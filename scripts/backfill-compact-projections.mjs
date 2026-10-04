// Compact engine: projection backfill and V4 pool registry tooling. DRY RUN BY DEFAULT: the database is opened read-only
// (PRAGMA query_only) and no RPC request is made; the plan prints stored hours, contiguity, request counts and duration.
// Nothing is ever written without an explicit execute flag AND COMPACT_PROJECTION_EXECUTE=yes; the two execute modes
// are separate runs. It never replays a full hour, never touches families, hours or the checkpoint, and never runs on
// its own (no scheduler calls it).
//   COMPACT_SQLITE_PATH=/data/arc-compact.sqlite node scripts/backfill-compact-projections.mjs              (dry run)
//   ... --probe-deployment          dry run plus a read-only eth_getCode binary search for the PoolManager deployment block
//   ... --v4-from-block=<n>         dry run with an operator-supplied V4 registry start (proven before any write)
//   COMPACT_PROJECTION_EXECUTE=yes ... --execute-backfill                   projection rows for stored hours
//   COMPACT_PROJECTION_EXECUTE=yes ... --execute-v4-registry --v4-from-block=<n>   V4 registry bootstrap / catch-up
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { UNISWAP_REGISTRY } from '../api/_lib/arc-intelligence/uniswap.js';
import {
  DEFAULT_PACING_MS, formatPlan, planProjectionBackfill, planV4Registry, readBackfillInputs, runProjectionBackfill,
} from '../server/compact/projection-backfill.js';
import { createProvider, ProviderError } from '../server/compact/provider.js';
import { bootstrapV4Registry, catchUpV4Registry, locateDeploymentBlock } from '../server/compact/registry.js';
import { COMPACT_SCHEMA_VERSION, createCompactStore } from '../server/compact/store.js';
import { MIN_RPC_INTERVAL_MS, SAFE_HEAD_MARGIN_BLOCKS } from './run-compact-hour.mjs';

export const EXECUTE_CONFIRMATION = 'yes';

export class BackfillConfigError extends Error {
  constructor(code) { super(code); this.code = code; }
}

// Arguments and environment, checked before any file is opened or any request is made.
export function backfillConfig({ argv = process.argv.slice(2), env = process.env } = {}) {
  const known = new Set(['--probe-deployment', '--execute-backfill', '--execute-v4-registry']);
  let fromBlock = null;
  const flags = new Set();
  for (const value of argv) {
    if (value.startsWith('--v4-from-block=')) {
      const raw = value.slice('--v4-from-block='.length);
      if (!/^\d+$/.test(raw) || !Number.isSafeInteger(Number(raw))) throw new BackfillConfigError('invalid_v4_from_block');
      fromBlock = Number(raw);
    } else if (known.has(value)) flags.add(value);
    else throw new BackfillConfigError('unknown_argument');
  }
  const executeBackfill = flags.has('--execute-backfill');
  const executeV4Registry = flags.has('--execute-v4-registry');
  if (executeBackfill && executeV4Registry) throw new BackfillConfigError('one_execute_mode_per_run');
  const execute = executeBackfill || executeV4Registry;
  if (execute && env.COMPACT_PROJECTION_EXECUTE !== EXECUTE_CONFIRMATION) throw new BackfillConfigError('execute_confirmation_required');
  if (execute && flags.has('--probe-deployment')) throw new BackfillConfigError('probe_is_dry_run_only');
  const sqlitePath = env.COMPACT_SQLITE_PATH?.trim();
  if (!sqlitePath || sqlitePath === ':memory:' || sqlitePath.startsWith('file:')) throw new BackfillConfigError('sqlite_path_required');
  const pacing = env.COMPACT_RPC_MIN_INTERVAL_MS ?? String(DEFAULT_PACING_MS);
  const minIntervalMs = /^\d+$/.test(pacing) ? Number(pacing) : Number.NaN;
  if (!Number.isSafeInteger(minIntervalMs) || minIntervalMs < MIN_RPC_INTERVAL_MS) throw new BackfillConfigError('unsafe_rpc_pacing');
  return { sqlitePath: resolve(sqlitePath), minIntervalMs, fromBlock, probeDeployment: flags.has('--probe-deployment'),
    mode: executeBackfill ? 'execute_backfill' : executeV4Registry ? 'execute_v4_registry' : 'dry_run' };
}

