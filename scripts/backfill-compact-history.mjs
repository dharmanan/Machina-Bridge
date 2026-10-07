// Bounded, resumable historical compact backfill for Arc public mainnet.
// Default mode is read-only plan. --probe validates the public-mainnet reporting boundary and probes the next
// historical hour, but still writes nothing. --execute is the only mode that writes.
//
// Every written hour is prepended atomically exactly one hour before the oldest stored hour. The normal live checkpoint
// never moves backward or changes. A stopped run therefore resumes from durable SQLite state, without a /tmp checkpoint.
//
// Arc's chain existed as private mainnet before the public launch. The product history boundary is therefore the
// public-mainnet go-live announcement, 2026-09-16T10:30:00Z. The partial 10:00-11:00 UTC launch hour is excluded;
// the first complete public-mainnet UTC hour is 2026-09-16T11:00:00Z. Pre-public private-mainnet data is never backfilled.
//
// Examples:
//   COMPACT_SQLITE_PATH=/data/arc-compact.sqlite node scripts/backfill-compact-history.mjs
//   COMPACT_SQLITE_PATH=/data/arc-compact.sqlite node scripts/backfill-compact-history.mjs --probe
//   COMPACT_SQLITE_PATH=/data/arc-compact.sqlite node scripts/backfill-compact-history.mjs --execute --max-hours=1
//   COMPACT_SQLITE_PATH=/data/arc-compact.sqlite node scripts/backfill-compact-history.mjs --execute --all
import { statSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { HOUR_SECONDS, locateHour, processHour } from '../server/compact/hour.js';
import { createProvider, ProviderError } from '../server/compact/provider.js';
import { createCompactStore } from '../server/compact/store.js';
import { acquireWriterLock, WriterLockError } from '../server/compact/writer-lock.js';
import { refreshDiscoverySafely } from '../server/compact/intelligence.js';

export const SAFE_HEAD_MARGIN_BLOCKS = 200;
export const DEFAULT_RPC_INTERVAL_MS = 1000;
export const MIN_RPC_INTERVAL_MS = 500;
const V3_KIND = 'uniswap_v3_pool';
const V4_KIND = 'uniswap_v4_pool';
const iso = (seconds) => new Date(seconds * 1000).toISOString();

export const ARC_PUBLIC_MAINNET_LIVE_AT = Date.parse('2026-09-16T10:30:00Z') / 1000;
export const ARC_PUBLIC_MAINNET_FIRST_COMPLETE_HOUR =
  Math.ceil(ARC_PUBLIC_MAINNET_LIVE_AT / HOUR_SECONDS) * HOUR_SECONDS;

export function discoverHistoryStart() {
  return {
    publicMainnetLiveAt: ARC_PUBLIC_MAINNET_LIVE_AT,
    firstCompleteHour: ARC_PUBLIC_MAINNET_FIRST_COMPLETE_HOUR,
  };
}

const intArg = (value, name) => {
  if (!/^\d+$/.test(value ?? '')) throw new Error(`invalid_${name}`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error(`invalid_${name}`);
  return parsed;
};

export function historyBackfillConfig({ argv = process.argv.slice(2), env = process.env } = {}) {
  const execute = argv.includes('--execute');
  const probe = argv.includes('--probe') || execute;
  const all = argv.includes('--all');
  const maxArg = argv.find((value) => value.startsWith('--max-hours='));
  if (all && maxArg) throw new Error('choose_all_or_max_hours');
  const allowed = argv.every((value) => value === '--execute' || value === '--probe' || value === '--all' || value.startsWith('--max-hours='));
  if (!allowed) throw new Error('unknown_argument');
  if (!execute && (all || maxArg)) throw new Error('execute_required_for_hour_limit');

  const sqlite = env.COMPACT_SQLITE_PATH?.trim();
  if (!sqlite || sqlite === ':memory:' || sqlite.startsWith('file:')) throw new Error('sqlite_path_required');
  const sqlitePath = resolve(sqlite);
  try { statSync(sqlitePath); } catch { throw new Error('sqlite_not_found'); }

  const pacing = env.COMPACT_RPC_MIN_INTERVAL_MS ?? String(DEFAULT_RPC_INTERVAL_MS);
  if (!/^\d+$/.test(pacing)) throw new Error('unsafe_rpc_pacing');
  const minIntervalMs = Number(pacing);
  if (!Number.isSafeInteger(minIntervalMs) || minIntervalMs < MIN_RPC_INTERVAL_MS) throw new Error('unsafe_rpc_pacing');

  return {
    sqlitePath, execute, probe, all,
    maxHours: maxArg ? intArg(maxArg.slice('--max-hours='.length), 'max_hours') : execute ? 1 : 0,
    minIntervalMs,
  };
}

async function openDatabase(sqlitePath, { readOnly = false } = {}) {
  const { DatabaseSync } = await import('node:sqlite');
  return readOnly
    ? new DatabaseSync(sqlitePath, { readOnly: true })
    : new DatabaseSync(sqlitePath);
}

export async function inspectHistory(sqlitePath, { historyStart = null } = {}) {
  const db = await openDatabase(sqlitePath, { readOnly: true });
  try {
    const row = db.prepare('SELECT COUNT(*) AS count, MIN(hour_start) AS earliest, MAX(hour_start) AS latest FROM compact_hours').get();
    const checkpoint = db.prepare('SELECT hour_start, last_block, last_hash FROM compact_checkpoint WHERE id = 1').get() ?? null;
    const coverageRows = db.prepare(`SELECT kind, from_block, through_block, through_hash FROM compact_registry_coverage
      WHERE kind IN (?, ?) ORDER BY kind`).all(V3_KIND, V4_KIND);
    const coverage = Object.fromEntries(coverageRows.map((entry) => [entry.kind, {
      fromBlock: entry.from_block, through: entry.through_block, throughHash: entry.through_hash,
    }]));
    const count = Number(row.count);
    const earliest = row.earliest === null ? null : Number(row.earliest);
    const latest = row.latest === null ? null : Number(row.latest);
    const spanHours = earliest === null ? 0 : ((latest - earliest) / HOUR_SECONDS) + 1;
    const remainingHours = earliest === null || historyStart === null ? null : Math.max(0, (earliest - historyStart) / HOUR_SECONDS);
    const hoursTo7d = earliest === null ? null : Math.max(0, 168 - spanHours);
    const blockers = [];
    if (!count || earliest === null || latest === null || !checkpoint) blockers.push('historical_base_missing');
    if (count && spanHours !== count) blockers.push('existing_hour_gap');
    if (checkpoint && latest !== checkpoint.hour_start) blockers.push('checkpoint_not_latest_hour');
    if (!coverage[V3_KIND]) blockers.push('v3_registry_missing');
    if (!coverage[V4_KIND]) blockers.push('v4_registry_missing');
    if (historyStart !== null && earliest !== null && earliest < historyStart) blockers.push('history_already_before_public_mainnet_start');
    return { count, earliest, latest, spanHours, checkpoint, coverage, remainingHours, hoursTo7d, blockers };
  } finally {
    db.close();
  }
}

function printPlan(plan, history = null) {
  console.log('MODE plan');
  console.log(`HISTORY_START ${history ? iso(history.firstCompleteHour) : 'requires --probe'}`);
  if (history) console.log(`PUBLIC_MAINNET_LIVE_AT ${iso(history.publicMainnetLiveAt)}`);
  console.log(`STORED_HOURS ${plan.count}`);
  console.log(`EARLIEST_HOUR ${plan.earliest === null ? 'none' : iso(plan.earliest)}`);
  console.log(`LATEST_HOUR ${plan.latest === null ? 'none' : iso(plan.latest)}`);
  console.log(`CONTIGUOUS ${plan.count > 0 && plan.spanHours === plan.count ? 'yes' : 'no'}`);
  console.log(`CHECKPOINT ${plan.checkpoint ? `${iso(plan.checkpoint.hour_start)} last_block=${plan.checkpoint.last_block}` : 'none'}`);
  console.log(`REMAINING_TO_HISTORY_START ${plan.remainingHours ?? 'requires --probe'} hours`);
  console.log(`HOURS_TO_7D ${plan.hoursTo7d ?? 'unknown'}`);
  for (const kind of [V3_KIND, V4_KIND]) {
    const c = plan.coverage[kind];
    console.log(`REGISTRY ${kind} ${c ? `${c.fromBlock}-${c.through}` : 'none'}`);
  }
  console.log(`BLOCKERS ${plan.blockers.length ? plan.blockers.join(',') : 'none'}`);
}

function assertRegistryCoverage(store, bounds) {
  const v3 = store.v3Registry();
  const v4 = store.v4Registry().coverage;
  if (!v3 || v3.fromBlock > bounds.before.number || v3.through < bounds.last.number) throw new Error('v3_registry_does_not_cover_history');
  if (!v4 || v4.fromBlock > bounds.before.number || v4.through < bounds.last.number) throw new Error('v4_registry_does_not_cover_history');
  return { v3, v4 };
}

// Network is always complete for a processHour result. Historical non-DEX protocols are allowed to be unavailable for an
// old hour (for example before their contract deployment); that absence is stored honestly as null, never as zero.
// The dashboard's historical DEX path, however, requires both Uniswap families, all DEX projections and valuations.
function assertHistoricalDexResult(result) {
  for (const name of ['uniswapV3', 'uniswapV4']) {
    const family = result.families?.[name];
    if (family?.status !== 'available') throw new Error(`historical_${name}_unavailable:${family?.reason ?? 'missing'}`);
  }
  const unavailableProjections = Object.entries(result.projections ?? {}).filter(([, entry]) => entry.status !== 'available')
    .map(([name, entry]) => `${name}:${entry.reason}`).join(',');
  if (unavailableProjections) throw new Error(`historical_projection_unavailable:${unavailableProjections}`);
}

export async function probeNextHour({ sqlitePath, provider }) {
  const history = await discoverHistoryStart(provider);
  const plan = await inspectHistory(sqlitePath, { historyStart: history.firstCompleteHour });
  if (plan.blockers.length) throw new Error(plan.blockers[0]);
  if (!plan.remainingHours) return { done: true, plan, history };

  const target = plan.earliest - HOUR_SECONDS;
  if (target < history.firstCompleteHour) return { done: true, plan, history };

  const safeHead = Number(BigInt(await provider.request('eth_blockNumber'))) - SAFE_HEAD_MARGIN_BLOCKS;
  const bounds = await locateHour({ provider, hourStart: target, safeHead });

  for (const kind of [V3_KIND, V4_KIND]) {
    const c = plan.coverage[kind];
    if (!c || c.fromBlock > bounds.before.number || c.through < bounds.last.number) {
      throw new Error(`${kind}_does_not_cover_next_hour`);
    }
  }
  return {
    done: false, plan, history, target, safeHead,
    bounds: { before: bounds.before.number, first: bounds.first.number, last: bounds.last.number, after: bounds.after.number },
  };
}

export async function executeHistoryBackfill({ config, provider, print = console.log }) {
  const lock = acquireWriterLock(config.sqlitePath, { owner: 'compact-history-backfill' });
  let db = null;
  const report = { committed: 0, historyStart: null, startEarliest: null, endEarliest: null, remaining: null, discovery: null };
  let discoveryRefreshed = false;
  try {
    const history = await discoverHistoryStart(provider);
    report.historyStart = history.firstCompleteHour;

    db = await openDatabase(config.sqlitePath);
    const store = createCompactStore(db);
    const baseCheckpoint = store.checkpoint();
    if (!baseCheckpoint) throw new Error('historical_base_missing');
    const first = store.earliestHour();
    if (!first) throw new Error('historical_base_missing');
    if (first.hourStart < history.firstCompleteHour) throw new Error('history_already_before_public_mainnet_start');
    report.startEarliest = first.hourStart;

    const head = Number(BigInt(await provider.request('eth_blockNumber')));
    const safeHead = head - SAFE_HEAD_MARGIN_BLOCKS;
    const limit = config.all ? Number.MAX_SAFE_INTEGER : config.maxHours;

    print(`HISTORY_BOUNDARY public_mainnet_live_at=${iso(history.publicMainnetLiveAt)} first_complete_hour=${iso(history.firstCompleteHour)}`);

    while (report.committed < limit) {
      const oldest = store.earliestHour();
      if (!oldest) throw new Error('historical_base_missing');
      if (oldest.hourStart <= history.firstCompleteHour) break;
      const target = oldest.hourStart - HOUR_SECONDS;
      if (target < history.firstCompleteHour) break;

      print(`BACKFILL_TARGET ${iso(target)} oldest=${iso(oldest.hourStart)}`);
      const bounds = await locateHour({ provider, hourStart: target, safeHead });
      const { v3 } = assertRegistryCoverage(store, bounds);
      const result = await processHour({ provider, hourStart: target, safeHead, v3Registry: v3, bounds });
      assertHistoricalDexResult(result);

      const committed = store.commitHistoricalHour(result, { requireValuations: true });
      if (committed.outcome !== 'inserted') throw new Error(`unexpected_historical_outcome:${committed.outcome}`);

      const afterCheckpoint = store.checkpoint();
      if (!afterCheckpoint || afterCheckpoint.hourStart !== baseCheckpoint.hourStart || afterCheckpoint.lastBlock !== baseCheckpoint.lastBlock
        || afterCheckpoint.lastHash !== baseCheckpoint.lastHash) throw new Error('historical_checkpoint_changed');

      report.committed += 1;
      report.endEarliest = target;
      // At most one bounded pass per child/invocation, even with --all. Hour COMMIT is already durable;
      // targeted RPC reads run outside its transaction, under the same writer lock and provider pacing.
      if (!discoveryRefreshed) {
        discoveryRefreshed = true;
        report.discovery = await refreshDiscoverySafely({ store, provider });
        print(`BACKFILL_DISCOVERY ${JSON.stringify(report.discovery)}`);
      }
      const unavailableFamilies = Object.entries(result.families).filter(([, entry]) => entry.status !== 'available')
        .map(([name, entry]) => `${name}:${entry.reason}`);
      const valuations = store.valuationStatus(target);
      print(`BACKFILL_COMMIT ${iso(target)} valuations=${valuations.map((row) => `${row.valuation}:${row.status}`).join(',')}`
        + `${unavailableFamilies.length ? ` unavailable_families=${unavailableFamilies.join(',')}` : ''}`);
      globalThis.gc?.();
    }

    const finalEarliest = store.earliestHour();
    report.endEarliest = finalEarliest?.hourStart ?? report.endEarliest;
    report.remaining = finalEarliest ? Math.max(0, (finalEarliest.hourStart - history.firstCompleteHour) / HOUR_SECONDS) : null;
    return report;
  } finally {
    db?.close();
    lock.release();
  }
}

async function main() {
  let config;
  try {
    config = historyBackfillConfig();
  } catch (error) {
    console.log(`RESULT FAIL ${error.message}`);
    process.exitCode = 1;
    return;
  }

  try {
    if (!config.probe && !config.execute) {
      const plan = await inspectHistory(config.sqlitePath);
      printPlan(plan);
      if (plan.blockers.length) throw new Error(plan.blockers[0]);
      console.log('RESULT PASS PLAN_ONLY');
      return;
    }

    const provider = createProvider({ minIntervalMs: config.minIntervalMs });

    if (!config.execute) {
      const probe = await probeNextHour({ sqlitePath: config.sqlitePath, provider });
      printPlan(probe.plan, probe.history);
      if (probe.done) console.log('PROBE already_at_discovered_history_start');
      else console.log(`PROBE next=${iso(probe.target)} blocks=${probe.bounds.first}-${probe.bounds.last} safe_head=${probe.safeHead}`);
      console.log(`PROVIDER requests=${provider.stats.requests} retries=${provider.stats.retries}`);
      console.log('RESULT PASS PROBE_ONLY');
      return;
    }

    const report = await executeHistoryBackfill({ config, provider });
    console.log(`BACKFILL_SUMMARY committed=${report.committed} history_start=${iso(report.historyStart)} start_earliest=${iso(report.startEarliest)} `
      + `end_earliest=${report.endEarliest === null ? 'none' : iso(report.endEarliest)} remaining=${report.remaining}`);
    console.log(`PROVIDER requests=${provider.stats.requests} retries=${provider.stats.retries}`);
    console.log('RESULT PASS');
  } catch (error) {
    const details = error instanceof ProviderError ? ` endpoint=${error.endpoint} http=${error.httpStatus ?? 'none'} rpc=${error.rpcCode ?? 'none'}` : '';
    const lock = error instanceof WriterLockError ? ` holder=${error.holder?.owner ?? 'unknown'}` : '';
    console.log(`RESULT FAIL ${error.code ?? error.message}${details}${lock}`);
    process.exitCode = 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) await main();
