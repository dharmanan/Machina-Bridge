// Compact engine: deterministic in-process scheduler for the always-on Intelligence service. Work is derived from the
// committed checkpoint, never from the wall clock: the next hour is always checkpoint + 1 hour, processed one at a time by
// the unchanged scripts/run-compact-hour.mjs in a memory-isolated child process, until the latest safely complete UTC
// hour is committed. A failed hour is never skipped: the same hour is retried with bounded exponential backoff, and no
// later hour can start before it commits (the runner itself also refuses any checkpoint gap). Progress is judged by the
// checkpoint, not the exit code: the runner exits 1 when an hour commits with a family unavailable, which is progress.
// Only after the chain is caught up, at most one recent hour with an unavailable family is repaired per tick. Only when no
// family repair is due either, at most one stored hour whose Uniswap pool projection is missing or unavailable is repaired
// per tick by a projection-only child (scripts/repair-compact-projection-hour.mjs): never processHour, never the hour,
// its families or the checkpoint. Every child (catch-up, family repair, projection repair) is the single child of the
// single run loop, so no two ever overlap.
import { spawn } from 'node:child_process';

export const HOUR_MS = 3_600_000;
// An hour is processed once it ended at least this long ago. The runner searches the hour's boundaries under a safe head
// 200 blocks (about 102 s at Arc's ~0.51 s blocks) below the RPC head, so 5 minutes leaves ample margin; an hour that is
// still not finalized fails with hour_not_finalized and is simply retried, never skipped.
export const DEFAULT_SAFETY_DELAY_MS = 5 * 60_000;
export const DEFAULT_TICK_MS = 5 * 60_000;
export const DEFAULT_BASE_BACKOFF_MS = 60_000;
export const MAX_BACKOFF_MS = 30 * 60_000;
export const REPAIR_WINDOW_HOURS = 24;
export const REPAIR_COOLDOWN_MS = HOUR_MS;
// Projection repair looks back as far as pool-hours are kept (35 days, projections.js POOL_HOUR_RETENTION_HOURS), oldest
// first, one hour per tick, and retries the same hour at most once per hour.
export const PROJECTION_REPAIR_WINDOW_HOURS = 35 * 24;
export const PROJECTION_REPAIR_COOLDOWN_MS = HOUR_MS;
export const DEFAULT_CHILD_KILL_GRACE_MS = 15_000;
// Equivalent to the proven production command: node --max-old-space-size=64 --max-semi-space-size=2 run-compact-hour.mjs
export const CHILD_NODE_ARGS = Object.freeze(['--max-old-space-size=64', '--max-semi-space-size=2']);
const HOUR_SECONDS = 3600;
const HOUR_ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:00:00\.000Z$/;

// Start (UTC seconds) of the latest hour that ended at least safetyDelayMs before nowMs.
export function latestSafeHourStart(nowMs, safetyDelayMs = DEFAULT_SAFETY_DELAY_MS) {
  return Math.floor((nowMs - safetyDelayMs) / HOUR_MS) * HOUR_SECONDS - HOUR_SECONDS;
}

export function hourIso(hourStart) {
  if (!Number.isSafeInteger(hourStart) || hourStart % HOUR_SECONDS !== 0 || hourStart < 0) throw new Error('invalid_hour');
  return new Date(hourStart * 1000).toISOString();
}

// The only accepted child argument: an exact UTC hour ISO string that round-trips.
export function assertHourIso(value) {
  if (typeof value !== 'string' || !HOUR_ISO.test(value) || new Date(Date.parse(value)).toISOString() !== value) {
    throw new Error('invalid_hour_argument');
  }
  return value;
}

export function backoffMs(failures, baseMs = DEFAULT_BASE_BACKOFF_MS, maxMs = MAX_BACKOFF_MS) {
  if (failures < 1) return 0;
  return Math.min(maxMs, baseMs * 2 ** Math.min(failures - 1, 30));
}

