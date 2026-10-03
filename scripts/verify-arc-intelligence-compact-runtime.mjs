// Compact Intelligence runtime: deterministic checks for the in-process scheduler, the memory-isolated child runner and
// the service shutdown path. Fake clock and fake runner for scheduling; real child processes running tiny temporary
// scripts for process handling. No Arc RPC, no SQLite writes, no network. Runs on any supported Node.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  assertHourIso, backoffMs, CHILD_NODE_ARGS, createChildHourRunner, createScheduler, DEFAULT_SAFETY_DELAY_MS, hourIso, latestSafeHourStart,
  MAX_BACKOFF_MS,
} from '../server/compact/scheduler.js';
import { RUNNER_SCRIPT, serviceConfig, startIntelligenceService } from './serve-compact-intelligence.mjs';

let passed = 0;
async function test(name, run) { await run(); passed += 1; console.log(`PASS ${name}`); }

const H = 3600;
const BASE = Date.UTC(2026, 9, 1, 0) / 1000;
const at = (hours, minutes = 0) => (BASE + hours * H + minutes * 60) * 1000;
const settle = () => new Promise((done) => setImmediate(done));

// A fake world: a clock, a checkpoint the fake runner advances exactly like the real runner (only checkpoint + 1 commits),
// timers that never fire on their own, and a log of every child start.
function world({ checkpoint = null, clock = at(10, 6), behavior = () => 'commit', candidates = () => [] } = {}) {
  const state = { checkpoint, clock, starts: [], running: 0, maxRunning: 0, timers: [], terminated: [], pending: [] };
  const readModel = {
    checkpoint: () => (state.checkpoint === null ? null : { hourStart: state.checkpoint, lastBlock: 1 }),
    repairCandidates: ({ fromHour, toHour }) => candidates(state).filter((hour) => hour >= fromHour && hour <= toHour),
  };
  function runHour(hour) {
    const hourStart = Date.parse(hour) / 1000;
    state.starts.push(hourStart);
    state.running += 1;
    state.maxRunning = Math.max(state.maxRunning, state.running);
    const mode = behavior(hourStart, state);
    let finish;
    const done = new Promise((resolve) => { finish = resolve; });
    const complete = (outcome) => {
      state.running -= 1;
      finish({ exitCode: outcome.exitCode, signal: outcome.signal ?? null, error: null, startedAt: state.clock, finishedAt: state.clock });
    };
    const commit = () => {
      // The real runner refuses anything but checkpoint + 1 (or the first hour of an empty store).
      if (state.checkpoint === null || hourStart === state.checkpoint + H) state.checkpoint = hourStart;
    };
    if (mode === 'commit') { commit(); complete({ exitCode: 0 }); }
    else if (mode === 'commit-unavailable') { commit(); complete({ exitCode: 1 }); }
    else if (mode === 'fail') complete({ exitCode: 1 });
    else if (mode === 'repair') complete({ exitCode: 0 });
    else state.pending.push({ hourStart, release: () => { commit(); complete({ exitCode: 0 }); } }); // 'hold'
    return {
      hour,
      done,
      terminate: async () => {
        state.terminated.push(hourStart);
        const index = state.pending.findIndex((entry) => entry.hourStart === hourStart);
        if (index >= 0) { state.pending.splice(index, 1); complete({ exitCode: null, signal: 'SIGTERM' }); }
        return done;
      },
    };
  }
  let fatal = 0;
  const scheduler = createScheduler({
    readModel, runHour, now: () => state.clock, onFatal: () => { fatal += 1; },
    setTimer: (fn, ms) => { const handle = { fn, ms }; state.timers.push(handle); return handle; },
    clearTimer: (handle) => { state.timers = state.timers.filter((timer) => timer !== handle); },
  });
  return { state, scheduler, readModel, fatal: () => fatal };
}

