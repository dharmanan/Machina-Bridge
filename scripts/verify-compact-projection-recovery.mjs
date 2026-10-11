// Disposable databases and hand-encoded chain evidence only. No production/RPC access.
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getHeapStatistics } from 'node:v8';
import { createCompactStore } from '../server/compact/store.js';
import { createProjectionSink, v4PoolIdOf, canonicalJson, PROJECTION_VERSIONS } from '../server/compact/projections.js';
import { FAMILY_FIELDS } from '../server/compact/families.js';
import { COMPACT_DEFINITION_VERSION } from '../server/compact/sources.js';
import { normalizeLog } from '../api/_lib/arc-intelligence/normalize.js';
import { decodeV3Swap, decodeV4Swap, UNISWAP_EVENT_TOPICS as T, UNISWAP_REGISTRY } from '../api/_lib/arc-intelligence/uniswap.js';
import { USDC_ERC20_ADDRESS as USDC } from '../api/_lib/arc-intelligence/usdc.js';
import { recoverProjectionInputs, projectionRecoveryConfig } from '../server/compact/projection-recovery.js';
import { boundedRecoveryProvider } from './recover-compact-discovery.mjs';
import { repairProjectionHour } from './repair-compact-projection-hour.mjs';
import { validateScopedPoolWitness, readScopedPoolWitness } from '../server/compact/registry.js';
import { v4StateSlot } from '../server/compact/tvl.js';
import { selectorOf } from '../server/compact/abi.js';
import { sha256Of } from '../server/compact/projections.js';
import { acquireWriterLock } from '../server/compact/writer-lock.js';
import { archiveConfig, createEvidenceArchive } from '../server/compact/evidence-archive.js';

globalThis.fetch = () => { throw new Error('network_forbidden'); };
const MiB = 1024 * 1024, HOUR = 1790006400, FIRST = 100, LAST = 195;
const hex = n => `0x${n.toString(16)}`, word = n => BigInt.asUintN(256, BigInt(n)).toString(16).padStart(64, '0');
const address = n => '0x' + word(n).slice(-40), hash = n => '0x' + word(n), topic = a => '0x' + word(BigInt(a));
const POOL = address(1000), FOREIGN = address(2000), UNKNOWN = address(3000), ZERO = address(0), PM = UNISWAP_REGISTRY.v4PoolManager.address,
  FACTORY = UNISWAP_REGISTRY.v3Factory.address, KEY = { currency0: USDC, currency1: UNKNOWN, fee: 500, tickSpacing: 60, hooks: ZERO },
  V4 = v4PoolIdOf(KEY), Q96 = 1n << 96n;
const CONFIG = projectionRecoveryConfig({ COMPACT_DEX_INPUT_RECOVERY_ENABLED: 'true', COMPACT_ARCHIVE_MAX_TOTAL_MIB: '512' });
const capacity = () => ({ freeBytes: 2_859_802_624, databaseBytes: 817_713_152 + 109_369_552 });
const dir = mkdtempSync(join(tmpdir(), 'compact-projection-integration-'));
let passed = 0, serial = 0;
async function test(name, run) { if (process.env.FILTER && !name.includes(process.env.FILTER)) return; await run(); passed++; console.log('PASS ' + name); }
async function rejects(run, code) { await assert.rejects(run, e => e.code === code, code); }
function rawLog(n, index, emitter, topics, data) {
  return { address: emitter, topics, data, blockNumber: hex(n), blockHash: hash(n), transactionHash: hash(n * 10),
    transactionIndex: '0x0', logIndex: hex(index), removed: false };
}
const V3_BIRTH = rawLog(80, 0, FACTORY, [T.v3PoolCreated, topic(USDC), topic(UNKNOWN), '0x' + word(500)],
  '0x' + word(60) + word(BigInt(POOL)));
const V4_BIRTH = rawLog(90, 0, PM, [T.v4Initialize, V4, topic(USDC), topic(UNKNOWN)],
  '0x' + word(500) + word(60) + word(0) + word(Q96) + word(0));
