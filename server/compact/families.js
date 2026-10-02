// Compact engine: per-family accumulators. Each consumes validated windows and keeps only counters and the address
// sets its unique counts need, so raw blocks and logs can be released after every window. Semantics are the A2 ones:
// network sets from top-level transactions, canonical USDC from the system emitter only, Uniswap via the shared
// decoders and pool-verification rules, unique traders as the transaction sender (event `sender` is usually a router).
import { summarizeUsdcTransfers } from '../../api/_lib/arc-intelligence/usdc.js';
import { summarizeVerifiedAssetTransfers } from '../../api/_lib/arc-intelligence/tokens.js';
import {
  decodeV3Burn, decodeV3Mint, decodeV3PoolCreated, decodeV3Swap, decodeV4Initialize, decodeV4ModifyLiquidity, decodeV4Swap,
  MAX_UNISWAP_POOL_CANDIDATES, UNISWAP_EVENT_TOPICS, UNISWAP_REGISTRY,
} from '../../api/_lib/arc-intelligence/uniswap.js';

export class FamilyError extends Error {
  constructor(code) { super(code); this.code = code; }
}

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
        gasUsed += BigInt(block.gasUsedRaw);
        for (const transaction of block.transactions) {
          transactionCount += 1;
          senders.add(transaction.from);
          if (transaction.to) recipients.add(transaction.to);
          else deploymentAttempts += 1;
        }
      }
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

// Same selectors and acceptance rules as verifyV3Pool in api/_lib/arc-intelligence/uniswap.js (not exported there).
const V3_SELECTORS = Object.freeze({ factory: '0xc45a0155', token0: '0x0dfe1681', token1: '0xd21220a7', fee: '0xddca3f43',
  getPool: '0x1698ee82' });
const WORD = /^0x[0-9a-f]{64}$/i;
const wordAddress = (result) => (typeof result === 'string' && WORD.test(result) && /^0x0{24}/i.test(result)
  ? `0x${result.slice(-40)}`.toLowerCase() : null);
const wordUint24 = (result) => {
  if (typeof result !== 'string' || !WORD.test(result)) return null;
  const value = BigInt(result);
  return value < (1n << 24n) ? Number(value) : null;
};
const addressWord = (address) => address.slice(2).toLowerCase().padStart(64, '0');
export const codeIsPresent = (code) => typeof code === 'string' && /^0x(?!0*$)[0-9a-f]+$/i.test(code);

// Batched: 5 reads per emitter (10 emitters per batch), then one getPool read per getter-valid emitter.
// A read the provider could not serve makes the family unavailable; only an execution revert rejects the emitter,
// so a lagging backend ("header not found") can never silently drop a real pool's events.
const reverted = (answer) => Boolean(answer.error) && (answer.error.code === 3 || /revert/i.test(answer.error.message));
const unserved = (answer) => (answer.error ? !reverted(answer) : typeof answer.result !== 'string');
export async function verifyV3Pools(provider, emitters, blockTag) {
  const verdicts = new Map();
  for (let offset = 0; offset < emitters.length; offset += 10) {
    const chunk = emitters.slice(offset, offset + 10);
    const answers = await provider.batch(chunk.flatMap((address) => [
      ['eth_getCode', [address, blockTag]],
      ...['factory', 'token0', 'token1', 'fee'].map((name) => ['eth_call', [{ to: address, data: V3_SELECTORS[name] }, blockTag]]),
    ]), { allowItemErrors: true });
    const candidates = [];
    chunk.forEach((address, index) => {
      const [code, factory, token0, token1, fee] = answers.slice(index * 5, index * 5 + 5);
      if (code.error || typeof code.result !== 'string' || [factory, token0, token1, fee].some(unserved)) {
        throw new FamilyError('v3_pool_verification_unavailable');
      }
      if (!codeIsPresent(code.result)) return verdicts.set(address, { status: 'rejected', reason: 'no_pool_bytecode' });
      if ([factory, token0, token1, fee].some(reverted)) {
        return verdicts.set(address, { status: 'rejected', reason: 'pool_getters_reverted' });
      }
      const pool = { address, factory: wordAddress(factory.result), token0: wordAddress(token0.result),
        token1: wordAddress(token1.result), fee: wordUint24(fee.result) };
      if (!pool.factory || !pool.token0 || !pool.token1 || pool.token0 === pool.token1 || pool.fee === null) {
        return verdicts.set(address, { status: 'rejected', reason: 'pool_getters_malformed' });
      }
      if (pool.factory !== UNISWAP_REGISTRY.v3Factory.address) return verdicts.set(address, { status: 'rejected', reason: 'foreign_factory' });
      return candidates.push(pool);
    });
    if (!candidates.length) continue;
    const mapped = await provider.batch(candidates.map((pool) => ['eth_call', [{ to: UNISWAP_REGISTRY.v3Factory.address,
      data: `${V3_SELECTORS.getPool}${addressWord(pool.token0)}${addressWord(pool.token1)}${pool.fee.toString(16).padStart(64, '0')}` },
    blockTag]]), { allowItemErrors: true });
    candidates.forEach((pool, index) => {
      if (mapped[index].error || typeof mapped[index].result !== 'string') throw new FamilyError('v3_pool_verification_unavailable');
      verdicts.set(pool.address, wordAddress(mapped[index].result) === pool.address
        ? { status: 'verified', token0: pool.token0, token1: pool.token1, fee: pool.fee }
        : { status: 'rejected', reason: 'factory_mapping_mismatch' });
    });
  }
  return verdicts;
}

