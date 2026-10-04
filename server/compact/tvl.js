// Compact engine: pool liquidity (value held in the pool, TVL style) of the top pools, read from pool state at the hour's
// last block with eth_call on the public Arc RPC, collected once per hour by the hourly runner (never on a dashboard
// request) and stored as one compact row per pool (store.js compact_pool_tvl_hours). Never derived from add or remove
// activity, swap flows or in-range liquidity units.
// - Uniswap V3: each pool is its own contract, so the tokens it holds are exactly token.balanceOf(pool) for both tokens
//   (positions plus uncollected fees and protocol fees: what the pool contract holds).
// - Uniswap V4: one PoolManager holds every pool's tokens together, so a pool's own reserves are derived from its state
//   (PoolManager.extsload, the v4-core StateLibrary layout): slot0 (price, tick), the in-range liquidity, the tick bitmap and
//   every initialized tick's liquidityNet. Sweeping the ticks gives each range's liquidity, and the token amounts of every
//   range follow from the exact SqrtPriceMath formulas (rounded down). The sweep must reproduce the stored in-range liquidity
//   exactly, or the pool is unavailable (tvl_state_inconsistent). Aggregating tick ranges omits per-position rounding,
//   so these are estimated principal reserves, not exact PoolManager holdings. The scan is bounded (MAX_BITMAP_WORDS, MAX_INITIALIZED_TICKS).
//   A hook that may hold value outside the pool's own accounting (liquidity deltas, or a beforeSwap that returns deltas:
//   hook address flags, including afterSwap return deltas) makes the pool unavailable (hook_may_hold_pool_value). Uncollected V4 fees are not reserves and
//   are not included.
// The USD value needs every token side with a non-zero amount to be USDC or a verified asset with a price of that hour;
// otherwise the pool's liquidity is unavailable (no_verified_price), never partial and never zero.
import { keccak256 } from './keccak.js';
import { usdMicrosOf } from './valuation.js';

export const TVL_VERSION = 'pool-balances-and-estimated-v4-principal-at-hour-end-v1';
export const TVL_POOLS_PER_PROTOCOL = 10;
export const MAX_BITMAP_WORDS = 1024;
export const MAX_INITIALIZED_TICKS = 1024;
export const TVL_REASONS = Object.freeze(['hook_may_hold_pool_value', 'tvl_scan_unbounded', 'tvl_state_inconsistent', 'balance_unreadable',
  'pool_not_initialized']);
export const MIN_TICK = -887272;
export const MAX_TICK = 887272;
const SELECTORS = Object.freeze({ balanceOf: '0x70a08231', extsloadMany: '0xdbd035ff' });
const POOLS_SLOT = 6n;
const LIQUIDITY_OFFSET = 3n;
const TICKS_OFFSET = 4n;
const TICK_BITMAP_OFFSET = 5n;
const Q96 = 2n ** 96n;
const UINT256_MAX = 2n ** 256n - 1n;
const MASK_128 = 2n ** 128n - 1n;
const MASK_160 = 2n ** 160n - 1n;
const BATCH = 50;

export class TvlError extends Error {
  constructor(code) { super(code); this.code = code; }
}

// Hook permission bits in the hook address: AFTER_REMOVE_LIQUIDITY_RETURNS_DELTA (1 << 0), AFTER_ADD_LIQUIDITY_RETURNS_DELTA
// (1 << 1), BEFORE_SWAP_RETURNS_DELTA (1 << 3) and AFTER_SWAP_RETURNS_DELTA (1 << 2) can move value outside pool reserves.
export const hookMayHoldPoolValue = (hooks) => typeof hooks === 'string' && (BigInt(hooks) & 0b1111n) !== 0n;

