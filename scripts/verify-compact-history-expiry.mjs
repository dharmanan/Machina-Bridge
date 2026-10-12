// Node 24: disposable SQLite files only. No network, no production database, no RPC.
// Verifies history expiry (server/compact/history-expiry.js, COMPACT_HISTORY_EXPIRY_ENABLED): OFF by default, only with
// packed expiry, refused with the evidence archive. Two databases get the same deterministic 70 days (identities, families,
// pool, price-path, fee, TVL, activity and DEX observation rows, statuses, valuations, coverage rows, discovery meta rows,
// registry): A without packing (the full history) and B with packing, retention, expiry and history expiry from its first
// hour. Every 24H/7D/30D read-model answer (with every previous-window comparison), every DEX correlation (first swap and
// liquidity proofs, early activity, stored swap counts) and every store accessor from the history floor on must be
// identical; before the floor the detail rows are gone and reported as gone (never empty), while canonical hours, status
// and coverage rows, the registry and all-history pool totals stay exact; foreign keys hold; the floor, the markers and the
// detail tables stop growing; the DAU replay never selects a day before the floor. A copy of A opened with history expiry
// (a file older than its floor that was never packed) folds and deletes the same way. Storage refusals and guards hold.
// Every deletion below happens in files this script creates.
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { archiveConfig } from '../server/compact/evidence-archive.js';
import { FAMILY_FIELDS } from '../server/compact/families.js';
import { HISTORY_HOUR_TABLES, HISTORY_KEEP_HOURS, HISTORY_META_PREFIXES, historyFloorOf } from '../server/compact/history-expiry.js';
import { INTELLIGENCE_REGISTRY, INTELLIGENCE_VERSION, registryDigest } from '../server/compact/intelligence-registry.js';
import { correlateDex } from '../server/compact/intelligence-store.js';
import { PACKED_DATASETS, packedShardsConfig } from '../server/compact/packed-shards.js';
import { ACTIVITY_KINDS, ACTIVITY_ROWS_PER_KIND } from '../server/compact/projections.js';
import { createCompactReadModel } from '../server/compact/read-model.js';
import { COMPACT_DEFINITION_VERSION } from '../server/compact/sources.js';
import { createCompactStore } from '../server/compact/store.js';
import { VALUATIONS } from '../server/compact/valuation.js';

globalThis.fetch = async () => { throw new Error('external_network_forbidden'); };
for (const key of ['COMPACT_PACKED_SHARDS_ENABLED', 'COMPACT_PACKED_RETENTION_ENABLED', 'COMPACT_PACKED_EXPIRY_ENABLED', 'COMPACT_HISTORY_EXPIRY_ENABLED',
  'COMPACT_PACKED_HOT_HOURS', 'COMPACT_PACKED_MAINTENANCE_SCOPES', 'COMPACT_PACKED_MAINTENANCE_MAX_MIB', 'COMPACT_EVIDENCE_ARCHIVE_ENABLED']) delete process.env[key];

const HOUR = 3600;
const DAY = 24 * HOUR;
const DAY0 = Date.parse('2026-06-01T00:00:00Z') / 1000;
const HOURS = 70 * 24; // the 61 kept days and nine more
const EXTRA = 48;
const NEWEST = DAY0 + (HOURS - 1) * HOUR;
const FLOOR = historyFloorOf(NEWEST);
const FLOOR_INDEX = (FLOOR - DAY0) / HOUR;
const EMPTY_POOL_HOUR = 5; // no pool row at all: legitimately empty, also before the floor
const FROZEN_HOUR = FLOOR_INDEX + 14; // valuations never became final: pruned only because they are frozen
const HISTORY = packedShardsConfig({ COMPACT_PACKED_SHARDS_ENABLED: 'true', COMPACT_PACKED_RETENTION_ENABLED: 'true', COMPACT_PACKED_EXPIRY_ENABLED: 'true',
  COMPACT_HISTORY_EXPIRY_ENABLED: 'true', COMPACT_PACKED_MAINTENANCE_SCOPES: '32' });
