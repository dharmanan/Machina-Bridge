// Reuses an existing, generated identity fixture. No production, network RPC, scheduler, recovery or original-file writes.
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { promises as fs, createReadStream, constants } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createServer, get } from 'node:http';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCompactStore } from '../server/compact/store.js';
import { createCompactReadModel } from '../server/compact/read-model.js';
import { createDashboardSnapshotStore, createSnapshotRunner, SNAPSHOT_STAGE_TIMEOUT_MS } from '../server/compact/dashboard-snapshot.js';
import { packedShardsConfig } from '../server/compact/packed-shards.js';
import { COMPACT_DEFINITION_VERSION } from '../server/compact/sources.js';
import { FAMILY_FIELDS,FAMILY_WINDOWS } from '../server/compact/families.js';

const MiB=1024**2,HOUR=3600,ROOT=fileURLToPath(new URL('../',import.meta.url));
globalThis.fetch=async()=>{throw Error('RPC_network_forbidden');};
const source=await fs.realpath(process.env.COMPACT_IDENTITY_SCALE_FIXTURE??'/not-configured');
assert.ok(source.startsWith('/workspace/machina-identity-integrity-')&&source.endsWith('/heap.sqlite'),'only an owned, generated fixture is allowed');
const digest=async path=>{const h=createHash('sha256');for await(const b of createReadStream(path))h.update(b);return h.digest('hex');};
const sourceSha=await digest(source),reuse=process.env.COMPACT_SUMMARY_SCALE_PREPARED;
if(reuse)assert.ok((await fs.realpath(reuse)).startsWith('/workspace/machina-summary-scale-'));
const directory=reuse?fileURLToPath(new URL('./','file://'+reuse)):await fs.mkdtemp('/workspace/machina-summary-scale-'),path=reuse??join(directory,'fixture.sqlite');
const disk=await fs.statfs(directory);assert.ok(disk.bavail*disk.bsize>2*1024**3,'need 2 GiB safe local test capacity, no deletion or forced fixture build');
if(!reuse)await fs.copyFile(source,path,constants.COPYFILE_FICLONE);
process.env.TMPDIR=directory;
const db=new DatabaseSync(path),beforeHours=db.prepare('SELECT COUNT(*) AS n FROM compact_hours').get().n;
assert.ok(beforeHours===720||beforeHours===1440,'prepared fixture must have 720 or 1440 hours; never discard an appended hour');
const BASE=db.prepare('SELECT MIN(hour_start) AS n FROM compact_hours').get().n;
assert.equal(db.prepare('SELECT transaction_count FROM compact_hours ORDER BY hour_start LIMIT 1').get().transaction_count,3200);
// The earlier fallback test deliberately disabled daily statuses. Restore only this generated copy's independently packed counts.
db.exec(`UPDATE compact_daily_active_addresses SET status='available',reason=NULL,active_addresses=(
  SELECT row_count FROM compact_packed_sets WHERE dataset='compact_daily_address_stage' AND scope_start=day_start)`);
