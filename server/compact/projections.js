// Compact engine: projections of the Uniswap V3 and V4 log streams the hour processor already fetches and validates.
// Projections are NOT families: their state lives in compact_projection_hours (store.js), they never enter
// FAMILY_VERSIONS, family repair or an hour's network hash, and a projection failure can never change a family result.
// Live, the V3/V4 family accumulators hand every official event they already decoded to one projection sink, so the
// projections cost no RPC at all; the projection backfill feeds the same sink from a logs-only re-read of stored hours.
// A projection hour is offered as available only after it reconciles exactly with the family counters of the same
// hour; otherwise it is unavailable with a bounded reason, never partial.
//
// Semantics (locked by the frozen dashboard contract):
// - Pools: every official V3 pool (factory registry) and every V4 PoolManager pool, all pairs. Per pool and hour the
//   swap flow is kept as four directional raw totals from the pool's side: token0/1 in = paid into the pool, out = paid
//   out of the pool. V3 Swap amounts are pool deltas (positive = into the pool). V4 Swap amounts are the PoolManager swap
//   delta as emitted, from the caller's side (negative = paid into the pool), and do not include hook deltas: they are
//   the pool's swap flow, never a user's final net flow. Nothing here is a volume: valuation comes later, from these
//   raw totals, without replaying the chain.
// - Liquidity changes: V3 Mint is an add; V3 Burn with liquidity > 0 is a remove; a zero-liquidity Burn is a fee poke.
//   V4 ModifyLiquidity with liquidityDelta > 0 is an add, < 0 a remove, 0 a poke. Pokes are counted only to reconcile and
//   never appear as adds or removes. V3 add/remove token amounts are exact event fields; V4 events carry no token
//   amounts, so none are derived from liquidityDelta. None of this is pool liquidity (TVL).
// - Activity: From is the top-level transaction sender from the verified block spine. The counterparty is only a field
//   the event itself records: the V3 Swap recipient, the V3 Mint/Burn owner, the V4 ModifyLiquidity sender (the owner of
//   the PoolManager position). A V4 Swap records no recipient, so it has none; tx.to or a router is never used.
// - Price paths: per pool and hour, the pool's own price path from its Swap events (each records the pool's square-root
//   price and in-range liquidity after the swap; mints and burns never move a Uniswap price). The end-of-block state after
//   the block's last swap holds until the next swap, so from the hour's first swap through the hour's last block the path
//   is exact: block-weighted sums of the square-root price and of the two virtual reserves. Blocks before the hour's first
//   swap are not covered (the opening price would need another hour). Only data of the hour itself, so a live hour and a
//   logs-only re-read give identical rows. valuation.js turns qualified paths into token prices; nothing here is a price.
import { createHash } from 'node:crypto';
import { decodeV4Initialize } from '../../api/_lib/arc-intelligence/uniswap.js';
import { keccak256 } from './keccak.js';
import { blockState, validSqrtPrice } from './valuation.js';

export const PROJECTION_VERSIONS = Object.freeze({
  uniswap_v3_pools: 'uniswap-v3-pool-hours-v1',
  uniswap_v4_pools: 'uniswap-v4-pool-hours-v1+initialize-pool-id-keccak',
  dex_activity: 'uniswap-dex-activity-v1',
  uniswap_v3_price_paths: 'uniswap-v3-pool-price-path-v1',
  uniswap_v4_price_paths: 'uniswap-v4-pool-price-path-v1',
});
export const PROJECTIONS = Object.freeze(Object.keys(PROJECTION_VERSIONS));
export const POOL_PROJECTIONS = Object.freeze({ uniswap_v3_pools: 'uniswap_v3', uniswap_v4_pools: 'uniswap_v4' });
export const PRICE_PATH_PROJECTIONS = Object.freeze({ uniswap_v3_price_paths: 'uniswap_v3', uniswap_v4_price_paths: 'uniswap_v4' });
// The price path built from the same stream as each pool projection (a re-read of one stream rebuilds both).
export const PRICE_PATH_OF_POOLS = Object.freeze({ uniswap_v3_pools: 'uniswap_v3_price_paths', uniswap_v4_pools: 'uniswap_v4_price_paths' });
export const V4_POOL_KIND = 'uniswap_v4_pool';
// Pool-hours are kept for 35 days (groundwork for 7D/30D); recent activity is bounded per kind.
export const POOL_HOUR_RETENTION_HOURS = 35 * 24;
export const ACTIVITY_ROWS_PER_KIND = 500;
export const ACTIVITY_KINDS = Object.freeze(['swap', 'add', 'remove']);
export const COUNTERPARTY_KINDS = Object.freeze(['swap_recipient', 'liquidity_owner', 'event_sender', 'none']);
// v3_pool_delta: signed V3 Swap amounts, positive = into the pool. v3_liquidity_amount: exact Mint/Burn token amounts.
// v4_swap_delta: signed V4 PoolManager swap delta as emitted, negative = into the pool, hook deltas excluded.
export const AMOUNT_BASES = Object.freeze(['v3_pool_delta', 'v3_liquidity_amount', 'v4_swap_delta', 'none']);
export const PROJECTION_REASONS = Object.freeze(['family_unavailable', 'reconciliation_mismatch', 'v4_pool_id_mismatch',
  'duplicate_v4_initialize', 'malformed_v4_initialize', 'activity_spine_missing', 'projection_inputs_unavailable', 'projection_error',
  'price_path_invalid', 'price_path_out_of_order']);

