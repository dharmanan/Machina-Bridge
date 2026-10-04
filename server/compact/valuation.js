// Compact engine: on-chain USD valuation of Uniswap swap flows. Pure functions only: no RPC, no SQLite, no clock. The
// store derives an hour's token prices and DEX USD volume from data it already holds (pool-hour flows, the pool price
// paths of projections.js and the pool registry), in the same transaction as the projections they come from, and the
// read model only sums stored results. Nothing here is a family, and nothing here is ever fetched from a price service.
//
// USD anchor: the canonical Arc USDC ERC-20 interface (6 decimals) and, in Uniswap V4 pools, currency 0x0, Arc's native
// USDC (18 decimals). 1 USDC = 1 USD by definition; no other token is assumed to be worth anything.
//
// Token prices (USD per whole token, 18-decimal fixed point, floor) exist only for the other verified Arc assets, and only
// from a verified USDC pool of the same hour: an official Uniswap V3 pool, or a Uniswap V4 pool without hooks (a hooked pool
// may trade outside its own curve, so its price is never used). A pool is a price source only when its price path
// (block-weighted mean of the pool's square-root price, projections.js) has at least PRICE_POLICY.minSwaps swaps, covers at
// least half of the hour's blocks, and keeps a block-weighted mean anchor-side virtual reserve of at least
// PRICE_POLICY.minDepthUsdMicros. A single swap, a short path or a shallow pool never sets a price. Among qualified sources
// the deepest one sets the price, and every other qualified source must agree within PRICE_POLICY.maxDivergenceBps;
// otherwise the token has no price for the hour. A token without a price is never valued, never zero.
//
// Volume: every swap is valued once, by one side of the pool. The USD anchor side when the pool has one (token0 when
// both sides are anchors), otherwise the side with a verified hourly price (the mean of both when both have one). A side is
// the pool's directional raw flows summed (paid in plus paid out), so a swap is never counted from both of its sides.
// Pools with neither an anchor nor a priced side are not valued; their swaps are reported as unvalued.
//
// Swap fees: the fee a swap pays to its pool (LP fee, including any protocol share), charged on the input amount: fee pips
// of 1,000,000. Uniswap V3 charges the pool's fee tier (its protocol fee is a share of that tier, never added on top). Uniswap V4
// records the fee it applied (protocol plus LP) in every Swap event (projections.js uniswap_v4_swap_fees). Per token side the
// fee is that token's input times the fee, plus, for swaps where the token was paid out, the input-side fee converted at the
// swap's execution rate: out * fee / (1,000,000 - fee). These are estimates: hourly flows do not retain the per-step
// integer rounding of the executed swap. The fee is valued with the same side rule as volume. A V4 pool whose hook may
// return swap deltas (hook address flags) can charge outside the pool fee, so its fees are
// never valued; fees a hook takes are never part of these numbers.
import { ARC_ASSETS_BY_ADDRESS, ARC_VERIFIED_ASSETS } from '../../api/_lib/arc-intelligence/assets.js';

export const VALUATION_VERSIONS = Object.freeze({
  token_prices: 'usdc-anchor-pool-twap-v1',
  dex_usd_volume: 'one-side-usd-swap-volume-v1',
  dex_fees: 'input-side-estimated-swap-fees-v1',
});
export const VALUATIONS = Object.freeze(Object.keys(VALUATION_VERSIONS));
export const VALUATION_REASONS = Object.freeze(['price_paths_unavailable', 'pool_projections_unavailable', 'prices_unavailable',
  'pool_registry_missing', 'valuation_error', 'fee_inputs_unavailable']);

export const PRICE_POLICY = Object.freeze({
  minSwaps: 3,
  minCoverageBps: 5000,
  minDepthUsdMicros: 25_000_000_000n, // 25,000 USD
  maxDivergenceBps: 500,
});