// Coverage rows under their own registry digest: correlateDex reads them, the ecosystem API (default registry) never does.
const FIXTURE_REGISTRY = Object.freeze({ ...INTELLIGENCE_REGISTRY, fixture: 'history-expiry-coverage' });
const sha = (text) => createHash('sha256').update(text).digest('hex');
const address = (label) => `0x${sha(label).slice(0, 40)}`;
const hash = (n) => `0x${n.toString(16).padStart(64, '0')}`;
const USDC = '0x3600000000000000000000000000000000000000';
const EURC = '0xbef5f6d51cb62b58e6a8f77868681825c6fe21c1';
const ZERO = `0x${'0'.repeat(40)}`;
const TOKEN = address('history-token-shared');
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
// 32 registry pools: before the first hour, before the floor, between the floor and the 36-day pool span, and after it.
const POOLS = Array.from({ length: 32 }, (_, k) => {
  const v4 = k % 2 === 1;
  const createdHour = k < 4 ? -3 : k < 12 ? 20 * k : (k * 53) % (HOURS - 10);
  return { k, v4, protocol: v4 ? 'uniswap_v4' : 'uniswap_v3', kind: v4 ? 'uniswap_v4_pool' : 'uniswap_v3_pool',
    pool: v4 ? `0x${sha(`history-pool-${k}`)}` : address(`history-pool-${k}`),
    token: k % 4 === 0 || k % 4 === 1 ? TOKEN : k % 4 === 3 ? EURC : address(`history-token-${k}`), createdHour };
});
function hourFixture(i) {
  const next = random(i + 11);
  const ids = new Set();
  const target = i % 97 === 13 ? 0 : 40;
  while (ids.size < target) ids.add(address(`history-identity-${Math.floor(next() * 3000)}`));
  const hourStart = DAY0 + i * HOUR, block = 100 + i;
  const pools = [], prices = [], fees = [], observations = [];
  for (const p of POOLS) {
    if (i === p.createdHour) observations.push([hourStart, p.protocol, p.pool, 'creation', block, p.k, hourStart + p.k, hash(10_000 + p.k)]);
    if (i < p.createdHour || i === EMPTY_POOL_HOUR) continue;
    if (i === p.createdHour ? p.k % 4 === 2 : next() < 0.55) continue;
    const swaps = Math.floor(next() * 12), adds = Math.floor(next() * 3);
    pools.push([hourStart, p.protocol, p.pool, swaps, digits(next, 24), digits(next, 24), digits(next, 30), digits(next, 30),
      adds, Math.floor(next() * 3), Math.floor(next() * 2),
      ...(p.v4 ? [null, null, null, null] : [digits(next, 20), digits(next, 20), digits(next, 20), digits(next, 20)])]);
    if (swaps > 0) {
      prices.push([hourStart, p.protocol, p.pool, swaps, block, block, 1, digits(next, 29), digits(next, 22), digits(next, 29), digits(next, 26), digits(next, 26)]);
      if (p.v4) fees.push([hourStart, p.pool, swaps, digits(next, 12), digits(next, 12), digits(next, 18), digits(next, 18)]);
      observations.push([hourStart, p.protocol, p.pool, 'swap', block, 40 + p.k, hourStart + 40 + p.k, hash(2_000_000 + i * 64 + p.k)]);
    }
    if (adds > 0) observations.push([hourStart, p.protocol, p.pool, 'liquidity', block, 80 + p.k, hourStart + 80 + p.k, hash(3_000_000 + i * 64 + p.k)]);
  }
  // Valid V3 activity rows: two swaps and one add every hour (their newest 500 are recent); removes three times an hour
  // before the floor and once every ten hours after it, so part of their newest 500 lies before the floor and stays.
  const activity = [];
  const row = (j, kind) => [block, j, hourStart, hourStart + j, hash(4_000_000 + i * 8 + j), address(`history-sender-${i % 50}`), 'uniswap_v3', kind,
    POOLS[0].pool, kind === 'swap' ? '-5' : '3', kind === 'swap' ? '7' : '4', kind === 'swap' ? 'v3_pool_delta' : 'v3_liquidity_amount',
    address(`history-counterparty-${j}`), kind === 'swap' ? 'swap_recipient' : 'liquidity_owner'];
  activity.push(row(1, 'swap'), row(2, 'swap'), row(3, 'add'));
  if (i < FLOOR_INDEX) activity.push(row(4, 'remove'), row(5, 'remove'), row(6, 'remove'));
  else if (i % 10 === 0) activity.push(row(4, 'remove'));
  const meta = [[`discovery_unit:${hourStart}:${sha('unit-a')}`, JSON.stringify({ fixture: i, kind: 'creations' })],
    [`discovery_spine_block:${hourStart}:${sha('unit-a')}:${String(block).padStart(16, '0')}`, JSON.stringify({ fixture: i })]];
  if (i % 3 === 0) meta.push([`discovery_unit_warning:${hourStart}:${sha('unit-b')}`, JSON.stringify({ reason: 'fixture' })]);
  if (i % 7 === 0) meta.push([`discovery_retry:${hourStart}:${sha('unit-c')}`, JSON.stringify({ attempts: 1 })]);
  if (i % 11 === 0) meta.push([`compact_dex_width:${hourStart}:uniswap_v3`, '16']);
  if (i % 13 === 0) meta.push([`family_repair_evidence:gateway:${String(hourStart).padStart(16, '0')}`, JSON.stringify({ originalReason: 'fixture', hourStart })]);
  return { i, result: identityHour(i, [...ids].sort()), pools, prices, fees, observations, activity, meta, next };
}
const bind = (row) => row.map((value) => (typeof value === 'number' ? BigInt(value) : value));
function writeRows(db, sql, rows) { const statement = db.prepare(sql); for (const row of rows) statement.run(...bind(row)); }
const registryRow = (p) => [p.kind, p.pool, 100 + p.createdHour, p.k, hash(10_000 + p.k), JSON.stringify(p.v4
  ? { currency0: USDC, currency1: p.token, fee: 3000, tickSpacing: 60, hooks: ZERO } : { token0: USDC, token1: p.token, fee: 500, tickSpacing: 10 })];
