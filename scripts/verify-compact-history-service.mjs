import assert from 'node:assert/strict';
import { createScheduler, HOUR_MS } from '../server/compact/scheduler.js';

const HOUR = HOUR_MS / 1000;
const START = Date.parse('2026-09-16T11:00:00Z') / 1000;
const LIVE = Date.parse('2026-10-06T17:00:00Z') / 1000;

function immediateHandle(onDone = () => {}) {
  return {
    done: Promise.resolve().then(() => { onDone(); return { exitCode: 0, signal: null, error: null, startedAt: 1, finishedAt: 2 }; }),
    terminate: async () => ({ exitCode: 0, signal: null, error: null }),
  };
}

async function oneTick({ checkpoint = LIVE, earliest = START + 3 * HOUR, latestSafe = LIVE, history = true } = {}) {
  let cp = checkpoint;
  let first = earliest;
  const calls = [];
  let scheduled = null;
  const nowMs = (latestSafe + HOUR) * 1000; // latestSafeHourStart(now, 0) == latestSafe
  const readModel = {
    checkpoint: () => ({ hourStart: cp, lastBlock: 1 }),
    historyBounds: () => ({ first, last: cp, count: ((cp - first) / HOUR) + 1 }),
    repairCandidates: () => [],
    projectionRepairCandidates: () => ({ hours: [], blocked: [] }),
  };
  const runHour = (hour) => ({ hour, ...immediateHandle(() => { cp += HOUR; calls.push(`live:${hour}`); }) });
  const runHistoryBackfill = history ? () => immediateHandle(() => { first -= HOUR; calls.push('history'); }) : null;
  const scheduler = createScheduler({
    readModel, runHour, runHistoryBackfill, historyStartHour: START,
    now: () => nowMs, safetyDelayMs: 0, tickMs: 60_000,
    setTimer: (fn, delay) => { scheduled = { fn, delay }; return 1; },
    clearTimer: () => {},
  });
  await scheduler.tick();
  await scheduler.stop();
  return { calls, first, cp, scheduled };
}

// When live is caught up, history keeps advancing until the durable public-mainnet boundary.
{
  const out = await oneTick();
  assert.deepEqual(out.calls, ['history', 'history', 'history']);
  assert.equal(out.first, START);
}

// A due live hour always wins before history, then history resumes automatically.
{
  const out = await oneTick({ checkpoint: LIVE - HOUR, earliest: START + 3 * HOUR, latestSafe: LIVE });
  assert.match(out.calls[0], /^live:/);
  assert.deepEqual(out.calls.slice(1), ['history', 'history', 'history']);
  assert.equal(out.first, START);
}

// A restarted service resumes from the durable earliest stored hour rather than starting over.
{
  const out = await oneTick({ earliest: START + 2 * HOUR });
  assert.deepEqual(out.calls, ['history', 'history']);
  assert.equal(out.first, START);
}

// Once the public-mainnet boundary is reached, history does not run.
{
  const out = await oneTick({ earliest: START });
  assert.deepEqual(out.calls, []);
}

console.log('VERIFIER PASS compact-history-service 4 tests');
