// Compact engine, Phase 1D.1: historical valuation backfill (server/compact/valuation-backfill.js and
// scripts/backfill-arc-intelligence-valuations.mjs), the writer lock and the storage safety rules.
// Offline only: a fake JSON-RPC chain serves hand-encoded Uniswap logs; no network, no server.
// Pure tests run on any Node; node:sqlite tests run when the runtime has it (Node 22.13+), and COMPACT_REQUIRE_SQLITE=1
// turns its absence into a failure.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { normalizeLog } from '../api/_lib/arc-intelligence/normalize.js';
import { decodeV3Swap, decodeV4Swap, UNISWAP_EVENT_TOPICS, UNISWAP_REGISTRY } from '../api/_lib/arc-intelligence/uniswap.js';
import { FAMILY_FIELDS, FAMILY_WINDOWS } from '../server/compact/families.js';
import { DAILY_ACTIVE_ADDRESSES_SQL } from '../server/compact/daily-active-addresses.js';
import { INTELLIGENCE_SQL } from '../server/compact/intelligence-store.js';
import { createProjectionSink, v4PoolIdOf, VALUATION_INPUT_PROJECTIONS } from '../server/compact/projections.js';
import { ARC_CHAIN_ID, createProvider } from '../server/compact/provider.js';
import { createCompactReadModel } from '../server/compact/read-model.js';
import { V3_POOL_KIND } from '../server/compact/registry.js';
import { COMPACT_DEFINITION_VERSION } from '../server/compact/sources.js';
import { createCompactStore } from '../server/compact/store.js';
import {
  formatValuationPlan, MAX_VALUATION_HOURS, planHour, planValuationBackfill, storageGuard, VALUATION_BACKFILL_TABLES,
} from '../server/compact/valuation-backfill.js';
import { hookCanTakeSwapDeltas } from '../server/compact/valuation.js';
import { acquireWriterLock, lockPathOf, MAX_LOCK_AGE_MS, WriterLockError, writerLockHolder } from '../server/compact/writer-lock.js';
import { runValuationBackfillTool, valuationBackfillConfig } from './backfill-arc-intelligence-valuations.mjs';

let passed = 0;
async function test(name, run) { await run(); passed += 1; console.log(`PASS ${name}`); }
const hex = (number) => `0x${number.toString(16)}`;
const word = (value) => BigInt.asUintN(256, BigInt(value)).toString(16).padStart(64, '0');
const topicOf = (address) => `0x${address.slice(2).padStart(64, '0')}`;
const addressOf = (n) => `0x${n.toString(16).padStart(40, '0')}`;
const hashOf = (n) => `0x${n.toString(16).padStart(64, '0')}`;
const T = UNISWAP_EVENT_TOPICS;
const PM = UNISWAP_REGISTRY.v4PoolManager.address;
const ENV = { COMPACT_SQLITE_PATH: '/data/arc-compact.sqlite' };
const scratch = mkdtempSync(join(process.env.COMPACT_SQLITE_DIR || tmpdir(), 'valuation-backfill-'));

// ---------------------------------------------------------------------------------------------------------------------
// Configuration: dry run by default, execute needs both the flag and the environment confirmation, at most 72 hours.

await test('config: dry run by default for 24 hours; execute needs --execute AND COMPACT_VALUATION_BACKFILL_EXECUTE=yes', async () => {
  assert.deepEqual(valuationBackfillConfig({ argv: [], env: ENV }), { sqlitePath: '/data/arc-compact.sqlite', hours: 24, minIntervalMs: 1000,
    mode: 'dry_run' });
  assert.equal(valuationBackfillConfig({ argv: ['--hours', '72'], env: ENV }).hours, 72);
  assert.equal(valuationBackfillConfig({ argv: ['--hours=48'], env: ENV }).hours, 48);
    assert.equal(valuationBackfillConfig({ argv: ['--before', '2026-10-03T22:00:00.000Z'], env: ENV }).beforeHour, Date.parse('2026-10-03T22:00:00.000Z') / 1000);
    assert.equal(valuationBackfillConfig({ argv: ['--before=2026-10-03T22:00:00Z'], env: ENV }).beforeHour, Date.parse('2026-10-03T22:00:00.000Z') / 1000);
  const refused = (argv, env, code) => assert.throws(() => valuationBackfillConfig({ argv, env }), (error) => error.code === code, `${argv.join(' ')} ${code}`);
  refused(['--execute'], ENV, 'execute_confirmation_required');
  refused(['--execute'], { ...ENV, COMPACT_VALUATION_BACKFILL_EXECUTE: 'true' }, 'execute_confirmation_required');
  assert.equal(valuationBackfillConfig({ argv: ['--execute'], env: { ...ENV, COMPACT_VALUATION_BACKFILL_EXECUTE: 'yes' } }).mode, 'execute');
  refused(['--hours', '73'], ENV, 'hours_above_maximum');
  refused(['--hours=720'], ENV, 'hours_above_maximum');
  for (const value of ['0', '-1', '1.5', 'all', '']) refused(['--hours', value], ENV, 'invalid_hours');
  refused(['--hours', '24', '--hours', '24'], ENV, 'unknown_argument');
    refused(['--before', '2026-10-03T22:30:00.000Z'], ENV, 'invalid_before_hour');
    refused(['--before', '2026-10-03T22:00:01.000Z'], ENV, 'invalid_before_hour');
    refused(['--before', 'not-a-date'], ENV, 'invalid_before_hour');
    refused(['--before', '2026-10-03T22:00:00.000Z', '--before', '2026-10-03T21:00:00.000Z'], ENV, 'unknown_argument');
  refused(['--all'], ENV, 'unknown_argument');
  refused([], {}, 'sqlite_path_required');
  refused([], { ...ENV, COMPACT_RPC_MIN_INTERVAL_MS: '100' }, 'unsafe_rpc_pacing');
  for (const value of ['3600001', '2147483648', '9007199254740992']) {
    refused([], { ...ENV, COMPACT_RPC_MIN_INTERVAL_MS: value }, 'unsafe_rpc_pacing');
  }
  assert.equal(valuationBackfillConfig({ argv: [], env: { ...ENV, COMPACT_RPC_MIN_INTERVAL_MS: '3600000' } }).minIntervalMs, 3_600_000);
  assert.equal(MAX_VALUATION_HOURS, 72);
});

// ---------------------------------------------------------------------------------------------------------------------
// Plan (pure).

