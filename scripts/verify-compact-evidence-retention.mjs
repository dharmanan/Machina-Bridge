// Node 24 only: disposable SQLite, generated evidence, no external network or historical execution.
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync,rmSync,statSync,existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fork,spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { createCompactStore } from '../server/compact/store.js';
import { archiveConfig,archivedRows,createEvidenceArchive,storagePreflight } from '../server/compact/evidence-archive.js';
import { FAMILY_FIELDS } from '../server/compact/families.js';
import { COMPACT_DEFINITION_VERSION,LOG_STREAMS } from '../server/compact/sources.js';
import { PROJECTIONS } from '../server/compact/projections.js';
import { acquireWriterLock } from '../server/compact/writer-lock.js';
import { createSyntheticChain } from '../server/compact/offline.js';
import { createProvider } from '../server/compact/provider.js';
import { processBlockRange } from '../server/compact/hour.js';
import { headerOf } from '../server/compact/spine.js';
import { intelligenceRegistry,registryDigest } from '../server/compact/intelligence-registry.js';
import { recoveryHourPlan,recoverDiscoveryHour } from '../server/compact/discovery-recovery.js';
import { runDiscoveryRecovery } from './recover-compact-discovery.mjs';
import { runDailyActiveReplay } from './replay-compact-dau-hour.mjs';
import { createCompactReadModel } from '../server/compact/read-model.js';

globalThis.fetch=async()=>{throw new Error('external_network_forbidden');};
const BASE=Date.parse('2026-10-09T00:00:00Z')/1000;
const address=n=>`0x${n.toString(16).padStart(40,'0')}`;
const hash=n=>`0x${n.toString(16).padStart(64,'0')}`;
const capacity=()=>({freeBytes:10*1024**3,databaseBytes:0});
const options={config:{...archiveConfig({COMPACT_EVIDENCE_ARCHIVE_ENABLED:'true'}),maxTransactionMs:2000},capacity,log:()=>{}};
const config=options.config;
let passed=0;
const test=async(name,fn)=>{if(process.env.RETENTION_TEST_FILTER&&!name.includes(process.env.RETENTION_TEST_FILTER))return;await fn();passed++;console.log(`PASS ${name}`);};
function fakeHour(i,{identities=[address(1)],projections=false}={}){
  const hourStart=BASE+i*3600,block=100+i;
  return{definitionVersion:COMPACT_DEFINITION_VERSION,chainId:5042,sourceVersions:{},complete:false,
    range:{kind:'hour',hourStart,hourEnd:hourStart+3600,firstBlock:block,lastBlock:block,parentHash:hash(block-1),firstHash:hash(block),lastHash:hash(block)},
    network:{status:'available',blockCount:1,transactionCount:2,uniqueActiveAddresses:identities.length,gasUsedRaw:'42000'},activeAddresses:identities,
    families:Object.fromEntries(Object.entries(FAMILY_FIELDS).map(([name,fields])=>[name,{status:'unavailable',reason:'fixture',...Object.fromEntries(fields.map(f=>[f,null]))}])),
    registry:{uniswapV3:null},...(projections?{projections:Object.fromEntries(PROJECTIONS.map(p=>[p,{status:'unavailable',reason:'family_unavailable'}]))}:{})};
}
function fixture({path=':memory:',archive=options}={}){
  const db=new DatabaseSync(path),store=createCompactStore(db,{archive});store.commitHour(fakeHour(0));return{db,store};
}
function transaction(f,fn){f.store.archive.begin();f.db.exec('BEGIN IMMEDIATE');try{const v=fn();f.db.exec('COMMIT');return v;}catch(e){f.db.exec('ROLLBACK');throw e;}}
const count=(db,t,where='')=>db.prepare(`SELECT COUNT(*) AS n FROM ${t} ${where}`).get().n;
const rows=(db,t)=>db.prepare(`SELECT * FROM ${t} ORDER BY 1,2`).all();
const normalize=value=>typeof value==='bigint'?Number.isSafeInteger(Number(value))?Number(value):String(value)
  :ArrayBuffer.isView(value)?{blob:Buffer.from(value).toString('hex')}:Array.isArray(value)?value.map(normalize)
  :value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(k=>[k,normalize(value[k])])):value;
