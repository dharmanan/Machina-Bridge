// Compact engine: projection-only backfill of hours that are already stored, and its dry-run plan. Never a processHour
// replay: no block spine, no receipts, no family recount. For each stored hour it re-reads only the two Uniswap streams
// the projections come from (v3Pools and v4, 500 blocks per eth_getLogs, exactly as live), validates them without a spine
// (range, emitter, topic, duplicates, one hash per block, the stored first/last block hashes, plus a batched header check
// of every stored hour boundary), and hands the decoded official events to the same projection sink the live hour uses.
// store.js then reconciles the result exactly against the hour's STORED family counters before anything is written;
// a mismatch is stored as unavailable. Recent activity needs the spine's transaction senders, so a backfilled hour
// never has activity: it fills from live hours only. The pool price paths come from the same two streams (no extra
// request) and are written with the pool rows; the hour's valuations are then derived from what is stored.
// Nothing here runs by itself: scripts/backfill-compact-projections.mjs plans by default and writes only on request, and
// scripts/repair-compact-projection-hour.mjs (the scheduler's self-heal child) repairs exactly one stored hour.
import { normalizeLog } from '../../api/_lib/arc-intelligence/normalize.js';
import {
  decodeV3Burn, decodeV3Mint, decodeV3Swap, decodeV4Initialize, decodeV4ModifyLiquidity, decodeV4Swap, UNISWAP_EVENT_TOPICS,
} from '../../api/_lib/arc-intelligence/uniswap.js';
import { LogError, streamLogs } from './logs.js';
import {
  ACTIVITY_KINDS, ACTIVITY_ROWS_PER_KIND, createProjectionSink, poolHourCutoff, POOL_HOUR_RETENTION_HOURS, POOL_PROJECTION_FAMILY, PROJECTIONS,
  projectionRepairState,
} from './projections.js';
import { ProviderError } from './provider.js';
import { v4RegistryScanRequests } from './registry.js';
import { DENSE_LOG_RANGE_BLOCKS, LOG_STREAMS } from './sources.js';
import { headerOf } from './spine.js';

export const DEFAULT_PACING_MS = 1000;
export const BOUNDARY_BATCH_SIZE = 50;
// The provider verifies the chain id once per run (one eth_chainId request) before its first real request.
export const CHAIN_CHECK_REQUESTS = 1;
// Storage estimate per stored row (SQLite payload, key and index overhead included), used only by the dry-run report.
export const POOL_HOUR_ROW_BYTES = 300;
export const ACTIVITY_ROW_BYTES = 420;
export const PROJECTION_STATUS_ROW_BYTES = 120;
// The only streams a projection backfill ever requests, per pool projection.
export const PROJECTION_BACKFILL_STREAMS = Object.freeze({
  uniswap_v3_pools: LOG_STREAMS.find((stream) => stream.key === 'v3Pools'),
  uniswap_v4_pools: LOG_STREAMS.find((stream) => stream.key === 'v4'),
});
const FAMILY_OF = Object.freeze({ uniswap_v3_pools: 'uniswapV3', uniswap_v4_pools: 'uniswapV4' });
const HOUR = 3600;
const hex = (number) => `0x${number.toString(16)}`;
const iso = (seconds) => new Date(seconds * 1000).toISOString();

export class BackfillError extends Error {
  constructor(code) { super(code); this.code = code; }
}

// ---------------------------------------------------------------------------------------------------------------------
// Inputs, read-only. db: an open node:sqlite DatabaseSync (the CLI opens it with readOnly and query_only). Works on a
// database written before projections existed: missing projection tables mean "no projection stored yet".

function compactTables(db, schemaVersion) {
  const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name GLOB 'compact_*'").all().map((row) => row.name));
  if (!tables.has('compact_meta') || !tables.has('compact_hours')) throw new BackfillError('database_not_compact');
  if (db.prepare("SELECT value FROM compact_meta WHERE key = 'schema_version'").get()?.value !== schemaVersion) {
    throw new BackfillError('schema_version_mismatch');
  }
  return tables;
}

