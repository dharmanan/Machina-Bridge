import { setTimeout as sleep } from 'node:timers/promises';
import { randomUUID } from 'node:crypto';
import { CHAIN_IDENTITY, createFoundationRepository, position } from './foundation.js';
import { createChainFollower } from './chain-lane.js';
import { createReceiptRepository } from './receipt-repository.js';
import { createReceiptWorker } from './receipt-lane.js';
import { createRpcBudget } from './rpc-budget.js';
import { createA2RpcClient } from './a2-rpc.js';
import { createMetricRepository } from './metric-repository.js';

const SUMMARY_INTERVAL_MS = 60000;
const WORK_PREFERENCES = Object.freeze([
  ...Array(10).fill('receipts'),'all_logs','transfer_logs',
]);
const BURST_STOPS = new Set(['idle','retrying','aborted','continuity_error','persistent_partial','stale_lease']);
const REDUCER_HOURS_PER_ITERATION = 2;
const REDUCER_DELAY_MS = 10000;
// While the work queue is draining, historical reduction yields the database to the catch-up path,
// but never for longer than this: durable hourly reduction always keeps making bounded progress.
export const REDUCER_MAX_DEFER_MS = 5 * 60000;

// Preference is carried across bursts, including a configured burst of one.
// Each worker call consumes one position, regardless of the number of jobs in a log batch.
// Claim falls back to any ready component, so unused opportunities are never reserved.
export function createWorkBurst({worker,maxCalls=12,frontier} = {}) {
  if (!worker?.runOnce || !Number.isSafeInteger(maxCalls) || maxCalls < 1 || maxCalls > 50) throw new Error('invalid_work_burst');
  if (frontier !== undefined && typeof frontier !== 'function') throw new Error('invalid_work_burst');
  let preference = 0;
  return async ({signal} = {}) => {
    const results = [];
    try {
      for (let i=0;i<maxCalls;i++) {
        if (signal?.aborted) break;
        const preferredComponent = WORK_PREFERENCES[preference];
        preference = (preference+1)%WORK_PREFERENCES.length;
        const result = await worker.runOnce({signal,preferredComponent,...(frontier ? {deferFrontier:true} : {})});
        results.push(result);
        if (BURST_STOPS.has(result.status)) break;
      }
    } finally {
      // Always recover from durable processed/certificate state, even on idle after a hard crash.
      // This cleanup is DB-only and must also run after abort or an early burst stop.
      if (frontier) try { await frontier(); } catch (error) {
        const continuity=error.message==='lane_continuity_stopped' || error.message==='checkpoint_parent_hash_mismatch';
        results.push({status:continuity ? 'continuity_error' : 'retrying',
          error:continuity ? 'checkpoint_parent_hash_mismatch' : 'required_read_unavailable',frontierFlush:true});
      }
    }
    return results;
  };
}

