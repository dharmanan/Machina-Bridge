import {
  MAINNET_BORROW_ADAPTER_CONTRACT,
  MAINNET_BORROW_CHAIN_ID,
  MAINNET_BORROW_DEFAULT_SLIPPAGE_BPS,
  MAINNET_BORROW_HIGH_UTILIZATION,
  MAINNET_BORROW_MAX_EVIDENCE_AGE_MS,
  MAINNET_BORROW_MAX_LTV,
  MAINNET_BORROW_MAX_COLLATERAL_BUFFER_BPS,
  MAINNET_BORROW_MAX_SLIPPAGE_BPS,
  MAINNET_BORROW_NATIVE_BACKED_TOKEN,
  MAINNET_BORROW_NATIVE_DECIMALS,
} from '../config/mainnetBorrow'
import type { MarketVerification, MarketVerificationReason } from './borrowMarketVerification'
import type { BorrowAmount, BorrowMarket, BorrowPosition, BorrowQuote } from './mainnetBorrow'

// Transaction safety for the Borrow writes (Stage 2). Pure and read only: no SDK, wallet, storage or network access. Every
// rule here runs in planBorrowWrite and again inside executeBorrowWrite, so the checks hold at the transaction boundary and
// not only in the UI that shows them.
//
// Rules this module never bends:
//  - missing, stale, mismatched or unreadable data is "unknown" and blocks; it is never a pass and never a zero;
//  - money is compared exactly, as integer token units, never as rounded display values;
//  - health factor and LTV are compared as the raw numbers the Borrow Service reported;
//  - the new-borrow limits (70% LTV, liquidity, selected health factor target) apply to Borrow and Borrow more only: a repay
//    or an added collateral reduces risk and is not blocked by them.

type Hex = `0x${string}`

const ADDRESS = /^0x[0-9a-fA-F]{40}$/
const BYTES32 = /^0x[0-9a-fA-F]{64}$/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const DECIMAL = /^\d+(\.\d+)?$/
const POSITIVE_DECIMAL = /^(?=.*[1-9])\d+(\.\d+)?$/

// Clock skew tolerated for a timestamp that appears to lie in the future.
const FUTURE_SKEW_MS = 5_000

// ---------------------------------------------------------------------------------------------------------------------
// Types

export type BorrowWalletCapability = 'supported' | 'unsupported' | 'unknown'

export type BorrowWriteAction =
  | { kind: 'borrow'; marketId: string; borrowAmount: string; slippageBps?: number }
  | { kind: 'borrow-more'; loanId: string; borrowAmount: string; slippageBps?: number }
  | { kind: 'repay'; loanId: string; repayAmount: string }
  | { kind: 'add-collateral'; loanId: string; collateralAmount: string }
  | { kind: 'withdraw-collateral'; loanId: string; collateralAmount: string; slippageBps?: number }
  | { kind: 'close-loan'; loanId: string; slippageBps?: number }

export type BorrowWalletState = {
  address?: string | null
  chainId?: number | null
  atomicBatch: BorrowWalletCapability
  // The wallet session (see borrowWalletSession) the atomicBatch answer was read for. An answer read for another address or
  // network is never used: switching wallet or network invalidates it.
  atomicBatchFor?: string | null
}

export type BorrowWriteBlocker =
  | 'writes_disabled'
  | 'wallet_missing'
  | 'wrong_chain'
  | 'wallet_capability_missing'
  | 'stale_wallet_session'
  | 'chain_address_mismatch'
  | 'invalid_action'
  | 'evidence_missing'
  | 'evidence_stale'
  | 'quote_missing'
  | 'quote_stale'
  | 'quote_request_mismatch'
  | 'quote_mismatch'
  | 'quote_token_mismatch'
  | 'slippage_invalid'
  | 'gas_unknown'
  | 'market_data_missing'
  | 'market_unverified'
  | 'oracle_unavailable'
  | 'insufficient_liquidity'
  | 'liquidity_unknown'
  | 'ltv_above_limit'
  | 'ltv_unknown'
  | 'health_target_not_met'
  | 'health_unknown'
  | 'position_missing'
  | 'position_not_owned'
  | 'position_not_active'
  | 'position_market_mismatch'
  | 'loan_exists'
  | 'loans_unknown'
  | 'repay_exceeds_debt'
  | 'residual_debt'
  | 'withdraw_exceeds_collateral'
  | 'withdraw_unhealthy'
  | 'balance_unknown'
  | 'insufficient_balance'
  | 'insufficient_gas_balance'
  | 'attempt_unresolved'
  | 'attempt_store_unreliable'
  | 'not_confirmed'
  | 'wallet_changed'
  | 'quote_changed'

// What the wallet would be asked to sign, in batch order. Every write is one atomic batch; approvals are exact and go to the
// Circle Borrow Adapter only.
export type BorrowWalletRequest =
  | 'allowance-reset-if-partial'
  | 'collateral-approval-if-short'
  | 'usdc-approval-if-short'
  | 'morpho-authorization-grant'
  | 'adapter-execution'
  | 'morpho-authorization-revoke'

// A Borrow Kit quote together with what it was asked for and when it was read. The Borrow Service quotes carry no expiry and
// no market ID, so Machina binds them to their request here and judges their age itself.
export type PreparedBorrowQuote = {
  quote: BorrowQuote
  fetchedAt: number
  request: {
    kind: BorrowWriteAction['kind']
    marketId: string | null
    loanId: string | null
    walletAddress: string | null
    // The amount asked for ('' for a close). Exactly the figure the write would send.
    amount: string
    // The slippage bound the quote was priced with; null for the two kinds that take none.
    slippageBps: number | null
  }
}

export type Stamped<T> = { data: T; fetchedAt: number }

export type BorrowWriteEvidence = {
  // borrowWalletSession of the wallet and network every read below was made for.
  session: string
  market: Stamped<BorrowMarket> | null
  verification: { marketId: string; result: MarketVerification; checkedAt: number } | null
  position: Stamped<BorrowPosition> | null
  loans: Stamped<{ items: BorrowPosition[]; complete: boolean }> | null
  balances: Stamped<{
    native: bigint | null
    loanToken: { address: string; raw: bigint | null }
    collateralToken: { address: string; raw: bigint | null }
  }> | null
  // The health factor the user selected, which a Borrow, Borrow more or Withdraw must still meet.
  targetHealthFactor: number | null
}

// 'interrupted': the page was closed or reloaded while the write was being sent, so whether it reached the chain is not known.
export type BorrowAttemptStatus = 'in-flight' | 'submitted' | 'interrupted' | 'failed' | 'confirmed'

export type BorrowAttemptRecord = {
  // One unresolved attempt per wallet, network and market or loan: a second write on the same target waits for the first,
  // whatever its amount, slippage or kind (see borrowAttemptScope).
  scopeId: string
  // The exact action that was attempted (amount and slippage included), for explaining it.
  actionId: string
  kind: BorrowWriteAction['kind']
  status: BorrowAttemptStatus
  idempotencyKey: string
  startedAt: number
  updatedAt: number
  batchId?: string
  txHash?: string
  errorCode?: string
}

// 'warn' is advisory: it is shown but never blocks. 'unknown' is data that is missing, stale or unreadable; it blocks, and the
// UI calls it Unavailable. 'fail' is a rule the transaction would break; the UI calls it Blocked.
export type WriteCheckStatus = 'pass' | 'warn' | 'fail' | 'unknown' | 'not-applicable'

