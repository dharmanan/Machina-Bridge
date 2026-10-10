// Lossless local evidence, not a raw blockchain archive. No RPC, automatic recovery or separate writer.
import { createHash } from 'node:crypto';
import { deflateRawSync, inflateRawSync } from 'node:zlib';
import { statfsSync, statSync } from 'node:fs';
import { dirname } from 'node:path';

const MiB = 1024 * 1024;
const pendingArchives = new WeakMap(); // Shared by controllers on the same connection; never clear inside a transaction.
export const ARCHIVE_VERSION = 'arc-lossless-evidence-v1';
export const ARCHIVE_DATASETS = Object.freeze([
  'compact_hour_addresses', 'compact_dex_activity', 'compact_pool_hours', 'compact_pool_price_hours',
  'compact_pool_fee_hours', 'compact_pool_tvl_hours', 'compact_token_price_hours', 'compact_dex_volume_hours',
  'compact_dex_fee_hours', 'compact_projection_hours', 'compact_valuation_hours', 'compact_daily_address_hours',
  'compact_daily_address_stage', 'compact_daily_active_addresses', 'compact_intelligence_hours',
  'compact_token_discoveries', 'compact_meta',
]);
export const ARCHIVE_SQL = `
CREATE TABLE IF NOT EXISTS compact_evidence_archive (
  sequence INTEGER PRIMARY KEY, archive_id TEXT NOT NULL UNIQUE, dataset TEXT NOT NULL,
  scope_start INTEGER NOT NULL, evidence_key TEXT NOT NULL, definition_digest TEXT NOT NULL, canonical_sha256 TEXT NOT NULL,
  manifest_json TEXT NOT NULL CHECK(json_valid(manifest_json)), row_count INTEGER NOT NULL,
  raw_bytes INTEGER NOT NULL, stored_bytes INTEGER NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS compact_evidence_archive_scope ON compact_evidence_archive(dataset,scope_start,sequence DESC);
CREATE INDEX IF NOT EXISTS compact_evidence_archive_key ON compact_evidence_archive(dataset,scope_start,evidence_key,sequence DESC);
CREATE INDEX IF NOT EXISTS compact_activity_archive_hour ON compact_dex_activity(hour_start,kind,block_number,log_index);
CREATE INDEX IF NOT EXISTS compact_activity_archive_kind_hour ON compact_dex_activity(kind,hour_start,block_number,log_index);
CREATE TABLE IF NOT EXISTS compact_evidence_archive_parts (
  archive_id TEXT NOT NULL REFERENCES compact_evidence_archive(archive_id), part INTEGER NOT NULL,
  raw_bytes INTEGER NOT NULL, raw_sha256 TEXT NOT NULL, stored_sha256 TEXT NOT NULL, payload BLOB NOT NULL,
  PRIMARY KEY(archive_id,part)
) STRICT, WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS compact_evidence_archive_usage (
  id INTEGER PRIMARY KEY CHECK(id=1), stored_bytes INTEGER NOT NULL, day_start INTEGER NOT NULL, day_bytes INTEGER NOT NULL
) STRICT;
INSERT OR IGNORE INTO compact_evidence_archive_usage VALUES(1,0,0,0);
CREATE TRIGGER IF NOT EXISTS compact_archive_no_update BEFORE UPDATE ON compact_evidence_archive BEGIN SELECT RAISE(ABORT,'immutable_evidence_archive'); END;
CREATE TRIGGER IF NOT EXISTS compact_archive_no_delete BEFORE DELETE ON compact_evidence_archive BEGIN SELECT RAISE(ABORT,'immutable_evidence_archive'); END;
CREATE TRIGGER IF NOT EXISTS compact_archive_part_no_update BEFORE UPDATE ON compact_evidence_archive_parts BEGIN SELECT RAISE(ABORT,'immutable_evidence_archive'); END;
CREATE TRIGGER IF NOT EXISTS compact_archive_part_no_delete BEFORE DELETE ON compact_evidence_archive_parts BEGIN SELECT RAISE(ABORT,'immutable_evidence_archive'); END;
CREATE TRIGGER IF NOT EXISTS compact_archive_no_replace BEFORE INSERT ON compact_evidence_archive
WHEN EXISTS(SELECT 1 FROM compact_evidence_archive WHERE archive_id=NEW.archive_id OR sequence=NEW.sequence)
BEGIN SELECT RAISE(ABORT,'immutable_evidence_archive'); END;
CREATE TRIGGER IF NOT EXISTS compact_archive_part_no_replace BEFORE INSERT ON compact_evidence_archive_parts
WHEN EXISTS(SELECT 1 FROM compact_evidence_archive_parts WHERE archive_id=NEW.archive_id AND part=NEW.part)
BEGIN SELECT RAISE(ABORT,'immutable_evidence_archive'); END;`;

