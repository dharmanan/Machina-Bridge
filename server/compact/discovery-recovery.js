// Permanent, versioned discovery evidence units. No canonical/family/projection/valuation writer or schema initializer.
import { createHash } from 'node:crypto';
import { createIntelligenceRepository } from './intelligence-store.js';
import { archivedRows } from './evidence-archive.js';
import { discoveryUnitDefinitions, persistDiscoveryUnit, persistDiscoveryRegistry } from './discovery-evidence.js';
import { INTELLIGENCE_REGISTRY, INTELLIGENCE_VERSION, intelligenceRegistry, registryDigest, extensionStreams } from './intelligence-registry.js';
import { createIntelligenceSink, intelligenceJson, DISCOVERY_LIMIT_PER_HOUR } from './intelligence.js';
import { FAMILY_FIELDS, createNetworkAccumulator, createUniswapV3Accumulator, createUniswapV4Accumulator,
  createUsdcAccumulator, createAssetsAccumulator } from './families.js';
import { FAMILY_VERSIONS, COMPACT_DEFINITION_VERSION, LOG_STREAMS } from './sources.js';
import { PROJECTION_VERSIONS, createProjectionSink } from './projections.js';
import { headerOf, spineBlockOf, spineWindows } from './spine.js';
import { streamLogs, validateLogs } from './logs.js';
import { codeIsPresent } from './registry.js';
import { UNISWAP_REGISTRY } from '../../api/_lib/arc-intelligence/uniswap.js';
import { providerDiagnostics } from './provider.js';

export const DISCOVERY_PUBLIC_START = Date.parse('2026-09-16T11:00:00Z') / 1000;
export const RECOVERY_HOURS = 720;
export const MAX_RECOVERY_ATTEMPTS = 8;
export const RECOVERY_TIMEOUT_MS = 600_000;
// Recovery only: <=469 body requests for the maximum 15,000-block hour, leaving
// room for canonical boundaries within 512 HTTP requests. Live spine defaults stay unchanged.
export const RECOVERY_BLOCK_BATCH_SIZE = 32;
export const RECOVERY_RETRY_MS = 3_600_000;
export const V3_RETRY_POLICY = 'sqlite-pool-membership-v1';
const HOUR = 3600;
const hash = value => createHash('sha256').update(value).digest('hex');
const jsonHash = value => hash(intelligenceJson(value));
const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
  : value && typeof value === 'object' ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
    : JSON.stringify(value);
