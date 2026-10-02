// Compact engine: durable store for finished hours on built-in node:sqlite. The caller opens the DatabaseSync, so this
// module loads on any Node version. Raw blocks, transactions, receipts and logs are never stored. Per hour: one network
// row (only for a complete, validated block spine), one row per protocol family (available with metrics, or unavailable
// with null metrics, never zero), and the hour's active-address identities, kept only for the latest 24 hours so 1H, 6H
// and 24H unique counts are exact. Plus the official Uniswap V3 pool registry and its explicit coverage. An hour, its
// family rows, its addresses, its registry rows and the contiguous checkpoint are written in one transaction.
import { createHash } from 'node:crypto';
import { FAMILY_FIELDS } from './families.js';
import { ARC_CHAIN_ID } from './provider.js';
import { V3_POOL_KIND } from './registry.js';
import { COMPACT_DEFINITION_VERSION } from './sources.js';

export const COMPACT_SCHEMA_VERSION = '2';
export const ADDRESS_WINDOW_HOURS = 24;
export const UNIQUE_ADDRESS_WINDOWS = Object.freeze([1, 6, 24]);
const HOUR = 3600;
const FAMILIES = Object.keys(FAMILY_FIELDS);
const ADDRESS = /^0x[0-9a-f]{40}$/;

export class StoreError extends Error {
  constructor(code) { super(code); this.code = code; }
}

const PRAGMAS = 'PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;';
const SCHEMA = `
CREATE TABLE IF NOT EXISTS compact_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
CREATE TABLE IF NOT EXISTS compact_hours (
  hour_start INTEGER PRIMARY KEY CHECK (hour_start % 3600 = 0),
  definition_version TEXT NOT NULL,
  first_block INTEGER NOT NULL,
  last_block INTEGER NOT NULL,
  parent_hash TEXT NOT NULL,
  first_hash TEXT NOT NULL,
  last_hash TEXT NOT NULL,
  block_count INTEGER NOT NULL CHECK (block_count = last_block - first_block + 1),
  transaction_count INTEGER NOT NULL,
  unique_active_addresses INTEGER NOT NULL,
  network_json TEXT NOT NULL,
  network_sha256 TEXT NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS compact_family_hours (
  hour_start INTEGER NOT NULL REFERENCES compact_hours (hour_start),
  family TEXT NOT NULL,
  status TEXT NOT NULL,
  reason TEXT,
  metrics_json TEXT,
  metrics_sha256 TEXT,
  PRIMARY KEY (hour_start, family),
  CHECK ((status = 'available' AND reason IS NULL AND metrics_json IS NOT NULL AND metrics_sha256 IS NOT NULL)
    OR (status = 'unavailable' AND reason IS NOT NULL AND metrics_json IS NULL AND metrics_sha256 IS NULL))
) STRICT, WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS compact_hour_addresses (
  hour_start INTEGER NOT NULL REFERENCES compact_hours (hour_start),
  address BLOB NOT NULL CHECK (length(address) = 20),
  PRIMARY KEY (hour_start, address)
) STRICT, WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS compact_registry (
  kind TEXT NOT NULL,
  address TEXT NOT NULL,
  created_block INTEGER NOT NULL,
  created_log_index INTEGER NOT NULL,
  created_tx TEXT NOT NULL,
  meta_json TEXT NOT NULL,
  PRIMARY KEY (kind, address)
) STRICT, WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS compact_registry_coverage (
  kind TEXT PRIMARY KEY,
  from_block INTEGER NOT NULL,
  through_block INTEGER NOT NULL,
  through_hash TEXT NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS compact_checkpoint (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  hour_start INTEGER NOT NULL,
  last_block INTEGER NOT NULL,
  last_hash TEXT NOT NULL
) STRICT;`;

// Key-sorted JSON, so a hash depends on values only and never on property order.
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}
const sha256 = (text) => createHash('sha256').update(text).digest('hex');

