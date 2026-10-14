// Targeted OOM acceptance: independently archived baseline, tiny equality fixture, high-cardinality packed fixture.
// All databases live in a disposable local directory. No RPC, collector, recovery or production paths.
import assert from 'node:assert/strict';
import { promises as fs, createReadStream } from 'node:fs';
import { spawn, execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
import { getHeapStatistics } from 'node:v8';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { createCompactStore } from '../server/compact/store.js';
import { createPackedShards } from '../server/compact/packed-shards.js';
import { createPoolTotals, POOL_TOTAL_BUFFER_BYTES, POOL_TOTAL_MAX_KEYS } from '../server/compact/pool-totals.js';
import { createCompactReadModel } from '../server/compact/read-model.js';
import { createDashboardSnapshotStore, createSnapshotRunner } from '../server/compact/dashboard-snapshot.js';
import { COMPACT_DEFINITION_VERSION } from '../server/compact/sources.js';
import { FAMILY_FIELDS } from '../server/compact/families.js';
import { VALUATIONS } from '../server/compact/valuation.js';
import { ARC_VERIFIED_ASSETS } from '../api/_lib/arc-intelligence/assets.js';

const ROOT=fileURLToPath(new URL('../',import.meta.url)),HOUR=3600,BASE=Date.parse('2026-09-16T00:00:00Z')/1000;
const BASELINE='a69b362ee77b9710f7eac6ae601a292121fe39e7'; // Keep the independent pre-fix comparison reproducible after commit.
const hash=n=>'0x'+n.toString(16).padStart(64,'0'),address=n=>'0x'+n.toString(16).padStart(40,'0');
const V3='uniswap_v3',V4='uniswap_v4',poolId=(protocol,n)=>protocol===V3?address(n+10000000):hash(n+20000000);
const token=symbol=>ARC_VERIFIED_ASSETS.find(t=>t.symbol===symbol).address,USDC=token('USDC'),WETH=token('WETH'),USYC=token('USYC');
const sha=text=>createHash('sha256').update(text).digest('hex');
const finished=(BASE+720*HOUR+60)*1000;

if(process.argv[2]==='--child'){
  assert.ok(getHeapStatistics().heap_size_limit<=64*1024*1024);
  const path=process.argv[3],root=process.argv[4],windows=JSON.parse(process.argv[5]);
  const {createCompactReadModel:factory}=await import(pathToFileURL(join(root,'server/compact/read-model.js')));
  const peak={},mem=()=>{const at=performance.now(),m={...process.memoryUsage(),heapSizeLimit:getHeapStatistics().heap_size_limit};
    for(const [k,v]of Object.entries(m))peak[k]=Math.max(peak[k]??0,v);cost+=performance.now()-at;};
  let cost=0,calls=0;
  class MeasuredDatabase extends DatabaseSync{
    prepare(sql){const s=super.prepare(sql),iterate=s.iterate;
      s.iterate=function*(...args){try{for(const row of iterate.apply(s,args)){if(++calls%2048===0)mem();yield row;}}finally{}};return s;}
  }
  const model=factory({path,DatabaseSync:MeasuredDatabase,now:()=>finished,onReadSample:mem});
  const values={},timings={};mem();
  try{
    const cp=model.snapshotIdentity();model.beginPrepared30d(cp);
    for(const window of windows)for(const protocol of ['v3','v4']){
      const stage=protocol+':'+window;process.send({started:stage});const at=performance.now();
      values[stage]=model.pools(protocol,window);timings[stage]=performance.now()-at;mem();process.send({finished:stage,ms:timings[stage]});
    }
    model.endPrepared30d();process.send({result:{values,timings,peak,sampleCostMs:cost,proof:model.poolProofStats(),memory:model.poolMemoryStats?.()??null}});
    model.close();process.disconnect();
  }catch(error){process.send({failure:{code:error.code,detail:error.detail}});model.close();process.exitCode=1;process.disconnect();}
  // Skip parent setup below.
}else{
  let checks=0;
  const check=(label,fn)=>{fn();checks++;console.log('PASS '+label);};
  check('exact hash placement, collision resolution, top-K ties and safe sums',()=>{
    const table=createPoolTotals({slots:64}),expected=new Map();
    for(let n=0;n<45;n++)for(const count of [n%7+1,9]){table.add(V3,poolId(V3,n),count);expected.set(poolId(V3,n),(expected.get(poolId(V3,n))??0)+count);}
    const ranked=[...expected].sort(([a,x],[b,y])=>y-x||(a<b?-1:a>b?1:0)).slice(0,10);
    assert.deepEqual([...table.top(V3)].map(([p,r])=>[p,r.total]),ranked);table.clear();assert.equal(table.stats().keys,0);
    table.add(V3,poolId(V3,1),Number.MAX_SAFE_INTEGER);assert.throws(()=>table.add(V3,poolId(V3,1),1),e=>e.detail==='pool_projection_malformed');
  });
  check('fixed counter capacity is fail-closed, never approximation or partial top-K',()=>{
    const table=createPoolTotals({slots:8});for(let i=0;i<6;i++)table.add(V4,poolId(V4,i),1);
    assert.throws(()=>table.add(V4,poolId(V4,6),1),e=>e.detail==='pool_ranking_memory_budget_exceeded');
    assert.equal(table.stats().bytes,8*41);assert.equal(POOL_TOTAL_BUFFER_BYTES,10747904);assert.equal(POOL_TOTAL_MAX_KEYS,209715);
  });
  const disk=await fs.statfs('/workspace');assert.ok(disk.bavail*disk.bsize>3*1024**3,'local test capacity');
  const directory=await fs.mkdtemp('/workspace/machina-pool-memory-'),baseline=join(directory,'baseline');
  await fs.mkdir(baseline);const archive=execFileSync('git',['archive',BASELINE,'server/compact','api/_lib'],{cwd:ROOT,maxBuffer:8*1024*1024});
  const unpack=spawn('tar',['-x','-C',baseline],{stdio:['pipe','inherit','inherit']});unpack.stdin.end(archive);
  assert.equal(await new Promise((r,j)=>{unpack.once('exit',r);unpack.once('error',j);}),0);
  const report={directory,baselineHead:BASELINE,checks:0};
  const registryMeta=n=>n%4===0?{token0:WETH,token1:USYC}:n%4===1?{token0:USDC,token1:WETH}:
    n%4===2?{token0:address(50000000+n),token1:WETH}:{token0:USDC,token1:address(50000000+n)};
  async function build(path,{poolsPerProtocol,rowsPerHour,pricesPerHour,longAmounts=false,olderWinner=false}){
    const db=new DatabaseSync(path),store=createCompactStore(db,{packedShards:{config:{enabled:true,retention:false},log:()=>{}}});
    const cfg={enabled:true,retention:true,expiry:false,history:false,hotHours:48,maintenanceScopes:256,maintenanceMiB:64};
    const packed=createPackedShards(db,{config:cfg,log:()=>{}}),insertPool=db.prepare('INSERT INTO compact_pool_hours VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
    const reg=db.prepare('INSERT INTO compact_registry VALUES(?,?,?,?,?,?)');db.exec('BEGIN');
    for(const protocol of [V3,V4])for(let n=0;n<poolsPerProtocol;n++){
      const pair=registryMeta(n),meta=protocol===V3?{...pair,fee:3000,tickSpacing:60}:
        {currency0:pair.token0,currency1:pair.token1,fee:3000,tickSpacing:60,hooks:address(0)};
      reg.run(protocol+'_pool',poolId(protocol,n),90,0,hash(90),JSON.stringify(meta));
    }
    for(const protocol of [V3,V4])db.prepare('INSERT INTO compact_registry_coverage VALUES(?,?,?,?)').run(protocol+'_pool',0,1000000000,hash(90));
    db.exec('COMMIT');
    const projection=db.prepare("INSERT INTO compact_projection_hours VALUES(?,?,'available',NULL,?,?)");
    const val=db.prepare("INSERT INTO compact_valuation_hours VALUES(?,?,'available',NULL,?,?)");
    const price=db.prepare('INSERT INTO compact_token_price_hours VALUES(?,?,?,?,?,?,?)');
    const volume=db.prepare('INSERT INTO compact_dex_volume_hours VALUES(?,?,?,?,?)'),fee=db.prepare('INSERT INTO compact_dex_fee_hours VALUES(?,?,?,?,?)');
    const tvl=db.prepare('INSERT INTO compact_pool_tvl_hours VALUES(?,?,?,?,?,?,?,?)');
    for(let i=0;i<720;i++){
      const hour=BASE+i*HOUR,block=100+i;
      store.commitHour({definitionVersion:COMPACT_DEFINITION_VERSION,chainId:5042,sourceVersions:{},complete:false,
        range:{kind:'hour',hourStart:hour,hourEnd:hour+HOUR,firstBlock:block,lastBlock:block,parentHash:hash(block-1),firstHash:hash(block),lastHash:hash(block)},
        network:{status:'available',blockCount:1,transactionCount:0,uniqueActiveAddresses:0,gasUsedRaw:'0'},activeAddresses:[],
        families:Object.fromEntries(Object.entries(FAMILY_FIELDS).map(([n,fields])=>[n,{status:'unavailable',reason:'memory_fixture',...Object.fromEntries(fields.map(f=>[f,null]))}])),registry:{uniswapV3:null}});
      packed.begin();db.exec('BEGIN');
      for(const protocol of [V3,V4]){
        let written=0;
        for(let j=0;j<rowsPerHour;j++){
          const n=j<12?j:12+(i*(rowsPerHour-12)+j-12)%(poolsPerProtocol-12);
          if(olderWinner&&n===31&&i>=672)continue;
          const count=olderWinner&&n===31&&i<100?100000:j<12?1000:1;written++;
          const raw=longAmounts?'1'+'0'.repeat(76):null;
          insertPool.run(hour,protocol,poolId(protocol,n),count,raw??'123456789012345678901234',raw??'7',raw??'9876543210123456789',raw??'11',1,1,0,
            ...(protocol===V3?[raw??'9999999999999999999',raw??'1',raw??'8888888888888888888',raw??'2']:[null,null,null,null]));
        }
        projection.run(hour,protocol+'_pools',written,sha(`${hour}:${protocol}`));
        projection.run(hour,protocol+'_price_paths',0,sha(`${hour}:${protocol}:prices`));
        volume.run(hour,protocol,'1234567890123456789',0,0);fee.run(hour,protocol,'0',0,0);
        if(i===719)for(let n=0;n<12;n++)tvl.run(hour,protocol,poolId(protocol,n),'available',null,'100000000000000000000','200000000000000000000',block);
      }
      projection.run(hour,'uniswap_v4_swap_fees',0,sha(`${hour}:fees`));projection.run(hour,'dex_activity',0,sha(`${hour}:activity`));
      for(const name of VALUATIONS)val.run(hour,name,pricesPerHour+2,sha(`${hour}:${name}`));
      price.run(hour,WETH,'2000000000000000000',V3,poolId(V3,0),'1000000000',1);
      price.run(hour,USYC,'1500000000000000000',V3,poolId(V3,0),'1000000000',1);
      for(let n=0;n<pricesPerHour;n++)price.run(hour,address(80000000+n),'1000000000000000000',V3,poolId(V3,0),'1000000000',1);
      const result=packed.packHour(hour);assert.equal(result.compact_pool_hours.outcome,'inserted');db.exec('COMMIT');
      if(i%120===119)console.log(JSON.stringify({fixture:path,hours:i+1,poolsPerProtocol,rowsPerHour,pricesPerHour}));
    }
    for(;;){packed.begin();db.exec('BEGIN');const result=packed.maintain(BASE+719*HOUR,{limit:256});db.exec('COMMIT');assert.deepEqual(result.failed,[]);
      if(!result.pruned&&!result.packed)break;}
    const counts={pools:db.prepare('SELECT COUNT(*) AS n FROM compact_registry').get().n,
      packedRows:db.prepare("SELECT SUM(row_count) AS n FROM compact_packed_sets WHERE dataset='compact_pool_hours'").get().n,
      packedPieces:db.prepare("SELECT SUM(pieces) AS n FROM compact_packed_sets WHERE dataset='compact_pool_hours'").get().n,
      prices:db.prepare('SELECT COUNT(*) AS n FROM compact_token_price_hours').get().n,
      prunedHours:db.prepare("SELECT COUNT(*) AS n FROM compact_packed_pruned WHERE dataset='compact_pool_hours'").get().n};
    assert.equal(db.prepare('PRAGMA quick_check').get().quick_check,'ok');db.exec('PRAGMA wal_checkpoint(TRUNCATE)');db.close();
    counts.bytes=(await fs.stat(path)).size;return counts;
  }
  async function runChild(path,root,windows){
    const child=spawn(process.execPath,['--max-old-space-size=48','--max-semi-space-size=4',fileURLToPath(import.meta.url),'--child',path,root,JSON.stringify(windows)],
      {stdio:['ignore','ignore','pipe','ipc'],env:{PATH:process.env.PATH}});
    let timer,stage='startup',result,failure,stderr='',timedOut=false;
    timer=setTimeout(()=>{timedOut=true;child.kill('SIGKILL');},30000);
    child.stderr.on('data',chunk=>{stderr=(stderr+chunk.toString()).slice(-16384);});
    child.on('message',m=>{
      if(m.started){stage=m.started;clearTimeout(timer);timer=setTimeout(()=>{timedOut=true;child.kill('SIGKILL');},30000);}
      if(m.finished)console.log(JSON.stringify({reader:root===ROOT?'new':'baseline',stage:m.finished,ms:m.ms}));
      if(m.result){result=m.result;clearTimeout(timer);}if(m.failure){failure=m.failure;clearTimeout(timer);}
    });
    const exit=await new Promise((r,j)=>{child.once('exit',(code,signal)=>r({code,signal}));child.once('error',j);});clearTimeout(timer);
    return {...exit,result,failure,timedOut,stage,heapOom:/heap out of memory|heap limit/.test(stderr)};
  }
  const small=join(directory,'small.sqlite'),large=join(directory,'large.sqlite');
  report.small=await build(small,{poolsPerProtocol:32,rowsPerHour:20,pricesPerHour:5,olderWinner:true});
  const before=await runChild(small,baseline,['24h','7d','30d']),after=await runChild(small,ROOT,['24h','7d','30d']);
  assert.equal(before.code,0);assert.equal(after.code,0);assert.deepEqual(after.result.values,before.result.values);checks++;
  console.log('PASS exact old/new output equality for V3/V4 24H/7D/30D (720 small hours, prices and liquidity)');
  report.smallEquality={before:before.result.timings,after:after.result.timings};
  // Wrong untrusted hint must still return the original verified totals/ranking.
  const w=new DatabaseSync(small);w.prepare('UPDATE compact_packed_pool_swaps SET swap_count=swap_count+?,row_count=row_count+1 WHERE pool=?').run(999999999,poolId(V3,31));w.close();
  const wrong=await runChild(small,ROOT,['30d']);assert.equal(wrong.code,0);
  assert.deepEqual(wrong.result.values['v3:30d'],after.result.values['v3:30d']);checks++;console.log('PASS false ranking hint independently corrected');
  // A malformed unneeded price is never skipped by token filtering.
  const p=new DatabaseSync(small);p.prepare("UPDATE compact_token_price_hours SET price_usd_e18='malformed' WHERE hour_start=? AND token=?").run(BASE+719*HOUR,address(80000000));p.close();
  const bad=await runChild(small,ROOT,['30d']);assert.equal(bad.code,1);assert.equal(bad.failure.detail,'token_price_malformed');checks++;console.log('PASS malformed unneeded token price fails closed');
  const streaming=join(directory,'streaming.sqlite');
  report.streaming=await build(streaming,{poolsPerProtocol:32,rowsPerHour:20,pricesPerHour:5,longAmounts:true,olderWinner:true});
  const streamed=await runChild(streaming,ROOT,['30d']);assert.equal(streamed.code,0);
  assert.equal(streamed.result.memory.memoBytes,0,'oversized selected rows must stream instead of staying in the memo');
  for(const protocol of ['v3','v4']){
    const body=streamed.result.values[protocol+':30d'];assert.equal(body.pools[0].pool,poolId(protocol==='v3'?V3:V4,31));
    assert.equal(body.pools.find(p=>p.pool===poolId(protocol==='v3'?V3:V4,0)).flowsRaw.token0In,(10n**76n*720n).toString());
  }
  report.streamingMetrics={timings:streamed.result.timings,peak:streamed.result.peak,memory:streamed.result.memory};checks++;
  console.log('PASS byte-budget streaming fallback preserves exact long amounts and packed-only winner order');
  report.large=await build(large,{poolsPerProtocol:100000,rowsPerHour:1200,pricesPerHour:700});
  const fileDigest=async()=>{const hash=createHash('sha256');for await(const chunk of createReadStream(large))hash.update(chunk);return hash.digest('hex');};
  const largeDigest=await fileDigest();
  const oldLarge=await runChild(large,baseline,['30d']);report.oldLarge={...oldLarge,result:undefined};
  const newLarge=await runChild(large,ROOT,['7d','30d']);report.newLarge={...newLarge,result:undefined,metrics:newLarge.result&&{timings:newLarge.result.timings,peak:newLarge.result.peak,sampleCostMs:newLarge.result.sampleCostMs,memory:newLarge.result.memory,proof:newLarge.result.proof}};
  assert.equal(newLarge.code,0,'new reader must complete under unchanged heap');
  assert.ok(newLarge.result.peak.heapSizeLimit<=64*1024*1024);assert.ok(Object.values(newLarge.result.timings).every(ms=>ms<30000));
  assert.ok(newLarge.result.memory.totals.keys<=POOL_TOTAL_MAX_KEYS);assert.equal(newLarge.result.memory.totals.bytes,POOL_TOTAL_BUFFER_BYTES);
  assert.ok(newLarge.result.memory.memoBytes<=newLarge.result.memory.maxMemoBytes);
  for(const key of ['v3:30d','v4:30d']){assert.equal(newLarge.result.values[key].status,'available');assert.equal(newLarge.result.values[key].pools.length,10);}
  checks++;console.log('PASS high-cardinality packed read under 48/4 MiB flags and 30s stage cap');
  // Run the real snapshot child protocol once, with original stage deadlines and unchanged heap flags.
  const readModel=createCompactReadModel({path:large,DatabaseSync}),snapshots=createDashboardSnapshotStore({path:large,verifyCheckpoint:cp=>readModel.snapshotCheckpointMatches(cp)});
  const stages={},starts={};
  const runner=createSnapshotRunner({path:large,store:snapshots,readModel,log:console.log,spawnImpl:(...args)=>{
    const child=spawn(...args),send=child.send.bind(child);child.send=(m,...rest)=>{starts[m.stage]=performance.now();return send(m,...rest);};
    child.on('message',m=>{stages[m.stage]=performance.now()-starts[m.stage];});return child;
  }});
  try{
    assert.equal((await runner.run().done).exitCode,0);const bundle=await snapshots.load();
    // The comparison child freezes the wall clock; production preparation uses Date.now(). Compare all source facts and checkpoint fields.
    const sourceFacts=({freshness,...body})=>({...body,freshness:{checkpointHour:freshness.checkpointHour,verifiedThrough:freshness.verifiedThrough,checkpointBlock:freshness.checkpointBlock}});
    for(const protocol of ['v3','v4'])assert.deepEqual(sourceFacts(JSON.parse(bundle.sections[protocol].json)),sourceFacts(newLarge.result.values[protocol+':30d']));
    assert.ok(Object.values(stages).every(ms=>ms<30000));report.snapshot={stages,activeBytes:(await fs.stat(snapshots.activePath)).size};checks++;
    console.log('PASS actual snapshot preparation and durable activation for the high-cardinality fixture');
  }finally{readModel.close();}
  assert.equal(await fileDigest(),largeDigest);checks++;report.canonicalFileSha256=largeDigest;console.log('PASS high-cardinality canonical SQLite file byte-identical after both readers and snapshot preparation');
  report.checks=checks;await fs.writeFile(join(directory,'result.json'),JSON.stringify(report,null,2));
  console.log(JSON.stringify({directory,checks,large:report.large,oldLarge:report.oldLarge,newLarge:report.newLarge,snapshot:report.snapshot}));
  console.log(`VERIFIER PASS compact-pool-memory ${checks} cases`);
}
