// Compact source-first engine: deterministic historical hour processor and its SQLite store. Offline only: recorded
// Arc mainnet fixtures plus a deterministic synthetic chain. No network, no server.
// node:sqlite tests run when the runtime has it (Node 22.13+); COMPACT_REQUIRE_SQLITE=1 turns its absence into a failure.
// COMPACT_SQLITE_DIR (optional) is where the temporary database directory is created; it is deleted afterwards.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { USDC_ERC20_ADDRESS, USDC_SYSTEM_EMITTER } from '../api/_lib/arc-intelligence/usdc.js';
import { UNISWAP_EVENT_TOPICS, UNISWAP_REGISTRY } from '../api/_lib/arc-intelligence/uniswap.js';
import { locateHourBlocks } from '../server/compact/boundary.js';
import { FAMILY_FIELDS } from '../server/compact/families.js';
import { HourIncompleteError, processBlockRange, processHour } from '../server/compact/hour.js';
import { createRecordedFetch, createSyntheticChain, SYNTHETIC_CONTRACTS } from '../server/compact/offline.js';
import { createProvider, ProviderError } from '../server/compact/provider.js';
import { DENSE_LOG_RANGE_BLOCKS, LOG_STREAMS } from '../server/compact/sources.js';
import { headerOf } from '../server/compact/spine.js';
import { createCompactStore } from '../server/compact/store.js';
import { validateHour } from './validate-compact-hour.mjs';

const capture = JSON.parse(await readFile(new URL('./fixtures/compact-arc-capture-2026-10-01.json', import.meta.url), 'utf8'));
const truth = JSON.parse(await readFile(new URL('./fixtures/compact-a2-ground-truth.json', import.meta.url), 'utf8'));
const hex = (number) => `0x${number.toString(16)}`;
const ZERO_TOPIC = `0x${'0'.repeat(64)}`;
const digest = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
let passed = 0;
async function test(name, run) { await run(); passed += 1; console.log(`PASS ${name}`); }

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
const chainOf = (options = {}) => createSyntheticChain({ ...ORIGIN, poolCreatedAt: 23_002_500, ...options });

function firstAtOrAfter(chain, target) {
  let number = ORIGIN.originNumber + Math.floor(((target - ORIGIN.originTimestamp) * 10000) / 5074) - 5;
  while (chain.timestampOf(number) >= target) number -= 1;
  while (chain.timestampOf(number) < target) number += 1;
  return number;
}

// Independent reference straight from the generator: no engine module, normalizer or decoder involved.
function reference(chain, first, last) {
  const senders = new Set(), recipients = new Set(), v4Traders = new Set(), v4Pools = new Set(), v3Traders = new Set();
  const out = { blockCount: 0, transactionCount: 0, gasUsed: 0n, deployments: 0, usdc: 0, usdcAmount: 0n, mints: 0, burns: 0,
    eurc: 0, v4Swaps: 0, v4Modify: 0, v4Init: 0, v3Swaps: 0, v3Mints: 0, v3Created: 0 };
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
    }
  }
  return { ...out, senders: senders.size, recipients: recipients.size, active: new Set([...senders, ...recipients]).size,
    v4Traders: v4Traders.size, v4Pools: v4Pools.size, v3Traders: v3Traders.size };
}

const clean = chainOf();
const expectedFirst = firstAtOrAfter(clean, HOUR);
const expectedLast = firstAtOrAfter(clean, HOUR + 3600) - 1;
const expected = reference(clean, expectedFirst, expectedLast);
const cleanResult = await processHour({ provider: offlineProvider(clean.fetchImpl), hourStart: HOUR, safeHead: SAFE_HEAD });

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
  const error = await rejectsWith(processHour({ provider: offlineProvider(chain.fetchImpl), hourStart: HOUR, safeHead: SAFE_HEAD }), 'parent_hash_mismatch');
  assert(error instanceof HourIncompleteError);
  assert.equal(error.blockNumber, expectedFirst + 1500);
});

await test('block continuity: right boundary block must descend from the last hour block', async () => {
  const chain = chainOf({ faults: { block: (n, raw, full) => (!full && n === expectedLast + 1 ? { ...raw, parentHash: `0x${'cd'.repeat(32)}` } : raw) } });
  await rejectsWith(processHour({ provider: offlineProvider(chain.fetchImpl), hourStart: HOUR, safeHead: SAFE_HEAD }), 'right_boundary_mismatch');
});

