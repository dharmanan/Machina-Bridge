import assert from 'node:assert/strict';
import { buildLatestSnapshot } from '../api/_lib/arc-intelligence/core.js';
import { ARC_CHAIN_ID, ARC_RPC_URL, createArcRpcClient } from '../api/_lib/arc-intelligence/rpc.js';
import {
  buildUniswapBoundedSnapshot,
  decodeV3PoolCreated,
  decodeV3Swap,
  decodeV4Initialize,
  decodeV4ModifyLiquidity,
  decodeV4Swap,
  UNISWAP_EVENT_TOPICS,
  UNISWAP_REGISTRY,
} from '../api/_lib/arc-intelligence/uniswap.js';

const TOKEN0 = '0x0000000000000000000000000000000000000011';
const TOKEN1 = '0x0000000000000000000000000000000000000022';
const V3_POOL = '0x0000000000000000000000000000000000000033';
const FAKE_POOL = '0x0000000000000000000000000000000000000044';
const OTHER_FACTORY = '0x0000000000000000000000000000000000000055';
const V4_NATIVE_USDC = '0x0000000000000000000000000000000000000000';
const V4_ERC20_USDC = '0x3600000000000000000000000000000000000000';
const ROUTER_SENDER = '0x4fca4a51ab4f23a7447b3284fbd7d73289a89fb1';
const HISTORICAL_END_TAG = '0x65';

function word(value, bits = 256) {
  const integer = BigInt(value);
  if (integer < 0n) {
    assert.ok(integer >= -(1n << BigInt(bits - 1)));
    return ((1n << 256n) + integer).toString(16).padStart(64, '0');
  }
  assert.ok(integer < (1n << BigInt(bits)));
  return integer.toString(16).padStart(64, '0');
}

function addressWord(address) {
  return address.slice(2).toLowerCase().padStart(64, '0');
}

function addressTopic(address) {
  return `0x${address.slice(2).toLowerCase().padStart(64, '0')}`;
}

function bytes32Text(value) {
  const bytes = Array.from(new TextEncoder().encode(value), (byte) => byte.toString(16).padStart(2, '0')).join('');
  assert.ok(bytes.length <= 64);
  return `0x${bytes.padEnd(64, '0')}`;
}

function eventLog(address, topics, data, logIndex, blockNumber = 101) {
  return {
    address: address.toLowerCase(),
    topics: topics.map((topic) => topic.toLowerCase()),
    data: data.toLowerCase(),
    blockNumber,
    transactionIndex: 0,
    logIndex,
    transactionHash: `0x${String(logIndex + 1).padStart(64, '0')}`,
    blockHash: `0x${'ab'.repeat(32)}`,
    removed: false,
  };
}

function fixtureV3PoolCreated() {
  return eventLog(UNISWAP_REGISTRY.v3Factory.address, [
    UNISWAP_EVENT_TOPICS.v3PoolCreated,
    addressTopic(TOKEN0),
    addressTopic(TOKEN1),
    `0x${word(3000)}`,
  ], `0x${word(60, 24)}${addressWord(V3_POOL)}`, 0);
}

function fixtureV3Swap(pool, logIndex, sender = ROUTER_SENDER) {
  return eventLog(pool, [UNISWAP_EVENT_TOPICS.v3Swap, addressTopic(sender), addressTopic(TOKEN1)],
    `0x${word(-12345)}${word(678)}${word(1n << 96n, 160)}${word(777, 128)}${word(-12, 24)}`, logIndex);
}

function fixtureV3Mint() {
  return eventLog(V3_POOL, [
    UNISWAP_EVENT_TOPICS.v3Mint,
    addressTopic(TOKEN1),
    `0x${word(-120)}`,
    `0x${word(120)}`,
  ], `0x${addressWord(ROUTER_SENDER)}${word(100, 128)}${word(1000)}${word(2000)}`, 3);
}

function fixtureV3Burn() {
  return eventLog(V3_POOL, [
    UNISWAP_EVENT_TOPICS.v3Burn,
    addressTopic(TOKEN1),
    `0x${word(-120)}`,
    `0x${word(120)}`,
  ], `0x${word(40, 128)}${word(400)}${word(800)}`, 4);
}

const KNOWN_V4_POOL_ID = `0x${'aa'.repeat(32)}`;
const UNKNOWN_V4_POOL_ID = `0x${'bb'.repeat(32)}`;

