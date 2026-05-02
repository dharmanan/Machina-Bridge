import crypto from 'node:crypto';

export const TRANSFER_STATUS = {
  PENDING_ATTESTATION: 'pending_attestation',
  READY_TO_MINT: 'ready_to_mint',
  MINTED: 'minted',
  DISMISSED: 'dismissed',
};

export function createTransferRecord(input) {
  const now = Date.now();
  return {
    id: crypto.randomUUID(),
    walletAddress: input.walletAddress.toLowerCase(),
    sourceChainId: input.sourceChainId,
    destinationChainId: input.destinationChainId,
    amount: input.amount,
    token: input.token,
    sourceTxHash: input.sourceTxHash,
    destinationTxHash: null,
    status: TRANSFER_STATUS.PENDING_ATTESTATION,
    createdAt: now,
    updatedAt: now,
  };
}

export function transferKey(id) {
  return `bridge:transfer:${id}`;
}

export function walletIndexKey(address) {
  return `bridge:wallet:${address.toLowerCase()}`;
}

export function pendingSetKey() {
  return 'bridge:pending';
}
