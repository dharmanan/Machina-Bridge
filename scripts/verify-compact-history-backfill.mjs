// Small acceptance test for the historical prepend primitive and CLI safety.
// No network. Uses node:sqlite in memory. This is intentionally not a broad Arc audit.
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { FAMILY_FIELDS } from '../server/compact/families.js';
import { HOUR_SECONDS } from '../server/compact/hour.js';
import { ARC_CHAIN_ID } from '../server/compact/provider.js';
import { COMPACT_DEFINITION_VERSION } from '../server/compact/sources.js';
import { createCompactStore } from '../server/compact/store.js';
import {
  ARC_PUBLIC_MAINNET_FIRST_COMPLETE_HOUR,
  ARC_PUBLIC_MAINNET_LIVE_AT,
  discoverHistoryStart,
  historyBackfillConfig,
} from './backfill-compact-history.mjs';

let passed = 0;
const test = (name, fn) => {
  fn();
  passed += 1;
  console.log(`PASS ${name}`);
};
const BASE = Date.parse('2026-09-16T00:00:00Z') / 1000;
const hash = (n) => `0x${n.toString(16).padStart(64, '0')}`;
const familyUnavailable = () => Object.fromEntries(Object.entries(FAMILY_FIELDS).map(([name, fields]) => [name, {
  status: 'unavailable', reason: 'fixture_unavailable', ...Object.fromEntries(fields.map((field) => [field, null])),
}]));

function hour(hourStart, firstBlock, lastBlock, parentHash, firstHash, lastHash) {
  const blockCount = lastBlock - firstBlock + 1;
  return {
    definitionVersion: COMPACT_DEFINITION_VERSION,
    sourceVersions: {},
    chainId: ARC_CHAIN_ID,
    range: { kind: 'hour', hourStart, hourEnd: hourStart + HOUR_SECONDS, startUtc: new Date(hourStart * 1000).toISOString(),
      endUtc: new Date((hourStart + HOUR_SECONDS) * 1000).toISOString(), firstBlock, lastBlock, parentHash, firstHash, lastHash,
      firstTimestamp: hourStart, lastTimestamp: hourStart + HOUR_SECONDS - 1 },
    network: { status: 'available', blockCount, transactionCount: 0, uniqueActiveAddresses: 0 },
    families: familyUnavailable(),
    complete: false,
    activeAddresses: [],
    registry: { uniswapV3: null },
  };
}

test('history starts at the first complete UTC hour after Arc public mainnet went live', () => {
  assert.equal(ARC_PUBLIC_MAINNET_LIVE_AT, Date.parse('2026-09-16T10:30:00Z') / 1000);
  assert.equal(ARC_PUBLIC_MAINNET_FIRST_COMPLETE_HOUR, Date.parse('2026-09-16T11:00:00Z') / 1000);
  assert.deepEqual(discoverHistoryStart(), {
    publicMainnetLiveAt: Date.parse('2026-09-16T10:30:00Z') / 1000,
    firstCompleteHour: Date.parse('2026-09-16T11:00:00Z') / 1000,
  });
});

test('CLI rejects execute-only limit flags without --execute', () => {
  const env = { COMPACT_SQLITE_PATH: '/tmp/x.sqlite' };
  assert.throws(() => historyBackfillConfig({ argv: ['--all'], env }), /execute_required/);
  assert.throws(() => historyBackfillConfig({ argv: ['--execute', '--all', '--max-hours=2'], env }), /choose_all/);
});

test('historical prepend is adjacent, hash-linked, and leaves checkpoint unchanged', () => {
  const db = new DatabaseSync(':memory:');
  const store = createCompactStore(db);
  const h1 = BASE + 2 * HOUR_SECONDS;
  const later = hour(h1, 110, 119, hash(109), hash(110), hash(119));
  assert.equal(store.commitHour(later).outcome, 'inserted');
  const checkpoint = store.checkpoint();

  const previous = hour(h1 - HOUR_SECONDS, 100, 109, hash(99), hash(100), hash(109));
  assert.equal(store.commitHistoricalHour(previous).outcome, 'inserted');
  assert.deepEqual(store.checkpoint(), checkpoint);
  assert.equal(store.earliestHour().hourStart, h1 - HOUR_SECONDS);

  const duplicate = store.commitHistoricalHour(previous);
  assert.equal(duplicate.outcome, 'unchanged');
  assert.deepEqual(store.checkpoint(), checkpoint);
  db.close();
});

test('historical prepend rejects gaps before writing', () => {
  const db = new DatabaseSync(':memory:');
  const store = createCompactStore(db);
  const h1 = BASE + 3 * HOUR_SECONDS;
  store.commitHour(hour(h1, 120, 129, hash(119), hash(120), hash(129)));
  assert.throws(() => store.commitHistoricalHour(
    hour(h1 - 2 * HOUR_SECONDS, 100, 109, hash(99), hash(100), hash(109))
  ), (error) => error.code === 'history_not_adjacent');
  assert.equal(store.hourCount(), 1);
  db.close();
});

test('historical prepend rejects a broken hash link and rolls back', () => {
  const db = new DatabaseSync(':memory:');
  const store = createCompactStore(db);
  const h1 = BASE + 2 * HOUR_SECONDS;
  store.commitHour(hour(h1, 110, 119, hash(109), hash(110), hash(119)));
  assert.throws(() => store.commitHistoricalHour(
    hour(h1 - HOUR_SECONDS, 100, 109, hash(99), hash(100), hash(999))
  ), (error) => error.code === 'history_discontinuity');
  assert.equal(store.hourCount(), 1);
  db.close();
});

console.log(`VERIFIER PASS compact-history-backfill ${passed} tests`);
