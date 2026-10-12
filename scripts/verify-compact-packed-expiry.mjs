// Node 24: disposable SQLite files only. No network, no production database, no RPC.
// Verifies packed-shards expiry (server/compact/packed-shards.js, COMPACT_PACKED_EXPIRY_ENABLED): OFF by default and only
// with retention; ON, it deletes the packed set of a pruned scope only past PACKED_KEEP_HOURS (identities 61 days for the
// 30D unique union and the previous 30D; pool data 36 days for 30D pools, repairs and backfills). Two databases get the
// same deterministic 65 days (identities, pool, price-path and fee rows, statuses, valuations, registry): A without
// packing, B with packing, retention and expiry. Every 24H/7D/30D read-model answer (with the previous 7D and 30D unique
// counts) and every store accessor inside the kept spans must be identical; an expired scope is an error or unknown,
// never empty data; ecosystem early activity survives through the creation-hour counts; the packed data stops growing;
// a mismatching or unreadable set, returned hot rows or a storage refusal block deletion; markers and guards hold.
// Every deletion below happens in files this script creates.
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FAMILY_FIELDS } from '../server/compact/families.js';
import { correlateDex } from '../server/compact/intelligence-store.js';
import { createPackedShards, PACKED_DATASETS, PACKED_JOURNAL_LIMIT_BYTES, PACKED_KEEP_HOURS, packedShardsConfig } from '../server/compact/packed-shards.js';
import { createCompactReadModel } from '../server/compact/read-model.js';
import { COMPACT_DEFINITION_VERSION } from '../server/compact/sources.js';
import { createCompactStore } from '../server/compact/store.js';
import { VALUATIONS } from '../server/compact/valuation.js';

globalThis.fetch = async () => { throw new Error('external_network_forbidden'); };
for (const key of ['COMPACT_PACKED_SHARDS_ENABLED', 'COMPACT_PACKED_RETENTION_ENABLED', 'COMPACT_PACKED_EXPIRY_ENABLED', 'COMPACT_PACKED_HOT_HOURS',
  'COMPACT_PACKED_MAINTENANCE_SCOPES', 'COMPACT_PACKED_MAINTENANCE_MAX_MIB', 'COMPACT_EVIDENCE_ARCHIVE_ENABLED']) delete process.env[key];

const HOUR = 3600;
const DAY = 24 * HOUR;
const DAY0 = Date.parse('2026-06-01T00:00:00Z') / 1000;
const HOURS = 65 * 24; // past both kept spans, with a previous 30D for the 30D window
const EXTRA = 72; // three more days for the growth check
const NEWEST = DAY0 + (HOURS - 1) * HOUR;
const EMPTY_POOL_HOUR = 5; // no pool row at all: an empty pool set that expires
const env = (extra) => packedShardsConfig({ COMPACT_PACKED_SHARDS_ENABLED: 'true', COMPACT_PACKED_RETENTION_ENABLED: 'true', COMPACT_PACKED_MAINTENANCE_SCOPES: '32', ...extra });
const RETAIN = env({});
const EXPIRE = env({ COMPACT_PACKED_EXPIRY_ENABLED: 'true' });
const HOT_TABLES = Object.keys(PACKED_DATASETS);
const PACKED_TABLES = ['compact_packed_payloads', 'compact_packed_sets', 'compact_packed_pieces', 'compact_packed_pruned', 'compact_packed_pool_swaps',
  'compact_packed_expired', 'compact_packed_pool_creation_swaps'];