function fixtureV4Initialize() {
  return eventLog(UNISWAP_REGISTRY.v4PoolManager.address, [
    UNISWAP_EVENT_TOPICS.v4Initialize,
    KNOWN_V4_POOL_ID,
    addressTopic(V4_NATIVE_USDC),
    addressTopic(V4_ERC20_USDC),
  ], `0x${word(500, 24)}${word(10, 24)}${addressWord(V4_NATIVE_USDC)}${word(1n << 96n, 160)}${word(0, 24)}`, 5);
}

function fixtureV4Swap(poolId, logIndex, amount0, amount1) {
  return eventLog(UNISWAP_REGISTRY.v4PoolManager.address, [
    UNISWAP_EVENT_TOPICS.v4Swap,
    poolId,
    addressTopic(ROUTER_SENDER),
  ], `0x${word(amount0, 128)}${word(amount1, 128)}${word(1n << 96n, 160)}${word(900, 128)}${word(-2, 24)}${word(500, 24)}`, logIndex);
}

function fixtureV4ModifyLiquidity(delta, logIndex) {
  return eventLog(UNISWAP_REGISTRY.v4PoolManager.address, [
    UNISWAP_EVENT_TOPICS.v4ModifyLiquidity,
    KNOWN_V4_POOL_ID,
    addressTopic(ROUTER_SENDER),
  ], `0x${word(-10, 24)}${word(10, 24)}${word(delta)}${'cd'.repeat(32)}`, logIndex);
}

function makeFixtureRpc() {
  const calls = [];
  const codeAddresses = new Set([
    UNISWAP_REGISTRY.v3Factory.address,
    UNISWAP_REGISTRY.v4PoolManager.address,
    V3_POOL,
    FAKE_POOL,
    TOKEN0,
    TOKEN1,
    V4_ERC20_USDC,
  ]);
  const rpc = {
    url: 'fixture://uniswap-arc',
    async request(method, params) {
      calls.push({ method, params });
      if (method === 'eth_getCode') {
        return codeAddresses.has(String(params[0]).toLowerCase()) ? '0x6000' : '0x';
      }
      if (method !== 'eth_call') throw new Error(`Unexpected fixture RPC method: ${method}`);
      const to = String(params[0]?.to).toLowerCase();
      const data = String(params[0]?.data).toLowerCase();
      if (to === V3_POOL || to === FAKE_POOL) {
        if (data === '0xc45a0155') return `0x${addressWord(to === V3_POOL ? UNISWAP_REGISTRY.v3Factory.address : OTHER_FACTORY)}`;
        if (data === '0x0dfe1681') return `0x${addressWord(TOKEN0)}`;
        if (data === '0xd21220a7') return `0x${addressWord(TOKEN1)}`;
        if (data === '0xddca3f43') return `0x${word(3000, 24)}`;
      }
      if (to === UNISWAP_REGISTRY.v3Factory.address && data.startsWith('0x1698ee82')) {
        return `0x${addressWord(V3_POOL)}`;
      }
      if (data === '0x06fdde03') return bytes32Text(to === V4_ERC20_USDC ? 'USD Coin' : 'Fixture Token');
      if (data === '0x95d89b41') return bytes32Text(to === V4_ERC20_USDC ? 'USDC' : 'FIX');
      if (data === '0x313ce567') return `0x${word(to === V4_ERC20_USDC ? 6 : 18)}`;
      if (data === '0x18160ddd') return `0x${word(1_000_000)}`;
      throw new Error(`Unexpected fixture contract call: ${to} ${data}`);
    },
  };
  return { rpc, calls };
}

