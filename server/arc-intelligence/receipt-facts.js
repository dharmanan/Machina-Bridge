import { normalizeReceipt } from '../../api/_lib/arc-intelligence/normalize.js';
import { MAX_ALL_LOGS } from '../../api/_lib/arc-intelligence/core.js';
import { hash, position } from './foundation.js';
import { ARC_CHAIN_ID } from '../../api/_lib/arc-intelligence/rpc.js';

export function validateReceipt(raw, view) {
  const receipt = normalizeReceipt(raw);
  const block = view.block;
  const known = view.transactions.find((t) => t.transaction_hash === receipt.hash);
  if (!known || receipt.status === 'unknown' || hash(raw.blockHash) !== block.block_hash
    || receipt.blockNumber !== position(block.block_number)
    || receipt.transactionIndex !== position(known.transaction_index) || receipt.logs.length > MAX_ALL_LOGS) throw new Error('receipt_invalid');
  const indices = new Set();
  for (const log of receipt.logs) {
    if (log.blockNumber !== receipt.blockNumber || log.transactionHash !== receipt.hash
      || log.transactionIndex !== receipt.transactionIndex || log.removed || indices.has(log.logIndex)
      || (log.blockHash !== null && log.blockHash !== block.block_hash)) throw new Error('receipt_invalid');
    indices.add(log.logIndex);
    log.blockHash = block.block_hash;
  }
  receipt.blockHash = block.block_hash;
  return receipt;
}

export function receiptFact(receipt) {
  return { chain_id:ARC_CHAIN_ID,block_number:receipt.blockNumber,block_hash:receipt.blockHash,
    transaction_index:receipt.transactionIndex,transaction_hash:receipt.hash,status:receipt.status,
    gas_used_raw:receipt.gasUsedRaw,effective_gas_price_raw:receipt.effectiveGasPriceRaw,contract_address:receipt.contractAddress };
}
export function logFact(log) {
  return { chain_id:ARC_CHAIN_ID,block_number:log.blockNumber,block_hash:log.blockHash,transaction_index:log.transactionIndex,
    transaction_hash:log.transactionHash,log_index:log.logIndex,address:log.address,topics:log.topics,data:log.data,removed:log.removed };
}
export function normalizedLog(row) {
  return { blockNumber:position(row.block_number),blockHash:row.block_hash,transactionIndex:position(row.transaction_index),
    transactionHash:row.transaction_hash,logIndex:position(row.log_index),address:row.address,topics:row.topics,data:row.data,removed:row.removed };
}
export function sameFacts(left,right) {
  return Object.entries(right).every(([key,value]) => Array.isArray(value)
    ? JSON.stringify(left[key]) === JSON.stringify(value) : String(left[key]) === String(value));
}
