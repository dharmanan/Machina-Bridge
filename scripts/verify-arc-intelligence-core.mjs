import assert from 'node:assert/strict';
import { ARC_VERIFIED_ASSETS, validateVerifiedAssetRegistry } from '../api/_lib/arc-intelligence/assets.js';
import { buildBoundedSnapshot, buildLatestSnapshot, MAX_WINDOW_SIZE } from '../api/_lib/arc-intelligence/core.js';
import { normalizeBlock, normalizeReceipt, normalizeTransaction, quantityToSafeNumber } from '../api/_lib/arc-intelligence/normalize.js';
import { ARC_CHAIN_ID } from '../api/_lib/arc-intelligence/rpc.js';
import {
  discoverTransferEmitters,
  inspectMajorAssets,
  summarizeVerifiedAssetTransfers,
  verifyErc20Metadata,
} from '../api/_lib/arc-intelligence/tokens.js';
import {
  summarizeUsdcTransfers,
  TRANSFER_TOPIC,
  USDC_ERC20_ADDRESS,
  USDC_SYSTEM_EMITTER,
} from '../api/_lib/arc-intelligence/usdc.js';

function indexedAddressTopic(address) {
  return `0x${address.slice(2).toLowerCase().padStart(64, '0')}`;
}

function word(value) {
  return BigInt(value).toString(16).padStart(64, '0');
}

function bytes32(value) {
  const encoded = Array.from(new TextEncoder().encode(value), (byte) => byte.toString(16).padStart(2, '0')).join('');
  assert.ok(encoded.length <= 64);
  return `0x${encoded.padEnd(64, '0')}`;
}

