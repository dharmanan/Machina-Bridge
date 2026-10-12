// Archery CL hourly activity: swap, mint and burn counts of the official Archery CL factory's pools only (counts, never
// USD, fees, prices or liquidity). It reuses the validated Uniswap V3-signature logs the uniswapV3 family already requests
// (topic-only, no address filter): no extra log request, and Uniswap pools are never counted. Pool membership is proven
// per hour by the official factory's own pool list at the hour's last block, so a pool created later is found the same
// way. This is not a family: it never enters FAMILY_FIELDS, hour completeness, family repair, token discovery or
// projections, and it never makes an hour fail. Any doubt gives an unavailable result with a reason, never zero.
import { ARCHERY_CL, ARCHERY_CL_DEFINITION_VERSION } from '../../api/_lib/arc-intelligence/archery.js';
import { UNISWAP_EVENT_TOPICS, decodeV3Burn, decodeV3Mint, decodeV3Swap } from '../../api/_lib/arc-intelligence/uniswap.js';
import { decodeResult, encodeCall } from './abi.js';
import { ProviderError } from './provider.js';
import { codeIsPresent } from './registry.js';

export const ARCHERY_CL_MAX_POOLS = 64;
const MAX_EMITTERS = 4096;
const ADDRESS = /^0x[0-9a-f]{40}$/;
const KINDS = Object.freeze({ [UNISWAP_EVENT_TOPICS.v3Swap]: ['swaps', decodeV3Swap], [UNISWAP_EVENT_TOPICS.v3Mint]: ['mints', decodeV3Mint],
  [UNISWAP_EVENT_TOPICS.v3Burn]: ['burns', decodeV3Burn] });

const unavailable = (reason) => ({ status: 'unavailable', reason, definitionVersion: ARCHERY_CL_DEFINITION_VERSION, metrics: null });
const call = (to, signature, args, blockTag) => ['eth_call', [{ to, data: encodeCall(signature, args) }, blockTag]];
const addressOf = (result) => decodeResult(['address'], result)?.[0] ?? null;

// registry: the verified static pools (ARCHERY_CL). uniswapPools: the Uniswap V3 registry's pool Set, skipped up front.
export function createArcheryClAccumulator({ registry = ARCHERY_CL, uniswapPools = null } = {}) {
  const emitters = new Map();
  let overflow = false;
  let failed = false;
  // Per-emitter counts of one validated response.
  function tally(logs) {
    for (const log of logs) {
      const kind = KINDS[log.topics?.[0]];
      if (!kind || uniswapPools?.has(log.address)) continue;
      let row = emitters.get(log.address);
      if (!row) {
        if (emitters.size >= MAX_EMITTERS) { overflow = true; continue; }
        row = { swaps: 0, mints: 0, burns: 0, malformed: false };
        emitters.set(log.address, row);
      }
      if (kind[1](log)) row[kind[0]] += 1;
      else row.malformed = true;
    }
  }
  return Object.freeze({
    // The same validated v3Pools logs the uniswapV3 accumulator received, in the same order. Never throws: it runs inside
    // the uniswapV3 stream loop, whose errors must stay that family's own.
    add(logs) {
      try { tally(logs); } catch { failed = true; }
    },
    // delivered: every window's v3Pools response reached add(). One batched request normally; new pools add three.
    // Never throws either: any failure is this result's own unavailable reason, never the hour's.
    async finish({ provider, blockTag, delivered }) {
      try {
        return await verify({ provider, blockTag, delivered });
      } catch (error) {
        return unavailable(error instanceof ProviderError ? 'factory_rpc_unavailable' : 'internal_error');
      }
    },
  });

  // Pool membership from the official factory at the hour's last block, then the counts of its pools only.
  async function verify({ provider, blockTag, delivered }) {
    if (!delivered) return unavailable('v3_log_stream_unavailable');
    if (failed) return unavailable('internal_error');
    if (overflow) return unavailable('emitter_limit');
    const statics = registry.pools;
    const first = await provider.batch([['eth_getCode', [registry.factory, blockTag]], call(registry.factory, 'allPoolsLength()', [], blockTag),
      ...statics.map((_, index) => call(registry.factory, 'allPools(uint256)', [['uint256', index]], blockTag))]);
    if (!codeIsPresent(first[0])) return unavailable('factory_code_unavailable');
    const count = decodeResult(['uint256'], first[1])?.[0];
    if (count === undefined) return unavailable('factory_pool_list_unavailable');
    if (count < BigInt(statics.length) || statics.some((pool, index) => addressOf(first[2 + index]) !== pool.address)) {
      return unavailable('factory_pool_list_mismatch');
    }
    if (count > BigInt(ARCHERY_CL_MAX_POOLS)) return unavailable('pool_limit');
    const length = Number(count);
    const pools = new Map(statics.map((pool) => [pool.address, { token0: pool.token0, token1: pool.token1, tickSpacing: pool.tickSpacing }]));
    if (length > statics.length) {
      // Pools created after the verified list: listed by the factory, then each proven like the published ones.
      const indexes = Array.from({ length: length - statics.length }, (_, offset) => statics.length + offset);
      const listed = (await provider.batch(indexes.map((index) => call(registry.factory, 'allPools(uint256)', [['uint256', index]], blockTag))))
        .map(addressOf);
      if (listed.some((address) => !address || pools.has(address)) || new Set(listed).size !== listed.length) return unavailable('new_pool_unverified');
      const details = await provider.batch(listed.flatMap((address) => [['eth_getCode', [address, blockTag]], call(address, 'factory()', [], blockTag),
        call(address, 'token0()', [], blockTag), call(address, 'token1()', [], blockTag), call(address, 'tickSpacing()', [], blockTag)]));
      const candidates = listed.map((address, index) => {
        const [code, factory, token0, token1, tickSpacing] = details.slice(index * 5, index * 5 + 5);
        return { address, code: codeIsPresent(code), factory: addressOf(factory), token0: addressOf(token0), token1: addressOf(token1),
          tickSpacing: decodeResult(['int24'], tickSpacing)?.[0] };
      });
      if (candidates.some((pool) => !pool.code || pool.factory !== registry.factory || !pool.token0 || !pool.token1 || pool.tickSpacing === undefined)) {
        return unavailable('new_pool_unverified');
      }
      const back = await provider.batch(candidates.map((pool) => call(registry.factory, 'getPool(address,address,int24)',
        [['address', pool.token0], ['address', pool.token1], ['int24', pool.tickSpacing]], blockTag)));
      if (candidates.some((pool, index) => addressOf(back[index]) !== pool.address)) return unavailable('new_pool_unverified');
      for (const pool of candidates) pools.set(pool.address, { token0: pool.token0, token1: pool.token1, tickSpacing: Number(pool.tickSpacing) });
    }
    const active = [];
    let swapCount = 0, mintCount = 0, burnCount = 0;
    for (const [address, row] of emitters) {
      const pool = pools.get(address);
      if (!pool) continue;
      if (row.malformed) return unavailable('malformed_pool_event');
      swapCount += row.swaps; mintCount += row.mints; burnCount += row.burns;
      active.push({ pool: address, ...pool, swaps: row.swaps, mints: row.mints, burns: row.burns });
    }
    active.sort((a, b) => (a.pool < b.pool ? -1 : 1));
    return { status: 'available', reason: null, definitionVersion: ARCHERY_CL_DEFINITION_VERSION,
      metrics: { swapCount, mintCount, burnCount, registeredPoolCount: length, pools: active } };
  }
}