// One child per call; the promise never rejects. terminate(): SIGTERM, then SIGKILL after the grace period. A killed
// child never commits its hour: the runner writes an hour in one SQLite transaction, which a dead process cannot finish.
export function createChildHourRunner({ scriptPath, execPath = process.execPath, env = process.env, spawnImpl = spawn,
  killGraceMs = DEFAULT_CHILD_KILL_GRACE_MS, now = () => Date.now() }) {
  if (typeof scriptPath !== 'string' || !scriptPath) throw new Error('script_path_required');
  return function runHour(hour) {
    const argument = assertHourIso(hour);
    const startedAt = now();
    const child = spawnImpl(execPath, [...CHILD_NODE_ARGS, scriptPath, argument], { stdio: ['ignore', 'inherit', 'inherit'], env,
      shell: false });
    let exited = false;
    const done = new Promise((resolve) => {
      child.once('error', () => { exited = true; resolve({ exitCode: null, signal: null, error: 'spawn_failed', startedAt, finishedAt: now() }); });
      child.once('exit', (exitCode, signal) => { exited = true; resolve({ exitCode, signal, error: null, startedAt, finishedAt: now() }); });
    });
    async function terminate() {
      if (!exited) {
        child.kill('SIGTERM');
        const timer = setTimeout(() => { if (!exited) child.kill('SIGKILL'); }, killGraceMs);
        try { return await done; } finally { clearTimeout(timer); }
      }
      return done;
    }
    return { hour: argument, done, terminate };
  };
}

