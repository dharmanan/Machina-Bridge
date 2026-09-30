import { setTimeout as sleep } from 'node:timers/promises';
import { randomUUID } from 'node:crypto';
import { CHAIN_IDENTITY, createFoundationRepository, position } from './foundation.js';
import { createChainFollower } from './chain-lane.js';
import { createReceiptRepository } from './receipt-repository.js';
import { createReceiptWorker } from './receipt-lane.js';
import { createRpcBudget } from './rpc-budget.js';
import { createA2RpcClient } from './a2-rpc.js';

const SUMMARY_INTERVAL_MS = 60000;
const WORK_PREFERENCES = Object.freeze([
  ...Array(6).fill('receipts'),...Array(3).fill('all_logs'),...Array(3).fill('transfer_logs'),
]);
const BURST_STOPS = new Set(['idle','retrying','aborted','continuity_error','persistent_partial','stale_lease']);

// Preference is carried across bursts, including a configured burst of one.
// Claim falls back to any ready component, so unused opportunities are never reserved.
export function createWorkBurst({worker,maxCalls=12} = {}) {
  if (!worker?.runOnce || !Number.isSafeInteger(maxCalls) || maxCalls < 1 || maxCalls > 50) throw new Error('invalid_work_burst');
  let preference = 0;
  return async ({signal} = {}) => {
    const results = [];
    for (let i=0;i<maxCalls;i++) {
      if (signal?.aborted) break;
      const preferredComponent = WORK_PREFERENCES[preference];
      preference = (preference+1)%WORK_PREFERENCES.length;
      const result = await worker.runOnce({signal,preferredComponent});
      results.push(result);
      if (BURST_STOPS.has(result.status)) break;
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
  const chain = createChainFollower({repository:foundation,rpc,mode:'live',maxBlocks:config.liveMaxBlocks,finalityBlocks});
  const worker = createReceiptWorker({repository:receipts,rpc,maxReceiptReads:config.receiptMaxReads,owner:randomUUID()});
  const burst = createWorkBurst({worker,maxCalls:config.workBurst});
  let active = false;
  let nextSummaryAt = now()+SUMMARY_INTERVAL_MS;
  async function summary() {
    if (now() < nextSummaryAt) return;
    nextSummaryAt = now()+SUMMARY_INTERVAL_MS;
    try {
      const chainLane = await foundation.getLane(CHAIN_IDENTITY);
      const receiptLane = await receipts.getLane();
      const counts = await receipts.workCounts();
      const number = (value) => value === null || value === undefined ? 'unavailable' : position(value);
      log(`Arc Intelligence A2: head=${number(chainLane?.observed_head)} chain=${number(chainLane?.processed_through)}`
        + ` receipt=${number(receiptLane?.processed_through)} pending=${counts.pending} retrying=${counts.retrying} leased=${counts.leased}`);
    } catch { log('Arc Intelligence A2: status=required_read_unavailable'); }
  }
  async function cycle({signal} = {}) {
    if (active) return {skipped:true};
    if (signal?.aborted) return {status:'aborted'};
    active = true;
    try {
      const chainResult = await chain.tick({signal});
      if (signal?.aborted) return {status:'aborted'};
      const lane = await foundation.getLane(CHAIN_IDENTITY);
      const receiptLane = await receipts.getLane();
      const scheduledBlocks = [];
      if (receiptLane?.status !== 'continuity_error' && lane?.processed_through !== null && lane?.processed_through !== undefined) {
        const recent = await receipts.recentIncompleteBlocks(lane.processed_through);
        for (const number of recent) {
          if (signal?.aborted) return {status:'aborted'};
          await receipts.scheduleBlock(number);
          scheduledBlocks.push(number);
        }
      }
      if (signal?.aborted) return {status:'aborted'};
      const work = receiptLane?.status === 'continuity_error' ? [{status:'continuity_error'}] : await burst({signal});
      const last = work.at(-1)?.status;
      const stopped = ['aborted','continuity_error','persistent_partial','stale_lease'].includes(last);
      // Exhausting a burst yields to the next chain tick, without a full idle poll.
      // Retrying jobs remain protected by their durable not_before deadlines.
      // An idle worker sleeps unless chain backlog still needs bounded sequential catch-up.
      const continueImmediately = !stopped && !signal?.aborted && !['retrying','continuity_error','aborted'].includes(chainResult.status)
        && (chainResult.status === 'indexing' || (work.length === (config.workBurst ?? 12) && last !== 'idle'));
      return {chain:chainResult,work,scheduledBlocks,continueImmediately};
    } finally { active = false; }
  }
  async function run({signal}) {
    while (!signal.aborted) {
      let result;
      try { result = await cycle({signal}); } catch { /* periodic sanitized summary owns runtime logging */ }
      if (signal.aborted) break;
      await summary();
      if (signal.aborted) break;
      if (result?.continueImmediately) continue;
      try { await sleepImpl(config.workerPollMs,undefined,{signal}); } catch { break; }
    }
  }
  return Object.freeze({cycle,run});
}
