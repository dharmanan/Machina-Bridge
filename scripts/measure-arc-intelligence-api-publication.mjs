// Reuse independently verified real-hour lab evidence through the actual backend, proxy, parsers and React screen.
// No production connections, RPC requests, backups or changes to existing evidence files.
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { execFileSync, spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { resolve, dirname } from 'node:path';
import { openPipeline, hash, json, readDefinition, assertHeapBudget } from '../server/intelligence-pipeline/storage.js';
import { verifyNetworkSeal } from '../server/intelligence-pipeline/network-hour-store.js';
import { verifyDexSeal, readDexSealSummaries } from '../server/intelligence-pipeline/dex-hour-store.js';
import { createPipelineApiPublication } from '../server/intelligence-pipeline/api-publication.js';
import { createDiscoveryPublication } from '../server/intelligence-pipeline/discovery-publication.js';
import { MAX_RESPONSE_BYTES } from '../server/compact/http.js';
import { handleIntelligenceProxy } from '../api/_lib/intelligence-proxy.js';
import { protocolSource } from '../server/intelligence-pipeline/protocol-source.js';
import { FAMILY_WINDOWS } from '../server/compact/families.js';
import { sumWindow } from '../server/compact/windows.js';
import { sha256Of } from '../server/compact/projections.js';
import { FAMILY_VERSIONS } from '../server/compact/sources.js';

const [networkPath, protocolPath, dexPath, reportPath, uiV3Path, uiV4Path, existingLab, borrowEvidencePath, poolWitnessPath, tokenDiscoveryPath] = process.argv.slice(2);
if (![networkPath, protocolPath, dexPath, reportPath].every(p => p?.startsWith('/tmp/'))) throw Error('isolated_tmp_paths_required');
if(existingLab&&!existingLab.startsWith('/tmp/arc-api-real-'))throw Error('isolated_existing_lab_required');
const directory = existingLab ?? mkdtempSync(join(tmpdir(), 'arc-api-real-')), require = createRequire(import.meta.url);
const heapBudget = assertHeapBudget(), snapshots = [];
function readOnlyPipeline(path, { verifySeal, readSealSummaries } = {}) {
  const before = hash(readFileSync(path));
  const source = openPipeline({ path, readOnly: true, verifySeal, readSealSummaries });
  source.db.exec('BEGIN'); snapshots.push({ p: source, path, before }); return source;
}
const network = readOnlyPipeline(networkPath, { verifySeal: verifyNetworkSeal });
const protocols = readOnlyPipeline(protocolPath);
const dex = readOnlyPipeline(dexPath, { verifySeal: verifyDexSeal, readSealSummaries: readDexSealSummaries });
const target = openPipeline({ path: join(directory, 'api.sqlite'), create: !existingLab, knownOtherBytes: 1981427712, volumeLimitBytes: 4838498304 });
const api = createPipelineApiPublication(target, { onProgress: item => console.error(JSON.stringify(item)) });
const find = (p, id) => [...p.db.prepare('SELECT unit_id,unit_json FROM arc_pipeline_units').iterate()]
  .filter(u => JSON.parse(readDefinition(u.unit_json)).source.id === id);
const nu = find(network, 'network'); assert.equal(nu.length, 1);
const entries = Object.fromEntries(['usdc', 'assets', 'cctp', 'gateway', 'across', 'aaveV4', 'morphoBlue', 'morphoVaultsV2'].map(name => {
  const u = find(protocols, protocolSource(name).id); assert.equal(u.length, 1); return [name, { pipeline: protocols, unitId: u[0].unit_id }];
}));
const de = Object.fromEntries([['uniswapV3', 'uniswap_v3_family'], ['uniswapV4', 'uniswap_v4_family']].map(([name, id]) => {
  const u = find(dex, id); assert.equal(u.length, 1); return [name, { pipeline: dex, unitId: u[0].unit_id }];
}));
const projectionInputs={};
for(const [name,path]of[['uniswapV3',uiV3Path],['uniswapV4',uiV4Path]])if(path){
  if(!path.startsWith('/tmp/arc-dex-ui-real-'))throw Error('isolated_projection_path_required');
  const pipeline=readOnlyPipeline(path), units=pipeline.db.prepare('SELECT unit_id FROM arc_pipeline_units').all();assert.equal(units.length,1);
  projectionInputs[name]={pipeline,unitId:units[0].unit_id};
}
const args = { network: { pipeline: network, unitId: nu[0].unit_id }, protocols: entries, dex: de, projectionInputs };
const started = performance.now(), publication = api.publish(args), initialAudit = api.audit(publication.hour);
console.error(JSON.stringify({ stage: 'audit:end', heapUsed: process.memoryUsage().heapUsed }));
assert.equal(initialAudit.ok, true); assert.equal(publication.availableFamilies.length, 10);
let poolWitnessPublication=null;
if(poolWitnessPath){
  if(!poolWitnessPath.startsWith('/tmp/arc-pool-witness-real-'))throw Error('isolated_pool_witness_path_required');
  const source=readOnlyPipeline(poolWitnessPath);
  const checkpointBefore=json(target.db.prepare('SELECT * FROM compact_checkpoint').all());
  const canonicalBefore=json(target.db.prepare('SELECT * FROM compact_hours').all());
  const coverageBefore=json(target.db.prepare('SELECT * FROM compact_registry_coverage ORDER BY kind').all());
  poolWitnessPublication=api.publishPoolWitnesses(source);
  assert.equal(api.publishPoolWitnesses(source).inserted,0);
  assert.equal(json(target.db.prepare('SELECT * FROM compact_checkpoint').all()),checkpointBefore);
  assert.equal(json(target.db.prepare('SELECT * FROM compact_hours').all()),canonicalBefore);
  assert.equal(json(target.db.prepare('SELECT * FROM compact_registry_coverage ORDER BY kind').all()),coverageBefore);
}
const canonical = network.getSeal(nu[0].unit_id).summary;
let tokenDiscoveryPublication=null,tokenCacheRepair=null;
if(tokenDiscoveryPath){
  if(!tokenDiscoveryPath.startsWith('/tmp/arc-token-real-'))throw Error('isolated_token_discovery_path_required');
  const source=readOnlyPipeline(tokenDiscoveryPath),units=find(source,'creation_token_views');assert.equal(units.length,1);
  const adapter=createDiscoveryPublication(target),checkpointBefore=json(target.db.prepare('SELECT * FROM compact_checkpoint').all());
  tokenDiscoveryPublication=adapter.publish(source,units[0].unit_id);
  assert.equal(adapter.publish(source,units[0].unit_id).outcome,'unchanged');
  const before=target.db.prepare('SELECT * FROM compact_token_discoveries ORDER BY candidate_key LIMIT 1').get();assert(before);
  target.db.prepare('DELETE FROM compact_token_discoveries WHERE candidate_key=?').run(before.candidate_key);
  assert.throws(()=>adapter.audit(),/discovery_api_cache_integrity_failed/);
  tokenCacheRepair=adapter.reconcile(()=>({pipeline:source,unitId:units[0].unit_id}));assert.equal(tokenCacheRepair.results[0].status,'repaired');
  assert.deepEqual(target.db.prepare('SELECT * FROM compact_token_discoveries WHERE candidate_key=?').get(before.candidate_key),before);
  assert.equal(json(target.db.prepare('SELECT * FROM compact_checkpoint').all()),checkpointBefore);
}
const expected = Object.fromEntries(target.db.prepare("SELECT family,metrics_json FROM compact_family_hours WHERE status='available'").all().map(r => [r.family, JSON.parse(r.metrics_json)]));
const referencePath = '/tmp/machina-recovery-proof/real-hour.sqlite';
const reference = new DatabaseSync(referencePath, { readOnly: true }); reference.exec('PRAGMA query_only=ON; PRAGMA cache_size=-2048');
const referenceHour = reference.prepare('SELECT * FROM compact_hours WHERE hour_start=?').get(publication.hour);
assert.equal(referenceHour.network_sha256, canonical.canonicalSha256);
const canonicalComparisons = [];
for (const [name, metrics] of Object.entries(expected)) {
  const row = reference.prepare('SELECT * FROM compact_family_hours WHERE hour_start=? AND family=?').get(publication.hour, name);
  assert.equal(reference.prepare('SELECT value FROM compact_meta WHERE key=?').get('family_version:' + name).value, FAMILY_VERSIONS[name]);
  assert.equal(hash(row.metrics_json), row.metrics_sha256);
  const comparable = value => name === 'assets' ? { ...value, items: [...value.items].sort((a, b) => a.address.localeCompare(b.address)) } : value;
  assert.equal(sha256Of(comparable(metrics)), sha256Of(comparable(JSON.parse(row.metrics_json))), name);
  canonicalComparisons.push({ family: name, definition: FAMILY_VERSIONS[name], metricsMatchExport: true });
}
reference.close();
const broken = target.db.prepare("SELECT * FROM compact_family_hours WHERE family='gateway'").get();
target.db.prepare("DELETE FROM compact_family_hours WHERE family='gateway'").run();
assert.equal(api.audit(publication.hour).ok, false);
const repair = api.reconcile(hour => { assert.equal(hour, publication.hour); return args; }, { maxHours: 1 });
assert.equal(repair.results[0].status, 'repaired', json(repair)); assert.equal(api.audit(publication.hour).ok, true);
assert.deepEqual(target.db.prepare("SELECT * FROM compact_family_hours WHERE family='gateway'").get(), broken);
assert.equal(api.publish(args).outcome, 'unchanged');
// Production API and browser execution do not share a V8 heap. Bound both test workers separately,
// rather than measuring an artificial combined API + React/SSR heap as the indexing worker's budget.
const apiWorker=spawn(process.execPath,['--max-old-space-size=48','--max-semi-space-size=2',
 'scripts/serve-arc-intelligence-api-lab.mjs',target.path,String((publication.hour+3600)*1000)],{cwd:process.cwd(),stdio:['pipe','pipe','pipe']});
const apiLines=[];const apiReader=createInterface({input:apiWorker.stdout});let apiWorkerMeasurement;
const apiExit=new Promise(resolve=>apiWorker.once('exit',(code,signal)=>resolve({code,signal})));
apiWorker.stderr.on('data',chunk=>process.stderr.write(chunk));
const origin=await new Promise((resolve,reject)=>{
 const timer=setTimeout(()=>reject(Error('api_worker_start_timeout')),10000);timer.unref();
 apiReader.on('line',line=>{const r=JSON.parse(line);apiLines.push(r);if(r.origin){clearTimeout(timer);resolve(r.origin);}else apiWorkerMeasurement=r;});
 apiWorker.once('error',reject);apiWorker.once('exit',code=>{if(!apiLines.length){clearTimeout(timer);reject(Error('api_worker_failed:'+code));}});
});
const files = ['src/components/ArcIntelligenceOverview.tsx', 'src/lib/arcIntelligence.ts',
  'src/config/mainnetBorrow.ts', 'src/config/arcIntelligenceUiScope.ts'];
// Development compilation runs separately; neither the collection nor API worker loads the TypeScript compiler.
execFileSync(process.execPath, ['--input-type=module', '-e', `
  import ts from 'typescript'; import {readFileSync,writeFileSync} from 'node:fs'; import {join} from 'node:path';
  const [dir, ...files] = process.argv.slice(1);
  for (let i=0;i<files.length;i++) writeFileSync(join(dir,'compiled-'+i+'.cjs'),ts.transpileModule(readFileSync(files[i],'utf8'),
    {compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true,jsx:ts.JsxEmit.ReactJSX},fileName:files[i]}).outputText);
`, directory, ...files], { cwd: process.cwd(), stdio: 'pipe' });
const Module = require('node:module');
const compiled = new Map(files.map((file, i) => [resolve(file).replace(/\.tsx?$/, ''), join(directory, 'compiled-' + i + '.cjs')])), cache = new Map();
function load(key) {
  if (cache.has(key)) return cache.get(key).exports;
  assert(compiled.has(key), 'Unexpected frontend dependency: ' + key);
  const m = new Module(key); m.filename = key; cache.set(key, m);
  m.require = id => id.startsWith('.') ? load(resolve(dirname(key), id)) : require(id);
  m._compile(readFileSync(compiled.get(key), 'utf8'), key); return m.exports;
}
const client = load(resolve(files[1]).replace(/\.ts$/, '')), screen = load(resolve(files[0]).replace(/\.tsx$/, '')),
  React = require('react'), { renderToStaticMarkup } = require('react-dom/server');
let borrowMarket={status:'unavailable'},borrowEvidence=null;
if(borrowEvidencePath){
  if(!borrowEvidencePath.startsWith('/tmp/'))throw Error('isolated_borrow_evidence_required');
  const r=JSON.parse(readFileSync(borrowEvidencePath));const body=JSON.stringify(r.response);
  const {BORROW_MARKETS_UPSTREAM_URL,handleBorrowMarketsProxy}=await import('../api/_lib/borrow-markets-proxy.js');
  assert.equal(r.endpoint,BORROW_MARKETS_UPSTREAM_URL);assert.equal(r.httpStatus,200);assert.equal(r.requests,1);
  assert.equal(Buffer.byteLength(body),r.responseBytes);assert.equal(hash(body),r.responseSha256);
  let reply,requests=0;
  await handleBorrowMarketsProxy({method:'GET',send:r=>{reply=r;},fetchImpl:async(url)=>{
    assert.equal(url,r.endpoint);requests++;return{status:200,text:async()=>body};
  }});
  assert.equal(requests,1);assert.equal(reply.status,200);
  borrowMarket=await client.loadArcBorrowMarkets({fetchImpl:async()=>({ok:true,status:200,json:async()=>JSON.parse(reply.body)})});
  assert.equal(borrowMarket.status,'available');assert.equal(borrowMarket.markets.length,2);
  borrowEvidence={capturedAt:r.checkedAt,responseSha256:r.responseSha256,responseBytes:r.responseBytes,
    source:'Owner-provided real Codespaces HTTP capture; exact-byte replay through unchanged proxy/parser',
    compatibleMarketCount:borrowMarket.markets.length,liveRequestInThisTest:false,writesEnabled:false,mainnetTransactionVerified:false};
}
const scope = JSON.parse(readFileSync('docs/arc-intelligence-pipeline/product-scope.json', 'utf8'));
assert.equal(scope.fields.length, 84);
assert.equal(hash(scope.fields), '644a73006433b128e79697d7346e43e2f9cc138147c5a52c740891e9caab9170');
const responses = [], windowResults = [], responsiveFixtures = [];
let sampledHeapHighWater = process.memoryUsage().heapUsed;
const sampleHeap = () => { sampledHeapHighWater = Math.max(sampledHeapHighWater, process.memoryUsage().heapUsed); assertHeapBudget(); };
async function localProxy(url, options = {}) {
  const query = Object.fromEntries(new URL(url, 'http://localhost').searchParams);
  const start = performance.now(); let reply;
  await handleIntelligenceProxy({ method: 'GET', query, headers: {}, env: { INTELLIGENCE_API_URL: origin },
    fetchImpl: (url, settings) => { assert.equal(new URL(url).origin, origin); return fetch(url, settings); }, send: r => { reply = r; } });
  const bytes = Buffer.byteLength(reply.body); assert(bytes <= MAX_RESPONSE_BYTES);
  responses.push({ request: url, status: reply.status, bytes, durationMs: Math.round((performance.now() - start) * 100) / 100 });
  sampleHeap();
  return { ok: reply.status===200, status: reply.status, json: async () => JSON.parse(reply.body), text: async () => reply.body,
    headers: new Headers(reply.headers) };
}
try {
  for (const window of ['24h', '7d', '30d']) {
    const data = await client.loadArcIntelligence(window, { fetchImpl: localProxy });
    assert.equal(data.failed, false);
    const s = data.summary;
    if (window === '30d') {
      assert.equal(s.network.transactions, canonical.network.transactionCount);
      assert.equal(s.network.blocks, canonical.network.blockCount);
      assert.equal(s.window.coverage.availableHours, 1);
      // Window contracts deliberately omit hourly distinct counts; they must never be summed as window uniques.
      const checked = (name, actual) => {
        const withoutUnits = v => Array.isArray(v) ? v.map(withoutUnits) : v && typeof v === 'object'
          ? Object.fromEntries(Object.entries(v).filter(([key]) => key !== 'units').map(([key, value]) => [key, withoutUnits(value)])) : v;
        const calculated = sumWindow(FAMILY_WINDOWS[name], [expected[name]]), values = withoutUnits(actual);
        assert.equal(sha256Of(values), sha256Of(calculated), name);
      };
      for (const name of ['cctp', 'gateway', 'across']) checked(name, s.crossChain[name].metrics);
      for (const name of ['aaveV4', 'morphoBlue', 'morphoVaultsV2']) checked(name, s.lending[name].metrics);
      assert.equal(s.dex.uniswapV3.metrics.swapCount, expected.uniswapV3.swapCount);
      assert.equal(s.dex.uniswapV4.metrics.swapCount, expected.uniswapV4.swapCount);
    } else { assert.equal(s.network.transactions, null); assert.equal(s.network.reason, 'insufficient_coverage'); }
    const html = renderToStaticMarkup(React.createElement(screen.ArcIntelligenceDashboard, { selectedWindow: window, data,
      borrowMarket, explorerUrl: 'https://arcscan.app' }));
    const statuses = new Map();
    for (const tag of html.matchAll(/<[^>]*data-intel-item="([^"]+)"[^>]*>/g)) {
      const status = /data-intel-status="([^"]+)"/.exec(tag[0])?.[1];
      assert(status); if (statuses.has(tag[1])) assert.equal(statuses.get(tag[1]), status); statuses.set(tag[1], status);
    }
    const fields = scope.fields.map(f => { assert(statuses.has(f.id), f.id); return { id: f.id, label: f.label, status: statuses.get(f.id),
      realFullWindowVerified: false, realObservedDataRendered: statuses.get(f.id) === 'available' && !f.id.startsWith('window.') && f.id !== 'borrow.route',
      explanation: f.id.startsWith('window.') || f.id === 'borrow.route' ? 'Static window/route control; not proof of historical data or live Borrow market terms.'
        : statuses.get(f.id) === 'available' ? 'Real verified one-hour data rendered; full-window acceptance still missing.'
          : f.originalBackend === 'pending' ? 'Authoritative source/action qualification and API integration still required.'
            : 'Missing window history or source-specific projection/price/discovery evidence; never filled with zero.' }; });
    const counts = Object.fromEntries([...new Set(fields.map(f => f.status))].map(s => [s, fields.filter(f => f.status === s).length]));
    writeFileSync(join(directory, window + '.html'), html);
    writeFileSync(join(directory, window + '.json'), json(data));
    const usd = [...html.matchAll(/<dd\b([^>]*data-usd-action="([^"]+)"[^>]*)>([\s\S]*?)<\/dd>/g)].map(m => ({
      field: m[2], micros: /data-usd-micros="([^"]+)"/.exec(m[1])?.[1],
      // Compare browser textContent, not React's HTML entity representation of an exact value such as <$0.01.
      text: m[3].replace(/<[^>]*>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&') }));
    responsiveFixtures.push({ name: window, html, usd });
    sampleHeap();
    windowResults.push({ window, fields, counts, schemaErrors: data.readErrors, verifiedHours: s.coverage.storedHours,
      requiredHours: s.window.hours, completedUtcDays: s.window.coverage?.completedUtcDays ?? null });
  }
} finally {apiWorker.stdin.end('stop\n');const exit=await apiExit;apiReader.close();assert.equal(exit.code,0,'API worker must finish within its heap ceiling');}
target.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
const responsiveFixturePath = join(directory, 'responsive-fixtures.json'); writeFileSync(responsiveFixturePath, json(responsiveFixtures));
const report = { scope: 'Actual compact API + Vercel proxy + unchanged frontend parser + React SSR, real one-hour pipeline results',
  directory, responsiveFixturePath, hour: new Date(publication.hour * 1000).toISOString(), publication, initialAudit,
  readModelClock: { value: new Date((publication.hour + 3600) * 1000).toISOString(), historicalWindowAnchoring: true,
    limitation: 'Deliberate historical-window clock; not evidence of present-day freshness or real full-window coverage.' },
  canonicalComparisons, canonicalReferenceReadOnly: true,
  apiTablePages: target.db.prepare('SELECT name,SUM(pgsize) bytes FROM dbstat GROUP BY name ORDER BY bytes DESC').all(),
  measuredApiStorage: target.metrics(), sourceEvidenceStorageExcluded: [networkPath, protocolPath, dexPath],
  rpcRequests: 0, restartNoReDownload: true, missingGatewayCacheRepairExact: true, boundedAutomaticCacheReconciliation: repair,
  responseMeasurements: responses, windows: windowResults, heapBudget, sampledHeapHighWaterBytes: sampledHeapHighWater,
  borrowEvidence,poolWitnessPublication,tokenDiscoveryPublication,tokenCacheRepair,apiWorkerMeasurement,
  apiFailures:responses.filter(r=>r.status!==200),reusedIndependentLab:!!existingLab,
  heapMeasurement: 'Samples at request/render boundaries; hard V8 ceiling covers unsampled intervals. RSS and development compiler are separate.',
  durationMs: Math.round(performance.now() - started), acceptance: { full84Fields: false, real720Hours: false, production5GBProof: false },
  productionAccess: false, backupsCreated: false };
for (const item of snapshots) { item.p.db.exec('COMMIT'); item.p.close(); assert.equal(hash(readFileSync(item.path)), item.before, 'source evidence file unchanged'); }
target.close(); writeFileSync(reportPath, JSON.stringify(report, null, 2));
console.log(JSON.stringify({ reportPath, directory, families: publication.availableFamilies.length, windows: windowResults.map(w => ({ window: w.window, counts: w.counts })),
  responseCount: responses.length, maximumResponseBytes: Math.max(...responses.map(r => r.bytes)), sampledHeapHighWaterBytes: report.sampledHeapHighWaterBytes, durationMs: report.durationMs,
  accepted: report.acceptance }));
