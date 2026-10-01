import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import handler from '../api/intelligence.js';

const tests = [];
async function test(name, work) {
  await work();
  tests.push(name);
  console.log(`PASS ${name}`);
}

function responseDouble() {
  const headers = new Map();
  return {
    statusCode: null,
    body: null,
    setHeader(name, value) { headers.set(name.toLowerCase(), value); },
    status(code) { this.statusCode = code; return this; },
    send(body) { this.body = body; return this; },
    header(name) { return headers.get(name.toLowerCase()); },
    json() { return JSON.parse(this.body); },
  };
}

async function call(req) {
  const res = responseDouble();
  await handler({ headers: {}, ...req }, res);
  return res;
}

async function withFetchDouble(fetchDouble, work) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fetchDouble;
  const originalUrl = process.env.INTELLIGENCE_API_URL;
  try {
    await work();
  } finally {
    globalThis.fetch = originalFetch;
    if (originalUrl === undefined) delete process.env.INTELLIGENCE_API_URL;
    else process.env.INTELLIGENCE_API_URL = originalUrl;
  }
}

await test('proxy forwards only exact allowed views to the configured origin', async () => {
  const seen = [];
  await withFetchDouble(async (url, options) => {
    seen.push({ url, options });
    return { ok: true, status: 200, async json() { return { ok: true }; } };
  }, async () => {
    process.env.INTELLIGENCE_API_URL = 'https://example.internal/base/path';
    const latest = await call({ method: 'GET', query: { view: 'latest' } });
    assert.equal(latest.statusCode, 200);
    const coverage = await call({ method: 'GET', query: { view: 'coverage' } });
    assert.equal(coverage.statusCode, 200);
    const runtime = await call({ method: 'GET', query: { view: 'runtime' } });
    assert.equal(runtime.statusCode, 200);
    const series = await call({ method: 'GET', query: { view: 'timeseries', window: '24h' } });
    assert.equal(series.statusCode, 200);
  });
  assert.deepEqual(seen.map((entry) => entry.url), [
    'https://example.internal/v1/intelligence/latest',
    'https://example.internal/v1/intelligence/coverage',
    'https://example.internal/v1/intelligence/runtime',
    'https://example.internal/v1/intelligence/timeseries?window=24h',
  ]);
  assert(seen.every((entry) => entry.options.method === 'GET'));
  assert(seen.every((entry) => entry.options.headers.accept === 'application/json'));
});

await test('proxy rejects unsupported views, arbitrary forwarding and request bodies', async () => {
  await withFetchDouble(async () => {
    throw new Error('fetch must not run for rejected requests');
  }, async () => {
    assert.equal((await call({ method: 'GET', query: { view: 'http://evil.example' } })).statusCode, 400);
    assert.equal((await call({ method: 'GET', query: { view: 'latest', path: '/health' } })).statusCode, 400);
    assert.equal((await call({ method: 'GET', query: { view: 'timeseries', window: '7d' } })).statusCode, 400);
    assert.equal((await call({ method: 'GET', query: { view: 'timeseries', window: '24h', path: '/health' } })).statusCode, 400);
    assert.equal((await call({ method: 'POST', query: { view: 'latest' } })).statusCode, 405);
    assert.equal((await call({ method: 'GET', query: { view: 'latest' }, headers: { 'content-length': '2' } })).statusCode, 400);
  });
});


await test('dashboard source uses real read model paths and safe user copy', async () => {
  const [component, helpers, dashboard] = await Promise.all([
    readFile(new URL('../src/components/ArcIntelligenceOverview.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/lib/arcIntelligence.ts', import.meta.url), 'utf8'),
    readFile(new URL('../src/components/MainnetDashboard.tsx', import.meta.url), 'utf8'),
  ]);
  assert(component.includes('animate-pulse'));
  assert(component.includes('Arc Intelligence is temporarily unavailable'));
  assert(component.includes('Arc Network Activity'));
  assert(component.includes('Verified historical activity is still being prepared.'));
  assert(component.includes('Transactions over time'));
  assert(component.includes('Active addresses over time'));
  assert(component.includes('USDC transfers over time'));
  assert(component.includes('Data coverage'));
  assert(component.includes('fetchArcTimeseries'));
  assert(component.includes('series?.summary?.uniqueActiveAddresses'));
  assert(component.includes('Unique across verified hours'));
  assert(!component.includes('Math.max(...activeValues)'));
  assert(!component.includes('Peak verified hour'));
  assert(component.includes("useState<ArcTimeseriesWindow>('24h')"));
  assert(helpers.includes("bucket.status !== 'available'"));
  assert(component.includes("return value === null ? total : total + value"));
  assert(component.includes("denominator > 0 ? (successful / denominator) * 100 : null"));
  assert(helpers.includes("return isFiniteNumber(value) ? value.toLocaleString('en-US') : 'Unavailable'"));
  assert(helpers.includes("fetchArcTimeseries"));
  for (const forbidden of ['Live', 'A1 read model', 'A2 runtime', 'a2_shadow', 'bounded chunk', 'receipt lane', 'reconciliation', 'candidate factories', 'decoder coverage', 'Decoder coverage', 'EIP 7708', 'Runtime mode', 'supplyEventCount', 'borrowEventCount', 'burnEventCount', 'mintEventCount', 'warnings[0]', 'Verified subset flows', 'Raw amount']) {
    assert(!component.includes(forbidden), `forbidden user/source copy remains: ${forbidden}`);
  }
  assert(dashboard.includes('<ArcIntelligenceOverview />'));
});

await test('proxy sanitizes invalid origin and upstream failures', async () => {
  await withFetchDouble(async () => {
    throw new Error('fetch must not run with invalid origin');
  }, async () => {
    process.env.INTELLIGENCE_API_URL = 'https://user:pass@example.internal';
    const res = await call({ method: 'GET', query: { view: 'latest' } });
    assert.equal(res.statusCode, 503);
    assert.equal(res.json().error, 'Arc Intelligence is temporarily unavailable');
  });

  await withFetchDouble(async () => ({ ok: false, status: 502, async json() { return { error: 'raw upstream body' }; } }), async () => {
    const res = await call({ method: 'GET', query: { view: 'latest' } });
    assert.equal(res.statusCode, 502);
    assert.equal(res.json().error, 'Arc Intelligence is temporarily unavailable');
    assert(!res.body.includes('raw upstream body'));
  });
});

console.log(`VERIFIER PASS arc-intelligence-dashboard ${tests.length} tests`);