const normalized=value=>JSON.stringify(normalize(value));
function insert(db,t,row){const keys=Object.keys(row);db.prepare(`INSERT INTO ${t}(${keys.join(',')}) VALUES(${keys.map(()=>'?').join(',')})`).run(...keys.map(k=>row[k]));}
const oldRows={
  compact_pool_hours:{hour_start:BASE,protocol:'uniswap_v3',pool:address(10),swap_count:1,token0_in_raw:'123456789012345678901234567890',token0_out_raw:'0',token1_in_raw:'0',token1_out_raw:'7',add_count:1,remove_count:0,poke_count:0,add_amount0_raw:'8',add_amount1_raw:'9',remove_amount0_raw:'0',remove_amount1_raw:'0'},
  compact_pool_price_hours:{hour_start:BASE,protocol:'uniswap_v3',pool:address(10),swap_count:1,first_swap_block:100,last_swap_block:100,priced_blocks:1,close_sqrt_price_x96:'79228162514264337593543950336',close_liquidity:'1234567890123456789012',sqrt_price_block_sum:'79228162514264337593543950336',reserve0_block_sum:'1234567890123456789012',reserve1_block_sum:'1234567890123456789012'},
  compact_pool_fee_hours:{hour_start:BASE,pool:hash(10),swap_count:1,fee_in0_e6:'123456789012345678901234',fee_in1_e6:'0',fee_out0_e12:'0',fee_out1_e12:'42'},
  compact_pool_tvl_hours:{hour_start:BASE,protocol:'uniswap_v3',pool:address(10),status:'unavailable',reason:'fixture_unavailable',amount0_raw:null,amount1_raw:null,block_number:100},
  compact_token_price_hours:{hour_start:BASE,token:address(11),price_usd_e18:'123456789012345678',source_protocol:'uniswap_v3',source_pool:address(10),depth_usd_micros:'1234567890123456789',source_count:1},
  compact_dex_volume_hours:{hour_start:BASE,protocol:'uniswap_v3',volume_usd_micros:'1234567890123456789',valued_swaps:1,unvalued_swaps:2},
  compact_dex_fee_hours:{hour_start:BASE,protocol:'uniswap_v3',fee_usd_micros:'1234567890123456789',valued_swaps:1,unvalued_swaps:2},
};
function activity(n){return{block_number:100,log_index:n,hour_start:BASE,block_timestamp:BASE+1,tx_hash:hash(n+1),tx_from:address(2),protocol:'uniswap_v3',kind:'swap',pool:address(10),amount0_raw:'123456789012345678901234567890',amount1_raw:'-17',amount_basis:'v3_pool_delta',counterparty:null,counterparty_kind:'none'};}

if(process.env.RETENTION_CRASH_CHILD){
  const f=fixture({path:process.env.RETENTION_CRASH_CHILD});
  f.store.archive.begin();f.db.exec('BEGIN IMMEDIATE');f.store.archive.prune('compact_hour_addresses','hour_start=?',[BASE]);
  if(process.env.RETENTION_CRASH_PHASE==='after')f.db.exec('COMMIT');
  process.send('ready');await new Promise(()=>{});
}

