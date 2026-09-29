import { ARC_CHAIN_ID, ARC_RPC_URL, createArcRpcClient } from './rpc.js';
import { mapConcurrent, verifyErc20Metadata } from './tokens.js';

export const UNISWAP_DEFINITION_VERSION = 'arc-intelligence-uniswap-v1';
export const MAX_UNISWAP_POOL_CANDIDATES = 50;
export const MAX_UNISWAP_TOKEN_METADATA_CANDIDATES = 100;

const UNISWAP_SDK_ADDRESS_BOOK = 'https://github.com/Uniswap/sdks/blob/main/sdks/sdk-core/src/addresses.ts#L2491-L2510';

export const UNISWAP_REGISTRY = Object.freeze({
  chainId: ARC_CHAIN_ID,
  v3Factory: Object.freeze({
    address: '0xf0db7b58379503491d857db50ac9ece64c653918',
    source: UNISWAP_SDK_ADDRESS_BOOK,
    sourceKey: 'ARC_ADDRESSES.v3CoreFactoryAddress',
  }),
  v4PoolManager: Object.freeze({
    address: '0x8366a39cc670b4001a1121b8f6a443a643e40951',
    source: UNISWAP_SDK_ADDRESS_BOOK,
    sourceKey: 'ARC_ADDRESSES.v4PoolManagerAddress',
  }),
});

export const UNISWAP_EVENT_TOPICS = Object.freeze({
  v3PoolCreated: '0x783cca1c0412dd0d695e784568c96da2e9c22ff989357a2e8b1d9b2b4e6b7118',
  v3Swap: '0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67',
  v3Mint: '0x7a53080ba414158be7ec69b987b5fb7d07dee101fe85488f0853ae16239d0bde',
  v3Burn: '0x0c396cd989a39f4459b5fa1aed6a9a8dcdbc45908acfd67e028cd568da98982c',
  v4Initialize: '0xdd466e674ea557f56295e2d0218a125ea4b4f0f6f3307b95f85e6110838d6438',
  v4Swap: '0x40e9cecb9f5f1f1c5b9c97dec2917b7ee92e57ba5563708daca94dd84ad7112f',
  v4ModifyLiquidity: '0xf208f4912782fd25c7f114ca3723a2d5dd6f3bcc3ac8db5af63baa85f711d5ec',
});

const FUNCTION_SELECTORS = Object.freeze({
  factory: '0xc45a0155',
  token0: '0x0dfe1681',
  token1: '0xd21220a7',
  fee: '0xddca3f43',
  getPool: '0x1698ee82',
  name: '0x06fdde03',
  symbol: '0x95d89b41',
  decimals: '0x313ce567',
  totalSupply: '0x18160ddd',
});

const ADDRESS = /^0x[0-9a-f]{40}$/i;
const HASH = /^0x[0-9a-f]{64}$/i;
const HEX_DATA = /^0x(?:[0-9a-f]{2})*$/i;
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
const TRANSIENT_RPC_ERROR = /timed out|could not connect|http 429|http 5\d\d|rate.?limit|temporar|overloaded/i;

function toBlockTag(blockNumber) {
  return `0x${blockNumber.toString(16)}`;
}

function topicAddress(topic) {
  if (typeof topic !== 'string' || !/^0x0{24}[0-9a-f]{40}$/i.test(topic)) return null;
  return `0x${topic.slice(-40)}`.toLowerCase();
}

function eventBase(log, type) {
  return {
    type,
    blockNumber: log.blockNumber,
    transactionHash: log.transactionHash?.toLowerCase() ?? null,
    logIndex: log.logIndex,
    emitter: log.address.toLowerCase(),
  };
}

function dataWords(data, expectedCount) {
  if (typeof data !== 'string' || !HEX_DATA.test(data)) return null;
  const hex = data.slice(2);
  if (hex.length !== expectedCount * 64) return null;
  return Array.from({ length: expectedCount }, (_, index) => hex.slice(index * 64, (index + 1) * 64));
}

function topicWord(topic) {
  return typeof topic === 'string' && HASH.test(topic) ? topic.slice(2).toLowerCase() : null;
}

function decodeUnsignedWord(word, bits = 256) {
  if (typeof word !== 'string' || !/^[0-9a-f]{64}$/i.test(word)) return null;
  const value = BigInt(`0x${word}`);
  if (value >= (1n << BigInt(bits))) return null;
  return value;
}

function decodeSignedWord(word, bits) {
  const unsigned = decodeUnsignedWord(word);
  if (unsigned === null) return null;
  const mask = (1n << BigInt(bits)) - 1n;
  const low = unsigned & mask;
  const signBit = 1n << BigInt(bits - 1);
  const signed = low >= signBit ? low - (1n << BigInt(bits)) : low;
  const signExtended = signed < 0n ? signed + (1n << 256n) : signed;
  return signExtended === unsigned ? signed : null;
}

function decodeAddressWord(word) {
  if (typeof word !== 'string' || !/^0{24}[0-9a-f]{40}$/i.test(word)) return null;
  return `0x${word.slice(-40)}`.toLowerCase();
}

