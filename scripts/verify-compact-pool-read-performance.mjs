// Reuses an EXISTING local fixture. No fixture generation, production access, RPC, recovery or service deployment.
// The last 720 stored hours form the 30D test window; synthetic density is not verified mainnet history.
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { createHash } from 'node:crypto';
import { inflateRawSync, deflateRawSync } from 'node:zlib';
import { createCompactStore } from '../server/compact/store.js';
import { createPackedShards } from '../server/compact/packed-shards.js';
import { createCompactReadModel } from '../server/compact/read-model.js';
import { createEcosystemReader, ECOSYSTEM_READ_TIMEOUT_MS } from '../server/compact/ecosystem-reader.js';
import { COMPACT_DEFINITION_VERSION } from '../server/compact/sources.js';
import { FAMILY_FIELDS } from '../server/compact/families.js';

globalThis.fetch = async () => { throw Error('external_network_forbidden'); };
const HOUR=3600, BASE=Date.parse('2026-09-16T00:00:00Z')/1000;
const address=n=>`0x${n.toString(16).padStart(40,'0')}`, hash=n=>`0x${n.toString(16).padStart(64,'0')}`;
const stripFreshness=({freshness,...value})=>value;
const path=process.env.POOL_READ_FIXTURE_PATH, baselineRoot=process.env.POOL_READ_BASELINE_ROOT;
assert.ok(path && baselineRoot,'existing POOL_READ_FIXTURE_PATH and frozen POOL_READ_BASELINE_ROOT required; no fixture is generated');
assert.equal(ECOSYSTEM_READ_TIMEOUT_MS,6000);
const old=await import(pathToFileURL(join(baselineRoot,'server/compact/read-model.js')));
const expected=new Map(),timings=[],failed=[];
let passed=0;
let trace;
class TracedDatabase extends DatabaseSync {
  prepare(sql) {
    const statement=super.prepare(sql),record=trace;
    if(!record)return statement;
    const count=()=>{record.queries++;if(sql.includes('SELECT * FROM compact_packed_payloads'))record.payloadGets++;};
    for(const method of ['get','all']) {
      const original=statement[method];statement[method]=(...args)=>{
        if(method==='all' && sql.includes('GROUP BY') && sql.includes('compact_pool_hours') && !record.plan) {
          record.plan=DatabaseSync.prototype.prepare.call(this,`EXPLAIN QUERY PLAN ${sql}`).all(...args).map(row=>row.detail);
        }
        count();const at=performance.now();try{return original.apply(statement,args);}finally{record.sqlMs+=performance.now()-at;}
      };
    }
    const original=statement.iterate;
    statement.iterate=function* (...args){
      count();const iterator=original.apply(statement,args);
      try {for(;;){const at=performance.now(),step=iterator.next();record.sqlMs+=performance.now()-at;if(step.done)return;yield step.value;}}
      finally {iterator.return?.();}
    };
    return statement;
  }
}

