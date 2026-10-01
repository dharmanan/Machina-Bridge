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
  // One range query result, validated as a whole, partitioned by block. Any structural defect makes it unusable.
  async function rangeQuery(start,end,transfer,signal) {
    if (signal?.aborted) throw new Error('operation_aborted');
    const filter={fromBlock:`0x${start.toString(16)}`,toBlock:`0x${end.toString(16)}`,...(transfer ? {topics:[TRANSFER_TOPIC]} : {})};
    const raw=await rpc.request('eth_getLogs',[filter],{signal});
    // Existing per-component limits are also absolute RANGE total limits, never multiplied by range width.
    if (!Array.isArray(raw) || raw.length>(transfer ? MAX_TRANSFER_LOGS : MAX_ALL_LOGS)) throw new Error('invalid_query');
    const partitions=new Map();
    for (const entry of raw) {
      const log=normalizeLog(entry);
      if (log.blockNumber<start || log.blockNumber>end || log.transactionHash===null || log.transactionIndex===null
        || (transfer && log.topics[0]!==TRANSFER_TOPIC)) throw new Error('invalid_query');
      const logs=partitions.get(log.blockNumber) ?? [];
      logs.push(log);partitions.set(log.blockNumber,logs);
    }
    return partitions;
  }
  function blockEvidence(view,query,transfer,extra={}) {
    const queried=query?.partitions.get(position(view.block.block_number)) ?? [];
    const blockQueryComplete=query !== null && !queried.some((log) => log.removed
      || (log.blockHash && log.blockHash!==view.block.block_hash)
      || !view.transactions.some((t) => t.transaction_hash===log.transactionHash && position(t.transaction_index)===log.transactionIndex));
    const options={receiptSetComplete:true,queryComplete:blockQueryComplete};
    const logs=view.logs.map(normalizedLog);
    return {...(transfer ? reconcileTransferLogs(logs,queried,options) : reconcileLogs(logs,queried,options,'all')),...extra};
  }
  const certified=(view,kind) => view.reconciliation.some((e) => e.kind===kind && e.complete);
  const transferLogCount=(view) => view.logs.filter((l) => l.topics[0]===TRANSFER_TOPIC).length;
  // A durable exact all-log certificate for this canonical block proves its receipt Transfer subset; no RPC is needed.
  // The absolute Transfer range cap is applied to the whole claimed span in runLogBatch, not per block.
  function certificateDerivable(view) {
    const all=view.reconciliation.find((e) => e.kind==='all_logs');
    return all?.complete===true && all.block_hash===view.block.block_hash && position(all.receipt_log_count)===view.logs.length
      && position(all.queried_log_count)===view.logs.length;
  }
  async function runLogBatch(firstLease,firstView,signal,deferFrontier) {
    const {leases,companions}=await repository.claimLogSpan(firstLease,maxLogRangeBlocks);
    const component=firstLease.component;
    const record=(lease) => ({lease,retryMs:retryDelay(lease),view:null,result:null,evidence:null});
    const records=leases.map(record),companionRecords=companions.map(record);
    async function fail(r,error) {
      try { r.result=await handleFailure(r.lease,error,r.retryMs,signal); }
      catch (failure) { r.result={status:failure.message==='stale_lease' ? 'stale_lease' : 'retrying',error:'required_read_unavailable'}; }
    }
    // A companion never fails the batch: without proof it simply returns to durable retry.
    async function release(r) {
      try { await repository.retry(r.lease,r.retryMs);r.result={status:'retrying'}; }
      catch (error) { r.result={status:error.message==='stale_lease' ? 'stale_lease' : 'retrying'}; }
    }
    // All durable facts are loaded outside a transaction, before at most one range transport attempt per filter.
    for (const r of records) {
      try {
        if (signal?.aborted) throw new Error('operation_aborted');
        r.view=r.lease.id===firstLease.id ? firstView : await repository.getBlock(position(r.lease.start_block));
        if (!receiptSetComplete(r.view)) {
          await repository.retry(r.lease,r.retryMs);r.result={status:'retrying'};
        }
      } catch (error) { await fail(r,error); }
    }
    const blocks=new Map();
    for (const r of records) blocks.set(position(r.lease.start_block),{[r.lease.component]:r});
    for (const c of companionRecords) {
      const pair=blocks.get(position(c.lease.start_block)),primary=pair?.[component];
      if (!primary || primary.result || primary.lease.block_hash!==c.lease.block_hash) { await release(c);continue; }
      c.view=primary.view;pair[c.lease.component]=c;
    }
    // Plan reads: one unfiltered query serves every all-log job and every Transfer job whose same-block all-log
    // evidence can prove its subset. The independent Transfer query remains only for Transfer jobs without proof.
    let needAll=false,needTransfer=false;
    for (const pair of blocks.values()) {
      const all=pair.all_logs,transfer=pair.transfer_logs;
      if (all && !all.result && !certified(all.view,'all_logs')) needAll=true;
      if (!transfer || transfer.result) continue;
      if (certified(transfer.view,'transfer_logs')) transfer.source='certified';
      else if (certificateDerivable(transfer.view)) transfer.source='all_logs_certificate';
      else if (all && !all.result) transfer.source='all_logs_query';
      else {transfer.source='transfer_query';needTransfer=true;}
    }
    // The certificate fast path certifies the claimed span at once, so it honours the independent Transfer query's
    // absolute RANGE cap in aggregate. Above it, every such job takes its pre-derivation path, with its own caps.
    const viaCertificate=[...blocks.values()].map((pair) => pair.transfer_logs).filter((t) => t?.source==='all_logs_certificate');
    if (viaCertificate.reduce((total,t) => total+transferLogCount(t.view),0)>MAX_TRANSFER_LOGS) {
      for (const t of viaCertificate) {
        const all=blocks.get(position(t.lease.start_block)).all_logs;
        if (all && !all.result) t.source='all_logs_query';
        else {t.source='transfer_query';needTransfer=true;}
      }
    }
    // The same bounded lease span and transport parameters as the per-component batches before A2.7.
    const start=position(leases[0].start_block),end=position(leases.at(-1).start_block);
    let allQuery=null,transferQuery=null,rpcQueries=0;
    if (needAll) {
      rpcQueries++;
      try { allQuery={partitions:await rangeQuery(start,end,false,signal)}; } catch { allQuery=null; }
    }
    if (needTransfer) {
      rpcQueries++;
      try { transferQuery={partitions:await rangeQuery(start,end,true,signal)}; } catch { transferQuery=null; }
    }
    // A derived range must also satisfy the independent Transfer query's absolute range cap.
    const derivableRange=allQuery !== null
      && [...allQuery.partitions.values()].flat().filter((l) => l.topics[0]===TRANSFER_TOPIC).length<=MAX_TRANSFER_LOGS;
    for (const pair of blocks.values()) {
      const all=pair.all_logs,transfer=pair.transfer_logs;
      for (const r of [all,transfer]) {
        if (!r || r.result) continue;
        try {
          if (signal?.aborted) throw new Error('operation_aborted');
          if (r===all) r.evidence=blockEvidence(r.view,allQuery,false);
          else if (r.source==='certified') r.evidence=blockEvidence(r.view,null,true);
          else if (r.source==='transfer_query') r.evidence=blockEvidence(r.view,transferQuery,true);
          else if (r.source==='all_logs_certificate') {
            const logs=r.view.logs.map(normalizedLog);
            r.evidence={...reconcileTransferLogs(logs,logs,{receiptSetComplete:true,queryComplete:true}),derivedFrom:'all_logs_certificate'};
          } else if (all?.evidence?.complete===true && derivableRange) {
            // Exact all-log evidence for this block, from this response, makes its Transfer subset exact too.
            r.evidence=blockEvidence(r.view,allQuery,true,{derivedFrom:'all_logs_query'});
          } else r.release=true;
        } catch (error) { if (r.lease.component===component) await fail(r,error); else r.release=true; }
      }
    }
    // Persist one short transaction per block. A Transfer job without proof never blocks its all-log certificate.
    const units=[];
    for (const pair of blocks.values()) {
      const ready=[pair.all_logs,pair.transfer_logs].filter((r) => r && !r.result && !r.release && r.evidence);
      if (ready.length) units.push({members:ready,lease:ready[0].lease,evidence:ready[0].evidence,retryMs:ready[0].retryMs,
        ...(ready[1] ? {companion:{lease:ready[1].lease,evidence:ready[1].evidence,retryMs:ready[1].retryMs}} : {})});
    }
    let frontierError;
    if (units.length) {
      const batch=await repository.saveReconciliationBatch(units,{maxBlocks:maxLogRangeBlocks,signal,
        // A pair transaction is guarded on its all-log job (members[0]); its Transfer member returns to retry.
        onError:async (unit,error) => {await fail(unit.members[0],error);for (const r of unit.members.slice(1)) await release(r);},
        ...(deferFrontier ? {deferFrontier:true} : {})});
      for (let i=0;i<units.length;i++) {
        const value=batch.results[i].value;
        if (!value) continue;
        const [first,second]=units[i].members;
        first.result={status:value.complete ? 'complete' : 'retrying'};
        if (second) second.result={status:value.companion.stale ? 'stale_lease' : value.companion.complete ? 'complete' : 'retrying'};
      }
      frontierError=batch.frontierError;
    }
    for (const r of [...records,...companionRecords]) if (!r.result) await release(r);
    const results=records.map((r) => ({blockNumber:position(r.lease.start_block),...r.result}));
    const companionResults=companionRecords.map((r) => ({blockNumber:position(r.lease.start_block),component:r.lease.component,...r.result}));
    const frontierStatus=frontierError ? frontierError.message==='lane_continuity_stopped' ? 'continuity_error' : 'retrying' : null;
    const status=['aborted','continuity_error','persistent_partial','stale_lease','retrying'].find((s) => frontierStatus===s
      || results.some((r) => r.status===s) || (['aborted','continuity_error'].includes(s) && companionResults.some((r) => r.status===s))) ?? 'complete';
    return {status,component,jobCount:leases.length,completedJobs:results.filter((r) => r.status==='complete').length,results,
      companionJobs:companions.length,completedCompanionJobs:companionResults.filter((r) => r.status==='complete').length,companionResults,rpcQueries,
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