export const ZERO_ADDRESS = `0x${'0'.repeat(40)}`;
const USDC = ARC_ASSETS_BY_ADDRESS.get('0x3600000000000000000000000000000000000000');
const ANCHOR_DECIMALS = new Map([[USDC.address, USDC.interfaces.erc20Decimals], [ZERO_ADDRESS, USDC.interfaces.nativeDecimals]]);
// Verified Arc assets that can receive a price (every verified asset except the USDC anchor itself).
const PRICEABLE_DECIMALS = new Map(ARC_VERIFIED_ASSETS.filter((asset) => asset.address !== USDC.address)
  .map((asset) => [asset.address, asset.decimals]));

export const anchorDecimals = (token) => ANCHOR_DECIMALS.get(token) ?? null;
export const priceableDecimals = (token) => PRICEABLE_DECIMALS.get(token) ?? null;
export const PRICEABLE_TOKENS = Object.freeze([...PRICEABLE_DECIMALS.keys()]);

// Uniswap's valid square-root price range (TickMath MIN_SQRT_RATIO / MAX_SQRT_RATIO, the same in V3 and V4).
export const MIN_SQRT_PRICE_X96 = 4295128739n;
export const MAX_SQRT_PRICE_X96 = 1461446703485210103287273052203988822378723970342n;
const Q96 = 2n ** 96n;
const Q192 = 2n ** 192n;
const MICROS = 10n ** 6n;
const E18 = 10n ** 18n;
const DIGITS = /^\d+$/;

export class ValuationError extends Error {
  constructor(code) { super(code); this.code = code; }
}

const pow10 = (exponent) => 10n ** BigInt(exponent);
export const validSqrtPrice = (value) => value >= MIN_SQRT_PRICE_X96 && value <= MAX_SQRT_PRICE_X96;

// End-of-block pool state as the price path accumulates it: the square-root price and the two virtual reserves of the
// in-range liquidity at that price (x = L * 2^96 / sqrtP, y = L * sqrtP / 2^96, floor). Throws on an invalid price.
export function blockState(sqrtPriceX96, liquidity) {
  if (!validSqrtPrice(sqrtPriceX96) || liquidity < 0n) throw new ValuationError('invalid_pool_state');
  return { sqrtPrice: sqrtPriceX96, reserve0: (liquidity * Q96) / sqrtPriceX96, reserve1: (liquidity * sqrtPriceX96) / Q96 };
}

// USD per whole target token (18-decimal fixed point, floor) from a block-weighted mean square-root price.
// anchorSide: 0 when token0 is the anchor (the target is token1), 1 when token1 is.
export function priceFromSqrt(meanSqrtPrice, { anchorSide, anchorDecimals: anchor, targetDecimals }) {
  const square = meanSqrtPrice * meanSqrtPrice;
  const numerator = pow10(targetDecimals) * E18;
  return anchorSide === 1 ? (square * numerator) / (Q192 * pow10(anchor)) : (Q192 * numerator) / (square * pow10(anchor));
}

// The anchor and priced sides of a pool, or null when the pool is not a USDC/verified-asset pair.
function priceSourceSides(token0, token1) {
  if (anchorDecimals(token0) !== null && priceableDecimals(token1) !== null) return { anchorSide: 0, target: token1 };
  if (anchorDecimals(token1) !== null && priceableDecimals(token0) !== null) return { anchorSide: 1, target: token0 };
  return null;
}

