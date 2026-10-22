// Offline only. Frozen pre-change SQL is the correctness oracle, not a second implementation of the index.
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { INTELLIGENCE_SQL, DISCOVERY_RETRY_INDEX_SQL, createIntelligenceRepository, discoveryWorkDue } from '../server/compact/intelligence-store.js';
import { createCompactStore } from '../server/compact/store.js';
import { acquireWriterLock, lockPathOf } from '../server/compact/writer-lock.js';
import { migrateDiscoveryRetryIndex } from './migrate-compact-discovery-retry-index.mjs';
import { createSyntheticChain } from '../server/compact/offline.js';
import { createProvider } from '../server/compact/provider.js';
import { runCompactHour } from './run-compact-hour.mjs';
import { runDiscoveryDrain } from './drain-compact-discovery.mjs';

export const RETRY_INDEX = 'compact_token_discovery_retry_due';
export const LEGACY_RETRY = `(status='unverified' OR (status='verified_erc20_like'
  AND json_extract(candidate_json,'$.kind')='source' AND json_extract(result_json,'$.launch.status')='unknown_source'))`;
export const LEGACY_RETRY_SQL = `SELECT candidate_key,candidate_json FROM compact_token_discoveries
  WHERE ${LEGACY_RETRY} AND not_before<=? ORDER BY not_before ASC,block_number ASC,candidate_key ASC LIMIT ?`;
export const LEGACY_DUE_SQL = `SELECT 1 FROM compact_token_discoveries WHERE not_before<=?
  AND (status='pending' OR ${LEGACY_RETRY}) LIMIT 1`;

export function legacyPending(db, { now, limit }) {
  const fresh = order => db.prepare(`SELECT candidate_key,candidate_json FROM compact_token_discoveries WHERE status='pending'
    AND not_before<=? ORDER BY not_before ${order},block_number ${order},candidate_key ASC LIMIT ?`).all(BigInt(now), BigInt(limit));
  const newest = fresh('DESC'), oldest = fresh('ASC');
  const retries = db.prepare(LEGACY_RETRY_SQL).all(BigInt(now), BigInt(limit));
  const selected = new Map();
  const take = (rows, places) => {
    for (const row of rows) {
      if (places <= 0 || selected.size >= limit) return;
      if (!selected.has(row.candidate_key)) { selected.set(row.candidate_key, row); places--; }
    }
  };
  const newestPlaces = Math.ceil(limit * 3 / 4), retryPlaces = Math.ceil((limit - newestPlaces) / 2);
  take(newest, newestPlaces); take(retries, retryPlaces); take(oldest, limit - newestPlaces - retryPlaces);
  for (const rows of [oldest, retries, newest]) take(rows, limit - selected.size);
  return [...selected.values()].map(row => JSON.parse(row.candidate_json));
}

