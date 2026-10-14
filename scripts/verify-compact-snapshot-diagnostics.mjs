// Error-visibility tests only: fake child failures, a real stderr replay and one tiny disposable SQLite fixture.
// No RPC, production files, collector, recovery, benchmarks or changes to execution budgets.
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { spawn } from 'node:child_process';
import { promises as fs, createReadStream, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { safeSnapshotError, safeExitCode, safeExitSignal, createSnapshotFatalScanner, FATAL_TAIL_BYTES } from '../server/compact/snapshot-diagnostics.js';
import { createSnapshotRunner, createDashboardSnapshotStore, SNAPSHOT_STAGE_TIMEOUT_MS } from '../server/compact/dashboard-snapshot.js';
import { ECOSYSTEM_READ_TIMEOUT_MS, ECOSYSTEM_RESPONSE_TIMEOUT_MS, READ_WORKER_RESOURCE_LIMITS } from '../server/compact/ecosystem-reader.js';
import { createCompactStore } from '../server/compact/store.js';
import { createCompactReadModel, ReadModelError } from '../server/compact/read-model.js';
import { COMPACT_DEFINITION_VERSION } from '../server/compact/sources.js';
import { FAMILY_FIELDS } from '../server/compact/families.js';

globalThis.fetch=async()=>{throw Error('network_forbidden');};
const secret='PRIVATE_KEY_environment_SQL_contents';
const cp={hourStart:Date.parse('2026-09-16T12:00:00Z')/1000,lastBlock:100,lastHash:'0x'+'a'.repeat(64),dataVersion:2};
const model={snapshotIdentity:()=>cp},store={compatibility:'diagnostic-test'};
let passed=0;
async function test(name,work){await work();passed++;console.log('PASS '+name);}
async function waitLogged(promise){let timer;try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('missing_sanitized_failure_log')),2000);})]);}finally{clearTimeout(timer);}}
function context(spawnImpl,extra={}){
  const logs=[];let logged;
  const failureLogged=new Promise(resolve=>{logged=resolve;});
  const runner=createSnapshotRunner({path:'/workspace/never-opened-diagnostics.sqlite',store,readModel:model,
    ...extra,spawnImpl,log:line=>{logs.push(line);if(line.startsWith('SNAPSHOT_FAILED'))logged();}});
  return {runner,logs,failureLogged};
}
class FakeChild extends EventEmitter {
  pid=123;
  stderr=new PassThrough();
  constructor(onV3){super();this.onV3=onV3;}
  send(message){queueMicrotask(()=>message.stage==='v3'?this.onV3(this):this.emit('message',{stage:message.stage}));}
  kill(){this.stderr.end();queueMicrotask(()=>this.emit('exit',null,'SIGKILL'));}
  disconnect(){this.stderr.end();queueMicrotask(()=>this.emit('exit',0,null));}
}
function checkLog(logs){
  assert.equal(logs.length,1,'one bounded diagnostic per failed attempt');assert.ok(logs[0].length<512);
  assert.ok(!logs[0].includes(secret));assert.ok(!logs[0].includes('SELECT '));assert.ok(!logs[0].includes('/private/'));
}

