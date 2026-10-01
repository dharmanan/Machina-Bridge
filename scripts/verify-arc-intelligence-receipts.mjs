import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fixturePool,block,rawBlock,transaction,hash,address,fixtureChainRpc } from './fixtures/arc-intelligence-a2.mjs';
import { migrate,MIGRATIONS } from '../server/arc-intelligence/migrate.js';
import { createFoundationRepository,CHAIN_IDENTITY } from '../server/arc-intelligence/foundation.js';
import { createReceiptRepository,RECEIPT_IDENTITY } from '../server/arc-intelligence/receipt-repository.js';
import { createReceiptWorker } from '../server/arc-intelligence/receipt-lane.js';
import { createChainFollower } from '../server/arc-intelligence/chain-lane.js';
import { createRpcBudget } from '../server/arc-intelligence/rpc-budget.js';
import { COMPLETE_WORK_RETAIN,COMPLETE_WORK_PRUNE_BATCH } from '../server/arc-intelligence/work-retention.js';
import { createA2RpcClient } from '../server/arc-intelligence/a2-rpc.js';
import { validateReceipt,normalizedLog } from '../server/arc-intelligence/receipt-facts.js';
import { reconcileLogs } from '../api/_lib/arc-intelligence/reconciliation.js';
import { ARC_RPC_URL } from '../api/_lib/arc-intelligence/rpc.js';
import { TRANSFER_TOPIC } from '../api/_lib/arc-intelligence/usdc.js';
import { MAX_ALL_LOGS,MAX_TRANSFER_LOGS } from '../api/_lib/arc-intelligence/core.js';
import { createWorkBurst } from '../server/arc-intelligence/a2-runtime.js';
const hex=(n) => `0x${n.toString(16)}`;
function log(n,i=0,index=i,transfer=true) {return {blockNumber:hex(n),blockHash:hash(n+1),transactionIndex:hex(i),
  transactionHash:transaction(n,i).hash,logIndex:hex(index),address:address(50),topics:[transfer ? TRANSFER_TOPIC : hash(987)],data:hash(123),removed:false};}
function receipt(n,i=0,logs=[log(n,i)]) {return {blockNumber:hex(n),blockHash:hash(n+1),transactionIndex:hex(i),transactionHash:transaction(n,i).hash,
  status:i % 2 ? '0x0' : '0x1',gasUsed:'0x20000000000001',effectiveGasPrice:'0x20000000000002',contractAddress:null,logs};}
let count=0;
async function test(name,work) {await work();count++;console.log(`PASS ${name}`);}
async function setup(blocks=[block(100)]) {
  const pool=fixturePool();await migrate(pool);const chain=createFoundationRepository(pool);await chain.initializeChainLane();
  for (const b of blocks) await chain.persistManifest(CHAIN_IDENTITY,[b]);
  const repository=createReceiptRepository(pool);await repository.initialize();
  return {pool,chain,repository};
}
function worker(ctx,handler,budget=createRpcBudget(),options={}) {
  const calls=[];
  const rpc=budget.wrap({url:ARC_RPC_URL,async request(method,params,options) {
    let depth=0;for (const call of ctx.pool.calls) {if (call.text === 'BEGIN') depth++;if (['COMMIT','ROLLBACK'].includes(call.text)) depth--;}
    assert.equal(depth,0,'No DB transaction open during RPC');calls.push({method,params,options});return handler(method,params,options);
  }});
  return {calls,instance:createReceiptWorker({repository:ctx.repository,rpc,...options})};
}
function observedWorker(ctx,handler,options={}) {
  const events=[],saves=[];
  const getBlock=ctx.repository.getBlock.bind(ctx.repository),saveReceipts=ctx.repository.saveReceipts.bind(ctx.repository);
  ctx.repository.getBlock=async (...args) => {events.push('getBlock');return getBlock(...args);};
  ctx.repository.saveReceipts=async (lease,raw,options) => {
    events.push('saveReceipts');saves.push({raw,options});return saveReceipts(lease,raw,options);
  };
  const w=worker(ctx,(method,...args) => {events.push(method);return handler(method,...args);},createRpcBudget(),options);
  return {...w,events,saves};
}
async function readyLogs(size=10) {
  const ctx=await setup(Array.from({length:size},(_,i) => block(100+i)));
  for (let n=100;n<100+size;n++) {
    await ctx.repository.scheduleBlock(n);
    const lease=await ctx.repository.claim('range-preparation',180000,{preferredComponent:'receipts'});
    await ctx.repository.saveReceipts(lease,[receipt(n,0,[log(n),log(n,0,1,false)])]);
  }
  return ctx;
}
function rangeLogs(start=100,size=10,transfer=false) {
  return Array.from({length:size},(_,i) => [log(start+i),...(transfer ? [] : [log(start+i,0,1,false)])]).flat();
}
function fullHandler(n,count=1) {return (method,params) => {
  if (method === 'eth_getBlockReceipts') return Array.from({length:count},(_,i) => receipt(n,i));
  if (method === 'eth_getLogs') return Array.from({length:count},(_,i) => log(n,i));
  throw new Error('unexpected_call');
};}
async function finish(ctx,instance,n) {await ctx.repository.scheduleBlock(n);for (let i=0;i<3;i++) assert.equal((await instance.runOnce()).status,'complete');}