function writeRegistry(db) {
  writeRows(db, 'INSERT INTO compact_registry (kind, address, created_block, created_log_index, created_tx, meta_json) VALUES (?, ?, ?, ?, ?, ?)', POOLS.map(registryRow));
  writeRows(db, 'INSERT INTO compact_registry_coverage (kind, from_block, through_block, through_hash) VALUES (?, 1, 1000000000, ?)',
    [['uniswap_v3_pool', hash(1)], ['uniswap_v4_pool', hash(2)]]);
  db.prepare("INSERT INTO compact_meta VALUES ('discovery_registry:fixture', '{}')").run();
}
function writeHourRows(db, { i, result, pools, prices, fees, observations, activity, meta, next }) {
  const hour = result.range.hourStart;
  const count = (protocol, rows) => rows.filter((row) => row[1] === protocol).length;
  db.exec('BEGIN IMMEDIATE');
  try {
    writeRows(db, `INSERT INTO compact_pool_hours VALUES (${Array(15).fill('?').join(', ')})`, pools);
    writeRows(db, `INSERT INTO compact_pool_price_hours VALUES (${Array(12).fill('?').join(', ')})`, prices);
    writeRows(db, 'INSERT INTO compact_pool_fee_hours VALUES (?, ?, ?, ?, ?, ?, ?)', fees);
    writeRows(db, `INSERT INTO compact_dex_activity VALUES (${Array(14).fill('?').join(', ')})`, activity);
    writeRows(db, "INSERT INTO compact_projection_hours VALUES (?, ?, 'available', NULL, ?, ?)", [['uniswap_v3_pools', count('uniswap_v3', pools)],
      ['uniswap_v4_pools', count('uniswap_v4', pools)], ['uniswap_v3_price_paths', count('uniswap_v3', prices)],
      ['uniswap_v4_price_paths', count('uniswap_v4', prices)], ['uniswap_v4_swap_fees', fees.length], ['dex_activity', activity.length]]
      .map(([name, rows]) => [hour, name, rows, sha(`${hour}:${name}`)]));
    if (i === FROZEN_HOUR) writeRows(db, "INSERT INTO compact_valuation_hours VALUES (?, ?, 'unavailable', 'fixture', NULL, NULL)", VALUATIONS.map((name) => [hour, name]));
    else writeRows(db, "INSERT INTO compact_valuation_hours VALUES (?, ?, 'available', NULL, 2, ?)", VALUATIONS.map((name) => [hour, name, sha(`${hour}:${name}`)]));
    writeRows(db, 'INSERT INTO compact_token_price_hours VALUES (?, ?, ?, ?, ?, ?, ?)', [[hour, EURC, digits(next, 18), 'uniswap_v3', POOLS[3].pool, digits(next, 11), 1]]);
    for (const table of ['compact_dex_volume_hours', 'compact_dex_fee_hours']) {
      writeRows(db, `INSERT INTO ${table} VALUES (?, ?, ?, ?, ?)`, ['uniswap_v3', 'uniswap_v4'].map((protocol) => [hour, protocol, digits(next, 10), count(protocol, prices), 0]));
    }
    writeRows(db, "INSERT INTO compact_pool_tvl_hours VALUES (?, ?, ?, 'available', NULL, ?, ?, ?)",
      [POOLS[2], POOLS[3]].map((p) => [hour, p.protocol, p.pool, digits(next, 20), digits(next, 20), 100 + i]));
    writeRows(db, 'INSERT INTO compact_token_dex_observations VALUES (?, ?, ?, ?, ?, ?, ?, ?)', observations);
    writeRows(db, "INSERT INTO compact_intelligence_hours VALUES (?, ?, ?, 'fixture', 'available', '{\"firstDexComplete\":1}')",
      [[hour, INTELLIGENCE_VERSION, registryDigest(FIXTURE_REGISTRY)]]);
    writeRows(db, 'INSERT INTO compact_meta VALUES (?, ?)', meta);
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}

const count = (db, table) => db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
const rowsOf = (db, sql, ...args) => JSON.stringify(db.prepare(sql).all(...args), (_k, v) => (ArrayBuffer.isView(v) ? Buffer.from(v).toString('hex') : v));
const tableRows = (db, table, where = '') => rowsOf(db, `SELECT * FROM ${table} ${where} ORDER BY ${db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name).join(', ')}`);
const drain = (store) => {
  for (let pass = 0; pass < 2000; pass++) {
    const packed = store.packedShards.maintain({ limit: 256 });
    const history = store.history.maintain({ limit: 256 });
    if (!packed.expired && !packed.pruned && !packed.packed && !Object.keys(history.deleted).length) return pass;
  }
  throw new Error('drain_unfinished');
};
const apiAnswers = (path, newest = NEWEST) => {
  const model = createCompactReadModel({ path, DatabaseSync, now: () => (newest + HOUR + 60) * 1000 });
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
    out.dauReplayCandidate = model.dailyActiveReplayCandidate();
    return out;
  } finally { model.close(); }
};
const UNTOUCHED = ['compact_hours', 'compact_checkpoint', 'compact_projection_hours', 'compact_intelligence_hours', 'compact_registry',
  'compact_registry_coverage', 'compact_token_discoveries', 'compact_token_metadata', 'compact_daily_address_status_history'];
// Per pool: all-history swaps and pool-hour rows (A: every hot row; B: hot rows plus the pruned and folded totals).
const poolTotals = (db, packed) => {
  const totals = new Map(db.prepare('SELECT protocol, pool, SUM(swap_count) AS swaps, COUNT(*) AS rows FROM compact_pool_hours GROUP BY protocol, pool').all()
    .map((r) => [`${r.protocol}:${r.pool}`, { swaps: r.swaps, rows: r.rows }]));
  if (packed) {
    for (const r of db.prepare('SELECT protocol, pool, swap_count, row_count FROM compact_packed_pool_swaps').all()) {
      const entry = totals.get(`${r.protocol}:${r.pool}`) ?? { swaps: 0, rows: 0 };
      totals.set(`${r.protocol}:${r.pool}`, { swaps: entry.swaps + r.swap_count, rows: entry.rows + r.row_count });
    }
  }
  return JSON.stringify([...totals].sort(([a], [b]) => (a < b ? -1 : 1)));
};
const firstObservations = (db) => rowsOf(db, `SELECT o.* FROM compact_token_dex_observations o WHERE NOT EXISTS (SELECT 1 FROM compact_token_dex_observations e
  WHERE e.protocol = o.protocol AND e.pool = o.pool AND e.activity = o.activity AND (e.block_number < o.block_number
    OR (e.block_number = o.block_number AND e.log_index < o.log_index))) ORDER BY o.protocol, o.pool, o.activity`);

