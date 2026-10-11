// Real mainnet source pieces in isolated SQLite, fixed existing provider budgets, no production or backup operations.
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openPipeline, hash, assertHeapBudget } from '../server/intelligence-pipeline/storage.js';
import { dexProjectionSource, createDexProjectionProcessor, deriveDexUiProjections } from '../server/intelligence-pipeline/dex-projection-source.js';
import { runBoundedUnit } from '../server/intelligence-pipeline/worker.js';
import { evidenceJson } from '../server/compact/discovery-evidence.js';
import { boundedRecoveryProvider } from './recover-compact-discovery.mjs';
import { providerDiagnostics } from '../server/compact/provider.js';
import { verifyDexSeal,readDexSealSummaries } from '../server/intelligence-pipeline/dex-hour-store.js';
import { readDefinition } from '../server/intelligence-pipeline/storage.js';
const [referencePath,reportPath,protocol='uniswap_v4',resumeRoot] = process.argv.slice(2);
if (!referencePath?.startsWith('/tmp/machina-recovery-proof/') || !reportPath?.startsWith('/tmp/')
  || resumeRoot && !resumeRoot.startsWith('/tmp/arc-dex-ui-real-')) throw Error('isolated_paths_required');
const input=new DatabaseSync(referencePath,{readOnly:true});input.exec('PRAGMA query_only=ON; PRAGMA cache_size=-2048');
const hour=input.prepare('SELECT * FROM compact_hours WHERE hour_start=?').get(Date.parse('2026-09-16T12:00Z')/1000);
const first=input.prepare("SELECT key FROM compact_meta WHERE key GLOB 'discovery_spine_block:*' ORDER BY key LIMIT 1").get();
const prefix=first.key.slice(0,first.key.lastIndexOf(':')+1),get=input.prepare('SELECT value FROM compact_meta WHERE key=?');
const saved=n=>JSON.parse(get.get(prefix+String(n).padStart(16,'0'))?.value??'null');
const block=n=>{
  const value=saved(n), previous=n===hour.first_block?null:saved(n-1);
  if(!value)throw Error('canonical_spine_missing'); const {checksum,...body}=value;
  if(hash(evidenceJson(body))!==checksum||body.previousDigest!==(previous?.checksum??null)
    ||body.identity.canonical!==hour.network_sha256||body.block.number!==n
    ||body.block.parentHash!==(previous?.block.hash??hour.parent_hash)||body.block.timestamp<hour.hour_start||body.block.timestamp>=hour.hour_start+3600)throw Error('canonical_spine_conflict');
  return body.block;
};
const official=input.prepare("SELECT created_block FROM compact_registry WHERE kind='uniswap_v3_pool' AND address=?");
const currentFactory=new Map();
if(protocol==='uniswap_v3'){
  const dex=openPipeline({path:'/tmp/arc-dex-compact-proof-C6fn0m/reduced.sqlite',readOnly:true,verifySeal:verifyDexSeal,readSealSummaries:readDexSealSummaries});
  for(const u of dex.db.prepare('SELECT unit_id,unit_json FROM arc_pipeline_units WHERE hour_start=?').iterate(hour.hour_start)){
    const definition=JSON.parse(readDefinition(u.unit_json)).source;
    if(definition.id!=='uniswap_v3_factory')continue;
    if(dex.coverage(u.unit_id).status!=='complete'||definition.chainId!==5042)throw Error('factory_source_unverified');
    for(const piece of dex.summaries(u.unit_id))for(const row of piece.rows){
      if(row.kind!=='official_v3_pool_created'||row.sourceKey!==hash(definition)||row.blockHash!==block(row.createdBlock).hash)throw Error('factory_canonical_conflict');
      currentFactory.set(row.address,row.createdBlock);
    }
  }dex.close();
}
const root=resumeRoot??mkdtempSync(join(tmpdir(),'arc-dex-ui-real-'));let clock=Date.now(),p;
const open=()=>openPipeline({path:join(root,'result.sqlite'),create:!resumeRoot&&!p,now:()=>clock,knownOtherBytes:1981427712,volumeLimitBytes:4838498304});p=open();
const unitId=p.defineUnit({source:dexProjectionSource(protocol),first:hour.first_block,last:hour.last_block,hourStart:hour.hour_start,
  anchorHash:hour.last_hash,registryDigest:hash(dexProjectionSource(protocol))},{chunkBlocks:64});
const processor=createDexProjectionProcessor({protocol,loadVerifiedBlock:block,isOfficialV3:log=>(official.get(log.address)?.created_block??currentFactory.get(log.address))<=log.blockNumber});
const report=resumeRoot?JSON.parse(readFileSync(reportPath)):{root,unitId,protocol,hour:new Date(hour.hour_start*1000).toISOString(),runs:[],
  scope:'Real full-hour signed pool flows, price paths, applied fees and capped Activity source; not all 84 fields or 720 hours',
  heapBudget:assertHeapBudget(),productionAccess:false,backupsCreated:false,rawResponsesPersisted:false};