await test('003 migration upgrades production-like 001/002 ledger once; immutable hashes and A1 retained',async () => {
  assert.deepEqual(MIGRATIONS,['001_init','002_a2_foundation','003_a2_receipts']);
  for (const [name,expected] of [['001_init','c38b78a7e0e1c47e1de5f1400f1502f53f4ce8eeb20fe5d8f328fb59d1992ff0'],
    ['002_a2_foundation','308c747d1b1f1c3fa3cace6daba11434eb5a1ba3709701b657ec1a93c3f43cd5']]) {
    const sql=await readFile(new URL(`../server/arc-intelligence/sql/${name}.sql`,import.meta.url));
    assert.equal(createHash('sha256').update(sql).digest('hex'),expected);
  }
  const pool=fixturePool();await migrate(pool);const a1=structuredClone(pool.store.a1);
  pool.store.migrations.delete('003_a2_receipts');const old=structuredClone(pool.store.migrations);pool.calls.length=0;
  await migrate(pool);await migrate(pool);assert.equal(pool.store.migrations.size,3);assert.deepEqual(pool.store.a1,a1);
  for (const [key,value] of old) assert.deepEqual(pool.store.migrations.get(key),value);
  assert.equal(pool.calls.filter((c) => c.text.startsWith('ALTER TABLE arc_intelligence_blocks')).length,1);
  assert(!pool.calls.some((c) => c.text.startsWith('CREATE TABLE IF NOT EXISTS arc_intelligence_state')));
});
await test('normalized transaction facts retain exact BigInt raw values and selector; duplicate safe, conflicts rejected',async () => {
  const ctx=await setup([block(100,2)]);const before=structuredClone(ctx.pool.store.transactions);
  const first=before.get(transaction(100).hash);assert.equal(first.value_raw,'900719925474099312345');
  assert.equal(first.from_address,address(1));assert.equal(first.to_address,address(2));assert.equal(first.input_selector,'0x12345678');
  assert.equal(before.get(transaction(100,1).hash).to_address,null);assert(!Object.hasOwn(first,'input'));
  await ctx.chain.persistManifest(CHAIN_IDENTITY,[block(100,2)]);assert.deepEqual(ctx.pool.store.transactions,before);
  const conflicting=block(100,2);conflicting.transactions[0].valueRaw='1';
  await assert.rejects(ctx.chain.persistManifest(CHAIN_IDENTITY,[conflicting]),/manifest_conflict/);
  assert.deepEqual(ctx.pool.store.transactions,before);
});
await test('inconsistent/missing transaction list never certifies a block',async () => {
  const ctx=await setup([]);const b=block(100,2);b.transactions[1].transactionIndex=0;
  await assert.rejects(ctx.chain.persistManifest(CHAIN_IDENTITY,[b]));assert.equal(ctx.pool.store.blocks.size,0);
  const absent=block(100);delete absent.transactions;await assert.rejects(ctx.chain.persistManifest(CHAIN_IDENTITY,[absent]));
  assert.equal(ctx.pool.store.transactions.size,0);
});
await test('live tail stops at safe head; raw observed head retained; historical gap does not advance contiguous checkpoint',async () => {
  const ctx=await setup([]);const rpc=fixtureChainRpc({url:ARC_RPC_URL,async request(method,params) {
    if (method === 'eth_chainId') return hex(5042);if (method === 'eth_blockNumber') return hex(1000);
    assert.equal(params[1],true);return rawBlock(Number(BigInt(params[0])));
  }});
  const result=await createChainFollower({repository:ctx.chain,rpc,maxBlocks:3,mode:'live'}).tick();
  assert.equal(result.targetHead,998);assert.equal(result.observedHead,1000);assert.equal(result.persistedBlocks,3);
  const lane=await ctx.chain.getLane();assert.equal(lane.processed_through,998);assert.equal(lane.contiguous_complete_through,null);
  assert.deepEqual([...ctx.pool.store.blocks.keys()],[996,997,998]);assert.equal(lane.observed_head,1000);
});
await test('head below finality offset creates no negative block; contiguous follower still fills from anchor',async () => {
  const ctx=await setup([]);let head=1;
  const rpc=fixtureChainRpc({url:ARC_RPC_URL,async request(method,params) {
    if (method === 'eth_chainId') return hex(5042);if (method === 'eth_blockNumber') return hex(head);return rawBlock(Number(BigInt(params[0])));
  }});
  const follower=createChainFollower({repository:ctx.chain,rpc,maxBlocks:2});assert.equal((await follower.tick()).status,'retrying');
  assert.equal(ctx.pool.store.blocks.size,0);head=103;assert.equal((await follower.tick()).persistedBlocks,2);
  assert.equal((await ctx.chain.getLane()).contiguous_complete_through,101);
});
await test('bulk exact receipt success needs no individual calls; exact statuses/logs/reconciliations durable; core stays false',async () => {
  const ctx=await setup([block(100,2)]);const w=worker(ctx,fullHandler(100,2));await finish(ctx,w.instance,100);
  assert.equal(w.calls.filter((c) => c.method === 'eth_getTransactionReceipt').length,0);
  assert.equal(ctx.pool.store.receipts.size,2);assert.equal(ctx.pool.store.logs.size,2);
  assert.equal(ctx.pool.store.receipts.get(transaction(100,1).hash).status,'failed');
  assert.equal(ctx.pool.store.receipts.get(transaction(100).hash).gas_used_raw,'9007199254740993');
  const b=ctx.pool.store.blocks.get(100);assert.equal(b.receipt_count,2);assert(b.receipt_complete && b.all_log_reconciliation_complete && b.transfer_log_reconciliation_complete);
  assert.equal(b.core_complete,false);assert.equal((await ctx.repository.getLane()).contiguous_complete_through,100);
});
for (const [name,bulk] of [
  ['canonical order',[receipt(100),receipt(100,1)]],
  ['reversed order',[receipt(100,1),receipt(100)]],
]) await test(`complete bulk fast path: ${name}, one final save, no reload or individual RPC`,async () => {
  const ctx=await setup([block(100,2)]);const w=observedWorker(ctx,(method) => {
    assert.equal(method,'eth_getBlockReceipts');return bulk;
  });await ctx.repository.scheduleBlock(100);
  const result=await w.instance.runOnce();assert.equal(result.status,'complete');assert.equal(result.complete,true);
  assert.deepEqual(w.events,['getBlock','eth_getBlockReceipts','saveReceipts']);assert.equal(w.saves.length,1);
  assert.deepEqual(w.saves[0].options,{retryMs:1000,finalize:true,enqueueFollowups:true});
  assert.equal(w.saves[0].raw.length,2);assert.equal(ctx.pool.store.receipts.size,2);
  assert.equal(ctx.pool.store.blocks.get(100).receipt_complete,true);
  assert.equal([...ctx.pool.store.work.values()].find((j) => j.component==='receipts').state,'complete');
  assert.equal(w.calls.filter((c) => c.method==='eth_getTransactionReceipt').length,0);
});
await test('identical duplicate bulk bypasses fast path, safely completes deduped evidence without fabricated conflict',async () => {
  const ctx=await setup([block(100,2)]);const w=observedWorker(ctx,(method) => {
    assert.equal(method,'eth_getBlockReceipts');return [receipt(100),receipt(100,1),receipt(100)];
  });await ctx.repository.scheduleBlock(100);
  const result=await w.instance.runOnce();assert.equal(result.status,'complete');assert.equal(result.complete,true);
  assert.deepEqual(w.events,['getBlock','eth_getBlockReceipts','saveReceipts','getBlock','saveReceipts']);
  assert.equal(w.saves.length,2);assert.equal(w.saves[0].options.finalize,false);
  assert.deepEqual(w.saves[0].raw,[receipt(100),receipt(100,1)]);assert.deepEqual(w.saves[1].raw,[]);
  assert.equal(w.saves[1].options.finalize ?? true,true);assert.equal(w.calls.length,1);
  const b=ctx.pool.store.blocks.get(100);assert.equal(b.receipt_complete,true);assert.equal(b.receipt_evidence_conflict,false);
  assert.equal(ctx.pool.store.receipts.size,2);assert.equal(ctx.pool.store.logs.size,2);
  assert.equal([...ctx.pool.store.work.values()].find((j) => j.component==='receipts').state,'complete');
  assert.notEqual((await ctx.repository.getLane()).status,'persistent_partial');
});
for (const enqueueFollowups of [true,false]) await test(`empty bulk fast path certifies once; enqueueFollowups=${enqueueFollowups}`,async () => {
  const ctx=await setup([block(100,0)]);const w=observedWorker(ctx,(method) => {
    assert.equal(method,'eth_getBlockReceipts');return [];
  });await ctx.repository.scheduleBlock(100);
  assert.equal((await w.instance.runOnce({enqueueFollowups})).status,'complete');
  assert.deepEqual(w.events,['getBlock','eth_getBlockReceipts','saveReceipts']);assert.equal(w.saves.length,1);
  assert.deepEqual(w.saves[0],{raw:[],options:{retryMs:1000,finalize:true,enqueueFollowups}});
  const b=ctx.pool.store.blocks.get(100);assert.equal(b.receipt_count,0);assert.equal(b.receipt_complete,true);
  assert.equal(ctx.pool.store.work.size,enqueueFollowups ? 3 : 1);
  assert.equal([...ctx.pool.store.work.values()][0].state,'complete');
});
await test('complete nonempty bulk fast path preserves drain mode zero followups',async () => {
  const ctx=await setup();const w=observedWorker(ctx,fullHandler(100));await ctx.repository.scheduleBlock(100);
  assert.equal((await w.instance.runOnce({enqueueFollowups:false})).status,'complete');
  assert.deepEqual(w.events,['getBlock','eth_getBlockReceipts','saveReceipts']);
  assert.deepEqual(w.saves[0].options,{retryMs:1000,finalize:true,enqueueFollowups:false});
  assert.equal(ctx.pool.store.work.size,1);assert.equal(ctx.pool.store.receipts.size,1);
  assert.equal([...ctx.pool.store.work.values()][0].state,'complete');
});
await test('complete bulk repository complete:false returns retrying without a same-call second attempt',async () => {
  const ctx=await setup();const w=observedWorker(ctx,fullHandler(100));let saves=0;
  ctx.repository.saveReceipts=async (lease,raw,options) => {
    saves++;w.events.push('saveReceipts');assert.equal(raw.length,1);
    assert.deepEqual(options,{retryMs:1000,finalize:true,enqueueFollowups:true});
    return {complete:false,receiptCount:0,missingCount:1};
  };
  await ctx.repository.scheduleBlock(100);const result=await w.instance.runOnce();
  assert.equal(result.status,'retrying');assert.equal(result.complete,false);assert.equal(result.missingCount,1);
  assert.equal(saves,1);assert.deepEqual(w.events,['getBlock','eth_getBlockReceipts','saveReceipts']);
  assert.equal(w.calls.length,1);assert.equal(ctx.pool.store.receipts.size,0);
});
await test('partial bulk persists valid evidence before bounded missing-only recovery and two saves',async () => {
  const ctx=await setup([block(100,3)]);const w=observedWorker(ctx,(method,params) => {
    if (method==='eth_getBlockReceipts') return [receipt(100)];
    assert.equal(method,'eth_getTransactionReceipt');assert.equal(params[0],transaction(100,1).hash);
    assert.equal(ctx.pool.store.receipts.size,1,'Bulk evidence must be durable before individual recovery');
    return receipt(100,1);
  },{maxReceiptReads:1});await ctx.repository.scheduleBlock(100);
  assert.equal((await w.instance.runOnce()).status,'retrying');
  assert.deepEqual(w.events,['getBlock','eth_getBlockReceipts','saveReceipts','getBlock','eth_getTransactionReceipt','saveReceipts']);
  assert.equal(w.saves.length,2);assert.equal(w.saves[0].options.finalize,false);
  assert.equal(w.saves[1].options.finalize ?? true,true);assert.equal(w.saves[1].raw.length,1);
  assert.equal(ctx.pool.store.receipts.size,2);assert.equal(ctx.pool.store.blocks.get(100).receipt_complete,false);
});
for (const [name,bulk] of [
  ['missing canonical hash despite matching raw count',[receipt(100),receipt(100)]],
  ['wrong transaction hash',[receipt(100),{...receipt(100,1),transactionHash:hash(999)}]],
  ['conflicting receipt payload',[receipt(100),receipt(100,1),{...receipt(100),gasUsed:'0x1'}]],
  ['conflicting log ownership',[receipt(100),receipt(100,1,[log(100,1,0)])]],
]) await test(`${name} prevents complete bulk fast path and recovers only missing hashes`,async () => {
  const ctx=await setup([block(100,2)]);const w=observedWorker(ctx,(method,params) => {
    if (method==='eth_getBlockReceipts') return bulk;
    assert.equal(method,'eth_getTransactionReceipt');
    return receipt(100,params[0]===transaction(100).hash ? 0 : 1);
  });await ctx.repository.scheduleBlock(100);
  assert.equal((await w.instance.runOnce()).status,'complete');assert.equal(w.events.filter((e) => e==='getBlock').length,2);
  assert(w.calls.some((c) => c.method==='eth_getTransactionReceipt'));
  if (w.saves.length===2) assert.equal(w.saves[0].options.finalize,false);
  assert.equal(ctx.pool.store.receipts.size,2);assert.equal(ctx.pool.store.blocks.get(100).receipt_evidence_conflict,false);
});
for (const [name,invalid] of [
  ['malformed',null],['unknown status',{...receipt(100),status:'unknown'}],
  ['wrong block',receipt(101)],['wrong transaction position',{...receipt(100),transactionIndex:'0x1'}],
  ['wrong log ownership',receipt(100,0,[{...log(100),transactionHash:transaction(100,1).hash}])],
]) await test(`extra ${name} receipt prevents fast path even with a complete valid subset`,async () => {
  const ctx=await setup([block(100,2)]);const w=observedWorker(ctx,(method) => {
    assert.equal(method,'eth_getBlockReceipts');return [receipt(100),receipt(100,1),invalid];
  });await ctx.repository.scheduleBlock(100);assert.equal((await w.instance.runOnce()).status,'complete');
  assert.deepEqual(w.events,['getBlock','eth_getBlockReceipts','saveReceipts','getBlock','saveReceipts']);
  assert.equal(w.saves.length,2);assert.equal(w.saves[0].options.finalize,false);
  assert.equal(ctx.pool.store.receipts.size,2);assert.equal(w.calls.length,1);
});
for (const failure of ['throw','nonarray']) await test(`empty block ${failure} bulk result is not a successful empty fast path`,async () => {
  const ctx=await setup([block(100,0)]);const w=observedWorker(ctx,(method) => {
    assert.equal(method,'eth_getBlockReceipts');if (failure==='throw') throw new Error('transient');return null;
  });await ctx.repository.scheduleBlock(100);assert.equal((await w.instance.runOnce()).status,'complete');
  assert.deepEqual(w.events,['getBlock','eth_getBlockReceipts','getBlock','saveReceipts']);
  assert.equal(w.saves.length,1);assert.equal(w.saves[0].options.finalize,undefined);
  assert.equal(ctx.pool.store.blocks.get(100).receipt_count,0);
});
await test('bulk failure and partial individual successes persist; retry reads only missing hashes and clears error',async () => {
  const ctx=await setup([block(100,3)]);let fail=true;
  const w=worker(ctx,(method,params) => {
    if (method === 'eth_getBlockReceipts') throw new Error('transient');
    if (method === 'eth_getTransactionReceipt') {const i=[0,1,2].find((i) => transaction(100,i).hash === params[0]);if (i === 1 && fail) throw new Error('transient');return receipt(100,i);}
    return [0,1,2].map((i) => log(100,i));
  });
  await ctx.repository.scheduleBlock(100);assert.equal((await w.instance.runOnce()).status,'retrying');
  assert.equal(ctx.pool.store.receipts.size,2);assert.equal(ctx.pool.store.blocks.get(100).receipt_count,null);assert.equal(ctx.pool.store.blocks.get(100).receipt_complete,false);
  assert.equal((await ctx.repository.getLane()).current_error_code,'required_read_unavailable');
  assert.deepEqual([...ctx.pool.store.work.values()].map((j) => j.component),['receipts'],'No reconciliation before exact receipts');
  fail=false;ctx.pool.advance(1000);const start=w.calls.length;assert.equal((await w.instance.runOnce()).status,'complete');
  assert.deepEqual(w.calls.slice(start).map((c) => [c.method,c.params[0]]),[['eth_getTransactionReceipt',transaction(100,1).hash]]);
  assert.equal(w.calls.filter((c) => c.method === 'eth_getBlockReceipts').length,1);
  assert.equal((await w.instance.runOnce()).status,'complete');assert.equal((await w.instance.runOnce()).status,'complete');
  const lane=await ctx.repository.getLane();assert.equal(lane.current_error_code,null);assert.equal(lane.status,'caught_up');
  assert([...ctx.pool.store.work.values()].every((j) => j.state === 'complete'));
});
await test('partial/malformed/unknown bulk rows preserve independently valid receipts, retry only missing',async () => {
  const ctx=await setup([block(100,2)]);const w=worker(ctx,(method,params) => {
    if (method === 'eth_getBlockReceipts') return [receipt(100),{...receipt(100,1),status:'unknown'},receipt(101),null];
    assert.equal(method,'eth_getTransactionReceipt');assert.equal(params[0],transaction(100,1).hash);return receipt(100,1);
  });await ctx.repository.scheduleBlock(100);assert.equal((await w.instance.runOnce()).status,'complete');
  assert.equal(ctx.pool.store.receipts.size,2);assert.equal(ctx.pool.store.logs.size,2);
});
await test('empty block is explicitly certified, with no fabricated missing receipt and core remains false',async () => {
  const ctx=await setup([block(100,0)]);const w=worker(ctx,() => []);await finish(ctx,w.instance,100);
  assert.equal(ctx.pool.store.blocks.get(100).receipt_count,0);assert.equal(ctx.pool.store.blocks.get(100).core_complete,false);
  assert.equal((await ctx.repository.getLane()).contiguous_complete_through,100);
});
await test('50 incomplete recent blocks with 40 durable receipt jobs returns only ten missing blocks',async () => {
  const blocks=Array.from({length:50},(_,i) => block(100+i));const ctx=await setup(blocks);
  const states=['pending','retrying','leased','persistent_partial','complete'];
  for (let i=0;i<40;i++) {
    const b=blocks[i];const row=await ctx.chain.enqueue(RECEIPT_IDENTITY,{component:'receipts',logicalKey:b.block_hash,
      startBlock:b.block_number,endBlock:b.block_number,blockHash:b.block_hash});
    ctx.pool.store.work.get(row.id).state=states[i%states.length];
  }
  assert.deepEqual(await ctx.repository.recentIncompleteBlocks(149),Array.from({length:10},(_,i) => 140+i));
});
for (const state of ['pending','retrying','leased','complete']) await test(`${state} receipt work suppresses recent scheduling`,async () => {
  const ctx=await setup([block(100)]);const b=ctx.pool.store.blocks.get(100);
  const row=await ctx.chain.enqueue(RECEIPT_IDENTITY,{component:'receipts',logicalKey:b.block_hash,
    startBlock:100,endBlock:100,blockHash:b.block_hash});ctx.pool.store.work.get(row.id).state=state;
  assert.deepEqual(await ctx.repository.recentIncompleteBlocks(100),[]);
});
await test('receipt-complete block with only all_logs work is recovered once and scheduleBlock adds only missing transfer work',async () => {
  const ctx=await setup([block(100,0)]);const b=ctx.pool.store.blocks.get(100);
  Object.assign(b,{receipt_complete:true,receipt_count:0,all_log_reconciliation_complete:false,transfer_log_reconciliation_complete:false});
  await ctx.chain.enqueue(RECEIPT_IDENTITY,{component:'all_logs',logicalKey:b.block_hash,startBlock:100,endBlock:100,blockHash:b.block_hash});
  assert.deepEqual(await ctx.repository.recentIncompleteBlocks(100),[100]);
  const before=ctx.pool.store.work.size;await ctx.repository.scheduleBlock(100);assert.equal(ctx.pool.store.work.size,before+1);
  assert.equal([...ctx.pool.store.work.values()].filter((w) => w.component==='all_logs').length,1);
  assert.equal([...ctx.pool.store.work.values()].filter((w) => w.component==='transfer_logs').length,1);
  assert.deepEqual(await ctx.repository.recentIncompleteBlocks(100),[]);
});
await test('receipt-complete block with both durable log jobs is not scheduled again',async () => {
  const ctx=await setup([block(100,0)]);const b=ctx.pool.store.blocks.get(100);
  Object.assign(b,{receipt_complete:true,receipt_count:0,all_log_reconciliation_complete:false,transfer_log_reconciliation_complete:false});
  for (const component of ['all_logs','transfer_logs']) await ctx.chain.enqueue(RECEIPT_IDENTITY,{component,logicalKey:b.block_hash,
    startBlock:100,endBlock:100,blockHash:b.block_hash});
  assert.deepEqual(await ctx.repository.recentIncompleteBlocks(100),[]);
});
await test('missing receipt work is returned and scheduleBlock creates it',async () => {
  const ctx=await setup([block(100)]);assert.deepEqual(await ctx.repository.recentIncompleteBlocks(100),[100]);
  const jobs=await ctx.repository.scheduleBlock(100);assert.equal(jobs.length,1);assert.equal(jobs[0].component,'receipts');
  assert.deepEqual(await ctx.repository.recentIncompleteBlocks(100),[]);
});
await test('other lane epoch/definition work does not suppress exact-identity recovery',async () => {
  const ctx=await setup([block(100)]);const b=ctx.pool.store.blocks.get(100);
  const otherIdentities=[{...RECEIPT_IDENTITY,epoch:'other-epoch',definitionVersion:'other-definition'},
    {...RECEIPT_IDENTITY,lane:'other-lane'},{...RECEIPT_IDENTITY,scopeId:'other-scope'}];
  for (const other of otherIdentities) await ctx.chain.enqueue(other,{component:'receipts',logicalKey:b.block_hash,
    startBlock:100,endBlock:100,blockHash:b.block_hash});
  assert.deepEqual(await ctx.repository.recentIncompleteBlocks(100),[100]);
  const isolated=createReceiptRepository(ctx.pool,otherIdentities[0]);assert.deepEqual(await isolated.recentIncompleteBlocks(100),[]);
});
await test('recent incomplete scan stays within the bounded last-50-block window',async () => {
  const ctx=await setup(Array.from({length:60},(_,i) => block(100+i)));
  assert.deepEqual(await ctx.repository.recentIncompleteBlocks(159),Array.from({length:50},(_,i) => 110+i));
  for (const tail of [0,51,1.5]) await assert.rejects(ctx.repository.recentIncompleteBlocks(159,tail),/invalid_recent_tail/);
});
await test('receipt duplicate idempotent; conflicting payload/identity/log evidence rejected without overwrite',async () => {
  const ctx=await setup();await ctx.repository.scheduleBlock(100);const lease=await ctx.repository.claim('test');
  await ctx.repository.saveReceipts(lease,[receipt(100)],{finalize:false});const saved=structuredClone(ctx.pool.store.receipts);
  await ctx.repository.saveReceipts(lease,[receipt(100)],{finalize:false});assert.equal(ctx.pool.store.logs.size,1);
  await assert.rejects(ctx.repository.saveReceipts(lease,[{...receipt(100),gasUsed:'0x1'}]),/receipt_evidence_conflict/);
  await assert.rejects(ctx.repository.saveReceipts(lease,[receipt(101)]));
  await assert.rejects(ctx.repository.saveReceipts(lease,[{...receipt(100),logs:[log(100),log(100)]}]));
  await assert.rejects(ctx.repository.saveReceipts(lease,[receipt(100,0,[{...log(100),data:hash(321)}])]),/receipt_evidence_conflict/);
  assert.deepEqual(ctx.pool.store.receipts,saved);assert.equal(ctx.pool.store.logs.size,1);
});
await test('log identity collision across transactions and wrong receipt position cannot certify coverage',async () => {
  const ctx=await setup([block(100,2)]);await ctx.repository.scheduleBlock(100);const lease=await ctx.repository.claim('test');
  await assert.rejects(ctx.repository.saveReceipts(lease,[{...receipt(100),transactionIndex:'0x1'}]));
  await assert.rejects(ctx.repository.saveReceipts(lease,[receipt(100,0,[{...log(100),removed:true}])]));
  await assert.rejects(ctx.repository.saveReceipts(lease,[receipt(100),receipt(100,1,[log(100,1,0)])]),/receipt_response_conflict/);
  assert.equal(ctx.pool.store.receipts.size,0);assert.equal(ctx.pool.store.logs.size,0);
  assert.equal(ctx.pool.store.blocks.get(100).receipt_complete,false);
});
await test('conflicting untrusted bulk duplicates fall back to individual RPC, with no arbitrary winner or lane halt',async () => {
  const ctx=await setup();const w=worker(ctx,(method) => {
    if (method === 'eth_getBlockReceipts') return [receipt(100),{...receipt(100),gasUsed:'0x1'}];
    if (method === 'eth_getTransactionReceipt') return {...receipt(100),gasUsed:'0x2'};
    return [log(100)];
  });await finish(ctx,w.instance,100);
  assert.equal(w.calls.filter((c) => c.method === 'eth_getTransactionReceipt').length,1);
  assert.equal(ctx.pool.store.receipts.get(transaction(100).hash).gas_used_raw,'2');
  assert.equal(ctx.pool.store.blocks.get(100).receipt_evidence_conflict,false);
  assert.equal((await ctx.repository.getLane()).status,'caught_up');
});
await test('conflicting bulk remains unresolved when individual lookup fails; no persistent conflict fabricated',async () => {
  const ctx=await setup();const w=worker(ctx,(method) => {
    if (method === 'eth_getBlockReceipts') return [receipt(100),{...receipt(100),gasUsed:'0x1'}];
    throw new Error('transient');
  });await ctx.repository.scheduleBlock(100);assert.equal((await w.instance.runOnce()).status,'retrying');
  assert.equal(ctx.pool.store.receipts.size,0);assert.equal(ctx.pool.store.blocks.get(100).receipt_evidence_conflict,false);
  assert.equal((await ctx.repository.getLane()).status,'retrying');
});
await test('conflicting new individual response batch is unresolved, not a fabricated durable evidence conflict',async () => {
  const ctx=await setup([block(100,2)]);const w=worker(ctx,(method,params) => {
    if (method === 'eth_getBlockReceipts') return [receipt(100),receipt(100,1,[log(100,1,0)])];
    const i=params[0] === transaction(100).hash ? 0 : 1;return receipt(100,i,[log(100,i,0)]);
  });await ctx.repository.scheduleBlock(100);assert.equal((await w.instance.runOnce()).status,'retrying');
  assert.equal(ctx.pool.store.receipts.size,0);assert.equal(ctx.pool.store.blocks.get(100).receipt_evidence_conflict,false);
  assert.equal((await ctx.repository.getLane()).status,'retrying');
});
await test('durable log conflict quarantines block N, while N+1 completes and persistent conflict remains visible',async () => {
  const ctx=await setup([block(100,2),block(101)]);let n=100;
  const w=worker(ctx,(method) => {
    if (n === 101) return fullHandler(101)(method);
    if (method === 'eth_getBlockReceipts') return [receipt(100)];
    if (method === 'eth_getTransactionReceipt') return receipt(100,1,[log(100,1,0)]);
    throw new Error('unexpected');
  });await ctx.repository.scheduleBlock(100);assert.equal((await w.instance.runOnce()).status,'persistent_partial');
  const saved=structuredClone(ctx.pool.store.receipts);assert.equal(saved.size,1);assert.equal(ctx.pool.store.logs.size,1);
  assert.equal(ctx.pool.store.blocks.get(100).receipt_evidence_conflict,true);assert.equal(ctx.pool.store.blocks.get(100).receipt_complete,false);
  n=101;await finish(ctx,w.instance,101);
  const lane=await ctx.repository.getLane();assert.equal(lane.processed_through,101);assert.equal(lane.contiguous_complete_through,null);
  assert.equal(lane.status,'persistent_partial');assert.equal(lane.current_error_code,'manifest_conflict');
  assert.equal(ctx.pool.store.blocks.get(101).transfer_log_reconciliation_complete,true);
  assert.equal(ctx.pool.store.receipts.get(transaction(100,1).hash),undefined);assert.equal(ctx.pool.store.receipts.size,2);
  assert([...ctx.pool.store.work.values()].some((j) => j.start_block === 100 && j.state === 'persistent_partial'));
});
await test('durable conflict atomically invalidates only current block coverage, preserving digests and all facts',async () => {
  const ctx=await setup([block(100),block(101)]);let n=100;const w=worker(ctx,(...args) => fullHandler(n)(...args));
  await finish(ctx,w.instance,100);n=101;await finish(ctx,w.instance,101);
  const current100=[...ctx.pool.store.coverage.values()].filter((c) => c.identity[1] === 'receipts_logs' && c.start === 100 && c.end === 100);
  assert.equal(current100.length,3);assert(current100.every((c) => c.state === 'complete'));
  assert.deepEqual(current100.map((c) => c.dimension).sort(),['all_log_reconciliation','receipts','transfer_log_reconciliation']);
  const historical=structuredClone(current100[0]);historical.identity[4]='historical-receipts-fixture';
  ctx.pool.store.coverage.set('historical-coverage',historical);
  const facts=structuredClone(ctx.pool.store.receipts);const logs=structuredClone(ctx.pool.store.logs);
  const evidence=structuredClone(ctx.pool.store.reconciliation);const previousCoverage=structuredClone(ctx.pool.store.coverage);
  const originalBlock=structuredClone(ctx.pool.store.blocks.get(100));
  const job=[...ctx.pool.store.work.values()].find((j) => j.component === 'receipts' && j.start_block === 100);job.state='pending';ctx.pool.advance(1000);
  const lease=await ctx.repository.claim('conflict');assert(lease);
  await assert.rejects(ctx.repository.saveReceipts(lease,[{...receipt(100),gasUsed:'0x1'}]),/receipt_evidence_conflict/);
  ctx.pool.fail('receipts:invalidate_coverage');await assert.rejects(ctx.repository.recordConflict(lease));
  assert.deepEqual(ctx.pool.store.blocks.get(100),originalBlock,'Coverage update failure rolls back block quarantine');
  assert.deepEqual(ctx.pool.store.coverage,previousCoverage);
  await ctx.repository.recordConflict(lease);
  const b=ctx.pool.store.blocks.get(100);assert(b.receipt_evidence_conflict);assert.equal(b.receipt_complete,false);
  assert.equal(b.all_log_reconciliation_complete,false);assert.equal(b.transfer_log_reconciliation_complete,false);assert.equal(b.core_complete,false);
  let invalidated=0;
  for (const [key,previous] of previousCoverage) {
    const isCurrent100=previous.identity[1] === 'receipts_logs' && previous.identity[4] === ctx.repository.identity.definitionVersion
      && previous.start === 100 && previous.end === 100;
    assert.deepEqual(ctx.pool.store.coverage.get(key),isCurrent100 ? {...previous,state:'partial'} : previous);
    if (isCurrent100) invalidated++;
  }
  assert.equal(invalidated,3);
  const current101=[...ctx.pool.store.coverage.values()].filter((c) => c.identity[1] === 'receipts_logs' && c.start === 101);
  assert.equal(current101.length,3);assert(current101.every((c) => c.state === 'complete'));
  assert.deepEqual(ctx.pool.store.receipts,facts);assert.deepEqual(ctx.pool.store.logs,logs);assert.deepEqual(ctx.pool.store.reconciliation,evidence);
  assert.equal((await ctx.repository.getLane()).contiguous_complete_through,null);assert.equal((await ctx.repository.getLane()).processed_through,101);
  assert.equal((await ctx.repository.getLane()).status,'persistent_partial');
});
for (const [name,modify,field] of [
  ['missing',() => [],'missing_count'],['extra',(logs) => [...logs,{...logs[0],logIndex:'0x1'}],'extra_count'],
  ['duplicate',(logs) => [...logs,...logs],'duplicate_query_count'],['identityless',(logs) => [{...logs[0],transactionHash:null}],'identityless_query_count'],
  ['payload mismatch',(logs) => [{...logs[0],data:hash(999)}],'payload_mismatch_count'],
]) await test(`${name} log query cannot certify all or Transfer reconciliation`,async () => {
  const ctx=await setup();const w=worker(ctx,(method) => method === 'eth_getBlockReceipts' ? [receipt(100)] : modify([log(100)]));
  await ctx.repository.scheduleBlock(100);assert.equal((await w.instance.runOnce()).status,'complete');
  assert.equal((await w.instance.runOnce()).status,'retrying');assert.equal((await w.instance.runOnce()).status,'retrying');
  for (const e of ctx.pool.store.reconciliation.values()) {
    assert.equal(e.complete,false);
    if (name==='identityless') {assert.equal(e.query_complete,false);assert.equal(e.reason_code,'query_unavailable');}
    else assert(e[field] > 0);
  }
  assert.equal((await ctx.repository.getLane()).contiguous_complete_through,null);assert.equal(ctx.pool.store.blocks.get(100).core_complete,false);
});
await test('failed all-log query retries only all-log work, keeps complete Transfer certificate and receipts',async () => {
  const ctx=await setup();let fail=true;
  const w=worker(ctx,(method,params) => {if (method === 'eth_getBlockReceipts') return [receipt(100)];
    if (!params[0].topics && fail) throw new Error('transient');return [log(100)];});
  await ctx.repository.scheduleBlock(100);await w.instance.runOnce();assert.equal((await w.instance.runOnce()).status,'retrying');
  assert.equal((await w.instance.runOnce()).status,'complete');assert.equal(ctx.pool.store.blocks.get(100).receipt_complete,true);
  assert.equal(ctx.pool.store.blocks.get(100).all_log_reconciliation_complete,false);
  const start=w.calls.length;fail=false;ctx.pool.advance(1000);assert.equal((await w.instance.runOnce()).status,'complete');
  assert.equal(w.calls.length,start+1);assert.equal(w.calls.at(-1).method,'eth_getLogs');assert(!w.calls.at(-1).params[0].topics);
  assert.equal((await ctx.repository.getLane()).current_error_code,null);
});
await test('failed Transfer query retries only Transfer work, complete evidence never downgraded',async () => {
  const ctx=await setup();let fail=true;
  const w=worker(ctx,(method,params) => {if (method === 'eth_getBlockReceipts') return [receipt(100)];
    if (params[0].topics && fail) throw new Error('transient');return [log(100)];});
  await ctx.repository.scheduleBlock(100);await w.instance.runOnce();await w.instance.runOnce();assert.equal((await w.instance.runOnce()).status,'retrying');
  const all=structuredClone([...ctx.pool.store.reconciliation.values()].find((r) => r.kind === 'all_logs'));
  const completeCoverage=new Map([...ctx.pool.store.coverage].filter(([,c]) => c.state === 'complete').map(([key,c]) => [key,structuredClone(c)]));
  const start=w.calls.length;fail=false;ctx.pool.advance(1000);assert.equal((await w.instance.runOnce()).status,'complete');
  assert.equal(w.calls.length,start+1);assert(w.calls.at(-1).params[0].topics);
  assert.deepEqual([...ctx.pool.store.reconciliation.values()].find((r) => r.kind === 'all_logs'),all);
  for (const [key,c] of completeCoverage) assert.deepEqual(ctx.pool.store.coverage.get(key),c,'Transient retry preserves complete coverage');
  const job=[...ctx.pool.store.work.values()].find((j) => j.component === 'all_logs');job.state='pending';
  const lease=await ctx.repository.claim('repeat');await ctx.repository.saveReconciliation(lease,{});
  assert.deepEqual([...ctx.pool.store.reconciliation.values()].find((r) => r.kind === 'all_logs'),all);
  assert.equal(ctx.pool.store.blocks.get(100).core_complete,false);
});
await test('complete island beyond gap remains blocked; closing gap advances durable checkpoint without rereading island',async () => {
  const ctx=await setup([block(100),block(101)]);let n=101;const w=worker(ctx,(...args) => fullHandler(n)(...args));
  await finish(ctx,w.instance,101);assert.equal((await ctx.repository.getLane()).processed_through,101);
  assert.equal((await ctx.repository.getLane()).contiguous_complete_through,null);const old=w.calls.length;n=100;
  await finish(ctx,w.instance,100);assert.equal((await ctx.repository.getLane()).contiguous_complete_through,101);
  assert.equal(w.calls.length,old+3);assert.equal(ctx.pool.store.logs.size,2);
});
await test('stale fencing cannot persist any receipt or overwrite newer recovered work',async () => {
  const ctx=await setup();await ctx.repository.scheduleBlock(100);const old=await ctx.repository.claim('old',1000);ctx.pool.advance(1001);
  const lease=await ctx.repository.claim('new',1000);await assert.rejects(ctx.repository.saveReceipts(old,[receipt(100)]),/stale_lease/);
  assert.equal(ctx.pool.store.receipts.size,0);await ctx.repository.saveReceipts(lease,[receipt(100)]);
  await assert.rejects(ctx.repository.retry(old),/stale_lease/);assert.equal(ctx.pool.store.receipts.size,1);
});
await test('crash during receipt/log commit rolls back both; durable bulk progress survives later commit failure',async () => {
  const ctx=await setup([block(100,2)]);let attempt=0;
  const w=worker(ctx,(method,params) => {if (method === 'eth_getBlockReceipts') return [receipt(100)];
    if (method === 'eth_getTransactionReceipt') {attempt++;ctx.pool.fail('receipts:insert_log');return receipt(100,1);}return [log(100),log(100,1)];});
  await ctx.repository.scheduleBlock(100);assert.equal((await w.instance.runOnce()).status,'retrying');
  assert.equal(ctx.pool.store.receipts.size,1);assert.equal(ctx.pool.store.logs.size,1);assert.equal(ctx.pool.store.blocks.get(100).receipt_complete,false);
  const fixed=worker(ctx,(method,params) => {assert.equal(method,'eth_getTransactionReceipt');assert.equal(params[0],transaction(100,1).hash);return receipt(100,1);});
  ctx.pool.advance(1000);assert.equal((await fixed.instance.runOnce()).status,'complete');assert.equal(ctx.pool.store.receipts.size,2);
  assert.equal(ctx.pool.store.logs.size,2);assert.equal(attempt,1);
});
await test('expired/crashed attempt resumes missing-only even before first receipt commit',async () => {
  const ctx=await setup();await ctx.repository.scheduleBlock(100);const old=await ctx.repository.claim('crashed',1000);
  assert.equal(await ctx.repository.markBulkAttempted(old),true);ctx.pool.advance(1001);
  const w=worker(ctx,(method) => {assert.equal(method,'eth_getTransactionReceipt');return receipt(100);});
  assert.equal((await w.instance.runOnce()).status,'complete');assert.equal(w.calls.length,1);
});
await test('same A2 budget caps simultaneous chain/receipt reads at four, queued and active AbortSignal cancel',async () => {
  const budget=createRpcBudget();let active=0,peak=0;
  const rpc=budget.wrap({url:ARC_RPC_URL,async request(method,params,{signal}={}) {
    active++;peak=Math.max(peak,active);try {await new Promise((resolve,reject) => {
      const timer=setTimeout(resolve,10);signal?.addEventListener('abort',() => {clearTimeout(timer);reject(new Error('aborted'));},{once:true});
    });return 1;} finally {active--;}
  }});
  await Promise.all(Array.from({length:12},() => rpc.request('test',[])));assert.equal(peak,4);
  const controller=new AbortController();const activeCalls=Array.from({length:4},() => rpc.request('test',[],{signal:controller.signal}));
  const queued=rpc.request('test',[],{signal:controller.signal});await Promise.resolve();controller.abort();
  const results=await Promise.allSettled([...activeCalls,queued]);assert(results.every((r) => r.status === 'rejected'));assert.equal(budget.pending,0);
});
await test('canonical A2 RPC adapter delivers active abort to fetch and has one request attempt',async () => {
  const budget=createRpcBudget();const controller=new AbortController();let calls=0;let start;
  const started=new Promise((resolve) => {start=resolve;});
  const rpc=createA2RpcClient({budget,fetchImpl:async (url,init) => {
    assert.equal(url,ARC_RPC_URL);calls++;start();return new Promise((resolve,reject) => {
      init.signal.addEventListener('abort',() => reject(new Error('aborted')),{once:true});
    });
  }});
  const result=rpc.request('eth_blockNumber',[],{signal:controller.signal});await started;controller.abort();
  await assert.rejects(result);assert.equal(calls,1);
});
await test('worker shutdown persists no unobserved receipt success; retry state remains recoverable',async () => {
  const ctx=await setup();const controller=new AbortController();
  const w=worker(ctx,(method,params,{signal}) => {assert.equal(signal,controller.signal);controller.abort();return [receipt(100)];});
  await ctx.repository.scheduleBlock(100);assert.equal((await w.instance.runOnce({signal:controller.signal})).status,'aborted');
  assert.equal(ctx.pool.store.receipts.size,0);assert.equal(ctx.pool.store.blocks.get(100).receipt_complete,false);
  assert.equal([...ctx.pool.store.work.values()][0].state,'retrying');
});
await test('shared reconciliation rejects duplicate receipt identities and retains exact P0 payload comparison',async () => {
  const ctx=await setup();const view=await ctx.repository.getBlock(100);const logs=validateReceipt(receipt(100),view).logs;
  assert.equal(reconcileLogs(logs,logs,{receiptSetComplete:true,queryComplete:true},'all').complete,true);
  assert.equal(reconcileLogs([...logs,...logs],logs,{receiptSetComplete:true,queryComplete:true},'all').complete,false);
  assert.equal(reconcileLogs(logs,logs,{receiptSetComplete:false,queryComplete:true},'all').complete,false);
});
await test('A2 repositories never issue A1 writes; default runtime remains A1 and storage contains no raw response',async () => {
  const ctx=await setup();const a1=structuredClone(ctx.pool.store.a1);const w=worker(ctx,fullHandler(100));await finish(ctx,w.instance,100);
  assert.deepEqual(ctx.pool.store.a1,a1);
  assert(!ctx.pool.calls.some((c) => /(?:INSERT INTO|UPDATE|DELETE FROM|ALTER TABLE) arc_intelligence_(?:state|chunks|latest|runs)\b/.test(c.text)));
  const main=await readFile(new URL('../server/arc-intelligence/main.js',import.meta.url),'utf8');
  assert(!/createChainFollower|createReceiptWorker|createA2RpcClient/.test(main));
  assert(main.includes("runtimeConfig.mode === 'a1'"));
  const sql=await readFile(new URL('../server/arc-intelligence/sql/003_a2_receipts.sql',import.meta.url),'utf8');assert(!/jsonb|raw_payload|full_input/i.test(sql));
  assert.equal([...ctx.pool.store.logs.values()].map(normalizedLog).length,1);
});
await test('incremental live follower makes zero reads at same head, one at +1, and bounds a large jump',async () => {
  const ctx=await setup([]);let head=1000;const reads=[];
  const rpc=fixtureChainRpc({url:ARC_RPC_URL,async request(method,params) {
    if (method === 'eth_chainId') return hex(5042);if (method === 'eth_blockNumber') return hex(head);
    reads.push(Number(BigInt(params[0])));return rawBlock(reads.at(-1));
  }});
  const follower=createChainFollower({repository:ctx.chain,rpc,maxBlocks:3,mode:'live'});
  assert.equal((await follower.tick()).persistedBlocks,3);assert.deepEqual(reads,[996,997,998]);
  reads.length=0;assert.equal((await follower.tick()).persistedBlocks,0);assert.deepEqual(reads,[]);
  head++;assert.equal((await follower.tick()).persistedBlocks,1);assert.deepEqual(reads,[999]);
  reads.length=0;head=1200;assert.equal((await follower.tick()).persistedBlocks,3);assert.deepEqual(reads,[1000,1001,1002]);
  const lane=await ctx.chain.getLane();assert.equal(lane.processed_through,1002);assert.equal(lane.observed_head,1200);
  assert.equal(lane.contiguous_complete_through,null);
});
await test('closing one gap advances across 120 certified blocks in bounded DB-only pages, with no island RPC reads',async () => {
  const ctx=await setup(Array.from({length:121},(_,i) => block(100+i)));let n=101;
  const w=worker(ctx,(...args) => fullHandler(n)(...args));
  for (;n<=220;n++) await finish(ctx,w.instance,n);
  assert.equal((await ctx.repository.getLane()).contiguous_complete_through,null);
  const reads=w.calls.length;const calls=ctx.pool.calls.length;n=100;await finish(ctx,w.instance,100);
  assert.equal((await ctx.repository.getLane()).contiguous_complete_through,220);
  assert.equal((await ctx.repository.getLane()).checkpoint_hash,hash(221));assert.equal(w.calls.length,reads+3);
  const pages=ctx.pool.calls.slice(calls).filter((c) => c.text.includes('receipts:advance'));
  assert(pages.some((c) => c.values[1] === 150));assert(pages.some((c) => c.values[1] === 200));
  assert(pages.every((c) => c.values[2] === 50));assert.equal(ctx.pool.store.receipts.size,121);
});
await test('interrupted DB-only frontier resumes from certified data on reschedule, without any RPC reread',async () => {
  const ctx=await setup(Array.from({length:121},(_,i) => block(100+i)));let n=101;
  const w=worker(ctx,(...args) => fullHandler(n)(...args));
  for (;n<=220;n++) await finish(ctx,w.instance,n);
  const connect=ctx.pool.connect.bind(ctx.pool);let fail=true;
  ctx.pool.connect=async () => {const client=await connect();const query=client.query.bind(client);
    client.query=async (sql,values=[]) => {
      if (fail && sql.includes('receipts:advance') && values[1] === 150) {fail=false;throw new Error('Injected frontier interruption');}
      return query(sql,values);
    };return client;
  };
  n=100;await ctx.repository.scheduleBlock(100);await w.instance.runOnce();await w.instance.runOnce();
  assert.equal((await w.instance.runOnce()).status,'retrying');assert.equal((await ctx.repository.getLane()).contiguous_complete_through,149);
  const reads=w.calls.length;assert.deepEqual(await ctx.repository.scheduleBlock(100),[]);
  assert.equal((await ctx.repository.getLane()).contiguous_complete_through,220);assert.equal(w.calls.length,reads);
});
await test('canonical mismatch in later DB-only page halts continuity without exposing an invalid frontier',async () => {
  const ctx=await setup(Array.from({length:121},(_,i) => block(100+i)));let n=101;
  const w=worker(ctx,(...args) => fullHandler(n)(...args));for (;n<=220;n++) await finish(ctx,w.instance,n);
  ctx.pool.store.blocks.get(177).parent_hash=hash(999);n=100;
  await ctx.repository.scheduleBlock(100);await w.instance.runOnce();await w.instance.runOnce();
  assert.equal((await w.instance.runOnce()).status,'continuity_error');const lane=await ctx.repository.getLane();
  assert.equal(lane.status,'continuity_error');assert.equal(lane.current_error_code,'checkpoint_parent_hash_mismatch');
  assert.equal(lane.contiguous_complete_through,149);assert.equal(ctx.pool.store.blocks.get(100).core_complete,false);
});
await test('DB-only frontier stops at exact incomplete or conflicting boundary beyond its first page',async () => {
  const ctx=await setup(Array.from({length:121},(_,i) => block(100+i)));let n=101;const w=worker(ctx,(...args) => fullHandler(n)(...args));
  for (;n<=220;n++) await finish(ctx,w.instance,n);
  ctx.pool.store.blocks.get(177).receipt_evidence_conflict=true;
  n=100;await finish(ctx,w.instance,100);assert.equal((await ctx.repository.getLane()).contiguous_complete_through,176);
  assert.equal((await ctx.repository.getLane()).checkpoint_hash,hash(177));
});
await test('canonical parent mismatch retains lane-wide fail-closed continuity behavior',async () => {
  const ctx=await setup();ctx.pool.store.blocks.get(100).parent_hash=hash(999);
  const w=worker(ctx,fullHandler(100));await ctx.repository.scheduleBlock(100);
  await w.instance.runOnce();await w.instance.runOnce();assert.equal((await w.instance.runOnce()).status,'continuity_error');
  assert.equal((await ctx.repository.getLane()).status,'continuity_error');
});
await test('ten all-log jobs use one RPC, ten Transfer jobs use a separate RPC, and each block certifies only its own logs',async () => {
  const ctx=await readyLogs();const jobs=ctx.pool.store.work.size;
  const w=worker(ctx,(method,[filter]) => {
    assert.equal(method,'eth_getLogs');assert.equal(filter.fromBlock,hex(100));assert.equal(filter.toBlock,hex(109));
    return rangeLogs(100,10,!!filter.topics);
  });
  const all=await w.instance.runOnce({preferredComponent:'all_logs'});
  assert.equal(all.status,'complete');assert.equal(all.jobCount,10);assert.equal(all.completedJobs,10);assert.equal(w.calls.length,1);
  assert(!Object.hasOwn(w.calls[0].params[0],'topics'));
  assert.equal([...ctx.pool.store.reconciliation.values()].filter((r) => r.kind==='transfer_logs').length,0);
  const transfers=await w.instance.runOnce({preferredComponent:'transfer_logs'});
  assert.equal(transfers.status,'complete');assert.equal(transfers.jobCount,10);assert.equal(w.calls.length,2);
  assert.deepEqual(w.calls[1].params[0].topics,[TRANSFER_TOPIC]);
  for (let n=100;n<110;n++) {
    for (const [kind,total] of [['all_logs',2],['transfer_logs',1]]) {
      const r=ctx.pool.store.reconciliation.get(`${n}:${kind}:arc-receipts-logs-v1`);
      assert(r.complete);assert.equal(r.receipt_log_count,total);assert.equal(r.queried_log_count,total);
      assert.equal(r.block_hash,hash(n+1));
    }
  }
  assert.equal(ctx.pool.store.work.size,jobs);assert.equal((await ctx.repository.workPressure()).outstanding,0);
  console.log('LOG_BATCH_FIXTURE: 10 all_logs jobs = 1 RPC; 10 transfer_logs jobs = 1 independent RPC; zero enqueue');
});
await test('all-log success is never reused as Transfer proof when the independent Transfer range RPC fails',async () => {
  const ctx=await readyLogs(3);const w=worker(ctx,(method,[filter]) => {
    if (filter.topics) throw new Error('private upstream error');return rangeLogs(100,3);
  });
  assert.equal((await w.instance.runOnce({preferredComponent:'all_logs'})).completedJobs,3);
  const before=structuredClone([...ctx.pool.store.reconciliation.values()]);
  const result=await w.instance.runOnce({preferredComponent:'transfer_logs'});
  assert.equal(result.status,'retrying');assert.equal(result.completedJobs,0);assert.equal(w.calls.length,2);
  for (const r of before) assert.deepEqual(ctx.pool.store.reconciliation.get(`${r.block_number}:${r.kind}:${r.definition_version}`),r);
  for (let n=100;n<103;n++) assert.equal(ctx.pool.store.blocks.get(n).transfer_log_reconciliation_complete,false);
  assert(result.results.every((r) => r.status==='retrying'));
  assert([...ctx.pool.store.work.values()].filter((j) => j.component==='transfer_logs').every((j) => j.state==='retrying' && j.attempts===1 && j.lease_owner===null));
});
await test('log batch claims preserve exact identity, readiness, owner, fences and numeric span with SKIP LOCKED',async () => {
  const ctx=await readyLogs(12);const all=[...ctx.pool.store.work.values()].filter((j) => j.component==='all_logs');
  Object.assign(all[1],{state:'retrying',not_before:1001000});
  Object.assign(all[2],{state:'leased',lease_owner:'held',lease_until:1001000});
  Object.assign(all[3],{state:'leased',lease_owner:'expired',lease_until:999999,fencing_token:'7',attempts:2});
  all[4].state='persistent_partial';all[5].state='failed';all[6].state='complete';all[7].locked=true;
  all[8].lane='other';all[9].definition_version='other';
  const first=await ctx.repository.claim('batch-owner',180000,{preferredComponent:'all_logs'});assert.equal(first.start_block,100);
  const leases=await ctx.repository.claimLogBatch(first,10);
  assert.deepEqual(leases.map((j) => j.start_block),[100,103]);
  assert(leases.every((j) => j.component==='all_logs' && j.lease_owner==='batch-owner' && j.lease_until===1180000));
  assert.equal(leases[1].fencing_token,'8');assert.equal(leases[1].attempts,3);
  assert.equal(ctx.pool.store.work.get(all[10].id).state,'pending');
  const sql=ctx.pool.calls.find((c) => c.text.includes('receipts:claim_logs'));
  assert(sql.text.includes('FOR UPDATE SKIP LOCKED'));assert.deepEqual(sql.values.slice(7),['all_logs',100,109,9]);
  for (const limit of [0,51,1.5]) await assert.rejects(ctx.repository.claimLogBatch(first,limit));
  for (const duration of [0,300001,1.5]) await assert.rejects(ctx.repository.claimLogBatch(first,10,duration));
  const receiptJob=[...ctx.pool.store.work.values()].find((j) => j.component==='receipts');receiptJob.state='pending';receiptJob.not_before=0;
  const receiptLease=await ctx.repository.claim('receipt-owner',180000,{preferredComponent:'receipts'});
  assert.equal(receiptLease.component,'receipts');
  await assert.rejects(ctx.repository.claimLogBatch(receiptLease),/work_identity_mismatch/);
});
await test('range width bounds sparse claims, max job count and single-block mode, without claiming receipts or other components',async () => {
  const ctx=await setup([block(100),block(105),block(106),block(115)]);
  for (const n of [100,105,106,115]) {
    await ctx.repository.scheduleBlock(n);
    const lease=await ctx.repository.claim('prep',180000,{preferredComponent:'receipts'});await ctx.repository.saveReceipts(lease,[receipt(n)]);
  }
  const first=await ctx.repository.claim('range',180000,{preferredComponent:'all_logs'});
  const batch=await ctx.repository.claimLogBatch(first,10);assert.deepEqual(batch.map((j) => j.start_block),[100,105,106]);
  assert(batch.at(-1).start_block-batch[0].start_block+1<=10);
  assert([...ctx.pool.store.work.values()].filter((j) => j.component==='transfer_logs').every((j) => j.state==='pending'));
  const bounded=await readyLogs(12);const one=await bounded.repository.claim('one',180000,{preferredComponent:'all_logs'});
  assert.equal((await bounded.repository.claimLogBatch(one,1)).length,1);
  const next=await bounded.repository.claim('three',180000,{preferredComponent:'all_logs'});
  assert.deepEqual((await bounded.repository.claimLogBatch(next,3)).map((j) => j.start_block),[101,102,103]);
  for (const limit of [0,51,1.5]) assert.throws(() => createReceiptWorker({repository:ctx.repository,
    rpc:createRpcBudget().wrap({url:ARC_RPC_URL,async request(){return [];}}),maxLogRangeBlocks:limit}));
});
await test('structurally invalid range responses certify zero blocks and never trigger same-attempt fallback RPC',async () => {
  const cases=[null,{},[null],[{...log(100),address:'0x1'}],[{...log(100),blockNumber:undefined}],
    [{...log(100),blockNumber:'0x'}],[log(103)],[{...log(100),transactionHash:undefined}],
    [{...log(100),transactionIndex:undefined}],[{...log(100),topics:['0x1']}],
    [log(100),{...log(101),data:'invalid'}],Array(MAX_ALL_LOGS+1).fill(log(100))];
  for (const raw of cases) {
    const ctx=await readyLogs(3);const w=worker(ctx,() => raw);
    const result=await w.instance.runOnce({preferredComponent:'all_logs'});
    assert.equal(result.status,'retrying');assert.equal(result.completedJobs,0);assert.equal(w.calls.length,1);
    assert([...ctx.pool.store.reconciliation.values()].every((r) => !r.complete && !r.query_complete));
    assert([...ctx.pool.store.work.values()].filter((j) => j.component==='all_logs').every((j) => j.state==='retrying' && j.attempts===1));
  }
});
await test('configured maximum batches exactly 50 blocks and leaves the 51st job unclaimed',async () => {
  const ctx=await readyLogs(51);const w=worker(ctx,() => rangeLogs(100,50),undefined,{maxLogRangeBlocks:50});
  const result=await w.instance.runOnce({preferredComponent:'all_logs'});
  assert.equal(result.status,'complete');assert.equal(result.jobCount,50);assert.equal(result.completedJobs,50);assert.equal(w.calls.length,1);
  assert.deepEqual(w.calls[0].params[0],{fromBlock:hex(100),toBlock:hex(149)});
  assert.equal([...ctx.pool.store.work.values()].find((j) => j.component==='all_logs' && j.start_block===150).state,'pending');
});
await test('Transfer range enforces its independent topic and absolute total cap, without multiplying limits by block count',async () => {
  for (const raw of [[log(100,0,1,false)],Array(MAX_TRANSFER_LOGS+1).fill(log(100))]) {
    const ctx=await readyLogs(3);const w=worker(ctx,() => raw);
    const result=await w.instance.runOnce({preferredComponent:'transfer_logs'});
    assert.equal(result.completedJobs,0);assert.equal(result.status,'retrying');assert.equal(w.calls.length,1);
    assert.deepEqual(w.calls[0].params[0].topics,[TRANSFER_TOPIC]);
    assert([...ctx.pool.store.reconciliation.values()].every((r) => !r.complete && !r.query_complete));
  }
});
await test('eight matching blocks complete while missing logs and a hash mismatch retry independently and stop the burst',async () => {
  const ctx=await readyLogs();const before=structuredClone(ctx.pool.store.blocks);
  const w=worker(ctx,() => rangeLogs().filter((l) => l.blockNumber!==hex(104)).map((l) =>
    l.blockNumber===hex(105) ? {...l,blockHash:hash(999)} : l));
  const burst=await createWorkBurst({worker:w.instance})();assert.equal(burst.length,1);
  assert.equal(burst[0].status,'retrying');assert.equal(burst[0].completedJobs,8);assert.equal(w.calls.length,1);
  for (let n=100;n<110;n++) {
    const b=ctx.pool.store.blocks.get(n);assert.equal(b.block_hash,before.get(n).block_hash);assert.equal(b.receipt_evidence_conflict,false);
    assert.equal(b.all_log_reconciliation_complete,![104,105].includes(n));
  }
  assert.equal(ctx.pool.store.reconciliation.get('104:all_logs:arc-receipts-logs-v1').missing_count,2);
  assert.equal(ctx.pool.store.reconciliation.get('105:all_logs:arc-receipts-logs-v1').query_complete,false);
});
await test('duplicate, payload, removed and transaction-position mismatches stay local to their assigned block',async () => {
  for (const alter of [(logs) => [...logs,log(101)],
    (logs) => logs.map((l) => l.blockNumber===hex(101) ? {...l,data:hash(999)} : l),
    (logs) => logs.map((l) => l.blockNumber===hex(101) ? {...l,removed:true} : l),
    (logs) => logs.map((l) => l.blockNumber===hex(101) ? {...l,transactionIndex:'0x1'} : l)]) {
    const ctx=await readyLogs(3);const w=worker(ctx,() => alter(rangeLogs(100,3)));
    const result=await w.instance.runOnce({preferredComponent:'all_logs'});
    assert.equal(result.status,'retrying');assert.equal(result.completedJobs,2);
    assert.deepEqual(result.results.map((r) => r.status),['complete','retrying','complete']);
  }
});
await test('one stale fenced lease cannot save or release newer work and does not prevent other blocks completing',async () => {
  const ctx=await readyLogs(3);let replacement;
  const w=worker(ctx,async () => {
    const job=[...ctx.pool.store.work.values()].find((j) => j.component==='all_logs' && j.start_block===101);job.lease_until=0;
    replacement=await ctx.repository.claim('replacement',180000,{preferredComponent:'all_logs'});
    assert.equal(replacement.id,job.id);return rangeLogs(100,3);
  });
  const result=await w.instance.runOnce({preferredComponent:'all_logs'});
  assert.equal(result.status,'stale_lease');assert.equal(result.completedJobs,2);
  assert.deepEqual(result.results.map((r) => r.status),['complete','stale_lease','complete']);
  assert(!ctx.pool.store.reconciliation.has('101:all_logs:arc-receipts-logs-v1'));
  const job=ctx.pool.store.work.get(replacement.id);assert.equal(job.lease_owner,'replacement');assert.equal(job.state,'leased');assert.equal(job.fencing_token,'2');
});
await test('one per-block DB commit failure leaves that job retryable while unrelated certificates commit',async () => {
  const ctx=await readyLogs(3);ctx.pool.fail('receipts:reconciliation');const w=worker(ctx,() => rangeLogs(100,3));
  const result=await w.instance.runOnce({preferredComponent:'all_logs'});
  assert.equal(result.status,'retrying');assert.equal(result.completedJobs,2);
  assert.deepEqual(result.results.map((r) => r.status),['retrying','complete','complete']);
  assert(!ctx.pool.store.reconciliation.has('100:all_logs:arc-receipts-logs-v1'));assert.equal(w.calls.length,1);
});
await test('range RPC abort releases all still-owned leases to durable retry and saves no unobserved success',async () => {
  const ctx=await readyLogs(3);const controller=new AbortController();let started;
  const begun=new Promise((resolve) => {started=resolve;});
  const w=worker(ctx,(method,params,{signal}) => {
    assert.equal(signal,controller.signal);started();return new Promise((resolve,reject) => signal.addEventListener('abort',() => reject(new Error('operation_aborted')),{once:true}));
  });
  const pending=w.instance.runOnce({preferredComponent:'all_logs',signal:controller.signal});await begun;controller.abort();
  const result=await pending;assert.equal(result.status,'aborted');assert.equal(result.completedJobs,0);assert.equal(w.calls.length,1);
  assert.equal(ctx.pool.store.reconciliation.size,0);
  assert([...ctx.pool.store.work.values()].filter((j) => j.component==='all_logs').every((j) => j.state==='retrying' && j.lease_owner===null));
});
await test('abort between per-block commits retains observed successful evidence and retries only remaining leases',async () => {
  const ctx=await readyLogs(3);const controller=new AbortController();const save=ctx.repository.saveReconciliation.bind(ctx.repository);
  ctx.repository.saveReconciliation=async (...args) => {const result=await save(...args);controller.abort();return result;};
  const w=worker(ctx,() => rangeLogs(100,3));const result=await w.instance.runOnce({preferredComponent:'all_logs',signal:controller.signal});
  assert.equal(result.status,'aborted');assert.equal(result.completedJobs,1);
  assert.deepEqual(result.results.map((r) => r.status),['complete','aborted','aborted']);
  assert.equal(ctx.pool.store.reconciliation.size,1);assert.equal(w.calls.length,1);
});
await test('already complete per-block certificates remain immutable and require no repeated range RPC',async () => {
  const ctx=await readyLogs(3);const w=worker(ctx,() => rangeLogs(100,3));
  await w.instance.runOnce({preferredComponent:'all_logs'});const certificates=structuredClone(ctx.pool.store.reconciliation);
  for (const j of ctx.pool.store.work.values()) if (j.component==='all_logs') {j.state='pending';j.not_before=0;}
  const result=await w.instance.runOnce({preferredComponent:'all_logs'});
  assert.equal(result.completedJobs,3);assert.equal(w.calls.length,1);assert.deepEqual(ctx.pool.store.reconciliation,certificates);
});
await test('over 10000 completed logical jobs cannot exhaust queue; pruning preserves active/persistent states and durable evidence',async () => {
  const ctx=await setup();const w=worker(ctx,fullHandler(100));await finish(ctx,w.instance,100);
  const evidence=structuredClone(ctx.pool.store.reconciliation);const coverage=structuredClone(ctx.pool.store.coverage);
  const facts=structuredClone(ctx.pool.store.receipts);const protectedJobs=[];
  for (const state of ['pending','leased','retrying','persistent_partial','failed']) {
    const j=await ctx.chain.enqueue(CHAIN_IDENTITY,{component:'retention',logicalKey:state,startBlock:100,endBlock:100});
    const row=ctx.pool.store.work.get(j.id);row.state=state;row.not_before=Infinity;
    if (state === 'leased') {row.lease_owner='held';row.lease_until=Infinity;}
    protectedJobs.push(structuredClone(row));
  }
  for (let i=0;i<10001;i++) {
    await ctx.chain.enqueue(CHAIN_IDENTITY,{component:'retention',logicalKey:`completed-${i}`,startBlock:100,endBlock:100});
    const lease=await ctx.chain.claim(CHAIN_IDENTITY,'retention-test');assert(lease);
    await ctx.chain.finishWork(lease);
    // The SQL double's diagnostics are not durable data; bound their memory during the stress fixture.
    if (i % 500 === 0) ctx.pool.calls.length=0;
  }
  assert.equal([...ctx.pool.store.work.values()].filter((j) => j.state === 'complete').length,COMPLETE_WORK_RETAIN);
  for (const j of protectedJobs) assert.deepEqual(ctx.pool.store.work.get(j.id),j);
  assert.deepEqual(ctx.pool.store.reconciliation,evidence);assert.deepEqual(ctx.pool.store.coverage,coverage);assert.deepEqual(ctx.pool.store.receipts,facts);
  assert(![...ctx.pool.store.work.values()].some((j) => j.lane === 'receipts_logs'));
  const reads=w.calls.length;assert.deepEqual(await ctx.repository.scheduleBlock(100),[]);
  assert.equal((await w.instance.runOnce()).status,'idle');assert.equal(w.calls.length,reads);
  assert.deepEqual(ctx.pool.store.reconciliation,evidence);assert.equal(ctx.pool.store.logs.size,1);
  const prunes=ctx.pool.calls.filter((c) => c.text.includes('a2:prune_complete'));
  assert(prunes.every((c) => c.values[0] === COMPLETE_WORK_RETAIN && c.values[1] === COMPLETE_WORK_PRUNE_BATCH));
});
console.log(`A2_RECEIPTS_VERIFIER: PASS (${count} scenarios; SQL/RPC doubles, no deployment claim)`);
