// Compact engine: lossless packed shards. Exact copies of hot compact rows, kept as bounded, deflate-compressed,
// content-addressed pieces inside the same SQLite file and written in the same writer transaction as the rows they copy.
// This is the "packed-shards" format of the lossless storage review (one real mainnet hour, 9,596,928 -> 3,518,464 bytes):
// column names and the scope (hour or UTC day) are stored once per set, a piece holds at most 256 rows (4096 addresses),
// addresses are their raw 20 bytes, every piece is deflated (raw, level 1) and stored once per distinct compressed byte
// string, so identical pieces (e.g. an hourly identity set equal to its daily set) share one payload.
// Additive only: no hot row is changed or deleted here, there is no RPC and no second writer, and nothing is written unless
// COMPACT_PACKED_SHARDS_ENABLED=true. A set is packed only once its rows are final (every source projection available,
// every identity of the hour or completed day present) and only after decoding it back reproduces the exact typed rows.
// Writing and reading both stream: source rows are iterated, never loaded as one array, and decoded rows are handed on
// piece by piece, so memory is bounded by one piece (at most 256 KiB raw) however large an hour or a completed day is.
// Reading verifies payload and raw checksums, piece order and sizes, the row digest, the table schema and the binding to
// the canonical compact_hours rows; any mismatch fails closed. Packing alone adds the packed bytes on top of the hot
// rows it copies; disk is only saved by retention.
// Retention (OFF unless COMPACT_PACKED_RETENTION_ENABLED=true, which requires packing) removes the hot rows of a packed
// scope only when every condition holds: the scope is older than the hot window (COMPACT_PACKED_HOT_HOURS, at least 48,
// so every 24H read, the 24H identity union, TVL top pools and pending valuations stay on hot rows); the set was committed
// by an EARLIER transaction; for pool data all of the hour's valuations are final (their inputs are no longer needed);
// the set verifies completely in this transaction; and the hot rows have exactly the packed row count and typed digest.
// Removal writes an immutable compact_packed_pruned marker in the same savepoint, and only a marked scope is ever read
// from its packed set (store accessors, read model pools, ecosystem pool activity, persisted identities). Pruned pool
// hours also add their swap counts to compact_packed_pool_swaps, so all-history pool activity stays an exact sum
// without decoding every pruned hour. Any missing, corrupt or mismatching packed data keeps the hot rows.
// Expiry (OFF unless COMPACT_PACKED_EXPIRY_ENABLED=true, which requires retention) bounds the packed data: it deletes the
// packed set of a pruned scope only once nothing the system serves or repairs can reach it any more (PACKED_KEEP_HOURS:
// identities 61 days, for the 30D unique union and the previous 30D it is compared with; pool data 36 days, the 35-day
// pool-hour retention of projection/valuation backfill, TVL repair and 30D pools), only when its hot rows are already gone
// and the set still matches its prune marker, and only after the storage check accepts the write-ahead log the deletion
// needs. An expired pool hour first keeps the creation-hour swap count of every registered pool created in it
// (compact_packed_pool_creation_swaps, for the ecosystem's early activity); all-history swap totals stay in
// compact_packed_pool_swaps. Deletion writes an immutable compact_packed_expired marker first: delete triggers allow
// removing a set or piece only for a marked scope, a payload only when no piece references it, and no set can be packed
// again for a marked scope. Readers never turn an expired scope into empty data: they fail closed or report it.
// History expiry (history-expiry.js, OFF unless COMPACT_HISTORY_EXPIRY_ENABLED=true, which requires expiry) raises the
// history floor (compact_packed_history_floor, only grows): below it nothing is packed again (code and insert guards),
// pool hours whose valuations are frozen (outside the pool-hour retention) are pruned without waiting for them, and only
// below it may the prune and expiry markers of an expired scope be deleted (delete guards), so markers stop growing too.
// Canonical hours, status rows and the registry are never touched here.
import { createHash } from 'node:crypto';
import { deflateRawSync, inflateRawSync } from 'node:zlib';
import { POOL_HOUR_RETENTION_HOURS } from './projections.js';
import { VALUATIONS } from './valuation.js';

export const PACKED_SHARDS_VERSION = 'arc-packed-shards-v1';
export const PACKED_COLUMN_ROWS = 256;
export const PACKED_ADDRESS_ROWS = 4096;
export const PACKED_MAX_RAW_PIECE_BYTES = 256 * 1024;
export const PACKED_POOL_PROOF_MAX_SCOPES = 744;
export const PACKED_POOL_PROOF_MAX_BYTES = 4 * 1024 * 1024;
// Conservative metadata accounting, not raw rows. Also impose a piece-count bound independently of byte accounting.
const PROOF_SCOPE_BYTES = 1024, PROOF_PIECE_BYTES = 512, PROOF_MAX_PIECES = 8192;
// The 24H window plus a full day of margin: nothing a 24H read, the TVL top-pool choice or a pending valuation touches
// is ever removed from the hot tables.
export const PACKED_MIN_HOT_HOURS = 48;
// Expiry keeps every packed scope whose last hour is inside these spans before the newest stored hour (each with one day
// of margin): identity sets cover the 30D window and the previous 30D its unique count is compared with (address-union.js);
// pool, price-path and fee sets cover the pool-hour retention (projections.js), the widest reach of 30D pools, TVL and
// projection repair, and projection/valuation backfill.
export const PACKED_KEEP_HOURS = Object.freeze({ identity: 2 * 30 * 24 + 24, pool: POOL_HOUR_RETENTION_HOURS + 24 });
// The write-ahead log of a retention pass is truncated back to this size after it is checkpointed (store.js).
export const PACKED_JOURNAL_LIMIT_BYTES = 64 * 1024 * 1024;
const ADDRESS_BYTES = 20;
const HOUR = 3600;
const DAY = 24 * HOUR;
const MiB = 1024 * 1024;

// Hourly datasets are final when every listed projection of the hour is available and the stored rows match their
// row counts; identity datasets when the hour's (or completed day's) identity count matches the canonical count.
export const PACKED_DATASETS = Object.freeze({
  compact_pool_hours: Object.freeze({ scope: 'hour_start', codec: 'columns-json', projections: Object.freeze(['uniswap_v3_pools', 'uniswap_v4_pools']) }),
  compact_pool_price_hours: Object.freeze({ scope: 'hour_start', codec: 'columns-json',
    projections: Object.freeze(['uniswap_v3_price_paths', 'uniswap_v4_price_paths']) }),
  compact_pool_fee_hours: Object.freeze({ scope: 'hour_start', codec: 'columns-json', projections: Object.freeze(['uniswap_v4_swap_fees']) }),
  compact_hour_addresses: Object.freeze({ scope: 'hour_start', codec: 'address-b20' }),
  compact_daily_address_stage: Object.freeze({ scope: 'day_start', codec: 'address-b20' }),
});
export const PACKED_HOUR_DATASETS = Object.freeze(Object.keys(PACKED_DATASETS).filter((name) => PACKED_DATASETS[name].scope === 'hour_start'));
// SQL: the scope of a packed row (NEW or OLD) ends before the history floor, so its rows are gone for good.
const belowFloor = (row) => `EXISTS (SELECT 1 FROM compact_packed_history_floor f WHERE f.name = 'details'
  AND ${row}.scope_start + CASE WHEN ${row}.dataset = 'compact_daily_address_stage' THEN ${DAY - HOUR} ELSE 0 END < f.hour_start)`;

