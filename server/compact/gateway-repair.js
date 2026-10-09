// One already-verified stored hour, one Gateway stream, no full block spine/transactions, metadata or projections.
// Log-bearing headers still verify transaction hashes/positions. Stored canonical boundaries are checked twice.
import { GATEWAY_FAMILY, GATEWAY_EVENTS, CIRCLE_ARC } from './protocols/circle.js';
import { normalizeLog } from '../../api/_lib/arc-intelligence/normalize.js';
import { streamLogs, validateLogs, LogError } from './logs.js';
import { headerOf } from './spine.js';
import { codeIsPresent } from './registry.js';

const hex = (number) => `0x${number.toString(16)}`;
export const GATEWAY_REPAIR_LIMITS = Object.freeze({ calls: 128, logRequests: 32, eventBlocks: 64, blocks: 10000 });

export async function repairStoredGatewayHour({ store, provider, hourStart, mode = 'repair' }) {
  if (mode !== 'repair' && mode !== 'inspect') throw new LogError('gateway_repair_mode_invalid');
  const input = store.gatewayRepairInput(hourStart);
  if (!input) throw new LogError('stored_gateway_hour_missing');
  if (input.status === 'available') return { outcome: 'unchanged', calls: 0, evidence: null };
  if (!Number.isSafeInteger(hourStart) || hourStart % 3600 || input.lastBlock - input.firstBlock + 1 > GATEWAY_REPAIR_LIMITS.blocks) {
    throw new LogError('gateway_repair_range_limit');
  }
  let calls = 0;
  const take = (count) => { calls += count; if (calls > GATEWAY_REPAIR_LIMITS.calls) throw new LogError('gateway_repair_call_limit'); };
  const bounded = {
    request(method, params) { take(1); return provider.request(method, params); },
    batch(items) { take(items.length); return provider.batch(items); },
  };
  const boundaries = async () => {
    const numbers = [input.firstBlock - 1, input.firstBlock, input.lastBlock, input.lastBlock + 1];
    const raw = await bounded.batch(numbers.map((number) => ['eth_getBlockByNumber', [hex(number), false]]));
    const [before, first, last, after] = raw.map((row, index) => headerOf(row, numbers[index]));
    if (before.hash !== input.parentHash || first.hash !== input.firstHash || last.hash !== input.lastHash
      || first.parentHash !== before.hash || after.parentHash !== last.hash || before.timestamp >= hourStart
      || first.timestamp < hourStart || last.timestamp >= hourStart + 3600 || after.timestamp < hourStart + 3600) {
      throw new LogError('boundary_hash_mismatch');
    }
  };
  await boundaries();
  const stream = GATEWAY_FAMILY.streams[0];
  const accumulator = GATEWAY_FAMILY.create();
  const seen = new Set(), headers = new Map();
  for await (const raw of streamLogs(bounded, stream, input.firstBlock, input.lastBlock, { maxRequests: GATEWAY_REPAIR_LIMITS.logRequests })) {
    // Evidence extraction verifies only the first unexpected-token candidate, never all log-bearing blocks.
    // It does not derive counters or claim an hour is repaired. Even a dense hour remains a small diagnostic operation.
    let selected = raw;
    if (mode === 'inspect') {
      const candidate = raw.find((item) => {
        const log = normalizeLog(item);
        const definition = Object.values(GATEWAY_EVENTS).find((event) => event.topic === log.topics[0]);
        const event = definition?.decode(log);
        return event && event.token !== CIRCLE_ARC.usdc;
      });
      if (!candidate) continue;
      selected = [candidate];
      const code = await bounded.batch(GATEWAY_FAMILY.codeAddresses.map((address) => ['eth_getCode', [address, hex(input.lastBlock)]]));
      await accumulator.finish({ codePresent: (address) => codeIsPresent(code[GATEWAY_FAMILY.codeAddresses.indexOf(address)]) });
    }
    const numbers = [...new Set(selected.map((log) => Number(BigInt(log.blockNumber))))];
    for (const number of numbers) {
      if (!Number.isSafeInteger(number) || number < input.firstBlock || number > input.lastBlock) throw new LogError('log_outside_range');
      if (headers.has(number)) continue;
      if (headers.size >= GATEWAY_REPAIR_LIMITS.eventBlocks) throw new LogError('gateway_repair_event_block_limit');
      const block = await bounded.request('eth_getBlockByNumber', [hex(number), false]);
      const header = headerOf(block, number);
      if (header.timestamp < hourStart || header.timestamp >= hourStart + 3600
        || !Array.isArray(block.transactions) || !block.transactions.every((tx) => /^0x[0-9a-f]{64}$/i.test(tx))) {
        throw new LogError('gateway_repair_block_invalid', number);
      }
      headers.set(number, { ...header, txHashes: block.transactions.map((tx) => tx.toLowerCase()) });
    }
    try {
      accumulator.add(stream.key, validateLogs(selected, stream,
        { fromBlock: input.firstBlock, toBlock: input.lastBlock, window: headers, seen }));
    } catch (error) {
      if (mode === 'inspect' && error.evidence) await boundaries();
      throw error;
    }
  }
  if (mode === 'inspect') return { outcome: 'no_unexpected_token_candidate_observed', calls, evidence: null,
    note: 'No repair or counter verification; no stored row changed.' };
  const code = await bounded.batch(GATEWAY_FAMILY.codeAddresses.map((address) => ['eth_getCode', [address, hex(input.lastBlock)]]));
  const metrics = await accumulator.finish({ codePresent: (address) => codeIsPresent(code[GATEWAY_FAMILY.codeAddresses.indexOf(address)]) });
  await boundaries();
  const outcome = store.commitGatewayRepair(input, metrics);
  return { outcome, calls, repairedFrom: input.reason };
}
