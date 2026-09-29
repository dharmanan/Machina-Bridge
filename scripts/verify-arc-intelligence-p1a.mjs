import assert from 'node:assert/strict';
import https from 'node:https';
import httpsProxyAgent from 'https-proxy-agent';
import { encodeAbiParameters } from 'viem';
import { ARC_CHAIN_ID, ARC_RPC_URL, createArcRpcClient } from '../api/_lib/arc-intelligence/rpc.js';
import { buildBoundedSnapshot, DEFINITION_VERSION as CORE_VERSION } from '../api/_lib/arc-intelligence/core.js';
import { buildDexP1Snapshot } from '../api/_lib/arc-intelligence/dex-p1.js';
import { buildLaunchpadSnapshot } from '../api/_lib/arc-intelligence/launchpads.js';
import { P1A_DEX_CANDIDATES, P1A_LAUNCHPAD_CANDIDATES } from '../api/_lib/arc-intelligence/p1a-registry.js';
import { createMetricAccumulator } from '../api/_lib/arc-intelligence/metrics.js';
import { eventTopic } from '../api/_lib/arc-intelligence/circle-common.js';
import { ARGUS_ADAPTER } from '../api/_lib/arc-intelligence/launchpad-adapters/argus.js';
import { OPENLAUNCH_ADAPTER } from '../api/_lib/arc-intelligence/launchpad-adapters/openlaunch.js';
import { TOLLY_ADAPTER } from '../api/_lib/arc-intelligence/launchpad-adapters/tolly.js';
import { ARCHEMIST_V2_ADAPTER } from '../api/_lib/arc-intelligence/launchpad-adapters/archemist-v2.js';

const { HttpsProxyAgent } = httpsProxyAgent;
const HASH = (number) => `0x${number.toString(16).padStart(64, '0')}`;
const ADDRESS = (number) => `0x${number.toString(16).padStart(40, '0')}`;
const FACTORIES = P1A_LAUNCHPAD_CANDIDATES.filter((candidate) => candidate.verificationStatus === 'source_verified_candidate');

function logFor(adapter, protocol, args, blockNumber, logIndex = 0, emitter = null) {
  const candidate = P1A_LAUNCHPAD_CANDIDATES.find((entry) => entry.protocol === protocol);
  const indexed = adapter.abi.inputs.filter((input) => input.indexed);
  const unindexed = adapter.abi.inputs.filter((input) => !input.indexed);
  return {
    address: emitter ?? candidate.address,
    topics: [eventTopic(adapter.abi), ...indexed.map((input) => encodeAbiParameters(
      [{ type: input.type }], [args[input.name]]))],
    data: encodeAbiParameters(unindexed, unindexed.map((input) => args[input.name])),
    blockNumber, transactionIndex: 0, logIndex, transactionHash: HASH(blockNumber + 100),
  };
}

function argusEvent(blockNumber = 22) {
  return logFor(ARGUS_ADAPTER, 'Argus', {
    token: ADDRESS(1000), creator: ADDRESS(1001), name: 'Fixture', symbol: 'FIX',
    poolId: HASH(700), imageURI: 'ipfs://image', website: '', twitter: '', telegram: '',
  }, blockNumber);
}

function openlaunchEvent(blockNumber = 22) {
  return logFor(OPENLAUNCH_ADAPTER, 'Openlaunch', {
    token: ADDRESS(1100), tokenId: 7n, launcher: ADDRESS(1101),
    quote: ADDRESS(1102), poolId: HASH(701), startTick: 200,
    lpFee: 10_000, supply: 900719925474099312345n, metadataURI: 'ipfs://metadata',
  }, blockNumber, 1);
}

function coreFixture(number, timestamp, logs = []) {
  return {
    chainId: ARC_CHAIN_ID, source: ARC_RPC_URL, definitionVersion: CORE_VERSION,
    startBlock: number, endBlock: number, lastIndexedBlock: number,
    blockCount: 1, totalTransactions: 0, receiptCount: 0,
    blocks: [{ number, timestamp, hash: HASH(number + 1), parentHash: HASH(number), transactions: [], transactionCount: 0 }],
    transactions: [], receipts: [], logs, transferLogs: [], verifiedAssetObservations: [],
    complete: true, warnings: [],
  };
}

