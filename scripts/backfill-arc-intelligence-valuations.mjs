// Compact engine: historical valuation backfill (Phase 1D.1, server/compact/valuation-backfill.js). DRY RUN BY DEFAULT:
// the database is opened read-only (PRAGMA query_only) and no RPC request is made; the plan prints the target hours, what
// each one needs, the estimated eth_getLogs requests and the estimated persistent row writes. Nothing is ever written
// without BOTH --execute AND COMPACT_VALUATION_BACKFILL_EXECUTE=yes. The latest 24 committed hours by default, at most 72.
// It never replays an hour, never touches hours, families, addresses or the checkpoint, and keeps compact hourly rows only.
// Execute safety, in order: the plan's storage estimate must be compact hourly scale (storageGuard); the writer lock must be
// free (the scheduler's hourly child and any other backfill hold it while writing; this run then holds it until done, and
// the scheduler simply retries its hour afterwards); a consistent snapshot of the database is written next to it with
// VACUUM INTO (refused when the volume lacks the space) as the rollback point; the file size is printed before and after;
// any provider, boundary or log inconsistency stops the run with its hour and reason. The snapshot is the only file left
// on purpose; the lock file is removed.
//   COMPACT_SQLITE_PATH=/data/arc-compact.sqlite node scripts/backfill-arc-intelligence-valuations.mjs [--hours 24|72]       (dry run)
//   COMPACT_VALUATION_BACKFILL_EXECUTE=yes COMPACT_SQLITE_PATH=/data/arc-compact.sqlite \
//     node scripts/backfill-arc-intelligence-valuations.mjs --execute [--hours 24|72]
import { existsSync, statfsSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createProvider, ProviderError } from '../server/compact/provider.js';
import { COMPACT_SCHEMA_VERSION, createCompactStore } from '../server/compact/store.js';
import {
  DEFAULT_VALUATION_HOURS, formatValuationPlan, MAX_VALUATION_HOURS, planValuationBackfill, readValuationInputs, runValuationBackfill, storageGuard,
} from '../server/compact/valuation-backfill.js';
import { acquireWriterLock, writerLockHolder } from '../server/compact/writer-lock.js';
import { DEFAULT_RPC_INTERVAL_MS, MIN_RPC_INTERVAL_MS } from './run-compact-hour.mjs';

export const EXECUTE_CONFIRMATION = 'yes';
export const SCRIPT = 'scripts/backfill-arc-intelligence-valuations.mjs';

export class ValuationBackfillConfigError extends Error {
  constructor(code) { super(code); this.code = code; }
}

// Arguments and environment, checked before any file is opened or any request is made.
export function valuationBackfillConfig({ argv = process.argv.slice(2), env = process.env } = {}) {
  let hours = DEFAULT_VALUATION_HOURS;
  let execute = false;
  let hoursSeen = false;
  for (let index = 0; index < argv.length; index++) {
    const value = argv[index];
    let raw = null;
    if (value === '--execute' && !execute) execute = true;
    else if (value === '--hours' && !hoursSeen) raw = argv[++index] ?? '';
    else if (value.startsWith('--hours=') && !hoursSeen) raw = value.slice('--hours='.length);
    else throw new ValuationBackfillConfigError('unknown_argument');
    if (raw === null) continue;
    hoursSeen = true;
    if (!/^\d+$/.test(raw) || !Number.isSafeInteger(Number(raw)) || Number(raw) < 1) throw new ValuationBackfillConfigError('invalid_hours');
    hours = Number(raw);
    if (hours > MAX_VALUATION_HOURS) throw new ValuationBackfillConfigError('hours_above_maximum');
  }
  if (execute && env.COMPACT_VALUATION_BACKFILL_EXECUTE !== EXECUTE_CONFIRMATION) throw new ValuationBackfillConfigError('execute_confirmation_required');
  const sqlitePath = env.COMPACT_SQLITE_PATH?.trim();
  if (!sqlitePath || sqlitePath === ':memory:' || sqlitePath.startsWith('file:')) throw new ValuationBackfillConfigError('sqlite_path_required');
  const pacing = env.COMPACT_RPC_MIN_INTERVAL_MS ?? String(DEFAULT_RPC_INTERVAL_MS);
  const minIntervalMs = /^\d+$/.test(pacing) ? Number(pacing) : Number.NaN;
  // Keep setTimeout well below its signed 32-bit limit; an overflow can turn a requested long delay into 1 ms.
  if (!Number.isSafeInteger(minIntervalMs) || minIntervalMs < MIN_RPC_INTERVAL_MS || minIntervalMs > 3_600_000) {
    throw new ValuationBackfillConfigError('unsafe_rpc_pacing');
  }
  return { sqlitePath: resolve(sqlitePath), hours, minIntervalMs, mode: execute ? 'execute' : 'dry_run' };
}

