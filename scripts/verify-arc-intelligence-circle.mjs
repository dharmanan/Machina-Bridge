import assert from 'node:assert/strict';
import https from 'node:https';
import httpsProxyAgent from 'https-proxy-agent';
import { encodeAbiParameters, encodeFunctionData, parseAbiItem, toEventSelector } from 'viem';
import { buildLatestSnapshot } from '../api/_lib/arc-intelligence/core.js';
import { ARC_CHAIN_ID, ARC_RPC_URL, createArcRpcClient } from '../api/_lib/arc-intelligence/rpc.js';
import { CCTP_V2_ABI, CCTP_V2_ARC, buildCctpV2Snapshot } from '../api/_lib/arc-intelligence/cctp.js';
import { GATEWAY_ABI, GATEWAY_ARC, buildGatewaySnapshot } from '../api/_lib/arc-intelligence/gateway.js';

const { HttpsProxyAgent } = httpsProxyAgent;
const END_BLOCK = 101;
const BLOCK_TAG = '0x65';
const USER = '0x0000000000000000000000000000000000000101';
const OTHER = '0x0000000000000000000000000000000000000102';
const FAKE = '0x0000000000000000000000000000000000000999';
const HASH = `0x${'ab'.repeat(32)}`;
const OTHER_HASH = `0x${'cd'.repeat(32)}`;

function bytes32Text(value) {
  return `0x${Buffer.from(value, 'utf8').toString('hex').padEnd(64, '0')}`;
}

function fixtureEvent(abi, emitter, values, logIndex) {
  const topics = [toEventSelector(abi)];
  const nonindexed = [];
  const nonindexedValues = [];
  for (const input of abi.inputs) {
    if (input.indexed) topics.push(encodeAbiParameters([{ type: input.type }], [values[input.name]]));
    else {
      nonindexed.push(input);
      nonindexedValues.push(values[input.name]);
    }
  }
  return {
    address: emitter.toLowerCase(),
    topics: topics.map((topic) => topic.toLowerCase()),
    data: encodeAbiParameters(nonindexed, nonindexedValues).toLowerCase(),
    blockNumber: END_BLOCK,
    transactionIndex: 0,
    transactionHash: `0x${(logIndex + 1).toString(16).padStart(64, '0')}`,
    logIndex,
    removed: false,
  };
}

