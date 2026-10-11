// Read-only accepted real source inputs, independent final-only SQLite target. No RPC or production access.
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,writeFileSync,statSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openPipeline,hash,assertHeapBudget,readDefinition,directoryBytes} from '../server/intelligence-pipeline/storage.js';
import {deriveDexUiProjections} from '../server/intelligence-pipeline/dex-projection-source.js';
import {createDexUiHourStore,verifyDexUiSeal} from '../server/intelligence-pipeline/dex-ui-hour-store.js';
const [v3Path,v4Path,reportPath]=process.argv.slice(2);
if(!v3Path?.startsWith('/tmp/arc-dex-ui-real-')||!v4Path?.startsWith('/tmp/arc-dex-ui-real-')||!reportPath?.startsWith('/tmp/'))throw Error('independent_paths_required');
const root=mkdtempSync(join(tmpdir(),'arc-ui-final-real-')),path=join(root,'results.sqlite');let p=openPipeline({path,create:true,verifySeal:verifyDexUiSeal});
const hashes=[v3Path,v4Path].map(x=>hash(readFileSync(x))),report={root,path,scope:'one actual dense hour, final UI-only storage; not 720 distinct hours or all 84 fields',
 productionAccess:false,rpcRequests:0,rawArchive:false,heapBudget:assertHeapBudget(),protocols:[]};let peak=0;
const sample=()=>{peak=Math.max(peak,process.memoryUsage().heapUsed);};const started=performance.now();
try{let i=0;for(const sourcePath of [v3Path,v4Path]){
 const source=openPipeline({path:sourcePath,readOnly:true});try{
  const unit=source.db.prepare('SELECT unit_id,unit_json FROM arc_pipeline_units').all().find(x=>JSON.parse(readDefinition(x.unit_json)).source.definition==='verified-dex-ui-projection-pieces-v1').unit_id;
  const expected=deriveDexUiProjections(source,unit);sample();const result=createDexUiHourStore(p).publish(unit,{evidenceSource:source});sample();
  const actual=deriveDexUiProjections(p,unit);sample();assert.deepEqual(actual,expected);assert.equal(p.claim({unitId:unit}),null);
  p.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');report.protocols.push({protocol:result.summary.protocol,unitId:unit,family:actual.family,
   counts:Object.fromEntries(Object.entries(actual.projections).map(([k,x])=>[k,{rows:x.rows.length,registry:x.registry?.length??null,sha256:x.rowsSha256}])),
   exactRoundTrip:true,sourceFileUnchanged:hash(readFileSync(sourcePath))===hashes[i++],sqliteBytesAfter:statSync(path).size});
 }finally{source.close();}}
 const digests=report.protocols.map(x=>hash(deriveDexUiProjections(p,x.unitId)));p.close();p=openPipeline({path,readOnly:true,verifySeal:verifyDexUiSeal});
 for(let i=0;i<digests.length;i++){assert.equal(hash(deriveDexUiProjections(p,report.protocols[i].unitId)),digests[i]);sample();}
 assert.equal(p.db.prepare('SELECT count(*) n FROM arc_pipeline_results').get().n,0);
 report.tableBytes=p.db.prepare("SELECT name,sum(pgsize) bytes FROM dbstat GROUP BY name ORDER BY bytes DESC").all();
 report.sqliteBytes=statSync(path).size;report.directoryAllocatedBytes=directoryBytes(root);report.restartAdditionalRpcRequests=0;
 report.complete=true;report.sampledHeapBytes=peak;report.durationMs=Math.round(performance.now()-started);
 report.sevenHundredTwentyHourProjectionBytes=report.sqliteBytes*720;
 report.capacityCaveat='Multiplication of one real dense hour is a planning upper sample, not a measured 720-distinct-hour capacity proof. Stable pool dictionaries can share, but historical novel pools and missing components are excluded.';
}catch(e){report.complete=false;report.error=e.code??e.message;process.exitCode=1;}finally{p.close();writeFileSync(reportPath,JSON.stringify(report,null,2));console.log(JSON.stringify(report));}
