// Compact source-first engine: deterministic historical hour processor and its SQLite store. Offline only: recorded
// Arc mainnet fixtures plus a deterministic synthetic chain. No network, no server.
// node:sqlite tests run when the runtime has it (Node 22.13+); COMPACT_REQUIRE_SQLITE=1 turns its absence into a failure.
// COMPACT_SQLITE_DIR (optional) is where the temporary database directory is created; it is deleted afterwards.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { USDC_ERC20_ADDRESS, USDC_SYSTEM_EMITTER } from '../api/_lib/arc-intelligence/usdc.js';
import { UNISWAP_EVENT_TOPICS, UNISWAP_REGISTRY } from '../api/_lib/arc-intelligence/uniswap.js';
import { locateHourBlocks } from '../server/compact/boundary.js';
import { FAMILY_FIELDS } from '../server/compact/families.js';
import { HourIncompleteError, processBlockRange, processHour } from '../server/compact/hour.js';
import { createRecordedFetch, createSyntheticChain, SYNTHETIC_CONTRACTS, SYNTHETIC_PROTOCOL } from '../server/compact/offline.js';
import { PROTOCOL_FAMILIES } from '../server/compact/protocols/index.js';
import { ARC_PRIMARY_ENDPOINT, createProvider, ProviderError } from '../server/compact/provider.js';
import { DISCOVERY_READS_PER_RUN } from '../server/compact/intelligence.js';
import { bootstrapV3Registry, catchUpV3Registry, registrySnapshot } from '../server/compact/registry.js';
import { COMPACT_DEFINITION_VERSION, DENSE_LOG_RANGE_BLOCKS, LOG_STREAMS } from '../server/compact/sources.js';
import { headerOf } from '../server/compact/spine.js';
import { ADDRESS_WINDOW_HOURS, createCompactStore } from '../server/compact/store.js';
import { runCompactHour, runnerConfig } from './run-compact-hour.mjs';
import { validateHour } from './validate-compact-hour.mjs';

const capture = JSON.parse(await readFile(new URL('./fixtures/compact-arc-capture-2026-10-01.json', import.meta.url), 'utf8'));
const truth = JSON.parse(await readFile(new URL('./fixtures/compact-a2-ground-truth.json', import.meta.url), 'utf8'));
const hex = (number) => `0x${number.toString(16)}`;
const ZERO_TOPIC = `0x${'0'.repeat(64)}`;
const digest = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
let passed = 0;
const TEST_FILTERS = (process.env.COMPACT_TEST_FILTER ?? '').split('||').map((value) => value.trim()).filter(Boolean);
async function test(name, run) {
  if (TEST_FILTERS.length && !TEST_FILTERS.some((value) => name.includes(value))) return;
  await run();
  passed += 1;
  console.log(`PASS ${name}`);
}

function offlineProvider(fetchImpl, options = {}) {
  return createProvider({ fetchImpl, minIntervalMs: 0, cooldownMs: 0, sleep: async () => {}, ...options });
}
async function rejectsWith(promise, code) {
  let error;
  try { await promise; } catch (caught) { error = caught; }
  assert(error, `expected ${code}, got a result`);
  assert.equal(error.code, code, `expected ${code}, got ${error.code ?? error.message}`);
  return error;
}

// Synthetic hour: aligned UTC hour, origin 1000 s before it, safe head ~25 minutes after it.
const HOUR = 1_790_006_400;
const ORIGIN = { originNumber: 23_000_000, originTimestamp: HOUR - 1000 };
const SAFE_HEAD = ORIGIN.originNumber + 12_000;
// The official V3 pool is created inside the synthetic hour (block 23,002,500) and swaps in that same block.
const POOL_CREATED_AT = 23_002_500;
const chainOf = (options = {}) => createSyntheticChain({ ...ORIGIN, poolCreatedAt: POOL_CREATED_AT, ...options });
// Official V3 pool registry for the synthetic chain: from the factory deployment past every hour the tests process.
const V3 = registrySnapshot(await bootstrapV3Registry(offlineProvider(chainOf().fetchImpl),
  { fromBlock: ORIGIN.originNumber, toBlock: ORIGIN.originNumber + 25_000 }));

function firstAtOrAfter(chain, target) {
  let number = ORIGIN.originNumber + Math.floor(((target - ORIGIN.originTimestamp) * 10000) / 5074) - 5;
  while (chain.timestampOf(number) >= target) number -= 1;
  while (chain.timestampOf(number) < target) number += 1;
  return number;
}

// Independent reference straight from the generator: no engine module, normalizer or decoder involved.
function reference(chain, first, last) {
  const senders = new Set(), recipients = new Set(), v4Traders = new Set(), v4Pools = new Set(), v3Traders = new Set();
  const v3Foreign = new Set();
  const out = { blockCount: 0, transactionCount: 0, gasUsed: 0n, deployments: 0, usdc: 0, usdcAmount: 0n, mints: 0, burns: 0,
    eurc: 0, v4Swaps: 0, v4Modify: 0, v4Init: 0, v3Swaps: 0, v3Mints: 0, v3Created: 0, v3ForeignEvents: 0 };
  for (let number = first; number <= last; number++) {
    const transactions = chain.transactionsOf(number);
    out.blockCount += 1;
    out.gasUsed += BigInt(chain.rawBlock(number, false).gasUsed);
    for (const tx of transactions) {
      out.transactionCount += 1;
      senders.add(tx.from);
      if (tx.to) recipients.add(tx.to); else out.deployments += 1;
    }
    for (const log of chain.logsOf(number)) {
      const from = transactions[Number(log.transactionIndex)].from;
      if (log.address === USDC_SYSTEM_EMITTER.toLowerCase()) {
        out.usdc += 1; out.usdcAmount += BigInt(log.data);
        if (log.topics[1] === ZERO_TOPIC) out.mints += 1;
        if (log.topics[2] === ZERO_TOPIC) out.burns += 1;
      } else if (log.address === SYNTHETIC_CONTRACTS.eurc) out.eurc += 1;
      else if (log.topics[0] === UNISWAP_EVENT_TOPICS.v4Swap) { out.v4Swaps += 1; v4Traders.add(from); v4Pools.add(log.topics[1]); }
      else if (log.topics[0] === UNISWAP_EVENT_TOPICS.v4ModifyLiquidity) out.v4Modify += 1;
      else if (log.topics[0] === UNISWAP_EVENT_TOPICS.v4Initialize) out.v4Init += 1;
      else if (log.topics[0] === UNISWAP_EVENT_TOPICS.v3PoolCreated) out.v3Created += 1;
      else if (log.address === SYNTHETIC_CONTRACTS.validV3Pool && log.topics[0] === UNISWAP_EVENT_TOPICS.v3Swap) { out.v3Swaps += 1; v3Traders.add(from); }
      else if (log.address === SYNTHETIC_CONTRACTS.validV3Pool && log.topics[0] === UNISWAP_EVENT_TOPICS.v3Mint) out.v3Mints += 1;
      else if (log.topics[0] === UNISWAP_EVENT_TOPICS.v3Swap) { out.v3ForeignEvents += 1; v3Foreign.add(log.address); }
    }
  }
  return { ...out, senders: senders.size, recipients: recipients.size, active: new Set([...senders, ...recipients]).size,
    v4Traders: v4Traders.size, v4Pools: v4Pools.size, v3Traders: v3Traders.size, v3ForeignEmitters: v3Foreign.size };
}

const clean = chainOf();
const expectedFirst = firstAtOrAfter(clean, HOUR);
const expectedLast = firstAtOrAfter(clean, HOUR + 3600) - 1;
const expected = reference(clean, expectedFirst, expectedLast);
const cleanProvider = offlineProvider(clean.fetchImpl);
const cleanResult = await processHour({ provider: cleanProvider, hourStart: HOUR, safeHead: SAFE_HEAD, v3Registry: V3 });
// Stage 3 protocol families read a few views per hour (Aave reserves, Morpho markets and vaults); Uniswap reads none.
const PROTOCOL_ETH_CALLS = cleanProvider.stats.calls.eth_call;
assert(PROTOCOL_ETH_CALLS > 0 && cleanResult.complete);
// The Stage 1/2 streams: the recorded mainnet fixtures hold exactly these, nothing for the Stage 3 protocol families.
const STAGE2_STREAMS = LOG_STREAMS.filter((stream) => ['usdc', 'assets', 'v3Factory', 'v3Pools', 'v4'].includes(stream.key));
const FAMILY_NAMES = Object.keys(FAMILY_FIELDS);

function assertNullFamily(result, name, reason) {
  const family = result.families[name];
  assert.equal(family.status, 'unavailable');
  assert.equal(family.reason, reason);
  for (const field of FAMILY_FIELDS[name]) assert.equal(family[field], null, `${name}.${field} must be null, never zero`);
  assert.equal(result.complete, false);
}

// Recorded Arc headers, replayed as eth_getBlockByNumber(n, false) responses.
const headerCalls = capture.boundary.headers.map((header) => ({ method: 'eth_getBlockByNumber', params: [hex(header.number), false],
  result: { number: hex(header.number), hash: header.hash, parentHash: header.parentHash, timestamp: hex(header.timestamp), transactions: [] } }));

// 1. Hour boundary selection
await test('hour boundary selection: synthetic hour is exact, including shared-second neighbours', async () => {
  assert.equal(cleanResult.range.firstBlock, expectedFirst);
  assert.equal(cleanResult.range.lastBlock, expectedLast);
  assert(clean.timestampOf(expectedFirst - 1) < HOUR && clean.timestampOf(expectedFirst) >= HOUR);
  assert(clean.timestampOf(expectedLast) < HOUR + 3600 && clean.timestampOf(expectedLast + 1) >= HOUR + 3600);
  assert.equal(clean.timestampOf(expectedFirst), clean.timestampOf(expectedFirst + 1), 'fixture must exercise equal timestamps');
  assert.equal(cleanResult.network.blockCount, expectedLast - expectedFirst + 1);
  assert.equal(cleanResult.range.startUtc, new Date(HOUR * 1000).toISOString());
});

await test('hour boundary selection: 8 recorded Arc mainnet hours equal A2 verified block counts', async () => {
  const recorded = createRecordedFetch(headerCalls);
  const provider = offlineProvider(recorded.fetchImpl);
  const header = async (number) => headerOf(await provider.request('eth_getBlockByNumber', [hex(number), false]), number);
  for (const hour of truth.hours) {
    const bounds = await locateHourBlocks({ header, safeHead: capture.boundary.safeHead, hourStart: hour.hourStart, hourEnd: hour.hourStart + 3600 });
    assert.equal(bounds.last.number - bounds.first.number + 1, hour.blocks, hour.utc);
    assert.equal(bounds.first.parentHash, bounds.before.hash);
    assert.equal(bounds.after.parentHash, bounds.last.hash);
    assert(bounds.before.timestamp < hour.hourStart && bounds.first.timestamp >= hour.hourStart);
    assert(bounds.last.timestamp < hour.hourStart + 3600 && bounds.after.timestamp >= hour.hourStart + 3600);
  }
  assert.deepEqual(recorded.missing, []);
});

// 2. Block continuity
await test('block continuity: broken parent hash inside the hour fails the hour', async () => {
  const chain = chainOf({ faults: { block: (n, raw, full) => (full && n === expectedFirst + 1500 ? { ...raw, parentHash: `0x${'ab'.repeat(32)}` } : raw) } });
  const error = await rejectsWith(processHour({ provider: offlineProvider(chain.fetchImpl), hourStart: HOUR, safeHead: SAFE_HEAD, v3Registry: V3 }), 'parent_hash_mismatch');
  assert(error instanceof HourIncompleteError);
  assert.equal(error.blockNumber, expectedFirst + 1500);
});

