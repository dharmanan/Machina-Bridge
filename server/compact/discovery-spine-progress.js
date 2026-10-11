// Incremental recovery inputs, not canonical hours or a completed discovery unit.
// Full RPC calldata is discarded; the exact validated compact spine survives restart.
import { createHash } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';
import { spineBlockOf } from './spine.js';
import { evidenceJson } from './discovery-evidence.js';

export const SPINE_PROGRESS_VERSION = 'compact-recovery-spine-v1';
const MiB = 1024 * 1024;
// Disk evidence may span many 64 MiB RPC executions. This is a separate read bound;
// writes also obey the existing shared, configured storage quota.
const MAX_HOUR_BYTES = 512 * MiB;
const digest = value => createHash('sha256').update(evidenceJson(value)).digest('hex');
const fail = code => { throw Object.assign(new Error(code), { code }); };
const prefix = (h, unit) => `discovery_spine_block:${h.hour_start}:${unit.id}:`;
const blockKey = (h, unit, n) => prefix(h, unit) + String(n).padStart(16, '0');
const cursorKey = (h, unit) => `discovery_spine_cursor:${h.hour_start}:${unit.id}`;
const identity = (h, unit) => ({ version: SPINE_PROGRESS_VERSION, unitId: unit.id,
  canonical: h.network_sha256, network: digest(h.network_json), definition: unit.definition,
  hourStart: h.hour_start, firstBlock: h.first_block, lastBlock: h.last_block,
  parentHash: h.parent_hash, firstHash: h.first_hash, lastHash: h.last_hash });
function read(db, key) {
  const row = db.prepare('SELECT CASE WHEN length(CAST(value AS BLOB))<=2097152 THEN value END AS value FROM compact_meta WHERE key=?').get(key);
  if (!row) return null;
  if (row.value === null) fail('recovery_spine_size_limit');
  try { return JSON.parse(row.value); } catch { fail('recovery_spine_corrupt'); }
}
function checked(value, binding) {
  if (!value) fail('recovery_spine_missing');
  const { checksum, ...body } = value;
  if (checksum !== digest(body) || digest(body.identity) !== digest(binding)) fail('recovery_spine_corrupt');
  return body;
}
function blockOf(saved, h) {
  const b = saved.block;
  if (!b || !/^\d+$/.test(b.gasUsed) || !Array.isArray(b.txHashes) || !Array.isArray(b.txFrom) || !Array.isArray(b.txTo)
    || b.txHashes.length !== b.txFrom.length || b.txHashes.length !== b.txTo.length) fail('recovery_spine_corrupt');
  const hex = n => `0x${n.toString(16)}`;
  const block = spineBlockOf({ number: hex(b.number), hash: b.hash, parentHash: b.parentHash,
    timestamp: hex(b.timestamp), gasUsed: hex(BigInt(b.gasUsed)),
    transactions: b.txHashes.map((hash, i) => ({ hash, from: b.txFrom[i], to: b.txTo[i] })) }, b.number);
  if (block.number < h.first_block || block.number > h.last_block || block.timestamp < h.hour_start
    || block.timestamp >= h.hour_start + 3600) fail('recovery_spine_corrupt');
  if (block.number === h.first_block && block.hash !== h.first_hash
    || block.number === h.last_block && block.hash !== h.last_hash) fail('recovery_spine_conflict');
  return block;
}
// The cursor is replaceable coordination state; the block evidence cannot be updated, deleted or replaced.
export const SPINE_PROGRESS_SQL = `
CREATE TRIGGER IF NOT EXISTS compact_spine_no_update BEFORE UPDATE ON compact_meta
WHEN OLD.key GLOB 'discovery_spine_block:*' BEGIN SELECT RAISE(ABORT,'immutable_recovery_spine'); END;
CREATE TRIGGER IF NOT EXISTS compact_spine_no_delete BEFORE DELETE ON compact_meta
WHEN OLD.key GLOB 'discovery_spine_block:*' BEGIN SELECT RAISE(ABORT,'immutable_recovery_spine'); END;
CREATE TRIGGER IF NOT EXISTS compact_spine_no_replace BEFORE INSERT ON compact_meta
WHEN NEW.key GLOB 'discovery_spine_block:*' AND EXISTS(SELECT 1 FROM compact_meta WHERE key=NEW.key)
BEGIN SELECT RAISE(ABORT,'immutable_recovery_spine'); END;`;

