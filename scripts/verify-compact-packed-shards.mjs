// Node 24: disposable SQLite files and the deterministic synthetic chain only. No network, no production database, no RPC.
// Verifies the lossless packed-shards layer (server/compact/packed-shards.js) inside the existing compact store: OFF by
// default with no schema change, exact typed read-back, unchanged canonical rows and API answers, sufficiency of the
// packed copies to rebuild the hot rows, integrity failures, failure isolation, the repair path, daily sets, bounds and
// bounded memory (a 1,200,000-identity day packed and read back under a 48 MiB old-space heap in a child process).
// Any row deletion below happens only in disposable copies created by this script.
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getHeapStatistics } from 'node:v8';
import { FAMILY_FIELDS } from '../server/compact/families.js';
import { processHour } from '../server/compact/hour.js';
import { createSyntheticChain } from '../server/compact/offline.js';
import {
  PACKED_ADDRESS_ROWS, PACKED_COLUMN_ROWS, PACKED_DATASETS, PACKED_HOUR_DATASETS, PACKED_MAX_RAW_PIECE_BYTES, PACKED_SHARDS_VERSION, packedShardsConfig,
} from '../server/compact/packed-shards.js';
import { PROJECTIONS } from '../server/compact/projections.js';
import { createProvider } from '../server/compact/provider.js';
import { createCompactReadModel } from '../server/compact/read-model.js';
import { bootstrapV3Registry, bootstrapV4Registry, registrySnapshot } from '../server/compact/registry.js';
import { COMPACT_DEFINITION_VERSION } from '../server/compact/sources.js';
import { createCompactStore } from '../server/compact/store.js';
import { archiveConfig } from '../server/compact/evidence-archive.js';

globalThis.fetch = async () => { throw new Error('external_network_forbidden'); };
delete process.env.COMPACT_PACKED_SHARDS_ENABLED;
// Typed, order-preserving text of rows: SQLite NULL/INTEGER/TEXT/BLOB stay distinguishable.
const typedValue = (value) => (value === null ? ['null'] : ArrayBuffer.isView(value) ? ['blob', Buffer.from(value).toString('hex')]
  : typeof value === 'number' ? ['integer', String(value)] : typeof value === 'bigint' ? ['integer', value.toString()] : ['text', value]);
const typedRows = (rows) => JSON.stringify(rows.map((row) => Object.entries(row).map(([key, value]) => [key, typedValue(value)])));
const pkOrder = (db, table) => db.prepare(`PRAGMA table_info(${table})`).all().filter((c) => c.pk).sort((a, b) => a.pk - b.pk).map((c) => c.name).join(',');
const hot = (db, dataset, scope) => db.prepare(`SELECT * FROM ${dataset} WHERE ${PACKED_DATASETS[dataset].scope} = ? ORDER BY ${pkOrder(db, dataset)}`).all(scope);
const compactTables = (db) => db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name GLOB 'compact_*' AND name NOT GLOB 'compact_packed_*' ORDER BY name").all().map((r) => r.name);
const tableState = (db) => Object.fromEntries(compactTables(db).map((table) => [table, typedRows(db.prepare(`SELECT * FROM ${table} ORDER BY ${pkOrder(db, table) || 'rowid'}`).all())]));
const count = (db, table) => db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
const hasPackedTables = (db) => db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name GLOB 'compact_packed_*' AND type = 'table'").get().n;
const bytesOf = (db, names) => db.prepare(`SELECT SUM(pgsize) AS bytes FROM dbstat WHERE name IN (${names.map(() => '?').join(',')})`).get(...names).bytes ?? 0;
const closeAndCheckpoint = (db) => { db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); db.close(); };

// Identity-only hours (families unavailable, no projections), day aligned, hash-linked (verify-compact-evidence-retention.mjs).
const DAY0 = Date.parse('2026-10-09T00:00:00Z') / 1000;
const address = (n) => `0x${n.toString(16).padStart(40, '0')}`;
const hash = (n) => `0x${n.toString(16).padStart(64, '0')}`;
function identityHour(i, identities) {
  const hourStart = DAY0 + i * 3600, block = 100 + i;
  return { definitionVersion: COMPACT_DEFINITION_VERSION, chainId: 5042, sourceVersions: {}, complete: false,
    range: { kind: 'hour', hourStart, hourEnd: hourStart + 3600, firstBlock: block, lastBlock: block, parentHash: hash(block - 1), firstHash: hash(block), lastHash: hash(block) },
    network: { status: 'available', blockCount: 1, transactionCount: identities.length, uniqueActiveAddresses: identities.length, gasUsedRaw: '42000' },
    activeAddresses: identities,
    families: Object.fromEntries(Object.entries(FAMILY_FIELDS).map(([name, fields]) => [name, { status: 'unavailable', reason: 'fixture', ...Object.fromEntries(fields.map((f) => [f, null])) }])),
    registry: { uniswapV3: null } };
}
const identities = (from, n) => Array.from({ length: n }, (_, k) => address(from + k)).sort();