function fixtureLogs() {
  const huge = 900719925474099312345n;
  const cctpBurn = fixtureEvent(CCTP_V2_ABI.depositForBurn, CCTP_V2_ARC.tokenMessenger, {
    burnToken: CCTP_V2_ARC.usdcInterface, amount: huge, depositor: USER,
    mintRecipient: HASH, destinationDomain: 7, destinationTokenMessenger: HASH,
    destinationCaller: OTHER_HASH, maxFee: 123n, minFinalityThreshold: 2000, hookData: '0x1234',
  }, 1);
  const cctpMint = fixtureEvent(CCTP_V2_ABI.mintAndWithdraw, CCTP_V2_ARC.tokenMessenger, {
    mintRecipient: USER, amount: 800n, mintToken: CCTP_V2_ARC.usdcInterface, feeCollected: 20n,
  }, 2);
  const message = { ...fixtureEvent(CCTP_V2_ABI.messageReceived, CCTP_V2_ARC.messageTransmitter, {
    caller: USER, sourceDomain: 7, nonce: HASH, sender: OTHER_HASH,
    finalityThresholdExecuted: 2000, messageBody: '0x123456',
  }, 3), transactionHash: cctpMint.transactionHash };
  const gatewayDeposit = fixtureEvent(GATEWAY_ABI.deposited, GATEWAY_ARC.wallet, {
    token: GATEWAY_ARC.usdcInterface, depositor: USER, sender: OTHER, value: 1000n,
  }, 4);
  const gatewayBurn = fixtureEvent(GATEWAY_ABI.gatewayBurned, GATEWAY_ARC.wallet, {
    token: GATEWAY_ARC.usdcInterface, depositor: USER, transferSpecHash: HASH,
    destinationDomain: 7, destinationRecipient: OTHER_HASH, signer: OTHER,
    value: 900n, fee: 10n, fromAvailable: 400n, fromWithdrawing: 510n,
  }, 5);
  const sameDomainBurn = fixtureEvent(GATEWAY_ABI.gatewayBurned, GATEWAY_ARC.wallet, {
    token: GATEWAY_ARC.usdcInterface, depositor: USER, transferSpecHash: OTHER_HASH,
    destinationDomain: 26, destinationRecipient: HASH, signer: OTHER,
    value: 100n, fee: 1n, fromAvailable: 101n, fromWithdrawing: 0n,
  }, 6);
  const attestation = fixtureEvent(GATEWAY_ABI.attestationUsed, GATEWAY_ARC.minter, {
    token: GATEWAY_ARC.usdcInterface, recipient: USER, transferSpecHash: HASH,
    sourceDomain: 7, sourceDepositor: OTHER_HASH, sourceSigner: HASH, value: 900n,
  }, 7);
  const initiated = fixtureEvent(GATEWAY_ABI.withdrawalInitiated, GATEWAY_ARC.wallet, {
    token: GATEWAY_ARC.usdcInterface, depositor: USER, value: 50n,
    remainingAvailable: 100n, totalWithdrawing: 50n, withdrawalBlock: 110n,
  }, 8);
  const completed = fixtureEvent(GATEWAY_ABI.withdrawalCompleted, GATEWAY_ARC.wallet, {
    token: GATEWAY_ARC.usdcInterface, depositor: USER, value: 50n,
  }, 9);
  return {
    huge,
    logs: [cctpBurn, cctpMint, message, gatewayDeposit, gatewayBurn, sameDomainBurn, attestation, initiated, completed,
      { ...cctpBurn, address: FAKE, logIndex: 10 },
      { ...gatewayBurn, address: FAKE, logIndex: 11 }],
  };
}

function fixtureSnapshot(logs, complete = true) {
  return {
    chainId: ARC_CHAIN_ID, startBlock: END_BLOCK - 1, endBlock: END_BLOCK,
    complete, logs,
  };
}

function fixtureRpc({ wrongCctpLink = false, wrongGatewayDomain = false, unsupportedGatewayUsdc = false, unavailableAddress = null } = {}) {
  const calls = [];
  const cctpMessenger = CCTP_V2_ARC.tokenMessenger.toLowerCase();
  const cctpTransmitter = CCTP_V2_ARC.messageTransmitter.toLowerCase();
  const wallet = GATEWAY_ARC.wallet.toLowerCase();
  const minter = GATEWAY_ARC.minter.toLowerCase();
  const usdc = GATEWAY_ARC.usdcInterface.toLowerCase();
  const known = new Set([cctpMessenger, cctpTransmitter, wallet, minter, usdc]);
  const word = (value) => encodeAbiParameters([{ type: 'uint256' }], [BigInt(value)]);
  const selector = (signature, functionName, args = []) => encodeFunctionData({
    abi: [parseAbiItem(signature)], functionName, args,
  }).slice(0, 10);
  const localDomainSelector = selector('function localDomain() view returns (uint32)', 'localDomain');
  const localTransmitterSelector = selector('function localMessageTransmitter() view returns (address)', 'localMessageTransmitter');
  const domainSelector = selector('function domain() view returns (uint32)', 'domain');
  const tokenSupportedSelector = selector('function isTokenSupported(address token) view returns (bool)', 'isTokenSupported', [usdc]);
  return {
    calls,
    rpc: {
      url: ARC_RPC_URL,
      async request(method, params) {
        calls.push({ method, params });
        assert.equal(params[1], BLOCK_TAG, 'historical blockTag propagated to every read');
        const to = String(method === 'eth_getCode' ? params[0] : params[0].to).toLowerCase();
        if (to === unavailableAddress?.toLowerCase()) throw new Error('transient RPC read unavailable');
        if (method === 'eth_getCode') return known.has(to) ? '0x6001' : '0x';
        assert.equal(method, 'eth_call');
        const selector = params[0].data.slice(0, 10);
        if (to === cctpTransmitter && selector === localDomainSelector) return word(26);
        if (to === cctpMessenger && selector === localTransmitterSelector) return encodeAbiParameters([{ type: 'address' }], [wrongCctpLink ? OTHER : CCTP_V2_ARC.messageTransmitter]);
        if ((to === wallet || to === minter) && selector === domainSelector) return word(wrongGatewayDomain && to === minter ? 27 : 26);
        if ((to === wallet || to === minter) && selector === tokenSupportedSelector) return word(unsupportedGatewayUsdc ? 0 : 1);
        if (to === usdc && selector === '0x06fdde03') return bytes32Text('USDC');
        if (to === usdc && selector === '0x95d89b41') return bytes32Text('USDC');
        if (to === usdc && selector === '0x313ce567') return word(6);
        if (to === usdc && selector === '0x18160ddd') return word(1000000);
        throw new Error(`Unexpected fixture view: ${to} ${selector}`);
      },
    },
  };
}

