import assert from 'node:assert/strict';
import https from 'node:https';
import httpsProxyAgent from 'https-proxy-agent';
import {
  decodeEventLog,
  encodeAbiParameters,
  parseAbiItem,
  toEventSelector,
} from 'viem';
import { buildLatestSnapshot } from '../api/_lib/arc-intelligence/core.js';
import { ARC_CHAIN_ID, ARC_RPC_URL, createArcRpcClient } from '../api/_lib/arc-intelligence/rpc.js';
import {
  AAVE_V4_DEPLOYMENTS,
  AAVE_V4_EVENT_TOPICS,
  buildAaveV4Snapshot,
  decodeAaveV4Event,
} from '../api/_lib/arc-intelligence/aave.js';
import {
  MORPHO_ARC_CANDIDATE_VAULTS,
  MORPHO_V2_ARC_FACTORY,
  MORPHO_V2_EVENT_TOPICS,
  buildMorphoV2Snapshot,
  decodeMorphoVaultV2Allocation,
  decodeMorphoVaultV2Flow,
} from '../api/_lib/arc-intelligence/morpho.js';

const FIXTURE_END_BLOCK = 0x65;
const { HttpsProxyAgent } = httpsProxyAgent;
const FIXTURE_BLOCK_TAG = `0x${FIXTURE_END_BLOCK.toString(16)}`;
const AAVE_ASSET = '0x0000000000000000000000000000000000000101';
const AAVE_CALLER = '0x0000000000000000000000000000000000000102';
const AAVE_USER = '0x0000000000000000000000000000000000000103';
const AAVE_LIQUIDATOR = '0x0000000000000000000000000000000000000104';
const FAKE_SPOKE = '0x0000000000000000000000000000000000000199';
const MORPHO_UNDERLYING = '0x0000000000000000000000000000000000000201';
const MORPHO_OWNER = '0x0000000000000000000000000000000000000202';
const MORPHO_CURATOR = '0x0000000000000000000000000000000000000203';
const MORPHO_ADAPTER_REGISTRY = '0x0000000000000000000000000000000000000204';
const ALLOCATION_ID = `0x${'ab'.repeat(32)}`;

const AAVE_ABI = [
  parseAbiItem('event Supply(uint256 indexed reserveId, address indexed caller, address indexed user, uint256 suppliedShares, uint256 suppliedAmount)'),
  parseAbiItem('event Withdraw(uint256 indexed reserveId, address indexed caller, address indexed user, uint256 withdrawnShares, uint256 withdrawnAmount)'),
  parseAbiItem('event Borrow(uint256 indexed reserveId, address indexed caller, address indexed user, uint256 drawnShares, uint256 drawnAmount)'),
  parseAbiItem('event Repay(uint256 indexed reserveId, address indexed caller, address indexed user, uint256 drawnShares, uint256 totalAmountRepaid, (int256 sharesDelta, int256 offsetRayDelta, uint256 restoredPremiumRay) premiumDelta)'),
  parseAbiItem('event LiquidationCall(uint256 indexed collateralReserveId, uint256 indexed debtReserveId, address indexed user, address liquidator, bool receiveShares, uint256 debtAmountRestored, uint256 drawnSharesLiquidated, (int256 sharesDelta, int256 offsetRayDelta, uint256 restoredPremiumRay) premiumDelta, uint256 collateralAmountRemoved, uint256 collateralSharesLiquidated, uint256 collateralSharesToLiquidator)'),
  parseAbiItem('event SetUsingAsCollateral(uint256 indexed reserveId, address indexed caller, address indexed user, bool usingAsCollateral)'),
  parseAbiItem('event AddReserve(uint256 indexed reserveId, uint256 indexed assetId, address indexed hub)'),
];

const MORPHO_ABI = [
  parseAbiItem('event Deposit(address indexed sender, address indexed onBehalf, uint256 assets, uint256 shares)'),
  parseAbiItem('event Withdraw(address indexed sender, address indexed receiver, address indexed onBehalf, uint256 assets, uint256 shares)'),
  parseAbiItem('event Transfer(address indexed from, address indexed to, uint256 shares)'),
  parseAbiItem('event Allocate(address indexed sender, address indexed adapter, uint256 assets, bytes32[] ids, int256 change)'),
  parseAbiItem('event Deallocate(address indexed sender, address indexed adapter, uint256 assets, bytes32[] ids, int256 change)'),
  parseAbiItem('event ForceDeallocate(address indexed sender, address adapter, uint256 assets, address indexed onBehalf, bytes32[] ids, uint256 penaltyAssets)'),
];

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

function assetInfo(address, decimals = 6) {
  const fields = Array.from({ length: 17 }, () => word(0));
  fields[2] = word(decimals, 8);
  fields[12] = addressWord(address);
  return `0x${fields.join('')}`;
}

function reserveInfo({ underlying, hub, assetId = 0, decimals = 6 }) {
  return `0x${[
    addressWord(underlying),
    addressWord(hub),
    word(assetId, 16),
    word(decimals, 8),
    word(7500, 24),
    word(0, 8),
    word(1, 32),
  ].join('')}`;
}

function bytes32Text(value) {
  return `0x${Array.from(new TextEncoder().encode(value), (byte) => byte.toString(16).padStart(2, '0')).join('').padEnd(64, '0')}`;
}

