import assert from 'node:assert/strict';
import {mkdtempSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {openPipeline,assertHeapBudget} from '../server/intelligence-pipeline/storage.js';
import {createNetworkReducer} from '../server/intelligence-pipeline/network-reducer.js';
import {createNetworkHourStore,verifyNetworkSeal} from '../server/intelligence-pipeline/network-hour-store.js';
import {createCreationsProcessor} from '../server/intelligence-pipeline/creations.js';
import {createCreationTokenProcessor} from '../server/intelligence-pipeline/token-discovery-source.js';
import {createDiscoveryPublication} from '../server/intelligence-pipeline/discovery-publication.js';
import {readEcosystem} from '../server/compact/intelligence-store.js';
import {createPipelineApiPublication} from '../server/intelligence-pipeline/api-publication.js';
import {sha256Of} from '../server/compact/projections.js';
const H='0x'+'1'.repeat(64),T='0x'+'4'.repeat(64),A='0x'+'2'.repeat(40),B='0x'+'3'.repeat(40),digest='a'.repeat(64);
const word=n=>'0x'+BigInt(n).toString(16).padStart(64,'0');
let checks=0;const test=async(name,f)=>{await f();checks++;console.log('PASS '+name);};
async function lab({interrupt}={}){
 const root=mkdtempSync(join(tmpdir(),'arc-token-source-test-')),path=join(root,'input.sqlite');let now=0;
 let input=openPipeline({path,create:true,verifySeal:verifyNetworkSeal});
 const source={id:'network',definition:'arc-canonical-reduction-v2',chainId:5042,originalDefinition:'arc-compact-hour-v2'},n=input.defineUnit({source,first:10,last:10,hourStart:0,anchorHash:H,registryDigest:digest});
 const r=createNetworkReducer({first:10,last:10,before:{number:9,hash:H,timestamp:0},hourStart:0,hourEnd:3600,source,anchorHash:H});
 r.addVerifiedSpine({number:10,hash:H,parentHash:H,timestamp:1,gasUsed:100n,txHashes:[H,T],txFrom:[A,B],txTo:[null,null]});input.accept(input.claim({unitId:n}),r.finish());
 const network={status:'available',blockCount:1,transactionCount:2,uniqueSenders:2,uniqueRecipients:0,uniqueActiveAddresses:2,gasUsedRaw:'100',averageTransactionsPerBlock:2,transactionsPerSecond:2/3600,internal:{deploymentAttempts:2}},range={kind:'hour',hourStart:0,hourEnd:3600,startUtc:new Date(0).toISOString(),endUtc:new Date(3600000).toISOString(),firstBlock:10,lastBlock:10,parentHash:H,firstHash:H,lastHash:H,firstTimestamp:1,lastTimestamp:1};
 const s=createNetworkHourStore(input);s.publish(n,{hour_start:0,first_block:10,last_block:10,parent_hash:H,first_hash:H,last_hash:H,definition_version:'arc-compact-hour-v2',network_json:JSON.stringify(network),network_sha256:sha256Of({definitionVersion:'arc-compact-hour-v2',range,network})});s.compact(n);
 const creations=createCreationsProcessor(input,{networkUnitId:n}),u=input.defineUnit({source:creations.source,first:10,last:10,hourStart:0,anchorHash:H,registryDigest:digest}),job=input.claim({unitId:u});
 const out=await creations.processJob(job,{canContinue:()=>true,request:async()=>input.getSeal(n).summary.creations.map(a=>({transactionHash:a.txHash,blockHash:a.blockHash,blockNumber:'0xa',transactionIndex:'0x'+a.transactionIndex.toString(16),from:a.deployer,to:null,status:a.transactionIndex?'0x0':'0x1',contractAddress:a.transactionIndex?null:B,logs:[]}))});input.accept(job,out.summary);input.close();
 input=openPipeline({path,readOnly:true,verifySeal:verifyNetworkSeal});
 const resultPath=join(root,'result.sqlite');let target=openPipeline({path:resultPath,create:true,now:()=>now});
 let processor=createCreationTokenProcessor(target,{creationPipeline:input,creationUnitId:u,afterCandidateCommit:interrupt});
 const spec={source:processor.source,first:10,last:10,hourStart:0,anchorHash:H,registryDigest:digest},unit=target.defineUnit(spec);
 return{input,u,n,unit,get target(){return target;},get processor(){return processor;},restart(){target.close();now+=600001;target=openPipeline({path:resultPath,now:()=>now});processor=createCreationTokenProcessor(target,{creationPipeline:input,creationUnitId:u});},close(){input.close();target.close();}};
}
function rpc({answers,error,canContinue=true}={}){let requests=0;return{get requests(){return requests;},canContinue:()=>canContinue,
 request:async()=>{throw Error('receipt or full block must not be downloaded');},batch:async calls=>{
  requests++;if(error)throw Object.assign(Error(error),{code:error});assert.equal(calls.length,7);assert(calls.every(c=>c[1].at(-1)==='0xa'));
  return answers??[{result:'0x6000'},{result:word(10)},{result:word(0)},{result:'0x'},{result:'0x'},{result:word(6)},{error:{code:3,message:'execution reverted'}}];}};}
async function accept(l,p){const j=l.target.claim({unitId:l.unit}),result=await l.processor.processJob(j,p);l.target.accept(j,result.summary);return result.summary;}
await test('canonical receipts reused, required views pinned, failed deployment never a launch',async()=>{const l=await lab(),p=rpc(),s=await accept(l,p);assert.deepEqual(s.counts,{candidates:2,verified:1,rejected:1});assert.equal(p.requests,1);assert.equal(s.rows[0].result.symbol,null);assert.equal(s.rows[0].result.launch.status,'direct_deployment');assert.equal(s.rows[1].result.reason,'deployment_failed');assert.equal(l.target.coverage(l.unit).status,'complete');assert.equal(l.input.coverage(l.n).status,'complete');l.close();});
await test('candidate commit survives interruption and restart without repeated token views',async()=>{let once=false;const l=await lab({interrupt:()=>{if(!once){once=true;throw Error('lab_crash');}}}),p=rpc();await assert.rejects(l.processor.processJob(l.target.claim({unitId:l.unit}),p),/lab_crash/);assert.equal(l.target.coverage(l.unit).status,'partial');l.restart();const q=rpc();const s=await accept(l,q);assert.equal(q.requests,0);assert.equal(s.counts.verified,1);assert.equal(l.target.claim({unitId:l.unit}),null);l.close();});
await test('budget, HTTP, transport and body failures retain their exact code and no partial unit',async()=>{for(const code of ['recovery_response_budget_exhausted','recovery_rpc_budget_exhausted','transport','http_error','body_read','timeout']){const l=await lab(),p=rpc({error:code});await assert.rejects(l.processor.processJob(l.target.claim({unitId:l.unit}),p),e=>e.code===code);assert.equal(p.requests,1);assert.equal(l.target.coverage(l.unit).status,'partial');assert.equal(l.target.db.prepare('SELECT COUNT(*) n FROM arc_pipeline_token_view_results').get().n,0);l.close();}});
await test('provider item errors are retryable, never terminal negatives or verified tokens',async()=>{const l=await lab(),p=rpc({answers:Array.from({length:7},()=>({error:{code:-32005,message:'rate limited'}}))});await assert.rejects(l.processor.processJob(l.target.claim({unitId:l.unit}),p),e=>e.code==='token_views_unverified');assert.equal(l.target.db.prepare('SELECT COUNT(*) n FROM arc_pipeline_token_view_results').get().n,0);l.close();});
await test('generic fallback fails the negative control instead of inventing ERC20 behavior',async()=>{const l=await lab(),p=rpc({answers:[{result:'0x6000'},...Array.from({length:6},()=>({result:word(0)}))]}),s=await accept(l,p);assert.equal(s.counts.verified,0);assert.equal(s.rows[0].result.reason,'token_behavior_negative_control_failed');l.close();});
await test('early bounded yield makes no additional RPC',async()=>{const l=await lab(),p=rpc({canContinue:false});await assert.rejects(l.processor.processJob(l.target.claim({unitId:l.unit}),p),e=>e.code==='bounded_run_yield');assert.equal(p.requests,0);l.close();});
await test('immutable terminal evidence cannot be overwritten or deleted',async()=>{const l=await lab();await accept(l,rpc());assert.throws(()=>l.target.db.exec("UPDATE arc_pipeline_token_view_results SET result_sha='bad'"));assert.throws(()=>l.target.db.exec('DELETE FROM arc_pipeline_token_view_results'));l.close();});
await test('source mismatch is rejected before RPC',async()=>{const l=await lab(),p=rpc(),j=l.target.claim({unitId:l.unit});j.spec.source={...j.spec.source,historicalBlock:11};await assert.rejects(l.processor.processJob(j,p),e=>e.code==='creation_token_source_conflict');assert.equal(p.requests,0);l.close();});
await test('unrelated source remains claimable after token failure',async()=>{const l=await lab(),other=l.target.defineUnit({source:{id:'independent_source',definition:'v1'},first:10,last:10,hourStart:0,anchorHash:H,registryDigest:digest});await assert.rejects(l.processor.processJob(l.target.claim({unitId:l.unit}),rpc({error:'transport'})));assert.equal(l.target.claim({unitId:other}).unit_id,other);l.close();});
async function publishedLab(){const l=await lab();await accept(l,rpc());createPipelineApiPublication(l.target).publish({network:{pipeline:l.input,unitId:l.n}});const q=openPipeline({path:l.target.path,readOnly:true});return{l,q,publication:createDiscoveryPublication(l.target),close(){q.close();l.close();}};}
await test('discovery publication rolls back candidates and coverage atomically on interruption',async()=>{const x=await publishedLab();try{
 assert.throws(()=>x.publication.publish(x.q,x.l.unit,{beforeCommit(){throw Error('crash');}}),/crash/);
 assert.equal(x.l.target.db.prepare('SELECT COUNT(*) n FROM compact_token_discoveries').get().n,0);
 assert.equal(x.l.target.db.prepare('SELECT COUNT(*) n FROM compact_intelligence_hours').get().n,0);
 assert.equal(x.l.target.coverage(x.l.unit).status,'complete');
}finally{x.close();}});
await test('real-contract Ecosystem adapter publishes qualified tokens without claiming missing coverage',async()=>{const x=await publishedLab();try{
 const before=x.l.target.db.prepare('SELECT * FROM compact_checkpoint').get();
 assert.equal(x.publication.publish(x.q,x.l.unit).verified,1);assert.equal(x.publication.publish(x.q,x.l.unit).outcome,'unchanged');
 for(const window of ['24h','7d','30d']){const e=readEcosystem(x.l.target.db,window);assert.equal(e.discoveredTokens.rows.length,1);assert.equal(e.launches.rows.length,1);assert.equal(e.coverage.availableHours,0);assert.equal(e.discoveredTokens.rows[0].verifiedAsset,false);}
 assert.equal(x.publication.audit().ok,true);assert.deepEqual(x.l.target.db.prepare('SELECT * FROM compact_checkpoint').get(),before);
}finally{x.close();}});
await test('corrupted discovered token copy fails audit and immutable commitment cannot be rewritten',async()=>{const x=await publishedLab();try{
 x.publication.publish(x.q,x.l.unit);x.l.target.db.prepare("UPDATE compact_token_discoveries SET result_json='{}'").run();
 assert.throws(()=>x.publication.audit(),/discovery_api_cache_integrity_failed/);
 assert.throws(()=>x.publication.publish(x.q,x.l.unit),/discovery_api_cache_integrity_failed/);
 assert.throws(()=>x.l.target.db.exec("UPDATE arc_pipeline_api_discovery_copies SET expected_sha='bad'"),/immutable/);
}finally{x.close();}});
await test('bounded discovery cache repair restores exact authority, keeps checkpoint and is idempotent',async()=>{const x=await publishedLab();try{
 x.publication.publish(x.q,x.l.unit);const before=x.l.target.db.prepare('SELECT * FROM compact_checkpoint').get();
 const rows=x.l.target.db.prepare('SELECT * FROM compact_token_discoveries ORDER BY candidate_key').all();
 x.l.target.db.prepare('DELETE FROM compact_token_discoveries').run();
 const out=x.publication.reconcile(()=>({pipeline:x.q,unitId:x.l.unit}));assert.equal(out.results[0].status,'repaired');
 assert.deepEqual(x.l.target.db.prepare('SELECT * FROM compact_token_discoveries ORDER BY candidate_key').all(),rows);
 assert.deepEqual(x.l.target.db.prepare('SELECT * FROM compact_checkpoint').get(),before);
 assert.equal(x.publication.reconcile(()=>{throw Error('must not reload authority');}).results[0].status,'verified');
 assert.equal(x.publication.audit().ok,true);
}finally{x.close();}});
await test('failed discovery repair rolls back without replacing accepted commitments',async()=>{const x=await publishedLab();try{
 x.publication.publish(x.q,x.l.unit);x.l.target.db.prepare("UPDATE compact_token_discoveries SET result_json='{}'").run();
 assert.throws(()=>x.publication.publish(x.q,x.l.unit,{repairCache:true,beforeCommit(){throw Error('crash');}}),/crash/);
 assert.equal(x.l.target.db.prepare("SELECT COUNT(*) n FROM compact_token_discoveries WHERE result_json='{}'").get().n,2);
 assert.equal(x.l.target.db.prepare('SELECT COUNT(*) n FROM arc_pipeline_api_discovery_repairs').get().n,0);
 assert.equal(x.publication.reconcile(()=>({pipeline:x.q,unitId:x.l.unit})).results[0].status,'repaired');
}finally{x.close();}});
console.log(JSON.stringify({checks,node:process.version,scope:'synthetic safety regressions; real token qualification measured separately',heapBudget:assertHeapBudget(),productionAccess:false}));
