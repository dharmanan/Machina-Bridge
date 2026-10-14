// The mandatory regression scenarios build small disposable SQLite files (deterministic synthetic rows). The timing section
// reuses an EXISTING local fixture when POOL_READ_FIXTURE_PATH and POOL_READ_BASELINE_ROOT are set; it is skipped
// otherwise. No production access, RPC, recovery or service deployment.
// The last 720 stored hours form the 30D test window; synthetic density is not verified mainnet history.
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { inflateRawSync, deflateRawSync } from 'node:zlib';
import { createCompactStore } from '../server/compact/store.js';
import { createPackedShards, packedShardsConfig } from '../server/compact/packed-shards.js';
import { createCompactReadModel } from '../server/compact/read-model.js';
import { createEcosystemReader, ECOSYSTEM_READ_TIMEOUT_MS, ECOSYSTEM_RESPONSE_TIMEOUT_MS } from '../server/compact/ecosystem-reader.js';
import { COMPACT_DEFINITION_VERSION } from '../server/compact/sources.js';
import { FAMILY_FIELDS } from '../server/compact/families.js';
import { VALUATIONS } from '../server/compact/valuation.js';
import { handleIntelligenceProxy } from '../api/_lib/intelligence-proxy.js';

globalThis.fetch = async () => { throw Error('external_network_forbidden'); };
for (const key of ['COMPACT_PACKED_SHARDS_ENABLED','COMPACT_PACKED_RETENTION_ENABLED','COMPACT_PACKED_EXPIRY_ENABLED','COMPACT_PACKED_HOT_HOURS',
  'COMPACT_PACKED_MAINTENANCE_SCOPES','COMPACT_EVIDENCE_ARCHIVE_ENABLED']) delete process.env[key];
const HOUR=3600, BASE=Date.parse('2026-09-16T00:00:00Z')/1000;
const address=n=>`0x${n.toString(16).padStart(40,'0')}`, hash=n=>`0x${n.toString(16).padStart(64,'0')}`;
const stripFreshness=({freshness,...value})=>value;
const path=process.env.POOL_READ_FIXTURE_PATH, baselineRoot=process.env.POOL_READ_BASELINE_ROOT;
assert.equal(Boolean(path),Boolean(baselineRoot),'POOL_READ_FIXTURE_PATH and POOL_READ_BASELINE_ROOT are set together');
assert.equal(ECOSYSTEM_READ_TIMEOUT_MS,6000);
const old=path?await import(pathToFileURL(join(baselineRoot,'server/compact/read-model.js'))):null;
const expected=new Map(),timings=[],failed=[];
let passed=0;
let trace;
const telemetry=[];
function measuredReader(extra={}) {
  let workers=0;
  const reader=createEcosystemReader({...extra,path,workerFactory:(url,options)=>{
    workers++;
    const worker=new Worker(extra.workerURL??url,{...options,workerData:{...options.workerData,collectMetrics:true}});
    worker.on('message',message=>{
      if(!message.metrics)return;
      const record={id:message.id,workerMs:message.workerMs,...message.metrics};telemetry.push(record);
    });
    return worker;
  }});
  return {reader,workers:()=>workers};
}
function assertTelemetry(record) {
  assert.ok(record.memory.heapSizeLimit<=64*1024*1024,'total V8 heap cap, not just old generation');
  assert.ok(record.memory.heapUsed<=record.memory.heapSizeLimit);
  if(record.proofCache){const c=record.proofCache;assert.ok(c.scopes<=c.maxScopes && c.accountedBytes<=c.maxBytes && c.pieces<=c.maxPieces);}
}
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


