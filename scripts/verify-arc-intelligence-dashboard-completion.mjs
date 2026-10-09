// Phase 1D completion checks. Run in Codespace with Node 22.13+ / Node 24 and real node:sqlite.
// Offline fixtures only: temporary SQLite files, encoded on-chain responses and actual read-model/HTTP code.
// Missing SQLite is a failure, never a skipped PASS. Nothing connects to production or writes operator databases.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:http';
import { FAMILY_FIELDS, FAMILY_WINDOWS } from '../server/compact/families.js';
import { createIntelligenceServer } from '../server/compact/http.js';
import { v4PoolIdOf, V4_POOL_KIND } from '../server/compact/projections.js';
import { ARC_CHAIN_ID } from '../server/compact/provider.js';
import { createCompactReadModel, V4_SWAP_TO_BLOCKER } from '../server/compact/read-model.js';
import { V3_POOL_KIND } from '../server/compact/registry.js';
import { COMPACT_DEFINITION_VERSION } from '../server/compact/sources.js';
import { createCompactStore } from '../server/compact/store.js';
import {
  amount0Delta, amount1Delta, collectPoolTvl, hookMayHoldPoolValue, poolTvlUsd, readV3Balances, readV4Reserves,
  sqrtPriceAtTick, v4BitmapSlot, v4Reserves, v4StateSlot, v4TickSlot,
} from '../server/compact/tvl.js';
import { VALUATION_VERSIONS } from '../server/compact/valuation.js';
import { MAX_VALUATION_HOURS, readValuationInputs, planValuationBackfill, storageGuard } from '../server/compact/valuation-backfill.js';

const { DatabaseSync } = await import('node:sqlite');
globalThis.fetch = async () => { throw new Error('network forbidden in completion fixtures'); };
let passed = 0;
async function test(name, run) { await run(); passed += 1; console.log(`PASS ${name}`); }
const root = mkdtempSync(join(tmpdir(), 'compact-completion-'));
const HOUR = 3600;
const BASE = Date.UTC(2026, 8, 1) / 1000;
const Q96 = 2n ** 96n;
const USDC = '0x3600000000000000000000000000000000000000';
const WETH = '0x128cc466b61f542da60c70e3aa11c10e19b84edb';
const ZERO = `0x${'0'.repeat(40)}`;
const UNKNOWN = `0x${'ab'.repeat(20)}`;
const address = (n) => `0x${n.toString(16).padStart(40, '0')}`;
const hash = (n) => `0x${n.toString(16).padStart(64, '0')}`;
const word = (n) => BigInt.asUintN(256, BigInt(n)).toString(16).padStart(64, '0');
const iso = (s) => new Date(s * 1000).toISOString();
const V3 = address(0x91);
const V4_KEY = { currency0: ZERO, currency1: WETH, fee: 500, tickSpacing: 200, hooks: ZERO };
const V4 = v4PoolIdOf(V4_KEY);
const MANAGER = address(0x92);
const constants = { rawDecimals: 18 };

