// Process-local evidence that a sealed transport never reached the wallet or received a completed standard EIP-1193 rejection. No network, SDK, storage or signature.
const issued = new WeakSet<object>()
export type BorrowUnsentProof = Readonly<{ owner: string; scopeId: string; actionId: string; idempotencyKey: string; basis?: 'never-requested' | 'provider-user-rejected' }>
export function isBorrowUnsentProof(value: unknown): value is BorrowUnsentProof { return typeof value === 'object' && value !== null && issued.has(value) }
export function createBorrowSubmissionGuard(binding: BorrowUnsentProof) {
  let requested = false, sealed = false, rejected = false
  return {
    check() { if (sealed) throw Error('borrow_submission_sealed') },
    markRequested() { if (sealed || requested) throw Error('borrow_duplicate_wallet_request'); requested = true },
    requested: () => requested,
    // Only the bounded wallet transport calls this after a completed EIP-1193 4001 rejection, before any hash exists.
    markProviderRejected() { if (!requested) throw Error('borrow_rejection_without_request'); rejected = true; sealed = true },
    sealUnsent(): BorrowUnsentProof | null {
      sealed = true
      if (requested && !rejected) return null
      const proof = Object.freeze({ ...binding, basis: rejected ? 'provider-user-rejected' as const : 'never-requested' as const }); issued.add(proof); return proof
    },
  }
}
