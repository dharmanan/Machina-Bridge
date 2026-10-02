// Compact engine, Stage 3: protocol-only live smoke. Read-only, official Arc public RPC only (rpc.mainnet.arc.io), one small
// completed block range, no Uniswap V3 registry, no database, no writes. It runs the real engine path (block spine, targeted
// log streams, strict decoders, contract code and view checks) for the six protocol families only, and prints each family
// as PASS (available, and at least one of its events was validated and decoded), NO_ACTIVITY (available, but nothing to
// decode in this range: the decoder is NOT verified by this run) or FAIL (unavailable, with the engine's reason). An
// address-only census of the fixed official contracts lists any topic the definitions do not know, so a wrong event
// signature cannot hide behind NO_ACTIVITY.
//   node scripts/smoke-compact-protocols.mjs                         the last 1,500 completed blocks
//   node scripts/smoke-compact-protocols.mjs --blocks=3000           the last 3,000 (at most 5,000)
//   node scripts/smoke-compact-protocols.mjs --from=23385341 --to=23385540
//   node scripts/smoke-compact-protocols.mjs --tx=0x<hash>           the five blocks around one known transaction
//   node scripts/smoke-compact-protocols.mjs --find=aaveV4 [--max-windows=6]
//       newest event of one family: walks back from the safe head in 10,000-block filtered windows, stops at the first hit
//       (never more than --max-windows requests per stream, at most 24), then checks the 500 blocks around it.
// Exit code: 0 every family PASS; 2 no FAIL but some NO_ACTIVITY (unverified); 1 any FAIL or an invalid request.
import { pathToFileURL } from 'node:url';
import { normalizeLog } from '../api/_lib/arc-intelligence/normalize.js';
import { HourIncompleteError, processBlockRange } from '../server/compact/hour.js';
import { LogError, streamLogs } from '../server/compact/logs.js';
import { AAVE_V4_EVENTS } from '../server/compact/protocols/aave.js';
import { ACROSS_EVENTS } from '../server/compact/protocols/across.js';
import { CCTP_EVENTS, GATEWAY_EVENTS } from '../server/compact/protocols/circle.js';
import { PROTOCOL_FAMILIES } from '../server/compact/protocols/index.js';
import { ERC4626_EVENTS, MORPHO_BLUE_EVENTS } from '../server/compact/protocols/morpho.js';
import { createProvider, ProviderError } from '../server/compact/provider.js';
import { LOG_STREAMS } from '../server/compact/sources.js';
import { headerOf } from '../server/compact/spine.js';

export const SMOKE_SAFE_HEAD_MARGIN = 200;
export const SMOKE_DEFAULT_BLOCKS = 1500;
export const SMOKE_MAX_BLOCKS = 5000;
const FIND_WINDOW_BLOCKS = 10_000;
const FIND_MAX_WINDOWS = 24;
const SAMPLES = 2;
const hex = (number) => `0x${number.toString(16)}`;
const NAMES = PROTOCOL_FAMILIES.map((family) => family.name);
const STREAM_KEYS = new Set(PROTOCOL_FAMILIES.flatMap((family) => family.streams.map((stream) => stream.key)));
export const PROTOCOL_STREAMS = LOG_STREAMS.filter((stream) => STREAM_KEYS.has(stream.key));
const FAMILY_OF_STREAM = Object.fromEntries(PROTOCOL_FAMILIES.flatMap((family) => family.streams.map((stream) => [stream.key, family.name])));
const EVENTS = { cctp: CCTP_EVENTS, gateway: GATEWAY_EVENTS, across: ACROSS_EVENTS, aaveV4: AAVE_V4_EVENTS, morphoBlue: MORPHO_BLUE_EVENTS,
  morphoVaultsV2: ERC4626_EVENTS };