const error = code => Object.assign(new Error(code), { code });
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
function encode(value) {
  if (value === null) return ['null'];
  if (typeof value === 'bigint' || typeof value === 'number' && Number.isSafeInteger(value)) return ['integer', String(value)];
  if (typeof value === 'string') return ['text', value];
  if (ArrayBuffer.isView(value)) return ['blob', Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString('hex')];
  throw error('archive_value_type_invalid');
}
function decode([type, value]) {
  if (type === 'null') return null;
  if (type === 'integer' && /^-?\d+$/.test(value)) { const n = BigInt(value); return Number.isSafeInteger(Number(n)) ? Number(n) : n; }
  if (type === 'text' && typeof value === 'string') return value;
  if (type === 'blob' && typeof value === 'string' && /^(?:[0-9a-f]{2})*$/.test(value)) return Buffer.from(value, 'hex');
  throw error('archive_value_type_invalid');
}
const rowText = row => JSON.stringify(Object.keys(row).sort().map(key => [key, encode(row[key])]));
const rowsText = rows => `[${rows.map(rowText).sort().join(',')}]`;
const readSQL = (db, sql, ...args) => { const statement=db.prepare(sql);statement.setReadBigInts(true);return statement.all(...args); };
function exists(db) { return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='compact_evidence_archive'").get()); }

export function archiveConfig(env = process.env) {
  const flag = env.COMPACT_EVIDENCE_ARCHIVE_ENABLED ?? '';
  if (!['', 'true', 'false'].includes(flag)) throw error('invalid_evidence_archive_enabled');
  const number = (key, fallback, min, max) => {
    const text = env[key] ?? String(fallback), n = /^\d+$/.test(text) ? Number(text) : NaN;
    if (!Number.isSafeInteger(n) || n < min || n > max) throw error(`invalid_${key.toLowerCase()}`);
    return n;
  };
  return { enabled: flag === 'true', minFreeBytes: number('COMPACT_STORAGE_MIN_FREE_MIB',256,16,1048576)*MiB,
    maxDatabaseBytes: number('COMPACT_STORAGE_MAX_DATABASE_MIB',16384,64,1048576)*MiB,
    maxArchiveBytes: number('COMPACT_ARCHIVE_MAX_TOTAL_MIB',4096,1,1048576)*MiB,
    maxDailyBytes: number('COMPACT_ARCHIVE_MAX_DAILY_MIB',256,1,65536)*MiB,
    maxTransactionBytes: number('COMPACT_ARCHIVE_MAX_TRANSACTION_MIB',8,1,16)*MiB,
    maxTransactionRows: number('COMPACT_ARCHIVE_MAX_TRANSACTION_ROWS',32768,1,32768),
    maxTransactionSets: number('COMPACT_ARCHIVE_MAX_TRANSACTION_SETS',32,1,128),
    maxTransactionMs: number('COMPACT_ARCHIVE_MAX_TRANSACTION_MS',200,1,2000),
    maxPruneHours: number('COMPACT_ARCHIVE_PRUNE_HOURS',4,1,24) };
}
// Pure read-only capacity inspection. Unknown free space fails closed; in-memory tests inject capacity explicitly.
export function storagePreflight(db, config = archiveConfig(), { plannedBytes = 0, capacity } = {}) {
  let info;
  try {
    if (capacity) info = capacity();
    else {
      const path = db.prepare('PRAGMA database_list').all().find(r => r.name === 'main')?.file;
      if (!path) throw error('storage_capacity_unknown');
      const fs = statfsSync(dirname(path), { bigint: true });
      const size = name => { try { return statSync(name).size; } catch (e) { if (e.code === 'ENOENT') return 0; throw e; } };
      info = { freeBytes: Number(fs.bavail * fs.bsize), databaseBytes: size(path) + size(`${path}-wal`) };
    }
    if (![info.freeBytes,info.databaseBytes,plannedBytes].every(n => Number.isSafeInteger(n) && n >= 0)) throw error('storage_capacity_unknown');
    const reserve = plannedBytes * 4; // pages, indexes and WAL; conservative planning, not a physical disk guarantee.
    const reason = info.freeBytes - reserve < config.minFreeBytes ? 'storage_low_space'
      : info.databaseBytes + reserve > config.maxDatabaseBytes ? 'storage_database_budget' : null;
    return { ...info, plannedBytes, reserveBytes: reserve, ok: reason === null, reason };
  } catch { return { ok: false, reason: 'storage_capacity_unknown', plannedBytes }; }
}

function verifiedSet(db, record, { maxBytes = 8 * MiB } = {}) {
  if (!record || record.raw_bytes > maxBytes || record.row_count > 32768) throw error('archive_read_budget');
  const manifest = JSON.parse(record.manifest_json);
  const identity = { ...manifest }; delete identity.archiveId;
  if (manifest.version !== ARCHIVE_VERSION || manifest.archiveId !== record.archive_id || hash(JSON.stringify(identity)) !== record.archive_id
    || manifest.dataset !== record.dataset || manifest.scopeStart !== record.scope_start || manifest.rows !== record.row_count
    || manifest.canonicalSha256 !== record.canonical_sha256 || record.evidence_key !== (manifest.proof?.unitId??'')
    || hash(JSON.stringify(manifest.definitions)) !== record.definition_digest) throw error('archive_manifest_corrupt');
  const day = record.dataset.startsWith('compact_daily_');
  if (!Array.isArray(manifest.canonicalHours) || !manifest.canonicalHours.length || manifest.canonicalHours.length > (day ? 24 : 1)
    || hash(JSON.stringify(manifest.canonicalHours)) !== record.canonical_sha256) throw error('archive_canonical_conflict');
  for (const h of manifest.canonicalHours) {
    if (h.hour_start < record.scope_start || h.hour_start >= record.scope_start + (day ? 86400 : 1)
      || JSON.stringify(db.prepare('SELECT * FROM compact_hours WHERE hour_start=?').get(h.hour_start)) !== JSON.stringify(h)) throw error('archive_canonical_conflict');
  }
  const parts = db.prepare('SELECT * FROM compact_evidence_archive_parts WHERE archive_id=? ORDER BY part LIMIT 129').all(record.archive_id);
  if (parts.length !== manifest.parts || parts.length > 128) throw error('archive_parts_corrupt');
  let bytes = 0, stored = 0; const rawParts = [];
  for (const [i,p] of parts.entries()) {
    if (p.part !== i || p.raw_bytes > MiB || hash(p.payload) !== p.stored_sha256) throw error('archive_part_corrupt');
    const raw = inflateRawSync(p.payload, { maxOutputLength: Math.min(MiB,maxBytes-bytes) });
    bytes += raw.length; stored += p.payload.byteLength;
    if (raw.length !== p.raw_bytes || hash(raw) !== p.raw_sha256 || bytes > maxBytes) throw error('archive_part_corrupt');
    rawParts.push(raw);
  }
  const decoded=JSON.parse(Buffer.concat(rawParts).toString());
  if(!Array.isArray(decoded)||decoded.length!==record.row_count)throw error('archive_rows_corrupt');
  const rows=decoded.map(fields=>{
    if (!Array.isArray(fields) || new Set(fields.map(f=>f[0])).size !== fields.length || fields.some(f=>!Array.isArray(f) || typeof f[0]!=='string')) throw error('archive_part_corrupt');
    return Object.fromEntries(fields.map(([key,value])=>[key,decode(value)]));
  });
  if (bytes !== record.raw_bytes || stored !== record.stored_bytes || rows.length !== record.row_count || hash(rowsText(rows)) !== manifest.rowsSha256) throw error('archive_rows_corrupt');
  return { rows, manifest };
}

// Indexed exact scope only. Consumers must ALSO check their own proof/count/source compatibility before reuse.
export function archivedRows(db, dataset, scope, { predicate = () => true, evidenceKey, maxBytes = 8 * MiB } = {}) {
  if (!ARCHIVE_DATASETS.includes(dataset)) throw error('archive_dataset_invalid');
  if (!exists(db)) return [];
  const records = evidenceKey === undefined
    ? db.prepare('SELECT * FROM compact_evidence_archive WHERE dataset=? AND scope_start=? ORDER BY sequence DESC LIMIT 33').all(dataset,scope)
    : db.prepare('SELECT * FROM compact_evidence_archive WHERE dataset=? AND scope_start=? AND evidence_key=? ORDER BY sequence DESC LIMIT 33').all(dataset,scope,evidenceKey);
  if (records.length > 32) throw error('archive_revision_budget');
  const seen = new Set(), out = []; let bytes = 0;
  for (const record of records) {
    bytes += record.raw_bytes;
    if (bytes > maxBytes) throw error('archive_read_budget');
    const {rows,manifest} = verifiedSet(db,record,{maxBytes});
    if (!predicate(manifest)) continue;
    for (const row of rows) { const text=rowText(row); if (!seen.has(text)) {seen.add(text);out.push(row);} }
  }
  return out;
}

export function createEvidenceArchive(db, { config = archiveConfig(), capacity, log = console.warn, now = Date.now } = {}) {
  const created=pendingArchives.get(db)??new Set();pendingArchives.set(db,created);
  const freshState=()=>({rows:0,bytes:0,readBytes:0,sets:0,started:performance.now(),failures:[]});
  let state=freshState();
  if(!db.isTransaction)created.clear();
  const reset = () => { if(db.isTransaction)throw error('archive_begin_requires_closed_transaction');state=freshState();created.clear(); };
  const fail = e => { const code=e.code??'archive_failed'; if (!state.failures.includes(code)) { state.failures.push(code);log(`EVIDENCE_RETENTION_BLOCKED reason=${code}`); } return false; };
  function preserve(dataset,scope,rows,proof={}) {
    if (!config.enabled) return false;
    try {
      if (!db.isTransaction || !ARCHIVE_DATASETS.includes(dataset) || !Number.isSafeInteger(scope)) throw error('archive_transaction_required');
      if (rows.length > config.maxTransactionRows-state.rows) throw error('archive_workload_rows');
      const sorted=rows.map(rowText).sort(), full=`[${sorted.join(',')}]`;
      if (Buffer.byteLength(full)>config.maxTransactionBytes-state.bytes) throw error('archive_workload_bytes');
      const day=dataset.startsWith('compact_daily_');
      const canonicalHours=day ? db.prepare('SELECT * FROM compact_hours WHERE hour_start>=? AND hour_start<? ORDER BY hour_start LIMIT 24').all(scope,scope+86400)
        : db.prepare('SELECT * FROM compact_hours WHERE hour_start=?').all(scope);
      if (!canonicalHours.length) throw error('archive_hour_missing');
      const definitions=db.prepare("SELECT key,value FROM compact_meta WHERE key IN ('schema_version','token_metadata_version','tvl_version')").all();
      // Separate primary-key ranges: ORDER BY with an OR/GLOB can otherwise scan every permanent discovery unit.
      for(const prefix of ['family_version','projection_version','valuation_version']) definitions.push(...db.prepare(
        'SELECT key,value FROM compact_meta WHERE key>=? AND key<? ORDER BY key LIMIT 65').all(`${prefix}:`,`${prefix};`));
      definitions.sort((a,b)=>a.key<b.key?-1:a.key>b.key?1:0);
      if (definitions.length>64) throw error('archive_definition_budget');
      const provenance={
        familyStatus:db.prepare('SELECT hour_start,family,status,reason,metrics_sha256 FROM compact_family_hours WHERE hour_start>=? AND hour_start<? ORDER BY hour_start,family LIMIT 257').all(scope,scope+(day?86400:1)),
        projectionStatus:db.prepare('SELECT * FROM compact_projection_hours WHERE hour_start>=? AND hour_start<? ORDER BY hour_start,projection LIMIT 257').all(scope,scope+(day?86400:1)),
        valuationStatus:db.prepare('SELECT * FROM compact_valuation_hours WHERE hour_start>=? AND hour_start<? ORDER BY hour_start,valuation LIMIT 257').all(scope,scope+(day?86400:1)),
      };
      if(Object.values(provenance).some(list=>list.length>256))throw error('archive_provenance_budget');
      // Split encoded bytes, never truncate a value. Even a 2 MiB discovery unit may span bounded chunks.
      const raw=Buffer.from(full),parts=[];
      for(let offset=0;offset<raw.length;offset+=512*1024)parts.push(raw.subarray(offset,offset+512*1024));
      if(parts.length>128)throw error('archive_parts_budget');
      const manifest={version:ARCHIVE_VERSION,dataset,scopeStart:scope,canonicalHours,canonicalSha256:hash(JSON.stringify(canonicalHours)),definitions,
        rows:rows.length,rowsSha256:hash(full),parts:parts.length,proof,provenance};
      const id=hash(JSON.stringify(manifest));manifest.archiveId=id;
      const old=db.prepare('SELECT * FROM compact_evidence_archive WHERE archive_id=?').get(id);
      if(old){verifiedSet(db,old);return !created.has(id);}
      if(state.sets>=config.maxTransactionSets||performance.now()-state.started>=config.maxTransactionMs)throw error('archive_workload_time_or_sets');
      const payloads=parts.map(p=>deflateRawSync(p,{level:1}));
      const storedBytes=payloads.reduce((n,p)=>n+p.length,0), rawBytes=parts.reduce((n,p)=>n+p.length,0), charge=storedBytes+Buffer.byteLength(JSON.stringify(manifest))+parts.length*256;
      const usage=db.prepare('SELECT * FROM compact_evidence_archive_usage WHERE id=1').get();
      const dayStart=Math.floor(now()/86400000)*86400, dayBytes=usage.day_start===dayStart?usage.day_bytes:0;
      if(usage.stored_bytes+charge>config.maxArchiveBytes||dayBytes+charge>config.maxDailyBytes)throw error('archive_storage_budget');
      const preflight=storagePreflight(db,config,{plannedBytes:charge,capacity});if(!preflight.ok)throw error(preflight.reason);
      db.exec('SAVEPOINT evidence_archive');
      try{
        db.prepare('INSERT INTO compact_evidence_archive(archive_id,dataset,scope_start,evidence_key,definition_digest,canonical_sha256,manifest_json,row_count,raw_bytes,stored_bytes) VALUES(?,?,?,?,?,?,?,?,?,?)')
          .run(id,dataset,scope,proof.unitId??'',hash(JSON.stringify(definitions)),manifest.canonicalSha256,JSON.stringify(manifest),rows.length,rawBytes,storedBytes);
        const insert=db.prepare('INSERT INTO compact_evidence_archive_parts VALUES(?,?,?,?,?,?)');
        parts.forEach((p,i)=>insert.run(id,i,p.length,hash(p),hash(payloads[i]),payloads[i]));
        db.prepare('UPDATE compact_evidence_archive_usage SET stored_bytes=stored_bytes+?,day_start=?,day_bytes=? WHERE id=1').run(charge,dayStart,dayBytes+charge);
        verifiedSet(db,db.prepare('SELECT * FROM compact_evidence_archive WHERE archive_id=?').get(id));
        db.exec('RELEASE evidence_archive');
      }catch(e){db.exec('ROLLBACK TO evidence_archive; RELEASE evidence_archive');throw e;}
      created.add(id);state.rows+=rows.length;state.bytes+=rawBytes;state.sets++;
      return false; // Only an independently checked archive from an EARLIER committed transaction permits deletion.
    }catch(e){return fail(e);}
  }
  function prune(dataset,where,args=[],scopeColumn='hour_start') {
    if(!config.enabled)return;
    const capacityCheck=storagePreflight(db,config,{capacity});
    if(!capacityCheck.ok){fail(error(capacityCheck.reason));return;}
    if(!ARCHIVE_DATASETS.includes(dataset)||!['hour_start','day_start'].includes(scopeColumn))throw error('archive_dataset_invalid');
    const source=dataset==='compact_dex_activity'?`${dataset} INDEXED BY compact_activity_archive_kind_hour`:dataset;
    const scopes=db.prepare(`SELECT DISTINCT ${scopeColumn} AS scope FROM ${source} WHERE ${where} ORDER BY ${scopeColumn} LIMIT ?`).all(...args,config.maxPruneHours);
    for(const{scope}of scopes){
      if(performance.now()-state.started>=config.maxTransactionMs){fail(error('archive_workload_time_or_sets'));break;}
      const rows=readSQL(db,`SELECT * FROM ${dataset} WHERE ${scopeColumn}=? AND (${where}) LIMIT ?`,scope,...args,config.maxTransactionRows+1);
      let covered=false;
      try {
        const records=db.prepare('SELECT * FROM compact_evidence_archive WHERE dataset=? AND scope_start=? ORDER BY sequence DESC LIMIT 33').all(dataset,scope);
        if(records.length>32)throw error('archive_revision_budget');
        const saved=new Set(),identities=new Map();let bytes=0;
        const keyFields=db.prepare(`PRAGMA table_info(${dataset})`).all().filter(c=>c.pk).sort((a,b)=>a.pk-b.pk).map(c=>c.name);
        const identity=row=>rowText(Object.fromEntries(keyFields.map(k=>[k,row[k]])));
        for(const record of records){
          if(created.has(record.archive_id))continue;
          bytes+=record.raw_bytes;state.readBytes+=record.raw_bytes;
          if(bytes>config.maxTransactionBytes||state.readBytes>config.maxTransactionBytes)throw error('archive_read_budget');
          for(const row of verifiedSet(db,record).rows){saved.add(rowText(row));identities.set(identity(row),rowText(row));}
        }
        if(rows.some(row=>identities.has(identity(row))&&identities.get(identity(row))!==rowText(row)))throw error('archive_evidence_conflict');
        covered=rows.length<=config.maxTransactionRows&&rows.every(row=>saved.has(rowText(row)));
      }catch(e){fail(e);continue;}
      if(covered){
        // Exact current row set matched the committed archive; deletion shares this writer transaction.
        db.prepare(`DELETE FROM ${dataset} WHERE ${scopeColumn}=? AND (${where})`).run(scope,...args);
      }else preserve(dataset,scope,rows,{scope:'exact_selected_hot_records'});
    }
  }
  return { config,begin:reset,preserve,prune,readRows:(table,where,args=[])=>readSQL(db,`SELECT * FROM ${table} WHERE ${where} LIMIT ?`,...args,config.maxTransactionRows+1),
    report:()=>({...state,enabled:config.enabled}), preflight:(plannedBytes=0)=>storagePreflight(db,config,{plannedBytes,capacity}) };
}
