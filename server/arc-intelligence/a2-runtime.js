import { setTimeout as sleep } from 'node:timers/promises';
import { randomUUID } from 'node:crypto';
import { CHAIN_IDENTITY, createFoundationRepository } from './foundation.js';
import { createChainFollower } from './chain-lane.js';
import { createReceiptRepository } from './receipt-repository.js';
import { createReceiptWorker } from './receipt-lane.js';
import { createRpcBudget } from './rpc-budget.js';
import { createA2RpcClient } from './a2-rpc.js';

// One process, one shared transport budget, one sequential bounded runtime cycle.
// The HTTP API continues reading A1. This runtime never creates an A1 indexer.
export function createA2Runtime({ pool, config, finalityBlocks = 2, fetchImpl = globalThis.fetch,
  now, sleepImpl = sleep, log = console.error } = {}) {
  const budget = createRpcBudget({maxConcurrency:config.rpcConcurrency,minIntervalMs:config.rpcMinIntervalMs,
    cooldownMs:config.rpc429CooldownMs,now,sleepImpl});
  const rpc = createA2RpcClient({budget,fetchImpl});
  const foundation = createFoundationRepository(pool);
  const receipts = createReceiptRepository(pool);
  const chain = createChainFollower({repository:foundation,rpc,mode:'live',maxBlocks:config.liveMaxBlocks,finalityBlocks});
  const worker = createReceiptWorker({repository:receipts,rpc,maxReceiptReads:config.receiptMaxReads,owner:randomUUID()});
  let active = false;
  async function cycle({signal} = {}) {
    if (active) return {skipped:true};
    if (signal?.aborted) return {status:'aborted'};
    active = true;
    try {
      const chainResult = await chain.tick({signal});
      if (signal?.aborted) return {status:'aborted'};
      const lane = await foundation.getLane(CHAIN_IDENTITY);
      const scheduledBlocks = [];
      if (lane?.processed_through !== null && lane?.processed_through !== undefined) {
        const recent = await receipts.recentIncompleteBlocks(lane.processed_through);
        for (const number of recent) {
          if (signal?.aborted) return {status:'aborted'};
          await receipts.scheduleBlock(number);
          scheduledBlocks.push(number);
        }
      }
      if (signal?.aborted) return {status:'aborted'};
      const receiptResult = await worker.runOnce({signal});
      return {chain:chainResult,receipts:receiptResult,scheduledBlocks};
    } finally { active = false; }
  }
  async function run({signal}) {
    while (!signal.aborted) {
      try { await cycle({signal}); }
      catch { if (!signal.aborted) log('Arc Intelligence A2 runtime: required_read_unavailable'); }
      if (signal.aborted) break;
      try { await sleepImpl(config.workerPollMs,undefined,{signal}); } catch { break; }
    }
  }
  return Object.freeze({cycle,run});
}
