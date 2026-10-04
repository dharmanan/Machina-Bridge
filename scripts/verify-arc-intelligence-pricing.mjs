// Compact engine, Stage 4B Phase 1C: token metadata, on-chain USD pricing, DEX USD volume and pool USD volume.
// Offline only: hand-encoded events, constructed price paths and fake providers. No network, no server, no backfill run.
// Pure tests run on any Node; node:sqlite tests (store derivation, read model) run when the runtime has it (Node 22.13+),
// and COMPACT_REQUIRE_SQLITE=1 turns its absence into a failure.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { normalizeLog } from '../api/_lib/arc-intelligence/normalize.js';
import { decodeV3Swap, decodeV4Swap, UNISWAP_EVENT_TOPICS, UNISWAP_REGISTRY } from '../api/_lib/arc-intelligence/uniswap.js';
import { FAMILY_FIELDS, FAMILY_WINDOWS } from '../server/compact/families.js';
import { processHour } from '../server/compact/hour.js';
import { createSyntheticChain } from '../server/compact/offline.js';
import {
  createProjectionSink, PRICE_PATH_OF_POOLS, PRICE_PATH_PROJECTIONS, PROJECTION_VERSIONS, PROJECTIONS, reconcilePricePaths, v4PoolIdOf,
  validPricePathRow,
} from '../server/compact/projections.js';
import { ARC_CHAIN_ID, createProvider } from '../server/compact/provider.js';
import { createCompactReadModel } from '../server/compact/read-model.js';
import { bootstrapV3Registry, registrySnapshot, V3_POOL_KIND } from '../server/compact/registry.js';
import { COMPACT_DEFINITION_VERSION, FAMILY_VERSIONS } from '../server/compact/sources.js';
import { createCompactStore } from '../server/compact/store.js';
import {
  decodeAbiText, decodeAbiUint, METADATA_TOKENS_PER_BATCH, METADATA_TOKENS_PER_RUN, metadataExempt, metadataOf, readTokenMetadata,
  refreshTokenMetadata,
} from '../server/compact/token-metadata.js';
import {
  anchorDecimals, blockState, evaluateSource, hourVolumeOf, MAX_SQRT_PRICE_X96, microsToDecimal, MIN_SQRT_PRICE_X96, needsPrice, poolVolumeUsd,
  PRICE_POLICY, priceFromSqrt, tokenPricesOf, usdMicrosOf, VALUATION_VERSIONS, ValuationError,
} from '../server/compact/valuation.js';

let passed = 0;
async function test(name, run) { await run(); passed += 1; console.log(`PASS ${name}`); }
const hex = (number) => `0x${number.toString(16)}`;
const word = (value) => BigInt.asUintN(256, BigInt(value)).toString(16).padStart(64, '0');
const topicOf = (address) => `0x${address.slice(2).padStart(64, '0')}`;
const addressOf = (n) => `0x${n.toString(16).padStart(40, '0')}`;
const hashOf = (n) => `0x${n.toString(16).padStart(64, '0')}`;
const T = UNISWAP_EVENT_TOPICS;
const Q96 = 2n ** 96n;
const Q192 = 2n ** 192n;

const ZERO = `0x${'0'.repeat(40)}`;
const USDC = '0x3600000000000000000000000000000000000000';
const EURC = '0xbef5f6d51cb62b58e6a8f77868681825c6fe21c1';
const CIRBTC = '0x171a4217b86a807a64eb94757db6849fb4bdbaa0';
const WETH = '0x128cc466b61f542da60c70e3aa11c10e19b84edb';
const USYC = '0x8a5d989bbb96929f689b0200f435f53da42bf490';
const MOON = addressOf(0x3c3c);
const ZAP = addressOf(0x2a2a);
const HOOKS = addressOf(0x4000);
const ROUTER = addressOf(0x4f4f);

// ---------------------------------------------------------------------------------------------------------------------
// Token metadata (eth_call answers are ABI encoded by hand).

const abiString = (text) => {
  const bytes = Buffer.from(text, 'latin1');
  const padded = bytes.toString('hex').padEnd(Math.ceil(bytes.length / 32) * 64, '0');
  return `0x${word(32)}${word(bytes.length)}${padded}`;
};
const bytes32 = (text) => `0x${Buffer.from(text, 'latin1').toString('hex').padEnd(64, '0')}`;
const ok = (result) => ({ result });
const REVERT = { error: { code: 3, message: 'execution reverted' } };
const TRANSIENT = { error: { code: -32000, message: 'header not found' } };
const answers = (symbol, name, decimals) => ({ symbol, name, decimals });

await test('metadata: a token that answers symbol, name and decimals plainly is cached as verified with exactly those values', async () => {
  assert.equal(decodeAbiText(abiString('MOON')), 'MOON');
  assert.equal(decodeAbiText(bytes32('MKR')), 'MKR', 'a legacy bytes32 symbol');
  assert.equal(decodeAbiUint(`0x${word(18)}`), 18n);
  assert.deepEqual(metadataOf(MOON, answers(ok(abiString('MOON')), ok(abiString('Moon Token')), ok(`0x${word(18)}`))),
    { token: MOON, verified: true, symbol: 'MOON', name: 'Moon Token', decimals: 18, reason: null });
  assert.deepEqual(metadataOf(MOON, answers(ok(abiString('ZAP')), REVERT, ok(`0x${word(0)}`))),
    { token: MOON, verified: true, symbol: 'ZAP', name: null, decimals: 0, reason: null }, 'name() is optional; zero decimals are valid');
});

await test('metadata: broken, missing or suspicious answers are cached as rejected with symbol, name and decimals null', async () => {
  const rejected = (reason) => ({ token: MOON, verified: false, symbol: null, name: null, decimals: null, reason });
  const name = ok(abiString('Moon'));
  const eighteen = ok(`0x${word(18)}`);
  const cases = [
    [answers(ok('0x'), name, eighteen), 'no_return_data'],
    [answers(REVERT, name, eighteen), 'reverted'],
    [answers(ok(abiString('MOON')), name, REVERT), 'reverted'],
    [answers(ok(abiString('MOON')), name, ok('0x')), 'no_return_data'],
    [answers(ok(abiString('MOON')), name, ok(`0x${word(37)}`)), 'decimals_out_of_range'],
    [answers(ok(abiString('MOON')), name, ok(`0x${word(18)}${word(1)}`)), 'malformed_decimals'],
    [answers(ok(abiString('MO\u0001ON')), name, eighteen), 'malformed_symbol'],
    [answers(ok(abiString('MOON TOKEN')), name, eighteen), 'malformed_symbol'],
    [answers(ok(abiString('A'.repeat(21))), name, eighteen), 'malformed_symbol'],
    [answers(ok(`0x${word(64)}${word(4)}${'4d4f4f4e'.padEnd(64, '0')}`), name, eighteen), 'malformed_symbol'],
    [answers(ok(`${abiString('MOON')}00`), name, eighteen), 'malformed_symbol'],
    [answers(ok(abiString('USDC')), name, eighteen), 'imitates_verified_asset'],
    [answers(ok(abiString('wETH2')), name, eighteen), 'imitates_verified_asset'],
    [answers(ok(abiString('CIRBTC')), name, eighteen), 'imitates_verified_asset'],
    [answers(ok(abiString('MOON')), ok(abiString('USD Coin')), eighteen), 'imitates_verified_asset'],
  ];
  for (const [input, reason] of cases) assert.deepEqual(metadataOf(MOON, input), rejected(reason), reason);
});

