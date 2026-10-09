// Additive tables in the existing schema-2 SQLite file. No raw receipt/log archive, independent checkpoint or RPC here.
import { createHash } from 'node:crypto';
import { INTELLIGENCE_VERSION, ECOSYSTEM_SCHEMA, ECOSYSTEM_WINDOWS, INTELLIGENCE_REGISTRY, registryDigest,
  existingProtocolDefinitions, addressOf } from './intelligence-registry.js';
import { DISCOVERY_LIMIT_PER_HOUR, intelligenceJson, valueExchangeFlow } from './intelligence.js';
import { storedWindow } from './windows.js';

export const INTELLIGENCE_SQL = `
CREATE TABLE IF NOT EXISTS compact_intelligence_hours (
  hour_start INTEGER NOT NULL REFERENCES compact_hours(hour_start), definition_version TEXT NOT NULL,
  registry_digest TEXT NOT NULL, evidence_digest TEXT NOT NULL,
  discovery_status TEXT NOT NULL CHECK(discovery_status IN ('available','insufficient_coverage')),
  payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),
  PRIMARY KEY(hour_start, definition_version, registry_digest)
) STRICT;
CREATE TABLE IF NOT EXISTS compact_token_discoveries (
  candidate_key TEXT PRIMARY KEY, hour_start INTEGER NOT NULL REFERENCES compact_hours(hour_start),
  block_number INTEGER NOT NULL, address TEXT, candidate_json TEXT NOT NULL CHECK(json_valid(candidate_json)),
  result_json TEXT CHECK(result_json IS NULL OR json_valid(result_json)),
  status TEXT NOT NULL CHECK(status IN ('pending','unverified','rejected_not_erc20_like','verified_erc20_like')),
  reason TEXT, attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts >= 0), not_before INTEGER NOT NULL DEFAULT 0
) STRICT;
CREATE INDEX IF NOT EXISTS compact_token_discovery_retry ON compact_token_discoveries(status, not_before, block_number);
CREATE INDEX IF NOT EXISTS compact_token_discovery_hour ON compact_token_discoveries(hour_start, block_number);
CREATE INDEX IF NOT EXISTS compact_token_discovery_address ON compact_token_discoveries(address, block_number, hour_start);
CREATE TABLE IF NOT EXISTS compact_token_dex_observations (
  hour_start INTEGER NOT NULL REFERENCES compact_hours(hour_start), protocol TEXT NOT NULL,
  pool TEXT NOT NULL, activity TEXT NOT NULL CHECK(activity IN ('swap','liquidity','creation')),
  block_number INTEGER NOT NULL, log_index INTEGER NOT NULL, timestamp INTEGER NOT NULL, tx_hash TEXT NOT NULL,
  PRIMARY KEY(hour_start, protocol, pool, activity)
) STRICT;
CREATE INDEX IF NOT EXISTS compact_token_dex_first ON compact_token_dex_observations(protocol, pool, activity, block_number, log_index);
`;
const HOUR = 3600;
const iso = (seconds) => new Date(seconds * 1000).toISOString();
const digest = (value) => createHash('sha256').update(intelligenceJson(value)).digest('hex');
const unavailable = (reason) => ({ status: 'unavailable', reason });
const parse = (row) => row && JSON.parse(row.payload_json);
// Never attempted or retryable. rejected_not_erc20_like is resolved (terminal), verified_erc20_like is a token.
const UNRESOLVED_STATUSES = ['pending', 'unverified'];
const RETRY_DISCOVERY = `(status='unverified' OR (status='verified_erc20_like'
  AND json_extract(candidate_json,'$.kind')='source' AND json_extract(result_json,'$.launch.status')='unknown_source'))`;