// Validates one processHour result and builds its canonical rows. Only a complete spine hour is ever written; each family
// is either available with every field present, or unavailable with a reason and every field null.
function hourRows(result) {
  if (result?.definitionVersion !== COMPACT_DEFINITION_VERSION) throw new StoreError('definition_version_mismatch');
  if (result.chainId !== ARC_CHAIN_ID) throw new StoreError('chain_id_mismatch');
  const range = result?.range;
  const network = result?.network;
  if (range?.kind !== 'hour' || !Number.isSafeInteger(range.hourStart) || range.hourStart % HOUR !== 0 || range.hourEnd !== range.hourStart + HOUR
    || network?.status !== 'available' || network.blockCount !== range.lastBlock - range.firstBlock + 1
    || !Array.isArray(result.activeAddresses) || result.activeAddresses.length !== network.uniqueActiveAddresses
    || !result.activeAddresses.every((address) => ADDRESS.test(address))) throw new StoreError('hour_not_complete');
  const families = FAMILIES.map((name) => {
    const family = result.families?.[name];
    const fields = FAMILY_FIELDS[name];
    if (family?.status === 'available' && fields.every((field) => family[field] !== undefined && family[field] !== null)) {
      const json = canonical(Object.fromEntries(fields.map((field) => [field, family[field]])));
      return { name, status: 'available', reason: null, json, sha: sha256(json) };
    }
    if (family?.status === 'unavailable' && typeof family.reason === 'string' && fields.every((field) => family[field] === null)) {
      return { name, status: 'unavailable', reason: family.reason, json: null, sha: null };
    }
    throw new StoreError('hour_inconsistent');
  });
  if (result.complete !== families.every((family) => family.status === 'available')) throw new StoreError('hour_inconsistent');
  const v3 = result.registry?.uniswapV3 ?? null;
  if ((families.find((family) => family.name === 'uniswapV3').status === 'available') !== Boolean(v3)
    || (v3 && (v3.through !== range.lastBlock || v3.throughHash !== range.lastHash || !Array.isArray(v3.created)))) {
    throw new StoreError('hour_inconsistent');
  }
  const networkJson = canonical(network);
  return { families, v3, networkJson, networkSha: sha256(canonical({ definitionVersion: result.definitionVersion, range, network })) };
}

