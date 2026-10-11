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
// the canonical compact_hours rows; any mismatch fails closed. Deleting hot rows is NOT part of this module: a later,
// separately approved retention step must re-verify a set in a transaction after the one that wrote it. Until then,
// turning this ON adds the packed bytes on top of the hot rows it copies; it saves no disk by itself.
import { createHash } from 'node:crypto';
import { deflateRawSync, inflateRawSync } from 'node:zlib';

export const PACKED_SHARDS_VERSION = 'arc-packed-shards-v1';
export const PACKED_COLUMN_ROWS = 256;
export const PACKED_ADDRESS_ROWS = 4096;
export const PACKED_MAX_RAW_PIECE_BYTES = 256 * 1024;
const ADDRESS_BYTES = 20;
const HOUR = 3600;
const DAY = 24 * HOUR;

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
CREATE TRIGGER IF NOT EXISTS compact_packed_payload_no_update BEFORE UPDATE ON compact_packed_payloads BEGIN SELECT RAISE(ABORT,'immutable_packed_shards'); END;
CREATE TRIGGER IF NOT EXISTS compact_packed_payload_no_delete BEFORE DELETE ON compact_packed_payloads BEGIN SELECT RAISE(ABORT,'immutable_packed_shards'); END;
CREATE TRIGGER IF NOT EXISTS compact_packed_payload_no_replace BEFORE INSERT ON compact_packed_payloads
WHEN EXISTS (SELECT 1 FROM compact_packed_payloads WHERE payload_sha256 = NEW.payload_sha256) BEGIN SELECT RAISE(ABORT,'immutable_packed_shards'); END;
CREATE TRIGGER IF NOT EXISTS compact_packed_set_no_update BEFORE UPDATE ON compact_packed_sets BEGIN SELECT RAISE(ABORT,'immutable_packed_shards'); END;
CREATE TRIGGER IF NOT EXISTS compact_packed_set_no_delete BEFORE DELETE ON compact_packed_sets BEGIN SELECT RAISE(ABORT,'immutable_packed_shards'); END;
CREATE TRIGGER IF NOT EXISTS compact_packed_set_no_replace BEFORE INSERT ON compact_packed_sets
WHEN EXISTS (SELECT 1 FROM compact_packed_sets WHERE dataset = NEW.dataset AND scope_start = NEW.scope_start) BEGIN SELECT RAISE(ABORT,'immutable_packed_shards'); END;
CREATE TRIGGER IF NOT EXISTS compact_packed_piece_no_update BEFORE UPDATE ON compact_packed_pieces BEGIN SELECT RAISE(ABORT,'immutable_packed_shards'); END;
CREATE TRIGGER IF NOT EXISTS compact_packed_piece_no_delete BEFORE DELETE ON compact_packed_pieces BEGIN SELECT RAISE(ABORT,'immutable_packed_shards'); END;
CREATE TRIGGER IF NOT EXISTS compact_packed_piece_no_replace BEFORE INSERT ON compact_packed_pieces
WHEN EXISTS (SELECT 1 FROM compact_packed_pieces WHERE dataset = NEW.dataset AND scope_start = NEW.scope_start AND part = NEW.part)
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