// Read-only scheduler predicate. Missing additive tables mean no durable work, not complete coverage.
export function discoveryWorkDue(db, now) {
  if (!Number.isSafeInteger(now) || now < 0) throw new Error('invalid_discovery_time');
  if (!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='compact_token_discoveries'").get()) return false;
  return Boolean(db.prepare(`SELECT 1 FROM compact_token_discoveries WHERE not_before<=?
    AND (status='pending' OR ${RETRY_DISCOVERY}) LIMIT 1`).get(BigInt(now)));
}

export function createIntelligenceRepository(db) {
  const run = (fn) => {
    db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); db.exec('COMMIT'); return result; } catch (error) { db.exec('ROLLBACK'); throw error; }
  };
  return Object.freeze({
    // Caller owns the hour transaction. Refuse any attempt to attach observations to a different canonical range.
    recordHour(result) {
      let payload = result.intelligence;
      if (!payload) return;
      if (db.isTransaction !== true || payload.version !== INTELLIGENCE_VERSION) throw new Error('intelligence_transaction_required');
      const hour = db.prepare('SELECT * FROM compact_hours WHERE hour_start = ?').get(BigInt(result.range.hourStart));
      if (!hour || hour.hour_start !== payload.range.hourStart || hour.first_block !== payload.range.firstBlock || hour.last_block !== payload.range.lastBlock
        || hour.last_hash !== payload.range.lastHash || hour.parent_hash !== payload.range.parentHash) throw new Error('intelligence_range_mismatch');
      if (!Array.isArray(payload.discovery?.candidates) || payload.discovery.candidates.length > DISCOVERY_LIMIT_PER_HOUR) throw new Error('intelligence_candidate_limit');
      const candidateFacts = payload.discovery.candidates;
      const dexFacts = payload.firstDex;
      if (!Array.isArray(dexFacts) || dexFacts.length > DISCOVERY_LIMIT_PER_HOUR * 2 || !/^[0-9a-f]{64}$/.test(payload.registryDigest)) throw new Error('intelligence_payload_invalid');
      // Store identity facts once in their bounded tables. The hourly row holds only coverage/counts/digests.
      payload = { ...payload, discovery: { ...payload.discovery, candidates: undefined, candidateCount: candidateFacts.length,
        candidateEvidenceDigest: digest(candidateFacts) }, firstDex: undefined, firstDexCount: dexFacts.length, firstDexEvidenceDigest: digest(dexFacts) };
      const old = db.prepare(`SELECT * FROM compact_intelligence_hours WHERE hour_start = ? AND definition_version = ? AND registry_digest = ?`)
        .get(BigInt(hour.hour_start), INTELLIGENCE_VERSION, payload.registryDigest);
      if (old) {
        const prior = parse(old);
        const preserve = (earlier, later) => {
          if (earlier.status !== 'available') return later;
          if (later.status === 'available' && digest(earlier) !== digest(later)) throw new Error('intelligence_evidence_conflict');
          return earlier;
        };
        const protocols = payload.protocols.map((row) => preserve(prior.protocols.find((item) => item.id === row.id) ?? row, row));
        const launchSources = payload.launchSources.map((row) => preserve(prior.launchSources.find((item) => item.id === row.id) ?? row, row));
        if (prior.firstDexComplete && payload.firstDexComplete && prior.firstDexEvidenceDigest !== payload.firstDexEvidenceDigest) throw new Error('intelligence_evidence_conflict');
        payload = { ...payload, discovery: preserve(prior.discovery, payload.discovery), exchange: preserve(prior.exchange, payload.exchange),
          protocols, launchSources, firstDexCount: prior.firstDexComplete ? prior.firstDexCount : payload.firstDexCount,
          firstDexEvidenceDigest: prior.firstDexComplete ? prior.firstDexEvidenceDigest : payload.firstDexEvidenceDigest,
          firstDexComplete: prior.firstDexComplete || payload.firstDexComplete };
      }
      const sha = digest(payload);
      db.prepare(`INSERT INTO compact_intelligence_hours VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(hour_start, definition_version, registry_digest)
        DO UPDATE SET evidence_digest=excluded.evidence_digest, discovery_status=excluded.discovery_status, payload_json=excluded.payload_json
        WHERE compact_intelligence_hours.evidence_digest <> excluded.evidence_digest`).run(BigInt(hour.hour_start), INTELLIGENCE_VERSION,
        payload.registryDigest, sha, payload.discovery.status, intelligenceJson(payload));
      for (const candidate of candidateFacts) {
        if (!Number.isSafeInteger(candidate.blockNumber) || candidate.blockNumber < hour.first_block || candidate.blockNumber > hour.last_block || candidate.readBlock !== hour.last_block
          || !Number.isSafeInteger(candidate.timestamp) || candidate.timestamp < hour.hour_start || candidate.timestamp >= hour.hour_start + HOUR
          || !Number.isSafeInteger(candidate.transactionIndex) || candidate.transactionIndex < 0
          || !/^0x[0-9a-f]{64}$/.test(candidate.txHash) || !/^0x[0-9a-f]{64}$/.test(candidate.blockHash)
          || candidate.address !== null && !addressOf(candidate.address)
          || !['creation', 'source', 'pool'].includes(candidate.kind)) throw new Error('intelligence_candidate_invalid');
        const json = intelligenceJson(candidate);
        const previous = db.prepare('SELECT candidate_json FROM compact_token_discoveries WHERE candidate_key = ?').get(candidate.key);
        if (previous && previous.candidate_json !== json) throw new Error('intelligence_candidate_conflict');
        db.prepare(`INSERT OR IGNORE INTO compact_token_discoveries(candidate_key,hour_start,block_number,address,candidate_json,status)
          VALUES (?,?,?,?,?,'pending')`).run(candidate.key, BigInt(hour.hour_start), BigInt(candidate.blockNumber), candidate.address, json);
      }
      for (const row of dexFacts) {
        if (!Number.isSafeInteger(row.blockNumber) || row.blockNumber < hour.first_block || row.blockNumber > hour.last_block
          || !Number.isSafeInteger(row.logIndex) || row.logIndex < 0 || !Number.isSafeInteger(row.timestamp)
          || row.timestamp < hour.hour_start || row.timestamp >= hour.hour_start + HOUR
          || !['uniswap_v3', 'uniswap_v4'].includes(row.protocol) || !/^0x[0-9a-f]{64}$/.test(row.txHash)) throw new Error('intelligence_dex_invalid');
        const previous = db.prepare(`SELECT * FROM compact_token_dex_observations WHERE hour_start=? AND protocol=? AND pool=? AND activity=?`)
          .get(BigInt(hour.hour_start), row.protocol, row.pool, row.activity);
        if (previous && (previous.block_number !== row.blockNumber || previous.log_index !== row.logIndex || previous.tx_hash !== row.txHash)) {
          throw new Error('intelligence_dex_conflict');
        }
        db.prepare('INSERT OR IGNORE INTO compact_token_dex_observations VALUES (?,?,?,?,?,?,?,?)').run(BigInt(hour.hour_start), row.protocol,
          row.pool, row.activity, BigInt(row.blockNumber), BigInt(row.logIndex), BigInt(row.timestamp), row.txHash);
      }
    },
    pending({ now, limit }) {
      if (!Number.isSafeInteger(now) || !Number.isSafeInteger(limit) || limit < 1 || limit > 16) throw new Error('invalid_discovery_limit');
      // Separate bounded queues: at the production limit each gets eight places; unused quota is borrowed.
      // Earliest retry eligibility rotates old attempts fairly. Terminal negatives never enter either queue.
      const fresh = db.prepare(`SELECT candidate_json FROM compact_token_discoveries WHERE status='pending' AND not_before<=?
        ORDER BY block_number ASC,candidate_key ASC LIMIT ?`).all(BigInt(now), BigInt(limit));
      const retries = db.prepare(`SELECT candidate_json FROM compact_token_discoveries WHERE ${RETRY_DISCOVERY} AND not_before<=?
        ORDER BY not_before ASC,block_number ASC,candidate_key ASC LIMIT ?`).all(BigInt(now), BigInt(limit));
      const retryCount = Math.min(retries.length, Math.ceil(limit / 2));
      const freshCount = Math.min(fresh.length, limit - retryCount);
      const selected = [...retries.slice(0, retryCount), ...fresh.slice(0, freshCount)];
      selected.push(...retries.slice(retryCount, retryCount + limit - selected.length));
      return selected.map((row) => JSON.parse(row.candidate_json));
    },
    recordVerification(result, { now }) {
      if (!['verified_erc20_like', 'rejected_not_erc20_like', 'unverified'].includes(result.status) || !Number.isSafeInteger(now)
        || result.status === 'verified_erc20_like' && !addressOf(result.address)) throw new Error('invalid_token_verification');
      return run(() => {
        const current = db.prepare('SELECT * FROM compact_token_discoveries WHERE candidate_key = ?').get(result.key);
        if (!current) throw new Error('discovery_candidate_missing');
        const candidate = JSON.parse(current.candidate_json);
        if (['blockHash', 'readBlock', 'txHash', 'blockNumber', 'transactionIndex', 'kind', 'timestamp'].some((field) => candidate[field] !== result[field])
          || candidate.kind !== 'creation' && candidate.address !== result.address) throw new Error('discovery_identity_mismatch');
        if (current.status === 'rejected_not_erc20_like') return; // Terminal: a later answer never reopens or promotes it.
        if (current.status === 'verified_erc20_like' && result.status !== 'verified_erc20_like') {
          db.prepare('UPDATE compact_token_discoveries SET attempts=attempts+1,not_before=? WHERE candidate_key=?')
            .run(BigInt(now + 60 * 60 * 1000), result.key);
          return;
        }
        if (current.status === 'verified_erc20_like' && JSON.parse(current.result_json).launch.status !== 'unknown_source') return;
        db.prepare(`UPDATE compact_token_discoveries SET address=?,result_json=?,status=?,reason=?,attempts=attempts+1,not_before=? WHERE candidate_key=?`)
          .run(result.address, intelligenceJson(result), result.status, result.reason, BigInt(now + 60 * 60 * 1000), result.key);
      });
    },
  });
}