async function verifyDeterministicFixtures() {
  assert.equal(validateVerifiedAssetRegistry(), true);
  assert.equal(ARC_VERIFIED_ASSETS.length, 5);
  assert.ok(ARC_VERIFIED_ASSETS.every((asset) => asset.chainId === ARC_CHAIN_ID));
  assert.ok(ARC_VERIFIED_ASSETS.every((asset) => /^0x[0-9a-f]{40}$/i.test(asset.address)));

  const largeRaw = '900719925474099312345678901234567890';
  const normalizedTransaction = normalizeTransaction({
    hash: `0x${'ab'.repeat(32)}`,
    from: '0x1111111111111111111111111111111111111111',
    to: '0x2222222222222222222222222222222222222222',
    value: `0x${BigInt(largeRaw).toString(16)}`,
    input: '0x1234567890',
  }, { blockNumber: 12, transactionIndex: 3 });
  assert.equal(normalizedTransaction.valueRaw, largeRaw);
  assert.equal(typeof normalizedTransaction.valueRaw, 'string');
  assert.equal(normalizedTransaction.inputSelector, '0x12345678');
  assert.throws(() => quantityToSafeNumber(`0x${BigInt(largeRaw).toString(16)}`), /safe integer range/);

  const transactionFixture = (byte, transactionIndex) => ({
    hash: `0x${byte.repeat(64)}`,
    blockNumber: '0xc',
    transactionIndex: `0x${transactionIndex.toString(16)}`,
    from: '0x1111111111111111111111111111111111111111',
    to: '0x2222222222222222222222222222222222222222',
    value: '0x0',
    input: '0x',
  });
  const normalizedBlock = normalizeBlock({
    number: '0xc',
    hash: `0x${'12'.repeat(32)}`,
    parentHash: `0x${'11'.repeat(32)}`,
    timestamp: '0x64',
    transactions: [transactionFixture('b', 1), transactionFixture('a', 0)],
  }, ARC_CHAIN_ID);
  assert.deepEqual(normalizedBlock.transactions.map((transaction) => transaction.transactionIndex), [0, 1]);

  const normalizedReceipt = normalizeReceipt({
    transactionHash: `0x${'ab'.repeat(32)}`,
    blockNumber: '0xc',
    transactionIndex: '0x0',
    status: '0x1',
    gasUsed: '0x5208',
    logs: [2, 1].map((index) => ({
      address: '0x3333333333333333333333333333333333333333',
      topics: [TRANSFER_TOPIC],
      data: '0x',
      blockNumber: '0xc',
      transactionIndex: '0x0',
      logIndex: `0x${index.toString(16)}`,
    })),
  });
  assert.deepEqual(normalizedReceipt.logs.map((log) => log.logIndex), [1, 2]);
  assert.throws(() => normalizeReceipt({
    transactionHash: `0x${'ab'.repeat(32)}`,
    blockNumber: '0xc',
    transactionIndex: '0x0',
    status: '0x1',
    gasUsed: '0x5208',
    logs: [{
      address: '0x3333333333333333333333333333333333333333',
      topics: [TRANSFER_TOPIC],
      data: '0x',
    }],
  }), /Log is missing block position/);

  const sharedFrom = '0x1111111111111111111111111111111111111111';
  const sharedTo = '0x2222222222222222222222222222222222222222';
  const duplicateUsdcMovement = [
    {
      address: USDC_SYSTEM_EMITTER,
      topics: [TRANSFER_TOPIC, indexedAddressTopic(sharedFrom), indexedAddressTopic(sharedTo)],
      data: `0x${word(1_000_000_000_000_000_000n)}`,
    },
    {
      address: USDC_ERC20_ADDRESS,
      topics: [TRANSFER_TOPIC, indexedAddressTopic(sharedFrom), indexedAddressTopic(sharedTo)],
      data: `0x${word(1_000_000)}`,
    },
  ];
  const canonicalUsdc = summarizeUsdcTransfers(duplicateUsdcMovement);
  const assetTotals = summarizeVerifiedAssetTransfers(duplicateUsdcMovement);
  const usdcTotal = assetTotals.find((asset) => asset.symbol === 'USDC');
  assert.equal(canonicalUsdc.transferCount, 1);
  assert.equal(canonicalUsdc.amountRaw, '1000000000000000000');
  assert.equal(canonicalUsdc.erc20InterfaceActivity.transferCount, 1);
  assert.equal(canonicalUsdc.erc20InterfaceActivity.amountRaw, '1000000');
  assert.equal(canonicalUsdc.erc20InterfaceActivity.includedInCanonicalAmount, false);
  assert.equal(usdcTotal.amountRaw, '1000000000000000000');
  const malformedCanonicalUsdc = summarizeUsdcTransfers([{
    address: USDC_SYSTEM_EMITTER,
    topics: [TRANSFER_TOPIC],
    data: `0x${word(1_000_000)}`,
  }]);
  assert.equal(malformedCanonicalUsdc.complete, false);
  assert.equal(malformedCanonicalUsdc.amountRaw, null);

  const defaultMetadataCalls = [];
  const malformedMetadataRpc = {
    async request(method, params) {
      defaultMetadataCalls.push({ method, params });
      if (method === 'eth_getCode') return '0x6000';
      if (method === 'eth_call') {
        const selector = params[0]?.data;
        if (selector === '0x313ce567') return `0x${word(6)}`;
        if (selector === '0x18160ddd') return `0x${word(BigInt(largeRaw))}`;
        return '0x';
      }
      throw new Error('Unexpected fixture RPC method');
    },
  };
  const unverifiedMetadata = await verifyErc20Metadata(
    malformedMetadataRpc,
    '0x3333333333333333333333333333333333333333',
  );
  assert.equal(unverifiedMetadata.status, 'unknown/unverified');
  assert.equal(unverifiedMetadata.symbol, null);
  assert.equal(unverifiedMetadata.decimals, null);
  assert.equal(unverifiedMetadata.totalSupplyRaw, null);
  assert.ok(defaultMetadataCalls.every(({ method, params }) => params[1] === 'latest'));

  const historicalBlockTag = '0xabc123';
  const historicalMetadataCalls = [];
  const historicalMetadataRpc = {
    async request(method, params) {
      historicalMetadataCalls.push({ method, params });
      if (method === 'eth_getCode') return '0x6000';
      if (method !== 'eth_call') throw new Error(`Unexpected historical metadata RPC method: ${method}`);
      const selector = params[0]?.data;
      if (selector === '0x06fdde03') return bytes32('Fixture Token');
      if (selector === '0x95d89b41') return bytes32('FIX');
      if (selector === '0x313ce567') return `0x${word(18)}`;
      if (selector === '0x18160ddd') return `0x${word(123456)}`;
      throw new Error(`Unexpected metadata selector: ${selector}`);
    },
  };
  const historicalAddress = '0x3333333333333333333333333333333333333333';
  const historicalMetadata = await verifyErc20Metadata(historicalMetadataRpc, historicalAddress, { blockTag: historicalBlockTag });
  assert.equal(historicalMetadata.status, 'verified');
  assert.ok(historicalMetadataCalls.some(({ method }) => method === 'eth_getCode'));
  assert.ok(historicalMetadataCalls.some(({ method }) => method === 'eth_call'));
  assert.ok(historicalMetadataCalls.every(({ params }) => params[1] === historicalBlockTag));

  historicalMetadataCalls.length = 0;
  const candidateLog = {
    address: historicalAddress,
    topics: [TRANSFER_TOPIC, indexedAddressTopic(sharedFrom), indexedAddressTopic(sharedTo)],
    data: `0x${word(1)}`,
    blockNumber: 10,
    transactionHash: `0x${'41'.repeat(32)}`,
    logIndex: 0,
  };
  const discovered = await discoverTransferEmitters(historicalMetadataRpc, [candidateLog], { blockTag: historicalBlockTag });
  assert.equal(discovered.records[0].status, 'verified');
  assert.ok(historicalMetadataCalls.every(({ params }) => params[1] === historicalBlockTag));

  historicalMetadataCalls.length = 0;
  const majorAssetObservations = await inspectMajorAssets(historicalMetadataRpc, { blockTag: historicalBlockTag });
  assert.equal(majorAssetObservations.length, ARC_VERIFIED_ASSETS.length);
  assert.ok(historicalMetadataCalls.every(({ params }) => params[1] === historicalBlockTag));

  const reconciliationTransactionHash = `0x${'31'.repeat(32)}`;
  const reconciliationLog = {
    address: USDC_SYSTEM_EMITTER,
    topics: [TRANSFER_TOPIC, indexedAddressTopic(sharedFrom), indexedAddressTopic(sharedTo)],
    data: `0x${word(1_000_000_000_000_000_000n)}`,
    blockNumber: '0xa',
    transactionIndex: '0x0',
    logIndex: '0x0',
  };
  const reconciliationEmitterLog = {
    address: historicalAddress,
    topics: [TRANSFER_TOPIC, indexedAddressTopic(sharedFrom), indexedAddressTopic(sharedTo)],
    data: `0x${word(2)}`,
    blockNumber: '0xa',
    transactionIndex: '0x0',
    logIndex: '0x1',
  };
  const reconciliationMetadataCalls = [];
  let returnMatchingTransferLogs = false;
  const reconciliationRpc = {
    url: 'fixture://transfer-log-reconciliation',
    async request(method, params) {
      if (method === 'eth_chainId') return '0x13b2';
      if (method === 'eth_blockNumber') return '0xa';
      if (method === 'eth_getBlockByNumber') return {
        number: '0xa',
        hash: `0x${'22'.repeat(32)}`,
        parentHash: `0x${'21'.repeat(32)}`,
        timestamp: '0x64',
        transactions: [{
          hash: reconciliationTransactionHash,
          blockNumber: '0xa',
          transactionIndex: '0x0',
          from: sharedFrom,
          to: sharedTo,
          value: '0x0',
          input: '0x',
        }],
      };
      if (method === 'eth_getBlockReceipts') return [{
        transactionHash: reconciliationTransactionHash,
        blockNumber: '0xa',
        transactionIndex: '0x0',
        status: '0x1',
        gasUsed: '0x5208',
        effectiveGasPrice: '0x1',
        contractAddress: null,
        logs: [reconciliationLog, reconciliationEmitterLog],
      }];
      if (method === 'eth_getLogs') return returnMatchingTransferLogs ? [
        { ...reconciliationLog, transactionHash: reconciliationTransactionHash },
        { ...reconciliationEmitterLog, transactionHash: reconciliationTransactionHash },
      ] : [];
      if (method === 'eth_getCode') {
        reconciliationMetadataCalls.push({ method, params });
        return '0x6000';
      }
      if (method === 'eth_call') {
        reconciliationMetadataCalls.push({ method, params });
        const selector = params[0]?.data;
        if (selector === '0x06fdde03') return bytes32('Fixture Token');
        if (selector === '0x95d89b41') return bytes32('FIX');
        if (selector === '0x313ce567') return `0x${word(18)}`;
        if (selector === '0x18160ddd') return `0x${word(123456)}`;
      }
      throw new Error(`Unexpected reconciliation fixture RPC method: ${method}`);
    },
  };
  const missingTransferSnapshot = await buildBoundedSnapshot({
    rpc: reconciliationRpc,
    startBlock: 10,
    endBlock: 10,
  });
  assert.equal(missingTransferSnapshot.transferLogReconciliation.receiptSetComplete, true);
  assert.equal(missingTransferSnapshot.transferLogReconciliation.queryComplete, true);
  assert.equal(missingTransferSnapshot.transferLogReconciliation.missingLogCount, 2);
  assert.equal(missingTransferSnapshot.transferScanComplete, false);
  assert.equal(missingTransferSnapshot.complete, false);
  assert.ok(missingTransferSnapshot.warnings.some((warning) => warning.includes('Transfer log reconciliation mismatch')));
  assert.equal(missingTransferSnapshot.canonicalUsdc.complete, false);
  assert.equal(missingTransferSnapshot.canonicalUsdc.amountRaw, null);
  assert.ok(missingTransferSnapshot.verifiedAssetTransfers.every((asset) => !asset.complete && asset.amountRaw === null));

  returnMatchingTransferLogs = true;
  const matchingTransferSnapshot = await buildBoundedSnapshot({
    rpc: reconciliationRpc,
    startBlock: 10,
    endBlock: 10,
  });
  assert.equal(matchingTransferSnapshot.transferLogReconciliation.complete, true);
  assert.equal(matchingTransferSnapshot.transferScanComplete, true);
  assert.equal(matchingTransferSnapshot.complete, true);
  assert.ok(reconciliationMetadataCalls.some(({ method }) => method === 'eth_getCode'));
  assert.ok(reconciliationMetadataCalls.some(({ method }) => method === 'eth_call'));
  assert.ok(reconciliationMetadataCalls.every(({ params }) => params[1] === '0xa'));

  const failingRpc = {
    url: 'fixture://unavailable',
    async request() { throw new Error('fixture RPC unavailable'); },
  };
  const incompleteSnapshot = await buildBoundedSnapshot({ rpc: failingRpc, startBlock: 10, endBlock: 10 });
  assert.equal(incompleteSnapshot.complete, false);
  assert.equal(incompleteSnapshot.chainId, null);

  await assert.rejects(buildBoundedSnapshot({
    rpc: failingRpc,
    startBlock: 0,
    endBlock: MAX_WINDOW_SIZE,
  }), /hard maximum/);
  await assert.rejects(buildBoundedSnapshot({
    rpc: failingRpc,
    startBlock: 10,
    endBlock: 10,
    blockConcurrency: 9,
  }), /blockConcurrency/);
}