// A large completed day for the low-heap regression: 24 hours x 50,000 distinct identities = 1,200,000 in the day's set.
const LOW_HEAP_PER_HOUR = 50_000;
const bigAddress = (n) => `0x${createHash('sha256').update(`packed-low-heap:${n}`).digest('hex').slice(0, 40)}`;
const bigHour = (i) => identityHour(i, Array.from({ length: LOW_HEAP_PER_HOUR }, (_, k) => bigAddress(i * LOW_HEAP_PER_HOUR + k)));
const rowLine = (row) => JSON.stringify(Object.keys(row).sort().map((key) => [key, typedValue(row[key])]));

// Low-heap child, spawned by the large-day regression with --max-old-space-size=48 --max-semi-space-size=2 (the
// recovery child limits). 'collect' is the negative control: the day's rows loaded as one array, as before the fix.
// 'pack' commits the day's last hour with packing ON (the day is packed inside that hour's transaction), then streams the
// hot rows and the packed set and reports both digests. Timers cannot run during synchronous SQLite work, so the heap is
// sampled during the streamed reads; surviving the commit itself under this heap is the bound for the write side.
if (process.env.PACKED_LOW_HEAP_CHILD) {
  const db = new DatabaseSync(process.env.PACKED_LOW_HEAP_DB);
  if (process.env.PACKED_LOW_HEAP_CHILD === 'collect') {
    const rows = db.prepare('SELECT * FROM compact_daily_address_stage WHERE day_start = ? ORDER BY address').all(DAY0);
    console.log(JSON.stringify({ mode: 'collect', rows: rows.length }));
    process.exit(0);
  }
  let peakHeap = 0;
  const sample = () => { peakHeap = Math.max(peakHeap, process.memoryUsage().heapUsed); };
  const blocked = [];
  const store = createCompactStore(db, { packedShards: { config: packedShardsConfig({ COMPACT_PACKED_SHARDS_ENABLED: 'true' }), log: (line) => blocked.push(line) } });
  store.commitHour(bigHour(23));
  sample();
  const hotHash = createHash('sha256');
  let hotCount = 0;
  for (const row of db.prepare('SELECT * FROM compact_daily_address_stage WHERE day_start = ? ORDER BY address').iterate(DAY0)) {
    hotHash.update(`${rowLine(row)}\n`);
    if (++hotCount % 65_536 === 0) sample();
  }
  const packedHash = createHash('sha256');
  let packedCount = 0;
  const verified = store.packedShards.forEachRow('compact_daily_address_stage', DAY0, (row) => {
    packedHash.update(`${rowLine(row)}\n`);
    if (++packedCount % 65_536 === 0) sample();
  });
  console.log(JSON.stringify({ mode: 'pack', status: store.packedShards.status('compact_daily_address_stage', DAY0),
    hourRows: store.packedShards.status('compact_hour_addresses', DAY0 + 23 * 3600)?.rowCount, hotCount, packedCount,
    hotSha: hotHash.digest('hex'), packedSha: packedHash.digest('hex'), verified, blocked,
    heapLimit: getHeapStatistics().heap_size_limit, peakHeapUsed: peakHeap, maxRssBytes: process.resourceUsage().maxRSS * 1024 }));
  db.close();
  process.exit(0);
}

const dir = mkdtempSync(join(tmpdir(), 'compact-packed-shards-'));
const open = (name) => new DatabaseSync(join(dir, name));
const logs = [];
const ON = Object.freeze({ packedShards: { config: packedShardsConfig({ COMPACT_PACKED_SHARDS_ENABLED: 'true' }), log: (line) => logs.push(line) } });
let passed = 0;
let apiComparisons = 0;
const measurements = [];
const test = async (name, fn) => { await fn(); passed++; console.log(`PASS ${name}`); };