// Stored hours (all, or the one at hourStart) with their Uniswap family rows and projection status, oldest first.
function storedHours(db, { projectionTables, hourStart = null }) {
  const only = hourStart === null ? [] : [BigInt(hourStart)];
  const statuses = new Map();
  if (projectionTables) {
    const rows = db.prepare(`SELECT hour_start, projection, status FROM compact_projection_hours${hourStart === null ? '' : ' WHERE hour_start = ?'}`)
      .all(...only);
    for (const row of rows) {
      if (!statuses.has(row.hour_start)) statuses.set(row.hour_start, {});
      statuses.get(row.hour_start)[row.projection] = row.status;
    }
  }
  const familyOf = (status, json) => (status === 'available' ? { status, ...JSON.parse(json) } : { status: status ?? 'missing' });
  return db.prepare(`SELECT h.hour_start, h.first_block, h.last_block, h.parent_hash, h.first_hash, h.last_hash,
      v3.status AS v3_status, v3.metrics_json AS v3_metrics, v4.status AS v4_status, v4.metrics_json AS v4_metrics
    FROM compact_hours h
    LEFT JOIN compact_family_hours v3 ON v3.hour_start = h.hour_start AND v3.family = 'uniswapV3'
    LEFT JOIN compact_family_hours v4 ON v4.hour_start = h.hour_start AND v4.family = 'uniswapV4'
    ${hourStart === null ? '' : 'WHERE h.hour_start = ?'} ORDER BY h.hour_start`).all(...only).map((row) => ({
    hourStart: row.hour_start, firstBlock: row.first_block, lastBlock: row.last_block, parentHash: row.parent_hash, firstHash: row.first_hash,
    lastHash: row.last_hash, families: { uniswapV3: familyOf(row.v3_status, row.v3_metrics), uniswapV4: familyOf(row.v4_status, row.v4_metrics) },
    projections: statuses.get(row.hour_start) ?? {},
  }));
}

function coverageOf(db, kind) {
  const row = db.prepare('SELECT from_block, through_block, through_hash FROM compact_registry_coverage WHERE kind = ?').get(kind);
  return row ? { fromBlock: row.from_block, through: row.through_block, throughHash: row.through_hash } : null;
}