const plannedHour = (overrides = {}) => ({ hourStart: 3600 * 1000, firstBlock: 1000, lastBlock: 8094, firstHash: hashOf(1000), lastHash: hashOf(8094),
  families: { uniswapV3: { status: 'available', poolsWithSwaps: 63 }, uniswapV4: { status: 'available', poolsWithSwaps: 171 } },
  projections: { uniswap_v3_pools: { status: 'available' }, uniswap_v4_pools: { status: 'available' } }, valuations: {}, ...overrides });
const available = { status: 'available' };

await test('plan: an hour is valued, needs a log re-read, needs only derivation, or is blocked with exact reasons', async () => {
  const valued = plannedHour({ valuations: { token_prices: available, dex_usd_volume: available, dex_fees: available } });
  assert.equal(planHour(valued, { v3Through: 9000 }).action, 'valued');
  const refetch = planHour(plannedHour(), { v3Through: 9000 });
  assert.deepEqual([refetch.action, refetch.refetch, refetch.missingInputs], ['refetch', { uniswap_v3_pools: true, uniswap_v4_pools: true },
    ['uniswap_v3_price_paths', 'uniswap_v4_price_paths', 'uniswap_v4_swap_fees']]);
  const inputsDone = plannedHour({ projections: { uniswap_v3_pools: available, uniswap_v4_pools: available, uniswap_v3_price_paths: available,
    uniswap_v4_price_paths: available, uniswap_v4_swap_fees: available }, valuations: { token_prices: available,
    dex_usd_volume: { status: 'unavailable', reason: 'prices_unavailable' } } });
  assert.equal(planHour(inputsDone, { v3Through: 9000 }).action, 'derive', 'inputs complete: no RPC, only derivation');
  const onlyV4 = planHour(plannedHour({ projections: { ...inputsDone.projections, uniswap_v4_swap_fees: { status: 'unavailable' } } }), { v3Through: 9000 });
  assert.deepEqual([onlyV4.action, onlyV4.refetch], ['refetch', { uniswap_v4_pools: true }], 'only the stream that is needed');
  const blocked = (hour, through, blocker) => {
    const plan = planHour(hour, { v3Through: through });
    assert.deepEqual([plan.action, plan.blockers.includes(blocker), plan.refetch], ['blocked', true, {}], blocker);
  };
  blocked(plannedHour({ families: { uniswapV3: { status: 'unavailable' }, uniswapV4: { status: 'available' } } }), 9000, 'v3_family_unavailable');
  blocked(plannedHour({ projections: { uniswap_v3_pools: available } }), 9000, 'v4_pool_projection_unavailable');
  blocked(plannedHour(), 8000, 'v3_registry_behind');
});

const inputsOf = (hourRows, extra = {}) => ({ hours: 24, fromHour: hourRows[0].hourStart, toHour: hourRows.at(-1).hourStart,
  newestHour: hourRows.at(-1).hourStart, valuationTables: true, v3Through: 10 ** 9, hourRows, ...extra });

