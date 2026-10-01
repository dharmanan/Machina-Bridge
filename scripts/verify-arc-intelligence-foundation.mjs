import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { migrate, captureA1Anchor } from '../server/arc-intelligence/migrate.js';
import { CHAIN_IDENTITY as identity, createFoundationRepository, manifestCoverage, MAX_WORK_ROWS } from '../server/arc-intelligence/foundation.js';
import { createChainFollower } from '../server/arc-intelligence/chain-lane.js';
import { createRpcBudget } from '../server/arc-intelligence/rpc-budget.js';
import { createFoundationScheduler } from '../server/arc-intelligence/scheduler.js';
import { ARC_RPC_URL } from '../api/_lib/arc-intelligence/rpc.js';

import { fixturePool,hash,block,rawBlock,fixtureChainRpc } from './fixtures/arc-intelligence-a2.mjs';
const names = ['arc_intelligence_state','arc_intelligence_chunks','arc_intelligence_latest','arc_intelligence_runs'];

async function setup() {
  const pool=fixturePool(); await migrate(pool);
  const repository=createFoundationRepository(pool); await repository.initializeChainLane();
  return {pool,repository};
}
let count=0;
async function test(name,work) {await work(); count++; console.log(`PASS ${name}`);}
const job = (key='blocks100') => ({component:'manifest',logicalKey:key,startBlock:100,endBlock:100,blockHash:hash(101)});