async function verifyDeterministicFixtures() {
  assert.equal(ARC_CHAIN_ID, 5042);
  assert.equal(UNISWAP_REGISTRY.v3Factory.address, '0xf0db7b58379503491d857db50ac9ece64c653918');
  assert.equal(UNISWAP_REGISTRY.v4PoolManager.address, '0x8366a39cc670b4001a1121b8f6a443a643e40951');

  const poolCreated = decodeV3PoolCreated(fixtureV3PoolCreated());
  assert.deepEqual({ token0: poolCreated.token0, token1: poolCreated.token1, fee: poolCreated.fee, tickSpacing: poolCreated.tickSpacing, pool: poolCreated.pool }, {
    token0: TOKEN0,
    token1: TOKEN1,
    fee: 3000,
    tickSpacing: 60,
    pool: V3_POOL,
  });

  const signedV3Swap = decodeV3Swap(fixtureV3Swap(V3_POOL, 1));
  assert.equal(signedV3Swap.amount0Raw, '-12345');
  assert.equal(signedV3Swap.amount1Raw, '678');
  assert.equal(signedV3Swap.token0InRaw, '0');
  assert.equal(signedV3Swap.token0OutRaw, '12345');
  assert.equal(signedV3Swap.token1InRaw, '678');
  assert.equal(signedV3Swap.token1OutRaw, '0');

  const v4Initialize = decodeV4Initialize(fixtureV4Initialize());
  assert.equal(v4Initialize.poolId, KNOWN_V4_POOL_ID);
  assert.equal(v4Initialize.currency0, V4_NATIVE_USDC);
  assert.equal(v4Initialize.currency1, V4_ERC20_USDC);
  assert.equal(v4Initialize.fee, 500);
  assert.equal(v4Initialize.tickSpacing, 10);

  const signedV4Swap = decodeV4Swap(fixtureV4Swap(KNOWN_V4_POOL_ID, 6, -9, 10));
  assert.equal(signedV4Swap.amount0Raw, '-9');
  assert.equal(signedV4Swap.amount1Raw, '10');

  const modifyPositive = decodeV4ModifyLiquidity(fixtureV4ModifyLiquidity(5, 8));
  const modifyNegative = decodeV4ModifyLiquidity(fixtureV4ModifyLiquidity(-6, 9));
  const modifyZero = decodeV4ModifyLiquidity(fixtureV4ModifyLiquidity(0, 10));
  assert.equal(modifyPositive.classification, 'increase');
  assert.equal(modifyNegative.classification, 'decrease');
  assert.equal(modifyZero.classification, 'poke');

  const logs = [
    fixtureV3PoolCreated(),
    fixtureV3Swap(V3_POOL, 1),
    fixtureV3Swap(FAKE_POOL, 2),
    fixtureV3Mint(),
    fixtureV3Burn(),
    fixtureV4Initialize(),
    fixtureV4Swap(KNOWN_V4_POOL_ID, 6, -9, 10),
    fixtureV4Swap(UNKNOWN_V4_POOL_ID, 7, 11, -12),
    fixtureV4ModifyLiquidity(5, 8),
    fixtureV4ModifyLiquidity(-6, 9),
    fixtureV4ModifyLiquidity(0, 10),
  ];
  const phase1aSnapshot = {
    chainId: ARC_CHAIN_ID,
    startBlock: 100,
    endBlock: 101,
    lastIndexedBlock: 101,
    source: 'fixture://uniswap-arc',
    complete: true,
    logs,
  };
  const { rpc, calls } = makeFixtureRpc();
  const decoded = await buildUniswapBoundedSnapshot({ phase1aSnapshot, rpc });

  assert.equal(decoded.v3.factoryCodeVerified, true);
  assert.equal(decoded.v3.poolCreatedCount, 1);
  assert.equal(decoded.v3.candidateSwapEmitters.length, 2);
  assert.equal(decoded.v3.verifiedSwapPools.length, 1);
  assert.equal(decoded.v3.verifiedSwapPools[0].address, V3_POOL);
  assert.equal(decoded.v3.rejectedSwapEmitters.length, 1);
  assert.equal(decoded.v3.rejectedSwapEmitters[0].address, FAKE_POOL);
  assert.equal(decoded.v3.rejectedSwapEmitters[0].status, 'rejected');
  assert.equal(decoded.v3.rawPoolFlows.filter((flow) => flow.type === 'swap').length, 1);
  assert.equal(decoded.v3.swapEventCount, 1);
  assert.equal(decoded.v3.mintEventCount, 1);
  assert.equal(decoded.v3.burnEventCount, 1);
  assert.equal(decoded.v3.poolsWithSwaps, 1);
  assert.equal(decoded.v3.complete, true);

  assert.equal(decoded.v4.poolManagerCodeVerified, true);
  assert.equal(decoded.v4.initializeEventCount, 1);
  assert.deepEqual(decoded.v4.knownPoolIds, [KNOWN_V4_POOL_ID]);
  assert.equal(decoded.v4.swapEventCount, 2);
  assert.equal(decoded.v4.unknownPoolIdSwapCount, 1);
  assert.equal(decoded.v4.unknownPoolIdModifyLiquidityCount, 0);
  assert.equal(decoded.v4.swapEvents[1].poolIdentityStatus, 'unavailable');
  assert.equal(decoded.v4.swapEvents[1].pair, null);
  assert.equal(decoded.v4.swapEvents[1].poolId, UNKNOWN_V4_POOL_ID);
  assert.equal(decoded.v4.swapEvents[1].amount0Raw, '11');
  assert.equal(decoded.v4.modifyLiquidityEventCount, 3);
  assert.equal(decoded.v4.modifyLiquidityEvents[0].poolId, KNOWN_V4_POOL_ID);
  assert.deepEqual(decoded.v4.modifyLiquidityEvents.map((event) => event.classification), ['increase', 'decrease', 'poke']);
  assert.equal(decoded.v4.swapEventScanComplete, true);
  assert.equal(decoded.v4.eventScanComplete, true);
  assert.equal(decoded.v4.poolMetadataComplete, false);
  assert.equal(decoded.v4.historicalPoolRegistryComplete, false);
  assert.equal(decoded.complete, true);

  const knownV4Pair = decoded.v4.swapEvents.find((event) => event.poolId === KNOWN_V4_POOL_ID).pair;
  assert.deepEqual(knownV4Pair.currency0, {
    address: V4_NATIVE_USDC,
    kind: 'native',
    symbol: 'native USDC',
    decimals: 18,
    status: 'chain_native_asset',
  });
  assert.equal(knownV4Pair.currency1.address, V4_ERC20_USDC);
  assert.equal(knownV4Pair.currency1.kind, 'erc20');
  assert.equal(knownV4Pair.currency1.symbol, 'USDC');
  assert.equal(knownV4Pair.currency1.decimals, 6);
  assert.notEqual(knownV4Pair.currency0.address, knownV4Pair.currency1.address);

  assert.ok(calls.some(({ method, params }) => method === 'eth_call'
    && String(params[0]?.to).toLowerCase() === UNISWAP_REGISTRY.v3Factory.address
    && String(params[0]?.data).startsWith('0x1698ee82')));
  assert.ok(calls.some(({ method, params }) => method === 'eth_getCode'
    && String(params[0]).toLowerCase() === UNISWAP_REGISTRY.v3Factory.address));
  assert.ok(calls.some(({ method, params }) => method === 'eth_getCode'
    && String(params[0]).toLowerCase() === UNISWAP_REGISTRY.v4PoolManager.address));
  assert.ok(calls.filter(({ method }) => method === 'eth_getCode' || method === 'eth_call')
    .every(({ params }) => params[1] === HISTORICAL_END_TAG));
  assert.equal(calls.some(({ method, params }) => method === 'eth_getCode'
    && String(params[0]).toLowerCase() === V4_NATIVE_USDC), false);

  for (const flow of [...decoded.v3.rawPoolFlows, ...decoded.v4.swapEvents, ...decoded.v4.modifyLiquidityEvents]) {
    assert.equal(Object.hasOwn(flow, 'trader'), false);
    assert.equal(Object.hasOwn(flow, 'usdVolume'), false);
    assert.equal(Object.hasOwn(flow, 'tvl'), false);
  }
  assert.equal(decoded.v3.rawPoolFlows.find((flow) => flow.type === 'swap').sender, ROUTER_SENDER);
  assert.equal(decoded.v4.swapEvents[0].sender, ROUTER_SENDER);

  console.log('Deterministic Uniswap fixtures: PASS');
  console.log('Covered: V3 PoolCreated/Swap/Mint/Burn, verified and rejected emitters, V4 Initialize/Swap/ModifyLiquidity, unknown poolId, native USDC, metadata blockTag, no trader/USD/TVL fields.');
}