delete report.error;let maxResponse=report.maximumResponseBytes??0,heap=report.sampledHeapBytes??0,interrupted=!!resumeRoot;
const previousDuration=report.durationMs??0,previousRSS=report.maxRSSBytes??0,previousRequests=report.runs.reduce((n,x)=>n+x.usage.requests,0);
const sampled=setInterval(()=>{heap=Math.max(heap,process.memoryUsage().heapUsed);},10);sampled.unref();
const started=performance.now();
try{
  for(let run=0;run<8&&p.coverage(unitId).status!=='complete';run++){
    const bounded=boundedRecoveryProvider({fetchImpl:async(url,options)=>{
      const response=await fetch(url,options),reader=response.body.getReader();let size=0;
      return {ok:response.ok,status:response.status,body:new ReadableStream({async pull(c){try{const r=await reader.read();if(r.done){maxResponse=Math.max(maxResponse,size);c.close();}else{size+=r.value.byteLength;c.enqueue(r.value);}}catch(e){c.error(e);}},cancel:reason=>reader.cancel(reason)})};
    }}),before=p.db.prepare("SELECT COUNT(*) n FROM arc_pipeline_jobs WHERE unit_id=? AND state='complete'").get(unitId).n;
    try{
      const header=await bounded.provider.request('eth_getBlockByNumber',['0x'+hour.last_block.toString(16),false]);assert.equal(header.hash,hour.last_hash);
      const result=await runBoundedUnit(p,{unitId,bounded,processJob:processor,afterAccept(){heap=Math.max(heap,process.memoryUsage().heapUsed);
        if(!interrupted){interrupted=true;throw Object.assign(Error('intentional_lab_restart'),{code:'intentional_lab_restart'});}}});
      report.runs.push({...result,previouslyCompletePieces:before});
      if(result.reason&&!['bounded_run_yield','recovery_response_budget_exhausted','recovery_rpc_budget_exhausted','recovery_time_budget_exhausted','suspect_log_result_count','range_too_large','too_many_results','reduced_summary_too_large'].includes(result.reason))break;
    }catch(e){report.runs.push({reason:e.code??e.message,usage:{...bounded.stats},diagnostics:providerDiagnostics(e),previouslyCompletePieces:before});if(e.code!=='intentional_lab_restart')throw e;}
    finally{bounded.close();}
    writeFileSync(reportPath,JSON.stringify(report,null,2));p.close();clock+=61000;p=open();
  }
  report.coverage=p.coverage(unitId);
  if(report.coverage.status==='complete'){
    const out=deriveDexUiProjections(p,unitId),expected=JSON.parse(input.prepare('SELECT metrics_json FROM compact_family_hours WHERE hour_start=? AND family=?').get(hour.hour_start,protocol==='uniswap_v3'?'uniswapV3':'uniswapV4').metrics_json);
    for(const k of (protocol==='uniswap_v3'?['swapCount','mintCount','burnCount']:['swapCount','initializeCount','modifyLiquidityCount']))assert.equal(out.family[k],expected[k],k);
    const resultPath=join(root,'ui-projections.json');writeFileSync(resultPath,JSON.stringify(out));report.projectionsPath=resultPath;
    report.familyMatchCanonical=true;report.projectionCounts=Object.fromEntries(Object.entries(out.projections).map(([k,v])=>[k,{rows:v.rows.length,registry:v.registry?.length??null,sha256:v.rowsSha256}]));
    const currentRequests=report.runs.reduce((n,x)=>n+x.usage.requests,0);p.close();p=open();assert.equal(p.claim({unitId}),null);
    assert.deepEqual(deriveDexUiProjections(p,unitId),out);report.restartAdditionalRequests=0;report.currentRequests=currentRequests;
  }
  p.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');report.metrics=p.metrics();report.complete=report.coverage.status==='complete';
}catch(e){report.error=e.code??e.message;report.complete=false;process.exitCode=1;}
finally{clearInterval(sampled);Object.assign(report,{maximumResponseBytes:maxResponse,sampledHeapBytes:heap,maxRSSBytes:Math.max(previousRSS,process.resourceUsage().maxRSS*1024),
  durationMs:previousDuration+Math.round(performance.now()-started),invocationAdditionalRequests:report.runs.reduce((n,x)=>n+x.usage.requests,0)-previousRequests});
  writeFileSync(reportPath,JSON.stringify(report,null,2));console.log(JSON.stringify(report));p.close();input.close();}