await test('metadata: a transport or node error caches nothing, so the token is read again later; verified identities are never read', async () => {
  const good = ok(abiString('MOON'));
  for (const input of [answers(TRANSIENT, good, ok(`0x${word(18)}`)), answers(good, good, TRANSIENT), answers(good, TRANSIENT, ok(`0x${word(18)}`)),
    answers(undefined, good, ok(`0x${word(18)}`))]) assert.equal(metadataOf(MOON, input), null);
  for (const token of [ZERO, USDC, EURC, CIRBTC, WETH, USYC]) assert.ok(metadataExempt(token), token);
  assert.equal(metadataExempt(MOON), false);
  const provider = { batch: async () => { throw new Error('must not be called'); } };
  await assert.rejects(readTokenMetadata(provider, [USDC], { blockTag: '0x10' }), /invalid_metadata_tokens/);
  await assert.rejects(readTokenMetadata(provider, [ZERO], { blockTag: '0x10' }), /invalid_metadata_tokens/);
});

// A fake provider that answers every eth_call from a table and records each batch.
function metadataProvider(table = new Map(), { failAt = null } = {}) {
  const batches = [];
  return {
    batches,
    async batch(calls, { allowItemErrors } = {}) {
      assert.equal(allowItemErrors, true);
      batches.push(calls);
      if (failAt !== null && batches.length === failAt) throw Object.assign(new Error('rate_limited'), { code: 'rate_limited' });
      return calls.map(([method, [call, blockTag]]) => {
        assert.deepEqual([method, blockTag], ['eth_call', '0xf4240']);
        const entry = table.get(call.to) ?? {};
        const kind = { '0x95d89b41': 'symbol', '0x06fdde03': 'name', '0x313ce567': 'decimals' }[call.data];
        return entry[kind] ?? REVERT;
      });
    },
  };
}
const tokensFrom = (count, start = 0x5000) => Array.from({ length: count }, (_, index) => addressOf(start + index));

await test('bounded RPC: metadata of at most 32 tokens per run, three eth_call each, at most 50 calls per batch: two batched requests', async () => {
  assert.equal(METADATA_TOKENS_PER_RUN, 32);
  assert.equal(METADATA_TOKENS_PER_BATCH * 3 <= 50, true);
  const tokens = tokensFrom(32);
  const table = new Map(tokens.map((token, index) => [token, answers(ok(abiString(`T${index}`)), ok(abiString(`Token ${index}`)), ok(`0x${word(index % 19)}`))]));
  const provider = metadataProvider(table);
  const result = await readTokenMetadata(provider, tokens, { blockTag: '0xf4240' });
  assert.deepEqual([result.requests, provider.batches.length, provider.batches.map((batch) => batch.length)], [2, 2, [48, 48]]);
  assert.equal(result.rows.length, 32);
  assert.deepEqual(result.rows[5], { token: tokens[5], verified: true, symbol: 'T5', name: 'Token 5', decimals: 5, reason: null });
  // refreshTokenMetadata: never more than the cap, whatever the store offers; exempt tokens are dropped before any call.
  const recorded = [];
  const store = { tokensNeedingMetadata: ({ limit }) => [USDC, ZERO, ...tokensFrom(limit + 8)], recordTokenMetadata: (rows, { readBlock }) => {
    recorded.push(...rows.map((row) => [row.token, readBlock]));
  } };
  const refresh = metadataProvider(new Map(tokensFrom(40).map((token) => [token, answers(ok(abiString('X')), REVERT, ok(`0x${word(6)}`))])));
  const report = await refreshTokenMetadata({ store, provider: refresh, blockNumber: 1_000_000, limit: 500 });
  assert.deepEqual(report, { candidates: 32, verified: 32, rejected: 0, skipped: 0, requests: 2, error: null });
  assert.equal(recorded.length, 32);
  assert(recorded.every(([token, block]) => !metadataExempt(token) && block === 1_000_000));
  // A failure after the first batch: the first batch stays cached, the run reports the error and never throws.
  const failing = [];
  const partial = await refreshTokenMetadata({ store: { ...store, recordTokenMetadata: (rows) => failing.push(...rows) },
    provider: metadataProvider(new Map(), { failAt: 2 }), blockNumber: 1_000_000 });
  assert.deepEqual([partial.requests, partial.rejected, failing.length, partial.error], [1, 16, 16, 'rate_limited']);
});

// ---------------------------------------------------------------------------------------------------------------------
// Valuation: anchors, prices from square-root prices, the source policy and one-side volume.

// A price-path row as projections.js produces it, for a constant square-root price and constant virtual reserves.
const pathRow = (pool, { sqrt, reserve0 = 0n, reserve1 = 0n, swaps = 10, priced = 100, first = 1000 }) => ({ pool, swapCount: swaps, firstSwapBlock: first,
  lastSwapBlock: first + priced - 1, pricedBlocks: priced, closeSqrtPriceX96: sqrt.toString(), closeLiquidity: '1',
  sqrtPriceBlockSum: (sqrt * BigInt(priced)).toString(), reserve0BlockSum: (reserve0 * BigInt(priced)).toString(),
  reserve1BlockSum: (reserve1 * BigInt(priced)).toString() });
const DEEP_USDC = 50_000n * 10n ** 6n; // 50,000 USDC of anchor-side virtual reserve
const DEEP_NATIVE = 50_000n * 10n ** 18n;
const S_EURC = 5n * 2n ** 94n; // sqrt(1.5625) * 2^96
const S_BTC = 25n * Q96; // raw price 625 = 62,500 USD per cirBTC (8 decimals) in USDC (6 decimals)
const S_WETH = 2n ** 90n; // native USDC per WETH raw = 1/4096 inverted: 4,096 USD per WETH

await test('USDC anchor: Arc USDC (6 decimals) and V4 native USDC (18 decimals) are exactly 1 USD; nothing else is assumed', async () => {
  assert.deepEqual([anchorDecimals(USDC), anchorDecimals(ZERO), anchorDecimals(EURC), anchorDecimals(MOON)], [6, 18, null, null]);
  assert.equal(usdMicrosOf(USDC, 123_456_789n, null), 123_456_789n, 'raw ERC-20 USDC units are micro-USD');
  assert.equal(usdMicrosOf(ZERO, 2_500_000_000_000_000_001n, null), 2_500_000n, 'native USDC floors to the micro-USD');
  assert.equal(usdMicrosOf(EURC, 10n ** 6n, null), null, 'a verified asset without a price has no value, never 1 USD');
  assert.equal(usdMicrosOf(MOON, 10n ** 18n, new Map([[MOON, { priceUsdE18: 10n ** 18n }]])), null, 'an unverified token never has a price');
  assert.equal(microsToDecimal(1_234_567n), '1.234567');
});

await test('V3 price: block-weighted mean square-root price of a verified USDC pool, exact in both token orders', async () => {
  assert.equal(priceFromSqrt(S_EURC, { anchorSide: 1, anchorDecimals: 6, targetDecimals: 6 }), 1_562_500_000_000_000_000n, 'EURC/USDC: 1.5625 USD');
  assert.equal(priceFromSqrt(S_EURC, { anchorSide: 0, anchorDecimals: 6, targetDecimals: 6 }), 640_000_000_000_000_000n, 'USDC/EURC: 0.64 USD');
  assert.equal(priceFromSqrt(S_BTC, { anchorSide: 1, anchorDecimals: 6, targetDecimals: 8 }), 62_500n * 10n ** 18n, 'cirBTC/USDC: 62,500 USD');
  const source = evaluateSource({ row: pathRow('0xpool', { sqrt: S_BTC, reserve1: DEEP_USDC }), protocol: 'uniswap_v3', token0: CIRBTC, token1: USDC,
    hooks: null, hourBlocks: 100 });
  assert.deepEqual([source.qualified, source.token, source.priceUsdE18, source.depthUsdMicros], [true, CIRBTC, 62_500n * 10n ** 18n, 50_000_000_000n]);
});

