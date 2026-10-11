// Targeted, isolated real Arc mainnet log ingestion. Does not write the imported canonical DB.
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { mkdtempSync,writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openPipeline,assertHeapBudget,hash,json } from '../server/intelligence-pipeline/storage.js';
import { deriveDexFamily } from '../server/intelligence-pipeline/dex-family.js';
import { createV3FactoryProcessor } from '../server/intelligence-pipeline/v3-factory.js';
import { createDexLogProcessor } from '../server/intelligence-pipeline/dex-log-reducer.js';
import { runBoundedUnit } from '../server/intelligence-pipeline/worker.js';
import { LOG_STREAMS,FAMILY_VERSIONS } from '../server/compact/sources.js';
import { UNISWAP_REGISTRY } from '../api/_lib/arc-intelligence/uniswap.js';
import { evidenceJson } from '../server/compact/discovery-evidence.js';
import { boundedRecoveryProvider } from './recover-compact-discovery.mjs';
import { providerDiagnostics } from '../server/compact/provider.js';
const [inputPath,reportPath,resumeDirectory]=process.argv.slice(2);if(!inputPath?.startsWith('/tmp/machina-recovery-proof/')||!reportPath?.startsWith('/tmp/'))throw Error('isolated_proof_paths_required');
const heapBudget=assertHeapBudget(),input=new DatabaseSync(inputPath,{readOnly:true});input.exec('PRAGMA query_only=ON; PRAGMA cache_size=-2048');
const h=input.prepare('SELECT * FROM compact_hours WHERE hour_start=?').get(Date.parse('2026-09-16T12:00:00Z')/1000);if(!h)throw Error('target_hour_missing');
const first=input.prepare("SELECT key,value FROM compact_meta WHERE key GLOB 'discovery_spine_block:*' ORDER BY key LIMIT 1").get(),prefix=first.key.slice(0,first.key.lastIndexOf(':')+1),row=input.prepare('SELECT value FROM compact_meta WHERE key=?');
const blockKey=n=>prefix+String(n).padStart(16,'0'),identity=JSON.parse(first.value).identity;
const registryDigest=createHash('sha256');for(const r of input.prepare("SELECT * FROM compact_registry WHERE kind='uniswap_v3_pool' ORDER BY address").iterate())registryDigest.update(json(r)+'\n');const registryEvidenceSha=registryDigest.digest('hex');
const membership=input.prepare("SELECT created_block,created_log_index FROM compact_registry WHERE kind='uniswap_v3_pool' AND address=?");
function load(first,last){const window=new Map();let prior=first===h.first_block?null:JSON.parse(row.get(blockKey(first-1)).value),previousHash=prior?.block.hash??h.parent_hash;
 for(const r of input.prepare('SELECT value FROM compact_meta WHERE key>=? AND key<=? ORDER BY key').iterate(blockKey(first),blockKey(last))){const saved=JSON.parse(r.value),{checksum,...body}=saved,b=body.block;
  if(checksum!==hash(evidenceJson(body))||body.previousDigest!==(prior?.checksum??null)||hash(body.identity)!==hash(identity)||body.identity.canonical!==h.network_sha256||b.number!==first+window.size||b.parentHash!==previousHash)throw Error('canonical_spine_evidence_conflict');
  window.set(b.number,b);previousHash=b.hash;prior=saved;
 }return window;
}
if(resumeDirectory&&!resumeDirectory.startsWith('/tmp/arc-dex-reduced-real-'))throw Error('isolated_resume_directory_required');
const directory=resumeDirectory??mkdtempSync(join(tmpdir(),'arc-dex-reduced-real-'));
const open=create=>openPipeline({path:join(directory,'reduced.sqlite'),create,knownOtherBytes:1978695680,volumeLimitBytes:4838498304});let p=open(!resumeDirectory);
let peakHeap=0,maxResponse=0,peakDisk=0;const monitor=setInterval(()=>{peakHeap=Math.max(peakHeap,process.memoryUsage().heapUsed);},10);monitor.unref();
const downloaded=[];const provider=()=>boundedRecoveryProvider({fetchImpl:async(url,options)=>{const payload=JSON.parse(options.body);for(const c of [].concat(payload))if(c.method==='eth_getLogs')downloaded.push({filterSha:hash(c.params[0]),stream:c.params[0].address?.length===1&&c.params[0].address[0]===UNISWAP_REGISTRY.v4PoolManager.address?'v4':c.params[0].address?'v3Supplement':'v3Pools',first:c.params[0].fromBlock,last:c.params[0].toBlock});const res=await fetch(url,options);let bytes=0;const reader=res.body.getReader();return {ok:res.ok,status:res.status,body:new ReadableStream({async pull(c){try{const r=await reader.read();if(r.done){reader.releaseLock();maxResponse=Math.max(maxResponse,bytes);c.close();}else{bytes+=r.value.byteLength;c.enqueue(r.value);}}catch(e){c.error(e);}},cancel:r=>reader.cancel(r)})};}});
const report={scope:'V3/V4 raw event statistics only; not USD valuation, token discovery, all 84 fields or full 720-hour acceptance',hour:new Date(h.hour_start*1000).toISOString(),node:process.version,heapBudget,directory,runs:[],groupProgress:[],streams:[],productionAccess:false,fullBodyRpcCalls:0};const started=performance.now();
try{
 for(const key of ['v3Pools','v4']){
  const stream=LOG_STREAMS.find(s=>s.key===key),family=key==='v3Pools'?'uniswapV3':'uniswapV4',end='0x'+h.last_block.toString(16),address=key==='v3Pools'?UNISWAP_REGISTRY.v3Factory.address:UNISWAP_REGISTRY.v4PoolManager.address;
  if(input.prepare('SELECT value FROM compact_meta WHERE key=?').get('family_version:'+family)?.value!==FAMILY_VERSIONS[family])throw Error('source_version_conflict');
  const pre=provider();let codeSha;try{const header=await pre.provider.request('eth_getBlockByNumber',[end,false]);assert.equal(header.hash.toLowerCase(),h.last_hash);const code=await pre.provider.request('eth_getCode',[address,end]);assert(/^0x(?!0*$)[0-9a-f]+$/i.test(code));codeSha=hash(code);report.runs.push({stream:key,phase:'pinned_source_preflight',usage:{...pre.stats}});}finally{pre.close();}
  const source={id:key==='v3Pools'?'uniswap_v3_events':'uniswap_v4_events',definition:'bounded-dex-raw-statistics-v1',originalVersion:FAMILY_VERSIONS[family],chainId:5042,stream,codeAtBlock:h.last_block,codeSha,registryEvidenceSha:key==='v3Pools'?registryEvidenceSha:null};
  const unit=p.defineUnit({source,first:h.first_block,last:h.last_block,hourStart:h.hour_start,anchorHash:h.last_hash,registryDigest:hash({registryEvidenceSha})});
  const processJob=createDexLogProcessor({stream,loadVerifiedWindow:load,isOfficialV3:l=>{const r=membership.get(l.address);return !!r&&(r.created_block<l.blockNumber||r.created_block===l.blockNumber&&r.created_log_index<l.logIndex);}});
  let interrupted=!!resumeDirectory;
  for(let n=0;n<8;n++){
   if(n>0){p.close();p=open(false);}
   const b=provider(),start=performance.now();try{const out=await runBoundedUnit(p,{unitId:unit,bounded:b,processJob,afterAccept:()=>{peakHeap=Math.max(peakHeap,process.memoryUsage().heapUsed);peakDisk=Math.max(peakDisk,p.metrics().directoryBytes);if(!interrupted){interrupted=true;throw Object.assign(Error('simulated_worker_restart'),{code:'simulated_worker_restart'});}}});report.runs.push({stream:key,...out,durationMs:Math.round(performance.now()-start)});console.log(JSON.stringify(report.runs.at(-1)));writeFileSync(reportPath,JSON.stringify({...report,complete:false},null,2));if(out.coverage.status==='complete')break;if(out.reason!=='bounded_run_yield')throw Object.assign(Error(out.reason??'source_incomplete'),{code:out.reason??'source_incomplete'});
   }catch(e){if(e.code!=='simulated_worker_restart')throw e;report.runs.push({stream:key,phase:'interruption_after_committed_piece',usage:{...b.stats}});}
   finally{b.close();}
  }
  const coverage=p.coverage(unit);assert.equal(coverage.status,'complete');
  const sums={swapCount:0,mintCount:0,burnCount:0,initializeCount:0,modifyLiquidityCount:0,foreignEventCount:0,receivedEvents:0};
  for(const r of p.summaries(unit)){sums.foreignEventCount+=r.counts.foreignEvents;sums.receivedEvents+=r.counts.receivedEvents;for(const pool of r.rows.slice(1)){sums.swapCount+=pool.swapCount;sums.mintCount+=pool.mintCount;sums.burnCount+=pool.burnCount;sums.initializeCount+=pool.initializeCount;sums.modifyLiquidityCount+=pool.liquidityIncreaseCount+pool.liquidityDecreaseCount+pool.liquidityPokeCount;}}
  const stored=input.prepare('SELECT * FROM compact_family_hours WHERE hour_start=? AND family=?').get(h.hour_start,family);assert.equal(hash(stored.metrics_json),stored.metrics_sha256);const canonical=JSON.parse(stored.metrics_json),keys=key==='v3Pools'?['swapCount','mintCount','burnCount','foreignEventCount']:['swapCount','initializeCount','modifyLiquidityCount'];
  report.streams.push({stream:key,unitId:unit,coverage,counts:sums,storedCanonicalCounts:Object.fromEntries(keys.map(k=>[k,canonical[k]])),comparedCountsMatch:keys.every(k=>sums[k]===canonical[k])});
  if(key==='v3Pools'&&!report.streams.at(-1).comparedCountsMatch){
    const factoryStream=LOG_STREAMS.find(s=>s.key==='v3Factory'),factorySource={id:'uniswap_v3_factory',definition:'official-factory-sparse-evidence-v1',chainId:5042,stream:factoryStream,codeAtBlock:h.last_block,codeSha};
    const factoryUnit=p.defineUnit({source:factorySource,first:h.first_block,last:h.last_block,hourStart:h.hour_start,anchorHash:h.last_hash,registryDigest:hash({registryEvidenceSha})},{chunkBlocks:10000});
    const fp=provider();try{const out=await runBoundedUnit(p,{unitId:factoryUnit,bounded:fp,processJob:createV3FactoryProcessor({loadVerifiedWindow:load})});assert.equal(out.coverage.status,'complete');report.runs.push({stream:'v3Factory',...out});}finally{fp.close();}
    const factorySummary=[...p.summaries(factoryUnit)][0],newPools=factorySummary.rows;
    assert.equal(factorySummary.counts.poolCreatedCount,canonical.poolCreatedCount);
    assert(newPools.every(r=>!membership.get(r.address))); // Verified disjointness prevents double-counting accepted base pools.
    const addresses=newPools.map(r=>r.address).sort(),factorySha=p.db.prepare('SELECT expected_sha FROM arc_pipeline_jobs WHERE unit_id=?').get(factoryUnit).expected_sha,addedUnits=[];
    const observed=p.db.prepare("SELECT payload_json,payload_sha FROM arc_pipeline_fact_rows WHERE unit_id=? AND fact_kind='v3_pool_created' AND fact_key=?");
    const addedProvider=provider();try{for(let offset=0;offset<addresses.length;offset+=16){
      const targets={...stream,address:addresses.slice(offset,offset+16)};
      const addedSource={...source,id:'uniswap_v3_hour_created_events',definition:'bounded-hour-created-pool-statistics-v2',stream:targets,factoryEvidenceSha:factorySha},addedUnit=p.defineUnit({source:addedSource,first:h.first_block,last:h.last_block,hourStart:h.hour_start,anchorHash:h.last_hash,registryDigest:hash({registryEvidenceSha,factorySha})},{chunkBlocks:10000});
      const processAdded=createDexLogProcessor({stream:targets,sparseWindow:true,loadVerifiedWindow:load,isOfficialV3:l=>{const r=observed.get(factoryUnit,l.address);if(!r||hash(r.payload_json)!==r.payload_sha)throw Error('factory_evidence_corrupt');const pool=JSON.parse(r.payload_json);return pool.createdBlock<l.blockNumber||pool.createdBlock===l.blockNumber&&pool.createdLogIndex<l.logIndex;}});
      const out=await runBoundedUnit(p,{unitId:addedUnit,bounded:addedProvider,processJob:processAdded,afterAccept:()=>{peakDisk=Math.max(peakDisk,p.metrics().directoryBytes);}});report.groupProgress.push({stream:'v3HourCreatedPoolGroup',group:offset/16,...out,cumulativeUsage:out.usage});if(out.coverage.status!=='complete')throw Object.assign(Error(out.reason??'source_incomplete'),{code:out.reason??'source_incomplete'});addedUnits.push(addedUnit);
    }}finally{report.runs.push({stream:'v3HourCreatedPools',phase:'one_bounded_invocation_for_all_groups',usage:{...addedProvider.stats}});addedProvider.close();}
    const merged={...sums,poolCreatedCount:factorySummary.counts.poolCreatedCount};let reclassified=0;
    for(const id of addedUnits)for(const r of p.summaries(id)){assert.equal(r.counts.foreignEvents,0);reclassified+=r.counts.acceptedEvents;for(const pool of r.rows.slice(1)){merged.swapCount+=pool.swapCount;merged.mintCount+=pool.mintCount;merged.burnCount+=pool.burnCount;}}
    merged.foreignEventCount-=reclassified;assert.equal(merged.foreignEventCount,merged.receivedEvents-merged.swapCount-merged.mintCount-merged.burnCount);
    assert(keys.every(k=>merged[k]===canonical[k]));
    const derived=deriveDexFamily(p,{baseUnit:unit,supplementUnits:addedUnits,factoryUnit,protocol:'uniswap_v3'});assert.deepEqual(derived.metrics,canonical);
    report.streams.at(-1).derivedFamily=derived;
    report.streams.at(-1).incrementalCorrection={factoryPools:newPools.length,factoryUnitId:factoryUnit,addedUnitIds:addedUnits,reclassifiedEvents:reclassified,mergedCounts:merged,canonicalCountsMatch:true,baseEvidencePreserved:true,onlyNewlyCreatedPoolLogsRequested:true};
  }else if(key==='v4'){const derived=deriveDexFamily(p,{baseUnit:unit,protocol:'uniswap_v4'});assert.deepEqual(derived.metrics,canonical);report.streams.at(-1).derivedFamily=derived;}
 }
 const keys=downloaded.map(x=>json(x));assert.equal(new Set(keys).size,keys.length);report.completedPiecesNotDownloadedAgain=true;p.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');report.metrics=p.metrics();report.complete=true;
}catch(e){report.error={code:e.code??e.message,diagnostics:providerDiagnostics(e)};report.complete=false;process.exitCode=1;}
finally{Object.assign(report,{maximumResponseBytes:maxResponse,peakSampledHeapBytes:peakHeap,peakManagedDirectoryBytes:peakDisk,maxRSSBytes:process.resourceUsage().maxRSS*1024,durationMs:Math.round(performance.now()-started)});clearInterval(monitor);writeFileSync(reportPath,JSON.stringify(report,null,2));console.log(JSON.stringify(report));p.close();input.close();}
