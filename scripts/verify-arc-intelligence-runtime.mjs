import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { readRuntimeConfig } from '../server/arc-intelligence/runtime-config.js';
import { createRpcBudget } from '../server/arc-intelligence/rpc-budget.js';
import { createA2RpcClient } from '../server/arc-intelligence/a2-rpc.js';
import { createA2Runtime } from '../server/arc-intelligence/a2-runtime.js';
import { start } from '../server/arc-intelligence/main.js';
import { createHttpServer } from '../server/arc-intelligence/http.js';
import { createFoundationRepository, CHAIN_IDENTITY } from '../server/arc-intelligence/foundation.js';
import { createReceiptRepository } from '../server/arc-intelligence/receipt-repository.js';
import { migrate } from '../server/arc-intelligence/migrate.js';
import { ARC_RPC_URL } from '../api/_lib/arc-intelligence/rpc.js';
import { fixturePool, block, rawBlock, hash, transaction } from './fixtures/arc-intelligence-a2.mjs';
let count = 0;
async function test(name, work) { await work(); console.log(`PASS ${name}`); count++; }
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
const hex = (n) => `0x${n.toString(16)}`;
function receipt(n) {return {blockNumber:hex(n),blockHash:hash(n+1),transactionIndex:'0x0',transactionHash:transaction(n).hash,
  status:'0x1',gasUsed:'0x1234',effectiveGasPrice:'0x1',contractAddress:null,logs:[]};}

await test('runtime defaults and numeric defaults are explicit; invalid mode fails closed',async () => {
  assert.deepEqual(readRuntimeConfig({}),{mode:'a1',rpcConcurrency:1,rpcMinIntervalMs:500,rpc429CooldownMs:15000,
    liveMaxBlocks:3,receiptMaxReads:4,workerPollMs:1000});
  for (const value of ['dual','A1','','a2','a1 ']) assert.throws(() => readRuntimeConfig({INTELLIGENCE_RUNTIME_MODE:value}));
  let opened=false;
  await assert.rejects(start({INTELLIGENCE_RUNTIME_MODE:'dual'},{createPool:() => {opened=true;}}));
  assert.equal(opened,false);
});
await test('all A2 numbers enforce bounds and reject malformed numeric strings',async () => {
  for (const [key,min,max] of [['RPC_CONCURRENCY',1,4],['RPC_MIN_INTERVAL_MS',100,60000],['RPC_429_COOLDOWN_MS',1000,3600000],
    ['LIVE_MAX_BLOCKS',1,50],['RECEIPT_MAX_READS',1,64],['WORKER_POLL_MS',100,3600000]]) {
    const name=`INTELLIGENCE_A2_${key}`;
    readRuntimeConfig({[name]:String(min)});readRuntimeConfig({[name]:String(max)});
    for (const bad of [String(min-1),String(max+1),'1.5','+1',' 1','1ms','1e3','',1,'9007199254740993']) {
      assert.throws(() => readRuntimeConfig({[name]:bad}));
    }
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
await test('real A2 cycle uses shared paced RPC, persists before scheduling, recovers recent crash gap only',async () => {
  const {pool,foundation}=await setup();const a1=structuredClone(pool.store.a1);
  await foundation.persistManifest(CHAIN_IDENTITY,[block(100)]);
  await foundation.persistManifest(CHAIN_IDENTITY,[block(995)]);
  let time=0;const calls=[];const config={...readRuntimeConfig({}),mode:'a2_shadow'};
  const runtime=createA2Runtime({pool,config,now:() => time,sleepImpl:async (ms) => {time+=ms;},fetchImpl:async (url,init) => {
    assert.equal(url,ARC_RPC_URL);const {method,params}=JSON.parse(init.body);calls.push({method,time});
    let depth=0;for (const call of pool.calls) {if (call.text==='BEGIN') depth++;if (['COMMIT','ROLLBACK'].includes(call.text)) depth--;}
    assert.equal(depth,0,'RPC never runs inside a DB transaction');
    if (method==='eth_chainId') return response(hex(5042));if (method==='eth_blockNumber') return response(hex(1002));
    if (method==='eth_getBlockByNumber') return response(rawBlock(Number(BigInt(params[0]))));
    if (method==='eth_getBlockReceipts') {
      assert(pool.store.blocks.has(1000));assert(pool.store.work.size>0);
      return response([receipt(Number(BigInt(params[0])))]);
    }
    if (method==='eth_getLogs') return response([]);
    throw new Error('unexpected RPC');
  }});
  const first=await runtime.cycle();
  assert.equal(first.chain.persistedBlocks,3);assert.equal(first.chain.targetHead,1000);assert.equal(first.chain.observedHead,1002);
  assert.deepEqual(first.scheduledBlocks,[995,998,999,1000]);assert.equal(first.receipts.status,'complete');
  assert(![...pool.store.work.values()].some((w) => w.start_block===100));assert(pool.store.work.size<=12);
  assert.deepEqual(calls.slice(0,6).map((c) => c.method),['eth_chainId','eth_blockNumber','eth_getBlockByNumber','eth_getBlockByNumber','eth_getBlockByNumber','eth_getBlockReceipts']);
  await runtime.cycle();await runtime.cycle();
  for (let i=1;i<calls.length;i++) assert(calls[i].time-calls[i-1].time>=500);
  assert.equal(pool.store.blocks.get(995).core_complete,false);assert.deepEqual(pool.store.a1,a1);
  assert(!pool.calls.some((c) => /(?:INSERT INTO|UPDATE|DELETE FROM) arc_intelligence_(?:state|chunks|latest|runs)\b/.test(c.text)));
  const query=pool.calls.find((c) => c.text.includes('receipts:recent'));
  assert.deepEqual(query.values,[5042,951,1000,50]);assert(query.text.includes('LIMIT $4'));
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
await test('cycle database failure logs only a stable code and enters cancellable poll wait',async () => {
  const {pool,foundation}=await setup();await foundation.persistManifest(CHAIN_IDENTITY,[block(100)]);
  pool.fail('receipts:recent');const time=clock();const controller=new AbortController();const logs=[];
  // This head leaves the existing manifest unchanged, isolating the recovery query failure.
  const runtime=createA2Runtime({pool,config:readRuntimeConfig({}),now:time.now,sleepImpl:time.sleep,log:(m) => logs.push(m),
    fetchImpl:async (url,init) => response(JSON.parse(init.body).method==='eth_chainId' ? hex(5042) : hex(102))});
  const run=runtime.run({signal:controller.signal});
  for (let i=0;i<50 && !time.timers;i++) await flush();
  await time.advance(500);
  for (let i=0;i<50 && !logs.length;i++) await flush();
  assert.deepEqual(logs,['Arc Intelligence A2 runtime: required_read_unavailable']);assert.equal(time.timers,1);
  controller.abort();await run;assert.equal(time.timers,0);
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
