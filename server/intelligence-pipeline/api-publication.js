// Explicit laboratory publication into the existing compact API schema. Never imported by the live scheduler.
// The accepted pipeline evidence remains the authority; these small API rows are a derived read cache.
import { createCompactStore } from '../compact/store.js';
import { createCompactReadModel, ReadModelError } from '../compact/read-model.js';
import { FAMILY_FIELDS, FAMILY_WINDOWS } from '../compact/families.js';
import { COMPACT_DEFINITION_VERSION, FAMILY_VERSIONS, LOG_STREAMS } from '../compact/sources.js';
import { archiveConfig } from '../compact/evidence-archive.js';
import { sha256Of, canonicalJson as canonicalText } from '../compact/projections.js';
import { sumWindow } from '../compact/windows.js';
import { deriveProtocolMetrics, protocolSource } from './protocol-source.js';
import { verifyNetworkSeal, decodeIds } from './network-hour-store.js';
import { hash, fail, json, readDefinition, assertHeapBudget } from './storage.js';
import { dexProjectionSource, deriveDexUiProjections } from './dex-projection-source.js';
import { ACTIVITY_KINDS, ACTIVITY_ROWS_PER_KIND } from '../compact/projections.js';
import { createHash } from 'node:crypto';
import { readPoolWitness } from './pool-witness-source.js';
import { createDiscoveryPublication } from './discovery-publication.js';

const SQL = `CREATE TABLE IF NOT EXISTS arc_pipeline_api_publications (
  hour_start INTEGER NOT NULL, manifest_sha TEXT NOT NULL, manifest_json TEXT NOT NULL,
  PRIMARY KEY(hour_start,manifest_sha)) STRICT,WITHOUT ROWID;
CREATE TRIGGER IF NOT EXISTS arc_pipeline_api_publication_immutable BEFORE UPDATE ON arc_pipeline_api_publications
BEGIN SELECT RAISE(ABORT,'api_publication_immutable'); END;
CREATE TRIGGER IF NOT EXISTS arc_pipeline_api_publication_no_delete BEFORE DELETE ON arc_pipeline_api_publications
BEGIN SELECT RAISE(ABORT,'api_publication_immutable'); END;
CREATE TABLE IF NOT EXISTS arc_pipeline_api_days(day_start INTEGER PRIMARY KEY,value_sha TEXT NOT NULL,inputs_sha TEXT NOT NULL) STRICT;
CREATE TRIGGER IF NOT EXISTS arc_pipeline_api_day_immutable BEFORE UPDATE ON arc_pipeline_api_days
BEGIN SELECT RAISE(ABORT,'api_daily_evidence_immutable'); END;
CREATE TRIGGER IF NOT EXISTS arc_pipeline_api_day_no_delete BEFORE DELETE ON arc_pipeline_api_days
BEGIN SELECT RAISE(ABORT,'api_daily_evidence_immutable'); END;
CREATE TABLE IF NOT EXISTS arc_pipeline_api_cache_repairs(id INTEGER PRIMARY KEY,hour_start INTEGER NOT NULL,
  dataset TEXT NOT NULL,damaged_sha TEXT NOT NULL,restored_sha TEXT NOT NULL) STRICT;
CREATE TABLE IF NOT EXISTS arc_pipeline_api_projection_copies(hour_start INTEGER NOT NULL,projection TEXT NOT NULL,rows_sha TEXT NOT NULL,
  body_sha TEXT NOT NULL,PRIMARY KEY(hour_start,projection,rows_sha)) STRICT,WITHOUT ROWID;
CREATE TRIGGER IF NOT EXISTS arc_pipeline_api_projection_copy_immutable BEFORE UPDATE ON arc_pipeline_api_projection_copies
BEGIN SELECT RAISE(ABORT,'api_projection_commitment_immutable'); END;
CREATE TRIGGER IF NOT EXISTS arc_pipeline_api_projection_copy_no_delete BEFORE DELETE ON arc_pipeline_api_projection_copies
BEGIN SELECT RAISE(ABORT,'api_projection_commitment_immutable'); END;
CREATE TABLE IF NOT EXISTS arc_pipeline_api_registry_copies(kind TEXT NOT NULL,address TEXT NOT NULL,row_sha TEXT NOT NULL,
  proof_sha TEXT NOT NULL,PRIMARY KEY(kind,address)) STRICT,WITHOUT ROWID;
CREATE TRIGGER IF NOT EXISTS arc_pipeline_api_registry_copy_immutable BEFORE UPDATE ON arc_pipeline_api_registry_copies
BEGIN SELECT RAISE(ABORT,'api_registry_commitment_immutable'); END;
CREATE TRIGGER IF NOT EXISTS arc_pipeline_api_registry_copy_no_delete BEFORE DELETE ON arc_pipeline_api_registry_copies
BEGIN SELECT RAISE(ABORT,'api_registry_commitment_immutable'); END;`;
// Reuse the existing canonical JSON renderer: rebuilding a sorted JS object would reorder integer-like domain keys.

function binding(p, unitId, network) {
  const u = p.db.prepare('SELECT * FROM arc_pipeline_units WHERE unit_id=?').get(unitId);
  if (!u || u.hour_start !== network.hourStart || u.first_block !== network.range.firstBlock
    || u.last_block !== network.range.lastBlock || u.anchor_hash !== network.range.lastHash) fail('api_source_canonical_conflict');
  if (p.coverage(unitId).status !== 'complete') fail('api_source_incomplete');
  const spec = JSON.parse(readDefinition(u.unit_json));
  const jobs = p.db.prepare("SELECT first_block,last_block,expected_sha FROM arc_pipeline_jobs WHERE unit_id=? AND state='complete' ORDER BY first_block").all(unitId);
  return { unitId, sourceKey: u.source_key, registryDigest: u.registry_digest, source: spec.source, pieces: jobs };
}

