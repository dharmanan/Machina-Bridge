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
import { DATA_CACHE_CONTROL, NO_STORE, resolveIntelligenceRoute, SUMMARY_SCHEMA, TIMESERIES_SCHEMA } from '../api/_lib/intelligence-proxy.js';
import { createIntelligenceServer } from '../server/compact/http.js';
import { SUMMARY_SCHEMA as BACKEND_SUMMARY_SCHEMA, TIMESERIES_SCHEMA as BACKEND_TIMESERIES_SCHEMA } from '../server/compact/read-model.js';

const tests = [];
async function test(name, work) {
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
const bodyFor = (query) => (query.view === 'health' ? { status: 'ok', checkpointHour: '2026-10-03T08:00:00.000Z' }
  : query.view === 'summary' ? summaryBody(query.window) : timeseriesBody(query.window));

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

await test('1-6 the six exact requests map to six fixed upstream URLs and return the upstream body unchanged', async () => {
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
    assert.equal(seen.length, 6);
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
      { view: 'summary', window: '' }, { view: 'summary', window: '7d' }, { view: 'summary', window: '24h ' },
      { view: 'summary', window: "24h' OR 1=1--" }, { view: 'summary', window: '24h;DROP TABLE compact_hours' },
      { view: 'summary', window: '../../health' }, { view: 'summary', window: ['24h', '6h'] }, { view: ['summary', 'health'] },
      { view: 'timeseries', window: '1h' }, { view: 'timeseries', window: '24h', window2: '6h' },
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
  ];
  await withFetch(async (url) => upstream({ body: bodyFor(MAPPING.find(([, path]) => `${ORIGIN}${path}` === url)?.[0] ?? { view: 'health' }) }), async (seen) => {
    for (const query of hostile) assert.equal((await call({ query })).statusCode, 400, JSON.stringify(query));
    for (const [query] of MAPPING) await call({ query, headers: { host: 'evil.example', 'x-forwarded-host': 'evil.example' } });
    assert.ok(seen.every(({ url }) => ALLOWED_URLS.has(url)), seen.map(({ url }) => url).join(' '));
    assert.equal(seen.length, MAPPING.length);
  });
  for (const query of [{ view: 'summary', window: 'constructor' }, { view: 'summary', window: '__proto__' }, { view: 'toString' }, { view: 'hasOwnProperty' }]) {
    assert.equal(resolveIntelligenceRoute(query), null, JSON.stringify(query));
  }
});