// No RPC, no writes. Used inside the existing read-only model's short WAL snapshot transaction.
export function readEcosystem(db, windowKey, { registry = INTELLIGENCE_REGISTRY } = {}) {
  if (!Object.hasOwn(ECOSYSTEM_WINDOWS, windowKey)) throw new Error('unsupported_window');
  let hours = ECOSYSTEM_WINDOWS[windowKey];
  const checkpoint = db.prepare('SELECT hour_start,last_block FROM compact_checkpoint WHERE id=1').get();
  const to = checkpoint?.hour_start ?? null;
  const bounds = windowKey === '30d' && checkpoint ? db.prepare('SELECT MIN(hour_start) AS first, MAX(hour_start) AS last, COUNT(*) AS count FROM compact_hours').get() : null;
  if (bounds && (bounds.last !== to || bounds.count !== (to - bounds.first) / HOUR + 1)) throw new Error('checkpoint_not_contiguous');
  const selected = bounds ? storedWindow(windowKey, hours, bounds.first, to) : null;
  const from = selected?.from ?? (to === null ? null : to - (hours - 1) * HOUR);
  hours = selected?.hours ?? hours;
  const base = { schema: ECOSYSTEM_SCHEMA, chain: { id: 5042, name: 'Arc' }, definitionVersion: INTELLIGENCE_VERSION,
    window: selected?.window ?? { key: windowKey, hours, start: from === null ? null : iso(from), end: to === null ? null : iso(to + HOUR) },
    verifiedAssets: registry.assets.map((asset) => ({ ...asset, classification: 'verified_registry_asset', promotionFromDiscovery: false })),
    rwa: registry.assets.filter((asset) => asset.category === 'tokenized_fund' || asset.category === 'rwa').map((asset) => ({ ...asset })),
    existingProtocols: existingProtocolDefinitions(), launchSources: registry.launches.map(({ events, ...entry }) => ({ ...entry,
      events: events.map((spec) => ({ declaration: spec.declaration, signature: spec.event.signature, topic: spec.event.topic,
        tokenField: spec.tokenField, creatorField: spec.creatorField ?? null })) })) };
  const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((row) => row.name));
  const empty = (reason) => ({ ...base, coverage: { ...unavailable(reason), requiredHours: hours, availableHours: 0 },
    discoveredTokens: { ...unavailable(reason), rows: [] }, contractCandidates: { ...unavailable(reason), rows: [] }, launches: { ...unavailable(reason), rows: [] },
    otherProtocols: { ...unavailable(registry.protocols.length ? reason : 'verified_protocol_registry_empty'), rows: [] },
    exchangeFlows: { ...unavailable(registry.exchanges.length ? reason : 'verified_exchange_registry_empty'), rows: [], buckets: [] } });
  if (!checkpoint || !['compact_intelligence_hours', 'compact_token_discoveries', 'compact_token_dex_observations'].every((name) => tables.has(name))) return empty('not_stored');
  const bytes = db.prepare(`SELECT SUM(length(payload_json)) AS bytes FROM compact_intelligence_hours WHERE hour_start BETWEEN ? AND ?
    AND definition_version=? AND registry_digest=?`).get(BigInt(from), BigInt(to), INTELLIGENCE_VERSION, registryDigest(registry)).bytes ?? 0;
  if (bytes > 4 * 1024 * 1024) return empty('bounded_read_limit');
  const rows = db.prepare(`SELECT * FROM compact_intelligence_hours WHERE hour_start BETWEEN ? AND ? AND definition_version=? AND registry_digest=? ORDER BY hour_start`)
    .all(BigInt(from), BigInt(to), INTELLIGENCE_VERSION, registryDigest(registry));
  const payloads = new Map(rows.map((row) => [row.hour_start, parse(row)]));
  const covered = rows.filter((row) => row.discovery_status === 'available').length;
  const candidates = db.prepare(`SELECT * FROM (SELECT d.*, MIN(hour_start) OVER(PARTITION BY COALESCE(address,candidate_key)) AS first_observed_hour,
    ROW_NUMBER() OVER(PARTITION BY COALESCE(address,candidate_key)
    ORDER BY CASE json_extract(result_json,'$.launch.status') WHEN 'verified_factory' THEN 0 WHEN 'verified_launchpad' THEN 0
    WHEN 'direct_deployment' THEN 1 ELSE 2 END,block_number ASC,candidate_key ASC) AS priority
    FROM compact_token_discoveries d WHERE hour_start<=?) WHERE priority=1 AND first_observed_hour BETWEEN ? AND ?
    ORDER BY block_number DESC,candidate_key ASC LIMIT 51`).all(BigInt(to), BigInt(from), BigInt(to));
  const launchCandidates = db.prepare(`SELECT * FROM (SELECT d.*,ROW_NUMBER() OVER(PARTITION BY address ORDER BY block_number,candidate_key) AS priority
    FROM compact_token_discoveries d WHERE hour_start BETWEEN ? AND ? AND status='verified_erc20_like'
    AND json_extract(result_json,'$.launch.status') IN ('verified_factory','verified_launchpad','direct_deployment')) WHERE priority=1
    ORDER BY block_number DESC,candidate_key ASC LIMIT 51`).all(BigInt(from),BigInt(to));
  const token = (row) => {
    const candidate = JSON.parse(row.candidate_json);
    const result = row.result_json && JSON.parse(row.result_json);
    const verified = row.status === 'verified_erc20_like';
    const rejected = row.status === 'rejected_not_erc20_like';
    const direct = result?.directDeploymentVerified === true;
    const deploymentRow = !direct && row.address ? db.prepare(`SELECT result_json FROM compact_token_discoveries WHERE address=?
      AND json_extract(result_json,'$.directDeploymentVerified')=1 ORDER BY block_number,candidate_key LIMIT 1`).get(row.address) : null;
    const deployment = direct ? candidate : deploymentRow ? JSON.parse(deploymentRow.result_json) : null;
    let launch = result?.launch;
    if (launch?.observedAt !== undefined) launch = { ...launch, observedAt: iso(launch.observedAt) };
    if (['verified_factory', 'verified_launchpad'].includes(launch?.status)
      && !registry.launches.some((entry) => entry.id === launch.source && entry.version === result.launchEvidence?.version
        && entry.addresses.includes(result.launchEvidence.emitter)
        && entry.events.some(spec => spec.event.signature === result.launchEvidence.eventSignature)
        && (!entry.factoryVerification || result.launchEvidence.factoryEvidence?.status === 'verified'))) launch = { status: 'unknown_source', source: null,
      reason: 'registry_definition_not_current', provenance: null };
    return { address: row.address, status: row.status, reason: row.reason, verifiedAsset: false,
      symbol: result?.symbol ?? null, name: result?.name ?? null, decimals: result?.decimals ?? null,
      discoveredAt: (() => {
        const first = row.address ? db.prepare('SELECT candidate_json FROM compact_token_discoveries WHERE address=? ORDER BY block_number,candidate_key LIMIT 1').get(row.address) : null;
        return iso(first ? JSON.parse(first.candidate_json).timestamp : candidate.timestamp);
      })(), observedBlock: candidate.blockNumber,
      deployment: deployment ? { transactionHash: deployment.txHash, blockNumber: deployment.blockNumber, timestamp: iso(deployment.timestamp), deployer: deployment.deployer }
        : { status: 'unavailable', reason: 'deployment_not_proven' },
      verification: result?.verification ?? null,
      launch: verified ? launch : { status: rejected ? 'not_applicable' : 'unverified', source: null, provenance: null },
      dex: verified ? correlateDex(db, row.address, checkpoint.last_block, { registry }) : unavailable(rejected ? 'rejected_not_erc20_like' : 'token_unverified') };
  };
  const tokens = candidates.slice(0, 50).map(token);
  const verificationCounts = db.prepare(`SELECT status,COUNT(*) AS n FROM compact_token_discoveries WHERE hour_start BETWEEN ? AND ? GROUP BY status`)
    .all(BigInt(from), BigInt(to));
  const unresolved = verificationCounts.filter((row) => UNRESOLVED_STATUSES.includes(row.status)).reduce((n, row) => n + row.n, 0);
  const full = covered === hours;
  const firstDexCoverage = rows.filter((row) => JSON.parse(row.payload_json).firstDexComplete === true).length;
  const exchangeBuckets = [];
  const protocolBuckets = [];
  for (let hour = from; hour <= to; hour += HOUR) {
    const payload = payloads.get(hour);
    if (registry.exchanges.length) {
      const complete = payload?.exchange.status === 'available';
      let prices = null;
      if (complete && tables.has('compact_token_price_hours') && tables.has('compact_valuation_hours')
        && db.prepare("SELECT status FROM compact_valuation_hours WHERE hour_start=? AND valuation='token_prices'").get(BigInt(hour))?.status === 'available') {
        prices = new Map(db.prepare('SELECT token,price_usd_e18 FROM compact_token_price_hours WHERE hour_start=?').all(BigInt(hour))
          .map((price) => [price.token, { priceUsdE18: BigInt(price.price_usd_e18) }]));
      }
      exchangeBuckets.push({ hourStart: iso(hour), status: complete ? 'available' : 'unavailable', reason: complete ? null : 'insufficient_coverage',
        rows: complete ? payload.exchange.rows.map((row) => valueExchangeFlow(row, prices)) : null });
    }
    if (registry.protocols.length) protocolBuckets.push({ hourStart: iso(hour), rows: payload?.protocols ?? null });
  }
  const exchangeComplete = registry.exchanges.length > 0 && exchangeBuckets.every((bucket) => bucket.status === 'available');
  const protocolComplete = registry.protocols.length > 0 && protocolBuckets.every((bucket) => bucket.rows?.length === registry.protocols.length
    && bucket.rows.every((row) => row.status === 'available'));
  const out = { ...base, coverage: { status: full ? 'available' : 'insufficient_coverage', reason: full ? null : 'discovery_hour_missing_or_capped',
    scope: 'top_level_creations_and_registered_sources', internalCreations: 'not_supported', allArcTokensComplete: false,
    requiredHours: hours, availableHours: covered, unresolvedCandidateCount: unresolved, candidateVerificationComplete: full && unresolved === 0,
    verifiedDexObservationHours: firstDexCoverage },
    discoveredTokens: { status: full && !unresolved ? 'available' : 'insufficient_coverage', limit: 50, truncated: candidates.length > 50,
      rows: tokens.filter((row) => row.status === 'verified_erc20_like') },
    contractCandidates: { status: unresolved ? 'unverified' : full ? 'available' : 'insufficient_coverage',
      limit: 50, truncated: candidates.length > 50, rows: tokens.filter((row) => row.status !== 'verified_erc20_like') },
    // An unresolved candidate may still be a launch, so the launch list is complete only when every candidate is resolved.
    launches: { status: full && !unresolved ? 'available' : 'insufficient_coverage', definition: 'verified_tokens_with_proven_source_or_direct_deployment_in_window',
      limit: 50, truncated: launchCandidates.length > 50,
      rows: launchCandidates.slice(0,50).map(token).filter((row) => ['verified_factory', 'verified_launchpad', 'direct_deployment'].includes(row.launch.status)) },
    otherProtocols: { status: protocolComplete ? 'available' : 'unavailable', reason: !registry.protocols.length ? 'verified_protocol_registry_empty'
      : protocolComplete ? null : 'insufficient_coverage', rows: protocolComplete ? sumProtocols(protocolBuckets) : null,
      definitions: registry.protocols.map(({ events, ...entry }) => ({ ...entry, events: events.map((spec) => ({ signature: spec.event.signature,
        metric: spec.metric, aggregation: spec.aggregation, assetField: spec.assetField, amountField: spec.amountField })) })), buckets: protocolBuckets },
    exchangeFlows: { status: exchangeComplete ? 'available' : 'unavailable', reason: !registry.exchanges.length ? 'verified_exchange_registry_empty'
      : exchangeComplete ? null : 'insufficient_coverage', definitions: registry.exchanges, unit: 'per_asset_raw',
      rows: exchangeComplete ? sumExchange(exchangeBuckets) : null, buckets: exchangeBuckets } };
  // Fixed GET routes have no arbitrary SQL pagination. A too-large result is explicitly unavailable, not silently truncated.
  return Buffer.byteLength(intelligenceJson(out)) > 240 * 1024 ? empty('bounded_response_limit') : out;
}

