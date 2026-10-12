// Node 24: disposable SQLite files only. No network, no production database, no RPC.
// Verifies packed-shards retention (server/compact/packed-shards.js, COMPACT_PACKED_RETENTION_ENABLED): OFF by default;
// when ON, hot rows are removed only for packed scopes outside the hot window whose set was committed by an earlier
// transaction, verifies now and equals the hot rows exactly (pool data also needs final valuations). Two databases get
// the same deterministic 200 hours (identities, pool, price-path and fee rows, statuses, valuations, registry): A without
// packing, B with packing and retention. Every 24H/7D/30D read-model answer, every store accessor, the token DEX
// correlation and the 30-day identity union must be identical; corrupt, missing or mismatching packed data must keep the
// hot rows; markers are immutable; replays never reinsert; disk use is measured; a 1,200,000-identity day is pruned under
// a 48 MiB old-space heap (child process). Every deletion below happens in files this script creates.
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getHeapStatistics } from 'node:v8';
import { FAMILY_FIELDS } from '../server/compact/families.js';
import { correlateDex } from '../server/compact/intelligence-store.js';
import { createPackedShards, PACKED_DATASETS, PACKED_MIN_HOT_HOURS, packedShardsConfig } from '../server/compact/packed-shards.js';
import { createCompactReadModel } from '../server/compact/read-model.js';
import { COMPACT_DEFINITION_VERSION } from '../server/compact/sources.js';
import { createCompactStore } from '../server/compact/store.js';
import { VALUATIONS } from '../server/compact/valuation.js';

globalThis.fetch = async () => { throw new Error('external_network_forbidden'); };
for (const key of ['COMPACT_PACKED_SHARDS_ENABLED', 'COMPACT_PACKED_RETENTION_ENABLED', 'COMPACT_PACKED_HOT_HOURS', 'COMPACT_PACKED_MAINTENANCE_SCOPES',
  'COMPACT_EVIDENCE_ARCHIVE_ENABLED']) delete process.env[key];

const HOUR = 3600;
const DAY = 24 * HOUR;
const DAY0 = Date.parse('2026-09-01T00:00:00Z') / 1000;
const HOURS = 200;
const IDENTITIES = 300;
const IDENTITY_POOL = 4000;
const NEWEST = DAY0 + (HOURS - 1) * HOUR;
const CUTOFF = NEWEST - PACKED_MIN_HOT_HOURS * HOUR; // the newest hour retention may remove
const PACK = packedShardsConfig({ COMPACT_PACKED_SHARDS_ENABLED: 'true' });
const RETAIN = packedShardsConfig({ COMPACT_PACKED_SHARDS_ENABLED: 'true', COMPACT_PACKED_RETENTION_ENABLED: 'true', COMPACT_PACKED_MAINTENANCE_SCOPES: '32' });
const HOT_TABLES = Object.keys(PACKED_DATASETS);
const PACKED_TABLES = ['compact_packed_payloads', 'compact_packed_sets', 'compact_packed_pieces', 'compact_packed_pruned', 'compact_packed_pool_swaps'];

const sha = (text) => createHash('sha256').update(text).digest('hex');
const address = (label) => `0x${sha(label).slice(0, 40)}`;
const hash = (n) => `0x${n.toString(16).padStart(64, '0')}`;
const USDC = '0x3600000000000000000000000000000000000000';
const EURC = '0xbef5f6d51cb62b58e6a8f77868681825c6fe21c1';
const ZERO = `0x${'0'.repeat(40)}`;
const TOKEN = address('retention-token-shared'); // paired with several pools: the DEX correlation subject