function printLiveSnapshot(snapshot) {
  console.log('Machina Arc Intelligence Phase 1A core verifier');
  console.log('Deterministic fixtures: PASS');
  console.log(`RPC source: ${snapshot.source}`);
  console.log(`Chain ID: ${snapshot.chainId}`);
  console.log(`Bounded window: ${snapshot.startBlock}..${snapshot.endBlock} (${snapshot.blockCount} blocks)`);
  console.log(`Completeness: ${snapshot.complete ? 'complete' : 'incomplete'}; last indexed block: ${snapshot.lastIndexedBlock}`);
  const reconciliation = snapshot.transferLogReconciliation;
  console.log(`Transfer log reconciliation: ${reconciliation.complete ? 'complete' : 'incomplete'}; receipts ${reconciliation.receiptTransferLogCount}; eth_getLogs ${reconciliation.queriedTransferLogCount ?? 'unavailable'}; missing ${reconciliation.missingLogCount ?? 'unavailable'}; extra ${reconciliation.extraLogCount ?? 'unavailable'}; duplicates receipt/query ${reconciliation.duplicateReceiptLogCount}/${reconciliation.duplicateQueryLogCount}; identityless receipt/query ${reconciliation.identitylessReceiptLogCount}/${reconciliation.identitylessQueryLogCount}`);
  console.log(`Transactions: ${snapshot.totalTransactions}; receipts: ${snapshot.receiptCount}; success: ${snapshot.successfulTransactions}; failed: ${snapshot.failedTransactions}`);
  console.log(`Top level addresses: senders ${snapshot.uniqueTopLevelSenders}; recipients ${snapshot.uniqueTopLevelRecipients}; active ${snapshot.uniqueTopLevelActiveAddresses}`);
  console.log(`Gas used raw: ${snapshot.totalGasUsedRaw}; transaction fees raw: ${snapshot.totalTransactionFeesRaw ?? 'unavailable'}`);
  console.log(`Transfer emitters: ${snapshot.discoveredTransferEmitters ?? 'unavailable'}; metadata verified: ${snapshot.verifiedTokenContracts}; unknown/unverified: ${snapshot.unverifiedTransferEmitters ?? 'unavailable'}`);

  for (const asset of snapshot.verifiedAssetObservations) {
    const state = asset.liveMetadataMatchesRegistry ? 'verified' : 'unavailable/unverified';
    console.log(`Asset ${asset.symbol}: live ${state}; observed symbol=${asset.observedSymbol ?? 'unavailable'} decimals=${asset.observedDecimals ?? 'unavailable'}`);
  }

  const usdc = snapshot.canonicalUsdc;
  console.log(`Canonical USDC: emitter ${usdc.emitter}; transfers ${usdc.transferCount ?? 'unavailable'}; amount raw ${usdc.amountRaw ?? 'unavailable'} (${usdc.rawDecimals} decimals)`);
  console.log(`USDC ERC-20 interface activity: ${usdc.erc20InterfaceActivity.transferCount ?? 'unavailable'}; raw decimals ${usdc.erc20InterfaceActivity.rawDecimals}; added to canonical amount: ${usdc.erc20InterfaceActivity.includedInCanonicalAmount ? 'yes' : 'no'}`);
  console.log(`Legacy USDC backfill: ${usdc.legacyUsdcBackfill.status}`);
  if (snapshot.warnings.length === 0) console.log('Warnings: none');
  else {
    console.log(`Warnings: ${snapshot.warnings.length}`);
    for (const warning of snapshot.warnings.slice(0, 8)) console.log(`- ${warning}`);
    if (snapshot.warnings.length > 8) console.log(`- ${snapshot.warnings.length - 8} additional warning(s) omitted`);
  }
}

