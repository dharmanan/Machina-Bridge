import assert from 'node:assert/strict';
import https from 'node:https';
import httpsProxyAgent from 'https-proxy-agent';
import { ARC_CHAIN_ID, ARC_RPC_URL, createArcRpcClient } from '../api/_lib/arc-intelligence/rpc.js';
import { buildHistoricalRange } from '../api/_lib/arc-intelligence/history.js';
import { buildHistoricalMetrics, createMetricAccumulator } from '../api/_lib/arc-intelligence/metrics.js';
import { TRANSFER_TOPIC, USDC_ERC20_ADDRESS, USDC_SYSTEM_EMITTER } from '../api/_lib/arc-intelligence/usdc.js';

const { HttpsProxyAgent } = httpsProxyAgent;
const HASH = (number) => `0x${number.toString(16).padStart(64, '0')}`;
const ADDRESS = (number) => `0x${number.toString(16).padStart(40, '0')}`;
const ZERO_TOPIC = `0x${'0'.repeat(64)}`;
const topicAddress = (address) => `0x${address.slice(2).padStart(64, '0')}`;

function block(number, timestamp) {
  return {
    number, hash: HASH(number + 1), parentHash: HASH(number), timestamp,
    transactions: [{ hash: HASH(number + 100), blockNumber: number, transactionIndex: 0,
      from: ADDRESS(number % 2 + 1), to: ADDRESS(3), valueRaw: '0' }], transactionCount: 1,
  };
}

function transfer(number, emitter, raw, from = ADDRESS(1), to = ADDRESS(2), logIndex = 0) {
  return {
    address: emitter.toLowerCase(), topics: [TRANSFER_TOPIC, topicAddress(from), topicAddress(to)],
    data: `0x${BigInt(raw).toString(16).padStart(64, '0')}`,
    blockNumber: number, transactionIndex: 0, logIndex, transactionHash: HASH(number + 100),
  };
}

function snapshot(start, end, { incomplete = false, missingReceipt = false, timestamps = {}, logs = [] } = {}) {
  const blocks = Array.from({ length: end - start + 1 }, (_, i) => block(start + i, timestamps[start + i] ?? 1000 + start + i));
  const receipts = blocks.map((item) => ({ hash: item.transactions[0].hash, blockNumber: item.number,
    transactionIndex: 0, status: 'success', gasUsedRaw: '21000', effectiveGasPriceRaw: '2',
    contractAddress: null, logs: [] }));
  if (missingReceipt) receipts.pop();
  return {
    chainId: ARC_CHAIN_ID, source: ARC_RPC_URL, definitionVersion: 'arc-intelligence-core-v1',
    startBlock: start, endBlock: end, lastIndexedBlock: incomplete || missingReceipt ? end - 1 : end,
    blockCount: blocks.length, totalTransactions: blocks.length, receiptCount: receipts.length,
    blocks, transactions: blocks.flatMap((item) => item.transactions), receipts,
    logs, transferLogs: logs, verifiedAssetObservations: ['USDC', 'EURC', 'cirBTC', 'WETH', 'USYC']
      .map((symbol) => ({ symbol, liveMetadataMatchesRegistry: true })),
    complete: !incomplete && !missingReceipt, warnings: missingReceipt ? ['Receipt missing.'] : [],
  };
}

function protocolBuilders() {
  return Object.fromEntries(['uniswap', 'aave', 'morpho', 'cctp', 'gateway'].map((name) => [name,
    async ({ phase1aSnapshot }) => ({ definitionVersion: `${name}-fixture-v1`, complete: name !== 'morpho',
      completeness: name === 'morpho' ? {
        verifiedVaultEventScanComplete: true, candidateCoverageComplete: false, complete: false,
      } : { complete: true },
      candidates: name === 'morpho' ? [{ address: ADDRESS(900), status: 'verified' }] : [],
      rawFlows: [], outboundBurns: [], inboundMints: [], messageReceipts: [],
      deposits: [], burns: [], attestations: [], withdrawals: { initiated: [], completed: [] },
      v3: { complete: true, rawPoolFlows: [] }, v4: { eventScanComplete: true, swapEvents: [], modifyLiquidityEvents: [], poolKeys: [] },
      blockRange: [phase1aSnapshot.startBlock, phase1aSnapshot.endBlock],
    })]));
}