await test('scheduler: the safe hour is the latest UTC hour that ended at least five minutes ago', () => {
  assert.equal(DEFAULT_SAFETY_DELAY_MS, 5 * 60_000);
  assert.equal(latestSafeHourStart(at(10, 4)), BASE + 8 * H, '10:04 -> 09:00 has ended only 4 minutes ago');
  assert.equal(latestSafeHourStart(at(10, 5)), BASE + 9 * H);
  assert.equal(latestSafeHourStart(at(10, 59)), BASE + 9 * H);
  assert.equal(latestSafeHourStart(at(11, 5)), BASE + 10 * H);
});

await test('scheduler: hour arguments are exact UTC hour ISO strings; nothing else reaches a child', () => {
  assert.equal(hourIso(BASE + 7 * H), '2026-10-01T07:00:00.000Z');
  assert.equal(assertHourIso('2026-10-01T07:00:00.000Z'), '2026-10-01T07:00:00.000Z');
  for (const bad of ['2026-10-01T07:30:00.000Z', '2026-10-01T07:00:00Z', '2026-10-01T07:00:00.000+01:00', ' 2026-10-01T07:00:00.000Z',
    '2026-10-01T07:00:00.000Z; rm -rf /', '$(id)', '2026-02-30T07:00:00.000Z', 7, null]) {
    assert.throws(() => assertHourIso(bad), /invalid_hour_argument/, String(bad));
  }
  assert.throws(() => hourIso(BASE + 1800), /invalid_hour/);
});

await test('scheduler: caught up means no child, and a wake-up no later than the next safe hour', async () => {
  const { state, scheduler } = world({ checkpoint: BASE + 9 * H, clock: at(10, 6) });
  await scheduler.tick();
  assert.deepEqual(state.starts, []);
  assert.equal(state.timers.length, 1);
  assert.ok(state.timers[0].ms <= 5 * 60_000);
});

await test('scheduler: one hour behind processes exactly checkpoint + 1 and stops', async () => {
  const { state, scheduler } = world({ checkpoint: BASE + 8 * H, clock: at(10, 6) });
  await scheduler.tick();
  assert.deepEqual(state.starts, [BASE + 9 * H]);
  assert.equal(state.checkpoint, BASE + 9 * H);
});

await test('scheduler: several hours behind are processed in strict checkpoint + 1 order, never from the wall clock', async () => {
  const { state, scheduler } = world({ checkpoint: BASE + 3 * H, clock: at(10, 6) });
  await scheduler.tick();
  assert.deepEqual(state.starts, [4, 5, 6, 7, 8, 9].map((hour) => BASE + hour * H));
  assert.notEqual(state.starts[0], latestSafeHourStart(at(10, 6)), 'the first hour is checkpoint + 1, not the latest wall-clock hour');
  assert.equal(state.maxRunning, 1);
});

await test('scheduler: a failed hour is retried itself after a bounded backoff; no later hour starts before it commits', async () => {
  let failuresLeft = 3;
  const { state, scheduler } = world({ checkpoint: BASE + 7 * H, clock: at(10, 6),
    behavior: (hour) => (hour === BASE + 8 * H && failuresLeft-- > 0 ? 'fail' : 'commit') });
  await scheduler.tick();
  assert.deepEqual(state.starts, [BASE + 8 * H]);
  await scheduler.tick(); // still inside the first backoff (1 minute): nothing starts
  assert.deepEqual(state.starts, [BASE + 8 * H]);
  state.clock += 60_000;
  await scheduler.tick();
  state.clock += 2 * 60_000;
  await scheduler.tick();
  assert.deepEqual(state.starts, [8, 8, 8].map((hour) => BASE + hour * H), 'only the failed hour is retried');
  state.clock += 4 * 60_000;
  await scheduler.tick();
  assert.deepEqual(state.starts, [8, 8, 8, 8, 9].map((hour) => BASE + hour * H));
  assert.equal(state.checkpoint, BASE + 9 * H);
  assert.equal(scheduler.status().consecutiveFailures, 0);
});

await test('scheduler: backoff doubles from one minute and is capped at thirty minutes', () => {
  assert.deepEqual([1, 2, 3, 4, 5, 6, 7, 50].map((failures) => backoffMs(failures)),
    [60_000, 120_000, 240_000, 480_000, 960_000, 1_800_000, 1_800_000, 1_800_000]);
  assert.equal(MAX_BACKOFF_MS, 30 * 60_000);
  assert.equal(backoffMs(0), 0);
});