export function sumProtocols(buckets) {
  const totals = new Map();
  for (const bucket of buckets) for (const row of bucket.rows ?? []) {
    const key = `${row.id}:${row.version}`;
    if (!totals.has(key)) totals.set(key, { id: row.id, version: row.version, counts: {}, rawFlows: {}, unit: 'per_asset_raw_not_USD' });
    const total = totals.get(key);
    for (const [metric, count] of Object.entries(row.counts)) total.counts[metric] = (total.counts[metric] ?? 0) + count;
    for (const [metricAsset, amount] of Object.entries(row.rawFlows)) total.rawFlows[metricAsset] = (BigInt(total.rawFlows[metricAsset] ?? '0') + BigInt(amount)).toString(10);
  }
  return [...totals.values()];
}

export function sumExchange(buckets) {
  const totals = new Map();
  for (const bucket of buckets) for (const row of bucket.rows ?? []) {
    const key = `${row.entity}:${row.asset}:${row.direction}:${row.decimals}`;
    if (!totals.has(key)) totals.set(key, { ...row, count: 0, amountRaw: '0', usd: { status: 'available', usdMicros: '0' } });
    const total = totals.get(key); total.count += row.count; total.amountRaw = (BigInt(total.amountRaw) + BigInt(row.amountRaw)).toString(10);
    total.usd = total.usd.status !== 'available' || row.usd.status !== 'available' ? { ...unavailable('verified_price_unavailable'), usdMicros: null }
      : { status: 'available', usdMicros: (BigInt(total.usd.usdMicros) + BigInt(row.usd.usdMicros)).toString(10) };
  }
  return [...totals.values()];
}