export type WriteCheck = {
  id: string
  // The blocker this check reports when it fails or cannot be evaluated. Null for an advisory check.
  blocker: BorrowWriteBlocker | null
  status: WriteCheckStatus
  text: string
}

// Whether the attempt history can be trusted. It must be saved across reloads and readable: if it is not, an earlier send cannot
// be ruled out, so nothing is prepared.
export type AttemptLogHealth = {
  ok: boolean
  persistent: boolean
  reason: 'storage_unavailable' | 'records_unreadable' | 'storage_write_failed' | null
}

export type WriteSafetyInput = {
  action: BorrowWriteAction
  wallet: BorrowWalletState | null
  quote: PreparedBorrowQuote | null
  evidence: BorrowWriteEvidence | null
  attempts: readonly BorrowAttemptRecord[]
  // null: the history was not provided, which is treated as not trustworthy.
  attemptLog: AttemptLogHealth | null
  now: number
  // The SDK's own Arc definition: its chain ID and Borrow Adapter address.
  chain: { chainId: number | null; adapter: string | null }
}

export type WriteSafetyReport = {
  actionId: string
  scopeId: string
  owner: Hex | null
  walletRequests: BorrowWalletRequest[]
  checks: WriteCheck[]
  // Distinct blockers of every check that failed or could not be evaluated, in check order.
  blockers: BorrowWriteBlocker[]
}

// ---------------------------------------------------------------------------------------------------------------------
// Exact decimal arithmetic

// A plain decimal as integer token units, or null when it is malformed or finer than the token can hold (never rounded).
export function decimalToUnits(value: string, decimals: number): bigint | null {
  if (typeof value !== 'string' || !DECIMAL.test(value) || !Number.isInteger(decimals) || decimals < 0 || decimals > 36) return null
  const [whole, fraction = ''] = value.split('.')
  const trimmed = fraction.replace(/0+$/, '')
  if (trimmed.length > decimals) return null
  return BigInt(whole) * 10n ** BigInt(decimals) + BigInt(trimmed.padEnd(decimals, '0') || '0')
}

export function unitsToDecimal(units: bigint, decimals: number): string {
  const base = 10n ** BigInt(decimals)
  const fraction = (units % base).toString().padStart(decimals, '0').replace(/0+$/, '')
  return fraction ? `${units / base}.${fraction}` : `${units / base}`
}

const amountUnits = (amount: BorrowAmount | null): bigint | null => (amount ? decimalToUnits(amount.amount, amount.decimals) : null)

function sameDecimal(left: string, right: string) {
  const normalize = (value: string) => {
    const [whole, fraction = ''] = value.split('.')
    return `${whole.replace(/^0+(?=\d)/, '')}.${fraction.replace(/0+$/, '')}`
  }
  return DECIMAL.test(left) && DECIMAL.test(right) && normalize(left) === normalize(right)
}

const sameText = (left: string | null | undefined, right: string | null | undefined) =>
  typeof left === 'string' && typeof right === 'string' && left.toLowerCase() === right.toLowerCase()

// ---------------------------------------------------------------------------------------------------------------------
// Action facts

const isAddress = (value: unknown): value is string => typeof value === 'string' && ADDRESS.test(value)
const isMarketId = (value: unknown) => typeof value === 'string' && BYTES32.test(value)
const isLoanId = (value: unknown) => typeof value === 'string' && UUID.test(value)
const isAmount = (value: unknown) => typeof value === 'string' && POSITIVE_DECIMAL.test(value)
const isSlippage = (value: unknown) =>
  value === undefined || (typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 10_000)

export function borrowActionIsValid(action: BorrowWriteAction): boolean {
  switch (action.kind) {
    case 'borrow':
      return isMarketId(action.marketId) && isAmount(action.borrowAmount) && isSlippage(action.slippageBps)
    case 'borrow-more':
      return isLoanId(action.loanId) && isAmount(action.borrowAmount) && isSlippage(action.slippageBps)
    case 'repay':
      return isLoanId(action.loanId) && isAmount(action.repayAmount)
    case 'add-collateral':
      return isLoanId(action.loanId) && isAmount(action.collateralAmount)
    case 'withdraw-collateral':
      return isLoanId(action.loanId) && isAmount(action.collateralAmount) && isSlippage(action.slippageBps)
    case 'close-loan':
      return isLoanId(action.loanId) && isSlippage(action.slippageBps)
    default:
      return false
  }
}

// The amount the write would send ('' for a close, which sizes itself).
export function borrowActionAmount(action: BorrowWriteAction): string {
  switch (action.kind) {
    case 'borrow':
    case 'borrow-more':
      return action.borrowAmount
    case 'repay':
      return action.repayAmount
    case 'add-collateral':
    case 'withdraw-collateral':
      return action.collateralAmount
    case 'close-loan':
      return ''
  }
}

// The slippage bound the write would use. Null for the two kinds that take none. Omitted means the service default.
export function effectiveSlippageBps(action: BorrowWriteAction): number | null {
  switch (action.kind) {
    case 'repay':
    case 'add-collateral':
      return null
    default:
      return action.slippageBps ?? MAINNET_BORROW_DEFAULT_SLIPPAGE_BPS
  }
}

const WALLET_REQUESTS: Record<BorrowWriteAction['kind'], BorrowWalletRequest[]> = {
  'borrow': ['collateral-approval-if-short', 'morpho-authorization-grant', 'adapter-execution', 'morpho-authorization-revoke'],
  'borrow-more': ['collateral-approval-if-short', 'morpho-authorization-grant', 'adapter-execution', 'morpho-authorization-revoke'],
  'repay': ['usdc-approval-if-short', 'adapter-execution'],
  'add-collateral': ['allowance-reset-if-partial', 'collateral-approval-if-short', 'adapter-execution'],
  'withdraw-collateral': ['usdc-approval-if-short', 'morpho-authorization-grant', 'adapter-execution', 'morpho-authorization-revoke'],
  'close-loan': ['usdc-approval-if-short', 'morpho-authorization-grant', 'adapter-execution', 'morpho-authorization-revoke'],
}

export const BORROW_WALLET_REQUESTS = WALLET_REQUESTS

const QUOTE_KIND: Record<BorrowWriteAction['kind'], BorrowQuote['kind']> = {
  'borrow': 'borrow',
  'borrow-more': 'borrow',
  'repay': 'repay',
  'add-collateral': 'add-collateral',
  'withdraw-collateral': 'withdraw-collateral',
  'close-loan': 'close-loan',
}

function quoteMatches(action: BorrowWriteAction, quote: BorrowQuote) {
  if (quote.kind !== QUOTE_KIND[action.kind]) return false
  switch (action.kind) {
    case 'borrow':
    case 'borrow-more':
      return quote.kind === 'borrow' && sameDecimal(quote.loanAsset.amount, action.borrowAmount)
    case 'repay':
      return quote.kind === 'repay' && sameDecimal(quote.repayAmount.amount, action.repayAmount)
    case 'add-collateral':
      return quote.kind === 'add-collateral' && sameDecimal(quote.collateral.amount, action.collateralAmount)
    case 'withdraw-collateral':
      return quote.kind === 'withdraw-collateral' && sameDecimal(quote.collateral.amount, action.collateralAmount)
    case 'close-loan':
      return quote.kind === 'close-loan'
  }
}

// Wallet address plus network. Capability answers and every read are tied to it; a different wallet or network is a different
// session and nothing carries over.
export function borrowWalletSession(address: string | null | undefined, chainId: number | null | undefined): string | null {
  if (!isAddress(address) || typeof chainId !== 'number' || !Number.isInteger(chainId)) return null
  return `${address.toLowerCase()}@${chainId}`
}