// Events of a family that were validated, decoded and counted (official emitters only), read from its own counters.
const DECODED = {
  cctp: (m) => m.outboundTransferCount + m.inboundMintCount + m.messageReceivedCount,
  gateway: (m) => m.depositCount + m.outboundBurnCount + m.inboundMintCount + m.withdrawalInitiatedCount + m.withdrawalCompletedCount,
  across: (m) => m.depositCount + m.fillCount,
  aaveV4: (m) => m.supplyCount + m.withdrawCount + m.borrowCount + m.repayCount + m.liquidationCount,
  morphoBlue: (m) => m.supplyCount + m.withdrawCount + m.borrowCount + m.repayCount + m.supplyCollateralCount + m.withdrawCollateralCount
    + m.liquidationCount + m.marketCreatedCount,
  morphoVaultsV2: (m) => m.depositCount + m.withdrawCount,
};

export function classify(result) {
  return NAMES.map((family) => {
    const metrics = result.families[family];
    if (metrics.status !== 'available') return { family, verdict: 'FAIL', reason: metrics.reason, decoded: null };
    const decoded = DECODED[family](metrics);
    const foreign = family === 'morphoVaultsV2' && metrics.foreignEventCount ? `; ${metrics.foreignEventCount} foreign ERC-4626 events ignored` : '';
    return decoded ? { family, verdict: 'PASS', reason: null, decoded }
      : { family, verdict: 'NO_ACTIVITY', reason: `no official event in range; decoder not verified${foreign}`, decoded: 0 };
  });
}

const json = (value) => JSON.stringify(value, (_key, item) => (typeof item === 'bigint' ? item.toString(10) : item));

// Every log of the fixed official contracts in the range, by topic, marked as counted or not known to the definitions.
async function census(provider, from, to) {
  const families = PROTOCOL_FAMILIES.filter((family) => family.streams.every((stream) => stream.address));
  const owner = new Map(families.flatMap((family) => family.streams.flatMap((stream) => stream.address.map((address) => [address, family]))));
  const out = Object.fromEntries(families.map((family) => [family.name, {}]));
  const pending = [[from, to]];
  while (pending.length) {
    const [low, high] = pending.pop();
    let logs;
    try {
      logs = await provider.request('eth_getLogs', [{ address: [...owner.keys()], fromBlock: hex(low), toBlock: hex(high) }]);
    } catch (error) {
      if (error instanceof ProviderError && ['range_too_large', 'too_many_results'].includes(error.code) && low < high) {
        const middle = low + Math.floor((high - low) / 2);
        pending.push([middle + 1, high], [low, middle]);
        continue;
      }
      throw error;
    }
    if (!Array.isArray(logs)) throw new LogError('malformed_log_response');
    for (const raw of logs) {
      const log = normalizeLog(raw);
      const family = owner.get(log.address);
      if (!family || log.removed) throw new LogError('unexpected_census_log');
      const known = family.streams.some((stream) => stream.topics.includes(log.topics[0]));
      const key = `${known ? 'counted' : 'unknown'} ${log.topics[0] ?? 'anonymous'}`;
      out[family.name][key] = (out[family.name][key] ?? 0) + 1;
    }
  }
  return out;
}

