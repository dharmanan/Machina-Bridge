// Compact engine: durable store for finished hours on built-in node:sqlite. The caller opens the DatabaseSync, so this
// module loads on any Node version. One aggregate row per complete hour plus one contiguous checkpoint, written in a
// single transaction. Raw blocks, transactions, receipts and logs are never stored.
import { createHash } from 'node:crypto';

export const COMPACT_SCHEMA_VERSION = '1';
const HOUR = 3600;

export class StoreError extends Error {
  constructor(code) { super(code); this.code = code; }
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS compact_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
CREATE TABLE IF NOT EXISTS compact_hours (
  hour_start INTEGER PRIMARY KEY CHECK (hour_start % 3600 = 0),
  definition_version TEXT NOT NULL,
  first_block INTEGER NOT NULL,
  last_block INTEGER NOT NULL,
  first_hash TEXT NOT NULL,
  last_hash TEXT NOT NULL,
  block_count INTEGER NOT NULL CHECK (block_count = last_block - first_block + 1),
  transaction_count INTEGER NOT NULL,
  unique_active_addresses INTEGER NOT NULL,
  usdc_transfer_count INTEGER NOT NULL,
  usdc_mint_count INTEGER NOT NULL,
  usdc_burn_count INTEGER NOT NULL,
  result_json TEXT NOT NULL,
  result_sha256 TEXT NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS compact_checkpoint (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  hour_start INTEGER NOT NULL,
  last_block INTEGER NOT NULL,
  last_hash TEXT NOT NULL
) STRICT;`;

// Only a complete hour result, with every family verified, can be stored; anything else is refused, never marked.
function assertCommittable(result) {
  const range = result?.range;
  const network = result?.network;
  if (result?.complete !== true || range?.kind !== 'hour' || !Number.isSafeInteger(range.hourStart) || range.hourStart % HOUR !== 0
    || range.hourEnd !== range.hourStart + HOUR || network?.status !== 'available'
    || network.blockCount !== range.lastBlock - range.firstBlock + 1
    || !Object.values(result.families ?? {}).every((family) => family.status === 'available')
    || !Number.isSafeInteger(result.families?.usdc?.transferCount)) throw new StoreError('hour_not_complete');
}

export function createCompactStore(db) {
  db.exec(SCHEMA);
  db.prepare('INSERT OR IGNORE INTO compact_meta (key, value) VALUES (?, ?)').run('schema_version', COMPACT_SCHEMA_VERSION);
  if (db.prepare('SELECT value FROM compact_meta WHERE key = ?').get('schema_version')?.value !== COMPACT_SCHEMA_VERSION) {
    throw new StoreError('schema_version_mismatch');
  }
  const int = (value) => BigInt(value); // bind as SQLite INTEGER, never REAL
  const sql = {
    hour: db.prepare('SELECT hour_start, first_block, last_block, last_hash, result_sha256 FROM compact_hours WHERE hour_start = ?'),
    insert: db.prepare(`INSERT INTO compact_hours (hour_start, definition_version, first_block, last_block, first_hash, last_hash,
      block_count, transaction_count, unique_active_addresses, usdc_transfer_count, usdc_mint_count, usdc_burn_count, result_json,
      result_sha256) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
    checkpoint: db.prepare('SELECT hour_start, last_block, last_hash FROM compact_checkpoint WHERE id = 1'),
    setCheckpoint: db.prepare(`INSERT INTO compact_checkpoint (id, hour_start, last_block, last_hash) VALUES (1, ?, ?, ?)
      ON CONFLICT (id) DO UPDATE SET hour_start = excluded.hour_start, last_block = excluded.last_block, last_hash = excluded.last_hash`),
  };
  const checkpoint = () => {
    const row = sql.checkpoint.get();
    return row ? { hourStart: row.hour_start, lastBlock: row.last_block, lastHash: row.last_hash } : null;
  };
  const moveCheckpoint = (row) => sql.setCheckpoint.run(int(row.hour_start), int(row.last_block), row.last_hash);

  // The checkpoint is the end of the contiguous run of committed hours that starts at the first committed hour.
  // It only moves onto the next hour when that hour's first block directly follows the checkpoint's last block.
  function advanceCheckpoint(insertedHour) {
    if (!checkpoint()) moveCheckpoint(sql.hour.get(int(insertedHour)));
    for (let current = checkpoint(), next; (next = sql.hour.get(int(current.hourStart + HOUR))); current = checkpoint()) {
      if (next.first_block !== current.lastBlock + 1) throw new StoreError('checkpoint_discontinuity');
      moveCheckpoint(next);
    }
  }

  // beforeCommit: test hook that runs after every write and before COMMIT.
  function commitHour(result, { beforeCommit = null } = {}) {
    assertCommittable(result);
    const json = JSON.stringify(result);
    const sha256 = createHash('sha256').update(json).digest('hex');
    const { range, network, families: { usdc } } = result;
    db.exec('BEGIN IMMEDIATE');
    try {
      const existing = sql.hour.get(int(range.hourStart));
      if (existing && existing.result_sha256 !== sha256) throw new StoreError('hour_conflict');
      if (!existing) {
        sql.insert.run(int(range.hourStart), result.definitionVersion, int(range.firstBlock), int(range.lastBlock), range.firstHash,
          range.lastHash, int(network.blockCount), int(network.transactionCount), int(network.uniqueActiveAddresses),
          int(usdc.transferCount), int(usdc.mintCount), int(usdc.burnCount), json, sha256);
        advanceCheckpoint(range.hourStart);
      }
      beforeCommit?.();
      db.exec('COMMIT');
      return { outcome: existing ? 'unchanged' : 'inserted', checkpoint: checkpoint() };
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch { /* the original error is the one to report */ }
      throw error;
    }
  }

  return Object.freeze({
    commitHour,
    checkpoint,
    hourCount: () => db.prepare('SELECT COUNT(*) AS count FROM compact_hours').get().count,
  });
}