export function borrowActionId(action: BorrowWriteAction, owner: string | null): string {
  if (!borrowActionIsValid(action)) return ''
  const target = action.kind === 'borrow' ? action.marketId : action.loanId
  const slippage = effectiveSlippageBps(action)
  return [action.kind, MAINNET_BORROW_CHAIN_ID, owner?.toLowerCase() ?? '', target.toLowerCase(), borrowActionAmount(action), slippage === null ? 'none' : String(slippage)].join('|')
}

// What an unresolved attempt blocks: any write on the same market (first borrow) or loan (everything else) for the same wallet and
// network, not only an identical one. A second borrow with another amount or buffer, or a repay while the first outcome is
// unknown, is no safer than the same one twice.
export function borrowAttemptScope(action: BorrowWriteAction, owner: string | null): string {
  if (!borrowActionIsValid(action) || !owner || !isAddress(owner)) return ''
  const target = action.kind === 'borrow' ? action.marketId : action.loanId
  return [MAINNET_BORROW_CHAIN_ID, owner.toLowerCase(), target.toLowerCase()].join('|')
}

// Plain words for an unresolved attempt: why nothing more is sent on this market or loan.
export function explainAttempt(record: BorrowAttemptRecord, sameAction: boolean, target: 'market' | 'loan'): string {
  const earlier = sameAction ? 'This action' : `An earlier ${record.kind} on this ${target}`
  switch (record.status) {
    case 'in-flight':
      return `${earlier} is already being sent from this page. Nothing else is sent on this ${target} meanwhile.`
    case 'interrupted':
      return `${earlier} was being sent when the page was closed or reloaded. Whether it reached the chain is not known, so nothing is sent on this ${target} until you have checked the loan and confirmed.`
    case 'submitted':
      return `${earlier} was submitted and its outcome is not known yet. Nothing is sent on this ${target} until it is settled, the position has been read again and you have confirmed.`
    case 'confirmed':
      return `${earlier} already went through. Read the position again and confirm before preparing another on this ${target}.`
    default:
      return `${earlier} failed and may still have reached the chain. Nothing is sent on this ${target} until the position has been read again and you have confirmed.`
  }
}

// Plain words for the state of the attempt history itself.
export function explainAttemptLog(log: AttemptLogHealth | null): string {
  if (log !== null && log.ok && log.persistent) return 'Attempts are recorded in this browser and survive a reload. They do not cover other devices or cleared browser data.'
  if (log === null) return 'The attempt history was not checked, so an earlier send cannot be ruled out.'
  if (!log.persistent) return 'The attempt history is not saved across reloads, so an earlier send cannot be ruled out after one.'
  if (log.reason === 'storage_unavailable') return "This browser's storage is not available, so an earlier send cannot be ruled out after a reload."
  if (log.reason === 'storage_write_failed') return "This browser's storage refused the last write, so the attempt history may be out of date."
  return 'The saved attempt history could not be read, so an earlier send cannot be ruled out. It is not cleared automatically.'
}

// Does this action add new debt? Only those are held to the new-borrow limits.
const addsDebt = (action: BorrowWriteAction) => action.kind === 'borrow' || action.kind === 'borrow-more'
const usesOracle = (action: BorrowWriteAction) => addsDebt(action) || action.kind === 'withdraw-collateral'

const ORACLE_REASONS: readonly MarketVerificationReason[] = ['oracle_missing', 'oracle_price_unavailable']

// ---------------------------------------------------------------------------------------------------------------------
// Evaluation

function totalGasWei(quote: BorrowQuote): bigint | null {
  if (!('gasFees' in quote) || quote.gasFees.length === 0) return null
  try {
    return quote.gasFees.reduce((sum, entry) => sum + BigInt(entry.feeWei), 0n)
  } catch {
    return null
  }
}

export function borrowQuoteGasWei(quote: BorrowQuote | null): bigint | null {
  return quote ? totalGasWei(quote) : null
}