function decodeTopicUint(topic, bits = 256) {
  const word = topicWord(topic);
  return word === null ? null : decodeUnsignedWord(word, bits);
}

function decodeTopicInt(topic, bits) {
  const word = topicWord(topic);
  return word === null ? null : decodeSignedWord(word, bits);
}

function isEventLog(log, topic, topicCount, dataWordCount) {
  return log
    && Number.isSafeInteger(log.blockNumber)
    && Number.isSafeInteger(log.logIndex)
    && ADDRESS.test(log.address ?? '')
    && Array.isArray(log.topics)
    && log.topics.length === topicCount
    && log.topics[0]?.toLowerCase() === topic
    && dataWords(log.data, dataWordCount) !== null;
}

export function decodeV3PoolCreated(log) {
  if (!isEventLog(log, UNISWAP_EVENT_TOPICS.v3PoolCreated, 4, 2)) return null;
  const token0 = topicAddress(log.topics[1]);
  const token1 = topicAddress(log.topics[2]);
  const fee = decodeTopicUint(log.topics[3], 24);
  const words = dataWords(log.data, 2);
  const tickSpacing = decodeSignedWord(words[0], 24);
  const pool = decodeAddressWord(words[1]);
  if (!token0 || !token1 || fee === null || tickSpacing === null || !pool || pool === ZERO_ADDRESS) return null;
  return {
    ...eventBase(log, 'pool_created'),
    token0,
    token1,
    fee: Number(fee),
    tickSpacing: Number(tickSpacing),
    pool,
  };
}

function amountDirections(amountRaw) {
  const amount = BigInt(amountRaw);
  return {
    inRaw: amount > 0n ? amount.toString(10) : '0',
    outRaw: amount < 0n ? (-amount).toString(10) : '0',
  };
}

export function decodeV3Swap(log) {
  if (!isEventLog(log, UNISWAP_EVENT_TOPICS.v3Swap, 3, 5)) return null;
  const sender = topicAddress(log.topics[1]);
  const recipient = topicAddress(log.topics[2]);
  const words = dataWords(log.data, 5);
  const amount0 = decodeSignedWord(words[0], 256);
  const amount1 = decodeSignedWord(words[1], 256);
  const sqrtPriceX96 = decodeUnsignedWord(words[2], 160);
  const liquidity = decodeUnsignedWord(words[3], 128);
  const tick = decodeSignedWord(words[4], 24);
  if (!sender || !recipient || amount0 === null || amount1 === null
    || sqrtPriceX96 === null || liquidity === null || tick === null) return null;
  const token0Direction = amountDirections(amount0.toString(10));
  const token1Direction = amountDirections(amount1.toString(10));
  return {
    ...eventBase(log, 'swap'),
    sender,
    recipient,
    amount0Raw: amount0.toString(10),
    amount1Raw: amount1.toString(10),
    token0InRaw: token0Direction.inRaw,
    token0OutRaw: token0Direction.outRaw,
    token1InRaw: token1Direction.inRaw,
    token1OutRaw: token1Direction.outRaw,
    sqrtPriceX96Raw: sqrtPriceX96.toString(10),
    liquidityRaw: liquidity.toString(10),
    tick: Number(tick),
  };
}

export function decodeV3Mint(log) {
  if (!isEventLog(log, UNISWAP_EVENT_TOPICS.v3Mint, 4, 4)) return null;
  const owner = topicAddress(log.topics[1]);
  const tickLower = decodeTopicInt(log.topics[2], 24);
  const tickUpper = decodeTopicInt(log.topics[3], 24);
  const words = dataWords(log.data, 4);
  const sender = decodeAddressWord(words[0]);
  const liquidity = decodeUnsignedWord(words[1], 128);
  const amount0 = decodeUnsignedWord(words[2]);
  const amount1 = decodeUnsignedWord(words[3]);
  if (!owner || !sender || tickLower === null || tickUpper === null
    || liquidity === null || amount0 === null || amount1 === null) return null;
  return {
    ...eventBase(log, 'mint'),
    sender,
    owner,
    tickLower: Number(tickLower),
    tickUpper: Number(tickUpper),
    liquidityRaw: liquidity.toString(10),
    amount0Raw: amount0.toString(10),
    amount1Raw: amount1.toString(10),
  };
}

export function decodeV3Burn(log) {
  if (!isEventLog(log, UNISWAP_EVENT_TOPICS.v3Burn, 4, 3)) return null;
  const owner = topicAddress(log.topics[1]);
  const tickLower = decodeTopicInt(log.topics[2], 24);
  const tickUpper = decodeTopicInt(log.topics[3], 24);
  const words = dataWords(log.data, 3);
  const liquidity = decodeUnsignedWord(words[0], 128);
  const amount0 = decodeUnsignedWord(words[1]);
  const amount1 = decodeUnsignedWord(words[2]);
  if (!owner || tickLower === null || tickUpper === null
    || liquidity === null || amount0 === null || amount1 === null) return null;
  return {
    ...eventBase(log, 'burn'),
    owner,
    tickLower: Number(tickLower),
    tickUpper: Number(tickUpper),
    liquidityRaw: liquidity.toString(10),
    amount0Raw: amount0.toString(10),
    amount1Raw: amount1.toString(10),
  };
}