function emptyMetrics(name) {
  const spec = FAMILY_WINDOWS[name];
  return Object.fromEntries(FAMILY_FIELDS[name].map((field) => [field,
    spec.amounts?.includes(field) ? '0' : spec.constants?.includes(field) ? constants[field]
      : spec.tallies?.[field] ? {} : spec.lists?.[field] ? [] : 0]));
}
function hourResult(i, { unknown = false, mismatchedDecimals = false } = {}) {
  const hourStart = BASE + i * HOUR;
  const firstBlock = 1000 + i * 100;
  const lastBlock = firstBlock + 99;
  const families = Object.fromEntries(Object.keys(FAMILY_FIELDS).map((name) => [name, { status: 'available', ...emptyMetrics(name) }]));
  Object.assign(families.uniswapV3, { swapCount: 3, poolsWithSwaps: 1 });
  Object.assign(families.uniswapV4, { swapCount: 3, poolsWithSwaps: 1 });
  // Separate action totals: no protocol/action/bridge-leg netting. CCTP/Gateway use 6-decimal ERC-20 USDC, not native 18.
  Object.assign(families.cctp, { outboundTransferCount: 1, inboundMintCount: 1, outboundAmountRaw: '1000000', inboundAmountRaw: '2000000' });
  Object.assign(families.gateway, { depositCount: 1, outboundBurnCount: 1, inboundMintCount: 1,
    depositAmountRaw: '3000000', outboundBurnAmountRaw: '4000000', inboundMintAmountRaw: '5000000' });
  Object.assign(families.aaveV4, { supplyCount: 1, borrowCount: 1 });
  families.aaveV4.reserves = { r: { spoke: address(7), reserveId: '1', underlying: unknown ? UNKNOWN : USDC,
    decimals: mismatchedDecimals ? 18 : 6, suppliedRaw: '6000000', withdrawnRaw: '0', borrowedRaw: '7000000', repaidRaw: '0',
    liquidatedDebtRaw: '0', liquidatedCollateralRaw: '0' } };
  Object.assign(families.morphoVaultsV2, { depositCount: 1, withdrawCount: 1 });
  families.morphoVaultsV2.vaults = { [address(8)]: { asset: USDC, depositCount: 1, withdrawCount: 1,
    depositedAssetsRaw: '8000000', withdrawnAssetsRaw: '9000000' } };
  const poolRow = (pool, v3) => ({ pool, swapCount: 3, token0InRaw: v3 ? '0' : '3000000000000000000',
    token0OutRaw: '0', token1InRaw: v3 ? '3000000' : '0', token1OutRaw: '0', addCount: 0, removeCount: 0, pokeCount: 0,
    addAmount0Raw: v3 ? '0' : null, addAmount1Raw: v3 ? '0' : null, removeAmount0Raw: v3 ? '0' : null, removeAmount1Raw: v3 ? '0' : null });
  const pricePath = (pool, sqrt, reserve0, reserve1) => ({ pool, swapCount: 3, firstSwapBlock: firstBlock, lastSwapBlock: lastBlock,
    pricedBlocks: 100, closeSqrtPriceX96: sqrt.toString(), closeLiquidity: '1', sqrtPriceBlockSum: (sqrt * 100n).toString(),
    reserve0BlockSum: (reserve0 * 100n).toString(), reserve1BlockSum: (reserve1 * 100n).toString() });
  return { definitionVersion: COMPACT_DEFINITION_VERSION, chainId: ARC_CHAIN_ID,
    range: { kind: 'hour', hourStart, hourEnd: hourStart + HOUR, startUtc: iso(hourStart), endUtc: iso(hourStart + HOUR),
      firstBlock, lastBlock, parentHash: hash(firstBlock - 1), firstHash: hash(firstBlock), lastHash: hash(lastBlock),
      firstTimestamp: hourStart, lastTimestamp: hourStart + HOUR - 1 },
    network: { status: 'available', blockCount: 100, transactionCount: 10, uniqueSenders: 1, uniqueRecipients: 1,
      uniqueActiveAddresses: 1, gasUsedRaw: '1000', averageTransactionsPerBlock: 0.1, transactionsPerSecond: 10 / HOUR,
      internal: { deploymentAttempts: 0 } }, activeAddresses: [address(9)], complete: true, families,
    registry: { uniswapV3: { through: lastBlock, throughHash: hash(lastBlock), created: [] } },
    projections: {
      uniswap_v3_pools: { status: 'available', rows: [poolRow(V3, true)] },
      uniswap_v4_pools: { status: 'available', rows: [poolRow(V4, false)], registry: [] },
      dex_activity: { status: 'available', rows: [] },
      uniswap_v3_price_paths: { status: 'available', rows: [pricePath(V3, 2n ** 80n, 0n, 50_000n * 10n ** 6n)] },
      // Below minimum anchor depth: does not compete with V3's verified WETH price.
      uniswap_v4_price_paths: { status: 'available', rows: [pricePath(V4, Q96, 1n, 1n)] },
      uniswap_v4_swap_fees: { status: 'available', rows: [{ pool: V4, swapCount: 3, feeIn0E6: (3n * 10n ** 18n * 500n).toString(),
        feeIn1E6: '0', feeOut0E12: '0', feeOut1E12: '0' }] },
    } };
}
function fixture(name, count, options) {
  const path = join(root, `${name}.sqlite`);
  const db = new DatabaseSync(path);
  const store = createCompactStore(db);
  store.extendRegistry({ kind: V3_POOL_KIND, fromBlock: 1, through: 999, throughHash: hash(999), previousThrough: null,
    created: [{ address: V3, createdBlock: 900, createdLogIndex: 0, createdTx: hash(901), token0: WETH, token1: USDC, fee: 500, tickSpacing: 10 }] });
  store.extendV4Registry({ kind: V4_POOL_KIND, fromBlock: 1, through: 999, throughHash: hash(999), previousThrough: null,
    created: [{ poolId: V4, createdBlock: 901, createdLogIndex: 1, createdTx: hash(902), ...V4_KEY }] });
  for (let i = 0; i < count; i++) store.commitHour(hourResult(i, options));
  return { path, db, store, model: () => createCompactReadModel({ path, DatabaseSync, now: () => (BASE + count * HOUR) * 1000 }) };
}
const facts = (db) => Object.fromEntries(['compact_hours', 'compact_family_hours', 'compact_checkpoint', 'compact_hour_addresses',
  'compact_pool_hours', 'compact_dex_activity'].map((table) => [table, db.prepare(`SELECT * FROM ${table}`).all()]));

