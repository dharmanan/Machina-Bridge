// Actual compact dense-hour evidence: consistent local snapshot, empty restore, exact missing-shard repair.
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync,mkdirSync,readFileSync,writeFileSync,statfsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openPipeline,readDefinition,hash,inspectCapacity,directoryBytes,assertHeapBudget } from '../server/intelligence-pipeline/storage.js';
import { verifyDexSeal,readDexSealSummaries,restoreDexShard } from '../server/intelligence-pipeline/dex-hour-store.js';
import { backupPipeline,restorePipeline } from '../server/intelligence-pipeline/backup.js';
import { deriveDexFamily } from '../server/intelligence-pipeline/dex-family.js';
const [inputPath,outputPath]=process.argv.slice(2);if(!inputPath?.startsWith('/tmp/')||!outputPath?.startsWith('/tmp/'))throw Error('isolated_lab_paths_required');
const input=JSON.parse(readFileSync(inputPath));if(!input.compactDefinitions||!input.root.startsWith('/tmp/arc-dex-compact-proof-'))throw Error('actual_compact_evidence_required');
const opts={verifySeal:verifyDexSeal,readSealSummaries:readDexSealSummaries,compactDefinitions:true},p=openPipeline({...opts,path:join(input.root,'reduced.sqlite')}),root=mkdtempSync(join(tmpdir(),'arc-compact-backup-'));mkdirSync(join(root,'backup'));mkdirSync(join(root,'restore'));let peakHeap=0,peakDisk=0;
const guard=plannedBytes=>{const fs=statfsSync(root,{bigint:true});peakHeap=Math.max(peakHeap,process.memoryUsage().heapUsed);const used=directoryBytes(root)+directoryBytes(p.directory);peakDisk=Math.max(peakDisk,used);const c=inspectCapacity({volumeLimitBytes:4838498304,knownOtherBytes:1978695680,plannedBytes,capacity:()=>({usedBytes:used,freeBytes:Number(fs.bavail*fs.bsize)})});if(!c.ok)throw Error(c.reason);};
let checks=0;
try{
 const saved=await backupPipeline(p,{targetDirectory:join(root,'backup'),guard});checks++;
 const restored=await restorePipeline({manifestPath:saved.manifestPath,expectedManifestSha:saved.manifestSha,destination:join(root,'restore','empty.sqlite'),guard,verifyDatabase:db=>{for(const r of db.prepare('SELECT * FROM arc_pipeline_sources').iterate())assert.equal(hash(readDefinition(r.definition_json)),r.source_key);for(const r of db.prepare('SELECT * FROM arc_pipeline_units').iterate())assert.equal(hash(readDefinition(r.unit_json)),r.unit_id);}});checks++;
 const q=openPipeline({...opts,path:restored.destination});try{
  for(const s of input.summaries){assert.equal(q.coverage(s.unitId).status,'complete');assert.deepEqual([...q.summaries(s.unitId)],[...p.summaries(s.unitId)]);checks++;}
  for(const f of input.finals){const args=f.metrics.poolCreatedCount!==undefined?{baseUnit:f.dependencies[0],supplementUnits:f.dependencies.slice(1,-1),factoryUnit:f.dependencies.at(-1),protocol:'uniswap_v3'}:{baseUnit:f.dependencies[0],protocol:'uniswap_v4'};assert.deepEqual(deriveDexFamily(q,args).metrics,f.metrics);checks++;}
  const unitId=input.summaries.find(s=>s.protocol==='uniswap_v4').unitId,sha=q.getSeal(unitId).summary.shards[0];q.db.prepare('DELETE FROM arc_pipeline_dex_shards WHERE sha=?').run(sha);assert.equal(q.coverage(unitId).status,'partial');restoreDexShard(q,{unitId,sha},p.db);assert.equal(q.coverage(unitId).status,'complete');checks++;
  assert.equal(q.db.prepare('PRAGMA integrity_check').get().integrity_check,'ok');checks++;
 }finally{q.close();}
 const report={scope:'Actual compact dense-hour DEX snapshot/empty restore and narrowly bounded missing-object repair; local only, no independent remote durability',checks,root,backup:saved,restore:restored,peakManagedBytes:peakDisk,sampledHeapBytes:peakHeap,heapBudget:assertHeapBudget(),maxRSSBytes:process.resourceUsage().maxRSS*1024,rpcRequests:0,productionAccess:false,offVolumeDurability:false};writeFileSync(outputPath,JSON.stringify(report,null,2));console.log(JSON.stringify(report));
}finally{p.close();}