// TickMath.getSqrtPriceAtTick (Uniswap V3/V4), exact.
const TICK_FACTORS = [
  [0x2n, 0xfff97272373d413259a46990580e213an], [0x4n, 0xfff2e50f5f656932ef12357cf3c7fdccn], [0x8n, 0xffe5caca7e10e4e61c3624eaa0941cd0n],
  [0x10n, 0xffcb9843d60f6159c9db58835c926644n], [0x20n, 0xff973b41fa98c081472e6896dfb254c0n], [0x40n, 0xff2ea16466c96a3843ec78b326b52861n],
  [0x80n, 0xfe5dee046a99a2a811c461f1969c3053n], [0x100n, 0xfcbe86c7900a88aedcffc83b479aa3a4n], [0x200n, 0xf987a7253ac413176f2b074cf7815e54n],
  [0x400n, 0xf3392b0822b70005940c7a398e4b70f3n], [0x800n, 0xe7159475a2c29b7443b29c7fa6e889d9n], [0x1000n, 0xd097f3bdfd2022b8845ad8f792aa5825n],
  [0x2000n, 0xa9f746462d870fdf8a65dc1f90e061e5n], [0x4000n, 0x70d869a156d2a1b890bb3df62baf32f7n], [0x8000n, 0x31be135f97d08fd981231505542fcfa6n],
  [0x10000n, 0x9aa508b5b7a84e1c677de54f3e99bc9n], [0x20000n, 0x5d6af8dedb81196699c329225ee604n], [0x40000n, 0x2216e584f5fa1ea926041bedfe98n],
  [0x80000n, 0x48a170391f7dc42444e8fa2n],
];
export function sqrtPriceAtTick(tick) {
  if (!Number.isSafeInteger(tick) || tick < MIN_TICK || tick > MAX_TICK) throw new TvlError('tick_out_of_range');
  const absTick = BigInt(Math.abs(tick));
  let ratio = (absTick & 0x1n) !== 0n ? 0xfffcb933bd6fad37aa2d162d1a594001n : 0x100000000000000000000000000000000n;
  for (const [bit, factor] of TICK_FACTORS) if ((absTick & bit) !== 0n) ratio = (ratio * factor) >> 128n;
  if (tick > 0) ratio = UINT256_MAX / ratio;
  return (ratio >> 32n) + (ratio % (1n << 32n) === 0n ? 0n : 1n);
}

// SqrtPriceMath, rounded down: token amounts of `liquidity` between two square-root prices (a < b).
export const amount0Delta = (sqrtA, sqrtB, liquidity) => ((liquidity << 96n) * (sqrtB - sqrtA) / sqrtB) / sqrtA;
export const amount1Delta = (sqrtA, sqrtB, liquidity) => (liquidity * (sqrtB - sqrtA)) / Q96;

// A V4 pool's reserves from its state. ticks: [tick, liquidityNet] of every initialized tick, ascending. Throws
// TvlError('tvl_state_inconsistent') unless the sweep is well formed and reproduces the stored in-range liquidity exactly.
export function v4Reserves({ sqrtPriceX96, tick, liquidity, ticks }) {
  if (typeof sqrtPriceX96 !== 'bigint' || sqrtPriceX96 <= 0n || typeof liquidity !== 'bigint' || liquidity < 0n
    || !Number.isSafeInteger(tick) || tick < MIN_TICK || tick > MAX_TICK || !Array.isArray(ticks)
    || ticks.some(([at, net]) => !Number.isSafeInteger(at) || at < MIN_TICK || at > MAX_TICK || typeof net !== 'bigint')) {
    throw new TvlError('tvl_state_inconsistent');
  }
  let active = 0n;
  let amount0 = 0n;
  let amount1 = 0n;
  let current = 0n;
  for (let index = 0; index < ticks.length; index++) {
    const [lower, net] = ticks[index];
    if (index > 0 && lower <= ticks[index - 1][0]) throw new TvlError('tvl_state_inconsistent');
    active += net;
    if (active < 0n) throw new TvlError('tvl_state_inconsistent');
    const upper = ticks[index + 1]?.[0];
    if (upper === undefined) {
      if (active !== 0n) throw new TvlError('tvl_state_inconsistent');
      break;
    }
    if (active === 0n) continue;
    const sqrtA = sqrtPriceAtTick(lower);
    const sqrtB = sqrtPriceAtTick(upper);
    if (tick < lower) amount0 += amount0Delta(sqrtA, sqrtB, active);
    else if (tick >= upper) amount1 += amount1Delta(sqrtA, sqrtB, active);
    else {
      if (sqrtPriceX96 < sqrtA || sqrtPriceX96 > sqrtB) throw new TvlError('tvl_state_inconsistent');
      amount0 += amount0Delta(sqrtPriceX96, sqrtB, active);
      amount1 += amount1Delta(sqrtA, sqrtPriceX96, active);
      current = active;
    }
  }
  if (current !== liquidity) throw new TvlError('tvl_state_inconsistent');
  return { amount0, amount1 };
}

// ---------------------------------------------------------------------------------------------------------------------
// V4 storage slots (v4-core StateLibrary).

const word = (value) => BigInt.asUintN(256, BigInt(value)).toString(16).padStart(64, '0');
const bytesOf = (hex) => Uint8Array.from(hex.match(/../g).map((byte) => Number.parseInt(byte, 16)));
const slotOf = (keyHex, mapSlot) => BigInt(keccak256(bytesOf(`${keyHex}${word(mapSlot)}`)));
export const v4StateSlot = (poolId) => slotOf(poolId.slice(2), POOLS_SLOT);
export const v4BitmapSlot = (state, wordPosition) => slotOf(word(wordPosition), state + TICK_BITMAP_OFFSET);
export const v4TickSlot = (state, tick) => slotOf(word(tick), state + TICKS_OFFSET);

