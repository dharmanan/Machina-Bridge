import { MAX_WINDOW_SIZE } from '../../api/_lib/arc-intelligence/core.js';
import { MAX_WORK_ROWS } from './foundation.js';

function integer(env, key, fallback, min, max) {
  const value = env[key] ?? String(fallback);
  if (typeof value !== 'string' || !/^\d+$/.test(value)) throw new Error(`Invalid ${key}`);
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < min || number > max) throw new Error(`Invalid ${key}`);
  return number;
}

export function readRuntimeConfig(env = {}) {
  const mode = env.INTELLIGENCE_RUNTIME_MODE ?? 'a1';
  if (!['a1','a2_shadow'].includes(mode)) throw new Error('Invalid INTELLIGENCE_RUNTIME_MODE');
  const workHighWater = integer(env,'INTELLIGENCE_A2_WORK_HIGH_WATER',9000,2,MAX_WORK_ROWS-1);
  const workLowWater = integer(env,'INTELLIGENCE_A2_WORK_LOW_WATER',7000,1,MAX_WORK_ROWS-1);
  if (workLowWater >= workHighWater) throw new Error('Invalid A2 work watermarks');
  return Object.freeze({ mode,workHighWater,workLowWater,
    rpcConcurrency:integer(env,'INTELLIGENCE_A2_RPC_CONCURRENCY',1,1,4),
    rpcMinIntervalMs:integer(env,'INTELLIGENCE_A2_RPC_MIN_INTERVAL_MS',500,100,60000),
    rpc429CooldownMs:integer(env,'INTELLIGENCE_A2_RPC_429_COOLDOWN_MS',15000,1000,3600000),
    liveMaxBlocks:integer(env,'INTELLIGENCE_A2_LIVE_MAX_BLOCKS',3,1,MAX_WINDOW_SIZE),
    receiptMaxReads:integer(env,'INTELLIGENCE_A2_RECEIPT_MAX_READS',4,1,64),
    workBurst:integer(env,'INTELLIGENCE_A2_WORK_BURST',12,1,50),
    workerPollMs:integer(env,'INTELLIGENCE_A2_WORKER_POLL_MS',1000,100,3600000),
  });
}
