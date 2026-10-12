// Archery CL hourly activity (server/compact/archery-cl.js): offline acceptance on the deterministic synthetic chain and
// disposable SQLite files only. No network, no production data. Proves the verified source constants, separation from
// Uniswap, unchanged token discovery, no repair or backfill trigger, the availableFamilies guard and the window rules.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ARC_VERIFIED_ASSETS } from '../api/_lib/arc-intelligence/assets.js';
import { ARCHERY_CL, ARCHERY_CL_DEFINITION_VERSION } from '../api/_lib/arc-intelligence/archery.js';
import { UNISWAP_EVENT_TOPICS } from '../api/_lib/arc-intelligence/uniswap.js';
import { ARCHERY_CL_KEEP_HOURS, ARCHERY_CL_META_PREFIX, archeryMetaKey, createArcheryClAccumulator } from '../server/compact/archery-cl.js';
import { FAMILY_FIELDS } from '../server/compact/families.js';
import { processHour as processHourEngine } from '../server/compact/hour.js';
import { HISTORY_META_PREFIXES } from '../server/compact/history-expiry.js';
import { intelligenceRegistry, registryDigest } from '../server/compact/intelligence-registry.js';
import { createSyntheticChain, SYNTHETIC_CONTRACTS } from '../server/compact/offline.js';
import { createProvider } from '../server/compact/provider.js';
import { createCompactReadModel } from '../server/compact/read-model.js';
import { bootstrapV3Registry, registrySnapshot } from '../server/compact/registry.js';
import { createCompactStore } from '../server/compact/store.js';

const { DatabaseSync } = await import('node:sqlite');
const tests = [];
const FILTER = process.env.ARCHERY_TEST_FILTER ?? '';
async function test(name, run) {
  if (FILTER && !name.includes(FILTER)) return;
  await run();
  tests.push(name);
  console.log(`PASS ${name}`);
}
const provider = (chain) => createProvider({ fetchImpl: chain.fetchImpl, minIntervalMs: 0, cooldownMs: 0, sleep: async () => {} });
const sha = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

// Three synthetic hours; the first two foreign V3-signature emitters play the verified Archery pools, the third an
// unrelated (Aero-like) pool that must never be counted. The official Uniswap pool lives in the same log stream.
const HOUR = 1_790_006_400;
const ORIGIN = { originNumber: 23_000_000, originTimestamp: HOUR - 1000 };
const SAFE_HEAD = ORIGIN.originNumber + 28_000;
const HOURS = [HOUR, HOUR + 3600, HOUR + 7200];
const foreign = (index) => `0xc0de02${(2 + index).toString(16).padStart(34, '0')}`;
assert.equal(foreign(0), SYNTHETIC_CONTRACTS.foreignV3Emitter);
const FACTORY = `0x${'ae'.repeat(20)}`;
const TOKENS = [SYNTHETIC_CONTRACTS.tokenA, SYNTHETIC_CONTRACTS.tokenB, SYNTHETIC_CONTRACTS.eurc];
const pool = (index) => ({ address: foreign(index), market: null, tickSpacing: 10 * (index + 1), token0: TOKENS[index % 3], token1: TOKENS[(index + 1) % 3] });
const REGISTRY = Object.freeze({ ...ARCHERY_CL, factory: FACTORY, pools: [pool(0), pool(1)] });
const word = (value) => BigInt.asUintN(256, BigInt(value)).toString(16).padStart(64, '0');
const addressWord = (address) => `0x${address.slice(2).padStart(64, '0')}`;