export const PACKED_SHARDS_SQL = `
CREATE TABLE IF NOT EXISTS compact_packed_payloads (
  payload_sha256 TEXT PRIMARY KEY, raw_sha256 TEXT NOT NULL,
  raw_bytes INTEGER NOT NULL CHECK (raw_bytes > 0 AND raw_bytes <= ${PACKED_MAX_RAW_PIECE_BYTES}), payload BLOB NOT NULL
) STRICT, WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS compact_packed_sets (
  dataset TEXT NOT NULL, scope_start INTEGER NOT NULL, version TEXT NOT NULL, codec TEXT NOT NULL, columns_json TEXT NOT NULL,
  row_count INTEGER NOT NULL CHECK (row_count >= 0), rows_sha256 TEXT NOT NULL, pieces INTEGER NOT NULL CHECK (pieces >= 0),
  binding_sha256 TEXT NOT NULL, raw_bytes INTEGER NOT NULL CHECK (raw_bytes >= 0), stored_bytes INTEGER NOT NULL CHECK (stored_bytes >= 0),
  PRIMARY KEY (dataset, scope_start)
) STRICT, WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS compact_packed_pieces (
  dataset TEXT NOT NULL, scope_start INTEGER NOT NULL, part INTEGER NOT NULL CHECK (part >= 0), row_count INTEGER NOT NULL CHECK (row_count > 0),
  payload_sha256 TEXT NOT NULL REFERENCES compact_packed_payloads (payload_sha256),
  PRIMARY KEY (dataset, scope_start, part)
) STRICT, WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS compact_packed_expired (
  dataset TEXT NOT NULL, scope_start INTEGER NOT NULL, row_count INTEGER NOT NULL CHECK (row_count >= 0), rows_sha256 TEXT NOT NULL,
  PRIMARY KEY (dataset, scope_start)
) STRICT, WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS compact_packed_pool_creation_swaps (
  protocol TEXT NOT NULL, pool TEXT NOT NULL, hour_start INTEGER NOT NULL, swap_count INTEGER CHECK (swap_count IS NULL OR swap_count >= 0),
  PRIMARY KEY (protocol, pool)
) STRICT, WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS compact_packed_history_floor (
  name TEXT PRIMARY KEY CHECK (name IN ('details', 'observations')), hour_start INTEGER NOT NULL CHECK (hour_start % 3600 = 0)
) STRICT, WITHOUT ROWID;
CREATE TRIGGER IF NOT EXISTS compact_packed_history_floor_no_delete BEFORE DELETE ON compact_packed_history_floor
BEGIN SELECT RAISE(ABORT,'immutable_history_floor'); END;
CREATE TRIGGER IF NOT EXISTS compact_packed_history_floor_only_grow BEFORE UPDATE ON compact_packed_history_floor
WHEN NEW.name <> OLD.name OR NEW.hour_start < OLD.hour_start BEGIN SELECT RAISE(ABORT,'immutable_history_floor'); END;
DROP TRIGGER IF EXISTS compact_packed_payload_no_delete;
DROP TRIGGER IF EXISTS compact_packed_set_no_delete;
DROP TRIGGER IF EXISTS compact_packed_piece_no_delete;
DROP TRIGGER IF EXISTS compact_packed_set_no_replace;
DROP TRIGGER IF EXISTS compact_packed_piece_no_replace;
DROP TRIGGER IF EXISTS compact_packed_pruned_no_delete;
DROP TRIGGER IF EXISTS compact_packed_expired_no_delete;
CREATE TRIGGER IF NOT EXISTS compact_packed_payload_no_update BEFORE UPDATE ON compact_packed_payloads BEGIN SELECT RAISE(ABORT,'immutable_packed_shards'); END;
CREATE TRIGGER IF NOT EXISTS compact_packed_payload_delete_guard BEFORE DELETE ON compact_packed_payloads
WHEN EXISTS (SELECT 1 FROM compact_packed_pieces WHERE payload_sha256 = OLD.payload_sha256) BEGIN SELECT RAISE(ABORT,'immutable_packed_shards'); END;
CREATE TRIGGER IF NOT EXISTS compact_packed_payload_no_replace BEFORE INSERT ON compact_packed_payloads
WHEN EXISTS (SELECT 1 FROM compact_packed_payloads WHERE payload_sha256 = NEW.payload_sha256) BEGIN SELECT RAISE(ABORT,'immutable_packed_shards'); END;
CREATE TRIGGER IF NOT EXISTS compact_packed_set_no_update BEFORE UPDATE ON compact_packed_sets BEGIN SELECT RAISE(ABORT,'immutable_packed_shards'); END;
CREATE TRIGGER IF NOT EXISTS compact_packed_set_delete_guard BEFORE DELETE ON compact_packed_sets
WHEN NOT EXISTS (SELECT 1 FROM compact_packed_expired WHERE dataset = OLD.dataset AND scope_start = OLD.scope_start)
BEGIN SELECT RAISE(ABORT,'immutable_packed_shards'); END;
CREATE TRIGGER IF NOT EXISTS compact_packed_set_insert_guard BEFORE INSERT ON compact_packed_sets
WHEN EXISTS (SELECT 1 FROM compact_packed_sets WHERE dataset = NEW.dataset AND scope_start = NEW.scope_start)
  OR EXISTS (SELECT 1 FROM compact_packed_expired WHERE dataset = NEW.dataset AND scope_start = NEW.scope_start) OR ${belowFloor('NEW')}
BEGIN SELECT RAISE(ABORT,'immutable_packed_shards'); END;
CREATE TRIGGER IF NOT EXISTS compact_packed_piece_no_update BEFORE UPDATE ON compact_packed_pieces BEGIN SELECT RAISE(ABORT,'immutable_packed_shards'); END;
CREATE TRIGGER IF NOT EXISTS compact_packed_piece_delete_guard BEFORE DELETE ON compact_packed_pieces
WHEN NOT EXISTS (SELECT 1 FROM compact_packed_expired WHERE dataset = OLD.dataset AND scope_start = OLD.scope_start)
BEGIN SELECT RAISE(ABORT,'immutable_packed_shards'); END;
CREATE TRIGGER IF NOT EXISTS compact_packed_piece_insert_guard BEFORE INSERT ON compact_packed_pieces
WHEN EXISTS (SELECT 1 FROM compact_packed_pieces WHERE dataset = NEW.dataset AND scope_start = NEW.scope_start AND part = NEW.part)
  OR EXISTS (SELECT 1 FROM compact_packed_expired WHERE dataset = NEW.dataset AND scope_start = NEW.scope_start) OR ${belowFloor('NEW')}
BEGIN SELECT RAISE(ABORT,'immutable_packed_shards'); END;
CREATE TABLE IF NOT EXISTS compact_packed_pruned (
  dataset TEXT NOT NULL, scope_start INTEGER NOT NULL, row_count INTEGER NOT NULL CHECK (row_count >= 0), rows_sha256 TEXT NOT NULL,
  PRIMARY KEY (dataset, scope_start)
) STRICT, WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS compact_packed_pool_swaps (
  protocol TEXT NOT NULL, pool TEXT NOT NULL, swap_count INTEGER NOT NULL CHECK (swap_count >= 0), row_count INTEGER NOT NULL CHECK (row_count > 0),
  PRIMARY KEY (protocol, pool)
) STRICT, WITHOUT ROWID;
CREATE TRIGGER IF NOT EXISTS compact_packed_pruned_no_update BEFORE UPDATE ON compact_packed_pruned BEGIN SELECT RAISE(ABORT,'immutable_packed_shards'); END;
CREATE TRIGGER IF NOT EXISTS compact_packed_pruned_delete_guard BEFORE DELETE ON compact_packed_pruned
WHEN NOT ${belowFloor('OLD')}
  OR EXISTS (SELECT 1 FROM compact_packed_expired WHERE dataset = OLD.dataset AND scope_start = OLD.scope_start)
  OR EXISTS (SELECT 1 FROM compact_packed_sets WHERE dataset = OLD.dataset AND scope_start = OLD.scope_start)
BEGIN SELECT RAISE(ABORT,'immutable_packed_shards'); END;
CREATE TRIGGER IF NOT EXISTS compact_packed_pruned_no_replace BEFORE INSERT ON compact_packed_pruned
WHEN EXISTS (SELECT 1 FROM compact_packed_pruned WHERE dataset = NEW.dataset AND scope_start = NEW.scope_start) BEGIN SELECT RAISE(ABORT,'immutable_packed_shards'); END;
CREATE TRIGGER IF NOT EXISTS compact_packed_pool_swaps_no_delete BEFORE DELETE ON compact_packed_pool_swaps BEGIN SELECT RAISE(ABORT,'immutable_packed_shards'); END;
CREATE TRIGGER IF NOT EXISTS compact_packed_pool_swaps_only_grow BEFORE UPDATE ON compact_packed_pool_swaps
WHEN NEW.protocol <> OLD.protocol OR NEW.pool <> OLD.pool OR NEW.swap_count < OLD.swap_count OR NEW.row_count <= OLD.row_count
BEGIN SELECT RAISE(ABORT,'immutable_packed_shards'); END;
CREATE TRIGGER IF NOT EXISTS compact_packed_expired_no_update BEFORE UPDATE ON compact_packed_expired BEGIN SELECT RAISE(ABORT,'immutable_packed_shards'); END;
CREATE TRIGGER IF NOT EXISTS compact_packed_expired_delete_guard BEFORE DELETE ON compact_packed_expired
WHEN NOT ${belowFloor('OLD')}
  OR EXISTS (SELECT 1 FROM compact_packed_sets WHERE dataset = OLD.dataset AND scope_start = OLD.scope_start)
  OR EXISTS (SELECT 1 FROM compact_packed_pieces WHERE dataset = OLD.dataset AND scope_start = OLD.scope_start)
BEGIN SELECT RAISE(ABORT,'immutable_packed_shards'); END;
CREATE TRIGGER IF NOT EXISTS compact_packed_expired_no_replace BEFORE INSERT ON compact_packed_expired
WHEN EXISTS (SELECT 1 FROM compact_packed_expired WHERE dataset = NEW.dataset AND scope_start = NEW.scope_start)
  OR NOT EXISTS (SELECT 1 FROM compact_packed_pruned WHERE dataset = NEW.dataset AND scope_start = NEW.scope_start)
BEGIN SELECT RAISE(ABORT,'immutable_packed_shards'); END;
CREATE TRIGGER IF NOT EXISTS compact_packed_creation_no_update BEFORE UPDATE ON compact_packed_pool_creation_swaps BEGIN SELECT RAISE(ABORT,'immutable_packed_shards'); END;
CREATE TRIGGER IF NOT EXISTS compact_packed_creation_no_delete BEFORE DELETE ON compact_packed_pool_creation_swaps BEGIN SELECT RAISE(ABORT,'immutable_packed_shards'); END;
CREATE TRIGGER IF NOT EXISTS compact_packed_creation_no_replace BEFORE INSERT ON compact_packed_pool_creation_swaps
WHEN EXISTS (SELECT 1 FROM compact_packed_pool_creation_swaps WHERE protocol = NEW.protocol AND pool = NEW.pool)
BEGIN SELECT RAISE(ABORT,'immutable_packed_shards'); END;`;

