import assert from 'node:assert/strict';
import { reduceDexLogs } from '../server/intelligence-pipeline/dex-log-reducer.js';
import { LOG_STREAMS } from '../server/compact/sources.js';
import { UNISWAP_EVENT_TOPICS as T } from '../api/_lib/arc-intelligence/uniswap.js';
import { unpackAddresses } from '../server/intelligence-pipeline/network-reducer.js';
import { assertHeapBudget } from '../server/intelligence-pipeline/storage.js';
const H='0x'+'1'.repeat(64),A='0x'+'2'.repeat(40),B='0x'+'3'.repeat(40),topic=a=>'0x'+a.slice(2).padStart(64,'0'),word=n=>(BigInt(n)<0n?(1n<<256n)+BigInt(n):BigInt(n)).toString(16).padStart(64,'0');
const window=new Map([[10,{hash:H,timestamp:1,txHashes:[H],txFrom:[A]}]]),v3=LOG_STREAMS.find(s=>s.key==='v3Pools'),v4=LOG_STREAMS.find(s=>s.key==='v4');
const raw=(stream,index=0,address=B)=>({address:stream.address?.[0]??address,blockNumber:'0xa',blockHash:H,transactionHash:H,transactionIndex:'0x0',logIndex:'0x'+index.toString(16),removed:false,
 topics:stream.key==='v3Pools'?[T.v3Swap,topic(A),topic(B)]:[T.v4Swap,H,topic(A)],data:'0x'+(stream.key==='v3Pools'?[100,-50,1n<<96n,1000,0]:[-100,50,1n<<96n,1000,0,3000]).map(word).join('')});
const options=stream=>({stream,first:10,last:10,window,isOfficialV3:()=>true,source:{id:stream.key==='v3Pools'?'uniswap_v3_events':'uniswap_v4_events',definition:'bounded-dex-raw-statistics-v1'},anchorHash:H});
let checks=0;const test=(name,fn)=>{fn();checks++;console.log('PASS '+name);};
test('V3 exact raw sums and observed evidence without inventing first-ever proof or USD',()=>{const r=reduceDexLogs([raw(v3)],options(v3)),p=r.rows[1];assert.equal(p.swapCount,1);assert.equal(p.swapAmount0AbsRaw,'100');assert.equal(p.swapAmount1AbsRaw,'50');assert.equal(p.observedSwap.firstProven,false);assert.equal(p.valuationStatus,'not_checked');assert.deepEqual([...unpackAddresses(r.rows[0].traderMembership)],[A]);assert.doesNotMatch(JSON.stringify(r),/"data"|"topics"/);});
test('V4 reuses strict existing signed amount and fee ABI decoders',()=>{const p=reduceDexLogs([raw(v4)],options(v4)).rows[1];assert.equal(p.pool,H);assert.equal(p.latestPoolState.appliedSwapFee,3000);assert.equal(p.swapAmount1AbsRaw,'50');assert.equal(p.tokenIdentityStatus,'not_checked');});
test('foreign V3 emitter is counted and excluded before ABI interpretation',()=>{const r=reduceDexLogs([{...raw(v3),data:'0x00'}],{...options(v3),isOfficialV3:()=>false});assert.equal(r.counts.foreignEvents,1);assert.equal(r.counts.acceptedEvents,0);assert.equal(r.rows.length,1);});
test('canonical hash, transaction position and duplicate log mismatches fail closed',()=>{assert.throws(()=>reduceDexLogs([{...raw(v3),blockHash:'0x'+'9'.repeat(64)}],options(v3)));assert.throws(()=>reduceDexLogs([{...raw(v3),transactionIndex:'0x1'}],options(v3)));assert.throws(()=>reduceDexLogs([raw(v3),raw(v3)],options(v3)));});
test('malformed official ABI fails; suspicious capped responses are split rather than accepted',()=>{assert.throws(()=>reduceDexLogs([{...raw(v3),data:'0x00'}],options(v3)));assert.throws(()=>reduceDexLogs(Array(10000).fill(raw(v3)),options(v3)),e=>e.code==='suspect_log_result_count');});
test('all 101 verified pool rows survive; response/UI caps never become ingestion caps',()=>{const logs=Array.from({length:101},(_,i)=>raw(v3,i,'0x'+(i+1).toString(16).padStart(40,'0'))),r=reduceDexLogs(logs,options(v3));assert.equal(r.rows.length,102);assert.equal(r.counts.acceptedEvents,101);});
console.log(JSON.stringify({checks,heapBudget:assertHeapBudget(),scope:'synthetic DEX reducer safety tests; not a real hour proof',productionAccess:false}));