export function createCompactStore(db) {
  // An existing compact database must already be this schema version. Anything else (a Stage 1 file, compact tables
  // without a version row) is refused by reads alone, before any pragma, table or row touches the file.
  const versionOf = () => db.prepare('SELECT value FROM compact_meta WHERE key = ?').get('schema_version')?.value;
  const existing = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name GLOB 'compact_*'").all().map((row) => row.name);
  if (existing.length && (!existing.includes('compact_meta') || versionOf() !== COMPACT_SCHEMA_VERSION)) {
    throw new StoreError('schema_version_mismatch');
  }
  db.exec(PRAGMAS);
  // A new database gets every table and its version row in one transaction, so it is never left half created.
  db.exec('BEGIN IMMEDIATE');
  try {
    db.exec(SCHEMA);
    db.prepare('INSERT OR IGNORE INTO compact_meta (key, value) VALUES (?, ?)').run('schema_version', COMPACT_SCHEMA_VERSION);
    db.exec('COMMIT');
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch { /* the original error is the one to report */ }
    throw error;
  }
  if (versionOf() !== COMPACT_SCHEMA_VERSION) throw new StoreError('schema_version_mismatch');
  const int = (value) => BigInt(value); // bind as SQLite INTEGER, never REAL
  const sql = {
    hour: db.prepare('SELECT hour_start, first_block, last_block, parent_hash, last_hash, network_sha256 FROM compact_hours WHERE hour_start = ?'),
    insertHour: db.prepare(`INSERT INTO compact_hours (hour_start, definition_version, first_block, last_block, parent_hash, first_hash,
      last_hash, block_count, transaction_count, unique_active_addresses, network_json, network_sha256) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
    family: db.prepare('SELECT status, metrics_sha256 FROM compact_family_hours WHERE hour_start = ? AND family = ?'),
    families: db.prepare('SELECT family, status, reason, metrics_json FROM compact_family_hours WHERE hour_start = ? ORDER BY family'),
    insertFamily: db.prepare(`INSERT INTO compact_family_hours (hour_start, family, status, reason, metrics_json, metrics_sha256)
      VALUES (?, ?, ?, ?, ?, ?)`),
    upgradeFamily: db.prepare(`UPDATE compact_family_hours SET status = 'available', reason = NULL, metrics_json = ?, metrics_sha256 = ?
      WHERE hour_start = ? AND family = ? AND status = 'unavailable'`),
    newestHour: db.prepare('SELECT MAX(hour_start) AS hour_start FROM compact_hours'),
    insertAddress: db.prepare('INSERT INTO compact_hour_addresses (hour_start, address) VALUES (?, ?)'),
    pruneAddresses: db.prepare('DELETE FROM compact_hour_addresses WHERE hour_start <= ?'),
    windowHours: db.prepare(`SELECT h.unique_active_addresses AS expected,
      (SELECT COUNT(*) FROM compact_hour_addresses a WHERE a.hour_start = h.hour_start) AS stored
      FROM compact_hours h WHERE h.hour_start BETWEEN ? AND ?`),
    windowUnique: db.prepare('SELECT COUNT(DISTINCT address) AS count FROM compact_hour_addresses WHERE hour_start BETWEEN ? AND ?'),
    pool: db.prepare('SELECT created_block, created_log_index, created_tx FROM compact_registry WHERE kind = ? AND address = ?'),
    pools: db.prepare('SELECT address FROM compact_registry WHERE kind = ?'),
    insertPool: db.prepare(`INSERT INTO compact_registry (kind, address, created_block, created_log_index, created_tx, meta_json)
      VALUES (?, ?, ?, ?, ?, ?)`),
    coverage: db.prepare('SELECT from_block, through_block, through_hash FROM compact_registry_coverage WHERE kind = ?'),
    setCoverage: db.prepare(`INSERT INTO compact_registry_coverage (kind, from_block, through_block, through_hash) VALUES (?, ?, ?, ?)
      ON CONFLICT (kind) DO UPDATE SET through_block = excluded.through_block, through_hash = excluded.through_hash`),
    checkpoint: db.prepare('SELECT hour_start, last_block, last_hash FROM compact_checkpoint WHERE id = 1'),
    setCheckpoint: db.prepare(`INSERT INTO compact_checkpoint (id, hour_start, last_block, last_hash) VALUES (1, ?, ?, ?)
      ON CONFLICT (id) DO UPDATE SET hour_start = excluded.hour_start, last_block = excluded.last_block, last_hash = excluded.last_hash`),
  };
  const checkpoint = () => {
    const row = sql.checkpoint.get();
    return row ? { hourStart: row.hour_start, lastBlock: row.last_block, lastHash: row.last_hash } : null;
  };
  const moveCheckpoint = (row) => sql.setCheckpoint.run(int(row.hour_start), int(row.last_block), row.last_hash);
  const coverage = () => {
    const row = sql.coverage.get(V3_POOL_KIND);
    return row ? { fromBlock: row.from_block, through: row.through_block, throughHash: row.through_hash } : null;
  };

  function transaction(work, beforeCommit = null) {
    db.exec('BEGIN IMMEDIATE');
    try {
      const value = work();
      beforeCommit?.(); // test hook: runs after every write and before COMMIT
      db.exec('COMMIT');
      return value;
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch { /* the original error is the one to report */ }
      throw error;
    }
  }

  // The checkpoint is the end of the contiguous run of spine-complete hours that starts at the first committed hour.
  // It only moves onto the next hour when that hour's first block directly follows the checkpoint's last block and
  // its parent hash is the checkpoint's last block hash: adjacent numbers alone never link two hours.
  function advanceCheckpoint(insertedHour) {
    if (!checkpoint()) moveCheckpoint(sql.hour.get(int(insertedHour)));
    for (let current = checkpoint(), next; (next = sql.hour.get(int(current.hourStart + HOUR))); current = checkpoint()) {
      if (next.first_block !== current.lastBlock + 1 || next.parent_hash !== current.lastHash) throw new StoreError('checkpoint_discontinuity');
      moveCheckpoint(next);
    }
  }

  // Identities only for the latest 24 hours (by the newest stored hour): no supported window needs anything older.
  function storeAddresses(hourStart, addresses) {
    const horizon = sql.newestHour.get().hour_start - ADDRESS_WINDOW_HOURS * HOUR;
    if (hourStart > horizon) for (const address of addresses) sql.insertAddress.run(int(hourStart), Buffer.from(address.slice(2), 'hex'));
    sql.pruneAddresses.run(int(horizon));
  }

  // A pool row is written once; the same pool can never be recorded with another creation log.
  function insertPools(created) {
    for (const pool of created) {
      const stored = sql.pool.get(V3_POOL_KIND, pool.address);
      if (stored) {
        if (stored.created_block !== pool.createdBlock || stored.created_log_index !== pool.createdLogIndex || stored.created_tx !== pool.createdTx) {
          throw new StoreError('registry_conflict');
        }
        continue;
      }
      sql.insertPool.run(V3_POOL_KIND, pool.address, int(pool.createdBlock), int(pool.createdLogIndex), pool.createdTx,
        canonical({ token0: pool.token0, token1: pool.token1, fee: pool.fee, tickSpacing: pool.tickSpacing }));
    }
  }

  // An hour with V3 available validated all of its PoolCreated logs against its spine, so a registry that reaches the
  // block before the hour (with the same hash) or into the hour becomes complete through the hour's last block.
  function advanceRegistry(range, v3) {
    insertPools(v3.created);
    const current = coverage();
    if (!current || current.through >= range.lastBlock || current.through < range.firstBlock - 1) return;
    if (current.through === range.firstBlock - 1 && current.throughHash !== range.parentHash) return;
    sql.setCoverage.run(V3_POOL_KIND, int(current.fromBlock), int(range.lastBlock), range.lastHash);
  }

  // Outcomes: inserted | unchanged | upgraded. A stored hour is immutable except that an unavailable family becomes
  // available when the same hour (same network hash) is processed again; an available family is never replaced.
  function commitHour(result, { beforeCommit = null } = {}) {
    const rows = hourRows(result);
    const { range, network } = result;
    return transaction(() => {
      const existing = sql.hour.get(int(range.hourStart));
      if (existing && existing.network_sha256 !== rows.networkSha) throw new StoreError('hour_conflict');
      let outcome = existing ? 'unchanged' : 'inserted';
      if (!existing) {
        // Forward only: after the first hour, a new hour must be the checkpoint's next canonical hour, so no hour is ever
        // stored ahead of (or behind) the contiguous, hash-linked run. Refused before any row is written.
        const current = checkpoint();
        if (current && range.hourStart > current.hourStart + HOUR) throw new StoreError('checkpoint_gap');
        if (current && range.hourStart < current.hourStart + HOUR) throw new StoreError('hour_before_checkpoint');
        if (current && (range.firstBlock !== current.lastBlock + 1 || range.parentHash !== current.lastHash)) {
          throw new StoreError('checkpoint_discontinuity');
        }
        sql.insertHour.run(int(range.hourStart), result.definitionVersion, int(range.firstBlock), int(range.lastBlock), range.parentHash,
          range.firstHash, range.lastHash, int(network.blockCount), int(network.transactionCount), int(network.uniqueActiveAddresses),
          rows.networkJson, rows.networkSha);
        for (const family of rows.families) {
          sql.insertFamily.run(int(range.hourStart), family.name, family.status, family.reason, family.json, family.sha);
        }
        storeAddresses(range.hourStart, result.activeAddresses);
        advanceCheckpoint(range.hourStart);
      } else {
        for (const family of rows.families) {
          const stored = sql.family.get(int(range.hourStart), family.name);
          if (!stored) throw new StoreError('hour_inconsistent');
          if (stored.status === 'available') {
            if (family.status === 'available' && family.sha !== stored.metrics_sha256) throw new StoreError('hour_conflict');
          } else if (family.status === 'available') {
            sql.upgradeFamily.run(family.json, family.sha, int(range.hourStart), family.name);
            outcome = 'upgraded';
          }
        }
      }
      if (rows.v3) advanceRegistry(range, rows.v3);
      return { outcome, checkpoint: checkpoint() };
    }, beforeCommit);
  }

  // A registry.js scan: the bootstrap (no coverage yet) or a catch-up that starts right after the stored coverage.
  function extendRegistry(registryScan) {
    return transaction(() => {
      const current = coverage();
      if (registryScan?.kind !== V3_POOL_KIND || (current
        ? registryScan.previousThrough !== current.through || registryScan.fromBlock !== current.fromBlock
        : registryScan.previousThrough !== null)) throw new StoreError('registry_discontinuity');
      insertPools(registryScan.created);
      sql.setCoverage.run(V3_POOL_KIND, int(registryScan.fromBlock), int(registryScan.through), registryScan.throughHash);
      return coverage();
    });
  }

  // Exact unique active addresses over the `hours` complete hours ending with endHourStart, or null unless every hour is
  // stored and (for 6H/24H) still holds its full identity set. Only 1H, 6H and 24H exist; nothing longer is stored.
  function uniqueActiveAddresses(endHourStart, hours) {
    if (!UNIQUE_ADDRESS_WINDOWS.includes(hours) || !Number.isSafeInteger(endHourStart) || endHourStart % HOUR !== 0) {
      throw new StoreError('unsupported_window');
    }
    const start = endHourStart - (hours - 1) * HOUR;
    const rows = sql.windowHours.all(int(start), int(endHourStart));
    if (rows.length !== hours) return null;
    if (hours === 1) return rows[0].expected;
    if (rows.some((row) => row.stored !== row.expected)) return null;
    return sql.windowUnique.get(int(start), int(endHourStart)).count;
  }

  return Object.freeze({
    commitHour,
    checkpoint,
    extendRegistry,
    uniqueActiveAddresses,
    hourCount: () => db.prepare('SELECT COUNT(*) AS count FROM compact_hours').get().count,
    familyRows: (hourStart) => sql.families.all(int(hourStart)).map((row) => ({ family: row.family, status: row.status, reason: row.reason,
      metrics: row.metrics_json === null ? null : JSON.parse(row.metrics_json) })),
    v3Registry() {
      const current = coverage();
      return current && { ...current, pools: new Set(sql.pools.all(V3_POOL_KIND).map((row) => row.address)) };
    },
  });
}
