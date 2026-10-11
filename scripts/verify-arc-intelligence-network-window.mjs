import assert from 'node:assert/strict';
import { mkdtempSync,rmSync,readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openPipeline,hash,assertHeapBudget } from '../server/intelligence-pipeline/storage.js';
import { createNetworkReducer } from '../server/intelligence-pipeline/network-reducer.js';
import { createNetworkHourStore,verifyNetworkSeal } from '../server/intelligence-pipeline/network-hour-store.js';
import { readNetworkWindow } from '../server/intelligence-pipeline/network-window.js';
import { sha256Of } from '../server/compact/projections.js';
const root=mkdtempSync(join(tmpdir(),'arc-network-window-')),source={id:'network',definition:'arc-canonical-reduction-v1',chainId:5042},digest='a'.repeat(64),A='0x'+'2'.repeat(40),B='0x'+'3'.repeat(40),H=n=>'0x'+hash(String(n));
const p=openPipeline({path:join(root,'window.sqlite'),create:true,verifySeal:verifyNetworkSeal}),store=createNetworkHourStore(p),ids=[];
let checks=0;const test=(name,fn)=>{fn();checks++;console.log('PASS '+name);};
function addHour(n){const hourStart=n*3600,first=n+1,anchorHash=H(first),spec={source,first,last:first,hourStart,anchorHash,registryDigest:digest};const u=p.defineUnit(spec),j=p.claim();assert.equal(j.unit_id,u);
 const r=createNetworkReducer({first,last:first,before:{number:first-1,hash:H(first-1),timestamp:hourStart},hourStart,hourEnd:hourStart+3600,source,anchorHash});r.addVerifiedSpine({number:first,hash:anchorHash,parentHash:H(first-1),timestamp:hourStart+1,gasUsed:100n,txHashes:[H(n+10000)],txFrom:[A],txTo:[B]});p.accept(j,r.finish());
 const network={status:'available',blockCount:1,transactionCount:1,uniqueSenders:1,uniqueRecipients:1,uniqueActiveAddresses:2,gasUsedRaw:'100',averageTransactionsPerBlock:1,transactionsPerSecond:1/3600,internal:{deploymentAttempts:0}},range={kind:'hour',hourStart,hourEnd:hourStart+3600,startUtc:new Date(hourStart*1000).toISOString(),endUtc:new Date((hourStart+3600)*1000).toISOString(),firstBlock:first,lastBlock:first,parentHash:H(first-1),firstHash:anchorHash,lastHash:anchorHash,firstTimestamp:hourStart+1,lastTimestamp:hourStart+1};
 const canonical={hour_start:hourStart,first_block:first,last_block:first,parent_hash:range.parentHash,first_hash:anchorHash,last_hash:anchorHash,definition_version:'arc-compact-hour-v2',network_json:JSON.stringify(network),network_sha256:sha256Of({definitionVersion:'arc-compact-hour-v2',range,network})};store.publish(u,canonical);store.compact(u);ids.push(u);
}
const read=(hours,end=720*3600,extra={})=>readNetworkWindow(p,{hours,endHour:end,sourceKey:hash(source),registryDigest:digest,...extra});
try{
 for(let n=0;n<720;n++)addHour(n);
 test('24H exact counts, unique addresses are not sums of hourly counts',()=>{const w=read(24);assert.equal(w.status,'available');assert.equal(w.totals.transactionCount,24);assert.equal(w.totals.uniqueActiveAddresses,2);assert.equal(w.daily.filter(d=>d.status==='available').length,1);});
 test('7D exact daily buckets and BigInt gas',()=>{const w=read(168);assert.equal(w.coverage.verifiedHours,168);assert.equal(w.totals.gasUsedRaw,'16800');assert.equal(w.daily.filter(d=>d.status==='available').length,7);assert(w.daily.every(d=>d.values.uniqueActiveAddresses===2));});
 test('full 30D requires 720 independently checked hour seals',()=>{const w=read(720);assert.equal(w.status,'available');assert.equal(w.totals.transactionCount,720);assert.equal(w.daily.filter(d=>d.status==='available').length,30);});
 test('new digest never silently merges old registry evidence',()=>{const w=read(720,720*3600,{registryDigest:'b'.repeat(64)});assert.equal(w.status,'unavailable');assert.equal(w.coverage.verifiedHours,0);assert.equal(w.totals,null);});
 test('missing hour keeps 30D available subset numeric; incomplete day remains null',()=>{p.db.prepare('DELETE FROM arc_pipeline_seals WHERE unit_id=?').run(ids[719]);const w=read(720);assert.equal(w.status,'partial');assert.equal(w.coverage.verifiedHours,719);assert.equal(w.totals.transactionCount,719);assert.equal(w.daily.at(-1).status,'incomplete');assert.equal(w.daily.at(-1).values,null);assert.equal(w.daily.filter(d=>d.status==='available').length,29);});
 test('existing 24H and 7D full-window totals stay withheld when evidence is missing',()=>{assert.equal(read(24).totals,null);assert.equal(read(168).totals,null);});
 test('damaged seal is isolated, never counted as valid or filled with zero',()=>{const r=p.db.prepare('SELECT * FROM arc_pipeline_seals WHERE unit_id=?').get(ids[718]);p.db.prepare('DELETE FROM arc_pipeline_seals WHERE unit_id=?').run(ids[718]);p.db.prepare('INSERT INTO arc_pipeline_seals VALUES(?,?,?,?)').run(ids[718],r.seal_sha,Buffer.from('bad'),3);const w=read(720);assert.equal(w.coverage.verifiedHours,718);assert.equal(w.totals.transactionCount,718);assert(w.issues.some(i=>i.reason==='unit_seal_corrupt'));});
 test('work files are removed on completion and interrupted read',()=>{assert(!readdirSync(root).some(n=>n.startsWith('.window-')));assert.throws(()=>read(720,720*3600,{onProgress:()=>{throw Error('interrupt')}}),/interrupt/);assert(!readdirSync(root).some(n=>n.startsWith('.window-')));});
 console.log(JSON.stringify({checks,node:process.version,heapBudget:assertHeapBudget(),scope:'synthetic network read-model regression; not real 720-hour acceptance',productionAccess:false}));
}finally{p.close();rmSync(root,{recursive:true,force:true});}
