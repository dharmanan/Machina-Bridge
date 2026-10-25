// Shared lifecycle orchestration, not a Borrow engine. Real funds still go only through the existing gated SDK boundary.
import { MAINNET_BORROW_CHAIN_ID, MAINNET_BORROW_EXECUTION_BOUND, MAINNET_BORROW_MAX_EVIDENCE_AGE_MS, MAINNET_BORROW_NATIVE_BACKED_TOKEN, MAINNET_BORROW_WRITES_ENABLED } from '../config/mainnetBorrow'
import { getBorrowLoans, getBorrowMarket, getBorrowPosition, planBorrowWrite, prepareBorrowQuote, prepareBorrowQuoteForTarget,
  type BorrowReadClient, type BorrowMarket, type BorrowWriteContext } from './mainnetBorrow'
import { WRITE_BLOCKER_TEXT, borrowActionId, borrowAttemptScope, borrowQuoteChange, borrowWalletSession, decimalToUnits, type BorrowWriteAction, type BorrowWalletState, type PreparedBorrowQuote, type BorrowWriteEvidence } from './borrowWriteSafety'
import type { BorrowAttemptLedger } from './borrowAttemptLedger'
import type { MarketVerification } from './borrowMarketVerification'
import type { WalletBalanceReader } from './borrowWalletBalances'
import { withBorrowOperationLock, type BorrowLockManager } from './borrowOperationLock'
import { isBorrowSettlementProof, borrowSettlementMatchesQuote, type BorrowSettlementProof } from './borrowSettlement'

import type { BorrowRecoveryResult } from './borrowRecovery'

