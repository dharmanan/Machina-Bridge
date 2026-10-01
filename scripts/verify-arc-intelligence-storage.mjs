import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fixturePool,block,transaction,hash,address } from './fixtures/arc-intelligence-a2.mjs';
import { migrate } from '../server/arc-intelligence/migrate.js';
import { createFoundationRepository,CHAIN_IDENTITY } from '../server/arc-intelligence/foundation.js';
import { createReceiptRepository } from '../server/arc-intelligence/receipt-repository.js';
import { createRpcBudget } from '../server/arc-intelligence/rpc-budget.js';
import { createReceiptWorker } from '../server/arc-intelligence/receipt-lane.js';
import { createMetricRepository } from '../server/arc-intelligence/metric-repository.js';
import { reduceDurableHour,MAX_HOURLY_BLOCKS,MAX_HOURLY_FACT_ROWS,RAW_KEEP_SECONDS } from '../server/arc-intelligence/hourly-reducer.js';
import { ARC_RPC_URL } from '../api/_lib/arc-intelligence/rpc.js';
import { DEFINITION_VERSION } from '../api/_lib/arc-intelligence/core.js';
import { buildHistoricalMetrics } from '../api/_lib/arc-intelligence/metrics.js';
const START=36000000,END=START+3600,GAS=900719925474099312345n,PRICE=900719925474099312346n;
const hex=(n) => `0x${n.toString(16)}`;
let passed=0;
async function test(name,run) {await run();passed++;console.log(`PASS ${name}`);}
async function setup(size=3) {
  const pool=fixturePool();await migrate(pool);
  const chain=createFoundationRepository(pool);await chain.initializeChainLane();
  const numbers=Array.from({length:size+2},(_,i) => 100+i);
  for (let i=0;i<numbers.length;i++) {
    const b=block(numbers[i],2);
    b.timestamp=i===0 ? START-1 : i===numbers.length-1 ? END : START+Math.floor((i-1)*3599/Math.max(1,size-1));
    await chain.persistManifest(CHAIN_IDENTITY,[b]);
  }
  const receipts=createReceiptRepository(pool);await receipts.initialize();
  const rpc={url:ARC_RPC_URL,async request(method,params) {
    if (method==='eth_getBlockReceipts') {
      const n=Number(BigInt(params[0]));return [0,1].map((i) => ({blockNumber:hex(n),blockHash:hash(n+1),transactionIndex:hex(i),
        transactionHash:transaction(n,i).hash,status:n===102 && i===0 ? '0x0' : '0x1',gasUsed:hex(GAS),effectiveGasPrice:hex(PRICE),
        contractAddress:i ? address(10) : null,logs:[]}));
    }
    if (method==='eth_getLogs') return [];
    throw new Error('Unexpected RPC');
  }};
  const worker=createReceiptWorker({repository:receipts,rpc:createRpcBudget().wrap(rpc)});
  for (const n of numbers) {
    await receipts.scheduleBlock(n);
    for (const preferredComponent of ['receipts','all_logs','transfer_logs']) assert.equal((await worker.runOnce({preferredComponent})).status,'complete');
  }
  assert([...pool.store.blocks.values()].every((b) => !b.core_complete));
  // Sparse historical islands are useful independently of an archive-wide frontier.
  for (const lane of pool.store.lanes.values()) lane.contiguous_complete_through=null;
  const repo=createMetricRepository(pool);pool.calls.length=0;
  return {pool,repo,receipts,async reduce(){return repo.reduceHour({bucketStart:START});},
    async dry(now=END+RAW_KEEP_SECONDS){return repo.retentionDryRun({bucketStart:START,nowSeconds:now});}};
}
function unavailable(bucket) {
  assert.equal(bucket.complete,false);assert.notEqual(bucket.coverageStatus,'available');
  assert.equal(bucket.metrics.network.records,null);assert.equal(bucket.metrics.network.mergeState,null);assert.equal(bucket.rawPrunable,false);
}
function metric(bucket,id) {return bucket.metrics.network.records.find((r) => r.metricId===id);}
function hook(pool,callback) {
  const connect=pool.connect.bind(pool);pool.connect=async () => {
    const client=await connect(),query=client.query.bind(client);
    client.query=async (sql,values) => {await callback(sql,values);return query(sql,values);};return client;
  };
}
await test('004 additive idempotent migration; 001/002/003 immutable and A1 preserved',async () => {
  const pool=fixturePool(),a1=structuredClone(pool.store.a1);await migrate(pool);const ledger=structuredClone(pool.store.migrations);
  await migrate(pool);assert.deepEqual(pool.store.migrations,ledger);assert.deepEqual(pool.store.a1,a1);assert.equal(ledger.size,4);
  const sql=await readFile(new URL('../server/arc-intelligence/sql/004_a2_metric_buckets.sql',import.meta.url),'utf8');
  assert(sql.includes('PRIMARY KEY (chain_id,period,bucket_start,definition_version,reducer_version)'));
  assert(sql.includes('raw_prunable boolean NOT NULL DEFAULT false'));assert(!/DELETE|TRUNCATE|ALTER TABLE|CREATE INDEX|VACUUM/i.test(sql));
  console.log('OLD_MIGRATION_SHA256',JSON.stringify(await Promise.all(['001_init','002_a2_foundation','003_a2_receipts'].map(async (v) =>
    [v,createHash('sha256').update(await readFile(new URL(`../server/arc-intelligence/sql/${v}.sql`,import.meta.url))).digest('hex')]))));
});
await test('full verified UTC hour persisted despite null lane frontier and core_complete=false',async () => {
  const ctx=await setup(),a1=structuredClone(ctx.pool.store.a1),lanes=structuredClone(ctx.pool.store.lanes),bucket=await ctx.reduce();
  assert.equal(bucket.complete,true);assert.equal(bucket.blockCount,3);assert.equal(bucket.startBlock,101);assert.equal(bucket.endBlock,103);
  assert.equal(bucket.coverage.scope,'core_network');assert.equal(bucket.requiredReducersComplete,false);assert.equal(bucket.rawPrunable,false);
  assert.deepEqual(ctx.pool.store.a1,a1);assert.deepEqual(ctx.pool.store.lanes,lanes);assert.equal(ctx.pool.store.metricBuckets.size,1);
  assert(bucket.metrics.network.records.every((r) => r.protocol==='arc.network'));
});
await test('existing metrics contract reused exactly; core counts/raw gas/fees and unique merge state',async () => {
  const ctx=await setup(),bucket=await ctx.reduce(),blocks=[...ctx.pool.store.blocks.values()];
  const snapshot={complete:true,chainId:5042,source:ARC_RPC_URL,definitionVersion:DEFINITION_VERSION,startBlock:100,endBlock:104,
    blocks:blocks.map((b) => ({number:b.block_number,hash:b.block_hash,parentHash:b.parent_hash,timestamp:b.timestamp})),
    transactions:[...ctx.pool.store.transactions.values()].map((t) => ({blockNumber:t.block_number,transactionIndex:t.transaction_index,hash:t.transaction_hash,from:t.from_address,to:t.to_address})),
    receipts:[...ctx.pool.store.receipts.values()].map((r) => ({blockNumber:r.block_number,transactionIndex:r.transaction_index,hash:r.transaction_hash,status:r.status,
      gasUsedRaw:r.gas_used_raw,effectiveGasPriceRaw:r.effective_gas_price_raw,contractAddress:r.contract_address})),transferLogs:[],verifiedAssetObservations:[]};
  const expected=buildHistoricalMetrics({chunkSnapshots:[snapshot],coreCoverage:{metricSnapshotCoverageComplete:true},legacyUsdcCoverage:{status:'unavailable'}})
    .buckets.hour.find((b) => b.bucketStartUtc===new Date(START*1000).toISOString()).records.filter((r) => r.protocol==='arc.network');
  assert.deepEqual(bucket.metrics.network.records,expected);
  const values=Object.fromEntries(expected.map((r) => [r.metricId,r.value]));console.log('DURABLE_NETWORK_METRICS',JSON.stringify(values));
  assert.equal(values['network.totalGasUsedRaw'],String(6n*GAS));assert.equal(values['network.totalTransactionFeesRaw'],String(6n*GAS*PRICE));
  assert.equal(values['network.transactionCount'],6);assert.equal(values['network.successfulTransactionCount'],5);assert.equal(values['network.failedTransactionCount'],1);
  assert.deepEqual(bucket.metrics.network.mergeState.uniqueTopLevelSenders,[address(1)]);
  assert.deepEqual(bucket.metrics.network.mergeState.uniqueTopLevelRecipients,[address(2)]);
});
await test('same hour/version rerun is idempotent and digest/order stable',async () => {
  const ctx=await setup(),first=await ctx.reduce(),second=await ctx.reduce();assert.deepEqual(first,second);assert.equal(ctx.pool.store.metricBuckets.size,1);
});
await test('raw fact order is normalized without losing precision',async () => {
  const ctx=await setup(),first=await ctx.reduce();
  ctx.pool.store.transactions=new Map([...ctx.pool.store.transactions].reverse());ctx.pool.store.receipts=new Map([...ctx.pool.store.receipts].reverse());
  assert.deepEqual(await ctx.reduce(),first);
});
for (const [name,mutate] of [
  ['missing middle block even when all remaining rows are complete',(s) => s.blocks.delete(102)],
  ['parent hash discontinuity',(s) => {s.blocks.get(102).parent_hash=hash(999);}],
  ['receipt incomplete',(s) => {s.blocks.get(102).receipt_complete=false;}],
  ['transaction manifest incomplete',(s) => {s.blocks.get(102).transactions_complete=false;}],
  ['all_logs incomplete',(s) => {s.blocks.get(102).all_log_reconciliation_complete=false;}],
  ['transfer_logs incomplete',(s) => {s.blocks.get(102).transfer_log_reconciliation_complete=false;}],
  ['receipt evidence conflict',(s) => {s.blocks.get(102).receipt_evidence_conflict=true;}],
  ['receipt coverage certificate missing',(s) => {for (const [k,c] of s.coverage) if (c.start===102 && c.dimension==='receipts') s.coverage.delete(k);}],
  ['all log certificate missing',(s) => {for (const [k,c] of s.reconciliation) if (c.block_number===102 && c.kind==='all_logs') s.reconciliation.delete(k);}],
  ['transfer log certificate partial',(s) => {for (const c of s.reconciliation.values()) if (c.block_number===102 && c.kind==='transfer_logs') c.complete=false;}],
  ['coverage exact epoch mismatch',(s) => {for (const c of s.coverage.values()) if (c.start===102 && c.dimension==='receipts') c.identity[3]='wrong';}],
  ['certificate exact block hash mismatch',(s) => {for (const c of s.reconciliation.values()) if (c.block_number===102) c.block_hash=hash(999);}],
  ['certificate definition mismatch',(s) => {for (const c of s.reconciliation.values()) if (c.block_number===102) c.definition_version='wrong';}],
  ['first partial hour',(s) => s.blocks.delete(100)],
  ['last partial hour',(s) => s.blocks.delete(104)],
  ['same timestamp at left boundary does not prove beginning',(s) => {s.blocks.get(100).timestamp=START;}],
  ['missing durable receipt facts',(s) => s.receipts.delete(transaction(102).hash)],
  ['missing durable transaction facts',(s) => s.transactions.delete(transaction(102).hash)],
  ['receipt identity mismatch',(s) => {s.receipts.get(transaction(102).hash).block_hash=hash(999);}],
]) await test(name+' cannot become complete or zero',async () => {const ctx=await setup();mutate(ctx.pool.store);unavailable(await ctx.reduce());});
await test('historical A1/A2 hole never becomes zero; exact missing ranges persist',async () => {
  const ctx=await setup();ctx.pool.store.blocks.delete(102);const b=await ctx.reduce();unavailable(b);
  assert.deepEqual(b.coverage.missingBlockRanges,[{startBlock:102,endBlock:102}]);
  const empty=await ctx.repo.reduceHour({bucketStart:START-3600});unavailable(empty);assert.equal(empty.metrics.network.records,null);
});
await test('empty verified block hour can be true zero; gaps cannot',async () => {
  const ctx=await setup();
  for (const b of ctx.pool.store.blocks.values()) {b.transaction_count=0;b.receipt_count=0;}
  ctx.pool.store.transactions.clear();ctx.pool.store.receipts.clear();const b=await ctx.reduce();assert.equal(b.complete,true);
  assert.equal(metric(b,'network.transactionCount').value,0);assert.equal(metric(b,'network.totalGasUsedRaw').value,'0');
});
await test('missing fee metadata is unavailable individually, not fabricated zero',async () => {
  const ctx=await setup();ctx.pool.store.receipts.get(transaction(102).hash).effective_gas_price_raw=null;
  const b=await ctx.reduce();assert.equal(b.complete,true);const fee=metric(b,'network.totalTransactionFeesRaw');assert.equal(fee.value,null);assert.equal(fee.complete,false);
});
await test('all protocol metrics explicitly unavailable/null, no zero/TVL/USD fabrication',async () => {
  const b=await (await setup()).reduce();assert.deepEqual(Object.keys(b.metrics.protocols),['uniswap','aave','morpho','cctp','gateway','across','launchpads']);
  for (const p of Object.values(b.metrics.protocols)) {assert.equal(p.value,null);assert.equal(p.complete,false);assert.equal(p.status,'unavailable');assert(p.reason);}
});
await test('recent retention bucket is not eligible',async () => {const ctx=await setup();await ctx.reduce();const d=await ctx.dry(END+RAW_KEEP_SECONDS-1);assert(d.reasons.includes('raw_keep_window'));assert.equal(d.eligible,false);});
await test('old incomplete bucket is not eligible',async () => {const ctx=await setup();ctx.pool.store.blocks.delete(102);await ctx.reduce();const d=await ctx.dry();assert(d.reasons.includes('durable_bucket_incomplete'));assert.equal(d.rawPrunable,false);});
await test('old complete core still cannot be raw pruned; exact estimates and protocol exclusion',async () => {
  const ctx=await setup();await ctx.reduce();const d=await ctx.dry();assert.equal(d.coreRetentionPrerequisitesSatisfied,true);assert.equal(d.eligible,false);assert.equal(d.rawPrunable,false);
  assert.deepEqual(d.reasons,['required_reducers_incomplete','raw_deletion_disabled']);assert.deepEqual(d.estimatedRawRowsAffected,{blocks:3,transactions:6,receipts:6,logs:0,reconciliation:6,coverage:12});
});
for (const state of ['pending','retrying','leased','persistent_partial','failed']) await test(`retention rejects ${state} reference including other lane`,async () => {
  const ctx=await setup();await ctx.reduce();ctx.pool.store.work.set('unresolved',{chain_id:5042,lane:'another',state,start_block:102,end_block:102});
  const d=await ctx.dry();assert(d.reasons.includes('unresolved_work_references'));assert.equal(d.unresolvedWork[state],1);assert.equal(d.coreRetentionPrerequisitesSatisfied,false);
});
await test('retention exact provenance mismatch and later quarantine detected; bucket may downgrade',async () => {
  const ctx=await setup();await ctx.reduce();ctx.pool.store.blocks.get(102).receipt_evidence_conflict=true;
  const d=await ctx.dry();assert(d.reasons.includes('current_block_evidence_incomplete'));assert(d.reasons.includes('bucket_provenance_mismatch'));unavailable(await ctx.reduce());
});
await test('dry-run executes SELECT only; raw facts and completed work untouched',async () => {
  const ctx=await setup();await ctx.reduce();const before=structuredClone(ctx.pool.store);ctx.pool.calls.length=0;await ctx.dry();
  assert.deepEqual(ctx.pool.store,before);assert(ctx.pool.calls.every((c) => /\/\* metrics:(bucket|hour|raw_counts|unresolved) \*\//.test(c.text)));
  assert(!ctx.pool.calls.some((c) => /DELETE|TRUNCATE|VACUUM|INSERT|UPDATE/i.test(c.text)));assert.equal(ctx.pool.calls.length,4);
});
await test('evidence changes after fact reads fail closed before publication',async () => {
  const ctx=await setup();let changed=false;
  hook(ctx.pool,async (sql) => {if (!changed && sql.includes('metrics:lock')) {changed=true;ctx.pool.store.blocks.get(102).receipt_evidence_conflict=true;}});
  await assert.rejects(ctx.reduce(),/metric_evidence_changed/);assert.equal(ctx.pool.store.metricBuckets.size,0);
});
await test('abort before reduction leaves no writes',async () => {const ctx=await setup(),ac=new AbortController();ac.abort();await assert.rejects(ctx.repo.reduceHour({bucketStart:START,signal:ac.signal}),/operation_aborted/);assert.equal(ctx.pool.store.metricBuckets.size,0);});
await test('abort after write rolls back bucket and retry is recoverable',async () => {
  const ctx=await setup(),ac=new AbortController();let aborted=false;
  hook(ctx.pool,async (sql) => {if (!aborted && sql.includes('metrics:upsert')) {aborted=true;ac.abort();}});
  await assert.rejects(ctx.repo.reduceHour({bucketStart:START,signal:ac.signal}),/operation_aborted/);assert.equal(ctx.pool.store.metricBuckets.size,0);assert.equal((await ctx.reduce()).complete,true);
});
await test('publishing failure leaves durable raw facts unchanged; retry succeeds',async () => {
  const ctx=await setup(),before=structuredClone(ctx.pool.store);ctx.pool.fail('metrics:upsert');await assert.rejects(ctx.reduce());assert.deepEqual(ctx.pool.store,before);assert.equal((await ctx.reduce()).complete,true);
});
await test('bounded reducer limits fail closed and reject invalid UTC hour',async () => {
  const ctx=await setup();await assert.rejects(ctx.repo.reduceHour({bucketStart:START+1}),/invalid_hour/);
  const rows=(await ctx.pool.query('/* metrics:hour */ SELECT fixture',[5042,'receipts_logs','canonical_receipts_logs','a2-foundation-1','arc-receipts-logs-v1',START,END,MAX_HOURLY_BLOCKS+1])).rows;
  const many=Array(MAX_HOURLY_FACT_ROWS+1).fill([...ctx.pool.store.transactions.values()][0]);
  unavailable(reduceDurableHour({rows,transactions:many,receipts:[],start:START}));
  const overflow=Array.from({length:MAX_HOURLY_BLOCKS+1},(_,i) => ({...rows[1],window_role:'inside',block_number:101+i}));
  unavailable(reduceDurableHour({rows:overflow,start:START}));
});
await test('constant bounded SQL count, canonical SHARE locks and no RPC/critical transaction reducer',async () => {
  const profiles=[];
  for (const size of [3,101]) {
    const ctx=await setup(size);assert.equal((await ctx.reduce()).complete,true);
    const calls=ctx.pool.calls;assert.equal(calls.length,8);assert.equal(calls.filter((c) => c.text==='BEGIN').length,1);
    assert.equal(calls.filter((c) => c.text.includes('FOR SHARE OF b')).length,1);
    assert.equal(calls.filter((c) => c.text.includes('metrics:transactions')).length,1);
    assert.equal(calls.filter((c) => c.text.includes('metrics:receipts')).length,1);
    profiles.push({insideBlocks:size,sql:calls.length,transactions:1});
  }
  console.log('REDUCER_SQL_PROFILE',JSON.stringify(profiles));
  const repository=await readFile(new URL('../server/arc-intelligence/metric-repository.js',import.meta.url),'utf8');
  assert(!/eth_|\.request\(|DELETE|TRUNCATE|VACUUM/.test(repository));
  for (const file of ['main.js','a2-runtime.js']) assert(!(await readFile(new URL(`../server/arc-intelligence/${file}`,import.meta.url),'utf8')).includes('metric-repository'));
});
console.log(`ARC_INTELLIGENCE_STORAGE: PASS (${passed} deterministic scenarios; no real PostgreSQL, Railway, RPC or deletion)`);
