// Arc Intelligence dashboard: deterministic checks of (1) the Vercel /api/intelligence proxy against the compact
// Intelligence API contract, (2) the read-only Vercel /api/borrow-markets proxy for the Borrow card, and (3) the dashboard
// UI scope contract (src/config/arcIntelligenceUiScope.ts), rendered with
// React server rendering across every data state. Upstream calls go to fetch doubles, except one end-to-end check against
// the real compact HTTP server on 127.0.0.1. No external network.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import Module, { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import handler from '../api/intelligence.js';
import borrowHandler from '../api/borrow-markets.js';
import { BORROW_CACHE_CONTROL, BORROW_COLLATERAL_ASSET, BORROW_LOAN_ASSET, BORROW_MARKETS_SCHEMA as PROXY_BORROW_SCHEMA,
  BORROW_MARKETS_UPSTREAM_URL, compatibleBorrowMarkets, handleBorrowMarketsProxy, normalizeBorrowMarketsPage } from '../api/_lib/borrow-markets-proxy.js';
import { ARC_VERIFIED_ASSETS } from '../api/_lib/arc-intelligence/assets.js';
import { ACTIVITY_SCHEMA, DATA_CACHE_CONTROL, ECOSYSTEM_SCHEMA, NO_STORE, POOLS_SCHEMA, resolveIntelligenceRoute, SUMMARY_SCHEMA, TIMESERIES_SCHEMA } from '../api/_lib/intelligence-proxy.js';
import { ECOSYSTEM_SCHEMA as BACKEND_ECOSYSTEM_SCHEMA } from '../server/compact/intelligence-registry.js';
import { createIntelligenceServer } from '../server/compact/http.js';
import { ACTIVITY_SCHEMA as BACKEND_ACTIVITY_SCHEMA, POOLS_SCHEMA as BACKEND_POOLS_SCHEMA, SUMMARY_SCHEMA as BACKEND_SUMMARY_SCHEMA,
  TIMESERIES_SCHEMA as BACKEND_TIMESERIES_SCHEMA } from '../server/compact/read-model.js';

const tests = [];
async function test(name, work) {
  if (process.env.ARC_DASHBOARD_TEST_FILTER && !name.includes(process.env.ARC_DASHBOARD_TEST_FILTER)) return;
  await work();
  tests.push(name);
  console.log(`PASS ${name}`);
}

const ORIGIN = 'https://machina-intelligence-production.up.railway.app';
const UNAVAILABLE = '{"error":"Arc Intelligence is temporarily unavailable"}';
const MAPPING = [
  [{ view: 'health' }, '/health'],
  [{ view: 'summary', window: '1h' }, '/v1/intelligence/summary?window=1h'],
  [{ view: 'summary', window: '6h' }, '/v1/intelligence/summary?window=6h'],
  [{ view: 'summary', window: '24h' }, '/v1/intelligence/summary?window=24h'],
  [{ view: 'timeseries', window: '6h' }, '/v1/intelligence/timeseries?window=6h'],
  [{ view: 'timeseries', window: '24h' }, '/v1/intelligence/timeseries?window=24h'],
  [{ view: 'pools', protocol: 'v3', window: '24h' }, '/v1/intelligence/pools?protocol=v3&window=24h'],
  [{ view: 'pools', protocol: 'v4', window: '24h' }, '/v1/intelligence/pools?protocol=v4&window=24h'],
  [{ view: 'activity', type: 'all' }, '/v1/intelligence/activity?type=all'],
  [{ view: 'activity', type: 'swaps' }, '/v1/intelligence/activity?type=swaps'],
  [{ view: 'activity', type: 'adds' }, '/v1/intelligence/activity?type=adds'],
  [{ view: 'activity', type: 'removes' }, '/v1/intelligence/activity?type=removes'],
  [{ view: 'summary', window: '7d' }, '/v1/intelligence/summary?window=7d'],
  [{ view: 'summary', window: '30d' }, '/v1/intelligence/summary?window=30d'],
  [{ view: 'timeseries', window: '7d' }, '/v1/intelligence/timeseries?window=7d'],
  [{ view: 'timeseries', window: '30d' }, '/v1/intelligence/timeseries?window=30d'],
  [{ view: 'pools', protocol: 'v3', window: '7d' }, '/v1/intelligence/pools?protocol=v3&window=7d'],
  [{ view: 'pools', protocol: 'v3', window: '30d' }, '/v1/intelligence/pools?protocol=v3&window=30d'],
  [{ view: 'pools', protocol: 'v4', window: '7d' }, '/v1/intelligence/pools?protocol=v4&window=7d'],
  [{ view: 'pools', protocol: 'v4', window: '30d' }, '/v1/intelligence/pools?protocol=v4&window=30d'],
  [{ view: 'ecosystem', window: '24h' }, '/v1/intelligence/ecosystem?window=24h'],
  [{ view: 'ecosystem', window: '7d' }, '/v1/intelligence/ecosystem?window=7d'],
  [{ view: 'ecosystem', window: '30d' }, '/v1/intelligence/ecosystem?window=30d'],
];
const ALLOWED_URLS = new Set(MAPPING.map(([, path]) => `${ORIGIN}${path}`));

function responseDouble() {
  const headers = new Map();
  return {
    statusCode: null,
    body: undefined,
    ended: false,
    setHeader(name, value) { headers.set(name.toLowerCase(), value); },
    status(code) { this.statusCode = code; return this; },
    send(body) { this.body = body; this.ended = true; return this; },
    end() { this.body = null; this.ended = true; return this; },
    header(name) { return headers.get(name.toLowerCase()); },
    headerNames() { return [...headers.keys()].sort(); },
    json() { return JSON.parse(this.body); },
  };
}

async function call(req) {
  const res = responseDouble();
  await handler({ headers: {}, query: {}, method: 'GET', ...req }, res);
  assert.equal(res.ended, true, 'every request gets exactly one response');
  return res;
}

// An upstream Response double. text() can be made to throw, to prove a 304 is never parsed.
function upstream({ status = 200, body = null, text = undefined, headers = {}, textThrows = false } = {}) {
  const lower = Object.fromEntries(Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value]));
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (name) => lower[name.toLowerCase()] ?? null },
    async text() {
      if (textThrows) throw new Error('the body of this response must not be read');
      return text ?? JSON.stringify(body);
    },
  };
}

const summaryBody = (window = '24h', extra = {}) => ({ schema: SUMMARY_SCHEMA, window: { key: window }, freshness: { stale: false }, ...extra });
const timeseriesBody = (window = '24h') => ({ schema: TIMESERIES_SCHEMA, window: { key: window }, buckets: [] });
const poolsBody = (protocol = 'v3', window = '24h') => ({ schema: POOLS_SCHEMA, protocol, window: { key: window }, status: 'available', pools: [] });
const activityBody = (type = 'all') => ({ schema: ACTIVITY_SCHEMA, type, status: 'available', limit: 25, rows: [] });
const ecosystemBody = (window = '24h') => ({ schema: ECOSYSTEM_SCHEMA, chain: { id: 5042 }, window: { key: window },
  coverage: { status: 'available' }, verifiedAssets: [], rwa: [], discoveredTokens: { rows: [] }, contractCandidates: { rows: [] },
  launches: { rows: [] }, exchangeFlows: { status: 'unavailable' }, otherProtocols: { status: 'unavailable' } });
const bodyFor = (query) => (query.view === 'health' ? { status: 'ok', checkpointHour: '2026-10-03T08:00:00.000Z' }
  : query.view === 'summary' ? summaryBody(query.window) : query.view === 'timeseries' ? timeseriesBody(query.window)
    : query.view === 'pools' ? poolsBody(query.protocol, query.window)
      : query.view === 'ecosystem' ? ecosystemBody(query.window) : activityBody(query.type));

async function withFetch(fetchDouble, work, env = {}) {
  const originalFetch = globalThis.fetch;
  const originalUrl = process.env.INTELLIGENCE_API_URL;
  const seen = [];
  globalThis.fetch = async (url, options) => { seen.push({ url, options }); return fetchDouble(url, options); };
  if ('INTELLIGENCE_API_URL' in env) process.env.INTELLIGENCE_API_URL = env.INTELLIGENCE_API_URL;
  else delete process.env.INTELLIGENCE_API_URL;
  try {
    await work(seen);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalUrl === undefined) delete process.env.INTELLIGENCE_API_URL;
    else process.env.INTELLIGENCE_API_URL = originalUrl;
  }
}

const noFetch = async () => { throw new Error('fetch must not run for a rejected request'); };

await test('the twenty-three exact requests map to twenty-three fixed upstream URLs and return the upstream body unchanged', async () => {
  await withFetch(async (url) => {
    const query = MAPPING.find(([, path]) => `${ORIGIN}${path}` === url)[0];
    return upstream({ body: bodyFor(query) });
  }, async (seen) => {
    for (const [query, path] of MAPPING) {
      const res = await call({ query });
      assert.equal(res.statusCode, 200, JSON.stringify(query));
      assert.equal(res.body, JSON.stringify(bodyFor(query)), 'body forwarded byte for byte');
      assert.equal(res.header('content-type'), 'application/json; charset=utf-8');
      assert.equal(seen.at(-1).url, `${ORIGIN}${path}`);
    }
    assert.ok(seen.every(({ options }) => options.method === 'GET' && options.headers.accept === 'application/json' && options.redirect === 'manual'));
    assert.equal(seen.length, 23);
  });
});

await test('7-10 obsolete and arbitrary views are rejected without any upstream call', async () => {
  await withFetch(noFetch, async () => {
    for (const view of ['latest', 'coverage', 'runtime', 'status', 'http://evil.example', '/health', '../health', 'Summary', 'summary ', '', 'health/']) {
      const res = await call({ query: { view } });
      assert.equal(res.statusCode, 400, view);
      assert.deepEqual(res.json(), { error: 'Unsupported intelligence request' });
      assert.equal(res.header('cache-control'), NO_STORE);
    }
    assert.equal((await call({ query: {} })).statusCode, 400, 'missing view');
  });
});

await test('11-13 extra, missing, repeated or unknown parameters and windows are rejected', async () => {
  await withFetch(noFetch, async () => {
    const rejected = [
      { view: 'health', window: '1h' }, { view: 'health', x: '1' }, { view: 'summary', window: '24h', path: '/x' },
      { view: 'summary', window: '24h', url: 'https://evil.example' }, { view: 'summary' }, { view: 'timeseries' },
      { view: 'summary', window: '2h' }, { view: 'summary', window: '48h' }, { view: 'summary', window: '24H' },
      { view: 'summary', window: '' }, { view: 'summary', window: '7D' }, { view: 'summary', window: '1w' }, { view: 'summary', window: '90d' },
      { view: 'summary', window: '24h ' }, { view: 'timeseries', window: '1h' }, { view: 'pools', protocol: 'v3', window: '30D' },
      { view: 'summary', window: "24h' OR 1=1--" }, { view: 'summary', window: '24h;DROP TABLE compact_hours' },
      { view: 'summary', window: '../../health' }, { view: 'summary', window: ['24h', '6h'] }, { view: ['summary', 'health'] },
      { view: 'timeseries', window: '1h' }, { view: 'timeseries', window: '24h', window2: '6h' },
      // pools: exactly protocol v3 or v4 and window 24h; activity: exactly one type
      { view: 'pools', protocol: 'v2', window: '24h' }, { view: 'pools', protocol: 'v3', window: '6h' }, { view: 'pools', protocol: 'v3' },
      { view: 'pools', window: '24h' }, { view: 'pools', protocol: 'v3', window: '24h', x: '1' }, { view: 'pools', protocol: ['v3', 'v4'], window: '24h' },
      { view: 'pools', protocol: 'v3', window: ['24h', '24h'] }, { view: 'pools', protocol: 'V3', window: '24h' }, { view: 'pools', protocol: 'v3', window: '24H' },
      { view: 'pools', protocol: '%76%33', window: '24h' }, { view: 'pools', protocol: 'v3&window=24h' }, { view: 'pools', protocol: 'v3 ', window: '24h' },
      { view: 'pools', protocol: '__proto__', window: '24h' }, { view: 'pools', protocol: 'v3', window: 'constructor' }, { view: 'pools', type: 'all' },
      { view: 'activity', type: 'mints' }, { view: 'activity', type: 'swap' }, { view: 'activity', type: 'Swaps' }, { view: 'activity', type: 'ALL' },
      { view: 'activity', type: ['all', 'swaps'] }, { view: 'activity', type: 'all', limit: '100' }, { view: 'activity' }, { view: 'activity', type: '' },
      { view: 'activity', type: '%61ll' }, { view: 'activity', window: '24h' }, { view: 'activity', type: 'toString' }, { view: 'activity', type: 'all', window: '24h' },
      { view: 'ecosystem' }, { view: 'ecosystem', window: '1h' }, { view: 'ecosystem', window: '6h' },
      { view: 'ecosystem', window: '7D' }, { view: 'ecosystem', window: ['24h', '7d'] },
      { view: 'ecosystem', window: '24h', url: 'https://evil.example' }, { view: 'ecosystem', window: '../../health' },
    ];
    for (const query of rejected) {
      const res = await call({ query });
      assert.equal(res.statusCode, 400, JSON.stringify(query));
    }
  });
});

await test('14-15 GET only, and request bodies are refused', async () => {
  await withFetch(noFetch, async () => {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']) {
      const res = await call({ method, query: { view: 'summary', window: '24h' } });
      assert.equal(res.statusCode, 405, method);
      assert.equal(res.header('allow'), 'GET');
    }
    assert.equal((await call({ query: { view: 'health' }, headers: { 'content-length': '2' } })).statusCode, 400);
    assert.equal((await call({ query: { view: 'health' }, headers: { 'transfer-encoding': 'chunked' } })).statusCode, 400);
  });
});

await test('16 invalid upstream origins are sanitized; a configured path is reduced to the origin', async () => {
  for (const INTELLIGENCE_API_URL of ['https://user:pass@example.internal', 'https://example.internal/?q=1', 'https://example.internal/#x',
    'ftp://example.internal', 'not a url']) {
    await withFetch(noFetch, async () => {
      const res = await call({ query: { view: 'health' } });
      assert.equal(res.statusCode, 503, INTELLIGENCE_API_URL);
      assert.equal(res.body, UNAVAILABLE);
    }, { INTELLIGENCE_API_URL });
  }
  await withFetch(async () => upstream({ body: summaryBody('6h') }), async (seen) => {
    await call({ query: { view: 'summary', window: '6h' } });
    assert.equal(seen[0].url, 'https://example.internal/v1/intelligence/summary?window=6h');
  }, { INTELLIGENCE_API_URL: 'https://example.internal/base/path' });
});

await test('17 network errors and timeouts become a sanitized 503', async () => {
  for (const failure of [new TypeError('fetch failed: getaddrinfo ENOTFOUND railway.internal at /srv/app.js:1'),
    Object.assign(new Error('The operation was aborted'), { name: 'AbortError' })]) {
    await withFetch(async () => { throw failure; }, async () => {
      const res = await call({ query: { view: 'summary', window: '24h' } });
      assert.equal(res.statusCode, 503);
      assert.equal(res.body, UNAVAILABLE);
      assert.equal(res.header('cache-control'), NO_STORE, 'errors are never cached');
    });
  }
});

await test('18-20 malformed, non-object and wrong-schema upstream bodies are a sanitized 502', async () => {
  const cases = [
    [{ view: 'summary', window: '24h' }, { text: '{"schema": "machina.intelligence.summary.v1", ' }],
    [{ view: 'summary', window: '24h' }, { text: '[]' }],
    [{ view: 'summary', window: '24h' }, { text: 'null' }],
    [{ view: 'summary', window: '24h' }, { text: '"ok"' }],
    [{ view: 'summary', window: '24h' }, { body: { schema: TIMESERIES_SCHEMA } }],
    [{ view: 'summary', window: '24h' }, { body: { schema: 'machina.intelligence.summary.v2' } }],
    [{ view: 'summary', window: '24h' }, { body: { window: { key: '24h' } } }],
    [{ view: 'timeseries', window: '6h' }, { body: { schema: SUMMARY_SCHEMA } }],
    [{ view: 'timeseries', window: '6h' }, { body: { buckets: [] } }],
    [{ view: 'health' }, { body: { status: 'degraded' } }],
    [{ view: 'health' }, { body: { checkpointHour: null } }],
    // a pools or activity body must also be the requested protocol, window or type
    [{ view: 'pools', protocol: 'v3', window: '24h' }, { body: poolsBody('v4') }],
    [{ view: 'pools', protocol: 'v4', window: '24h' }, { body: { ...poolsBody('v4'), window: { key: '6h' } } }],
    [{ view: 'activity', type: 'all' }, { body: activityBody('swaps') }],
    [{ view: 'activity', type: 'adds' }, { body: { ...activityBody('adds'), schema: 'machina.intelligence.activity.v2' } }],
    [{ view: 'summary', window: '24h' }, { text: `{"schema":"${SUMMARY_SCHEMA}","pad":"${'x'.repeat(600 * 1024)}"}` }],
  ];
  // Every route checks its own schema: each one gets every other route's valid body, and a body with no schema at all.
  for (const [query] of MAPPING) {
    const own = JSON.stringify(bodyFor(query));
    for (const [other] of MAPPING) {
      if (JSON.stringify(bodyFor(other)) !== own && bodyFor(other).schema !== bodyFor(query).schema) cases.push([query, { body: bodyFor(other) }]);
    }
    cases.push([query, { body: { window: { key: query.window ?? null } } }]);
  }
  for (const [query, reply] of cases) {
    await withFetch(async () => upstream(reply), async () => {
      const res = await call({ query });
      assert.equal(res.statusCode, 502, `${JSON.stringify(query)} ${String(reply.text ?? JSON.stringify(reply.body)).slice(0, 60)}`);
      assert.equal(res.body, UNAVAILABLE);
      assert.equal(res.header('etag'), undefined);
    });
  }
});

await test('error sanitization: upstream error bodies, statuses and redirects never leak', async () => {
  const leak = 'Error: SQLITE_BUSY at /data/arc-compact.sqlite (read-model.js:200) DATABASE_URL=postgres://secret';
  for (const [status, expected] of [[500, 503], [503, 503], [502, 503], [404, 502], [400, 502], [302, 502], [204, 502], [304, 502]]) {
    await withFetch(async () => upstream({ status, text: leak, headers: { location: 'https://evil.example', etag: '"abc"' } }), async () => {
      const res = await call({ query: { view: 'summary', window: '24h' } });
      assert.equal(res.statusCode, expected, String(status));
      assert.equal(res.body, UNAVAILABLE);
      assert.ok(!res.headerNames().includes('location'));
    });
  }
});

await test('21 a valid summary whose windows are unavailable (insufficient_coverage) passes through as HTTP 200', async () => {
  const insufficient = summaryBody('24h', {
    network: { status: 'unavailable', reason: 'insufficient_coverage', transactions: null },
    assets: { usdc: { status: 'unavailable', reason: 'insufficient_coverage', reasons: ['insufficient_coverage'], metrics: null } },
  });
  await withFetch(async () => upstream({ body: insufficient, headers: { etag: '"0123abcd"' } }), async () => {
    const res = await call({ query: { view: 'summary', window: '24h' } });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json(), insufficient);
    assert.equal(res.header('cache-control'), DATA_CACHE_CONTROL);
  });
});

await test('22-23 health is no-store; summary and timeseries use the CDN cache policy', async () => {
  assert.equal(DATA_CACHE_CONTROL, 'public, s-maxage=300, stale-while-revalidate=3300, stale-if-error=86400');
  await withFetch(async (url) => upstream({ body: bodyFor(MAPPING.find(([, path]) => `${ORIGIN}${path}` === url)[0]), headers: { etag: '"aa"' } }), async () => {
    for (const [query] of MAPPING) {
      const res = await call({ query });
      assert.equal(res.header('cache-control'), query.view === 'health' ? NO_STORE : DATA_CACHE_CONTROL, JSON.stringify(query));
      if (query.view === 'health') assert.equal(res.header('etag'), undefined, 'health never carries a validator');
    }
  });
});

await test('24-26 If-None-Match is forwarded for data views, an upstream 304 is a bodiless 304, and ETag is forwarded', async () => {
  const tag = '"9f86d081884c7d659a2feaa0c55ad015a3bf4f1b"';
  await withFetch(async (_url, options) => (options.headers['if-none-match'] === tag
    ? upstream({ status: 304, headers: { etag: tag }, textThrows: true })
    : upstream({ body: summaryBody('6h'), headers: { etag: tag } })), async (seen) => {
    const fresh = await call({ query: { view: 'summary', window: '6h' } });
    assert.equal(fresh.statusCode, 200);
    assert.equal(fresh.header('etag'), tag);
    assert.equal(seen[0].options.headers['if-none-match'], undefined);
    const revalidated = await call({ query: { view: 'summary', window: '6h' }, headers: { 'if-none-match': tag } });
    assert.equal(seen[1].options.headers['if-none-match'], tag);
    assert.equal(revalidated.statusCode, 304);
    assert.equal(revalidated.body, null, 'no body, nothing parsed');
    assert.equal(revalidated.header('etag'), tag);
    assert.equal(revalidated.header('cache-control'), DATA_CACHE_CONTROL);
    assert.equal(revalidated.header('content-type'), undefined);
  });
  await withFetch(async () => upstream({ body: { status: 'ok' } }), async (seen) => {
    await call({ query: { view: 'health' }, headers: { 'if-none-match': tag } });
    assert.equal(seen[0].options.headers['if-none-match'], undefined, 'health is never revalidated');
  });
  await withFetch(async () => upstream({ body: summaryBody('1h'), headers: { etag: 'unquoted\r\nset-cookie: a=b' } }), async (seen) => {
    for (const value of ['"a"\r\nx-evil: 1', 'abc', `"${'a'.repeat(200)}"`, '"a" junk']) {
      await call({ query: { view: 'summary', window: '1h' }, headers: { 'if-none-match': value } });
    }
    assert.ok(seen.every(({ options }) => options.headers['if-none-match'] === undefined), 'malformed validators are never forwarded');
    const res = await call({ query: { view: 'summary', window: '1h' } });
    assert.equal(res.header('etag'), undefined, 'a malformed upstream ETag is dropped');
  });
});

await test('27 no upstream header other than a well-formed ETag reaches the response', async () => {
  await withFetch(async () => upstream({ body: summaryBody('24h'), headers: { etag: '"aa"', 'set-cookie': 'session=1', 'x-powered-by': 'railway',
    'access-control-allow-origin': '*', server: 'railway-edge', 'content-type': 'text/html', 'cache-control': 'no-store', location: '/x' } }), async () => {
    const res = await call({ query: { view: 'summary', window: '24h' } });
    assert.deepEqual(res.headerNames(), ['cache-control', 'content-type', 'etag']);
    assert.equal(res.header('content-type'), 'application/json; charset=utf-8');
    assert.equal(res.header('cache-control'), DATA_CACHE_CONTROL);
  });
});

await test('28 no user input can alter the upstream origin or path', async () => {
  const hostile = [
    { view: 'summary', window: '24h', host: 'evil.example' }, { view: '//evil.example/health' }, { view: 'summary', window: '24h@evil.example' },
    { view: 'summary', window: '24h/../../admin' }, { view: 'summary', window: '24h?window=6h' }, { view: 'summary', window: '24h#' },
    { view: 'timeseries', window: '6h&view=health' }, { view: 'health?x=1' }, { view: 'summary', window: '%32%34h' },
    { view: 'pools', protocol: 'v3/../../health', window: '24h' }, { view: 'pools', protocol: 'v3', window: '24h@evil.example' },
    { view: 'activity', type: 'all&type=swaps' }, { view: 'activity', type: '//evil.example' },
    { view: 'ecosystem', window: '24h?window=7d' }, { view: 'ecosystem', window: '24h', host: 'evil.example' },
  ];
  await withFetch(async (url) => upstream({ body: bodyFor(MAPPING.find(([, path]) => `${ORIGIN}${path}` === url)?.[0] ?? { view: 'health' }) }), async (seen) => {
    for (const query of hostile) assert.equal((await call({ query })).statusCode, 400, JSON.stringify(query));
    for (const [query] of MAPPING) await call({ query, headers: { host: 'evil.example', 'x-forwarded-host': 'evil.example' } });
    assert.ok(seen.every(({ url }) => ALLOWED_URLS.has(url)), seen.map(({ url }) => url).join(' '));
    assert.equal(seen.length, MAPPING.length);
  });
  for (const query of [{ view: 'summary', window: 'constructor' }, { view: 'summary', window: '__proto__' }, { view: 'toString' }, { view: 'hasOwnProperty' },
    { view: 'pools', protocol: 'hasOwnProperty', window: '24h' }, { view: 'activity', type: '__proto__' }]) {
    assert.equal(resolveIntelligenceRoute(query), null, JSON.stringify(query));
  }
});