// Bitmap words covering every usable tick of a tick spacing (compressed ticks, 256 per word, floor division).
export function bitmapWords(tickSpacing) {
  if (!Number.isSafeInteger(tickSpacing) || tickSpacing < 1) throw new TvlError('tvl_state_inconsistent');
  const compress = (tick) => Math.floor(tick / tickSpacing);
  return [Math.floor(compress(MIN_TICK) / 256), Math.floor(compress(MAX_TICK) / 256)];
}
export function initializedTicks(words, tickSpacing) {
  const ticks = [];
  for (const [position, value] of [...words].sort(([left], [right]) => left - right)) {
    for (let bit = 0; bit < 256; bit++) if ((value >> BigInt(bit)) & 1n) ticks.push((position * 256 + bit) * tickSpacing);
  }
  return ticks;
}
const decodeSlot0 = (value) => {
  let tick = Number((value >> 160n) & 0xffffffn);
  if (tick >= 0x800000) tick -= 0x1000000;
  return { sqrtPriceX96: value & MASK_160, tick };
};
const decodeTickNet = (value) => BigInt.asIntN(128, value >> 128n);

function extsloadCall(poolManager, slots, blockTag) {
  return ['eth_call', [{ to: poolManager, data: `${SELECTORS.extsloadMany}${word(32)}${word(slots.length)}${slots.map(word).join('')}` }, blockTag]];
}
function decodeWords(result, count) {
  if (typeof result !== 'string' || !/^0x[0-9a-fA-F]*$/.test(result) || result.length !== 2 + 64 * (2 + count)) throw new TvlError('tvl_state_inconsistent');
  const body = result.slice(2);
  if (BigInt(`0x${body.slice(0, 64)}`) !== 32n || BigInt(`0x${body.slice(64, 128)}`) !== BigInt(count)) throw new TvlError('tvl_state_inconsistent');
  return Array.from({ length: count }, (_, index) => BigInt(`0x${body.slice(128 + index * 64, 192 + index * 64)}`));
}

// Batched eth_calls, at most 50 per request. PoolManager reads: any item error fails the collection (a public RPC limit is
// not a pool fact). Token balance reads keep item errors (a token whose balanceOf reverts makes only its pool unavailable).
async function calls(provider, list, { allowItemErrors = false } = {}) {
  const out = [];
  for (let offset = 0; offset < list.length; offset += BATCH) out.push(...await provider.batch(list.slice(offset, offset + BATCH), { allowItemErrors }));
  return out;
}

// V4 reserves of the given pools at blockTag. pools: [{ pool: poolId, tickSpacing, hooks }]. Returns Map pool -> result
// ({ status: 'available', amount0, amount1 } | { status: 'unavailable', reason }). At most three batched rounds.
export async function readV4Reserves(provider, pools, { poolManager, blockTag }) {
  const out = new Map();
  const live = [];
  for (const pool of pools) {
    if (hookMayHoldPoolValue(pool.hooks)) out.set(pool.pool, { status: 'unavailable', reason: 'hook_may_hold_pool_value' });
    else {
      const [from, to] = bitmapWords(pool.tickSpacing);
      if (to - from + 1 > MAX_BITMAP_WORDS) out.set(pool.pool, { status: 'unavailable', reason: 'tvl_scan_unbounded' });
      else live.push({ ...pool, state: v4StateSlot(pool.pool), words: [from, to] });
    }
  }
  if (!live.length) return out;
  const heads = await calls(provider, live.map((pool) => extsloadCall(poolManager, [pool.state, pool.state + LIQUIDITY_OFFSET], blockTag)));
  const scanning = [];
  live.forEach((pool, index) => {
    try {
      const [slot0, liquidity] = decodeWords(heads[index], 2);
      const head = decodeSlot0(slot0);
      if (head.sqrtPriceX96 === 0n) out.set(pool.pool, { status: 'unavailable', reason: 'pool_not_initialized' });
      else scanning.push({ ...pool, ...head, liquidity: liquidity & MASK_128 });
    } catch (error) {
      out.set(pool.pool, { status: 'unavailable', reason: error.code ?? 'tvl_state_inconsistent' });
    }
  });
  const bitmaps = await calls(provider, scanning.map((pool) => {
    const positions = [];
    for (let position = pool.words[0]; position <= pool.words[1]; position++) positions.push(position);
    pool.positions = positions;
    return extsloadCall(poolManager, positions.map((position) => v4BitmapSlot(pool.state, position)), blockTag);
  }));
  const ticking = [];
  scanning.forEach((pool, index) => {
    try {
      const values = decodeWords(bitmaps[index], pool.positions.length);
      const ticks = initializedTicks(new Map(pool.positions.map((position, at) => [position, values[at]])), pool.tickSpacing);
      if (ticks.length > MAX_INITIALIZED_TICKS) out.set(pool.pool, { status: 'unavailable', reason: 'tvl_scan_unbounded' });
      else ticking.push({ ...pool, ticks });
    } catch (error) {
      out.set(pool.pool, { status: 'unavailable', reason: error.code ?? 'tvl_state_inconsistent' });
    }
  });
  const tickInfo = await calls(provider, ticking.filter((pool) => pool.ticks.length)
    .map((pool) => extsloadCall(poolManager, pool.ticks.map((tick) => v4TickSlot(pool.state, tick)), blockTag)));
  let cursor = 0;
  for (const pool of ticking) {
    try {
      const nets = pool.ticks.length ? decodeWords(tickInfo[cursor++], pool.ticks.length).map(decodeTickNet) : [];
      const reserves = v4Reserves({ sqrtPriceX96: pool.sqrtPriceX96, tick: pool.tick, liquidity: pool.liquidity,
        ticks: pool.ticks.map((tick, index) => [tick, nets[index]]) });
      out.set(pool.pool, { status: 'available', ...reserves });
    } catch (error) {
      out.set(pool.pool, { status: 'unavailable', reason: error.code ?? 'tvl_state_inconsistent' });
    }
  }
  return out;
}

