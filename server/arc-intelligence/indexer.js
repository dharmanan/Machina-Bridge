import { buildHistoricalRange } from '../../api/_lib/arc-intelligence/history.js';
import { ARC_CHAIN_ID, ARC_RPC_URL, createArcRpcClient } from '../../api/_lib/arc-intelligence/rpc.js';
import { MAX_WINDOW_SIZE } from '../../api/_lib/arc-intelligence/core.js';
import { quantityToSafeNumber } from '../../api/_lib/arc-intelligence/normalize.js';
import { buildReadModel, extractCompleteChunk } from './read-model.js';

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
  historyBuilder = buildHistoricalRange } = {}) {
  // Config is also validated for injected callers; no path can exceed core bounds.
  if (!Number.isSafeInteger(config.chunkSize) || config.chunkSize < 1 || config.chunkSize > MAX_WINDOW_SIZE
    || !Number.isSafeInteger(config.maxChunksPerTick) || config.maxChunksPerTick < 1 || config.maxChunksPerTick > 16
    || !Number.isSafeInteger(config.finalityBlocks) || config.finalityBlocks < 0) throw new Error('Invalid indexer bounds');
  let active = false;
  return {
    async tick() {
      if (active) return { skipped: true };
      active = true;
      try {
        return await repository.withIndexerLock(async (db) => {
          let state = await db.ensureState();
          if (state.status === 'continuity_error') return { status: 'continuity_error', stopped: true };
          if (state.chain_id !== ARC_CHAIN_ID || state.source !== ARC_RPC_URL || rpc.url !== ARC_RPC_URL) {
            await db.setStatus('degraded', 'canonical_source_mismatch');
            return { status: 'degraded' };
          }
          let head;
          let safeHead;
          try {
            head = quantityToSafeNumber(await rpc.request('eth_blockNumber'));
            if (head === null || head < config.finalityBlocks) throw new Error('Unavailable head');
            safeHead = head - config.finalityBlocks;
          } catch {
            await db.attempt(null, null);
            await db.setStatus('degraded', 'arc_rpc_head_unavailable');
            return { status: 'degraded' };
          }
          await db.attempt(head, safeHead);
          if (state.next_block === null) state = await db.initialize(Math.max(0, safeHead - config.chunkSize + 1));
          let indexedChunks = 0;
          while (state.next_block <= safeHead && indexedChunks < config.maxChunksPerTick) {
            const start = state.next_block;
            const end = Math.min(safeHead, start + config.chunkSize - 1);
            const run = await db.startRun(start, end);
            let success = false;
            let errorCode = null;
            try {
              const history = await historyBuilder({ rpc, startBlock: start, endBlock: end, chunkSize: config.chunkSize });
              const chunk = extractCompleteChunk(history, start, end);
              if (state.last_indexed_hash !== null && state.last_indexed_hash !== chunk.firstParentHash) {
                errorCode = 'checkpoint_parent_hash_mismatch';
                await db.setStatus('continuity_error', errorCode);
                return { status: 'continuity_error', indexedChunks };
              }
              await db.saveChunk(chunk, buildReadModel(history, chunk));
              success = true;
              indexedChunks += 1;
              state = await db.getState();
            } catch {
              errorCode = 'chunk_unavailable_or_incomplete';
              await db.setStatus('degraded', errorCode);
              return { status: 'degraded', indexedChunks };
            } finally {
              await db.finishRun(run, success, errorCode);
            }
          }
          await db.pruneRuns();
          const status = state.next_block > safeHead ? 'caught_up' : 'indexing';
          await db.setStatus(status);
          return { status, indexedChunks };
        });
      } catch {
        // Database/lock failures also leave the checkpoint untouched and retry.
        // Do not expose upstream connection strings or arbitrary error text.
        return { status: 'degraded', error: 'intelligence_database_unavailable' };
      } finally { active = false; }
    },
  };
}
