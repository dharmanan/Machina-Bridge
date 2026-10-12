// Node 24: disposable SQLite files only. No network, no production database, no RPC.
// Verifies exact 7D/30D unique active addresses (server/compact/address-union.js through the read model): the union of the
// stored daily and hourly identity sets, each address counted once, equals a brute-force union of the generated identities
// for every window and for random spans, both when every set is hot (A: SQLite counts) and when retention moved most sets
// into packed sets (B: verified streams merged in address order). A day without a usable daily set falls back to its
// hours; an hour without a complete set, or a packed set that does not verify, makes the window unavailable (never an
// estimate) while the rest of the summary is still served; 24H and 1H answers keep their previous path; a large union stays
// within a 48 MiB old-space heap (child process). Every deletion below happens in files this script creates.
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getHeapStatistics } from 'node:v8';
import { uniqueAddressesOfSpan } from '../server/compact/address-union.js';
import { FAMILY_FIELDS } from '../server/compact/families.js';
import { createPackedShards, packedShardsConfig } from '../server/compact/packed-shards.js';
import { createCompactReadModel } from '../server/compact/read-model.js';
import { COMPACT_DEFINITION_VERSION } from '../server/compact/sources.js';
import { createCompactStore } from '../server/compact/store.js';

globalThis.fetch = async () => { throw new Error('external_network_forbidden'); };
for (const key of ['COMPACT_PACKED_SHARDS_ENABLED', 'COMPACT_PACKED_RETENTION_ENABLED', 'COMPACT_PACKED_HOT_HOURS', 'COMPACT_PACKED_MAINTENANCE_SCOPES',
  'COMPACT_EVIDENCE_ARCHIVE_ENABLED']) delete process.env[key];

const HOUR = 3600;
const DAY = 24 * HOUR;
const DAY0 = Date.parse('2026-08-01T00:00:00Z') / 1000;
const HOURS = 730; // the newest hour is 09:00 UTC, so 7D and 30D windows start and end inside a UTC day
const NEWEST = DAY0 + (HOURS - 1) * HOUR;
const PACK = packedShardsConfig({ COMPACT_PACKED_SHARDS_ENABLED: 'true' });
const RETAIN = packedShardsConfig({ COMPACT_PACKED_SHARDS_ENABLED: 'true', COMPACT_PACKED_RETENTION_ENABLED: 'true', COMPACT_PACKED_MAINTENANCE_SCOPES: '32' });
const sha = (text) => createHash('sha256').update(text).digest('hex');
const address = (label) => `0x${sha(label).slice(0, 40)}`;
const hash = (n) => `0x${n.toString(16).padStart(64, '0')}`;

// Identity-only hours (families unavailable), one block each, hash-linked (as in verify-compact-packed-retention.mjs).
function identityHour(i, identities) {
  const hourStart = DAY0 + i * HOUR, block = 100 + i;
  return { definitionVersion: COMPACT_DEFINITION_VERSION, chainId: 5042, sourceVersions: {}, complete: false,
    range: { kind: 'hour', hourStart, hourEnd: hourStart + HOUR, firstBlock: block, lastBlock: block, parentHash: hash(block - 1), firstHash: hash(block), lastHash: hash(block) },
    network: { status: 'available', blockCount: 1, transactionCount: identities.length, uniqueActiveAddresses: identities.length, gasUsedRaw: '42000' },
    activeAddresses: identities,
    families: Object.fromEntries(Object.entries(FAMILY_FIELDS).map(([name, fields]) => [name, { status: 'unavailable', reason: 'fixture', ...Object.fromEntries(fields.map((f) => [f, null])) }])),
    registry: { uniswapV3: null } };
}
// Deterministic PRNG (mulberry32).
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
// 0..400 identities per hour (some hours empty) drawn from 40,000, so windows overlap and the hourly sum is far above
// the union.
function identitiesOf(i, { perHour = 400, pool = 40_000, label = 'unique-identity' } = {}) {
  const next = random(i + 7);
  const target = i % 97 === 13 ? 0 : Math.floor(next() * perHour);
  const ids = new Set();
  while (ids.size < target) ids.add(address(`${label}-${Math.floor(next() * pool)}`));
  return [...ids].sort();
}
const IDENTITIES = Array.from({ length: HOURS }, (_, i) => identitiesOf(i));
const bruteForce = (from, to) => {
  const seen = new Set();
  for (let hour = from; hour <= to; hour += HOUR) for (const id of IDENTITIES[(hour - DAY0) / HOUR]) seen.add(id);
  return seen.size;
};
const hourlySum = (from, to) => { let sum = 0; for (let hour = from; hour <= to; hour += HOUR) sum += IDENTITIES[(hour - DAY0) / HOUR].length; return sum; };

