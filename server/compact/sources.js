// Compact engine: the only log streams it ever requests. Every stream is filtered by topic and, where the emitter is
// known in advance, by address. Definitions come from the existing verified registries; nothing here is new semantics.
import { ARC_VERIFIED_ASSETS } from '../../api/_lib/arc-intelligence/assets.js';
import { TRANSFER_TOPIC, USDC_SYSTEM_EMITTER } from '../../api/_lib/arc-intelligence/usdc.js';
import { UNISWAP_DEFINITION_VERSION, UNISWAP_EVENT_TOPICS, UNISWAP_REGISTRY } from '../../api/_lib/arc-intelligence/uniswap.js';

export const COMPACT_DEFINITION_VERSION = 'arc-compact-hour-v1';
export const COMPACT_SOURCE_VERSIONS = Object.freeze({
  hour: COMPACT_DEFINITION_VERSION,
  usdc: 'canonical-system-emitter-v1',
  uniswap: UNISWAP_DEFINITION_VERSION,
});

const NON_USDC_ASSET_ADDRESSES = ARC_VERIFIED_ASSETS.filter((asset) => asset.symbol !== 'USDC').map((asset) => asset.address.toLowerCase());

// Dense streams (several logs per block) are never requested over more than this many blocks per call.
export const DENSE_LOG_RANGE_BLOCKS = 500;

// address: null means topic-only (V3 pools are not known before their events are seen; they are verified afterwards).
// maxRange: per-request block cap before any provider-limit split; sparse streams follow the window size.
export const LOG_STREAMS = Object.freeze([
  Object.freeze({ key: 'usdc', address: Object.freeze([USDC_SYSTEM_EMITTER.toLowerCase()]), topics: Object.freeze([TRANSFER_TOPIC]),
    maxRange: DENSE_LOG_RANGE_BLOCKS }),
  Object.freeze({ key: 'assets', address: Object.freeze(NON_USDC_ASSET_ADDRESSES), topics: Object.freeze([TRANSFER_TOPIC]) }),
  Object.freeze({ key: 'v3Factory', address: Object.freeze([UNISWAP_REGISTRY.v3Factory.address]),
    topics: Object.freeze([UNISWAP_EVENT_TOPICS.v3PoolCreated]) }),
  Object.freeze({ key: 'v3Pools', address: null,
    topics: Object.freeze([UNISWAP_EVENT_TOPICS.v3Swap, UNISWAP_EVENT_TOPICS.v3Mint, UNISWAP_EVENT_TOPICS.v3Burn]) }),
  Object.freeze({ key: 'v4', address: Object.freeze([UNISWAP_REGISTRY.v4PoolManager.address]),
    topics: Object.freeze([UNISWAP_EVENT_TOPICS.v4Initialize, UNISWAP_EVENT_TOPICS.v4Swap, UNISWAP_EVENT_TOPICS.v4ModifyLiquidity]),
    maxRange: DENSE_LOG_RANGE_BLOCKS }),
]);

// Which result family each stream feeds. A family is unavailable as soon as any of its streams is.
export const FAMILY_STREAMS = Object.freeze({
  usdc: Object.freeze(['usdc']),
  assets: Object.freeze(['assets']),
  uniswapV3: Object.freeze(['v3Factory', 'v3Pools']),
  uniswapV4: Object.freeze(['v4']),
});

const hex = (number) => `0x${number.toString(16)}`;

export function logFilter(stream, fromBlock, toBlock) {
  return {
    ...(stream.address ? { address: [...stream.address] } : {}),
    topics: [[...stream.topics]],
    fromBlock: hex(fromBlock),
    toBlock: hex(toBlock),
  };
}