function log(address, topics, data, logIndex, blockNumber = FIXTURE_END_BLOCK) {
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

function aaveLog(name, emitter, indexed, dataWords, logIndex) {
  const event = AAVE_ABI.find((candidate) => candidate.name === name);
  assert.ok(event, `Missing ABI event ${name}`);
  const topics = [toEventSelector(event), ...indexed];
  const data = dataWords.length === 0 ? '0x' : `0x${dataWords.join('')}`;
  return log(emitter, topics, data, logIndex);
}

function fixtureAaveLogs() {
  const { mainSpoke, forexSpoke } = AAVE_V4_DEPLOYMENTS;
  const supply = aaveLog('Supply', mainSpoke.address, [wordTopic(0), addressTopic(AAVE_CALLER), addressTopic(AAVE_USER)], [word(900), word(1000)], 1);
  const withdraw = aaveLog('Withdraw', mainSpoke.address, [wordTopic(0), addressTopic(AAVE_CALLER), addressTopic(AAVE_USER)], [word(400), word(450)], 2);
  const borrow = aaveLog('Borrow', forexSpoke.address, [wordTopic(0), addressTopic(AAVE_CALLER), addressTopic(AAVE_USER)], [word(200), word(225)], 3);
  const repay = aaveLog('Repay', mainSpoke.address, [wordTopic(0), addressTopic(AAVE_CALLER), addressTopic(AAVE_USER)], [word(150), word(175), word(-2), word(3), word(4)], 4);
  const liquidation = aaveLog('LiquidationCall', mainSpoke.address, [wordTopic(0), wordTopic(0), addressTopic(AAVE_USER)], [
    addressWord(AAVE_LIQUIDATOR), word(1, 8), word(10), word(11), word(-1), word(2), word(3), word(12), word(13), word(14),
  ], 5);
  const collateral = aaveLog('SetUsingAsCollateral', mainSpoke.address, [wordTopic(0), addressTopic(AAVE_CALLER), addressTopic(AAVE_USER)], [word(1, 8)], 6);
  const addReserve = aaveLog('AddReserve', forexSpoke.address, [wordTopic(0), wordTopic(0), addressTopic(AAVE_V4_DEPLOYMENTS.coreHub.address)], [], 7);
  const fakeSupply = aaveLog('Supply', FAKE_SPOKE, [wordTopic(0), addressTopic(AAVE_CALLER), addressTopic(AAVE_USER)], [word(1), word(1)], 8);
  return { logs: [supply, withdraw, borrow, repay, liquidation, collateral, addReserve, fakeSupply], malformedSupply: supply };
}

function wordTopic(value) {
  return `0x${BigInt(value).toString(16).padStart(64, '0')}`;
}

function makeAaveFixtureRpc({ malformedSupply = false } = {}) {
  const calls = [];
  const deployments = [AAVE_V4_DEPLOYMENTS.coreHub.address, AAVE_V4_DEPLOYMENTS.mainSpoke.address, AAVE_V4_DEPLOYMENTS.forexSpoke.address]
    .map((address) => address.toLowerCase());
  const assetAddress = AAVE_ASSET.toLowerCase();
  const rpc = {
    url: ARC_RPC_URL,
    async request(method, params = []) {
      calls.push({ method, params });
      if (method === 'eth_getCode') {
        assert.equal(params[1], FIXTURE_BLOCK_TAG, 'historical eth_getCode blockTag propagation');
        return deployments.includes(String(params[0]).toLowerCase()) || String(params[0]).toLowerCase() === assetAddress ? '0x60016000' : '0x';
      }
      if (method !== 'eth_call') throw new Error(`Unexpected Aave fixture RPC method ${method}`);
      assert.equal(params[1], FIXTURE_BLOCK_TAG, 'historical eth_call blockTag propagation');
      const to = String(params[0].to).toLowerCase();
      const data = String(params[0].data).toLowerCase();
      if (to === AAVE_V4_DEPLOYMENTS.coreHub.address.toLowerCase()) {
        if (data === '0xa0aead4d') return `0x${word(1)}`;
        if (data === `0xeac8f5b8${word(0)}`) return assetInfo(assetAddress, 6);
      }
      if ([AAVE_V4_DEPLOYMENTS.mainSpoke.address, AAVE_V4_DEPLOYMENTS.forexSpoke.address].map((address) => address.toLowerCase()).includes(to)) {
        if (data === '0x99806546') return `0x${word(1)}`;
        if (data === `0x77778db3${word(0)}`) return reserveInfo({ underlying: assetAddress, hub: AAVE_V4_DEPLOYMENTS.coreHub.address.toLowerCase() });
        if (data === `0x77778db3${word(1)}`) throw new Error('Reserve ID out of range');
      }
      if (to === assetAddress) {
        if (data === '0x06fdde03') return bytes32Text('USD Coin');
        if (data === '0x95d89b41') return bytes32Text('USDC');
        if (data === '0x313ce567') return `0x${word(6, 8)}`;
        if (data === '0x18160ddd') return `0x${word(1_000_000)}`;
      }
      throw new Error(`Unexpected Aave fixture call ${to} ${data}`);
    },
  };
  return { rpc, calls };
}

function morphoLog(name, emitter, indexed, data, logIndex) {
  const event = MORPHO_ABI.find((candidate) => candidate.name === name);
  assert.ok(event, `Missing Morpho ABI event ${name}`);
  return log(emitter, [toEventSelector(event), ...indexed], data, logIndex);
}

function fixtureMorphoLogs() {
  const vault = MORPHO_ARC_CANDIDATE_VAULTS[0].address.toLowerCase();
  const rejectedVault = MORPHO_ARC_CANDIDATE_VAULTS[1].address.toLowerCase();
  const unresolvedVault = MORPHO_ARC_CANDIDATE_VAULTS[2].address.toLowerCase();
  const depositData = encodeAbiParameters([{ type: 'uint256' }, { type: 'uint256' }], [500n, 450n]);
  const withdrawData = encodeAbiParameters([{ type: 'uint256' }, { type: 'uint256' }], [200n, 175n]);
  const transferData = encodeAbiParameters([{ type: 'uint256' }], [75n]);
  const allocationData = `0x${word(700)}${word(96)}${word(-10)}${word(1)}${ALLOCATION_ID.slice(2)}`;
  return [
    morphoLog('Deposit', vault, [addressTopic(MORPHO_OWNER), addressTopic(AAVE_USER)], depositData, 20),
    morphoLog('Withdraw', vault, [addressTopic(MORPHO_OWNER), addressTopic(AAVE_USER), addressTopic(AAVE_USER)], withdrawData, 21),
    morphoLog('Transfer', vault, [addressTopic(MORPHO_OWNER), addressTopic(AAVE_USER)], transferData, 22),
    morphoLog('Allocate', vault, [addressTopic(MORPHO_OWNER), addressTopic(MORPHO_ADAPTER_REGISTRY)], allocationData, 23),
    morphoLog('Deposit', rejectedVault, [addressTopic(MORPHO_OWNER), addressTopic(AAVE_USER)], depositData, 25),
    morphoLog('Deposit', unresolvedVault, [addressTopic(MORPHO_OWNER), addressTopic(AAVE_USER)], depositData, 24),
  ];
}

function makeMorphoFixtureRpc({ allOtherCandidatesRejected = false, failFirstVaultCodeRead = false, firstVaultFactoryFlag = 1 } = {}) {
  const calls = [];
  const firstVault = MORPHO_ARC_CANDIDATE_VAULTS[0].address.toLowerCase();
  const noCodeCandidate = MORPHO_ARC_CANDIDATE_VAULTS[1].address.toLowerCase();
  const factory = MORPHO_V2_ARC_FACTORY.address.toLowerCase();
  const underlying = MORPHO_UNDERLYING.toLowerCase();
  const knownContracts = new Set([factory, firstVault, underlying]);
  if (!allOtherCandidatesRejected) {
    for (const candidate of MORPHO_ARC_CANDIDATE_VAULTS) {
      const address = candidate.address.toLowerCase();
      if (address !== noCodeCandidate) knownContracts.add(address);
    }
  }
  const rpc = {
    url: ARC_RPC_URL,
    async request(method, params = []) {
      calls.push({ method, params });
      if (method === 'eth_getCode') {
        assert.equal(params[1], FIXTURE_BLOCK_TAG, 'historical Morpho eth_getCode blockTag propagation');
        const address = String(params[0]).toLowerCase();
        if (failFirstVaultCodeRead && address === firstVault) throw new Error('transient code read failure');
        return knownContracts.has(address) ? '0x60016000' : '0x';
      }
      if (method !== 'eth_call') throw new Error(`Unexpected Morpho fixture RPC method ${method}`);
      assert.equal(params[1], FIXTURE_BLOCK_TAG, 'historical Morpho eth_call blockTag propagation');
      const to = String(params[0].to).toLowerCase();
      const data = String(params[0].data).toLowerCase();
      if (to === factory && data.startsWith('0x5edec50d')) {
        const target = `0x${data.slice(-40)}`;
        return `0x${word(target === firstVault ? firstVaultFactoryFlag : 0)}`;
      }
      if (to === firstVault) {
        if (data === '0x38d52e0f') return `0x${addressWord(underlying)}`;
        if (data === '0x313ce567') return `0x${word(18, 8)}`;
        if (data === '0x8da5cb5b') return `0x${addressWord(MORPHO_OWNER)}`;
        if (data === '0xe66f53b7') return `0x${addressWord(MORPHO_CURATOR)}`;
        if (data === '0x50b5c16a') return `0x${addressWord(MORPHO_ADAPTER_REGISTRY)}`;
        if (data === '0x5aa22bc8') return `0x${word(1)}`;
      }
      if (to === firstVault || to === underlying) {
        if (data === '0x06fdde03') return bytes32Text(to === firstVault ? 'Galaxy USDC' : 'USD Coin');
        if (data === '0x95d89b41') return bytes32Text(to === firstVault ? 'arcUSDC' : 'USDC');
        if (data === '0x313ce567') return `0x${word(to === firstVault ? 18 : 6, 8)}`;
        if (data === '0x18160ddd') return `0x${word(10_000_000)}`;
      }
      throw new Error(`Unexpected Morpho fixture call ${to} ${data}`);
    },
  };
  return { rpc, calls };
}

function phase1aFixture(logs) {
  return {
    chainId: ARC_CHAIN_ID,
    startBlock: FIXTURE_END_BLOCK - 1,
    endBlock: FIXTURE_END_BLOCK,
    lastIndexedBlock: FIXTURE_END_BLOCK,
    source: ARC_RPC_URL,
    complete: true,
    logs,
  };
}

function assertAaveAbiTopics() {
  const sourceEventSignatures = [
    'Supply(uint256,address,address,uint256,uint256)',
    'Withdraw(uint256,address,address,uint256,uint256)',
    'Borrow(uint256,address,address,uint256,uint256)',
    'Repay(uint256,address,address,uint256,uint256,(int256,int256,uint256))',
    'LiquidationCall(uint256,uint256,address,address,bool,uint256,uint256,(int256,int256,uint256),uint256,uint256,uint256)',
    'SetUsingAsCollateral(uint256,address,address,bool)',
    'AddReserve(uint256,uint256,address)',
  ];
  assert.deepEqual(sourceEventSignatures.map((signature) => toEventSelector(signature)), Object.values(AAVE_V4_EVENT_TOPICS));
}

function assertMorphoAbiTopics() {
  const sourceEventSignatures = [
    'Deposit(address,address,uint256,uint256)',
    'Withdraw(address,address,address,uint256,uint256)',
    'Transfer(address,address,uint256)',
    'Allocate(address,address,uint256,bytes32[],int256)',
    'Deallocate(address,address,uint256,bytes32[],int256)',
    'ForceDeallocate(address,address,uint256,address,bytes32[],uint256)',
  ];
  assert.deepEqual(sourceEventSignatures.map((signature) => toEventSelector(signature)), Object.values(MORPHO_V2_EVENT_TOPICS));
}

async function verifyDeterministicFixtures() {
  assertAaveAbiTopics();
  assertMorphoAbiTopics();

  const aaveFixtures = fixtureAaveLogs();
  const supplyAbi = AAVE_ABI.find((event) => event.name === 'Supply');
  const decodedByViem = decodeEventLog({ abi: [supplyAbi], topics: aaveFixtures.logs[0].topics, data: aaveFixtures.logs[0].data });
  assert.equal(decodedByViem.eventName, 'Supply');
  assert.equal(decodedByViem.args.suppliedAmount, 1000n);

  const decodedSupply = decodeAaveV4Event(aaveFixtures.logs[0]);
  assert.equal(decodedSupply.type, 'supply');
  assert.equal(decodedSupply.caller, AAVE_CALLER.toLowerCase());
  assert.equal(decodedSupply.positionOwner, AAVE_USER.toLowerCase());
  assert.equal(decodedSupply.suppliedSharesRaw, '900');
  assert.equal(decodedSupply.suppliedAmountRaw, '1000');
  const decodedWithdraw = decodeAaveV4Event(aaveFixtures.logs[1]);
  assert.equal(decodedWithdraw.type, 'withdraw');
  assert.equal(decodedWithdraw.withdrawnSharesRaw, '400');
  assert.equal(decodedWithdraw.withdrawnAmountRaw, '450');
  const decodedBorrow = decodeAaveV4Event(aaveFixtures.logs[2]);
  assert.equal(decodedBorrow.type, 'borrow');
  assert.equal(decodedBorrow.caller, AAVE_CALLER.toLowerCase());
  assert.equal(decodedBorrow.positionOwner, AAVE_USER.toLowerCase());
  const decodedRepay = decodeAaveV4Event(aaveFixtures.logs[3]);
  assert.equal(decodedRepay.type, 'repay');
  assert.equal(decodedRepay.drawnSharesRaw, '150');
  assert.equal(decodedRepay.totalAmountRepaidRaw, '175');
  assert.equal(decodedRepay.premiumDelta.sharesDeltaRaw, '-2');
  const decodedLiquidation = decodeAaveV4Event(aaveFixtures.logs[4]);
  assert.equal(decodedLiquidation.type, 'liquidation');
  assert.equal(decodedLiquidation.positionOwner, AAVE_USER.toLowerCase());
  assert.equal(decodedLiquidation.liquidator, AAVE_LIQUIDATOR.toLowerCase());
  assert.equal(decodedLiquidation.receiveShares, true);
  assert.equal(decodedLiquidation.collateralAmountRemovedRaw, '12');
  assert.equal(decodeAaveV4Event(aaveFixtures.logs[5]).usingAsCollateral, true);
  assert.equal(decodeAaveV4Event(aaveFixtures.logs[6]).hub, AAVE_V4_DEPLOYMENTS.coreHub.address.toLowerCase());

  const aaveRpc = makeAaveFixtureRpc();
  const aave = await buildAaveV4Snapshot({ phase1aSnapshot: phase1aFixture(aaveFixtures.logs), rpc: aaveRpc.rpc });
  assert.equal(aave.deployments[0].codePresent, true);
  assert.equal(aave.completeness.complete, true);
  assert.equal(aave.eventCounts.supply, 1, 'non Aave emitter must be filtered');
  assert.equal(aave.eventCounts.withdraw, 1);
  assert.equal(aave.eventCounts.borrow, 1);
  assert.equal(aave.eventCounts.repay, 1);
  assert.equal(aave.eventCounts.liquidation, 1);
  assert.equal(aave.eventCounts.setUsingAsCollateral, 1);
  assert.equal(aave.eventCounts.addReserve, 1);
  assert.ok(aave.rawFlows.filter((flow) => flow.type !== 'liquidation').every((flow) => flow.caller === AAVE_CALLER.toLowerCase() && flow.positionOwner === AAVE_USER.toLowerCase()), 'caller and position owner remain distinct');
  for (const metric of Object.values(aave.accountingMetrics)) assert.equal(metric.status, 'unavailable');
  assert.ok(aaveRpc.calls.some((entry) => entry.method === 'eth_getCode' && entry.params[0].toLowerCase() === AAVE_V4_DEPLOYMENTS.coreHub.address.toLowerCase() && entry.params[1] === FIXTURE_BLOCK_TAG));
  assert.ok(aaveRpc.calls.filter((entry) => entry.method === 'eth_call').every((entry) => entry.params[1] === FIXTURE_BLOCK_TAG));

  const malformedLogs = [...aaveFixtures.logs];
  malformedLogs[0] = { ...malformedLogs[0], data: `0x${word(1)}` };
  const malformedAave = await buildAaveV4Snapshot({ phase1aSnapshot: phase1aFixture(malformedLogs), rpc: makeAaveFixtureRpc().rpc });
  assert.equal(malformedAave.malformedEventCount, 1);
  assert.equal(malformedAave.completeness.complete, false);
  assert.ok(malformedAave.warnings.some((warning) => /failed strict ABI validation/.test(warning)));

  const morphoLogs = fixtureMorphoLogs();
  const depositAbi = MORPHO_ABI.find((event) => event.name === 'Deposit');
  const morphoViem = decodeEventLog({ abi: [depositAbi], topics: morphoLogs[0].topics, data: morphoLogs[0].data });
  assert.equal(morphoViem.args.assets, 500n);
  assert.equal(morphoViem.args.shares, 450n);
  const deposit = decodeMorphoVaultV2Flow(morphoLogs[0]);
  assert.equal(deposit.type, 'deposit');
  assert.equal(deposit.assetsRaw, '500');
  assert.equal(deposit.sharesRaw, '450');
  assert.equal(deposit.sender, MORPHO_OWNER.toLowerCase());
  assert.equal(deposit.owner, AAVE_USER.toLowerCase());
  const withdrawal = decodeMorphoVaultV2Flow(morphoLogs[1]);
  assert.equal(withdrawal.type, 'withdraw');
  assert.equal(withdrawal.assetsRaw, '200');
  assert.equal(withdrawal.sharesRaw, '175');
  assert.equal(withdrawal.sender, MORPHO_OWNER.toLowerCase());
  assert.equal(withdrawal.receiver, AAVE_USER.toLowerCase());
  assert.equal(withdrawal.owner, AAVE_USER.toLowerCase());
  assert.equal(decodeMorphoVaultV2Flow(morphoLogs[2]), undefined, 'ERC20 share Transfer is not a deposit or withdrawal');
  const allocation = decodeMorphoVaultV2Allocation(morphoLogs[3]);
  assert.equal(allocation.type, 'allocate');
  assert.equal(allocation.assetsRaw, '700');
  assert.equal(allocation.changeRaw, '-10');
  assert.deepEqual(allocation.ids, [ALLOCATION_ID]);

  const morphoRpc = makeMorphoFixtureRpc();
  const morpho = await buildMorphoV2Snapshot({ phase1aSnapshot: phase1aFixture(morphoLogs), rpc: morphoRpc.rpc });
  assert.equal(morpho.candidateVaultCount, 10);
  assert.equal(morpho.verifiedVaultCount, 1);
  assert.equal(morpho.flows.scope, 'verified_vault_subset');
  assert.equal(morpho.flows.verifiedVaultCount, 1);
  assert.equal(morpho.candidates[0].status, 'verified');
  assert.equal(morpho.candidates[0].version, 'v2');
  assert.equal(morpho.candidates[0].underlying.symbol, 'USDC');
  assert.equal(morpho.candidates[1].status, 'rejected');
  assert.equal(morpho.candidates[1].rejectionEvidence.authoritative, true);
  assert.equal(morpho.candidates[2].status, 'unverified');
  assert.equal(morpho.flows.depositEventCount, 1);
  assert.equal(morpho.flows.withdrawEventCount, 1);
  assert.equal(morpho.ignoredShareTransferCount, 1);
  assert.equal(morpho.allocationEvents.length, 1);
  assert.equal(morpho.rawFlows[0].assetsRaw, '500');
  assert.equal(morpho.rawFlows[0].sharesRaw, '450');
  assert.equal(morpho.rawFlows[0].underlyingAsset, MORPHO_UNDERLYING.toLowerCase());
  assert.equal(morpho.completeness.verifiedVaultEventScanComplete, true);
  assert.equal(morpho.completeness.candidateCoverageComplete, false);
  assert.equal(morpho.verifiedVaultCount + morpho.rejectedOrUnverifiedVaults.filter((candidate) => candidate.status === 'rejected').length + morpho.completeness.unresolvedCandidateCount, morpho.candidateVaultCount);
  assert.equal(morpho.completeness.complete, false);
  assert.ok(morpho.rawFlows.every((flow) => morpho.candidates.some((candidate) => candidate.address === flow.emitter && candidate.status === 'verified')), 'only verified vault emitters may flow');
  assert.equal(morpho.flows.depositEventCount, 1, 'rejected and unresolved candidate emitter logs are ignored');
  for (const metric of Object.values(morpho.accountingMetrics)) assert.equal(metric.status, 'unavailable');
  assert.ok(morphoRpc.calls.filter((entry) => entry.method === 'eth_getCode' || entry.method === 'eth_call').every((entry) => entry.params[1] === FIXTURE_BLOCK_TAG));

  const transientMorpho = await buildMorphoV2Snapshot({
    phase1aSnapshot: phase1aFixture(morphoLogs),
    rpc: makeMorphoFixtureRpc({ failFirstVaultCodeRead: true }).rpc,
  });
  assert.notEqual(transientMorpho.verifiedVaultCount, morpho.verifiedVaultCount, 'transient verification failures may change verified counts');
  assert.equal(transientMorpho.completeness.candidateCoverageComplete, false);
  assert.equal(transientMorpho.completeness.complete, false);
  assert.equal(transientMorpho.completeness.verifiedVaultEventScanComplete, true, 'verified subset scan can complete despite unresolved coverage');
  assert.ok(transientMorpho.rawFlows.every((flow) => transientMorpho.candidates.some((candidate) => candidate.address === flow.emitter && candidate.status === 'verified')));

  const malformedFactoryMorpho = await buildMorphoV2Snapshot({
    phase1aSnapshot: phase1aFixture(morphoLogs),
    rpc: makeMorphoFixtureRpc({ firstVaultFactoryFlag: 2 }).rpc,
  });
  assert.equal(malformedFactoryMorpho.candidates[0].status, 'unverified');
  assert.equal(malformedFactoryMorpho.candidates[0].verificationReason, 'factory_read_unavailable');
  const falseFactoryMorpho = await buildMorphoV2Snapshot({
    phase1aSnapshot: phase1aFixture(morphoLogs),
    rpc: makeMorphoFixtureRpc({ firstVaultFactoryFlag: 0 }).rpc,
  });
  assert.equal(falseFactoryMorpho.candidates[0].status, 'unverified');
  assert.equal(falseFactoryMorpho.candidates[0].verificationReason, 'version_not_established');

  const malformedMorphoLogs = [...morphoLogs];
  malformedMorphoLogs[0] = { ...malformedMorphoLogs[0], data: `0x${word(500)}` };
  const malformedMorpho = await buildMorphoV2Snapshot({ phase1aSnapshot: phase1aFixture(malformedMorphoLogs), rpc: makeMorphoFixtureRpc().rpc });
  assert.equal(malformedMorpho.malformedEventCount, 1);
  assert.equal(malformedMorpho.completeness.verifiedVaultEventScanComplete, false, 'malformed recognized event invalidates verified-vault scan');
  assert.equal(malformedMorpho.completeness.complete, false);

  const fullyCoveredMorpho = await buildMorphoV2Snapshot({
    phase1aSnapshot: phase1aFixture(morphoLogs),
    rpc: makeMorphoFixtureRpc({ allOtherCandidatesRejected: true }).rpc,
  });
  assert.equal(fullyCoveredMorpho.verifiedVaultCount, 1);
  assert.equal(fullyCoveredMorpho.completeness.verifiedVaultEventScanComplete, true);
  assert.equal(fullyCoveredMorpho.completeness.candidateCoverageComplete, true);
  assert.equal(fullyCoveredMorpho.completeness.unresolvedCandidateCount, 0);
  assert.equal(fullyCoveredMorpho.completeness.complete, true);

  console.log('DETERMINISTIC FIXTURES: PASS');
  console.log(JSON.stringify({
    aave: {
      officialEventTopics: Object.keys(AAVE_V4_EVENT_TOPICS).length,
      decodedEventTypes: Object.keys(aave.eventCounts),
      fakeEmitterFiltered: aave.eventCounts.supply === 1,
      malformedLogMakesIncomplete: malformedAave.completeness.complete === false,
      blockTag: FIXTURE_BLOCK_TAG,
      unavailableAccountingMetrics: Object.keys(aave.accountingMetrics),
    },
    morpho: {
      candidateCount: morpho.candidateVaultCount,
      verifiedCount: morpho.verifiedVaultCount,
      depositAssetsRaw: morpho.rawFlows[0].assetsRaw,
      depositSharesRaw: morpho.rawFlows[0].sharesRaw,
      withdrawalAssetsRaw: morpho.rawFlows[1].assetsRaw,
      withdrawalSharesRaw: morpho.rawFlows[1].sharesRaw,
      transferEventsIgnored: morpho.ignoredShareTransferCount,
      allocationEventsSeparate: morpho.allocationEvents.length,
      verifiedVaultEventScanComplete: morpho.completeness.verifiedVaultEventScanComplete,
      candidateCoverageComplete: morpho.completeness.candidateCoverageComplete,
      unresolvedCandidateCount: morpho.completeness.unresolvedCandidateCount,
      complete: morpho.completeness.complete,
      fullCoverageFixture: {
        verifiedVaultEventScanComplete: fullyCoveredMorpho.completeness.verifiedVaultEventScanComplete,
        candidateCoverageComplete: fullyCoveredMorpho.completeness.candidateCoverageComplete,
        unresolvedCandidateCount: fullyCoveredMorpho.completeness.unresolvedCandidateCount,
        complete: fullyCoveredMorpho.completeness.complete,
      },
      blockTag: FIXTURE_BLOCK_TAG,
      unavailableAccountingMetrics: Object.keys(morpho.accountingMetrics),
    },
  }, null, 2));
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
        method: init.method ?? 'GET',
        headers: init.headers,
        agent,
        signal: init.signal,
      }, (response) => {
        const chunks = [];
        response.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
        response.on('error', reject);
        response.on('end', () => {
          const status = response.statusCode ?? 0;
          const payload = Buffer.concat(chunks).toString('utf8');
          resolve({
            status,
            ok: status >= 200 && status < 300,
            async json() { return JSON.parse(payload); },
          });
        });
      });
      request.on('error', reject);
      if (init.body) request.write(init.body);
      request.end();
    });
  };
  const rpc = createArcRpcClient({ url: ARC_RPC_URL, fetchImpl: fetchArcOnly, maxAttempts: 3 });
  if (rpc.url !== 'https://rpc.mainnet.arc.io') throw new Error('Live verifier RPC URL must be exactly https://rpc.mainnet.arc.io');
  return rpc;
}

