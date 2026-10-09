// Synthetic local SQLite only; never opens a production file, fetches RPC or runs an indexer.
import assert from 'node:assert/strict';
import { DatabaseSync, backup } from 'node:sqlite';
import { performance } from 'node:perf_hooks';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { get } from 'node:http';
import { EventEmitter } from 'node:events';
import { Worker } from 'node:worker_threads';
import { pathToFileURL } from 'node:url';
import { createCompactStore } from '../server/compact/store.js';
import { COMPACT_DEFINITION_VERSION } from '../server/compact/sources.js';
import { FAMILY_FIELDS } from '../server/compact/families.js';
import { INTELLIGENCE_REGISTRY, INTELLIGENCE_VERSION, registryDigest } from '../server/compact/intelligence-registry.js';
import { readEcosystem } from '../server/compact/intelligence-store.js';
import { createCompactReadModel } from '../server/compact/read-model.js';
import { createEcosystemReader } from '../server/compact/ecosystem-reader.js';
import { createIntelligenceServer } from '../server/compact/http.js';

const address = (n) => `0x${n.toString(16).padStart(40, '0')}`;
const hash = (n) => `0x${n.toString(16).padStart(64, '0')}`;
const BASE = Date.parse('2026-09-16T11:00:00.000Z') / 1000;
export const FIXTURE_SIZE = { hours: 560, unresolvedCandidates: 142562, verifiedTokens: 50, pools: 2000,
  poolHours: 560000, poolsPerToken: 4 };