// 3. Missing block
await test('missing block: null body or hash-only body is never an empty block', async () => {
  const missing = chainOf({ faults: { block: (n, raw, full) => (full && n === expectedFirst + 10 ? null : raw) } });
  await rejectsWith(processHour({ provider: offlineProvider(missing.fetchImpl), hourStart: HOUR, safeHead: SAFE_HEAD }), 'missing_block');
  const hashesOnly = chainOf({ faults: { block: (n, raw, full) => (full && n === expectedFirst + 20 ? { ...raw, transactions: raw.transactions.map((tx) => tx.hash) } : raw) } });
  await rejectsWith(processHour({ provider: offlineProvider(hashesOnly.fetchImpl), hourStart: HOUR, safeHead: SAFE_HEAD }), 'transaction_bodies_missing');
});

// 4. Malformed batch response
await test('malformed batch response: short, duplicate-id and truncated batches fail closed after retries and failover', async () => {
  const isBodyBatch = (body) => Array.isArray(body) && body[0]?.method === 'eth_getBlockByNumber';
  const variants = [
    (body) => body.slice(1).map((item) => ({ jsonrpc: '2.0', id: item.id, result: null })),
    (body) => body.map((item) => ({ jsonrpc: '2.0', id: 1, result: null })),
    () => '[{"jsonrpc":"2.0","id":1,"result":{"number":"0x1"',
  ];
  for (const variant of variants) {
    const chain = chainOf({ faults: { request: (body) => (isBodyBatch(body) ? variant(body) : undefined) } });
    const provider = offlineProvider(chain.fetchImpl);
    await rejectsWith(processHour({ provider, hourStart: HOUR, safeHead: SAFE_HEAD }), 'invalid_response');
    assert.equal(provider.stats.failovers, 1);
    assert.equal(provider.stats.retries, 4);
  }
  let once = true;
  const transient = chainOf({ faults: { request: (body) => (isBodyBatch(body) && once ? ((once = false), '[]') : undefined) } });
  const provider = offlineProvider(transient.fetchImpl);
  assert.deepEqual(await processHour({ provider, hourStart: HOUR, safeHead: SAFE_HEAD }), cleanResult);
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
  assert.equal(provider.stats.requests, 2 * 3 + 2, 'three attempts on each endpoint plus one chainId check each');
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
  assert.deepEqual(await processHour({ provider, hourStart: HOUR, safeHead: SAFE_HEAD }), cleanResult);
  assert.equal(provider.stats.retries, 1);
  assert(!chain.requests.some((request) => Array.isArray(request) && request.includes('eth_getLogs')), 'eth_getLogs must never be batched');
  assert(chain.requests.filter(Array.isArray).every((request) => request.length <= 50), 'batches are at most 50 calls');
});

// 6. Range splitting
await test('range splitting: -32012 and -32602 split down to identical results; one-block overflow fails closed', async () => {
  for (const limits of [{ maxRange: 300 }, { maxResults: 2000 }]) {
    const chain = chainOf({ limits });
    const provider = offlineProvider(chain.fetchImpl);
    assert.deepEqual(await processHour({ provider, hourStart: HOUR, safeHead: SAFE_HEAD }), cleanResult, JSON.stringify(limits));
  }
  const chain = chainOf({ limits: { maxResults: 3 } });
  const result = await processHour({ provider: offlineProvider(chain.fetchImpl), hourStart: HOUR, safeHead: SAFE_HEAD });
  assertNullFamily(result, 'usdc', 'unsplittable_range');
  assert.deepEqual(result.network, cleanResult.network, 'network spine is unaffected by a log family failure');
});

// 7. Removed log rejection
await test('removed log rejection: a removed log makes its family unavailable, never a smaller count', async () => {
  const chain = chainOf({ faults: { logs: (filter, logs) => (filter.address?.[0] === USDC_SYSTEM_EMITTER.toLowerCase() && logs.length
    ? logs.map((log, index) => (index === 7 ? { ...log, removed: true } : log)) : logs) } });
  const result = await processHour({ provider: offlineProvider(chain.fetchImpl), hourStart: HOUR, safeHead: SAFE_HEAD });
  assertNullFamily(result, 'usdc', 'removed_log');
  assert.deepEqual(result.families.uniswapV4, cleanResult.families.uniswapV4);
});