function fixtureRpc({ absent = [] } = {}) {
  const calls = [];
  const absentSet = new Set(absent.map((address) => address.toLowerCase()));
  const topicByAddress = new Map(FACTORIES.map((candidate) => {
    const adapter = candidate.protocol === 'Argus' ? ARGUS_ADAPTER
      : candidate.protocol === 'Openlaunch' ? OPENLAUNCH_ADAPTER
        : candidate.protocol === 'Tolly' ? TOLLY_ADAPTER : ARCHEMIST_V2_ADAPTER;
    return [candidate.address, adapter ? eventTopic(adapter.abi) : null];
  }));
  return {
    url: ARC_RPC_URL, calls,
    async request(method, params) {
      calls.push({ method, params });
      if (method === 'eth_getCode') {
        const address = params[0].toLowerCase();
        if (absentSet.has(address)) return '0x';
        const topic = topicByAddress.get(address);
        return topic ? `0x60${topic.slice(2)}` : '0x6000';
      }
      if (method === 'eth_call') {
        const selector = params[0].data;
        if (selector === '0x06fdde03') return encodeAbiParameters([{ type: 'string' }], ['Fixture Token']);
        if (selector === '0x95d89b41') return encodeAbiParameters([{ type: 'string' }], ['FIX']);
        if (selector === '0x313ce567') return encodeAbiParameters([{ type: 'uint256' }], [18n]);
        if (selector === '0x18160ddd') return encodeAbiParameters([{ type: 'uint256' }], [1000n]);
        if (params[0].to.toLowerCase() === FACTORIES.find((entry) => entry.protocol === 'Argus').address) {
          return encodeAbiParameters([{ type: 'uint256' }], [11n]);
        }
        if (params[0].to.toLowerCase() === FACTORIES.find((entry) => entry.protocol === 'Tolly').address) {
          return encodeAbiParameters([{ type: 'address' }], ['0x3600000000000000000000000000000000000000']);
        }
        if (params[0].to.toLowerCase() === FACTORIES.find((entry) => entry.protocol === 'Openlaunch').address) {
          return encodeAbiParameters([{ type: 'uint256' }], [1n]);
        }
      }
      throw new Error(`Unexpected fixture RPC ${method}`);
    },
  };
}

function bucketFor(chunks) {
  const accumulator = createMetricAccumulator();
  for (const chunk of chunks) accumulator.addChunk(chunk.core, chunk.protocols);
  const history = { coreCoverage: { metricSnapshotCoverageComplete: true },
    legacyUsdcCoverage: { status: 'unavailable' } };
  return accumulator.finalize(history).buckets.hour.find((bucket) => bucket.bucketStartUtc === new Date(3600 * 1000).toISOString());
}