// One process and shared transport budget. The HTTP API continues reading A1.
export function createA2Runtime({ pool, config, finalityBlocks = 2, fetchImpl = globalThis.fetch,
  now = () => performance.now(), sleepImpl = sleep, log = console.error } = {}) {
  const budget = createRpcBudget({maxConcurrency:config.rpcConcurrency,minIntervalMs:config.rpcMinIntervalMs,
    cooldownMs:config.rpc429CooldownMs,now,sleepImpl});
  const rpc = createA2RpcClient({budget,fetchImpl});
  const foundation = createFoundationRepository(pool);
  const receipts = createReceiptRepository(pool);
  const metrics = createMetricRepository(pool);
  const chain = createChainFollower({repository:foundation,rpc,mode:'live',maxBlocks:config.liveMaxBlocks,finalityBlocks});
  const worker = createReceiptWorker({repository:receipts,rpc,maxReceiptReads:config.receiptMaxReads,
    maxLogRangeBlocks:config.logRangeBlocks,owner:randomUUID()});
  let draining = false;
  let capacityBlocked = false;
  let capacityLogged = false;
  let deferredNextBlock = 0;
  let outstanding = 0;
  let pressureRefresh = Promise.resolve();
  const burst = createWorkBurst({worker:{async runOnce(options) {
    await refreshPressure();
    const result=await worker.runOnce({...options,enqueueFollowups:!draining});
    if (result.error==='work_capacity_reached') capacityError();
    return result;
  }},maxCalls:config.workBurst,frontier:() => receipts.advanceFrontier()});
  let cycleActive = false;
  let chainActive = false;
  let workActive = false;
  let reducerActive = false;
  let reducerRanAt = null;
  let runActive = false;
  let nextSummaryAt = now()+SUMMARY_INTERVAL_MS;
  function refreshPressure(allowResume=false) {
    const task=pressureRefresh.then(async () => {
      outstanding=(await receipts.workPressure()).outstanding;
      if (outstanding>=config.workHighWater) draining=true;
      else if (draining && allowResume && outstanding<=config.workLowWater
        && (!capacityBlocked || await receipts.capacityBelow(config.workHighWater))) {
        draining=false;capacityBlocked=false;
      }
      return draining;
    });
    pressureRefresh=task.catch(() => {});
    return task;
  }
  function capacityError() {
    draining=true;capacityBlocked=true;
    if (!capacityLogged || now()>=nextSummaryAt) {
      log('Arc Intelligence A2: backpressure=drain error=work_capacity_reached');
      nextSummaryAt=now()+SUMMARY_INTERVAL_MS;capacityLogged=true;
    }
  }
  async function summary() {
    if (now() < nextSummaryAt) return;
    nextSummaryAt = now()+SUMMARY_INTERVAL_MS;
    try {
      const chainLane = await foundation.getLane(CHAIN_IDENTITY);
      const receiptLane = await receipts.getLane();
      const counts = await receipts.workCounts();
      const pressure = await receipts.workPressure();
      const number = (value) => value === null || value === undefined ? 'unavailable' : position(value);
      log(`Arc Intelligence A2: head=${number(chainLane?.observed_head)} chain=${number(chainLane?.processed_through)}`
        + ` receipt=${number(receiptLane?.processed_through)} outstanding=${pressure.outstanding} pending=${counts.pending} retrying=${counts.retrying} leased=${counts.leased}`
        + ` backpressure=${draining ? 'drain' : 'normal'}${capacityBlocked ? ' error=work_capacity_reached' : ''}`);
    } catch { log('Arc Intelligence A2: status=required_read_unavailable'); }
  }
  async function chainStep({signal} = {}) {
    if (chainActive) return {skipped:true};
    if (signal?.aborted) return {status:'aborted'};
    chainActive = true;
    try {
      await refreshPressure(true);
      if (signal?.aborted) return {status:'aborted'};
      const chainResult = draining ? {status:'paused',persistedBlocks:0} : await chain.tick({signal});
      if (signal?.aborted) return {status:'aborted'};
      const receiptLane = await receipts.getLane();
      const scheduledBlocks = [];
      const deferredBlocks = [];
      if (!draining && receiptLane?.status !== 'continuity_error') {
        const page=await receipts.deferredFollowupBlocks(deferredNextBlock);
        for (const number of page.blocks) {
          if (signal?.aborted) return {status:'aborted'};
          if (await refreshPressure()) break;
          await receipts.recoverDeferredFollowups(number);
          deferredBlocks.push(number);
        }
        if (!await refreshPressure()) deferredNextBlock=page.nextBlock;
        const lane=await foundation.getLane(CHAIN_IDENTITY);
        if (!draining && lane?.processed_through !== null && lane?.processed_through !== undefined) {
          const recent=await receipts.recentIncompleteBlocks(lane.processed_through);
          for (const number of recent) {
            if (signal?.aborted) return {status:'aborted'};
            if (await refreshPressure()) break;
            // Scheduling cannot complete evidence; every completion is followed by the burst's shared frontier sweep.
            await receipts.scheduleBlock(number,{advanceFrontier:false});
            scheduledBlocks.push(number);
          }
        }
      }
      const continueImmediately = !draining && chainResult.status === 'indexing';
      return {chain:chainResult,scheduledBlocks,deferredBlocks,continueImmediately,
        backpressure:draining ? 'drain' : 'normal',outstanding};
    } catch (error) {
      if (error.message!=='work_capacity_reached') throw error;
      capacityError();
      return {chain:{status:'paused',persistedBlocks:0},status:'retrying',error:'work_capacity_reached',
        work:[],scheduledBlocks:[],deferredBlocks:[],backpressure:'drain',outstanding,continueImmediately:false};
    } finally { chainActive = false; }
  }
  async function workStep({signal} = {}) {
    if (workActive) return {skipped:true};
    if (signal?.aborted) return {status:'aborted',work:[]};
    workActive = true;
    try {
      await refreshPressure(true);
      if (signal?.aborted) return {status:'aborted',work:[]};
      const receiptLane = await receipts.getLane();
      const work = receiptLane?.status === 'continuity_error' ? [{status:'continuity_error'}] : await burst({signal});
      if (!signal?.aborted) await refreshPressure();
      const last = work.at(-1)?.status;
      const stopped = work.at(-1)?.frontierFlush === true
        || ['aborted','continuity_error','persistent_partial','stale_lease'].includes(last);
      const fullBurst=work.length===(config.workBurst ?? 12);
      const continueImmediately = draining
        ? !signal?.aborted && fullBurst && work.every((result) => result.status==='complete')
        : !stopped && !signal?.aborted && !['retrying','aborted','continuity_error'].includes(last)
          && fullBurst && last!=='idle';
      return {work,continueImmediately,backpressure:draining ? 'drain' : 'normal',outstanding};
    } catch (error) {
      if (error.message!=='work_capacity_reached') throw error;
      capacityError();
      return {status:'retrying',error:'work_capacity_reached',work:[],backpressure:'drain',outstanding,continueImmediately:false};
    } finally { workActive = false; }
  }

  async function reducerStep({signal} = {}) {
    if (reducerActive) return {skipped:true};
    if (signal?.aborted) return {status:'aborted'};
    if (draining && reducerRanAt !== null && now()-reducerRanAt < REDUCER_MAX_DEFER_MS) {
      return {status:'deferred',processed:0,complete:0,skipped:0,continueImmediately:false};
    }
    reducerActive = true;
    reducerRanAt = now();
    try {
      const result = await metrics.reduceCandidateHours({limit:REDUCER_HOURS_PER_ITERATION,signal});
      return {status:result.processed > 0 ? 'reduced' : 'idle',...result,
        continueImmediately:false};
    } catch {
      return {status:'retrying',processed:0,complete:0,skipped:0,continueImmediately:false};
    } finally { reducerActive = false; }
  }
  async function cycle({signal} = {}) {
    if (cycleActive || runActive) return {skipped:true};
    if (signal?.aborted) return {status:'aborted'};
    cycleActive = true;
    try {
      const chainResult=await chainStep({signal});
      if (signal?.aborted) return {status:'aborted'};
      const workResult=chainResult.error==='work_capacity_reached'
        ? {work:[],continueImmediately:false,backpressure:'drain',outstanding}
        : await workStep({signal});
      const chainStatus=chainResult.chain?.status ?? chainResult.status;
      const lastWorkStatus = workResult.work?.at(-1)?.status;
      const workStopped = workResult.work?.at(-1)?.frontierFlush === true
        || ['retrying','aborted','continuity_error','persistent_partial','stale_lease'].includes(lastWorkStatus);
      const continueImmediately = Boolean(workResult.continueImmediately)
        || (!workStopped && !draining && !signal?.aborted && chainStatus === 'indexing');
      return {...chainResult,...workResult,continueImmediately,backpressure:draining ? 'drain' : 'normal',outstanding};
    } finally { cycleActive = false; }
  }
  async function chainLoop({signal}) {
    while (!signal.aborted) {
      let result;
      try { result=await chainStep({signal}); } catch { result=null; }
      if (signal.aborted) break;
      await summary();
      if (signal.aborted) break;
      if (result?.chain?.status === 'indexing' && !draining) continue;
      try { await sleepImpl(config.workerPollMs,undefined,{signal}); } catch { break; }
    }
  }
  async function workLoop({signal}) {
    while (!signal.aborted) {
      let result;
      try { result=await workStep({signal}); } catch { result=null; }
      if (signal.aborted) break;
      await summary();
      if (signal.aborted) break;
      if (result?.continueImmediately) continue;
      try { await sleepImpl(config.workerPollMs,undefined,{signal}); } catch { break; }
    }
  }
  async function reducerLoop({signal}) {
    while (!signal.aborted) {
      await reducerStep({signal});
      if (signal.aborted) break;
      await summary();
      if (signal.aborted) break;
      // Historical reduction must yield even when both selected hours remain incomplete.
      try { await sleepImpl(REDUCER_DELAY_MS,undefined,{signal}); } catch { break; }
    }
  }
  async function run({signal}) {
    if (runActive) return;
    runActive = true;
    try { await Promise.allSettled([chainLoop({signal}),workLoop({signal}),reducerLoop({signal})]); }
    finally { runActive = false; }
  }
  return Object.freeze({cycle,run,chainStep,workStep,reducerStep});
}
