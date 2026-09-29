import { normalizeBlock, normalizeLog, normalizeReceipt, quantityToSafeNumber } from './normalize.js';
import { ARC_CHAIN_ID, ARC_RPC_URL, createArcRpcClient } from './rpc.js';
import {
  discoverTransferEmitters,
  formatEmitterMetadataSummary,
  inspectMajorAssets,
  mapConcurrent,
  summarizeVerifiedAssetTransfers,
} from './tokens.js';
import { summarizeUsdcTransfers, TRANSFER_TOPIC } from './usdc.js';

export const DEFINITION_VERSION = 'arc-intelligence-core-v1';
export const DEFAULT_WINDOW_SIZE = 25;
export const MAX_WINDOW_SIZE = 50;
export const MAX_BLOCK_CONCURRENCY = 8;
export const MAX_TRANSFER_LOGS = 10_000;

function blockTag(blockNumber) {
  return `0x${blockNumber.toString(16)}`;
}

function emptySnapshot({ startBlock = null, endBlock = null, source = ARC_RPC_URL } = {}) {
  return {
    chainId: null,
    startBlock,
    endBlock,
    startTimestamp: null,
    endTimestamp: null,
    blockCount: 0,
    totalTransactions: 0,
    receiptCount: 0,
    blocks: [],
    transactions: [],
    receipts: [],
    logs: [],
    transferLogs: [],
    successfulTransactions: 0,
    failedTransactions: 0,
    uniqueTopLevelSenders: 0,
    uniqueTopLevelRecipients: 0,
    uniqueTopLevelActiveAddresses: 0,
    topLevelContractCreations: 0,
    totalGasUsedRaw: '0',
    totalTransactionFeesRaw: null,
    averageTransactionsPerBlock: null,
    discoveredTransferEmitters: null,
    discoveredTransferEmitterAddresses: [],
    verifiedTokenContracts: 0,
    unverifiedTransferEmitters: null,
    transferEmitterMetadata: [],
    verifiedAssetObservations: [],
    verifiedAssetTransfers: [],
    canonicalUsdc: summarizeUsdcTransfers([], { complete: false }),
    transferScanComplete: false,
    transferLogReconciliation: {
      complete: false,
      receiptSetComplete: false,
      queryComplete: false,
      receiptTransferLogCount: 0,
      queriedTransferLogCount: null,
      missingLogCount: null,
      extraLogCount: null,
      duplicateReceiptLogCount: null,
      duplicateQueryLogCount: null,
      identitylessReceiptLogCount: null,
      identitylessQueryLogCount: null,
    },
    complete: false,
    source,
    definitionVersion: DEFINITION_VERSION,
    lastIndexedBlock: null,
    warnings: [],
  };
}

function validateWindow(startBlock, endBlock, maxWindowSize = MAX_WINDOW_SIZE) {
  if (!Number.isSafeInteger(startBlock) || !Number.isSafeInteger(endBlock) || startBlock < 0 || endBlock < startBlock) {
    throw new RangeError('Invalid bounded block window');
  }
  if (!Number.isSafeInteger(maxWindowSize) || maxWindowSize < 1 || maxWindowSize > MAX_WINDOW_SIZE) {
    throw new RangeError(`maxWindowSize must be between 1 and ${MAX_WINDOW_SIZE}`);
  }
  const size = endBlock - startBlock + 1;
  if (size > maxWindowSize) throw new RangeError(`Block window exceeds hard maximum of ${maxWindowSize}`);
  return size;
}

async function readBlock(rpc, number) {
  const raw = await rpc.request('eth_getBlockByNumber', [blockTag(number), true]);
  if (!raw) throw new Error(`Block ${number} was unavailable`);
  const block = normalizeBlock(raw, ARC_CHAIN_ID);
  if (block.number !== number) throw new Error(`RPC returned unexpected block ${block.number} for ${number}`);
  return { raw, block };
}

