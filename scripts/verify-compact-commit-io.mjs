// Offline acceptance for opt-in commitHour subphase diagnostics. Only disposable SQLite and synthetic RPC.
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { createCompactStore } from '../server/compact/store.js';
import { createCompactIoDiagnostics, runCompactHour } from './run-compact-hour.mjs';
import { FAMILY_FIELDS } from '../server/compact/families.js';
import { COMPACT_DEFINITION_VERSION } from '../server/compact/sources.js';
import { archiveConfig } from '../server/compact/evidence-archive.js';
import { packedShardsConfig } from '../server/compact/packed-shards.js';
import { createProvider } from '../server/compact/provider.js';
import { createSyntheticChain } from '../server/compact/offline.js';
import { lockPathOf } from '../server/compact/writer-lock.js';
import { existsSync } from 'node:fs';

const BASE='098151e7a874b843d18174872a66b654e2da3830', root=new URL('../',import.meta.url);
async function baseline(path, overrides={}) {
  const url=new URL(path,root);
  const source=execFileSync('git',['show',`${BASE}:${path}`],{cwd:root,encoding:'utf8'})
    .replace(/from (['"])(\.\.?\/[^'"]+)\1/g,(_,q,relative)=>`from ${q}${overrides[relative]??new URL(relative,url).href}${q}`);
  const moduleUrl=`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
  return {module:await import(moduleUrl),moduleUrl};
}
const oldStore=await baseline('server/compact/store.js');
const oldRunner=await baseline('scripts/run-compact-hour.mjs',{'../server/compact/store.js':oldStore.moduleUrl});
const directory=mkdtempSync(join(tmpdir(),'compact-commit-io-acceptance-'));
const HOUR=Date.parse('2026-10-22T00:00:00.000Z')/1000, target=new Date(HOUR*1000).toISOString();
const enabled={MACHINA_COMPACT_IO_DIAGNOSTICS:'1',MACHINA_COMPACT_IO_DIAGNOSTICS_HOUR:target};
const address=n=>'0x'+n.toString(16).padStart(40,'0'),hash=n=>'0x'+n.toString(16).padStart(64,'0');
const prefix='COMPACT_IO_DIAGNOSTIC ',parse=lines=>lines.filter(x=>x.startsWith(prefix)).map(x=>JSON.parse(x.slice(prefix.length)));
let passed=0,external=0,serial=0;
globalThis.fetch=async()=>{external++;throw Error('external_network_forbidden');};
const test=async(name,work)=>{await work();passed++;console.log('PASS '+name);};
function hour(i=0) {return {definitionVersion:COMPACT_DEFINITION_VERSION,chainId:5042,complete:false,sourceVersions:{},
  range:{kind:'hour',hourStart:HOUR+i*3600,hourEnd:HOUR+(i+1)*3600,firstBlock:100+i,lastBlock:100+i,parentHash:hash(99+i),firstHash:hash(100+i),lastHash:hash(100+i)},
  network:{status:'available',blockCount:1,transactionCount:2,uniqueActiveAddresses:2,gasUsedRaw:'21000'},activeAddresses:[address(1),address(2)],
  families:Object.fromEntries(Object.entries(FAMILY_FIELDS).map(([n,f])=>[n,{status:'unavailable',reason:'fixture',...Object.fromEntries(f.map(k=>[k,null]))}])),registry:{uniswapV3:null}};}
function sink(lines, over={}) {
  let tick=0,read=0;
  return createCompactIoDiagnostics({env:enabled,hourStart:HOUR,print:x=>lines.push(x),pid:321,utc:()=>target,clock:()=>++tick,
    read:path=>path==='/proc/self/cgroup'?'0::/\n':path.endsWith('memory.stat')?'anon 40\nfile 80\n':`read_bytes: ${++read*4096}\nrchar: ${read*8192}\n`,...over});
}
function fixture(factory=createCompactStore) {
  const db=new DatabaseSync(join(directory,`${++serial}.sqlite`));
  const store=factory(db,{archive:{config:archiveConfig({}),log:()=>{}},packedShards:{config:packedShardsConfig({}),log:()=>{}}});
  return {db,store};
}
function state(db) {
  const sha=createHash('sha256');
  for(const {name}of db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all()){
    sha.update(name);
    for(const text of db.prepare(`SELECT * FROM "${name}"`).all().map(row=>JSON.stringify(row)).sort())sha.update(text+'\n');
  }return sha.digest('hex');
}
function commit(f, value=hour(), diag=null, options={}) {
  diag?.start('commit_hour.unattributed');
  let ok=false;
  try {const valueOut=f.store.commitHour(value,{...options,ioDiagnostics:diag?.commitHour??null});ok=true;return valueOut;}
  finally{diag?.end(ok?'ok':'error');}
}
function exitPhases(lines) {return parse(lines).filter(e=>e.event==='exit'&&e.scope==='commit_hour');}
function phaseNames(lines) {return exitPhases(lines).filter(e=>e.stage!=='commit_hour.unattributed').map(e=>e.stage.slice(12));}
function assertPartition(lines) {
  const events=parse(lines);let active=null;
  for(const e of events){
    assert.equal(e.pid,321);assert.equal(e.utc,target);assert.equal(e.target_hour,target);
    if(e.event==='enter'){assert.equal(active,null,'phases never overlap');active=e.stage;}
    else{assert.equal(e.stage,active);active=null;assert.ok(e.elapsed_ms>=0);assert.ok(['ok','error'].includes(e.outcome));}
    if(e.stage.startsWith('commit_hour.'))assert.equal(e.accounting,'exclusive');
    assert.notEqual(e.stage,'commit_hour','no inclusive commit total is emitted alongside subphases');
  }assert.equal(active,null);
}
const originalEnv={flag:process.env.MACHINA_COMPACT_IO_DIAGNOSTICS,target:process.env.MACHINA_COMPACT_IO_DIAGNOSTICS_HOUR};
delete process.env.MACHINA_COMPACT_IO_DIAGNOSTICS;delete process.env.MACHINA_COMPACT_IO_DIAGNOSTICS_HOUR;
try {
  await test('off, invalid/noncanonical target, missing hour and nonmatching hours perform no diagnostic reads or clocks',()=>{
    for(const [env,hourStart]of [[{},HOUR],[{...enabled,MACHINA_COMPACT_IO_DIAGNOSTICS:'0'},HOUR],
      [{...enabled,MACHINA_COMPACT_IO_DIAGNOSTICS_HOUR:'invalid'},HOUR],
      [{...enabled,MACHINA_COMPACT_IO_DIAGNOSTICS_HOUR:'2026-10-22T00:00:00Z'},HOUR],
      [{...enabled,MACHINA_COMPACT_IO_DIAGNOSTICS_HOUR:'2026-02-30T00:00:00.000Z'},HOUR],
      [{...enabled,MACHINA_COMPACT_IO_DIAGNOSTICS_HOUR:'2026-10-22T00:30:00.000Z'},HOUR],
      [enabled,undefined],[enabled,HOUR-3600],[enabled,HOUR+3600]]){
      let called=0;const io=sink([],{env,hourStart,read:()=>{called++;throw Error('SECRET');},clock:()=>{called++;throw Error('SECRET');},print:()=>{called++;}});
      assert.equal(io.commitHour,null);io.start('commit_hour');io.end();assert.equal(called,0);
    }
  });
  await test('legacy broad opt-in retains its inclusive stage with subphases disabled',()=>{
    const lines=[],io=sink(lines,{env:{MACHINA_COMPACT_IO_DIAGNOSTICS:'1'}});
    assert.equal(io.commitHour,null);io.start('commit_hour');io.end();
    assert.deepEqual(parse(lines).map(e=>e.stage),['commit_hour','commit_hour']);assert.equal(parse(lines)[0].accounting,undefined);
  });
  await test('successful commit is an exclusive partition including a separate SQLite COMMIT',()=>{
    const f=fixture(),lines=[];try{
      assert.equal(commit(f,hour(),sink(lines)).outcome,'inserted');assertPartition(lines);
      assert.deepEqual(phaseNames(lines),['hour_rows','transaction_setup','sqlite_begin','canonical_checkpoint','store_addresses','daily_active_addresses','advance_checkpoint',
        'intelligence_record_hour','packed_pack_hour','packed_maintain','history_maintain','sqlite_commit']);
      for(const e of exitPhases(lines)){assert.equal(e.delta.read_bytes,'4096');assert.equal(e.delta.rchar,'8192');}
      assert.ok(exitPhases(lines).some(e=>e.stage==='commit_hour.unattributed'));
    }finally{f.db.close();}
  });
  await test('baseline and new off/on writers have identical SQL execution order, bind values and final tables',()=>{
    const runs=[];
    for(const [factory,diag]of [[oldStore.module.createCompactStore,null],[createCompactStore,null],[createCompactStore,sink([])]]){
      const f=fixture(factory),sql=[];const prepare=f.db.prepare.bind(f.db),exec=f.db.exec.bind(f.db);
      // Store's prepared statements are already built: prototype instrumentation also observes those existing handles.
      const statement=prepare('SELECT 1'),proto=Object.getPrototypeOf(statement),methods={};
      for(const method of ['run','get','all','iterate']){methods[method]=proto[method];proto[method]=function(...args){
        assert.equal(typeof this.sourceSQL,'string');sql.push([this.sourceSQL,method,args.map(a=>typeof a==='bigint'?a.toString():Buffer.isBuffer(a)?a.toString('hex'):a)]);return methods[method].apply(this,args);};}
      f.db.exec=function(text){sql.push(['exec',text]);return exec(text);};
      try{
        const outputs=[commit(f,hour(),diag),commit(f,hour(),diag)];
        assert.throws(()=>commit(f,hour(1),diag,{beforeCommit(){throw Error('rollback');}}),/rollback/);
        runs.push({sql:JSON.stringify(sql),outputs,digest:state(f.db)});
      }finally{for(const [method,fn]of Object.entries(methods))proto[method]=fn;f.db.close();}
    }
    assert.deepEqual(runs[1],runs[0]);assert.deepEqual(runs[2],runs[0]);
  });
  await test('stored/replay commits do not pretend to run new-hour addresses or checkpoint advancement',()=>{
    const f=fixture(),lines=[];try{
      commit(f);const before=state(f.db);assert.equal(commit(f,hour(),sink(lines)).outcome,'unchanged');assert.equal(state(f.db),before);
      assertPartition(lines);assert.ok(!phaseNames(lines).includes('store_addresses'));assert.ok(!phaseNames(lines).includes('daily_active_addresses'));assert.ok(!phaseNames(lines).includes('advance_checkpoint'));assert.ok(phaseNames(lines).includes('sqlite_commit'));
    }finally{f.db.close();}
  });
  await test('canonical discontinuity logs error and rollback; checkpoint and accepted facts remain unchanged',()=>{
    const f=fixture(),lines=[];try{
      commit(f);const before=state(f.db),value=hour(1);value.range.parentHash=hash(999);
      assert.throws(()=>commit(f,value,sink(lines)),e=>e.code==='checkpoint_discontinuity');assert.equal(state(f.db),before);assertPartition(lines);
      assert.equal(exitPhases(lines).find(e=>e.stage==='commit_hour.canonical_checkpoint').outcome,'error');
      assert.ok(phaseNames(lines).includes('sqlite_rollback'));assert.ok(!phaseNames(lines).includes('sqlite_commit'));
    }finally{f.db.close();}
  });
  await test('normalization failure happens before BEGIN and cannot change persisted facts',()=>{
    const f=fixture(),lines=[];try{const before=state(f.db);assert.throws(()=>commit(f,{...hour(),chainId:1},sink(lines)),/chain_id_mismatch/);
      assert.equal(state(f.db),before);assert.deepEqual(phaseNames(lines),['hour_rows']);assert.equal(exitPhases(lines).find(e=>e.stage==='commit_hour.hour_rows').outcome,'error');assertPartition(lines);
    }finally{f.db.close();}
  });
  await test('beforeCommit failure rolls back and is attributed to remaining work, not successful COMMIT',()=>{
    const f=fixture(),lines=[];try{const before=state(f.db);assert.throws(()=>commit(f,hour(),sink(lines),{beforeCommit(){throw Error('original_failure');}}),/original_failure/);
      assert.equal(state(f.db),before);assert.ok(phaseNames(lines).includes('sqlite_rollback'));assert.ok(!phaseNames(lines).includes('sqlite_commit'));assertPartition(lines);
      assert.ok(exitPhases(lines).some(e=>e.stage==='commit_hour.unattributed'&&e.outcome==='error'));
    }finally{f.db.close();}
  });
  await test('BEGIN failure is measured and preserves the original no-rollback-before-BEGIN behaviour',()=>{
    const f=fixture(),lines=[],exec=f.db.exec.bind(f.db),failure=Error('begin_failure');
    f.db.exec=sql=>{if(sql==='BEGIN IMMEDIATE')throw failure;return exec(sql);};
    try{const before=state(f.db);assert.throws(()=>commit(f,hour(),sink(lines)),e=>e===failure);assert.equal(state(f.db),before);assert.equal(f.db.isTransaction,false);
      assertPartition(lines);assert.equal(exitPhases(lines).find(e=>e.stage==='commit_hour.sqlite_begin').outcome,'error');
      assert.ok(!phaseNames(lines).includes('sqlite_rollback'));assert.ok(!phaseNames(lines).includes('sqlite_commit'));
    }finally{f.db.close();}
  });
  await test('COMMIT failure is separately measured; successful rollback preserves its original error',()=>{
    const f=fixture(),lines=[],exec=f.db.exec.bind(f.db),failure=Error('commit_failure');
    f.db.exec=sql=>{if(sql==='COMMIT')throw failure;return exec(sql);};
    try{const before=state(f.db);assert.throws(()=>commit(f,hour(),sink(lines)),e=>e===failure);assert.equal(state(f.db),before);
      assertPartition(lines);assert.equal(exitPhases(lines).find(e=>e.stage==='commit_hour.sqlite_commit').outcome,'error');assert.equal(exitPhases(lines).find(e=>e.stage==='commit_hour.sqlite_rollback').outcome,'ok');
    }finally{f.db.close();}
  });
  await test('ROLLBACK failure never replaces the original failure and diagnostics never claim success',()=>{
    const f=fixture(),lines=[],exec=f.db.exec.bind(f.db),failure=Error('original_failure');f.db.exec=sql=>{if(sql==='ROLLBACK')throw Error('rollback_failure');return exec(sql);};
    try{assert.throws(()=>commit(f,hour(),sink(lines),{beforeCommit(){throw failure;}}),e=>e===failure);
      assert.equal(exitPhases(lines).find(e=>e.stage==='commit_hour.sqlite_rollback').outcome,'error');assertPartition(lines);
    }finally{if(f.db.isTransaction)exec('ROLLBACK');f.db.close();}
  });
  await test('throwing callback/property, logger and clock cannot change successful commit or rollback',()=>{
    const badGetter={get start(){throw Error('SECRET');},get end(){throw Error('SECRET');}};
    for(const io of [badGetter,{start(){throw Error('SECRET');},end(){throw Error('SECRET');}},sink([],{print(){throw Error('SECRET');}}).commitHour,sink([],{clock(){throw Error('SECRET');}}).commitHour]){
      const f=fixture();try{assert.equal(f.store.commitHour(hour(),{ioDiagnostics:io}).outcome,'inserted');const before=state(f.db),failure=Error('original_failure');
        assert.throws(()=>f.store.commitHour(hour(1),{ioDiagnostics:io,beforeCommit(){throw failure;}}),e=>e===failure);assert.equal(state(f.db),before);
      }finally{f.db.close();}
    }
  });
  await test('missing counters and counter failures remain null, with no confidential exception contents',()=>{
    for(const read of [()=>{throw Error('SECRET');},()=> 'invalid SECRET']){
      const f=fixture(),lines=[];try{commit(f,hour(),sink(lines,{read}));assertPartition(lines);
        for(const e of exitPhases(lines))assert.deepEqual(e.delta,{read_bytes:null,rchar:null});assert.ok(!lines.join('').includes('SECRET'));
      }finally{f.db.close();}
    }
  });
  function provider(){const chain=createSyntheticChain({originNumber:100000,originTimestamp:HOUR-3600,blockSpacing:36000000,head:100010,txPerBlock:-3,usdcPerBlock:0,v4PerBlock:0,poolCreatedAt:100005});return createProvider({fetchImpl:chain.fetchImpl,minIntervalMs:0,cooldownMs:0,sleep:async()=>{}});}
  const clean=s=>{const {elapsedMs,sqlitePath,...rest}=s;return rest;};
  async function run(name,engine=runCompactHour,ioDiagnostics){const lines=[],path=join(directory,name);const summary=await engine({sqlitePath:path,hourStart:HOUR,provider:provider(),registryFromBlock:99999,safeHeadMargin:0,print:x=>lines.push(x),...(ioDiagnostics?{ioDiagnostics:ioDiagnostics(lines)}:{})});return {summary,lines,path};}
  await test('real runner baseline/off/targeted have equal summaries, RPC counts and all table contents',async()=>{
    const before=await run('runner-base.sqlite',oldRunner.module.runCompactHour),off=await run('runner-off.sqlite'),on=await run('runner-on.sqlite',runCompactHour,lines=>sink(lines));
    assert.equal(on.summary.ok,true);assert.deepEqual(clean(off.summary),clean(before.summary));assert.deepEqual(clean(on.summary),clean(before.summary));
    const digests=[before,off,on].map(r=>{const db=new DatabaseSync(r.path,{readOnly:true});try{return state(db);}finally{db.close();}});assert.equal(digests[0],digests[1]);assert.equal(digests[0],digests[2]);
    assert.equal(existsSync(lockPathOf(on.path)),false);assertPartition(on.lines);
    for(const name of ['registry_update','projections_valuations','sqlite_commit'])assert.ok(phaseNames(on.lines).includes(name),name);
    if(process.env.COMPACT_COMMIT_IO_SAMPLE)writeFileSync(process.env.COMPACT_COMMIT_IO_SAMPLE,on.lines.filter(l=>l.startsWith(prefix)).join('\n')+'\n');
  });
  await test('real environment target integrates with the runner and does not spread to stored or later hours',async()=>{
    process.env.MACHINA_COMPACT_IO_DIAGNOSTICS='1';process.env.MACHINA_COMPACT_IO_DIAGNOSTICS_HOUR=target;
    try{
      const current=await run('env-target.sqlite');assert.equal(current.summary.ok,true);assert.ok(phaseNames(current.lines).includes('sqlite_commit'));
      const storedLines=[],stored=await runCompactHour({sqlitePath:current.path,hourStart:HOUR,provider:provider(),registryFromBlock:99999,safeHeadMargin:0,print:l=>storedLines.push(l)});
      assert.equal(stored.hourMode,'stored');assert.equal(exitPhases(storedLines).length,0,'already stored target does not fabricate a commit');
      const laterLines=[],later=await runCompactHour({sqlitePath:current.path,hourStart:HOUR+3600,provider:provider(),registryFromBlock:99999,safeHeadMargin:0,print:l=>laterLines.push(l)});
      assert.equal(later.ok,true);assert.equal(parse(laterLines).length,0,'the next natural hour is not instrumented');
      const events=[];await runCompactHour({sqlitePath:current.path,hourStart:HOUR+3600,provider:provider(),registryFromBlock:99999,safeHeadMargin:0,print:l=>events.push(l)});assert.equal(parse(events).length,0);
    }finally{delete process.env.MACHINA_COMPACT_IO_DIAGNOSTICS;delete process.env.MACHINA_COMPACT_IO_DIAGNOSTICS_HOUR;}
  });
  await test('real local /proc subphase records remain successful with actual counters',()=>{
    const f=fixture(),lines=[];try{const io=createCompactIoDiagnostics({env:enabled,hourStart:HOUR,print:l=>lines.push(l)});commit(f,hour(),io);
      assert.ok(exitPhases(lines).some(e=>e.stage==='commit_hour.sqlite_commit'));for(const e of exitPhases(lines))assert.ok(e.delta.read_bytes===null||/^\d+$/.test(e.delta.read_bytes));
      if(process.env.COMPACT_COMMIT_IO_LOCAL_SAMPLE)writeFileSync(process.env.COMPACT_COMMIT_IO_LOCAL_SAMPLE,lines.join('\n')+'\n');
    }finally{f.db.close();}
  });
  assert.equal(external,0);console.log(`${passed}/${passed} commit subphase diagnostic groups PASS; offline only, zero external calls.`);
}finally{
  for(const [key,value]of [['MACHINA_COMPACT_IO_DIAGNOSTICS',originalEnv.flag],['MACHINA_COMPACT_IO_DIAGNOSTICS_HOUR',originalEnv.target]]){if(value===undefined)delete process.env[key];else process.env[key]=value;}
  rmSync(directory,{recursive:true,force:true});
}
