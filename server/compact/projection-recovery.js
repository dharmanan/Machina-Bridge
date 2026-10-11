// Opt-in continuation of the existing single-hour compact projection repair. No scheduler,
// canonical database, transaction-body archive or public read-model is added here.
import { getHeapStatistics } from 'node:v8';
import { createHash } from 'node:crypto';
import { decodeV3Swap, decodeV3Mint, decodeV3Burn, decodeV4Swap, decodeV4ModifyLiquidity, decodeV4Initialize,
  UNISWAP_EVENT_TOPICS, UNISWAP_REGISTRY } from '../../api/_lib/arc-intelligence/uniswap.js';
import { createProjectionSink, canonicalJson, sha256Of, PROJECTION_VERSIONS, VALUATION_INPUTS_OF_POOLS, validV4Record, v4PoolRecordOf,
  validPoolRow, validPricePathRow, validSwapFeeRow, reconcilePoolRows, reconcilePricePaths } from './projections.js';
import { PROJECTION_BACKFILL_STREAMS, readProjectionRepairInput } from './projection-backfill.js';
import { appendRecoverySlice, recoverySliceProgress, recoverySliceUsage, SLICE_PROGRESS_VERSION, spineStorageUsage } from './discovery-spine-progress.js';
import { archiveConfig, storagePreflight } from './evidence-archive.js';
import { COMPACT_DEFINITION_VERSION, FAMILY_VERSIONS } from './sources.js';
import { readScopedPoolWitness, validateScopedPoolWitness, POOL_WITNESS_VERSION } from './registry.js';
import { validateLogs, streamLogs } from './logs.js';
import { headerOf } from './spine.js';
import { collectPoolTvl, TVL_REASONS } from './tvl.js';
import { VALUATION_VERSIONS } from './valuation.js';

const MiB = 1024 * 1024;
const VERSION = 'compact-projection-continuation-v1';
const hex = n => `0x${n.toString(16)}`;
const fail = code => { throw Object.assign(new Error(code), { code }); };
const tx = (db, fn) => {
  db.exec('BEGIN IMMEDIATE');
  try { const value = fn(); db.exec('COMMIT'); return value; } catch (error) { db.exec('ROLLBACK'); throw error; }
};
const decoders = {
  uniswap_v3: { [UNISWAP_EVENT_TOPICS.v3Swap]: ['swap', decodeV3Swap], [UNISWAP_EVENT_TOPICS.v3Mint]: ['mint', decodeV3Mint],
    [UNISWAP_EVENT_TOPICS.v3Burn]: ['burn', decodeV3Burn] },
  uniswap_v4: { [UNISWAP_EVENT_TOPICS.v4Swap]: ['swap', decodeV4Swap], [UNISWAP_EVENT_TOPICS.v4ModifyLiquidity]: ['modify', decodeV4ModifyLiquidity],
    [UNISWAP_EVENT_TOPICS.v4Initialize]: ['initialize', decodeV4Initialize] },
};

export function projectionRecoveryConfig(env = process.env) {
  if (!['', 'false', 'true'].includes(env.COMPACT_DEX_INPUT_RECOVERY_ENABLED ?? '')) fail('invalid_dex_input_recovery_enabled');
  const config = archiveConfig(env);
  return { ...config, enabled: env.COMPACT_DEX_INPUT_RECOVERY_ENABLED === 'true',
    maxArchiveBytes: Math.min(config.maxArchiveBytes, 512 * MiB), maxDatabaseBytes: Math.min(config.maxDatabaseBytes, 5_000_000_000) };
}

