import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Interface } from 'ethers';
import { openPipeline,hash,assertHeapBudget } from '../server/intelligence-pipeline/storage.js';
import { createPoolWitnessLookup } from '../server/intelligence-pipeline/pool-witness-source.js';
import { v4PoolIdOf } from '../server/compact/projections.js';
import { V4_INITIALIZE_STREAM } from '../server/compact/sources.js';
const A='0x'+'1'.repeat(40),B='0x'+'2'.repeat(40),Z='0x'+'0'.repeat(40),H=n=>'0x'+hash(String(n));
const pool=v4PoolIdOf({currency0:A,currency1:B,fee:3000,tickSpacing:60,hooks:Z});
const iface=new Interface(['event Initialize(bytes32 indexed id,address indexed currency0,address indexed currency1,uint24 fee,int24 tickSpacing,address hooks,uint160 sqrtPriceX96,int24 tick)']);
const event=iface.encodeEventLog(iface.getEvent('Initialize'),[pool,A,B,3000,60,Z,2n**96n,0]);
const raw={...event,address:V4_INITIALIZE_STREAM.address[0],blockNumber:'0x5',blockHash:H(5),transactionHash:H(100),transactionIndex:'0x0',logIndex:'0x0',removed:false};
const root=mkdtempSync(join(tmpdir(),'arc-pool-witness-test-'));let checks=0;
const test=async(name,f)=>{await f();checks++;console.log('PASS '+name);};
function scenario(n,{logs=[raw],bodyHash=H(5),budgetFailure=false,lookupStrategy='reverse_ranges_v1',stateFailOnce=false}={}) {
  const path=join(root,n+'.sqlite'),p=openPipeline({path,create:true});
  const args={protocol:'uniswap_v4',pools:[pool],reference:{firstBlock:10,lastBlock:20,lastHash:H(20),canonicalSha:hash('canonical')},validFromBlock:1,lookupStrategy};
  const lookup=createPoolWitnessLookup(p,args);let reads=0;const points=[];
  const bounded={stats:{requests:0},provider:{canContinue:()=>true,request:async(method,params)=>{
    reads++;bounded.stats.requests++;
    if(method==='eth_getCode')return'0x6000';
    if(method==='eth_call'){
      const n=parseInt(params[1],16);points.push(n);
      if(stateFailOnce&&n===3){stateFailOnce=false;throw Object.assign(Error('recovery_response_budget_exhausted'),{code:'recovery_response_budget_exhausted'});}
      const word=n=>BigInt(n).toString(16).padStart(64,'0');return'0x'+word(32)+word(1)+word(n>=5?2n**96n:0n);
    }
    if(method==='eth_getBlockByNumber'){const n=parseInt(params[0],16);assert.equal(params[1],false);
      return{number:params[0],hash:n===20?H(20):bodyHash,parentHash:H(n-1),timestamp:'0x5',transactions:[H(100)]};}
    assert.equal(method,'eth_getLogs');assert.deepEqual(params[0].topics,[V4_INITIALIZE_STREAM.topics[0],lookupStrategy==='reverse_ranges_v1'?[pool]:pool]);
    if(budgetFailure)throw Object.assign(Error('recovery_response_budget_exhausted'),{code:'recovery_response_budget_exhausted'});
    return logs;
  }}};
  return{p,path,args,lookup,bounded,reads:()=>reads,points};
}
await test('a canonical official birth is a pool witness, never complete global coverage or token identity',async()=>{
  const x=scenario('valid');try{const r=await x.lookup.run(x.bounded);assert.equal(r.completeRequestedPoolWitnesses,true);
    assert.equal(r.globalRegistryCoverageComplete,false);assert.equal(x.lookup.read(pool).record.poolId,pool);
    assert.equal(x.lookup.read(pool).tokenIdentityStatus,undefined);}finally{x.p.close();}
});
await test('interruption after atomic acceptance resumes without re-downloading accepted evidence',async()=>{
  const x=scenario('restart');await assert.rejects(x.lookup.run(x.bounded,{afterAccept:()=>{throw Error('crash');}}),/crash/);
  x.p.close();const p=openPipeline({path:x.path});try{const next=createPoolWitnessLookup(p,x.args);const before=x.reads();
    assert.equal((await next.run(x.bounded)).completeRequestedPoolWitnesses,true);assert.equal(x.reads(),before);
    assert.equal(p.db.prepare('SELECT COUNT(*) n FROM arc_pipeline_pool_witnesses').get().n,1);}finally{p.close();}
});
await test('exhausted empty search remains unavailable and retains its exact searched range',async()=>{
  const x=scenario('empty',{logs:[]});try{const r=await x.lookup.run(x.bounded);assert.equal(r.completeRequestedPoolWitnesses,false);
    assert.equal(r.remainingPoolCount,1);assert.equal(x.lookup.read(pool),null);
    assert.equal(x.p.db.prepare('SELECT COUNT(*) n FROM arc_pipeline_pool_search_ranges').get().n,1);}finally{x.p.close();}
});
for(const [name,options]of[
  ['foreign emitter',{logs:[{...raw,address:A}]}],['canonical hash mismatch',{bodyHash:H(6)}],
  ['transaction membership mismatch',{logs:[{...raw,transactionHash:H(101)}]}],
  ['removed event',{logs:[{...raw,removed:true}]}],
])await test(name+' cannot produce an accepted witness',async()=>{
  const x=scenario(name.replaceAll(' ','-'),options);try{await assert.rejects(x.lookup.run(x.bounded));
    assert.equal(x.p.db.prepare('SELECT COUNT(*) n FROM arc_pipeline_pool_witnesses').get().n,0);
    assert.equal(x.p.db.prepare('SELECT next_block FROM arc_pipeline_pool_searches').get().next_block,9);}finally{x.p.close();}
});
await test('budget failure preserves prior cursor and stops before any additional RPC',async()=>{
  const x=scenario('budget',{budgetFailure:true});try{await assert.rejects(x.lookup.run(x.bounded),e=>e.code==='recovery_response_budget_exhausted');
    assert.equal(x.reads(),4);assert.equal(x.p.db.prepare('SELECT next_block FROM arc_pipeline_pool_searches').get().next_block,9);
    assert.equal(x.p.db.prepare('SELECT COUNT(*) n FROM arc_pipeline_pool_search_ranges').get().n,0);}finally{x.p.close();}
});
await test('immutable witness and search ledgers reject updates and deletions',async()=>{
  const x=scenario('immutable');try{await x.lookup.run(x.bounded);
    assert.throws(()=>x.p.db.exec('DELETE FROM arc_pipeline_pool_witnesses'),/immutable/);
    assert.throws(()=>x.p.db.exec("UPDATE arc_pipeline_pool_search_ranges SET response_sha='bad'"),/immutable/);}finally{x.p.close();}
});
await test('slot0 transition narrows a lookup but still requires the exact canonical Initialize',async()=>{
  const x=scenario('slot0',{lookupStrategy:'slot0_transition_v1'});try{
    assert.equal((await x.lookup.run(x.bounded)).completeRequestedPoolWitnesses,true);
    assert.equal(x.lookup.read(pool).record.createdBlock,5);assert.equal(x.points.length,5);
    assert.equal(x.p.db.prepare('SELECT COUNT(*) n FROM arc_pipeline_pool_search_ranges').get().n,0);
  }finally{x.p.close();}
});
await test('interrupted binary lookup reuses every accepted state point, without claiming a partial witness',async()=>{
  const x=scenario('state-restart',{lookupStrategy:'slot0_transition_v1',stateFailOnce:true});try{
    await assert.rejects(x.lookup.run(x.bounded),e=>e.code==='recovery_response_budget_exhausted');
    assert.equal(x.lookup.read(pool),null);assert.equal(x.p.db.prepare('SELECT COUNT(*) n FROM arc_pipeline_pool_state_points').get().n,3);
    assert.equal((await x.lookup.run(x.bounded)).completeRequestedPoolWitnesses,true);
    for(const n of[1,5,9])assert.equal(x.points.filter(v=>v===n).length,1);
    assert.equal(x.points.filter(v=>v===3).length,2);
    assert.throws(()=>x.p.db.exec('DELETE FROM arc_pipeline_pool_state_points'),/immutable/);
  }finally{x.p.close();}
});
await test('a positive slot0 without the actual birth event is never enough proof',async()=>{
  const x=scenario('state-no-event',{lookupStrategy:'slot0_transition_v1',logs:[]});try{
    await assert.rejects(x.lookup.run(x.bounded),e=>e.code==='pool_birth_event_missing_at_state_transition');assert.equal(x.lookup.read(pool),null);
  }finally{x.p.close();}
});
console.log(JSON.stringify({checks,heapBudget:assertHeapBudget(),scope:'synthetic sparse witness safety, not real historical API acceptance',productionAccess:false}));