const HOUR = 3600;
const ADDRESS = /^0x[0-9a-f]{40}$/;
const POOL_ID = /^0x[0-9a-f]{64}$/;
const HASH = /^0x[0-9a-f]{64}$/;
const UINT = /^\d+$/;
const INT = /^-?\d+$/;

export class ProjectionError extends Error {
  constructor(code) { super(code); this.code = code; }
}

const reasonOf = (error) => (PROJECTION_REASONS.includes(error?.code) ? error.code : 'projection_error');

// Key-sorted JSON (as store.js), so a digest depends on values only.
export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}
export const sha256Of = (value) => createHash('sha256').update(canonicalJson(value)).digest('hex');

// ---------------------------------------------------------------------------------------------------------------------
// V4 pool identity: PoolId = keccak256(abi.encode(PoolKey)) over 5 words (currency0, currency1, uint24 fee, int24
// tickSpacing, hooks). currency 0x0 is the chain's native currency (on Arc: native USDC, 18 decimals); it is kept as the
// zero address, never reinterpreted as the 6-decimal USDC token.

const word = (value) => BigInt.asUintN(256, BigInt(value)).toString(16).padStart(64, '0');

export function v4PoolIdOf({ currency0, currency1, fee, tickSpacing, hooks }) {
  const hex = `${word(currency0)}${word(currency1)}${word(fee)}${word(tickSpacing)}${word(hooks)}`;
  const bytes = new Uint8Array(160);
  for (let index = 0; index < 160; index++) bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  return keccak256(bytes);
}

// Registry record of one validated Initialize log. Throws ProjectionError unless it decodes and its poolId is exactly
// keccak256 of its own PoolKey.
export function v4PoolRecordOf(log) {
  const event = decodeV4Initialize(log);
  if (!event || !log.transactionHash) throw new ProjectionError('malformed_v4_initialize');
  if (v4PoolIdOf(event) !== event.poolId) throw new ProjectionError('v4_pool_id_mismatch');
  return { poolId: event.poolId, createdBlock: log.blockNumber, createdLogIndex: log.logIndex, createdTx: log.transactionHash.toLowerCase(),
    currency0: event.currency0, currency1: event.currency1, fee: event.fee, tickSpacing: event.tickSpacing, hooks: event.hooks };
}

export function validV4Record(record) {
  return Boolean(record) && POOL_ID.test(record.poolId) && Number.isSafeInteger(record.createdBlock) && Number.isSafeInteger(record.createdLogIndex)
    && HASH.test(record.createdTx) && ADDRESS.test(record.currency0) && ADDRESS.test(record.currency1) && ADDRESS.test(record.hooks)
    && Number.isSafeInteger(record.fee) && Number.isSafeInteger(record.tickSpacing) && v4PoolIdOf(record) === record.poolId;
}

// ---------------------------------------------------------------------------------------------------------------------
// Reconciliation with the authoritative family counters of the same hour. Returns null when exact, else a reason.

const sum = (rows, field) => rows.reduce((total, row) => total + row[field], 0);