const dir = mkdtempSync(join(tmpdir(), 'compact-history-expiry-'));
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
const storeB = createCompactStore(dbB, { packedShards: { config: HISTORY, log: (line) => logs.push(line) } });
writeRegistry(dbA);
writeRegistry(dbB);
const buildStarted = performance.now();
for (let i = 0; i < HOURS; i++) {
  for (const [db, store] of [[dbA, storeA], [dbB, storeB]]) {
    store.commitHour(hourFixture(i).result);
    writeHourRows(db, hourFixture(i));
  }
}
measurements.build = { hours: HOURS, ms: Math.round(performance.now() - buildStarted) };
measurements.drainPasses = drain(storeB);
dbA.exec('PRAGMA wal_checkpoint(TRUNCATE)');
dbB.exec('PRAGMA wal_checkpoint(TRUNCATE)');

await test('configuration: OFF by default, needs packed expiry, refused with the evidence archive, before any write', async () => {
  assert.equal(packedShardsConfig({}).history, false);
  assert.equal(HISTORY.history, true);
  assert.equal(HISTORY_KEEP_HOURS, 61 * 24, '30D, the previous 30D and one day of margin');
  const refused = (extra, code) => assert.throws(() => packedShardsConfig(extra), (error) => error.code === code, code);
  refused({ COMPACT_HISTORY_EXPIRY_ENABLED: 'yes' }, 'invalid_history_expiry_enabled');
  refused({ COMPACT_PACKED_SHARDS_ENABLED: 'true', COMPACT_PACKED_RETENTION_ENABLED: 'true', COMPACT_HISTORY_EXPIRY_ENABLED: 'true' },
    'history_expiry_requires_packed_expiry');
  const db = new DatabaseSync(':memory:');
  assert.throws(() => createCompactStore(db, { archive: { config: archiveConfig({ COMPACT_EVIDENCE_ARCHIVE_ENABLED: 'true' }), log: () => {} },
    packedShards: { config: HISTORY, log: () => {} } }), (error) => error.code === 'history_expiry_requires_archive_off');
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name GLOB 'compact_*'").get().n, 0, 'nothing created');
  db.close();
  assert.equal(storeA.history.enabled, false);
  assert.equal(storeA.history.maintain(), null);
  assert.equal(storeA.history.floor(), null);
  assert.equal(storeB.history.floor(), FLOOR, 'the floor follows the checkpoint hour');
  assert.equal(dbB.prepare("SELECT hour_start FROM compact_packed_history_floor WHERE name = 'observations'").get().hour_start, FLOOR);
  assert.deepEqual(logs, []);
});

await test('read model: every 24H/7D/30D answer and every previous-window comparison is identical to the full history', async () => {
  const a = apiAnswers(pathOf('a.sqlite'));
  const b = apiAnswers(pathOf('b.sqlite'));
  for (const key of Object.keys(a)) { assert.deepEqual(b[key], a[key], key); comparisons++; }
  for (const window of ['7d', '30d']) {
    const previous = a[`summary:${window}`];
    assert.equal(previous.network.previous.uniqueActiveAddresses.status, 'available', `previous ${window} unique addresses`);
    assert.equal(previous.dex.usdVolume.previous.status, 'available', `previous ${window} USD volume`);
    assert.equal(previous.dex.swapFees.previous.status, 'available', `previous ${window} swap fees`);
    for (const protocol of ['v3', 'v4']) assert.equal(a[`pools:${protocol}:${window}`].status, 'available', `${protocol} ${window}`);
  }
  measurements.readModel = { answers: Object.keys(a).length, refusedOnBoth: Object.entries(a).filter(([, v]) => v?.error).map(([k, v]) => `${k}:${v.error}`) };
});

await test('ecosystem: first swap and liquidity proofs, early activity and all-history swap counts are identical', async () => {
  const proven = [];
  for (const registry of [INTELLIGENCE_REGISTRY, FIXTURE_REGISTRY]) {
    for (const token of [TOKEN, EURC]) {
      const a = correlateDex(dbA, token, 100 + HOURS - 1, { registry });
      assert.deepEqual(correlateDex(dbB, token, 100 + HOURS - 1, { registry }), a, token);
      comparisons++;
      if (registry === FIXTURE_REGISTRY) proven.push(...a.observedPools);
    }
  }
  const early = proven.filter((pool) => pool.earlyActivity.hourStart && Date.parse(pool.earlyActivity.hourStart) / 1000 < FLOOR);
  assert(early.some((pool) => pool.firstSwap.firstProven && pool.earlyActivity.status === 'available' && pool.earlyActivity.swapCount > 0),
    'fixture: a pool created before the floor keeps its proven first swap and its early count');
  assert(early.some((pool) => pool.firstLiquidity.firstProven), 'and a proven first liquidity');
  assert.equal(poolTotals(dbB, true), poolTotals(dbA, false), 'all-history swaps and pool-hour rows per pool');
  for (const p of POOLS.filter((pool) => pool.createdHour >= 0 && pool.createdHour < HOURS - 864)) {
    const kept = dbB.prepare('SELECT swap_count FROM compact_packed_pool_creation_swaps WHERE protocol = ? AND pool = ?').get(p.protocol, p.pool);
    const hot = dbA.prepare('SELECT swap_count FROM compact_pool_hours WHERE hour_start = ? AND protocol = ? AND pool = ?').get(DAY0 + p.createdHour * HOUR, p.protocol, p.pool);
    assert.deepEqual({ ...kept }, { swap_count: hot?.swap_count ?? null }, `creation count of pool ${p.k}`);
  }
});

