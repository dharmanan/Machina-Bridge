// Compact engine: historical valuation backfill (Phase 1D.1). For the latest committed hours (24 by default, at most 72)
// it makes the hours' valuations (token prices, DEX USD volume, swap fees) exist when they can be made safely:
// - an hour whose valuation inputs (pool price paths, V4 swap fees) are missing while its pool projections are available
//   re-reads only the two Uniswap log streams it needs (v3Pools for V3, v4 for V4, 500 blocks per eth_getLogs, after a
//   batched check of the stored first/last block hashes), exactly like the projection backfill, and writes only those
//   inputs; store.js reconciles them with the hour's STORED family counters and derives the valuations in the same commit;
// - an hour whose inputs are complete but whose valuations are missing or unavailable is re-derived with no RPC at all;
// - an hour without both pool projections, with a family unavailable or a V3 registry behind it, is reported blocked and
//   never touched (the projection self-heal or projection backfill comes first).
// It never writes compact_hours, compact_family_hours, compact_hour_addresses or the checkpoint, never replays an hour,
// never fetches a block body or receipt, and keeps no log: every response is reduced to projection rows in memory.
// Storage: it persists compact hourly rows only (VALUATION_BACKFILL_TABLES): one price-path row per pool with swaps, one V4
// swap-fee row per V4 pool with swaps, status rows, at most one price row per verified asset and two volume and two fee rows
// per hour. Never a raw log, transaction, receipt, block or per-swap row, and never the per-event activity feed.
// Nothing here runs by itself: scripts/backfill-arc-intelligence-valuations.mjs plans by default and writes only on request.
import { LogError } from './logs.js';
import {
  backfillProjectionHour, BOUNDARY_BATCH_SIZE, CHAIN_CHECK_REQUESTS, DEFAULT_PACING_MS, verifyStoredBoundaries,
} from './projection-backfill.js';
import { poolHourCutoff, POOL_PROJECTION_FAMILY, VALUATION_INPUTS_OF_POOLS } from './projections.js';
import { ProviderError } from './provider.js';
import { DENSE_LOG_RANGE_BLOCKS } from './sources.js';
import { PRICEABLE_TOKENS, VALUATIONS } from './valuation.js';

export const DEFAULT_VALUATION_HOURS = 24;
export const MAX_VALUATION_HOURS = 72;
const HOUR = 3600;
const iso = (seconds) => new Date(seconds * 1000).toISOString();
const POOLS = Object.freeze(Object.keys(POOL_PROJECTION_FAMILY)); // uniswap_v3_pools, uniswap_v4_pools
// The only tables a valuation backfill may write, and an estimate of each row's stored size (payload, key and overhead).
export const VALUATION_BACKFILL_TABLES = Object.freeze(['compact_pool_price_hours', 'compact_pool_fee_hours', 'compact_projection_hours',
  'compact_valuation_hours', 'compact_token_price_hours', 'compact_dex_volume_hours', 'compact_dex_fee_hours']);
export const ROW_BYTES = Object.freeze({ pricePath: 420, swapFee: 260, status: 120, volume: 110, fee: 110, tokenPrice: 200 });

export class ValuationBackfillError extends Error {
  constructor(code) { super(code); this.code = code; }
}

// ---------------------------------------------------------------------------------------------------------------------
// Inputs, read-only (the CLI opens the database with readOnly and query_only). A database written before valuations
// existed has no valuation tables yet: every valuation then reads as missing.

const tableSet = (db) => new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name GLOB 'compact_*'").all().map((row) => row.name));

