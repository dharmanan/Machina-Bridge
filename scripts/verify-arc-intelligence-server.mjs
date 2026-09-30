import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { request } from 'node:http';
import { ARC_CHAIN_ID, ARC_RPC_URL } from '../api/_lib/arc-intelligence/rpc.js';
import { DEFINITION_VERSION as CORE_VERSION, MAX_WINDOW_SIZE } from '../api/_lib/arc-intelligence/core.js';
import { buildHistoricalRange } from '../api/_lib/arc-intelligence/history.js';
import { createIndexer, readConfig } from '../server/arc-intelligence/indexer.js';
import { createRepository, createSession } from '../server/arc-intelligence/db.js';
import { buildReadModel, chunkFailureCode, extractCompleteChunk, statusReadModel } from '../server/arc-intelligence/read-model.js';
import { indexingFailureMessage, runIndexerLoop } from '../server/arc-intelligence/main.js';
import { createHttpServer, parseAllowedOrigins } from '../server/arc-intelligence/http.js';
import { migrate } from '../server/arc-intelligence/migrate.js';

const hash = (value) => `0x${value.toString(16).padStart(64, '0')}`;
const config = readConfig({});
const json = (value) => JSON.parse(value);
const tests = [];
async function test(name, work) { await work(); tests.push(name); console.log(`PASS ${name}`); }

// A narrow SQL client double exercises the real repository/session queries,
// transaction boundaries, rollback, duplicate path, and advisory-lock lifecycle.
function fixturePool() {
  let store = { state: null, chunks: new Map(), latest: null, runs: new Map(), migrations: new Map() };
  let nextId = 1;
  let locked = false;
  const calls = [];
  const releases = [];
  let failOn = null;
  function client() {
    let backup = null;
    return {
      async query(sql, values = []) {
        const text = sql.replace(/\s+/g, ' ').trim();
        calls.push({ text, values });
        if (failOn && text.startsWith(failOn)) { failOn = null; throw new Error('Injected DB failure'); }
        const rows = (items = []) => ({ rows: structuredClone(items) });
        if (text === 'BEGIN') { backup = structuredClone(store); return rows(); }
        if (text === 'COMMIT') { backup = null; return rows(); }
        if (text === 'ROLLBACK') { if (backup) store = backup; backup = null; return rows(); }
        if (text.startsWith('SELECT pg_try_advisory_lock')) {
          const acquired = !locked; if (acquired) locked = true; return rows([{ locked: acquired }]);
        }
        if (text.startsWith('SELECT pg_advisory_unlock')) { locked = false; return rows([{ pg_advisory_unlock: true }]); }
        if (text.startsWith('SELECT pg_advisory_xact_lock') || text.startsWith('CREATE TABLE')
          || text.startsWith('ALTER TABLE arc_intelligence_blocks') || text === 'SELECT 1') return rows();
        if (text.startsWith('SELECT * FROM arc_intelligence_migrations')) return rows(store.migrations.has(values[0]) ? [store.migrations.get(values[0])] : []);
        if (text.startsWith('INSERT INTO arc_intelligence_migrations')) {
          store.migrations.set(values[0], { version: values[0], checksum: values[1], metadata: json(values[2]) }); return rows();
        }
        if (text.startsWith('SELECT * FROM arc_intelligence_state')) return rows(store.state ? [store.state] : []);
        if (text.startsWith('INSERT INTO arc_intelligence_state')) {
          store.state ??= { id: 1, chain_id: values[0], source: values[1], next_block: null,
            last_indexed_block: null, last_indexed_hash: null, latest_arc_head: null, safe_head: null,
            last_success_at: null, last_error: null, status: 'starting', engine_versions: {} };
          return rows();
        }
        if (text.startsWith('UPDATE arc_intelligence_state SET next_block = $1, updated_at')) {
          if (store.state.next_block === null && store.state.chain_id === values[1] && store.state.source === values[2]) store.state.next_block = values[0];
          return rows();
        }
        if (text.startsWith('UPDATE arc_intelligence_state SET latest_arc_head')) {
          Object.assign(store.state, { latest_arc_head: values[0], safe_head: values[1], last_attempt_at: 'attempted' }); return rows();
        }
        if (text.startsWith('UPDATE arc_intelligence_state SET status')) {
          Object.assign(store.state, { status: values[0], last_error: values[1] }); return rows();
        }
        if (text.startsWith('UPDATE arc_intelligence_state SET next_block')) {
          Object.assign(store.state, { next_block: values[0], last_indexed_block: values[1], last_indexed_hash: values[2],
            engine_versions: json(values[3]), status: 'indexing', last_error: null, last_success_at: 'success' }); return rows();
        }
        if (text.startsWith('SELECT start_hash, end_hash')) {
          const chunk = store.chunks.get(`${values[0]}:${values[1]}`); return rows(chunk ? [chunk] : []);
        }
        if (text.startsWith('INSERT INTO arc_intelligence_chunks')) {
          const key = `${values[0]}:${values[1]}`;
          assert(!store.chunks.has(key), 'chunk unique constraint');
          store.chunks.set(key, { start_hash: values[2], end_hash: values[3], metrics: json(values[10]) }); return rows();
        }
        if (text.startsWith('INSERT INTO arc_intelligence_latest')) {
          store.latest = { payload: json(values[0]), block_number: values[1], block_hash: values[2] }; return rows();
        }
        if (text.startsWith('SELECT payload')) return rows(store.latest ? [store.latest] : []);
        if (text.startsWith('INSERT INTO arc_intelligence_runs')) {
          const id = nextId++; store.runs.set(id, { start: values[0], end: values[1] }); return rows([{ id }]);
        }
        if (text.startsWith('UPDATE arc_intelligence_runs')) {
          Object.assign(store.runs.get(values[0]), { success: values[1], error: values[2] }); return rows();
        }
        if (text.startsWith('DELETE FROM arc_intelligence_runs')) return rows();
        throw new Error(`Unhandled SQL fixture: ${text}`);
      },
      release(broken) { releases.push(Boolean(broken)); },
    };
  }
  return { calls, releases, get store() { return store; }, setFailure(prefix) { failOn = prefix; },
    async connect() { return client(); }, async query(...args) { return client().query(...args); } };
}

