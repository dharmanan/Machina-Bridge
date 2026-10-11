// Real RPC-derived dense-hour storage test. Originals are read-only; all writes are disposable lab copies.
import assert from 'node:assert/strict';
import { DatabaseSync,backup } from 'node:sqlite';
import { mkdtempSync,readFileSync,writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openPipeline,hash,assertHeapBudget } from '../server/intelligence-pipeline/storage.js';
import { createDexHourStore,verifyDexSeal,readDexSealSummaries,restoreDexShard } from '../server/intelligence-pipeline/dex-hour-store.js';
import { deriveDexFamily } from '../server/intelligence-pipeline/dex-family.js';
const [inputPath,outputPath]=process.argv.slice(2);
if(!inputPath?.startsWith('/tmp/')||!outputPath?.startsWith('/tmp/'))throw Error('isolated_lab_paths_required');
const input=JSON.parse(readFileSync(inputPath));assert(input.complete);assert(input.directory.startsWith('/tmp/arc-dex-reduced-real-'));
const source=new DatabaseSync(join(input.directory,'reduced.sqlite'),{readOnly:true}),root=mkdtempSync(join(tmpdir(),'arc-dex-compact-proof-')),path=join(root,'reduced.sqlite');
await backup(source,path);source.close();
const opts={path,verifySeal:verifyDexSeal,readSealSummaries:readDexSealSummaries};let p=openPipeline(opts);const store=createDexHourStore(p);
let checks=0,peakHeap=0;const sample=()=>{peakHeap=Math.max(peakHeap,process.memoryUsage().heapUsed);assertHeapBudget();};const pass=()=>{checks++;sample();};
const before=p.metrics(),rowsBefore=p.db.prepare('SELECT sum(plain_bytes) plain,sum(length(payload_gzip)) gzip FROM arc_pipeline_results').get();
const units=p.db.prepare("SELECT unit_id FROM arc_pipeline_units WHERE json_extract(unit_json,'$.source.id') IN('uniswap_v3_events','uniswap_v4_events','uniswap_v3_hour_created_events') ORDER BY unit_id").all().map(r=>r.unit_id).filter(id=>p.coverage(id).status==='complete');
const summaries=[];let removed=0;const start=performance.now();
for(const id of units){
 const originalCounts={receivedEvents:0,acceptedEvents:0,foreignEvents:0},oracle=new Map();
 const order=proof=>[proof.blockNumber,proof.transactionIndex,proof.logIndex].map(n=>String(n).padStart(16,'0')).join(':');
 for(const s of p.summaries(id)){
  for(const k of Object.keys(originalCounts))originalCounts[k]+=s.counts[k];
  for(const r of s.rows.slice(1)){const old=oracle.get(r.pool);if(!old){oracle.set(r.pool,structuredClone(r));continue;}
   for(const [k,v]of Object.entries(r)){
    if(k.endsWith('Count'))old[k]+=v;
    else if(k.endsWith('Raw'))old[k]=(BigInt(old[k])+BigInt(v)).toString();
    else if(['observedSwap','observedLiquidity'].includes(k)){if(v&&(!old[k]||order(v)<order(old[k])))old[k]=v;}
    else if(k==='latestPoolState'){if(v&&(!old[k]||order(v)>order(old[k])))old[k]=v;}
    else if(k==='initializedPool'){if(old[k])assert.deepEqual(old[k],v);else old[k]=v;}
    else assert.deepEqual(old[k],v);
   }
  }
 }
 sample();
 const seal=store.publish(id);for(const k of Object.keys(originalCounts))assert.equal(seal.summary.counts[k],originalCounts[k]);pass();
 for(const s of p.summaries(id))for(const row of s.rows.slice(1)){assert.deepEqual(row,oracle.get(row.pool));oracle.delete(row.pool);}assert.equal(oracle.size,0);pass();
 assert.deepEqual(store.publish(id),seal);pass();removed+=store.compact(id).removedTransientPieces;assert.equal(p.coverage(id).status,'complete');pass();
 summaries.push({unitId:id,protocol:seal.summary.protocol,pools:seal.summary.poolCount,shards:seal.summary.shards.length,counts:seal.summary.counts});sample();
}
const after=p.metrics(),tables=p.db.prepare('SELECT name,sum(pgsize) bytes,sum(payload) payload FROM dbstat GROUP BY name ORDER BY bytes DESC').all();
const finals=[];for(const s of input.streams){const args=s.stream==='v3Pools'?{baseUnit:s.unitId,supplementUnits:s.incrementalCorrection.addedUnitIds,factoryUnit:s.incrementalCorrection.factoryUnitId,protocol:'uniswap_v3'}:{baseUnit:s.unitId,protocol:'uniswap_v4'};
 const d=deriveDexFamily(p,args);assert.equal(d.unitId,s.derivedFamily.unitId);assert.deepEqual(d.metrics,s.derivedFamily.metrics);pass();
 const row=p.db.prepare('SELECT result_sha FROM arc_pipeline_jobs WHERE unit_id=?').get(d.unitId);p.db.prepare('DELETE FROM arc_pipeline_results WHERE result_sha=?').run(row.result_sha);assert.equal(p.audit().repairQueued,1);const repaired=deriveDexFamily(p,args);assert.deepEqual(repaired.metrics,d.metrics);pass();finals.push(repaired);
}
assert.equal(p.db.prepare('PRAGMA integrity_check').get().integrity_check,'ok');assert.equal(p.db.prepare('PRAGMA foreign_key_check').all().length,0);pass();
p.close();p=openPipeline(opts);for(const id of units)assert.equal(p.coverage(id).status,'complete');pass();
const id=units.find(id=>p.getSeal(id).summary.shards.length),seal=p.getSeal(id),sha=seal.summary.shards[0],trustedPath=join(root,'trusted.sqlite');await backup(p.db,trustedPath);const trusted=new DatabaseSync(trustedPath,{readOnly:true});
p.db.prepare('DELETE FROM arc_pipeline_dex_shards WHERE sha=?').run(sha);assert.equal(p.coverage(id).status,'partial');restoreDexShard(p,{unitId:id,sha},trusted);assert.equal(p.coverage(id).status,'complete');pass();trusted.close();
const last=p.metrics(),shards=p.db.prepare('SELECT count(*) shards,sum(plain_bytes) plain,sum(length(payload_gzip)) gzip FROM arc_pipeline_dex_shards').get(),liveBytes=(last.pageCount-last.freelistCount)*last.pageSize;
const report={scope:'Real 2026-09-16 12:00 UTC verified DEX raw counts, per-pool action amounts, observed evidence, latest states and memberships. Not all 84 fields or actual 720-hour history.',root,checks,heapBudget:assertHeapBudget(),sampledHeapBytes:peakHeap,maxRSSBytes:process.resourceUsage().maxRSS*1024,durationMs:Math.round(performance.now()-start),rpcRequests:0,productionAccess:false,before,rowsBefore,after,last,liveBytes,shards,tables,summaries,removedTransientPieces:removed,finals,linearDense720LiveBytes:liveBytes*720,linearDense720Excludes:'network, identity/metadata, valuation, remaining protocols, shared dictionary reuse, WAL, temporary work, growth, backup and safety reserve'};
p.close();writeFileSync(outputPath,JSON.stringify(report,null,2));console.log(JSON.stringify({root,checks,liveBytes,shards,linearDense720LiveBytes:report.linearDense720LiveBytes,sampledHeapBytes:peakHeap,durationMs:report.durationMs}));
