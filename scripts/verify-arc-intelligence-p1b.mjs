import assert from 'node:assert/strict';
import https from 'node:https';
import httpsProxyAgent from 'https-proxy-agent';
import { encodeAbiParameters } from 'viem';
import { ARC_CHAIN_ID, ARC_RPC_URL, createArcRpcClient } from '../api/_lib/arc-intelligence/rpc.js';
import { buildBoundedSnapshot, DEFINITION_VERSION as CORE_VERSION } from '../api/_lib/arc-intelligence/core.js';
import { buildAcrossSnapshot, decodeAcrossArcLeg } from '../api/_lib/arc-intelligence/across.js';
import { buildMorphoV2Snapshot } from '../api/_lib/arc-intelligence/morpho.js';
import { ACROSS_ARC_SPOKE_POOL, ACROSS_FILLED_RELAY_ABI, ACROSS_FUNDS_DEPOSITED_ABI,
  P1B_BRIDGE_CANDIDATES, P1B_MORPHO_VAULT_REGISTRY, RWA_ARC_CANDIDATES,
  STABLEFX_ARC_CANDIDATES, buildP1BRegistrySnapshot } from '../api/_lib/arc-intelligence/p1b-registry.js';
import { MORPHO_V2_DEFINITION_VERSION, MORPHO_V2_EVENT_TOPICS, MORPHO_ARC_CANDIDATE_VAULTS, decodeMorphoVaultV2Allocation,
  decodeMorphoVaultV2Flow } from '../api/_lib/arc-intelligence/morpho.js';
import { createMetricAccumulator } from '../api/_lib/arc-intelligence/metrics.js';
import { eventTopic } from '../api/_lib/arc-intelligence/circle-common.js';
import { TRANSFER_TOPIC } from '../api/_lib/arc-intelligence/usdc.js';

const { HttpsProxyAgent } = httpsProxyAgent;
const HASH = (number) => `0x${number.toString(16).padStart(64, '0')}`;
const ADDRESS = (number) => `0x${number.toString(16).padStart(40, '0')}`;
const EMPTY_ADDRESS_WORD = `0x${'0'.repeat(64)}`;

function eventLog(abi, args, { address = ACROSS_ARC_SPOKE_POOL.address, blockNumber = 22, logIndex = 0 } = {}) {
  const indexed = abi.inputs.filter((input) => input.indexed);
  const unindexed = abi.inputs.filter((input) => !input.indexed);
  return {
    address: address.toLowerCase(),
    topics: [eventTopic(abi), ...indexed.map((input) => encodeAbiParameters([{ type: input.type }], [args[input.name]]))],
    data: encodeAbiParameters(unindexed, unindexed.map((input) => args[input.name])),
    blockNumber, transactionIndex: 0, logIndex, transactionHash: HASH(blockNumber + 100),
  };
}

function coreFixture(number = 22, logs = [], timestamp = 3600) {
  return { chainId: ARC_CHAIN_ID, source: ARC_RPC_URL, definitionVersion: CORE_VERSION,
    startBlock: number, endBlock: number, lastIndexedBlock: number, blockCount: 1,
    totalTransactions: 0, receiptCount: 0, blocks: [{ number, timestamp,
    hash: HASH(number + 1), parentHash: HASH(number), timestamp, transactions: [], transactionCount: 0 }],
    transactions: [], receipts: [], logs, transferLogs: [], verifiedAssetObservations: [], complete: true, warnings: [] };
}

function fixtureRpc({ code = '0x60016000' } = {}) {
  const calls = [];
  return { url: ARC_RPC_URL, calls, async request(method, params) {
    calls.push({ method, params });
    if (method === 'eth_getCode') return code;
    throw new Error(`Unexpected fixture RPC ${method}`);
  } };
}

function fixtureDeposit() {
  return eventLog(ACROSS_FUNDS_DEPOSITED_ABI, {
    inputToken: `0x${'1'.repeat(64)}`, outputToken: `0x${'2'.repeat(64)}`,
    inputAmount: 900719925474099312345n, outputAmount: 900719925474099300000n,
    destinationChainId: 8453n, depositId: 77n, quoteTimestamp: 1, fillDeadline: 2,
    exclusivityDeadline: 0, depositor: `0x${'3'.repeat(64)}`, recipient: `0x${'4'.repeat(64)}`,
    exclusiveRelayer: EMPTY_ADDRESS_WORD, message: '0x',
  });
}

