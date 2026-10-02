// Compact engine: targeted eth_getLogs. Always single, paced requests (batched eth_getLogs draws item-level -32005 on
// Arc), split on provider range/result limits, and yielded one response at a time so callers validate, count and release
// each response before the next one is requested. Every log is validated against the block spine before it is counted.
import { normalizeLog, quantityToSafeNumber } from '../../api/_lib/arc-intelligence/normalize.js';
import { ProviderError } from './provider.js';
import { logFilter } from './sources.js';

export const LOG_MAX_RANGE_BLOCKS = 10000; // Arc: 10,001 blocks answers -32012
// A response this large may have been capped silently by a backend; split the range instead of trusting it.
export const LOG_SUSPECT_RESULT_COUNT = 10000;
const SPLITTABLE = new Set(['range_too_large', 'too_many_results']);
const LOG_INDEX_LIMIT = 2 ** 24; // per-block log index bound behind the numeric duplicate keys

export class LogError extends Error {
  constructor(code, blockNumber = null) { super(code); this.code = code; this.blockNumber = blockNumber; }
}

// Ascending, gap-free coverage of [fromBlock, toBlock] in chunks of at most stream.maxRange blocks. Provider limits
// halve a chunk further; a limit on a single block cannot be split and fails closed. Yields each accepted response.
export async function* streamLogs(provider, stream, fromBlock, toBlock, { suspectResultCount = LOG_SUSPECT_RESULT_COUNT,
  maxRequests = 512 } = {}) {
  if (!Number.isSafeInteger(fromBlock) || !Number.isSafeInteger(toBlock) || toBlock < fromBlock) throw new LogError('invalid_log_range');
  const chunk = Math.min(stream.maxRange ?? LOG_MAX_RANGE_BLOCKS, LOG_MAX_RANGE_BLOCKS);
  const pending = [];
  for (let start = fromBlock; start <= toBlock; start += chunk) pending.unshift([start, Math.min(toBlock, start + chunk - 1)]);
  let requests = 0;
  const split = (from, to) => {
    if (from === to) throw new LogError('unsplittable_range', from);
    const middle = from + Math.floor((to - from) / 2);
    pending.push([middle + 1, to], [from, middle]);
  };
  while (pending.length) {
    const [from, to] = pending.pop();
    if (++requests > maxRequests) throw new LogError('log_split_exhausted', from);
    let result;
    try {
      result = await provider.request('eth_getLogs', [logFilter(stream, from, to)]);
    } catch (error) {
      if (error instanceof ProviderError && SPLITTABLE.has(error.code)) { split(from, to); continue; }
      throw error;
    }
    if (!Array.isArray(result)) throw new LogError('malformed_log_response', from);
    if (result.length >= suspectResultCount) { split(from, to); continue; }
    yield result;
  }
}

// window: Map blockNumber -> spine block ({ hash, timestamp, txHashes, txFrom, ... }) covering [fromBlock, toBlock].
// seen: (block, logIndex) keys shared by every stream of the window, so no log can be counted twice.
// Returns normalized logs in (block, logIndex) order; nothing else is copied or attached.
export function validateLogs(rawLogs, stream, { fromBlock, toBlock, window, seen }) {
  const logs = [];
  for (const raw of rawLogs) {
    if (raw?.removed === true) throw new LogError('removed_log');
    let log;
    try { log = normalizeLog(raw); } catch { throw new LogError('malformed_log'); }
    if (log.blockNumber < fromBlock || log.blockNumber > toBlock) throw new LogError('log_outside_range', log.blockNumber);
    const block = window.get(log.blockNumber);
    if (!block) throw new LogError('log_block_unknown', log.blockNumber);
    if (log.blockHash !== block.hash) throw new LogError('log_block_hash_mismatch', log.blockNumber);
    if (raw.blockTimestamp != null) {
      let timestamp = null;
      try { timestamp = quantityToSafeNumber(raw.blockTimestamp, 'log block timestamp'); } catch { /* compared below */ }
      if (timestamp !== block.timestamp) throw new LogError('log_timestamp_mismatch', log.blockNumber);
    }
    if (stream.address && !stream.address.includes(log.address)) throw new LogError('unexpected_log_address', log.blockNumber);
    if (!stream.topics.includes(log.topics[0])) throw new LogError('unexpected_log_topic', log.blockNumber);
    if (log.transactionIndex === null || log.transactionHash !== block.txHashes[log.transactionIndex]) {
      throw new LogError('log_transaction_mismatch', log.blockNumber);
    }
    if (log.logIndex >= LOG_INDEX_LIMIT) throw new LogError('malformed_log', log.blockNumber);
    const key = (log.blockNumber - fromBlock) * LOG_INDEX_LIMIT + log.logIndex;
    if (seen.has(key)) throw new LogError('duplicate_log', log.blockNumber);
    seen.add(key);
    logs.push(log);
  }
  return logs.sort((left, right) => left.blockNumber - right.blockNumber || left.logIndex - right.logIndex);
}

// Top-level sender of the transaction that emitted a validated log (a trader; the event `sender` is usually a router).
export const senderOf = (window, log) => window.get(log.blockNumber).txFrom[log.transactionIndex];