const sha = (text) => createHash('sha256').update(text).digest('hex');
const address = (label) => `0x${sha(label).slice(0, 40)}`;
const hash = (n) => `0x${n.toString(16).padStart(64, '0')}`;
const USDC = '0x3600000000000000000000000000000000000000';
const EURC = '0xbef5f6d51cb62b58e6a8f77868681825c6fe21c1';
const ZERO = `0x${'0'.repeat(40)}`;
const TOKEN = address('expiry-token-shared');
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
function identityHour(i, identities) {
  const hourStart = DAY0 + i * HOUR, block = 100 + i;
  return { definitionVersion: COMPACT_DEFINITION_VERSION, chainId: 5042, sourceVersions: {}, complete: false,
    range: { kind: 'hour', hourStart, hourEnd: hourStart + HOUR, firstBlock: block, lastBlock: block, parentHash: hash(block - 1), firstHash: hash(block), lastHash: hash(block) },
    network: { status: 'available', blockCount: 1, transactionCount: identities.length, uniqueActiveAddresses: identities.length, gasUsedRaw: '42000' },
    activeAddresses: identities,
    families: Object.fromEntries(Object.entries(FAMILY_FIELDS).map(([name, fields]) => [name, { status: 'unavailable', reason: 'fixture', ...Object.fromEntries(fields.map((f) => [f, null])) }])),
    registry: { uniswapV3: null } };
}
// 32 registry pools, created before the first hour, in hours that expire, and in kept hours.
const POOLS = Array.from({ length: 32 }, (_, k) => {
  const v4 = k % 2 === 1;
  const createdHour = k < 4 ? -3 : (k * 97) % (HOURS - 10);
  return { k, v4, protocol: v4 ? 'uniswap_v4' : 'uniswap_v3', kind: v4 ? 'uniswap_v4_pool' : 'uniswap_v3_pool',
    pool: v4 ? `0x${sha(`expiry-pool-${k}`)}` : address(`expiry-pool-${k}`),
    token: k % 4 === 0 || k % 4 === 1 ? TOKEN : k % 4 === 3 ? EURC : address(`expiry-token-${k}`), createdHour };
});
// 0..40 identities drawn from 3,000 (some hours empty) and the active pools' rows of the hour.
function hourFixture(i) {
  const next = random(i + 11);
  const ids = new Set();
  const target = i % 97 === 13 ? 0 : 40;
  while (ids.size < target) ids.add(address(`expiry-identity-${Math.floor(next() * 3000)}`));
  const hourStart = DAY0 + i * HOUR, block = 100 + i;
  const pools = [], prices = [], fees = [];
  for (const p of POOLS) {
    if (i < p.createdHour || i === EMPTY_POOL_HOUR) continue;
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
const registryRow = (p) => [p.kind, p.pool, 100 + p.createdHour, p.k, hash(10_000 + p.k), JSON.stringify(p.v4
  ? { currency0: USDC, currency1: p.token, fee: 3000, tickSpacing: 60, hooks: ZERO } : { token0: USDC, token1: p.token, fee: 500, tickSpacing: 10 })];
function writeRegistry(db) {
  writeRows(db, 'INSERT INTO compact_registry (kind, address, created_block, created_log_index, created_tx, meta_json) VALUES (?, ?, ?, ?, ?, ?)', POOLS.map(registryRow));
  writeRows(db, 'INSERT INTO compact_registry_coverage (kind, from_block, through_block, through_hash) VALUES (?, 1, 1000000000, ?)',
    [['uniswap_v3_pool', hash(1)], ['uniswap_v4_pool', hash(2)]]);
}
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

const count = (db, table) => db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
const hotCount = (db, dataset, scope) => db.prepare(`SELECT COUNT(*) AS n FROM ${dataset} WHERE ${PACKED_DATASETS[dataset].scope} = ?`).get(scope).n;
const keys = (db, table) => db.prepare(`SELECT dataset, scope_start FROM ${table}`).all().map((r) => `${r.dataset}:${r.scope_start}`).sort();
const bytesOf = (db, names) => db.prepare(`SELECT SUM(pgsize) AS bytes FROM dbstat WHERE name IN (${names.map(() => '?').join(',')})`).get(...names).bytes ?? 0;
const keepOf = (dataset) => (PACKED_DATASETS[dataset].codec === 'address-b20' ? PACKED_KEEP_HOURS.identity : PACKED_KEEP_HOURS.pool);
const lastHourOf = (dataset, scope) => (PACKED_DATASETS[dataset].scope === 'day_start' ? scope + DAY - HOUR : scope);
// The scopes expiry must have deleted for a newest hour: every pruned scope whose last hour is before the kept span.
const expectedExpired = (db, newest) => keys(db, 'compact_packed_pruned').filter((key) => {
  const [dataset, scope] = key.split(':');
  return lastHourOf(dataset, Number(scope)) < newest - (keepOf(dataset) - 1) * HOUR;
});
const drain = (store) => { for (let report; (report = store.packedShards.maintain({ limit: 256 })).expired || report.pruned || report.packed;); };

const dir = mkdtempSync(join(tmpdir(), 'compact-packed-expiry-'));
const pathOf = (name) => join(dir, name);
const open = (name) => new DatabaseSync(pathOf(name));
const copyOf = (db, from, to) => { db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); copyFileSync(pathOf(from), pathOf(to)); return open(to); };
let passed = 0;
let comparisons = 0;
const measurements = {};
const test = async (name, fn) => { await fn(); passed++; console.log(`PASS ${name}`); };

const logs = [];
const dbA = open('a.sqlite');
const storeA = createCompactStore(dbA, { packedShards: { log: (line) => logs.push(line) } });
const dbB = open('b.sqlite');
const storeB = createCompactStore(dbB, { packedShards: { config: EXPIRE, log: (line) => logs.push(line) } });
writeRegistry(dbA);
writeRegistry(dbB);
const buildStarted = performance.now();
for (let i = 0; i < HOURS; i++) {
  for (const [db, store] of [[dbA, storeA], [dbB, storeB]]) {
    store.commitHour(hourFixture(i).result);
    writeHourRows(db, hourFixture(i));
  }
}
drain(storeB);
dbA.exec('PRAGMA wal_checkpoint(TRUNCATE)');
dbB.exec('PRAGMA wal_checkpoint(TRUNCATE)');
measurements.build = { hours: HOURS, ms: Math.round(performance.now() - buildStarted) };

await test('configuration: expiry is OFF by default, needs retention, and its pass budget is bounded', async () => {
  assert.deepEqual(packedShardsConfig({}), { enabled: false, retention: false, expiry: false, hotHours: 48, maintenanceScopes: 16, maintenanceMiB: 64 });
  assert.equal(EXPIRE.expiry, true);
  const refused = (extra, code) => assert.throws(() => packedShardsConfig(extra), (error) => error.code === code, code);
  refused({ COMPACT_PACKED_EXPIRY_ENABLED: 'true' }, 'packed_expiry_requires_retention');
  refused({ COMPACT_PACKED_SHARDS_ENABLED: 'true', COMPACT_PACKED_EXPIRY_ENABLED: 'true' }, 'packed_expiry_requires_retention');
  refused({ COMPACT_PACKED_EXPIRY_ENABLED: 'yes' }, 'invalid_packed_expiry_enabled');
  for (const value of ['0', '1025', 'x']) refused({ COMPACT_PACKED_MAINTENANCE_MAX_MIB: value }, 'invalid_packed_maintenance_max_mib');
  assert.deepEqual(PACKED_KEEP_HOURS, { identity: 1464, pool: 864 });
  assert.equal(storeA.packedShards.expiry, false);
  assert.equal(storeB.packedShards.expiry, true);
  assert.equal(dbB.prepare('PRAGMA journal_size_limit').get().journal_size_limit, PACKED_JOURNAL_LIMIT_BYTES, 'retention bounds the WAL after a checkpoint');
  assert.equal(dbA.prepare('PRAGMA journal_size_limit').get().journal_size_limit, -1, 'OFF keeps the previous WAL setting');
});

await test('ON: exactly the pruned scopes past the kept spans lose their packed sets; nothing else is deleted', async () => {
  assert.deepEqual(logs, []);
  const expected = expectedExpired(dbB, NEWEST);
  assert.deepEqual(keys(dbB, 'compact_packed_expired'), expected);
  const perDataset = Object.fromEntries(HOT_TABLES.map((dataset) => [dataset, expected.filter((key) => key.startsWith(`${dataset}:`)).length]));
  assert.deepEqual(perDataset, { compact_pool_hours: HOURS - 864, compact_pool_price_hours: HOURS - 864, compact_pool_fee_hours: HOURS - 864,
    compact_hour_addresses: HOURS - 1464, compact_daily_address_stage: 4 });
  const sets = new Set(keys(dbB, 'compact_packed_sets'));
  for (const key of expected) assert(!sets.has(key), `${key}: set deleted`);
  for (const key of keys(dbB, 'compact_packed_pruned')) assert(expected.includes(key) || sets.has(key), `${key}: a kept pruned scope keeps its set`);
  assert.equal(count(dbB, 'compact_packed_pieces p WHERE NOT EXISTS (SELECT 1 FROM compact_packed_sets s WHERE s.dataset = p.dataset AND s.scope_start = p.scope_start)'), 0);
  assert.equal(count(dbB, 'compact_packed_payloads y WHERE NOT EXISTS (SELECT 1 FROM compact_packed_pieces p WHERE p.payload_sha256 = y.payload_sha256)'), 0,
    'no orphan payload');
  for (const key of sets) { const [dataset, scope] = key.split(':'); assert(storeB.packedShards.forEachRow(dataset, Number(scope)), key); }
  for (const dataset of HOT_TABLES) for (const key of expected.filter((k) => k.startsWith(`${dataset}:`))) assert.equal(hotCount(dbB, dataset, Number(key.split(':')[1])), 0);
  measurements.expired = perDataset;
});

const apiAnswers = (path) => {
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
};

await test('read model: every 24H/7D/30D answer, with the previous 7D and 30D unique counts, is identical to A', async () => {
  const a = apiAnswers(pathOf('a.sqlite'));
  const b = apiAnswers(pathOf('b.sqlite'));
  for (const key of Object.keys(a)) { assert.deepEqual(b[key], a[key], key); comparisons++; }
  for (const window of ['7d', '30d']) {
    assert.equal(a[`summary:${window}`].network.uniqueActiveAddresses.status, 'available', window);
    assert.equal(a[`summary:${window}`].network.previous.uniqueActiveAddresses.status, 'available', `previous ${window}`);
    for (const protocol of ['v3', 'v4']) assert.equal(a[`pools:${protocol}:${window}`].status, 'available', `${protocol} ${window}`);
  }
  measurements.readModel = { answers: Object.keys(a).length, refusedOnBoth: Object.entries(a).filter(([, v]) => v?.error).map(([k, v]) => `${k}:${v.error}`),
    previous30dUnique: a['summary:30d'].network.previous.uniqueActiveAddresses.value };
});

await test('store: accessors inside the kept spans equal A; an expired scope is an error or unknown, never empty', async () => {
  for (const i of [HOURS - 864, HOURS - 864 + 23, HOURS - 720, 1200, HOURS - 1]) {
    const hour = DAY0 + i * HOUR;
    for (const protocol of ['uniswap_v3', 'uniswap_v4']) {
      assert.deepEqual(storeB.poolHours(hour, protocol), storeA.poolHours(hour, protocol));
      assert.deepEqual(storeB.pricePaths(hour, protocol), storeA.pricePaths(hour, protocol));
      // The 24H ranking reaches 23 hours back; repairs ask for it at most 719 hours back (projection-recovery.js).
      if (i - 23 >= HOURS - 864) assert.deepEqual(storeB.topPoolsOf(protocol, hour, 10), storeA.topPoolsOf(protocol, hour, 10));
    }
    assert.deepEqual(storeB.swapFees(hour), storeA.swapFees(hour));
    comparisons += 7;
  }
  for (const i of [HOURS - 1464, 300, HOURS - 1]) {
    assert.deepEqual(storeB.persistedActiveAddresses(DAY0 + i * HOUR), storeA.persistedActiveAddresses(DAY0 + i * HOUR));
    comparisons++;
  }
  const expiredPool = DAY0 + 10 * HOUR, expiredIdentity = DAY0 + 20 * HOUR;
  assert(storeA.poolHours(expiredPool, 'uniswap_v3').length > 0);
  assert.equal(storeB.packedShards.expired('compact_pool_hours', expiredPool), true);
  for (const read of [() => storeB.poolHours(expiredPool, 'uniswap_v3'), () => storeB.pricePaths(expiredPool, 'uniswap_v4'), () => storeB.swapFees(expiredPool),
    () => storeB.topPoolsOf('uniswap_v3', expiredPool + 5 * HOUR, 10)]) {
    assert.throws(read, (error) => error.code === 'packed_scope_expired');
  }
  assert.equal(storeA.persistedActiveAddresses(expiredIdentity).length, 40);
  assert.equal(storeB.persistedActiveAddresses(expiredIdentity), null, 'unknown, so a DAU replay re-reads the hour');
});

await test('ecosystem: early activity and stored swap counts equal A; expired hours never become smaller or zero counts', async () => {
  const expiredCreated = POOLS.filter((p) => p.createdHour >= 0 && p.createdHour < HOURS - 864 && p.token === TOKEN);
  assert(expiredCreated.length >= 2, 'fixture: correlated pools created in expired hours');
  const kept = dbB.prepare('SELECT protocol, pool, swap_count FROM compact_packed_pool_creation_swaps').all();
  assert.equal(kept.length, POOLS.filter((p) => p.createdHour >= 0 && p.createdHour < HOURS - 864).length, 'one count per pool created in an expired hour');
  assert(kept.some((row) => row.swap_count === null), 'a pool without a row in its creation hour keeps NULL (no row), as A reads it');
  for (const token of [TOKEN, EURC]) {
    assert.deepEqual(correlateDex(dbB, token, 100 + HOURS - 1), correlateDex(dbA, token, 100 + HOURS - 1), token);
    comparisons++;
  }
  const a = correlateDex(dbA, TOKEN, 100 + HOURS - 1);
  assert(a.observedPools.some((pool) => pool.earlyActivity.status === 'available' && pool.earlyActivity.swapCount > 0
    && Date.parse(pool.earlyActivity.hourStart) / 1000 < NEWEST - 864 * HOUR), 'an early count from an expired creation hour');
  // An older end block would need expired hours streamed: the pools' stored swap counts are unknown, never smaller.
  const old = correlateDex(dbB, TOKEN, 100 + 300);
  assert(correlateDex(dbA, TOKEN, 100 + 300).observedPools.some((pool) => Number.isSafeInteger(pool.observedSwapCount)));
  assert(old.observedPools.every((pool) => pool.observedSwapCount === null));
  // A pool registered only after its creation hour expired has no kept count: unavailable, not zero.
  const late = { k: 99, v4: false, protocol: 'uniswap_v3', kind: 'uniswap_v3_pool', pool: address('expiry-pool-late'), token: TOKEN, createdHour: 40 };
  for (const db of [dbA, dbB]) writeRows(db, 'INSERT INTO compact_registry (kind, address, created_block, created_log_index, created_tx, meta_json) VALUES (?, ?, ?, ?, ?, ?)', [registryRow(late)]);
  const lateB = correlateDex(dbB, TOKEN, 100 + HOURS - 1).observedPools.find((pool) => pool.pool === late.pool);
  assert.deepEqual([lateB.earlyActivity.status, lateB.earlyActivity.swapCount], ['unavailable', null]);
  assert.equal(correlateDex(dbA, TOKEN, 100 + HOURS - 1).observedPools.find((pool) => pool.pool === late.pool).earlyActivity.status, 'available');
});

await test('growth is bounded: three more days add no packed sets and no packed pages while A keeps growing', async () => {
  const blobs = (db) => db.prepare('SELECT SUM(length(payload)) AS n FROM compact_packed_payloads').get().n;
  const markerRows = (db) => count(db, 'compact_packed_pruned') + count(db, 'compact_packed_expired');
  const before = { sets: count(dbB, 'compact_packed_sets'), blobs: blobs(dbB), markers: markerRows(dbB), packedBytes: bytesOf(dbB, PACKED_TABLES), hotBytes: bytesOf(dbB, HOT_TABLES),
    fileA: statSync(pathOf('a.sqlite')).size, fileB: statSync(pathOf('b.sqlite')).size, hotA: bytesOf(dbA, HOT_TABLES) };
  for (let i = HOURS; i < HOURS + EXTRA; i++) {
    for (const [db, store] of [[dbA, storeA], [dbB, storeB]]) { store.commitHour(hourFixture(i).result); writeHourRows(db, hourFixture(i)); }
  }
  drain(storeB);
  for (const db of [dbA, dbB]) db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  const newest = NEWEST + EXTRA * HOUR;
  assert.deepEqual(keys(dbB, 'compact_packed_expired'), expectedExpired(dbB, newest));
  const after = { sets: count(dbB, 'compact_packed_sets'), blobs: blobs(dbB), markers: markerRows(dbB), packedBytes: bytesOf(dbB, PACKED_TABLES), hotBytes: bytesOf(dbB, HOT_TABLES),
    fileA: statSync(pathOf('a.sqlite')).size, fileB: statSync(pathOf('b.sqlite')).size, hotA: bytesOf(dbA, HOT_TABLES) };
  assert.equal(after.sets, before.sets, 'one set expires for every set packed');
  // Stored bytes follow the live sets only (later hours of this fixture hold more pools, so a live set is not a constant size).
  assert.equal(count(dbB, 'compact_packed_payloads y WHERE NOT EXISTS (SELECT 1 FROM compact_packed_pieces p WHERE p.payload_sha256 = y.payload_sha256)'), 0);
  assert(after.blobs <= dbB.prepare('SELECT SUM(stored_bytes) AS n FROM compact_packed_sets').get().n, 'no stored byte outside a live set');
  assert.equal(after.markers - before.markers, 2 * (EXTRA * 4 + EXTRA / 24), 'markers: one prune and one expiry marker per scope (never removed)');
  assert(after.packedBytes <= before.packedBytes * 1.1, 'packed pages stay within B-tree fill drift (freed pages are reused)');
  assert(after.hotA > before.hotA, 'A grows');
  assert(after.fileB - before.fileB < after.fileA - before.fileA, 'B grows less than A');
  measurements.growth3Days = { packedSets: [before.sets, after.sets], storedPackedBytes: [before.blobs, after.blobs], markerRows: [before.markers, after.markers],
    packedPageBytes: [before.packedBytes, after.packedBytes],
    hotPageBytesB: [before.hotBytes, after.hotBytes], fileGrowthBytes: { a: after.fileA - before.fileA, b: after.fileB - before.fileB },
    note: 'B still grows: canonical hours, status and valuation rows and the other non-packed tables are never expired' };
});

await test('safety: returned hot rows, a set that differs from its marker, or an unreadable expiring pool set block deletion (logged)', async () => {
  const db = copyOf(dbB, 'b.sqlite', 'unsafe.sqlite');
  const log = [];
  const store = createCompactStore(db, { packedShards: { config: RETAIN, log: () => {} } });
  // The next scopes to expire once the newest hour moves past the creation hour of the next registered pool: give three of
  // them a reason to stay.
  const newest = NEWEST + EXTRA * HOUR;
  const nextPool = newest - 863 * HOUR, nextIdentity = newest - 1463 * HOUR;
  const poolHour = POOLS.filter((p) => DAY0 + p.createdHour * HOUR > nextPool).sort((x, y) => x.createdHour - y.createdHour)[0];
  const created = DAY0 + poolHour.createdHour * HOUR;
  const target = created + 864 * HOUR;
  db.exec('DROP TRIGGER compact_packed_set_no_update; DROP TRIGGER compact_packed_payload_no_update');
  db.prepare("UPDATE compact_packed_sets SET rows_sha256 = 'x' WHERE dataset = 'compact_pool_price_hours' AND scope_start = ?").run(nextPool);
  db.prepare(`UPDATE compact_packed_payloads SET payload = zeroblob(length(payload)) WHERE payload_sha256 IN
    (SELECT payload_sha256 FROM compact_packed_pieces WHERE dataset = 'compact_pool_hours' AND scope_start = ?)`).run(created);
  db.prepare('INSERT INTO compact_hour_addresses VALUES (?, ?)').run(nextIdentity, Buffer.alloc(20, 7));
  const packed = createPackedShards(db, { config: env({ COMPACT_PACKED_EXPIRY_ENABLED: 'true', COMPACT_PACKED_MAINTENANCE_MAX_MIB: '1024' }),
    log: (line) => log.push(line) });
  packed.begin();
  db.exec('BEGIN IMMEDIATE');
  const report = packed.maintain(target, { limit: 4000 });
  db.exec('COMMIT');
  const failed = report.failed.map((f) => `${f.dataset}:${f.scope}:${f.reason}`).sort();
  assert.deepEqual(failed, [`compact_hour_addresses:${nextIdentity}:packed_expiry_hot_rows_present`, `compact_pool_hours:${created}:packed_payload_corrupt`,
    `compact_pool_price_hours:${nextPool}:packed_expiry_set_mismatch`].sort());
  assert.equal(log.length, 3);
  assert(log.every((line) => line.startsWith('PACKED_EXPIRY_BLOCKED ')));
  for (const [dataset, scope] of [['compact_hour_addresses', nextIdentity], ['compact_pool_hours', created], ['compact_pool_price_hours', nextPool]]) {
    assert.equal(packed.isExpired(dataset, scope), false, `${dataset}:${scope} kept`);
    assert(db.prepare('SELECT 1 FROM compact_packed_sets WHERE dataset = ? AND scope_start = ?').get(dataset, scope), 'set kept');
  }
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM compact_packed_pool_creation_swaps WHERE hour_start = ?').get(created).n, 0, 'nothing kept from the blocked hour');
  assert(report.expired > 0, 'other scopes still expire');
  db.close();
  void store;
});

await test('safety: a storage refusal stops every deletion of the pass (one report, one log line); the pass budget caps its WAL', async () => {
  const db = copyOf(dbB, 'b.sqlite', 'storage.sqlite');
  createCompactStore(db, { packedShards: { config: RETAIN, log: () => {} } });
  const run = (config, preflight) => {
    const log = [];
    const packed = createPackedShards(db, { config, preflight, log: (line) => log.push(line) });
    packed.begin();
    db.exec('BEGIN IMMEDIATE');
    try { return { report: packed.maintain(NEWEST + EXTRA * HOUR + 30 * HOUR, { limit: 256 }), log }; } finally { db.exec('ROLLBACK'); }
  };
  const before = [count(db, 'compact_packed_sets'), count(db, 'compact_packed_expired'), count(db, 'compact_packed_pruned')];
  const refused = run(EXPIRE, () => ({ ok: false, reason: 'storage_low_space' }));
  assert.deepEqual([refused.report.expired, refused.report.pruned], [0, 0]);
  assert.deepEqual(refused.report.failed.map((f) => f.reason), ['storage_blocked:storage_low_space']);
  assert.equal(refused.log.length, 1);
  const free = run(EXPIRE, () => ({ ok: true }));
  assert(free.report.expired + free.report.pruned > 4, 'with space, the same pass deletes');
  const budget = run(env({ COMPACT_PACKED_EXPIRY_ENABLED: 'true', COMPACT_PACKED_MAINTENANCE_MAX_MIB: '1' }), () => ({ ok: true }));
  assert(budget.report.expired + budget.report.pruned <= Math.ceil(1024 / 64) + 1, 'about 64 KiB planned per deletion');
  assert(budget.report.expired + budget.report.pruned < free.report.expired + free.report.pruned);
  assert.deepEqual([count(db, 'compact_packed_sets'), count(db, 'compact_packed_expired'), count(db, 'compact_packed_pruned')], before, 'rolled back');
  db.close();
});

await test('guards: live sets, pieces and referenced payloads cannot be deleted; markers and kept counts are immutable', async () => {
  const immutable = /immutable_packed_shards/;
  const live = dbB.prepare('SELECT dataset, scope_start FROM compact_packed_sets LIMIT 1').get();
  const expired = dbB.prepare('SELECT dataset, scope_start FROM compact_packed_expired LIMIT 1').get();
  assert.throws(() => dbB.prepare('DELETE FROM compact_packed_sets WHERE dataset = ? AND scope_start = ?').run(live.dataset, live.scope_start), immutable);
  assert.throws(() => dbB.prepare('DELETE FROM compact_packed_pieces WHERE dataset = ? AND scope_start = ?').run(live.dataset, live.scope_start), immutable);
  assert.throws(() => dbB.exec('DELETE FROM compact_packed_payloads'), immutable);
  assert.throws(() => dbB.exec('DELETE FROM compact_packed_expired'), immutable);
  assert.throws(() => dbB.exec('UPDATE compact_packed_expired SET row_count = row_count + 1'), immutable);
  const hotHour = NEWEST + (EXTRA - 1) * HOUR; // the newest hour: still hot, never pruned
  assert.equal(dbB.prepare("SELECT 1 FROM compact_packed_pruned WHERE dataset = 'compact_hour_addresses' AND scope_start = ?").get(hotHour), undefined);
  assert.throws(() => dbB.prepare("INSERT INTO compact_packed_expired VALUES ('compact_hour_addresses', ?, 0, 'x')").run(hotHour), immutable, 'only a pruned scope');
  assert.throws(() => dbB.exec('DELETE FROM compact_packed_pool_creation_swaps'), immutable);
  assert.throws(() => dbB.exec('UPDATE compact_packed_pool_creation_swaps SET swap_count = 0'), immutable);
  assert.throws(() => dbB.prepare(`INSERT INTO compact_packed_sets VALUES (?, ?, 'v', 'c', '[]', 0, 'x', 0, 'x', 0, 0)`).run(expired.dataset, expired.scope_start),
    immutable, 'an expired scope is never packed again');
  assert.equal(count(dbB, "sqlite_master WHERE type = 'trigger' AND name IN ('compact_packed_payload_no_delete', 'compact_packed_set_no_delete', 'compact_packed_piece_no_delete')"), 0);
});

await test('migration of a packed file written before expiry: the old unconditional delete triggers are replaced on open', async () => {
  const db = copyOf(dbB, 'b.sqlite', 'old-triggers.sqlite');
  db.exec(`DROP TRIGGER compact_packed_set_delete_guard; DROP TRIGGER compact_packed_piece_delete_guard; DROP TRIGGER compact_packed_payload_delete_guard;
    CREATE TRIGGER compact_packed_set_no_delete BEFORE DELETE ON compact_packed_sets BEGIN SELECT RAISE(ABORT,'immutable_packed_shards'); END;
    CREATE TRIGGER compact_packed_piece_no_delete BEFORE DELETE ON compact_packed_pieces BEGIN SELECT RAISE(ABORT,'immutable_packed_shards'); END;
    CREATE TRIGGER compact_packed_payload_no_delete BEFORE DELETE ON compact_packed_payloads BEGIN SELECT RAISE(ABORT,'immutable_packed_shards'); END;`);
  const store = createCompactStore(db, { packedShards: { config: EXPIRE, log: () => {} } });
  const triggers = db.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND name GLOB 'compact_packed_*delete*' ORDER BY name").all().map((r) => r.name);
  assert.deepEqual(triggers.filter((name) => name.endsWith('_no_delete')), ['compact_packed_creation_no_delete', 'compact_packed_expired_no_delete',
    'compact_packed_pool_swaps_no_delete', 'compact_packed_pruned_no_delete']);
  assert(triggers.includes('compact_packed_set_delete_guard') && triggers.includes('compact_packed_piece_delete_guard') && triggers.includes('compact_packed_payload_delete_guard'));
  for (let i = HOURS + EXTRA; i < HOURS + EXTRA + 3; i++) { store.commitHour(hourFixture(i).result); writeHourRows(db, hourFixture(i)); }
  assert.deepEqual(keys(db, 'compact_packed_expired'), expectedExpired(db, NEWEST + (EXTRA + 3) * HOUR));
  db.close();
});

await test('expiry OFF (retention ON) deletes no packed set; an expired empty scope never comes back as a pack candidate', async () => {
  const db = copyOf(dbB, 'b.sqlite', 'expiry-off.sqlite');
  const store = createCompactStore(db, { packedShards: { config: RETAIN, log: () => {} } });
  const before = keys(db, 'compact_packed_expired');
  for (let i = HOURS + EXTRA; i < HOURS + EXTRA + 30; i++) { store.commitHour(hourFixture(i).result); writeHourRows(db, hourFixture(i)); }
  assert.deepEqual(keys(db, 'compact_packed_expired'), before);
  assert.equal(store.packedShards.expired('compact_pool_hours', DAY0 + EMPTY_POOL_HOUR * HOUR), true, 'fixture: an empty pool hour expired');
  // With one scope per pass, the oldest pack candidate must be the newest hour's pool set, not the expired empty hour.
  const next = HOURS + EXTRA + 30;
  store.commitHour(hourFixture(next).result);
  writeHourRows(db, hourFixture(next));
  assert.equal(store.packedShards.maintain({ limit: 1 }).packed, 1);
  assert(db.prepare("SELECT 1 FROM compact_packed_sets WHERE dataset = 'compact_pool_hours' AND scope_start = ?").get(DAY0 + next * HOUR));
  db.close();
});

dbA.close();
dbB.close();
rmSync(dir, { recursive: true, force: true });
console.log(JSON.stringify({ measurements }, null, 1));
console.log(`COMPACT_PACKED_EXPIRY: PASS (${passed} scenarios, ${comparisons} A/B comparisons; Node ${process.version}; disposable SQLite, no network)`);