function printLiveSnapshot(phase1aSnapshot, snapshot) {
  console.log('Machina Arc Intelligence Phase 1B Uniswap verifier');
  console.log(`RPC source: ${snapshot.source}`);
  console.log(`Chain ID: ${snapshot.chainId}`);
  console.log(`Phase 1A snapshot complete: ${phase1aSnapshot.complete}`);
  console.log(`Bounded window: ${snapshot.startBlock}..${snapshot.endBlock}`);
  console.log(`V3 factory: ${snapshot.v3.factory}; code verified: ${snapshot.v3.factoryCodeVerified}`);
  console.log(`V3 PoolCreated: ${snapshot.v3.poolCreatedCount ?? 'unavailable'}; swap candidates: ${snapshot.v3.candidateSwapEmitters.length}; verified pools: ${snapshot.v3.verifiedSwapPools.length}; rejected/unavailable emitters: ${snapshot.v3.rejectedSwapEmitters.length}`);
  console.log(`V3 swap candidate addresses: ${snapshot.v3.candidateSwapEmitters.join(', ') || 'none'}`);
  console.log(`V3 verified swap pools: ${snapshot.v3.verifiedSwapPools.map((pool) => `${pool.address} (${pool.token0}/${pool.token1}, fee ${pool.fee})`).join('; ') || 'none'}`);
  console.log(`V3 rejected/unavailable emitters: ${snapshot.v3.rejectedSwapEmitters.map((emitter) => `${emitter.address} (${emitter.status}: ${emitter.reason})`).join('; ') || 'none'}`);
  console.log(`V3 swaps: ${snapshot.v3.swapEventCount ?? 'unavailable'}; Mint: ${snapshot.v3.mintEventCount ?? 'unavailable'}; Burn: ${snapshot.v3.burnEventCount ?? 'unavailable'}; pools with swaps: ${snapshot.v3.poolsWithSwaps ?? 'unavailable'}; scan complete: ${snapshot.v3.complete}`);
  console.log(`V4 PoolManager: ${snapshot.v4.poolManager}; code verified: ${snapshot.v4.poolManagerCodeVerified}`);
  console.log(`V4 Initialize: ${snapshot.v4.initializeEventCount ?? 'unavailable'}; known poolIds: ${snapshot.v4.knownPoolIds.length}; swaps: ${snapshot.v4.swapEventCount ?? 'unavailable'}; ModifyLiquidity: ${snapshot.v4.modifyLiquidityEventCount ?? 'unavailable'}; unknown swap poolIds: ${snapshot.v4.unknownPoolIdSwapCount ?? 'unavailable'}; unknown liquidity poolIds: ${snapshot.v4.unknownPoolIdModifyLiquidityCount ?? 'unavailable'}`);
  console.log(`V4 scan complete: ${snapshot.v4.eventScanComplete}; swap scan complete: ${snapshot.v4.swapEventScanComplete}; bounded pool metadata complete: ${snapshot.v4.poolMetadataComplete}; historical registry complete: ${snapshot.v4.historicalPoolRegistryComplete}`);
  const nativeUsdcObserved = snapshot.v4.poolKeys.some((poolKey) => poolKey.currency0 === V4_NATIVE_USDC || poolKey.currency1 === V4_NATIVE_USDC);
  console.log(`Native USDC currency observed: ${nativeUsdcObserved ? 'yes (address(0), raw decimals 18)' : 'no'}`);
  console.log(`ERC-20 token metadata complete: ${snapshot.metadataComplete}`);
  console.log(`Overall decoder completeness: ${snapshot.complete}`);
  if (snapshot.warnings.length === 0) console.log('Warnings: none');
  else {
    console.log(`Warnings: ${snapshot.warnings.length}`);
    for (const warning of snapshot.warnings) console.log(`- ${warning}`);
  }
}

