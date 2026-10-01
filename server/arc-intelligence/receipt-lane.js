import { ARC_RPC_URL } from '../../api/_lib/arc-intelligence/rpc.js';
import { MAX_ALL_LOGS, MAX_TRANSFER_LOGS, MAX_WINDOW_SIZE } from '../../api/_lib/arc-intelligence/core.js';
import { normalizeLog } from '../../api/_lib/arc-intelligence/normalize.js';
import { reconcileLogs, reconcileTransferLogs } from '../../api/_lib/arc-intelligence/reconciliation.js';
import { TRANSFER_TOPIC } from '../../api/_lib/arc-intelligence/usdc.js';
import { position } from './foundation.js';
import { validateReceipt, normalizedLog } from './receipt-facts.js';
import { receiptSetComplete } from './receipt-repository.js';

export function createReceiptWorker({ repository,rpc,owner='receipt-worker',maxReceiptReads=16,maxLogRangeBlocks=10 }={}) {
  if (!repository || rpc?.url !== ARC_RPC_URL || !rpc.budget || !Number.isSafeInteger(maxReceiptReads)
    || maxReceiptReads < 1 || maxReceiptReads > 64 || !Number.isSafeInteger(maxLogRangeBlocks)
    || maxLogRangeBlocks < 1 || maxLogRangeBlocks > MAX_WINDOW_SIZE) throw new Error('invalid_receipt_worker');
  let active=false;
  const retryDelay=(lease) => Math.min(60000,1000*(2**Math.min(position(lease.attempts)-1,6)));
  async function handleFailure(lease,error,retryMs,signal) {
    if (error.message === 'stale_lease') return {status:'stale_lease'};
    if (error.message === 'lane_continuity_stopped') return {status:'continuity_error'};
    if (error.message === 'checkpoint_parent_hash_mismatch') {
      if (lease) await repository.recordContinuityError(lease);
      return {status:'continuity_error',error:'checkpoint_parent_hash_mismatch'};
    }
    if (error.message === 'receipt_evidence_conflict') {
      if (lease) await repository.recordConflict(lease);
      return {status:'persistent_partial',error:'manifest_conflict'};
    }
    if (lease) await repository.retry(lease,retryMs).catch(() => {});
    return {status:signal?.aborted ? 'aborted' : 'retrying',error:error.message==='work_capacity_reached' ? 'work_capacity_reached' : 'required_read_unavailable'};
  }
  async function runLogBatch(firstLease,firstView,signal,deferFrontier) {
    const leases=await repository.claimLogBatch(firstLease,maxLogRangeBlocks);
    const component=firstLease.component;
    const transfer=component==='transfer_logs';
    const records=leases.map((lease) => ({lease,retryMs:retryDelay(lease),view:null,result:null}));
    async function fail(record,error) {
      try { record.result=await handleFailure(record.lease,error,record.retryMs,signal); }
      catch (failure) { record.result={status:failure.message==='stale_lease' ? 'stale_lease' : 'retrying',error:'required_read_unavailable'}; }
    }
    // All durable facts are loaded outside a transaction, before the single range transport attempt.
    for (const record of records) {
      try {
        if (signal?.aborted) throw new Error('operation_aborted');
        record.view=record.lease.id===firstLease.id ? firstView : await repository.getBlock(position(record.lease.start_block));
        if (!receiptSetComplete(record.view)) {
          await repository.retry(record.lease,record.retryMs);record.result={status:'retrying'};
        }
      } catch (error) { await fail(record,error); }
    }
    const start=position(leases[0].start_block),end=position(leases.at(-1).start_block);
    let partitions=new Map();
    let queryComplete=false;
    if (records.some((r) => !r.result && !r.view.reconciliation.some((e) => e.kind===component && e.complete))) {
      try {
        if (signal?.aborted) throw new Error('operation_aborted');
        const filter={fromBlock:`0x${start.toString(16)}`,toBlock:`0x${end.toString(16)}`,
          ...(transfer ? {topics:[TRANSFER_TOPIC]} : {})};
        const raw=await rpc.request('eth_getLogs',[filter],{signal});
        // Existing per-component limits are also absolute RANGE total limits, never multiplied by range width.
        if (!Array.isArray(raw) || raw.length>(transfer ? MAX_TRANSFER_LOGS : MAX_ALL_LOGS)) throw new Error('invalid_query');
        for (const entry of raw) {
          const log=normalizeLog(entry);
          if (log.blockNumber<start || log.blockNumber>end || log.transactionHash===null || log.transactionIndex===null
            || (transfer && log.topics[0]!==TRANSFER_TOPIC)) throw new Error('invalid_query');
          const logs=partitions.get(log.blockNumber) ?? [];
          logs.push(log);partitions.set(log.blockNumber,logs);
        }
        queryComplete=true;
      } catch { partitions=new Map(); }
    }
    for (const record of records) {
      if (record.result) continue;
      try {
        if (signal?.aborted) throw new Error('operation_aborted');
        const view=record.view;
        const queried=partitions.get(position(view.block.block_number)) ?? [];
        const blockQueryComplete=queryComplete && !queried.some((log) => log.removed
          || (log.blockHash && log.blockHash!==view.block.block_hash)
          || !view.transactions.some((t) => t.transaction_hash===log.transactionHash && position(t.transaction_index)===log.transactionIndex));
        const options={receiptSetComplete:true,queryComplete:blockQueryComplete};
        const logs=view.logs.map(normalizedLog);
        record.evidence=transfer ? reconcileTransferLogs(logs,queried,options) : reconcileLogs(logs,queried,options,'all');
      } catch (error) { await fail(record,error); }
    }
    let frontierError;
    const pending=records.filter((r) => !r.result);
    if (pending.length) {
      const batch=await repository.saveReconciliationBatch(pending,{maxBlocks:maxLogRangeBlocks,signal,onError:fail,
        ...(deferFrontier ? {deferFrontier:true} : {})});
      for (let i=0;i<pending.length;i++) if (batch.results[i].value) {
        pending[i].result={status:batch.results[i].value.complete ? 'complete' : 'retrying'};
      }
      frontierError=batch.frontierError;
    }
    const results=records.map((r) => ({blockNumber:position(r.lease.start_block),...r.result}));
    const frontierStatus=frontierError ? frontierError.message==='lane_continuity_stopped' ? 'continuity_error' : 'retrying' : null;
    const status=['aborted','continuity_error','persistent_partial','stale_lease','retrying'].find((s) =>
      frontierStatus===s || results.some((r) => r.status===s)) ?? 'complete';
    return {status,component,jobCount:leases.length,completedJobs:results.filter((r) => r.status==='complete').length,results,
      ...(frontierError ? {error:frontierStatus==='continuity_error' ? 'checkpoint_parent_hash_mismatch' : 'required_read_unavailable'} : {})};
  }
  return {
    async runOnce({signal,preferredComponent=null,enqueueFollowups=true,deferFrontier=false}={}) {
      if (active) return {skipped:true};
      if (signal?.aborted) return {status:'aborted'};
      active=true;
      const frontierOptions=deferFrontier ? {deferFrontier:true} : {};
      let lease;
      let retryMs=1000;
      try {
        lease=await repository.claim(owner,180000,{preferredComponent});
        if (!lease) return {status:'idle'};
        retryMs=retryDelay(lease);
        let view=await repository.getBlock(position(lease.start_block));
        const blockTag=`0x${position(view.block.block_number).toString(16)}`;
        if (lease.component === 'receipts') {
          if (await repository.markBulkAttempted(lease)) {
            let bulk=[],bulkValid=false;
            try {
              const result=await rpc.request('eth_getBlockReceipts',[blockTag],{signal});
              if (Array.isArray(result) && result.length <= MAX_ALL_LOGS) {bulk=result;bulkValid=true;}
            } catch { if (signal?.aborted) throw new Error('operation_aborted'); }
            const seen=new Map();
            const duplicateHashes=new Set();
            const conflicts=new Set();
            const logOwners=new Map();
            for (const raw of bulk) {
              let normalized;
              try { normalized=validateReceipt(raw,view); } catch { bulkValid=false;continue; }
              const payload=JSON.stringify(normalized);
              if (seen.has(normalized.hash)) duplicateHashes.add(normalized.hash);
              if (seen.has(normalized.hash) && seen.get(normalized.hash).payload !== payload) conflicts.add(normalized.hash);
              for (const log of normalized.logs) {
                const owner=logOwners.get(log.logIndex);
                if (owner && owner !== normalized.hash) {conflicts.add(owner);conflicts.add(normalized.hash);}
                logOwners.set(log.logIndex,normalized.hash);
              }
              seen.set(normalized.hash,{payload,raw});
            }
            // Conflicting rows in one untrusted response have no canonical winner: recover those hashes individually.
            const valid=[...seen.entries()].filter(([hash]) => !conflicts.has(hash)).map(([,entry]) => entry.raw);
            if (signal?.aborted) throw new Error('operation_aborted');
            const canonicalHashes=new Set(view.transactions.map((t) => t.transaction_hash));
            if (bulkValid && duplicateHashes.size === 0 && conflicts.size === 0 && valid.length === view.transactions.length
              && seen.size === canonicalHashes.size && [...seen.keys()].every((hash) => canonicalHashes.has(hash))) {
              const result=await repository.saveReceipts(lease,valid,{retryMs,finalize:true,enqueueFollowups,...frontierOptions});
              return {status:result.complete ? 'complete' : 'retrying',component:lease.component,...result};
            }
            if (valid.length) await repository.saveReceipts(lease,valid,{retryMs,finalize:false,enqueueFollowups,...frontierOptions});
            view=await repository.getBlock(position(lease.start_block));
          }
          const present=new Set(view.receipts.map((r) => r.transaction_hash));
          const missing=view.transactions.filter((t) => !present.has(t.transaction_hash)).slice(0,maxReceiptReads);
          const results=await Promise.allSettled(missing.map(async (transaction) => {
            const raw=await rpc.request('eth_getTransactionReceipt',[transaction.transaction_hash],{signal});
            if (validateReceipt(raw,view).hash !== transaction.transaction_hash) throw new Error('receipt_invalid');
            return raw;
          }));
          if (signal?.aborted) throw new Error('operation_aborted');
          const raw=results.filter((r) => r.status === 'fulfilled').map((r) => r.value);
          const result=await repository.saveReceipts(lease,raw,{retryMs,enqueueFollowups,...frontierOptions});
          return {status:result.complete ? 'complete' : 'retrying',component:lease.component,...result};
        }
        return await runLogBatch(lease,view,signal,deferFrontier);
      } catch (error) {
        return await handleFailure(lease,error,retryMs,signal);
      } finally {active=false;}
    },
  };
}