await test('V4 price: a hookless pool against native USDC prices the other side; a hooked pool never sets a price', async () => {
  const row = pathRow('0xv4', { sqrt: S_WETH, reserve0: DEEP_NATIVE });
  const source = evaluateSource({ row, protocol: 'uniswap_v4', token0: ZERO, token1: WETH, hooks: ZERO, hourBlocks: 100 });
  assert.deepEqual([source.qualified, source.token, source.priceUsdE18], [true, WETH, 4096n * 10n ** 18n]);
  assert.equal(source.priceUsdE18, (Q192 * 10n ** 36n) / (S_WETH * S_WETH * 10n ** 18n), 'the closed form, independently');
  assert.deepEqual(evaluateSource({ row, protocol: 'uniswap_v4', token0: ZERO, token1: WETH, hooks: HOOKS, hourBlocks: 100 }),
    { qualified: false, reason: 'hooked_pool' });
});

await test('unknown price: unverified tokens, non-USDC pairs and USDC itself never receive a price', async () => {
  const row = pathRow('0xp', { sqrt: Q96, reserve0: DEEP_USDC, reserve1: DEEP_USDC });
  for (const [token0, token1] of [[USDC, MOON], [MOON, USDC], [EURC, WETH], [MOON, ZAP], [USDC, ZERO]]) {
    assert.deepEqual(evaluateSource({ row, protocol: 'uniswap_v3', token0, token1, hooks: null, hourBlocks: 100 }), { qualified: false, reason: 'not_a_usdc_pair' },
      `${token0}/${token1}`);
  }
  const { prices } = tokenPricesOf({ pricePaths: { uniswap_v3: [row], uniswap_v4: [] }, poolOf: () => ({ token0: USDC, token1: MOON, hooks: null }), hourBlocks: 100 });
  assert.equal(prices.size, 0);
});

await test('manipulation fails closed: too few swaps, a short path, a shallow pool and disagreeing sources set no price', async () => {
  const base = { protocol: 'uniswap_v3', token0: CIRBTC, token1: USDC, hooks: null, hourBlocks: 100 };
  const check = (row, reason) => assert.deepEqual(evaluateSource({ ...base, row }), { qualified: false, reason }, reason);
  check(pathRow('0xp', { sqrt: S_BTC, reserve1: DEEP_USDC, swaps: PRICE_POLICY.minSwaps - 1 }), 'too_few_swaps');
  check(pathRow('0xp', { sqrt: S_BTC, reserve1: DEEP_USDC, priced: 49, first: 1051 }), 'short_price_path');
  check(pathRow('0xp', { sqrt: S_BTC, reserve1: 24_999n * 10n ** 6n }), 'shallow_pool');
  check({ ...pathRow('0xp', { sqrt: S_BTC, reserve1: DEEP_USDC }), pricedBlocks: 101 }, 'invalid_price_path');
  check(pathRow('0xp', { sqrt: MIN_SQRT_PRICE_X96 - 1n, reserve1: DEEP_USDC }), 'invalid_price_path');
  assert.equal(evaluateSource({ ...base, row: pathRow('0xp', { sqrt: S_BTC, reserve1: DEEP_USDC, priced: 50, first: 1050 }) }).qualified, true, 'half the hour');
  // Two qualified sources: the deepest sets the price; more than 5% apart, the token has no price at all.
  const pools = { '0xdeep': { token0: CIRBTC, token1: USDC, hooks: null }, '0xother': { token0: CIRBTC, token1: USDC, hooks: null } };
  const poolOf = (_protocol, pool) => pools[pool];
  const near = 25n * Q96 + (25n * Q96) / 100n; // about 2% higher price
  const far = 26n * Q96; // about 8% higher price
  const agreeing = tokenPricesOf({ pricePaths: { uniswap_v3: [pathRow('0xdeep', { sqrt: S_BTC, reserve1: DEEP_USDC * 2n }),
    pathRow('0xother', { sqrt: near, reserve1: DEEP_USDC })], uniswap_v4: [] }, poolOf, hourBlocks: 100 });
  assert.deepEqual(agreeing.prices.get(CIRBTC), { priceUsdE18: 62_500n * 10n ** 18n, protocol: 'uniswap_v3', pool: '0xdeep', depthUsdMicros: 100_000_000_000n,
    sources: 2 });
  const disagreeing = tokenPricesOf({ pricePaths: { uniswap_v3: [pathRow('0xdeep', { sqrt: S_BTC, reserve1: DEEP_USDC * 2n }),
    pathRow('0xother', { sqrt: far, reserve1: DEEP_USDC })], uniswap_v4: [] }, poolOf, hourBlocks: 100 });
  assert.deepEqual([disagreeing.prices.has(CIRBTC), disagreeing.rejected.get(CIRBTC)], [false, 'sources_disagree']);
  assert.throws(() => tokenPricesOf({ pricePaths: { uniswap_v3: [pathRow('0xmissing', { sqrt: S_BTC })], uniswap_v4: [] }, poolOf, hourBlocks: 100 }),
    (error) => error instanceof ValuationError && error.code === 'pool_registry_missing', 'a pool outside the registry fails closed');
});

await test('no double counting: each swap is valued once, by its USDC side, else a priced side (the mean when both are priced)', async () => {
  const prices = new Map([[EURC, { priceUsdE18: 640_000_000_000_000_000n }], [CIRBTC, { priceUsdE18: 62_500n * 10n ** 18n }]]);
  // USDC/EURC: 100 USDC paid in, 90 EURC paid out: 100 USD, never 100 + 90 * 0.64.
  assert.deepEqual(poolVolumeUsd({ token0: USDC, token1: EURC, side0Raw: 100_000_000n, side1Raw: 90_000_000n }, prices),
    { usdMicros: 100_000_000n, basis: 'usd_anchor' });
  assert.deepEqual(poolVolumeUsd({ token0: EURC, token1: USDC, side0Raw: 90_000_000n, side1Raw: 100_000_000n }, prices),
    { usdMicros: 100_000_000n, basis: 'usd_anchor' }, 'the anchor side whatever the token order');
  assert.deepEqual(poolVolumeUsd({ token0: USDC, token1: ZERO, side0Raw: 5_000_000n, side1Raw: 4_999_000_000_000_000_000n }, null),
    { usdMicros: 5_000_000n, basis: 'usd_anchor' }, 'two anchors: token0 only');
  assert.deepEqual(poolVolumeUsd({ token0: EURC, token1: MOON, side0Raw: 1_000_000n, side1Raw: 10n ** 30n }, prices),
    { usdMicros: 640_000n, basis: 'verified_price' }, 'the verified side of an unverified pair');
  assert.deepEqual(poolVolumeUsd({ token0: EURC, token1: CIRBTC, side0Raw: 1_000_000n, side1Raw: 100_000_000n }, prices),
    { usdMicros: (640_000n + 62_500_000_000n) / 2n, basis: 'verified_price' }, 'both priced: one swap, the mean of its two values');
  assert.equal(poolVolumeUsd({ token0: MOON, token1: ZAP, side0Raw: 1n, side1Raw: 1n }, prices), null, 'nothing to value it with');
  assert.equal(poolVolumeUsd({ token0: EURC, token1: MOON, side0Raw: 1_000_000n, side1Raw: 1n }, new Map()), null, 'a missing price is not a zero');
  assert.deepEqual([needsPrice(EURC, MOON), needsPrice(USDC, MOON), needsPrice(MOON, ZAP)], [true, false, false]);
});