export function decodeV4Initialize(log) {
  if (!isEventLog(log, UNISWAP_EVENT_TOPICS.v4Initialize, 4, 5)) return null;
  const poolIdWord = topicWord(log.topics[1]);
  const poolId = poolIdWord === null ? null : `0x${poolIdWord}`;
  const currency0 = topicAddress(log.topics[2]);
  const currency1 = topicAddress(log.topics[3]);
  const words = dataWords(log.data, 5);
  const fee = decodeUnsignedWord(words[0], 24);
  const tickSpacing = decodeSignedWord(words[1], 24);
  const hooks = decodeAddressWord(words[2]);
  const sqrtPriceX96 = decodeUnsignedWord(words[3], 160);
  const tick = decodeSignedWord(words[4], 24);
  if (!poolId || !currency0 || !currency1 || fee === null || tickSpacing === null
    || !hooks || sqrtPriceX96 === null || tick === null) return null;
  return {
    ...eventBase(log, 'initialize'),
    poolId,
    currency0,
    currency1,
    fee: Number(fee),
    tickSpacing: Number(tickSpacing),
    hooks,
    sqrtPriceX96Raw: sqrtPriceX96.toString(10),
    tick: Number(tick),
  };
}

export function decodeV4Swap(log) {
  if (!isEventLog(log, UNISWAP_EVENT_TOPICS.v4Swap, 3, 6)) return null;
  const poolIdWord = topicWord(log.topics[1]);
  const poolId = poolIdWord === null ? null : `0x${poolIdWord}`;
  const sender = topicAddress(log.topics[2]);
  const words = dataWords(log.data, 6);
  const amount0 = decodeSignedWord(words[0], 128);
  const amount1 = decodeSignedWord(words[1], 128);
  const sqrtPriceX96 = decodeUnsignedWord(words[2], 160);
  const liquidity = decodeUnsignedWord(words[3], 128);
  const tick = decodeSignedWord(words[4], 24);
  const fee = decodeUnsignedWord(words[5], 24);
  if (!poolId || !sender || amount0 === null || amount1 === null
    || sqrtPriceX96 === null || liquidity === null || tick === null || fee === null) return null;
  return {
    ...eventBase(log, 'swap'),
    poolId,
    sender,
    amount0Raw: amount0.toString(10),
    amount1Raw: amount1.toString(10),
    sqrtPriceX96Raw: sqrtPriceX96.toString(10),
    liquidityRaw: liquidity.toString(10),
    tick: Number(tick),
    fee: Number(fee),
  };
}

export function decodeV4ModifyLiquidity(log) {
  if (!isEventLog(log, UNISWAP_EVENT_TOPICS.v4ModifyLiquidity, 3, 4)) return null;
  const poolIdWord = topicWord(log.topics[1]);
  const poolId = poolIdWord === null ? null : `0x${poolIdWord}`;
  const sender = topicAddress(log.topics[2]);
  const words = dataWords(log.data, 4);
  const tickLower = decodeSignedWord(words[0], 24);
  const tickUpper = decodeSignedWord(words[1], 24);
  const liquidityDelta = decodeSignedWord(words[2], 256);
  const salt = `0x${words[3]}`.toLowerCase();
  if (!poolId || !sender || tickLower === null || tickUpper === null || liquidityDelta === null) return null;
  return {
    ...eventBase(log, 'modify_liquidity'),
    poolId,
    sender,
    tickLower: Number(tickLower),
    tickUpper: Number(tickUpper),
    liquidityDeltaRaw: liquidityDelta.toString(10),
    classification: liquidityDelta > 0n ? 'increase' : liquidityDelta < 0n ? 'decrease' : 'poke',
    salt,
  };
}

function isNormalizedLog(log, startBlock, endBlock) {
  return log && Number.isSafeInteger(log.blockNumber)
    && log.blockNumber >= startBlock && log.blockNumber <= endBlock
    && Number.isSafeInteger(log.logIndex) && log.logIndex >= 0
    && ADDRESS.test(log.address ?? '')
    && HASH.test(log.transactionHash ?? '')
    && Array.isArray(log.topics) && log.topics.every((topic) => HASH.test(topic))
    && typeof log.data === 'string' && HEX_DATA.test(log.data)
    && log.removed !== true;
}

