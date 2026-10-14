// Small isolated SQLite acceptance cases only. No mainnet/RPC, collector, recovery or production files.
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createCompactStore } from '../server/compact/store.js';
import { COMPACT_DEFINITION_VERSION } from '../server/compact/sources.js';
import { FAMILY_FIELDS } from '../server/compact/families.js';
import { createCompactReadModel } from '../server/compact/read-model.js';
import { createDashboardSnapshotStore, createSnapshotRunner, SNAPSHOT_MAX_BYTES, SNAPSHOT_STAGE_TIMEOUT_MS } from '../server/compact/dashboard-snapshot.js';
import { ECOSYSTEM_READ_TIMEOUT_MS, ECOSYSTEM_RESPONSE_TIMEOUT_MS, READ_WORKER_RESOURCE_LIMITS } from '../server/compact/ecosystem-reader.js';
import { createScheduler } from '../server/compact/scheduler.js';
import { createIntelligenceServer } from '../server/compact/http.js';

const directory = await fs.mkdtemp('/workspace/machina-snapshot-test-'), path=join(directory,'fixture.sqlite');
const BASE=Date.parse('2026-09-16T00:00:00Z')/1000, HOUR=3600;
const hash=n=>'0x'+n.toString(16).padStart(64,'0'), address=n=>'0x'+n.toString(16).padStart(40,'0');
let clock=(BASE+4*HOUR+60)*1000, passed=0;
async function test(name,fn){await fn();passed++;console.log('PASS '+name);}
const writer=new DatabaseSync(path), store=createCompactStore(writer,{packedShards:{config:{enabled:false},log:()=>{}}});
function append(i){
  const hour=BASE+i*HOUR, block=100+i;
  store.commitHour({definitionVersion:COMPACT_DEFINITION_VERSION,chainId:5042,sourceVersions:{},complete:false,
    range:{kind:'hour',hourStart:hour,hourEnd:hour+HOUR,firstBlock:block,lastBlock:block,parentHash:hash(block-1),firstHash:hash(block),lastHash:hash(block)},
    network:{status:'available',blockCount:1,transactionCount:1,uniqueActiveAddresses:1,gasUsedRaw:'21000'},activeAddresses:[address(1)],
    families:Object.fromEntries(Object.entries(FAMILY_FIELDS).map(([name,fields])=>[name,{status:'unavailable',reason:'fixture',...Object.fromEntries(fields.map(f=>[f,null]))}])),registry:{uniswapV3:null}});
  for(const [protocol,kind,pool] of [['uniswap_v3','uniswap_v3_pool',address(2)],['uniswap_v4','uniswap_v4_pool',hash(3)]]){
    writer.prepare('INSERT INTO compact_pool_hours VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(hour,protocol,pool,i+1,'10000000000000000000001','2','3','4',1,2,0,
      ...(protocol==='uniswap_v3'?['5','6','7','8']:[null,null,null,null]));
    writer.prepare('INSERT INTO compact_projection_hours VALUES(?,?,?,?,?,?)').run(hour,protocol+'_pools','available',null,1,hash(i));
    const meta=protocol==='uniswap_v3'?{token0:address(4),token1:address(5),fee:500,tickSpacing:10}:{currency0:address(4),currency1:address(5),fee:3000,tickSpacing:60,hooks:address(0)};
    writer.prepare('INSERT OR IGNORE INTO compact_registry VALUES(?,?,?,?,?,?)').run(kind,pool,90,0,hash(90),JSON.stringify(meta));
    writer.prepare('INSERT INTO compact_registry_coverage VALUES(?,?,?,?) ON CONFLICT(kind) DO UPDATE SET through_block=excluded.through_block,through_hash=excluded.through_hash').run(kind,1,block,hash(block));
  }
}
for(let i=0;i<4;i++)append(i);
const model=createCompactReadModel({path,DatabaseSync,now:()=>clock});
const options={path,now:()=>clock,verifyCheckpoint:cp=>model.snapshotCheckpointMatches(cp)};
const snapshots=createDashboardSnapshotStore(options), runner=createSnapshotRunner({path,store:snapshots,readModel:model,now:()=>clock});
let original;
try {
 await test('background snapshot stage exceeds 6s safely; 30s cap, HTTP deadlines and heap limits stay separate',async()=>{
   assert.equal(SNAPSHOT_STAGE_TIMEOUT_MS,30000);
   assert.equal(ECOSYSTEM_READ_TIMEOUT_MS,6000);assert.equal(ECOSYSTEM_RESPONSE_TIMEOUT_MS,7000);
   assert.match(readFileSync(new URL('../api/_lib/intelligence-proxy.js',import.meta.url),'utf8'),/const REQUEST_TIMEOUT_MS = 8_000\b/);
   assert.deepEqual(READ_WORKER_RESOURCE_LIMITS,{maxOldGenerationSizeMb:48,maxYoungGenerationSizeMb:4});
   for(const timeoutMs of [0,30001])assert.throws(()=>createSnapshotRunner({path,store:snapshots,readModel:model,timeoutMs}),/invalid_snapshot_timeout/);
   let timer;
   class SlowPreparation extends EventEmitter {
     send(m){if(m.stage==='v3')timer=setTimeout(()=>this.emit('message',{stage:m.stage}),6100);
       else queueMicrotask(()=>this.emit('message',{stage:m.stage}));}
     disconnect(){queueMicrotask(()=>this.emit('exit',0));}
     kill(){clearTimeout(timer);queueMicrotask(()=>this.emit('exit',null));}
   }
   const slow=createSnapshotRunner({path,store:snapshots,readModel:model,spawnImpl:(_exec,args)=>{
     assert.deepEqual(args.slice(0,2),['--max-old-space-size=48','--max-semi-space-size=4']);return new SlowPreparation();
   }});
   const at=performance.now(),handle=slow.run();
   assert.throws(()=>slow.run(),/snapshot_already_running/);
   assert.equal((await handle.done).exitCode,0);
   const elapsedMs=performance.now()-at;assert.ok(elapsedMs>6000 && elapsedMs<30000);
   console.log(JSON.stringify({test:'simulated_background_stage_over_http_cap',elapsedMs,snapshotStageLimitMs:30000,httpActiveMs:6000,httpTotalMs:7000,proxyMs:8000}));
 });
 await test('no snapshot: explicit not_ready, no heavy fallback',async()=>assert.rejects(snapshots.read('v3',model.snapshotIdentity()),e=>e.code==='not_ready'));
 await test('all three real read-model outputs prepared and atomically activated',async()=>{
   assert.equal(await runner.needed(),true);assert.equal((await runner.run().done).exitCode,0);original=await snapshots.load();
   for(const section of ['v3','v4','ecosystem']){
     const direct=section==='ecosystem'?model.ecosystem('30d'):model.pools(section,'30d');
     const saved=JSON.parse(original.sections[section].json);delete direct.freshness;delete saved.freshness;assert.deepEqual(saved,JSON.parse(JSON.stringify(direct)));
   }
   assert.equal(JSON.parse(original.sections.v3.json).pools[0].swapCount,10);
   assert.equal(JSON.parse(original.sections.v4.json).pools[0].flowsRaw.token0In,'40000000000000000000004');
   assert.equal(await runner.needed(),false);
 });
 await test('ready snapshot quick reads: bounded body, explicit verified time',async()=>{
   const at=performance.now();for(let i=0;i<30;i++){const b=await snapshots.read('v3',model.snapshotIdentity());assert.equal(b.snapshot.status,'current');assert.equal(b.snapshot.verifiedThrough,new Date((BASE+4*HOUR)*1000).toISOString());}
   console.log(JSON.stringify({read30TotalMs:performance.now()-at,activeBytes:(await fs.stat(snapshots.activePath)).size,maxBytes:SNAPSHOT_MAX_BYTES}));
 });
 await test('restart uses same durable bundle without recomputation',async()=>{
   const restart=createDashboardSnapshotStore(options), r=createSnapshotRunner({path,store:restart,readModel:model,now:()=>clock});
   assert.equal(await r.needed(),false);assert.deepEqual(await restart.read('ecosystem',model.snapshotIdentity()),await snapshots.read('ecosystem',model.snapshotIdentity()));
 });
 await test('new hour: previous bundle retained with old timestamp and explicit lag',async()=>{
   append(4);clock+=HOUR*1000;assert.equal(await runner.needed(),true);
   const b=await snapshots.read('v4',model.snapshotIdentity());assert.equal(b.snapshot.status,'stale');assert.equal(b.snapshot.lagHours,1);
   assert.equal(b.freshness.stale,true);assert.equal(b.pools[0].swapCount,10);
 });
 await test('partial, mixed-checkpoint and changed window bundles cannot activate',async()=>{
   const cp=model.snapshotIdentity(),values={v3:model.pools('v3','30d'),v4:model.pools('v4','30d'),ecosystem:model.ecosystem('30d')};
   await assert.rejects(snapshots.publish(cp,{...values,ecosystem:undefined}));
   values.v4.freshness.checkpointBlock--;
   await assert.rejects(snapshots.publish(cp,values));assert.deepEqual(await snapshots.load(),original);
 });
 await test('failed prepare and bounded stage timeout preserve successful bundle; retries are bounded',async()=>{
   class FailingChild extends EventEmitter {send(m){queueMicrotask(()=>this.emit('message',{stage:m.stage,error:'forced'}));}kill(){queueMicrotask(()=>this.emit('exit',null));}}
   const bad=createSnapshotRunner({path,store:snapshots,readModel:model,now:()=>clock,spawnImpl:()=>new FailingChild()});
   // This runner starts with the older bundle, so the current hour genuinely needs a rebuild.
   assert.equal(await bad.needed(),true);assert.equal((await bad.run().done).exitCode,1);assert.equal(await bad.needed(),false);assert.deepEqual(await snapshots.load(),original);
   class StalledChild extends EventEmitter {send(){}kill(){queueMicrotask(()=>this.emit('exit',null));}}
   const stalled=createSnapshotRunner({path,store:snapshots,readModel:model,spawnImpl:()=>new StalledChild(),timeoutMs:20});
   assert.equal((await stalled.run().done).error,'snapshot_stage_timeout');assert.deepEqual(await snapshots.load(),original);
 });
 await test('IPC failure awaits actual child exit; late replies never activate',async()=>{
   let exited=false;
   class FailedIPC extends EventEmitter {
     pid=123;
     send(){queueMicrotask(()=>this.emit('error',Error('private_error_details')));}
     kill(){setTimeout(()=>{exited=true;this.emit('message',{stage:'end'});this.emit('exit',null);},10);}
   }
   const before=await snapshots.load(),transport=createSnapshotRunner({path,store:snapshots,readModel:model,spawnImpl:()=>new FailedIPC()});
   const handle=transport.run();let settled=false;handle.done.then(()=>{settled=true;});await Promise.resolve();assert.equal(settled,false);
   assert.equal((await handle.done).error,'snapshot_child_failed');assert.equal(exited,true);assert.deepEqual(await snapshots.load(),before);
 });
 await test('low disk leaves old file untouched',async()=>{
   const low=createDashboardSnapshotStore({...options,filesystem:{...fs,statfs:async()=>({bavail:0,bsize:4096})}});
   await assert.rejects(low.publish(model.snapshotIdentity(),{v3:model.pools('v3','30d'),v4:model.pools('v4','30d'),ecosystem:model.ecosystem('30d')}),e=>e.code==='snapshot_disk_budget');
   assert.deepEqual(await snapshots.load(),original);
 });
 await test('crash before atomic rename cannot replace active bundle',async()=>{
   const crash=createDashboardSnapshotStore({...options,filesystem:{...fs,rename:async()=>{throw Error('simulated_crash');}}});
   await assert.rejects(crash.publish(model.snapshotIdentity(),{v3:model.pools('v3','30d'),v4:model.pools('v4','30d'),ecosystem:model.ecosystem('30d')}));
   assert.deepEqual(await createDashboardSnapshotStore(options).load(),original);
 });
 await test('new hour refresh: all values and checkpoint advance together',async()=>{
   assert.equal((await runner.run().done).exitCode,0);const b=await snapshots.load();assert.equal(b.checkpoint.hourStart,BASE+4*HOUR);
   for(const s of ['v3','v4','ecosystem'])assert.equal((await snapshots.read(s,model.snapshotIdentity())).snapshot.lagHours,0);
   assert.equal((await snapshots.read('v3',model.snapshotIdentity())).pools[0].swapCount,15);
 });
 await test('pinned transaction: concurrent local commit cannot mix stages',async()=>{
   const isolated=createCompactReadModel({path,DatabaseSync,now:()=>clock}),cp=isolated.snapshotIdentity();isolated.beginPrepared30d(cp);
   const a=isolated.pools('v3','30d');append(5);clock+=HOUR*1000;
   const b=isolated.pools('v4','30d'),e=isolated.ecosystem('30d');isolated.endPrepared30d();isolated.close();
   assert.equal(a.window.end,b.window.end);assert.equal(b.window.end,e.window.end);assert.equal(a.pools[0].swapCount,15);
   assert.equal((await snapshots.read('v3',model.snapshotIdentity())).snapshot.lagHours,1);
 });
 await test('input changes between prepare and activation fail closed',async()=>{
   class ChangedChild extends EventEmitter { send(m){queueMicrotask(()=>{
     const value=m.stage==='ecosystem'?model.ecosystem('30d'):['v3','v4'].includes(m.stage)?model.pools(m.stage,'30d'):undefined;
     if(m.stage==='end')writer.prepare("INSERT INTO compact_meta(key,value) VALUES('snapshot_test_commit','changed')").run();
     this.emit('message',{stage:m.stage,value});
   });}disconnect(){queueMicrotask(()=>this.emit('exit',0));}kill(){queueMicrotask(()=>this.emit('exit',null));} }
   const cp=(await snapshots.load()).checkpoint;
   const changed=createSnapshotRunner({path,store:snapshots,readModel:model,spawnImpl:()=>new ChangedChild()});
   assert.equal((await changed.run().done).error,'snapshot_inputs_changed');assert.deepEqual((await snapshots.load()).checkpoint,cp);
 });
 await test('HTTP 30D serves only saved bundle; 24H/7D unchanged',async()=>{
   let heavy=0,exposed=snapshots;const httpModel={...model,pools:(p,w)=>w==='30d'?exposed.read(p,model.snapshotIdentity()):(heavy++,model.pools(p,w)),ecosystem:w=>w==='30d'?exposed.read('ecosystem',model.snapshotIdentity()):(heavy++,model.ecosystem(w))};
   const server=createIntelligenceServer({readModel:httpModel});await new Promise(r=>server.listen(0,'127.0.0.1',r));
   try{for(const route of ['pools?protocol=v3','pools?protocol=v4','ecosystem?']){
     const url=`http://127.0.0.1:${server.address().port}/v1/intelligence/${route}${route.endsWith('?')?'':'&'}window=30d`;
     const at=performance.now(),response=await fetch(url),body=await response.json();assert.equal(response.status,200);assert.equal(body.snapshot.status,'stale');
     console.log(JSON.stringify({route,totalMs:performance.now()-at}));
   }assert.equal(heavy,0);
   for(const w of ['24h','7d']){const r=await fetch(`http://127.0.0.1:${server.address().port}/v1/intelligence/pools?protocol=v3&window=${w}`);assert.equal(r.status,200);assert.equal((await r.json()).snapshot,undefined);}assert.equal(heavy,2);
   exposed=createDashboardSnapshotStore({...options,path:join(directory,'missing.sqlite')});
   const missing=await fetch(`http://127.0.0.1:${server.address().port}/v1/intelligence/ecosystem?window=30d`);assert.equal(missing.status,503);assert.deepEqual(await missing.json(),{error:'not_ready'});assert.equal(heavy,2);
   }finally{await new Promise(r=>server.close(r));}
 });
 await test('corrupt/incomplete/foreign-definition saved files rejected after restart',async()=>{
   const bytes=await fs.readFile(snapshots.activePath),previousPath=join(path+'.dashboard-30d','previous.json'),previous=await fs.readFile(previousPath),damaged=JSON.parse(bytes);damaged.sections.v3.json+=' ';
   try{for(const corrupt of [Buffer.from('{'),Buffer.from(JSON.stringify({...JSON.parse(bytes),sections:{}})),Buffer.from(JSON.stringify({...JSON.parse(bytes),compatibility:'other'})),Buffer.from(JSON.stringify(damaged))]){
     await fs.writeFile(snapshots.activePath,corrupt);const fallback=await createDashboardSnapshotStore(options).load();assert.deepEqual(fallback,JSON.parse(previous));
     await fs.writeFile(previousPath,'{');await assert.rejects(createDashboardSnapshotStore(options).load(),e=>e.code==='snapshot_invalid');await fs.writeFile(previousPath,previous);
   }}finally{await fs.writeFile(snapshots.activePath,bytes);await fs.writeFile(previousPath,previous);}
 });
 await test('canonical identity mismatch is not accepted even for an older bundle',async()=>{
   const rejecting=createDashboardSnapshotStore({...options,verifyCheckpoint:()=>false});
   await assert.rejects(rejecting.read('ecosystem',model.snapshotIdentity()),e=>e.code==='snapshot_checkpoint_mismatch');
 });
 await test('scheduler live priority, failure independent and no child overlap',async()=>{
   let cp=BASE+3*HOUR,work=0,need=true;const calls=[];
   const handle=(name,fn)=>{assert.equal(work,0);work++;calls.push(name);return{done:Promise.resolve().then(()=>{fn?.();work--;return{exitCode:name==='snapshot'?1:0,error:null};}),terminate:async()=>{}};};
   const scheduler=createScheduler({readModel:{checkpoint:()=>({hourStart:cp,lastBlock:100}),repairCandidates:()=>[]},
     runHour:hour=>({hour,...handle('collector',()=>{cp+=HOUR;})}),
     snapshotRunner:{needed:async()=>need,run:()=>handle('snapshot',()=>{need=false;})},
     runDiscoveryDrain:()=>handle('drain'),now:()=>(BASE+5*HOUR+60)*1000,safetyDelayMs:0,setTimer:()=>1,clearTimer:()=>{}});
   await scheduler.tick();await scheduler.stop();assert.deepEqual(calls,['collector','snapshot']);assert.equal(cp,BASE+4*HOUR);assert.equal(scheduler.status().consecutiveFailures,0);
 });
 await test('next live hour cancels preparation, waits for it and starts collector',async()=>{
   let cp=BASE+4*HOUR,liveClock=(cp+HOUR+60)*1000,pending=true,snapshotActive=false,finish;
   const calls=[];
   const scheduler=createScheduler({readModel:{checkpoint:()=>({hourStart:cp,lastBlock:100}),repairCandidates:()=>[]},
     runHour:hour=>{assert.equal(snapshotActive,false);calls.push('collector');cp+=HOUR;return{hour,done:Promise.resolve({exitCode:0,error:null}),terminate:async()=>{}};},
     snapshotRunner:{needed:async()=>pending,run:()=>{
       snapshotActive=true;calls.push('snapshot');return{done:new Promise(r=>{finish=r;}),terminate:async()=>{
         calls.push('terminate');await Promise.resolve();snapshotActive=false;pending=false;finish({exitCode:1,error:'snapshot_cancelled'});
       }};
     }},now:()=>liveClock,safetyDelayMs:0,setTimer:fn=>{if(snapshotActive)queueMicrotask(()=>{liveClock+=HOUR*1000;fn();});return 1;},clearTimer:()=>{}});
   await scheduler.tick();await scheduler.stop();assert.deepEqual(calls,['snapshot','terminate','collector']);assert.equal(cp,BASE+5*HOUR);
 });
 await test('frontend validates metadata, displays saved coverage and explicit delay',async()=>{
   const require=createRequire(import.meta.url),ts=require('typescript');
   require.extensions['.ts']=(module,file)=>module._compile(ts.transpileModule(readFileSync(file,'utf8'),{fileName:file,
     compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true,jsx:ts.JsxEmit.ReactJSX}}).outputText,file);
   require.extensions['.tsx']=require.extensions['.ts'];
   const lib=require(fileURLToPath(new URL('../src/lib/arcIntelligence.ts',import.meta.url)));
   const components=require(fileURLToPath(new URL('../src/components/ArcIntelligenceOverview.tsx',import.meta.url)));
   const React=require('react'),{renderToStaticMarkup}=require('react-dom/server');
   const v3=await snapshots.read('v3',model.snapshotIdentity()),v4=await snapshots.read('v4',model.snapshotIdentity()),eco=await snapshots.read('ecosystem',model.snapshotIdentity());
   assert.ok(lib.parseArcPools(v3,'v3','30d'));assert.ok(lib.parseArcEcosystem(eco,'30d'));
   assert.equal(lib.parseArcPools({...v3,snapshot:{...v3.snapshot,lagHours:-1}},'v3','30d'),null);
   assert.equal(lib.parseArcEcosystem({...eco,snapshot:{...eco.snapshot,verifiedThrough:'2026-09-15T00:00:00Z'}},'30d'),null);
   const data={window:'30d',summary:model.summary('30d'),timeseries:model.timeseries('30d'),pools:{v3,v4},ecosystem:eco,failed:false,
     refresh:Object.fromEntries(['poolsV3','poolsV4','ecosystem'].map(section=>[section,{lastSuccessAt:new Date(clock).toISOString(),verifiedThrough:v3.snapshot.verifiedThrough,retained:false,error:null}]))};
   const html=renderToStaticMarkup(React.createElement(components.ArcIntelligenceDashboard,{selectedWindow:'30d',data}));
   assert.match(html,/saved verified snapshot/);assert.doesNotMatch(html,/up to date/);assert.match(html,/Newer results are not ready/);assert.match(html,/delayed by at least 1 hours/);
   assert.ok(html.includes('5 of 720 verified hours'),'snapshot evidence keeps its own partial window');
   const urls=(await import('../api/_lib/intelligence-proxy.js')).resolveIntelligenceRoute;
   const load=await lib.loadArcIntelligence('30d',{fetchImpl:async url=>{
     const query=Object.fromEntries(new URL(url,'http://local').searchParams),route=urls(query);
     let value;
     if(query.view==='summary')value=data.summary;else if(query.view==='timeseries')value=data.timeseries;
     else if(query.view==='ecosystem')value={...eco,snapshot:{...eco.snapshot,preparedAt:new Date(clock+1000).toISOString()}};
     else if(query.view==='pools')value=query.protocol==='v3'?v3:v4;else value=model.activity(query.type);
     assert.ok(route);return{ok:true,status:200,json:async()=>value};
   }});
   assert.equal(load.pools.v3,null);assert.equal(load.pools.v4,null);assert.equal(load.ecosystem,null);assert.ok(load.summary);
 });
 await test('crash after activation: durable bundle prevents unnecessary repeated preparation',async()=>{
   class CommittedThenFailed extends EventEmitter {
     send(m){queueMicrotask(async()=>{
       if(m.stage==='end'){
         const cp=model.snapshotIdentity();await snapshots.publish(cp,{v3:model.pools('v3','30d'),v4:model.pools('v4','30d'),ecosystem:model.ecosystem('30d')});
         this.emit('message',{stage:'end',error:'lost_acknowledgement'});
       }else this.emit('message',{stage:m.stage});
     });}
     kill(){queueMicrotask(()=>this.emit('exit',null));}
   }
   const r=createSnapshotRunner({path,store:snapshots,readModel:model,spawnImpl:()=>new CommittedThenFailed()});
   assert.equal(await r.needed(),true);assert.equal((await r.run().done).exitCode,1);assert.equal(await r.needed(),false);
   assert.equal((await createDashboardSnapshotStore(options).read('v3',model.snapshotIdentity())).pools[0].swapCount,21);
 });
 await test('SQLite integrity and accepted canonical/projection values preserved',async()=>{
   assert.equal(writer.prepare('PRAGMA quick_check').get().quick_check,'ok');assert.equal(writer.prepare('SELECT count(*) AS n FROM compact_hours').get().n,6);
   assert.equal(writer.prepare('SELECT hour_start FROM compact_checkpoint').get().hour_start,BASE+5*HOUR);
   assert.equal(writer.prepare('SELECT count(*) AS n FROM compact_pool_hours').get().n,12);
 });
 console.log(`VERIFIER PASS compact-dashboard-snapshot ${passed} cases`);
}finally{model.close();writer.close();await fs.rm(directory,{recursive:true,force:true});}