async function verifyLiveArc() {
  const rpc = liveRpc();
  const snapshot = await buildLatestSnapshot({ rpc, windowSize: 25 });
  assert.equal(snapshot.source, ARC_RPC_URL);
  assert.equal(snapshot.chainId, ARC_CHAIN_ID);
  assert.equal(snapshot.blockCount, 25);
  assert.equal(snapshot.receiptCount, snapshot.totalTransactions, 'Phase 1A transaction and receipt counts must agree');
  assert.equal(snapshot.complete, true, `Phase 1A bounded Arc snapshot incomplete: ${snapshot.warnings.join(' | ')}`);
  assert.equal(snapshot.lastIndexedBlock, snapshot.endBlock);

  const aave = await buildAaveV4Snapshot({ phase1aSnapshot: snapshot, rpc });
  assert.equal(aave.blockRange.endBlock, snapshot.endBlock);
  assert.equal(aave.blockRange.blockTag, `0x${snapshot.endBlock.toString(16)}`);
  const morphoRuns = [];
  for (let run = 0; run < 3; run += 1) {
    morphoRuns.push(await buildMorphoV2Snapshot({ phase1aSnapshot: snapshot, rpc }));
  }
  const expectedBlockTag = `0x${snapshot.endBlock.toString(16)}`;
  const classifications = morphoRuns.map((morpho) => JSON.stringify({
    factoryCodeVerified: morpho.factory.codePresent,
    candidates: morpho.candidates.map(({ address, status }) => [address, status]),
  }));
  const rpcReadStability = classifications.every((classification) => classification === classifications[0]) ? 'STABLE' : 'DEGRADED';
  const morphoReports = morphoRuns.map((morpho, index) => ({
    run: index + 1,
    startBlock: morpho.blockRange.startBlock,
    endBlock: morpho.blockRange.endBlock,
    blockTag: morpho.blockRange.blockTag,
    verifiedVaultCount: morpho.verifiedVaultCount,
    unresolvedCandidateCount: morpho.completeness.unresolvedCandidateCount,
    rejectedCandidateCount: morpho.candidates.filter((candidate) => candidate.status === 'rejected').length,
    candidateCoverageComplete: morpho.completeness.candidateCoverageComplete,
    verifiedVaultEventScanComplete: morpho.completeness.verifiedVaultEventScanComplete,
    complete: morpho.completeness.complete,
    factoryCodeVerified: morpho.factory.codePresent,
    candidates: morpho.candidates.map(({ address, candidateLabel, status, factoryEvidence, verificationReason }) => ({
      address, candidateLabel, status, factoryEvidence, verificationReason: verificationReason ?? null,
    })),
  }));

  console.log('LIVE ARC SNAPSHOT: COLLECTED');
  console.log(`RPC_READ_STABILITY: ${rpcReadStability}`);
  console.log('MORPHO SAME-BLOCK READS:');
  console.log(JSON.stringify(morphoReports, null, 2));
  assert.ok(morphoRuns.some((morpho) => morpho.factory.codePresent), 'At least one probe must verify official factory bytecode');
  assert.ok(morphoRuns.some((morpho) => morpho.verifiedVaultCount > 0), 'At least one probe must verify a live VaultV2');
  for (const [index, morpho] of morphoRuns.entries()) {
    const runLabel = `Morpho run ${index + 1}`;
    assert.equal(morpho.blockRange.startBlock, snapshot.startBlock, `${runLabel} startBlock`);
    assert.equal(morpho.blockRange.endBlock, snapshot.endBlock, `${runLabel} endBlock`);
    assert.equal(morpho.blockRange.blockTag, expectedBlockTag, `${runLabel} blockTag`);
    assert.equal(morpho.candidateVaultCount, 10, `${runLabel} candidate count`);
    const rejectedCount = morpho.candidates.filter((candidate) => candidate.status === 'rejected').length;
    assert.equal(morpho.verifiedVaultCount + rejectedCount + morpho.completeness.unresolvedCandidateCount, 10, `${runLabel} candidate statuses must partition the universe`);
    assert.equal(morpho.completeness.verifiedVaultEventScanComplete, morpho.malformedEventCount === 0, `${runLabel} verified-vault event scan`);
    assert.ok(morpho.candidates.filter((candidate) => candidate.status === 'rejected').every((candidate) => candidate.rejectionEvidence?.authoritative === true && !candidate.verificationReason?.endsWith('_unavailable')), `${runLabel} transient read failures must not reject candidates`);
    if (!morpho.factory.codePresent) assert.equal(rejectedCount, 0, `${runLabel} unavailable factory read must not reject candidates`);
    assert.equal(morpho.flows.scope, 'verified_vault_subset', `${runLabel} flow scope`);
    assert.equal(morpho.flows.verifiedVaultCount, morpho.verifiedVaultCount, `${runLabel} verified flow count`);
    assert.equal(morpho.flows.candidateVaultCount, 10, `${runLabel} flow candidate count`);
    assert.equal(morpho.flows.unresolvedCandidateCount, morpho.completeness.unresolvedCandidateCount, `${runLabel} unresolved flow count`);
    assert.ok(morpho.rawFlows.every((flow) => morpho.candidates.some((candidate) => candidate.address === flow.emitter && candidate.status === 'verified')), `${runLabel} only verified vault emitters may produce flows`);
    assert.ok(morpho.allocationEvents.every((event) => morpho.candidates.some((candidate) => candidate.address === event.emitter && candidate.status === 'verified')), `${runLabel} only verified vault emitters may produce allocations`);
    if (morpho.completeness.unresolvedCandidateCount > 0) {
      assert.equal(morpho.completeness.candidateCoverageComplete, false, `${runLabel} unresolved coverage`);
      assert.equal(morpho.completeness.complete, false, `${runLabel} unresolved completeness`);
    }
    if (morpho.completeness.complete) {
      assert.equal(morpho.completeness.unresolvedCandidateCount, 0, `${runLabel} complete unresolved count`);
      assert.equal(morpho.completeness.candidateCoverageComplete, true, `${runLabel} complete candidate coverage`);
    }
  }
  const morphoDataCompleteness = morphoRuns.every((morpho) => morpho.completeness.complete) ? 'COMPLETE' : 'INCOMPLETE';
  console.log('VERIFIER_CORRECTNESS: PASS');
  console.log(`MORPHO_DATA_COMPLETENESS: ${morphoDataCompleteness}`);
  const morpho = morphoRuns[0];
  console.log(JSON.stringify({
    source: snapshot.source,
    chainId: snapshot.chainId,
    latestBlock: snapshot.endBlock,
    startBlock: snapshot.startBlock,
    endBlock: snapshot.endBlock,
    blockCount: snapshot.blockCount,
    totalTransactions: snapshot.totalTransactions,
    receiptCount: snapshot.receiptCount,
    complete: snapshot.complete,
    warnings: snapshot.warnings,
    aave: {
      deployments: aave.deployments.map(({ role, address, codePresent, status, assetCount, reserveCount, warnings }) => ({ role, address, codePresent, status, assetCount: assetCount ?? null, reserveCount: reserveCount ?? null, warnings })),
      observedMarkets: aave.observedMarkets,
      eventCounts: aave.eventCounts,
      malformedEventCount: aave.malformedEventCount,
      rawFlows: aave.rawFlows,
      collateralStateChanges: aave.collateralStateChanges,
      accountingMetrics: aave.accountingMetrics,
      completeness: aave.completeness,
      warnings: aave.warnings,
    },
    morpho: {
      factory: morpho.factory,
      candidateVaultCount: morpho.candidateVaultCount,
      verifiedVaultCount: morpho.verifiedVaultCount,
      flowSummary: {
        scope: morpho.flows.scope,
        verifiedVaultCount: morpho.flows.verifiedVaultCount,
        candidateVaultCount: morpho.flows.candidateVaultCount,
        unresolvedCandidateCount: morpho.flows.unresolvedCandidateCount,
        depositEventCount: morpho.flows.depositEventCount,
        withdrawEventCount: morpho.flows.withdrawEventCount,
        allocationEventCount: morpho.flows.allocationEventCount,
      },
      candidates: morpho.candidates,
      rejectedOrUnverifiedVaults: morpho.rejectedOrUnverifiedVaults,
      rawFlows: morpho.rawFlows,
      allocationEvents: morpho.allocationEvents,
      ignoredShareTransferCount: morpho.ignoredShareTransferCount,
      accountingMetrics: morpho.accountingMetrics,
      apiReconciliation: morpho.apiReconciliation,
      completeness: morpho.completeness,
      warnings: morpho.warnings,
    },
  }, null, 2));

  return { snapshot, aave, morpho };
}

const mode = process.argv[2] ?? 'all';
assert.ok(['all', '--fixtures-only', '--live-only'].includes(mode), 'Use --fixtures-only or --live-only');
if (mode !== '--live-only') await verifyDeterministicFixtures();
if (mode !== '--fixtures-only') await verifyLiveArc();