export function createPipelineApiPublication(target, { onProgress } = {}) {
  assertHeapBudget();
  if (target.readOnly) fail('api_publication_read_only_target');
  // A pipeline marker, not an arbitrary compact/production database, is required even for explicit use.
  if (target.db.prepare("SELECT value FROM arc_pipeline_meta WHERE key='version'").get()?.value !== 'arc-independent-reduced-evidence-v1') {
    fail('independent_database_marker_required');
  }
  target.guard(256 * 1024);
  const store = createCompactStore(target.db, { archive: { config: archiveConfig({ COMPACT_EVIDENCE_ARCHIVE_ENABLED: 'false' }) } });
  target.db.exec('PRAGMA synchronous=FULL; PRAGMA cache_size=-2048');
  target.transaction(() => target.db.exec(SQL));
  const discoveryPublication=createDiscoveryPublication(target);

  function projectionBodySha(db,hour,name){
    const hash=createHash('sha256');let table,protocol;
    if(name==='uniswap_v3_pools'||name==='uniswap_v4_pools'){table='compact_pool_hours';protocol=name==='uniswap_v3_pools'?'uniswap_v3':'uniswap_v4';}
    else if(name==='uniswap_v3_price_paths'||name==='uniswap_v4_price_paths'){table='compact_pool_price_hours';protocol=name==='uniswap_v3_price_paths'?'uniswap_v3':'uniswap_v4';}
    else if(name==='uniswap_v4_swap_fees')table='compact_pool_fee_hours';
    else if(name==='dex_activity')table='compact_dex_activity';else fail('api_projection_unknown');
    const order=name==='dex_activity'?'block_number DESC,log_index DESC':'pool';
    const sql=`SELECT * FROM ${table} WHERE hour_start=?${protocol?' AND protocol=?':''} ORDER BY ${order}`;
    for(const row of db.prepare(sql).iterate(...(protocol?[hour,protocol]:[hour])))hash.update(canonicalText(row)+'\n');
    return hash.digest('hex');
  }

  function verifiedLocalNetwork(hour) {
    const m = target.db.prepare('SELECT manifest_json,manifest_sha FROM arc_pipeline_api_publications WHERE hour_start=? ORDER BY manifest_sha').all(hour);
    for (const row of m) {
      if (hash(row.manifest_json) !== row.manifest_sha) fail('api_publication_corrupt');
      const manifest = JSON.parse(row.manifest_json), id = manifest.evidence.network.unitId;
      if (!target.db.prepare('SELECT 1 FROM arc_pipeline_units WHERE unit_id=?').get(id)) continue;
      const seal = target.getSeal(id);
      if (seal?.summary.canonicalSha256 !== manifest.canonicalSha || seal.summary.hourStart !== hour) fail('api_cache_expiry_source_conflict');
      verifyNetworkSeal(target.db, seal, target.db.prepare('SELECT * FROM arc_pipeline_units WHERE unit_id=?').get(id));
      return { seal, sha: manifest.canonicalSha };
    }
    fail('api_cache_expiry_durable_inputs_missing');
  }

  // Only disposable API membership caches expire. Accepted membership seals/dictionary and canonical facts survive.
  // External lab inputs are deliberately excluded: automatic expiry requires the authority in this same SQLite file.
  function expireReadCaches(latest) {
    const expired = { hourlyMembershipHours: 0, finalizedDays: 0 };
    for (const row of target.db.prepare('SELECT DISTINCT hour_start FROM compact_hour_addresses WHERE hour_start<=? ORDER BY hour_start LIMIT 4').all(latest - 24 * 3600)) {
      const { seal } = verifiedLocalNetwork(row.hour_start);
      target.transaction(() => {
        // Verification happens again inside the deletion transaction; checksum failure retains the cache.
        verifiedLocalNetwork(row.hour_start);
        target.db.prepare('DELETE FROM compact_hour_addresses WHERE hour_start=?').run(row.hour_start);
      }, seal.summary.network.uniqueActiveAddresses * 80 + 65536);
      expired.hourlyMembershipHours++;
    }
    const days = target.db.prepare(`SELECT day_start,active_addresses FROM compact_daily_active_addresses d WHERE status='available'
      AND EXISTS(SELECT 1 FROM compact_daily_address_stage s WHERE s.day_start=d.day_start) ORDER BY day_start LIMIT 1`).all();
    for (const day of days) {
      target.guard(day.active_addresses * 64 + 65536);
      target.db.exec('CREATE TEMP TABLE api_day_members(id INTEGER PRIMARY KEY) STRICT');
      try {
        const add = target.db.prepare('INSERT OR IGNORE INTO api_day_members VALUES(?)'), inputs = [];
        for (let hour = day.day_start; hour < day.day_start + 86400; hour += 3600) {
          const { seal, sha } = verifiedLocalNetwork(hour); inputs.push(sha);
          for (const text of [seal.summary.senderIds, seal.summary.recipientIds]) for (const id of decodeIds(text)) add.run(id);
        }
        const count = target.db.prepare('SELECT COUNT(*) n FROM api_day_members').get().n;
        if (count !== day.active_addresses) fail('api_daily_membership_conflict');
        const valueSha = hash({ day: day.day_start, status: 'available', count }), inputsSha = hash(inputs);
        target.transaction(() => {
          const value = target.db.prepare('SELECT * FROM compact_daily_active_addresses WHERE day_start=?').get(day.day_start);
          if (value?.status !== 'available' || value.reason !== null || value.active_addresses !== count) fail('api_daily_membership_conflict');
          const prior = target.db.prepare('SELECT * FROM arc_pipeline_api_days WHERE day_start=?').get(day.day_start);
          if (prior && (prior.value_sha !== valueSha || prior.inputs_sha !== inputsSha)) fail('api_daily_membership_conflict');
          target.db.prepare('INSERT OR IGNORE INTO arc_pipeline_api_days VALUES(?,?,?)').run(day.day_start, valueSha, inputsSha);
          target.db.prepare('DELETE FROM compact_daily_address_stage WHERE day_start=?').run(day.day_start);
          target.db.prepare('DELETE FROM compact_daily_address_hours WHERE day_start=?').run(day.day_start);
        }, count * 80 + 65536);
        expired.finalizedDays++;
      } finally { target.db.exec('DROP TABLE api_day_members'); }
    }
    return expired;
  }

  function publish({ network: input, protocols = {}, dex = {}, projectionInputs = {}, repairCache = false, beforeCommit, afterCommit } = {}) {
    onProgress?.({ stage: 'publish:start', heapUsed: process.memoryUsage().heapUsed });
    const seal = input?.pipeline.getSeal(input.unitId);
    if (seal?.summary?.format !== 'arc-network-hour-v1') fail('api_verified_network_required');
    const n = seal.summary, u = input.pipeline.db.prepare('SELECT * FROM arc_pipeline_units WHERE unit_id=?').get(input.unitId);
    // Independently check the network seal as well as its generic checksum/coverage envelope.
    verifyNetworkSeal(input.pipeline.db, seal, u);
    const source = binding(input.pipeline, input.unitId, n);
    if (n.definitionVersion !== COMPACT_DEFINITION_VERSION || source.source.chainId !== 5042
      || source.source.id !== 'network' || source.source.originalDefinition !== COMPACT_DEFINITION_VERSION) fail('api_source_definition_conflict');
    if (sha256Of({ definitionVersion: n.definitionVersion, range: n.range, network: n.network }) !== n.canonicalSha256) fail('api_source_canonical_conflict');
    const families = Object.fromEntries(Object.entries(FAMILY_FIELDS).map(([name, fields]) => [name, {
      status: 'unavailable', reason: 'verified_pipeline_evidence_missing', ...Object.fromEntries(fields.map(f => [f, null])),
    }]));
    const evidence = { network: source };
    for (const [name, entry] of Object.entries(protocols)) {
      if (!Object.hasOwn(FAMILY_FIELDS, name) || ['uniswapV3', 'uniswapV4'].includes(name)) fail('api_family_adapter_missing');
      const b = binding(entry.pipeline, entry.unitId, n);
      if (b.sourceKey !== hash(protocolSource(name)) || b.source.originalVersion !== FAMILY_VERSIONS[name]) fail('api_source_definition_conflict');
      const metrics = deriveProtocolMetrics(entry.pipeline, entry.unitId, name);
      sumWindow(FAMILY_WINDOWS[name], [metrics]);
      if (!FAMILY_FIELDS[name].every(f => metrics[f] !== undefined && metrics[f] !== null)) fail('api_family_fields_missing');
      families[name] = { status: 'available', ...metrics }; evidence[name] = b;
    }
    let v3Registry;
    for (const [name, entry] of Object.entries(dex)) {
      const protocol = name === 'uniswapV3' ? 'uniswap_v3' : name === 'uniswapV4' ? 'uniswap_v4' : null;
      if (!protocol) fail('api_family_adapter_missing');
      const b = binding(entry.pipeline, entry.unitId, n), s = b.source;
      if (s.id !== protocol + '_family' || s.definition !== 'verified-dex-derived-family-v1'
        || s.originalVersion !== FAMILY_VERSIONS[name] || s.chainId !== 5042
        || !Array.isArray(s.dependencies) || !s.dependencies.length || s.dependencies.length > 4096) fail('api_source_definition_conflict');
      for (const dep of s.dependencies) {
        const d = binding(entry.pipeline, dep.unitId, n);
        if (d.sourceKey !== dep.sourceKey || hash(d.pieces) !== hash(dep.pieces)) fail('api_dex_dependency_conflict');
      }
      const rows = [...entry.pipeline.summaries(entry.unitId)];
      const r = rows[0]?.rows[0];
      if (rows.length !== 1 || rows[0].rows.length !== 1 || r?.kind !== 'verified_dex_family' || r.protocol !== protocol
        || r.definitionVersion !== FAMILY_VERSIONS[name] || hash(rows[0].counts) !== hash(r.metrics)) fail('api_dex_family_invalid');
      sumWindow(FAMILY_WINDOWS[name], [r.metrics]);
      if (!FAMILY_FIELDS[name].every(f => Number.isSafeInteger(r.metrics[f]) && r.metrics[f] >= 0)) fail('api_family_fields_missing');
      if (name === 'uniswapV3') {
        const factories = s.dependencies.filter(dep => JSON.parse(readDefinition(entry.pipeline.db.prepare('SELECT unit_json FROM arc_pipeline_units WHERE unit_id=?').get(dep.unitId).unit_json)).source.id === 'uniswap_v3_factory');
        if (factories.length !== 1) fail('api_dex_factory_evidence_missing');
        const factory = binding(entry.pipeline, factories[0].unitId, n), stream = LOG_STREAMS.find(s => s.key === 'v3Factory');
        if (factory.source.definition !== 'official-factory-sparse-evidence-v1' || factory.source.chainId !== 5042
          || hash(factory.source.stream) !== hash(stream) || factory.source.codeAtBlock !== n.range.lastBlock
          || !/^[0-9a-f]{64}$/.test(factory.source.codeSha ?? '')) fail('api_dex_factory_evidence_invalid');
        const created = [];
        for (const piece of entry.pipeline.summaries(factories[0].unitId)) for (const pool of piece.rows) {
          if (pool.kind !== 'official_v3_pool_created' || pool.sourceKey !== factories[0].sourceKey
            || !stream.address.includes(pool.emitter) || pool.createdBlock < n.range.firstBlock || pool.createdBlock > n.range.lastBlock) fail('api_dex_factory_evidence_invalid');
          created.push(pool);
        }
        if (created.length !== r.metrics.poolCreatedCount) fail('api_dex_factory_evidence_invalid');
        v3Registry = { through: n.range.lastBlock, throughHash: n.range.lastHash, created };
      }
      families[name] = { status: 'available', ...r.metrics }; evidence[name] = b;
    }
    const projectionBindings = Object.fromEntries(Object.entries(projectionInputs).map(([name,entry]) => {
      const protocol=name==='uniswapV3'?'uniswap_v3':name==='uniswapV4'?'uniswap_v4':null;
      if(!protocol||!dex[name])fail('api_projection_family_missing');
      const b=binding(entry.pipeline,entry.unitId,n);
      if(b.sourceKey!==hash(dexProjectionSource(protocol)))fail('api_projection_source_conflict');
      return [name+'_projections',b];
    }));
    const commitBinding = b => ({ unitId:b.unitId,sourceKey:b.sourceKey,registryDigest:b.registryDigest,
      piecesSha:hash(b.pieces),pieceCount:b.pieces.length });
    let projections, projectionMetadata;
    // A verified immutable publication and its exact row commitments can be reused. Recheck every
    // source piece via binding/coverage above; never regenerate large arrays to repair an unrelated family.
    if (Object.keys(projectionBindings).length) for (const saved of target.db.prepare(
      'SELECT manifest_json,manifest_sha FROM arc_pipeline_api_publications WHERE hour_start=? ORDER BY manifest_sha').iterate(n.hourStart)) {
      if(hash(saved.manifest_json)!==saved.manifest_sha)fail('api_publication_corrupt');
      const m=JSON.parse(saved.manifest_json);
      const keys=Object.keys(m.evidence).filter(k=>k.endsWith('_projections')).sort();
      if(m.canonicalSha!==n.canonicalSha256||json(keys)!==json(Object.keys(projectionBindings).sort())
        || keys.some(k=>json(m.evidence[k])!==json(commitBinding(projectionBindings[k])))||!m.projections)continue;
      const verified=Object.entries(m.projections).every(([key,expected])=>{
        if(expected.status!=='available')return true;
        const row=target.db.prepare('SELECT status,rows_sha256 FROM compact_projection_hours WHERE hour_start=? AND projection=?').get(n.hourStart,key);
        const body=target.db.prepare('SELECT body_sha FROM arc_pipeline_api_projection_copies WHERE hour_start=? AND projection=? AND rows_sha=?').get(n.hourStart,key,expected.sha);
        return row?.status==='available'&&row.rows_sha256===expected.sha&&body?.body_sha===projectionBodySha(target.db,n.hourStart,key);
      });
      if(verified){projectionMetadata=m.projections;break;}
    }
    Object.assign(evidence,projectionBindings);
    const activity=[];
    for(const [name,entry] of Object.entries(projectionMetadata ? {} : projectionInputs)) {
      const protocol=name==='uniswapV3'?'uniswap_v3':name==='uniswapV4'?'uniswap_v4':null;
      if(!protocol||!dex[name])fail('api_projection_family_missing');
      const b=binding(entry.pipeline,entry.unitId,n);
      if(b.sourceKey!==hash(dexProjectionSource(protocol)))fail('api_projection_source_conflict');
      onProgress?.({ stage: 'derive:' + protocol, heapUsed: process.memoryUsage().heapUsed });
      const derived=deriveDexUiProjections(entry.pipeline,entry.unitId);
      onProgress?.({ stage: 'derived:' + protocol, heapUsed: process.memoryUsage().heapUsed });
      const counters=protocol==='uniswap_v3'?['swapCount','mintCount','burnCount']:['swapCount','initializeCount','modifyLiquidityCount'];
      if(counters.some(k=>derived.family[k]!==families[name][k]))fail('api_projection_counts_conflict');
      projections??={};
      for(const [key,value]of Object.entries(derived.projections))if(key==='dex_activity')activity.push(...value.rows);else projections[key]=value;
      evidence[name+'_projections']=b;
    }
    if(projections){
      if(projectionInputs.uniswapV3&&projectionInputs.uniswapV4){
        const rows=ACTIVITY_KINDS.flatMap(kind=>activity.filter(row=>row.kind===kind).sort((a,b)=>b.blockNumber-a.blockNumber||b.logIndex-a.logIndex).slice(0,ACTIVITY_ROWS_PER_KIND))
          .sort((a,b)=>b.blockNumber-a.blockNumber||b.logIndex-a.logIndex);
        projections.dex_activity={status:'available',rows,rowsSha256:sha256Of({rows})};
      }else projections.dex_activity={status:'unavailable',reason:'projection_inputs_unavailable'};
    }
    // One hour of identities, not a full-window JS set. Exact daily distinct counts are finalized by the existing store.
    const addresses = new Set(), get = input.pipeline.db.prepare('SELECT lower(hex(address)) address FROM arc_pipeline_addresses WHERE id=?');
    for (const encoded of [n.senderIds, n.recipientIds]) for (const id of decodeIds(encoded)) {
      const a = get.get(id)?.address;
      if (!/^[0-9a-f]{40}$/.test(a ?? '')) fail('api_membership_missing');
      addresses.add('0x' + a);
      if (addresses.size % 1024 === 0) assertHeapBudget();
    }
    if (addresses.size !== n.network.uniqueActiveAddresses) fail('api_membership_mismatch');
    projectionMetadata ??= projections ? Object.fromEntries(Object.entries(projections).map(([key,value])=>[key,{status:value.status,sha:value.rowsSha256??null}])) : null;
    const commitments = Object.fromEntries(Object.entries(evidence).map(([name, b]) => [name, commitBinding(b)]));
    const activeAddresses = [...addresses].sort();
    const manifest = { definition: 'verified-pipeline-api-publication-v1', hour: n.hourStart, canonicalSha: n.canonicalSha256,
      activeAddressesSha: sha256Of(activeAddresses),
      range: n.range, evidence: commitments, ...(projectionMetadata?{projections:projectionMetadata}:{}), families: Object.fromEntries(Object.entries(families).map(([name, f]) => [name,
        f.status === 'available' ? { status: f.status, definition: FAMILY_VERSIONS[name], metricsSha: sha256Of(Object.fromEntries(FAMILY_FIELDS[name].map(k => [k, f[k]]))) }
          : { status: f.status, reason: f.reason }])) };
    const text = json(manifest), sha = hash(text);
    target.guard(Buffer.byteLength(text) + addresses.size * 80 + 65536);
    let repairedCopies = 0;
    if (repairCache) {
      // Repair only derived rows with an earlier immutable commitment exactly matching these reverified inputs.
      // A new source result or conflicting accepted fact cannot be used to overwrite the old commitment.
      const prior = target.db.prepare('SELECT * FROM arc_pipeline_api_publications WHERE hour_start=?').all(n.hourStart).map(row => {
        if (hash(row.manifest_json) !== row.manifest_sha) fail('api_publication_corrupt'); return JSON.parse(row.manifest_json);
      });
      if (!prior.some(m => m.canonicalSha === n.canonicalSha256 && m.activeAddressesSha === manifest.activeAddressesSha)) fail('api_repair_commitment_missing');
      const networkJson = canonicalText(n.network);
      const expected = { hour_start: n.hourStart, definition_version: n.definitionVersion, first_block: n.range.firstBlock,
        last_block: n.range.lastBlock, parent_hash: n.range.parentHash, first_hash: n.range.firstHash, last_hash: n.range.lastHash,
        block_count: n.network.blockCount, transaction_count: n.network.transactionCount,
        unique_active_addresses: n.network.uniqueActiveAddresses, network_json: networkJson, network_sha256: n.canonicalSha256 };
      target.transaction(() => {
        const checkpoint = target.db.prepare('SELECT * FROM compact_checkpoint WHERE id=1').get();
        if (!checkpoint || checkpoint.hour_start === n.hourStart && (checkpoint.last_block !== n.range.lastBlock || checkpoint.last_hash !== n.range.lastHash)) {
          fail('api_repair_checkpoint_conflict');
        }
        const log = (dataset, damaged, restored) => {
          target.db.prepare('INSERT INTO arc_pipeline_api_cache_repairs(hour_start,dataset,damaged_sha,restored_sha) VALUES(?,?,?,?)')
            .run(n.hourStart, dataset, hash(json(damaged)), restored); repairedCopies++;
        };
        const old = target.db.prepare('SELECT * FROM compact_hours WHERE hour_start=?').get(n.hourStart);
        if (hash(canonicalText(old ?? null)) !== hash(canonicalText(expected))) {
          log('network', old ?? null, hash(networkJson));
          target.db.prepare(`INSERT INTO compact_hours VALUES(?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(hour_start) DO UPDATE SET
            definition_version=excluded.definition_version,first_block=excluded.first_block,last_block=excluded.last_block,
            parent_hash=excluded.parent_hash,first_hash=excluded.first_hash,last_hash=excluded.last_hash,block_count=excluded.block_count,
            transaction_count=excluded.transaction_count,unique_active_addresses=excluded.unique_active_addresses,
            network_json=excluded.network_json,network_sha256=excluded.network_sha256`).run(...Object.values(expected));
        }
        for (const [name, f] of Object.entries(families)) {
          if (f.status !== 'available') continue;
          const metricsJson = canonicalText(Object.fromEntries(FAMILY_FIELDS[name].map(k => [k, f[k]]))), metricsSha = hash(metricsJson);
          const existing = target.db.prepare('SELECT * FROM compact_family_hours WHERE hour_start=? AND family=?').get(n.hourStart, name);
          const valid = existing?.status === 'available' && existing.reason === null && existing.metrics_sha256 === metricsSha && hash(existing.metrics_json) === metricsSha;
          if (valid) continue;
          if (!prior.some(m => m.families[name]?.status === 'available' && m.families[name].metricsSha === metricsSha)) fail('api_repair_commitment_missing');
          log(name, existing ?? null, metricsSha);
          target.db.prepare(`INSERT INTO compact_family_hours VALUES(?,?,'available',NULL,?,?) ON CONFLICT(hour_start,family)
            DO UPDATE SET status='available',reason=NULL,metrics_json=excluded.metrics_json,metrics_sha256=excluded.metrics_sha256`)
            .run(n.hourStart, name, metricsJson, metricsSha);
        }
        if (n.hourStart >= checkpoint.hour_start - 23 * 3600) {
          const saved = target.db.prepare('SELECT lower(hex(address)) a FROM compact_hour_addresses WHERE hour_start=? ORDER BY address').all(n.hourStart).map(r => '0x' + r.a);
          if (sha256Of(saved) !== manifest.activeAddressesSha) {
            log('hourly_membership_cache', saved, manifest.activeAddressesSha);
            target.db.prepare('DELETE FROM compact_hour_addresses WHERE hour_start=?').run(n.hourStart);
            const add = target.db.prepare('INSERT INTO compact_hour_addresses VALUES(?,?)');
            for (const address of activeAddresses) add.run(n.hourStart, Buffer.from(address.slice(2), 'hex'));
          }
        }
      }, Buffer.byteLength(text) + addresses.size * 80 + 65536);
    }
    onProgress?.({ stage: 'commit:start', heapUsed: process.memoryUsage().heapUsed });
    const outcome = store.commitHour({ chainId: 5042, definitionVersion: n.definitionVersion, range: n.range, network: n.network,
      activeAddresses, families, ...(projections?{projections}:{}), ...(v3Registry ? { registry: { uniswapV3: v3Registry } } : {}),
      complete: Object.values(families).every(f => f.status === 'available') }, {
      beforeCommit() {
        for(const [key,value]of Object.entries(projectionMetadata??{}))if(value.status==='available'){
          const stored=target.db.prepare('SELECT status,rows_sha256 FROM compact_projection_hours WHERE hour_start=? AND projection=?').get(n.hourStart,key);
          if(stored?.status!=='available'||stored.rows_sha256!==value.sha)fail('api_projection_storage_conflict');
          const bodySha=projectionBodySha(target.db,n.hourStart,key);
          target.db.prepare('INSERT OR IGNORE INTO arc_pipeline_api_projection_copies VALUES(?,?,?,?)').run(n.hourStart,key,value.sha,bodySha);
          if(target.db.prepare('SELECT body_sha FROM arc_pipeline_api_projection_copies WHERE hour_start=? AND projection=? AND rows_sha=?').get(n.hourStart,key,value.sha)?.body_sha!==bodySha)fail('api_projection_body_conflict');
        }
        target.db.prepare('INSERT OR IGNORE INTO arc_pipeline_api_publications VALUES(?,?,?)').run(n.hourStart, sha, text);
        const saved = target.db.prepare('SELECT manifest_json FROM arc_pipeline_api_publications WHERE hour_start=? AND manifest_sha=?').get(n.hourStart, sha);
        if (saved?.manifest_json !== text) fail('api_publication_conflict');
        target.guard(0); beforeCommit?.();
      },
    });
    onProgress?.({ stage: 'commit:end', heapUsed: process.memoryUsage().heapUsed });
    afterCommit?.();
    let readCacheExpiry = { skipped: 'authority_not_in_target_database' };
    if (input.pipeline === target) {
      try { readCacheExpiry = expireReadCaches(n.hourStart); }
      catch (error) { readCacheExpiry = { retainedOnFailure: true, reason: error.code ?? 'api_cache_expiry_failed' }; }
    }
    return { ...outcome, manifestSha: sha, hour: n.hourStart, availableFamilies: [...Object.keys(protocols), ...Object.keys(dex)],
      unavailableFamilies: Object.keys(families).filter(k => families[k].status !== 'available'), repairedCopies, readCacheExpiry, rpcRequests: 0 };
  }

  // Audit the derived cache against its immutable publication commitment, without reading RPC or changing evidence.
  function audit(hour, db = target.db) {
    const rows = db.prepare('SELECT * FROM arc_pipeline_api_publications WHERE hour_start=? ORDER BY manifest_sha').all(hour);
    if (!rows.length) fail('api_publication_missing');
    const issues = [], network = db.prepare('SELECT * FROM compact_hours WHERE hour_start=?').get(hour);
    for (const row of rows) {
      if (hash(row.manifest_json) !== row.manifest_sha) fail('api_publication_corrupt');
      const m = JSON.parse(row.manifest_json);
      const values = network ? JSON.parse(network.network_json) : null;
      if (!network || network.network_sha256 !== m.canonicalSha || network.definition_version !== COMPACT_DEFINITION_VERSION
        || network.first_block !== m.range.firstBlock || network.last_block !== m.range.lastBlock
        || network.first_hash !== m.range.firstHash || network.last_hash !== m.range.lastHash || network.parent_hash !== m.range.parentHash
        || network.block_count !== values.blockCount || network.transaction_count !== values.transactionCount
        || network.unique_active_addresses !== values.uniqueActiveAddresses
        || sha256Of({ definitionVersion: network.definition_version, range: m.range, network: values }) !== m.canonicalSha) {
        issues.push({ family: 'network', reason: 'api_network_missing_or_conflicting' });
      }
      const latest = db.prepare('SELECT hour_start FROM compact_checkpoint WHERE id=1').get()?.hour_start;
      if (hour >= latest - 23 * 3600) {
        const members = db.prepare('SELECT lower(hex(address)) a FROM compact_hour_addresses WHERE hour_start=? ORDER BY address').all(hour).map(r => '0x' + r.a);
        if (sha256Of(members) !== m.activeAddressesSha) issues.push({ family: 'network', reason: 'api_membership_missing_or_conflicting' });
      }
      for (const [name, expected] of Object.entries(m.families)) {
        // Old incomplete publications do not invalidate a later independently verified upgrade.
        if (expected.status !== 'available') continue;
        const f = db.prepare('SELECT * FROM compact_family_hours WHERE hour_start=? AND family=?').get(hour, name);
        if (!f || f.status !== 'available' || f.metrics_sha256 !== expected.metricsSha || hash(f.metrics_json ?? '') !== expected.metricsSha) {
          issues.push({ family: name, reason: 'api_family_missing_or_conflicting' });
        }
      }
      for(const [name,expected]of Object.entries(m.projections??{}))if(expected.status==='available'){
        const row=db.prepare('SELECT status,rows_sha256 FROM compact_projection_hours WHERE hour_start=? AND projection=?').get(hour,name);
        if(row?.status!=='available'||row.rows_sha256!==expected.sha)issues.push({projection:name,reason:'api_projection_missing_or_conflicting'});
        // Old capped activity is a regenerable read cache; the latest published hour must still match exactly.
        const latest=db.prepare('SELECT hour_start FROM compact_checkpoint WHERE id=1').get()?.hour_start;
        if(name!=='dex_activity'||hour===latest){
          const body=db.prepare('SELECT body_sha FROM arc_pipeline_api_projection_copies WHERE hour_start=? AND projection=? AND rows_sha=?').get(hour,name,expected.sha);
          if(!body||body.body_sha!==projectionBodySha(db,hour,name))issues.push({projection:name,reason:'api_projection_body_conflict'});
        }
      }
    }
    return { hour, ok: issues.length === 0, issues, productionAccess: false };
  }
  function readModel(options = {}) {
    let connection;
    class SnapshotDatabase {
      constructor(path, settings) { connection = new target.db.constructor(path, settings); return connection; }
    }
    return createCompactReadModel({ ...options, path: target.path, DatabaseSync: SnapshotDatabase,
      onSnapshotStarted() {
        // Check the exact read transaction used to build the API response. A concurrent writer cannot swap
        // verified and unverified snapshots between integrity validation and response construction.
        const bounds = connection.prepare('SELECT MAX(hour_start) last,COUNT(*) n FROM compact_hours').get();
        try{discoveryPublication.audit(connection);}catch{throw new ReadModelError('read_failed','api_discovery_integrity_failed');}
        for(const expected of connection.prepare('SELECT * FROM arc_pipeline_api_registry_copies').iterate()){
          const record=connection.prepare('SELECT * FROM compact_registry WHERE kind=? AND address=?').get(expected.kind,expected.address);
          if(!record||hash(json({...record}))!==expected.row_sha)throw new ReadModelError('read_failed','api_registry_integrity_failed');
        }
        if (!bounds.n) throw new ReadModelError('not_ready', 'no_checkpoint');
        for (const row of connection.prepare('SELECT hour_start FROM compact_hours WHERE hour_start>=? ORDER BY hour_start').iterate(bounds.last - 719 * 3600)) {
          if (!audit(row.hour_start, connection).ok) throw new ReadModelError('read_failed', 'api_cache_integrity_failed');
        }
        for (const d of connection.prepare('SELECT * FROM arc_pipeline_api_days WHERE day_start>=?').iterate(bounds.last - 720 * 3600)) {
          const fact = connection.prepare('SELECT * FROM compact_daily_active_addresses WHERE day_start=?').get(d.day_start);
          if (!fact || hash({ day: d.day_start, status: fact.status, count: fact.active_addresses }) !== d.value_sha) {
            throw new ReadModelError('read_failed', 'api_daily_integrity_failed');
          }
        }
        options.onSnapshotStarted?.();
      } });
  }
  function publishPoolWitnesses(source,{maxRecords=256,after='',beforeCommit}={}) {
    if(!source?.readOnly||!Number.isInteger(maxRecords)||maxRecords<1||maxRecords>256)fail('read_only_bounded_pool_witness_source_required');
    const rows=source.db.prepare('SELECT protocol,pool FROM arc_pipeline_pool_witnesses WHERE protocol||pool>? ORDER BY protocol,pool LIMIT ?').all(after,maxRecords);
    let inserted=0;
    target.transaction(()=>{
      for(const row of rows){
        const proof=readPoolWitness(source.db,row.protocol,row.pool),r=proof.record,ref=proof.canonicalReference;
        const canonical=target.db.prepare('SELECT * FROM compact_hours WHERE first_block=? AND last_block=?').get(ref.firstBlock,ref.lastBlock);
        if(!canonical||canonical.last_hash!==ref.lastHash||canonical.network_sha256!==ref.canonicalSha)fail('pool_witness_canonical_reference_conflict');
        const kind=row.protocol+'_pool',metadata=row.protocol==='uniswap_v3'
          ?{token0:r.token0,token1:r.token1,fee:r.fee,tickSpacing:r.tickSpacing}
          :{currency0:r.currency0,currency1:r.currency1,fee:r.fee,tickSpacing:r.tickSpacing,hooks:r.hooks};
        const expected={kind,address:row.pool,created_block:r.createdBlock,created_log_index:r.createdLogIndex,
          created_tx:r.createdTx,meta_json:canonicalText(metadata)};
        const old=target.db.prepare('SELECT * FROM compact_registry WHERE kind=? AND address=?').get(kind,row.pool);
        if(old){if(old.created_block!==expected.created_block||old.created_log_index!==expected.created_log_index
          ||old.created_tx!==expected.created_tx||canonicalText(JSON.parse(old.meta_json))!==expected.meta_json)fail('pool_witness_registry_conflict');}
        else {target.db.prepare('INSERT INTO compact_registry VALUES(?,?,?,?,?,?)').run(...Object.values(expected));inserted++;}
        const copy=target.db.prepare('SELECT * FROM compact_registry WHERE kind=? AND address=?').get(kind,row.pool),sha=hash(json({...copy}));
        target.db.prepare('INSERT OR IGNORE INTO arc_pipeline_api_registry_copies VALUES(?,?,?,?)').run(kind,row.pool,sha,proof.proofSha);
        if(target.db.prepare('SELECT row_sha FROM arc_pipeline_api_registry_copies WHERE kind=? AND address=?').get(kind,row.pool)?.row_sha!==sha)fail('pool_witness_registry_conflict');
      }
      beforeCommit?.();
    },rows.length*4096+65536);
    // Witnesses qualify individual pools only. Never move canonical/intelligence checkpoints or registry coverage.
    return{checked:rows.length,inserted,after:rows.length?rows.at(-1).protocol+rows.at(-1).pool:after,hasMore:rows.length===maxRecords,
      globalRegistryCoverageChanged:false,canonicalCheckpointChanged:false,rpcRequests:0};
  }
  function reconcile(resolveInputs, { afterHour = -1, maxHours = 4 } = {}) {
    if (typeof resolveInputs !== 'function' || !Number.isSafeInteger(afterHour) || !Number.isSafeInteger(maxHours) || maxHours < 1 || maxHours > 4) fail('api_reconcile_budget_invalid');
    const hours = target.db.prepare('SELECT DISTINCT hour_start FROM arc_pipeline_api_publications WHERE hour_start>? ORDER BY hour_start LIMIT ?').all(afterHour, maxHours);
    const results = [];
    for (const row of hours) {
      let state;
      try { state = audit(row.hour_start); } catch (e) { state = { ok: false, reason: e.code ?? 'api_cache_invalid' }; }
      if (state.ok) { results.push({ hour: row.hour_start, status: 'verified', rpcRequests: 0 }); continue; }
      try {
        publish({ ...resolveInputs(row.hour_start), repairCache: true });
        if (!audit(row.hour_start).ok) fail('api_cache_repair_incomplete');
        results.push({ hour: row.hour_start, status: 'repaired', rpcRequests: 0 });
      } catch (e) { results.push({ hour: row.hour_start, status: 'blocked', reason: e.code ?? 'api_cache_repair_failed' }); }
    }
    return { results, afterHour: hours.at(-1)?.hour_start ?? afterHour, scannedHours: hours.length, automaticActivation: false };
  }
  function reconcileDays(resolveNetwork = hour => {
    const { seal } = verifiedLocalNetwork(hour);
    const unit = target.db.prepare('SELECT unit_id FROM arc_pipeline_units WHERE hour_start=? AND source_key=?').get(hour,seal.sourceKey);
    return { pipeline: target, unitId: unit?.unit_id };
  }, { afterDay = -1, maxDays = 1, beforeCommit, afterCommit } = {}) {
    if (typeof resolveNetwork !== 'function' || !Number.isSafeInteger(afterDay) || maxDays !== 1) fail('api_daily_reconcile_budget_invalid');
    const days = target.db.prepare('SELECT * FROM arc_pipeline_api_days WHERE day_start>? ORDER BY day_start LIMIT 1').all(afterDay);
    const results = [];
    for (const day of days) {
      const fact = target.db.prepare('SELECT * FROM compact_daily_active_addresses WHERE day_start=?').get(day.day_start);
      if (fact?.reason === null && hash({ day: day.day_start, status: fact.status, count: fact.active_addresses }) === day.value_sha) {
        results.push({ day: day.day_start, status: 'verified', rpcRequests: 0 }); continue;
      }
      target.db.exec('CREATE TEMP TABLE api_repair_day_members(address BLOB PRIMARY KEY CHECK(length(address)=20)) STRICT,WITHOUT ROWID');
      try {
        const add = target.db.prepare('INSERT OR IGNORE INTO api_repair_day_members VALUES(?)'), inputs = [];
        let inserted = 0;
        for (let hour = day.day_start; hour < day.day_start + 86400; hour += 3600) {
          const input = resolveNetwork(hour), seal = input?.pipeline.getSeal(input.unitId);
          const unit = input?.pipeline.db.prepare('SELECT * FROM arc_pipeline_units WHERE unit_id=?').get(input.unitId);
          if (!seal || seal.summary.hourStart !== hour) fail('api_daily_source_missing');
          verifyNetworkSeal(input.pipeline.db, seal, unit);
          const manifests = target.db.prepare('SELECT manifest_json,manifest_sha FROM arc_pipeline_api_publications WHERE hour_start=?').all(hour);
          if (!manifests.some(row => hash(row.manifest_json) === row.manifest_sha
            && JSON.parse(row.manifest_json).canonicalSha === seal.summary.canonicalSha256)) fail('api_daily_source_conflict');
          inputs.push(seal.summary.canonicalSha256);
          const get = input.pipeline.db.prepare('SELECT address FROM arc_pipeline_addresses WHERE id=?');
          for (const text of [seal.summary.senderIds,seal.summary.recipientIds]) for (const id of decodeIds(text)) {
            const address = get.get(id)?.address;
            if (!address || address.length !== 20) fail('api_daily_source_missing');
            inserted += add.run(address).changes;
            if (inserted * 80 > 32 * 1024 * 1024) fail('api_daily_scratch_budget');
            if (inserted % 1024 === 0) target.guard(inserted * 80 + 65536);
          }
        }
        const valueSha = hash({ day: day.day_start, status: 'available', count: inserted });
        if (hash(inputs) !== day.inputs_sha || valueSha !== day.value_sha) fail('api_daily_commitment_conflict');
        const checkpoint = json(target.db.prepare('SELECT * FROM compact_checkpoint WHERE id=1').get());
        target.transaction(() => {
          const locked = target.db.prepare('SELECT * FROM arc_pipeline_api_days WHERE day_start=?').get(day.day_start);
          if (locked?.value_sha !== valueSha || locked.inputs_sha !== day.inputs_sha) fail('api_daily_commitment_conflict');
          const damaged = target.db.prepare('SELECT * FROM compact_daily_active_addresses WHERE day_start=?').get(day.day_start);
          target.db.prepare('INSERT INTO arc_pipeline_api_cache_repairs(hour_start,dataset,damaged_sha,restored_sha) VALUES(?,?,?,?)')
            .run(day.day_start,'daily_active_addresses',hash(json(damaged ?? null)),valueSha);
          target.db.prepare('DELETE FROM compact_daily_active_addresses WHERE day_start=?').run(day.day_start);
          target.db.prepare("INSERT INTO compact_daily_active_addresses(day_start,status,reason,active_addresses) VALUES(?,'available',NULL,?)").run(day.day_start,inserted);
          if (json(target.db.prepare('SELECT * FROM compact_checkpoint WHERE id=1').get()) !== checkpoint) fail('api_daily_checkpoint_conflict');
          beforeCommit?.();
        });
        afterCommit?.();
        results.push({ day: day.day_start, status: 'repaired', count: inserted, rpcRequests: 0 });
      } catch (error) { results.push({ day: day.day_start, status: 'blocked', reason: error.code ?? error.message ?? 'api_daily_repair_failed' }); }
      finally { target.db.exec('DROP TABLE api_repair_day_members'); }
    }
    return { results, afterDay: days.at(-1)?.day_start ?? afterDay, automaticActivation: false };
  }
  return { publish, publishPoolWitnesses, audit, readModel, reconcile, reconcileDays };
}
