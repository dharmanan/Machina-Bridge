import { ARC_RPC_URL } from '../../api/_lib/arc-intelligence/rpc.js';
import { MAX_ALL_LOGS, MAX_TRANSFER_LOGS } from '../../api/_lib/arc-intelligence/core.js';
import { normalizeLog } from '../../api/_lib/arc-intelligence/normalize.js';
import { reconcileLogs, reconcileTransferLogs } from '../../api/_lib/arc-intelligence/reconciliation.js';
import { TRANSFER_TOPIC } from '../../api/_lib/arc-intelligence/usdc.js';
import { position } from './foundation.js';
import { validateReceipt, normalizedLog } from './receipt-facts.js';
import { receiptSetComplete } from './receipt-repository.js';

export function createReceiptWorker({ repository,rpc,owner='receipt-worker',maxReceiptReads=16 }={}) {
  if (!repository || rpc?.url !== ARC_RPC_URL || !rpc.budget || !Number.isSafeInteger(maxReceiptReads)
    || maxReceiptReads < 1 || maxReceiptReads > 64) throw new Error('invalid_receipt_worker');
  let active=false;
  return {
    async runOnce({signal,preferredComponent=null}={}) {
      if (active) return {skipped:true};
      if (signal?.aborted) return {status:'aborted'};
      active=true;
      let lease;
      let retryMs=1000;
      try {
        lease=await repository.claim(owner,180000,{preferredComponent});
        if (!lease) return {status:'idle'};
        retryMs=Math.min(60000,1000*(2**Math.min(position(lease.attempts)-1,6)));
        let view=await repository.getBlock(position(lease.start_block));
        const blockTag=`0x${position(view.block.block_number).toString(16)}`;
        if (lease.component === 'receipts') {
          if (await repository.markBulkAttempted(lease)) {
            let bulk=[];
            try {
              const result=await rpc.request('eth_getBlockReceipts',[blockTag],{signal});
              if (Array.isArray(result) && result.length <= MAX_ALL_LOGS) bulk=result;
            } catch { if (signal?.aborted) throw new Error('operation_aborted'); }
            const seen=new Map();
            const conflicts=new Set();
            const logOwners=new Map();
            for (const raw of bulk) {
              let normalized;
              try { normalized=validateReceipt(raw,view); } catch { continue; }
              const payload=JSON.stringify(normalized);
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
            if (valid.length) await repository.saveReceipts(lease,valid,{retryMs,finalize:false});
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
          const result=await repository.saveReceipts(lease,raw,{retryMs});
          return {status:result.complete ? 'complete' : 'retrying',component:lease.component,...result};
        }
        if (!receiptSetComplete(view)) {
          await repository.retry(lease,retryMs); return {status:'retrying',component:lease.component};
        }
        const transfer=lease.component === 'transfer_logs';
        const old=view.reconciliation.find((r) => r.kind === lease.component);
        let queried=[];
        let queryComplete=false;
        const logs=view.logs.map(normalizedLog);
        if (!old?.complete) {
          try {
            const filter={fromBlock:blockTag,toBlock:blockTag,...(transfer ? {topics:[TRANSFER_TOPIC]} : {})};
            const result=await rpc.request('eth_getLogs',[filter],{signal});
            if (!Array.isArray(result) || result.length > (transfer ? MAX_TRANSFER_LOGS : MAX_ALL_LOGS)) throw new Error('invalid_query');
            queried=result.map((log) => normalizeLog(log));
            if (queried.some((log) => log.removed || (log.blockHash && log.blockHash !== view.block.block_hash))) throw new Error('invalid_query');
            queryComplete=true;
          } catch { if (signal?.aborted) throw new Error('operation_aborted'); }
        }
        const options={receiptSetComplete:true,queryComplete};
        const evidence=transfer ? reconcileTransferLogs(logs,queried,options) : reconcileLogs(logs,queried,options,'all');
        if (signal?.aborted) throw new Error('operation_aborted');
        const result=await repository.saveReconciliation(lease,evidence,retryMs);
        return {status:result.complete ? 'complete' : 'retrying',component:lease.component};
      } catch (error) {
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
        return {status:signal?.aborted ? 'aborted' : 'retrying',error:'required_read_unavailable'};
      } finally {active=false;}
    },
  };
}