// One price-path row checked against the policy. Returns { qualified: true, priceUsdE18, depthUsdMicros, ... } or
// { qualified: false, reason }.
export function evaluateSource({ row, protocol, token0, token1, hooks, hourBlocks, policy = PRICE_POLICY }) {
  const sides = priceSourceSides(token0, token1);
  if (!sides) return { qualified: false, reason: 'not_a_usdc_pair' };
  if (protocol === 'uniswap_v4' && hooks !== ZERO_ADDRESS) return { qualified: false, reason: 'hooked_pool' };
  if (row.swapCount < policy.minSwaps) return { qualified: false, reason: 'too_few_swaps' };
  if (!Number.isSafeInteger(hourBlocks) || hourBlocks < 1 || row.pricedBlocks < 1 || row.pricedBlocks > hourBlocks) {
    return { qualified: false, reason: 'invalid_price_path' };
  }
  if (BigInt(row.pricedBlocks) * 10_000n < BigInt(hourBlocks) * BigInt(policy.minCoverageBps)) return { qualified: false, reason: 'short_price_path' };
  const blocks = BigInt(row.pricedBlocks);
  const meanSqrtPrice = BigInt(row.sqrtPriceBlockSum) / blocks;
  if (!validSqrtPrice(meanSqrtPrice)) return { qualified: false, reason: 'invalid_price_path' };
  const anchor = anchorDecimals(sides.anchorSide === 0 ? token0 : token1);
  const reserve = BigInt(sides.anchorSide === 0 ? row.reserve0BlockSum : row.reserve1BlockSum) / blocks;
  const depthUsdMicros = (reserve * MICROS) / pow10(anchor);
  if (depthUsdMicros < policy.minDepthUsdMicros) return { qualified: false, reason: 'shallow_pool' };
  const priceUsdE18 = priceFromSqrt(meanSqrtPrice, { anchorSide: sides.anchorSide, anchorDecimals: anchor, targetDecimals: priceableDecimals(sides.target) });
  if (priceUsdE18 <= 0n) return { qualified: false, reason: 'price_below_precision' };
  return { qualified: true, token: sides.target, protocol, pool: row.pool, priceUsdE18, depthUsdMicros, swapCount: row.swapCount };
}

const sourceOrder = (left, right) => (left.depthUsdMicros > right.depthUsdMicros ? -1 : left.depthUsdMicros < right.depthUsdMicros ? 1
  : left.protocol < right.protocol ? -1 : left.protocol > right.protocol ? 1 : left.pool < right.pool ? -1 : left.pool > right.pool ? 1 : 0);

// Token prices of one hour. pricePaths: { uniswap_v3: rows, uniswap_v4: rows } (price-path rows of the hour). poolOf(protocol,
// pool) -> { token0, token1, hooks } from the pool registry; a missing pool throws (fail closed). hourBlocks: the hour's
// block count. Returns { prices: Map token -> { priceUsdE18, protocol, pool, depthUsdMicros, sources }, rejected: Map
// token -> reason } (rejected: a token that had a qualified source but whose sources disagree).
export function tokenPricesOf({ pricePaths, poolOf, hourBlocks, policy = PRICE_POLICY }) {
  const candidates = new Map();
  for (const protocol of ['uniswap_v3', 'uniswap_v4']) {
    for (const row of pricePaths[protocol] ?? []) {
      const meta = poolOf(protocol, row.pool);
      if (!meta) throw new ValuationError('pool_registry_missing');
      const source = evaluateSource({ row, protocol, token0: meta.token0, token1: meta.token1, hooks: meta.hooks, hourBlocks, policy });
      if (!source.qualified) continue;
      if (!candidates.has(source.token)) candidates.set(source.token, []);
      candidates.get(source.token).push(source);
    }
  }
  const prices = new Map();
  const rejected = new Map();
  for (const token of [...candidates.keys()].sort()) {
    const sources = candidates.get(token).sort(sourceOrder);
    const [best] = sources;
    const limit = best.priceUsdE18 * BigInt(policy.maxDivergenceBps);
    const disagree = sources.some((source) => {
      const difference = source.priceUsdE18 > best.priceUsdE18 ? source.priceUsdE18 - best.priceUsdE18 : best.priceUsdE18 - source.priceUsdE18;
      return difference * 10_000n > limit;
    });
    if (disagree) rejected.set(token, 'sources_disagree');
    else prices.set(token, { priceUsdE18: best.priceUsdE18, protocol: best.protocol, pool: best.pool, depthUsdMicros: best.depthUsdMicros, sources: sources.length });
  }
  return { prices, rejected };
}

// USD value (micro-USD, floor) of a raw amount of one token: anchors by their decimals, priced verified assets by their hourly
// price; null for any other token (or a verified asset without a price).
export function usdMicrosOf(token, raw, prices) {
  const anchor = anchorDecimals(token);
  if (anchor !== null) return (raw * MICROS) / pow10(anchor);
  const decimals = priceableDecimals(token);
  const price = prices?.get(token);
  if (decimals === null || !price) return null;
  return (raw * price.priceUsdE18) / pow10(decimals + 12);
}

