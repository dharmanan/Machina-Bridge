// Local worker/HTTP regressions only. No production file, scheduler, discovery execution or RPC.
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Worker } from 'node:worker_threads';
import { performance } from 'node:perf_hooks';
import { readFileSync } from 'node:fs';
import { get } from 'node:http';
import { createEcosystemReader, ECOSYSTEM_READ_TIMEOUT_MS } from '../server/compact/ecosystem-reader.js';
import { createIntelligenceServer } from '../server/compact/http.js';

globalThis.fetch = async () => { throw Error('external_network_forbidden'); };
let passed = 0;
const test = async (name, work) => { await work(); passed++; console.log(`PASS ${name}`); };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
function controlled(options = {}) {
  const workers = [], logs = []; let live = 0, peak = 0;
  const reader = createEcosystemReader({ path: '/tmp/never-opened-private-path.sqlite', timeoutMs: 1000,
    ...options, log: line => logs.push(line), workerFactory: (_url, config) => {
      const worker = new EventEmitter(); worker.sent = []; worker.config = config;
      worker.postMessage = job => { worker.sent.push(job); options.onSend?.(worker, job, workers.length); };
      worker.terminate = async () => { await options.onTerminate?.(); live--; };
      workers.push(worker); live++; peak = Math.max(peak, live); return worker;
    } });
  const reply = (worker, job, value, error) => worker.emit('message', { id: job.id, value, error, workerMs: 1 });
  return { reader, workers, logs, reply, peak: () => peak, live: () => live };
}

await test('timeouts remain six seconds in the worker and eight in the proxy', () => {
  assert.equal(ECOSYSTEM_READ_TIMEOUT_MS, 6000);
  assert.match(readFileSync(new URL('../api/_lib/intelligence-proxy.js', import.meta.url), 'utf8'), /const REQUEST_TIMEOUT_MS = 8_000\b/);
});

await test('all nine fixed route keys coalesce independently and run on one existing worker', async () => {
  const ctx = controlled();
  try {
    const work = [];
    for (const window of ['24h', '7d', '30d']) {
      const read = ctx.reader.read(window); assert.strictEqual(ctx.reader.read(window), read); work.push(read);
      for (const protocol of ['v3', 'v4']) {
        const read = ctx.reader.readPools(protocol, window);
        assert.strictEqual(ctx.reader.readPools(protocol, window), read); work.push(read);
      }
    }
    const worker = ctx.workers[0];
    for (let i = 0; i < work.length; i++) {
      assert.equal(worker.sent.length, i + 1);
      ctx.reply(worker, worker.sent[i], i); assert.equal(await work[i], i);
    }
    assert.equal(ctx.peak(), 1); assert.equal(ctx.workers.length, 1);
    assert.deepEqual(worker.config.resourceLimits, { maxOldGenerationSizeMb: 64, maxYoungGenerationSizeMb: 8 });
  } finally { await ctx.reader.close(); }
  assert.equal(ctx.live(), 0);
});

await test('reply IDs prevent cross-section and obsolete reply races in the same window', async () => {
  const ctx = controlled();
  try {
    const first = ctx.reader.read('24h'), pool = ctx.reader.readPools('v4', '24h'), worker = ctx.workers[0];
    ctx.reply(worker, worker.sent[0], 'ecosystem'); assert.equal(await first, 'ecosystem');
    let finished = false; pool.then(() => { finished = true; });
    ctx.reply(worker, worker.sent[0], 'obsolete'); await Promise.resolve(); assert.equal(finished, false);
    ctx.reply(worker, worker.sent[1], 'v4'); assert.equal(await pool, 'v4');
  } finally { await ctx.reader.close(); }
});

await test('active Ecosystem failure preserves an independent queued V4 read', async () => {
  const ctx = controlled({ timeoutMs: 100, onSend(worker, job, generation) {
    if (generation > 1) queueMicrotask(() => worker.emit('message', { id: job.id, value: 'v4 survives' }));
  } });
  try {
    const first = ctx.reader.read('30d').catch(error => error.code);
    await sleep(30);
    const next = ctx.reader.readPools('v4', '24h');
    assert.equal(await first, 'ecosystem_read_timeout');
    assert.equal(await next, 'v4 survives'); assert.equal(ctx.peak(), 1);
    ctx.workers[0].emit('message', { id: ctx.workers[0].sent[0].id, value: 'obsolete terminated worker' });
    assert.ok(ctx.logs.some(line => /kind=ecosystem.*code=ecosystem_read_timeout/.test(line)));
  } finally { await ctx.reader.close(); }
});

await test('queued deadline remains bounded while an old worker is terminating', async () => {
  const ctx = controlled({ timeoutMs: 80, onTerminate: () => sleep(100) });
  try {
    const first = ctx.reader.readPools('v3', '30d').catch(error => error.code);
    await sleep(20);
    const second = ctx.reader.readPools('v4', '30d').catch(error => error.code);
    assert.equal(await first, 'pools_read_timeout'); assert.equal(await second, 'pools_read_timeout');
    assert.equal(ctx.workers.length, 1);
    assert.ok(ctx.logs.some(line => /protocol=v4.*phase=queued/.test(line)));
  } finally { await ctx.reader.close(); }
});