// 8. blockHash mismatch
await test('blockHash mismatch: a log from another block hash or transaction is rejected', async () => {
  const isV4 = (filter) => filter.address?.[0] === UNISWAP_REGISTRY.v4PoolManager.address;
  const wrongHash = chainOf({ faults: { logs: (filter, logs) => (isV4(filter) && logs.length
    ? [{ ...logs[0], blockHash: `0x${'ee'.repeat(32)}` }, ...logs.slice(1)] : logs) } });
  const first = await processHour({ provider: offlineProvider(wrongHash.fetchImpl), hourStart: HOUR, safeHead: SAFE_HEAD });
  assertNullFamily(first, 'uniswapV4', 'log_block_hash_mismatch');
  const wrongTx = chainOf({ faults: { logs: (filter, logs) => (isV4(filter) && logs.length
    ? [{ ...logs[0], transactionHash: `0x${'ff'.repeat(32)}` }, ...logs.slice(1)] : logs) } });
  const second = await processHour({ provider: offlineProvider(wrongTx.fetchImpl), hourStart: HOUR, safeHead: SAFE_HEAD });
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
  const result = await processHour({ provider: offlineProvider(injected.fetchImpl), hourStart: HOUR, safeHead: SAFE_HEAD });
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
  assert.deepEqual(v3.verifiedPools.map((pool) => pool.address), [SYNTHETIC_CONTRACTS.validV3Pool]);
  assert.equal(v3.rejectedEmitterCount, 1, 'emitter from a foreign factory is rejected');
  assert.equal(cleanResult.families.assets.items.find((item) => item.symbol === 'EURC').transferCount, expected.eurc);
});

// Real Arc mainnet micro window (blocks 23677449-23677452, crosses 08:00 UTC): equivalence with the raw responses.
const micro = capture.microWindow;
const microBefore = headerOf(micro.calls[0].result, micro.first - 1);
async function runMicro() {
  const recorded = createRecordedFetch(micro.calls);
  const provider = offlineProvider(recorded.fetchImpl);
  const result = await processBlockRange({ provider, first: micro.first, last: micro.last, before: microBefore });
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
  assert.equal(microResult.complete, true);
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
  const result = await processHour({ provider: offlineProvider(failing.fetchImpl), hourStart: HOUR, safeHead: SAFE_HEAD });
  assertNullFamily(result, 'uniswapV4', 'rpc_error');
  assert.equal(JSON.stringify(result.families.uniswapV4).includes(':0'), false);
});

await test('dense streams: canonical USDC and V4 requests never span more than 500 blocks and stay gap-free', async () => {
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
  const result = await processHour({ provider: offlineProvider(chain.fetchImpl), hourStart: HOUR, safeHead: SAFE_HEAD, windowBlocks: 2000 });
  assert.deepEqual(result, cleanResult);
  for (const key of ['usdc', 'v4']) {
    assert(Math.max(...spans[key]) <= DENSE_LOG_RANGE_BLOCKS, `${key} requested ${Math.max(...spans[key])} blocks`);
    assert.equal(spans[key].reduce((sum, span) => sum + span, 0), cleanResult.network.blockCount);
  }
  assert(Math.max(...spans.assets) > DENSE_LOG_RANGE_BLOCKS, 'sparse streams follow the window size');
});

await test('V3 pool check: a non-revert RPC error makes V3 unavailable; only a revert rejects the pool', async () => {
  const answer = (error) => ({ to }) => (to.toLowerCase() === SYNTHETIC_CONTRACTS.validV3Pool ? { error } : undefined);
  const lagging = chainOf({ faults: { call: answer({ code: -32000, message: 'header not found' }) } });
  const unavailable = await processHour({ provider: offlineProvider(lagging.fetchImpl), hourStart: HOUR, safeHead: SAFE_HEAD });
  assertNullFamily(unavailable, 'uniswapV3', 'v3_pool_verification_unavailable');
  const reverting = chainOf({ faults: { call: answer({ code: 3, message: 'execution reverted' }) } });
  const rejected = (await processHour({ provider: offlineProvider(reverting.fetchImpl), hourStart: HOUR, safeHead: SAFE_HEAD })).families.uniswapV3;
  assert.equal(rejected.status, 'available');
  assert.deepEqual(rejected.verifiedPools, []);
  assert.equal(rejected.rejectedEmitterCount, 2);
});