export function reconcilePoolRows(projection, rows, family, { initializeCount = null } = {}) {
  if (family?.status !== 'available') return 'family_unavailable';
  if (projection === 'uniswap_v3_pools') {
    return sum(rows, 'swapCount') === family.swapCount && sum(rows, 'addCount') === family.mintCount
      && sum(rows, 'removeCount') + sum(rows, 'pokeCount') === family.burnCount ? null : 'reconciliation_mismatch';
  }
  if (projection === 'uniswap_v4_pools') {
    return sum(rows, 'swapCount') === family.swapCount
      && sum(rows, 'addCount') + sum(rows, 'removeCount') + sum(rows, 'pokeCount') === family.modifyLiquidityCount
      && (initializeCount === null || initializeCount === family.initializeCount) ? null : 'reconciliation_mismatch';
  }
  return 'projection_error';
}

// ---------------------------------------------------------------------------------------------------------------------
// Row checks (store.js re-validates everything it writes; nothing is trusted only because a sink produced it).

export function validPoolRow(row, protocol) {
  const amounts = ['token0InRaw', 'token0OutRaw', 'token1InRaw', 'token1OutRaw'];
  const liquidityAmounts = ['addAmount0Raw', 'addAmount1Raw', 'removeAmount0Raw', 'removeAmount1Raw'];
  const counts = ['swapCount', 'addCount', 'removeCount', 'pokeCount'];
  if (!row || (protocol === 'uniswap_v3' ? !ADDRESS.test(row.pool) : !POOL_ID.test(row.pool))) return false;
  if (!counts.every((field) => Number.isSafeInteger(row[field]) && row[field] >= 0)) return false;
  if (!amounts.every((field) => typeof row[field] === 'string' && UINT.test(row[field]))) return false;
  return protocol === 'uniswap_v3'
    ? liquidityAmounts.every((field) => typeof row[field] === 'string' && UINT.test(row[field]))
    : liquidityAmounts.every((field) => row[field] === null);
}

export function validActivityRow(row) {
  if (!row || !Number.isSafeInteger(row.blockNumber) || !Number.isSafeInteger(row.logIndex) || !Number.isSafeInteger(row.hourStart)
    || row.hourStart % HOUR !== 0 || !Number.isSafeInteger(row.blockTimestamp) || row.blockTimestamp < row.hourStart
    || row.blockTimestamp >= row.hourStart + HOUR || !HASH.test(row.txHash) || !ADDRESS.test(row.txFrom)
    || !ACTIVITY_KINDS.includes(row.kind) || !AMOUNT_BASES.includes(row.amountBasis) || !COUNTERPARTY_KINDS.includes(row.counterpartyKind)) return false;
  if (row.protocol === 'uniswap_v3') {
    if (!ADDRESS.test(row.pool) || !ADDRESS.test(row.counterparty ?? '')) return false;
    if (row.kind === 'swap') return row.amountBasis === 'v3_pool_delta' && row.counterpartyKind === 'swap_recipient' && INT.test(row.amount0Raw) && INT.test(row.amount1Raw);
    return row.amountBasis === 'v3_liquidity_amount' && row.counterpartyKind === 'liquidity_owner' && UINT.test(row.amount0Raw) && UINT.test(row.amount1Raw);
  }
  if (row.protocol === 'uniswap_v4') {
    if (!POOL_ID.test(row.pool)) return false;
    if (row.kind === 'swap') {
      return row.amountBasis === 'v4_swap_delta' && row.counterpartyKind === 'none' && row.counterparty === null && INT.test(row.amount0Raw) && INT.test(row.amount1Raw);
    }
    return row.amountBasis === 'none' && row.amount0Raw === null && row.amount1Raw === null && row.counterpartyKind === 'event_sender'
      && ADDRESS.test(row.counterparty ?? '');
  }
  return false;
}

// One price-path row inside its range { firstBlock, lastBlock }: every swap block inside the range, the path closed at the
// range's last block, exact non-negative integer sums, and valid Uniswap square-root prices.
export function validPricePathRow(row, protocol, { firstBlock, lastBlock }) {
  if (!row || (protocol === 'uniswap_v3' ? !ADDRESS.test(row.pool) : !POOL_ID.test(row.pool))) return false;
  if (!Number.isSafeInteger(row.swapCount) || row.swapCount < 1 || !Number.isSafeInteger(row.firstSwapBlock) || !Number.isSafeInteger(row.lastSwapBlock)
    || row.firstSwapBlock < firstBlock || row.lastSwapBlock > lastBlock || row.firstSwapBlock > row.lastSwapBlock
    || row.pricedBlocks !== lastBlock - row.firstSwapBlock + 1) return false;
  const integers = ['closeSqrtPriceX96', 'closeLiquidity', 'sqrtPriceBlockSum', 'reserve0BlockSum', 'reserve1BlockSum'];
  if (!integers.every((field) => typeof row[field] === 'string' && UINT.test(row[field]))) return false;
  return validSqrtPrice(BigInt(row.closeSqrtPriceX96)) && validSqrtPrice(BigInt(row.sqrtPriceBlockSum) / BigInt(row.pricedBlocks));
}

