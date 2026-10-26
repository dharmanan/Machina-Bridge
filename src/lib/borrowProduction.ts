import { createWalletClient, custom, type Hex } from 'viem'
import { getChainByEnum, Blockchain } from '@circle-fin/borrow-kit'
import { createViemAdapterContext, createViemAdapterFromContext } from '@circle-fin/borrow-adapter-viem-v2/next'
import { executeBorrowWrite, type BorrowBoundaryRequest, type Eip1193Request } from './mainnetBorrow'
import { createBorrowSdkTransport, borrowPublicClient, borrowWalletRead } from './borrowSdkTransport'
import { createBorrowRecoveryStore, recoverBorrowTransaction, type BorrowRecoveryResult } from './borrowRecovery'
import { BorrowOperationError, BorrowNotRequestedError, productionBorrowExecutionBlocker, type BorrowOperationPorts, type BorrowReview } from './borrowOperations'
import { browserBorrowLocks } from './borrowOperationLock'
import { borrowAttemptScope } from './borrowWriteSafety'
import type { StorageLike } from './borrowAttemptLedger'

// Capability discovery is read-only. EOA support is supplied by the official /next mechanism, never by skipping atomicity.
export async function detectBorrowAtomicSupport(request: Eip1193Request, owner: Hex): Promise<'supported' | 'unsupported' | 'unknown'> {
  try {
    let nativeAtomic = false
    const readOnlyRequest = async (args: Parameters<Eip1193Request>[0]) => {
      if (!['eth_chainId', 'eth_accounts', 'wallet_getCapabilities'].includes(args.method)) throw new Error('borrow_capability_method_blocked')
      const response = await borrowWalletRead(request, args)
      if (args.method === 'wallet_getCapabilities' && response && typeof response === 'object') {
        const caps = response as Record<string, { atomic?: { status?: string; supported?: boolean } }>
        if (Object.keys(caps).length > 128) throw new Error('borrow_capabilities_unbounded')
        nativeAtomic = Object.entries(caps).some(([id, value]) => /^(?:0x[0-9a-f]+|[1-9][0-9]*)$/i.test(id) && BigInt(id) === 5042n && (['supported', 'ready'].includes(value?.atomic?.status ?? '') || value?.atomic?.supported === true))
      }
      return response // Never hide or rewrite capabilities to force the SDK onto another mechanism.
    }
    const chain = getChainByEnum(Blockchain.Arc), client = borrowPublicClient()
    if (chain.type !== 'evm') return 'unknown'
    const wallet = createWalletClient({ account: owner, transport: custom({ request: readOnlyRequest as any }, { retryCount: 0 }) })
    const ctx = createViemAdapterContext({ capabilities: { addressContext: 'user-controlled', supportedChains: [chain] }, getPublicClient: () => client, getWalletClient: () => wallet })
    const supported = await createViemAdapterFromContext(ctx).supportsAtomicBatch(chain, { fromAddress: owner })
    return supported && !nativeAtomic ? 'supported' : 'unsupported'
  } catch { return 'unknown' }
}
export function createProductionBorrowPorts(options: Pick<BorrowOperationPorts, 'readWallet' | 'prepare' | 'attempts'> & {
  request(): Eip1193Request | undefined; storage(): StorageLike | null; currentOwner(): string | undefined
}): BorrowOperationPorts {
  const client = borrowPublicClient()
  const store = (owner: Hex) => createBorrowRecoveryStore(options.storage(), owner)
  const recover = async (scopeId: string, knownHash?: string): Promise<BorrowRecoveryResult> => {
    const wallet = await options.readWallet()
    if (!wallet?.address || wallet.chainId !== 5042 || !scopeId.startsWith(`5042|${wallet.address.toLowerCase()}|`)) return { status: 'unknown', message: 'Reconnect the original wallet on Arc to check this record.' }
    try {
      const record = store(wallet.address as Hex).get(scopeId)
      if (!record) return { status: 'unknown', message: 'The original batch binding is missing. No second transaction is allowed.' }
      const recoveredHash = knownHash ?? options.attempts.get(scopeId)?.txHash
      if (!record.txHash && recoveredHash && /^0x[0-9a-f]{64}$/i.test(recoveredHash)) return recoverBorrowTransaction(client, { ...record, txHash: recoveredHash as Hex })
      return recoverBorrowTransaction(client, record)
    } catch { return { status: 'unknown', message: 'The recovery record cannot be independently verified. No second transaction is allowed.' } }
  }
  return { ...options, locks: browserBorrowLocks(), walletStage: 'bound', executionBlocker: () => productionBorrowExecutionBlocker(options.currentOwner()), recover,
    async acknowledge(scopeId) {
      const result = await recover(scopeId)
      if (!('proof' in result)) return false
      return options.attempts.resolve(scopeId, { acknowledged: true, positionReadAt: Date.now(), settlement: result.proof })
    },
    async submit(review: BorrowReview, onSubmitted, onWalletRequested, onPrepared, isCurrent) {
      // Guards are checked here as well as by the controller and existing SDK boundary. No environment flag bypasses them.
      if (!review?.wallet?.address || productionBorrowExecutionBlocker(review.wallet.address)) throw new BorrowOperationError('Real Borrow transactions are closed for this wallet.')
      if (!isCurrent || !isCurrent()) throw new BorrowNotRequestedError('Wallet or input changed. Request a new review; nothing was requested.')
      const owner = review.wallet.address as Hex, request = options.request()
      if (!request) throw new BorrowOperationError('Reconnect the wallet before preparing a transaction.')
      const ledger = options.attempts, persistence = store(owner), idempotencyKey = crypto.randomUUID()
      const transport = createBorrowSdkTransport({ review, request, client, idempotencyKey, isCurrent, requireCanary: true, walletRequested: onWalletRequested, prepared: onPrepared, persist: r => persistence.save(r), submitted: hash => {
        ledger.finish(borrowAttemptScope(review.action, owner), 'submitted', Date.now(), { batchId: hash, txHash: hash })
        onSubmitted(hash, hash)
      } })
      const result = await executeBorrowWrite({ canaryAdapter: transport.adapter as unknown as Awaited<ReturnType<BorrowBoundaryRequest['getAdapter']>>, action: review.action, reviewedQuote: review.prepared, confirmedActionId: review.actionId,
        readWallet: options.readWallet,
        refresh: async wallet => { const c = await options.prepare(review.action, wallet, review.evidence.targetHealthFactor ?? 1.5); return { quote: c.quote, evidence: c.evidence } },
        getAdapter: async () => transport.adapter as unknown as Awaited<ReturnType<BorrowBoundaryRequest['getAdapter']>>, attempts: ledger, newIdempotencyKey: () => idempotencyKey })
      const bound = transport.getBound()
      if (bound?.txHash) {
        if ('loanId' in result && /^[0-9a-f-]{36}$/i.test(result.loanId)) {
          bound.loanId = result.loanId
          try { persistence.save(bound) } catch { /* Keep the early hash and the durable pre-submit binding. */ }
        }
        return { batchId: bound.txHash, txHash: bound.txHash }
      }
      const unsent = transport.sealUnsent()
      if (unsent) {
        ledger.discard(unsent.scopeId, unsent)
        if (!ledger.get(unsent.scopeId)) {
          const reason = transport.reason()
          const message = reason === 'atomic_fee_contract' || reason === 'borrow_atomic_wallet_fee_ceiling_unsupported'
            ? 'This wallet atomic API cannot enforce the selected fee ceiling. No wallet transaction was requested.'
            : reason === 'borrow_user_rejected'
              ? 'You rejected the wallet request. Nothing was submitted. Prepare a fresh review when ready.'
            : reason === 'borrow_context_changed'
              ? 'Wallet, market or input changed. Prepare a fresh review; no wallet transaction was requested.'
            : reason === 'borrow_fee_ceiling_unbound' || reason === 'borrow_sdk_gas_drift'
              ? 'The simulated atomic batch does not fit your maximum network-fee budget. Review the budget; no wallet transaction was requested.'
              : ['borrow_nonce_unstable_or_pending', 'borrow_nonce_sources_disagree', 'borrow_send_context_changed'].includes(reason)
                ? 'Wallet and public RPC nonce checks disagree or a transaction is pending. Wait for a stable state; no wallet transaction was requested.'
                : ['borrow_review_expired', 'borrow_execution_expired', 'borrow_execution_deadline_or_metadata'].includes(reason)
                  ? 'The quote or signed execution is no longer valid. Prepare a fresh review; no wallet transaction was requested.'
                  : 'Signed batch, simulation or fresh safety checks blocked this operation. No wallet transaction was requested; prepare a new review.'
          throw new BorrowNotRequestedError(message)
        }
      }
      if (result.status === 'refused') throw new BorrowOperationError('Fresh safety checks blocked this operation. No wallet transaction was requested.')
      // A provider failure without a provable hash is ambiguous. Never create another batch to discover its outcome.
      throw new BorrowOperationError('The submission outcome is not independently known. Do not submit again.')
    },
    async verify(review, batchId, hash) {
      const result = await recover(borrowAttemptScope(review.action, review.wallet.address!), hash === batchId ? hash : undefined)
      return 'proof' in result ? result.proof : null
    },
  }
}
