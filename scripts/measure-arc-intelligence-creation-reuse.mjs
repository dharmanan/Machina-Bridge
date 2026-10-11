// Explicit lab-only real RPC measurement. Reuses a previously checked isolated network-hour seal.
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { openPipeline,assertHeapBudget } from '../server/intelligence-pipeline/storage.js';
import { verifyNetworkSeal } from '../server/intelligence-pipeline/network-hour-store.js';
import { createCreationsProcessor } from '../server/intelligence-pipeline/creations.js';
import { runBoundedUnit } from '../server/intelligence-pipeline/worker.js';
import { boundedRecoveryProvider } from './recover-compact-discovery.mjs';
import { providerDiagnostics } from '../server/compact/provider.js';
const [path,reportPath]=process.argv.slice(2);
if(!path?.startsWith('/tmp/arc-reduced-real-hour-')||!reportPath?.startsWith('/tmp/'))throw Error('isolated_tmp_paths_required');
const heapBudget=assertHeapBudget();let now=Date.now();
const open=()=>openPipeline({path,verifySeal:verifyNetworkSeal,knownOtherBytes:1978695680,volumeLimitBytes:4838498304,now:()=>now});let p=open();
const network=p.db.prepare("SELECT u.* FROM arc_pipeline_units u JOIN arc_pipeline_seals s USING(unit_id) LIMIT 1").get();if(!network)throw Error('independently_verified_hour_required');
const cachedAtStart=p.db.prepare('SELECT payload_json FROM arc_pipeline_creation_receipts').all();
const cachedBlocks=new Set(cachedAtStart.map(r=>'0x'+JSON.parse(r.payload_json).blockNumber.toString(16)));
let interrupted=cachedAtStart.length>0,peakHeap=0,maxResponse=0;const receiptBlocks=[];
const sampleTimer=setInterval(()=>{peakHeap=Math.max(peakHeap,process.memoryUsage().heapUsed);},10);sampleTimer.unref();
const report={scope:'real creation receipts only; not token metadata, all seven discovery sources or all 84 fields',hour:new Date(network.hour_start*1000).toISOString(),heapBudget,node:process.version,runs:[],productionAccess:false,fullBodyRpcCalls:0,resumedReceiptRowsAtStart:cachedAtStart.length};
const measuredProvider=()=>boundedRecoveryProvider({fetchImpl:async(url,options)=>{const payload=JSON.parse(options.body);for(const call of [].concat(payload))if(call.method==='eth_getBlockReceipts')receiptBlocks.push(call.params[0]);const res=await fetch(url,options);let n=0;const reader=res.body.getReader();return {ok:res.ok,status:res.status,body:new ReadableStream({async pull(c){const r=await reader.read();if(r.done){maxResponse=Math.max(maxResponse,n);reader.releaseLock();c.close();}else{n+=r.value.byteLength;c.enqueue(r.value);}},cancel:reason=>reader.cancel(reason)})};}});
const started=performance.now();
try{
 let processor=createCreationsProcessor(p,{networkUnitId:network.unit_id,afterReceiptCommit:()=>{peakHeap=Math.max(peakHeap,process.memoryUsage().heapUsed);if(!interrupted){interrupted=true;throw Object.assign(Error('lab_interrupt'),{code:'lab_interrupt'});}}});
 const spec={source:processor.source,first:network.first_block,last:network.last_block,hourStart:network.hour_start,anchorHash:network.anchor_hash,registryDigest:network.registry_digest},unit=p.defineUnit(spec);
 for(let run=0;run<8;run++){
  if(run>0){p.close();if(run===1)now+=61000;p=open();processor=createCreationsProcessor(p,{networkUnitId:network.unit_id});}
  const bounded=measuredProvider(),runStart=performance.now();try{
   const header=await bounded.provider.request('eth_getBlockByNumber',['0x'+network.last_block.toString(16),false]);assert.equal(header.hash.toLowerCase(),network.anchor_hash);
   const out=await runBoundedUnit(p,{unitId:unit,bounded,processJob:processor.processJob,afterAccept:()=>{peakHeap=Math.max(peakHeap,process.memoryUsage().heapUsed);}});
   report.runs.push({...out,durationMs:Math.round(performance.now()-runStart),receiptRows:p.db.prepare('SELECT COUNT(*) n FROM arc_pipeline_creation_receipts').get().n});
   console.log(JSON.stringify({run:run+1,...report.runs.at(-1)}));writeFileSync(reportPath,JSON.stringify({...report,complete:false},null,2));
   if(out.coverage.status==='complete')break;
   if(!['lab_interrupt','bounded_run_yield'].includes(out.reason))break;
  }catch(e){report.runs.push({usage:{...bounded.stats},durationMs:Math.round(performance.now()-runStart),error:{code:e.code??'source_failed',diagnostics:providerDiagnostics(e)}});throw e;}
  finally{bounded.close();}
 }
 const summary=[...p.summaries(unit)],attempts=summary.reduce((n,r)=>n+r.counts.attempts,0),successful=summary.reduce((n,r)=>n+r.counts.successful,0),failed=summary.reduce((n,r)=>n+r.counts.failed,0);
 assert.equal(p.coverage(unit).status,'complete');assert.equal(attempts,processor.attemptCount);assert.equal(successful+failed,attempts);
 assert.equal(new Set(receiptBlocks).size,receiptBlocks.length);assert(receiptBlocks.every(block=>!cachedBlocks.has(block))); // Every downloaded block's required receipts survive restart.
 assert.equal(p.claim({unitId:unit}),null);p.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
 Object.assign(report,{attempts,successful,failed,receiptBlockCalls:receiptBlocks.length,completedWorkNotDownloadedTwice:true,maximumResponseBytes:maxResponse,peakSampledHeapBytes:peakHeap,maxRSSBytes:process.resourceUsage().maxRSS*1024,durationMs:Math.round(performance.now()-started),metrics:p.metrics(),unitId:unit,canonicalNetworkSealPreserved:p.coverage(network.unit_id).status==='complete'});
}catch(e){report.error={code:e.code??e.message,diagnostics:providerDiagnostics(e)};report.complete=false;process.exitCode=1;}
finally{clearInterval(sampleTimer);writeFileSync(reportPath,JSON.stringify(report,null,2));console.log(JSON.stringify(report));p.close();}