await test('exact BigInt precision: raw amounts far beyond 2^53 are valued without floating point', async () => {
  const huge = 10n ** 30n + 7n;
  assert.equal(usdMicrosOf(CIRBTC, huge, new Map([[CIRBTC, { priceUsdE18: 62_500n * 10n ** 18n }]])), (huge * 62_500n * 10n ** 18n) / 10n ** 20n);
  assert.equal(usdMicrosOf(USDC, huge, null), huge);
  const big = { token0InRaw: (2n ** 120n).toString(), token0OutRaw: '1', token1InRaw: '0', token1OutRaw: '0' };
  const { totals } = hourVolumeOf({ poolRows: { uniswap_v3: [{ pool: 'a', swapCount: 2, ...big }], uniswap_v4: [] },
    poolOf: () => ({ token0: USDC, token1: MOON, hooks: null }), prices: null });
  assert.equal(totals.uniswap_v3.usdMicros, 2n ** 120n + 1n);
  assert.throws(() => hourVolumeOf({ poolRows: { uniswap_v3: [{ pool: 'a', swapCount: 1, ...big, token0OutRaw: '1.5' }], uniswap_v4: [] },
    poolOf: () => ({ token0: USDC, token1: MOON, hooks: null }), prices: null }), (error) => error.code === 'malformed_flow');
});

await test('hourly USD volume: per protocol, valued and unvalued swaps; without prices an hour that needs one is not valued at all', async () => {
  const pools = { a: { token0: USDC, token1: MOON, hooks: null }, b: { token0: EURC, token1: MOON, hooks: null }, c: { token0: MOON, token1: ZAP, hooks: null },
    x: { token0: ZERO, token1: EURC, hooks: HOOKS } };
  const poolOf = (_protocol, pool) => pools[pool];
  const row = (pool, swapCount, side0, side1 = '0') => ({ pool, swapCount, token0InRaw: side0, token0OutRaw: '0', token1InRaw: side1, token1OutRaw: '0' });
  const poolRows = { uniswap_v3: [row('a', 10, '7000000'), row('b', 4, '2000000'), row('c', 2, '9'), row('a', 0, '0')],
    uniswap_v4: [row('x', 5, '3000000000000000000')] };
  const prices = new Map([[EURC, { priceUsdE18: 640_000_000_000_000_000n }]]);
  assert.deepEqual(hourVolumeOf({ poolRows, poolOf, prices }), { needsPrices: false, totals: {
    uniswap_v3: { usdMicros: 7_000_000n + 1_280_000n, valuedSwaps: 14, unvaluedSwaps: 2 },
    uniswap_v4: { usdMicros: 3_000_000n, valuedSwaps: 5, unvaluedSwaps: 0 } } });
  assert.equal(hourVolumeOf({ poolRows, poolOf, prices: null }).needsPrices, true, 'b needs the EURC price: the hour is not valued without it');
  const anchoredOnly = { uniswap_v3: [row('a', 10, '7000000'), row('c', 2, '9')], uniswap_v4: [row('x', 5, '3000000000000000000')] };
  assert.equal(hourVolumeOf({ poolRows: anchoredOnly, poolOf, prices: null }).needsPrices, false, 'an hour with USDC sides only needs no price');
  assert.throws(() => hourVolumeOf({ poolRows: { uniswap_v3: [row('unknown', 1, '1')], uniswap_v4: [] }, poolOf, prices }),
    (error) => error.code === 'pool_registry_missing');
});

// ---------------------------------------------------------------------------------------------------------------------
// Price paths from Swap events (projections.js), through the real decoders.

const V3_POOL = addressOf(0xc0de01);
const V4_POOL = `0x${'d1'.repeat(32)}`;
const FIRST = 50_000;
const LAST = FIRST + 99;
function swapLog(protocol, block, logIndex, sqrt, liquidity, amounts = [1n, -1n]) {
  const raw = protocol === 'v3'
    ? { address: V3_POOL, topics: [T.v3Swap, topicOf(ROUTER), topicOf(ROUTER)],
      data: `0x${word(amounts[0])}${word(amounts[1])}${word(sqrt)}${word(liquidity)}${word(0)}` }
    : { address: UNISWAP_REGISTRY.v4PoolManager.address, topics: [T.v4Swap, V4_POOL, topicOf(ROUTER)],
      data: `0x${word(amounts[0])}${word(amounts[1])}${word(sqrt)}${word(liquidity)}${word(0)}${word(500)}` };
  return normalizeLog({ ...raw, blockNumber: hex(block), blockHash: hashOf(block), transactionHash: hashOf(0x7a0000 + block * 10 + logIndex),
    transactionIndex: '0x0', logIndex: hex(logIndex), removed: false });
}
function priceHour(events, { protocol = 'v3', first = FIRST, last = LAST } = {}) {
  const sink = createProjectionSink({ activity: false });
  for (const [block, logIndex, sqrt, liquidity] of events) {
    const log = swapLog(protocol, block, logIndex, sqrt, liquidity);
    if (protocol === 'v3') sink.v3('swap', log, decodeV3Swap(log), null);
    else sink.v4('swap', log, decodeV4Swap(log), null);
  }
  const families = { uniswapV3: { status: 'available', swapCount: protocol === 'v3' ? events.length : 0, mintCount: 0, burnCount: 0 },
    uniswapV4: { status: 'available', swapCount: protocol === 'v4' ? events.length : 0, modifyLiquidityCount: 0, initializeCount: 0 } };
  return sink.finish({ families, hourStart: null, firstBlock: first, lastBlock: last });
}
const reserves = (sqrt, liquidity) => [(liquidity * Q96) / sqrt, (liquidity * sqrt) / Q96];

await test('price path: end-of-block prices are weighted by the blocks they hold, from the first swap through the hour\'s last block', async () => {
  const L = 10n ** 18n;
  const [s1, s2, s3, s4] = [Q96, 2n * Q96, 3n * Q96, 4n * Q96];
  const out = priceHour([[FIRST, 0, s1, L], [FIRST, 3, s2, L], [FIRST + 40, 1, s3, 2n * L], [LAST, 0, s4, L]]);
  assert.equal(out.uniswap_v3_price_paths.status, 'available');
  const [row] = out.uniswap_v3_price_paths.rows;
  const weighted = (index) => 40n * reserves(s2, L)[index] + 59n * reserves(s3, 2n * L)[index] + reserves(s4, L)[index];
  assert.deepEqual(row, { pool: V3_POOL, swapCount: 4, firstSwapBlock: FIRST, lastSwapBlock: LAST, pricedBlocks: 100, closeSqrtPriceX96: s4.toString(),
    closeLiquidity: L.toString(), sqrtPriceBlockSum: (40n * s2 + 59n * s3 + s4).toString(), reserve0BlockSum: weighted(0).toString(),
    reserve1BlockSum: weighted(1).toString() }, 'block 50000 ends at s2 (the second swap of the block), s3 holds 59 blocks, s4 the last one');
  assert.deepEqual(blockState(s2, L), { sqrtPrice: s2, reserve0: reserves(s2, L)[0], reserve1: reserves(s2, L)[1] });
  assert.ok(validPricePathRow(row, 'uniswap_v3', { firstBlock: FIRST, lastBlock: LAST }));
  assert.equal(validPricePathRow({ ...row, pricedBlocks: 99 }, 'uniswap_v3', { firstBlock: FIRST, lastBlock: LAST }), false);
  // The pool rows of the same events are exactly the Phase 1A ones: the price path adds a projection and changes no other.
  assert.equal(out.uniswap_v3_pools.rows[0].swapCount, 4);
  assert.equal(out.dex_activity.status, 'unavailable');
});

await test('price path: a pump and dump inside one block has no weight; a last-block swap weighs one block of the hour', async () => {
  const L = 10n ** 18n;
  const s = 25n * Q96;
  const steady = [[FIRST, 0, s, L], [FIRST + 10, 0, s, L], [FIRST + 20, 0, s, L]];
  const pumped = [...steady, [FIRST + 50, 1, s * 10n, L], [FIRST + 50, 2, s, L]];
  const mean = (out) => BigInt(out.uniswap_v3_price_paths.rows[0].sqrtPriceBlockSum) / BigInt(out.uniswap_v3_price_paths.rows[0].pricedBlocks);
  assert.equal(mean(priceHour(pumped)), s, 'the end-of-block price is unchanged, so the path is unchanged');
  const lastBlock = mean(priceHour([...steady, [LAST, 0, s * 4n, L]]));
  assert.equal(lastBlock, (99n * s + 4n * s) / 100n, 'one block in a hundred');
  const price = priceFromSqrt(lastBlock, { anchorSide: 1, anchorDecimals: 6, targetDecimals: 8 });
  assert.ok(price < (62_500n * 10n ** 18n * 107n) / 100n, 'a 16x pump in the last block moves the hourly price by about 6%, not 16x');
});