await test('block continuity: right boundary block must descend from the last hour block', async () => {
  const chain = chainOf({ faults: { block: (n, raw, full) => (!full && n === expectedLast + 1 ? { ...raw, parentHash: `0x${'cd'.repeat(32)}` } : raw) } });
  await rejectsWith(processHour({ provider: offlineProvider(chain.fetchImpl), hourStart: HOUR, safeHead: SAFE_HEAD, v3Registry: V3 }), 'right_boundary_mismatch');
});

// 3. Missing block
await test('missing block: null body or hash-only body is never an empty block', async () => {
  const missing = chainOf({ faults: { block: (n, raw, full) => (full && n === expectedFirst + 10 ? null : raw) } });
  await rejectsWith(processHour({ provider: offlineProvider(missing.fetchImpl), hourStart: HOUR, safeHead: SAFE_HEAD, v3Registry: V3 }), 'missing_block');
  const hashesOnly = chainOf({ faults: { block: (n, raw, full) => (full && n === expectedFirst + 20 ? { ...raw, transactions: raw.transactions.map((tx) => tx.hash) } : raw) } });
  await rejectsWith(processHour({ provider: offlineProvider(hashesOnly.fetchImpl), hourStart: HOUR, safeHead: SAFE_HEAD, v3Registry: V3 }), 'transaction_bodies_missing');
});

// 4. Malformed batch response
await test('malformed batch response: short, duplicate-id and truncated batches fail closed after bounded retries, no failover', async () => {
  const isBodyBatch = (body) => Array.isArray(body) && body[0]?.method === 'eth_getBlockByNumber';
  const variants = [
    (body) => body.slice(1).map((item) => ({ jsonrpc: '2.0', id: item.id, result: null })),
    (body) => body.map((item) => ({ jsonrpc: '2.0', id: 1, result: null })),
    () => '[{"jsonrpc":"2.0","id":1,"result":{"number":"0x1"',
  ];
  for (const variant of variants) {
    const chain = chainOf({ faults: { request: (body) => (isBodyBatch(body) ? variant(body) : undefined) } });
    const provider = offlineProvider(chain.fetchImpl);
    await rejectsWith(processHour({ provider, hourStart: HOUR, safeHead: SAFE_HEAD, v3Registry: V3 }), 'invalid_response');
    assert.equal(provider.stats.retries, 2, 'three attempts on the one endpoint');
    assert(chain.requests.length > 0 && provider.endpoint.name === ARC_PRIMARY_ENDPOINT.name);
  }
  let once = true;
  const transient = chainOf({ faults: { request: (body) => (isBodyBatch(body) && once ? ((once = false), '[]') : undefined) } });
  const provider = offlineProvider(transient.fetchImpl);
  assert.deepEqual(await processHour({ provider, hourStart: HOUR, safeHead: SAFE_HEAD, v3Registry: V3 }), cleanResult);
  assert.equal(provider.stats.retries, 1);
});

// 5. Provider item-level -32005
await test('provider item-level -32005: real recorded Arc batch never becomes empty data', async () => {
  const items = capture.rateLimitedBatchItems;
  const fetchImpl = async (_url, init) => ({ status: 200, ok: true,
    text: async () => JSON.stringify(Array.isArray(JSON.parse(init.body))
      ? items.map((item, index) => ({ jsonrpc: '2.0', id: index + 1, error: item.error }))
      : { jsonrpc: '2.0', id: 1, result: hex(5042) }) });
  const provider = offlineProvider(fetchImpl);
  const error = await rejectsWith(provider.batch(items.map((item) => ['eth_getLogs', item.params]), { allowItemErrors: true }), 'rate_limited');
  assert(error instanceof ProviderError);
  assert.equal(error.rpcCode, -32005);
  assert.equal(error.detail, 'rate limit exceeded', 'the RPC message is kept for diagnostics');
  assert.equal(provider.stats.requests, 3 + 1, 'three attempts on the one endpoint plus one chainId check');
});

await test('provider item-level -32005: one rate-limited body item is retried, result unchanged, getLogs never batched', async () => {
  let once = true;
  const chain = chainOf({ faults: { request: (body) => {
    if (!Array.isArray(body) || body[0]?.method !== 'eth_getBlockByNumber' || !once) return undefined;
    once = false;
    return body.map((item, index) => (index === 3 ? { jsonrpc: '2.0', id: item.id, error: { code: -32005, message: 'rate limit exceeded' } }
      : { jsonrpc: '2.0', id: item.id, result: chain.rawBlock(Number(BigInt(item.params[0])), true) }));
  } } });
  const provider = offlineProvider(chain.fetchImpl);
  assert.deepEqual(await processHour({ provider, hourStart: HOUR, safeHead: SAFE_HEAD, v3Registry: V3 }), cleanResult);
  assert.equal(provider.stats.retries, 1);
  assert(!chain.requests.some((request) => Array.isArray(request) && request.includes('eth_getLogs')), 'eth_getLogs must never be batched');
  assert(chain.requests.filter(Array.isArray).every((request) => request.length <= 50), 'batches are at most 50 calls');
});

// 6. Range splitting
await test('range splitting: -32012 and -32602 split down to identical results; one-block overflow fails closed', async () => {
  for (const limits of [{ maxRange: 300 }, { maxResults: 2000 }]) {
    const chain = chainOf({ limits });
    const provider = offlineProvider(chain.fetchImpl);
    assert.deepEqual(await processHour({ provider, hourStart: HOUR, safeHead: SAFE_HEAD, v3Registry: V3 }), cleanResult, JSON.stringify(limits));
  }
  const chain = chainOf({ limits: { maxResults: 3 } });
  const result = await processHour({ provider: offlineProvider(chain.fetchImpl), hourStart: HOUR, safeHead: SAFE_HEAD, v3Registry: V3 });
  assertNullFamily(result, 'usdc', 'unsplittable_range');
  assert.deepEqual(result.network, cleanResult.network, 'network spine is unaffected by a log family failure');
});

// 7. Removed log rejection
await test('removed log rejection: a removed log makes its family unavailable, never a smaller count', async () => {
  const chain = chainOf({ faults: { logs: (filter, logs) => (filter.address?.[0] === USDC_SYSTEM_EMITTER.toLowerCase() && logs.length
    ? logs.map((log, index) => (index === 7 ? { ...log, removed: true } : log)) : logs) } });
  const result = await processHour({ provider: offlineProvider(chain.fetchImpl), hourStart: HOUR, safeHead: SAFE_HEAD, v3Registry: V3 });
  assertNullFamily(result, 'usdc', 'removed_log');
  assert.deepEqual(result.families.uniswapV4, cleanResult.families.uniswapV4);
});

// 8. blockHash mismatch
await test('blockHash mismatch: a log from another block hash or transaction is rejected', async () => {
  const isV4 = (filter) => filter.address?.[0] === UNISWAP_REGISTRY.v4PoolManager.address;
  const wrongHash = chainOf({ faults: { logs: (filter, logs) => (isV4(filter) && logs.length
    ? [{ ...logs[0], blockHash: `0x${'ee'.repeat(32)}` }, ...logs.slice(1)] : logs) } });
  const first = await processHour({ provider: offlineProvider(wrongHash.fetchImpl), hourStart: HOUR, safeHead: SAFE_HEAD, v3Registry: V3 });
  assertNullFamily(first, 'uniswapV4', 'log_block_hash_mismatch');
  const wrongTx = chainOf({ faults: { logs: (filter, logs) => (isV4(filter) && logs.length
    ? [{ ...logs[0], transactionHash: `0x${'ff'.repeat(32)}` }, ...logs.slice(1)] : logs) } });
  const second = await processHour({ provider: offlineProvider(wrongTx.fetchImpl), hourStart: HOUR, safeHead: SAFE_HEAD, v3Registry: V3 });
  assertNullFamily(second, 'uniswapV4', 'log_transaction_mismatch');
});

// 9. Canonical USDC semantics
await test('canonical USDC semantics: system emitter only, mint/burn by zero address, 18-decimal raw amounts', async () => {
  const usdcStream = LOG_STREAMS.find((stream) => stream.key === 'usdc');
  assert.deepEqual(usdcStream.address, [USDC_SYSTEM_EMITTER.toLowerCase()]);
  assert(!LOG_STREAMS.some((stream) => stream.address?.includes(USDC_ERC20_ADDRESS)), 'the 0x3600 ERC-20 interface is never requested');
  const usdc = cleanResult.families.usdc;
  assert.deepEqual(usdc, { status: 'available', transferCount: expected.usdc, amountRaw: expected.usdcAmount.toString(10), rawDecimals: 18,
    mintCount: expected.mints, burnCount: expected.burns });
  assert(expected.mints > 0 && expected.burns > 0);
  const injected = chainOf({ faults: { logs: (filter, logs) => (filter.address?.[0] === USDC_SYSTEM_EMITTER.toLowerCase() && logs.length
    ? [...logs, { ...logs[0], address: USDC_ERC20_ADDRESS, logIndex: '0x3e7' }] : logs) } });
  const result = await processHour({ provider: offlineProvider(injected.fetchImpl), hourStart: HOUR, safeHead: SAFE_HEAD, v3Registry: V3 });
  assertNullFamily(result, 'usdc', 'unexpected_log_address');
});

// 10. Unique address semantics
await test('unique address semantics: top-level from ∪ to, deployments are not recipients, traders are tx senders', async () => {
  const network = cleanResult.network;
  assert.equal(network.transactionCount, expected.transactionCount);
  assert.equal(network.uniqueSenders, expected.senders);
  assert.equal(network.uniqueRecipients, expected.recipients);
  assert.equal(network.uniqueActiveAddresses, expected.active);
  assert.equal(network.gasUsedRaw, expected.gasUsed.toString(10));
  assert.equal(network.internal.deploymentAttempts, expected.deployments);
  assert(expected.deployments > 0);
  assert.equal(network.transactionsPerSecond, expected.transactionCount / 3600);
  const v4 = cleanResult.families.uniswapV4;
  assert.deepEqual(v4, { status: 'available', initializeCount: expected.v4Init, swapCount: expected.v4Swaps, modifyLiquidityCount: expected.v4Modify,
    uniqueTraders: expected.v4Traders, poolsWithSwaps: expected.v4Pools });
  assert(expected.v4Traders > 1, 'all synthetic V4 events share one router sender; traders must come from tx.from');
  const v3 = cleanResult.families.uniswapV3;
  assert.equal(v3.swapCount, expected.v3Swaps);
  assert.equal(v3.mintCount, expected.v3Mints);
  assert.equal(v3.poolCreatedCount, expected.v3Created);
  assert.equal(v3.uniqueTraders, expected.v3Traders);
  assert.equal(v3.poolsWithSwaps, 1);
  assert.equal(v3.foreignEmitterCount, 1, 'an emitter outside the official registry is foreign, never an official pool');
  assert.equal(v3.foreignEventCount, expected.v3ForeignEvents);
  assert(!('verifiedPools' in v3), 'pool details live in the registry, not in every hourly result');
  assert.deepEqual(cleanResult.registry.uniswapV3.created.map((pool) => pool.address), [SYNTHETIC_CONTRACTS.validV3Pool]);
  assert.equal(cleanResult.families.assets.items.find((item) => item.symbol === 'EURC').transferCount, expected.eurc);
});