async function individualReceipts(rpc, transactions, blockNumber) {
  return mapConcurrent(transactions, 4, async (transaction) => {
    const raw = await rpc.request('eth_getTransactionReceipt', [transaction.hash]);
    if (!raw) throw new Error(`Receipt unavailable for ${transaction.hash}`);
    return normalizeReceipt(raw, {
      hash: transaction.hash,
      blockNumber,
      transactionIndex: transaction.transactionIndex,
    });
  });
}

function validateReceiptSet(receipts, block) {
  if (!Array.isArray(receipts) || receipts.length !== block.transactionCount) return false;
  const byHash = new Map();
  for (const receipt of receipts) {
    if (byHash.has(receipt.hash) || receipt.blockNumber !== block.number || receipt.status === 'unknown') return false;
    byHash.set(receipt.hash, receipt);
  }
  return block.transactions.every((transaction) => {
    const receipt = byHash.get(transaction.hash);
    return receipt?.transactionIndex === transaction.transactionIndex;
  });
}

async function readBlockReceipts(rpc, entry, warnings) {
  const { raw, block } = entry;
  if (block.transactionCount === 0) return [];

  try {
    const bulk = await rpc.request('eth_getBlockReceipts', [raw.number]);
    if (Array.isArray(bulk)) {
      const receipts = bulk.map((receipt) => normalizeReceipt(receipt, { blockNumber: block.number }))
        .sort((left, right) => left.blockNumber - right.blockNumber || left.transactionIndex - right.transactionIndex);
      if (validateReceiptSet(receipts, block)) return receipts;
      warnings.push(`Block ${block.number}: bulk receipt set was incomplete; trying transaction receipt fallback.`);
    } else {
      warnings.push(`Block ${block.number}: bulk receipt response was malformed; trying transaction receipt fallback.`);
    }
  } catch {
    warnings.push(`Block ${block.number}: bulk receipts unavailable; trying transaction receipt fallback.`);
  }

  try {
    const receipts = (await individualReceipts(rpc, block.transactions, block.number))
      .sort((left, right) => left.blockNumber - right.blockNumber || left.transactionIndex - right.transactionIndex);
    if (!validateReceiptSet(receipts, block)) throw new Error('Fallback receipt set did not match block transactions');
    return receipts;
  } catch {
    warnings.push(`Block ${block.number}: transaction receipt fallback was incomplete.`);
    return null;
  }
}

function sortedUniqueCount(values) {
  return new Set(values.filter(Boolean)).size;
}

function transferLogIdentity(log) {
  if (!Number.isSafeInteger(log.blockNumber)
    || !Number.isSafeInteger(log.logIndex)
    || typeof log.transactionHash !== 'string'
    || typeof log.address !== 'string') return null;
  return `${log.blockNumber}:${log.transactionHash.toLowerCase()}:${log.logIndex}:${log.address.toLowerCase()}`;
}

function countTransferLogIdentities(logs) {
  const counts = new Map();
  let identitylessCount = 0;
  for (const log of logs) {
    if (log.topics?.[0] !== TRANSFER_TOPIC) continue;
    const identity = transferLogIdentity(log);
    if (identity === null) {
      identitylessCount += 1;
      continue;
    }
    counts.set(identity, (counts.get(identity) ?? 0) + 1);
  }
  const duplicateCount = [...counts.values()].reduce((sum, count) => sum + Math.max(0, count - 1), 0);
  return { counts, identitylessCount, duplicateCount };
}