// Low-heap child: the 7D union of a large database whose day and hour sets retention moved into packed sets, through the
// read model, under the recovery heap limits. Prints the answer and the sampled heap.
if (process.env.UNIQUE_LOW_HEAP_CHILD === 'collect') {
  // Negative control: the same 7D identities collected into one in-memory Set, as a naive union would.
  const db = new DatabaseSync(process.env.UNIQUE_LOW_HEAP_DB);
  const packed = createPackedShards(db, { config: { enabled: false } });
  const newest = db.prepare('SELECT MAX(hour_start) AS hour FROM compact_hours').get().hour;
  const seen = new Set();
  for (let hour = newest - 167 * HOUR; hour <= newest; hour += HOUR) {
    if (!packed.forEachRow('compact_hour_addresses', hour, (row) => seen.add(Buffer.from(row.address).toString('hex')))) {
      for (const row of db.prepare('SELECT address FROM compact_hour_addresses WHERE hour_start = ?').iterate(hour)) seen.add(Buffer.from(row.address).toString('hex'));
    }
  }
  console.log(JSON.stringify({ mode: 'collect', unique: seen.size }));
  process.exit(0);
}
if (process.env.UNIQUE_LOW_HEAP_CHILD) {
  let peak = 0;
  const timer = setInterval(() => { peak = Math.max(peak, process.memoryUsage().heapUsed); }, 1);
  const model = createCompactReadModel({ path: process.env.UNIQUE_LOW_HEAP_DB, DatabaseSync, now: () => Date.parse(process.env.UNIQUE_LOW_HEAP_NOW) });
  const started = performance.now();
  const network = model.summary('7d').network;
  const ms = Math.round(performance.now() - started);
  peak = Math.max(peak, process.memoryUsage().heapUsed);
  clearInterval(timer);
  model.close();
  console.log(JSON.stringify({ unique: network.uniqueActiveAddresses, ms, heapLimit: getHeapStatistics().heap_size_limit, peakHeapUsed: peak,
    maxRssBytes: process.resourceUsage().maxRSS * 1024 }));
  process.exit(0);
}

const dir = mkdtempSync(join(tmpdir(), 'compact-unique-addresses-'));
const pathOf = (name) => join(dir, name);
const open = (name) => new DatabaseSync(pathOf(name));
const copyOf = (db, from, to) => { db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); copyFileSync(pathOf(from), pathOf(to)); return open(to); };
let passed = 0;
let comparisons = 0;
const measurements = {};
const test = async (name, fn) => { await fn(); passed++; console.log(`PASS ${name}`); };
const modelOf = (name) => createCompactReadModel({ path: pathOf(name), DatabaseSync, now: () => (NEWEST + HOUR + 60) * 1000 });
const unionOf = (db, from, to, options = {}) => uniqueAddressesOfSpan(db, from, to, { packed: createPackedShards(db, { config: { enabled: false } }), ...options });

const logs = [];
const dbA = open('a.sqlite');
const storeA = createCompactStore(dbA, { packedShards: { log: (line) => logs.push(line) } });
const dbB = open('b.sqlite');
const storeB = createCompactStore(dbB, { packedShards: { config: RETAIN, log: (line) => logs.push(line) } });
const buildStarted = performance.now();
for (let i = 0; i < HOURS; i++) {
  storeA.commitHour(identityHour(i, IDENTITIES[i]));
  storeB.commitHour(identityHour(i, IDENTITIES[i]));
}
for (let report; (report = storeB.packedShards.maintain({ limit: 256 })).pruned || report.packed;);
dbA.exec('PRAGMA wal_checkpoint(TRUNCATE)');
dbB.exec('PRAGMA wal_checkpoint(TRUNCATE)');
measurements.build = { hours: HOURS, ms: Math.round(performance.now() - buildStarted), prunedScopesB: dbB.prepare('SELECT COUNT(*) AS n FROM compact_packed_pruned').get().n };

