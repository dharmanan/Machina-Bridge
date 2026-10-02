// Compact engine: per-family accumulators. Each consumes validated log responses and keeps only counters and the
// address sets its unique counts need, so raw blocks and logs are released after every response. Semantics are the A2
// ones: network sets from top-level transactions, canonical USDC from the system emitter only, Uniswap via the shared
// decoders, unique traders as the transaction sender (event `sender` is usually a router). Uniswap V3 pools are the
// official factory's PoolCreated pools (durable registry plus this range's overlay); other V3-signature emitters are
// foreign: counted, never decoded, never fatal.
import { summarizeUsdcTransfers } from '../../api/_lib/arc-intelligence/usdc.js';
import { summarizeVerifiedAssetTransfers } from '../../api/_lib/arc-intelligence/tokens.js';
import {
  decodeV3Burn, decodeV3Mint, decodeV3Swap, decodeV4Initialize, decodeV4ModifyLiquidity, decodeV4Swap, UNISWAP_EVENT_TOPICS,
} from '../../api/_lib/arc-intelligence/uniswap.js';
import { FamilyError } from './family-error.js';
import { senderOf } from './logs.js';
import { PROTOCOL_FAMILIES } from './protocols/index.js';
import { poolRecordOf } from './registry.js';

export { FamilyError };

export function createNetworkAccumulator() {
  let blockCount = 0;
  let transactionCount = 0;
  let gasUsed = 0n;
  let deploymentAttempts = 0;
  const senders = new Set();
  const recipients = new Set();
  return {
    addBlocks(blocks) {
      for (const block of blocks) {
        blockCount += 1;
        gasUsed += block.gasUsed;
        transactionCount += block.txHashes.length;
        for (let index = 0; index < block.txFrom.length; index++) {
          senders.add(block.txFrom[index]);
          const to = block.txTo[index];
          if (to) recipients.add(to);
          else deploymentAttempts += 1;
        }
      }
    },
    // The exact identity set behind uniqueActiveAddresses (senders ∪ recipients), sorted.
    activeAddresses() {
      const active = [...senders];
      for (const recipient of recipients) if (!senders.has(recipient)) active.push(recipient);
      return active.sort();
    },
    finish({ durationSeconds = null } = {}) {
      let active = senders.size;
      for (const recipient of recipients) if (!senders.has(recipient)) active += 1;
      return {
        status: 'available',
        blockCount,
        transactionCount,
        uniqueSenders: senders.size,
        uniqueRecipients: recipients.size,
        uniqueActiveAddresses: active,
        gasUsedRaw: gasUsed.toString(10),
        averageTransactionsPerBlock: blockCount ? transactionCount / blockCount : null,
        transactionsPerSecond: durationSeconds ? transactionCount / durationSeconds : null,
        // Internal only: a to == null transaction is a deployment attempt; without receipts its success is unknown.
        internal: { deploymentAttempts },
      };
    },
  };
}

export function createUsdcAccumulator() {
  let transferCount = 0;
  let amount = 0n;
  let mintCount = 0;
  let burnCount = 0;
  return {
    add(_stream, logs) {
      const summary = summarizeUsdcTransfers(logs);
      if (!summary.complete || summary.transferCount !== logs.length) throw new FamilyError('malformed_usdc_transfer');
      transferCount += summary.transferCount;
      amount += BigInt(summary.amountRaw);
      mintCount += summary.mintCount;
      burnCount += summary.burnCount;
    },
    async finish() {
      return { transferCount, amountRaw: amount.toString(10), rawDecimals: 18, mintCount, burnCount };
    },
  };
}

export function createAssetsAccumulator() {
  const totals = new Map();
  return {
    add(_stream, logs) {
      for (const asset of summarizeVerifiedAssetTransfers(logs)) {
        if (asset.symbol === 'USDC') continue;
        if (!asset.complete) throw new FamilyError('malformed_asset_transfer');
        const total = totals.get(asset.address) ?? { symbol: asset.symbol, address: asset.address, decimals: asset.decimals,
          transferCount: 0, amount: 0n, mintCount: 0, burnCount: 0 };
        total.transferCount += asset.transferCount;
        total.amount += BigInt(asset.amountRaw);
        total.mintCount += asset.mintCount;
        total.burnCount += asset.burnCount;
        totals.set(asset.address, total);
      }
    },
    async finish() {
      return {
        items: [...totals.values()].map(({ amount, ...total }) => ({ ...total, amountRaw: amount.toString(10) })),
      };
    },
  };
}

