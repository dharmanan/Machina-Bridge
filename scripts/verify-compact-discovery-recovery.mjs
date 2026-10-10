// Node 24, generated chains + disposable SQLite only. All external fetches forbidden.
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { createCompactStore } from '../server/compact/store.js';
import { createProvider, ProviderError, providerDiagnostics } from '../server/compact/provider.js';
import { createSyntheticChain, SYNTHETIC_CONTRACTS } from '../server/compact/offline.js';
import { normalizeLog } from '../api/_lib/arc-intelligence/normalize.js';
import { poolRecordOf } from '../server/compact/registry.js';
import { processBlockRange } from '../server/compact/hour.js';
import { verifyTokenCandidate, intelligenceJson } from '../server/compact/intelligence.js';
import { createHash } from 'node:crypto';
import { selectorOf } from '../server/compact/abi.js';
import { headerOf } from '../server/compact/spine.js';
import { LOG_STREAMS } from '../server/compact/sources.js';
import { intelligenceRegistry, INTELLIGENCE_REGISTRY, registryDigest } from '../server/compact/intelligence-registry.js';
import { planDiscoveryRecovery, recoverDiscoveryHour, recoverEvidenceUnit, recoveryHourPlan, MAX_RECOVERY_ATTEMPTS, RECOVERY_RETRY_MS, DISCOVERY_PUBLIC_START, V3_RETRY_POLICY, RECOVERY_BLOCK_BATCH_SIZE } from '../server/compact/discovery-recovery.js';
import { recoveryConfig, runDiscoveryRecovery, boundedRecoveryProvider, RECOVERY_BUDGET } from './recover-compact-discovery.mjs';
import { createCompactReadModel } from '../server/compact/read-model.js';
import { createIntelligenceServer } from '../server/compact/http.js';
import { createDiscoveryRecoveryPlanner } from '../server/compact/discovery-recovery-planner.js';
import { createScheduler, hourIso, createChildDiscoveryRecoveryRunner } from '../server/compact/scheduler.js';
import { serviceConfig } from './serve-compact-intelligence.mjs';
import { acquireWriterLock } from '../server/compact/writer-lock.js';

const realFetch = globalThis.fetch;
globalThis.fetch = async () => { throw new Error('external_network_forbidden'); };
const BASE = Date.parse('2026-10-09T09:00:00Z') / 1000;
const ORIGIN = 23_000_000;
const noLaunch = intelligenceRegistry({ launches: [] });
const addr = n => `0x${n.toString(16).padStart(40, '0')}`;
const launch = (id, n) => ({ id, chainId: 5042, address: addr(n), version: 'test-v1', source: 'generated_fixture',
  verificationBasis: 'disposable_test_only', validFromBlock: 0, classification: 'verified_factory', codeAssumption: 'present_at_window_end',
  events: [{ declaration: 'event Created(address indexed token)', tokenField: 'token' }] });
const registry = intelligenceRegistry({ launches: [launch('one', 800)] });
let passed = 0;
async function test(name, fn) {
  if (process.env.RECOVERY_TEST_FILTER && !name.includes(process.env.RECOVERY_TEST_FILTER)) return;
  await fn(); passed++; console.log(`PASS ${name}`);
}
async function fixture({ initialRegistry = noLaunch, missing = false, path = ':memory:', count = 1, blocksPerHour = 10,
  poolCreatedAt = ORIGIN, txPerBlock = 2, v3Every = 300,
  streams = LOG_STREAMS.filter(s => ['v3Factory', 'v3Pools', 'v4'].includes(s.key)) } = {}) {
  const db = new DatabaseSync(path), store = createCompactStore(db);
  const chain = createSyntheticChain({ originNumber: ORIGIN, originTimestamp: BASE, blockSpacing: 36_000_000 / blocksPerHour,
    poolCreatedAt, factoryDeployedAt: Math.min(ORIGIN - 1, poolCreatedAt), protocols: false, txPerBlock, v3Every, v4PerBlock: 1, usdcPerBlock: 1 });
  const provider = createProvider({ fetchImpl: chain.fetchImpl, sleep: async () => {}, minIntervalMs: 0, maxAttempts: 1 });
  // An empty verified factory registry covers all earlier blocks; the hour discovers its own PoolCreated.
  store.extendRegistry({ kind: 'uniswap_v3_pool', fromBlock: 0, through: ORIGIN - 1, throughHash: chain.blockHash(ORIGIN - 1), previousThrough: null,
    created: poolCreatedAt < ORIGIN ? chain.logsOf(poolCreatedAt).map(normalizeLog).map(poolRecordOf).filter(Boolean) : [] });
  const results = [];
  for (let i = 0; i < count; i++) {
    const first = ORIGIN + i * blocksPerHour, last = first + blocksPerHour - 1;
    const result = await processBlockRange({ provider, first, last, before: headerOf(chain.rawBlock(first - 1, false), first - 1),
      after: headerOf(chain.rawBlock(last + 1, false), last + 1), hourStart: BASE + i * 3600, hourEnd: BASE + (i + 1) * 3600,
      intelligenceRegistry: initialRegistry, v3Registry: store.v3Registry(), streams });
    if (missing) delete result.intelligence;
    store.commitHour(result); results.push(result);
  }
  return { db, store, chain, provider, results };
}
function immutable(db) {
  const allowed = new Set(['compact_intelligence_hours', 'compact_token_discoveries', 'compact_token_dex_observations', 'compact_meta']);
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'compact_%' ORDER BY name").all().map(r => r.name);
  return Object.fromEntries(tables.filter(t => !allowed.has(t)).map(t => [t, db.prepare(`SELECT * FROM ${t} ORDER BY 1,2`).all()])
    .concat([['meta', db.prepare("SELECT * FROM compact_meta WHERE key NOT LIKE 'discovery_unit:%' AND key NOT LIKE 'discovery_retry:%' AND key NOT LIKE 'discovery_registry:%' AND key NOT LIKE 'discovery_unit_warning:%' ORDER BY key").all()]]));
}
function immutableDigest(db) {
  // Stream large registry fixtures rather than allocating copies of 100,000 rows under the 64 MiB test heap.
  const excluded = new Set(['compact_intelligence_hours','compact_token_discoveries','compact_token_dex_observations']);
  const digest = createHash('sha256');
  for (const {name} of db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'compact_%' ORDER BY name").all()) {
    if (excluded.has(name)) continue;
    digest.update(name);
    const where=name==='compact_meta'?" WHERE key NOT LIKE 'discovery_unit:%' AND key NOT LIKE 'discovery_retry:%' AND key NOT LIKE 'discovery_registry:%' AND key NOT LIKE 'discovery_unit_warning:%'":'';
    for (const row of db.prepare(`SELECT * FROM ${name}${where} ORDER BY 1,2`).iterate()) digest.update(intelligenceJson(row)+'\n');
  }
  return digest.digest('hex');
}
function allState(db) {
  return Object.fromEntries(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'compact_%'").all()
    .map(r => [r.name, db.prepare(`SELECT * FROM ${r.name} ORDER BY 1,2`).all()]));
}
const payload = (unit, status = 'available', reason = null) => ({ status, reason,
  evidence: { candidates: [], firstDex: [], ...(unit.kind === 'launch' ? { entry: { kind: 'launch', id: unit.entry.id, version: unit.entry.version,
    source: unit.entry.source, verificationBasis: unit.entry.verificationBasis, address: unit.entry.address, status, reason, counts: {}, rawFlows: {} } } : {}) } });
const fakeRecover = async ({ unit }) => payload(unit);

// Stream one JSON-RPC envelope at a time, as a real HTTP body. Padding models
// transaction input/other full-block fields without allocating the entire response.
function bodyFixture(f, { paddingBytes = 0, mutate = () => {} } = {}) {
  const batches = [], encoder = new TextEncoder(), padding = 'x'.repeat(paddingBytes);
  let requests = 0, maxResponseBytes = 0;
  return { batches, get requests() { return requests; }, get maxResponseBytes() { return maxResponseBytes; }, fetchImpl: async (url, options) => {
    requests++;
    const call = JSON.parse(options.body), items = Array.isArray(call) ? call : [call];
    if (items.some(i => i.method === 'eth_getBlockByNumber' && i.params[1] === true)) batches.push(items.length);
    const response = JSON.parse(await (await f.chain.fetchImpl(url, options)).text());
    const replies = Array.isArray(response) ? response : [response];
    replies.forEach((reply, i) => {
      if (items[i].method === 'eth_getBlockByNumber' && items[i].params[1] === true) reply.result.fixturePadding = padding;
      // Deliberately reverse log responses; proof grouping must preserve normalized order.
      if (items[i].method === 'eth_getLogs') reply.result.reverse();
      mutate(reply, items[i]);
    });
    let index = 0, responseBytes = 0;
    return new Response(new ReadableStream({ pull(controller) {
      if (index === replies.length) { controller.close(); return; }
      const i = index++;
      const bytes = encoder.encode((Array.isArray(response) && i === 0 ? '[' : '')
        + JSON.stringify(replies[i]) + (Array.isArray(response) ? i === replies.length - 1 ? ']' : ',' : ''));
      responseBytes += bytes.byteLength; maxResponseBytes = Math.max(maxResponseBytes, responseBytes);
      controller.enqueue(bytes);
    } }));
  } };
}