await test('worker error restarts only the failed job; malformed protocols never enter the queue', async () => {
  const ctx = controlled({ onSend(worker, job, generation) {
    if (generation > 1) queueMicrotask(() => worker.emit('message', { id: job.id, value: 'fresh worker' }));
  } });
  try {
    await assert.rejects(ctx.reader.readPools('v5', '24h'), error => error.code === 'unsupported_protocol');
    await assert.rejects(ctx.reader.readPools('v4', '1h'), error => error.code === 'unsupported_window');
    const first = ctx.reader.readPools('v4', '24h').catch(error => error.code), next = ctx.reader.read('7d');
    ctx.workers[0].emit('error', new Error('private path and SQL'));
    assert.equal(await first, 'ecosystem_worker_failed'); assert.equal(await next, 'fresh worker');
    assert.equal(ctx.peak(), 1); assert.ok(ctx.logs.every(line => !/private path|SELECT|never-opened/.test(line)));
  } finally { await ctx.reader.close(); }
});

await test('close rejects active and queued reads and leaves no worker running', async () => {
  const ctx = controlled();
  const active = ctx.reader.read('24h').catch(error => error.code);
  const queued = ctx.reader.readPools('v4', '24h').catch(error => error.code);
  await ctx.reader.close();
  assert.equal(await active, 'ecosystem_reader_closed'); assert.equal(await queued, 'ecosystem_reader_closed');
  assert.equal(ctx.live(), 0);
  await assert.rejects(ctx.reader.read('30d'), error => error.code === 'ecosystem_reader_closed');
});

const localGet = (server, path) => new Promise((resolve, reject) => {
  const req = get(`http://127.0.0.1:${server.address().port}${path}`, response => {
    let text = ''; response.setEncoding('utf8'); response.on('data', chunk => { text += chunk; });
    response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body: text }));
  });
  req.on('error', reject); req.setTimeout(2000, () => req.destroy(new Error('local_test_timeout')));
});

await test('control: synchronous cold V4 work stalls a concurrent HTTP health response', async () => {
  const model = { health: () => ({ status: 'ok' }), summary() {}, timeseries() {}, activity() {},
    pools() { const end = Date.now() + 350; while (Date.now() < end) {} return { status: 'available' }; } };
  const server = createIntelligenceServer({ readModel: model });
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const at = performance.now(), pool = localGet(server, '/v1/intelligence/pools?protocol=v4&window=30d');
    const health = await localGet(server, '/health'), peerMs = performance.now() - at;
    assert.equal(health.status, 200); assert.ok(peerMs >= 300);
    assert.equal((await pool).status, 200);
    console.log(JSON.stringify({ synchronousV4CpuMs: 350, concurrentHealthMs: peerMs }));
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});

await test('cold V4 CPU work no longer blocks HTTP health or scheduler timers', async () => {
  let begin;
  const started = new Promise(resolve => { begin = resolve; });
  const reader = createEcosystemReader({ path: '/tmp/never-opened.sqlite', workerFactory: (_url, options) => {
    const worker = new Worker(`const {parentPort}=require('node:worker_threads');
      parentPort.on('message',({id,kind})=>{parentPort.postMessage({started:true});
        const end=Date.now()+350;while(Date.now()<end){};
        parentPort.postMessage({id,value:{kind}});});`, { ...options, eval: true });
    worker.on('message', message => { if (message.started) begin(); }); return worker;
  } });
  const model = { health: () => ({ status: 'ok' }), summary() {}, timeseries() {}, activity() {},
    pools: (protocol, window) => reader.readPools(protocol, window), ecosystem: window => reader.read(window) };
  const server = createIntelligenceServer({ readModel: model });
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const pool = localGet(server, '/v1/intelligence/pools?protocol=v4&window=30d');
    await started;
    const at = performance.now(); let ticked = false; const timer = setTimeout(() => { ticked = true; }, 10);
    const health = await localGet(server, '/health');
    await sleep(20); clearTimeout(timer);
    assert.equal(health.status, 200); assert.equal(ticked, true);
    const peerMs = performance.now() - at; assert.ok(peerMs < 200, `peer blocked ${peerMs}ms`);
    assert.equal((await pool).status, 200);
    console.log(JSON.stringify({ simulatedV4CpuMs: 350, concurrentHealthAndTimerMs: peerMs }));
  } finally {
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await reader.close();
  }
});

await test('V4 async errors and oversized responses retain sanitized 503 and identify the exact route', async () => {
  const logs = [], model = { health() {}, summary() {}, timeseries() {}, activity() {},
    async pools(protocol, window) {
      if (window === '24h') throw Object.assign(new Error('private SQL/path'), { code: 'pools_read_timeout' });
      return { padding: 'x'.repeat(256 * 1024) };
    } };
  const server = createIntelligenceServer({ readModel: model, log: line => logs.push(line) });
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const failed = await localGet(server, '/v1/intelligence/pools?protocol=v4&window=24h');
    assert.equal(failed.status, 503); assert.equal(failed.body, '{"error":"unavailable"}');
    assert.equal(failed.headers['cache-control'], 'no-store');
    assert.ok(logs.some(line => /code=pools_read_timeout route=pools protocol=v4 window=24h elapsedMs=\d+/.test(line)));
    const large = await localGet(server, '/v1/intelligence/pools?protocol=v4&window=30d');
    assert.equal(large.status, 503); assert.equal(large.body, '{"error":"response_too_large"}');
    assert.ok(logs.some(line => /HTTP_RESPONSE_TOO_LARGE route=pools protocol=v4 window=30d/.test(line)));
    assert.ok(logs.every(line => !/private SQL|path/.test(line)));
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});

console.log(`VERIFIER PASS compact-read-reliability ${passed} tests (no production, no RPC)`);