// Collects a (small, test-sized) packed set through the streaming reader; null when the set is not stored.
const packedRows = (store, dataset, scope) => { const rows = []; return store.packedShards.forEachRow(dataset, scope, (row) => rows.push(row)) ? rows : null; };

// The deterministic live hour of the synthetic chain (as in verify-arc-intelligence-projections.mjs).
const HOUR = 1_790_006_400;
const ORIGIN = { originNumber: 23_000_000, originTimestamp: HOUR - 1000 };
const SAFE_HEAD = ORIGIN.originNumber + 12_000;
const offlineProvider = (fetchImpl) => createProvider({ fetchImpl, minIntervalMs: 0, cooldownMs: 0, sleep: async () => {} });
const chainOf = (options = {}) => createSyntheticChain({ ...ORIGIN, poolCreatedAt: 23_002_500, ...options });
const V3 = registrySnapshot(await bootstrapV3Registry(offlineProvider(chainOf().fetchImpl), { fromBlock: ORIGIN.originNumber, toBlock: ORIGIN.originNumber + 25_000 }));
const LIVE = await processHour({ provider: offlineProvider(chainOf().fetchImpl), hourStart: HOUR, safeHead: SAFE_HEAD, v3Registry: V3 });
assert(PROJECTIONS.every((name) => LIVE.projections[name].status === 'available'), 'fixture: every projection of the live hour is available');
// Both registries bootstrapped up to the live hour, so pools and activity resolve every pool (the read model's normal state).
const V3_SCAN = await bootstrapV3Registry(offlineProvider(chainOf().fetchImpl), { fromBlock: ORIGIN.originNumber, toBlock: LIVE.range.firstBlock - 1 });
const V4_SCAN = await bootstrapV4Registry(offlineProvider(chainOf({ poolManagerDeployedAt: ORIGIN.originNumber }).fetchImpl),
  { fromBlock: ORIGIN.originNumber, toBlock: LIVE.range.firstBlock - 1 });
function liveStore(db, options) {
  const store = createCompactStore(db, options);
  store.extendRegistry(V3_SCAN);
  store.extendV4Registry(V4_SCAN);
  return store;
}

// Read-model answers of one database for every window and route the dashboard uses; a refusal is kept as its code.
function apiAnswers(path) {
  const model = createCompactReadModel({ path, DatabaseSync, now: () => (HOUR + 2 * 3600) * 1000 });
  const answer = (read) => { try { return read(); } catch (error) { return { error: error.code ?? String(error), detail: error.detail ?? null }; } };
  try {
    const out = {};
    for (const window of ['24h', '7d', '30d']) {
      out[`summary:${window}`] = answer(() => model.summary(window));
      out[`timeseries:${window}`] = answer(() => model.timeseries(window));
      out[`pools:v3:${window}`] = answer(() => model.pools('v3', window));
      out[`pools:v4:${window}`] = answer(() => model.pools('v4', window));
      out[`ecosystem:${window}`] = answer(() => model.ecosystem(window));
    }
    for (const type of ['all', 'swaps', 'adds', 'removes']) out[`activity:${type}`] = answer(() => model.activity(type));
    return out;
  } finally { model.close(); }
}
const refusals = (answers) => Object.entries(answers).filter(([, value]) => value?.error).map(([key, value]) => `${key}:${value.error}:${value.detail}`);
// The synthetic chain swaps in two V4 pools whose Initialize is not on the chain, so these four reads refuse with
// pool_registry_missing on every database of this fixture, with or without packing (pre-existing fixture behaviour).
const FIXTURE_REFUSALS = ['pools:v4:30d', 'activity:all', 'activity:swaps', 'activity:adds'].map((key) => `${key}:inconsistent_state:pool_registry_missing`);
let apiAnswered = 0;
function compareAnswers(actual, expected) {
  assert.deepEqual(refusals(expected), FIXTURE_REFUSALS);
  for (const key of Object.keys(expected)) {
    assert.deepEqual(actual[key], expected[key], key);
    apiComparisons++;
    if (!expected[key]?.error) apiAnswered++;
  }
}

const offDb = open('off.sqlite');
const offStore = liveStore(offDb);
const offCommit = offStore.commitHour(LIVE);
const onDb = open('on.sqlite');
const onStore = liveStore(onDb, ON);
const onCommit = onStore.commitHour(LIVE);