export function readValuationInputs(db, { hours = DEFAULT_VALUATION_HOURS, schemaVersion = '2' } = {}) {
  const tables = tableSet(db);
  if (!tables.has('compact_meta') || !tables.has('compact_hours')) throw new ValuationBackfillError('database_not_compact');
  if (db.prepare("SELECT value FROM compact_meta WHERE key = 'schema_version'").get()?.value !== schemaVersion) {
    throw new ValuationBackfillError('schema_version_mismatch');
  }
  const checkpoint = db.prepare('SELECT hour_start, last_block FROM compact_checkpoint WHERE id = 1').get();
  if (!checkpoint) throw new ValuationBackfillError('no_checkpoint');
  const toHour = checkpoint.hour_start;
  const fromHour = toHour - (hours - 1) * HOUR;
  const statuses = (table, key) => {
    const out = new Map();
    if (!tables.has(table)) return out;
    for (const row of db.prepare(`SELECT hour_start, ${key} AS name, status, reason FROM ${table} WHERE hour_start BETWEEN ? AND ?`)
      .all(BigInt(fromHour), BigInt(toHour))) {
      if (!out.has(row.hour_start)) out.set(row.hour_start, {});
      out.get(row.hour_start)[row.name] = { status: row.status, reason: row.reason };
    }
    return out;
  };
  const projections = statuses('compact_projection_hours', 'projection');
  const valuations = statuses('compact_valuation_hours', 'valuation');
  const familyOf = (status, json) => (status === 'available' ? { status, ...JSON.parse(json) } : { status: status ?? 'missing' });
  const hourRows = db.prepare(`SELECT h.hour_start, h.first_block, h.last_block, h.first_hash, h.last_hash,
      v3.status AS v3_status, v3.metrics_json AS v3_metrics, v4.status AS v4_status, v4.metrics_json AS v4_metrics
    FROM compact_hours h
    LEFT JOIN compact_family_hours v3 ON v3.hour_start = h.hour_start AND v3.family = 'uniswapV3'
    LEFT JOIN compact_family_hours v4 ON v4.hour_start = h.hour_start AND v4.family = 'uniswapV4'
    WHERE h.hour_start BETWEEN ? AND ? ORDER BY h.hour_start`).all(BigInt(fromHour), BigInt(toHour)).map((row) => ({
    hourStart: row.hour_start, firstBlock: row.first_block, lastBlock: row.last_block, firstHash: row.first_hash, lastHash: row.last_hash,
    families: { uniswapV3: familyOf(row.v3_status, row.v3_metrics), uniswapV4: familyOf(row.v4_status, row.v4_metrics) },
    projections: projections.get(row.hour_start) ?? {}, valuations: valuations.get(row.hour_start) ?? {} }));
  const coverage = db.prepare("SELECT through_block FROM compact_registry_coverage WHERE kind = 'uniswap_v3_pool'").get();
  return { hours, fromHour, toHour, newestHour: db.prepare('SELECT MAX(hour_start) AS hour FROM compact_hours').get().hour,
    valuationTables: tables.has('compact_valuation_hours'), v3Through: coverage?.through_block ?? null, hourRows };
}

// ---------------------------------------------------------------------------------------------------------------------
// Plan (pure). One entry per target hour: valued | refetch | derive | blocked.

export function planHour(hour, { v3Through }) {
  const valuationStatus = Object.fromEntries(VALUATIONS.map((name) => [name, hour.valuations[name]?.status ?? null]));
  const base = { hourStart: hour.hourStart, valuationStatus, missingInputs: [], refetch: {}, blockers: [] };
  if (VALUATIONS.every((name) => valuationStatus[name] === 'available')) return { ...base, action: 'valued' };
  for (const pools of POOLS) {
    const family = POOL_PROJECTION_FAMILY[pools];
    const tag = pools === 'uniswap_v3_pools' ? 'v3' : 'v4';
    if (hour.families[family].status !== 'available') base.blockers.push(`${tag}_family_unavailable`);
    else if (hour.projections[pools]?.status !== 'available') base.blockers.push(`${tag}_pool_projection_unavailable`);
    const missing = VALUATION_INPUTS_OF_POOLS[pools].filter((name) => hour.projections[name]?.status !== 'available');
    if (!missing.length) continue;
    base.missingInputs.push(...missing);
    if (pools === 'uniswap_v3_pools' && (v3Through === null || v3Through < hour.lastBlock)) base.blockers.push('v3_registry_behind');
    else base.refetch[pools] = true;
  }
  if (base.blockers.length) return { ...base, action: 'blocked', refetch: {} };
  return { ...base, action: Object.keys(base.refetch).length ? 'refetch' : 'derive' };
}

