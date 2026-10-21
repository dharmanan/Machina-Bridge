import { decodeFunctionData, encodeFunctionData, toHex, type Hex } from 'viem'
import { ARC_ROUTER, EXECUTE_ABI, UNISWAP_ARC_WRITES_ENABLED, nativeAmount, requestKey, sameAddress, uint, validateArcRequest, validateArcReview, type ArcRequest, type ArcReview } from './uniswapArcPolicy'

export interface ExecutionContext { owner: string; connected: boolean; chainId: number; connectorId: string }
export interface ExecutionProvider { request(args: { method: string; params?: unknown[] }): Promise<unknown> }
export type AttemptStatus = 'awaiting_wallet' | 'pending' | 'confirmed' | 'failed' | 'rejected' | 'unknown'
export interface SwapAttempt { id: string; review: ArcReview; nonce: number; status: AttemptStatus; createdAt: number; hash?: Hex; output?: string; fee?: string }
export interface ExecutionView {
  phase: 'idle' | 'preparing' | 'review' | 'checking' | AttemptStatus
  approvalId?: string; review?: ArcReview; attempt?: SwapAttempt; error?: string; walletWindowMs?: number; walletRequestOpen?: boolean
}
export type ChainResult = { status: 'pending' } | { status: 'confirmed' | 'failed'; output: string; fee: string }
export interface ExecutionPorts {
  context(): ExecutionContext; input(): ArcRequest | null
  fresh(input: ArcRequest): Promise<ArcReview>; quoteNow(input: ArcRequest): number
  preflight(review: ArcReview): Promise<{ nonce: number }>
  provider(): Promise<ExecutionProvider>
  result(attempt: SwapAttempt): Promise<ChainResult>
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
const stop = (code: string): never => { throw new Error(code) }
export function executionMessage(code: string): string {
  const messages: Record<string, string> = {
    writes_disabled: 'Real Uniswap swaps are disabled pending independent review and release approval.',
    pilot_restricted: 'Execution is restricted to the configured pilot wallet on Arc Mainnet: USDC to EURC, at most 0.1 USDC. Live previews remain available.',
    context: 'The wallet, network, provider or swap inputs changed. Review a fresh swap.',
    expired: 'This swap review expired. Review a fresh swap before confirming.',
    busy: 'An earlier wallet request or transaction is unresolved. Check its status before retrying.',
    lock: 'Another tab is handling this wallet, or safe browser locking is unavailable.',
    storage: 'Safe transaction recording is unavailable. No new transaction can be requested.',
    nonce: 'The wallet transaction nonce changed. Review a fresh swap.',
    rejected: 'You rejected the wallet request. No automatic retry will occur.',
    unknown: 'The wallet request may have been submitted. Check your wallet and recover its hash; do not submit again.',
    wallet_timeout: 'The wallet approval window ended. Cancel the open request in your wallet; do not approve or submit again. The app cannot cancel it. A late approval or delayed inclusion may revert and still charge gas. Any returned hash will still be tracked.',
    verification: 'The transaction or its result could not be independently verified. Do not resubmit.',
    smart_wallet: 'This execution flow supports EOAs only. Contract and delegated wallets remain blocked.',
    preflight: 'The current balance, fees, contract identity or simulation could not be verified. No wallet request was started.',
    confirmation: 'The transaction is still being checked. RPC errors and timeouts do not mean it failed.',
  }
  return messages[code] ?? messages.preflight
}

// Only the deadline is tightened. Commands, inputs, attribution suffix, value and economic floors are unchanged.
export function tightenExecutionReview(source: ArcReview, context: ExecutionContext, now: number): ArcReview {
  validateArcReview(source, context, now)
  const review = structuredClone(source)
  const outer = decodeFunctionData({ abi: EXECUTE_ABI, data: review.transaction.data })
  const canonical = encodeFunctionData({ abi: EXECUTE_ABI, functionName: 'execute', args: outer.args })
  const deadline = BigInt(Math.floor((review.requestStartedAt + EXECUTION_DEADLINE_WINDOW_MS) / 1000))
  const shorter = deadline < outer.args[2] ? deadline : outer.args[2]
  review.transaction.data = (encodeFunctionData({ abi: EXECUTE_ABI, functionName: 'execute', args: [outer.args[0], outer.args[1], shorter] }) + review.transaction.data.slice(canonical.length)) as Hex
  validateArcReview(review, context, now)
  return review
}
export function executionTransaction(review: ArcReview, nonce: number) {
  if (!isNonce(nonce)) return stop('nonce')
  return Object.freeze({ chainId: toHex(5042), from: review.request.owner, to: ARC_ROUTER, data: review.transaction.data,
    value: toHex(nativeAmount(review.request.amount)), gas: toHex(uint(review.gasLimit)), nonce: toHex(nonce),
    type: '0x2', maxFeePerGas: toHex(uint(review.maxFeePerGas)), maxPriorityFeePerGas: toHex(uint(review.maxPriorityFeePerGas)) })
}
function validateAttempt(value: unknown, owner: string): SwapAttempt {
  if (!value || typeof value !== 'object') return stop('storage')
  const a = value as SwapAttempt
  if (Object.keys(a).some(k => !['id', 'review', 'nonce', 'status', 'createdAt', 'hash', 'output', 'fee'].includes(k)) ||
    !/^[a-f0-9-]{36}$/i.test(a.id) || !isNonce(a.nonce) || !Number.isSafeInteger(a.createdAt) ||
    !['awaiting_wallet', 'pending', 'confirmed', 'failed', 'rejected', 'unknown'].includes(a.status) ||
    !a.review || !sameAddress(a.review.request?.owner, owner) || (a.hash !== undefined && !isTransactionHash(a.hash))) return stop('storage')
  // Historical reviews are checked at their original timestamp, solely for tracking. Never restored as send authority.
  validateArcReview(a.review, { owner, chainId: 5042, connected: true }, a.review.requestStartedAt)
  if (['pending', 'confirmed', 'failed'].includes(a.status) && !a.hash) return stop('storage')
  if (a.output !== undefined) uint(a.output)
  if (a.fee !== undefined && uint(a.fee) > uint(a.review.networkFee)) return stop('storage')
  return structuredClone(a)
}
export function createExecutionJournal(storage: ExecutionPorts['storage']) {
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
        const removable = records.findIndex(a => !unresolved(a))
        if (removable < 0) return stop('storage')
        records.splice(removable, 1)
      }
      records.push(checked)
      const text = JSON.stringify(records)
      if (text.length > 1048576) return stop('storage')
      storage.setItem(storageKey(owner), text)
      if (storage.getItem(storageKey(owner)) !== text) return stop('storage')
    } catch { return stop('storage') }
  } }
}
export async function browserExecutionLock<T>(owner: string, run: () => Promise<T>): Promise<T> {
  if (!globalThis.navigator?.locks) return stop('lock')
  return navigator.locks.request(`machina-uniswap-5042:${owner.toLowerCase()}`, { mode: 'exclusive', ifAvailable: true }, lock => lock ? run() : stop('lock'))
}
async function walletIdentity(provider: ExecutionProvider, owner: string, nonce: number) {
  const chain = await provider.request({ method: 'eth_chainId' })
  if (typeof chain !== 'string' || !/^0x[0-9a-f]+$/i.test(chain) || BigInt(chain) !== 5042n) return stop('context')
  const accounts = await provider.request({ method: 'eth_accounts' })
  if (!Array.isArray(accounts) || !sameAddress(accounts[0], owner)) return stop('context')
  const currentNonce = await provider.request({ method: 'eth_getTransactionCount', params: [owner, 'pending'] })
  if (typeof currentNonce !== 'string' || !/^0x[0-9a-f]+$/i.test(currentNonce) || BigInt(currentNonce) !== BigInt(nonce)) return stop('nonce')
}