function coreFixture(start, end) {
  const blocks = Array.from({ length: end - start + 1 }, (_, i) => ({ number: start + i,
    hash: hash(start + i + 1), parentHash: hash(start + i), timestamp: 1700000000 + start + i,
    transactionCount: 1 }));
  return { chainId: ARC_CHAIN_ID, source: ARC_RPC_URL, definitionVersion: CORE_VERSION,
    complete: true, startBlock: start, endBlock: end, lastIndexedBlock: end, blockCount: blocks.length, blocks,
    startTimestamp: blocks[0].timestamp, endTimestamp: blocks.at(-1).timestamp,
    totalTransactions: blocks.length, receiptCount: blocks.length,
    allLogReconciliation: { complete: true, receiptSetComplete: true, queryComplete: true },
    transferLogReconciliation: { complete: true, receiptSetComplete: true, queryComplete: true }, transferScanComplete: true,
    canonicalUsdc: { amountRaw: '900719925474099312345', transferCount: 1, rawDecimals: 18, complete: true,
      erc20InterfaceActivity: { amountRaw: '900719925', rawDecimals: 6, includedInCanonicalAmount: false } },
    verifiedAssetTransfers: [], verifiedAssetObservations: [], warnings: [],
    transactions: [{ mustNotPersist: true }], receipts: [{ mustNotPersist: true }], logs: [{ mustNotPersist: true }] };
}