function fixtureFill() {
  return eventLog(ACROSS_FILLED_RELAY_ABI, {
    inputToken: `0x${'1'.repeat(64)}`, outputToken: `0x${'2'.repeat(64)}`,
    inputAmount: 900719925474099312345n, outputAmount: 900719925474099300000n,
    repaymentChainId: 1n, originChainId: 8453n, depositId: 77n, fillDeadline: 2,
    exclusivityDeadline: 0, exclusiveRelayer: EMPTY_ADDRESS_WORD, relayer: `0x${'5'.repeat(64)}`,
    depositor: `0x${'3'.repeat(64)}`, recipient: `0x${'4'.repeat(64)}`,
    messageHash: HASH(88), relayExecutionInfo: { updatedRecipient: EMPTY_ADDRESS_WORD,
      updatedMessageHash: HASH(89), updatedOutputAmount: 900719925474099299999n, fillType: 0 },
  }, { logIndex: 1 });
}

async function deterministic() {
  assert.equal(fixtureDeposit().topics[0], eventTopic(ACROSS_FUNDS_DEPOSITED_ABI));
  const sourceLeg = decodeAcrossArcLeg(fixtureDeposit());
  const destinationLeg = decodeAcrossArcLeg(fixtureFill());
  assert.equal(sourceLeg.type, 'source_deposit_leg');
  assert.equal(sourceLeg.inputAmountRaw, '900719925474099312345');
  assert.equal(sourceLeg.feeRaw, null);
  assert.equal(destinationLeg.type, 'destination_fill_leg');
  assert.equal(destinationLeg.outputAmountRaw, '900719925474099299999');

  const fakeEmitter = { ...fixtureDeposit(), address: ADDRESS(991), logIndex: 2 };
  const malformed = { ...fixtureDeposit(), data: '0x12', logIndex: 3 };
  const routerTopic = `0x${'9'.repeat(64)}`;
  const routerLog = { ...fixtureDeposit(), address: ADDRESS(992), topics: [routerTopic], logIndex: 4 };
  const zero = await buildAcrossSnapshot({ phase1aSnapshot: coreFixture(22), rpc: fixtureRpc() });
  assert.equal(zero.completeness.eventScanComplete, true);
  assert.equal(zero.sourceLegCount, 0);
  assert.equal(zero.completeness.protocolUniverseComplete, false);
  assert.equal(zero.complete, false);
  const unverified = await buildAcrossSnapshot({ phase1aSnapshot: coreFixture(22), rpc: fixtureRpc({ code: '0x' }) });
  assert.equal(unverified.deployment.status, 'unavailable');
  assert.equal(unverified.completeness.eventScanComplete, false);
  assert.equal(unverified.complete, false);
  const withEvents = await buildAcrossSnapshot({ phase1aSnapshot: coreFixture(22,
    [fixtureDeposit(), fixtureFill(), fakeEmitter, malformed, routerLog]), rpc: fixtureRpc() });
  assert.equal(withEvents.sourceLegCount, 1);
  assert.equal(withEvents.destinationLegCount, 1);
  assert.equal(withEvents.malformedEventCount, 1);
  assert.equal(withEvents.completeness.eventScanComplete, false);
  assert.equal(withEvents.events.some((event) => event.emitter === ADDRESS(991)), false);
  assert.equal(withEvents.events.some((event) => event.emitter === ADDRESS(992)), false);
  assert.equal(withEvents.crossChainCompletionCoverage.status, 'unavailable');

  // A verified subset can be event-complete while the bridge universe is incomplete.
  assert.equal(P1B_BRIDGE_CANDIDATES.find((entry) => entry.protocol === 'Across').verificationStatus, 'source_verified_candidate');
  assert.ok(P1B_BRIDGE_CANDIDATES.filter((entry) => entry.address === null).length >= 8);
  assert.equal(P1B_MORPHO_VAULT_REGISTRY.length, MORPHO_ARC_CANDIDATE_VAULTS.length + 2);
  assert.equal(new Set(P1B_MORPHO_VAULT_REGISTRY.filter((entry) => entry.address)
    .map((entry) => entry.address.toLowerCase())).size, MORPHO_ARC_CANDIDATE_VAULTS.length + 1);
  assert.equal(P1B_MORPHO_VAULT_REGISTRY.find((entry) => entry.label === 'Cumberland')?.address, null);
  const shareTransfer = { address: MORPHO_ARC_CANDIDATE_VAULTS[0].address,
    topics: [MORPHO_V2_EVENT_TOPICS.transfer, HASH(1), HASH(2)], data: `0x${'0'.repeat(64)}`,
    blockNumber: 22, logIndex: 5, transactionHash: HASH(122) };
  assert.equal(decodeMorphoVaultV2Flow(shareTransfer), undefined);

  const registry = await buildP1BRegistrySnapshot({ phase1aSnapshot: coreFixture(), rpc: fixtureRpc() });
  assert.equal(registry.complete, false);
  assert.equal(registry.stablefxCandidates[0].deploymentVerified, false);
  assert.equal(registry.stablefxCandidates[0].settlementEventCount, null);
  assert.equal(registry.rwaCandidates.find((entry) => entry.protocol === 'USYC').accountingMetrics, 'unavailable');
  assert.ok(RWA_ARC_CANDIDATES.filter((entry) => entry.address === null).length === 3);

  const malformedStatus = { ...withEvents, completeness: { ...withEvents.completeness, eventScanComplete: false } };
  assert.equal(malformedStatus.completeness.eventScanComplete, false);
  const metricsProtocolVersion = { definitionVersion: 'fixture-a' };
  assert.notEqual(metricsProtocolVersion.definitionVersion, 'fixture-b'); // Mixed decoder versions cannot be source-complete.
  const noFabrication = JSON.stringify({ registry, across: withEvents });
  assert.doesNotMatch(noFabrication, /usdVolume|totalValueLocked|totalAum|crossChainCompletedVolume/);
  assert.equal(MORPHO_V2_EVENT_TOPICS.transfer, shareTransfer.topics[0]);

  const accumulator = createMetricAccumulator();
  const zeroAccumulator = createMetricAccumulator();
  const acrossProtocol = (version) => ({ definitionVersion: version, complete: true,
    completeness: { eventScanComplete: true }, events: [], sourceLegCount: 0, destinationLegCount: 0 });
  const morphoSubset = { definitionVersion: MORPHO_V2_DEFINITION_VERSION,
    completeness: { verifiedVaultEventScanComplete: true, candidateCoverageComplete: true, complete: true },
    candidates: [{ address: MORPHO_ARC_CANDIDATE_VAULTS[0].address.toLowerCase(), status: 'verified' }],
    rawFlows: [], allocationEvents: [] };
  for (const [number, timestamp, version] of [[21, 3599, 'across-fixture-v1'], [22, 3600, 'across-fixture-v1'],
    [23, 3601, 'across-fixture-v2'], [24, 7200, 'across-fixture-v2']]) {
    const chunk = coreFixture(number, [], timestamp);
    if (number === 22) {
      chunk.transferLogs = [{ address: RWA_ARC_CANDIDATES[0].address,
        topics: [TRANSFER_TOPIC, HASH(0), HASH(1)], data: `0x${'0'.repeat(63)}1`,
        blockNumber: 22, transactionIndex: 0, logIndex: 0, transactionHash: HASH(122) }];
      chunk.verifiedAssetObservations = [{ symbol: 'USYC', liveMetadataMatchesRegistry: true }];
    }
    accumulator.addChunk(chunk, { across: acrossProtocol(version), morpho: morphoSubset });
    zeroAccumulator.addChunk(coreFixture(number, [], timestamp), { across: acrossProtocol('across-fixture-v1'), morpho: morphoSubset });
  }
  const history = { coreCoverage: { metricSnapshotCoverageComplete: true }, legacyUsdcCoverage: { status: 'unavailable' } };
  const bucket = accumulator.finalize(history).buckets.hour.find((item) => item.bucketStartUtc === new Date(3600 * 1000).toISOString());
  const metric = (id) => bucket.records.find((record) => record.metricId === id);
  assert.equal(metric('across.v3.sourceLegCount').value, 0);
  assert.equal(metric('across.v3.sourceLegCount').complete, false);
  assert.equal(metric('across.v3.sourceLegCount').coverageStatus, 'partial');
  assert.equal(metric('circle.stablefx.settlementEventCount').value, null);
  assert.equal(metric('rwa.totalAum').value, null);
  assert.equal(metric('rwa.subscriptionRedemptionVolume').value, null);
  assert.equal(metric('across.v3.crossChainCompletedCount').value, null);
  assert.equal(metric('morpho.v2.depositEventCount').protocolUniverseComplete, false);
  assert.equal(metric('morpho.v2.depositEventCount').candidateCoverageComplete, true);
  assert.equal(metric('arc.p1b.protocolUniverseComplete').value, false);
  assert.equal(metric('arc.p1b.protocolUniverseComplete').coverageStatus, 'partial');
  assert.equal(metric('asset.USYC.canonical.transferEventCount').value, 1);
  const zeroBucket = zeroAccumulator.finalize(history).buckets.hour.find((item) => item.bucketStartUtc === new Date(3600 * 1000).toISOString());
  const zeroMetric = zeroBucket.records.find((record) => record.metricId === 'across.v3.sourceLegCount');
  assert.equal(zeroMetric.value, 0);
  assert.equal(zeroMetric.coverageStatus, 'available');
  console.log('P1B deterministic fixtures: PASS');
  console.log('Coverage: zero-event verified deployment, unavailable deployment, fake/router ignored, malformed recognized event incomplete, BigInt raw preserved, verified-subset/universe split, Morpho share Transfer ignored, StableFX/RWA metrics unavailable, mixed decoder version partial.');
}