export function createPerformanceFixture(path = ':memory:') {
  const db = new DatabaseSync(path), store = createCompactStore(db);
  for (let i = 0; i < FIXTURE_SIZE.hours; i++) {
    const firstBlock = 100 + i * 10, lastBlock = firstBlock + 9, hourStart = BASE + i * 3600;
    const range = { kind: 'hour', hourStart, hourEnd: hourStart + 3600, firstBlock, lastBlock,
      parentHash: hash(firstBlock - 1), firstHash: hash(firstBlock), lastHash: hash(lastBlock) };
    const intelligence = { version: INTELLIGENCE_VERSION, registryDigest: registryDigest(INTELLIGENCE_REGISTRY), range,
      discovery: { status: 'insufficient_coverage', candidates: [], reason: 'synthetic_fixture', allArcTokensComplete: false },
      firstDex: [], firstDexComplete: true, exchange: { status: 'unavailable', rows: [] }, protocols: [], launchSources: [] };
    store.commitHour({ definitionVersion: COMPACT_DEFINITION_VERSION, sourceVersions: {}, chainId: 5042, range,
      network: { status: 'available', blockCount: 10, transactionCount: 1, uniqueActiveAddresses: 0, gasUsedRaw: '21000' }, activeAddresses: [],
      families: Object.fromEntries(Object.entries(FAMILY_FIELDS).map(([name, fields]) => [name, { status: 'unavailable', reason: 'fixture',
        ...Object.fromEntries(fields.map((field) => [field, null])) }])), registry: { uniswapV3: null }, complete: false, intelligence });
  }
  const insertCandidate = db.prepare(`INSERT INTO compact_token_discoveries
    (candidate_key,hour_start,block_number,address,candidate_json,result_json,status,reason) VALUES (?,?,?,?,?,?,?,?)`);
  const insertPool = db.prepare('INSERT INTO compact_registry VALUES(?,?,?,?,?,?)');
  const insertPoolHour = db.prepare('INSERT INTO compact_pool_hours VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
  const insertObservation = db.prepare('INSERT INTO compact_token_dex_observations VALUES(?,?,?,?,?,?,?,?)');
  db.exec('BEGIN');
  try {
    for (let i = 0; i < FIXTURE_SIZE.unresolvedCandidates + FIXTURE_SIZE.verifiedTokens; i++) {
      const verified = i < FIXTURE_SIZE.verifiedTokens;
      const index = verified ? 559 - i % 20 : i % 560, hourStart = BASE + index * 3600;
      const candidate = { timestamp: hourStart + 10, blockNumber: 101 + index * 10,
        txHash: hash(100000 + i), blockHash: hash(101 + index * 10), readBlock: 109 + index * 10,
        transactionIndex: 0, kind: 'creation', deployer: address(900), address: null };
      const result = verified ? { ...candidate, address: address(800 + i), symbol: 'BENCH', name: 'Synthetic fixture token', decimals: 18,
        directDeploymentVerified: true, launch: { status: 'direct_deployment', source: null },
        verification: { basis: 'synthetic_fixture_only', evidence: 'x'.repeat(1800) } } : null;
      insertCandidate.run(`fixture-${i}`, BigInt(hourStart), BigInt(candidate.blockNumber), address(800 + i),
        JSON.stringify(candidate), result && JSON.stringify(result), verified ? 'verified_erc20_like' : 'unverified', verified ? null : 'provider_rate_limited');
    }
    for (let i = 0; i < FIXTURE_SIZE.pools; i++) {
      const relevant = i < FIXTURE_SIZE.verifiedTokens * FIXTURE_SIZE.poolsPerToken;
      const token = relevant ? address(800 + Math.floor(i / FIXTURE_SIZE.poolsPerToken)) : address(200000 + i);
      insertPool.run('uniswap_v3_pool', address(500000 + i), 102n, BigInt(i), hash(102),
        JSON.stringify({ token0: token, token1: '0x3600000000000000000000000000000000000000' }));
      if (relevant) insertObservation.run(BigInt(BASE + 559 * 3600), 'uniswap_v3', address(500000 + i), 'swap', 5695n,
        BigInt(i), BigInt(BASE + 559 * 3600 + 20), hash(5695));
    }
    for (let i = 0; i < FIXTURE_SIZE.poolHours; i++) {
      const pool = address(500000 + i % 1000), hourStart = BASE + Math.floor(i / 1000) * 3600;
      insertPoolHour.run(BigInt(hourStart), 'uniswap_v3', pool, 1n, '0', '0', '0', '0', 0n, 0n, 0n, '0', '0', '0', '0');
    }
    for (let i = 0; i < 560; i++) db.prepare('INSERT INTO compact_projection_hours VALUES(?,?,?,?,?,?)')
      .run(BigInt(BASE + i * 3600), 'uniswap_v3_pools', 'available', null, 1000n, 'synthetic_fixture');
    for (const kind of ['uniswap_v3_pool', 'uniswap_v4_pool']) db.prepare('INSERT INTO compact_registry_coverage VALUES(?,?,?,?)')
      .run(kind, 0n, 5699n, hash(5699));
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); db.close(); throw error; }
  return db;
}