function reconcileTransferLogs(receiptLogs, queriedLogs, { receiptSetComplete, queryComplete }) {
  const receiptTransfers = receiptLogs.filter((log) => log.topics?.[0] === TRANSFER_TOPIC);
  const queriedTransfers = queriedLogs.filter((log) => log.topics?.[0] === TRANSFER_TOPIC);
  const receiptIdentities = countTransferLogIdentities(receiptTransfers);
  const queryIdentities = countTransferLogIdentities(queriedTransfers);
  const canCompareSets = receiptSetComplete && queryComplete;
  let missingLogCount = null;
  let extraLogCount = null;
  if (canCompareSets) {
    const identities = new Set([...receiptIdentities.counts.keys(), ...queryIdentities.counts.keys()]);
    missingLogCount = 0;
    extraLogCount = 0;
    for (const identity of identities) {
      const receiptCount = receiptIdentities.counts.get(identity) ?? 0;
      const queryCount = queryIdentities.counts.get(identity) ?? 0;
      missingLogCount += Math.max(0, receiptCount - queryCount);
      extraLogCount += Math.max(0, queryCount - receiptCount);
    }
  }
  const exactMatch = canCompareSets
    && missingLogCount === 0
    && extraLogCount === 0
    && receiptIdentities.duplicateCount === 0
    && queryIdentities.duplicateCount === 0
    && receiptIdentities.identitylessCount === 0
    && queryIdentities.identitylessCount === 0;

  return {
    complete: exactMatch,
    receiptSetComplete,
    queryComplete,
    receiptTransferLogCount: receiptTransfers.length,
    queriedTransferLogCount: queryComplete ? queriedTransfers.length : null,
    missingLogCount,
    extraLogCount,
    duplicateReceiptLogCount: receiptIdentities.duplicateCount,
    duplicateQueryLogCount: queryIdentities.duplicateCount,
    identitylessReceiptLogCount: receiptIdentities.identitylessCount,
    identitylessQueryLogCount: queryIdentities.identitylessCount,
  };
}

function aggregateBlockResults(blockResults, warnings) {
  const blocks = blockResults.filter((result) => result?.block).map((result) => result.block);
  const receipts = blockResults.flatMap((result) => result?.receipts ?? [])
    .sort((left, right) => left.blockNumber - right.blockNumber || left.transactionIndex - right.transactionIndex);
  const transactions = blocks.flatMap((block) => block.transactions)
    .sort((left, right) => left.blockNumber - right.blockNumber || left.transactionIndex - right.transactionIndex);
  const receiptByHash = new Map(receipts.map((receipt) => [receipt.hash, receipt]));
  let successfulTransactions = 0;
  let failedTransactions = 0;
  let statusComplete = true;
  let totalGasUsed = 0n;
  let totalFees = 0n;
  let feesComplete = true;
  let topLevelContractCreations = 0;

  for (const receipt of receipts) {
    if (receipt.status === 'success') successfulTransactions += 1;
    else if (receipt.status === 'failed') failedTransactions += 1;
    else statusComplete = false;

    totalGasUsed += BigInt(receipt.gasUsedRaw);
    if (receipt.effectiveGasPriceRaw === null) feesComplete = false;
    else totalFees += BigInt(receipt.gasUsedRaw) * BigInt(receipt.effectiveGasPriceRaw);
  }

  for (const transaction of transactions) {
    const receipt = receiptByHash.get(transaction.hash);
    if (transaction.to === null && receipt?.status === 'success' && receipt.contractAddress) {
      topLevelContractCreations += 1;
    }
  }

  if (!feesComplete) warnings.push('At least one receipt had no effectiveGasPrice; total transaction fees are unavailable.');
  if (!statusComplete) warnings.push('At least one receipt had an unknown status.');

  const senders = transactions.map((transaction) => transaction.from);
  const recipients = transactions.map((transaction) => transaction.to);
  const activeAddresses = [...senders, ...recipients].filter(Boolean);
  const blockCount = blocks.length;
  const totalTransactions = blocks.reduce((sum, block) => sum + block.transactionCount, 0);
  const byNumber = new Map(blocks.map((block) => [block.number, block]));

  let lastIndexedBlock = null;
  let previousBlock = null;
  for (const result of blockResults) {
    if (!result?.block || result.receipts === null || result.receipts === undefined) break;
    if (previousBlock && result.block.parentHash !== previousBlock.hash) break;
    lastIndexedBlock = result.requestedNumber;
    previousBlock = result.block;
  }

  return {
    blocks,
    receipts,
    transactions,
    blockCount,
    totalTransactions,
    successfulTransactions,
    failedTransactions,
    uniqueTopLevelSenders: sortedUniqueCount(senders),
    uniqueTopLevelRecipients: sortedUniqueCount(recipients),
    uniqueTopLevelActiveAddresses: sortedUniqueCount(activeAddresses),
    topLevelContractCreations,
    totalGasUsedRaw: totalGasUsed.toString(10),
    totalTransactionFeesRaw: feesComplete ? totalFees.toString(10) : null,
    averageTransactionsPerBlock: blockCount > 0 ? totalTransactions / blockCount : null,
    startTimestamp: byNumber.get(blockResults[0]?.requestedNumber)?.timestamp ?? null,
    endTimestamp: byNumber.get(blockResults.at(-1)?.requestedNumber)?.timestamp ?? null,
    lastIndexedBlock,
    statusComplete,
  };
}

