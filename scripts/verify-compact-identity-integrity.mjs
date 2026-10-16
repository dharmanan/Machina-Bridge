// Isolated compact SQLite regression package. No production path, real RPC, scheduler, collector or service mutation.
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { mkdtempSync,writeFileSync,statSync,readFileSync,readdirSync,readlinkSync,writeSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { getHeapStatistics } from 'node:v8';
import { createCompactStore } from '../server/compact/store.js';
import { createCompactReadModel } from '../server/compact/read-model.js';
import { createPackedShards,packedShardsConfig } from '../server/compact/packed-shards.js';
import { createEvidenceArchive,archiveConfig,archivedIdentitySet } from '../server/compact/evidence-archive.js';
import { identitySource,identityUnionRows,identityUnionCount,identityUnionCapacity,IDENTITY_UNION_MAX_TEMP_BYTES } from '../server/compact/identity-evidence.js';
import { uniqueAddressesOfSpan } from '../server/compact/address-union.js';
import { COMPACT_DEFINITION_VERSION } from '../server/compact/sources.js';
import { FAMILY_FIELDS } from '../server/compact/families.js';
import { inventoryDay } from './repair-compact-daily-identity.mjs';
import { acquireWriterLock } from '../server/compact/writer-lock.js';

globalThis.fetch=async()=>{throw Error('network_forbidden');};
const HOUR=3600,BASE=Date.parse('2026-10-09T00:00:00Z')/1000,MiB=1024**2;
const address=n=>'0x'+n.toString(16).padStart(40,'0'),hash=n=>'0x'+n.toString(16).padStart(64,'0');
const capacity=()=>({freeBytes:8*1024**3,databaseBytes:0});
const archiveOptions={config:{...archiveConfig({COMPACT_EVIDENCE_ARCHIVE_ENABLED:'true'}),maxTransactionMs:2000,maxArchiveBytes:512*MiB},capacity,log:()=>{}};
const off={config:archiveConfig({}),capacity,log:()=>{}};
function hour(i,addresses){const block=100+i,hourStart=BASE+i*HOUR;return {definitionVersion:COMPACT_DEFINITION_VERSION,chainId:5042,sourceVersions:{},complete:false,
  range:{kind:'hour',hourStart,hourEnd:hourStart+HOUR,firstBlock:block,lastBlock:block,parentHash:hash(block-1),firstHash:hash(block),lastHash:hash(block)},
  network:{status:'available',blockCount:1,transactionCount:addresses.length,uniqueActiveAddresses:addresses.length,gasUsedRaw:'21000'},activeAddresses:addresses,
  families:Object.fromEntries(Object.entries(FAMILY_FIELDS).map(([name,fields])=>[name,{status:'unavailable',reason:'identity_fixture',...Object.fromEntries(fields.map(f=>[f,null]))}])),registry:{uniswapV3:null}};}
function fixture(n,{archive=off,packed=false,path=':memory:',identities=i=>[address(1),address(100+i)]}={}){
  const db=new DatabaseSync(path);db.exec('PRAGMA temp_store=FILE');const store=createCompactStore(db,{archive,packedShards:{config:packed?packedShardsConfig({COMPACT_PACKED_SHARDS_ENABLED:'true'}):{enabled:false},log:()=>{}}});
  for(let i=0;i<n;i++)store.commitHour(hour(i,identities(i)));
  return {db,store,packed:createPackedShards(db,{config:{enabled:false}})};
}
const union=(f,from,to,cache)=>uniqueAddressesOfSpan(f.db,BASE+from*HOUR,BASE+to*HOUR,{packed:f.packed,cache});
function archiveHours(f,hours){const a=createEvidenceArchive(f.db,archiveOptions);
  for(const i of hours){a.begin();f.db.exec('BEGIN');a.preserve('compact_hour_addresses',BASE+i*HOUR,a.readRows('compact_hour_addresses','hour_start=?',[BASE+i*HOUR]));f.db.exec('COMMIT');}}
const erase=(f,i)=>f.db.prepare('DELETE FROM compact_hour_addresses WHERE hour_start=?').run(BASE+i*HOUR);
const invariant=f=>JSON.stringify({hours:f.db.prepare('SELECT * FROM compact_hours').all(),families:f.db.prepare('SELECT * FROM compact_family_hours').all(),checkpoint:f.store.checkpoint()});

if(process.argv[2]==='--heap'){
  const path=process.argv[3],expected=Number(process.argv[4]);let peak=0,peakExternal=0,peakTempBytes=0,sampleMs=0;
  const sample=()=>{const at=performance.now(),m=process.memoryUsage();peak=Math.max(peak,m.heapUsed);peakExternal=Math.max(peakExternal,m.external);
    let bytes=0;for(const fd of readdirSync('/proc/self/fd'))try{const name=readlinkSync('/proc/self/fd/'+fd);if(name.includes('etilqs')||name.includes('machina-identity-union-'))bytes+=statSync('/proc/self/fd/'+fd).size;}catch{}
    peakTempBytes=Math.max(peakTempBytes,bytes);sampleMs+=performance.now()-at;};
  class Measured extends DatabaseSync{prepare(sql){const s=super.prepare(sql),iterate=s.iterate;s.iterate=function*(...args){let n=0;for(const r of iterate.apply(s,args)){if(++n%2048===0)sample();yield r;}};return s;}}
  const db=new Measured(path,{readOnly:true});db.exec('PRAGMA query_only=ON; PRAGMA temp_store=FILE');
  const packed=createPackedShards(db,{config:{enabled:false}}),start=performance.now(),phases={};
  const observe=event=>{sample();if(!phases[event.phase])phases[event.phase]=performance.now()-start;};
  const cache=new Map(),result=uniqueAddressesOfSpan(db,BASE,BASE+719*HOUR,{packed,cache,onProgress:observe});
  const coldMs=performance.now()-start,at=performance.now();
  assert.deepEqual(uniqueAddressesOfSpan(db,BASE,BASE+719*HOUR,{packed,cache}),result);
  const warmMs=performance.now()-at;
  const windows={};
  for(const [window,hours]of [['24h',24],['7d',168]]){
    const at=performance.now(),value=uniqueAddressesOfSpan(db,BASE+(720-hours)*HOUR,BASE+719*HOUR,{packed,onProgress:()=>sample()});
    const perHour=Number(process.argv[5]??1500),stride=Number(process.argv[6]??1000);
    assert.deepEqual(value,{status:'available',value:(hours-1)*stride+perHour});windows[window]={ms:performance.now()-at,result:value};
  }
  assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check,'ok');
  sample();assert.deepEqual(result,{status:'available',value:expected});
  assert.ok(getHeapStatistics().heap_size_limit<=64*MiB);assert.ok(peak<getHeapStatistics().heap_size_limit);
  assert.ok(peakTempBytes<=256*MiB);
  console.log(JSON.stringify({result,ms:coldMs,warmMs,windows,phases,deadlines:{active6000:coldMs<6000,proxy8000:coldMs<8000},heapLimit:getHeapStatistics().heap_size_limit,peakSampledHeap:peak,
    peakExternal,peakTempBytes,samplingMsIncluded:sampleMs,maxRss:process.resourceUsage().maxRSS*1024}));db.close();
}else if(process.argv[2]==='--spool-crash'){
  const db=new DatabaseSync(process.argv[3],{readOnly:true}),packed=createPackedShards(db,{config:{enabled:false}});
  const source=identitySource(db,'compact_hour_addresses',BASE,2,{packed});
  identityUnionCount(db,[source],{onProgress:event=>{if(event.phase==='verified')process.kill(process.pid,'SIGKILL');}});
  throw Error('crash_hook_not_reached');
}else{
  const directory=mkdtempSync('/workspace/machina-identity-integrity-');process.env.TMPDIR=directory;
  let passed=0;const measurements={};
  const test=async(name,fn)=>{if(process.env.COMPACT_IDENTITY_TEST_EXCLUDE&&name.includes(process.env.COMPACT_IDENTITY_TEST_EXCLUDE)){console.log('NOT REPEATED '+name+' (scale preparation/HTTP covered by verify-compact-summary-snapshot-scale.mjs)');return;}if(process.env.COMPACT_IDENTITY_TEST_FILTER&&!name.includes(process.env.COMPACT_IDENTITY_TEST_FILTER))return;
    await fn();passed++;console.log('PASS '+name);};
  await test('14 absent 7D edge hours: 11 verified archives readable with writing OFF; 3 missing remain unavailable',()=>{
    const f=fixture(178),before=invariant(f),cache=new Map();assert.deepEqual(union(f,10,177,cache),{status:'available',value:169});
    archiveHours(f,Array.from({length:11},(_,i)=>10+i));for(let i=10;i<=23;i++)erase(f,i);
    assert.deepEqual(union(f,10,20),{status:'available',value:12});
    assert.deepEqual(union(f,10,177,cache),{status:'unavailable',reason:'identity_incomplete',value:null});
    assert.equal(inventoryDay(f.db,BASE).hours.filter(h=>h.source==='archive').length,11);
    assert.equal(inventoryDay(f.db,BASE).hours.filter(h=>h.source==='missing').length,3);
    for(let i=21;i<=23;i++)f.store.replayDailyActiveAddresses(BASE+i*HOUR,[address(1),address(100+i)]);
    assert.deepEqual(union(f,10,177,cache),{status:'available',value:169});assert.equal(invariant(f),before);f.db.close();
  });
  await test('final day is packed before archive pruning; packed reads work even when packing is disabled',()=>{
    const f=fixture(24,{archive:archiveOptions,packed:true});assert.equal(f.packed.status('compact_daily_address_stage',BASE).rowCount,25);
    for(let i=24;i<28;i++)f.store.commitHour(hour(i,[address(1),address(100+i)]));
    assert.deepEqual(union(f,0,27),{status:'available',value:29});
    assert.deepEqual(f.store.persistedActiveAddresses(BASE),[address(1),address(100)]);f.db.close();
  });
  await test('one-day zero-RPC repair preserves available count, canonical facts and checkpoints; rollback/restart/idempotency',()=>{
    const path=join(directory,'repair.sqlite'),f=fixture(48,{path}),before=invariant(f);
    f.db.exec('DELETE FROM compact_daily_address_stage; DELETE FROM compact_daily_address_hours');
    assert.throws(()=>f.store.repairDailyIdentity(BASE,{beforeCommit:()=>{throw Error('crash_before_commit');}}),/crash_before_commit/);
    assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM compact_daily_address_stage').get().n,0);
    assert.equal(f.store.repairDailyIdentity(BASE).activeAddresses,25);assert.equal(invariant(f),before);
    const changes=f.db.prepare('SELECT total_changes() AS n').get().n;f.store.repairDailyIdentity(BASE);
    assert.equal(f.db.prepare('SELECT total_changes() AS n').get().n,changes);f.db.close();
    const again=fixture(0,{path});assert.equal(again.store.repairDailyIdentity(BASE).activeAddresses,25);assert.equal(invariant(again),before);again.db.close();
  });
  await test('a missing day rebuilds from 24 complete archives while archive writes stay OFF and hourly hot rows stay absent',()=>{
    const f=fixture(24),before=invariant(f);archiveHours(f,Array.from({length:24},(_,i)=>i));
    f.db.exec('DELETE FROM compact_hour_addresses; DELETE FROM compact_daily_address_stage; DELETE FROM compact_daily_address_hours');
    assert.equal(f.store.repairDailyIdentity(BASE).activeAddresses,25);
    assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM compact_hour_addresses').get().n,0);
    assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM compact_evidence_archive').get().n,24);
    assert.equal(invariant(f),before);assert.equal(union(f,0,23).value,25);f.db.close();
  });
  await test('checkpoint mutation during day repair is detected before COMMIT and completely rolled back',()=>{
    const f=fixture(24),before=invariant(f);
    assert.throws(()=>f.store.repairDailyIdentity(BASE,{beforeCommit:()=>f.db.exec('UPDATE compact_checkpoint SET last_block=999')}),/identity_checkpoint_changed/);
    assert.equal(invariant(f),before);f.db.close();
  });
  await test('same-count hot corruption invalidates memo and fails closed; replay cannot overwrite conflicting identities',()=>{
    const f=fixture(24),cache=new Map();assert.equal(union(f,0,23,cache).value,25);
    f.db.prepare('UPDATE compact_daily_address_stage SET address=? WHERE day_start=? AND address=?').run(Buffer.from(address(999).slice(2),'hex'),BASE,Buffer.from(address(100).slice(2),'hex'));
    assert.equal(union(f,0,23,cache).reason,'identity_unverified');
    assert.throws(()=>f.store.repairDailyIdentity(BASE),/identity_daily_membership_conflict/);
    assert.throws(()=>f.store.replayDailyActiveAddresses(BASE,[address(1),address(999)]),/identity_evidence_conflict/);f.db.close();
  });
  await test('live finalization repairs a lost staging member/marker from verified hours without RPC',()=>{
    const f=fixture(23),before=f.store.checkpoint();
    f.db.prepare('DELETE FROM compact_daily_address_hours WHERE hour_start=?').run(BASE+5*HOUR);
    f.db.prepare('DELETE FROM compact_daily_address_stage WHERE day_start=? AND address=?').run(BASE,Buffer.from(address(100).slice(2),'hex'));
    f.store.commitHour(hour(23,[address(1),address(123)]));
    assert.equal(f.store.checkpoint().hourStart,before.hourStart+HOUR);
    assert.equal(f.db.prepare('SELECT active_addresses FROM compact_daily_active_addresses WHERE day_start=?').get(BASE).active_addresses,25);
    assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM compact_daily_address_hours WHERE day_start=?').get(BASE).n,24);
    assert.deepEqual(union(f,0,23),{status:'available',value:25});f.db.close();
  });
  await test('conflicting staging cannot gain a false checksum or stop the live canonical hour; hourly union stays exact',()=>{
    const f=fixture(23);f.db.prepare('UPDATE compact_daily_address_stage SET address=? WHERE day_start=? AND address=?')
      .run(Buffer.from(address(999).slice(2),'hex'),BASE,Buffer.from(address(100).slice(2),'hex'));
    f.store.commitHour(hour(23,[address(1),address(123)]));assert.equal(f.store.checkpoint().hourStart,BASE+23*HOUR);
    assert.equal(f.db.prepare('SELECT status FROM compact_daily_active_addresses WHERE day_start=?').get(BASE).status,'unavailable');
    assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM compact_meta WHERE key LIKE 'identity_membership:v1:compact_daily_address_stage:%'").get().n,0);
    assert.deepEqual(union(f,0,23),{status:'available',value:25});f.db.close();
  });
  await test('new commitments are immutable; corrupt hot membership cannot be frozen into archive or packed proof',()=>{
    const f=fixture(1),key=`identity_membership:v1:compact_hour_addresses:${BASE}`;
    assert.throws(()=>f.db.prepare('UPDATE compact_meta SET value=value WHERE key=?').run(key),/immutable_identity_commitment/);
    assert.throws(()=>f.db.prepare('DELETE FROM compact_meta WHERE key=?').run(key),/immutable_identity_commitment/);
    f.db.prepare('UPDATE compact_hour_addresses SET address=? WHERE hour_start=? AND address=?').run(Buffer.from(address(999).slice(2),'hex'),BASE,Buffer.from(address(100).slice(2),'hex'));
    const archive=createEvidenceArchive(f.db,archiveOptions);archive.begin();f.db.exec('BEGIN');archive.prune('compact_hour_addresses','hour_start=?',[BASE]);f.db.exec('COMMIT');
    assert.ok(archive.report().failures.includes('archive_identity_commitment_conflict'));
    const logs=[],writer=createCompactStore(f.db,{archive:off,packedShards:{config:packedShardsConfig({COMPACT_PACKED_SHARDS_ENABLED:'true'}),log:l=>logs.push(l)}});
    writer.packedShards.packHour(BASE);assert.equal(f.packed.status('compact_hour_addresses',BASE),null);
    assert.ok(logs.some(l=>l.includes('identity_commitment_corrupt')));assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM compact_hour_addresses').get().n,2);f.db.close();
  });
  await test('conflicting complete archive revisions are rejected rather than merged or chosen by recency',()=>{
    const f=fixture(1);archiveHours(f,[0]);const a=createEvidenceArchive(f.db,archiveOptions);
    a.begin();f.db.exec('BEGIN');a.preserve('compact_hour_addresses',BASE,[1,999].map(n=>({hour_start:BASE,address:Buffer.from(address(n).slice(2),'hex')})));f.db.exec('COMMIT');
    erase(f,0);assert.equal(union(f,0,0).reason,'identity_unverified');f.db.close();
  });
  await test('partial archive revisions never combine into invented completeness; canonical rebinding is rejected',()=>{
    const f=fixture(1),a=createEvidenceArchive(f.db,archiveOptions),original=a.readRows('compact_hour_addresses','hour_start=?',[BASE]);
    for(const row of original){a.begin();f.db.exec('BEGIN');a.preserve('compact_hour_addresses',BASE,[row]);f.db.exec('COMMIT');}
    erase(f,0);assert.equal(identitySource(f.db,'compact_hour_addresses',BASE,2,{packed:f.packed}),null);
    f.db.prepare('UPDATE compact_hours SET last_hash=? WHERE hour_start=?').run(hash(999),BASE);
    assert.throws(()=>archivedIdentitySet(f.db,'compact_hour_addresses',BASE,1),/archive_canonical_conflict/);f.db.close();
  });
  await test('32,000-address multipart archive is streamed and last-part corruption cannot publish a partial union',()=>{
    const f=fixture(1,{identities:()=>Array.from({length:32000},(_,i)=>address(i+1))});archiveHours(f,[0]);erase(f,0);
    const source=identitySource(f.db,'compact_hour_addresses',BASE,32000,{packed:f.packed});let n=0;for(const _row of source.openRows())n++;assert.equal(n,32000);
    f.db.exec('DROP TRIGGER compact_archive_part_no_update');
    f.db.exec('UPDATE compact_evidence_archive_parts SET payload=zeroblob(length(payload)) WHERE part=(SELECT MAX(part) FROM compact_evidence_archive_parts)');
    assert.equal(union(f,0,0).reason,'identity_unverified');f.db.close();
  });
  await test('a malformed archive manifest is an isolated unavailable identity metric, not an uncaught parser failure',()=>{
    const path=join(directory,'corrupt-manifest.sqlite'),f=fixture(2,{path});archiveHours(f,[0]);erase(f,0);
    f.db.exec("DROP TRIGGER compact_archive_no_update; PRAGMA ignore_check_constraints=ON; UPDATE compact_evidence_archive SET manifest_json='{'");
    f.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    const model=createCompactReadModel({path,DatabaseSync,now:()=> (BASE+2*HOUR+60)*1000});
    try{const network=model.summary('30d').network;assert.equal(network.transactions,4);assert.equal(network.uniqueActiveAddresses.reason,'identity_unverified');}
    finally{model.close();f.db.close();}
  });
  await test('missing canonical hours, duplicate inputs, missing evidence and low space never become verified or mutate data',()=>{
    const f=fixture(24),before=invariant(f);
    assert.equal(union(f,0,24).reason,'insufficient_coverage');
    assert.throws(()=>f.store.replayDailyActiveAddresses(BASE,[address(1),address(1)]),/identity_hour_count_conflict/);
    const source=identitySource(f.db,'compact_hour_addresses',BASE,2,{packed:f.packed});
    assert.throws(()=>identityUnionRows(f.db,[source],{capacity:()=>0}),/identity_union_storage_budget/);
    erase(f,0);assert.throws(()=>f.store.repairDailyIdentity(BASE),/identity_membership_missing/);assert.equal(invariant(f),before);f.db.close();
  });
  await test('day repair disk preflight rolls back without changing accepted facts or memberships',()=>{
    let free=8*1024**3;const f=fixture(24,{archive:{...off,capacity:()=>({freeBytes:free,databaseBytes:0})}}),before=invariant(f);
    const rows=f.db.prepare('SELECT * FROM compact_daily_address_stage').all();free=0;
    assert.throws(()=>f.store.repairDailyIdentity(BASE),/storage_low_space/);assert.equal(invariant(f),before);
    assert.deepEqual(f.db.prepare('SELECT * FROM compact_daily_address_stage').all(),rows);f.db.close();
  });
  await test('operator CLI defaults to query_only, one-day metadata inventory with zero writes or RPC',()=>{
    const path=join(directory,'inventory.sqlite'),f=fixture(24,{path});f.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');f.db.close();
    const before=createHash('sha256').update(readFileSync(path)).digest('hex');
    const run=spawnSync(process.execPath,[fileURLToPath(new URL('./repair-compact-daily-identity.mjs',import.meta.url)),'2026-10-09'],
      {encoding:'utf8',env:{PATH:process.env.PATH,COMPACT_SQLITE_PATH:path},timeout:10000});
    assert.equal(run.status,0,run.stderr);const report=JSON.parse(run.stdout);assert.equal(report.canonicalHours,24);assert.equal(report.rpcExecuted,false);
    assert.equal(createHash('sha256').update(readFileSync(path)).digest('hex'),before);
    const lock=acquireWriterLock(path,{owner:'disposable-live-collector'});
    try{
      const blocked=spawnSync(process.execPath,[fileURLToPath(new URL('./repair-compact-daily-identity.mjs',import.meta.url)),'2026-10-09','--execute'],
        {encoding:'utf8',env:{PATH:process.env.PATH,COMPACT_SQLITE_PATH:path},timeout:10000});
      assert.equal(blocked.status,1);assert.match(blocked.stderr,/writer_lock_held/);
      assert.equal(createHash('sha256').update(readFileSync(path)).digest('hex'),before);
    }finally{lock.release();}
  });
  await test('24H/7D/30D API counts are exact unions, including 719/720 partial canonical coverage and genuine empty hours',()=>{
    const path=join(directory,'windows.sqlite'),f=fixture(719,{path,identities:i=>i===0?[]:[address(1),address(100+i)]});
    f.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    const model=createCompactReadModel({path,DatabaseSync,now:()=> (BASE+719*HOUR+60)*1000});
    try{for(const [window,expected]of [['24h',25],['7d',169],['30d',719]])assert.equal(model.summary(window).network.uniqueActiveAddresses.value,expected);
      assert.equal(model.summary('30d').window.coverage.availableHours,719);assert.equal(model.summary('30d').window.coverage.expectedHours,720);
    }finally{model.close();}f.db.close();
  });
  await test('exact binary capacity accepts the production minimum without raising the 256 MiB ceiling',()=>{
    const f=fixture(1),count=2_098_876;
    assert.equal(identityUnionCapacity(f.db,[{count}],{capacity:()=>256*MiB+count*20}),41_977_520);
    assert.throws(()=>identityUnionCapacity(f.db,[{count}],{capacity:()=>256*MiB+count*20-1}),/identity_union_storage_budget/);
    assert.throws(()=>identityUnionCapacity(f.db,[{count:Math.floor(IDENTITY_UNION_MAX_TEMP_BYTES/20)+1}],{capacity:()=>8*1024**3}),/identity_union_storage_budget/);
    f.db.close();
  });
  await test('anonymous spool closes on proof failure and abandoned iteration, without publishing an incomplete count',()=>{
    const f=fixture(1),source=identitySource(f.db,'compact_hour_addresses',BASE,2,{packed:f.packed});
    const temps=()=>readdirSync('/proc/self/fd').filter(fd=>{try{return readlinkSync('/proc/self/fd/'+fd).includes('machina-identity-union-');}catch{return false;}});
    const bad={...source,openRows:function*(){yield* source.openRows();throw Object.assign(Error('packed_rows_corrupt'),{code:'packed_rows_corrupt'});}};
    assert.throws(()=>identityUnionCount(f.db,[bad]),/packed_rows_corrupt/);assert.equal(temps().length,0);
    const rows=identityUnionRows(f.db,[source]);assert.equal(rows.next().value,address(1).slice(2));rows.return();assert.equal(temps().length,0);f.db.close();
  });
  await test('spool checksum rejects changed temporary bytes before publishing any count; valid sources survive',()=>{
    const f=fixture(1),before=invariant(f),source=identitySource(f.db,'compact_hour_addresses',BASE,2,{packed:f.packed});
    assert.throws(()=>identityUnionCount(f.db,[source],{onProgress:event=>{
      if(event.phase!=='verified')return;
      const fd=readdirSync('/proc/self/fd').find(fd=>{try{return readlinkSync('/proc/self/fd/'+fd).includes('machina-identity-union-');}catch{return false;}});
      assert.ok(fd);writeSync(Number(fd),Buffer.alloc(20,255),0,20,0);
    }}),/identity_union_spool_corrupt/);
    assert.equal(invariant(f),before);assert.equal(identityUnionCount(f.db,[source]),2);f.db.close();
  });
  await test('SIGKILL after source verification leaves no named spool, changes no canonical bytes and permits restart',()=>{
    const path=join(directory,'crash.sqlite'),f=fixture(1,{path});f.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');f.db.close();
    const before=createHash('sha256').update(readFileSync(path)).digest('hex');
    const child=spawnSync(process.execPath,['--max-old-space-size=48','--max-semi-space-size=4',fileURLToPath(import.meta.url),'--spool-crash',path],
      {encoding:'utf8',timeout:10000,env:{...process.env,TMPDIR:directory}});
    assert.equal(child.signal,'SIGKILL',child.stderr);assert.equal(child.status,null);
    assert.equal(readdirSync(directory).filter(p=>p.startsWith('machina-identity-union-')).length,0);
    assert.equal(createHash('sha256').update(readFileSync(path)).digest('hex'),before);
    const again=fixture(0,{path});assert.deepEqual(union(again,0,0),{status:'available',value:2});again.db.close();
  });
  await test('production-scale daily and 720 hourly packed unions exceed 2,098,876 inputs at 48/4 heap; exact restart and deadlines',()=>{
    const path=join(directory,'heap.sqlite'),perHour=3200,stride=3100;
    // Random-looking high-entropy, injective addresses (the final four bytes contain n). No synthetic zero-prefix compression windfall.
    const denseAddress=n=>'0x'+createHash('sha256').update('identity-capacity:'+n).digest('hex').slice(0,32)+n.toString(16).padStart(8,'0');
    const f=fixture(720,{path,packed:true,identities:i=>Array.from({length:perHour},(_,j)=>denseAddress(i*stride+j+1))});
    const dailyInputs=f.db.prepare("SELECT SUM(active_addresses) AS n FROM compact_daily_active_addresses WHERE status='available'").get().n;
    assert.ok(dailyInputs>2_098_876);assert.equal(dailyInputs,30*(23*stride+perHour));
    const before=invariant(f);
    // The disposable fixture already has verified packed copies. No source from production is touched.
    f.db.exec('DELETE FROM compact_daily_address_stage; DELETE FROM compact_daily_address_hours; DELETE FROM compact_hour_addresses');
    f.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');f.db.close();
    const run=()=>{
      const child=spawnSync(process.execPath,['--max-old-space-size=48','--max-semi-space-size=4',fileURLToPath(import.meta.url),'--heap',path,String(719*stride+perHour),String(perHour),String(stride)],
        {encoding:'utf8',timeout:60000,env:{...process.env,TMPDIR:directory},maxBuffer:65536});
      assert.equal(child.status,0,child.stderr);return JSON.parse(child.stdout.trim());
    };
    measurements.daily={...run(),sourceMemberships:dailyInputs};
    measurements.restart={...run(),sourceMemberships:dailyInputs};
    assert.deepEqual(measurements.restart.result,measurements.daily.result);
    const db=new DatabaseSync(path);db.exec("UPDATE compact_daily_active_addresses SET status='unavailable',reason='identity_not_captured',active_addresses=NULL");
    const immutableAfter=JSON.stringify({hours:db.prepare('SELECT * FROM compact_hours').all(),families:db.prepare('SELECT * FROM compact_family_hours').all()});
    assert.deepEqual(JSON.parse(immutableAfter),{hours:JSON.parse(before).hours,families:JSON.parse(before).families});
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');db.close();
    measurements.hourly={...run(),sourceMemberships:720*perHour};
    measurements.databaseBytes=statSync(path).size;
    for(const [scenario,result]of Object.entries(measurements))if(result?.deadlines)console.log(JSON.stringify({scenario,...result}));
  });
  writeFileSync(join(directory,'results.json'),JSON.stringify({passed,measurements},null,2));
  console.log(JSON.stringify({directory,passed,measurements}));console.log(`VERIFIER PASS compact-identity-integrity ${passed} correctness cases`);
  const timingFailures=Object.entries(measurements).flatMap(([scenario,result])=>result?.deadlines
    ?[...(result.deadlines.active6000?[]:[scenario+':30d>=6000ms']),...Object.entries(result.windows).filter(([,r])=>r.ms>=6000).map(([w])=>scenario+':'+w+'>=6000ms')]:[]);
  console.log(JSON.stringify({timingAcceptance:Object.values(measurements).some(r=>r?.deadlines)?(timingFailures.length?'NO_GO':'PASS'):'NOT_RUN',failures:timingFailures,syntheticOnly:true}));
  if(timingFailures.length)process.exitCode=1;
}