function openReadOnly(DatabaseSync, path) {
  if (!existsSync(path)) throw new BackfillConfigError('database_missing');
  const db = new DatabaseSync(path, { readOnly: true });
  db.exec('PRAGMA query_only = ON');
  if (db.prepare('PRAGMA query_only').get()?.query_only !== 1) throw new BackfillConfigError('query_only_unavailable');
  return db;
}

// providerFactory is only called when the run needs the network (probe or execute); a plain dry run never creates one.
export async function runBackfillTool({ config, DatabaseSync, providerFactory, print = console.log }) {
  print(`PROJECTION_TOOL_MODE ${config.mode}`);
  let provider = null;
  const network = () => (provider ??= providerFactory());
  const db = openReadOnly(DatabaseSync, config.sqlitePath);
  let inputs;
  try {
    inputs = readBackfillInputs(db, { schemaVersion: COMPACT_SCHEMA_VERSION });
  } finally {
    db.close();
  }
  let deployment = null;
  if (config.probeDeployment) {
    const safeHead = Number(BigInt(await network().request('eth_blockNumber'))) - SAFE_HEAD_MARGIN_BLOCKS;
    const high = Math.min(safeHead, inputs.checkpoint?.lastBlock ?? safeHead);
    deployment = await locateDeploymentBlock(network(), UNISWAP_REGISTRY.v4PoolManager.address, { low: 0, high });
    print(`V4_DEPLOYMENT block=${deployment.block} method=${deployment.method} requests=${deployment.requests}`);
  }
  const plan = planProjectionBackfill(inputs, { pacingMs: config.minIntervalMs });
  const v4Plan = planV4Registry(inputs, { pacingMs: config.minIntervalMs, deployment, fromBlock: config.fromBlock });
  for (const line of formatPlan(plan, v4Plan)) print(line);
  const summary = { mode: config.mode, plan: { ...plan, targets: undefined }, v4Plan, executed: null,
    rpcRequests: () => provider?.stats.requests ?? 0 };
  if (config.mode === 'dry_run') {
    print(`RESULT DRY_RUN writes=0 rpc_requests=${summary.rpcRequests()}`);
    return summary;
  }

  const writer = new DatabaseSync(config.sqlitePath);
  try {
    const store = createCompactStore(writer);
    if (config.mode === 'execute_backfill') {
      summary.executed = await runProjectionBackfill({ store, provider: network(), plan, v3Pools: store.v3Registry()?.pools ?? new Set(), print });
      print(`BACKFILL_DONE committed=${summary.executed.committed} skipped=${summary.executed.skipped.length} `
        + `outcomes=${JSON.stringify(summary.executed.outcomes)}`);
    } else {
      const coverage = store.v4Registry().coverage;
      const target = store.checkpoint()?.lastBlock;
      if (!Number.isSafeInteger(target)) throw new BackfillConfigError('no_checkpoint');
      if (!coverage && config.fromBlock === null) throw new BackfillConfigError('v4_from_block_required');
      const scan = coverage ? await catchUpV4Registry(network(), coverage, target)
        : await bootstrapV4Registry(network(), { fromBlock: config.fromBlock, toBlock: target });
      const after = scan ? store.extendV4Registry(scan) : coverage;
      summary.executed = { created: scan?.created.length ?? 0, coverage: after };
      print(`V4_REGISTRY_DONE created=${summary.executed.created} coverage=${after ? `${after.fromBlock}-${after.through}` : 'none'}`);
    }
  } finally {
    writer.close();
  }
  print(`RESULT EXECUTED rpc_requests=${summary.rpcRequests()}`);
  return summary;
}

async function main() {
  let config;
  try {
    config = backfillConfig();
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
    await runBackfillTool({ config, DatabaseSync: sqlite.DatabaseSync, providerFactory: () => createProvider({ minIntervalMs: config.minIntervalMs }) });
  } catch (error) {
    const diagnostics = error instanceof ProviderError ? ` ${JSON.stringify({ httpStatus: error.httpStatus, rpcCode: error.rpcCode })}` : '';
    console.log(`RESULT FAIL ${error?.code ?? error?.message ?? String(error)}${diagnostics}`);
    process.exitCode = 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) await main();