export function planValuationBackfill(inputs, { pacingMs = DEFAULT_PACING_MS, chunkBlocks = DENSE_LOG_RANGE_BLOCKS } = {}) {
  const cutoff = inputs.newestHour === null ? null : poolHourCutoff(inputs.newestHour);
  const outside = inputs.hourRows.filter((hour) => cutoff !== null && hour.hourStart <= cutoff).length;
  const entries = inputs.hourRows.filter((hour) => cutoff === null || hour.hourStart > cutoff).map((hour) => ({ ...planHour(hour, inputs), hour }));
  const count = (action) => entries.filter((entry) => entry.action === action).length;
  const requestsOf = (hour) => Math.ceil((hour.lastBlock - hour.firstBlock + 1) / chunkBlocks);
  const refetch = entries.filter((entry) => entry.action === 'refetch');
  const v3Requests = refetch.filter((entry) => entry.refetch.uniswap_v3_pools).reduce((total, entry) => total + requestsOf(entry.hour), 0);
  const v4Requests = refetch.filter((entry) => entry.refetch.uniswap_v4_pools).reduce((total, entry) => total + requestsOf(entry.hour), 0);
  const boundaryRequests = Math.ceil((2 * refetch.length) / BOUNDARY_BATCH_SIZE);
  const totalRequests = v3Requests + v4Requests + boundaryRequests + (refetch.length ? CHAIN_CHECK_REQUESTS : 0);
  const touched = entries.filter((entry) => entry.action === 'refetch' || entry.action === 'derive');
  // Rows written: one price path (and V4 fee) row per pool with swaps (the stored poolsWithSwaps counters), three valuation
  // status rows, two volume and two fee rows per hour, and at most one price row per verified asset.
  const poolsWithSwaps = (entry, family) => entry.hour.families[family].poolsWithSwaps ?? 0;
  const pricePathRows = refetch.reduce((total, entry) => total + (entry.refetch.uniswap_v3_pools ? poolsWithSwaps(entry, 'uniswapV3') : 0)
    + (entry.refetch.uniswap_v4_pools ? poolsWithSwaps(entry, 'uniswapV4') : 0), 0);
  const swapFeeRows = refetch.reduce((total, entry) => total + (entry.missingInputs.includes('uniswap_v4_swap_fees') ? poolsWithSwaps(entry, 'uniswapV4') : 0), 0);
  const reasons = {};
  for (const entry of entries) {
    for (const [name, status] of Object.entries(entry.valuationStatus)) {
      if (status === 'available') continue;
      const reason = status === null ? 'not_processed' : entry.hour.valuations[name]?.reason ?? 'unavailable';
      reasons[`${name}:${reason}`] = (reasons[`${name}:${reason}`] ?? 0) + 1;
    }
  }
  const blockers = {};
  for (const entry of entries) for (const blocker of entry.blockers) blockers[blocker] = (blockers[blocker] ?? 0) + 1;
  return {
    hours: inputs.hours,
    fromHour: inputs.fromHour,
    toHour: inputs.toHour,
    targetHours: entries.length,
    outsideRetention: outside,
    alreadyValued: count('valued'),
    missingValuationHours: entries.length - count('valued'),
    missingPricePathHours: entries.filter((entry) => entry.missingInputs.some((name) => name.endsWith('_price_paths'))).length,
    missingSwapFeeHours: entries.filter((entry) => entry.missingInputs.includes('uniswap_v4_swap_fees')).length,
    refetchHours: refetch.length,
    refetchV3Hours: refetch.filter((entry) => entry.refetch.uniswap_v3_pools).length,
    refetchV4Hours: refetch.filter((entry) => entry.refetch.uniswap_v4_pools).length,
    deriveHours: count('derive'),
    blockedHours: count('blocked'),
    blockers,
    v3Requests,
    v4Requests,
    boundaryRequests,
    totalRequests,
    pacingMs,
    durationSeconds: Math.round((totalRequests * pacingMs) / 1000),
    expectedWrites: (() => {
      const writes = { pricePathRows, swapFeeRows, projectionStatusRows: refetch.reduce((total, entry) => total + entry.missingInputs.length, 0),
        valuationStatusRows: touched.length * VALUATIONS.length, volumeRows: touched.length * 2, feeRows: touched.length * 2,
        tokenPriceRowsAtMost: touched.length * PRICEABLE_TOKENS.length };
      writes.totalRowsAtMost = Object.values(writes).reduce((total, value) => total + value, 0);
      writes.estimatedBytes = pricePathRows * ROW_BYTES.pricePath + swapFeeRows * ROW_BYTES.swapFee
        + (writes.projectionStatusRows + writes.valuationStatusRows) * ROW_BYTES.status + writes.volumeRows * ROW_BYTES.volume
        + writes.feeRows * ROW_BYTES.fee + writes.tokenPriceRowsAtMost * ROW_BYTES.tokenPrice;
      return writes;
    })(),
    unavailableReasons: reasons,
    valuationTables: inputs.valuationTables,
    entries,
  };
}

