import { createHash } from 'node:crypto';
import { ARC_CHAIN_ID, ARC_RPC_URL } from '../../api/_lib/arc-intelligence/rpc.js';
import { DEFINITION_VERSION as CORE_VERSION, MAX_WINDOW_SIZE } from '../../api/_lib/arc-intelligence/core.js';
import { METRIC_DEFINITION_VERSION, createMetricAccumulator } from '../../api/_lib/arc-intelligence/metrics.js';
import { summarizeUsdcTransfers } from '../../api/_lib/arc-intelligence/usdc.js';
import { HISTORY_DEFINITION_VERSION } from '../../api/_lib/arc-intelligence/history.js';
import { position } from './foundation.js';
import { receiptSetComplete } from './receipt-repository.js';

export const HOURLY_REDUCER_VERSION = 'arc-a2-durable-core-usdc-hour-v2';
export const HOUR_SECONDS = 3600;
export const RAW_KEEP_SECONDS = 6 * HOUR_SECONDS;
// Callable, off the indexing hot path. One hour and hard limits, never an archive sweep.
export const MAX_HOURLY_BLOCKS = 12000;
export const MAX_HOURLY_FACT_ROWS = 200000;
export const digest = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function hourStart(value) {
  const start=position(value);
  if (start % HOUR_SECONDS || start > Number.MAX_SAFE_INTEGER-HOUR_SECONDS) throw new Error('invalid_hour');
  // Metric contracts express UTC dates using JavaScript Date.
  if (!Number.isFinite(new Date((start+HOUR_SECONDS)*1000).getTime())) throw new Error('invalid_hour');
  return start;
}
export function checkAbort(signal) { if (signal?.aborted) throw new Error('operation_aborted'); }
const protocols = Object.freeze({
  uniswap:'durable_pool_registry_and_metadata_unavailable',
  aave:'durable_v4_asset_and_deployment_verification_unavailable',
  morpho:'durable_vault_factory_interface_and_metadata_verification_unavailable',
  cctp:'durable_contract_and_local_domain_verification_unavailable',
  gateway:'durable_contract_and_domain_verification_unavailable',
  across:'durable_spoke_verification_unavailable',
  launchpads:'durable_factory_and_token_verification_unavailable',
});
export const protocolCoverage = () => Object.fromEntries(Object.entries(protocols).map(([name,reason]) =>
  [name,{status:'unavailable',complete:false,value:null,reason}]));

function proofRows(rows) {
  // Fingerprint current canonical evidence, not lane progress or timestamps of DB writes.
  return rows.map((r) => ({role:r.window_role,number:position(r.block_number),hash:r.block_hash,parent:r.parent_hash,
    timestamp:position(r.timestamp),transactionCount:position(r.transaction_count),receiptCount:r.receipt_count===null ? null : position(r.receipt_count),
    transactions:r.transactions_complete,receipts:r.receipt_complete,conflict:r.receipt_evidence_conflict,
    allLogs:r.all_log_reconciliation_complete,transferLogs:r.transfer_log_reconciliation_complete,
    receiptsDigest:r.receipts_digest,allLogsDigest:r.all_logs_digest,transferLogsDigest:r.transfer_logs_digest}));
}
export function inspectHour(rows,start) {
  start=hourStart(start);
  const sorted=[...rows].sort((a,b) => position(a.block_number)-position(b.block_number));
  const inside=sorted.filter((b) => b.window_role==='inside');
  const before=sorted.find((b) => b.window_role==='before'),after=sorted.find((b) => b.window_role==='after');
  const left=!!before && !!inside.length && position(before.block_number)+1===position(inside[0].block_number)
    && position(before.timestamp)<start;
  const right=!!after && !!inside.length && position(after.block_number)===position(inside.at(-1).block_number)+1
    && position(after.timestamp)>=start+HOUR_SECONDS;
  const gaps=[];
  for (let i=1;i<sorted.length;i++) {
    const previous=position(sorted[i-1].block_number),current=position(sorted[i].block_number);
    if (current>previous+1) gaps.push({startBlock:previous+1,endBlock:current-1});
  }
  const coverage={scope:'core_network',bounded:inside.length<=MAX_HOURLY_BLOCKS,
    blockNumbersContiguous:inside.length>0 && gaps.length===0 && sorted.every((b,i) => !i || position(b.block_number)===position(sorted[i-1].block_number)+1),
    parentHashesContinuous:sorted.every((b,i) => !i || b.parent_hash===sorted[i-1].block_hash),
    timestampsMonotonic:sorted.every((b,i) => !i || position(b.timestamp)>=position(sorted[i-1].timestamp)),
    receiptEvidenceComplete:sorted.length>0 && sorted.every((b) => b.transactions_complete===true && b.receipt_complete===true
      && b.receipt_evidence_conflict===false && b.receipt_count!==null && position(b.receipt_count)===position(b.transaction_count)
      && b.all_log_reconciliation_complete===true && b.transfer_log_reconciliation_complete===true),
    certificatesComplete:sorted.length>0 && sorted.every((b) => [b.receipts_digest,b.all_logs_digest,b.transfer_logs_digest]
      .every((d) => typeof d==='string' && /^[0-9a-f]{64}$/.test(d))),
    leftBoundaryCovered:left,rightBoundaryCovered:right,factSetsComplete:false,
    missingBlockRanges:gaps,observedBlockCount:inside.length,requiredReducersComplete:false,
    protocols:protocolCoverage(),boundaryEvidence:{before:before ? {number:position(before.block_number),hash:before.block_hash,timestamp:position(before.timestamp)} : null,
      after:after ? {number:position(after.block_number),hash:after.block_hash,timestamp:position(after.timestamp)} : null},
    sourceDefinitionVersions:{core:CORE_VERSION,history:HISTORY_DEFINITION_VERSION,metrics:METRIC_DEFINITION_VERSION,
      receipts:'arc-receipts-logs-v1',reducer:HOURLY_REDUCER_VERSION},
    source:ARC_RPC_URL,sourceKind:'a2_durable_rpc_facts',warnings:[],
  };
  const keys=['bounded','blockNumbersContiguous','parentHashesContinuous','timestampsMonotonic','receiptEvidenceComplete',
    'certificatesComplete','leftBoundaryCovered','rightBoundaryCovered'];
  for (const key of keys) if (!coverage[key]) coverage.warnings.push(key);
  return {inside,sorted,coverage,manifestComplete:keys.every((k) => coverage[k]),proofDigest:digest(proofRows(sorted))};
}