// No preview object, DOM state or localStorage value can be passed to confirm as transaction authority.
export function createUniswapArcExecution(ports: ExecutionPorts) {
  const journal = createExecutionJournal(ports.storage)
  const enabled = ports.enabled ?? (() => UNISWAP_ARC_WRITES_ENABLED)
  let view: ExecutionView = { phase: 'idle' }, version = 0, busy = false, tracking = false, sending = false
  let intent: { id: string; review: ArcReview; nonce: number; context: string; version: number } | null = null
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
    validateArcReview(selected.review, context, ports.quoteNow(selected.review.request))
    if (selected.review.expiresAt - ports.quoteNow(selected.review.request) < 5000) stop('expired')
    if (executionDeadlineMs(selected.review) - ports.quoteNow(selected.review.request) < MIN_WALLET_WINDOW_MS + EXECUTION_MINING_BUFFER_MS) stop('expired')
  }
  function errorCode(error: unknown) {
    const code = error instanceof Error ? error.message : ''
    return ['writes_disabled', 'pilot_restricted', 'context', 'nonce', 'storage', 'lock', 'busy', 'smart_wallet', 'expired'].includes(code) ? code
      : ['deadline', 'quote_expired'].includes(code) ? 'expired' : 'preflight'
  }
  async function prepare() {
    if (busy || tracking) return
    busy = true
    const currentVersion = ++version
    intent = null
    try {
      requireEnabled()
      const input = validateArcRequest(ports.input()), expectedContext = contextKey()
      const persisted = journal.read(input.owner).find(unresolved)
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
      const selected = { id: crypto.randomUUID(), review, nonce: 0, context: expectedContext, version: currentVersion }
      const checked = await ports.preflight(structuredClone(review))
      selected.nonce = checked.nonce
      executionTransaction(review, selected.nonce)
      ready(selected)
      intent = selected
      emit({ phase: 'review', approvalId: selected.id, review })
    } catch (error) { if (currentVersion === version) emit({ phase: 'idle', error: executionMessage(errorCode(error)) }) }
    finally { busy = false }
  }
  async function confirm(approvalId: string) {
    if (busy || tracking || !intent || view.phase !== 'review' || approvalId !== intent.id) return
    busy = true
    const selected = intent
    let attempt: SwapAttempt | undefined, requested = false
    try {
      ready(selected)
      emit({ phase: 'checking', approvalId, review: selected.review })
      await ports.lock(selected.review.request.owner, async () => {
        ready(selected)
        if (journal.read(selected.review.request.owner).some(unresolved)) stop('busy')
        const checked = await ports.preflight(structuredClone(selected.review))
        if (checked.nonce !== selected.nonce) stop('nonce')
        ready(selected)
        const provider = await ports.provider()
        await walletIdentity(provider, selected.review.request.owner, selected.nonce)
        ready(selected)
        const transaction = executionTransaction(selected.review, selected.nonce)
        let record: SwapAttempt = { id: selected.id, review: structuredClone(selected.review), nonce: selected.nonce, createdAt: Date.now(), status: 'awaiting_wallet' }
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
      if (!requested) emit({ phase: 'idle', error: executionMessage(errorCode(error)) })
    } finally { busy = false }
    if (attempt?.hash) await reconcile(attempt.review.request.owner)
  }
  async function reconcile(owner = ports.context().owner, recoveredHash?: string) {
    if (busy || tracking || !/^0x[a-fA-F0-9]{40}$/.test(owner)) return
    tracking = true
    try {
      await ports.lock(owner, async () => {
        const records = journal.read(owner)
        const stored = [...records].reverse().find(unresolved) ?? records[records.length - 1]
        if (!stored || stored.status === 'rejected') return
        let attempt = stored
        if (!attempt.hash && view.attempt?.id === stored.id && view.attempt.hash) attempt = { ...attempt, hash: view.attempt.hash }
        if (recoveredHash !== undefined) {
          if (!isTransactionHash(recoveredHash) || (attempt.hash && attempt.hash.toLowerCase() !== recoveredHash.toLowerCase())) throw new Error('verification')
          attempt = { ...attempt, hash: recoveredHash }
        }
        if (!attempt.hash) { emit({ phase: 'unknown', attempt, error: executionMessage('unknown') }); return }
        // Persisted terminal status is not trusted as a fresh chain observation after reload.
        emit({ phase: 'pending', attempt: { ...attempt, status: 'pending' } })
        try {
          const result = await ports.result(structuredClone(attempt))
          if (result.status === 'pending') {
            // A recovery hash is saved only after exact transaction verification. A reorg of a
            // formerly terminal record must become durable Pending again, blocking another send.
            journal.save({ ...attempt, status: 'pending' })
            return
          }
          if (uint(result.fee) > uint(attempt.review.networkFee) || (result.status === 'confirmed' && uint(result.output) < uint(attempt.review.requiredMinimum))) stop('verification')
          attempt = { ...attempt, status: result.status, output: result.output, fee: result.fee }
          journal.save(attempt)
          emit({ phase: result.status, attempt })
          try { ports.settled?.(structuredClone(attempt)) } catch { /* Balance refresh cannot change chain truth. */ }
        } catch {
          attempt = { ...attempt, status: 'unknown' }
          // Do not persist an unverified recovery hash; keep the original record recoverable.
          if (recoveredHash === undefined) { try { journal.save(attempt) } catch { /* Previous unresolved record remains. */ } }
          emit({ phase: 'unknown', attempt, error: executionMessage('verification') })
        }
      })
    } catch (error) {
      // A temporarily held cross-tab lock does not turn a transaction into a failure.
      if (!(error instanceof Error && error.message === 'lock')) emit({ ...view, error: executionMessage(error instanceof Error && error.message === 'verification' ? 'verification' : 'storage') })
    } finally { tracking = false }
  }
  function invalidate() {
    version++; intent = null
    if (!sending && !['pending', 'unknown', 'confirmed', 'failed', 'rejected'].includes(view.phase)) emit({ phase: 'idle' })
  }
  return { prepare, confirm, reconcile, invalidate, current: () => structuredClone(view) }
}