// The factory and its pools as eth_call answers. listed: allPoolsLength; overrides reshape single answers.
function factoryCalls({ listed = 2, first = foreign(0), factoryOf = () => FACTORY, getPool = (address) => address, failList = false } = {}) {
  return ({ to, data }) => {
    const target = to.toLowerCase(), selector = data.slice(0, 10);
    if (target === FACTORY) {
      if (selector === '0xefde4e64') return failList ? { error: { code: -32000, message: 'header not found' } } : { result: `0x${word(listed)}` };
      if (selector === '0x41d1de97') {
        const index = Number(BigInt(`0x${data.slice(10)}`));
        return { result: addressWord(index === 0 ? first : foreign(index)) };
      }
      if (selector === '0x28af8d0b') {
        const index = [0, 1, 2].find((i) => data.slice(10) === `${pool(i).token0.slice(2).padStart(64, '0')}${pool(i).token1.slice(2).padStart(64, '0')}${word(pool(i).tickSpacing)}`);
        return { result: addressWord(index === undefined ? `0x${'0'.repeat(40)}` : getPool(foreign(index))) };
      }
    }
    const index = [0, 1, 2].find((i) => foreign(i) === target);
    if (index === undefined) return undefined;
    if (selector === '0xc45a0155') return { result: addressWord(factoryOf(target)) };
    if (selector === '0x0dfe1681') return { result: addressWord(pool(index).token0) };
    if (selector === '0xd21220a7') return { result: addressWord(pool(index).token1) };
    if (selector === '0xd0c93a7c') return { result: `0x${word(pool(index).tickSpacing)}` };
    return undefined;
  };
}
const chainOf = (calls = factoryCalls(), extra = {}) => createSyntheticChain({ ...ORIGIN, head: ORIGIN.originNumber + 30_000, poolCreatedAt: 23_002_500,
  foreignV3Emitters: 3, foreignV3Every: 40,
  faults: { call: calls, code: (target, present) => present || target === FACTORY || [0, 1, 2].some((i) => foreign(i) === target), ...extra } });
const V3 = registrySnapshot(await bootstrapV3Registry(provider(chainOf()), { fromBlock: ORIGIN.originNumber, toBlock: ORIGIN.originNumber + 30_000 }));
const generic = intelligenceRegistry({ launches: [] });
const run = (chain, hourStart, options = {}) => processHourEngine({ provider: provider(chain), hourStart, safeHead: SAFE_HEAD, v3Registry: V3,
  intelligenceRegistry: generic, archeryRegistry: REGISTRY, ...options });
// Independent expected counts: every log of the hour's blocks from the given pools.
function expected(chain, range, pools) {
  const out = { swaps: 0, mints: 0, burns: 0, byPool: {} };
  for (let number = range.firstBlock; number <= range.lastBlock; number++) for (const log of chain.logsOf(number)) {
    if (!pools.includes(log.address)) continue;
    const kind = { [UNISWAP_EVENT_TOPICS.v3Swap]: 'swaps', [UNISWAP_EVENT_TOPICS.v3Mint]: 'mints', [UNISWAP_EVENT_TOPICS.v3Burn]: 'burns' }[log.topics[0]];
    if (!kind) continue;
    out[kind] += 1;
    out.byPool[log.address] = (out.byPool[log.address] ?? 0) + (kind === 'swaps' ? 1 : 0);
  }
  return out;
}
const withoutProtocols = ({ protocols, ...rest }) => rest;

await test('source: the integration uses exactly the verified official Archery CL factory, deployment and four pools', async () => {
  assert.equal(ARCHERY_CL.chainId, 5042);
  assert.equal(ARCHERY_CL.source, 'https://archery.wtf/docs/security');
  assert.equal(ARCHERY_CL.factory, '0xc481038c013fe96f38ce7a2dc417b2b1b78b16a4');
  assert.equal(ARCHERY_CL.factoryCreationBlock, 22447744);
  assert.equal(ARCHERY_CL.factoryCreationTx, '0xdc8c3afb16ba528119a53fe7149cf988754e7ae6762f88dc213ee7d5071a9bbb');
  assert.equal(ARCHERY_CL.deployer, '0x5a378ff5e4450f8841ded68fcc110cd433f52e97');
  const symbol = Object.fromEntries(ARC_VERIFIED_ASSETS.map((asset) => [asset.address.toLowerCase(), asset.symbol]));
  assert.deepEqual(ARCHERY_CL.pools.map((p) => [p.address, `${symbol[p.token0]} / ${symbol[p.token1]}`, p.market, p.tickSpacing]), [
    ['0x072ca55acb3cc90f96b7f7807cf8de2250af4dc7', 'WETH / USDC', 'WETH / USDC', 50],
    ['0x948523143f6610a64ee8f17667818fe1d8c9f562', 'cirBTC / USDC', 'cirBTC / USDC', 50],
    ['0x3572897908f2d8d171bf701758f6ddafec5e3637', 'WETH / cirBTC', 'WETH / cirBTC', 10],
    ['0xb88c08e31c1bc7d41f2cfc4fbafad5b3b0a5eae9', 'USDC / EURC', 'USDC / EURC', 1]]);
  assert.ok(Object.isFrozen(ARCHERY_CL) && Object.isFrozen(ARCHERY_CL.pools) && ARCHERY_CL.pools.every(Object.isFrozen));
  assert.ok(!Object.keys(FAMILY_FIELDS).some((name) => /archery/i.test(name)), 'never a core family');
});