// registry: { pools: Set of official pool addresses } covering every block before the range (hour.js checks coverage).
// Pools created inside the range join an in-memory overlay first: the factory stream of a window is always consumed
// before that window's pool stream, so a pool created and used in the same block is counted.
export function createUniswapV3Accumulator({ registry }) {
  let poolCreatedCount = 0, swapCount = 0, mintCount = 0, burnCount = 0, foreignEventCount = 0;
  const created = new Map();
  const traders = new Set();
  const swapPools = new Set();
  const foreign = new Set();
  const decoders = { [UNISWAP_EVENT_TOPICS.v3Swap]: ['swap', decodeV3Swap], [UNISWAP_EVENT_TOPICS.v3Mint]: ['mint', decodeV3Mint],
    [UNISWAP_EVENT_TOPICS.v3Burn]: ['burn', decodeV3Burn] };
  return {
    add(stream, logs, window) {
      if (stream === 'v3Factory') {
        for (const log of logs) {
          const pool = poolRecordOf(log);
          if (!pool) throw new FamilyError('malformed_v3_pool_created');
          if (created.has(pool.address)) throw new FamilyError('duplicate_v3_pool_created');
          created.set(pool.address, pool);
          poolCreatedCount += 1;
        }
        return;
      }
      for (const log of logs) {
        if (!registry.pools.has(log.address) && !created.has(log.address)) {
          foreign.add(log.address);
          foreignEventCount += 1;
          continue;
        }
        const [kind, decode] = decoders[log.topics[0]];
        if (!decode(log)) throw new FamilyError('malformed_v3_pool_event');
        if (kind === 'swap') {
          swapCount += 1;
          traders.add(senderOf(window, log));
          swapPools.add(log.address);
        } else if (kind === 'mint') mintCount += 1;
        else burnCount += 1;
      }
    },
    // Official pools created inside the range, in chain order: the registry rows this range adds.
    createdPools: () => [...created.values()],
    async finish({ factoryCodePresent }) {
      if (!factoryCodePresent) throw new FamilyError('v3_factory_code_unverified');
      return { poolCreatedCount, swapCount, mintCount, burnCount, uniqueTraders: traders.size, poolsWithSwaps: swapPools.size,
        foreignEmitterCount: foreign.size, foreignEventCount };
    },
  };
}

export function createUniswapV4Accumulator() {
  let initializeCount = 0, swapCount = 0, modifyLiquidityCount = 0;
  const traders = new Set();
  const swapPools = new Set();
  return {
    add(_stream, logs, window) {
      for (const log of logs) {
        const topic = log.topics[0];
        if (topic === UNISWAP_EVENT_TOPICS.v4Swap) {
          const event = decodeV4Swap(log);
          if (!event) throw new FamilyError('malformed_v4_swap');
          swapCount += 1;
          traders.add(senderOf(window, log));
          swapPools.add(event.poolId);
        } else if (topic === UNISWAP_EVENT_TOPICS.v4ModifyLiquidity) {
          if (!decodeV4ModifyLiquidity(log)) throw new FamilyError('malformed_v4_modify_liquidity');
          modifyLiquidityCount += 1;
        } else if (topic === UNISWAP_EVENT_TOPICS.v4Initialize) {
          if (!decodeV4Initialize(log)) throw new FamilyError('malformed_v4_initialize');
          initializeCount += 1;
        }
      }
    },
    async finish({ poolManagerCodePresent }) {
      if (!poolManagerCodePresent) throw new FamilyError('v4_pool_manager_code_unverified');
      return { initializeCount, swapCount, modifyLiquidityCount, uniqueTraders: traders.size, poolsWithSwaps: swapPools.size };
    },
  };
}

// Field templates: an unavailable family keeps every field, all null, so missing evidence can never read as zero.
// The first four families are the Stage 1/2 ones; protocol families (protocols/index.js) follow in their declared order.
export const FAMILY_FIELDS = Object.freeze({
  usdc: Object.freeze(['transferCount', 'amountRaw', 'rawDecimals', 'mintCount', 'burnCount']),
  assets: Object.freeze(['items']),
  uniswapV3: Object.freeze(['poolCreatedCount', 'swapCount', 'mintCount', 'burnCount', 'uniqueTraders', 'poolsWithSwaps',
    'foreignEmitterCount', 'foreignEventCount']),
  uniswapV4: Object.freeze(['initializeCount', 'swapCount', 'modifyLiquidityCount', 'uniqueTraders', 'poolsWithSwaps']),
  ...Object.fromEntries(PROTOCOL_FAMILIES.map((family) => [family.name, Object.freeze([...family.fields])])),
});

// What adds up across hours (windows.js): counts and raw amounts do; per-hour unique counts, pools-with-activity and
// foreign-emitter counts do not (the same actor or pool in two hours would be counted twice), so windows leave them out.
export const FAMILY_WINDOWS = Object.freeze({
  usdc: Object.freeze({ counts: ['transferCount', 'mintCount', 'burnCount'], amounts: ['amountRaw'], constants: ['rawDecimals'] }),
  assets: Object.freeze({ lists: { items: { key: 'address', counts: ['transferCount', 'mintCount', 'burnCount'], amounts: ['amountRaw'],
    constants: ['symbol', 'address', 'decimals'] } } }),
  uniswapV3: Object.freeze({ counts: ['poolCreatedCount', 'swapCount', 'mintCount', 'burnCount', 'foreignEventCount'] }),
  uniswapV4: Object.freeze({ counts: ['initializeCount', 'swapCount', 'modifyLiquidityCount'] }),
  ...Object.fromEntries(PROTOCOL_FAMILIES.map((family) => [family.name, family.window])),
});
