// Independent lab import of already accepted reduced DEX results into a smaller lossless representation.
// Source stays read-only and untouched. Not a database backup, raw archive or production migration.
import { gzipSync } from 'node:zlib';
import { hash, json, fail } from './storage.js';
import { encodeEvidence } from './binary-evidence.js';
import { createDexHourStore, verifyDexSeal } from './dex-hour-store.js';
import { createStableSymbols, stableDexIdentifiers, STABLE_SYMBOL_CODEC } from './evidence-symbols.js';

export function importVerifiedDexResults(source, target) {
  if (!source.readOnly || target.readOnly || target.db.prepare('SELECT COUNT(*) n FROM arc_pipeline_units').get().n) {
    fail('dex_transfer_isolated_empty_target_required');
  }
  createDexHourStore(target);
  const stable = target.transaction(() => createStableSymbols(target.db));
  // Authenticate all accepted inputs before any target can be considered complete.
  const sealed = [];
  for (const row of source.db.prepare('SELECT unit_id FROM arc_pipeline_seals ORDER BY unit_id').iterate()) {
    const seal = source.getSeal(row.unit_id);
    if (seal.summary.format !== 'arc-dex-hour-v1') fail('dex_transfer_source_invalid');
    sealed.push(row.unit_id);
  }
  for (const row of source.db.prepare('SELECT result_sha FROM arc_pipeline_results').iterate()) source.getResult(row.result_sha);
  for (const table of ['arc_pipeline_sources','arc_pipeline_units','arc_pipeline_jobs','arc_pipeline_results','arc_pipeline_addresses']) {
    const columns = source.db.prepare(`PRAGMA table_info(${table})`).all().map(r => r.name);
    const put = target.db.prepare(`INSERT INTO ${table}(${columns.join(',')}) VALUES(${columns.map(() => '?').join(',')})`);
    target.transaction(() => {
      for (const row of source.db.prepare(`SELECT * FROM ${table}`).iterate()) put.run(...columns.map(k => row[k]));
    }, Math.max(65536, source.db.prepare(`SELECT SUM(pgsize) bytes FROM dbstat WHERE name=?`).get(table).bytes ?? 65536));
  }
  let verifiedRows = 0;
  for (const unitId of sealed) target.transaction(() => {
    const original = source.getSeal(unitId), stableMap = new Map(), local = new Set();
    const each = function* () { for (const piece of source.summaries(unitId)) yield* piece.rows.slice(1); };
    for (const row of each()) for (const symbol of stableDexIdentifiers(row)) {
      if (!stableMap.has(symbol)) stableMap.set(symbol, stable.intern(symbol));
      if (stableMap.size > 100000) fail('dex_symbols_budget');
    }
    const collect = value => {
      if (typeof value === 'string' && /^0x(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value)) {
        if (!stableMap.has(value)) local.add(value);
        if (local.size > 100000) fail('dex_symbols_budget');
      } else if (value && typeof value === 'object') for (const v of Object.values(value)) collect(v);
    };
    for (const row of each()) collect(row);
    const dictionary = [...local].sort(), refs = new Map(dictionary.map((v,i) => [v,i])), shards = [], symbols = [];
    const insert = target.db.prepare('INSERT OR IGNORE INTO arc_pipeline_dex_shards VALUES(?,?,?)');
    const save = (value, options) => {
      const raw = encodeEvidence(value, { ...options, compactIntegers: true }), sha = hash(raw);
      insert.run(sha, gzipSync(raw, { level: 9 }), raw.length); return sha;
    };
    for (let at = 0; at < dictionary.length; at += 512) symbols.push(save(dictionary.slice(at, at + 512)));
    let rows = [];
    const flush = () => {
      if (!rows.length) return;
      const keys = [...new Set(rows.flatMap(row => Object.keys(row)))];
      shards.push(save({ keys, values: rows.map(row => keys.map(k => Object.hasOwn(row,k) ? [row[k]] : [])) }, { dictionary: refs, stableSymbols: stableMap }));
      verifiedRows += rows.length; rows = [];
    };
    for (const row of each()) { rows.push(row); if (rows.length === 128) flush(); } flush();
    const seal = { ...original, summary: { ...original.summary, codec: STABLE_SYMBOL_CODEC, shards, symbols } };
    verifyDexSeal(target.db, seal, target.db.prepare('SELECT * FROM arc_pipeline_units WHERE unit_id=?').get(unitId));
    const raw = Buffer.from(json(seal));
    target.db.prepare('INSERT INTO arc_pipeline_seals VALUES(?,?,?,?)').run(unitId, hash(raw), gzipSync(raw, { level: 9 }), raw.length);
    target.getSeal(unitId);
  }, 4 * 1024 * 1024);
  return { importedUnits: sealed.length, verifiedPoolRows: verifiedRows, sourceUnchanged: true, rawEvidenceStored: false };
}
