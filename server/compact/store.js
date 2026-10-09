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
// Projections (projections.js: Uniswap pool-hours, pool price paths, recent DEX activity, the V4 pool registry) are
// additive and are NOT families: own tables, own status rows (compact_projection_hours), own `projection_version:<name>`
// meta rows. They are written in the same transaction as their hour, re-validated and re-reconciled here against the
// hour's family counters, and a projection that fails any check is stored as unavailable, never partially, without
// blocking its hour.
// Valuations (valuation.js: an hour's token prices and DEX USD volume) are derived here from stored projections and the
// pool registry, never fetched: own tables, own status rows (compact_valuation_hours), own `valuation_version:<name>` meta
// rows. They are derived in the transaction that writes their inputs, and for stored hours without them by a bounded pass
// without any RPC (derivePendingValuations). An available valuation is immutable; a failure never blocks its hour.
// Token metadata (token-metadata.js) is a read-once cache of ERC-20 symbol, name and decimals, never used for a value.
import { createHash } from 'node:crypto';
import { FAMILY_FIELDS, FAMILY_WINDOWS } from './families.js';
import {
  ACTIVITY_KINDS, ACTIVITY_ROWS_PER_KIND, POOL_PROJECTIONS, poolHourCutoff, PRICE_PATH_PROJECTIONS, PROJECTION_REASONS, PROJECTION_VERSIONS,
  PROJECTIONS, reconcilePoolRows, reconcilePricePaths, sha256Of, V4_POOL_KIND, validActivityRow, validPoolRow, validPricePathRow, validSwapFeeRow,
  validV4Record,
} from './projections.js';
import { ARC_CHAIN_ID } from './provider.js';
import { V3_POOL_KIND } from './registry.js';
import { COMPACT_DEFINITION_VERSION, FAMILY_VERSIONS } from './sources.js';
import { metadataExempt, TOKEN_METADATA_VERSION } from './token-metadata.js';
import { TVL_POOLS_PER_PROTOCOL, TVL_REASONS, TVL_VERSION } from './tvl.js';
import { hourFeesOf, hourVolumeOf, tokenPricesOf, VALUATION_REASONS, VALUATION_VERSIONS, VALUATIONS } from './valuation.js';
import { sumWindow } from './windows.js';