await test('bounded block batches reproduce legacy 50-body HTTP 200 response-budget failure', async () => {
  const f = await fixture({ blocksPerHour: 96, txPerBlock: 6 });
  const http = bodyFixture(f, { paddingBytes: 170_000 });
  const bounded = boundedRecoveryProvider({ fetchImpl: http.fetchImpl, sleep: async () => {} });
  try {
    await bounded.provider.batch([ORIGIN - 1, ORIGIN, ORIGIN + 95, ORIGIN + 96].map(n => ['eth_getBlockByNumber', [`0x${n.toString(16)}`, false]]));
    await assert.rejects(bounded.provider.batch(Array.from({ length: 50 }, (_, i) => ['eth_getBlockByNumber', [`0x${(ORIGIN + i).toString(16)}`, true]])), e => {
      const d = providerDiagnostics(e);
      assert.equal(e.code, 'recovery_response_budget_exhausted'); assert.equal(d.category, 'response_budget');
      assert.equal(d.httpStatus, 200); assert.equal(d.batchSize, 50);
      return true;
    });
    assert.equal(bounded.stats.requests, 3); assert.equal(bounded.stats.calls, 55);
    const count = http.requests;
    await assert.rejects(bounded.provider.request('eth_getCode', []), e => e.code === 'recovery_response_budget_exhausted');
    assert.equal(http.requests, count);
  } finally { bounded.close(); f.db.close(); }
});
await test('bounded block batches recover dense creations V3 and V4 with identical evidence', async () => {
  const options = { missing: true, blocksPerHour: 96, txPerBlock: 6, v3Every: 1 };
  const baseline = await fixture({ ...options, missing: false }), f = await fixture(options);
  const before = immutableDigest(f.db), http = bodyFixture(f, { paddingBytes: 170_000 });
  const bounded = boundedRecoveryProvider({ fetchImpl: http.fetchImpl, sleep: async () => {} });
  try {
    assert.equal((await recoverDiscoveryHour({ db: baseline.db, hourStart: BASE, registry: noLaunch, provider: baseline.provider })).phase, 'recovered');
    assert.equal((await recoverDiscoveryHour({ db: f.db, hourStart: BASE, registry: noLaunch, provider: bounded.provider, checkBudget: bounded.check })).phase, 'recovered');
    const units = db => db.prepare("SELECT key,value FROM compact_meta WHERE key LIKE 'discovery_unit:%' ORDER BY key").all();
    assert.deepEqual(units(f.db), units(baseline.db));
    assert(http.batches.length >= 9); assert(http.batches.every(n => n <= RECOVERY_BLOCK_BATCH_SIZE));
    assert(bounded.stats.bytes > 30 * 1024 * 1024 && bounded.stats.bytes < RECOVERY_BUDGET.bytes);
    assert(http.maxResponseBytes < RECOVERY_BUDGET.responseBytes);
    assert.equal(immutableDigest(f.db), before);
    const count = http.requests;
    assert.equal((await recoverDiscoveryHour({ db: f.db, hourStart: BASE, registry: noLaunch, provider: bounded.provider })).rpcNeeded, false);
    assert.equal(http.requests, count);
    assert(process.memoryUsage().heapUsed < 64 * 1024 * 1024);
    console.log(`MEASURE dense-hour requests=${bounded.stats.requests} calls=${bounded.stats.calls} bytes=${bounded.stats.bytes} maxResponseBytes=${http.maxResponseBytes} heapUsed=${process.memoryUsage().heapUsed}`);
  } finally { bounded.close(); baseline.db.close(); f.db.close(); }
});
await test('bounded block batches stop oversized single-block evidence and retain successful units', async () => {
  const f = await fixture({ missing: true, blocksPerHour: 96, txPerBlock: 6, v3Every: 1 });
  const before = immutableDigest(f.db);
  let inV4 = false, oversized = false;
  const http = bodyFixture(f, { mutate(reply, item) {
    if (item.method === 'eth_getLogs' && item.params[0].address?.includes(LOG_STREAMS.find(s => s.key === 'v4').address[0])) inV4 = true;
    if (inV4 && !oversized && item.method === 'eth_getBlockByNumber' && item.params[1] === true) {
      oversized = true; reply.result.fixturePadding = 'x'.repeat(RECOVERY_BUDGET.responseBytes + 1);
    }
  } });
  const bounded = boundedRecoveryProvider({ fetchImpl: http.fetchImpl, sleep: async () => {} });
  try {
    const result = await recoverDiscoveryHour({ db: f.db, hourStart: BASE, registry: noLaunch, provider: bounded.provider, checkBudget: bounded.check });
    assert.equal(result.phase, 'incomplete'); assert.match(result.reason, /recovery_response_budget_exhausted/);
    assert.equal(f.db.prepare("SELECT COUNT(*) n FROM compact_meta WHERE key LIKE 'discovery_unit:%'").get().n, 2);
    assert.equal(immutableDigest(f.db), before);
    const count = http.requests;
    await assert.rejects(bounded.provider.request('eth_getCode', []), e => e.code === 'recovery_response_budget_exhausted');
    assert.equal(http.requests, count);
  } finally { bounded.close(); f.db.close(); }
});
await test('bounded block batches reject transaction mismatch beyond the first proof group atomically', async () => {
  const f = await fixture({ missing: true, blocksPerHour: 96, txPerBlock: 6, v3Every: 1 });
  const before = immutableDigest(f.db);
  const http = bodyFixture(f, { mutate(reply, item) {
    if (item.method === 'eth_getLogs') for (const log of reply.result) {
      if (Number(BigInt(log.blockNumber)) >= ORIGIN + 64) log.transactionHash = '0x' + 'f'.repeat(64);
    }
  } });
  const bounded = boundedRecoveryProvider({ fetchImpl: http.fetchImpl, sleep: async () => {} });
  try {
    const result = await recoverDiscoveryHour({ db: f.db, hourStart: BASE, registry: noLaunch, provider: bounded.provider, checkBudget: bounded.check });
    assert.equal(result.phase, 'incomplete'); assert.match(result.reason, /log_transaction_mismatch/);
    assert.equal(f.db.prepare("SELECT COUNT(*) n FROM compact_meta WHERE key LIKE 'discovery_unit:%'").get().n, 1);
    assert.equal(immutableDigest(f.db), before);
  } finally { bounded.close(); f.db.close(); }
});
await test('bounded block batches preserve creations parent continuity across spine windows', async () => {
  const f = await fixture({ blocksPerHour: 96, txPerBlock: 6 });
  const before = allState(f.db);
  const http = bodyFixture(f, { mutate(reply, item) {
    if (item.method === 'eth_getBlockByNumber' && item.params[1] === true && Number(BigInt(item.params[0])) === ORIGIN + 32) {
      reply.result.parentHash = '0x' + 'f'.repeat(64);
    }
  } });
  const bounded = boundedRecoveryProvider({ fetchImpl: http.fetchImpl, sleep: async () => {} });
  try {
    await assert.rejects(recoverEvidenceUnit({ db: f.db, provider: bounded.provider,
      c: { h: f.db.prepare('SELECT * FROM compact_hours WHERE hour_start=?').get(BASE) }, unit: { kind: 'creations' }, registry: noLaunch }),
    e => e.code === 'parent_hash_mismatch');
    assert.deepEqual(http.batches, [32, 32]); assert.equal(http.requests, 4);
    assert.deepEqual(allState(f.db), before);
  } finally { bounded.close(); f.db.close(); }
});
await test('bounded block batches fit maximum creations hour under unchanged request and time budgets', async () => {
  const f = await fixture({ blocksPerHour: 15_000, txPerBlock: 1, streams: [] });
  const before = immutableDigest(f.db), http = bodyFixture(f);
  let clock = 0;
  const bounded = boundedRecoveryProvider({ fetchImpl: http.fetchImpl, now: () => clock, sleep: async ms => { clock += ms; } });
  try {
    const result = await recoverEvidenceUnit({ db: f.db, provider: bounded.provider,
      c: { h: f.db.prepare('SELECT * FROM compact_hours WHERE hour_start=?').get(BASE) }, unit: { kind: 'creations' }, registry: noLaunch });
    assert.equal(result.status, 'available'); assert.equal(http.batches.length, 469);
    assert.equal(bounded.stats.requests, 472); assert.equal(bounded.stats.calls, 15009);
    assert(clock < RECOVERY_BUDGET.timeoutMs); bounded.check();
    assert.equal(immutableDigest(f.db), before);
    assert(process.memoryUsage().heapUsed < 64 * 1024 * 1024);
    console.log(`MEASURE max-creations-hour requests=${bounded.stats.requests} calls=${bounded.stats.calls} bytes=${bounded.stats.bytes} pacedMs=${clock} heapUsed=${process.memoryUsage().heapUsed}`);
  } finally { bounded.close(); f.db.close(); }
});

if (process.env.RECOVERY_CRASH_CHILD || process.env.RECOVERY_POLICY_CRASH_CHILD) {
  const path = process.env.RECOVERY_CRASH_CHILD ?? process.env.RECOVERY_POLICY_CRASH_CHILD;
  const db = new DatabaseSync(path);
  acquireWriterLock(path, { owner: 'disposable-crash-test' });
  await recoverDiscoveryHour({ db, hourStart: BASE, registry: noLaunch, recoverUnit: async args => {
    if (args.unit.kind === 'uniswap_v3') { process.send('unit-one-durable-unit-two-leased'); await new Promise(() => {}); }
    return fakeRecover(args);
  } });
  process.exit(2);
}