export function evaluateBorrowWriteSafety(input: WriteSafetyInput): WriteSafetyReport {
  const { action, wallet, quote: prepared, evidence, attempts, attemptLog, now, chain } = input
  const checks: WriteCheck[] = []
  const add = (id: string, blocker: BorrowWriteBlocker | null, status: WriteCheckStatus, text: string) => { checks.push({ id, blocker, status, text }) }
  const ageOf = (at: number) => now - at
  const isFresh = (at: number) => Number.isFinite(at) && ageOf(at) <= MAINNET_BORROW_MAX_EVIDENCE_AGE_MS && ageOf(at) >= -FUTURE_SKEW_MS
  const ageText = (at: number) => (Number.isFinite(at) ? `${Math.max(0, Math.round(ageOf(at) / 1000))} s old` : 'of unknown age')
  const limitSeconds = MAINNET_BORROW_MAX_EVIDENCE_AGE_MS / 1000

  const valid = borrowActionIsValid(action)
  const owner = wallet?.address && isAddress(wallet.address) ? wallet.address as Hex : null
  const session = borrowWalletSession(owner, wallet?.chainId)

  // 1. Action.
  add('action', 'invalid_action', valid ? 'pass' : 'fail', valid ? 'The action and its amounts are well formed.' : 'The action, loan, market or amount is not valid.')

  // 2. Wallet, network, capability and session.
  add('wallet', 'wallet_missing', owner ? 'pass' : 'unknown', owner ? 'A wallet is connected.' : 'Connect a wallet.')
  // No network reported (no wallet) is missing data; a reported network that is not Arc is a block.
  add('network', 'wrong_chain', wallet?.chainId === MAINNET_BORROW_CHAIN_ID ? 'pass' : typeof wallet?.chainId === 'number' ? 'fail' : 'unknown',
    wallet?.chainId === MAINNET_BORROW_CHAIN_ID ? `The wallet is on Arc mainnet (chain ${MAINNET_BORROW_CHAIN_ID}).` : `The wallet must be on Arc mainnet (chain ${MAINNET_BORROW_CHAIN_ID}).`)
  const capability = wallet?.atomicBatch ?? 'unknown'
  add('wallet-capability', 'wallet_capability_missing', capability === 'supported' ? 'pass' : capability === 'unsupported' ? 'fail' : 'unknown',
    capability === 'supported' ? 'Atomic transactions supported: the wallet reports EIP-5792 atomic batch support on Arc.'
      : capability === 'unsupported' ? 'Not supported: this wallet does not report atomic batch support (EIP-5792) on Arc, so it cannot run a Borrow transaction. Machina does not fall back to separate approval and borrow transactions.'
        : 'Could not verify: the wallet did not give a usable answer about atomic batch support (EIP-5792) on Arc, so it is treated as not suitable.')
  const sessionOk = session !== null && wallet?.atomicBatchFor === session && (!evidence || evidence.session === session)
  if (owner && wallet?.chainId === MAINNET_BORROW_CHAIN_ID) {
    add('wallet-session', 'stale_wallet_session', sessionOk ? 'pass' : 'unknown',
      sessionOk ? 'The wallet capability and every read belong to this wallet and network.'
        : 'The wallet or network changed since the capability and reads were taken. Everything is read again for the current wallet.')
  }

  // 3. Addresses the transaction would touch: the SDK's own Arc definition must agree with the pinned adapter.
  const adapterOk = chain.chainId === MAINNET_BORROW_CHAIN_ID && isAddress(chain.adapter)
    && chain.adapter.toLowerCase() === MAINNET_BORROW_ADAPTER_CONTRACT.toLowerCase()
  add('chain-addresses', 'chain_address_mismatch', adapterOk ? 'pass' : chain.chainId === null || chain.adapter === null ? 'unknown' : 'fail',
    adapterOk ? `Approvals and the batch go to the Circle Borrow Adapter ${MAINNET_BORROW_ADAPTER_CONTRACT} on chain ${MAINNET_BORROW_CHAIN_ID} only.`
      : 'The Borrow Kit chain definition does not match the Arc chain and Borrow Adapter address Machina pins, so nothing would be approved or sent.')

  // 4. Slippage. For new debt it is the collateral buffer Circle adds to the collateral it sizes; elsewhere it only sets repayment headroom.
  const slippage = valid ? effectiveSlippageBps(action) : null
  const buffer = valid && (action.kind === 'borrow' || action.kind === 'borrow-more')
  const cap = buffer ? MAINNET_BORROW_MAX_COLLATERAL_BUFFER_BPS : MAINNET_BORROW_MAX_SLIPPAGE_BPS
  const name = buffer ? 'Collateral buffer' : 'Slippage bound'
  if (!valid || slippage === null) add('slippage', 'slippage_invalid', 'not-applicable', 'This action takes no slippage bound.')
  else if (slippage > cap) {
    add('slippage', 'slippage_invalid', 'fail', `${name} ${(slippage / 100).toFixed(2)}% is above the ${(cap / 100).toFixed(2)}% Machina allows.`)
  } else {
    const how = action.kind !== 'repay' && action.kind !== 'add-collateral' && action.slippageBps === undefined ? ' (service default)'
      : buffer ? " (Circle's slippage setting, which adds this much to the collateral it sizes)" : ''
    add('slippage', 'slippage_invalid', 'pass', `${name} ${(slippage / 100).toFixed(2)}%${how}.`)
  }

  // 5. Earlier attempts on the same market or loan are never repeated blindly, and the history that says so must be trustworthy.
  const actionId = borrowActionId(action, owner)
  const scopeId = borrowAttemptScope(action, owner)
  const previous = scopeId ? attempts.find((attempt) => attempt.scopeId === scopeId) : undefined
  const target = valid && action.kind === 'borrow' ? 'market' : 'loan'
  add('attempt', 'attempt_unresolved', previous ? 'fail' : 'pass',
    previous ? explainAttempt(previous, previous.actionId === actionId, target) : `No unresolved earlier attempt on this ${target} is recorded in this browser.`)
  const logOk = attemptLog !== null && attemptLog.ok && attemptLog.persistent
  add('attempt-log', 'attempt_store_unreliable', logOk ? 'pass' : 'unknown', explainAttemptLog(attemptLog))

  if (!evidence) {
    add('evidence', 'evidence_missing', 'unknown', 'The market, position and wallet reads this transaction depends on are not available.')
  }

  // 6. Quote: present, answering this request, fresh, consistent with the action.
  const quote = prepared?.quote ?? null
  if (!prepared || !quote) {
    add('quote', 'quote_missing', 'unknown', 'No quote is available for this action.')
  } else {
    const fresh = isFresh(prepared.fetchedAt)
    add('quote-fresh', 'quote_stale', fresh ? 'pass' : 'unknown',
      fresh ? `The quote is ${ageText(prepared.fetchedAt)}, within the ${limitSeconds} s Machina allows.` : `The quote is ${ageText(prepared.fetchedAt)}; it is only used for ${limitSeconds} s. Get a new quote.`)
    const req = prepared.request
    const wantsLoan = action.kind !== 'borrow'
    const requestOk = valid && req.kind === action.kind
      && (wantsLoan ? 'loanId' in action && sameText(req.loanId, action.loanId) : 'marketId' in action && sameText(req.marketId, action.marketId) && sameText(req.walletAddress, owner))
      && req.amount === borrowActionAmount(action)
      && req.slippageBps === effectiveSlippageBps(action)
    // Without a wallet the quote's wallet cannot be compared yet: that is missing data, not a mismatch.
    const walletPending = !requestOk && owner === null && valid && req.kind === action.kind && req.amount === borrowActionAmount(action) && req.slippageBps === effectiveSlippageBps(action)
    add('quote-request', 'quote_request_mismatch', requestOk ? 'pass' : walletPending ? 'unknown' : 'fail',
      requestOk ? 'The quote answers exactly this market or loan, wallet, amount and slippage.'
        : walletPending ? 'Connect a wallet to check that the quote was priced for it.' : 'The quote was priced for a different market, loan, wallet, amount or slippage than this action.')
    const matches = valid && quoteMatches(action, quote)
    add('quote-amounts', 'quote_mismatch', matches ? 'pass' : 'fail',
      matches ? 'The quoted amount equals the amount this action would send.' : 'The quote does not match this action: the kind or the amount differs.')
    const gas = totalGasWei(quote)
    add('gas', 'gas_unknown', gas !== null && gas > 0n ? 'pass' : 'unknown',
      gas !== null && gas > 0n ? 'The quote reports a gas estimate.' : 'The quote does not report a gas estimate, so the cost cannot be shown.')
  }

  if (!evidence || !valid) return finish()

  // 7. Position (loan actions).
  const needsPosition = action.kind !== 'borrow'
  let position: BorrowPosition | null = null
  if (needsPosition) {
    const stamped = evidence.position
    if (!stamped) add('position', 'position_missing', 'unknown', 'The loan has not been read, so it cannot be checked.')
    else if (!isFresh(stamped.fetchedAt)) add('position', 'evidence_stale', 'unknown', `The loan was read ${ageText(stamped.fetchedAt)}; it is only used for ${limitSeconds} s. Read it again.`)
    else if (!('loanId' in action) || !sameText(stamped.data.loanId, action.loanId)) add('position', 'position_missing', 'fail', 'The loan that was read is not the loan this action names.')
    else {
      position = stamped.data
      add('position', 'position_missing', 'pass', 'The loan was read for this action.')
      const ownedBy = owner !== null && sameText(position.owner, owner)
      add('position-owner', 'position_not_owned', ownedBy ? 'pass' : owner === null ? 'unknown' : 'fail',
        ownedBy ? 'The loan belongs to the connected wallet.' : owner === null ? 'Connect a wallet to check that the loan is yours.' : 'The loan does not belong to the connected wallet.')
      add('position-state', 'position_not_active', position.lifecycle === 'active' && position.economics === 'ready' ? 'pass' : position.lifecycle === 'closed' ? 'fail' : 'unknown',
        position.lifecycle === 'active' && position.economics === 'ready' ? 'The loan is active and its collateral and debt are indexed.'
          : position.lifecycle === 'closed' ? 'The loan is closed.'
            : position.lifecycle === 'unreported' ? 'The loan status is not reported.' : 'The loan exists but its collateral and debt are not indexed yet.')
    }
  }

  // 8. Market: the Circle read, bound to this action's market, and its on-chain verification.
  const marketId = action.kind === 'borrow' ? action.marketId : position?.marketId ?? null
  let market: BorrowMarket | null = null
  if (!marketId) {
    add('market', 'market_data_missing', 'unknown', 'The market is not known until the loan has been read.')
  } else {
    const stamped = evidence.market
    if (!stamped) add('market', 'market_data_missing', 'unknown', 'The market has not been read.')
    else if (!sameText(stamped.data.marketId, marketId)) {
      add('market', needsPosition ? 'position_market_mismatch' : 'market_data_missing', 'fail', 'The market that was read is not the market of this action.')
    }
    else if (!isFresh(stamped.fetchedAt)) add('market', 'evidence_stale', 'unknown', `The market was read ${ageText(stamped.fetchedAt)}; it is only used for ${limitSeconds} s. Read it again.`)
    else {
      market = stamped.data
      add('market', 'market_data_missing', 'pass', 'The market was read for this action.')
    }
  }

  let verified: Extract<MarketVerification, { status: 'verified' | 'unverified' }> | null = null
  if (marketId) {
    const check = evidence.verification
    if (!check) add('market-verified', 'market_unverified', 'unknown', 'The market has not been checked against Morpho on-chain yet.')
    else if (!sameText(check.marketId, marketId)) add('market-verified', 'market_unverified', 'fail', 'The on-chain check was made for a different market than this action.')
    else if (!isFresh(check.checkedAt)) add('market-verified', 'evidence_stale', 'unknown', `The on-chain market check is ${ageText(check.checkedAt)}; it is only used for ${limitSeconds} s. Check again.`)
    else if (check.result.status === 'checking') add('market-verified', 'market_unverified', 'unknown', 'The market is still being checked against Morpho on-chain.')
    else if (check.result.status === 'unavailable') add('market-verified', 'market_unverified', 'unknown', 'Morpho could not be read on-chain, so the market is not verified.')
    else {
      const result = check.result
      const identityReasons = result.status === 'unverified' ? result.reasons.filter((reason) => !ORACLE_REASONS.includes(reason)) : []
      const tokensMatch = !market || !result.details || (sameText(result.details.params.loanToken, market.loanAsset.address)
        && sameText(result.details.params.collateralToken, market.collateralAsset.address))
      if (identityReasons.length === 0 && tokensMatch) {
        verified = result
        add('market-verified', 'market_unverified', 'pass', 'The market ID, tokens and LLTV match Morpho on-chain.')
      } else add('market-verified', 'market_unverified', 'fail', 'The market does not match Morpho on-chain (ID, tokens, LLTV or rate model).')
    }
  }

  // 9. Oracle: only where the transaction depends on a price (new debt or a collateral withdrawal).
  if (!usesOracle(action)) add('oracle', 'oracle_unavailable', 'not-applicable', 'This action does not depend on the oracle price.')
  else if (!verified) add('oracle', 'oracle_unavailable', 'unknown', 'The oracle cannot be checked until the market is verified.')
  else if (verified.details && verified.details.oraclePrice) add('oracle', 'oracle_unavailable', 'pass', 'The market oracle returns a price.')
  else add('oracle', 'oracle_unavailable', 'fail', 'The market oracle has no readable price.')

  // 10. Quote tokens against the market's own tokens.
  if (quote) {
    if (!market) add('quote-tokens', 'quote_token_mismatch', 'unknown', 'The quote tokens cannot be compared until the market has been read.')
    else {
      // null: this kind has no such leg. A leg that is expected but absent (undefined) is a mismatch, never a pass.
      const sameAsset = (amount: BorrowAmount | null | undefined, asset: BorrowMarket['loanAsset']) =>
        amount === null || (amount !== undefined && sameText(amount.tokenAddress, asset.address) && amount.decimals === asset.decimals)
      const loanLeg = quote.kind === 'borrow' ? quote.loanAsset : quote.kind === 'repay' ? quote.repayAmount
        : quote.kind === 'close-loan' || quote.kind === 'withdraw-collateral' ? quote.maxRepayment : null
      const collateralLeg = quote.kind === 'borrow' || quote.kind === 'add-collateral' || quote.kind === 'close-loan' || quote.kind === 'withdraw-collateral'
        ? quote.collateral : null
      const tokensOk = sameAsset(loanLeg, market.loanAsset) && sameAsset(collateralLeg, market.collateralAsset)
        && sameAsset(quote.liquidationPrice ?? null, market.loanAsset)
      add('quote-tokens', 'quote_token_mismatch', tokensOk ? 'pass' : 'fail',
        tokensOk ? `The quote uses the market's own tokens (${market.collateralAsset.symbol} / ${market.loanAsset.symbol}).` : 'The quote uses a token that is not this market\'s loan or collateral token.')
    }
  }

  // 11. New debt only: liquidity, loan-to-value and the selected health factor target.
  if (addsDebt(action)) {
    add('liquidity', ...liquidityCheck(action, market, verified))
    // A market-wide rate risk, not a statement about the amount available.
    if (market && market.utilization !== null && market.utilization >= MAINNET_BORROW_HIGH_UTILIZATION) {
      add('utilization', null, 'warn', `High market utilization (${(market.utilization * 100).toFixed(1)}%): most supplied funds are already lent out, so the variable borrow rate can rise quickly. This flags rate risk, not the amount available.`)
    }
    if (quote?.kind === 'borrow') {
      add('ltv', ...ltvCheck(quote, market))
      add('health-target', ...targetCheck(quote.resultingHealthFactor, evidence.targetHealthFactor))
    } else {
      add('ltv', 'ltv_unknown', 'unknown', 'The loan-to-value cannot be checked without a matching quote.')
      add('health-target', 'health_unknown', 'unknown', 'The health factor cannot be compared with your target without a matching quote.')
    }
  } else {
    add('liquidity', 'insufficient_liquidity', 'not-applicable', 'Repaying or adding collateral does not draw on the market\'s liquidity.')
    add('ltv', 'ltv_above_limit', 'not-applicable', `The ${(MAINNET_BORROW_MAX_LTV * 100).toFixed(0)}% limit applies to new debt only. This action does not add debt.`)
  }

  // 12. Loan specific rules.
  if (action.kind === 'borrow') {
    const stamped = evidence.loans
    if (!stamped) add('loan-exists', 'loans_unknown', 'unknown', 'The wallet\'s loans have not been read, so an existing loan in this market cannot be ruled out.')
    else if (!isFresh(stamped.fetchedAt)) add('loan-exists', 'evidence_stale', 'unknown', `The wallet's loans were read ${ageText(stamped.fetchedAt)}; read them again.`)
    else {
      const existing = stamped.data.items.filter((loan) => sameText(loan.marketId, action.marketId) && loan.lifecycle !== 'closed')
      if (existing.length > 0) add('loan-exists', 'loan_exists', 'fail', 'The wallet already has a loan in this market. Borrow more on that loan instead of opening another.')
      else if (!stamped.data.complete) add('loan-exists', 'loans_unknown', 'unknown', 'Only part of the wallet\'s loans could be read, so an existing loan in this market cannot be ruled out.')
      else add('loan-exists', 'loan_exists', 'pass', 'The wallet has no loan in this market yet.')
    }
  }
  if (position && market) loanRules(action, quote, position, market)

  // 13. Balances: what leaves the wallet, plus gas, from a fresh read.
  balanceChecks(action, quote, market, evidence)

  return finish()

  // -------------------------------------------------------------------------------------------------------------------

  function finish(): WriteSafetyReport {
    return {
      actionId,
      scopeId,
      owner,
      walletRequests: valid ? WALLET_REQUESTS[action.kind] : [],
      checks,
      blockers: [...new Set(checks.flatMap((check) => ((check.status === 'fail' || check.status === 'unknown') && check.blocker ? [check.blocker] : [])))],
    }
  }

  function liquidityCheck(act: BorrowWriteAction, mkt: BorrowMarket | null, ver: typeof verified): [BorrowWriteBlocker, WriteCheckStatus, string] {
    if (!mkt || !('borrowAmount' in act)) return ['insufficient_liquidity', 'unknown', 'Liquidity cannot be checked until the market has been read.']
    const decimals = mkt.loanAsset.decimals
    const asked = decimalToUnits(act.borrowAmount, decimals)
    if (asked === null) return ['invalid_action', 'fail', `The borrow amount has more decimals than ${mkt.loanAsset.symbol} holds (${decimals}).`]
    const circle = mkt.liquidity ? amountUnits(mkt.liquidity) : null
    const onchain = ver?.details ? ver.details.liquidity : null
    // The lower of the two figures: a source that reports more never raises the other's limit.
    const known = [circle, onchain].filter((value): value is bigint => value !== null)
    if (known.length === 0) return ['liquidity_unknown', 'unknown', 'The market\'s available liquidity is not reported, so the borrow amount cannot be compared with it.']
    const available = known.reduce((lowest, value) => (value < lowest ? value : lowest))
    const symbol = mkt.loanAsset.symbol
    return asked <= available
      ? ['insufficient_liquidity', 'pass', `The borrow amount ${act.borrowAmount} ${symbol} is within the available liquidity ${unitsToDecimal(available, decimals)} ${symbol}.`]
      : ['insufficient_liquidity', 'fail', `Insufficient Liquidity: the borrow amount ${act.borrowAmount} ${symbol} is above the available ${unitsToDecimal(available, decimals)} ${symbol}.`]
  }

  function ltvCheck(q: Extract<BorrowQuote, { kind: 'borrow' }>, mkt: BorrowMarket | null): [BorrowWriteBlocker, WriteCheckStatus, string] {
    let ltv: number | null = q.resultingLtv
    let source = 'Borrow Kit quote'
    if (ltv === null && q.resultingHealthFactor !== null && q.resultingHealthFactor > 0 && mkt !== null && mkt.lltv !== null) {
      ltv = mkt.lltv / q.resultingHealthFactor
      source = 'derived: LLTV ÷ health factor'
    }
    if (ltv === null || !Number.isFinite(ltv)) return ['ltv_unknown', 'unknown', 'The quote reports no loan-to-value and no health factor, so the limit cannot be checked.']
    const limit = `${(MAINNET_BORROW_MAX_LTV * 100).toFixed(0)}%`
    const shown = `${(ltv * 100).toFixed(4).replace(/\.?0+$/, '')}%`
    // Raw comparison: 70.0001% is above the limit even though it displays as 70%.
    return ltv > MAINNET_BORROW_MAX_LTV
      ? ['ltv_above_limit', 'fail', `Loan-to-value ${shown} is above the ${limit} starting limit (${source}).`]
      : ['ltv_above_limit', 'pass', `Loan-to-value ${shown} is within the ${limit} starting limit (${source}). This is not a guarantee against liquidation.`]
  }

  function targetCheck(resulting: number | null, target: number | null): [BorrowWriteBlocker, WriteCheckStatus, string] {
    if (target === null || !Number.isFinite(target) || target <= 1) return ['health_unknown', 'unknown', 'No health factor target is selected.']
    if (resulting === null || !Number.isFinite(resulting)) return ['health_unknown', 'unknown', 'The quote does not report a health factor, so it cannot be compared with your target.']
    // Raw comparison: 1.499 does not meet 1.50 even though both display as 1.50.
    return resulting >= target
      ? ['health_target_not_met', 'pass', `The quote's health factor ${resulting} meets your ${target.toFixed(2)} target.`]
      : ['health_target_not_met', 'fail', `Selected safety target not met: the quote's health factor ${resulting} is below the ${target.toFixed(2)} you selected.`]
  }

  function loanRules(act: BorrowWriteAction, q: BorrowQuote | null, pos: BorrowPosition, mkt: BorrowMarket) {
    const loanDecimals = mkt.loanAsset.decimals
    const collateralDecimals = mkt.collateralAsset.decimals
    const debt = amountUnits(pos.borrowed)
    const held = amountUnits(pos.collateral)
    const loanSymbol = mkt.loanAsset.symbol
    const collateralSymbol = mkt.collateralAsset.symbol

    if (act.kind === 'repay') {
      const repay = decimalToUnits(act.repayAmount, loanDecimals)
      if (debt === null || repay === null) add('repay-debt', 'repay_exceeds_debt', 'unknown', 'The loan\'s debt is not reported, so the repayment cannot be compared with it.')
      else if (repay >= debt) {
        add('repay-debt', 'repay_exceeds_debt', 'fail', `The repayment ${act.repayAmount} ${loanSymbol} is not below the debt ${unitsToDecimal(debt, loanDecimals)} ${loanSymbol}. Interest keeps accruing, so a full repayment is made with Close loan, not Repay.`)
      } else add('repay-debt', 'repay_exceeds_debt', 'pass', `After this repayment ${unitsToDecimal(debt - repay, loanDecimals)} ${loanSymbol} of debt remains (plus interest that keeps accruing).`)
    }

    if (act.kind === 'close-loan') {
      const ceiling = q?.kind === 'close-loan' ? amountUnits(q.maxRepayment) : null
      if (debt === null || ceiling === null) add('close-debt', 'residual_debt', 'unknown', 'The debt or the repayment ceiling is not reported, so a full close cannot be confirmed.')
      else if (ceiling < debt) {
        add('close-debt', 'residual_debt', 'fail', `The repayment ceiling ${unitsToDecimal(ceiling, loanDecimals)} ${loanSymbol} is below the debt ${unitsToDecimal(debt, loanDecimals)} ${loanSymbol}, so debt would remain.`)
      } else add('close-debt', 'residual_debt', 'pass', `The repayment ceiling ${unitsToDecimal(ceiling, loanDecimals)} ${loanSymbol} covers the debt ${unitsToDecimal(debt, loanDecimals)} ${loanSymbol} and the interest and slippage headroom; unused headroom is returned.`)
      const returned = q?.kind === 'close-loan' ? amountUnits(q.collateral) : null
      add('close-collateral', 'quote_mismatch', held !== null && returned !== null && held === returned ? 'pass' : held === null || returned === null ? 'unknown' : 'fail',
        held !== null && returned !== null && held === returned ? `The quote returns all ${unitsToDecimal(held, collateralDecimals)} ${collateralSymbol} of collateral.`
          : held === null || returned === null ? 'The loan\'s collateral or the returned collateral is not reported.' : 'The collateral the quote returns differs from the loan\'s collateral.')
    }

    if (act.kind === 'withdraw-collateral') {
      const asked = decimalToUnits(act.collateralAmount, collateralDecimals)
      if (asked === null || held === null) add('withdraw-collateral', 'withdraw_exceeds_collateral', 'unknown', 'The loan\'s collateral is not reported, so the withdrawal cannot be compared with it.')
      else if (asked > held) add('withdraw-collateral', 'withdraw_exceeds_collateral', 'fail', `The withdrawal ${act.collateralAmount} ${collateralSymbol} is above the loan's collateral ${unitsToDecimal(held, collateralDecimals)} ${collateralSymbol}.`)
      else add('withdraw-collateral', 'withdraw_exceeds_collateral', 'pass', `The withdrawal is within the loan's collateral ${unitsToDecimal(held, collateralDecimals)} ${collateralSymbol}.`)
      if (q?.kind === 'withdraw-collateral') {
        const repays = amountUnits(q.maxRepayment)
        const noDebtLeft = debt !== null && debt === 0n && repays === 0n
        if (noDebtLeft && q.resultingHealthFactor === null) {
          add('withdraw-health', 'withdraw_unhealthy', 'pass', 'The loan has no debt, so the withdrawal cannot bring it near liquidation.')
        } else {
          const [, status, text] = targetCheck(q.resultingHealthFactor, evidence?.targetHealthFactor ?? null)
          add('withdraw-health', status === 'fail' ? 'withdraw_unhealthy' : 'health_unknown', status,
            status === 'fail' ? `The withdrawal would leave the loan at health factor ${q.resultingHealthFactor}, below the ${(evidence?.targetHealthFactor ?? 0).toFixed(2)} you selected and too close to liquidation.` : text)
        }
      }
    }
  }

  function balanceChecks(act: BorrowWriteAction, q: BorrowQuote | null, mkt: BorrowMarket | null, ev: BorrowWriteEvidence) {
    if (!q || !mkt) {
      add('balance', 'balance_unknown', 'unknown', 'Wallet balances cannot be compared until the quote and the market are known.')
      return
    }
    const stamped = ev.balances
    if (!stamped) { add('balance', 'balance_unknown', 'unknown', 'The wallet balances have not been read.'); return }
    if (!isFresh(stamped.fetchedAt)) { add('balance', 'evidence_stale', 'unknown', `The wallet balances were read ${ageText(stamped.fetchedAt)}; read them again.`); return }
    const { native, loanToken, collateralToken } = stamped.data
    if (!sameText(loanToken.address, mkt.loanAsset.address) || !sameText(collateralToken.address, mkt.collateralAsset.address)) {
      add('balance', 'balance_unknown', 'fail', 'The balances that were read are for different tokens than this market\'s loan and collateral tokens.')
      return
    }
    // What the batch pulls from the wallet: loan token for repayments, collateral token for collateral supplied.
    const loanNeeded = q.kind === 'repay' ? amountUnits(q.repayAmount) : q.kind === 'close-loan' || q.kind === 'withdraw-collateral' ? amountUnits(q.maxRepayment) : 0n
    const collateralNeeded = q.kind === 'borrow' || q.kind === 'add-collateral' ? amountUnits(q.collateral) : 0n
    if (loanNeeded === null || collateralNeeded === null) { add('balance', 'balance_unknown', 'unknown', 'The amounts the quote would take from the wallet are not exact.'); return }
    const missing = (raw: bigint | null) => raw === null
    if ((loanNeeded > 0n && missing(loanToken.raw)) || (collateralNeeded > 0n && missing(collateralToken.raw))) {
      add('balance', 'balance_unknown', 'unknown', 'A token balance of the wallet could not be read.')
      return
    }
    const enoughLoan = loanNeeded === 0n || (loanToken.raw as bigint) >= loanNeeded
    const enoughCollateral = collateralNeeded === 0n || (collateralToken.raw as bigint) >= collateralNeeded
    if (!enoughLoan || !enoughCollateral) {
      const [needed, have, symbol, decimals] = !enoughLoan
        ? [loanNeeded, loanToken.raw as bigint, mkt.loanAsset.symbol, mkt.loanAsset.decimals]
        : [collateralNeeded, collateralToken.raw as bigint, mkt.collateralAsset.symbol, mkt.collateralAsset.decimals]
      add('balance', 'insufficient_balance', 'fail', `The wallet holds ${unitsToDecimal(have, decimals)} ${symbol}; this action takes up to ${unitsToDecimal(needed, decimals)} ${symbol}.`)
    } else add('balance', 'insufficient_balance', 'pass', 'The wallet holds the tokens this action takes.')

    const gas = totalGasWei(q)
    if (gas === null) return
    if (native === null) { add('gas-balance', 'balance_unknown', 'unknown', 'The wallet\'s native balance could not be read, so gas cannot be covered.'); return }
    // USDC is both Arc's gas currency and the usual loan token: when the batch pulls USDC, the native balance must cover both.
    const nativeScale = 10n ** BigInt(Math.max(0, MAINNET_BORROW_NATIVE_DECIMALS - mkt.loanAsset.decimals))
    const alsoPaidInNative = loanNeeded > 0n && sameText(mkt.loanAsset.address, MAINNET_BORROW_NATIVE_BACKED_TOKEN)
    const needed = gas + (alsoPaidInNative ? loanNeeded * nativeScale : 0n)
    add('gas-balance', 'insufficient_gas_balance', native >= needed ? 'pass' : 'fail',
      native >= needed ? 'The wallet covers the estimated gas.' : `The wallet holds ${unitsToDecimal(native, MAINNET_BORROW_NATIVE_DECIMALS)} of the native gas currency; gas${alsoPaidInNative ? ' and the repayment, both paid in USDC,' : ''} needs ${unitsToDecimal(needed, MAINNET_BORROW_NATIVE_DECIMALS)}.`)
  }
}