await test('versioned migrations are idempotent, additive, checksum protected and preserve A1',async () => {
  const pool=fixturePool(); const a1=structuredClone(pool.store.a1);
  await migrate(pool); const records=structuredClone(pool.store.migrations); await migrate(pool);
  assert.equal(pool.store.migrations.size,3); assert.deepEqual(pool.store.migrations,records); assert.deepEqual(pool.store.a1,a1);
  assert.equal(pool.store.tables.size,13); names.forEach((name) => assert(pool.store.tables.has(name)));
  const sql=await readFile(new URL('../server/arc-intelligence/sql/002_a2_foundation.sql',import.meta.url),'utf8');
  assert(!/\b(?:ALTER|DROP|TRUNCATE)\b/.test(sql));
  names.forEach((name) => assert(!sql.includes(name)));
  const coverageSchema=sql.split('CREATE TABLE IF NOT EXISTS arc_intelligence_coverage')[1];
  assert(!coverageSchema.includes('chain_manifest'),'Generic schema must support future complete coverage dimensions');
  assert(coverageSchema.includes("state text NOT NULL CHECK (state IN ('complete','partial'))"));
  pool.store.migrations.get('002_a2_foundation').checksum='invalid';
  await assert.rejects(migrate(pool),/migration_checksum_mismatch/);
});
await test('A1 anchor retains bounded origin and original epoch after A1 advances',async () => {
  const {pool,repository}=await setup();
  pool.store.a1.last_indexed_block='149'; pool.store.a1.last_indexed_hash=hash(150); pool.store.a1.next_block='150';
  await migrate(pool); const lane=await repository.initializeChainLane();
  assert.equal(lane.origin_block,100); assert.equal(lane.anchor_block,99); assert.equal(lane.anchor_hash,hash(100));
  assert.equal(lane.epoch,identity.epoch); assert.equal(lane.processed_through,null);
  assert.deepEqual(pool.store.migrations.get('002_a2_foundation').metadata.anchor,{lastIndexedBlock:99,lastIndexedHash:hash(100),nextBlock:100});
  assert.throws(() => captureA1Anchor({...pool.store.a1,next_block:'151'}),/a1_anchor_invalid/);
});
await test('interrupted migration rolls back ledger and tables, retry applies exactly once',async () => {
  const pool=fixturePool(); const a1=structuredClone(pool.store.a1);
  pool.fail('CREATE TABLE IF NOT EXISTS arc_intelligence_lanes');
  await assert.rejects(migrate(pool)); assert.equal(pool.store.migrations.size,0); assert.equal(pool.store.tables.size,4);
  assert.deepEqual(pool.store.a1,a1); await migrate(pool); await migrate(pool); assert.equal(pool.store.migrations.size,3);
});
await test('missing A1 anchor never assumes genesis or prevents A1 migration',async () => {
  const pool=fixturePool(); pool.store.a1=null; await migrate(pool);
  await assert.rejects(createFoundationRepository(pool).initializeChainLane(),/a1_anchor_unavailable/);
});
await test('null anchor bootstraps once from valid A1 without A1 writes and remains immutable',async () => {
  const pool=fixturePool(); const state=structuredClone(pool.store.a1); pool.store.a1=null; await migrate(pool);
  const repository=createFoundationRepository(pool);
  pool.store.a1={...state,next_block:null,last_indexed_block:null,last_indexed_hash:null};
  await assert.rejects(repository.initializeChainLane(),/a1_anchor_unavailable/);
  assert.equal(pool.store.migrations.get('002_a2_foundation').metadata.anchor,null);
  pool.store.a1={...state,next_block:'101'};
  await assert.rejects(repository.initializeChainLane(),/a1_anchor_invalid/);
  assert.equal(pool.store.migrations.get('002_a2_foundation').metadata.anchor,null);
  assert.equal(pool.store.lanes.size,0);
  pool.store.a1=state; pool.fail('a2:initialize');
  await assert.rejects(repository.initializeChainLane());
  assert.equal(pool.store.migrations.get('002_a2_foundation').metadata.anchor,null,'Capture and lane creation roll back together');
  const before=structuredClone(pool.store.a1); const lane=await repository.initializeChainLane();
  assert.equal(lane.origin_block,100); assert.equal(lane.anchor_hash,hash(100)); assert.deepEqual(pool.store.a1,before);
  const original=structuredClone(pool.store.migrations.get('002_a2_foundation').metadata);
  pool.store.a1={...state,last_indexed_block:'149',last_indexed_hash:hash(150),next_block:'150'};
  assert.equal((await repository.initializeChainLane()).origin_block,100);
  assert.deepEqual(pool.store.migrations.get('002_a2_foundation').metadata,original);
  assert(!pool.calls.some(({text}) => /(?:INSERT INTO|UPDATE|DELETE FROM) arc_intelligence_state\b/.test(text)));
});
await test('invalid existing anchor fails closed without replacement',async () => {
  const pool=fixturePool(); await migrate(pool);
  pool.store.migrations.get('002_a2_foundation').metadata.anchor.nextBlock=101;
  await assert.rejects(createFoundationRepository(pool).initializeChainLane(),/a1_anchor_invalid/);
  assert.equal(pool.store.lanes.size,0);
  assert(!pool.calls.some(({text}) => text.includes('a2:capture_anchor')));
});
await test('migration before A1 initialization leaves a recoverable null anchor',async () => {
  const pool=fixturePool(); const state=structuredClone(pool.store.a1);
  pool.store.a1={...state,last_indexed_block:null,last_indexed_hash:null,next_block:null};
  await migrate(pool); assert.equal(pool.store.migrations.get('002_a2_foundation').metadata.anchor,null);
  pool.store.a1=state; assert.equal((await createFoundationRepository(pool).initializeChainLane()).origin_block,100);
});
await test('forward-safe block schema preserves defaults and permits only consistent future completion',async () => {
  const sql=await readFile(new URL('../server/arc-intelligence/sql/002_a2_foundation.sql',import.meta.url),'utf8');
  const schema=sql.split('CREATE TABLE IF NOT EXISTS arc_intelligence_blocks')[1].split('CREATE TABLE IF NOT EXISTS arc_intelligence_work')[0];
  assert(schema.includes('receipt_count integer CHECK (receipt_count IS NULL OR (receipt_count >= 0 AND receipt_count <= transaction_count))'));
  const implications=[
    'NOT receipt_complete OR (receipt_count IS NOT NULL AND receipt_count = transaction_count)',
    'NOT all_log_reconciliation_complete OR receipt_complete',
    'NOT transfer_log_reconciliation_complete OR receipt_complete',
    'NOT core_complete OR (receipt_complete AND all_log_reconciliation_complete AND transfer_log_reconciliation_complete)',
  ];
  implications.forEach((expression) => assert(schema.includes(`CHECK (${expression})`)));
  ['receipt_complete','all_log_reconciliation_complete','transfer_log_reconciliation_complete','core_complete'].forEach((field) => {
    assert(schema.includes(`${field} boolean NOT NULL DEFAULT false`)); assert(!schema.includes(`CHECK (${field} = false)`));
  });
  // Constraint truth-table fixture, tied above to the exact SQL expressions; no future receipt writer is added.
  const valid=(b) => (b.receipt_count === null || (b.receipt_count >= 0 && b.receipt_count <= b.transaction_count))
    && (!b.receipt_complete || (b.receipt_count !== null && b.receipt_count === b.transaction_count))
    && (!b.all_log_reconciliation_complete || b.receipt_complete)
    && (!b.transfer_log_reconciliation_complete || b.receipt_complete)
    && (!b.core_complete || (b.receipt_complete && b.all_log_reconciliation_complete && b.transfer_log_reconciliation_complete));
  const initial={transaction_count:2,receipt_count:null,receipt_complete:false,all_log_reconciliation_complete:false,transfer_log_reconciliation_complete:false,core_complete:false};
  const completed={...initial,receipt_count:2,receipt_complete:true,all_log_reconciliation_complete:true,transfer_log_reconciliation_complete:true,core_complete:true};
  assert(valid(initial)); assert(valid({...initial,receipt_count:1})); assert(valid(completed));
  assert(valid({...completed,transaction_count:0,receipt_count:0}));
  for (const invalid of [{...initial,receipt_count:-1},{...initial,receipt_count:3},{...initial,receipt_complete:true},
    {...completed,receipt_count:1},{...initial,core_complete:true},{...completed,all_log_reconciliation_complete:false},
    {...completed,transfer_log_reconciliation_complete:false}]) assert.equal(valid(invalid),false);
});
await test('manifest persistence leaves receipts, reconciliation and core incomplete',async () => {
  const {pool,repository}=await setup(); await repository.persistManifest(identity,[block(100)]);
  const stored=pool.store.blocks.get(100); assert.equal(stored.receipt_count,null);
  ['receipt_complete','all_log_reconciliation_complete','transfer_log_reconciliation_complete','core_complete'].forEach((key) => assert.equal(stored[key],false));
  const lane=await repository.getLane(); assert.equal(lane.contiguous_complete_through,100); assert.equal(lane.checkpoint_hash,hash(101));
  Object.assign(stored,{receipt_count:1,receipt_complete:true,all_log_reconciliation_complete:true,
    transfer_log_reconciliation_complete:true,core_complete:true});
  await repository.persistManifest(identity,[block(100)]);
  assert.equal(pool.store.blocks.get(100).core_complete,true,'Chain replay must preserve future verified receipt/core state');
});
await test('duplicate and crash retry are idempotent; rolled back manifests are not counted',async () => {
  const {pool,repository}=await setup(); pool.fail('a2:progress');
  await assert.rejects(repository.persistManifest(identity,[block(100)])); assert.equal(pool.store.blocks.size,0);
  await repository.persistManifest(identity,[block(100)]); await repository.persistManifest(identity,[block(100)]);
  assert.equal(pool.store.blocks.size,1); assert.equal((await repository.getLane()).processed_through,100);
});
await test('parent mismatch fails closed, persists halt and cannot reset lane status',async () => {
  const {pool,repository}=await setup();
  await assert.rejects(repository.persistManifest(identity,[{...block(100),parent_hash:hash(900)}]),/checkpoint_parent_hash_mismatch/);
  assert.equal(pool.store.blocks.size,0); assert.equal((await repository.getLane()).status,'continuity_error');
  await repository.setLaneStatus(identity,'indexing');
  await assert.rejects(repository.persistManifest(identity,[block(100)]),/lane_continuity_stopped/);
});
await test('conflicting block hash rejected without replacing prior evidence',async () => {
  const {pool,repository}=await setup(); await repository.persistManifest(identity,[block(100)]);
  await assert.rejects(repository.persistManifest(identity,[{...block(100),block_hash:hash(999)}]),/manifest_conflict/);
  assert.equal(pool.store.blocks.get(100).block_hash,hash(101));
});
await test('out of order parent evidence and persisted anchor mismatch both fail closed',async () => {
  const first=await setup(); await first.repository.persistManifest(identity,[{...block(102),parent_hash:hash(999)}]);
  await assert.rejects(first.repository.persistManifest(identity,[block(101)]),/checkpoint_parent_hash_mismatch/);
  assert.equal((await first.repository.getLane()).status,'continuity_error');
  const second=await setup(); second.pool.store.blocks.set(100,{...block(100),parent_hash:hash(999),transactions_complete:true});
  await assert.rejects(second.repository.persistManifest(identity,[block(102)]),/checkpoint_parent_hash_mismatch/);
  assert.equal((await second.repository.getLane()).status,'continuity_error');
  assert(!second.pool.store.blocks.has(102));
});
await test('processed frontier advances across a gap; complete frontier advances only after filling it',async () => {
  const {pool,repository}=await setup(); await repository.persistManifest(identity,[block(100)]);
  let lane=await repository.persistManifest(identity,[block(102)]);
  assert.equal(lane.processed_through,102); assert.equal(lane.contiguous_complete_through,100);
  assert([...pool.store.coverage.values()].some((c) => c.start === 102 && c.state === 'partial'));
  lane=await repository.persistManifest(identity,[block(101)]);
  assert.equal(lane.contiguous_complete_through,102); assert.equal(lane.checkpoint_hash,hash(103));
  assert([...pool.store.coverage.values()].every((c) => c.state === 'complete'));
});
await test('manifest evidence cannot certify receipts or protocol completeness',async () => {
  for (const dimension of ['receipts','all_log_reconciliation','transfer_log_reconciliation','protocol_events']) {
    assert.throws(() => manifestCoverage(identity,[block(100)],'complete',dimension),/invalid_chain_coverage/);
  }
  assert.throws(() => manifestCoverage(identity,[block(100),block(102)],'complete'),/invalid_chain_coverage/);
  assert.match(manifestCoverage(identity,[block(100)]).evidenceDigest,/^[0-9a-f]{64}$/);
  assert.equal(manifestCoverage({...identity},[block(100)]).evidenceDigest,
    manifestCoverage(Object.fromEntries(Object.entries(identity).reverse()),[{...block(100),block_hash:hash(101).toUpperCase().replace('0X','0x')}]).evidenceDigest);
});
await test('version keyed lane reuses canonical manifests without sharing progress state',async () => {
  const {pool,repository}=await setup(); await repository.persistManifest(identity,[block(100),block(101),block(102)]);
  const other={...identity,definitionVersion:'arc-chain-manifest-fixture-v2'};
  await repository.initializeChainLane(other); assert.equal((await repository.getLane(other)).processed_through,null);
  const result=await repository.persistManifest(other,[block(100)]);
  assert.equal(result.contiguous_complete_through,102); assert.equal(result.processed_through,102);
  assert.equal(pool.store.blocks.size,3); assert.equal(pool.store.lanes.size,2);
});
await test('queue unique identity, immutable range, bounded size and safe reasons',async () => {
  const {pool,repository}=await setup();
  const first=await repository.enqueue(identity,job()); assert.equal((await repository.enqueue(identity,job())).id,first.id);
  await assert.rejects(repository.enqueue(identity,{...job(),endBlock:101,blockHash:null}),/work_identity_conflict/);
  await assert.rejects(repository.enqueue(identity,{...job(),endBlock:101}),/invalid_block_identity_range/);
  await assert.rejects(repository.enqueue(identity,{...job('large'),endBlock:150}),/invalid_work_range/);
  // Capacity uses all rows, including terminal jobs, so retention cannot grow silently.
  for (let i=pool.store.work.size;i<MAX_WORK_ROWS;i++) pool.store.work.set(`capacity${i}`,{});
  await assert.rejects(repository.enqueue(identity,job('overcapacity')),/work_capacity_reached/);
  assert.equal(pool.store.work.size,MAX_WORK_ROWS);
});
await test('expired leases reclaim with increasing fences; stale owners cannot finish',async () => {
  const {pool,repository}=await setup(); await repository.enqueue(identity,job());
  const old=await repository.claim(identity,'worker1',1000); assert.equal(await repository.claim(identity,'worker2'),null);
  pool.advance(1001); const current=await repository.claim(identity,'worker2',1000);
  assert.equal(current.attempts,2); assert.equal(current.fencing_token,'2');
  await assert.rejects(repository.finishWork(old),/stale_lease/);
  await assert.rejects(repository.persistManifest(identity,[block(100)],old),/stale_lease/);
  assert.equal(pool.store.blocks.size,0);
  await repository.persistManifest(identity,[block(100)],current);
  assert.equal(pool.store.work.get(current.id).state,'complete'); assert.equal(pool.store.blocks.size,1);
  await assert.rejects(repository.finishWork(current),/stale_lease/);
});
await test('lease completion is atomic with manifests and checks full job range',async () => {
  const {pool,repository}=await setup(); await repository.enqueue(identity,{...job(),endBlock:101,blockHash:null});
  const lease=await repository.claim(identity,'worker1');
  await assert.rejects(repository.persistManifest(identity,[block(100)],lease),/work_identity_mismatch/);
  pool.fail('a2:finish'); await assert.rejects(repository.persistManifest(identity,[block(100),block(101)],lease));
  assert.equal(pool.store.blocks.size,0); assert.equal(pool.store.work.get(lease.id).state,'leased');
  await repository.persistManifest(identity,[block(100),block(101)],lease); assert.equal(pool.store.blocks.size,2);
});
await test('retry delays preserve conservative transient status and sanitized reasons',async () => {
  const {pool,repository}=await setup(); await repository.enqueue(identity,job()); const lease=await repository.claim(identity,'worker');
  await assert.rejects(repository.finishWork(lease,{state:'failed',reason:'required_read_unavailable'}),/transient_failure_requires_retry/);
  await assert.rejects(repository.finishWork(lease,{state:'retrying',reason:'DATABASE_URL=secret'}),/invalid_reason_code/);
  await repository.finishWork(lease,{state:'retrying',reason:'required_read_unavailable',retryMs:5000});
  assert.equal(await repository.claim(identity,'worker'),null); pool.advance(5000);
  assert.equal((await repository.claim(identity,'worker')).fencing_token,'2');
});
await test('chain follower uses only canonical block reads and never writes A1',async () => {
  const {pool,repository}=await setup(); const a1=structuredClone(pool.store.a1); const calls=[];
  const rpc={url:ARC_RPC_URL,async request(method,params) {
    const transactions=pool.calls.map((c) => c.text).filter((text) => ['BEGIN','COMMIT','ROLLBACK'].includes(text));
    assert.notEqual(transactions.at(-1),'BEGIN','No database transaction may span an RPC call');
    calls.push(method);
    if (method === 'eth_chainId') return '0x13b2'; if (method === 'eth_blockNumber') return '0x68';
    assert.equal(method,'eth_getBlockByNumber'); assert.equal(params[1],true);
    const n=Number(BigInt(params[0])); return rawBlock(n);
  }};
  const follower=createChainFollower({repository,rpc:fixtureChainRpc(rpc),maxBlocks:2});
  assert.equal((await follower.tick()).status,'indexing'); const result=await follower.tick();
  assert.equal(result.status,'caught_up'); assert.equal(result.coreComplete,false); assert.equal(pool.store.blocks.size,3);
  assert.equal(result.observedHead,104); assert.equal(result.targetHead,102);
  assert.equal((await repository.getLane()).observed_head,104); assert.equal(Math.max(...pool.store.blocks.keys()),102);
  const other=await setup(); const custom=await createChainFollower({repository:other.repository,rpc:fixtureChainRpc(rpc),finalityBlocks:3}).tick();
  assert.equal(custom.observedHead,104); assert.equal(custom.targetHead,101); assert.equal(Math.max(...other.pool.store.blocks.keys()),101);
  assert.deepEqual(pool.store.a1,a1); assert(!calls.some((m) => /Receipt|Logs/.test(m)));
  assert(!pool.calls.some(({text}) => /(?:INSERT INTO|UPDATE|DELETE FROM) arc_intelligence_(?:state|chunks|latest|runs)\b/.test(text)));
});
await test('chain read failure preserves checkpoint; retry resumes and shutdown aborts',async () => {
  const {repository}=await setup(); let failing=true;
  const rpc={url:ARC_RPC_URL,async request(method) {
    if (method === 'eth_chainId') return '0x13b2'; if (method === 'eth_blockNumber') return '0x66';
    if (failing) throw new Error('arbitrary RPC body');
    return {number:'0x64',hash:hash(101),parentHash:hash(100),timestamp:'0x6553f100',transactions:[]};
  }};
  const follower=createChainFollower({repository,rpc:fixtureChainRpc(rpc)});
  assert.deepEqual(await follower.tick(),{status:'retrying',error:'block_unavailable',persistedBlocks:0});
  assert.equal((await repository.getLane()).contiguous_complete_through,null);
  failing=false; assert.equal((await follower.tick()).status,'caught_up');
  const controller=new AbortController(); controller.abort(); assert.equal((await follower.tick({signal:controller.signal})).status,'aborted');
});
await test('safe-head option is bounded; head below offset preserves raw head without negative indexing',async () => {
  const {pool,repository}=await setup(); const reads=[];
  const rpc={url:ARC_RPC_URL,async request(method) {
    reads.push(method); if (method === 'eth_chainId') return '0x13b2'; if (method === 'eth_blockNumber') return '0x1';
    assert.fail('No block read is allowed below finality offset');
  }};
  for (const finalityBlocks of [-1,10001,1.5]) assert.throws(() => createChainFollower({repository,rpc:fixtureChainRpc(rpc),finalityBlocks}),/invalid_chain_follower/);
  const result=await createChainFollower({repository,rpc:fixtureChainRpc(rpc)}).tick();
  assert.equal(result.status,'retrying'); assert.equal(result.error,'rpc_head_unavailable'); assert.equal(result.persistedBlocks,0);
  const lane=await repository.getLane(); assert.equal(lane.observed_head,1); assert.equal(lane.contiguous_complete_through,null);
  assert.equal(pool.store.blocks.size,0); assert.deepEqual(reads,['eth_chainId','eth_blockNumber']);
  const zero=await createChainFollower({repository,rpc:fixtureChainRpc(rpc),finalityBlocks:0}).tick(); assert.equal(zero.status,'caught_up'); assert.equal(zero.targetHead,1);
});
await test('RPC budget is bounded, shared, and cancels queued work without freeing active slots early',async () => {
  assert.throws(() => createRpcBudget({maxConcurrency:5}),/invalid_rpc_budget/);
  const budget=createRpcBudget({maxConcurrency:1,maxPending:2}); let resolve;
  const first=budget.run(() => new Promise((r) => {resolve=r;})); await Promise.resolve();
  const controller=new AbortController(); const queued=budget.run(() => assert.fail('aborted task ran'),{signal:controller.signal});
  controller.abort(); await assert.rejects(queued,/operation_aborted/); assert.equal(budget.active,1);
  resolve(); await first; await new Promise((r) => setImmediate(r)); assert.equal(budget.active,0);
});
await test('active wrapped RPC receives identical options and signal; shared concurrency never exceeds four',async () => {
  const budget=createRpcBudget(); const controller=new AbortController(); const options={signal:controller.signal,requestLabel:'fixture'};
  let received;
  const wrapped=budget.wrap({url:ARC_RPC_URL,request(method,params,actual) {
    received=actual; assert.equal(method,'eth_blockNumber'); assert.deepEqual(params,[]);
    return new Promise((resolve,reject) => actual.signal.addEventListener('abort',() => reject(new Error('active_aborted')),{once:true}));
  }});
  const active=wrapped.request('eth_blockNumber',[],options); await Promise.resolve();
  assert.equal(received,options); assert.equal(received.signal,controller.signal); controller.abort();
  await assert.rejects(active,/active_aborted/); await new Promise((r) => setImmediate(r)); assert.equal(budget.active,0);
  let inFlight=0,peak=0;
  const shared=budget.wrap({url:ARC_RPC_URL,async request() {
    inFlight++; peak=Math.max(peak,inFlight); await new Promise((r) => setImmediate(r)); inFlight--; return 'ok';
  }});
  await Promise.all(Array.from({length:12},() => shared.request('eth_blockNumber'))); assert.equal(peak,4);
  await new Promise((r) => setImmediate(r)); assert.equal(budget.active,0);
  const single=createRpcBudget({maxConcurrency:1}); let release;
  const queuedRpc=single.wrap({url:ARC_RPC_URL,request(method) {
    assert.equal(method,'active'); return new Promise((resolve) => {release=resolve;});
  }});
  const held=queuedRpc.request('active'); await Promise.resolve();
  const queuedController=new AbortController();
  const waiting=queuedRpc.request('must_not_run',[],{signal:queuedController.signal});
  queuedController.abort(); await assert.rejects(waiting,/operation_aborted/);
  release(); await held; await new Promise((r) => setImmediate(r)); assert.equal(single.active,0);
});
await test('scheduler is bounded, isolates task failure, and has no production auto start',async () => {
  const scheduler=createFoundationScheduler(); const result=await scheduler.tick([async () => {throw new Error('raw secret');},async () => 2]);
  assert.deepEqual(result.results,[{status:'rejected',reason:'task_unavailable'},{status:'fulfilled',value:2}]);
  const main=await readFile(new URL('../server/arc-intelligence/main.js',import.meta.url),'utf8');
  assert(!/createChainFollower|createFoundationScheduler|createFoundationRepository/.test(main));
});
console.log(`A2_FOUNDATION_VERIFIER: PASS (${count} deterministic scenarios; SQL/RPC doubles, no live Postgres or deployment)`);