await test('price path: out-of-order events or an impossible price make the paths unavailable; the pool rows stand', async () => {
  const L = 10n ** 18n;
  const disorder = priceHour([[FIRST + 5, 0, Q96, L], [FIRST + 4, 0, Q96, L]]);
  assert.deepEqual([disorder.uniswap_v3_price_paths, disorder.uniswap_v3_pools.status],
    [{ status: 'unavailable', reason: 'price_path_out_of_order' }, 'available']);
  assert.deepEqual(priceHour([[FIRST, 0, MAX_SQRT_PRICE_X96 + 1n, L]]).uniswap_v3_price_paths, { status: 'unavailable', reason: 'price_path_invalid' });
  assert.deepEqual(priceHour([[FIRST, 0, 0n, L]]).uniswap_v3_price_paths, { status: 'unavailable', reason: 'price_path_invalid' });
  assert.deepEqual(priceHour([[FIRST, 0, Q96, L]], { last: null }).uniswap_v3_price_paths, { status: 'unavailable', reason: 'projection_inputs_unavailable' });
  const rows = priceHour([[FIRST, 0, Q96, L]]).uniswap_v3_price_paths.rows;
  assert.equal(reconcilePricePaths(rows, { status: 'available', swapCount: 2 }), 'reconciliation_mismatch');
  assert.equal(reconcilePricePaths(rows, { status: 'available', swapCount: 1 }, [{ pool: V3_POOL, swapCount: 2 }]), 'reconciliation_mismatch');
  assert.equal(reconcilePricePaths(rows, { status: 'available', swapCount: 1 }, [{ pool: V3_POOL, swapCount: 1 }]), null);
});

await test('price path: V4 Swap events give the same path for a PoolManager pool', async () => {
  const L = 7n * 10n ** 20n;
  const out = priceHour([[FIRST, 0, S_WETH, L], [FIRST + 60, 0, S_WETH * 2n, L]], { protocol: 'v4' });
  assert.equal(out.uniswap_v4_price_paths.status, 'available');
  assert.deepEqual(out.uniswap_v4_price_paths.rows.map((row) => [row.pool, row.swapCount, row.sqrtPriceBlockSum]),
    [[V4_POOL, 2, (60n * S_WETH + 40n * S_WETH * 2n).toString()]]);
  assert.equal(out.uniswap_v3_price_paths.rows.length, 0, 'no V3 swap, an empty V3 path that still reconciles');
});

// ---------------------------------------------------------------------------------------------------------------------
// Existing projections, versions and the RPC budget of the hour.

const offlineProvider = (fetchImpl) => createProvider({ fetchImpl, minIntervalMs: 0, cooldownMs: 0, sleep: async () => {} });
const SYNTH_HOUR = 1_790_006_400;
const ORIGIN = { originNumber: 23_000_000, originTimestamp: SYNTH_HOUR - 1000 };
const chainOf = () => createSyntheticChain({ ...ORIGIN, poolCreatedAt: 23_002_500 });
const V3 = registrySnapshot(await bootstrapV3Registry(offlineProvider(chainOf().fetchImpl), { fromBlock: ORIGIN.originNumber, toBlock: ORIGIN.originNumber + 25_000 }));
async function syntheticHour(projections) {
  const chain = chainOf();
  const provider = offlineProvider(chain.fetchImpl);
  const result = await processHour({ provider, hourStart: SYNTH_HOUR, safeHead: ORIGIN.originNumber + 12_000, v3Registry: V3, projections });
  return { chain, provider, result };
}
const LIVE = await syntheticHour(true);

await test('existing projections unaffected: same versions, same pool rows and activity; price paths are two new projections', async () => {
  assert.deepEqual(PROJECTION_VERSIONS, { uniswap_v3_pools: 'uniswap-v3-pool-hours-v1', uniswap_v4_pools: 'uniswap-v4-pool-hours-v1+initialize-pool-id-keccak',
    dex_activity: 'uniswap-dex-activity-v1', uniswap_v3_price_paths: 'uniswap-v3-pool-price-path-v1', uniswap_v4_price_paths: 'uniswap-v4-pool-price-path-v1',
    uniswap_v4_swap_fees: 'uniswap-v4-swap-fees-v1' });
  assert.deepEqual(PROJECTIONS.slice(0, 3), ['uniswap_v3_pools', 'uniswap_v4_pools', 'dex_activity'], 'the Phase 1A projections keep their order');
  assert.deepEqual(PRICE_PATH_OF_POOLS, { uniswap_v3_pools: 'uniswap_v3_price_paths', uniswap_v4_pools: 'uniswap_v4_price_paths' });
  assert.deepEqual(Object.values(PRICE_PATH_PROJECTIONS), ['uniswap_v3', 'uniswap_v4']);
  for (const name of [...PROJECTIONS, ...Object.keys(VALUATION_VERSIONS)]) {
    assert(!Object.hasOwn(FAMILY_VERSIONS, name) && !Object.hasOwn(FAMILY_FIELDS, name), `${name} is not a family`);
  }
  const { projections } = LIVE.result;
  for (const name of PROJECTIONS) assert.equal(projections[name].status, 'available', name);
  for (const [name, protocol] of Object.entries(PRICE_PATH_PROJECTIONS)) {
    const pools = projections[protocol === 'uniswap_v3' ? 'uniswap_v3_pools' : 'uniswap_v4_pools'].rows.filter((row) => row.swapCount > 0);
    assert.deepEqual(projections[name].rows.map((row) => [row.pool, row.swapCount]), pools.map((row) => [row.pool, row.swapCount]), name);
  }
  // The Phase 1A rows are unchanged by the new projections: their digests are computed over the same rows as before.
  const digest = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
  const again = await syntheticHour(true);
  assert.equal(digest(again.result.projections.uniswap_v3_pools), digest(projections.uniswap_v3_pools));
  assert.equal(digest(again.result.projections.uniswap_v4_pools), digest(projections.uniswap_v4_pools));
});

await test('bounded RPC during indexing: price paths cost zero extra requests; the hour definition is unchanged', async () => {
  const without = await syntheticHour(false);
  assert.deepEqual(LIVE.chain.requests, without.chain.requests, 'identical request sequence with and without every projection');
  assert.deepEqual([LIVE.provider.stats.requests, LIVE.provider.stats.calls], [without.provider.stats.requests, without.provider.stats.calls]);
  assert.equal(COMPACT_DEFINITION_VERSION, 'arc-compact-hour-v2');
  assert(!JSON.stringify(LIVE.result.families).includes('price'), 'no family carries a price');
});

