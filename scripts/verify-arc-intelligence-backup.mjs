// Real-evidence backup acceptance for the isolated reduced network-hour DB. No production/remote service.
import assert from 'node:assert/strict';
import { mkdtempSync,mkdirSync,readFileSync,writeFileSync,existsSync,rmSync,statSync,statfsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { gunzipSync } from 'node:zlib';
import { openPipeline,inspectCapacity,directoryBytes,hash,assertHeapBudget } from '../server/intelligence-pipeline/storage.js';
import { verifyNetworkSeal } from '../server/intelligence-pipeline/network-hour-store.js';
import { backupPipeline,restorePipeline } from '../server/intelligence-pipeline/backup.js';
const [path,reportPath]=process.argv.slice(2);if(!path?.startsWith('/tmp/arc-reduced-real-hour-')||!reportPath?.startsWith('/tmp/'))throw Error('isolated_real_evidence_paths_required');
const heapBudget=assertHeapBudget();
const root=mkdtempSync(join(tmpdir(),'arc-real-backup-')),target=join(root,'backup'),restored=join(root,'restored');mkdirSync(target);mkdirSync(restored);
const p=openPipeline({path,verifySeal:verifyNetworkSeal});let peakDisk=0,peakHeap=0,checks=0;
const capacity=()=>{const fs=statfsSync(root,{bigint:true});return {usedBytes:directoryBytes(root)+directoryBytes(p.directory),freeBytes:Number(fs.bavail*fs.bsize)};};
const guard=plannedBytes=>{const c=inspectCapacity({capacity,knownOtherBytes:1978695680,volumeLimitBytes:4838498304,plannedBytes});if(!c.ok)throw Object.assign(Error(c.reason),{code:c.reason});peakDisk=Math.max(peakDisk,c.usedBytes);peakHeap=Math.max(peakHeap,process.memoryUsage().heapUsed);};
let verifiedHours=0;
const verify=db=>{
 for(const s of db.prepare('SELECT * FROM arc_pipeline_sources').iterate())assert.equal(hash(s.definition_json),s.source_key);
 for(const r of db.prepare('SELECT * FROM arc_pipeline_seals').iterate()){
  const raw=gunzipSync(r.payload_gzip,{maxOutputLength:8*1024*1024});assert.equal(hash(raw),r.seal_sha);const seal=JSON.parse(raw),u=db.prepare('SELECT * FROM arc_pipeline_units WHERE unit_id=?').get(r.unit_id);verifyNetworkSeal(db,seal,u);
  for(const segment of seal.segments){const j=db.prepare('SELECT * FROM arc_pipeline_jobs WHERE unit_id=? AND first_block=? AND last_block=?').get(r.unit_id,segment.first,segment.last);assert.equal(j.state,'complete');assert.equal(j.expected_sha,segment.resultSha);}verifiedHours++;
 }
};
const start=performance.now();let result;
try{
 const saved=await backupPipeline(p,{targetDirectory:target,guard}),destination=join(restored,'empty.sqlite');checks++;
 const out=await restorePipeline({manifestPath:saved.manifestPath,expectedManifestSha:saved.manifestSha,destination,guard,verifyDatabase:verify});assert(out.restored);assert(verifiedHours>0);checks++;
 const q=openPipeline({path:destination,verifySeal:verifyNetworkSeal});const unit=q.db.prepare('SELECT unit_id FROM arc_pipeline_seals LIMIT 1').get().unit_id;assert.equal(q.coverage(unit).status,'complete');assert.equal(q.claim(),null);q.close();checks++;
 const before=hash(readFileSync(destination));await assert.rejects(restorePipeline({manifestPath:saved.manifestPath,expectedManifestSha:saved.manifestSha,destination,guard,verifyDatabase:verify}),e=>e.code==='restore_requires_empty_destination');assert.equal(hash(readFileSync(destination)),before);checks++;
 await assert.rejects(restorePipeline({manifestPath:saved.manifestPath,expectedManifestSha:'f'.repeat(64),destination:join(restored,'bad-manifest.sqlite'),guard,verifyDatabase:verify}),e=>e.code==='backup_manifest_corrupt');checks++;
 const manifest=JSON.parse(readFileSync(saved.manifestPath)),part=join(target,manifest.parts[0].name),original=readFileSync(part),changed=Buffer.from(original);changed[10]^=1;writeFileSync(part,changed);
 const bad=join(restored,'bad-part.sqlite');await assert.rejects(restorePipeline({manifestPath:saved.manifestPath,expectedManifestSha:saved.manifestSha,destination:bad,guard,verifyDatabase:verify}),e=>e.code==='backup_part_corrupt');assert(!existsSync(bad));writeFileSync(part,original);checks++;
 const low=join(restored,'low-capacity.sqlite');await assert.rejects(restorePipeline({manifestPath:saved.manifestPath,expectedManifestSha:saved.manifestSha,destination:low,guard:()=>{throw Error('storage_low_space')},verifyDatabase:verify}),/storage_low_space/);assert(!existsSync(low));checks++;
 const interrupted=join(restored,'interrupted.sqlite');await assert.rejects(restorePipeline({manifestPath:saved.manifestPath,expectedManifestSha:saved.manifestSha,destination:interrupted,guard,verifyDatabase:()=>{throw Error('simulated_interruption')}}),/simulated_interruption/);assert(!existsSync(interrupted));
 const retry=await restorePipeline({manifestPath:saved.manifestPath,expectedManifestSha:saved.manifestSha,destination:interrupted,guard,verifyDatabase:verify});assert(retry.restored);checks++;
 const repeated=await backupPipeline(p,{targetDirectory:target,guard});assert.equal(repeated.manifestSha,saved.manifestSha);assert.equal(repeated.storedPartBytes,saved.storedPartBytes);checks++;
 result={scope:'real network-hour evidence only; not full 84-field or off-volume production backup acceptance',checks,node:process.version,heapBudget,source:path,backup:saved,restore:out,verifiedNetworkHours:verifiedHours,sourceDictionaryEntries:p.db.prepare('SELECT COUNT(*) n FROM arc_pipeline_addresses').get().n,peakManagedBytesIncludingSnapshotAndRestore:peakDisk,peakSampledHeapBytes:peakHeap,maxRSSBytes:process.resourceUsage().maxRSS*1024,durationMs:Math.round(performance.now()-start),newPaidServices:0,productionAccess:false,independentPhysicalStorageProven:false,files:root};
 writeFileSync(reportPath,JSON.stringify(result,null,2));console.log(JSON.stringify(result));
}finally{p.close();}