import { INTELLIGENCE_SQL, createIntelligenceRepository } from './intelligence-store.js';
import { DAILY_ACTIVE_ADDRESSES_SQL, createDailyActiveAddressesStore } from './daily-active-addresses.js';

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
CREATE INDEX IF NOT EXISTS compact_dex_activity_kind ON compact_dex_activity (kind, block_number DESC, log_index DESC);
CREATE TABLE IF NOT EXISTS compact_pool_price_hours (
  hour_start INTEGER NOT NULL REFERENCES compact_hours (hour_start),
  protocol TEXT NOT NULL CHECK (protocol IN ('uniswap_v3', 'uniswap_v4')),
  pool TEXT NOT NULL,
  swap_count INTEGER NOT NULL CHECK (swap_count > 0),
  first_swap_block INTEGER NOT NULL,
  last_swap_block INTEGER NOT NULL CHECK (last_swap_block >= first_swap_block),
  priced_blocks INTEGER NOT NULL CHECK (priced_blocks > 0),
  close_sqrt_price_x96 TEXT NOT NULL,
  close_liquidity TEXT NOT NULL,
  sqrt_price_block_sum TEXT NOT NULL,
  reserve0_block_sum TEXT NOT NULL,
  reserve1_block_sum TEXT NOT NULL,
  PRIMARY KEY (hour_start, protocol, pool)
) STRICT, WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS compact_valuation_hours (
  hour_start INTEGER NOT NULL REFERENCES compact_hours (hour_start),
  valuation TEXT NOT NULL,
  status TEXT NOT NULL,
  reason TEXT,
  row_count INTEGER,
  rows_sha256 TEXT,
  PRIMARY KEY (hour_start, valuation),
  CHECK ((status = 'available' AND reason IS NULL AND row_count IS NOT NULL AND rows_sha256 IS NOT NULL)
    OR (status = 'unavailable' AND reason IS NOT NULL AND row_count IS NULL AND rows_sha256 IS NULL))
) STRICT, WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS compact_token_price_hours (
  hour_start INTEGER NOT NULL REFERENCES compact_hours (hour_start),
  token TEXT NOT NULL,
  price_usd_e18 TEXT NOT NULL,
  source_protocol TEXT NOT NULL CHECK (source_protocol IN ('uniswap_v3', 'uniswap_v4')),
  source_pool TEXT NOT NULL,
  depth_usd_micros TEXT NOT NULL,
  source_count INTEGER NOT NULL CHECK (source_count > 0),
  PRIMARY KEY (hour_start, token)
) STRICT, WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS compact_dex_volume_hours (
  hour_start INTEGER NOT NULL REFERENCES compact_hours (hour_start),
  protocol TEXT NOT NULL CHECK (protocol IN ('uniswap_v3', 'uniswap_v4')),
  volume_usd_micros TEXT NOT NULL,
  valued_swaps INTEGER NOT NULL CHECK (valued_swaps >= 0),
  unvalued_swaps INTEGER NOT NULL CHECK (unvalued_swaps >= 0),
  PRIMARY KEY (hour_start, protocol)
) STRICT, WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS compact_pool_fee_hours (
  hour_start INTEGER NOT NULL REFERENCES compact_hours (hour_start),
  pool TEXT NOT NULL,
  swap_count INTEGER NOT NULL CHECK (swap_count > 0),
  fee_in0_e6 TEXT NOT NULL,
  fee_in1_e6 TEXT NOT NULL,
  fee_out0_e12 TEXT NOT NULL,
  fee_out1_e12 TEXT NOT NULL,
  PRIMARY KEY (hour_start, pool)
) STRICT, WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS compact_dex_fee_hours (
  hour_start INTEGER NOT NULL REFERENCES compact_hours (hour_start),
  protocol TEXT NOT NULL CHECK (protocol IN ('uniswap_v3', 'uniswap_v4')),
  fee_usd_micros TEXT NOT NULL,
  valued_swaps INTEGER NOT NULL CHECK (valued_swaps >= 0),
  unvalued_swaps INTEGER NOT NULL CHECK (unvalued_swaps >= 0),
  PRIMARY KEY (hour_start, protocol)
) STRICT, WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS compact_pool_tvl_hours (
  hour_start INTEGER NOT NULL REFERENCES compact_hours (hour_start),
  protocol TEXT NOT NULL CHECK (protocol IN ('uniswap_v3', 'uniswap_v4')),
  pool TEXT NOT NULL,
  status TEXT NOT NULL,
  reason TEXT,
  amount0_raw TEXT,
  amount1_raw TEXT,
  block_number INTEGER NOT NULL,
  PRIMARY KEY (hour_start, protocol, pool),
  CHECK ((status = 'available' AND reason IS NULL AND amount0_raw IS NOT NULL AND amount1_raw IS NOT NULL)
    OR (status = 'unavailable' AND reason IS NOT NULL AND amount0_raw IS NULL AND amount1_raw IS NULL))
) STRICT, WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS compact_token_metadata (
  token TEXT PRIMARY KEY CHECK (length(token) = 42),
  verified INTEGER NOT NULL CHECK (verified IN (0, 1)),
  symbol TEXT,
  name TEXT,
  decimals INTEGER,
  reason TEXT,
  read_block INTEGER NOT NULL,
  CHECK ((verified = 1 AND symbol IS NOT NULL AND decimals IS NOT NULL AND reason IS NULL)
    OR (verified = 0 AND symbol IS NULL AND name IS NULL AND decimals IS NULL AND reason IS NOT NULL))
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
  // Price paths: every row inside the hour's blocks, reconciled with the family swap counter and with this set's own pool
  // rows of the same protocol when those are available.
  for (const [name, protocol] of Object.entries(PRICE_PATH_PROJECTIONS)) {
    const entry = projections?.[name];
    if (entry?.status !== 'available') {
      out[name] = unavailableProjection(entry?.reason);
      continue;
    }
    const { rows } = entry;
    const valid = Array.isArray(rows) && rows.every((row) => validPricePathRow(row, protocol, range)) && new Set(rows.map((row) => row.pool)).size === rows.length;
    if (!valid) {
      out[name] = unavailableProjection('projection_error');
      continue;
    }
    const pools = out[protocol === 'uniswap_v3' ? 'uniswap_v3_pools' : 'uniswap_v4_pools'];
    const reason = reconcilePricePaths(rows, families?.[PROTOCOL_FAMILY[protocol]], pools.status === 'available' ? pools.rows : null);
    const sha = sha256Of({ rows });
    out[name] = reason || (entry.rowsSha256 !== undefined && entry.rowsSha256 !== sha) ? unavailableProjection(reason ?? 'projection_error')
      : { status: 'available', rows, sha };
  }
  // V4 swap fees: the same reconciliation as the V4 price paths.
  const fees = projections?.uniswap_v4_swap_fees;
  if (fees?.status !== 'available') out.uniswap_v4_swap_fees = unavailableProjection(fees?.reason);
  else if (!Array.isArray(fees.rows) || !fees.rows.every(validSwapFeeRow) || new Set(fees.rows.map((row) => row.pool)).size !== fees.rows.length) {
    out.uniswap_v4_swap_fees = unavailableProjection('projection_error');
  } else {
    const { rows } = fees;
    const reason = reconcilePricePaths(rows, families?.uniswapV4, out.uniswap_v4_pools.status === 'available' ? out.uniswap_v4_pools.rows : null);
    const sha = sha256Of({ rows });
    out.uniswap_v4_swap_fees = reason || (fees.rowsSha256 !== undefined && fees.rowsSha256 !== sha) ? unavailableProjection(reason ?? 'projection_error')
      : { status: 'available', rows, sha };
  }
  return out;
}

