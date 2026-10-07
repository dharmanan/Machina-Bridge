// Compact Intelligence API: deterministic checks for the read-only HTTP layer and the read-only SQLite read model.
// No network, no Arc RPC (fetch is replaced by a throwing spy), no writes to anything but temporary test databases.
// HTTP and static checks run on any Node. node:sqlite checks need Node 22.13+ (production: Node 24); on an older runtime
// they are reported DEFERRED, and COMPACT_REQUIRE_SQLITE=1 turns that into a failure.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FAMILY_FIELDS, FAMILY_WINDOWS } from '../server/compact/families.js';
import { createIntelligenceServer, MAX_RESPONSE_BYTES, MAX_URL_LENGTH } from '../server/compact/http.js';
import { ARC_CHAIN_ID } from '../server/compact/provider.js';
import { v4PoolIdOf, V4_POOL_KIND } from '../server/compact/projections.js';
import {
  ACTIVITY_SCHEMA, createCompactReadModel, POOLS_SCHEMA, ReadModelError, STALE_LAG_HOURS, SUMMARY_SCHEMA, SUMMARY_WINDOWS, TIMESERIES_SCHEMA,
  TIMESERIES_WINDOWS,
} from '../server/compact/read-model.js';
import { V3_POOL_KIND } from '../server/compact/registry.js';
import { createScheduler } from '../server/compact/scheduler.js';
import { COMPACT_DEFINITION_VERSION, FAMILY_VERSIONS } from '../server/compact/sources.js';
import { createCompactStore } from '../server/compact/store.js';
import { ECOSYSTEM_SCHEMA } from '../server/compact/intelligence-registry.js';

let passed = 0;
const TEST_FILTERS = (process.env.COMPACT_API_TEST_FILTER ?? '').split('||').map((value) => value.trim()).filter(Boolean);
async function test(name, run) { if (TEST_FILTERS.length && TEST_FILTERS.some((value) => name.includes(value)) === false) return; await run(); passed += 1; console.log(`PASS ${name}`); }

// Any Arc RPC (or any network call) from these code paths is a failure.
let fetchCalls = 0;
globalThis.fetch = async () => { fetchCalls += 1; throw new Error('network is not allowed in this test'); };

const root = new URL('..', import.meta.url);
const source = (path) => readFileSync(new URL(path, root), 'utf8');

// ---------------------------------------------------------------------------------------------------------------------
// HTTP helpers: raw request strings, so no client-side URL normalization hides what the server receives.
function send(port, { method = 'GET', path, headers = {}, body = null }) {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, method, path, headers }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = text ? JSON.parse(text) : null; } catch { json = null; }
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
    });
    req.on('error', reject);
    if (body !== null) req.write(body);
    req.end();
  });
}

async function withServer(options, run) {
  const server = createIntelligenceServer(options);
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  try {
    return await run(server.address().port);
  } finally {
    server.closeAllConnections?.();
    await new Promise((done) => server.close(done));
  }
}

function fakeReadModel(overrides = {}) {
  const calls = [];
  let version = 1;
  return {
    calls,
    bump() { version += 1; },
    health() { calls.push('health'); return overrides.health ? overrides.health() : { status: 'ok', checkpointHour: '2026-10-02T09:00:00.000Z' }; },
    summary(window) { calls.push(`summary:${window}`); return overrides.summary ? overrides.summary(window) : { schema: SUMMARY_SCHEMA, window: { key: window }, version }; },
    timeseries(window) { calls.push(`timeseries:${window}`); return overrides.timeseries ? overrides.timeseries(window) : { schema: TIMESERIES_SCHEMA, window: { key: window }, version }; },
    pools(protocol, window) {
      calls.push(`pools:${protocol}:${window}`);
      return overrides.pools ? overrides.pools(protocol, window) : { schema: POOLS_SCHEMA, protocol, window: { key: window }, version };
    },
    activity(type) { calls.push(`activity:${type}`); return overrides.activity ? overrides.activity(type) : { schema: ACTIVITY_SCHEMA, type, version }; },
    ecosystem(window) { calls.push(`ecosystem:${window}`); return { schema: ECOSYSTEM_SCHEMA, chain: { id: 5042 }, window: { key: window }, version }; },
  };
}

// Existing routes and three additive ecosystem routes, each with the exact read-model call it must make.
const ROUTE_CALLS = [
  ['/v1/intelligence/ecosystem?window=24h', 'ecosystem:24h'],
  ['/v1/intelligence/ecosystem?window=7d', 'ecosystem:7d'],
  ['/v1/intelligence/ecosystem?window=30d', 'ecosystem:30d'],
  ['/health', 'health'],
  ['/v1/intelligence/summary?window=1h', 'summary:1h'],
  ['/v1/intelligence/summary?window=6h', 'summary:6h'],
  ['/v1/intelligence/summary?window=24h', 'summary:24h'],
  ['/v1/intelligence/timeseries?window=6h', 'timeseries:6h'],
  ['/v1/intelligence/timeseries?window=24h', 'timeseries:24h'],
  ['/v1/intelligence/pools?protocol=v3&window=24h', 'pools:v3:24h'],
  ['/v1/intelligence/pools?protocol=v4&window=24h', 'pools:v4:24h'],
  ['/v1/intelligence/activity?type=all', 'activity:all'],
  ['/v1/intelligence/activity?type=swaps', 'activity:swaps'],
  ['/v1/intelligence/activity?type=adds', 'activity:adds'],
  ['/v1/intelligence/activity?type=removes', 'activity:removes'],
  ['/v1/intelligence/summary?window=7d', 'summary:7d'],
  ['/v1/intelligence/summary?window=30d', 'summary:30d'],
  ['/v1/intelligence/timeseries?window=7d', 'timeseries:7d'],
  ['/v1/intelligence/timeseries?window=30d', 'timeseries:30d'],
  ['/v1/intelligence/pools?protocol=v3&window=7d', 'pools:v3:7d'],
  ['/v1/intelligence/pools?protocol=v3&window=30d', 'pools:v3:30d'],
  ['/v1/intelligence/pools?protocol=v4&window=7d', 'pools:v4:7d'],
  ['/v1/intelligence/pools?protocol=v4&window=30d', 'pools:v4:30d'],
];
const VALID = ROUTE_CALLS.map(([path]) => path);

await test('http: only the 23 exact read routes answer 200; health is no-store, data routes carry an ETag', async () => {
  const model = fakeReadModel();
  await withServer({ readModel: model }, async (port) => {
    for (const path of VALID) {
      const res = await send(port, { path });
      assert.equal(res.status, 200, path);
      assert.equal(res.headers['content-type'], 'application/json; charset=utf-8');
      assert.equal(res.headers['x-content-type-options'], 'nosniff');
      assert.equal(res.headers['access-control-allow-origin'], undefined, 'no CORS');
      if (path === '/health') {
        assert.equal(res.headers['cache-control'], 'no-store');
        assert.equal(res.headers.etag, undefined);
      } else {
        assert.equal(res.headers['cache-control'], 'no-cache');
        assert.match(res.headers.etag, /^"[0-9a-f]{40}"$/);
        const [kind, ...args] = ROUTE_CALLS.find(([candidate]) => candidate === path)[1].split(':');
        if (kind === 'pools') assert.deepEqual([res.json.schema, res.json.protocol, res.json.window.key], [POOLS_SCHEMA, ...args]);
        else if (kind === 'activity') assert.deepEqual([res.json.schema, res.json.type], [ACTIVITY_SCHEMA, ...args]);
        else assert.equal(res.json.window.key, args[0]);
      }
    }
    assert.deepEqual(model.calls, ROUTE_CALLS.map(([, call]) => call), 'each route calls exactly its read-model method with its fixed arguments');
  });
});