// Real Arc mainnet micro window (blocks 23677449-23677452, crosses 08:00 UTC): equivalence with the raw responses.
const micro = capture.microWindow;
const microBefore = headerOf(micro.calls[0].result, micro.first - 1);
// A registry known complete through the block before the window; no official pool emitted inside it.
const microRegistry = { fromBlock: 0, through: micro.first - 1, throughHash: microBefore.hash, pools: new Set() };
async function runMicro() {
  const recorded = createRecordedFetch(micro.calls);
  const provider = offlineProvider(recorded.fetchImpl);
  const result = await processBlockRange({ provider, first: micro.first, last: micro.last, before: microBefore, v3Registry: microRegistry,
    streams: STAGE2_STREAMS });
  assert.deepEqual(recorded.missing, []);
  return { result, provider };
}
const { result: microResult, provider: microProvider } = await runMicro();

await test('real Arc micro window: network, canonical USDC and V4 equal an independent count of the recorded responses', async () => {
  const bodies = micro.calls.filter((call) => call.method === 'eth_getBlockByNumber' && call.params[1] === true).map((call) => call.result);
  const transactions = bodies.flatMap((block) => block.transactions);
  const senders = new Set(transactions.map((tx) => tx.from));
  const recipients = new Set(transactions.map((tx) => tx.to).filter(Boolean));
  assert.equal(microResult.network.blockCount, 4);
  assert.equal(microResult.network.transactionCount, transactions.length);
  assert.equal(microResult.network.uniqueActiveAddresses, new Set([...senders, ...recipients]).size);
  assert.equal(microResult.network.gasUsedRaw, bodies.reduce((sum, block) => sum + BigInt(block.gasUsed), 0n).toString(10));
  const logsOf = (address) => micro.calls.find((call) => call.method === 'eth_getLogs' && call.params[0].address?.[0] === address).result;
  const usdcLogs = logsOf(USDC_SYSTEM_EMITTER.toLowerCase());
  assert.deepEqual(microResult.families.usdc, { status: 'available', transferCount: usdcLogs.length,
    amountRaw: usdcLogs.reduce((sum, log) => sum + BigInt(log.data), 0n).toString(10), rawDecimals: 18,
    mintCount: usdcLogs.filter((log) => log.topics[1] === ZERO_TOPIC).length, burnCount: usdcLogs.filter((log) => log.topics[2] === ZERO_TOPIC).length });
  const v4Logs = logsOf(UNISWAP_REGISTRY.v4PoolManager.address);
  const swapSenders = new Set(v4Logs.map((log) => transactions.find((tx) => tx.hash === log.transactionHash).from));
  assert.equal(new Set(v4Logs.map((log) => log.topics[2])).size, 1, 'every recorded swap names the same router as event sender');
  assert.deepEqual(microResult.families.uniswapV4, { status: 'available', initializeCount: 0, swapCount: v4Logs.length, modifyLiquidityCount: 0,
    uniqueTraders: swapSenders.size, poolsWithSwaps: new Set(v4Logs.map((log) => log.topics[1])).size });
  assert.equal(microResult.families.uniswapV3.swapCount, 0);
  assert(microResult.families.assets.items.every((item) => item.transferCount === 0));
  for (const name of ['usdc', 'assets', 'uniswapV3', 'uniswapV4']) assert.equal(microResult.families[name].status, 'available', name);
  for (const { name } of PROTOCOL_FAMILIES) {
    assert.deepEqual([microResult.families[name].status, microResult.families[name].reason], ['unavailable', 'stream_not_requested'], name);
  }
  assert.equal(microResult.range.lastHash, bodies.at(-1).hash);
});

// 11. Incomplete hour never zero
await test('incomplete hour never zero: unfinished hour, missing bodies and failed families never read as 0', async () => {
  await rejectsWith(processHour({ provider: offlineProvider(clean.fetchImpl), hourStart: HOUR, safeHead: expectedLast - 5 }), 'hour_not_finalized');
  const recorded = createRecordedFetch(headerCalls);
  const error = await rejectsWith(processHour({ provider: offlineProvider(recorded.fetchImpl), hourStart: truth.hours[7].hourStart,
    safeHead: capture.boundary.safeHead }), 'rpc_error');
  assert(error instanceof HourIncompleteError, 'recorded Arc hour without bodies yields no result at all');
  const failing = chainOf({ faults: { request: (body) => (!Array.isArray(body) && body.method === 'eth_getLogs'
    && body.params[0].address?.[0] === UNISWAP_REGISTRY.v4PoolManager.address ? { jsonrpc: '2.0', id: 1, error: { code: -32000, message: 'header not found' } } : undefined) } });
  const result = await processHour({ provider: offlineProvider(failing.fetchImpl), hourStart: HOUR, safeHead: SAFE_HEAD, v3Registry: V3 });
  assertNullFamily(result, 'uniswapV4', 'rpc_error');
  assert.equal(JSON.stringify(result.families.uniswapV4).includes(':0'), false);
});

await test('dense streams: canonical USDC, V4 and topic-only V3 requests never span more than 500 blocks and stay gap-free', async () => {
  const spans = {};
  const chain = chainOf({ faults: { request: (body) => {
    if (!Array.isArray(body) && body.method === 'eth_getLogs') {
      const filter = body.params[0];
      const key = LOG_STREAMS.find((stream) => (stream.address?.[0] ?? null) === (filter.address?.[0] ?? null)
        && stream.topics[0] === filter.topics[0][0]).key;
      (spans[key] ??= []).push(Number(BigInt(filter.toBlock) - BigInt(filter.fromBlock)) + 1);
    }
    return undefined;
  } } });
  const result = await processHour({ provider: offlineProvider(chain.fetchImpl), hourStart: HOUR, safeHead: SAFE_HEAD, windowBlocks: 2000, v3Registry: V3 });
  assert.deepEqual(result, cleanResult);
  for (const key of ['usdc', 'v4', 'v3Pools', 'erc4626Vaults']) {
    assert(Math.max(...spans[key]) <= DENSE_LOG_RANGE_BLOCKS, `${key} requested ${Math.max(...spans[key])} blocks`);
    assert.equal(spans[key].reduce((sum, span) => sum + span, 0), cleanResult.network.blockCount);
  }
  assert(Math.max(...spans.assets) > DENSE_LOG_RANGE_BLOCKS, 'sparse streams follow the window size');
});

// Replaces the Stage 1 per-hour eth_call pool check: V3 sources now fail closed on RPC errors with no eth_call at all.
await test('V3 source check: a non-revert RPC error on a V3 stream makes V3 unavailable; no eth_call is ever made', async () => {
  const isV3 = (body) => !Array.isArray(body) && body.method === 'eth_getLogs' && body.params[0].topics[0][0] === UNISWAP_EVENT_TOPICS.v3Swap;
  const lagging = chainOf({ faults: { request: (body) => (isV3(body) ? { jsonrpc: '2.0', id: 1, error: { code: -32000, message: 'header not found' } } : undefined) } });
  const provider = offlineProvider(lagging.fetchImpl);
  const unavailable = await processHour({ provider, hourStart: HOUR, safeHead: SAFE_HEAD, v3Registry: V3 });
  assertNullFamily(unavailable, 'uniswapV3', 'rpc_error');
  assert.equal(unavailable.registry.uniswapV3, null, 'an unavailable V3 hour adds nothing to the registry');
  assert.deepEqual(unavailable.network, cleanResult.network);
  assert.equal(provider.stats.calls.eth_call ?? 0, PROTOCOL_ETH_CALLS, 'V3 adds no eth_call; only protocol families read views');
});

await test('V3 registry: bootstrap proves its start, catch-up checks continuity, same-hour pools come from the overlay', async () => {
  const provider = offlineProvider(chainOf().fetchImpl);
  await rejectsWith(bootstrapV3Registry(provider, { fromBlock: ORIGIN.originNumber + 1, toBlock: ORIGIN.originNumber + 10 }),
    'registry_start_after_factory_deployment');
  const early = await bootstrapV3Registry(provider, { fromBlock: ORIGIN.originNumber, toBlock: expectedFirst - 1001 });
  assert.deepEqual(early.created, [], 'the official pool is created inside the hour, after this bootstrap');
  const behind = await processHour({ provider, hourStart: HOUR, safeHead: SAFE_HEAD, v3Registry: registrySnapshot(early) });
  assertNullFamily(behind, 'uniswapV3', 'v3_registry_behind');
  assert.deepEqual(behind.network, cleanResult.network);
  const missing = await processHour({ provider, hourStart: HOUR, safeHead: SAFE_HEAD });
  assertNullFamily(missing, 'uniswapV3', 'v3_registry_missing');
  await rejectsWith(catchUpV3Registry(provider, { ...registrySnapshot(early), throughHash: `0x${'aa'.repeat(32)}` }, expectedFirst - 1), 'v3_registry_fork');
  const caught = registrySnapshot(await catchUpV3Registry(provider, registrySnapshot(early), expectedFirst - 1), registrySnapshot(early));
  assert.equal(caught.through, expectedFirst - 1);
  assert.equal(caught.pools.size, 0);
  const forked = await processHour({ provider, hourStart: HOUR, safeHead: SAFE_HEAD, v3Registry: { ...caught, throughHash: `0x${'bb'.repeat(32)}` } });
  assertNullFamily(forked, 'uniswapV3', 'v3_registry_fork');
  const overlay = await processHour({ provider, hourStart: HOUR, safeHead: SAFE_HEAD, v3Registry: caught });
  assert(clean.logsOf(POOL_CREATED_AT).some((log) => log.address === SYNTHETIC_CONTRACTS.validV3Pool && log.topics[0] === UNISWAP_EVENT_TOPICS.v3Swap),
    'the fixture swaps in the pool creation block');
  assert.deepEqual(overlay, cleanResult, 'a registry ending right before the hour plus the overlay equals a registry past the hour');
  assert.deepEqual(overlay.registry.uniswapV3.created.map((pool) => [pool.address, pool.createdBlock]), [[SYNTHETIC_CONTRACTS.validV3Pool, POOL_CREATED_AT]]);
  assert.equal(overlay.registry.uniswapV3.through, expectedLast);
});

await test('V3: more than 50 foreign V3-signature emitters never make V3 unavailable and cost no RPC reads', async () => {
  const chain = chainOf({ foreignV3Emitters: 80, foreignV3Every: 10 });
  const provider = offlineProvider(chain.fetchImpl);
  const result = await processHour({ provider, hourStart: HOUR, safeHead: SAFE_HEAD, v3Registry: V3 });
  const many = reference(chain, expectedFirst, expectedLast);
  assert(many.v3ForeignEmitters === 80 && many.v3ForeignEvents > 500);
  const v3 = result.families.uniswapV3;
  assert.equal(v3.status, 'available');
  assert.deepEqual({ foreignEmitterCount: v3.foreignEmitterCount, foreignEventCount: v3.foreignEventCount },
    { foreignEmitterCount: 80, foreignEventCount: many.v3ForeignEvents });
  assert.deepEqual({ ...v3, foreignEmitterCount: 1, foreignEventCount: expected.v3ForeignEvents }, cleanResult.families.uniswapV3,
    'official pool metrics are unchanged by foreign emitters');
  assert.equal(result.complete, true);
  assert.equal(provider.stats.calls.eth_call ?? 0, PROTOCOL_ETH_CALLS, 'foreign V3 emitters cost no eth_call');
});