function fixtureEngine(options = {}) {
  const ranges = [];
  const snapshotCalls = [];
  const rpc = { url: ARC_RPC_URL, async request(method) {
    assert.equal(method, 'eth_blockNumber');
    if (options.failHead) throw new Error('timeout');
    return `0x${(options.head ?? 100).toString(16)}`;
  } };
  const snapshotBuilder = async ({ startBlock, endBlock }) => {
    snapshotCalls.push([startBlock, endBlock]);
    if (options.snapshotUnavailable) throw new Error('Untrusted upstream body must not be exposed');
    const core = coreFixture(startBlock, endBlock);
    if (options.incomplete) core.complete = false;
    if (options.badSource) core.source = 'https://wrong.example';
    if (options.badParent) core.blocks[0].parentHash = hash(999);
    if (options.receiptIncomplete) {
      core.complete = false; core.receiptCount -= 1;
      core.allLogReconciliation = { complete: false, receiptSetComplete: false, queryComplete: true };
      core.transferLogReconciliation = { complete: false, receiptSetComplete: false, queryComplete: true };
      core.transferScanComplete = false;
    }
    if (options.allLogIncomplete) {
      core.complete = false; core.allLogReconciliation.complete = false;
    }
    if (options.transferLogIncomplete) {
      core.complete = false; core.transferLogReconciliation.complete = false; core.transferScanComplete = false;
    }
    if (options.badTimestamp) core.startTimestamp = null;
    return core;
  };
  const historyBuilder = async ({ startBlock, endBlock, ...rest }) => {
    ranges.push([startBlock, endBlock]);
    if (options.failChunk) throw new Error('HTTP 429');
    return buildHistoricalRange({ ...rest, startBlock, endBlock,
      snapshotBuilder: rest.snapshotBuilder ?? snapshotBuilder,
      protocolBuilders: {
        morpho: async () => {
          if (options.failDecoder) throw new Error('decoder unavailable');
          return { source: ARC_RPC_URL, definitionVersion: 'morpho-fixture-v1',
            completeness: { complete: false, verifiedVaultEventScanComplete: true, candidateCoverageComplete: false, unresolvedCandidateCount: 2 },
            candidateVaultCount: 10, verifiedVaultCount: 8, candidates: [],
            accountingMetrics: { totalAssets: { status: 'unavailable' }, apy: { status: 'unavailable' } },
            rawFlows: [{ type: 'deposit', emitter: hash(1), assetsRaw: '900719925474099312345', sharesRaw: '123' },
              { type: 'deposit', emitter: hash(1), assetsRaw: '1', sharesRaw: '456' },
              { type: 'deposit', emitter: hash(2), assetsRaw: '2', sharesRaw: '789' }], warnings: [] };
        },
      },
    });
  };
  return { rpc, historyBuilder, snapshotBuilder, ranges, snapshotCalls };
}
function setup(options = {}, bounds = config) {
  const pool = fixturePool();
  const repository = createRepository(pool);
  const engine = fixtureEngine(options);
  return { pool, repository, ...engine, indexer: createIndexer({ repository, ...engine, config: bounds }) };
}
async function seed(pool, nextBlock, previousHash = null) {
  const session = createSession(await pool.connect());
  await session.ensureState(); await session.initialize(nextBlock);
  pool.store.state.last_indexed_hash = previousHash;
  pool.store.state.last_indexed_block = previousHash ? nextBlock - 1 : null;
}

