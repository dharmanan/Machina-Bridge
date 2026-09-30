import { Pool } from 'pg';
import { ARC_CHAIN_ID, ARC_RPC_URL } from '../../api/_lib/arc-intelligence/rpc.js';

// PostgreSQL bigint defaults to strings. Convert only bounded chain positions,
// never financial amounts, and refuse precision loss.
function position(value) {
  if (value === null || value === undefined) return null;
  if (!/^\d+$/.test(String(value))) throw new Error('Invalid persisted block position');
  const number = Number(value);
  if (!Number.isSafeInteger(number)) throw new Error('Unsafe persisted block position');
  return number;
}
function stateRow(row) {
  if (!row) return null;
  return { ...row, next_block: position(row.next_block), last_indexed_block: position(row.last_indexed_block),
    latest_arc_head: position(row.latest_arc_head), safe_head: position(row.safe_head) };
}

export function createPool(databaseUrl) {
  if (!databaseUrl) throw new Error('DATABASE_URL is required');
  const pool = new Pool({ connectionString: databaseUrl, max: 4, connectionTimeoutMillis: 5000,
    idleTimeoutMillis: 30000, query_timeout: 10000, statement_timeout: 10000 });
  // Never log upstream database errors, which may contain connection details.
  pool.on('error', () => console.error('Intelligence database connection unavailable'));
  return pool;
}

export function createSession(client) {
  return {
    async getState() {
      return stateRow((await client.query('SELECT * FROM arc_intelligence_state WHERE id = 1')).rows[0]);
    },
    async ensureState() {
      await client.query(`INSERT INTO arc_intelligence_state (id, chain_id, source) VALUES (1, $1, $2)
        ON CONFLICT (id) DO NOTHING`, [ARC_CHAIN_ID, ARC_RPC_URL]);
      return this.getState();
    },
    async initialize(nextBlock) {
      await client.query(`UPDATE arc_intelligence_state SET next_block = $1, updated_at = now()
        WHERE id = 1 AND next_block IS NULL AND chain_id = $2 AND source = $3`, [nextBlock, ARC_CHAIN_ID, ARC_RPC_URL]);
      return this.getState();
    },
    async attempt(head, safeHead) {
      await client.query(`UPDATE arc_intelligence_state SET latest_arc_head = $1, safe_head = $2,
        last_attempt_at = now(), updated_at = now() WHERE id = 1`, [head, safeHead]);
    },
    async setStatus(status, error = null) {
      await client.query(`UPDATE arc_intelligence_state SET status = $1, last_error = $2,
        updated_at = now() WHERE id = 1`, [status, error]);
    },
    async startRun(start, end) {
      return (await client.query(`INSERT INTO arc_intelligence_runs (start_block, end_block)
        VALUES ($1, $2) RETURNING id`, [start, end])).rows[0].id;
    },
    async finishRun(id, success, error) {
      await client.query(`UPDATE arc_intelligence_runs SET finished_at = now(), success = $2, error = $3 WHERE id = $1`,
        [id, success, error]);
    },
    async pruneRuns() {
      // Delete at most 100 records per tick; keep the newest 1000.
      await client.query(`DELETE FROM arc_intelligence_runs WHERE id IN
        (SELECT id FROM arc_intelligence_runs ORDER BY id DESC OFFSET 1000 LIMIT 100)`);
    },
    async saveChunk(chunk, payload) {
      // The dedicated advisory-lock connection also owns this entire transaction.
      await client.query('BEGIN');
      try {
        const state = stateRow((await client.query('SELECT * FROM arc_intelligence_state WHERE id = 1 FOR UPDATE')).rows[0]);
        if (state?.chain_id !== ARC_CHAIN_ID || state?.source !== ARC_RPC_URL) throw new Error('Noncanonical persisted state');
        const existing = (await client.query(`SELECT start_hash, end_hash FROM arc_intelligence_chunks
          WHERE start_block = $1 AND end_block = $2`, [chunk.startBlock, chunk.endBlock])).rows[0];
        if (existing) {
          if (existing.start_hash !== chunk.startHash || existing.end_hash !== chunk.endHash
            || state.next_block <= chunk.endBlock) throw new Error('Conflicting duplicate chunk');
          await client.query('COMMIT');
          return { duplicate: true };
        }
        if (state.next_block !== chunk.startBlock || (state.last_indexed_hash !== null
          && state.last_indexed_hash !== chunk.firstParentHash)) throw new Error('Checkpoint continuity conflict');
        await client.query(`INSERT INTO arc_intelligence_chunks
          (start_block, end_block, start_hash, end_hash, start_timestamp, end_timestamp,
           block_count, transaction_count, receipt_count, protocol_coverage, compact_metrics, warnings)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [chunk.startBlock, chunk.endBlock, chunk.startHash, chunk.endHash, chunk.startTimestamp, chunk.endTimestamp,
          chunk.blockCount, chunk.transactionCount, chunk.receiptCount, JSON.stringify(payload.coverage),
          JSON.stringify(payload), JSON.stringify(chunk.warnings)]);
        await client.query(`INSERT INTO arc_intelligence_latest (id, payload, block_number, block_hash)
          VALUES (1,$1,$2,$3) ON CONFLICT (id) DO UPDATE SET payload = EXCLUDED.payload,
          block_number = EXCLUDED.block_number, block_hash = EXCLUDED.block_hash, generated_at = now()`,
        [JSON.stringify(payload), chunk.endBlock, chunk.endHash]);
        await client.query(`UPDATE arc_intelligence_state SET next_block = $1, last_indexed_block = $2,
          last_indexed_hash = $3, last_success_at = now(), last_error = NULL, status = 'indexing',
          engine_versions = $4, updated_at = now() WHERE id = 1`,
        [chunk.endBlock + 1, chunk.endBlock, chunk.endHash, JSON.stringify(payload.coverage.engineVersions)]);
        await client.query('COMMIT');
        return { duplicate: false };
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    },
  };
}

export function createRepository(pool) {
  return {
    async withIndexerLock(work) {
      const client = await pool.connect();
      let locked = false;
      let broken = false;
      try {
        locked = (await client.query('SELECT pg_try_advisory_lock(5042, 177001) AS locked')).rows[0].locked;
        if (!locked) return { skipped: true };
        return await work(createSession(client));
      } finally {
        if (locked) {
          try { await client.query('SELECT pg_advisory_unlock(5042, 177001)'); } catch { broken = true; }
        }
        client.release(broken);
      }
    },
    async health() { await pool.query('SELECT 1'); },
    async getState() { return stateRow((await pool.query('SELECT * FROM arc_intelligence_state WHERE id = 1')).rows[0]); },
    async getLatest() {
      return (await pool.query('SELECT payload FROM arc_intelligence_latest WHERE id = 1')).rows[0]?.payload ?? null;
    },
  };
}
