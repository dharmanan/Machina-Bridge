// Default: read-only current-30D plan. --execute requires exactly ONE stored UTC hour; no bulk mode.
import { existsSync, statfsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { assertHourIso } from '../server/compact/scheduler.js';
import { acquireWriterLock } from '../server/compact/writer-lock.js';
import { createProvider, ProviderError, providerDiagnostics } from '../server/compact/provider.js';
import { planDiscoveryRecovery, recoveryHourPlan, recoverDiscoveryHour, assertRecoverySchema, RECOVERY_TIMEOUT_MS } from '../server/compact/discovery-recovery.js';
import { archiveConfig, storagePreflight } from '../server/compact/evidence-archive.js';

export const RECOVERY_BUDGET = Object.freeze({ requests: 512, calls: 20000, bytes: 64 * 1024 * 1024,
  responseBytes: 8 * 1024 * 1024, timeoutMs: RECOVERY_TIMEOUT_MS });
export function recoveryConfig({ argv = process.argv.slice(2), env = process.env } = {}) {
  const execute = argv.includes('--execute');
  const hours = argv.filter(arg => arg !== '--execute');
  if (argv.filter(arg => arg === '--execute').length > 1 || hours.length > 1 || execute && hours.length !== 1) throw new Error('one_exact_hour_required');
  const hourStart = hours.length ? Date.parse(assertHourIso(hours[0])) / 1000 : null;
  const path = env.COMPACT_SQLITE_PATH?.trim();
  if (!path || path === ':memory:' || path.startsWith('file:')) throw new Error('existing_sqlite_path_required');
  const pacing = env.COMPACT_RPC_MIN_INTERVAL_MS ?? '1000';
  if (!/^\d+$/.test(pacing) || Number(pacing) < 1000 || Number(pacing) > 10000) throw new Error('unsafe_recovery_rpc_pacing');
  return { sqlitePath: resolve(path), execute, hourStart, minIntervalMs: Number(pacing) };
}
// Counts physical HTTP requests INCLUDING chain checks and every batch item. Abort applies during pacing and fetch.
export function boundedRecoveryProvider({ fetchImpl = globalThis.fetch, now = Date.now, minIntervalMs = 1000,
  budget = RECOVERY_BUDGET, sleep, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  const started = now(), controller = new AbortController();
  const stats = { requests: 0, calls: 0, bytes: 0 };
  let failure = null;
  const error = code => new ProviderError(code, { phase: 'budget' });
  const exhausted = code => { failure ??= error(code); throw failure; };
  const check = () => {
    if (failure) throw failure;
    if (controller.signal.aborted || now() - started >= budget.timeoutMs) exhausted('recovery_time_budget_exhausted');
  };
  const timer = setTimer(() => controller.abort(), budget.timeoutMs);
  timer.unref?.();
  const provider = createProvider({ minIntervalMs, maxAttempts: 1, timeoutMs: 10000, ...(sleep ? { sleep } : {}),
    fetchImpl: async (url, options) => {
      check();
      const count = [].concat(JSON.parse(options.body)).length;
      if (stats.requests >= budget.requests || stats.calls + count > budget.calls) exhausted('recovery_rpc_budget_exhausted');
      stats.requests++; stats.calls += count;
      let response;
      try { response = await fetchImpl(url, { ...options, signal: AbortSignal.any([options.signal, controller.signal]) }); }
      catch (err) { if (controller.signal.aborted) exhausted('recovery_time_budget_exhausted'); throw err; }
      return { ok: response.ok, status: response.status, async text() {
        const chunks = []; let size = 0;
        const reader = response.body.getReader();
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            size += value.byteLength; stats.bytes += value.byteLength;
            if (size > budget.responseBytes || stats.bytes > budget.bytes) {
              // Latch the budget failure BEFORE cancellation; even a failing cancel must not hide it.
              failure ??= error('recovery_response_budget_exhausted');
              controller.abort();
              try { void reader.cancel().catch(() => {}); } catch {} // Cleanup must not stall the failure/deadline.
              throw failure;
            }
            chunks.push(Buffer.from(value));
          }
        } catch (err) { if (controller.signal.aborted) exhausted('recovery_time_budget_exhausted'); throw err; }
        finally { reader.releaseLock(); }
        check();
        return Buffer.concat(chunks).toString('utf8');
      } };
    } });
  const guarded = async fn => {
    check();
    try { return await fn(); } catch (err) {
      // Existing bounded log splitting needs another narrower request; every physical attempt still consumes budget.
      if (!['range_too_large', 'too_many_results'].includes(err.code)) {
        failure ??= err; failure.recoveryUsage = { ...stats }; throw failure;
      }
      throw err;
    }
  };
  const canContinue = (calls = 32) => {
    check();
    // Reserve a maximum next body response PLUS a maximum boundary response.
    // Yield before exhaustion; this does not relax any hard provider guard.
    return stats.bytes + 2 * budget.responseBytes <= budget.bytes
      && stats.requests + 3 <= budget.requests && stats.calls + calls + 8 <= budget.calls
      && now() - started + 30_000 < budget.timeoutMs;
  };
  return { stats, check, close: () => clearTimer(timer), provider: {
    stats, canContinue,
    request: (...args) => guarded(() => provider.request(...args)),
    batch: (...args) => guarded(() => provider.batch(...args))
  } };
}
export async function runDiscoveryRecovery(config, { Database = DatabaseSync, providerFactory = boundedRecoveryProvider, print = console.log,
  storage = archiveConfig(), capacity } = {}) {
  let lock, db, bounded;
  try {
    if (!existsSync(config.sqlitePath)) throw new Error('existing_sqlite_path_required');
    if (config.execute) lock = acquireWriterLock(config.sqlitePath, { owner: 'discovery-recovery' });
    db = new Database(config.sqlitePath, { readOnly: !config.execute });
    db.exec(`PRAGMA busy_timeout=1000; PRAGMA foreign_keys=ON; ${config.execute ? 'PRAGMA synchronous=FULL; PRAGMA cache_size=-2048; PRAGMA temp_store=FILE;' : 'PRAGMA query_only=ON;'}`);
    assertRecoverySchema(db);
    if (!config.execute) {
      db.exec('BEGIN');
      let plan;
      try { plan = config.hourStart === null ? planDiscoveryRecovery(db) : recoveryHourPlan(db, config.hourStart); }
      finally { db.exec('ROLLBACK'); }
      print(`DISCOVERY_RECOVERY_PLAN ${JSON.stringify(plan)}`);
      return { phase: 'planned', plan };
    }
    const plan = recoveryHourPlan(db, config.hourStart);
    if (plan.phase !== 'pending') {
      print(`DISCOVERY_RECOVERY_SKIP ${JSON.stringify(plan)}`);
      return plan;
    }
    const checkStorage = (plannedBytes = 8*1024*1024) => {
      const preflight=storagePreflight(db,storage,{plannedBytes,capacity});
      if(!preflight.ok)throw Object.assign(new Error(preflight.reason),{code:preflight.reason});
      if (plannedBytes > 8*1024*1024) {
        let freeBytes;
        try { const fs=statfsSync(process.env.SQLITE_TMPDIR || tmpdir(),{bigint:true});freeBytes=Number(fs.bavail*fs.bsize); } catch {}
        if (!Number.isSafeInteger(freeBytes) || freeBytes-plannedBytes*4<storage.minFreeBytes)
          throw Object.assign(new Error('recovery_temp_capacity_insufficient'),{code:'recovery_temp_capacity_insufficient'});
      }
    };
    checkStorage(); // Before constructing a provider, leases, recovery evidence or any historical RPC.
    bounded = providerFactory({ minIntervalMs: config.minIntervalMs });
    const result = await recoverDiscoveryHour({ db, hourStart: config.hourStart, provider: bounded.provider, oneUnit: true, storage,
      checkBudget:()=>{bounded.check();checkStorage();},checkStorage, log: print });
    print(`DISCOVERY_RECOVERY_RESULT ${JSON.stringify({ ...result, provider: bounded.stats })}`);
    return result;
  } catch (error) {
    const result = { phase: 'retryable', reason: error.code ?? 'recovery_failed', diagnostics: providerDiagnostics(error),
      ...(bounded ? { provider: bounded.stats } : {}) };
    print(`DISCOVERY_RECOVERY_RESULT ${JSON.stringify(result)}`);
    return result;
  } finally { bounded?.close(); db?.close(); lock?.release(); }
}
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    if (Number(process.versions.node.split('.')[0]) !== 24) throw new Error('node24_required');
    const config = recoveryConfig();
    if (config.execute && (await import('node:v8')).getHeapStatistics().heap_size_limit > 96 * 1024 * 1024) throw new Error('recovery_heap_limit_required');
    const result = await runDiscoveryRecovery(config);
    process.exitCode = ['planned', 'recovered'].includes(result.phase) ? 0 : 1;
  } catch (error) { console.log(`DISCOVERY_RECOVERY_FAIL ${error.message}`); process.exitCode = 1; }
}