function fakeRpc({ badHash = false } = {}) {
  return {
    url: ARC_RPC_URL,
    async request(method, params) {
      if (method !== 'eth_getBlockByNumber') throw new Error(`Unexpected fixture RPC ${method}`);
      const number = Number(BigInt(params[0]));
      return { hash: badHash ? HASH(999) : HASH(number + 1) };
    },
  };
}

async function fixtures() {
  const builders = protocolBuilders();
  const calls = [];
  const options = { rpc: fakeRpc(), startBlock: 10, endBlock: 15, chunkSize: 2,
    snapshotBuilder: async ({ startBlock, endBlock }) => {
      calls.push([startBlock, endBlock]); return snapshot(startBlock, endBlock);
    }, protocolBuilders: builders };
  const full = await buildHistoricalRange(options);
  assert.deepEqual(calls, [[10, 11], [12, 13], [14, 15]]);
  assert.equal(full.complete, true);
  assert.equal(full.chunks.length, 3);
  assert.equal(full.contiguousEndBlock, 15);
  assert.equal(full.checkpoint.nextBlock, 16);
  assert.equal(full.coreCoverage.expectedReceipts, 6);
  assert.equal(full.coreCoverage.observedReceipts, 6);
  assert.equal(full.protocolCoverage.morpho.complete, false);
  assert.equal(full.protocolCoverage.morpho.verifiedVaultEventScanComplete, true);
  assert.equal(full.protocolCoverage.morpho.candidateCoverageComplete, false);
  assert.equal(full.protocolCoverage.cctp.crossChainCompletionCoverage.status, 'unavailable');

  const middleMissing = await buildHistoricalRange({ ...options,
    snapshotBuilder: async ({ startBlock, endBlock }) => snapshot(startBlock, endBlock, { incomplete: startBlock === 12 }) });
  assert.equal(middleMissing.complete, false);
  assert.equal(middleMissing.checkpoint.lastIndexedBlock, 11);
  assert.deepEqual(middleMissing.missingRanges[0], { startBlock: 12, endBlock: 13, reason: 'incomplete_chunk' });
  assert.equal(middleMissing.chunks.length, 2);
  const missingReceipt = await buildHistoricalRange({ ...options,
    snapshotBuilder: async ({ startBlock, endBlock }) => snapshot(startBlock, endBlock, { missingReceipt: startBlock === 12 }) });
  assert.equal(missingReceipt.checkpoint.lastIndexedBlock, 11);
  assert.equal(missingReceipt.complete, false);
  const mismatch = await buildHistoricalRange({ ...options,
    snapshotBuilder: async ({ startBlock, endBlock }) => {
      const item = snapshot(startBlock, endBlock);
      if (startBlock === 12) item.blocks[0].parentHash = HASH(900);
      return item;
    } });
  assert.equal(mismatch.continuityComplete, false);
  assert.equal(mismatch.checkpoint.lastIndexedBlock, 11);

  const firstPart = await buildHistoricalRange({ ...options, endBlock: 15,
    snapshotBuilder: async ({ startBlock, endBlock }) => {
      if (startBlock === 12) return snapshot(startBlock, endBlock, { incomplete: true });
      return snapshot(startBlock, endBlock);
    } });
  const resumed = await buildHistoricalRange({ ...options, checkpoint: firstPart.checkpoint,
    previousResult: firstPart, snapshotBuilder: async ({ startBlock, endBlock }) => snapshot(startBlock, endBlock) });
  assert.equal(resumed.complete, true);
  assert.equal(resumed.checkpointPrefixVerified, true);
  assert.equal(resumed.materializedCoverageComplete, true);
  assert.deepEqual(resumed.chunkSnapshots.map((item) => item.startBlock), [10, 12, 14]);
  assert.equal(resumed.coreCoverage.indexedBlocks, 6);
  assert.equal(buildHistoricalMetrics(resumed).buckets.hour[0].records
    .find((record) => record.metricId === 'network.transactionCount').value, 6);
  const checkpointOnly = await buildHistoricalRange({ ...options, checkpoint: firstPart.checkpoint,
    snapshotBuilder: async ({ startBlock, endBlock }) => snapshot(startBlock, endBlock) });
  assert.equal(checkpointOnly.checkpointPrefixVerified, true);
  assert.equal(checkpointOnly.continuityComplete, true);
  assert.equal(checkpointOnly.checkpoint.complete, true);
  assert.equal(checkpointOnly.coreCoverage.checkpointCoverageComplete, true);
  assert.equal(checkpointOnly.coreCoverage.materializedCoverageComplete, false);
  assert.equal(checkpointOnly.coreCoverage.complete, false);
  assert.equal(checkpointOnly.complete, false);
  assert.equal(checkpointOnly.coreCoverage.indexedBlocks, 4);
  assert.ok(buildHistoricalMetrics(checkpointOnly).records.every((record) => record.complete === false));
  await assert.rejects(buildHistoricalRange({ ...options, chunkSize: 51 }), /chunkSize/);
  await assert.rejects(buildHistoricalRange({ ...options, endBlock: 510 }), /Historical range/);
  const wrongHash = await buildHistoricalRange({ ...options, rpc: fakeRpc({ badHash: true }),
    checkpoint: firstPart.checkpoint, previousResult: firstPart });
  assert.equal(wrongHash.complete, false);
  assert.equal(wrongHash.checkpoint.lastIndexedBlock, 11);
  assert.equal(wrongHash.continuityComplete, false);

  const midnight = 172800;
  const times = { 20: midnight - 1, 21: midnight, 22: midnight + 3599, 23: midnight + 3600,
    24: midnight + 86399, 25: midnight + 86400 };
  const huge = '900719925474099312345';
  const logs = [
    transfer(21, USDC_SYSTEM_EMITTER, huge), transfer(21, USDC_ERC20_ADDRESS, '1000000', ADDRESS(1), ADDRESS(2), 1),
    transfer(22, USDC_SYSTEM_EMITTER, '7', ADDRESS(1), ADDRESS(2), 2),
    transfer(22, USDC_SYSTEM_EMITTER, '5', ADDRESS(1), ADDRESS(2), 3),
    transfer(24, USDC_SYSTEM_EMITTER, '9', ADDRESS(1), ADDRESS(2), 4),
    transfer(21, ADDRESS(900), '15', ADDRESS(1), ADDRESS(2), 5), // Vault share transfer is not a Morpho deposit.
  ];
  const richBuilders = Object.fromEntries(Object.entries(builders).map(([name, builder]) => [name,
    async (input) => {
      const result = await builder(input);
      if (input.phase1aSnapshot.startBlock !== 20) return result;
      const at21 = { blockNumber: 21, transactionIndex: 0, logIndex: 7 };
      if (name === 'uniswap') result.v3.rawPoolFlows = [{ ...at21, type: 'swap', pool: ADDRESS(701),
        token0: { address: ADDRESS(702) }, token1: { address: ADDRESS(703) },
        token0InRaw: '10', token0OutRaw: '0', token1InRaw: '0', token1OutRaw: '20' }];
      if (name === 'morpho') result.rawFlows = [{ ...at21, type: 'deposit', emitter: ADDRESS(900), assetsRaw: '31', sharesRaw: '29' }];
      if (name === 'cctp') {
        result.inboundMints = [{ ...at21, mintToken: USDC_ERC20_ADDRESS, amountRaw: '50', feeCollectedRaw: '1' }];
        result.messageReceipts = [{ ...at21, logIndex: 8 }];
      }
      if (name === 'gateway') {
        result.deposits = [{ ...at21, token: USDC_ERC20_ADDRESS, valueRaw: '60', category: 'gateway_balance_funding' }];
        result.withdrawals.initiated = [{ ...at21, logIndex: 9, token: USDC_ERC20_ADDRESS, valueRaw: '4' }];
      }
      return result;
    }]));
  const bucketHistory = await buildHistoricalRange({ rpc: fakeRpc(), startBlock: 20, endBlock: 25, chunkSize: 2,
    snapshotBuilder: async ({ startBlock, endBlock }) => snapshot(startBlock, endBlock,
      { timestamps: times, logs: logs.filter((log) => log.blockNumber >= startBlock && log.blockNumber <= endBlock) }),
    protocolBuilders: richBuilders });
  const metrics = buildHistoricalMetrics(bucketHistory);
  const closedHour = metrics.buckets.hour.find((item) => item.bucketStartUtc === new Date(midnight * 1000).toISOString());
  assert.equal(closedHour.complete, true);
  assert.equal(closedHour.coreBoundaryComplete, true);
  assert.equal(closedHour.leftBoundaryCovered, true);
  assert.equal(closedHour.rightBoundaryCovered, true);
  const find = (bucket, id) => bucket.records.find((record) => record.metricId === id);
  assert.equal(find(closedHour, 'network.blockCount').value, 2);
  assert.equal(find(closedHour, 'network.uniqueTopLevelSenders').value, 2);
  assert.equal(find(closedHour, 'network.uniqueTopLevelRecipients').value, 1);
  assert.equal(find(closedHour, 'network.totalTransactionFeesRaw').value, '84000');
  assert.equal(find(closedHour, 'asset.USDC.canonical.rawTransferAmount').value, (BigInt(huge) + 12n).toString());
  assert.equal(find(closedHour, 'asset.USDC.interface.rawTransferAmount').value, '1000000');
  assert.equal(find(closedHour, 'asset.USDC.canonical.rawTransferAmount').complete, false);
  assert.equal(find(closedHour, 'asset.USDC.canonical.rawTransferAmount').coverageStatus, 'partial');
  assert.equal(find(closedHour, 'network.transactionCount').coverageStatus, 'available');
  assert.equal(find(closedHour, 'aave.v4.totalValueLocked').coverageStatus, 'unavailable');
  assert.equal(find(closedHour, 'aave.v4.totalValueLocked').value, null);
  assert.equal(find(closedHour, 'cctp.v2.arcInboundMintLegCount').value, 1);
  assert.equal(find(closedHour, 'cctp.v2.messageReceivedCount').value, 1);
  assert.equal(find(closedHour, 'cctp.v2.arcInboundMintRaw').value, '50');
  assert.equal(find(closedHour, 'gateway.gatewayDepositCount').value, 1);
  assert.equal(find(closedHour, 'gateway.crossDomainSourceLegCount').value, 0);
  assert.equal(find(closedHour, 'gateway.withdrawalInitiatedCount').value, 1);
  assert.equal(find(closedHour, 'morpho.v2.depositEventCount').value, 1);
  assert.equal(find(closedHour, 'morpho.v2.depositEventCount').complete, true);
  assert.deepEqual(find(closedHour, 'morpho.v2.depositEventCount').verifiedVaults, [ADDRESS(900)]);
  assert.equal(find(closedHour, 'morpho.v2.depositEventCount').stableVerifiedVaultCount, 1);
  assert.equal(find(closedHour, 'morpho.v2.depositEventCount').protocolUniverseComplete, false);
  assert.equal(find(closedHour, 'morpho.v2.deposit.assetsRaw').value, '31');
  assert.equal(find(closedHour, 'morpho.v2.deposit.sharesRaw').value, '29');
  assert.equal(find(closedHour, 'uniswap.v3.verifiedPool.swapEventCount').value, 1);
  assert.equal(find(closedHour, 'cctp.v2.crossChainCompletedCount').coverageStatus, 'unavailable');
  assert.equal(find(closedHour, 'gateway.crossChainCompletedCount').coverageStatus, 'unavailable');
  assert.equal(metrics.buckets.hour[0].complete, false);
  const day = metrics.buckets.day.find((item) => item.bucketStartUtc === new Date(midnight * 1000).toISOString());
  assert.equal(day.complete, true);
  assert.equal(day.rightBoundaryCovered, true);
  assert.equal(metrics.buckets.day.at(-1).complete, false);
  assert.deepEqual(find(day, 'network.transactionCount').sourceDefinitionVersions.core, 'arc-intelligence-core-v1');
  const changingVaultHistory = structuredClone(bucketHistory);
  changingVaultHistory.protocolSnapshots[1].morpho.candidates = [{ address: ADDRESS(901), status: 'verified' }];
  changingVaultHistory.protocolSnapshots[1].morpho.rawFlows = [{ blockNumber: 22, transactionIndex: 0,
    logIndex: 7, type: 'deposit', emitter: ADDRESS(901), assetsRaw: '17', sharesRaw: '16' }];
  const changingHour = buildHistoricalMetrics(changingVaultHistory).buckets.hour
    .find((item) => item.bucketStartUtc === new Date(midnight * 1000).toISOString());
  const changingMorpho = find(changingHour, 'morpho.v2.depositEventCount');
  assert.equal(changingMorpho.value, 0);
  assert.equal(changingMorpho.complete, false);
  assert.equal(changingMorpho.coverageStatus, 'partial');
  assert.deepEqual(changingMorpho.verifiedVaults, []);
  assert.equal(changingMorpho.stableVerifiedVaultCount, 0);
  const mixedVersionHistory = structuredClone(bucketHistory);
  mixedVersionHistory.protocolSnapshots[1].uniswap.definitionVersion = 'uniswap-fixture-v2';
  const mixedHour = buildHistoricalMetrics(mixedVersionHistory).buckets.hour
    .find((item) => item.bucketStartUtc === new Date(midnight * 1000).toISOString());
  const mixedUniswap = find(mixedHour, 'uniswap.v3.verifiedPool.swapEventCount');
  assert.equal(mixedUniswap.complete, false);
  assert.equal(mixedUniswap.coverageStatus, 'partial');
  assert.deepEqual(mixedUniswap.sourceDefinitionVersions.uniswap,
    ['uniswap-fixture-v1', 'uniswap-fixture-v2']);
  assert.equal(find(closedHour, 'uniswap.v3.verifiedPool.swapEventCount').complete, true);
  mixedVersionHistory.protocolSnapshots[2].uniswap.definitionVersion = 'uniswap-fixture-v3';
  const firstHour = buildHistoricalMetrics(mixedVersionHistory).buckets.hour
    .find((item) => item.bucketStartUtc === new Date((midnight - 3600) * 1000).toISOString());
  assert.deepEqual(find(firstHour, 'network.transactionCount').sourceDefinitionVersions.uniswap,
    ['uniswap-fixture-v1']);
  assert.doesNotMatch(JSON.stringify(metrics.records), /"metricId":"(?:usdVolume|tvl|uniqueUsers|arcDexVolume|crossChainCompletedCount)"/);
  const accumulator = createMetricAccumulator();
  accumulator.addChunk(bucketHistory.chunkSnapshots[0], bucketHistory.protocolSnapshots[0]);
  assert.throws(() => accumulator.addChunk(bucketHistory.chunkSnapshots[0], bucketHistory.protocolSnapshots[0]), /duplicate|missing|discontinuous/);
  console.log('DETERMINISTIC HISTORY FIXTURES: PASS');
}