// Rule violations first, then data that is unavailable, then warnings, passes and what does not apply. Stable within a group.
export function orderWriteChecks(checks: readonly WriteCheck[]): WriteCheck[] {
  const rank = (check: WriteCheck) => (check.status === 'fail' ? 0 : check.status === 'unknown' ? 1 : check.status === 'warn' ? 2 : check.status === 'pass' ? 3 : 4)
  return checks.map((check, index) => ({ check, index })).sort((a, b) => rank(a.check) - rank(b.check) || a.index - b.index).map(({ check }) => check)
}

// Raw comparison against the selected target; null when either side is missing. Display rounding never decides it.
export function healthTargetMet(resulting: number | null, target: number | null): boolean | null {
  if (resulting === null || target === null || !Number.isFinite(resulting) || !Number.isFinite(target)) return null
  return resulting >= target
}

// ---------------------------------------------------------------------------------------------------------------------
// Readiness for review

// What the Transaction Readiness line says. "Ready for review" means every safety check passes for a transaction that could be
// reviewed. It never means a transaction can be sent: the write gate is a separate, closed switch (planBorrowWrite).
export type BorrowReadiness = 'ready' | 'blocked' | 'unavailable'

export function borrowReadiness(checks: readonly WriteCheck[]): { status: BorrowReadiness; reason: string | null; reasonId: string | null; failed: number; unavailable: number; warnings: number } {
  const failed = checks.filter((check) => check.status === 'fail')
  const unavailable = checks.filter((check) => check.status === 'unknown')
  const warnings = checks.filter((check) => check.status === 'warn').length
  const status: BorrowReadiness = failed.length > 0 ? 'blocked' : unavailable.length > 0 ? 'unavailable' : 'ready'
  const first = failed[0] ?? unavailable[0] ?? null
  return { status, reason: first?.text ?? null, reasonId: first?.id ?? null, failed: failed.length, unavailable: unavailable.length, warnings }
}