export class PackedShardsError extends Error {
  constructor(code, reason = null) { super(code); this.code = code; this.reason = reason; }
}
const fail = (code) => { throw new PackedShardsError(code); };
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

// Key-sorted JSON, so a digest depends on values only.
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

// Typed row text: the same encoding as the review's row digests. Only SQLite NULL, TEXT, BLOB and safe INTEGER values
// exist in the packed datasets; anything else (REAL, an unsafe integer) is refused rather than approximated.
function typed(value) {
  if (value === null) return ['null'];
  if (typeof value === 'string') return ['text', value];
  if (typeof value === 'number' && Number.isSafeInteger(value)) return ['integer', String(value)];
  if (ArrayBuffer.isView(value)) return ['blob', Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString('hex')];
  return fail('packed_value_type_invalid');
}
// One line of a set's row digest: SHA256 over these lines (each followed by a newline) in primary-key order.
const rowText = (row) => JSON.stringify(Object.keys(row).sort().map((key) => [key, typed(row[key])]));

// The exact same sorted, typed JSON as rowText, with bounded per-column scratch instead of nested arrays per row.
// Writers keep rowText as an independent reference. Escapes and lone UTF-16 surrogates use JSON.stringify.
function rowDigestEncoder(schema, columns, scopeColumn) {
  const keys = schema.map(({ name }) => name).sort();
  const prefixes = keys.map(key => `[${JSON.stringify(key)},`);
  const indices = keys.map(key => key === scopeColumn ? -1 : columns.indexOf(key));
  const previous = new Array(keys.length), fields = new Array(keys.length);
  const quoted = value => /["\\\u0000-\u001f\ud800-\udfff]/.test(value) ? JSON.stringify(value) : `"${value}"`;
  return (values, scope) => {
    for (let i = 0; i < keys.length; i++) {
      const value = indices[i] === -1 ? scope : values[indices[i]];
      if (fields[i] !== undefined && previous[i] === value) continue;
      let text;
      if (value === null) text = '["null"]';
      else if (typeof value === 'string') text = `["text",${quoted(value)}]`;
      else if (typeof value === 'number' && Number.isSafeInteger(value)) text = `["integer","${String(value)}"]`;
      else if (ArrayBuffer.isView(value)) text = `["blob","${Buffer.from(value.buffer,value.byteOffset,value.byteLength).toString('hex')}"]`;
      else fail('packed_value_type_invalid');
      previous[i] = value; fields[i] = `${prefixes[i]}${text}]`;
    }
    return `[${fields.join(',')}]`;
  };
}

export function packedShardsConfig(env = process.env) {
  const flag = (key) => {
    const value = env[key] ?? '';
    if (!['', 'true', 'false'].includes(value)) fail(`invalid_${key.slice('COMPACT_'.length).toLowerCase()}`);
    return value === 'true';
  };
  const number = (key, fallback, min, max) => {
    const text = env[key] ?? String(fallback);
    const value = /^\d+$/.test(text) ? Number(text) : NaN;
    if (!Number.isSafeInteger(value) || value < min || value > max) fail(`invalid_${key.slice('COMPACT_'.length).toLowerCase()}`);
    return value;
  };
  const enabled = flag('COMPACT_PACKED_SHARDS_ENABLED');
  const retention = flag('COMPACT_PACKED_RETENTION_ENABLED');
  const expiry = flag('COMPACT_PACKED_EXPIRY_ENABLED');
  const history = flag('COMPACT_HISTORY_EXPIRY_ENABLED');
  if (retention && !enabled) fail('packed_retention_requires_packing');
  if (expiry && !retention) fail('packed_expiry_requires_retention');
  if (history && !expiry) fail('history_expiry_requires_packed_expiry');
  return Object.freeze({ enabled, retention, expiry, history,
    hotHours: number('COMPACT_PACKED_HOT_HOURS', PACKED_MIN_HOT_HOURS, PACKED_MIN_HOT_HOURS, 400 * 24),
    maintenanceScopes: number('COMPACT_PACKED_MAINTENANCE_SCOPES', 16, 1, 256),
    // Write-ahead log a pass may plan for its deletions; the first deletion of a pass is never refused by this alone.
    maintenanceMiB: number('COMPACT_PACKED_MAINTENANCE_MAX_MIB', 64, 1, 1024) });
}

// A JSON column value: NULL, TEXT or a safe INTEGER, which JSON returns with the same type. A BLOB is never JSON-packed.
function columnValue(value) {
  if (ArrayBuffer.isView(value)) fail('packed_value_type_invalid');
  typed(value);
  return value;
}

// One piece's raw bytes. Columns: a JSON array of value arrays in table column order (scope column omitted). Addresses:
// the concatenated 20-byte identities.
function encodePiece(codec, columns, rows) {
  if (codec === 'address-b20') {
    if (!rows.every((row) => ArrayBuffer.isView(row.address) && row.address.byteLength === ADDRESS_BYTES)) fail('packed_address_invalid');
    return Buffer.concat(rows.map((row) => Buffer.from(row.address.buffer, row.address.byteOffset, row.address.byteLength)));
  }
  return Buffer.from(JSON.stringify(rows.map((row) => columns.map((column) => columnValue(row[column])))));
}

// At most one bounded piece's column arrays are decoded. Full row objects are materialized only for consumers
// that need them; the typed digest still covers EVERY schema column of EVERY row, including the implicit scope.
function decodePiece(codec, columns, raw, rowCount) {
  if (codec === 'address-b20') {
    if (raw.length !== rowCount * ADDRESS_BYTES) fail('packed_piece_corrupt');
    return Array.from({ length: rowCount }, (_, index) =>
      [new Uint8Array(raw.subarray(index * ADDRESS_BYTES, (index + 1) * ADDRESS_BYTES))]);
  }
  let values;
  try { values = JSON.parse(raw.toString('utf8')); } catch { fail('packed_piece_corrupt'); }
  if (!Array.isArray(values) || values.length !== rowCount) fail('packed_piece_corrupt');
  for (const value of values) if (!Array.isArray(value) || value.length !== columns.length) fail('packed_piece_corrupt');
  return values;
}
const materializeRow = (definition, scope, values) => {
  const row = { [definition.scope]: scope };
  for (let i = 0; i < definition.columns.length; i++) row[definition.columns[i]] = values[i];
  return row;
};

// db: the store's DatabaseSync. Writes (packHour, packDay) must run inside the caller's open writer transaction; each set
// is written inside its own savepoint so a failure leaves the caller's rows untouched and is only reported.
// preflight(plannedBytes): the store's storage check ({ ok, reason }). beforePack(dataset, scope): test hook.
export function createPackedShards(db, { config = packedShardsConfig(), preflight = () => ({ ok: true }), log = console.warn,
  beforePack = null, reusePoolProofs = false, onPieceRead = null } = {}) {
  // Fixed scratch for synchronous typed-row hashing. Each piece flushes before yielding, so iterators may safely
  // interleave without retaining or sharing unhashed bytes. Native SHA update consumes the buffer synchronously.
  const digestBuffer = Buffer.allocUnsafe(64 * 1024);
  // Proofs this reader issued for sets that verified completely (openPieces). Only an object from this set is accepted.
  const issuedProofs = new WeakSet();
  // Opt-in read-model cache only. Writers keep their original behavior. A proof never contains decoded rows or raw bytes.
  const poolProofs = new Map();
  let proofBytes = 0, proofPieces = 0;
  const proofStats = { hits: 0, misses: 0, evictions: 0, verifiedSets: 0, verifiedRows: 0, proofReads: 0 };
  const dropProof = (scope, evicted = true) => {
    const entry = poolProofs.get(scope);
    if (!entry) return;
    poolProofs.delete(scope); proofBytes -= entry.bytes; proofPieces -= entry.proof.pieces.length;
    if (evicted) proofStats.evictions++;
  };
  const rememberProof = (scope, proof) => {
    const bytes = PROOF_SCOPE_BYTES + proof.pieces.length * PROOF_PIECE_BYTES;
    if (bytes > PACKED_POOL_PROOF_MAX_BYTES || proof.pieces.length > PROOF_MAX_PIECES) return;
    dropProof(scope, false);
    while (poolProofs.size >= PACKED_POOL_PROOF_MAX_SCOPES || proofBytes + bytes > PACKED_POOL_PROOF_MAX_BYTES
      || proofPieces + proof.pieces.length > PROOF_MAX_PIECES) dropProof(poolProofs.keys().next().value);
    poolProofs.set(scope, { proof, bytes }); proofBytes += bytes; proofPieces += proof.pieces.length;
  };
  const tablesExist = () => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'compact_packed_sets'").get());
  const prunedTableExists = () => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'compact_packed_pruned'").get());
  const expiredTableExists = () => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'compact_packed_expired'").get());
  const int = (value) => BigInt(value);
  const retention = config.retention === true;
  const hotHours = Number.isSafeInteger(config.hotHours) ? Math.max(config.hotHours, PACKED_MIN_HOT_HOURS) : PACKED_MIN_HOT_HOURS;
  const maintenanceScopes = Number.isSafeInteger(config.maintenanceScopes) ? config.maintenanceScopes : 16;
  const expiry = retention && config.expiry === true;
  const history = expiry && config.history === true;
  const maintenanceBytes = (Number.isSafeInteger(config.maintenanceMiB) ? config.maintenanceMiB : 64) * MiB;
  // The persisted history floor (history-expiry.js): every hour before it lost its detail rows. Null when never raised.
  const historyFloor = () => (db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'compact_packed_history_floor'").get()
    ? db.prepare("SELECT hour_start FROM compact_packed_history_floor WHERE name = 'details'").get()?.hour_start ?? null : null);
  // The oldest scope start packing may still touch: a scope whose last hour is before the floor is never packed again.
  const lowestScope = (definition) => {
    const floor = historyFloor();
    return floor === null ? 0 : floor - (definition.scope === 'day_start' ? DAY - HOUR : 0);
  };
  // Sets written by the current writer transaction (reset by begin()): such a set never authorizes removing hot rows.
  const created = new Set();
  const keyOf = (dataset, scope) => `${dataset}:${scope}`;
  // True when retention removed this scope's hot rows; readers then read the packed set, and only then.
  const isPruned = (dataset, scope) => prunedTableExists()
    && Boolean(db.prepare('SELECT 1 FROM compact_packed_pruned WHERE dataset = ? AND scope_start = ?').get(dataset, int(scope)));
  // True when expiry deleted this pruned scope's packed set: its rows exist nowhere any more, and readers must say so.
  const isExpired = (dataset, scope) => expiredTableExists()
    && Boolean(db.prepare('SELECT 1 FROM compact_packed_expired WHERE dataset = ? AND scope_start = ?').get(dataset, int(scope)));
  const prunedScopes = (dataset, from, to) => (prunedTableExists()
    ? db.prepare('SELECT scope_start FROM compact_packed_pruned WHERE dataset = ? AND scope_start BETWEEN ? AND ? ORDER BY scope_start')
      .all(dataset, int(from), int(to)).map((row) => row.scope_start) : []);
  const schemaOf = (dataset) => db.prepare(`PRAGMA table_info(${dataset})`).all();
  const definitionOf = (dataset) => {
    const spec = PACKED_DATASETS[dataset];
    if (!spec) fail('packed_dataset_invalid');
    const schema = schemaOf(dataset);
    const columns = schema.map((column) => column.name).filter((name) => name !== spec.scope);
    if (!schema.some((column) => column.name === spec.scope) || (spec.codec === 'address-b20' && (columns.length !== 1 || columns[0] !== 'address'))) {
      fail('packed_definition_mismatch');
    }
    const order = schema.filter((column) => column.pk).sort((a, b) => a.pk - b.pk).map((column) => column.name).join(', ');
    return { ...spec, schema, columns, order };
  };
  const canonicalHours = (definition, scope) => (definition.scope === 'day_start'
    ? db.prepare('SELECT * FROM compact_hours WHERE hour_start >= ? AND hour_start < ? ORDER BY hour_start').all(int(scope), int(scope + DAY))
    : db.prepare('SELECT * FROM compact_hours WHERE hour_start = ?').all(int(scope)));
  const bindingOf = (dataset, definition, scope, hours, digest) => sha256(canonical({ version: PACKED_SHARDS_VERSION, dataset, scope, codec: definition.codec,
    columns: definition.columns, schema: definition.schema.map(({ name, type, notnull, pk }) => [name, type, notnull, pk]), canonicalHours: hours,
    rowCount: digest.count, rowsSha256: digest.sha256 }));

  // Null when the set's rows are final and complete, else the reason it is not packed yet.
  function notReady(dataset, definition, scope, hours, rowCount) {
    if (definition.scope === 'day_start') {
      if (hours.length !== 24) return 'day_hours_missing';
      const captured = db.prepare('SELECT COUNT(*) AS count FROM compact_daily_address_hours WHERE day_start = ?').get(int(scope)).count;
      const daily = db.prepare('SELECT status, active_addresses FROM compact_daily_active_addresses WHERE day_start = ?').get(int(scope));
      if (captured !== 24 || daily?.status !== 'available') return 'day_not_final';
      return daily.active_addresses === rowCount ? null : 'hot_rows_incomplete';
    }
    if (hours.length !== 1) return 'hour_missing';
    if (definition.codec === 'address-b20') return hours[0].unique_active_addresses === rowCount ? null : 'hot_rows_incomplete';
    let expected = 0;
    for (const projection of definition.projections) {
      const row = db.prepare('SELECT status, row_count FROM compact_projection_hours WHERE hour_start = ? AND projection = ?').get(int(scope), projection);
      if (row?.status !== 'available') return 'projection_not_available';
      expected += row.row_count;
    }
    return expected === rowCount ? null : 'hot_rows_incomplete';
  }

  // Writes one set's pieces while its source rows stream past in primary-key order: a chunk of at most 256 rows (4096
  // addresses) is encoded, deflated, stored and released before the next row is read, and the row digest is updated row
  // by row, so memory is bounded by one piece whatever the size of the hour or day. A chunk over the raw size bound is
  // split in halves (never truncated). Each new payload passes the storage check before it is written.
  function writePieces(dataset, definition, scope, rows) {
    const size = definition.codec === 'address-b20' ? PACKED_ADDRESS_ROWS : PACKED_COLUMN_ROWS;
    const payloadOf = db.prepare('SELECT raw_sha256, raw_bytes FROM compact_packed_payloads WHERE payload_sha256 = ?');
    const insertPayload = db.prepare('INSERT INTO compact_packed_payloads (payload_sha256, raw_sha256, raw_bytes, payload) VALUES (?, ?, ?, ?)');
    const insertPiece = db.prepare('INSERT INTO compact_packed_pieces (dataset, scope_start, part, row_count, payload_sha256) VALUES (?, ?, ?, ?, ?)');
    const hash = createHash('sha256');
    const totals = { count: 0, pieces: 0, rawBytes: 0, storedBytes: 0, newPayloadBytes: 0 };
    const store = (chunk) => {
      const raw = encodePiece(definition.codec, definition.columns, chunk);
      if (raw.length > PACKED_MAX_RAW_PIECE_BYTES) {
        if (chunk.length === 1) fail('packed_piece_too_large');
        const half = Math.ceil(chunk.length / 2);
        store(chunk.slice(0, half));
        store(chunk.slice(half));
        return;
      }
      const payload = deflateRawSync(raw, { level: 1 });
      const payloadSha = sha256(payload);
      const rawSha = sha256(raw);
      const existing = payloadOf.get(payloadSha);
      if (existing && (existing.raw_sha256 !== rawSha || existing.raw_bytes !== raw.length)) fail('packed_payload_conflict');
      if (!existing) {
        const check = preflight(payload.length + 512);
        if (!check?.ok) throw new PackedShardsError('packed_storage_blocked', check?.reason ?? 'storage_capacity_unknown');
        insertPayload.run(payloadSha, rawSha, int(raw.length), payload);
        totals.newPayloadBytes += payload.length;
      }
      insertPiece.run(dataset, int(scope), int(totals.pieces), int(chunk.length), payloadSha);
      totals.pieces++;
      totals.rawBytes += raw.length;
      totals.storedBytes += payload.length;
    };
    let chunk = [];
    for (const row of rows) {
      if (row[definition.scope] !== scope) fail('packed_scope_mismatch');
      hash.update(`${rowText(row)}\n`);
      totals.count++;
      chunk.push(row);
      if (chunk.length === size) { store(chunk); chunk = []; }
    }
    if (chunk.length) store(chunk);
    return { ...totals, sha256: hash.digest('hex') };
  }

  // Packs one (dataset, scope) inside the caller's transaction. Outcomes: inserted | unchanged | not_ready:<reason> |
  // storage_blocked:<reason>. A different set already stored for the scope is a conflict (thrown).
  function packScope(dataset, scope) {
    if (!config.enabled) fail('packed_shards_disabled');
    if (db.isTransaction !== true) fail('packed_transaction_required');
    const definition = definitionOf(dataset);
    if (!Number.isSafeInteger(scope) || scope % (definition.scope === 'day_start' ? DAY : HOUR) !== 0) fail('packed_scope_invalid');
    // A pruned scope's packed set is its only copy (immutable, verified on every read): a replayed hour leaves it as it is.
    if (isPruned(dataset, scope)) return { outcome: 'unchanged' };
    if (scope < lowestScope(definition)) return { outcome: 'not_ready:history_expired' };
    const hours = canonicalHours(definition, scope);
    // Counts first: a set that is not final is never read row by row (a day's stage can hold a whole day of identities).
    const rowCount = db.prepare(`SELECT COUNT(*) AS count FROM ${dataset} WHERE ${definition.scope} = ?`).get(int(scope)).count;
    const waiting = notReady(dataset, definition, scope, hours, rowCount);
    if (waiting) return { outcome: `not_ready:${waiting}` };
    // Final source rows are insert-only, so a stored set of the same final scope is unchanged when its count matches;
    // its content is fully re-verified on every read (forEachRow).
    const stored = db.prepare('SELECT row_count FROM compact_packed_sets WHERE dataset = ? AND scope_start = ?').get(dataset, int(scope));
    if (stored) {
      if (stored.row_count !== rowCount) fail('packed_set_conflict');
      return { outcome: 'unchanged' };
    }
    beforePack?.(dataset, scope);
    // The final hot rows stream straight into pieces (an iterator, never a loaded array).
    const source = db.prepare(`SELECT * FROM ${dataset} WHERE ${definition.scope} = ? ORDER BY ${definition.order}`).iterate(int(scope));
    const written = writePieces(dataset, definition, scope, source);
    if (written.count !== rowCount) fail('packed_scope_mismatch');
    const binding = bindingOf(dataset, definition, scope, hours, written);
    db.prepare(`INSERT INTO compact_packed_sets (dataset, scope_start, version, codec, columns_json, row_count, rows_sha256, pieces, binding_sha256,
      raw_bytes, stored_bytes) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(dataset, int(scope), PACKED_SHARDS_VERSION, definition.codec,
      JSON.stringify(definition.columns), int(written.count), written.sha256, int(written.pieces), binding, int(written.rawBytes), int(written.storedBytes));
    created.add(keyOf(dataset, scope));
    // Read every piece back and require the exact typed row digest (checked against the digest just stored) before the
    // caller can commit. Streaming too: no decoded row is kept.
    const verified = streamSet(dataset, scope);
    if (verified?.rowCount !== written.count) fail('packed_readback_mismatch');
    return { outcome: 'inserted', rows: written.count, pieces: written.pieces, rawBytes: written.rawBytes, storedBytes: written.storedBytes,
      newPayloadBytes: written.newPayloadBytes };
  }

  // Opens a stored set in primary-key order with the table's column order: null when the set is not stored,
  // else a bounded piece iterator that returns { rowCount, pieces, rawBytes, storedBytes } at its verified end. The set's
  // binding to the current canonical hours and table schema (and its stored row count and digest) is checked when it is
  // opened; each piece's payload and raw SHA256, size and order before its first row; the row count, row digest and byte
  // totals at the end. Memory is bounded by one piece. On any mismatch it throws, and a caller must discard the rows it
  // already received: only an iterator that reached its end means the whole set verified. That end also returns a proof.
  // proof: one this reader returned for the same set. The typed row digest is a function of the set's binding (schema,
  // columns, codec, canonical hours, row count and digest) and the raw bytes alone, so with a proof every piece is still
  // read, size-checked and SHA256-hashed (payload and raw) and must be byte-identical to the verified run; only the typed
  // row digest is not computed a second time. Any difference from the proof throws packed_proof_mismatch.
  function openPieces(dataset, scope, proof = null) {
    if (!tablesExist()) return null;
    const definition = definitionOf(dataset);
    const set = db.prepare('SELECT * FROM compact_packed_sets WHERE dataset = ? AND scope_start = ?').get(dataset, int(scope));
    if (!set) return null;
    if (set.version !== PACKED_SHARDS_VERSION || set.codec !== definition.codec || set.columns_json !== JSON.stringify(definition.columns)) {
      fail('packed_definition_mismatch');
    }
    if (bindingOf(dataset, definition, scope, canonicalHours(definition, scope), { count: set.row_count, sha256: set.rows_sha256 }) !== set.binding_sha256) {
      fail('packed_binding_mismatch');
    }
    const cacheable = reusePoolProofs && dataset === 'compact_pool_hours';
    if (proof === null && cacheable) {
      const cached = poolProofs.get(Number(scope))?.proof;
      if (cached && cached.binding === set.binding_sha256 && cached.rowsSha256 === set.rows_sha256
        && cached.rowCount === set.row_count && cached.pieces.length === set.pieces) {
        proof = cached; proofStats.hits++;
      } else { if (cached) dropProof(Number(scope)); proofStats.misses++; }
    }
    if (proof !== null && (!issuedProofs.has(proof) || proof.dataset !== dataset || proof.scope !== Number(scope) || proof.binding !== set.binding_sha256
      || proof.rowsSha256 !== set.rows_sha256 || proof.rowCount !== set.row_count || proof.pieces.length !== set.pieces)) fail('packed_proof_mismatch');
    const payload = db.prepare('SELECT * FROM compact_packed_payloads WHERE payload_sha256 = ?');
    const digestRow = rowDigestEncoder(definition.schema, definition.columns, definition.scope);
    const pieces = db.prepare('SELECT part, row_count, payload_sha256 FROM compact_packed_pieces WHERE dataset = ? AND scope_start = ? ORDER BY part');
    return (function* rows() {
      const hash = proof ? null : createHash('sha256');
      const verifiedPieces = [];
      let count = 0;
      let part = 0;
      let rawBytes = 0;
      let storedBytes = 0;
      for (const piece of pieces.iterate(dataset, int(scope))) {
        if (piece.part !== part || part >= set.pieces) fail('packed_pieces_corrupt');
        const expected = proof?.pieces[part];
        part++;
        const blob = payload.get(piece.payload_sha256);
        if (!blob || sha256(blob.payload) !== piece.payload_sha256) fail('packed_payload_corrupt');
        let raw;
        try { raw = inflateRawSync(blob.payload, { maxOutputLength: PACKED_MAX_RAW_PIECE_BYTES }); } catch { fail('packed_payload_corrupt'); }
        if (raw.length !== blob.raw_bytes || sha256(raw) !== blob.raw_sha256) fail('packed_payload_corrupt');
        if (expected && (expected.payloadSha256 !== piece.payload_sha256 || expected.rawSha256 !== blob.raw_sha256
          || expected.rowCount !== piece.row_count)) fail('packed_proof_mismatch');
        rawBytes += raw.length;
        storedBytes += blob.payload.byteLength;
        const values = decodePiece(definition.codec, definition.columns, raw, piece.row_count);
        // Same UTF-8 bytes and row order as the independent writer's rowText+newline, with fixed 64 KiB scratch.
        // Avoid a piece-sized array of checksum strings and its concatenated copy. An unusually large single row
        // is hashed directly (still bounded by the decoded piece); no truncation, skipped rows or weaker digest.
        if (hash) {
          let used = 0;
          for (const value of values) {
            const line = `${digestRow(value, scope)}\n`, bytes = Buffer.byteLength(line);
            if (used + bytes > digestBuffer.length) { if (used) hash.update(digestBuffer.subarray(0, used)); used = 0; }
            if (bytes > digestBuffer.length) hash.update(line);
            else used += digestBuffer.write(line, used, bytes, 'utf8');
          }
          if (used) hash.update(digestBuffer.subarray(0, used));
          verifiedPieces.push(Object.freeze({ payloadSha256: piece.payload_sha256, rawSha256: blob.raw_sha256, rowCount: piece.row_count }));
        }
        count += values.length;
        onPieceRead?.();
        yield { definition, values };
      }
      if (part !== set.pieces) fail('packed_pieces_corrupt');
      if (count !== set.row_count || (hash && hash.digest('hex') !== set.rows_sha256) || rawBytes !== set.raw_bytes || storedBytes !== set.stored_bytes) {
        fail('packed_rows_corrupt');
      }
      if (!proof) {
        proof = Object.freeze({ dataset, scope: Number(scope), binding: set.binding_sha256, rowsSha256: set.rows_sha256, rowCount: set.row_count,
          pieces: Object.freeze(verifiedPieces) });
        issuedProofs.add(proof);
        if (cacheable) { proofStats.verifiedSets++; proofStats.verifiedRows += count; }
      } else if (cacheable) {
        proofStats.proofReads++;
      }
      if (cacheable) rememberProof(Number(scope), proof);
      return { rowCount: count, pieces: part, rawBytes, storedBytes, proof };
    })();
  }

  // Row iterator compatibility for identity merging and other existing consumers. End-of-set proof is shared
  // with the direct streaming path; no caller may accept output before this iterator reaches its verified end.
  function openSet(dataset, scope) {
    const pieces = openPieces(dataset, scope);
    if (!pieces) return null;
    return (function* rows() {
      try {
        for (let step = pieces.next(); ; step = pieces.next()) {
          if (step.done) return step.value;
          const { definition, values } = step.value;
          for (const value of values) yield materializeRow(definition, scope, value);
        }
      } finally { pieces.return?.(); }
    })();
  }

  // Streams a verified set without per-row generator transitions. The pool-only callback observes existing column
  // values, and materializes only ranked rows in the read model. All checksum/binding/count checks remain identical;
  // with a proof (openPieces) the set's bytes must match the run that verified it and its row digest is not recomputed.
  function streamSet(dataset, scope, onRow = null, onPoolSwap = null, proof = null) {
    const pieces = openPieces(dataset, scope, proof);
    if (!pieces) return null;
    try {
      for (let step = pieces.next(); ; step = pieces.next()) {
        if (step.done) return step.value;
        const { definition, values } = step.value;
        if (onPoolSwap) {
          const columns = definition.columns;
          const protocol = columns.indexOf('protocol'), pool = columns.indexOf('pool'), count = columns.indexOf('swap_count');
          if (dataset !== 'compact_pool_hours' || Math.min(protocol, pool, count) < 0) fail('packed_definition_mismatch');
          for (const value of values) onPoolSwap(value[protocol], value[pool], value[count], value, columns, scope);
        } else if (onRow) for (const value of values) onRow(materializeRow(definition, scope, value));
      }
    } finally { pieces.return?.(); }
  }

  // Packs a set inside its own savepoint; a failure rolls back only that set and is reported, never thrown, so packing
  // can never block or change the hour, family, projection, address or checkpoint rows of the caller's transaction.
  function packSafely(dataset, scope) {
    db.exec('SAVEPOINT compact_packed_shards');
    try {
      const report = packScope(dataset, scope);
      db.exec('RELEASE compact_packed_shards');
      return report;
    } catch (error) {
      db.exec('ROLLBACK TO compact_packed_shards');
      db.exec('RELEASE compact_packed_shards');
      const storage = error?.code === 'packed_storage_blocked';
      const reason = storage ? `storage:${error.reason}` : error?.code ?? 'packed_shards_failed';
      log(`PACKED_SHARDS_BLOCKED dataset=${dataset} scope=${scope} reason=${reason}`);
      return { outcome: storage ? `storage_blocked:${error.reason}` : `failed:${reason}` };
    }
  }

  // Last hour a scope covers, and the newest last hour retention may remove for the newest stored hour.
  const lastHourOf = (definition, scope) => (definition.scope === 'day_start' ? scope + DAY - HOUR : scope);
  const retentionCutoff = (newest) => newest - hotHours * HOUR;
  const valuationsFinal = (hour) => db.prepare(`SELECT COUNT(*) AS count FROM compact_valuation_hours WHERE hour_start = ? AND status = 'available'
    AND valuation IN (${VALUATIONS.map(() => '?').join(', ')})`).get(int(hour), ...VALUATIONS).count === VALUATIONS.length;
  // With history expiry, the newest pool hour whose valuations are frozen: outside the pool-hour retention no pass derives
  // them again (store.js, valuation and projection backfill), and history expiry deletes their status rows later, so such a
  // pool hour must not wait for them. Without history expiry nothing is frozen (-1): the step 2 rule holds unchanged.
  const frozenCutoff = (newest) => (history ? newest - POOL_HOUR_RETENTION_HOURS * HOUR : -1);

  // A deletion writes the pages it touches to the write-ahead log before any space is freed. It is admitted only when the
  // store's storage check (free space after a reserve, database and WAL budget) accepts the pass's planned bytes; after the
  // pass's first deletion also only within the pass budget. Admitted bytes count against the pass even if rolled back.
  function admit(pass, planned) {
    if (pass.bytes > 0 && pass.bytes + planned > maintenanceBytes) return false;
    const check = preflight(pass.bytes + planned);
    if (!check?.ok) throw new PackedShardsError('packed_storage_blocked', check?.reason ?? 'storage_capacity_unknown');
    pass.bytes += planned;
    return true;
  }

  // Removes one scope's hot rows inside the caller's transaction, or keeps them and says why. Throws (caught by
  // pruneSafely, which rolls the savepoint back) when the packed set does not verify or differs from the hot rows.
  function pruneScope(dataset, scope, newest, pass) {
    if (!retention) fail('packed_retention_disabled');
    if (db.isTransaction !== true) fail('packed_transaction_required');
    const definition = definitionOf(dataset);
    if (lastHourOf(definition, scope) > retentionCutoff(newest)) return { outcome: 'kept:hot_window' };
    if (created.has(keyOf(dataset, scope))) return { outcome: 'kept:packed_in_this_transaction' };
    if (isPruned(dataset, scope)) return { outcome: 'unchanged' };
    const set = db.prepare('SELECT row_count, rows_sha256, raw_bytes FROM compact_packed_sets WHERE dataset = ? AND scope_start = ?').get(dataset, int(scope));
    if (!set) return { outcome: 'kept:not_packed' };
    if (definition.projections && scope > frozenCutoff(newest) && !valuationsFinal(scope)) return { outcome: 'kept:valuations_not_final' };
    // The hot rows' pages (about twice their raw bytes) and their index pages.
    if (!admit(pass, 2 * set.raw_bytes + 64 * 1024)) return { outcome: 'kept:pass_budget' };
    // 1. The packed set verifies completely now, in a transaction after the one that wrote it (streamed, bounded).
    streamSet(dataset, scope);
    // 2. The hot rows are exactly the packed rows: same count and the same typed digest, streamed in primary-key order.
    //    Pool hours add their swaps to the pruned totals in the same pass (rolled back with everything else on failure).
    const addSwaps = dataset === 'compact_pool_hours' ? db.prepare(`INSERT INTO compact_packed_pool_swaps (protocol, pool, swap_count, row_count)
      VALUES (?, ?, ?, 1) ON CONFLICT (protocol, pool) DO UPDATE SET swap_count = swap_count + excluded.swap_count, row_count = row_count + 1`) : null;
    const hash = createHash('sha256');
    let count = 0;
    for (const row of db.prepare(`SELECT * FROM ${dataset} WHERE ${definition.scope} = ? ORDER BY ${definition.order}`).iterate(int(scope))) {
      hash.update(`${rowText(row)}\n`);
      count++;
      addSwaps?.run(row.protocol, row.pool, int(row.swap_count));
    }
    if (count !== set.row_count || hash.digest('hex') !== set.rows_sha256) fail('packed_hot_rows_differ');
    // 3. Mark the scope and remove exactly its hot rows.
    db.prepare('INSERT INTO compact_packed_pruned (dataset, scope_start, row_count, rows_sha256) VALUES (?, ?, ?, ?)')
      .run(dataset, int(scope), int(count), set.rows_sha256);
    const deleted = Number(db.prepare(`DELETE FROM ${dataset} WHERE ${definition.scope} = ?`).run(int(scope)).changes);
    if (deleted !== count || db.prepare(`SELECT COUNT(*) AS count FROM ${dataset} WHERE ${definition.scope} = ?`).get(int(scope)).count !== 0) {
      fail('packed_prune_mismatch');
    }
    return { outcome: 'pruned', rows: count };
  }

  // Runs one deletion inside its own savepoint; a failure rolls back only that scope and is reported, never thrown.
  function deleteSafely(savepoint, tag, work, dataset, scope) {
    db.exec(`SAVEPOINT ${savepoint}`);
    try {
      const report = work();
      db.exec(`RELEASE ${savepoint}`);
      return report;
    } catch (error) {
      db.exec(`ROLLBACK TO ${savepoint}`);
      db.exec(`RELEASE ${savepoint}`);
      const storage = error?.code === 'packed_storage_blocked';
      const reason = storage ? `storage:${error.reason}` : error?.code ?? `${savepoint}_failed`;
      log(`${tag} dataset=${dataset} scope=${scope} reason=${reason}`);
      return { outcome: storage ? `storage_blocked:${error.reason}` : `failed:${reason}` };
    }
  }
  const pruneSafely = (dataset, scope, newest, pass) => deleteSafely('compact_packed_retention', 'PACKED_RETENTION_BLOCKED',
    () => pruneScope(dataset, scope, newest, pass), dataset, scope);

  // Deletes one pruned scope's packed set once nothing can reach it (PACKED_KEEP_HOURS), or keeps it and says why.
  // Throws (caught by expireSafely) when the set no longer matches its prune marker, hot rows came back, an expiring pool
  // hour's set cannot be read for its creation-hour swaps, or the storage check refuses the deletion.
  const keepHoursOf = (definition) => (definition.codec === 'address-b20' ? PACKED_KEEP_HOURS.identity : PACKED_KEEP_HOURS.pool);
  const expiryCutoff = (definition, newest) => newest - (keepHoursOf(definition) - 1) * HOUR; // the oldest last hour kept
  function expireScope(dataset, scope, newest, pass) {
    if (!expiry) fail('packed_expiry_disabled');
    if (db.isTransaction !== true) fail('packed_transaction_required');
    const definition = definitionOf(dataset);
    if (lastHourOf(definition, scope) >= expiryCutoff(definition, newest)) return { outcome: 'kept:needed' };
    if (isExpired(dataset, scope)) return { outcome: 'unchanged' };
    const marker = db.prepare('SELECT row_count, rows_sha256 FROM compact_packed_pruned WHERE dataset = ? AND scope_start = ?').get(dataset, int(scope));
    if (!marker) return { outcome: 'kept:not_pruned' };
    const set = db.prepare('SELECT row_count, rows_sha256, pieces, stored_bytes FROM compact_packed_sets WHERE dataset = ? AND scope_start = ?')
      .get(dataset, int(scope));
    if (!set || set.row_count !== marker.row_count || set.rows_sha256 !== marker.rows_sha256) fail('packed_expiry_set_mismatch');
    if (db.prepare(`SELECT COUNT(*) AS count FROM ${dataset} WHERE ${definition.scope} = ?`).get(int(scope)).count !== 0) {
      fail('packed_expiry_hot_rows_present');
    }
    // The set's payload pages and its index pages.
    if (!admit(pass, set.stored_bytes + 64 * 1024)) return { outcome: 'kept:pass_budget' };
    if (dataset === 'compact_pool_hours') keepCreationSwaps(scope, (onRow) => streamSet('compact_pool_hours', scope, onRow));
    db.prepare('INSERT INTO compact_packed_expired (dataset, scope_start, row_count, rows_sha256) VALUES (?, ?, ?, ?)')
      .run(dataset, int(scope), int(set.row_count), set.rows_sha256);
    const payloads = db.prepare('SELECT DISTINCT payload_sha256 FROM compact_packed_pieces WHERE dataset = ? AND scope_start = ?')
      .all(dataset, int(scope)).map((row) => row.payload_sha256);
    const pieces = Number(db.prepare('DELETE FROM compact_packed_pieces WHERE dataset = ? AND scope_start = ?').run(dataset, int(scope)).changes);
    const sets = Number(db.prepare('DELETE FROM compact_packed_sets WHERE dataset = ? AND scope_start = ?').run(dataset, int(scope)).changes);
    if (pieces !== set.pieces || sets !== 1) fail('packed_expiry_mismatch');
    // A payload another set still references (an equal piece) stays.
    const unreferenced = db.prepare(`DELETE FROM compact_packed_payloads WHERE payload_sha256 = ?
      AND NOT EXISTS (SELECT 1 FROM compact_packed_pieces WHERE payload_sha256 = ?)`);
    for (const payload of payloads) unreferenced.run(payload, payload);
    return { outcome: 'expired', rows: set.row_count };
  }
  const expireSafely = (dataset, scope, newest, pass) => deleteSafely('compact_packed_expiry', 'PACKED_EXPIRY_BLOCKED',
    () => expireScope(dataset, scope, newest, pass), dataset, scope);

  // Before an hour's pool rows are gone for good: the creation-hour swap count of every registered pool created in that
  // hour (NULL when the pool had no row in it), exactly what the ecosystem reads as early activity (intelligence-store.js).
  // read(onRow) streams the hour's rows (the verified set, or the final hot rows a fold removes) and returns a falsy value
  // when they cannot be read; a pool registered only after this hour expired is never given a count.
  function keepCreationSwaps(hour, read) {
    const range = db.prepare('SELECT first_block, last_block FROM compact_hours WHERE hour_start = ?').get(int(hour));
    if (!range) fail('packed_expiry_hour_missing');
    const created = new Map(db.prepare(`SELECT kind, address FROM compact_registry WHERE kind IN ('uniswap_v3_pool', 'uniswap_v4_pool')
      AND created_block BETWEEN ? AND ?`).all(int(range.first_block), int(range.last_block))
      .map((row) => [`${row.kind === 'uniswap_v3_pool' ? 'uniswap_v3' : 'uniswap_v4'}:${row.address}`, null]));
    if (!created.size) return;
    const verified = read((row) => {
      const key = `${row.protocol}:${row.pool}`;
      if (created.has(key)) created.set(key, row.swap_count);
    });
    if (!verified) fail('packed_expiry_set_mismatch');
    const insert = db.prepare('INSERT INTO compact_packed_pool_creation_swaps (protocol, pool, hour_start, swap_count) VALUES (?, ?, ?, ?)');
    for (const [key, swaps] of created) {
      const [protocol, pool] = key.split(':');
      insert.run(protocol, pool, int(hour), swaps === null ? null : int(swaps));
    }
  }

  // History expiry (history-expiry.js) of a pool hour before the history floor that was never packed (stored before
  // packing, or reached the floor first): it keeps exactly what pruning and expiry keep of a pool hour, its swaps in the
  // all-history totals and the creation-hour counts of the pools created in it, and then deletes its hot rows. Only a final
  // hour (both pool projections available, every row present) is folded; anything else throws and its rows stay. Runs in
  // the caller's savepoint.
  function foldPoolHour(hour) {
    if (!history) fail('history_expiry_disabled');
    if (db.isTransaction !== true) fail('packed_transaction_required');
    const floor = historyFloor();
    if (floor === null || hour >= floor) fail('history_fold_not_expired');
    const packedSet = db.prepare("SELECT 1 FROM compact_packed_sets WHERE dataset = 'compact_pool_hours' AND scope_start = ?").get(int(hour));
    if (packedSet || isPruned('compact_pool_hours', hour)) fail('history_fold_packed');
    const final = db.prepare(`SELECT COUNT(*) AS available, SUM(row_count) AS rows FROM compact_projection_hours WHERE hour_start = ?
      AND projection IN (?, ?) AND status = 'available'`).get(int(hour), ...PACKED_DATASETS.compact_pool_hours.projections);
    if (final.available !== 2) fail('history_fold_not_final');
    const rows = () => db.prepare('SELECT protocol, pool, swap_count FROM compact_pool_hours WHERE hour_start = ? ORDER BY protocol, pool').iterate(int(hour));
    const addSwaps = db.prepare(`INSERT INTO compact_packed_pool_swaps (protocol, pool, swap_count, row_count) VALUES (?, ?, ?, 1)
      ON CONFLICT (protocol, pool) DO UPDATE SET swap_count = swap_count + excluded.swap_count, row_count = row_count + 1`);
    let count = 0;
    for (const row of rows()) {
      addSwaps.run(row.protocol, row.pool, int(row.swap_count));
      count++;
    }
    if (count !== final.rows) fail('history_fold_not_final');
    keepCreationSwaps(hour, (onRow) => { for (const row of rows()) onRow(row); return true; });
    if (Number(db.prepare('DELETE FROM compact_pool_hours WHERE hour_start = ?').run(int(hour)).changes) !== count) fail('history_fold_mismatch');
    return { outcome: 'folded', rows: count };
  }

  // Oldest pruned scopes whose packed set nothing can reach any more and that are not expired yet.
  function expiryCandidates(dataset, newest, limit) {
    const definition = definitionOf(dataset);
    const newestScope = expiryCutoff(definition, newest) - HOUR - (definition.scope === 'day_start' ? DAY - HOUR : 0);
    return db.prepare(`SELECT m.scope_start FROM compact_packed_pruned m WHERE m.dataset = ? AND m.scope_start <= ?
      AND NOT EXISTS (SELECT 1 FROM compact_packed_expired e WHERE e.dataset = m.dataset AND e.scope_start = m.scope_start)
      ORDER BY m.scope_start LIMIT ?`).all(dataset, int(newestScope), int(limit)).map((row) => row.scope_start);
  }

  // Oldest packed scopes outside the hot window whose hot rows are all present and, for pool data, whose valuations
  // are final. Scopes that cannot qualify are filtered here, so they never consume the maintenance budget.
  function pruneCandidates(dataset, newest, limit) {
    const definition = definitionOf(dataset);
    const cutoff = retentionCutoff(newest) - (definition.scope === 'day_start' ? DAY - HOUR : 0);
    const valuations = definition.projections ? `AND (s.scope_start <= ? OR (SELECT COUNT(*) FROM compact_valuation_hours v WHERE v.hour_start = s.scope_start
      AND v.status = 'available' AND v.valuation IN (${VALUATIONS.map(() => '?').join(', ')})) = ${VALUATIONS.length})` : '';
    return db.prepare(`SELECT s.scope_start FROM compact_packed_sets s WHERE s.dataset = ? AND s.scope_start <= ?
      AND NOT EXISTS (SELECT 1 FROM compact_packed_pruned m WHERE m.dataset = s.dataset AND m.scope_start = s.scope_start)
      AND (SELECT COUNT(*) FROM ${dataset} t WHERE t.${definition.scope} = s.scope_start) = s.row_count ${valuations}
      ORDER BY s.scope_start LIMIT ?`).all(dataset, int(cutoff), ...(definition.projections ? [int(frozenCutoff(newest)), ...VALUATIONS] : []), int(limit))
      .map((row) => row.scope_start).filter((scope) => !created.has(keyOf(dataset, scope)));
  }

  // Oldest final scopes that are not packed yet (hours stored before packing was turned on, or whose projections
  // became available later). The same readiness rules as packScope, as SQL, so a scope that is not final is skipped.
  function packCandidates(dataset, newest, limit) {
    const definition = definitionOf(dataset);
    // Not packed and never pruned: an expired scope has neither hot rows nor a set and must not come back as a candidate.
    const unpacked = (scope) => `NOT EXISTS (SELECT 1 FROM compact_packed_sets s WHERE s.dataset = '${dataset}' AND s.scope_start = ${scope})
      AND NOT EXISTS (SELECT 1 FROM compact_packed_pruned m WHERE m.dataset = '${dataset}' AND m.scope_start = ${scope})`;
    // Scopes before the history floor are skipped: their rows are gone, and an empty scope must not be packed again.
    const lowest = int(lowestScope(definition));
    if (definition.scope === 'day_start') {
      return db.prepare(`SELECT d.day_start AS scope FROM compact_daily_active_addresses d WHERE d.status = 'available' AND d.day_start BETWEEN ? AND ?
        AND ${unpacked('d.day_start')}
        AND (SELECT COUNT(*) FROM compact_hours h WHERE h.hour_start >= d.day_start AND h.hour_start < d.day_start + ${DAY}) = 24
        AND (SELECT COUNT(*) FROM compact_daily_address_hours c WHERE c.day_start = d.day_start) = 24
        AND (SELECT COUNT(*) FROM compact_daily_address_stage a WHERE a.day_start = d.day_start) = d.active_addresses
        ORDER BY d.day_start LIMIT ?`).all(lowest, int(newest), int(limit)).map((row) => row.scope);
    }
    if (definition.codec === 'address-b20') {
      return db.prepare(`SELECT h.hour_start AS scope FROM compact_hours h WHERE h.hour_start BETWEEN ? AND ? AND ${unpacked('h.hour_start')}
        AND (SELECT COUNT(*) FROM ${dataset} a WHERE a.hour_start = h.hour_start) = h.unique_active_addresses
        ORDER BY h.hour_start LIMIT ?`).all(lowest, int(newest), int(limit)).map((row) => row.scope);
    }
    const names = definition.projections.map(() => '?').join(', ');
    return db.prepare(`SELECT h.hour_start AS scope FROM compact_hours h WHERE h.hour_start BETWEEN ? AND ? AND ${unpacked('h.hour_start')}
      AND (SELECT COUNT(*) FROM compact_projection_hours p WHERE p.hour_start = h.hour_start AND p.projection IN (${names})
        AND p.status = 'available') = ${definition.projections.length}
      AND (SELECT COUNT(*) FROM ${dataset} t WHERE t.hour_start = h.hour_start) = (SELECT SUM(p.row_count) FROM compact_projection_hours p
        WHERE p.hour_start = h.hour_start AND p.projection IN (${names}))
      ORDER BY h.hour_start LIMIT ?`).all(lowest, int(newest), ...definition.projections, ...definition.projections, int(limit)).map((row) => row.scope);
  }

  // One bounded retention pass inside the caller's writer transaction: with expiry ON, first delete the packed sets of
  // up to `limit` pruned scopes nothing can reach any more; then remove the hot rows of up to `limit` qualifying scopes
  // packed by earlier transactions; then pack up to `limit` final scopes that are not packed yet (those can only be
  // removed by a later pass). Datasets take turns, oldest scope first. Deletions share one write-ahead-log budget and stop
  // for the rest of the pass at the first storage refusal (the next pass checks again). Null when retention is OFF.
  function maintain(newest, { limit = maintenanceScopes } = {}) {
    if (!retention) return null;
    if (db.isTransaction !== true) fail('packed_transaction_required');
    if (!Number.isSafeInteger(limit) || limit < 1) fail('packed_maintenance_limit_invalid');
    const report = { expired: 0, pruned: 0, packed: 0, kept: 0, failed: [] };
    const pass = { bytes: 0, blocked: false };
    // Candidate selection is read-only; a failure there is reported like a failed scope and never fails the caller.
    const candidates = (select) => Object.keys(PACKED_DATASETS).map((dataset) => {
      try {
        return [dataset, select(dataset, newest, limit)];
      } catch (error) {
        const reason = error?.code ?? 'packed_retention_failed';
        log(`PACKED_RETENTION_BLOCKED dataset=${dataset} scope=candidates reason=${reason}`);
        report.failed.push({ dataset, scope: null, reason });
        return [dataset, []];
      }
    });
    const roundRobin = (lists, budget, run) => {
      for (let round = 0, done = 0; done < budget; round++) {
        const turn = lists.filter(([, scopes]) => round < scopes.length);
        if (!turn.length) break;
        for (const [dataset, scopes] of turn) {
          if (done >= budget) break;
          run(dataset, scopes[round]);
          done++;
        }
      }
    };
    const deletion = (deleteSafe, done) => (dataset, scope) => {
      if (pass.blocked) return;
      const { outcome } = deleteSafe(dataset, scope, newest, pass);
      if (outcome === done) report[done]++;
      else if (outcome.startsWith('failed:')) report.failed.push({ dataset, scope, reason: outcome.slice(7) });
      else if (outcome.startsWith('storage_blocked:')) {
        pass.blocked = true;
        report.failed.push({ dataset, scope, reason: outcome });
      } else report.kept++;
    };
    if (expiry) roundRobin(candidates(expiryCandidates), limit, deletion(expireSafely, 'expired'));
    roundRobin(candidates(pruneCandidates), limit, deletion(pruneSafely, 'pruned'));
    roundRobin(candidates(packCandidates), limit, (dataset, scope) => {
      const { outcome } = packSafely(dataset, scope);
      if (outcome === 'inserted') report.packed++;
      else if (outcome.startsWith('failed:') || outcome.startsWith('storage_blocked:')) report.failed.push({ dataset, scope, reason: outcome });
    });
    return report;
  }

  return Object.freeze({
    config,
    tablesExist,
    // Called before each writer transaction opens; inside one it would forget the sets that transaction already wrote.
    begin() {
      if (db.isTransaction === true) fail('packed_begin_requires_closed_transaction');
      created.clear();
    },
    isPruned,
    isExpired,
    prunedScopes,
    historyFloor,
    foldPoolHour,
    maintain,
    // Writer side (inside the caller's transaction): the hour's datasets, and the hour's UTC day once it is final.
    packHour(hourStart) {
      if (!config.enabled) return null;
      const report = Object.fromEntries(PACKED_HOUR_DATASETS.map((dataset) => [dataset, packSafely(dataset, hourStart)]));
      const dayStart = Math.floor(hourStart / DAY) * DAY;
      report.compact_daily_address_stage = packSafely('compact_daily_address_stage', dayStart);
      return report;
    },
    packDay(dayStart) {
      if (!config.enabled) return null;
      return { compact_daily_address_stage: packSafely('compact_daily_address_stage', dayStart) };
    },
    // Reader side: forEachRow(dataset, scope, onRow) streams a verified set (see streamSet); null when not stored.
    // openRows(dataset, scope) is the same read as an iterator (see openSet), for merging several sets in order.
    forEachRow: streamSet,
    // Returns the set totals with a proof; passing that proof back re-reads the same verified bytes (see openPieces).
    forEachPoolSwap: (scope, onSwap, proof = null) => streamSet('compact_pool_hours', scope, null, onSwap, proof),
    poolProofStats: () => ({ ...proofStats, scopes: poolProofs.size, pieces: proofPieces, accountedBytes: proofBytes,
      maxScopes: PACKED_POOL_PROOF_MAX_SCOPES, maxBytes: PACKED_POOL_PROOF_MAX_BYTES, maxPieces: PROOF_MAX_PIECES }),
    openRows: openSet,
    // Stored set row counts of [from, to] (scope -> rowCount), without reading any piece.
    storedScopes(dataset, from, to) {
      if (!PACKED_DATASETS[dataset]) fail('packed_dataset_invalid');
      if (!tablesExist()) return new Map();
      return new Map(db.prepare('SELECT scope_start, row_count FROM compact_packed_sets WHERE dataset = ? AND scope_start BETWEEN ? AND ?')
        .all(dataset, int(from), int(to)).map((row) => [row.scope_start, row.row_count]));
    },
    status(dataset, scope) {
      if (!tablesExist()) return null;
      if (!PACKED_DATASETS[dataset]) fail('packed_dataset_invalid');
      const set = db.prepare('SELECT * FROM compact_packed_sets WHERE dataset = ? AND scope_start = ?').get(dataset, int(scope));
      return set ? { dataset, scopeStart: set.scope_start, version: set.version, codec: set.codec, rowCount: set.row_count, rowsSha256: set.rows_sha256,
        pieces: set.pieces, rawBytes: set.raw_bytes, storedBytes: set.stored_bytes } : null;
    },
  });
}
