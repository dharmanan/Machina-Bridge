// Actual dense-hour DEX proofs: local snapshot, empty restore and deterministic derived-data repair.
import assert from 'node:assert/strict';
import { mkdtempSync,mkdirSync,readFileSync,writeFileSync,statfsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { gunzipSync } from 'node:zlib';
import { openPipeline,hash,directoryBytes,inspectCapacity,assertHeapBudget } from '../server/intelligence-pipeline/storage.js';
import { backupPipeline,restorePipeline } from '../server/intelligence-pipeline/backup.js';
import { deriveDexFamily } from '../server/intelligence-pipeline/dex-family.js';
const [reportInput,reportOutput]=process.argv.slice(2);if(!reportInput?.startsWith('/tmp/machina-inventory/')||!reportOutput?.startsWith('/tmp/'))throw Error('isolated_lab_reports_required');
const input=JSON.parse(readFileSync(reportInput));if(!input.complete||!input.directory?.startsWith('/tmp/arc-dex-reduced-real-')||!input.streams.every(s=>s.derivedFamily))throw Error('actual_derived_family_proofs_required');
const heapBudget=assertHeapBudget(),p=openPipeline({path:join(input.directory,'reduced.sqlite')});
const root=mkdtempSync(join(tmpdir(),'arc-dex-real-backup-')),target=join(root,'backup'),restored=join(root,'restored');mkdirSync(target);mkdirSync(restored);let peakDisk=0,peakHeap=0,checks=0;
const guard=plannedBytes=>{const fs=statfsSync(root,{bigint:true}),c=inspectCapacity({knownOtherBytes:1978695680,volumeLimitBytes:4838498304,plannedBytes,capacity:()=>({usedBytes:directoryBytes(root)+directoryBytes(p.directory),freeBytes:Number(fs.bavail*fs.bsize)})});if(!c.ok)throw Error(c.reason);peakDisk=Math.max(peakDisk,c.usedBytes);peakHeap=Math.max(peakHeap,process.memoryUsage().heapUsed);};
const verify=db=>{
 for(const r of db.prepare('SELECT * FROM arc_pipeline_sources').iterate())assert.equal(hash(r.definition_json),r.source_key);
 for(const r of db.prepare('SELECT * FROM arc_pipeline_units').iterate())assert.equal(hash(r.unit_json),r.unit_id);
 for(const r of db.prepare('SELECT * FROM arc_pipeline_results').iterate()){const raw=gunzipSync(r.payload_gzip,{maxOutputLength:8*1024*1024});assert.equal(raw.length,r.plain_bytes);assert.equal(hash(raw),r.result_sha);JSON.parse(raw);}
 for(const r of db.prepare('SELECT * FROM arc_pipeline_fact_rows').iterate())assert.equal(hash(r.payload_json),r.payload_sha);
 for(const j of db.prepare("SELECT * FROM arc_pipeline_jobs WHERE state='complete'").iterate()){assert.equal(j.expected_sha,j.result_sha);assert(db.prepare('SELECT 1 FROM arc_pipeline_results WHERE result_sha=?').get(j.result_sha));}
};
const start=performance.now();
try{
 const saved=await backupPipeline(p,{targetDirectory:target,guard});checks++;
 const out=await restorePipeline({manifestPath:saved.manifestPath,expectedManifestSha:saved.manifestSha,destination:join(restored,'empty.sqlite'),guard,verifyDatabase:verify});checks++;
 const q=openPipeline({path:out.destination}),derived=[];
 try{
  for(const s of input.streams){const args=s.stream==='v3Pools'?{baseUnit:s.unitId,supplementUnits:s.incrementalCorrection.addedUnitIds,factoryUnit:s.incrementalCorrection.factoryUnitId,protocol:'uniswap_v3'}:{baseUnit:s.unitId,protocol:'uniswap_v4'};
    const ready=deriveDexFamily(q,args);assert.equal(ready.unitId,s.derivedFamily.unitId);assert.deepEqual(ready.metrics,s.derivedFamily.metrics);checks++;
    const old=q.db.prepare('SELECT result_sha FROM arc_pipeline_jobs WHERE unit_id=?').get(ready.unitId).result_sha;
    q.db.prepare('DELETE FROM arc_pipeline_results WHERE result_sha=?').run(old);assert.equal(q.audit().repairQueued,1);const repaired=deriveDexFamily(q,args);assert.equal(repaired.unitId,ready.unitId);assert.deepEqual(repaired.metrics,ready.metrics);checks++;
    derived.push({protocol:args.protocol,metrics:ready.metrics,restoredAndRepairedWithoutRpc:true});
  }
 }finally{q.close();}
 const report={scope:'actual one-hour V3/V4 family proofs; local backup only, not independent remote backup or all 84-field acceptance',checks,heapBudget,backup:saved,restore:out,derived,peakManagedBytes:peakDisk,peakSampledHeapBytes:peakHeap,maxRSSBytes:process.resourceUsage().maxRSS*1024,durationMs:Math.round(performance.now()-start),rpcRequests:0,productionAccess:false,offVolumeDurability:false};writeFileSync(reportOutput,JSON.stringify(report,null,2));console.log(JSON.stringify(report));
}finally{p.close();}
