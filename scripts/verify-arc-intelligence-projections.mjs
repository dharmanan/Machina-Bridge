// Compact engine, Stage 4B Phase 1A: Uniswap V3/V4 pool-hour projections, recent DEX activity and the V4 pool registry.
// Offline only: hand-encoded events plus the deterministic synthetic chain. No network, no server, no backfill run.
// node:sqlite tests run when the runtime has it (Node 22.13+); COMPACT_REQUIRE_SQLITE=1 turns its absence into a failure.
// COMPACT_SQLITE_DIR (optional) is where the temporary database directory is created; it is deleted afterwards.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeLog } from '../api/_lib/arc-intelligence/normalize.js';
import { UNISWAP_EVENT_TOPICS, UNISWAP_REGISTRY } from '../api/_lib/arc-intelligence/uniswap.js';
import { USDC_ERC20_ADDRESS } from '../api/_lib/arc-intelligence/usdc.js';
import { createUniswapV3Accumulator, createUniswapV4Accumulator, FAMILY_FIELDS } from '../server/compact/families.js';
import { processHour } from '../server/compact/hour.js';
import { LogError } from '../server/compact/logs.js';
import { createSyntheticChain, SYNTHETIC_CONTRACTS, SYNTHETIC_V4_HOOKS, syntheticV4PoolKey } from '../server/compact/offline.js';
import {
  backfillProjectionHour, formatPlan, planProjectionBackfill, planProjectionRepair, planV4Registry, PROJECTION_BACKFILL_STREAMS,
  readBackfillInputs, runProjectionBackfill, validateBackfillLogs, verifyStoredBoundaries,
} from '../server/compact/projection-backfill.js';
import {
  activityOrder, ACTIVITY_ROWS_PER_KIND, createProjectionSink, newestActivity, POOL_HOUR_RETENTION_HOURS, poolHourCutoff, PROJECTION_VERSIONS,
  projectionRepairState, PROJECTIONS, reconcilePoolRows, v4PoolIdOf, v4PoolRecordOf, validV4Record,
} from '../server/compact/projections.js';
import { ARC_CHAIN_ID, createProvider } from '../server/compact/provider.js';
import {
  bootstrapV3Registry, bootstrapV4Registry, catchUpV4Registry, locateDeploymentBlock, registrySnapshot, v4RegistryScanRequests,
} from '../server/compact/registry.js';
import { COMPACT_DEFINITION_VERSION, FAMILY_STREAMS, FAMILY_VERSIONS, LOG_STREAMS, V4_INITIALIZE_STREAM } from '../server/compact/sources.js';
import { createCompactReadModel } from '../server/compact/read-model.js';
import { createCompactStore } from '../server/compact/store.js';
import { backfillConfig, runBackfillTool } from './backfill-compact-projections.mjs';
import { repairConfig, repairProjectionHour } from './repair-compact-projection-hour.mjs';
import { runCompactHour } from './run-compact-hour.mjs';

let passed = 0;
async function test(name, run) { await run(); passed += 1; console.log(`PASS ${name}`); }
const offlineProvider = (fetchImpl) => createProvider({ fetchImpl, minIntervalMs: 0, cooldownMs: 0, sleep: async () => {} });
async function rejectsWith(promise, code) {
  let error;
  try { await promise; } catch (caught) { error = caught; }
  assert(error, `expected ${code}, got a result`);
  assert.equal(error.code, code, `expected ${code}, got ${error.code ?? error.message}`);
  return error;
}
const hex = (number) => `0x${number.toString(16)}`;
const word = (value) => BigInt.asUintN(256, BigInt(value)).toString(16).padStart(64, '0');
const topicOf = (address) => `0x${address.slice(2).padStart(64, '0')}`;
const addressOf = (prefix, n) => `0x${prefix}${n.toString(16).padStart(40 - prefix.length, '0')}`;
const ZERO = `0x${'0'.repeat(40)}`;
const T = UNISWAP_EVENT_TOPICS;
const PM = UNISWAP_REGISTRY.v4PoolManager.address;
const POOL_MANAGER_KEY = (overrides = {}) => ({ currency0: ZERO, currency1: SYNTHETIC_CONTRACTS.tokenB, fee: 500, tickSpacing: 10, hooks: ZERO, ...overrides });

// ---------------------------------------------------------------------------------------------------------------------
// Hand-encoded events through the real family accumulators (so foreign-emitter exclusion and decoding are the live ones).

const UNIT_HOUR = 1_790_006_400;
const UNIT_FIRST = 50_000_000;
const UNIT_TXS = 4;
const V3_POOL = addressOf('c0de01', 1);
const FOREIGN = addressOf('c0de02', 2);
const ROUTER = addressOf('4f', 1);
const RECIPIENT = addressOf('9e', 7);
const OWNER = addressOf('0e', 3);
const NPM = addressOf('5a', 5);
const P1 = `0x${'d1'.repeat(32)}`;
const P2 = `0x${'d2'.repeat(32)}`;
const unitTxHash = (block, index) => `0x7a${block.toString(16).padStart(14, '0')}${index.toString(16).padStart(8, '0')}${'0'.repeat(40)}`;
const unitBlockHash = (block) => `0x${block.toString(16).padStart(64, '0')}`;
function windowOf(first, count, hourStart = UNIT_HOUR) {
  return new Map(Array.from({ length: count }, (_, index) => {
    const number = first + index;
    return [number, { number, hash: unitBlockHash(number), timestamp: hourStart + Math.floor(index / 2),
      txHashes: Array.from({ length: UNIT_TXS }, (__, tx) => unitTxHash(number, tx)),
      txFrom: Array.from({ length: UNIT_TXS }, (__, tx) => addressOf('f0', number * 10 + tx)) }];
  }));
}
const UNIT_WINDOW = windowOf(UNIT_FIRST, 10);

const v3Swap = (amount0, amount1, { pool = V3_POOL, sender = ROUTER, recipient = RECIPIENT } = {}) => ({ stream: 'v3Pools', address: pool,
  topics: [T.v3Swap, topicOf(sender), topicOf(recipient)], data: `0x${word(amount0)}${word(amount1)}${word(1n << 96n)}${word(10n ** 18n)}${word(-120)}` });
const v3Mint = (liquidity, amount0, amount1, { pool = V3_POOL, owner = OWNER, sender = NPM } = {}) => ({ stream: 'v3Pools', address: pool,
  topics: [T.v3Mint, topicOf(owner), `0x${word(-600)}`, `0x${word(600)}`], data: `0x${word(BigInt(sender))}${word(liquidity)}${word(amount0)}${word(amount1)}` });
const v3Burn = (liquidity, amount0, amount1, { pool = V3_POOL, owner = OWNER } = {}) => ({ stream: 'v3Pools', address: pool,
  topics: [T.v3Burn, topicOf(owner), `0x${word(-600)}`, `0x${word(600)}`], data: `0x${word(liquidity)}${word(amount0)}${word(amount1)}` });
const v4Swap = (poolId, amount0, amount1, { sender = ROUTER } = {}) => ({ stream: 'v4', address: PM, topics: [T.v4Swap, poolId, topicOf(sender)],
  data: `0x${word(amount0)}${word(amount1)}${word(1n << 96n)}${word(10n ** 18n)}${word(-5)}${word(500)}` });
const v4Modify = (poolId, delta, { sender = NPM, salt = 1 } = {}) => ({ stream: 'v4', address: PM, topics: [T.v4ModifyLiquidity, poolId, topicOf(sender)],
  data: `0x${word(-600)}${word(600)}${word(delta)}${word(salt)}` });
const v4Initialize = (key, { poolId = v4PoolIdOf(key) } = {}) => ({ stream: 'v4', address: PM,
  topics: [T.v4Initialize, poolId, topicOf(key.currency0), topicOf(key.currency1)],
  data: `0x${word(key.fee)}${word(key.tickSpacing)}${word(BigInt(key.hooks))}${word(1n << 96n)}${word(0)}` });

// Spec i sits at block UNIT_FIRST + floor(i / 8), log index i % 8, transaction i % 4.
function unitLogs(specs, { first = UNIT_FIRST, window = UNIT_WINDOW } = {}) {
  return specs.map((spec, index) => {
    const block = first + Math.floor(index / 8);
    const tx = index % UNIT_TXS;
    return { stream: spec.stream, log: normalizeLog({ address: spec.address, topics: spec.topics, data: spec.data, blockNumber: hex(block),
      blockHash: window.get(block).hash, transactionHash: window.get(block).txHashes[tx], transactionIndex: hex(tx), logIndex: hex(index % 8),
      removed: false }) };
  });
}
async function unitHour(specs, { pools = [V3_POOL], window = UNIT_WINDOW, first = UNIT_FIRST, hourStart = UNIT_HOUR, sink = createProjectionSink() } = {}) {
  const logs = unitLogs(specs, { first, window });
  const v3 = createUniswapV3Accumulator({ registry: { pools: new Set(pools) }, projection: sink });
  const v4 = createUniswapV4Accumulator({ projection: sink });
  v3.add('v3Pools', logs.filter((entry) => entry.stream === 'v3Pools').map((entry) => entry.log), window);
  v4.add('v4', logs.filter((entry) => entry.stream === 'v4').map((entry) => entry.log), window);
  const families = { uniswapV3: { status: 'available', ...(await v3.finish({ factoryCodePresent: true })) },
    uniswapV4: { status: 'available', ...(await v4.finish({ poolManagerCodePresent: true })) } };
  return { logs: logs.map((entry) => entry.log), families, projections: sink.finish({ families, hourStart }), sink };
}
const activityOf = (projections, kind) => projections.dex_activity.rows.filter((row) => row.kind === kind);
const txFromOf = (window, row) => {
  const block = window.get(row.blockNumber);
  return block.txFrom[block.txHashes.indexOf(row.txHash)];
};
const V3_EMPTY_LIQUIDITY = { addAmount0Raw: '0', addAmount1Raw: '0', removeAmount0Raw: '0', removeAmount1Raw: '0' };
const V4_NULL_LIQUIDITY = { addAmount0Raw: null, addAmount1Raw: null, removeAmount0Raw: null, removeAmount1Raw: null };
const NO_VALUE_FIELDS = (row) => !Object.keys(row).some((key) => /volume|usd|value|price|tvl/i.test(key));

await test('V3 Swap: four directional raw totals from the pool side; signed event amounts kept exactly in activity; nothing is a volume', async () => {
  const big = 10n ** 30n;
  const { projections, families } = await unitHour([v3Swap(100n, -40n), v3Swap(-7n, 9n), v3Swap(big, -(big / 10n))]);
  assert.equal(projections.uniswap_v3_pools.status, 'available');
  assert.deepEqual(projections.uniswap_v3_pools.rows, [{ pool: V3_POOL, swapCount: 3, token0InRaw: (100n + big).toString(), token0OutRaw: '7',
    token1InRaw: '9', token1OutRaw: (40n + big / 10n).toString(), addCount: 0, removeCount: 0, pokeCount: 0, ...V3_EMPTY_LIQUIDITY }]);
  assert.equal(families.uniswapV3.swapCount, 3);
  const swaps = activityOf(projections, 'swap');
  assert.deepEqual(swaps.map((row) => [row.amount0Raw, row.amount1Raw, row.amountBasis]),
    [[big.toString(), (-(big / 10n)).toString(), 'v3_pool_delta'], ['-7', '9', 'v3_pool_delta'], ['100', '-40', 'v3_pool_delta']], 'newest first');
  assert(projections.uniswap_v3_pools.rows.every(NO_VALUE_FIELDS) && swaps.every(NO_VALUE_FIELDS), 'no volume, USD, price or TVL field');
});

await test('V3 Mint is an Add with its exact token amounts; the position owner is the counterparty', async () => {
  const { projections, families } = await unitHour([v3Mint(5000n, 11n, 22n)]);
  assert.deepEqual(projections.uniswap_v3_pools.rows, [{ pool: V3_POOL, swapCount: 0, token0InRaw: '0', token0OutRaw: '0', token1InRaw: '0',
    token1OutRaw: '0', addCount: 1, removeCount: 0, pokeCount: 0, addAmount0Raw: '11', addAmount1Raw: '22', removeAmount0Raw: '0', removeAmount1Raw: '0' }]);
  assert.equal(families.uniswapV3.mintCount, 1);
  const [add] = activityOf(projections, 'add');
  assert.deepEqual([add.protocol, add.amount0Raw, add.amount1Raw, add.amountBasis, add.counterparty, add.counterpartyKind],
    ['uniswap_v3', '11', '22', 'v3_liquidity_amount', OWNER, 'liquidity_owner']);
  assert.notEqual(add.counterparty, NPM, 'the Mint sender (position manager) is not the counterparty');
});

