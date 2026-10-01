import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { readRuntimeConfig } from '../server/arc-intelligence/runtime-config.js';
import { createRpcBudget } from '../server/arc-intelligence/rpc-budget.js';
import { createA2RpcClient } from '../server/arc-intelligence/a2-rpc.js';
import { createA2Runtime, createWorkBurst } from '../server/arc-intelligence/a2-runtime.js';
import { start } from '../server/arc-intelligence/main.js';
import { createHttpServer } from '../server/arc-intelligence/http.js';
import { createFoundationRepository, CHAIN_IDENTITY, MAX_WORK_ROWS } from '../server/arc-intelligence/foundation.js';
import { createChainFollower } from '../server/arc-intelligence/chain-lane.js';
import { createReceiptRepository, RECEIPT_IDENTITY } from '../server/arc-intelligence/receipt-repository.js';
import { createReceiptWorker } from '../server/arc-intelligence/receipt-lane.js';
import { migrate } from '../server/arc-intelligence/migrate.js';
import { ARC_RPC_URL } from '../api/_lib/arc-intelligence/rpc.js';
import { TRANSFER_TOPIC } from '../api/_lib/arc-intelligence/usdc.js';
import { fixturePool, block, rawBlock, hash, transaction, fixtureChainRpc } from './fixtures/arc-intelligence-a2.mjs';
let count = 0;
async function test(name, work) {
  if (process.argv.includes('--focused-a25h') && !name.startsWith('A2.5H')) return;
  await work(); console.log(`PASS ${name}`); count++;
}
async function flush() { for (let i=0;i<40;i++) await Promise.resolve(); }
function clock() {
  let time = 0;
  const timers = new Set();
  function sleep(ms, unused, {signal} = {}) {
    return new Promise((resolve,reject) => {
      if (signal?.aborted) return reject(new Error('operation_aborted'));
      const timer = {until:time+ms,finish:() => {timers.delete(timer);signal?.removeEventListener('abort',abort);resolve();}};
      function abort() {timers.delete(timer);reject(new Error('operation_aborted'));}
      signal?.addEventListener('abort',abort,{once:true});
      timers.add(timer);
    });
  }
  return {now:() => time,sleep, get timers() {return timers.size;},
    async advance(ms) {time+=ms;for (const timer of [...timers]) if (timer.until<=time) timer.finish();await flush();},
  };
}
const response = (result,status=200) => ({status,ok:status===200,async json() {return {jsonrpc:'2.0',id:1,result};}});
const blockBatchResponse = (requests) => ({status:200,ok:true,async json() {
  return requests.map(({id,params}) => ({jsonrpc:'2.0',id,result:rawBlock(Number(BigInt(params[0])))}));
}});
const hex = (n) => `0x${n.toString(16)}`;
const preferenceCycle = [...Array(10).fill('receipts'),'all_logs','transfer_logs'];
function receipt(n) {return {blockNumber:hex(n),blockHash:hash(n+1),transactionIndex:'0x0',transactionHash:transaction(n).hash,
  status:'0x1',gasUsed:'0x1234',effectiveGasPrice:'0x1',contractAddress:null,logs:[]};}