function logs() {
  const out = [];
  for (const [i, n] of [100, 100, 132, 164, 195].entries()) {
    out.push(rawLog(n, i === 1 ? 2 : 0, POOL, [T.v3Swap, topic(ZERO), topic(ZERO)],
      '0x' + word(100 + i) + word(-100 - i) + word(Q96 + BigInt(i)) + word(10n ** 18n) + word(0)));
    out.push(rawLog(n, i === 1 ? 3 : 1, PM, [T.v4Swap, V4, topic(ZERO)],
      '0x' + word(-100 - i) + word(100 + i) + word(Q96 + BigInt(i)) + word(10n ** 18n) + word(0) + word(500)));
  }
  out.push(rawLog(100, 4, FOREIGN, [T.v3Swap, topic(ZERO), topic(ZERO)],
    '0x' + word(999) + word(-999) + word(Q96) + word(1) + word(0)));
  return out;
}
function denseLogs(first, last, padding = 0) {
  const out = [];
  for (let n = first; n <= last; n++) {
    const a = rawLog(n, 0, POOL, [T.v3Swap, topic(ZERO), topic(ZERO)], '0x' + word(100) + word(-100) + word(Q96) + word(10n ** 18n) + word(0));
    const b = rawLog(n, 1, PM, [T.v4Swap, V4, topic(ZERO)], '0x' + word(-100) + word(100) + word(Q96) + word(10n ** 18n) + word(0) + word(500));
    if (padding) { a.providerPadding = 'p'.repeat(padding); b.providerPadding = 'p'.repeat(padding); }
    out.push(a, b);
  }
  return out;
}
function fixture({ existingPools = true, inputs = false, dense = false } = {}) {
  const blockCount = dense ? 7107 : 96, last = FIRST + blockCount - 1, timestamp = dense ? HOUR + 3599 : HOUR + 95;
  const path = join(dir, `${serial++}.sqlite`), db = new DatabaseSync(path), store = createCompactStore(db);
  const v3record = { address: POOL, createdBlock: 80, createdLogIndex: 0, createdTx: hash(800), token0: USDC, token1: UNKNOWN, fee: 500, tickSpacing: 60 };
  const v4record = { poolId: V4, createdBlock: 90, createdLogIndex: 0, createdTx: hash(900), ...KEY };
  store.extendRegistry({ kind: 'uniswap_v3_pool', fromBlock: 0, through: 99, throughHash: hash(99), previousThrough: null, created: existingPools ? [v3record] : [] });
  store.extendV4Registry({ kind: 'uniswap_v4_pool', fromBlock: 0, through: 99, throughHash: hash(99), previousThrough: null, created: existingPools ? [v4record] : [] });
  const families = Object.fromEntries(Object.entries(FAMILY_FIELDS).map(([family, fields]) => [family,
    { status: 'unavailable', reason: 'fixture_not_requested', ...Object.fromEntries(fields.map(field => [field, null])) }]));
  for (const family of ['uniswapV3', 'uniswapV4']) families[family] = {
    ...Object.fromEntries(FAMILY_FIELDS[family].map(field => [field, 0])), status: 'available', swapCount: dense ? blockCount : 5, poolsWithSwaps: 1 };
  const sink = createProjectionSink({ activity: false });
  function* evidence() {
    if (!dense) { yield* logs().filter(raw => raw.address !== FOREIGN); return; }
    for (let n = FIRST; n <= last; n += 32) yield* denseLogs(n, Math.min(last, n + 31));
  }
  for (const raw of evidence()) {
    const log = normalizeLog(raw);
    if (raw.address === POOL) sink.v3('swap', log, decodeV3Swap(log), null);
    else sink.v4('swap', log, decodeV4Swap(log), null);
  }
  const expected = sink.finish({ families, firstBlock: FIRST, lastBlock: last });
  store.commitHour({ definitionVersion: COMPACT_DEFINITION_VERSION, chainId: 5042,
    range: { kind: 'hour', hourStart: HOUR, hourEnd: HOUR + 3600, startUtc: new Date(HOUR * 1000).toISOString(),
      endUtc: new Date((HOUR + 3600) * 1000).toISOString(), firstBlock: FIRST, lastBlock: last, parentHash: hash(99), firstHash: hash(FIRST),
      lastHash: hash(last), firstTimestamp: HOUR, lastTimestamp: timestamp },
    network: { status: 'available', blockCount, transactionCount: blockCount, uniqueSenders: 1, uniqueRecipients: 1, uniqueActiveAddresses: 1,
      gasUsedRaw: String(blockCount * 21000), averageTransactionsPerBlock: 1, transactionsPerSecond: blockCount / 3600, internal: { deploymentAttempts: 0 } },
    families, complete: false, activeAddresses: [address(9999)], registry: { uniswapV3: { through: last, throughHash: hash(last), created: [] } },
    projections: inputs ? expected : undefined });
  return { db, path, store, families, expected, close: () => db.close() };
}
function rpc({ stop, mutate, budget, allow = () => true, dense = false, padding = 0, revertForeign = false, deployment = null } = {}) {
  const chainLast = dense ? FIRST + 7107 - 1 : LAST;
  let maxResponseBytes = 0;
  const calls = [], all = [V3_BIRTH, V4_BIRTH, ...logs()];
  const answer = item => {
    calls.push([item.method, item.params]);
    if (stop?.(item, calls)) throw Object.assign(new Error('offline_disconnect'), { code: 'ECONNRESET' });
    let result;
    if (item.method === 'eth_chainId') result = hex(5042);
    else if (item.method === 'eth_getBlockByNumber') {
      assert.equal(item.params[1], false, 'no full transaction bodies');
      const n = Number(BigInt(item.params[0]));
      result = { number: hex(n), hash: hash(n), parentHash: hash(n - 1), timestamp: hex(n < FIRST ? HOUR - 1 : n > chainLast ? HOUR + 3600
        : dense ? HOUR + Math.floor((n - FIRST) * 3599 / (chainLast - FIRST)) : HOUR + n - FIRST), transactions: [hash(n * 10)] };
    } else if (item.method === 'eth_getLogs') {
      const f = item.params[0], first = Number(BigInt(f.fromBlock)), last = Number(BigInt(f.toBlock));
      const rangeLogs = dense && first >= FIRST ? denseLogs(first, last, padding) : all;
      result = rangeLogs.filter(raw => Number(BigInt(raw.blockNumber)) >= first && Number(BigInt(raw.blockNumber)) <= last
        && (!f.address || [].concat(f.address).includes(raw.address)) && f.topics.every((expected, i) => expected === null || [].concat(expected).includes(raw.topics[i])));
    } else if (item.method === 'eth_getCode') result = Number(BigInt(item.params[1])) >= (item.params[0] === PM ? deployment ?? 0 : 80) ? '0x6000' : '0x';
    else if (item.method === 'eth_call') {
      const [{ to, data }, tag] = item.params, sig = data.slice(0, 10);
      if (revertForeign && sig === selectorOf('factory()') && to === FOREIGN) return { jsonrpc: '2.0', id: item.id, error: { code: 3, message: 'execution reverted' } };
      if (sig === selectorOf('factory()')) result = '0x' + word(BigInt(to === FOREIGN ? ZERO : FACTORY));
      else if (sig === selectorOf('token0()')) result = '0x' + word(BigInt(USDC));
      else if (sig === selectorOf('token1()')) result = '0x' + word(BigInt(UNKNOWN));
      else if (sig === selectorOf('fee()')) result = '0x' + word(500);
      else if (sig === selectorOf('getPool(address,address,uint24)')) result = '0x' + word(BigInt(POOL));
      else if (sig === '0x70a08231') result = '0x' + word(1000000);
      else if (sig === '0xdbd035ff') {
        const count = Number(BigInt('0x' + data.slice(74, 138)));
        const values = Array.from({ length: count }, (_, i) => count <= 2 && i === 0 && Number(BigInt(tag)) >= 90 ? Q96 : 0n);
        result = deployment !== null && Number(BigInt(tag)) < deployment ? '0x' : '0x' + word(32) + word(count) + values.map(word).join('');
      } else throw new Error('unexpected_call');
    } else throw new Error('unexpected_method');
    return { jsonrpc: '2.0', id: item.id, result: mutate ? mutate(item, result) : result };
  };
  const bounded = boundedRecoveryProvider({ minIntervalMs: 0, sleep: async () => {}, ...(budget ? { budget } : {}),
    fetchImpl: async (_url, init) => {
      const body = JSON.parse(init.body), out = Array.isArray(body) ? body.map(answer) : answer(body);
      const text = JSON.stringify(out); maxResponseBytes = Math.max(maxResponseBytes, Buffer.byteLength(text));
      return new Response(text, { status: 200 });
    } });
  const base = bounded.provider.canContinue;
  bounded.provider.canContinue = n => allow(calls) && base(n);
  return { ...bounded, calls, get maxResponseBytes() { return maxResponseBytes; } };
}
const protectedState = db => ['compact_hours', 'compact_family_hours', 'compact_hour_addresses', 'compact_checkpoint',
  'compact_evidence_archive', 'compact_evidence_archive_parts', 'compact_dex_activity']
  .map(table => [table, db.prepare(`SELECT * FROM ${table}`).all()]);