await test('http: arbitrary windows, extra or repeated parameters and SQL-like input are rejected before the read model', async () => {
  const model = fakeReadModel();
  await withServer({ readModel: model }, async (port) => {
    const rejected = [
      '/v1/intelligence/timeseries?window=1h', '/v1/intelligence/summary?window=2h', '/v1/intelligence/summary?window=48h',
      '/v1/intelligence/summary?window=24H', '/v1/intelligence/summary?window=24h%20', '/v1/intelligence/summary?window=%32%34h',
      '/v1/intelligence/summary?window=24h&window=6h', '/v1/intelligence/summary?window=24h&x=1', '/v1/intelligence/summary?Window=24h',
      '/v1/intelligence/summary?window=', '/v1/intelligence/summary', '/v1/intelligence/summary?', '/v1/intelligence/timeseries',
      "/v1/intelligence/summary?window=24h'%20OR%201=1--", '/v1/intelligence/summary?window=24h;DROP%20TABLE%20compact_hours',
      '/v1/intelligence/summary?window=24h#x', '/health?x=1', '/health?',
      // pools: protocol v3 or v4, window 24h, in exactly this order
      '/v1/intelligence/pools?protocol=v2&window=24h', '/v1/intelligence/pools?protocol=v3&window=6h', '/v1/intelligence/pools?protocol=v3&window=7D',
      '/v1/intelligence/summary?window=7D', '/v1/intelligence/summary?window=1w', '/v1/intelligence/timeseries?window=30D', '/v1/intelligence/pools?protocol=v3&window=90d',
      '/v1/intelligence/pools?window=24h&protocol=v3', '/v1/intelligence/pools?protocol=v3&window=24h&x=1', '/v1/intelligence/pools?x=1&protocol=v3&window=24h',
      '/v1/intelligence/pools?protocol=v3&protocol=v4&window=24h', '/v1/intelligence/pools?protocol=v3&window=24h&window=24h',
      '/v1/intelligence/pools?protocol=v3', '/v1/intelligence/pools?window=24h', '/v1/intelligence/pools', '/v1/intelligence/pools?',
      '/v1/intelligence/pools?protocol=V3&window=24h', '/v1/intelligence/pools?Protocol=v3&window=24h', '/v1/intelligence/pools?protocol=v3&window=24H',
      '/v1/intelligence/pools?protocol=%76%33&window=24h', '/v1/intelligence/pools?protocol=v3%26window=24h', '/v1/intelligence/pools?protocol=v3&amp;window=24h',
      '/v1/intelligence/pools?protocol=v3;&window=24h', "/v1/intelligence/pools?protocol=v3'--&window=24h",
      // activity: one of all, swaps, adds, removes
      '/v1/intelligence/activity?type=mints', '/v1/intelligence/activity?type=swap', '/v1/intelligence/activity?type=Swaps',
      '/v1/intelligence/activity?type=ALL', '/v1/intelligence/activity?type=all&type=swaps', '/v1/intelligence/activity?type=all&limit=100',
      '/v1/intelligence/activity?limit=25&type=all', '/v1/intelligence/activity?type=%61ll', '/v1/intelligence/activity?type=',
      '/v1/intelligence/activity', '/v1/intelligence/activity?', '/v1/intelligence/activity?Type=all',
    ];
    for (const path of rejected) {
      const res = await send(port, { path });
      assert.equal(res.status, 400, path);
      assert.deepEqual(res.json, { error: 'bad_request' }, path);
    }
    assert.deepEqual(model.calls, []);
  });
});

await test('http: unknown routes are 404, absolute-form and oversized URLs are refused', async () => {
  const model = fakeReadModel();
  await withServer({ readModel: model }, async (port) => {
    for (const path of ['/', '/v1/intelligence/latest', '/v1/intelligence/coverage', '/v1/intelligence/runtime', '/v1/intelligence/status',
      '/health/', '/v1/intelligence/summary/', '/v1/intelligence/../../health', '/db', '/data/arc-compact.sqlite', '/debug',
      '/v1/intelligence/pool?protocol=v3&window=24h', '/v1/intelligence/pools/', '/v1/intelligence/Pools?protocol=v3&window=24h',
      '/v1/intelligence/activity/', '/v1/intelligence/activities?type=all', '/v1/intelligence/swaps', '/v2/intelligence/pools?protocol=v3&window=24h']) {
      const res = await send(port, { path });
      assert.equal(res.status, 404, path);
      assert.deepEqual(res.json, { error: 'not_found' });
    }
    const absolute = await send(port, { path: 'http://evil.example/health' });
    assert.equal(absolute.status, 400);
    const long = await send(port, { path: `/v1/intelligence/summary?window=24h&pad=${'a'.repeat(MAX_URL_LENGTH)}` });
    assert.equal(long.status, 414);
    assert.deepEqual(long.json, { error: 'uri_too_long' });
    assert.deepEqual(model.calls, []);
  });
});

await test('http: GET only; any request body is refused', async () => {
  const model = fakeReadModel();
  await withServer({ readModel: model }, async (port) => {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']) {
      for (const path of ['/v1/intelligence/summary?window=24h', '/v1/intelligence/pools?protocol=v3&window=24h', '/v1/intelligence/activity?type=all']) {
        const res = await send(port, { method, path });
        assert.equal(res.status, 405, `${method} ${path}`);
        assert.equal(res.headers.allow, 'GET');
        assert.deepEqual(res.json, { error: 'method_not_allowed' });
      }
    }
    const head = await send(port, { method: 'HEAD', path: '/health' });
    assert.equal(head.status, 405);
    const withBody = await send(port, { path: '/health', headers: { 'content-length': '5' }, body: 'hello' });
    assert.equal(withBody.status, 400);
    assert.deepEqual(withBody.json, { error: 'body_not_allowed' });
    const chunked = await send(port, { path: '/health', headers: { 'transfer-encoding': 'chunked' }, body: 'hello' });
    assert.equal(chunked.status, 400);
    for (const path of ['/v1/intelligence/pools?protocol=v4&window=24h', '/v1/intelligence/activity?type=removes']) {
      const res = await send(port, { path, headers: { 'content-length': '2' }, body: '{}' });
      assert.deepEqual([res.status, res.json], [400, { error: 'body_not_allowed' }], path);
    }
    assert.deepEqual(model.calls, []);
  });
});

await test('http: read failures become fixed sanitized errors; incompatible databases are fatal; the server keeps serving', async () => {
  let fatal = 0;
  let mode = 'leak';
  const model = fakeReadModel({
    summary() {
      if (mode === 'leak') throw Object.assign(new Error('SQLITE_BUSY: database /data/arc-compact.sqlite is locked at Object.x (store.js:1)'), { code: 'ERR_SQLITE_ERROR' });
      if (mode === 'not_ready') throw new ReadModelError('not_ready', 'database_missing');
      throw new ReadModelError('incompatible', 'schema_version_mismatch');
    },
  });
  await withServer({ readModel: model, onFatal: () => { fatal += 1; } }, async (port) => {
    const leak = await send(port, { path: '/v1/intelligence/summary?window=24h' });
    assert.equal(leak.status, 503);
    assert.equal(leak.text, '{"error":"unavailable"}');
    mode = 'not_ready';
    const notReady = await send(port, { path: '/v1/intelligence/summary?window=24h' });
    assert.equal(notReady.text, '{"error":"not_ready"}');
    mode = 'incompatible';
    const incompatible = await send(port, { path: '/v1/intelligence/summary?window=24h' });
    assert.equal(incompatible.text, '{"error":"unavailable"}');
    assert.equal(fatal, 1);
    const health = await send(port, { path: '/health' });
    assert.equal(health.status, 200, 'one failing route never stops the server');
  });
  // The pools and activity routes share the same sanitization: nothing of an internal error reaches the client.
  const leaking = () => { throw Object.assign(new Error('SQLITE_ERROR: no such table compact_pool_hours at /data/arc-compact.sqlite'), { code: 'ERR_SQLITE_ERROR' }); };
  const pools = fakeReadModel({ pools: leaking, activity: () => { throw new ReadModelError('inconsistent_state', 'pool_registry_metadata_malformed'); } });
  await withServer({ readModel: pools }, async (port) => {
    for (const path of ['/v1/intelligence/pools?protocol=v3&window=24h', '/v1/intelligence/activity?type=all']) {
      const res = await send(port, { path });
      assert.deepEqual([res.status, res.text, res.headers['cache-control']], [503, '{"error":"unavailable"}', 'no-store'], path);
    }
  });
});

await test('http: ETag is the hash of the exact body; If-None-Match gives 304; changed data gives a new tag', async () => {
  const model = fakeReadModel();
  await withServer({ readModel: model }, async (port) => {
    const path = '/v1/intelligence/summary?window=6h';
    const first = await send(port, { path });
    const expected = `"${createHash('sha256').update(first.text).digest('hex').slice(0, 40)}"`;
    assert.equal(first.headers.etag, expected);
    const again = await send(port, { path });
    assert.equal(again.headers.etag, expected);
    const cached = await send(port, { path, headers: { 'if-none-match': expected } });
    assert.equal(cached.status, 304);
    assert.equal(cached.text, '');
    const weak = await send(port, { path, headers: { 'if-none-match': `"other", W/${expected}` } });
    assert.equal(weak.status, 304);
    const miss = await send(port, { path, headers: { 'if-none-match': '"stale"' } });
    assert.equal(miss.status, 200);
    model.bump();
    const changed = await send(port, { path, headers: { 'if-none-match': expected } });
    assert.equal(changed.status, 200, 'a changed body is never answered with 304');
    assert.notEqual(changed.headers.etag, expected);
    // The pools and activity data routes carry the same validator contract.
    for (const dataPath of ['/v1/intelligence/pools?protocol=v4&window=24h', '/v1/intelligence/activity?type=swaps']) {
      const res = await send(port, { path: dataPath });
      assert.equal(res.headers.etag, `"${createHash('sha256').update(res.text).digest('hex').slice(0, 40)}"`, dataPath);
      assert.equal(res.headers['cache-control'], 'no-cache');
      assert.equal((await send(port, { path: dataPath, headers: { 'if-none-match': res.headers.etag } })).status, 304, dataPath);
      model.bump();
      assert.equal((await send(port, { path: dataPath, headers: { 'if-none-match': res.headers.etag } })).status, 200, dataPath);
    }
  });
});

