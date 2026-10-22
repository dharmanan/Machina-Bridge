// Development benchmark: creates a NEW disposable directory and synthetic database only.
// Never accepts an existing database, production path, RPC URL or credentials. Node 24 + Python stdlib for read counters.
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir, release, arch, cpus } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { DISCOVERY_RETRY_INDEX_SQL, createIntelligenceRepository, discoveryWorkDue } from '../server/compact/intelligence-store.js';
import { queueFixture, queueInsert, queueSql, queryPlan, legacyPending, LEGACY_DUE_SQL, LEGACY_RETRY_SQL, RETRY_INDEX } from './verify-compact-discovery-retry-index.mjs';

globalThis.fetch = async () => { throw Error('external_network_forbidden'); };
const bytes = path => existsSync(path) ? statSync(path).size : 0;
const io = () => Object.fromEntries(readFileSync('/proc/self/io', 'utf8').trim().split('\n').map(line => {
  const [key, value] = line.split(':'); return [key, Number(value.trim())];
}));
const delta = (a, b) => Object.fromEntries(Object.keys(a).map(key => [key, b[key] - a[key]]));
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const dataHash = db => {
  const digest = createHash('sha256');
  for (const row of db.prepare('SELECT * FROM compact_token_discoveries ORDER BY candidate_key').iterate()) digest.update(JSON.stringify(row) + '\n');
  digest.update(JSON.stringify(db.prepare('SELECT * FROM compact_checkpoint').all()));
  return digest.digest('hex');
};
const stats = db => db.prepare('SELECT name,COUNT(*) pages,SUM(pgsize) bytes,SUM(payload) payloadBytes,SUM(unused) unusedBytes FROM dbstat GROUP BY name').all();
const elapsed = start => performance.now() - start;