export async function smokeProtocols({ provider, from, to, print = console.log }) {
  if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from < 1 || to < from || to - from + 1 > SMOKE_MAX_BLOCKS) {
    throw new Error('invalid_smoke_range');
  }
  print(`PROTOCOL SMOKE ${provider.endpoint?.url ?? 'provider'} blocks ${from}-${to} (${to - from + 1} blocks), read-only`);
  const samples = Object.fromEntries(NAMES.map((name) => [name, []]));
  // Counted event kinds per transaction: a liquidation sharing its transaction with a repay or withdraw of the same family
  // would mean one flow is counted twice, so it is reported (WARN) for a human to check.
  const kindsByTx = Object.fromEntries(NAMES.map((name) => [name, new Map()]));
  let result = null;
  let failure = null;
  try {
    const before = headerOf(await provider.request('eth_getBlockByNumber', [hex(from - 1), false]), from - 1);
    result = await processBlockRange({ provider, first: from, last: to, before, streams: PROTOCOL_STREAMS, onLogs: (key, logs) => {
      const family = FAMILY_OF_STREAM[key];
      for (const log of logs) {
        const event = Object.entries(EVENTS[family]).find(([, definition]) => definition.topic === log.topics[0]);
        const kinds = kindsByTx[family];
        if (kinds.has(log.transactionHash) || kinds.size < 10_000) kinds.set(log.transactionHash, (kinds.get(log.transactionHash) ?? new Set()).add(event[0]));
        if (samples[family].length < SAMPLES * 4) {
          samples[family].push({ block: log.blockNumber, tx: log.transactionHash, emitter: log.address, event: event[0], args: event[1].decode(log) });
        }
      }
    } });
  } catch (error) {
    if (!(error instanceof HourIncompleteError || error instanceof ProviderError || error?.code)) throw error;
    failure = error.code;
  }
  const verdicts = result ? classify(result) : NAMES.map((family) => ({ family, verdict: 'FAIL', reason: `range_unavailable:${failure}`, decoded: null }));
  let logCensus = null;
  try {
    logCensus = await census(provider, from, to);
  } catch (error) {
    logCensus = { unavailable: error?.code ?? error?.message ?? String(error) };
  }
  const official = new Set(Object.keys(result?.families.morphoVaultsV2.vaults ?? {}));
  const overlaps = Object.fromEntries(NAMES.map((name) => {
    const combos = {};
    for (const kinds of kindsByTx[name].values()) if (kinds.size > 1) combos[[...kinds].sort().join('+')] = (combos[[...kinds].sort().join('+')] ?? 0) + 1;
    return [name, combos];
  }));
  for (const verdict of verdicts) {
    print(`${verdict.family.padEnd(16)} ${verdict.verdict.padEnd(12)} ${verdict.verdict === 'PASS' ? `${verdict.decoded} events decoded` : verdict.reason}`);
    const shown = samples[verdict.family].filter((sample) => verdict.family !== 'morphoVaultsV2' || official.has(sample.emitter)).slice(0, SAMPLES);
    if (verdict.verdict === 'PASS') for (const sample of shown) print(`  sample ${json(sample)}`);
    if (logCensus && !logCensus.unavailable && logCensus[verdict.family]) print(`  census ${json(logCensus[verdict.family])}`);
    if (Object.keys(overlaps[verdict.family]).length) print(`  same-tx ${json(overlaps[verdict.family])}`);
    const liquidationShared = Object.keys(overlaps[verdict.family]).filter((combo) => /liquidat/i.test(combo) && combo.includes('+'));
    if (liquidationShared.length) print(`  WARN a liquidation shares its transaction with other counted events (${liquidationShared.join(', ')}): check for double counting`);
  }
  if (logCensus?.unavailable) print(`CENSUS unavailable (${logCensus.unavailable}); verdicts above are unaffected`);
  const failed = verdicts.filter((item) => item.verdict === 'FAIL').map((item) => item.family);
  const idle = verdicts.filter((item) => item.verdict === 'NO_ACTIVITY').map((item) => item.family);
  const exitCode = failed.length ? 1 : idle.length ? 2 : 0;
  print(`PROVIDER requests=${provider.stats.requests} retries=${provider.stats.retries} calls=${json(provider.stats.calls)}`);
  print(`RESULT ${failed.length ? `FAIL ${failed.join(',')}` : idle.length ? `INCOMPLETE no failure; unverified (no activity): ${idle.join(',')}`
    : 'PASS every protocol family decoded real events'}`);
  return { verdicts, census: logCensus, overlaps, result, exitCode };
}