await test('V3 Burn with liquidity > 0 is a Remove with its exact token amounts', async () => {
  const { projections, families } = await unitHour([v3Burn(5000n, 3n, 4n)]);
  const [row] = projections.uniswap_v3_pools.rows;
  assert.deepEqual([row.removeCount, row.pokeCount, row.removeAmount0Raw, row.removeAmount1Raw, row.addCount], [1, 0, '3', '4', 0]);
  assert.equal(families.uniswapV3.burnCount, 1);
  const [remove] = activityOf(projections, 'remove');
  assert.deepEqual([remove.amount0Raw, remove.amount1Raw, remove.amountBasis, remove.counterparty, remove.counterpartyKind],
    ['3', '4', 'v3_liquidity_amount', OWNER, 'liquidity_owner']);
});

await test('V3 Burn with zero liquidity is a fee poke: counted only to reconcile, never a Remove or an activity row', async () => {
  const { projections, families } = await unitHour([v3Burn(0n, 0n, 0n), v3Burn(7n, 1n, 1n)]);
  const [row] = projections.uniswap_v3_pools.rows;
  assert.deepEqual([row.removeCount, row.pokeCount, row.removeAmount0Raw, row.removeAmount1Raw], [1, 1, '1', '1']);
  assert.equal(families.uniswapV3.burnCount, 2, 'the family counts both Burns');
  assert.equal(projections.uniswap_v3_pools.status, 'available', 'remove + poke reconciles with burnCount');
  assert.equal(activityOf(projections, 'remove').length, 1, 'only the real remove is activity');
});

await test('foreign V3-signature emitters never become pool rows or activity', async () => {
  const { projections, families } = await unitHour([v3Swap(5n, -5n, { pool: FOREIGN }), v3Mint(9n, 1n, 1n, { pool: FOREIGN }), v3Swap(1n, -1n),
    v3Burn(0n, 0n, 0n, { pool: FOREIGN })]);
  assert.deepEqual(projections.uniswap_v3_pools.rows.map((row) => [row.pool, row.swapCount]), [[V3_POOL, 1]]);
  assert.deepEqual([families.uniswapV3.foreignEventCount, families.uniswapV3.foreignEmitterCount, families.uniswapV3.swapCount], [3, 1, 1]);
  assert(!projections.dex_activity.rows.some((row) => row.pool === FOREIGN));
  assert.equal(projections.uniswap_v3_pools.status, 'available');
});

const KEY_NATIVE_HOOKED = POOL_MANAGER_KEY({ hooks: SYNTHETIC_V4_HOOKS, tickSpacing: 60 });
const KEY_PLAIN = POOL_MANAGER_KEY({ currency0: SYNTHETIC_CONTRACTS.tokenA, tickSpacing: 1 });

await test('V4 Initialize builds a registry record keyed by poolId = keccak256(PoolKey), with the full PoolKey', async () => {
  const { projections, families, logs } = await unitHour([v4Initialize(KEY_NATIVE_HOOKED), v4Initialize(KEY_PLAIN)]);
  assert.equal(projections.uniswap_v4_pools.status, 'available');
  assert.deepEqual(projections.uniswap_v4_pools.registry, [KEY_NATIVE_HOOKED, KEY_PLAIN].map((key, index) => ({ poolId: v4PoolIdOf(key),
    createdBlock: logs[index].blockNumber, createdLogIndex: logs[index].logIndex, createdTx: logs[index].transactionHash, ...key })));
  assert(projections.uniswap_v4_pools.registry.every(validV4Record));
  assert.equal(families.uniswapV4.initializeCount, 2);
  assert.equal(validV4Record({ ...projections.uniswap_v4_pools.registry[0], fee: 3000 }), false, 'a record whose PoolKey changed is invalid');
});

await test('V4 poolId verification failure: the V4 projection is unavailable, the V4 family still counts exactly', async () => {
  const forged = `0x${'ab'.repeat(32)}`;
  const { projections, families } = await unitHour([v4Initialize(KEY_PLAIN, { poolId: forged }), v4Swap(P1, -5n, 4n), v3Swap(1n, -1n)]);
  assert.deepEqual(projections.uniswap_v4_pools, { status: 'unavailable', reason: 'v4_pool_id_mismatch' });
  assert.deepEqual([families.uniswapV4.initializeCount, families.uniswapV4.swapCount], [1, 1], 'the family is unaffected');
  assert.equal(projections.uniswap_v3_pools.status, 'available');
  assert.deepEqual(projections.dex_activity, { status: 'unavailable', reason: 'projection_inputs_unavailable' });
  const [log] = unitLogs([v4Initialize(KEY_PLAIN, { poolId: forged })]).map((entry) => entry.log);
  assert.throws(() => v4PoolRecordOf(log), (error) => error.code === 'v4_pool_id_mismatch');
});

await test('V4 Swap: directional flow from the caller-side delta (negative = into the pool); the delta is kept as emitted', async () => {
  const { projections } = await unitHour([v4Swap(P1, -500n, 200n), v4Swap(P1, 30n, -70n), v4Swap(P2, -1n, 1n)]);
  assert.deepEqual(projections.uniswap_v4_pools.rows, [
    { pool: P1, swapCount: 2, token0InRaw: '500', token0OutRaw: '30', token1InRaw: '70', token1OutRaw: '200', addCount: 0, removeCount: 0, pokeCount: 0,
      ...V4_NULL_LIQUIDITY },
    { pool: P2, swapCount: 1, token0InRaw: '1', token0OutRaw: '0', token1InRaw: '0', token1OutRaw: '1', addCount: 0, removeCount: 0, pokeCount: 0,
      ...V4_NULL_LIQUIDITY }]);
  assert.deepEqual(activityOf(projections, 'swap').map((row) => [row.pool, row.amount0Raw, row.amount1Raw, row.amountBasis]),
    [[P2, '-1', '1', 'v4_swap_delta'], [P1, '30', '-70', 'v4_swap_delta'], [P1, '-500', '200', 'v4_swap_delta']]);
});

await test('V4 ModifyLiquidity: delta > 0 is an Add, < 0 a Remove, 0 a poke; no token amounts are derived', async () => {
  const { projections, families } = await unitHour([v4Modify(P1, 10n ** 15n), v4Modify(P1, -(10n ** 12n)), v4Modify(P1, 0n)]);
  assert.deepEqual(projections.uniswap_v4_pools.rows, [{ pool: P1, swapCount: 0, token0InRaw: '0', token0OutRaw: '0', token1InRaw: '0',
    token1OutRaw: '0', addCount: 1, removeCount: 1, pokeCount: 1, ...V4_NULL_LIQUIDITY }]);
  assert.equal(families.uniswapV4.modifyLiquidityCount, 3, 'add + remove + poke reconciles with the family');
  for (const kind of ['add', 'remove']) {
    const [row] = activityOf(projections, kind);
    assert.deepEqual([row.amount0Raw, row.amount1Raw, row.amountBasis, row.counterparty, row.counterpartyKind], [null, null, 'none', NPM, 'event_sender']);
  }
  assert.equal(projections.dex_activity.rows.length, 2, 'the poke is not activity');
});