// ---------------------------------------------------------------------------------------------------------------------
// Mandatory regression scenarios (always run). 900 deterministic hours: the 30D window of the newest hour leaves 180 stored
// hours outside it. 14 pools per protocol: 4 legacy pools swap heavily only in those outside hours, 10 current pools only
// inside, so the all-history ledger ranks the legacy pools first (a natural wrong hint) while the true 30D top ten are the
// current pools. A is never packed (the reference). R packs and prunes (retention, 72 hot hours): pruned hours lie
// outside the window, fewer than inside, so the hint path runs and must fall back. E also expires the pool sets past the
// 36-day span (the expiry path). Small by design: it proves the paths and the cache key, not production timing.
const W={hours:900,legacyHours:180,day0:Date.parse('2026-06-01T00:00:00Z')/1000};
const W_NEWEST=W.day0+(W.hours-1)*HOUR, W_FROM=W_NEWEST-719*HOUR, W_NOW=()=>(W_NEWEST+HOUR+60)*1000;
const wsha=text=>createHash('sha256').update(text).digest('hex');
const W_USDC='0x3600000000000000000000000000000000000000', W_ZERO=`0x${'0'.repeat(40)}`;
const W_POOLS=['uniswap_v3','uniswap_v4'].flatMap(protocol=>Array.from({length:14},(_,k)=>{
  const v4=protocol==='uniswap_v4',id=wsha(`window-pool-${protocol}-${k}`);
  return {protocol,v4,k,legacy:k<4,kind:v4?'uniswap_v4_pool':'uniswap_v3_pool',pool:v4?`0x${id}`:`0x${id.slice(0,40)}`,
    token:`0x${wsha(`window-token-${k}`).slice(0,40)}`};
}));
const wDigits=(i,k,n)=>`${BigInt(i+1)*1000003n+BigInt(k)*7919n+BigInt(n)*104729n}000000000000`;
function windowHour(i) {
  const hourStart=W.day0+i*HOUR,block=100+i;
  return {definitionVersion:COMPACT_DEFINITION_VERSION,chainId:5042,sourceVersions:{},complete:false,
    range:{kind:'hour',hourStart,hourEnd:hourStart+HOUR,firstBlock:block,lastBlock:block,parentHash:hash(block-1),firstHash:hash(block),lastHash:hash(block)},
    network:{status:'available',blockCount:1,transactionCount:1,uniqueActiveAddresses:1,gasUsedRaw:'21000'},activeAddresses:[address(0x5000+i%7)],
    families:Object.fromEntries(Object.entries(FAMILY_FIELDS).map(([name,fields])=>[name,{status:'unavailable',reason:'fixture',
      ...Object.fromEntries(fields.map(f=>[f,null]))}])),registry:{uniswapV3:null}};
}
function writeWindowHour(db,i) {
  const hour=W.day0+i*HOUR;
  const rows=W_POOLS.flatMap(p=>{
    const swaps=p.legacy?(i<W.legacyHours?40:0):(i<W.legacyHours?0:1+(i+p.k)%3);
    return swaps?[[hour,p.protocol,p.pool,swaps,wDigits(i,p.k,1),wDigits(i,p.k,2),wDigits(i,p.k,3),wDigits(i,p.k,4),i%3,i%2,0,
      ...(p.v4?[null,null,null,null]:[wDigits(i,p.k,5),wDigits(i,p.k,6),wDigits(i,p.k,7),wDigits(i,p.k,8)])]]:[];
  });
  const count=protocol=>rows.filter(row=>row[1]===protocol).length;
  db.exec('BEGIN IMMEDIATE');
  try {
    const pool=db.prepare(`INSERT INTO compact_pool_hours VALUES (${Array(15).fill('?').join(',')})`);
    for(const row of rows)pool.run(...row.map(v=>typeof v==='number'?BigInt(v):v));
    const projection=db.prepare("INSERT INTO compact_projection_hours VALUES (?,?,'available',NULL,?,?)");
    for(const [name,n] of [['uniswap_v3_pools',count('uniswap_v3')],['uniswap_v4_pools',count('uniswap_v4')],['uniswap_v3_price_paths',0],
      ['uniswap_v4_price_paths',0],['uniswap_v4_swap_fees',0],['dex_activity',0]]) projection.run(BigInt(hour),name,BigInt(n),wsha(`${hour}:${name}`));
    const valuation=db.prepare("INSERT INTO compact_valuation_hours VALUES (?,?,'available',NULL,2,?)");
    for(const name of VALUATIONS)valuation.run(BigInt(hour),name,wsha(`${hour}:${name}`));
    for(const table of ['compact_dex_volume_hours','compact_dex_fee_hours']) {
      const insert=db.prepare(`INSERT INTO ${table} VALUES (?,?,?,?,?)`);
      for(const protocol of ['uniswap_v3','uniswap_v4'])insert.run(BigInt(hour),protocol,'0',0n,0n);
    }
    db.exec('COMMIT');
  } catch(error) {db.exec('ROLLBACK');throw error;}
}
const wConfig=(extra={})=>packedShardsConfig({COMPACT_PACKED_SHARDS_ENABLED:'true',COMPACT_PACKED_RETENTION_ENABLED:'true',
  COMPACT_PACKED_MAINTENANCE_SCOPES:'32',...extra});
const drainPacked=store=>{for(let report;(report=store.packedShards.maintain({limit:256})).expired||report.pruned||report.packed;);};