export function formatValuationPlan(plan) {
  const at = (seconds) => iso(seconds);
  const object = (value) => (Object.keys(value).length ? JSON.stringify(value) : 'none');
  return [
    `TARGET_HOURS ${plan.targetHours} requested=${plan.hours} from=${at(plan.fromHour)} to=${at(plan.toHour)} outside_retention=${plan.outsideRetention}`,
    `VALUATION_TABLES ${plan.valuationTables ? 'present' : 'missing (created by the first write)'}`,
    `ALREADY_VALUED_HOURS ${plan.alreadyValued}`,
    `MISSING_VALUATION_HOURS ${plan.missingValuationHours}`,
    `MISSING_PRICE_PATH_HOURS ${plan.missingPricePathHours}`,
    `MISSING_SWAP_FEE_HOURS ${plan.missingSwapFeeHours}`,
    `REFETCH_HOURS ${plan.refetchHours} v3=${plan.refetchV3Hours} v4=${plan.refetchV4Hours}`,
    `DERIVE_ONLY_HOURS ${plan.deriveHours} (no RPC)`,
    `BLOCKED_HOURS ${plan.blockedHours} blockers=${object(plan.blockers)}`,
    `ESTIMATED_GETLOGS v3=${plan.v3Requests} v4=${plan.v4Requests} (sum of ceil(blocks/500) per hour and stream)`,
    `ESTIMATED_REQUESTS total=${plan.totalRequests} boundary_batches=${plan.boundaryRequests} chain_check=${plan.refetchHours ? CHAIN_CHECK_REQUESTS : 0}`,
    `DURATION_AT_PACING ${plan.durationSeconds}s pacing_ms=${plan.pacingMs}`,
    `EXPECTED_PERSISTENT_WRITES compact hourly rows only: price_path_rows~${plan.expectedWrites.pricePathRows} `
      + `swap_fee_rows~${plan.expectedWrites.swapFeeRows} projection_status_rows<=${plan.expectedWrites.projectionStatusRows} `
      + `valuation_status_rows<=${plan.expectedWrites.valuationStatusRows} volume_rows<=${plan.expectedWrites.volumeRows} `
      + `fee_rows<=${plan.expectedWrites.feeRows} token_price_rows<=${plan.expectedWrites.tokenPriceRowsAtMost} `
      + `total_rows<=${plan.expectedWrites.totalRowsAtMost} estimated_bytes~${plan.expectedWrites.estimatedBytes}`,
    `STORAGE raw logs=0 transactions=0 receipts=0 blocks=0 per_swap_rows=0 tables=${VALUATION_BACKFILL_TABLES.join(',')}`,
    `UNAVAILABLE_REASONS ${object(plan.unavailableReasons)}`,
    ...plan.entries.filter((entry) => entry.action !== 'valued').map((entry) => `HOUR ${at(entry.hourStart)} action=${entry.action}`
      + `${entry.missingInputs.length ? ` missing=${entry.missingInputs.join(',')}` : ''}${entry.blockers.length ? ` blockers=${entry.blockers.join(',')}` : ''}`),
  ];
}