async function verifyFixtures() {
  const { logs, huge } = fixtureLogs();
  const fixture = fixtureRpc();
  const phase1aSnapshot = fixtureSnapshot(logs);
  const cctp = await buildCctpV2Snapshot({ phase1aSnapshot, rpc: fixture.rpc });
  const gateway = await buildGatewaySnapshot({ phase1aSnapshot, rpc: fixture.rpc });
  assert.equal(cctp.contractVerification.contractsVerified, true);
  assert.equal(cctp.arcDomain, 26);
  assert.equal(cctp.eventCounts.arcOutboundBurnLegCount, 1);
  assert.equal(cctp.eventCounts.arcInboundMintLegCount, 1);
  assert.equal(cctp.eventCounts.messageReceivedCount, 1);
  assert.equal(cctp.outboundBurns[0].amountRaw, huge.toString(10));
  assert.equal(cctp.outboundBurns[0].amountUnits, 'USDC ERC20 interface raw units');
  assert.equal(cctp.outboundBurns[0].maxFeeRaw, '123');
  assert.equal(cctp.outboundBurns[0].minFinalityThreshold, 2000);
  assert.equal(cctp.outboundBurns[0].hookDataLength, 2);
  assert.equal(cctp.inboundMints[0].feeCollectedRaw, '20');
  assert.equal(cctp.messageReceipts[0].sourceDomain, 7);
  assert.equal(cctp.messageReceipts[0].messageBodyLength, 3);
  assert.equal(cctp.messageToMintLinks.length, 1);
  assert.equal(cctp.messageToMintLinks[0].transactionHash, cctp.inboundMints[0].transactionHash);
  assert.equal(cctp.complete, true);
  assert.equal(gateway.contractVerification.sharedDomainVerified, true);
  assert.equal(gateway.verifiedDomain, 26);
  assert.equal(gateway.eventCounts.gatewayDepositCount, 1);
  assert.equal(gateway.gatewayDepositRawByToken[GATEWAY_ARC.usdcInterface], '1000');
  assert.equal(gateway.eventCounts.gatewayBurnCount, 2);
  assert.equal(gateway.eventCounts.gatewayAttestationCount, 1);
  assert.equal(gateway.eventCounts.withdrawalInitiatedCount, 1);
  assert.equal(gateway.eventCounts.withdrawalCompletedCount, 1);
  assert.equal(gateway.burns[0].transferSpecHash, HASH);
  assert.equal(gateway.burns[0].valueRaw, '900');
  assert.equal(gateway.burns[0].feeRaw, '10');
  assert.equal(gateway.burns[0].category, 'cross_domain_source_leg');
  assert.equal(gateway.burns[1].category, 'same_domain_source_leg');
  assert.equal(gateway.attestations[0].category, 'cross_domain_destination_leg');
  assert.deepEqual(gateway.linkedTransferSpecHashes, [HASH]);
  assert.equal(gateway.complete, true);
  assert.ok(fixture.calls.some(({ method }) => method === 'eth_getCode'));
  assert.ok(fixture.calls.some(({ method }) => method === 'eth_call'));

  const malformedCctp = await buildCctpV2Snapshot({
    phase1aSnapshot: fixtureSnapshot([...logs, { ...logs[0], data: '0x12', logIndex: 12 }]),
    rpc: fixtureRpc().rpc,
  });
  assert.equal(malformedCctp.eventCounts.malformedEventCount, 1);
  assert.equal(malformedCctp.arcLegEventScanComplete, false);
  assert.equal(malformedCctp.complete, false);
  const ambiguousCctp = await buildCctpV2Snapshot({
    phase1aSnapshot: fixtureSnapshot([...logs, { ...logs[1], logIndex: 12 }]),
    rpc: fixtureRpc().rpc,
  });
  assert.equal(ambiguousCctp.eventCounts.arcInboundMintLegCount, 2);
  assert.equal(ambiguousCctp.messageToMintLinks.length, 0, 'multiple same-transaction mints cannot be paired by guesswork');
  const malformedGateway = await buildGatewaySnapshot({
    phase1aSnapshot: fixtureSnapshot([...logs, { ...logs[4], data: '0x12', logIndex: 13 }]),
    rpc: fixtureRpc().rpc,
  });
  assert.equal(malformedGateway.eventCounts.malformedEventCount, 1);
  assert.equal(malformedGateway.arcLegEventScanComplete, false);
  assert.equal(malformedGateway.complete, false);
  assert.equal((await buildCctpV2Snapshot({ phase1aSnapshot, rpc: fixtureRpc({ wrongCctpLink: true }).rpc })).contractVerification.contractsVerified, false);
  assert.equal((await buildGatewaySnapshot({ phase1aSnapshot, rpc: fixtureRpc({ wrongGatewayDomain: true }).rpc })).verifiedDomain, null);
  assert.equal((await buildGatewaySnapshot({ phase1aSnapshot, rpc: fixtureRpc({ unsupportedGatewayUsdc: true }).rpc })).complete, false);
  const unavailableCctp = await buildCctpV2Snapshot({
    phase1aSnapshot, rpc: fixtureRpc({ unavailableAddress: CCTP_V2_ARC.messageTransmitter }).rpc,
  });
  assert.equal(unavailableCctp.deployments.messageTransmitter.codePresent, null);
  assert.equal(unavailableCctp.arcDomain, null);
  assert.equal(unavailableCctp.complete, false);
  const unavailableGateway = await buildGatewaySnapshot({
    phase1aSnapshot, rpc: fixtureRpc({ unavailableAddress: GATEWAY_ARC.wallet }).rpc,
  });
  assert.equal(unavailableGateway.wallet.codePresent, null);
  assert.equal(unavailableGateway.verifiedDomain, null);
  assert.equal(unavailableGateway.complete, false);
  assert.equal((await buildCctpV2Snapshot({ phase1aSnapshot: fixtureSnapshot(logs, false), rpc: fixtureRpc().rpc })).complete, false);
  assert.equal((await buildGatewaySnapshot({ phase1aSnapshot: fixtureSnapshot(logs, false), rpc: fixtureRpc().rpc })).complete, false);
  for (const snapshot of [cctp, gateway]) {
    assert.equal(snapshot.crossChainCompletionCoverage.status, 'unavailable');
    assert.doesNotMatch(JSON.stringify(snapshot), /"(?:usdVolume|tvl|userCount|crossChainCompleted)":/);
  }
  console.log('DETERMINISTIC CIRCLE FIXTURES: PASS');
}