await test('scheduler: an always-failing hour never busy-loops and never skips ahead', async () => {
  const { state, scheduler } = world({ checkpoint: BASE + 7 * H, clock: at(10, 6), behavior: () => 'fail' });
  for (let round = 0; round < 12; round++) {
    await scheduler.tick();
    await scheduler.tick();
    state.clock += 45 * 60_000;
  }
  assert.ok(state.starts.every((hour) => hour === BASE + 8 * H));
  assert.ok(state.starts.length <= 12, `${state.starts.length} attempts`);
  assert.ok(state.timers.every((timer) => timer.ms >= 1000), 'never a zero-delay loop');
});

await test('scheduler: an hour committed with an unavailable family (runner exit 1) counts as progress, not failure', async () => {
  const { state, scheduler } = world({ checkpoint: BASE + 7 * H, clock: at(10, 6), behavior: () => 'commit-unavailable' });
  await scheduler.tick();
  assert.deepEqual(state.starts, [BASE + 8 * H, BASE + 9 * H]);
  assert.equal(scheduler.status().consecutiveFailures, 0);
});

await test('scheduler: concurrent ticks never start a second child', async () => {
  const { state, scheduler } = world({ checkpoint: BASE + 7 * H, clock: at(10, 6), behavior: () => 'hold' });
  const runs = [scheduler.tick(), scheduler.tick(), scheduler.tick()];
  await settle();
  assert.equal(state.starts.length, 1);
  assert.equal(state.running, 1);
  state.pending.shift().release();
  await settle();
  assert.equal(state.starts.length, 2, 'the next hour starts only after the first finished');
  state.pending.shift().release();
  await Promise.all(runs);
  assert.equal(state.maxRunning, 1);
  assert.deepEqual(state.starts, [BASE + 8 * H, BASE + 9 * H]);
});

await test('scheduler: a newly completed hour is detected on a later tick', async () => {
  const { state, scheduler } = world({ checkpoint: BASE + 9 * H, clock: at(10, 6) });
  await scheduler.tick();
  assert.deepEqual(state.starts, []);
  state.clock = at(11, 6);
  await scheduler.tick();
  assert.deepEqual(state.starts, [BASE + 10 * H]);
});

await test('scheduler: an empty store starts with the latest safe hour only, never a historical backfill', async () => {
  const { state, scheduler } = world({ checkpoint: null, clock: at(10, 6) });
  await scheduler.tick();
  assert.deepEqual(state.starts, [BASE + 9 * H]);
});

await test('scheduler: stop() prevents any future start', async () => {
  const { state, scheduler } = world({ checkpoint: BASE + 5 * H, clock: at(10, 6) });
  await scheduler.stop();
  scheduler.start();
  await scheduler.tick();
  assert.deepEqual(state.starts, []);
  assert.deepEqual(state.timers, []);
});

await test('scheduler: stop() terminates the active child, waits for it, and starts nothing after it', async () => {
  const { state, scheduler } = world({ checkpoint: BASE + 7 * H, clock: at(10, 6), behavior: () => 'hold' });
  const run = scheduler.tick();
  await settle();
  assert.equal(state.running, 1);
  await scheduler.stop();
  await run;
  assert.deepEqual(state.terminated, [BASE + 8 * H]);
  assert.equal(state.running, 0);
  assert.equal(state.checkpoint, BASE + 7 * H, 'a terminated child commits nothing');
  assert.deepEqual(state.starts, [BASE + 8 * H]);
});

