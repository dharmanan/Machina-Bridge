import { statSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { replayHourActiveAddresses } from '../server/compact/daily-active-replay.js';
import { createProvider } from '../server/compact/provider.js';
import { createCompactStore } from '../server/compact/store.js';
import { acquireWriterLock } from '../server/compact/writer-lock.js';

const HOUR = 3600;
const DEFAULT_RPC_INTERVAL_MS = 1000;
const MIN_RPC_INTERVAL_MS = 500;
const iso = (seconds) => new Date(seconds * 1000).toISOString();

function config(argv = process.argv.slice(2), env = process.env) {
  const rawHour = argv[0] ?? '';
  const hourStart = Date.parse(rawHour) / 1000;
  if (Number.isSafeInteger(hourStart) === false || hourStart % HOUR !== 0) {
    throw new Error('invalid_dau_replay_hour');
  }

  const rawPath = env.COMPACT_SQLITE_PATH?.trim();
  if (typeof rawPath === 'string' && rawPath.length > 0 && rawPath !== ':memory:' && rawPath.startsWith('file:') === false) {
    const sqlitePath = resolve(rawPath);
    statSync(sqlitePath);

    const rawPacing = env.COMPACT_RPC_MIN_INTERVAL_MS ?? String(DEFAULT_RPC_INTERVAL_MS);
    const minIntervalMs = /^\d+$/.test(rawPacing) ? Number(rawPacing) : Number.NaN;
    if (Number.isSafeInteger(minIntervalMs) && minIntervalMs >= MIN_RPC_INTERVAL_MS) {
      return { hourStart, sqlitePath, minIntervalMs };
    }
  }

  throw new Error('invalid_dau_replay_config');
}

export async function runDailyActiveReplay({ sqlitePath, hourStart, provider, print = console.log }) {
  let db = null;
  let lock = null;

  try {
    lock = acquireWriterLock(sqlitePath, { owner: 'replay-compact-dau-hour' });
    const { DatabaseSync } = await import('node:sqlite');
    db = new DatabaseSync(sqlitePath);

    const store = createCompactStore(db);
    const candidate = store.dailyActiveReplayCandidate();

    if (candidate === hourStart) {
      const hour = store.storedHour(hourStart);
      if (hour === null) throw new Error('dau_replay_hour_missing');

      const checkpointBefore = store.checkpoint();
      const addresses = await replayHourActiveAddresses({ provider, hour });
      const result = store.replayDailyActiveAddresses(hourStart, addresses);
      const checkpointAfter = store.checkpoint();

      const checkpointUnchanged =
        checkpointBefore?.hourStart === checkpointAfter?.hourStart &&
        checkpointBefore?.lastBlock === checkpointAfter?.lastBlock &&
        checkpointBefore?.lastHash === checkpointAfter?.lastHash;

      if (checkpointUnchanged === false) throw new Error('dau_replay_checkpoint_changed');

      print(`DAU_REPLAY_HOUR ${iso(hourStart)} addresses=${addresses.length}`);
      print(`DAU_REPLAY_DAY ${iso(result.dayStart)} status=${result.status} finalized=${result.finalized}`);
      print('RESULT PASS');
      return { ok: true, hourStart, addresses: addresses.length, result };
    }

    throw new Error('dau_replay_candidate_changed');
  } finally {
    db?.close();
    lock?.release();
  }
}

async function main() {
  try {
    const current = config();
    const provider = createProvider({ minIntervalMs: current.minIntervalMs });
    await runDailyActiveReplay({
      sqlitePath: current.sqlitePath,
      hourStart: current.hourStart,
      provider,
    });
  } catch (error) {
    console.log(`RESULT FAIL ${error?.code ?? error?.message ?? String(error)}`);
    process.exitCode = 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) await main();