function liveRpc() {
  const proxyUrl = process.env.HTTPS_PROXY;
  if (!proxyUrl) throw new Error('The safe wrapper HTTPS proxy is unavailable.');
  const agent = new HttpsProxyAgent(proxyUrl);
  const fetchArcOnly = async (input, init = {}) => {
    const target = new URL(typeof input === 'string' ? input : input.url);
    if (target.href !== 'https://rpc.mainnet.arc.io/' && target.href !== ARC_RPC_URL) {
      throw new Error('Live verifier egress is restricted to https://rpc.mainnet.arc.io.');
    }
    return new Promise((resolve, reject) => {
      const request = https.request(target, {
        method: init.method ?? 'GET', headers: init.headers, agent, signal: init.signal,
      }, (response) => {
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

async function verifyLive() {
  const rpc = liveRpc();
  const snapshot = await buildLatestSnapshot({ rpc, windowSize: 25 });
  assert.equal(snapshot.chainId, ARC_CHAIN_ID);
  assert.equal(snapshot.blockCount, 25);
  assert.equal(snapshot.receiptCount, snapshot.totalTransactions);
  assert.equal(snapshot.complete, true, `Phase 1A snapshot incomplete: ${snapshot.warnings.join(' | ')}`);
  const [cctp, gateway] = await Promise.all([
    buildCctpV2Snapshot({ phase1aSnapshot: snapshot, rpc }),
    buildGatewaySnapshot({ phase1aSnapshot: snapshot, rpc }),
  ]);
  console.log(JSON.stringify({
    source: snapshot.source,
    blockRange: cctp.blockRange,
    phase1aComplete: snapshot.complete,
    cctp: {
      deployments: cctp.deployments,
      contractVerification: cctp.contractVerification,
      arcDomain: cctp.arcDomain,
      eventCounts: cctp.eventCounts,
      messageToMintLinkCount: cctp.messageToMintLinks.length,
      arcLegEventScanComplete: cctp.arcLegEventScanComplete,
      crossChainCompletionCoverage: cctp.crossChainCompletionCoverage.status,
      tokenMetadataStatus: cctp.tokenMetadata.status,
      complete: cctp.complete,
      warnings: cctp.warnings,
    },
    gateway: {
      wallet: gateway.wallet,
      minter: gateway.minter,
      verifiedDomain: gateway.verifiedDomain,
      eventCounts: gateway.eventCounts,
      arcLegEventScanComplete: gateway.arcLegEventScanComplete,
      crossChainCompletionCoverage: gateway.crossChainCompletionCoverage.status,
      tokenMetadataStatus: gateway.tokenMetadata.status,
      complete: gateway.complete,
      warnings: gateway.warnings,
    },
  }, null, 2));
  assert.equal(cctp.blockRange.endBlock, snapshot.endBlock);
  assert.equal(gateway.blockRange.endBlock, snapshot.endBlock);
  assert.equal(cctp.arcLegEventScanComplete, cctp.eventCounts.malformedEventCount === 0);
  assert.equal(gateway.arcLegEventScanComplete, gateway.eventCounts.malformedEventCount === 0);
  assert.equal(cctp.contractVerification.contractsVerified, true, 'CCTP V2 code and official local views must verify');
  assert.equal(gateway.contractVerification.sharedDomainVerified, true, 'Gateway code, domain, and USDC support must verify');
  assert.equal(cctp.tokenMetadata.status, 'verified', 'CCTP Arc USDC interface metadata must verify');
  assert.equal(gateway.tokenMetadata.status, 'verified', 'Gateway Arc USDC interface metadata must verify');
  assert.equal(cctp.arcLegEventScanComplete, true);
  assert.equal(gateway.arcLegEventScanComplete, true);
  console.log('LIVE DEPLOYMENT VERIFICATION: PASS');
  console.log('LIVE CIRCLE VERIFIER: PASS');
}

const mode = process.argv[2] ?? 'all';
assert.ok(['all', '--fixtures-only', '--live-only'].includes(mode), 'Use --fixtures-only or --live-only');
if (mode !== '--live-only') await verifyFixtures();
if (mode !== '--fixtures-only') await verifyLive();