await test('scheduler: repair runs only when caught up, at most one per tick, within 24 hours, with a cooldown', async () => {
  const unavailable = [BASE + 8 * H, BASE + 5 * H];
  const behind = world({ checkpoint: BASE + 7 * H, clock: at(10, 6), candidates: () => unavailable,
    behavior: (hour, state) => (hour <= state.checkpoint ? 'repair' : 'commit') });
  await behind.scheduler.tick();
  assert.deepEqual(behind.state.starts, [BASE + 8 * H, BASE + 9 * H, BASE + 8 * H], 'catch-up first, then one repair');
  const { state, scheduler } = world({ checkpoint: BASE + 9 * H, clock: at(10, 6), candidates: () => [BASE + 8 * H, BASE + 5 * H, BASE - 30 * H],
    behavior: () => 'repair' });
  await scheduler.tick();
  assert.deepEqual(state.starts, [BASE + 8 * H]);
  await scheduler.tick();
  assert.deepEqual(state.starts, [BASE + 8 * H, BASE + 5 * H], 'one repair per tick, the next candidate');
  await scheduler.tick();
  assert.equal(state.starts.length, 2, 'both candidates are cooling down; the one older than 24 hours is never repaired');
  state.clock += 60_000; // one minute later: both are still cooling down and the chain is still caught up
  await scheduler.tick();
  assert.equal(state.starts.length, 2);
});

await test('scheduler: an incompatible database is fatal and starts nothing', async () => {
  const fatalWorld = world({ checkpoint: BASE + 7 * H });
  fatalWorld.readModel.checkpoint = () => { throw Object.assign(new Error('incompatible'), { code: 'incompatible' }); };
  await fatalWorld.scheduler.tick();
  assert.equal(fatalWorld.fatal(), 1);
  assert.deepEqual(fatalWorld.state.starts, []);
});

// ---------------------------------------------------------------------------------------------------------------------
// Real child processes running tiny temporary scripts.
const workdir = mkdtempSync(join(tmpdir(), 'compact-runtime-'));
const script = (name, body) => {
  const path = join(workdir, name);
  writeFileSync(path, body);
  return path;
};
const recorder = script('record.mjs', `import { writeFileSync } from 'node:fs';
writeFileSync(process.env.CHILD_OUT, JSON.stringify({ argv: process.argv.slice(2), execArgv: process.execArgv }));
process.exit(Number(process.env.CHILD_EXIT ?? 0));
`);
const sleeper = script('sleep.mjs', 'setInterval(() => {}, 1000);\n');
const stubborn = script('stubborn.mjs', "process.on('SIGTERM', () => {});\nsetInterval(() => {}, 1000);\n");

