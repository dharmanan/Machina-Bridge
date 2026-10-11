// Explicit independent lab only. Canonical receipts are read-only; no production or scheduler activation.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtempSync,readFileSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openPipeline,assertHeapBudget,hash} from '../server/intelligence-pipeline/storage.js';
import {verifyNetworkSeal} from '../server/intelligence-pipeline/network-hour-store.js';
import {createCreationTokenProcessor} from '../server/intelligence-pipeline/token-discovery-source.js';
import {runBoundedUnit} from '../server/intelligence-pipeline/worker.js';
import {boundedRecoveryProvider,RECOVERY_BUDGET} from './recover-compact-discovery.mjs';
import {providerDiagnostics} from '../server/compact/provider.js';
const [inputPath,creationUnitId,reportPath,resumeRoot]=process.argv.slice(2);
if(!inputPath?.startsWith('/tmp/arc-reduced-real-hour-')||!reportPath?.startsWith('/tmp/')
 ||resumeRoot&&!resumeRoot.startsWith('/tmp/arc-token-real-'))throw Error('isolated_tmp_paths_required');
const inputSha=createHash('sha256').update(readFileSync(inputPath)).digest('hex');
const input=openPipeline({path:inputPath,readOnly:true,verifySeal:verifyNetworkSeal});input.db.exec('BEGIN');
const root=resumeRoot??mkdtempSync(join(tmpdir(),'arc-token-real-')),path=join(root,'results.sqlite');let now=Date.now();
const open=()=>openPipeline({path,now:()=>now});let target=resumeRoot?open():openPipeline({path,create:true,now:()=>now});
let peakHeap=0,maxResponse=0,interrupted=Boolean(resumeRoot);const visited=[],began=performance.now();
const timer=setInterval(()=>{peakHeap=Math.max(peakHeap,process.memoryUsage().heapUsed);},10);timer.unref();
const report={scope:'one real historical hour creation candidates; not other discovery components, 720 hours or all 84 fields',
 heapBudget:assertHeapBudget(),node:process.version,root,path,creationUnitId,productionAccess:false,budget:RECOVERY_BUDGET,
 inputSha,runs:[],fullBodyRpcCalls:0,receiptRpcCalls:0,complete:false};
function bounded(){return boundedRecoveryProvider({fetchImpl:async(url,options)=>{
 const calls=[].concat(JSON.parse(options.body));for(const c of calls){
  if(c.method==='eth_getTransactionReceipt'||c.method==='eth_getBlockReceipts')report.receiptRpcCalls++;
  if(c.method==='eth_getBlockByNumber'&&c.params[1]===true)report.fullBodyRpcCalls++;
  if(c.method==='eth_getCode')visited.push(c.params[0]);
 }
 const r=await fetch(url,options),reader=r.body.getReader();let n=0;
 return{ok:r.ok,status:r.status,body:new ReadableStream({async pull(c){const x=await reader.read();if(x.done){maxResponse=Math.max(maxResponse,n);reader.releaseLock();c.close();}else{n+=x.value.byteLength;c.enqueue(x.value);}},cancel:reason=>reader.cancel(reason)})};
 }});}
let processor,unit;
try{
 processor=createCreationTokenProcessor(target,{creationPipeline:input,creationUnitId,afterCandidateCommit:()=>{
  peakHeap=Math.max(peakHeap,process.memoryUsage().heapUsed);if(!interrupted){interrupted=true;throw Object.assign(Error('lab_interrupt'),{code:'lab_interrupt'});}
 }});
 const u=input.db.prepare('SELECT * FROM arc_pipeline_units WHERE unit_id=?').get(creationUnitId);
 report.hour=new Date(u.hour_start*1000).toISOString();report.candidates=processor.candidateCount;
 unit=target.defineUnit({source:processor.source,first:u.first_block,last:u.last_block,hourStart:u.hour_start,anchorHash:u.anchor_hash,registryDigest:u.registry_digest});report.unitId=unit;
 for(let run=0;run<4;run++){
  if(run){target.close();now+=61000;target=open();processor=createCreationTokenProcessor(target,{creationPipeline:input,creationUnitId});}
  const b=bounded(),start=performance.now();
  try{
   assert.equal(await b.provider.request('eth_chainId',[]),'0x13b2');
   const header=await b.provider.request('eth_getBlockByNumber',['0x'+u.last_block.toString(16),false]);assert.equal(header.hash.toLowerCase(),u.anchor_hash);
   const out=await runBoundedUnit(target,{unitId:unit,bounded:b,processJob:processor.processJob});
   report.runs.push({...out,durationMs:Math.round(performance.now()-start),durableCandidates:target.db.prepare('SELECT COUNT(*) n FROM arc_pipeline_token_view_results').get().n});
   console.log(JSON.stringify({run:run+1,...report.runs.at(-1)}));writeFileSync(reportPath,JSON.stringify(report,null,2));
   if(out.coverage.status==='complete')break;
   if(!['lab_interrupt','bounded_run_yield'].includes(out.reason))break;
  }finally{b.close();}
 }
 report.complete=target.coverage(unit).status==='complete';
 if(report.complete){
  const summaries=[...target.summaries(unit)],rows=summaries.flatMap(x=>x.rows);
  assert.equal(rows.length,processor.candidateCount);assert.equal(new Set(rows.map(x=>x.candidate.txHash)).size,rows.length);
  report.counts=summaries.reduce((a,s)=>{for(const k of Object.keys(a))a[k]+=s.counts[k];return a;},{candidates:0,verified:0,rejected:0});
  report.rejectedReasons={};for(const r of rows)if(r.result.status==='rejected_not_erc20_like')report.rejectedReasons[r.result.reason]=(report.rejectedReasons[r.result.reason]??0)+1;
  report.evidenceSha=hash(rows);assert.equal(new Set(visited).size,visited.length);
  report.completedViewsNotDownloadedTwice=true;report.newlyDownloadedCandidates=visited.length;
  target.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');target.close();target=open();
  const resumed=createCreationTokenProcessor(target,{creationPipeline:input,creationUnitId});
  assert.equal(hash([...target.summaries(unit)].flatMap(x=>x.rows)),report.evidenceSha);assert.equal(target.claim({unitId:unit}),null);
  assert.equal(resumed.candidateCount,rows.length);report.finalRestartAdditionalRpcCalls=0;
 }
 assert.equal(report.fullBodyRpcCalls,0);assert.equal(report.receiptRpcCalls,0);
 report.metrics=target.metrics();report.canonicalInputUnchanged=createHash('sha256').update(readFileSync(inputPath)).digest('hex')===inputSha;
 assert(report.canonicalInputUnchanged);
}catch(e){report.error={code:e.code??e.message,diagnostics:providerDiagnostics(e)};process.exitCode=1;}
finally{
 clearInterval(timer);Object.assign(report,{peakSampledHeapBytes:peakHeap,maximumResponseBytes:maxResponse,maxRSSBytes:process.resourceUsage().maxRSS*1024,durationMs:Math.round(performance.now()-began)});
 writeFileSync(reportPath,JSON.stringify(report,null,2));console.log(JSON.stringify(report));target.close();input.db.exec('ROLLBACK');input.close();
}