await test('no RPC and no writes from the read model: it never imports a provider, the metadata reader or any write statement', async () => {
  const source = await readFile(new URL('../server/compact/read-model.js', import.meta.url), 'utf8');
  const imports = [...source.matchAll(/^import .* from '([^']+)';$/gm)].map((match) => match[1]);
  assert.deepEqual(imports.filter((path) => path !== './provider.js' && /provider|token-metadata|logs|hour|spine|projection-backfill/.test(path)), [],
    imports.join(','));
  assert.match(source, /import \{ ARC_CHAIN_ID \} from '\.\/provider\.js';/, 'only the chain id constant from provider.js');
  assert.doesNotMatch(source, /createProvider|\bfetch\(|eth_call|eth_getLogs|\.batch\(|refreshTokenMetadata|readTokenMetadata/);
  const sqlBlock = source.match(/const SQL = Object\.freeze\(\{([\s\S]*?)\n\}\);/)[1];
  assert.doesNotMatch(sqlBlock, /\b(INSERT|UPDATE|DELETE|REPLACE|CREATE|DROP|ALTER|PRAGMA)\b/, 'every read-model statement is a read');
  const valuation = await readFile(new URL('../server/compact/valuation.js', import.meta.url), 'utf8');
  assert.deepEqual([...valuation.matchAll(/^import .* from '([^']+)';$/gm)].map((match) => match[1]), ['../../api/_lib/arc-intelligence/assets.js'],
    'valuation is pure: no provider, no SQLite, no network');
  assert.doesNotMatch(valuation, /\bfetch\(|Date\.now|Math\.random|parseFloat|Number\(/, 'no clock, randomness or floating point in valuation');
});

// ---------------------------------------------------------------------------------------------------------------------
// node:sqlite: derivation at commit, the bounded pass for stored hours, the metadata cache and the read model.

const sqlite = await import('node:sqlite').catch(() => null);
if (!sqlite) {
  assert.notEqual(process.env.COMPACT_REQUIRE_SQLITE, '1', `node:sqlite is required but unavailable on Node ${process.version}`);
  console.log(`DEFERRED pricing sqlite tests: node:sqlite is unavailable on Node ${process.version}; run this file on Node 22.13+ `
    + '(e.g. the Node 24 Railway image) with COMPACT_REQUIRE_SQLITE=1 to execute them');
} else {
  const { DatabaseSync } = sqlite;
  const workdir = mkdtempSync(join(process.env.COMPACT_SQLITE_DIR || tmpdir(), 'compact-pricing-'));
  const HOUR = 3600;
  const BASE = Date.UTC(2026, 9, 1, 0) / 1000;
  const BLOCKS = 100;
  const iso = (seconds) => new Date(seconds * 1000).toISOString();
  const firstBlockOf = (i) => 1000 + i * BLOCKS;
  const CONSTANTS = { rawDecimals: 18, symbol: 'EURC', address: EURC, decimals: 6, spoke: addressOf(0x5555), reserveId: '1', underlying: USDC,
    loanToken: USDC, collateralToken: CIRBTC, lltv: '860000000000000000', asset: USDC };
  const entry = (spec, k, index) => ({
    ...Object.fromEntries((spec.counts ?? []).map((field) => [field, k + 1 + index])),
    ...Object.fromEntries((spec.amounts ?? []).map((field) => [field, String(1000 + k + index)])),
    ...Object.fromEntries((spec.constants ?? []).map((field) => [field, CONSTANTS[field]])),
  });
  function familyMetrics(name, k) {
    const spec = FAMILY_WINDOWS[name];
    return Object.fromEntries(FAMILY_FIELDS[name].map((field) => {
      if (spec.counts?.includes(field)) return [field, k + 1];
      if (spec.amounts?.includes(field)) return [field, String(1000 + k)];
      if (spec.constants?.includes(field)) return [field, CONSTANTS[field]];
      if (spec.tallies?.[field]) return [field, { k: entry(spec.tallies[field], k, 0) }];
      if (spec.lists?.[field]) return [field, [entry(spec.lists[field], k, 0)]];
      return [field, 50 + k];
    }));
  }
  // Pools: V3 WETH/USDC (deep: the WETH price source), V3 WETH/MOON (needs the WETH price), V3 MOON/ZAP (never valued);
  // V4 native USDC/EURC without hooks and a hooked USDC/MOON pool.
  const P = { wethUsdc: addressOf(0x9101), wethMoon: addressOf(0x9102), moonZap: addressOf(0x9103) };
  const V4_KEYS = { nativeEurc: { currency0: ZERO, currency1: EURC, fee: 500, tickSpacing: 10, hooks: ZERO },
    usdcMoon: { currency0: USDC, currency1: MOON, fee: 10000, tickSpacing: 200, hooks: HOOKS } };
  const V4 = Object.fromEntries(Object.entries(V4_KEYS).map(([name, key]) => [name, v4PoolIdOf(key)]));
  const S_WETH_USDC = 2n ** 80n; // WETH token0 (18), USDC token1 (6): 10^30 / 2^32 micro-USD... exact below
  const WETH_PRICE = (S_WETH_USDC * S_WETH_USDC * 10n ** 36n) / (Q192 * 10n ** 6n);
  const v3Created = (address, token0, token1, n) => ({ address, createdBlock: firstBlockOf(0), createdLogIndex: n, createdTx: hashOf(0x7100 + n), token0, token1,
    fee: 500, tickSpacing: 10 });
  const v4Created = (name, n) => ({ poolId: V4[name], createdBlock: firstBlockOf(0), createdLogIndex: 10 + n, createdTx: hashOf(0x7300 + n), ...V4_KEYS[name] });
  const poolRow = (pool, swapCount, flows, v3 = true) => ({ pool, swapCount, token0InRaw: flows[0], token0OutRaw: flows[1], token1InRaw: flows[2],
    token1OutRaw: flows[3], addCount: 0, removeCount: 0, pokeCount: 0, ...(v3 ? { addAmount0Raw: '0', addAmount1Raw: '0', removeAmount0Raw: '0',
      removeAmount1Raw: '0' } : { addAmount0Raw: null, addAmount1Raw: null, removeAmount0Raw: null, removeAmount1Raw: null }) });
  const path = (i, pool, swapCount, sqrt, reserve0, reserve1) => pathRow(pool, { sqrt, reserve0, reserve1, swaps: swapCount, priced: BLOCKS,
    first: firstBlockOf(i) });
  const WETH_SIDE = 10n ** 18n; // 1 WETH through the WETH/MOON pool each hour
  // One hour; withPaths false: price paths left out (an hour indexed before they existed).
  function hourResult(i, { withPaths = true, projections = true } = {}) {
    const hourStart = BASE + i * HOUR;
    const firstBlock = firstBlockOf(i);
    const lastBlock = firstBlock + BLOCKS - 1;
    const families = Object.fromEntries(Object.keys(FAMILY_FIELDS).map((name) => [name, { status: 'available', ...familyMetrics(name, i) }]));
    Object.assign(families.uniswapV3, { swapCount: 16, mintCount: 0, burnCount: 0 });
    Object.assign(families.uniswapV4, { swapCount: 8, modifyLiquidityCount: 0, initializeCount: i === 0 ? 2 : 0 });
    const v3Rows = [poolRow(P.wethUsdc, 10, ['1000000000000000000', '1000000000000000000', '2000000000', '2000000000']),
      poolRow(P.wethMoon, 4, [(WETH_SIDE / 2n).toString(), (WETH_SIDE / 2n).toString(), '5', '5']), poolRow(P.moonZap, 2, ['9', '0', '0', '9'])]
      .sort((left, right) => (left.pool < right.pool ? -1 : 1));
    const v4Rows = [poolRow(V4.nativeEurc, 5, ['3000000000000000000', '2000000000000000000', '1', '1'], false),
      poolRow(V4.usdcMoon, 3, ['10000000', '0', '0', '7'], false)].sort((left, right) => (left.pool < right.pool ? -1 : 1));
    const set = {
      uniswap_v3_pools: { status: 'available', rows: v3Rows },
      uniswap_v4_pools: { status: 'available', rows: v4Rows, registry: i === 0 ? [v4Created('nativeEurc', 0), v4Created('usdcMoon', 1)] : [] },
      dex_activity: { status: 'available', rows: [] },
      ...(withPaths ? {
        uniswap_v3_price_paths: { status: 'available', rows: [path(i, P.wethUsdc, 10, S_WETH_USDC, 0n, 50_000n * 10n ** 6n),
          path(i, P.wethMoon, 4, Q96, 10n ** 18n, 10n ** 18n), path(i, P.moonZap, 2, Q96, 1n, 1n)].sort((left, right) => (left.pool < right.pool ? -1 : 1)) },
        uniswap_v4_price_paths: { status: 'available', rows: [path(i, V4.nativeEurc, 5, Q96, 1n, 1n), path(i, V4.usdcMoon, 3, Q96, 1n, 1n)]
          .sort((left, right) => (left.pool < right.pool ? -1 : 1)) },
        uniswap_v4_swap_fees: { status: 'available', rows: [V4.nativeEurc, V4.usdcMoon].map((pool) => ({ pool, swapCount: pool === V4.nativeEurc ? 5 : 3,
          feeIn0E6: '0', feeIn1E6: '0', feeOut0E12: '0', feeOut1E12: '0' })).sort((left, right) => (left.pool < right.pool ? -1 : 1)) },
      } : {}),
    };
    return { definitionVersion: COMPACT_DEFINITION_VERSION, chainId: ARC_CHAIN_ID,
      range: { kind: 'hour', hourStart, hourEnd: hourStart + HOUR, startUtc: iso(hourStart), endUtc: iso(hourStart + HOUR), firstBlock, lastBlock,
        parentHash: hashOf(firstBlock - 1), firstHash: hashOf(firstBlock), lastHash: hashOf(lastBlock), firstTimestamp: hourStart, lastTimestamp: hourStart + 3599 },
      network: { status: 'available', blockCount: BLOCKS, transactionCount: 100, uniqueSenders: 1, uniqueRecipients: 1, uniqueActiveAddresses: 1,
        gasUsedRaw: '1000', averageTransactionsPerBlock: 1, transactionsPerSecond: 100 / HOUR, internal: { deploymentAttempts: 0 } },
      families, complete: true, activeAddresses: [addressOf(0xad00 + i)],
      registry: { uniswapV3: { through: lastBlock, throughHash: hashOf(lastBlock),
        created: i === 0 ? [v3Created(P.wethUsdc, WETH, USDC, 0), v3Created(P.wethMoon, WETH, MOON, 1), v3Created(P.moonZap, MOON, ZAP, 2)] : [] } },
      ...(projections ? { projections: set } : {}) };
  }
  function buildDatabase(name, count, options = () => ({})) {
    const file = join(workdir, `${name}.sqlite`);
    const db = new DatabaseSync(file);
    const store = createCompactStore(db);
    store.extendRegistry({ kind: V3_POOL_KIND, fromBlock: 1, through: 999, throughHash: hashOf(999), previousThrough: null, created: [] });
    store.extendV4Registry({ kind: 'uniswap_v4_pool', fromBlock: 1, through: 999, throughHash: hashOf(999), previousThrough: null, created: [] });
    for (let i = 0; i < count; i++) store.commitHour(hourResult(i, options(i)));
    return { file, db, store };
  }
  const statusOf = (store, hour) => Object.fromEntries(store.valuationStatus(hour).map((row) => [row.valuation,
    row.status === 'available' ? 'available' : `unavailable(${row.reason})`]));
  const HOUR_V3 = 4_000_000_000n + (WETH_SIDE * WETH_PRICE) / 10n ** 30n; // USDC side of WETH/USDC + the WETH side of WETH/MOON at the WETH price
  const HOUR_V4 = 5_000_000n + 10_000_000n; // native USDC side (5 native USDC) + the hooked pool's USDC side
  let fetchCalls = 0;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => { fetchCalls += 1; throw new Error('no network in this test'); };
  try {
    await test('sqlite: valuation tables are additive in schema 2, with their own definition versions; a changed one is refused', async () => {
      const { db, file } = buildDatabase('schema', 0);
      const meta = new Map(db.prepare('SELECT key, value FROM compact_meta').all().map((row) => [row.key, row.value]));
      assert.equal(meta.get('schema_version'), '2');
      for (const [name, version] of Object.entries(VALUATION_VERSIONS)) assert.equal(meta.get(`valuation_version:${name}`), version);
      assert.ok(meta.get('token_metadata_version'));
      db.exec("UPDATE compact_meta SET value = 'other' WHERE key = 'valuation_version:token_prices'");
      db.close();
      assert.throws(() => createCompactStore(new DatabaseSync(file)), (error) => error.code === 'valuation_definition_mismatch');
    });

    await test('sqlite: an hour\'s token prices and DEX USD volume are derived in its own commit, exactly, from stored rows only', async () => {
      const { db, store } = buildDatabase('derive', 1);
      assert.deepEqual(statusOf(store, BASE), { dex_fees: 'available', dex_usd_volume: 'available', token_prices: 'available' });
      assert.deepEqual(store.tokenPrices(BASE), [{ token: WETH, priceUsdE18: WETH_PRICE.toString(), sourceProtocol: 'uniswap_v3', sourcePool: P.wethUsdc,
        depthUsdMicros: '50000000000', sourceCount: 1 }], 'only WETH has a qualified USDC pool; shallow, hooked and unverified pools set no price');
      assert.equal(WETH_PRICE, (10n ** 30n) / (2n ** 32n), 'WETH = 10^12 / 2^32 USD, independently');
      assert.deepEqual(store.dexVolume(BASE), [
        { protocol: 'uniswap_v3', volumeUsdMicros: HOUR_V3.toString(), valuedSwaps: 14, unvaluedSwaps: 2 },
        { protocol: 'uniswap_v4', volumeUsdMicros: HOUR_V4.toString(), valuedSwaps: 8, unvaluedSwaps: 0 }]);
      // Immutable: replaying the hour changes nothing.
      store.commitHour(hourResult(0));
      assert.deepEqual(store.dexVolume(BASE).map((row) => row.volumeUsdMicros), [HOUR_V3.toString(), HOUR_V4.toString()]);
      db.close();
    });

    await test('sqlite: without price paths an hour that needs a price is not valued; once its paths arrive it is', async () => {
      const { db, store } = buildDatabase('no-paths', 1, () => ({ withPaths: false }));
      assert.deepEqual(statusOf(store, BASE), { dex_fees: 'unavailable(fee_inputs_unavailable)', dex_usd_volume: 'unavailable(prices_unavailable)',
        token_prices: 'unavailable(price_paths_unavailable)' });
      assert.deepEqual(store.dexVolume(BASE), [], 'no partial volume');
      store.commitProjectionHour(BASE, hourResult(0).projections);
      assert.deepEqual(statusOf(store, BASE), { dex_fees: 'available', dex_usd_volume: 'available', token_prices: 'available' });
      assert.equal(store.dexVolume(BASE)[0].volumeUsdMicros, HOUR_V3.toString(), 'the same value a live hour gets');
      db.close();
    });

    await test('sqlite: stored hours from before valuations get them from a bounded pass with no RPC, newest first', async () => {
      const { db, store } = buildDatabase('pass', 6);
      db.exec('DELETE FROM compact_valuation_hours; DELETE FROM compact_token_price_hours; DELETE FROM compact_dex_volume_hours; DELETE FROM compact_dex_fee_hours');
      assert.deepEqual(store.derivePendingValuations({ limit: 4 }).hours, [5, 4, 3, 2].map((i) => BASE + i * HOUR));
      assert.deepEqual(store.derivePendingValuations({ limit: 4 }).hours, [1, 0].map((i) => BASE + i * HOUR));
      assert.deepEqual(store.derivePendingValuations({ limit: 4 }).hours, [], 'nothing left');
      for (let i = 0; i < 6; i++) {
        assert.deepEqual(statusOf(store, BASE + i * HOUR), { dex_fees: 'available', dex_usd_volume: 'available', token_prices: 'available' });
      }
      assert.throws(() => store.derivePendingValuations({ limit: 0 }), (error) => error.code === 'invalid_valuation_limit');
      db.close();
    });

    await test('sqlite: a pool missing from the registry fails the hour\'s valuation closed without blocking the hour', async () => {
      const { db, store } = buildDatabase('registry-gap', 0);
      const hour = hourResult(0);
      hour.registry.uniswapV3.created = hour.registry.uniswapV3.created.filter((pool) => pool.address !== P.moonZap);
      assert.equal(store.commitHour(hour).outcome, 'inserted');
      assert.deepEqual(statusOf(store, BASE), { dex_fees: 'unavailable(pool_registry_missing)', dex_usd_volume: 'unavailable(pool_registry_missing)',
        token_prices: 'unavailable(pool_registry_missing)' });
      assert.equal(store.checkpoint().hourStart, BASE, 'the hour and its checkpoint commit');
      db.close();
    });

    await test('sqlite: token metadata cache: candidates from visible pools only, written once, never replaced', async () => {
      const { db, store } = buildDatabase('metadata', 2);
      const candidates = store.tokensNeedingMetadata({ limit: 10 });
      assert.deepEqual(new Set(candidates), new Set([MOON, ZAP]), 'verified assets and native USDC are never candidates');
      assert.equal(store.tokensNeedingMetadata({ limit: 1 }).length, 1, 'never more than the limit');
      store.recordTokenMetadata([{ token: MOON, verified: true, symbol: 'MOON', name: 'Moon Token', decimals: 18, reason: null },
        { token: ZAP, verified: false, symbol: null, name: null, decimals: null, reason: 'reverted' }], { readBlock: 1234 });
      store.recordTokenMetadata([{ token: MOON, verified: false, symbol: null, name: null, decimals: null, reason: 'reverted' }], { readBlock: 9999 });
      assert.deepEqual(store.tokenMetadata(MOON), { token: MOON, verified: true, symbol: 'MOON', name: 'Moon Token', decimals: 18, reason: null, readBlock: 1234 });
      assert.deepEqual(store.tokensNeedingMetadata({ limit: 10 }), []);
      assert.throws(() => store.recordTokenMetadata([{ token: MOON, verified: false, symbol: 'X', name: null, decimals: null, reason: 'x' }], { readBlock: 1 }),
        (error) => error.code === 'invalid_token_metadata', 'a rejected row never carries a symbol');
      db.close();
    });

    await test('sqlite: the read model serves DEX USD volume, hourly buckets, pool USD volume and contract metadata, read only', async () => {
      const built = buildDatabase('read', 26);
      built.store.recordTokenMetadata([{ token: MOON, verified: true, symbol: 'MOON', name: 'Moon Token', decimals: 18, reason: null }], { readBlock: 1 });
      built.db.close();
      const before = createHash('sha256').update(readFileSync(built.file)).digest('hex');
      const model = createCompactReadModel({ path: built.file, DatabaseSync, now: () => (BASE + 26 * HOUR + 600) * 1000 });
      const summary = model.summary('24h');
      const volume = summary.dex.usdVolume;
      assert.deepEqual([volume.status, volume.totalUsdMicros, volume.byProtocol, volume.valuedSwaps, volume.unvaluedSwaps],
        ['available', (24n * (HOUR_V3 + HOUR_V4)).toString(), { uniswapV3: (24n * HOUR_V3).toString(), uniswapV4: (24n * HOUR_V4).toString() }, 24 * 22, 24 * 2]);
      assert.deepEqual([volume.previous.status, volume.previous.reason], ['unavailable', 'insufficient_coverage'], 'only two earlier hours exist');
      assert.deepEqual(summary.dex.usdPrices.tokens.map((token) => [token.address, token.symbol, token.priceUsdE18]), [[WETH, 'WETH', WETH_PRICE.toString()]]);
      assert.equal(summary.definitions.valuation.pricePolicy.minDepthUsdMicros, PRICE_POLICY.minDepthUsdMicros.toString());
      const series = model.timeseries('24h');
      assert.deepEqual(series.buckets.at(-1).dexUsdVolume, { status: 'available', totalUsdMicros: (HOUR_V3 + HOUR_V4).toString(),
        uniswapV3UsdMicros: HOUR_V3.toString(), uniswapV4UsdMicros: HOUR_V4.toString(), valuedSwaps: 22, unvaluedSwaps: 2 });
      const v3 = model.pools('v3', '24h');
      assert.deepEqual(v3.ranking.usdVolume, { status: 'available', reason: null, reasons: [] });
      const byPool = Object.fromEntries(v3.pools.map((pool) => [pool.pool, pool.usdVolume]));
      assert.deepEqual(byPool[P.wethUsdc], { status: 'available', reason: null, usdMicros: (24n * 4_000_000_000n).toString(), basis: 'usd_anchor' });
      assert.deepEqual(byPool[P.wethMoon], { status: 'available', reason: null, usdMicros: (24n * ((WETH_SIDE * WETH_PRICE) / 10n ** 30n)).toString(),
        basis: 'verified_price' });
      assert.deepEqual(byPool[P.moonZap], { status: 'unavailable', reason: 'no_verified_price', usdMicros: null, basis: null });
      assert.deepEqual(v3.pools.map((pool) => pool.pool), [P.wethUsdc, P.wethMoon, P.moonZap], 'still ranked by swap count');
      const moon = v3.pools.find((pool) => pool.pool === P.moonZap).token0;
      assert.deepEqual(moon, { address: MOON, symbol: null, decimals: null, verified: false, native: false,
        contractMetadata: { symbol: 'MOON', name: 'Moon Token', decimals: 18 } }, 'contract metadata beside, never instead of, the verified identity');
      assert.equal(v3.pools[0].token0.contractMetadata, null, 'a verified asset never carries contract metadata');
      const v4 = model.pools('v4', '24h');
      assert.deepEqual(v4.pools.map((pool) => [pool.pool, pool.usdVolume.usdMicros]), [[V4.nativeEurc, (24n * 5_000_000n).toString()],
        [V4.usdcMoon, (24n * 10_000_000n).toString()]]);
      model.close();
      assert.equal(createHash('sha256').update(readFileSync(built.file)).digest('hex'), before, 'reading never changes the file');
      assert.equal(fetchCalls, 0, 'no network from the read model');
    });

    await test('sqlite: a window with an unvalued hour is unavailable with its reason, never a partial total', async () => {
      const built = buildDatabase('gap', 26, (i) => ({ withPaths: i !== 20 }));
      built.db.close();
      const model = createCompactReadModel({ path: built.file, DatabaseSync, now: () => (BASE + 26 * HOUR + 600) * 1000 });
      const volume = model.summary('24h').dex.usdVolume;
      assert.deepEqual([volume.status, volume.reason, volume.reasons, volume.unavailableHours, volume.totalUsdMicros],
        ['unavailable', 'valuation_hour_unavailable', ['prices_unavailable'], [iso(BASE + 20 * HOUR)], null]);
      const bucket = model.timeseries('24h').buckets.find((entry) => entry.start === iso(BASE + 20 * HOUR));
      assert.deepEqual(bucket.dexUsdVolume, { status: 'unavailable', reason: 'prices_unavailable' });
      const v3 = model.pools('v3', '24h');
      assert.deepEqual([v3.status, v3.ranking.usdVolume.status, v3.pools[0].usdVolume.status], ['available', 'unavailable', 'unavailable'],
        'pools keep their swap ranking; their USD volume waits for every hour');
      model.close();
    });
  } finally {
    globalThis.fetch = realFetch;
    rmSync(workdir, { recursive: true, force: true });
  }
}

console.log(`ARC_INTELLIGENCE_PRICING: PASS (${passed} deterministic scenarios on Node ${process.version}; offline only, no network; `
  + `node:sqlite ${sqlite ? 'tested' : 'deferred'})`);