await test('bounded defaults and invalid env fail closed', async () => {
  assert.equal(config.chunkSize, 25); assert.equal(config.pollMs, 10000);
  assert.equal(config.finalityBlocks, 2); assert.equal(config.maxChunksPerTick, 4);
  assert.throws(() => readConfig({ INTELLIGENCE_CHUNK_SIZE: String(MAX_WINDOW_SIZE + 1) }));
  assert.throws(() => readConfig({ INTELLIGENCE_POLL_MS: '0' }));
  assert.throws(() => readConfig({ INTELLIGENCE_FINALITY_BLOCKS: '-1' }));
});
await test('idempotent startup migration transaction', async () => {
  const pool = fixturePool(); await migrate(pool); await migrate(pool);
  assert.equal(pool.calls.filter(({ text }) => text === 'COMMIT').length, 2);
  const sql = await readFile(new URL('../server/arc-intelligence/sql/001_init.sql', import.meta.url), 'utf8');
  assert.equal((sql.match(/CREATE TABLE IF NOT EXISTS/g) ?? []).length, 4);
  assert(sql.includes('PRIMARY KEY (start_block, end_block)'));
});
await test('first boot starts bounded near head and atomically advances', async () => {
  const x = setup(); assert.equal((await x.indexer.tick()).status, 'caught_up');
  assert.deepEqual(x.ranges, [[74, 98]]);
  assert.equal(x.pool.store.state.next_block, 99); assert.equal(x.pool.store.state.last_indexed_block, 98);
  assert.equal(x.pool.store.chunks.size, 1); assert.equal(x.pool.store.latest.block_number, 98);
  const texts = x.pool.calls.map(({ text }) => text);
  const begin = texts.indexOf('BEGIN'); const commit = texts.indexOf('COMMIT');
  assert(begin >= 0 && commit > begin);
  for (const table of ['arc_intelligence_chunks', 'arc_intelligence_latest']) {
    const index = texts.findIndex((text) => text.startsWith(`INSERT INTO ${table}`));
    assert(index > begin && index < commit);
  }
  assert.equal(x.pool.releases.at(-1), false);
  assert(!JSON.stringify(x.pool.store.latest).includes('mustNotPersist'));
});
await test('existing checkpoint resumes exactly, sequential tick budget', async () => {
  const x = setup({ head: 500 }); await seed(x.pool, 10, hash(10));
  await x.indexer.tick();
  assert.deepEqual(x.ranges, [[10, 34], [35, 59], [60, 84], [85, 109]]);
  assert.equal(x.pool.store.state.next_block, 110);
  assert.equal(x.pool.store.state.status, 'indexing');
});
await test('incomplete/source mismatch chunks never advance', async () => {
  for (const options of [{ incomplete: true }, { badSource: true }]) {
    const x = setup(options); await seed(x.pool, 74); await x.indexer.tick();
    assert.equal(x.pool.store.state.next_block, 74); assert.equal(x.pool.store.chunks.size, 0);
    assert.equal(x.pool.store.state.status, 'degraded'); assert.equal(x.pool.store.latest, null);
  }
});
await test('RPC head/429 failures retry same checkpoint without crashing', async () => {
  for (const options of [{ failHead: true }, { failChunk: true }]) {
    const x = setup(options); await seed(x.pool, 74);
    assert.equal((await x.indexer.tick()).status, 'degraded'); await x.indexer.tick();
    assert.equal(x.pool.store.state.next_block, 74); assert.equal(x.pool.store.chunks.size, 0);
    if (options.failChunk) assert.deepEqual(x.ranges, [[74, 98], [74, 98]]);
  }
});
await test('parent hash mismatch halts with continuity_error, no rollback', async () => {
  const x = setup({ badParent: true }); await seed(x.pool, 74, hash(74));
  assert.equal((await x.indexer.tick()).status, 'continuity_error');
  assert.equal(x.pool.store.state.next_block, 74); assert.equal(x.pool.store.latest, null);
  assert.equal((await x.indexer.tick()).stopped, true); assert.equal(x.ranges.length, 1);
});
await test('duplicate retry idempotent and conflicting hashes rejected', async () => {
  const x = setup(); await x.indexer.tick();
  const history = await x.historyBuilder({ rpc: x.rpc, startBlock: 74, endBlock: 98, chunkSize: 25 });
  const chunk = extractCompleteChunk(history, 74, 98);
  const state = structuredClone(x.pool.store.state);
  const latest = structuredClone(x.pool.store.latest);
  const session = createSession(await x.pool.connect());
  assert.equal((await session.saveChunk(chunk, buildReadModel(history, chunk))).duplicate, true);
  assert.deepEqual(x.pool.store.state, state); assert.deepEqual(x.pool.store.latest, latest); assert.equal(x.pool.store.chunks.size, 1);
  await assert.rejects(session.saveChunk({ ...chunk, endHash: hash(0) }, latest.payload));
  assert.deepEqual(x.pool.store.state, state);
});
await test('mid transaction failure rolls back chunk, latest and checkpoint', async () => {
  const x = setup(); await seed(x.pool, 74);
  x.pool.setFailure('INSERT INTO arc_intelligence_latest');
  assert.equal((await x.indexer.tick()).status, 'degraded');
  assert.equal(x.pool.store.chunks.size, 0); assert.equal(x.pool.store.latest, null); assert.equal(x.pool.store.state.next_block, 74);
  await x.indexer.tick(); assert.equal(x.pool.store.chunks.size, 1); assert.equal(x.pool.store.state.next_block, 99);
});
await test('advisory lock skips competing indexer and releases lock', async () => {
  const x = setup(); const holder = await x.pool.connect(); await holder.query('SELECT pg_try_advisory_lock(5042, 177001) AS locked');
  assert.equal((await x.indexer.tick()).skipped, true); assert.equal(x.ranges.length, 0);
  await holder.query('SELECT pg_advisory_unlock(5042, 177001)');
  await x.indexer.tick(); assert.equal(x.ranges.length, 1);
});
await test('decoder unavailable does not fabricate data or stall complete core checkpoint', async () => {
  const x = setup({ failDecoder: true }); await x.indexer.tick();
  assert.equal(x.pool.store.state.next_block, 99);
  assert.equal(x.pool.store.latest.payload.lending.morpho.status, 'unavailable');
  assert.equal(x.pool.store.latest.payload.coverage.protocolCoverage.morpho.complete, false);
});
await test('compact model preserves raw precision, units, partial/unavailable and scope', async () => {
  const x = setup(); await x.indexer.tick(); const p = x.pool.store.latest.payload;
  assert.equal(p.window, 'latest_bounded_chunk'); assert.equal(p.coverage.coreRangeComplete, true);
  assert.equal(p.lending.morpho.status, 'partial'); assert.equal(p.lending.morpho.completeness.candidateCoverageComplete, false);
  assert.equal(p.lending.morpho.data.accountingMetrics.apy.status, 'unavailable');
  assert.equal(p.coverage.historicalMetrics.status, 'unavailable');
  assert.equal(p.assets.canonicalUsdc.amountRaw, '900719925474099312345');
  assert.equal(p.assets.canonicalUsdc.erc20InterfaceActivity.includedInCanonicalAmount, false);
  const flows = p.lending.morpho.data.verifiedSubsetFlows;
  assert.equal(flows.length, 2); assert.equal(flows[0].raw.assetsRaw, '900719925474099312346');
  assert.equal(flows[0].raw.sharesRaw, '579'); assert.equal(p.lending.morpho.data.flowScope, 'verified_vault_subset');
  for (const field of ['tvl', 'aum', 'usd', 'volume24h', 'volume7d']) assert(!JSON.stringify(p).includes(`"${field}"`));
  assert.equal(p.interop.cctp.status, 'unavailable');
});