async function windowScenarios() {
  const dir=mkdtempSync(join(tmpdir(),'compact-pool-window-')),file=name=>join(dir,name);
  const copy=(from,to)=>{copyFileSync(file(from),file(to));return file(to);};
  const built=performance.now();
  {
    const db=new DatabaseSync(file('a.sqlite')),store=createCompactStore(db,{packedShards:{log:()=>{}}});
    const registry=db.prepare('INSERT INTO compact_registry (kind,address,created_block,created_log_index,created_tx,meta_json) VALUES (?,?,?,?,?,?)');
    for(const [n,p] of W_POOLS.entries())registry.run(p.kind,p.pool,97n,BigInt(n),hash(20000+n),JSON.stringify(p.v4
      ?{currency0:W_USDC,currency1:p.token,fee:3000,tickSpacing:60,hooks:W_ZERO}:{token0:W_USDC,token1:p.token,fee:500,tickSpacing:10}));
    for(const [kind,n] of [['uniswap_v3_pool',1],['uniswap_v4_pool',2]])
      db.prepare('INSERT INTO compact_registry_coverage (kind,from_block,through_block,through_hash) VALUES (?,1,1000000000,?)').run(kind,hash(n));
    for(let i=0;i<W.hours;i++){store.commitHour(windowHour(i));writeWindowHour(db,i);}
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');db.close();
  }
  for(const [name,config] of [['r.sqlite',wConfig({COMPACT_PACKED_HOT_HOURS:'72'})],['e.sqlite',wConfig({COMPACT_PACKED_EXPIRY_ENABLED:'true'})]]) {
    const db=new DatabaseSync(copy('a.sqlite',name));drainPacked(createCompactStore(db,{packedShards:{config,log:()=>{}}}));
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');db.close();
  }
  const buildMs=Math.round(performance.now()-built);
  const keys=['v3:7d','v4:7d','v3:30d','v4:30d'];
  const answers=(path,Database=DatabaseSync)=>{
    const model=createCompactReadModel({path,DatabaseSync:Database,now:W_NOW});
    try {return Object.fromEntries(keys.map(key=>{const [p,w]=key.split(':');return [key,model.pools(p,w)];}));} finally {model.close();}
  };
  const reference=answers(file('a.sqlite'));
  for(const key of keys) assert.equal(reference[key].status,'available',key);
  const truth=protocol=>reference[`${protocol}:30d`].pools.map(row=>row.pool);
  for(const protocol of ['v3','v4']) {
    assert.equal(truth(protocol).length,10);
    assert.ok(truth(protocol).every(pool=>W_POOLS.some(p=>p.pool===pool && !p.legacy)),'the true 30D top ten are the current pools');
  }
  // The window state the read model sees, and the all-history hint it would rank by (hot window totals + ledger).
  const stateOf=path=>{
    const db=new DatabaseSync(path,{readOnly:true});
    try {
      const n=(sql,...args)=>db.prepare(sql).get(...args).n;
      const prunedIn=`SELECT scope_start FROM compact_packed_pruned WHERE dataset='compact_pool_hours' AND scope_start BETWEEN ${W_FROM} AND ${W_NEWEST}`;
      const expiredTable=n("SELECT COUNT(*) n FROM sqlite_master WHERE name='compact_packed_expired'");
      const hint=new Map();
      for(const row of db.prepare(`SELECT protocol,pool,SUM(swap_count) total FROM compact_pool_hours WHERE hour_start BETWEEN ? AND ? GROUP BY protocol,pool`)
        .all(W_FROM,W_NEWEST)) hint.set(`${row.protocol}:${row.pool}`,row.total);
      for(const row of db.prepare('SELECT protocol,pool,swap_count FROM compact_packed_pool_swaps').all())
        hint.set(`${row.protocol}:${row.pool}`,(hint.get(`${row.protocol}:${row.pool}`)??0)+row.swap_count);
      const hintTop=protocol=>[...hint].filter(([key,total])=>key.startsWith(`${protocol}:`)&&total>0)
        .sort(([a,x],[b,y])=>y-x||(a<b?-1:a>b?1:0)).slice(0,10).map(([key])=>key.split(':')[1]);
      return {inside:n(`SELECT COUNT(*) n FROM (${prunedIn})`),
        outside:n(`SELECT COUNT(*) n FROM compact_packed_pruned WHERE dataset='compact_pool_hours' AND scope_start NOT BETWEEN ${W_FROM} AND ${W_NEWEST}`),
        expired:expiredTable?n("SELECT COUNT(*) n FROM compact_packed_expired WHERE dataset='compact_pool_hours'"):0,
        pieces:n(`SELECT COUNT(*) n FROM compact_packed_pieces WHERE dataset='compact_pool_hours' AND scope_start IN (${prunedIn})`),
        hintV3:hintTop('uniswap_v3'),hintV4:hintTop('uniswap_v4')};
    } finally {db.close();}
  };
  const tracedRead=(path,protocol)=>{
    trace={queries:0,payloadGets:0,sqlMs:0};
    const model=createCompactReadModel({path,DatabaseSync:TracedDatabase,now:W_NOW}),at=performance.now();
    try {
      const v3=model.pools('v3','30d'),afterV3=trace.payloadGets,v4=model.pools('v4','30d');
      return {v3,v4,ms:performance.now()-at,payloadGets:afterV3,v4ExtraPayloadGets:trace.payloadGets-afterV3};
    } finally {model.close();}
  };
  const results={buildMs};

  {
    const state=stateOf(file('r.sqlite'));
    assert.ok(state.inside>0 && state.outside>0 && state.outside<state.inside && state.expired===0,JSON.stringify(state));
    for(const [protocol,hint] of [['v3',state.hintV3],['v4',state.hintV4]]) {
      assert.ok(hint.some(pool=>W_POOLS.some(p=>p.pool===pool && p.legacy)),'the all-history hint ranks pruned legacy pools outside the window');
      assert.notDeepEqual(new Set(hint),new Set(truth(protocol)),`${protocol}: natural wrong hint`);
    }
    const read=tracedRead(file('r.sqlite'));
    assert.deepEqual(read.v3,reference['v3:30d']);assert.deepEqual(read.v4,reference['v4:30d']);
    assert.equal(read.payloadGets,2*state.pieces,'every in-window pruned set is read exactly twice (verified, then by proof)');
    assert.equal(read.v4ExtraPayloadGets,0,'V4 reuses the verified window');
    assert.deepEqual(answers(file('r.sqlite')),reference,'7D (two-pass path: more pruned hours outside than inside) and 30D');
    results.wrongHint={...state,hintV3:undefined,hintV4:undefined,ms:Math.round(read.ms),payloadGets:read.payloadGets};
    passed++;console.log('PASS outside-window pruned hours with a natural wrong all-history hint: exact fallback, every in-window set read twice');
  }
  {
    const state=stateOf(file('e.sqlite'));
    assert.ok(state.expired>0 && state.outside>0,JSON.stringify(state));
    const read=tracedRead(file('e.sqlite'));
    assert.deepEqual(read.v3,reference['v3:30d']);assert.deepEqual(read.v4,reference['v4:30d']);
    assert.equal(read.payloadGets,2*state.pieces,'expiry keeps the two-pass path: totals pass, then the proof re-read');
    assert.deepEqual(answers(file('e.sqlite')),reference);
    results.expiry={inside:state.inside,outside:state.outside,expired:state.expired,pieces:state.pieces,ms:Math.round(read.ms),payloadGets:read.payloadGets};
    passed++;console.log('PASS expired pool hours: exact two-pass answer, every in-window set read twice');
  }
  {
    // Proof semantics on a disposable copy: only an issued proof of the same set, over byte-identical pieces, skips the
    // typed digest; every other difference is refused. Also the measured cost of both reads over the 30D pruned hours.
    const db=new DatabaseSync(copy('r.sqlite','proof.sqlite'));
    try {
      const packed=createPackedShards(db,{config:{enabled:false}}),other=createPackedShards(db,{config:{enabled:false}});
      const hours=db.prepare(`SELECT scope_start h FROM compact_packed_pruned WHERE dataset='compact_pool_hours' AND scope_start BETWEEN ? AND ? ORDER BY 1`)
        .all(W_FROM,W_NEWEST).map(row=>row.h);
      const proofs=new Map();
      let at=performance.now();for(const h of hours)proofs.set(h,packed.forEachPoolSwap(h,()=>{}).proof);const fullMs=performance.now()-at;
      at=performance.now();for(const h of hours)assert.ok(packed.forEachPoolSwap(h,()=>{},proofs.get(h)));const proofMs=performance.now()-at;
      const rowsOf=(h,proof)=>{const out=[];packed.forEachPoolSwap(h,(protocol,pool,count,values)=>out.push([...values]),proof);return out;};
      const [h0,h1]=hours;
      assert.deepEqual(rowsOf(h0,proofs.get(h0)),rowsOf(h0,null));
      const refused=(run,code)=>assert.throws(run,e=>e.code===code,code);
      refused(()=>packed.forEachPoolSwap(h0,()=>{},proofs.get(h1)),'packed_proof_mismatch');
      refused(()=>packed.forEachPoolSwap(h0,()=>{},{...proofs.get(h0)}),'packed_proof_mismatch');
      refused(()=>other.forEachPoolSwap(h0,()=>{},proofs.get(h0)),'packed_proof_mismatch');
      db.exec('DROP TRIGGER compact_packed_piece_no_update');db.exec('DROP TRIGGER compact_packed_payload_no_update');
      const piece=db.prepare("SELECT * FROM compact_packed_pieces WHERE dataset='compact_pool_hours' AND scope_start=? ORDER BY part DESC LIMIT 1").get(h0);
      const original=db.prepare('SELECT * FROM compact_packed_payloads WHERE payload_sha256=?').get(piece.payload_sha256);
      // Valid piece hashes over different bytes (same rows, reversed): refused with the proof and by the full digest without it.
      const raw=Buffer.from(JSON.stringify(JSON.parse(inflateRawSync(original.payload).toString()).reverse())),payload=deflateRawSync(raw,{level:1});
      const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
      db.prepare('INSERT INTO compact_packed_payloads VALUES(?,?,?,?)').run(sha(payload),sha(raw),BigInt(raw.length),payload);
      db.prepare("UPDATE compact_packed_pieces SET payload_sha256=? WHERE dataset='compact_pool_hours' AND scope_start=? AND part=?").run(sha(payload),h0,piece.part);
      refused(()=>packed.forEachPoolSwap(h0,()=>{},proofs.get(h0)),'packed_proof_mismatch');
      refused(()=>packed.forEachPoolSwap(h0,()=>{}),'packed_rows_corrupt');
      db.prepare("UPDATE compact_packed_pieces SET payload_sha256=? WHERE dataset='compact_pool_hours' AND scope_start=? AND part=?").run(piece.payload_sha256,h0,piece.part);
      db.prepare('UPDATE compact_packed_payloads SET payload=? WHERE payload_sha256=?').run(Buffer.from('bad'),piece.payload_sha256);
      refused(()=>packed.forEachPoolSwap(h0,()=>{},proofs.get(h0)),'packed_payload_corrupt');
      results.proof={hours:hours.length,fullVerifiedMs:Math.round(fullMs),proofReReadMs:Math.round(proofMs),ratio:+(proofMs/fullMs).toFixed(2)};
      passed++;console.log('PASS proofs: foreign, copied or other-reader proofs and changed bytes are refused; equal rows otherwise');
    } finally {db.close();}
  }
  {
    // Which check guards the second read: one piece is swapped, on that read only, for different bytes with valid piece
    // hashes. A proof re-read refuses it as packed_proof_mismatch; a second full verification would say packed_rows_corrupt.
    for(const name of ['r.sqlite','e.sqlite']) {
      const path=copy(name,`swap-${name}`),db=new DatabaseSync(path);
      const h0=db.prepare(`SELECT MIN(scope_start) h FROM compact_packed_pruned WHERE dataset='compact_pool_hours' AND scope_start BETWEEN ? AND ?`).get(W_FROM,W_NEWEST).h;
      const piece=db.prepare("SELECT * FROM compact_packed_pieces WHERE dataset='compact_pool_hours' AND scope_start=? ORDER BY part DESC LIMIT 1").get(h0);
      const original=db.prepare('SELECT * FROM compact_packed_payloads WHERE payload_sha256=?').get(piece.payload_sha256);
      const raw=Buffer.from(JSON.stringify(JSON.parse(inflateRawSync(original.payload).toString()).reverse())),payload=deflateRawSync(raw,{level:1});
      const sha=bytes=>createHash('sha256').update(bytes).digest('hex'),swapped=sha(payload);
      db.prepare('INSERT INTO compact_packed_payloads VALUES(?,?,?,?)').run(swapped,sha(raw),BigInt(raw.length),payload);db.close();
      let reads=0;
      class SecondReadSwap extends DatabaseSync {
        prepare(sql) {
          const statement=super.prepare(sql);
          if(!sql.startsWith('SELECT part, row_count, payload_sha256 FROM compact_packed_pieces'))return statement;
          const iterate=statement.iterate;
          statement.iterate=function* (...args){
            const second=Number(args[1])===h0 && ++reads===2;
            for(const row of iterate.apply(statement,args)) yield second && row.part===piece.part ? {...row,payload_sha256:swapped} : row;
          };
          return statement;
        }
      }
      const model=createCompactReadModel({path,DatabaseSync:SecondReadSwap,now:W_NOW});
      try {assert.throws(()=>model.pools('v3','30d'),e=>e.code==='read_failed' && e.detail==='packed_proof_mismatch',name);}
      finally {model.close();}
      assert.equal(reads,2,`${name}: the hour was read twice`);
    }
    passed++;console.log('PASS the second read of every set is guarded by its proof (wrong hint and expiry paths)');
  }
  {
    const db=new DatabaseSync(copy('r.sqlite','hourly-proof-cache.sqlite'));
    const cached=createPackedShards(db,{config:{enabled:false},reusePoolProofs:true});
    try {
      const hours=cached.prunedScopes('compact_pool_hours',W_FROM,W_NEWEST),h=hours[0];
      db.exec('BEGIN');const issued=cached.forEachPoolSwap(h,()=>{}).proof;db.exec('COMMIT');
      const first=cached.poolProofStats();
      db.prepare("INSERT INTO compact_meta VALUES('proof-cache-unrelated','1')").run();
      assert.ok(cached.forEachPoolSwap(h,()=>{}));
      assert.equal(cached.poolProofStats().verifiedSets,first.verifiedSets);assert.equal(cached.poolProofStats().hits,1);
      const other=createPackedShards(db,{config:{enabled:false}}),foreign=other.forEachPoolSwap(h,()=>{}).proof;
      assert.throws(()=>cached.forEachPoolSwap(h,()=>{},foreign),e=>e.code==='packed_proof_mismatch');
      assert.throws(()=>cached.forEachPoolSwap(h,()=>{},{...issued}),e=>e.code==='packed_proof_mismatch');
      const canonical=db.prepare('SELECT last_hash FROM compact_hours WHERE hour_start=?').get(BigInt(h));
      db.prepare('UPDATE compact_hours SET last_hash=? WHERE hour_start=?').run(hash(999999),BigInt(h));
      assert.throws(()=>cached.forEachPoolSwap(h,()=>{}),e=>e.code==='packed_binding_mismatch');
      db.prepare('UPDATE compact_hours SET last_hash=? WHERE hour_start=?').run(canonical.last_hash,BigInt(h));
      const blob=db.prepare(`SELECT b.* FROM compact_packed_pieces p JOIN compact_packed_payloads b USING(payload_sha256)
        WHERE p.dataset='compact_pool_hours' AND p.scope_start=? LIMIT 1`).get(BigInt(h));
      db.exec('DROP TRIGGER compact_packed_payload_no_update');
      db.prepare('UPDATE compact_packed_payloads SET raw_sha256=? WHERE payload_sha256=?').run(hash(123).slice(2),blob.payload_sha256);
      assert.throws(()=>cached.forEachPoolSwap(h,()=>{}),e=>e.code==='packed_payload_corrupt');
      db.prepare('UPDATE compact_packed_payloads SET raw_sha256=? WHERE payload_sha256=?').run(blob.raw_sha256,blob.payload_sha256);
      // A cached proof must also reject valid hashes over DIFFERENT bytes, not only damaged hashes.
      const piece=db.prepare("SELECT * FROM compact_packed_pieces WHERE dataset='compact_pool_hours' AND scope_start=? LIMIT 1").get(BigInt(h));
      const newRaw=Buffer.from(JSON.stringify(JSON.parse(inflateRawSync(blob.payload).toString()).reverse()));
      const newPayload=deflateRawSync(newRaw,{level:1}),digest=b=>createHash('sha256').update(b).digest('hex');
      db.prepare('INSERT OR IGNORE INTO compact_packed_payloads VALUES(?,?,?,?)').run(digest(newPayload),digest(newRaw),BigInt(newRaw.length),newPayload);
      db.exec('DROP TRIGGER compact_packed_piece_no_update');
      db.prepare("UPDATE compact_packed_pieces SET payload_sha256=? WHERE dataset='compact_pool_hours' AND scope_start=? AND part=?")
        .run(digest(newPayload),BigInt(h),BigInt(piece.part));
      assert.throws(()=>cached.forEachPoolSwap(h,()=>{}),e=>e.code==='packed_proof_mismatch');
      db.prepare("UPDATE compact_packed_pieces SET payload_sha256=? WHERE dataset='compact_pool_hours' AND scope_start=? AND part=?")
        .run(piece.payload_sha256,BigInt(h),BigInt(piece.part));
      db.exec('BEGIN');
      try {
        db.exec('ALTER TABLE compact_pool_hours ADD COLUMN test_schema_change TEXT');
        assert.throws(()=>cached.forEachPoolSwap(h,()=>{}),e=>e.code==='packed_definition_mismatch');
      }finally{db.exec('ROLLBACK');}
      assert.ok(cached.forEachPoolSwap(h,()=>{}));
      const allHours=cached.prunedScopes('compact_pool_hours',W.day0,W_NEWEST);
      for(const hour of allHours)cached.forEachPoolSwap(hour,()=>{});
      const stats=cached.poolProofStats();assert.ok(stats.evictions>0 && stats.scopes<=stats.maxScopes && stats.accountedBytes<=stats.maxBytes && stats.pieces<=stats.maxPieces);
      const before=stats.verifiedSets;cached.forEachPoolSwap(allHours[0],()=>{});
      assert.ok(cached.poolProofStats().verifiedSets>before,'evicted proof is fully reverified');
      const restarted=createPackedShards(db,{config:{enabled:false},reusePoolProofs:true});
      assert.equal(restarted.poolProofStats().scopes,0);restarted.forEachPoolSwap(h,()=>{});
      assert.equal(restarted.poolProofStats().verifiedSets,1);
      results.hourProofCache=stats;passed++;
      console.log('PASS bounded hourly proofs: cross-commit reuse, eviction, cold restart, foreign proof, canonical and raw SHA rejection');
    } finally {db.close();}
  }
  {
    // The fingerprint memo: an unrelated commit (as the discovery drain makes every minute) rebuilds the response but
    // reads no packed set; a pool input change (another hour pruned, a changed projection commitment) recomputes.
    const path=copy('r.sqlite','memo.sqlite');
    trace={queries:0,payloadGets:0,sqlMs:0};
    const model=createCompactReadModel({path,DatabaseSync:TracedDatabase,now:W_NOW}),writer=new DatabaseSync(path);
    try {
      const first=model.pools('v3','30d'),cold=trace.payloadGets;
      assert.ok(cold>0);assert.deepEqual(first,reference['v3:30d']);
      writer.prepare("INSERT INTO compact_meta (key,value) VALUES ('pool-window-unrelated','1')").run();
      const queries=trace.queries,at=performance.now();
      assert.deepEqual(model.pools('v3','30d'),first);assert.deepEqual(model.pools('v4','30d'),reference['v4:30d']);
      const warmMs=performance.now()-at;
      assert.ok(trace.queries>queries,'the response cache was invalidated by the commit and rebuilt');
      assert.equal(trace.payloadGets,cold,'no packed set is read again after an unrelated commit');
      // One more in-window hour pruned (72 -> 48 hot hours): new prune marker and set, hot rows gone -> recomputed, still exact.
      const store=createCompactStore(writer,{packedShards:{config:wConfig(),log:()=>{}}});
      const markers=()=>writer.prepare(`SELECT COUNT(*) n FROM compact_packed_pruned WHERE dataset='compact_pool_hours' AND scope_start BETWEEN ? AND ?`).get(W_FROM,W_NEWEST).n;
      const before=markers();drainPacked(store);assert.ok(markers()>before,'retention pruned more in-window hours');
      const pruneGets=trace.payloadGets;
      assert.deepEqual(model.pools('v3','30d'),first);assert.ok(trace.payloadGets>pruneGets,'a prune change recomputes');
      // A changed projection commitment for a hot in-window hour (its rows changed with it) recomputes and shows the change.
      const hot=writer.prepare(`SELECT MAX(hour_start) h FROM compact_pool_hours WHERE protocol='uniswap_v3'`).get().h;
      const last=first.pools.at(-1).pool;
      writer.exec('BEGIN');
      writer.prepare("UPDATE compact_pool_hours SET swap_count=swap_count+100000 WHERE hour_start=? AND protocol='uniswap_v3' AND pool=?").run(hot,last);
      writer.prepare("UPDATE compact_projection_hours SET rows_sha256=? WHERE hour_start=? AND projection='uniswap_v3_pools'").run(wsha('changed'),hot);
      writer.exec('COMMIT');
      const changed=model.pools('v3','30d');
      assert.equal(changed.pools[0].pool,last,'the changed hot rows are visible at once');
      assert.deepEqual(changed,answers(path)['v3:30d'],'equal to a cold read');
      results.memo={coldPayloadGets:cold,afterUnrelatedCommitMs:Math.round(warmMs)};
      passed++;console.log('PASS fingerprint memo: unrelated commits reuse verified pool rows; prune and projection changes recompute');
    } finally {model.close();writer.close();}
  }
  {
    // V3, V4 and Ecosystem 30D queued together in the one read-only worker, each with its 6 s deadline from enqueue.
    results.queue={};
    for(const name of ['r.sqlite','e.sqlite']) {
      let workers=0;
      const reader=createEcosystemReader({path:file(name),workerFactory:(url,options)=>{workers++;return new Worker(url,options);}});
      try {
        const at=performance.now(),done={};
        const settled=await Promise.allSettled([['v3',()=>reader.readPools('v3','30d')],['v4',()=>reader.readPools('v4','30d')],['ecosystem',()=>reader.read('30d')]]
          .map(([job,run])=>run().then(value=>{done[job]=Math.round(performance.now()-at);return value;})));
        assert.ok(settled.every(result=>result.status==='fulfilled'),JSON.stringify(settled.map(result=>result.reason?.code??'ok')));
        assert.equal(workers,1,'no worker restart');
        assert.deepEqual(stripFreshness(settled[0].value),stripFreshness(reference['v3:30d']));
        assert.deepEqual(stripFreshness(settled[1].value),stripFreshness(reference['v4:30d']));
        assert.ok(Math.max(...Object.values(done))<ECOSYSTEM_READ_TIMEOUT_MS);
        results.queue[name]=done;
      } finally {await reader.close();}
    }
    passed++;console.log('PASS V3, V4 and Ecosystem 30D queued together in one worker: all answered, no restart (small fixture)');
  }
  rmSync(dir,{recursive:true,force:true});
  console.log(JSON.stringify({windowScenarios:results,note:'small synthetic fixture: proves paths and cache key, not production timing'}));
}

