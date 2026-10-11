import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {openPipeline,hash} from '../server/intelligence-pipeline/storage.js';
import {dexProjectionSource,deriveDexUiProjections} from '../server/intelligence-pipeline/dex-projection-source.js';
import {createDexUiHourStore,verifyDexUiSeal,readDexUiHour} from '../server/intelligence-pipeline/dex-ui-hour-store.js';
import {sha256Of} from '../server/compact/projections.js';
const H='0x'+'1'.repeat(64),P='0x'+'2'.repeat(40),hour=360000;
const pool={pool:P,swapCount:1,addCount:0,removeCount:0,pokeCount:0,token0InRaw:'001',token0OutRaw:'0',token1InRaw:'0',token1OutRaw:'2',
 addAmount0Raw:'0',addAmount1Raw:'0',removeAmount0Raw:'0',removeAmount1Raw:'0'};
const path={pool:P,swapCount:1,firstSwapBlock:10,lastSwapBlock:10,pricedBlocks:1,closeSqrtPriceX96:(2n**96n).toString(),closeLiquidity:'001',
 sqrtPriceBlockSum:(2n**96n).toString(),reserve0BlockSum:'0',reserve1BlockSum:'0'};
const activity={hourStart:hour,blockTimestamp:hour,blockNumber:10,logIndex:0,txHash:H,txFrom:P,protocol:'uniswap_v3',pool:P,
 kind:'swap',amountBasis:'v3_pool_delta',counterpartyKind:'swap_recipient',counterparty:P,amount0Raw:'-0001',amount1Raw:'2'};
const family={status:'available',swapCount:1,mintCount:0,burnCount:0,initializeCount:0,modifyLiquidityCount:0};
const wrap=rows=>({status:'available',rows,rowsSha256:sha256Of({rows})});
function lab(){const root=mkdtempSync(join(tmpdir(),'arc-ui-hour-test-')),file=join(root,'result.sqlite');
 const p=openPipeline({path:file,create:true,verifySeal:verifyDexUiSeal});const store=createDexUiHourStore(p);
 const source=dexProjectionSource('uniswap_v3'),unit=p.defineUnit({source,first:10,last:10,hourStart:hour,anchorHash:H,registryDigest:hash(source)});
 return{p,store,unit,file};}
function accept(l){const j=l.p.claim({unitId:l.unit});l.p.accept(j,{format:'arc-reduced-source-v1',first:10,last:10,sourceKey:hash(j.spec.source),anchorHash:H,
 inputSha256:hash('canonical logs'),status:'verified',reason:null,counts:{received:1,foreign:0,...Object.fromEntries(Object.entries(family).filter(([k])=>k!=='status'))},
 rows:[{kind:'verified_dex_ui_piece',protocol:'uniswap_v3',family,projections:{uniswap_v3_pools:wrap([pool]),uniswap_v3_price_paths:wrap([path]),dex_activity:wrap([activity])},
 activityPolicy:{perKind:500,capped:true}}]});}
let checks=0;const test=(name,f)=>{f();checks++;console.log('PASS '+name);};
test('complete exact hourly results preserve numeric strings, signed deltas and capped evidence',()=>{const l=lab();try{accept(l);const before=deriveDexUiProjections(l.p,l.unit);
 l.store.publish(l.unit);assert.deepEqual(readDexUiHour(l.p,l.unit),before);assert.equal(l.store.compact(l.unit).removedTransientPieces,1);
 assert.deepEqual(deriveDexUiProjections(l.p,l.unit),before);assert.equal(l.p.coverage(l.unit).status,'complete');assert.equal(l.p.claim({unitId:l.unit}),null);
 assert.equal(l.p.db.prepare('SELECT count(*) n FROM arc_pipeline_results').get().n,0);}finally{l.p.close();}});
test('partial hour cannot publish or expire its evidence',()=>{const l=lab();try{assert.throws(()=>l.store.publish(l.unit),e=>e.code==='ui_hour_incomplete');
 assert.throws(()=>l.store.compact(l.unit));assert.equal(l.p.coverage(l.unit).status,'partial');}finally{l.p.close();}});
test('crash before seal commit atomically preserves original pieces and removes attempted shards',()=>{const l=lab();try{accept(l);
 assert.throws(()=>l.store.publish(l.unit,{beforeCommit(){throw Error('crash');}}));assert.equal(l.p.getSeal(l.unit),null);
 assert.equal(l.p.db.prepare('SELECT count(*) n FROM arc_pipeline_ui_shards').get().n,0);assert.equal(l.p.coverage(l.unit).status,'complete');
 assert.equal(l.p.db.prepare('SELECT count(*) n FROM arc_pipeline_results').get().n,1);}finally{l.p.close();}});