await test('http: response size is bounded; the auth seam can refuse a request without touching the read model', async () => {
  const huge = fakeReadModel({ summary: () => ({ blob: 'x'.repeat(MAX_RESPONSE_BYTES) }) });
  await withServer({ readModel: huge }, async (port) => {
    const res = await send(port, { path: '/v1/intelligence/summary?window=24h' });
    assert.equal(res.status, 503);
    assert.deepEqual(res.json, { error: 'response_too_large' });
  });
  const model = fakeReadModel();
  await withServer({ readModel: model, authorize: (req) => req.headers['x-intelligence-key'] === 'k' }, async (port) => {
    assert.equal((await send(port, { path: '/health' })).status, 401);
    assert.equal((await send(port, { path: '/health', headers: { 'x-intelligence-key': 'k' } })).status, 200);
    assert.deepEqual(model.calls, ['health']);
  });
});

await test('static: the HTTP and read paths cannot write SQLite, call Arc RPC, run shell commands or open CORS', () => {
  const http = source('server/compact/http.js');
  const read = source('server/compact/read-model.js');
  const imports = (text) => [...text.matchAll(/^import .* from '([^']+)';$/gm)].map((match) => match[1]);
  assert.deepEqual(imports(http), ['node:crypto', 'node:http']);
  assert.match(read, /readOnly: true/);
  assert.match(read, /PRAGMA query_only = ON/);
  assert.match(read, /query_only !== 1/);
  assert.doesNotMatch(read, /\b(INSERT|UPDATE|DELETE|CREATE|DROP|ALTER|REPLACE|VACUUM|ATTACH|DETACH|REINDEX)\b/);
  assert.doesNotMatch(read, /journal_mode|wal_checkpoint|IMMEDIATE|EXCLUSIVE|createCompactStore|commitHour/i);
  for (const text of [http, read]) {
    assert.doesNotMatch(text, /fetch\(|createProvider|\.request\(|eth_|child_process|spawn\(|execFile|execSync|Access-Control-Allow/);
  }
  // The only statements the read path executes directly are pragmas and read-transaction control.
  for (const match of read.matchAll(/\.exec\(([`'])([^`']*)\1\)/g)) {
    assert.match(match[2], /^(PRAGMA (query_only = ON|busy_timeout = \$\{busyTimeoutMs\})|BEGIN|COMMIT|ROLLBACK)$/, match[2]);
  }
  // Only the explicit routes exist, and no route takes a free-form value.
  assert.deepEqual([...http.matchAll(/^ {2}\['(\/[^']*)'/gm)].map((match) => match[1]), VALID);
});

// ---------------------------------------------------------------------------------------------------------------------
// node:sqlite read model.
const sqlite = await import('node:sqlite').catch(() => null);
if (!sqlite) {
  assert.notEqual(process.env.COMPACT_REQUIRE_SQLITE, '1', `node:sqlite is required but unavailable on Node ${process.version}`);
  console.log(`DEFERRED read-model sqlite tests: node:sqlite is unavailable on Node ${process.version}; run on Node 24`);
} else {
  const { DatabaseSync } = sqlite;
  const workdir = mkdtempSync(join(tmpdir(), 'compact-api-'));
  const HOUR = 3600;
  const BASE = Date.UTC(2026, 9, 1, 0) / 1000;
  const BIG = 10n ** 24n;
  const USDC = '0x3600000000000000000000000000000000000000';
  const EURC = '0xbef5f6d51cb62b58e6a8f77868681825c6fe21c1';
  const CIRBTC = '0x171a4217b86a807a64eb94757db6849fb4bdbaa0';
  const SPOKE = `0x${'5'.repeat(40)}`;
  const MARKET = `0x${'ab'.repeat(32)}`;
  const VAULT = `0x${'fa'.repeat(20)}`;
  const iso = (seconds) => new Date(seconds * 1000).toISOString();
  const hash = (n) => `0x${n.toString(16).padStart(64, '0')}`;
  const address = (n) => `0x${n.toString(16).padStart(40, '0')}`;
  const CONSTANTS = { rawDecimals: 18, symbol: 'EURC', address: EURC, decimals: 6, spoke: SPOKE, reserveId: '1', underlying: USDC,
    loanToken: USDC, collateralToken: CIRBTC, lltv: '860000000000000000', asset: USDC };
  const TALLY_KEYS = { outboundByDestinationDomain: ['0', '6'], messagesBySourceDomain: ['0'], inboundBySourceDomain: ['0'],
    depositByToken: [EURC], depositByDestinationChain: ['1'], fillByToken: [EURC], fillByOriginChain: ['1'], reserves: [`${SPOKE}:1`],
    markets: [MARKET], vaults: [VAULT] };
  const blocksOf = (i) => 10 + (i % 3);
  const firstBlockOf = (i) => 1000 + Array.from({ length: i }, (_, j) => blocksOf(j)).reduce((a, b) => a + b, 0);
  const txOf = (i) => 100 + i * 7;
  const gasOf = (i) => 10n ** 20n + BigInt(i);
  const addressesOf = (i) => [address(i + 1), address(i + 2), address(i + 3)];

  const entry = (spec, k, index) => ({
    ...Object.fromEntries((spec.counts ?? []).map((field) => [field, k + 1 + index])),
    ...Object.fromEntries((spec.amounts ?? []).map((field) => [field, (BIG * BigInt(k + 1 + index)).toString()])),
    ...Object.fromEntries((spec.constants ?? []).map((field) => [field, CONSTANTS[field]])),
  });
  function familyMetrics(name, k) {
    const spec = FAMILY_WINDOWS[name];
    return Object.fromEntries(FAMILY_FIELDS[name].map((field) => {
      if (spec.counts?.includes(field)) return [field, k + 1];
      if (spec.amounts?.includes(field)) return [field, (BIG * BigInt(k + 1)).toString()];
      if (spec.constants?.includes(field)) return [field, CONSTANTS[field]];
      if (spec.tallies?.[field]) return [field, Object.fromEntries((TALLY_KEYS[field] ?? ['k']).map((key, index) => [key, entry(spec.tallies[field], k, index)]))];
      if (spec.lists?.[field]) return [field, [entry(spec.lists[field], k, 0)]];
      return [field, 50 + k]; // per-hour unique counts
    }));
  }
  // overrides: family fields replaced for this hour (projection fixtures reconcile with them); projections: the hour's
  // projection set, omitted entirely when undefined (an hour stored without projections).
  function hourResult(i, { unavailable = {}, pools = [], overrides = {}, projections = undefined } = {}) {
    const hourStart = BASE + i * HOUR;
    const firstBlock = firstBlockOf(i);
    const lastBlock = firstBlock + blocksOf(i) - 1;
    const addresses = addressesOf(i);
    const families = Object.fromEntries(Object.keys(FAMILY_FIELDS).map((name) => [name, unavailable[name]
      ? { status: 'unavailable', reason: unavailable[name], ...Object.fromEntries(FAMILY_FIELDS[name].map((field) => [field, null])) }
      : { status: 'available', ...familyMetrics(name, i) }]));
    for (const [name, values] of Object.entries(overrides)) if (families[name].status === 'available') Object.assign(families[name], values);
    return {
      definitionVersion: COMPACT_DEFINITION_VERSION,
      chainId: ARC_CHAIN_ID,
      range: { kind: 'hour', hourStart, hourEnd: hourStart + HOUR, startUtc: iso(hourStart), endUtc: iso(hourStart + HOUR), firstBlock, lastBlock,
        parentHash: hash(firstBlock - 1), firstHash: hash(firstBlock), lastHash: hash(lastBlock), firstTimestamp: hourStart, lastTimestamp: hourStart + 3599 },
      network: { status: 'available', blockCount: blocksOf(i), transactionCount: txOf(i), uniqueSenders: 2, uniqueRecipients: 2,
        uniqueActiveAddresses: addresses.length, gasUsedRaw: gasOf(i).toString(), averageTransactionsPerBlock: txOf(i) / blocksOf(i),
        transactionsPerSecond: txOf(i) / HOUR, internal: { deploymentAttempts: 7 } },
      families,
      complete: Object.values(families).every((family) => family.status === 'available'),
      activeAddresses: addresses,
      registry: { uniswapV3: families.uniswapV3.status === 'available' ? { through: lastBlock, throughHash: hash(lastBlock), created: pools } : null },
      ...(projections === undefined ? {} : { projections }),
    };
  }
  const pool = (i, n) => ({ address: address(0x9000 + n), createdBlock: firstBlockOf(i), createdLogIndex: n, createdTx: hash(0x7000 + n),
    token0: USDC, token1: EURC, fee: 500, tickSpacing: 10 });

  // count hours from BASE; options(i) customizes an hour. Returns the open writer so a test can keep writing.
  function buildDatabase(name, count, options = () => ({})) {
    const path = join(workdir, `${name}.sqlite`);
    const db = new DatabaseSync(path);
    const store = createCompactStore(db);
    store.extendRegistry({ kind: V3_POOL_KIND, fromBlock: 1, through: 999, throughHash: hash(999), previousThrough: null, created: [] });
    for (let i = 0; i < count; i++) store.commitHour(hourResult(i, options(i)));
    return { path, db, store };
  }
  const fileHash = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');
  const sum = (from, to, value) => Array.from({ length: to - from + 1 }, (_, j) => value(from + j)).reduce((a, b) => a + b);
  const sumBig = (from, to, value) => Array.from({ length: to - from + 1 }, (_, j) => value(from + j)).reduce((a, b) => a + b, 0n);
  const open = (path, extra = {}) => createCompactReadModel({ path, DatabaseSync, now: () => (BASE + 50 * HOUR + 600) * 1000, ...extra });

  // Main fixture: hours 0..49 (checkpoint 49). USDC unavailable at hour 40 (inside the current 24H, outside 6H and the
  // previous 24H). V3 pools created at hours 10 and 49.
  const main = buildDatabase('main', 50, (i) => ({ unavailable: i === 40 ? { usdc: 'malformed_usdc_transfer' } : {},
    pools: i === 10 ? [pool(10, 1)] : i === 49 ? [pool(49, 2)] : [] }));
  main.db.close();

  await test('read model: a compatible database opens read-only; summaries, timeseries and health never change the file', () => {
    const before = fileHash(main.path);
    const model = open(main.path);
    assert.deepEqual(model.health(), { status: 'ok', checkpointHour: iso(BASE + 49 * HOUR), verifiedThrough: iso(BASE + 50 * HOUR) });
    for (const window of Object.keys(SUMMARY_WINDOWS)) model.summary(window);
    for (const window of Object.keys(TIMESERIES_WINDOWS)) model.timeseries(window);
    model.checkpoint();
    model.repairCandidates({ fromHour: BASE, toHour: BASE + 49 * HOUR });
    model.close();
    assert.equal(fileHash(main.path), before);
    assert.equal(fetchCalls, 0);
  });

  await test('read model: 1H summary is the checkpoint hour, with exact network values and the hour-only uniques', () => {
    const model = open(main.path);
    const summary = model.summary('1h');
    model.close();
    assert.equal(summary.schema, SUMMARY_SCHEMA);
    assert.deepEqual(summary.chain, { id: 5042, name: 'Arc' });
    assert.deepEqual(summary.window, { key: '1h', hours: 1, start: iso(BASE + 49 * HOUR), end: iso(BASE + 50 * HOUR) });
    const network = summary.network;
    assert.equal(network.status, 'available');
    assert.equal(network.blocks, blocksOf(49));
    assert.equal(network.transactions, txOf(49));
    assert.equal(network.transactionsPerSecond, txOf(49) / 3600);
    assert.equal(network.averageTransactionsPerBlock, txOf(49) / blocksOf(49));
    assert.equal(network.gasUsedRaw, gasOf(49).toString());
    assert.deepEqual(network.uniqueActiveAddresses, { status: 'available', value: 3 });
    assert.equal(network.previous.transactions, txOf(48));
    assert.deepEqual(network.previous.uniqueActiveAddresses, { status: 'available', value: 3 });
    const v3 = summary.dex.uniswapV3;
    assert.equal(v3.status, 'available');
    assert.equal(v3.hourOnly.status, 'available');
    assert.equal(v3.hourOnly.values.uniqueTraders, 50 + 49);
    assert.equal(summary.assets.usdc.metrics.transferCount, 50);
  });

  await test('read model: 6H sums every hour, and unique active addresses are the exact union, not a sum', () => {
    const model = open(main.path);
    const { network, assets, crossChain } = model.summary('6h');
    model.close();
    assert.equal(network.blocks, sum(44, 49, blocksOf));
    assert.equal(network.transactions, sum(44, 49, txOf));
    assert.equal(network.transactionsPerSecond, sum(44, 49, txOf) / (6 * 3600));
    assert.equal(network.averageTransactionsPerBlock, sum(44, 49, txOf) / sum(44, 49, blocksOf));
    assert.equal(network.gasUsedRaw, sumBig(44, 49, gasOf).toString());
    // Hours 44..49 hold addresses 45..52: 8 distinct identities, while the hourly counts add up to 18.
    assert.deepEqual(network.uniqueActiveAddresses, { status: 'available', value: 8 });
    assert.notEqual(network.uniqueActiveAddresses.value, 18);
    assert.deepEqual(network.previous.uniqueActiveAddresses, { status: 'available', value: 8 }, 'previous 6H identities are still retained');
    assert.equal(assets.usdc.status, 'available');
    assert.equal(assets.usdc.metrics.transferCount, sum(44, 49, (i) => i + 1));
    assert.equal(assets.usdc.metrics.amountRaw, (BIG * BigInt(sum(44, 49, (i) => i + 1))).toString());
    assert.equal(crossChain.cctp.metrics.outboundAmountRaw, (BIG * BigInt(sum(44, 49, (i) => i + 1))).toString());
    assert.deepEqual(assets.usdc.hourOnly, { status: 'not_supported', reason: 'per_hour_unique', values: null });
  });

  await test('read model: one unavailable hour makes the whole 24H family window unavailable, never a partial or zero total', () => {
    const model = open(main.path);
    const summary = model.summary('24h');
    model.close();
    const usdc = summary.assets.usdc;
    assert.equal(usdc.status, 'unavailable');
    assert.equal(usdc.reason, 'family_hour_unavailable');
    assert.deepEqual(usdc.reasons, ['malformed_usdc_transfer']);
    assert.deepEqual(usdc.unavailableHours, [iso(BASE + 40 * HOUR)]);
    assert.equal(usdc.metrics, null);
    assert.deepEqual(summary.coverage.families.usdc, { status: 'unavailable', reasons: ['malformed_usdc_transfer'], unavailableHours: [iso(BASE + 40 * HOUR)] });
    assert.equal(usdc.previous.status, 'available', 'the previous 24H (hours 2..25) does not contain hour 40');
    assert.equal(summary.network.uniqueActiveAddresses.value, (49 - 26) + 3);
    assert.deepEqual(summary.network.previous.uniqueActiveAddresses, { status: 'not_supported', reason: 'identity_retention_exceeded', value: null });
    assert.equal(summary.network.previous.status, 'available');
    assert.equal(summary.network.previous.transactions, sum(2, 25, txOf));
    for (const family of [summary.dex.uniswapV3, summary.lending.morphoBlue, summary.crossChain.gateway]) assert.equal(family.status, 'available');
  });

  await test('read model: amounts stay exact decimal strings with their decimals; canonical USDC is 18, CCTP and Gateway are 6', () => {
    const model = open(main.path);
    const { assets, crossChain, lending } = model.summary('6h');
    model.close();
    const expected = (BIG * BigInt(sum(44, 49, (i) => i + 1))).toString();
    assert.equal(typeof assets.usdc.metrics.amountRaw, 'string');
    assert.ok(BigInt(expected) > BigInt(Number.MAX_SAFE_INTEGER));
    assert.equal(assets.usdc.metrics.rawDecimals, 18);
    assert.equal(assets.usdc.metrics.units.amountRaw.decimals, 18);
    assert.equal(crossChain.cctp.metrics.units.decimals, 6);
    assert.equal(crossChain.gateway.metrics.units.decimals, 6);
    assert.equal(crossChain.gateway.metrics.units.token, USDC);
    assert.equal(crossChain.gateway.metrics.inboundBySourceDomain['0'].amountRaw, expected);
    assert.deepEqual(crossChain.across.metrics.depositByToken[EURC].units, { symbol: 'EURC', decimals: 6, verified: true });
    assert.deepEqual(lending.morphoBlue.metrics.markets[MARKET].units.collateralToken, { symbol: 'cirBTC', decimals: 8, verified: true });
    assert.deepEqual(lending.morphoVaultsV2.metrics.vaults[VAULT].units.asset, { symbol: 'USDC', decimals: 6, verified: true });
    assert.equal(lending.aaveV4.metrics.reserves[`${SPOKE}:1`].decimals, 6);
    assert.equal(assets.verifiedAssets.metrics.items[0].decimals, 6);
  });

  await test('read model: no aggregate is invented: each family exposes exactly its persisted window fields', () => {
    const model = open(main.path);
    const summary = model.summary('6h');
    model.close();
    const families = { ...summary.assets, ...summary.dex, ...summary.lending, ...summary.crossChain };
    const names = { usdc: 'usdc', verifiedAssets: 'assets', uniswapV3: 'uniswapV3', uniswapV4: 'uniswapV4', aaveV4: 'aaveV4',
      morphoBlue: 'morphoBlue', morphoVaultsV2: 'morphoVaultsV2', cctp: 'cctp', gateway: 'gateway', across: 'across' };
    for (const [section, family] of Object.entries(names)) {
      const spec = FAMILY_WINDOWS[family];
      const allowed = new Set([...(spec.counts ?? []), ...(spec.amounts ?? []), ...(spec.constants ?? []), ...Object.keys(spec.tallies ?? {}),
        ...Object.keys(spec.lists ?? {}), 'units']);
      for (const key of Object.keys(families[section].metrics)) assert.ok(allowed.has(key), `${section}.${key} is not a persisted window field`);
    }
    const text = JSON.stringify(summary);
    for (const forbidden of ['successRate', 'successfulTransactions', 'failedTransactions', 'averageFee', 'totalFees', 'contractCreations',
      'deploymentAttempts', 'totalVolume', 'netFlow', 'tvl', 'apy', 'usd']) {
      assert.ok(!text.toLowerCase().includes(`"${forbidden.toLowerCase()}"`), `${forbidden} must not be served`);
    }
  });

  await test('read model: freshness is anchored to the checkpoint with a deterministic stale rule; coverage and definitions are exposed', () => {
    const fresh = open(main.path, { now: () => (BASE + 50 * HOUR + 600) * 1000 });
    const summary = fresh.summary('24h');
    fresh.close();
    assert.deepEqual(summary.freshness, { checkpointHour: iso(BASE + 49 * HOUR), verifiedThrough: iso(BASE + 50 * HOUR), checkpointBlock: firstBlockOf(50) - 1,
      latestCompleteHour: iso(BASE + 49 * HOUR), lagHours: 0, stale: false, staleRule: `lagHours >= ${STALE_LAG_HOURS}` });
    const late = open(main.path, { now: () => (BASE + 52 * HOUR + 600) * 1000 });
    assert.deepEqual([late.summary('24h').freshness.lagHours, late.summary('24h').freshness.stale], [2, true]);
    late.close();
    assert.deepEqual({ ...summary.coverage, families: undefined }, { firstStoredHour: iso(BASE), storedHours: 50, checkpointHour: iso(BASE + 49 * HOUR),
      verifiedThrough: iso(BASE + 50 * HOUR), checkpointBlock: firstBlockOf(50) - 1, families: undefined });
    assert.deepEqual(summary.definitions.families, FAMILY_VERSIONS);
    assert.equal(summary.definitions.hourDefinition, COMPACT_DEFINITION_VERSION);
    assert.deepEqual(summary.dex.officialV3Pools, { status: 'available', count: 2, throughBlock: firstBlockOf(50) - 1 });
    assert.ok(!JSON.stringify(summary).includes(workdir), 'no filesystem path is served');
  });

  await test('read model: insufficient committed hours give explicit insufficient_coverage, never a shorter window', () => {
    const small = buildDatabase('small', 3);
    small.db.close();
    const model = open(small.path);
    assert.equal(model.summary('1h').network.status, 'available');
    const six = model.summary('6h');
    assert.equal(six.network.status, 'unavailable');
    assert.equal(six.network.reason, 'insufficient_coverage');
    assert.equal(six.network.transactions, null);
    assert.equal(six.network.uniqueActiveAddresses.status, 'unavailable');
    for (const family of [six.assets.usdc, six.dex.uniswapV4, six.crossChain.cctp]) {
      assert.equal(family.status, 'unavailable');
      assert.deepEqual(family.reasons, ['insufficient_coverage']);
      assert.equal(family.metrics, null);
    }
    const series = model.timeseries('6h');
    assert.deepEqual(series.buckets.map((bucket) => bucket.status), ['not_stored', 'not_stored', 'not_stored', 'committed', 'committed', 'committed']);
    assert.equal(series.buckets[0].network, null);
    model.close();
  });

  await test('read model: timeseries holds one bucket per hour with scalar fields only; an unavailable hour stays a gap', () => {
    const model = open(main.path);
    const series = model.timeseries('24h');
    model.close();
    assert.equal(series.schema, TIMESERIES_SCHEMA);
    assert.equal(series.buckets.length, 24);
    assert.deepEqual(series.buckets.map((bucket) => bucket.start), Array.from({ length: 24 }, (_, j) => iso(BASE + (26 + j) * HOUR)));
    const gap = series.buckets.find((bucket) => bucket.start === iso(BASE + 40 * HOUR));
    assert.deepEqual(gap.families.usdc, { status: 'unavailable', reason: 'malformed_usdc_transfer' });
    const last = series.buckets.at(-1);
    assert.equal(last.network.uniqueActiveAddresses, 3);
    assert.equal(last.network.gasUsedRaw, gasOf(49).toString());
    assert.equal(last.families.usdc.transferCount, 50);
    assert.equal(last.families.assets, undefined, 'list-only families are not charted');
    for (const value of Object.values(last.families.morphoBlue)) assert.notEqual(typeof value, 'object', 'no breakdown objects in buckets');
    assert.ok(Buffer.byteLength(JSON.stringify(series)) < 256 * 1024);
  });

  await test('read model: a family row missing for a stored hour is family_not_processed and a repair candidate', () => {
    const fixture = buildDatabase('missing-row', 8);
    fixture.db.exec(`DELETE FROM compact_family_hours WHERE hour_start = ${BASE + 7 * HOUR} AND family = 'gateway'`);
    fixture.db.close();
    const model = open(fixture.path);
    const gateway = model.summary('1h').crossChain.gateway;
    assert.equal(gateway.status, 'unavailable');
    assert.deepEqual(gateway.reasons, ['family_not_processed']);
    assert.deepEqual(model.repairCandidates({ fromHour: BASE, toHour: BASE + 7 * HOUR }), [BASE + 7 * HOUR]);
    model.close();
    const mainModel = open(main.path);
    assert.deepEqual(mainModel.repairCandidates({ fromHour: BASE + 26 * HOUR, toHour: BASE + 49 * HOUR }), [BASE + 40 * HOUR]);
    mainModel.close();
  });

  await test('read model: incompatible schema or family definitions fail closed; a missing family version is not ready', () => {
    const cases = [
      ["UPDATE compact_meta SET value = '3' WHERE key = 'schema_version'", 'incompatible', 'schema_version_mismatch'],
      ["UPDATE compact_meta SET value = 'other' WHERE key = 'family_version:cctp'", 'incompatible', 'family_definition_mismatch'],
      ["INSERT INTO compact_meta (key, value) VALUES ('family_version:legacy', 'v0')", 'incompatible', 'family_unknown'],
      ["DELETE FROM compact_meta WHERE key = 'family_version:across'", 'not_ready', 'family_version_missing'],
      ['DROP TABLE compact_registry_coverage', 'incompatible', 'schema_tables_mismatch'],
    ];
    for (const [statement, code, detail] of cases) {
      const fixture = buildDatabase(`meta-${detail}`, 2);
      fixture.db.exec(statement);
      fixture.db.close();
      const model = open(fixture.path);
      for (const read of [() => model.health(), () => model.summary('1h'), () => model.timeseries('6h')]) {
        assert.throws(read, (error) => error instanceof ReadModelError && error.code === code && error.detail === detail, statement);
      }
      model.close();
    }
    const missing = open(join(workdir, 'absent.sqlite'));
    assert.throws(() => missing.health(), (error) => error.code === 'not_ready' && error.detail === 'database_missing');
    assert.equal(missing.checkpoint(), null);
    assert.throws(() => open(main.path).summary('48h'), (error) => error.code === 'unsupported_window');
  });

  await test('consistency: a reader sees the old committed snapshot while a writer transaction is open, and the new one only after commit', () => {
    const fixture = buildDatabase('consistency', 6);
    const model = open(fixture.path);
    assert.equal(model.summary('1h').freshness.checkpointHour, iso(BASE + 5 * HOUR));
    let inside = null;
    fixture.store.commitHour(hourResult(6), { beforeCommit: () => {
      inside = { six: model.summary('6h'), health: model.health(), series: model.timeseries('6h'), checkpoint: model.checkpoint() };
    } });
    assert.equal(inside.six.freshness.checkpointHour, iso(BASE + 5 * HOUR));
    assert.equal(inside.six.network.transactions, sum(0, 5, txOf));
    assert.equal(inside.health.checkpointHour, iso(BASE + 5 * HOUR));
    assert.equal(inside.series.buckets.at(-1).start, iso(BASE + 5 * HOUR));
    assert.equal(inside.checkpoint.hourStart, BASE + 5 * HOUR);
    const after = model.summary('6h');
    assert.equal(after.freshness.checkpointHour, iso(BASE + 6 * HOUR), 'a commit invalidates the cache through data_version');
    assert.equal(after.network.transactions, sum(1, 6, txOf));
    model.close();
    fixture.db.close();
  });

  await test('consistency: a commit in the middle of a request never mixes into that request\'s snapshot', () => {
    const fixture = buildDatabase('mid-snapshot', 7);
    let armed = false;
    const model = open(fixture.path, { onSnapshotStarted: () => {
      if (!armed) return;
      armed = false;
      fixture.store.commitHour(hourResult(7)); // another connection commits hour 7 while this snapshot is open
    } });
    armed = true;
    const summary = model.summary('24h');
    assert.equal(summary.freshness.checkpointHour, iso(BASE + 6 * HOUR), 'the snapshot began before the commit');
    assert.equal(summary.coverage.storedHours, 7);
    assert.equal(summary.network.status, 'unavailable', 'hours 0..6 cannot fill 24H');
    const oneHour = model.summary('1h');
    assert.equal(oneHour.freshness.checkpointHour, iso(BASE + 7 * HOUR));
    assert.equal(oneHour.assets.usdc.metrics.transferCount, 8, 'hour 7 rows belong to the hour-7 snapshot');
    model.close();
    fixture.db.close();
  });

  await test('scheduler + read model: catch-up follows the real SQLite checkpoint hour by hour and the API sees each commit', async () => {
    const fixture = buildDatabase('scheduler', 8); // hours 0..7
    const model = open(fixture.path);
    const started = [];
    const runHour = (hour) => {
      const hourStart = Date.parse(hour) / 1000;
      started.push(hourStart);
      fixture.store.commitHour(hourResult((hourStart - BASE) / HOUR)); // a writer committing exactly like the runner
      return { hour, done: Promise.resolve({ exitCode: 0, signal: null, error: null, startedAt: 0, finishedAt: 0 }), terminate: async () => {} };
    };
    const scheduler = createScheduler({ readModel: model, runHour, now: () => (BASE + 12 * HOUR + 360) * 1000, setTimer: () => null, clearTimer: () => {} });
    await scheduler.tick();
    assert.deepEqual(started, [8, 9, 10, 11].map((hour) => BASE + hour * HOUR));
    assert.equal(model.checkpoint().hourStart, BASE + 11 * HOUR);
    assert.equal(model.summary('1h').freshness.checkpointHour, iso(BASE + 11 * HOUR));
    await scheduler.stop();
    model.close();
    fixture.db.close();
  });

  await test('http + read model: real summaries over HTTP, 304 revalidation, and fatal handling of an incompatible database', async () => {
    const model = open(main.path);
    await withServer({ readModel: model }, async (port) => {
      const health = await send(port, { path: '/health' });
      assert.equal(health.status, 200);
      assert.ok(Buffer.byteLength(health.text) < 200, 'health stays tiny');
      for (const path of VALID.filter((path) => path !== '/health')) {
        const res = await send(port, { path });
        assert.equal(res.status, 200, path);
        assert.ok(Buffer.byteLength(res.text) <= MAX_RESPONSE_BYTES, path);
        const revalidated = await send(port, { path, headers: { 'if-none-match': res.headers.etag } });
        assert.equal(revalidated.status, 304, path);
      }
    });
    model.close();
    const broken = buildDatabase('broken', 2);
    broken.db.exec("UPDATE compact_meta SET value = '9' WHERE key = 'schema_version'");
    broken.db.close();
    let fatal = 0;
    const brokenModel = open(broken.path);
    await withServer({ readModel: brokenModel, onFatal: () => { fatal += 1; } }, async (port) => {
      const res = await send(port, { path: '/health' });
      assert.equal(res.status, 503);
      assert.equal(res.text, '{"error":"unavailable"}');
    });
    brokenModel.close();
    assert.equal(fatal, 1);
    assert.equal(fetchCalls, 0);
  });

  // -------------------------------------------------------------------------------------------------------------------
  // Pools (pools.v1) and recent activity (activity.v1) over the Phase 1A projection tables.
  // Fixture: hours 0..25 (checkpoint 25, 24H = hours 2..25). Twelve V3 pools (USDC/EURC) created at hour 0 swap n times
  // per hour (pool n); pool C (USDC/unknown token) is created at hour 20 and swaps 100 times per hour from then on. V4: pool X
  // (native USDC/EURC) and the hooked pool Y (USDC/unknown) are initialized at hour 0, pool Z (USDC/cirBTC) at hour 21.
  // Activity rows exist in hours 24 and 25 (25 per hour).
  const ZERO = `0x${'0'.repeat(40)}`;
  const UNKNOWN = '0xabcdef0123456789abcdef0123456789abcd1234';
  const HOOKS = address(0x4000);
  const V3_POOLS = Array.from({ length: 12 }, (_, index) => address(0x9100 + index + 1));
  const POOL_C = address(0x9200);
  const V4_KEYS = [
    { currency0: ZERO, currency1: EURC, fee: 500, tickSpacing: 10, hooks: ZERO },
    { currency0: USDC, currency1: UNKNOWN, fee: 3000, tickSpacing: 60, hooks: HOOKS },
    { currency0: USDC, currency1: CIRBTC, fee: 100, tickSpacing: 1, hooks: ZERO },
  ];
  const [POOL_X, POOL_Y, POOL_Z] = V4_KEYS.map(v4PoolIdOf);
  const v3Created = (pool, i, n, token1 = EURC) => ({ address: pool, createdBlock: firstBlockOf(i), createdLogIndex: n, createdTx: hash(0x7100 + i * 100 + n),
    token0: USDC, token1, fee: 500, tickSpacing: 10 });
  const v4Created = (keyIndex, i, n) => ({ poolId: v4PoolIdOf(V4_KEYS[keyIndex]), createdBlock: firstBlockOf(i), createdLogIndex: n,
    createdTx: hash(0x7300 + i * 100 + n), ...V4_KEYS[keyIndex] });
  const v3Row = (pool, swapCount, flows, liquidity = [0n, 0n, 0n, 0n], counts = [0, 0, 0]) => ({ pool, swapCount, token0InRaw: flows[0].toString(),
    token0OutRaw: flows[1].toString(), token1InRaw: flows[2].toString(), token1OutRaw: flows[3].toString(), addCount: counts[0], removeCount: counts[1],
    pokeCount: counts[2], addAmount0Raw: liquidity[0].toString(), addAmount1Raw: liquidity[1].toString(), removeAmount0Raw: liquidity[2].toString(),
    removeAmount1Raw: liquidity[3].toString() });
  const v4Row = (pool, swapCount, flows, addCount = 0) => ({ pool, swapCount, token0InRaw: flows[0].toString(), token0OutRaw: flows[1].toString(),
    token1InRaw: flows[2].toString(), token1OutRaw: flows[3].toString(), addCount, removeCount: 0, pokeCount: 0, addAmount0Raw: null, addAmount1Raw: null,
    removeAmount0Raw: null, removeAmount1Raw: null });
  // Activity of one hour: k 0..19 swaps (even V3 on pool 12, odd V4 on X), 20..21 V3 adds, 22 V4 add, 23 V3 remove, 24 V4 remove.
  const txFromOf = (i, k) => address(0xf000 + i * 100 + k);
  function activityOf(i) {
    const hourStart = BASE + i * HOUR;
    return Array.from({ length: 25 }, (_, k) => {
      const base = { blockNumber: firstBlockOf(i) + Math.floor(k / 5), logIndex: k % 5, hourStart, blockTimestamp: hourStart + k,
        txHash: hash(0xaa000 + i * 100 + k), txFrom: txFromOf(i, k) };
      const v3Pool = V3_POOLS[11];
      if (k < 20 && k % 2 === 0) {
        return { ...base, protocol: 'uniswap_v3', kind: 'swap', pool: v3Pool, amount0Raw: String(k + 1), amount1Raw: `-${BIG * BigInt(k + 1)}`,
          amountBasis: 'v3_pool_delta', counterparty: address(0xe000 + k), counterpartyKind: 'swap_recipient' };
      }
      if (k < 20) {
        return { ...base, protocol: 'uniswap_v4', kind: 'swap', pool: POOL_X, amount0Raw: `-${k}`, amount1Raw: String(BIG), amountBasis: 'v4_swap_delta',
          counterparty: null, counterpartyKind: 'none' };
      }
      if (k === 22 || k === 24) {
        return { ...base, protocol: 'uniswap_v4', kind: k === 22 ? 'add' : 'remove', pool: POOL_X, amount0Raw: null, amount1Raw: null, amountBasis: 'none',
          counterparty: address(0xc000 + k), counterpartyKind: 'event_sender' };
      }
      return { ...base, protocol: 'uniswap_v3', kind: k === 23 ? 'remove' : 'add', pool: v3Pool, amount0Raw: '5', amount1Raw: '6',
        amountBasis: 'v3_liquidity_amount', counterparty: address(0xd000 + k), counterpartyKind: 'liquidity_owner' };
    });
  }
  // One projection hour that reconciles exactly with its (overridden) Uniswap family counters.
  function projectionHour(i) {
    const v3Rows = V3_POOLS.map((pool, index) => {
      const n = BigInt(index + 1);
      return index === 11
        ? v3Row(pool, 12, [BIG * n, n, 0n, BIG * n * 2n], [BIG, BIG * 2n, 3n, 4n], [1, 1, 1])
        : v3Row(pool, index + 1, [BIG * n, n, 0n, BIG * n * 2n]);
    });
    if (i >= 20) v3Rows.push(v3Row(POOL_C, 100, [1n, 0n, 0n, 1n]));
    const registry = i === 0 ? [v4Created(0, 0, 0), v4Created(1, 0, 1)] : i === 21 ? [v4Created(2, 21, 0)] : [];
    const v4Rows = [v4Row(POOL_X, 3, [7n, 0n, 0n, BIG], 1), v4Row(POOL_Y, 1, [0n, 1n, 1n, 0n]), ...(i >= 21 ? [v4Row(POOL_Z, 2, [2n, 0n, 0n, 2n])] : [])];
    return {
      pools: i === 0 ? V3_POOLS.map((pool, n) => v3Created(pool, 0, n)) : i === 20 ? [v3Created(POOL_C, 20, 0, UNKNOWN)] : [],
      overrides: { uniswapV3: { swapCount: 78 + (i >= 20 ? 100 : 0), mintCount: 1, burnCount: 2 },
        uniswapV4: { swapCount: 4 + (i >= 21 ? 2 : 0), modifyLiquidityCount: 1, initializeCount: registry.length } },
      projections: { uniswap_v3_pools: { status: 'available', rows: v3Rows }, uniswap_v4_pools: { status: 'available', rows: v4Rows, registry },
        dex_activity: { status: 'available', rows: i >= 24 ? activityOf(i) : [] } },
    };
  }
  function buildProjectionDatabase(name, { count = 26, hour = projectionHour, v4Registry = true } = {}) {
    const path = join(workdir, `${name}.sqlite`);
    const db = new DatabaseSync(path);
    const store = createCompactStore(db);
    store.extendRegistry({ kind: V3_POOL_KIND, fromBlock: 1, through: 999, throughHash: hash(999), previousThrough: null, created: [] });
    if (v4Registry) store.extendV4Registry({ kind: V4_POOL_KIND, fromBlock: 1, through: 999, throughHash: hash(999), previousThrough: null, created: [] });
    for (let i = 0; i < count; i++) store.commitHour(hourResult(i, hour(i)));
    return { path, db, store };
  }
  const projected = buildProjectionDatabase('projections');
  projected.db.close();
  const openProjected = (path = projected.path) => open(path, { now: () => (BASE + 26 * HOUR + 600) * 1000 });
  const token = (address, symbol, decimals) => ({ address, symbol, decimals, verified: symbol !== null, native: false, contractMetadata: null });
  const NATIVE_USDC = { address: ZERO, symbol: 'USDC', decimals: 18, verified: true, native: true, contractMetadata: null };

  await test('read model pools: V3 24H ranks by summed swap count, top 10, exact BigInt flows, registry pair and V3 liquidity amounts', () => {
    const before = fileHash(projected.path);
    const model = openProjected();
    const v3 = model.pools('v3', '24h');
    model.close();
    assert.deepEqual([v3.schema, v3.chain, v3.protocol, v3.status, v3.reason, v3.reasons, v3.unavailableHours], [POOLS_SCHEMA, { id: 5042, name: 'Arc' },
      'v3', 'available', null, [], []]);
    assert.deepEqual(v3.window, { key: '24h', hours: 24, start: iso(BASE + 2 * HOUR), end: iso(BASE + 26 * HOUR) });
    // Every pool of this fixture has a USDC side, so every hour is valued from stored flows alone (no price needed).
    assert.deepEqual(v3.ranking, { by: 'swap_count', usdVolume: { status: 'available', reason: null, reasons: [] },
      liquidityUsd: { status: 'unavailable', reason: 'tvl_not_collected', asOfHour: iso(BASE + 25 * HOUR) } }, 'no liquidity snapshot in this fixture');
    assert.deepEqual([v3.poolsTracked, v3.newPools], [13, 1], 'all registry pools through the checkpoint; pool C was created inside the window');
    assert.deepEqual(v3.pools.map((row) => [row.pool, row.swapCount]), [[POOL_C, 600], ...[12, 11, 10, 9, 8, 7, 6, 5, 4].map((n) => [V3_POOLS[n - 1], 24 * n])],
      'at most 10 pools, ranked by summed swap count');
    const twelve = v3.pools[1];
    assert.deepEqual(twelve.flowsRaw, { token0In: (BIG * 12n * 24n).toString(), token0Out: '288', token1In: '0', token1Out: (BIG * 24n * 24n).toString() });
    assert.ok(BigInt(twelve.flowsRaw.token0In) > BigInt(Number.MAX_SAFE_INTEGER), 'exact beyond 2^53');
    assert.deepEqual(twelve.liquidityActivity, { addCount: 24, removeCount: 24, pokeCount: 24, amounts: { status: 'available',
      addAmount0Raw: (BIG * 24n).toString(), addAmount1Raw: (BIG * 48n).toString(), removeAmount0Raw: '72', removeAmount1Raw: '96' } });
    assert.deepEqual(twelve.usdVolume, { status: 'available', reason: null, usdMicros: (BIG * 288n + 288n).toString(), basis: 'usd_anchor' },
      'the USDC side of every swap (paid in plus paid out), exact, never both sides');
    assert.deepEqual(v3.pools[0].usdVolume, { status: 'available', reason: null, usdMicros: '6', basis: 'usd_anchor' }, 'pool C: six hours of one raw unit');
    assert.deepEqual(twelve.liquidityUsd, { status: 'unavailable', reason: 'tvl_not_collected', usdMicros: null, amount0Raw: null, amount1Raw: null,
      asOfBlock: null }, 'never filled from add or remove activity');
    assert.deepEqual({ ...twelve, flowsRaw: undefined, liquidityActivity: undefined, swapCount: undefined, usdVolume: undefined, liquidityUsd: undefined },
      { pool: V3_POOLS[11], createdBlock: firstBlockOf(0), token0: token(USDC, 'USDC', 6), token1: token(EURC, 'EURC', 6), fee: 500, tickSpacing: 10, hooks: null,
        flowsRaw: undefined, liquidityActivity: undefined, swapCount: undefined, usdVolume: undefined, liquidityUsd: undefined });
    assert.deepEqual(v3.pools[0].token1, token(UNKNOWN, null, null), 'an unknown token keeps its address, no symbol or decimals are guessed');
    const keys = [...JSON.stringify(v3.pools).matchAll(/"([^"]+)":/g)].map((match) => match[1]);
    assert.ok(!keys.some((key) => /usd|tvl|volume|price/i.test(key) && !['usdVolume', 'usdMicros', 'liquidityUsd'].includes(key)),
      'the only USD fields are the valued swap volume and the pool liquidity value; no other price field is produced');
    assert.ok(Buffer.byteLength(JSON.stringify(v3)) < MAX_RESPONSE_BYTES);
    assert.equal(fileHash(projected.path), before, 'reading never changes the file');
    assert.equal(fetchCalls, 0);
  });

  await test('read model pools: V4 keeps native USDC (18 decimals), hooks and PoolKey; V4 token amounts are not_supported', () => {
    const model = openProjected();
    const v4 = model.pools('v4', '24h');
    model.close();
    assert.deepEqual([v4.status, v4.poolsTracked, v4.newPools], ['available', 3, 1]);
    assert.deepEqual(v4.pools.map((row) => [row.pool, row.swapCount]), [[POOL_X, 72], [POOL_Y, 24], [POOL_Z, 10]]);
    const [x, y] = v4.pools;
    assert.deepEqual([x.token0, x.token1, x.fee, x.tickSpacing, x.hooks], [NATIVE_USDC, token(EURC, 'EURC', 6), 500, 10, ZERO]);
    assert.deepEqual([y.token1, y.hooks], [token(UNKNOWN, null, null), HOOKS], 'hooked pools keep their hooks');
    assert.deepEqual(x.flowsRaw, { token0In: '168', token0Out: '0', token1In: '0', token1Out: (BIG * 24n).toString() });
    assert.deepEqual(x.liquidityActivity, { addCount: 24, removeCount: 0, pokeCount: 0, amounts: { status: 'not_supported',
      reason: 'v4_token_amounts_unavailable', addAmount0Raw: null, addAmount1Raw: null, removeAmount0Raw: null, removeAmount1Raw: null } });
  });

  await test('read model activity: newest 25 rows, block DESC then log index DESC; real type filters; exact From and To semantics', () => {
    const model = openProjected();
    const feeds = Object.fromEntries(['all', 'swaps', 'adds', 'removes'].map((type) => [type, model.activity(type)]));
    model.close();
    for (const [type, feed] of Object.entries(feeds)) {
      assert.deepEqual([feed.schema, feed.type, feed.status, feed.reason, feed.limit], [ACTIVITY_SCHEMA, type, 'available', null, 25], type);
      for (let index = 1; index < feed.rows.length; index++) {
        const [previous, row] = [feed.rows[index - 1], feed.rows[index]];
        assert.ok(previous.blockNumber > row.blockNumber || (previous.blockNumber === row.blockNumber && previous.logIndex > row.logIndex), type);
      }
    }
    assert.equal(feeds.all.rows.length, 25);
    assert.ok(feeds.all.rows.every((row) => row.blockNumber >= firstBlockOf(25)), 'the newest hour first');
    assert.deepEqual([feeds.swaps.rows.length, feeds.adds.rows.length, feeds.removes.rows.length], [25, 6, 4]);
    assert.ok(feeds.swaps.rows.every((row) => row.kind === 'swap') && feeds.adds.rows.every((row) => row.kind === 'add')
      && feeds.removes.rows.every((row) => row.kind === 'remove'));
    const byKey = (k) => feeds.all.rows.find((row) => row.txHash === hash(0xaa000 + 25 * 100 + k));
    const v3Swap = byKey(0);
    assert.deepEqual(v3Swap, { time: iso(BASE + 25 * HOUR), blockNumber: firstBlockOf(25), logIndex: 0, txHash: hash(0xaa000 + 2500), protocol: 'uniswap_v3',
      kind: 'swap', pool: V3_POOLS[11], pair: { token0: token(USDC, 'USDC', 6), token1: token(EURC, 'EURC', 6), fee: 500, tickSpacing: 10, hooks: null },
      amounts: { status: 'available', basis: 'v3_pool_delta', amount0Raw: '1', amount1Raw: `-${BIG}` }, from: txFromOf(25, 0), to: address(0xe000),
      toKind: 'swap_recipient', toReason: null });
    const v4Swap = byKey(1);
    assert.equal(v4Swap.toReason, 'v4_swap_recipient_not_emitted_and_trace_unavailable', 'the exact blocker, never a fake recipient');
    assert.deepEqual([v4Swap.from, v4Swap.to, v4Swap.toKind, v4Swap.pair.token0, v4Swap.amounts], [txFromOf(25, 1), null, 'none', NATIVE_USDC,
      { status: 'available', basis: 'v4_swap_delta', amount0Raw: '-1', amount1Raw: String(BIG) }], 'a V4 swap has no recipient: To stays null');
    assert.deepEqual([byKey(20).to, byKey(20).toKind, byKey(20).amounts], [address(0xd000 + 20), 'liquidity_owner',
      { status: 'available', basis: 'v3_liquidity_amount', amount0Raw: '5', amount1Raw: '6' }]);
    assert.deepEqual([byKey(22).to, byKey(22).toKind, byKey(22).amounts], [address(0xc000 + 22), 'event_sender',
      { status: 'not_supported', reason: 'v4_token_amounts_unavailable', basis: 'none', amount0Raw: null, amount1Raw: null }]);
    for (const row of feeds.all.rows) assert.equal(row.from, txFromOf(25, Number(BigInt(row.txHash)) - (0xaa000 + 2500)), 'From is the stored transaction sender');
  });

  await test('read model pools and activity fail closed: a missing or unavailable projection hour, a registry gap, malformed metadata', () => {
    const tampered = (i) => {
      const spec = projectionHour(i);
      if (i === 10) spec.projections.uniswap_v3_pools.rows[0].swapCount += 1; // no longer reconciles: stored unavailable
      if (i === 12) delete spec.projections; // stored without any projection
      if (i === 25) spec.projections.dex_activity = { status: 'unavailable', reason: 'activity_spine_missing' };
      return spec;
    };
    const gaps = buildProjectionDatabase('projection-gaps', { hour: tampered });
    gaps.db.close();
    const model = openProjected(gaps.path);
    const v3 = model.pools('v3', '24h');
    assert.deepEqual([v3.status, v3.reason, v3.reasons, v3.unavailableHours, v3.pools, v3.poolsTracked],
      ['unavailable', 'projection_hour_unavailable', ['projection_not_processed', 'reconciliation_mismatch'], [iso(BASE + 10 * HOUR), iso(BASE + 12 * HOUR)], [], 13]);
    const v4 = model.pools('v4', '24h');
    assert.deepEqual([v4.status, v4.reason, v4.pools], ['unavailable', 'registry_behind_checkpoint', []], 'V4 coverage stops at the unprojected hour');
    assert.deepEqual([model.activity('all').status, model.activity('all').reason, model.activity('all').rows], ['unavailable', 'activity_spine_missing', []],
      'the checkpoint hour has no verified activity: the feed is unavailable, never an older list');
    model.close();
    const noV4 = buildProjectionDatabase('no-v4-registry', { v4Registry: false });
    noV4.db.close();
    const noV4Model = openProjected(noV4.path);
    assert.deepEqual([noV4Model.pools('v4', '24h').status, noV4Model.pools('v4', '24h').reason], ['unavailable', 'registry_missing']);
    noV4Model.close();
    const malformed = buildProjectionDatabase('malformed-registry');
    malformed.db.prepare("UPDATE compact_registry SET meta_json = '{\"token0\":\"usdc\"}' WHERE kind = 'uniswap_v3_pool' AND address = ?").run(POOL_C);
    malformed.db.close();
    const malformedModel = openProjected(malformed.path);
    assert.throws(() => malformedModel.pools('v3', '24h'), (error) => error.code === 'inconsistent_state' && error.detail === 'pool_registry_metadata_malformed');
    assert.equal(malformedModel.pools('v4', '24h').status, 'available', 'only the answer that needs the broken row fails');
    malformedModel.close();
    const smallFixture = buildDatabase('pools-small', 3);
    smallFixture.db.close();
    const small = open(smallFixture.path);
    assert.deepEqual([small.pools('v3', '24h').status, small.pools('v3', '24h').reason], ['unavailable', 'insufficient_coverage']);
    small.close();
    const direct = openProjected();
    for (const [read, code] of [[() => direct.pools('v2', '24h'), 'unsupported_protocol'], [() => direct.pools('v3', '6h'), 'unsupported_window'],
      [() => direct.pools('__proto__', '24h'), 'unsupported_protocol'], [() => direct.activity('mints'), 'unsupported_activity_type'],
      [() => direct.activity('constructor'), 'unsupported_activity_type'], [() => direct.activity(null), 'unsupported_activity_type']]) {
      assert.throws(read, (error) => error instanceof ReadModelError && error.code === code, code);
    }
    direct.close();
  });

  await test('read model: without the optional projection tables, health, summary and timeseries work and pools/activity are not ready', () => {
    const legacy = buildDatabase('legacy-no-projections', 26);
    legacy.db.exec('DROP TABLE compact_dex_activity; DROP TABLE compact_pool_hours; DROP TABLE compact_projection_hours;');
    legacy.db.close();
    const model = open(legacy.path, { now: () => (BASE + 26 * HOUR + 600) * 1000 });
    assert.equal(model.health().status, 'ok');
    assert.equal(model.summary('24h').network.status, 'available');
    assert.equal(model.timeseries('24h').buckets.length, 24);
    for (const protocol of ['v3', 'v4']) {
      const pools = model.pools(protocol, '24h');
      assert.deepEqual([pools.status, pools.reason, pools.reasons, pools.pools, pools.poolsTracked, pools.newPools],
        ['unavailable', 'projection_not_ready', ['projection_not_ready'], [], null, null], protocol);
    }
    assert.deepEqual([model.activity('all').status, model.activity('all').reason, model.activity('all').rows], ['unavailable', 'projection_not_ready', []]);
    model.close();
    // Tables present but nothing projected yet (the main fixture): every hour is reported, nothing is filled in.
    const main24 = open(main.path);
    const v3 = main24.pools('v3', '24h');
    assert.deepEqual([v3.status, v3.reason, v3.reasons, v3.unavailableHours.length, v3.pools], ['unavailable', 'projection_hour_unavailable',
      ['projection_not_processed'], 24, []]);
    assert.equal(main24.pools('v4', '24h').reason, 'registry_missing');
    assert.equal(main24.activity('swaps').reason, 'projection_not_processed');
    main24.close();
  });

  await test('http + read model: pools and activity over HTTP with 304 revalidation', async () => {
    const model = openProjected();
    await withServer({ readModel: model }, async (port) => {
      for (const path of VALID.filter((path) => path.startsWith('/v1/intelligence/activity?') || (path.startsWith('/v1/intelligence/pools?') && path.endsWith('window=24h')))) {
        const res = await send(port, { path });
        assert.equal(res.status, 200, path);
        assert.equal(res.json.status, 'available', path);
        assert.ok(Buffer.byteLength(res.text) <= MAX_RESPONSE_BYTES, path);
        assert.equal((await send(port, { path, headers: { 'if-none-match': res.headers.etag } })).status, 304, path);
      }
      assert.equal((await send(port, { path: '/v1/intelligence/pools?protocol=v3&window=24h' })).json.pools.length, 10);
      assert.equal((await send(port, { path: '/v1/intelligence/activity?type=adds' })).json.rows.length, 6);
    });
    model.close();
    assert.equal(fetchCalls, 0);
  });

  rmSync(workdir, { recursive: true, force: true });
}

console.log(`\nCompact Intelligence API checks: ${passed} passed (node:sqlite ${sqlite ? 'tested' : 'deferred'})`);