export function spineProgress(db, h, unit, { verify = false, onBlock = () => {} } = {}) {
  const binding = identity(h, unit), value = read(db, cursorKey(h, unit));
  if (!value) {
    if (db.prepare('SELECT 1 FROM compact_meta WHERE key GLOB ? LIMIT 1').get(prefix(h, unit) + '*')) fail('recovery_spine_cursor_missing');
    return { nextBlock: h.first_block, lastHash: h.parent_hash, lastTimestamp: h.hour_start,
      lastDigest: null, blocks: 0, bytes: 0, gasUsed: '0', transactions: 0, deployments: 0 };
  }
  const cursor = checked(value, binding);
  if (![cursor.nextBlock, cursor.blocks, cursor.bytes].every(Number.isSafeInteger) || cursor.blocks < 1
    || cursor.blocks > 15000 || cursor.bytes < 1 || cursor.bytes > MAX_HOUR_BYTES
    || cursor.nextBlock !== h.first_block + cursor.blocks || cursor.nextBlock > h.last_block + 1) fail('recovery_spine_corrupt');
  const tail = checked(read(db, blockKey(h, unit, cursor.nextBlock - 1)), binding);
  if (digest(tail) !== cursor.lastDigest || tail.block.hash !== cursor.lastHash) fail('recovery_spine_corrupt');
  if (!verify) return cursor;
  let number = h.first_block, lastHash = h.parent_hash, lastTimestamp = h.hour_start, lastDigest = null, bytes = 0;
  let transactions = 0, deployments = 0, gasUsed = 0n;
  for (const row of db.prepare('SELECT key,CASE WHEN length(CAST(value AS BLOB))<=2097152 THEN value END AS value FROM compact_meta WHERE key GLOB ? ORDER BY key LIMIT 15001').iterate(prefix(h, unit) + '*')) {
    if (row.value === null) fail('recovery_spine_size_limit');
    bytes += Buffer.byteLength(row.value);
    if (bytes > MAX_HOUR_BYTES || number > h.last_block) fail('recovery_spine_size_limit');
    let value;
    try { value = JSON.parse(row.value); } catch { fail('recovery_spine_corrupt'); }
    const body = checked(value, binding), block = blockOf(body, h);
    if (row.key !== blockKey(h, unit, number) || block.number !== number || block.parentHash !== lastHash
      || block.timestamp < lastTimestamp || body.previousDigest !== lastDigest
      || number === h.first_block && block.hash !== h.first_hash) fail('recovery_spine_conflict');
    lastHash = block.hash; lastTimestamp = block.timestamp; lastDigest = digest(body); number++;
    gasUsed += block.gasUsed; transactions += block.txHashes.length;
    deployments += block.txTo.filter(to => to === null).length;
    onBlock(block);
  }
  if (cursor.nextBlock !== number || cursor.lastHash !== lastHash || cursor.lastTimestamp !== lastTimestamp
    || cursor.lastDigest !== lastDigest || cursor.bytes !== bytes || cursor.transactions !== transactions
    || cursor.deployments !== deployments || cursor.gasUsed !== gasUsed.toString()) fail('recovery_spine_conflict');
  return cursor;
}