export function profileRead(db, read, window) {
  const groups = {}, queries = [];
  const category = (sql) => /ROW_NUMBER/i.test(sql) ? 'candidate_ranking' : /compact_pool_hours/.test(sql) ? 'pool_activity'
    : /json_extract\(meta_json/.test(sql) ? 'registry_json_search' : /firstDexComplete/.test(sql) ? 'dex_coverage'
      : /compact_token_discoveries/.test(sql) ? 'candidate_metadata' : 'other';
  const record = (sql, time) => {
    const name = category(sql), item = groups[name] ??= { calls: 0, ms: 0 };
    item.calls++; item.ms += time; queries.push({ sql, ms: time });
  };
  const profiled = { prepare(sql) {
    const statement = db.prepare(sql), result = {};
    for (const method of ['all', 'get']) result[method] = (...args) => {
      const start = performance.now(); try { return statement[method](...args); } finally { record(sql, performance.now() - start); }
    };
    result.iterate = function* (...args) {
      const start = performance.now(); try { yield* statement.iterate(...args); } finally { record(sql, performance.now() - start); }
    };
    return result;
  } };
  const start = performance.now(), value = read(profiled, window), ms = performance.now() - start;
  return { value, ms, groups, queryCount: queries.length,
    nonQueryMs: ms - Object.values(groups).reduce((sum, row) => sum + row.ms, 0),
    slowest: queries.sort((a, b) => b.ms - a.ms).slice(0, 5).map(row => ({ sql: row.sql.slice(0,600), ms: row.ms,
      plan: db.prepare(`EXPLAIN QUERY PLAN ${row.sql}`).all(...Array((row.sql.match(/\?/g) ?? []).length).fill(0)).map(step => step.detail).slice(0,20) })) };
}

const localGet = (server, path) => new Promise((resolve, reject) => {
  const request = get(`http://127.0.0.1:${server.address().port}${path}`, response => {
    let text=''; response.setEncoding('utf8'); response.on('data',chunk=>{text+=chunk;});
    response.on('end',()=>resolve({ status:response.statusCode, body:JSON.parse(text), headers:response.headers }));
  });
  request.on('error',reject); request.setTimeout(4000,()=>request.destroy(new Error('local_test_timeout')));
});

async function workerRegressions(db, expected) {
  const root=mkdtempSync(join(tmpdir(),'machina-ecosystem-performance-')),path=join(root,'fixture.sqlite');
  let stored,reader,model,server,busyReader;
  try {
    await backup(db,path); stored=new DatabaseSync(path);
    const schema=stored.prepare('SELECT type,name,sql FROM sqlite_master ORDER BY type,name').all();
    const dataVersion=stored.prepare('PRAGMA data_version').get().data_version;
    const checkpoint=stored.prepare('SELECT * FROM compact_checkpoint').get();
    reader=createEcosystemReader({path});
    for(const window of ['24h','7d','30d']) {
      const start=performance.now(),cold=await reader.read(window),coldMs=performance.now()-start;
      const warmStart=performance.now(),warm=await reader.read(window),warmMs=performance.now()-warmStart;
      assert.deepEqual(cold,expected.get(window)); assert.deepEqual(warm,cold);
      assert.ok(coldMs<3000,`${window} worker cold read ${coldMs.toFixed(1)}ms exceeds 3s fixture budget`);
      assert.ok(warmMs<250,`${window} commit-version cache is too slow`);
      console.log(JSON.stringify({test:'readonly_worker_and_cache',window,coldMs,warmMs,responseBytes:Buffer.byteLength(JSON.stringify(cold))}));
    }
    assert.deepEqual(stored.prepare('SELECT * FROM compact_checkpoint').get(),checkpoint);
    assert.deepEqual(stored.prepare('SELECT type,name,sql FROM sqlite_master ORDER BY type,name').all(),schema);
    assert.equal(stored.prepare('PRAGMA data_version').get().data_version,dataVersion,'worker performed no fixture database writes');
    // Only this local synthetic file is changed, to prove invalidation even when the checkpoint has not moved.
    stored.prepare("UPDATE compact_token_discoveries SET result_json=json_set(result_json,'$.symbol','CHANGED') WHERE candidate_key='fixture-0'").run();
    const changed=await reader.read('30d');
    assert.ok(changed.launches.rows.some(row=>row.symbol==='CHANGED'));
    assert.deepEqual(stored.prepare('SELECT * FROM compact_checkpoint').get(),checkpoint);
    console.log('PASS cache invalidates after another connection commits discovery evidence without checkpoint movement');
    await reader.close(); reader=null;

    model=createCompactReadModel({path,DatabaseSync}); model.summary('24h'); model.activity('all');
    let startedResolve; const started=new Promise(resolve=>{startedResolve=resolve;});
    busyReader=createEcosystemReader({path,workerFactory:(_,options)=>{
      const worker=new Worker(`const {parentPort,workerData}=require('node:worker_threads');
        parentPort.on('message',({window})=>{parentPort.postMessage({started:true});
          const until=Date.now()+1200; while(Date.now()<until){};
          parentPort.postMessage({window,value:workerData.value});});`,
        {...options,eval:true,workerData:{value:changed}});
      worker.on('message',message=>{if(message.started) startedResolve();}); return worker;
    }});
    server=createIntelligenceServer({readModel:{...model,ecosystem:window=>busyReader.read(window)}});
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    let ecosystemFinished=false;
    const ecosystem=localGet(server,'/v1/intelligence/ecosystem?window=30d').then(value=>{ecosystemFinished=true;return value;});
    await started;
    const start=performance.now();
    const peers=await Promise.all(['/health','/v1/intelligence/summary?window=24h','/v1/intelligence/activity?type=all'].map(path=>localGet(server,path)));
    const peerMs=performance.now()-start;
    assert.ok(peers.every(response=>response.status===200));
    assert.equal(ecosystemFinished,false,'Summary/Activity must complete while Ecosystem worker is still busy');
    assert.ok(peerMs<500,`unrelated HTTP reads blocked for ${peerMs.toFixed(1)}ms`);
    const result=await ecosystem; assert.equal(result.status,200); assert.deepEqual(result.body,JSON.parse(JSON.stringify(changed)));
    console.log(JSON.stringify({test:'http_isolation',simulatedEcosystemCpuMs:1200,concurrentHealthSummaryActivityMs:peerMs}));
  } finally {
    if(server) {server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
    await busyReader?.close(); await reader?.close(); model?.close(); stored?.close();
    rmSync(root,{recursive:true,force:true});
  }
}

async function queueRegressions() {
  const workers=[];let live=0,peak=0;
  const reader=createEcosystemReader({path:'/tmp/synthetic-never-opened.sqlite',timeoutMs:40,workerFactory:()=>{
    const worker=new EventEmitter(); workers.push(worker);live++;peak=Math.max(peak,live);
    worker.postMessage=({window})=>{if(workers.length>1) queueMicrotask(()=>worker.emit('message',{window,value:{window}}));};
    worker.terminate=async()=>{live--;};return worker;
  }});
  try {
    const first=reader.read('30d'); assert.strictEqual(reader.read('30d'),first);
    const queued=reader.read('24h');
    const failures=await Promise.allSettled([first,queued]);
    assert.ok(failures.every(row=>row.status==='rejected'&&row.reason.code==='ecosystem_read_timeout'));
    const next=reader.read('7d'); workers[0].emit('message',{window:'7d',value:'late obsolete response'});
    assert.deepEqual(await next,{window:'7d'});assert.equal(peak,1);
    await assert.rejects(reader.read('1h'),error=>error.code==='unsupported_window');
  } finally {await reader.close();}
  assert.equal(live,0);await assert.rejects(reader.read('24h'),error=>error.code==='ecosystem_reader_closed');
  console.log('PASS bounded window queue coalesces duplicates; timeout terminates worker, rejects queued work, ignores late replies and recovers');
}

async function main() {
  if(process.argv.length>2) throw new Error('no_arguments_fixture_only');
  console.log(JSON.stringify({ fixture: FIXTURE_SIZE, node: process.version }));
  const db = createPerformanceFixture(),expected=new Map();
  try {
    for (const window of ['24h', '7d', '30d']) {
      const { value, ...measurement } = profileRead(db, readEcosystem, window);
      assert.equal(value.schema, 'machina.intelligence.ecosystem.v1');
      assert.ok(Buffer.byteLength(JSON.stringify(value)) <= 240 * 1024);
      assert.ok(value.launches.rows.length > 0 && value.launches.rows.length <= 50);
      assert.ok(measurement.ms<3000,`${window}: Ecosystem fixture exceeded 3s budget`);
      assert.ok(measurement.queryCount<=25,`${window}: per-token/pool query amplification returned`);
      expected.set(window,value);
      console.log(JSON.stringify({ window, ...measurement, responseBytes: Buffer.byteLength(JSON.stringify(value)),
        responseSha256: createHash('sha256').update(JSON.stringify(value)).digest('hex'), launchRows: value.launches.rows.length }));
    }
    await workerRegressions(db,expected);
    await queueRegressions();
    console.log('VERIFIER PASS ecosystem-performance 9 scenarios (three query profiles, three read-only worker/cache windows, invalidation, HTTP isolation, queue recovery)');
  } finally { db.close(); }
}
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) await main();