export function readBackfillInputs(db, { schemaVersion = '2' } = {}) {
  const projectionTables = compactTables(db, schemaVersion).has('compact_projection_hours');
  const checkpoint = db.prepare('SELECT hour_start, last_block, last_hash FROM compact_checkpoint WHERE id = 1').get();
  return {
    hours: storedHours(db, { projectionTables }),
    projectionTables,
    v3Coverage: coverageOf(db, 'uniswap_v3_pool'),
    v4Coverage: coverageOf(db, 'uniswap_v4_pool'),
    v4Pools: db.prepare("SELECT COUNT(*) AS count FROM compact_registry WHERE kind = 'uniswap_v4_pool'").get().count,
    checkpoint: checkpoint ? { hourStart: checkpoint.hour_start, lastBlock: checkpoint.last_block, lastHash: checkpoint.last_hash } : null,
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// Single-hour projection repair (the scheduler's self-heal). Same rule as the read model (projections.js
// projectionRepairState): only pool projections that are missing or unavailable while their family is available, only
// when their registry already covers the hour, only inside pool-hour retention. Recent activity is never rebuilt.

export function readProjectionRepairInput(db, hourStart, { schemaVersion = '2' } = {}) {
  const projectionTables = compactTables(db, schemaVersion).has('compact_projection_hours');
  const [hour = null] = storedHours(db, { projectionTables, hourStart });
  return { hour, newestHour: db.prepare('SELECT MAX(hour_start) AS hour FROM compact_hours').get().hour,
    v3Coverage: coverageOf(db, 'uniswap_v3_pool'), v4Coverage: coverageOf(db, 'uniswap_v4_pool') };
}

// Returns { reason, needs: { name: true }, blocked: { name: blocker }, state }. reason: hour_missing | outside_retention.
export function planProjectionRepair({ hour, newestHour, v3Coverage, v4Coverage }) {
  if (!hour) return { reason: 'hour_missing', needs: {}, blocked: {}, state: null };
  if (hour.hourStart <= poolHourCutoff(newestHour)) return { reason: 'outside_retention', needs: {}, blocked: {}, state: null };
  const state = projectionRepairState({
    families: Object.fromEntries(Object.values(POOL_PROJECTION_FAMILY).map((family) => [family, hour.families[family].status])),
    projections: Object.fromEntries(PROJECTIONS.map((name) => [name, hour.projections[name] ?? null])),
    firstBlock: hour.firstBlock, lastBlock: hour.lastBlock, coverage: { uniswap_v3_pools: v3Coverage, uniswap_v4_pools: v4Coverage } });
  const pools = Object.keys(POOL_PROJECTION_FAMILY);
  return { reason: null, state,
    needs: Object.fromEntries(pools.filter((name) => state[name].repair === 'eligible').map((name) => [name, true])),
    blocked: Object.fromEntries(pools.filter((name) => state[name].repair === 'blocked').map((name) => [name, state[name].blocker])) };
}

// ---------------------------------------------------------------------------------------------------------------------
// Dry-run plan (pure). Without provider splits, an hour of B blocks costs ceil(B / 500) eth_getLogs per stream, and the
// boundary check costs one batched request per 50 headers (2 per hour): ceil(2N / 50).

export function contiguityOf(hours) {
  const gaps = [];
  for (let index = 1; index < hours.length; index++) {
    const previous = hours[index - 1];
    const hour = hours[index];
    if (hour.hourStart !== previous.hourStart + HOUR) gaps.push({ after: previous.hourStart, kind: 'hour_gap' });
    else if (hour.firstBlock !== previous.lastBlock + 1) gaps.push({ after: previous.hourStart, kind: 'block_gap' });
    else if (hour.parentHash !== previous.lastHash) gaps.push({ after: previous.hourStart, kind: 'hash_link' });
  }
  return { contiguous: gaps.length === 0, gaps };
}

export function planProjectionBackfill(inputs, { pacingMs = DEFAULT_PACING_MS, chunkBlocks = DENSE_LOG_RANGE_BLOCKS } = {}) {
  const { hours } = inputs;
  const blocksOf = (hour) => hour.lastBlock - hour.firstBlock + 1;
  const requestsOf = (hour) => Math.ceil(blocksOf(hour) / chunkBlocks);
  const newest = hours.length ? hours.at(-1).hourStart : null;
  const cutoff = newest === null ? null : poolHourCutoff(newest);
  const retained = hours.filter((hour) => hour.hourStart > cutoff);
  const skipped = { familyUnavailable: 0, alreadyAvailable: 0 };
  const targets = [];
  for (const hour of retained) {
    const needs = {};
    for (const name of Object.keys(PROJECTION_BACKFILL_STREAMS)) {
      if (hour.projections[name] === 'available') { skipped.alreadyAvailable += 1; continue; }
      if (hour.families[FAMILY_OF[name]].status !== 'available') { skipped.familyUnavailable += 1; continue; }
      needs[name] = true;
    }
    if (Object.keys(needs).length) targets.push({ ...hour, needs });
  }
  const v3Hours = targets.filter((hour) => hour.needs.uniswap_v3_pools);
  const v4Hours = targets.filter((hour) => hour.needs.uniswap_v4_pools);
  const v3Requests = v3Hours.reduce((total, hour) => total + requestsOf(hour), 0);
  const v4Requests = v4Hours.reduce((total, hour) => total + requestsOf(hour), 0);
  const boundaryRequests = Math.ceil((2 * targets.length) / BOUNDARY_BATCH_SIZE);
  const totalRequests = v3Requests + v4Requests + boundaryRequests + (targets.length ? CHAIN_CHECK_REQUESTS : 0);
  const blockers = [];
  const v3Through = Math.max(0, ...v3Hours.map((hour) => hour.lastBlock));
  if (v3Hours.length && (!inputs.v3Coverage || inputs.v3Coverage.through < v3Through)) blockers.push('v3_registry_behind');
  // Rows per stored hour: at least one per pool with swaps (the stored family counter); pools with only liquidity
  // changes add a few more. Activity is bounded by count, not time.
  const poolRows = (hour) => (hour.families.uniswapV3.poolsWithSwaps ?? 0) + (hour.families.uniswapV4.poolsWithSwaps ?? 0);
  const estimatedPoolRows = targets.reduce((total, hour) => total + poolRows(hour), 0);
  const known = hours.filter((hour) => hour.families.uniswapV3.status === 'available' && hour.families.uniswapV4.status === 'available');
  const averagePoolRowsPerHour = known.length ? known.reduce((total, hour) => total + poolRows(hour), 0) / known.length : null;
  const thirtyDayBytes = averagePoolRowsPerHour === null ? null : Math.round(30 * 24 * (averagePoolRowsPerHour * POOL_HOUR_ROW_BYTES
    + PROJECTIONS.length * PROJECTION_STATUS_ROW_BYTES) + ACTIVITY_KINDS.length * ACTIVITY_ROWS_PER_KIND * ACTIVITY_ROW_BYTES);
  return {
    storedHours: hours.length,
    earliestHour: hours.length ? hours[0].hourStart : null,
    latestHour: newest,
    totalBlocks: hours.reduce((total, hour) => total + blocksOf(hour), 0),
    ...contiguityOf(hours),
    retentionHours: POOL_HOUR_RETENTION_HOURS,
    retentionCutoff: cutoff,
    targets,
    targetHours: targets.length,
    targetBlocks: targets.reduce((total, hour) => total + blocksOf(hour), 0),
    v3Hours: v3Hours.length,
    v4Hours: v4Hours.length,
    skipped,
    v3Requests,
    v4Requests,
    boundaryRequests,
    totalRequests,
    pacingMs,
    durationSeconds: Math.round((totalRequests * pacingMs) / 1000),
    durationSecondsAt1000Ms: totalRequests,
    estimatedPoolRows,
    estimatedBytes: estimatedPoolRows * POOL_HOUR_ROW_BYTES + targets.length * PROJECTIONS.length * PROJECTION_STATUS_ROW_BYTES,
    averagePoolRowsPerHour,
    thirtyDayBytes,
    blockers,
  };
}

// V4 registry bootstrap (no coverage) or catch-up, up to the checkpoint's last block. deployment: a probe result
// ({ block, requests, method }) or null; fromBlock: an operator-supplied candidate.
export function planV4Registry(inputs, { pacingMs = DEFAULT_PACING_MS, deployment = null, fromBlock = null } = {}) {
  const target = inputs.checkpoint?.lastBlock ?? null;
  const base = { target, pools: inputs.v4Pools, pacingMs };
  if (target === null) return { ...base, mode: 'blocked', reason: 'no_checkpoint', requests: 0, durationSeconds: 0 };
  if (inputs.v4Coverage) {
    const from = inputs.v4Coverage.through + 1;
    const requests = target >= from ? v4RegistryScanRequests(from, target, { bootstrap: false }) + CHAIN_CHECK_REQUESTS : 0;
    return { ...base, mode: requests ? 'catchup' : 'covered', coverage: inputs.v4Coverage, fromBlock: from, requests,
      durationSeconds: Math.round((requests * pacingMs) / 1000) };
  }
  const candidate = deployment?.block ?? fromBlock;
  const method = deployment ? deployment.method : fromBlock !== null ? 'operator_supplied' : 'unknown';
  const probeRequests = Math.ceil(Math.log2(Math.max(2, target))) + 2;
  const requests = candidate === null ? null : v4RegistryScanRequests(candidate, target) + CHAIN_CHECK_REQUESTS;
  const upperBound = v4RegistryScanRequests(0, target) + CHAIN_CHECK_REQUESTS;
  return { ...base, mode: 'bootstrap', candidate, method, probeRequests: deployment?.requests ?? probeRequests, requests,
    durationSeconds: requests === null ? null : Math.round((requests * pacingMs) / 1000), upperBoundFromGenesis: upperBound,
    upperBoundSeconds: Math.round((upperBound * pacingMs) / 1000) };
}

export function formatPlan(plan, v4Plan) {
  const at = (seconds) => (seconds === null ? 'none' : iso(seconds));
  const lines = [
    `STORED_HOURS ${plan.storedHours}`,
    `EARLIEST_HOUR ${at(plan.earliestHour)}`,
    `LATEST_HOUR ${at(plan.latestHour)}`,
    `TOTAL_BLOCKS ${plan.totalBlocks}`,
    `CONTIGUITY ${plan.contiguous ? 'contiguous' : `gaps=${plan.gaps.length} ${plan.gaps.slice(0, 5).map((gap) => `${gap.kind}@${at(gap.after)}`).join(',')}`}`,
    `RETENTION ${plan.retentionHours}h cutoff=${at(plan.retentionCutoff)}`,
    `TARGET_HOURS any=${plan.targetHours} v3=${plan.v3Hours} v4=${plan.v4Hours} blocks=${plan.targetBlocks} `
      + `skipped_available=${plan.skipped.alreadyAvailable} skipped_family_unavailable=${plan.skipped.familyUnavailable}`,
    `V3_REQUESTS ${plan.v3Requests} (sum of ceil(blocks/500) per hour, eth_getLogs v3Pools)`,
    `V4_REQUESTS ${plan.v4Requests} (sum of ceil(blocks/500) per hour, eth_getLogs v4)`,
    `BOUNDARY_REQUESTS ${plan.boundaryRequests} (ceil(2 x ${plan.targetHours} / ${BOUNDARY_BATCH_SIZE}) batched eth_getBlockByNumber)`,
    `TOTAL_REQUESTS ${plan.totalRequests} (including ${plan.targetHours ? CHAIN_CHECK_REQUESTS : 0} eth_chainId check)`,
    `DURATION_AT_1000MS ${plan.durationSecondsAt1000Ms}s`,
    `DURATION_AT_PACING ${plan.durationSeconds}s pacing_ms=${plan.pacingMs}`,
    `ESTIMATED_POOL_ROWS ${plan.estimatedPoolRows} bytes~${plan.estimatedBytes}`,
    `PROJECTION_30D_BYTES ${plan.thirtyDayBytes ?? 'unknown'} avg_pool_rows_per_hour=${plan.averagePoolRowsPerHour === null ? 'unknown'
      : Math.round(plan.averagePoolRowsPerHour)}`,
    `BLOCKERS ${plan.blockers.length ? plan.blockers.join(',') : 'none'}`,
  ];
  if (v4Plan) {
    lines.push(v4Plan.mode === 'bootstrap'
      ? `V4_REGISTRY mode=bootstrap candidate=${v4Plan.candidate ?? 'unknown'} method=${v4Plan.method} target=${v4Plan.target} `
        + `requests=${v4Plan.requests ?? 'unknown'} duration_s=${v4Plan.durationSeconds ?? 'unknown'} probe_requests<=${v4Plan.probeRequests} `
        + `upper_bound_from_genesis=${v4Plan.upperBoundFromGenesis} (${v4Plan.upperBoundSeconds}s) stored_pools=${v4Plan.pools}`
      : `V4_REGISTRY mode=${v4Plan.mode} target=${v4Plan.target} from=${v4Plan.fromBlock ?? 'none'} requests=${v4Plan.requests} `
        + `duration_s=${v4Plan.durationSeconds} stored_pools=${v4Plan.pools}${v4Plan.reason ? ` reason=${v4Plan.reason}` : ''}`);
  }
  return lines;
}

// ---------------------------------------------------------------------------------------------------------------------
// Execution (only from the CLI with an explicit execute flag).

// Every stored hour boundary must still be this chain's block: first and last block headers, 50 per batched request.
// Returns the set of hour starts whose stored hashes no longer match.
export async function verifyStoredBoundaries(provider, hours) {
  const checks = hours.flatMap((hour) => [[hour.firstBlock, hour.firstHash, hour.hourStart], [hour.lastBlock, hour.lastHash, hour.hourStart]]);
  const failed = new Set();
  for (let offset = 0; offset < checks.length; offset += BOUNDARY_BATCH_SIZE) {
    const chunk = checks.slice(offset, offset + BOUNDARY_BATCH_SIZE);
    const answers = await provider.batch(chunk.map(([number]) => ['eth_getBlockByNumber', [hex(number), false]]));
    chunk.forEach(([number, hash, hourStart], index) => {
      let actual = null;
      try { actual = headerOf(answers[index], number).hash; } catch { /* a malformed header fails the hour */ }
      if (actual !== hash) failed.add(hourStart);
    });
  }
  return failed;
}

// One response of a projection stream, without a spine: in range, from the stream's emitter and topics, never removed or
// duplicated, one hash per block, and the stored hash at the hour's first and last block.
export function validateBackfillLogs(rawLogs, stream, { fromBlock, toBlock, seen, hashes }) {
  const logs = [];
  for (const raw of rawLogs) {
    if (raw?.removed === true) throw new LogError('removed_log');
    let log;
    try { log = normalizeLog(raw); } catch { throw new LogError('malformed_log'); }
    if (log.blockNumber < fromBlock || log.blockNumber > toBlock) throw new LogError('log_outside_range', log.blockNumber);
    if (stream.address && !stream.address.includes(log.address)) throw new LogError('unexpected_log_address', log.blockNumber);
    if (!stream.topics.includes(log.topics[0])) throw new LogError('unexpected_log_topic', log.blockNumber);
    if (!log.blockHash || !log.transactionHash || log.transactionIndex === null) throw new LogError('malformed_log', log.blockNumber);
    if ((hashes.get(log.blockNumber) ?? log.blockHash) !== log.blockHash) throw new LogError('log_block_hash_mismatch', log.blockNumber);
    hashes.set(log.blockNumber, log.blockHash);
    const key = `${log.blockNumber}:${log.logIndex}`;
    if (seen.has(key)) throw new LogError('duplicate_log', log.blockNumber);
    seen.add(key);
    logs.push(log);
  }
  return logs.sort((left, right) => left.blockNumber - right.blockNumber || left.logIndex - right.logIndex);
}

const V3_DECODERS = Object.freeze({ [UNISWAP_EVENT_TOPICS.v3Swap]: ['swap', decodeV3Swap], [UNISWAP_EVENT_TOPICS.v3Mint]: ['mint', decodeV3Mint],
  [UNISWAP_EVENT_TOPICS.v3Burn]: ['burn', decodeV3Burn] });
const V4_DECODERS = Object.freeze({ [UNISWAP_EVENT_TOPICS.v4Swap]: ['swap', decodeV4Swap],
  [UNISWAP_EVENT_TOPICS.v4ModifyLiquidity]: ['modify', decodeV4ModifyLiquidity], [UNISWAP_EVENT_TOPICS.v4Initialize]: ['initialize', decodeV4Initialize] });

// Projections of one stored hour from its two Uniswap streams only. hour: a readBackfillInputs hour with `needs`.
// v3Pools: Set of official V3 pool addresses covering the hour (the stored registry). Returns the sink result, which
// commitProjectionHour reconciles against the stored family counters before writing.
export async function backfillProjectionHour({ provider, hour, v3Pools }) {
  const sink = createProjectionSink({ activity: false });
  const seen = new Set();
  const hashes = new Map([[hour.firstBlock, hour.firstHash], [hour.lastBlock, hour.lastHash]]);
  for (const [name, stream] of Object.entries(PROJECTION_BACKFILL_STREAMS)) {
    if (!hour.needs[name]) continue;
    for await (const response of streamLogs(provider, stream, hour.firstBlock, hour.lastBlock)) {
      for (const log of validateBackfillLogs(response, stream, { fromBlock: hour.firstBlock, toBlock: hour.lastBlock, seen, hashes })) {
        if (name === 'uniswap_v3_pools') {
          if (!v3Pools.has(log.address)) continue; // foreign V3-signature emitter: never a pool row
          const [kind, decode] = V3_DECODERS[log.topics[0]];
          const event = decode(log);
          if (!event) throw new LogError('malformed_v3_pool_event', log.blockNumber);
          sink.v3(kind, log, event, null);
        } else {
          const [kind, decode] = V4_DECODERS[log.topics[0]];
          const event = decode(log);
          if (!event) throw new LogError('malformed_v4_event', log.blockNumber);
          sink.v4(kind, log, event, null);
        }
      }
    }
  }
  return sink.finish({ families: hour.families, hourStart: null, firstBlock: hour.firstBlock, lastBlock: hour.lastBlock });
}

// Runs a plan: boundary check for every target hour, then one projection commit per hour. A provider failure stops the
// run (nothing partial: each hour commits alone); a log or boundary problem skips only that hour.
export async function runProjectionBackfill({ store, provider, plan, v3Pools, print = () => {} }) {
  if (plan.blockers.length) throw new BackfillError(plan.blockers[0]);
  const report = { committed: 0, skipped: [], outcomes: {} };
  const failed = await verifyStoredBoundaries(provider, plan.targets);
  for (const hour of plan.targets) {
    if (failed.has(hour.hourStart)) {
      report.skipped.push({ hour: iso(hour.hourStart), reason: 'boundary_hash_mismatch' });
      continue;
    }
    let projections;
    try {
      projections = await backfillProjectionHour({ provider, hour, v3Pools });
    } catch (error) {
      if (error instanceof ProviderError || !(error instanceof LogError)) throw error;
      report.skipped.push({ hour: iso(hour.hourStart), reason: error.code });
      continue;
    }
    const outcome = store.commitProjectionHour(hour.hourStart, projections);
    report.committed += 1;
    for (const [name, value] of Object.entries(outcome)) report.outcomes[`${name}:${value}`] = (report.outcomes[`${name}:${value}`] ?? 0) + 1;
    print(`BACKFILL_HOUR ${iso(hour.hourStart)} ${Object.entries(outcome).map(([name, value]) => `${name}=${value}`).join(' ')}`);
  }
  return report;
}