// Caller owns a short BEGIN IMMEDIATE and canonical/storage checks. One accepted HTTP batch is atomic.
export function appendSpine(db, h, unit, blocks, { maxTotalBytes, maxDailyBytes, archiveBytes = 0, archiveDayBytes = 0, beforeCommit = () => {} }) {
  if (!Array.isArray(blocks) || !blocks.length || blocks.length > 32) fail('recovery_spine_size_limit');
  const binding = identity(h, unit), old = spineProgress(db, h, unit), cursor = { ...old };
  const values = [];
  for (const block of blocks) {
    if (block.number !== cursor.nextBlock || block.parentHash !== cursor.lastHash || block.timestamp < cursor.lastTimestamp
      || block.number === h.first_block && block.hash !== h.first_hash
      || block.number === h.last_block && block.hash !== h.last_hash) fail('recovery_spine_conflict');
    const body = { identity: binding, previousDigest: cursor.lastDigest,
      block: { ...block, gasUsed: block.gasUsed.toString() } };
    const checksum = digest(body), text = evidenceJson({ ...body, checksum }), size = Buffer.byteLength(text);
    if (size > 2 * MiB) fail('recovery_spine_size_limit');
    values.push([blockKey(h, unit, block.number), text]);
    cursor.nextBlock++; cursor.blocks++; cursor.bytes += size;
    cursor.lastHash = block.hash; cursor.lastTimestamp = block.timestamp; cursor.lastDigest = checksum;
    cursor.transactions += block.txHashes.length;
    cursor.deployments += block.txTo.filter(to => to === null).length;
    cursor.gasUsed = (BigInt(cursor.gasUsed) + block.gasUsed).toString();
  }
  const addedBytes = cursor.bytes - old.bytes;
  if (addedBytes > 8 * MiB || cursor.bytes > MAX_HOUR_BYTES) fail('recovery_spine_size_limit');
  const usage = spineStorageUsage(db);
  if (usage.bytes < old.bytes) fail('recovery_spine_usage_corrupt');
  const total = usage.bytes + addedBytes;
  const dayStart = Math.floor(Date.now() / 86400000) * 86400;
  const dayBytes = (usage?.dayStart === dayStart ? usage.dayBytes : 0) + addedBytes;
  if (!Number.isSafeInteger(maxTotalBytes) || total + archiveBytes > maxTotalBytes) fail('recovery_spine_storage_budget');
  if (!Number.isSafeInteger(dayBytes) || !Number.isSafeInteger(maxDailyBytes) || dayBytes + archiveDayBytes > maxDailyBytes) fail('recovery_spine_storage_budget');
  db.exec(SPINE_PROGRESS_SQL);
  const insert = db.prepare('INSERT INTO compact_meta(key,value) VALUES(?,?)');
  for (const args of values) insert.run(...args);
  const upsert = db.prepare('INSERT INTO compact_meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value');
  const state = { ...cursor, identity: binding };
  upsert.run(cursorKey(h, unit), evidenceJson({ ...state, checksum: digest(state) }));
  upsert.run('discovery_spine_usage', evidenceJson({ version: SPINE_PROGRESS_VERSION, bytes: total, dayStart, dayBytes }));
  beforeCommit();
  return cursor;
}
export function spineStorageUsage(db) {
  const usage = read(db, 'discovery_spine_usage');
  if (!usage) {
    if (db.prepare("SELECT 1 FROM compact_meta WHERE key GLOB 'discovery_spine_block:*' LIMIT 1").get()) fail('recovery_spine_usage_corrupt');
    return { bytes: 0, dayBytes: 0, dayStart: 0 };
  }
  if (usage.version !== SPINE_PROGRESS_VERSION || ![usage.bytes, usage.dayBytes, usage.dayStart].every(Number.isSafeInteger)
    || usage.bytes < 0 || usage.dayBytes < 0 || usage.dayBytes > usage.bytes || usage.dayStart < 0) fail('recovery_spine_usage_corrupt');
  return usage;
}

export function cachedSpineBlock(db, h, unit, number) {
  const saved = read(db, blockKey(h, unit, number));
  if (!saved) return null;
  const block = blockOf(checked(saved, identity(h, unit)), h);
  if (block.number !== number) fail('recovery_spine_conflict');
  return block;
}
export function spineNetwork(db, h, unit, cursor) {
  if (cursor.nextBlock !== h.last_block + 1 || cursor.lastHash !== h.last_hash) fail('recovery_spine_incomplete');
  const scope = prefix(h, unit) + '*';
  // Bound to one <=512 MiB disk ledger, streamed/checked first. SQLite does the
  // distinct union with a disk-backed temp store; no hour-wide JS address Set.
  const count = field => db.prepare(`SELECT COUNT(DISTINCT j.value) AS n FROM compact_meta m,
    json_each(m.value,'$.block.${field}') j WHERE m.key GLOB ? AND j.value IS NOT NULL`).get(scope).n;
  const active = db.prepare(`SELECT COUNT(*) AS n FROM (SELECT j.value FROM compact_meta m,
    json_each(m.value,'$.block.txFrom') j WHERE m.key GLOB ? UNION SELECT j.value FROM compact_meta m,
    json_each(m.value,'$.block.txTo') j WHERE m.key GLOB ? AND j.value IS NOT NULL)`).get(scope, scope).n;
  return { status: 'available', blockCount: cursor.blocks, transactionCount: cursor.transactions,
    uniqueSenders: count('txFrom'), uniqueRecipients: count('txTo'), uniqueActiveAddresses: active,
    gasUsedRaw: cursor.gasUsed, averageTransactionsPerBlock: cursor.transactions / cursor.blocks,
    transactionsPerSecond: cursor.transactions / 3600, internal: { deploymentAttempts: cursor.deployments } };
}