// Whether a pool's swaps can only be valued with a token price (no anchor side, at least one verified asset side).
export const needsPrice = (token0, token1) => anchorDecimals(token0) === null && anchorDecimals(token1) === null
  && (priceableDecimals(token0) !== null || priceableDecimals(token1) !== null);

// USD volume of one pool's swaps from its directional raw flows. side0Raw / side1Raw: in + out of each token (BigInt).
// Returns { usdMicros, basis: 'usd_anchor' | 'verified_price' } or null when the pool cannot be valued.
export function poolVolumeUsd({ token0, token1, side0Raw, side1Raw }, prices) {
  if (anchorDecimals(token0) !== null) return { usdMicros: usdMicrosOf(token0, side0Raw, null), basis: 'usd_anchor' };
  if (anchorDecimals(token1) !== null) return { usdMicros: usdMicrosOf(token1, side1Raw, null), basis: 'usd_anchor' };
  const value0 = usdMicrosOf(token0, side0Raw, prices);
  const value1 = usdMicrosOf(token1, side1Raw, prices);
  if (value0 !== null && value1 !== null) return { usdMicros: (value0 + value1) / 2n, basis: 'verified_price' };
  if (value0 !== null) return { usdMicros: value0, basis: 'verified_price' };
  if (value1 !== null) return { usdMicros: value1, basis: 'verified_price' };
  return null;
}

const rawSum = (left, right) => {
  if (typeof left !== 'string' || typeof right !== 'string' || !DIGITS.test(left) || !DIGITS.test(right)) throw new ValuationError('malformed_flow');
  return BigInt(left) + BigInt(right);
};

// DEX USD volume of one hour. poolRows: { uniswap_v3: rows, uniswap_v4: rows } (pool-hour rows with raw flows). prices: a
// tokenPricesOf map, or null when the hour's price paths are unavailable. Returns { needsPrices, totals } where totals[protocol]
// = { usdMicros, valuedSwaps, unvaluedSwaps }. needsPrices: prices were null and some pool could only be valued with one, so
// the hour cannot be valued (the caller stores it unavailable; nothing is guessed).
export function hourVolumeOf({ poolRows, poolOf, prices }) {
  const totals = {};
  let needsPrices = false;
  for (const protocol of ['uniswap_v3', 'uniswap_v4']) {
    const total = { usdMicros: 0n, valuedSwaps: 0, unvaluedSwaps: 0 };
    for (const row of poolRows[protocol] ?? []) {
      if (!row.swapCount) continue;
      const meta = poolOf(protocol, row.pool);
      if (!meta) throw new ValuationError('pool_registry_missing');
      if (prices === null && needsPrice(meta.token0, meta.token1)) needsPrices = true;
      const value = poolVolumeUsd({ token0: meta.token0, token1: meta.token1, side0Raw: rawSum(row.token0InRaw, row.token0OutRaw),
        side1Raw: rawSum(row.token1InRaw, row.token1OutRaw) }, prices);
      if (value) {
        total.usdMicros += value.usdMicros;
        total.valuedSwaps += row.swapCount;
      } else total.unvaluedSwaps += row.swapCount;
    }
    totals[protocol] = total;
  }
  return { needsPrices, totals };
}

// ---------------------------------------------------------------------------------------------------------------------
// Swap fees.

export const FEE_PIPS = 1_000_000n;
const E12 = 10n ** 12n;
// Hook permission bits are encoded in the hook address: BEFORE_SWAP_RETURNS_DELTA (1 << 3) and AFTER_SWAP_RETURNS_DELTA (1 << 2).
export const HOOK_SWAP_DELTA_FLAGS = 0b1100n;
export const hookCanTakeSwapDeltas = (hooks) => typeof hooks === 'string' && hooks !== ZERO_ADDRESS && (BigInt(hooks) & HOOK_SWAP_DELTA_FLAGS) !== 0n;