await test('child runner: the existing runner command keeps its memory flags, gets one validated hour argument and no shell', async () => {
  assert.deepEqual(CHILD_NODE_ARGS, ['--max-old-space-size=64', '--max-semi-space-size=2']);
  assert.ok(RUNNER_SCRIPT.endsWith('/scripts/run-compact-hour.mjs'));
  const out = join(workdir, 'out.json');
  const runHour = createChildHourRunner({ scriptPath: recorder, env: { ...process.env, CHILD_OUT: out, CHILD_EXIT: '0' } });
  const result = await runHour('2026-10-01T07:00:00.000Z').done;
  assert.equal(result.exitCode, 0);
  assert.ok(result.finishedAt >= result.startedAt);
  const seen = JSON.parse(readFileSync(out, 'utf8'));
  assert.deepEqual(seen, { argv: ['2026-10-01T07:00:00.000Z'], execArgv: ['--max-old-space-size=64', '--max-semi-space-size=2'] });
  const failing = await createChildHourRunner({ scriptPath: recorder, env: { ...process.env, CHILD_OUT: out, CHILD_EXIT: '1' } })('2026-10-01T08:00:00.000Z').done;
  assert.equal(failing.exitCode, 1);
  const source = readFileSync(new URL('../server/compact/scheduler.js', import.meta.url), 'utf8');
  assert.match(source, /shell: false/);
  assert.doesNotMatch(source, /shell: true|execSync|exec\(/);
});

await test('child runner: an invalid hour never spawns', () => {
  let spawned = 0;
  const runHour = createChildHourRunner({ scriptPath: recorder, spawnImpl: () => { spawned += 1; } });
  assert.throws(() => runHour('2026-10-01T07:00:00.000Z && echo hi'), /invalid_hour_argument/);
  assert.equal(spawned, 0);
});

await test('child runner: terminate() sends SIGTERM, and SIGKILL after the grace period if the child ignores it', async () => {
  const polite = createChildHourRunner({ scriptPath: sleeper, killGraceMs: 2_000 })('2026-10-01T07:00:00.000Z');
  await new Promise((done) => setTimeout(done, 150));
  assert.equal((await polite.terminate()).signal, 'SIGTERM');
  const stubbornChild = createChildHourRunner({ scriptPath: stubborn, killGraceMs: 300 })('2026-10-01T07:00:00.000Z');
  await new Promise((done) => setTimeout(done, 300));
  assert.equal((await stubbornChild.terminate()).signal, 'SIGKILL');
});

await test('service: configuration is validated before anything starts', () => {
  assert.deepEqual(serviceConfig({ env: { COMPACT_SQLITE_PATH: '/data/arc-compact.sqlite' } }),
    { sqlitePath: '/data/arc-compact.sqlite', minIntervalMs: 1000, port: 8080, host: '0.0.0.0' });
  assert.equal(serviceConfig({ env: { COMPACT_SQLITE_PATH: '/data/x.sqlite', PORT: '3000', COMPACT_RPC_MIN_INTERVAL_MS: '1500' } }).port, 3000);
  for (const [env, code] of [[{}, 'sqlite_path_required'], [{ COMPACT_SQLITE_PATH: ':memory:' }, 'sqlite_path_required'],
    [{ COMPACT_SQLITE_PATH: 'file:x.sqlite' }, 'sqlite_path_required'], [{ COMPACT_SQLITE_PATH: '/d.sqlite', COMPACT_RPC_MIN_INTERVAL_MS: '250' }, 'unsafe_rpc_pacing'],
    [{ COMPACT_SQLITE_PATH: '/d.sqlite', PORT: '80a' }, 'invalid_port'], [{ COMPACT_SQLITE_PATH: '/d.sqlite', PORT: '70000' }, 'invalid_port']]) {
    assert.throws(() => serviceConfig({ env }), (error) => error.code === code, JSON.stringify(env));
  }
});

await test('service: shutdown stops the scheduler first, then HTTP, then the read connection, exactly once', async () => {
  const order = [];
  const scheduler = { start: () => order.push('scheduler.start'), stop: async () => { order.push('scheduler.stop'); await settle(); } };
  const server = {
    listen: (_port, _host, done) => { order.push('server.listen'); done?.(); },
    close: (done) => { order.push('server.close'); setImmediate(done); },
    closeIdleConnections: () => order.push('server.closeIdle'),
    closeAllConnections: () => {},
  };
  const readModel = { close: () => order.push('readModel.close') };
  const exits = [];
  const service = startIntelligenceService({ config: { port: 1, host: '127.0.0.1' }, readModel, scheduler, server, log: () => {},
    exit: (code) => exits.push(code) });
  const first = service.shutdown(0, 'SIGTERM');
  const second = service.shutdown(1, 'SIGINT');
  assert.equal(first, second, 'a second signal joins the first shutdown');
  await first;
  assert.deepEqual(order, ['server.listen', 'scheduler.start', 'scheduler.stop', 'server.close', 'server.closeIdle', 'readModel.close']);
  assert.deepEqual(exits, [0]);
});

await test('railway.toml: always-on server, restart on failure, /health check, no cron and no sleeping', () => {
  const toml = readFileSync(new URL('../railway.toml', import.meta.url), 'utf8');
  assert.match(toml, /^startCommand = "exec node --max-old-space-size=128 scripts\/serve-compact-intelligence\.mjs"$/m);
  assert.match(toml, /^restartPolicyType = "ON_FAILURE"$/m);
  assert.match(toml, /^healthcheckPath = "\/health"$/m);
  assert.doesNotMatch(toml, /cronSchedule|sleepApplication\s*=\s*true|run-compact-hour\.mjs \\"\$HOUR|restartPolicyType = "NEVER"/);
  assert.match(toml, /Serverless \(app sleeping\) must be OFF/);
});

rmSync(workdir, { recursive: true, force: true });
console.log(`\nCompact Intelligence runtime checks: ${passed} passed`);