// Price paths reconcile with the family's swap counter and, when given, with the same hour's pool rows (exactly the pools
// with swaps, with the same swap counts). Returns null when exact, else a reason.
export function reconcilePricePaths(rows, family, poolRows = null) {
  if (family?.status !== 'available') return 'family_unavailable';
  if (sum(rows, 'swapCount') !== family.swapCount) return 'reconciliation_mismatch';
  if (poolRows) {
    const swapping = new Map(poolRows.filter((row) => row.swapCount > 0).map((row) => [row.pool, row.swapCount]));
    if (swapping.size !== rows.length || rows.some((row) => swapping.get(row.pool) !== row.swapCount)) return 'reconciliation_mismatch';
  }
  return null;
}

// Newest `limit` rows per kind, ordered (block_number DESC, log_index DESC): the bounded recent activity.
export const activityOrder = (left, right) => right.blockNumber - left.blockNumber || right.logIndex - left.logIndex;
export function newestActivity(rows, limit = ACTIVITY_ROWS_PER_KIND) {
  return ACTIVITY_KINDS.flatMap((kind) => rows.filter((row) => row.kind === kind).sort(activityOrder).slice(0, limit));
}

// Pool-hours older than the newest stored hour minus the retention window are pruned (hour_start <= cutoff).
export const poolHourCutoff = (newestHourStart) => newestHourStart - POOL_HOUR_RETENTION_HOURS * HOUR;

// ---------------------------------------------------------------------------------------------------------------------
// Projection-only repair (self-heal) of stored hours. One rule for the read model (which hours are candidates) and the
// single-hour repair child (what it fetches): a pool projection is repairable when it is missing or unavailable while its
// family is available, and its registry already covers the hour. A registry that is missing or behind is a blocker,
// never a reason to bootstrap it automatically. Recent activity is live-only: it needs the block spine's transaction
// senders, so a stored hour never gets activity afterwards and dex_activity is never a repair target.

export const POOL_PROJECTION_FAMILY = Object.freeze({ uniswap_v3_pools: 'uniswapV3', uniswap_v4_pools: 'uniswapV4' });
export const PROJECTION_REPAIR_BLOCKERS = Object.freeze(['v3_registry_missing', 'v3_registry_behind', 'v4_registry_missing',
  'v4_registry_behind']);

// V3 pool classification needs the official registry through the hour's last block; V4 registry coverage must reach the
// block before the hour, so the repaired hour's Initialize rows extend it contiguously. coverage: { through } or null.
export function registryRepairBlocker(projection, coverage, { firstBlock, lastBlock }) {
  if (projection === 'uniswap_v3_pools') return !coverage ? 'v3_registry_missing' : coverage.through < lastBlock ? 'v3_registry_behind' : null;
  return !coverage ? 'v4_registry_missing' : coverage.through < firstBlock - 1 ? 'v4_registry_behind' : null;
}