const fail = code => { throw Object.assign(new Error(code), { code }); };
const checkpoint = db => db.prepare('SELECT * FROM compact_checkpoint WHERE id=1').get();
const sameCheckpoint = (a, b) => a && b && a.hour_start === b.hour_start && a.last_block === b.last_block && a.last_hash === b.last_hash;
const rangeOf = h => ({ hourStart: h.hour_start, firstBlock: h.first_block, lastBlock: h.last_block, parentHash: h.parent_hash, lastHash: h.last_hash });
const unitKey = (hour, id) => `discovery_unit:${hour}:${id}`;
const retryKey = (hour, id, policy = null) => `discovery_retry:${hour}:${id}${policy ? `:${policy}` : ''}`;
const transaction = (db, fn) => {
  db.exec('BEGIN IMMEDIATE');
  try { const value = fn(); db.exec('COMMIT'); return value; } catch (error) { db.exec('ROLLBACK'); throw error; }
};
const meta = (db, key) => {
  const row = db.prepare('SELECT value FROM compact_meta WHERE key=?').get(key);
  if (!row) return null;
  if (Buffer.byteLength(row.value) > 2 * 1024 * 1024) fail('recovery_unit_size_limit');
  try { return JSON.parse(row.value); } catch { fail('recovery_unit_corrupt'); }
};
export function assertRecoverySchema(db) {
  if (db.prepare("SELECT value FROM compact_meta WHERE key='schema_version'").get()?.value !== '2') fail('recovery_schema_mismatch');
  const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row => row.name));
  for (const name of ['compact_hours', 'compact_checkpoint', 'compact_family_hours', 'compact_projection_hours',
    'compact_intelligence_hours', 'compact_token_discoveries', 'compact_token_dex_observations', 'compact_registry', 'compact_registry_coverage']) {
    if (!tables.has(name)) fail('recovery_tables_missing');
  }
}
function context(db, hour, registry) {
  if (!Number.isSafeInteger(hour) || hour % HOUR || hour < DISCOVERY_PUBLIC_START) fail('recovery_hour_outside_public_history');
  const cp = checkpoint(db);
  if (!cp || hour > cp.hour_start || hour < cp.hour_start - (RECOVERY_HOURS - 1) * HOUR) fail('recovery_hour_outside_window');
  const h = db.prepare('SELECT * FROM compact_hours WHERE hour_start=?').get(hour);
  if (!h || h.definition_version !== COMPACT_DEFINITION_VERSION) fail('recovery_canonical_definition_mismatch');
  if (!Number.isSafeInteger(h.first_block) || h.first_block < 1 || !Number.isSafeInteger(h.last_block) || h.last_block < h.first_block
    || h.last_block - h.first_block + 1 > 15000 || ![h.parent_hash, h.first_hash, h.last_hash].every(v => /^0x[0-9a-f]{64}$/.test(v))
    || !/^[0-9a-f]{64}$/.test(h.network_sha256)) fail('recovery_canonical_evidence_mismatch');
  let network;
  try { network = JSON.parse(h.network_json); } catch { fail('recovery_canonical_evidence_mismatch'); }
  if (canonical(network) !== h.network_json || network.status !== 'available' || network.blockCount !== h.block_count
    || h.block_count !== h.last_block - h.first_block + 1 || network.transactionCount !== h.transaction_count
    || network.uniqueActiveAddresses !== h.unique_active_addresses) fail('recovery_canonical_evidence_mismatch');
  const rows = db.prepare('SELECT * FROM compact_intelligence_hours WHERE hour_start=? ORDER BY definition_version,registry_digest').all(hour);
  if (rows.length > 16 || rows.reduce((n, r) => n + Buffer.byteLength(r.payload_json), 0) > 2 * 1024 * 1024) fail('recovery_evidence_limit');
  const keys = [...Object.keys(FAMILY_VERSIONS).map(k => `family_version:${k}`), ...Object.keys(PROJECTION_VERSIONS).map(k => `projection_version:${k}`)];
  const versions = new Map(db.prepare(`SELECT key,value FROM compact_meta WHERE key IN (${keys.map(() => '?').join(',')})`).all(...keys).map(r => [r.key, r.value]));
  const v3 = db.prepare("SELECT * FROM compact_registry_coverage WHERE kind='uniswap_v3_pool'").get();
  const digest = registryDigest(registry);
  const snapshot = meta(db, `discovery_registry:${INTELLIGENCE_VERSION}:${digest}`);
  if (snapshot && registryDigest(snapshot) !== digest) fail('recovery_registry_snapshot_corrupt');
  const fingerprint = jsonHash({ canonical: h.network_sha256, network: hash(h.network_json), v3Ready: Boolean(v3 && v3.through_block >= h.first_block - 1), versions: [...versions].sort() });
  return { h, cp, rows, versions, v3, digest, fingerprint };
}
function payload(row, h) {
  let p;
  try { p = JSON.parse(row.payload_json); } catch { fail('recovery_stored_evidence_corrupt'); }
  if (hash(row.payload_json) !== row.evidence_digest || p.version !== row.definition_version
    || p.registryDigest !== row.registry_digest || p.discovery?.status !== row.discovery_status
    || !['available', 'insufficient_coverage'].includes(row.discovery_status)
    || Object.entries(rangeOf(h)).some(([field, value]) => p.range?.[field] !== value)) fail('recovery_stored_evidence_corrupt');
  return p;
}
const definitions = discoveryUnitDefinitions;
function readUnit(db, h, unit) {
  if (meta(db, `discovery_unit_warning:${h.hour_start}:${unit.id}`)) fail('recovery_unit_preservation_blocked');
  const key=unitKey(h.hour_start,unit.id);
  const hot=meta(db,key);
  const archived=archivedRows(db,'compact_meta',h.hour_start,{evidenceKey:unit.id,predicate:m=>m.proof?.scope==='independently_complete_discovery_unit'&&m.proof.unitId===unit.id});
  const matches=archived.filter(r=>r.key===key).map(r=>JSON.parse(r.value));
  if(matches.some(r=>jsonHash(r)!==jsonHash(matches[0])) || hot&&matches.length&&jsonHash(hot)!==jsonHash(matches[0])) fail('recovery_archive_unit_conflict');
  const saved = matches[0]??hot;
  if (!saved) return null;
  if (!saved.evidence || !Array.isArray(saved.evidence.candidates) || !Array.isArray(saved.evidence.firstDex) || !saved.definition
    || saved.id !== unit.id || saved.kind !== unit.kind || jsonHash(saved.definition) !== jsonHash(unit.definition)
    || canonical(saved.range) !== canonical(rangeOf(h)) || jsonHash(saved.evidence) !== saved.evidenceDigest
    || !['available', 'insufficient_coverage'].includes(saved.status)) fail('recovery_unit_corrupt');
  return saved;
}
function validateRetry(attempt) {
  if (attempt && (!/^[0-9a-f]{64}$/.test(attempt.fingerprint) || !Number.isSafeInteger(attempt.attempts)
    || attempt.attempts < 1 || attempt.attempts > MAX_RECOVERY_ATTEMPTS || !Number.isSafeInteger(attempt.notBefore)
    || attempt.notBefore < 0 || !['retryable', 'blocked'].includes(attempt.phase)
    || typeof attempt.reason !== 'string' || attempt.reason.length > 256)) fail('recovery_retry_corrupt');
  return attempt;
}
function readRetry(db, hour, unit, fingerprint) {
  const legacy = validateRetry(meta(db, retryKey(hour, unit.id)));
  // Only this obsolete implementation cap is superseded. Keep the original record and attempt count;
  // exhausted quotas, corrupt evidence and every other blocked reason remain blocked.
  if (unit.kind !== 'uniswap_v3' || legacy?.fingerprint !== fingerprint || legacy.phase !== 'blocked'
    || legacy.reason !== 'recovery_pool_registry_limit' || legacy.attempts >= MAX_RECOVERY_ATTEMPTS) return legacy;
  const revised = validateRetry(meta(db, retryKey(hour, unit.id, V3_RETRY_POLICY)));
  const supersedes = jsonHash(legacy);
  if (revised && (revised.retryPolicy !== V3_RETRY_POLICY || revised.supersedes !== supersedes
    || revised.fingerprint !== fingerprint || revised.attempts < legacy.attempts)) fail('recovery_retry_policy_conflict');
  return revised ?? { ...legacy, phase: 'retryable', notBefore: 0, retryPolicy: V3_RETRY_POLICY, supersedes };
}
// Import only definitions and COMPLETE observation lists whose original count/digest is reproduced exactly.
// New source facts cannot contaminate an old digest: candidates are selected by the source definitions in that row.
function storedImports(db, c, registry, units) {
  const imports = new Map();
  if (!c.rows.length) return imports;
  let facts, dex;
  for (const row of c.rows) {
    const p = payload(row, c.h);
    if (row.definition_version !== INTELLIGENCE_VERSION || !Array.isArray(p.launchSources)
      || p.discovery.reason === 'candidate_limit') continue;
    const sources = registry.launches.filter(entry => p.launchSources.some(s => s.id === entry.id && s.version === entry.version
      && s.address === entry.address && s.source === entry.source && s.verificationBasis === entry.verificationBasis));
    const oldRegistry = intelligenceRegistry({ ...registry, launches: sources });
    if (registryDigest(oldRegistry) !== row.registry_digest) continue;
    facts ??= db.prepare('SELECT candidate_json FROM compact_token_discoveries WHERE hour_start=? ORDER BY block_number,candidate_key LIMIT 4097')
      .all(c.h.hour_start).map(r => JSON.parse(r.candidate_json));
    const candidates = facts.filter(f => f.kind !== 'source' || sources.some(entry => entry.addresses.includes(f.launchEvidence?.emitter)
      && entry.version === f.launchEvidence?.version && entry.events.some(e => e.event.signature === f.launchEvidence?.eventSignature)))
      .sort((a, b) => a.blockNumber - b.blockNumber || a.transactionIndex - b.transactionIndex || a.key.localeCompare(b.key));
    if (candidates.length !== p.discovery.candidateCount || jsonHash(candidates) !== p.discovery.candidateEvidenceDigest) continue;
    // A checksum proves the accepted list's integrity, not its completeness. A recovery aggregate that
    // explicitly reports missing creations must never turn an empty/partial list into a successful unit.
    if (!p.discovery.reason?.startsWith('creations:')) {
      imports.set(units.find(u => u.kind === 'creations').id, { candidates: candidates.filter(f => f.kind === 'creation'), firstDex: [] });
    }
    if (p.firstDexComplete) {
      dex ??= db.prepare('SELECT * FROM compact_token_dex_observations WHERE hour_start=? ORDER BY protocol,pool,activity LIMIT 4097').all(c.h.hour_start)
        .map(r => ({ protocol: r.protocol, pool: r.pool, activity: r.activity, blockNumber: r.block_number, logIndex: r.log_index, timestamp: r.timestamp, txHash: r.tx_hash }));
      if (dex.length === p.firstDexCount && jsonHash(dex) === p.firstDexEvidenceDigest) {
        for (const protocol of ['uniswap_v3', 'uniswap_v4']) {
          const family = protocol === 'uniswap_v3' ? 'uniswapV3' : 'uniswapV4';
          if (c.versions.get(`family_version:${family}`) === FAMILY_VERSIONS[family]
            && c.versions.get(`projection_version:${protocol}_pools`) === PROJECTION_VERSIONS[`${protocol}_pools`]) {
            imports.set(units.find(u => u.kind === protocol).id, { candidates: candidates.filter(f => f.kind === 'pool' && f.poolEvidence?.protocol === protocol),
              firstDex: dex.filter(f => f.protocol === protocol) });
          }
        }
      }
    }
    for (const unit of units.filter(u => u.kind === 'launch')) {
      const entry = p.launchSources.find(s => s.id === unit.entry.id);
      const proof = entry?.factoryEvidence;
      if (entry?.status === 'available' && sources.includes(unit.entry) && (!unit.entry.factoryVerification
        || proof?.status === 'verified' && proof.firstBlock === c.h.first_block && proof.lastBlock === c.h.last_block
          && proof.end?.status === 'verified' && (unit.entry.validFromBlock !== null || proof.start?.status === 'verified'))) {
        imports.set(unit.id, { candidates: candidates.filter(f => f.kind === 'source' && unit.entry.addresses.includes(f.launchEvidence?.emitter)
          && f.launchEvidence?.version === unit.entry.version), firstDex: [], entry });
      }
    }
    for (const unit of units.filter(u => u.kind === 'protocol')) {
      const entry = p.protocols?.find(e => e.id === unit.entry.id && e.version === unit.entry.version && e.address === unit.entry.address
        && e.source === unit.entry.source && e.verificationBasis === unit.entry.verificationBasis && e.status === 'available');
      if (entry) imports.set(unit.id, { candidates: [], firstDex: [], entry });
    }
    const exchangeUnit = units.find(u => u.kind === 'exchange');
    if (exchangeUnit && p.exchange?.status === 'available' && c.versions.get('family_version:usdc') === FAMILY_VERSIONS.usdc
      && c.versions.get('family_version:assets') === FAMILY_VERSIONS.assets) imports.set(exchangeUnit.id, { candidates: [], firstDex: [], exchange: p.exchange });
  }
  return imports;
}
function hourPlan(db, hour, registry, now) {
  const c = context(db, hour, registry), units = definitions(c.h, registry);
  const current = c.rows.find(r => r.definition_version === INTELLIGENCE_VERSION && r.registry_digest === c.digest);
  let currentPayload;
  let category = current ? current.discovery_status === 'available' ? 'current_available' : 'current_insufficient'
    : !c.rows.length ? 'missing' : c.rows.some(r => r.discovery_status === 'available') ? 'older_available' : 'older_insufficient_or_other_definition';
  let imports = new Map(), corrupt = null;
  try { for (const row of c.rows) { const p = payload(row, c.h); if (row === current) currentPayload = p; } imports = storedImports(db, c, registry, units); }
  catch (error) { corrupt = error.code ?? 'recovery_stored_evidence_corrupt'; category = 'inconsistent'; }
  const unitPlans = units.map(unit => {
    let saved, attempt;
    try { saved = readUnit(db, c.h, unit); attempt = readRetry(db, hour, unit, c.fingerprint); }
    catch (error) { corrupt ??= error.code; }
    let phase = saved?.status === 'available' || imports.has(unit.id) ? 'complete' : 'pending';
    let reason = saved?.reason ?? null;
    if (saved?.status === 'insufficient_coverage') { phase = 'blocked'; reason = saved.reason; }
    if (unit.entry?.validFromBlock !== null && unit.entry?.validFromBlock > c.h.first_block) { phase = 'blocked'; reason = 'registry_not_valid_for_entire_range'; }
    if (unit.kind === 'uniswap_v3' && phase === 'pending' && (!c.v3 || c.v3.through_block < c.h.first_block - 1)) {
      phase = 'blocked'; reason = 'v3_registry_missing_or_behind';
    }
    if (unit.kind.startsWith('uniswap_') && phase === 'pending'
      && (c.versions.get(`family_version:${unit.kind === 'uniswap_v3' ? 'uniswapV3' : 'uniswapV4'}`) !== unit.definition.family
        || c.versions.get(`projection_version:${unit.kind}_pools`) !== unit.definition.projection)) {
      phase = 'blocked'; reason = 'recovery_pool_definition_mismatch';
    }
    if (attempt?.fingerprint === c.fingerprint && phase === 'pending') {
      reason = attempt.reason;
      if (attempt.phase === 'blocked' || attempt.attempts >= MAX_RECOVERY_ATTEMPTS) phase = 'blocked';
      else if (attempt.notBefore > now) phase = 'retryable';
    }
    return { ...unit, phase, reason, attempts: attempt?.fingerprint === c.fingerprint ? attempt.attempts : 0,
      retryPolicy: attempt?.fingerprint === c.fingerprint ? attempt.retryPolicy ?? null : null,
      supersedes: attempt?.supersedes ?? null,
      saved, imported: imports.get(unit.id) ?? null };
  });
  const aggregateLimited = unitPlans.every(u => u.phase === 'complete') && ['candidate_limit', 'first_dex_observation_limit'].includes(currentPayload?.discovery.reason);
  const phase = corrupt || aggregateLimited ? 'blocked' : category === 'current_available' ? 'recovered'
    : unitPlans.some(u => u.phase === 'pending') || unitPlans.every(u => u.phase === 'complete') ? 'pending'
      : unitPlans.some(u => u.phase === 'retryable') ? 'retryable' : 'blocked';
  return { c, units: unitPlans, category, phase, reason: corrupt ?? (aggregateLimited ? currentPayload.discovery.reason : null) };
}
export function recoveryHourPlan(db, hour, { registry = INTELLIGENCE_REGISTRY, now = Date.now() } = {}) {
  let p;
  try { p = hourPlan(db, hour, registry, now); }
  catch (error) { return { hourStart: hour, digest: registryDigest(registry), category: 'inconsistent', phase: 'blocked', reason: error.code ?? 'recovery_evidence_corrupt', units: [] }; }
  return { hourStart: hour, digest: p.c.digest, category: p.category, phase: p.phase, reason: p.reason,
    units: p.units.map(({ kind, id, entry, phase, reason, attempts, retryPolicy }) => ({ kind, id, source: entry?.id ?? null, phase, reason, attempts, retryPolicy })) };
}
export function planDiscoveryRecovery(db, { registry = INTELLIGENCE_REGISTRY, now = Date.now() } = {}) {
  assertRecoverySchema(db);
  const cp = checkpoint(db);
  if (!cp) return { digest: registryDigest(registry), counts: { pending: 0, recovered: 0, blocked: 0, retryable: 0 }, candidate: null, hours: [] };
  const hours = db.prepare('SELECT hour_start FROM compact_hours WHERE hour_start BETWEEN ? AND ? ORDER BY hour_start LIMIT 721')
    .all(Math.max(DISCOVERY_PUBLIC_START, cp.hour_start - (RECOVERY_HOURS - 1) * HOUR), cp.hour_start);
  if (hours.length > RECOVERY_HOURS) fail('recovery_window_limit');
  const plans = hours.map(r => recoveryHourPlan(db, r.hour_start, { registry, now }));
  const counts = { pending: 0, recovered: 0, blocked: 0, retryable: 0 };
  for (const p of plans) counts[p.phase] = (counts[p.phase] ?? 0) + 1;
  // Oldest eligible gap first: continuing live hours cannot indefinitely displace existing historical work.
  return { digest: registryDigest(registry), counts, candidate: plans.find(p => p.phase === 'pending')?.hourStart ?? null, hours: plans };
}
function unchanged(db, c) {
  const h = db.prepare('SELECT * FROM compact_hours WHERE hour_start=?').get(c.h.hour_start);
  if (canonical(h) !== canonical(c.h) || !sameCheckpoint(c.cp, checkpoint(db))) fail('recovery_canonical_state_changed');
}
function saveUnit(db, c, unit, evidence, { status = 'available', reason = null, beforeCommit = null } = {}) {
  if (evidence.candidates.length > DISCOVERY_LIMIT_PER_HOUR || evidence.firstDex.length > DISCOVERY_LIMIT_PER_HOUR * 2) fail('recovery_unit_candidate_limit');
  return transaction(db, () => {
    unchanged(db, c);
    const saved = persistDiscoveryUnit(db, c.h, unit, evidence, status, reason);
    beforeCommit?.();
    return saved;
  });
}