export async function buildBoundedSnapshot({
  rpc = createArcRpcClient(),
  startBlock,
  endBlock,
  windowSize = DEFAULT_WINDOW_SIZE,
  maxWindowSize = MAX_WINDOW_SIZE,
  blockConcurrency = 4,
  maxMetadataCandidates = 50,
} = {}) {
  const snapshot = emptySnapshot({ startBlock: Number.isSafeInteger(startBlock) ? startBlock : null, endBlock: Number.isSafeInteger(endBlock) ? endBlock : null, source: rpc.url ?? ARC_RPC_URL });
  const warnings = snapshot.warnings;
  if (!Number.isSafeInteger(maxMetadataCandidates) || maxMetadataCandidates < 0 || maxMetadataCandidates > 50) {
    throw new RangeError('maxMetadataCandidates must be between 0 and 50');
  }
  if (!Number.isSafeInteger(blockConcurrency) || blockConcurrency < 1 || blockConcurrency > MAX_BLOCK_CONCURRENCY) {
    throw new RangeError(`blockConcurrency must be between 1 and ${MAX_BLOCK_CONCURRENCY}`);
  }
  if (!Number.isSafeInteger(maxWindowSize) || maxWindowSize < 1 || maxWindowSize > MAX_WINDOW_SIZE) {
    throw new RangeError(`maxWindowSize must be between 1 and ${MAX_WINDOW_SIZE}`);
  }

  const hasExplicitRange = startBlock !== undefined || endBlock !== undefined;
  if (hasExplicitRange && (startBlock === undefined || endBlock === undefined)) {
    throw new RangeError('Provide both startBlock and endBlock, or neither');
  }
  if (hasExplicitRange) validateWindow(startBlock, endBlock, maxWindowSize);
  else if (!Number.isSafeInteger(windowSize) || windowSize < 1 || windowSize > maxWindowSize) {
    throw new RangeError(`windowSize must be between 1 and ${maxWindowSize}`);
  }

  let chainId;
  let head;

  try {
    chainId = quantityToSafeNumber(await rpc.request('eth_chainId'), 'chain id');
    if (chainId !== ARC_CHAIN_ID) throw new Error(`Unexpected chain id ${chainId}`);
    head = quantityToSafeNumber(await rpc.request('eth_blockNumber'), 'block number');
  } catch (error) {
    warnings.push(error?.message ?? 'RPC chain/head request failed.');
    return snapshot;
  }

  let requestedStart = startBlock;
  let requestedEnd = endBlock;
  if (!hasExplicitRange) {
    requestedEnd = head;
    requestedStart = Math.max(0, head - windowSize + 1);
  }

  const expectedBlockCount = validateWindow(requestedStart, requestedEnd, maxWindowSize);
  snapshot.startBlock = requestedStart;
  snapshot.endBlock = requestedEnd;

  if (requestedEnd > head) {
    warnings.push('Requested end block is above the current canonical head.');
    return snapshot;
  }

  const requestedNumbers = Array.from({ length: expectedBlockCount }, (_, index) => requestedStart + index);
  const blockResults = await mapConcurrent(requestedNumbers, blockConcurrency, async (number) => {
    try {
      const result = { requestedNumber: number, ...(await readBlock(rpc, number)) };
      result.receipts = await readBlockReceipts(rpc, result, warnings);
      return result;
    } catch {
      warnings.push(`Block ${number}: block response was missing or malformed.`);
      return { requestedNumber: number, block: null, raw: null, receipts: null };
    }
  });

  const aggregate = aggregateBlockResults(blockResults, warnings);
  snapshot.chainId = chainId;
  snapshot.blockCount = aggregate.blockCount;
  snapshot.totalTransactions = aggregate.totalTransactions;
  snapshot.receiptCount = aggregate.receipts.length;
  snapshot.blocks = aggregate.blocks;
  snapshot.transactions = aggregate.transactions;
  snapshot.receipts = aggregate.receipts;
  snapshot.logs = aggregate.receipts.flatMap((receipt) => receipt.logs)
    .sort((left, right) => left.blockNumber - right.blockNumber || left.logIndex - right.logIndex);
  snapshot.successfulTransactions = aggregate.successfulTransactions;
  snapshot.failedTransactions = aggregate.failedTransactions;
  snapshot.uniqueTopLevelSenders = aggregate.uniqueTopLevelSenders;
  snapshot.uniqueTopLevelRecipients = aggregate.uniqueTopLevelRecipients;
  snapshot.uniqueTopLevelActiveAddresses = aggregate.uniqueTopLevelActiveAddresses;
  snapshot.topLevelContractCreations = aggregate.topLevelContractCreations;
  snapshot.totalGasUsedRaw = aggregate.totalGasUsedRaw;
  snapshot.totalTransactionFeesRaw = aggregate.totalTransactionFeesRaw;
  snapshot.averageTransactionsPerBlock = aggregate.averageTransactionsPerBlock;
  snapshot.startTimestamp = aggregate.startTimestamp;
  snapshot.endTimestamp = aggregate.endTimestamp;
  snapshot.lastIndexedBlock = aggregate.lastIndexedBlock;

  const receiptSetComplete = aggregate.blockCount === expectedBlockCount
    && blockResults.every((result) => result.block
      && Array.isArray(result.receipts)
      && validateReceiptSet(result.receipts, result.block))
    && aggregate.transactions.length === aggregate.receipts.length
    && aggregate.lastIndexedBlock === requestedEnd;
  const receiptTransferLogs = snapshot.logs.filter((log) => log.topics?.[0] === TRANSFER_TOPIC);
  let transferLogs = [];
  let transferQueryComplete = false;
  try {
    const rawLogs = await rpc.request('eth_getLogs', [{
      fromBlock: blockTag(requestedStart),
      toBlock: blockTag(requestedEnd),
      topics: [TRANSFER_TOPIC],
    }]);
    if (!Array.isArray(rawLogs) || rawLogs.length > MAX_TRANSFER_LOGS) {
      throw new Error('Transfer log response was malformed or exceeded the bounded response limit.');
    }
    transferLogs = rawLogs.map((log) => normalizeLog(log))
      .sort((left, right) => left.blockNumber - right.blockNumber || left.logIndex - right.logIndex);
    transferQueryComplete = true;
  } catch (error) {
    warnings.push(error?.message ?? 'Transfer log query or normalization failed.');
  }

  const reconciliation = reconcileTransferLogs(receiptTransferLogs, transferLogs, {
    receiptSetComplete,
    queryComplete: transferQueryComplete,
  });
  snapshot.transferLogReconciliation = reconciliation;
  const transferScanComplete = reconciliation.complete;
  if (!receiptSetComplete) {
    warnings.push('Transfer log reconciliation incomplete because block or receipt coverage is incomplete.');
  } else if (!transferQueryComplete) {
    warnings.push('Transfer log reconciliation incomplete because the eth_getLogs response was unavailable or malformed.');
  } else if (!reconciliation.complete) {
    warnings.push(`Transfer log reconciliation mismatch: missing ${reconciliation.missingLogCount}, extra ${reconciliation.extraLogCount}, duplicate receipt ${reconciliation.duplicateReceiptLogCount}, duplicate query ${reconciliation.duplicateQueryLogCount}, identityless receipt ${reconciliation.identitylessReceiptLogCount}, identityless query ${reconciliation.identitylessQueryLogCount}.`);
  }

  snapshot.transferScanComplete = transferScanComplete;
  snapshot.transferLogs = transferQueryComplete ? transferLogs : [];
  snapshot.canonicalUsdc = summarizeUsdcTransfers(transferLogs, { complete: transferScanComplete });
  snapshot.verifiedAssetTransfers = summarizeVerifiedAssetTransfers(transferLogs, { complete: transferScanComplete });

  if (transferScanComplete) {
    try {
      const discovery = await discoverTransferEmitters(rpc, transferLogs, {
        maxCandidates: maxMetadataCandidates,
        concurrency: 3,
        blockTag: blockTag(requestedEnd),
      });
      snapshot.discoveredTransferEmitters = discovery.emitters.length;
      snapshot.discoveredTransferEmitterAddresses = discovery.emitters;
      snapshot.verifiedTokenContracts = discovery.verifiedCount;
      snapshot.unverifiedTransferEmitters = discovery.unverifiedCount;
      snapshot.transferEmitterMetadata = formatEmitterMetadataSummary(discovery.records);
      if (discovery.truncatedCount > 0) {
        warnings.push(`${discovery.truncatedCount} transfer emitter(s) exceeded the metadata validation limit and remain unknown/unverified.`);
      }
    } catch {
      snapshot.discoveredTransferEmitters = null;
      snapshot.unverifiedTransferEmitters = null;
      warnings.push('Transfer emitter metadata validation could not complete; candidates remain unknown/unverified.');
    }

    try {
      snapshot.verifiedAssetObservations = await inspectMajorAssets(rpc, { concurrency: 3, blockTag: blockTag(requestedEnd) });
    } catch {
      warnings.push('Live major-asset metadata observations are unavailable.');
    }
    for (const observation of snapshot.verifiedAssetObservations) {
      if (!observation.liveMetadataMatchesRegistry) {
        warnings.push(`${observation.symbol} live metadata did not fully verify against the official registry.`);
      }
    }
    warnings.push('The EIP-7708 system emitter is excluded from generic ERC-20 token candidates.');
  }

  if (snapshot.canonicalUsdc.warnings.length > 0) warnings.push(...snapshot.canonicalUsdc.warnings);
  if (!snapshot.canonicalUsdc.complete && transferScanComplete) {
    warnings.push('Canonical USDC transfer totals are incomplete because one or more transfer logs were malformed.');
  }

  const blocksComplete = receiptSetComplete
    && aggregate.transactions.length === aggregate.receipts.length
    && aggregate.statusComplete;
  const transferMetricsComplete = transferScanComplete
    && snapshot.canonicalUsdc.complete
    && snapshot.canonicalUsdc.erc20InterfaceActivity.complete
    && snapshot.verifiedAssetTransfers.every((asset) => asset.complete);
  snapshot.complete = blocksComplete && transferMetricsComplete;
  snapshot.warnings = [...new Set(warnings)];

  if (snapshot.complete && snapshot.lastIndexedBlock !== requestedEnd) {
    snapshot.complete = false;
    snapshot.warnings.push('The bounded window was not contiguous through the requested end block.');
  }

  return snapshot;
}

export async function buildLatestSnapshot(options = {}) {
  return buildBoundedSnapshot({ ...options, startBlock: undefined, endBlock: undefined });
}