// Repair state of one stored hour. families / projections: stored status per name, or null when there is no row.
// Pool projection: state available | missing | unavailable | family_unavailable, repair eligible | blocked | none.
export function projectionRepairState({ families, projections, firstBlock, lastBlock, coverage }) {
  const out = {};
  for (const [name, family] of Object.entries(POOL_PROJECTION_FAMILY)) {
    const stored = projections[name] ?? null;
    if (stored === 'available') out[name] = { state: 'available', repair: 'none', blocker: null };
    else if (families[family] !== 'available') out[name] = { state: 'family_unavailable', repair: 'none', blocker: null };
    else {
      const blocker = registryRepairBlocker(name, coverage[name] ?? null, { firstBlock, lastBlock });
      out[name] = { state: stored === null ? 'missing' : 'unavailable', repair: blocker ? 'blocked' : 'eligible', blocker };
    }
  }
  const activity = projections.dex_activity ?? null;
  out.dex_activity = activity === 'available' ? { state: 'available', repair: 'none', blocker: null }
    : { state: activity === null ? 'missing' : 'unavailable', repair: 'none', blocker: null, reason: 'live_only' };
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------
// Projection sink. Never throws into its caller: a family accumulator keeps counting exactly as before whatever happens
// here; a failure only marks the affected projection unavailable for the hour. `activity: false` (the logs-only
// backfill, which has no block spine) leaves recent activity out.

const newPool = () => ({ swapCount: 0, token0In: 0n, token0Out: 0n, token1In: 0n, token1Out: 0n, addCount: 0, removeCount: 0, pokeCount: 0,
  add0: 0n, add1: 0n, remove0: 0n, remove1: 0n });

// Adds `blocks` blocks of one end-of-block state to a price path's sums [sqrtPrice, reserve0, reserve1].
function addSegment(sums, state, blocks) {
  const weight = BigInt(blocks);
  sums[0] += state.sqrtPrice * weight;
  sums[1] += state.reserve0 * weight;
  sums[2] += state.reserve1 * weight;
}

// A pool's price path closed at the range's last block (the state after its last swap holds through that block).
function pricePathRow(pool, path, firstBlock, lastBlock) {
  if (path.firstBlock < firstBlock || path.block > lastBlock) throw new ProjectionError('price_path_invalid');
  const sums = [...path.sums];
  addSegment(sums, path.state, lastBlock - path.block + 1);
  return { pool, swapCount: path.swapCount, firstSwapBlock: path.firstBlock, lastSwapBlock: path.block, pricedBlocks: lastBlock - path.firstBlock + 1,
    closeSqrtPriceX96: path.close[0], closeLiquidity: path.close[1], sqrtPriceBlockSum: sums[0].toString(10), reserve0BlockSum: sums[1].toString(10),
    reserve1BlockSum: sums[2].toString(10) };
}

export function createProjectionSink({ activity = true, activityLimit = ACTIVITY_ROWS_PER_KIND } = {}) {
  const pools = { uniswap_v3: new Map(), uniswap_v4: new Map() };
  const paths = { uniswap_v3: new Map(), uniswap_v4: new Map() };
  const created = [];
  const createdIds = new Set();
  const failures = { uniswap_v3_pools: null, uniswap_v4_pools: null, dex_activity: activity ? null : 'projection_inputs_unavailable',
    uniswap_v3_price_paths: null, uniswap_v4_price_paths: null };
  const rings = { swap: [], add: [], remove: [] };
  const fail = (projection, error) => { failures[projection] ??= reasonOf(error); };
  const poolOf = (protocol, key) => {
    let entry = pools[protocol].get(key);
    if (!entry) pools[protocol].set(key, (entry = newPool()));
    return entry;
  };

  // One Swap event of a pool's price path. Events must arrive in (block, logIndex) order, as every stream yields them;
  // anything else, or a price outside Uniswap's range, makes the protocol's price paths unavailable for the hour.
  function pricePath(protocol, key, log, event) {
    const name = protocol === 'uniswap_v3' ? 'uniswap_v3_price_paths' : 'uniswap_v4_price_paths';
    if (failures[name]) return;
    try {
      let state;
      try { state = blockState(BigInt(event.sqrtPriceX96Raw), BigInt(event.liquidityRaw)); } catch { throw new ProjectionError('price_path_invalid'); }
      const path = paths[protocol].get(key);
      if (!path) {
        paths[protocol].set(key, { swapCount: 1, firstBlock: log.blockNumber, block: log.blockNumber, logIndex: log.logIndex, state,
          close: [event.sqrtPriceX96Raw, event.liquidityRaw], sums: [0n, 0n, 0n] });
        return;
      }
      if (log.blockNumber < path.block || (log.blockNumber === path.block && log.logIndex <= path.logIndex)) {
        throw new ProjectionError('price_path_out_of_order');
      }
      if (log.blockNumber > path.block) {
        addSegment(path.sums, path.state, log.blockNumber - path.block);
        path.block = log.blockNumber;
      }
      path.logIndex = log.logIndex;
      path.state = state;
      path.close = [event.sqrtPriceX96Raw, event.liquidityRaw];
      path.swapCount += 1;
    } catch (error) {
      fail(name, error);
    }
  }

  function record(protocol, kind, log, window, fields) {
    if (!activity || failures.dex_activity) return;
    try {
      const block = window?.get(log.blockNumber);
      const txFrom = block?.txFrom?.[log.transactionIndex];
      if (!block || !txFrom || !log.transactionHash) throw new ProjectionError('activity_spine_missing');
      const ring = rings[kind];
      ring.push({ blockNumber: log.blockNumber, logIndex: log.logIndex, blockTimestamp: block.timestamp, txHash: log.transactionHash.toLowerCase(),
        txFrom, protocol, kind, pool: protocol === 'uniswap_v3' ? log.address : fields.pool, ...fields.row });
      // Bounded memory: never more than twice the kept rows per kind.
      if (ring.length > activityLimit * 2) ring.splice(0, ring.length, ...ring.sort(activityOrder).slice(0, activityLimit));
    } catch (error) {
      fail('dex_activity', error);
    }
  }

  return Object.freeze({
    // kind: swap | mint | burn; event: the decodeV3* result the family accumulator just produced for this official log.
    v3(kind, log, event, window) {
      let activityKind = kind === 'swap' ? 'swap' : kind === 'mint' ? 'add' : null;
      try {
        const pool = poolOf('uniswap_v3', log.address);
        if (kind === 'swap') {
          const amount0 = BigInt(event.amount0Raw);
          const amount1 = BigInt(event.amount1Raw);
          pool.swapCount += 1;
          if (amount0 > 0n) pool.token0In += amount0; else pool.token0Out -= amount0;
          if (amount1 > 0n) pool.token1In += amount1; else pool.token1Out -= amount1;
        } else if (kind === 'mint') {
          pool.addCount += 1;
          pool.add0 += BigInt(event.amount0Raw);
          pool.add1 += BigInt(event.amount1Raw);
        } else if (BigInt(event.liquidityRaw) === 0n) {
          pool.pokeCount += 1;
        } else {
          activityKind = 'remove';
          pool.removeCount += 1;
          pool.remove0 += BigInt(event.amount0Raw);
          pool.remove1 += BigInt(event.amount1Raw);
        }
      } catch (error) {
        fail('uniswap_v3_pools', error);
      }
      if (kind === 'swap') pricePath('uniswap_v3', log.address, log, event);
      if (!activityKind) return;
      record('uniswap_v3', activityKind, log, window, { row: kind === 'swap'
        ? { amount0Raw: event.amount0Raw, amount1Raw: event.amount1Raw, amountBasis: 'v3_pool_delta', counterparty: event.recipient, counterpartyKind: 'swap_recipient' }
        : { amount0Raw: event.amount0Raw, amount1Raw: event.amount1Raw, amountBasis: 'v3_liquidity_amount', counterparty: event.owner,
          counterpartyKind: 'liquidity_owner' } });
    },
    // kind: initialize | swap | modify; event: the decodeV4* result the family accumulator just produced.
    v4(kind, log, event, window) {
      let activityKind = null;
      try {
        if (kind === 'initialize') {
          const pool = v4PoolRecordOf(log);
          if (createdIds.has(pool.poolId)) throw new ProjectionError('duplicate_v4_initialize');
          createdIds.add(pool.poolId);
          created.push(pool);
          return;
        }
        const pool = poolOf('uniswap_v4', event.poolId);
        if (kind === 'swap') {
          const amount0 = BigInt(event.amount0Raw);
          const amount1 = BigInt(event.amount1Raw);
          activityKind = 'swap';
          pool.swapCount += 1;
          if (amount0 < 0n) pool.token0In -= amount0; else pool.token0Out += amount0;
          if (amount1 < 0n) pool.token1In -= amount1; else pool.token1Out += amount1;
        } else if (event.classification === 'increase') {
          activityKind = 'add';
          pool.addCount += 1;
        } else if (event.classification === 'decrease') {
          activityKind = 'remove';
          pool.removeCount += 1;
        } else {
          pool.pokeCount += 1;
        }
      } catch (error) {
        fail('uniswap_v4_pools', error);
        return;
      }
      if (kind === 'swap') pricePath('uniswap_v4', event.poolId, log, event);
      if (!activityKind) return;
      record('uniswap_v4', activityKind, log, window, { pool: event.poolId, row: activityKind === 'swap'
        ? { amount0Raw: event.amount0Raw, amount1Raw: event.amount1Raw, amountBasis: 'v4_swap_delta', counterparty: null, counterpartyKind: 'none' }
        : { amount0Raw: null, amount1Raw: null, amountBasis: 'none', counterparty: event.sender, counterpartyKind: 'event_sender' } });
    },
    // families: the hour's finished family results (authoritative). hourStart: null for a plain block range. firstBlock /
    // lastBlock: the range the events came from (price paths close at lastBlock; without them they are unavailable). Never
    // throws: the hour processor calls it after the families are final, and nothing here may fail an hour.
    finish(input) {
      try {
        return finishProjections(input);
      } catch {
        return Object.fromEntries(PROJECTIONS.map((name) => [name, { status: 'unavailable', reason: 'projection_error' }]));
      }
    },
  });

  function finishPricePaths(out, { families, firstBlock, lastBlock }) {
    for (const [name, protocol] of Object.entries(PRICE_PATH_PROJECTIONS)) {
      const family = families[protocol === 'uniswap_v3' ? 'uniswapV3' : 'uniswapV4'];
      const pool = out[protocol === 'uniswap_v3' ? 'uniswap_v3_pools' : 'uniswap_v4_pools'];
      let reason = family?.status !== 'available' ? 'family_unavailable' : failures[name]
        ?? (!Number.isSafeInteger(firstBlock) || !Number.isSafeInteger(lastBlock) || lastBlock < firstBlock ? 'projection_inputs_unavailable' : null);
      let rows = [];
      if (!reason) {
        try {
          rows = [...paths[protocol].entries()].sort(([left], [right]) => (left < right ? -1 : 1))
            .map(([key, path]) => pricePathRow(key, path, firstBlock, lastBlock));
          reason = reconcilePricePaths(rows, family, pool.status === 'available' ? pool.rows : null);
        } catch (error) {
          reason = reasonOf(error);
        }
      }
      out[name] = reason ? { status: 'unavailable', reason } : { status: 'available', rows, rowsSha256: sha256Of({ rows }) };
    }
  }

  function finishProjections({ families, hourStart = null, firstBlock = null, lastBlock = null }) {
    const out = {};
    for (const [projection, protocol] of Object.entries(POOL_PROJECTIONS)) {
      const family = families[protocol === 'uniswap_v3' ? 'uniswapV3' : 'uniswapV4'];
      const rows = [...pools[protocol].entries()].sort(([left], [right]) => (left < right ? -1 : 1)).map(([pool, entry]) => ({
        pool, swapCount: entry.swapCount, token0InRaw: entry.token0In.toString(10), token0OutRaw: entry.token0Out.toString(10),
        token1InRaw: entry.token1In.toString(10), token1OutRaw: entry.token1Out.toString(10), addCount: entry.addCount,
        removeCount: entry.removeCount, pokeCount: entry.pokeCount,
        addAmount0Raw: protocol === 'uniswap_v3' ? entry.add0.toString(10) : null, addAmount1Raw: protocol === 'uniswap_v3' ? entry.add1.toString(10) : null,
        removeAmount0Raw: protocol === 'uniswap_v3' ? entry.remove0.toString(10) : null,
        removeAmount1Raw: protocol === 'uniswap_v3' ? entry.remove1.toString(10) : null }));
      const registry = protocol === 'uniswap_v4' ? [...created] : undefined;
      const reason = family?.status !== 'available' ? 'family_unavailable' : failures[projection]
        ?? reconcilePoolRows(projection, rows, family, { initializeCount: registry ? registry.length : null });
      out[projection] = reason ? { status: 'unavailable', reason }
        : { status: 'available', rows, ...(registry ? { registry } : {}), rowsSha256: sha256Of(registry ? { rows, registry } : { rows }) };
    }
    const activityReason = failures.dex_activity ?? (out.uniswap_v3_pools.status !== 'available' || out.uniswap_v4_pools.status !== 'available'
      ? 'projection_inputs_unavailable' : hourStart === null ? 'projection_inputs_unavailable' : null);
    if (activityReason) out.dex_activity = { status: 'unavailable', reason: activityReason };
    else {
      const rows = newestActivity(Object.values(rings).flat(), activityLimit).map((row) => ({ ...row, hourStart }));
      out.dex_activity = { status: 'available', rows, rowsSha256: sha256Of({ rows }) };
    }
    finishPricePaths(out, { families, firstBlock, lastBlock });
    return out;
  }
}
