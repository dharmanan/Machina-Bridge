import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { encodeEvidence,decodeEvidence } from '../server/intelligence-pipeline/binary-evidence.js';
import { openPipeline,hash,assertHeapBudget } from '../server/intelligence-pipeline/storage.js';
import { createStableSymbols,stableSymbolReader } from '../server/intelligence-pipeline/evidence-symbols.js';
let checks=0;const test=(name,f)=>{f();checks++;console.log('PASS '+name);};
const values={missing:undefined,zero:'0',negativeZero:'-0',leading:'00012',negativeLeading:'-00012',positive:'900719925474099312345678901234567890',
  negative:'-900719925474099312345678901234567890',preciseNumber:0.5,null:null,truth:true,number:-0};delete values.missing;
test('ARCB1 remains byte-compatible while ARCB2 preserves exact strings, nulls, missing keys and signed zero',()=>{
  assert.equal(encodeEvidence('123456').subarray(0,5).toString(),'ARCB1');
  assert.equal(encodeEvidence(values,{compactIntegers:true}).subarray(0,5).toString(),'ARCB2');
  assert.deepEqual(decodeEvidence(encodeEvidence(values)),values);assert.deepEqual(decodeEvidence(encodeEvidence(values,{compactIntegers:true})),values);
});
test('unknown version, truncated integer and invalid stable reference fail closed',()=>{
  assert.throws(()=>decodeEvidence(Buffer.from('ARCB3')));assert.throws(()=>decodeEvidence(Buffer.concat([Buffer.from('ARCB2'),Buffer.from([12,2,1])])));
  const a='0x'+'1'.repeat(40),raw=encodeEvidence(a,{stableSymbols:new Map([[a,1]])});assert.throws(()=>decodeEvidence(raw));
});
const root=mkdtempSync(join(tmpdir(),'arc-evidence-codec-test-')),p=openPipeline({path:join(root,'lab.sqlite'),create:true,compactMemberships:true});
test('immutable stable symbol IDs are checksummed and missing IDs never decode',()=>{
  const store=p.transaction(()=>createStableSymbols(p.db)),value='0x'+'a'.repeat(64),id=p.transaction(()=>store.intern(value));
  assert.equal(store.intern(value),id);const read=stableSymbolReader(p.db);
  assert.deepEqual(decodeEvidence(encodeEvidence({value},{stableSymbols:new Map([[value,id]])}),{resolveStableSymbol:read}),{value});
  assert.throws(()=>read(id+1));assert.throws(()=>p.db.prepare('UPDATE arc_pipeline_stable_symbols SET sha=? WHERE id=?').run(Buffer.alloc(32),id),/immutable/);
});
const source={id:'codec_membership_test',definition:'exact-source-v1',chainId:5042},spec={source,first:1,last:1,hourStart:0,anchorHash:'0x'+hash('anchor'),registryDigest:hash(source)};
const unit=p.defineUnit(spec),j=p.claim({unitId:unit});
const membership=Buffer.concat(Array.from({length:10000},(_,i)=>Buffer.from(hash(String(i)).slice(0,40),'hex'))).toString('base64');
const summary={format:'arc-reduced-source-v1',first:1,last:1,sourceKey:hash(source),anchorHash:spec.anchorHash,inputSha256:hash('input'),status:'verified',reason:null,
  counts:{n:10000},rows:[{kind:'verified_protocol_range',membership:{senders:membership,recipients:membership},metrics:{amountRaw:values.positive,unknownPrice:null,domains:{'19':{raw:'200'},'2':{raw:'100'}}}}]};
let sha;
test('membership codec commits exact existing JSON checksum and preserves original packed order',()=>{
  sha=p.accept(j,summary);assert.equal(sha,hash({summary,facts:[]}));assert.deepEqual(p.getResult(sha),summary);
  assert.equal(p.db.prepare('SELECT format FROM arc_pipeline_results WHERE result_sha=?').get(sha).format,'reduced-evidence-v2');
  assert.equal(p.coverage(unit).status,'complete');
});
test('registry-version reuse does not duplicate completed codec work',()=>{
  const next=p.defineUnit({...spec,registryDigest:hash('next')});assert.equal(p.coverage(next).status,'complete');assert.equal(p.claim({unitId:next}),null);
  assert.equal(p.db.prepare('SELECT COUNT(*) n FROM arc_pipeline_results').get().n,1);
});
test('restart reads exact memberships and JSON checksums without RPC',()=>{
  p.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');const readonly=openPipeline({path:p.path,readOnly:true});
  assert.deepEqual(readonly.getResult(sha),summary);assert.equal(readonly.coverage(unit).status,'complete');readonly.close();
});
test('dictionary mutation is rejected and corruption cannot be treated as complete',()=>{
  assert.throws(()=>p.db.prepare('UPDATE arc_pipeline_addresses SET address=? WHERE id=1').run(Buffer.alloc(20)),/immutable/);
  assert.throws(()=>p.db.prepare('DELETE FROM arc_pipeline_addresses WHERE id=1').run(),/immutable/);
  const row=p.db.prepare('SELECT * FROM arc_pipeline_results WHERE result_sha=?').get(sha);
  p.db.prepare('DELETE FROM arc_pipeline_results WHERE result_sha=?').run(sha);p.db.prepare('INSERT INTO arc_pipeline_results VALUES(?,?,?,?)').run(sha,Buffer.from('bad'),row.plain_bytes,row.format);
  assert.notEqual(p.coverage(unit).status,'complete');assert.throws(()=>p.getResult(sha));
  p.db.prepare('DELETE FROM arc_pipeline_results WHERE result_sha=?').run(sha);p.db.prepare('INSERT INTO arc_pipeline_results VALUES(?,?,?,?)').run(sha,row.payload_gzip,row.plain_bytes,row.format);
  assert.equal(p.coverage(unit).status,'complete');
});
console.log(JSON.stringify({checks,heapBudget:assertHeapBudget(),heap:process.memoryUsage().heapUsed,synthetic:true,rpcRequests:0,productionAccess:false}));p.close();
