// Compact engine: projection-only repair of ONE stored hour, the scheduler's self-heal child. Never a processHour replay:
// no block spine, no receipts, no family recount, and the hour, its families, its addresses and the checkpoint are never
// written. It rebuilds only the Uniswap pool projections that are missing or unavailable while their family is available
// (projections.js projectionRepairState), from only the stream each one needs (v3Pools for V3, v4 for V4, 500 blocks per
// eth_getLogs), after checking the stored first/last block hashes, and writes them through store.js, which reconciles
// them exactly with the hour's STORED family counters (a mismatch stays unavailable). Recent activity is never rebuilt:
// it needs the spine's transaction senders and comes from live hours only. A registry that is missing or behind the hour
// blocks that projection (v3_registry_*, v4_registry_*) with no RPC request; it is never bootstrapped from here. The
// valuation inputs built from the same stream (pool price paths, V4 swap fees) are written with each rebuilt pool
// projection (no extra request), and the hour's valuations are derived from the result in the same commit.
// Strict arguments: exactly one exact UTC hour ISO string, no flags, no bulk mode (bulk work stays with the operator-only
// scripts/backfill-compact-projections.mjs). Exit 0 only when every repairable projection of the hour ends available.
//   COMPACT_SQLITE_PATH=/data/arc-compact.sqlite [COMPACT_RPC_MIN_INTERVAL_MS=1000] \
//   node --max-old-space-size=64 --max-semi-space-size=2 scripts/repair-compact-projection-hour.mjs 2026-10-01T07:00:00.000Z
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { LogError } from '../server/compact/logs.js';
import {
  backfillProjectionHour, planProjectionRepair, readProjectionRepairInput, verifyStoredBoundaries,
} from '../server/compact/projection-backfill.js';
import { VALUATION_INPUTS_OF_POOLS } from '../server/compact/projections.js';
import { createProvider, ProviderError } from '../server/compact/provider.js';
import { assertHourIso } from '../server/compact/scheduler.js';
import { COMPACT_SCHEMA_VERSION, createCompactStore } from '../server/compact/store.js';
import { acquireWriterLock, WriterLockError } from '../server/compact/writer-lock.js';
import { DEFAULT_RPC_INTERVAL_MS, MIN_RPC_INTERVAL_MS } from './run-compact-hour.mjs';

export class RepairConfigError extends Error {
  constructor(code) { super(code); this.code = code; }
}

// Arguments and environment, checked before any file is opened or any request is made.
export function repairConfig({ argv = process.argv.slice(2), env = process.env } = {}) {
  if (argv.length !== 1) throw new RepairConfigError('exactly_one_hour_required');
  try { assertHourIso(argv[0]); } catch { throw new RepairConfigError('invalid_hour'); }
  const sqlitePath = env.COMPACT_SQLITE_PATH?.trim();
  if (!sqlitePath || sqlitePath === ':memory:' || sqlitePath.startsWith('file:')) throw new RepairConfigError('sqlite_path_required');
  const pacing = env.COMPACT_RPC_MIN_INTERVAL_MS ?? String(DEFAULT_RPC_INTERVAL_MS);
  const minIntervalMs = /^\d+$/.test(pacing) ? Number(pacing) : Number.NaN;
  if (!Number.isSafeInteger(minIntervalMs) || minIntervalMs < MIN_RPC_INTERVAL_MS) throw new RepairConfigError('unsafe_rpc_pacing');
  return { hourStart: Date.parse(argv[0]) / 1000, sqlitePath: resolve(sqlitePath), minIntervalMs };
}

const statusOf = (row) => (row.status === 'available' ? 'available' : `unavailable(${row.reason})`);
const listOf = (object) => Object.entries(object).map(([name, value]) => (value === true ? name : `${name}=${value}`)).join(',') || 'none';