await test('configuration is strict and OFF by default', async () => {
  const defaults = { retention: false, expiry: false, hotHours: 48, maintenanceScopes: 16, maintenanceMiB: 64 };
  assert.deepEqual(packedShardsConfig({}), { enabled: false, ...defaults });
  assert.deepEqual(packedShardsConfig({ COMPACT_PACKED_SHARDS_ENABLED: 'false' }), { enabled: false, ...defaults });
  assert.deepEqual(packedShardsConfig({ COMPACT_PACKED_SHARDS_ENABLED: 'true' }), { enabled: true, ...defaults });
  assert.throws(() => packedShardsConfig({ COMPACT_PACKED_SHARDS_ENABLED: 'yes' }), (e) => e.code === 'invalid_packed_shards_enabled');
});

await test('OFF: no packed table is created, nothing is packed and the hour commits exactly as before', async () => {
  assert.equal(hasPackedTables(offDb), 0);
  assert.equal(offStore.packedShards.enabled, false);
  assert.equal(packedRows(offStore, 'compact_pool_hours', HOUR), null);
  assert.equal(offStore.packedShards.status('compact_pool_hours', HOUR), null);
  assert.equal(offStore.packedShards.packHour(HOUR), null);
  assert.deepEqual(onCommit, offCommit, 'commit outcome, checkpoint and projection report are unchanged by packing');
});

await test('ON: every final dataset of the live hour is packed and reads back as the exact typed hot rows', async () => {
  assert.equal(hasPackedTables(onDb), 7, 'sets, pieces, payloads and the (still empty) retention and expiry tables');
  for (const dataset of PACKED_HOUR_DATASETS) {
    const status = onStore.packedShards.status(dataset, HOUR);
    const rows = hot(onDb, dataset, HOUR);
    assert(status, `${dataset} packed`);
    assert.equal(status.version, PACKED_SHARDS_VERSION);
    assert.equal(status.rowCount, rows.length);
    assert.equal(typedRows(packedRows(onStore, dataset, HOUR)), typedRows(rows), `${dataset} lossless`);
  }
  assert.equal(onStore.packedShards.status('compact_pool_hours', HOUR).rowCount,
    LIVE.projections.uniswap_v3_pools.rows.length + LIVE.projections.uniswap_v4_pools.rows.length);
  assert.equal(onStore.packedShards.status('compact_hour_addresses', HOUR).rowCount, LIVE.network.uniqueActiveAddresses);
  assert.equal(onStore.packedShards.status('compact_daily_address_stage', HOUR - (HOUR % 86400)), null, 'an incomplete day is never packed');
  assert.equal(logs.length, 0);
});

await test('ON: canonical, family, projection, valuation, address and registry rows are identical to OFF', async () => {
  assert.deepEqual(tableState(onDb), tableState(offDb));
});

await test('ON: every read-model answer (summary, timeseries, pools, ecosystem, activity) is identical to OFF', async () => {
  compareAnswers(apiAnswers(join(dir, 'on.sqlite')), apiAnswers(join(dir, 'off.sqlite')));
});

await test('ON: committing the same hour again is idempotent (no new set, piece or payload)', async () => {
  const before = ['compact_packed_sets', 'compact_packed_pieces', 'compact_packed_payloads'].map((t) => count(onDb, t));
  const again = onStore.commitHour(LIVE);
  assert.equal(again.outcome, 'unchanged');
  assert.deepEqual(['compact_packed_sets', 'compact_packed_pieces', 'compact_packed_payloads'].map((t) => count(onDb, t)), before);
});

await test('ON: packed sets, pieces and payloads are immutable', async () => {
  for (const sql of ['UPDATE compact_packed_sets SET row_count = row_count', 'DELETE FROM compact_packed_sets', 'UPDATE compact_packed_pieces SET part = part',
    'DELETE FROM compact_packed_pieces', 'UPDATE compact_packed_payloads SET raw_bytes = raw_bytes', 'DELETE FROM compact_packed_payloads',
    "INSERT OR REPLACE INTO compact_packed_sets SELECT * FROM compact_packed_sets LIMIT 1"]) {
    assert.throws(() => onDb.exec(sql), /immutable_packed_shards/, sql);
  }
});

// From here on: disposable copies only.
closeAndCheckpoint(onDb);
closeAndCheckpoint(offDb);
const copyOf = (name) => { copyFileSync(join(dir, 'on.sqlite'), join(dir, name)); return open(name); };