const run = (f, r, extras = {}) => recoverProjectionInputs({ db: f.db, store: f.store, provider: r.provider, hourStart: HOUR, config: CONFIG, capacity, ...extras });
const stored = f => ['uniswap_v3', 'uniswap_v4'].map(protocol => [protocol, f.store.poolHours(HOUR, protocol), f.store.pricePaths(HOUR, protocol)]);

try {
  await test('default OFF; first integration flag and all stored data unchanged', async () => {
    assert.equal(projectionRecoveryConfig({}).enabled, false);
    assert.equal(projectionRecoveryConfig({ COMPACT_DISCOVERY_RECOVERY_ENABLED: 'true' }).enabled, false);
    const f = fixture(), before = protectedState(f.db);
    assert.equal((await recoverProjectionInputs({ db: f.db, store: f.store, hourStart: HOUR, config: projectionRecoveryConfig({}) })).phase, 'disabled');
    assert.deepEqual(protectedState(f.db), before); f.close();
  });
  await test('resumable V3/V4 paths equal uninterrupted reducer, same-block swaps and empty gaps not counted twice', async () => {
    let f = fixture(), r = rpc(); const before = protectedState(f.db);
    assert.equal((await run(f, r, { maxSlices: 2 })).phase, 'partial');
    assert(!f.store.projectionStatus(HOUR).some(row => row.projection === 'uniswap_v3_pools' && row.status === 'available'));
    const seen = r.calls.filter(([method]) => method === 'eth_getLogs').map(([, [filter]]) => canonicalJson(filter));
    r.close(); f.close();
    const db = new DatabaseSync(f.path); f = { ...f, db, store: createCompactStore(db), close: () => db.close() }; r = rpc();
    const result = await run(f, r); assert.equal(result.phase, 'complete', canonicalJson(result));
    for (const protocol of ['uniswap_v3', 'uniswap_v4']) {
      assert.deepEqual(f.store.poolHours(HOUR, protocol), f.expected[protocol + '_pools'].rows);
      assert.deepEqual(f.store.pricePaths(HOUR, protocol), f.expected[protocol + '_price_paths'].rows);
    }
    assert.deepEqual(f.store.swapFees(HOUR), f.expected.uniswap_v4_swap_fees.rows);
    assert(!r.calls.filter(([m]) => m === 'eth_getLogs').some(([, [filter]]) => seen.includes(canonicalJson(filter))));
    assert.deepEqual(protectedState(f.db), before);
    assert.equal(f.db.prepare("SELECT COUNT(*) n FROM compact_meta WHERE key GLOB 'discovery_slice_cursor:*'").get().n, 0);
    const snapshot = stored(f), again = rpc(); assert.equal((await run(f, again)).phase, 'complete');
    assert.equal(again.calls.length, 0); assert.deepEqual(stored(f), snapshot);
    console.log('MEASURE', JSON.stringify({ requests: r.stats.requests, calls: r.stats.calls, responseBytes: r.stats.bytes,
      databaseBytes: statSync(f.path).size, walBytes: statSync(f.path + '-wal').size, retainedProgressBytes: f.db.prepare('SELECT value FROM compact_meta WHERE key=?').get('discovery_slice_usage').value,
      heapLimitBytes: getHeapStatistics().heap_size_limit }));
    again.close(); r.close(); f.close();
  });
  await test('missing V3 factory and V4 Initialize identities recovered by exact event without global coverage claim', async () => {
    const f = fixture({ existingPools: false }), r = rpc(), before = protectedState(f.db);
    assert.equal((await run(f, r)).phase, 'complete');
    assert.equal(f.db.prepare('SELECT COUNT(*) n FROM compact_registry').get().n, 2);
    const witness = f.db.prepare("SELECT value FROM compact_meta WHERE key GLOB 'compact_dex_fact:*'").all().map(row => JSON.parse(row.value).value)
      .filter(value => value?.version === 'compact-official-pool-witness-v1');
    assert.equal(witness.length, 2);
    for (const proof of witness) validateScopedPoolWitness(proof, proof.protocol, proof.record.address ?? proof.record.poolId, FIRST);
    assert.deepEqual(protectedState(f.db), before); assert(!f.store.tokenPrices(HOUR).some(row => row.token === UNKNOWN));
    assert.equal(f.store.poolTvl(HOUR, 'uniswap_v3')[0].amount0Raw, '1000000');
    r.close(); f.close();
  });
  await test('interrupted pool probes restart from persisted successful primitive reads', async () => {
    const f = fixture({ existingPools: false });
    let r = rpc({ stop: item => item.method === 'eth_getCode' });
    await rejects(() => run(f, r), 'transport');
    const successfulCalls = r.calls.filter(([m]) => m === 'eth_call'); r.close();
    r = rpc(); assert.equal((await run(f, r)).phase, 'complete');
    for (const call of successfulCalls) assert(!r.calls.some(value => canonicalJson(value) === canonicalJson(call)), 'successful probe downloaded twice');
    r.close(); f.close();
  });
  await test('atomic range rollback; crash after commit resumes with no repeat accepted log range', async () => {
    const f = fixture(), r = rpc();
    await assert.rejects(() => run(f, r, { beforeCommit: () => { throw new Error('crash_before_commit'); } }), /crash_before_commit/);
    assert.equal(f.db.prepare("SELECT COUNT(*) n FROM compact_meta WHERE key GLOB 'discovery_slice_piece:*'").get().n, 0);
    r.close(); const second = rpc();
    await assert.rejects(() => run(f, second, { afterSlice: () => { throw new Error('crash_after_commit'); } }), /crash_after_commit/);
    assert.equal(f.db.prepare("SELECT COUNT(*) n FROM compact_meta WHERE key GLOB 'discovery_slice_piece:*'").get().n, 1);
    second.close(); const third = rpc(); assert.equal((await run(f, third)).phase, 'complete');
    assert(!third.calls.some(([m, [p]]) => m === 'eth_getLogs' && !p.address && p.fromBlock === hex(FIRST) && p.toBlock === hex(FIRST + 31)));
    third.close(); f.close();
  });
  await test('corrupt reducer fails closed before repeat logs', async () => {
    const f = fixture(), r = rpc(); await run(f, r, { maxSlices: 1 }); r.close();
    f.db.prepare("UPDATE compact_meta SET value='{}' WHERE key GLOB 'discovery_slice_cursor:*'").run();
    const next = rpc(); await rejects(() => run(f, next), 'recovery_slice_corrupt');
    assert(!next.calls.some(([m]) => m === 'eth_getLogs')); next.close(); f.close();
  });
  await test('source/projection version mismatch blocks without RPC or overwrite', async () => {
    const f = fixture(), r = rpc();
    f.db.prepare('UPDATE compact_meta SET value=? WHERE key=?').run('incompatible', 'projection_version:uniswap_v3_price_paths');
    await rejects(() => run(f, r), 'projection_definition_mismatch'); assert.equal(r.calls.length, 0); r.close(); f.close();
  });
  await test('low disk capacity and shared archive quota fail closed', async () => {
    const f = fixture(), r = rpc(), before = protectedState(f.db);
    await rejects(() => run(f, r, { capacity: () => ({ freeBytes: 1, databaseBytes: 100 }) }), 'storage_low_space');
    assert.equal(r.calls.length, 0); assert.deepEqual(protectedState(f.db), before);
    f.db.prepare('UPDATE compact_evidence_archive_usage SET stored_bytes=? WHERE id=1').run(CONFIG.maxArchiveBytes);
    await rejects(() => run(f, r), 'projection_storage_budget'); assert(!f.store.projectionStatus(HOUR).some(row => row.status === 'available'));
    r.close(); f.close();
  });
  await test('block/transaction mismatch, duplicate events and corrupt birth evidence never commit partial outputs', async () => {
    for (const mode of ['tx', 'duplicate', 'birth']) {
      const f = fixture({ existingPools: mode !== 'birth' }), r = rpc({ mutate: (item, result) => {
        if (item.method !== 'eth_getLogs' || !result.length) return result;
        if (mode === 'tx') return result.map(raw => ({ ...raw, transactionHash: hash(999) }));
        if (mode === 'duplicate') return [...result, result[0]];
        if (result[0].topics[0] === T.v3PoolCreated) return [{ ...result[0], data: '0x' }];
        return result;
      } });
      await assert.rejects(() => run(f, r));
      assert(!f.store.projectionStatus(HOUR).some(row => row.projection === 'uniswap_v3_pools' && row.status === 'available'));
      r.close(); f.close();
    }
  });
  await test('provider response budget halts RPC; next run uses smaller unsaved slice and preserves accepted progress', async () => {
    const f = fixture(), r = rpc({ budget: { requests: 512, calls: 20000, bytes: 64 * MiB, responseBytes: 8 * MiB, timeoutMs: 600000 },
      mutate: (item, result) => item.method === 'eth_getLogs' ? [...result, { filler: 'x'.repeat(8 * MiB) }] : result });
    await rejects(() => run(f, r), 'recovery_response_budget_exhausted');
    const count = r.calls.length; await rejects(() => r.provider.request('eth_chainId', []), 'recovery_response_budget_exhausted');
    assert.equal(r.calls.length, count);
    assert.equal(f.db.prepare('SELECT value FROM compact_meta WHERE key=?').get(`compact_dex_width:${HOUR}:uniswap_v3`).value, '16');
    r.close(); const next = rpc(); assert.equal((await run(f, next)).phase, 'complete'); next.close(); f.close();
  });
  await test('TVL transport interruption resumes accepted pinned calls without redownload', async () => {
    const f = fixture({ inputs: true }), r = rpc({ stop: item => item.method === 'eth_call' && item.params[0].data.startsWith('0xdbd035ff') });
    const partial = await run(f, r); assert.equal(partial.phase, 'partial'); assert.equal(partial.blocked.tvl, 'transport');
    const accepted = r.calls.filter(([m, [p]]) => m === 'eth_call' && p.data.startsWith('0x70a08231')); r.close();
    const next = rpc(); assert.equal((await run(f, next)).phase, 'complete');
    for (const call of accepted) assert(!next.calls.some(value => canonicalJson(value) === canonicalJson(call)));
    assert(!next.calls.some(([m]) => m === 'eth_getLogs')); next.close(); f.close();
  });
  await test('existing single-hour repair integrates continuation under explicit flag; legacy/default stays off', async () => {
    const f = fixture(), path = f.path; f.close(); const r = rpc();
    const result = await repairProjectionHour({ sqlitePath: path, hourStart: HOUR, DatabaseSync, providerFactory: () => r.provider,
      continuationConfig: CONFIG, capacity, print: () => {} });
    assert.equal(result.ok, true, canonicalJson(result)); r.close();
  });
  await test('checkpoint snapshots reject malformed counters, prices and activity restoration', async () => {
    const sink = createProjectionSink({ activity: false });
    const log = normalizeLog(logs()[0]); sink.v3('swap', log, decodeV3Swap(log), null);
    const snapshot = sink.checkpoint();
    assert.deepEqual(createProjectionSink({ activity: false, checkpoint: snapshot }).checkpoint(), snapshot);
    assert.throws(() => createProjectionSink({ checkpoint: snapshot }), e => e.code === 'projection_checkpoint_invalid');
    for (const mutate of [s => { s.pools.uniswap_v3[0][1].swapCount = -1; }, s => { s.paths.uniswap_v3[0][1].close[0] = '0'; }]) {
      const bad = structuredClone(snapshot); mutate(bad);
      assert.throws(() => createProjectionSink({ activity: false, checkpoint: bad }), e => e.code === 'projection_checkpoint_invalid');
    }
  });
  await test('historical identities fill missing valuation metadata with no repeated projection logs', async () => {
    const f = fixture({ existingPools: false, inputs: true }), r = rpc();
    const before = stored(f);
    assert.equal((await run(f, r)).phase, 'complete');
    assert.deepEqual(stored(f), before);
    assert(!r.calls.some(([method, [filter]]) => method === 'eth_getLogs' && filter.topics[0] !== T.v3PoolCreated && filter.topics[0] !== T.v4Initialize));
    assert(!f.store.tokenPrices(HOUR).some(row => row.token === UNKNOWN));
    r.close(); f.close();
  });
  await test('foreign EVM revert is excluded without accepting a false factory or weakening transport errors', async () => {
    const f = fixture(), r = rpc({ revertForeign: true });
    assert.equal((await run(f, r)).phase, 'complete');
    assert.equal(f.db.prepare('SELECT COUNT(*) n FROM compact_registry WHERE address=?').get(FOREIGN).n, 0);
    assert.equal(f.store.poolHours(HOUR, 'uniswap_v3')[0].swapCount, 5); r.close(); f.close();
  });
  await test('final projection commit rollback retains complete cursor; retry does not redownload completed V3', async () => {
    const f = fixture(), r = rpc(); let commits = 0;
    await assert.rejects(() => run(f, r, { beforeCommit: () => { if (++commits === 4) throw new Error('final_commit_crash'); } }), /final_commit_crash/);
    assert(!f.store.projectionStatus(HOUR).some(row => row.projection === 'uniswap_v3_pools' && row.status === 'available'));
    r.close(); const next = rpc(); assert.equal((await run(f, next)).phase, 'complete');
    assert(!next.calls.some(([m, [p]]) => m === 'eth_getLogs' && !p.address)); next.close(); f.close();
  });
  await test('stored verified outputs and family checksums detect corruption without RPC or replacement', async () => {
    for (const mode of ['family', 'price']) {
      const f = fixture({ inputs: true }), r = rpc();
      if (mode === 'family') f.db.prepare("UPDATE compact_family_hours SET metrics_sha256=? WHERE family='uniswapV3'").run('0'.repeat(64));
      else f.db.prepare("UPDATE compact_pool_price_hours SET sqrt_price_block_sum='1' WHERE protocol='uniswap_v3'").run();
      await rejects(() => run(f, r), mode === 'family' ? 'projection_family_corrupt' : 'projection_stored_input_corrupt');
      assert.equal(r.calls.length, 0); r.close(); f.close();
    }
  });
  await test('complete hash-only spine reconciles canonical transaction count and rejects duplicate hashes', async () => {
    for (const duplicate of [false, true]) {
      const f = fixture(), r = rpc({ mutate: (item, result) => {
        if (item.method === 'eth_getBlockByNumber' && item.params[0] === hex(FIRST + 1)) {
          return { ...result, transactions: duplicate ? [result.transactions[0], result.transactions[0]] : [] };
        }
        return result;
      } });
      await rejects(() => run(f, r), duplicate ? 'projection_slice_block_invalid' : 'projection_transaction_count_mismatch');
      assert(!f.store.projectionStatus(HOUR).some(row => row.projection === 'uniswap_v3_pools' && row.status === 'available'));
      r.close(); f.close();
    }
  });
  await test('scoped proof preserves registry coverage and rejects conflicting metadata atomically', async () => {
    const f = fixture({ existingPools: false }), r = rpc(), memo = new Map();
    const proof = await readScopedPoolWitness(r.provider, { protocol: 'uniswap_v3', pool: POOL, atBlock: FIRST,
      cached: async (key, producer) => { const text = canonicalJson(key); if (!memo.has(text)) memo.set(text, await producer()); return memo.get(text); } });
    const before = f.db.prepare('SELECT * FROM compact_registry_coverage').all();
    f.store.recordPoolWitness('uniswap_v3', POOL, FIRST, proof);
    assert.deepEqual(f.db.prepare('SELECT * FROM compact_registry_coverage').all(), before);
    const altered = structuredClone(proof); altered.record.fee = 100;
    const { checksum, ...body } = altered; altered.checksum = sha256Of(body);
    assert.throws(() => f.store.recordPoolWitness('uniswap_v3', POOL, FIRST, altered), e => e.code === 'pool_witness_invalid');
    r.close(); f.close();
  });
  await test('writer contention refuses existing repair before RPC; original checkpoint and rows stay intact', async () => {
    const f = fixture(), before = protectedState(f.db), lock = acquireWriterLock(f.path, { owner: 'local-regression' }), r = rpc();
    const result = await repairProjectionHour({ sqlitePath: f.path, hourStart: HOUR, DatabaseSync, providerFactory: () => r.provider,
      continuationConfig: CONFIG, capacity, print: () => {} });
    assert.equal(result.ok, false); assert.equal(r.calls.length, 0); assert.deepEqual(protectedState(f.db), before);
    lock.release(); r.close(); f.close();
  });
  await test('V4 birth search handles predeployment empty calls only with independent absent-code proof', async () => {
    const f = fixture({ existingPools: false }), r = rpc({ deployment: 70 });
    assert.equal((await run(f, r)).phase, 'complete');
    assert(r.calls.some(([method, [target]]) => method === 'eth_getCode' && target === PM));
    r.close(); f.close();
  });
  await test('historical unavailable TVL upgrades atomically while preserving prior reason and verified snapshots', async () => {
    const f = fixture({ inputs: true }), r = rpc();
    f.store.recordPoolTvl(HOUR, 'uniswap_v3', [{ pool: POOL, status: 'unavailable', reason: 'balance_unreadable' }], { blockNumber: LAST });
    f.store.recordPoolTvl(HOUR, 'uniswap_v4', [{ pool: V4, status: 'available', amount0: 9n, amount1: 8n }], { blockNumber: LAST });
    const before = f.store.poolTvl(HOUR, 'uniswap_v4');
    assert.equal((await run(f, r)).phase, 'complete');
    assert.equal(f.store.poolTvl(HOUR, 'uniswap_v3')[0].amount0Raw, '1000000'); assert.deepEqual(f.store.poolTvl(HOUR, 'uniswap_v4'), before);
    assert(!r.calls.some(([method, [params]]) => method === 'eth_call' && params.data.startsWith('0xdbd035ff')));
    const facts = f.db.prepare("SELECT value FROM compact_meta WHERE key GLOB 'compact_dex_fact:*'").all().map(row => JSON.parse(row.value).value);
    assert(facts.some(value => value?.reason === 'balance_unreadable' && value.pool === POOL));
    assert.throws(() => f.db.prepare("UPDATE compact_meta SET value='{}' WHERE key GLOB 'compact_dex_fact:*'").run(), /immutable_projection_fact/);
    r.close(); f.close();
  });
  await test('missing V4 fee input preserves already verified prices USD volumes fees and pool projections', async () => {
    const f = fixture({ inputs: true }), r = rpc();
    const valuation = () => [f.store.tokenPrices(HOUR), f.store.dexVolume(HOUR), f.store.dexFees(HOUR), f.store.valuationStatus(HOUR)];
    const before = valuation(), pools = stored(f);
    f.db.prepare('DELETE FROM compact_pool_fee_hours WHERE hour_start=?').run(HOUR);
    f.db.prepare('DELETE FROM compact_projection_hours WHERE hour_start=? AND projection=?').run(HOUR, 'uniswap_v4_swap_fees');
    assert.equal((await run(f, r)).phase, 'complete');
    assert.deepEqual(valuation(), before); assert.deepEqual(stored(f), pools);
    assert(!r.calls.some(([method, [filter]]) => method === 'eth_getLogs' && !filter.address)); r.close(); f.close();
  });
  await test('existing nonempty immutable archive survives projection and TVL repair byte for byte', async () => {
    const f = fixture(), r = rpc();
    const archive = createEvidenceArchive(f.db, { config: archiveConfig({ COMPACT_EVIDENCE_ARCHIVE_ENABLED: 'true', COMPACT_ARCHIVE_MAX_TOTAL_MIB: '512' }), capacity });
    archive.begin(); f.db.exec('BEGIN IMMEDIATE');
    archive.preserve('compact_meta', HOUR, [{ key: 'fixture_verified_provenance', value: 'retained' }], { scope: 'local_regression' });
    f.db.exec('COMMIT');
    const before = protectedState(f.db); assert(f.db.prepare('SELECT COUNT(*) n FROM compact_evidence_archive').get().n > 0);
    assert.equal((await run(f, r)).phase, 'complete'); assert.deepEqual(protectedState(f.db), before); r.close(); f.close();
  });
  await test('dense generated 7107-block hour resumes under unchanged real provider budgets and bounded heap', async () => {
    let f = fixture({ dense: true }); const before = protectedState(f.db), metrics = [], filters = new Set();
    let peakWalBytes = 0, peakDatabaseAndWalBytes = 0;
    const disk = () => {
      const wal = statSync(f.path + '-wal').size;
      peakWalBytes = Math.max(peakWalBytes, wal);
      peakDatabaseAndWalBytes = Math.max(peakDatabaseAndWalBytes, statSync(f.path).size + wal + statSync(f.path + '-shm').size);
    };
    for (let attempt = 0; attempt < 8; attempt++) {
      const r = rpc({ dense: true, padding: 12600 }), start = performance.now();
      const result = await run(f, r, { afterSlice: disk }); disk();
      for (const [method, [filter]] of r.calls) if (method === 'eth_getLogs') {
        const key = canonicalJson(filter); assert(!filters.has(key), 'accepted range repeated after reopen'); filters.add(key);
      }
      const elapsedMs = performance.now() - start;
      assert(r.stats.bytes <= 64 * MiB && r.maxResponseBytes <= 8 * MiB && r.stats.requests <= 512 && r.stats.calls <= 20000 && elapsedMs < 600000);
      metrics.push({ ...r.stats, maxResponseBytes: r.maxResponseBytes, elapsedMs: Math.round(elapsedMs), phase: result.phase });
      r.close(); const path = f.path; f.close();
      const db = new DatabaseSync(path); f = { ...f, db, store: createCompactStore(db), close: () => db.close() };
      if (result.phase === 'complete') break;
    }
    for (const protocol of ['uniswap_v3', 'uniswap_v4']) {
      assert.deepEqual(f.store.poolHours(HOUR, protocol), f.expected[protocol + '_pools'].rows);
      assert.deepEqual(f.store.pricePaths(HOUR, protocol), f.expected[protocol + '_price_paths'].rows);
    }
    assert.equal(metrics.at(-1).phase, 'complete'); assert.deepEqual(protectedState(f.db), before);
    console.log('DENSE_MEASURE', JSON.stringify({ generatedOnly: true, blocks: 7107, runs: metrics, databaseBytes: statSync(f.path).size,
      retainedBytes: JSON.parse(f.db.prepare('SELECT value FROM compact_meta WHERE key=?').get('discovery_slice_usage').value).bytes,
      peakWalBytes, peakDatabaseAndWalBytes, heapLimitBytes: getHeapStatistics().heap_size_limit,
      peakRssBytes: process.resourceUsage().maxRSS * 1024 })); f.close();
  });
  console.log(`RESULT PASS ${passed} checks; heap_limit=${getHeapStatistics().heap_size_limit}`);
} finally { rmSync(dir, { recursive: true, force: true }); }
