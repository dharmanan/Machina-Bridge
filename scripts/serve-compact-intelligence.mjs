// Compact engine: the always-on Machina Intelligence service. One parent process owns a read-only SQLite read model, the
// public read-only HTTP API, and the deterministic hourly scheduler. The scheduler runs the unchanged
// scripts/run-compact-hour.mjs as a memory-isolated child for checkpoint + 1 hour until caught up. Once live is caught
// up, the same scheduler runs exactly one historical prepend child at a time until the public-mainnet boundary; before
// every next historical hour it re-checks live catch-up, so live indexing always has priority. After history is complete
// it may run projection repair. Never two writer children at once. Railway: always-on service, Serverless OFF, no cron,
// restart ON_FAILURE.
// COMPACT_SCHEDULER_ENABLED (maintenance gate): unset, empty or "true" runs the scheduler; "false" serves the read API
// only, starts no indexing child and writes nothing; any other value refuses to start.
//   COMPACT_SQLITE_PATH=/data/arc-compact.sqlite [COMPACT_RPC_MIN_INTERVAL_MS=1000] [PORT=8080] [COMPACT_SCHEDULER_ENABLED=true] \
//   node --max-old-space-size=128 scripts/serve-compact-intelligence.mjs
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createIntelligenceServer } from '../server/compact/http.js';
import { createCompactReadModel } from '../server/compact/read-model.js';
import { createChildHistoryRunner, createChildHourRunner, createScheduler } from '../server/compact/scheduler.js';
import { ARC_PUBLIC_MAINNET_FIRST_COMPLETE_HOUR } from './backfill-compact-history.mjs';
import { DEFAULT_RPC_INTERVAL_MS, MIN_RPC_INTERVAL_MS } from './run-compact-hour.mjs';

export const RUNNER_SCRIPT = fileURLToPath(new URL('./run-compact-hour.mjs', import.meta.url));
export const PROJECTION_REPAIR_SCRIPT = fileURLToPath(new URL('./repair-compact-projection-hour.mjs', import.meta.url));
export const HISTORY_BACKFILL_SCRIPT = fileURLToPath(new URL('./backfill-compact-history.mjs', import.meta.url));
export const DEFAULT_PORT = 8080;
export const SHUTDOWN_TIMEOUT_MS = 25_000;

export class ServiceConfigError extends Error {
  constructor(code) { super(code); this.code = code; }
}

// Environment checked before anything is opened or started. The child runner re-validates the same variables.
export function serviceConfig({ env = process.env } = {}) {
  const sqlitePath = env.COMPACT_SQLITE_PATH?.trim();
  if (!sqlitePath || sqlitePath === ':memory:' || sqlitePath.startsWith('file:')) throw new ServiceConfigError('sqlite_path_required');
  const pacing = env.COMPACT_RPC_MIN_INTERVAL_MS ?? String(DEFAULT_RPC_INTERVAL_MS);
  const minIntervalMs = /^\d+$/.test(pacing) ? Number(pacing) : Number.NaN;
  if (!Number.isSafeInteger(minIntervalMs) || minIntervalMs < MIN_RPC_INTERVAL_MS) throw new ServiceConfigError('unsafe_rpc_pacing');
  const portText = env.PORT ?? String(DEFAULT_PORT);
  const port = /^\d+$/.test(portText) ? Number(portText) : Number.NaN;
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) throw new ServiceConfigError('invalid_port');
  // Exactly "true" or "false"; a malformed value fails closed instead of silently pausing (or running) the indexer.
  const enabled = env.COMPACT_SCHEDULER_ENABLED ?? '';
  if (enabled !== '' && enabled !== 'true' && enabled !== 'false') throw new ServiceConfigError('invalid_scheduler_enabled');
  return { sqlitePath: resolve(sqlitePath), minIntervalMs, port, host: '0.0.0.0', schedulerEnabled: enabled !== 'false' };
}