await test('contract: proxy schemas and upstream paths are exactly the compact backend\'s', async () => {
  assert.equal(SUMMARY_SCHEMA, BACKEND_SUMMARY_SCHEMA);
  assert.equal(TIMESERIES_SCHEMA, BACKEND_TIMESERIES_SCHEMA);
  assert.equal(POOLS_SCHEMA, BACKEND_POOLS_SCHEMA);
  assert.equal(ACTIVITY_SCHEMA, BACKEND_ACTIVITY_SCHEMA);
  assert.equal(ECOSYSTEM_SCHEMA, BACKEND_ECOSYSTEM_SCHEMA);
  const backend = await readFile(new URL('../server/compact/http.js', import.meta.url), 'utf8');
  const backendRoutes = [...backend.matchAll(/^ {2}\['(\/[^']+)'/gm)].map((match) => match[1]).sort();
  assert.deepEqual(backendRoutes, MAPPING.map(([, path]) => path).sort());
  const proxy = await readFile(new URL('../api/_lib/intelligence-proxy.js', import.meta.url), 'utf8');
  assert.match(proxy, /url = `\$\{upstreamOrigin\(env\)\}\$\{route\.path\}`/);
  // The accepted ecosystem table expands three literal windows at module initialization, before any request exists.
  // Exempt only this exact fixed construction; the general ban on request-input interpolation still covers all other code.
  const fixedEcosystemPaths = "ecosystem: Object.freeze(Object.fromEntries(['24h', '7d', '30d'].map((window) => [window, Object.freeze({\n"
    + '    path: `/v1/intelligence/ecosystem?window=${window}`,';
  const assertProxySafety = (source) => {
    assert.equal(source.split(fixedEcosystemPaths).length, 2, 'exactly one literal ecosystem window construction');
    assert.doesNotMatch(source.replace(fixedEcosystemPaths, ''), /\$\{(query|view|window|protocol|type)\b/,
      'no user input is interpolated into a URL');
  };
  assertProxySafety(proxy);
  assert.throws(() => assertProxySafety(proxy.replace("['24h', '7d', '30d'].map", '[query.window].map')));
  assert.throws(() => assertProxySafety(proxy.replace('${route.path}', '${query.window}')));
});

await test('end to end: the real compact HTTP server behind the proxy gives 200, then 304 for the same ETag', async () => {
  const readModel = {
    health: () => ({ status: 'ok', checkpointHour: '2026-10-03T08:00:00.000Z', verifiedThrough: '2026-10-03T09:00:00.000Z' }),
    summary: (window) => summaryBody(window, { network: { status: 'unavailable', reason: 'insufficient_coverage' } }),
    timeseries: (window) => timeseriesBody(window),
    pools: (protocol, window) => ({ ...poolsBody(protocol), window: { key: window } }),
    activity: (type) => activityBody(type),
    ecosystem: (window) => ecosystemBody(window),
  };
  const server = createIntelligenceServer({ readModel });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const originalUrl = process.env.INTELLIGENCE_API_URL;
  process.env.INTELLIGENCE_API_URL = origin;
  try {
    for (const [query] of MAPPING) assert.equal((await call({ query })).statusCode, 200, JSON.stringify(query));
    const first = await call({ query: { view: 'summary', window: '24h' } });
    assert.match(first.header('etag'), /^"[0-9a-f]{40}"$/);
    assert.equal(first.json().network.reason, 'insufficient_coverage');
    const second = await call({ query: { view: 'summary', window: '24h' }, headers: { 'if-none-match': first.header('etag') } });
    assert.equal(second.statusCode, 304);
    assert.equal(second.body, null);
  } finally {
    if (originalUrl === undefined) delete process.env.INTELLIGENCE_API_URL;
    else process.env.INTELLIGENCE_API_URL = originalUrl;
    server.closeAllConnections?.();
    await new Promise((done) => server.close(done));
  }
});

// ---------------------------------------------------------------------------------------------------------------------
// Dashboard UI scope contract. The TypeScript sources are transpiled in memory and rendered with react-dom/server.

const require = createRequire(import.meta.url);
const ts = require('typescript');
const COMPILER_OPTIONS = { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true, jsx: ts.JsxEmit.ReactJSX };
const compileInto = (loadedModule, source, filename) => {
  const { outputText } = ts.transpileModule(source, { compilerOptions: COMPILER_OPTIONS, fileName: filename });
  loadedModule._compile(outputText, filename);
};
require.extensions['.ts'] = (loadedModule, filename) => compileInto(loadedModule, readFileSync(filename, 'utf8'), filename);
require.extensions['.tsx'] = require.extensions['.ts'];

const sourcePath = (relative) => fileURLToPath(new URL(`../${relative}`, import.meta.url));
const COMPONENT_PATH = sourcePath('src/components/ArcIntelligenceOverview.tsx');
const LIB_PATH = sourcePath('src/lib/arcIntelligence.ts');
const SCOPE_PATH = sourcePath('src/config/arcIntelligenceUiScope.ts');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const scopeModule = require(SCOPE_PATH);
const lib = require(LIB_PATH);
const componentModule = require(COMPONENT_PATH);
const { ARC_INTELLIGENCE_UI_SCOPE: SCOPE, ARC_INTELLIGENCE_REMOVED_SCOPE } = scopeModule;
const STATUSES = ['available', 'collecting', 'unavailable', 'source_pending'];
const SECTION_IDS = ['network', 'volume-chart', 'active-addresses-chart', 'top-protocols', 'top-pools-v3', 'top-pools-v4',
  'recent-activity', 'assets', 'launches', 'borrow', 'lending', 'cross-chain', 'rwa-other'];
const LOWER_SECTIONS = ['assets', 'launches', 'borrow', 'lending', 'cross-chain', 'rwa-other'];
const BORROW_CONFIG_PATH = sourcePath('src/config/mainnetBorrow.ts');
const BORROW_LIB_PATH = sourcePath('src/lib/mainnetBorrow.ts');

// Evaluates a (possibly mutated) copy of a source file as its own module, resolving imports like the real file.
function loadMutated(filename, source) {
  const loadedModule = new Module(filename, null);
  loadedModule.filename = filename;
  loadedModule.paths = Module._nodeModulePaths(path.dirname(filename));
  compileInto(loadedModule, source, filename);
  return loadedModule.exports;
}

// Minimal parser for react-dom/server output (well formed, escaped), giving a tree with parents for scope checks.
const VOID_TAGS = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);
const decode = (text) => text.replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
function parseHtml(html) {
  const root = { tag: '#root', attrs: {}, children: [], parent: null };
  let node = root;
  const tokens = /<!--[\s\S]*?-->|<\/([a-zA-Z0-9-]+)\s*>|<([a-zA-Z0-9-]+)((?:\s+[^\s=/>]+(?:="[^"]*")?)*)\s*(\/?)>|([^<]+)/g;
  for (const match of html.matchAll(tokens)) {
    if (match[0].startsWith('<!--')) continue;
    if (match[1]) {
      assert.equal(node.tag, match[1].toLowerCase(), 'balanced markup');
      node = node.parent;
    } else if (match[2]) {
      const attrs = {};
      for (const attribute of match[3].matchAll(/([^\s=/>]+)(?:="([^"]*)")?/g)) attrs[attribute[1]] = decode(attribute[2] ?? '');
      const child = { tag: match[2].toLowerCase(), attrs, children: [], parent: node };
      node.children.push(child);
      if (!match[4] && !VOID_TAGS.has(child.tag)) node = child;
    } else {
      node.children.push({ tag: '#text', text: decode(match[5]), attrs: {}, children: [], parent: node });
    }
  }
  assert.equal(node, root, 'every element is closed');
  return root;
}
function* walk(node) {
  yield node;
  for (const child of node.children) yield* walk(child);
}
const textOf = (node) => (node.tag === '#text' ? node.text : node.children.map(textOf).join(' ')).replace(/\s+/g, ' ').trim();
const byAttr = (tree, name, value) => [...walk(tree)].filter((node) => node.attrs[name] !== undefined && (value === undefined || node.attrs[name] === value));
const item = (tree, id) => {
  const nodes = byAttr(tree, 'data-intel-item', id);
  assert.ok(nodes.length, `item ${id} rendered`);
  return nodes[0];
};

// The scope contract: every declared section and item is rendered, inside its own section, with a known status;
// nothing undeclared is rendered; a value attribute exists only for available data. Returns item id -> status.
function checkScope(tree, scope, { allowLoading = false } = {}) {
  const owner = new Map();
  for (const section of scope) {
    for (const entry of section.items) {
      if (owner.has(entry.id)) throw new Error(`duplicate item ${entry.id}`);
      owner.set(entry.id, section.id);
    }
  }
  const sectionIds = byAttr(tree, 'data-intel-section').map((node) => node.attrs['data-intel-section']);
  if (new Set(sectionIds).size !== sectionIds.length) throw new Error('duplicate section marker');
  for (const section of scope) if (!sectionIds.includes(section.id)) throw new Error(`section ${section.id} not rendered`);
  for (const id of sectionIds) if (!scope.some((section) => section.id === id)) throw new Error(`section ${id} not declared`);
  const statuses = new Map();
  for (const node of byAttr(tree, 'data-intel-item')) {
    const id = node.attrs['data-intel-item'];
    const status = node.attrs['data-intel-status'];
    if (!owner.has(id)) throw new Error(`item ${id} not declared`);
    let parent = node.parent;
    while (parent && parent.attrs['data-intel-section'] === undefined) parent = parent.parent;
    if (parent?.attrs['data-intel-section'] !== owner.get(id)) throw new Error(`item ${id} outside section ${owner.get(id)}`);
    if (!STATUSES.includes(status) && !(allowLoading && status === 'loading')) throw new Error(`item ${id} status ${status}`);
    if (statuses.has(id) && statuses.get(id) !== status) throw new Error(`item ${id} inconsistent status`);
    if (node.attrs['data-intel-value'] !== undefined && status !== 'available') throw new Error(`item ${id} value without data`);
    statuses.set(id, status);
  }
  for (const id of owner.keys()) if (!statuses.has(id)) throw new Error(`item ${id} not rendered`);
  return statuses;
}

function render(props, component = componentModule.ArcIntelligenceDashboard) {
  const errors = [];
  const original = console.error;
  console.error = (...args) => errors.push(args.join(' '));
  try {
    const html = renderToStaticMarkup(React.createElement(component, props));
    assert.deepEqual(errors, [], 'React renders without warnings');
    return { html, tree: parseHtml(html) };
  } finally {
    console.error = original;
  }
}

// Fixtures shaped exactly like summary.v1 / timeseries.v1 of server/compact/read-model.js.
const HOUR_MS = 3600_000;
const END = Date.parse('2026-10-03T14:00:00.000Z');
const isoAt = (ms) => new Date(ms).toISOString();
const WINDOW_RANGE = { start: isoAt(END - 24 * HOUR_MS), end: isoAt(END) };
const USDC = '0x3600000000000000000000000000000000000000';
const UNKNOWN_TOKEN = '0xabcdef0123456789abcdef0123456789abcd1234';
const USDC_UNITS = { token: USDC, symbol: 'USDC', decimals: 6, source: 'arc_usdc_erc20_interface', fields: [] };
const available = (metrics) => ({ status: 'available', ...WINDOW_RANGE, metrics, hourOnly: { status: 'not_supported', reason: 'per_hour_unique', values: null },
  previous: { status: 'available', metrics } });
const unavailableFamily = (reason = 'insufficient_coverage') => ({ status: 'unavailable', reason, reasons: [reason], unavailableHours: [], ...WINDOW_RANGE,
  metrics: null, previous: { status: 'unavailable', reason: 'insufficient_coverage', metrics: null } });
const freshness = { checkpointHour: isoAt(END - HOUR_MS), verifiedThrough: isoAt(END), checkpointBlock: 4_200_000, latestCompleteHour: isoAt(END - HOUR_MS),
  lagHours: 0, stale: false, staleRule: 'lagHours >= 2' };
const FAMILY_METRICS = {
  usdc: { transferCount: 5000, mintCount: 40, burnCount: 30, amountRaw: '1234567890123456789012345', rawDecimals: 18 },
  assets: { items: [
    { symbol: 'EURC', address: '0xbef5f6d51cb62b58e6a8f77868681825c6fe21c1', decimals: 6, transferCount: 321, mintCount: 4, burnCount: 2, amountRaw: '98765432100' },
    { symbol: 'WETH', address: '0x128cc466b61f542da60c70e3aa11c10e19b84edb', decimals: 18, transferCount: 17, mintCount: 0, burnCount: 0, amountRaw: '1500000000000000000' },
    { symbol: 'USYC', address: '0x8a5d989bbb96929f689b0200f435f53da42bf490', decimals: 6, transferCount: 12, mintCount: 3, burnCount: 1, amountRaw: '250000000' },
  ] },
  uniswapV3: { poolCreatedCount: 3, swapCount: 4321, mintCount: 120, burnCount: 80, foreignEventCount: 0 },
  uniswapV4: { initializeCount: 2, swapCount: 1234, modifyLiquidityCount: 56 },
  aaveV4: { supplyCount: 10, withdrawCount: 5, borrowCount: 7, repayCount: 3, liquidationCount: 1, reserves: {
    '1:1': { spoke: '0x1111111111111111111111111111111111111111', reserveId: 1, underlying: USDC, decimals: 6, suppliedRaw: '5000000000', withdrawnRaw: '0',
      borrowedRaw: '2000000000', repaidRaw: '0', liquidatedDebtRaw: '0', liquidatedCollateralRaw: '0' } } },
  morphoBlue: { supplyCount: 4, withdrawCount: 1, borrowCount: 2, repayCount: 1, supplyCollateralCount: 3, withdrawCollateralCount: 0, liquidationCount: 0,
    marketCreatedCount: 1, markets: { '0xmarket': { loanToken: UNKNOWN_TOKEN, collateralToken: USDC, lltv: '860000000000000000', suppliedRaw: '1000000',
      borrowedRaw: '500000', units: { loanToken: { symbol: null, decimals: null, verified: false }, collateralToken: { symbol: 'USDC', decimals: 6, verified: true } } } } },
  morphoVaultsV2: { depositCount: 6, withdrawCount: 2, foreignEventCount: 0, vaults: { '0x2222222222222222222222222222222222222222': { asset: USDC, depositCount: 6,
    withdrawCount: 2, depositedAssetsRaw: '7000000', withdrawnAssetsRaw: '1000000', units: { asset: { symbol: 'USDC', decimals: 6, verified: true } } } } },
  cctp: { outboundTransferCount: 9, inboundMintCount: 11, messageReceivedCount: 11, outboundAmountRaw: '9000000', inboundAmountRaw: '11000000',
    inboundFeeCollectedRaw: '0', units: USDC_UNITS },
  gateway: { depositCount: 2, outboundBurnCount: 1, inboundMintCount: 3, withdrawalInitiatedCount: 1, withdrawalCompletedCount: 1, depositAmountRaw: '2000000',
    outboundBurnAmountRaw: '1000000', outboundBurnFeeRaw: '0', inboundMintAmountRaw: '3000000', withdrawalAmountRaw: '500000', units: USDC_UNITS },
  across: { depositCount: 5, fillCount: 4, slowFillCount: 0,
    depositByToken: { [USDC]: { depositCount: 4, inputAmountRaw: '4000000', units: { symbol: 'USDC', decimals: 6, verified: true } },
      [UNKNOWN_TOKEN]: { depositCount: 1, inputAmountRaw: '123', units: { symbol: null, decimals: null, verified: false } } },
    fillByToken: { [USDC]: { fillCount: 4, outputAmountRaw: '3990000', units: { symbol: 'USDC', decimals: 6, verified: true } } } },
};
function summaryFixture({ families = {}, network = {}, storedHours = 48, usdVolume, swapFees, protocolUsd, window = '24h', hours = 24 } = {}) {
  const family = (name) => (Object.hasOwn(families, name) ? families[name] : available(FAMILY_METRICS[name]));
  return {
    schema: SUMMARY_SCHEMA, chain: { id: 5042, name: 'Arc' }, window: { key: window, hours, start: isoAt(END - hours * HOUR_MS), end: isoAt(END) }, freshness,
    network: { status: 'available', ...WINDOW_RANGE, blocks: 86_400, transactions: 1_234_567, transactionsPerSecond: 1_234_567 / 86_400,
      averageTransactionsPerBlock: 1_234_567 / 86_400, gasUsedRaw: '987654321000', uniqueActiveAddresses: { status: 'available', value: 45_678 },
      previous: { status: 'available', blocks: 86_400, transactions: 1_000_000, transactionsPerSecond: 1_000_000 / 86_400, averageTransactionsPerBlock: 11.5,
        gasUsedRaw: '900000000000', uniqueActiveAddresses: { status: 'not_supported', reason: 'identity_retention_exceeded', value: null } }, ...network },
    assets: { usdc: family('usdc'), verifiedAssets: family('assets') },
    dex: { uniswapV3: family('uniswapV3'), uniswapV4: family('uniswapV4'), officialV3Pools: { status: 'available', count: 87, throughBlock: 4_200_000 },
      ...(usdVolume ? { usdVolume } : {}), ...(swapFees ? { swapFees } : {}) },
    lending: { aaveV4: family('aaveV4'), morphoBlue: family('morphoBlue'), morphoVaultsV2: family('morphoVaultsV2') },
    ...(protocolUsd ? { protocolUsd } : {}),
    crossChain: { cctp: family('cctp'), gateway: family('gateway'), across: family('across') },
    coverage: { firstStoredHour: isoAt(END - storedHours * HOUR_MS), storedHours, checkpointHour: freshness.checkpointHour,
      verifiedThrough: freshness.verifiedThrough, checkpointBlock: 4_200_000, families: {} },
    definitions: {},
  };
}
// usd: hourly DEX USD volume as the read model serves it (a function of the bucket index), absent for an older API.
function timeseriesFixture({ notStored = 2, v4GapAt = 10, usd } = {}) {
  const buckets = Array.from({ length: 24 }, (_, index) => {
    const range = { start: isoAt(END - (24 - index) * HOUR_MS), end: isoAt(END - (23 - index) * HOUR_MS) };
    if (index < notStored) return { ...range, status: 'not_stored', network: null, families: null, ...(usd ? { dexUsdVolume: null } : {}) };
    return { ...range, status: 'committed', ...(usd ? { dexUsdVolume: usd(index) } : {}),
      network: { blocks: 3600, transactions: 50_000 + index, transactionsPerSecond: 13.9, averageTransactionsPerBlock: 13.9, gasUsedRaw: '41000000000',
        uniqueActiveAddresses: 1000 + index * 10 },
      families: {
        usdc: { status: 'available', transferCount: 200, mintCount: 1, burnCount: 1, amountRaw: '1', rawDecimals: 18 },
        uniswapV3: { status: 'available', poolCreatedCount: 0, swapCount: 100 + index, mintCount: 5, burnCount: 3, foreignEventCount: 0 },
        uniswapV4: index === v4GapAt ? { status: 'unavailable', reason: 'rpc_error' }
          : { status: 'available', initializeCount: 0, swapCount: 50 + index, modifyLiquidityCount: 2 },
      } };
  });
  return { schema: TIMESERIES_SCHEMA, chain: { id: 5042, name: 'Arc' }, window: { key: '24h', hours: 24, ...WINDOW_RANGE }, freshness, buckets };
}
const insufficient = Object.fromEntries(Object.keys(FAMILY_METRICS).map((name) => [name, unavailableFamily()]));
const collectingNetwork = { status: 'unavailable', reason: 'insufficient_coverage', blocks: null, transactions: null, transactionsPerSecond: null,
  averageTransactionsPerBlock: null, gasUsedRaw: null, uniqueActiveAddresses: { status: 'unavailable', reason: 'insufficient_coverage', value: null },
  previous: { status: 'unavailable', reason: 'insufficient_coverage', transactions: null, uniqueActiveAddresses: { status: 'unavailable', value: null } } };
// Shaped like a normalized BorrowMarket of src/lib/mainnetBorrow.ts (ratios are decimal fractions, amounts decimal strings).
const CIRBTC = '0x171a4217b86a807a64eb94757db6849fb4bdbaa0';
const borrowMarketFixture = (overrides = {}) => ({
  marketId: `0x${'ab'.repeat(32)}`, protocol: 'morpho',
  loanAsset: { symbol: 'USDC', address: USDC, decimals: 6 }, collateralAsset: { symbol: 'cirBTC', address: CIRBTC, decimals: 8 },
  lltv: 0.86, borrowApy: 0.0523, utilization: null, borrowAssets: null,
  liquidity: { token: 'USDC', tokenAddress: USDC, amount: '1234567.891', decimals: 6 }, refreshedAt: '2026-10-03T13:30:00.000Z', ...overrides,
});
const BORROW_AVAILABLE = { status: 'available', markets: [borrowMarketFixture()] };
// pools.v1 and activity.v1 fixtures, shaped exactly like server/compact/read-model.js answers.
const EURC = '0xbef5f6d51cb62b58e6a8f77868681825c6fe21c1';
const ZERO_ADDRESS = `0x${'0'.repeat(40)}`;
const poolToken = (address, symbol = null, decimals = null, native = false) => ({ address, symbol, decimals, verified: symbol !== null, native });
const T_USDC = poolToken(USDC, 'USDC', 6);
const T_EURC = poolToken(EURC, 'EURC', 6);
const T_UNKNOWN = poolToken(UNKNOWN_TOKEN);
const T_NATIVE = poolToken(ZERO_ADDRESS, 'USDC', 18, true);
const V3_POOL_A = `0x${'91'.repeat(20)}`;
const V3_POOL_B = `0x${'92'.repeat(20)}`;
const V4_POOL_X = `0x${'d1'.repeat(32)}`;
const V4_POOL_Y = `0x${'d2'.repeat(32)}`;
const HOOKS = `0x${'40'.repeat(20)}`;
const poolEntry = (pool, token0, token1, swapCount, extra = {}) => ({ pool, createdBlock: 4_100_000, token0, token1, fee: 500, tickSpacing: 10, hooks: null,
  swapCount, flowsRaw: { token0In: '1000000', token0Out: '0', token1In: '0', token1Out: '5' }, liquidityActivity: { addCount: 1, removeCount: 0, pokeCount: 0,
    amounts: { status: 'not_supported', reason: 'v4_token_amounts_unavailable', addAmount0Raw: null, addAmount1Raw: null, removeAmount0Raw: null, removeAmount1Raw: null } },
  ...extra });
const poolsFixture = (protocol, pools, extra = {}) => ({ schema: lib.POOLS_SCHEMA, chain: { id: 5042, name: 'Arc' }, protocol, window: { key: '24h', hours: 24, ...WINDOW_RANGE },
  freshness, status: 'available', reason: null, reasons: [], unavailableHours: [], ranking: { by: 'swap_count', usdVolume: { status: 'source_pending' },
    liquidityUsd: { status: 'source_pending' } }, poolsTracked: 87, newPools: 3, pools, ...extra });
const POOLS_READY = {
  v3: poolsFixture('v3', [poolEntry(V3_POOL_A, T_USDC, T_UNKNOWN, 4321), poolEntry(V3_POOL_B, T_USDC, T_EURC, 56, { fee: 3000, tickSpacing: 60 })]),
  v4: poolsFixture('v4', [poolEntry(V4_POOL_X, T_NATIVE, T_EURC, 1234, { hooks: ZERO_ADDRESS }), poolEntry(V4_POOL_Y, T_USDC, T_UNKNOWN, 12, { hooks: HOOKS, fee: 0x800000 })]),
};
const POOLS_COLLECTING = Object.fromEntries(['v3', 'v4'].map((protocol) => [protocol, poolsFixture(protocol, [], { status: 'unavailable',
  reason: 'insufficient_coverage', reasons: ['insufficient_coverage'], poolsTracked: null, newPools: null })]));
const TX = (n) => `0x${n.toString(16).padStart(64, '0')}`;
const SENDER = `0x${'5e'.repeat(20)}`;
const RECIPIENT = `0x${'7e'.repeat(20)}`;
const OWNER = `0x${'0e'.repeat(20)}`;
const LP_SENDER = `0x${'5a'.repeat(20)}`;
const V3_PAIR = { token0: T_USDC, token1: T_EURC, fee: 500, tickSpacing: 10, hooks: null };
const V3_UNKNOWN_PAIR = { token0: T_USDC, token1: T_UNKNOWN, fee: 500, tickSpacing: 10, hooks: null };
const V4_PAIR = { token0: T_NATIVE, token1: T_EURC, fee: 500, tickSpacing: 10, hooks: ZERO_ADDRESS };
const activityRow = (n, kind, protocol, pool, pair, amounts, to, toKind) => ({ time: isoAt(END - HOUR_MS + n * 60_000), blockNumber: 4_200_000 - n, logIndex: 0,
  txHash: TX(0xab00 + n), protocol, kind, pool, pair, amounts, from: SENDER, to, toKind });
const ROWS = {
  v3Swap: activityRow(1, 'swap', 'uniswap_v3', V3_POOL_B, V3_PAIR, { status: 'available', basis: 'v3_pool_delta', amount0Raw: '1500000', amount1Raw: '-1400000' },
    RECIPIENT, 'swap_recipient'),
  v4Swap: activityRow(2, 'swap', 'uniswap_v4', V4_POOL_X, V4_PAIR, { status: 'available', basis: 'v4_swap_delta', amount0Raw: '-2000000000000000000',
    amount1Raw: '1900000' }, null, 'none'),
  v3Add: activityRow(3, 'add', 'uniswap_v3', V3_POOL_A, V3_UNKNOWN_PAIR, { status: 'available', basis: 'v3_liquidity_amount', amount0Raw: '2500000', amount1Raw: '123' },
    OWNER, 'liquidity_owner'),
  v4Remove: activityRow(4, 'remove', 'uniswap_v4', V4_POOL_X, V4_PAIR, { status: 'not_supported', reason: 'v4_token_amounts_unavailable', basis: 'none',
    amount0Raw: null, amount1Raw: null }, LP_SENDER, 'event_sender'),
};
const activityFixture = (type, rows, extra = {}) => ({ schema: lib.ACTIVITY_SCHEMA, chain: { id: 5042, name: 'Arc' }, type, freshness, status: 'available', reason: null,
  limit: 25, rows, ...extra });
const ACTIVITY_READY = { all: activityFixture('all', [ROWS.v3Swap, ROWS.v4Swap, ROWS.v3Add, ROWS.v4Remove]), swaps: activityFixture('swaps', [ROWS.v3Swap, ROWS.v4Swap]),
  adds: activityFixture('adds', [ROWS.v3Add]), removes: activityFixture('removes', [ROWS.v4Remove]) };
const READY_DATA = { window: '24h', summary: summaryFixture(), timeseries: timeseriesFixture(), failed: false, pools: POOLS_READY, activity: ACTIVITY_READY };
// USD valuation as the read model serves it (server/compact/valuation.js): exact micro-USD strings, unvalued swaps counted.
const usdWindow = (totalUsdMicros, { unvaluedSwaps = 0, previous = '1000000000000' } = {}) => ({ status: 'available', reason: null, reasons: [], unavailableHours: [],
  ...WINDOW_RANGE, totalUsdMicros, byProtocol: { uniswapV3: '1000000000000', uniswapV4: (BigInt(totalUsdMicros) - 1_000_000_000_000n).toString() },
  valuedSwaps: 5500, unvaluedSwaps, previous: previous === null ? { status: 'unavailable', reason: 'insufficient_coverage', reasons: ['insufficient_coverage'],
    totalUsdMicros: null, byProtocol: null, valuedSwaps: null, unvaluedSwaps: null }
    : { status: 'available', reason: null, reasons: [], totalUsdMicros: previous, byProtocol: null, valuedSwaps: 5000, unvaluedSwaps: 0 } });
const usdUnavailable = (reasons) => ({ status: 'unavailable', reason: 'valuation_hour_unavailable', reasons, unavailableHours: [isoAt(END - HOUR_MS)], ...WINDOW_RANGE,
  totalUsdMicros: null, byProtocol: null, valuedSwaps: null, unvaluedSwaps: null });
const USD_GAP_AT = 12;
const usdHour = (index) => (index === USD_GAP_AT ? { status: 'unavailable', reason: 'prices_unavailable' }
  : { status: 'available', totalUsdMicros: String((1500 + index) * 1_000_000), uniswapV3UsdMicros: String((1000 + index) * 1_000_000),
    uniswapV4UsdMicros: '500000000', valuedSwaps: 150, unvaluedSwaps: index === 20 ? 7 : 0 });
const usdRanking = (status = 'available', reasons = []) => ({ by: 'swap_count', usdVolume: { status, reason: status === 'available' ? null : 'valuation_hour_unavailable', reasons },
  liquidityUsd: { status: 'source_pending' } });
const T_MOON = { ...poolToken(`0x${'3c'.repeat(20)}`), contractMetadata: { symbol: 'MOON', name: 'Moon Token', decimals: 18 } };
const usdPools = (ranking = usdRanking()) => ({
  v3: poolsFixture('v3', [poolEntry(V3_POOL_A, T_USDC, T_UNKNOWN, 4321, { usdVolume: { status: 'available', reason: null, usdMicros: '2000000000', basis: 'usd_anchor' } }),
    poolEntry(V3_POOL_B, T_EURC, T_MOON, 56, { fee: 3000, tickSpacing: 60, usdVolume: { status: 'unavailable', reason: 'no_verified_price', usdMicros: null, basis: null } })],
  { ranking }),
  v4: poolsFixture('v4', [poolEntry(V4_POOL_X, T_NATIVE, T_EURC, 1234, { hooks: ZERO_ADDRESS, usdVolume: { status: 'available', reason: null, usdMicros: '1234560000', basis: 'usd_anchor' } }),
    poolEntry(V4_POOL_Y, T_USDC, T_MOON, 12, { hooks: HOOKS, fee: 0x800000, usdVolume: { status: 'available', reason: null, usdMicros: '4500', basis: 'usd_anchor' } })],
  { ranking }),
});
const MOON_ROW = activityRow(5, 'swap', 'uniswap_v3', V3_POOL_A, { token0: T_USDC, token1: T_MOON, fee: 500, tickSpacing: 10, hooks: null },
  { status: 'available', basis: 'v3_pool_delta', amount0Raw: '-3250000', amount1Raw: '1873749079602007177928126' }, RECIPIENT, 'swap_recipient');
const USD_DATA = { window: '24h', summary: summaryFixture({ usdVolume: usdWindow('1234567890123', { unvaluedSwaps: 7 }) }),
  timeseries: timeseriesFixture({ usd: usdHour }), failed: false, pools: usdPools(),
  activity: { ...ACTIVITY_READY, all: activityFixture('all', [MOON_ROW, ...ACTIVITY_READY.all.rows]) } };
const notProcessed = ['valuation_not_processed'];
const USD_COLLECTING_DATA = { ...USD_DATA, summary: summaryFixture({ usdVolume: usdUnavailable(notProcessed) }),
  timeseries: timeseriesFixture({ usd: () => ({ status: 'unavailable', reason: 'valuation_not_processed' }) }), pools: usdPools(usdRanking('unavailable', notProcessed)) };
const USD_UNAVAILABLE_DATA = { ...USD_DATA, summary: summaryFixture({ usdVolume: usdUnavailable(['prices_unavailable']) }),
  timeseries: timeseriesFixture({ usd: () => ({ status: 'unavailable', reason: 'prices_unavailable' }) }),
  pools: usdPools(usdRanking('unavailable', ['prices_unavailable'])) };
// Swap fees, other protocols' USD and pool liquidity, exactly as the read model serves them once valued.
const feesWindow = (totalFeeUsdMicros, valuedSwaps, { unvaluedSwaps = 0, previousAverage = '250000' } = {}) => ({ status: 'available', reason: null, reasons: [],
  calculation: 'estimated', basis: 'input-side-estimated-swap-fees-v1', unavailableHours: [], ...WINDOW_RANGE,
  totalFeeUsdMicros, byProtocol: { uniswapV3: totalFeeUsdMicros, uniswapV4: '0' }, valuedSwaps, unvaluedSwaps,
  averageFeeUsdMicros: (BigInt(totalFeeUsdMicros) / BigInt(valuedSwaps)).toString(),
  previous: { status: 'available', reason: null, reasons: [], totalFeeUsdMicros: '1250000000', byProtocol: null, valuedSwaps: 5000, unvaluedSwaps: 0,
    averageFeeUsdMicros: previousAverage } });
const PROTOCOL_USD_READY = {
  cctp: { status: 'available', reason: null, ...WINDOW_RANGE, values: { outboundUsdMicros: '9000000', inboundUsdMicros: '11000000', inboundFeeUsdMicros: '0' } },
  gateway: { status: 'available', reason: null, ...WINDOW_RANGE, values: { depositUsdMicros: '2000000', outboundBurnUsdMicros: '1000000', outboundBurnFeeUsdMicros: '0',
    inboundMintUsdMicros: '3000000', withdrawalUsdMicros: '500000' } },
  across: { status: 'unavailable', reason: 'unverified_token', ...WINDOW_RANGE, values: null, failedHour: isoAt(END - 3 * HOUR_MS) },
  aaveV4: { status: 'available', reason: null, ...WINDOW_RANGE, values: { suppliedUsdMicros: '5000000000', withdrawnUsdMicros: '0', borrowedUsdMicros: '2000000000',
    repaidUsdMicros: '0', liquidatedDebtUsdMicros: '0', liquidatedCollateralUsdMicros: '0' } },
  morphoBlue: { status: 'unavailable', reason: 'unverified_token', ...WINDOW_RANGE, values: null, failedHour: isoAt(END - 5 * HOUR_MS) },
  morphoVaultsV2: { status: 'available', reason: null, ...WINDOW_RANGE, values: { depositedUsdMicros: '7000000', withdrawnUsdMicros: '1000000' } },
};
const liquidity = (usdMicros, extra = {}) => ({ status: 'available', reason: null, usdMicros, amount0Raw: '1000000', amount1Raw: '2000000', asOfBlock: 4_200_000, ...extra });
const noLiquidity = (reason, extra = {}) => ({ status: 'unavailable', reason, usdMicros: null, amount0Raw: null, amount1Raw: null, asOfBlock: null, ...extra });
const completePools = () => {
  const ranking = { ...usdRanking(), liquidityUsd: { status: 'available', reason: null, asOfHour: isoAt(END - HOUR_MS) } };
  const pools = usdPools(ranking);
  pools.v3.pools[0].liquidityUsd = liquidity('3500000000000');
  pools.v3.pools[1].liquidityUsd = noLiquidity('no_verified_price', { amount0Raw: '5', amount1Raw: '6', asOfBlock: 4_200_000 });
  pools.v4.pools[0].liquidityUsd = liquidity('820000000', { calculation: 'estimated_principal_reserves' });
  pools.v4.pools[1].liquidityUsd = noLiquidity('hook_may_hold_pool_value', { asOfBlock: 4_200_000 });
  return pools;
};
const COMPLETE_DATA = { ...USD_DATA, summary: summaryFixture({ usdVolume: usdWindow('1234567890123', { unvaluedSwaps: 7 }),
  swapFees: feesWindow('1650000000', 5500, { unvaluedSwaps: 12 }), protocolUsd: PROTOCOL_USD_READY }), pools: completePools(),
  activity: { ...ACTIVITY_READY, all: activityFixture('all', ACTIVITY_READY.all.rows.map((row) => ({ ...row, toReason: row.toKind === 'none' ? lib.V4_SWAP_TO_BLOCKER : null }))) } };
// 7D and 30D while history fills (52 of 168 or 720 hours stored): totals collecting, daily buckets with honest gaps.
const STORED_HOURS = 52;
const longSummary = (window, hours) => summaryFixture({ window, hours, families: insufficient, network: collectingNetwork, storedHours: STORED_HOURS,
  usdVolume: { status: 'unavailable', reason: 'insufficient_coverage', reasons: ['insufficient_coverage'], unavailableHours: [], totalUsdMicros: null, byProtocol: null,
    valuedSwaps: null, unvaluedSwaps: null },
  swapFees: { status: 'unavailable', reason: 'insufficient_coverage', reasons: ['insufficient_coverage'], unavailableHours: [], totalFeeUsdMicros: null, byProtocol: null,
    valuedSwaps: null, unvaluedSwaps: null, averageFeeUsdMicros: null },
  protocolUsd: Object.fromEntries(Object.keys(PROTOCOL_USD_READY).map((name) => [name, { status: 'unavailable', reason: 'insufficient_coverage', values: null }])) });
function dailyTimeseries(window, days) {
  const dayMs = 24 * HOUR_MS;
  const end = Math.floor(END / dayMs) * dayMs;
  const buckets = Array.from({ length: days }, (_, index) => {
    const start = end - (days - index) * dayMs;
    const range = { start: isoAt(start), end: isoAt(start + dayMs) };
    const fromEnd = days - 1 - index;
    const storedHours = Math.max(0, Math.min(24, (start + dayMs - Math.max(start, END - STORED_HOURS * HOUR_MS)) / HOUR_MS));
    if (storedHours < 24) return { ...range, status: storedHours ? 'incomplete' : 'not_stored', storedHours,
      network: null, families: null, dexUsdVolume: null };
    return { ...range, status: 'committed', storedHours: 24,
      network: { blocks: 86_400, transactions: 1_200_000 + index, transactionsPerSecond: 13.9, averageTransactionsPerBlock: 13.9, gasUsedRaw: '980000000000',
        uniqueActiveAddresses: null, uniqueActiveAddressesStatus: { status: 'not_stored', reason: 'daily_identity_not_processed', value: null } },
      families: { uniswapV3: { status: 'available', swapCount: 4000 + index, poolCreatedCount: 1, mintCount: 9, burnCount: 4, foreignEventCount: 0 },
        uniswapV4: { status: 'available', swapCount: 1000, initializeCount: 0, modifyLiquidityCount: 3 } },
      dexUsdVolume: fromEnd === 1 ? { status: 'unavailable', reason: 'valuation_not_processed' }
        : { status: 'available', totalUsdMicros: '36000000000', uniswapV3UsdMicros: '24000000000', uniswapV4UsdMicros: '12000000000', valuedSwaps: 5000, unvaluedSwaps: 3 } };
  });
  return { schema: TIMESERIES_SCHEMA, chain: { id: 5042, name: 'Arc' }, window: { key: window, hours: days * 24, start: isoAt(end - days * dayMs), end: isoAt(end) },
    freshness, bucketHours: 24, buckets };
}
const longPools = (window, hours) => Object.fromEntries(['v3', 'v4'].map((protocol) => [protocol, { ...POOLS_COLLECTING[protocol],
  window: { key: window, hours, start: isoAt(END - hours * HOUR_MS), end: isoAt(END) } }]));
const longData = (window, days) => ({ window, summary: longSummary(window, days * 24), timeseries: dailyTimeseries(window, days), failed: false,
  pools: longPools(window, days * 24), activity: ACTIVITY_READY });
const SEVEN_DAY_DATA = longData('7d', 7);
const THIRTY_DAY_DATA = longData('30d', 30);
const USD_STATES = ['ready-usd', 'usd-swaps-tab', 'usd-collecting', 'usd-unavailable', 'ready-complete', '7d', '7d-swaps', '30d'];
const LOADING_STATES = ['loading', '7d-loading', '7d-with-24h-data'];
const BORROW_UNAVAILABLE = { status: 'unavailable' };
const STATES = {
  // Swaps view, so the chart assertions see the hourly bars; the default view (Volume) is checked separately.
  ready: { selectedWindow: '24h', initialDexView: 'swaps', borrowMarket: BORROW_AVAILABLE, data: READY_DATA },
  'ready-default-view': { selectedWindow: '24h', borrowMarket: BORROW_AVAILABLE, data: READY_DATA },
  collecting: { selectedWindow: '24h', borrowMarket: BORROW_UNAVAILABLE,
    data: { window: '24h', summary: summaryFixture({ families: insufficient, network: collectingNetwork, storedHours: 18 }),
      timeseries: timeseriesFixture({ notStored: 6, v4GapAt: -1 }), failed: false, pools: POOLS_COLLECTING, activity: ACTIVITY_READY } },
  // One pools read and one activity filter failed: only those parts read unavailable.
  mixed: { selectedWindow: '24h', borrowMarket: BORROW_AVAILABLE, data: { window: '24h', timeseries: timeseriesFixture(), failed: false,
    summary: summaryFixture({ families: { aaveV4: unavailableFamily('family_hour_unavailable'), across: unavailableFamily('window_constant_mismatch') } }),
    pools: { v3: null, v4: POOLS_READY.v4 }, activity: { ...ACTIVITY_READY, swaps: null } } },
  failed: { selectedWindow: '24h', borrowMarket: BORROW_UNAVAILABLE, data: { window: '24h', summary: null, timeseries: null, failed: true } },
  loading: { selectedWindow: '24h', data: null },
  '7d': { selectedWindow: '7d', borrowMarket: BORROW_AVAILABLE, data: SEVEN_DAY_DATA },
  '7d-swaps': { selectedWindow: '7d', initialDexView: 'swaps', borrowMarket: BORROW_AVAILABLE, data: SEVEN_DAY_DATA },
  '30d': { selectedWindow: '30d', borrowMarket: BORROW_UNAVAILABLE, data: THIRTY_DAY_DATA },
  '7d-loading': { selectedWindow: '7d', borrowMarket: BORROW_AVAILABLE, data: null },
  // A 24H result handed to the 7D view must be ignored, never shown as 7D: the 7D view keeps loading its own data.
  '7d-with-24h-data': { selectedWindow: '7d', borrowMarket: BORROW_AVAILABLE, data: READY_DATA },
  // Everything valued: DEX volume, swap fees, pool liquidity, other protocols' USD and the V4 To reason.
  'ready-complete': { selectedWindow: '24h', borrowMarket: BORROW_AVAILABLE, data: COMPLETE_DATA },
  'ready-swaps-tab': { selectedWindow: '24h', borrowMarket: BORROW_AVAILABLE, data: READY_DATA, initialActivityType: 'swaps',
    explorerUrl: 'https://explorer.arc.io' },
  // The API with USD valuation: available, still being valued, and unavailable (prices missing for some hour).
  'ready-usd': { selectedWindow: '24h', borrowMarket: BORROW_AVAILABLE, data: USD_DATA },
  'usd-swaps-tab': { selectedWindow: '24h', initialDexView: 'swaps', borrowMarket: BORROW_AVAILABLE, data: USD_DATA },
  'usd-collecting': { selectedWindow: '24h', borrowMarket: BORROW_AVAILABLE, data: USD_COLLECTING_DATA },
  'usd-unavailable': { selectedWindow: '24h', borrowMarket: BORROW_AVAILABLE, data: USD_UNAVAILABLE_DATA },
};
const rendered = Object.fromEntries(Object.entries(STATES).map(([name, props]) => [name, render(props)]));
const statusIn = (state, id) => item(rendered[state].tree, id).attrs['data-intel-status'];
const valueIn = (state, id) => item(rendered[state].tree, id).attrs['data-intel-value'];

await test('UI 1 manifest: the thirteen stable sections in order (Borrow after launches), unique item ids, receipt analytics the only removed scope', async () => {
  assert.deepEqual(SCOPE.map((section) => section.id), SECTION_IDS);
  const ids = SCOPE.flatMap((section) => section.items.map((entry) => entry.id));
  assert.equal(new Set(ids).size, ids.length);
  for (const section of SCOPE) {
    assert.ok(section.items.length > 0, section.id);
    for (const entry of section.items) assert.ok(['live', 'pending'].includes(entry.backend), entry.id);
  }
  assert.deepEqual([...new Set(SCOPE.map((section) => section.group))],
    ['Network Activity', 'Markets', 'Recent Activity', 'Assets', 'New Token Launches', 'Borrow', 'Lending', 'Cross-chain', 'Ecosystem']);
  for (const id of ['window.24h', 'window.7d', 'window.30d', 'network.total-volume', 'network.average-fee', 'top-pools-v3.all-pairs', 'top-pools-v4.all-pairs',
    'recent-activity.transaction-links', 'launches.initial-pool', 'borrow.route', 'borrow.market-terms', 'borrow.action', 'lending.morpho-vaults',
    'cross-chain.across', 'rwa-other.exchange-flows', 'rwa-other.more-protocols']) assert.ok(ids.includes(id), id);
  assert.deepEqual([...ARC_INTELLIGENCE_REMOVED_SCOPE], ['successful transaction count', 'failed transaction count', 'success rate',
    'receipt-dependent transaction outcome analytics']);
});

await test('UI 2 every manifest section and item is rendered, in its own section, in every data state', async () => {
  for (const [name, { tree }] of Object.entries(rendered)) {
    const statuses = checkScope(tree, SCOPE, { allowLoading: LOADING_STATES.includes(name) });
    if (!LOADING_STATES.includes(name)) assert.ok(![...statuses.values()].includes('loading'), name);
  }
});

await test('UI 3 header, window selector, refresh, KPI cards, chart tabs, activity tabs and group headers exist', async () => {
  const { tree } = rendered.ready;
  const buttons = [...walk(tree)].filter((node) => node.tag === 'button').map((node) => ({ text: textOf(node), node }));
  const button = (text) => buttons.find((entry) => entry.text === text)?.node;
  for (const label of ['24H', '7D', '30D', 'Refresh', 'Volume', 'Swaps', 'All', 'Adds', 'Removes']) assert.ok(button(label), label);
  assert.match(button('24H').attrs.class, /bg-\[#2F6E0C\].*text-white/);
  assert.match(button('7D').attrs.class, /border-slate-300 bg-white/);
  assert.equal(button('24H').attrs['aria-selected'], 'true');
  const text = textOf(tree);
  for (const label of ['Arc Intelligence', 'Verified Arc network activity', 'Verified through Oct 3, 14:00 UTC', 'Active Addresses', 'Transactions', 'DEX Volume',
    'Avg DEX Pool Fee', 'Top Protocols', 'Top Pools (Uniswap V3)', 'Top Pools (Uniswap V4)', 'Latest DEX activity', 'Verified asset transfers', 'New Token Launches',
    'Borrow on Arc', 'Powered by Circle Borrow Kit on Arc', 'Aave', 'Morpho Blue', 'Morpho Vaults', 'CCTP', 'Gateway', 'Across', 'RWA',
    'Other Verified Protocols', 'Exchange flows', 'Other verified Arc protocols', 'Hours in UTC']) {
    assert.ok(text.includes(label), label);
  }
  const groups = [...walk(tree)].filter((node) => node.tag === 'h3').map(textOf);
  assert.deepEqual(groups, ['Network Activity', 'Markets', 'Recent Activity', 'Assets', 'New Token Launches', 'Borrow', 'Lending', 'Cross-chain', 'Ecosystem']);
  const order = byAttr(tree, 'data-intel-section').map((node) => node.attrs['data-intel-section']);
  assert.deepEqual(order, SECTION_IDS, 'sections render in the locked order');
});

await test('UI 4 verified values come from the summary and timeseries exactly, with explicit units', async () => {
  assert.equal(valueIn('ready', 'network.transactions'), '1234567');
  assert.match(textOf(item(rendered.ready.tree, 'network.transactions')), /1,234,567 Total transactions, last 24H/);
  assert.equal(valueIn('ready', 'network.active-addresses'), '45678');
  assert.equal(valueIn('ready', 'network.blocks'), '86400');
  assert.equal(valueIn('ready', 'network.gas-used'), '987654321000');
  assert.equal(valueIn('ready', 'top-protocols.uniswap-v3'), '4321');
  assert.equal(valueIn('ready', 'top-protocols.aave'), '26');
  assert.equal(valueIn('ready', 'top-pools-v3.new-pools'), '3');
  assert.equal(valueIn('ready', 'top-pools-v4.new-pools'), '2');
  assert.equal(valueIn('ready', 'top-pools-v3.pool-count'), '87');
  assert.equal(valueIn('ready', 'assets.eurc'), '321');
  assert.match(textOf(item(rendered.ready.tree, 'assets.usdc')), /1,234,567\.89 USDC/, 'canonical USDC amount uses its persisted 18 decimals, exactly');
  assert.match(textOf(item(rendered.ready.tree, 'assets.weth')), /1\.5 WETH/);
  assert.equal(lib.formatTokenAmount('123456789', 8, 4), '1.2345', 'cirBTC-like tokens keep four decimals');
  assert.equal(valueIn('ready', 'assets.cirbtc'), '0');
  assert.match(textOf(item(rendered.ready.tree, 'assets.cirbtc')), /No verified transfers in this window/);
  assert.equal(valueIn('ready', 'cross-chain.cctp'), '20');
  assert.match(textOf(item(rendered.ready.tree, 'cross-chain.cctp')),
    /Outbound From Arc to other chains 9 transfers 9 USDC Inbound From other chains to Arc 11 transfers 11 USDC/);
  assert.match(textOf(item(rendered.ready.tree, 'rwa-other.rwa')), /USYC Tokenized fund RWA Transfers 12 Mints 3 Burns 1 Amount moved 250 USYC/);
  // Swap chart: latest complete hour is 13:00-14:00 UTC (V3 123 + V4 73); gaps are drawn as gaps, never as zero.
  assert.equal(valueIn('ready', 'volume-chart.latest'), '196');
  assert.equal(valueIn('ready', 'active-addresses-chart.latest'), '1230');
  const bars = (sectionId) => [...walk(byAttr(rendered.ready.tree, 'data-intel-section', sectionId)[0])].filter((node) => node.tag === 'button' && /UTC/.test(node.attrs['aria-label'] ?? ''));
  const swapBars = bars('volume-chart');
  assert.equal(swapBars.length, 24);
  assert.equal(swapBars.at(-1).attrs['aria-label'], '13:00-14:00 UTC: 196 swaps');
  assert.equal(swapBars.filter((node) => /no verified data/.test(node.attrs['aria-label'])).length, 3, 'two hours not stored, one V4 hour unavailable');
  assert.equal(bars('active-addresses-chart').filter((node) => /no verified data/.test(node.attrs['aria-label'])).length, 2);
  assert.match(textOf(byAttr(rendered.ready.tree, 'data-intel-section', 'volume-chart')[0]), /Counts, not amounts/);
});

const ALLOWED_DIGITS = [/\b\d+ of \d+ hours\b/g, /\b(24H|7D|30D)\b/g, /\bV[34]\b/g, /\b(7|30) full days\b/g];
const withoutAllowedDigits = (text) => ALLOWED_DIGITS.reduce((current, pattern) => current.replace(pattern, ''), text);

await test('UI 5 missing data never appears as a number or as zero, in any state', async () => {
  for (const [name, { tree }] of Object.entries(rendered)) {
    for (const node of byAttr(tree, 'data-intel-item')) {
      if (node.attrs['data-intel-status'] === 'available') continue;
      const text = textOf(node);
      assert.doesNotMatch(withoutAllowedDigits(text), /\d/, `${name} ${node.attrs['data-intel-item']}: "${text}"`);
    }
  }
  // Without verified window data no window value exists. Borrow markets are current product terms read from Borrow Kit,
  // not a window metric, so they are the only values a 7D or 30D view may carry.
  const windowValues = (tree) => byAttr(tree, 'data-intel-value').map((node) => node.attrs['data-intel-item']).filter((id) => !id.startsWith('borrow.'));
  for (const name of ['failed', ...LOADING_STATES]) assert.deepEqual(windowValues(rendered[name].tree), [], name);
  // 7D and 30D while history fills: only complete days and the pool registry carry values; window totals stay collecting.
  for (const name of ['7d', '30d']) assert.deepEqual(windowValues(rendered[name].tree), ['volume-chart.latest', 'top-pools-v3.pool-count'], name);
  // While the 24H totals are still being collected, only hour-level and registry values exist: the verified hours.
  assert.deepEqual(windowValues(rendered.collecting.tree), ['active-addresses-chart.latest', 'top-pools-v3.pool-count']);
  // The collecting state still draws every verified hour (18 of 24), and says so in plain words.
  assert.equal(statusIn('collecting', 'volume-chart.swaps'), 'available');
  assert.equal(statusIn('collecting', 'network.transactions'), 'collecting');
  assert.match(textOf(rendered.collecting.tree), /History is still being collected \(18 of 24 hours so far\)\. 24H totals appear once every hour of the window is verified/);
  assert.match(textOf(item(rendered.collecting.tree, 'network.transactions')), /Collecting History is still being collected/);
});

await test('UI 6 without the API\'s USD valuation no USD value exists; the protocol USD ranking stays blocked with its reason', async () => {
  const VOLUME = ['network.total-volume', 'network.average-fee', 'volume-chart.volume', 'top-pools-v3.volume', 'top-pools-v4.volume', 'top-pools-v3.liquidity',
    'top-pools-v4.liquidity', 'lending.aave-usd', 'lending.morpho-blue-usd', 'lending.morpho-vaults-usd', 'cross-chain.cctp-usd', 'cross-chain.gateway-usd',
    'cross-chain.across-usd'];
  for (const [name, { tree, html }] of Object.entries(rendered)) {
    assert.equal(item(tree, 'top-protocols.volume-ranking').attrs['data-intel-status'], 'source_pending', `${name} ranking`);
    if (USD_STATES.includes(name)) continue;
    for (const id of VOLUME) assert.notEqual(item(tree, id).attrs['data-intel-status'], 'available', `${name} ${id}`);
    assert.equal(item(tree, 'network.total-volume').attrs['data-intel-value'], undefined, `${name}: no financial value`);
    assert.doesNotMatch(html, /\$\s?\d|\d\s?USD\b|US\$/, `${name}: no USD amount`);
  }
  // An API without valuation (the ready fixtures carry none) reads as not available yet, never as zero or unavailable.
  for (const id of VOLUME) assert.equal(statusIn('ready', id), 'source_pending', id);
  assert.equal(statusIn('ready-default-view', 'volume-chart.volume'), 'source_pending');
  assert.match(textOf(item(rendered.ready.tree, 'network.average-fee')), /Avg DEX Pool Fee Not available yet Verified data does not include estimated swap fees yet\./);
  assert.match(textOf(item(rendered.ready.tree, 'network.total-volume')), /DEX Volume Not available yet USD-valued Uniswap V3 and V4 swaps on Arc\. Verified data does not include DEX USD valuations yet\./);
});

const UI_SOURCES = [COMPONENT_PATH, LIB_PATH, SCOPE_PATH].map((file) => [file, readFileSync(file, 'utf8')]);
const componentSource = UI_SOURCES[0][1];

await test('UI 7 Top Pools, Recent Activity and swaps cover all pairs, never only USDC pairs', async () => {
  for (const [file, source] of UI_SOURCES) {
    assert.doesNotMatch(source, /(===|!==|==)\s*'USDC'|'USDC'\s*(===|!==|==)|usdcOnly|onlyUsdc|USDC_ONLY/i, file);
  }
  for (const id of ['top-pools-v3.all-pairs', 'top-pools-v4.all-pairs']) {
    assert.match(SCOPE.flatMap((section) => section.items).find((entry) => entry.id === id).label, /not only USDC pairs/);
  }
  const text = textOf(rendered.ready.tree);
  assert.match(text, /Every verified Uniswap V3 pair is ranked by swaps, not only USDC pairs/);
  assert.match(text, /Every verified Uniswap V4 pair is ranked by swaps, not only USDC pairs/);
  assert.match(text, /Tokens without verified details show their shortened address/);
  assert.match(textOf(byAttr(rendered.ready.tree, 'data-intel-section', 'top-pools-v3')[0]), /USDC \/ 0xabcd\.\.\.1234/,
    'a non-USDC side is listed by its shortened address');
});

await test('UI 8 no removed receipt metrics, no runtime views, no engineering words, no em dashes in the UI', async () => {
  for (const [file, source] of UI_SOURCES) {
    assert.doesNotMatch(source, /successRate|successfulTransactions|failedTransactions|contractCreations|view=(runtime|latest|coverage)/, file);
  }
  for (const [name, { tree, html }] of Object.entries(rendered)) {
    const text = textOf(tree);
    assert.doesNotMatch(text, /success rate|successful|failed transactions|contract creations|receipt|checkpoint|\bRPC\b|SQLite|indexer|\blane\b|shadow|reconcil|backfill|chunk|reducer|decoder|queue|A1\b|A2\b|\bAPI\b|backend/i, name);
    assert.doesNotMatch(html, /[–—]/, `${name}: no en or em dash`);
    assert.doesNotMatch(text, /Ethereum|Optimism|Arbitrum|Solana|Machina Intelligence/, `${name}: no copied chain menu or second app shell`);
  }
  for (const entry of SCOPE.flatMap((section) => [section.title, ...section.items.map((scopeItem) => scopeItem.label)])) assert.doesNotMatch(entry, /[–—]/);
  assert.doesNotMatch(componentSource, /\bdark:|bg-(slate|gray|zinc|neutral)-(900|950)\b|purple|violet|indigo|fuchsia/, 'light Machina theme only');
});

await test('UI 9 every window reads exactly its own summary, timeseries and pools plus the shared activity; nothing else is requested', async () => {
  const requests = (window) => [`/api/intelligence?view=summary&window=${window}`, `/api/intelligence?view=timeseries&window=${window}`,
    `/api/intelligence?view=pools&protocol=v3&window=${window}`, `/api/intelligence?view=pools&protocol=v4&window=${window}`,
    `/api/intelligence?view=ecosystem&window=${window}`,
    ...['all', 'swaps', 'adds', 'removes'].map((type) => `/api/intelligence?view=activity&type=${type}`)];
  assert.deepEqual(Object.values(lib.ARC_INTELLIGENCE_REQUESTS).sort(), [...new Set(['24h', '7d', '30d'].flatMap(requests))].sort());
  for (const url of Object.values(lib.ARC_INTELLIGENCE_REQUESTS)) {
    const parsed = new URL(url, 'https://machina.example');
    assert.equal(parsed.pathname, '/api/intelligence');
    assert.ok(resolveIntelligenceRoute(Object.fromEntries(parsed.searchParams)), `${url} is an exact proxy route`);
  }
  assert.deepEqual({ ...scopeModule.ARC_INTELLIGENCE_BACKEND_WINDOWS }, { '24h': true, '7d': true, '30d': true });
  const DATA = { '24h': READY_DATA, '7d': SEVEN_DAY_DATA, '30d': THIRTY_DAY_DATA };
  for (const window of ['24h', '7d', '30d']) {
    const calls = [];
    const body = (url) => {
      const query = Object.fromEntries(new URL(url, 'https://machina.example').searchParams);
      if (query.view === 'activity') return DATA[window].activity[query.type];
      if (query.view === 'pools') return DATA[window].pools[query.protocol];
      return DATA[window][query.view];
    };
    const fetchImpl = async (url, init) => {
      calls.push([url, init.method]);
      return { ok: true, json: async () => structuredClone(body(url)) };
    };
    const result = await lib.loadArcIntelligence(window, { fetchImpl });
    assert.deepEqual(calls.map(([url, method]) => `${method} ${url}`).sort(), requests(window).map((url) => `GET ${url}`).sort(), `${window}: its eight exact requests`);
    assert.deepEqual([result.window, result.failed, result.summary.window.key, result.timeseries.window.key], [window, false, window, window]);
    assert.ok(result.pools.v3 && result.pools.v4 && result.activity.all, `${window}: pools and activity parsed`);
  }
  assert.equal(lib.parseArcPools(POOLS_READY.v3, 'v3', '7d'), null, 'a pools answer for another window is never accepted');
  assert.doesNotMatch(componentSource, /\bfetch\(/, 'the component only loads through loadArcIntelligence');
  assert.match(componentSource, /if \(!ARC_INTELLIGENCE_BACKEND_WINDOWS\[target\]\) return/);
  for (const [name, hours] of [['7d', 168], ['30d', 720]]) {
    assert.match(textOf(rendered[name].tree), new RegExp(`History is still being collected \\(${STORED_HOURS} of ${hours} hours so far\\)\\. ${name.toUpperCase()} totals appear once every hour of the window is verified; the daily charts already show each complete day\\.`), name);
    assert.equal(statusIn(name, 'network.transactions'), 'collecting', name);
    assert.equal(statusIn(name, 'active-addresses-chart.series'), 'unavailable', `${name}: daily unique addresses are never summed`);
  }
  for (const name of ['7d-loading', '7d-with-24h-data']) assert.equal(statusIn(name, 'network.transactions'), 'loading', `${name}: never shows another window's data`);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () => { throw new Error('server rendering must not fetch'); };
  try {
    checkScope(render({}, componentModule.default).tree, SCOPE, { allowLoading: true });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

await test('UI 10 a transport failure keeps the full layout with a calm notice', async () => {
  const failures = [
    async () => { throw new TypeError('network down'); },
    async () => ({ ok: false, json: async () => ({ error: 'Arc Intelligence is temporarily unavailable' }) }),
    async (url) => ({ ok: true, json: async () => (url.includes('summary') ? { schema: TIMESERIES_SCHEMA } : timeseriesFixture()) }),
    async () => ({ ok: true, json: async () => [] }),
  ];
  for (const fetchImpl of failures) {
    const result = await lib.loadArcIntelligence('24h', { fetchImpl });
    assert.equal(result.failed, true);
    assert.equal(result.summary, null);
  }
  const { tree } = rendered.failed;
  assert.match(textOf(tree), /Arc Intelligence data could not be loaded right now\. The layout stays in place; try Refresh in a moment\./);
  for (const id of ['network.transactions', 'top-protocols.aave', 'assets.usdc', 'lending.aave', 'cross-chain.cctp', 'volume-chart.swaps']) {
    assert.equal(statusIn('failed', id), 'unavailable', id);
  }
  assert.equal(statusIn('failed', 'launches.token'), 'source_pending');
});

await test('UI 11 one unavailable family does not hide or blank any other section', async () => {
  assert.equal(statusIn('mixed', 'lending.aave'), 'unavailable');
  assert.equal(statusIn('mixed', 'top-protocols.aave'), 'unavailable');
  assert.equal(statusIn('mixed', 'cross-chain.across'), 'unavailable');
  for (const id of ['lending.morpho-blue', 'lending.morpho-vaults', 'cross-chain.cctp', 'cross-chain.gateway', 'top-protocols.uniswap-v3', 'assets.usdc', 'network.transactions']) {
    assert.equal(statusIn('mixed', id), 'available', id);
  }
  assert.match(textOf(item(rendered.mixed.tree, 'lending.aave')), /Not verified for this window/);
});

await test('UI 12 unknown tokens are shown by shortened address, never hidden or given a guessed amount', async () => {
  const blue = textOf(item(rendered.ready.tree, 'lending.morpho-blue'));
  assert.match(blue, /0xabcd\.\.\.1234 Token details are not verified yet/);
  const across = textOf(item(rendered.ready.tree, 'cross-chain.across'));
  assert.match(across, /Deposits from Arc 5 Deposited by token U USDC Amount 4/);
  assert.match(across, /0xabcd\.\.\.1234 Token details are not verified yet/);
  assert.equal(lib.shortenAddress(UNKNOWN_TOKEN), '0xabcd...1234');
});

await test('UI 13 previous-window change is shown only when the previous window is exactly comparable', async () => {
  assert.match(textOf(item(rendered.ready.tree, 'network.transactions')), /\+23\.5% vs previous 24H/);
  assert.doesNotMatch(textOf(item(rendered.ready.tree, 'network.active-addresses')), /vs previous/, 'previous unique count not supported: no delta, metric kept');
  for (const name of ['collecting', 'failed', '7d', '30d']) assert.doesNotMatch(textOf(rendered[name].tree), /vs previous/, name);
  assert.equal(lib.percentChange(10, null), null);
  assert.equal(lib.percentChange(10, 0), null);
});

await test('UI 14 amounts are exact (BigInt), and the token registry matches the verified asset registry', async () => {
  assert.equal(lib.formatTokenAmount('1234567890123456789012345', 18), '1,234,567.89');
  assert.equal(lib.formatTokenAmount('1', 6), '<0.01', 'a real amount below the shown precision is never shown as zero');
  assert.equal(lib.formatTokenAmount('0', 6), '0');
  assert.equal(lib.formatTokenAmount('1500000', 6), '1.5');
  assert.equal(lib.formatTokenAmount('99999999999999999999999999999999', 6, 6), '99,999,999,999,999,999,999,999,999.999999');
  assert.equal(lib.formatCompactRaw('987654321000'), '987.6B');
  assert.deepEqual({ ...lib.ARC_KNOWN_TOKENS },
    Object.fromEntries(ARC_VERIFIED_ASSETS.map((asset) => [asset.address, { symbol: asset.symbol, decimals: asset.decimals }])));
  assert.equal(lib.windowStatus({ status: 'unavailable', reason: 'insufficient_coverage' }), 'collecting');
  assert.equal(lib.windowStatus({ status: 'unavailable', reason: 'family_hour_unavailable' }), 'unavailable');
  assert.equal(lib.metricNumber(unavailableFamily(), 'swapCount'), null);
  assert.equal(lib.metricSum(available({ a: 1 }), ['a', 'b']), null, 'a partial sum is never shown');
});

await test('UI 15 mutation: removing a manifest entry or a rendered marker fails the scope check', async () => {
  const { tree, html } = rendered.ready;
  const dropItem = SCOPE.map((section) => (section.id === 'lending' ? { ...section, items: section.items.slice(1) } : section));
  const extraItem = SCOPE.map((section) => (section.id === 'launches' ? { ...section, items: [...section.items, { id: 'launches.extra', label: 'x', backend: 'pending' }] } : section));
  assert.throws(() => checkScope(tree, SCOPE.filter((section) => section.id !== 'assets')), /section assets not declared/);
  assert.throws(() => checkScope(tree, dropItem), /item lending\.aave not declared/);
  assert.throws(() => checkScope(tree, extraItem), /item launches\.extra not rendered/);
  assert.throws(() => checkScope(parseHtml(html.replace('data-intel-section="launches"', 'data-removed="launches"')), SCOPE), /section launches not rendered/);
  assert.throws(() => checkScope(parseHtml(html.replaceAll('data-intel-item="cross-chain.gateway"', 'data-removed="x"')), SCOPE), /item cross-chain\.gateway not rendered/);
  assert.throws(() => checkScope(parseHtml(html.replace(/data-intel-item="network\.average-fee" data-intel-status="source_pending"/, '$& data-intel-value="0"')), SCOPE),
    /value without data/);
});

await test('UI 16 mutation: a component that drops a section, or hides one when data is missing, is caught', async () => {
  const mutations = [
    [componentSource.replace('data-intel-section="cross-chain"', 'data-removed="cross-chain"'), 'ready', /section cross-chain not rendered/],
    [componentSource.replace('<LaunchesSection ctx={ctx} />', ''), 'ready', /section launches not rendered/],
    [componentSource.replace('<BorrowSection borrowMarket={borrowMarket} />', ''), 'collecting', /section borrow not rendered/],
    [componentSource.replace('function AssetsSection({ ctx }: { ctx: ViewContext }) {', "function AssetsSection({ ctx }: { ctx: ViewContext }) {\n  if (ctx.mode !== 'ready') return null"), 'failed', /section assets not rendered/],
    [componentSource.replace("  { item: 'rwa-other.exchange-flows', icon: Store, title: 'Exchange flows', detail: 'Flows to and from verified exchange addresses' },\n", ''),
      'collecting', /item rwa-other\.exchange-flows not rendered/],
  ];
  for (const [source, state, expected] of mutations) {
    assert.notEqual(source, componentSource, 'the mutation applies to the current source');
    const mutated = loadMutated(COMPONENT_PATH, source);
    assert.throws(() => checkScope(render(STATES[state], mutated.ArcIntelligenceDashboard).tree, SCOPE), expected);
  }
});

const borrowConfig = require(BORROW_CONFIG_PATH);
const libSource = UI_SOURCES[1][1];
const sectionNode = (tree, id) => byAttr(tree, 'data-intel-section', id)[0];
const widthOf = (node) => Number(/width:\s*([\d.]+)%/.exec(node.attrs.style ?? '')?.[1]);

await test('UI 17 Borrow is always present and respects the existing guarded Borrow Kit integration', async () => {
  assert.equal(borrowConfig.MAINNET_BORROW_WRITES_ENABLED, false, 'Borrow writes stay disabled');
  assert.equal(borrowConfig.MAINNET_BORROW_READ_ONLY_ENABLED, true);
  for (const [name, { tree }] of Object.entries(rendered)) {
    const section = sectionNode(tree, 'borrow');
    assert.ok(section, `${name}: Borrow section`);
    const text = textOf(section);
    for (const label of ['Borrow on Arc', 'Powered by Circle Borrow Kit on Arc', 'cirBTC', 'Collateral', 'USDC', 'Preview']) assert.ok(text.includes(label), `${name}: ${label}`);
    assert.equal([...walk(section)].filter((node) => ['button', 'a', 'form', 'input'].includes(node.tag)).length, 0,
      `${name}: no Borrow action, link or form is invented (Machina has no Borrow route)`);
    assert.equal(item(tree, 'borrow.action').attrs['data-intel-status'], 'source_pending');
    assert.match(textOf(item(tree, 'borrow.action')), /Preview only\. Borrowing from Machina is not enabled yet, so no wallet action is offered here\./);
  }
  // The dashboard reads the gate constant and the read only market listing; it can never reach a Borrow write path.
  assert.match(componentSource, /import \{ MAINNET_BORROW_WRITES_ENABLED \} from '\.\.\/config\/mainnetBorrow'/);
  assert.ok(!/from '[^']*lib\/mainnetBorrow'|import\('[^']*lib\/mainnetBorrow'\)|from '@circle-fin\/borrow-kit'/.test(componentSource),
    'the component never imports the Borrow Kit boundary or the SDK');
  assert.match(libSource, /import type \{ BorrowMarket \} from '\.\/mainnetBorrow'/);
  assert.ok(!/import\(\s*'[^']*mainnetBorrow'\s*\)|^import \{[^}]*\} from '[^']*mainnetBorrow'/m.test(libSource),
    'the browser loader never loads the Borrow Kit boundary or its SDK at runtime');
  for (const [file, source] of UI_SOURCES) {
    const write = /executeBorrowWrite|planBorrowWrite|detectAtomicBatchCapability|\bBorrowKit\b|wallet_sendCalls|wallet_getCapabilities|MAINNET_BORROW_WRITES_ENABLED\s*=/.exec(source);
    assert.equal(write, null, `${file}: no Borrow write path (${write?.[0]})`);
  }
  // The guarded integration is untouched: its only write entry point still refuses first while the gate is false.
  assert.match(readFileSync(BORROW_LIB_PATH, 'utf8'), /if \(MAINNET_BORROW_WRITES_ENABLED !== true\) return \{ status: 'refused', blockers: \['writes_disabled'\] \}/);
});

await test('UI 18 Borrow market terms are read only, exact, and omitted when the service reports none', async () => {
  const other = borrowMarketFixture({ marketId: `0x${'cd'.repeat(32)}`, collateralAsset: { symbol: 'WETH', address: '0x128cc466b61f542da60c70e3aa11c10e19b84edb', decimals: 18 } });
  let calls = 0;
  const serve = (markets) => async (url, init) => {
    calls += 1;
    assert.deepEqual([url, init.method], ['/api/borrow-markets', 'GET']);
    return { ok: true, json: async () => ({ schema: lib.BORROW_MARKETS_SCHEMA, chain: 'Arc', markets }) };
  };
  assert.deepEqual(await lib.loadArcBorrowMarkets({ fetchImpl: serve([borrowMarketFixture()]) }), BORROW_AVAILABLE);
  assert.equal(calls, 1, 'one same-origin read');
  assert.deepEqual(await lib.loadArcBorrowMarkets({ fetchImpl: serve([]) }), BORROW_UNAVAILABLE, 'no cirBTC/USDC market is unavailable, never a guess');
  assert.deepEqual(await lib.loadArcBorrowMarkets({ fetchImpl: serve([other, borrowMarketFixture()]) }), BORROW_UNAVAILABLE,
    'a market that is not exactly Arc cirBTC/USDC makes the answer unavailable (fail closed)');
  assert.deepEqual(await lib.loadArcBorrowMarkets({ fetchImpl: serve([borrowMarketFixture(), { ...borrowMarketFixture({ marketId: `0x${'ef'.repeat(32)}` }), lltv: 'high' }]) }),
    BORROW_UNAVAILABLE, 'one malformed market makes the answer unavailable');
  assert.deepEqual(await lib.loadArcBorrowMarkets({ fetchImpl: serve([borrowMarketFixture(), borrowMarketFixture()]) }), BORROW_UNAVAILABLE, 'a repeated market ID fails closed');
  assert.deepEqual(await lib.loadArcBorrowMarkets({ fetchImpl: async () => ({ ok: false, json: async () => ({ error: 'x' }) }) }), BORROW_UNAVAILABLE);
  assert.deepEqual(await lib.loadArcBorrowMarkets({ fetchImpl: async () => { throw new Error('network down'); } }), BORROW_UNAVAILABLE);
  assert.equal(lib.BORROW_MARKETS_SCHEMA, PROXY_BORROW_SCHEMA, 'browser and proxy agree on the schema');

  const terms = textOf(item(rendered.ready.tree, 'borrow.market-terms'));
  assert.equal(terms, 'Borrow APY 5.23% Liquidation LTV 86% Available liquidity 1,234,567.89 USDC');
  assert.doesNotMatch(terms, /Utilization|Total borrowed/, 'terms the service does not report are omitted, not invented');
  assert.match(textOf(item(rendered.ready.tree, 'borrow.market-list')), /Read only from Circle Borrow Kit\. Listed by market ID; the order is not a ranking\./);
  for (const [state, status] of [[BORROW_UNAVAILABLE, 'unavailable'], [{ status: 'loading' }, 'loading']]) {
    const { tree } = render({ ...STATES.collecting, borrowMarket: state });
    for (const id of ['borrow.market-list', 'borrow.market-id', 'borrow.market-terms']) {
      assert.equal(item(tree, id).attrs['data-intel-status'], status, `${status} ${id}`);
      assert.equal(item(tree, id).attrs['data-intel-value'], undefined);
    }
    assert.doesNotMatch(textOf(sectionNode(tree, 'borrow')), /\d|%/, `${status}: no Borrow number without service data`);
  }
  const silent = render({ ...STATES.collecting, borrowMarket: { status: 'available', markets: [borrowMarketFixture({ lltv: null, borrowApy: null, liquidity: null })] } }).tree;
  assert.equal(item(silent, 'borrow.market-terms').attrs['data-intel-status'], 'unavailable');
  assert.equal(textOf(item(silent, 'borrow.market-terms')), 'Terms are not reported yet', 'a market without reported terms shows no number');
  assert.equal(lib.formatRatioPercent(0.0523), '5.23%');
  assert.equal(lib.formatDecimalString('1234567.891'), '1,234,567.89');
  assert.equal(lib.formatDecimalString('0.0001'), '<0.01');
  assert.equal(lib.formatDecimalString('not a number'), null);
});

await test('UI 19 lower sections stay present and compact: one status badge per card, bars only from real counts', async () => {
  const BADGED = ['top-protocols', 'top-pools-v3', 'top-pools-v4', 'recent-activity', ...LOWER_SECTIONS];
  for (const [name, { tree }] of Object.entries(rendered)) {
    for (const id of LOWER_SECTIONS) assert.equal(byAttr(tree, 'data-intel-section', id).length, 1, `${name} ${id}`);
    for (const id of BADGED) {
      const section = sectionNode(tree, id);
      const cards = [section, ...walk(section)].filter((node) => /\brounded-2xl border border-slate-200 bg-white\b/.test(node.attrs.class ?? ''));
      assert.ok(cards.length > 0, `${name} ${id} has cards`);
      for (const card of cards) assert.ok(byAttr(card, 'data-status-pill').length <= 1, `${name} ${id}: at most one status badge per card`);
      assert.ok(![...walk(section)].some((node) => /\bmin-h-/.test(node.attrs.class ?? '')), `${name} ${id}: no tall empty panel`);
    }
  }
  for (const name of ['collecting', 'failed', ...LOADING_STATES, '7d', '30d']) {
    assert.equal(byAttr(rendered[name].tree, 'data-activity-bar').length, 0, `${name}: no activity bar without verified counts`);
    assert.equal(byAttr(rendered[name].tree, 'data-mix-segment').length, 0, `${name}: no event mix without verified counts`);
  }
  const bars = (id) => byAttr(sectionNode(rendered.ready.tree, id), 'data-activity-bar');
  const values = (nodes) => nodes.map((node) => Number(node.attrs['data-activity-value']));
  assert.deepEqual(values(bars('top-protocols')), [4321, 1234, 26, 11, 8], 'protocol activity bars are the real event counts');
  assert.deepEqual(values(bars('assets')), [5000, 321, 17, 12], 'asset bars are the real transfer counts');
  // Each bar is its count relative to the largest count beside it (CCTP: outbound and inbound only).
  for (const id of ['top-protocols', 'assets', 'cross-chain']) {
    const nodes = bars(id);
    const max = Math.max(...values(nodes));
    for (const node of nodes) {
      const value = Number(node.attrs['data-activity-value']);
      assert.ok(Math.abs(widthOf(node) - Math.max((value / max) * 100, 1.5)) < 1e-9, `${id}: ${value} drawn as ${widthOf(node)}%`);
    }
  }
  const mix = byAttr(item(rendered.ready.tree, 'lending.aave'), 'data-mix-segment');
  assert.deepEqual(mix.map((node) => [node.attrs['data-mix-segment'], Number(node.attrs['data-mix-count'])]),
    [['supplyCount', 10], ['withdrawCount', 5], ['borrowCount', 7], ['repayCount', 3], ['liquidationCount', 1]]);
  assert.ok(Math.abs(mix.reduce((sum, node) => sum + widthOf(node), 0) - 100) < 1e-9);
  assert.doesNotMatch(textOf(sectionNode(rendered.ready.tree, 'cross-chain')), /total bridge|bridge volume/i, 'directions are never summed');
});

await test('UI 20 Volume is the primary DEX view, Swaps the secondary verified view; the all-pair rule holds in every state', async () => {
  const { tree } = rendered['ready-default-view'];
  const section = sectionNode(tree, 'volume-chart');
  const tabs = [...walk(section)].filter((node) => node.tag === 'button' && node.attrs.role === 'tab');
  assert.deepEqual(tabs.map((node) => [textOf(node), node.attrs['aria-selected']]), [['Volume', 'true'], ['Swaps', 'false']]);
  assert.match(textOf(section), /DEX volume is not available yet/);
  assert.equal(item(tree, 'volume-chart.volume').attrs['data-intel-status'], 'source_pending');
  assert.equal(item(tree, 'volume-chart.swaps').attrs['data-intel-status'], 'available');
  assert.equal(item(tree, 'volume-chart.latest').attrs['data-intel-status'], 'source_pending');
  for (const [name, { tree: stateTree }] of Object.entries(rendered)) {
    for (const id of ['top-pools-v3', 'top-pools-v4']) {
      for (const column of ['all-pairs', 'volume', 'swaps', 'liquidity']) item(stateTree, `${id}.${column}`);
    }
    assert.match(textOf(sectionNode(stateTree, 'top-pools-v3')), /not only USDC pairs/, name);
    assert.match(textOf(sectionNode(stateTree, 'top-pools-v4')), /not only USDC pairs/, name);
  }
});

await test('Pools 1 Top Pools rows come from pools.v1 in service order: pair, fee, swaps; without valuation, volume and liquidity stay not available yet', async () => {
  const v3 = sectionNode(rendered.ready.tree, 'top-pools-v3');
  const v3Rows = byAttr(v3, 'data-pool-row');
  assert.deepEqual(v3Rows.map((node) => node.attrs['data-pool-row']), [V3_POOL_A, V3_POOL_B], 'kept in the ranked order the service returns');
  assert.equal(textOf(v3Rows[0]), '1 USDC / 0xabcd...1234 0.05% 4,321 swaps');
  assert.equal(textOf(v3Rows[1]), '2 USDC / EURC 0.3% 56 swaps');
  const v4Rows = byAttr(sectionNode(rendered.ready.tree, 'top-pools-v4'), 'data-pool-row');
  assert.equal(textOf(v4Rows[0]), '1 USDC / EURC 0.05% 1,234 swaps', 'native USDC is named from the verified registry');
  assert.equal(textOf(v4Rows[1]), '2 USDC / 0xabcd...1234 Dynamic fee Hooks 12 swaps');
  const unknown = [...walk(v3Rows[0])].find((node) => node.attrs.title?.startsWith(UNKNOWN_TOKEN));
  assert.equal(unknown.attrs.title, `${UNKNOWN_TOKEN} (token details not verified)`, 'the full address of an unverified token stays on hover');
  for (const id of ['top-pools-v3', 'top-pools-v4']) {
    assert.deepEqual(['all-pairs', 'swaps', 'volume', 'liquidity'].map((column) => statusIn('ready', `${id}.${column}`)),
      ['available', 'available', 'source_pending', 'source_pending'], id);
  }
  assert.equal(statusIn('mixed', 'top-pools-v3.swaps'), 'unavailable', 'a failed pools read is unavailable, never empty or zero');
  assert.equal(byAttr(sectionNode(rendered.mixed.tree, 'top-pools-v3'), 'data-pool-row').length, 0);
  assert.match(textOf(sectionNode(rendered.mixed.tree, 'top-pools-v3')), /Pool data is not verified for this window Rankings appear once every hour/);
  assert.equal(statusIn('mixed', 'top-pools-v4.swaps'), 'available', 'one failed read never hides the other');
  assert.equal(statusIn('collecting', 'top-pools-v3.swaps'), 'collecting');
  for (const name of ['failed', ...LOADING_STATES, '7d', '30d']) {
    assert.equal(byAttr(rendered[name].tree, 'data-pool-row').length, 0, `${name}: no pool rows without a ready, complete window read`);
  }
});

await test('Activity 1 Recent Activity rows: type, protocol, pair, exact token amounts, From sender, To only from the event, Tx', async () => {
  const section = sectionNode(rendered.ready.tree, 'recent-activity');
  const rows = byAttr(section, 'data-activity-row');
  assert.deepEqual(rows.map((node) => node.attrs['data-activity-row']), [TX(0xab01), TX(0xab02), TX(0xab03), TX(0xab04)], 'newest first, as served');
  const cells = (node) => textOf(node);
  assert.equal(cells(rows[0]), 'Time (UTC) Oct 3, 13:01 Type Swap Protocol Uniswap V3 Pair USDC / EURC Amount 1.5 USDC to pool 1.4 EURC from pool '
    + 'From 0x5e5e...5e5e To 0x7e7e...7e7e Tx 0x0000...ab01');
  assert.equal(cells(rows[1]), 'Time (UTC) Oct 3, 13:02 Type Swap Protocol Uniswap V4 Pair USDC / EURC Amount 2 USDC to pool 1.9 EURC from pool '
    + 'From 0x5e5e...5e5e To Unavailable Tx 0x0000...ab02', 'a V4 swap records no recipient: To reads unavailable');
  assert.equal(cells(rows[2]), 'Time (UTC) Oct 3, 13:03 Type Add Protocol Uniswap V3 Pair USDC / 0xabcd...1234 Amount 2.5 USDC Raw amount 0xabcd...1234 123 '
    + 'From 0x5e5e...5e5e To 0x0e0e...0e0e Tx 0x0000...ab03', 'an unverified token keeps its exact raw amount, behind a short label');
  assert.equal(cells(rows[3]), 'Time (UTC) Oct 3, 13:04 Type Remove Protocol Uniswap V4 Pair USDC / EURC Amount Token amounts not recorded '
    + 'From 0x5e5e...5e5e To 0x5a5a...5a5a Tx 0x0000...ab04', 'V4 liquidity changes carry no token amounts');
  assert.equal(byAttr(section, 'href').length, 0, 'without the page explorer URL no link is invented');
  const linked = sectionNode(rendered['ready-swaps-tab'].tree, 'recent-activity');
  const links = [...walk(linked)].filter((node) => node.tag === 'a');
  assert.deepEqual(links.map((node) => [node.attrs.href, node.attrs.rel, node.attrs.target]), [[`https://explorer.arc.io/tx/${TX(0xab01)}`, 'noopener noreferrer', '_blank'],
    [`https://explorer.arc.io/tx/${TX(0xab02)}`, 'noopener noreferrer', '_blank']]);
  assert.doesNotMatch(textOf(section), /\$|USD\b/, 'no USD conversion');
});

await test('Activity 3 a huge raw amount stays compact with its exact value one tap away; events of one transaction carry their log number', async () => {
  const HUGE = '19824699890742085728050';
  const shared = TX(0xcafe);
  const first = { ...ROWS.v3Swap, txHash: shared, logIndex: 31, pair: V3_UNKNOWN_PAIR,
    amounts: { status: 'available', basis: 'v3_pool_delta', amount0Raw: '641423', amount1Raw: `-${HUGE}` } };
  const second = { ...first, logIndex: 27, amounts: { status: 'available', basis: 'v3_pool_delta', amount0Raw: '550400', amount1Raw: '-489258' } };
  const { tree } = render({ ...STATES.ready, data: { ...READY_DATA, activity: { ...ACTIVITY_READY, all: activityFixture('all', [first, second, ROWS.v4Swap]) } } });
  const rows = byAttr(sectionNode(tree, 'recent-activity'), 'data-activity-row');
  assert.deepEqual(rows.map((node) => node.attrs['data-log-index']), ['31', '27', '0']);
  assert.match(textOf(rows[0]), /Tx 0x0000\.\.\.cafe Log #31$/);
  assert.match(textOf(rows[1]), /Tx 0x0000\.\.\.cafe Log #27$/, 'separate events of one transaction are never merged and never look identical');
  assert.doesNotMatch(textOf(rows[2]), /Log #/, 'a single-event transaction carries no log number');
  const details = [...walk(rows[0])].find((node) => node.tag === 'details');
  const summary = details.children.find((node) => node.tag === 'summary');
  assert.equal(textOf(summary), 'Raw amount 0xabcd...1234 from pool', 'the visible line never prints the huge integer');
  assert.equal(details.attrs.title, `Exact raw amount: ${HUGE}`);
  assert.ok(textOf(details).endsWith(HUGE), 'the exact raw integer is kept, one tap away');
  assert.match(textOf(rows[0]), /Amount 0\.64 USDC to pool Raw amount/, 'a verified stablecoin reads in cents');
  const visibleText = (node) => (node.tag === 'details' ? textOf(node.children.find((child) => child.tag === 'summary'))
    : node.tag === '#text' ? node.text : node.children.map(visibleText).join(' ')).replace(/\s+/g, ' ').trim();
  assert.doesNotMatch(visibleText(sectionNode(tree, 'recent-activity')), /raw units|e\+\d|\d{16}/i, 'no long raw number is printed in the table itself');
});

await test('Activity 2 the All, Swaps, Adds and Removes tabs read their own exact filters; a failed filter is unavailable on its own', async () => {
  const swapsTab = rendered['ready-swaps-tab'].tree;
  assert.deepEqual(byAttr(sectionNode(swapsTab, 'recent-activity'), 'data-activity-row').map((node) => node.attrs['data-activity-row']), [TX(0xab01), TX(0xab02)]);
  const selected = [...walk(sectionNode(swapsTab, 'recent-activity'))].filter((node) => node.tag === 'button' && node.attrs['aria-selected'] === 'true').map(textOf);
  assert.deepEqual(selected, ['Swaps']);
  for (const type of ['all', 'swaps', 'adds', 'removes']) assert.equal(statusIn('ready', `recent-activity.${type}`), 'available', type);
  assert.deepEqual(['all', 'swaps', 'adds', 'removes'].map((type) => statusIn('mixed', `recent-activity.${type}`)), ['available', 'unavailable', 'available', 'available']);
  const failedSwaps = render({ ...STATES.mixed, initialActivityType: 'swaps' }).tree;
  assert.equal(byAttr(sectionNode(failedSwaps, 'recent-activity'), 'data-activity-row').length, 0);
  assert.match(textOf(sectionNode(failedSwaps, 'recent-activity')), /The verified activity feed is not available right now/);
  assert.equal(item(failedSwaps, 'recent-activity.time').attrs['data-intel-status'], 'unavailable');
  for (const [type, url] of [['all', 'activityAll'], ['swaps', 'activitySwaps'], ['adds', 'activityAdds'], ['removes', 'activityRemoves']]) {
    const parsed = new URL(lib.ARC_INTELLIGENCE_REQUESTS[url], 'https://machina.example');
    assert.deepEqual(Object.fromEntries(parsed.searchParams), { view: 'activity', type });
    assert.ok(resolveIntelligenceRoute(Object.fromEntries(parsed.searchParams)), `${type} is an exact proxy route`);
  }
});

await test('Pools and activity loader: exact shapes only; any malformed field, wrong filter or invented recipient fails that read closed', async () => {
  const bodies = new Map([[lib.ARC_INTELLIGENCE_REQUESTS.summary24h, summaryFixture()], [lib.ARC_INTELLIGENCE_REQUESTS.timeseries24h, timeseriesFixture()],
    [lib.ARC_INTELLIGENCE_REQUESTS.poolsV3_24h, POOLS_READY.v3], [lib.ARC_INTELLIGENCE_REQUESTS.poolsV4_24h, POOLS_READY.v4],
    ...['all', 'swaps', 'adds', 'removes'].map((type) => [lib.ARC_INTELLIGENCE_REQUESTS[`activity${type[0].toUpperCase()}${type.slice(1)}`], ACTIVITY_READY[type]])]);
  const serve = (override = {}) => async (url) => (Object.hasOwn(override, url) && override[url] === 'down'
    ? { ok: false, json: async () => ({}) } : { ok: true, json: async () => structuredClone(Object.hasOwn(override, url) ? override[url] : bodies.get(url)) });
  const loaded = await lib.loadArcIntelligence('24h', { fetchImpl: serve() });
  assert.deepEqual([loaded.failed, loaded.pools.v3.pools.length, loaded.pools.v4.pools.length, loaded.activity.all.rows.length, loaded.activity.removes.rows.length],
    [false, 2, 2, 4, 1]);
  const one = (url, body) => lib.loadArcIntelligence('24h', { fetchImpl: serve({ [url]: body }) });
  const R = lib.ARC_INTELLIGENCE_REQUESTS;
  const v3 = (mutate) => { const body = structuredClone(POOLS_READY.v3); mutate(body); return body; };
  const all = (mutate) => { const body = structuredClone(ACTIVITY_READY.all); mutate(body); return body; };
  const poolCases = [v3((body) => { body.pools[0].flowsRaw.token0In = '1.5'; }), v3((body) => { body.protocol = 'v4'; }), v3((body) => { body.window.key = '6h'; }),
    v3((body) => { body.pools[0].token1.symbol = 'USDC'; }), v3((body) => { body.pools[0].hooks = HOOKS; }), v3((body) => { body.ranking.by = 'volume'; }),
    v3((body) => { body.pools = [...body.pools, ...Array.from({ length: 9 }, () => body.pools[1])]; }), 'down'];
  for (const body of poolCases) {
    const result = await one(R.poolsV3_24h, body);
    assert.equal(result.pools.v3, null, JSON.stringify(body).slice(0, 80));
    assert.ok(result.pools.v4 && result.activity.all && result.summary, 'only the failed read is null');
  }
  const activityCases = [all((body) => { body.rows[1].to = RECIPIENT; }), all((body) => { body.rows[0].to = null; }), all((body) => { body.rows[0].from = 'router'; }),
    all((body) => { body.rows[3].amounts = { status: 'available', basis: 'none', amount0Raw: '1', amount1Raw: '1' }; }),
    all((body) => { body.rows[2].amounts.amount0Raw = '-5'; }), all((body) => { body.type = 'swaps'; }), all((body) => { body.rows[0].toKind = 'event_sender'; })];
  for (const body of activityCases) assert.equal((await one(R.activityAll, body)).activity.all, null, JSON.stringify(body).slice(0, 80));
  assert.equal((await one(R.activitySwaps, activityFixture('swaps', [ROWS.v3Swap, ROWS.v3Add]))).activity.swaps, null, 'a filter must only hold its own kind');
  const unavailable = activityFixture('all', [], { status: 'unavailable', reason: 'projection_not_processed' });
  assert.deepEqual((await one(R.activityAll, unavailable)).activity.all, unavailable, 'an unavailable feed is kept as such, never shown as empty activity');
});

// ---------------------------------------------------------------------------------------------------------------------
// Read-only Borrow market proxy (/api/borrow-markets). Upstream calls go to fetch doubles; no external network.

const rawMarket = (overrides = {}) => ({
  marketId: `0x${'ab'.repeat(32)}`, protocol: 'morpho', chain: 'ARC',
  loanAsset: { symbol: 'USDC', address: USDC, decimals: 6 },
  collateralAsset: { symbol: 'cirBTC', address: '0x171A4217b86A807A64eB94757Db6849fb4bDbAA0', decimals: 8 },
  lltv: 0.86, borrowCap: null, borrowAssets: { raw: '191321039940000', decimals: 6 }, liquidity: { raw: '3850000', decimals: 6 },
  borrowApy: 0.0096, utilization: 1, refreshedAt: '2026-10-03T22:14:00.000Z', ...overrides,
});
const rawPage = (markets = [rawMarket()]) => ({ data: { markets, pagination: {} } });
const wethMarket = rawMarket({ marketId: `0x${'cd'.repeat(32)}`, collateralAsset: { symbol: 'WETH', address: '0x128cc466b61f542da60c70e3aa11c10e19b84edb', decimals: 18 } });
const BORROW_PROXY_PATH = sourcePath('api/_lib/borrow-markets-proxy.js');
const borrowProxySource = readFileSync(BORROW_PROXY_PATH, 'utf8');
const BORROW_ERROR = '{"error":"Borrow market data is temporarily unavailable"}';

async function borrowCall(request = {}, upstreamImpl = async () => upstream({ body: rawPage() })) {
  const seen = [];
  let sent = null;
  await handleBorrowMarketsProxy({
    method: 'GET', headers: {}, query: {}, ...request,
    send: (response) => { sent = response; },
    fetchImpl: async (url, options) => {
      seen.push({ url, options });
      return upstreamImpl(url, options);
    },
  });
  assert.ok(sent, 'every request gets exactly one response');
  return { ...sent, seen, json: () => JSON.parse(sent.body) };
}

await test('Borrow proxy 1 the browser card reads only the same-origin proxy: no Circle URL and no Borrow SDK in the browser path', async () => {
  for (const [file, source] of UI_SOURCES) assert.equal(/api\.circle\.com|circle\.com\//i.test(source), false, `${file} contains no Circle URL`);
  assert.equal(lib.ARC_BORROW_MARKETS_REQUEST, '/api/borrow-markets');
  const calls = [];
  const state = await lib.loadArcBorrowMarkets({ fetchImpl: async (url, init) => {
    calls.push([url, init.method]);
    return { ok: true, json: async () => (await borrowCall()).json() };
  } });
  assert.deepEqual(calls, [['/api/borrow-markets', 'GET']]);
  assert.equal(state.status, 'available');
});

await test('Borrow proxy 2 GET only: other methods, request bodies and any query parameter are refused without an upstream call', async () => {
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']) {
    const res = await borrowCall({ method }, noFetch);
    assert.equal(res.status, 405, method);
    assert.equal(res.headers.Allow, 'GET');
    assert.equal(res.headers['Cache-Control'], 'no-store');
    assert.equal(res.seen.length, 0, method);
  }
  for (const headers of [{ 'content-length': '12' }, { 'transfer-encoding': 'chunked' }]) {
    const res = await borrowCall({ headers }, noFetch);
    assert.equal(res.status, 400);
    assert.equal(res.seen.length, 0);
  }
  for (const query of [{ url: 'https://evil.example' }, { chain: 'ETH' }, { pageSize: '100' }, { path: '../loans' }, { marketId: '0x1' }]) {
    const res = await borrowCall({ query }, noFetch);
    assert.equal(res.status, 400, JSON.stringify(query));
    assert.equal(res.seen.length, 0);
  }
});

await test('Borrow proxy 3 the upstream is one fixed keyless Circle URL; no client header, cookie or credential is forwarded', async () => {
  const res = await borrowCall({ headers: { cookie: 'session=secret', authorization: 'Bearer secret', 'x-api-key': 'key', host: 'evil.example',
    'x-forwarded-host': 'evil.example' } });
  assert.equal(res.status, 200);
  assert.equal(res.seen.length, 1);
  assert.equal(res.seen[0].url, 'https://api.circle.com/v1/borrowKit/markets?chain=ARC&pageSize=20');
  assert.equal(BORROW_MARKETS_UPSTREAM_URL, res.seen[0].url);
  assert.deepEqual(res.seen[0].options.headers, { accept: 'application/json' });
  assert.equal(res.seen[0].options.method, 'GET');
  assert.equal(res.seen[0].options.redirect, 'manual');
  assert.ok(res.seen[0].options.signal instanceof AbortSignal, 'the request carries the timeout signal');
  assert.match(borrowProxySource, /const REQUEST_TIMEOUT_MS = 8_000/);
  assert.equal([...borrowProxySource.matchAll(/fetchImpl\(/g)].length, 1, 'exactly one upstream request exists');
  assert.match(borrowProxySource, /const UPSTREAM_URL = 'https:\/\/api\.circle\.com\/v1\/borrowKit\/markets\?chain=ARC&pageSize=20'/);
  assert.doesNotMatch(borrowProxySource, /\$\{(query|headers|req|method|url)\b/, 'no request input is interpolated into the upstream URL');
  assert.doesNotMatch(borrowProxySource, /process\.env|apiKey|api_key|authorization|privateKey|from '[^']*(mainnetBorrow|borrow-kit)/i,
    'no credential, key, environment value or SDK on this path');
});

await test('Borrow proxy 4 upstream failures become fixed, sanitized, uncached errors', async () => {
  const secret = 'internal upstream detail 10.0.0.7 token=abc';
  const cases = [
    [async () => upstream({ status: 500, text: secret }), 503],
    [async () => upstream({ status: 503, text: secret }), 503],
    [async () => upstream({ status: 404, text: secret }), 502],
    [async () => upstream({ status: 429, text: secret }), 502],
    [async () => upstream({ status: 302, text: secret, headers: { location: 'https://evil.example' } }), 502],
    [async () => { throw new Error(secret); }, 503],
    [async () => { throw Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }); }, 503],
    [async () => upstream({ text: `not json ${secret}` }), 502],
    [async () => upstream({ text: `"${'x'.repeat(300 * 1024)}"` }), 502],
    [async () => upstream({ body: [] }), 502],
    [async () => upstream({ body: { data: { markets: 'nope' } } }), 502],
    [async () => upstream({ body: rawPage([rawMarket({ chain: 'ETH' })]) }), 502],
    [async () => upstream({ body: rawPage([rawMarket({ protocol: 'aave' })]) }), 502],
    [async () => upstream({ body: rawPage([rawMarket({ marketId: 'x' })]) }), 502],
    [async () => upstream({ body: rawPage([rawMarket({ lltv: -1 })]) }), 502],
    [async () => upstream({ body: rawPage([rawMarket({ liquidity: { raw: '1.5', decimals: 6 } })]) }), 502],
    [async () => upstream({ body: rawPage([wethMarket, rawMarket({ loanAsset: { symbol: 'USDC', address: 'nope', decimals: 6 } })]) }), 502],
    // A canonical token address reported with another identity cannot be verified: fail closed.
    [async () => upstream({ body: rawPage([rawMarket({ collateralAsset: { symbol: 'BTC', address: CIRBTC, decimals: 8 } })]) }), 502],
    [async () => upstream({ body: rawPage([rawMarket({ loanAsset: { symbol: 'USDC', address: USDC, decimals: 18 } })]) }), 502],
    [async () => upstream({ body: rawPage([rawMarket(), rawMarket()]) }), 502],
  ];
  for (const [upstreamImpl, status] of cases) {
    const res = await borrowCall({}, upstreamImpl);
    assert.equal(res.status, status);
    assert.equal(res.body, BORROW_ERROR, 'no upstream text, status or address leaks');
    assert.deepEqual(Object.keys(res.headers).sort(), ['Cache-Control', 'Content-Type']);
    assert.equal(res.headers['Cache-Control'], 'no-store');
  }
});

await test('Borrow proxy 5 success is short-lived CDN cacheable and mapped exactly like Borrow Kit: exact amounts, nulls stay null', async () => {
  const res = await borrowCall({}, async () => upstream({ body: rawPage([rawMarket({ utilization: null, borrowAssets: null })]),
    headers: { 'set-cookie': 'a=b', 'x-internal': 'secret', etag: '"abc"' } }));
  assert.equal(res.status, 200);
  assert.equal(BORROW_CACHE_CONTROL, 'public, s-maxage=300, stale-while-revalidate=300');
  assert.deepEqual(res.headers, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': BORROW_CACHE_CONTROL },
    'only the proxy\'s own headers; no upstream header passes');
  assert.deepEqual(res.json(), { schema: 'machina.borrow.markets.v2', chain: 'Arc',
    pair: { collateral: { symbol: 'cirBTC', address: CIRBTC, decimals: 8 }, loan: { symbol: 'USDC', address: USDC, decimals: 6 } }, markets: [{
    marketId: `0x${'ab'.repeat(32)}`, protocol: 'morpho',
    loanAsset: { symbol: 'USDC', address: USDC, decimals: 6 },
    collateralAsset: { symbol: 'cirBTC', address: '0x171A4217b86A807A64eB94757Db6849fb4bDbAA0', decimals: 8 },
    lltv: 0.86, borrowApy: 0.0096, utilization: null, borrowAssets: null,
    liquidity: { token: 'USDC', tokenAddress: USDC, amount: '3.85', decimals: 6 }, refreshedAt: '2026-10-03T22:14:00.000Z' }] });
  const amount = (raw, decimals) => normalizeBorrowMarketsPage(rawPage([rawMarket({ borrowAssets: { raw, decimals } })]))[0].borrowAssets.amount;
  assert.equal(amount('191321039940000', 6), '191321039.94');
  assert.equal(amount('7', 0), '7');
  assert.equal(amount('1', 18), '0.000000000000000001');
  assert.equal(amount('115792089237316195423570985008687907853269984665640564039457584007913129639935', 6),
    '115792089237316195423570985008687907853269984665640564039457584007913129.639935');
  await withFetch(async () => upstream({ body: rawPage() }), async (seen) => {
    const ok = responseDouble();
    await borrowHandler({ method: 'GET', headers: {}, query: {} }, ok);
    assert.equal(ok.statusCode, 200);
    assert.equal(ok.header('cache-control'), BORROW_CACHE_CONTROL);
    assert.equal(seen.length, 1);
    const post = responseDouble();
    await borrowHandler({ method: 'POST', headers: {}, query: {} }, post);
    assert.equal(post.statusCode, 405);
    assert.equal(post.header('allow'), 'GET');
    assert.equal(seen.length, 1, 'the Vercel entry point never calls upstream for a refused request');
  });
});

await test('Borrow proxy 6 the Borrow write gate stays false and untouched; nothing on the market path can write', async () => {
  assert.equal(borrowConfig.MAINNET_BORROW_WRITES_ENABLED, false);
  assert.match(readFileSync(BORROW_CONFIG_PATH, 'utf8'), /export const MAINNET_BORROW_WRITES_ENABLED: boolean = false\n/);
  assert.match(readFileSync(BORROW_LIB_PATH, 'utf8'), /if \(MAINNET_BORROW_WRITES_ENABLED !== true\) return \{ status: 'refused', blockers: \['writes_disabled'\] \}/);
  for (const file of ['api/_lib/borrow-markets-proxy.js', 'api/borrow-markets.js', 'src/lib/arcIntelligence.ts', 'src/components/ArcIntelligenceOverview.tsx']) {
    const source = readFileSync(sourcePath(file), 'utf8');
    const write = /executeBorrowWrite|planBorrowWrite|MAINNET_BORROW_WRITES_ENABLED\s*=|wallet_sendCalls|eth_sendTransaction|signTypedData|privateKey|\/loans/.exec(source);
    assert.equal(write, null, `${file}: no write path (${write?.[0]})`);
    assert.doesNotMatch(source, /method:\s*'(POST|PUT|PATCH|DELETE)'/, `${file}: no write request`);
  }
});

await test('Borrow proxy 7 when the proxy or Circle fails the Borrow card stays, market terms read unavailable, Preview is unchanged', async () => {
  const viaProxy = (upstreamImpl) => async (url, init) => {
    assert.equal(url, '/api/borrow-markets');
    const res = await borrowCall({ method: init.method }, upstreamImpl);
    return { ok: res.status === 200, json: async () => JSON.parse(res.body) };
  };
  const failures = [async () => upstream({ status: 500, text: 'boom' }), async () => { throw new Error('down'); },
    async () => upstream({ body: rawPage([rawMarket({ chain: 'ETH' })]) }), async () => upstream({ body: rawPage([wethMarket]) })];
  for (const upstreamImpl of failures) {
    const state = await lib.loadArcBorrowMarkets({ fetchImpl: viaProxy(upstreamImpl) });
    assert.deepEqual(state, { status: 'unavailable' });
    for (const base of [STATES.ready, STATES.collecting, STATES.failed]) {
      const { tree } = render({ ...base, borrowMarket: state });
      checkScope(tree, SCOPE);
      const section = sectionNode(tree, 'borrow');
      assert.equal(item(tree, 'borrow.market-terms').attrs['data-intel-status'], 'unavailable');
      assert.match(textOf(section), /Market terms could not be read right now\./);
      assert.match(textOf(section), /Preview only\. Borrowing from Machina is not enabled yet, so no wallet action is offered here\./);
      assert.equal([...walk(section)].filter((node) => ['button', 'a', 'form', 'input'].includes(node.tag)).length, 0);
      assert.doesNotMatch(textOf(section), /\d|%/, 'no Borrow number without a verified answer');
    }
  }
  const state = await lib.loadArcBorrowMarkets({ fetchImpl: viaProxy(async () => upstream({ body: rawPage([wethMarket, rawMarket()]) })) });
  assert.equal(state.status, 'available');
  const { tree } = render({ ...STATES.ready, borrowMarket: state });
  assert.match(textOf(item(tree, 'borrow.market-terms')),
    /Borrow APY 0\.96% Liquidation LTV 86% Utilization 100% Available liquidity 3\.85 USDC/);
});

// Several compatible Arc cirBTC/USDC markets: all of them are listed, none is picked.
const ID_LOW = `0x${'0a'.repeat(32)}`;
const ID_HIGH = `0x${'f1'.repeat(32)}`;
const marketLow = rawMarket({ marketId: ID_LOW, borrowApy: 0.006443, liquidity: { raw: '0', decimals: 6 }, borrowAssets: { raw: '15034169889', decimals: 6 } });
const marketHigh = rawMarket({ marketId: ID_HIGH, borrowApy: 0.009615, liquidity: { raw: '3855512', decimals: 6 } });
const FAKE_CIRBTC = '0x1111111111111111111111111111111111111111';
const FAKE_USDC = '0x2222222222222222222222222222222222222222';
const spoofBoth = rawMarket({ marketId: `0x${'5a'.repeat(32)}`, collateralAsset: { symbol: 'cirBTC', address: FAKE_CIRBTC, decimals: 8 },
  loanAsset: { symbol: 'USDC', address: FAKE_USDC, decimals: 6 } });
const spoofLoan = rawMarket({ marketId: `0x${'5b'.repeat(32)}`, loanAsset: { symbol: 'USDC', address: FAKE_USDC, decimals: 6 } });
const spoofCollateral = rawMarket({ marketId: `0x${'5c'.repeat(32)}`, collateralAsset: { symbol: 'cirBTC', address: FAKE_CIRBTC, decimals: 8 } });
const throughProxy = (upstreamImpl) => async (url, init) => {
  assert.equal(url, '/api/borrow-markets');
  const res = await borrowCall({ method: init.method }, upstreamImpl);
  return { ok: res.status === 200, json: async () => JSON.parse(res.body) };
};
async function borrowView(markets) {
  const state = await lib.loadArcBorrowMarkets({ fetchImpl: throughProxy(async () => upstream({ body: rawPage(markets) })) });
  const { tree } = render({ ...STATES.ready, borrowMarket: state });
  return { state, tree, section: sectionNode(tree, 'borrow') };
}
const listedIds = (tree) => byAttr(tree, 'data-intel-item', 'borrow.market-id').map((node) => node.attrs['data-intel-value']);

await test('Borrow markets 1 two compatible cirBTC/USDC markets both render, each with its own verified terms and market ID', async () => {
  const { state, tree, section } = await borrowView([marketHigh, marketLow]);
  assert.equal(state.status, 'available');
  assert.equal(state.markets.length, 2);
  assert.equal('market' in state, false, 'there is no single selected market');
  assert.deepEqual(listedIds(tree), [ID_LOW, ID_HIGH]);
  assert.deepEqual(byAttr(tree, 'data-intel-item', 'borrow.market-terms').map(textOf), [
    'Borrow APY 0.64% Liquidation LTV 86% Utilization 100% Available liquidity 0 USDC',
    'Borrow APY 0.96% Liquidation LTV 86% Utilization 100% Available liquidity 3.85 USDC',
  ]);
  assert.match(textOf(section), /Market 1 0x0a0a\.\.\.0a0a .*Market 2 0xf1f1\.\.\.f1f1/);
  assert.equal(item(tree, 'borrow.market-list').attrs['data-intel-value'], '2');
  checkScope(tree, SCOPE);
});

await test('Borrow markets 2 reversed upstream order gives the same order on screen (market ID ascending, display only)', async () => {
  const forward = await borrowView([marketLow, marketHigh]);
  const reversed = await borrowView([marketHigh, marketLow]);
  assert.deepEqual(listedIds(forward.tree), [ID_LOW, ID_HIGH]);
  assert.deepEqual(listedIds(reversed.tree), [ID_LOW, ID_HIGH]);
  assert.equal(textOf(forward.section), textOf(reversed.section));
  const forwardBody = (await borrowCall({}, async () => upstream({ body: rawPage([marketLow, marketHigh]) }))).body;
  const reversedBody = (await borrowCall({}, async () => upstream({ body: rawPage([marketHigh, marketLow]) }))).body;
  assert.equal(forwardBody, reversedBody, 'the proxy answer does not depend on upstream order');
  const shuffled = await lib.loadArcBorrowMarkets({ fetchImpl: async () => ({ ok: true,
    json: async () => ({ schema: lib.BORROW_MARKETS_SCHEMA, markets: JSON.parse(forwardBody).markets.reverse() }) }) });
  assert.deepEqual(shuffled.markets.map((entry) => entry.marketId), [ID_LOW, ID_HIGH], 'the browser orders by market ID as well');
  assert.match(textOf(forward.section), /Listed by market ID; the order is not a ranking\./);
});

await test('Borrow markets 3 no best, recommended or primary market and no automatic selection anywhere', async () => {
  const { section } = await borrowView([marketHigh, marketLow]);
  assert.doesNotMatch(textOf(section), /best|recommend|primary|preferred|default|suggested|top market|selected|highest|largest/i);
  assert.equal([...walk(section)].filter((node) => ['button', 'a', 'form', 'input', 'select', 'option', 'label'].includes(node.tag)
    || ['radio', 'radiogroup', 'option', 'listbox', 'checkbox'].includes(node.attrs.role)).length, 0, 'no selection control');
  assert.equal(byAttr(section, 'data-status-pill').length, 0, 'no badge marks a market');
  assert.equal(new Set(byAttr(section, 'data-intel-item', 'borrow.market-id').map((node) => node.parent.attrs.class)).size, 1,
    'every listed market has the same markup; none is emphasised');
  for (const [file, source] of [['component', componentSource], ['lib', libSource], ['proxy', borrowProxySource]]) {
    assert.equal(/recommendedMarket|bestMarket|primaryMarket|preferredMarket|selectedMarket|defaultMarket|isRecommended|isBest|isPrimary/.exec(source), null, file);
    assert.equal(/markets?\.find\(|\.find\(\(entry\) => entry\.collateralAsset/.exec(source), null, `${file}: no single market is picked out of the list`);
  }
});

await test('Borrow markets 4 a token that only claims the cirBTC or USDC symbol is never accepted; identity is the verified registry', async () => {
  const body = (await borrowCall({}, async () => upstream({ body: rawPage([spoofBoth, spoofLoan, spoofCollateral, marketLow]) }))).json();
  assert.deepEqual(body.markets.map((entry) => entry.marketId), [ID_LOW], 'symbol-only tokens are not the Arc cirBTC/USDC pair');
  const { state, tree } = await borrowView([spoofBoth, spoofLoan, spoofCollateral, marketLow]);
  assert.deepEqual(state.markets.map((entry) => entry.marketId), [ID_LOW]);
  assert.deepEqual(listedIds(tree), [ID_LOW]);
  assert.deepEqual((await borrowView([spoofBoth, spoofLoan])).state, { status: 'unavailable' });
  const direct = await lib.loadArcBorrowMarkets({ fetchImpl: async () => ({ ok: true,
    json: async () => ({ schema: lib.BORROW_MARKETS_SCHEMA, markets: normalizeBorrowMarketsPage(rawPage([spoofBoth])) }) }) });
  assert.deepEqual(direct, { status: 'unavailable' }, 'a spoof handed straight to the browser fails closed');
  // Even with no amount carrying the fake address, the browser checks token addresses, not symbols.
  for (const spoof of [spoofBoth, spoofLoan, spoofCollateral]) {
    const bare = { ...normalizeBorrowMarketsPage(rawPage([spoof]))[0], liquidity: null, borrowAssets: null };
    const state = await lib.loadArcBorrowMarkets({ fetchImpl: async () => ({ ok: true, json: async () => ({ schema: lib.BORROW_MARKETS_SCHEMA, markets: [bare] }) }) });
    assert.deepEqual(state, { status: 'unavailable' }, `browser rejects ${bare.marketId.slice(0, 6)} by address`);
  }
  assert.deepEqual({ ...BORROW_COLLATERAL_ASSET }, { symbol: 'cirBTC', address: CIRBTC, decimals: 8 });
  assert.deepEqual({ ...BORROW_LOAN_ASSET }, { symbol: 'USDC', address: USDC, decimals: 6 });
  assert.deepEqual([lib.ARC_BORROW_COLLATERAL_TOKEN, lib.ARC_BORROW_LOAN_TOKEN], [CIRBTC, USDC]);
  assert.deepEqual([lib.ARC_KNOWN_TOKENS[CIRBTC], lib.ARC_KNOWN_TOKENS[USDC]], [{ symbol: 'cirBTC', decimals: 8 }, { symbol: 'USDC', decimals: 6 }]);
  for (const conflict of [rawMarket({ collateralAsset: { symbol: 'cirBTC.e', address: CIRBTC, decimals: 8 } }),
    rawMarket({ loanAsset: { symbol: 'USDC', address: USDC, decimals: 18 } })]) {
    assert.equal((await borrowCall({}, async () => upstream({ body: rawPage([marketLow, conflict]) }))).status, 502,
      'a canonical address with another identity cannot be verified: fail closed');
  }
  assert.deepEqual(compatibleBorrowMarkets(normalizeBorrowMarketsPage(rawPage([spoofBoth]))), []);
});

await test('Borrow markets 5 one malformed market fails the whole answer closed, and the Borrow card stays', async () => {
  const broken = rawMarket({ marketId: `0x${'77'.repeat(32)}`, borrowApy: 'high' });
  const res = await borrowCall({}, async () => upstream({ body: rawPage([marketLow, marketHigh, broken]) }));
  assert.equal(res.status, 502);
  assert.equal(res.body, BORROW_ERROR);
  const { state, tree, section } = await borrowView([marketLow, marketHigh, broken]);
  assert.deepEqual(state, { status: 'unavailable' });
  assert.equal(item(tree, 'borrow.market-list').attrs['data-intel-status'], 'unavailable');
  assert.match(textOf(section), /Market terms could not be read right now\./);
  assert.doesNotMatch(textOf(section), /\d|%/, 'not a single term of the valid markets is shown from a rejected answer');
  checkScope(tree, SCOPE);
});

await test('Borrow markets 6 zero compatible markets keep the Borrow section visible with market terms unavailable', async () => {
  const res = await borrowCall({}, async () => upstream({ body: rawPage([wethMarket]) }));
  assert.equal(res.status, 200);
  assert.deepEqual(res.json().markets, []);
  for (const markets of [[], [wethMarket]]) {
    const { state, tree, section } = await borrowView(markets);
    assert.deepEqual(state, { status: 'unavailable' });
    for (const id of ['borrow.route', 'borrow.market-list', 'borrow.market-id', 'borrow.market-terms', 'borrow.action']) item(tree, id);
    assert.equal(item(tree, 'borrow.market-list').attrs['data-intel-status'], 'unavailable');
    assert.match(textOf(section), /Market terms could not be read right now\./);
    assert.doesNotMatch(textOf(section), /\d|%/);
    checkScope(tree, SCOPE);
  }
});

await test('Borrow markets 7 with several markets listed, writes stay false and no button, form, selection or action appears', async () => {
  assert.equal(borrowConfig.MAINNET_BORROW_WRITES_ENABLED, false);
  const { tree, section } = await borrowView([marketHigh, marketLow]);
  assert.equal([...walk(section)].filter((node) => ['button', 'a', 'form', 'input', 'select', 'textarea'].includes(node.tag)).length, 0);
  assert.equal(item(tree, 'borrow.action').attrs['data-intel-status'], 'source_pending');
  assert.match(textOf(item(tree, 'borrow.action')), /Preview only\. Borrowing from Machina is not enabled yet, so no wallet action is offered here\./);
  assert.match(textOf(section), /Preview/);
  for (const [file, source] of [['component', componentSource], ['lib', libSource], ['proxy', borrowProxySource]]) {
    assert.equal(/executeBorrowWrite|planBorrowWrite|MAINNET_BORROW_WRITES_ENABLED\s*=|onClick=\{[^}]*[Bb]orrow/.exec(source), null, file);
  }
});

// ---------------------------------------------------------------------------------------------------------------------
// Scope contract locks: Recent Activity columns, From/To semantics, Liquidity meaning, Volume as the primary metric.

const SEMANTICS = scopeModule.ARC_INTELLIGENCE_FIELD_SEMANTICS;
const scopeItem = (id) => SCOPE.flatMap((section) => section.items).find((entry) => entry.id === id);
const RECENT_COLUMNS = [['recent-activity.time', 'Time (UTC)'], ['recent-activity.type', 'Type'], ['recent-activity.protocol', 'Protocol'],
  ['recent-activity.pair', 'Pair'], ['recent-activity.amounts', 'Amount'], ['recent-activity.from', 'From'], ['recent-activity.to', 'To'],
  ['recent-activity.transaction-links', 'Tx']];
const TO_NOTE = 'From is the wallet that sent the transaction. To is shown only when the event itself records the recipient or owner; otherwise it reads unavailable.';
const ROUTER_AS_RECIPIENT = /router|tx\.to|called contract|transaction recipient/i;
const UI_CODE = [['component', componentSource], ['lib', libSource]];

function assertToSemantics(tree, name) {
  const text = textOf(sectionNode(tree, 'recent-activity'));
  if (!text.includes(TO_NOTE)) throw new Error(`${name}: To semantics note missing`);
  if (ROUTER_AS_RECIPIENT.test(text)) throw new Error(`${name}: a router or tx.to is presented as the recipient`);
}
function assertPendingField(tree, ids, name) {
  for (const id of ids) {
    const nodes = byAttr(tree, 'data-intel-item', id);
    if (!nodes.length) throw new Error(`${name}: ${id} missing`);
    for (const node of nodes) {
      if (node.attrs['data-intel-status'] !== 'source_pending' || node.attrs['data-intel-value'] !== undefined) {
        throw new Error(`${name}: ${id} is filled without its exact source`);
      }
    }
  }
}
const LIQUIDITY_IDS = ['top-pools-v3.liquidity', 'top-pools-v4.liquidity'];
const VOLUME_IDS = ['top-pools-v3.volume', 'top-pools-v4.volume', 'top-protocols.volume-ranking', 'volume-chart.volume', 'network.total-volume'];
const LIQUIDITY_FROM_ACTIVITY = /liquidity[^\n]*(mintCount|burnCount|modifyLiquidityCount|addCount|removeCount|add_count|remove_count)|(mintCount|burnCount|modifyLiquidityCount)[^\n]*liquidity/i;
const VOLUME_FROM_COUNTS = /\.sort\([^)\n]*swap|volume[^\n]*swapCount|swapCount[^\n]*volume/i;
const NEW_POOLS_TILE = '<StatTile marker={markerProps(`${id}.new-pools`, newPools.status, newPools.raw)} label={`New pools, ${ctx.windowLabel}`} cell={newPools} />';

await test('Contract 1 Recent Activity keeps Time, Type, Protocol, Pair, Amount, From, To and Tx, in that order, in every state', async () => {
  const items = SCOPE.find((section) => section.id === 'recent-activity').items;
  for (const id of ['recent-activity.protocol', 'recent-activity.from', 'recent-activity.to']) assert.equal(scopeItem(id)?.backend, 'live', id);
  assert.deepEqual(items.map((entry) => entry.id).filter((id) => RECENT_COLUMNS.some(([column]) => column === id)), RECENT_COLUMNS.map(([id]) => id),
    'manifest keeps the column order');
  for (const tab of ['all', 'swaps', 'adds', 'removes']) assert.ok(scopeItem(`recent-activity.${tab}`), tab);
  for (const [name, { tree }] of Object.entries(rendered)) {
    const section = sectionNode(tree, 'recent-activity');
    for (const variant of ['lg:grid', 'lg:hidden']) {
      const row = [...walk(section)].find((node) => (node.attrs.class ?? '').includes(variant)
        && node.children.some((child) => child.attrs['data-intel-item'] === 'recent-activity.time'));
      assert.ok(row, `${name} ${variant}`);
      assert.deepEqual(row.children.map((child) => [child.attrs['data-intel-item'], textOf(child)]), RECENT_COLUMNS, `${name} ${variant} columns`);
    }
    // Every column follows the feed of the selected tab; a column is never available without that feed, never carries a value.
    const tab = STATES[name].initialActivityType ?? 'all';
    for (const [id] of RECENT_COLUMNS) {
      assert.equal(statusIn(name, id), statusIn(name, `recent-activity.${tab}`), `${name} ${id}`);
      assert.equal(item(tree, id).attrs['data-intel-value'], undefined, `${name} ${id}`);
    }
  }
  assert.equal(statusIn('ready', 'recent-activity.time'), 'available');
  assert.equal(statusIn('failed', 'recent-activity.time'), 'unavailable');
  for (const id of ['recent-activity.protocol', 'recent-activity.from', 'recent-activity.to']) {
    const line = componentSource.split('\n').find((entry) => entry.includes(`item: '${id}'`));
    const mutated = loadMutated(COMPONENT_PATH, componentSource.replace(`${line}\n`, ''));
    assert.throws(() => checkScope(render(STATES.ready, mutated.ArcIntelligenceDashboard).tree, SCOPE), new RegExp(`item ${id.replace('.', '\\.')} not rendered`),
      `dropping ${id} is caught`);
  }
});

await test('Contract 2 From is the transaction sender; To is only an exact event recipient or owner, never tx.to or a router', async () => {
  assert.match(SEMANTICS['recent-activity.protocol'].meaning, /exact protocol identity/);
  assert.match(SEMANTICS['recent-activity.from'].meaning, /exact transaction sender/);
  assert.match(SEMANTICS['recent-activity.from'].source, /verified block spine/);
  assert.match(SEMANTICS['recent-activity.to'].meaning, /exact event-level recipient, owner or counterparty/);
  for (const forbidden of ['tx.to', 'router', 'top-level transaction recipient', 'called contract']) {
    assert.ok(SEMANTICS['recent-activity.to'].forbidden.includes(forbidden), forbidden);
  }
  assert.deepEqual([...SEMANTICS['recent-activity.to'].unavailableWhen], ['uniswap_v4_swap'], 'V4 swaps have no exact recipient: To is unavailable');
  assert.doesNotMatch(scopeItem('recent-activity.to').label, ROUTER_AS_RECIPIENT);
  for (const [name, { tree }] of Object.entries(rendered)) assertToSemantics(tree, name);
  for (const [file, source] of UI_CODE) {
    assert.equal(/txTo|tx\.to\b|transaction\.to\b|\brouter\b/i.exec(source), null, `${file}: no top-level transaction recipient or router feeds To`);
  }
  const mutated = componentSource.replace(TO_NOTE, 'To is the router that received the swap (tx.to).');
  assert.notEqual(mutated, componentSource);
  assert.throws(() => assertToSemantics(render(STATES.ready, loadMutated(COMPONENT_PATH, mutated).ArcIntelligenceDashboard).tree, 'mutated'),
    /router or tx\.to is presented as the recipient|To semantics note missing/, 'labelling the router as the recipient is caught');
});

await test('Contract 3 Liquidity uses V3 balances or clearly estimated V4 principal, never add/remove activity', async () => {
  assert.match(SEMANTICS['top-pools.liquidity'].meaning, /V3 token balances; V4 estimated principal reserves/);
  assert.match(SEMANTICS['top-pools.liquidity'].source, /pool state at the last block of the latest stored snapshot hour inside the selected window/);
  assert.match(SEMANTICS['top-pools.liquidity'].source, /dated per pool.*snapshot hour's verified prices/);
  for (const forbidden of ['add or remove event count', 'mint, burn or modifyLiquidity activity', 'liquidity activity', 'in-range liquidity units',
    'external or guessed price', 'unpriced tokens counted as zero']) {
    assert.ok(SEMANTICS['top-pools.liquidity'].forbidden.includes(forbidden), forbidden);
  }
  for (const id of LIQUIDITY_IDS) {
    assert.equal(scopeItem(id).backend, 'live', id);
    assert.match(scopeItem(id).label, /value held in the pool|Estimated principal reserves/);
    assert.doesNotMatch(scopeItem(id).label, /activity/i, `${id} is not liquidity activity`);
  }
  for (const [name, { tree }] of Object.entries(rendered)) {
    assert.match(textOf(sectionNode(tree, 'top-pools-v3')), /Liquidity uses token balances held by the pool\./, name);
    assert.match(textOf(sectionNode(tree, 'top-pools-v4')), /Liquidity uses estimated principal reserves from pool state\./, name);
  }
  // Available only when the pools read itself carries pool state; an API without it is not available yet.
  assertPendingField(rendered.ready.tree, LIQUIDITY_IDS, 'ready');
  for (const id of LIQUIDITY_IDS) assert.equal(statusIn('ready-complete', id), 'available', id);
  assert.equal(LIQUIDITY_FROM_ACTIVITY.exec(componentSource), null, 'no Liquidity value comes from add or remove counts');
  const mutated = componentSource.replace(NEW_POOLS_TILE, `${NEW_POOLS_TILE}
        <StatTile marker={markerProps(\`\${id}.liquidity\`, 'available', metricSum(family, ['mintCount', 'burnCount']))} label="Liquidity" cell={newPools} />`);
  assert.notEqual(mutated, componentSource);
  assert.ok(LIQUIDITY_FROM_ACTIVITY.test(mutated), 'the source check catches the mutation');
  assert.throws(() => assertPendingField(render(STATES.ready, loadMutated(COMPONENT_PATH, mutated).ArcIntelligenceDashboard).tree, LIQUIDITY_IDS, 'mutated'),
    /filled without its exact source/, 'filling Liquidity from mint and burn counts is caught');
});

await test('Contract 4 Volume comes only from the USD valuation, never from counts; pools rank by swap count, always labelled as swaps', async () => {
  for (const forbidden of ['swap count', 'event count', 'raw token sum', 'usdc-only flow', 'both sides of one swap added together', 'external or guessed price',
    'unpriced swaps counted as zero']) {
    assert.ok(SEMANTICS['top-pools.volume'].forbidden.includes(forbidden), forbidden);
  }
  assert.match(SEMANTICS['top-pools.volume'].meaning, /every swap valued once, by its USDC side or by a verified hourly price/);
  assert.match(SEMANTICS['top-pools.swaps'].meaning, /labelled as a count: the ranking of the table/);
  for (const forbidden of ['labelled or shown as volume', 'shown in USD']) assert.ok(SEMANTICS['top-pools.swaps'].forbidden.includes(forbidden), forbidden);
  for (const version of ['v3', 'v4']) {
    assert.match(scopeItem(`top-pools-${version}.volume`).label, /Pool volume in USD over the window/);
    assert.equal(scopeItem(`top-pools-${version}.volume`).backend, 'live');
    assert.match(scopeItem(`top-pools-${version}.swaps`).label, /labelled as a count/);
  }
  for (const [name, { tree }] of Object.entries(rendered)) {
    for (const id of ['top-pools-v3', 'top-pools-v4']) {
      const text = textOf(sectionNode(tree, id));
      assert.match(text, /ranked by swap count/, `${name} ${id}`);
      const volumeAvailable = statusIn(name, `${id}.volume`) === 'available';
      for (const row of byAttr(sectionNode(tree, id), 'data-pool-row')) {
        assert.match(textOf(row), / [\d,]+ swaps$/, `${name} ${id}: a pool's count is always shown as swaps`);
        assert.doesNotMatch(textOf(row), /liquidity/i, `${name} ${id}: a pool row never carries a liquidity value`);
        if (!volumeAvailable) {
          assert.doesNotMatch(textOf(row).replace(/Holds \S+/, ''), /volume|USD\b|\$/i, `${name} ${id}: no volume without the valuation`);
        }
      }
      assert.match(text, /Liquidity (Not available yet|Available|Collecting|Unavailable|Loading)/, `${name} ${id}: liquidity keeps its place, stated once`);
    }
    const protocols = textOf(sectionNode(tree, 'top-protocols'));
    assert.match(protocols, /Ranked by USD volume Not available: lending and bridge USD values are kept per action \(supplied, borrowed, sent\), so protocols share no comparable USD volume\. Listed in a fixed order\./, name);
    assert.match(protocols, /Activity, last (24H|7D|30D)/, `${name}: counts carry an explicit Activity label`);
  }
  // The ready fixtures carry no valuation: their Volume (USD) line says so once, beside Liquidity.
  assert.match(textOf(sectionNode(rendered.ready.tree, 'top-pools-v3')), /Volume \(USD\) Not available yet Verified data does not include pool USD valuations yet\. Liquidity Not available yet/);
  const unitOf = (node) => textOf(node).match(/(swaps|lending actions|market actions|vault actions)$/)?.[1];
  for (const node of byAttr(sectionNode(rendered.ready.tree, 'top-protocols'), 'data-intel-value')) {
    assert.ok(unitOf(node), `${node.attrs['data-intel-item']}: a count is always shown with its unit`);
  }
  assert.equal(VOLUME_FROM_COUNTS.exec(componentSource), null, 'no Volume value or ranking comes from swap counts');
  const swapsAsVolume = componentSource.replace(NEW_POOLS_TILE, `${NEW_POOLS_TILE}
        <StatTile marker={markerProps(\`\${id}.volume\`, 'available', metricNumber(family, 'swapCount'))} label="Volume" cell={newPools} />`);
  assert.ok(VOLUME_FROM_COUNTS.test(swapsAsVolume), 'the source check catches the mutation');
  assert.throws(() => assertPendingField(render(STATES.ready, loadMutated(COMPONENT_PATH, swapsAsVolume).ArcIntelligenceDashboard).tree, VOLUME_IDS, 'mutated'),
    /filled without its exact source|inconsistent/, 'filling Volume from swap counts is caught');
  assert.throws(() => checkScope(render(STATES.ready, loadMutated(COMPONENT_PATH, swapsAsVolume).ArcIntelligenceDashboard).tree, SCOPE), /inconsistent status/,
    'a second Volume marker beside the pending one is caught by the scope check');
  const unlabelled = componentSource.replace('<p className={LABEL}>Activity, last {ctx.windowLabel}</p>', '<p className={LABEL}>Ranking</p>');
  assert.notEqual(unlabelled, componentSource);
  assert.doesNotMatch(textOf(sectionNode(render(STATES.ready, loadMutated(COMPONENT_PATH, unlabelled).ArcIntelligenceDashboard).tree, 'top-protocols')),
    /Activity, last 24H/, 'removing the secondary Activity label would fail the check above');
});

// ---------------------------------------------------------------------------------------------------------------------
// USD volume (server/compact/valuation.js through summary.v1, timeseries.v1 and pools.v1).

await test('Volume 1 DEX Volume is the exact window value from the API, with its unit, period, change and unvalued swaps stated', async () => {
  const kpi = item(rendered['ready-usd'].tree, 'network.total-volume');
  assert.equal(kpi.attrs['data-intel-status'], 'available');
  assert.equal(kpi.attrs['data-intel-value'], '1234567890123', 'the exact micro-USD amount the API served');
  assert.equal(textOf(kpi), 'DEX Volume $1.2M USD-valued Uniswap V3 and V4 swaps on Arc. Total, last 24H. 7 swaps without a verified price excluded. +23.5% vs previous 24H');
  assert.equal([...walk(kpi)].find((node) => node.attrs.title)?.attrs.title, '$1,234,567.89', 'the exact amount stays on hover');
  const noPrevious = render({ ...STATES['ready-usd'], data: { ...USD_DATA, summary: summaryFixture({ usdVolume: usdWindow('5000000', { previous: null }) }) } }).tree;
  assert.equal(textOf(item(noPrevious, 'network.total-volume')), 'DEX Volume $5 USD-valued Uniswap V3 and V4 swaps on Arc. Total, last 24H.',
    'no change without an exactly comparable previous window, no unvalued note without unvalued swaps');
  assert.equal(statusIn('usd-collecting', 'network.total-volume'), 'collecting');
  assert.match(textOf(item(rendered['usd-collecting'].tree, 'network.total-volume')),
    /DEX Volume Collecting USD-valued Uniswap V3 and V4 swaps on Arc\. Some hours of this window are not valued yet\./);
  assert.match(textOf(item(rendered['usd-unavailable'].tree, 'network.total-volume')),
    /DEX Volume Unavailable USD-valued Uniswap V3 and V4 swaps on Arc\. No verified price for a token in some hour of this window\./, 'the exact reason, never a vague gap');
  assert.equal(statusIn('usd-unavailable', 'network.total-volume'), 'unavailable');
  for (const name of ['usd-collecting', 'usd-unavailable']) assert.doesNotMatch(rendered[name].html, /\$\s?\d/, `${name}: no USD amount without a valued window`);
});

await test('Volume 2 the DEX Volume chart draws only valued hours, keeps the unvalued hour as a gap, and reads in dollars', async () => {
  const { tree } = rendered['ready-usd'];
  const section = sectionNode(tree, 'volume-chart');
  const tabs = [...walk(section)].filter((node) => node.tag === 'button' && node.attrs.role === 'tab');
  assert.deepEqual(tabs.map((node) => [textOf(node), node.attrs['aria-selected']]), [['Volume', 'true'], ['Swaps', 'false']], 'Volume is the default view');
  assert.equal(statusIn('ready-usd', 'volume-chart.volume'), 'available');
  assert.equal(statusIn('ready-usd', 'volume-chart.swaps'), 'available');
  const labels = [...walk(section)].filter((node) => node.tag === 'button' && node.attrs['aria-label']).map((node) => node.attrs['aria-label']);
  assert.equal(labels.length, 24);
  assert.deepEqual(labels.slice(0, 2), ['14:00-15:00 UTC: no verified data', '15:00-16:00 UTC: no verified data'], 'hours not stored stay gaps');
  assert.equal(labels[USD_GAP_AT], '02:00-03:00 UTC: no verified price', 'an hour without a verified value is a gap with its reason, never zero');
  assert.equal(labels[23], '13:00-14:00 UTC: $1.5K', 'each bar is the hour\'s V3 plus V4 value');
  assert.equal(valueIn('ready-usd', 'volume-chart.latest'), '1523', 'latest complete hour, in dollars');
  assert.match(textOf(item(tree, 'volume-chart.latest')), /Latest complete hour \$1\.5K 13:00-14:00 UTC Peak hour in window \$1\.5K 13:00-14:00 UTC/);
  assert.match(textOf(section), /USD-valued Uniswap V3 and V4 swaps on Arc\. USD value per UTC hour across all verified pairs, last 24H\. Each swap is counted once\./);
  assert.match(textOf(section), /Each swap counts once, valued by its USDC side or by a verified hourly price from Arc USDC pools\. 7 swaps between tokens without a verified price are not included\./);
  assert.match(textOf(sectionNode(rendered['usd-swaps-tab'].tree, 'volume-chart')), /Counts, not amounts/, 'the Swaps view stays counts');
  assert.equal(statusIn('usd-collecting', 'volume-chart.volume'), 'collecting');
  assert.match(textOf(sectionNode(rendered['usd-collecting'].tree, 'volume-chart')), /DEX volume is still being collected Hours appear here once their swaps are valued\./);
  assert.equal(statusIn('usd-unavailable', 'volume-chart.volume'), 'unavailable');
  assert.match(textOf(sectionNode(rendered['usd-unavailable'].tree, 'volume-chart')),
    /DEX volume per hour is not available right now No verified price for a token in some hour of this window\./);
});

await test('Volume 3 pool volume is each listed pool\'s exact USD value; a pool without a verified price says so; ranking stays by swaps', async () => {
  const v3Rows = byAttr(sectionNode(rendered['ready-usd'].tree, 'top-pools-v3'), 'data-pool-row');
  assert.deepEqual(v3Rows.map(textOf), ['1 USDC / 0xabcd...1234 0.05% $2K volume 4,321 swaps', '2 EURC / MOON 0.3% No verified price 56 swaps']);
  assert.equal([...walk(v3Rows[0])].find((node) => node.attrs.title?.startsWith('$'))?.attrs.title, '$2,000.00');
  const v4Rows = byAttr(sectionNode(rendered['ready-usd'].tree, 'top-pools-v4'), 'data-pool-row');
  assert.deepEqual(v4Rows.map(textOf), ['1 USDC / EURC 0.05% $1.2K volume 1,234 swaps', '2 USDC / MOON Dynamic fee Hooks <$0.01 volume 12 swaps'],
    'kept in the service\'s swap-count order, a tiny amount never reads as zero');
  for (const id of ['top-pools-v3', 'top-pools-v4']) {
    assert.deepEqual(['all-pairs', 'swaps', 'volume', 'liquidity'].map((column) => statusIn('ready-usd', `${id}.${column}`)),
      ['available', 'available', 'available', 'source_pending'], id);
    assert.equal(statusIn('usd-collecting', `${id}.volume`), 'collecting');
    assert.equal(statusIn('usd-unavailable', `${id}.volume`), 'unavailable');
    assert.match(textOf(sectionNode(rendered['usd-unavailable'].tree, id)),
      /Volume \(USD\) Unavailable No verified price for a token in some hour of this window\. Liquidity Not available yet/);
    for (const row of byAttr(sectionNode(rendered['usd-collecting'].tree, id), 'data-pool-row')) {
      assert.doesNotMatch(textOf(row), /\$|volume/i);
      assert.match(textOf(row), /Not valued yet/, 'a row says why its value is missing, never an endless placeholder');
    }
  }
});

await test('Completion 1 fee estimate, state-based liquidity and protocol USD remain visible with their exact source or blocker', async () => {
  const tree = rendered['ready-complete'].tree;
  assert.equal(statusIn('ready-complete', 'network.average-fee'), 'available');
  assert.equal(valueIn('ready-complete', 'network.average-fee'), '300000');
  assert.match(textOf(item(tree, 'network.average-fee')), /Avg DEX Pool Fee \$0\.3/);
  assert.match(textOf(item(tree, 'network.average-fee')), /Does not include per step rounding or hook fees/);
  assert.match(textOf(sectionNode(tree, 'top-pools-v3')), /Holds \$3\.5M/);
  assert.match(textOf(sectionNode(tree, 'top-pools-v4')), /Estimated reserves \$820/);
  assert.match(textOf(sectionNode(tree, 'top-pools-v4')), /excluding uncollected fees and position rounding/);
  assert.match(textOf(sectionNode(tree, 'recent-activity')), /V4 swap recipient is not emitted by the event and trace data is unavailable\./);
  for (const id of ['lending.aave-usd', 'lending.morpho-vaults-usd', 'cross-chain.cctp-usd', 'cross-chain.gateway-usd']) {
    assert.equal(item(tree, id).attrs['data-intel-status'], 'available', id);
  }
  assert.match(textOf(item(tree, 'lending.morpho-blue-usd')), /not a verified Arc asset/);
  assert.equal(lib.usdMicrosToNumber('9'.repeat(400)), null, 'unrepresentable chart values never become Infinity or zero');
});

await test('Partial 30D displays 549 verified hours, all supported numeric sections and completed daily charts', async () => {
  const hours = 549;
  const start = END - hours * HOUR_MS;
  const summary = summaryFixture({ window: '30d', hours: 720, storedHours: hours, usdVolume: usdWindow('3294000000'),
    swapFees: feesWindow('1647000', 3294), protocolUsd: PROTOCOL_USD_READY,
    network: { blocks: 54900, transactions: 5490, transactionsPerSecond: 10 / 3600, gasUsedRaw: '549000',
      previous: { status: 'unavailable', reason: 'insufficient_coverage', transactions: null },
      uniqueActiveAddresses: { status: 'not_supported', reason: 'identity_retention_exceeded', value: null } } });
  summary.window.coverage = { status: 'partial', expectedHours: 720, availableHours: hours, missingHours: 171,
    start: isoAt(start), end: isoAt(END), completedUtcDays: 22 };
  summary.dex.usdVolume.previous = { status: 'unavailable', reason: 'insufficient_coverage', totalUsdMicros: null };
  summary.dex.swapFees.previous = { status: 'unavailable', reason: 'insufficient_coverage', averageFeeUsdMicros: null };
  const buckets = [];
  const dayMs = 24 * HOUR_MS;
  for (let day = Math.floor(Date.parse(summary.window.start) / dayMs) * dayMs; day < END; day += dayMs) {
    const storedHours = Math.max(0, (Math.min(day + dayMs, END) - Math.max(day, start)) / HOUR_MS);
    const range = { start: isoAt(day), end: isoAt(Math.min(day + dayMs, END)) };
    if (storedHours < 24) {
      buckets.push({ ...range, status: storedHours ? 'incomplete' : 'not_stored', storedHours, network: null, families: null, dexUsdVolume: null });
    } else buckets.push({ ...range, status: 'committed', storedHours: 24,
      network: { blocks: 2400, transactions: 240, gasUsedRaw: '24000', uniqueActiveAddresses: 1,
        uniqueActiveAddressesStatus: { status: 'available', value: 1 } },
      families: { uniswapV3: { status: 'available', swapCount: 72 }, uniswapV4: { status: 'available', swapCount: 72 } },
      dexUsdVolume: { status: 'available', totalUsdMicros: '144000000', uniswapV3UsdMicros: '72000000', uniswapV4UsdMicros: '72000000' } });
  }
  const series = { schema: TIMESERIES_SCHEMA, window: summary.window, freshness, bucketHours: 24, buckets };
  const pools = completePools();
  for (const protocol of ['v3', 'v4']) pools[protocol].window = summary.window;
  const data = { ...COMPLETE_DATA, window: '30d', summary, timeseries: series, pools };
  const { tree } = render({ selectedWindow: '30d', data, borrowMarket: BORROW_AVAILABLE });
  checkScope(tree, SCOPE);
  const text = textOf(tree);
  assert.match(text, /Partial history : 549 \/ 720 verified hours/);
  assert.match(text, /22 completed UTC days/);
  assert.match(text, new RegExp(lib.formatUtcDateTime(summary.window.coverage.start)));
  assert.match(text, new RegExp(lib.formatUtcDateTime(summary.window.coverage.end)));
  assert.match(text, /Values show available verified history within the selected 30D window/);
  assert.doesNotMatch(text, /30D totals appear once every hour|Total transactions, last 30D|vs previous 30D/);
  for (const id of ['network.transactions', 'network.blocks', 'network.tps', 'network.gas-used', 'network.total-volume', 'network.average-fee',
    'top-protocols.uniswap-v3', 'top-protocols.uniswap-v4', 'top-pools-v3.volume', 'top-pools-v4.volume', 'assets.usdc',
    'lending.aave', 'lending.morpho-blue', 'lending.morpho-vaults', 'cross-chain.cctp', 'cross-chain.gateway', 'cross-chain.across']) {
    assert.equal(item(tree, id).attrs['data-intel-status'], 'available', id);
  }
  assert.equal(item(tree, 'network.transactions').attrs['data-intel-value'], '5490');
  assert.equal(item(tree, 'network.active-addresses').attrs['data-intel-status'], 'unavailable');
  assert.equal(item(tree, 'active-addresses-chart.series').attrs['data-intel-status'], 'available', 'persisted daily distinct counts are displayed');
  for (const section of ['volume-chart', 'active-addresses-chart']) {
    const bars = [...walk(sectionNode(tree, section))].filter((node) => node.tag === 'button' && node.attrs['aria-label']);
    assert.equal(bars.filter((bar) => /hours stored so far/.test(bar.attrs['aria-label'])).length, 2, 'both incomplete boundaries identified');
    assert.equal(buckets.filter((bucket) => bucket.status === 'committed').length, 22);
  }
  assert.ok(lib.parseArcPools(pools.v3, 'v3', '30d'));
  for (const mutate of [(coverage) => { coverage.status = 'complete'; }, (coverage) => { coverage.availableHours = 720; },
    (coverage) => { coverage.start = summary.window.start; }, (coverage) => { coverage.completedUtcDays = 30; }]) {
    const malformed = structuredClone(pools.v3);
    mutate(malformed.window.coverage);
    assert.equal(lib.parseArcPools(malformed, 'v3', '30d'), null, 'malformed coverage fails closed');
  }
});

await test('Completion 2 fully valued 7D and 30D render their own daily USD bars and pool values', async () => {
  for (const [window, days] of [['7d', 7], ['30d', 30]]) {
    const hours = days * 24;
    const summary = summaryFixture({ window, hours, storedHours: hours, usdVolume: usdWindow('1234567890123'),
      swapFees: feesWindow('1650000000', 5500), protocolUsd: PROTOCOL_USD_READY,
      network: { uniqueActiveAddresses: { status: 'not_supported', reason: 'identity_retention_exceeded', value: null } } });
    const series = dailyTimeseries(window, days);
    series.buckets = series.buckets.map((bucket) => ({ ...bucket, status: 'committed', storedHours: 24,
      network: { blocks: 86400, transactions: 12345, transactionsPerSecond: 12345 / 86400, gasUsedRaw: '1000',
        uniqueActiveAddresses: null, uniqueActiveAddressesStatus: { status: 'not_supported', reason: 'identity_retention_exceeded' } },
      families: { uniswapV3: { status: 'available', swapCount: 3000, mintCount: 0, burnCount: 0 },
        uniswapV4: { status: 'available', swapCount: 1000, initializeCount: 0, modifyLiquidityCount: 0 } },
      dexUsdVolume: { status: 'available', totalUsdMicros: '36000000000', uniswapV3UsdMicros: '24000000000', uniswapV4UsdMicros: '12000000000',
        valuedSwaps: 4000, unvaluedSwaps: 0 } }));
    const pools = completePools();
    for (const protocol of ['v3', 'v4']) pools[protocol].window = summary.window;
    const data = { ...COMPLETE_DATA, window, summary, timeseries: series, pools };
    const { tree } = render({ selectedWindow: window, data, borrowMarket: BORROW_AVAILABLE });
    checkScope(tree, SCOPE);
    assert.match(textOf(tree), /Days in UTC, each from midnight to midnight/);
    assert.doesNotMatch(textOf(tree), /ending at the same hour as the latest verified hour/);
    assert.equal(series.window.end, '2026-10-03T00:00:00.000Z');
    for (const bucket of series.buckets) {
      assert.equal(new Date(bucket.start).getUTCHours(), 0);
      assert.equal(Date.parse(bucket.end) - Date.parse(bucket.start), 24 * HOUR_MS);
    }
    assert.equal(item(tree, 'network.total-volume').attrs['data-intel-status'], 'available', window);
    assert.equal(item(tree, 'volume-chart.volume').attrs['data-intel-status'], 'available', window);
    assert.equal(item(tree, 'network.active-addresses').attrs['data-intel-status'], 'unavailable', 'long-window uniques are not guessed');
    const bars = [...walk(sectionNode(tree, 'volume-chart'))].filter((node) => node.tag === 'button' && node.attrs['aria-label']);
    assert.equal(bars.length, days, window);
    assert.ok(bars.every((bar) => /\$/.test(bar.attrs['aria-label'])), 'only actually valued daily bins have values');
    assert.equal(item(tree, 'top-pools-v3.volume').attrs['data-intel-status'], 'available', window);
  }
});

await test('Completion 3 older missing valuations explain the bounded backfill limit instead of an endless placeholder', async () => {
  const summary = summaryFixture({ window: '7d', hours: 168, storedHours: 168,
    usdVolume: { ...usdUnavailable(['prices_unavailable']), unavailableHours: [isoAt(END - 120 * HOUR_MS)] } });
  const { tree } = render({ selectedWindow: '7d', data: { ...SEVEN_DAY_DATA, summary }, borrowMarket: BORROW_UNAVAILABLE });
  const kpi = item(tree, 'network.total-volume');
  assert.equal(kpi.attrs['data-intel-value'], undefined);
  assert.match(textOf(kpi), /Some hourly valuations are missing in this window/);
  assert.match(textOf(kpi), /backfill covers the latest 72 hours at most/);
});

await test('Tokens 1 a token\'s own contract metadata reads as an unverified label, never as a verified identity', async () => {
  const section = sectionNode(rendered['ready-usd'].tree, 'recent-activity');
  const [row] = byAttr(section, 'data-activity-row');
  assert.equal(textOf(row), 'Time (UTC) Oct 3, 13:05 Type Swap Protocol Uniswap V3 Pair USDC / MOON Amount 3.25 USDC from pool 1,873,749.0796 MOON to pool '
    + 'From 0x5e5e...5e5e To 0x7e7e...7e7e Tx 0x0000...ab05', 'amounts in the decimals the token contract reports');
  const label = [...walk(row)].find((node) => node.attrs.title?.includes('Name from the token contract'));
  assert.equal(label.attrs.title, `Moon Token, ${T_MOON.address}. Name from the token contract, not a verified Arc asset.`);
  assert.match(label.attrs.class, /decoration-dotted/, 'visibly different from a verified symbol');
  assert.equal(lib.parseArcPools(usdPools().v3, 'v3')?.pools.length, 2);
  const withMetadata = (mutate) => { const body = structuredClone(usdPools().v3); mutate(body); return lib.parseArcPools(body, 'v3'); };
  assert.equal(withMetadata((body) => { body.pools[0].token0.contractMetadata = { symbol: 'USDC', name: null, decimals: 6 }; }), null,
    'a verified token never carries contract metadata');
  assert.equal(withMetadata((body) => { body.pools[1].token1.contractMetadata.symbol = 'MOON TOKEN!'; }), null);
  assert.equal(withMetadata((body) => { body.pools[1].token1.contractMetadata.decimals = 77; }), null);
  assert.equal(withMetadata((body) => { body.pools[1].token1.symbol = 'MOON'; }), null, 'contract metadata never becomes the verified symbol');
  assert.equal(withMetadata((body) => { body.pools[0].usdVolume.usdMicros = '1.5'; }), null, 'a malformed USD amount fails the read closed');
  assert.equal(withMetadata((body) => { body.pools[1].usdVolume = { status: 'unavailable', reason: 'no_verified_price', usdMicros: '0', basis: null }; }), null,
    'an unavailable USD value never carries an amount');
  assert.ok(withMetadata((body) => { delete body.pools[0].token1.contractMetadata; delete body.pools[0].usdVolume; }), 'an older API without these fields still loads');
});

const completionEcosystem = () => {
  const observed = { timestamp: isoAt(END - HOUR_MS), blockNumber: 101, logIndex: 0, txHash: `0x${'91'.repeat(32)}` };
  const activity = { status: 'insufficient_coverage', firstProven: false, firstObserved: observed, reason: 'first_activity_history_missing' };
  const pool = { protocol: 'uniswap_v4', pool: `0x${'92'.repeat(32)}`, pairedToken: USDC, creationBlock: 100,
    creationTxHash: `0x${'93'.repeat(32)}`, creationTimestamp: observed.timestamp, firstSwap: activity, firstLiquidity: activity,
    earlyActivity: { status: 'available', reason: null, hourStart: observed.timestamp, swapCount: 5, basis: 'pool_creation_UTC_hour' } };
  const token = { address: `0x${'94'.repeat(20)}`, status: 'verified_erc20_like', verifiedAsset: false, symbol: 'FOUND', name: 'Fixture discovery',
    decimals: 18, discoveredAt: observed.timestamp, observedBlock: 100,
    deployment: { transactionHash: `0x${'95'.repeat(32)}`, timestamp: observed.timestamp, blockNumber: 100 },
    launch: { status: 'direct_deployment', source: null }, dex: { status: 'insufficient_coverage', reason: 'pool_registry_history_incomplete_or_limit',
      firstPool: null, observedPools: [pool], firstDexActivity: { status: 'insufficient_coverage', reason: 'first_activity_history_missing',
        firstObserved: { ...observed, firstProven: false } } } };
  return { schema: 'machina.intelligence.ecosystem.v1', window: READY_DATA.summary.window,
    coverage: { status: 'insufficient_coverage', reason: 'discovery_hour_missing_or_capped', requiredHours: 24, availableHours: 1 },
    discoveredTokens: { status: 'insufficient_coverage', rows: [token], truncated: true },
    launches: { status: 'insufficient_coverage', rows: [token], truncated: true },
    otherProtocols: { status: 'unavailable', reason: 'verified_protocol_registry_empty' },
    exchangeFlows: { status: 'unavailable', reason: 'verified_exchange_registry_empty' } };
};
await test('Completion partial family metrics reconcile actual hour evidence and keep gaps explicit', async () => {
  const family = { status: 'unavailable', reason: 'family_hour_unavailable', reasons: ['rpc_error'], ...WINDOW_RANGE,
    unavailableHours: [isoAt(END - HOUR_MS)], metrics: null,
    verifiedSubset: { status: 'available', scope: 'verified_hours_only', metrics: { transferCount: 123, amountRaw: '123456000000000000000', rawDecimals: 18 },
      coverage: { expectedHours: 24, availableHours: 23, missingHours: 1,
        verifiedHours: Array.from({ length: 23 }, (_, i) => isoAt(END - (24 - i) * HOUR_MS)) } } };
  assert.equal(lib.metricNumber(family, 'transferCount'), 123);
  assert.equal(lib.metricAmount(family, 'amountRaw'), '123456000000000000000');
  assert.equal(lib.windowStatus(family), 'available');
  const data = structuredClone(READY_DATA); data.summary.assets.usdc = family;
  const tree = render({ ...STATES.ready, data }).tree;
  assert.match(textOf(sectionNode(tree, 'assets')), /Partial history: 23 \/ 24 verified hours/);
  for (const mutate of [row => row.verifiedSubset.coverage.verifiedHours[0] = row.unavailableHours[0],
    row => row.verifiedSubset.coverage.availableHours = 24]) {
    const bad = structuredClone(family); mutate(bad);
    assert.equal(lib.metricNumber(bad, 'transferCount'), null); assert.equal(lib.windowStatus(bad), 'unavailable');
  }
});
await test('Completion USD action/asset subtotals display real values and exact excluded token dependencies', async () => {
  const data = structuredClone(COMPLETE_DATA);
  const unknown = `0x${'96'.repeat(20)}`;
  data.summary.protocolUsd.aaveV4 = { status: 'unavailable', reason: 'unverified_token', values: null,
    actions: { suppliedUsdMicros: { status: 'partial', scope: 'verified_priced_subset', usdMicros: '12000000',
      coverage: { expectedHours: 24, storedHours: 24, fullyValuedHours: 0 },
      assets: [{ token: USDC, symbol: 'USDC', verified: true, decimals: 6, amountRaw: '12000000', valuedAmountRaw: '12000000', unvaluedAmountRaw: '0', usdMicros: '12000000', blockers: [] }, { token: unknown, symbol: null, verified: false, decimals: null, amountRaw: '999', valuedAmountRaw: '0', unvaluedAmountRaw: '999', usdMicros: null,
        blockers: [{ reason: 'unverified_token', firstHour: isoAt(END - HOUR_MS), lastHour: isoAt(END - HOUR_MS), hours: 1 }] }] } } };
  const forged = structuredClone(data.summary.protocolUsd.aaveV4); forged.actions.suppliedUsdMicros.assets[1].usdMicros = '1';
  assert.equal(lib.protocolActions(forged), null);
  const tree = render({ ...STATES['ready-complete'], data }).tree;
  const node = item(tree, 'lending.aave-usd');
  assert.equal(node.attrs['data-intel-status'], 'available');
  assert.match(textOf(node), /\$12.00/); assert.match(textOf(node), /Verified subset/);
  assert.match(textOf(node), /0 \/ 24 fully valued hours/);
  assert.match(textOf(node), /Excluded 999 raw units: unverified token/);
  assert.match(textOf(node), new RegExp(unknown));
});
await test('Completion verified launches and discovery render despite incomplete history without claiming lifetime first', async () => {
  const ecosystem = completionEcosystem();
  assert.ok(lib.parseArcEcosystem(ecosystem, '24h'));
  assert.equal(lib.parseArcEcosystem(ecosystem, '7d'), null);
  const data = { ...READY_DATA, ecosystem };
  const tree = render({ ...STATES.ready, data }).tree;
  checkScope(tree, SCOPE);
  const launches = textOf(sectionNode(tree, 'launches'));
  assert.match(launches, /FOUND/); assert.match(launches, /1 launch records returned/);
  assert.match(launches, /Discovery coverage: 1 \/ 24 hours/);
  assert.match(launches, /Direct deployment/); assert.match(launches, /Observed pool/);
  assert.match(launches, /First observed activity/);
  assert.equal(byAttr(tree, 'data-token-evidence').length, 0, 'technical evidence starts collapsed');
  assert.equal(item(tree, 'assets.new-tokens').attrs['data-intel-status'], 'available');
  assert.match(textOf(sectionNode(tree, 'rwa-other')), /verified_exchange_registry_empty/);
  const corrupt = structuredClone(ecosystem); corrupt.launches.rows[0].dex.observedPools[0].creationTxHash = 'guessed';
  assert.equal(lib.parseArcEcosystem(corrupt, '24h'), null);
});
await test('Completion ecosystem GET is isolated from other reads and never accepts a malformed verified token', async () => {
  const urls = [];
  const out = await lib.loadArcIntelligence('24h', { fetchImpl: async (url) => {
    urls.push(url);
    if (url.includes('view=ecosystem')) return { ok: true, json: async () => completionEcosystem() };
    return { ok: true, json: async () => url.includes('view=summary') ? READY_DATA.summary : { schema: 'unexpected' } };
  } });
  assert.equal(urls.filter(url => url.includes('view=ecosystem')).length, 1);
  assert.ok(out.ecosystem); assert.equal(out.failed, false);
  const corrupt = completionEcosystem(); corrupt.discoveredTokens.rows[0].verifiedAsset = true;
  assert.equal(lib.parseArcEcosystem(corrupt, '24h'), null);
});

// Match the production contract: a stored pool can have no retained swap/liquidity event,
// and a partial 30D response can still contain 19 verified discoveries and 50 proven launches.
const missingActivityEcosystem = (window) => {
  const data = completionEcosystem();
  const hours = { '24h': 24, '7d': 168, '30d': 720 }[window];
  data.window = { key: window, hours, start: isoAt(END - hours * HOUR_MS), end: isoAt(END) };
  if (window === '30d') data.window.coverage = { status: 'partial', expectedHours: 720, availableHours: 560,
    missingHours: 160, start: isoAt(END - 560 * HOUR_MS), end: isoAt(END),
    completedUtcDays: Math.floor(END / (24 * HOUR_MS)) - Math.ceil((END - 560 * HOUR_MS) / (24 * HOUR_MS)) };
  data.coverage.requiredHours = window === '30d' ? 560 : hours;
  data.coverage.availableHours = 6;
  data.coverage.unresolvedCandidateCount = 142619;
  const token = data.launches.rows[0];
  token.dex.observedPools[0].firstSwap = { status: 'unavailable', reason: 'activity_not_stored' };
  token.dex.observedPools[0].earlyActivity = { status: 'unavailable', reason: 'creation_hour_projection_missing',
    basis: 'pool_creation_UTC_hour', hourStart: null, swapCount: null };
  const row = (index) => ({ ...structuredClone(token), address: `0x${(index + 1).toString(16).padStart(40, '0')}` });
  data.discoveredTokens.rows = Array.from({ length: 19 }, (_, i) => row(i));
  data.launches.rows = Array.from({ length: 50 }, (_, i) => row(i));
  // Include both a known first pool with absent activity and a pool lacking any activity at all.
  for (const list of [data.discoveredTokens, data.launches]) {
    list.rows[0].dex.firstPool = structuredClone(list.rows[0].dex.observedPools[0]);
    list.rows[0].dex.status = 'available';
    list.rows[1].dex.observedPools[0].firstLiquidity = { status: 'unavailable', reason: 'activity_not_stored' };
    list.rows[1].dex.firstDexActivity = { status: 'insufficient_coverage', reason: 'first_activity_history_missing',
      value: null, firstObserved: null };
    list.rows[2].dex = { status: 'unavailable', reason: 'no_verified_pool', firstPool: null, observedPools: [] };
  }
  // Unknown launch source is valid discovery evidence but must never enter the proven launch list.
  data.discoveredTokens.rows[3].launch = { status: 'unknown_source', source: null, provenance: null };
  return data;
};
for (const window of ['24h', '7d', '30d']) await test(`Ecosystem schema ${window} preserves missing activity and renders verified partial lists`, async () => {
  const body = missingActivityEcosystem(window), original = structuredClone(body);
  const parsed = lib.parseArcEcosystem(body, window);
  assert.equal(parsed, body);
  assert.deepEqual(parsed, original, 'parsing never fabricates an observation, proof, or zero');
  assert.equal(parsed.discoveredTokens.rows.length, 19); assert.equal(parsed.launches.rows.length, 50);
  assert.deepEqual(parsed.launches.rows[0].dex.firstPool.firstSwap, { status: 'unavailable', reason: 'activity_not_stored' });
  assert.equal(lib.parseArcEcosystem(body, window === '24h' ? '7d' : '24h'), null);
  const summary = structuredClone(READY_DATA.summary); summary.window = body.window;
  const tree = render({ selectedWindow: window, data: { ...READY_DATA, window, summary, ecosystem: parsed } }).tree;
  assert.match(textOf(sectionNode(tree, 'assets')), /19 verified ERC-20-like records; asset identities remain unverified/);
  assert.equal(byAttr(tree, 'data-launch-token').length, 10);
  const launches = textOf(sectionNode(tree, 'launches'));
  assert.match(launches, /50 launch records returned \(list capped\)/);
  assert.match(launches, new RegExp(`Discovery coverage: 6 / ${body.coverage.requiredHours} hours`));
  assert.match(launches, /Incomplete discovery does not hide proven launches/);
  assert.match(launches, /First observed activity/);
  assert.equal(byAttr(tree, 'data-token-evidence').length, 0);
});
await test('Ecosystem schema rejects malformed or contradictory activity and token evidence in every window', async () => {
  const mutations = [
    row => row.dex.firstPool.firstSwap.firstProven = true,
    row => row.dex.firstPool.firstSwap.firstObserved = row.dex.firstPool.firstLiquidity.firstObserved,
    row => row.dex.firstPool.firstSwap.reason = 'invented_missing_reason',
    row => row.dex.observedPools[0].firstLiquidity.firstProven = true,
    row => row.dex.observedPools[0].firstLiquidity.firstObserved = null,
    row => delete row.dex.observedPools[0].firstLiquidity.firstProven,
    row => row.dex.observedPools[0].firstLiquidity.firstObserved.txHash = 'guessed',
    row => row.dex.observedPools[0].firstLiquidity.firstObserved.timestamp = 'invalid',
    row => row.dex.observedPools[0].firstLiquidity.firstObserved.blockNumber = -1,
    row => row.dex.observedPools[0].firstLiquidity.firstObserved.logIndex = 1.5,
    row => row.dex.firstDexActivity.status = 'available',
    row => delete row.dex.firstDexActivity.firstObserved.firstProven,
    row => row.dex.firstDexActivity.firstObserved.txHash = 'guessed',
    row => row.dex.firstPool.pool = `0x${'12'.repeat(20)}`,
    row => row.dex.firstPool.pairedToken = 'guessed',
    row => row.dex.firstPool.creationTxHash = 'guessed',
    row => row.dex.firstPool.creationTimestamp = 'invalid',
    row => row.address = 'guessed',
    row => row.status = 'unverified',
    row => row.verifiedAsset = true,
    row => row.deployment.transactionHash = 'guessed',
    row => row.deployment.timestamp = 'invalid',
    row => row.deployment.blockNumber = -1,
    row => row.deployment.deployer = 'guessed',
    row => row.observedBlock = -1,
    row => row.launch.observedAt = 'invalid',
    row => row.launch.source = 'guessed_direct_source',
    row => row.launch = { status: 'verified_factory', source: null },
    row => row.launch = { status: 'verified_launchpad', source: '' },
  ];
  for (const window of ['24h', '7d', '30d']) {
    for (const list of ['discoveredTokens', 'launches']) for (const mutate of mutations) {
      const body = missingActivityEcosystem(window); mutate(body[list].rows[0]);
      assert.equal(lib.parseArcEcosystem(body, window), null, `${window} ${list}: ${mutate}`);
    }
    const unknown = missingActivityEcosystem(window); unknown.launches.rows[0].launch = { status: 'unknown_source', source: null };
    assert.equal(lib.parseArcEcosystem(unknown, window), null);
    const capped = missingActivityEcosystem(window); capped.launches.rows.push(structuredClone(capped.launches.rows[0]));
    assert.equal(lib.parseArcEcosystem(capped, window), null);
    const proven = missingActivityEcosystem(window);
    const pool = proven.launches.rows[0].dex.firstPool;
    pool.firstSwap = { ...structuredClone(pool.firstLiquidity), status: 'available', firstProven: true, reason: null };
    assert.ok(lib.parseArcEcosystem(proven, window), 'genuinely proven activity still validates');
  }
});

// Drive the actual list's hook state and native button handlers without external network or a DOM dependency.
// Render every state with React so the assertions inspect the resulting table, controls and evidence panels.
function tokenListHarness(kind, ecosystem = missingActivityEcosystem('30d')) {
  let state;
  let ctx = { ecosystem, windowHours: ecosystem.window.hours, windowLabel: ecosystem.window.key.toUpperCase(), explorerUrl: 'https://arcscan.app' };
  const draw = () => {
    const original = React.useState;
    React.useState = initial => {
      if (state === undefined) state = typeof initial === 'function' ? initial() : initial;
      return [state, next => { state = typeof next === 'function' ? next(state) : next; }];
    };
    let element;
    try { element = componentModule.EcosystemTokenList({ ctx, kind }); }
    finally { React.useState = original; }
    const output = render({}, () => element);
    function* elements(node) {
      if (Array.isArray(node)) { for (const child of node) yield* elements(child); return; }
      if (!React.isValidElement(node)) return;
      yield node;
      if (typeof node.type === 'function') yield* elements(node.type(node.props));
      else yield* elements(node.props.children);
    }
    return { ...output, controls: [...elements(element)].filter(node => node.type === 'button') };
  };
  return { draw, replace: ecosystem => { ctx = { ...ctx, ecosystem }; },
    click: label => {
      const control = draw().controls.find(node => node.props.children === label);
      assert.ok(control, label); assert.equal(control.props.type, 'button');
      if (!control.props.disabled) control.props.onClick();
    },
    expand: address => {
      const control = draw().controls.find(node => node.props['aria-controls']?.endsWith(address));
      assert.ok(control, `expand ${address}`); control.props.onClick();
    } };
}
await test('Token list UX compact defaults, coverage and capped counts keep both lists bounded', async () => {
  const ecosystem = missingActivityEcosystem('30d'); ecosystem.coverage.requiredHours = 561;
  ecosystem.window.coverage.availableHours = 561; ecosystem.window.coverage.missingHours = 159;
  ecosystem.window.coverage.start = isoAt(END - 561 * HOUR_MS);
  const summary = structuredClone(READY_DATA.summary); summary.window = ecosystem.window;
  const { tree } = render({ selectedWindow: '30d', data: { ...READY_DATA, window: '30d', summary, ecosystem }, borrowMarket: BORROW_UNAVAILABLE });
  checkScope(tree, SCOPE);
  assert.equal(byAttr(tree, 'data-launch-token').length, 10);
  assert.equal(byAttr(tree, 'data-discovered-token').length, 10);
  assert.equal(byAttr(tree, 'data-token-evidence').length, 0);
  for (const kind of ['launches', 'discoveredTokens']) {
    const list = byAttr(tree, 'data-token-list', kind)[0], text = textOf(list);
    assert.match(text, /Discovery coverage: 6 \/ 561 hours/);
    assert.match(text, /Capped results are not the total number of launches or tokens/);
    assert.match(text, /asset identities remain unverified/);
    assert.match(text, kind === 'launches' ? /50 launch records returned/ : /19 discovered token records returned/);
    const table = [...walk(list)].find(node => node.tag === 'table');
    assert.ok(table); assert.match(table.attrs.class, /md:table/);
    assert.equal([...walk(table)].filter(node => node.tag === 'th' && node.attrs.scope === 'col').length, 5);
    const rows = byAttr(list, kind === 'launches' ? 'data-launch-token' : 'data-discovered-token');
    assert.ok(rows.every(row => /grid-cols-2/.test(row.attrs.class) && /md:table-row/.test(row.attrs.class)));
  }
});
await test('Token list UX Previous and Next visit every returned record once and isolate list navigation', async () => {
  const ecosystem = missingActivityEcosystem('30d');
  const launches = tokenListHarness('launches', ecosystem), discoveries = tokenListHarness('discoveredTokens', ecosystem);
  const visited = [];
  assert.equal(launches.draw().controls.find(node => node.props.children === 'Previous').props.disabled, true);
  for (let page = 0; page < 5; page++) {
    const { tree } = launches.draw();
    const rows = byAttr(tree, 'data-launch-token'); assert.equal(rows.length, 10);
    visited.push(...rows.map(row => row.attrs['data-launch-token']));
    assert.match(textOf(tree), new RegExp(`Page ${page + 1} of 5`));
    launches.click('Next');
  }
  assert.deepEqual(visited, ecosystem.launches.rows.map(row => row.address));
  assert.equal(launches.draw().controls.find(node => node.props.children === 'Next').props.disabled, true);
  launches.click('Previous'); assert.match(textOf(launches.draw().tree), /Page 4 of 5/);
  assert.match(textOf(discoveries.draw().tree), /Page 1 of 2/);
  discoveries.click('Next');
  assert.equal(byAttr(discoveries.draw().tree, 'data-discovered-token').length, 9);
  assert.match(textOf(discoveries.draw().tree), /11–19 of 19 returned/);
  const smaller = structuredClone(ecosystem); smaller.launches.rows = smaller.launches.rows.slice(0, 3);
  launches.replace(smaller); assert.match(textOf(launches.draw().tree), /1–3 of 3 returned · Page 1 of 1/);
  launches.click('Previous'); assert.equal(byAttr(launches.draw().tree, 'data-launch-token').length, 3);
});
await test('Token list UX expansion reveals real evidence, remains single-row and closes on pagination', async () => {
  const ecosystem = missingActivityEcosystem('30d'), rows = ecosystem.launches.rows;
  const harness = tokenListHarness('launches', ecosystem);
  assert.equal(byAttr(harness.draw().tree, 'data-token-evidence').length, 0);
  harness.expand(rows[0].address);
  let output = harness.draw();
  assert.deepEqual(byAttr(output.tree, 'data-token-evidence').map(node => node.attrs['data-token-evidence']), [rows[0].address]);
  assert.match(textOf(output.tree), new RegExp(rows[0].address));
  assert.match(textOf(output.tree), new RegExp(rows[0].deployment.transactionHash));
  assert.match(textOf(output.tree), /Deployment block 100/);
  assert.match(textOf(output.tree), new RegExp(rows[0].dex.firstPool.pool));
  assert.match(textOf(output.tree), /First observed activity/); assert.match(textOf(output.tree), /Lifetime first unproven/);
  assert.match(textOf(output.tree), /activity_not_stored/);
  const toggle = output.controls.find(node => node.props['aria-expanded'] === true);
  assert.ok(byAttr(output.tree, 'id', toggle.props['aria-controls']).length);
  assert.equal(toggle.props.type, 'button'); assert.match(toggle.props['aria-label'], /Hide evidence for/);
  const region = byAttr(output.tree, 'role', 'region')[0]; assert.match(region.attrs['aria-label'], /Evidence for/);
  for (const button of output.controls) assert.ok(button.props.className.includes('focus-visible:outline'));
  harness.expand(rows[1].address);
  assert.deepEqual(byAttr(harness.draw().tree, 'data-token-evidence').map(node => node.attrs['data-token-evidence']), [rows[1].address]);
  harness.expand(rows[1].address); assert.equal(byAttr(harness.draw().tree, 'data-token-evidence').length, 0);
  harness.expand(rows[0].address); harness.click('Next');
  assert.equal(byAttr(harness.draw().tree, 'data-token-evidence').length, 0);
  const discovery = tokenListHarness('discoveredTokens', ecosystem); discovery.expand(ecosystem.discoveredTokens.rows[3].address);
  assert.match(textOf(discovery.draw().tree), /Source unproven/);
});
await test('Token list UX unavailable and unsupported data stay explicit without sample rows', async () => {
  const empty = missingActivityEcosystem('24h'); empty.launches.rows = []; empty.discoveredTokens.rows = [];
  for (const kind of ['launches', 'discoveredTokens']) {
    const harness = tokenListHarness(kind, empty), output = harness.draw();
    assert.equal(output.controls.length, 0); assert.equal(byAttr(output.tree, 'data-token-evidence').length, 0);
    assert.match(textOf(output.tree), /No .* listed yet/);
    harness.replace(null); assert.match(textOf(harness.draw().tree), /Records appear once token discovery is verified/);
    assert.doesNotMatch(textOf(harness.draw().tree), /0 (verified|launch|discovered token) records/, 'a missing response never becomes a zero count');
  }
  assert.match(componentSource, /<EcosystemTokenList key=\{ctx.windowHours\} ctx=\{ctx\} kind="launches"/);
  assert.match(componentSource, /<EcosystemTokenList key=\{ctx.windowHours\} ctx=\{ctx\} kind="discoveredTokens"/);
});
await test('Completion both 7D and 30D daily-active charts preserve persisted completed-day values', async () => {
  for (const [window, days] of [['7d', 7], ['30d', 30]]) {
    const data = longData(window, days);
    data.timeseries.buckets = data.timeseries.buckets.map(bucket => bucket.status === 'committed' ? { ...bucket,
      network: { ...bucket.network, uniqueActiveAddresses: 321, uniqueActiveAddressesStatus: { status: 'available', value: 321 } } } : bucket);
    const tree = render({ selectedWindow: window, data }).tree;
    const chart = textOf(sectionNode(tree, 'active-addresses-chart'));
    assert.match(chart, /Verified distinct addresses per completed UTC day/);
    assert.doesNotMatch(chart, /Daily active addresses are not available/);
    assert.equal(item(tree, 'network.active-addresses').attrs['data-intel-status'], 'unavailable');
  }
});
const refreshTime = '2026-10-09T17:00:00.000Z';
const recoveryTime = '2026-10-09T17:02:00.000Z';
const refreshFixture = (window = '24h') => {
  const data = structuredClone(window === '24h' ? READY_DATA : longData(window, window === '7d' ? 7 : 30));
  data.summary.network = structuredClone(READY_DATA.summary.network);
  if (window === '30d') {
    const end = Date.parse(data.summary.window.end), start = end - 560 * HOUR_MS;
    data.summary.window.coverage = { status: 'partial', expectedHours: 720, availableHours: 560, missingHours: 160,
      start: isoAt(start), end: isoAt(end), completedUtcDays: Math.floor(end / (24 * HOUR_MS)) - Math.ceil(start / (24 * HOUR_MS)) };
    data.summary.coverage.storedHours = 560;
  }
  data.ecosystem = completionEcosystem(); data.ecosystem.window = data.summary.window;
  return data;
};
const refreshSection = (data, section) => section === 'poolsV3' ? data.pools?.v3 : section === 'poolsV4' ? data.pools?.v4
  : section.startsWith('activity:') ? data.activity?.[section.slice(9)] : data[section];
const removeRefreshSection = (data, section) => {
  if (section === 'poolsV3' || section === 'poolsV4') data.pools[section === 'poolsV3' ? 'v3' : 'v4'] = null;
  else if (section.startsWith('activity:')) data.activity[section.slice(9)] = null;
  else data[section] = null;
};
const refreshFetch = (data, mutate = (_, body) => body) => async (url) => {
  const query = new URL(url, 'https://fixture.invalid').searchParams;
  const section = query.get('view') === 'pools' ? query.get('protocol') === 'v3' ? 'poolsV3' : 'poolsV4'
    : query.get('view') === 'activity' ? `activity:${query.get('type')}` : query.get('view');
  return { ok: true, json: async () => mutate(section, structuredClone(refreshSection(data, section))) };
};

await test('Refresh 1 success validates each section independently and limits concurrent GETs to two', async () => {
  for (const window of ['24h', '7d', '30d']) {
    let inFlight = 0, peak = 0, count = 0;
    const data = refreshFixture(window), serve = refreshFetch(data);
    const result = await lib.loadArcIntelligence(window, { fetchImpl: async (...args) => {
      count++; inFlight++; peak = Math.max(peak, inFlight);
      await new Promise(resolve => setImmediate(resolve));
      inFlight--; return serve(...args);
    } });
    assert.equal(count, 9); assert.equal(peak, 2);
    const retained = lib.retainArcIntelligenceLoad(undefined, result, refreshTime);
    assert.equal(retained.failed, false);
    for (const section of lib.ARC_READ_SECTIONS) {
      assert.ok(refreshSection(retained, section), `${window}:${section}`);
      assert.equal(retained.refresh[section].lastSuccessAt, refreshTime);
      assert.equal(retained.refresh[section].error, null);
      assert.equal(retained.refresh[section].retained, false);
    }
  }
});

await test('Refresh 2 a failed 30D reload preserves every verified section and shows stale response timestamps', async () => {
  const previous = lib.retainArcIntelligenceLoad(undefined, refreshFixture('30d'), refreshTime);
  const failure = await lib.loadArcIntelligence('30d', { fetchImpl: async () => { throw new TypeError('offline'); } });
  const kept = lib.retainArcIntelligenceLoad(previous, failure, recoveryTime);
  assert.equal(kept.failed, false);
  for (const section of lib.ARC_READ_SECTIONS) {
    assert.strictEqual(refreshSection(kept, section), refreshSection(previous, section));
    assert.deepEqual(kept.refresh[section], { ...previous.refresh[section], error: 'request_failed', retained: true });
  }
  const tree = render({ selectedWindow: '30d', data: kept }).tree;
  assert.equal(item(tree, 'network.transactions').attrs['data-intel-status'], 'available');
  assert.equal(byAttr(tree, 'data-refresh-section', 'summary')[0].attrs['data-refresh-status'], 'stale');
  assert.match(textOf(tree), /560 \/ 720 verified hours/);
  assert.match(textOf(tree), /Refresh failed for Summary, Timeseries/);
  assert.match(textOf(tree), /Previously verified responses are retained and marked stale/);
  assert.match(textOf(tree), /Last successfully validated response: Oct 9, 17:00 UTC/);
  assert.doesNotMatch(textOf(tree), /Last successfully validated response: Oct 9, 17:02 UTC/);
});

await test('Refresh 3 each partial API failure retains only that section while successful peers advance', async () => {
  const previous = lib.retainArcIntelligenceLoad(undefined, refreshFixture(), refreshTime);
  for (const failedSection of lib.ARC_READ_SECTIONS) {
    const result = await lib.loadArcIntelligence('24h', { fetchImpl: refreshFetch(refreshFixture(), (section, body) => {
      if (section === failedSection) throw new TypeError('one section failed'); return body;
    }) });
    const kept = lib.retainArcIntelligenceLoad(previous, result, recoveryTime);
    for (const section of lib.ARC_READ_SECTIONS) {
      assert.equal(kept.refresh[section].retained, section === failedSection);
      assert.equal(kept.refresh[section].lastSuccessAt, section === failedSection ? refreshTime : recoveryTime);
      if (section === failedSection) assert.strictEqual(refreshSection(kept, section), refreshSection(previous, section));
      else assert.notStrictEqual(refreshSection(kept, section), refreshSection(previous, section));
    }
    assert.equal(kept.failed, false);
  }
});

await test('Refresh 4 a first-load Summary failure does not hide successful Timeseries Pools Ecosystem or Activity', async () => {
  const result = await lib.loadArcIntelligence('24h', { fetchImpl: refreshFetch(refreshFixture(), (section, body) => {
    if (section === 'summary') throw new TypeError('summary failed'); return body;
  }) });
  const data = lib.retainArcIntelligenceLoad(undefined, result, refreshTime);
  assert.equal(data.summary, null); assert.ok(data.timeseries); assert.equal(lib.hasArcIntelligenceData(data), true);
  const tree = render({ selectedWindow: '24h', data }).tree;
  assert.equal(item(tree, 'network.transactions').attrs['data-intel-status'], 'unavailable');
  for (const id of ['top-pools-v3.swaps', 'top-pools-v4.swaps', 'assets.new-tokens', 'recent-activity.all', 'volume-chart.swaps']) {
    assert.equal(item(tree, id).attrs['data-intel-status'], 'available', id);
  }
  assert.match(textOf(tree), /Sections without a previous successful response remain unavailable/);
});

await test('Refresh 5 recovery replaces retained responses and clears errors with new success timestamps', async () => {
  let data = lib.retainArcIntelligenceLoad(undefined, refreshFixture(), refreshTime);
  const failure = { window: '24h', summary: null, timeseries: null, failed: true };
  data = lib.retainArcIntelligenceLoad(data, failure, recoveryTime);
  const fresh = refreshFixture(); fresh.summary.network.transactions = 76543;
  data = lib.retainArcIntelligenceLoad(data, fresh, recoveryTime);
  assert.equal(data.summary.network.transactions, 76543);
  for (const section of lib.ARC_READ_SECTIONS) {
    assert.equal(data.refresh[section].error, null); assert.equal(data.refresh[section].retained, false);
    assert.equal(data.refresh[section].lastSuccessAt, recoveryTime);
  }
  const tree = render({ selectedWindow: '24h', data }).tree;
  assert.doesNotMatch(textOf(tree), /Refresh failed|Stale retained response/);
  assert.equal(byAttr(tree, 'data-refresh-section', 'summary')[0].attrs['data-refresh-status'], 'refreshed');
});

await test('Refresh 6 caches remain separate on window switching and never borrow another window timestamp or data', async () => {
  const cache = {};
  for (const window of ['24h', '7d', '30d']) cache[window] = lib.retainArcIntelligenceLoad(undefined, refreshFixture(window), refreshTime);
  for (const window of ['30d', '24h', '7d', '30d']) {
    const old = cache[window];
    cache[window] = lib.retainArcIntelligenceLoad(old, { window, summary: null, timeseries: null, failed: true }, recoveryTime);
    assert.strictEqual(cache[window].summary, old.summary);
    assert.equal(cache[window].summary.window.key, window);
    assert.equal(cache[window].refresh.summary.lastSuccessAt, refreshTime);
  }
  const freshWindow = lib.retainArcIntelligenceLoad(cache['24h'], { window: '30d', summary: null, timeseries: null, failed: true }, recoveryTime);
  assert.equal(freshWindow.summary, null); assert.equal(freshWindow.refresh.summary.lastSuccessAt, null);
});

await test('Refresh 7 timer and manual reloads coalesce and late aborted window responses cannot publish or clear new state', async () => {
  const pending = [], updates = [], busy = [];
  const coordinator = lib.createArcIntelligenceRefresh({ onResult: result => updates.push(result.window),
    onRefreshing: value => busy.push(value), loader: (window, { signal }) => new Promise(resolve => pending.push({ window, signal, resolve })) });
  const first = coordinator.refresh('30d');
  assert.strictEqual(coordinator.refresh('30d'), first); assert.equal(pending.length, 1);
  const second = coordinator.refresh('24h'); assert.equal(pending[0].signal.aborted, true);
  pending[0].resolve(refreshFixture('30d')); await first;
  assert.deepEqual(updates, []); assert.deepEqual(busy, [true, true]);
  pending[1].resolve(refreshFixture()); await second;
  assert.deepEqual(updates, ['24h']); assert.deepEqual(busy, [true, true, false]);
  const third = coordinator.refresh('7d'); coordinator.cancel();
  pending[2].resolve(refreshFixture('7d')); await third;
  assert.deepEqual(updates, ['24h']); assert.equal(pending[2].signal.aborted, true);
  assert.match(componentSource, /setInterval\(\(\) => void load\(selectedWindow\), 60_000\)/);
  assert.match(componentSource, /coordinator\.current\?\.cancel\(\)/);
});

await test('Refresh 8 malformed and wrong-window responses retain verified data but genuine unavailable responses replace it', async () => {
  const previous = lib.retainArcIntelligenceLoad(undefined, refreshFixture(), refreshTime);
  const invalid = await lib.loadArcIntelligence('24h', { fetchImpl: refreshFetch(refreshFixture(), (section, body) => {
    if (section === 'summary' || section === 'timeseries') body.window.key = '30d';
    if (section === 'ecosystem') body.discoveredTokens.rows[0].verifiedAsset = true;
    if (section === 'poolsV3') body.pools[0].swapCount = 'guessed';
    return body;
  }) });
  const kept = lib.retainArcIntelligenceLoad(previous, invalid, recoveryTime);
  for (const section of ['summary', 'timeseries', 'ecosystem', 'poolsV3']) {
    assert.equal(kept.refresh[section].error, 'invalid_response'); assert.equal(kept.refresh[section].retained, true);
  }
  const genuine = refreshFixture();
  genuine.summary.network = { status: 'unavailable', reason: 'insufficient_coverage' };
  genuine.pools.v3 = { ...genuine.pools.v3, status: 'unavailable', reason: 'not_ready', pools: [] };
  const replacement = lib.retainArcIntelligenceLoad(previous,
    await lib.loadArcIntelligence('24h', { fetchImpl: refreshFetch(genuine) }), recoveryTime);
  assert.equal(replacement.summary.network.status, 'unavailable');
  assert.equal(replacement.pools.v3.status, 'unavailable');
  assert.equal(replacement.refresh.summary.retained, false); assert.equal(replacement.refresh.poolsV3.error, null);
});

await test('Refresh 9 cancellation stops queued section requests without issuing the remaining seven GETs', async () => {
  const controller = new AbortController(); let calls = 0;
  const result = lib.loadArcIntelligence('30d', { signal: controller.signal, fetchImpl: (_, { signal }) => {
    calls++; return new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
  } });
  assert.equal(calls, 2); controller.abort(); await result; assert.equal(calls, 2);
});

console.log(`VERIFIER PASS arc-intelligence-dashboard ${tests.length} tests`);