codecChecks();passed++;
if(process.env.POOL_READ_CODEC_ONLY==='true'){console.log('PASS focused codec, oversized UTF-8 row and iterator interruption checks');process.exit(0);}
await windowScenarios();
if(!path){
  console.log(JSON.stringify({summary:{passed,failed:0},largeFixture:'skipped: POOL_READ_FIXTURE_PATH not set; timing on an existing large fixture not measured'}));
  process.exit(0);
}
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
    console.log(JSON.stringify({test:'baseline_source_reference',protocol,window,ms,...trace,nonSqlMs:ms-trace.sqlMs}));}
  finally {reference.close();}
  let workers=0;const workerTimes=[];
  const reader=createEcosystemReader({path,workerFactory:(url,options)=>{
    workers++;const w=new Worker(url,{...options,workerData:{...options.workerData,collectMetrics:true}});w.on('message',m=>{if(Number.isFinite(m.workerMs))workerTimes.push(m.workerMs);if(m.metrics){assertTelemetry(m.metrics);telemetry.push({protocol,window,workerMs:m.workerMs,...m.metrics});}});return w;
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
// Truly cold Ecosystem also uses the same enforced worker limit and is compared with the immutable reference.
{
  for(const ecoWindow of ['24h','7d','30d']) {
  const reference=old.createCompactReadModel({path,DatabaseSync});let answer;
  try{answer=reference.ecosystem(ecoWindow);}finally{reference.close();}
  const ctx=measuredReader(),at=performance.now();
  try{
    assert.deepEqual(await ctx.reader.read(ecoWindow),answer);passed++;
    console.log(JSON.stringify({test:'cold_ecosystem',window:ecoWindow,ms:performance.now()-at,workers:ctx.workers()}));
  } finally{await ctx.reader.close();}
  }
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
  // The responses are rebuilt (anchor() checks the checkpoint again), but the window's pool inputs are unchanged, so the
  // verified rows are reused by fingerprint instead of decoding every packed set again.
  const invalidationGets=trace.payloadGets,invalidationQueries=trace.queries;
  assert.deepEqual(stripFreshness(model.pools('v4','30d')),expected.get('v4:30d'));
  assert.deepEqual(stripFreshness(model.pools('v3','30d')),expected.get('v3:30d'));
  assert.ok(trace.queries>invalidationQueries,'the restored checkpoint rebuilds the responses');
  assert.equal(trace.payloadGets,invalidationGets,'unchanged pool inputs reuse the verified window');
  assert.deepEqual(writer.prepare('SELECT * FROM compact_checkpoint WHERE id=1').get(),checkpoint);passed++;
  console.log('PASS checkpoint commits invalidate cached responses; inconsistent checkpoint fails closed; unchanged pool inputs reuse the verified window');
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
    const fallbackMs=performance.now()-fallbackAt,record={test:'incorrect_hint_verified_fallback',ms:fallbackMs,nearDeadline:fallbackMs>=5000};
    console.log(JSON.stringify(record));
    if(fallbackMs>=ECOSYSTEM_READ_TIMEOUT_MS)failed.push(record);
  } finally {fallbackModel.close();}
  // An unrelated commit (as the discovery drain makes every minute) must not decode the verified window again.
  trace={queries:0,payloadGets:0,sqlMs:0};
  const memoModel=createCompactReadModel({path,DatabaseSync:TracedDatabase});
  try {
    assert.deepEqual(stripFreshness(memoModel.pools('v3','30d')),expected.get('v3:30d'));
    const gets=trace.payloadGets;
    writer.prepare("INSERT INTO compact_meta (key,value) VALUES ('pool-read-performance-unrelated','1')").run();
    const at=performance.now();
    assert.deepEqual(stripFreshness(memoModel.pools('v3','30d')),expected.get('v3:30d'));
    assert.deepEqual(stripFreshness(memoModel.pools('v4','30d')),expected.get('v4:30d'));
    assert.equal(trace.payloadGets,gets,'no packed set is decoded again after an unrelated commit');passed++;
    console.log(JSON.stringify({test:'unrelated_commit_keeps_verified_window',ms:performance.now()-at}));
  } finally {
    writer.prepare("DELETE FROM compact_meta WHERE key='pool-read-performance-unrelated'").run();memoModel.close();
  }
  // V3, V4 and Ecosystem 30D enqueued together in the one cold worker, each with its 6 s deadline from enqueue.
  {
    let workers=0;
    const reader=createEcosystemReader({path,workerFactory:(url,options)=>{workers++;return new Worker(url,options);}});
    try {
      const at=performance.now(),done={};
      const settled=await Promise.allSettled([['v3',()=>reader.readPools('v3','30d')],['v4',()=>reader.readPools('v4','30d')],['ecosystem',()=>reader.read('30d')]]
        .map(([job,run])=>run().then(value=>{done[job]=performance.now()-at;return value;},error=>{done[job]=`${error.code} after ${Math.round(performance.now()-at)} ms`;throw error;})));
      const record={test:'shared_worker_queue_30d',done,workers};
      console.log(JSON.stringify(record));
      if(workers!==1 || settled.some(result=>result.status!=='fulfilled'))failed.push(record);
      else {
        assert.deepEqual(stripFreshness(settled[0].value),expected.get('v3:30d'));assert.deepEqual(stripFreshness(settled[1].value),expected.get('v4:30d'));passed++;
      }
    } finally {await reader.close();}
  }
  // Run the real worker module, substituting only the SQLite constructor for a read-only wrong-hint regression.
  {
    const workerSource=readFileSync(new URL('../server/compact/ecosystem-worker.js',import.meta.url),'utf8')
      .replace("import { DatabaseSync } from 'node:sqlite';",`import { DatabaseSync as RealDatabase } from 'node:sqlite';
        class DatabaseSync extends RealDatabase { prepare(sql) {
          const s=super.prepare(sql);
          if(sql==='SELECT protocol,pool,swap_count FROM compact_packed_pool_swaps') {
            const it=s.iterate;s.iterate=function* (...args) {
              for(const r of it.apply(s,args))yield r.protocol===${JSON.stringify(hintRow.protocol)} && r.pool===${JSON.stringify(hintRow.pool)}
                ? {...r,swap_count:r.swap_count+1000000}:r;
            };
          }return s;
        }}`)
      .replace("from './read-model.js'",`from '${new URL('../server/compact/read-model.js',import.meta.url).href}'`);
    const ctx=measuredReader({workerURL:new URL('data:text/javascript;base64,'+Buffer.from(workerSource).toString('base64'))}),at=performance.now();
    try {
      assert.deepEqual(stripFreshness(await ctx.reader.readPools('v3','30d')),expected.get('v3:30d'));passed++;
      console.log(JSON.stringify({test:'incorrect_hint_cold_worker',ms:performance.now()-at,workers:ctx.workers()}));
    } finally {await ctx.reader.close();}
  }
  {
    const ctx=measuredReader(),at=performance.now(),done={};
    try {
      const results=await Promise.all(['v3','v4','ecosystem'].map(async job=>{
        let sent;
        await handleIntelligenceProxy({method:'GET',query:job==='ecosystem'?{view:'ecosystem',window:'30d'}:{view:'pools',protocol:job,window:'30d'},
          send:value=>{sent=value;},fetchImpl:async (_url,{signal})=>{
            const value=await (job==='ecosystem'?ctx.reader.read('30d'):ctx.reader.readPools(job,'30d'));
            await new Promise((resolve,reject)=>{
              const cancel=()=>{clearTimeout(timer);reject(Error('proxy_cancelled'));};
              const timer=setTimeout(()=>{signal.removeEventListener('abort',cancel);resolve();},500);
              signal.addEventListener('abort',cancel,{once:true});if(signal.aborted)cancel();
            });
            return new Response(JSON.stringify(value),{status:200,headers:{'content-type':'application/json'}});
          }});
        done[job]=performance.now()-at;assert.equal(sent.status,200);return JSON.parse(sent.body);
      }));
      assert.deepEqual(stripFreshness(results[0]),expected.get('v3:30d'));assert.deepEqual(stripFreshness(results[1]),expected.get('v4:30d'));
      assert.equal(ctx.workers(),1);assert.ok(Math.max(...Object.values(done))<8000);passed++;
      console.log(JSON.stringify({test:'unchanged_proxy_30d_queue',done,workers:ctx.workers(),simulatedDeliveryMs:500}));
    }finally{await ctx.reader.close();}
  }
  // Advance ONLY this isolated synthetic fixture by ONE hour, using the existing compact writer and existing rows.
  {
    const ctx=measuredReader();
    try {
      await ctx.reader.readPools('v3','30d');
      const beforeStats=telemetry.at(-1).proofCache;
      const prior=writer.prepare('SELECT * FROM compact_hours ORDER BY hour_start DESC LIMIT 1').get();
      const range={kind:'hour',hourStart:prior.hour_start+HOUR,hourEnd:prior.hour_start+2*HOUR,
        firstBlock:prior.last_block+1,lastBlock:prior.last_block+10,parentHash:prior.last_hash,
        firstHash:hash(prior.last_block+1),lastHash:hash(prior.last_block+10)};
      const store=createCompactStore(writer,{packedShards:{config:{enabled:false},log:()=>{}}});
      store.commitHour({definitionVersion:COMPACT_DEFINITION_VERSION,sourceVersions:{},chainId:5042,range,complete:false,
        network:JSON.parse(prior.network_json),activeAddresses:[],families:Object.fromEntries(Object.entries(FAMILY_FIELDS).map(([name,fields])=>
          [name,{status:'unavailable',reason:'synthetic_fixture',...Object.fromEntries(fields.map(f=>[f,null]))}])),registry:{uniswapV3:null}});
      checkpoint=writer.prepare('SELECT * FROM compact_checkpoint WHERE id=1').get();
      writer.exec('BEGIN');
      try {
        for(const table of ['compact_pool_hours','compact_projection_hours','compact_valuation_hours','compact_token_price_hours',
          'compact_dex_volume_hours','compact_dex_fee_hours','compact_pool_tvl_hours']) {
          const columns=writer.prepare(`PRAGMA table_info(${table})`).all().map(c=>c.name);
          if(!columns.length)continue;
          writer.prepare(`INSERT INTO ${table} (${columns.join(',')}) SELECT ${columns.map(c=>c==='hour_start'?'?':c).join(',')}
            FROM ${table} WHERE hour_start=?`).run(BigInt(range.hourStart),BigInt(prior.hour_start));
        }
        writer.prepare('UPDATE compact_registry_coverage SET through_block=?,through_hash=?').run(BigInt(range.lastBlock),range.lastHash);
        writer.exec('COMMIT');
      } catch(e){writer.exec('ROLLBACK');throw e;}
      const packed=createPackedShards(writer,{config:{enabled:true,retention:true,hotHours:48},log:()=>{}});
      packed.begin();writer.exec('BEGIN');const prune=packed.maintain(range.hourStart,{limit:16});writer.exec('COMMIT');
      assert.deepEqual(prune.failed,[]);
      const reference=old.createCompactReadModel({path,DatabaseSync}),advanced={};
      try{for(const p of ['v3','v4'])advanced[p]=stripFreshness(reference.pools(p,'30d'));advanced.ecosystem=reference.ecosystem('30d');}
      finally{reference.close();}
      const at=performance.now(),done={},sampleStart=telemetry.length;
      const answers=await Promise.all([['v3',()=>ctx.reader.readPools('v3','30d')],['v4',()=>ctx.reader.readPools('v4','30d')],
        ['ecosystem',()=>ctx.reader.read('30d')]].map(([job,run])=>run().then(value=>{done[job]=performance.now()-at;return value;})));
      assert.deepEqual(stripFreshness(answers[0]),advanced.v3);assert.deepEqual(stripFreshness(answers[1]),advanced.v4);
      assert.deepEqual(answers[2],advanced.ecosystem);assert.equal(ctx.workers(),1);
      const poolStats=telemetry[sampleStart].proofCache;
      assert.ok(poolStats.hits>beforeStats.hits+500,'overlapping historical hours reuse their byte-identical proofs');
      assert.ok(poolStats.verifiedSets-beforeStats.verifiedSets<=16,'only newly pruned scopes need a full typed-row digest');
      assert.ok(Math.max(...Object.values(done))<ECOSYSTEM_RESPONSE_TIMEOUT_MS);passed++;
      console.log(JSON.stringify({test:'advanced_hour_30d',done,workers:ctx.workers(),prune,
        reused:poolStats.hits-beforeStats.hits,newFullVerifications:poolStats.verifiedSets-beforeStats.verifiedSets,proofCache:poolStats}));
      await ctx.reader.close();
      const restarted=measuredReader(),restartAt=performance.now();
      try {
        assert.deepEqual(stripFreshness(await restarted.reader.readPools('v3','30d')),advanced.v3);
        const metrics=telemetry.at(-1);assert.ok(metrics.proofCache.verifiedSets>500,'a restarted worker has no cached proof');passed++;
        console.log(JSON.stringify({test:'advanced_hour_cold_restart',ms:performance.now()-restartAt,metrics}));
      }finally{await restarted.reader.close();}
      // This fixture is disposable: preserve its NEW valid checkpoint, not the old 900-hour anchor.
      checkpoint=writer.prepare('SELECT * FROM compact_checkpoint WHERE id=1').get();
    } finally {await ctx.reader.close();}
  }
} finally {
  if(writer && checkpoint) writer.prepare('UPDATE compact_checkpoint SET hour_start=? WHERE id=1 AND hour_start!=?').run(checkpoint.hour_start,checkpoint.hour_start);
  writer?.close();model.close();
}
for(const record of telemetry)assertTelemetry(record);
console.log(JSON.stringify({workerTelemetry:telemetry}));
console.log(JSON.stringify({summary:{passed,failed:failed.length,timings},workerDeadlineMs:6000,responseDeadlineMs:7000,proxyDeadlineMs:8000,noRetry:true}));
if(failed.length)process.exitCode=1;
