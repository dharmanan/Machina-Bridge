// Shared evidence identity for live ingestion and recovery. Functions are excluded from registry serialization.
import { createHash } from 'node:crypto';
import { INTELLIGENCE_VERSION, intelligenceRegistry, registryDigest } from './intelligence-registry.js';
import { COMPACT_DEFINITION_VERSION, FAMILY_VERSIONS } from './sources.js';
import { PROJECTION_VERSIONS } from './projections.js';
export const evidenceJson = value => JSON.stringify(value, (_key, item) => typeof item === 'bigint' ? item.toString(10) : item);
export const evidenceHash = value => createHash('sha256').update(evidenceJson(value)).digest('hex');
export const discoveryUnitKey = (hour, id) => `discovery_unit:${hour}:${id}`;
export const discoveryRange = h => ({ hourStart: h.hour_start, firstBlock: h.first_block, lastBlock: h.last_block, parentHash: h.parent_hash, lastHash: h.last_hash });
export function discoveryUnitDefinitions(h, registry) {
  const base = { version: INTELLIGENCE_VERSION, canonical: h.network_sha256, networkPayload: evidenceHash(JSON.parse(h.network_json)) };
  const units = [
    { kind: 'creations', definition: { hour: COMPACT_DEFINITION_VERSION, basis: 'all_top_level_transaction_bodies' } },
    ...['uniswap_v3', 'uniswap_v4'].map(protocol => ({ kind: protocol, definition: { family: FAMILY_VERSIONS[protocol === 'uniswap_v3' ? 'uniswapV3' : 'uniswapV4'],
      projection: PROJECTION_VERSIONS[`${protocol}_pools`], assets: registry.assets.map(a => a.address).sort() } })),
    ...registry.launches.map(entry => ({ kind: 'launch', entry, definition: entry })),
    ...registry.protocols.map(entry => ({ kind: 'protocol', entry, definition: entry })),
    ...(registry.exchanges.length ? [{ kind: 'exchange', definition: { assets: registry.assets, exchanges: registry.exchanges,
      usdc: FAMILY_VERSIONS.usdc, assetsVersion: FAMILY_VERSIONS.assets } }] : [])
  ];
  return units.map(u => ({ ...u, id: evidenceHash({ ...base, kind: u.kind, definition: u.definition }) }));
}
// Append-only. A conflicting completed unit is never replaced. Caller owns the existing hour transaction.
export function persistDiscoveryUnit(db, h, unit, evidence, status = 'available', reason = null) {
  const saved = { id: unit.id, kind: unit.kind, definition: unit.definition, range: discoveryRange(h), status, reason, evidence, evidenceDigest: evidenceHash(evidence) };
  const text = evidenceJson(saved);
  if (Buffer.byteLength(text) > 2 * 1024 * 1024) throw Object.assign(new Error('recovery_unit_size_limit'), { code: 'recovery_unit_size_limit' });
  const key = discoveryUnitKey(h.hour_start, unit.id);
  const old = db.prepare('SELECT value FROM compact_meta WHERE key=?').get(key);
  if (old && old.value !== text) throw Object.assign(new Error('recovery_unit_conflict'), { code: 'recovery_unit_conflict' });
  db.prepare('INSERT OR IGNORE INTO compact_meta(key,value) VALUES(?,?)').run(key, text);
  return saved;
}
export function persistDiscoveryRegistry(db, reg) {
  const definitionKey = `discovery_registry:${INTELLIGENCE_VERSION}:${registryDigest(reg)}`;
  const text = evidenceJson(reg);
  const old = db.prepare('SELECT value FROM compact_meta WHERE key=?').get(definitionKey);
  if (old && old.value !== text) throw new Error('discovery_registry_definition_conflict');
  db.prepare('INSERT OR IGNORE INTO compact_meta(key,value) VALUES(?,?)').run(definitionKey, text);
}
export function retainLiveDiscoveryEvidence(db, h, p, candidates, firstDex, definition, components, archive) {
  if (!definition) return; // Legacy/manual fixtures have no definition snapshot; never infer one from the digest.
  const reg = intelligenceRegistry(definition);
  if (registryDigest(reg) !== p.registryDigest) throw new Error('discovery_registry_definition_mismatch');
  persistDiscoveryRegistry(db, reg);
  if (p.discovery.candidateCount !== candidates.length || p.discovery.candidateEvidenceDigest !== evidenceHash(candidates)) return;
  const dexListsAgree = p.firstDexCount === firstDex.length && p.firstDexEvidenceDigest === evidenceHash(firstDex);
  const capped = p.discovery.reason === 'candidate_limit';
  for (const unit of discoveryUnitDefinitions(h, reg)) {
    let evidence;
    if (unit.kind === 'creations' && (components?.creations ?? !capped)) evidence = { candidates: candidates.filter(c => c.kind === 'creation'), firstDex: [] };
    else if (unit.kind.startsWith('uniswap_') && dexListsAgree && (components?.[unit.kind] ?? (p.firstDexComplete && !capped))) evidence = {
      candidates: candidates.filter(c => c.kind === 'pool' && c.poolEvidence?.protocol === unit.kind), firstDex: firstDex.filter(f => f.protocol === unit.kind) };
    else if (['launch', 'protocol'].includes(unit.kind)) {
      const entry = p[unit.kind === 'launch' ? 'launchSources' : 'protocols'].find(e => e.id === unit.entry.id);
      if (entry?.status === 'available' && (unit.kind !== 'launch' || (components?.launches?.[unit.entry.id] ?? !capped))) evidence = { candidates: unit.kind === 'launch' ? candidates.filter(c => c.kind === 'source'
        && unit.entry.addresses.includes(c.launchEvidence?.emitter) && c.launchEvidence.version === unit.entry.version) : [], firstDex: [], entry };
    } else if (unit.kind === 'exchange' && p.exchange.status === 'available') evidence = { candidates: [], firstDex: [], exchange: p.exchange };
    if (evidence) {
      try {
        persistDiscoveryUnit(db, h, unit, evidence);
        archive?.preserve('compact_meta',h.hour_start,[db.prepare('SELECT key,value FROM compact_meta WHERE key=?').get(discoveryUnitKey(h.hour_start,unit.id))],
          {scope:'independently_complete_discovery_unit',unitId:unit.id,registryDigest:p.registryDigest});
      }
      catch (error) {
        // Supplemental retention cannot block independently verified live indexing. Keep the earlier unit intact,
        // persist an explicit conflict/size diagnostic, and refuse its reuse during recovery.
        if (!['recovery_unit_conflict', 'recovery_unit_size_limit'].includes(error.code)) throw error;
        const warning = db.prepare('INSERT OR IGNORE INTO compact_meta(key,value) VALUES(?,?)')
          .run(`discovery_unit_warning:${h.hour_start}:${unit.id}`, evidenceJson({ reason: error.code }));
        if (warning.changes) console.warn(`DISCOVERY_PRESERVATION_BLOCKED hour=${h.hour_start} kind=${unit.kind} reason=${error.code}`);
      }
    }
  }
}