try {
  await test('V3 actual balance calls preserve historical blockTag and >2^53 raw precision; missing sides fail closed', async () => {
    const raw = 10n ** 30n + 123n;
    const provider = { batch: async (calls, options) => {
      assert.equal(options.allowItemErrors, true);
      assert.deepEqual(calls.map(([, args]) => [args[0].to, args[0].data, args[1]]), [WETH, USDC]
        .map((token) => [token, `0x70a08231${word(BigInt(V3))}`, '0x1234']));
      return [{ result: `0x${word(raw)}` }, { result: `0x${word(2_000_000n)}` }];
    } };
    const pools = [{ pool: V3, token0: WETH, token1: USDC }];
    assert.deepEqual((await readV3Balances(provider, pools, { blockTag: '0x1234' })).get(V3), { status: 'available', amount0: raw, amount1: 2_000_000n });
    const broken = { batch: async () => [{ result: '0x' }, { result: `0x${word(2_000_000n)}` }] };
    assert.deepEqual((await readV3Balances(broken, pools, { blockTag: '0x1234' })).get(V3), { status: 'unavailable', reason: 'balance_unreadable' });
    assert.equal(poolTvlUsd({ token0: UNKNOWN, token1: USDC, amount0: 1n, amount1: 2_000_000n }, new Map()), null);
    assert.equal(poolTvlUsd({ token0: UNKNOWN, token1: USDC, amount0: 0n, amount1: 2_000_000n }, new Map()), 2_000_000n);
  });

  await test('V4 bounded state reads reproduce principal reserves at the historical block, never manager balances or flow', async () => {
    const liquidity = 10n ** 18n;
    const state = v4StateSlot(V4);
    const values = new Map([[state, Q96], [state + 3n, liquidity], [v4BitmapSlot(state, -1), 1n << 255n],
      [v4BitmapSlot(state, 0), 2n], [v4TickSlot(state, -200), BigInt.asUintN(128, liquidity) << 128n],
      [v4TickSlot(state, 200), BigInt.asUintN(128, -liquidity) << 128n]]);
    let requests = 0;
    const provider = { batch: async (list) => {
      requests += 1;
      assert.equal(list.length, 1);
      return list.map(([method, args]) => {
        assert.equal(method, 'eth_call');
        assert.equal(args[0].to, MANAGER);
        assert.equal(args[1], '0x1234');
        const data = args[0].data;
        assert.ok(data.startsWith('0xdbd035ff'));
        const count = Number(BigInt(`0x${data.slice(74, 138)}`));
        const slots = Array.from({ length: count }, (_, i) => BigInt(`0x${data.slice(138 + i * 64, 202 + i * 64)}`));
        return `0x${word(32)}${word(count)}${slots.map((slot) => word(values.get(slot) ?? 0n)).join('')}`;
      });
    } };
    const pools = [{ pool: V4, tickSpacing: 200, hooks: ZERO }];
    const expected = { amount0: amount0Delta(Q96, sqrtPriceAtTick(200), liquidity), amount1: amount1Delta(sqrtPriceAtTick(-200), Q96, liquidity) };
    assert.deepEqual((await readV4Reserves(provider, pools, { poolManager: MANAGER, blockTag: '0x1234' })).get(V4), { status: 'available', ...expected });
    assert.equal(requests, 3);
    values.set(state + 3n, liquidity + 1n);
    assert.deepEqual((await readV4Reserves(provider, pools, { poolManager: MANAGER, blockTag: '0x1234' })).get(V4),
      { status: 'unavailable', reason: 'tvl_state_inconsistent' });
    assert.equal(sqrtPriceAtTick(0), Q96);
    assert.equal(sqrtPriceAtTick(-887272), 4295128739n);
    assert.equal(sqrtPriceAtTick(887272), 1461446703485210103287273052203988822378723970342n);
  });

  await test('V4 hooks including afterSwap deltas, oversized scans and malformed tick state never fabricate holdings', async () => {
    for (const flag of [1, 2, 4, 8]) assert.equal(hookMayHoldPoolValue(address(flag)), true);
    const never = { batch: async () => { throw new Error('no RPC expected'); } };
    const results = await readV4Reserves(never, [{ pool: V4, tickSpacing: 200, hooks: address(4) },
      { pool: hash(77), tickSpacing: 1, hooks: ZERO }], { poolManager: MANAGER, blockTag: '0x1234' });
    assert.equal(results.get(V4).reason, 'hook_may_hold_pool_value');
    assert.equal(results.get(hash(77)).reason, 'tvl_scan_unbounded');
    assert.throws(() => v4Reserves({ sqrtPriceX96: Q96, tick: 0, liquidity: 1n, ticks: [[-900000, 1n], [200, -1n]] }),
      (error) => error.code === 'tvl_state_inconsistent');
    const malformed = await readV4Reserves({ batch: async () => ['0x'] }, [{ pool: V4, tickSpacing: 200, hooks: ZERO }],
      { poolManager: MANAGER, blockTag: '0x1234' });
    assert.equal(malformed.get(V4).reason, 'tvl_state_inconsistent');
  });

  const live = fixture('full-30d', 720);
  try {
    await test('24H, 7D and 30D complete windows carry exact one-sided volume, estimated fees and valued pool totals', async () => {
      const model = live.model();
      try {
        for (const [key, hours, bins] of [['24h', 24, 24], ['7d', 168, 7], ['30d', 720, 30]]) {
          const summary = model.summary(key);
          assert.equal(summary.dex.usdVolume.status, 'available');
          assert.equal(summary.dex.usdVolume.totalUsdMicros, (BigInt(hours) * 6_000_000n).toString());
          assert.equal(summary.dex.usdVolume.valuedSwaps, hours * 6);
          assert.equal(summary.dex.swapFees.calculation, 'estimated');
          assert.equal(summary.dex.swapFees.basis, VALUATION_VERSIONS.dex_fees);
          assert.equal(summary.dex.swapFees.totalFeeUsdMicros, (BigInt(hours) * 3000n).toString());
          assert.equal(summary.dex.swapFees.averageFeeUsdMicros, '500');
          const series = model.timeseries(key);
          assert.equal(series.buckets.length, bins);
          assert.ok(series.buckets.every((bucket) => bucket.dexUsdVolume.status === 'available'));
          assert.equal(series.buckets.reduce((sum, bucket) => sum + BigInt(bucket.dexUsdVolume.totalUsdMicros), 0n), BigInt(hours) * 6_000_000n);
          for (const protocol of ['v3', 'v4']) assert.equal(model.pools(protocol, key).pools[0].usdVolume.usdMicros, (BigInt(hours) * 3_000_000n).toString());
          if (hours > 24) {
            assert.deepEqual(summary.network.uniqueActiveAddresses,
              { status: 'not_supported', reason: 'identity_retention_exceeded', value: null });
            assert.equal(series.window.start, iso(BASE + (720 - hours) * HOUR));
            assert.equal(series.window.end, iso(BASE + 720 * HOUR));
            for (const [index, bucket] of series.buckets.entries()) {
              assert.equal(bucket.start, iso(BASE + (720 - hours + index * 24) * HOUR));
              assert.equal(bucket.end, iso(BASE + (720 - hours + (index + 1) * 24) * HOUR));
              assert.equal(bucket.storedHours, 24);
              assert.equal(bucket.network.uniqueActiveAddresses, 1, 'daily distinct count, not the sum of hourly uniques');
              assert.deepEqual(bucket.network.uniqueActiveAddressesStatus, { status: 'available', value: 1 });
            }
          }
        }
      } finally { model.close(); }
    });

    await test('protocol USD keeps Arc ERC-20 units and independent actions; shares, native raw USDC and DEX are not added', async () => {
      const model = live.model();
      try {
        const p = model.summary('24h').protocolUsd;
        assert.equal(p.cctp.values.outboundUsdMicros, '24000000');
        assert.equal(p.cctp.values.inboundUsdMicros, '48000000');
        assert.equal(p.gateway.values.depositUsdMicros, '72000000');
        assert.equal(p.gateway.values.outboundBurnUsdMicros, '96000000');
        assert.equal(p.gateway.values.inboundMintUsdMicros, '120000000');
        assert.equal(p.aaveV4.values.borrowedUsdMicros, '168000000');
        assert.equal(p.morphoVaultsV2.values.depositedUsdMicros, '192000000');
        assert.equal(p.morphoVaultsV2.values.withdrawnUsdMicros, '216000000');
        assert.equal(model.summary('24h').dex.usdVolume.totalUsdMicros, '144000000');
      } finally { model.close(); }
    });

    await test('TVL rows are immutable, bound to the committed last block, and do not mutate core/family/projection facts', async () => {
      const i = 719;
      const hourStart = BASE + i * HOUR;
      const lastBlock = 1099 + i * 100;
      const before = facts(live.db);
      const missing = live.model();
      try {
        for (const protocol of ['v3', 'v4']) {
          const pools = missing.pools(protocol, '24h');
          assert.equal(pools.ranking.liquidityUsd.status, 'unavailable');
          assert.equal(pools.ranking.liquidityUsd.reason, 'tvl_not_collected');
          assert.equal(pools.pools[0].liquidityUsd.usdMicros, null);
        }
      } finally { missing.close(); }
      const rows = [{ pool: V3, status: 'available', amount0: 10n ** 18n + 123n, amount1: 2_000_000n }];
      assert.throws(() => live.store.recordPoolTvl(hourStart, 'uniswap_v3', rows, { blockNumber: lastBlock + 1 }),
        (error) => error.code === 'invalid_tvl_snapshot');
      assert.deepEqual(live.store.poolTvl(hourStart, 'uniswap_v3'), []);
      live.store.recordPoolTvl(hourStart, 'uniswap_v3', rows, { blockNumber: lastBlock });
      live.store.recordPoolTvl(hourStart, 'uniswap_v3', [{ ...rows[0], amount1: 1n }], { blockNumber: lastBlock });
      assert.equal(live.store.poolTvl(hourStart, 'uniswap_v3')[0].amount1Raw, '2000000');
      live.store.recordPoolTvl(hourStart, 'uniswap_v4', [{ pool: V4, status: 'available', amount0: 10n ** 18n, amount1: 0n }], { blockNumber: lastBlock });
      assert.deepEqual(facts(live.db), before);
      const model = live.model();
      try {
        const v3 = model.pools('v3', '24h').pools[0].liquidityUsd;
        assert.equal(v3.calculation, 'balance_snapshot');
        assert.equal(v3.status, 'available');
        assert.equal(v3.amount0Raw, (10n ** 18n + 123n).toString());
        const v4 = model.pools('v4', '24h').pools[0].liquidityUsd;
        assert.equal(v4.calculation, 'estimated_principal_reserves');
        assert.equal(v4.usdMicros, '1000000');
      } finally { model.close(); }
      const tooMany = await collectPoolTvl({ store: live.store, provider: { batch: async () => { throw new Error('no RPC expected'); } },
        hourStart, blockNumber: lastBlock, poolManager: MANAGER, limit: 11 });
      assert.equal(tooMany.error, 'tvl_scan_unbounded');
    });

    await test('one failed valuation hour blocks window/pool totals and leaves a real chart gap, never a fake zero', async () => {
      const at = BASE + 708 * HOUR;
      live.db.prepare("UPDATE compact_valuation_hours SET status='unavailable',reason='prices_unavailable',row_count=NULL,rows_sha256=NULL WHERE hour_start=? AND valuation='dex_usd_volume'").run(BigInt(at));
      const model = live.model();
      try {
        assert.equal(model.summary('24h').dex.usdVolume.totalUsdMicros, null);
        assert.ok(model.summary('24h').dex.usdVolume.unavailableHours.includes(iso(at)));
        const gap = model.timeseries('24h').buckets.find((bucket) => bucket.start === iso(at));
        assert.equal(gap.dexUsdVolume.status, 'unavailable');
        assert.equal(gap.dexUsdVolume.reason, 'prices_unavailable');
        assert.equal(gap.dexUsdVolume.totalUsdMicros, undefined);
        assert.equal(model.pools('v3', '24h').pools[0].usdVolume.usdMicros, null);
        const days = model.timeseries('30d').buckets;
        assert.ok(days.some((bucket) => bucket.dexUsdVolume.status === 'unavailable'));
      } finally { model.close(); }
    });
  } finally { live.db.close(); }

  await test('daily charts exclude the current partial UTC day and keep missing or unavailable DAU counts null', async () => {
    const data = fixture('partial-utc-day', 173);
    try {
      data.db.prepare('DELETE FROM compact_daily_active_addresses WHERE day_start = ?').run(BigInt(BASE));
      data.db.prepare("UPDATE compact_daily_active_addresses SET status='unavailable',reason='identity_not_captured',active_addresses=NULL WHERE day_start = ?")
        .run(BigInt(BASE + 24 * HOUR));
      const model = data.model();
      try {
        assert.equal(model.summary('7d').window.end, iso(BASE + 173 * HOUR), 'summary retains its rolling-hour window');
        const series = model.timeseries('7d');
        assert.equal(series.window.start, iso(BASE));
        assert.equal(series.window.end, iso(BASE + 168 * HOUR));
        assert.equal(series.buckets.length, 7);
        for (const [index, bucket] of series.buckets.entries()) {
          assert.equal(bucket.start, iso(BASE + index * 24 * HOUR));
          assert.equal(bucket.end, iso(BASE + (index + 1) * 24 * HOUR));
          assert.equal(bucket.status, 'committed');
          assert.equal(bucket.storedHours, 24);
          assert.equal(bucket.network.transactions, 240, 'missing daily identities do not remove additive evidence');
          const expected = index === 0 ? { status: 'not_stored', reason: 'daily_identity_not_processed', value: null }
            : index === 1 ? { status: 'unavailable', reason: 'identity_not_captured', value: null }
              : { status: 'available', value: 1 };
          assert.deepEqual(bucket.network.uniqueActiveAddressesStatus, expected);
          assert.equal(bucket.network.uniqueActiveAddresses, expected.value);
        }
      } finally { model.close(); }
    } finally { data.db.close(); }
  });

  await test('missing long-window history is an explicit gap; the bounded valuation backfill never promises 168/720 hours', async () => {
    const short = fixture('short', 24);
    const model = short.model();
    try {
      for (const key of ['7d', '30d']) {
        assert.equal(model.summary(key).dex.usdVolume.status, 'unavailable');
        assert.equal(model.summary(key).dex.usdVolume.reason, 'insufficient_coverage');
        assert.equal(model.summary(key).dex.usdVolume.totalUsdMicros, null);
        assert.ok(model.timeseries(key).buckets.some((bucket) => bucket.status === 'not_stored'));
      }
      const plan = planValuationBackfill(readValuationInputs(short.db, { hours: 72 }));
      assert.equal(MAX_VALUATION_HOURS, 72);
      assert.equal(plan.targetHours, 24);
      assert.equal(storageGuard(plan), null);
    } finally { model.close(); short.db.close(); }
  });

  await test('unverified assets and incorrect Aave units block protocol USD, not other protocols or DEX', async () => {
    for (const [name, options, reason] of [['unknown', { unknown: true }, 'unverified_token'], ['units', { mismatchedDecimals: true }, 'decimals_mismatch']]) {
      const data = fixture(name, 24, options);
      const model = data.model();
      try {
        const summary = model.summary('24h');
        assert.equal(summary.protocolUsd.aaveV4.status, 'unavailable');
        assert.equal(summary.protocolUsd.aaveV4.reason, reason);
        assert.equal(summary.protocolUsd.aaveV4.values, null);
        assert.equal(summary.protocolUsd.cctp.status, 'available');
        assert.equal(summary.dex.usdVolume.status, 'available');
      } finally { model.close(); data.db.close(); }
    }
  });

  await test('real HTTP serves all long-window read models; the read API never fetches RPC', async () => {
    const data = fixture('http', 24);
    const model = data.model();
    const server = createIntelligenceServer({ readModel: model });
    await new Promise((done) => server.listen(0, '127.0.0.1', done));
    try {
      for (const path of ['/health', ...['24h', '7d', '30d'].flatMap((key) => [`/v1/intelligence/summary?window=${key}`,
        `/v1/intelligence/timeseries?window=${key}`, `/v1/intelligence/pools?protocol=v3&window=${key}`, `/v1/intelligence/pools?protocol=v4&window=${key}`])]) {
        const reply = await new Promise((resolve, reject) => {
          const req = request({ host: '127.0.0.1', port: server.address().port, path }, (res) => {
            const parts = [];
            res.on('data', (part) => parts.push(part));
            res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(parts).toString()) }));
          });
          req.on('error', reject); req.end();
        });
        assert.equal(reply.status, 200, path);
        if (path.includes('summary?window=30d')) assert.equal(reply.body.dex.usdVolume.totalUsdMicros, null);
      }
    } finally {
      server.closeAllConnections?.();
      await new Promise((done) => server.close(done));
      model.close(); data.db.close();
    }
  });

  await test('visible metric copy and V4 recipient blocker remain explicit; no transaction target is fabricated', async () => {
    const ui = readFileSync(new URL('../src/components/ArcIntelligenceOverview.tsx', import.meta.url), 'utf8');
    const lib = readFileSync(new URL('../src/lib/arcIntelligence.ts', import.meta.url), 'utf8');
    assert.match(ui, /label="DEX Volume"/);
    assert.match(ui, /USD-valued Uniswap V3 and V4 swaps on Arc\./);
    assert.match(ui, /label="Avg DEX Pool Fee"/);
    assert.match(ui, /Estimated principal reserves/);
    assert.match(lib, /V4 swap recipient is not emitted by the event and trace data is unavailable\./);
    assert.match(ui, /Uniswap V4 swaps: \{V4_SWAP_TO_TEXT\}/);
    assert.equal(V4_SWAP_TO_BLOCKER, 'v4_swap_recipient_not_emitted_and_trace_unavailable');
    assert.match(lib, /toReason/);
    assert.doesNotMatch(lib, /to\s*[:=]\s*(?:tx\.to|transaction\.to|router|poolManager)/);
  });
} finally { rmSync(root, { recursive: true, force: true }); }
console.log(`ARC_INTELLIGENCE_DASHBOARD_COMPLETION: PASS (${passed} deterministic scenarios; real node:sqlite; offline)`);