function retry(db, c, unit, { now, reason, phase = 'retryable', lease = false, diagnostics = null }) {
  transaction(db, () => {
    unchanged(db, c);
    db.prepare('INSERT INTO compact_meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
      .run(retryKey(c.h.hour_start, unit.id, unit.retryPolicy), intelligenceJson({ fingerprint: c.fingerprint, attempts: unit.attempts + 1,
        reason, phase, notBefore: now + RECOVERY_RETRY_MS + (lease ? RECOVERY_TIMEOUT_MS : 0),
        ...(unit.retryPolicy ? { retryPolicy: unit.retryPolicy, supersedes: unit.supersedes } : {}),
        ...(diagnostics ? { diagnostics } : {}) }));
  });
}
async function boundaries(provider, h) {
  const numbers = [h.first_block - 1, h.first_block, h.last_block, h.last_block + 1];
  const raw = await provider.batch(numbers.map(n => ['eth_getBlockByNumber', [`0x${n.toString(16)}`, false]]));
  const [before, first, last, after] = raw.map((r, i) => headerOf(r, numbers[i]));
  if (before.hash !== h.parent_hash || first.hash !== h.first_hash || last.hash !== h.last_hash || first.parentHash !== before.hash
    || after.parentHash !== last.hash || before.timestamp >= h.hour_start || first.timestamp < h.hour_start
    || last.timestamp >= h.hour_start + HOUR || after.timestamp < h.hour_start + HOUR) fail('recovery_boundary_mismatch');
  const range = { kind: 'hour', hourStart: h.hour_start, hourEnd: h.hour_start + HOUR,
    startUtc: new Date(h.hour_start * 1000).toISOString(), endUtc: new Date((h.hour_start + HOUR) * 1000).toISOString(),
    firstBlock: h.first_block, lastBlock: h.last_block, parentHash: h.parent_hash, firstHash: h.first_hash, lastHash: h.last_hash,
    firstTimestamp: first.timestamp, lastTimestamp: last.timestamp };
  if (hash(canonical({ definitionVersion: h.definition_version, range, network: JSON.parse(h.network_json) })) !== h.network_sha256) fail('recovery_network_digest_mismatch');
  return { before, first, last, after };
}
// Existing Gateway/projection repair model: canonical pinned boundaries plus canonical log-bearing block/tx proofs.
// Never rescans non-event transaction bodies for a source-only unit. Keep the
// <=500-block log range, but retain at most 32 decoded block/transaction proofs.
async function scan(provider, h, stream, onLogs) {
  for (let from = h.first_block; from <= h.last_block; from += 500) {
    // validateLogs duplicate keys are relative to this chunk, not the entire hour.
    const seen = new Set();
    const to = Math.min(h.last_block, from + 499);
    for await (const raw of streamLogs(provider, stream, from, to)) {
      const numbers = [...new Set(raw.map(r => Number(BigInt(r.blockNumber))))].sort((a, b) => a - b);
      if (numbers.some(n => !Number.isSafeInteger(n) || n < from || n > to)) fail('recovery_log_range_mismatch');
      raw.sort((a, b) => Number(BigInt(a.blockNumber)) - Number(BigInt(b.blockNumber)));
      let cursor = 0;
      if (!numbers.length) await onLogs([], new Map());
      for (let offset = 0; offset < numbers.length; offset += RECOVERY_BLOCK_BATCH_SIZE) {
        const chunk = numbers.slice(offset, offset + RECOVERY_BLOCK_BATCH_SIZE);
        const window = new Map();
        const blocks = await provider.batch(chunk.map(n => ['eth_getBlockByNumber', [`0x${n.toString(16)}`, true]]));
        blocks.forEach((b, i) => {
          const block = spineBlockOf(b, chunk[i]);
          if (block.timestamp < h.hour_start || block.timestamp >= h.hour_start + HOUR
            || block.number === h.first_block && block.hash !== h.first_hash || block.number === h.last_block && block.hash !== h.last_hash) fail('recovery_event_block_mismatch');
          window.set(block.number, block);
        });
        const start = cursor;
        while (cursor < raw.length && Number(BigInt(raw[cursor].blockNumber)) <= chunk.at(-1)) cursor++;
        await onLogs(validateLogs(raw.slice(start, cursor), stream, { fromBlock: from, toBlock: to, window, seen }), window);
      }
    }
  }
}
function singleRegistry(registry, unit) {
  return intelligenceRegistry({ ...registry, launches: unit.kind === 'launch' ? [unit.entry] : [],
    protocols: unit.kind === 'protocol' ? [unit.entry] : [], exchanges: unit.kind === 'exchange' ? registry.exchanges : [] });
}
function finishSink(sink, h, families, projections, present = () => false) {
  return sink.finish({ range: rangeOf(h), families, projections, codePresent: present });
}
export async function recoverEvidenceUnit({ db, provider, c, unit, registry = INTELLIGENCE_REGISTRY }) {
  const h = c.h;
  const edges = await boundaries(provider, h);
  const reg = singleRegistry(registry, unit), sink = createIntelligenceSink({ registry: reg });
  let result;
  const families = { uniswapV3: { status: 'unavailable' }, uniswapV4: { status: 'unavailable' } };
  if (unit.kind === 'creations') {
    const network = createNetworkAccumulator(); let last;
    for await (const blocks of spineWindows(provider, { first: h.first_block, last: h.last_block, before: edges.before,
      hourStart: h.hour_start, hourEnd: h.hour_start + HOUR,
      batchSize: RECOVERY_BLOCK_BATCH_SIZE, windowBlocks: RECOVERY_BLOCK_BATCH_SIZE })) { network.addBlocks(blocks); sink.blocks(blocks); last = blocks.at(-1); }
    if (last.hash !== h.last_hash || canonical(network.finish({ durationSeconds: HOUR })) !== h.network_json) fail('recovery_network_conflict');
    const p = finishSink(sink, h, families, null);
    result = { evidence: { candidates: p.discovery.candidates, firstDex: [] }, status: p.discovery.reason === 'candidate_limit' ? 'insufficient_coverage' : 'available',
      reason: p.discovery.reason === 'candidate_limit' ? 'candidate_limit' : null };
  } else if (unit.kind.startsWith('uniswap_')) {
    const v3 = unit.kind === 'uniswap_v3', family = v3 ? 'uniswapV3' : 'uniswapV4';
    if (c.versions.get(`family_version:${family}`) !== FAMILY_VERSIONS[family]
      || c.versions.get(`projection_version:${unit.kind}_pools`) !== PROJECTION_VERSIONS[`${unit.kind}_pools`]) fail('recovery_pool_definition_mismatch');
    const projection = createProjectionSink({ onVerifiedDex: sink.dex });
    if (v3 && (!c.v3 || c.v3.through_block < h.first_block - 1)) fail('recovery_pool_registry_unavailable');
    // The existing (kind,address) primary key bounds each lookup to one row. No registry-sized Set,
    // cache or address-filter RPC is required; same-hour factory discoveries still use the accumulator overlay.
    const membership = v3 ? db.prepare("SELECT 1 FROM compact_registry WHERE kind='uniswap_v3_pool' AND address=? AND created_block<?") : null;
    const accumulator = v3 ? createUniswapV3Accumulator({ registry: { through: h.first_block - 1, throughHash: h.parent_hash,
      pools: { has: address => Boolean(membership.get(address, h.first_block)) } }, projection }) : createUniswapV4Accumulator({ projection });
    for (const stream of LOG_STREAMS.filter(s => (v3 ? ['v3Factory', 'v3Pools'] : ['v4']).includes(s.key))) {
      await scan(provider, h, stream, (logs, window) => {
        accumulator.add(stream.key, logs, window);
        if (stream.key === 'v3Factory') for (const record of accumulator.createdPools()) if (window.has(record.createdBlock)) sink.poolCreated(record, window);
      });
    }
    const address = v3 ? UNISWAP_REGISTRY.v3Factory.address : UNISWAP_REGISTRY.v4PoolManager.address;
    const present = codeIsPresent(await provider.request('eth_getCode', [address, `0x${h.last_block.toString(16)}`]));
    const metrics = await accumulator.finish({ provider, blockTag: `0x${h.last_block.toString(16)}`, factoryCodePresent: present,
      poolManagerCodePresent: present, codePresent: () => present });
    families[family] = { status: 'available', ...metrics };
    const stored = db.prepare('SELECT * FROM compact_family_hours WHERE hour_start=? AND family=?').get(h.hour_start, family);
    if (stored?.status === 'available' && canonical(Object.fromEntries(FAMILY_FIELDS[family].map(k => [k, metrics[k]]))) !== stored.metrics_json) fail('recovery_family_evidence_conflict');
    const projections = projection.finish({ families, hourStart: h.hour_start, firstBlock: h.first_block, lastBlock: h.last_block });
    if (projections[`${unit.kind}_pools`]?.status !== 'available') fail('recovery_pool_discovery_unavailable');
    const p = finishSink(sink, h, families, projections);
    const reason = p.discovery.reason === 'candidate_limit' ? 'candidate_limit' : p.firstDexLimited ? 'first_dex_observation_limit' : null;
    result = { evidence: { candidates: p.discovery.candidates, firstDex: p.firstDex }, status: reason ? 'insufficient_coverage' : 'available',
      reason, permanent: Boolean(reason) };
  } else if (unit.kind === 'exchange') {
    const accumulators = { usdc: createUsdcAccumulator(), assets: createAssetsAccumulator() };
    for (const stream of LOG_STREAMS.filter(s => ['usdc', 'assets'].includes(s.key))) {
      await scan(provider, h, stream, (logs, window) => { accumulators[stream.key].add(stream.key, logs, window); sink.transfers(logs); });
    }
    for (const [family, accumulator] of Object.entries(accumulators)) {
      const metrics = accumulator.finish();
      families[family] = { status: 'available', ...metrics };
    }
    const p = finishSink(sink, h, families, null);
    result = { evidence: { candidates: [], firstDex: [], exchange: p.exchange }, status: p.exchange.status === 'available' ? 'available' : 'insufficient_coverage', reason: p.exchange.reason };
  } else {
    const stream = extensionStreams(reg).find(s => s.kind === unit.kind);
    const codes = unit.entry.factoryVerification ? [] : await provider.batch(unit.entry.addresses.map(a => ['eth_getCode', [a, `0x${h.last_block.toString(16)}`]]));
    const present = a => codeIsPresent(codes[unit.entry.addresses.indexOf(a)]);
    if (!unit.entry.factoryVerification && !unit.entry.addresses.every(present)) {
      const p = finishSink(sink, h, families, null, present);
      const entry = p[unit.kind === 'launch' ? 'launchSources' : 'protocols'][0];
      return { evidence: { candidates: [], firstDex: [], entry }, status: 'insufficient_coverage', reason: entry.reason, permanent: true };
    }
    if (unit.kind === 'launch') {
      await sink.verifyLaunchSources(provider, { firstBlock: h.first_block, lastBlock: h.last_block });
      if (unit.entry.factoryVerification) {
        const preflight = finishSink(sink, h, families, null).launchSources[0];
        if (preflight.factoryEvidence?.status !== 'verified') {
          return { evidence: { candidates: [], firstDex: [], entry: preflight }, status: 'insufficient_coverage',
            reason: preflight.reason, permanent: ['code_absent_at_requested_end', 'official_event_topic_not_in_bytecode']
              .includes(preflight.factoryEvidence?.end?.reason) || ['code_absent_at_requested_end', 'official_event_topic_not_in_bytecode'].includes(preflight.factoryEvidence?.start?.reason) };
        }
      }
    }
    await scan(provider, h, stream, (logs, window) => sink.extension(stream, logs, window));
    const p = finishSink(sink, h, families, null, present);
    const entry = p[unit.kind === 'launch' ? 'launchSources' : 'protocols'][0];
    result = { evidence: { candidates: p.discovery.candidates, firstDex: [], entry }, status: entry.status === 'available' ? 'available' : 'insufficient_coverage', reason: entry.reason,
      permanent: ['malformed_registered_event', 'invalid_launch_identity', 'protocol_asset_limit'].includes(entry.reason) };
    if (p.discovery.reason === 'candidate_limit') { result.status = 'insufficient_coverage'; result.reason = 'candidate_limit'; }
  }
  await boundaries(provider, h);
  return result;
}
function aggregate(c, units) {
  const facts = new Map(), dex = new Map(); let capped = false;
  for (const unit of units) {
    for (const candidate of unit.saved?.evidence.candidates ?? []) {
      const previous = facts.get(candidate.key);
      if (previous && intelligenceJson(previous) !== intelligenceJson(candidate)) fail('recovery_candidate_conflict');
      facts.set(candidate.key, candidate);
    }
    for (const f of unit.saved?.evidence.firstDex ?? []) {
      const key = `${f.protocol}:${f.pool}:${f.activity}`;
      const previous = dex.get(key);
      if (previous && intelligenceJson(previous) !== intelligenceJson(f)) fail('recovery_dex_conflict');
      dex.set(key, f);
    }
  }
  let candidates = [...facts.values()].sort((a, b) => a.blockNumber - b.blockNumber || a.transactionIndex - b.transactionIndex || a.key.localeCompare(b.key));
  if (candidates.length > DISCOVERY_LIMIT_PER_HOUR) { capped = true; candidates = candidates.slice(0, DISCOVERY_LIMIT_PER_HOUR); }
  let firstDex = [...dex.values()].sort((a, b) => a.protocol.localeCompare(b.protocol) || a.pool.localeCompare(b.pool) || a.activity.localeCompare(b.activity));
  const dexCapped = firstDex.length > DISCOVERY_LIMIT_PER_HOUR * 2;
  if (dexCapped) firstDex = firstDex.slice(0, DISCOVERY_LIMIT_PER_HOUR * 2);
  const incomplete = units.find(u => u.saved?.status !== 'available');
  const reason = capped ? 'candidate_limit' : dexCapped ? 'first_dex_observation_limit'
    : incomplete ? `${incomplete.kind}:${incomplete.saved?.reason ?? incomplete.reason ?? 'evidence_not_stored'}` : null;
  return { version: INTELLIGENCE_VERSION, registryDigest: c.digest, range: rangeOf(c.h),
    discovery: { scope: 'top_level_creations_and_registered_sources', status: reason ? 'insufficient_coverage' : 'available', reason,
      internalCreations: 'not_supported', allArcTokensComplete: false, poolTokens: 'additional_verified_pool_observations_not_deployment_universe', candidates },
    firstDex,
    firstDexComplete: !capped && !dexCapped && units.filter(u => u.kind.startsWith('uniswap_')).every(u => u.saved?.status === 'available'),
    exchange: units.find(u => u.kind === 'exchange')?.saved?.evidence.exchange ?? { status: units.some(u => u.kind === 'exchange') ? 'insufficient_coverage' : 'unavailable',
      reason: units.some(u => u.kind === 'exchange') ? 'exchange_evidence_not_stored' : 'verified_exchange_registry_empty',
      registryVersions: units.find(u => u.kind === 'exchange')?.definition.exchanges.map(e => `${e.id}:${e.address}:${e.version}`).sort() ?? [], rows: [] },
    protocols: units.filter(u => u.kind === 'protocol').map(u => u.saved?.evidence.entry ?? unavailableEntry(u)),
    launchSources: units.filter(u => u.kind === 'launch').map(u => u.saved?.evidence.entry ?? unavailableEntry(u)) };
}
function unavailableEntry(u) {
  const e = u.entry;
  return { kind: u.kind, id: e.id, version: e.version, source: e.source, verificationBasis: e.verificationBasis, address: e.address,
    status: 'unavailable', reason: u.reason ?? 'evidence_not_stored', counts: u.kind === 'protocol' ? null : {}, rawFlows: u.kind === 'protocol' ? null : {},
    ...(e.factoryVerification ? { factoryEvidence: { status: 'unavailable', reason: 'factory_verification_not_run' }, validFromBlock: e.validFromBlock,
      validityBasis: e.validityBasis, protocol: e.protocol, sourceDefinitionVersion: e.sourceDefinitionVersion } : {}) };
}
export function commitDiscoveryRecovery(db, c, units, { registry = INTELLIGENCE_REGISTRY, beforeCommit = null } = {}) {
  return transaction(db, () => {
    unchanged(db, c);
    const p = aggregate(c, units);
    if (p.registryDigest !== registryDigest(registry)) fail('recovery_definition_mismatch');
    persistDiscoveryRegistry(db, registry);
    createIntelligenceRepository(db).recordHour({ range: p.range, intelligence: p });
    beforeCommit?.();
    return { phase: p.discovery.status === 'available' ? 'recovered' : 'incomplete', reason: p.discovery.reason };
  });
}
export async function recoverDiscoveryHour({ db, hourStart, provider, registry = INTELLIGENCE_REGISTRY, now = Date.now(),
  recoverUnit = recoverEvidenceUnit, beforeCommit = null, beforeUnitCommit = null, checkBudget = () => {}, checkStorage = () => {}, log = () => {} }) {
  assertRecoverySchema(db);
  const plan = hourPlan(db, hourStart, registry, now);
  if (plan.phase !== 'pending') return { hourStart, phase: plan.phase, reason: plan.reason, rpcNeeded: false };
  const { c, units } = plan;
  if (c.h.last_block - c.h.first_block + 1 > 15000) fail('recovery_block_limit');
  let calls = false;
  for (const unit of units) {
    checkStorage();
    checkBudget(); // Capacity guard before background writes or historical requests.
    if (unit.imported && !unit.saved) unit.saved = saveUnit(db, c, unit, unit.imported, { beforeCommit: beforeUnitCommit });
    if (unit.phase !== 'pending' || unit.saved) continue;
    retry(db, c, unit, { now, reason: 'recovery_interrupted_or_in_progress', lease: true });
    try {
      checkBudget(); calls = true;
      const result = await recoverUnit({ db, provider, c, unit, registry });
      checkBudget();
      checkStorage();
      // Transient semantic unavailability remains retryable. Deterministic caps/validity failures retain their evidence permanently.
      if (result.status === 'available' || result.reason === 'candidate_limit' || result.reason === 'registry_not_valid_for_entire_range' || result.permanent) {
        unit.saved = saveUnit(db, c, unit, result.evidence, { status: result.status, reason: result.reason, beforeCommit: beforeUnitCommit });
        log(`DISCOVERY_UNIT_COMMITTED hour=${hourStart} kind=${unit.kind} source=${unit.entry?.id ?? 'none'} status=${result.status}`);
      } else { unit.reason = result.reason; retry(db, c, unit, { now, reason: result.reason }); }
    } catch (error) {
      unit.reason = error.code ?? 'recovery_failed';
      try {checkStorage();} catch (storageError) {log(`DISCOVERY_STORAGE_BLOCKED reason=${storageError.code??storageError.message}`);throw storageError;}
      const diagnostics = providerDiagnostics(error);
      retry(db, c, unit, { now, reason: unit.reason, diagnostics, phase: /conflict|corrupt|mismatch|limit/.test(unit.reason) && !/rate_limit/.test(unit.reason) ? 'blocked' : 'retryable' });
      log(`DISCOVERY_UNIT_FAILED hour=${hourStart} kind=${unit.kind} source=${unit.entry?.id ?? 'none'} attempt=${unit.attempts + 1} reason=${unit.reason} diagnostics=${JSON.stringify(diagnostics)}`);
      // Subsequent requests after a provider/budget failure are forbidden. Already committed units survive.
      try { checkBudget(); } catch { break; }
    }
  }
  checkStorage();
  const outcome = commitDiscoveryRecovery(db, c, units, { registry, beforeCommit });
  const finalPlan = recoveryHourPlan(db, hourStart, { registry, now });
  return { hourStart, ...outcome, pendingPhase: finalPlan.phase, rpcNeeded: calls,
    completedUnits: units.filter(u => u.saved?.status === 'available').length, requiredUnits: units.length };
}