// The stored form of one hour's result, or an unavailable record when the result is not exactly that shape. Never throws.
export function archeryHourRecord(result, range) {
  const base = { definitionVersion: ARCHERY_CL_DEFINITION_VERSION, firstBlock: range.firstBlock, lastBlock: range.lastBlock };
  const count = (value) => Number.isSafeInteger(value) && value >= 0;
  if (result?.status === 'unavailable' && typeof result.reason === 'string' && /^[a-z0-9_]{1,64}$/.test(result.reason) && result.metrics === null) {
    return { ...base, status: 'unavailable', reason: result.reason, metrics: null };
  }
  const m = result?.metrics;
  const valid = result?.status === 'available' && result.reason === null && m && count(m.swapCount) && count(m.mintCount) && count(m.burnCount)
    && count(m.registeredPoolCount) && m.registeredPoolCount <= ARCHERY_CL_MAX_POOLS && Array.isArray(m.pools) && m.pools.length <= m.registeredPoolCount
    && m.pools.every((pool) => ADDRESS.test(pool.pool) && ADDRESS.test(pool.token0) && ADDRESS.test(pool.token1) && Number.isSafeInteger(pool.tickSpacing)
      && count(pool.swaps) && count(pool.mints) && count(pool.burns) && pool.swaps + pool.mints + pool.burns > 0)
    && new Set(m.pools.map((pool) => pool.pool)).size === m.pools.length
    && m.pools.reduce((sum, pool) => sum + pool.swaps, 0) === m.swapCount && m.pools.reduce((sum, pool) => sum + pool.mints, 0) === m.mintCount
    && m.pools.reduce((sum, pool) => sum + pool.burns, 0) === m.burnCount;
  if (!valid) return { ...base, status: 'unavailable', reason: 'result_invalid', metrics: null };
  return { ...base, status: 'available', reason: null, metrics: { swapCount: m.swapCount, mintCount: m.mintCount, burnCount: m.burnCount,
    registeredPoolCount: m.registeredPoolCount, pools: m.pools.map(({ pool, token0, token1, tickSpacing, swaps, mints, burns }) =>
      ({ pool, token0, token1, tickSpacing, swaps, mints, burns })) } };
}

// compact_meta key of one hour's record: a namespace no expiry, archive, recovery or family reader scans.
export const ARCHERY_CL_META_PREFIX = 'protocol_hour:archery_cl:';
export const archeryMetaKey = (hourStart) => `${ARCHERY_CL_META_PREFIX}${String(hourStart).padStart(10, '0')}`;
// Records kept: the 30D window plus margin. Each new record removes this namespace's own records older than that.
export const ARCHERY_CL_KEEP_HOURS = 35 * 24;