await verifyDeterministicFixtures();
if (process.argv.includes('--fixtures-only')) {
  console.log('Live Arc RPC: skipped by --fixtures-only');
  process.exit(0);
}

const rpc = createArcRpcClient({ url: ARC_RPC_URL });
assert.equal(new URL(rpc.url).origin, 'https://rpc.mainnet.arc.io', 'Live verifier must use only the approved Arc mainnet RPC host');
const phase1aSnapshot = await buildLatestSnapshot({ rpc, windowSize: 25 });
assert.equal(phase1aSnapshot.chainId, ARC_CHAIN_ID);
assert.equal(phase1aSnapshot.complete, true, 'Phase 1A must provide a complete bounded receipt/log snapshot');
const snapshot = await buildUniswapBoundedSnapshot({ phase1aSnapshot, rpc });
printLiveSnapshot(phase1aSnapshot, snapshot);

assert.equal(snapshot.chainId, ARC_CHAIN_ID);
assert.equal(snapshot.source, ARC_RPC_URL);
assert.equal(snapshot.phase1aSnapshotComplete, true);
assert.equal(snapshot.v3.factoryCodeVerified, true, 'Official V3 factory code must be present at requestedEnd');
assert.equal(snapshot.v4.poolManagerCodeVerified, true, 'Official V4 PoolManager code must be present at requestedEnd');
assert.equal(snapshot.v3.complete, true, 'Bounded V3 protocol event scan must complete');
assert.equal(snapshot.v4.eventScanComplete, true, 'Bounded V4 protocol event scan must complete');
assert.equal(snapshot.complete, true, 'The bounded Uniswap protocol event scans must complete');
console.log('Uniswap live verifier result: PASS');