await test('copy: hot rows rebuilt only from the packed sets reproduce every table digest and every read-model answer', async () => {
  const db = copyOf('restored.sqlite');
  const store = createCompactStore(db, ON);
  const packed = Object.fromEntries(PACKED_HOUR_DATASETS.map((dataset) => [dataset, packedRows(store, dataset, HOUR)]));
  db.exec('PRAGMA foreign_keys = OFF; BEGIN IMMEDIATE');
  for (const [dataset, rows] of Object.entries(packed)) {
    db.prepare(`DELETE FROM ${dataset} WHERE hour_start = ?`).run(HOUR);
    assert.equal(hot(db, dataset, HOUR).length, 0);
    for (const row of rows) db.prepare(`INSERT INTO ${dataset} (${Object.keys(row).join(',')}) VALUES (${Object.keys(row).map(() => '?').join(',')})`).run(...Object.values(row));
  }
  db.exec('COMMIT');
  closeAndCheckpoint(db);
  const offState = tableState(open('off.sqlite'));
  const restoredState = tableState(open('restored.sqlite'));
  assert.deepEqual(restoredState, offState);
  compareAnswers(apiAnswers(join(dir, 'restored.sqlite')), apiAnswers(join(dir, 'off.sqlite')));
});

await test('copy: corrupt payload bytes, a missing piece and a changed canonical hour all fail closed', async () => {
  const corrupt = copyOf('corrupt.sqlite');
  const store = createCompactStore(corrupt, ON);
  corrupt.exec('DROP TRIGGER compact_packed_payload_no_update');
  const piece = corrupt.prepare("SELECT payload_sha256 FROM compact_packed_pieces WHERE dataset = 'compact_pool_hours' ORDER BY part LIMIT 1").get();
  const blob = Buffer.from(corrupt.prepare('SELECT payload FROM compact_packed_payloads WHERE payload_sha256 = ?').get(piece.payload_sha256).payload);
  blob[0] ^= 1;
  corrupt.prepare('UPDATE compact_packed_payloads SET payload = ? WHERE payload_sha256 = ?').run(blob, piece.payload_sha256);
  assert.throws(() => packedRows(store, 'compact_pool_hours', HOUR), (e) => e.code === 'packed_payload_corrupt');
  corrupt.close();

  const missing = copyOf('missing.sqlite');
  const missingStore = createCompactStore(missing, ON);
  missing.exec('DROP TRIGGER compact_packed_piece_delete_guard');
  missing.prepare("DELETE FROM compact_packed_pieces WHERE dataset = 'compact_hour_addresses' AND part = 0").run();
  assert.throws(() => packedRows(missingStore, 'compact_hour_addresses', HOUR), (e) => e.code === 'packed_pieces_corrupt');
  missing.close();

  const rebound = copyOf('rebound.sqlite');
  const reboundStore = createCompactStore(rebound, ON);
  rebound.prepare('UPDATE compact_hours SET network_sha256 = ? WHERE hour_start = ?').run('0'.repeat(64), HOUR);
  assert.throws(() => packedRows(reboundStore, 'compact_pool_price_hours', HOUR), (e) => e.code === 'packed_binding_mismatch');
  rebound.close();
});

await test('a packing failure is isolated: the hour and all its rows commit, the failed set is absent and reported', async () => {
  const lines = [];
  const db = open('isolated.sqlite');
  const store = liveStore(db, { packedShards: { ...ON.packedShards, log: (line) => lines.push(line),
    beforePack: (dataset) => { if (dataset === 'compact_pool_hours') throw new Error('injected'); } } });
  const committed = store.commitHour(LIVE);
  assert.deepEqual(committed, offCommit);
  assert.equal(store.packedShards.status('compact_pool_hours', HOUR), null);
  assert(store.packedShards.status('compact_pool_price_hours', HOUR));
  assert(lines.some((line) => line.startsWith('PACKED_SHARDS_BLOCKED dataset=compact_pool_hours')), lines.join('\n'));
  closeAndCheckpoint(db);
  assert.deepEqual(tableState(open('isolated.sqlite')), tableState(open('off.sqlite')));
});

