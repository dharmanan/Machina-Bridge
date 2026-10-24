// Offline-only diagnostics regression. Disposable SQLite, deterministic RPC, no production or network.
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, existsSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { runCompactHour, createCompactIoDiagnostics } from './run-compact-hour.mjs';
import { createSyntheticChain } from '../server/compact/offline.js';
import { createProvider } from '../server/compact/provider.js';
import { acquireWriterLock, lockPathOf } from '../server/compact/writer-lock.js';

const root = new URL('../', import.meta.url), baselineUrl = new URL('scripts/run-compact-hour.mjs', root);
const code = execFileSync('git', ['show', '8d4500910a74b3ba57c739ad52057e3b59ae097b:scripts/run-compact-hour.mjs'], { cwd: root, encoding: 'utf8' })
  .replace(/from (['"])(\.\.?\/[^'"]+)\1/g, (_all, quote, relative) => `from ${quote}${new URL(relative, baselineUrl).href}${quote}`);
const baseline = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);
const HOUR = 1790006400, directory = mkdtempSync(join(tmpdir(), 'compact-io-diagnostics-'));
const stages = ['sqlite_open_store_preflight', 'registry_prepare', 'process_hour', 'commit_hour', 'token_metadata', 'tvl', 'discovery', 'pending_valuations', 'final_status_close'];
const prefix = 'COMPACT_IO_DIAGNOSTIC ';
const parsed = lines => lines.filter(l => l.startsWith(prefix)).map(l => JSON.parse(l.slice(prefix.length)));
const enabled = { MACHINA_COMPACT_IO_DIAGNOSTICS: '1' };
let passed = 0, external = 0;
globalThis.fetch = async () => { external++; throw Error('network_forbidden'); };
const test = async (name, run) => { await run(); passed++; console.log(`PASS ${name}`); };
function diagnostic(lines, over = {}) {
  let time = 0, reads = 0;
  return createCompactIoDiagnostics({ env: enabled, print: l => lines.push(l), pid: 123, utc: () => '2026-10-24T00:00:00.000Z', clock: () => time += 10,
    read: path => path === '/proc/self/cgroup' ? '0::/\n' : path.endsWith('memory.stat') ? 'anon 100\nfile 200\n' : `rchar: ${9007199254740993n + BigInt(++reads) * 4096n}\nread_bytes: ${BigInt(reads) * 8192n}\n`, ...over });
}
function provider(seed) {
  const chain = createSyntheticChain({ originNumber: 100000, originTimestamp: HOUR - 3600, blockSpacing: 36000000, head: 100010,
    txPerBlock: -3, usdcPerBlock: 0, v4PerBlock: 0, poolCreatedAt: 100005, ...(seed === undefined ? {} : { seed }) });
  return createProvider({ fetchImpl: chain.fetchImpl, minIntervalMs: 0, cooldownMs: 0, sleep: async () => {} });
}
function clean(summary) {
  const { elapsedMs, sqlitePath, ...stable } = summary;
  return stable;
}
function logs(lines) {
  return lines.filter(l => !l.startsWith(prefix)).map(l => {
    if (l.startsWith('STORAGE_PREFLIGHT ')) { const value = JSON.parse(l.slice(18)); value.freeBytes = 0; return 'STORAGE_PREFLIGHT ' + JSON.stringify(value); }
    if (l.startsWith('EVIDENCE_ARCHIVE ')) { const value = JSON.parse(l.slice(17)); value.started = 0; return 'EVIDENCE_ARCHIVE ' + JSON.stringify(value); }
    return l.startsWith('COMPACT_RUN_SUMMARY ') ? `COMPACT_RUN_SUMMARY ${JSON.stringify(clean(JSON.parse(l.slice(20))))}`
    : /^(SQLITE_PATH|ELAPSED_MS|MEMORY) /.test(l) ? l.split(' ')[0] : l; });
}
async function run(name, { engine = runCompactHour, diag, seed, hourStart = HOUR, rpc = provider(seed) } = {}) {
  const lines = [], path = join(directory, name);
  const summary = await engine({ sqlitePath: path, hourStart, provider: rpc, registryFromBlock: 99999, safeHeadMargin: 0, print: l => lines.push(l),
    ...(diag ? { ioDiagnostics: diag(lines) } : {}) });
  return { summary, lines, path };
}
function invariant(path) {
  const db = new DatabaseSync(path, { readOnly: true });
  try { return JSON.stringify({ checkpoint: db.prepare('SELECT * FROM compact_checkpoint').all(), hours: db.prepare('SELECT * FROM compact_hours').all(), families: db.prepare('SELECT * FROM compact_family_hours').all() }); }
  finally { db.close(); }
}
function assertPairs(events, expected) {
  assert.deepEqual(events.filter(e => e.event === 'enter').map(e => e.stage), expected);
  assert.equal(events.length, expected.length * 2);
  for (let i = 0; i < events.length; i += 2) {
    assert.equal(events[i].event, 'enter'); assert.equal(events[i + 1].event, 'exit'); assert.equal(events[i].stage, events[i + 1].stage);
  }
}
const priorFlag = process.env.MACHINA_COMPACT_IO_DIAGNOSTICS;
delete process.env.MACHINA_COMPACT_IO_DIAGNOSTICS;
try {
  await test('only exact opt-in 1 enables diagnostics; disabled path performs no reads, clocks or logging', () => {
    for (const flag of [undefined, '', '0', 'false', 'true', '01', '1 ']) {
      let calls = 0;
      const diag = createCompactIoDiagnostics({ env: { MACHINA_COMPACT_IO_DIAGNOSTICS: flag }, read: () => { calls++; throw Error('must not read'); }, clock: () => { calls++; throw Error('must not clock'); }, print: () => { calls++; throw Error('must not print'); } });
      diag.start('stage'); diag.end(); assert.equal(calls, 0);
    }
  });
  await test('off is equivalent to baseline: summary, original log format, canonical database and provider calls', async () => {
    const old = await run('baseline.sqlite', { engine: baseline.runCompactHour }), current = await run('off.sqlite');
    assert.equal(current.summary.ok, true); assert.deepEqual(clean(current.summary), clean(old.summary)); assert.deepEqual(logs(current.lines), logs(old.lines));
    assert.equal(parsed(current.lines).length, 0); assert.equal(invariant(current.path), invariant(old.path)); assert.equal(existsSync(lockPathOf(current.path)), false);
  });
  await test('on pairs all nine stages, with UTC/PID/duration, exact large counters and cgroup boundary values', async () => {
    const current = await run('on.sqlite', { diag: lines => diagnostic(lines) }), off = await run('on-comparison.sqlite');
    assert.equal(current.summary.ok, true); assert.deepEqual(clean(current.summary), clean(off.summary)); assert.deepEqual(logs(current.lines), logs(off.lines));
    const events = parsed(current.lines); assertPairs(events, stages);
    for (const e of events) { assert.equal(e.pid, 123); assert.match(e.utc, /Z$/); assert.deepEqual(e.cgroup, { anon: '100', file: '200' }); }
    for (const e of events.filter(e => e.event === 'exit')) { assert.equal(e.elapsed_ms, 10); assert.deepEqual(e.delta, { read_bytes: '8192', rchar: '4096' }); assert.equal(e.outcome, 'ok'); }
    assert.equal(invariant(current.path), invariant(off.path)); assert.equal(existsSync(lockPathOf(current.path)), false);
    if (process.env.COMPACT_IO_DIAGNOSTIC_SAMPLE) writeFileSync(process.env.COMPACT_IO_DIAGNOSTIC_SAMPLE, current.lines.filter(l => l.startsWith(prefix)).join('\n') + '\n');
  });
  await test('environment opt-in emits real local process counters without extra RPC or DB changes', async () => {
    process.env.MACHINA_COMPACT_IO_DIAGNOSTICS = '1';
    let current; try { current = await run('environment-on.sqlite'); } finally { delete process.env.MACHINA_COMPACT_IO_DIAGNOSTICS; }
    const off = await run('environment-off-comparison.sqlite');
    assert.deepEqual(clean(current.summary), clean(off.summary)); assert.deepEqual(logs(current.lines), logs(off.lines)); assert.equal(invariant(current.path), invariant(off.path));
    assert.equal(current.summary.ok, true); const events = parsed(current.lines); assertPairs(events, stages);
    for (const e of events) { assert.equal(e.pid, process.pid); assert.ok(Number.isFinite(Date.parse(e.utc))); }
    if (process.env.COMPACT_IO_LOCAL_SAMPLE) writeFileSync(process.env.COMPACT_IO_LOCAL_SAMPLE, current.lines.filter(l => l.startsWith(prefix)).join('\n') + '\n');
  });
  await test('stored/replay path emits only executed stages, keeps checkpoint and never reports a fictitious commit', async () => {
    await run('stored.sqlite'); const before = invariant(join(directory, 'stored.sqlite'));
    const current = await run('stored.sqlite', { diag: lines => diagnostic(lines) });
    assert.equal(current.summary.hourMode, 'stored'); assertPairs(parsed(current.lines), ['sqlite_open_store_preflight', 'registry_prepare', 'discovery', 'pending_valuations', 'final_status_close']);
    assert.equal(invariant(current.path), before);
  });
  await test('missing and malformed proc/cgroup files stay null; no zero-success or exception contents leak', async () => {
    for (const read of [() => { throw Error('SECRET'); }, () => 'malformed SECRET']) {
      const lines = [], current = await run('missing-' + passed + '-' + Math.random() + '.sqlite', { diag: () => diagnostic(lines, { read }) });
      assert.equal(current.summary.ok, true); const events = parsed(lines); assertPairs(events, stages);
      for (const e of events) { assert.deepEqual(e.counters, { read_bytes: null, rchar: null }); assert.deepEqual(e.cgroup, { anon: null, file: null }); }
      for (const e of events.filter(e => e.event === 'exit')) assert.deepEqual(e.delta, { read_bytes: null, rchar: null });
      assert.equal(lines.join('').includes('SECRET'), false);
    }
  });
  await test('counter reset, partial data and unmapped cgroup do not manufacture deltas or use host fallback', () => {
    let n = 0; const lines = [], paths = [];
    const diag = diagnostic(lines, { read: path => { paths.push(path); if (path === '/proc/self/cgroup') return '0::/../../host\n'; return `rchar: ${++n === 1 ? 100 : 5}\nread_bytes: invalid\n`; } });
    diag.start('stage'); diag.end(); const events = parsed(lines); assert.deepEqual(events[1].delta, { read_bytes: null, rchar: null });
    assert.deepEqual(events[1].cgroup, { anon: null, file: null }); assert.equal(paths.some(p => p.includes('memory.stat')), false);
  });
  await test('clock and diagnostic logger exceptions cannot change indexing or commit result', async () => {
    for (const sink of [lines => diagnostic(lines, { clock: () => { throw Error('SECRET'); } }), lines => diagnostic(lines, { print: () => { throw Error('SECRET'); } }),
      () => ({ start() { throw Error('SECRET'); }, end() { throw Error('SECRET'); } })]) {
      const current = await run('sink-' + Math.random() + '.sqlite', { diag: sink }); assert.equal(current.summary.ok, true); assert.equal(existsSync(lockPathOf(current.path)), false);
    }
  });
  await test('registry/RPC failure ends its stage with error and closes the connection and writer lock', async () => {
    const rpc = { ...provider(), request: async () => { throw Error('synthetic_rpc_failure'); } };
    let closes = 0; const close = DatabaseSync.prototype.close;
    DatabaseSync.prototype.close = function () { closes++; return close.call(this); };
    let current;
    try { current = await run('rpc-error.sqlite', { rpc, diag: lines => diagnostic(lines) }); } finally { DatabaseSync.prototype.close = close; }
    assert.equal(current.summary.ok, false); assert.equal(closes, 1); assert.equal(existsSync(lockPathOf(current.path)), false);
    const events = parsed(current.lines); assertPairs(events, ['sqlite_open_store_preflight', 'registry_prepare', 'final_status_close']); assert.equal(events[3].outcome, 'error');
  });
  await test('processHour failure is attributed before commit, and resources/checkpoint remain safe', async () => {
    const original = provider(), batch = original.batch;
    const rpc = { ...original, batch: async (...args) => { if (args[0].some(([method, params]) => method === 'eth_getBlockByNumber' && params[1] === true)) throw Error('synthetic_body_failure'); return batch(...args); } };
    const current = await run('body-error.sqlite', { rpc, diag: lines => diagnostic(lines) });
    assert.equal(current.summary.ok, false); assert.equal(current.summary.hourOutcome, null); assert.equal(existsSync(lockPathOf(current.path)), false);
    const events = parsed(current.lines); assertPairs(events, ['sqlite_open_store_preflight', 'registry_prepare', 'process_hour', 'final_status_close']); assert.equal(events[5].outcome, 'error');
  });
  await test('commit failure rolls back, reports the commit stage error, and closes resources', async () => {
    const prepare = DatabaseSync.prototype.prepare;
    DatabaseSync.prototype.prepare = function (sql) {
      const stmt = prepare.call(this, sql);
      if (!/^INSERT INTO compact_hours/.test(sql)) return stmt;
      return new Proxy(stmt, { get(target, name) { if (name === 'run') return () => { throw Error('synthetic_commit_failure'); }; const value = Reflect.get(target, name); return typeof value === 'function' ? value.bind(target) : value; } });
    };
    let current; try { current = await run('commit-error.sqlite', { diag: lines => diagnostic(lines) }); } finally { DatabaseSync.prototype.prepare = prepare; }
    assert.equal(current.summary.ok, false); assert.equal(existsSync(lockPathOf(current.path)), false);
    const events = parsed(current.lines); assertPairs(events, stages.slice(0, 4).concat('final_status_close')); assert.equal(events[7].outcome, 'error');
    const db = new DatabaseSync(current.path, { readOnly: true }); try { assert.equal(db.prepare('SELECT COUNT(*) n FROM compact_hours').get().n, 0); } finally { db.close(); }
  });
  await test('canonical discontinuity fails closed and preserves the previous checkpoint', async () => {
    const first = await run('canonical.sqlite'), before = invariant(first.path);
    const bad = await run('canonical.sqlite', { seed: 123, hourStart: HOUR + 3600, diag: lines => diagnostic(lines) });
    assert.equal(bad.summary.ok, false); assert.equal(bad.summary.reason, 'checkpoint_discontinuity'); assert.equal(invariant(first.path), before); assert.equal(existsSync(lockPathOf(first.path)), false);
  });
  await test('one-writer refusal never opens SQLite, does not release another owner lock and sends no RPC', async () => {
    const path = join(directory, 'held.sqlite'), holder = acquireWriterLock(path, { owner: 'test-holder' });
    try { const current = await run('held.sqlite', { diag: lines => diagnostic(lines) }); assert.equal(current.summary.reason, 'writer_lock_held'); assert.equal(current.summary.provider.requests, 0); assert.equal(existsSync(lockPathOf(path)), true); assertPairs(parsed(current.lines), ['final_status_close']); }
    finally { holder.release(); }
  });
  assert.equal(external, 0);
  console.log(`${passed}/${passed} compact I/O diagnostic groups PASS; offline only, zero external calls.`);
} finally {
  if (priorFlag === undefined) delete process.env.MACHINA_COMPACT_IO_DIAGNOSTICS; else process.env.MACHINA_COMPACT_IO_DIAGNOSTICS = priorFlag;
  rmSync(directory, { recursive: true, force: true });
}