function emptySnapshot(phase1aSnapshot, rpc) {
  const startBlock = Number.isSafeInteger(phase1aSnapshot?.startBlock) ? phase1aSnapshot.startBlock : null;
  const endBlock = Number.isSafeInteger(phase1aSnapshot?.endBlock) ? phase1aSnapshot.endBlock : null;
  return {
    chainId: ARC_CHAIN_ID,
    startBlock,
    endBlock,
    source: phase1aSnapshot?.source ?? rpc.url ?? ARC_RPC_URL,
    definitionVersion: UNISWAP_DEFINITION_VERSION,
    phase1aSnapshotComplete: false,
    v3: {
      factory: UNISWAP_REGISTRY.v3Factory.address,
      factoryCodeVerified: false,
      poolCreatedCount: null,
      poolCreated: [],
      candidateSwapEmitters: [],
      verifiedSwapPools: [],
      rejectedSwapEmitters: [],
      swapEventCount: null,
      mintEventCount: null,
      burnEventCount: null,
      poolsWithSwaps: null,
      rawPoolFlows: [],
      tokenMetadataComplete: false,
      complete: false,
      warnings: [],
    },
    v4: {
      poolManager: UNISWAP_REGISTRY.v4PoolManager.address,
      poolManagerCodeVerified: false,
      initializeEventCount: null,
      knownPoolIds: [],
      poolKeys: [],
      swapEventCount: null,
      swapEvents: [],
      modifyLiquidityEventCount: null,
      modifyLiquidityEvents: [],
      unknownPoolIdSwapCount: null,
      unknownPoolIdModifyLiquidityCount: null,
      swapEventScanComplete: false,
      eventScanComplete: false,
      poolMetadataComplete: false,
      historicalPoolRegistryComplete: false,
      tokenMetadataComplete: false,
      warnings: [],
    },
    tokenMetadata: [],
    metadataComplete: false,
    complete: false,
    warnings: [],
  };
}

function codeIsPresent(code) {
  return typeof code === 'string' && /^0x(?!0*$)[0-9a-f]+$/i.test(code);
}

async function inspectCode(rpc, address, blockTag) {
  try {
    return codeIsPresent(await rpc.request('eth_getCode', [address, blockTag])) ? 'present' : 'absent';
  } catch {
    return 'unavailable';
  }
}

async function call(rpc, address, data, blockTag) {
  try {
    return { ok: true, result: await rpc.request('eth_call', [{ to: address, data }, blockTag]) };
  } catch (error) {
    return { ok: false, transient: TRANSIENT_RPC_ERROR.test(error?.message ?? '') };
  }
}

function addressCall(rpc, address, selector, blockTag) {
  return call(rpc, address, selector, blockTag);
}

function isWordResult(result) {
  return typeof result === 'string' && /^0x[0-9a-f]{64}$/i.test(result);
}

function addressWord(address) {
  return address.slice(2).toLowerCase().padStart(64, '0');
}

function uintWord(value) {
  return BigInt(value).toString(16).padStart(64, '0');
}

async function verifyV3Pool(rpc, address, blockTag, factoryCodeVerified) {
  if (!factoryCodeVerified) return { status: 'unavailable', reason: 'official factory bytecode is not verified' };
  const poolCode = await inspectCode(rpc, address, blockTag);
  if (poolCode === 'unavailable') return { status: 'unavailable', reason: 'pool bytecode read was unavailable' };
  if (poolCode === 'absent') return { status: 'rejected', reason: 'no pool bytecode at requested end block' };

  const getterResults = await Promise.all([
    addressCall(rpc, address, FUNCTION_SELECTORS.factory, blockTag),
    addressCall(rpc, address, FUNCTION_SELECTORS.token0, blockTag),
    addressCall(rpc, address, FUNCTION_SELECTORS.token1, blockTag),
    addressCall(rpc, address, FUNCTION_SELECTORS.fee, blockTag),
  ]);
  if (getterResults.some((result) => !result.ok)) {
    return getterResults.some((result) => result.transient)
      ? { status: 'unavailable', reason: 'pool getter RPC read was unavailable' }
      : { status: 'rejected', reason: 'required V3 pool getters did not respond' };
  }

  const factory = isWordResult(getterResults[0].result) ? decodeAddressWord(getterResults[0].result.slice(2)) : null;
  const token0 = isWordResult(getterResults[1].result) ? decodeAddressWord(getterResults[1].result.slice(2)) : null;
  const token1 = isWordResult(getterResults[2].result) ? decodeAddressWord(getterResults[2].result.slice(2)) : null;
  const fee = isWordResult(getterResults[3].result) ? decodeUnsignedWord(getterResults[3].result.slice(2), 24) : null;
  if (!factory || !token0 || !token1 || token0 === token1 || fee === null) {
    return { status: 'rejected', reason: 'V3 pool getter response was malformed' };
  }
  if (factory !== UNISWAP_REGISTRY.v3Factory.address) {
    return { status: 'rejected', reason: 'pool factory() does not match the official V3 factory' };
  }

  const getPoolData = `${FUNCTION_SELECTORS.getPool}${addressWord(token0)}${addressWord(token1)}${uintWord(fee)}`;
  const mappingResult = await call(rpc, UNISWAP_REGISTRY.v3Factory.address, getPoolData, blockTag);
  if (!mappingResult.ok) {
    return mappingResult.transient
      ? { status: 'unavailable', reason: 'official factory getPool RPC read was unavailable' }
      : { status: 'unavailable', reason: 'official factory getPool could not be read' };
  }
  const mappedPool = isWordResult(mappingResult.result) ? decodeAddressWord(mappingResult.result.slice(2)) : null;
  if (!mappedPool || mappedPool !== address) {
    return { status: 'rejected', reason: 'official factory getPool() does not resolve to this emitter' };
  }
  return { status: 'verified', address, token0, token1, fee: Number(fee), factory };
}