function codecChecks() {
  const db=new DatabaseSync(':memory:'),store=createCompactStore(db,{packedShards:{config:{enabled:true},log:()=>{}}});
  const range={kind:'hour',hourStart:BASE,hourEnd:BASE+HOUR,firstBlock:100,lastBlock:109,parentHash:hash(99),firstHash:hash(100),lastHash:hash(109)};
  store.commitHour({definitionVersion:COMPACT_DEFINITION_VERSION,sourceVersions:{},chainId:5042,range,
    network:{status:'available',blockCount:10,transactionCount:2,uniqueActiveAddresses:2,gasUsedRaw:'0'},activeAddresses:[address(1),address(2)],
    complete:false,families:Object.fromEntries(Object.entries(FAMILY_FIELDS).map(([name,fields])=>[name,{status:'unavailable',reason:'fixture',
      ...Object.fromEntries(fields.map(f=>[f,null]))}])),registry:{uniswapV3:null}});
  const names=['plain','quote " slash \\ controls \n\t\u0000','emoji 👋 and lone \ud800','large-precision','🌍'.repeat(20000)+'\ud800',
    ...Array.from({length:260},(_,i)=>`bounded-piece-${i}`)];
  const insert=db.prepare('INSERT INTO compact_pool_hours VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
  for(let i=0;i<names.length;i++)insert.run(BigInt(BASE),'uniswap_v4',names[i],BigInt(i),
    '1234567890123456789012345678901234567890','0','1','2',0n,0n,0n,null,null,null,null);
  for(const [name,count] of [['uniswap_v3_pools',0],['uniswap_v4_pools',names.length]])
    db.prepare('INSERT INTO compact_projection_hours VALUES(?,?,?,?,?,?)').run(BigInt(BASE),name,'available',null,BigInt(count),hash(0));
  const packed=createPackedShards(db,{config:{enabled:true},log:()=>{}});packed.begin();db.exec('BEGIN');
  assert.equal(packed.packHour(BASE).compact_pool_hours.outcome,'inserted');db.exec('COMMIT');
  for(const table of ['compact_pool_hours','compact_hour_addresses']) {
    const original=db.prepare(`SELECT * FROM ${table} ORDER BY 1,2,${table==='compact_pool_hours'?'3':'2'}`).all().map(row=>({...row})),decoded=[];
    assert.ok(packed.forEachRow(table,BASE,row=>decoded.push(row)));assert.deepEqual(decoded,original);
    const iterator=packed.openRows(table,BASE),iterated=[];
    let step;for(step=iterator.next();!step.done;step=iterator.next())iterated.push(step.value);
    assert.deepEqual(iterated,original);assert.equal(step.value.rowCount,original.length);
  }
  // Iterator interleaving shares only flushed scratch, never unfinished checksum bytes.
  const left=packed.openRows('compact_pool_hours',BASE),right=packed.openRows('compact_hour_addresses',BASE);
  let l=left.next(),r=right.next(),leftCount=0,rightCount=0;
  while(!l.done || !r.done) {
    if(!l.done){leftCount++;l=left.next();}
    if(!r.done){rightCount++;r=right.next();}
  }
  assert.equal(l.value.rowCount,leftCount);assert.equal(r.value.rowCount,rightCount);
  const partial=packed.openRows('compact_pool_hours',BASE);partial.next();partial.return();
  assert.throws(()=>packed.forEachPoolSwap(BASE,()=>{throw Error('test_consumer_stop');}),/test_consumer_stop/);
  assert.ok(packed.forEachPoolSwap(BASE,()=>{}));
  const selected=[];
  packed.forEachPoolSwap(BASE,(protocol,pool,count,values,columns,hour)=>{
    assert.equal(protocol,'uniswap_v4');assert.ok(Number.isSafeInteger(count));
    selected.push({hour_start:hour,...Object.fromEntries(columns.map((name,i)=>[name,values[i]]))});
  });
  assert.deepEqual(selected,db.prepare('SELECT * FROM compact_pool_hours ORDER BY hour_start,protocol,pool').all().map(row=>({...row})));
  // Fault injection in this disposable in-memory database only; production triggers/schema are unchanged.
  db.exec('DROP TRIGGER compact_packed_piece_no_update');
  db.exec('DROP TRIGGER compact_packed_payload_no_update');
  const lastPiece=db.prepare("SELECT * FROM compact_packed_pieces WHERE dataset='compact_pool_hours' ORDER BY part DESC LIMIT 1").get();
  const originalPayload=db.prepare('SELECT * FROM compact_packed_payloads WHERE payload_sha256=?').get(lastPiece.payload_sha256);
  const rejectBoth=code=>{
    assert.throws(()=>packed.forEachRow('compact_pool_hours',BASE),e=>e.code===code);
    assert.throws(()=>packed.forEachPoolSwap(BASE,()=>{}),e=>e.code===code);
  };
  db.prepare('UPDATE compact_packed_payloads SET payload=? WHERE payload_sha256=?').run(Buffer.from('bad'),lastPiece.payload_sha256);
  rejectBoth('packed_payload_corrupt');
  db.prepare('UPDATE compact_packed_payloads SET payload=? WHERE payload_sha256=?').run(originalPayload.payload,lastPiece.payload_sha256);
  // All piece-level hashes are valid, but the last piece's row order is corrupt. Only the full typed-row checksum catches it.
  const changed=JSON.parse(inflateRawSync(originalPayload.payload).toString()).reverse();
  const raw=Buffer.from(JSON.stringify(changed)),payload=deflateRawSync(raw,{level:1});
  const sha=bytes=>createHash('sha256').update(bytes).digest('hex'),payloadSha=sha(payload);
  db.prepare('INSERT INTO compact_packed_payloads VALUES(?,?,?,?)').run(payloadSha,sha(raw),BigInt(raw.length),payload);
  db.prepare("UPDATE compact_packed_pieces SET payload_sha256=? WHERE dataset='compact_pool_hours' AND part=?").run(payloadSha,BigInt(lastPiece.part));
  rejectBoth('packed_rows_corrupt');
  db.prepare("UPDATE compact_packed_pieces SET payload_sha256=? WHERE dataset='compact_pool_hours' AND part=?").run(lastPiece.payload_sha256,BigInt(lastPiece.part));
  assert.ok(packed.forEachPoolSwap(BASE,()=>{}));
  db.exec('DROP TRIGGER compact_packed_piece_delete_guard');
  db.prepare("DELETE FROM compact_packed_pieces WHERE dataset='compact_pool_hours' AND scope_start=? AND part=0").run(BigInt(BASE));
  assert.throws(()=>packed.forEachRow('compact_pool_hours',BASE),error=>error.code==='packed_pieces_corrupt'||error.code==='packed_rows_corrupt');
  db.prepare('UPDATE compact_hours SET last_hash=? WHERE hour_start=?').run(hash(999),BigInt(BASE));
  assert.throws(()=>packed.forEachRow('compact_hour_addresses',BASE),error=>error.code==='packed_binding_mismatch');
  db.close();console.log('PASS independent writer digests: escaped text, Unicode, NULL, exact integers/BLOB and missing/corrupt evidence');
}


codecChecks();passed++;
if(process.env.POOL_READ_CODEC_ONLY==='true'){console.log('PASS focused codec, oversized UTF-8 row and iterator interruption checks');process.exit(0);}
{
  const db=new DatabaseSync(path,{readOnly:true});db.exec('PRAGMA query_only=ON');
  const bounds=db.prepare('SELECT COUNT(*) hours, MIN(hour_start) first, MAX(hour_start) last FROM compact_hours').get();
  assert.ok(bounds.hours>=720);assert.equal((bounds.last-bounds.first)/HOUR+1,bounds.hours);
  const from=bounds.last-719*HOUR;
  assert.equal(db.prepare('SELECT COUNT(*) n FROM compact_hours WHERE hour_start BETWEEN ? AND ?').get(from,bounds.last).n,720);
  console.log(JSON.stringify({existingFixture:path,storedHours:bounds.hours,selected30dHours:720,from,to:bounds.last,synthetic:true,actualMainnetHistory:false}));db.close();
}
for(const window of ['24h','7d','30d']) for(const protocol of ['v3','v4']) {
  trace={queries:0,payloadGets:0,sqlMs:0};
  const reference=old.createCompactReadModel({path,DatabaseSync:TracedDatabase}),at=performance.now();
  try {expected.set(`${protocol}:${window}`,stripFreshness(reference.pools(protocol,window)));
    const ms=performance.now()-at;
    console.log(JSON.stringify({test:'baseline_841766e',protocol,window,ms,...trace,nonSqlMs:ms-trace.sqlMs}));}
  finally {reference.close();}
  let workers=0;const workerTimes=[];
  const reader=createEcosystemReader({path,workerFactory:(url,options)=>{
    workers++;const w=new Worker(url,options);w.on('message',m=>{if(Number.isFinite(m.workerMs))workerTimes.push(m.workerMs);});return w;
  }});
  try {
    const coldAt=performance.now();let value;
    try {value=await reader.readPools(protocol,window);} catch(error) {
      const record={protocol,window,coldMs:performance.now()-coldAt,error:error.code};timings.push(record);failed.push(record);
      console.log(JSON.stringify({test:'cold_worker_failed',...record}));continue;
    }
    const coldMs=performance.now()-coldAt;
    assert.equal(value.status,'available');assert.equal(value.pools.length,10);
    assert.deepEqual(stripFreshness(value),expected.get(`${protocol}:${window}`));passed++;
    const warmAt=performance.now(),warm=await reader.readPools(protocol,window),warmMs=performance.now()-warmAt;
    assert.deepEqual(stripFreshness(warm),expected.get(`${protocol}:${window}`));assert.equal(workers,1);passed++;
    const record={protocol,window,coldMs,warmMs,workerTimes,nearDeadline:coldMs>=5500};timings.push(record);
    console.log(JSON.stringify({test:'cold_warm_equal',...record}));
  } finally {await reader.close();}
}
// Shared packed proof must be reused across protocols, but only for the same window and committed version.
trace={queries:0,payloadGets:0,sqlMs:0};
const model=createCompactReadModel({path,DatabaseSync:TracedDatabase});
let writer,checkpoint;
try {
  const at=performance.now();assert.deepEqual(stripFreshness(model.pools('v3','30d')),expected.get('v3:30d'));
  const coldMs=performance.now()-at,gets=trace.payloadGets;
  const sharedAt=performance.now();assert.deepEqual(stripFreshness(model.pools('v4','30d')),expected.get('v4:30d'));
  const sharedMs=performance.now()-sharedAt;
  assert.equal(trace.payloadGets,gets,'V4 must not decode already verified packed V3/V4 window again');passed++;
  console.log(JSON.stringify({test:'shared_verified_window',coldMs,sharedMs,extraPayloadReads:trace.payloadGets-gets}));
  // Two tiny reversible commits, exclusively to this disposable existing test fixture. No schema changes or new hours.
  // An inconsistent checkpoint must fail closed even after both protocol responses have been cached.
  writer=new DatabaseSync(path);checkpoint=writer.prepare('SELECT * FROM compact_checkpoint WHERE id=1').get();
  writer.prepare('UPDATE compact_checkpoint SET hour_start=? WHERE id=1').run(checkpoint.hour_start+HOUR);
  for(const p of ['v3','v4']) assert.throws(()=>model.pools(p,'30d'),e=>e.code==='inconsistent_state' && e.detail==='checkpoint_not_contiguous');
  passed++;
  writer.prepare('UPDATE compact_checkpoint SET hour_start=? WHERE id=1').run(checkpoint.hour_start);
  const invalidationGets=trace.payloadGets;
  assert.deepEqual(stripFreshness(model.pools('v4','30d')),expected.get('v4:30d'));
  assert.ok(trace.payloadGets>invalidationGets,'restored committed version must rebuild shared packed proof');
  const reverifiedGets=trace.payloadGets;
  assert.deepEqual(stripFreshness(model.pools('v3','30d')),expected.get('v3:30d'));
  assert.equal(trace.payloadGets,reverifiedGets);
  assert.deepEqual(writer.prepare('SELECT * FROM compact_checkpoint WHERE id=1').get(),checkpoint);passed++;
  console.log('PASS checkpoint commits invalidate cached responses and shared proof; inconsistent checkpoint fails closed; restored evidence reverified');
  const topIds=new Set(expected.get('v3:30d').pools.map(row=>row.pool));
  const hintRow=writer.prepare("SELECT * FROM compact_packed_pool_swaps WHERE protocol='uniswap_v3' ORDER BY pool LIMIT 20").all().find(row=>!topIds.has(row.pool));
  assert.ok(hintRow);model.close();
  // Inject a wrong secondary hint on the read connection, without altering the immutable fixture ledger.
  class WrongHintDatabase extends DatabaseSync {
    prepare(sql) {
      const statement=super.prepare(sql);
      if(sql==='SELECT protocol,pool,swap_count FROM compact_packed_pool_swaps') {
        const iterate=statement.iterate;
        statement.iterate=function* (...args) {
          for(const row of iterate.apply(statement,args)) yield row.protocol===hintRow.protocol && row.pool===hintRow.pool
            ? {...row,swap_count:row.swap_count+1000000} : row;
        };
      }
      return statement;
    }
  }
  const fallbackModel=createCompactReadModel({path,DatabaseSync:WrongHintDatabase}),fallbackAt=performance.now();
  try {
    assert.deepEqual(stripFreshness(fallbackModel.pools('v3','30d')),expected.get('v3:30d'));
    assert.deepEqual(stripFreshness(fallbackModel.pools('v4','30d')),expected.get('v4:30d'));passed++;
    console.log(JSON.stringify({test:'incorrect_hint_verified_fallback',ms:performance.now()-fallbackAt}));
  } finally {fallbackModel.close();}
} finally {
  if(writer && checkpoint) writer.prepare('UPDATE compact_checkpoint SET hour_start=? WHERE id=1 AND hour_start!=?').run(checkpoint.hour_start,checkpoint.hour_start);
  writer?.close();model.close();
}
console.log(JSON.stringify({summary:{passed,failed:failed.length,timings},workerDeadlineMs:6000,proxyDeadlineMs:8000,noRetry:true}));
if(failed.length)process.exitCode=1;