// Wires the three parts; returns shutdown(code, reason) so signals, fatal read-model errors and tests share one path.
export function startIntelligenceService({ config, readModel, scheduler, server, log = console.log, exit = (code) => process.exit(code),
  shutdownTimeoutMs = SHUTDOWN_TIMEOUT_MS }) {
  let closing = null;
  function shutdown(code, reason) {
    if (closing) return closing;
    log(`SERVICE_SHUTDOWN reason=${reason} code=${code}`);
    const forced = setTimeout(() => { log('SERVICE_SHUTDOWN_FORCED'); exit(code === 0 ? 1 : code); }, shutdownTimeoutMs);
    forced.unref?.();
    closing = (async () => {
      // 1. No new indexing work; a running child is terminated and awaited (bounded by the runner's kill grace).
      try { await scheduler.stop(); } catch { log('SERVICE_SCHEDULER_STOP_FAILED'); }
      // 2. No new HTTP requests; idle keep-alive sockets close now, the rest once in-flight responses finish.
      await new Promise((done) => {
        server.close(() => done());
        server.closeIdleConnections?.();
        setTimeout(() => server.closeAllConnections?.(), 2_000).unref?.();
      });
      // 3. The read connection last: nothing can use it any more.
      try { readModel.close(); } catch { log('SERVICE_READ_MODEL_CLOSE_FAILED'); }
      clearTimeout(forced);
      exit(code);
    })();
    return closing;
  }
  server.listen(config.port, config.host, () => log(`SERVICE_LISTENING port=${config.port}`));
  // Maintenance gate: a paused scheduler starts no timer and no child; reads keep being served; shutdown is unchanged.
  const schedulerEnabled = config.schedulerEnabled !== false;
  log(`SCHEDULER_ENABLED ${schedulerEnabled}`);
  if (schedulerEnabled) scheduler.start();
  return { shutdown };
}

async function main() {
  let config;
  try {
    config = serviceConfig();
  } catch (error) {
    console.log(`SERVICE_FAIL ${error.code ?? 'invalid_config'}`);
    process.exitCode = 1;
    return;
  }
  let DatabaseSync;
  try {
    ({ DatabaseSync } = await import('node:sqlite'));
  } catch {
    console.log(`SERVICE_FAIL node_sqlite_unavailable node=${process.version}`);
    process.exitCode = 1;
    return;
  }
  const log = (line) => console.log(line);
  const readModel = createCompactReadModel({ path: config.sqlitePath, DatabaseSync });
  // An existing but incompatible database is refused before serving or indexing anything. A missing file is not an
  // error: the first scheduled hour creates it.
  try {
    readModel.health();
  } catch (error) {
    if (error?.code === 'incompatible') {
      console.log(`SERVICE_FAIL database_incompatible ${error.detail ?? ''}`.trim());
      process.exitCode = 1;
      return;
    }
    log(`SERVICE_DATABASE_NOT_READY code=${error?.code ?? 'unknown'}`);
  }
  let service = null;
  const fatal = () => service?.shutdown(1, 'database_incompatible');
  const childEnv = { ...process.env, COMPACT_SQLITE_PATH: config.sqlitePath, COMPACT_RPC_MIN_INTERVAL_MS: String(config.minIntervalMs) };
  const runHour = createChildHourRunner({ scriptPath: RUNNER_SCRIPT, env: childEnv });
  const runProjectionRepair = createChildHourRunner({ scriptPath: PROJECTION_REPAIR_SCRIPT, env: childEnv });
  const runHistoryBackfill = createChildHistoryRunner({ scriptPath: HISTORY_BACKFILL_SCRIPT, env: childEnv });
  const scheduler = createScheduler({
    readModel, runHour, runProjectionRepair, runHistoryBackfill,
    historyStartHour: ARC_PUBLIC_MAINNET_FIRST_COMPLETE_HOUR, log, onFatal: fatal,
  });
  const server = createIntelligenceServer({ readModel, log, onFatal: fatal });
  service = startIntelligenceService({ config, readModel, scheduler, server, log });
  process.once('SIGTERM', () => { void service.shutdown(0, 'SIGTERM'); });
  process.once('SIGINT', () => { void service.shutdown(0, 'SIGINT'); });
  process.on('uncaughtException', (error) => {
    console.log(`SERVICE_UNCAUGHT ${error?.code ?? error?.name ?? 'error'}`);
    void service.shutdown(1, 'uncaught_exception');
  });
  process.on('unhandledRejection', (error) => {
    console.log(`SERVICE_UNHANDLED_REJECTION ${error?.code ?? error?.name ?? 'error'}`);
    void service.shutdown(1, 'unhandled_rejection');
  });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) await main();