function tokenMetadataView(address, metadataByAddress) {
  const record = metadataByAddress.get(address);
  return {
    address,
    status: record?.status ?? 'unknown/unverified',
    symbol: record?.status === 'verified' ? record.symbol : null,
    decimals: record?.status === 'verified' ? record.decimals : null,
  };
}

function currencyView(address, metadataByAddress) {
  if (address === ZERO_ADDRESS) {
    return { address, kind: 'native', symbol: 'native USDC', decimals: 18, status: 'chain_native_asset' };
  }
  return { kind: 'erc20', ...tokenMetadataView(address, metadataByAddress) };
}

async function inspectTokenMetadata(rpc, addresses, blockTag, concurrency) {
  const uniqueAddresses = [...new Set(addresses.filter((address) => address && address !== ZERO_ADDRESS))].sort();
  const selected = uniqueAddresses.slice(0, MAX_UNISWAP_TOKEN_METADATA_CANDIDATES);
  const records = await mapConcurrent(selected, concurrency, (address) => verifyErc20Metadata(rpc, address, { blockTag }));
  const byAddress = new Map(records.filter((record) => record.address).map((record) => [record.address, record]));
  const unavailableAddresses = uniqueAddresses.filter((address) => byAddress.get(address)?.status !== 'verified');
  const truncatedAddresses = uniqueAddresses.slice(selected.length);
  return {
    records,
    byAddress,
    complete: unavailableAddresses.length === 0 && truncatedAddresses.length === 0,
    unavailableAddresses,
    truncatedAddresses,
  };
}

function compareEventOrder(left, right) {
  return left.blockNumber - right.blockNumber
    || (left.transactionIndex ?? 0) - (right.transactionIndex ?? 0)
    || left.logIndex - right.logIndex;
}

function uniqueWarnings(warnings) {
  return [...new Set(warnings)];
}