// Reduced, versioned progress in the SAME compact database. Old full-spine rows remain immutable/readable.
// One current exact reducer state, plus small immutable range commitments: no raw bodies or raw logs.
export const SLICE_PROGRESS_VERSION = 'compact-discovery-slices-v1';
// Base64 + envelope must still fit the existing 2 MiB compact_meta read bound.
const MAX_SLICE_PACKED_BYTES = 3 * MiB / 2 - 4096;
const slicePrefix = (h, unit) => `discovery_slice_piece:${h.hour_start}:${unit.id}:`;
const sliceCursorKey = (h, unit) => `discovery_slice_cursor:${h.hour_start}:${unit.id}`;
const sliceIdentity = (h, unit) => ({ ...identity(h, unit), version: SLICE_PROGRESS_VERSION });
const sliceRows = (db, h, unit) => db.prepare('SELECT key,CASE WHEN length(CAST(value AS BLOB))<=65536 THEN value END AS value FROM compact_meta WHERE key>=? AND key<? ORDER BY key LIMIT 15001')
  .iterate(slicePrefix(h, unit), slicePrefix(h, unit) + '~');
const packSlice = value => {
  const raw = Buffer.from(evidenceJson(value)); if (raw.length > 8 * MiB) fail('recovery_slice_size_limit');
  const packed = gzipSync(raw, { level: 6 });
  if (packed.length > MAX_SLICE_PACKED_BYTES) fail('recovery_slice_size_limit');
  return evidenceJson({ version: SLICE_PROGRESS_VERSION, bytes: raw.length, sha: digest(value), packed: packed.toString('base64') });
};
const unpackSlice = text => {
  let wire, raw, value;
  try { wire = JSON.parse(text); if (wire.version !== SLICE_PROGRESS_VERSION || !Number.isInteger(wire.bytes) || wire.bytes < 1 || wire.bytes > 8 * MiB
    || typeof wire.packed !== 'string' || wire.packed.length > 2 * MiB) fail('recovery_slice_corrupt');
    const packed = Buffer.from(wire.packed, 'base64'); if (packed.length > MAX_SLICE_PACKED_BYTES || packed.toString('base64') !== wire.packed) fail('recovery_slice_corrupt');
    raw = gunzipSync(packed, { maxOutputLength: 8 * MiB }); value = JSON.parse(raw);
  } catch { fail('recovery_slice_corrupt'); }
  if (raw.length !== wire.bytes || digest(value) !== wire.sha) fail('recovery_slice_corrupt'); return value;
};
export function recoverySliceProgress(db, h, unit) {
  const binding = sliceIdentity(h, unit), cursor = read(db, sliceCursorKey(h, unit));
  if (!cursor) {
    if (sliceRows(db, h, unit).next().value) fail('recovery_slice_cursor_missing');
    return { nextBlock: h.first_block, blocks: 0, lastHash: h.parent_hash, lastTimestamp: h.hour_start, lastDigest: null, state: null };
  }
  const value = unpackSlice(evidenceJson(cursor));
  if (digest(value.identity) !== digest(binding)) fail('recovery_slice_binding_conflict');
  let next = h.first_block, previous = null, lastHash = h.parent_hash, lastTimestamp = h.hour_start;
  for (const row of sliceRows(db, h, unit)) {
    if (row.value === null) fail('recovery_slice_size_limit');
    let piece;
    try { piece=checked(JSON.parse(row.value),binding); } catch { fail('recovery_slice_corrupt'); }
    if (piece.first !== next || !Number.isSafeInteger(piece.last) || piece.last < next || piece.last > h.last_block
      || piece.last - piece.first + 1 > 32 || piece.previousDigest !== previous
      || !/^0x[0-9a-f]{64}$/.test(piece.lastHash) || !/^[0-9a-f]{64}$/.test(piece.inputSha256)
      || !/^[0-9a-f]{64}$/.test(piece.stateSha) || !Number.isSafeInteger(piece.lastTimestamp)
      || piece.lastTimestamp < lastTimestamp || piece.lastTimestamp >= h.hour_start + 3600
      || row.key !== slicePrefix(h, unit) + String(next).padStart(16, '0')) fail('recovery_slice_corrupt');
    next = piece.last + 1; previous = digest(piece); lastHash = piece.lastHash; lastTimestamp = piece.lastTimestamp;
    if (next === value.nextBlock && piece.stateSha !== digest(value.state)) fail('recovery_slice_corrupt');
  }
  if (value.nextBlock !== next || value.blocks !== next - h.first_block || value.blocks < 1 || value.lastDigest !== previous
    || value.lastHash !== lastHash || value.lastTimestamp !== lastTimestamp || next === h.last_block + 1 && lastHash !== h.last_hash) fail('recovery_slice_corrupt');
  return value;
}
export function recoverySliceUsage(db) {
  const usage = read(db, 'discovery_slice_usage');
  if (!usage) {
    if (db.prepare("SELECT 1 FROM compact_meta WHERE key>='discovery_slice_cursor:' AND key<'discovery_slice_cursor;' LIMIT 1").get()) fail('recovery_slice_usage_corrupt');
    return { bytes: 0, dayStart: 0, dayBytes: 0 };
  }
  if (usage.version !== SLICE_PROGRESS_VERSION || ![usage.bytes, usage.dayStart, usage.dayBytes].every(n => Number.isSafeInteger(n) && n >= 0)
    || usage.dayBytes > usage.bytes) fail('recovery_slice_usage_corrupt'); return usage;
}
// Caller owns the canonical guard and BEGIN IMMEDIATE. Cursor, checksum chain and accounting commit together.
export function appendRecoverySlice(db, h, unit, { first, last, lastHash, lastTimestamp, inputSha256, state },
  { maxTotalBytes, maxDailyBytes, archiveBytes = 0, archiveDayBytes = 0, beforeCommit = () => {} }) {
  const old = recoverySliceProgress(db, h, unit), binding = sliceIdentity(h, unit);
  if (first !== old.nextBlock || !Number.isSafeInteger(last) || last < first || last > h.last_block || last - first + 1 > 32
    || !/^0x[0-9a-f]{64}$/.test(lastHash) || !/^[0-9a-f]{64}$/.test(inputSha256)
    || !Number.isSafeInteger(lastTimestamp) || lastTimestamp < old.lastTimestamp || lastTimestamp >= h.hour_start + 3600
    || last === h.last_block && lastHash !== h.last_hash) fail('recovery_slice_conflict');
  const piece = { identity: binding, first, last, lastHash, lastTimestamp, inputSha256, previousDigest: old.lastDigest, stateSha: digest(state) };
  const checksum = digest(piece), pieceText = evidenceJson({ ...piece, checksum });
  const cursor = { identity: binding, nextBlock: last + 1, blocks: last - h.first_block + 1, lastHash, lastTimestamp, lastDigest: checksum, state };
  const cursorText = packSlice(cursor), prior = db.prepare('SELECT length(CAST(value AS BLOB)) bytes FROM compact_meta WHERE key=?').get(sliceCursorKey(h, unit))?.bytes ?? 0;
  const addedBytes = Buffer.byteLength(cursorText) - prior + Buffer.byteLength(pieceText), usage = recoverySliceUsage(db);
  const bytes = usage.bytes + addedBytes, dayStart = Math.floor(Date.now() / 86400000) * 86400;
  // Shared daily quota counts net retained bytes, matching the existing archive/spine accounting.
  const dayBytes = (usage.dayStart === dayStart ? usage.dayBytes : 0) + Math.max(0, addedBytes);
  const legacy = spineStorageUsage(db);
  if (!Number.isSafeInteger(bytes) || bytes < 0 || !Number.isSafeInteger(maxTotalBytes) || bytes + legacy.bytes + archiveBytes > maxTotalBytes
    || !Number.isSafeInteger(maxDailyBytes) || dayBytes + (legacy.dayStart === dayStart ? legacy.dayBytes : 0) + archiveDayBytes > maxDailyBytes) fail('recovery_slice_storage_budget');
  db.exec(`CREATE TRIGGER IF NOT EXISTS compact_slice_no_update BEFORE UPDATE ON compact_meta
    WHEN OLD.key GLOB 'discovery_slice_piece:*' BEGIN SELECT RAISE(ABORT,'immutable_recovery_slice'); END;
    CREATE TRIGGER IF NOT EXISTS compact_slice_no_delete BEFORE DELETE ON compact_meta
    WHEN OLD.key GLOB 'discovery_slice_piece:*' BEGIN SELECT RAISE(ABORT,'immutable_recovery_slice'); END;
    CREATE TRIGGER IF NOT EXISTS compact_slice_no_replace BEFORE INSERT ON compact_meta
    WHEN NEW.key GLOB 'discovery_slice_piece:*' AND EXISTS(SELECT 1 FROM compact_meta WHERE key=NEW.key)
    BEGIN SELECT RAISE(ABORT,'immutable_recovery_slice'); END;`);
  db.prepare('INSERT INTO compact_meta VALUES(?,?)').run(slicePrefix(h, unit) + String(first).padStart(16, '0'), pieceText);
  const upsert = db.prepare('INSERT INTO compact_meta VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value');
  upsert.run(sliceCursorKey(h, unit), cursorText);
  upsert.run('discovery_slice_usage', evidenceJson({ version: SLICE_PROGRESS_VERSION, bytes, dayStart, dayBytes }));
  recoverySliceProgress(db, h, unit); beforeCommit(); return cursor;
}