// ---------------------------------------------------------------------------------------------------------------------
// A quote that changed after it was reviewed

export type QuoteChange = 'request' | 'amounts' | 'health-factor' | 'ltv'

function fundAmounts(quote: BorrowQuote): (BorrowAmount | null)[] {
  switch (quote.kind) {
    case 'borrow':
      return [quote.collateral, quote.loanAsset]
    case 'repay':
      return [quote.repayAmount]
    case 'add-collateral':
      return [quote.collateral]
    case 'withdraw-collateral':
    case 'close-loan':
      return [quote.collateral, quote.maxRepayment]
    default:
      return []
  }
}

// Compares a fresh quote with the one the user reviewed. A write may only go ahead on a fresh quote that asks the same thing,
// moves exactly the same amounts and leaves the position no riskier. Gas and fees may drift and are shown again, not compared.
export function borrowQuoteChange(reviewed: PreparedBorrowQuote, fresh: PreparedBorrowQuote): QuoteChange | null {
  const a = reviewed.request
  const b = fresh.request
  if (a.kind !== b.kind || !sameText(a.marketId ?? '', b.marketId ?? '') || !sameText(a.loanId ?? '', b.loanId ?? '')
    || !sameText(a.walletAddress ?? '', b.walletAddress ?? '') || a.amount !== b.amount || a.slippageBps !== b.slippageBps) return 'request'
  if (reviewed.quote.kind !== fresh.quote.kind) return 'request'
  const before = fundAmounts(reviewed.quote)
  const after = fundAmounts(fresh.quote)
  if (before.length !== after.length) return 'amounts'
  for (let index = 0; index < before.length; index += 1) {
    const x = before[index]
    const y = after[index]
    if (x === null || y === null) { if (x !== y) return 'amounts'; continue }
    if (!sameText(x.tokenAddress, y.tokenAddress) || x.decimals !== y.decimals || amountUnits(x) === null || amountUnits(x) !== amountUnits(y)) return 'amounts'
  }
  const hf0 = reviewed.quote.resultingHealthFactor
  const hf1 = fresh.quote.resultingHealthFactor
  if (hf0 !== null && (hf1 === null || hf1 < hf0)) return 'health-factor'
  const ltv0 = 'resultingLtv' in reviewed.quote ? reviewed.quote.resultingLtv : null
  const ltv1 = 'resultingLtv' in fresh.quote ? fresh.quote.resultingLtv : null
  if (ltv0 !== null && (ltv1 === null || ltv1 > ltv0)) return 'ltv'
  return null
}

