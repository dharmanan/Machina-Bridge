import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fixturePool,block,rawBlock,transaction,hash,address,fixtureChainRpc } from './fixtures/arc-intelligence-a2.mjs';
import { migrate,MIGRATIONS } from '../server/arc-intelligence/migrate.js';
import { createFoundationRepository,CHAIN_IDENTITY,MAX_WORK_ROWS,identityValues } from '../server/arc-intelligence/foundation.js';
import { createReceiptRepository,RECEIPT_IDENTITY } from '../server/arc-intelligence/receipt-repository.js';
import { createReceiptWorker } from '../server/arc-intelligence/receipt-lane.js';
import { createChainFollower } from '../server/arc-intelligence/chain-lane.js';
import { createRpcBudget } from '../server/arc-intelligence/rpc-budget.js';
import { COMPLETE_WORK_RETAIN,COMPLETE_WORK_PRUNE_BATCH,pruneCompleteWork } from '../server/arc-intelligence/work-retention.js';
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
async function test(name,work) {
  if (process.argv.includes('--focused-a25h') && !name.startsWith('A2.5H')) return;
  if (process.argv.includes('--focused-a25i') && !name.startsWith('A2.5I')) return;
  await work();count++;console.log(`PASS ${name}`);
}
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
async function preparedLogRecords(ctx,maxBlocks=10) {
  const first=await ctx.repository.claim('batch-persist-test',180000,{preferredComponent:'all_logs'});
  const leases=await ctx.repository.claimLogBatch(first,maxBlocks);
  return Promise.all(leases.map(async (lease) => {
    const view=await ctx.repository.getBlock(lease.start_block),logs=view.logs.map(normalizedLog);
    return {lease,retryMs:1000,evidence:reconcileLogs(logs,logs,{receiptSetComplete:true,queryComplete:true},'all')};
  }));
}
function fullHandler(n,count=1) {return (method,params) => {
  if (method === 'eth_getBlockReceipts') return Array.from({length:count},(_,i) => receipt(n,i));
  if (method === 'eth_getLogs') return Array.from({length:count},(_,i) => log(n,i));
  throw new Error('unexpected_call');
};}
// Reproduce the base's four independent typed fact reads without caching their results.
function legacyFactReads(pool) {
  const connect=pool.connect.bind(pool);
  pool.connect=async () => {
    const client=await connect(),query=client.query.bind(client);
    client.query=async (sql,values) => {
      if (!sql.includes('receipts:facts')) return query(sql,values);
      const tables=[['transactions','transactions','transaction_index'],['receipts','receipts','transaction_index'],
        ['logs','logs','log_index'],['evidence','reconciliation',null]];
      const rows=[];
      for (let fact_kind=0;fact_kind<tables.length;fact_kind++) {
        const [tag,table,order]=tables[fact_kind];
        const result=await query(`/* receipts:${tag} */ SELECT * FROM arc_intelligence_${table}
          WHERE chain_id=$1 AND block_number=$2${order ? ` ORDER BY ${order}` : ' AND definition_version=$3'}`,
        order ? values.slice(0,2) : values);
        rows.push(...result.rows.map((row) => ({fact_kind,...row})));
      }
      return {rows};
    };
    return client;
  };
}
// Fixture-only replay of the pre-A2.5I two single-component enqueue paths.
function legacyFollowupEnqueues(pool) {
  const connect=pool.connect.bind(pool);
  pool.connect=async () => {
    const client=await connect(),query=client.query.bind(client);
    client.query=async (sql,values) => {
      if (!sql.includes('a2:followups_existing')) return query(sql,values);
      const rows=[];
      for (let i=0;i<values[5].length;i++) {
        // The pair helper has already performed the first lock/prune.
        if (i) {await query('SELECT pg_advisory_xact_lock(5042,177004)');await pruneCompleteWork({query});}
        const identity=values.slice(0,5),component=values[5][i],hash=values[6];
        const existing=(await query(`/* a2:work_existing */ SELECT * FROM arc_intelligence_work
          WHERE chain_id=$1 AND lane=$2 AND scope_id=$3 AND epoch=$4 AND definition_version=$5 AND component=$6 AND logical_key=$7`,
        [...identity,component,hash])).rows[0];
        if (existing) {rows.push(existing);continue;}
        const count=(await query('/* a2:work_count */ SELECT count(*) AS count FROM arc_intelligence_work WHERE state <> \'complete\'')).rows[0].count;
        if (Number(count)>=MAX_WORK_ROWS) throw new Error('work_capacity_reached');
        const block=pool.store.blocks.get([...pool.store.blocks.keys()].find((n) => pool.store.blocks.get(n).block_hash===hash));
        rows.push(...(await query(`/* a2:enqueue */ INSERT INTO arc_intelligence_work
          (chain_id,lane,scope_id,epoch,definition_version,component,logical_key,start_block,end_block,block_hash)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
        [...identity,component,hash,block.block_number,block.block_number,hash])).rows);
      }
      return {rows};
    };return client;
  };
}
async function finish(ctx,instance,n) {await ctx.repository.scheduleBlock(n);for (let i=0;i<3;i++) assert.equal((await instance.runOnce()).status,'complete');}

await test('003 migration upgrades production-like 001/002 ledger once; immutable hashes and A1 retained',async () => {
  assert.deepEqual(MIGRATIONS,['001_init','002_a2_foundation','003_a2_receipts','004_a2_metric_buckets']);
  for (const [name,expected] of [['001_init','c38b78a7e0e1c47e1de5f1400f1502f53f4ce8eeb20fe5d8f328fb59d1992ff0'],
    ['002_a2_foundation','308c747d1b1f1c3fa3cace6daba11434eb5a1ba3709701b657ec1a93c3f43cd5']]) {
    const sql=await readFile(new URL(`../server/arc-intelligence/sql/${name}.sql`,import.meta.url));
    assert.equal(createHash('sha256').update(sql).digest('hex'),expected);
  }
  const pool=fixturePool();await migrate(pool);const a1=structuredClone(pool.store.a1);
  pool.store.migrations.delete('003_a2_receipts');const old=structuredClone(pool.store.migrations);pool.calls.length=0;
  await migrate(pool);await migrate(pool);assert.equal(pool.store.migrations.size,4);assert.deepEqual(pool.store.a1,a1);
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
  const ctx=await readyLogs(3);const controller=new AbortController();const connect=ctx.pool.connect.bind(ctx.pool);let stop=true;
  ctx.pool.connect=async () => {const client=await connect(),query=client.query.bind(client);
    client.query=async (...args) => {const result=await query(...args);
      if (stop && args[0]==='COMMIT' && ctx.pool.store.reconciliation.size===1) {stop=false;controller.abort();}
      return result;
    };return client;
  };
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
await test('bounded batch persistence preserves single-save truth while reducing ten progress/frontier passes',async () => {
  const single=await readyLogs(),batch=await readyLogs();
  const individual=await preparedLogRecords(single),records=await preparedLogRecords(batch);
  single.pool.calls.length=0;batch.pool.calls.length=0;
  for (const r of individual) assert.equal((await single.repository.saveReconciliation(r.lease,r.evidence,r.retryMs)).complete,true);
  const result=await batch.repository.saveReconciliationBatch(records);
  assert.equal(result.frontierError,undefined);assert.equal(result.results.length,10);
  assert(result.results.every((r) => r.value?.complete===true));
  for (const key of ['blocks','receipts','logs','reconciliation','coverage','work','lanes']) {
    assert.deepEqual(batch.pool.store[key],single.pool.store[key],`${key} truth must match the unchanged single-job API`);
  }
  const totals=(ctx) => ({queries:ctx.pool.calls.length,transactions:ctx.pool.calls.filter((c) => c.text==='BEGIN').length,
    frontierScans:ctx.pool.calls.filter((c) => c.text.includes('receipts:advance')).length});
  const before=totals(single),after=totals(batch);
  assert.equal(before.transactions,20);assert.equal(after.transactions,11);
  assert.equal(before.frontierScans,20);assert.equal(after.frontierScans,1);assert(after.queries<before.queries);
  for (const r of records) {
    const cert=batch.pool.store.reconciliation.get(`${r.lease.start_block}:all_logs:arc-receipts-logs-v1`);
    assert.equal(cert.evidence_digest,createHash('sha256').update(JSON.stringify({blockHash:r.lease.block_hash,evidence:r.evidence})).digest('hex'));
  }
  console.log(`LOG_PERSISTENCE_FIXTURE: single=${JSON.stringify(before)} batch=${JSON.stringify(after)}; identical durable truth`);
});
await test('worker hands ten precomputed records to one batch call; no single saves or RPC inside transactions',async () => {
  const ctx=await readyLogs();const save=ctx.repository.saveReconciliationBatch.bind(ctx.repository);const batches=[];
  ctx.repository.saveReconciliation=async () => {throw new Error('Unexpected single-job persistence');};
  ctx.repository.saveReconciliationBatch=async (records,options) => {
    let depth=0;for (const c of ctx.pool.calls) {if (c.text==='BEGIN') depth++;if (['COMMIT','ROLLBACK'].includes(c.text)) depth--;}
    assert.equal(depth,0);assert.equal(records.length,10);assert(records.every((r) => r.evidence.complete));
    batches.push(records.map((r) => r.lease.component));return save(records,options);
  };
  const w=worker(ctx,(method,[filter]) => rangeLogs(100,10,!!filter.topics));
  assert.equal((await w.instance.runOnce({preferredComponent:'all_logs'})).completedJobs,10);
  assert.equal((await w.instance.runOnce({preferredComponent:'transfer_logs'})).completedJobs,10);
  assert.deepEqual(batches,[Array(10).fill('all_logs'),Array(10).fill('transfer_logs')]);assert.equal(w.calls.length,2);
  const lane=await ctx.repository.getLane();assert.equal(lane.processed_through,109);assert.equal(lane.contiguous_complete_through,109);
  assert.equal(lane.checkpoint_hash,hash(110));assert.equal(lane.status,'caught_up');
  assert([...ctx.pool.store.blocks.values()].every((b) => b.receipt_complete && b.all_log_reconciliation_complete && b.transfer_log_reconciliation_complete && !b.core_complete));
  assert([...ctx.pool.store.coverage.values()].every((c) => c.state==='complete'));
  assert([...ctx.pool.store.work.values()].every((j) => j.state==='complete'));
});
await test('batch invalid evidence, stale lease and valid record remain isolated; error callbacks run outside transactions',async () => {
  const ctx=await readyLogs(3),records=await preparedLogRecords(ctx);
  records[0].evidence={...records[0].evidence,missingLogCount:1};
  const stale=ctx.pool.store.work.get(records[1].lease.id);stale.lease_until=0;
  const replacement=await ctx.repository.claim('new-owner',180000,{preferredComponent:'all_logs'});
  assert.equal(replacement.id,stale.id);const errors=[];
  const result=await ctx.repository.saveReconciliationBatch(records,{onError:async (r,error) => {
    let depth=0;for (const c of ctx.pool.calls) {if (c.text==='BEGIN') depth++;if (['COMMIT','ROLLBACK'].includes(c.text)) depth--;}
    assert.equal(depth,0);errors.push(error.message);
    if (error.message!=='stale_lease') await ctx.repository.retry(r.lease,r.retryMs);
  }});
  assert.deepEqual(errors,['invalid_reconciliation_evidence','stale_lease']);assert.equal(result.results[2].value.complete,true);
  assert(!ctx.pool.store.reconciliation.has('100:all_logs:arc-receipts-logs-v1'));
  assert(!ctx.pool.store.reconciliation.has('101:all_logs:arc-receipts-logs-v1'));
  assert.equal(ctx.pool.store.blocks.get(100).all_log_reconciliation_complete,false);
  assert.equal(ctx.pool.store.blocks.get(101).all_log_reconciliation_complete,false);
  assert.equal(ctx.pool.store.blocks.get(102).all_log_reconciliation_complete,true);
  assert.equal(ctx.pool.store.work.get(replacement.id).lease_owner,'new-owner');assert.equal(ctx.pool.store.work.get(replacement.id).state,'leased');
  assert.equal(ctx.pool.store.work.get(records[0].lease.id).state,'retrying');
  assert.equal((await ctx.repository.getLane()).contiguous_complete_through,null);
});
await test('batch completed certificates and coverage are immutable even when handed invalid replacement evidence',async () => {
  const ctx=await readyLogs(3);let records=await preparedLogRecords(ctx);await ctx.repository.saveReconciliationBatch(records);
  const certificates=structuredClone(ctx.pool.store.reconciliation),coverage=structuredClone(ctx.pool.store.coverage);
  for (const j of ctx.pool.store.work.values()) if (j.component==='all_logs') {j.state='pending';j.not_before=0;}
  records=await preparedLogRecords(ctx);for (const r of records) r.evidence={complete:false};
  const result=await ctx.repository.saveReconciliationBatch(records);
  assert(result.results.every((r) => r.value?.complete));assert.deepEqual(ctx.pool.store.reconciliation,certificates);
  assert.deepEqual(ctx.pool.store.coverage,coverage);
});
await test('batch bounds reject oversized ranges and duplicate jobs before any persistence',async () => {
  const ctx=await readyLogs(11),records=await preparedLogRecords(ctx,50),before=structuredClone(ctx.pool.store);
  for (const [rows,maxBlocks] of [[records,10],[[records[0],records[0]],10],[[records[0],records[10]],10],[[],10],[records,51]]) {
    await assert.rejects(ctx.repository.saveReconciliationBatch(rows,{maxBlocks}),/invalid_log_batch/);
    assert.deepEqual(ctx.pool.store,before);
  }
});
await test('single-job worker uses bounded batch API and preserves certification/frontier',async () => {
  const ctx=await readyLogs(1);const w=worker(ctx,(method,[filter]) => rangeLogs(100,1,!!filter.topics),undefined,{maxLogRangeBlocks:1});
  assert.equal((await w.instance.runOnce({preferredComponent:'all_logs'})).completedJobs,1);
  assert.equal((await w.instance.runOnce({preferredComponent:'transfer_logs'})).completedJobs,1);
  assert.equal((await ctx.repository.getLane()).contiguous_complete_through,100);assert.equal(w.calls.length,2);
});
await test('receipt evidence revalidated after RPC cannot be falsely certified from the earlier worker view',async () => {
  const ctx=await readyLogs(3);const w=worker(ctx,() => {
    ctx.pool.store.receipts.delete(transaction(101).hash);return rangeLogs(100,3);
  });const result=await w.instance.runOnce({preferredComponent:'all_logs'});
  assert.deepEqual(result.results.map((r) => r.status),['complete','retrying','complete']);
  assert.equal(ctx.pool.store.blocks.get(101).all_log_reconciliation_complete,false);
  assert(!ctx.pool.store.reconciliation.has('101:all_logs:arc-receipts-logs-v1'));
});
await test('canonical lease hash mismatch halts the lane before later batch records are persisted',async () => {
  const ctx=await readyLogs(3);const w=worker(ctx,() => {
    const job=[...ctx.pool.store.work.values()].find((j) => j.component==='all_logs' && j.start_block===101);
    job.block_hash=hash(999);return rangeLogs(100,3);
  });const result=await w.instance.runOnce({preferredComponent:'all_logs'});
  assert.equal(result.status,'continuity_error');assert.deepEqual(result.results.map((r) => r.status),['complete','continuity_error','continuity_error']);
  assert.equal(ctx.pool.store.reconciliation.size,1);assert.equal((await ctx.repository.getLane()).status,'continuity_error');
  assert.equal(ctx.pool.store.blocks.get(102).all_log_reconciliation_complete,false);
});
await test('shared frontier failure reports retrying and retains durable processed ceiling for DB-only recovery',async () => {
  const ctx=await readyLogs(3);let fail=false;const w=worker(ctx,(method,[filter]) => {
    if (fail) ctx.pool.fail('receipts:advance');return rangeLogs(100,3,!!filter.topics);
  });await w.instance.runOnce({preferredComponent:'all_logs'});fail=true;
  const result=await w.instance.runOnce({preferredComponent:'transfer_logs'});
  assert.equal(result.status,'retrying');assert.equal(result.error,'required_read_unavailable');assert.equal(result.completedJobs,3);
  let lane=await ctx.repository.getLane();assert.equal(lane.processed_through,102);assert.equal(lane.contiguous_complete_through,null);
  assert([...ctx.pool.store.work.values()].every((j) => j.state==='complete'));const calls=w.calls.length;
  await ctx.repository.advanceFrontier();lane=await ctx.repository.getLane();assert.equal(lane.contiguous_complete_through,102);
  assert.equal(lane.checkpoint_hash,hash(103));assert.equal(w.calls.length,calls);
});
await test('A2.5H typed fact load equals legacy reads, retains precision, ordering, timestamps and block locks',async () => {
  const ctx=await setup([block(100,2)]);await ctx.repository.scheduleBlock(100);
  const w=worker(ctx,fullHandler(100,2));await w.instance.runOnce({preferredComponent:'receipts'});
  const lease=await ctx.repository.claim('typed-test',180000,{preferredComponent:'all_logs'});
  const view=await ctx.repository.getBlock(100),logs=view.logs.map(normalizedLog);
  await ctx.repository.saveReconciliation(lease,reconcileLogs(logs,logs,{receiptSetComplete:true,queryComplete:true},'all'));
  const cert=ctx.pool.store.reconciliation.values().next().value;cert.updated_at=new Date('2026-10-01T00:00:00Z');
  // Deliberately reverse durable insertion order: SQL ordering must determine the view.
  for (const name of ['transactions','receipts','logs']) ctx.pool.store[name]=new Map([...ctx.pool.store[name]].reverse());
  const before=ctx.pool.calls.length,actual=await ctx.repository.getBlock(100);
  assert.equal(ctx.pool.calls.length-before,2);
  legacyFactReads(ctx.pool);
  assert.deepEqual(actual,await ctx.repository.getBlock(100));
  assert.deepEqual(actual.transactions.map((r) => r.transaction_index),[0,1]);
  assert.deepEqual(actual.receipts.map((r) => r.transaction_index),[0,1]);
  assert.deepEqual(actual.logs.map((r) => r.log_index),[0,1]);
  assert.equal(actual.transactions[0].value_raw,'900719925474099312345');
  assert.equal(actual.receipts[0].gas_used_raw,'9007199254740993');
  assert.equal(actual.receipts[0].effective_gas_price_raw,'9007199254740994');
  assert(actual.reconciliation[0].updated_at instanceof Date);
  assert(ctx.pool.calls.some((c) => c.text.includes('receipts:block') && c.text.endsWith('FOR UPDATE')));
  const sql=ctx.pool.calls.find((c) => c.text.includes('receipts:facts')).text;
  assert(sql.includes('NULL::bigint AS block_number')===false); // bigint comes directly from every table.
  assert(sql.includes('NULL::text[] AS topics'));assert(sql.includes('NULL::timestamptz AS updated_at'));
});
await test('A2.5H pg parsed bigint strings and nullable typed facts survive extraction unchanged',async () => {
  const ctx=await readyLogs(1),expected=await ctx.repository.getBlock(100);
  const connect=ctx.pool.connect.bind(ctx.pool);
  ctx.pool.connect=async () => {
    const c=await connect(),query=c.query.bind(c);
    c.query=async (...args) => {
      const result=await query(...args);
      if (args[0].includes('receipts:facts')) for (const row of result.rows) row.block_number=String(row.block_number);
      return result;
    };return c;
  };
  for (const name of ['transactions','receipts','logs','reconciliation']) for (const row of expected[name]) row.block_number=String(row.block_number);
  assert.deepEqual(await ctx.repository.getBlock(100),expected);
});
await test('A2.5H normal 10/1/1 burst reproduces base truth with 990->703 SQL, 66->55 transactions, 22->11 scans',async () => {
  async function profile(legacy) {
    const ctx=await setup(Array.from({length:10},(_,i) => block(100+i)));
    legacyFollowupEnqueues(ctx.pool); // Keep the A2.5H regression isolated from this enqueue optimization.
    if (legacy) legacyFactReads(ctx.pool);
    for (let n=100;n<110;n++) await ctx.repository.scheduleBlock(n);
    const w=worker(ctx,(method,[arg]) => method==='eth_getBlockReceipts'
      ? [receipt(Number(BigInt(arg)),0,[log(Number(BigInt(arg))),log(Number(BigInt(arg)),0,1,false)])]
      : rangeLogs(100,10,!!arg.topics));
    ctx.pool.calls.length=0;
    const burst=createWorkBurst({worker:{async runOnce(options) {
      await ctx.repository.workPressure();return w.instance.runOnce(options);
    }},...(legacy ? {} : {frontier:() => ctx.repository.advanceFrontier()})});
    const results=await burst();assert.equal(results.length,12);assert(results.every((r) => r.status==='complete'));
    assert.deepEqual(results.map((r) => r.component),[...Array(10).fill('receipts'),'all_logs','transfer_logs']);
    assert.equal(w.calls.filter((c) => c.method==='eth_getBlockReceipts').length,10);
    assert.equal(w.calls.filter((c) => c.method==='eth_getLogs').length,2);assert.equal(w.calls.length,12);
    return {ctx,totals:{sql:ctx.pool.calls.length,transactions:ctx.pool.calls.filter((c) => c.text==='BEGIN').length,
      advance:ctx.pool.calls.filter((c) => c.text.includes('receipts:advance')).length}};
  }
  const before=await profile(true),after=await profile(false);
  assert.deepEqual(before.totals,{sql:990,transactions:66,advance:22});
  assert.deepEqual(after.totals,{sql:703,transactions:55,advance:11});
  for (const key of ['blocks','transactions','receipts','logs','reconciliation','coverage','work','lanes'])
    assert.deepEqual(after.ctx.pool.store[key],before.ctx.pool.store[key],`${key} must remain identical`);
  console.log(`A2.5H_BURST_PROFILE: before=${JSON.stringify(before.totals)} after=${JSON.stringify(after.totals)}; identical durable truth`);
});
await test('A2.5H durable certificates survive crash before flush and idle restarted burst recovers without RPC',async () => {
  const ctx=await readyLogs(3);const w=worker(ctx,(method,[filter]) => rangeLogs(100,3,!!filter.topics));
  for (const preferredComponent of ['all_logs','transfer_logs']) {
    assert.equal((await w.instance.runOnce({preferredComponent,deferFrontier:true})).status,'complete');
  }
  const lane=await ctx.repository.getLane();assert.equal(lane.processed_through,102);assert.equal(lane.contiguous_complete_through,null);
  assert([...ctx.pool.store.work.values()].every((j) => j.state==='complete'));
  const facts=structuredClone(ctx.pool.store),reads=w.calls.length;
  // New repository/worker/burst has no memory of deferred writes and no ready work.
  ctx.repository=createReceiptRepository(ctx.pool);
  const restarted=worker(ctx,() => {throw new Error('Recovery must be DB-only');});
  const result=await createWorkBurst({worker:restarted.instance,frontier:() => ctx.repository.advanceFrontier()})();
  assert.equal(result[0].status,'idle');assert.equal(restarted.calls.length,0);assert.equal(w.calls.length,reads);
  assert.equal((await ctx.repository.getLane()).contiguous_complete_through,102);
  assert.equal((await ctx.repository.getLane()).checkpoint_hash,hash(103));
  for (const key of ['blocks','receipts','logs','reconciliation','coverage','work']) assert.deepEqual(ctx.pool.store[key],facts[key]);
});
await test('A2.5H abort flush preserves committed truth and leaves remaining leases recoverable',async () => {
  const ctx=await readyLogs(3);const w=worker(ctx,(method,[filter]) => {
    const start=Number(BigInt(filter.fromBlock)),end=Number(BigInt(filter.toBlock));
    return rangeLogs(start,end-start+1,!!filter.topics);
  });
  await w.instance.runOnce({preferredComponent:'all_logs'});
  const controller=new AbortController(),connect=ctx.pool.connect.bind(ctx.pool);let armed=false;
  ctx.pool.connect=async () => {
    const c=await connect(),query=c.query.bind(c);let written=false;
    c.query=async (sql,...args) => {
      if (armed && sql.includes('receipts:reconciliation')) written=true;
      const result=await query(sql,...args);
      if (armed && written && sql==='COMMIT') {armed=false;controller.abort();}
      return result;
    };return c;
  };
  armed=true;
  const result=await createWorkBurst({worker:w.instance,frontier:() => ctx.repository.advanceFrontier()})({signal:controller.signal});
  assert.equal(result.length,1);assert.equal(result[0].status,'aborted');assert.equal(result[0].completedJobs,1);
  assert.equal((await ctx.repository.getLane()).contiguous_complete_through,100);
  assert.equal(ctx.pool.store.blocks.get(101).transfer_log_reconciliation_complete,false);
  ctx.pool.advance(1000000);
  assert.equal((await w.instance.runOnce({preferredComponent:'transfer_logs'})).status,'complete');
  assert.equal((await ctx.repository.getLane()).contiguous_complete_through,102);
});
await test('A2.5H nondeferred receipt and log APIs still sweep immediately; deferred receipt still runs in-tx progress',async () => {
  const ctx=await setup([block(100)]);await ctx.repository.scheduleBlock(100);
  const lease=await ctx.repository.claim('single-test');ctx.pool.calls.length=0;
  await ctx.repository.saveReceipts(lease,[receipt(100)]);
  assert.equal(ctx.pool.calls.filter((c) => c.text==='BEGIN').length,2);
  assert.equal(ctx.pool.calls.filter((c) => c.text.includes('receipts:advance')).length,2);
  const r=await ctx.repository.claim('single-log',180000,{preferredComponent:'all_logs'});
  const view=await ctx.repository.getBlock(100),logs=view.logs.map(normalizedLog);ctx.pool.calls.length=0;
  await ctx.repository.saveReconciliation(r,reconcileLogs(logs,logs,{receiptSetComplete:true,queryComplete:true},'all'));
  assert.equal(ctx.pool.calls.filter((c) => c.text==='BEGIN').length,2);
  assert.equal(ctx.pool.calls.filter((c) => c.text.includes('receipts:advance')).length,2);
  const deferred=await setup();await deferred.repository.scheduleBlock(100);
  const job=await deferred.repository.claim('deferred');deferred.pool.calls.length=0;
  await deferred.repository.saveReceipts(job,[receipt(100)],{deferFrontier:true});
  assert.equal(deferred.pool.calls.filter((c) => c.text==='BEGIN').length,1);
  assert.equal(deferred.pool.calls.filter((c) => c.text.includes('receipts:advance')).length,1);
  const followups=deferred.pool.calls.filter((c) => c.text.includes('a2:enqueue_followups'));
  assert.equal(followups.length,1);assert.deepEqual(followups[0].values[5],['all_logs','transfer_logs']);
});
await test('A2.5H deferred batch preserves per-job fencing, rollback isolation and completed certificate immutability',async () => {
  const ctx=await readyLogs(3),records=await preparedLogRecords(ctx);
  records[0].evidence={...records[0].evidence,missingLogCount:1};
  ctx.pool.store.work.get(records[1].lease.id).lease_until=0;
  const replacement=await ctx.repository.claim('replacement',180000,{preferredComponent:'all_logs'});
  const result=await ctx.repository.saveReconciliationBatch(records,{deferFrontier:true,onError:async (r,error) => {
    if (error.message!=='stale_lease') await ctx.repository.retry(r.lease,r.retryMs);
  }});
  assert.deepEqual(result.results.map((r) => r.error?.message ?? r.value.complete),['invalid_reconciliation_evidence','stale_lease',true]);
  assert.equal(ctx.pool.store.work.get(replacement.id).lease_owner,'replacement');
  assert(!ctx.pool.store.reconciliation.has('100:all_logs:arc-receipts-logs-v1'));
  assert(!ctx.pool.store.reconciliation.has('101:all_logs:arc-receipts-logs-v1'));
  assert.equal(ctx.pool.store.blocks.get(102).all_log_reconciliation_complete,true);
  await ctx.repository.advanceFrontier();assert.equal((await ctx.repository.getLane()).contiguous_complete_through,null);
  const completed=ctx.pool.store.work.get(records[2].lease.id);completed.state='pending';completed.not_before=0;
  const lease=await ctx.repository.claim('immutable',180000,{preferredComponent:'all_logs'});
  assert.equal(lease.id,completed.id);
  const certificates=structuredClone(ctx.pool.store.reconciliation),coverage=structuredClone(ctx.pool.store.coverage);
  const retried=await ctx.repository.saveReconciliationBatch([{lease,evidence:{complete:false}}],{deferFrontier:true});
  assert.equal(retried.results[0].value.complete,true);
  assert.deepEqual(ctx.pool.store.reconciliation,certificates);assert.deepEqual(ctx.pool.store.coverage,coverage);
});
await test('A2.5H deferred worker freshly locks/reloads facts after RPC and canonical mismatch stops continuity',async () => {
  for (const failure of ['missing_receipt','changed_receipt','canonical_hash']) {
    const ctx=await readyLogs(3);let rpcBoundary;
    const w=worker(ctx,() => {
      rpcBoundary=ctx.pool.calls.length;
      if (failure==='missing_receipt') ctx.pool.store.receipts.delete(transaction(101).hash);
      else if (failure==='changed_receipt') ctx.pool.store.receipts.get(transaction(101).hash).block_hash=hash(999);
      else [...ctx.pool.store.work.values()].find((j) => j.component==='all_logs' && j.start_block===101).block_hash=hash(999);
      return rangeLogs(100,3);
    });
    const burst=createWorkBurst({worker:w.instance,frontier:() => ctx.repository.advanceFrontier()});
    const result=(await burst())[0];
    assert.equal(result.status,failure==='canonical_hash' ? 'continuity_error' : 'retrying');
    assert.equal(ctx.pool.store.blocks.get(101).all_log_reconciliation_complete,false);
    assert(!ctx.pool.store.reconciliation.has('101:all_logs:arc-receipts-logs-v1'));
    const after=ctx.pool.calls.slice(rpcBoundary);
    assert(after.some((c) => c.text.includes('receipts:block') && c.text.endsWith('FOR UPDATE') && c.values[1]===101));
    assert(after.some((c) => c.text.includes('receipts:facts') && c.values[1]===101));
    if (failure==='canonical_hash') {
      assert.equal((await ctx.repository.getLane()).status,'continuity_error');
      assert.equal(ctx.pool.store.blocks.get(102).all_log_reconciliation_complete,false);
    }
  }
});
async function receiptFollowupContext(existing=[]) {
  const ctx=await setup();await ctx.repository.scheduleBlock(100);
  for (const component of existing) await ctx.chain.enqueue(RECEIPT_IDENTITY,{component,logicalKey:hash(101),
    startBlock:100,endBlock:100,blockHash:hash(101)});
  const lease=await ctx.repository.claim('followup-test',180000,{preferredComponent:'receipts'});
  return {...ctx,lease};
}
function fillWorkCapacity(ctx,outstanding) {
  const current=[...ctx.pool.store.work.values()].filter((w) => w.state!=='complete').length;
  for (let i=current;i<outstanding;i++) {
    const id=`capacity-${i}`;
    ctx.pool.store.work.set(id,{id,chain_id:5042,lane:'other',scope_id:'other',epoch:'other',definition_version:'other',
      component:'other',logical_key:id,state:'failed',reason_code:null});
  }
}
for (const existing of [[],['all_logs'],['transfer_logs'],['all_logs','transfer_logs']]) {
  await test(`A2.5I bounded followup pair reuses ${existing.join('+') || 'none'} and inserts only missing jobs`,async () => {
    const ctx=await receiptFollowupContext(existing),before=structuredClone(ctx.pool.store.work);ctx.pool.calls.length=0;
    assert.equal((await ctx.repository.saveReceipts(ctx.lease,[receipt(100)],{deferFrontier:true})).complete,true);
    const calls=ctx.pool.calls;
    assert.equal(calls.filter((c) => c.text.startsWith('SELECT pg_advisory_xact_lock')).length,1);
    // One pair prune plus the unchanged successful work finish prune.
    assert.equal(calls.filter((c) => c.text.includes('a2:prune_complete')).length,2);
    const lookup=calls.filter((c) => c.text.includes('a2:followups_existing'));assert.equal(lookup.length,1);
    assert(lookup[0].text.endsWith('LIMIT 2'));assert.deepEqual(lookup[0].values.slice(0,5),identityValues(RECEIPT_IDENTITY));
    assert.deepEqual(lookup[0].values[5],['all_logs','transfer_logs']);assert.equal(lookup[0].values[6],hash(101));
    const inserts=calls.filter((c) => c.text.includes('a2:enqueue_followups'));
    assert.equal(inserts.length,existing.length===2 ? 0 : 1);
    assert.equal(calls.filter((c) => c.text.includes('a2:work_count')).length,existing.length===2 ? 0 : 1);
    if (inserts.length) assert.deepEqual(inserts[0].values[5],['all_logs','transfer_logs'].filter((c) => !existing.includes(c)));
    const jobs=[...ctx.pool.store.work.values()].filter((w) => w.component!=='receipts');assert.equal(jobs.length,2);
    for (const j of jobs) {
      assert.equal(j.logical_key,hash(101));assert.equal(j.block_hash,hash(101));assert.equal(j.start_block,100);assert.equal(j.end_block,100);
      assert.deepEqual([j.chain_id,j.lane,j.scope_id,j.epoch,j.definition_version],lookup[0].values.slice(0,5));
      if (existing.includes(j.component)) assert.deepEqual(j,before.get(j.id));
    }
    // A fresh retry lease can re-save identical evidence without duplicating either logical followup.
    const row=ctx.pool.store.work.get(ctx.lease.id);row.state='pending';row.not_before=0;
    const lease=await ctx.repository.claim('followup-retry',180000,{preferredComponent:'receipts'});
    const durable=structuredClone(ctx.pool.store.work);ctx.pool.calls.length=0;
    await ctx.repository.saveReceipts(lease,[receipt(100)],{deferFrontier:true});
    assert(!ctx.pool.calls.some((c) => c.text.includes('a2:enqueue_followups')));
    assert.equal(ctx.pool.store.work.size,3);
    for (const j of jobs) assert.deepEqual(ctx.pool.store.work.get(j.id),durable.get(j.id));
  });
}
await test('A2.5I every durable work state suppresses duplicate followups; other identities do not',async () => {
  for (const state of ['pending','retrying','leased','persistent_partial','complete']) {
    const ctx=await receiptFollowupContext(['all_logs','transfer_logs']);
    for (const j of ctx.pool.store.work.values()) if (j.component!=='receipts') j.state=state;
    const previous=structuredClone(ctx.pool.store.work);ctx.pool.calls.length=0;
    await ctx.repository.saveReceipts(ctx.lease,[receipt(100)],{deferFrontier:true});
    assert(!ctx.pool.calls.some((c) => c.text.includes('a2:enqueue_followups')));
    for (const j of previous.values()) if (j.component!=='receipts') assert.deepEqual(ctx.pool.store.work.get(j.id),j);
  }
  const ctx=await receiptFollowupContext();
  for (const identity of [{...RECEIPT_IDENTITY,scopeId:'other'}, {...RECEIPT_IDENTITY,lane:'other'},
    {...RECEIPT_IDENTITY,epoch:'other'},{...RECEIPT_IDENTITY,definitionVersion:'other'}]) {
    await ctx.chain.enqueue(identity,{component:'all_logs',logicalKey:hash(101),startBlock:100,endBlock:100,blockHash:hash(101)});
  }
  await ctx.repository.saveReceipts(ctx.lease,[receipt(100)],{deferFrontier:true});
  assert.equal([...ctx.pool.store.work.values()].filter((w) => w.component==='all_logs').length,5);
  assert.equal([...ctx.pool.store.work.values()].filter((w) => w.component==='transfer_logs').length,1);
});
await test('A2.5I exact capacity boundary counts missing jobs before inserting and rolls back an over-capacity pair',async () => {
  for (const [existing,outstanding,success] of [
    [[],MAX_WORK_ROWS-2,true],[[],MAX_WORK_ROWS-1,false],[[],MAX_WORK_ROWS,false],
    [['all_logs'],MAX_WORK_ROWS-1,true],[['transfer_logs'],MAX_WORK_ROWS-1,true],
    [['all_logs'],MAX_WORK_ROWS,false],[['all_logs','transfer_logs'],MAX_WORK_ROWS,true],
  ]) {
    const ctx=await receiptFollowupContext(existing);fillWorkCapacity(ctx,outstanding);
    const before=structuredClone(ctx.pool.store);ctx.pool.calls.length=0;
    const save=ctx.repository.saveReceipts(ctx.lease,[receipt(100)],{deferFrontier:true});
    if (success) {
      assert.equal((await save).complete,true);
      assert.equal([...ctx.pool.store.work.values()].filter((w) => w.component==='all_logs').length,1);
      assert.equal([...ctx.pool.store.work.values()].filter((w) => w.component==='transfer_logs').length,1);
      // The leased receipt still counts at admission; only afterwards does unchanged finish release its capacity.
      assert.equal([...ctx.pool.store.work.values()].filter((w) => w.state!=='complete').length,outstanding+2-existing.length-1);
    } else {
      await assert.rejects(save,/work_capacity_reached/);assert.deepEqual(ctx.pool.store,before);
      assert(!ctx.pool.calls.some((c) => c.text.includes('a2:enqueue_followups')));
    }
  }
});
await test('A2.5I failure after pair INSERT rolls back both jobs and receipt evidence/certification/coverage/progress',async () => {
  const ctx=await receiptFollowupContext(),before=structuredClone(ctx.pool.store);ctx.pool.fail('a2:result');
  await assert.rejects(ctx.repository.saveReceipts(ctx.lease,[receipt(100)],{deferFrontier:true}),/Injected failure/);
  assert(ctx.pool.calls.some((c) => c.text.includes('a2:enqueue_followups')));
  assert.deepEqual(ctx.pool.store,before);
  await ctx.repository.saveReceipts(ctx.lease,[receipt(100)],{deferFrontier:true});
  assert.equal(ctx.pool.store.work.size,3);assert.equal(ctx.pool.store.receipts.size,1);
});
await test('A2.5I capacity failure remains retrying with durable receipt bulk-attempt marker and no fabricated success',async () => {
  const ctx=await setup();await ctx.repository.scheduleBlock(100);fillWorkCapacity(ctx,MAX_WORK_ROWS-1);
  const w=worker(ctx,fullHandler(100));const result=await w.instance.runOnce({preferredComponent:'receipts',deferFrontier:true});
  assert.equal(result.status,'retrying');assert.equal(result.error,'work_capacity_reached');
  assert.equal(ctx.pool.store.receipts.size,0);assert.equal(ctx.pool.store.logs.size,0);
  assert.equal(ctx.pool.store.blocks.get(100).receipt_complete,false);assert.equal(ctx.pool.store.blocks.get(100).receipt_bulk_attempted,true);
  assert.equal([...ctx.pool.store.work.values()].filter((w) => w.component==='all_logs' || w.component==='transfer_logs').length,0);
  const job=[...ctx.pool.store.work.values()].find((w) => w.component==='receipts');assert.equal(job.state,'retrying');
  assert.equal(job.reason_code,'required_read_unavailable');assert.equal(job.lease_owner,null);
});
await test('A2.5I completed reconciliation suppresses that component; drain and bounded old-block recovery stay unchanged',async () => {
  const ctx=await readyLogs(1),records=await preparedLogRecords(ctx,1);
  await ctx.repository.saveReconciliationBatch(records);
  const j=ctx.pool.store.work.get(records[0].lease.id);ctx.pool.store.work.delete(j.id);
  const receiptJob=[...ctx.pool.store.work.values()].find((w) => w.component==='receipts');receiptJob.state='pending';receiptJob.not_before=0;
  const lease=await ctx.repository.claim('certificate-retry',180000,{preferredComponent:'receipts'});ctx.pool.calls.length=0;
  await ctx.repository.saveReceipts(lease,[receipt(100,0,[log(100),log(100,0,1,false)])],{deferFrontier:true});
  const lookup=ctx.pool.calls.find((c) => c.text.includes('a2:followups_existing'));
  assert.deepEqual(lookup.values[5],['transfer_logs']);assert(!ctx.pool.calls.some((c) => c.text.includes('a2:enqueue_followups')));
  const drain=await setup([block(100),block(1000)]);await drain.repository.scheduleBlock(100);
  const w=worker(drain,fullHandler(100));drain.pool.calls.length=0;
  assert.equal((await w.instance.runOnce({preferredComponent:'receipts',enqueueFollowups:false,deferFrontier:true})).status,'complete');
  assert(!drain.pool.calls.some((c) => c.text.includes('a2:followups_existing') || c.text.includes('a2:enqueue')));
  assert.deepEqual(await drain.repository.recentIncompleteBlocks(1000),[1000]);
  assert.deepEqual((await drain.repository.deferredFollowupBlocks()).blocks,[100]);
  assert.equal((await drain.repository.recoverDeferredFollowups(100)).length,2);
  assert.equal((await drain.repository.recoverDeferredFollowups(100)).length,0);assert.equal(drain.pool.store.work.size,3);
});
await test('A2.5I pair prune preserves complete retention and all non-complete states',async () => {
  const ctx=await receiptFollowupContext();
  for (let i=0;i<COMPLETE_WORK_RETAIN+10;i++) {
    const id=String(10000+i);ctx.pool.store.work.set(id,{id,state:'complete'});
  }
  const protectedIds=[];
  for (const state of ['pending','leased','retrying','persistent_partial','failed']) {
    const id=`protected-${state}`;protectedIds.push(id);ctx.pool.store.work.set(id,{id,state});
  }
  ctx.pool.calls.length=0;
  // No finish prune in this call: precisely the pair's single retention pass.
  await ctx.repository.saveReceipts(ctx.lease,[receipt(100)],{finalize:false,deferFrontier:true});
  assert.equal(ctx.pool.calls.filter((c) => c.text.includes('a2:prune_complete')).length,1);
  assert.equal([...ctx.pool.store.work.values()].filter((w) => w.state==='complete').length,COMPLETE_WORK_RETAIN);
  for (const id of protectedIds) assert(ctx.pool.store.work.has(id));
});
await test('A2.5I same burst keeps durable truth with 703->653 SQL and 100->50 followup statements',async () => {
  async function profile(legacy) {
    const ctx=await setup(Array.from({length:10},(_,i) => block(100+i)));
    if (legacy) legacyFollowupEnqueues(ctx.pool);
    for (let n=100;n<110;n++) await ctx.repository.scheduleBlock(n);
    let followupSql=0;const save=ctx.repository.saveReceipts.bind(ctx.repository);
    ctx.repository.saveReceipts=async (...args) => {
      const start=ctx.pool.calls.length,result=await save(...args),calls=ctx.pool.calls.slice(start);
      const first=calls.findIndex((c) => c.text.startsWith('SELECT pg_advisory_xact_lock'));
      const last=calls.findLastIndex((c) => c.text.includes('a2:enqueue'));
      assert(first>=0 && last>=first);followupSql+=last-first+1;return result;
    };
    const w=worker(ctx,(method,[arg]) => method==='eth_getBlockReceipts'
      ? [receipt(Number(BigInt(arg)),0,[log(Number(BigInt(arg))),log(Number(BigInt(arg)),0,1,false)])]
      : rangeLogs(100,10,!!arg.topics));
    ctx.pool.calls.length=0;
    const results=await createWorkBurst({worker:{async runOnce(options) {
      await ctx.repository.workPressure();return w.instance.runOnce(options);
    }},frontier:() => ctx.repository.advanceFrontier()})();
    assert.equal(results.length,12);assert(results.every((r) => r.status==='complete'));
    assert.deepEqual(results.map((r) => r.component),[...Array(10).fill('receipts'),'all_logs','transfer_logs']);
    assert.equal(w.calls.length,12);assert.equal(w.calls.filter((c) => c.method==='eth_getLogs').length,2);
    return {ctx,totals:{sql:ctx.pool.calls.length,transactions:ctx.pool.calls.filter((c) => c.text==='BEGIN').length,
      advance:ctx.pool.calls.filter((c) => c.text.includes('receipts:advance')).length,followupSql}};
  }
  const before=await profile(true),after=await profile(false);
  assert.deepEqual(before.totals,{sql:703,transactions:55,advance:11,followupSql:100});
  assert.deepEqual(after.totals,{sql:653,transactions:55,advance:11,followupSql:50});
  for (const key of ['blocks','transactions','receipts','logs','reconciliation','coverage','work','lanes'])
    assert.deepEqual(after.ctx.pool.store[key],before.ctx.pool.store[key]);
  console.log(`A2.5I_BURST_PROFILE: before=${JSON.stringify(before.totals)} after=${JSON.stringify(after.totals)}; identical durable truth`);
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