await test('store: accessors from the floor on equal the full history; before it they answer history_expired, never empty', async () => {
  for (const i of [FLOOR_INDEX, FLOOR_INDEX + 23, HOURS - 864, HOURS - 1]) {
    const hour = DAY0 + i * HOUR;
    for (const read of ['familyRows', 'valuationStatus', 'tokenPrices', 'dexVolume', 'dexFees']) {
      assert.deepEqual(storeB[read](hour), storeA[read](hour), `${read} ${i}`);
      comparisons++;
    }
    assert.deepEqual(storeB.poolTvl(hour, 'uniswap_v3'), storeA.poolTvl(hour, 'uniswap_v3'));
    assert.deepEqual(storeB.familyWindow('usdc', hour + 23 * HOUR, 24), storeA.familyWindow('usdc', hour + 23 * HOUR, 24));
    comparisons += 2;
  }
  for (const i of [HOURS - 864, HOURS - 1]) {
    const hour = DAY0 + i * HOUR;
    assert.deepEqual(storeB.poolHours(hour, 'uniswap_v4'), storeA.poolHours(hour, 'uniswap_v4'));
    assert.deepEqual(storeB.persistedActiveAddresses(hour), storeA.persistedActiveAddresses(hour));
    comparisons += 2;
  }
  const gone = DAY0 + 100 * HOUR;
  const expired = (error) => error.code === 'history_expired';
  for (const read of [() => storeB.familyRows(gone), () => storeB.valuationStatus(gone), () => storeB.tokenPrices(gone), () => storeB.dexVolume(gone),
    () => storeB.dexFees(gone), () => storeB.poolTvl(gone, 'uniswap_v3'), () => storeB.poolHours(gone, 'uniswap_v3'), () => storeB.pricePaths(gone, 'uniswap_v4'),
    () => storeB.swapFees(gone)]) {
    assert.throws(read, expired);
  }
  assert(storeA.familyRows(gone).length > 0 && storeA.poolHours(gone, 'uniswap_v3').length > 0, 'A still holds them');
  assert.equal(storeB.familyWindow('usdc', gone + 23 * HOUR, 24).reason, 'history_expired');
  assert.equal(storeB.persistedActiveAddresses(gone), null, 'unknown, never re-read for a day before the floor');
  const empty = DAY0 + EMPTY_POOL_HOUR * HOUR;
  assert.deepEqual(storeB.poolHours(empty, 'uniswap_v3'), [], 'an hour its projections recorded as empty stays empty, not expired');
  assert.deepEqual(storeA.poolHours(empty, 'uniswap_v3'), []);
  assert.equal(storeB.packedShards.packHour(gone).compact_pool_hours.outcome, 'not_ready:history_expired', 'never packed again');
});