await test('dependency policy: engine, tests and validator import only node: built-ins and repository files', async () => {
  const compactDirectory = new URL('../server/compact/', import.meta.url);
  const queue = [...(await readdir(compactDirectory)).filter((name) => name.endsWith('.js')).map((name) => new URL(name, compactDirectory)),
    new URL(import.meta.url), new URL('./validate-compact-hour.mjs', import.meta.url)];
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
async function validateOffline({ expectedValues = syntheticTruth, secondaryFetch = chainOf().fetchImpl, sqliteDirectory = null } = {}) {
  const lines = [];
  const report = await validateHour({ primary: offlineProvider(chainOf().fetchImpl), secondary: offlineProvider(secondaryFetch),
    hourStart: HOUR, expected: expectedValues, sqliteDirectory, print: (text) => lines.push(text) });
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
  const limited = async () => ({ status: 429, ok: false, text: async () => '' });
  const { report, lines } = await validateOffline({ secondaryFetch: limited });
  assert.equal(report.ok, false);
  assert.equal(report.secondary.status, 'not_verified');
  assert.equal(report.secondary.reason, 'rate_limited');
  assert(lines.some((text) => text.startsWith('SECONDARY NOT VERIFIED')));
  assert(report.metrics.every((metric) => metric.match));
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
    hours.push(await processHour({ provider: offlineProvider(chainOf().fetchImpl), hourStart: HOUR + offset * 3600, safeHead: ORIGIN.originNumber + 25_000 }));
  }
  assert(hours.every((hour) => hour.complete));
  const rows = (db) => db.prepare('SELECT hour_start, result_sha256 FROM compact_hours ORDER BY hour_start').all()
    .map((row) => `${row.hour_start}:${row.result_sha256}`);
  try {
    await test('sqlite: schema is created on node:sqlite and reopening keeps it', async () => {
      const db = open();
      createCompactStore(db);
      assert.deepEqual(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all().map((row) => row.name),
        ['compact_checkpoint', 'compact_hours', 'compact_meta']);
      db.close();
      const again = open();
      createCompactStore(again);
      assert.equal(again.prepare('SELECT value FROM compact_meta WHERE key = ?').get('schema_version').value, '1');
      again.close();
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
      assert.equal(store.commitHour(hours[2]).checkpoint.hourStart, HOUR, 'a gap never moves the checkpoint');
      assert.equal(store.commitHour(hours[1]).checkpoint.hourStart, HOUR + 7200, 'closing the gap moves it across contiguous hours');
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

    await test('sqlite: an incomplete or inconsistent hour can never be committed as complete', async () => {
      const db = open('refusals.sqlite');
      const store = createCompactStore(db);
      const unavailableUsdc = { status: 'unavailable', reason: 'removed_log', ...Object.fromEntries(FAMILY_FIELDS.usdc.map((field) => [field, null])) };
      for (const result of [
        { ...hours[0], complete: false, families: { ...hours[0].families, usdc: unavailableUsdc } },
        { ...hours[0], families: { ...hours[0].families, usdc: unavailableUsdc } },
        microResult,
        { ...hours[0], network: { ...hours[0].network, blockCount: hours[0].network.blockCount - 1 } },
      ]) assert.throws(() => store.commitHour(result), (error) => error.code === 'hour_not_complete');
      assert.equal(store.hourCount(), 0);
      assert.equal(store.checkpoint(), null);
      assert.throws(() => db.prepare("INSERT INTO compact_hours VALUES (?, 'x', 10, 20, 'a', 'b', 5, 0, 0, 0, 0, 0, '{}', 'h')").run(BigInt(HOUR)),
        /CHECK constraint/i);
      store.commitHour(hours[0]);
      const shifted = { ...hours[1], range: { ...hours[1].range, firstBlock: hours[1].range.firstBlock + 1, lastBlock: hours[1].range.lastBlock + 1 } };
      assert.throws(() => store.commitHour(shifted), (error) => error.code === 'checkpoint_discontinuity');
      assert.equal(store.hourCount(), 1);
      db.close();
    });

    await test('sqlite: the compact database holds aggregates only, no raw block, transaction, receipt or log archive', async () => {
      const db = open();
      assert.deepEqual(db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table', 'view') ORDER BY name").all().map((row) => row.name),
        ['compact_checkpoint', 'compact_hours', 'compact_meta']);
      const text = db.prepare('SELECT first_hash || last_hash || result_json AS text FROM compact_hours').all().map((row) => row.text).join('');
      assert.equal(text.match(/0x[0-9a-f]{64}/g).length, hours.length * 4, 'only first and last block hashes; no transaction or log hashes');
      assert(db.prepare('SELECT MAX(LENGTH(result_json)) AS size FROM compact_hours').get().size < 16384);
      db.close();
      const { size } = await stat(join(directory, 'store.sqlite'));
      assert(size < 256 * 1024, `database is ${size} bytes for ${hours.length} hours`);
    });

    await test('validator gate: a verified hour round-trips through a temporary node:sqlite file that is then deleted', async () => {
      const { report } = await validateOffline({ sqliteDirectory: directory });
      assert.equal(report.ok, true);
      assert.deepEqual({ status: report.sqlite.status, first: report.sqlite.first, replay: report.sqlite.replay },
        { status: 'verified', first: 'inserted', replay: 'unchanged' });
      assert(!(await readdir(directory)).some((name) => name.startsWith('compact-validation-')));
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

// 13. Replay idempotence
await test('replay idempotence: same hour, any window size or safe head, byte-identical result', async () => {
  const runs = [
    await processHour({ provider: offlineProvider(clean.fetchImpl), hourStart: HOUR, safeHead: SAFE_HEAD }),
    await processHour({ provider: offlineProvider(chainOf().fetchImpl), hourStart: HOUR, safeHead: SAFE_HEAD + 3000, windowBlocks: 500 }),
    await processHour({ provider: offlineProvider(chainOf().fetchImpl), hourStart: HOUR, safeHead: SAFE_HEAD + 40_000, windowBlocks: 2000 }),
  ];
  for (const run of runs) assert.equal(digest(run), digest(cleanResult));
  assert.equal(digest((await runMicro()).result), digest(microResult));
});

await test('provider: wrong chain and dead primary fail over to the fallback endpoint', async () => {
  const chain = chainOf();
  const wrongChain = async (url, init) => (url.includes('rpc.mainnet.arc.io')
    ? { status: 200, ok: true, text: async () => JSON.stringify({ jsonrpc: '2.0', id: 1, result: '0x1' }) } : chain.fetchImpl(url, init));
  const provider = offlineProvider(wrongChain);
  assert.equal(await provider.request('eth_chainId'), hex(5042));
  assert.equal(provider.stats.failovers, 1);
  const dead = async (url, init) => (url.includes('rpc.mainnet.arc.io') ? { status: 503, ok: false, text: async () => '' } : chain.fetchImpl(url, init));
  const fallback = offlineProvider(dead);
  assert.deepEqual(await processHour({ provider: fallback, hourStart: HOUR, safeHead: SAFE_HEAD }), cleanResult);
  assert(fallback.stats.byEndpoint.drpc > 0);
});

console.log('COMPACT_REAL_MICRO_WINDOW', JSON.stringify({ range: microResult.range, network: microResult.network, families: microResult.families,
  requests: microProvider.stats.requests, responseBytes: microProvider.stats.responseBytes, sha256: digest(microResult) }));
console.log('COMPACT_SYNTHETIC_HOUR', JSON.stringify({ range: cleanResult.range, network: cleanResult.network, usdc: cleanResult.families.usdc,
  uniswapV4: cleanResult.families.uniswapV4, sha256: digest(cleanResult) }));
console.log(`ARC_INTELLIGENCE_COMPACT: PASS (${passed} deterministic scenarios on Node ${process.version}; offline only, no network or server; `
  + `node:sqlite ${sqlite ? 'tested' : 'deferred'})`);
