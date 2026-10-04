// Compact engine: durable store for finished hours on built-in node:sqlite. The caller opens the DatabaseSync, so this
// module loads on any Node version. Raw blocks, transactions, receipts and logs are never stored. Per hour: one network
// row (only for a complete, validated block spine), one row per protocol family (available with metrics, or unavailable
// with null metrics, never zero), and the hour's active-address identities, kept only for the latest 24 hours so 1H, 6H
// and 24H unique counts are exact. Plus the official Uniswap V3 pool registry and its explicit coverage. An hour, its
// family rows, its addresses, its registry rows and the contiguous checkpoint are written in one transaction.
// Family definitions: every family's definition version is recorded in compact_meta (`family_version:<name>`) the first
// time the database is opened with that family. A database whose recorded version differs from the running code is refused
// before anything is written: a changed definition needs an explicit migration, never a silent mix of old and new rows.
// A family added later (Stage 3: protocol families) has no row for hours stored before it; replaying such an hour inserts
// its row (outcome `upgraded`) without touching the hour, its other families or the checkpoint.
// Projections (projections.js: Uniswap pool-hours, recent DEX activity, the V4 pool registry) are additive and are NOT
// families: own tables, own status rows (compact_projection_hours), own `projection_version:<name>` meta rows. They are
// written in the same transaction as their hour, re-validated and re-reconciled here against the hour's family counters,
// and a projection that fails any check is stored as unavailable, never partially, without blocking its hour.
import { createHash } from 'node:crypto';
import { FAMILY_FIELDS, FAMILY_WINDOWS } from './families.js';
import {
  ACTIVITY_KINDS, ACTIVITY_ROWS_PER_KIND, POOL_PROJECTIONS, poolHourCutoff, PROJECTION_REASONS, PROJECTION_VERSIONS, PROJECTIONS,
  reconcilePoolRows, sha256Of, V4_POOL_KIND, validActivityRow, validPoolRow, validV4Record,
} from './projections.js';
import { ARC_CHAIN_ID } from './provider.js';
import { V3_POOL_KIND } from './registry.js';
import { COMPACT_DEFINITION_VERSION, FAMILY_VERSIONS } from './sources.js';
import { sumWindow } from './windows.js';

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
) STRICT;
CREATE TABLE IF NOT EXISTS compact_projection_hours (
  hour_start INTEGER NOT NULL REFERENCES compact_hours (hour_start),
  projection TEXT NOT NULL,
  status TEXT NOT NULL,
  reason TEXT,
  row_count INTEGER,
  rows_sha256 TEXT,
  PRIMARY KEY (hour_start, projection),
  CHECK ((status = 'available' AND reason IS NULL AND row_count IS NOT NULL AND rows_sha256 IS NOT NULL)
    OR (status = 'unavailable' AND reason IS NOT NULL AND row_count IS NULL AND rows_sha256 IS NULL))
) STRICT, WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS compact_pool_hours (
  hour_start INTEGER NOT NULL REFERENCES compact_hours (hour_start),
  protocol TEXT NOT NULL CHECK (protocol IN ('uniswap_v3', 'uniswap_v4')),
  pool TEXT NOT NULL,
  swap_count INTEGER NOT NULL CHECK (swap_count >= 0),
  token0_in_raw TEXT NOT NULL,
  token0_out_raw TEXT NOT NULL,
  token1_in_raw TEXT NOT NULL,
  token1_out_raw TEXT NOT NULL,
  add_count INTEGER NOT NULL CHECK (add_count >= 0),
  remove_count INTEGER NOT NULL CHECK (remove_count >= 0),
  poke_count INTEGER NOT NULL CHECK (poke_count >= 0),
  add_amount0_raw TEXT,
  add_amount1_raw TEXT,
  remove_amount0_raw TEXT,
  remove_amount1_raw TEXT,
  PRIMARY KEY (hour_start, protocol, pool),
  CHECK ((protocol = 'uniswap_v3' AND add_amount0_raw IS NOT NULL AND add_amount1_raw IS NOT NULL
      AND remove_amount0_raw IS NOT NULL AND remove_amount1_raw IS NOT NULL)
    OR (protocol = 'uniswap_v4' AND add_amount0_raw IS NULL AND add_amount1_raw IS NULL
      AND remove_amount0_raw IS NULL AND remove_amount1_raw IS NULL))
) STRICT, WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS compact_dex_activity (
  block_number INTEGER NOT NULL,
  log_index INTEGER NOT NULL,
  hour_start INTEGER NOT NULL REFERENCES compact_hours (hour_start),
  block_timestamp INTEGER NOT NULL,
  tx_hash TEXT NOT NULL,
  tx_from TEXT NOT NULL,
  protocol TEXT NOT NULL CHECK (protocol IN ('uniswap_v3', 'uniswap_v4')),
  kind TEXT NOT NULL CHECK (kind IN ('swap', 'add', 'remove')),
  pool TEXT NOT NULL,
  amount0_raw TEXT,
  amount1_raw TEXT,
  amount_basis TEXT NOT NULL CHECK (amount_basis IN ('v3_pool_delta', 'v3_liquidity_amount', 'v4_swap_delta', 'none')),
  counterparty TEXT,
  counterparty_kind TEXT NOT NULL CHECK (counterparty_kind IN ('swap_recipient', 'liquidity_owner', 'event_sender', 'none')),
  PRIMARY KEY (block_number, log_index),
  CHECK ((counterparty_kind = 'none') = (counterparty IS NULL))
) STRICT, WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS compact_dex_activity_kind ON compact_dex_activity (kind, block_number DESC, log_index DESC);`;

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
  // Projections never make an hour invalid: a missing set is simply not written; a bad one is stored as unavailable.
  const projections = result.projections === undefined ? null : normalizeProjections(result.projections, range, result.families);
  return { families, v3, networkJson, networkSha: sha256(canonical({ definitionVersion: result.definitionVersion, range, network })), projections };
}

const PROTOCOL_FAMILY = Object.freeze({ uniswap_v3: 'uniswapV3', uniswap_v4: 'uniswapV4' });
const unavailableProjection = (reason) => ({ status: 'unavailable', reason: PROJECTION_REASONS.includes(reason) ? reason : 'projection_error' });

// Re-validates a projection set (from the hour processor or the projection backfill) against its hour before anything is
// written: row shapes, V4 registry records (poolId = keccak256(PoolKey)), activity rows inside the hour, digests, and an
// exact reconciliation with the hour's family counters. Anything that fails becomes unavailable; nothing is partial.
// range: { hourStart, firstBlock, lastBlock }. families: { uniswapV3, uniswapV4 } results or stored metrics with status.
function normalizeProjections(projections, range, families) {
  const out = {};
  for (const [name, protocol] of Object.entries(POOL_PROJECTIONS)) {
    const entry = projections?.[name];
    if (entry?.status !== 'available') {
      out[name] = unavailableProjection(entry?.reason);
      continue;
    }
    const { rows } = entry;
    const registry = protocol === 'uniswap_v4' ? entry.registry : undefined;
    const valid = Array.isArray(rows) && rows.every((row) => validPoolRow(row, protocol)) && new Set(rows.map((row) => row.pool)).size === rows.length
      && (protocol === 'uniswap_v3' || (Array.isArray(registry) && new Set(registry.map((pool) => pool?.poolId)).size === registry.length
        && registry.every((pool) => validV4Record(pool) && pool.createdBlock >= range.firstBlock && pool.createdBlock <= range.lastBlock)));
    if (!valid) {
      out[name] = unavailableProjection('projection_error');
      continue;
    }
    const reason = reconcilePoolRows(name, rows, families?.[PROTOCOL_FAMILY[protocol]], { initializeCount: registry ? registry.length : null });
    const sha = sha256Of(registry ? { rows, registry } : { rows });
    if (reason || (entry.rowsSha256 !== undefined && entry.rowsSha256 !== sha)) out[name] = unavailableProjection(reason ?? 'projection_error');
    else out[name] = { status: 'available', rows, registry, sha };
  }
  const activity = projections?.dex_activity;
  if (activity?.status !== 'available') out.dex_activity = unavailableProjection(activity?.reason);
  else if (out.uniswap_v3_pools.status !== 'available' || out.uniswap_v4_pools.status !== 'available') {
    out.dex_activity = unavailableProjection('projection_inputs_unavailable');
  } else {
    const { rows } = activity;
    const valid = Array.isArray(rows) && rows.every((row) => validActivityRow(row) && row.hourStart === range.hourStart
      && row.blockNumber >= range.firstBlock && row.blockNumber <= range.lastBlock)
      && new Set(rows.map((row) => `${row.blockNumber}:${row.logIndex}`)).size === rows.length
      && ACTIVITY_KINDS.every((kind) => rows.filter((row) => row.kind === kind).length <= ACTIVITY_ROWS_PER_KIND);
    const sha = valid ? sha256Of({ rows }) : null;
    out.dex_activity = !valid || (activity.rowsSha256 !== undefined && activity.rowsSha256 !== sha) ? unavailableProjection('projection_error')
      : { status: 'available', rows, sha };
  }
  return out;
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
    const setMeta = db.prepare('INSERT OR IGNORE INTO compact_meta (key, value) VALUES (?, ?)');
    setMeta.run('schema_version', COMPACT_SCHEMA_VERSION);
    for (const [name, version] of Object.entries(FAMILY_VERSIONS)) {
      setMeta.run(`family_version:${name}`, version);
      if (db.prepare('SELECT value FROM compact_meta WHERE key = ?').get(`family_version:${name}`)?.value !== version) {
        throw new StoreError('family_definition_mismatch');
      }
    }
    // Projection definitions, recorded like families but under their own prefix: never a family, never in repair logic.
    for (const [name, version] of Object.entries(PROJECTION_VERSIONS)) {
      setMeta.run(`projection_version:${name}`, version);
      if (db.prepare('SELECT value FROM compact_meta WHERE key = ?').get(`projection_version:${name}`)?.value !== version) {
        throw new StoreError('projection_definition_mismatch');
      }
    }
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
    windowFamily: db.prepare(`SELECT h.hour_start, f.status, f.metrics_json FROM compact_hours h
      LEFT JOIN compact_family_hours f ON f.hour_start = h.hour_start AND f.family = ? WHERE h.hour_start BETWEEN ? AND ? ORDER BY h.hour_start`),
    pool: db.prepare('SELECT created_block, created_log_index, created_tx FROM compact_registry WHERE kind = ? AND address = ?'),
    pools: db.prepare('SELECT address FROM compact_registry WHERE kind = ?'),
    insertPool: db.prepare(`INSERT INTO compact_registry (kind, address, created_block, created_log_index, created_tx, meta_json)
      VALUES (?, ?, ?, ?, ?, ?)`),
    coverage: db.prepare('SELECT from_block, through_block, through_hash FROM compact_registry_coverage WHERE kind = ?'),
    setCoverage: db.prepare(`INSERT INTO compact_registry_coverage (kind, from_block, through_block, through_hash) VALUES (?, ?, ?, ?)
      ON CONFLICT (kind) DO UPDATE SET through_block = excluded.through_block, through_hash = excluded.through_hash`),
    hourRange: db.prepare('SELECT hour_start, first_block, last_block, parent_hash, last_hash FROM compact_hours WHERE hour_start = ?'),
    uniswapFamilies: db.prepare(`SELECT family, status, metrics_json FROM compact_family_hours WHERE hour_start = ?
      AND family IN ('uniswapV3', 'uniswapV4')`),
    projection: db.prepare('SELECT status, rows_sha256 FROM compact_projection_hours WHERE hour_start = ? AND projection = ?'),
    projections: db.prepare(`SELECT projection, status, reason, row_count, rows_sha256 FROM compact_projection_hours WHERE hour_start = ?
      ORDER BY projection`),
    insertProjection: db.prepare(`INSERT INTO compact_projection_hours (hour_start, projection, status, reason, row_count, rows_sha256)
      VALUES (?, ?, ?, ?, ?, ?)`),
    upgradeProjection: db.prepare(`UPDATE compact_projection_hours SET status = 'available', reason = NULL, row_count = ?, rows_sha256 = ?
      WHERE hour_start = ? AND projection = ? AND status = 'unavailable'`),
    insertPoolHour: db.prepare(`INSERT INTO compact_pool_hours (hour_start, protocol, pool, swap_count, token0_in_raw, token0_out_raw,
      token1_in_raw, token1_out_raw, add_count, remove_count, poke_count, add_amount0_raw, add_amount1_raw, remove_amount0_raw,
      remove_amount1_raw) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
    poolHours: db.prepare('SELECT * FROM compact_pool_hours WHERE hour_start = ? AND protocol = ? ORDER BY pool'),
    insertActivity: db.prepare(`INSERT OR IGNORE INTO compact_dex_activity (block_number, log_index, hour_start, block_timestamp, tx_hash,
      tx_from, protocol, kind, pool, amount0_raw, amount1_raw, amount_basis, counterparty, counterparty_kind)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
    pruneActivity: db.prepare(`DELETE FROM compact_dex_activity WHERE kind = ? AND (block_number, log_index) NOT IN
      (SELECT block_number, log_index FROM compact_dex_activity WHERE kind = ? ORDER BY block_number DESC, log_index DESC LIMIT ?)`),
    activity: db.prepare(`SELECT * FROM compact_dex_activity WHERE (?1 IS NULL OR kind = ?1)
      ORDER BY block_number DESC, log_index DESC LIMIT ?2`),
    prunePoolHours: db.prepare('DELETE FROM compact_pool_hours WHERE hour_start <= ?'),
    pruneProjectionHours: db.prepare('DELETE FROM compact_projection_hours WHERE hour_start <= ?'),
    registryCount: db.prepare('SELECT COUNT(*) AS count FROM compact_registry WHERE kind = ?'),
    checkpoint: db.prepare('SELECT hour_start, last_block, last_hash FROM compact_checkpoint WHERE id = 1'),
    setCheckpoint: db.prepare(`INSERT INTO compact_checkpoint (id, hour_start, last_block, last_hash) VALUES (1, ?, ?, ?)
      ON CONFLICT (id) DO UPDATE SET hour_start = excluded.hour_start, last_block = excluded.last_block, last_hash = excluded.last_hash`),
  };
  const checkpoint = () => {
    const row = sql.checkpoint.get();
    return row ? { hourStart: row.hour_start, lastBlock: row.last_block, lastHash: row.last_hash } : null;
  };
  const moveCheckpoint = (row) => sql.setCheckpoint.run(int(row.hour_start), int(row.last_block), row.last_hash);
  const coverageOf = (kind) => {
    const row = sql.coverage.get(kind);
    return row ? { fromBlock: row.from_block, through: row.through_block, throughHash: row.through_hash } : null;
  };
  const coverage = () => coverageOf(V3_POOL_KIND);

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

  // Registry row identity and metadata per kind. V3: the official pool address. V4: the PoolManager poolId, with its full
  // PoolKey (currency 0x0 is the native currency, hooks kept: hooked pools are part of all-pair coverage).
  const REGISTRY_ROW = Object.freeze({
    [V3_POOL_KIND]: (pool) => [pool.address, canonical({ token0: pool.token0, token1: pool.token1, fee: pool.fee, tickSpacing: pool.tickSpacing })],
    [V4_POOL_KIND]: (pool) => [pool.poolId, canonical({ currency0: pool.currency0, currency1: pool.currency1, fee: pool.fee,
      tickSpacing: pool.tickSpacing, hooks: pool.hooks })],
  });

  // A pool row is written once; the same pool can never be recorded with another creation log.
  function insertRegistryRows(kind, created) {
    for (const pool of created) {
      const [key, meta] = REGISTRY_ROW[kind](pool);
      const stored = sql.pool.get(kind, key);
      if (stored) {
        if (stored.created_block !== pool.createdBlock || stored.created_log_index !== pool.createdLogIndex || stored.created_tx !== pool.createdTx) {
          throw new StoreError('registry_conflict');
        }
        continue;
      }
      sql.insertPool.run(kind, key, int(pool.createdBlock), int(pool.createdLogIndex), pool.createdTx, meta);
    }
  }
  const insertPools = (created) => insertRegistryRows(V3_POOL_KIND, created);

  // A range whose creation logs were all validated extends a registry that reaches the block before it (with the same
  // hash) or into it, through the range's last block. Coverage never skips a gap.
  function advanceCoverage(kind, range) {
    const current = coverageOf(kind);
    if (!current || current.through >= range.lastBlock || current.through < range.firstBlock - 1) return;
    if (current.through === range.firstBlock - 1 && current.throughHash !== range.parentHash) return;
    sql.setCoverage.run(kind, int(current.fromBlock), int(range.lastBlock), range.lastHash);
  }

  // An hour with V3 available validated all of its PoolCreated logs against its spine, so a registry that reaches the
  // block before the hour (with the same hash) or into the hour becomes complete through the hour's last block.
  function advanceRegistry(range, v3) {
    insertPools(v3.created);
    advanceCoverage(V3_POOL_KIND, range);
  }

  // Writes one hour's normalized projections (see normalizeProjections). An available projection is immutable: a later
  // identical one is `unchanged`, a different one is reported as `conflict` and nothing is replaced. An unavailable one is
  // upgraded when an available one arrives. Recent activity is idempotent by (block_number, log_index) and pruned to the
  // newest rows per kind; pool-hours and projection status rows follow the 35-day retention. Returns name -> outcome.
  function writeProjections(range, normalized) {
    const hour = int(range.hourStart);
    const report = {};
    const projections = { ...normalized };
    // A poolId already stored with another creation log cannot be initialized twice on one chain: that hour's V4 projection
    // (and the activity that depends on it) is unavailable, while the hour and its families still commit.
    const v4 = projections.uniswap_v4_pools;
    if (v4.status === 'available' && v4.registry.some((pool) => {
      const stored = sql.pool.get(V4_POOL_KIND, pool.poolId);
      return stored && (stored.created_block !== pool.createdBlock || stored.created_log_index !== pool.createdLogIndex || stored.created_tx !== pool.createdTx);
    })) {
      projections.uniswap_v4_pools = unavailableProjection('duplicate_v4_initialize');
      if (projections.dex_activity.status === 'available') projections.dex_activity = unavailableProjection('projection_inputs_unavailable');
    }
    for (const name of PROJECTIONS) {
      const entry = projections[name];
      const stored = sql.projection.get(hour, name);
      if (stored?.status === 'available') {
        report[name] = entry.status === 'available' && entry.sha !== stored.rows_sha256 ? 'conflict' : 'unchanged';
        continue;
      }
      if (entry.status !== 'available') {
        if (!stored) sql.insertProjection.run(hour, name, 'unavailable', entry.reason, null, null);
        report[name] = stored ? 'unchanged' : 'unavailable';
        continue;
      }
      if (name === 'dex_activity') {
        for (const row of entry.rows) {
          sql.insertActivity.run(int(row.blockNumber), int(row.logIndex), hour, int(row.blockTimestamp), row.txHash, row.txFrom, row.protocol,
            row.kind, row.pool, row.amount0Raw, row.amount1Raw, row.amountBasis, row.counterparty, row.counterpartyKind);
        }
      } else {
        const protocol = POOL_PROJECTIONS[name];
        for (const row of entry.rows) {
          sql.insertPoolHour.run(hour, protocol, row.pool, int(row.swapCount), row.token0InRaw, row.token0OutRaw, row.token1InRaw, row.token1OutRaw,
            int(row.addCount), int(row.removeCount), int(row.pokeCount), row.addAmount0Raw, row.addAmount1Raw, row.removeAmount0Raw, row.removeAmount1Raw);
        }
        if (protocol === 'uniswap_v4') {
          insertRegistryRows(V4_POOL_KIND, entry.registry);
          advanceCoverage(V4_POOL_KIND, range);
        }
      }
      if (stored) sql.upgradeProjection.run(int(entry.rows.length), entry.sha, hour, name);
      else sql.insertProjection.run(hour, name, 'available', null, int(entry.rows.length), entry.sha);
      report[name] = stored ? 'upgraded' : 'inserted';
    }
    for (const kind of ACTIVITY_KINDS) sql.pruneActivity.run(kind, kind, int(ACTIVITY_ROWS_PER_KIND));
    const cutoff = poolHourCutoff(sql.newestHour.get().hour_start);
    sql.prunePoolHours.run(int(cutoff));
    sql.pruneProjectionHours.run(int(cutoff));
    return report;
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
          if (!stored) {
            // A family added after this hour was stored: its first row for the hour, available or unavailable.
            sql.insertFamily.run(int(range.hourStart), family.name, family.status, family.reason, family.json, family.sha);
            outcome = 'upgraded';
          } else if (stored.status === 'available') {
            if (family.status === 'available' && family.sha !== stored.metrics_sha256) throw new StoreError('hour_conflict');
          } else if (family.status === 'available') {
            sql.upgradeFamily.run(family.json, family.sha, int(range.hourStart), family.name);
            outcome = 'upgraded';
          }
        }
      }
      if (rows.v3) advanceRegistry(range, rows.v3);
      // Same transaction as the hour: a crash leaves neither the hour nor its projections.
      const projections = rows.projections ? writeProjections(range, rows.projections) : null;
      return { outcome, checkpoint: checkpoint(), projections };
    }, beforeCommit);
  }

  // Projection-only commit for an hour that is already stored (the projection backfill): never touches the hour, its
  // families, the addresses or the checkpoint. The projections are reconciled against the stored family counters.
  function commitProjectionHour(hourStart, projections, { beforeCommit = null } = {}) {
    return transaction(() => {
      const hour = sql.hourRange.get(int(hourStart));
      if (!hour) throw new StoreError('hour_missing');
      const families = Object.fromEntries(sql.uniswapFamilies.all(int(hourStart)).map((row) => [row.family,
        row.status === 'available' ? { status: 'available', ...JSON.parse(row.metrics_json) } : { status: row.status }]));
      const range = { hourStart, firstBlock: hour.first_block, lastBlock: hour.last_block, parentHash: hour.parent_hash, lastHash: hour.last_hash };
      return writeProjections(range, normalizeProjections(projections, range, families));
    }, beforeCommit);
  }

  // A registry.js scan: the bootstrap (no coverage yet) or a catch-up that starts right after the stored coverage.
  function extendRegistryOf(kind, registryScan) {
    return transaction(() => {
      const current = coverageOf(kind);
      if (registryScan?.kind !== kind || (current
        ? registryScan.previousThrough !== current.through || registryScan.fromBlock !== current.fromBlock
        : registryScan.previousThrough !== null)) throw new StoreError('registry_discontinuity');
      if (kind === V4_POOL_KIND && !registryScan.created.every(validV4Record)) throw new StoreError('registry_record_invalid');
      insertRegistryRows(kind, registryScan.created);
      sql.setCoverage.run(kind, int(registryScan.fromBlock), int(registryScan.through), registryScan.throughHash);
      return coverageOf(kind);
    });
  }
  const extendRegistry = (registryScan) => extendRegistryOf(V3_POOL_KIND, registryScan);

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

  // Sum of one family's additive metrics over the `hours` complete hours ending with endHourStart (windows.js), e.g. the
  // current 6H next to the 6H before it. Unavailable unless every hour is stored with that family available: a window is
  // never partial and missing evidence never counts as zero.
  function familyWindow(family, endHourStart, hours) {
    if (!FAMILY_WINDOWS[family] || !UNIQUE_ADDRESS_WINDOWS.includes(hours) || !Number.isSafeInteger(endHourStart) || endHourStart % HOUR !== 0) {
      throw new StoreError('unsupported_window');
    }
    const fromHour = endHourStart - (hours - 1) * HOUR;
    const rows = sql.windowFamily.all(family, int(fromHour), int(endHourStart));
    const base = { family, fromHour, toHour: endHourStart, hours };
    if (rows.length !== hours) return { ...base, status: 'unavailable', reason: 'hour_missing', metrics: null };
    const gap = rows.find((row) => row.status !== 'available');
    if (gap) return { ...base, status: 'unavailable', reason: gap.status ? 'family_unavailable' : 'family_not_processed', hourStart: gap.hour_start, metrics: null };
    return { ...base, status: 'available', metrics: sumWindow(FAMILY_WINDOWS[family], rows.map((row) => JSON.parse(row.metrics_json))) };
  }

  return Object.freeze({
    commitHour,
    checkpoint,
    extendRegistry,
    uniqueActiveAddresses,
    familyWindow,
    hourCount: () => db.prepare('SELECT COUNT(*) AS count FROM compact_hours').get().count,
    familyRows: (hourStart) => sql.families.all(int(hourStart)).map((row) => ({ family: row.family, status: row.status, reason: row.reason,
      metrics: row.metrics_json === null ? null : JSON.parse(row.metrics_json) })),
    v3Registry() {
      const current = coverage();
      return current && { ...current, pools: new Set(sql.pools.all(V3_POOL_KIND).map((row) => row.address)) };
    },
    // Projections (never families).
    commitProjectionHour,
    extendV4Registry: (registryScan) => extendRegistryOf(V4_POOL_KIND, registryScan),
    // Coverage and size only: V4 pool identities are resolved when read, never loaded whole into the hour processor.
    v4Registry: () => {
      const current = coverageOf(V4_POOL_KIND);
      return { coverage: current, pools: sql.registryCount.get(V4_POOL_KIND).count };
    },
    v4Pool(poolId) {
      const row = sql.pool.get(V4_POOL_KIND, poolId);
      return row ? { poolId, createdBlock: row.created_block, createdLogIndex: row.created_log_index, createdTx: row.created_tx,
        ...JSON.parse(db.prepare('SELECT meta_json FROM compact_registry WHERE kind = ? AND address = ?').get(V4_POOL_KIND, poolId).meta_json) } : null;
    },
    projectionStatus: (hourStart) => sql.projections.all(int(hourStart)).map((row) => ({ projection: row.projection, status: row.status,
      reason: row.reason, rowCount: row.row_count, rowsSha256: row.rows_sha256 })),
    poolHours: (hourStart, protocol) => sql.poolHours.all(int(hourStart), protocol).map((row) => ({ pool: row.pool, swapCount: row.swap_count,
      token0InRaw: row.token0_in_raw, token0OutRaw: row.token0_out_raw, token1InRaw: row.token1_in_raw, token1OutRaw: row.token1_out_raw,
      addCount: row.add_count, removeCount: row.remove_count, pokeCount: row.poke_count, addAmount0Raw: row.add_amount0_raw,
      addAmount1Raw: row.add_amount1_raw, removeAmount0Raw: row.remove_amount0_raw, removeAmount1Raw: row.remove_amount1_raw })),
    recentActivity: (kind = null, limit = ACTIVITY_ROWS_PER_KIND * ACTIVITY_KINDS.length) => sql.activity.all(kind, int(limit)).map((row) => ({
      blockNumber: row.block_number, logIndex: row.log_index, hourStart: row.hour_start, blockTimestamp: row.block_timestamp, txHash: row.tx_hash,
      txFrom: row.tx_from, protocol: row.protocol, kind: row.kind, pool: row.pool, amount0Raw: row.amount0_raw, amount1Raw: row.amount1_raw,
      amountBasis: row.amount_basis, counterparty: row.counterparty, counterpartyKind: row.counterparty_kind })),
  });
}