// readModel: { checkpoint(), repairCandidates({ fromHour, toHour }), projectionRepairCandidates({ fromHour, toHour }) }
// (read-only). runHour(hourIso) / runProjectionRepair(hourIso): { done, terminate }. Without runProjectionRepair there is
// no projection repair at all.
export function createScheduler({ readModel, runHour, runProjectionRepair = null, now = () => Date.now(), setTimer = setTimeout,
  clearTimer = clearTimeout, log = () => {}, onFatal = null, safetyDelayMs = DEFAULT_SAFETY_DELAY_MS, tickMs = DEFAULT_TICK_MS,
  baseBackoffMs = DEFAULT_BASE_BACKOFF_MS, maxBackoffMs = MAX_BACKOFF_MS, repairWindowHours = REPAIR_WINDOW_HOURS,
  repairCooldownMs = REPAIR_COOLDOWN_MS, projectionRepairWindowHours = PROJECTION_REPAIR_WINDOW_HOURS,
  projectionRepairCooldownMs = PROJECTION_REPAIR_COOLDOWN_MS }) {
  let stopped = false;
  let active = null; // the single in-flight run loop
  let child = null; // the single running child
  let timer = null;
  let failures = 0;
  let retryAt = 0;
  const repairAttempts = new Map(); // hour start -> last attempt (ms)
  const projectionAttempts = new Map(); // hour start -> last projection repair attempt (ms)
  let blockedSummary = '';
  const status = { lastRun: null, consecutiveFailures: 0, retryAt: null, projectionRepairBlocked: null };

  async function runChild(hourStart, kind, runner = runHour) {
    const handle = runner(hourIso(hourStart));
    child = { kind, terminate: () => handle.terminate() };
    log(`SCHEDULER_CHILD_START kind=${kind} hour=${handle.hour}`);
    try {
      return await handle.done;
    } finally {
      child = null;
    }
  }

  // One unit of work. Returns { again } when another unit may run immediately, else the time to wake up.
  async function step() {
    const target = latestSafeHourStart(now(), safetyDelayMs);
    const checkpoint = readModel.checkpoint();
    // Empty store: only the latest safe hour, never a historical backfill.
    const next = checkpoint ? checkpoint.hourStart + HOUR_SECONDS : target;
    if (next <= target) {
      if (now() < retryAt) return { again: false, wakeAt: retryAt };
      const outcome = await runChild(next, 'catch_up');
      if (stopped) return { again: false };
      const after = readModel.checkpoint();
      const advanced = Boolean(after) && after.hourStart >= next;
      status.lastRun = { kind: 'catch_up', hour: hourIso(next), advanced, ...outcome };
      if (advanced) {
        failures = 0;
        retryAt = 0;
        log(`SCHEDULER_HOUR_COMMITTED hour=${hourIso(next)} exit=${outcome.exitCode}`);
        return { again: true };
      }
      failures += 1;
      retryAt = now() + backoffMs(failures, baseBackoffMs, maxBackoffMs);
      log(`SCHEDULER_HOUR_FAILED hour=${hourIso(next)} exit=${outcome.exitCode} signal=${outcome.signal} failures=${failures} `
        + `retry_at=${new Date(retryAt).toISOString()}`);
      return { again: false, wakeAt: retryAt };
    }
    // Caught up. At most one bounded repair of a recent hour, never ahead of chain catch-up.
    const nowMs = now();
    const fromHour = checkpoint.hourStart - (repairWindowHours - 1) * HOUR_SECONDS;
    const candidate = readModel.repairCandidates({ fromHour, toHour: checkpoint.hourStart })
      .find((hour) => nowMs - (repairAttempts.get(hour) ?? -Infinity) >= repairCooldownMs);
    for (const hour of repairAttempts.keys()) if (hour < fromHour) repairAttempts.delete(hour);
    const nextHourDue = (target + 2 * HOUR_SECONDS) * 1000 + safetyDelayMs;
    if (candidate !== undefined) {
      repairAttempts.set(candidate, nowMs);
      const outcome = await runChild(candidate, 'repair');
      status.lastRun = { kind: 'repair', hour: hourIso(candidate), ...outcome };
      log(`SCHEDULER_REPAIR_DONE hour=${hourIso(candidate)} exit=${outcome.exitCode}`);
      return { again: false, wakeAt: nextHourDue };
    }
    // Caught up and no family repair due: at most one projection-only repair, oldest eligible hour first.
    if (!runProjectionRepair) return { again: false, wakeAt: nextHourDue };
    const projectionFrom = checkpoint.hourStart - (projectionRepairWindowHours - 1) * HOUR_SECONDS;
    const { hours, blocked } = readModel.projectionRepairCandidates({ fromHour: projectionFrom, toHour: checkpoint.hourStart });
    for (const hour of projectionAttempts.keys()) if (hour < projectionFrom) projectionAttempts.delete(hour);
    noteBlocked(blocked);
    const projectionHour = hours.find((hour) => nowMs - (projectionAttempts.get(hour) ?? -Infinity) >= projectionRepairCooldownMs);
    if (projectionHour === undefined) return { again: false, wakeAt: nextHourDue };
    projectionAttempts.set(projectionHour, nowMs);
    const outcome = await runChild(projectionHour, 'projection_repair', runProjectionRepair);
    if (stopped) return { again: false };
    status.lastRun = { kind: 'projection_repair', hour: hourIso(projectionHour), ...outcome };
    log(`SCHEDULER_PROJECTION_REPAIR_DONE hour=${hourIso(projectionHour)} exit=${outcome.exitCode}`);
    return { again: false, wakeAt: nextHourDue };
  }

  // Hours waiting for a registry (never bootstrapped automatically): logged once per change, kept in status().
  function noteBlocked(blocked) {
    const counts = {};
    for (const entry of blocked) counts[entry.reason] = (counts[entry.reason] ?? 0) + 1;
    const summary = Object.keys(counts).sort().map((reason) => `${reason}:${counts[reason]}`).join(',');
    status.projectionRepairBlocked = summary ? counts : null;
    if (summary !== blockedSummary) log(`SCHEDULER_PROJECTION_REPAIR_BLOCKED ${summary || 'none'}`);
    blockedSummary = summary;
  }

  function schedule(wakeAt) {
    if (stopped) return;
    if (timer) clearTimer(timer);
    const delay = Math.max(1000, Math.min(tickMs, (wakeAt ?? now() + tickMs) - now()));
    timer = setTimer(() => { timer = null; void tick(); }, delay);
  }

  async function loop() {
    let wakeAt;
    try {
      for (;;) {
        if (stopped) return;
        const result = await step();
        wakeAt = result.wakeAt;
        if (!result.again) break;
      }
    } catch (error) {
      if (error?.code === 'incompatible') {
        log('SCHEDULER_FATAL code=incompatible');
        onFatal?.(error);
        return;
      }
      log(`SCHEDULER_ERROR code=${typeof error?.code === 'string' ? error.code : 'unknown'}`);
    } finally {
      status.consecutiveFailures = failures;
      status.retryAt = retryAt ? new Date(retryAt).toISOString() : null;
    }
    schedule(wakeAt);
  }

  // Never overlaps: a tick while a run is active returns that run.
  function tick() {
    if (stopped) return Promise.resolve();
    if (!active) active = loop().finally(() => { active = null; });
    return active;
  }

  return Object.freeze({
    start() {
      if (stopped || timer) return;
      timer = setTimer(() => { timer = null; void tick(); }, 0);
    },
    tick,
    // Stop accepting work, terminate a running child (bounded), and wait for the run loop to finish.
    async stop() {
      stopped = true;
      if (timer) clearTimer(timer);
      timer = null;
      await child?.terminate();
      await active;
    },
    status: () => ({ ...status, running: Boolean(child), stopped, runningKind: child?.kind ?? null }),
  });
}