const chain = chainOf();
const [base, withArchery] = [await run(chain, HOUR), await run(chain, HOUR, { protocolActivity: true })];

await test('separation: Archery counts only its official pools; families, Uniswap, projections and discovery are byte-identical', async () => {
  assert.equal(base.protocols, undefined, 'off by default: the result is exactly what it was');
  assert.deepEqual(withoutProtocols(withArchery), base);
  assert.equal(sha(withArchery.intelligence), sha(base.intelligence));
  assert.equal(sha(withArchery.families.uniswapV3), sha(base.families.uniswapV3));
  const archery = withArchery.protocols.archeryCl;
  const want = expected(chain, withArchery.range, [foreign(0), foreign(1)]);
  assert.equal(archery.status, 'available');
  assert.equal(archery.definitionVersion, ARCHERY_CL_DEFINITION_VERSION);
  assert.ok(want.swaps > 0, 'the fixture hour has Archery swaps');
  assert.deepEqual([archery.metrics.swapCount, archery.metrics.mintCount, archery.metrics.burnCount], [want.swaps, want.mints, want.burns]);
  assert.deepEqual(Object.fromEntries(archery.metrics.pools.map((p) => [p.pool, p.swaps])), want.byPool);
  assert.equal(archery.metrics.registeredPoolCount, 2);
  const unrelated = expected(chain, withArchery.range, [foreign(2)]), uniswap = expected(chain, withArchery.range, [SYNTHETIC_CONTRACTS.validV3Pool]);
  assert.ok(unrelated.swaps > 0 && uniswap.swaps > 0, 'the same stream carries an unrelated pool and the Uniswap pool');
  assert.ok(!archery.metrics.pools.some((p) => p.pool === foreign(2) || p.pool === SYNTHETIC_CONTRACTS.validV3Pool));
  assert.equal(base.families.uniswapV3.swapCount, uniswap.swaps, 'Uniswap swaps never include Archery');
});

await test('cost: no extra log request; one bounded batch for the factory list at the hour end', async () => {
  const counted = async (options) => {
    const p = provider(chain);
    await processHourEngine({ provider: p, hourStart: HOUR, safeHead: SAFE_HEAD, v3Registry: V3, intelligenceRegistry: generic, archeryRegistry: REGISTRY, ...options });
    return p.stats;
  };
  const off = await counted({}), on = await counted({ protocolActivity: true });
  assert.equal(on.calls.eth_getLogs, off.calls.eth_getLogs, 'the v3Pools logs are reused');
  assert.equal(on.requests - off.requests, 1);
  assert.equal(on.calls.eth_call - (off.calls.eth_call ?? 0), 1 + REGISTRY.pools.length);
  assert.equal(on.calls.eth_getCode - off.calls.eth_getCode, 1);
});

await test('discovery of later pools: a pool the factory lists is counted only after its factory() and getPool agree', async () => {
  const listed = chainOf(factoryCalls({ listed: 3 }));
  const result = await run(listed, HOUR, { protocolActivity: true });
  const want = expected(listed, result.range, [foreign(0), foreign(1), foreign(2)]);
  assert.equal(result.protocols.archeryCl.status, 'available');
  assert.equal(result.protocols.archeryCl.metrics.registeredPoolCount, 3);
  assert.equal(result.protocols.archeryCl.metrics.swapCount, want.swaps);
  assert.deepEqual(withoutProtocols(result), base);
  for (const [name, calls] of [['foreign factory()', factoryCalls({ listed: 3, factoryOf: (address) => (address === foreign(2) ? `0x${'bb'.repeat(20)}` : FACTORY) })],
    ['getPool disagrees', factoryCalls({ listed: 3, getPool: (address) => (address === foreign(2) ? foreign(1) : address) })]]) {
    const bad = await run(chainOf(calls), HOUR, { protocolActivity: true });
    assert.deepEqual(bad.protocols.archeryCl, { status: 'unavailable', reason: 'new_pool_unverified', definitionVersion: ARCHERY_CL_DEFINITION_VERSION, metrics: null }, name);
    assert.deepEqual(withoutProtocols(bad), base, name);
  }
});