// Registry completeness, not list length, is the prerequisite for a true first pool. Activity additionally needs
// contiguous retained projections from pool creation through the observation. Earlier missing history never becomes zero.
export function correlateDex(db, token, endBlock, { registry = INTELLIGENCE_REGISTRY } = {}) {
  const pools = db.prepare(`SELECT * FROM compact_registry WHERE kind IN ('uniswap_v3_pool','uniswap_v4_pool') AND created_block<=?
    AND (lower(json_extract(meta_json,'$.token0'))=? OR lower(json_extract(meta_json,'$.token1'))=?
      OR lower(json_extract(meta_json,'$.currency0'))=? OR lower(json_extract(meta_json,'$.currency1'))=?)
    ORDER BY created_block,created_log_index,kind,address LIMIT 51`).all(BigInt(endBlock), token, token, token, token);
  const coverages = new Map(db.prepare('SELECT * FROM compact_registry_coverage').all().map((row) => [row.kind, row]));
  const registryComplete = [['uniswap_v3_pool', 1948019], ['uniswap_v4_pool', 1948056]].every(([kind, floor]) => {
    const row = coverages.get(kind); return row && row.from_block <= floor && row.through_block >= endBlock;
  });
  if (!pools.length) return { ...unavailable(registryComplete ? 'no_verified_pool' : 'insufficient_coverage'), firstPool: null, observedPools: [] };
  const observedPools = pools.slice(0, 50).map((row) => {
    const meta = JSON.parse(row.meta_json);
    const token0 = meta.token0 ?? meta.currency0; const token1 = meta.token1 ?? meta.currency1;
    const protocol = row.kind === 'uniswap_v3_pool' ? 'uniswap_v3' : 'uniswap_v4';
    const firstOf = (activity) => {
      const observed = db.prepare(`SELECT * FROM compact_token_dex_observations WHERE protocol=? AND pool=? AND activity=? AND block_number<=?
        ORDER BY block_number,log_index LIMIT 1`).get(protocol, row.address, activity, BigInt(endBlock));
      if (!observed) return unavailable('activity_not_stored');
      const start = db.prepare('SELECT hour_start FROM compact_hours WHERE first_block<=? AND last_block>=?').get(BigInt(row.created_block), BigInt(row.created_block));
      let complete = false;
      if (start) {
        const count = db.prepare(`SELECT COUNT(*) AS n FROM compact_projection_hours WHERE hour_start BETWEEN ? AND ? AND projection=? AND status='available'`)
          .get(BigInt(start.hour_start), BigInt(observed.hour_start), `${protocol}_pools`).n;
        // New observation coverage is required too: older pool projections alone did not retain their earliest events.
        const covered = db.prepare(`SELECT COUNT(*) AS n FROM compact_intelligence_hours WHERE hour_start BETWEEN ? AND ? AND definition_version=?
          AND registry_digest=? AND json_extract(payload_json,'$.firstDexComplete')=1`)
          .get(BigInt(start.hour_start), BigInt(observed.hour_start), INTELLIGENCE_VERSION, registryDigest(registry)).n;
        complete = count === (observed.hour_start - start.hour_start) / HOUR + 1 && covered === count;
      }
      return { status: complete ? 'available' : 'insufficient_coverage', reason: complete ? null : 'first_activity_history_missing',
        firstProven: complete, firstObserved: { timestamp: iso(observed.timestamp), blockNumber: observed.block_number,
          logIndex: observed.log_index, txHash: observed.tx_hash } };
    };
    const activity = db.prepare(`SELECT MIN(h.hour_start) AS start,SUM(h.swap_count) AS swaps FROM compact_pool_hours h WHERE h.protocol=? AND h.pool=?
      AND h.hour_start IN (SELECT hour_start FROM compact_hours WHERE last_block<=?)`).get(protocol, row.address, BigInt(endBlock));
    const creationHour = db.prepare('SELECT hour_start,last_block FROM compact_hours WHERE first_block<=? AND last_block>=?')
      .get(BigInt(row.created_block), BigInt(row.created_block));
    const early = creationHour && creationHour.last_block <= endBlock ? db.prepare(`SELECT p.status,h.swap_count FROM compact_projection_hours p
      LEFT JOIN compact_pool_hours h ON h.hour_start=p.hour_start AND h.protocol=? AND h.pool=? WHERE p.hour_start=? AND p.projection=?`)
      .get(protocol, row.address, BigInt(creationHour.hour_start), `${protocol}_pools`) : null;
    return { protocol, pool: row.address, pairedToken: token0 === token ? token1 : token0, creationBlock: row.created_block,
      creationTxHash: row.created_tx, creationTimestamp: (() => {
        const observed = db.prepare(`SELECT timestamp FROM compact_token_dex_observations WHERE protocol=? AND pool=? AND activity='creation'
          AND block_number=? AND tx_hash=? LIMIT 1`).get(protocol, row.address, BigInt(row.created_block), row.created_tx);
        return observed ? iso(observed.timestamp) : null;
      })(), firstSwap: firstOf('swap'), firstLiquidity: firstOf('liquidity'),
      earlyActivity: { status: early?.status === 'available' ? 'available' : 'unavailable',
        reason: early?.status === 'available' ? null : 'creation_hour_projection_missing', basis: 'pool_creation_UTC_hour',
        hourStart: creationHour ? iso(creationHour.hour_start) : null, swapCount: early?.status === 'available' ? early.swap_count ?? 0 : null },
      observedSwapCount: activity.swaps ?? null, countScope: 'stored_pool_hours_only_not_full_lifetime' };
  });
  const observed = observedPools.flatMap((pool) => ['firstSwap','firstLiquidity'].flatMap((key) => pool[key].firstObserved
    ? [{ ...pool[key].firstObserved, pool: pool.pool, protocol: pool.protocol, activity: key === 'firstSwap' ? 'swap' : 'liquidity', firstProven: pool[key].firstProven }] : []))
    .sort((a,b) => a.blockNumber - b.blockNumber || a.logIndex - b.logIndex)[0] ?? null;
  const activityProven = registryComplete && pools.length <= 50 && observed?.firstProven === true
    && observedPools.every((pool) => pool.creationBlock >= observed.blockNumber || pool.firstSwap.firstProven && pool.firstLiquidity.firstProven);
  return { status: registryComplete && pools.length <= 50 ? 'available' : 'insufficient_coverage',
    reason: registryComplete && pools.length <= 50 ? null : 'pool_registry_history_incomplete_or_limit',
    firstPool: registryComplete && pools.length <= 50 ? observedPools[0] : null, observedPools,
    firstDexActivity: { status: activityProven ? 'available' : 'insufficient_coverage', reason: activityProven ? null : 'first_activity_history_missing',
      value: activityProven ? observed : null, firstObserved: observed },
    source: 'existing_official_registry_and_shared_compact_projections' };
}
