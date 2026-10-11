// Physically write 720 independent copies of one REAL dense-hour reduced workload, with durable dictionaries once.
// This is a representative storage stress workload, NOT 720 distinct mainnet hours or all-84-field GO.
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync,writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openPipeline,hash,assertHeapBudget } from '../server/intelligence-pipeline/storage.js';
import { createResultObjects } from '../server/intelligence-pipeline/result-objects.js';
const [path,output]=process.argv.slice(2);
if(!path?.startsWith('/tmp/arc-dex-shared-')||!output?.startsWith('/tmp/'))throw Error('isolated_result_paths_required');
const source=new DatabaseSync(path,{readOnly:true});source.exec('PRAGMA query_only=ON; PRAGMA cache_size=-2048');
const root=mkdtempSync(join(tmpdir(),'arc-shared-capacity-'));
const budgets={safetyBytes:536870912,liveGrowthBytes:268435456,walBytes:134217728,tempBytes:134217728};
const used=1981427712,volume=4838498304,apiMembershipCacheBytes=51257344;
const p=openPipeline({path:join(root,'capacity.sqlite'),create:true,knownOtherBytes:used+budgets.liveGrowthBytes+budgets.walBytes+budgets.tempBytes+apiMembershipCacheBytes,volumeLimitBytes:volume});
const objects=createResultObjects(p),streams=[['arc_pipeline_dex_shards','sha','payload_gzip',false],['arc_pipeline_seals','unit_id','payload_gzip',false],
  ['arc_pipeline_results','result_sha','payload_gzip',false],['arc_pipeline_sources','source_key','definition_json',true],['arc_pipeline_units','unit_id','unit_json',true],['arc_pipeline_jobs','job_id',null,true]];
for(let kind=0;kind<streams.length;kind++)p.transaction(()=>p.db.prepare('INSERT INTO arc_pipeline_object_kinds VALUES(?,?)').run(kind,streams[kind][0]));
// Exact existing ID maps are part of the cost and cannot be silently discarded or renumbered.
for(const table of ['arc_pipeline_addresses','arc_pipeline_stable_symbols']){
  const schema=source.prepare('SELECT sql FROM sqlite_schema WHERE name=?').get(table).sql;p.transaction(()=>p.db.exec(schema));
  const columns=source.prepare(`PRAGMA table_info(${table})`).all().map(r=>r.name),put=p.db.prepare(`INSERT INTO ${table} VALUES(${columns.map(()=>'?').join(',')})`);
  p.transaction(()=>{for(const row of source.prepare(`SELECT * FROM ${table}`).iterate())put.run(...columns.map(k=>row[k]));},4*1024*1024);
}
const started=performance.now();let copies=0,checks=0,peakHeap=0,peakWal=0,error=null;
try{
  for(let hour=0;hour<720;hour++){
    p.transaction(()=>{
      for(let kind=0;kind<streams.length;kind++){
        const[table,key,column,compress]=streams[kind];
        for(const row of source.prepare(`SELECT * FROM ${table}`).iterate()){
          const value=column?row[column]:JSON.stringify(row),raw=typeof value==='string'?Buffer.from(value):Buffer.from(value);
          objects.put(hour,kind,Buffer.from(row[key],'hex'),raw,{compress});
        }
      }
    },4*1024*1024);copies++;
    peakHeap=Math.max(peakHeap,process.memoryUsage().heapUsed);peakWal=Math.max(peakWal,p.metrics().walBytes);
    if(copies%120===0)console.log(JSON.stringify({copies,physical:p.metrics().databaseBytes,heap:peakHeap}));
  }
  for(const hour of [0,359,719])for(let kind=0;kind<streams.length;kind++){
    const[table,key,column]=streams[kind];
    for(const row of source.prepare(`SELECT * FROM ${table}`).iterate()){
      const value=column?row[column]:JSON.stringify(row),raw=typeof value==='string'?Buffer.from(value):Buffer.from(value);
      if(hash(objects.read(hour,kind,Buffer.from(row[key],'hex')))!==hash(raw))throw Error('object_roundtrip_mismatch');checks++;
    }
  }
}catch(e){error=e.code??e.message;}
p.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');const metrics=p.metrics();
const reserve=Object.values(budgets).reduce((n,x)=>n+x,0),remaining=volume-used-reserve-apiMembershipCacheBytes-metrics.databaseBytes;
const report={root,hourCopies:copies,realDistinctHours:1,checks,error,metrics,peakWal,peakHeap,heapBudget:assertHeapBudget(),durationMs:Math.round(performance.now()-started),
  ownerInventory:{capacity:volume,used,free:volume-used},budgets,measuredApiMembershipCacheBytes:apiMembershipCacheBytes,
  availableForMissingComponentsBytes:remaining,oldDexFixtureBytes:1767297024,measuredDexFixtureSavingsBytes:1767297024-metrics.databaseBytes,
  exclusions:['Network seals and address novelty beyond this existing DEX dictionary','Additional protocol results and source evidence','Signed pool/price/fee/valuation outputs','Discovery/launch metadata and provenance','720 actual distinct-hour growth'],
  all84FieldsCapacityProven:false,productionAccess:false,backupsCreated:false,rpcRequests:0};
p.close();source.close();writeFileSync(output,JSON.stringify(report,null,2));console.log(JSON.stringify(report));