await test('fail closed: list mismatch, RPC failure, missing V3 stream and malformed pool events are unavailable, never zero', async () => {
  const cases = [
    ['factory_pool_list_mismatch', chainOf(factoryCalls({ first: foreign(2) })), {}],
    ['factory_rpc_unavailable', chainOf(factoryCalls({ failList: true })), {}],
    ['v3_log_stream_unavailable', chain, { v3Registry: null }],
    ['malformed_pool_event', chainOf(factoryCalls(), { logs: (filter, out) => (filter.address ? out
      : out.map((log) => (log.address === foreign(0) && log.topics[0] === UNISWAP_EVENT_TOPICS.v3Swap ? { ...log, data: `0x${'00'.repeat(32)}` } : log))) }), {}],
  ];
  for (const [reason, source, options] of cases) {
    const result = await run(source, HOUR, { protocolActivity: true, ...options });
    assert.deepEqual(result.protocols.archeryCl, { status: 'unavailable', reason, definitionVersion: ARCHERY_CL_DEFINITION_VERSION, metrics: null }, reason);
    assert.equal(result.range.hourStart, HOUR, `${reason}: the hour itself still completes`);
    if (!('v3Registry' in options)) assert.deepEqual(withoutProtocols(result), base, `${reason}: everything else is unchanged`);
  }
  // Neither add() (inside the uniswapV3 stream loop) nor finish() ever throws, whatever happens: the reason is Archery's own.
  const p = provider(chain);
  const accumulator = createArcheryClAccumulator({ registry: REGISTRY });
  accumulator.add([{ address: foreign(0), topics: [], data: '0x' }, null]);
  assert.equal((await accumulator.finish({ provider: p, blockTag: '0x1', delivered: true })).reason, 'internal_error');
  const broken = { batch: async () => { throw new TypeError('unexpected'); } };
  assert.equal((await createArcheryClAccumulator({ registry: REGISTRY }).finish({ provider: broken, blockTag: '0x1', delivered: true })).reason, 'internal_error');
});

// Disposable SQLite files: stores written by the hour pipeline and read back through the read-only read model.
const directory = await mkdtemp(join(tmpdir(), 'machina-archery-'));
const opened = [];
function openStore(name) {
  const path = join(directory, `${name}.sqlite`);
  const db = new DatabaseSync(path);
  opened.push(db);
  return { path, db, store: createCompactStore(db) };
}
const readModel = (path) => createCompactReadModel({ path, DatabaseSync, now: () => (HOURS[2] + 3600 + 600) * 1000 });
const metaRows = (db) => db.prepare('SELECT key, value FROM compact_meta WHERE key >= ? AND key < ? ORDER BY key')
  .all(ARCHERY_CL_META_PREFIX, `${ARCHERY_CL_META_PREFIX.slice(0, -1)};`);
const table = (db, name) => db.prepare(`SELECT * FROM ${name} ORDER BY 1, 2`).all();
const hours = { off: [], on: [] };
for (const hourStart of HOURS) {
  hours.off.push(await run(chain, hourStart));
  hours.on.push(await run(chain, hourStart, { protocolActivity: true }));
}

