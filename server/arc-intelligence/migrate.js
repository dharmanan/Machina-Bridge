import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { ARC_CHAIN_ID, ARC_RPC_URL } from '../../api/_lib/arc-intelligence/rpc.js';

export const FOUNDATION_EPOCH = 'a2-foundation-1';
export const MIGRATIONS = Object.freeze(['001_init', '002_a2_foundation']);

export function captureA1Anchor(state) {
  if (!state) return { epoch: FOUNDATION_EPOCH, anchor: null };
  if (state.chain_id !== ARC_CHAIN_ID || state.source !== ARC_RPC_URL) throw new Error('a1_anchor_invalid');
  const position = (value) => {
    if (value === null) return null;
    if (!/^\d+$/.test(String(value)) || !Number.isSafeInteger(Number(value))) throw new Error('a1_anchor_invalid');
    return Number(value);
  };
  const last = position(state.last_indexed_block);
  const next = position(state.next_block);
  const hash = state.last_indexed_hash;
  if ((last === null) !== (hash === null) || (hash !== null && !/^0x[0-9a-f]{64}$/i.test(hash))
    || (last !== null && next !== last + 1)) throw new Error('a1_anchor_invalid');
  if (next === null) return { epoch: FOUNDATION_EPOCH, anchor: null };
  return { epoch: FOUNDATION_EPOCH, anchor: { lastIndexedBlock: last,
    lastIndexedHash: hash?.toLowerCase() ?? null, nextBlock: next } };
}

export async function migrate(pool) {
  const migrations = await Promise.all(MIGRATIONS.map(async (version) => {
    const sql = await readFile(new URL(`./sql/${version}.sql`, import.meta.url), 'utf8');
    return { version, sql, checksum: createHash('sha256').update(sql).digest('hex') };
  }));
  const client = await pool.connect();
  let broken = false;
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(5042, 177002)');
    await client.query(`CREATE TABLE IF NOT EXISTS arc_intelligence_migrations (
      version text PRIMARY KEY, checksum text NOT NULL,
      metadata jsonb NOT NULL DEFAULT '{}'::jsonb, applied_at timestamptz NOT NULL DEFAULT now()
    )`);
    for (const migration of migrations) {
      const existing = (await client.query('SELECT * FROM arc_intelligence_migrations WHERE version = $1', [migration.version])).rows[0];
      if (existing) {
        if (existing.checksum !== migration.checksum) throw new Error('migration_checksum_mismatch');
        continue;
      }
      await client.query(migration.sql);
      const metadata = migration.version === '002_a2_foundation'
        ? captureA1Anchor((await client.query('SELECT * FROM arc_intelligence_state WHERE id = 1')).rows[0]) : {};
      await client.query('INSERT INTO arc_intelligence_migrations (version, checksum, metadata) VALUES ($1,$2,$3)',
        [migration.version, migration.checksum, JSON.stringify(metadata)]);
    }
    await client.query('COMMIT');
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch { broken = true; }
    throw error;
  } finally {
    client.release(broken);
  }
}
