// Compact engine: the only log streams it ever requests. Every stream is filtered by topic and, where the emitter is
// known in advance, by address. Definitions come from the existing verified registries; nothing here is new semantics.
import { ARC_VERIFIED_ASSETS } from '../../api/_lib/arc-intelligence/assets.js';
import { TRANSFER_TOPIC, USDC_SYSTEM_EMITTER } from '../../api/_lib/arc-intelligence/usdc.js';
import { UNISWAP_DEFINITION_VERSION, UNISWAP_EVENT_TOPICS, UNISWAP_REGISTRY } from '../../api/_lib/arc-intelligence/uniswap.js';
import { PROTOCOL_FAMILIES } from './protocols/index.js';

// v2: lean spine (calldata and value are no longer parsed), per-response log streaming, Uniswap V3 pools from the
// official factory registry (foreign V3-signature emitters are counted, never fatal), per-family availability.
// The hour definition covers the spine and network metrics only; each family carries its own version below, so adding a
// family never changes a stored hour's network hash.
export const COMPACT_DEFINITION_VERSION = 'arc-compact-hour-v2';

// Definition version of every family, recorded once per database (store.js): a stored family row was always produced
// by this definition, and a database written under another one is refused rather than silently mixed.
export const FAMILY_VERSIONS = Object.freeze({
  usdc: 'canonical-system-emitter-v1',
  assets: 'verified-asset-transfers-v1',
  uniswapV3: `${UNISWAP_DEFINITION_VERSION}+official-factory-pool-created-registry-v1`,
  uniswapV4: UNISWAP_DEFINITION_VERSION,
  ...Object.fromEntries(PROTOCOL_FAMILIES.map((family) => [family.name, family.version])),
});

export const COMPACT_SOURCE_VERSIONS = Object.freeze({
  hour: COMPACT_DEFINITION_VERSION,
  usdc: FAMILY_VERSIONS.usdc,
  uniswap: UNISWAP_DEFINITION_VERSION,
  uniswapV3Pools: 'official-factory-pool-created-registry-v1',
  families: FAMILY_VERSIONS,
});

const NON_USDC_ASSET_ADDRESSES = ARC_VERIFIED_ASSETS.filter((asset) => asset.symbol !== 'USDC').map((asset) => asset.address.toLowerCase());

// Dense streams (several logs per block) are never requested over more than this many blocks per call.
export const DENSE_LOG_RANGE_BLOCKS = 500;

// address: null means topic-only: every V3-signature emitter on Arc. Only pools in the official factory registry (or
// created earlier in the same hour) are counted; any other emitter is reported as foreign.
// maxRange: per-request block cap before any provider-limit split; sparse streams follow the window size.
export const LOG_STREAMS = Object.freeze([
  Object.freeze({ key: 'usdc', address: Object.freeze([USDC_SYSTEM_EMITTER.toLowerCase()]), topics: Object.freeze([TRANSFER_TOPIC]),
    maxRange: DENSE_LOG_RANGE_BLOCKS }),
  Object.freeze({ key: 'assets', address: Object.freeze(NON_USDC_ASSET_ADDRESSES), topics: Object.freeze([TRANSFER_TOPIC]) }),
  Object.freeze({ key: 'v3Factory', address: Object.freeze([UNISWAP_REGISTRY.v3Factory.address]),
    topics: Object.freeze([UNISWAP_EVENT_TOPICS.v3PoolCreated]) }),
  Object.freeze({ key: 'v3Pools', address: null,
    topics: Object.freeze([UNISWAP_EVENT_TOPICS.v3Swap, UNISWAP_EVENT_TOPICS.v3Mint, UNISWAP_EVENT_TOPICS.v3Burn]),
    maxRange: DENSE_LOG_RANGE_BLOCKS }),
  Object.freeze({ key: 'v4', address: Object.freeze([UNISWAP_REGISTRY.v4PoolManager.address]),
    topics: Object.freeze([UNISWAP_EVENT_TOPICS.v4Initialize, UNISWAP_EVENT_TOPICS.v4Swap, UNISWAP_EVENT_TOPICS.v4ModifyLiquidity]),
    maxRange: DENSE_LOG_RANGE_BLOCKS }),
  // Protocol families (protocols/index.js): official emitters, sparse; topic-only streams take the dense cap.
  ...PROTOCOL_FAMILIES.flatMap((family) => family.streams.map((stream) => Object.freeze({ key: stream.key,
    address: stream.address ? Object.freeze([...stream.address]) : null, topics: Object.freeze([...stream.topics]),
    ...(stream.dense ? { maxRange: DENSE_LOG_RANGE_BLOCKS } : {}) }))),
]);

// Uniswap V4 pool registry only (registry.js): Initialize alone, sparse, so each request may cover the provider maximum
// (10,000 blocks). Deliberately not in LOG_STREAMS: the hour processor already receives Initialize through `v4`.
export const V4_INITIALIZE_STREAM = Object.freeze({ key: 'v4Initialize', address: Object.freeze([UNISWAP_REGISTRY.v4PoolManager.address]),
  topics: Object.freeze([UNISWAP_EVENT_TOPICS.v4Initialize]) });

// Which result family each stream feeds. A family is unavailable as soon as any of its streams is.
export const FAMILY_STREAMS = Object.freeze({
  usdc: Object.freeze(['usdc']),
  assets: Object.freeze(['assets']),
  uniswapV3: Object.freeze(['v3Factory', 'v3Pools']),
  uniswapV4: Object.freeze(['v4']),
  ...Object.fromEntries(PROTOCOL_FAMILIES.map((family) => [family.name, Object.freeze(family.streams.map((stream) => stream.key))])),
});
if (new Set(LOG_STREAMS.map((stream) => stream.key)).size !== LOG_STREAMS.length) throw new Error('duplicate_log_stream_key');

const hex = (number) => `0x${number.toString(16)}`;

export function logFilter(stream, fromBlock, toBlock) {
  return {
    ...(stream.address ? { address: [...stream.address] } : {}),
    topics: [[...stream.topics]],
    fromBlock: hex(fromBlock),
    toBlock: hex(toBlock),
  };
}