export async function buildUniswapBoundedSnapshot({
  phase1aSnapshot,
  rpc = createArcRpcClient(),
  maxPoolCandidates = MAX_UNISWAP_POOL_CANDIDATES,
  metadataConcurrency = 3,
} = {}) {
  const result = emptySnapshot(phase1aSnapshot, rpc);
  const warnings = result.warnings;
  if (!Number.isSafeInteger(maxPoolCandidates) || maxPoolCandidates < 0 || maxPoolCandidates > 1000) {
    throw new RangeError('maxPoolCandidates must be between 0 and 1000');
  }
  if (!Number.isSafeInteger(metadataConcurrency) || metadataConcurrency < 1 || metadataConcurrency > 8) {
    throw new RangeError('metadataConcurrency must be between 1 and 8');
  }

  const rangeValid = Number.isSafeInteger(result.startBlock)
    && Number.isSafeInteger(result.endBlock)
    && result.startBlock >= 0
    && result.endBlock >= result.startBlock;
  const logsValid = Array.isArray(phase1aSnapshot?.logs)
    && rangeValid
    && phase1aSnapshot.logs.every((log) => isNormalizedLog(log, result.startBlock, result.endBlock));
  const phase1aComplete = phase1aSnapshot?.complete === true
    && phase1aSnapshot?.chainId === ARC_CHAIN_ID
    && phase1aSnapshot?.lastIndexedBlock === result.endBlock
    && logsValid;
  if (!phase1aComplete) {
    warnings.push('A complete Phase 1A Arc snapshot with normalized receipt logs is required.');
    return result;
  }
  result.phase1aSnapshotComplete = true;

  const logs = phase1aSnapshot.logs.slice().sort(compareEventOrder);
  const blockTag = toBlockTag(result.endBlock);
  const [factoryCodeStatus, poolManagerCodeStatus] = await Promise.all([
    inspectCode(rpc, UNISWAP_REGISTRY.v3Factory.address, blockTag),
    inspectCode(rpc, UNISWAP_REGISTRY.v4PoolManager.address, blockTag),
  ]);
  const factoryCodeVerified = factoryCodeStatus === 'present';
  const poolManagerCodeVerified = poolManagerCodeStatus === 'present';
  result.v3.factoryCodeVerified = factoryCodeVerified;
  result.v4.poolManagerCodeVerified = poolManagerCodeVerified;
  if (!factoryCodeVerified) result.v3.warnings.push('Official V3 factory bytecode could not be verified at requestedEnd.');
  if (!poolManagerCodeVerified) result.v4.warnings.push('Official V4 PoolManager bytecode could not be verified at requestedEnd.');

  const v3FactoryLogs = logs.filter((log) => log.address.toLowerCase() === UNISWAP_REGISTRY.v3Factory.address
    && log.topics[0]?.toLowerCase() === UNISWAP_EVENT_TOPICS.v3PoolCreated);
  const poolCreated = factoryCodeVerified ? v3FactoryLogs.map(decodeV3PoolCreated) : [];
  const malformedPoolCreatedCount = factoryCodeVerified ? poolCreated.filter((event) => event === null).length : 0;
  result.v3.poolCreated = poolCreated.filter(Boolean);
  result.v3.poolCreatedCount = factoryCodeVerified ? result.v3.poolCreated.length : null;
  if (malformedPoolCreatedCount > 0) {
    result.v3.warnings.push(`${malformedPoolCreatedCount} official V3 PoolCreated log(s) were malformed.`);
  }

  const v3SwapLogs = logs.filter((log) => log.topics[0]?.toLowerCase() === UNISWAP_EVENT_TOPICS.v3Swap);
  const v3LiquidityLogs = logs.filter((log) => [UNISWAP_EVENT_TOPICS.v3Mint, UNISWAP_EVENT_TOPICS.v3Burn]
    .includes(log.topics[0]?.toLowerCase()));
  const candidateSwapEmitters = [...new Set(v3SwapLogs.map((log) => log.address.toLowerCase()))].sort();
  const allV3EventEmitters = [...new Set([...v3SwapLogs, ...v3LiquidityLogs].map((log) => log.address.toLowerCase()))].sort();
  const selectedV3Emitters = allV3EventEmitters.slice(0, maxPoolCandidates);
  const poolVerifications = await mapConcurrent(selectedV3Emitters, Math.min(metadataConcurrency, 4), (address) =>
    verifyV3Pool(rpc, address, blockTag, factoryCodeVerified));
  const verifiedPoolByAddress = new Map(poolVerifications
    .filter((pool) => pool.status === 'verified')
    .map((pool) => [pool.address, pool]));
  const verificationByAddress = new Map(selectedV3Emitters.map((address, index) => [address, poolVerifications[index]]));
  const candidateScanComplete = selectedV3Emitters.length === allV3EventEmitters.length;
  const candidateVerificationComplete = poolVerifications.every((pool) => pool.status !== 'unavailable');
  result.v3.candidateSwapEmitters = candidateSwapEmitters;
  result.v3.verifiedSwapPools = candidateSwapEmitters
    .map((address) => verifiedPoolByAddress.get(address))
    .filter(Boolean)
    .map((pool) => ({ address: pool.address, token0: pool.token0, token1: pool.token1, fee: pool.fee }));
  result.v3.rejectedSwapEmitters = candidateSwapEmitters
    .filter((address) => !verifiedPoolByAddress.has(address))
    .map((address) => ({
      address,
      status: verificationByAddress.get(address)?.status ?? 'unavailable',
      reason: verificationByAddress.get(address)?.reason ?? 'candidate limit reached',
    }));
  result.v3.rejectedLiquidityEmitters = allV3EventEmitters
    .filter((address) => !candidateSwapEmitters.includes(address) && !verifiedPoolByAddress.has(address))
    .map((address) => ({
      address,
      status: verificationByAddress.get(address)?.status ?? 'unavailable',
      reason: verificationByAddress.get(address)?.reason ?? 'candidate limit reached',
    }));
  if (!candidateScanComplete) result.v3.warnings.push('V3 pool emitter candidate limit reached; remaining emitters were not verified.');
  if (!candidateVerificationComplete) result.v3.warnings.push('One or more V3 pool emitter checks were unavailable; raw pool metrics may be incomplete.');

  const verifiedV3EventLogs = logs.filter((log) => verifiedPoolByAddress.has(log.address.toLowerCase()));
  const v3SwapEvents = [];
  const v3LiquidityEvents = [];
  let malformedV3SwapCount = 0;
  let malformedV3LiquidityCount = 0;
  for (const log of verifiedV3EventLogs) {
    const topic = log.topics[0]?.toLowerCase();
    if (topic === UNISWAP_EVENT_TOPICS.v3Swap) {
      const decoded = decodeV3Swap(log);
      if (decoded) v3SwapEvents.push({ ...decoded, pool: log.address.toLowerCase() });
      else malformedV3SwapCount += 1;
    } else if (topic === UNISWAP_EVENT_TOPICS.v3Mint) {
      const decoded = decodeV3Mint(log);
      if (decoded) v3LiquidityEvents.push({ ...decoded, pool: log.address.toLowerCase() });
      else malformedV3LiquidityCount += 1;
    } else if (topic === UNISWAP_EVENT_TOPICS.v3Burn) {
      const decoded = decodeV3Burn(log);
      if (decoded) v3LiquidityEvents.push({ ...decoded, pool: log.address.toLowerCase() });
      else malformedV3LiquidityCount += 1;
    }
  }
  const verifiedPoolTokens = [...verifiedPoolByAddress.values()].flatMap((pool) => [pool.token0, pool.token1]);

  const v4EventTopics = new Set([
    UNISWAP_EVENT_TOPICS.v4Initialize,
    UNISWAP_EVENT_TOPICS.v4Swap,
    UNISWAP_EVENT_TOPICS.v4ModifyLiquidity,
  ]);
  const v4Logs = logs.filter((log) => log.address.toLowerCase() === UNISWAP_REGISTRY.v4PoolManager.address
    && v4EventTopics.has(log.topics[0]?.toLowerCase()));
  const initializeLogs = v4Logs.filter((log) => log.topics[0].toLowerCase() === UNISWAP_EVENT_TOPICS.v4Initialize);
  const v4SwapLogs = v4Logs.filter((log) => log.topics[0].toLowerCase() === UNISWAP_EVENT_TOPICS.v4Swap);
  const modifyLiquidityLogs = v4Logs.filter((log) => log.topics[0].toLowerCase() === UNISWAP_EVENT_TOPICS.v4ModifyLiquidity);
  const initializeEvents = poolManagerCodeVerified ? initializeLogs.map(decodeV4Initialize) : [];
  const swapEvents = poolManagerCodeVerified ? v4SwapLogs.map(decodeV4Swap) : [];
  const modifyLiquidityEvents = poolManagerCodeVerified ? modifyLiquidityLogs.map(decodeV4ModifyLiquidity) : [];
  const malformedInitializeCount = poolManagerCodeVerified ? initializeEvents.filter((event) => event === null).length : 0;
  const malformedV4SwapCount = poolManagerCodeVerified ? swapEvents.filter((event) => event === null).length : 0;
  const malformedModifyLiquidityCount = poolManagerCodeVerified ? modifyLiquidityEvents.filter((event) => event === null).length : 0;
  const poolKeyById = new Map();
  let conflictingPoolKeyCount = 0;
  for (const event of initializeEvents.filter(Boolean)) {
    const poolKey = {
      poolId: event.poolId,
      currency0: event.currency0,
      currency1: event.currency1,
      fee: event.fee,
      tickSpacing: event.tickSpacing,
      hooks: event.hooks,
      initializedAtBlock: event.blockNumber,
      metadataProvenance: 'bounded_window_initialize_event',
      globalHistoryComplete: false,
    };
    const existing = poolKeyById.get(event.poolId);
    if (existing && (existing.currency0 !== poolKey.currency0
      || existing.currency1 !== poolKey.currency1
      || existing.fee !== poolKey.fee
      || existing.tickSpacing !== poolKey.tickSpacing
      || existing.hooks !== poolKey.hooks)) {
      conflictingPoolKeyCount += 1;
      continue;
    }
    if (!existing) poolKeyById.set(event.poolId, poolKey);
  }
  const unknownPoolIdSwapCount = swapEvents.filter((event) => event && !poolKeyById.has(event.poolId)).length;
  const unknownPoolIdModifyLiquidityCount = modifyLiquidityEvents
    .filter((event) => event && !poolKeyById.has(event.poolId)).length;
  const knownV4PoolTokens = [...poolKeyById.values()].flatMap((poolKey) => [poolKey.currency0, poolKey.currency1]);
  const allTokenAddresses = [...verifiedPoolTokens, ...knownV4PoolTokens];
  const tokenMetadata = await inspectTokenMetadata(rpc, allTokenAddresses, blockTag, metadataConcurrency);
  result.tokenMetadata = tokenMetadata.records.map((record) => ({
    address: record.address,
    status: record.status,
    symbol: record.status === 'verified' ? record.symbol : null,
    decimals: record.status === 'verified' ? record.decimals : null,
  }));
  result.metadataComplete = tokenMetadata.complete;
  if (!tokenMetadata.complete) {
    const unavailableCount = tokenMetadata.unavailableAddresses.length;
    const truncatedCount = tokenMetadata.truncatedAddresses.length;
    warnings.push(`ERC-20 metadata incomplete at requestedEnd: ${unavailableCount} unavailable and ${truncatedCount} beyond the bounded candidate limit; raw amounts are preserved.`);
  }

  const poolWithSwapAddresses = new Set(v3SwapEvents.map((event) => event.pool));
  const token0MetaByPool = new Map();
  for (const pool of verifiedPoolByAddress.values()) {
    token0MetaByPool.set(pool.address, {
      token0: tokenMetadataView(pool.token0, tokenMetadata.byAddress),
      token1: tokenMetadataView(pool.token1, tokenMetadata.byAddress),
    });
  }
  result.v3.poolsWithSwaps = poolWithSwapAddresses.size;
  result.v3.mintEventCount = v3LiquidityEvents.filter((event) => event.type === 'mint').length;
  result.v3.burnEventCount = v3LiquidityEvents.filter((event) => event.type === 'burn').length;
  result.v3.rawPoolFlows = [
    ...v3SwapEvents.map((event) => ({
      protocol: 'uniswap_v3',
      ...event,
      ...token0MetaByPool.get(event.pool),
    })),
    ...v3LiquidityEvents.map((event) => ({
      protocol: 'uniswap_v3',
      ...event,
      ...token0MetaByPool.get(event.pool),
    })),
  ].sort(compareEventOrder);
  result.v3.swapEventCount = v3SwapEvents.length;
  result.v3.tokenMetadataComplete = verifiedPoolTokens.every((address) => tokenMetadata.byAddress.get(address)?.status === 'verified');
  result.v3.complete = factoryCodeVerified
    && phase1aComplete
    && candidateScanComplete
    && candidateVerificationComplete
    && malformedPoolCreatedCount === 0
    && malformedV3SwapCount === 0
    && malformedV3LiquidityCount === 0;
  if (malformedV3SwapCount > 0) result.v3.warnings.push(`${malformedV3SwapCount} Swap log(s) from verified V3 pools were malformed.`);
  if (malformedV3LiquidityCount > 0) result.v3.warnings.push(`${malformedV3LiquidityCount} Mint/Burn log(s) from verified V3 pools were malformed.`);

  const v4SwapEventsWithIdentity = swapEvents.filter(Boolean).map((event) => {
    const poolKey = poolKeyById.get(event.poolId);
    if (!poolKey) return { ...event, poolIdentityStatus: 'unavailable', pair: null };
    return {
      ...event,
      poolIdentityStatus: 'known',
      pair: {
        currency0: currencyView(poolKey.currency0, tokenMetadata.byAddress),
        currency1: currencyView(poolKey.currency1, tokenMetadata.byAddress),
      },
    };
  });
  result.v4.initializeEventCount = poolManagerCodeVerified ? initializeEvents.filter(Boolean).length : null;
  result.v4.knownPoolIds = [...poolKeyById.keys()].sort();
  result.v4.poolKeys = [...poolKeyById.values()].sort((left, right) => left.poolId.localeCompare(right.poolId));
  result.v4.swapEventCount = poolManagerCodeVerified ? v4SwapEventsWithIdentity.length : null;
  result.v4.swapEvents = v4SwapEventsWithIdentity;
  result.v4.modifyLiquidityEventCount = poolManagerCodeVerified ? modifyLiquidityEvents.filter(Boolean).length : null;
  result.v4.modifyLiquidityEvents = modifyLiquidityEvents.filter(Boolean);
  result.v4.unknownPoolIdSwapCount = poolManagerCodeVerified ? unknownPoolIdSwapCount : null;
  result.v4.unknownPoolIdModifyLiquidityCount = poolManagerCodeVerified ? unknownPoolIdModifyLiquidityCount : null;
  result.v4.swapEventScanComplete = phase1aComplete && poolManagerCodeVerified && malformedV4SwapCount === 0;
  result.v4.eventScanComplete = phase1aComplete && poolManagerCodeVerified
    && malformedInitializeCount === 0
    && malformedV4SwapCount === 0
    && malformedModifyLiquidityCount === 0;
  result.v4.poolMetadataComplete = poolManagerCodeVerified
    && malformedInitializeCount === 0
    && conflictingPoolKeyCount === 0
    && unknownPoolIdSwapCount === 0
    && unknownPoolIdModifyLiquidityCount === 0;
  result.v4.historicalPoolRegistryComplete = false;
  result.v4.tokenMetadataComplete = knownV4PoolTokens
    .filter((address) => address !== ZERO_ADDRESS)
    .every((address) => tokenMetadata.byAddress.get(address)?.status === 'verified');
  if (malformedInitializeCount > 0) result.v4.warnings.push(`${malformedInitializeCount} Initialize log(s) from the official PoolManager were malformed.`);
  if (malformedV4SwapCount > 0) result.v4.warnings.push(`${malformedV4SwapCount} Swap log(s) from the official PoolManager were malformed.`);
  if (malformedModifyLiquidityCount > 0) result.v4.warnings.push(`${malformedModifyLiquidityCount} ModifyLiquidity log(s) from the official PoolManager were malformed.`);
  if (conflictingPoolKeyCount > 0) result.v4.warnings.push('Conflicting Initialize metadata was observed for a V4 poolId.');
  if (unknownPoolIdSwapCount > 0) {
    result.v4.warnings.push(`${unknownPoolIdSwapCount} V4 Swap event(s) have no Initialize PoolKey in this bounded window; raw poolId and deltas remain available.`);
  }
  if (unknownPoolIdModifyLiquidityCount > 0) {
    result.v4.warnings.push(`${unknownPoolIdModifyLiquidityCount} V4 ModifyLiquidity event(s) have no Initialize PoolKey in this bounded window; raw poolId and liquidity deltas remain available.`);
  }
  result.v4.warnings.push('V4 PoolKey metadata is indexed only from Initialize events in this bounded window; the historical pool registry is incomplete.');

  result.v3.warnings = uniqueWarnings(result.v3.warnings);
  result.v4.warnings = uniqueWarnings(result.v4.warnings);
  warnings.push(...result.v3.warnings, ...result.v4.warnings);
  result.complete = result.v3.complete && result.v4.eventScanComplete;
  result.warnings = uniqueWarnings(warnings);
  return result;
}