await test('before the floor: detail rows are deleted, only first observations and the newest activity stay', async () => {
  const before = (table, column = 'hour_start', bound = FLOOR) => `${table} WHERE ${column} < ${bound}`;
  const dayBound = FLOOR - (DAY - HOUR);
  const deleted = {};
  for (const table of HISTORY_HOUR_TABLES) {
    assert(count(dbA, before(table)) > 0, table);
    assert.equal(count(dbB, before(table)), 0, table);
    assert.equal(tableRows(dbB, table, `WHERE hour_start >= ${FLOOR}`), tableRows(dbA, table, `WHERE hour_start >= ${FLOOR}`), `${table} kept rows`);
    deleted[table] = count(dbA, before(table));
  }
  for (const [table, column, bound] of [['compact_daily_active_addresses', 'day_start', dayBound], ['compact_daily_address_hours', 'day_start', dayBound],
    ['compact_daily_address_stage', 'day_start', dayBound], ['compact_hour_addresses', 'hour_start', FLOOR], ['compact_pool_hours', 'hour_start', FLOOR],
    ['compact_pool_price_hours', 'hour_start', FLOOR], ['compact_pool_fee_hours', 'hour_start', FLOOR]]) {
    assert(count(dbA, before(table, column, bound)) > 0, table);
    assert.equal(count(dbB, before(table, column, bound)), 0, table);
    deleted[table] = count(dbA, before(table, column, bound));
  }
  assert.equal(tableRows(dbB, 'compact_daily_active_addresses', `WHERE day_start >= ${dayBound}`), tableRows(dbA, 'compact_daily_active_addresses', `WHERE day_start >= ${dayBound}`));
  // Activity: the newest 500 of each kind are the same rows; before the floor nothing else is left.
  for (const kind of ACTIVITY_KINDS) {
    const newest = `compact_dex_activity WHERE kind = '${kind}' ORDER BY block_number DESC, log_index DESC LIMIT ${ACTIVITY_ROWS_PER_KIND}`;
    assert.equal(rowsOf(dbB, `SELECT * FROM ${newest}`), rowsOf(dbA, `SELECT * FROM ${newest}`), kind);
    assert.equal(count(dbB, `compact_dex_activity WHERE kind = '${kind}' AND hour_start < ${FLOOR} AND (block_number, log_index) NOT IN
      (SELECT block_number, log_index FROM ${newest})`), 0, kind);
  }
  assert(count(dbB, `compact_dex_activity WHERE kind = 'remove' AND hour_start < ${FLOOR}`) > 100, 'fixture: newest removes before the floor stay');
  assert(count(dbA, "compact_dex_activity WHERE kind = 'remove'") > ACTIVITY_ROWS_PER_KIND, 'fixture: older removes are deleted');
  assert.equal(count(dbB, "compact_dex_activity WHERE kind = 'remove'"), ACTIVITY_ROWS_PER_KIND);
  assert.equal(tableRows(dbB, 'compact_dex_activity', `WHERE hour_start >= ${FLOOR}`), tableRows(dbA, 'compact_dex_activity', `WHERE hour_start >= ${FLOOR}`));
  // Observations: the first of every pool and activity (and every creation) is the same row; nothing later before the floor.
  assert.equal(firstObservations(dbB), firstObservations(dbA));
  assert.equal(tableRows(dbB, 'compact_token_dex_observations', `WHERE hour_start >= ${FLOOR}`),
    tableRows(dbA, 'compact_token_dex_observations', `WHERE hour_start >= ${FLOOR}`));
  assert.equal(count(dbB, `compact_token_dex_observations o WHERE o.hour_start < ${FLOOR} AND o.activity <> 'creation' AND EXISTS (SELECT 1
    FROM compact_token_dex_observations e WHERE e.protocol = o.protocol AND e.pool = o.pool AND e.activity = o.activity AND e.block_number < o.block_number)`), 0);
  assert.equal(count(dbB, "compact_token_dex_observations WHERE activity = 'creation'"), count(dbA, "compact_token_dex_observations WHERE activity = 'creation'"));
  deleted.compact_dex_activity = count(dbA, 'compact_dex_activity') - count(dbB, 'compact_dex_activity');
  deleted.compact_token_dex_observations = count(dbA, 'compact_token_dex_observations') - count(dbB, 'compact_token_dex_observations');
  // Meta rows: the four discovery namespaces and the gateway evidence before the floor are gone; nothing else changed.
  const metaBefore = (db) => [...HISTORY_META_PREFIXES, 'family_repair_evidence:gateway:'].reduce((n, prefix) => n + db.prepare(`SELECT COUNT(*) AS n
    FROM compact_meta WHERE key > ? AND key < ?`).get(prefix, `${prefix}${String(FLOOR).padStart(prefix.startsWith('family') ? 16 : 10, '0')}`).n, 0);
  assert(metaBefore(dbA) > 0);
  assert.equal(metaBefore(dbB), 0);
  const kept = (db) => rowsOf(db, "SELECT key, value FROM compact_meta WHERE key NOT GLOB 'discovery_unit*' AND key NOT GLOB 'discovery_retry:*' AND key NOT GLOB 'compact_dex_width:*' AND key NOT GLOB 'family_repair_evidence:*' ORDER BY key");
  assert.equal(kept(dbB), kept(dbA), 'spine blocks, the registry snapshot and definitions are untouched');
  const after = (db) => [...HISTORY_META_PREFIXES, 'family_repair_evidence:gateway:'].map((prefix) => rowsOf(db, `SELECT key, value FROM compact_meta
    WHERE key >= ? AND key < ? ORDER BY key`, `${prefix}${String(FLOOR).padStart(prefix.startsWith('family') ? 16 : 10, '0')}`, `${prefix}~`)).join();
  assert.equal(after(dbB), after(dbA));
  deleted.compact_meta = metaBefore(dbA);
  // Markers of scopes before the floor are gone; every later scope keeps its markers.
  for (const [dataset, { scope }] of Object.entries(PACKED_DATASETS)) {
    const bound = scope === 'day_start' ? dayBound : FLOOR;
    assert.equal(count(dbB, `compact_packed_pruned WHERE dataset = '${dataset}' AND scope_start < ${bound}`), 0, dataset);
    assert.equal(count(dbB, `compact_packed_expired WHERE dataset = '${dataset}' AND scope_start < ${bound}`), 0, dataset);
    // Pool sets expire after 36 days, so their markers stay from the floor on; identity sets expire exactly at the floor.
    assert(count(dbB, `compact_packed_${PACKED_DATASETS[dataset].projections ? 'expired' : 'pruned'} WHERE dataset = '${dataset}' AND scope_start >= ${bound}`) > 0,
      `${dataset} later markers`);
    assert.equal(count(dbB, `compact_packed_sets WHERE dataset = '${dataset}' AND scope_start < ${bound}`), 0, dataset);
  }
  assert(dbB.prepare("SELECT 1 FROM compact_packed_expired WHERE dataset = 'compact_pool_hours' AND scope_start = ?").get(DAY0 + FROZEN_HOUR * HOUR),
    'a pool hour whose valuations never became final is pruned and expired once they are frozen');
  measurements.deletedRows = deleted;
});