// The real queue schema, with a minimal FK parent and a checkpoint sentinel.
// Full canonical-hour/checkpoint/scheduler/snapshot integration is covered by the existing suites.
export function queueFixture(path = ':memory:', { indexed = true } = {}) {
  const db = new DatabaseSync(path);
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA foreign_keys=ON;
    CREATE TABLE compact_hours(hour_start INTEGER PRIMARY KEY);
    INSERT INTO compact_hours VALUES(0);
    CREATE TABLE compact_checkpoint(id INTEGER PRIMARY KEY, hour_start INTEGER, last_block INTEGER, last_hash TEXT);
    INSERT INTO compact_checkpoint VALUES(1,0,999,'unchanged');`);
  db.exec(INTELLIGENCE_SQL);
  // Explicit synthetic fixture setup only; normal store creation must never install this index.
  if (indexed) db.exec(DISCOVERY_RETRY_INDEX_SQL);
  return db;
}

export function queueInsert(db) {
  const insert = db.prepare(`INSERT INTO compact_token_discoveries
    (candidate_key,hour_start,block_number,address,candidate_json,result_json,status,reason,attempts,not_before)
    VALUES(?,0,?,?,?,?,?,NULL,0,?)`);
  return (key, { status = 'pending', kind = 'source', launch = 'unknown_source', notBefore = 0, block = 1,
    result = undefined, padding = '' } = {}) => {
    const candidate = { key, kind, address: '0x' + '1'.repeat(40), blockNumber: block,
      blockHash: '0x' + '2'.repeat(64), txHash: '0x' + '3'.repeat(64), timestamp: 1,
      transactionIndex: 0, readBlock: 999, ...(padding ? { padding } : {}) };
    const json = JSON.stringify(candidate);
    insert.run(key, BigInt(block), candidate.address, json,
      result === undefined ? JSON.stringify({ launch: { status: launch } }) : result === null ? null : JSON.stringify(result),
      status, BigInt(notBefore));
    return candidate;
  };
}

export function queueSql(db) {
  const sql = [];
  const traced = { prepare(query) { sql.push(query); return db.prepare(query); } };
  discoveryWorkDue(traced, 100);
  createIntelligenceRepository(traced).pending({ now: 100, limit: 16 });
  return { due: sql.find(query => query.includes('AS due')) ?? sql.find(query => query.startsWith('SELECT 1 FROM compact_token_discoveries')),
    retry: sql.find(query => query.startsWith('SELECT candidate_key,candidate_json') && query.includes("status='unverified'")) };
}

export function queryPlan(db, sql, ...args) {
  return db.prepare('EXPLAIN QUERY PLAN ' + sql).all(...args).map(row => row.detail);
}

async function main() {
  globalThis.fetch = async () => { throw Error('external_network_forbidden'); };
  let passed = 0;
  const test = async (name, fn) => { await fn(); passed++; console.log('PASS ' + name); };
  const same = db => {
    const repo = createIntelligenceRepository(db);
    for (const now of [0, 1, 98, 99, 100, 101, 100000, Number.MAX_SAFE_INTEGER]) {
      assert.equal(discoveryWorkDue(db, now), Boolean(db.prepare(LEGACY_DUE_SQL).get(BigInt(now))));
      for (let limit = 1; limit <= 16; limit++) assert.deepEqual(repo.pending({ now, limit }), legacyPending(db, { now, limit }));
    }
  };
  const hasIndex = db => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='index' AND name=?").get(RETRY_INDEX));
  const dir = mkdtempSync(join(tmpdir(), 'compact-retry-maintenance-'));
  const path = join(dir, 'full-store.sqlite');
  const open = () => new DatabaseSync(path);
  const state = db => Object.fromEntries(db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all()
    .map(({ name }) => [name, db.prepare(`SELECT * FROM "${name}" ORDER BY 1`).all()]));
  const cli = args => spawnSync(process.execPath, [fileURLToPath(new URL('./migrate-compact-discovery-retry-index.mjs', import.meta.url)), ...args], {
    encoding: 'utf8', env: { ...process.env, COMPACT_SQLITE_PATH: path, COMPACT_DISCOVERY_RETRY_INDEX_ENABLED: 'true' },
  });
  try {
    await test('new real store and repeated writer open never create the maintenance index', () => {
      assert(!INTELLIGENCE_SQL.includes(RETRY_INDEX));
      let db = open(); createCompactStore(db); assert.equal(hasIndex(db), false); db.close();
      db = open(); const before = state(db); createCompactStore(db); createCompactStore(db);
      assert.equal(hasIndex(db), false); assert.deepEqual(state(db), before); db.close();
    });
    await test('ordinary catch_up, stored-hour replay and discovery drain cannot migrate a real store', async () => {
      const base = Date.parse('2026-10-09T09:00:00Z') / 1000, origin = 23_000_000;
      const chain = createSyntheticChain({ originNumber: origin, originTimestamp: base, blockSpacing: 3600000,
        poolCreatedAt: origin - 1, factoryDeployedAt: origin - 1, head: origin + 100,
        txPerBlock: 1, usdcPerBlock: 1, v4PerBlock: 1 });
      const provider = createProvider({ fetchImpl: chain.fetchImpl, minIntervalMs: 0, cooldownMs: 0, sleep: async () => {} });
      for (const hourStart of [base, base, base + 3600]) {
        const summary = await runCompactHour({ sqlitePath: path, hourStart, provider, registryFromBlock: origin - 1,
          safeHeadMargin: 0, print: () => {} });
        assert.equal(summary.ok, true, summary.reason);
        const db = open(); assert.equal(hasIndex(db), false); db.close();
      }
      const db = open(), checkpoint = db.prepare('SELECT * FROM compact_checkpoint').all(); db.close();
      const result = await runDiscoveryDrain({ sqlitePath: path, provider, print: () => {} });
      assert.equal(result.status, 'available');
      const after = open(); assert.equal(hasIndex(after), false);
      assert.deepEqual(after.prepare('SELECT * FROM compact_checkpoint').all(), checkpoint); after.close();
    });
    await test('missing approval and default/invalid CLI invocations leave database and lock untouched', () => {
      const before = readFileSync(path);
      for (const approval of [undefined, false, 'true', 1]) assert.throws(() => migrateDiscoveryRetryIndex({ sqlitePath: path, maintenanceApproved: approval }), /maintenance_approval_required/);
      const ordinary = cli([]); assert.equal(ordinary.status, 0); assert.match(ordinary.stdout, /not_applied/);
      for (const args of [['--apply'], ['--sqlite-path', path], ['--apply-approved-maintenance']]) assert.notEqual(cli(args).status, 0);
      assert.deepEqual(readFileSync(path), before); assert.equal(existsSync(lockPathOf(path)), false);
    });
    await test('approved migration refuses a live writer without opening or changing the database', () => {
      const before = readFileSync(path), lock = acquireWriterLock(path, { owner: 'disposable-maintenance-blocker' });
      try {
        assert.throws(() => migrateDiscoveryRetryIndex({ sqlitePath: path, maintenanceApproved: true }), error => error.code === 'writer_lock_held');
        const result = cli(['--apply-approved-maintenance', '--sqlite-path', path]);
        assert.notEqual(result.status, 0); assert.match(result.stderr, /writer_lock_held/);
        assert.deepEqual(readFileSync(path), before); assert.equal(existsSync(lock.path), true);
      } finally { lock.release(); }
    });
    await test('approved maintenance alone installs the index; repeat invocation is idempotent and preserves all rows', () => {
      let db = open(); const before = state(db); same(db); db.close();
      const result = cli(['--apply-approved-maintenance', '--sqlite-path', path]);
      assert.equal(result.status, 0, result.stderr); assert.match(result.stdout, / applied/);
      assert.deepEqual(migrateDiscoveryRetryIndex({ sqlitePath: path, maintenanceApproved: true }), { status: 'already_present' });
      db = open(); assert.equal(hasIndex(db), true); assert.deepEqual(state(db), before); same(db);
      const sql = queueSql(db); assert(queryPlan(db, sql.retry, 100n, 16n).some(row => row.includes(RETRY_INDEX)));
      assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
      assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []); db.close();
      assert.equal(existsSync(lockPathOf(path)), false);
    });
    await test('normal writer preserves an installed index; approved removal is not undone by restart/reopen/drain', async () => {
      let db = open(); createCompactStore(db); assert.equal(hasIndex(db), true); db.close();
      const lock = acquireWriterLock(path, { owner: 'disposable-index-rollback' });
      try { db = open(); db.exec('BEGIN IMMEDIATE'); db.exec('DROP INDEX ' + RETRY_INDEX); db.exec('COMMIT'); db.close(); }
      finally { lock.release(); }
      db = open(); const before = state(db); createCompactStore(db); assert.equal(hasIndex(db), false); same(db); db.close();
      const result = await runDiscoveryDrain({ sqlitePath: path, provider: { request: async () => { throw Error('offline_rpc_failure'); } }, print: () => {} });
      assert.equal(result.status, 'available');
      db = open(); assert.equal(hasIndex(db), false);
      assert.deepEqual(db.prepare('SELECT * FROM compact_checkpoint').all(), before.compact_checkpoint);
      db.close(); // Drain may advance retry cooldown on its fixture candidates, never checkpoint or index.
    });
    await test('migration rejects nonexistent files, non-WAL/schema files and incompatible existing index; releases locks', () => {
      const missing = join(dir, 'never-created.sqlite');
      assert.throws(() => migrateDiscoveryRetryIndex({ sqlitePath: missing, maintenanceApproved: true }));
      assert.equal(existsSync(missing), false); assert.equal(existsSync(lockPathOf(missing)), false);
      const bad = join(dir, 'incompatible.sqlite'); let db = new DatabaseSync(bad); db.close();
      assert.throws(() => migrateDiscoveryRetryIndex({ sqlitePath: bad, maintenanceApproved: true }), /existing_wal_database_required/);
      db = new DatabaseSync(bad); db.exec("PRAGMA journal_mode=WAL; CREATE TABLE compact_meta(key TEXT PRIMARY KEY,value TEXT); INSERT INTO compact_meta VALUES('schema_version','1');"); db.close();
      assert.throws(() => migrateDiscoveryRetryIndex({ sqlitePath: bad, maintenanceApproved: true }), /schema_version_mismatch/);
      assert.equal(existsSync(lockPathOf(bad)), false);
      db = open(); db.exec(`CREATE INDEX ${RETRY_INDEX} ON compact_token_discoveries(candidate_key)`); const before = state(db); db.close();
      assert.throws(() => migrateDiscoveryRetryIndex({ sqlitePath: path, maintenanceApproved: true }), /retry_index_definition_mismatch/);
      db = open(); assert.deepEqual(state(db), before); assert.equal(db.isTransaction, false);
      db.exec('DROP INDEX ' + RETRY_INDEX); db.close(); assert.equal(existsSync(lockPathOf(path)), false);
    });
  } finally { rmSync(dir, { recursive: true, force: true }); }

  await test('all statuses, JSON null/missing fields, retry boundaries, ties and limits 1..16 match old ordered results', () => {
    const db = queueFixture(), put = queueInsert(db);
    for (let i = 0; i < 640; i++) put('candidate-' + i.toString().padStart(4, '0'), {
      status: ['pending', 'unverified', 'verified_erc20_like', 'rejected_not_erc20_like'][i % 4],
      kind: ['source', 'creation', 'pool', null][Math.floor(i / 4) % 4],
      launch: ['unknown_source', 'verified_factory', null][Math.floor(i / 16) % 3],
      notBefore: [0, 99, 100, 101, 100000][Math.floor(i / 48) % 5], block: i % 11,
      result: i % 17 === 0 ? null : i % 19 === 0 ? {} : undefined,
    });
    same(db); db.close();
  });
  await test('empty queues and absent additive tables keep the same boolean meaning and time validation', () => {
    const db = new DatabaseSync(':memory:');
    assert.equal(discoveryWorkDue(db, 0), false);
    for (const now of [-1, NaN, 1.5, Number.MAX_SAFE_INTEGER + 1]) assert.throws(() => discoveryWorkDue(db, now), /invalid_discovery_time/);
    db.close(); const empty = queueFixture(); same(empty); empty.close();
  });
  await test('single queues and unused-place borrowing preserve exact candidate order without duplicates', () => {
    for (const statuses of [['pending'], ['unverified'], ['verified_erc20_like'], ['pending', 'unverified']]) {
      const db = queueFixture(), put = queueInsert(db);
      for (let i = 0; i < 48; i++) put('borrow-' + i, { status: statuses[i % statuses.length], block: i });
      same(db); db.close();
    }
  });
  await test('full pass reserves twelve newest, two retry and two oldest places; terminal/future rows excluded', () => {
    const db = queueFixture(), put = queueInsert(db);
    for (let i = 0; i < 48; i++) {
      put('p-' + i, { block: i }); put('r-' + i, { status: 'unverified', block: i });
      put('future-' + i, { status: 'unverified', notBefore: 101 });
      put('terminal-' + i, { status: 'verified_erc20_like', launch: 'verified_factory' });
    }
    const keys = createIntelligenceRepository(db).pending({ now: 100, limit: 16 }).map(row => row.key);
    assert.deepEqual(keys, [...Array.from({ length: 12 }, (_, i) => 'p-' + (47 - i)), 'r-0', 'r-1', 'p-0', 'p-1']);
    assert.equal(new Set(keys).size, 16); db.close();
  });
  await test('partial index is actually used for retry and due; resolved JSON scan and retry sort disappear', () => {
    const db = queueFixture(), put = queueInsert(db);
    for (let i = 0; i < 1000; i++) put('resolved-' + i, { status: 'verified_erc20_like', launch: 'verified_factory' });
    for (let i = 0; i < 32; i++) put('retry-' + i, { status: 'unverified', notBefore: i });
    const sql = queueSql(db);
    const retry = queryPlan(db, sql.retry, 100n, 16n), due = queryPlan(db, sql.due, 100n);
    assert(retry.some(row => row.includes('USING INDEX ' + RETRY_INDEX)));
    assert(due.some(row => row.includes('USING INDEX ' + RETRY_INDEX)));
    assert(!retry.some(row => /TEMP B-TREE|MULTI-INDEX/.test(row)));
    console.log(JSON.stringify({ retryPlan: retry, duePlan: due })); db.close();
  });
  await test('same-name wrong partial index reproduces no query solution; both readers use original SQL safely', () => {
    const db = queueFixture(':memory:', { indexed: false }), put = queueInsert(db);
    put('retry', { status: 'unverified', block: 1 });
    put('unknown', { status: 'verified_erc20_like', block: 2 }); put('pending', { block: 3 });
    db.exec(`CREATE INDEX ${RETRY_INDEX} ON compact_token_discoveries(not_before,block_number,candidate_key) WHERE status='pending'`);
    const forced = LEGACY_RETRY_SQL.replace('FROM compact_token_discoveries', `FROM compact_token_discoveries INDEXED BY ${RETRY_INDEX}`);
    assert.throws(() => db.prepare(forced).all(100n, 16n), /no query solution/);
    const before = db.prepare('SELECT sql FROM sqlite_master WHERE name=?').get(RETRY_INDEX).sql;
    db.exec('PRAGMA query_only=ON');
    same(db);
    const sql = queueSql(db), compact = value => value.replace(/\s+/g, ' ').trim();
    assert.equal(compact(sql.due), compact(LEGACY_DUE_SQL));
    assert.equal(compact(sql.retry), compact(LEGACY_RETRY_SQL));
    assert.deepEqual(createIntelligenceRepository(db).pending({ now: 100, limit: 16 }).map(row => row.key), ['pending', 'retry', 'unknown']);
    assert.equal(db.prepare('SELECT sql FROM sqlite_master WHERE name=?').get(RETRY_INDEX).sql, before);
    assert.equal(db.prepare('SELECT last_hash FROM compact_checkpoint').get().last_hash, 'unchanged'); db.close();
  });
  await test('wrong columns, collation, partial predicate and quoted values never enable the optimized path', () => {
    const variants = [
      DISCOVERY_RETRY_INDEX_SQL.replace('(not_before,block_number,candidate_key)', '(block_number,not_before,candidate_key)'),
      DISCOVERY_RETRY_INDEX_SQL.replace('candidate_key)', 'candidate_key COLLATE NOCASE)'),
      DISCOVERY_RETRY_INDEX_SQL.replace(/WHERE[\s\S]*$/, "WHERE status='unverified';"),
      DISCOVERY_RETRY_INDEX_SQL.replace(';', ' AND not_before>0;'),
      DISCOVERY_RETRY_INDEX_SQL.replace("='source'", "='IF NOT EXISTS source'"),
      DISCOVERY_RETRY_INDEX_SQL.replace("='unknown_source'", "='unknown_  source'"),
      DISCOVERY_RETRY_INDEX_SQL.replace("='unknown_source'", "='UNKNOWN_SOURCE'"),
      DISCOVERY_RETRY_INDEX_SQL.replace("'$.kind'", "'$.kind '"),
    ];
    for (const ddl of variants) {
      const db = queueFixture(':memory:', { indexed: false }), put = queueInsert(db);
      for (let i = 0; i < 40; i++) put('candidate-' + i, { status: ['pending', 'unverified', 'verified_erc20_like', 'rejected_not_erc20_like'][i % 4],
        notBefore: [0, 99, 100, 101][Math.floor(i / 4) % 4], block: i % 5 });
      db.exec(ddl); same(db);
      const sql = queueSql(db); assert(!sql.due.includes('INDEXED BY')); assert(!sql.retry.includes('INDEXED BY'));
      db.close();
    }
  });
  await test('correct DDL with harmless outer whitespace still uses the partial index without a retry sort', () => {
    const db = queueFixture(':memory:', { indexed: false }); queueInsert(db)('retry', { status: 'unverified' });
    db.exec(DISCOVERY_RETRY_INDEX_SQL.replace(/\n  /g, '\n\t\t'));
    const sql = queueSql(db); assert(sql.retry.includes('INDEXED BY ' + RETRY_INDEX));
    const plan = queryPlan(db, sql.retry, 100n, 16n);
    assert(plan.some(row => row.includes('USING INDEX ' + RETRY_INDEX)));
    assert(!plan.some(row => /TEMP B-TREE|MULTI-INDEX/.test(row))); same(db); db.close();
  });
  await test('old files work before migration; index install, repeat install and drop work on the same connection', () => {
    const db = queueFixture(':memory:', { indexed: false }), put = queueInsert(db);
    put('unknown', { status: 'verified_erc20_like' }); put('new'); put('retry', { status: 'unverified' });
    same(db); db.exec(DISCOVERY_RETRY_INDEX_SQL); same(db);
    db.exec(DISCOVERY_RETRY_INDEX_SQL); same(db);
    db.exec('DROP INDEX ' + RETRY_INDEX); same(db); db.close();
  });
  await test('absent index uses exactly the original due/retry SQL and query plans', () => {
    const db = queueFixture(':memory:', { indexed: false }); queueInsert(db)('retry', { status: 'unverified' });
    const sql = queueSql(db), compact = value => value.replace(/\s+/g, ' ').trim();
    assert.equal(compact(sql.due), compact(LEGACY_DUE_SQL));
    assert.equal(compact(sql.retry), compact(LEGACY_RETRY_SQL));
    assert.deepEqual(queryPlan(db, sql.due, 100n), queryPlan(db, LEGACY_DUE_SQL, 100n));
    assert.deepEqual(queryPlan(db, sql.retry, 100n, 16n), queryPlan(db, LEGACY_RETRY_SQL, 100n, 16n));
    db.close();
  });
  await test('failed/rolled-back additive migration leaves all rows and checkpoint intact', () => {
    const db = queueFixture(':memory:', { indexed: false }); queueInsert(db)('retry', { status: 'unverified' });
    const before = db.prepare('SELECT * FROM compact_token_discoveries').all();
    const checkpoint = db.prepare('SELECT * FROM compact_checkpoint').all();
    db.exec('BEGIN IMMEDIATE'); db.exec(DISCOVERY_RETRY_INDEX_SQL); db.exec('ROLLBACK');
    assert.equal(db.prepare('SELECT 1 FROM sqlite_master WHERE name=?').get(RETRY_INDEX), undefined);
    assert.deepEqual(db.prepare('SELECT * FROM compact_token_discoveries').all(), before);
    assert.deepEqual(db.prepare('SELECT * FROM compact_checkpoint').all(), checkpoint);
    same(db); db.close();
  });
  await test('verification transitions update partial membership and preserve one-hour cooldown and terminal finality', () => {
    const db = queueFixture(), put = queueInsert(db), repo = createIntelligenceRepository(db);
    const c = put('new'), cp = db.prepare('SELECT * FROM compact_checkpoint').all();
    const record = (status, launch, now) => repo.recordVerification({ ...c, status, reason: null, launch: { status: launch } }, { now });
    record('unverified', 'unknown_source', 100);
    assert.equal(discoveryWorkDue(db, 3600099), false); assert.equal(discoveryWorkDue(db, 3600100), true);
    same(db); record('verified_erc20_like', 'unknown_source', 3600100); same(db);
    assert.equal(discoveryWorkDue(db, 7200100), true);
    record('verified_erc20_like', 'verified_factory', 7200100);
    assert.equal(discoveryWorkDue(db, Number.MAX_SAFE_INTEGER), false);
    assert.equal(db.prepare(`SELECT count(*) n FROM compact_token_discoveries INDEXED BY ${RETRY_INDEX} WHERE ${LEGACY_RETRY}`).get().n, 0);
    const terminal = put('negative');
    repo.recordVerification({ ...terminal, status: 'rejected_not_erc20_like', reason: 'negative' }, { now: 100 });
    repo.recordVerification({ ...terminal, status: 'verified_erc20_like', launch: { status: 'unknown_source' } }, { now: 200 });
    assert.equal(db.prepare("SELECT status FROM compact_token_discoveries WHERE candidate_key='negative'").get().status, 'rejected_not_erc20_like');
    assert.deepEqual(db.prepare('SELECT * FROM compact_checkpoint').all(), cp);
    assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []); db.close();
  });
  await test('read-only connection sees external migration/rollback and never writes schema, checkpoint or candidates', () => {
    const dir = mkdtempSync(join(tmpdir(), 'compact-retry-index-')), path = join(dir, 'fixture.sqlite');
    const writer = queueFixture(path, { indexed: false }); queueInsert(writer)('retry', { status: 'unverified' });
    const reader = new DatabaseSync(path, { readOnly: true });
    try {
      reader.exec('PRAGMA query_only=ON'); const changes = reader.prepare('SELECT total_changes() n').get().n;
      same(reader); writer.exec(DISCOVERY_RETRY_INDEX_SQL); same(reader);
      assert(queueSql(reader).retry.includes('INDEXED BY ' + RETRY_INDEX));
      writer.exec('DROP INDEX ' + RETRY_INDEX);
      writer.exec(`CREATE INDEX ${RETRY_INDEX} ON compact_token_discoveries(not_before) WHERE status='pending'`);
      same(reader); assert(!queueSql(reader).retry.includes('INDEXED BY'));
      writer.exec('DROP INDEX ' + RETRY_INDEX); writer.exec(DISCOVERY_RETRY_INDEX_SQL);
      same(reader); assert(queueSql(reader).retry.includes('INDEXED BY ' + RETRY_INDEX));
      writer.exec('DROP INDEX ' + RETRY_INDEX); same(reader);
      assert.equal(reader.prepare('SELECT total_changes() n').get().n, changes);
      assert.equal(reader.prepare('SELECT last_hash FROM compact_checkpoint').get().last_hash, 'unchanged');
    } finally { reader.close(); writer.close(); rmSync(dir, { recursive: true, force: true }); }
  });
  console.log(`Discovery retry index: ${passed}/${passed} PASS (offline SQLite).`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
