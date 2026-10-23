import { WalletRpcFailure, walletRpcRead, walletRpcQuantity, walletRpcMessage } from './uniswapArcWalletRpc'
import { decodeFunctionData, encodeFunctionData, keccak256, toHex, type Hex } from 'viem'
import { ARC_ROUTER, EXECUTE_ABI, UNISWAP_ARC_WRITES_ENABLED, requestKey, sameAddress, uint, validateArcRequest, type ArcRequest, type ArcReview } from './uniswapArcPolicy'
import { reviewValue, validateReview } from './swap/swapPolicy'
import type { ChainSummary, IntentSummary, IntentVerdict } from './swap/transactionEvidence'
import { archiveRecord, archiveUnreadable, readArchive } from './swap/journalArchive'

export interface ExecutionContext { owner: string; connected: boolean; chainId: number; connectorId: string }
export interface ExecutionProvider { request(args: { method: string; params?: unknown[] }): Promise<unknown> }
// confirmed : the chain says success AND the transaction matches the Review the user approved
// mismatch  : the chain says success but the transaction is not what was reviewed (never shown as Confirmed)
// failed    : the chain says the transaction reverted
// unknown   : the outcome could not be determined (RPC trouble, or a hash that does not identify the attempt)
export type AttemptStatus = 'awaiting_wallet' | 'pending' | 'confirmed' | 'failed' | 'rejected' | 'unknown' | 'mismatch'
// Append-only record of how an attempt's status changed. Original Review data is never rewritten.
export interface StatusLogEntry { at: number; status: AttemptStatus; note: string }
export interface SwapAttempt {
  id: string; review: ArcReview; nonce: number; status: AttemptStatus; createdAt: number; hash?: Hex; output?: string; fee?: string
  // Chain facts and the Review comparison are stored separately: a chain success never implies Review verification.
  // Signed calldata commitment only; the PermitSingle signature itself is never persisted.
  submittedCalldataHash?: Hex
  chain?: ChainSummary; intent?: IntentSummary; log?: StatusLogEntry[]
}
export interface ExecutionView {
  phase: 'idle' | 'preparing' | 'review' | 'checking' | AttemptStatus
  allowanceNotice?: string
  approvalId?: string; review?: ArcReview; attempt?: SwapAttempt; error?: string; walletWindowMs?: number; walletRequestOpen?: boolean
  // A status lookup in progress. The status already known stays visible; only this flag changes.
  checking?: boolean
  // When the next automatic lookup is due, or null when none will run (terminal or deterministic result).
  nextCheckMs?: number | null
  // The last time the chain was actually read for this attempt (not a stored value).
  observedAt?: number
  // The recorded hash is unknown to the network and its nonce was used by another transaction: the replacement's hash can be supplied.
  replaced?: boolean
}
// Raised when the evidence cannot be trusted or does not identify the attempt. `retryable` false = repeating cannot change it.
export class ExecutionVerificationError extends Error {
  constructor(readonly reason: 'binding' | 'malformed' | 'rpc', readonly retryable: boolean) { super('verification') }
}
export type ChainResult =
  // identified: the node knows this exact transaction and it is bound to the attempt (sender, nonce, chain). A hash the node has never
  // seen is not identified. nonceUsed: that hash is unknown AND the account's nonce was already used by another transaction, so the
  // recorded transaction can never execute any more (a wallet speed-up or cancel replaced it, or it was dropped and the nonce reused).
  | { status: 'pending'; identified?: boolean; nonceUsed?: boolean }
  | { status: 'confirmed' | 'failed'; output: string; fee: string }
  // Full verification: chain facts plus the Review comparison.
  | { status: 'settled'; chain: ChainSummary; intent: IntentSummary; output: string; fee: string }