// The output-side term of one fee: out * fee / (1e6 - fee), scaled by 1e12 (floor). Throws on an impossible fee.
export function outFeeE12(outRaw, fee) {
  if (fee < 0n || fee > FEE_PIPS || (fee === FEE_PIPS && outRaw > 0n)) throw new ValuationError('swap_fee_invalid');
  return outRaw === 0n ? 0n : (outRaw * fee * E12) / (FEE_PIPS - fee);
}

// One token side's fee, in that token's raw units scaled by 1e12, for a static fee (Uniswap V3 fee tier).
export function staticSideFeeE12({ inRaw, outRaw, fee }) {
  return inRaw * fee * MICROS + outFeeE12(outRaw, fee);
}

// USD value (micro-USD, floor) of one pool's fee sides (raw units x 1e12), by the volume side rule; null when not valuable.
export function poolFeeUsd({ token0, token1, side0E12, side1E12 }, prices) {
  const value = poolVolumeUsd({ token0, token1, side0Raw: side0E12, side1Raw: side1E12 }, prices);
  return value && { usdMicros: value.usdMicros / E12, basis: value.basis };
}

const raw = (value) => {
  if (typeof value !== 'string' || !DIGITS.test(value)) throw new ValuationError('malformed_flow');
  return BigInt(value);
};

// Swap fees of one hour. poolRows.uniswap_v3: V3 pool-hour rows (flows); feeRows.uniswap_v4: V4 swap-fee rows
// (projections.js). poolOf(protocol, pool) -> { token0, token1, hooks, fee }. Returns { needsPrices, totals } where
// totals[protocol] = { feeUsdMicros, valuedSwaps, unvaluedSwaps }; the same price rule as hourVolumeOf.
export function hourFeesOf({ poolRows, feeRows, poolOf, prices }) {
  let needsPrices = false;
  const totals = { uniswap_v3: { feeUsdMicros: 0n, valuedSwaps: 0, unvaluedSwaps: 0 }, uniswap_v4: { feeUsdMicros: 0n, valuedSwaps: 0, unvaluedSwaps: 0 } };
  const add = (protocol, meta, swapCount, sides) => {
    if (!sides) {
      totals[protocol].unvaluedSwaps += swapCount; // never valuable, whatever the prices
      return;
    }
    if (prices === null && needsPrice(meta.token0, meta.token1)) needsPrices = true;
    const value = poolFeeUsd({ token0: meta.token0, token1: meta.token1, side0E12: sides[0], side1E12: sides[1] }, prices);
    if (value) {
      totals[protocol].feeUsdMicros += value.usdMicros;
      totals[protocol].valuedSwaps += swapCount;
    } else totals[protocol].unvaluedSwaps += swapCount;
  };
  for (const row of poolRows.uniswap_v3 ?? []) {
    if (!row.swapCount) continue;
    const meta = poolOf('uniswap_v3', row.pool);
    if (!meta || !Number.isSafeInteger(meta.fee)) throw new ValuationError('pool_registry_missing');
    const fee = BigInt(meta.fee);
    add('uniswap_v3', meta, row.swapCount, [staticSideFeeE12({ inRaw: raw(row.token0InRaw), outRaw: raw(row.token0OutRaw), fee }),
      staticSideFeeE12({ inRaw: raw(row.token1InRaw), outRaw: raw(row.token1OutRaw), fee })]);
  }
  for (const row of feeRows.uniswap_v4 ?? []) {
    const meta = poolOf('uniswap_v4', row.pool);
    if (!meta) throw new ValuationError('pool_registry_missing');
    add('uniswap_v4', meta, row.swapCount, hookCanTakeSwapDeltas(meta.hooks) ? null
      : [raw(row.feeIn0E6) * MICROS + raw(row.feeOut0E12), raw(row.feeIn1E6) * MICROS + raw(row.feeOut1E12)]);
  }
  return { needsPrices, totals };
}

// Decimal text of a micro-USD amount (exact, no floating point), e.g. 1234567n -> "1.234567".
export function microsToDecimal(micros) {
  const value = BigInt(micros);
  const whole = value / MICROS;
  return `${whole}.${(value % MICROS).toString().padStart(6, '0')}`;
}