// providerFactory is called only when there is something to fetch.
export async function repairProjectionHour({ sqlitePath, hourStart, DatabaseSync, providerFactory, print = console.log }) {
  const summary = { hour: new Date(hourStart * 1000).toISOString(), needs: null, blocked: null, outcomes: null, projections: null, requests: 0,
    ok: false, reason: null, diagnostics: null };
  print(`PROJECTION_REPAIR_HOUR ${summary.hour}`);
  let provider = null;
  let db = null;
  let lock = null;
  try {
    // An existing compact database only: this child never creates one.
    if (!existsSync(sqlitePath)) throw new RepairConfigError('database_missing');
    // One writer at a time: an operator backfill holding the lock makes this child refuse before any request or write.
    lock = acquireWriterLock(sqlitePath, { owner: 'repair-compact-projection-hour' });
    db = new DatabaseSync(sqlitePath);
    const store = createCompactStore(db);
    const input = readProjectionRepairInput(db, hourStart, { schemaVersion: COMPACT_SCHEMA_VERSION });
    const plan = planProjectionRepair(input);
    summary.needs = Object.keys(plan.needs);
    summary.blocked = plan.blocked;
    if (plan.reason) throw new RepairConfigError(plan.reason);
    if (summary.needs.length) {
      provider = providerFactory();
      if ((await verifyStoredBoundaries(provider, [input.hour])).size) throw new RepairConfigError('boundary_hash_mismatch');
      // The V3 registry is loaded only when V3 is rebuilt; V4 pool identities come from the hour's own Initialize logs.
      const v3Pools = plan.needs.uniswap_v3_pools ? store.v3Registry()?.pools ?? new Set() : new Set();
      const projections = await backfillProjectionHour({ provider, hour: { ...input.hour, needs: plan.needs }, v3Pools });
      summary.outcomes = store.commitProjectionHour(hourStart, projections,
        { only: [...summary.needs, ...summary.needs.flatMap((name) => VALUATION_INPUTS_OF_POOLS[name])] });
    }
    summary.projections = Object.fromEntries(store.projectionStatus(hourStart).map((row) => [row.projection, statusOf(row)]));
    const notRepaired = summary.needs.filter((name) => summary.projections[name] !== 'available');
    summary.ok = notRepaired.length === 0 && Object.keys(plan.blocked).length === 0;
    if (!summary.ok) summary.reason = notRepaired.length ? `not_repaired:${notRepaired.join(',')}` : `blocked:${listOf(plan.blocked)}`;
  } catch (error) {
    summary.reason = error?.code ?? `${error?.name ?? 'Error'}: ${error?.message ?? String(error)}`;
    if (error instanceof ProviderError) summary.diagnostics = { httpStatus: error.httpStatus, rpcCode: error.rpcCode };
    else if (error instanceof LogError) summary.diagnostics = { blockNumber: error.blockNumber };
    else if (error instanceof WriterLockError) summary.diagnostics = { holder: error.holder?.owner ?? null };
  } finally {
    db?.close();
    lock?.release();
  }
  summary.requests = provider?.stats.requests ?? 0;
  print(`NEEDS ${summary.needs?.length ? summary.needs.join(',') : 'none'}`);
  print(`BLOCKED ${summary.blocked ? listOf(summary.blocked) : 'none'}`);
  print(`OUTCOMES ${summary.outcomes ? listOf(summary.outcomes) : 'none'}`);
  print(`PROJECTIONS ${summary.projections ? listOf(summary.projections) : 'unknown'}`);
  print(`PROVIDER requests=${summary.requests} calls=${JSON.stringify(provider?.stats.calls ?? {})}`);
  print(`RESULT ${summary.ok ? 'PASS' : `FAIL ${summary.reason}`}${summary.diagnostics ? ` ${JSON.stringify(summary.diagnostics)}` : ''}`);
  return summary;
}

async function main() {
  let config;
  try {
    config = repairConfig();
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
  const summary = await repairProjectionHour({ sqlitePath: config.sqlitePath, hourStart: config.hourStart, DatabaseSync: sqlite.DatabaseSync,
    providerFactory: () => createProvider({ minIntervalMs: config.minIntervalMs }) });
  process.exitCode = summary.ok ? 0 : 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) await main();
