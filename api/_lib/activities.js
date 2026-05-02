import crypto from 'node:crypto';

export const ACTIVITY_RETENTION_DAYS = 30;

export const ACTIVITY_STATUS = {
  AWAITING_APPROVE: 'awaiting_approve',
  AWAITING_BURN: 'awaiting_burn',
  PENDING_ATTESTATION: 'pending_attestation',
  READY_TO_MINT: 'ready_to_mint',
  MINTED: 'minted',
  FAILED: 'failed',
  DISMISSED: 'dismissed',
};

export function activityKey(id) {
  return `bridge:activity:${id}`;
}

export function activityWalletIndexKey(address) {
  return `bridge:activity:wallet:${address.toLowerCase()}`;
}

export function createActivityRecord(input) {
  const now = Date.now();
  return {
    id: input.id || crypto.randomUUID(),
    walletAddress: input.walletAddress.toLowerCase(),
    sourceChainId: input.sourceChainId,
    destinationChainId: input.destinationChainId,
    amount: input.amount,
    token: input.token || 'USDC',
    startedAt: Number.isFinite(input.startedAt) ? Number(input.startedAt) : now,
    status: input.status || ACTIVITY_STATUS.PENDING_ATTESTATION,
    step: input.step,
    signatureCount: Number.isFinite(input.signatureCount) ? Number(input.signatureCount) : undefined,
    approvalTxHash: input.approvalTxHash || undefined,
    sourceTxHash: input.sourceTxHash || undefined,
    receiveTxHash: input.receiveTxHash || undefined,
    txHashes: Array.isArray(input.txHashes) ? input.txHashes : [],
    updatedAt: Number.isFinite(input.updatedAt) ? Number(input.updatedAt) : now,
  };
}

export function isActivityStatus(value) {
  return typeof value === 'string' && Object.values(ACTIVITY_STATUS).includes(value);
}