// ---------------------------------------------------------------------------------------------------------------------
// Plain wording

export const WRITE_BLOCKER_TEXT: Record<BorrowWriteBlocker, string> = {
  writes_disabled: 'Real Borrow transactions are switched off in this release.',
  wallet_missing: 'No wallet is connected.',
  wrong_chain: 'The wallet is not on Arc mainnet.',
  wallet_capability_missing: 'The wallet does not report atomic batch support (EIP-5792) on Arc.',
  stale_wallet_session: 'The wallet or network changed; everything is read again.',
  chain_address_mismatch: 'The chain or Borrow Adapter address does not match what Machina pins.',
  invalid_action: 'The action or its amount is not valid.',
  evidence_missing: 'Required reads are not available.',
  evidence_stale: 'A read is too old to use.',
  quote_missing: 'There is no quote yet.',
  quote_stale: 'The quote is too old.',
  quote_request_mismatch: 'The quote was priced for a different request.',
  quote_mismatch: 'The quote does not match the action.',
  quote_token_mismatch: 'The quote uses tokens that are not the market\'s.',
  slippage_invalid: 'The slippage bound is above what Machina allows.',
  gas_unknown: 'No gas estimate is reported.',
  market_data_missing: 'The market data is missing or does not match.',
  market_unverified: 'The market is not verified against Morpho on-chain.',
  oracle_unavailable: 'The oracle price is not readable.',
  insufficient_liquidity: 'The market does not have enough liquidity.',
  liquidity_unknown: 'The market liquidity is not reported.',
  ltv_above_limit: `The loan-to-value is above the ${(MAINNET_BORROW_MAX_LTV * 100).toFixed(0)}% limit.`,
  ltv_unknown: 'The loan-to-value cannot be checked.',
  health_target_not_met: 'Selected safety target not met.',
  health_unknown: 'The health factor cannot be compared with your target.',
  position_missing: 'The loan has not been read.',
  position_not_owned: 'The loan does not belong to this wallet.',
  position_not_active: 'The loan is not active or not indexed yet.',
  position_market_mismatch: 'The loan is in a different market.',
  loan_exists: 'The wallet already has a loan in this market.',
  loans_unknown: 'The wallet\'s loans could not be fully read.',
  repay_exceeds_debt: 'The repayment is not below the debt; use Close loan.',
  residual_debt: 'Debt would remain after closing.',
  withdraw_exceeds_collateral: 'The withdrawal is above the loan\'s collateral.',
  withdraw_unhealthy: 'The withdrawal would leave the loan too close to liquidation.',
  balance_unknown: 'The wallet balance is not known.',
  insufficient_balance: 'The wallet does not hold enough tokens.',
  insufficient_gas_balance: 'The wallet does not hold enough for gas.',
  attempt_unresolved: 'An earlier attempt on this market or loan is unresolved.',
  attempt_store_unreliable: 'The attempt history cannot be trusted, so an earlier send cannot be ruled out.',
  not_confirmed: 'The action was not confirmed by the user.',
  wallet_changed: 'The wallet that would sign is not the wallet this action was prepared for.',
  quote_changed: 'The quote changed after it was reviewed.',
}