export function packedShardsConfig(env = process.env) {
  const flag = env.COMPACT_PACKED_SHARDS_ENABLED ?? '';
  if (!['', 'true', 'false'].includes(flag)) fail('invalid_packed_shards_enabled');
  return Object.freeze({ enabled: flag === 'true' });
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

function decodePiece(codec, columns, scopeColumn, scope, raw, rowCount) {
  if (codec === 'address-b20') {
    if (raw.length !== rowCount * ADDRESS_BYTES) fail('packed_piece_corrupt');
    const rows = [];
    for (let index = 0; index < rowCount; index++) {
      rows.push({ [scopeColumn]: scope, address: new Uint8Array(raw.subarray(index * ADDRESS_BYTES, (index + 1) * ADDRESS_BYTES)) });
    }
    return rows;
  }
  let values;
  try { values = JSON.parse(raw.toString('utf8')); } catch { fail('packed_piece_corrupt'); }
  if (!Array.isArray(values) || values.length !== rowCount) fail('packed_piece_corrupt');
  return values.map((value) => {
    if (!Array.isArray(value) || value.length !== columns.length) fail('packed_piece_corrupt');
    const row = { [scopeColumn]: scope };
    columns.forEach((column, index) => { row[column] = value[index]; });
    return row;
  });
}

// db: the store's DatabaseSync. Writes (packHour, packDay) must run inside the caller's open writer transaction; each set
// is written inside its own savepoint so a failure leaves the caller's rows untouched and is only reported.
// preflight(plannedBytes): the store's storage check ({ ok, reason }). beforePack(dataset, scope): test hook.
export function createPackedShards(db, { config = packedShardsConfig(), preflight = () => ({ ok: true }), log = console.warn, beforePack = null } = {}) {
  const tablesExist = () => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'compact_packed_sets'").get());
  const int = (value) => BigInt(value);
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
    // Read every piece back and require the exact typed row digest (checked against the digest just stored) before the
    // caller can commit. Streaming too: no decoded row is kept.
    const verified = streamSet(dataset, scope);
    if (verified?.rowCount !== written.count) fail('packed_readback_mismatch');
    return { outcome: 'inserted', rows: written.count, pieces: written.pieces, rawBytes: written.rawBytes, storedBytes: written.storedBytes,
      newPayloadBytes: written.newPayloadBytes };
  }

  // Streams a stored set, verified, in primary-key order with the table's column order. The set's binding to the current
  // canonical hours and table schema (and its stored row count and digest) is checked first; each piece's payload and raw
  // SHA256, size and order are checked before its rows are passed to onRow; the row count, row digest and byte totals are
  // required at the end. Memory is bounded by one piece. Returns null when the set is not stored. On any mismatch it
  // throws, and a caller must discard the rows it already received: only a returned call means the whole set verified.
  function streamSet(dataset, scope, onRow = null) {
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
    const payload = db.prepare('SELECT * FROM compact_packed_payloads WHERE payload_sha256 = ?');
    const pieces = db.prepare('SELECT part, row_count, payload_sha256 FROM compact_packed_pieces WHERE dataset = ? AND scope_start = ? ORDER BY part');
    const hash = createHash('sha256');
    let count = 0;
    let part = 0;
    let rawBytes = 0;
    let storedBytes = 0;
    for (const piece of pieces.iterate(dataset, int(scope))) {
      if (piece.part !== part || part >= set.pieces) fail('packed_pieces_corrupt');
      part++;
      const blob = payload.get(piece.payload_sha256);
      if (!blob || sha256(blob.payload) !== piece.payload_sha256) fail('packed_payload_corrupt');
      let raw;
      try { raw = inflateRawSync(blob.payload, { maxOutputLength: PACKED_MAX_RAW_PIECE_BYTES }); } catch { fail('packed_payload_corrupt'); }
      if (raw.length !== blob.raw_bytes || sha256(raw) !== blob.raw_sha256) fail('packed_payload_corrupt');
      rawBytes += raw.length;
      storedBytes += blob.payload.byteLength;
      for (const decoded of decodePiece(definition.codec, definition.columns, definition.scope, scope, raw, piece.row_count)) {
        const row = Object.fromEntries(definition.schema.map(({ name }) => [name, decoded[name]]));
        hash.update(`${rowText(row)}\n`);
        count++;
        onRow?.(row);
      }
    }
    if (part !== set.pieces) fail('packed_pieces_corrupt');
    if (count !== set.row_count || hash.digest('hex') !== set.rows_sha256 || rawBytes !== set.raw_bytes || storedBytes !== set.stored_bytes) {
      fail('packed_rows_corrupt');
    }
    return { rowCount: count, pieces: part, rawBytes, storedBytes };
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

  return Object.freeze({
    config,
    tablesExist,
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
    forEachRow: streamSet,
    status(dataset, scope) {
      if (!tablesExist()) return null;
      if (!PACKED_DATASETS[dataset]) fail('packed_dataset_invalid');
      const set = db.prepare('SELECT * FROM compact_packed_sets WHERE dataset = ? AND scope_start = ?').get(dataset, int(scope));
      return set ? { dataset, scopeStart: set.scope_start, version: set.version, codec: set.codec, rowCount: set.row_count, rowsSha256: set.rows_sha256,
        pieces: set.pieces, rawBytes: set.raw_bytes, storedBytes: set.stored_bytes } : null;
    },
  });
}