export const isIntentVerified = (verdict: IntentVerdict) => verdict === 'verified' || verdict === 'verified_with_notes'
export interface ExecutionNonceState { nonce: number; latestNonce: number }
export class ExecutionNonceObservationError extends Error {
  constructor(source: 'public' | 'wallet', readonly highestObserved: number, readonly reason?: 'latest-changed' | 'pending-behind-latest') { super(`${source}_nonce`) }
}
class NonceRpcConflict extends Error {
  constructor(readonly publicState: ExecutionNonceState, readonly walletState: ExecutionNonceState) { super('nonce_rpc') }
}
export interface ExecutionPorts {
  context(): ExecutionContext; input(): ArcRequest | null
  fresh(input: ArcRequest): Promise<ArcReview>; quoteNow(input: ArcRequest): number
  preflight(review: ArcReview, signedData?: Hex): Promise<ExecutionNonceState & { allowanceNotice?: string }>
  signPermit?(review: ArcReview, provider: ExecutionProvider): Promise<Hex>
  provider(): Promise<ExecutionProvider>
  result(attempt: SwapAttempt, submitted?: (intent: IntentSummary) => void): Promise<ChainResult>
  storage: Pick<Storage, 'getItem' | 'setItem'>
  lock<T>(owner: string, run: () => Promise<T>): Promise<T>
  changed?(view: ExecutionView): void; settled?(attempt: SwapAttempt): void
  // Production supplies the pilot restriction. Missing authorization fails closed.
  authorize?(input: ArcRequest | null, context: ExecutionContext): boolean
  // Trusted test seam only. Production uses the source gate AND mandatory pilot authorization.
  enabled?(): boolean
}
export const ARC_EXECUTION_EXPLORER = 'https://explorer.arc.io/tx/'
// Quote freshness authorizes opening a wallet request; it is not the on-chain deadline.
export const EXECUTION_DEADLINE_WINDOW_MS = 120000
export const EXECUTION_MINING_BUFFER_MS = 15000
const MIN_WALLET_WINDOW_MS = 30000
export const executionDeadlineMs = (review: ArcReview) => Number(decodeFunctionData({ abi: EXECUTE_ABI, data: review.transaction.data }).args[2]) * 1000
export const isTransactionHash = (hash: unknown): hash is Hex => typeof hash === 'string' && /^0x[a-fA-F0-9]{64}$/.test(hash)
const isNonce = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0
const unresolved = (a: SwapAttempt) => ['awaiting_wallet', 'pending', 'unknown'].includes(a.status)
const storageKey = (owner: string) => `machina.uniswap.arc.execution.v1:${owner.toLowerCase()}`
const archiveKey = (owner: string) => `machina.uniswap.arc.execution.archive.v1:${owner.toLowerCase()}`
const stop = (code: string): never => { throw new Error(code) }
// Automatic status lookups: a pending transaction is polled at a steady pace; a transient read failure backs off and eventually
// stops. A deterministic result (terminal chain state, or a hash that cannot identify the attempt) is never retried automatically.
export const PENDING_CHECK_MS = 5000
export const TRANSIENT_CHECK_DELAYS_MS = [5000, 10000, 20000, 40000, 60000]
export const MAX_AUTOMATIC_CHECK_FAILURES = 8
const TERMINAL: AttemptStatus[] = ['confirmed', 'failed', 'mismatch']
export function executionMessage(code: string): string {
  const messages: Record<string, string> = {
    writes_disabled: 'Real Uniswap swaps are disabled pending independent review and release approval.',
    pilot_restricted: 'Execution is restricted to the configured pilot wallet on Arc Mainnet: USDC to EURC, at most 0.1 USDC. Live previews remain available.',
    context: 'The wallet, network, provider or swap inputs changed. Review a fresh swap.',
    expired: 'This swap review expired. Review a fresh swap before confirming.',
    busy: 'An earlier wallet request or transaction is unresolved. Check its status before retrying.',
    lock: 'Another tab is handling this wallet, or safe browser locking is unavailable.',
    storage: 'Safe transaction recording is unavailable. No new transaction can be requested.',
    nonce: 'The account nonce changed since Review. Check recent transactions before creating a fresh review. No transaction was requested.',
    nonce_rpc: 'Public Arc RPC and wallet RPC disagree about the account nonce. A pending transaction or stale RPC may be involved. No transaction was requested. Check the wallet’s Arc RPC and transaction activity; repeating Review alone will not resolve this.',
    nonce_pending: 'RPC reports another pending transaction for this account. Wait for it to resolve and check its status before trying again. No replacement or new transaction was requested.',
    nonce_regression: 'RPC nonce observations moved backwards during verification. Account state cannot be safely reconciled. No transaction was requested. Wait for consistent RPC state before retrying.',
    public_nonce: 'Public Arc RPC could not provide a valid, stable latest/pending nonce. No transaction was requested. Check RPC availability and recent account activity.',
    wallet_nonce: 'The wallet RPC could not provide a valid, stable latest/pending nonce. No transaction was requested. Check the wallet’s Arc network and RPC connection.',
    rejected: 'You rejected the wallet request. No automatic retry will occur.',
    unknown: 'Submission or confirmation is not yet verified. This does not mean failure. Check your wallet or Arc Explorer; do not submit again.',
    wallet_timeout: 'The wallet approval window ended. Cancel the open request in your wallet; do not approve or submit again. The app cannot cancel it. A late approval or delayed inclusion may revert and still charge gas. Any returned hash will still be tracked.',
    verification: 'The chain could not be read just now (network or RPC trouble). This does not mean the transaction failed or succeeded. The app checks again automatically with growing pauses; you can also check manually. Do not submit another swap.',
    verification_binding: 'This transaction hash does not identify the reviewed swap (its sender, nonce, network or hash differ), so it is not counted as this swap. Check it on Arc Explorer. No further automatic checks will run, and no new swap can start while this attempt is unresolved.',
    verification_stopped: 'Automatic checks stopped after repeated read failures. This does not mean the transaction failed. Use Check transaction status to try again; do not submit another swap.',
    recovery_unknown: 'The network does not know that hash (yet), so it was not saved and nothing was changed. Check the hash in your wallet or on Arc Explorer, then paste it again.',
    replaced: 'The recorded transaction is not known to the network, and its nonce was used by another transaction (for example a wallet speed-up or cancel). Paste the hash your wallet shows for the replacement; it is accepted only if it is the swap you reviewed.',
    mismatch: 'The blockchain transaction succeeded, but it is not the transaction you reviewed, so it is not marked Confirmed. The differences are listed below.',
    smart_wallet: 'This execution flow supports EOAs only. Contract and delegated wallets remain blocked.',
    allowance_missing: 'The exact approvals this swap needs are not in place (or have expired). Approve the exact amount first; each approval is its own wallet confirmation. No swap was requested.',
    insufficient_input_balance: 'The wallet does not hold enough of the input token for this swap. No wallet request was started.',
    preflight: 'The current balance, fees, contract identity or simulation could not be verified. No wallet request was started.',
    confirmation: 'The transaction is still being checked. RPC errors and timeouts do not mean it failed.',
  }
  return messages[code] ?? messages.preflight
}

