// Lossless stable identifiers shared by independent accepted DEX results. No RPC or production imports.
import { hash, fail } from './storage.js';
const HEX = /^0x(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
export const STABLE_SYMBOL_CODEC = 'arc-stable-symbols-v1';
export function createStableSymbols(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS arc_pipeline_stable_symbols(id INTEGER PRIMARY KEY,value BLOB NOT NULL UNIQUE,
    sha BLOB NOT NULL CHECK(length(sha)=32),CHECK(length(value) IN(20,32))) STRICT;
    CREATE TRIGGER IF NOT EXISTS arc_pipeline_stable_symbol_immutable BEFORE UPDATE ON arc_pipeline_stable_symbols
    BEGIN SELECT RAISE(ABORT,'stable_symbol_immutable'); END;
    CREATE TRIGGER IF NOT EXISTS arc_pipeline_stable_symbol_no_delete BEFORE DELETE ON arc_pipeline_stable_symbols
    BEGIN SELECT RAISE(ABORT,'stable_symbol_immutable'); END;`);
  const insert = db.prepare('INSERT OR IGNORE INTO arc_pipeline_stable_symbols(value,sha) VALUES(?,?)');
  const lookup = db.prepare('SELECT id,sha FROM arc_pipeline_stable_symbols WHERE value=?');
  return { intern(value) {
    if (!HEX.test(value ?? '')) fail('stable_symbol_invalid');
    const raw = Buffer.from(value.slice(2), 'hex'), sha = Buffer.from(hash(raw), 'hex');
    insert.run(raw, sha); const row = lookup.get(raw);
    if (!Buffer.from(row.sha).equals(sha)) fail('stable_symbol_corrupt'); return row.id;
  } };
}
export function stableSymbolReader(db) {
  const get = db.prepare('SELECT value,sha FROM arc_pipeline_stable_symbols WHERE id=?');
  return id => {
    const row = get.get(id);
    if (!row || ![20,32].includes(row.value.length) || hash(row.value) !== Buffer.from(row.sha).toString('hex')) fail('stable_symbol_corrupt');
    return '0x' + Buffer.from(row.value).toString('hex');
  };
}
// Only names that remain stable between hours. Transaction and block hashes stay in each checked hour.
export function stableDexIdentifiers(row) {
  const values = [row.pool];
  for (const p of [row.observedSwap, row.observedLiquidity, row.latestPoolState]) if (p) {
    values.push(p.emitter); if (/^[0-9a-f]{64}$/.test(p.sourceKey ?? '')) values.push('0x' + p.sourceKey);
  }
  const init = row.initializedPool;
  if (init) for (const k of ['poolId','token0','token1','hooks','emitter']) if (HEX.test(init[k] ?? '')) values.push(init[k]);
  return values.filter(value => HEX.test(value ?? ''));
}