function httpCall(server, path, method = 'GET', headers = {}) {
  return new Promise((resolve, reject) => {
    const req = request({ hostname: '127.0.0.1', port: server.address().port, path, method, headers }, (res) => {
      let data = ''; res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, headers: res.headers, body: JSON.parse(data) }); }
        catch { reject(new Error(`Non JSON fixture response: ${method} ${path} status ${res.statusCode}`)); }
      });
    });
    req.on('error', reject); req.end(headers['content-length'] === '1' ? 'x' : undefined);
  });
}
await test('read API endpoints, method/body limits, CORS and sanitized DB failure', async () => {
  const x = setup();
  const server = createHttpServer({ repository: x.repository });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    assert.equal((await httpCall(server, '/health')).status, 200);
    assert.equal((await httpCall(server, '/v1/intelligence/latest')).status, 503);
    assert.equal((await httpCall(server, '/v1/intelligence/coverage')).body.status, 'unavailable');
    assert.equal((await httpCall(server, '/v1/intelligence/status')).body.lagBlocks, null);
    await x.indexer.tick();
    await createSession(await x.pool.connect()).setStatus('degraded', 'rpc_head_unavailable');
    assert.equal((await httpCall(server, '/health')).status, 200, 'RPC degraded must not fail DB health');
    const status = await httpCall(server, '/v1/intelligence/status');
    assert.equal(status.body.status, 'degraded'); assert.equal(status.body.lagBlocks, 0);
    assert.equal((await httpCall(server, '/v1/intelligence/latest')).body.window, 'latest_bounded_chunk');
    assert.equal((await httpCall(server, '/v1/intelligence/coverage')).body.coreRangeComplete, true);
    assert.equal((await httpCall(server, '/v1/intelligence/latest', 'POST')).status, 405);
    assert.equal((await httpCall(server, '/v1/intelligence/latest', 'GET', { 'content-length': '1' })).status, 400);
    assert.equal((await httpCall(server, '/v1/intelligence/latest?range=all')).status, 404);
    const denied = await httpCall(server, '/v1/intelligence/latest', 'GET', { origin: 'https://app.example' });
    assert.equal(denied.status, 403); assert.equal(denied.headers['access-control-allow-origin'], undefined);
    assert.equal(status.headers['x-content-type-options'], 'nosniff'); assert.equal(status.headers['cache-control'], 'no-store');
    x.pool.setFailure('SELECT payload');
    const failure = await httpCall(server, '/v1/intelligence/latest'); assert.equal(failure.status, 503);
    assert.deepEqual(failure.body, { error: 'intelligence_database_unavailable' });
    x.pool.setFailure('SELECT 1');
    assert.equal((await httpCall(server, '/health')).status, 503);
  } finally { await new Promise((resolve) => server.close(resolve)); }
  assert.equal(parseAllowedOrigins().size, 0); assert.throws(() => parseAllowedOrigins('*'));
  const allowed = createHttpServer({ repository: x.repository, allowedOrigins: parseAllowedOrigins('https://app.example') });
  await new Promise((resolve) => allowed.listen(0, '127.0.0.1', resolve));
  try {
    const ok = await httpCall(allowed, '/v1/intelligence/latest', 'GET', { origin: 'https://app.example' });
    assert.equal(ok.status, 200); assert.equal(ok.headers['access-control-allow-origin'], 'https://app.example');
    assert.equal(ok.headers['access-control-allow-credentials'], undefined);
    assert.equal((await httpCall(allowed, '/v1/intelligence/latest', 'OPTIONS',
      { origin: 'https://app.example', 'access-control-request-method': 'POST' })).status, 405);
  } finally { await new Promise((resolve) => allowed.close(resolve)); }
});
await test('Railway uses backend-only check and start', async () => {
  const packageJson = json(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(packageJson.scripts['start:intelligence'], 'node server/arc-intelligence/main.js');
  const railway = await readFile(new URL('../railway.toml', import.meta.url), 'utf8');
  assert(railway.includes('builder = "RAILPACK"')); assert(railway.includes('healthcheckPath = "/health"'));
  assert(railway.includes('buildCommand = "npm run railway:intelligence:check"'));
  assert(railway.includes('startCommand = "npm run start:intelligence"')); assert(!railway.includes('vite'));
});
await test('runtime loop uses catchup delay only for backlog; ticks remain sequential', async () => {
  const controller = new AbortController();
  const statuses = ['indexing', 'caught_up', 'degraded', 'continuity_error', undefined];
  const delays = [];
  const logs = [];
  let ticks = 0;
  let inFlight = 0;
  let maxInFlight = 0;
  await runIndexerLoop({ pollMs: 12345, signal: controller.signal, log: (message) => logs.push(message),
    indexer: { async tick() {
      inFlight += 1; maxInFlight = Math.max(maxInFlight, inFlight);
      await Promise.resolve(); inFlight -= 1;
      return { status: statuses[ticks++], error: 'core_incomplete', startBlock: 74, endBlock: 98 };
    } },
    sleepImpl: async (ms, value, { signal }) => {
      assert.equal(signal, controller.signal); assert.equal(value, undefined);
      delays.push(ms); if (delays.length === statuses.length) controller.abort();
    },
  });
  assert.deepEqual(delays, [500, 12345, 12345, 12345, 12345]);
  assert.equal(maxInFlight, 1); assert.equal(ticks, statuses.length);
  assert.deepEqual(logs, ['Arc Intelligence indexing degraded: 74..98 core_incomplete']);
});
await test('AbortSignal interrupts runtime sleep and prevents another tick', async () => {
  const controller = new AbortController(); let ticks = 0;
  await runIndexerLoop({ pollMs: config.pollMs, signal: controller.signal,
    indexer: { async tick() { ticks += 1; return { status: 'caught_up' }; } },
    sleepImpl: async (ms, value, { signal }) => {
      assert.equal(ms, config.pollMs);
      return new Promise((resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Error('AbortError')), { once: true });
        queueMicrotask(() => controller.abort());
      });
    },
  });
  assert.equal(ticks, 1);
});
await test('incomplete core reason selection uses original receipt/log evidence, no second crawl', async () => {
  for (const [options, code] of [
    [{ incomplete: true }, 'core_incomplete'],
    [{ receiptIncomplete: true }, 'receipt_coverage_incomplete'],
    [{ allLogIncomplete: true }, 'all_log_reconciliation_incomplete'],
    [{ transferLogIncomplete: true }, 'transfer_log_reconciliation_incomplete'],
    [{ snapshotUnavailable: true }, 'snapshot_unavailable'],
    [{ badTimestamp: true }, 'core_incomplete'],
  ]) {
    const x = setup(options); await seed(x.pool, 74);
    const result = await x.indexer.tick();
    assert.equal(result.status, 'degraded'); assert.equal(result.error, code); assert.equal(result.indexedChunks, 0);
    assert.equal(x.pool.store.state.last_error, code); assert.equal(x.pool.store.state.next_block, 74);
    assert.equal(x.pool.store.latest, null); assert.equal(x.pool.store.chunks.size, 0);
    assert.equal(x.pool.store.runs.get(1).success, false); assert.equal(x.pool.store.runs.get(1).error, code);
    assert.deepEqual(x.snapshotCalls, [[74, 98]]);
    assert.equal(indexingFailureMessage(result), `Arc Intelligence indexing degraded: 74..98 ${code}`);
    await x.indexer.tick(); assert.deepEqual(x.snapshotCalls, [[74, 98], [74, 98]]);
  }
  const core = coreFixture(74, 98); core.allLogReconciliation.complete = false;
  assert.equal(chunkFailureCode({ complete: true }, core), 'all_log_reconciliation_incomplete', 'do not trust a false success flag');
});
await test('specific failures retain prior trusted payload and resume exact failed range', async () => {
  const x = setup({ head: 500 }); await seed(x.pool, 10);
  const engine = fixtureEngine({ head: 500 }); let count = 0;
  const indexer = createIndexer({ repository: x.repository, rpc: engine.rpc, config,
    historyBuilder: engine.historyBuilder, snapshotBuilder: async (args) => {
      const core = await engine.snapshotBuilder(args);
      if (++count === 2) { core.complete = false; core.allLogReconciliation.complete = false; }
      return core;
    },
  });
  const result = await indexer.tick();
  assert.equal(result.status, 'degraded'); assert.equal(result.indexedChunks, 1);
  assert.equal(result.error, 'all_log_reconciliation_incomplete'); assert.equal(x.pool.store.state.next_block, 35);
  assert.equal(x.pool.store.latest.block_number, 34); assert.equal(x.pool.store.chunks.size, 1);
  assert.deepEqual([result.startBlock, result.endBlock], [35, 59]);
  await indexer.tick(); assert.deepEqual(engine.ranges.slice(0, 3), [[10, 34], [35, 59], [35, 59]]);
});
await test('head, database and continuity failures return stable codes', async () => {
  const head = setup({ failHead: true }); await seed(head.pool, 74);
  assert.equal((await head.indexer.tick()).error, 'rpc_head_unavailable');
  assert.equal(head.pool.store.state.last_error, 'rpc_head_unavailable');
  const database = setup(); await seed(database.pool, 74); database.pool.setFailure('INSERT INTO arc_intelligence_latest');
  assert.equal((await database.indexer.tick()).error, 'database_unavailable');
  assert.equal(database.pool.store.state.last_error, 'database_unavailable');
  assert.equal(database.pool.store.state.next_block, 74);
  const unavailable = setup(); unavailable.pool.setFailure('SELECT pg_try_advisory_lock');
  assert.equal((await unavailable.indexer.tick()).error, 'database_unavailable');
  const continuity = setup({ badParent: true }); await seed(continuity.pool, 74, hash(74));
  assert.equal((await continuity.indexer.tick()).error, 'checkpoint_parent_hash_mismatch');
});
await test('status and logs expose only bounded codes, never arbitrary stored errors', async () => {
  const untrusted = 'postgres://example:NOT_A_REAL_PASSWORD@invalid.example Internal upstream body';
  assert.equal(statusReadModel({ last_error: untrusted }).lastError, null);
  assert.equal(statusReadModel({ last_error: 'chunk_unavailable_or_incomplete' }).lastError, 'core_incomplete');
  assert.equal(statusReadModel({ last_error: 'arc_rpc_head_unavailable' }).lastError, 'rpc_head_unavailable');
  for (const code of ['rpc_head_unavailable', 'snapshot_unavailable', 'core_incomplete', 'receipt_coverage_incomplete',
    'all_log_reconciliation_incomplete', 'transfer_log_reconciliation_incomplete',
    'checkpoint_parent_hash_mismatch', 'database_unavailable']) {
    assert.equal(statusReadModel({ last_error: code }).lastError, code);
  }
  const message = indexingFailureMessage({ error: untrusted, startBlock: untrusted, endBlock: 98 });
  assert.equal(message, 'Arc Intelligence indexing degraded: core_incomplete');
  const x = setup(); await seed(x.pool, 74); x.pool.store.state.last_error = untrusted;
  const server = createHttpServer({ repository: x.repository });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try { assert.equal((await httpCall(server, '/v1/intelligence/status')).body.lastError, null); }
  finally { await new Promise((resolve) => server.close(resolve)); }
});
console.log(`INTELLIGENCE_SERVER_VERIFIER: PASS (${tests.length} deterministic scenarios; no live DB/RPC)`);