function openReadOnly(DatabaseSync, path) {
  if (!existsSync(path)) throw new ValuationBackfillConfigError('database_missing');
  const db = new DatabaseSync(path, { readOnly: true });
  db.exec('PRAGMA query_only = ON');
  if (db.prepare('PRAGMA query_only').get()?.query_only !== 1) throw new ValuationBackfillConfigError('query_only_unavailable');
  return db;
}

const sizeOf = (path) => (existsSync(path) ? statSync(path).size : 0);
export const sqliteBytes = (path) => ({ db: sizeOf(path), wal: sizeOf(`${path}-wal`) });
export const snapshotPathOf = (sqlitePath, now = new Date()) => `${sqlitePath}.pre-valuation-backfill-${now.toISOString().replace(/[:.]/g, '-')}`;

// Free bytes on the database volume (null when the platform cannot tell).
function freeBytes(path) {
  try {
    const stats = statfsSync(dirname(path));
    return Number(stats.bavail) * Number(stats.bsize);
  } catch {
    return null;
  }
}

// A consistent snapshot (VACUUM INTO reads one committed snapshot of the whole database) as the rollback point. Refused
// when the volume cannot hold it plus the planned writes with a margin.
export function writeSnapshot({ DatabaseSync, sqlitePath, snapshotPath, plannedBytes, free = freeBytes }) {
  if (existsSync(snapshotPath)) throw new ValuationBackfillConfigError('snapshot_exists');
  const size = sqliteBytes(sqlitePath);
  const needed = Math.ceil((size.db + size.wal) * 1.2) + plannedBytes * 2;
  const available = free(sqlitePath);
  if (available === null || available < needed) {
    throw Object.assign(new ValuationBackfillConfigError('insufficient_disk_for_snapshot'), { needed, available });
  }
  const source = new DatabaseSync(sqlitePath, { readOnly: true });
  try {
    source.exec(`VACUUM INTO '${snapshotPath.replace(/'/g, "''")}'`);
  } finally {
    source.close();
  }
  return { path: snapshotPath, bytes: sizeOf(snapshotPath), needed, available };
}