// ---------------------------------------------------------------------------------------------------------------------
// What the transaction would do, for the read-only preview

export type BorrowMovement = {
  direction: 'out' | 'in'
  label: string
  amount: BorrowAmount
  // A ceiling the batch may pull, not the amount that will be paid.
  ceiling?: boolean
  note?: string
}

export type BorrowWriteDescription = {
  title: string
  movements: BorrowMovement[]
  fees: { type: string; amount: BorrowAmount }[]
  gasWei: bigint | null
  slippageBps: number | null
}

export function describeBorrowWrite(action: BorrowWriteAction, quote: BorrowQuote | null): BorrowWriteDescription {
  const titles: Record<BorrowWriteAction['kind'], string> = {
    'borrow': 'Borrow', 'borrow-more': 'Borrow more', 'repay': 'Repay', 'add-collateral': 'Add collateral',
    'withdraw-collateral': 'Withdraw collateral', 'close-loan': 'Close loan',
  }
  const movements: BorrowMovement[] = []
  if (quote?.kind === 'borrow') {
    movements.push({ direction: 'out', label: 'Collateral you supply', amount: quote.collateral })
    movements.push({ direction: 'in', label: 'Loan you receive', amount: quote.loanAsset })
  } else if (quote?.kind === 'repay') {
    movements.push({ direction: 'out', label: 'Repayment', amount: quote.repayAmount })
  } else if (quote?.kind === 'add-collateral') {
    movements.push({ direction: 'out', label: 'Collateral you add', amount: quote.collateral })
  } else if (quote?.kind === 'withdraw-collateral') {
    movements.push({ direction: 'in', label: 'Collateral released to you', amount: quote.collateral })
    if (amountUnits(quote.maxRepayment) !== 0n) {
      movements.push({ direction: 'out', label: 'Repayment, up to', amount: quote.maxRepayment, ceiling: true, note: 'Sized by the service to keep the loan healthy; unused headroom is returned.' })
    }
  } else if (quote?.kind === 'close-loan') {
    movements.push({ direction: 'out', label: 'Repayment, up to', amount: quote.maxRepayment, ceiling: true, note: 'A ceiling, not an invoice: interest and slippage headroom is included and unused headroom is returned.' })
    movements.push({ direction: 'in', label: 'Collateral returned', amount: quote.collateral })
  }
  return {
    title: titles[action.kind],
    movements,
    fees: quote && 'fees' in quote ? quote.fees : [],
    gasWei: totalGasWei0(quote),
    slippageBps: effectiveSlippageBps(action),
  }
}

function totalGasWei0(quote: BorrowQuote | null): bigint | null {
  return quote ? totalGasWei(quote) : null
}