// Deterministic PRNG (mulberry32): A and B receive exactly the same rows.
function random(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6D2B79F5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const digits = (next, length) => { let out = String(1 + Math.floor(next() * 9)); while (out.length < length) out += Math.floor(next() * 10); return out; };

// Identity-only hours (families unavailable), one block each, hash-linked (as in verify-compact-packed-shards.mjs).
function identityHour(i, identities) {
  const hourStart = DAY0 + i * HOUR, block = 100 + i;
  return { definitionVersion: COMPACT_DEFINITION_VERSION, chainId: 5042, sourceVersions: {}, complete: false,
    range: { kind: 'hour', hourStart, hourEnd: hourStart + HOUR, firstBlock: block, lastBlock: block, parentHash: hash(block - 1), firstHash: hash(block), lastHash: hash(block) },
    network: { status: 'available', blockCount: 1, transactionCount: identities.length, uniqueActiveAddresses: identities.length, gasUsedRaw: '42000' },
    activeAddresses: identities,
    families: Object.fromEntries(Object.entries(FAMILY_FIELDS).map(([name, fields]) => [name, { status: 'unavailable', reason: 'fixture', ...Object.fromEntries(fields.map((f) => [f, null])) }])),
    registry: { uniswapV3: null } };
}

// 48 registry pools (V3 and V4, USDC-paired): created before the first hour, in hours retention removes and in hot hours.
const POOLS = Array.from({ length: 48 }, (_, k) => {
  const v4 = k % 2 === 1;
  const createdHour = k < 6 ? -3 : (k * 37) % (HOURS - 10);
  return { k, v4, protocol: v4 ? 'uniswap_v4' : 'uniswap_v3', kind: v4 ? 'uniswap_v4_pool' : 'uniswap_v3_pool',
    pool: v4 ? `0x${sha(`retention-pool-${k}`)}` : address(`retention-pool-${k}`),
    token: k % 6 === 0 || k % 6 === 1 ? TOKEN : k % 6 === 3 ? EURC : address(`retention-token-${k}`), createdHour };
});

// One hour of fixture data: 300 identities drawn from 4,000 (so windows overlap), and the pool, price-path and fee rows of
// the pools active in that hour (a pool's creation hour always has a row unless k % 4 === 2; swap_count 0 = liquidity only).
function hourFixture(i) {
  const next = random(i + 1);
  const ids = new Set();
  while (ids.size < IDENTITIES) ids.add(address(`retention-identity-${Math.floor(next() * IDENTITY_POOL)}`));
  const hourStart = DAY0 + i * HOUR, block = 100 + i;
  const pools = [], prices = [], fees = [];
  for (const p of POOLS) {
    if (i < p.createdHour) continue;
    if (i === p.createdHour ? p.k % 4 === 2 : next() < 0.55) continue;
    const swaps = Math.floor(next() * 12);
    pools.push([hourStart, p.protocol, p.pool, swaps, digits(next, 24), digits(next, 24), digits(next, 30), digits(next, 30),
      Math.floor(next() * 3), Math.floor(next() * 3), Math.floor(next() * 2),
      ...(p.v4 ? [null, null, null, null] : [digits(next, 20), digits(next, 20), digits(next, 20), digits(next, 20)])]);
    if (swaps > 0) {
      prices.push([hourStart, p.protocol, p.pool, swaps, block, block, 1, digits(next, 29), digits(next, 22), digits(next, 29), digits(next, 26), digits(next, 26)]);
      if (p.v4) fees.push([hourStart, p.pool, swaps, digits(next, 12), digits(next, 12), digits(next, 18), digits(next, 18)]);
    }
  }
  return { i, result: identityHour(i, [...ids].sort()), pools, prices, fees, next };
}

const bind = (row) => row.map((value) => (typeof value === 'number' ? BigInt(value) : value));
function writeRows(db, sql, rows) { const statement = db.prepare(sql); for (const row of rows) statement.run(...bind(row)); }
function writeRegistry(db) {
  writeRows(db, 'INSERT INTO compact_registry (kind, address, created_block, created_log_index, created_tx, meta_json) VALUES (?, ?, ?, ?, ?, ?)',
    POOLS.map((p) => [p.kind, p.pool, 100 + p.createdHour, p.k, hash(10_000 + p.k), JSON.stringify(p.v4
      ? { currency0: USDC, currency1: p.token, fee: 3000, tickSpacing: 60, hooks: ZERO } : { token0: USDC, token1: p.token, fee: 500, tickSpacing: 10 })]));
  writeRows(db, 'INSERT INTO compact_registry_coverage (kind, from_block, through_block, through_hash) VALUES (?, 1, 1000000000, ?)',
    [['uniswap_v3_pool', hash(1)], ['uniswap_v4_pool', hash(2)]]);
}
// The hour's projection rows, statuses, valuations and valued rows, written in their own transaction after the hour
// commits, as a projection backfill would (B packs them in a later hour's maintenance pass).
function writeHourRows(db, { result, pools, prices, fees, next }) {
  const hour = result.range.hourStart;
  const count = (protocol, rows) => rows.filter((row) => row[1] === protocol).length;
  db.exec('BEGIN IMMEDIATE');
  try {
    writeRows(db, `INSERT INTO compact_pool_hours VALUES (${Array(15).fill('?').join(', ')})`, pools);
    writeRows(db, `INSERT INTO compact_pool_price_hours VALUES (${Array(12).fill('?').join(', ')})`, prices);
    writeRows(db, 'INSERT INTO compact_pool_fee_hours VALUES (?, ?, ?, ?, ?, ?, ?)', fees);
    writeRows(db, "INSERT INTO compact_projection_hours VALUES (?, ?, 'available', NULL, ?, ?)", [['uniswap_v3_pools', count('uniswap_v3', pools)],
      ['uniswap_v4_pools', count('uniswap_v4', pools)], ['uniswap_v3_price_paths', count('uniswap_v3', prices)],
      ['uniswap_v4_price_paths', count('uniswap_v4', prices)], ['uniswap_v4_swap_fees', fees.length], ['dex_activity', 0]]
      .map(([name, rows]) => [hour, name, rows, sha(`${hour}:${name}`)]));
    writeRows(db, "INSERT INTO compact_valuation_hours VALUES (?, ?, 'available', NULL, 2, ?)", VALUATIONS.map((name) => [hour, name, sha(`${hour}:${name}`)]));
    writeRows(db, 'INSERT INTO compact_token_price_hours VALUES (?, ?, ?, ?, ?, ?, ?)', [[hour, EURC, digits(next, 18), 'uniswap_v3', POOLS[3].pool, digits(next, 11), 1]]);
    for (const table of ['compact_dex_volume_hours', 'compact_dex_fee_hours']) {
      writeRows(db, `INSERT INTO ${table} VALUES (?, ?, ?, ?, ?)`, ['uniswap_v3', 'uniswap_v4'].map((protocol) => [hour, protocol, digits(next, 10), count(protocol, prices), 0]));
    }
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}

// Typed, order-preserving text of rows: SQLite NULL/INTEGER/TEXT/BLOB stay distinguishable.
const typedValue = (value) => (value === null ? ['null'] : ArrayBuffer.isView(value) ? ['blob', Buffer.from(value).toString('hex')]
  : typeof value === 'number' ? ['integer', String(value)] : typeof value === 'bigint' ? ['integer', value.toString()] : ['text', value]);
const typedRows = (rows) => JSON.stringify(rows.map((row) => Object.entries(row).map(([key, value]) => [key, typedValue(value)])));
const pkOrder = (db, table) => db.prepare(`PRAGMA table_info(${table})`).all().filter((c) => c.pk).sort((a, b) => a.pk - b.pk).map((c) => c.name).join(',');
const hot = (db, dataset, scope) => db.prepare(`SELECT * FROM ${dataset} WHERE ${PACKED_DATASETS[dataset].scope} = ? ORDER BY ${pkOrder(db, dataset)}`).all(scope);
const hotCount = (db, dataset, scope) => db.prepare(`SELECT COUNT(*) AS n FROM ${dataset} WHERE ${PACKED_DATASETS[dataset].scope} = ?`).get(scope).n;
const count = (db, table) => db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
const markers = (db) => db.prepare('SELECT dataset, scope_start FROM compact_packed_pruned ORDER BY dataset, scope_start').all().map((r) => `${r.dataset}:${r.scope_start}`);
const isMarked = (db, dataset, scope) => Boolean(db.prepare('SELECT 1 FROM compact_packed_pruned WHERE dataset = ? AND scope_start = ?').get(dataset, scope));
const packedRows = (store, dataset, scope) => { const rows = []; return store.packedShards.forEachRow(dataset, scope, (row) => rows.push(row)) ? rows : null; };
const bytesOf = (db, names) => db.prepare(`SELECT SUM(pgsize) AS bytes FROM dbstat WHERE name IN (${names.map(() => '?').join(',')})`).get(...names).bytes ?? 0;
const pages = (db) => ({ pageCount: db.prepare('PRAGMA page_count').get().page_count, freelist: db.prepare('PRAGMA freelist_count').get().freelist_count });
const scopesOf = (dataset) => (PACKED_DATASETS[dataset].scope === 'day_start'
  ? Array.from({ length: Math.ceil(HOURS / 24) }, (_, d) => DAY0 + d * DAY) : Array.from({ length: HOURS }, (_, i) => DAY0 + i * HOUR));
const lastHourOf = (dataset, scope) => (PACKED_DATASETS[dataset].scope === 'day_start' ? scope + DAY - HOUR : scope);

// Low-heap child: prunes the large completed day (and its hours) in one maintenance transaction under the recovery heap
// limits, then streams the packed day set back. Synchronous SQLite work cannot be sampled, so surviving the transaction
// under this heap is the write-side bound; the streamed read is sampled.
if (process.env.RETENTION_LOW_HEAP_CHILD) {
  const db = new DatabaseSync(process.env.RETENTION_LOW_HEAP_DB);
  const blocked = [];
  const store = createCompactStore(db, { packedShards: { config: RETAIN, log: (line) => blocked.push(line) } });
  const started = performance.now();
  // Passes until nothing is left to prune: each pass stays within its write-ahead-log budget (64 MiB by default).
  const report = { pruned: 0, passes: 0 };
  for (let pass; (pass = store.packedShards.maintain({ limit: 64 })).pruned; report.passes++) report.pruned += pass.pruned;
  const pruneMs = Math.round(performance.now() - started);
  let peakHeap = process.memoryUsage().heapUsed;
  let rows = 0;
  const verified = store.packedShards.forEachRow('compact_daily_address_stage', DAY0, () => {
    if (++rows % 65_536 === 0) peakHeap = Math.max(peakHeap, process.memoryUsage().heapUsed);
  });
  console.log(JSON.stringify({ report, pruneMs, blocked, pruned: store.packedShards.pruned('compact_daily_address_stage', DAY0),
    hotStage: db.prepare('SELECT COUNT(*) AS n FROM compact_daily_address_stage WHERE day_start = ?').get(DAY0).n,
    hotHour: db.prepare('SELECT COUNT(*) AS n FROM compact_hour_addresses WHERE hour_start = ?').get(DAY0 + 23 * HOUR).n,
    marker: db.prepare("SELECT row_count FROM compact_packed_pruned WHERE dataset = 'compact_daily_address_stage' AND scope_start = ?").get(DAY0),
    rows, verified, heapLimit: getHeapStatistics().heap_size_limit, peakHeapUsed: peakHeap, maxRssBytes: process.resourceUsage().maxRSS * 1024 }));
  db.close();
  process.exit(0);
}

const dir = mkdtempSync(join(tmpdir(), 'compact-packed-retention-'));
const pathOf = (name) => join(dir, name);
const open = (name) => new DatabaseSync(pathOf(name));
// A file copy of a live database: its WAL is checkpointed into the main file first.
const copyOf = (db, from, to) => { db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); copyFileSync(pathOf(from), pathOf(to)); return open(to); };
let passed = 0;
let comparisons = 0;
const measurements = {};
const test = async (name, fn) => { await fn(); passed++; console.log(`PASS ${name}`); };

const logsA = [], logsB = [];
const dbA = open('a.sqlite');
const storeA = createCompactStore(dbA, { packedShards: { log: (line) => logsA.push(line) } });
const dbB = open('b.sqlite');
const storeB = createCompactStore(dbB, { packedShards: { config: RETAIN, log: (line) => logsB.push(line) } });
writeRegistry(dbA);
writeRegistry(dbB);
const buildStarted = performance.now();
for (let i = 0; i < HOURS; i++) {
  for (const [db, store] of [[dbA, storeA], [dbB, storeB]]) {
    const fixture = hourFixture(i); // a fresh copy per database (its PRNG is consumed by writeHourRows)
    assert.equal(store.commitHour(fixture.result).outcome, 'inserted');
    writeHourRows(db, fixture);
  }
}
const liveMarkers = markers(dbB).length;
// Drain what the per-hour passes (32 scopes each) left: pack the last projection rows, prune every eligible scope.
const drains = [];
for (let report; (report = storeB.packedShards.maintain({ limit: 256 })).pruned || report.packed;) drains.push(report);
measurements.build = { hours: HOURS, ms: Math.round(performance.now() - buildStarted), markersAfterLiveHours: liveMarkers, drainPasses: drains.length };

await test('configuration: strict, retention OFF by default, requires packing, a hot window of at least 48 hours', async () => {
  assert.deepEqual(packedShardsConfig({}), { enabled: false, retention: false, expiry: false, hotHours: 48, maintenanceScopes: 16, maintenanceMiB: 64 });
  assert.deepEqual(RETAIN, { enabled: true, retention: true, expiry: false, hotHours: 48, maintenanceScopes: 32, maintenanceMiB: 64 });
  assert.equal(packedShardsConfig({ COMPACT_PACKED_SHARDS_ENABLED: 'true', COMPACT_PACKED_RETENTION_ENABLED: 'true', COMPACT_PACKED_HOT_HOURS: '72' }).hotHours, 72);
  const refused = (env, code) => assert.throws(() => packedShardsConfig(env), (error) => error.code === code, code);
  refused({ COMPACT_PACKED_RETENTION_ENABLED: 'true' }, 'packed_retention_requires_packing');
  refused({ COMPACT_PACKED_SHARDS_ENABLED: 'false', COMPACT_PACKED_RETENTION_ENABLED: 'true' }, 'packed_retention_requires_packing');
  refused({ COMPACT_PACKED_RETENTION_ENABLED: 'yes' }, 'invalid_packed_retention_enabled');
  for (const value of ['47', '0', '-48', '48.5', 'abc', '9601']) refused({ COMPACT_PACKED_HOT_HOURS: value }, 'invalid_packed_hot_hours');
  for (const value of ['0', '257', 'x']) refused({ COMPACT_PACKED_MAINTENANCE_SCOPES: value }, 'invalid_packed_maintenance_scopes');
});

await test('OFF (default) and packing-only: nothing is ever removed; maintain is a no-op', async () => {
  assert.equal(storeA.packedShards.retention, false);
  assert.equal(storeA.packedShards.maintain(), null);
  assert.deepEqual(logsA, []);
  assert.equal(count(dbA, 'sqlite_master WHERE name GLOB \'compact_packed_*\''), 0, 'OFF creates no packed table');
  const db = copyOf(dbA, 'a.sqlite', 'pack-only.sqlite');
  const store = createCompactStore(db, { packedShards: { config: PACK, log: () => {} } });
  assert.equal(store.packedShards.maintain(), null);
  for (let i = 0; i < 4; i++) store.packedShards.packHour(DAY0 + i * HOUR);
  const extra = hourFixture(HOURS);
  store.commitHour(extra.result);
  writeHourRows(db, extra);
  assert.equal(count(db, 'compact_packed_pruned'), 0);
  assert(count(db, 'compact_packed_sets') > 0, 'sets are packed');
  for (const dataset of HOT_TABLES.filter((name) => PACKED_DATASETS[name].scope === 'hour_start')) {
    assert.equal(count(db, `${dataset} WHERE hour_start <= ${NEWEST}`), count(dbA, dataset), `${dataset}: every earlier hot row kept`);
  }
  db.close();
});

await test('ON: exactly the packed scopes outside the 48-hour window are pruned; every other hot row stays', async () => {
  const expected = [];
  for (const dataset of HOT_TABLES) for (const scope of scopesOf(dataset)) if (lastHourOf(dataset, scope) <= CUTOFF) expected.push(`${dataset}:${scope}`);
  assert.deepEqual(markers(dbB).sort(), expected.sort());
  assert.equal(expected.length, 4 * (HOURS - PACKED_MIN_HOT_HOURS) + 6);
  assert.deepEqual(logsB, [], 'no retention or packing failure');
  for (const dataset of HOT_TABLES) {
    for (const scope of scopesOf(dataset)) {
      const marked = isMarked(dbB, dataset, scope);
      assert.equal(hotCount(dbB, dataset, scope), marked ? 0 : hotCount(dbA, dataset, scope), `${dataset}:${scope}`);
      if (lastHourOf(dataset, scope) > CUTOFF) assert(!marked, 'the hot window is never pruned');
    }
  }
  assert(measurements.build.markersAfterLiveHours > 0.9 * expected.length, 'the hourly passes keep up; the drain only finishes the tail');
});

await test('ON: every pruned scope is read back losslessly (typed rows equal to A\'s hot rows); the marker records them', async () => {
  for (const key of markers(dbB)) {
    const [dataset, scopeText] = key.split(':');
    const scope = Number(scopeText);
    const rows = hot(dbA, dataset, scope);
    assert.equal(typedRows(packedRows(storeB, dataset, scope)), typedRows(rows), key);
    const marker = dbB.prepare('SELECT row_count, rows_sha256 FROM compact_packed_pruned WHERE dataset = ? AND scope_start = ?').get(dataset, scope);
    const set = dbB.prepare('SELECT row_count, rows_sha256 FROM compact_packed_sets WHERE dataset = ? AND scope_start = ?').get(dataset, scope);
    assert.deepEqual(marker, set);
    assert.equal(marker.row_count, rows.length);
  }
});

// Read-model answers of one database for every window and route the dashboard uses; a refusal is kept as its code.
function apiAnswers(path) {
  const model = createCompactReadModel({ path, DatabaseSync, now: () => (NEWEST + HOUR + 60) * 1000 });
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

await test('read model: every 24H/7D/30D answer is identical; 7D and 30D pools are served from hot + packed rows', async () => {
  dbA.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  dbB.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  const a = apiAnswers(pathOf('a.sqlite'));
  const b = apiAnswers(pathOf('b.sqlite'));
  for (const key of Object.keys(a)) { assert.deepEqual(b[key], a[key], key); comparisons++; }
  for (const key of ['pools:v3:24h', 'pools:v4:24h', 'pools:v3:7d', 'pools:v4:7d', 'pools:v3:30d', 'pools:v4:30d']) {
    assert.equal(a[key].status, 'available', `${key} answers (not a refusal on both sides)`);
    assert.equal(a[key].pools.length, 10, key);
  }
  const reader = createPackedShards(dbB, { config: { enabled: false } });
  assert.equal(reader.prunedScopes('compact_pool_hours', NEWEST - 23 * HOUR, NEWEST).length, 0, '24H never touches a pruned hour');
  assert.equal(reader.prunedScopes('compact_pool_hours', NEWEST - 167 * HOUR, NEWEST).length, 168 - PACKED_MIN_HOT_HOURS);
  assert.equal(reader.prunedScopes('compact_pool_hours', DAY0, NEWEST).length, HOURS - PACKED_MIN_HOT_HOURS);
  measurements.readModel = { answers: Object.keys(a).length, refusedOnBoth: Object.entries(a).filter(([, v]) => v?.error).map(([k, v]) => `${k}:${v.error}`) };
});

await test('read model: a corrupt packed set fails the read closed (no partial or zero answer)', async () => {
  const db = copyOf(dbB, 'b.sqlite', 'b-corrupt-read.sqlite');
  const hour = DAY0 + 100 * HOUR;
  db.exec('DROP TRIGGER compact_packed_payload_no_update');
  db.prepare(`UPDATE compact_packed_payloads SET payload = zeroblob(length(payload)) WHERE payload_sha256 =
    (SELECT payload_sha256 FROM compact_packed_pieces WHERE dataset = 'compact_pool_hours' AND scope_start = ? AND part = 0)`).run(hour);
  db.close();
  const model = createCompactReadModel({ path: pathOf('b-corrupt-read.sqlite'), DatabaseSync, now: () => (NEWEST + HOUR + 60) * 1000 });
  try {
    assert.throws(() => model.pools('v3', '7d'), (error) => error.code === 'read_failed' && error.detail === 'packed_payload_corrupt');
    assert.equal(model.pools('v3', '24h').status, 'available', 'windows without pruned hours are unaffected');
  } finally { model.close(); }
});

await test('store accessors: pool, price-path and fee rows, 24H TVL top pools and persisted identities equal A for every hour', async () => {
  for (let i = 0; i < HOURS; i++) {
    const hour = DAY0 + i * HOUR;
    for (const protocol of ['uniswap_v3', 'uniswap_v4']) {
      assert.deepEqual(storeB.poolHours(hour, protocol), storeA.poolHours(hour, protocol));
      assert.deepEqual(storeB.pricePaths(hour, protocol), storeA.pricePaths(hour, protocol));
      assert.deepEqual(storeB.topPoolsOf(protocol, hour, 10), storeA.topPoolsOf(protocol, hour, 10), `topPoolsOf ${protocol} ${i}`);
    }
    assert.deepEqual(storeB.swapFees(hour), storeA.swapFees(hour));
    const persisted = storeA.persistedActiveAddresses(hour);
    assert.equal(persisted.length, IDENTITIES);
    assert.deepEqual(storeB.persistedActiveAddresses(hour), persisted);
    comparisons += 8;
  }
  assert(storeA.poolHours(DAY0 + 10 * HOUR, 'uniswap_v3').length > 0 && isMarked(dbB, 'compact_pool_hours', DAY0 + 10 * HOUR));
});

await test('token DEX correlation: early swaps and observed swap counts equal A for every end block (both packed paths)', async () => {
  const pools = POOLS.filter((p) => p.token === TOKEN);
  assert(pools.some((p) => p.createdHour >= 0 && DAY0 + p.createdHour * HOUR <= CUTOFF), 'a correlated pool was created in a pruned hour');
  for (const endBlock of [100 + HOURS - 1, 100 + 180, 100 + 120, 100 + 60, 100 + 10, 99]) {
    for (const token of [TOKEN, EURC]) {
      const a = correlateDex(dbA, token, endBlock);
      assert.deepEqual(correlateDex(dbB, token, endBlock), a, `${token}@${endBlock}`);
      comparisons++;
      if (endBlock === 100 + HOURS - 1 && token === TOKEN) {
        assert(a.observedPools.some((pool) => pool.earlyActivity.status === 'available' && pool.earlyActivity.swapCount > 0
          && Date.parse(pool.earlyActivity.hourStart) / 1000 <= CUTOFF), 'early swaps of a pruned creation hour');
        assert(a.observedPools.every((pool) => Number.isSafeInteger(pool.observedSwapCount)), 'every pool has stored swaps');
      }
    }
  }
});

await test('30-day requirement: unique identities over any window are exact from hot + packed sets (packed sets are never removed)', async () => {
  const union = (from, to) => {
    const seen = new Set();
    for (let hour = from; hour <= to; hour += HOUR) {
      if (isMarked(dbB, 'compact_hour_addresses', hour)) storeB.packedShards.forEachRow('compact_hour_addresses', hour, (row) => seen.add(Buffer.from(row.address).toString('hex')));
      else for (const row of hot(dbB, 'compact_hour_addresses', hour)) seen.add(Buffer.from(row.address).toString('hex'));
    }
    return seen.size;
  };
  const exact = (from, to) => dbA.prepare('SELECT COUNT(DISTINCT address) AS n FROM compact_hour_addresses WHERE hour_start BETWEEN ? AND ?').get(from, to).n;
  for (const [from, to] of [[DAY0, NEWEST], [NEWEST - 167 * HOUR, NEWEST], [DAY0 + 5 * HOUR, DAY0 + 130 * HOUR], [NEWEST - 23 * HOUR, NEWEST]]) {
    assert.equal(union(from, to), exact(from, to));
    comparisons++;
  }
  for (const scope of scopesOf('compact_daily_address_stage')) {
    const daily = dbB.prepare('SELECT active_addresses FROM compact_daily_active_addresses WHERE day_start = ?').get(scope);
    if (!isMarked(dbB, 'compact_daily_address_stage', scope)) continue;
    assert.equal(storeB.packedShards.forEachRow('compact_daily_address_stage', scope).rowCount, daily.active_addresses);
  }
  for (const name of ['compact_packed_sets', 'compact_packed_pieces', 'compact_packed_payloads']) {
    assert.throws(() => dbB.exec(`DELETE FROM ${name}`), /immutable_packed_shards/);
  }
  measurements.uniqueIdentities = { allHours: exact(DAY0, NEWEST), last168Hours: exact(NEWEST - 167 * HOUR, NEWEST) };
});

await test('pool swap totals of pruned hours equal a recomputation from their packed sets', async () => {
  const expected = new Map();
  for (const key of markers(dbB).filter((k) => k.startsWith('compact_pool_hours:'))) {
    storeB.packedShards.forEachRow('compact_pool_hours', Number(key.split(':')[1]), (row) => {
      const entry = expected.get(`${row.protocol}:${row.pool}`) ?? { swaps: 0, rows: 0 };
      entry.swaps += row.swap_count;
      entry.rows++;
      expected.set(`${row.protocol}:${row.pool}`, entry);
    });
  }
  const stored = new Map(dbB.prepare('SELECT * FROM compact_packed_pool_swaps').all().map((row) => [`${row.protocol}:${row.pool}`, { swaps: row.swap_count, rows: row.row_count }]));
  assert.deepEqual(stored, expected);
});

await test('safety: a set never authorizes removal in the transaction that wrote it; the next transaction may', async () => {
  const db = copyOf(dbA, 'a.sqlite', 'two-phase.sqlite');
  const logs = [];
  const store = createCompactStore(db, { packedShards: { config: RETAIN, log: (line) => logs.push(line) } });
  const sets = () => db.prepare('SELECT dataset, scope_start FROM compact_packed_sets').all().map((r) => `${r.dataset}:${r.scope_start}`);
  const first = store.packedShards.maintain({ limit: 64 });
  assert.deepEqual([first.pruned, first.packed, first.failed], [0, 64, []], 'first pass: packs only');
  const packedByFirst = new Set(sets());
  const second = store.packedShards.maintain({ limit: 64 });
  assert(second.pruned > 0 && second.failed.length === 0, 'second pass removes hot rows');
  assert.equal(markers(db).length, second.pruned);
  assert(markers(db).every((key) => packedByFirst.has(key)), 'only sets an earlier transaction committed');
  // Module level: pack an old hour, then run maintenance in the SAME transaction. This instance also asks for a 1-hour
  // window, which is raised to the 48-hour minimum.
  const packed = createPackedShards(db, { config: { ...RETAIN, hotHours: 1 }, log: (line) => logs.push(line) });
  const hour = DAY0 + 150 * HOUR;
  assert.equal(db.prepare("SELECT 1 FROM compact_packed_sets WHERE dataset = 'compact_hour_addresses' AND scope_start = ?").get(hour), undefined);
  packed.begin();
  db.exec('BEGIN IMMEDIATE');
  assert.throws(() => packed.begin(), (error) => error.code === 'packed_begin_requires_closed_transaction');
  assert.equal(packed.packHour(hour).compact_hour_addresses.outcome, 'inserted');
  packed.maintain(NEWEST, { limit: 2000 });
  assert.equal(isMarked(db, 'compact_hour_addresses', hour), false, 'not pruned by the transaction that packed it');
  db.exec('COMMIT');
  packed.begin();
  db.exec('BEGIN IMMEDIATE');
  packed.maintain(NEWEST, { limit: 2000 });
  db.exec('COMMIT');
  assert.equal(isMarked(db, 'compact_hour_addresses', hour), true, 'pruned by a later transaction');
  assert(markers(db).every((key) => Number(key.split(':')[1]) <= CUTOFF), 'a smaller configured window never goes below 48 hours');
  assert.deepEqual(logs, []);
  db.close();
});

await test('safety: corrupt payload, missing piece or changed hot row keep the hot rows (logged); missing hot rows or non-final valuations are never attempted', async () => {
  const db = copyOf(dbA, 'a.sqlite', 'unsafe.sqlite');
  const hours = Object.fromEntries([10, 11, 12, 13, 14, 20].map((i) => [i, DAY0 + i * HOUR]));
  const packOnly = createCompactStore(db, { packedShards: { config: PACK, log: () => {} } });
  for (const hour of Object.values(hours)) packOnly.packedShards.packHour(hour);
  const logs = [];
  const store = createCompactStore(db, { packedShards: { config: RETAIN, log: (line) => logs.push(line) } }); // re-creates the triggers
  const before = Object.fromEntries(HOT_TABLES.map((t) => [t, count(db, t)]));
  db.exec('DROP TRIGGER compact_packed_payload_no_update; DROP TRIGGER compact_packed_piece_delete_guard');
  db.prepare(`UPDATE compact_packed_payloads SET payload = zeroblob(length(payload)) WHERE payload_sha256 =
    (SELECT payload_sha256 FROM compact_packed_pieces WHERE dataset = 'compact_pool_hours' AND scope_start = ? AND part = 0)`).run(hours[10]);
  db.prepare("DELETE FROM compact_packed_pieces WHERE dataset = 'compact_hour_addresses' AND scope_start = ? AND part = 0").run(hours[11]);
  db.prepare('UPDATE compact_pool_hours SET swap_count = swap_count + 1 WHERE hour_start = ? AND pool = (SELECT pool FROM compact_pool_hours WHERE hour_start = ? LIMIT 1)')
    .run(hours[12], hours[12]);
  db.prepare('DELETE FROM compact_pool_price_hours WHERE hour_start = ? AND pool = (SELECT pool FROM compact_pool_price_hours WHERE hour_start = ? LIMIT 1)')
    .run(hours[13], hours[13]);
  db.prepare("UPDATE compact_valuation_hours SET status = 'unavailable', reason = 'valuation_error', row_count = NULL, rows_sha256 = NULL WHERE hour_start = ? AND valuation = 'dex_fees'")
    .run(hours[14]);
  const report = store.packedShards.maintain({ limit: 256 });
  const failed = report.failed.map((f) => `${f.dataset}:${(f.scope - DAY0) / HOUR}:${f.reason}`).sort();
  assert.deepEqual(failed, ['compact_hour_addresses:11:packed_pieces_corrupt', 'compact_pool_hours:10:packed_payload_corrupt',
    'compact_pool_hours:12:packed_hot_rows_differ']);
  assert.deepEqual(logs.sort(), failed.map((f) => { const [dataset, i, reason] = f.split(':'); return `PACKED_RETENTION_BLOCKED dataset=${dataset} scope=${hours[i]} reason=${reason}`; }).sort());
  const kept = [['compact_pool_hours', 10], ['compact_hour_addresses', 11], ['compact_pool_hours', 12], ['compact_pool_price_hours', 13],
    ['compact_pool_hours', 14], ['compact_pool_price_hours', 14], ['compact_pool_fee_hours', 14]];
  for (const [dataset, i] of kept) {
    assert.equal(isMarked(db, dataset, hours[i]), false, `${dataset}:${i} not marked`);
    const deleted = dataset === 'compact_pool_price_hours' && i === 13 ? 1 : 0;
    assert.equal(hotCount(db, dataset, hours[i]), hotCount(dbA, dataset, hours[i]) - deleted, `${dataset}:${i} hot rows kept`);
  }
  for (const [dataset, i] of kept.slice(0, 4)) assert(hotCount(dbA, dataset, hours[i]) > 0, `fixture: ${dataset}:${i} has rows to protect`);
  for (const dataset of ['compact_hour_addresses', 'compact_pool_price_hours', 'compact_pool_fee_hours']) assert(isMarked(db, dataset, hours[10]), `${dataset}:10 pruned`);
  assert(isMarked(db, 'compact_hour_addresses', hours[14]), 'identities do not wait for valuations');
  for (const dataset of HOT_TABLES.filter((name) => PACKED_DATASETS[name].scope === 'hour_start')) assert(isMarked(db, dataset, hours[20]), `${dataset}:20 pruned`);
  // Pool swap totals hold exactly the pool hours that were pruned (11, 13 and 20), nothing from the failed attempts.
  const expected = new Map();
  for (const i of [11, 13, 20]) {
    for (const row of hot(dbA, 'compact_pool_hours', hours[i])) {
      const entry = expected.get(`${row.protocol}:${row.pool}`) ?? { swaps: 0, rows: 0 };
      entry.swaps += row.swap_count;
      entry.rows++;
      expected.set(`${row.protocol}:${row.pool}`, entry);
    }
  }
  assert.deepEqual(new Map(db.prepare('SELECT * FROM compact_packed_pool_swaps').all().map((row) => [`${row.protocol}:${row.pool}`,
    { swaps: row.swap_count, rows: row.row_count }])), expected);
  assert.equal(count(db, 'compact_hour_addresses'), before.compact_hour_addresses
    - [10, 12, 13, 14, 20].reduce((sum, i) => sum + hotCount(dbA, 'compact_hour_addresses', hours[i]), 0));
  db.close();
});

await test('safety: a failing maintenance query is logged and never blocks the live hour commit', async () => {
  const db = copyOf(dbB, 'b.sqlite', 'maintenance-failure.sqlite');
  const logs = [];
  const store = createCompactStore(db, { packedShards: { config: RETAIN, log: (line) => logs.push(line) } });
  db.exec('ALTER TABLE compact_valuation_hours RENAME TO compact_valuation_hours_hidden');
  const before = markers(db);
  assert.equal(store.commitHour(hourFixture(HOURS).result).outcome, 'inserted');
  assert.equal(store.checkpoint().hourStart, DAY0 + HOURS * HOUR);
  assert.deepEqual(markers(db).filter((key) => !before.includes(key)), [`compact_hour_addresses:${DAY0 + 152 * HOUR}`], 'identities still prune; pool datasets wait');
  assert(logs.length === 3 && logs.every((line) => /^PACKED_RETENTION_BLOCKED dataset=compact_pool_(hours|price_hours|fee_hours) scope=candidates reason=/.test(line)), logs.join('\n'));
  db.close();
});

await test('markers and pool swap totals are immutable; packed sets of pruned scopes stay', async () => {
  const scope = DAY0 + 3 * HOUR;
  const immutable = /immutable_packed_shards/;
  assert.throws(() => dbB.prepare("UPDATE compact_packed_pruned SET row_count = row_count + 1 WHERE dataset = 'compact_pool_hours' AND scope_start = ?").run(scope), immutable);
  assert.throws(() => dbB.prepare("DELETE FROM compact_packed_pruned WHERE dataset = 'compact_pool_hours' AND scope_start = ?").run(scope), immutable);
  assert.throws(() => dbB.prepare("INSERT INTO compact_packed_pruned VALUES ('compact_pool_hours', ?, 0, 'x')").run(scope), immutable);
  assert.throws(() => dbB.exec('DELETE FROM compact_packed_pool_swaps'), immutable);
  assert.throws(() => dbB.exec('UPDATE compact_packed_pool_swaps SET swap_count = swap_count - 1 WHERE swap_count > 0'), immutable);
  assert.throws(() => dbB.exec('UPDATE compact_packed_pool_swaps SET swap_count = swap_count + 1'), immutable, 'a total only grows with a pruned hour');
  assert.equal(count(dbB, 'compact_packed_pruned m WHERE NOT EXISTS (SELECT 1 FROM compact_packed_sets s WHERE s.dataset = m.dataset AND s.scope_start = m.scope_start)'), 0,
    'every marker keeps its packed set');
});

await test('recovery: replaying a pruned hour, its projections or its day reinserts nothing and keeps every packed set', async () => {
  const db = copyOf(dbB, 'b.sqlite', 'replay.sqlite');
  const store = createCompactStore(db, { packedShards: { config: RETAIN, log: () => {} } });
  const i = 5, hour = DAY0 + i * HOUR;
  const state = () => PACKED_TABLES.map((t) => count(db, t)).concat(HOT_TABLES.map((t) => count(db, t)));
  const before = state();
  assert.equal(store.commitHour(hourFixture(i).result).outcome, 'unchanged');
  assert.deepEqual(Object.values(store.commitProjectionHour(hour, {})), Array(6).fill('unchanged'));
  assert.equal(store.replayDailyActiveAddresses(hour, hourFixture(i).result.activeAddresses).status, 'available');
  assert.deepEqual(Object.values(store.packedShards.packHour(hour)).map((r) => r.outcome), Array(5).fill('unchanged'));
  assert.deepEqual(state(), before);
  for (const dataset of HOT_TABLES) assert.equal(hotCount(db, dataset, PACKED_DATASETS[dataset].scope === 'day_start' ? DAY0 : hour), 0);
  assert.deepEqual(store.persistedActiveAddresses(hour), storeA.persistedActiveAddresses(hour));
  db.close();
});

await test('retention turned OFF (or packing OFF) after pruning: readers still serve pruned scopes from their packed sets', async () => {
  const db = copyOf(dbB, 'b.sqlite', 'off-after.sqlite');
  const store = createCompactStore(db);
  assert.equal(store.packedShards.enabled, false);
  assert.equal(store.packedShards.maintain(), null);
  for (const i of [0, 30, 151, 152, 199]) {
    const hour = DAY0 + i * HOUR;
    assert.deepEqual(store.poolHours(hour, 'uniswap_v4'), storeA.poolHours(hour, 'uniswap_v4'));
    assert.deepEqual(store.swapFees(hour), storeA.swapFees(hour));
    assert.deepEqual(store.persistedActiveAddresses(hour), storeA.persistedActiveAddresses(hour));
    assert.deepEqual(store.topPoolsOf('uniswap_v3', hour, 10), storeA.topPoolsOf('uniswap_v3', hour, 10));
  }
  const before = markers(db);
  const extra = hourFixture(HOURS);
  store.commitHour(extra.result);
  writeHourRows(db, extra);
  assert.deepEqual(markers(db), before);
  db.close();
});

await test('disk (synthetic, measured): pruning removes hot pages; retention is always smaller than packing alone; size after VACUUM', async () => {
  const pageSize = dbA.prepare('PRAGMA page_size').get().page_size;
  const vacuumed = (db, from, name) => { const copy = copyOf(db, from, name); copy.exec('VACUUM'); copy.close(); return statSync(pathOf(name)).size; };
  // Packing alone (step 1): the same rows packed, nothing pruned.
  const p = copyOf(dbA, 'a.sqlite', 'pack-only-disk.sqlite');
  const sp = createCompactStore(p, { packedShards: { config: PACK, log: () => {} } });
  for (let i = 0; i < HOURS; i++) sp.packedShards.packHour(DAY0 + i * HOUR);
  assert.equal(count(p, 'compact_packed_sets'), count(dbB, 'compact_packed_sets'));
  const hotA = bytesOf(dbA, HOT_TABLES), hotB = bytesOf(dbB, HOT_TABLES), packedB = bytesOf(dbB, PACKED_TABLES);
  // Stored payload bytes per dataset (distinct payloads), next to the dataset's hot row pages in A.
  const perDataset = Object.fromEntries(HOT_TABLES.map((dataset) => [dataset, { hotRowPagesA: bytesOf(dbA, [dataset]),
    payloadBytes: dbB.prepare(`SELECT SUM(length(payload)) AS n FROM compact_packed_payloads WHERE payload_sha256 IN
      (SELECT payload_sha256 FROM compact_packed_pieces WHERE dataset = ?)`).get(dataset).n }]));
  const result = { hotRowPagesA: hotA, hotRowPagesB: hotB, packedPagesB: packedB, payloadTablePagesB: bytesOf(dbB, ['compact_packed_payloads']),
    payloadBlobBytesB: dbB.prepare('SELECT SUM(length(payload)) AS n FROM compact_packed_payloads').get().n, perDataset,
    vacuumedBytes: { noPacking: vacuumed(dbA, 'a.sqlite', 'vacuum-a.sqlite'), packingOnly: (p.close(), vacuumed(new DatabaseSync(pathOf('pack-only-disk.sqlite')),
      'pack-only-disk.sqlite', 'vacuum-p.sqlite')), retention: vacuumed(dbB, 'b.sqlite', 'vacuum-b.sqlite') }, pageSize };
  assert(hotB < hotA, 'pruning removed hot row pages');
  assert(result.vacuumedBytes.retention < result.vacuumedBytes.packingOnly, 'retention is always smaller than packing alone');
  result.netVersusNoPackingPercent = Number((100 * (1 - result.vacuumedBytes.retention / result.vacuumedBytes.noPacking)).toFixed(3));
  measurements.disk = { fixture: `${HOURS} hours x ${IDENTITIES} random identities (of ${IDENTITY_POOL}), 48 pools; 48 of ${HOURS} hours stay hot; not mainnet`, ...result };
});

await test('disk (synthetic, measured): steady-state growth per hour with 3,000 identities per hour, retention versus no packing', async () => {
  const a = open('steady-a.sqlite'), b = open('steady-b.sqlite');
  const logs = [];
  const sa = createCompactStore(a), sb = createCompactStore(b, { packedShards: { config: RETAIN, log: (line) => logs.push(line) } });
  const hourOf = (i) => {
    const next = random(10_000 + i);
    const ids = new Set();
    while (ids.size < 3000) ids.add(address(`steady-identity-${Math.floor(next() * 50_000)}`));
    return identityHour(i, [...ids].sort());
  };
  const used = (db) => { const p = pages(db); return (p.pageCount - p.freelist) * db.prepare('PRAGMA page_size').get().page_size; };
  let start = null;
  // Hours 72..95: B is in steady state (each new hour prunes the hour 48 hours older; one full UTC day is packed and one
  // pruned), so the growth over these 24 hours is the per-day cost of a long retention period.
  for (let i = 0; i < 96; i++) {
    const result = hourOf(i);
    sa.commitHour(result);
    sb.commitHour(result);
    if (i === 71) start = [used(a), used(b)];
  }
  const growth = { noPacking: used(a) - start[0], retention: used(b) - start[1] };
  assert.deepEqual(logs, []);
  assert.equal(count(b, 'compact_packed_pruned'), 96 - PACKED_MIN_HOT_HOURS + 2, 'hours 0..47 and days 0..1 pruned');
  assert(growth.retention < growth.noPacking, 'retention grows less per day than unpacked hot rows');
  measurements.steadyState = { fixture: '96 hours x 3,000 random identities (of 50,000); identities only; not mainnet', growthBytesPerDay: growth,
    savingPercent: Number((100 * (1 - growth.retention / growth.noPacking)).toFixed(3)) };
  a.close();
  b.close();
});

await test('performance (synthetic, measured): 7D/30D pool reads on hot + packed rows versus hot rows', async () => {
  const time = (path, protocol, window) => {
    const model = createCompactReadModel({ path, DatabaseSync, now: () => (NEWEST + HOUR + 60) * 1000 });
    try { const started = performance.now(); model.pools(protocol, window); return Number((performance.now() - started).toFixed(1)); } finally { model.close(); }
  };
  measurements.poolReadMs = {};
  for (const window of ['24h', '7d', '30d']) {
    measurements.poolReadMs[window] = { a: time(pathOf('a.sqlite'), 'v3', window), b: time(pathOf('b.sqlite'), 'v3', window) };
  }
});

await test('low heap: pruning a 1,200,000-identity completed day (and its hours) stays within a 48 MiB old space', async () => {
  const path = pathOf('large-day.sqlite');
  const db = new DatabaseSync(path);
  const store = createCompactStore(db, { packedShards: { config: PACK, log: () => {} } });
  const big = (i) => identityHour(i, Array.from({ length: 50_000 }, (_, k) => `0x${sha(`retention-low-heap:${i}:${k}`).slice(0, 40)}`).sort());
  for (let i = 0; i < 24; i++) store.commitHour(big(i));
  for (let i = 24; i <= 24 + PACKED_MIN_HOT_HOURS; i++) store.commitHour(identityHour(i, [address(`small-${i}`)]));
  assert.equal(store.packedShards.status('compact_daily_address_stage', DAY0).rowCount, 1_200_000);
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  db.close();
  const child = spawnSync(process.execPath, ['--max-old-space-size=48', '--max-semi-space-size=2', fileURLToPath(import.meta.url)], {
    env: { ...process.env, RETENTION_LOW_HEAP_CHILD: '1', RETENTION_LOW_HEAP_DB: path }, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  assert.equal(child.status, 0, child.stderr);
  const out = JSON.parse(child.stdout.trim().split('\n').at(-1));
  assert.deepEqual(out.blocked, []);
  assert.equal(out.pruned, true);
  assert.deepEqual([out.hotStage, out.hotHour, out.marker.row_count, out.rows, out.verified.rowCount], [0, 0, 1_200_000, 1_200_000, 1_200_000]);
  assert(out.heapLimit <= 64 * 1024 * 1024 && out.peakHeapUsed < out.heapLimit);
  measurements.lowHeap = { day: '24 x 50,000 distinct identities', pruned: out.report.pruned, passes: out.report.passes, pruneMs: out.pruneMs, heapLimitBytes: out.heapLimit,
    peakSampledHeapUsedBytes: out.peakHeapUsed, maxRssBytes: out.maxRssBytes };
});

dbA.close();
dbB.close();
rmSync(dir, { recursive: true, force: true });
console.log(JSON.stringify({ measurements }, null, 1));
console.log(`COMPACT_PACKED_RETENTION: PASS (${passed} scenarios, ${comparisons} A/B comparisons; Node ${process.version}; disposable SQLite, no network)`);