function logModel(row) {
  return {
    blockNumber: position(row.block_number),
    transactionIndex: position(row.transaction_index),
    transactionHash: row.transaction_hash,
    logIndex: position(row.log_index),
    address: row.address,
    topics: row.topics,
    data: row.data,
  };
}

export function reduceDurableHour({rows,transactions=[],receipts=[],logs=[],start,signal}={}) {
  const inspected=inspectHour(rows,start),{inside,sorted,coverage}=inspected;
  checkAbort(signal);
  let records=null,mergeState=null;
  if (inspected.manifestComplete) {
    try {
      if (transactions.length>MAX_HOURLY_FACT_ROWS || receipts.length>MAX_HOURLY_FACT_ROWS || logs.length>MAX_HOURLY_FACT_ROWS) throw new Error('fact_limit');
      const txByBlock=new Map(),receiptsByBlock=new Map(),logsByBlock=new Map();
      for (const [facts,map] of [[transactions,txByBlock],[receipts,receiptsByBlock],[logs,logsByBlock]]) for (const fact of facts) {
        const n=position(fact.block_number);if (!map.has(n)) map.set(n,[]);map.get(n).push(fact);
      }
      const known=new Set(sorted.map((b) => position(b.block_number)));
      if ([...txByBlock.keys(),...receiptsByBlock.keys(),...logsByBlock.keys()].some((n) => !known.has(n))) throw new Error('fact_identity');
      const views=sorted.map((block) => {
        const n=position(block.block_number),txs=(txByBlock.get(n) ?? []).sort((a,b) => position(a.transaction_index)-position(b.transaction_index));
        const rs=(receiptsByBlock.get(n) ?? []).sort((a,b) => position(a.transaction_index)-position(b.transaction_index));
        const ls=(logsByBlock.get(n) ?? []).sort((a,b) => position(a.log_index)-position(b.log_index));
        const view={block,transactions:txs,receipts:rs,logs:ls};
        if (!receiptSetComplete(view) || new Set(txs.map((t) => t.transaction_hash)).size!==txs.length
          || new Set(rs.map((r) => r.transaction_hash)).size!==rs.length
          || [...txs,...rs].some((r) => r.chain_id!==ARC_CHAIN_ID || r.block_hash!==block.block_hash)
          || txs.some((t) => !/^0x[0-9a-f]{40}$/.test(t.from_address) || (t.to_address!==null && !/^0x[0-9a-f]{40}$/.test(t.to_address)))
          || rs.some((r) => !/^\d+$/.test(r.gas_used_raw) || (r.effective_gas_price_raw!==null && !/^\d+$/.test(r.effective_gas_price_raw)))
          || ls.some((l) => l.chain_id!==ARC_CHAIN_ID || l.block_hash!==block.block_hash || !/^0x[0-9a-f]{40}$/.test(l.address)
            || !Array.isArray(l.topics) || !/^0x([0-9a-f]{2})*$/.test(l.data))) throw new Error('fact_identity');
        return view;
      });
      const accumulator=createMetricAccumulator();
      for (let offset=0;offset<views.length;offset+=MAX_WINDOW_SIZE) {
        checkAbort(signal);
        const chunk=views.slice(offset,offset+MAX_WINDOW_SIZE);
        accumulator.addChunk({complete:true,chainId:ARC_CHAIN_ID,source:ARC_RPC_URL,definitionVersion:CORE_VERSION,
          startBlock:position(chunk[0].block.block_number),endBlock:position(chunk.at(-1).block.block_number),
          blocks:chunk.map(({block:b}) => ({number:position(b.block_number),hash:b.block_hash,parentHash:b.parent_hash,timestamp:position(b.timestamp)})),
          transactions:chunk.flatMap((v) => v.transactions.map((t) => ({blockNumber:position(t.block_number),transactionIndex:position(t.transaction_index),hash:t.transaction_hash,
            from:t.from_address,to:t.to_address}))),
          receipts:chunk.flatMap((v) => v.receipts.map((r) => ({blockNumber:position(r.block_number),transactionIndex:position(r.transaction_index),hash:r.transaction_hash,
            status:r.status,gasUsedRaw:r.gas_used_raw,effectiveGasPriceRaw:r.effective_gas_price_raw,contractAddress:r.contract_address}))),
          transferLogs:chunk.flatMap((v) => v.logs.map(logModel)),verifiedAssetObservations:[],
        });
      }
      const existing=accumulator.finalize({coreCoverage:{metricSnapshotCoverageComplete:true},legacyUsdcCoverage:{status:'unavailable'}})
        .buckets.hour.find((b) => b.bucketStartUtc===new Date(hourStart(start)*1000).toISOString());
      if (!existing?.complete) throw new Error('boundary');
      // Missing DB protocol/metadata verification must never become the accumulator's empty event counts.
      records=existing.records.filter((r) => r.protocol==='arc.network');
      const txs=views.filter((v) => v.block.window_role==='inside').flatMap((v) => v.transactions);
      const insideLogs=views.filter((v) => v.block.window_role==='inside').flatMap((v) => v.logs.map(logModel));
      const canonicalUsdc=summarizeUsdcTransfers(insideLogs,{complete:true});
      mergeState={uniqueTopLevelSenders:[...new Set(txs.map((t) => t.from_address))].sort(),
        uniqueTopLevelRecipients:[...new Set(txs.map((t) => t.to_address).filter(Boolean))].sort(),
        semantics:'Union address sets across hours; never sum hourly unique counts.'};
      coverage.factSetsComplete=true;
      coverage.canonicalUsdcCountsComplete=canonicalUsdc.complete;
      coverage.canonicalUsdcRawAmountAvailable=false;
      coverage.canonicalUsdcRawAmountReason='raw_amount_not_exposed_in_product_timeseries';
      records={network:records,assets:{canonicalUsdc:{status:canonicalUsdc.complete ? 'available' : 'unavailable',complete:canonicalUsdc.complete,
        transferCount:canonicalUsdc.transferCount,mintCount:canonicalUsdc.mintCount,burnCount:canonicalUsdc.burnCount}}};
    } catch (error) {
      if (signal?.aborted) throw error;
      coverage.warnings.push('durable_fact_sets_incomplete_or_bounded_limit');
    }
  }
  const complete=inspected.manifestComplete && coverage.factSetsComplete;
  const retained=inside.slice(0,MAX_HOURLY_BLOCKS),first=retained[0],last=retained.at(-1);
  // For gaps/partial boundaries even an empty observed transaction set is unavailable, never activity=0.
  const networkRecords=Array.isArray(records) ? records : records?.network ?? null;
  const assets=records?.assets ?? {canonicalUsdc:{status:'unavailable',complete:false,transferCount:null,mintCount:null,burnCount:null}};
  const metrics={network:{status:complete ? 'available' : 'unavailable',records:networkRecords,mergeState},assets,protocols:protocolCoverage()};
  const result={chainId:ARC_CHAIN_ID,period:'hour',bucketStart:hourStart(start),bucketEnd:hourStart(start)+HOUR_SECONDS,
    startBlock:first ? position(first.block_number) : null,endBlock:last ? position(last.block_number) : null,
    startHash:first?.block_hash ?? null,endHash:last?.block_hash ?? null,blockCount:retained.length,
    definitionVersion:METRIC_DEFINITION_VERSION,reducerVersion:HOURLY_REDUCER_VERSION,
    coverageStatus:complete ? 'available' : retained.length ? 'partial' : 'unavailable',complete,
    requiredReducersComplete:false,rawPrunable:false,metrics,coverage,proofDigest:inspected.proofDigest};
  return {...result,evidenceDigest:digest(result)};
}