test('crash after commit and restart reuses accepted results without source reads or RPC',()=>{const l=lab();accept(l);assert.throws(()=>l.store.publish(l.unit,{afterCommit(){throw Error('crash');}}));
 const before=readDexUiHour(l.p,l.unit);l.p.close();const p=openPipeline({path:l.file,verifySeal:verifyDexUiSeal});try{
 const store=createDexUiHourStore(p);store.publish(l.unit,{evidenceSource:{get coverage(){throw Error('must not read');}}});
 store.compact(l.unit);assert.deepEqual(readDexUiHour(p,l.unit),before);assert.equal(store.compact(l.unit).removedTransientPieces,0);}finally{p.close();}});
test('compaction transaction rollback retains original accepted source pieces',()=>{const l=lab();try{accept(l);l.store.publish(l.unit);
 assert.throws(()=>l.store.compact(l.unit,{beforeCommit(){throw Error('crash');}}));assert.equal(l.p.db.prepare('SELECT count(*) n FROM arc_pipeline_results').get().n,1);
 assert.ok(l.p.db.prepare('SELECT result_sha FROM arc_pipeline_jobs WHERE unit_id=?').get(l.unit).result_sha);assert.ok(l.p.getSeal(l.unit));}finally{l.p.close();}});
test('loss or corruption fails closed and cannot claim complete',()=>{const l=lab();try{accept(l);l.store.publish(l.unit);l.store.compact(l.unit);
 l.p.db.exec('DROP TRIGGER arc_pipeline_ui_shard_immutable');l.p.db.exec("UPDATE arc_pipeline_ui_shards SET payload=X'00'");
 assert.equal(l.p.coverage(l.unit).status,'partial');assert.throws(()=>readDexUiHour(l.p,l.unit));assert.throws(()=>l.store.compact(l.unit));}finally{l.p.close();}});
test('immutable final shards and stable symbols reject mutation',()=>{const l=lab();try{accept(l);l.store.publish(l.unit);
 assert.throws(()=>l.p.db.exec('UPDATE arc_pipeline_ui_shards SET plain_bytes=0'));assert.throws(()=>l.p.db.exec('DELETE FROM arc_pipeline_ui_shards'));
 assert.throws(()=>l.p.db.exec('UPDATE arc_pipeline_stable_symbols SET sha=zeroblob(32)'));}finally{l.p.close();}});
test('independent read-only source import stores final results without duplicate transient payloads',()=>{const l=lab();accept(l);const before=deriveDexUiProjections(l.p,l.unit);l.p.close();
 const source=openPipeline({path:l.file,readOnly:true}),target=lab();const sourceHash=hash(readFileSync(l.file));try{
 // Target's unrelated pending hour has another registry, preserving it during import.
 target.p.close();const file=join(mkdtempSync(join(tmpdir(),'arc-ui-import-test-')),'target.sqlite');const p=openPipeline({path:file,create:true,verifySeal:verifyDexUiSeal});try{
 const store=createDexUiHourStore(p);assert.throws(()=>store.publish(l.unit,{evidenceSource:source,beforeCommit(){throw Error('crash');}}));
 assert.equal(p.db.prepare('SELECT count(*) n FROM arc_pipeline_units').get().n,0);store.publish(l.unit,{evidenceSource:source});assert.deepEqual(readDexUiHour(p,l.unit),before);
 assert.equal(p.db.prepare('SELECT count(*) n FROM arc_pipeline_results').get().n,0);assert.equal(hash(readFileSync(l.file)),sourceHash);
 }finally{p.close();}}finally{source.close();}});
test('low space fails before publication without changing complete evidence',()=>{const l=lab();accept(l);l.p.close();let enough=true;
 const p=openPipeline({path:l.file,verifySeal:verifyDexUiSeal,capacity:()=>({usedBytes:65536,freeBytes:enough?2e9:1})});try{
 const store=createDexUiHourStore(p);enough=false;assert.throws(()=>store.publish(l.unit),e=>e.code==='storage_low_space');assert.equal(p.getSeal(l.unit),null);
 assert.equal(p.db.prepare('SELECT count(*) n FROM arc_pipeline_results').get().n,1);}finally{p.close();}});
console.log(JSON.stringify({checks,scope:'bounded exact final UI hour results; no mainnet or 720-hour completeness claim',rpcRequests:0}));
