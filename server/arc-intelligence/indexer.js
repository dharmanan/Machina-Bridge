import { buildHistoricalRange } from '../../api/_lib/arc-intelligence/history.js';
import { ARC_CHAIN_ID, ARC_RPC_URL, createArcRpcClient } from '../../api/_lib/arc-intelligence/rpc.js';
import { buildBoundedSnapshot, MAX_WINDOW_SIZE } from '../../api/_lib/arc-intelligence/core.js';
import { quantityToSafeNumber } from '../../api/_lib/arc-intelligence/normalize.js';
import { buildReadModel, chunkFailureCode, extractCompleteChunk } from './read-model.js';

function integer(env, key, fallback, min, max) {
  const value = env[key] ?? String(fallback);
  if (!/^\d+$/.test(value)) throw new Error(`Invalid ${key}`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) throw new Error(`Invalid ${key}`);
  return parsed;
}

export function readConfig(env = process.env) {
  return Object.freeze({
    pollMs: integer(env, 'INTELLIGENCE_POLL_MS', 10000, 1000, 3600000),
    chunkSize: integer(env, 'INTELLIGENCE_CHUNK_SIZE', 25, 1, MAX_WINDOW_SIZE),
    finalityBlocks: integer(env, 'INTELLIGENCE_FINALITY_BLOCKS', 2, 0, 10000),
    maxChunksPerTick: integer(env, 'INTELLIGENCE_MAX_CHUNKS_PER_TICK', 4, 1, 16),
    port: integer(env, 'PORT', 8080, 1, 65535),
  });
}

export function createIndexer({ repository, rpc = createArcRpcClient(), config = readConfig({}),
  historyBuilder = buildHistoricalRange, snapshotBuilder = buildBoundedSnapshot } = {}) {
  // Config is also validated for injected callers; no path can exceed core bounds.
  if (!Number.isSafeInteger(config.chunkSize) || config.chunkSize < 1 || config.chunkSize > MAX_WINDOW_SIZE
    || !Number.isSafeInteger(config.maxChunksPerTick) || config.maxChunksPerTick < 1 || config.maxChunksPerTick > 16
    || !Number.isSafeInteger(config.finalityBlocks) || config.finalityBlocks < 0) throw new Error('Invalid indexer bounds');
  let active = false;
  return {
    async tick() {
      if (active) return { skipped: true };
      active = true;
      let failingRange = {};
      try {
        return await repository.withIndexerLock(async (db) => {
          let state = await db.ensureState();
          if (state.status === 'continuity_error') return { status: 'continuity_error', stopped: true };
          if (state.chain_id !== ARC_CHAIN_ID || state.source !== ARC_RPC_URL || rpc.url !== ARC_RPC_URL) {
            await db.setStatus('degraded', 'core_incomplete');
            return { status: 'degraded', error: 'core_incomplete' };
          }
          let head;
          let safeHead;
          try {
            head = quantityToSafeNumber(await rpc.request('eth_blockNumber'));
            if (head === null || head < config.finalityBlocks) throw new Error('Unavailable head');
            safeHead = head - config.finalityBlocks;
          } catch {
            await db.attempt(null, null);
            await db.setStatus('degraded', 'rpc_head_unavailable');
            return { status: 'degraded', error: 'rpc_head_unavailable' };
          }
          await db.attempt(head, safeHead);
          if (state.next_block === null) state = await db.initialize(Math.max(0, safeHead - config.chunkSize + 1));
          let indexedChunks = 0;
          while (state.next_block <= safeHead && indexedChunks < config.maxChunksPerTick) {
            const start = state.next_block;
            const end = Math.min(safeHead, start + config.chunkSize - 1);
            failingRange = { startBlock: start, endBlock: end };
            const run = await db.startRun(start, end);
            let success = false;
            let errorCode = null;
            try {
              let observedSnapshot;
              errorCode = 'snapshot_unavailable';
              const history = await historyBuilder({ rpc, startBlock: start, endBlock: end, chunkSize: config.chunkSize,
                // History keeps only complete snapshots. Observe the existing
                // single core read in memory, including an incomplete result.
                snapshotBuilder: async (args) => {
                  observedSnapshot = await snapshotBuilder(args);
                  return observedSnapshot;
                },
              });
              const failure = chunkFailureCode(history, observedSnapshot ?? history?.chunkSnapshots?.[0]);
              errorCode = failure ?? 'core_incomplete';
              if (failure) throw new Error(failure);
              const chunk = extractCompleteChunk(history, start, end);
              if (state.last_indexed_hash !== null && state.last_indexed_hash !== chunk.firstParentHash) {
                errorCode = 'checkpoint_parent_hash_mismatch';
                await db.setStatus('continuity_error', errorCode);
                return { status: 'continuity_error', indexedChunks, error: errorCode, ...failingRange };
              }
              const payload = buildReadModel(history, chunk);
              errorCode = 'database_unavailable';
              await db.saveChunk(chunk, payload);
              success = true;
              indexedChunks += 1;
              state = await db.getState();
              errorCode = null;
            } catch {
              await db.setStatus('degraded', errorCode);
              return { status: 'degraded', indexedChunks, error: errorCode, ...failingRange };
            } finally {
              await db.finishRun(run, success, errorCode);
            }
            failingRange = {};
          }
          await db.pruneRuns();
          const status = state.next_block > safeHead ? 'caught_up' : 'indexing';
          await db.setStatus(status);
          return { status, indexedChunks };
        });
      } catch {
        // Database/lock failures also leave the checkpoint untouched and retry.
        // Do not expose upstream connection strings or arbitrary error text.
        return { status: 'degraded', error: 'database_unavailable', ...failingRange };
      } finally { active = false; }
    },
  };
}
