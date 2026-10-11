// Independent compact-metadata snapshot; accepted source/unit identity and evidence remain unchanged.
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync,readFileSync,writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openPipeline,hash,readDefinition,storeDefinition,assertHeapBudget } from '../server/intelligence-pipeline/storage.js';
import { createDexHourStore,verifyDexSeal,readDexSealSummaries } from '../server/intelligence-pipeline/dex-hour-store.js';
import { deriveDexFamily } from '../server/intelligence-pipeline/dex-family.js';
const [inputPath,outputPath]=process.argv.slice(2);if(!inputPath?.startsWith('/tmp/')||!outputPath?.startsWith('/tmp/'))throw Error('isolated_lab_paths_required');
const input=JSON.parse(readFileSync(inputPath));assert(input.root.startsWith('/tmp/arc-dex-compact-proof-'));
const original=new DatabaseSync(join(input.root,'reduced.sqlite'),{readOnly:true}),root=mkdtempSync(join(tmpdir(),'arc-dex-compact-proof-')),path=join(root,'reduced.sqlite');
const opts={path,verifySeal:verifyDexSeal,readSealSummaries:readDexSealSummaries,compactDefinitions:true};let p=openPipeline({...opts,create:true});createDexHourStore(p);let checks=0;
const tables=['arc_pipeline_sources','arc_pipeline_units','arc_pipeline_results','arc_pipeline_jobs','arc_pipeline_failures','arc_pipeline_addresses','arc_pipeline_dex_shards','arc_pipeline_seals'];
p.transaction(()=>{
 for(const table of tables){const keys=original.prepare(`PRAGMA table_info(${table})`).all().map(r=>r.name),insert=p.db.prepare(`INSERT INTO ${table}(${keys.join(',')}) VALUES(${keys.map(()=>'?').join(',')})`);
  for(const r of original.prepare(`SELECT * FROM ${table}`).iterate()){
   if(table==='arc_pipeline_sources'){const text=readDefinition(r.definition_json);assert.equal(hash(text),r.source_key);r.definition_json=storeDefinition(text);}
   if(table==='arc_pipeline_units'){const text=readDefinition(r.unit_json);assert.equal(hash(text),r.unit_id);r.unit_json=storeDefinition(text);}
   insert.run(...keys.map(k=>r[k]));checks++;
  }
 }
},input.liveBytes);
for(const t of ['arc_pipeline_sources','arc_pipeline_units'])for(const r of p.db.prepare(`SELECT * FROM ${t}`).iterate()){const col=t.endsWith('sources')?'definition_json':'unit_json',key=t.endsWith('sources')?'source_key':'unit_id';assert.equal(readDefinition(r[col]),readDefinition(original.prepare(`SELECT ${col} FROM ${t} WHERE ${key}=?`).get(r[key])[col]));checks++;}
// Durable factory facts regenerate from immutable results; the duplicative cache can then expire safely.
const factory=p.db.prepare("SELECT unit_id FROM arc_pipeline_units WHERE source_key IN(SELECT source_key FROM arc_pipeline_sources)").all().find(r=>JSON.parse(readDefinition(p.db.prepare('SELECT unit_json FROM arc_pipeline_units WHERE unit_id=?').get(r.unit_id).unit_json)).source.id==='uniswap_v3_factory').unit_id;
const audit=p.audit();assert.equal(audit.repairQueued,0);assert.equal(p.db.prepare('SELECT count(*) n FROM arc_pipeline_fact_rows WHERE unit_id=?').get(factory).n,320);checks++;
assert.equal(p.expireFactCache(factory).verifiedFacts,320);assert.equal(p.db.prepare('SELECT count(*) n FROM arc_pipeline_fact_rows').get().n,0);checks++;
for(const f of input.finals){const args=f.metrics.poolCreatedCount!==undefined?{baseUnit:f.dependencies[0],supplementUnits:f.dependencies.slice(1,-1),factoryUnit:f.dependencies.at(-1),protocol:'uniswap_v3'}:{baseUnit:f.dependencies[0],protocol:'uniswap_v4'};const result=deriveDexFamily(p,args);assert.equal(result.unitId,f.unitId);assert.deepEqual(result.metrics,f.metrics);checks++;}
assert.equal(p.db.prepare('PRAGMA integrity_check').get().integrity_check,'ok');assert.equal(p.db.prepare('PRAGMA foreign_key_check').all().length,0);checks++;
p.close();p=openPipeline(opts);for(const id of input.summaries.map(s=>s.unitId))assert.equal(p.coverage(id).status,'complete');checks++;const last=p.metrics();
const report={...input,root,scope:input.scope+' Compact source definitions retain exact original checksums; duplicate factory cache safely expires.',checks,definitionChecks:checks,liveBytes:(last.pageCount-last.freelistCount)*last.pageSize,last,tables:p.db.prepare('SELECT name,sum(pgsize) bytes FROM dbstat GROUP BY name ORDER BY bytes DESC').all(),compactDefinitions:true,productionAccess:false,rpcRequests:0,heapBudget:assertHeapBudget(),sampledHeapBytes:process.memoryUsage().heapUsed};
p.close();original.close();writeFileSync(outputPath,JSON.stringify(report,null,2));console.log(JSON.stringify({root,checks,liveBytes:report.liveBytes,heapUsed:report.sampledHeapBytes}));