await test('V3: a malformed event from an official pool fails closed; a malformed foreign event is ignored', async () => {
  const corrupt = (target) => chainOf({ faults: { logs: (filter, logs) => logs.map((log) => (log.address === target
    && log.topics[0] === UNISWAP_EVENT_TOPICS.v3Swap ? { ...log, data: '0x00' } : log)) } });
  const official = await processHour({ provider: offlineProvider(corrupt(SYNTHETIC_CONTRACTS.validV3Pool).fetchImpl), hourStart: HOUR,
    safeHead: SAFE_HEAD, v3Registry: V3 });
  assertNullFamily(official, 'uniswapV3', 'malformed_v3_pool_event');
  const foreign = await processHour({ provider: offlineProvider(corrupt(SYNTHETIC_CONTRACTS.foreignV3Emitter).fetchImpl), hourStart: HOUR,
    safeHead: SAFE_HEAD, v3Registry: V3 });
  assert.deepEqual(foreign, cleanResult);
});

await test('omitted streams: a family whose streams were not requested is unavailable with nulls, never zero', async () => {
  // A bounded range around the official pool's creation, so every omitted family would have had real activity.
  const first = POOL_CREATED_AT - 50;
  const last = POOL_CREATED_AT + 149;
  const before = headerOf(clean.rawBlock(first - 1, false), first - 1);
  const range = (streams) => processBlockRange({ provider: offlineProvider(chainOf().fetchImpl), first, last, before, v3Registry: V3, streams });
  const full = await range(LOG_STREAMS);
  assert.equal(full.complete, true);
  assert(full.families.uniswapV3.swapCount > 0 && full.families.uniswapV4.swapCount > 0
    && full.families.assets.items.find((item) => item.symbol === 'EURC').transferCount > 0, 'each omitted family has activity in this range');
  for (const [name, omitted] of [['uniswapV3', ['v3Factory', 'v3Pools']], ['uniswapV3', ['v3Pools']], ['uniswapV4', ['v4']], ['assets', ['assets']]]) {
    const result = await range(LOG_STREAMS.filter((stream) => !omitted.includes(stream.key)));
    assertNullFamily(result, name, 'stream_not_requested');
    for (const other of Object.keys(full.families).filter((key) => key !== name)) {
      assert.deepEqual(result.families[other], full.families[other], `omitting ${omitted} must not change ${other}`);
    }
    assert.deepEqual(result.network, full.network);
  }
  assert.equal((await range(LOG_STREAMS.filter((stream) => stream.key !== 'v3Pools'))).registry.uniswapV3, null,
    'an unavailable V3 adds nothing to the registry');
});

await test('streaming equivalence: any window size and any per-response split give a byte-identical hour', async () => {
  for (const { windowBlocks, limits } of [{ windowBlocks: 50 }, { windowBlocks: 250 }, { windowBlocks: 1000 }, { limits: { maxRange: 120 } }]) {
    const chain = chainOf(limits ? { limits } : {});
    const result = await processHour({ provider: offlineProvider(chain.fetchImpl), hourStart: HOUR, safeHead: SAFE_HEAD, v3Registry: V3,
      ...(windowBlocks ? { windowBlocks } : {}) });
    assert.equal(digest(result), digest(cleanResult), JSON.stringify({ windowBlocks, limits }));
  }
  // With a 120-block provider limit each 500-block window arrives as several responses; each is handed over on its own,
  // in chain order, and never merged into a window-wide array.
  let previous = -1;
  let widest = 0;
  let responses = 0;
  await processHour({ provider: offlineProvider(chainOf({ limits: { maxRange: 120 } }).fetchImpl), hourStart: HOUR, safeHead: SAFE_HEAD, v3Registry: V3,
    onLogs: (key, logs) => {
      if (key !== 'usdc' || !logs.length) return;
      responses += 1;
      assert(logs[0].blockNumber > previous, 'responses arrive in ascending block order');
      previous = logs.at(-1).blockNumber;
      widest = Math.max(widest, logs.at(-1).blockNumber - logs[0].blockNumber + 1);
    } });
  assert(widest <= 120, `a single hand-over spans ${widest} blocks`);
  assert(responses >= Math.ceil(expected.blockCount / 120));
});