await test('repair path: pool sets wait while projections are unavailable and are packed when commitHour or commitProjectionHour upgrades them', async () => {
  const garbage = { ...LIVE, projections: { uniswap_v3_pools: 'garbage', uniswap_v4_pools: { status: 'available', rows: 'x' }, dex_activity: null } };
  for (const via of ['commitHour', 'commitProjectionHour']) {
    const db = open(`repair-${via}.sqlite`);
    const store = liveStore(db, ON);
    store.commitHour(garbage);
    for (const dataset of ['compact_pool_hours', 'compact_pool_price_hours', 'compact_pool_fee_hours']) assert.equal(store.packedShards.status(dataset, HOUR), null);
    assert(store.packedShards.status('compact_hour_addresses', HOUR), 'identities are final with the hour');
    if (via === 'commitHour') store.commitHour(LIVE); else store.commitProjectionHour(HOUR, LIVE.projections);
    for (const dataset of PACKED_HOUR_DATASETS) assert.equal(typedRows(packedRows(store, dataset, HOUR)), typedRows(hot(db, dataset, HOUR)), `${via} ${dataset}`);
    db.close();
  }
});

await test('daily stage: packed only when the UTC day is final; equal hourly and daily sets share one payload', async () => {
  const db = open('daily.sqlite');
  const store = createCompactStore(db, ON);
  const same = identities(1, 500);
  for (let i = 0; i < 24; i++) {
    store.commitHour(identityHour(i, same));
    if (i < 23) assert.equal(store.packedShards.status('compact_daily_address_stage', DAY0), null, `hour ${i}: day not final`);
  }
  const daily = store.packedShards.status('compact_daily_address_stage', DAY0);
  assert.equal(daily.rowCount, 500);
  assert.equal(typedRows(packedRows(store, 'compact_daily_address_stage', DAY0)), typedRows(hot(db, 'compact_daily_address_stage', DAY0)));
  for (let i = 0; i < 24; i++) assert.equal(store.packedShards.status('compact_hour_addresses', DAY0 + i * 3600).rowCount, 500);
  assert.equal(count(db, 'compact_packed_payloads'), 1, '24 hourly sets and the daily set store one shared payload');
  // A different identity set per hour: the day's union is its own payload, never confused with an hour.
  for (let i = 24; i < 48; i++) store.commitHour(identityHour(i, identities(1000 + i * 10, 10)));
  const next = packedRows(store, 'compact_daily_address_stage', DAY0 + 86400);
  assert.equal(next.length, 240);
  assert.equal(typedRows(next), typedRows(hot(db, 'compact_daily_address_stage', DAY0 + 86400)));
  db.close();
});

await test('recovery accessor: persistedActiveAddresses reads a packed hour when its hot identities are gone (copy only)', async () => {
  const source = open('daily.sqlite');
  closeAndCheckpoint(source);
  copyFileSync(join(dir, 'daily.sqlite'), join(dir, 'daily-copy.sqlite'));
  const db = open('daily-copy.sqlite');
  const store = createCompactStore(db, ON);
  const expected = store.persistedActiveAddresses(DAY0 + 3600);
  assert.equal(expected.length, 500);
  db.prepare('DELETE FROM compact_hour_addresses WHERE hour_start = ?').run(DAY0 + 3600);
  assert.deepEqual(store.persistedActiveAddresses(DAY0 + 3600), expected);
  db.close();
  copyFileSync(join(dir, 'daily.sqlite'), join(dir, 'daily-off.sqlite'));
  const offCopy = open('daily-off.sqlite');
  offCopy.prepare('DELETE FROM compact_hour_addresses WHERE hour_start = ?').run(DAY0 + 3600);
  assert.equal(createCompactStore(offCopy).persistedActiveAddresses(DAY0 + 3600), null, 'OFF keeps the previous behaviour');
  offCopy.close();
});