export class BorrowOperationError extends Error {}
export class BorrowNotRequestedError extends BorrowOperationError {}
const explain = (error: unknown) => error instanceof BorrowOperationError ? error.message : error instanceof Error && error.message === 'borrow_operation_busy' ? 'Another tab is using this wallet. No transaction was requested.' : error instanceof Error && error.message === 'borrow_lock_unavailable' ? 'Browser transaction locking is unavailable. Nothing was requested.' : 'The operation could not be independently verified. Nothing further was requested.'
export const BORROW_EXECUTION_BLOCKER = 'Real transactions are closed. The production write gates are closed. EOA execution uses the separately bound SDK batch; unsupported atomic-wallet fee contracts remain blocked.'
export type BorrowReview = { action: BorrowWriteAction; wallet: BorrowWalletState; prepared: PreparedBorrowQuote; evidence: BorrowWriteEvidence; maxGasCostWei: bigint; expiresAt: number; actionId: string }
export type BorrowOperationState = {
  phase: 'idle' | 'quoting' | 'review' | 'checking' | 'wallet' | 'pending' | 'verified' | 'failed' | 'unknown' | 'blocked'
  review: BorrowReview | null; message: string; batchId?: string; txHash?: string; actualGasWei?: bigint; rpcEstimatedFeeWei?: bigint; requestFeeCeilingWei?: bigint; executionDeadlineMs?: number
}
export type BorrowOperationPorts = {
  readWallet(): Promise<BorrowWalletState | null>
  prepare(action: BorrowWriteAction, wallet: BorrowWalletState, target: number): Promise<BorrowWriteContext>
  attempts: BorrowAttemptLedger; locks: BorrowLockManager | null
  // Production intentionally provides neither callback until the SDK boundary has been independently bound.
  // Test doubles may exercise the lifecycle, but cannot enable the production SDK gate.
  walletStage?: 'bound'
  submit?: (review: BorrowReview, onSubmitted: (batchId: string, hash?: string) => void, onWalletRequested?: () => void, onPrepared?: (details: Pick<BorrowOperationState, 'rpcEstimatedFeeWei' | 'requestFeeCeilingWei' | 'executionDeadlineMs'>) => void, isCurrent?: () => boolean) => Promise<{ batchId: string; txHash?: string }>
  verify?: (review: BorrowReview, batchId: string, hash?: string) => Promise<BorrowSettlementProof | null>
  recover?: (scopeId: string) => Promise<BorrowRecoveryResult>
  acknowledge?: (scopeId: string) => Promise<boolean>
  executionBlocker(): string | null
  now?: () => number
}
export function borrowNativeBudget(prepared: PreparedBorrowQuote, gasCap: bigint): bigint | null {
  const q = prepared.quote
  const loan = q.kind === 'repay' ? q.repayAmount : q.kind === 'close-loan' || q.kind === 'withdraw-collateral' ? q.maxRepayment : null
  if (!loan || loan.tokenAddress.toLowerCase() !== MAINNET_BORROW_NATIVE_BACKED_TOKEN.toLowerCase()) return gasCap
  const nativeLoan = decimalToUnits(loan.amount, 18)
  return nativeLoan === null ? null : gasCap + nativeLoan
}
export function productionBorrowExecutionBlocker(): string | null {
  return MAINNET_BORROW_WRITES_ENABLED !== true || MAINNET_BORROW_EXECUTION_BOUND !== true ? BORROW_EXECUTION_BLOCKER : null
}
export function createBorrowOperationController(ports: BorrowOperationPorts) {
  let state: BorrowOperationState = { phase: 'idle', review: null, message: '' }, generation = 0, busy = false
  const listeners = new Set<(value: BorrowOperationState) => void>(), now = ports.now ?? Date.now
  const set = (next: BorrowOperationState) => { state = next; for (const listener of listeners) listener(state) }
  const sameWallet = (a: BorrowWalletState | null, b: BorrowWalletState) => a?.address?.toLowerCase() === b.address?.toLowerCase() && a?.chainId === b.chainId
  return {
    getState: () => state,
    subscribe(listener: (value: BorrowOperationState) => void) { listeners.add(listener); return () => { listeners.delete(listener) } },
    invalidate() {
      generation++
      if (!busy && !['pending', 'unknown', 'verified'].includes(state.phase)) set({ phase: 'idle', review: null, message: 'Wallet, network or input changed. Request a new review.' })
      // A submitted/ambiguous transaction is never discarded by context changes.
    },
    async recover(scopeId: string) {
      if (busy || !ports.recover) return
      busy = true
      try {
        const result = await ports.recover(scopeId)
        if ('proof' in result && isBorrowSettlementProof(result.proof)) set({ phase: result.status, review: null, txHash: result.proof.txHash, actualGasWei: result.proof.gasCostWei, message: result.message })
        else set({ phase: result.status === 'pending' ? 'pending' : 'unknown', review: null, message: result.message })
      } catch { set({ phase: 'unknown', review: null, message: 'Recovery could not be verified. Do not submit again.' }) }
      finally { busy = false }
    },
    async acknowledge(scopeId: string) {
      if (busy || !ports.acknowledge) return false
      return ports.acknowledge(scopeId)
    },
    async prepare(action: BorrowWriteAction, target: number, maximumGas: string) {
      if (busy || ['pending', 'unknown'].includes(state.phase)) return
      const token = ++generation
      set({ phase: 'quoting', review: null, message: 'Reading the quote, balances and market…' })
      try {
        const cap = decimalToUnits(maximumGas, 18)
        if (cap === null || cap <= 0n) throw new BorrowOperationError('Enter a positive maximum gas cost in native USDC.')
        const wallet = await ports.readWallet()
        if (!wallet?.address || wallet.chainId !== MAINNET_BORROW_CHAIN_ID) throw new BorrowOperationError('Connect your wallet on Arc Mainnet.')
        const context = await ports.prepare(action, wallet, target)
        if (token !== generation) return
        const boundAction = (action.kind === 'borrow' || action.kind === 'borrow-more') && context.quote ? { ...action, slippageBps: context.quote.request.slippageBps ?? undefined } : action
        const plan = planBorrowWrite(boundAction, { ...context, wallet, attempts: ports.attempts.list(), attemptLog: ports.attempts.health(), now: now() })
        const blockers = plan.blockers.filter(x => x !== 'writes_disabled')
        if (blockers.length || !context.quote || !context.evidence) throw new BorrowOperationError(`Review blocked: ${blockers.map(b => WRITE_BLOCKER_TEXT[b]).join(' ') || 'Missing current evidence'}.`)
        const gas = 'gasFees' in context.quote.quote ? context.quote.quote.gasFees.reduce((sum, x) => sum + BigInt(x.feeWei), 0n) : null
        const nativeBudget = borrowNativeBudget(context.quote, cap)
        if (nativeBudget === null || context.evidence.balances?.data.native == null || context.evidence.balances.data.native < nativeBudget) throw new BorrowOperationError('Your native USDC balance cannot cover the maximum gas budget.')
        if (gas === null || gas < 0n || gas > cap) throw new BorrowOperationError('The fee estimate exceeds your maximum gas budget.')
        if (!sameWallet(await ports.readWallet(), wallet)) throw new BorrowOperationError('Wallet or network changed during preparation.')
        if (token !== generation) return
        const prepared = context.quote
        const review = structuredClone({ action: boundAction, wallet, prepared, evidence: context.evidence, maxGasCostWei: cap,
          expiresAt: prepared.fetchedAt + MAINNET_BORROW_MAX_EVIDENCE_AGE_MS, actionId: borrowActionId(boundAction, wallet.address) })
        if (now() >= review.expiresAt) throw new BorrowOperationError('The quote expired during preparation. Request a new review.')
        set({ phase: 'review', review, message: ports.executionBlocker() ?? 'Check the amounts and maximum cost before confirming.' })
      } catch (error) { if (token === generation) set({ phase: 'blocked', review: null, message: explain(error) }) }
    },
    async confirm() {
      if (busy || state.phase !== 'review' || !state.review) return
      const review = state.review, token = generation
      const blocker = ports.executionBlocker()
      if (blocker || !ports.submit || !ports.verify) { set({ ...state, message: blocker ?? BORROW_EXECUTION_BLOCKER }); return }
      busy = true
      let submitted = false
      let feeDetails: Pick<BorrowOperationState, 'rpcEstimatedFeeWei' | 'requestFeeCeilingWei' | 'executionDeadlineMs'> = {}
      try {
        await withBorrowOperationLock(review.wallet.address!, async () => {
          if (ports.attempts.list().length > 0) throw new BorrowNotRequestedError('An unresolved Borrow operation already uses this wallet. Recheck and acknowledge its verified result before another transaction.')
          set({ phase: 'checking', review, message: 'Checking wallet, quote and fee budget…' })
          const wallet = await ports.readWallet()
          if (!sameWallet(wallet, review.wallet) || token !== generation || now() >= review.expiresAt) throw new BorrowOperationError('Wallet changed or review expired. Request a new review.')
          const fresh = await ports.prepare(review.action, wallet!, review.evidence.targetHealthFactor ?? 1.5)
          const plan = planBorrowWrite(review.action, { ...fresh, wallet, attempts: ports.attempts.list(), attemptLog: ports.attempts.health(), now: now() })
          if (plan.blockers.some(x => x !== 'writes_disabled') || !fresh.quote || borrowQuoteChange(review.prepared, fresh.quote) !== null) throw new BorrowOperationError('The quote or safety checks changed. Review again.')
          const feeTerms = (q: PreparedBorrowQuote) => JSON.stringify('fees' in q.quote ? q.quote.fees : [])
          if (feeTerms(fresh.quote) !== feeTerms(review.prepared)) throw new BorrowOperationError('Service fees changed. Request a new review.')
          const fee = 'gasFees' in fresh.quote.quote ? fresh.quote.quote.gasFees.reduce((s, x) => s + BigInt(x.feeWei), 0n) : null
          const nativeBudget = borrowNativeBudget(fresh.quote, review.maxGasCostWei)
          if (nativeBudget === null || fee === null || fee < 0n || fresh.evidence?.balances?.data.native == null || fresh.evidence.balances.data.native < nativeBudget || fee > review.maxGasCostWei || token !== generation || now() >= review.expiresAt || !sameWallet(await ports.readWallet(), review.wallet)) throw new BorrowOperationError('The fee budget, wallet or review is no longer valid.')
          set({ phase: ports.walletStage === 'bound' ? 'checking' : 'wallet', review, message: ports.walletStage === 'bound' ? 'Preparing and simulating the signed atomic batch…' : 'Waiting for your explicit wallet confirmation…' })
          // The production port must call the existing executeBorrowWrite under this lock. It is intentionally absent.
          submitted = true // Once the boundary is reached, a thrown error may have submitted; retain ambiguity.
          const result = await ports.submit!(review, (batchId, txHash) => {
            set({ phase: 'pending', review, ...feeDetails, batchId, txHash, message: 'Submitted. Waiting for independent chain verification.' })
          }, () => set({ phase: 'wallet', review, ...feeDetails, message: 'Check the final amounts and fee cap in your wallet.' }), details => { feeDetails = details; set({ ...state, ...details }) }, () => token === generation)
          set({ phase: 'pending', review, ...feeDetails, ...result, message: 'Checking the receipt and position independently…' })
          const proof = await ports.verify!(review, result.batchId, result.txHash)
          if (!isBorrowSettlementProof(proof) || !borrowSettlementMatchesQuote(proof, review.action, review.prepared, review.evidence.market!.data.marketId, review.maxGasCostWei, review.evidence.targetHealthFactor) || proof.owner !== review.wallet.address!.toLowerCase() || proof.chainId !== MAINNET_BORROW_CHAIN_ID || proof.scopeId !== borrowAttemptScope(review.action, review.wallet.address!) || !result.txHash || proof.txHash.toLowerCase() !== result.txHash.toLowerCase()) {
            set({ phase: 'unknown', review, ...feeDetails, ...result, message: 'Submission or result is not independently verified. Do not submit again.' }); return
          }
          set({ phase: proof.status === 'verified' ? 'verified' : 'failed', review, ...feeDetails, batchId: result.batchId, txHash: proof.txHash, actualGasWei: proof.gasCostWei, message: proof.status === 'verified' ? 'Receipt and position changes independently verified.' : 'The chain receipt confirms that the transaction reverted. Gas was spent; no successful loan change is claimed.' })
        }, ports.locks)
      } catch (error) {
        if (error instanceof BorrowNotRequestedError) submitted = false
        set({ phase: submitted ? 'unknown' : 'blocked', review, ...feeDetails, message: submitted ? 'The submission outcome is unknown. No automatic retry is allowed.' : explain(error) })
      } finally { busy = false }
    },
  }
}
// Shared read preparation for all six operations. No write method, signature or signed envelope request.
export async function readBorrowOperation(action: BorrowWriteAction, wallet: BorrowWalletState, target: number, options: {
  client?: BorrowReadClient; verifyMarket: (market: BorrowMarket) => Promise<MarketVerification>; balances: WalletBalanceReader
}): Promise<BorrowWriteContext> {
  const stamp = Date.now(), owner = wallet.address!
  const position = action.kind === 'borrow' ? null : await getBorrowPosition({ loanId: action.loanId, expectedOwner: owner }, options.client)
  if (position?.status === 'unavailable') throw new BorrowOperationError('The position could not be read for this wallet.')
  const marketId = action.kind === 'borrow' ? action.marketId : position!.data.marketId
  const market = await getBorrowMarket(marketId, options.client)
  if (market.status !== 'available') throw new BorrowOperationError('Market unavailable.')
  const [verification, balances, quote] = await Promise.all([
    options.verifyMarket(market.data), options.balances(owner, market.data.loanAsset.address, market.data.collateralAsset.address),
    action.kind === 'borrow' || action.kind === 'borrow-more'
      ? prepareBorrowQuoteForTarget(action, owner, target, options.client).then(r => {
        if (r.status !== 'available' || r.data.outcome === 'not-reached') throw new BorrowOperationError('The service quote does not meet your health factor target.')
        // Preserve exact caller action. A different buffer requires a new explicitly prepared action/review.
        return r.data.prepared
      })
      : prepareBorrowQuote(action, owner, options.client).then(r => { if (r.status !== 'available') throw new BorrowOperationError('Quote unavailable.'); return r.data }),
  ])
  if (verification.status !== 'verified' || !verification.details.block) throw new BorrowOperationError('A canonical, pinned market snapshot is required.')
  const loans = []; let cursor: string | undefined
  for (let page = 0; page < 5; page++) {
    const result = await getBorrowLoans({ walletAddress: owner, pageSize: 20, pageAfter: cursor }, options.client)
    if (result.status !== 'available') throw new BorrowOperationError('Loan list unavailable.')
    loans.push(...result.data.items); cursor = result.data.nextPageAfter ?? undefined
    if (!cursor) break
  }
  if (cursor) throw new BorrowOperationError('The full loan list could not be verified.')
  return { wallet, quote, evidence: { session: borrowWalletSession(owner, wallet.chainId)!, market: { data: market.data, fetchedAt: stamp },
    position: position?.status === 'available' ? { data: position.data, fetchedAt: stamp } : null,
    verification: { marketId, result: verification, checkedAt: stamp }, loans: { data: { items: loans, complete: true }, fetchedAt: stamp },
    balances: { data: balances, fetchedAt: stamp }, targetHealthFactor: target } }
}