await test('caught read-model and packed evidence codes retain safe detail',()=>{
  assert.deepEqual(safeSnapshotError(new ReadModelError('inconsistent_state','pool_registry_metadata_malformed')),
    {code:'inconsistent_state',detail:'pool_registry_metadata_malformed'});
  assert.deepEqual(safeSnapshotError({code:'packed_payload_corrupt',stack:secret}),{code:'packed_payload_corrupt'});
  assert.deepEqual(safeSnapshotError(new ReadModelError('read_failed','ERR_SQLITE_ERROR')),{code:'read_failed',detail:'ERR_SQLITE_ERROR'});
});
await test('native SQLite, storage and bounded RangeError causes are distinguishable',()=>{
  assert.deepEqual(safeSnapshotError({code:'ERR_SQLITE_ERROR',errcode:5,message:'SELECT '+secret}),{code:'ERR_SQLITE_ERROR',detail:'SQLITE_BUSY'});
  assert.deepEqual(safeSnapshotError({code:'ENOSPC',path:'/private/'+secret}),{code:'snapshot_disk_budget',detail:'ENOSPC'});
  assert.deepEqual(safeSnapshotError(new RangeError('Map maximum size exceeded')),{code:'snapshot_range_error',detail:'map_size_limit'});
  assert.deepEqual(safeSnapshotError(new Error('snapshot_inputs_changed')),{code:'snapshot_inputs_changed'});
});
await test('unknown codes, messages, stacks and private detail never cross the whitelist',()=>{
  for(const code of [secret,'a'.repeat(64),'read_failed\n'+secret]){
    assert.deepEqual(safeSnapshotError({code,detail:secret,message:secret,stack:secret,cause:{code:secret}}),{code:'snapshot_prepare_failed'});
  }
  assert.deepEqual(safeSnapshotError({code:'read_failed',detail:'pool_registry_missing SELECT '+secret}),{code:'read_failed'});
  assert.equal(safeExitCode(secret),null);assert.equal(safeExitSignal('SIGABRT\n'+secret),'unknown');
  assert.equal(safeExitCode(23),23);assert.equal(safeExitSignal('SIGABRT'),'SIGABRT');
});
await test('V8 markers survive split chunks; retained stderr is at most 256 bytes',()=>{
  const scanner=createSnapshotFatalScanner();scanner.write(Buffer.from((secret+'\n').repeat(20000)));
  assert.ok(scanner.retainedBytes()<=FATAL_TAIL_BYTES);assert.equal(scanner.marker(),'none');
  scanner.write('\nFATAL ERROR: Ineffective mark-compacts near heap limit Allocation failed - JavaScript heap out of mem');
  scanner.write('ory\n'+secret);assert.equal(scanner.marker(),'v8_heap_oom');assert.equal(scanner.retainedBytes(),0);
  const other=createSnapshotFatalScanner();other.write('FATAL ERROR: Allocation failed - process out of memory\n');assert.equal(other.marker(),'v8_process_oom');
  const fatal=createSnapshotFatalScanner();fatal.write('FATAL ERROR: other engine assertion\n');assert.equal(fatal.marker(),'v8_fatal');
});
await test('parent preserves caught code/detail and identifies its own termination',async()=>{
  const ctx=context(()=>new FakeChild(c=>c.emit('message',{stage:'v3',error:'inconsistent_state',detail:'packed_rows_corrupt'})));
  assert.equal((await ctx.runner.run().done).error,'inconsistent_state');await waitLogged(ctx.failureLogged);checkLog(ctx.logs);
  assert.match(ctx.logs[0],/code=inconsistent_state stage=v3 detail=packed_rows_corrupt exit=null signal=SIGKILL/);
  assert.match(ctx.logs[0],/fatalMarker=none termination=parent_requested/);
});
await test('parent sanitizes forged child diagnostics independently',async()=>{
  const ctx=context(()=>new FakeChild(c=>c.emit('message',{stage:'v3',error:secret,detail:secret,stack:secret})));
  assert.equal((await ctx.runner.run().done).error,'snapshot_prepare_failed');await waitLogged(ctx.failureLogged);checkLog(ctx.logs);
  assert.match(ctx.logs[0],/detail=unknown/);
});
await test('unexpected V8 abort retains stage, signal and heap-oom marker without raw stderr',async()=>{
  const ctx=context(()=>new FakeChild(c=>{
    c.stderr.write(secret+'\nFATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory\n'+secret);
    c.stderr.end();c.emit('exit',null,'SIGABRT');
  }));
  assert.equal((await ctx.runner.run().done).exitCode,1);await waitLogged(ctx.failureLogged);checkLog(ctx.logs);
  assert.match(ctx.logs[0],/stage=v3.*exit=null signal=SIGABRT fatalMarker=v8_heap_oom termination=none/);
});
await test('SIGKILL with no V8 marker is reported without assuming OOM',async()=>{
  const ctx=context(()=>new FakeChild(c=>{c.stderr.end();c.emit('exit',null,'SIGKILL');}));
  await ctx.runner.run().done;await waitLogged(ctx.failureLogged);checkLog(ctx.logs);
  assert.match(ctx.logs[0],/signal=SIGKILL fatalMarker=none termination=none/);
});
await test('stderr finishing after exit affects diagnostics only; execution completes without waiting',async()=>{
  let child;
  const ctx=context(()=>child=new FakeChild(c=>c.emit('exit',17,null)));
  assert.equal((await ctx.runner.run().done).exitCode,1);assert.equal(ctx.logs.length,0);
  child.stderr.end('FATAL ERROR: a generic V8 fatal failure\n'+secret);await waitLogged(ctx.failureLogged);checkLog(ctx.logs);
  assert.match(ctx.logs[0],/stage=v3.*exit=17 signal=none fatalMarker=v8_fatal/);
});
await test('spawn failure logs only a safe OS code once',async()=>{
  const ctx=context(()=>{
    const c=new FakeChild(()=>{});c.pid=undefined;
    c.send=()=>queueMicrotask(()=>{c.emit('error',Object.assign(new Error('/private/'+secret),{code:'ENOENT'}));c.stderr.end();});return c;
  });
  assert.equal((await ctx.runner.run().done).error,'snapshot_child_failed');await waitLogged(ctx.failureLogged);checkLog(ctx.logs);
  assert.match(ctx.logs[0],/stage=begin detail=ENOENT exit=null signal=none/);
});
await test('real child stderr pipe replays a fatal signature without emitting its raw payload',async()=>{
  const replay="process.on('message',m=>{if(m.stage==='v3'){process.stderr.write('PRIVATE_KEY_environment_SQL_contents\\nFATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory\\n',()=>process.exit(23));}else process.send({stage:m.stage});});";
  const ctx=context((exec,args,options)=>spawn(exec,[...args.slice(0,2),'-e',replay],options));
  assert.equal((await ctx.runner.run().done).error,'snapshot_prepare_failed');await waitLogged(ctx.failureLogged);checkLog(ctx.logs);
  assert.match(ctx.logs[0],/stage=v3.*exit=23 signal=none fatalMarker=v8_heap_oom/);
});
await test('actual preparation child exposes a read-model detail; disposable canonical file stays unchanged',async()=>{
  const directory=await fs.mkdtemp('/workspace/machina-snapshot-diagnostic-'),path=join(directory,'fixture.sqlite');
  const db=new DatabaseSync(path),writer=createCompactStore(db,{packedShards:{config:{enabled:false},log:()=>{}}});
  const pool='0x'+'b'.repeat(40),hash='0x'+'a'.repeat(64);
  writer.commitHour({definitionVersion:COMPACT_DEFINITION_VERSION,chainId:5042,sourceVersions:{},complete:false,
    range:{kind:'hour',hourStart:cp.hourStart,hourEnd:cp.hourStart+3600,firstBlock:100,lastBlock:100,parentHash:hash,firstHash:hash,lastHash:hash},
    network:{status:'available',blockCount:1,transactionCount:0,uniqueActiveAddresses:0,gasUsedRaw:'0'},activeAddresses:[],
    families:Object.fromEntries(Object.entries(FAMILY_FIELDS).map(([name,fields])=>[name,{status:'unavailable',reason:'diagnostic_fixture',...Object.fromEntries(fields.map(f=>[f,null]))}])),registry:{uniswapV3:null}});
  db.prepare('INSERT INTO compact_registry VALUES(?,?,?,?,?,?)').run('uniswap_v3_pool',pool,90,0,hash,'{');
  db.prepare('INSERT INTO compact_registry_coverage VALUES(?,?,?,?)').run('uniswap_v3_pool',0,100,hash);
  db.prepare('INSERT INTO compact_projection_hours VALUES(?,?,?,?,?,?)').run(cp.hourStart,'uniswap_v3_pools','available',null,1,hash);
  db.prepare('INSERT INTO compact_pool_hours VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(cp.hourStart,'uniswap_v3',pool,1,'1','0','1','0',0,0,0,'0','0','0','0');
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)');db.close();
  const sha=async()=>{const hash=createHash('sha256');for await(const chunk of createReadStream(path))hash.update(chunk);return hash.digest('hex');};
  const original=await sha(),readModel=createCompactReadModel({path,DatabaseSync});
  try{
    const snapshotStore=createDashboardSnapshotStore({path,verifyCheckpoint:c=>readModel.snapshotCheckpointMatches(c)});
    const ctx=context(spawn,{path,store:snapshotStore,readModel});
    assert.equal((await ctx.runner.run().done).error,'inconsistent_state');await waitLogged(ctx.failureLogged);checkLog(ctx.logs);
    assert.match(ctx.logs[0],/code=inconsistent_state stage=v3 detail=pool_registry_metadata_malformed/);
    assert.equal(await sha(),original);await assert.rejects(fs.stat(snapshotStore.activePath),e=>e.code==='ENOENT');
  }finally{readModel.close();await fs.rm(directory,{recursive:true,force:true});}
});
await test('all execution budgets and child heap configuration remain unchanged',()=>{
  assert.equal(SNAPSHOT_STAGE_TIMEOUT_MS,30000);assert.equal(ECOSYSTEM_READ_TIMEOUT_MS,6000);assert.equal(ECOSYSTEM_RESPONSE_TIMEOUT_MS,7000);
  assert.deepEqual(READ_WORKER_RESOURCE_LIMITS,{maxOldGenerationSizeMb:48,maxYoungGenerationSizeMb:4});
  assert.match(readFileSync(new URL('../api/_lib/intelligence-proxy.js',import.meta.url),'utf8'),/const REQUEST_TIMEOUT_MS = 8_000\b/);
});
console.log(`VERIFIER PASS compact-snapshot-diagnostics ${passed} cases`);