await test('integrity: canonical hours, statuses, coverage, registry and discoveries are untouched; foreign keys hold', async () => {
  for (const table of UNTOUCHED) { assert.equal(tableRows(dbB, table), tableRows(dbA, table), table); comparisons++; }
  assert.equal(count(dbB, 'compact_hours'), HOURS);
  assert.deepEqual(dbB.prepare('PRAGMA foreign_key_check').all(), []);
  assert.equal(dbB.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
});

await test('DAU replay: a day before the floor is gone, not missing, and is never selected for replay', async () => {
  const unfloored = (db) => db.prepare(`SELECT h.hour_start FROM compact_hours h LEFT JOIN compact_daily_address_hours c ON c.hour_start = h.hour_start
    LEFT JOIN compact_daily_active_addresses d ON d.day_start = h.hour_start - (h.hour_start % 86400)
    WHERE c.hour_start IS NULL AND (d.day_start IS NULL OR (d.status = 'unavailable' AND d.reason = 'identity_not_captured')) LIMIT 1`).get()?.hour_start ?? null;
  assert.equal(unfloored(dbA), null);
  assert(unfloored(dbB) < FLOOR, 'without the floor B would re-read a deleted day');
  assert.equal(storeB.dailyActiveReplayCandidate(), null);
  assert.equal(storeA.dailyActiveReplayCandidate(), null);
  assert.equal(apiAnswers(pathOf('b.sqlite')).dauReplayCandidate, null, 'the scheduler read model too');
});

await test('guards: the floor only grows; markers and sets before it follow the delete and insert guards', async () => {
  const floorImmutable = /immutable_history_floor/;
  const immutable = /immutable_packed_shards/;
  assert.throws(() => dbB.prepare("UPDATE compact_packed_history_floor SET hour_start = hour_start - 3600 WHERE name = 'details'").run(), floorImmutable);
  assert.throws(() => dbB.exec('DELETE FROM compact_packed_history_floor'), floorImmutable);
  const later = dbB.prepare("SELECT dataset, scope_start FROM compact_packed_expired WHERE dataset = 'compact_pool_hours' ORDER BY scope_start LIMIT 1").get();
  assert(later.scope_start >= FLOOR);
  assert.throws(() => dbB.prepare('DELETE FROM compact_packed_expired WHERE dataset = ? AND scope_start = ?').run(later.dataset, later.scope_start), immutable);
  assert.throws(() => dbB.prepare('DELETE FROM compact_packed_pruned WHERE dataset = ? AND scope_start = ?').run(later.dataset, later.scope_start), immutable);
  assert.throws(() => dbB.prepare(`INSERT INTO compact_packed_sets VALUES ('compact_pool_hours', ?, 'v', 'c', '[]', 0, 'x', 0, 'x', 0, 0)`).run(FLOOR - HOUR),
    immutable, 'no set before the floor');
  assert.throws(() => dbB.prepare("INSERT INTO compact_packed_pieces VALUES ('compact_hour_addresses', ?, 0, 1, 'x')").run(FLOOR - HOUR), immutable);
  assert.throws(() => dbB.prepare(`INSERT INTO compact_packed_sets VALUES ('compact_daily_address_stage', ?, 'v', 'c', '[]', 0, 'x', 0, 'x', 0, 0)`)
    .run(Math.floor(FLOOR / DAY) * DAY - DAY), immutable, 'no day set ending before the floor');
  // An empty scope before the floor (no rows, no set, no marker) is never a pack candidate again: with one scope per pass
  // the newest hour's pool set is packed, not the empty pool hour the floor passed.
  assert.equal(count(dbB, `compact_packed_pruned WHERE scope_start = ${DAY0 + EMPTY_POOL_HOUR * HOUR}`), 0, 'fixture: its markers are gone');
  const db = copyOf(dbB, 'b.sqlite', 'candidates.sqlite');
  const store = createCompactStore(db, { packedShards: { config: HISTORY, log: (line) => logs.push(line) } });
  store.commitHour(hourFixture(HOURS).result);
  writeHourRows(db, hourFixture(HOURS));
  assert.equal(store.packedShards.maintain({ limit: 1 }).packed, 1);
  assert(db.prepare("SELECT 1 FROM compact_packed_sets WHERE dataset = 'compact_pool_hours' AND scope_start = ?").get(DAY0 + HOURS * HOUR));
  db.close();
});

await test('growth is bounded: two more days leave every expired table, the markers and the packed sets at the same size', async () => {
  const sizes = (db, packed = true) => Object.fromEntries([...HISTORY_HOUR_TABLES, 'compact_daily_active_addresses', 'compact_daily_address_hours',
    ...(packed ? ['compact_packed_pruned', 'compact_packed_expired', 'compact_packed_sets'] : [])].map((table) => [table, count(db, table)]));
  const beforeB = sizes(dbB), beforeA = sizes(dbA, false);
  const tables = dbB.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name GLOB 'compact_*' ORDER BY name").all().map((r) => r.name);
  const rowsBefore = Object.fromEntries(tables.map((table) => [table, count(dbB, table)]));
  const fileBefore = { a: statSync(pathOf('a.sqlite')).size, b: statSync(pathOf('b.sqlite')).size };
  for (let i = HOURS; i < HOURS + EXTRA; i++) {
    for (const [db, store] of [[dbA, storeA], [dbB, storeB]]) { store.commitHour(hourFixture(i).result); writeHourRows(db, hourFixture(i)); }
  }
  drain(storeB);
  for (const db of [dbA, dbB]) db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  const newest = NEWEST + EXTRA * HOUR, floor = historyFloorOf(newest);
  assert.equal(storeB.history.floor(), floor);
  assert.deepEqual(sizes(dbB), beforeB, 'one hour (and one day) leaves for every hour (and day) that arrives');
  for (const table of HISTORY_HOUR_TABLES) assert(sizes(dbA, false)[table] > beforeA[table], `A grows ${table}`);
  for (const table of [...HISTORY_HOUR_TABLES, 'compact_hour_addresses', 'compact_pool_price_hours', 'compact_pool_fee_hours', 'compact_pool_hours']) {
    assert.equal(count(dbB, `${table} WHERE hour_start < ${floor}`), 0, table);
  }
  assert.equal(count(dbB, 'compact_hours'), HOURS + EXTRA, 'canonical hours keep growing (one row per hour)');
  assert.deepEqual(dbB.prepare('PRAGMA foreign_key_check').all(), []);
  const b = apiAnswers(pathOf('b.sqlite'), newest), a = apiAnswers(pathOf('a.sqlite'), newest);
  for (const key of Object.keys(a)) { assert.deepEqual(b[key], a[key], key); comparisons++; }
  // What still adds rows in B: per hour, one canonical hour with its projection status and coverage rows, and (fixture only)
  // one immutable spine control key; per pool, the all-history totals and creation counts; and windowed tables whose row
  // count follows the volume inside their window (this fixture's later hours hold more pools), checked here to hold
  // nothing older than that window: hot packed rows (48 hours), live packed pieces and payloads, activity and observations
  // (the floor, apart from the newest 500 per kind and the first observations).
  const grew = Object.fromEntries(tables.map((table) => [table, count(dbB, table) - rowsBefore[table]]).filter(([, n]) => n > 0));
  const PER_HOUR = ['compact_hours', 'compact_projection_hours', 'compact_intelligence_hours', 'compact_meta'];
  const PER_POOL = ['compact_packed_pool_swaps', 'compact_packed_pool_creation_swaps'];
  const WINDOWED = [...Object.keys(PACKED_DATASETS), 'compact_packed_pieces', 'compact_packed_payloads', 'compact_dex_activity', 'compact_token_dex_observations'];
  assert.deepEqual(Object.keys(grew).filter((table) => ![...PER_HOUR, ...PER_POOL, ...WINDOWED].includes(table)), [], 'nothing else grows');
  assert.equal(grew.compact_hours, EXTRA);
  for (const [dataset, { scope }] of Object.entries(PACKED_DATASETS)) {
    assert.equal(count(dbB, `${dataset} WHERE ${scope} + ${scope === 'day_start' ? DAY - HOUR : 0} <= ${newest - 48 * HOUR}`), 0, `${dataset}: hot rows only inside 48 hours`);
  }
  assert.equal(count(dbB, 'compact_packed_pieces p WHERE NOT EXISTS (SELECT 1 FROM compact_packed_sets s WHERE s.dataset = p.dataset AND s.scope_start = p.scope_start)'), 0);
  assert.equal(count(dbB, 'compact_packed_payloads y WHERE NOT EXISTS (SELECT 1 FROM compact_packed_pieces p WHERE p.payload_sha256 = y.payload_sha256)'), 0);
  assert(count(dbB, 'compact_packed_pool_swaps') <= POOLS.length && count(dbB, 'compact_packed_pool_creation_swaps') <= POOLS.length);
  assert.equal(count(dbB, `compact_meta WHERE key NOT GLOB 'discovery_spine_block:*' AND key > 'discovery_unit:' AND key < 'discovery_unit:${floor}'`), 0);
  measurements.growth2Days = { b: { before: beforeB, after: sizes(dbB) }, rowsAddedInB: grew, fileGrowthBytes: { a: statSync(pathOf('a.sqlite')).size - fileBefore.a,
    b: statSync(pathOf('b.sqlite')).size - fileBefore.b } };
});

await test('an existing file older than the floor and never packed: folded and deleted the same way (A reopened with history expiry)', async () => {
  const db = copyOf(dbA, 'a.sqlite', 'c.sqlite');
  const store = createCompactStore(db, { packedShards: { config: HISTORY, log: (line) => logs.push(line) } });
  const passes = drain(store);
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  const newest = NEWEST + EXTRA * HOUR, floor = historyFloorOf(newest);
  for (const table of [...HISTORY_HOUR_TABLES, 'compact_hour_addresses', 'compact_pool_price_hours', 'compact_pool_fee_hours', 'compact_pool_hours']) {
    assert.equal(count(db, `${table} WHERE hour_start < ${floor}`), 0, table);
  }
  assert.equal(poolTotals(db, true), poolTotals(dbA, false), 'folded hours keep their swaps in the all-history totals');
  for (const registry of [INTELLIGENCE_REGISTRY, FIXTURE_REGISTRY]) {
    for (const token of [TOKEN, EURC]) {
      assert.deepEqual(correlateDex(db, token, 100 + HOURS + EXTRA - 1, { registry }), correlateDex(dbA, token, 100 + HOURS + EXTRA - 1, { registry }), token);
      comparisons++;
    }
  }
  const folded = POOLS.filter((p) => p.createdHour >= 0 && p.createdHour < (floor - DAY0) / HOUR);
  assert(folded.length >= 4, 'fixture: pools created in folded hours');
  for (const p of folded) {
    const hot = dbA.prepare('SELECT swap_count FROM compact_pool_hours WHERE hour_start = ? AND protocol = ? AND pool = ?').get(DAY0 + p.createdHour * HOUR, p.protocol, p.pool);
    assert.deepEqual({ ...db.prepare('SELECT swap_count FROM compact_packed_pool_creation_swaps WHERE protocol = ? AND pool = ?').get(p.protocol, p.pool) },
      { swap_count: hot?.swap_count ?? null }, `pool ${p.k}`);
  }
  for (const table of UNTOUCHED) assert.equal(tableRows(db, table), tableRows(dbA, table), table);
  assert.equal(firstObservations(db), firstObservations(dbA));
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  db.close();
  const b = apiAnswers(pathOf('c.sqlite'), newest), a = apiAnswers(pathOf('a.sqlite'), newest);
  for (const key of Object.keys(a)) { assert.deepEqual(b[key], a[key], key); comparisons++; }
  measurements.reopened = { drainPasses: passes };
});

await test('safety: a storage refusal deletes nothing (reported and logged once); with space the same pass deletes', async () => {
  let free = 10 * 1024 ** 3;
  const minFree = archiveConfig({}).minFreeBytes;
  const db = copyOf(dbA, 'a.sqlite', 'storage.sqlite');
  const log = [];
  const store = createCompactStore(db, { archive: { config: archiveConfig({}), capacity: () => ({ freeBytes: free, databaseBytes: 0 }), log: () => {} },
    packedShards: { config: HISTORY, log: (line) => log.push(line) } });
  const families = count(db, 'compact_family_hours');
  free = minFree + 257 * 1024; // the store's 64 KiB writer check (4 x 64 KiB) passes; a deletion's plan (64 KiB + its rows) does not
  const refused = store.history.maintain({ limit: 256 });
  assert.equal(count(db, 'compact_family_hours'), families);
  assert.deepEqual(refused.deleted, {});
  assert.deepEqual(refused.failed.map((f) => f.reason), ['storage_blocked:storage_low_space']);
  assert.equal(log.length, 1);
  assert(log[0].startsWith('HISTORY_EXPIRY_BLOCKED '));
  free = 10 * 1024 ** 3;
  const done = store.history.maintain({ limit: 256 });
  assert(done.deleted.compact_family_hours > 0 && count(db, 'compact_family_hours') < families);
  db.close();
});

dbA.close();
dbB.close();
rmSync(dir, { recursive: true, force: true });
console.log(JSON.stringify({ measurements }, null, 1));
console.log(`COMPACT_HISTORY_EXPIRY: PASS (${passed} scenarios, ${comparisons} A/B comparisons; Node ${process.version}; disposable SQLite, no network)`);