const store=createCompactStore(db,{archive:{config:{enabled:false}},packedShards:{config:packedShardsConfig({COMPACT_PACKED_SHARDS_ENABLED:'true'}),log:()=>{}}});
const hash=n=>'0x'+n.toString(16).padStart(64,'0');
const address=n=>'0x'+createHash('sha256').update('identity-capacity:'+n).digest('hex').slice(0,32)+n.toString(16).padStart(8,'0');
// Complete empty-event PROTOCOL fixtures, not mainnet claims. Derive the typed zero counters/tallies from existing specs.
// This avoids an invalid >256 KiB all-failure response while leaving genuinely absent prices/projections unavailable.
const emptyFamilies=Object.fromEntries(Object.entries(FAMILY_FIELDS).map(([name,fields])=>{
  const spec=FAMILY_WINDOWS[name],metrics=Object.fromEntries(fields.map(k=>[k,0]));
  for(const k of spec.amounts??[])metrics[k]='0';
  for(const k of Object.keys(spec.tallies??{}))metrics[k]={};
  for(const k of Object.keys(spec.lists??{}))metrics[k]=[];
  for(const k of spec.constants??[]){assert.equal(k,'rawDecimals');metrics[k]=18;}
  return[name,{status:'available',...metrics}];
}));
function append(i){
  const block=100+i,hourStart=BASE+i*HOUR,local=i%720;
  store.commitHour({definitionVersion:COMPACT_DEFINITION_VERSION,chainId:5042,sourceVersions:{},complete:true,
    range:{kind:'hour',hourStart,hourEnd:hourStart+HOUR,firstBlock:block,lastBlock:block,parentHash:hash(block-1),firstHash:hash(block),lastHash:hash(block)},
    network:{status:'available',blockCount:1,transactionCount:3200,uniqueActiveAddresses:3200,gasUsedRaw:'21000'},
    activeAddresses:Array.from({length:3200},(_,j)=>address(local*3100+j+1)),
    families:emptyFamilies,registry:{uniswapV3:{through:block,throughHash:hash(block),created:[]}}});
}
const buildAt=performance.now();
// Existing canonical network and accepted memberships must match exactly. commitHour validates that before adding the
// new, explicitly synthetic empty-event families. The source fixture and all its unavailable evidence remain untouched.
for(let i=0;i<1440;i++)append(i);
db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
console.log(JSON.stringify({fixture:{directory,addedHours:1440-beforeHours,buildMs:performance.now()-buildAt,syntheticOnly:true,repeatedMembershipDistribution:true}}));
const clock=()=> (BASE+1440*HOUR+60)*1000;
const model=createCompactReadModel({path,DatabaseSync,now:clock}),options={path,now:clock,verifyCheckpoint:cp=>model.snapshotCheckpointMatches(cp)};
const snapshots=createDashboardSnapshotStore(options),measurements={stages:[],peakChildRss:0,peakSpoolBytes:0};
let activeChild;
const spawnImpl=(node,args,options)=>{
  assert.deepEqual(args.slice(0,2),['--max-old-space-size=48','--max-semi-space-size=4']);
  activeChild=spawn(node,args,options);return activeChild;
};
let sampling=Promise.resolve();
const monitor=setInterval(()=>{const pid=activeChild?.pid;if(!pid)return;
  sampling=sampling.then(async()=>{
    try{
      const text=await fs.readFile(`/proc/${pid}/status`,'utf8'),m=text.match(/^VmHWM:\s+(\d+)\s+kB/m);
      if(m)measurements.peakChildRss=Math.max(measurements.peakChildRss,Number(m[1])*1024);
      let bytes=0;for(const fd of await fs.readdir(`/proc/${pid}/fd`))try{
        if((await fs.readlink(`/proc/${pid}/fd/${fd}`)).includes('machina-identity-union-'))bytes+=(await fs.stat(`/proc/${pid}/fd/${fd}`)).size;
      }catch{}
      measurements.peakSpoolBytes=Math.max(measurements.peakSpoolBytes,bytes);
    }catch{}
  });
},25);
const runner=createSnapshotRunner({path,store:snapshots,readModel:model,now:clock,spawnImpl,log:line=>console.log(line),onStage:s=>{measurements.stages.push(s);console.log(JSON.stringify({stage:s}));}});
let service,serviceExit;
async function startService(){
  const reserve=createServer();await new Promise(r=>reserve.listen(0,'127.0.0.1',r));const port=reserve.address().port;await new Promise(r=>reserve.close(r));
  service=spawn(process.execPath,['--max-old-space-size=48','--max-semi-space-size=4','scripts/serve-compact-intelligence.mjs'],{
    cwd:ROOT,env:{PATH:process.env.PATH,COMPACT_SQLITE_PATH:path,PORT:String(port),COMPACT_SCHEDULER_ENABLED:'false',COMPACT_DISCOVERY_RECOVERY_ENABLED:'false',COMPACT_EVIDENCE_ARCHIVE_ENABLED:'false'},stdio:['ignore','pipe','pipe']});
  let log='';const output=b=>{log=(log+b).slice(-16384);};service.stdout.on('data',output);service.stderr.on('data',output);
  serviceExit=new Promise(r=>service.once('exit',(code,signal)=>r({code,signal})));
  const until=performance.now()+10000;while(!log.includes('SERVICE_LISTENING')){assert.equal(service.exitCode,null,log);assert.ok(performance.now()<until,'service startup timeout');await new Promise(r=>setTimeout(r,20));}
  return port;
}
async function stopService(){if(service?.exitCode===null){service.kill('SIGTERM');await serviceExit;}service=null;}
const request=(port,route)=>new Promise((resolve,reject)=>{
  const at=performance.now();let timer;
  const req=get({host:'127.0.0.1',port,path:route},res=>{let body='';res.setEncoding('utf8');res.on('data',b=>body+=b);res.on('end',()=>{clearTimeout(timer);resolve({status:res.statusCode,ms:performance.now()-at,body:JSON.parse(body)});});});
  req.on('error',e=>{clearTimeout(timer);reject(e);});timer=setTimeout(()=>req.destroy(Error('proxy_8000ms_exceeded')),8000);
});
try{
  let port=await startService();
  const missing=await request(port,'/v1/intelligence/summary?window=30d');assert.equal(missing.status,503);assert.deepEqual(missing.body,{error:'not_ready'});
  assert.ok(missing.ms<6000);measurements.initialNotReadyMs=missing.ms;
  const at=performance.now();assert.equal((await runner.run().done).exitCode,0);measurements.prepareMs=performance.now()-at;
  const bundle=await snapshots.load(),summary=JSON.parse(bundle.sections.summary.json);
  assert.equal(summary.network.uniqueActiveAddresses.value,2232100);assert.equal(summary.network.previous.uniqueActiveAddresses.value,2232100);
  assert.equal(summary.network.transactions,2304000);assert.equal(summary.network.previous.transactions,2304000);
  assert.equal(summary.window.coverage.availableHours,720);
  assert.deepEqual(Object.keys(bundle.sections).sort(),['ecosystem','summary','v3','v4']);
  for(const part of Object.values(bundle.sections))assert.equal(JSON.parse(part.json).window.end,summary.window.end);
  const routes=['summary?','pools?protocol=v3&','pools?protocol=v4&','ecosystem?'];
  const results=await Promise.all(routes.map(async route=>({route,...await request(port,'/v1/intelligence/'+route+'window=30d')})));
  for(const result of results){assert.equal(result.status,200);assert.ok(result.ms<6000);assert.equal(result.body.snapshot.checkpointHour,new Date(bundle.checkpoint.hourStart*1000).toISOString());}
  assert.equal(results[0].body.network.previous.uniqueActiveAddresses.value,2232100);
  measurements.http=results.map(({route,status,ms})=>({route,status,ms}));
  await stopService();port=await startService();
  const restarted=await request(port,'/v1/intelligence/summary?window=30d');assert.equal(restarted.status,200);assert.ok(restarted.ms<6000);
  measurements.restartHttpMs=restarted.ms;assert.equal(await runner.needed(),false);
  const activeSha=await digest(snapshots.activePath),canonical=JSON.stringify(store.checkpoint());
  // Real child death during a >2.2M-member preparation, with a valid generation still being served.
  const cancelling=createSnapshotRunner({path,store:snapshots,readModel:model,now:clock,spawnImpl});
  const handle=cancelling.run();let kill;
  const poll=setInterval(()=>{if(measurements.peakSpoolBytes>MiB&&activeChild?.pid){clearInterval(poll);kill=handle.terminate();}},10);
  // Ensure this specific run reaches live scratch, not a stale sampler's peak from the successful preparation.
  measurements.peakSpoolBytes=0;
  const outcome=await handle.done;clearInterval(poll);await kill;assert.equal(outcome.error,'snapshot_cancelled');
  assert.equal(await digest(snapshots.activePath),activeSha);assert.equal(JSON.stringify(store.checkpoint()),canonical);
  assert.equal((await fs.readdir(directory)).filter(n=>n.startsWith('machina-identity-union-')).length,0);
  assert.equal((await request(port,'/v1/intelligence/summary?window=30d')).status,200);
  measurements.sigkillPreservedSnapshot=true;
  // A canonical hour committed between pinned stages rejects the new bundle; the previous generation remains intact.
  let advanced=false;
  const changing=createSnapshotRunner({path,store:snapshots,readModel:model,now:clock,spawnImpl,onStage:s=>{
    if(s.stage==='summary'&&!advanced){append(1440);db.exec('PRAGMA wal_checkpoint(PASSIVE)');advanced=true;}
  }});
  assert.equal((await changing.run().done).error,'snapshot_inputs_changed');assert.equal(advanced,true);
  assert.equal(await digest(snapshots.activePath),activeSha);
  const stale=await request(port,'/v1/intelligence/summary?window=30d');assert.equal(stale.status,200);assert.equal(stale.body.snapshot.lagHours,1);assert.equal(stale.body.snapshot.status,'stale');
  assert.equal(stale.body.network.transactions,2304000);measurements.staleHttpMs=stale.ms;
  assert.ok(measurements.stages.every(s=>s.elapsedMs<SNAPSHOT_STAGE_TIMEOUT_MS&&s.heapLimit<=64*MiB&&s.peakHeap<s.heapLimit));
  measurements.sourceUnchanged=await digest(source)===sourceSha;assert.equal(measurements.sourceUnchanged,true);
  measurements.sourceSha256=sourceSha;measurements.fixtureDatabaseBytes=(await fs.stat(path)).size;
  measurements.snapshotBytes=(await fs.stat(snapshots.activePath)).size;
  measurements.freePages=db.prepare('PRAGMA freelist_count').get().freelist_count;
  assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check,'ok');
  console.log(JSON.stringify({directory,measurements,syntheticOnly:true,productionGuarantee:false}));
  await fs.writeFile(join(directory,'results.json'),JSON.stringify({measurements,syntheticOnly:true},null,2));
  console.log('VERIFIER PASS compact-summary-snapshot-scale');
}finally{clearInterval(monitor);await sampling;await stopService();model.close();db.close();}