// Only the deadline is tightened. Commands, inputs, attribution suffix, value and economic floors are unchanged.
export function tightenExecutionReview(source: ArcReview, context: ExecutionContext, now: number): ArcReview {
  validateReview(source, context, now)
  const review = structuredClone(source)
  const outer = decodeFunctionData({ abi: EXECUTE_ABI, data: review.transaction.data })
  const canonical = encodeFunctionData({ abi: EXECUTE_ABI, functionName: 'execute', args: outer.args })
  const deadline = BigInt(Math.floor((review.requestStartedAt + EXECUTION_DEADLINE_WINDOW_MS) / 1000))
  const shorter = deadline < outer.args[2] ? deadline : outer.args[2]
  review.transaction.data = (encodeFunctionData({ abi: EXECUTE_ABI, functionName: 'execute', args: [outer.args[0], outer.args[1], shorter] }) + review.transaction.data.slice(canonical.length)) as Hex
  validateReview(review, context, now)
  return review
}
export function executionTransaction(review: ArcReview, nonce: number) {
  if (!isNonce(nonce)) return stop('nonce')
  return Object.freeze({ chainId: toHex(5042), from: review.request.owner, to: ARC_ROUTER, data: review.transaction.data,
    value: toHex(reviewValue(review)), gas: toHex(uint(review.gasLimit)), nonce: toHex(nonce),
    type: '0x2', maxFeePerGas: toHex(uint(review.maxFeePerGas)), maxPriorityFeePerGas: toHex(uint(review.maxPriorityFeePerGas)) })
}
const ATTEMPT_STATUSES = ['awaiting_wallet', 'pending', 'confirmed', 'failed', 'rejected', 'unknown', 'mismatch']
const INTENT_VERDICTS = ['verified', 'verified_with_notes', 'mismatch', 'incomplete', 'unbound', 'no_review']
const INTENT_STATUSES = ['match', 'allowed', 'mismatch', 'unavailable']
const decimalText = (v: unknown): v is string => typeof v === 'string' && /^\d{1,78}$/.test(v)
const boundedText = (v: unknown, max: number): v is string => typeof v === 'string' && v.length <= max
function validateChain(c: unknown) {
  const v = c as Record<string, unknown> | null
  if (!v || typeof v !== 'object' || Object.keys(v).some(k => !['state', 'blockNumber', 'blockHash', 'gasUsed', 'effectiveGasPrice', 'fee', 'received', 'sent', 'checkedAt'].includes(k)) ||
    !['success', 'reverted'].includes(v.state as string) || !decimalText(v.blockNumber) || typeof v.blockHash !== 'string' || !/^0x[a-fA-F0-9]{64}$/.test(v.blockHash) ||
    !decimalText(v.gasUsed) || !decimalText(v.effectiveGasPrice) || !decimalText(v.fee) || (v.received !== null && !decimalText(v.received)) || (v.sent !== null && v.sent !== undefined && !decimalText(v.sent)) ||
    !Number.isSafeInteger(v.checkedAt)) stop('storage')
}
function validateIntent(i: unknown) {
  const v = i as Record<string, unknown> | null
  if (!v || typeof v !== 'object' || Object.keys(v).some(k => !['verdict', 'checks', 'differences', 'checkedAt'].includes(k)) || !INTENT_VERDICTS.includes(v.verdict as string) ||
    !Array.isArray(v.checks) || v.checks.length > 24 || !Array.isArray(v.differences) || v.differences.length > 8 || !Number.isSafeInteger(v.checkedAt)) return stop('storage')
  for (const item of v.checks as Record<string, unknown>[]) if (!item || typeof item !== 'object' || !boundedText(item.id, 40) || !INTENT_STATUSES.includes(item.status as string) || !boundedText(item.detail, 500)) stop('storage')
  for (const text of v.differences as unknown[]) if (!boundedText(text, 500)) stop('storage')
}
function validateLog(l: unknown) {
  if (!Array.isArray(l) || l.length > 40) return stop('storage')
  for (const item of l as Record<string, unknown>[]) if (!item || typeof item !== 'object' || !Number.isSafeInteger(item.at) || !ATTEMPT_STATUSES.includes(item.status as string) || !boundedText(item.note, 300)) stop('storage')
}
function validateAttempt(value: unknown, owner: string): SwapAttempt {
  if (!value || typeof value !== 'object') return stop('storage')
  const a = value as SwapAttempt
  if (Object.keys(a).some(k => !['id', 'review', 'nonce', 'status', 'createdAt', 'hash', 'output', 'fee', 'chain', 'intent', 'log', 'submittedCalldataHash'].includes(k)) ||
    !/^[a-f0-9-]{36}$/i.test(a.id) || !isNonce(a.nonce) || !Number.isSafeInteger(a.createdAt) ||
    !ATTEMPT_STATUSES.includes(a.status) ||
    !a.review || !sameAddress(a.review.request?.owner, owner) || (a.hash !== undefined && !isTransactionHash(a.hash))) return stop('storage')
  if (a.submittedCalldataHash !== undefined && (!isTransactionHash(a.submittedCalldataHash) || a.review?.request?.tokenIn === 'USDC')) stop('storage')
  // Historical reviews are checked at their original timestamp, solely for tracking. Never restored as send authority.
  validateReview(a.review, { owner, chainId: 5042, connected: true }, a.review.requestStartedAt)
  if (['pending', 'confirmed', 'failed', 'mismatch'].includes(a.status) && !a.hash) return stop('storage')
  if (a.output !== undefined) uint(a.output)
  // Only a Confirmed result must stay inside the approved fee ceiling; a mismatch records what the chain actually charged.
  if (a.fee !== undefined && (uint(a.fee) > uint(a.review.networkFee) && a.status === 'confirmed')) return stop('storage')
  if (a.fee !== undefined) uint(a.fee)
  if (a.chain !== undefined) validateChain(a.chain)
  if (a.intent !== undefined) validateIntent(a.intent)
  if (a.log !== undefined) validateLog(a.log)
  return structuredClone(a)
}
export function createExecutionJournal(storage: ExecutionPorts['storage'], pinned: (id: string) => boolean = () => false) {
  function read(owner: string): SwapAttempt[] {
    try {
      const raw = storage.getItem(storageKey(owner))
      if (raw === null) return []
      if (raw.length > 1048576) return stop('storage')
      const data = JSON.parse(raw)
      if (!Array.isArray(data) || data.length > 20) return stop('storage')
      const result = data.map(a => validateAttempt(a, owner))
      if (new Set(result.map(a => a.id)).size !== result.length) return stop('storage')
      return result
    } catch { return stop('storage') }
  }
  return { read, save(attempt: SwapAttempt) {
    try {
      const owner = attempt.review.request.owner, checked = validateAttempt(attempt, owner)
      const records = read(owner).filter(a => a.id !== checked.id)
      if (records.length >= 20) {
        // Oldest settled record first; a record that recorded a mismatch is the last one removed. Unresolved ones never are.
        // A settled record that this session could not re-verify (`pinned`) still blocks new sends, so it is not moved out either.
        const movable = (a: SwapAttempt) => !unresolved(a) && !pinned(a.id)
        const removable = (() => { const index = records.findIndex(a => movable(a) && a.status !== 'mismatch'); return index >= 0 ? index : records.findIndex(movable) })()
        if (removable < 0) return stop('storage')
        // Moved, never deleted: the archive must hold the record before it leaves the active journal.
        archiveRecord(storage, archiveKey(owner), records[removable], value => validateAttempt(value, owner))
        records.splice(removable, 1)
      }
      records.push(checked)
      const text = JSON.stringify(records)
      if (text.length > 1048576) return stop('storage')
      storage.setItem(storageKey(owner), text)
      if (storage.getItem(storageKey(owner)) !== text) return stop('storage')
    } catch { return stop('storage') }
  }, archived(owner: string): SwapAttempt[] {
    try { const active = new Set(read(owner).map(a => a.id)); return readArchive(storage, archiveKey(owner), value => validateAttempt(value, owner)).filter(a => !active.has(a.id)) } catch { return stop('storage') }
  }, archiveUnreadable(owner: string): number {
    try { return archiveUnreadable(storage, archiveKey(owner), value => validateAttempt(value, owner)) } catch { return stop('storage') }
  } }
}
// Read-only enumeration of every wallet's records stored in this browser, so the history stays reachable without a connected wallet,
// on another network, or while a different token pair or provider is selected. Unreadable records are reported, never repaired or removed.
export interface StoredHistory { owner: string; attempts: SwapAttempt[]; archived: SwapAttempt[]; unreadable: boolean; archiveUnreadable?: number }
export function listStoredAttempts(storage: Pick<Storage, 'getItem' | 'key' | 'length'>): StoredHistory[] {
  const prefix = 'machina.uniswap.arc.execution.v1:'
  const owners: string[] = []
  try {
    for (let index = 0; index < Math.min(storage.length, 512); index++) {
      const key = storage.key(index)
      if (key?.startsWith(prefix) && /^0x[a-f0-9]{40}$/.test(key.slice(prefix.length))) owners.push(key.slice(prefix.length))
    }
  } catch { return [] }
  return owners.slice(0, 16).map(owner => {
    // The active records and the archive are read separately: a problem in one never hides the other.
    const journal = createExecutionJournal({ getItem: key => storage.getItem(key), setItem: () => stop('storage') })
    let attempts: SwapAttempt[], archived: SwapAttempt[] = [], archiveUnreadable = 0, unreadable = false
    try { attempts = journal.read(owner) } catch { return { owner, attempts: [], archived: [], unreadable: true } }
    try { archived = journal.archived(owner); archiveUnreadable = journal.archiveUnreadable(owner) } catch { unreadable = true }
    return { owner, attempts, archived, unreadable, archiveUnreadable }
  })
}
export async function browserExecutionLock<T>(owner: string, run: () => Promise<T>): Promise<T> {
  if (!globalThis.navigator?.locks) return stop('lock')
  return navigator.locks.request(`machina-uniswap-5042:${owner.toLowerCase()}`, { mode: 'exclusive', ifAvailable: true }, lock => lock ? run() : stop('lock'))
}
export async function walletIdentity(provider: ExecutionProvider, owner: string): Promise<ExecutionNonceState> {
  async function identity(after: boolean) {
    const chainStage = after ? 'chain-after' : 'chain-before', accountStage = after ? 'accounts-after' : 'accounts-before'
    const chain = walletRpcQuantity(await walletRpcRead(provider, chainStage, owner), chainStage)
    if (chain !== 5042) throw new WalletRpcFailure(chainStage, 'network-mismatch')
    const accounts = await walletRpcRead(provider, accountStage, owner)
    if (!Array.isArray(accounts) || !accounts.every(a => typeof a === 'string' && /^0x[0-9a-f]{40}$/i.test(a))) throw new WalletRpcFailure(accountStage, 'invalid-response')
    if (!sameAddress(accounts[0], owner)) throw new WalletRpcFailure(accountStage, 'account-mismatch')
  }
  await identity(false)
  // Only this already-authorized execution path opts into pending failure shape diagnostics.
  const read = async (stage: 'latest-before' | 'pending' | 'latest-after') => walletRpcQuantity(await walletRpcRead(provider, stage, owner), stage, stage === 'pending')
  const before = await read('latest-before'), nonce = await read('pending'), latestNonce = await read('latest-after')
  if (before !== latestNonce || nonce < latestNonce) throw new ExecutionNonceObservationError('wallet', Math.max(before, nonce, latestNonce), before !== latestNonce ? 'latest-changed' : 'pending-behind-latest')
  const state = { nonce, latestNonce }
  await identity(true) // No wallet, chain or account mutation during the reads.
  return state
}

