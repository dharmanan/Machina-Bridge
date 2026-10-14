// Targeted Node 24.21.0 startup regression. Real local HTTP service, disposable SQLite, scheduler/recovery OFF; no RPC.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { Worker } from 'node:worker_threads';
import { getHeapStatistics } from 'node:v8';
import { DatabaseSync } from 'node:sqlite';
import { promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import { createServer, get } from 'node:http';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { createEcosystemReader, READ_WORKER_RESOURCE_LIMITS, ECOSYSTEM_READ_TIMEOUT_MS, ECOSYSTEM_RESPONSE_TIMEOUT_MS } from '../server/compact/ecosystem-reader.js';
import { createCompactReadModel } from '../server/compact/read-model.js';
import { createCompactStore } from '../server/compact/store.js';
import { createIntelligenceSink } from '../server/compact/intelligence.js';
import { COMPACT_DEFINITION_VERSION } from '../server/compact/sources.js';
import { FAMILY_FIELDS } from '../server/compact/families.js';
import { createDashboardSnapshotStore, createSnapshotRunner, SNAPSHOT_STAGE_TIMEOUT_MS } from '../server/compact/dashboard-snapshot.js';

const ROOT=fileURLToPath(new URL('../',import.meta.url)),MiB=1024**2,HOUR=3600;
if(process.argv[2]==='--probe'){
  const limits=[];
  for(const cleared of [false,true]){
    const worker=new Worker(`require('node:worker_threads').parentPort.postMessage(require('node:v8').getHeapStatistics().heap_size_limit)`,
      {eval:true,resourceLimits:READ_WORKER_RESOURCE_LIMITS,...(cleared?{execArgv:[]}:{})});
    try{limits.push({cleared,heapBytes:await new Promise((resolve,reject)=>{worker.once('message',resolve);worker.once('error',reject);})});}
    finally{await worker.terminate();}
  }
  const reader=createEcosystemReader({path:'/workspace/never-opened-worker-startup.sqlite'});
  let error;
  try{await reader.read('24h');}catch(e){error=e.code;}finally{await reader.close();}
  process.send({node:process.version,parentHeapBytes:getHeapStatistics().heap_size_limit,limits,error});
  process.disconnect();
}else{
  assert.equal(process.version,'v24.21.0','run with the production Node 24.21.0 binary');
  let checks=0;
  const test=async(name,fn)=>{await fn();checks++;console.log('PASS '+name);};
  const config=await fs.readFile(join(ROOT,'railway.toml'),'utf8');
  const command=JSON.parse(config.match(/^startCommand = (".*")$/m)[1]).split(' ');
  assert.deepEqual(command.slice(0,2),['exec','node']);
  const args=command.slice(2,-1),entry=join(ROOT,command.at(-1));
  const env={PATH:process.env.PATH};
  async function probe(flags){
    const child=spawn(process.execPath,[...flags,fileURLToPath(import.meta.url),'--probe'],{env,stdio:['ignore','ignore','pipe','ipc']});
    let value,stderr='';child.stderr.on('data',b=>{stderr=(stderr+b).slice(-2048);});child.on('message',m=>{value=m;});
    const timer=setTimeout(()=>child.kill('SIGKILL'),10000);
    const code=await new Promise((resolve,reject)=>{child.once('exit',resolve);child.once('error',reject);});clearTimeout(timer);
    assert.equal(code,0,stderr);return value;
  }
  await test('fixed HTTP/snapshot budgets, worker guard and aligned bounded parent command',async()=>{
    assert.deepEqual(READ_WORKER_RESOURCE_LIMITS,{maxOldGenerationSizeMb:48,maxYoungGenerationSizeMb:4});
    assert.deepEqual(args,['--max-old-space-size=48','--max-semi-space-size=4']);
    assert.equal(ECOSYSTEM_READ_TIMEOUT_MS,6000);assert.equal(ECOSYSTEM_RESPONSE_TIMEOUT_MS,7000);assert.equal(SNAPSHOT_STAGE_TIMEOUT_MS,30000);
    assert.match(await fs.readFile(join(ROOT,'api/_lib/intelligence-proxy.js'),'utf8'),/const REQUEST_TIMEOUT_MS = 8_000\b/);
    assert.match(await fs.readFile(join(ROOT,'server/compact/ecosystem-worker.js'),'utf8'),/getHeapStatistics\(\).heap_size_limit > 64 \* 1024 \* 1024/);
  });
  await test('old production flag overrides 48/4 limits even with execArgv cleared; actual guard refuses SQLite',async()=>{
    const result=await probe(['--max-old-space-size=128']);
    assert.ok(result.limits.every(v=>v.heapBytes>64*MiB));assert.equal(result.error,'ecosystem_worker_heap_limit');
    console.log(JSON.stringify({test:'old_startup',...result}));
  });
  await test('new production flags hard-bound both parent and Worker; actual Worker reaches the read model',async()=>{
    const result=await probe(args);
    assert.equal(result.parentHeapBytes,60*MiB);assert.ok(result.limits.every(v=>v.heapBytes===60*MiB));
    assert.equal(result.error,'not_ready','nonexistent test file: startup succeeded, normal fail-closed read follows');
    console.log(JSON.stringify({test:'new_startup',...result}));
  });

  const directory=await fs.mkdtemp('/workspace/machina-worker-startup-'),path=join(directory,'fixture.sqlite');
  const hash=n=>'0x'+n.toString(16).padStart(64,'0'),address=n=>'0x'+n.toString(16).padStart(40,'0');
  const first=Math.floor(Date.now()/1000/HOUR)*HOUR-168*HOUR;
  const db=new DatabaseSync(path),store=createCompactStore(db,{packedShards:{config:{enabled:false},log:()=>{}}});
  for(let i=0;i<168;i++){
    const hour=first+i*HOUR,block=100+i;
    const range={kind:'hour',hourStart:hour,hourEnd:hour+HOUR,firstBlock:block,lastBlock:block,parentHash:hash(block-1),firstHash:hash(block),lastHash:hash(block)};
    const families=Object.fromEntries(Object.entries(FAMILY_FIELDS).map(([name,fields])=>[name,{status:'unavailable',reason:'startup_fixture',
      ...Object.fromEntries(fields.map(f=>[f,null]))}]));
    // Synthetic source-unavailable states stay explicit; this startup test does not claim mainnet discovery completeness.
    const intelligence=createIntelligenceSink().finish({range,families,codePresent:()=>false,projections:{}});
    store.commitHour({definitionVersion:COMPACT_DEFINITION_VERSION,chainId:5042,sourceVersions:{},complete:false,range,
      network:{status:'available',blockCount:1,transactionCount:1,uniqueActiveAddresses:1,gasUsedRaw:'21000'},
      activeAddresses:[address(1)],families,registry:{uniswapV3:null},intelligence});
    for(const [protocol,pool,count]of [['uniswap_v3',address(2),1],['uniswap_v4',hash(3),2]]){
      const meta=protocol==='uniswap_v3'?{token0:address(4),token1:address(5),fee:500,tickSpacing:10}:
        {currency0:address(4),currency1:address(5),fee:3000,tickSpacing:60,hooks:address(0)};
      db.prepare('INSERT OR IGNORE INTO compact_registry VALUES(?,?,?,?,?,?)').run(protocol+'_pool',pool,90,0,hash(90),JSON.stringify(meta));
      db.prepare('INSERT INTO compact_registry_coverage VALUES(?,?,?,?) ON CONFLICT(kind) DO UPDATE SET through_block=excluded.through_block,through_hash=excluded.through_hash')
        .run(protocol+'_pool',1,block,hash(block));
      db.prepare('INSERT INTO compact_pool_hours VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(hour,protocol,pool,count,'100','2','3','4',1,2,0,
        ...(protocol==='uniswap_v3'?['5','6','7','8']:[null,null,null,null]));
      db.prepare('INSERT INTO compact_projection_hours VALUES(?,?,?,?,?,?)').run(hour,protocol+'_pools','available',null,1,hash(i));
    }
  }
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)');db.close();
  const model=createCompactReadModel({path,DatabaseSync}),snapshots=createDashboardSnapshotStore({path,verifyCheckpoint:cp=>model.snapshotCheckpointMatches(cp)});
  const runner=createSnapshotRunner({path,store:snapshots,readModel:model});
  await test('unchanged 48/4 snapshot child prepares and persists all three 30D sections',async()=>{
    assert.equal((await runner.run().done).exitCode,0);
    const bundle=await snapshots.load();assert.ok(bundle.sections.v3&&bundle.sections.v4&&bundle.sections.ecosystem);
    assert.equal(JSON.parse(bundle.sections.v3.json).pools[0].swapCount,168);assert.equal(JSON.parse(bundle.sections.v4.json).pools[0].swapCount,336);
  });
  const digest=async p=>createHash('sha256').update(await fs.readFile(p)).digest('hex');
  const sqliteSha=await digest(path),activeSha=await digest(snapshots.activePath);
  const portServer=createServer();await new Promise(r=>portServer.listen(0,'127.0.0.1',r));
  const port=portServer.address().port;await new Promise(r=>portServer.close(r));
  const child=spawn(process.execPath,[...args,entry],{cwd:ROOT,env:{...env,COMPACT_SQLITE_PATH:path,PORT:String(port),
    COMPACT_SCHEDULER_ENABLED:'false',COMPACT_DISCOVERY_RECOVERY_ENABLED:'false',COMPACT_EVIDENCE_ARCHIVE_ENABLED:'false'},stdio:['ignore','pipe','pipe']});
  let log='',rssPeak=0;const output=b=>{log=(log+b).slice(-16384);};child.stdout.on('data',output);child.stderr.on('data',output);
  const exited=new Promise(r=>child.once('exit',(code,signal)=>r({code,signal})));
  const monitor=setInterval(()=>{fs.readFile(`/proc/${child.pid}/status`,'utf8').then(text=>{
    const match=text.match(/^VmRSS:\s+(\d+)\s+kB/m);if(match)rssPeak=Math.max(rssPeak,Number(match[1])*1024);
  }).catch(()=>{});},25);
  const localGet=route=>new Promise((resolve,reject)=>{
    const at=performance.now(),req=get({hostname:'127.0.0.1',port,path:route},res=>{
      let text='';res.setEncoding('utf8');res.on('data',b=>{text+=b;});res.on('end',()=>resolve({status:res.statusCode,body:JSON.parse(text),ms:performance.now()-at}));
    });req.on('error',reject);req.setTimeout(8000,()=>req.destroy(Error('local_proxy_limit')));
  });
  try{
    const until=performance.now()+10000;
    while(!log.includes('SERVICE_LISTENING')){assert.equal(child.exitCode,null,log);assert.ok(performance.now()<until,'service startup deadline');await new Promise(r=>setTimeout(r,25));}
    await test('real Railway-command service: simultaneous V3/V4/Ecosystem 24H/7D return HTTP 200 and exact source results',async()=>{
      const routes=[];
      for(const window of ['24h','7d'])for(const kind of ['v3','v4','ecosystem'])routes.push({kind,window,
        route:kind==='ecosystem'?`/v1/intelligence/ecosystem?window=${window}`:`/v1/intelligence/pools?protocol=${kind}&window=${window}`});
      const results=await Promise.all(routes.map(async item=>({...item,...await localGet(item.route)})));
      for(const result of results){
        assert.equal(result.status,200,log);assert.ok(result.ms<7000);
        const expected=result.kind==='ecosystem'?model.ecosystem(result.window):model.pools(result.kind,result.window);
        assert.deepEqual(result.body,JSON.parse(JSON.stringify(expected)));
        if(result.kind!=='ecosystem'){assert.equal(result.body.status,'available');assert.equal(result.body.pools[0].swapCount,
          (result.window==='24h'?24:168)*(result.kind==='v3'?1:2));}
      }
      console.log(JSON.stringify({test:'real_service_six_reads',results:results.map(({kind,window,status,ms})=>({kind,window,status,ms}))}));
    });
    await test('bounded parent health/Summary/Timeseries and unchanged persisted 30D snapshot routing',async()=>{
      assert.equal((await localGet('/health')).status,200);
      for(const window of ['24h','7d','30d'])for(const kind of ['summary','timeseries']){
        const result=await localGet(`/v1/intelligence/${kind}?window=${window}`);assert.equal(result.status,200,log);
        assert.deepEqual(result.body,JSON.parse(JSON.stringify(model[kind](window))));
      }
      for(const section of ['v3','v4','ecosystem']){
        const route=section==='ecosystem'?'/v1/intelligence/ecosystem?window=30d':`/v1/intelligence/pools?protocol=${section}&window=30d`;
        const result=await localGet(route);assert.equal(result.status,200,log);
        assert.deepEqual(result.body,await snapshots.read(section,model.snapshotIdentity()));
        assert.ok(result.body.snapshot);assert.ok(result.ms<7000);
      }
      assert.ok(!/HTTP_READ_FAILED|ecosystem_worker_heap_limit|SERVICE_UNCAUGHT|SERVICE_UNHANDLED/.test(log),log);
      assert.match(log,/SCHEDULER_ENABLED false/);assert.match(log,/DISCOVERY_RECOVERY_ENABLED false/);
    });
  }finally{
    clearInterval(monitor);child.kill('SIGTERM');const forced=setTimeout(()=>child.kill('SIGKILL'),5000);
    const exit=await exited;clearTimeout(forced);model.close();assert.equal(exit.code,0,log);
  }
  await test('read service preserves canonical SQLite and active snapshot byte-for-byte',async()=>{
    assert.equal(await digest(path),sqliteSha);assert.equal(await digest(snapshots.activePath),activeSha);
  });
  console.log(JSON.stringify({directory,node:process.version,parentAndWorkerHeapLimitMiB:60,sampledProcessRssBytes:rssPeak,
    note:'small synthetic startup fixture; no production load guarantee; parent old generation reduced from 128 to 48 MiB'}));
  console.log(`VERIFIER PASS compact-worker-startup ${checks} cases`);
}