async function deterministic() {
  assert.equal(P1A_DEX_CANDIDATES.length, 12);
  assert.equal(P1A_LAUNCHPAD_CANDIDATES.length, 13);
  assert.ok(P1A_DEX_CANDIDATES.every((candidate) => candidate.verificationStatus === 'unavailable' && candidate.address === null));
  const fake = fixtureRpc();
  const official = [argusEvent(), openlaunchEvent()];
  const fakeEmitter = { ...argusEvent(), address: ADDRESS(9999), logIndex: 2 };
  const transferOnly = { address: ADDRESS(1000), topics: [HASH(999)], data: '0x',
    blockNumber: 22, transactionIndex: 0, logIndex: 3, transactionHash: HASH(122) };
  const unverifiedAggregatorRoute = { address: ADDRESS(2000), topics: [HASH(998)], data: '0x',
    blockNumber: 22, transactionIndex: 0, logIndex: 4, transactionHash: HASH(122) };
  const core22 = coreFixture(22, 3600, [...official, fakeEmitter, transferOnly, unverifiedAggregatorRoute]);
  const launch22 = await buildLaunchpadSnapshot({ phase1aSnapshot: core22, rpc: fake });
  const dex22 = await buildDexP1Snapshot({ phase1aSnapshot: core22, rpc: fake });
  assert.equal(launch22.verifiedFactoryCount, 4);
  assert.equal(launch22.launchEvents.length, 2); // Fake emitter, token Transfer, and unverified route ignored.
  assert.equal(launch22.verifiedFactoryEventScanComplete, true);
  assert.equal(launch22.protocolUniverseComplete, false);
  assert.equal(launch22.complete, false);
  assert.equal(launch22.tokenMetadataComplete, true);
  assert.equal(launch22.launchEvents.find((event) => event.protocol === 'Openlaunch').supplyRaw,
    '900719925474099312345');
  assert.equal(launch22.launchEvents.find((event) => event.protocol === 'Openlaunch').creator, null);
  assert.equal(launch22.launchEvents.find((event) => event.protocol === 'Argus').creator, ADDRESS(1001));
  assert.ok(fake.calls.filter((call) => ['eth_getCode', 'eth_call'].includes(call.method))
    .every((call) => call.params[1] === '0x16'));
  assert.deepEqual(dex22.observedSwaps, []);
  assert.deepEqual(dex22.routeExecutions, []);

  const malformed = { ...argusEvent(), data: '0x1234' };
  const malformedResult = await buildLaunchpadSnapshot({ phase1aSnapshot: coreFixture(22, 3600, [malformed]), rpc: fixtureRpc() });
  assert.equal(malformedResult.factories.find((factory) => factory.protocol === 'Argus').malformedEventCount, 1);
  assert.equal(malformedResult.factories.find((factory) => factory.protocol === 'Argus').eventScanComplete, false);
  const absentResult = await buildLaunchpadSnapshot({ phase1aSnapshot: coreFixture(22, 3600, [argusEvent()]),
    rpc: fixtureRpc({ absent: [FACTORIES.find((entry) => entry.protocol === 'Argus').address] }) });
  assert.equal(absentResult.factories.find((factory) => factory.protocol === 'Argus').status, 'unavailable');
  assert.equal(absentResult.launchEvents.length, 0);

  const core21 = coreFixture(21, 3599);
  const core23 = coreFixture(23, 3601);
  const core24 = coreFixture(24, 7200);
  const launch23 = await buildLaunchpadSnapshot({ phase1aSnapshot: core23, rpc: fixtureRpc() });
  const uni = { definitionVersion: 'uniswap-fixture-v1', v3: { complete: true,
    rawPoolFlows: [{ blockNumber: 22, transactionIndex: 0, logIndex: 9, type: 'swap', pool: ADDRESS(77) }] },
  v4: { eventScanComplete: true, swapEvents: [], modifyLiquidityEvents: [], poolKeys: [] } };
  const emptyUni = { ...uni, v3: { ...uni.v3, rawPoolFlows: [] } };
  const chunks = [
    { core: core21, protocols: { launchpads: launch23, dexP1: dex22, uniswap: emptyUni } },
    { core: core22, protocols: { launchpads: launch22, dexP1: dex22, uniswap: uni } },
    { core: core23, protocols: { launchpads: launch23, dexP1: dex22, uniswap: emptyUni } },
    { core: core24, protocols: { launchpads: launch23, dexP1: dex22, uniswap: emptyUni } },
  ];
  const bucket = bucketFor(chunks);
  const record = (id) => bucket.records.find((item) => item.metricId === id);
  assert.equal(bucket.coreBoundaryComplete, true);
  assert.equal(record('launchpad.argus.launchEventCount').value, 1);
  assert.equal(record('launchpad.argus.launchEventCount').complete, true);
  assert.equal(record('launchpad.argus.launchEventCount').protocolUniverseComplete, false);
  assert.equal(record('launchpad.argus.creatorCount').value, 1);
  assert.equal(record('launchpad.openlaunch.launchEventCount').value, 1);
  assert.equal(record('launchpad.openlaunch.creatorCount'), undefined);
  assert.equal(record('uniswap.v3.verifiedPool.swapEventCount').value, 1);
  assert.ok(!bucket.records.some((item) => item.protocol === 'dex.p1' && item.value !== null));
  assert.doesNotMatch(JSON.stringify(bucket.records.filter((item) => item.protocol === 'launchpad.p1')),
    /usdVolume|totalValueLocked|marketShare|tradeEventCount/);

  const zeroChunks = chunks.map((chunk) => ({ ...chunk,
    protocols: { ...chunk.protocols, launchpads: { ...chunk.protocols.launchpads, launchEvents: [] } } }));
  assert.equal(bucketFor(zeroChunks).records.find((item) => item.metricId === 'launchpad.argus.launchEventCount').value, 0);
  assert.equal(bucketFor(zeroChunks).records.find((item) => item.metricId === 'launchpad.argus.launchEventCount').complete, true);
  const unavailableChunks = chunks.map((chunk) => ({ ...chunk,
    protocols: { ...chunk.protocols, launchpads: absentResult } }));
  assert.equal(bucketFor(unavailableChunks).records.find((item) => item.metricId === 'launchpad.argus.launchEventCount').value, null);
  const mixedChunks = structuredClone(chunks);
  mixedChunks[2].protocols.launchpads.definitionVersion = 'arc-intelligence-launchpads-v2';
  const mixed = bucketFor(mixedChunks).records.find((item) => item.metricId === 'launchpad.argus.launchEventCount');
  assert.equal(mixed.complete, false);
  assert.equal(mixed.coverageStatus, 'partial');
  console.log('P1A DETERMINISTIC FIXTURES: PASS');
}