// providerFactory is called only when an execute run has an hour that needs a log re-read.
export async function runValuationBackfillTool({ config, DatabaseSync, providerFactory, print = console.log, free = freeBytes,
  now = () => new Date() }) {
  print(`VALUATION_BACKFILL_MODE ${config.mode} hours=${config.hours}`);
  let provider = null;
  const network = () => (provider ??= providerFactory());
  const reader = openReadOnly(DatabaseSync, config.sqlitePath);
  let inputs;
  try {
    inputs = readValuationInputs(reader, { hours: config.hours, schemaVersion: COMPACT_SCHEMA_VERSION });
  } finally {
    reader.close();
  }
  let plan = planValuationBackfill(inputs, { pacingMs: config.minIntervalMs });
  for (const line of formatValuationPlan(plan)) print(line);
  const guard = storageGuard(plan);
  const holder = writerLockHolder(config.sqlitePath);
  const current = sqliteBytes(config.sqlitePath);
  print(`STORAGE_GUARD ${guard ?? 'pass (compact hourly scale)'}`);
  print(`WRITER_LOCK ${holder ? `held by ${holder.owner} pid=${holder.pid} since=${holder.since}` : 'free'}`);
  print(`SQLITE_BYTES_NOW db=${current.db} wal=${current.wal}`);
  const hoursArgument = config.hours === DEFAULT_VALUATION_HOURS ? '' : ` --hours ${config.hours}`;
  const summary = { mode: config.mode, plan: { ...plan, entries: undefined }, executed: null, sqliteBytes: null,
    rpcRequests: () => provider?.stats.requests ?? 0 };
  const work = plan.missingValuationHours > plan.blockedHours;
  if (config.mode === 'dry_run') {
    print(`SNAPSHOT_PLAN execute writes ${snapshotPathOf(config.sqlitePath, now())} first (VACUUM INTO, about the size of the database)`);
    print(`NEXT_COMMAND ${work && !guard
      ? `COMPACT_VALUATION_BACKFILL_EXECUTE=yes COMPACT_SQLITE_PATH=${config.sqlitePath} node ${SCRIPT} --execute${hoursArgument}`
      : guard ? `none (${guard})` : 'none (nothing a valuation backfill can do)'}`);
    print(`RESULT DRY_RUN writes=0 rpc_requests=${summary.rpcRequests()}`);
    return summary;
  }
  if (guard) throw new ValuationBackfillConfigError(guard);
  if (!work) {
    print('RESULT EXECUTED nothing_to_do writes=0 rpc_requests=0');
    return summary;
  }

  const lock = acquireWriterLock(config.sqlitePath, { owner: 'backfill-arc-intelligence-valuations' });
  try {
    // The scheduler may have committed between the dry planning read and lock acquisition. Replan while exclusively
    // holding the lock, before backup or any writes; never carry fact/status snapshots across a persistence boundary.
    const lockedReader = openReadOnly(DatabaseSync, config.sqlitePath);
    try {
      plan = planValuationBackfill(readValuationInputs(lockedReader, { hours: config.hours, schemaVersion: COMPACT_SCHEMA_VERSION }),
        { pacingMs: config.minIntervalMs });
    } finally { lockedReader.close(); }
    summary.plan = { ...plan, entries: undefined };
    print('LOCKED_PLAN');
    for (const line of formatValuationPlan(plan)) print(line);
    const lockedGuard = storageGuard(plan);
    if (lockedGuard) throw new ValuationBackfillConfigError(lockedGuard);
    if (plan.missingValuationHours <= plan.blockedHours) {
      print('RESULT EXECUTED nothing_to_do writes=0 rpc_requests=0');
      return summary;
    }
    const before = sqliteBytes(config.sqlitePath);
    print(`SQLITE_BYTES_BEFORE db=${before.db} wal=${before.wal}`);
    const snapshot = writeSnapshot({ DatabaseSync, sqlitePath: config.sqlitePath, snapshotPath: snapshotPathOf(config.sqlitePath, now()),
      plannedBytes: plan.expectedWrites.estimatedBytes, free });
    summary.snapshot = snapshot;
    print(`SNAPSHOT ${snapshot.path} bytes=${snapshot.bytes} free_before=${snapshot.available}`);
      print(`ROLLBACK stop every compact writer first; preserve the failed database for inspection; restore ${snapshot.path} to ${config.sqlitePath}; `
        + 'remove stale WAL/SHM only while all connections are stopped; restart with the original configuration. Never replace a live database.');
    const writer = new DatabaseSync(config.sqlitePath);
    try {
      const store = createCompactStore(writer);
      const needsV3 = plan.entries.some((entry) => entry.refetch?.uniswap_v3_pools);
      summary.executed = await runValuationBackfill({ store, provider: plan.refetchHours ? network() : null, plan,
        v3Pools: needsV3 ? store.v3Registry()?.pools ?? new Set() : new Set(), print });
    } finally {
      writer.close();
      const after = sqliteBytes(config.sqlitePath);
      summary.sqliteBytes = { before, after };
      print(`SQLITE_BYTES_AFTER db=${after.db} wal=${after.wal} delta=${after.db + after.wal - before.db - before.wal}`);
    }
  } finally {
    lock.release();
  }
  print(`VALUATION_BACKFILL_DONE refetched=${summary.executed.refetched} derived=${summary.executed.derived} `
    + `outcomes=${JSON.stringify(summary.executed.outcomes)}`);
  print(`DELETE_SNAPSHOT_AFTER_VERIFICATION rm ${summary.snapshot.path}`);
  print(`RESULT EXECUTED rpc_requests=${summary.rpcRequests()}`);
  return summary;
}

async function main() {
  let config;
  try {
    config = valuationBackfillConfig();
  } catch (error) {
    console.log(`RESULT FAIL ${error.code ?? error.message}`);
    process.exitCode = 1;
    return;
  }
  const sqlite = await import('node:sqlite').catch(() => null);
  if (!sqlite) {
    console.log(`RESULT FAIL sqlite_unavailable node=${process.version}`);
    process.exitCode = 1;
    return;
  }
  try {
    await runValuationBackfillTool({ config, DatabaseSync: sqlite.DatabaseSync,
      providerFactory: () => createProvider({ minIntervalMs: config.minIntervalMs }) });
  } catch (error) {
    const details = { ...(error instanceof ProviderError ? { httpStatus: error.httpStatus, rpcCode: error.rpcCode } : {}),
      ...(error?.hour ? { hour: error.hour } : {}), ...(error?.hours ? { hours: error.hours } : {}), ...(error?.holder ? { holder: error.holder } : {}),
      ...(error?.needed ? { needed: error.needed, available: error.available } : {}) };
    console.log(`RESULT FAIL ${error?.code ?? error?.message ?? String(error)}${Object.keys(details).length ? ` ${JSON.stringify(details)}` : ''}`);
    process.exitCode = 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) await main();
