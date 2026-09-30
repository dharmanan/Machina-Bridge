import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fixturePool,block,rawBlock,transaction,hash,address } from './fixtures/arc-intelligence-a2.mjs';
import { migrate,MIGRATIONS } from '../server/arc-intelligence/migrate.js';
import { createFoundationRepository,CHAIN_IDENTITY } from '../server/arc-intelligence/foundation.js';
import { createReceiptRepository } from '../server/arc-intelligence/receipt-repository.js';
import { createReceiptWorker } from '../server/arc-intelligence/receipt-lane.js';
import { createChainFollower } from '../server/arc-intelligence/chain-lane.js';
import { createRpcBudget } from '../server/arc-intelligence/rpc-budget.js';
import { COMPLETE_WORK_RETAIN,COMPLETE_WORK_PRUNE_BATCH } from '../server/arc-intelligence/work-retention.js';
import { createA2RpcClient } from '../server/arc-intelligence/a2-rpc.js';
import { validateReceipt,normalizedLog } from '../server/arc-intelligence/receipt-facts.js';
import { reconcileLogs } from '../api/_lib/arc-intelligence/reconciliation.js';
import { ARC_RPC_URL } from '../api/_lib/arc-intelligence/rpc.js';
import { TRANSFER_TOPIC } from '../api/_lib/arc-intelligence/usdc.js';
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
function worker(ctx,handler,budget=createRpcBudget()) {
  const calls=[];
  const rpc=budget.wrap({url:ARC_RPC_URL,async request(method,params,options) {
    let depth=0;for (const call of ctx.pool.calls) {if (call.text === 'BEGIN') depth++;if (['COMMIT','ROLLBACK'].includes(call.text)) depth--;}
    assert.equal(depth,0,'No DB transaction open during RPC');calls.push({method,params,options});return handler(method,params,options);
  }});
  return {calls,instance:createReceiptWorker({repository:ctx.repository,rpc})};
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
  const ctx=await setup([]);const rpc=createRpcBudget().wrap({url:ARC_RPC_URL,async request(method,params) {
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
  const rpc=createRpcBudget().wrap({url:ARC_RPC_URL,async request(method,params) {
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
  for (const e of ctx.pool.store.reconciliation.values()) {assert.equal(e.complete,false);assert(e[field] > 0);}
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
  const rpc=createRpcBudget().wrap({url:ARC_RPC_URL,async request(method,params) {
    if (method === 'eth_chainId') return hex(5042);if (method === 'eth_blockNumber') return hex(head);
    reads.push(Number(BigInt(params[0])));return rawBlock(reads.at(-1));
  }});
  const follower=createChainFollower({repository:ctx.chain,rpc,maxBlocks:3,mode:'live'});
  assert.equal((await follower.tick()).persistedBlocks,3);assert.deepEqual(reads,[996,997,998]);
  reads.length=0;assert.equal((await follower.tick()).persistedBlocks,0);assert.deepEqual(reads,[]);
  head++;assert.equal((await follower.tick()).persistedBlocks,1);assert.deepEqual(reads,[999]);
  reads.length=0;head=1200;assert.equal((await follower.tick()).persistedBlocks,3);assert.deepEqual(reads,[1196,1197,1198]);
  const lane=await ctx.chain.getLane();assert.equal(lane.processed_through,1198);assert.equal(lane.observed_head,1200);
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