function liveRpc() {
  const proxyUrl = process.env.HTTPS_PROXY;
  if (!proxyUrl) throw new Error('The safe wrapper HTTPS proxy is unavailable.');
  const agent = new HttpsProxyAgent(proxyUrl);
  const fetchArcOnly = async (input, init = {}) => {
    const target = new URL(typeof input === 'string' ? input : input.url);
    if (target.href !== `${ARC_RPC_URL}/` && target.href !== ARC_RPC_URL) throw new Error('Only canonical Arc RPC is allowed.');
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
  return createArcRpcClient({ url: ARC_RPC_URL, fetchImpl: fetchArcOnly, maxAttempts: 3 });
}

async function live() {
  const rpc = liveRpc();
  const chainId = Number(BigInt(await rpc.request('eth_chainId')));
  assert.equal(chainId, ARC_CHAIN_ID);
  const head = Number(BigInt(await rpc.request('eth_blockNumber')));
  const endBlock = head - 2;
  const startBlock = endBlock - 99;
  const result = await buildHistoricalRange({ rpc, startBlock, endBlock, chunkSize: 25 });
  const metrics = buildHistoricalMetrics(result);
  const completeChunks = result.chunks.filter((chunk) => chunk.complete);
  const correctness = result.chunks.every((chunk, index) => chunk.blockCount <= 25
      && chunk.startBlock === (index === 0 ? startBlock : result.chunks[index - 1].endBlock + 1))
    && completeChunks.length === result.chunkSnapshots.length
    && result.chunkSnapshots.every((snapshot, index) => snapshot.receiptCount === snapshot.totalTransactions
      && snapshot.blocks.length === snapshot.blockCount
      && snapshot.transferScanComplete === true
      && result.protocolSnapshots[index] !== undefined)
    && result.coreCoverage.indexedBlocks === completeChunks.reduce((total, chunk) => total + chunk.blockCount, 0)
    && result.checkpoint.nextBlock === (result.contiguousEndBlock ?? (startBlock - 1)) + 1
    && (result.complete ? result.coreCoverage.indexedBlocks === 100 && result.missingRanges.length === 0 : true)
    && metrics.records.every((record) => record.complete === (record.coverageStatus === 'available'))
    && [...metrics.buckets.hour, ...metrics.buckets.day].every((bucket) =>
      !bucket.complete || (bucket.leftBoundaryCovered && bucket.rightBoundaryCovered && bucket.blockHistoryContiguous));
  assert.equal(correctness, true, 'Historical continuity or metric contract invariant failed.');
  console.log(JSON.stringify({
    chainId, head, requestedRange: { startBlock, endBlock },
    chunkCount: result.chunks.length, completeChunkCount: result.chunks.filter((chunk) => chunk.complete).length,
    contiguousThroughBlock: result.contiguousEndBlock, missingRanges: result.missingRanges,
    checkpoint: result.checkpoint, continuityComplete: result.continuityComplete,
    coreCoverage: result.coreCoverage, protocolCoverage: result.protocolCoverage,
    hourlyBucketStates: metrics.buckets.hour.map((bucket) => ({
      bucketStartUtc: bucket.bucketStartUtc, leftBoundaryCovered: bucket.leftBoundaryCovered,
      rightBoundaryCovered: bucket.rightBoundaryCovered, complete: bucket.complete,
    })),
    dailyBucketStates: metrics.buckets.day.map((bucket) => ({ bucketStartUtc: bucket.bucketStartUtc, complete: bucket.complete })),
    metricRecordCount: metrics.records.length, legacyUsdcCoverage: result.legacyUsdcCoverage,
    warnings: result.warnings, verifierCorrectness: 'PASS', dataCompleteness: result.complete ? 'COMPLETE' : 'INCOMPLETE',
  }, null, 2));
  console.log('LIVE HISTORY VERIFIER_CORRECTNESS: PASS');
}

const mode = process.argv[2] ?? 'all';
assert.ok(['all', '--fixtures-only', '--live-only'].includes(mode));
if (mode !== '--live-only') await fixtures();
if (mode !== '--fixtures-only') await live();