// ---------------------------------------------------------------------------------------------------------------------
// Execution (only from the CLI with --execute and COMPACT_VALUATION_BACKFILL_EXECUTE=yes).

// Storage guard: a valuation backfill only ever writes compact hourly rows. A plan whose estimate is beyond these bounds
// (far more pools with swaps than Arc has, or more bytes than hourly rows can take) is refused before anything is written.
export const MAX_ROWS_PER_HOUR = 50_000;
export const MAX_ESTIMATED_BYTES = 128 * 1024 * 1024;
export function storageGuard(plan) {
  const touched = plan.entries.filter((entry) => entry.action === 'refetch' || entry.action === 'derive').length;
  if (Object.values(plan.expectedWrites).some((value) => !Number.isSafeInteger(value) || value < 0)) {
    return 'storage_estimate_abnormal';
  }
  if (plan.expectedWrites.estimatedBytes > MAX_ESTIMATED_BYTES) return 'storage_estimate_abnormal';
  if (touched && plan.expectedWrites.totalRowsAtMost / touched > MAX_ROWS_PER_HOUR) return 'storage_estimate_abnormal';
  return null;
}

// store: an open compact store (writer). provider: created by the caller, used only when an hour needs a log re-read.
// Fail closed: a provider failure, a stored boundary hash that no longer matches the chain, or an inconsistent log response
// stops the whole run with the hour and reason; nothing is skipped silently. Every hour commits alone (bounded
// transactions), so the hours already done stay valid and a failed hour leaves the others untouched. Idempotent: a second
// run finds the hours valued and writes nothing; available projections and valuations are never replaced.
export async function runValuationBackfill({ store, provider, plan, v3Pools, print = () => {} }) {
  const report = { refetched: 0, derived: 0, skipped: [], outcomes: {} };
  const refetch = plan.entries.filter((entry) => entry.action === 'refetch');
  const failed = refetch.length ? await verifyStoredBoundaries(provider, refetch.map((entry) => entry.hour)) : new Set();
  if (failed.size) {
    throw Object.assign(new ValuationBackfillError('boundary_hash_mismatch'), { hours: [...failed].sort((left, right) => left - right).map(iso) });
  }
  const note = (entry, valuations) => {
    for (const row of valuations) {
      const key = `${row.valuation}:${row.status === 'available' ? 'available' : `unavailable(${row.reason})`}`;
      report.outcomes[key] = (report.outcomes[key] ?? 0) + 1;
    }
    print(`VALUATION_HOUR ${iso(entry.hourStart)} action=${entry.action} ${valuations.map((row) => `${row.valuation}=${row.status === 'available'
      ? 'available' : `unavailable(${row.reason})`}`).join(' ')}`);
  };
  for (const entry of plan.entries) {
    if (entry.action === 'refetch') {
      let projections;
      try {
        projections = await backfillProjectionHour({ provider, hour: { ...entry.hour, needs: entry.refetch }, v3Pools });
      } catch (error) {
        if (error instanceof LogError || error instanceof ProviderError) error.hour = iso(entry.hourStart);
        throw error;
      }
      // Only the missing inputs of the streams that were re-read; available projections stay exactly as stored.
      const only = Object.keys(entry.refetch).flatMap((pools) => VALUATION_INPUTS_OF_POOLS[pools]).filter((name) => entry.missingInputs.includes(name));
      store.commitProjectionHour(entry.hourStart, projections, { only });
      report.refetched += 1;
      note(entry, store.rederiveValuations(entry.hourStart));
    } else if (entry.action === 'derive') {
      report.derived += 1;
      note(entry, store.rederiveValuations(entry.hourStart));
    }
  }
  return report;
}