const VALUATION_PROTOCOLS = Object.freeze(['uniswap_v3', 'uniswap_v4']);
const unavailableValuation = (reason) => ({ status: 'unavailable', reason: VALUATION_REASONS.includes(reason) ? reason : 'valuation_error' });

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
    db.exec(INTELLIGENCE_SQL);
    db.exec(DAILY_ACTIVE_ADDRESSES_SQL);
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
    // Valuation and token metadata definitions, the same way: a changed definition is refused, never mixed.
    for (const [name, version] of Object.entries(VALUATION_VERSIONS)) {
      setMeta.run(`valuation_version:${name}`, version);
      if (db.prepare('SELECT value FROM compact_meta WHERE key = ?').get(`valuation_version:${name}`)?.value !== version) {
        throw new StoreError('valuation_definition_mismatch');
      }
    }
    setMeta.run('token_metadata_version', TOKEN_METADATA_VERSION);
    if (db.prepare('SELECT value FROM compact_meta WHERE key = ?').get('token_metadata_version')?.value !== TOKEN_METADATA_VERSION) {
      throw new StoreError('token_metadata_definition_mismatch');
    }
    setMeta.run('tvl_version', TVL_VERSION);
    if (db.prepare('SELECT value FROM compact_meta WHERE key = ?').get('tvl_version')?.value !== TVL_VERSION) {
      throw new StoreError('tvl_definition_mismatch');
    }
    db.exec('COMMIT');
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch { /* the original error is the one to report */ }
    throw error;
  }
  if (versionOf() !== COMPACT_SCHEMA_VERSION) throw new StoreError('schema_version_mismatch');
  const int = (value) => BigInt(value); // bind as SQLite INTEGER, never REAL
  const intelligence = createIntelligenceRepository(db);
  const dailyActiveAddresses = createDailyActiveAddressesStore(db);
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
    oldestHour: db.prepare('SELECT hour_start, first_block, parent_hash FROM compact_hours ORDER BY hour_start ASC LIMIT 1'),
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
    dauReplayCandidate: db.prepare(`
      SELECT h.hour_start
      FROM compact_hours h
      LEFT JOIN compact_daily_address_hours c ON c.hour_start = h.hour_start
      LEFT JOIN compact_daily_active_addresses d
        ON d.day_start = h.hour_start - (h.hour_start % 86400)
      WHERE c.hour_start IS NULL
        AND (
          d.day_start IS NULL
          OR (d.status = 'unavailable' AND d.reason = 'identity_not_captured')
        )
        AND (
          SELECT COUNT(*)
          FROM compact_hours x
          WHERE x.hour_start >= h.hour_start - (h.hour_start % 86400)
            AND x.hour_start < h.hour_start - (h.hour_start % 86400) + 86400
        ) = 24
      ORDER BY h.hour_start - (h.hour_start % 86400) DESC, h.hour_start ASC
      LIMIT 1
    `),
    hourByLastBlock: db.prepare('SELECT hour_start FROM compact_hours WHERE last_block = ?'),
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
    // Price paths, valuations and token metadata.
    insertPricePath: db.prepare(`INSERT INTO compact_pool_price_hours (hour_start, protocol, pool, swap_count, first_swap_block, last_swap_block,
      priced_blocks, close_sqrt_price_x96, close_liquidity, sqrt_price_block_sum, reserve0_block_sum, reserve1_block_sum)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
    pricePaths: db.prepare('SELECT * FROM compact_pool_price_hours WHERE hour_start = ? AND protocol = ? ORDER BY pool'),
    prunePricePaths: db.prepare('DELETE FROM compact_pool_price_hours WHERE hour_start <= ?'),
    valuations: db.prepare(`SELECT valuation, status, reason, row_count, rows_sha256 FROM compact_valuation_hours WHERE hour_start = ?
      ORDER BY valuation`),
    // An available valuation is never replaced; an unavailable one is updated (another reason) or upgraded.
    setValuation: db.prepare(`INSERT INTO compact_valuation_hours (hour_start, valuation, status, reason, row_count, rows_sha256)
      VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (hour_start, valuation) DO UPDATE SET status = excluded.status, reason = excluded.reason,
      row_count = excluded.row_count, rows_sha256 = excluded.rows_sha256 WHERE compact_valuation_hours.status = 'unavailable'`),
    insertTokenPrice: db.prepare(`INSERT INTO compact_token_price_hours (hour_start, token, price_usd_e18, source_protocol, source_pool,
      depth_usd_micros, source_count) VALUES (?, ?, ?, ?, ?, ?, ?)`),
    tokenPrices: db.prepare('SELECT * FROM compact_token_price_hours WHERE hour_start = ? ORDER BY token'),
    insertDexVolume: db.prepare(`INSERT INTO compact_dex_volume_hours (hour_start, protocol, volume_usd_micros, valued_swaps, unvalued_swaps)
      VALUES (?, ?, ?, ?, ?)`),
    dexVolume: db.prepare('SELECT * FROM compact_dex_volume_hours WHERE hour_start = ? ORDER BY protocol'),
    insertSwapFee: db.prepare(`INSERT INTO compact_pool_fee_hours (hour_start, pool, swap_count, fee_in0_e6, fee_in1_e6, fee_out0_e12, fee_out1_e12)
      VALUES (?, ?, ?, ?, ?, ?, ?)`),
    swapFees: db.prepare('SELECT * FROM compact_pool_fee_hours WHERE hour_start = ? ORDER BY pool'),
    pruneSwapFees: db.prepare('DELETE FROM compact_pool_fee_hours WHERE hour_start <= ?'),
    insertDexFee: db.prepare(`INSERT INTO compact_dex_fee_hours (hour_start, protocol, fee_usd_micros, valued_swaps, unvalued_swaps)
      VALUES (?, ?, ?, ?, ?)`),
    dexFees: db.prepare('SELECT * FROM compact_dex_fee_hours WHERE hour_start = ? ORDER BY protocol'),
    pruneDexFees: db.prepare('DELETE FROM compact_dex_fee_hours WHERE hour_start <= ?'),
    // Pool liquidity snapshots (tvl.js): one row per top pool and hour, written once.
    insertPoolTvl: db.prepare(`INSERT OR IGNORE INTO compact_pool_tvl_hours (hour_start, protocol, pool, status, reason, amount0_raw, amount1_raw,
      block_number) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`),
    poolTvl: db.prepare('SELECT * FROM compact_pool_tvl_hours WHERE hour_start = ? AND protocol = ? ORDER BY pool'),
    prunePoolTvl: db.prepare('DELETE FROM compact_pool_tvl_hours WHERE hour_start <= ?'),
    // The read model's 24H top pools (by summed swap count, ties by pool), for the liquidity snapshot of the same pools.
    topPools: db.prepare(`SELECT pool, SUM(swap_count) AS total FROM compact_pool_hours WHERE protocol = ?1 AND hour_start BETWEEN ?2 AND ?3
      GROUP BY pool HAVING total > 0 ORDER BY total DESC, pool ASC LIMIT ?4`),
    pruneValuationHours: db.prepare('DELETE FROM compact_valuation_hours WHERE hour_start <= ?'),
    pruneTokenPrices: db.prepare('DELETE FROM compact_token_price_hours WHERE hour_start <= ?'),
    pruneDexVolume: db.prepare('DELETE FROM compact_dex_volume_hours WHERE hour_start <= ?'),
    // Stored hours inside retention without a status row for every valuation, newest first.
    pendingValuationHours: db.prepare(`SELECT h.hour_start FROM compact_hours h WHERE h.hour_start > ?1
      AND (SELECT COUNT(*) FROM compact_valuation_hours v WHERE v.hour_start = h.hour_start) < ?2 ORDER BY h.hour_start DESC LIMIT ?3`),
    registryMeta: db.prepare('SELECT meta_json FROM compact_registry WHERE kind = ? AND address = ?'),
    tokenMetadata: db.prepare('SELECT * FROM compact_token_metadata WHERE token = ?'),
    insertTokenMetadata: db.prepare(`INSERT OR IGNORE INTO compact_token_metadata (token, verified, symbol, name, decimals, reason, read_block)
      VALUES (?, ?, ?, ?, ?, ?, ?)`),
    recentActivityPools: db.prepare(`SELECT protocol, pool, MAX(block_number) AS latest FROM compact_dex_activity GROUP BY protocol, pool
      ORDER BY latest DESC, protocol ASC, pool ASC LIMIT ?`),
    busiestPools: db.prepare(`SELECT protocol, pool, SUM(swap_count) AS swaps FROM compact_pool_hours WHERE hour_start > ? GROUP BY protocol, pool
      ORDER BY swaps DESC, protocol ASC, pool ASC LIMIT ?`),
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

  // Every stored hour whose V4 projection is available has all of its validated Initialize rows in the registry, so V4
  // coverage that ends exactly at such an hour's parent (same hash) runs on through it, hour by hour. This lets a
  // projection-only repair (or a registry scan) close a gap left by one failed hour without any RPC or operator step.
  function chainV4Coverage(fromHourStart) {
    for (let hour = fromHourStart + HOUR; ; hour += HOUR) {
      const current = coverageOf(V4_POOL_KIND);
      const next = sql.hourRange.get(int(hour));
      if (!current || !next || next.first_block !== current.through + 1 || next.parent_hash !== current.throughHash) return;
      if (sql.projection.get(int(hour), 'uniswap_v4_pools')?.status !== 'available') return;
      sql.setCoverage.run(V4_POOL_KIND, int(current.fromBlock), int(next.last_block), next.last_hash);
    }
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
  // names: the projections to write (a projection-only repair writes only the ones it rebuilt; nothing else is touched).
  function writeProjections(range, normalized, names = PROJECTIONS) {
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
      for (const name of ['uniswap_v4_price_paths', 'uniswap_v4_swap_fees']) {
        if (projections[name].status === 'available') projections[name] = unavailableProjection('projection_inputs_unavailable');
      }
    }
    for (const name of names) {
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
      } else if (name === 'uniswap_v4_swap_fees') {
        for (const row of entry.rows) {
          sql.insertSwapFee.run(hour, row.pool, int(row.swapCount), row.feeIn0E6, row.feeIn1E6, row.feeOut0E12, row.feeOut1E12);
        }
      } else if (Object.hasOwn(PRICE_PATH_PROJECTIONS, name)) {
        for (const row of entry.rows) {
          sql.insertPricePath.run(hour, PRICE_PATH_PROJECTIONS[name], row.pool, int(row.swapCount), int(row.firstSwapBlock), int(row.lastSwapBlock),
            int(row.pricedBlocks), row.closeSqrtPriceX96, row.closeLiquidity, row.sqrtPriceBlockSum, row.reserve0BlockSum, row.reserve1BlockSum);
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
          chainV4Coverage(range.hourStart);
        }
      }
      if (stored) sql.upgradeProjection.run(int(entry.rows.length), entry.sha, hour, name);
      else sql.insertProjection.run(hour, name, 'available', null, int(entry.rows.length), entry.sha);
      report[name] = stored ? 'upgraded' : 'inserted';
    }
    // The hour's valuations follow from what is stored now (never from what was only offered).
    deriveValuations(range.hourStart);
    for (const kind of ACTIVITY_KINDS) sql.pruneActivity.run(kind, kind, int(ACTIVITY_ROWS_PER_KIND));
    pruneHours(poolHourCutoff(sql.newestHour.get().hour_start));
    return report;
  }

  // Pool-hours, price paths, projection status rows and valuations share one retention (projections.js).
  function pruneHours(cutoff) {
    for (const statement of [sql.prunePoolHours, sql.prunePricePaths, sql.pruneProjectionHours, sql.pruneValuationHours, sql.pruneTokenPrices,
      sql.pruneDexVolume, sql.pruneSwapFees, sql.pruneDexFees, sql.prunePoolTvl]) statement.run(int(cutoff));
  }

  // ---------------------------------------------------------------------------------------------------------------------
  // Valuations (valuation.js), derived from stored rows only. poolOf resolves a pool's tokens from the registry; a pool
  // without a well-formed registry row makes the derivation fail closed (pool_registry_missing).

  function registryPool(protocol, pool) {
    const v4 = protocol === 'uniswap_v4';
    const row = sql.registryMeta.get(v4 ? V4_POOL_KIND : V3_POOL_KIND, pool);
    if (!row) return null;
    let meta = null;
    try { meta = JSON.parse(row.meta_json); } catch { return null; }
    const [token0, token1] = v4 ? [meta?.currency0, meta?.currency1] : [meta?.token0, meta?.token1];
    const hooks = v4 ? meta?.hooks : null;
    if (![token0, token1, ...(v4 ? [hooks] : [])].every((value) => typeof value === 'string' && ADDRESS.test(value))) return null;
    if (!Number.isSafeInteger(meta.fee) || meta.fee < 0) return null;
    return { token0, token1, hooks, fee: meta.fee };
  }

  const pricePathRowsOf = (hour, protocol) => sql.pricePaths.all(hour, protocol).map((row) => ({ pool: row.pool, swapCount: row.swap_count,
    firstSwapBlock: row.first_swap_block, lastSwapBlock: row.last_swap_block, pricedBlocks: row.priced_blocks, closeSqrtPriceX96: row.close_sqrt_price_x96,
    closeLiquidity: row.close_liquidity, sqrtPriceBlockSum: row.sqrt_price_block_sum, reserve0BlockSum: row.reserve0_block_sum,
    reserve1BlockSum: row.reserve1_block_sum }));
  const poolRowsOf = (hour, protocol) => sql.poolHours.all(hour, protocol).map((row) => ({ pool: row.pool, swapCount: row.swap_count,
    token0InRaw: row.token0_in_raw, token0OutRaw: row.token0_out_raw, token1InRaw: row.token1_in_raw, token1OutRaw: row.token1_out_raw }));
  const storedPrices = (hour) => new Map(sql.tokenPrices.all(hour).map((row) => [row.token, { priceUsdE18: BigInt(row.price_usd_e18),
    protocol: row.source_protocol, pool: row.source_pool, depthUsdMicros: BigInt(row.depth_usd_micros), sources: row.source_count }]));
  const setValuation = (hour, name, entry) => sql.setValuation.run(hour, name, entry.status, entry.status === 'available' ? null : entry.reason,
    entry.status === 'available' ? int(entry.rowCount) : null, entry.status === 'available' ? entry.sha : null);

  // One hour: token prices when both price paths are stored available; DEX USD volume when both pool projections are, with
  // those prices, or without them when no pool of the hour could use one. Runs in the caller's transaction, inside a
  // savepoint: a failure rolls back only the valuation rows and leaves the hour, its families and projections as written.
  function deriveValuations(hourStart) {
    const hour = int(hourStart);
    const stored = new Map(sql.valuations.all(hour).map((row) => [row.valuation, row]));
    if (VALUATIONS.every((name) => stored.get(name)?.status === 'available')) return;
    db.exec('SAVEPOINT compact_valuations');
    try {
      deriveHourValuations(hour, stored);
      db.exec('RELEASE compact_valuations');
    } catch (error) {
      db.exec('ROLLBACK TO compact_valuations');
      const failed = unavailableValuation(error?.code === 'pool_registry_missing' ? 'pool_registry_missing' : 'valuation_error');
      for (const name of VALUATIONS) if (stored.get(name)?.status !== 'available') setValuation(hour, name, failed);
      db.exec('RELEASE compact_valuations');
    }
  }

  const swapFeeRowsOf = (hour) => sql.swapFees.all(hour).map((row) => ({ pool: row.pool, swapCount: row.swap_count, feeIn0E6: row.fee_in0_e6,
    feeIn1E6: row.fee_in1_e6, feeOut0E12: row.fee_out0_e12, feeOut1E12: row.fee_out1_e12 }));

  // Token prices, then DEX USD volume, then swap fees; each valuation is independent and an available one is never redone.
  function deriveHourValuations(hour, stored) {
    const range = sql.hourRange.get(hour);
    const projection = new Map(sql.projections.all(hour).map((row) => [row.projection, row.status]));
    const available = (names) => names.every((name) => projection.get(name) === 'available');
    const pools = new Map();
    const poolOf = (protocol, pool) => {
      const key = `${protocol}:${pool}`;
      if (!pools.has(key)) pools.set(key, registryPool(protocol, pool));
      return pools.get(key);
    };
    let prices = null;
    if (stored.get('token_prices')?.status === 'available') prices = storedPrices(hour);
    else if (available(Object.keys(PRICE_PATH_PROJECTIONS))) {
      ({ prices } = tokenPricesOf({ pricePaths: Object.fromEntries(VALUATION_PROTOCOLS.map((protocol) => [protocol, pricePathRowsOf(hour, protocol)])),
        poolOf, hourBlocks: range.last_block - range.first_block + 1 }));
      const rows = [...prices].map(([token, price]) => ({ token, priceUsdE18: price.priceUsdE18.toString(10), sourceProtocol: price.protocol,
        sourcePool: price.pool, depthUsdMicros: price.depthUsdMicros.toString(10), sourceCount: price.sources }));
      for (const row of rows) {
        sql.insertTokenPrice.run(hour, row.token, row.priceUsdE18, row.sourceProtocol, row.sourcePool, row.depthUsdMicros, int(row.sourceCount));
      }
      setValuation(hour, 'token_prices', { status: 'available', rowCount: rows.length, sha: sha256Of({ rows }) });
    } else setValuation(hour, 'token_prices', unavailableValuation('price_paths_unavailable'));

    if (stored.get('dex_usd_volume')?.status !== 'available') {
      if (!available(Object.keys(POOL_PROJECTIONS))) setValuation(hour, 'dex_usd_volume', unavailableValuation('pool_projections_unavailable'));
      else {
        const { needsPrices, totals } = hourVolumeOf({ poolRows: Object.fromEntries(VALUATION_PROTOCOLS.map((protocol) => [protocol,
          poolRowsOf(hour, protocol)])), poolOf, prices });
        if (needsPrices) setValuation(hour, 'dex_usd_volume', unavailableValuation('prices_unavailable'));
        else {
          const rows = VALUATION_PROTOCOLS.map((protocol) => ({ protocol, volumeUsdMicros: totals[protocol].usdMicros.toString(10),
            valuedSwaps: totals[protocol].valuedSwaps, unvaluedSwaps: totals[protocol].unvaluedSwaps }));
          for (const row of rows) sql.insertDexVolume.run(hour, row.protocol, row.volumeUsdMicros, int(row.valuedSwaps), int(row.unvaluedSwaps));
          setValuation(hour, 'dex_usd_volume', { status: 'available', rowCount: rows.length, sha: sha256Of({ rows }) });
        }
      }
    }

    // Swap fees need the V3 pool rows (fixed fee tiers), the V4 swap-fee rows (fees the events applied) and, like volume,
    // prices only for pools without a USDC side.
    if (stored.get('dex_fees')?.status !== 'available') {
      if (!available([...Object.keys(POOL_PROJECTIONS), 'uniswap_v4_swap_fees'])) {
        setValuation(hour, 'dex_fees', unavailableValuation(available(Object.keys(POOL_PROJECTIONS)) ? 'fee_inputs_unavailable'
          : 'pool_projections_unavailable'));
      } else {
        const { needsPrices, totals } = hourFeesOf({ poolRows: { uniswap_v3: poolRowsOf(hour, 'uniswap_v3') },
          feeRows: { uniswap_v4: swapFeeRowsOf(hour) }, poolOf, prices });
        if (needsPrices) setValuation(hour, 'dex_fees', unavailableValuation('prices_unavailable'));
        else {
          const rows = VALUATION_PROTOCOLS.map((protocol) => ({ protocol, feeUsdMicros: totals[protocol].feeUsdMicros.toString(10),
            valuedSwaps: totals[protocol].valuedSwaps, unvaluedSwaps: totals[protocol].unvaluedSwaps }));
          for (const row of rows) sql.insertDexFee.run(hour, row.protocol, row.feeUsdMicros, int(row.valuedSwaps), int(row.unvaluedSwaps));
          setValuation(hour, 'dex_fees', { status: 'available', rowCount: rows.length, sha: sha256Of({ rows }) });
        }
      }
    }
  }

  // Re-derives one stored hour's valuations from what is stored now (the valuation backfill, after its projections are
  // written, or for an hour whose inputs were already complete). Never touches anything but valuation rows.
  function rederiveValuations(hourStart) {
    if (!sql.hourRange.get(int(hourStart))) throw new StoreError('hour_missing');
    transaction(() => deriveValuations(hourStart));
    return sql.valuations.all(int(hourStart)).map((row) => ({ valuation: row.valuation, status: row.status, reason: row.reason }));
  }

  // The bounded pass for stored hours that have no valuation status yet (hours stored before valuations existed), newest
  // first, one transaction per hour, within pool-hour retention. No RPC: everything comes from stored rows.
  function derivePendingValuations({ limit = 72 } = {}) {
    if (!Number.isSafeInteger(limit) || limit < 1) throw new StoreError('invalid_valuation_limit');
    const newest = sql.newestHour.get().hour_start;
    if (newest === null) return { hours: [] };
    const hours = sql.pendingValuationHours.all(int(poolHourCutoff(newest)), int(VALUATIONS.length), int(limit)).map((row) => row.hour_start);
    for (const hourStart of hours) transaction(() => deriveValuations(hourStart));
    return { hours };
  }

  // ---------------------------------------------------------------------------------------------------------------------
  // Token metadata cache (token-metadata.js).

  // Tokens of the pools the dashboard shows first (latest activity, then the busiest pools of the newest 24 stored hours)
  // that have no cached metadata, at most `limit`. Verified assets and the native currency are never candidates.
  function tokensNeedingMetadata({ limit }) {
    if (!Number.isSafeInteger(limit) || limit < 1) throw new StoreError('invalid_metadata_limit');
    const newest = sql.newestHour.get().hour_start;
    if (newest === null) return [];
    const pools = [...sql.recentActivityPools.all(int(100)), ...sql.busiestPools.all(int(newest - ADDRESS_WINDOW_HOURS * HOUR), int(400))];
    const tokens = [];
    const seen = new Set();
    for (const { protocol, pool } of pools) {
      const meta = registryPool(protocol, pool);
      for (const token of meta ? [meta.token0, meta.token1] : []) {
        if (seen.has(token) || metadataExempt(token)) continue;
        seen.add(token);
        if (!sql.tokenMetadata.get(token)) tokens.push(token);
        if (tokens.length >= limit) return tokens;
      }
    }
    return tokens;
  }

  // ---------------------------------------------------------------------------------------------------------------------
  // Pool liquidity snapshots (tvl.js).

  // The top `limit` pools of a protocol over the 24 hours ending at hourStart (the read model's ranking), with the registry
  // identity the snapshot needs. A pool without a well-formed registry row is left out (it is never shown either).
  function topPoolsOf(protocol, hourStart, limit) {
    const from = hourStart - (ADDRESS_WINDOW_HOURS - 1) * HOUR;
    return sql.topPools.all(protocol, int(from), int(hourStart), int(limit)).map((row) => ({ pool: row.pool, ...registryPool(protocol, row.pool) }))
      .filter((pool) => pool.token0)
      .map((pool) => ({ ...pool, tickSpacing: JSON.parse(sql.registryMeta.get(protocol === 'uniswap_v4' ? V4_POOL_KIND : V3_POOL_KIND, pool.pool).meta_json).tickSpacing }));
  }

  // Writes one hour's snapshot rows once; an existing row of the hour is never replaced.
  function recordPoolTvl(hourStart, protocol, rows, { blockNumber }) {
    if (!Number.isSafeInteger(blockNumber) || !['uniswap_v3', 'uniswap_v4'].includes(protocol)
      || !Array.isArray(rows) || rows.length > TVL_POOLS_PER_PROTOCOL || new Set(rows.map((row) => row.pool)).size !== rows.length) {
      throw new StoreError('invalid_tvl_snapshot');
    }
    return transaction(() => {
      const hour = sql.hourRange.get(int(hourStart));
      if (!hour) throw new StoreError('hour_missing');
      if (blockNumber !== hour.last_block) throw new StoreError('invalid_tvl_snapshot');
      for (const row of rows) {
        if (!registryPool(protocol, row.pool) || !['available', 'unavailable'].includes(row.status)) throw new StoreError('invalid_tvl_snapshot');
        const available = row.status === 'available';
        if (available ? typeof row.amount0 !== 'bigint' || typeof row.amount1 !== 'bigint' || row.amount0 < 0n || row.amount1 < 0n
          : !TVL_REASONS.includes(row.reason)) throw new StoreError('invalid_tvl_snapshot');
        sql.insertPoolTvl.run(int(hourStart), protocol, row.pool, row.status, available ? null : row.reason, available ? row.amount0.toString(10) : null,
          available ? row.amount1.toString(10) : null, int(blockNumber));
      }
    });
  }

  // Each row is written once (INSERT OR IGNORE): cached metadata is never replaced.
  function recordTokenMetadata(rows, { readBlock }) {
    if (!Number.isSafeInteger(readBlock) || readBlock < 0) throw new StoreError('invalid_metadata_block');
    return transaction(() => {
      for (const row of rows) {
        const verified = row.verified === true;
        if (!ADDRESS.test(row.token) || (verified ? typeof row.symbol !== 'string' || !Number.isSafeInteger(row.decimals) || row.reason !== null
          : row.symbol !== null || row.name !== null || row.decimals !== null || typeof row.reason !== 'string')) throw new StoreError('invalid_token_metadata');
        sql.insertTokenMetadata.run(row.token, verified ? 1n : 0n, row.symbol, row.name, verified ? int(row.decimals) : null, row.reason, int(readBlock));
      }
    });
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
        dailyActiveAddresses.observeHour(range.hourStart, result.activeAddresses);
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
      intelligence.recordHour(result);
      return { outcome, checkpoint: checkpoint(), projections };
    }, beforeCommit);
  }

  // Historical prepend for operator backfill only. A new hour must be exactly one UTC hour before the oldest stored
  // hour and must hash-link directly into it. The live checkpoint never moves backward or changes. This is deliberately
  // separate from commitHour so the scheduler remains strictly forward-only. Each prepend is one SQLite transaction, so a
  // stopped backfill resumes from the new oldest durable hour without a sidecar checkpoint.
  function commitHistoricalHour(result, { beforeCommit = null, requireValuations = false } = {}) {
    const rows = hourRows(result);
    const { range, network } = result;
    return transaction(() => {
      const existing = sql.hour.get(int(range.hourStart));
      if (existing) {
        if (existing.network_sha256 !== rows.networkSha) throw new StoreError('hour_conflict');
        intelligence.recordHour(result);
        return { outcome: 'unchanged', checkpoint: checkpoint(), projections: null };
      }
      const oldest = sql.oldestHour.get();
      const currentCheckpoint = checkpoint();
      if (!oldest || !currentCheckpoint) throw new StoreError('historical_base_missing');
      if (range.hourStart !== oldest.hour_start - HOUR) throw new StoreError('history_not_adjacent');
      if (range.lastBlock + 1 !== oldest.first_block || oldest.parent_hash !== range.lastHash) {
        throw new StoreError('history_discontinuity');
      }

      const checkpointBefore = { ...currentCheckpoint };
      sql.insertHour.run(int(range.hourStart), result.definitionVersion, int(range.firstBlock), int(range.lastBlock), range.parentHash,
        range.firstHash, range.lastHash, int(network.blockCount), int(network.transactionCount), int(network.uniqueActiveAddresses),
        rows.networkJson, rows.networkSha);
      for (const family of rows.families) {
        sql.insertFamily.run(int(range.hourStart), family.name, family.status, family.reason, family.json, family.sha);
      }
      storeAddresses(range.hourStart, result.activeAddresses);
      dailyActiveAddresses.observeHour(range.hourStart, result.activeAddresses);
      if (rows.v3) advanceRegistry(range, rows.v3);
      const projections = rows.projections ? writeProjections(range, rows.projections) : null;
      intelligence.recordHour(result);

      if (requireValuations) {
        const valuations = new Map(sql.valuations.all(int(range.hourStart)).map((row) => [row.valuation, row.status]));
        if (!VALUATIONS.every((name) => valuations.get(name) === 'available')) {
          throw new StoreError('historical_valuation_unavailable');
        }
      }

      const checkpointAfter = checkpoint();
      if (!checkpointAfter || checkpointAfter.hourStart !== checkpointBefore.hourStart
        || checkpointAfter.lastBlock !== checkpointBefore.lastBlock || checkpointAfter.lastHash !== checkpointBefore.lastHash) {
        throw new StoreError('historical_checkpoint_changed');
      }
      return { outcome: 'inserted', checkpoint: checkpointAfter, projections };
    }, beforeCommit);
  }

  // Projection-only commit for an hour that is already stored (the projection backfill and the single-hour repair): never
  // touches the hour, its families, the addresses or the checkpoint. The projections are reconciled against the stored
  // family counters. only: the projections to write (default all); the others keep whatever is stored.
  function commitProjectionHour(hourStart, projections, { beforeCommit = null, only = PROJECTIONS } = {}) {
    if (!Array.isArray(only) || !only.length || !only.every((name) => PROJECTIONS.includes(name)) || new Set(only).size !== only.length) {
      throw new StoreError('invalid_projection_names');
    }
    return transaction(() => {
      const hour = sql.hourRange.get(int(hourStart));
      if (!hour) throw new StoreError('hour_missing');
      const families = Object.fromEntries(sql.uniswapFamilies.all(int(hourStart)).map((row) => [row.family,
        row.status === 'available' ? { status: 'available', ...JSON.parse(row.metrics_json) } : { status: row.status }]));
      const range = { hourStart, firstBlock: hour.first_block, lastBlock: hour.last_block, parentHash: hour.parent_hash, lastHash: hour.last_hash };
      return writeProjections(range, normalizeProjections(projections, range, families), only);
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
      // A V4 scan that ends at a stored hour's last block continues through the stored hours after it that already hold
      // their Initialize rows (V4 projection available).
      const end = kind === V4_POOL_KIND ? sql.hourByLastBlock.get(int(registryScan.through)) : null;
      if (end) chainV4Coverage(end.hour_start);
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
    intelligence,
    commitHour,
    gatewayRepairInput(hourStart) {
      const hour = db.prepare('SELECT * FROM compact_hours WHERE hour_start = ?').get(int(hourStart));
      const family = sql.families.all(int(hourStart)).find((row) => row.family === 'gateway');
      return hour && family ? { hourStart, firstBlock: hour.first_block, lastBlock: hour.last_block,
        firstHash: hour.first_hash, lastHash: hour.last_hash, parentHash: hour.parent_hash,
        networkSha: hour.network_sha256, status: family.status, reason: family.reason } : null;
    },
    commitGatewayRepair(input, metrics) {
      if (!input || !FAMILY_FIELDS.gateway.every((field) => metrics[field] !== undefined && metrics[field] !== null)) {
        throw new StoreError('gateway_repair_invalid');
      }
      // Validate additive/constant/tally values using the existing family rules before the transaction.
      sumWindow(FAMILY_WINDOWS.gateway, [metrics]);
      return transaction(() => {
        const hour = sql.hour.get(int(input.hourStart));
        const family = sql.families.all(int(input.hourStart)).find((row) => row.family === 'gateway');
        if (!hour || hour.network_sha256 !== input.networkSha || hour.first_block !== input.firstBlock
          || hour.last_block !== input.lastBlock || hour.parent_hash !== input.parentHash || hour.last_hash !== input.lastHash) {
          throw new StoreError('hour_conflict');
        }
        if (family?.status === 'available') return 'unchanged';
        if (!family || family.reason !== input.reason) throw new StoreError('gateway_repair_state_changed');
        const evidence = { originalReason: input.reason, hourStart: input.hourStart, firstBlock: input.firstBlock, lastBlock: input.lastBlock,
          firstHash: input.firstHash, lastHash: input.lastHash, networkSha: input.networkSha };
        const json = canonical(Object.fromEntries(FAMILY_FIELDS.gateway.map((field) => [field, metrics[field]])));
        sql.upgradeFamily.run(json, sha256(json), int(input.hourStart), 'gateway');
        // An append-only metadata key preserves the original failure without changing any family definition,
        // metrics JSON/hash, existing table or successful projection. Older readers ignore this namespace.
        db.prepare('INSERT OR IGNORE INTO compact_meta (key,value) VALUES (?,?)')
          .run(`family_repair_evidence:gateway:${String(input.hourStart).padStart(16, '0')}`, canonical(evidence));
        return 'upgraded';
      });
    },
    commitHistoricalHour,
    checkpoint,
    earliestHour() {
      const row = sql.oldestHour.get();
      return row ? { hourStart: row.hour_start, firstBlock: row.first_block, parentHash: row.parent_hash } : null;
    },
    dailyActiveReplayCandidate() {
      const row = sql.dauReplayCandidate.get();
      return row ? row.hour_start : null;
    },
    storedHour(hourStart) {
      const row = sql.hourRange.get(int(hourStart));
      return row ? {
        hourStart: row.hour_start,
        firstBlock: row.first_block,
        lastBlock: row.last_block,
        parentHash: row.parent_hash,
        lastHash: row.last_hash,
      } : null;
    },
    replayDailyActiveAddresses(hourStart, addresses) {
      return transaction(() => {
        if (!sql.hourRange.get(int(hourStart))) throw new StoreError('hour_missing');
        return dailyActiveAddresses.observeHour(hourStart, addresses, { replay: true });
      });
    },
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
    pricePaths: (hourStart, protocol) => pricePathRowsOf(int(hourStart), protocol),
    // Valuations (never families, never projections).
    derivePendingValuations,
    rederiveValuations,
    swapFees: (hourStart) => swapFeeRowsOf(int(hourStart)),
    dexFees: (hourStart) => sql.dexFees.all(int(hourStart)).map((row) => ({ protocol: row.protocol, feeUsdMicros: row.fee_usd_micros,
      valuedSwaps: row.valued_swaps, unvaluedSwaps: row.unvalued_swaps })),
    valuationStatus: (hourStart) => sql.valuations.all(int(hourStart)).map((row) => ({ valuation: row.valuation, status: row.status, reason: row.reason,
      rowCount: row.row_count, rowsSha256: row.rows_sha256 })),
    tokenPrices: (hourStart) => sql.tokenPrices.all(int(hourStart)).map((row) => ({ token: row.token, priceUsdE18: row.price_usd_e18,
      sourceProtocol: row.source_protocol, sourcePool: row.source_pool, depthUsdMicros: row.depth_usd_micros, sourceCount: row.source_count })),
    dexVolume: (hourStart) => sql.dexVolume.all(int(hourStart)).map((row) => ({ protocol: row.protocol, volumeUsdMicros: row.volume_usd_micros,
      valuedSwaps: row.valued_swaps, unvaluedSwaps: row.unvalued_swaps })),
    // Pool liquidity snapshots.
    topPoolsOf,
    recordPoolTvl,
    poolTvl: (hourStart, protocol) => sql.poolTvl.all(int(hourStart), protocol).map((row) => ({ pool: row.pool, status: row.status, reason: row.reason,
      amount0Raw: row.amount0_raw, amount1Raw: row.amount1_raw, blockNumber: row.block_number })),
    // Token metadata cache.
    tokensNeedingMetadata,
    recordTokenMetadata,
    tokenMetadata(token) {
      const row = sql.tokenMetadata.get(token);
      return row ? { token: row.token, verified: row.verified === 1, symbol: row.symbol, name: row.name, decimals: row.decimals, reason: row.reason,
        readBlock: row.read_block } : null;
    },
  });
}