function child(mode, path, rows) {
  if (mode === 'create' || mode === 'create-dense') {
    const dense = mode === 'create-dense';
    const db = queueFixture(path, { indexed: false }), put = queueInsert(db), start = performance.now();
    const padding = 'x'.repeat(2300);
    // Match source candidate key shape/length, including launch-evidence version (not short benchmark IDs).
    const keyOf = n => `source:0x${'1'.repeat(40)}:0x${n.toString(16).padStart(64, '0')}:fixture-v1`;
    for (let i = 0; i < rows; i++) {
      if (i % 2000 === 0) db.exec('BEGIN IMMEDIATE');
      put(keyOf(i), { status: dense ? 'unverified' : 'verified_erc20_like',
        launch: 'verified_factory', notBefore: dense ? 1 + i % 100 : 0, block: i, padding });
      if (i % 2000 === 1999 || i === rows - 1) db.exec('COMMIT');
    }
    db.exec('BEGIN IMMEDIATE');
    for (let i = 0; i < 8192; i++) put(keyOf(rows + i), {
      status: i % 2 ? 'unverified' : 'verified_erc20_like', notBefore: i < 4096 ? 1 : 10000, block: rows + i, padding });
    for (let i = 0; i < 128; i++) put(keyOf(rows + 8192 + i), { notBefore: 1, block: rows + 8192 + i, padding });
    db.exec('COMMIT'); db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    const result = { creationMs: elapsed(start), rows: rows + 8192 + 128,
      terminalRows: dense ? 0 : rows, retryRows: dense ? rows + 8192 : 8192,
      pendingRows: 128, candidateKeyBytes: Buffer.byteLength(keyOf(0)), dbBytes: bytes(path), objects: stats(db),
      dataHash: dataHash(db), integrity: db.prepare('PRAGMA integrity_check').get().integrity_check,
      foreignKeyErrors: db.prepare('PRAGMA foreign_key_check').all().length };
    db.close(); return result;
  }
  const db = new DatabaseSync(path);
  db.exec('PRAGMA synchronous=NORMAL; PRAGMA temp_store=FILE; PRAGMA cache_size=-2000; PRAGMA mmap_size=0;');
  if (mode === 'build') {
    // Observe WAL before closing the writer. Retain normal automatic checkpoint behavior.
    const before = { rssBytes: process.memoryUsage().rss, io: io(), dbBytes: bytes(path), walBytes: bytes(path + '-wal') };
    const start = performance.now();
    db.exec('BEGIN IMMEDIATE'); db.exec(DISCOVERY_RETRY_INDEX_SQL); db.exec('COMMIT');
    const result = { buildMs: elapsed(start), before,
      after: { rssBytes: process.memoryUsage().rss, peakRssBytes: process.resourceUsage().maxRSS * 1024,
        io: io(), dbBytes: bytes(path), walBytes: bytes(path + '-wal') },
      pageCount: db.prepare('PRAGMA page_count').get().page_count,
      pageSize: db.prepare('PRAGMA page_size').get().page_size,
      index: stats(db).find(row => row.name === RETRY_INDEX) };
    result.ioDelta = delta(before.io, result.after.io);
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    result.afterExplicitSyntheticCheckpoint = { dbBytes: bytes(path), walBytes: bytes(path + '-wal') };
    // Exclude integrity/hash scans from the measured DDL interval and DDL I/O.
    result.dataHash = dataHash(db); result.integrity = db.prepare('PRAGMA integrity_check').get().integrity_check;
    result.foreignKeyErrors = db.prepare('PRAGMA foreign_key_check').all().length;
    db.close(); return result;
  }
  const indexed = mode === 'new', queries = indexed ? queueSql(db) : { retry: LEGACY_RETRY_SQL, due: LEGACY_DUE_SQL };
  const repo = createIntelligenceRepository(db);
  const cases = {
    retryDue: () => db.prepare(queries.retry).all(100n, 16n),
    pendingDue: () => indexed ? repo.pending({ now: 100, limit: 16 }) : legacyPending(db, { now: 100, limit: 16 }),
    dueEmpty: () => indexed ? discoveryWorkDue(db, 0) : Boolean(db.prepare(LEGACY_DUE_SQL).get(0n)),
    duePresent: () => indexed ? discoveryWorkDue(db, 100) : Boolean(db.prepare(LEGACY_DUE_SQL).get(100n)),
  };
  const result = { version: db.prepare('SELECT sqlite_version() version').get().version,
    pragmas: Object.fromEntries(['cache_size', 'mmap_size', 'temp_store', 'journal_mode', 'wal_autocheckpoint'].map(key => [key, db.prepare('PRAGMA ' + key).get()[key]])),
    plans: { retry: queryPlan(db, queries.retry, 100n, 16n), due: queryPlan(db, queries.due, 0n) }, cases: {} };
  for (const [name, run] of Object.entries(cases)) {
    const firstIo = io(), firstStart = performance.now(), value = run(), firstMs = elapsed(firstStart), firstIoDelta = delta(firstIo, io());
    const samples = [], beforeIo = io();
    for (let i = 0; i < 9; i++) { const start = performance.now(); assert.equal(hash(run()), hash(value)); samples.push(elapsed(start)); }
    samples.sort((a, b) => a - b);
    result.cases[name] = { firstMs, firstIoDelta, medianMs: samples[4], p95Ms: samples[8],
      nineRunIoDelta: delta(beforeIo, io()), resultRows: Array.isArray(value) ? value.length : null, resultHash: hash(value) };
  }
  // Separate, untimed read-only Python instrumentation: node:sqlite UDF callbacks retain V8 handles
  // during a long sqlite3_step, so instrumenting hundreds of thousands of JSONs in JS distorts memory.
  // Count field evaluations, not physical pages/all B-tree visits. Require identical EXPLAIN plans.
  const instrument = spawnSync('python', ['-c', `
import json, sqlite3, sys
data=json.load(sys.stdin)
db=sqlite3.connect('file:'+data['path']+'?mode=ro',uri=True)
counts={'candidateFieldEvaluations':0,'resultFieldEvaluations':0}
def extract(value,path):
 key='candidateFieldEvaluations' if path=='$.kind' else 'resultFieldEvaluations'
 counts[key]+=1
 obj=json.loads(value) if value is not None else {}
 return obj.get('kind') if path=='$.kind' else obj.get('launch',{}).get('status')
db.create_function('json_extract',2,extract,deterministic=True)
out={'sqliteVersion':sqlite3.sqlite_version,'note':'Separate Python SQLite instrumentation; same plans required; field evaluations are not physical reads.'}
for name,args in [('retryDue',[100,16]),('dueEmpty',[0]),('duePresent',[100])]:
 sql=data['retry'] if name=='retryDue' else data['due']
 plan=[row[3] for row in db.execute('EXPLAIN QUERY PLAN '+sql,args)]
 assert plan==data['plans']['retry' if name=='retryDue' else 'due'],(name,plan)
 counts.update(candidateFieldEvaluations=0,resultFieldEvaluations=0)
 rows=db.execute(sql,args).fetchall()
 out[name]={**counts,'resultRows':len(rows),'returnedCandidatePayloads':len(rows) if name=='retryDue' else 0}
print(json.dumps(out))
`], { input: JSON.stringify({ path, ...queries, plans: result.plans }), encoding: 'utf8', maxBuffer: 1024 * 1024 });
  assert.equal(instrument.status, 0, instrument.stderr);
  result.jsonReadInstrumentation = JSON.parse(instrument.stdout);
  db.close(); return result;
}

