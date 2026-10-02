// Compact engine: canonical block/body spine for one hour, fetched in bounded batches and validated before use.
// Raw block objects never leave this module. A spine block keeps only what the metrics and log validation read: hash,
// parent, time, gas and, per top-level transaction, its hash, sender and recipient as parallel arrays (no per-transaction
// objects). Calldata and value are never read, so they are not parsed (arc-compact-hour-v2).
import { normalizeAddress, quantityToBigInt, quantityToSafeNumber } from '../../api/_lib/arc-intelligence/normalize.js';

export const SPINE_BATCH_SIZE = 50;
const HASH = /^0x[0-9a-f]{64}$/i;
const hex = (number) => `0x${number.toString(16)}`;

export class SpineError extends Error {
  constructor(code, blockNumber = null) { super(code); this.code = code; this.blockNumber = blockNumber; }
}

function hashOf(value) {
  if (typeof value !== 'string' || !HASH.test(value)) throw new TypeError('Malformed hash');
  return value.toLowerCase();
}

function headerFields(raw, expectedNumber) {
  let block;
  try {
    block = { number: quantityToSafeNumber(raw.number, 'block number'), hash: hashOf(raw.hash), parentHash: hashOf(raw.parentHash),
      timestamp: quantityToSafeNumber(raw.timestamp, 'block timestamp') };
  } catch { throw new SpineError('malformed_block', expectedNumber); }
  if (block.number !== expectedNumber) throw new SpineError('block_number_mismatch', expectedNumber);
  return block;
}

export function headerOf(raw, expectedNumber) {
  if (!raw || typeof raw !== 'object') throw new SpineError('missing_block', expectedNumber);
  return headerFields(raw, expectedNumber);
}

// Full body: header, gas and every top-level transaction (hash, from, to), each transaction in its own position.
export function spineBlockOf(raw, expectedNumber) {
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.transactions)) throw new SpineError('missing_block', expectedNumber);
  const transactions = raw.transactions;
  if (transactions.some((tx) => typeof tx !== 'object' || tx === null)) throw new SpineError('transaction_bodies_missing', expectedNumber);
  const block = headerFields(raw, expectedNumber);
  const count = transactions.length;
  const txHashes = new Array(count);
  const txFrom = new Array(count);
  const txTo = new Array(count);
  const unique = new Set();
  let gasUsed;
  try {
    gasUsed = quantityToBigInt(raw.gasUsed, 'block gas used');
    for (let index = 0; index < count; index++) {
      const tx = transactions[index];
      txHashes[index] = hashOf(tx.hash);
      txFrom[index] = normalizeAddress(tx.from);
      txTo[index] = normalizeAddress(tx.to, { nullable: true });
      if (tx.blockHash != null && String(tx.blockHash).toLowerCase() !== block.hash) {
        throw new SpineError('transaction_block_hash_mismatch', expectedNumber);
      }
      if ((tx.transactionIndex != null && quantityToSafeNumber(tx.transactionIndex, 'transaction index') !== index)
        || (tx.blockNumber != null && quantityToSafeNumber(tx.blockNumber, 'transaction block number') !== block.number)) {
        throw new SpineError('transaction_position_mismatch', expectedNumber);
      }
      if (unique.has(txHashes[index])) throw new SpineError('duplicate_transaction', expectedNumber);
      unique.add(txHashes[index]);
    }
  } catch (error) {
    if (error instanceof SpineError) throw error;
    throw new SpineError('malformed_block', expectedNumber);
  }
  return { ...block, gasUsed, txHashes, txFrom, txTo };
}

// Yields validated windows of consecutive blocks. Continuity is checked against the previous block, including the
// left boundary block before the hour; the caller checks the right boundary against the block after the hour.
// hourStart/hourEnd null means a plain block range (used for bounded fixture windows that cross an hour).
export async function* spineWindows(provider, { first, last, before, hourStart = null, hourEnd = null, windowBlocks = 500,
  batchSize = SPINE_BATCH_SIZE }) {
  if (!Number.isSafeInteger(first) || !Number.isSafeInteger(last) || last < first || batchSize < 1 || batchSize > 50
    || windowBlocks < batchSize || !before?.hash || (hourStart === null) !== (hourEnd === null)) throw new SpineError('invalid_spine_request');
  if (before.number !== first - 1) throw new SpineError('invalid_spine_request');
  let previous = before;
  for (let windowStart = first; windowStart <= last; windowStart += windowBlocks) {
    const windowEnd = Math.min(last, windowStart + windowBlocks - 1);
    const blocks = [];
    for (let start = windowStart; start <= windowEnd; start += batchSize) {
      const end = Math.min(windowEnd, start + batchSize - 1);
      const raw = await provider.batch(Array.from({ length: end - start + 1 }, (_, i) => ['eth_getBlockByNumber', [hex(start + i), true]]));
      for (let i = 0; i < raw.length; i++) {
        const block = spineBlockOf(raw[i], start + i);
        if (block.parentHash !== previous.hash) throw new SpineError('parent_hash_mismatch', block.number);
        if (block.timestamp < previous.timestamp) throw new SpineError('timestamp_regression', block.number);
        if (hourStart !== null && (block.timestamp < hourStart || block.timestamp >= hourEnd)) throw new SpineError('block_outside_hour', block.number);
        blocks.push(block);
        previous = block;
      }
    }
    yield blocks;
  }
}