await test('feature flags default OFF; read-only preflight fails closed and validates configured limits',()=>{
  assert.equal(archiveConfig({}).enabled,false);assert.throws(()=>archiveConfig({COMPACT_EVIDENCE_ARCHIVE_ENABLED:'yes'}));
  assert.throws(()=>archiveConfig({COMPACT_ARCHIVE_MAX_TRANSACTION_MIB:'999'}));
  const f=fixture({archive:{config:archiveConfig({}),log:()=>{}}});
  const before=rows(f.db,'compact_evidence_archive');assert.equal(storagePreflight(f.db,config).reason,'storage_capacity_unknown');
  assert.equal(storagePreflight(f.db,config,{capacity:()=>({freeBytes:1,databaseBytes:0})}).reason,'storage_low_space');
  assert.equal(storagePreflight(f.db,config,{capacity:()=>({freeBytes:10*1024**3,databaseBytes:config.maxDatabaseBytes+1})}).reason,'storage_database_budget');
  assert.deepEqual(rows(f.db,'compact_evidence_archive'),before);f.db.close();
});
await test('address deletion path: two separate commits, lossless 20-byte membership, restart and idempotency',()=>{
  const f=fixture(),before=rows(f.db,'compact_hour_addresses');
  assert.equal(f.db.prepare('PRAGMA synchronous').get().synchronous,2,'activated archive uses FULL commit durability');
  transaction(f,()=>f.store.archive.prune('compact_hour_addresses','hour_start=?',[BASE]));
  assert.equal(count(f.db,'compact_hour_addresses'),1);assert.equal(count(f.db,'compact_evidence_archive'),1);
  assert.equal(normalized(archivedRows(f.db,'compact_hour_addresses',BASE)),normalized(before));
  transaction(f,()=>f.store.archive.prune('compact_hour_addresses','hour_start=?',[BASE]));assert.equal(count(f.db,'compact_hour_addresses'),0);
  transaction(f,()=>f.store.archive.prune('compact_hour_addresses','hour_start=?',[BASE]));assert.equal(count(f.db,'compact_evidence_archive'),1);f.db.close();
});
for(const table of Object.keys(oldRows))await test(`${table} deletion path preserves exact values and nulls before expiry`,()=>{
  const f=fixture();insert(f.db,table,oldRows[table]);const before=rows(f.db,table);
  transaction(f,()=>f.store.archive.prune(table,'hour_start<=?',[BASE]));assert.equal(count(f.db,table),1);
  assert.equal(normalized(archivedRows(f.db,table,BASE)),normalized(before));
  transaction(f,()=>f.store.archive.prune(table,'hour_start<=?',[BASE]));assert.equal(count(f.db,table),0);f.db.close();
});
await test('activity deletion path retains exact accepted subset while hot feed remains newest 500',()=>{
  const f=fixture();for(let i=0;i<501;i++)insert(f.db,'compact_dex_activity',activity(i));
  const where="kind=? AND (block_number,log_index) NOT IN(SELECT block_number,log_index FROM compact_dex_activity WHERE kind=? ORDER BY block_number DESC,log_index DESC LIMIT 500)";
  transaction(f,()=>f.store.archive.prune('compact_dex_activity',where,['swap','swap']));assert.equal(count(f.db,'compact_dex_activity'),501);
  transaction(f,()=>f.store.archive.prune('compact_dex_activity',where,['swap','swap']));assert.equal(count(f.db,'compact_dex_activity'),500);
  assert.equal(archivedRows(f.db,'compact_dex_activity',BASE)[0].log_index,0);assert.equal(f.store.recentActivity('swap')[0].logIndex,500);f.db.close();
});
await test('projection and valuation deletion paths are replaced by permanent indexed status evidence',()=>{
  const f=fixture();insert(f.db,'compact_projection_hours',{hour_start:BASE,projection:'uniswap_v3_pools',status:'unavailable',reason:'recorded_failure',row_count:null,rows_sha256:null});
  insert(f.db,'compact_valuation_hours',{hour_start:BASE,valuation:'token_prices',status:'unavailable',reason:'recorded_failure',row_count:null,rows_sha256:null});
  for(const [t,r]of Object.entries(oldRows))insert(f.db,t,r);
  const cp=rows(f.db,'compact_hours')[0];
  for(let i=1;i<=841;i++)f.store.commitHour(fakeHour(i,{projections:true}));
  for(const t of Object.keys(oldRows)){assert.equal(count(f.db,t),0);assert.equal(normalized(archivedRows(f.db,t,BASE)),normalized([oldRows[t]]));}
  assert.equal(f.db.prepare('SELECT reason FROM compact_projection_hours WHERE hour_start=? AND projection=?').get(BASE,'uniswap_v3_pools').reason,'recorded_failure');
  assert.equal(f.db.prepare('SELECT reason FROM compact_valuation_hours WHERE hour_start=? AND valuation=?').get(BASE,'token_prices').reason,'recorded_failure');
  assert.deepEqual(f.db.prepare('SELECT * FROM compact_hours WHERE hour_start=?').get(BASE),cp);f.db.close();
});
await test('DAU stage and captured-hour deletion paths preserve finalized membership and remain resumable',()=>{
  const f=fixture();for(let i=1;i<24;i++)f.store.commitHour(fakeHour(i,{identities:[address(i+1)]}));
  assert.equal(count(f.db,'compact_daily_address_stage'),24);assert.equal(count(f.db,'compact_daily_address_hours'),24);
  assert.equal(f.db.prepare('SELECT active_addresses FROM compact_daily_active_addresses WHERE day_start=?').get(BASE).active_addresses,24);
  f.store.commitHour(fakeHour(24));
  assert.equal(count(f.db,'compact_daily_address_stage',`WHERE day_start=${BASE}`),0);assert.equal(count(f.db,'compact_daily_address_hours',`WHERE day_start=${BASE}`),0);
  assert.equal(archivedRows(f.db,'compact_daily_address_stage',BASE).length,24);assert.equal(archivedRows(f.db,'compact_daily_address_hours',BASE).length,24);f.db.close();
});
await test('20,000-address daily evidence remains lossless under the bounded writer heap and row budget',()=>{
  const db=new DatabaseSync(':memory:'),store=createCompactStore(db,{archive:options});
  const identities=Array.from({length:20000},(_,i)=>address(i+1));
  const first=fakeHour(0,{identities});first.network.transactionCount=identities.length;store.commitHour(first);
  for(let i=1;i<=26;i++)store.commitHour(fakeHour(i,{identities:[]}));
  assert.equal(db.prepare('SELECT active_addresses FROM compact_daily_active_addresses WHERE day_start=?').get(BASE).active_addresses,20000);
  assert.equal(archivedRows(db,'compact_daily_address_stage',BASE).length,20000);
  assert.deepEqual(store.persistedActiveAddresses(BASE),identities.sort());db.close();
});
await test('DAU unavailable-status deletion path becomes nondestructive replay upgrade with permanent failure reason',()=>{
  const f=fixture({archive:{config:archiveConfig({}),log:()=>{}}});for(let i=1;i<24;i++)f.store.commitHour(fakeHour(i));
  f.db.exec('DELETE FROM compact_daily_active_addresses; DELETE FROM compact_daily_address_hours; DELETE FROM compact_daily_address_stage'); // disposable legacy gap
  insert(f.db,'compact_daily_active_addresses',{day_start:BASE,status:'unavailable',reason:'identity_not_captured',active_addresses:null});
  for(let i=0;i<24;i++)f.store.replayDailyActiveAddresses(BASE+i*3600,[address(i+1)]);
  assert.equal(f.db.prepare('SELECT active_addresses FROM compact_daily_active_addresses WHERE day_start=?').get(BASE).active_addresses,24);
  assert.equal(f.db.prepare('SELECT reason FROM compact_daily_address_status_history WHERE day_start=?').get(BASE).reason,'identity_not_captured');f.db.close();
});
await test('OFF archives nothing and retains eligible originals while live indexing and 24H accuracy continue',()=>{
  const f=fixture({archive:{config:archiveConfig({}),log:()=>{}}});for(let i=1;i<27;i++)f.store.commitHour(fakeHour(i));
  assert.equal(count(f.db,'compact_hour_addresses'),27);assert.equal(count(f.db,'compact_evidence_archive'),0);
  assert.equal(f.store.uniqueActiveAddresses(BASE+26*3600,24),1);assert.equal(f.store.checkpoint().hourStart,BASE+26*3600);f.db.close();
});
await test('low space, unknown capacity, archive quota, daily quota and workload exhaustion retain original records',()=>{
  for(const archive of [
    {...options,capacity:()=>({freeBytes:0,databaseBytes:0})},
    {...options,capacity:()=>{throw Error('unknown');}},
    {...options,config:{...config,maxArchiveBytes:1}},
    {...options,config:{...config,maxDailyBytes:1}},
    {...options,config:{...config,maxTransactionRows:0}},
    {...options,config:{...config,maxTransactionBytes:1}},
    {...options,config:{...config,maxTransactionSets:0}},
    {...options,config:{...config,maxTransactionMs:0}},
  ]){const f=fixture({archive});transaction(f,()=>f.store.archive.prune('compact_hour_addresses','hour_start=?',[BASE]));
    assert.equal(count(f.db,'compact_hour_addresses'),1);assert.equal(count(f.db,'compact_evidence_archive'),0);assert.ok(f.store.archive.report().failures.length);f.db.close();}
});
await test('transaction rollback never commits a partial archive, quota counter or deletion',()=>{
  const f=fixture(),before=rows(f.db,'compact_evidence_archive_usage');
  assert.throws(()=>transaction(f,()=>{f.store.archive.prune('compact_hour_addresses','hour_start=?',[BASE]);throw Error('crash');}));
  assert.equal(count(f.db,'compact_evidence_archive'),0);assert.equal(count(f.db,'compact_evidence_archive_parts'),0);assert.deepEqual(rows(f.db,'compact_evidence_archive_usage'),before);
  transaction(f,()=>f.store.archive.prune('compact_hour_addresses','hour_start=?',[BASE]));
  assert.throws(()=>transaction(f,()=>{f.store.archive.prune('compact_hour_addresses','hour_start=?',[BASE]);throw Error('crash_after_delete');}));
  assert.equal(count(f.db,'compact_hour_addresses'),1);assert.equal(count(f.db,'compact_evidence_archive'),1);f.db.close();
});
await test('a second controller cannot treat an uncommitted archive as durable or reset transaction tracking',()=>{
  const f=fixture();transaction(f,()=>{
    f.store.archive.prune('compact_hour_addresses','hour_start=?',[BASE]);
    const other=createEvidenceArchive(f.db,options);
    assert.throws(()=>other.begin(),/archive_begin_requires_closed_transaction/);
    other.prune('compact_hour_addresses','hour_start=?',[BASE]);assert.equal(count(f.db,'compact_hour_addresses'),1);
  });assert.equal(count(f.db,'compact_hour_addresses'),1);f.db.close();
});
await test('archive immutability, independent checksum verification and corrupted archive fail closed',()=>{
  const f=fixture();transaction(f,()=>f.store.archive.prune('compact_hour_addresses','hour_start=?',[BASE]));
  assert.throws(()=>f.db.exec("UPDATE compact_evidence_archive SET row_count=0"),/immutable/);assert.throws(()=>f.db.exec('DELETE FROM compact_evidence_archive_parts'),/immutable/);
  assert.throws(()=>f.db.exec('INSERT OR REPLACE INTO compact_evidence_archive SELECT * FROM compact_evidence_archive'),/immutable/);
  assert.throws(()=>f.db.exec('INSERT OR REPLACE INTO compact_evidence_archive_parts SELECT * FROM compact_evidence_archive_parts'),/immutable/);
  f.db.exec('DROP TRIGGER compact_archive_part_no_update');f.db.prepare('UPDATE compact_evidence_archive_parts SET payload=?').run(Buffer.from('corrupt')); // disposable fault
  assert.throws(()=>archivedRows(f.db,'compact_hour_addresses',BASE));transaction(f,()=>f.store.archive.prune('compact_hour_addresses','hour_start=?',[BASE]));
  assert.equal(count(f.db,'compact_hour_addresses'),1);assert.ok(f.store.archive.report().failures.includes('archive_part_corrupt'));f.db.close();
});
await test('canonical identity conflict prevents archive reuse and deletion',()=>{
  const f=fixture();transaction(f,()=>f.store.archive.prune('compact_hour_addresses','hour_start=?',[BASE]));
  f.db.prepare('UPDATE compact_hours SET last_hash=? WHERE hour_start=?').run(hash(900),BASE); // disposable corruption
  assert.throws(()=>archivedRows(f.db,'compact_hour_addresses',BASE),/archive_canonical_conflict/);
  transaction(f,()=>f.store.archive.prune('compact_hour_addresses','hour_start=?',[BASE]));assert.equal(count(f.db,'compact_hour_addresses'),1);f.db.close();
});
await test('changed immutable hot evidence conflicts with a committed archive instead of silently replacing proof',()=>{
  const f=fixture();insert(f.db,'compact_pool_hours',oldRows.compact_pool_hours);
  transaction(f,()=>f.store.archive.prune('compact_pool_hours','hour_start=?',[BASE]));
  f.db.exec("UPDATE compact_pool_hours SET token0_in_raw='999'"); // disposable fault
  transaction(f,()=>f.store.archive.prune('compact_pool_hours','hour_start=?',[BASE]));
  assert.equal(count(f.db,'compact_pool_hours'),1);assert.equal(count(f.db,'compact_evidence_archive'),1);
  assert.ok(f.store.archive.report().failures.includes('archive_evidence_conflict'));f.db.close();
});
await test('failed archive INSERT rolls back its manifest and parts while the live transaction keeps originals',()=>{
  const f=fixture();f.db.exec("CREATE TRIGGER disposable_archive_failure BEFORE INSERT ON compact_evidence_archive_parts BEGIN SELECT RAISE(ABORT,'test_failure'); END");
  transaction(f,()=>f.store.archive.prune('compact_hour_addresses','hour_start=?',[BASE]));
  assert.equal(count(f.db,'compact_hour_addresses'),1);assert.equal(count(f.db,'compact_evidence_archive'),0);assert.equal(count(f.db,'compact_evidence_archive_parts'),0);f.db.close();
});
await test('DAU replay reuses complete archived membership with zero RPC and preserves its checkpoint',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'retention-dau-')),path=join(dir,'test.sqlite');const f=fixture({path});
  try{
    for(let i=1;i<27;i++)f.store.commitHour(fakeHour(i,{identities:[address(i+1)]}));
    assert.equal(count(f.db,'compact_hour_addresses',`WHERE hour_start=${BASE}`),0);
    assert.deepEqual(f.store.persistedActiveAddresses(BASE),[address(1)]);
    f.db.exec('DELETE FROM compact_daily_active_addresses WHERE day_start='+BASE+'; DELETE FROM compact_daily_address_hours WHERE day_start='+BASE+'; DELETE FROM compact_daily_address_stage WHERE day_start='+BASE); // disposable legacy gap
    insert(f.db,'compact_daily_active_addresses',{day_start:BASE,status:'unavailable',reason:'identity_not_captured',active_addresses:null});
    const cp=f.store.checkpoint();f.db.close();
    let requests=0;const result=await runDailyActiveReplay({sqlitePath:path,hourStart:BASE,provider:{request(){requests++;throw Error('RPC_forbidden');},batch(){requests++;throw Error('RPC_forbidden');}},print:()=>{}});
    assert.equal(result.ok,true);assert.equal(requests,0);
    const reopened=new DatabaseSync(path,{readOnly:true});assert.equal(reopened.prepare('SELECT hour_start FROM compact_checkpoint').get().hour_start,cp.hourStart);reopened.close();
  }finally{try{f.db.close();}catch{}rmSync(dir,{recursive:true,force:true});}
});
await test('large typed values, chunk boundaries, exact integers and explicit empty snapshots round trip',()=>{
  const f=fixture(),data=Array.from({length:700},(_,i)=>({key:`synthetic-${i}`,value:'€'.repeat(1000)}));
  transaction(f,()=>f.store.archive.preserve('compact_meta',BASE,data,{scope:'test'}));
  assert.ok(count(f.db,'compact_evidence_archive_parts')>1);assert.equal(normalized(archivedRows(f.db,'compact_meta',BASE)),normalized([...data].sort((a,b)=>a.key.localeCompare(b.key))));
  transaction(f,()=>f.store.archive.preserve('compact_pool_hours',BASE,[],{scope:'explicit_empty_snapshot'}));assert.deepEqual(archivedRows(f.db,'compact_pool_hours',BASE),[]);f.db.close();
});
await test('process death before and after archive COMMIT leaves originals recoverable; restart only prunes committed evidence',async()=>{
  for(const phase of ['before','after']){
    const dir=mkdtempSync(join(tmpdir(),'retention-crash-')),path=join(dir,'test.sqlite');let child;
    try{
      child=fork(new URL(import.meta.url),[],{env:{...process.env,RETENTION_CRASH_CHILD:path,RETENTION_CRASH_PHASE:phase},stdio:['ignore','ignore','ignore','ipc']});
      await Promise.race([once(child,'message'),new Promise((_,reject)=>{const t=setTimeout(()=>reject(Error('child_timeout')),5000);t.unref();})]);
      const exited=once(child,'exit');child.kill('SIGKILL');await exited;
      const f={db:new DatabaseSync(path)};f.store=createCompactStore(f.db,{archive:options});assert.equal(count(f.db,'compact_hour_addresses'),1);
      assert.equal(count(f.db,'compact_evidence_archive'),phase==='after'?1:0);
      transaction(f,()=>f.store.archive.prune('compact_hour_addresses','hour_start=?',[BASE]));
      assert.equal(count(f.db,'compact_hour_addresses'),phase==='after'?0:1);f.db.close();
    }finally{child?.kill('SIGKILL');rmSync(dir,{recursive:true,force:true});}
  }
});
await test('writer-lock contention prevents background recovery before RPC or writes',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'retention-lock-')),path=join(dir,'test.sqlite'),f=fixture({path});f.db.close();
  const lock=acquireWriterLock(path,{owner:'disposable-live-writer'});let calls=0;
  try{const result=await runDiscoveryRecovery({sqlitePath:path,execute:true,hourStart:BASE},{print:()=>{},providerFactory:()=>{calls++;throw Error('RPC_forbidden');}});
    assert.equal(result.reason,'writer_lock_held');assert.equal(calls,0);
  }finally{lock.release();rmSync(dir,{recursive:true,force:true});}
});
await test('read-only storage CLI cannot create a database or activate archival',()=>{
  const dir=mkdtempSync(join(tmpdir(),'retention-inspect-')),path=join(dir,'test.sqlite'),f=fixture({path});
  try{
    const before=rows(f.db,'compact_evidence_archive_usage'),hours=rows(f.db,'compact_hours');
    const run=spawnSync(process.execPath,[new URL('./inspect-compact-storage.mjs',import.meta.url).pathname],
      {env:{...process.env,COMPACT_SQLITE_PATH:path,COMPACT_EVIDENCE_ARCHIVE_ENABLED:'false'},encoding:'utf8'});
    assert.equal(run.status,0,run.stderr);const report=JSON.parse(run.stdout);assert.equal(report.mode,'read_only');assert.equal(report.archiveEnabled,false);
    assert.deepEqual(rows(f.db,'compact_evidence_archive_usage'),before);assert.deepEqual(rows(f.db,'compact_hours'),hours);
    const missing=join(dir,'missing.sqlite');const refused=spawnSync(process.execPath,[new URL('./inspect-compact-storage.mjs',import.meta.url).pathname],
      {env:{...process.env,COMPACT_SQLITE_PATH:missing},encoding:'utf8'});
    assert.notEqual(refused.status,0);assert.equal(existsSync(missing),false);
  }finally{f.db.close();rmSync(dir,{recursive:true,force:true});}
});
await test('low-space discovery execution exits before provider construction, leases or recovery writes',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'retention-low-space-')),path=join(dir,'test.sqlite'),f=fixture({path});
  const before=rows(f.db,'compact_meta');f.db.close();let providers=0;
  try{
    const result=await runDiscoveryRecovery({sqlitePath:path,execute:true,hourStart:BASE},{print:()=>{},capacity:()=>({freeBytes:0,databaseBytes:0}),
      providerFactory:()=>{providers++;throw Error('RPC_forbidden');}});
    assert.equal(result.reason,'storage_low_space');assert.equal(providers,0);
    const read=new DatabaseSync(path,{readOnly:true});assert.deepEqual(rows(read,'compact_meta'),before);read.close();
  }finally{rmSync(dir,{recursive:true,force:true});}
});
await test('end to end: live indexing, hot expiry, archived unit validation, registry change and only-new-source recovery',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'retention-e2e-')),path=join(dir,'test.sqlite');let db,model;
  try{
    db=new DatabaseSync(path);const store=createCompactStore(db,{archive:options});
    const oldRegistry=intelligenceRegistry({launches:[]}),origin=23_000_000;
    const chain=createSyntheticChain({originNumber:origin,originTimestamp:BASE,blockSpacing:3_600_000,poolCreatedAt:origin,factoryDeployedAt:origin-1,protocols:false,txPerBlock:2,v4PerBlock:1,usdcPerBlock:1});
    const provider=createProvider({fetchImpl:chain.fetchImpl,sleep:async()=>{},minIntervalMs:0,maxAttempts:1});
    store.extendRegistry({kind:'uniswap_v3_pool',previousThrough:null,fromBlock:1_948_018,through:origin-1,throughHash:chain.rawBlock(origin-1,false).hash,created:[]});
    const initial=await processBlockRange({provider,first:origin,last:origin+9,before:headerOf(chain.rawBlock(origin-1,false),origin-1),after:headerOf(chain.rawBlock(origin+10,false),origin+10),
      hourStart:BASE,hourEnd:BASE+3600,intelligenceRegistry:oldRegistry,v3Registry:store.v3Registry(),streams:LOG_STREAMS.filter(s=>['v3Factory','v3Pools','v4'].includes(s.key))});
    store.commitHour(initial);const original=db.prepare('SELECT * FROM compact_hours WHERE hour_start=?').get(BASE);
    for(let i=1;i<=26;i++){
      const next=fakeHour(i);next.range.firstBlock=origin+9+i;next.range.lastBlock=origin+9+i;next.range.firstHash=hash(origin+9+i);next.range.lastHash=hash(origin+9+i);next.range.parentHash=i===1?initial.range.lastHash:hash(origin+8+i);
      store.commitHour(next);
    }
    assert.equal(count(db,'compact_hour_addresses',`WHERE hour_start=${BASE}`),0);assert.equal(archivedRows(db,'compact_hour_addresses',BASE).length,initial.activeAddresses.length);
    db.prepare("DELETE FROM compact_meta WHERE key GLOB ?").run(`discovery_unit:${BASE}:*`); // disposable loss of hot unit copies: archive is now the only complete unit evidence.
    const source={id:'added',chainId:5042,address:address(800),version:'test-v1',source:'synthetic_only',verificationBasis:'disposable_fixture',validFromBlock:0,classification:'verified_factory',codeAssumption:'present_at_window_end',events:[{declaration:'event Created(address indexed token)',tokenField:'token'}]};
    const updated=intelligenceRegistry({launches:[source]});const plan=recoveryHourPlan(db,BASE,{registry:updated});
    assert.equal(plan.units.filter(u=>u.phase==='pending').length,1);assert.equal(plan.units.find(u=>u.kind==='launch').phase,'pending');
    const cp=store.checkpoint(),calls=[];
    const result=await recoverDiscoveryHour({db,hourStart:BASE,registry:updated,recoverUnit:async({unit})=>{calls.push(unit.kind);return{status:'available',reason:null,evidence:{candidates:[],firstDex:[],entry:{kind:'launch',id:source.id,version:source.version,source:source.source,address:source.address,verificationBasis:source.verificationBasis,status:'available',reason:null,counts:{},rawFlows:{}}}};}});
    assert.equal(result.phase,'recovered');assert.deepEqual(calls,['launch']);assert.deepEqual(store.checkpoint(),cp);assert.deepEqual(db.prepare('SELECT * FROM compact_hours WHERE hour_start=?').get(BASE),original);
    assert.equal(count(db,'compact_intelligence_hours',`WHERE hour_start=${BASE}`),2);assert.equal(recoveryHourPlan(db,BASE,{registry:updated}).phase,'recovered');
    // Prove corruption in the archived unit is detected even while the original hot unit still exists.
    const record=db.prepare("SELECT archive_id FROM compact_evidence_archive WHERE dataset='compact_meta' LIMIT 1").get();
    db.exec('DROP TRIGGER compact_archive_part_no_update');db.prepare('UPDATE compact_evidence_archive_parts SET payload=? WHERE archive_id=?').run(Buffer.from('corrupt'),record.archive_id);
    assert.equal(recoveryHourPlan(db,BASE,{registry:updated}).phase,'blocked');
    model=createCompactReadModel({path,DatabaseSync});for(const window of ['24h','7d','30d']){const s=model.summary(window);assert.equal(s.window.key,window);assert.ok(s.network);}
    console.log(`E2E old=${registryDigest(oldRegistry).slice(0,12)} new=${registryDigest(updated).slice(0,12)} reused=3 new_source=1 unrelated_rpc=0`);
  }finally{model?.close();db?.close();rmSync(dir,{recursive:true,force:true});}
});
await test('local archive storage measurement uses synthetic evidence and includes physical SQLite pages',()=>{
  const dir=mkdtempSync(join(tmpdir(),'retention-size-')),path=join(dir,'test.sqlite');const f=fixture({path});
  try{
    for(const[t,r]of Object.entries(oldRows))insert(f.db,t,r);for(let i=0;i<500;i++)insert(f.db,'compact_dex_activity',activity(i));
    f.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');const before=statSync(path).size;
    transaction(f,()=>{for(const t of ['compact_hour_addresses','compact_dex_activity',...Object.keys(oldRows)])f.store.archive.preserve(t,BASE,rows(f.db,t),{scope:'synthetic_storage_measurement'});});
    f.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');const after=statSync(path).size;
    const measured=f.db.prepare('SELECT COUNT(*) AS sets,SUM(row_count) AS rows,SUM(raw_bytes) AS rawBytes,SUM(stored_bytes) AS compressedBytes FROM compact_evidence_archive').get();
    console.log(`ARCHIVE_STORAGE_SYNTHETIC ${JSON.stringify({...measured,databaseBeforeBytes:before,databaseAfterBytes:after,physicalArchiveOverheadBytes:after-before})}`);
    assert.ok(measured.rows>=508);assert.ok(measured.compressedBytes<measured.rawBytes);
  }finally{f.db.close();rmSync(dir,{recursive:true,force:true});}
});
await test('less repetitive synthetic activity measures storage overhead without assuming production compression',()=>{
  const dir=mkdtempSync(join(tmpdir(),'retention-entropy-')),path=join(dir,'test.sqlite'),f=fixture({path});
  const digest=s=>createHash('sha256').update(s).digest('hex');
  try{
    for(let i=0;i<500;i++)insert(f.db,'compact_dex_activity',{...activity(i),tx_hash:`0x${digest(`tx-${i}`)}`,tx_from:`0x${digest(`from-${i}`).slice(0,40)}`,
      pool:`0x${digest(`pool-${i}`).slice(0,40)}`,amount0_raw:BigInt(`0x${digest(`amount-${i}`).slice(0,24)}`).toString(),amount1_raw:`-${BigInt(`0x${digest(`amount1-${i}`).slice(0,24)}`)}`});
    f.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');const before=statSync(path).size;
    transaction(f,()=>f.store.archive.preserve('compact_dex_activity',BASE,rows(f.db,'compact_dex_activity'),{scope:'synthetic_entropy_measurement',completeBlockchainActivity:false}));
    f.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');const after=statSync(path).size;
    const measured=f.db.prepare('SELECT SUM(row_count) AS rows,SUM(raw_bytes) AS rawBytes,SUM(stored_bytes) AS compressedBytes FROM compact_evidence_archive').get();
    console.log(`ARCHIVE_STORAGE_SYNTHETIC_ENTROPY ${JSON.stringify({...measured,physicalArchiveOverheadBytes:after-before})}`);
    assert.equal(measured.rows,500);assert.ok(measured.compressedBytes<measured.rawBytes);
  }finally{f.db.close();rmSync(dir,{recursive:true,force:true});}
});
console.log(`Lossless retention checks: ${passed} passed (disposable SQLite only)`);