// V3 balances of the given pools at blockTag: token.balanceOf(pool) for both tokens, one batched round per 25 pools.
export async function readV3Balances(provider, pools, { blockTag }) {
  const list = pools.flatMap((pool) => [pool.token0, pool.token1].map((token) => ['eth_call', [{ to: token,
    data: `${SELECTORS.balanceOf}${word(BigInt(pool.pool))}` }, blockTag]]));
  const answers = await calls(provider, list, { allowItemErrors: true });
  return new Map(pools.map((pool, index) => {
    const [a, b] = [answers[index * 2]?.result, answers[index * 2 + 1]?.result];
    const valid = (value) => typeof value === 'string' && /^0x[0-9a-fA-F]{64}$/.test(value);
    return [pool.pool, valid(a) && valid(b) ? { status: 'available', amount0: BigInt(a), amount1: BigInt(b) }
      : { status: 'unavailable', reason: 'balance_unreadable' }];
  }));
}

// USD value of one pool's reserves with that hour's prices; null when a held token has no verified price.
export function poolTvlUsd({ token0, token1, amount0, amount1 }, prices) {
  const side = (token, amount) => (amount === 0n ? 0n : usdMicrosOf(token, amount, prices));
  const value0 = side(token0, amount0);
  const value1 = side(token1, amount1);
  return value0 === null || value1 === null ? null : value0 + value1;
}

// The hourly step (scripts/run-compact-hour.mjs, after the hour commits): snapshot the 24H top pools of each protocol at
// the hour's last block, once per hour. Bounded: TVL_POOLS_PER_PROTOCOL pools per protocol, one batched round for V3 and at
// most three for V4. Never throws: a failure is reported and the hour simply has no snapshot (the dashboard then says so).
export async function collectPoolTvl({ store, provider, hourStart, blockNumber, poolManager, limit = TVL_POOLS_PER_PROTOCOL }) {
  const report = { v3: 0, v4: 0, error: null };
  try {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > TVL_POOLS_PER_PROTOCOL) throw new TvlError('tvl_scan_unbounded');
    const blockTag = `0x${blockNumber.toString(16)}`;
    for (const protocol of ['uniswap_v3', 'uniswap_v4']) {
      if (store.poolTvl(hourStart, protocol).length) continue; // an hour's snapshot is written once
      const pools = store.topPoolsOf(protocol, hourStart, limit);
      if (!pools.length) continue;
      const results = protocol === 'uniswap_v3' ? await readV3Balances(provider, pools, { blockTag })
        : await readV4Reserves(provider, pools, { poolManager, blockTag });
      const rows = pools.map((pool) => ({ pool: pool.pool, ...results.get(pool.pool) }));
      store.recordPoolTvl(hourStart, protocol, rows, { blockNumber });
      report[protocol === 'uniswap_v3' ? 'v3' : 'v4'] = rows.length;
    }
  } catch (error) {
    report.error = TVL_REASONS.includes(error?.code) ? error.code : 'tvl_read_unavailable';
  }
  return report;
}