// Newest validated event of one family under the safe head, from at most maxWindows filtered 10,000-block requests per stream.
export async function findRecentEvent(provider, family, safeHead, maxWindows = 6) {
  const definition = PROTOCOL_FAMILIES.find((item) => item.name === family);
  if (!definition || !Number.isSafeInteger(maxWindows) || maxWindows < 1 || maxWindows > FIND_MAX_WINDOWS) throw new Error('invalid_find_request');
  const streams = PROTOCOL_STREAMS.filter((stream) => FAMILY_OF_STREAM[stream.key] === family).map((stream) => ({ ...stream, maxRange: FIND_WINDOW_BLOCKS }));
  for (let window = 0; window < maxWindows; window++) {
    const to = safeHead - window * FIND_WINDOW_BLOCKS;
    const from = Math.max(1, to - FIND_WINDOW_BLOCKS + 1);
    let newest = null;
    for (const stream of streams) {
      for await (const response of streamLogs(provider, stream, from, to, { maxRequests: 64 })) {
        for (const raw of response) {
          const log = normalizeLog(raw);
          if (!log.removed && (!newest || log.blockNumber > newest.blockNumber)) newest = log;
        }
      }
    }
    if (newest) return { blockNumber: newest.blockNumber, transactionHash: newest.transactionHash, searchedFrom: from };
    if (from === 1) break;
  }
  return null;
}

export function smokeArguments(argv) {
  const value = (name) => argv.find((item) => item.startsWith(`--${name}=`))?.slice(name.length + 3);
  const integer = (name) => (value(name) === undefined ? undefined : /^\d+$/.test(value(name)) ? Number(value(name)) : Number.NaN);
  const request = { blocks: integer('blocks'), from: integer('from'), to: integer('to'), tx: value('tx'), find: value('find'),
    maxWindows: integer('max-windows') ?? 6 };
  const modes = [request.blocks !== undefined, request.from !== undefined || request.to !== undefined, request.tx !== undefined, request.find !== undefined];
  if (modes.filter(Boolean).length > 1 || argv.some((item) => !/^--(blocks|from|to|tx|find|max-windows)=/.test(item))) throw new Error('invalid_arguments');
  if (request.tx !== undefined && !/^0x[0-9a-fA-F]{64}$/.test(request.tx)) throw new Error('invalid_tx');
  if (request.find !== undefined && !NAMES.includes(request.find)) throw new Error('invalid_family');
  return request;
}

// Resolves the arguments to one completed range under the safe head; never wider than SMOKE_MAX_BLOCKS.
export async function smokeRange(provider, request, print = console.log) {
  const safeHead = Number(BigInt(await provider.request('eth_blockNumber'))) - SMOKE_SAFE_HEAD_MARGIN;
  const clip = (from, to) => [Math.max(1, from), Math.min(safeHead, to)];
  if (request.from !== undefined || request.to !== undefined) {
    if (!Number.isSafeInteger(request.from) || !Number.isSafeInteger(request.to) || request.to > safeHead) throw new Error('range_not_completed');
    return [request.from, request.to];
  }
  if (request.tx) {
    const transaction = await provider.request('eth_getTransactionByHash', [request.tx]);
    if (!transaction?.blockNumber) throw new Error('transaction_not_found');
    const number = Number(BigInt(transaction.blockNumber));
    if (number > safeHead) throw new Error('transaction_not_finalized');
    return clip(number - 2, number + 2);
  }
  if (request.find) {
    const found = await findRecentEvent(provider, request.find, safeHead, request.maxWindows);
    if (!found) throw new Error(`no_${request.find}_event_in_${request.maxWindows}_windows`);
    print(`FOUND ${request.find} event at block ${found.blockNumber} tx ${found.transactionHash}`);
    return clip(found.blockNumber - 249, found.blockNumber + 250);
  }
  const blocks = request.blocks ?? SMOKE_DEFAULT_BLOCKS;
  if (!Number.isSafeInteger(blocks) || blocks < 1 || blocks > SMOKE_MAX_BLOCKS) throw new Error('invalid_block_count');
  return clip(safeHead - blocks + 1, safeHead);
}

async function main() {
  const provider = createProvider();
  try {
    const [from, to] = await smokeRange(provider, smokeArguments(process.argv.slice(2)));
    process.exitCode = (await smokeProtocols({ provider, from, to })).exitCode;
  } catch (error) {
    console.log(`RESULT FAIL ${error?.code ?? error?.message ?? String(error)}`);
    process.exitCode = 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) await main();