await test('bounds: 256-row and 4096-address pieces, oversized pieces split, a zero-row set, large values and NULLs stay exact', async () => {
  const db = open('bounds.sqlite');
  const store = createCompactStore(db, ON);
  const hour = DAY0;
  const many = identities(5000, 10_000);
  store.commitHour(identityHour(0, many));
  const addresses = store.packedShards.status('compact_hour_addresses', hour);
  assert.equal(addresses.pieces, Math.ceil(10_000 / PACKED_ADDRESS_ROWS));
  assert.equal(typedRows(packedRows(store, 'compact_hour_addresses', hour)), typedRows(hot(db, 'compact_hour_addresses', hour)));
  // Final projections written directly: 600 V3 rows (one with 1,200-digit amounts), 400 V4 rows (NULL liquidity amounts),
  // price paths for 300 pools and an available zero-row V4 swap-fee projection.
  const big = '9'.repeat(1200);
  const uint256 = (2n ** 256n - 1n).toString();
  db.exec('BEGIN IMMEDIATE');
  const pool = db.prepare(`INSERT INTO compact_pool_hours (hour_start, protocol, pool, swap_count, token0_in_raw, token0_out_raw, token1_in_raw, token1_out_raw,
    add_count, remove_count, poke_count, add_amount0_raw, add_amount1_raw, remove_amount0_raw, remove_amount1_raw) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  for (let n = 0; n < 600; n++) pool.run(hour, 'uniswap_v3', address(0x100000 + n), n, n < 300 ? big : uint256, '0', String(n), '1', 1, 0, 0, '2', '3', '0', '0');
  for (let n = 0; n < 400; n++) pool.run(hour, 'uniswap_v4', hash(0x200000 + n), n, '1', '0', '0', uint256, 0, 1, 2, null, null, null, null);
  const price = db.prepare(`INSERT INTO compact_pool_price_hours (hour_start, protocol, pool, swap_count, first_swap_block, last_swap_block, priced_blocks,
    close_sqrt_price_x96, close_liquidity, sqrt_price_block_sum, reserve0_block_sum, reserve1_block_sum) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`);
  for (let n = 0; n < 300; n++) price.run(hour, 'uniswap_v3', address(0x100000 + n), 1, 100, 100, 1, '79228162514264337593543950336', uint256, '1', '2', '3');
  const status = db.prepare("INSERT INTO compact_projection_hours (hour_start, projection, status, reason, row_count, rows_sha256) VALUES (?, ?, 'available', NULL, ?, 'fixture')");
  for (const [name, rows] of [['uniswap_v3_pools', 600], ['uniswap_v4_pools', 400], ['uniswap_v3_price_paths', 300], ['uniswap_v4_price_paths', 0], ['uniswap_v4_swap_fees', 0]]) status.run(hour, name, rows);
  db.exec('COMMIT');
  const report = store.packedShards.packHour(hour);
  assert.equal(report.compact_pool_hours.outcome, 'inserted');
  assert.equal(report.compact_hour_addresses.outcome, 'unchanged');
  assert(report.compact_pool_hours.pieces > Math.ceil(1000 / PACKED_COLUMN_ROWS), 'the 1,200-digit rows force halved pieces');
  const maxRaw = db.prepare('SELECT MAX(raw_bytes) AS max FROM compact_packed_payloads').get().max;
  assert(maxRaw <= PACKED_MAX_RAW_PIECE_BYTES);
  for (const dataset of ['compact_pool_hours', 'compact_pool_price_hours', 'compact_pool_fee_hours']) {
    assert.equal(typedRows(packedRows(store, dataset, hour)), typedRows(hot(db, dataset, hour)), dataset);
  }
  assert.deepEqual(packedRows(store, 'compact_pool_fee_hours', hour), []);
  assert.equal(store.packedShards.status('compact_pool_fee_hours', hour).pieces, 0);
  // Rows that are not final are never packed: an unavailable projection leaves its set unpacked.
  const later = DAY0 + 3600;
  store.commitHour(identityHour(1, identities(1, 3)));
  db.prepare("INSERT INTO compact_projection_hours (hour_start, projection, status, reason, row_count, rows_sha256) VALUES (?, 'uniswap_v4_swap_fees', 'unavailable', 'fixture', NULL, NULL)").run(later);
  assert.equal(store.packedShards.packHour(later).compact_pool_fee_hours.outcome, 'not_ready:projection_not_available');
  assert.equal(store.packedShards.status('compact_pool_fee_hours', later), null);
  db.close();
});

await test('a storage check failing in the middle of a set rolls back only that set; the hour and its identities commit', async () => {
  const lines = [];
  let calls = 0;
  // Calls 1 and 2 are the store's own checks (open, hour transaction); call 3 is the first new payload of the
  // 10,000-identity set and passes; call 4, the second payload, reports low space inside the streaming loop.
  const capacity = () => ({ freeBytes: ++calls >= 4 ? 1024 : 10 * 1024 ** 3, databaseBytes: 0 });
  const db = open('storage-blocked.sqlite');
  const store = createCompactStore(db, { archive: { config: archiveConfig({}), capacity }, packedShards: { ...ON.packedShards, log: (line) => lines.push(line) } });
  assert.equal(store.commitHour(identityHour(0, identities(9000, 10_000))).outcome, 'inserted');
  assert.equal(count(db, 'compact_hour_addresses'), 10_000);
  assert.equal(store.packedShards.status('compact_hour_addresses', DAY0), null);
  assert.deepEqual(['compact_packed_sets', 'compact_packed_pieces', 'compact_packed_payloads'].map((t) => count(db, t)), [0, 0, 0]);
  assert.deepEqual(lines, [`PACKED_SHARDS_BLOCKED dataset=compact_hour_addresses scope=${DAY0} reason=storage:storage_low_space`]);
  db.close();
});

// Synthetic chain addresses and amounts are sequential and compress far better than mainnet data, so they are not
// measured. Random 20-byte identities (incompressible, like real addresses) give an honest check of the identity codec.
await test('measurement (random identities, not mainnet): hourly + daily identity rows versus packed payload pages', async () => {
  const db = open('random.sqlite');
  const store = createCompactStore(db, ON);
  // A different identity set every hour, as on mainnet: the day's union cannot share a payload with any single hour.
  for (let i = 0; i < 24; i++) store.commitHour(identityHour(i, Array.from({ length: 5000 }, () => `0x${randomBytes(20).toString('hex')}`).sort()));
  assert.equal(store.packedShards.status('compact_daily_address_stage', DAY0).rowCount, 24 * 5000);
  const hotBytes = bytesOf(db, ['compact_hour_addresses', 'compact_daily_address_stage']);
  const packedBytes = bytesOf(db, ['compact_packed_payloads']);
  measurements.push({ fixture: '24 hours x 5,000 different random identities; day union 120,000 (no hourly/daily sharing possible)',
    hotRowPageBytes: hotBytes, packedPayloadPageBytes: packedBytes, payloads: count(db, 'compact_packed_payloads'),
    savingPercent: Number(((1 - packedBytes / hotBytes) * 100).toFixed(3)) });
  assert(packedBytes < hotBytes);
  db.close();
});

await test('low heap: a 1,200,000-identity completed day is packed inside its hour transaction and verified within a 48 MiB old space', async () => {
  const path = join(dir, 'low-heap.sqlite');
  const db = new DatabaseSync(path);
  const store = createCompactStore(db); // packing OFF while the day's first 23 hours are written
  for (let i = 0; i < 23; i++) store.commitHour(bigHour(i));
  closeAndCheckpoint(db);
  const child = (mode) => spawnSync(process.execPath, ['--max-old-space-size=48', '--max-semi-space-size=2', fileURLToPath(import.meta.url)],
    { env: { ...process.env, PACKED_LOW_HEAP_CHILD: mode, PACKED_LOW_HEAP_DB: path }, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  const control = child('collect');
  assert.notEqual(control.status, 0, 'negative control: the day loaded as one array must not fit this heap');
  assert.match(control.stderr, /heap out of memory|Allocation failed/i);
  const packed = child('pack');
  assert.equal(packed.status, 0, packed.stderr);
  const result = JSON.parse(packed.stdout.trim().split('\n').at(-1));
  const day = 24 * LOW_HEAP_PER_HOUR;
  assert.equal(result.status.rowCount, day);
  assert.equal(result.status.pieces, Math.ceil(day / PACKED_ADDRESS_ROWS));
  assert.equal(result.hourRows, LOW_HEAP_PER_HOUR);
  assert.deepEqual([result.hotCount, result.packedCount, result.verified.rowCount], [day, day, day]);
  assert.equal(result.packedSha, result.hotSha, 'streamed packed rows equal the streamed hot rows');
  assert.equal(result.status.rowsSha256, result.hotSha, 'the stored set digest equals an independent digest of the hot rows');
  assert.deepEqual(result.blocked, []);
  assert(result.heapLimit <= 64 * 1024 * 1024);
  measurements.push({ fixture: 'low-heap completed day (24 x 50,000 distinct identities)', rows: day, pieces: result.status.pieces,
    heapLimitBytes: result.heapLimit, peakSampledHeapUsedBytes: result.peakHeapUsed, maxRssBytes: result.maxRssBytes,
    negativeControl: 'one-array load of the same day: heap out of memory' });
});

console.log(JSON.stringify({ measurements }, null, 1));
rmSync(dir, { recursive: true, force: true });
console.log(`COMPACT_PACKED_SHARDS: PASS (${passed} scenarios, ${apiComparisons} read-model comparisons: ${apiAnswered} answered, `
  + `${apiComparisons - apiAnswered} identical fixture refusals; Node ${process.version}; disposable SQLite, no network)`);