await test('contract: proxy schemas and upstream paths are exactly the compact backend\'s', async () => {
  assert.equal(SUMMARY_SCHEMA, BACKEND_SUMMARY_SCHEMA);
  assert.equal(TIMESERIES_SCHEMA, BACKEND_TIMESERIES_SCHEMA);
  const backend = await readFile(new URL('../server/compact/http.js', import.meta.url), 'utf8');
  const backendRoutes = [...backend.matchAll(/^ {2}\['(\/[^']+)'/gm)].map((match) => match[1]).sort();
  assert.deepEqual(backendRoutes, MAPPING.map(([, path]) => path).sort());
  const proxy = await readFile(new URL('../api/_lib/intelligence-proxy.js', import.meta.url), 'utf8');
  assert.match(proxy, /url = `\$\{upstreamOrigin\(env\)\}\$\{route\.path\}`/);
  assert.doesNotMatch(proxy, /\$\{(query|view|window)\b/, 'no user input is interpolated into a URL');
});

await test('end to end: the real compact HTTP server behind the proxy gives 200, then 304 for the same ETag', async () => {
  const readModel = {
    health: () => ({ status: 'ok', checkpointHour: '2026-10-03T08:00:00.000Z', verifiedThrough: '2026-10-03T09:00:00.000Z' }),
    summary: (window) => summaryBody(window, { network: { status: 'unavailable', reason: 'insufficient_coverage' } }),
    timeseries: (window) => timeseriesBody(window),
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
function summaryFixture({ families = {}, network = {}, storedHours = 48 } = {}) {
  const family = (name) => (Object.hasOwn(families, name) ? families[name] : available(FAMILY_METRICS[name]));
  return {
    schema: SUMMARY_SCHEMA, chain: { id: 5042, name: 'Arc' }, window: { key: '24h', hours: 24, ...WINDOW_RANGE }, freshness,
    network: { status: 'available', ...WINDOW_RANGE, blocks: 86_400, transactions: 1_234_567, transactionsPerSecond: 1_234_567 / 86_400,
      averageTransactionsPerBlock: 1_234_567 / 86_400, gasUsedRaw: '987654321000', uniqueActiveAddresses: { status: 'available', value: 45_678 },
      previous: { status: 'available', blocks: 86_400, transactions: 1_000_000, transactionsPerSecond: 1_000_000 / 86_400, averageTransactionsPerBlock: 11.5,
        gasUsedRaw: '900000000000', uniqueActiveAddresses: { status: 'not_supported', reason: 'identity_retention_exceeded', value: null } }, ...network },
    assets: { usdc: family('usdc'), verifiedAssets: family('assets') },
    dex: { uniswapV3: family('uniswapV3'), uniswapV4: family('uniswapV4'), officialV3Pools: { status: 'available', count: 87, throughBlock: 4_200_000 } },
    lending: { aaveV4: family('aaveV4'), morphoBlue: family('morphoBlue'), morphoVaultsV2: family('morphoVaultsV2') },
    crossChain: { cctp: family('cctp'), gateway: family('gateway'), across: family('across') },
    coverage: { firstStoredHour: isoAt(END - storedHours * HOUR_MS), storedHours, checkpointHour: freshness.checkpointHour,
      verifiedThrough: freshness.verifiedThrough, checkpointBlock: 4_200_000, families: {} },
    definitions: {},
  };
}
function timeseriesFixture({ notStored = 2, v4GapAt = 10 } = {}) {
  const buckets = Array.from({ length: 24 }, (_, index) => {
    const range = { start: isoAt(END - (24 - index) * HOUR_MS), end: isoAt(END - (23 - index) * HOUR_MS) };
    if (index < notStored) return { ...range, status: 'not_stored', network: null, families: null };
    return { ...range, status: 'committed',
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
const BORROW_UNAVAILABLE = { status: 'unavailable' };
const STATES = {
  // Swaps view, so the chart assertions see the hourly bars; the default view (Volume) is checked separately.
  ready: { selectedWindow: '24h', initialDexView: 'swaps', borrowMarket: BORROW_AVAILABLE,
    data: { window: '24h', summary: summaryFixture(), timeseries: timeseriesFixture(), failed: false } },
  'ready-default-view': { selectedWindow: '24h', borrowMarket: BORROW_AVAILABLE,
    data: { window: '24h', summary: summaryFixture(), timeseries: timeseriesFixture(), failed: false } },
  collecting: { selectedWindow: '24h', borrowMarket: BORROW_UNAVAILABLE,
    data: { window: '24h', summary: summaryFixture({ families: insufficient, network: collectingNetwork, storedHours: 18 }),
      timeseries: timeseriesFixture({ notStored: 6, v4GapAt: -1 }), failed: false } },
  mixed: { selectedWindow: '24h', borrowMarket: BORROW_AVAILABLE, data: { window: '24h', timeseries: timeseriesFixture(), failed: false,
    summary: summaryFixture({ families: { aaveV4: unavailableFamily('family_hour_unavailable'), across: unavailableFamily('window_constant_mismatch') } }) } },
  failed: { selectedWindow: '24h', borrowMarket: BORROW_UNAVAILABLE, data: { window: '24h', summary: null, timeseries: null, failed: true } },
  loading: { selectedWindow: '24h', data: null },
  '7d': { selectedWindow: '7d', borrowMarket: BORROW_AVAILABLE, data: null },
  '30d': { selectedWindow: '30d', borrowMarket: BORROW_UNAVAILABLE, data: null },
  // A 24H result handed to the 7D view must be ignored, never shown as 7D.
  '7d-with-24h-data': { selectedWindow: '7d', borrowMarket: BORROW_AVAILABLE,
    data: { window: '24h', summary: summaryFixture(), timeseries: timeseriesFixture(), failed: false } },
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
    const statuses = checkScope(tree, SCOPE, { allowLoading: name === 'loading' });
    if (name !== 'loading') assert.ok(![...statuses.values()].includes('loading'), name);
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
  for (const label of ['Arc Intelligence', 'Verified Arc network activity', 'Verified through Oct 3, 14:00 UTC', 'Active Addresses', 'Transactions', 'Total Volume',
    'Average Fee', 'Top Protocols', 'Top Pools (Uniswap V3)', 'Top Pools (Uniswap V4)', 'Latest DEX activity', 'Verified asset transfers', 'Newly launched tokens',
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
  for (const name of ['failed', 'loading', '7d', '30d', '7d-with-24h-data']) assert.deepEqual(windowValues(rendered[name].tree), [], name);
  // While the 24H totals are still being collected, only hour-level and registry values exist: the verified hours.
  assert.deepEqual(windowValues(rendered.collecting.tree), ['active-addresses-chart.latest', 'top-pools-v3.pool-count']);
  // The collecting state still draws every verified hour (18 of 24), and says so in plain words.
  assert.equal(statusIn('collecting', 'volume-chart.swaps'), 'available');
  assert.equal(statusIn('collecting', 'network.transactions'), 'collecting');
  assert.match(textOf(rendered.collecting.tree), /History is still being collected \(18 of 24 hours so far\)\. 24H totals appear once every hour of the window is verified/);
  assert.match(textOf(item(rendered.collecting.tree, 'network.transactions')), /Collecting History is still being collected/);
});

await test('UI 6 Total Volume and Average Fee are never filled in, and no USD value is shown anywhere', async () => {
  for (const [name, { tree, html }] of Object.entries(rendered)) {
    for (const id of ['network.total-volume', 'network.average-fee', 'volume-chart.volume', 'top-protocols.volume-ranking', 'top-pools-v3.volume', 'top-pools-v4.volume']) {
      assert.equal(item(tree, id).attrs['data-intel-status'], 'source_pending', `${name} ${id}`);
    }
    assert.doesNotMatch(textOf(item(tree, 'network.total-volume')), /USDC|\d/, name);
    assert.doesNotMatch(html, /\$\s?\d|\d\s?USD\b|US\$/, `${name}: no USD amount`);
  }
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
  assert.match(text, /Every verified Uniswap V3 pair will be listed here, not only USDC pairs/);
  assert.match(text, /Every verified Uniswap V4 pair will be listed here, not only USDC pairs/);
  assert.match(text, /Tokens without verified details show their shortened address/);
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

await test('UI 9 only the two 24H requests exist; 7D and 30D make no request at all', async () => {
  assert.deepEqual(Object.values(lib.ARC_INTELLIGENCE_REQUESTS), ['/api/intelligence?view=summary&window=24h', '/api/intelligence?view=timeseries&window=24h']);
  for (const url of Object.values(lib.ARC_INTELLIGENCE_REQUESTS)) {
    const parsed = new URL(url, 'https://machina.example');
    assert.equal(parsed.pathname, '/api/intelligence');
    assert.ok(resolveIntelligenceRoute(Object.fromEntries(parsed.searchParams)), `${url} is an exact proxy route`);
  }
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push([url, init.method]);
    return { ok: true, json: async () => (url.includes('timeseries') ? timeseriesFixture() : summaryFixture()) };
  };
  for (const window of ['7d', '30d']) {
    const result = await lib.loadArcIntelligence(window, { fetchImpl });
    assert.deepEqual(result, { window, summary: null, timeseries: null, failed: false });
  }
  assert.deepEqual(calls, [], '7D and 30D never reach the network');
  const result = await lib.loadArcIntelligence('24h', { fetchImpl });
  assert.equal(result.failed, false);
  assert.equal(result.summary.schema, SUMMARY_SCHEMA);
  assert.deepEqual(calls.sort(), [['/api/intelligence?view=summary&window=24h', 'GET'], ['/api/intelligence?view=timeseries&window=24h', 'GET']]);
  assert.doesNotMatch(componentSource, /\bfetch\(/, 'the component only loads through loadArcIntelligence');
  assert.match(componentSource, /if \(!ARC_INTELLIGENCE_BACKEND_WINDOWS\[target\]\) return/);
  assert.deepEqual({ ...scopeModule.ARC_INTELLIGENCE_BACKEND_WINDOWS }, { '24h': true, '7d': false, '30d': false });
  for (const name of ['7d', '30d', '7d-with-24h-data']) {
    assert.match(textOf(rendered[name].tree), /History is still being collected/, name);
    assert.equal(statusIn(name, 'network.transactions'), 'collecting', name);
    assert.equal(statusIn(name, 'active-addresses-chart.series'), 'collecting', name);
  }
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
  for (const name of ['collecting', 'failed', 'loading', '7d', '30d', '7d-with-24h-data']) {
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

console.log(`VERIFIER PASS arc-intelligence-dashboard ${tests.length} tests`);