await test('dependency policy: engine, tests and validator import only node: built-ins and repository files', async () => {
  const compactDirectory = new URL('../server/compact/', import.meta.url);
  const queue = [...(await readdir(compactDirectory)).filter((name) => name.endsWith('.js')).map((name) => new URL(name, compactDirectory)),
    new URL(import.meta.url), new URL('./validate-compact-hour.mjs', import.meta.url), new URL('./verify-arc-intelligence-compact-protocols.mjs', import.meta.url),
    new URL('./smoke-compact-protocols.mjs', import.meta.url)];
  const visited = new Set();
  while (queue.length) {
    const url = queue.pop();
    if (visited.has(url.href)) continue;
    visited.add(url.href);
    for (const [, specifier] of (await readFile(url, 'utf8')).matchAll(/(?:\bfrom\s+|\bimport\s*\(\s*)['"]([^'"]+)['"]/g)) {
      if (specifier.startsWith('node:')) continue;
      assert(specifier.startsWith('./') || specifier.startsWith('../'), `${url.pathname} imports a package: ${specifier}`);
      queue.push(new URL(specifier, url));
    }
  }
  assert(visited.size >= 15, `only ${visited.size} modules visited`);
});

// Live validator gate, exercised offline: same code path as the GitHub Actions run, synthetic chains as providers.
const syntheticTruth = { blocks: expected.blockCount, transactions: expected.transactionCount, activeAddresses: expected.active,
  canonicalUsdcTransfers: expected.usdc, usdcMints: expected.mints, usdcBurns: expected.burns };
// secondaryFetch null means no secondary was requested (the default for the live validator without --secondary).
async function validateOffline({ expectedValues = syntheticTruth, secondaryFetch = chainOf().fetchImpl, sqliteDirectory = null } = {}) {
  const lines = [];
  const report = await validateHour({ primary: offlineProvider(chainOf().fetchImpl), secondary: secondaryFetch && offlineProvider(secondaryFetch),
    hourStart: HOUR, expected: expectedValues, sqliteDirectory, v3RegistryFromBlock: ORIGIN.originNumber, print: (text) => lines.push(text) });
  return { report, lines };
}

await test('validator gate: an equal hour prints EXPECTED / ACTUAL / MATCH for every metric and passes', async () => {
  const { report, lines } = await validateOffline();
  assert.equal(report.ok, true, lines.join('\n'));
  assert.equal(digest(report.result), digest(cleanResult));
  for (const metric of ['blocks', 'transactions', 'uniqueActiveAddresses', 'canonicalUsdcTransfers', 'canonicalUsdcMints', 'canonicalUsdcBurns']) {
    assert(lines.some((text) => text.startsWith(`${metric} `) && text.includes(' EXPECTED ') && text.includes(' ACTUAL ') && text.endsWith(' MATCH')), metric);
  }
  assert.equal(report.secondary.status, 'verified');
  assert.equal(report.secondary.checks.length, 9);
  assert.equal(report.resources.primary.returnedLogsByStream.usdc, expected.usdc);
  assert.equal(report.resources.primary.logCallsByStream.usdc, Math.ceil(expected.blockCount / DENSE_LOG_RANGE_BLOCKS));
  for (const field of ['rss', 'heapUsed', 'heapTotal', 'external', 'arrayBuffers']) {
    for (const phase of ['Before', 'PeakSampled', 'After']) assert(Number.isFinite(report.resources.primary[`${field}${phase}Mb`]), `${field}${phase}Mb`);
  }
  assert.equal(report.resources.registry.officialPools, 1);
  assert(lines.some((text) => text.startsWith('RECOMMENDED PRODUCTION NODE FLAGS --max-old-space-size=64 --max-semi-space-size=2')));
  assert(lines.some((text) => text.startsWith('UNISWAP V3 official:') && text.includes('foreign V3-signature emitters ignored: 1')));
});

await test('validator gate: any metric mismatch fails the run, with no tolerance', async () => {
  const { report, lines } = await validateOffline({ expectedValues: { ...syntheticTruth, transactions: syntheticTruth.transactions + 1 } });
  assert.equal(report.ok, false);
  assert(lines.some((text) => text.startsWith('transactions ') && text.endsWith(' MISMATCH')));
  assert(lines.at(-1).startsWith('RESULT FAIL'));
});

await test('validator gate: a log missing on the secondary is a located identity-set mismatch', async () => {
  let dropped = false;
  const secondary = chainOf({ faults: { logs: (filter, logs) => {
    if (dropped || filter.address?.[0] !== USDC_SYSTEM_EMITTER.toLowerCase() || !logs.length) return logs;
    dropped = true;
    return logs.slice(1);
  } } });
  const { report, lines } = await validateOffline({ secondaryFetch: secondary.fetchImpl });
  assert.equal(report.ok, false);
  assert.equal(report.secondary.status, 'mismatch');
  assert.deepEqual(report.secondary.checks.filter((check) => !check.match).map((check) => check.name), ['usdcLogCount', 'usdcLogIdentitySet']);
  assert(lines.some((text) => text.includes('first differing 500-block bucket')));
  assert(report.metrics.every((metric) => metric.match), 'the primary equivalence itself still matched');
});

await test('validator gate: a rate-limited secondary is NOT VERIFIED and fails the run, never a silent pass', async () => {
  const limited = async () => ({ status: 429, ok: false, text: async () => 'Too Many Requests' });
  const { report, lines } = await validateOffline({ secondaryFetch: limited });
  assert.equal(report.ok, false);
  assert.equal(report.secondary.status, 'not_verified');
  assert.equal(report.secondary.reason, 'rate_limited');
  assert.deepEqual({ httpStatus: report.secondary.diagnostics.httpStatus, detail: report.secondary.diagnostics.detail },
    { httpStatus: 429, detail: 'Too Many Requests' });
  assert(lines.some((text) => text.startsWith('SECONDARY NOT VERIFIED') && text.includes('"httpStatus":429')));
  assert(report.metrics.every((metric) => metric.match));
  // Not requested is reported as such; it is never shown as verified.
  const alone = await validateOffline({ secondaryFetch: null });
  assert.equal(alone.report.secondary.status, 'not_requested');
  assert.equal(alone.report.ok, true);
  assert(alone.lines.at(-1).includes('secondary not_requested'));
});

// SQLite store on built-in node:sqlite (Node 22.13+). Temporary files only, deleted at the end.
const sqlite = await import('node:sqlite').catch(() => null);
if (!sqlite) {
  assert.notEqual(process.env.COMPACT_REQUIRE_SQLITE, '1', `node:sqlite is required but unavailable on Node ${process.version}`);
  console.log(`DEFERRED sqlite store tests: node:sqlite is unavailable on Node ${process.version}; they run in the manual GitHub Actions validator (Node 24)`);
} else {
  const directory = await mkdtemp(join(process.env.COMPACT_SQLITE_DIR || tmpdir(), 'compact-sqlite-'));
  const open = (name = 'store.sqlite') => new sqlite.DatabaseSync(join(directory, name));
  const hours = [cleanResult];
  for (const offset of [1, 2]) {
    hours.push(await processHour({ provider: offlineProvider(chainOf().fetchImpl), hourStart: HOUR + offset * 3600, safeHead: ORIGIN.originNumber + 25_000,
      v3Registry: V3 }));
  }
  assert(hours.every((hour) => hour.complete));
  // The second hour again, with a removed canonical USDC log: the spine is complete, USDC is unavailable.
  const removedUsdc = await processHour({ provider: offlineProvider(chainOf({ faults: { logs: (filter, logs) => (filter.address?.[0]
    === USDC_SYSTEM_EMITTER.toLowerCase() && logs.length ? [{ ...logs[0], removed: true }, ...logs.slice(1)] : logs) } }).fetchImpl),
  hourStart: HOUR + 3600, safeHead: ORIGIN.originNumber + 25_000, v3Registry: V3 });
  assert(removedUsdc.families.usdc.status === 'unavailable' && removedUsdc.families.uniswapV4.status === 'available');
  const rows = (db) => db.prepare('SELECT hour_start, network_sha256 FROM compact_hours ORDER BY hour_start').all()
    .map((row) => `${row.hour_start}:${row.network_sha256}`);
  const tables = (db) => db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table', 'view') ORDER BY name").all().map((row) => row.name);
  const TABLES = ['compact_checkpoint', 'compact_dex_activity', 'compact_dex_fee_hours', 'compact_dex_volume_hours', 'compact_family_hours',
    'compact_hour_addresses', 'compact_hours', 'compact_intelligence_hours', 'compact_meta', 'compact_pool_fee_hours', 'compact_pool_hours', 'compact_pool_price_hours',
    'compact_pool_tvl_hours', 'compact_projection_hours', 'compact_registry', 'compact_registry_coverage', 'compact_token_dex_observations',
    'compact_token_discoveries', 'compact_token_metadata', 'compact_token_price_hours', 'compact_valuation_hours'];
  const metricsOf = (family, name) => Object.fromEntries(FAMILY_FIELDS[name].map((field) => [field, family[field]]));
  try {
    await test('sqlite: schema v2 is created with WAL, synchronous=NORMAL and busy_timeout=5000; reopening keeps it', async () => {
      const db = open();
      createCompactStore(db);
      assert.deepEqual(tables(db), TABLES);
      assert.equal(db.prepare('PRAGMA journal_mode').get().journal_mode, 'wal');
      assert.equal(db.prepare('PRAGMA synchronous').get().synchronous, 1, 'NORMAL');
      assert.equal(Object.values(db.prepare('PRAGMA busy_timeout').get())[0], 5000);
      db.close();
      const again = open();
      createCompactStore(again);
      assert.equal(again.prepare('SELECT value FROM compact_meta WHERE key = ?').get('schema_version').value, '2');
      again.close();
    });

    await test('sqlite: an incompatible Stage 1 (v1) database is refused before anything in the file changes', async () => {
      const path = join(directory, 'stage1.sqlite');
      const v1 = new sqlite.DatabaseSync(path);
      // The Stage 1 schema, as written by the v1 store, with one stored hour.
      v1.exec(`CREATE TABLE compact_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
        CREATE TABLE compact_hours (hour_start INTEGER PRIMARY KEY CHECK (hour_start % 3600 = 0), definition_version TEXT NOT NULL,
          first_block INTEGER NOT NULL, last_block INTEGER NOT NULL, first_hash TEXT NOT NULL, last_hash TEXT NOT NULL,
          block_count INTEGER NOT NULL CHECK (block_count = last_block - first_block + 1), transaction_count INTEGER NOT NULL,
          unique_active_addresses INTEGER NOT NULL, usdc_transfer_count INTEGER NOT NULL, usdc_mint_count INTEGER NOT NULL,
          usdc_burn_count INTEGER NOT NULL, result_json TEXT NOT NULL, result_sha256 TEXT NOT NULL) STRICT;
        CREATE TABLE compact_checkpoint (id INTEGER PRIMARY KEY CHECK (id = 1), hour_start INTEGER NOT NULL, last_block INTEGER NOT NULL,
          last_hash TEXT NOT NULL) STRICT;
        INSERT INTO compact_meta VALUES ('schema_version', '1');
        INSERT INTO compact_hours VALUES (${HOUR}, 'arc-compact-hour-v1', 10, 19, 'a', 'b', 10, 0, 0, 0, 0, 0, '{}', 'h');`);
      v1.close();
      const fingerprint = async () => createHash('sha256').update(await readFile(path)).digest('hex');
      const before = await fingerprint();
      const db = new sqlite.DatabaseSync(path);
      assert.throws(() => createCompactStore(db), (error) => error.code === 'schema_version_mismatch');
      assert.deepEqual(tables(db), ['compact_checkpoint', 'compact_hours', 'compact_meta'], 'no v2 table was created');
      assert.equal(db.prepare('PRAGMA journal_mode').get().journal_mode, 'delete', 'the journal mode was not switched to WAL');
      db.close();
      assert.equal(await fingerprint(), before, 'the file is byte-identical');
      assert(!(await readdir(directory)).some((name) => name.startsWith('stage1.sqlite-')), 'no WAL or shared-memory file appeared');
      const orphan = new sqlite.DatabaseSync(join(directory, 'orphan.sqlite'));
      orphan.exec('CREATE TABLE compact_hours (hour_start INTEGER PRIMARY KEY) STRICT');
      assert.throws(() => createCompactStore(orphan), (error) => error.code === 'schema_version_mismatch', 'compact tables without a version row');
      assert.deepEqual(tables(orphan), ['compact_hours']);
      orphan.close();
    });

    await test('sqlite: a new hour with another definition version or chain id is refused before anything is written', async () => {
      const db = open('identity.sqlite');
      const store = createCompactStore(db);
      assert.throws(() => store.commitHour({ ...hours[0], definitionVersion: 'arc-compact-hour-v1' }), (error) => error.code === 'definition_version_mismatch');
      assert.throws(() => store.commitHour({ ...hours[0], chainId: 1 }), (error) => error.code === 'chain_id_mismatch');
      const dataTables = TABLES.filter((table) => table !== 'compact_meta');
      assert.deepEqual(dataTables.map((table) => db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count), dataTables.map(() => 0));
      assert.equal(store.commitHour(hours[0]).outcome, 'inserted', 'the same hour with the expected identity is accepted');
      db.close();
    });

    await test('sqlite: the checkpoint advances only across hash-linked hours; a forged parent hash is refused', async () => {
      const db = open('continuity.sqlite');
      const store = createCompactStore(db);
      store.commitHour(hours[0]);
      assert.equal(hours[1].range.parentHash, hours[0].range.lastHash, 'genuine neighbours link by hash');
      const forged = { ...hours[1], range: { ...hours[1].range, parentHash: `0x${'ab'.repeat(32)}` } };
      assert.equal(forged.range.firstBlock, hours[0].range.lastBlock + 1, 'block numbers alone still look contiguous');
      assert.throws(() => store.commitHour(forged), (error) => error.code === 'checkpoint_discontinuity');
      assert.deepEqual([store.hourCount(), store.checkpoint().hourStart], [1, HOUR], 'the forged hour is not stored and the checkpoint stays');
      assert.equal(db.prepare('SELECT COUNT(*) AS count FROM compact_hour_addresses WHERE hour_start = ?').get(BigInt(HOUR + 3600)).count, 0);
      assert.equal(store.commitHour(hours[1]).checkpoint.hourStart, HOUR + 3600, 'the genuine hour still advances it');
      db.close();
    });

    await test('sqlite: forward only; a new hour ahead of the checkpoint is refused before any row is written', async () => {
      const db = open('forward.sqlite');
      const store = createCompactStore(db);
      const count = (table) => db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count;
      const state = () => ({ tables: TABLES.filter((table) => table !== 'compact_meta').map((table) => [table, count(table)]),
        families: db.prepare('SELECT hour_start, family, status, metrics_sha256 FROM compact_family_hours ORDER BY hour_start, family').all()
          .map((row) => `${row.hour_start}:${row.family}:${row.status}:${row.metrics_sha256}`),
        registry: store.v3Registry(), checkpoint: store.checkpoint() });
      store.extendRegistry(await bootstrapV3Registry(offlineProvider(chainOf().fetchImpl), { fromBlock: ORIGIN.originNumber, toBlock: hours[0].range.firstBlock - 1 }));
      assert.equal(store.commitHour(hours[0]).outcome, 'inserted', 'an empty database accepts its first hour at any hour start');
      const before = state();
      // H+2 straight after H, carrying an extra pool row as well: refused, and nothing at all is written.
      const extraPool = { ...hours[2].registry.uniswapV3, created: [...hours[2].registry.uniswapV3.created, { address: `0x${'ee'.repeat(20)}`,
        createdBlock: hours[2].range.firstBlock, createdLogIndex: 0, createdTx: `0x${'ee'.repeat(32)}`, token0: `0x${'01'.repeat(20)}`,
        token1: `0x${'02'.repeat(20)}`, fee: 3000, tickSpacing: 60 }] };
      for (const ahead of [hours[2], { ...hours[2], registry: { uniswapV3: extraPool } }]) {
        assert.throws(() => store.commitHour(ahead), (error) => error.code === 'checkpoint_gap');
      }
      assert.deepEqual(state(), before, 'no hour, family, address, registry, coverage or checkpoint change');
      assert.equal(count('compact_hour_addresses'), hours[0].network.uniqueActiveAddresses);
      // H+1 (here with canonical USDC unavailable) is the next canonical hour, then H+2 follows it.
      assert.deepEqual(store.commitHour(removedUsdc).checkpoint.hourStart, HOUR + 3600);
      assert.equal(store.commitHour(hours[2]).checkpoint.hourStart, HOUR + 7200);
      assert.equal(store.v3Registry().through, hours[2].range.lastBlock);
      // Existing hours still replay: unchanged, and an unavailable family upgrades when the network hash matches.
      assert.equal(store.commitHour(hours[0]).outcome, 'unchanged');
      assert.equal(store.commitHour(hours[1]).outcome, 'upgraded');
      assert.equal(store.familyRows(HOUR + 3600).find((row) => row.family === 'usdc').status, 'available');
      assert.deepEqual([store.hourCount(), store.checkpoint().hourStart], [3, HOUR + 7200]);
      db.close();
      // Once a checkpoint exists, a new hour behind it is refused too: the run only grows forward.
      const later = open('forward-behind.sqlite');
      const behind = createCompactStore(later);
      assert.equal(behind.commitHour(hours[1]).outcome, 'inserted');
      assert.throws(() => behind.commitHour(hours[0]), (error) => error.code === 'hour_before_checkpoint');
      assert.deepEqual([behind.hourCount(), behind.checkpoint().hourStart], [1, HOUR + 3600]);
      later.close();
    });

    await test('sqlite: hour row and checkpoint commit together; an injected failure before COMMIT advances neither', async () => {
      let db = open();
      let store = createCompactStore(db);
      assert.equal(store.commitHour(hours[0]).outcome, 'inserted');
      assert.deepEqual(store.checkpoint(), { hourStart: HOUR, lastBlock: hours[0].range.lastBlock, lastHash: hours[0].range.lastHash });
      assert.throws(() => store.commitHour(hours[1], { beforeCommit: () => { throw new Error('injected_failure'); } }), /injected_failure/);
      assert.equal(store.hourCount(), 1);
      assert.equal(store.checkpoint().hourStart, HOUR);
      db.close();
      db = open();
      store = createCompactStore(db);
      assert.equal(store.hourCount(), 1, 'state on disk after reopen');
      assert.equal(store.checkpoint().hourStart, HOUR);
      assert.throws(() => store.commitHour(hours[2]), (error) => error.code === 'checkpoint_gap', 'an hour ahead of the checkpoint is refused');
      assert.equal(store.commitHour(hours[1]).checkpoint.hourStart, HOUR + 3600, 'the next canonical hour moves the checkpoint');
      assert.equal(store.commitHour(hours[2]).checkpoint.hourStart, HOUR + 7200);
      db.close();
    });

    await test('sqlite: replaying completed hours is idempotent; a different result for a stored hour is refused', async () => {
      const db = open();
      const store = createCompactStore(db);
      const before = rows(db);
      for (const hour of hours) assert.equal(store.commitHour(hour).outcome, 'unchanged');
      const conflicting = { ...hours[0], network: { ...hours[0].network, transactionCount: hours[0].network.transactionCount + 1 } };
      assert.throws(() => store.commitHour(conflicting), (error) => error.code === 'hour_conflict');
      assert.deepEqual(rows(db), before);
      assert.equal(store.checkpoint().hourStart, HOUR + 7200);
      db.close();
    });

    // Stage 2a: an unavailable family no longer blocks an hour (next test); everything below is still refused.
    await test('sqlite: an incomplete spine or an inconsistent hour can never be committed', async () => {
      const db = open('refusals.sqlite');
      const store = createCompactStore(db);
      const unavailableUsdc = { status: 'unavailable', reason: 'removed_log', ...Object.fromEntries(FAMILY_FIELDS.usdc.map((field) => [field, null])) };
      for (const [result, code] of [
        [microResult, 'hour_not_complete'],
        [{ ...hours[0], network: { ...hours[0].network, blockCount: hours[0].network.blockCount - 1 } }, 'hour_not_complete'],
        [{ ...hours[0], activeAddresses: hours[0].activeAddresses.slice(1) }, 'hour_not_complete'],
        [{ ...hours[0], families: { ...hours[0].families, usdc: unavailableUsdc } }, 'hour_inconsistent'],
        [{ ...hours[0], complete: false, families: { ...hours[0].families, usdc: { ...unavailableUsdc, transferCount: 0 } } }, 'hour_inconsistent'],
        [{ ...hours[0], registry: { uniswapV3: null } }, 'hour_inconsistent'],
      ]) assert.throws(() => store.commitHour(result), (error) => error.code === code, code);
      assert.equal(store.hourCount(), 0);
      assert.equal(store.checkpoint(), null);
      assert.throws(() => db.prepare("INSERT INTO compact_hours VALUES (?, 'x', 10, 20, 'p', 'a', 'b', 5, 0, 0, '{}', 'h')").run(BigInt(HOUR)),
        /CHECK constraint/i);
      store.commitHour(hours[0]);
      assert.throws(() => db.prepare("INSERT INTO compact_family_hours VALUES (?, 'zero', 'unavailable', 'x', '{\"count\":0}', NULL)").run(BigInt(HOUR)),
        /CHECK constraint/i, 'an unavailable family row can never hold metrics');
      const { range, registry } = hours[1];
      const shifted = { ...hours[1], range: { ...range, firstBlock: range.firstBlock + 1, lastBlock: range.lastBlock + 1 },
        registry: { uniswapV3: { ...registry.uniswapV3, through: range.lastBlock + 1 } } };
      assert.throws(() => store.commitHour(shifted), (error) => error.code === 'checkpoint_discontinuity');
      assert.equal(store.hourCount(), 1);
      db.close();
    });

    await test('sqlite: a spine-complete hour commits with a family unavailable; the family stays null and the checkpoint advances', async () => {
      const db = open('families.sqlite');
      const store = createCompactStore(db);
      store.commitHour(hours[0]);
      const { outcome, checkpoint } = store.commitHour(removedUsdc);
      assert.equal(outcome, 'inserted');
      assert.equal(checkpoint.hourStart, HOUR + 3600, 'a valid spine hour moves the checkpoint even with a family unavailable');
      const families = Object.fromEntries(store.familyRows(HOUR + 3600).map((row) => [row.family, row]));
      assert.deepEqual(families.usdc, { family: 'usdc', status: 'unavailable', reason: 'removed_log', metrics: null });
      for (const name of ['assets', 'uniswapV3', 'uniswapV4']) assert.deepEqual(families[name].metrics, metricsOf(hours[1].families[name], name));
      assert.equal(store.uniqueActiveAddresses(HOUR + 3600, 1), hours[1].network.uniqueActiveAddresses);
      assert.equal(store.commitHour(hours[2]).checkpoint.hourStart, HOUR + 7200);
      db.close();
    });

    await test('sqlite: unavailable -> available replay upgrades a family only when the network hash matches', async () => {
      const db = open('families.sqlite');
      const store = createCompactStore(db);
      const usdcRow = () => store.familyRows(HOUR + 3600).find((row) => row.family === 'usdc');
      assert.throws(() => store.commitHour({ ...hours[1], network: { ...hours[1].network, gasUsedRaw: '1' } }), (error) => error.code === 'hour_conflict');
      assert.equal(usdcRow().status, 'unavailable', 'a different network never upgrades anything');
      assert.equal(store.commitHour(hours[1]).outcome, 'upgraded');
      assert.deepEqual(usdcRow().metrics, metricsOf(hours[1].families.usdc, 'usdc'));
      assert.equal(store.commitHour(hours[1]).outcome, 'unchanged');
      assert.equal(store.commitHour(removedUsdc).outcome, 'unchanged', 'an available family is never downgraded');
      assert.equal(usdcRow().status, 'available');
      const changed = { ...hours[1], families: { ...hours[1].families, usdc: { ...hours[1].families.usdc, transferCount: hours[1].families.usdc.transferCount + 1 } } };
      assert.throws(() => store.commitHour(changed), (error) => error.code === 'hour_conflict');
      assert.deepEqual([store.hourCount(), store.checkpoint().hourStart], [3, HOUR + 7200]);
      db.close();
    });

    await test('sqlite: registry coverage is explicit and contiguous; hour commits extend it; pools are written once', async () => {
      const db = open('registry.sqlite');
      const store = createCompactStore(db);
      assert.equal(store.v3Registry(), null);
      const provider = offlineProvider(chainOf().fetchImpl);
      const early = await bootstrapV3Registry(provider, { fromBlock: ORIGIN.originNumber, toBlock: expectedFirst - 1001 });
      const late = await catchUpV3Registry(provider, registrySnapshot(early), expectedFirst - 1);
      assert.throws(() => store.extendRegistry(late), (error) => error.code === 'registry_discontinuity', 'a catch-up needs its bootstrap first');
      store.extendRegistry(early);
      store.extendRegistry(late);
      assert.throws(() => store.extendRegistry(early), (error) => error.code === 'registry_discontinuity', 'coverage never restarts');
      const stored = store.v3Registry();
      assert.deepEqual([stored.fromBlock, stored.through, stored.pools.size], [ORIGIN.originNumber, expectedFirst - 1, 0]);
      const hour = await processHour({ provider, hourStart: HOUR, safeHead: SAFE_HEAD, v3Registry: stored });
      assert.deepEqual(hour, cleanResult);
      store.commitHour(hour);
      const extended = store.v3Registry();
      assert.deepEqual([extended.through, extended.throughHash, [...extended.pools]], [expectedLast, hour.range.lastHash, [SYNTHETIC_CONTRACTS.validV3Pool]]);
      assert.equal(store.commitHour(hour).outcome, 'unchanged');
      assert.equal(db.prepare("SELECT COUNT(*) AS count FROM compact_registry WHERE kind = 'uniswap_v3_pool'").get().count, 1);
      const next = await processHour({ provider, hourStart: HOUR + 3600, safeHead: ORIGIN.originNumber + 25_000, v3Registry: store.v3Registry() });
      assert.equal(digest(next), digest(hours[1]), 'the next hour runs from the stored registry, with no scan');
      store.commitHour(next);
      assert.equal(store.v3Registry().through, next.range.lastBlock);
      db.close();
    });

    await test('sqlite: rolling 24H unique active addresses are exact; only 1H, 6H and 24H exist; nothing older is kept', async () => {
      // One block per minute keeps 25 consecutive hours small.
      const slowOrigin = { originNumber: ORIGIN.originNumber, originTimestamp: HOUR - 120, blockSpacing: 600_000 };
      const slow = createSyntheticChain({ ...slowOrigin, senderPool: 900, recipientPool: 600 });
      const slowHead = slowOrigin.originNumber + 1_600;
      const provider = offlineProvider(slow.fetchImpl);
      const registry = registrySnapshot(await bootstrapV3Registry(provider, { fromBlock: slowOrigin.originNumber, toBlock: slowHead }));
      const identities = Array.from({ length: 25 }, () => new Set());
      for (let number = slowOrigin.originNumber; number <= slowHead; number++) {
        const index = Math.floor((slow.timestampOf(number) - HOUR) / 3600);
        if (index < 0 || index >= 25) continue;
        for (const tx of slow.transactionsOf(number)) { identities[index].add(tx.from); if (tx.to) identities[index].add(tx.to); }
      }
      const union = (from, to) => new Set(identities.slice(from, to + 1).flatMap((set) => [...set])).size;
      const db = open('windows.sqlite');
      const store = createCompactStore(db);
      for (let index = 0; index < 25; index++) {
        const hourStart = HOUR + index * 3600;
        assert.equal(store.commitHour(await processHour({ provider, hourStart, safeHead: slowHead, v3Registry: registry })).outcome, 'inserted');
        if (index === 2) assert.equal(store.uniqueActiveAddresses(hourStart, 6), null, 'a window with missing hours is unavailable, never partial');
      }
      const last = HOUR + 24 * 3600;
      assert.equal(store.uniqueActiveAddresses(last, 1), identities[24].size);
      assert.equal(store.uniqueActiveAddresses(last, 6), union(19, 24));
      assert.equal(store.uniqueActiveAddresses(last, 24), union(1, 24));
      assert(union(1, 24) < identities.slice(1).reduce((sum, set) => sum + set.size, 0), 'the 24H union is not a sum of hourly counts');
      assert.equal(store.uniqueActiveAddresses(last - 3600, 24), null, 'its first hour is past the 24-hour identity horizon');
      assert.equal(store.uniqueActiveAddresses(last - 3600, 6), union(18, 23));
      assert.equal(store.uniqueActiveAddresses(HOUR, 1), identities[0].size, '1H stays exact from the hour row');
      for (const span of [2, 168, 720]) assert.throws(() => store.uniqueActiveAddresses(last, span), (error) => error.code === 'unsupported_window');
      const kept = db.prepare('SELECT COUNT(DISTINCT hour_start) AS hours, MIN(hour_start) AS first FROM compact_hour_addresses').get();
      assert.deepEqual([kept.hours, kept.first], [ADDRESS_WINDOW_HOURS, last - 23 * 3600]);
      assert.deepEqual(tables(db), TABLES, 'no daily, weekly or monthly address storage');
      db.close();
    });

    await test('sqlite: the compact database holds aggregates only, no raw block, transaction, receipt or log archive', async () => {
      const db = open();
      assert.deepEqual(tables(db), TABLES);
      const hourText = db.prepare('SELECT parent_hash || first_hash || last_hash || network_json AS text FROM compact_hours').all()
        .map((row) => row.text).join('');
      assert.equal(hourText.match(/0x[0-9a-f]{64}/g).length, hours.length * 3, 'only boundary block hashes; no transaction or log hashes');
      const familyText = db.prepare("SELECT COALESCE(metrics_json, '') AS text FROM compact_family_hours").all().map((row) => row.text).join('');
      // The only 32-byte values in family rows are Morpho market ids (a market key, not a transaction or log hash).
      assert((familyText.match(/0x[0-9a-f]{64}/g) ?? []).every((value) => value in SYNTHETIC_PROTOCOL.morphoMarkets));
      assert(db.prepare('SELECT MAX(LENGTH(metrics_json)) AS size FROM compact_family_hours').get().size < 4096);
      assert(db.prepare('SELECT MAX(LENGTH(network_json)) AS size FROM compact_hours').get().size < 1024);
      assert.equal(db.prepare("SELECT COUNT(*) AS count FROM compact_registry WHERE kind = 'uniswap_v3_pool'").get().count, 1,
        'one official V3 pool, written once');
      assert.equal(db.prepare('SELECT COUNT(*) AS count FROM compact_hour_addresses').get().count,
        hours.reduce((sum, hour) => sum + hour.network.uniqueActiveAddresses, 0), 'one 20-byte identity per active address per hour');
      db.close();
      const { size } = await stat(join(directory, 'store.sqlite'));
      // Additive Intelligence tables/indexes add bounded SQLite page overhead without storing raw chain data.
      const additiveSchemaAllowanceBytes = 64 * 1024;
      assert(size < 2 * 1024 * 1024 + additiveSchemaAllowanceBytes, `database is ${size} bytes for ${hours.length} hours`);
    });

    await test('validator gate: a verified hour round-trips through a temporary node:sqlite file that is then deleted', async () => {
      const { report } = await validateOffline({ sqliteDirectory: directory });
      assert.equal(report.ok, true);
      assert.deepEqual({ status: report.sqlite.status, first: report.sqlite.first, replay: report.sqlite.replay },
        { status: 'verified', first: 'inserted', replay: 'unchanged' });
      assert(!(await readdir(directory)).some((name) => name.startsWith('compact-validation-')));
    });

    // Stage 2b one-shot runner on persistent files: registry warm start, forward-only hours, fail-closed errors.
    // Every official-factory eth_getLogs range is recorded, so a historical registry scan cannot go unnoticed.
    const runner = async (name, { hourStart = HOUR, fetchImpl = chainOf().fetchImpl, registryFromBlock = ORIGIN.originNumber } = {}) => {
      const factoryScans = [];
      const provider = offlineProvider(async (url, init) => {
        for (const item of [].concat(JSON.parse(init.body))) {
          const filter = item.method === 'eth_getLogs' ? item.params[0] : null;
          if (filter?.address?.[0] === UNISWAP_REGISTRY.v3Factory.address) factoryScans.push([Number(BigInt(filter.fromBlock)), Number(BigInt(filter.toBlock))]);
        }
        return fetchImpl(url, init);
      });
      const lines = [];
      const summary = await runCompactHour({ sqlitePath: join(directory, name), hourStart, provider, registryFromBlock, print: (text) => lines.push(text) });
      return { summary, lines, factoryScans, provider };
    };
    const lineOf = (lines, key) => lines.find((text) => text.startsWith(`${key} `));
    const historyScans = (scans, beforeBlock) => scans.filter(([from]) => from < beforeBlock);
    const assertStoredHourDiscoveryOnly = ({ summary, factoryScans, provider }, label) => {
      assert.equal(summary.hourOutcome, 'already_committed', `${label}: stored hour`);
      assert.equal(summary.discovery?.status, 'available', `${label}: discovery result`);
      assert.equal(factoryScans.length, 0, `${label}: no registry scan`);
      const allowed = new Set(['eth_chainId', 'eth_getTransactionReceipt', 'eth_getCode', 'eth_call']);
      assert(Object.keys(provider.stats.calls).every((method) => allowed.has(method)), `${label}: targeted RPC only`);
      assert.equal(provider.stats.calls.eth_getLogs ?? 0, 0, `${label}: no log range replay`);
      assert.equal(provider.stats.calls.eth_getBlockByNumber ?? 0, 0, `${label}: no block range replay`);
      assert(provider.stats.requests <= DISCOVERY_READS_PER_RUN * 2 + 1, `${label}: bounded discovery RPC requests`);
    };

    await test('runner: an empty database bootstraps the registry once, only up to the block before the hour, then commits it', async () => {
      const { summary, lines, factoryScans, provider } = await runner('runner.sqlite');
      assert.deepEqual([summary.registryMode, summary.registryBefore, summary.hourOutcome, summary.ok], ['bootstrap', 'none', 'inserted', true]);
      const history = historyScans(factoryScans, expectedFirst);
      assert.deepEqual([Math.min(...history.map(([from]) => from)), Math.max(...history.map(([, to]) => to))], [ORIGIN.originNumber, expectedFirst - 1],
        'from the factory deployment to the block before the hour, not to the safe head');
      assert.equal(summary.registryAfter, `${ORIGIN.originNumber}-${expectedLast}`, 'the committed hour extends coverage through itself');
      assert.equal(summary.officialV3Pools, 1);
      assert.deepEqual(summary.families, Object.fromEntries(FAMILY_NAMES.map((name) => [name, 'available'])));
      assert.deepEqual([summary.checkpoint.hour, summary.checkpoint.lastBlock], [new Date(HOUR * 1000).toISOString(), expectedLast]);
      assert(provider.stats.requests > 0 && summary.sqliteBytes.db > 0);
      for (const key of ['TARGET_HOUR', 'SQLITE_PATH', 'REGISTRY_MODE', 'REGISTRY_COVERAGE', 'V3_OFFICIAL_POOLS', 'HOUR_OUTCOME', 'FAMILIES',
        'CHECKPOINT', 'PROVIDER', 'ELAPSED_MS', 'SQLITE_BYTES', 'COMPACT_RUN_SUMMARY']) assert(lineOf(lines, key), key);
      assert.equal(lines.at(-1), 'RESULT PASS');
      const db = open('runner.sqlite');
      const store = createCompactStore(db);
      assert.deepEqual(store.familyRows(HOUR).map((row) => row.metrics), [...FAMILY_NAMES].sort()
        .map((name) => metricsOf(cleanResult.families[name], name)), 'the runner stores exactly what the engine computes');
      db.close();
    });

    await test('runner: a second invocation reuses the registry and only performs bounded discovery enrichment for a stored hour', async () => {
      const second = await runner('runner.sqlite');
      const { summary, lines } = second;
      assert.deepEqual([summary.registryMode, summary.ok], ['reused', true]);
      assertStoredHourDiscoveryOnly(second, 'second invocation');
      assert.equal(summary.discovery?.candidates, DISCOVERY_READS_PER_RUN, 'discovery stays capped');
      assert.equal(summary.registryAfter, summary.registryBefore);
      assert.equal(lines.at(-1), 'RESULT PASS');
      // Do not spawn the real CLI here: stored-hour discovery may use bounded RPC.
      // The injected offline provider above is the deterministic contract test.
    });

    await test('runner: the next hour runs on the stored registry with no historical scan', async () => {
      const { summary, factoryScans } = await runner('runner.sqlite', { hourStart: HOUR + 3600 });
      assert.deepEqual([summary.registryMode, summary.hourOutcome, summary.ok], ['reused', 'inserted', true]);
      assert.deepEqual(historyScans(factoryScans, hours[1].range.firstBlock), [], 'only the hour\'s own PoolCreated stream is read');
      assert.equal(summary.registryAfter, `${ORIGIN.originNumber}-${hours[1].range.lastBlock}`);
      const earlier = await runner('runner.sqlite');
      assert.equal(earlier.summary.registryMode, 'reused');
      assertStoredHourDiscoveryOnly(earlier, 'stored earlier hour');
    });

    await test('runner: coverage behind the hour catches up only the blocks after it', async () => {
      const partial = expectedFirst - 1500;
      const db = open('catchup.sqlite');
      createCompactStore(db).extendRegistry(await bootstrapV3Registry(offlineProvider(chainOf().fetchImpl), { fromBlock: ORIGIN.originNumber, toBlock: partial }));
      db.close();
      const { summary, factoryScans } = await runner('catchup.sqlite');
      assert.deepEqual([summary.registryMode, summary.registryBefore, summary.hourOutcome, summary.ok], ['catchup', `${ORIGIN.originNumber}-${partial}`, 'inserted', true]);
      const history = historyScans(factoryScans, expectedFirst);
      assert.deepEqual([Math.min(...history.map(([from]) => from)), Math.max(...history.map(([, to]) => to))], [partial + 1, expectedFirst - 1]);
    });

    await test('runner: forward only; a gap or an earlier unstored hour is refused before any request or write', async () => {
      for (const [hourStart, code] of [[HOUR + 3 * 3600, 'checkpoint_gap'], [HOUR - 3600, 'hour_before_checkpoint']]) {
        const { summary, lines, provider } = await runner('runner.sqlite', { hourStart });
        assert.deepEqual([summary.ok, summary.reason, summary.hourOutcome, provider.stats.requests], [false, code, null, 0]);
        assert.equal(lines.at(-1), `RESULT FAIL ${code}`);
      }
      const db = open('runner.sqlite');
      const store = createCompactStore(db);
      assert.deepEqual([store.hourCount(), store.checkpoint().hourStart], [2, HOUR + 3600]);
      db.close();
    });

    await test('runner: configuration refuses RPC pacing below 500 ms, a missing or in-memory database and a non-hour target', async () => {
      const config = (env, argv = ['2026-10-01T07:00:00Z']) => runnerConfig({ argv, env });
      assert.deepEqual(config({ COMPACT_SQLITE_PATH: '/data/arc-compact.sqlite' }),
        { hourStart: 1_790_838_000, sqlitePath: '/data/arc-compact.sqlite', minIntervalMs: 1000 });
      assert.equal(config({ COMPACT_SQLITE_PATH: '/data/a.sqlite', COMPACT_RPC_MIN_INTERVAL_MS: '500' }).minIntervalMs, 500);
      for (const pacing of ['499', '250', '0', '-1', '1e3', 'fast', '']) {
        assert.throws(() => config({ COMPACT_SQLITE_PATH: '/data/a.sqlite', COMPACT_RPC_MIN_INTERVAL_MS: pacing }), (error) => error.code === 'unsafe_rpc_pacing', pacing);
      }
      for (const path of [undefined, '', '  ', ':memory:', 'file::memory:']) {
        assert.throws(() => config({ COMPACT_SQLITE_PATH: path }), (error) => error.code === 'sqlite_path_required', String(path));
      }
      for (const argv of [[], ['2026-10-01T07:30:00Z'], ['yesterday']]) {
        assert.throws(() => config({ COMPACT_SQLITE_PATH: '/data/a.sqlite' }, argv), (error) => error.code === 'invalid_hour', String(argv));
      }
      const cli = spawnSync(process.execPath, [fileURLToPath(new URL('./run-compact-hour.mjs', import.meta.url)), '2026-10-01T07:00:00Z'],
        { env: { ...process.env, COMPACT_SQLITE_PATH: join(directory, 'never.sqlite'), COMPACT_RPC_MIN_INTERVAL_MS: '250' }, encoding: 'utf8' });
      assert.deepEqual([cli.status, cli.stdout.trim()], [1, 'RESULT FAIL unsafe_rpc_pacing']);
      assert(!(await readdir(directory)).includes('never.sqlite'), 'refused before the database file is created');
    });

    await test('runner: registry and store errors fail closed and leave nothing half written', async () => {
      const factoryDown = chainOf({ faults: { request: (body) => (!Array.isArray(body) && body.method === 'eth_getLogs'
        && body.params[0].address?.[0] === UNISWAP_REGISTRY.v3Factory.address
        ? { jsonrpc: '2.0', id: 1, error: { code: -32000, message: 'header not found' } } : undefined) } });
      const broken = await runner('broken.sqlite', { fetchImpl: factoryDown.fetchImpl });
      assert.deepEqual([broken.summary.ok, broken.summary.reason, broken.summary.registryMode, broken.summary.hourOutcome],
        [false, 'rpc_error', 'bootstrap', null]);
      assert.equal(broken.summary.diagnostics.detail, 'header not found');
      const late = await runner('late.sqlite', { registryFromBlock: ORIGIN.originNumber + 1 });
      assert.deepEqual([late.summary.ok, late.summary.reason], [false, 'registry_start_after_factory_deployment']);
      for (const name of ['broken.sqlite', 'late.sqlite']) {
        const db = open(name);
        const store = createCompactStore(db);
        assert.deepEqual([store.v3Registry(), store.hourCount(), store.checkpoint()], [null, 0, null], name);
        db.close();
      }
      const stage1Path = join(directory, 'runner-stage1.sqlite');
      const stage1Db = new sqlite.DatabaseSync(stage1Path);
      stage1Db.exec(`CREATE TABLE compact_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
        INSERT INTO compact_meta VALUES ('schema_version', '1');`);
      stage1Db.close();
      const stage1 = await runner('runner-stage1.sqlite');
      assert.deepEqual([stage1.summary.ok, stage1.summary.reason, stage1.provider.stats.requests], [false, 'schema_version_mismatch', 0]);
    });

    await test('runner: an unavailable family is committed as null, reported unavailable and never as zero', async () => {
      const v4Down = chainOf({ faults: { request: (body) => (!Array.isArray(body) && body.method === 'eth_getLogs'
        && body.params[0].address?.[0] === UNISWAP_REGISTRY.v4PoolManager.address
        ? { jsonrpc: '2.0', id: 1, error: { code: -32000, message: 'header not found' } } : undefined) } });
      const { summary, lines } = await runner('partial.sqlite', { fetchImpl: v4Down.fetchImpl });
      assert.deepEqual([summary.hourOutcome, summary.ok, summary.reason, summary.families.uniswapV4],
        ['inserted', false, 'families_unavailable:uniswapV4', 'unavailable(rpc_error)']);
      assert(lineOf(lines, 'FAMILIES').includes('uniswapV4=unavailable(rpc_error)'));
      assert.equal(lines.at(-1), 'RESULT FAIL families_unavailable:uniswapV4');
      const db = open('partial.sqlite');
      assert.deepEqual(createCompactStore(db).familyRows(HOUR).find((row) => row.family === 'uniswapV4'),
        { family: 'uniswapV4', status: 'unavailable', reason: 'rpc_error', metrics: null });
      db.close();
    });

    // Repair: a stored hour with an unavailable family is never treated as finished.
    const v4DownChain = (options = {}) => chainOf({ ...options, faults: { ...options.faults, request: (body) => (!Array.isArray(body)
      && body.method === 'eth_getLogs' && body.params[0].address?.[0] === UNISWAP_REGISTRY.v4PoolManager.address
      ? { jsonrpc: '2.0', id: 1, error: { code: -32000, message: 'header not found' } } : undefined) } });
    const storedRows = (name, hourStart = HOUR) => {
      const db = open(name);
      const store = createCompactStore(db);
      const state = { families: Object.fromEntries(store.familyRows(hourStart).map((row) => [row.family, row])), hours: store.hourCount(),
        checkpoint: store.checkpoint(), registry: store.v3Registry() };
      db.close();
      return state;
    };

    await test('runner: a stored hour with an unavailable family is reprocessed and upgraded on the stored registry, with no scan', async () => {
      const before = storedRows('partial.sqlite');
      assert.equal(before.families.uniswapV4.status, 'unavailable');
      const { summary, lines, factoryScans, provider } = await runner('partial.sqlite');
      assert.deepEqual([summary.hourMode, summary.repairFamilies, summary.registryMode, summary.hourOutcome, summary.ok],
        ['repair', ['uniswapV4'], 'reused', 'upgraded', true]);
      assert(provider.stats.requests > 0, 'the hour is reprocessed');
      assert.deepEqual(historyScans(factoryScans, expectedFirst), [], 'no historical V3 registry scan during a repair');
      assert.equal(lineOf(lines, 'HOUR_MODE'), 'HOUR_MODE repair repair_families=uniswapV4');
      assert.equal(lines.at(-1), 'RESULT PASS');
      const after = storedRows('partial.sqlite');
      assert.deepEqual(after.families.uniswapV4.metrics, metricsOf(cleanResult.families.uniswapV4, 'uniswapV4'), 'upgraded to the verified value');
      for (const name of ['usdc', 'assets', 'uniswapV3']) assert.deepEqual(after.families[name], before.families[name], `${name} is untouched`);
      assert.deepEqual([after.hours, after.checkpoint, after.registry.through], [before.hours, before.checkpoint, before.registry.through]);
      const settled = await runner('partial.sqlite');
      assert.deepEqual([settled.summary.hourMode, settled.summary.ok], ['stored', true],
        'once every family is available the hour stays in stored mode');
      assertStoredHourDiscoveryOnly(settled, 'settled repaired hour');
    });

    await test('runner: a repair that still cannot verify a family keeps it unavailable; available families never change', async () => {
      const first = await runner('repair.sqlite', { fetchImpl: v4DownChain().fetchImpl });
      assert.deepEqual([first.summary.hourOutcome, first.summary.ok], ['inserted', false]);
      const original = storedRows('repair.sqlite');
      // V4 still down, and USDC now fails on replay: V4 stays unavailable, the stored available USDC is kept as it was.
      const usdcRemoved = v4DownChain({ faults: { logs: (filter, logs) => (filter.address?.[0] === USDC_SYSTEM_EMITTER.toLowerCase() && logs.length
        ? [{ ...logs[0], removed: true }, ...logs.slice(1)] : logs) } });
      const still = await runner('repair.sqlite', { fetchImpl: usdcRemoved.fetchImpl });
      assert.deepEqual([still.summary.hourMode, still.summary.hourOutcome, still.summary.ok, still.summary.reason],
        ['repair', 'unchanged', false, 'families_unavailable:uniswapV4']);
      assert.deepEqual([still.summary.families.uniswapV4, still.summary.families.usdc], ['unavailable(rpc_error)', 'available']);
      assert.deepEqual(storedRows('repair.sqlite'), original, 'nothing stored changed');
      // A replay that computes a different value for an already-available family is refused as a whole.
      const usdcChanged = chainOf({ faults: { logs: (filter, logs) => (filter.address?.[0] === USDC_SYSTEM_EMITTER.toLowerCase() && logs.length
        ? [{ ...logs[0], data: `0x${(BigInt(logs[0].data) + 1n).toString(16).padStart(64, '0')}` }, ...logs.slice(1)] : logs) } });
      const conflict = await runner('repair.sqlite', { fetchImpl: usdcChanged.fetchImpl });
      assert.deepEqual([conflict.summary.hourMode, conflict.summary.ok, conflict.summary.reason], ['repair', false, 'hour_conflict']);
      assert.deepEqual(storedRows('repair.sqlite'), original, 'the V4 upgrade in that replay was rolled back with it');
      // After the next hour moved the checkpoint on, repairing the earlier hour upgrades it and leaves the checkpoint ahead.
      const next = await runner('repair.sqlite', { hourStart: HOUR + 3600 });
      assert.deepEqual([next.summary.hourMode, next.summary.hourOutcome, next.summary.ok], ['new', 'inserted', true]);
      const repaired = await runner('repair.sqlite');
      assert.deepEqual([repaired.summary.hourMode, repaired.summary.hourOutcome, repaired.summary.ok], ['repair', 'upgraded', true]);
      for (const run of [still, conflict, repaired]) assert.deepEqual(historyScans(run.factoryScans, expectedFirst), [], 'no registry rescan');
      const final = storedRows('repair.sqlite');
      assert.deepEqual([final.hours, final.checkpoint.hourStart], [2, HOUR + 3600], 'the checkpoint never moves back');
      assert.deepEqual(final.families.usdc, original.families.usdc, 'the first stored USDC value is immutable');
      assert.equal(final.families.uniswapV4.status, 'available');
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

// 13. Replay idempotence
await test('replay idempotence: same hour, any window size or safe head, byte-identical result', async () => {
  const runs = [
    await processHour({ provider: offlineProvider(clean.fetchImpl), hourStart: HOUR, safeHead: SAFE_HEAD, v3Registry: V3 }),
    await processHour({ provider: offlineProvider(chainOf().fetchImpl), hourStart: HOUR, safeHead: SAFE_HEAD + 3000, windowBlocks: 500, v3Registry: V3 }),
    await processHour({ provider: offlineProvider(chainOf().fetchImpl), hourStart: HOUR, safeHead: SAFE_HEAD + 40_000, windowBlocks: 2000, v3Registry: V3 }),
  ];
  for (const run of runs) assert.equal(digest(run), digest(cleanResult));
  assert.equal(digest((await runMicro()).result), digest(microResult));
});

// Stage 2a: there is no fallback endpoint any more. A wrong chain or a dead primary yields no result, with diagnostics.
await test('provider: wrong chain fails closed; a dead primary yields no result and never fails over', async () => {
  const chain = chainOf();
  const urls = new Set();
  const wrongChain = async (url) => { urls.add(url); return { status: 200, ok: true, text: async () => JSON.stringify({ jsonrpc: '2.0', id: 1, result: '0x1' }) }; };
  const provider = offlineProvider(wrongChain);
  const mismatch = await rejectsWith(provider.request('eth_chainId'), 'chain_mismatch');
  assert.equal(mismatch.detail, '0x1');
  assert.equal(provider.stats.requests, 1, 'a wrong chain is never retried');
  const dead = async (url) => { urls.add(url); return { status: 503, ok: false, text: async () => '<html>upstream\n unavailable</html>' }; };
  const primary = offlineProvider(dead);
  const error = await rejectsWith(processHour({ provider: primary, hourStart: HOUR, safeHead: SAFE_HEAD, v3Registry: V3 }), 'transport');
  assert(error instanceof HourIncompleteError);
  assert.equal(primary.stats.requests, 3, 'three attempts on the primary, then nothing');
  const direct = await rejectsWith(offlineProvider(dead).request('eth_blockNumber'), 'transport');
  assert.deepEqual([direct.httpStatus, direct.detail, direct.endpoint], [503, '<html>upstream unavailable</html>', 'circle']);
  assert.deepEqual([...urls], [ARC_PRIMARY_ENDPOINT.url], 'the default provider only ever talks to the primary Arc RPC');
  const thrown = await rejectsWith(offlineProvider(async () => { throw new TypeError('fetch failed', { cause: { code: 'ECONNRESET' } }); })
    .request('eth_blockNumber'), 'transport');
  assert.equal(thrown.detail, 'TypeError: fetch failed: ECONNRESET');
  assert.equal((await offlineProvider(chain.fetchImpl).request('eth_chainId')), hex(5042));
});

console.log('COMPACT_REAL_MICRO_WINDOW', JSON.stringify({ range: microResult.range, network: microResult.network, families: microResult.families,
  requests: microProvider.stats.requests, responseBytes: microProvider.stats.responseBytes, sha256: digest(microResult) }));
console.log('COMPACT_SYNTHETIC_HOUR', JSON.stringify({ range: cleanResult.range, network: cleanResult.network, usdc: cleanResult.families.usdc,
  uniswapV4: cleanResult.families.uniswapV4, sha256: digest(cleanResult) }));
console.log(`ARC_INTELLIGENCE_COMPACT: PASS (${passed} deterministic scenarios on Node ${process.version}; offline only, no network or server; `
  + `node:sqlite ${sqlite ? 'tested' : 'deferred'})`);