await test('plan: exact getLogs estimate (ceil(blocks/500) per stream and hour), compact hourly row and byte estimates, storage guard', async () => {
  const hours = Array.from({ length: 24 }, (_, i) => plannedHour({ hourStart: 3600 * (1000 + i), firstBlock: 1000 + i * 7095, lastBlock: 1000 + i * 7095 + 7094 }));
  const plan = planValuationBackfill(inputsOf(hours));
  assert.deepEqual([plan.targetHours, plan.refetchHours, plan.v3Requests, plan.v4Requests, plan.boundaryRequests, plan.totalRequests],
    [24, 24, 24 * 15, 24 * 15, 1, 24 * 30 + 1 + 1]);
  assert.deepEqual([plan.missingValuationHours, plan.missingPricePathHours, plan.missingSwapFeeHours, plan.alreadyValued, plan.blockedHours], [24, 24, 24, 0, 0]);
  assert.equal(plan.expectedWrites.pricePathRows, 24 * (63 + 171), 'one price-path row per pool with swaps and hour, never one per swap');
  assert.equal(plan.expectedWrites.swapFeeRows, 24 * 171);
  assert.equal(plan.expectedWrites.valuationStatusRows, 24 * 3);
  assert.ok(plan.expectedWrites.estimatedBytes < 16 * 1024 * 1024, 'about 10 MB for 24 hours at Arc scale');
  assert.equal(storageGuard(plan), null);
  for (const value of [Number.NaN, Number.POSITIVE_INFINITY, -1, Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal(storageGuard({ ...plan, expectedWrites: { ...plan.expectedWrites, estimatedBytes: value } }), 'storage_estimate_abnormal');
  }
  const lines = formatValuationPlan(plan);
  for (const key of ['TARGET_HOURS', 'ALREADY_VALUED_HOURS', 'MISSING_VALUATION_HOURS', 'MISSING_PRICE_PATH_HOURS', 'MISSING_SWAP_FEE_HOURS', 'REFETCH_HOURS',
    'DERIVE_ONLY_HOURS', 'BLOCKED_HOURS', 'ESTIMATED_GETLOGS', 'ESTIMATED_REQUESTS', 'EXPECTED_PERSISTENT_WRITES', 'STORAGE', 'UNAVAILABLE_REASONS']) {
    assert.ok(lines.some((line) => line.startsWith(`${key} `)), key);
  }
  assert.ok(lines.find((line) => line.startsWith('STORAGE ')).includes('raw logs=0 transactions=0 receipts=0 blocks=0 per_swap_rows=0'));
  // A plan far beyond compact hourly scale is refused before anything is written.
  const huge = hours.map((hour) => ({ ...hour, families: { uniswapV3: { status: 'available', poolsWithSwaps: 400_000 },
    uniswapV4: { status: 'available', poolsWithSwaps: 400_000 } } }));
  assert.equal(storageGuard(planValuationBackfill(inputsOf(huge))), 'storage_estimate_abnormal');
  // Hours outside pool-hour retention are never targets.
  const old = planValuationBackfill(inputsOf(hours, { newestHour: hours.at(-1).hourStart + 900 * 3600 }));
  assert.deepEqual([old.targetHours, old.outsideRetention], [0, 24]);
});

// ---------------------------------------------------------------------------------------------------------------------
// Writer lock.

await test('writer lock: exclusive, dead process recovery, live locks never expire and acquisition is serialized', async () => {
  const path = join(scratch, 'lock.sqlite');
  const lock = acquireWriterLock(path, { owner: 'first' });
  assert.ok(existsSync(lockPathOf(path)));
  assert.equal(writerLockHolder(path).owner, 'first');
  assert.throws(() => acquireWriterLock(path, { owner: 'second' }), (error) => error instanceof WriterLockError && error.code === 'writer_lock_held'
    && error.holder.owner === 'first');
  lock.release();
  lock.release();
  assert.equal(existsSync(lockPathOf(path)), false, 'no lock file is left behind');
  // A holder whose process is gone is stale.
  writeFileSync(lockPathOf(path), JSON.stringify({ pid: 99_999_999, owner: 'crashed', since: new Date().toISOString() }));
  const replaced = acquireWriterLock(path, { owner: 'third', isAlive: () => false });
  assert.equal(writerLockHolder(path).owner, 'third');
  replaced.release();
  // Age cannot prove that a live process is gone.
  writeFileSync(lockPathOf(path), JSON.stringify({ pid: process.pid, owner: 'ancient', since: '2026-01-01T00:00:00.000Z' }));
  const past = (Date.now() - MAX_LOCK_AGE_MS - 60_000) / 1000;
  utimesSync(lockPathOf(path), past, past);
  assert.throws(() => acquireWriterLock(path, { owner: 'fourth' }), (error) => error.code === 'writer_lock_held');
  rmSync(lockPathOf(path));
  // A fresh unreadable lock may be mid-write by its creator: it is respected.
  writeFileSync(lockPathOf(path), '');
  assert.throws(() => acquireWriterLock(path, { owner: 'fifth' }), (error) => error.code === 'writer_lock_held');
  rmSync(lockPathOf(path));
  writeFileSync(`${lockPathOf(path)}.claim`, '');
  assert.throws(() => acquireWriterLock(path, { owner: 'contender' }), (error) => error.code === 'writer_lock_contended');
  assert.equal(existsSync(lockPathOf(path)), false);
  rmSync(`${lockPathOf(path)}.claim`);
  const original = acquireWriterLock(path, { owner: 'original' });
  writeFileSync(lockPathOf(path), JSON.stringify({ pid: process.pid, owner: 'replacement', token: 'different' }));
  original.release();
  assert.equal(writerLockHolder(path).owner, 'replacement', 'release cannot remove a replacement lock');
  rmSync(lockPathOf(path));
  assert.deepEqual(readdirSync(scratch).filter((name) => name.endsWith('.writer-lock')), []);
});

await test('every writer holds the lock: hourly runner, projection repair child, projection backfill and valuation backfill', async () => {
  for (const [file, owner] of [['run-compact-hour.mjs', 'run-compact-hour'], ['repair-compact-projection-hour.mjs', 'repair-compact-projection-hour'],
    ['backfill-compact-projections.mjs', 'backfill-compact-projections'], ['backfill-arc-intelligence-valuations.mjs', 'backfill-arc-intelligence-valuations']]) {
    const source = readFileSync(new URL(`./${file}`, import.meta.url), 'utf8');
    assert.match(source, new RegExp(`acquireWriterLock\\([^)]*owner: '${owner}'`), file);
    assert.match(source, /\.release\(\)/, `${file} releases the lock`);
  }
});

// ---------------------------------------------------------------------------------------------------------------------
// Storage safety (static): compact hourly tables only, no raw archive, no dumps, no external services.

const STORE_SOURCE = readFileSync(new URL('../server/compact/store.js', import.meta.url), 'utf8');
const SCHEMA = STORE_SOURCE.match(/const SCHEMA = `([\s\S]*?)`;/)[1] + DAILY_ACTIVE_ADDRESSES_SQL + INTELLIGENCE_SQL;
const SCHEMA_TABLES = [...SCHEMA.matchAll(/CREATE TABLE IF NOT EXISTS (\w+) \(/g)].map((match) => match[1]);
export const ALLOWED_TABLES = Object.freeze(['compact_meta', 'compact_hours', 'compact_family_hours', 'compact_hour_addresses', 'compact_registry',
  'compact_registry_coverage', 'compact_checkpoint', 'compact_projection_hours', 'compact_pool_hours', 'compact_dex_activity', 'compact_pool_price_hours',
  'compact_valuation_hours', 'compact_token_price_hours', 'compact_dex_volume_hours', 'compact_pool_fee_hours', 'compact_dex_fee_hours',
  'compact_token_metadata', 'compact_pool_tvl_hours',
  'compact_daily_active_addresses', 'compact_daily_address_hours', 'compact_daily_address_stage',
  'compact_intelligence_hours', 'compact_token_dex_observations', 'compact_token_discoveries']);
const ARCHIVE_NAME = /raw|_logs?\b|_log_|receipt|transaction|_txs?\b|block_body|blocks\b|events?\b|archive|dump/i;

await test('storage safety: the schema is exactly the compact tables; no raw log, transaction, receipt, block or per-swap archive table', async () => {
  assert.deepEqual([...SCHEMA_TABLES].sort(), [...ALLOWED_TABLES].sort(), 'a new table must be reviewed and allow-listed here');
  for (const table of SCHEMA_TABLES) assert.doesNotMatch(table, ARCHIVE_NAME, table);
  // The only per-event table is the bounded recent-activity feed (Phase 1A), never written by a backfill.
  assert.ok(!VALUATION_BACKFILL_TABLES.includes('compact_dex_activity'));
  for (const table of VALUATION_BACKFILL_TABLES) {
    const ddl = SCHEMA.match(new RegExp(`CREATE TABLE IF NOT EXISTS ${table} \\(([\\s\\S]*?)\\) STRICT`))[1];
    assert.match(ddl, /PRIMARY KEY \(hour_start/, `${table} is keyed by hour: compact hourly rows only`);
    assert.doesNotMatch(ddl, /tx_hash|log_index|block_number|transaction|calldata|topics|data_hex/i, `${table} holds no per-event field`);
  }
  // One price-path and one swap-fee row per (hour, pool), whatever the number of swaps: the projections aggregate them.
  for (const table of ['compact_pool_price_hours', 'compact_pool_fee_hours']) {
    assert.match(SCHEMA.match(new RegExp(`CREATE TABLE IF NOT EXISTS ${table} \\(([\\s\\S]*?)\\) STRICT`))[1], /PRIMARY KEY \(hour_start, (protocol, )?pool\)/);
  }
  const sources = ['../server/compact/valuation-backfill.js', './backfill-arc-intelligence-valuations.mjs', '../server/compact/writer-lock.js',
    '../server/compact/valuation.js', '../server/compact/projections.js'].map((file) => [file, readFileSync(new URL(file, import.meta.url), 'utf8')]);
  for (const [file, source] of sources) {
    assert.doesNotMatch(source, /writeFileSync\(|appendFileSync\(|createWriteStream\(|console\.dir\(|JSON\.stringify\(\s*(logs?|response|raw)\b/, `${file}: no dump`);
    for (const [, path] of source.matchAll(/^import .* from '([^']+)';$/gm)) {
      assert.ok(path.startsWith('node:') || path.startsWith('./') || path.startsWith('../'), `${file}: ${path} is a repository module or a node built-in`);
    }
    assert.doesNotMatch(source, /coingecko|coinmarketcap|alchemy|quicknode|infura|postgres|redis|https?:\/\/(?!docs\.arc)/i, `${file}: no external service`);
  }
});

// ---------------------------------------------------------------------------------------------------------------------
// node:sqlite: the full flow against a fake chain.

const sqlite = await import('node:sqlite').catch(() => null);
if (!sqlite) {
  assert.notEqual(process.env.COMPACT_REQUIRE_SQLITE, '1', `node:sqlite is required but unavailable on Node ${process.version}`);
  console.log(`DEFERRED valuation-backfill sqlite tests: node:sqlite is unavailable on Node ${process.version}; run this file on Node 22.13+ `
    + '(e.g. the Node 24 Railway image) with COMPACT_REQUIRE_SQLITE=1 to execute them');
} else {
  const { DatabaseSync } = sqlite;
  const HOUR = 3600;
  const BASE = Date.UTC(2026, 9, 1, 0) / 1000;
  const BLOCKS = 100;
  const HOURS = 26; // checkpoint at hour 25: the 24H window is hours 2..25
  const iso = (seconds) => new Date(seconds * 1000).toISOString();
  const firstBlockOf = (i) => 1000 + i * BLOCKS;
  const USDC = '0x3600000000000000000000000000000000000000';
  const EURC = '0xbef5f6d51cb62b58e6a8f77868681825c6fe21c1';
  const WETH = '0x128cc466b61f542da60c70e3aa11c10e19b84edb';
  const ZERO = `0x${'0'.repeat(40)}`;
  const MOON = addressOf(0x3c3c);
  const ROUTER = addressOf(0x4f4f);
  const DELTA_HOOKS = addressOf(0x4000c); // flags 0b1100: before/after swap may return deltas
  assert.ok(hookCanTakeSwapDeltas(DELTA_HOOKS));
  const POOL_A = addressOf(0x9101); // WETH/USDC, the WETH price source
  const POOL_B = addressOf(0x9102); // WETH/MOON, valued with the WETH price
  const KEY_X = { currency0: ZERO, currency1: EURC, fee: 500, tickSpacing: 10, hooks: ZERO };
  const KEY_Y = { currency0: USDC, currency1: MOON, fee: 10000, tickSpacing: 200, hooks: DELTA_HOOKS };
  const [POOL_X, POOL_Y] = [v4PoolIdOf(KEY_X), v4PoolIdOf(KEY_Y)];
  const Q96 = 2n ** 96n;
  const S_WETH = 2n ** 80n;
  const L_DEEP = 50_000_000_000n * 65_536n; // 50,000 USDC of virtual reserve at S_WETH
  const WETH_PRICE = (S_WETH * S_WETH * 10n ** 36n) / (2n ** 192n * 10n ** 6n);
  // Every hour's swaps: [protocol, pool, blockOffset, amount0, amount1, sqrtPrice, liquidity, fee]
  const SWAPS = [
    ['v3', POOL_A, 0, 10n ** 18n, -2000n * 10n ** 6n, S_WETH, L_DEEP], ['v3', POOL_A, 10, -(5n * 10n ** 17n), 1001n * 10n ** 6n, S_WETH, L_DEEP],
    ['v3', POOL_A, 20, 25n * 10n ** 16n, -500n * 10n ** 6n, S_WETH, L_DEEP], ['v3', POOL_A, 30, -(25n * 10n ** 16n), 501n * 10n ** 6n, S_WETH, L_DEEP],
    ['v3', POOL_B, 40, 10n ** 17n, -(5n * 10n ** 20n), Q96, 1n], ['v3', POOL_B, 50, -(2n * 10n ** 17n), 9n * 10n ** 20n, Q96, 1n],
    ['v4', POOL_X, 5, -(2n * 10n ** 18n), 1_900_000n, Q96, 1n, 500n], ['v4', POOL_X, 15, 10n ** 18n, -1_100_000n, Q96, 1n, 500n],
    ['v4', POOL_X, 25, -(3n * 10n ** 18n), 2_800_000n, Q96, 1n, 500n],
    ['v4', POOL_Y, 35, -10_000_000n, 7n * 10n ** 18n, Q96, 1n, 10000n], ['v4', POOL_Y, 45, 4_000_000n, -(3n * 10n ** 18n), Q96, 1n, 10000n],
  ];
  // Independent expected values (formulas written out, not the engine's functions).
  const outFee = (out, fee) => (out * fee * 10n ** 12n) / (1_000_000n - fee);
  const HOUR_VOLUME = { uniswap_v3: (1502n + 2500n) * 10n ** 6n + ((3n * 10n ** 17n) * WETH_PRICE) / 10n ** 30n, uniswap_v4: 6_000_000n + 14_000_000n };
  const FEE_A = (1502n * 10n ** 6n * 500n * 10n ** 6n + outFee(2500n * 10n ** 6n, 500n)) / 10n ** 12n;
  const FEE_B = ((10n ** 17n * 500n * 10n ** 6n + outFee(2n * 10n ** 17n, 500n)) * WETH_PRICE / 10n ** 30n) / 10n ** 12n;
  const FEE_X = (5n * 10n ** 18n * 500n * 10n ** 6n + outFee(10n ** 18n, 500n)) / 10n ** 24n;
  const HOUR_FEES = { uniswap_v3: FEE_A + FEE_B, uniswap_v4: FEE_X };

  function logsOfHour(i, { faults = null } = {}) {
    return SWAPS.map(([protocol, pool, offset, amount0, amount1, sqrt, liquidity, fee], index) => {
      const block = firstBlockOf(i) + offset;
      const raw = protocol === 'v3'
        ? { address: pool, topics: [T.v3Swap, topicOf(ROUTER), topicOf(ROUTER)], data: `0x${word(amount0)}${word(amount1)}${word(sqrt)}${word(liquidity)}${word(0)}` }
        : { address: PM, topics: [T.v4Swap, pool, topicOf(ROUTER)], data: `0x${word(amount0)}${word(amount1)}${word(sqrt)}${word(liquidity)}${word(0)}${word(fee)}` };
      const log = { ...raw, blockNumber: hex(block), blockHash: hashOf(block), transactionHash: hashOf(0x7a000000 + i * 100 + index), transactionIndex: '0x0',
        logIndex: hex(index), removed: false };
      return faults ? faults(i, log) : log;
    });
  }
  // A fake public RPC: chain id, headers and topic/address-filtered logs only. Counts every request.
  function fakeChain({ faults = null } = {}) {
    const stats = { getLogs: 0, headers: 0, other: [] };
    const answer = (item) => {
      const envelope = (payload) => ({ jsonrpc: '2.0', id: item.id, ...payload });
      if (item.method === 'eth_chainId') return envelope({ result: hex(ARC_CHAIN_ID) });
      if (item.method === 'eth_getBlockByNumber') {
        stats.headers += 1;
        const number = Number(BigInt(item.params[0]));
        return envelope({ result: { number: hex(number), hash: hashOf(number), parentHash: hashOf(number - 1), timestamp: hex(BASE + Math.floor((number - 1000) * 36)) } });
      }
      if (item.method === 'eth_getLogs') {
        stats.getLogs += 1;
        const filter = item.params[0];
        const from = Number(BigInt(filter.fromBlock));
        const to = Number(BigInt(filter.toBlock));
        const addresses = filter.address ? new Set(filter.address) : null;
        const topics = new Set(filter.topics[0]);
        const out = [];
        for (let i = 0; i < HOURS; i++) {
          for (const log of logsOfHour(i, { faults })) {
            const number = Number(BigInt(log.blockNumber));
            if (number >= from && number <= to && topics.has(log.topics[0]) && (!addresses || addresses.has(log.address))) out.push(log);
          }
        }
        return envelope({ result: out });
      }
      stats.other.push(item.method);
      return envelope({ error: { code: -32601, message: 'method not supported' } });
    };
    const fetchImpl = async (_url, init) => {
      const body = JSON.parse(init.body);
      const result = Array.isArray(body) ? body.map(answer) : answer(body);
      return { ok: true, status: 200, text: async () => JSON.stringify(result) };
    };
    return { stats, fetchImpl, provider: () => createProvider({ fetchImpl, minIntervalMs: 0, cooldownMs: 0, sleep: async () => {} }) };
  }

  const CONSTANTS = { rawDecimals: 18, symbol: 'EURC', address: EURC, decimals: 6, spoke: addressOf(0x5555), reserveId: '1', underlying: USDC,
    loanToken: USDC, collateralToken: addressOf(0xb7c), lltv: '860000000000000000', asset: USDC };
  const entry = (spec, k) => ({ ...Object.fromEntries((spec.counts ?? []).map((field) => [field, k + 1])),
    ...Object.fromEntries((spec.amounts ?? []).map((field) => [field, String(1000 + k)])), ...Object.fromEntries((spec.constants ?? []).map((field) => [field, CONSTANTS[field]])) });
  function familyMetrics(name, k) {
    const spec = FAMILY_WINDOWS[name];
    return Object.fromEntries(FAMILY_FIELDS[name].map((field) => {
      if (spec.counts?.includes(field)) return [field, k + 1];
      if (spec.amounts?.includes(field)) return [field, String(1000 + k)];
      if (spec.constants?.includes(field)) return [field, CONSTANTS[field]];
      if (spec.tallies?.[field]) return [field, { k: entry(spec.tallies[field], k) }];
      if (spec.lists?.[field]) return [field, [entry(spec.lists[field], k)]];
      return [field, 50 + k];
    }));
  }
  // One stored hour: the live projections of its logs, with the valuation inputs (price paths, V4 swap fees) left out, as an
  // hour indexed before they existed.
  function storedHour(i, { withInputs = false } = {}) {
    const hourStart = BASE + i * HOUR;
    const firstBlock = firstBlockOf(i);
    const lastBlock = firstBlock + BLOCKS - 1;
    const families = Object.fromEntries(Object.keys(FAMILY_FIELDS).map((name) => [name, { status: 'available', ...familyMetrics(name, i) }]));
    Object.assign(families.uniswapV3, { swapCount: 6, mintCount: 0, burnCount: 0, poolsWithSwaps: 2 });
    Object.assign(families.uniswapV4, { swapCount: 5, modifyLiquidityCount: 0, initializeCount: 0, poolsWithSwaps: 2 });
    const sink = createProjectionSink({ activity: false });
    for (const raw of logsOfHour(i)) {
      const log = normalizeLog(raw);
      if (log.address === PM) sink.v4('swap', log, decodeV4Swap(log), null);
      else sink.v3('swap', log, decodeV3Swap(log), null);
    }
    const projections = sink.finish({ families, hourStart: null, firstBlock, lastBlock });
    if (!withInputs) for (const name of VALUATION_INPUT_PROJECTIONS) delete projections[name];
    return { definitionVersion: COMPACT_DEFINITION_VERSION, chainId: ARC_CHAIN_ID,
      range: { kind: 'hour', hourStart, hourEnd: hourStart + HOUR, startUtc: iso(hourStart), endUtc: iso(hourStart + HOUR), firstBlock, lastBlock,
        parentHash: hashOf(firstBlock - 1), firstHash: hashOf(firstBlock), lastHash: hashOf(lastBlock), firstTimestamp: hourStart, lastTimestamp: hourStart + 3599 },
      network: { status: 'available', blockCount: BLOCKS, transactionCount: 100, uniqueSenders: 1, uniqueRecipients: 1, uniqueActiveAddresses: 1,
        gasUsedRaw: '1000', averageTransactionsPerBlock: 1, transactionsPerSecond: 100 / HOUR, internal: { deploymentAttempts: 0 } },
      families, complete: true, activeAddresses: [addressOf(0xad00 + i)],
      registry: { uniswapV3: { through: lastBlock, throughHash: hashOf(lastBlock), created: [] } }, projections };
  }
  const workdir = mkdtempSync(join(process.env.COMPACT_SQLITE_DIR || tmpdir(), 'valuation-backfill-db-'));
  function buildDatabase(name, { hours = HOURS, options = () => ({}) } = {}) {
    const path = join(workdir, `${name}.sqlite`);
    const db = new DatabaseSync(path);
    const store = createCompactStore(db);
    const v3 = (address, token0, token1, n) => ({ address, createdBlock: 900, createdLogIndex: n, createdTx: hashOf(0x7100 + n), token0, token1, fee: 500,
      tickSpacing: 10 });
    store.extendRegistry({ kind: V3_POOL_KIND, fromBlock: 1, through: 999, throughHash: hashOf(999), previousThrough: null,
      created: [v3(POOL_A, WETH, USDC, 0), v3(POOL_B, WETH, MOON, 1)] });
    const v4 = (key, n) => ({ poolId: v4PoolIdOf(key), createdBlock: 901, createdLogIndex: n, createdTx: hashOf(0x7300 + n), ...key });
    store.extendV4Registry({ kind: 'uniswap_v4_pool', fromBlock: 1, through: 999, throughHash: hashOf(999), previousThrough: null,
      created: [v4(KEY_X, 0), v4(KEY_Y, 1)] });
    for (let i = 0; i < hours; i++) store.commitHour(storedHour(i, options(i)));
    db.close();
    return path;
  }
  const count = (db, table) => db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count;
  const tablesOf = (db) => db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all().map((row) => row.name);
  // Everything a valuation backfill must never change.
  function protectedState(path) {
    const db = new DatabaseSync(path, { readOnly: true });
    try {
      const rows = (sql) => db.prepare(sql).all().map((row) => JSON.stringify(row));
      return { hours: rows('SELECT * FROM compact_hours ORDER BY hour_start'), families: rows('SELECT * FROM compact_family_hours ORDER BY hour_start, family'),
        addresses: count(db, 'compact_hour_addresses'), checkpoint: rows('SELECT * FROM compact_checkpoint'), registry: rows('SELECT * FROM compact_registry ORDER BY kind, address'),
        coverage: rows('SELECT * FROM compact_registry_coverage ORDER BY kind'), poolHours: rows('SELECT * FROM compact_pool_hours ORDER BY hour_start, protocol, pool'),
        activity: count(db, 'compact_dex_activity'), poolStatus: rows("SELECT * FROM compact_projection_hours WHERE projection IN ('uniswap_v3_pools', 'uniswap_v4_pools', 'dex_activity') ORDER BY hour_start, projection") };
    } finally {
      db.close();
    }
  }
  const tableCounts = (path) => {
    const db = new DatabaseSync(path, { readOnly: true });
    try { return Object.fromEntries(tablesOf(db).map((table) => [table, count(db, table)])); } finally { db.close(); }
  };
  const fileHash = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');
  const run = async (path, { mode = 'dry_run', hours = 24, chain = fakeChain(), free = () => 10 ** 12 } = {}) => {
    const lines = [];
    let created = 0;
    let error = null;
    let summary = null;
    try {
      summary = await runValuationBackfillTool({ config: { sqlitePath: path, hours, minIntervalMs: 1000, mode }, DatabaseSync,
        providerFactory: () => { created += 1; return chain.provider(); }, print: (line) => lines.push(line), free,
        now: () => new Date(Date.UTC(2026, 9, 5, 0, 0, created)) });
    } catch (caught) {
      error = caught;
    }
    return { lines, created, error, summary, chain, line: (key) => lines.find((text) => text.startsWith(`${key} `)) };
  };
  const statusRows = (path) => {
    const db = new DatabaseSync(path, { readOnly: true });
    try {
      return db.prepare('SELECT hour_start, valuation, status, reason FROM compact_valuation_hours ORDER BY hour_start, valuation').all()
        .map((row) => `${row.hour_start}:${row.valuation}:${row.status}:${row.reason}`);
    } finally {
      db.close();
    }
  };
  const readModel = (path) => createCompactReadModel({ path, DatabaseSync, now: () => (BASE + HOURS * HOUR + 600) * 1000 });

  try {
    await test('sqlite: the stored state reproduces production: pool projections available, price paths and fees missing, 24H not valued', async () => {
      const path = buildDatabase('production-like');
      const model = readModel(path);
      const volume = model.summary('24h').dex.usdVolume;
      assert.deepEqual([volume.status, volume.reason, volume.reasons, volume.totalUsdMicros], ['unavailable', 'valuation_hour_unavailable', ['prices_unavailable'], null]);
      assert.ok(model.timeseries('24h').buckets.every((bucket) => bucket.dexUsdVolume.status === 'unavailable' && bucket.dexUsdVolume.reason === 'prices_unavailable'),
        'every hour needs the WETH price for the WETH/MOON pool; no hour is a fake zero');
      model.close();
    });

    await test('sqlite: dry run reads only: zero writes, zero RPC, exact plan with requests and compact row estimates', async () => {
      const path = buildDatabase('dry-run');
      const before = fileHash(path);
      const result = await run(path);
      assert.equal(result.error, null, result.error?.message);
      assert.equal(fileHash(path), before, 'the database file is byte-identical');
      assert.equal(result.created, 0, 'no provider is ever created by a dry run');
      assert.equal(result.lines.at(-1), 'RESULT DRY_RUN writes=0 rpc_requests=0');
      assert.equal(result.line('TARGET_HOURS').split(' ')[1], '24');
      assert.equal(result.line('MISSING_PRICE_PATH_HOURS'), 'MISSING_PRICE_PATH_HOURS 24');
      assert.equal(result.line('REFETCH_HOURS'), 'REFETCH_HOURS 24 v3=24 v4=24');
      assert.match(result.line('ESTIMATED_GETLOGS'), /^ESTIMATED_GETLOGS v3=24 v4=24 /, 'one 500-block request per stream for a 100-block hour');
      assert.match(result.line('ESTIMATED_REQUESTS'), /^ESTIMATED_REQUESTS total=50 boundary_batches=1 chain_check=1/);
      assert.match(result.line('EXPECTED_PERSISTENT_WRITES'), /price_path_rows~96 swap_fee_rows~48 /);
      assert.equal(result.line('STORAGE_GUARD'), 'STORAGE_GUARD pass (compact hourly scale)');
      assert.equal(result.line('WRITER_LOCK'), 'WRITER_LOCK free');
      assert.ok(result.line('SQLITE_BYTES_NOW'));
      assert.ok(result.line('NEXT_COMMAND').includes('COMPACT_VALUATION_BACKFILL_EXECUTE=yes') && result.line('NEXT_COMMAND').includes('--execute'));
      assert.equal(existsSync(lockPathOf(path)), false);
    });

    await test('sqlite: execute rebuilds price paths and fees from logs, derives every valuation, and changes nothing else', async () => {
      const path = buildDatabase('execute');
      const reference = buildDatabase('reference', { options: () => ({ withInputs: true }) });
      const before = protectedState(path);
      const countsBefore = tableCounts(path);
      const result = await run(path, { mode: 'execute' });
      assert.equal(result.error, null, result.error?.stack);
      assert.equal(result.lines.at(-1), 'RESULT EXECUTED rpc_requests=50', 'exactly the planned requests');
      assert.deepEqual([result.chain.stats.getLogs, result.chain.stats.headers, result.chain.stats.other], [48, 48, []], 'getLogs and headers only');
      assert.ok(result.line('SQLITE_BYTES_BEFORE') && result.line('SQLITE_BYTES_AFTER'), 'file size before and after');
      assert.deepEqual(protectedState(path), before, 'hours, families, addresses, checkpoint, registry, pool rows and activity untouched');
      const countsAfter = tableCounts(path);
      const changed = Object.keys(countsAfter).filter((table) => countsAfter[table] !== countsBefore[table]);
      assert.ok(changed.every((table) => VALUATION_BACKFILL_TABLES.includes(table)), `only valuation tables changed: ${changed}`);
      const inspector = new DatabaseSync(path, { readOnly: true });
      try {
        assert.deepEqual(tablesOf(inspector).sort(), [...ALLOWED_TABLES].sort());
      } finally { inspector.close(); }
      assert.equal(countsAfter.compact_pool_price_hours - countsBefore.compact_pool_price_hours, 24 * 4, 'one row per pool with swaps per hour');
      assert.equal(countsAfter.compact_pool_fee_hours - countsBefore.compact_pool_fee_hours, 24 * 2, 'one fee row per V4 pool with swaps per hour');
      // The rebuilt inputs are exactly what live indexing would have stored.
      const [rebuilt, live] = [path, reference].map((file) => {
        const db = new DatabaseSync(file, { readOnly: true });
        try {
          return [db.prepare('SELECT * FROM compact_pool_price_hours WHERE hour_start >= ? ORDER BY hour_start, protocol, pool').all(BigInt(BASE + 2 * HOUR)),
            db.prepare('SELECT * FROM compact_pool_fee_hours WHERE hour_start >= ? ORDER BY hour_start, pool').all(BigInt(BASE + 2 * HOUR))].map((rows) => JSON.stringify(rows));
        } finally {
          db.close();
        }
      });
      assert.deepEqual(rebuilt, live);
      // Valuations: available for the 24 target hours, with exact values.
      assert.ok(statusRows(path).filter((row) => Number(row.split(':')[0]) >= BASE + 2 * HOUR).every((row) => row.includes(':available:')));
      const model = readModel(path);
      const summary = model.summary('24h');
      assert.deepEqual([summary.dex.usdVolume.status, summary.dex.usdVolume.totalUsdMicros, summary.dex.usdVolume.byProtocol, summary.dex.usdVolume.valuedSwaps,
        summary.dex.usdVolume.unvaluedSwaps], ['available', (24n * (HOUR_VOLUME.uniswap_v3 + HOUR_VOLUME.uniswap_v4)).toString(),
        { uniswapV3: (24n * HOUR_VOLUME.uniswap_v3).toString(), uniswapV4: (24n * HOUR_VOLUME.uniswap_v4).toString() }, 24 * 11, 0]);
      assert.deepEqual([summary.dex.swapFees.status, summary.dex.swapFees.totalFeeUsdMicros, summary.dex.swapFees.valuedSwaps, summary.dex.swapFees.unvaluedSwaps,
        summary.dex.swapFees.averageFeeUsdMicros], ['available', (24n * (HOUR_FEES.uniswap_v3 + HOUR_FEES.uniswap_v4)).toString(), 24 * 9, 24 * 2,
        ((24n * (HOUR_FEES.uniswap_v3 + HOUR_FEES.uniswap_v4)) / BigInt(24 * 9)).toString()], 'the hooked pool that may take swap deltas is unvalued');
      const buckets = model.timeseries('24h').buckets;
      assert.ok(buckets.every((bucket) => bucket.dexUsdVolume.status === 'available'
        && bucket.dexUsdVolume.totalUsdMicros === (HOUR_VOLUME.uniswap_v3 + HOUR_VOLUME.uniswap_v4).toString()));
      const v3 = Object.fromEntries(model.pools('v3', '24h').pools.map((pool) => [pool.pool, pool.usdVolume]));
      assert.deepEqual(v3[POOL_A], { status: 'available', reason: null, usdMicros: (24n * 4002n * 10n ** 6n).toString(), basis: 'usd_anchor' });
      assert.deepEqual(v3[POOL_B], { status: 'available', reason: null, usdMicros: (24n * ((3n * 10n ** 17n * WETH_PRICE) / 10n ** 30n)).toString(),
        basis: 'verified_price' });
      const v4 = Object.fromEntries(model.pools('v4', '24h').pools.map((pool) => [pool.pool, pool.usdVolume.usdMicros]));
      assert.deepEqual(v4, { [POOL_X]: (24n * 6_000_000n).toString(), [POOL_Y]: (24n * 14_000_000n).toString() });
      model.close();
      // Snapshot: a complete copy taken before the first write; no lock file or other file left behind.
      const snapshot = result.summary.snapshot.path;
      const copy = new DatabaseSync(snapshot, { readOnly: true });
      assert.deepEqual([count(copy, 'compact_hours'), count(copy, 'compact_pool_price_hours')], [HOURS, 0], 'the rollback point predates the backfill');
      copy.close();
      assert.ok(result.line('ROLLBACK').includes(snapshot));
      assert.equal(existsSync(lockPathOf(path)), false);
      rmSync(snapshot);
      assert.deepEqual(readdirSync(workdir).filter((name) => name.startsWith('execute.sqlite') && !/\.sqlite(-wal|-shm)?$/.test(name)), []);
    });

    await test('sqlite: idempotent: a second execute finds every hour valued, writes nothing and creates no snapshot', async () => {
      const path = join(workdir, 'execute.sqlite');
      const statuses = statusRows(path);
      const counts = tableCounts(path);
      const result = await run(path, { mode: 'execute' });
      assert.equal(result.error, null);
      assert.equal(result.line('ALREADY_VALUED_HOURS'), 'ALREADY_VALUED_HOURS 24');
      assert.equal(result.lines.at(-1), 'RESULT EXECUTED nothing_to_do writes=0 rpc_requests=0');
      assert.deepEqual([statusRows(path), tableCounts(path), result.created], [statuses, counts, 0]);
      assert.deepEqual(readdirSync(workdir).filter((name) => name.includes('pre-valuation-backfill')), []);
    });

    await test('sqlite: a held writer lock refuses execute before any snapshot, request or write', async () => {
      const path = buildDatabase('locked');
      const lock = acquireWriterLock(path, { owner: 'run-compact-hour' });
      const counts = tableCounts(path);
      const result = await run(path, { mode: 'execute' });
      lock.release();
      assert.deepEqual([result.error?.code, result.error?.holder?.owner, result.created], ['writer_lock_held', 'run-compact-hour', 0]);
      assert.deepEqual(tableCounts(path), counts);
      assert.deepEqual(readdirSync(workdir).filter((name) => name.startsWith('locked.sqlite.pre-')), []);
      const dry = await run(path);
      assert.equal(dry.line('WRITER_LOCK'), 'WRITER_LOCK free', 'released');
    });

    await test('sqlite: not enough disk for the snapshot refuses execute before any write', async () => {
      const path = buildDatabase('no-disk');
      const counts = tableCounts(path);
      const result = await run(path, { mode: 'execute', free: () => 1024 });
      assert.equal(result.error?.code, 'insufficient_disk_for_snapshot');
      assert.deepEqual([tableCounts(path), result.created], [counts, 0]);
      assert.equal(existsSync(lockPathOf(path)), false, 'the lock is released on refusal');
    });

    await test('sqlite: inconsistent logs fail closed with the hour; finished hours stay valid, the failed hour is never zero', async () => {
      const path = buildDatabase('inconsistent');
      const before = protectedState(path);
      const bad = BASE + 10 * HOUR;
      const chain = fakeChain({ faults: (i, log) => (i === 10 && log.logIndex === '0x0' ? { ...log, blockHash: hashOf(0xdead) } : log) });
      const result = await run(path, { mode: 'execute', chain });
      assert.deepEqual([result.error?.code, result.error?.hour], ['log_block_hash_mismatch', iso(bad)]);
      assert.deepEqual(protectedState(path), before);
      const rows = statusRows(path);
      assert.ok(rows.includes(`${BASE + 9 * HOUR}:dex_usd_volume:available:null`), 'hours before it are committed and valid');
      assert.ok(rows.includes(`${bad}:dex_usd_volume:unavailable:prices_unavailable`), 'the failed hour keeps its exact reason');
      const model = readModel(path);
      const volume = model.summary('24h').dex.usdVolume;
      assert.deepEqual([volume.status, volume.totalUsdMicros], ['unavailable', null], 'never a partial 24H total');
      assert.ok(volume.unavailableHours.includes(iso(bad)));
      assert.deepEqual(model.timeseries('24h').buckets.find((bucket) => bucket.start === iso(bad)).dexUsdVolume,
        { status: 'unavailable', reason: 'prices_unavailable' });
      model.close();
      assert.equal(existsSync(lockPathOf(path)), false);
    });

    await test('sqlite: a stored boundary hash that no longer matches the chain fails the run closed before any projection write', async () => {
      const path = buildDatabase('boundary');
      const db = new DatabaseSync(path);
      db.prepare('UPDATE compact_hours SET first_hash = ? WHERE hour_start = ?').run(hashOf(0xbeef), BigInt(BASE + 5 * HOUR));
      db.close();
      const counts = tableCounts(path);
      const result = await run(path, { mode: 'execute' });
      assert.deepEqual([result.error?.code, result.error?.hours], ['boundary_hash_mismatch', [iso(BASE + 5 * HOUR)]]);
      const after = tableCounts(path);
      assert.deepEqual(VALUATION_BACKFILL_TABLES.filter((table) => table !== 'compact_valuation_hours').map((table) => after[table]),
        VALUATION_BACKFILL_TABLES.filter((table) => table !== 'compact_valuation_hours').map((table) => counts[table]));
    });

    await test('sqlite: derivation-only hours need no RPC; blocked hours are reported with exact reasons, never touched', async () => {
      const path = buildDatabase('derive', { options: () => ({ withInputs: true }) });
      const db = new DatabaseSync(path);
      db.exec('DELETE FROM compact_valuation_hours; DELETE FROM compact_dex_volume_hours; DELETE FROM compact_dex_fee_hours; DELETE FROM compact_token_price_hours');
      db.prepare("DELETE FROM compact_projection_hours WHERE hour_start = ? AND projection = 'uniswap_v4_pools'").run(BigInt(BASE + 10 * HOUR));
      db.close();
      const dry = await run(path);
      assert.match(dry.line('DERIVE_ONLY_HOURS'), /^DERIVE_ONLY_HOURS 23 /);
      assert.match(dry.line('BLOCKED_HOURS'), /^BLOCKED_HOURS 1 blockers=\{"v4_pool_projection_unavailable":1\}/);
      assert.ok(dry.lines.includes(`HOUR ${iso(BASE + 10 * HOUR)} action=blocked blockers=v4_pool_projection_unavailable`));
      const result = await run(path, { mode: 'execute' });
      assert.equal(result.error, null);
      assert.deepEqual([result.created, result.lines.at(-1)], [0, 'RESULT EXECUTED rpc_requests=0']);
      const model = readModel(path);
      const volume = model.summary('24h').dex.usdVolume;
      assert.deepEqual([volume.status, volume.reason, volume.unavailableHours], ['unavailable', 'valuation_hour_unavailable', [iso(BASE + 10 * HOUR)]]);
      assert.equal(model.summary('6h').dex.usdVolume.status, 'available', 'a window without the blocked hour is valued');
      model.close();
      rmSync(result.summary.snapshot.path);
    });

    await test('sqlite: --hours 72 on a younger database targets only the stored hours; old databases without valuation tables still serve', async () => {
      const path = buildDatabase('young', { hours: 30 });
      const dry = await run(path, { hours: 72 });
      assert.equal(dry.line('TARGET_HOURS').split(' ')[1], '30');
      // A database written before Phase 1C: no valuation tables at all. Health and summary still serve; USD reads not ready.
      const old = join(workdir, 'old.sqlite');
      const db = new DatabaseSync(old);
      createCompactStore(db);
      for (const table of ['compact_valuation_hours', 'compact_dex_volume_hours', 'compact_token_price_hours', 'compact_dex_fee_hours']) db.exec(`DROP TABLE ${table}`);
      db.close();
      const model = readModel(old);
      assert.equal(model.health().status, 'ok');
      model.close();
    });
  } finally {
    rmSync(workdir, { recursive: true, force: true });
  }
}

rmSync(scratch, { recursive: true, force: true });
console.log(`ARC_INTELLIGENCE_VALUATION_BACKFILL: PASS (${passed} deterministic scenarios on Node ${process.version}; offline only, no network; `
  + `node:sqlite ${sqlite ? 'tested' : 'deferred'})`);