await verifyDeterministicFixtures();
if (process.argv.includes('--fixtures-only')) {
  console.log('Deterministic fixtures: PASS');
  console.log('Live RPC: skipped by --fixtures-only');
  process.exit(0);
}
const snapshot = await buildLatestSnapshot({ windowSize: 25 });
printLiveSnapshot(snapshot);

assert.equal(snapshot.chainId, ARC_CHAIN_ID, 'Arc chain ID must be 5042');
assert.equal(snapshot.complete, true, 'The live bounded window must be complete');
assert.equal(snapshot.blockCount, 25, 'Expected the verifier default window of 25 blocks');
assert.equal(snapshot.endBlock - snapshot.startBlock + 1, snapshot.blockCount, 'Block range must be contiguous');
assert.equal(snapshot.lastIndexedBlock, snapshot.endBlock, 'Indexing must reach the requested end block');
assert.equal(snapshot.receiptCount, snapshot.totalTransactions, 'Receipt count must match transaction count');
assert.equal(snapshot.successfulTransactions + snapshot.failedTransactions, snapshot.totalTransactions);
assert.equal(typeof snapshot.totalGasUsedRaw, 'string');
assert.ok(/^\d+$/.test(snapshot.totalGasUsedRaw));
assert.equal(snapshot.discoveredTransferEmitters, snapshot.discoveredTransferEmitterAddresses.length);
assert.equal(snapshot.verifiedTokenContracts + snapshot.unverifiedTransferEmitters, snapshot.discoveredTransferEmitters);
assert.equal(snapshot.canonicalUsdc.emitter, USDC_SYSTEM_EMITTER);
assert.equal(snapshot.canonicalUsdc.erc20InterfaceActivity.includedInCanonicalAmount, false);
assert.equal(snapshot.canonicalUsdc.complete, true);
assert.equal(snapshot.verifiedAssetObservations.length, ARC_VERIFIED_ASSETS.length);
assert.ok(snapshot.verifiedAssetTransfers.every((asset) => asset.amountRaw === null || /^\d+$/.test(asset.amountRaw)));

console.log('Verifier result: PASS');