function liveRpc() {
  if (!process.env.HTTPS_PROXY) throw new Error('Safe wrapper HTTPS proxy is unavailable.');
  const agent = new HttpsProxyAgent(process.env.HTTPS_PROXY);
  const fetchArcOnly = async (input, init = {}) => {
    const target = new URL(typeof input === 'string' ? input : input.url);
    if (target.href !== `${ARC_RPC_URL}/` && target.href !== ARC_RPC_URL) throw new Error('Only canonical Arc RPC is allowed.');
    return new Promise((resolve, reject) => {
      const request = https.request(target, { method: init.method ?? 'GET', headers: init.headers,
        agent, signal: init.signal }, (response) => {
        const chunks = [];
        response.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
        response.on('error', reject);
        response.on('end', () => {
          const status = response.statusCode ?? 0;
          const payload = Buffer.concat(chunks).toString('utf8');
          resolve({ status, ok: status >= 200 && status < 300, async json() { return JSON.parse(payload); } });
        });
      });
      request.on('error', reject);
      if (init.body) request.write(init.body);
      request.end();
    });
  };
  return createArcRpcClient({ url: ARC_RPC_URL, fetchImpl: fetchArcOnly, maxAttempts: 3 });
}

async function live() {
  const rpc = liveRpc();
  const chainId = Number(BigInt(await rpc.request('eth_chainId')));
  assert.equal(chainId, ARC_CHAIN_ID);
  const head = Number(BigInt(await rpc.request('eth_blockNumber')));
  const endBlock = head - 2;
  const startBlock = endBlock - 24;
  const core = await buildBoundedSnapshot({ rpc, startBlock, endBlock });
  const [dex, launchpads] = await Promise.all([
    buildDexP1Snapshot({ phase1aSnapshot: core, rpc }),
    buildLaunchpadSnapshot({ phase1aSnapshot: core, rpc }),
  ]);
  const output = {
    chainId, head, startBlock, endBlock, blockTag: `0x${endBlock.toString(16)}`,
    coreComplete: core.complete, coreWarnings: core.warnings,
    dex: dex.candidates.map((candidate) => ({ protocol: candidate.protocol,
      source: candidate.source, address: candidate.address, codePresent: candidate.codePresent,
      viewResult: null, status: candidate.status, observedEventCount: 0,
      malformedEventCount: 0, eventScanComplete: candidate.eventScanComplete,
      protocolUniverseComplete: dex.protocolUniverseComplete })),
    launchpads: launchpads.factories.map((factory) => ({ protocol: factory.protocol,
      source: factory.source, address: factory.address, codePresent: factory.codePresent,
      eventTopicInBytecode: factory.eventTopicInBytecode, viewResult: factory.viewResult,
      status: factory.status, observedEventCount: launchpads.launchEvents.filter((event) => event.protocol === factory.protocol).length,
      malformedEventCount: factory.malformedEventCount, eventScanComplete: factory.eventScanComplete,
      protocolUniverseComplete: launchpads.protocolUniverseComplete,
      verificationReason: factory.verificationReason })),
    verifiedFactoryEventScanComplete: launchpads.verifiedFactoryEventScanComplete,
    protocolUniverseComplete: launchpads.protocolUniverseComplete,
    tokenMetadataComplete: launchpads.tokenMetadataComplete,
    warnings: launchpads.warnings,
  };
  console.log(JSON.stringify(output, null, 2));
  if (!core.complete) throw new Error('LIVE P1A DATA: INCOMPLETE Phase 1A snapshot; no P1A event completeness asserted.');
  assert.equal(core.blockCount, 25);
  assert.equal(core.receiptCount, core.totalTransactions);
  assert.ok(launchpads.verifiedFactoryCount > 0);
  assert.equal(launchpads.verifiedFactoryEventScanComplete, true);
  assert.ok(launchpads.factories.every((factory) => factory.status !== 'verified' || factory.eventScanComplete));
  assert.ok(launchpads.launchEvents.every((event) => launchpads.factories.some((factory) =>
    factory.status === 'verified' && factory.address === event.emitter)));
  console.log('P1A LIVE VERIFIER_CORRECTNESS: PASS');
  console.log(`P1A LIVE DATA COMPLETENESS: ${launchpads.complete ? 'COMPLETE' : 'INCOMPLETE_SUBSET'}`);
}

const mode = process.argv[2] ?? 'all';
assert.ok(['all', '--fixtures-only', '--live-only'].includes(mode));
if (mode !== '--live-only') await deterministic();
if (mode !== '--fixtures-only') await live();