// Never select the higher/lower of disagreeing mempool views, silently rebase a
// reviewed nonce, or send a replacement. Both sources must agree and be clear.
export function reconcileExecutionNonce(publicState: ExecutionNonceState, walletState: ExecutionNonceState, expected?: number): number {
  for (const [state, code] of [[publicState, 'public_nonce'], [walletState, 'wallet_nonce']] as const) {
    if (!isNonce(state.nonce) || !isNonce(state.latestNonce) || state.nonce < state.latestNonce) stop(code)
  }
  if (publicState.nonce !== walletState.nonce || publicState.latestNonce !== walletState.latestNonce) throw new NonceRpcConflict(publicState, walletState)
  if (walletState.nonce > walletState.latestNonce) stop('nonce_pending')
  if (expected !== undefined && walletState.nonce !== expected) stop('nonce')
  return walletState.nonce
}

// No preview object, DOM state or localStorage value can be passed to confirm as transaction authority.
export function createUniswapArcExecution(ports: ExecutionPorts) {
  const journal = createExecutionJournal(ports.storage, id => unverified.has(id))
  const enabled = ports.enabled ?? (() => UNISWAP_ARC_WRITES_ENABLED)
  let view: ExecutionView = { phase: 'idle' }, version = 0, busy = false, tracking = false, sending = false
  // A settled record whose chain re-check failed in this session keeps its recorded status, but still blocks a new send until it is
  // re-verified: a stored status is a record, not a fresh observation.
  const unverified = new Set<string>()
  const failures = new Map<string, number>()
  const blocking = (a: SwapAttempt) => unresolved(a) || unverified.has(a.id)
  const withLog = (a: SwapAttempt, status: AttemptStatus, note: string, at = Date.now()): SwapAttempt => {
    if (a.status === status && a.log && a.log.length > 0) return { ...a, status }
    return { ...a, status, log: [...(a.log ?? []), { at, status, note }].slice(-40) }
  }
  let intent: { allowanceNotice?: string; id: string; review: ArcReview; nonce: number; context: string; version: number } | null = null
  const contextKey = () => { const c = ports.context(); return JSON.stringify([c.owner.toLowerCase(), c.connected, c.chainId, c.connectorId]) }
  function emit(next: ExecutionView) { view = structuredClone(next); try { ports.changed?.(structuredClone(view)) } catch { /* Observer cannot interrupt recording. */ } }
  function requireEnabled() {
    if (!enabled()) stop('writes_disabled')
    if (!ports.authorize?.(ports.input(), ports.context())) stop('pilot_restricted')
  }
  function ready(selected: NonNullable<typeof intent>) {
    requireEnabled()
    const input = ports.input(), context = ports.context()
    if (selected.version !== version || contextKey() !== selected.context || !input || requestKey(input) !== requestKey(selected.review.request)) stop('context')
    validateReview(selected.review, context, ports.quoteNow(selected.review.request))
    if (selected.review.expiresAt - ports.quoteNow(selected.review.request) < 5000) stop('expired')
    if (executionDeadlineMs(selected.review) - ports.quoteNow(selected.review.request) < MIN_WALLET_WINDOW_MS + EXECUTION_MINING_BUFFER_MS) stop('expired')
  }
  function errorCode(error: unknown) {
    const code = error instanceof Error ? error.message : ''
    return ['writes_disabled', 'pilot_restricted', 'context', 'nonce', 'nonce_rpc', 'nonce_pending', 'nonce_regression', 'public_nonce', 'wallet_nonce', 'storage', 'lock', 'busy', 'smart_wallet', 'expired', 'allowance_missing', 'insufficient_input_balance', 'permit_invalid'].includes(code) ? code
      : ['deadline', 'quote_expired'].includes(code) ? 'expired' : 'preflight'
  }
  function failureMessage(error: unknown, stage: 'Review' | 'Confirm') {
    if (error instanceof WalletRpcFailure) return `${stage} nonce check: ${walletRpcMessage(error)}`
    if (error instanceof ExecutionNonceObservationError && error.message === 'wallet_nonce') return `${stage} nonce check: The wallet RPC returned inconsistent eth_getTransactionCount(latest/pending/latest) observations: ${error.reason === 'latest-changed' ? 'latest changed during the reads' : 'pending was below latest'}. No transaction was requested.`
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 4001) return 'The wallet permission was rejected. No swap transaction was requested.'
    if (error instanceof Error && error.message === 'allowance_changed') return 'The existing token allowance changed since Review. Review a fresh swap to see the current permission; no swap transaction was requested.'
    if (error instanceof Error && error.message === 'permit_invalid') return 'The Permit2 signature, nonce or deadline could not be verified. No swap transaction was requested.'
    const code = errorCode(error), message = executionMessage(code)
    if (!['nonce', 'nonce_rpc', 'nonce_pending', 'nonce_regression', 'public_nonce', 'wallet_nonce'].includes(code)) return message
    // Only validated public integers are included, never a raw wallet/RPC error.
    const detail = error instanceof NonceRpcConflict
      ? `Public latest/pending ${error.publicState.latestNonce}/${error.publicState.nonce}; wallet latest/pending ${error.walletState.latestNonce}/${error.walletState.nonce}. ` : ''
    return `${stage} nonce check: ${detail}${message}`
  }
  async function checkedNonce(selected: NonNullable<typeof intent>, provider: ExecutionProvider, expected?: number, signedData?: Hex) {
    // One bounded recheck can reconcile a moving head or transient stale result.
    // Repeat the full balance/gas/router/simulation preflight, not just the nonce.
    let highestObserved = -1
    for (let pass = 0; pass < 2; pass++) {
      try {
        ready(selected)
        const publicState = await ports.preflight(structuredClone(selected.review), signedData)
        if (expected !== undefined && publicState.allowanceNotice !== selected.allowanceNotice) stop('allowance_changed')
        selected.allowanceNotice = publicState.allowanceNotice
        if (!isNonce(publicState.nonce) || !isNonce(publicState.latestNonce) || publicState.nonce < publicState.latestNonce) stop('public_nonce')
        highestObserved = Math.max(highestObserved, publicState.nonce)
        ready(selected)
        const walletState = await walletIdentity(provider, selected.review.request.owner)
        highestObserved = Math.max(highestObserved, walletState.nonce)
        ready(selected)
        if (publicState.nonce === walletState.nonce && walletState.nonce < highestObserved) stop('nonce_regression')
        return reconcileExecutionNonce(publicState, walletState, expected)
      } catch (error) {
        const code = error instanceof Error ? error.message : ''
        if (error instanceof ExecutionNonceObservationError && isNonce(error.highestObserved)) highestObserved = Math.max(highestObserved, error.highestObserved)
        if (pass === 0 && (code === 'nonce_rpc' || error instanceof ExecutionNonceObservationError)) continue
        throw error
      }
    }
    return stop('nonce_rpc')
  }
  async function prepare() {
    if (busy || tracking) return
    busy = true
    const currentVersion = ++version
    intent = null
    try {
      requireEnabled()
      const input = validateArcRequest(ports.input()), expectedContext = contextKey()
      const persisted = journal.read(input.owner).find(blocking)
      const memory = view.attempt && sameAddress(view.attempt.review.request.owner, input.owner) && unresolved(view.attempt) ? view.attempt : undefined
      const outstanding = memory ?? persisted
      if (outstanding) {
        emit({ phase: outstanding.hash ? 'pending' : 'unknown', attempt: outstanding, error: executionMessage('busy') })
        return
      }
      emit({ phase: 'preparing' })
      const fresh = await ports.fresh(input)
      if (currentVersion !== version || contextKey() !== expectedContext || !ports.input() || requestKey(ports.input()!) !== requestKey(input) || requestKey(fresh.request) !== requestKey(input)) stop('context')
      const review = tightenExecutionReview(fresh, ports.context(), ports.quoteNow(input))
      if (input.tokenIn !== 'USDC' && !ports.signPermit) stop('permit_invalid')
      const selected = { allowanceNotice: undefined as string | undefined, id: crypto.randomUUID(), review, nonce: 0, context: expectedContext, version: currentVersion }
      const provider = await ports.provider()
      selected.nonce = await checkedNonce(selected, provider)
      executionTransaction(review, selected.nonce)
      ready(selected)
      intent = selected
      emit({ phase: 'review', approvalId: selected.id, review, allowanceNotice: selected.allowanceNotice })
    } catch (error) { if (currentVersion === version) emit({ phase: 'idle', error: failureMessage(error, 'Review') }) }
    finally { busy = false }
  }
  async function confirm(approvalId: string) {
    if (busy || tracking || !intent || view.phase !== 'review' || approvalId !== intent.id) return
    busy = true
    const selected = intent
    let attempt: SwapAttempt | undefined, requested = false
    try {
      ready(selected)
      emit({ phase: 'checking', approvalId, allowanceNotice: selected.allowanceNotice, review: selected.review })
      await ports.lock(selected.review.request.owner, async () => {
        ready(selected)
        if (journal.read(selected.review.request.owner).some(blocking)) stop('busy')
        const provider = await ports.provider()
        await checkedNonce(selected, provider, selected.nonce)
        ready(selected)
        // Confirm Swap explicitly authorizes the shown free PermitSingle signature and subsequent wallet transaction.
        let signedData: Hex | undefined
        if (selected.review.request.tokenIn !== 'USDC') {
          if (!ports.signPermit) stop('permit_invalid')
          emit({ phase: 'checking', approvalId, allowanceNotice: selected.allowanceNotice, review: selected.review, walletRequestOpen: true })
          signedData = await ports.signPermit!(structuredClone(selected.review), provider)
          if (!signedData) stop('permit_invalid')
          emit({ phase: 'checking', approvalId, allowanceNotice: selected.allowanceNotice, review: selected.review, walletRequestOpen: false })
          ready(selected)
          // Mandatory exact signed transaction simulation, current Permit2 nonce, gas and wallet/public nonce checks after signing.
          await checkedNonce(selected, provider, selected.nonce, signedData)
          ready(selected)
        }
        const transaction = { ...executionTransaction(selected.review, selected.nonce), ...(signedData ? { data: signedData } : {}) }
        let record: SwapAttempt = { id: selected.id, review: structuredClone(selected.review), nonce: selected.nonce, createdAt: Date.now(), status: 'awaiting_wallet', ...(signedData ? { submittedCalldataHash: keccak256(signedData) } : {}) }
        attempt = record
        journal.save(record) // Must succeed BEFORE the only wallet write method can run.
        ready(selected)
        const walletWindowMs = executionDeadlineMs(selected.review) - ports.quoteNow(selected.review.request) - EXECUTION_MINING_BUFFER_MS
        intent = null; requested = true; sending = true
        emit({ phase: 'awaiting_wallet', attempt: record, walletWindowMs, walletRequestOpen: true })
        // EIP-1193 cannot cancel an open request. Stop presenting it as approvable at
        // the cutoff, but retain the lock/observer until it settles to record a late
        // hash. Never race it into rejection or make a timeout authorize another send.
        const walletTimer = setTimeout(() => {
          record = { ...record, status: 'unknown' }; attempt = record
          emit({ phase: 'unknown', attempt: record, error: executionMessage('wallet_timeout'), walletRequestOpen: true })
          try { journal.save(record) } catch { /* Original durable unresolved intent still blocks retry. */ }
        }, walletWindowMs)
        try {
          const hash = await provider.request({ method: 'eth_sendTransaction', params: [transaction] })
          if (!isTransactionHash(hash)) throw new Error('unknown')
          record = { ...record, hash, status: 'pending' }; attempt = record
          emit({ phase: 'pending', attempt: record }) // Never lose the hash to a later RPC/storage error.
          journal.save(record)
        } catch (error) {
          const rejected = !record.hash && typeof error === 'object' && error !== null && 'code' in error && error.code === 4001
          record = { ...record, status: rejected ? 'rejected' : 'unknown' }; attempt = record
          emit({ phase: record.status, attempt: record, error: executionMessage(rejected ? 'rejected' : 'unknown') })
          try { journal.save(record) } catch { emit({ phase: 'unknown', attempt: record, error: executionMessage('storage') }) }
        } finally { clearTimeout(walletTimer); sending = false }
      })
    } catch (error) {
      intent = null
      if (!requested && attempt) { attempt = { ...attempt, status: 'rejected' }; try { journal.save(attempt) } catch { /* Original durable record blocks retry. */ } }
      if (!requested) emit({ phase: 'idle', error: failureMessage(error, 'Confirm') })
    } finally { busy = false }
    if (attempt?.hash) await reconcile(attempt.review.request.owner)
  }
  async function reconcile(owner = ports.context().owner, recoveredHash?: string, attemptId?: string) {
    if (busy || tracking || !/^0x[a-fA-F0-9]{40}$/.test(owner)) return
    tracking = true
    try {
      await ports.lock(owner, async () => {
        const records = journal.read(owner)
        const stored = attemptId ? records.find(a => a.id === attemptId) : [...records].reverse().find(blocking) ?? records[records.length - 1]
        if (!stored || stored.status === 'rejected') return
        let attempt = stored
        if (!attempt.hash && view.attempt?.id === stored.id && view.attempt.hash) attempt = { ...attempt, hash: view.attempt.hash }
        // `base` is what is recorded (plus a hash the wallet itself returned). A hash the user typed is `unrecorded` until the network has
        // shown that exact transaction: a mistyped or foreign hash must never replace the means of finding the real one.
        let base = attempt
        let unrecorded = false, replaced: Hex | undefined
        if (recoveredHash !== undefined) {
          if (!isTransactionHash(recoveredHash)) throw new ExecutionVerificationError('binding', false)
          if (attempt.hash && attempt.hash.toLowerCase() !== recoveredHash.toLowerCase()) {
            // A different hash can take over only when the recorded one provably cannot execute any more: the node does not know it AND
            // its nonce was already used by another transaction. The new hash is then verified like any other (sender, nonce, calldata, fee).
            const probe = await ports.result(structuredClone(attempt))
            if (!(probe.status === 'pending' && probe.identified === false && probe.nonceUsed === true)) throw new ExecutionVerificationError('binding', false)
            replaced = attempt.hash
          }
          unrecorded = !attempt.hash || replaced !== undefined
          attempt = { ...attempt, hash: recoveredHash }
        }
        if (!attempt.hash) { emit({ phase: 'unknown', attempt, error: executionMessage('unknown'), nextCheckMs: null }); return }
        // The status already known stays on screen; only the checking indicator is added. A stored settled status is shown as
        // recorded until the chain has been read again.
        emit({ phase: attempt.status === 'awaiting_wallet' ? 'unknown' : attempt.status, attempt, checking: true, nextCheckMs: null, observedAt: view.attempt?.id === attempt.id ? view.observedAt : undefined })
        // The record of a replacement keeps the earlier hash in its log, so nothing about the first attempt is lost.
        const withReplacement = (a: SwapAttempt, at: number): SwapAttempt => replaced === undefined ? a
          : { ...a, log: [...(a.log ?? []), { at, status: a.status, note: `Tracked under the hash you supplied. The previously recorded hash ${replaced} is unknown to the network and its nonce was used by another transaction.`.slice(0, 290) }].slice(-40) }
        try {
          const result = await ports.result(structuredClone(attempt), intent => {
            // Evidence only: never settle, authorize a retry, or persist an unverified recovery hash.
            if (unrecorded || !unresolved(attempt) || !['mismatch', 'unbound'].includes(intent.verdict)) return
            attempt = { ...attempt, intent }
            journal.save(attempt)
            base = attempt
            emit({ ...view, attempt })
          })
          const observedAt = Date.now()
          if (result.status === 'pending') {
            failures.delete(attempt.id)
            if (unrecorded && result.identified !== true) {
              // Nothing is saved: the recorded state (and the means to find the real transaction) stays exactly as it was.
              emit({ phase: base.status === 'awaiting_wallet' ? 'unknown' : base.status, attempt: base, checking: false, nextCheckMs: null, error: executionMessage('recovery_unknown'), observedAt: view.observedAt, ...(replaced ? { replaced: true } : {}) })
              return
            }
            // A reorg of a formerly settled record must become durable Pending again, blocking another send.
            unverified.delete(attempt.id)
            const pending = withReplacement(withLog({ ...attempt, status: attempt.status }, 'pending', 'Waiting for inclusion and two observed blocks.', observedAt), observedAt)
            journal.save(pending)
            const gone = result.identified === false && result.nonceUsed === true
            emit({ phase: 'pending', attempt: pending, checking: false, nextCheckMs: PENDING_CHECK_MS, observedAt, ...(gone ? { replaced: true, error: executionMessage('replaced') } : {}) })
            return
          }
          let next: SwapAttempt, status: AttemptStatus
          if (result.status === 'settled') {
            const verified = isIntentVerified(result.intent.verdict)
            status = result.chain.state === 'reverted' ? 'failed' : verified ? 'confirmed' : result.intent.verdict === 'mismatch' ? 'mismatch' : 'unknown'
            if (status === 'unknown') {
              // The chain answered (success) but the evidence needed to compare it with the Review is incomplete. The chain facts are kept and
              // shown; nothing about the Review is claimed. It stays unresolved (blocks a new send) and is re-read with growing pauses that
              // end: the same incomplete answer must not be fetched every five seconds forever.
              const count = (failures.get(attempt.id) ?? 0) + 1
              failures.set(attempt.id, count)
              const wait = count < MAX_AUTOMATIC_CHECK_FAILURES ? TRANSIENT_CHECK_DELAYS_MS[Math.min(count - 1, TRANSIENT_CHECK_DELAYS_MS.length - 1)] : null
              const incomplete = withReplacement(withLog({ ...attempt, output: result.output, fee: result.fee, chain: result.chain, intent: result.intent }, 'unknown', 'Chain success; evidence to compare with the Review is incomplete. Nothing is claimed.', observedAt), observedAt)
              journal.save(incomplete)
              unverified.delete(attempt.id)
              emit({ phase: 'unknown', attempt: incomplete, checking: false, nextCheckMs: wait, observedAt, error: executionMessage(wait === null ? 'verification_stopped' : 'verification') })
              return
            }
            if (status === 'confirmed' && (uint(result.fee) > uint(attempt.review.networkFee) || uint(result.output) < uint(attempt.review.requiredMinimum))) throw new ExecutionVerificationError('malformed', false)
            const note = status === 'confirmed' ? (result.intent.verdict === 'verified_with_notes' ? 'Chain success; matches the Review (wallet adjusted gas fields within the approved ceiling).' : 'Chain success; matches the Review.')
              : status === 'failed' ? 'Chain: the transaction reverted.' : `Chain success; not the reviewed transaction: ${result.intent.differences[0] ?? 'see the intent checks'}`
            next = withLog({ ...attempt, output: result.output, fee: result.fee, chain: result.chain, intent: result.intent }, status, note.slice(0, 290), observedAt)
          } else {
            if (uint(result.fee) > uint(attempt.review.networkFee) || (result.status === 'confirmed' && uint(result.output) < uint(attempt.review.requiredMinimum))) throw new ExecutionVerificationError('malformed', false)
            status = result.status
            next = withLog({ ...attempt, output: result.output, fee: result.fee }, status, status === 'confirmed' ? 'Chain success; matches the Review.' : 'Chain: the transaction reverted.', observedAt)
          }
          next = withReplacement(next, observedAt)
          failures.delete(attempt.id)
          journal.save(next)
          unverified.delete(attempt.id)
          emit({ phase: status, attempt: next, checking: false, nextCheckMs: null, observedAt, ...(status === 'mismatch' ? { error: executionMessage('mismatch') } : {}) })
          try { ports.settled?.(structuredClone(next)) } catch { /* Balance refresh cannot change chain truth. */ }
        } catch (error) {
          const deterministic = error instanceof ExecutionVerificationError && !error.retryable
          const count = (failures.get(attempt.id) ?? 0) + 1
          failures.set(attempt.id, count)
          const automatic = !deterministic && count < MAX_AUTOMATIC_CHECK_FAILURES
          const delay = automatic ? TRANSIENT_CHECK_DELAYS_MS[Math.min(count - 1, TRANSIENT_CHECK_DELAYS_MS.length - 1)] : null
          const message = executionMessage(deterministic ? 'verification_binding' : automatic ? 'verification' : 'verification_stopped')
          if ((TERMINAL.includes(attempt.status) || attempt.status === 'pending') && !deterministic) {
            // A read failure teaches nothing about the chain. A settled record is not downgraded, and a Pending transaction stays Pending:
            // the last known status remains on screen (with the reason it could not be refreshed), it keeps blocking new sends until
            // the chain is read again, and the lookup is retried with growing pauses.
            unverified.add(attempt.id)
            emit({ phase: attempt.status, attempt: base, checking: false, nextCheckMs: delay, error: message, observedAt: view.observedAt })
          } else {
            const unknown = withLog({ ...attempt }, 'unknown', deterministic ? 'The hash does not identify the reviewed transaction.' : 'The chain could not be read; outcome not yet verified.')
            // Do not persist an unverified recovery hash; keep the original record recoverable.
            if (!unrecorded) { try { journal.save(unknown) } catch { /* Previous unresolved record remains. */ } }
            emit({ phase: 'unknown', attempt: unrecorded ? { ...unknown, hash: base.hash } : unknown, checking: false, nextCheckMs: delay, error: message, observedAt: view.observedAt })
          }
        }
      })
    } catch (error) {
      // A temporarily held cross-tab lock does not turn a transaction into a failure.
      if (!(error instanceof Error && error.message === 'lock')) emit({ ...view, checking: false, error: executionMessage(error instanceof ExecutionVerificationError ? (error.retryable ? 'verification' : 'verification_binding') : error instanceof Error && error.message === 'verification' ? 'verification' : 'storage') })
    } finally { tracking = false }
  }
  function invalidate() {
    version++; intent = null
    if (!sending && !['pending', 'unknown', 'confirmed', 'failed', 'rejected'].includes(view.phase)) emit({ phase: 'idle' })
  }
  return { prepare, confirm, reconcile, invalidate, history: (owner = ports.context().owner) => journal.read(owner), current: () => structuredClone(view),
    // True while a record of this wallet is unresolved (or could not be re-verified). Unreadable storage counts as blocking.
    blocking: (owner: string) => { try { return journal.read(owner).some(blocking) } catch { return true } } }
}