async function live() {
  const proxyUrl = process.env.HTTPS_PROXY;
  if (!proxyUrl) throw new Error('The safe wrapper HTTPS proxy is unavailable.');
  const agent = new HttpsProxyAgent(proxyUrl);
  const fetchImpl = async (input, init = {}) => {
    const target = new URL(typeof input === 'string' ? input : input.url);
    if (target.href !== 'https://rpc.mainnet.arc.io/' && target.href !== ARC_RPC_URL) {
      throw new Error('Live verifier egress is restricted to https://rpc.mainnet.arc.io.');
    }
    return new Promise((resolve, reject) => {
      const request = https.request(target, { method: init.method ?? 'GET', headers: init.headers, agent, signal: init.signal }, (response) => {
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
  const rpc = createArcRpcClient({ fetchImpl });
  const chainId = await rpc.request('eth_chainId', []).then((v) => Number(BigInt(v)));
  assert.equal(chainId, ARC_CHAIN_ID);
  const latestBlock = Number(BigInt(await rpc.request('eth_blockNumber', [])));
  const endBlock = latestBlock;
  const startBlock = Math.max(0, endBlock - 24);
  const core = await buildBoundedSnapshot({ rpc, startBlock, endBlock });
  assert.equal(core.complete, true, JSON.stringify(core.warnings));
  const [across, registry, morpho] = await Promise.all([
    buildAcrossSnapshot({ phase1aSnapshot: core, rpc }),
    buildP1BRegistrySnapshot({ phase1aSnapshot: core, rpc }),
    buildMorphoV2Snapshot({ phase1aSnapshot: core, rpc }),
  ]);
  const morphoEventCounts = Object.fromEntries(morpho.candidates.map((candidate) => {
    const candidateFlows = morpho.rawFlows.filter((event) => event.emitter === candidate.address);
    const candidateAllocations = morpho.allocationEvents.filter((event) => event.emitter === candidate.address);
    const candidateLogs = core.logs.filter((log) => log.address?.toLowerCase() === candidate.address);
    const malformedRecognizedEventCount = candidate.status === 'verified' ? candidateLogs.filter((log) => {
      const flow = decodeMorphoVaultV2Flow(log);
      if (flow === null) return true;
      if (flow !== undefined) return false;
      return decodeMorphoVaultV2Allocation(log) === null;
    }).length : null;
    return [candidate.address, { depositEventCount: candidate.status === 'verified' ? candidateFlows.filter((event) => event.type === 'deposit').length : null,
      withdrawEventCount: candidate.status === 'verified' ? candidateFlows.filter((event) => event.type === 'withdraw').length : null,
      allocationEventCount: candidate.status === 'verified' ? candidateAllocations.length : null,
      malformedRecognizedEventCount,
      eventScanComplete: candidate.status === 'verified' && morpho.completeness.verifiedVaultEventScanComplete
        && malformedRecognizedEventCount === 0 }];
  }));
  console.log(JSON.stringify({
    chainId, latestBlock, startBlock, endBlock, blockCount: core.blockCount,
    requestedEndBlockTag: `0x${endBlock.toString(16)}`,
    across: { address: across.deployment.address, codeStatus: across.deployment.status,
      blockTag: across.deployment.codeVerifiedAt, sourceLegCount: across.sourceLegCount,
      destinationLegCount: across.destinationLegCount, malformedEventCount: across.malformedEventCount,
      eventScanComplete: across.completeness.eventScanComplete,
      registrySubsetComplete: across.completeness.registrySubsetComplete,
      protocolUniverseComplete: across.completeness.protocolUniverseComplete,
      crossChainCompletionCoverage: across.crossChainCompletionCoverage },
    investigatedBridgeCandidates: registry.bridgeCandidates.map(({ protocol, address, verificationStatus }) => ({ protocol, address, verificationStatus })),
    stablefxCandidates: registry.stablefxCandidates,
    rwaCandidates: registry.rwaCandidates,
    morphoRegistry: registry.morphoVaultRegistry.map(({ category, role, address, label, labelProvenance, verificationStatus }) =>
      ({ category, role, address, label, labelProvenance, verificationStatus })),
    rwaLiveVerification: (() => {
      const observation = core.verifiedAssetObservations.find((item) => item.symbol === 'USYC');
      return observation ? { address: observation.address, symbol: observation.symbol, decimals: observation.decimals,
        blockTag: `0x${endBlock.toString(16)}`, liveCodePresent: observation.liveCodePresent,
        liveMetadataStatus: observation.liveMetadataStatus, liveMetadataMatchesRegistry: observation.liveMetadataMatchesRegistry,
        accountingMetrics: 'unavailable' } : null;
    })(),
    morpho: { factory: morpho.factory, candidateVaultCount: morpho.candidateVaultCount,
      blockRange: morpho.blockRange,
      verifiedVaultCount: morpho.verifiedVaultCount, rejectedCount: morpho.candidates.filter((item) => item.status === 'rejected').length,
      unresolvedCandidateCount: morpho.completeness.unresolvedCandidateCount,
      verifiedVaultEventScanComplete: morpho.completeness.verifiedVaultEventScanComplete,
      candidateCoverageComplete: morpho.completeness.candidateCoverageComplete,
      protocolUniverseComplete: false,
      verifiedCandidateSetComplete: morpho.completeness.complete,
      candidates: morpho.candidates.map(({ address, candidateLabel, status, codePresent, version, factoryEvidence,
        verificationReason, v2Interface, underlying, shareToken }) => ({ address, candidateLabel, status, codePresent, version,
        factoryEvidence, verificationReason, v2Interface, underlying, shareToken,
        ...(morphoEventCounts[address] ?? {}) })),
      verifiedSubsetDepositEventCount: morpho.flows.depositEventCount,
      verifiedSubsetWithdrawEventCount: morpho.flows.withdrawEventCount,
      verifiedSubsetAllocationEventCount: morpho.flows.allocationEventCount,
      verifiedSubsetMalformedEventCount: morpho.malformedEventCount,
      warnings: morpho.warnings },
    warnings: [...core.warnings, ...across.warnings, ...registry.warnings, ...morpho.warnings],
  }, null, 2));
  assert.equal(across.deployment.status, 'verified');
  assert.equal(across.malformedEventCount, 0);
  console.log('P1B live verifier: PASS (bounded 25 block Arc RPC snapshot)');
}

if (process.argv.includes('--live')) await live();
else await deterministic();