await test('runner configuration is dry-run by default, one exact hour, safe pacing and memory ownership', () => {
  const env = { COMPACT_SQLITE_PATH: '/tmp/disposable.sqlite' };
  assert.equal(recoveryConfig({ argv: [], env }).execute, false);
  assert.throws(() => recoveryConfig({ argv: ['--execute'], env }));
  for (const argv of [['--all'], ['--execute', hourIso(BASE), hourIso(BASE + 3600)], ['--execute', '--execute', hourIso(BASE)]]) assert.throws(() => recoveryConfig({ argv, env }));
  assert.equal(recoveryConfig({ argv: [hourIso(BASE), '--execute'], env }).hourStart, BASE);
  assert.throws(() => recoveryConfig({ argv: [], env: { ...env, COMPACT_RPC_MIN_INTERVAL_MS: '500' } }));
  assert.equal(serviceConfig({ env }).discoveryRecoveryEnabled, false);
  assert.equal(serviceConfig({ env: { ...env, COMPACT_DISCOVERY_RECOVERY_ENABLED: 'true' } }).discoveryRecoveryEnabled, true);
  assert.throws(() => serviceConfig({ env: { ...env, COMPACT_DISCOVERY_RECOVERY_ENABLED: 'yes' } }));
  assert.throws(() => serviceConfig({ env: { ...env, COMPACT_DISCOVERY_RECOVERY_ENABLED: 'true', COMPACT_RPC_MIN_INTERVAL_MS: '500' } }));
});
await test('current complete coverage is a read-only no-op with zero repeated RPC', async () => {
  const f = await fixture(); const before = allState(f.db);
  const result = await recoverDiscoveryHour({ db: f.db, hourStart: BASE, registry: noLaunch, provider: { batch() { throw new Error('unexpected_rpc'); } } });
  assert.equal(result.phase, 'recovered'); assert.equal(result.rpcNeeded, false);
  assert.deepEqual(allState(f.db), before); f.db.close();
});
await test('old registry imports complete units and fetches only the newly required source', async () => {
  const f = await fixture();
  f.db.exec("DELETE FROM compact_meta WHERE key LIKE 'discovery_unit:%' OR key LIKE 'discovery_registry:%'"); // disposable legacy-state fixture
  const before = immutable(f.db), calls = [];
  assert.equal(recoveryHourPlan(f.db, BASE, { registry }).category, 'older_available');
  const result = await recoverDiscoveryHour({ db: f.db, hourStart: BASE, registry, recoverUnit: async args => { calls.push(args.unit.kind); return fakeRecover(args); } });
  assert.equal(result.phase, 'recovered'); assert.deepEqual(calls, ['launch']);
  assert.deepEqual(immutable(f.db), before);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM compact_intelligence_hours').get().n, 2);
  await recoverDiscoveryHour({ db: f.db, hourStart: BASE, registry, recoverUnit: () => { throw new Error('successful_work_repeated'); } });
  f.db.close();
});
await test('missing discovery rebuilds exact missing units with real compact decoders and preserves every other table', async () => {
  const f = await fixture({ missing: true }); const before = immutable(f.db);
  const result = await recoverDiscoveryHour({ db: f.db, hourStart: BASE, registry: noLaunch, provider: f.provider });
  assert.equal(result.phase, 'recovered'); assert.equal(result.completedUnits, 3); assert.deepEqual(immutable(f.db), before);
  assert.equal(f.db.prepare('SELECT discovery_status FROM compact_intelligence_hours').get().discovery_status, 'available');
  f.db.close();
});
await test('future registry expansion reuses prior units across registry digests permanently', async () => {
  const f = await fixture({ missing: true });
  await recoverDiscoveryHour({ db: f.db, hourStart: BASE, registry, recoverUnit: fakeRecover });
  const later = intelligenceRegistry({ launches: [...registry.launches, launch('two', 801)] });
  const called = [];
  const result = await recoverDiscoveryHour({ db: f.db, hourStart: BASE, registry: later, recoverUnit: async args => { called.push(args.unit.entry?.id ?? args.unit.kind); return fakeRecover(args); } });
  assert.equal(result.phase, 'recovered'); assert.deepEqual(called, ['two']);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM compact_intelligence_hours').get().n, 2); f.db.close();
});
await test('interrupted source and restart retain completed source units and never repeat base discovery', async () => {
  const f = await fixture({ missing: true }); const later = intelligenceRegistry({ launches: [...registry.launches, launch('two', 801)] });
  let failed = false;
  const first = await recoverDiscoveryHour({ db: f.db, hourStart: BASE, registry: later, now: 1000, recoverUnit: async args => {
    if (args.unit.entry?.id === 'two') { failed = true; throw new ProviderError('transport'); } return fakeRecover(args);
  } });
  assert(failed); assert.equal(first.phase, 'incomplete');
  assert.equal(recoveryHourPlan(f.db, BASE, { registry: later, now: 1001 }).phase, 'retryable');
  const called = [];
  const retry = await recoverDiscoveryHour({ db: f.db, hourStart: BASE, registry: later, now: 1000 + RECOVERY_RETRY_MS + 1,
    recoverUnit: async args => { called.push(args.unit.entry?.id ?? args.unit.kind); return fakeRecover(args); } });
  assert.equal(retry.phase, 'recovered'); assert.deepEqual(called, ['two']); f.db.close();
});
await test('unit crash after writes rolls back that unit, retaining previously durable units', async () => {
  const f = await fixture({ missing: true }); let count = 0;
  await recoverDiscoveryHour({ db: f.db, hourStart: BASE, registry: noLaunch, now: 1000, recoverUnit: fakeRecover,
    beforeUnitCommit: () => { if (++count === 2) throw new Error('simulated_crash'); } });
  assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM compact_meta WHERE key LIKE 'discovery_unit:%'").get().n, 2);
  const called = [];
  await recoverDiscoveryHour({ db: f.db, hourStart: BASE, registry: noLaunch, now: 1000 + RECOVERY_RETRY_MS + 1,
    recoverUnit: async args => { called.push(args.unit.kind); return fakeRecover(args); } });
  assert.deepEqual(called, ['uniswap_v3']); f.db.close();
});
await test('aggregate rollback preserves all original facts and durable evidence units for zero-RPC retry', async () => {
  const f = await fixture({ missing: true }); const before = immutable(f.db);
  await assert.rejects(recoverDiscoveryHour({ db: f.db, hourStart: BASE, registry: noLaunch, recoverUnit: fakeRecover,
    beforeCommit: () => { throw new Error('aggregate_crash'); } }));
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM compact_intelligence_hours').get().n, 0);
  assert.deepEqual(immutable(f.db), before);
  const result = await recoverDiscoveryHour({ db: f.db, hourStart: BASE, registry: noLaunch, recoverUnit: () => { throw new Error('rpc_repeated'); } });
  assert.equal(result.phase, 'recovered'); assert.equal(result.rpcNeeded, false); f.db.close();
});
await test('older insufficient/unknown-version records remain intact; 33 hours are classified without guessing cause', async () => {
  const f = await fixture({ count: 33 });
  f.db.prepare("UPDATE compact_intelligence_hours SET definition_version='unknown-version'").run();
  // Deliberately inconsistent column/payload identity is detected, not guessed or promoted.
  const before = allState(f.db); const plan = planDiscoveryRecovery(f.db, { registry });
  assert.equal(plan.hours.length, 33); assert.equal(plan.counts.blocked, 33);
  assert(plan.hours.every(h => h.category === 'inconsistent'));
  assert.deepEqual(allState(f.db), before); f.db.close();
});
await test('candidate cap and permanently absent factory retain explicit incomplete evidence without recurring scans', async () => {
  const f = await fixture({ missing: true }); let calls = 0;
  const first = await recoverDiscoveryHour({ db: f.db, hourStart: BASE, registry, recoverUnit: async args => {
    calls++; return args.unit.kind === 'launch' ? { ...payload(args.unit, 'insufficient_coverage', 'candidate_limit'), permanent: true } : fakeRecover(args);
  } });
  assert.equal(first.phase, 'incomplete'); assert.match(first.reason, /candidate_limit/);
  const n = calls;
  await recoverDiscoveryHour({ db: f.db, hourStart: BASE, registry, now: Date.now() + 100 * RECOVERY_RETRY_MS, recoverUnit: async args => { calls++; return fakeRecover(args); } });
  assert.equal(calls, n); f.db.close();
});
await test('pool unavailability and historical factory failure exhaust bounded retries and remain incomplete', async () => {
  const f = await fixture({ missing: true });
  for (let i = 0; i < MAX_RECOVERY_ATTEMPTS; i++) await recoverDiscoveryHour({ db: f.db, hourStart: BASE, registry, now: i * RECOVERY_RETRY_MS + 1,
    recoverUnit: async args => ['uniswap_v4', 'launch'].includes(args.unit.kind) ? payload(args.unit, 'insufficient_coverage', 'historical_evidence_unavailable') : fakeRecover(args) });
  assert.equal(recoveryHourPlan(f.db, BASE, { registry, now: 100 * RECOVERY_RETRY_MS }).phase, 'blocked');
  assert.equal(f.db.prepare('SELECT discovery_status FROM compact_intelligence_hours').get().discovery_status, 'insufficient_coverage'); f.db.close();
});
await test('unknown deployment floor rejects earlier hours without historical scan', async () => {
  const f = await fixture(); const late = intelligenceRegistry({ launches: [{ ...launch('late', 803), validFromBlock: ORIGIN + 1 }] });
  const plan = recoveryHourPlan(f.db, BASE, { registry: late });
  assert.equal(plan.units.find(u => u.kind === 'launch').phase, 'blocked');
  assert.equal(plan.units.find(u => u.kind === 'launch').reason, 'registry_not_valid_for_entire_range');
  await assert.rejects(recoverDiscoveryHour({ db: f.db, hourStart: DISCOVERY_PUBLIC_START - 3600, registry: late })); f.db.close();
});
await test('conflicting candidate facts abort aggregate and preserve verified discoveries', async () => {
  const f = await fixture({ missing: true });
  const candidate = { key: 'same', kind: 'creation', address: null, txHash: '0x' + '1'.repeat(64), blockHash: f.chain.blockHash(ORIGIN),
    blockNumber: ORIGIN, timestamp: BASE, transactionIndex: 0, deployer: addr(99), readBlock: ORIGIN + 9 };
  await assert.rejects(recoverDiscoveryHour({ db: f.db, hourStart: BASE, registry: noLaunch, recoverUnit: async args => {
    const p = payload(args.unit); p.evidence.candidates = args.unit.kind === 'creations' ? [candidate] : args.unit.kind === 'uniswap_v3' ? [{ ...candidate, deployer: addr(98) }] : []; return p;
  } }), /recovery_candidate_conflict/);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM compact_token_discoveries').get().n, 0); f.db.close();
});
await test('actual source-only scan verifies log-bearing blocks without rescanning the full spine', async () => {
  const f = await fixture(); const requests = [];
  const provider = { batch: async items => Promise.all(items.map(([m, p]) => provider.request(m, p))),
    request: async (method, params) => {
      requests.push([method, params]);
      if (method === 'eth_getBlockByNumber') return f.chain.rawBlock(Number(BigInt(params[0])), params[1]);
      if (method === 'eth_getCode') return '0x6000';
      if (method === 'eth_getLogs') return [];
      throw new Error('unexpected method');
    } };
  const result = await recoverDiscoveryHour({ db: f.db, hourStart: BASE, registry, provider });
  assert.equal(result.phase, 'recovered');
  assert.equal(requests.filter(([m, p]) => m === 'eth_getBlockByNumber' && p[1]).length, 0);
  assert.equal(requests.filter(([m]) => m === 'eth_getLogs').length, 1);
  assert(requests.filter(([m]) => m === 'eth_getLogs').every(([, p]) => p[0].address[0] === registry.launches[0].address)); f.db.close();
});
await test('live ingestion retains versioned evidence even when another launch source fails', async () => {
  const f = await fixture({ initialRegistry: registry });
  // Generic launch factory has no synthetic code: pool/creation units are independently complete.
  const before = immutable(f.db), called = [];
  const result = await recoverDiscoveryHour({ db: f.db, hourStart: BASE, registry, recoverUnit: async args => { called.push(args.unit.kind); return fakeRecover(args); } });
  assert.equal(result.phase, 'recovered'); assert.deepEqual(called, ['launch']); assert.deepEqual(immutable(f.db), before); f.db.close();
});
await test('removing a source or changing its ABI does not repeatedly rebuild the previously completed base', async () => {
  const f = await fixture({ missing: true });
  await recoverDiscoveryHour({ db: f.db, hourStart: BASE, registry, recoverUnit: fakeRecover });
  const changed = intelligenceRegistry({ launches: [{ ...launch('one', 800), version: 'test-v2', events: [{ declaration: 'event NewCreated(address indexed token)', tokenField: 'token' }] }] });
  const called = [];
  await recoverDiscoveryHour({ db: f.db, hourStart: BASE, registry: changed, recoverUnit: async args => { called.push(args.unit.kind); return fakeRecover(args); } });
  assert.deepEqual(called, ['launch']);
  const removed = await recoverDiscoveryHour({ db: f.db, hourStart: BASE, registry: noLaunch, recoverUnit: () => { throw new Error('repeat'); } });
  assert.equal(removed.phase, 'recovered'); assert.equal(removed.rpcNeeded, false); f.db.close();
});
await test('RPC 429/timeout failures cannot erase durable units and respect finite retry quotas', async () => {
  for (const code of ['rate_limited', 'transport']) {
    const f = await fixture({ missing: true });
    let attempts = 0;
    for (let i = 0; i < MAX_RECOVERY_ATTEMPTS; i++) {
      await recoverDiscoveryHour({ db: f.db, hourStart: BASE, registry, now: i * RECOVERY_RETRY_MS + 1,
        recoverUnit: async args => { if (args.unit.kind === 'launch') { attempts++; throw new ProviderError(code); } return fakeRecover(args); } });
    }
    assert.equal(attempts, MAX_RECOVERY_ATTEMPTS);
    const plan = recoveryHourPlan(f.db, BASE, { registry, now: 100 * RECOVERY_RETRY_MS });
    assert.equal(plan.phase, 'blocked'); assert.equal(plan.units.filter(u => u.phase === 'complete').length, 3);
    assert.equal(f.db.prepare('SELECT discovery_status FROM compact_intelligence_hours').get().discovery_status, 'insufficient_coverage'); f.db.close();
  }
});
await test('physical request, call, response-byte and execution-time budgets fail closed with no unbounded retries', async () => {
  const good = async (_url, options) => {
    const body = JSON.parse(options.body);
    const answer = item => ({ jsonrpc: '2.0', id: item.id, result: '0x13b2' });
    return new Response(JSON.stringify(Array.isArray(body) ? body.map(answer) : answer(body)));
  };
  const requestBound = boundedRecoveryProvider({ fetchImpl: good, sleep: async () => {}, budget: { ...RECOVERY_BUDGET, requests: 1 } });
  await assert.rejects(requestBound.provider.request('eth_getCode', [addr(1), '0x1']));
  assert.equal(requestBound.stats.requests, 1); assert.throws(requestBound.check, /rpc_budget/); requestBound.close();
  const callBound = boundedRecoveryProvider({ fetchImpl: good, sleep: async () => {}, budget: { ...RECOVERY_BUDGET, calls: 2 } });
  await assert.rejects(callBound.provider.batch([['eth_getCode', []], ['eth_getCode', []]]));
  assert.equal(callBound.stats.calls, 1); callBound.close();
  const byteBound = boundedRecoveryProvider({ fetchImpl: good, sleep: async () => {}, budget: { ...RECOVERY_BUDGET, responseBytes: 5 } });
  await assert.rejects(byteBound.provider.request('eth_getCode', [])); assert.throws(byteBound.check, /response_budget/); byteBound.close();
  let clock = 0;
  const timeBound = boundedRecoveryProvider({ fetchImpl: good, sleep: async () => {}, now: () => clock, budget: { ...RECOVERY_BUDGET, timeoutMs: 10 } });
  clock = 11; await assert.rejects(timeBound.provider.request('eth_getCode', [])); assert.equal(timeBound.stats.requests, 0); timeBound.close();
  let requests = 0;
  const rateBound = boundedRecoveryProvider({ sleep: async () => {}, fetchImpl: async () => { requests++; return new Response('rate limited', { status: 429 }); } });
  await assert.rejects(rateBound.provider.request('eth_getCode', [])); assert.equal(requests, 1); assert.throws(rateBound.check, /rate_limited/); rateBound.close();
  const timeoutBound = boundedRecoveryProvider({ sleep: async () => {}, fetchImpl: async () => { throw new Error('fixture timeout'); } });
  await assert.rejects(timeoutBound.provider.request('eth_getCode', [])); assert.throws(timeoutBound.check, /transport/); timeoutBound.close();
});
await test('dry-run is query-only and lock contention performs zero RPC and zero database mutations', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'discovery-lock-')), path = join(dir, 'db.sqlite');
  try {
    const f = await fixture({ path }); const before = allState(f.db);
    const config = { sqlitePath: path, execute: false, hourStart: null, minIntervalMs: 1000 };
    let calls = 0;
    const dependencies = { print: () => {}, providerFactory: () => { calls++; throw new Error('no RPC'); } };
    assert.equal((await runDiscoveryRecovery(config, dependencies)).phase, 'planned');
    assert.deepEqual(allState(f.db), before);
    const lock = acquireWriterLock(path, { owner: 'test-live-indexer' });
    try { assert.equal((await runDiscoveryRecovery({ ...config, execute: true, hourStart: BASE }, dependencies)).reason, 'writer_lock_held'); }
    finally { lock.release(); }
    assert.equal(calls, 0); assert.deepEqual(allState(f.db), before); f.db.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
await test('concurrent canonical mutation aborts recovery instead of attaching stale evidence', async () => {
  const f = await fixture({ missing: true }); const before = immutable(f.db);
  await assert.rejects(recoverDiscoveryHour({ db: f.db, hourStart: BASE, registry: noLaunch, recoverUnit: async args => {
    f.db.prepare('UPDATE compact_checkpoint SET last_block=last_block+1 WHERE id=1').run(); // rogue writer simulated only in disposable DB
    return fakeRecover(args);
  } }), /canonical_state_changed/);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM compact_intelligence_hours').get().n, 0);
  assert.deepEqual(f.db.prepare('SELECT * FROM compact_hours').all(), before.compact_hours); f.db.close();
});
function schedulerFixture({ caughtUp = true, hold = false } = {}) {
  let clock = (BASE + 3600) * 1000 + 300000, cp = { hourStart: caughtUp ? BASE : BASE - 3600, lastBlock: 99, lastHash: 'hash' };
  let release;
  const starts = [], timers = [];
  const runner = kind => hour => {
    starts.push(kind);
    let done;
    if (hold) done = new Promise(resolve => { release = resolve; });
    else { if (kind === 'catch_up') cp = { ...cp, hourStart: BASE }; done = Promise.resolve({ exitCode: 0, error: null }); }
    return { hour, done, terminate: async () => { release?.({ exitCode: null, signal: 'SIGTERM' }); return done; } };
  };
  const readModel = { checkpoint: () => cp, historyBounds: () => ({ first: BASE }), dailyActiveReplayCandidate: () => BASE - 3600,
    repairCandidates: () => [BASE], projectionRepairCandidates: () => ({ hours: [BASE], blocked: [] }), discoveryPending: () => true,
    discoveryRecoveryPlan: () => ({ digest: 'test', counts: { pending: 1 }, candidate: BASE }) };
  const scheduler = createScheduler({ readModel, runHour: runner('catch_up'), runHistoryBackfill: () => runner('history')(), historyStartHour: DISCOVERY_PUBLIC_START,
    runDailyActiveReplay: runner('dau'), runProjectionRepair: runner('projection'), runDiscoveryRecovery: runner('recovery'),
    runDiscoveryDrain: () => runner('drain')(), now: () => clock, repairCooldownMs: 0, projectionRepairCooldownMs: 0,
    setTimer: (fn, ms) => { const t = { fn, ms }; timers.push(t); return t; }, clearTimer: t => { const i = timers.indexOf(t); if (i >= 0) timers.splice(i, 1); } });
  return { scheduler, starts, timers, release: () => release?.({ exitCode: 0, error: null }) };
}
await test('scheduler recovery round-robin guarantees every maintenance class progress and prioritizes live catch-up', async () => {
  const f = schedulerFixture();
  for (let i = 0; i < 12; i++) await f.scheduler.tick();
  for (const kind of ['history', 'dau', 'catch_up', 'projection', 'recovery', 'drain']) assert.equal(f.starts.filter(k => k === kind).length, 2, kind);
  await f.scheduler.stop();
  const lag = schedulerFixture({ caughtUp: false }); await lag.scheduler.tick(); assert.equal(lag.starts[0], 'catch_up'); await lag.scheduler.stop();
});
await test('overlapping scheduler ticks never overlap writers and stopping terminates the active child', async () => {
  const f = schedulerFixture({ hold: true }); const one = f.scheduler.tick(); const two = f.scheduler.tick();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.starts.length, 1); f.release(); await Promise.all([one, two]);
  const third = f.scheduler.tick(); await new Promise(resolve => setImmediate(resolve)); await f.scheduler.stop(); await third; assert.equal(f.starts.length, 2);
});
await test('recovery child always includes explicit execute and bounded heap arguments', () => {
  let args;
  const spawnImpl = (_exe, argv) => { args = argv; return { once: () => {}, kill: () => {} }; };
  createChildDiscoveryRecoveryRunner({ scriptPath: '/disposable/recovery.mjs', spawnImpl })(hourIso(BASE));
  assert(args.includes('--execute')); assert(args.includes('--max-old-space-size=64')); assert(args.includes(hourIso(BASE)));
});
await test('end-to-end official registry recovery becomes visible through existing Ecosystem HTTP API', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'discovery-e2e-')), path = join(dir, 'db.sqlite');
  let server, model;
  try {
    const f = await fixture({ path }); const original = immutable(f.db);
    const requests = [];
    const provider = { batch: async items => Promise.all(items.map(([m, p]) => provider.request(m, p))), request: async (method, params) => {
      requests.push([method, params]);
      if (method === 'eth_getBlockByNumber') return f.chain.rawBlock(Number(BigInt(params[0])), params[1]);
      if (method === 'eth_getLogs') return [];
      const source = INTELLIGENCE_REGISTRY.launches.find(s => s.address === params[0] || s.address === params[0]?.to);
      assert(source);
      if (method === 'eth_getCode') return '0x60' + source.events[0].event.topic.slice(2);
      if (method === 'eth_call') {
        const value = source.id === 'argus' ? 11n : source.id === 'tolly' ? BigInt('0x3600000000000000000000000000000000000000') : 0n;
        return '0x' + value.toString(16).padStart(64, '0');
      }
      throw new Error('unapproved RPC method');
    } };
    const outcome = await recoverDiscoveryHour({ db: f.db, hourStart: BASE, provider });
    assert.equal(outcome.phase, 'recovered'); assert.equal(outcome.completedUnits, 7);
    assert.deepEqual(immutable(f.db), original);
    const count = requests.length;
    await recoverDiscoveryHour({ db: f.db, hourStart: BASE, provider }); assert.equal(requests.length, count);
    model = createCompactReadModel({ path, DatabaseSync });
    server = createIntelligenceServer({ readModel: model });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    for (const window of ['24h', '7d', '30d']) {
      const response = await realFetch(`http://127.0.0.1:${server.address().port}/v1/intelligence/ecosystem?window=${window}`);
      assert.equal(response.status, 200);
      const data = await response.json(); assert.equal(data.coverage.availableHours, 1);
      assert.equal(data.coverage.status, window === '30d' ? 'available' : 'insufficient_coverage');
      assert.equal(data.launchSources.length, 4);
    }
    assert(f.db.prepare('SELECT registry_digest FROM compact_intelligence_hours').all().some(r => r.registry_digest === registryDigest()));
    f.db.close();
  } finally {
    if (server) await new Promise(resolve => server.close(resolve)); model?.close(); rmSync(dir, { recursive: true, force: true });
  }
});
await test('malformed persisted retry state fails closed without requests or erasing progress', async () => {
  const f = await fixture({ missing: true });
  const unit = recoveryHourPlan(f.db, BASE, { registry: noLaunch }).units[0];
  f.db.prepare('INSERT INTO compact_meta VALUES(?,?)').run(`discovery_retry:${BASE}:${unit.id}`, JSON.stringify({
    fingerprint: 'f'.repeat(64), attempts: 'NaN', reason: 'invalid', phase: 'retryable', notBefore: 1 }));
  const before = allState(f.db);
  const outcome = await recoverDiscoveryHour({ db: f.db, hourStart: BASE, registry: noLaunch, recoverUnit: () => { throw new Error('must_not_run'); } });
  assert.equal(outcome.phase, 'blocked'); assert.equal(outcome.reason, 'recovery_retry_corrupt'); assert.deepEqual(allState(f.db), before); f.db.close();
});
await test('absent historical official factories save explicit incomplete evidence and never repeatedly scan', async () => {
  const f = await fixture(), calls = [];
  const provider = { batch: async items => Promise.all(items.map(([m, p]) => provider.request(m, p))), request: async (m, p) => {
    calls.push(m);
    if (m === 'eth_getBlockByNumber') return f.chain.rawBlock(Number(BigInt(p[0])), p[1]);
    if (m === 'eth_getCode') return '0x';
    throw new Error('historically absent factory must not be scanned');
  } };
  assert.equal((await recoverDiscoveryHour({ db: f.db, hourStart: BASE, provider })).phase, 'incomplete');
  assert(!calls.includes('eth_getLogs'));
  const plan = recoveryHourPlan(f.db, BASE); assert.equal(plan.phase, 'blocked');
  assert(plan.units.filter(u => u.kind === 'launch').every(u => u.phase === 'blocked' && u.reason === 'registered_factory_unverified'));
  const count = calls.length;
  await recoverDiscoveryHour({ db: f.db, hourStart: BASE, provider, now: Date.now() + 100 * RECOVERY_RETRY_MS });
  assert.equal(calls.length, count); f.db.close();
});
await test('source events require canonical emitter, transaction, timestamp, topic and decoded address', async () => {
  for (const bad of [null, 'emitter', 'hash', 'transaction', 'timestamp', 'topic', 'data']) {
    const f = await fixture();
    const raw = f.chain.rawBlock(ORIGIN, true);
    const log = { address: registry.launches[0].address, blockNumber: `0x${ORIGIN.toString(16)}`, blockHash: raw.hash,
      transactionHash: raw.transactions[0].hash, transactionIndex: '0x0', logIndex: '0x14', removed: false,
      topics: [registry.launches[0].events[0].event.topic, '0x' + addr(123).slice(2).padStart(64, '0')], data: '0x', blockTimestamp: `0x${BASE.toString(16)}` };
    if (bad === 'emitter') log.address = addr(999);
    if (bad === 'hash') log.blockHash = '0x' + 'a'.repeat(64);
    if (bad === 'transaction') log.transactionHash = '0x' + 'b'.repeat(64);
    if (bad === 'timestamp') log.blockTimestamp = '0x1';
    if (bad === 'topic') log.topics[0] = '0x' + 'c'.repeat(64);
    if (bad === 'data') log.topics[1] = '0x1';
    let bodies = 0;
    const provider = { batch: async items => Promise.all(items.map(([m, p]) => provider.request(m, p))), request: async (m, p) => {
      if (m === 'eth_getBlockByNumber') { if (p[1]) bodies++; return f.chain.rawBlock(Number(BigInt(p[0])), p[1]); }
      if (m === 'eth_getCode') return '0x6000';
      if (m === 'eth_getLogs') return [log];
      throw new Error('unexpected method');
    } };
    const outcome = await recoverDiscoveryHour({ db: f.db, hourStart: BASE, registry, provider });
    assert.equal(outcome.phase, bad ? 'incomplete' : 'recovered', bad ?? 'valid');
    assert.equal(bodies, 1);
    const row = f.db.prepare("SELECT * FROM compact_token_discoveries WHERE address=? AND json_extract(candidate_json,'$.kind')='source'").get(addr(123));
    assert.equal(Boolean(row), !bad);
    if (row) { assert.equal(row.status, 'pending'); assert.equal(row.result_json, null); }
    f.db.close();
  }
});
await test('missing pool registry blocks only its unit and becomes eligible after independently verified coverage', async () => {
  const f = await fixture({ missing: true }); f.db.prepare("DELETE FROM compact_registry_coverage WHERE kind='uniswap_v3_pool'").run();
  const called = [];
  await recoverDiscoveryHour({ db: f.db, hourStart: BASE, registry: noLaunch, recoverUnit: async args => { called.push(args.unit.kind); return fakeRecover(args); } });
  assert.deepEqual(called, ['creations', 'uniswap_v4']);
  assert.equal(recoveryHourPlan(f.db, BASE, { registry: noLaunch }).phase, 'blocked');
  f.store.extendRegistry({ kind: 'uniswap_v3_pool', fromBlock: 0, through: ORIGIN - 1, throughHash: f.chain.blockHash(ORIGIN - 1), previousThrough: null, created: [] });
  called.length = 0;
  assert.equal((await recoverDiscoveryHour({ db: f.db, hourStart: BASE, registry: noLaunch,
    recoverUnit: async args => { called.push(args.unit.kind); return fakeRecover(args); } })).phase, 'recovered');
  assert.deepEqual(called, ['uniswap_v3']); f.db.close();
});
await test('killed process restart retains committed units, honors durable lease and safely replaces a dead writer lock', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'discovery-crash-')), path = join(dir, 'db.sqlite'); let child;
  try {
    const f = await fixture({ path, missing: true }); const before = immutable(f.db); f.db.close();
    child = fork(new URL(import.meta.url), [], { execArgv: ['--max-old-space-size=64'],
      env: { ...process.env, RECOVERY_CRASH_CHILD: path }, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('child_crash_test_timeout')), 5000);
      child.once('message', message => { clearTimeout(timer); assert.equal(message, 'unit-one-durable-unit-two-leased'); resolve(); });
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('exit', () => { clearTimeout(timer); reject(new Error('child_exited_before_lease')); });
    });
    const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited;
    const db = new DatabaseSync(path);
    assert.deepEqual(immutable(db), before);
    assert.equal(db.prepare("SELECT COUNT(*) n FROM compact_meta WHERE key LIKE 'discovery_unit:%'").get().n, 1);
    const lock = acquireWriterLock(path, { owner: 'disposable-restart' });
    try {
      const called = [];
      await recoverDiscoveryHour({ db, hourStart: BASE, registry: noLaunch, recoverUnit: async args => { called.push(args.unit.kind); return fakeRecover(args); } });
      assert.deepEqual(called, ['uniswap_v4']);
      assert.equal(recoveryHourPlan(db, BASE, { registry: noLaunch }).phase, 'retryable');
      called.length = 0;
      const result = await recoverDiscoveryHour({ db, hourStart: BASE, registry: noLaunch, now: Date.now() + RECOVERY_RETRY_MS + RECOVERY_BUDGET.timeoutMs + 1,
        recoverUnit: async args => { called.push(args.unit.kind); return fakeRecover(args); } });
      assert.equal(result.phase, 'recovered'); assert.deepEqual(called, ['uniswap_v3']); assert.deepEqual(immutable(db), before);
    } finally { lock.release(); db.close(); }
  } finally { child?.kill('SIGKILL'); rmSync(dir, { recursive: true, force: true }); }
});
await test('bounded provider permits verified log-range splitting while counting every failed request', async () => {
  let split = false;
  const bounded = boundedRecoveryProvider({ sleep: async () => {}, fetchImpl: async (_url, options) => {
    const item = JSON.parse(options.body);
    const reply = item.method === 'eth_chainId' ? { result: '0x13b2' } : !split ? (split = true, { error: { code: -32012, message: 'range too large' } }) : { result: [] };
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: item.id, ...reply }));
  } });
  try {
    await assert.rejects(bounded.provider.request('eth_getLogs', []), /range_too_large/);
    bounded.check(); assert.deepEqual(await bounded.provider.request('eth_getLogs', []), []); assert.equal(bounded.stats.requests, 3);
  } finally { bounded.close(); }
});
await test('574-hour inventory uses bounded indexed reads and exact classification totals', async () => {
  const f = await fixture({ count: 574 }); const before = immutable(f.db);
  const start = performance.now(); const plan = planDiscoveryRecovery(f.db, { registry }); const elapsed = performance.now() - start;
  assert.equal(plan.hours.length, 574); assert.equal(plan.counts.pending, 574);
  assert.equal(Object.values(plan.counts).reduce((a, b) => a + b, 0), 574);
  assert.equal(plan.candidate, BASE); assert.deepEqual(immutable(f.db), before);
  const queryPlan = f.db.prepare('EXPLAIN QUERY PLAN SELECT value FROM compact_meta WHERE key=?').all('discovery_unit:test');
  assert(queryPlan.some(row => row.detail.includes('SEARCH')));
  console.log(`MEASUREMENT 574-hour read-only recovery plan ${elapsed.toFixed(1)}ms (generated fixture)`);
  f.db.close();
});
await test('isolated read-only planner coalesces requests, terminates on deadline and never creates a database', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'discovery-planner-')), path = join(dir, 'db.sqlite');
  const f = await fixture({ path }); const before = allState(f.db);
  const planner = createDiscoveryRecoveryPlanner({ path }), timeout = createDiscoveryRecoveryPlanner({ path, timeoutMs: 1 });
  const absentPath = join(dir, 'absent.sqlite'), absent = createDiscoveryRecoveryPlanner({ path: absentPath });
  try {
    const one = planner.read(); assert.equal(planner.read(), one);
    const result = await one; assert.equal(result.counts.pending, 1); assert.equal(result.candidate, BASE);
    assert.deepEqual(allState(f.db), before);
    await assert.rejects(timeout.read(), /recovery_planner_timeout/);
    await assert.rejects(absent.read(), /recovery_planner_failed|recovery_planner_exit/);
    const { existsSync } = await import('node:fs'); assert.equal(existsSync(absentPath), false);
    await planner.close(); await assert.rejects(planner.read(), /closed/);
  } finally { await planner.close(); await timeout.close(); await absent.close(); f.db.close(); rmSync(dir, { recursive: true, force: true }); }
});
await test('planner failure cannot stop other maintenance and shutdown cannot start a late writer', async () => {
  let release, starts = 0; const cp = { hourStart: BASE, lastBlock: 1, lastHash: 'x' };
  const make = plan => createScheduler({ readModel: { checkpoint: () => cp, discoveryRecoveryPlan: plan, repairCandidates: () => [],
    historyBounds: () => ({ first: BASE }) }, runHour: () => { throw new Error('unexpected live'); }, runDiscoveryRecovery: () => { throw new Error('unexpected recovery'); },
    runHistoryBackfill: () => { starts++; return { done: Promise.resolve({ exitCode: 0 }), terminate: async () => {} }; }, historyStartHour: DISCOVERY_PUBLIC_START,
    now: () => (BASE + 3600) * 1000 + 300000, setTimer: () => 1, clearTimer: () => {} });
  const failed = make(() => Promise.reject(new Error('planner unavailable'))); await failed.tick(); await failed.stop(); assert.equal(starts, 1);
  const stopping = make(() => new Promise(resolve => { release = resolve; })); const active = stopping.tick(); const stopped = stopping.stop();
  release({ counts: {}, candidate: null }); await Promise.all([active, stopped]); assert.equal(starts, 1);
});
await test('valid older insufficient definitions remain versioned and recover only independently incomplete components', async () => {
  const f = await fixture({ initialRegistry: registry }); const oldRows = f.db.prepare('SELECT * FROM compact_intelligence_hours').all();
  const next = intelligenceRegistry({ launches: [...registry.launches, launch('two', 801)] }); const called = [];
  assert.equal(recoveryHourPlan(f.db, BASE, { registry: next }).category, 'older_insufficient_or_other_definition');
  await recoverDiscoveryHour({ db: f.db, hourStart: BASE, registry: next, recoverUnit: async args => { called.push(args.unit.entry?.id ?? args.unit.kind); return fakeRecover(args); } });
  assert.deepEqual(called, ['one', 'two']);
  for (const old of oldRows) assert.deepEqual(f.db.prepare('SELECT * FROM compact_intelligence_hours WHERE registry_digest=?').get(old.registry_digest), old);
  f.db.close();
});
await test('supplemental unit conflicts never erase old evidence or prevent independently verified live hour commits', async () => {
  const f = await fixture();
  const unit = recoveryHourPlan(f.db, BASE, { registry: noLaunch }).units[0]; const key = `discovery_unit:${BASE}:${unit.id}`;
  // Generated corrupt supplemental record, never production. Canonical and intelligence evidence remain verified.
  f.db.prepare('UPDATE compact_meta SET value=? WHERE key=?').run('{}', key);
  const before = allState(f.db);
  assert.doesNotThrow(() => f.store.commitHour(f.results[0]));
  assert.equal(f.db.prepare('SELECT value FROM compact_meta WHERE key=?').get(key).value, '{}');
  for (const table of Object.keys(before).filter(t => t !== 'compact_meta')) assert.deepEqual(allState(f.db)[table], before[table]);
  assert.equal(recoveryHourPlan(f.db, BASE, { registry: noLaunch }).reason, 'recovery_unit_preservation_blocked'); f.db.close();
});
await test('multi-chunk source scan uses exact bounded ranges and distinct canonical duplicate keys', async () => {
  const f = await fixture({ blocksPerHour: 1000 }); let bodies = 0; const ranges = [];
  let offset = 0;
  while (!f.chain.rawBlock(ORIGIN + offset, true).transactions.length || !f.chain.rawBlock(ORIGIN + 500 + offset, true).transactions.length) offset++;
  const provider = { batch: async items => Promise.all(items.map(([m, p]) => provider.request(m, p))), request: async (m, p) => {
    if (m === 'eth_getBlockByNumber') { if (p[1]) bodies++; return f.chain.rawBlock(Number(BigInt(p[0])), p[1]); }
    if (m === 'eth_getCode') return '0x6000';
    if (m === 'eth_getLogs') {
      const filter = p[0], first = Number(BigInt(filter.fromBlock)), last = Number(BigInt(filter.toBlock)); ranges.push([first, last]);
      const n = first + offset, b = f.chain.rawBlock(n, true);
      return [{ address: registry.launches[0].address, blockNumber: `0x${n.toString(16)}`, blockHash: b.hash,
        transactionHash: b.transactions[0].hash, transactionIndex: '0x0', logIndex: '0x14', topics: [registry.launches[0].events[0].event.topic,
          '0x' + addr(n).slice(2).padStart(64, '0')], data: '0x' }];
    }
    throw new Error('unexpected RPC');
  } };
  assert.equal((await recoverDiscoveryHour({ db: f.db, hourStart: BASE, registry, provider })).phase, 'recovered');
  assert.equal(bodies, 2); assert.deepEqual(ranges, [[ORIGIN, ORIGIN + 499], [ORIGIN + 500, ORIGIN + 999]]);
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM compact_token_discoveries WHERE json_extract(candidate_json,'$.kind')='source'").get().n, 2); f.db.close();
});
await test('aggregate candidate cap retains every durable unit and does not repeatedly reaggregate or refetch', async () => {
  const f = await fixture({ missing: true });
  const candidate = n => ({ key: `fixture:${n}`, kind: 'creation', address: null, txHash: '0x' + n.toString(16).padStart(64, '0'),
    blockHash: f.chain.blockHash(ORIGIN), blockNumber: ORIGIN, timestamp: BASE, transactionIndex: n, deployer: addr(99), readBlock: ORIGIN + 9 });
  const outcome = await recoverDiscoveryHour({ db: f.db, hourStart: BASE, registry: noLaunch, recoverUnit: async ({ unit }) => {
    const result = payload(unit);
    if (unit.kind !== 'uniswap_v4') result.evidence.candidates = Array.from({ length: 1100 }, (_, i) => candidate(i + (unit.kind === 'creations' ? 1 : 1101)));
    return result;
  } });
  assert.equal(outcome.phase, 'incomplete'); assert.equal(outcome.reason, 'candidate_limit');
  const units = f.db.prepare("SELECT value FROM compact_meta WHERE key LIKE 'discovery_unit:%'").all().map(r => JSON.parse(r.value));
  assert.equal(units.reduce((n, u) => n + u.evidence.candidates.length, 0), 2200);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM compact_token_discoveries').get().n, 2048);
  const before = allState(f.db);
  const repeat = await recoverDiscoveryHour({ db: f.db, hourStart: BASE, registry: noLaunch, recoverUnit: () => { throw new Error('must_not_repeat'); } });
  assert.equal(repeat.phase, 'blocked'); assert.equal(repeat.reason, 'candidate_limit'); assert.deepEqual(allState(f.db), before); f.db.close();
});
await test('verified token results and old registry facts remain byte-for-byte intact during recovery', async () => {
  const f = await fixture();
  const row = f.db.prepare('SELECT candidate_json FROM compact_token_discoveries LIMIT 1').get(); assert(row);
  const candidate = JSON.parse(row.candidate_json);
  const verifier = { batch: async calls => calls.map(([method, args]) => method === 'eth_getCode' ? { result: '0x6000' }
    : args[0].data === selectorOf('machinaIntelligenceUnknownSelector()') ? { error: { code: 3, message: 'execution reverted' } }
      : { result: '0x' + (args[0].data === selectorOf('decimals()') ? 18n : 1n).toString(16).padStart(64, '0') }) };
  const verified = await verifyTokenCandidate(verifier, candidate);
  assert.equal(verified.status, 'verified_erc20_like');
  f.store.intelligence.recordVerification(verified, { now: 1000 });
  const facts = f.db.prepare('SELECT * FROM compact_token_discoveries ORDER BY candidate_key').all();
  const old = f.db.prepare('SELECT * FROM compact_intelligence_hours').all();
  await recoverDiscoveryHour({ db: f.db, hourStart: BASE, registry, recoverUnit: fakeRecover });
  assert.deepEqual(f.db.prepare('SELECT * FROM compact_token_discoveries ORDER BY candidate_key').all(), facts);
  for (const r of old) assert.deepEqual(f.db.prepare('SELECT * FROM compact_intelligence_hours WHERE registry_digest=?').get(r.registry_digest), r);
  f.db.close();
});
await test('generated 19/199/323/33 inventory is completely classified without assigning production failure causes', async () => {
  const f = await fixture({ count: 574 });
  for (let i = 0; i < 19; i++) await recoverDiscoveryHour({ db: f.db, hourStart: BASE + i * 3600, registry, recoverUnit: fakeRecover });
  for (let i = 218; i < 541; i++) {
    const hour = BASE + i * 3600;
    f.db.prepare('DELETE FROM compact_intelligence_hours WHERE hour_start=?').run(hour); // disposable inventory fixture only
    f.db.prepare('DELETE FROM compact_meta WHERE key LIKE ?').run(`discovery_unit:${hour}:%`);
  }
  for (let i = 541; i < 574; i++) {
    const hour = BASE + i * 3600, r = f.db.prepare('SELECT * FROM compact_intelligence_hours WHERE hour_start=?').get(hour);
    const p = JSON.parse(r.payload_json); p.version = 'generated-unknown-legacy-definition';
    p.discovery.status = 'insufficient_coverage'; p.discovery.reason = 'generated_fixture_only';
    const text = intelligenceJson(p), sha = createHash('sha256').update(text).digest('hex');
    f.db.prepare('UPDATE compact_intelligence_hours SET definition_version=?,discovery_status=?,payload_json=?,evidence_digest=? WHERE hour_start=?')
      .run(p.version, p.discovery.status, text, sha, hour);
  }
  const before = allState(f.db), plan = planDiscoveryRecovery(f.db, { registry });
  const counts = {};
  for (const p of plan.hours) counts[p.category] = (counts[p.category] ?? 0) + 1;
  assert.deepEqual(counts, { current_available: 19, older_available: 199, missing: 323, older_insufficient_or_other_definition: 33 });
  assert.equal(plan.hours.length, 574); assert.equal(Object.values(plan.counts).reduce((a, b) => a + b), 574);
  assert.deepEqual(allState(f.db), before); f.db.close();
});
await test('independently complete V4 live evidence is retained when V3 fails; recovery scans only V3', async () => {
  const f = await fixture({ streams: LOG_STREAMS.filter(s => s.key === 'v4') });
  const before = immutable(f.db), plan = recoveryHourPlan(f.db, BASE, { registry: noLaunch });
  assert.equal(plan.units.find(u => u.kind === 'uniswap_v4').phase, 'complete');
  assert.equal(plan.units.find(u => u.kind === 'uniswap_v3').phase, 'pending');
  const requests = [];
  const provider = { batch: (...args) => f.provider.batch(...args), request: (method, params) => { requests.push([method, params]); return f.provider.request(method, params); } };
  assert.equal((await recoverDiscoveryHour({ db: f.db, hourStart: BASE, registry: noLaunch, provider })).phase, 'recovered');
  assert.deepEqual(immutable(f.db), before);
  assert(requests.filter(([m]) => m === 'eth_getLogs').every(([, p]) => !p[0].topics[0].includes(LOG_STREAMS.find(s => s.key === 'v4').topics[0])));
  assert.equal(f.db.prepare("SELECT status FROM compact_family_hours WHERE family='uniswapV3'").get().status, 'unavailable'); f.db.close();
});
for (const count of [10000, 10001, 100000]) await test(`SQLite membership recovers with ${count} pools and immutable canonical/archive evidence`, async () => {
  const f = await fixture({ missing: true, poolCreatedAt: ORIGIN - 2, blocksPerHour: 350, txPerBlock:6 });
  // Generate one row at a time: the test itself must not allocate a registry-sized JS array/Set.
  const insert = f.db.prepare('INSERT INTO compact_registry VALUES(?,?,?,?,?,?)');
  f.db.exec('BEGIN');
  for (let n = 1; n < count; n++) insert.run('uniswap_v3_pool', addr(n + 1000), ORIGIN - 1, n,
    f.chain.blockHash(ORIGIN - 1), '{}');
  // A V3-signature foreign emitter appearing only in a future registry row must remain foreign.
  insert.run('uniswap_v3_pool', SYNTHETIC_CONTRACTS.foreignV3Emitter, ORIGIN + 1000, 0, f.chain.blockHash(ORIGIN + 1000), '{}');
  f.db.exec('COMMIT');
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM compact_registry WHERE kind='uniswap_v3_pool' AND created_block<?").get(ORIGIN).n, count);
  const query = "SELECT 1 FROM compact_registry WHERE kind='uniswap_v3_pool' AND address=? AND created_block<?";
  assert(f.db.prepare('EXPLAIN QUERY PLAN '+query).all(SYNTHETIC_CONTRACTS.validV3Pool, ORIGIN).some(r => /SEARCH.*PRIMARY KEY/.test(r.detail)));
  // Verify against actual production SQL through a delegating DB: no full registry read is permitted.
  let lookups = 0;
  const delegated = { get isTransaction() { return f.db.isTransaction; }, exec: sql => f.db.exec(sql), prepare(sql) {
    if (/SELECT address FROM compact_registry/.test(sql)) throw new Error('registry_bulk_read_forbidden');
    const statement = f.db.prepare(sql);
    return sql === query ? { get(...args) { lookups++; return statement.get(...args); } } : statement;
  } };
  const before = immutableDigest(f.db), start = performance.now();
  const result = await recoverDiscoveryHour({ db: delegated, hourStart: BASE, registry: noLaunch, provider: f.provider });
  assert.equal(result.phase, 'recovered'); assert(lookups > 0);
  assert.equal(immutableDigest(f.db), before); // Includes every archive table, canonical row, family and checkpoint.
  assert(f.results[0].families.uniswapV3.swapCount > 0); assert(f.results[0].families.uniswapV3.foreignEventCount > 0);
  console.log(`MEMBERSHIP_MEASUREMENT pools=${count} lookups=${lookups} recoveryMs=${(performance.now()-start).toFixed(1)} heapUsedMiB=${(process.memoryUsage().heapUsed/1024**2).toFixed(1)}`);
  f.db.close();
});
await test('same-hour V3 factory overlay still verifies pools absent from pre-hour registry', async () => {
  const f = await fixture({ missing: true }); const before = immutable(f.db);
  assert.equal(f.db.prepare("SELECT 1 FROM compact_registry WHERE address=? AND created_block<?").get(SYNTHETIC_CONTRACTS.validV3Pool, ORIGIN), undefined);
  assert.equal((await recoverDiscoveryHour({ db:f.db, hourStart:BASE, registry:noLaunch, provider:f.provider })).phase, 'recovered');
  assert.deepEqual(immutable(f.db), before); assert.equal(f.results[0].families.uniswapV3.poolCreatedCount, 1); f.db.close();
});
await test('versioned retry supersedes only obsolete V3 pool cap and preserves legacy records and successful units', async () => {
  const f = await fixture({ missing:true });
  await recoverDiscoveryHour({ db:f.db, hourStart:BASE, registry:noLaunch, now:1000, recoverUnit:async args => {
    if(args.unit.kind==='uniswap_v3') throw Object.assign(new Error('fixture cap'),{code:'recovery_pool_registry_limit'}); return fakeRecover(args);
  } });
  const p = recoveryHourPlan(f.db,BASE,{registry:noLaunch,now:1001}), v3=p.units.find(u=>u.kind==='uniswap_v3');
  assert.equal(v3.phase,'pending'); assert.equal(v3.retryPolicy,V3_RETRY_POLICY); assert.equal(v3.attempts,1);
  const key=`discovery_retry:${BASE}:${v3.id}`, legacy=f.db.prepare('SELECT value FROM compact_meta WHERE key=?').get(key).value;
  const before=immutable(f.db), calls=[];
  await recoverDiscoveryHour({db:f.db,hourStart:BASE,registry:noLaunch,now:1001,recoverUnit:async args=>{calls.push(args.unit.kind);return fakeRecover(args);}});
  assert.deepEqual(calls,['uniswap_v3']); assert.deepEqual(immutable(f.db),before);
  assert.equal(f.db.prepare('SELECT value FROM compact_meta WHERE key=?').get(key).value,legacy);
  const revised=JSON.parse(f.db.prepare('SELECT value FROM compact_meta WHERE key=?').get(`${key}:${V3_RETRY_POLICY}`).value);
  assert.equal(revised.retryPolicy,V3_RETRY_POLICY); assert.equal(revised.attempts,2);
  assert.equal((await recoverDiscoveryHour({db:f.db,hourStart:BASE,registry:noLaunch,recoverUnit:()=>{throw new Error('repeat');}})).rpcNeeded,false); f.db.close();
});
await test('retry policy leaves other blocked reasons, exhausted quotas and non-V3 caps untouched', async () => {
  for(const [kind,reason,exhausted] of [['uniswap_v3','recovery_pool_definition_mismatch',false],['creations','recovery_pool_registry_limit',false],['uniswap_v4','recovery_pool_registry_limit',false],['uniswap_v3','recovery_pool_registry_limit',true]]) {
    const f=await fixture({missing:true});
    await recoverDiscoveryHour({db:f.db,hourStart:BASE,registry:noLaunch,now:1000,recoverUnit:async args=>{
      if(args.unit.kind===kind)throw Object.assign(new Error('fixture'),{code:reason});return fakeRecover(args);
    }});
    if(exhausted){const u=recoveryHourPlan(f.db,BASE,{registry:noLaunch}).units.find(u=>u.kind===kind),key=`discovery_retry:${BASE}:${u.id}`;
      const record=JSON.parse(f.db.prepare('SELECT value FROM compact_meta WHERE key=?').get(key).value);record.attempts=MAX_RECOVERY_ATTEMPTS;
      f.db.prepare('UPDATE compact_meta SET value=? WHERE key=?').run(JSON.stringify(record),key);}
    const before=allState(f.db),plan=recoveryHourPlan(f.db,BASE,{registry:noLaunch,now:100*RECOVERY_RETRY_MS});
    assert.equal(plan.units.find(u=>u.kind===kind).phase,'blocked');
    await recoverDiscoveryHour({db:f.db,hourStart:BASE,registry:noLaunch,now:100*RECOVERY_RETRY_MS,recoverUnit:()=>{throw new Error('unexpected RPC');}});
    assert.deepEqual(allState(f.db),before);f.db.close();
  }
});
await test('retry policy survives interruption, honors cooldown and never resets attempts after revised failures', async () => {
  const f=await fixture({missing:true});
  await recoverDiscoveryHour({db:f.db,hourStart:BASE,registry:noLaunch,now:1000,recoverUnit:async args=>{
    if(args.unit.kind==='uniswap_v3')throw Object.assign(new Error('cap'),{code:'recovery_pool_registry_limit'});return fakeRecover(args);
  }});
  const v3=recoveryHourPlan(f.db,BASE,{registry:noLaunch}).units.find(u=>u.kind==='uniswap_v3'), key=`discovery_retry:${BASE}:${v3.id}`;
  const legacy=f.db.prepare('SELECT value FROM compact_meta WHERE key=?').get(key).value;
  for(let attempt=2;attempt<=MAX_RECOVERY_ATTEMPTS;attempt++){
    const now=1001+(attempt-2)*(RECOVERY_RETRY_MS+1);
    await recoverDiscoveryHour({db:f.db,hourStart:BASE,registry:noLaunch,now,recoverUnit:()=>{throw new ProviderError('transport');}});
    const plan=recoveryHourPlan(f.db,BASE,{registry:noLaunch,now:now+1});
    assert.equal(plan.units.find(u=>u.kind==='uniswap_v3').attempts,attempt);
    assert.equal(plan.units.find(u=>u.kind==='uniswap_v3').phase,attempt===MAX_RECOVERY_ATTEMPTS?'blocked':'retryable');
  }
  assert.equal(f.db.prepare('SELECT value FROM compact_meta WHERE key=?').get(key).value,legacy);
  const before=allState(f.db);await recoverDiscoveryHour({db:f.db,hourStart:BASE,registry:noLaunch,now:100*RECOVERY_RETRY_MS,recoverUnit:()=>{throw new Error('quota reset');}});
  assert.deepEqual(allState(f.db),before);f.db.close();
});
await test('versioned V3 lease survives process death and restart without erasing old failure or successful units', async () => {
  const dir=mkdtempSync(join(tmpdir(),'discovery-policy-crash-')),path=join(dir,'db.sqlite');let child;
  try {
    const f=await fixture({missing:true,path});
    await recoverDiscoveryHour({db:f.db,hourStart:BASE,registry:noLaunch,recoverUnit:async args=>{
      if(args.unit.kind==='uniswap_v3')throw Object.assign(new Error('cap'),{code:'recovery_pool_registry_limit'});return fakeRecover(args);
    }});
    const unit=recoveryHourPlan(f.db,BASE,{registry:noLaunch}).units.find(u=>u.kind==='uniswap_v3'),key=`discovery_retry:${BASE}:${unit.id}`;
    const legacy=f.db.prepare('SELECT value FROM compact_meta WHERE key=?').get(key).value,before=immutableDigest(f.db);f.db.close();
    child=fork(new URL(import.meta.url),[],{env:{...process.env,RECOVERY_POLICY_CRASH_CHILD:path},execArgv:['--max-old-space-size=64','--max-semi-space-size=2'],stdio:['ignore','ignore','ignore','ipc']});
    await new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>reject(new Error('policy_crash_test_timeout')),5000);
      child.once('message',()=>{clearTimeout(timer);resolve();});child.once('exit',()=>{clearTimeout(timer);reject(new Error('policy_child_early_exit'));});
    });
    const exited=once(child,'exit');child.kill('SIGKILL');await exited;
    const db=new DatabaseSync(path),lock=acquireWriterLock(path,{owner:'disposable-policy-restart'});
    try {
      assert.equal(immutableDigest(db),before);assert.equal(db.prepare('SELECT value FROM compact_meta WHERE key=?').get(key).value,legacy);
      const revised=JSON.parse(db.prepare('SELECT value FROM compact_meta WHERE key=?').get(`${key}:${V3_RETRY_POLICY}`).value);
      assert.equal(revised.reason,'recovery_interrupted_or_in_progress');assert.equal(revised.attempts,2);
      assert.equal(recoveryHourPlan(db,BASE,{registry:noLaunch}).units.find(u=>u.kind==='uniswap_v3').phase,'retryable');
      const calls=[];
      await recoverDiscoveryHour({db,hourStart:BASE,registry:noLaunch,now:revised.notBefore+1,recoverUnit:async args=>{calls.push(args.unit.kind);return fakeRecover(args);}});
      assert.deepEqual(calls,['uniswap_v3']);assert.equal(immutableDigest(db),before);
      assert.equal(db.prepare('SELECT value FROM compact_meta WHERE key=?').get(key).value,legacy);
    } finally {lock.release();db.close();}
  } finally {child?.kill('SIGKILL');rmSync(dir,{recursive:true,force:true});}
});
await test('response budget remains original error even if body cancellation fails; zero RPC after failure', async () => {
  for (const cancellation of ['fails','stalls']) {
  const bounded=boundedRecoveryProvider({sleep:async()=>{},budget:{...RECOVERY_BUDGET,responseBytes:5},fetchImpl:async()=>new Response(new ReadableStream({
    start(c){c.enqueue(new Uint8Array(6));},cancel(){if(cancellation==='fails')throw new Error('SECRET cancellation');return new Promise(()=>{});}
  }))});
  await assert.rejects(bounded.provider.request('eth_getCode',[]),e=>e.code==='recovery_response_budget_exhausted'&&providerDiagnostics(e).category==='response_budget');
  const requests=bounded.stats.requests;
  await assert.rejects(bounded.provider.request('eth_getCode',[]),e=>e.code==='recovery_response_budget_exhausted');
  assert.equal(bounded.stats.requests,requests);bounded.close();
  }
});
await test('bounded provider isolates HTTP, body-read and cumulative response budget failures with no extra requests', async () => {
  for(const kind of ['http','body_read','response_budget']){
    let requests=0;
    const bounded=boundedRecoveryProvider({sleep:async()=>{},budget:{...RECOVERY_BUDGET,...(kind==='response_budget'?{bytes:80}:{})},fetchImpl:async(_url,options)=>{
      requests++;const item=JSON.parse(options.body);
      if(item.method==='eth_chainId')return new Response(JSON.stringify({jsonrpc:'2.0',id:item.id,result:'0x13b2'}));
      if(kind==='http')return new Response('SECRET upstream',{status:503});
      if(kind==='body_read')return new Response(new ReadableStream({start(c){c.error(new Error('SECRET reader'));}}));
      return new Response('SECRET'+'x'.repeat(50));
    }});
    await assert.rejects(bounded.provider.request('eth_getLogs',[{fromBlock:'0x10',toBlock:'0x20',address:'SECRET'}]),e=>{
      const d=providerDiagnostics(e);assert.equal(d.category,kind);assert.deepEqual(d.blockRange,{first:16,last:32});
      assert.equal(d.recoveryUsage.requests,2);assert(!JSON.stringify(d).includes('SECRET'));
      return e.code===(kind==='response_budget'?'recovery_response_budget_exhausted':'transport');
    });
    await assert.rejects(bounded.provider.batch([['eth_getCode',[]]]));assert.equal(requests,2);bounded.close();
  }
});
await test('recovery deadline abort keeps time-budget identity and creates no subsequent request', async () => {
  let requests=0;
  const bounded=boundedRecoveryProvider({sleep:async()=>{},budget:{...RECOVERY_BUDGET,timeoutMs:10},fetchImpl:async(_url,{signal})=>{
    requests++;return new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(new Error('SECRET aborted')),{once:true}));
  }});
  await assert.rejects(bounded.provider.request('eth_getCode',[]),e=>e.code==='recovery_time_budget_exhausted'&&providerDiagnostics(e).category==='time_budget');
  await assert.rejects(bounded.provider.request('eth_getCode',[]));assert.equal(requests,1);bounded.close();
});
await test('revised blocked failure cannot restart the V3 retry transition and corrupt supersession fails closed', async () => {
  const f=await fixture({missing:true});
  const cap=async args=>{if(args.unit.kind==='uniswap_v3')throw Object.assign(new Error('cap'),{code:'recovery_pool_registry_limit'});return fakeRecover(args);};
  await recoverDiscoveryHour({db:f.db,hourStart:BASE,registry:noLaunch,now:1000,recoverUnit:cap});
  await recoverDiscoveryHour({db:f.db,hourStart:BASE,registry:noLaunch,now:1001,recoverUnit:async()=>{throw Object.assign(new Error('bad evidence'),{code:'recovery_family_evidence_conflict'});}});
  const p=recoveryHourPlan(f.db,BASE,{registry:noLaunch,now:100*RECOVERY_RETRY_MS}),unit=p.units.find(u=>u.kind==='uniswap_v3');
  assert.equal(unit.phase,'blocked');assert.equal(unit.reason,'recovery_family_evidence_conflict');assert.equal(unit.attempts,2);
  const before=allState(f.db);await recoverDiscoveryHour({db:f.db,hourStart:BASE,registry:noLaunch,now:100*RECOVERY_RETRY_MS,recoverUnit:()=>{throw new Error('reset');}});
  assert.deepEqual(allState(f.db),before);
  const key=`discovery_retry:${BASE}:${unit.id}:${V3_RETRY_POLICY}`,revised=JSON.parse(f.db.prepare('SELECT value FROM compact_meta WHERE key=?').get(key).value);
  revised.supersedes='0'.repeat(64);f.db.prepare('UPDATE compact_meta SET value=? WHERE key=?').run(JSON.stringify(revised),key);
  assert.equal(recoveryHourPlan(f.db,BASE,{registry:noLaunch}).reason,'recovery_retry_policy_conflict');f.db.close();
});
await test('transport diagnostics survive durable retries without secrets or additional failed-run RPC', async () => {
  const f=await fixture({missing:true}), before=immutable(f.db),logs=[];let requests=0;
  const bounded=boundedRecoveryProvider({sleep:async()=>{},fetchImpl:async()=>{requests++;throw new TypeError('SECRET https://user:password@host',{cause:{code:'ECONNRESET'}});}});
  const outcome=await recoverDiscoveryHour({db:f.db,hourStart:BASE,registry:noLaunch,provider:bounded.provider,checkBudget:bounded.check,log:s=>logs.push(s)});
  assert.equal(outcome.phase,'incomplete');assert.equal(requests,1);assert.deepEqual(immutable(f.db),before);
  const retries=f.db.prepare("SELECT value FROM compact_meta WHERE key LIKE 'discovery_retry:%'").all();
  assert.equal(retries.length,1);const record=JSON.parse(retries[0].value);
  assert.equal(record.reason,'transport');assert.equal(record.diagnostics.category,'transport');assert.equal(record.diagnostics.causeCode,'ECONNRESET');
  assert.equal(recoveryHourPlan(f.db,BASE,{registry:noLaunch}).units.find(u=>u.kind==='creations').phase,'retryable',
    'An empty accepted-list checksum cannot certify creations after an explicitly failed scan');
  assert.deepEqual(record.diagnostics.methods,['eth_chainId']);assert.equal(record.diagnostics.recoveryUsage.requests,1);
  assert(!JSON.stringify([record,logs]).includes('SECRET'));assert(!JSON.stringify([record,logs]).includes('password'));
  bounded.close();f.db.close();
});
console.log(`Discovery recovery checks: ${passed} passed (disposable SQLite, no external network)`);