try {
  await test('store: one record per newly committed live hour, in compact_meta only, kept 35 days; replay, repair and prepend never write one', async () => {
    const { db, store } = openStore('live');
    for (const result of hours.on) assert.equal(store.commitHour(result).outcome, 'inserted');
    const rows = metaRows(db);
    assert.deepEqual(rows.map((row) => row.key), HOURS.map(archeryMetaKey));
    rows.forEach((row, index) => {
      const record = JSON.parse(row.value);
      assert.equal(record.status, 'available');
      assert.deepEqual(record.metrics, hours.on[index].protocols.archeryCl.metrics);
      assert.equal(record.firstBlock, hours.on[index].range.firstBlock);
    });
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM compact_family_hours').get().n, HOURS.length * Object.keys(FAMILY_FIELDS).length);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM compact_family_hours WHERE family NOT IN (" + Object.keys(FAMILY_FIELDS).map((f) => `'${f}'`).join(',') + ')').get().n, 0);
    // The same hour again (a replay or a repair) is the existing-hour path: the record is never written or replaced.
    const changed = { ...hours.on[2], protocols: { archeryCl: { ...hours.on[2].protocols.archeryCl, metrics: { ...hours.on[2].protocols.archeryCl.metrics, swapCount: 999 } } } };
    assert.equal(store.commitHour(changed).outcome, 'unchanged');
    assert.deepEqual(metaRows(db), rows);
    // The namespace is outside every compact_meta prefix history expiry scans.
    assert.ok(HISTORY_META_PREFIXES.every((prefix) => !ARCHERY_CL_META_PREFIX.startsWith(prefix) && !prefix.startsWith('protocol_hour')));
    // Historical prepend never writes a record either.
    const prepend = openStore('prepend');
    prepend.store.commitHour(hours.on[1]);
    assert.equal(prepend.store.commitHistoricalHour(hours.on[0]).outcome, 'inserted');
    assert.deepEqual(metaRows(prepend.db).map((row) => row.key), [archeryMetaKey(HOURS[1])]);
    // An invalid result is stored as unavailable and never blocks the hour.
    const invalid = openStore('invalid');
    const bad = { ...hours.on[0], protocols: { archeryCl: { status: 'available', reason: null, metrics: { swapCount: -1 } } } };
    assert.equal(invalid.store.commitHour(bad).outcome, 'inserted');
    assert.equal(JSON.parse(metaRows(invalid.db)[0].value).reason, 'result_invalid');
    // Retention: each new record removes only this namespace's records older than ARCHERY_CL_KEEP_HOURS.
    const kept = openStore('retention');
    const insert = kept.db.prepare('INSERT INTO compact_meta (key, value) VALUES (?, ?)');
    const oldest = HOURS[0] - (ARCHERY_CL_KEEP_HOURS - 1) * 3600;
    const sentinels = ['protocol_hour:archery_ck:0000000001', 'protocol_hour:archery_cl', 'protocol_hour:archery_cl;', 'protocol_hour:other:0000000001'];
    for (const key of [archeryMetaKey(oldest - 3600), archeryMetaKey(oldest - 7200), archeryMetaKey(oldest), ...sentinels]) insert.run(key, '{}');
    kept.store.commitHour(hours.on[0]);
    assert.deepEqual(metaRows(kept.db).map((row) => row.key), [archeryMetaKey(oldest), archeryMetaKey(HOURS[0])]);
    for (const key of sentinels) assert.ok(kept.db.prepare('SELECT 1 FROM compact_meta WHERE key = ?').get(key), key);
    // A runner without protocol activity writes nothing.
    const off = openStore('off');
    for (const result of hours.off) off.store.commitHour(result);
    assert.deepEqual(metaRows(off.db), []);
  });

  await test('regression: Uniswap families, token discovery tables and registry digest are identical with and without Archery', async () => {
    const on = openStore('twin-on'), off = openStore('twin-off');
    for (const result of hours.on) on.store.commitHour(result);
    for (const result of hours.off) off.store.commitHour(result);
    // Every table, byte for byte; compact_meta too, once the Archery records are set aside.
    const names = on.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name <> 'compact_meta' ORDER BY name").all().map((row) => row.name);
    assert.ok(names.includes('compact_family_hours') && names.includes('compact_token_discoveries') && names.length > 20);
    for (const name of names) assert.equal(sha(table(on.db, name)), sha(table(off.db, name)), name);
    const meta = (db) => db.prepare('SELECT key, value FROM compact_meta WHERE key NOT LIKE ? ORDER BY key').all(`${ARCHERY_CL_META_PREFIX}%`);
    assert.ok(meta(off.db).length > 0);
    assert.equal(sha(meta(on.db)), sha(meta(off.db)), 'compact_meta apart from the Archery records');
    assert.deepEqual(metaRows(on.db).map((row) => row.key), HOURS.map(archeryMetaKey), 'the only new rows are the Archery records');
    assert.equal(registryDigest(), 'eb9b8a0da24f2fa65e1202cd88aeb5204dcd54edf63ff9d1231fdcd06044264a', 'production discovery registry digest unchanged');
    const summaryOn = readModel(on.path).summary('24h'), summaryOff = readModel(off.path).summary('24h');
    assert.deepEqual(summaryOn.dex.uniswapV3, summaryOff.dex.uniswapV3);
    assert.deepEqual(summaryOn.dex.uniswapV4, summaryOff.dex.uniswapV4);
    assert.deepEqual({ ...summaryOn, dex: { ...summaryOn.dex, archeryCl: null }, freshness: null }, { ...summaryOff, dex: { ...summaryOff.dex, archeryCl: null }, freshness: null });
  });

  await test('repair: missing Archery records never start a repair; family repair plans and candidates are unchanged', async () => {
    const on = openStore('repair-on'), off = openStore('repair-off');
    on.store.commitHour(hours.off[0]); // tracking starts later: the first hour has no Archery record at all
    for (const result of hours.on.slice(1)) on.store.commitHour(result);
    for (const result of hours.off) off.store.commitHour(result);
    // The same real repair need in both: an unavailable gateway hour and an hour without its across row.
    for (const db of [on.db, off.db]) {
      db.prepare("UPDATE compact_family_hours SET status = 'unavailable', reason = 'rpc_error', metrics_json = NULL, metrics_sha256 = NULL WHERE hour_start = ? AND family = 'gateway'").run(BigInt(HOURS[1]));
      db.prepare("DELETE FROM compact_family_hours WHERE hour_start = ? AND family = 'across'").run(BigInt(HOURS[2]));
    }
    const range = { fromHour: HOURS[0] - 23 * 3600, toHour: HOURS[2] };
    const modelOn = readModel(on.path), modelOff = readModel(off.path);
    const plans = modelOn.familyRepairPlans(range);
    assert.deepEqual(plans, modelOff.familyRepairPlans(range));
    assert.deepEqual(plans.plans.map((plan) => [plan.hourStart, plan.families]), [[HOURS[2], ['across']], [HOURS[1], ['gateway']]]);
    assert.deepEqual(modelOn.repairCandidates(range), modelOff.repairCandidates(range));
    assert.deepEqual([...modelOn.repairCandidates(range)].sort(), [HOURS[1], HOURS[2]]);
    assert.ok(!JSON.stringify(modelOn.familyRepairPlans(range)).includes('archery'));
  });

  await test('availableFamilies guard: an extra row can never hide a missing core family from repair', async () => {
    const { db, path, store } = openStore('guard');
    for (const result of hours.off) store.commitHour(result);
    const hour = HOURS[1];
    db.prepare("UPDATE compact_family_hours SET status = 'unavailable', reason = 'rpc_error', metrics_json = NULL, metrics_sha256 = NULL WHERE hour_start = ? AND family = 'gateway'").run(BigInt(hour));
    db.prepare("INSERT INTO compact_family_hours VALUES (?, 'archeryCl', 'available', NULL, '{}', 'x')").run(BigInt(hour));
    const old = db.prepare(`SELECT (SELECT COUNT(*) FROM compact_family_hours f WHERE f.hour_start = h.hour_start AND f.status = 'available') AS available
      FROM compact_hours h WHERE h.hour_start = ?`).get(BigInt(hour)).available;
    assert.equal(old, Object.keys(FAMILY_FIELDS).length, 'the previous query would have counted the hour complete');
    const range = { fromHour: HOURS[0], toHour: HOURS[2] };
    assert.ok(readModel(path).repairCandidates(range).includes(hour), 'the hour still needs its gateway repair');
    assert.deepEqual(readModel(path).familyRepairPlans(range).plans.find((plan) => plan.hourStart === hour).families, ['gateway']);
  });

  await test('windows: counts only tracked hours, states hours before tracking and unavailable hours, never a zero', async () => {
    const pending = openStore('pending');
    for (const result of hours.off) pending.store.commitHour(result);
    const none = readModel(pending.path).summary('24h').dex.archeryCl;
    assert.equal(none.status, 'source_pending'); assert.equal(none.metrics, null); assert.equal(none.trackedFrom, null);
    assert.deepEqual(none.coverage, { expectedHours: 24, availableHours: 0, unavailableHours: 0, notTrackedHours: 24 });

    const later = openStore('later');
    later.store.commitHour(hours.off[0]);
    for (const result of hours.on.slice(1)) later.store.commitHour(result);
    const model = readModel(later.path);
    const day = model.summary('24h').dex.archeryCl;
    const want = [1, 2].map((i) => hours.on[i].protocols.archeryCl.metrics.swapCount).reduce((a, b) => a + b, 0);
    assert.equal(day.status, 'partial'); assert.equal(day.trackedFrom, new Date(HOURS[1] * 1000).toISOString());
    assert.deepEqual(day.coverage, { expectedHours: 24, availableHours: 2, unavailableHours: 0, notTrackedHours: 22 });
    assert.equal(day.metrics.swapCount, want, 'the untracked first hour is not counted, as a zero or otherwise');
    assert.ok(hours.on[0].protocols.archeryCl.metrics.swapCount > 0, 'the first hour did have Archery swaps on chain');
    assert.ok(day.reasons.includes('not_tracked_before_start'));
    for (const [key, expectedHours] of [['7d', 168], ['30d', null]]) {
      const window = model.summary(key).dex.archeryCl;
      assert.equal(window.status, 'partial', key); assert.equal(window.metrics.swapCount, want, key);
      if (expectedHours) assert.equal(window.coverage.expectedHours, expectedHours, key);
      assert.equal(window.coverage.availableHours + window.coverage.unavailableHours + window.coverage.notTrackedHours, window.coverage.expectedHours, key);
    }
    // A tracked hour that failed stays a listed gap.
    const gap = openStore('gap');
    gap.store.commitHour(hours.on[0]);
    gap.store.commitHour({ ...hours.on[1], protocols: { archeryCl: { status: 'unavailable', reason: 'factory_rpc_unavailable', metrics: null } } });
    gap.store.commitHour(hours.on[2]);
    const gapped = readModel(gap.path).summary('24h').dex.archeryCl;
    assert.deepEqual(gapped.unavailableHours, [new Date(HOURS[1] * 1000).toISOString()]);
    assert.ok(gapped.reasons.includes('factory_rpc_unavailable'));
    assert.equal(gapped.metrics.swapCount, hours.on[0].protocols.archeryCl.metrics.swapCount + hours.on[2].protocols.archeryCl.metrics.swapCount);
    // Damaged records never break the summary: each is a stated gap with its reason.
    const damaged = openStore('damaged');
    for (const result of hours.on) damaged.store.commitHour(result);
    const put = damaged.db.prepare('UPDATE compact_meta SET value = ? WHERE key = ?');
    const stored = JSON.parse(metaRows(damaged.db)[2].value);
    put.run('{not json', archeryMetaKey(HOURS[0]));
    put.run(JSON.stringify({ ...stored, definitionVersion: 'archery-cl-hour-v0' }), archeryMetaKey(HOURS[1]));
    put.run(JSON.stringify({ ...stored, metrics: { ...stored.metrics, pools: null } }), archeryMetaKey(HOURS[2]));
    const broken = readModel(damaged.path).summary('24h').dex.archeryCl;
    assert.equal(broken.status, 'unavailable'); assert.equal(broken.metrics, null);
    assert.deepEqual(broken.reasons, ['definition_unsupported', 'not_tracked_before_start', 'record_malformed']);
    assert.deepEqual(broken.coverage, { expectedHours: 24, availableHours: 0, unavailableHours: 3, notTrackedHours: 21 });
  });

  await test('schema: the SQLite schema is exactly the previous one (no table, index, trigger or migration added)', async () => {
    const { db } = openStore('schema');
    const rows = db.prepare('SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name').all();
    assert.equal(sha(rows), '0858489685e6d9b23cb58c889318530e3a97687194f229f9f2eec9dd72f02736', 'schema digest of 8bae796');
    assert.ok(!rows.some((row) => /archery/i.test(`${row.name} ${row.sql}`)));
  });
} finally {
  for (const db of opened) { try { db.close(); } catch {} }
  await rm(directory, { recursive: true, force: true });
}
console.log(`VERIFIER PASS arc-intelligence-archery ${tests.length} tests (offline, disposable SQLite)`);