// All retained facts share the existing Discovery/archive accounting. A small immutable fact
// cache prevents repeat eth_calls/state probes, including interrupted TVL reads. Headers and
// full eth_getLogs replies are NOT cached; only a single sparse birth event is retained.
function facts(db, h, cp, definition, config, capacity) {
  const familyRows = db.prepare('SELECT * FROM compact_family_hours WHERE hour_start=? ORDER BY family').all(h.hour_start);
  const versionKeys = [...Object.keys(FAMILY_VERSIONS).map(key => 'family_version:' + key),
    ...Object.keys(PROJECTION_VERSIONS).map(key => 'projection_version:' + key), ...Object.keys(VALUATION_VERSIONS).map(key => 'valuation_version:' + key)];
  const versionQuery = db.prepare(`SELECT key,value FROM compact_meta WHERE key IN (${versionKeys.map(() => '?').join(',')}) ORDER BY key`);
  const versionRows = versionQuery.all(...versionKeys);
  const binding = { version: VERSION, hour: h.network_sha256, definitionSha: sha256Of(definition) },
    prefix = `compact_dex_fact:${h.hour_start}:`;
  const guard = plannedBytes => {
    if (canonicalJson(db.prepare('SELECT * FROM compact_hours WHERE hour_start=?').get(h.hour_start)) !== canonicalJson(h)
      || canonicalJson(db.prepare('SELECT * FROM compact_checkpoint WHERE id=1').get()) !== canonicalJson(cp)
      || canonicalJson(db.prepare('SELECT * FROM compact_family_hours WHERE hour_start=? ORDER BY family').all(h.hour_start)) !== canonicalJson(familyRows)
      || canonicalJson(versionQuery.all(...versionKeys)) !== canonicalJson(versionRows)) fail('projection_canonical_changed');
    const status = storagePreflight(db, config, { capacity, plannedBytes });
    if (!status.ok) fail(status.reason);
    if (recoverySliceUsage(db).bytes + spineStorageUsage(db).bytes + archiveUsage(db).bytes >= config.maxArchiveBytes) fail('projection_storage_budget');
  };
  const read = key => {
    const row = db.prepare('SELECT CASE WHEN length(CAST(value AS BLOB))<=131072 THEN value END value FROM compact_meta WHERE key=?').get(key);
    if (!row) return null;
    if (!row.value) fail('projection_fact_size_limit');
    let body;
    try { body = JSON.parse(row.value); } catch { fail('projection_fact_corrupt'); }
    const { checksum, ...value } = body;
    if (checksum !== sha256Of(value) || canonicalJson(value.binding) !== canonicalJson(binding)) fail('projection_fact_corrupt');
    return value;
  };
  const save = (key, value) => {
    const existing = read(key);
    if (existing) { if (canonicalJson(existing.value) !== canonicalJson(value)) fail('projection_fact_conflict'); return; }
    const body = { binding, value }, text = canonicalJson({ ...body, checksum: sha256Of(body) });
    if (Buffer.byteLength(text) > 131072) fail('projection_fact_size_limit');
    guard(Buffer.byteLength(text) + 65536);
    const usage = recoverySliceUsage(db), legacy = spineStorageUsage(db), archive = archiveUsage(db);
    const savedUsage = db.prepare('SELECT value FROM compact_meta WHERE key=?').get('compact_dex_fact_usage');
    let own = { bytes: 0 };
    if (savedUsage) {
      try { const { checksum, ...body } = JSON.parse(savedUsage.value);
        if (checksum !== sha256Of(body) || body.version !== VERSION || !Number.isSafeInteger(body.bytes) || body.bytes < 0) throw new Error();
        own = body;
      } catch { fail('projection_usage_corrupt'); }
    } else if (db.prepare("SELECT 1 FROM compact_meta WHERE key>='compact_dex_fact:' AND key<'compact_dex_fact;' LIMIT 1").get()) fail('projection_usage_corrupt');
    if (usage.bytes < own.bytes) fail('projection_usage_corrupt');
    const bytes = usage.bytes + Buffer.byteLength(text), dayStart = Math.floor(Date.now() / 86400000) * 86400;
    const dayBytes = (usage.dayStart === dayStart ? usage.dayBytes : 0) + Buffer.byteLength(text);
    if (bytes + legacy.bytes + archive.bytes > config.maxArchiveBytes
      || dayBytes + (legacy.dayStart === dayStart ? legacy.dayBytes : 0) + archive.dayBytes > config.maxDailyBytes) fail('projection_storage_budget');
    db.exec(`CREATE TRIGGER IF NOT EXISTS compact_dex_fact_no_update BEFORE UPDATE ON compact_meta
      WHEN OLD.key GLOB 'compact_dex_fact:*' BEGIN SELECT RAISE(ABORT,'immutable_projection_fact'); END;
      CREATE TRIGGER IF NOT EXISTS compact_dex_fact_no_delete BEFORE DELETE ON compact_meta
      WHEN OLD.key GLOB 'compact_dex_fact:*' BEGIN SELECT RAISE(ABORT,'immutable_projection_fact'); END;
      CREATE TRIGGER IF NOT EXISTS compact_dex_fact_no_replace BEFORE INSERT ON compact_meta
      WHEN NEW.key GLOB 'compact_dex_fact:*' AND EXISTS(SELECT 1 FROM compact_meta WHERE key=NEW.key)
      BEGIN SELECT RAISE(ABORT,'immutable_projection_fact'); END;`);
    db.prepare('INSERT INTO compact_meta VALUES(?,?)').run(key, text);
    db.prepare('INSERT INTO compact_meta VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
      .run('discovery_slice_usage', canonicalJson({ version: SLICE_PROGRESS_VERSION, bytes, dayStart, dayBytes }));
    const ownBody = { version: VERSION, bytes: own.bytes + Buffer.byteLength(text) };
    db.prepare('INSERT INTO compact_meta VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
      .run('compact_dex_fact_usage', canonicalJson({ ...ownBody, checksum: sha256Of(ownBody) }));
    read(key);
  };
  const keyOf = key => prefix + sha256Of(key);
  return { guard, read: key => read(keyOf(key))?.value ?? null,
    save: (key, value) => save(keyOf(key), value),
    async cached(key, producer) {
      const keyText = keyOf(key), existing = read(keyText);
      if (existing) return existing.value;
      guard(256 * 1024);
      const value = await producer();
      tx(db, () => save(keyText, value)); return value;
    } };
}
function archiveUsage(db) {
  const row = db.prepare('SELECT * FROM compact_evidence_archive_usage WHERE id=1').get();
  return { bytes: row?.stored_bytes ?? 0, dayBytes: row?.day_start === Math.floor(Date.now() / 86400000) * 86400 ? row.day_bytes : 0 };
}

async function boundaries(provider, h) {
  const numbers = [h.first_block - 1, h.first_block, h.last_block, h.last_block + 1];
  const blocks = await provider.batch(numbers.map(n => ['eth_getBlockByNumber', [hex(n), false]]));
  const [before, first, last, after] = blocks.map((raw, i) => headerOf(raw, numbers[i]));
  if (before.hash !== h.parent_hash || first.hash !== h.first_hash || last.hash !== h.last_hash
    || first.parentHash !== before.hash || after.parentHash !== last.hash || before.timestamp >= h.hour_start
    || first.timestamp < h.hour_start || last.timestamp >= h.hour_start + 3600 || after.timestamp < h.hour_start + 3600) fail('projection_boundary_mismatch');
  const range = { kind: 'hour', hourStart: h.hour_start, hourEnd: h.hour_start + 3600,
    startUtc: new Date(h.hour_start * 1000).toISOString(), endUtc: new Date((h.hour_start + 3600) * 1000).toISOString(),
    firstBlock: h.first_block, lastBlock: h.last_block, parentHash: h.parent_hash, firstHash: h.first_hash, lastHash: h.last_hash,
    firstTimestamp: first.timestamp, lastTimestamp: last.timestamp };
  if (sha256Of({ definitionVersion: h.definition_version, range, network: JSON.parse(h.network_json) }) !== h.network_sha256) fail('projection_network_digest_mismatch');
}

function verifyStoredInputs(db, store, hour) {
  for (const protocol of ['uniswap_v3', 'uniswap_v4']) {
    const family = hour.families[protocol === 'uniswap_v3' ? 'uniswapV3' : 'uniswapV4'];
    const pools = store.poolHours(hour.hourStart, protocol), paths = store.pricePaths(hour.hourStart, protocol);
    const range = { firstBlock: hour.firstBlock, lastBlock: hour.lastBlock };
    for (const name of [protocol + '_pools', ...VALUATION_INPUTS_OF_POOLS[protocol + '_pools']]) {
      const status = store.projectionStatus(hour.hourStart).find(row => row.projection === name);
      if (status?.status !== 'available') continue;
      let rows, payload, reason;
      if (name.endsWith('_pools')) {
        rows = pools;
        const registry = protocol === 'uniswap_v4' ? db.prepare(`SELECT * FROM compact_registry WHERE kind='uniswap_v4_pool'
          AND created_block BETWEEN ? AND ? ORDER BY created_block,created_log_index`).all(hour.firstBlock, hour.lastBlock).map(row => ({
          poolId: row.address, createdBlock: row.created_block, createdLogIndex: row.created_log_index, createdTx: row.created_tx, ...JSON.parse(row.meta_json) })) : null;
        if (!rows.every(row => validPoolRow(row, protocol)) || registry && !registry.every(validV4Record)) fail('projection_stored_input_corrupt');
        payload = registry ? { rows, registry } : { rows };
        reason = reconcilePoolRows(name, rows, family, { initializeCount: registry?.length ?? null });
      } else {
        rows = name.endsWith('_price_paths') ? paths : store.swapFees(hour.hourStart);
        if (!rows.every(row => name.endsWith('_price_paths') ? validPricePathRow(row, protocol, range) : validSwapFeeRow(row))) fail('projection_stored_input_corrupt');
        payload = { rows }; reason = reconcilePricePaths(rows, family, hour.projections[protocol + '_pools'] === 'available' ? pools : null);
      }
      if (family.status !== 'available' || reason || rows.length !== status.rowCount || sha256Of(payload) !== status.rowsSha256) fail('projection_stored_input_corrupt');
    }
  }
}

// Explicitly called only by the existing single-hour repair child. Provider must enforce the
// existing hard HTTP/call/response/time budgets; canContinue is a conservative admission check.
export async function recoverProjectionInputs({ db, store, provider, hourStart, config = projectionRecoveryConfig(), capacity,
  maxSlices = 512, afterSlice = () => {}, beforeCommit = () => {} }) {
  if (!config.enabled) return { phase: 'disabled', outcomes: {} };
  if (getHeapStatistics().heap_size_limit > 64 * MiB) fail('projection_heap_budget');
  if (!provider?.canContinue || !Number.isInteger(maxSlices) || maxSlices < 1 || maxSlices > 512) fail('bounded_projection_provider_required');
  const input = readProjectionRepairInput(db, hourStart), h = db.prepare('SELECT * FROM compact_hours WHERE hour_start=?').get(hourStart),
    cp = db.prepare('SELECT * FROM compact_checkpoint WHERE id=1').get();
  if (!h || h.definition_version !== COMPACT_DEFINITION_VERSION || !cp || hourStart > cp.hour_start
    || hourStart < cp.hour_start - 719 * 3600 || h.last_block - h.first_block + 1 > 15000
    || ![h.first_block, h.last_block].every(n => Number.isSafeInteger(n) && n >= 1) || h.last_block < h.first_block
    || ![h.parent_hash, h.first_hash, h.last_hash].every(v => /^0x[0-9a-f]{64}$/.test(v))) fail('projection_hour_outside_window');
  const namesOf = protocol => [protocol + '_pools', ...VALUATION_INPUTS_OF_POOLS[protocol + '_pools']];
  const definition = { version: VERSION, witness: POOL_WITNESS_VERSION,
    sources: UNISWAP_REGISTRY, family: FAMILY_VERSIONS, projections: PROJECTION_VERSIONS };
  for (const [key, expected] of Object.entries(PROJECTION_VERSIONS)) {
    if (db.prepare('SELECT value FROM compact_meta WHERE key=?').get('projection_version:' + key)?.value !== expected) fail('projection_definition_mismatch');
  }
  for (const family of ['uniswapV3', 'uniswapV4']) {
    if (db.prepare('SELECT value FROM compact_meta WHERE key=?').get('family_version:' + family)?.value !== FAMILY_VERSIONS[family]) fail('projection_definition_mismatch');
    const row = db.prepare('SELECT * FROM compact_family_hours WHERE hour_start=? AND family=?').get(hourStart, family);
    if (row?.status === 'available' && createHash('sha256').update(row.metrics_json).digest('hex') !== row.metrics_sha256) fail('projection_family_corrupt');
  }
  verifyStoredInputs(db, store, input.hour);
  for (const protocol of ['uniswap_v3', 'uniswap_v4']) for (const row of store.poolTvl(hourStart, protocol)) {
    if (row.blockNumber !== h.last_block || !['available', 'unavailable'].includes(row.status)
      || (row.status === 'available' ? ![row.amount0Raw, row.amount1Raw].every(v => typeof v === 'string' && /^(0|[1-9][0-9]*)$/.test(v))
        : !TVL_REASONS.includes(row.reason))) fail('projection_stored_tvl_corrupt');
  }
  const cache = facts(db, h, cp, definition, config, capacity), report = { phase: 'complete', outcomes: {}, ranges: 0, blocked: {} };
  const needs = ['uniswap_v3', 'uniswap_v4'].filter(protocol => namesOf(protocol).some(name => input.hour.projections[name] !== 'available'));
  const references = [];
  for (const protocol of ['uniswap_v3', 'uniswap_v4']) {
    const paths = new Map(store.pricePaths(hourStart, protocol).map(row => [row.pool, row.firstSwapBlock]));
    for (const row of store.poolHours(hourStart, protocol)) references.push({ protocol, pool: row.pool, atBlock: paths.get(row.pool) ?? h.first_block });
  }
  const missingIdentities = references.filter(({ protocol, pool }) => !db.prepare('SELECT 1 FROM compact_registry WHERE kind=? AND address=?')
    .get(protocol === 'uniswap_v3' ? 'uniswap_v3_pool' : 'uniswap_v4_pool', pool));
  for (const reference of references.filter(row => !missingIdentities.includes(row))) await poolIdentity(reference.protocol, reference.pool, reference.atBlock);
  const needsTvl = () => ['uniswap_v3', 'uniswap_v4'].some(protocol => {
    const verified = new Set(store.poolTvl(hourStart, protocol).filter(row => row.status === 'available').map(row => row.pool));
    return store.topPoolsOf(protocol, hourStart, 10).some(row => !verified.has(row.pool));
  });
  if (!needs.length && !needsTvl() && !missingIdentities.length) { cache.guard(65536); store.rederiveValuations(hourStart); return report; }
  // FULL durability only on this bounded child; live indexing's settings are unchanged.
  db.exec('PRAGMA synchronous=FULL; PRAGMA cache_size=-2048; PRAGMA temp_store=FILE;');
  cache.guard(8 * MiB);
  await boundaries(provider, h);
  for (const { protocol, pool, atBlock } of missingIdentities) {
    if (!await poolIdentity(protocol, pool, atBlock)) fail('projection_stored_pool_unverified');
  }
  async function poolIdentity(protocol, pool, block) {
    const row = db.prepare('SELECT * FROM compact_registry WHERE kind=? AND address=?')
      .get(protocol === 'uniswap_v3' ? 'uniswap_v3_pool' : 'uniswap_v4_pool', pool);
    if (row) {
      let meta; try { meta = JSON.parse(row.meta_json); } catch { fail('projection_registry_invalid'); }
      if (!Number.isSafeInteger(row.created_block) || row.created_block > block || !/^0x[0-9a-f]{64}$/.test(row.created_tx)
        || !Number.isSafeInteger(row.created_log_index) || row.created_log_index < 0) fail('projection_registry_invalid');
      if (protocol === 'uniswap_v4') {
        if (!validV4Record({ poolId: pool, createdBlock: row.created_block, createdLogIndex: row.created_log_index, createdTx: row.created_tx, ...meta })) fail('projection_registry_invalid');
      } else if (![meta.token0, meta.token1].every(v => /^0x[0-9a-f]{40}$/.test(v))
        || !Number.isSafeInteger(meta.fee) || meta.fee < 0 || meta.fee > 1000000 || !Number.isSafeInteger(meta.tickSpacing)) fail('projection_registry_invalid');
      const proof = cache.read(['witness', protocol, pool]);
      if (proof) {
        const accepted = validateScopedPoolWitness(proof, protocol, pool, block);
        const expected = { ...(protocol === 'uniswap_v3' ? { address: pool } : { poolId: pool }), createdBlock: row.created_block,
          createdLogIndex: row.created_log_index, createdTx: row.created_tx, ...meta };
        if (canonicalJson(accepted) !== canonicalJson(expected)) fail('projection_registry_conflict');
      }
      return true;
    }
    const saved = cache.read(['witness', protocol, pool]);
    const proof = saved ?? await readScopedPoolWitness(provider, { protocol, pool, atBlock: block, cached: cache.cached });
    if (proof === null) return false;
    validateScopedPoolWitness(proof, protocol, pool, block);
    store.recordPoolWitness(protocol, pool, block, proof, { beforeCommit: () => { cache.guard(65536); cache.save(['witness', protocol, pool], proof); } });
    return true;
  }
  for (const protocol of needs) {
    const family = protocol === 'uniswap_v3' ? 'uniswapV3' : 'uniswapV4', names = namesOf(protocol);
    if (input.hour.families[family].status !== 'available') { report.blocked[protocol] = 'family_unavailable'; continue; }
    const unit = { id: sha256Of({ domain: VERSION, protocol }), definition: { version: VERSION, witness: POOL_WITNESS_VERSION,
      sourceSha: sha256Of(UNISWAP_REGISTRY), familyVersion: FAMILY_VERSIONS[family],
      projectionsSha: sha256Of(Object.fromEntries(names.map(name => [name, PROJECTION_VERSIONS[name]]))),
      familySha: db.prepare('SELECT metrics_sha256 FROM compact_family_hours WHERE hour_start=? AND family=?').get(hourStart, family).metrics_sha256 } };
    let progress = recoverySliceProgress(db, h, unit);
    if (progress.state && (!Number.isSafeInteger(progress.state.transactionCount) || progress.state.transactionCount < 0
      || progress.state.transactionCount > h.transaction_count)) fail('projection_checkpoint_invalid');
    let transactionCount = progress.state?.transactionCount ?? 0;
    const sink = createProjectionSink({ activity: false, checkpoint: progress.state?.reducer ?? null });
    const widthFact = db.prepare('SELECT value FROM compact_meta WHERE key=?').get(`compact_dex_width:${hourStart}:${protocol}`);
    let width = widthFact ? Number(widthFact.value) : 32;
    if (![1, 2, 4, 8, 16, 32].includes(width)) fail('projection_slice_width_invalid');
    while (progress.nextBlock <= h.last_block && report.ranges < maxSlices && provider.canContinue(40)) {
      const first = progress.nextBlock, last = Math.min(h.last_block, first + width - 1), stream = PROJECTION_BACKFILL_STREAMS[protocol + '_pools'];
      cache.guard(8 * MiB);
      try {
        const rawLogs = [];
        let logBytes = 0;
        for await (const raw of streamLogs(provider, { ...stream, maxRange: width }, first, last)) {
          logBytes += Buffer.byteLength(canonicalJson(raw));
          if (logBytes > 4 * MiB || rawLogs.length + raw.length > 8000) fail('projection_slice_size_limit');
          for (const log of raw) rawLogs.push(log);
        }
        const numbers = Array.from({ length: last - first + 1 }, (_, i) => first + i), window = new Map();
        let previous = progress.lastHash, timestamp = progress.lastTimestamp, sliceTransactions = 0;
        // Hash-only headers, never full transaction bodies; at most 32 blocks, adaptively smaller.
        const rawBlocks = await provider.batch(numbers.map(n => ['eth_getBlockByNumber', [hex(n), false]]));
        rawBlocks.forEach((raw, i) => {
          const block = headerOf(raw, numbers[i]);
          if (block.parentHash !== previous || block.timestamp < timestamp || block.timestamp < hourStart || block.timestamp >= hourStart + 3600
            || block.number === h.first_block && block.hash !== h.first_hash || block.number === h.last_block && block.hash !== h.last_hash
            || !Array.isArray(raw.transactions) || !raw.transactions.every(v => /^0x[0-9a-f]{64}$/i.test(v))
            || new Set(raw.transactions.map(v => v.toLowerCase())).size !== raw.transactions.length) fail('projection_slice_block_invalid');
          window.set(block.number, { ...block, txHashes: raw.transactions.map(v => v.toLowerCase()) });
          sliceTransactions += raw.transactions.length;
          previous = block.hash; timestamp = block.timestamp;
        });
        const logs = validateLogs(rawLogs, stream, { fromBlock: first, toBlock: last, window, seen: new Set() });
        for (const log of logs) {
          if (protocol === 'uniswap_v3' && !await poolIdentity(protocol, log.address, log.blockNumber)) continue;
          const [kind, decode] = decoders[protocol][log.topics[0]], event = decode(log);
          if (!event) fail('projection_event_invalid');
          if (protocol === 'uniswap_v3') {
            sink.v3(kind, log, event, null);
          } else {
            if (kind === 'initialize') {
              const raw = rawLogs.find(value => value.blockHash.toLowerCase() === log.blockHash && Number(BigInt(value.logIndex)) === log.logIndex);
              const record = v4PoolRecordOf(log);
              const body = { version: POOL_WITNESS_VERSION, protocol, record, blockHash: log.blockHash,
                transactionMembershipVerified: true, event: { ...raw, removed: false } };
              const proof = { ...body, checksum: sha256Of(body) };
              store.recordPoolWitness(protocol, event.poolId, log.blockNumber, proof,
                { beforeCommit: () => { cache.guard(65536); cache.save(['witness', protocol, event.poolId], proof); } });
            }
            if (kind !== 'initialize' && !await poolIdentity(protocol, event.poolId, log.blockNumber)) fail('projection_pool_unverified');
            sink.v4(kind, log, event, null);
          }
        }
        const reducer = sink.checkpoint(), state = { reducer, transactionCount: transactionCount + sliceTransactions };
        if (state.transactionCount > h.transaction_count || last === h.last_block && state.transactionCount !== h.transaction_count) fail('projection_transaction_count_mismatch');
        if (names.some(name => reducer.failures[name])) fail(reducer.failures[names.find(name => reducer.failures[name])]);
        const archive = archiveUsage(db);
        tx(db, () => {
          cache.guard(Buffer.byteLength(canonicalJson(state)) + 65536);
          progress = appendRecoverySlice(db, h, unit, { first, last, lastHash: previous, lastTimestamp: timestamp,
            inputSha256: sha256Of({ logs, blocks: [...window].map(([n, b]) => [n, b.hash, sha256Of(b.txHashes)]) }), state },
          { maxTotalBytes: config.maxArchiveBytes, maxDailyBytes: config.maxDailyBytes, archiveBytes: archive.bytes, archiveDayBytes: archive.dayBytes,
            beforeCommit });
        });
        transactionCount = state.transactionCount;
        report.ranges++; await afterSlice({ protocol, first, last });
      } catch (error) {
        // Budget failures latch the provider. Only save the NEXT invocation's smaller range;
        // never issue another RPC in this execution after the failure.
        if (['recovery_response_budget_exhausted', 'projection_slice_size_limit'].includes(error.code) && width > 1) tx(db, () => {
          cache.guard(65536); db.prepare('INSERT INTO compact_meta VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
            .run(`compact_dex_width:${hourStart}:${protocol}`, String(width / 2));
        });
        throw error;
      }
    }
    if (progress.nextBlock <= h.last_block) { report.phase = 'partial'; continue; }
    const projections = sink.finish({ families: input.hour.families, hourStart: null, firstBlock: h.first_block, lastBlock: h.last_block });
    if (names.some(name => projections[name].status !== 'available')) {
      report.blocked[protocol] = names.filter(name => projections[name].status !== 'available').map(name => projections[name].reason).join(',');
      continue;
    }
    for (const name of names) {
      const existing = store.projectionStatus(hourStart).find(row => row.projection === name);
      if (existing?.status === 'available' && existing.rowsSha256 !== projections[name].rowsSha256) fail('projection_existing_conflict');
    }
    cache.guard(Buffer.byteLength(canonicalJson(projections)) + 65536);
    report.outcomes[protocol] = store.commitProjectionHour(hourStart, projections, { only: names, beforeCommit: () => {
      // Remove only this reducer, atomically with final verified output writes. Discovery's
      // cursors and every immutable commitment remain untouched. Rollback restores both.
      cache.guard(65536);
      const key = `discovery_slice_cursor:${hourStart}:${unit.id}`, bytes = db.prepare('SELECT length(CAST(value AS BLOB)) bytes FROM compact_meta WHERE key=?').get(key)?.bytes ?? 0;
      const usage = recoverySliceUsage(db);
      if (bytes > usage.bytes) fail('projection_usage_corrupt');
      db.prepare('DELETE FROM compact_meta WHERE key=?').run(key);
      db.prepare('UPDATE compact_meta SET value=? WHERE key=?').run(canonicalJson({ version: SLICE_PROGRESS_VERSION,
        bytes: usage.bytes - bytes, dayStart: usage.dayStart, dayBytes: Math.min(usage.dayBytes, usage.bytes - bytes) }), 'discovery_slice_usage');
      beforeCommit();
    } });
  }
  if (Object.keys(report.blocked).length) report.phase = 'blocked';
  // Valuation is still the existing stored-input reducer. TVL formulas, hook restrictions and
  // verified-price requirements are unchanged. Only missing pinned historical eth_calls resume.
  store.rederiveValuations(hourStart);
  if (report.phase === 'complete' && needsTvl() && !provider.canContinue(50)) report.phase = 'partial';
  if (report.phase === 'complete' && provider.canContinue(50)) {
    let tvlFailure = null;
    const cachedProvider = { batch: async (requests, { allowItemErrors = false } = {}) => {
      const results = new Array(requests.length), missing = [];
      for (const [i, [method, params]] of requests.entries()) {
        if (method !== 'eth_call' || params[1] !== hex(h.last_block)) fail('projection_tvl_call_unpinned');
        const saved = cache.read(['tvl', method, params]);
        if (saved !== null) results[i] = saved;
        else missing.push(i);
      }
      try {
        for (let start = 0; start < missing.length; start += 8) {
          if (!provider.canContinue(8)) fail('projection_work_yield');
          cache.guard(2 * MiB);
          const indices = missing.slice(start, start + 8), replies = await provider.batch(indices.map(i => requests[i]));
          for (const [offset, i] of indices.entries()) {
            if (typeof replies[offset] !== 'string' || !/^0x(?:[0-9a-f]{2})*$/i.test(replies[offset])) fail('projection_tvl_response_invalid');
            const data = requests[i][1][0].data, raw = replies[offset];
            if (data.startsWith('0x70a08231') ? raw.length !== 66
              : !data.startsWith('0xdbd035ff') || raw.length !== 2 + 64 * (2 + Number(BigInt('0x' + data.slice(74, 138))))
                || BigInt('0x' + raw.slice(2, 66)) !== 32n || raw.slice(66, 130) !== data.slice(74, 138)) fail('projection_tvl_response_invalid');
            results[i] = replies[offset];
            tx(db, () => cache.save(['tvl', ...requests[i]], replies[offset]));
          }
        }
      } catch (error) { tvlFailure = error.code ?? 'tvl_read_unavailable'; throw error; }
      return allowItemErrors ? results.map(result => ({ result, error: null })) : results;
    } };
    const protectedStore = { ...store, recordPoolTvl(...args) {
      cache.guard(256 * 1024);
      const [hour, protocol, rows, options] = args;
      const previous = store.poolTvl(hour, protocol).filter(row => row.status === 'unavailable'
        && rows.some(next => next.pool === row.pool && next.status === 'available'));
      return store.recordPoolTvl(hour, protocol, rows, { ...options, beforeCommit: () => {
        cache.guard(256 * 1024);
        for (const row of previous) cache.save(['tvl-previous-unavailable', protocol, row.pool], row);
        beforeCommit();
      } });
    } };
    report.tvl = await collectPoolTvl({ store: protectedStore, provider: cachedProvider, hourStart, blockNumber: h.last_block,
      poolManager: UNISWAP_REGISTRY.v4PoolManager.address, repairUnavailable: true });
    if (report.tvl.error) {
      report.phase = 'partial'; report.blocked.tvl = tvlFailure ?? report.tvl.error;
    }
  }
  return report;
}