await test('V4 native currency: 0x0 stays the native currency (Arc USDC, 18 decimals), never the 6-decimal USDC token', async () => {
  // Public Uniswap V4 vector: native ETH / USDC 0.05% pool on Ethereum mainnet.
  assert.equal(v4PoolIdOf({ currency0: ZERO, currency1: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', fee: 500, tickSpacing: 10, hooks: ZERO }),
    '0x21c67e77068de97969ba93d4aab21826d33ca12bb9f565d8496e8fda8a82ca27');
  const { projections } = await unitHour([v4Initialize(KEY_NATIVE_HOOKED)]);
  const [record] = projections.uniswap_v4_pools.registry;
  assert.equal(record.currency0, ZERO);
  assert.notEqual(record.currency0, USDC_ERC20_ADDRESS.toLowerCase());
  assert.notEqual(v4PoolIdOf({ ...KEY_NATIVE_HOOKED, currency0: USDC_ERC20_ADDRESS.toLowerCase() }), record.poolId, 'a different pool identity');
});

await test('hooked V4 pools are included and keep their hooks; the hook is part of the pool identity', async () => {
  const hooked = v4PoolIdOf(KEY_NATIVE_HOOKED);
  const { projections } = await unitHour([v4Initialize(KEY_NATIVE_HOOKED), v4Swap(hooked, -9n, 8n)]);
  assert.equal(projections.uniswap_v4_pools.registry[0].hooks, SYNTHETIC_V4_HOOKS);
  assert.notEqual(v4PoolIdOf({ ...KEY_NATIVE_HOOKED, hooks: ZERO }), hooked);
  assert.deepEqual(projections.uniswap_v4_pools.rows.map((row) => [row.pool, row.swapCount]), [[hooked, 1]]);
  assert.equal(activityOf(projections, 'swap')[0].pool, hooked);
});

await test('activity From is the exact top-level transaction sender from the spine, never an event field or a router', async () => {
  const { projections } = await unitHour([v3Swap(1n, -1n), v3Mint(9n, 1n, 2n), v4Swap(P1, -3n, 2n), v4Modify(P1, 5n), v3Burn(3n, 1n, 1n),
    v4Modify(P1, -5n)]);
  assert.equal(projections.dex_activity.rows.length, 6);
  for (const row of projections.dex_activity.rows) {
    assert.equal(row.txFrom, txFromOf(UNIT_WINDOW, row));
    assert(![ROUTER, RECIPIENT, OWNER, NPM].includes(row.txFrom));
    assert.equal(row.hourStart, UNIT_HOUR);
    assert.equal(row.blockTimestamp, UNIT_WINDOW.get(row.blockNumber).timestamp);
  }
});

await test('V3 Swap To is exactly the event recipient (not the sender, not tx.to)', async () => {
  const { projections } = await unitHour([v3Swap(4n, -4n, { sender: ROUTER, recipient: RECIPIENT })]);
  const [row] = activityOf(projections, 'swap');
  assert.deepEqual([row.counterparty, row.counterpartyKind], [RECIPIENT, 'swap_recipient']);
  assert.notEqual(row.counterparty, row.txFrom);
});

await test('V4 Swap To is absent: no recipient in the event, so no counterparty even though the event has a sender', async () => {
  const { projections } = await unitHour([v4Swap(P1, -4n, 4n, { sender: ROUTER })]);
  const [row] = activityOf(projections, 'swap');
  assert.deepEqual([row.counterparty, row.counterpartyKind], [null, 'none']);
});

await test('activity is unavailable when a block or transaction sender is missing from the spine; pool projections are not', async () => {
  const sparse = new Map([...UNIT_WINDOW].filter(([number]) => number !== UNIT_FIRST));
  const sink = createProjectionSink();
  const [log] = unitLogs([v4Swap(P1, -1n, 1n)]).map((entry) => entry.log);
  sink.v4('swap', log, { poolId: P1, amount0Raw: '-1', amount1Raw: '1', sender: ROUTER }, sparse);
  const families = { uniswapV3: { status: 'available', swapCount: 0, mintCount: 0, burnCount: 0 },
    uniswapV4: { status: 'available', swapCount: 1, modifyLiquidityCount: 0, initializeCount: 0 } };
  const out = sink.finish({ families, hourStart: UNIT_HOUR });
  assert.deepEqual([out.uniswap_v3_pools.status, out.uniswap_v4_pools.status], ['available', 'available']);
  assert.deepEqual(out.dex_activity, { status: 'unavailable', reason: 'activity_spine_missing' });
});

await test('reconciliation mismatch makes a projection unavailable, never partial', async () => {
  const { sink, families } = await unitHour([v3Swap(1n, -1n), v4Swap(P1, -1n, 1n), v4Initialize(KEY_PLAIN)]);
  const off = (name, field) => sink.finish({ families: { ...families, [name]: { ...families[name], [field]: families[name][field] + 1 } }, hourStart: UNIT_HOUR });
  assert.deepEqual(off('uniswapV3', 'swapCount').uniswap_v3_pools, { status: 'unavailable', reason: 'reconciliation_mismatch' });
  assert.deepEqual(off('uniswapV3', 'burnCount').uniswap_v3_pools, { status: 'unavailable', reason: 'reconciliation_mismatch' });
  assert.deepEqual(off('uniswapV4', 'modifyLiquidityCount').uniswap_v4_pools, { status: 'unavailable', reason: 'reconciliation_mismatch' });
  assert.deepEqual(off('uniswapV4', 'initializeCount').uniswap_v4_pools, { status: 'unavailable', reason: 'reconciliation_mismatch' });
  assert.deepEqual(off('uniswapV4', 'swapCount').dex_activity, { status: 'unavailable', reason: 'projection_inputs_unavailable' });
  const down = sink.finish({ families: { ...families, uniswapV3: { status: 'unavailable', reason: 'v3_registry_behind' } }, hourStart: UNIT_HOUR });
  assert.deepEqual(down.uniswap_v3_pools, { status: 'unavailable', reason: 'family_unavailable' });
  assert.equal(reconcilePoolRows('uniswap_v4_pools', [], { status: 'available', swapCount: 0, modifyLiquidityCount: 0, initializeCount: 1 },
    { initializeCount: 0 }), 'reconciliation_mismatch');
});

await test('a projection failure never throws into the hour or the family accumulators', async () => {
  const sink = createProjectionSink();
  const [log] = unitLogs([v3Swap(1n, -1n)]).map((entry) => entry.log);
  assert.doesNotThrow(() => sink.v3('swap', log, { amount0Raw: 'not-a-number', amount1Raw: '1', recipient: RECIPIENT }, UNIT_WINDOW));
  assert.doesNotThrow(() => sink.v4('modify', log, null, UNIT_WINDOW));
  const out = sink.finish({ families: { uniswapV3: { status: 'available', swapCount: 1, mintCount: 0, burnCount: 0 },
    uniswapV4: { status: 'available', swapCount: 0, modifyLiquidityCount: 1, initializeCount: 0 } }, hourStart: UNIT_HOUR });
  assert.deepEqual([out.uniswap_v3_pools.reason, out.uniswap_v4_pools.reason], ['projection_error', 'projection_error']);
  assert.deepEqual(sink.finish(undefined), Object.fromEntries(PROJECTIONS.map((name) => [name, { status: 'unavailable', reason: 'projection_error' }])));
});

await test('a duplicate V4 Initialize for one poolId inside an hour is refused', async () => {
  const { projections } = await unitHour([v4Initialize(KEY_PLAIN), v4Initialize(KEY_PLAIN)]);
  assert.deepEqual(projections.uniswap_v4_pools, { status: 'unavailable', reason: 'duplicate_v4_initialize' });
});

await test('recent activity keeps the newest 500 rows per kind (block DESC, log index DESC)', async () => {
  const window = windowOf(UNIT_FIRST, 200);
  const specs = [];
  for (let index = 0; index < 1200; index++) specs.push(index % 40 === 0 ? v4Modify(P1, 1n) : v4Swap(P1, -1n, 1n));
  const sink = createProjectionSink();
  const { projections, logs } = await unitHour(specs, { window, sink });
  const swaps = activityOf(projections, 'swap');
  const adds = activityOf(projections, 'add');
  assert.equal(swaps.length, ACTIVITY_ROWS_PER_KIND);
  assert.equal(adds.length, 30);
  const expected = logs.filter((log) => log.topics[0] === T.v4Swap).map((log) => ({ blockNumber: log.blockNumber, logIndex: log.logIndex }))
    .sort(activityOrder).slice(0, ACTIVITY_ROWS_PER_KIND);
  assert.deepEqual(swaps.map((row) => ({ blockNumber: row.blockNumber, logIndex: row.logIndex })), expected);
  assert.deepEqual(newestActivity([{ kind: 'swap', blockNumber: 1, logIndex: 2 }, { kind: 'swap', blockNumber: 2, logIndex: 0 },
    { kind: 'swap', blockNumber: 1, logIndex: 3 }], 2).map((row) => [row.blockNumber, row.logIndex]), [[2, 0], [1, 3]]);
});

await test('pool-hour retention is 35 days, cut from the newest stored hour', async () => {
  assert.equal(POOL_HOUR_RETENTION_HOURS, 35 * 24);
  assert.equal(poolHourCutoff(UNIT_HOUR), UNIT_HOUR - 840 * 3600);
});

// ---------------------------------------------------------------------------------------------------------------------
// The live hour on the deterministic synthetic chain.

const HOUR = 1_790_006_400;
const ORIGIN = { originNumber: 23_000_000, originTimestamp: HOUR - 1000 };
const SAFE_HEAD = ORIGIN.originNumber + 12_000;
const chainOf = (options = {}) => createSyntheticChain({ ...ORIGIN, poolCreatedAt: 23_002_500, ...options });
const V3 = registrySnapshot(await bootstrapV3Registry(offlineProvider(chainOf().fetchImpl), { fromBlock: ORIGIN.originNumber, toBlock: ORIGIN.originNumber + 25_000 }));
async function liveHour(options = {}, extra = {}) {
  const chain = chainOf(options);
  const provider = offlineProvider(chain.fetchImpl);
  const result = await processHour({ provider, hourStart: HOUR, safeHead: SAFE_HEAD, v3Registry: V3, ...extra });
  return { chain, provider, result };
}
const live = await liveHour();
const LIVE = live.result;
const withoutProjections = ({ projections, ...rest }) => rest;
const corruptInitialize = (filter, logs) => logs.map((log) => (log.topics[0] === T.v4Initialize
  ? { ...log, topics: [log.topics[0], `0x${'ab'.repeat(32)}`, ...log.topics.slice(2)] } : log));

await test('live synthetic hour: every projection available, reconciled with the families, V4 pools from their PoolKeys', async () => {
  assert(LIVE.complete);
  const { uniswap_v3_pools: v3, uniswap_v4_pools: v4, dex_activity: activity } = LIVE.projections;
  assert.deepEqual([v3.status, v4.status, activity.status], ['available', 'available', 'available']);
  assert.equal(v3.rows.reduce((total, row) => total + row.swapCount, 0), LIVE.families.uniswapV3.swapCount);
  assert.equal(v3.rows.reduce((total, row) => total + row.addCount, 0), LIVE.families.uniswapV3.mintCount);
  assert.deepEqual(v3.rows.map((row) => row.pool), [SYNTHETIC_CONTRACTS.validV3Pool], 'foreign emitters are not pools');
  assert(LIVE.families.uniswapV3.foreignEventCount > 0);
  assert.equal(v4.rows.reduce((total, row) => total + row.swapCount, 0), LIVE.families.uniswapV4.swapCount);
  const initializes = [];
  for (let number = LIVE.range.firstBlock; number <= LIVE.range.lastBlock; number++) if (number % 3001 === 0) initializes.push(number);
  assert.equal(initializes.length, 3);
  assert.deepEqual(v4.registry.map(({ poolId, createdBlock, currency0, currency1, fee, tickSpacing, hooks }) => ({ poolId, createdBlock, currency0,
    currency1, fee, tickSpacing, hooks })), initializes.map((number) => ({ poolId: v4PoolIdOf(syntheticV4PoolKey(number)), createdBlock: number,
    ...syntheticV4PoolKey(number) })));
  assert(v4.registry.some((pool) => pool.currency0 === ZERO) && v4.registry.some((pool) => pool.hooks === SYNTHETIC_V4_HOOKS));
  assert.deepEqual(activity.rows.filter((row) => row.kind === 'swap').length, ACTIVITY_ROWS_PER_KIND);
  for (const row of activity.rows) {
    assert(row.blockNumber >= LIVE.range.firstBlock && row.blockNumber <= LIVE.range.lastBlock && row.hourStart === HOUR);
    const tx = live.chain.transactionsOf(row.blockNumber).find((candidate) => candidate.hash === row.txHash);
    assert.equal(row.txFrom, tx.from, 'From is the generator transaction sender');
  }
});

await test('no extra RPC: the live projections cost exactly zero requests', async () => {
  const without = await liveHour({}, { projections: false });
  assert.deepEqual(live.chain.requests, without.chain.requests, 'identical request sequence');
  assert.deepEqual([live.provider.stats.requests, live.provider.stats.calls], [without.provider.stats.requests, without.provider.stats.calls]);
  assert.deepEqual(withoutProjections(LIVE), without.result, 'identical hour, families, network and registry');
  assert(!('projections' in without.result));
});

await test('projections are not a compact family: no family version, field, stream, repair input or network hash input', async () => {
  for (const name of PROJECTIONS) {
    assert(!Object.hasOwn(FAMILY_VERSIONS, name) && !Object.hasOwn(FAMILY_FIELDS, name) && !Object.hasOwn(FAMILY_STREAMS, name));
    assert(!Object.values(FAMILY_VERSIONS).includes(PROJECTION_VERSIONS[name]));
  }
  assert.deepEqual(Object.keys(LIVE.families).sort(), Object.keys(FAMILY_FIELDS).sort());
  assert(!LOG_STREAMS.some((stream) => stream.key === V4_INITIALIZE_STREAM.key), 'the registry stream is never requested by the hour');
  assert(!JSON.stringify(LIVE.network).includes('projection'));
  assert.equal(COMPACT_DEFINITION_VERSION, 'arc-compact-hour-v2', 'the hour definition is unchanged');
  // The read model and scheduler know projections only for the projection-only self-heal, never in family repair.
  const readModel = await readFile(new URL('../server/compact/read-model.js', import.meta.url), 'utf8');
  assert(!readModel.match(/availableFamilies: `([^`]*)`/)[1].includes('projection'), 'family repair candidates never look at projections');
  assert(!readModel.match(/const TABLES = Object\.freeze\(\[([^\]]*)\]/)[1].includes('projection'), 'projection tables are not in the family schema check');
  const scheduler = await readFile(new URL('../server/compact/scheduler.js', import.meta.url), 'utf8');
  assert.match(scheduler, /runChild\(candidate, 'repair'\)/, 'family repair runs the hour runner');
  assert.match(scheduler, /runChild\(projectionHour, 'projection_repair', runProjectionRepair\)/, 'projection repair runs only the projection-only child');
  const runner = await readFile(new URL('./run-compact-hour.mjs', import.meta.url), 'utf8');
  assert(/unavailableStored = \[\.\.\.stored\.filter/.test(runner) && /summary\.ok = unavailable\.length === 0/.test(runner),
    'the runner repairs and fails on families only');
});

await test('projection failure does not corrupt family data: a forged Initialize poolId leaves families, network and registry identical', async () => {
  const forged = await liveHour({ faults: { logs: corruptInitialize } });
  assert.deepEqual(withoutProjections(forged.result), withoutProjections(LIVE));
  assert.deepEqual(forged.result.projections.uniswap_v4_pools, { status: 'unavailable', reason: 'v4_pool_id_mismatch' });
  assert.equal(forged.result.projections.uniswap_v3_pools.status, 'available');
  assert.deepEqual(forged.result.projections.dex_activity, { status: 'unavailable', reason: 'projection_inputs_unavailable' });
});

await test('a duplicate log is rejected: its family is unavailable and so is its projection; the other projection stands', async () => {
  const duplicated = await liveHour({ faults: { logs: (filter, logs) => (filter.address?.[0] === PM && logs.length ? [...logs, logs[0]] : logs) } });
  assert.deepEqual([duplicated.result.families.uniswapV4.status, duplicated.result.families.uniswapV4.reason], ['unavailable', 'duplicate_log']);
  assert.deepEqual(duplicated.result.projections.uniswap_v4_pools, { status: 'unavailable', reason: 'family_unavailable' });
  assert.equal(duplicated.result.projections.uniswap_v3_pools.status, 'available');
  const [raw] = live.chain.logsOf(LIVE.range.firstBlock).filter((log) => log.address === PM);
  const stream = PROJECTION_BACKFILL_STREAMS.uniswap_v4_pools;
  assert.throws(() => validateBackfillLogs([raw, raw], stream, { fromBlock: LIVE.range.firstBlock, toBlock: LIVE.range.lastBlock, seen: new Set(),
    hashes: new Map() }), (error) => error instanceof LogError && error.code === 'duplicate_log');
});

await test('same-hour replay is deterministic: identical projections and digests', async () => {
  const again = await liveHour();
  assert.deepEqual(again.result.projections, LIVE.projections);
});

// ---------------------------------------------------------------------------------------------------------------------
// Projection backfill (logs-only) and its dry-run plan.

const liveHourInput = (needs = { uniswap_v3_pools: true, uniswap_v4_pools: true }) => ({ hourStart: HOUR, firstBlock: LIVE.range.firstBlock,
  lastBlock: LIVE.range.lastBlock, parentHash: LIVE.range.parentHash, firstHash: LIVE.range.firstHash, lastHash: LIVE.range.lastHash,
  families: { uniswapV3: LIVE.families.uniswapV3, uniswapV4: LIVE.families.uniswapV4 }, projections: {}, needs });

await test('backfill equals live: two log streams in 500-block requests reproduce the live pool rows and V4 registry exactly', async () => {
  const chain = chainOf();
  const provider = offlineProvider(chain.fetchImpl);
  const out = await backfillProjectionHour({ provider, hour: liveHourInput(), v3Pools: V3.pools });
  assert.deepEqual(out.uniswap_v3_pools, LIVE.projections.uniswap_v3_pools);
  assert.deepEqual(out.uniswap_v4_pools, LIVE.projections.uniswap_v4_pools);
  assert.deepEqual(out.dex_activity, { status: 'unavailable', reason: 'projection_inputs_unavailable' }, 'no spine, no activity');
  const blocks = LIVE.range.lastBlock - LIVE.range.firstBlock + 1;
  assert.deepEqual(provider.stats.calls, { eth_chainId: 1, eth_getLogs: 2 * Math.ceil(blocks / 500) }, 'no spine, receipts or family recount');
  const filters = chain.requests.filter((method) => method === 'eth_getLogs').length;
  assert.equal(filters, 2 * Math.ceil(blocks / 500));
});

await test('backfill validation without a spine: stored boundary hashes, one hash per block, emitter, topic and removed logs', async () => {
  const stream = PROJECTION_BACKFILL_STREAMS.uniswap_v4_pools;
  const first = LIVE.range.firstBlock;
  const [raw] = live.chain.logsOf(first).filter((log) => log.address === PM);
  const options = () => ({ fromBlock: first, toBlock: LIVE.range.lastBlock, seen: new Set(), hashes: new Map([[first, LIVE.range.firstHash]]) });
  assert.equal(validateBackfillLogs([raw], stream, options()).length, 1);
  const cases = [[{ ...raw, blockHash: `0x${'cd'.repeat(32)}` }, 'log_block_hash_mismatch'], [{ ...raw, address: SYNTHETIC_CONTRACTS.tokenA },
    'unexpected_log_address'], [{ ...raw, topics: [T.v3Swap, ...raw.topics.slice(1)] }, 'unexpected_log_topic'], [{ ...raw, removed: true }, 'removed_log'],
  [{ ...raw, blockNumber: hex(first - 1) }, 'log_outside_range']];
  for (const [log, code] of cases) assert.throws(() => validateBackfillLogs([log], stream, options()), (error) => error.code === code, code);
  const provider = offlineProvider(chainOf().fetchImpl);
  const hour = liveHourInput();
  assert.deepEqual([...await verifyStoredBoundaries(provider, [hour, { ...hour, hourStart: HOUR + 3600, lastHash: `0x${'ee'.repeat(32)}` }])], [HOUR + 3600]);
});

await test('backfill: a foreign V3 emitter is skipped, and an unofficial registry can only reconcile to unavailable', async () => {
  const provider = offlineProvider(chainOf().fetchImpl);
  const out = await backfillProjectionHour({ provider, hour: liveHourInput({ uniswap_v3_pools: true }), v3Pools: new Set() });
  assert.deepEqual(out.uniswap_v3_pools, { status: 'unavailable', reason: 'reconciliation_mismatch' }, 'no pool was official: counts cannot match');
});

const blockHash = (number) => `0x${number.toString(16).padStart(64, '0')}`;
function planHours(count, { blocks = 7096, start = 1_790_100_000 - (1_790_100_000 % 3600), firstBlock = 24_000_000 } = {}) {
  return Array.from({ length: count }, (_, index) => {
    const first = firstBlock + index * blocks;
    return { hourStart: start + index * 3600, firstBlock: first, lastBlock: first + blocks - 1, parentHash: blockHash(first - 1), firstHash: blockHash(first),
      lastHash: blockHash(first + blocks - 1), families: { uniswapV3: { status: 'available', poolsWithSwaps: 100 }, uniswapV4: { status: 'available',
        poolsWithSwaps: 50 } }, projections: {} };
  });
}
const planInputs = (hours, extra = {}) => ({ hours, projectionTables: true, v3Coverage: { fromBlock: 1, through: hours.at(-1).lastBlock, throughHash: 'x' },
  v4Coverage: null, v4Pools: 0, checkpoint: { hourStart: hours.at(-1).hourStart, lastBlock: hours.at(-1).lastBlock, lastHash: hours.at(-1).lastHash }, ...extra });

await test('dry-run plan: request and duration formulas for 30 contiguous hours', async () => {
  const hours = planHours(30);
  const plan = planProjectionBackfill(planInputs(hours));
  assert.deepEqual([plan.storedHours, plan.earliestHour, plan.latestHour, plan.totalBlocks, plan.contiguous], [30, hours[0].hourStart,
    hours[29].hourStart, 30 * 7096, true]);
  assert.deepEqual([plan.v3Requests, plan.v4Requests, plan.boundaryRequests, plan.totalRequests], [450, 450, 2, 903], '15 + 15 per hour, ceil(60/50), chain id');
  assert.deepEqual([plan.durationSecondsAt1000Ms, plan.durationSeconds, plan.blockers], [903, 903, []]);
  assert.equal(plan.estimatedPoolRows, 30 * 150);
  const lines = formatPlan(plan, planV4Registry(planInputs(hours), { fromBlock: 1_948_019 }));
  for (const key of ['STORED_HOURS', 'EARLIEST_HOUR', 'LATEST_HOUR', 'TOTAL_BLOCKS', 'CONTIGUITY', 'V3_REQUESTS', 'V4_REQUESTS', 'BOUNDARY_REQUESTS',
    'TOTAL_REQUESTS', 'DURATION_AT_1000MS', 'PROJECTION_30D_BYTES', 'V4_REGISTRY']) assert(lines.some((line) => line.startsWith(`${key} `)), key);
  assert(lines.includes('CONTIGUITY contiguous'));
});

await test('dry-run plan: gaps, retention, already available hours, unavailable families and a registry behind', async () => {
  const hours = planHours(6);
  const gap = planProjectionBackfill(planInputs([...hours.slice(0, 2), ...hours.slice(3)]));
  assert.deepEqual([gap.contiguous, gap.gaps.map((item) => item.kind)], [false, ['hour_gap']]);
  const broken = hours.map((hour, index) => (index === 4 ? { ...hour, parentHash: blockHash(1) } : hour));
  assert.deepEqual(planProjectionBackfill(planInputs(broken)).gaps.map((item) => item.kind), ['hash_link']);
  const mixed = hours.map((hour, index) => (index === 0 ? { ...hour, projections: { uniswap_v3_pools: 'available', uniswap_v4_pools: 'available' } }
    : index === 1 ? { ...hour, projections: { uniswap_v3_pools: 'available' } }
      : index === 2 ? { ...hour, families: { ...hour.families, uniswapV4: { status: 'unavailable' } } } : hour));
  const plan = planProjectionBackfill(planInputs(mixed));
  assert.deepEqual([plan.targetHours, plan.v3Hours, plan.v4Hours, plan.skipped], [5, 4, 4, { alreadyAvailable: 3, familyUnavailable: 1 }]);
  const old = planHours(2, { start: hours[0].hourStart - 900 * 3600 });
  const retained = planProjectionBackfill(planInputs([...old, ...hours]));
  assert.equal(retained.targetHours, 6, 'hours older than 35 days are never backfilled');
  assert.deepEqual(planProjectionBackfill(planInputs(hours, { v3Coverage: null })).blockers, ['v3_registry_behind']);
});

await test('V4 registry plan: bootstrap from the candidate in 10,000-block Initialize-only requests, catch-up, upper bound', async () => {
  const inputs = { hours: [], v4Coverage: null, v4Pools: 0, checkpoint: { lastBlock: 24_117_363 } };
  const bootstrap = planV4Registry(inputs, { fromBlock: 1_948_019 });
  assert.deepEqual([bootstrap.mode, bootstrap.method, bootstrap.target, bootstrap.requests, bootstrap.durationSeconds], ['bootstrap', 'operator_supplied',
    24_117_363, 2217 + 1 + 1 + 1, 2220], 'chunks + deployment proof + end header + chain id');
  assert.deepEqual([bootstrap.upperBoundFromGenesis, bootstrap.probeRequests], [2412 + 1 + 1, 27]);
  const unknown = planV4Registry(inputs);
  assert.deepEqual([unknown.method, unknown.requests, unknown.candidate], ['unknown', null, null]);
  const probed = planV4Registry(inputs, { deployment: { block: 2_000_000, requests: 26, method: 'eth_getCode_binary_search' } });
  assert.deepEqual([probed.candidate, probed.method, probed.probeRequests, probed.requests], [2_000_000, 'eth_getCode_binary_search', 26,
    Math.ceil((24_117_363 - 2_000_000 + 1) / 10_000) + 3]);
  const catchup = planV4Registry({ ...inputs, v4Coverage: { fromBlock: 2_000_000, through: 24_100_000, throughHash: 'x' } });
  assert.deepEqual([catchup.mode, catchup.fromBlock, catchup.requests], ['catchup', 24_100_001, 2 + 1 + 1 + 1]);
  assert.equal(planV4Registry({ ...inputs, v4Coverage: { fromBlock: 1, through: 24_117_363, throughHash: 'x' } }).mode, 'covered');
  assert.equal(planV4Registry({ ...inputs, checkpoint: null }).mode, 'blocked');
});

// ---------------------------------------------------------------------------------------------------------------------
// V4 pool registry tooling on the synthetic chain (never run against mainnet here).

const DEPLOYED = ORIGIN.originNumber + 1234;
await test('V4 registry bootstrap: Initialize-only scan, every poolId self-verified, start proven before the deployment', async () => {
  const chain = chainOf({ poolManagerDeployedAt: DEPLOYED });
  const provider = offlineProvider(chain.fetchImpl);
  const scan = await bootstrapV4Registry(provider, { fromBlock: DEPLOYED, toBlock: ORIGIN.originNumber + 25_000 });
  const expected = [];
  for (let number = DEPLOYED; number <= ORIGIN.originNumber + 25_000; number++) if (number % 3001 === 0) expected.push(number);
  assert.deepEqual(scan.created.map((pool) => pool.createdBlock), expected);
  assert(scan.created.every((pool) => validV4Record(pool) && pool.poolId === v4PoolIdOf(syntheticV4PoolKey(pool.createdBlock))));
  assert.deepEqual([scan.kind, scan.previousThrough, scan.through, scan.throughHash], ['uniswap_v4_pool', null, ORIGIN.originNumber + 25_000,
    chain.blockHash(ORIGIN.originNumber + 25_000)]);
  assert.equal(provider.stats.requests, v4RegistryScanRequests(DEPLOYED, ORIGIN.originNumber + 25_000) + 1, 'scan + chain id, nothing else');
  await rejectsWith(bootstrapV4Registry(offlineProvider(chain.fetchImpl), { fromBlock: DEPLOYED + 1, toBlock: DEPLOYED + 10 }),
    'registry_start_after_pool_manager_deployment');
  await rejectsWith(bootstrapV4Registry(offlineProvider(chainOf({ poolManagerDeployedAt: DEPLOYED, faults: { logs: corruptInitialize } }).fetchImpl),
    { fromBlock: DEPLOYED, toBlock: DEPLOYED + 5000 }), 'v4_pool_id_mismatch');
  const head = await bootstrapV4Registry(offlineProvider(chain.fetchImpl), { fromBlock: DEPLOYED, toBlock: DEPLOYED + 3000 });
  const next = await catchUpV4Registry(offlineProvider(chain.fetchImpl), head, ORIGIN.originNumber + 25_000);
  assert.deepEqual([next.previousThrough, next.fromBlock, [...head.created, ...next.created].map((pool) => pool.createdBlock)], [DEPLOYED + 3000, DEPLOYED,
    expected]);
  await rejectsWith(catchUpV4Registry(offlineProvider(chain.fetchImpl), { ...head, throughHash: `0x${'00'.repeat(32)}` }, DEPLOYED + 9000), 'v4_registry_fork');
});

await test('V4 deployment block: eth_getCode binary search, exact and bounded, refusing to guess', async () => {
  const provider = offlineProvider(chainOf({ poolManagerDeployedAt: DEPLOYED }).fetchImpl);
  const found = await locateDeploymentBlock(provider, PM, { low: ORIGIN.originNumber, high: ORIGIN.originNumber + 20_000 });
  assert.deepEqual([found.block, found.method], [DEPLOYED, 'eth_getCode_binary_search']);
  assert(found.requests <= Math.ceil(Math.log2(20_000)) + 2);
  await rejectsWith(locateDeploymentBlock(provider, PM, { low: DEPLOYED, high: DEPLOYED + 10 }), 'deployment_at_or_before_low');
  await rejectsWith(locateDeploymentBlock(provider, PM, { low: ORIGIN.originNumber, high: DEPLOYED - 1 }), 'deployment_not_found');
});

await test('backfill CLI: dry run by default; writes need an execute flag and COMPACT_PROJECTION_EXECUTE=yes; one mode per run', async () => {
  const env = { COMPACT_SQLITE_PATH: '/data/arc-compact.sqlite' };
  assert.deepEqual(backfillConfig({ argv: [], env }), { sqlitePath: '/data/arc-compact.sqlite', minIntervalMs: 1000, fromBlock: null,
    probeDeployment: false, mode: 'dry_run' });
  assert.equal(backfillConfig({ argv: ['--probe-deployment', '--v4-from-block=1948019'], env }).mode, 'dry_run');
  const refused = (argv, environment, code) => assert.throws(() => backfillConfig({ argv, env: environment }), (error) => error.code === code, code);
  refused(['--execute-backfill'], env, 'execute_confirmation_required');
  refused(['--execute-v4-registry'], { ...env, COMPACT_PROJECTION_EXECUTE: '1' }, 'execute_confirmation_required');
  refused(['--execute-backfill', '--execute-v4-registry'], { ...env, COMPACT_PROJECTION_EXECUTE: 'yes' }, 'one_execute_mode_per_run');
  refused(['--execute-backfill', '--probe-deployment'], { ...env, COMPACT_PROJECTION_EXECUTE: 'yes' }, 'probe_is_dry_run_only');
  refused(['--execute'], env, 'unknown_argument');
  refused(['--v4-from-block=abc'], env, 'invalid_v4_from_block');
  refused([], { ...env, COMPACT_RPC_MIN_INTERVAL_MS: '100' }, 'unsafe_rpc_pacing');
  refused([], {}, 'sqlite_path_required');
  assert.equal(backfillConfig({ argv: ['--execute-backfill'], env: { ...env, COMPACT_PROJECTION_EXECUTE: 'yes' } }).mode, 'execute_backfill');
});

// ---------------------------------------------------------------------------------------------------------------------
// SQLite store (built-in node:sqlite, Node 22.13+). Temporary files only, deleted at the end.

// ---------------------------------------------------------------------------------------------------------------------
// Projection-only self-heal (Phase 1A.1): the repair rule, the single-hour plan, the streams it fetches, the strict child.

const AVAILABLE_FAMILIES = { uniswapV3: 'available', uniswapV4: 'available' };
const REPAIR_COVERAGE = { uniswap_v3_pools: { through: 1999 }, uniswap_v4_pools: { through: 999 } };
const repairState = (projections, families = AVAILABLE_FAMILIES, coverage = REPAIR_COVERAGE) => projectionRepairState({ families, projections,
  firstBlock: 1000, lastBlock: 1999, coverage });
const ELIGIBLE = (state) => ({ state, repair: 'eligible', blocker: null });
const NONE = (state) => ({ state, repair: 'none', blocker: null });
const LIVE_ONLY = (state) => ({ state, repair: 'none', blocker: null, reason: 'live_only' });

await test('repair rule: a missing or unavailable pool projection with an available family is eligible; nothing else is', async () => {
  assert.deepEqual(repairState({ uniswap_v3_pools: 'available', uniswap_v4_pools: 'available', dex_activity: 'available' }),
    { uniswap_v3_pools: NONE('available'), uniswap_v4_pools: NONE('available'), dex_activity: NONE('available') }, 'available is never a candidate');
  assert.deepEqual(repairState({}), { uniswap_v3_pools: ELIGIBLE('missing'), uniswap_v4_pools: ELIGIBLE('missing'), dex_activity: LIVE_ONLY('missing') },
    'missing is a candidate');
  assert.deepEqual(repairState({ uniswap_v3_pools: 'unavailable', uniswap_v4_pools: 'unavailable', dex_activity: 'unavailable' }),
    { uniswap_v3_pools: ELIGIBLE('unavailable'), uniswap_v4_pools: ELIGIBLE('unavailable'), dex_activity: LIVE_ONLY('unavailable') }, 'unavailable is a candidate');
  assert.deepEqual(repairState({ uniswap_v3_pools: 'unavailable' }, { uniswapV3: 'unavailable', uniswapV4: null }),
    { uniswap_v3_pools: NONE('family_unavailable'), uniswap_v4_pools: NONE('family_unavailable'), dex_activity: LIVE_ONLY('missing') },
    'a projection whose family is unavailable (or not stored) is never retried');
  const activityOnly = repairState({ uniswap_v3_pools: 'available', uniswap_v4_pools: 'available' });
  assert.deepEqual([activityOnly.uniswap_v3_pools.repair, activityOnly.uniswap_v4_pools.repair, activityOnly.dex_activity], ['none', 'none',
    LIVE_ONLY('missing')], 'missing historical activity alone is never a candidate');
});

await test('repair rule: a registry that is missing or behind blocks the repair; it is never bootstrapped', async () => {
  const blocked = (coverage) => { const out = repairState({}, AVAILABLE_FAMILIES, coverage); return [out.uniswap_v3_pools, out.uniswap_v4_pools]; };
  assert.deepEqual(blocked({ uniswap_v3_pools: null, uniswap_v4_pools: null }), [{ state: 'missing', repair: 'blocked', blocker: 'v3_registry_missing' },
    { state: 'missing', repair: 'blocked', blocker: 'v4_registry_missing' }]);
  assert.deepEqual(blocked({ uniswap_v3_pools: { through: 1998 }, uniswap_v4_pools: { through: 998 } }).map((entry) => entry.blocker),
    ['v3_registry_behind', 'v4_registry_behind']);
  assert.deepEqual(blocked({ uniswap_v3_pools: { through: 1999 }, uniswap_v4_pools: { through: 999 } }).map((entry) => entry.repair), ['eligible', 'eligible'],
    'V3 through the last block, V4 through the block before the hour');
  assert.deepEqual(blocked({ uniswap_v3_pools: { through: 9000 }, uniswap_v4_pools: { through: 9000 } }).map((entry) => entry.repair), ['eligible', 'eligible']);
});

await test('single-hour repair plan: only the needed projections, inside pool-hour retention, never activity', async () => {
  const hour = (projections, families = { uniswapV3: { status: 'available' }, uniswapV4: { status: 'available' } }) => ({ hourStart: HOUR,
    firstBlock: 1000, lastBlock: 1999, families, projections });
  const input = (h, newestHour = HOUR) => ({ hour: h, newestHour, v3Coverage: { through: 1999 }, v4Coverage: { through: 999 } });
  assert.deepEqual(planProjectionRepair({ ...input(null) }).reason, 'hour_missing');
  assert.equal(planProjectionRepair(input(hour({}), HOUR + POOL_HOUR_RETENTION_HOURS * 3600)).reason, 'outside_retention');
  assert.deepEqual(planProjectionRepair(input(hour({}), HOUR + (POOL_HOUR_RETENTION_HOURS - 1) * 3600)).needs,
    { uniswap_v3_pools: true, uniswap_v4_pools: true });
  assert.deepEqual(planProjectionRepair(input(hour({ uniswap_v4_pools: 'available' }))).needs, { uniswap_v3_pools: true }, 'only V3');
  assert.deepEqual(planProjectionRepair(input(hour({ uniswap_v3_pools: 'available', dex_activity: 'unavailable' }))).needs, { uniswap_v4_pools: true },
    'only V4; activity is never a need');
  const behind = planProjectionRepair({ ...input(hour({ uniswap_v3_pools: 'available' })), v4Coverage: { through: 500 } });
  assert.deepEqual([behind.needs, behind.blocked], [{}, { uniswap_v4_pools: 'v4_registry_behind' }]);
});

async function recordedRepairStreams(needs) {
  const chain = chainOf();
  const filters = [];
  const provider = offlineProvider(async (url, init) => {
    for (const item of [].concat(JSON.parse(init.body))) if (item.method === 'eth_getLogs') filters.push(item.params[0]);
    return chain.fetchImpl(url, init);
  });
  const out = await backfillProjectionHour({ provider, hour: liveHourInput(needs), v3Pools: V3.pools });
  return { out, filters, calls: provider.stats.calls };
}
const chunks = Math.ceil((LIVE.range.lastBlock - LIVE.range.firstBlock + 1) / 500);

await test('single-hour repair fetches only v3Pools when only V3 is needed', async () => {
  const { out, filters, calls } = await recordedRepairStreams({ uniswap_v3_pools: true });
  assert.deepEqual(out.uniswap_v3_pools, LIVE.projections.uniswap_v3_pools);
  assert.deepEqual(calls, { eth_chainId: 1, eth_getLogs: chunks });
  assert(filters.every((filter) => filter.address === undefined && JSON.stringify(filter.topics) === JSON.stringify([[T.v3Swap, T.v3Mint, T.v3Burn]])));
  assert(filters.every((filter) => Number(BigInt(filter.toBlock)) - Number(BigInt(filter.fromBlock)) < 500), '500-block ranges');
});

await test('single-hour repair fetches only v4 when only V4 is needed', async () => {
  const { out, filters, calls } = await recordedRepairStreams({ uniswap_v4_pools: true });
  assert.deepEqual(out.uniswap_v4_pools, LIVE.projections.uniswap_v4_pools);
  assert.deepEqual(calls, { eth_chainId: 1, eth_getLogs: chunks });
  assert(filters.every((filter) => JSON.stringify(filter.address) === JSON.stringify([PM])
    && JSON.stringify(filter.topics) === JSON.stringify([[T.v4Initialize, T.v4Swap, T.v4ModifyLiquidity]])));
});

await test('repair child: strict arguments (exactly one UTC hour, no flags, no bulk mode); never processHour, the spine or receipts', async () => {
  const env = { COMPACT_SQLITE_PATH: '/data/arc-compact.sqlite' };
  assert.deepEqual(repairConfig({ argv: ['2026-10-01T07:00:00.000Z'], env }), { hourStart: Date.parse('2026-10-01T07:00:00.000Z') / 1000,
    sqlitePath: '/data/arc-compact.sqlite', minIntervalMs: 1000 });
  const refused = (argv, environment, code) => assert.throws(() => repairConfig({ argv, env: environment }), (error) => error.code === code, code);
  refused([], env, 'exactly_one_hour_required');
  refused(['2026-10-01T07:00:00.000Z', '2026-10-01T08:00:00.000Z'], env, 'exactly_one_hour_required');
  refused(['--execute-backfill'], env, 'invalid_hour');
  refused(['2026-10-01T07:00:00Z'], env, 'invalid_hour');
  refused(['2026-10-01T07:30:00.000Z'], env, 'invalid_hour');
  refused(['2026-10-01T07:00:00.000Z'], {}, 'sqlite_path_required');
  refused(['2026-10-01T07:00:00.000Z'], { ...env, COMPACT_RPC_MIN_INTERVAL_MS: '100' }, 'unsafe_rpc_pacing');
  const script = fileURLToPath(new URL('./repair-compact-projection-hour.mjs', import.meta.url));
  for (const [argv, expected] of [[[], 'RESULT FAIL exactly_one_hour_required'], [['--all'], 'RESULT FAIL invalid_hour']]) {
    const run = spawnSync(process.execPath, [script, ...argv], { env: { PATH: process.env.PATH, ...env }, encoding: 'utf8', timeout: 20_000 });
    assert.deepEqual([run.status, run.stdout.trim()], [1, expected], run.stderr);
  }
  const repairSource = await readFile(new URL('./repair-compact-projection-hour.mjs', import.meta.url), 'utf8');
  const backfillSource = await readFile(new URL('../server/compact/projection-backfill.js', import.meta.url), 'utf8');
  for (const text of [repairSource, backfillSource]) {
    assert.doesNotMatch(text, /processHour\(|processBlockRange\(|spineWindows|hour\.js'|eth_getTransactionReceipt|eth_getBlockReceipts|\[hex\([^)]*\), true\]/);
  }
  assert.doesNotMatch(repairSource, /--execute|COMPACT_PROJECTION_EXECUTE|readBackfillInputs|runProjectionBackfill|bootstrapV4Registry|catchUpV4Registry/);
  assert.match(repairSource, /commitProjectionHour\(hourStart, projections, \{ only: summary\.needs \}\)/, 'writes only the rebuilt projections');
});

const sqlite = await import('node:sqlite').catch(() => null);
if (!sqlite) {
  assert.notEqual(process.env.COMPACT_REQUIRE_SQLITE, '1', `node:sqlite is required but unavailable on Node ${process.version}`);
  console.log(`DEFERRED sqlite projection tests: node:sqlite is unavailable on Node ${process.version}; run this file on Node 22.13+ `
    + '(e.g. the Node 24 Railway image) with COMPACT_REQUIRE_SQLITE=1 to execute them');
} else {
  const directory = await mkdtemp(join(process.env.COMPACT_SQLITE_DIR || tmpdir(), 'compact-projections-'));
  const open = (name) => new sqlite.DatabaseSync(join(directory, name));
  const count = (db, table, where = '') => db.prepare(`SELECT COUNT(*) AS count FROM ${table} ${where}`).get().count;
  const tables = (db) => db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table', 'view') ORDER BY name").all().map((row) => row.name);
  const familyState = (db) => db.prepare('SELECT hour_start, family, status, metrics_sha256 FROM compact_family_hours ORDER BY hour_start, family').all()
    .map((row) => `${row.hour_start}:${row.family}:${row.status}:${row.metrics_sha256}`);
  const hourState = (db) => ({ hours: db.prepare('SELECT hour_start, network_sha256 FROM compact_hours ORDER BY hour_start').all().map((row) => `${row.hour_start}:${row.network_sha256}`),
    families: familyState(db), addresses: count(db, 'compact_hour_addresses'), checkpoint: db.prepare('SELECT * FROM compact_checkpoint').all().map((row) => ({ ...row })) });
  const statusOf = (store, hour) => Object.fromEntries(store.projectionStatus(hour).map((row) => [row.projection, row.status === 'available' ? 'available'
    : `unavailable(${row.reason})`]));
  const clone = (value) => structuredClone(value);
  const unhashed = (result, mutate) => {
    const copy = clone(result);
    mutate(copy.projections);
    for (const name of PROJECTIONS) delete copy.projections[name]?.rowsSha256;
    return copy;
  };
  const sortActivity = (rows) => [...rows].map(({ hourStart, ...row }) => ({ hourStart, ...row })).sort(activityOrder);

  // Contiguous fake hours (10 blocks each) whose projections reconcile with their families.
  const FAKE_BASE = HOUR + 1000 * 3600;
  const fakeHash = (n) => `0x${n.toString(16).padStart(64, '0')}`;
  function fakeHour(i, { swaps = 0, registry = [] } = {}) {
    const hourStart = FAKE_BASE + i * 3600;
    const firstBlock = 1_000_000 + i * 10;
    const lastBlock = firstBlock + 9;
    const families = clone(LIVE.families);
    Object.assign(families.uniswapV3, { swapCount: 1, mintCount: 1, burnCount: 1 });
    Object.assign(families.uniswapV4, { swapCount: 1 + swaps, modifyLiquidityCount: 0, initializeCount: registry.length });
    const activity = Array.from({ length: swaps }, (_, k) => ({ blockNumber: firstBlock + Math.floor(k / 40), logIndex: k % 40, hourStart,
      blockTimestamp: hourStart + Math.floor(k / 40), txHash: fakeHash(0x7a000000 + i * 1000 + k), txFrom: addressOf('f0', k + 1), protocol: 'uniswap_v4',
      kind: 'swap', pool: P1, amount0Raw: '-1', amount1Raw: '1', amountBasis: 'v4_swap_delta', counterparty: null, counterpartyKind: 'none' }));
    return { definitionVersion: COMPACT_DEFINITION_VERSION, chainId: ARC_CHAIN_ID,
      range: { kind: 'hour', hourStart, hourEnd: hourStart + 3600, startUtc: new Date(hourStart * 1000).toISOString(),
        endUtc: new Date((hourStart + 3600) * 1000).toISOString(), firstBlock, lastBlock, parentHash: fakeHash(firstBlock - 1), firstHash: fakeHash(firstBlock),
        lastHash: fakeHash(lastBlock), firstTimestamp: hourStart, lastTimestamp: hourStart + 9 },
      network: { ...LIVE.network, blockCount: 10, uniqueActiveAddresses: 1 }, families, complete: true, activeAddresses: [addressOf('ad', i + 1)],
      registry: { uniswapV3: { through: lastBlock, throughHash: fakeHash(lastBlock), created: [] } },
      projections: {
        uniswap_v3_pools: { status: 'available', rows: [{ pool: V3_POOL, swapCount: 1, token0InRaw: '5', token0OutRaw: '0', token1InRaw: '0',
          token1OutRaw: '4', addCount: 1, removeCount: 0, pokeCount: 1, addAmount0Raw: '1', addAmount1Raw: '2', removeAmount0Raw: '0', removeAmount1Raw: '0' }] },
        uniswap_v4_pools: { status: 'available', rows: [{ pool: P1, swapCount: 1 + swaps, token0InRaw: String(1 + swaps), token0OutRaw: '0',
          token1InRaw: '0', token1OutRaw: String(1 + swaps), addCount: 0, removeCount: 0, pokeCount: 0, ...V4_NULL_LIQUIDITY }], registry },
        dex_activity: { status: 'available', rows: activity },
      } };
  }
  const TABLES = ['compact_checkpoint', 'compact_dex_activity', 'compact_family_hours', 'compact_hour_addresses', 'compact_hours', 'compact_meta',
    'compact_pool_hours', 'compact_projection_hours', 'compact_registry', 'compact_registry_coverage'];
  try {
    await test('sqlite: additive projection tables, activity index and projection_version meta rows; a changed version is refused', async () => {
      const db = open('schema.sqlite');
      createCompactStore(db);
      assert.deepEqual(tables(db), TABLES);
      assert(db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'compact_dex_activity_kind'").get());
      const meta = new Map(db.prepare('SELECT key, value FROM compact_meta').all().map((row) => [row.key, row.value]));
      for (const [name, version] of Object.entries(PROJECTION_VERSIONS)) assert.equal(meta.get(`projection_version:${name}`), version);
      assert.deepEqual([...meta.keys()].filter((key) => key.startsWith('family_version:')).map((key) => key.slice(15)).sort(), Object.keys(FAMILY_VERSIONS).sort());
      db.exec("UPDATE compact_meta SET value = 'other' WHERE key = 'projection_version:dex_activity'");
      db.close();
      assert.throws(() => createCompactStore(open('schema.sqlite')), (error) => error.code === 'projection_definition_mismatch');
    });

    await test('sqlite: the live hour commits its projections in the same transaction: pool rows, activity and V4 registry', async () => {
      const db = open('live.sqlite');
      const store = createCompactStore(db);
      const committed = store.commitHour(LIVE);
      assert.deepEqual([committed.outcome, committed.projections], ['inserted', { uniswap_v3_pools: 'inserted', uniswap_v4_pools: 'inserted', dex_activity: 'inserted' }]);
      assert.deepEqual(store.projectionStatus(HOUR).map((row) => [row.projection, row.status, row.rowCount, row.rowsSha256]), [
        ['dex_activity', 'available', LIVE.projections.dex_activity.rows.length, LIVE.projections.dex_activity.rowsSha256],
        ['uniswap_v3_pools', 'available', LIVE.projections.uniswap_v3_pools.rows.length, LIVE.projections.uniswap_v3_pools.rowsSha256],
        ['uniswap_v4_pools', 'available', LIVE.projections.uniswap_v4_pools.rows.length, LIVE.projections.uniswap_v4_pools.rowsSha256]]);
      assert.deepEqual(store.poolHours(HOUR, 'uniswap_v3'), LIVE.projections.uniswap_v3_pools.rows);
      assert.deepEqual(store.poolHours(HOUR, 'uniswap_v4'), LIVE.projections.uniswap_v4_pools.rows);
      assert.deepEqual(sortActivity(store.recentActivity()), sortActivity(LIVE.projections.dex_activity.rows));
      assert.deepEqual(store.v4Registry(), { coverage: null, pools: 3 });
      for (const record of LIVE.projections.uniswap_v4_pools.registry) assert.deepEqual(store.v4Pool(record.poolId), record);
      // The same transaction: a crash before COMMIT leaves neither the hour nor any projection row.
      const crash = open('crash.sqlite');
      const crashStore = createCompactStore(crash);
      assert.throws(() => crashStore.commitHour(LIVE, { beforeCommit: () => { throw new Error('crash'); } }), /crash/);
      assert.deepEqual(['compact_hours', 'compact_pool_hours', 'compact_dex_activity', 'compact_projection_hours', 'compact_registry'].map((table) => count(crash, table)),
        [0, 0, 0, 0, 0]);
      crash.close();
      db.close();
    });

    await test('sqlite: same-hour replay is idempotent: unchanged, no duplicate pool or activity row', async () => {
      const db = open('live.sqlite');
      const store = createCompactStore(db);
      const before = ['compact_pool_hours', 'compact_dex_activity', 'compact_projection_hours', 'compact_registry'].map((table) => count(db, table));
      const again = store.commitHour(LIVE);
      assert.deepEqual([again.outcome, again.projections], ['unchanged', { uniswap_v3_pools: 'unchanged', uniswap_v4_pools: 'unchanged', dex_activity: 'unchanged' }]);
      assert.deepEqual(['compact_pool_hours', 'compact_dex_activity', 'compact_projection_hours', 'compact_registry'].map((table) => count(db, table)), before);
      const [row] = store.recentActivity('swap', 1);
      assert.throws(() => db.prepare(`INSERT INTO compact_dex_activity (block_number, log_index, hour_start, block_timestamp, tx_hash, tx_from, protocol,
        kind, pool, amount0_raw, amount1_raw, amount_basis, counterparty, counterparty_kind) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(BigInt(row.blockNumber), BigInt(row.logIndex), BigInt(HOUR), BigInt(row.blockTimestamp), row.txHash, row.txFrom, row.protocol, row.kind, row.pool,
          row.amount0Raw, row.amount1Raw, row.amountBasis, row.counterparty, row.counterpartyKind), /UNIQUE|PRIMARY/i, 'one row per (block, log index)');
      db.close();
    });

    await test('sqlite: store-side reconciliation: a mismatching or duplicated projection is stored unavailable, the hour still commits', async () => {
      const clean = open('clean.sqlite');
      createCompactStore(clean).commitHour(LIVE);
      const db = open('mismatch.sqlite');
      const store = createCompactStore(db);
      const tampered = unhashed(LIVE, (projections) => { projections.uniswap_v3_pools.rows[0].swapCount += 1; });
      assert.equal(store.commitHour(tampered).outcome, 'inserted');
      assert.deepEqual(statusOf(store, HOUR), { dex_activity: 'unavailable(projection_inputs_unavailable)',
        uniswap_v3_pools: 'unavailable(reconciliation_mismatch)', uniswap_v4_pools: 'available' });
      assert.deepEqual([store.poolHours(HOUR, 'uniswap_v3'), count(db, 'compact_dex_activity')], [[], 0], 'nothing partial');
      assert.deepEqual(hourState(db), hourState(clean), 'hour, families, addresses and checkpoint identical to a clean commit');
      const duplicate = open('duplicate.sqlite');
      const duplicateStore = createCompactStore(duplicate);
      duplicateStore.commitHour(unhashed(LIVE, (projections) => { projections.dex_activity.rows[1] = { ...projections.dex_activity.rows[0] }; }));
      assert.equal(statusOf(duplicateStore, HOUR).dex_activity, 'unavailable(projection_error)');
      duplicate.close();
      clean.close();
      db.close();
    });

    await test('sqlite: projection failure does not corrupt family data; a later valid replay upgrades it; a different one is a conflict', async () => {
      const clean = open('clean.sqlite');
      const db = open('upgrade.sqlite');
      const store = createCompactStore(db);
      const garbage = { ...LIVE, projections: { uniswap_v3_pools: 'garbage', uniswap_v4_pools: { status: 'available', rows: 'x' }, dex_activity: null } };
      assert.equal(store.commitHour(garbage).outcome, 'inserted');
      assert.deepEqual(hourState(db), hourState(clean));
      assert.deepEqual(statusOf(store, HOUR), { dex_activity: 'unavailable(projection_error)', uniswap_v3_pools: 'unavailable(projection_error)',
        uniswap_v4_pools: 'unavailable(projection_error)' });
      const upgraded = store.commitHour(LIVE);
      assert.deepEqual([upgraded.outcome, upgraded.projections], ['unchanged', { uniswap_v3_pools: 'upgraded', uniswap_v4_pools: 'upgraded', dex_activity: 'upgraded' }]);
      assert.deepEqual(store.poolHours(HOUR, 'uniswap_v3'), LIVE.projections.uniswap_v3_pools.rows);
      const different = unhashed(LIVE, (projections) => { projections.uniswap_v3_pools.rows[0].token0InRaw = '1'; });
      assert.deepEqual(store.commitHour(different).projections.uniswap_v3_pools, 'conflict');
      assert.deepEqual(store.poolHours(HOUR, 'uniswap_v3'), LIVE.projections.uniswap_v3_pools.rows, 'an available projection is never replaced');
      clean.close();
      db.close();
    });

    await test('sqlite: 35-day pool-hour retention, pruned in the commit transaction; hours themselves are kept', async () => {
      const db = open('retention.sqlite');
      const store = createCompactStore(db);
      const total = POOL_HOUR_RETENTION_HOURS + 2;
      for (let i = 0; i < total; i++) assert.deepEqual(store.commitHour(fakeHour(i)).projections.uniswap_v4_pools, 'inserted');
      assert.equal(count(db, 'compact_hours'), total);
      assert.equal(db.prepare('SELECT COUNT(DISTINCT hour_start) AS count FROM compact_pool_hours').get().count, POOL_HOUR_RETENTION_HOURS);
      assert.equal(db.prepare('SELECT MIN(hour_start) AS hour FROM compact_pool_hours').get().hour, FAKE_BASE + 2 * 3600);
      assert.equal(count(db, 'compact_projection_hours'), POOL_HOUR_RETENTION_HOURS * PROJECTIONS.length);
      db.close();
    });

    await test('sqlite: recent activity keeps the newest 500 rows per kind across hours', async () => {
      const db = open('activity.sqlite');
      const store = createCompactStore(db);
      const first = fakeHour(0, { swaps: 300 });
      const second = fakeHour(1, { swaps: 300 });
      store.commitHour(first);
      store.commitHour(second);
      assert.equal(count(db, 'compact_dex_activity', "WHERE kind = 'swap'"), ACTIVITY_ROWS_PER_KIND);
      const expected = [...second.projections.dex_activity.rows, ...first.projections.dex_activity.rows].sort(activityOrder).slice(0, ACTIVITY_ROWS_PER_KIND);
      assert.deepEqual(store.recentActivity('swap').map((row) => [row.blockNumber, row.logIndex]), expected.map((row) => [row.blockNumber, row.logIndex]));
      db.close();
    });

    await test('sqlite: a poolId already stored with another creation log makes that hour\'s V4 projection unavailable, not the hour', async () => {
      const db = open('v4conflict.sqlite');
      const store = createCompactStore(db);
      const key = syntheticV4PoolKey(3001 * 7665);
      const record = (i) => ({ poolId: v4PoolIdOf(key), createdBlock: 1_000_000 + i * 10, createdLogIndex: 0, createdTx: fakeHash(0xabc0 + i), ...key });
      assert.equal(store.commitHour(fakeHour(0, { registry: [record(0)] })).projections.uniswap_v4_pools, 'inserted');
      const second = store.commitHour(fakeHour(1, { registry: [record(1)] }));
      assert.deepEqual([second.outcome, second.projections.uniswap_v4_pools, second.projections.dex_activity], ['inserted', 'unavailable', 'unavailable']);
      assert.deepEqual(statusOf(store, FAKE_BASE + 3600).uniswap_v4_pools, 'unavailable(duplicate_v4_initialize)');
      assert.deepEqual(store.v4Pool(v4PoolIdOf(key)).createdBlock, 1_000_000);
      db.close();
    });

    await test('sqlite: the V4 registry bootstrap is stored with explicit coverage; a live hour extends it only when contiguous', async () => {
      const db = open('v4registry.sqlite');
      const store = createCompactStore(db);
      const chain = chainOf({ poolManagerDeployedAt: ORIGIN.originNumber });
      const scan = await bootstrapV4Registry(offlineProvider(chain.fetchImpl), { fromBlock: ORIGIN.originNumber, toBlock: LIVE.range.firstBlock - 1 });
      assert.deepEqual(store.extendV4Registry(scan), { fromBlock: ORIGIN.originNumber, through: LIVE.range.firstBlock - 1, throughHash: LIVE.range.parentHash });
      assert.throws(() => store.extendV4Registry(scan), (error) => error.code === 'registry_discontinuity');
      store.commitHour(LIVE);
      assert.deepEqual(store.v4Registry(), { coverage: { fromBlock: ORIGIN.originNumber, through: LIVE.range.lastBlock, throughHash: LIVE.range.lastHash },
        pools: 3 });
      const fresh = createCompactStore(open('v4invalid.sqlite'));
      const bad = { ...scan, created: [{ ...LIVE.projections.uniswap_v4_pools.registry[0], fee: 3000 }] };
      assert.throws(() => fresh.extendV4Registry(bad), (error) => error.code === 'registry_record_invalid');
      db.close();
    });

    await test('sqlite: projection-only backfill of a stored hour: only two log streams, reconciled with stored families, hour untouched', async () => {
      const path = 'backfill.sqlite';
      const db = open(path);
      const store = createCompactStore(db);
      store.extendRegistry(await bootstrapV3Registry(offlineProvider(chainOf().fetchImpl), { fromBlock: ORIGIN.originNumber, toBlock: LIVE.range.firstBlock - 1 }));
      const stored = (await liveHour({}, { projections: false })).result;
      store.commitHour(stored);
      assert.deepEqual(store.projectionStatus(HOUR), [], 'stored before projections existed');
      const before = hourState(db);
      // Dry run through the CLI entry point: read-only, no provider ever created, nothing written.
      const lines = [];
      const versionBefore = db.prepare('PRAGMA data_version').get().data_version;
      const summary = await runBackfillTool({ config: { sqlitePath: join(directory, path), minIntervalMs: 1000, fromBlock: null, probeDeployment: false,
        mode: 'dry_run' }, DatabaseSync: sqlite.DatabaseSync, providerFactory: () => { throw new Error('a dry run must not touch the network'); },
      print: (line) => lines.push(line) });
      assert.equal(db.prepare('PRAGMA data_version').get().data_version, versionBefore, 'no other connection committed');
      assert.equal(lines.at(-1), 'RESULT DRY_RUN writes=0 rpc_requests=0');
      assert.deepEqual([summary.plan.targetHours, summary.plan.v3Requests, summary.plan.v4Requests, summary.plan.boundaryRequests], [1, 15, 15, 1]);
      // Execute (in-process, offline provider): one hour, reconciled against the stored family counters.
      const inputs = readBackfillInputs(db);
      const plan = planProjectionBackfill(inputs);
      const provider = offlineProvider(chainOf().fetchImpl);
      const report = await runProjectionBackfill({ store, provider, plan, v3Pools: store.v3Registry().pools });
      assert.deepEqual([report.committed, report.skipped], [1, []]);
      assert.equal(provider.stats.requests, plan.totalRequests, 'exactly the planned requests');
      assert.deepEqual(statusOf(store, HOUR), { dex_activity: 'unavailable(projection_inputs_unavailable)', uniswap_v3_pools: 'available',
        uniswap_v4_pools: 'available' });
      assert.deepEqual(store.poolHours(HOUR, 'uniswap_v3'), LIVE.projections.uniswap_v3_pools.rows);
      assert.deepEqual(store.poolHours(HOUR, 'uniswap_v4'), LIVE.projections.uniswap_v4_pools.rows);
      assert.deepEqual(hourState(db), before, 'hours, families, addresses and checkpoint untouched');
      assert.equal(planProjectionBackfill(readBackfillInputs(db)).targetHours, 0, 'a second run has nothing to do');
      assert.throws(() => store.commitProjectionHour(HOUR + 3600, LIVE.projections), (error) => error.code === 'hour_missing');
      db.close();
    });

    await test('sqlite: the runner reports projection status; projections never fail the run or trigger a repair', async () => {
      const lines = [];
      const summary = await runCompactHour({ sqlitePath: join(directory, 'runner.sqlite'), hourStart: HOUR,
        provider: offlineProvider(chainOf({ faults: { logs: corruptInitialize } }).fetchImpl), registryFromBlock: ORIGIN.originNumber, print: (line) => lines.push(line) });
      assert.equal(summary.ok, true, 'a projection being unavailable is not a failed hour');
      assert.equal(summary.projections.uniswap_v4_pools, 'unavailable(v4_pool_id_mismatch)');
      assert(lines.some((line) => line.startsWith('PROJECTIONS ') && line.includes('uniswap_v3_pools=available')));
      const again = await runCompactHour({ sqlitePath: join(directory, 'runner.sqlite'), hourStart: HOUR, provider: offlineProvider(chainOf().fetchImpl),
        registryFromBlock: ORIGIN.originNumber, print: () => {} });
      assert.deepEqual([again.hourMode, again.provider.requests], ['stored', 0], 'no repair is triggered by an unavailable projection');
    });

    // -----------------------------------------------------------------------------------------------------------------
    // Projection-only self-heal (Phase 1A.1).
    const v3Down = (result) => {
      const copy = clone(result);
      copy.families.uniswapV3 = { status: 'unavailable', reason: 'v3_registry_behind', ...Object.fromEntries(FAMILY_FIELDS.uniswapV3.map((field) => [field, null])) };
      return { ...copy, complete: false, registry: { uniswapV3: null } };
    };
    const tamper = (result, name, field = 'swapCount') => {
      const copy = clone(result);
      copy.projections[name].rows[0][field] += 5;
      for (const key of PROJECTIONS) delete copy.projections[key]?.rowsSha256;
      return copy;
    };

    await test('sqlite: read model repair candidates: missing or unavailable with an available family, oldest first; blocked hours reported', async () => {
      const db = open('candidates.sqlite');
      const store = createCompactStore(db);
      store.extendRegistry({ kind: 'uniswap_v3_pool', fromBlock: 1, previousThrough: null, through: 999_999, throughHash: fakeHash(999_999), created: [] });
      store.extendV4Registry({ kind: 'uniswap_v4_pool', fromBlock: 1, previousThrough: null, through: 999_999, throughHash: fakeHash(999_999), created: [] });
      const hour4 = fakeHour(4);
      hour4.projections.dex_activity = { status: 'unavailable', reason: 'activity_spine_missing' };
      for (const result of [fakeHour(0), tamper(fakeHour(1), 'uniswap_v3_pools'), withoutProjections(fakeHour(2)), v3Down(fakeHour(3)), hour4,
        tamper(fakeHour(5), 'uniswap_v4_pools')]) store.commitHour(result);
      const hour = (i) => FAKE_BASE + i * 3600;
      const readModel = createCompactReadModel({ path: join(directory, 'candidates.sqlite'), DatabaseSync: sqlite.DatabaseSync });
      const range = { fromHour: hour(0), toHour: hour(5) };
      assert.deepEqual(readModel.projectionRepairCandidates(range), { hours: [hour(1), hour(2)],
        blocked: [{ hourStart: hour(5), projection: 'uniswap_v4_pools', reason: 'v4_registry_behind' }] });
      const states = Object.fromEntries(readModel.projectionStates(range).hours.map((entry) => [entry.hourStart, entry.projections]));
      assert.deepEqual(states[hour(0)].uniswap_v3_pools, { state: 'available', repair: 'none', blocker: null }, 'available');
      assert.deepEqual(states[hour(1)].uniswap_v3_pools, { state: 'unavailable', repair: 'eligible', blocker: null }, 'unavailable');
      assert.deepEqual([states[hour(2)].uniswap_v3_pools.state, states[hour(2)].uniswap_v4_pools.state], ['missing', 'missing'], 'missing');
      assert.deepEqual(states[hour(3)].uniswap_v3_pools, { state: 'family_unavailable', repair: 'none', blocker: null }, 'family unavailable');
      assert.deepEqual(states[hour(4)].dex_activity, { state: 'unavailable', repair: 'none', blocker: null, reason: 'live_only' }, 'activity is live-only');
      assert.deepEqual(readModel.projectionRepairCandidates({ fromHour: hour(3), toHour: hour(4) }), { hours: [], blocked: [] });
      assert.throws(() => readModel.projectionRepairCandidates({ fromHour: hour(0) + 1, toHour: hour(5) }), (error) => error.code === 'invalid_range');
      readModel.close();
      db.close();
    });

    const STORED = withoutProjections(LIVE);
    async function storedHourDb(name, { v3 = true, v4Through = LIVE.range.firstBlock - 1 } = {}) {
      const db = open(name);
      const store = createCompactStore(db);
      if (v3) store.extendRegistry(await bootstrapV3Registry(offlineProvider(chainOf().fetchImpl), { fromBlock: ORIGIN.originNumber, toBlock: LIVE.range.firstBlock - 1 }));
      if (v4Through !== null) {
        store.extendV4Registry(await bootstrapV4Registry(offlineProvider(chainOf({ poolManagerDeployedAt: ORIGIN.originNumber }).fetchImpl),
          { fromBlock: ORIGIN.originNumber, toBlock: v4Through }));
      }
      store.commitHour(STORED);
      return { db, store, path: join(directory, name) };
    }
    async function repairHour(path, { providerFactory = null } = {}) {
      const chain = chainOf();
      const record = { filters: [], batches: [], created: 0, lines: [] };
      const fetchImpl = async (url, init) => {
        const body = JSON.parse(init.body);
        if (Array.isArray(body)) record.batches.push(body.map((item) => [item.method, item.params]));
        for (const item of [].concat(body)) if (item.method === 'eth_getLogs') record.filters.push(item.params[0]);
        return chain.fetchImpl(url, init);
      };
      record.summary = await repairProjectionHour({ sqlitePath: path, hourStart: HOUR, DatabaseSync: sqlite.DatabaseSync,
        providerFactory: providerFactory ?? (() => { record.created += 1; return offlineProvider(fetchImpl); }), print: (line) => record.lines.push(line) });
      return record;
    }
    const familyJson = (db) => db.prepare('SELECT family, metrics_json FROM compact_family_hours ORDER BY family').all().map((row) => ({ ...row }));
    const onlyHeaders = (batches) => batches.every((batch) => batch.every(([method, params]) => method === 'eth_getBlockByNumber' && params[1] === false));

    await test('sqlite: projection-only repair of V3 alone: only v3Pools logs, stored hour/families/checkpoint untouched, no activity', async () => {
      const { db, store, path } = await storedHourDb('repair-v3.sqlite', { v4Through: null });
      const before = { state: hourState(db), families: familyJson(db) };
      const run = await repairHour(path);
      assert.deepEqual([run.summary.needs, run.summary.blocked, run.summary.ok], [['uniswap_v3_pools'], { uniswap_v4_pools: 'v4_registry_missing' }, false]);
      assert.equal(run.summary.reason, 'blocked:uniswap_v4_pools=v4_registry_missing', 'the V4 blocker is reported, never bootstrapped');
      assert.equal(run.filters.length, chunks);
      assert(run.filters.every((filter) => filter.address === undefined && filter.topics[0].includes(T.v3Swap)), 'v3Pools only');
      assert(onlyHeaders(run.batches) && run.batches.flat().length === 2, 'two boundary headers, never a block body or receipt');
      assert.equal(run.summary.requests, 1 + 1 + chunks, 'chain id + one boundary batch + the V3 log chunks');
      assert.deepEqual(statusOf(store, HOUR), { uniswap_v3_pools: 'available' }, 'no V4 row (blocked) and no activity row');
      assert.deepEqual(store.poolHours(HOUR, 'uniswap_v3'), LIVE.projections.uniswap_v3_pools.rows, 'reconciled to the stored V3 family counters');
      assert.equal(count(db, 'compact_dex_activity'), 0, 'historical repair never fabricates activity');
      assert.deepEqual({ state: hourState(db), families: familyJson(db) }, before, 'compact_hours, compact_family_hours and the checkpoint are untouched');
      assert.equal(store.v4Registry().coverage, null, 'no automatic V4 bootstrap');
      db.close();
    });

    await test('sqlite: projection-only repair of V4 alone: only v4 logs, registry and coverage extended, reconciled, nothing else written', async () => {
      const { db, store, path } = await storedHourDb('repair-v4.sqlite');
      store.commitProjectionHour(HOUR, LIVE.projections, { only: ['uniswap_v3_pools'] });
      const before = { state: hourState(db), families: familyJson(db) };
      const run = await repairHour(path);
      assert.deepEqual([run.summary.needs, run.summary.blocked, run.summary.ok, run.lines.at(-1)], [['uniswap_v4_pools'], {}, true, 'RESULT PASS']);
      assert.equal(run.filters.length, chunks);
      assert(run.filters.every((filter) => JSON.stringify(filter.address) === JSON.stringify([PM])), 'v4 only');
      assert.deepEqual(statusOf(store, HOUR), { uniswap_v3_pools: 'available', uniswap_v4_pools: 'available' });
      assert.deepEqual(store.poolHours(HOUR, 'uniswap_v4'), LIVE.projections.uniswap_v4_pools.rows);
      assert.deepEqual(store.v4Registry(), { coverage: { fromBlock: ORIGIN.originNumber, through: LIVE.range.lastBlock, throughHash: LIVE.range.lastHash },
        pools: 3 });
      assert.equal(count(db, 'compact_dex_activity'), 0);
      assert.deepEqual({ state: hourState(db), families: familyJson(db) }, before);
      const again = await repairHour(path);
      assert.deepEqual([again.summary.needs, again.created, again.summary.ok], [[], 0, true], 'nothing left: no provider, no request');
      db.close();
    });

    await test('sqlite: a V4 registry behind the hour blocks the V4 repair with no RPC request and no bootstrap', async () => {
      const { db, store, path } = await storedHourDb('repair-behind.sqlite', { v4Through: LIVE.range.firstBlock - 101 });
      store.commitProjectionHour(HOUR, LIVE.projections, { only: ['uniswap_v3_pools'] });
      const run = await repairHour(path, { providerFactory: () => { throw new Error('a blocked repair must not create a provider'); } });
      assert.deepEqual([run.summary.ok, run.summary.reason, run.summary.requests], [false, 'blocked:uniswap_v4_pools=v4_registry_behind', 0]);
      assert.equal(store.v4Registry().coverage.through, LIVE.range.firstBlock - 101, 'coverage untouched');
      assert.deepEqual(statusOf(store, HOUR), { uniswap_v3_pools: 'available' });
      db.close();
    });

    await test('sqlite: a repair that does not reconcile with the stored family counters stays unavailable, and stays so on retry', async () => {
      const { db, store, path } = await storedHourDb('repair-mismatch.sqlite', { v4Through: null });
      const metrics = JSON.parse(db.prepare("SELECT metrics_json FROM compact_family_hours WHERE family = 'uniswapV3'").get().metrics_json);
      db.prepare("UPDATE compact_family_hours SET metrics_json = ? WHERE family = 'uniswapV3'").run(JSON.stringify({ ...metrics, swapCount: metrics.swapCount + 1 }));
      const before = familyJson(db);
      const first = await repairHour(path);
      assert.deepEqual([first.summary.ok, first.summary.reason], [false, 'not_repaired:uniswap_v3_pools']);
      assert.deepEqual(statusOf(store, HOUR), { uniswap_v3_pools: 'unavailable(reconciliation_mismatch)' });
      assert.deepEqual(store.poolHours(HOUR, 'uniswap_v3'), [], 'nothing partial');
      const second = await repairHour(path);
      assert.deepEqual([second.summary.outcomes, statusOf(store, HOUR).uniswap_v3_pools], [{ uniswap_v3_pools: 'unchanged' },
        'unavailable(reconciliation_mismatch)']);
      assert.deepEqual(familyJson(db), before, 'the family row is never rewritten by a projection repair');
      db.close();
    });

    await test('sqlite: repairing one failed V4 hour closes the coverage gap through the later stored hours', async () => {
      const db = open('repair-chain.sqlite');
      const store = createCompactStore(db);
      store.extendRegistry(await bootstrapV3Registry(offlineProvider(chainOf().fetchImpl), { fromBlock: ORIGIN.originNumber, toBlock: LIVE.range.firstBlock - 1 }));
      store.extendV4Registry(await bootstrapV4Registry(offlineProvider(chainOf({ poolManagerDeployedAt: ORIGIN.originNumber }).fetchImpl),
        { fromBlock: ORIGIN.originNumber, toBlock: LIVE.range.firstBlock - 1 }));
      const next = await processHour({ provider: offlineProvider(chainOf().fetchImpl), hourStart: HOUR + 3600, safeHead: ORIGIN.originNumber + 25_000,
        v3Registry: V3 });
      store.commitHour(tamper(LIVE, 'uniswap_v4_pools'));
      store.commitHour(next);
      assert.equal(store.v4Registry().coverage.through, LIVE.range.firstBlock - 1, 'the failed hour stalls coverage; the next hour cannot extend it');
      const readModel = createCompactReadModel({ path: join(directory, 'repair-chain.sqlite'), DatabaseSync: sqlite.DatabaseSync });
      assert.deepEqual(readModel.projectionRepairCandidates({ fromHour: HOUR, toHour: HOUR + 3600 }), { hours: [HOUR], blocked: [] });
      const run = await repairHour(join(directory, 'repair-chain.sqlite'));
      assert.deepEqual([run.summary.needs, run.summary.ok], [['uniswap_v4_pools'], true]);
      assert.deepEqual(store.v4Registry().coverage, { fromBlock: ORIGIN.originNumber, through: next.range.lastBlock, throughHash: next.range.lastHash });
      assert.equal(statusOf(store, HOUR).dex_activity, 'unavailable(projection_inputs_unavailable)', 'the failed live hour keeps no activity');
      assert.deepEqual(readModel.projectionRepairCandidates({ fromHour: HOUR, toHour: HOUR + 3600 }), { hours: [], blocked: [] });
      readModel.close();
      db.close();
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

console.log(`ARC_INTELLIGENCE_PROJECTIONS: PASS (${passed} deterministic scenarios on Node ${process.version}; offline only, no network, `
  + `no backfill run; node:sqlite ${sqlite ? 'tested' : 'deferred'})`);