export function createUniswapV3Accumulator({ maxPoolCandidates = MAX_UNISWAP_POOL_CANDIDATES } = {}) {
  let poolCreatedCount = 0;
  const emitters = new Map();
  const decoders = { [UNISWAP_EVENT_TOPICS.v3Swap]: ['swaps', decodeV3Swap], [UNISWAP_EVENT_TOPICS.v3Mint]: ['mints', decodeV3Mint],
    [UNISWAP_EVENT_TOPICS.v3Burn]: ['burns', decodeV3Burn] };
  return {
    add(stream, logs) {
      if (stream === 'v3Factory') {
        for (const log of logs) {
          const event = decodeV3PoolCreated(log);
          if (!event) throw new FamilyError('malformed_v3_pool_created');
          poolCreatedCount += 1;
        }
        return;
      }
      for (const log of logs) {
        let emitter = emitters.get(log.address);
        if (!emitter) {
          if (emitters.size >= maxPoolCandidates) throw new FamilyError('v3_pool_candidate_limit');
          emitter = { swaps: 0, mints: 0, burns: 0, malformed: 0, traders: new Set() };
          emitters.set(log.address, emitter);
        }
        const [counter, decode] = decoders[log.topics[0]];
        if (!decode(log)) { emitter.malformed += 1; continue; }
        emitter[counter] += 1;
        if (counter === 'swaps') emitter.traders.add(log.transactionFrom);
      }
    },
    async finish({ provider, blockTag, factoryCodePresent }) {
      if (!factoryCodePresent) throw new FamilyError('v3_factory_code_unverified');
      const addresses = [...emitters.keys()].sort();
      const verdicts = await verifyV3Pools(provider, addresses, blockTag);
      const traders = new Set();
      let swapCount = 0, mintCount = 0, burnCount = 0, poolsWithSwaps = 0;
      const verifiedPools = [];
      for (const address of addresses) {
        const verdict = verdicts.get(address);
        if (verdict.status !== 'verified') continue;
        const emitter = emitters.get(address);
        if (emitter.malformed) throw new FamilyError('malformed_v3_pool_event');
        swapCount += emitter.swaps; mintCount += emitter.mints; burnCount += emitter.burns;
        if (emitter.swaps) poolsWithSwaps += 1;
        for (const trader of emitter.traders) traders.add(trader);
        verifiedPools.push({ address, token0: verdict.token0, token1: verdict.token1, fee: verdict.fee });
      }
      return { poolCreatedCount, swapCount, mintCount, burnCount, uniqueTraders: traders.size, poolsWithSwaps, verifiedPools,
        rejectedEmitterCount: addresses.length - verifiedPools.length };
    },
  };
}

export function createUniswapV4Accumulator() {
  let initializeCount = 0, swapCount = 0, modifyLiquidityCount = 0;
  const traders = new Set();
  const swapPools = new Set();
  return {
    add(_stream, logs) {
      for (const log of logs) {
        const topic = log.topics[0];
        if (topic === UNISWAP_EVENT_TOPICS.v4Swap) {
          const event = decodeV4Swap(log);
          if (!event) throw new FamilyError('malformed_v4_swap');
          swapCount += 1;
          traders.add(log.transactionFrom);
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
export const FAMILY_FIELDS = Object.freeze({
  usdc: Object.freeze(['transferCount', 'amountRaw', 'rawDecimals', 'mintCount', 'burnCount']),
  assets: Object.freeze(['items']),
  uniswapV3: Object.freeze(['poolCreatedCount', 'swapCount', 'mintCount', 'burnCount', 'uniqueTraders', 'poolsWithSwaps',
    'verifiedPools', 'rejectedEmitterCount']),
  uniswapV4: Object.freeze(['initializeCount', 'swapCount', 'modifyLiquidityCount', 'uniqueTraders', 'poolsWithSwaps']),
});