// The windows the summary serves: [from, to] of the current and previous 24H, 7D and 30D.
const WINDOWS = {
  '24h': [NEWEST - 23 * HOUR, NEWEST], 'previous 24h': [NEWEST - 47 * HOUR, NEWEST - 24 * HOUR],
  '7d': [NEWEST - 167 * HOUR, NEWEST], 'previous 7d': [NEWEST - 335 * HOUR, NEWEST - 168 * HOUR], '30d': [NEWEST - 719 * HOUR, NEWEST],
};

await test('fixture: B keeps only the newest 48 hours hot; every older hour and completed day is a packed set', async () => {
  assert.deepEqual(logs, []);
  assert.equal(dbB.prepare("SELECT COUNT(*) AS n FROM compact_packed_pruned WHERE dataset = 'compact_hour_addresses'").get().n, HOURS - 48);
  assert.equal(dbB.prepare("SELECT COUNT(*) AS n FROM compact_packed_pruned WHERE dataset = 'compact_daily_address_stage'").get().n, 28);
  assert.equal(dbA.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name GLOB 'compact_packed_*'").get().n, 0, 'A: no packing');
  for (const [name, [from, to]] of Object.entries(WINDOWS)) assert(hourlySum(from, to) > bruteForce(from, to) || from === to, name);
});

await test('read model: 24H, 7D and 30D (and the previous 24H and 7D) unique addresses equal the brute-force union in A and B', async () => {
  const summaries = {};
  for (const name of ['a.sqlite', 'b.sqlite']) {
    const model = modelOf(name);
    try { summaries[name] = Object.fromEntries(['24h', '7d', '30d'].map((window) => [window, model.summary(window).network])); } finally { model.close(); }
  }
  for (const name of ['a.sqlite', 'b.sqlite']) {
    const network = summaries[name];
    const expect = (actual, window) => { assert.deepEqual(actual, { status: 'available', value: bruteForce(...WINDOWS[window]) }, `${name} ${window}`); comparisons++; };
    expect(network['24h'].uniqueActiveAddresses, '24h');
    expect(network['24h'].previous.uniqueActiveAddresses, 'previous 24h');
    expect(network['7d'].uniqueActiveAddresses, '7d');
    expect(network['7d'].previous.uniqueActiveAddresses, 'previous 7d');
    expect(network['30d'].uniqueActiveAddresses, '30d');
    assert.deepEqual(network['30d'].previous.uniqueActiveAddresses, { status: 'unavailable', reason: 'insufficient_coverage', value: null },
      'no previous 30D is stored');
  }
  assert.deepEqual(summaries['b.sqlite'], summaries['a.sqlite'], 'every network answer is identical with retention');
  measurements.windows = Object.fromEntries(Object.entries(WINDOWS).map(([name, span]) => [name, { union: bruteForce(...span), hourlySum: hourlySum(...span) }]));
});

await test('random spans (day-aligned, inside one day, single hours, whole history) equal the brute-force union in A and B', async () => {
  const next = random(99);
  const spans = [[DAY0, NEWEST], [DAY0, DAY0], [DAY0 + 5 * DAY, DAY0 + 6 * DAY - HOUR], [DAY0 + 5 * DAY + HOUR, DAY0 + 6 * DAY], [NEWEST, NEWEST],
    [DAY0 + 13 * HOUR, DAY0 + 13 * HOUR]];
  for (let k = 0; k < 24; k++) {
    const a = Math.floor(next() * HOURS), b = Math.floor(next() * HOURS);
    spans.push([DAY0 + Math.min(a, b) * HOUR, DAY0 + Math.max(a, b) * HOUR]);
  }
  for (const [from, to] of spans) {
    const expected = { status: 'available', value: bruteForce(from, to) };
    assert.deepEqual(unionOf(dbA, from, to), expected, `A ${from}..${to}`);
    assert.deepEqual(unionOf(dbB, from, to), expected, `B ${from}..${to}`);
    comparisons += 2;
  }
});

await test('a day without a usable daily set falls back to its 24 hourly sets; a daily set covers an incomplete hour', async () => {
  const db = copyOf(dbA, 'a.sqlite', 'fallback.sqlite');
  const [from, to] = WINDOWS['7d'];
  const day = Math.ceil(from / DAY) * DAY + DAY; // a completed day inside the 7D window
  const expected = { status: 'available', value: bruteForce(from, to) };
  db.prepare("UPDATE compact_daily_active_addresses SET status = 'unavailable', reason = 'identity_not_captured', active_addresses = NULL WHERE day_start = ?").run(day);
  assert.deepEqual(unionOf(db, from, to), expected, 'daily count not available');
  db.prepare("UPDATE compact_daily_active_addresses SET status = 'available', reason = NULL, active_addresses = ? WHERE day_start = ?")
    .run(db.prepare('SELECT COUNT(*) AS n FROM compact_daily_address_stage WHERE day_start = ?').get(day).n, day);
  db.prepare('DELETE FROM compact_daily_address_stage WHERE day_start = ? AND address = (SELECT address FROM compact_daily_address_stage WHERE day_start = ? LIMIT 1)').run(day, day);
  assert.deepEqual(unionOf(db, from, to), expected, 'daily set incomplete');
  // The other way round: an hour of a completed day loses a row, but its day's complete daily set still covers it.
  const other = day + DAY;
  const hour = other + 5 * HOUR;
  assert(IDENTITIES[(hour - DAY0) / HOUR].length > 0);
  db.prepare('DELETE FROM compact_hour_addresses WHERE hour_start = ? AND address = (SELECT address FROM compact_hour_addresses WHERE hour_start = ? LIMIT 1)').run(hour, hour);
  assert.deepEqual(unionOf(db, from, to), expected, 'the daily set is the union of the day\'s hours');
  comparisons += 3;
  db.close();
});

await test('an hour without a complete set makes the window unavailable (never an estimate); 24H and the rest of the summary are kept', async () => {
  const db = copyOf(dbA, 'a.sqlite', 'missing-hour.sqlite');
  const [from] = WINDOWS['7d'];
  const edge = from + 2 * HOUR; // before the first completed day of the window: only its hourly set can cover it
  assert(Math.ceil(from / DAY) * DAY > edge && IDENTITIES[(edge - DAY0) / HOUR].length > 0);
  db.prepare('DELETE FROM compact_hour_addresses WHERE hour_start = ? AND address = (SELECT address FROM compact_hour_addresses WHERE hour_start = ? LIMIT 1)').run(edge, edge);
  db.close();
  const model = modelOf('missing-hour.sqlite');
  try {
    const seven = model.summary('7d').network;
    assert.deepEqual(seven.uniqueActiveAddresses, { status: 'unavailable', reason: 'identity_incomplete', value: null });
    assert.equal(seven.status, 'available');
    assert.equal(seven.transactions, hourlySum(...WINDOWS['7d']), 'additive network metrics are unaffected');
    assert.deepEqual(model.summary('24h').network.uniqueActiveAddresses, { status: 'available', value: bruteForce(...WINDOWS['24h']) });
    // In 30D the same hour lies inside a completed UTC day, whose complete daily set still gives the exact union.
    assert.deepEqual(model.summary('30d').network.uniqueActiveAddresses, { status: 'available', value: bruteForce(...WINDOWS['30d']) });
  } finally { model.close(); }
  // A whole hour missing (as when only an archive would hold it) is the same: unavailable, not a smaller union.
  const gone = copyOf(dbA, 'a.sqlite', 'gone-hour.sqlite');
  gone.prepare('DELETE FROM compact_hour_addresses WHERE hour_start = ?').run(edge);
  assert.deepEqual(unionOf(gone, ...WINDOWS['7d']), { status: 'unavailable', reason: 'identity_incomplete', value: null });
  gone.close();
});

await test('a packed set that does not verify makes the window unavailable (identity_unverified); the summary is still served', async () => {
  const db = copyOf(dbB, 'b.sqlite', 'corrupt.sqlite');
  const [from] = WINDOWS['7d'];
  const day = Math.ceil(from / DAY) * DAY;
  db.exec('DROP TRIGGER compact_packed_payload_no_update');
  db.prepare(`UPDATE compact_packed_payloads SET payload = zeroblob(length(payload)) WHERE payload_sha256 =
    (SELECT payload_sha256 FROM compact_packed_pieces WHERE dataset = 'compact_daily_address_stage' AND scope_start = ? AND part = 0)`).run(day);
  db.close();
  const model = modelOf('corrupt.sqlite');
  try {
    const seven = model.summary('7d').network;
    assert.deepEqual(seven.uniqueActiveAddresses, { status: 'unavailable', reason: 'identity_unverified', value: null });
    assert.equal(seven.transactions, hourlySum(...WINDOWS['7d']));
    assert.deepEqual(model.summary('24h').network.uniqueActiveAddresses, { status: 'available', value: bruteForce(...WINDOWS['24h']) });
  } finally { model.close(); }
});

await test('answers are cached by the exact sets they used; a different set choice is counted again; reads change nothing', async () => {
  const cache = new Map();
  const [from, to] = WINDOWS['30d'];
  const writes = (db) => db.prepare('SELECT total_changes() AS n').get().n;
  const before = [writes(dbA), writes(dbB)];
  const first = unionOf(dbB, from, to, { cache });
  assert.equal(cache.size, 1);
  assert.equal(unionOf(dbB, from, to, { cache }), first, 'same sets: the cached answer');
  assert.deepEqual(unionOf(dbA, from, to, { cache }), first, 'hot sets of the same window: a different key, counted again, same value');
  assert.equal(cache.size, 2);
  for (let k = 0; k < 20; k++) unionOf(dbA, from - k * HOUR, to, { cache, cacheLimit: 4 });
  assert.equal(cache.size, 4, 'bounded');
  assert.deepEqual([writes(dbA), writes(dbB)], before, 'counting writes nothing');
});

await test('performance (synthetic, measured): 7D/30D unions in A (SQLite count) and B (packed streams merged)', async () => {
  const time = (db, span) => { const started = performance.now(); unionOf(db, ...span); return Number((performance.now() - started).toFixed(1)); };
  measurements.unionMs = Object.fromEntries(['7d', '30d'].map((window) => [window, { inputRows: hourlySum(...WINDOWS[window]),
    a: time(dbA, WINDOWS[window]), b: time(dbB, WINDOWS[window]) }]));
});

await test('low heap: a 7D union over large packed day and hour sets stays within a 48 MiB old space and is exact', async () => {
  const path = pathOf('large.sqlite');
  const db = new DatabaseSync(path);
  const store = createCompactStore(db, { packedShards: { config: RETAIN, log: () => {} } });
  const big = (i) => identitiesOf(i, { perHour: 12_000, pool: 4_000_000, label: 'unique-low-heap' });
  const hours = 8 * 24 + 10;
  const exact = new Set();
  const newest = DAY0 + (hours - 1) * HOUR;
  for (let i = 0; i < hours; i++) {
    const ids = big(i);
    if (DAY0 + i * HOUR >= newest - 167 * HOUR) for (const id of ids) exact.add(id);
    store.commitHour(identityHour(i, ids));
  }
  for (let report; (report = store.packedShards.maintain({ limit: 256 })).pruned || report.packed;);
  const prunedDays = db.prepare("SELECT COUNT(*) AS n FROM compact_packed_pruned WHERE dataset = 'compact_daily_address_stage'").get().n;
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  db.close();
  const run = (mode) => spawnSync(process.execPath, ['--max-old-space-size=48', '--max-semi-space-size=2', fileURLToPath(import.meta.url)], {
    env: { ...process.env, UNIQUE_LOW_HEAP_CHILD: mode, UNIQUE_LOW_HEAP_DB: path, UNIQUE_LOW_HEAP_NOW: new Date((newest + HOUR + 60) * 1000).toISOString() },
    encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  const control = run('collect');
  assert.notEqual(control.status, 0, 'negative control: one in-memory Set of the 7D identities exceeds this heap');
  assert.match(control.stderr, /heap out of memory/i, control.stderr.slice(-400));
  const child = run('union');
  assert.equal(child.status, 0, child.stderr);
  const out = JSON.parse(child.stdout.trim().split('\n').at(-1));
  assert.deepEqual(out.unique, { status: 'available', value: exact.size });
  assert(prunedDays >= 6, 'the window is served from packed day sets');
  assert(out.heapLimit <= 64 * 1024 * 1024 && out.peakHeapUsed < out.heapLimit);
  measurements.lowHeap = { fixture: `${hours} hours x up to 12,000 random identities (of 4,000,000)`, unique: exact.size,
    prunedDays, ms: out.ms, heapLimitBytes: out.heapLimit, peakSampledHeapUsedBytes: out.peakHeapUsed, maxRssBytes: out.maxRssBytes,
    negativeControl: 'one in-memory Set of the same identities: heap out of memory' };
});

dbA.close();
dbB.close();
rmSync(dir, { recursive: true, force: true });
console.log(JSON.stringify({ measurements }, null, 1));
console.log(`COMPACT_UNIQUE_ADDRESSES: PASS (${passed} scenarios, ${comparisons} exact comparisons; Node ${process.version}; disposable SQLite, no network)`);