await test('runtime defaults and numeric defaults are explicit; invalid mode fails closed',async () => {
  assert.deepEqual(readRuntimeConfig({}),{mode:'a1',workHighWater:9000,workLowWater:7000,rpcConcurrency:1,rpcMinIntervalMs:500,rpc429CooldownMs:15000,
    liveMaxBlocks:3,receiptMaxReads:4,logRangeBlocks:10,workBurst:12,workerPollMs:1000});
  for (const value of ['dual','A1','','a2','a1 ']) assert.throws(() => readRuntimeConfig({INTELLIGENCE_RUNTIME_MODE:value}));
  let opened=false;
  await assert.rejects(start({INTELLIGENCE_RUNTIME_MODE:'dual'},{createPool:() => {opened=true;}}));
  assert.equal(opened,false);
});
await test('all A2 numbers enforce bounds and reject malformed numeric strings',async () => {
  for (const [key,min,max] of [['RPC_CONCURRENCY',1,4],['RPC_MIN_INTERVAL_MS',100,60000],['RPC_429_COOLDOWN_MS',1000,3600000],
    ['LIVE_MAX_BLOCKS',1,50],['RECEIPT_MAX_READS',1,64],['LOG_RANGE_BLOCKS',1,50],['WORKER_POLL_MS',100,3600000],['WORK_BURST',1,50]]) {
    const name=`INTELLIGENCE_A2_${key}`;
    readRuntimeConfig({[name]:String(min)});readRuntimeConfig({[name]:String(max)});
    for (const bad of [String(min-1),String(max+1),'1.5','+1',' 1','1ms','1e3','',1,'9007199254740993']) {
      assert.throws(() => readRuntimeConfig({[name]:bad}));
    }
  }
});
await test('watermarks use capacity bounds, default to 9000/7000 and reject malformed/equal/reversed pairs',async () => {
  const config=readRuntimeConfig({});assert.equal(config.workHighWater,9000);assert.equal(config.workLowWater,7000);
  readRuntimeConfig({INTELLIGENCE_A2_WORK_HIGH_WATER:'2',INTELLIGENCE_A2_WORK_LOW_WATER:'1'});
  readRuntimeConfig({INTELLIGENCE_A2_WORK_HIGH_WATER:String(MAX_WORK_ROWS-1),INTELLIGENCE_A2_WORK_LOW_WATER:String(MAX_WORK_ROWS-2)});
  for (const [high,low] of [['9000','9000'],['7000','9000'],[String(MAX_WORK_ROWS),'7000'],['9000','0'],['1','1']]) {
    assert.throws(() => readRuntimeConfig({INTELLIGENCE_A2_WORK_HIGH_WATER:high,INTELLIGENCE_A2_WORK_LOW_WATER:low}));
  }
  for (const name of ['INTELLIGENCE_A2_WORK_HIGH_WATER','INTELLIGENCE_A2_WORK_LOW_WATER']) {
    for (const value of ['1.5','+9000',' 9000','9000rows','9e3','',9000,'9007199254740993']) assert.throws(() => readRuntimeConfig({[name]:value}));
  }
});
await test('global start spacing applies across chain and receipt callers',async () => {
  const time=clock();const starts=[];
  const budget=createRpcBudget({maxConcurrency:4,minIntervalMs:500,now:time.now,sleepImpl:time.sleep});
  const rpc=budget.wrap({url:ARC_RPC_URL,async request(method) {starts.push([method,time.now()]);return 1;}});
  const tasks=[rpc.request('chain'),rpc.request('receipt'),rpc.request('logs')];await flush();
  assert.deepEqual(starts,[['chain',0]]);
  await time.advance(499);assert.equal(starts.length,1);
  await time.advance(1);assert.equal(starts.length,2);
  await time.advance(500);await Promise.all(tasks);await flush();
  assert.deepEqual(starts,[['chain',0],['receipt',500],['logs',1000]]);assert.equal(time.timers,0);
});
await test('HTTP 429 arms global cooldown before a queued different caller starts; single attempt',async () => {
  const time=clock();const starts=[];
  const budget=createRpcBudget({maxConcurrency:1,minIntervalMs:500,cooldownMs:15000,now:time.now,sleepImpl:time.sleep});
  const rpc=createA2RpcClient({budget,fetchImpl:async (url,init) => {
    assert.equal(url,ARC_RPC_URL);starts.push([JSON.parse(init.body).method,time.now()]);
    return response('0x1',starts.length===1 ? 429 : 200);
  }});
  const failed=assert.rejects(rpc.request('eth_getBlockReceipts',['0x1']),/required_read_unavailable/);
  const next=rpc.request('eth_blockNumber');await flush();await failed;
  assert.equal(starts.length,1);
  await time.advance(14999);assert.equal(starts.length,1);
  await time.advance(1);await next;await flush();
  assert.deepEqual(starts,[['eth_getBlockReceipts',0],['eth_blockNumber',15000]]);assert.equal(time.timers,0);
});
await test('a late 429 reschedules an existing pacing wait across callers',async () => {
  const time=clock();let release;const starts=[];
  const budget=createRpcBudget({maxConcurrency:4,minIntervalMs:500,cooldownMs:15000,now:time.now,sleepImpl:time.sleep});
  const rpc=createA2RpcClient({budget,fetchImpl:async (url,init) => {
    starts.push([JSON.parse(init.body).method,time.now()]);
    if (starts.length===1) return new Promise((resolve) => {release=resolve;});
    return response('0x1');
  }});
  const first=assert.rejects(rpc.request('eth_getBlockReceipts',['0x1']),/required_read_unavailable/);
  const next=rpc.request('eth_getLogs',[{}]);await flush();assert.equal(time.timers,1);
  await time.advance(400);release(response(null,429));await first;await flush();assert.equal(time.timers,1);
  await time.advance(500);assert.equal(starts.length,1);
  await time.advance(14499);assert.equal(starts.length,1);
  await time.advance(1);await next;await flush();assert.deepEqual(starts,[['eth_getBlockReceipts',0],['eth_getLogs',15400]]);
  assert.equal(time.timers,0);
});
await test('5xx, network and timeout errors do not arm cooldown or inner retries',async () => {
  for (const failure of [500,'network','timeout']) {
    const time=clock();const starts=[];
    const budget=createRpcBudget({maxConcurrency:1,minIntervalMs:500,now:time.now,sleepImpl:time.sleep});
    const rpc=createA2RpcClient({budget,fetchImpl:async () => {
      starts.push(time.now());
      if (starts.length===1) {
        if (failure==='network') throw new TypeError('private upstream body');
        if (failure==='timeout') throw new DOMException('private upstream body','AbortError');
        return response(null,failure);
      }
      return response('0x1');
    }});
    const failed=assert.rejects(rpc.request('eth_blockNumber'),/^Error: required_read_unavailable$/);
    const next=rpc.request('eth_chainId');await flush();await failed;
    assert.equal(starts.length,1);await time.advance(500);await next;
    assert.deepEqual(starts,[0,500]);
  }
});
for (const cooldown of [false,true]) await test(`abort during ${cooldown ? 'cooldown' : 'pacing'} cancels waits and all queued starts`,async () => {
  const time=clock();const controller=new AbortController();let calls=0;
  const budget=createRpcBudget({maxConcurrency:1,minIntervalMs:500,now:time.now,sleepImpl:time.sleep});
  const rpc=createA2RpcClient({budget,fetchImpl:async () => {calls++;return response('0x1',cooldown ? 429 : 200);}});
  const first=rpc.request('eth_blockNumber',[],{signal:controller.signal}).catch(() => {});
  const next=assert.rejects(rpc.request('eth_chainId',[],{signal:controller.signal}),/operation_aborted/);
  await flush();await first;assert.equal(calls,1);assert.equal(time.timers,1);
  controller.abort();await next;await flush();assert.equal(time.timers,0);assert.equal(budget.pending,0);
  await time.advance(20000);assert.equal(calls,1);
});
await test('active transport receives shutdown signal; concurrency never exceeds four',async () => {
  const controller=new AbortController();let signal;
  const budget=createRpcBudget({maxConcurrency:1});
  const rpc=createA2RpcClient({budget,fetchImpl:async (url,init) => new Promise((resolve,reject) => {
    signal=init.signal;signal.addEventListener('abort',() => reject(new DOMException('aborted','AbortError')),{once:true});
  })});
  const active=assert.rejects(rpc.request('eth_blockNumber',[],{signal:controller.signal}),/operation_aborted/);
  await flush();assert(signal);controller.abort();await active;await flush();assert.equal(signal.aborted,true);assert.equal(budget.active,0);
  const parallel=createRpcBudget({maxConcurrency:4});let peak=0;let activeCount=0;const releases=[];
  const tasks=Array.from({length:8},() => parallel.run(() => {activeCount++;peak=Math.max(peak,activeCount);
    return new Promise((resolve) => releases.push(() => {activeCount--;resolve();}));}));
  await flush();assert.equal(releases.length,4);releases.splice(0).forEach((release) => release());await flush();
  releases.splice(0).forEach((release) => release());await Promise.all(tasks);assert.equal(peak,4);
});
await test('aborting between budget dispatch and microtask prevents a transport start',async () => {
  const controller=new AbortController();let starts=0;
  const task=assert.rejects(createRpcBudget().run(() => {starts++;},{signal:controller.signal}),/operation_aborted/);
  controller.abort();await task;assert.equal(starts,0);
});
function localServer(options) {
  const server=createHttpServer(options);const listen=server.listen.bind(server);
  server.listen=(port,host,callback) => listen(0,'127.0.0.1',callback);
  return server;
}
async function get(server,path) {
  return new Promise((resolve,reject) => {
    const req=httpRequest({host:'127.0.0.1',port:server.address().port,path,agent:false},(res) => {
      let body='';res.on('data',(part) => {body+=part;});res.on('end',() => resolve({status:res.statusCode,body:JSON.parse(body)}));
    });req.on('error',reject);req.end();
  });
}
for (const mode of ['a1','a2_shadow']) await test(`real startup selects only ${mode}; health/read API survives and shutdown closes pool`,async () => {
  let a1=0;let a2=0;let ticks=0;let ends=0;let signal;const messages=[];
  const latest={window:'latest_bounded_chunk',generatedAt:'unchanged',indexing:{endBlock:99},coverage:{core:{complete:true}}};
  const handle=await start({INTELLIGENCE_RUNTIME_MODE:mode},{createPool:() => ({async end(){ends++;}}),migrate:async () => {},
    createRepository:() => ({health:async () => {},getLatest:async () => latest}),createHttpServer:localServer,log:(m) => messages.push(m),
    createIndexer:() => {a1++;return {async tick(){ticks++;return {status:'caught_up'};}};},
    createA2Runtime:({config}) => {a2++;assert.equal(config.mode,'a2_shadow');return {run(options) {signal=options.signal;
      return new Promise((resolve) => signal.addEventListener('abort',resolve,{once:true}));}};},
  });
  try {
    assert.equal(a1,mode==='a1' ? 1 : 0);assert.equal(a2,mode==='a2_shadow' ? 1 : 0);assert.equal(ticks,a1);
    assert.deepEqual(messages,[`Arc Intelligence runtime mode: ${mode}`]);
    assert.equal((await get(handle.server,'/health')).status,200);
    assert.deepEqual((await get(handle.server,'/v1/intelligence/latest')).body,latest);
    assert.equal((await get(handle.server,'/v1/intelligence/coverage')).status,200);
  } finally {await Promise.all([handle.stop(),handle.stop()]);}
  assert.equal(ends,1);if (signal) assert.equal(signal.aborted,true);assert.equal(handle.server.listening,false);
});
await test('A1 startup shutdown aborts active RPC transport without starting A2',async () => {
  let starts=0;let signal;
  const handle=await start({}, {createPool:() => ({async end(){}}),migrate:async () => {},createRepository:() => ({}),
    createHttpServer:localServer,log:() => {},createA2Runtime:() => {throw new Error('A2 must not start');},
    fetchImpl:async (url,init) => new Promise((resolve,reject) => {starts++;signal=init.signal;
      signal.addEventListener('abort',() => reject(new Error('operation_aborted')),{once:true});}),
    createIndexer:({rpc}) => ({async tick(){try {await rpc.request('eth_blockNumber');} catch {} return {status:'degraded'};}}),
  });
  await flush();assert.equal(starts,1);await handle.stop();assert.equal(signal.aborted,true);assert.equal(starts,1);
});
async function setup() {
  const pool=fixturePool();await migrate(pool);
  const foundation=createFoundationRepository(pool);await foundation.initializeChainLane();
  return {pool,foundation};
}
async function batchFollower(mutate=(payload) => payload) {
  const ctx=await setup();const calls=[];const writes=[];
  const persist=ctx.foundation.persistManifest.bind(ctx.foundation);
  ctx.foundation.persistManifest=async (identity,blocks) => {writes.push(blocks.map((b) => b.block_number));return persist(identity,blocks);};
  const rpc=createA2RpcClient({budget:createRpcBudget(),fetchImpl:async (url,init) => {
    assert.equal(url,ARC_RPC_URL);assert.equal(init.method,'POST');const body=JSON.parse(init.body);calls.push(body);
    let depth=0;for (const {text} of ctx.pool.calls) {if (text==='BEGIN') depth++;if (['COMMIT','ROLLBACK'].includes(text)) depth--;}
    assert.equal(depth,0,'No DB transaction spans a batch transport');
    if (!Array.isArray(body)) return response(body.method==='eth_chainId' ? hex(5042) : hex(111));
    assert.equal(body.length,10);assert.deepEqual(body.map((r) => r.id),Array.from({length:10},(_,i) => i+1));
    assert(body.every((r,i) => r.method==='eth_getBlockByNumber' && r.params[0]===hex(100+i) && r.params[1]===true));
    const payload=body.map(({id,params}) => ({jsonrpc:'2.0',id,result:rawBlock(Number(BigInt(params[0])))}));
    return {status:200,ok:true,async json(){return mutate(payload);}};
  }});
  return {...ctx,calls,writes,rpc,follower:createChainFollower({repository:ctx.foundation,rpc,maxBlocks:10})};
}
await test('ten contiguous blocks use one HTTP batch and one atomic multi-block persist; chain/head behavior unchanged',async () => {
  const ctx=await batchFollower();const first=await ctx.follower.tick();
  assert.equal(first.status,'caught_up');assert.equal(first.persistedBlocks,10);assert.equal(first.observedHead,111);assert.equal(first.targetHead,109);
  assert.equal(ctx.calls.filter(Array.isArray).length,1);assert.deepEqual(ctx.writes,[Array.from({length:10},(_,i) => 100+i)]);
  assert.deepEqual([...ctx.pool.store.blocks.keys()],ctx.writes[0]);assert.equal(ctx.pool.store.transactions.size,10);
  assert([...ctx.pool.store.blocks.values()].every((b) => b.transactions_complete && !b.core_complete && !b.receipt_complete));
  const lane=await ctx.foundation.getLane();assert.equal(lane.processed_through,109);assert.equal(lane.contiguous_complete_through,109);assert.equal(lane.observed_head,111);
  assert.equal((await ctx.follower.tick()).persistedBlocks,0);
  assert.equal(ctx.calls.filter((c) => c.method==='eth_chainId').length,1);assert.equal(ctx.calls.filter((c) => c.method==='eth_blockNumber').length,2);
  assert.equal(ctx.calls.filter(Array.isArray).length,1);
  console.log('CHAIN_BATCH_FIXTURE: 10 blocks = 1 block HTTP transport = 1 persistManifest call; separate chainId/head reads');
});
await test('shuffled batch responses are reassociated by id before normalization and persistence',async () => {
  const ctx=await batchFollower((payload) => payload.reverse());assert.equal((await ctx.follower.tick()).persistedBlocks,10);
  assert.deepEqual(ctx.writes,[Array.from({length:10},(_,i) => 100+i)]);
});
for (const [name,mutate] of [
  ['non-array body',() => ({result:[]})],
  ['missing response id',(p) => {delete p[4].id;return p;}],
  ['duplicate response id',(p) => {p[4].id=p[3].id;return p;}],
  ['unknown response id',(p) => {p[4].id=999;return p;}],
  ['wrong id type',(p) => {p[4].id=String(p[4].id);return p;}],
  ['missing response',(p) => p.slice(0,-1)],
  ['JSON-RPC error',(p) => {p[4]={jsonrpc:'2.0',id:5,error:{code:-32000,message:'arbitrary upstream body'}};return p;}],
  ['null result',(p) => {p[4].result=null;return p;}],
  ['missing result',(p) => {delete p[4].result;return p;}],
  ['primitive result',(p) => {p[4].result=42;return p;}],
  ['wrong block number',(p) => {p[4].result.number=hex(200);return p;}],
  ['duplicate block number',(p) => {p[4].result=p[3].result;return p;}],
  ['malformed manifest',(p) => {p[4].result.hash='0x12';return p;}],
  ['malformed transaction set',(p) => {p[4].result.transactions[0].transactionIndex='0x1';return p;}],
]) await test(`invalid block batch (${name}) persists zero blocks and performs no fallback`,async () => {
  const ctx=await batchFollower(mutate);const before=structuredClone(ctx.pool.store.transactions);
  assert.deepEqual(await ctx.follower.tick(),{status:'retrying',error:'block_unavailable',persistedBlocks:0});
  assert.equal(ctx.pool.store.blocks.size,0);assert.deepEqual(ctx.pool.store.transactions,before);assert.equal(ctx.pool.store.coverage.size,0);
  assert.equal(ctx.writes.length,0);assert.equal(ctx.calls.filter(Array.isArray).length,1);
  assert(!ctx.calls.some((c) => c.method==='eth_getBlockByNumber'));
  const lane=await ctx.foundation.getLane();assert.equal(lane.processed_through,null);assert.equal(lane.contiguous_complete_through,null);
});
for (const index of [0,5]) await test(`batch parent mismatch at index ${index} halts continuity without persisting a prefix`,async () => {
  const ctx=await batchFollower((p) => {p[index].result.parentHash=hash(999);return p;});
  const result=await ctx.follower.tick();assert.equal(result.status,'continuity_error');assert.equal(result.persistedBlocks,0);
  assert.equal(ctx.pool.store.blocks.size,0);assert.equal(ctx.pool.store.transactions.size,0);assert.equal(ctx.pool.store.coverage.size,0);
  assert.equal(ctx.calls.filter(Array.isArray).length,1);assert.equal(ctx.writes.length,index===0 ? 1 : 0);
  const lane=await ctx.foundation.getLane();assert.equal(lane.status,'continuity_error');assert.equal(lane.current_error_code,'checkpoint_parent_hash_mismatch');
  assert.equal(lane.processed_through,null);assert.equal((await ctx.follower.tick()).status,'continuity_error');assert.equal(ctx.calls.length,3);
});
await test('one ten-item batch consumes one shared budget opportunity and honors pacing/concurrency',async () => {
  const time=clock();const starts=[];let release;
  const budget=createRpcBudget({maxConcurrency:1,minIntervalMs:500,now:time.now,sleepImpl:time.sleep});
  const rpc=createA2RpcClient({budget,fetchImpl:async (url,init) => {
    const body=JSON.parse(init.body);starts.push({body,time:time.now()});assert.equal(budget.active,1);
    if (Array.isArray(body)) return new Promise((resolve) => {release=() => resolve(blockBatchResponse(body));});
    return response(hex(111));
  }});
  const batch=rpc.requestBlockRange(100,109);const head=rpc.request('eth_blockNumber');await flush();
  assert.equal(starts.length,1);assert.equal(budget.active,1);assert.equal(budget.pending,1);
  release();assert.equal((await batch).length,10);await flush();await time.advance(499);assert.equal(starts.length,1);
  await time.advance(1);await head;await flush();assert.deepEqual(starts.map((s) => s.time),[0,500]);
  assert.equal(time.timers,0);assert.equal(budget.active,0);
});
await test('batch 429 arms shared cooldown before another batch or single caller; one attempt only',async () => {
  const time=clock();const starts=[];const budget=createRpcBudget({maxConcurrency:1,minIntervalMs:500,now:time.now,sleepImpl:time.sleep});
  const rpc=createA2RpcClient({budget,fetchImpl:async (url,init) => {
    const body=JSON.parse(init.body);starts.push({body,time:time.now()});
    if (starts.length===1) return response(null,429);
    return Array.isArray(body) ? blockBatchResponse(body) : response(hex(111));
  }});
  const failed=assert.rejects(rpc.requestBlockRange(100,109),/required_read_unavailable/);
  const second=rpc.requestBlockRange(100,109);const head=rpc.request('eth_blockNumber');await flush();await failed;
  await time.advance(14999);assert.equal(starts.length,1);
  await time.advance(1);await second;assert.equal(starts.length,2);assert.equal(starts[1].time,15000);
  await time.advance(500);await head;await flush();assert.deepEqual(starts.map((s) => s.time),[0,15000,15500]);assert.equal(time.timers,0);
});
await test('batch bounds use MAX_WINDOW_SIZE; invalid ranges start no transport',async () => {
  let calls=0;const rpc=createA2RpcClient({budget:createRpcBudget(),fetchImpl:async (url,init) => {calls++;return blockBatchResponse(JSON.parse(init.body));}});
  for (const [start,end] of [[-1,1],[1,0],[1,51],[1.5,2],[0,Infinity]]) assert.throws(() => rpc.requestBlockRange(start,end),/invalid_block_batch/);
  assert.equal(calls,0);assert.equal((await rpc.requestBlockRange(100,149)).length,50);assert.equal(calls,1);
});
await test('abort before, during and after batch response persists nothing; active transport gets shutdown signal',async () => {
  const before=await batchFollower();const stopped=new AbortController();stopped.abort();
  assert.equal((await before.follower.tick({signal:stopped.signal})).status,'aborted');assert.equal(before.calls.length,0);assert.equal(before.pool.store.blocks.size,0);
  for (const afterResponse of [false,true]) {
    const ctx=await setup();const controller=new AbortController();let activeSignal;let starts=0;let begun;
    const started=new Promise((resolve) => {begun=resolve;});
    const rpc=createA2RpcClient({budget:createRpcBudget(),fetchImpl:async (url,init) => {
      const body=JSON.parse(init.body);if (!Array.isArray(body)) return response(body.method==='eth_chainId' ? hex(5042) : hex(111));
      starts++;activeSignal=init.signal;
      if (afterResponse) {controller.abort();return blockBatchResponse(body);}
      begun();return new Promise((resolve,reject) => init.signal.addEventListener('abort',() => reject(new Error('aborted')),{once:true}));
    }});
    const follower=createChainFollower({repository:ctx.foundation,rpc,maxBlocks:10});const pending=follower.tick({signal:controller.signal});
    if (!afterResponse) {await started;controller.abort();}
    const result=await pending;assert.equal(result.status,'aborted');assert.equal(result.persistedBlocks,0);assert.equal(starts,1);assert.equal(activeSignal.aborted,true);
    assert.equal(ctx.pool.store.blocks.size,0);assert.equal(ctx.pool.store.transactions.size,0);assert.equal((await ctx.foundation.getLane()).processed_through,null);
  }
});
await test('queued batch cancellation during cooldown prevents transport and releases pacing timer',async () => {
  const time=clock();const budget=createRpcBudget({maxConcurrency:1,now:time.now,sleepImpl:time.sleep});let calls=0;const controller=new AbortController();
  const rpc=createA2RpcClient({budget,fetchImpl:async () => {calls++;return response(null,429);}});
  await assert.rejects(rpc.requestBlockRange(100,109),/required_read_unavailable/);
  const queued=assert.rejects(rpc.requestBlockRange(100,109,{signal:controller.signal}),/operation_aborted/);await flush();
  assert.equal(time.timers,1);controller.abort();await queued;await flush();assert.equal(time.timers,0);assert.equal(budget.pending,0);
  await time.advance(20000);assert.equal(calls,1);
});
await test('batch timeout, HTTP 5xx and network failure are sanitized and never retried internally',async () => {
  for (const failure of ['timeout','5xx','network']) {
    let calls=0;const rpc=createA2RpcClient({budget:createRpcBudget(),timeoutMs:5,fetchImpl:async (url,init) => {
      calls++;if (failure==='5xx') return response(null,503);if (failure==='network') throw new TypeError('arbitrary provider body');
      return new Promise((resolve,reject) => init.signal.addEventListener('abort',() => reject(new Error('timeout')),{once:true}));
    }});
    await assert.rejects(rpc.requestBlockRange(100,109),/^Error: required_read_unavailable$/);assert.equal(calls,1);
  }
});
await test('work pressure counts every non-complete state, including failed/conflict, with exact receipt lane scope',async () => {
  const {pool,foundation}=await setup();const repository=createReceiptRepository(pool);await repository.initialize();
  const states=['pending','retrying','leased','failed','persistent_partial','complete'];
  for (const [i,state] of states.entries()) {
    const row=await foundation.enqueue(RECEIPT_IDENTITY,{component:'receipts',logicalKey:hash(i+100),startBlock:100+i,endBlock:100+i});
    pool.store.work.get(row.id).state=state;
  }
  await foundation.enqueue(CHAIN_IDENTITY,{component:'manifest',logicalKey:'other_lane',startBlock:100,endBlock:100});
  await foundation.initializeLane({...RECEIPT_IDENTITY,definitionVersion:'other-version'});
  await foundation.enqueue({...RECEIPT_IDENTITY,definitionVersion:'other-version'},{component:'receipts',logicalKey:'other_version',startBlock:100,endBlock:100});
  assert.deepEqual(await repository.workPressure(),{outstanding:5});
  assert.deepEqual(await repository.workCounts(),{pending:1,retrying:1,leased:1});
  const query=pool.calls.find((c) => c.text.includes('receipts:work_pressure'));
  assert(query.text.includes("state <> 'complete'"));assert.deepEqual(query.values,[5042,'receipts_logs','canonical_receipts_logs',RECEIPT_IDENTITY.epoch,RECEIPT_IDENTITY.definitionVersion]);
});
await test('real A2 cycle uses shared paced RPC, persists before scheduling, recovers recent crash gap only',async () => {
  const {pool,foundation}=await setup();const a1=structuredClone(pool.store.a1);
  await foundation.persistManifest(CHAIN_IDENTITY,[block(100)]);
  await foundation.persistManifest(CHAIN_IDENTITY,[block(995)]);
  let time=0;const calls=[];const config={...readRuntimeConfig({}),mode:'a2_shadow'};
  const runtime=createA2Runtime({pool,config,now:() => time,sleepImpl:async (ms) => {time+=ms;},fetchImpl:async (url,init) => {
    assert.equal(url,ARC_RPC_URL);const body=JSON.parse(init.body);const {method,params}=body;calls.push({method:Array.isArray(body) ? 'block_batch' : method,time});
    let depth=0;for (const call of pool.calls) {if (call.text==='BEGIN') depth++;if (['COMMIT','ROLLBACK'].includes(call.text)) depth--;}
    assert.equal(depth,0,'RPC never runs inside a DB transaction');
    if (Array.isArray(body)) return blockBatchResponse(body);
    if (method==='eth_chainId') return response(hex(5042));if (method==='eth_blockNumber') return response(hex(1002));
    if (method==='eth_getBlockReceipts') {
      assert(pool.store.blocks.has(998));assert(pool.store.work.size>0);
      return response([receipt(Number(BigInt(params[0])))]);
    }
    if (method==='eth_getLogs') return response([]);
    throw new Error('unexpected RPC');
  }});
  const first=await runtime.cycle();
  assert.equal(first.chain.persistedBlocks,3);assert.equal(first.chain.targetHead,1000);assert.equal(first.chain.observedHead,1002);
  assert.deepEqual(first.scheduledBlocks,[995,996,997,998]);assert.equal(first.work.length,7);
  assert(first.work.slice(0,-1).every((result) => result.status==='complete'));assert.equal(first.work.at(-1).status,'idle');
  assert.equal(first.work.filter((r) => r.component==='all_logs')[0].jobCount,4);
  assert.equal(first.work.filter((r) => r.component==='transfer_logs')[0].jobCount,4);assert.equal(first.continueImmediately,true);
  assert(![...pool.store.work.values()].some((w) => w.start_block===100));assert(pool.store.work.size<=12);
  assert.deepEqual(calls.slice(0,4).map((c) => c.method),['eth_chainId','eth_blockNumber','block_batch','eth_getBlockReceipts']);
  await runtime.cycle();await runtime.cycle();
  for (let i=1;i<calls.length;i++) assert(calls[i].time-calls[i-1].time>=500);
  assert.equal(pool.store.blocks.get(995).core_complete,false);assert.deepEqual(pool.store.a1,a1);
  assert(!pool.calls.some((c) => /(?:INSERT INTO|UPDATE|DELETE FROM) arc_intelligence_(?:state|chunks|latest|runs)\b/.test(c.text)));
  const query=pool.calls.find((c) => c.text.includes('receipts:recent'));
  assert.deepEqual(query.values,[5042,949,998,50,...Object.values(RECEIPT_IDENTITY)]);
  assert(query.text.includes('LIMIT $4'));assert.equal((query.text.match(/NOT EXISTS/g) ?? []).length,3);
  assert.equal(pool.store.blocks.get(995).receipt_complete,true);
});
await test('recent recovery excludes certified/conflicted/transaction-incomplete blocks and validates tail bounds',async () => {
  const {pool,foundation}=await setup();await foundation.persistManifest(CHAIN_IDENTITY,[block(100),block(101),block(102),block(103)]);
  Object.assign(pool.store.blocks.get(101),{receipt_complete:true,all_log_reconciliation_complete:true,transfer_log_reconciliation_complete:true});
  pool.store.blocks.get(102).receipt_evidence_conflict=true;pool.store.blocks.get(103).transactions_complete=false;
  const receipts=createReceiptRepository(pool);assert.deepEqual(await receipts.recentIncompleteBlocks(103,4),[100]);
  assert.deepEqual(await receipts.recentIncompleteBlocks(103,2),[]);
  for (const invalid of [0,51,1.5]) await assert.rejects(receipts.recentIncompleteBlocks(103,invalid));
});
await test('runtime schedules only ten missing jobs from a 50-block recent tail',async () => {
  const {pool,foundation}=await setup();const older=Array.from({length:40},(_,i) => block(100+i));
  await foundation.persistManifest(CHAIN_IDENTITY,older);
  const repository=createReceiptRepository(pool);await repository.initialize();
  for (const b of older) await foundation.enqueue(RECEIPT_IDENTITY,{component:'receipts',logicalKey:b.block_hash,
    startBlock:b.block_number,endBlock:b.block_number,blockHash:b.block_hash});
  const previous=new Set([...pool.store.work.values()].map((w) => w.id));const calls=[];let time=0;
  const runtime=createA2Runtime({pool,config:{...readRuntimeConfig({}),liveMaxBlocks:10,workBurst:1},now:() => time,
    sleepImpl:async (ms) => {time+=ms;pool.advance(ms);},fetchImpl:async (url,init) => {
      const body=JSON.parse(init.body);const respond=({id,method,params}) => ({jsonrpc:'2.0',id,result:method==='eth_getBlockByNumber'
        ? rawBlock(Number(BigInt(params[0]))) : []});
      if (Array.isArray(body)) {calls.push('block_batch');return {status:200,ok:true,async json(){return body.map(respond);}};}
      const {method,params}=body;calls.push(method);
      return response(method==='eth_chainId' ? hex(5042) : method==='eth_blockNumber' ? hex(151)
        : method==='eth_getBlockReceipts' ? [receipt(Number(BigInt(params[0])))] : []);
    }});
  const result=await runtime.cycle();assert.deepEqual(result.scheduledBlocks,Array.from({length:10},(_,i) => 140+i));
  assert.equal(calls.filter((m) => m==='block_batch').length,1);
  const created=[...pool.store.work.values()].filter((w) => !previous.has(w.id) && w.component==='receipts');
  assert.deepEqual(created.map((w) => w.start_block).sort((a,b) => a-b),Array.from({length:10},(_,i) => 140+i));
  const query=pool.calls.find((c) => c.text.includes('receipts:recent'));
  assert.deepEqual(query.values,[5042,100,149,50,...Object.values(RECEIPT_IDENTITY)]);
});
await test('overlapping runtime cycles skip; abort active runtime stops queued requests and poll sleep',async () => {
  const {pool}=await setup();const controller=new AbortController();const time=clock();let starts=0;let release;
  const runtime=createA2Runtime({pool,config:readRuntimeConfig({}),now:time.now,sleepImpl:time.sleep,fetchImpl:async (url,init) => {
    starts++;return new Promise((resolve,reject) => {release=resolve;init.signal.addEventListener('abort',() => reject(new Error('aborted')),{once:true});});
  }});
  const run=runtime.run({signal:controller.signal});
  for (let i=0;i<50 && !release;i++) await flush();assert(release);
  assert.deepEqual(await runtime.cycle({signal:controller.signal}),{skipped:true});
  controller.abort();await run;await flush();assert.equal(starts,1);assert.equal(time.timers,0);
  assert.equal((await runtime.cycle({signal:controller.signal})).status,'aborted');
});
await test('A2 runtime poll wait is AbortSignal aware after follower failure',async () => {
  const pool=fixturePool();pool.fail('a2:anchor');
  const time=clock();const controller=new AbortController();const logs=[];
  const runtime=createA2Runtime({pool,config:readRuntimeConfig({}),now:time.now,sleepImpl:time.sleep,log:(m) => logs.push(m),
    fetchImpl:() => {throw new Error('RPC must not run without an anchor');}});
  const run=runtime.run({signal:controller.signal});
  for (let i=0;i<50 && !time.timers;i++) await flush();
  assert.equal(time.timers,1);assert.deepEqual(logs,[]); // follower stores its sanitized failure; no raw exception is logged
  controller.abort();await run;assert.equal(time.timers,0);
});
await test('cycle database failure enters cancellable idle poll without arbitrary exception logging',async () => {
  const {pool,foundation}=await setup();await foundation.persistManifest(CHAIN_IDENTITY,[block(100)]);
  pool.fail('receipts:recent');const time=clock();const controller=new AbortController();const logs=[];
  // This head leaves the existing manifest unchanged, isolating the recovery query failure.
  const runtime=createA2Runtime({pool,config:readRuntimeConfig({}),now:time.now,sleepImpl:time.sleep,log:(m) => logs.push(m),
    fetchImpl:async (url,init) => response(JSON.parse(init.body).method==='eth_chainId' ? hex(5042) : hex(102))});
  const run=runtime.run({signal:controller.signal});
  for (let i=0;i<50 && !time.timers;i++) await flush();
  await time.advance(500);
  await flush();
  assert.deepEqual(logs,[]);assert.equal(time.timers,1); // failures are visible through bounded periodic summaries, not per-cycle logs
  controller.abort();await run;assert.equal(time.timers,0);
});
await test('live bootstrap alone jumps; repeated head jumps and restart follow exact persisted tail; chainId caches once',async () => {
  const {pool,foundation}=await setup();let head=1000;let chainReads=0;let headReads=0;const reads=[];
  const rpc=fixtureChainRpc({url:ARC_RPC_URL,async request(method,params) {
    if (method==='eth_chainId') {chainReads++;return hex(5042);}
    if (method==='eth_blockNumber') {headReads++;return hex(head);}
    reads.push(Number(BigInt(params[0])));return rawBlock(reads.at(-1));
  }});
  const follower=createChainFollower({repository:foundation,rpc,maxBlocks:3,mode:'live'});
  assert.equal((await follower.tick()).status,'caught_up');assert.deepEqual(reads,[996,997,998]);
  head=1012;assert.equal((await follower.tick()).status,'indexing');assert.equal((await follower.tick()).status,'indexing');
  assert.deepEqual(reads,[996,997,998,999,1000,1001,1002,1003,1004]);assert.equal(chainReads,1);assert.equal(headReads,3);
  const restarted=createChainFollower({repository:foundation,rpc,maxBlocks:3,mode:'live'});
  head=1200;assert.equal((await restarted.tick()).status,'indexing');assert.deepEqual(reads.slice(-3),[1005,1006,1007]);
  assert.equal(chainReads,2);assert.equal((await foundation.getLane()).contiguous_complete_through,null);
  assert(!pool.store.blocks.has(100)); // old anchor-to-bootstrap gap stays untouched
});
await test('explicit processedThrough=100 target=110 advances 101..103 then 104..106; failed read resumes exact next block',async () => {
  const {pool,foundation}=await setup();await foundation.persistManifest(CHAIN_IDENTITY,[block(100)]);
  const reads=[];let fail=false;
  const rpc=fixtureChainRpc({url:ARC_RPC_URL,async request(method,params) {
    if (method==='eth_chainId') return hex(5042);if (method==='eth_blockNumber') return hex(112);
    const n=Number(BigInt(params[0]));reads.push(n);if (fail && n===108) throw new Error('transient');return rawBlock(n);
  }});
  const follower=createChainFollower({repository:foundation,rpc,maxBlocks:3,mode:'live'});
  assert.equal((await follower.tick()).status,'indexing');assert.deepEqual(reads,[101,102,103]);
  await follower.tick();assert.deepEqual(reads.slice(-3),[104,105,106]);
  fail=true;const failed=await follower.tick();assert.equal(failed.status,'retrying');assert.equal(failed.persistedBlocks,0);
  assert.deepEqual(reads.slice(-3),[107,108,109]);assert(!pool.store.blocks.has(107));assert.equal((await foundation.getLane()).processed_through,106);
  fail=false;assert.equal((await follower.tick()).status,'indexing');assert.deepEqual(reads.slice(-3),[107,108,109]);
  assert.equal((await follower.tick()).status,'caught_up');assert.equal(reads.at(-1),110);
});
await test('unavailable or noncanonical chain never reaches head/block reads; only success is cached',async () => {
  const {pool,foundation}=await setup();let checks=0;let headReads=0;
  const rpc=fixtureChainRpc({url:ARC_RPC_URL,async request(method,params) {
    if (method==='eth_chainId') {checks++;if (checks===1) return hex(1);if (checks===2) throw new Error('private body');return hex(5042);}
    if (method==='eth_blockNumber') {headReads++;return hex(1000);}
    return rawBlock(Number(BigInt(params[0])));
  }});
  const follower=createChainFollower({repository:foundation,rpc,maxBlocks:3,mode:'live'});
  for (let i=0;i<2;i++) {assert.equal((await follower.tick()).status,'retrying');assert.equal(pool.store.blocks.size,0);assert.equal(headReads,0);}
  assert.equal((await follower.tick()).persistedBlocks,3);await follower.tick();assert.equal(checks,3);assert.equal(headReads,2);
});
await test('work burst is bounded with an exact 10/1/1 worker-call preference cycle',async () => {
  const preferences=[];const worker={async runOnce({preferredComponent}) {preferences.push(preferredComponent);return {status:'complete'};}};
  const defaultBurst=createWorkBurst({worker});assert.equal((await defaultBurst()).length,12);
  assert.deepEqual(preferences,preferenceCycle);
  assert.equal((await createWorkBurst({worker,maxCalls:50})()).length,50);
  for (const maxCalls of [0,51,1.5]) assert.throws(() => createWorkBurst({worker,maxCalls}));
});
await test('small and single-call bursts carry preferences; endless receipt backlog cannot starve either log component',async () => {
  for (const maxCalls of [1,5]) {
    const preferences=[];
    // All components stay ready; receipt work never runs out to force a log fallback.
    const burst=createWorkBurst({maxCalls,worker:{async runOnce({preferredComponent}) {
      preferences.push(preferredComponent);return {status:'complete',component:preferredComponent};
    }}});
    for (let i=0;i<36;i++) assert.equal((await burst()).length,maxCalls);
    assert.deepEqual(preferences,Array.from({length:36*maxCalls},(_,i) => preferenceCycle[i%12]));
    assert.equal(preferences.filter((c) => c==='all_logs').length,3*maxCalls);
    assert.equal(preferences.filter((c) => c==='transfer_logs').length,3*maxCalls);
  }
});
await test('each ten-job all_logs or transfer_logs batch consumes only one preference position',async () => {
  const preferences=[];const burst=createWorkBurst({worker:{async runOnce({preferredComponent}) {
    preferences.push(preferredComponent);const jobCount=preferredComponent==='receipts' ? 1 : 10;
    return {status:'complete',component:preferredComponent,jobCount,completedJobs:jobCount};
  }}});
  const results=[...await burst(),...await burst()];
  assert.deepEqual(preferences,[...preferenceCycle,...preferenceCycle]);
  for (const i of [10,11,22,23]) assert.equal(results[i].completedJobs,10);
  assert.equal(results[12].component,'receipts');assert.equal(results.length,24);
});
await test('retrying ends the burst immediately without starting a second worker job',async () => {
  let calls=0;
  const burst=createWorkBurst({worker:{async runOnce() {
    calls++;
    return {status:calls===1 ? 'retrying' : 'complete'};
  }}});
  assert.deepEqual(await burst(),[{status:'retrying'}]);assert.equal(calls,1);
});
await test('A2.5H shared frontier flush runs exactly once after normal, early stop, abort and thrown worker',async () => {
  for (const status of ['complete','idle','retrying','continuity_error','persistent_partial','stale_lease','aborted']) {
    const events=[];const burst=createWorkBurst({maxCalls:3,frontier:async () => events.push('flush'),
      worker:{async runOnce(options) {assert.equal(options.deferFrontier,true);events.push('work');return {status};}}});
    const result=await burst();assert.equal(result.length,status==='complete' ? 3 : 1);
    assert.equal(events.at(-1),'flush');assert.equal(events.filter((e) => e==='flush').length,1);
  }
  const controller=new AbortController();let flushed=0,calls=0;
  const burst=createWorkBurst({frontier:async () => flushed++,worker:{async runOnce() {calls++;controller.abort();return {status:'complete'};}}});
  assert.equal((await burst({signal:controller.signal})).length,1);assert.equal(calls,1);assert.equal(flushed,1);
  assert.deepEqual(await burst({signal:controller.signal}),[]);assert.equal(flushed,2);
  const throwing=createWorkBurst({frontier:async () => flushed++,worker:{async runOnce() {throw new Error('worker failure');}}});
  await assert.rejects(throwing(),/worker failure/);assert.equal(flushed,3);
});
await test('A2.5H frontier flush errors are sanitized and stop successful runtime continuation',async () => {
  for (const error of ['private DB body','lane_continuity_stopped','checkpoint_parent_hash_mismatch']) {
    const burst=createWorkBurst({maxCalls:1,frontier:async () => {throw new Error(error);},
      worker:{async runOnce() {return {status:'complete'};}}});
    const result=await burst();assert.equal(result.length,2);assert.equal(result[0].status,'complete');
    assert.deepEqual(result[1],{status:error==='private DB body' ? 'retrying' : 'continuity_error',
      error:error==='private DB body' ? 'required_read_unavailable' : 'checkpoint_parent_hash_mismatch',frontierFlush:true});
  }
  const {pool,foundation}=await setup();await foundation.persistManifest(CHAIN_IDENTITY,[block(100)]);
  const repository=createReceiptRepository(pool);await repository.initialize();await repository.scheduleBlock(100);
  const connect=pool.connect.bind(pool);let receiptCommit=false,failOnce=true;
  pool.connect=async () => {
    const c=await connect(),query=c.query.bind(c);let writes=false;
    c.query=async (sql,...args) => {
      if (sql.includes('receipts:certify')) writes=true;
      if (receiptCommit && failOnce && sql.includes('receipts:advance')) {failOnce=false;throw new Error('private DB body');}
      const result=await query(sql,...args);
      if (writes && sql==='COMMIT') receiptCommit=true;
      return result;
    };return c;
  };
  let time=0;
  const runtime=createA2Runtime({pool,config:{...readRuntimeConfig({}),workBurst:1},now:() => time,
    sleepImpl:async (ms) => {time+=ms;pool.advance(ms);},fetchImpl:async (url,init) => {
      const body=JSON.parse(init.body);
      if (Array.isArray(body)) return blockBatchResponse(body);
      if (body.method==='eth_chainId') return response(hex(5042));
      if (body.method==='eth_blockNumber') return response(hex(200));
      assert.equal(body.method,'eth_getBlockReceipts');return response([receipt(Number(BigInt(body.params[0])))]);
    }});
  const result=await runtime.cycle();assert.equal(result.chain.status,'indexing');
  assert.equal(result.work[0].status,'complete');assert.equal(result.work.at(-1).status,'retrying');
  assert.equal(result.work.at(-1).frontierFlush,true);assert.equal(result.continueImmediately,false);
  assert.equal(pool.store.blocks.get(100).receipt_complete,true);
});
await test('A2.5H actual restarted idle runtime repairs durable deferred frontier with no worker RPC',async () => {
  const {pool,foundation}=await setup();await foundation.persistManifest(CHAIN_IDENTITY,[block(100,0)]);
  const repository=createReceiptRepository(pool);await repository.initialize();await repository.scheduleBlock(100);
  const w=createReceiptWorker({repository,rpc:createRpcBudget().wrap({url:ARC_RPC_URL,async request(){return [];}})});
  for (const preferredComponent of ['receipts','all_logs','transfer_logs'])
    assert.equal((await w.runOnce({preferredComponent,deferFrontier:true})).status,'complete');
  assert.equal((await repository.getLane()).contiguous_complete_through,null);
  const before=structuredClone(pool.store.a1);let time=0;const methods=[];
  const runtime=createA2Runtime({pool,config:readRuntimeConfig({}),now:() => time,
    sleepImpl:async (ms) => {time+=ms;pool.advance(ms);},fetchImpl:async (url,init) => {
      const body=JSON.parse(init.body);methods.push(body.method);
      if (body.method==='eth_chainId') return response(hex(5042));
      assert.equal(body.method,'eth_blockNumber');return response(hex(102));
    }});
  const result=await runtime.cycle();assert.equal(result.work[0].status,'idle');
  assert.equal((await repository.getLane()).contiguous_complete_through,100);
  assert.deepEqual(methods,['eth_chainId','eth_blockNumber']);assert.deepEqual(pool.store.a1,before);
});
await test('real runtime yields after 429; first post-cooldown RPC refreshes head before another worker RPC',async () => {
  const {pool,foundation}=await setup();await foundation.persistManifest(CHAIN_IDENTITY,[block(100,0),block(101,0)]);
  const repository=createReceiptRepository(pool);await repository.initialize();
  for (const n of [100,101]) await repository.scheduleBlock(n);
  // Certify empty-block receipts through the real worker so both log components are ready.
  const preparer=createReceiptWorker({repository,rpc:createRpcBudget().wrap({url:ARC_RPC_URL,async request(){return [];}})});
  for (let i=0;i<2;i++) assert.equal((await preparer.runOnce({preferredComponent:'receipts'})).status,'complete');
  const claimsBefore=pool.calls.filter((c) => c.text.includes('a2:claim')).length;
  const controller=new AbortController();let time=0;let rateLimited=false;let headRefreshes=0;const calls=[];
  const runtime=createA2Runtime({pool,config:readRuntimeConfig({}),now:() => time,
    sleepImpl:async (ms) => {time+=ms;pool.advance(ms);},fetchImpl:async (url,init) => {
      assert.equal(url,ARC_RPC_URL);const {method}=JSON.parse(init.body);calls.push({method,time});
      if (method==='eth_chainId') return response(hex(5042));
      if (method==='eth_blockNumber') {
        headRefreshes++;
        if (rateLimited) {
          const claims=pool.calls.filter((c) => c.text.includes('a2:claim')).length-claimsBefore;
          assert.equal(claims,1,'No second worker job was claimed in the retrying burst');
          const retry=[...pool.store.work.values()].find((w) => w.state==='retrying');
          assert(retry);assert.equal(retry.attempts,1);assert(retry.not_before<=1000000+time);
          assert.equal(retry.reason_code,'required_read_unavailable');
          assert.equal([...pool.store.work.values()].filter((w) => w.state==='retrying').length,2);
          assert.equal([...pool.store.work.values()].filter((w) => w.state==='pending').length,2);
        }
        return response(hex(103));
      }
      assert.equal(method,'eth_getLogs');
      if (!rateLimited) {rateLimited=true;return response(null,429);}
      controller.abort();return response([]);
    }});
  await runtime.run({signal:controller.signal});
  assert.equal(headRefreshes,2);
  assert.deepEqual(calls.map((c) => c.method),['eth_chainId','eth_blockNumber','eth_getLogs','eth_blockNumber','eth_getLogs']);
  assert.equal(calls[3].time,calls[2].time+15000,'The first RPC opportunity after cooldown belongs to chain tracking');
  assert(calls[4].time>=calls[3].time+500);
  assert([...pool.store.work.values()].some((w) => w.state==='retrying'));
});
await test('idle, continuity, conflict and stale lease stop a burst; abort interrupts before another job',async () => {
  for (const status of ['idle','continuity_error','persistent_partial','stale_lease','aborted']) {
    let calls=0;const burst=createWorkBurst({worker:{async runOnce(){calls++;return {status};}}});
    assert.equal((await burst()).length,1);assert.equal(calls,1);
  }
  let calls=0;const controller=new AbortController();
  const burst=createWorkBurst({maxCalls:50,worker:{async runOnce(){calls++;if (calls===3) controller.abort();return {status:'complete'};}}});
  assert.equal((await burst({signal:controller.signal})).length,3);assert.equal(calls,3);
  assert.deepEqual(await burst({signal:controller.signal}),[]);
});
await test('real worker/repository honors receipt priority and both log quotas despite a continuing receipt backlog',async () => {
  const {pool,foundation}=await setup();await foundation.persistManifest(CHAIN_IDENTITY,Array.from({length:50},(_,i) => block(100+i,0)));
  const repository=createReceiptRepository(pool);await repository.initialize();for (let n=100;n<150;n++) await repository.scheduleBlock(n);
  const rpc=createRpcBudget().wrap({url:ARC_RPC_URL,async request() {return [];}});
  const worker=createReceiptWorker({repository,rpc});
  for (let i=0;i<20;i++) assert.equal((await worker.runOnce({preferredComponent:'receipts'})).status,'complete');
  const from=pool.calls.length;const burst=createWorkBurst({worker});const results=[...await burst(),...await burst()];
  assert.deepEqual(results.map((r) => r.component),[...preferenceCycle,...preferenceCycle]);
  assert(results.every((r) => r.status==='complete'));
  assert.equal([...pool.store.work.values()].filter((w) => w.component==='receipts' && w.state==='pending').length,10);
  assert(results.filter((r) => r.component!=='receipts').every((r) => r.jobCount===10 && r.completedJobs===10));
  assert.equal(results.filter((r) => r.component==='receipts').length,20);
  assert([...pool.store.work.values()].filter((w) => w.component==='receipts').every((w) => w.start_block===w.end_block));
  const claims=pool.calls.slice(from).filter((c) => c.text.includes('a2:claim'));assert(claims.every((c) => c.text.includes('FOR UPDATE SKIP LOCKED')));
  assert.equal(claims.length,24);
  assert.deepEqual(claims.map((c) => c.values[7]),results.map((r) => r.component));
});
await test('10/1/1 also drains ready receipts and ten-job log batches without creating any work',async () => {
  const {pool,foundation}=await setup();await foundation.persistManifest(CHAIN_IDENTITY,Array.from({length:50},(_,i) => block(100+i,0)));
  const repository=createReceiptRepository(pool);await repository.initialize();for (let n=100;n<150;n++) await repository.scheduleBlock(n);
  const preparer=createReceiptWorker({repository,rpc:createRpcBudget().wrap({url:ARC_RPC_URL,async request(){return [];}})});
  for (let i=0;i<20;i++) assert.equal((await preparer.runOnce({preferredComponent:'receipts'})).status,'complete');
  const rows=pool.store.work.size;let time=0;
  const runtime=createA2Runtime({pool,config:{...readRuntimeConfig({}),workHighWater:50,workLowWater:10},now:() => time,
    sleepImpl:async (ms) => {time+=ms;pool.advance(ms);},fetchImpl:async (url,init) => {
      assert.equal(url,ARC_RPC_URL);assert.equal(JSON.parse(init.body).method,'eth_getLogs');return response([]);
    }});
  const result=await runtime.cycle();assert.equal(result.backpressure,'drain');assert.equal(result.chain.status,'paused');
  assert.deepEqual(result.work.map((r) => r.component),preferenceCycle);assert(result.work.every((r) => r.status==='complete'));
  assert(result.work.slice(10).every((r) => r.jobCount===10 && r.completedJobs===10));
  assert.equal(pool.store.work.size,rows);assert.equal(result.outstanding,40);
  assert.deepEqual(result.scheduledBlocks,[]);assert.deepEqual(result.deferredBlocks,[]);
});
await test('empty preferred all_logs and transfer_logs slots fall back to ready single-block receipts',async () => {
  const {pool,foundation}=await setup();await foundation.persistManifest(CHAIN_IDENTITY,[block(100,0),block(101,0)]);
  const repository=createReceiptRepository(pool);await repository.initialize();for (const n of [100,101]) await repository.scheduleBlock(n);
  const worker=createReceiptWorker({repository,rpc:createRpcBudget().wrap({url:ARC_RPC_URL,async request(){return [];}})});
  for (const preferredComponent of ['all_logs','transfer_logs']) {
    const result=await worker.runOnce({preferredComponent,enqueueFollowups:false});
    assert.equal(result.status,'complete');assert.equal(result.component,'receipts');
  }
  assert.equal(pool.store.work.size,2);
  assert([...pool.store.work.values()].every((w) => w.state==='complete' && w.start_block===w.end_block));
});
await test('preferred claim falls back, respects not_before, excludes terminal work and preserves old callers',async () => {
  const {pool,foundation}=await setup();const repository=createReceiptRepository(pool);await repository.initialize();
  const enqueue=(component,n) => foundation.enqueue(RECEIPT_IDENTITY,{component,logicalKey:hash(n),startBlock:n,endBlock:n,blockHash:hash(n)});
  const oldLog=await enqueue('all_logs',100);const r=await enqueue('receipts',101);await enqueue('transfer_logs',102);
  const first=await repository.claim('test',180000,{preferredComponent:'receipts'});assert.equal(first.id,r.id);
  await foundation.finishWork(first,{state:'retrying',reason:'required_read_unavailable',retryMs:1000});
  const fallback=await repository.claim('test',180000,{preferredComponent:'receipts'});assert.equal(fallback.id,oldLog.id);
  await foundation.finishWork(fallback);const oldCaller=await repository.claim('test');assert.equal(oldCaller.component,'transfer_logs');
  await foundation.finishWork(oldCaller);assert.equal(await repository.claim('test'),null);
  pool.advance(1001);const ready=await repository.claim('test');assert.equal(ready.id,r.id);assert.equal(ready.attempts,2);
  await assert.rejects(repository.claim('test',180000,{preferredComponent:'unknown'}));
});
await test('real cooperative run completes 12 jobs before one idle poll; refreshes chain between every bounded burst',async () => {
  const {pool,foundation}=await setup();await foundation.persistManifest(CHAIN_IDENTITY,Array.from({length:4},(_,i) => block(100+i,0)));
  const controller=new AbortController();let time=0;let chainIdReads=0;const frontiers=[];const polls=[];
  const completed=() => [...pool.store.work.values()].filter((w) => w.state==='complete').length;
  const runtime=createA2Runtime({pool,config:{...readRuntimeConfig({}),workBurst:3},now:() => time,
    sleepImpl:async (ms) => {
      time+=ms;pool.advance(ms);
      if (ms===1000) {polls.push(completed());controller.abort();throw new Error('operation_aborted');}
    },fetchImpl:async (url,init) => {
      const {method}=JSON.parse(init.body);
      if (method==='eth_chainId') {chainIdReads++;return response(hex(5042));}
      if (method==='eth_blockNumber') {frontiers.push(completed());return response(hex(105));}
      assert(['eth_getBlockReceipts','eth_getLogs'].includes(method));return response([]);
    }});
  await runtime.run({signal:controller.signal});
  assert.deepEqual(frontiers,[0,3,12]);assert.deepEqual(polls,[12]);assert.equal(chainIdReads,1);
  assert.equal(completed(),12);assert(!pool.calls.some((c) => c.text.includes('receipts:work_counts')));
  console.log('THROUGHPUT_FIXTURE: 12 completed jobs, 2 bounded productive bursts, 3 head refreshes, 1 idle poll');
});
await test('stopped receipt lane does not schedule, claim or spin; reports no immediate continuation',async () => {
  const {pool,foundation}=await setup();await foundation.persistManifest(CHAIN_IDENTITY,[block(100,0)]);
  const repository=createReceiptRepository(pool);await repository.initialize();await repository.scheduleBlock(100);
  await foundation.setLaneStatus(RECEIPT_IDENTITY,'continuity_error','checkpoint_parent_hash_mismatch');
  let time=0;
  const runtime=createA2Runtime({pool,config:readRuntimeConfig({}),now:() => time,sleepImpl:async (ms) => {time+=ms;},fetchImpl:async (url,init) => {
    return response(JSON.parse(init.body).method==='eth_chainId' ? hex(5042) : hex(102));
  }});
  const result=await runtime.cycle();assert.deepEqual(result.work,[{status:'continuity_error'}]);assert.equal(result.continueImmediately,false);
  assert.deepEqual(result.scheduledBlocks,[]);assert(!pool.calls.some((c) => c.text.includes('a2:claim')));
});
await test('summary logs sanitized numbers at most once per minute and counts query uses bounded ready-state scope',async () => {
  const {pool,foundation}=await setup();await foundation.persistManifest(CHAIN_IDENTITY,[block(100,0)]);
  const controller=new AbortController();let time=0;const logs=[];
  const runtime=createA2Runtime({pool,config:readRuntimeConfig({}),now:() => time,log:(text) => logs.push({time,text}),
    sleepImpl:async (ms) => {time+=ms;pool.advance(ms);if (logs.length===2) {controller.abort();throw new Error('operation_aborted');}},
    fetchImpl:async (url,init) => {
      const {method}=JSON.parse(init.body);return response(method==='eth_chainId' ? hex(5042) : method==='eth_blockNumber' ? hex(102) : []);
    }});
  await runtime.run({signal:controller.signal});assert.equal(logs.length,2);assert(logs[0].time>=60000);assert(logs[1].time-logs[0].time>=60000);
  for (const {text} of logs) assert.equal(text,'Arc Intelligence A2: head=102 chain=100 receipt=100 outstanding=0 pending=0 retrying=0 leased=0 backpressure=normal');
  const counts=pool.calls.filter((c) => c.text.includes('receipts:work_counts'));assert.equal(counts.length,2);
  assert(counts.every((c) => c.text.includes("state IN ('pending','retrying','leased')") && c.values.length===5));
});
await test('periodic summary read failure prints only a fixed sanitized code',async () => {
  const {pool,foundation}=await setup();await foundation.persistManifest(CHAIN_IDENTITY,[block(100,0)]);
  pool.fail('receipts:work_counts');const controller=new AbortController();let time=0;const logs=[];
  const runtime=createA2Runtime({pool,config:readRuntimeConfig({}),now:() => time,log:(text) => logs.push(text),
    sleepImpl:async (ms) => {time+=ms;pool.advance(ms);if (logs.length) {controller.abort();throw new Error('operation_aborted');}},
    fetchImpl:async (url,init) => {const {method}=JSON.parse(init.body);return response(method==='eth_chainId' ? hex(5042) : method==='eth_blockNumber' ? hex(102) : []);}});
  await runtime.run({signal:controller.signal});assert.deepEqual(logs,['Arc Intelligence A2: status=required_read_unavailable']);
});
await test('drain hysteresis creates zero chain/work rows; receipts complete without follow-ups; low watermark resumes chain first',async () => {
  const {pool,foundation}=await setup();await foundation.persistManifest(CHAIN_IDENTITY,Array.from({length:5},(_,i) => block(100+i)));
  await foundation.persistManifest(CHAIN_IDENTITY,[block(995)]);
  const repository=createReceiptRepository(pool);await repository.initialize();for (let n=100;n<105;n++) await repository.scheduleBlock(n);
  let time=0;const calls=[];const config={...readRuntimeConfig({}),workHighWater:5,workLowWater:2,workBurst:1,liveMaxBlocks:1};
  const runtime=createA2Runtime({pool,config,now:() => time,sleepImpl:async (ms) => {time+=ms;pool.advance(ms);},fetchImpl:async (url,init) => {
    const body=JSON.parse(init.body);const {method,params}=body;calls.push(Array.isArray(body) ? 'block_batch' : method);
    if (Array.isArray(body)) return blockBatchResponse(body);
    if (method==='eth_chainId') return response(hex(5042));if (method==='eth_blockNumber') return response(hex(1002));
    if (method==='eth_getBlockReceipts') return response([receipt(Number(BigInt(params[0])))]);
    return response([]);
  }});
  const blocks=pool.store.blocks.size;const work=pool.store.work.size;
  for (let i=0;i<3;i++) {
    const from=pool.calls.length;const result=await runtime.cycle();
    assert.equal(result.backpressure,'drain');assert.equal(result.chain.status,'paused');assert.equal(result.work[0].status,'complete');
    assert.equal(result.continueImmediately,true);assert.equal(result.outstanding,4-i);
    assert.deepEqual(result.scheduledBlocks,[]);assert.deepEqual(result.deferredBlocks,[]);
    assert(!pool.calls.slice(from).some((c) => /a2:block|a2:enqueue|receipts:recent|receipts:deferred/.test(c.text)));
    assert.equal(pool.store.blocks.size,blocks);assert.equal(pool.store.work.size,work);
    assert.equal(pool.store.blocks.get(100+i).receipt_complete,true);
    assert.equal([...pool.store.work.values()].find((w) => w.start_block===100+i).state,'complete');
  }
  assert.deepEqual(calls,['eth_getBlockReceipts','eth_getBlockReceipts','eth_getBlockReceipts']);
  assert.equal(pool.store.receipts.size,3);assert.equal((await repository.workPressure()).outstanding,2);
  const resume=await runtime.cycle();assert.equal(resume.chain.persistedBlocks,1);
  assert.deepEqual(calls.slice(3,6),['eth_chainId','eth_blockNumber','block_batch']);
  assert(pool.store.blocks.has(996));assert(!pool.store.blocks.has(105));
  assert.deepEqual(resume.deferredBlocks,[100,101]); // recovery returns to drain as soon as high watermark is reached
  assert.equal([...pool.store.work.values()].filter((w) => ['all_logs','transfer_logs'].includes(w.component)).length,4);
});
await test('fresh runtime above high watermark enters drain immediately and productive bursts drain without idle poll',async () => {
  const {pool,foundation}=await setup();await foundation.persistManifest(CHAIN_IDENTITY,Array.from({length:4},(_,i) => block(100+i)));
  const repository=createReceiptRepository(pool);await repository.initialize();for (let n=100;n<104;n++) await repository.scheduleBlock(n);
  const controller=new AbortController();let time=0;let bulkCalls=0;let headCalls=0;const polls=[];
  const runtime=createA2Runtime({pool,config:{...readRuntimeConfig({}),workHighWater:4,workLowWater:1,workBurst:1},now:() => time,
    sleepImpl:async (ms) => {time+=ms;pool.advance(ms);if (ms===1000) polls.push(ms);},fetchImpl:async (url,init) => {
      const {method,params}=JSON.parse(init.body);
      if (method==='eth_chainId') {controller.abort();return response(hex(5042));}
      if (method==='eth_blockNumber') {headCalls++;return response(hex(105));}
      assert.equal(method,'eth_getBlockReceipts');bulkCalls++;return response([receipt(Number(BigInt(params[0])))]);
    }});
  await runtime.run({signal:controller.signal});assert.equal(bulkCalls,3);assert.equal(headCalls,0);assert.deepEqual(polls,[]);
  assert.equal(pool.store.work.size,4);assert.equal((await repository.workPressure()).outstanding,1);
});
await test('deferred recovery pages at most 50 durable blocks, reaches old blocks, is idempotent and preserves existing certificates',async () => {
  const {pool,foundation}=await setup();await foundation.persistManifest(CHAIN_IDENTITY,Array.from({length:50},(_,i) => block(100+i,0)));
  await foundation.persistManifest(CHAIN_IDENTITY,[block(150,0)]);await foundation.persistManifest(CHAIN_IDENTITY,[block(1000,0)]);
  const repository=createReceiptRepository(pool);await repository.initialize();for (let n=100;n<=150;n++) await repository.scheduleBlock(n);
  const worker=createReceiptWorker({repository,rpc:createRpcBudget().wrap({url:ARC_RPC_URL,async request(){return [];}})});
  for (let i=0;i<51;i++) assert.equal((await worker.runOnce({enqueueFollowups:false})).status,'complete');
  assert.equal(pool.store.work.size,51);assert.equal((await repository.workPressure()).outstanding,0);
  const recent=await repository.recentIncompleteBlocks(1000);assert(!recent.some((n) => n<=150));
  const first=await repository.deferredFollowupBlocks();assert.equal(first.scanned,50);assert.equal(first.blocks.length,50);assert.equal(first.nextBlock,150);
  for (const n of first.blocks) assert.equal((await repository.recoverDeferredFollowups(n)).length,2);
  assert.deepEqual((await repository.deferredFollowupBlocks()).blocks,[]);
  assert.deepEqual(await repository.recoverDeferredFollowups(100),[]);
  const second=await repository.deferredFollowupBlocks(first.nextBlock);assert.equal(second.scanned,2);assert.deepEqual(second.blocks,[150]);assert.equal(second.nextBlock,0);
  assert.equal((await repository.recoverDeferredFollowups(150)).length,2);assert.equal(pool.store.work.size,153);
  const keys=[...pool.store.work.values()].map((w) => `${w.component}:${w.logical_key}`);assert.equal(new Set(keys).size,keys.length);
  assert.equal((await worker.runOnce({preferredComponent:'all_logs'})).status,'complete');
  const certificate=structuredClone(pool.store.reconciliation);assert.deepEqual(await repository.recoverDeferredFollowups(100),[]);
  assert.deepEqual(pool.store.reconciliation,certificate);
  for (const bad of [0,51,1.5]) await assert.rejects(repository.deferredFollowupBlocks(0,bad));
});
await test('deferred recovery cursor wraps so previously incomplete old receipts are eventually revisited',async () => {
  const {pool,foundation}=await setup();await foundation.persistManifest(CHAIN_IDENTITY,Array.from({length:50},(_,i) => block(100+i,0)));
  await foundation.persistManifest(CHAIN_IDENTITY,[block(1000,0)]);
  const repository=createReceiptRepository(pool);await repository.initialize();
  const first=await repository.deferredFollowupBlocks();assert.deepEqual(first,{blocks:[],scanned:50,nextBlock:150});
  await repository.scheduleBlock(100);
  const worker=createReceiptWorker({repository,rpc:createRpcBudget().wrap({url:ARC_RPC_URL,async request(){return [];}})});
  assert.equal((await worker.runOnce({enqueueFollowups:false})).status,'complete');
  assert.equal(pool.store.blocks.get(100).receipt_complete,true);assert.equal(pool.store.work.size,1);
  const tail=await repository.deferredFollowupBlocks(first.nextBlock);assert.deepEqual(tail,{blocks:[],scanned:1,nextBlock:0});
  const wrapped=await repository.deferredFollowupBlocks(tail.nextBlock);assert.deepEqual(wrapped.blocks,[100]);
  assert.equal((await repository.recoverDeferredFollowups(100)).length,2);
  assert.deepEqual(await repository.recoverDeferredFollowups(100),[]);assert.equal(pool.store.work.size,3);
});
await test('deferred recovery excludes conflicts and incomplete facts and creates only the missing component',async () => {
  const {pool,foundation}=await setup();await foundation.persistManifest(CHAIN_IDENTITY,Array.from({length:5},(_,i) => block(100+i,0)));
  const repository=createReceiptRepository(pool);await repository.initialize();for (let n=100;n<105;n++) await repository.scheduleBlock(n);
  const worker=createReceiptWorker({repository,rpc:createRpcBudget().wrap({url:ARC_RPC_URL,async request(){return [];}})});
  for (let i=0;i<5;i++) assert.equal((await worker.runOnce({enqueueFollowups:false})).status,'complete');
  pool.store.blocks.get(101).receipt_evidence_conflict=true;
  pool.store.blocks.get(102).transactions_complete=false;
  pool.store.blocks.get(103).receipt_complete=false;
  await foundation.enqueue(RECEIPT_IDENTITY,{component:'all_logs',logicalKey:hash(105),startBlock:104,endBlock:104,blockHash:hash(105)});
  const page=await repository.deferredFollowupBlocks();assert.deepEqual(page.blocks,[100,104]);
  assert.deepEqual(await repository.recoverDeferredFollowups(101),[]);
  assert.deepEqual(await repository.recoverDeferredFollowups(103),[]);
  const jobs=await repository.recoverDeferredFollowups(104);assert.equal(jobs.length,1);assert.equal(jobs[0].component,'transfer_logs');
  assert.deepEqual(await repository.recoverDeferredFollowups(104),[]);
  assert.equal([...pool.store.work.values()].filter((w) => w.start_block===104 && w.component==='all_logs').length,1);
});
await test('high-water drain keeps retrying durable and gives post-cooldown RPC to worker while chain is paused',async () => {
  const {pool,foundation}=await setup();await foundation.persistManifest(CHAIN_IDENTITY,[block(100,0),block(101,0)]);
  const repository=createReceiptRepository(pool);await repository.initialize();for (const n of [100,101]) await repository.scheduleBlock(n);
  const preparer=createReceiptWorker({repository,rpc:createRpcBudget().wrap({url:ARC_RPC_URL,async request(){return [];}})});
  for (let i=0;i<2;i++) await preparer.runOnce({preferredComponent:'receipts'});
  const controller=new AbortController();let time=0;const calls=[];
  const runtime=createA2Runtime({pool,config:{...readRuntimeConfig({}),workHighWater:4,workLowWater:1},now:() => time,
    sleepImpl:async (ms) => {time+=ms;pool.advance(ms);},fetchImpl:async (url,init) => {
      const method=JSON.parse(init.body).method;calls.push({method,time});assert.equal(method,'eth_getLogs');
      if (calls.length===1) return response(null,429);controller.abort();return response([]);
    }});
  const size=pool.store.work.size;const from=pool.calls.length;const first=await runtime.cycle({signal:controller.signal});
  assert.equal(first.backpressure,'drain');assert.equal(first.work.length,1);assert.equal(first.work[0].status,'retrying');assert.equal(first.continueImmediately,false);
  const retry=[...pool.store.work.values()].find((w) => w.state==='retrying');assert(retry);assert.equal(retry.attempts,1);assert(retry.not_before>1000000);
  await runtime.cycle({signal:controller.signal});assert.deepEqual(calls,[{method:'eth_getLogs',time:0},{method:'eth_getLogs',time:15000}]);
  assert.equal(pool.store.work.size,size);assert(!pool.calls.slice(from).some((c) => /a2:enqueue|receipts:recent|receipts:deferred|a2:block/.test(c.text)));
});
await test('two ten-job log batches drain existing work with zero enqueue and resume chain only below low water',async () => {
  const {pool,foundation}=await setup();await foundation.persistManifest(CHAIN_IDENTITY,Array.from({length:10},(_,i) => block(100+i,0)));
  const repository=createReceiptRepository(pool);await repository.initialize();for (let n=100;n<110;n++) await repository.scheduleBlock(n);
  const preparer=createReceiptWorker({repository,rpc:createRpcBudget().wrap({url:ARC_RPC_URL,async request(){return [];}})});
  for (let i=0;i<10;i++) assert.equal((await preparer.runOnce({preferredComponent:'receipts'})).status,'complete');
  assert.equal((await repository.workPressure()).outstanding,20);const size=pool.store.work.size;
  let time=0;const calls=[];const runtime=createA2Runtime({pool,config:{...readRuntimeConfig({}),workHighWater:20,workLowWater:5,workBurst:1},
    now:() => time,sleepImpl:async (ms) => {time+=ms;pool.advance(ms);},fetchImpl:async (url,init) => {
      const {method,params}=JSON.parse(init.body);calls.push({method,params});
      if (method==='eth_chainId') return response(hex(5042));if (method==='eth_blockNumber') return response(hex(111));
      assert.equal(method,'eth_getLogs');return response([]);
    }});
  const from=pool.calls.length;
  for (const outstanding of [10,0]) {
    const result=await runtime.cycle();assert.equal(result.backpressure,'drain');assert.equal(result.chain.status,'paused');
    assert.equal(result.work[0].jobCount,10);assert.equal(result.work[0].completedJobs,10);assert.equal(result.outstanding,outstanding);
    assert(result.continueImmediately);assert.equal(pool.store.work.size,size);assert.equal(pool.store.blocks.size,10);
  }
  assert(!pool.calls.slice(from).some((c) => /a2:enqueue|receipts:recent|receipts:deferred|a2:block/.test(c.text)));
  assert.deepEqual(calls.map((c) => c.method),['eth_getLogs','eth_getLogs']);
  assert(!calls[0].params[0].topics);assert.deepEqual(calls[1].params[0].topics,[TRANSFER_TOPIC]);
  for (const call of calls) assert.deepEqual([call.params[0].fromBlock,call.params[0].toBlock],[hex(100),hex(109)]);
  const normal=await runtime.cycle();assert.equal(normal.backpressure,'normal');assert.equal(normal.chain.status,'caught_up');
  assert.deepEqual(calls.slice(2).map((c) => c.method),['eth_chainId','eth_blockNumber']);assert.equal(pool.store.work.size,size);
});
await test('capacity race is explicit, pauses producers and sleeps safely while global capacity remains occupied',async () => {
  const {pool,foundation}=await setup();await foundation.persistManifest(CHAIN_IDENTITY,[block(100,0)]);
  pool.fail('a2:enqueue','work_capacity_reached');let time=0;const logs=[];const methods=[];
  const runtime=createA2Runtime({pool,config:readRuntimeConfig({}),now:() => time,log:(s) => logs.push(s),sleepImpl:async (ms) => {time+=ms;},
    fetchImpl:async (url,init) => {const method=JSON.parse(init.body).method;methods.push(method);return response(method==='eth_chainId' ? hex(5042) : hex(102));}});
  const result=await runtime.cycle();assert.equal(result.error,'work_capacity_reached');assert.equal(result.backpressure,'drain');assert.equal(result.continueImmediately,false);
  assert.equal(pool.store.work.size,0);assert.deepEqual(logs,['Arc Intelligence A2: backpressure=drain error=work_capacity_reached']);
  for (let i=0;i<MAX_WORK_ROWS;i++) pool.store.work.set(String(i+1),{id:String(i+1),chain_id:5042,lane:'other',scope_id:'other',epoch:'other',definition_version:'other',state:'failed'});
  const from=pool.calls.length;const rpcCount=methods.length;const next=await runtime.cycle();
  assert.equal(next.backpressure,'drain');assert.equal(next.chain.status,'paused');assert.equal(next.continueImmediately,false);
  assert.equal(methods.length,rpcCount);assert(!pool.calls.slice(from).some((c) => /a2:enqueue|receipts:recent|receipts:deferred|a2:block/.test(c.text)));
});
await test('pressure read failure fails closed before any chain or worker RPC',async () => {
  const {pool}=await setup();pool.fail('receipts:work_pressure');let calls=0;
  const runtime=createA2Runtime({pool,config:readRuntimeConfig({}),fetchImpl:async () => {calls++;return response([]);}});
  await assert.rejects(runtime.cycle());assert.equal(calls,0);
});
await test('drain summary reports exact outstanding including terminal partial work without chain RPC',async () => {
  const {pool,foundation}=await setup();await foundation.persistManifest(CHAIN_IDENTITY,[block(100,0)]);
  await foundation.setLaneStatus(CHAIN_IDENTITY,'caught_up',null,102);const repository=createReceiptRepository(pool);await repository.initialize();
  for (let i=0;i<2;i++) {
    await foundation.enqueue(RECEIPT_IDENTITY,{component:'receipts',logicalKey:hash(100+i),startBlock:100+i,endBlock:100+i});
    const lease=await repository.claim('setup');await foundation.finishWork(lease,{state:'persistent_partial',reason:'unsupported_scope'});
  }
  const controller=new AbortController();let time=0;const logs=[];let rpcCalls=0;
  const runtime=createA2Runtime({pool,config:{...readRuntimeConfig({}),workHighWater:2,workLowWater:1},now:() => time,log:(s) => logs.push(s),
    sleepImpl:async (ms) => {time+=ms;if (logs.length) {controller.abort();throw new Error('operation_aborted');}},fetchImpl:async () => {rpcCalls++;return response([]);}});
  await runtime.run({signal:controller.signal});assert.equal(rpcCalls,0);
  assert.deepEqual(logs,['Arc Intelligence A2: head=102 chain=100 receipt=unavailable outstanding=2 pending=0 retrying=0 leased=0 backpressure=drain']);
});
await test('001/002/003 immutable; main consumes mode; SIGTERM and SIGINT share guarded shutdown',async () => {
  for (const [name,expected] of [['001_init','c38b78a7e0e1c47e1de5f1400f1502f53f4ce8eeb20fe5d8f328fb59d1992ff0'],
    ['002_a2_foundation','308c747d1b1f1c3fa3cace6daba11434eb5a1ba3709701b657ec1a93c3f43cd5'],
    ['003_a2_receipts','f6016e7417e72efaf83e698a76b62f10d8c3d97a3bf9fd10aea174d4520219de']]) {
    assert.equal(createHash('sha256').update(await readFile(new URL(`../server/arc-intelligence/sql/${name}.sql`,import.meta.url))).digest('hex'),expected);
  }
  const main=await readFile(new URL('../server/arc-intelligence/main.js',import.meta.url),'utf8');
  assert(main.includes('readRuntimeConfig(env)'));assert(main.includes("runtimeConfig.mode === 'a1'"));
  assert(main.includes("process.once('SIGTERM', shutdown)"));assert(main.includes("process.once('SIGINT', shutdown)"));
});
console.log(`A2_RUNTIME_VERIFIER: PASS (${count} deterministic scenarios; fake clock/RPC/SQL and real localhost HTTP; no live RPC or Postgres)`);