async function runChild(mode, path, rows, directory) {
  const proc = spawn(process.execPath, ['--max-old-space-size=64', '--max-semi-space-size=2',
    fileURLToPath(import.meta.url), '--child', mode, path, String(rows)], { env: { ...process.env, TMPDIR: directory }, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  const sampled = { peakRssBytes: 0, peakWalBytes: 0, peakDeletedTemporaryBytes: 0, samples: 0 };
  const poll = () => {
    try {
      const status = readFileSync(`/proc/${proc.pid}/status`, 'utf8');
      sampled.peakRssBytes = Math.max(sampled.peakRssBytes, Number(status.match(/^VmRSS:\s+(\d+)/m)?.[1] ?? 0) * 1024);
      sampled.peakWalBytes = Math.max(sampled.peakWalBytes, bytes(path + '-wal'));
      let temporaryBytes = 0;
      for (const fd of readdirSync(`/proc/${proc.pid}/fd`)) {
        try {
          const file = `/proc/${proc.pid}/fd/${fd}`, target = readlinkSync(file), stat = statSync(file);
          if (target.endsWith(' (deleted)') && stat.isFile()) temporaryBytes += stat.size;
        } catch { /* fd may close between observations */ }
      }
      sampled.peakDeletedTemporaryBytes = Math.max(sampled.peakDeletedTemporaryBytes, temporaryBytes); sampled.samples++;
    } catch { /* process may have exited */ }
  };
  const interval = setInterval(poll, 10);
  proc.stdout.on('data', chunk => { stdout += chunk; }); proc.stderr.on('data', chunk => { stderr += chunk; });
  return new Promise((resolveResult, reject) => {
    proc.on('error', error => { clearInterval(interval); reject(error); });
    proc.on('close', code => {
      clearInterval(interval);
      if (code !== 0) { reject(Error(`${mode}: ${code}: ${stderr}`)); return; }
      try { resolveResult({ ...JSON.parse(stdout), sampled }); } catch (error) { reject(error); }
    });
  });
}

if (process.argv[2] === '--child') {
  console.log(JSON.stringify(child(process.argv[3], process.argv[4], Number(process.argv[5]))));
} else {
  const args = process.argv.slice(2);
  assert(args.length <= 2, 'usage: node scripts/benchmark-compact-discovery-retry.mjs [output-root] [terminal-rows]');
  const rows = Number(args[1] ?? 300000); assert(Number.isSafeInteger(rows) && rows >= 10000 && rows <= 1000000);
  const directory = mkdtempSync(join(resolve(args[0] ?? tmpdir()), 'discovery-retry-bench-')), path = join(directory, 'synthetic.sqlite');
  const result = { directory, node: process.version, platform: `${process.platform}/${arch()} ${release()}`, cpu: cpus()[0]?.model,
    notice: 'Synthetic data only; OS cache not evicted, fresh process is not a cold-disk test. /proc I/O is process I/O, not Railway metrics.' };
  result.fixture = await runChild('create', path, rows, directory);
  result.old = await runChild('old', path, rows, directory);
  result.build = await runChild('build', path, rows, directory);
  result.new = await runChild('new', path, rows, directory);
  assert.equal(result.fixture.dataHash, result.build.dataHash, 'index build changed row/checkpoint contents');
  for (const name of Object.keys(result.old.cases)) assert.equal(result.old.cases[name].resultHash, result.new.cases[name].resultHash, name);
  assert.equal(result.fixture.integrity, 'ok'); assert.equal(result.build.integrity, 'ok');
  assert.equal(result.build.foreignKeyErrors, 0);
  // A second, smaller fixture stresses a broad retry backlog and external sorting/WAL costs.
  // It is not used to claim query speedup or a production-size upper bound.
  const densePath = join(directory, 'dense-synthetic.sqlite');
  result.dense = { fixture: await runChild('create-dense', densePath, Math.min(rows, 100000), directory) };
  result.dense.build = await runChild('build', densePath, rows, directory);
  assert.equal(result.dense.fixture.dataHash, result.dense.build.dataHash);
  assert.equal(result.dense.build.integrity, 'ok'); assert.equal(result.dense.build.foreignKeyErrors, 0);
  writeFileSync(join(directory, 'results.json'), JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify(result, null, 2));
}
