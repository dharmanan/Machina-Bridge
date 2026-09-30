import { TRANSFER_TOPIC } from './usdc.js';

export function logIdentity(log) {
  if (!Number.isSafeInteger(log.blockNumber)
    || !Number.isSafeInteger(log.logIndex)
    || typeof log.transactionHash !== 'string'
    || typeof log.address !== 'string') return null;
  return `${log.blockNumber}:${log.transactionHash.toLowerCase()}:${log.logIndex}:${log.address.toLowerCase()}`;
}

function countLogIdentities(logs) {
  const counts = new Map();
  let identitylessCount = 0;
  for (const log of logs) {
    const identity = logIdentity(log);
    if (identity === null) {
      identitylessCount += 1;
      continue;
    }
    const entry = counts.get(identity) ?? { count: 0, payload: null };
    entry.count += 1;
    entry.payload = JSON.stringify([log.topics, log.data]);
    counts.set(identity, entry);
  }
  const duplicateCount = [...counts.values()].reduce((sum, entry) => sum + Math.max(0, entry.count - 1), 0);
  return { counts, identitylessCount, duplicateCount };
}

export function reconcileLogs(receiptLogs, queriedLogs, { receiptSetComplete, queryComplete }, kind) {
  const receiptIdentities = countLogIdentities(receiptLogs);
  const queryIdentities = countLogIdentities(queriedLogs);
  const canCompareSets = receiptSetComplete && queryComplete;
  let missingLogCount = null;
  let extraLogCount = null;
  let payloadMismatchCount = null;
  if (canCompareSets) {
    const identities = new Set([...receiptIdentities.counts.keys(), ...queryIdentities.counts.keys()]);
    missingLogCount = 0;
    extraLogCount = 0;
    payloadMismatchCount = 0;
    for (const identity of identities) {
      const receiptEntry = receiptIdentities.counts.get(identity);
      const queryEntry = queryIdentities.counts.get(identity);
      const receiptCount = receiptEntry?.count ?? 0;
      const queryCount = queryEntry?.count ?? 0;
      missingLogCount += Math.max(0, receiptCount - queryCount);
      extraLogCount += Math.max(0, queryCount - receiptCount);
      if (receiptEntry && queryEntry && receiptEntry.payload !== queryEntry.payload) payloadMismatchCount += 1;
    }
  }
  const exactMatch = canCompareSets
    && missingLogCount === 0
    && extraLogCount === 0
    && payloadMismatchCount === 0
    && receiptIdentities.duplicateCount === 0
    && queryIdentities.duplicateCount === 0
    && receiptIdentities.identitylessCount === 0
    && queryIdentities.identitylessCount === 0;

  return {
    complete: exactMatch,
    receiptSetComplete,
    queryComplete,
    [kind === 'transfer' ? 'receiptTransferLogCount' : 'receiptLogCount']: receiptLogs.length,
    [kind === 'transfer' ? 'queriedTransferLogCount' : 'queriedLogCount']: queryComplete ? queriedLogs.length : null,
    missingLogCount,
    extraLogCount,
    duplicateReceiptLogCount: receiptIdentities.duplicateCount,
    duplicateQueryLogCount: queryIdentities.duplicateCount,
    identitylessReceiptLogCount: receiptIdentities.identitylessCount,
    identitylessQueryLogCount: queryIdentities.identitylessCount,
    payloadMismatchCount,
  };
}

export function reconcileTransferLogs(receiptLogs, queriedLogs, options) {
  return reconcileLogs(
    receiptLogs.filter((log) => log.topics?.[0] === TRANSFER_TOPIC),
    queriedLogs.filter((log) => log.topics?.[0] === TRANSFER_TOPIC), options, 'transfer',
  );
}
