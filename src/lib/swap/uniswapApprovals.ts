import { existingAllowanceNotice } from './permitSingle'
import { decodeFunctionData, encodeFunctionData, getAddress, parseAbi, toHex, type Hex } from 'viem'
import { ARC_PERMIT2, ARC_ROUTER, ARC_TOKENS, sameAddress, tokenUnits, validateArcRequest, type ArcRequest, type ArcSymbol } from '../uniswapArcPolicy'
import { WalletRpcFailure, walletRpcMessage } from '../uniswapArcWalletRpc'
import {
  ExecutionNonceObservationError, ExecutionVerificationError, reconcileExecutionNonce, walletIdentity,
  type AttemptStatus, type ExecutionContext, type ExecutionNonceState, type ExecutionProvider, type StatusLogEntry,
} from '../uniswapArcExecution'
import { archiveRecord, archiveUnreadable, readArchive } from './journalArchive'

// Approvals for ERC-20 inputs. The Universal Router pulls an ERC-20 through Permit2, which takes two separate on-chain approvals:
//   1. token.approve(Permit2, amount)                          the token lets Permit2 move exactly the swap amount
//   2. Permit2.approve(token, router, amount, expiration)      Permit2 lets the router use exactly that amount, for a short time
// Both are for the EXACT amount of the swap being reviewed, never unlimited and never longer than PERMIT_VALIDITY_SECONDS. Each one is
// its own review and its own wallet confirmation; the app never bundles them with a swap and never asks for a signature or key. The
// native USDC input needs none. This module is the only place that can ask a wallet for an approval, and it can ask for these two shapes only.
export const PERMIT_VALIDITY_SECONDS = 900
export const APPROVAL_REVIEW_TTL_MS = 60_000
export const APPROVAL_GAS_CEILING = 300_000n
export const APPROVAL_FEE_CEILING = 10n ** 16n // 0.01 USDC, 18 decimals: an approval is a small transaction
const TOKEN_ABI = parseAbi(['function approve(address spender, uint256 amount) returns (bool)'])
const PERMIT_ABI = parseAbi(['function approve(address token, address spender, uint160 amount, uint48 expiration)'])
const UINT160_MAX = 2n ** 160n - 1n

export type ApprovalKind = 'token' | 'permit2'
export interface ApprovalStep { kind: ApprovalKind; token: ArcSymbol; spender: Hex; amount: string; expiration: number /* unix seconds; 0 for the token step */ }
export interface ApprovalTransaction { chainId: 5042; from: Hex; to: Hex; data: Hex; value: '0x0' }

export function approvalTransaction(owner: string, step: ApprovalStep): ApprovalTransaction {
  const token = ARC_TOKENS[step.token], amount = BigInt(step.amount)
  const common = { chainId: 5042 as const, from: getAddress(owner) as Hex, value: '0x0' as const }
  return step.kind === 'token'
    ? { ...common, to: token.address as Hex, data: encodeFunctionData({ abi: TOKEN_ABI, functionName: 'approve', args: [step.spender, amount] }) }
    : { ...common, to: ARC_PERMIT2 as Hex, data: encodeFunctionData({ abi: PERMIT_ABI, functionName: 'approve', args: [token.address as Hex, step.spender, amount, step.expiration] }) }
}

// Strict shape check for a step: right spender, exact amount, bounded expiry. The same function validates what is stored and what is sent.
export function validateApprovalStep(step: unknown, request: ArcRequest, now: number): ApprovalStep {
  const s = step as ApprovalStep
  if (!s || typeof s !== 'object' || Object.keys(s).sort().join() !== 'amount,expiration,kind,spender,token') throw new Error('approval_step')
  const need = tokenUnits(request.amount, ARC_TOKENS[request.tokenIn].decimals)
  if (request.tokenIn === 'USDC' || s.token !== request.tokenIn || typeof s.amount !== 'string' || !/^[1-9]\d{0,77}$/.test(s.amount) || BigInt(s.amount) !== need || need > UINT160_MAX) throw new Error('approval_amount')
  if (s.kind === 'token') { if (!sameAddress(s.spender, ARC_PERMIT2) || s.expiration !== 0) throw new Error('approval_spender') }
  else if (s.kind === 'permit2') {
    if (!sameAddress(s.spender, ARC_ROUTER) || !Number.isSafeInteger(s.expiration) || s.expiration <= Math.floor(now / 1000) || s.expiration > Math.floor(now / 1000) + PERMIT_VALIDITY_SECONDS + 60) throw new Error('approval_expiry')
  } else throw new Error('approval_kind')
  return Object.freeze({ kind: s.kind, token: s.token, spender: getAddress(s.spender) as Hex, amount: s.amount, expiration: s.expiration })
}
// The canonical decoder: a transaction is an approval of this step only if re-encoding its decoded arguments reproduces it exactly.
export function decodeApprovalTransaction(tx: { to: string; data: string; value?: unknown }): ApprovalStep | null {
  try {
    if (tx.value !== undefined && BigInt(tx.value as string | bigint | number) !== 0n) return null
    const symbol = (Object.keys(ARC_TOKENS) as ArcSymbol[]).find(k => sameAddress(tx.to, ARC_TOKENS[k].address))
    if (symbol && symbol !== 'USDC') {
      const decoded = decodeFunctionData({ abi: TOKEN_ABI, data: tx.data as Hex })
      if (encodeFunctionData({ abi: TOKEN_ABI, functionName: 'approve', args: decoded.args }).toLowerCase() !== tx.data.toLowerCase()) return null
      return { kind: 'token', token: symbol, spender: getAddress(decoded.args[0]) as Hex, amount: decoded.args[1].toString(), expiration: 0 }
    }
    if (sameAddress(tx.to, ARC_PERMIT2)) {
      const decoded = decodeFunctionData({ abi: PERMIT_ABI, data: tx.data as Hex })
      if (encodeFunctionData({ abi: PERMIT_ABI, functionName: 'approve', args: decoded.args }).toLowerCase() !== tx.data.toLowerCase()) return null
      const token = (Object.keys(ARC_TOKENS) as ArcSymbol[]).find(k => sameAddress(decoded.args[0], ARC_TOKENS[k].address))
      if (!token || token === 'USDC') return null
      return { kind: 'permit2', token, spender: getAddress(decoded.args[1]) as Hex, amount: decoded.args[2].toString(), expiration: Number(decoded.args[3]) }
    }
  } catch { /* not an approval */ }
  return null
}

export interface ApprovalReads { timestamp: bigint; balance: bigint; tokenAllowance: bigint; permitAmount: bigint; permitExpiration: bigint; nativeBalance: bigint; gasPrice: bigint }
export type ApprovalPlan =
  | { state: 'native_input' }
  | { state: 'blocked'; reason: 'insufficient_balance' }
  | { state: 'complete' }
  | { state: 'needed'; steps: ApprovalStep[] }
// What token approval is still missing, from fresh chain reads. Existing approvals that already cover the exact amount are reused; nothing is
// approved "just in case", and an allowance larger than needed is left as it is (the app never raises or revokes without being asked).
export function planApprovals(requestInput: ArcRequest, reads: ApprovalReads): ApprovalPlan {
  const request = validateArcRequest(requestInput)
  if (request.tokenIn === 'USDC') return { state: 'native_input' }
  const need = tokenUnits(request.amount, ARC_TOKENS[request.tokenIn].decimals)
  if (reads.balance < need) return { state: 'blocked', reason: 'insufficient_balance' }
  const steps: ApprovalStep[] = []
  if (reads.tokenAllowance < need) steps.push({ kind: 'token', token: request.tokenIn, spender: ARC_PERMIT2 as Hex, amount: need.toString(), expiration: 0 })
  // Router authorisation is now a short-lived PermitSingle signature inside the swap, never a second on-chain approval.
  return steps.length === 0 ? { state: 'complete' } : { state: 'needed', steps }
}

export interface ApprovalReview {
  id: string; step: ApprovalStep; request: ArcRequest; transaction: ApprovalTransaction; nonce: number
  gas: string; maxFeePerGas: string; maxPriorityFeePerGas: string; networkFee: string; nativeBalance: string; expiresAt: number
  estimatedNetworkFee: string
  remaining: number // how many approvals this swap still needs, this one included
}
export interface ApprovalAttempt {
  id: string; owner: string; step: ApprovalStep; transaction: ApprovalTransaction; nonce: number; status: AttemptStatus; createdAt: number
  gas: string; maxFeePerGas: string; maxPriorityFeePerGas: string; networkFee: string; hash?: Hex; fee?: string; blockNumber?: string; log?: StatusLogEntry[]; note?: string
}
export interface ApprovalView {
  phase: 'idle' | 'preparing' | 'review' | 'checking' | AttemptStatus
  review?: ApprovalReview; attempt?: ApprovalAttempt; error?: string; walletRequestOpen?: boolean; checking?: boolean; nextCheckMs?: number | null; observedAt?: number
}
export type ApprovalChainResult =
  // identified: the node knows this exact transaction and it is bound to the approval. A hash it has never seen is not identified.
  | { status: 'pending'; identified?: boolean }
  // bound: the sent transaction is exactly the reviewed approval; allowanceOk: the chain now holds exactly that approval.
  | { status: 'settled'; state: 'success' | 'reverted'; fee: string; blockNumber: string; bound: boolean; allowanceOk: boolean }
export interface ApprovalPorts {
  context(): ExecutionContext
  authorize(request: ArcRequest, context: ExecutionContext): boolean
  reads(owner: Hex, token: ArcSymbol): Promise<ApprovalReads>
  estimate(transaction: ApprovalTransaction): Promise<bigint>
  nonces(owner: Hex): Promise<ExecutionNonceState>
  provider(): Promise<ExecutionProvider>
  result(attempt: ApprovalAttempt): Promise<ApprovalChainResult>
  storage: Pick<Storage, 'getItem' | 'setItem'>
  lock<T>(owner: string, run: () => Promise<T>): Promise<T>
  now(): number
  // True while an unresolved swap (either provider) of this wallet exists: it holds the account nonce, so no approval may start either.
  blockedBy?(owner: string): boolean
  changed?(view: ApprovalView): void
  settled?(attempt: ApprovalAttempt): void
}

const isHash = (v: unknown): v is Hex => typeof v === 'string' && /^0x[0-9a-fA-F]{64}$/.test(v)
const STATUSES: AttemptStatus[] = ['awaiting_wallet', 'pending', 'confirmed', 'failed', 'rejected', 'unknown', 'mismatch']
const unresolved = (a: ApprovalAttempt) => a.status === 'awaiting_wallet' || a.status === 'pending' || a.status === 'unknown'
export const APPROVAL_STORAGE_PREFIX = 'machina.uniswap.arc.approvals.v1:'
const storageKey = (owner: string) => `${APPROVAL_STORAGE_PREFIX}${owner.toLowerCase()}`
const archiveKey = (owner: string) => `machina.uniswap.arc.approvals.archive.v1:${owner.toLowerCase()}`
const stop = (code: string): never => { throw new Error(code) }
export const APPROVAL_CHECK_MS = 5000
export const APPROVAL_TRANSIENT_DELAYS_MS = [5000, 10000, 20000, 40000, 60000]
export const APPROVAL_MAX_FAILURES = 8

export function approvalMessage(code: string): string {
  const messages: Record<string, string> = {
    writes_disabled: 'Swap execution is switched off in this build. No approval was requested.',
    pilot_restricted: 'Execution is limited to the controlled pilot. No approval was requested.',
    context: 'The wallet, network or swap inputs changed. Start the approval again for the current wallet.',
    busy: 'Another approval or swap transaction for this wallet is still unresolved. Wait for its final status before approving again.',
    recovery_unknown: 'The network does not know that hash (yet), so it was not saved and nothing was changed. Check the hash in your wallet or on Arc Explorer, then paste it again.',
    expired: 'This approval review expired. Review it again before confirming.',
    not_needed: 'No approval is needed for this swap.',
    complete: 'The approvals this swap needs are already in place.',
    insufficient_balance: 'The wallet does not hold enough of the input token for this swap.',
    insufficient_fee: 'The wallet cannot cover the network fee for this approval. No wallet request was started.',
    changed: 'The on-chain approval state changed since the review. Review it again.',
    nonce: 'The account nonce changed since Review. Check recent transactions before reviewing again. No transaction was requested.',
    storage: 'The local approval record could not be saved, so no wallet request was made.',
    lock: 'Another tab is already handling a transaction for this wallet.',
    reads: 'The current approval state could not be read from Arc. No wallet request was made.',
    smart_wallet: 'This flow supports externally owned wallets only.',
    wallet_timeout: 'The wallet request is still open or unanswered. Check your wallet; the approval is treated as unresolved.',
    rejected: 'The wallet request was rejected. No approval was made.',
    verification: 'The approval status could not be verified yet. It is shown as unresolved and no new approval is allowed until it is verified.',
  }
  return messages[code] ?? messages.reads
}
function validateApprovalAttempt(value: unknown, owner: string): ApprovalAttempt {
  const a = value as ApprovalAttempt
  const allowed = ['id', 'owner', 'step', 'transaction', 'nonce', 'status', 'createdAt', 'gas', 'maxFeePerGas', 'maxPriorityFeePerGas', 'networkFee', 'hash', 'fee', 'blockNumber', 'log', 'note']
  if (!a || typeof a !== 'object' || Object.keys(a).some(k => !allowed.includes(k)) || typeof a.id !== 'string' || a.id.length > 64 || !sameAddress(a.owner, owner) ||
    !STATUSES.includes(a.status) || !Number.isSafeInteger(a.nonce) || a.nonce < 0 || !Number.isSafeInteger(a.createdAt)) stop('storage')
  for (const key of ['gas', 'maxFeePerGas', 'maxPriorityFeePerGas', 'networkFee'] as const) if (!/^\d{1,78}$/.test(a[key])) stop('storage')
  if (a.hash !== undefined && !isHash(a.hash)) stop('storage')
  if (a.fee !== undefined && !/^\d{1,78}$/.test(a.fee)) stop('storage')
  if (a.blockNumber !== undefined && !/^\d{1,78}$/.test(a.blockNumber)) stop('storage')
  if (a.note !== undefined && (typeof a.note !== 'string' || a.note.length > 300)) stop('storage')
  if (a.log !== undefined && (!Array.isArray(a.log) || a.log.length > 40 || a.log.some(l => !l || !Number.isSafeInteger(l.at) || !STATUSES.includes(l.status) || typeof l.note !== 'string' || l.note.length > 300))) stop('storage')
  const decoded = decodeApprovalTransaction(a.transaction), step = a.step
  if (!decoded || !step || decoded.kind !== step.kind || decoded.token !== step.token || decoded.amount !== step.amount || decoded.expiration !== step.expiration || !sameAddress(decoded.spender, step.spender) ||
    !sameAddress(a.transaction.from, owner) || a.transaction.chainId !== 5042) stop('storage')
  return structuredClone(a)
}
export function createApprovalJournal(storage: ApprovalPorts['storage'], pinned: (id: string) => boolean = () => false) {
  function read(owner: string): ApprovalAttempt[] {
    try {
      const raw = storage.getItem(storageKey(owner))
      if (raw === null) return []
      if (raw.length > 524288) return stop('storage')
      const data = JSON.parse(raw)
      if (!Array.isArray(data) || data.length > 20) return stop('storage')
      const records = data.map(a => validateApprovalAttempt(a, owner))
      if (new Set(records.map(a => a.id)).size !== records.length) return stop('storage')
      return records
    } catch { return stop('storage') }
  }
  return { read, save(attempt: ApprovalAttempt) {
    try {
      const checked = validateApprovalAttempt(attempt, attempt.owner), records = read(attempt.owner).filter(a => a.id !== checked.id)
      if (records.length >= 20) {
        const i = records.findIndex(a => !unresolved(a) && !pinned(a.id)); if (i < 0) return stop('storage') // a record this session could not re-verify stays
        archiveRecord(storage, archiveKey(attempt.owner), records[i], value => validateApprovalAttempt(value, attempt.owner)) // moved, never deleted
        records.splice(i, 1)
      }
      records.push(checked)
      const text = JSON.stringify(records)
      storage.setItem(storageKey(attempt.owner), text)
      if (storage.getItem(storageKey(attempt.owner)) !== text) stop('storage')
    } catch { stop('storage') }
  }, archived(owner: string): ApprovalAttempt[] {
    try { const active = new Set(read(owner).map(a => a.id)); return readArchive(storage, archiveKey(owner), value => validateApprovalAttempt(value, owner)).filter(a => !active.has(a.id)) } catch { return stop('storage') }
  }, archiveUnreadable(owner: string): number {
    try { return archiveUnreadable(storage, archiveKey(owner), value => validateApprovalAttempt(value, owner)) } catch { return stop('storage') }
  } }
}
export interface StoredApprovals { owner: string; attempts: ApprovalAttempt[]; archived: ApprovalAttempt[]; unreadable: boolean; archiveUnreadable?: number }
export function listStoredApprovals(storage: Pick<Storage, 'getItem' | 'key' | 'length'>): StoredApprovals[] {
  const owners: string[] = []
  try {
    for (let i = 0; i < Math.min(storage.length, 512); i++) {
      const key = storage.key(i)
      if (key?.startsWith(APPROVAL_STORAGE_PREFIX) && /^0x[a-f0-9]{40}$/.test(key.slice(APPROVAL_STORAGE_PREFIX.length))) owners.push(key.slice(APPROVAL_STORAGE_PREFIX.length))
    }
  } catch { return [] }
  return owners.slice(0, 16).map(owner => {
    const journal = createApprovalJournal({ getItem: k => storage.getItem(k), setItem: () => stop('storage') })
    let attempts: ApprovalAttempt[], archived: ApprovalAttempt[] = [], archiveUnreadable = 0, unreadable = false
    try { attempts = journal.read(owner) } catch { return { owner, attempts: [], archived: [], unreadable: true } }
    try { archived = journal.archived(owner); archiveUnreadable = journal.archiveUnreadable(owner) } catch { unreadable = true }
    return { owner, attempts, archived, unreadable, archiveUnreadable }
  })
}

export function createUniswapApprovals(ports: ApprovalPorts) {
  const journal = createApprovalJournal(ports.storage, id => unverified.has(id))
  let view: ApprovalView = { phase: 'idle' }, version = 0, busy = false, tracking = false
  let intent: { review: ApprovalReview; context: string; version: number } | null = null
  const unverified = new Set<string>(), failures = new Map<string, number>()
  const blocking = (a: ApprovalAttempt) => unresolved(a) || unverified.has(a.id)
  const contextKey = () => { const c = ports.context(); return JSON.stringify([c.owner.toLowerCase(), c.connected, c.chainId, c.connectorId]) }
  const emit = (next: ApprovalView) => { view = structuredClone(next); try { ports.changed?.(structuredClone(view)) } catch { /* Observer cannot interrupt recording. */ } }
  const withLog = (a: ApprovalAttempt, status: AttemptStatus, note: string): ApprovalAttempt =>
    a.status === status && a.log?.length ? { ...a, status } : { ...a, status, log: [...(a.log ?? []), { at: ports.now(), status, note }].slice(-40) }
  // A swap record that is not settled holds the nonce; if it cannot be read, the answer is "held" (fail closed).
  const heldElsewhere = (owner: string) => { try { return ports.blockedBy?.(owner) === true } catch { return true } }
  function authorized(request: ArcRequest) {
    const context = ports.context()
    if (!context.connected || context.chainId !== 5042 || !sameAddress(context.owner, request.owner)) stop('context')
    if (!ports.authorize(request, context)) stop('pilot_restricted')
  }
  const code = (error: unknown) => error instanceof Error ? error.message : ''
  function failureMessage(error: unknown) {
    if (error instanceof WalletRpcFailure) return `Nonce check: ${walletRpcMessage(error)}`
    if (error instanceof ExecutionNonceObservationError) return `Nonce check: ${approvalMessage('nonce')}`
    const c = code(error)
    return approvalMessage(['nonce', 'nonce_rpc', 'nonce_pending', 'nonce_regression', 'public_nonce', 'wallet_nonce'].includes(c) ? 'nonce' : c)
  }
  async function currentStep(request: ArcRequest, owner: Hex): Promise<{ step: ApprovalStep; remaining: number; reads: ApprovalReads }> {
    let reads: ApprovalReads
    try { reads = await ports.reads(owner, request.tokenIn) } catch { return stop('reads') }
    const plan = planApprovals(request, reads)
    if (plan.state === 'native_input') return stop('not_needed')
    if (plan.state === 'blocked') return stop('insufficient_balance')
    if (plan.state === 'complete') return stop('complete')
    const step = validateApprovalStep(plan.steps[0], request, Number(reads.timestamp) * 1000)
    return { step, remaining: plan.steps.length, reads }
  }
  async function inspect(requestInput: ArcRequest) {
    const request = validateArcRequest(requestInput), reads = await ports.reads(request.owner as Hex, request.tokenIn)
    return { plan: planApprovals(request, reads), allowanceNotice: existingAllowanceNotice(request, reads.tokenAllowance) }
  }
  async function plan(requestInput: ArcRequest): Promise<ApprovalPlan> { return (await inspect(requestInput)).plan }
  async function prepare(requestInput: ArcRequest) {
    if (busy || tracking) return
    busy = true
    const current = ++version
    intent = null
    try {
      const request = validateArcRequest(requestInput), owner = request.owner as Hex, expected = contextKey()
      authorized(request)
      const outstanding = journal.read(owner).find(blocking)
      if (outstanding) { emit({ phase: outstanding.hash ? 'pending' : 'unknown', attempt: outstanding, error: approvalMessage('busy') }); return }
      if (heldElsewhere(owner)) { emit({ phase: 'idle', error: approvalMessage('busy') }); return }
      emit({ phase: 'preparing' })
      const { step, remaining, reads } = await currentStep(request, owner)
      const transaction = approvalTransaction(owner, step)
      let estimate: bigint
      try { estimate = await ports.estimate(transaction) } catch { return stop('reads') }
      const gas = estimate * 3n / 2n
      const maxFee = reads.gasPrice * 2n, fee = gas * maxFee
      if (estimate <= 0n || gas > APPROVAL_GAS_CEILING || maxFee <= 0n || fee > APPROVAL_FEE_CEILING) stop('reads')
      if (reads.nativeBalance < fee) stop('insufficient_fee')
      const [publicState, walletState] = [await ports.nonces(owner), await walletIdentity(await ports.provider(), owner)]
      const nonce = reconcileExecutionNonce(publicState, walletState)
      if (current !== version || contextKey() !== expected) stop('context')
      const review: ApprovalReview = { id: crypto.randomUUID(), step, request, transaction, nonce, gas: gas.toString(), maxFeePerGas: maxFee.toString(), maxPriorityFeePerGas: '0',
        networkFee: fee.toString(), estimatedNetworkFee: (estimate * reads.gasPrice).toString(), nativeBalance: reads.nativeBalance.toString(), expiresAt: ports.now() + APPROVAL_REVIEW_TTL_MS, remaining }
      intent = { review, context: expected, version: current }
      emit({ phase: 'review', review })
    } catch (error) { if (current === version) emit({ phase: 'idle', error: failureMessage(error) }) }
    finally { busy = false }
  }
  async function confirm(id: string) {
    if (busy || tracking || !intent || view.phase !== 'review' || intent.review.id !== id) return
    busy = true
    const selected = intent
    let record: ApprovalAttempt | undefined, requested = false
    try {
      const { review } = selected, request = review.request, owner = request.owner as Hex
      if (review.step.kind !== 'token') stop('changed')
      const ready = () => {
        authorized(request)
        if (selected.version !== version || contextKey() !== selected.context) stop('context')
        if (ports.now() >= review.expiresAt) stop('expired')
      }
      ready()
      emit({ phase: 'checking', review })
      await ports.lock(owner, async () => {
        ready()
        if (journal.read(owner).some(blocking) || heldElsewhere(owner)) stop('busy')
        // The chain must still need exactly this step, and nothing about the account may have moved.
        const fresh = await currentStep(request, owner)
        if (JSON.stringify([fresh.step.kind, fresh.step.token, fresh.step.spender, fresh.step.amount]) !== JSON.stringify([review.step.kind, review.step.token, review.step.spender, review.step.amount])) stop('changed')
        const provider = await ports.provider()
        const nonce = reconcileExecutionNonce(await ports.nonces(owner), await walletIdentity(provider, owner), review.nonce)
        ready()
        if (heldElsewhere(owner)) stop('busy')
        const sent = { chainId: toHex(5042), from: owner, to: review.transaction.to, data: review.transaction.data, value: '0x0', gas: toHex(BigInt(review.gas)), nonce: toHex(nonce),
          type: '0x2', maxFeePerGas: toHex(BigInt(review.maxFeePerGas)), maxPriorityFeePerGas: toHex(BigInt(review.maxPriorityFeePerGas)) }
        const decoded = decodeApprovalTransaction({ to: sent.to, data: sent.data, value: sent.value })
        if (!decoded || JSON.stringify([decoded.kind, decoded.token, decoded.spender.toLowerCase(), decoded.amount, decoded.expiration]) !== JSON.stringify([review.step.kind, review.step.token, review.step.spender.toLowerCase(), review.step.amount, review.step.expiration])) stop('changed')
        record = { id: review.id, owner, step: review.step, transaction: review.transaction, nonce, status: 'awaiting_wallet', createdAt: ports.now(), gas: review.gas,
          maxFeePerGas: review.maxFeePerGas, maxPriorityFeePerGas: review.maxPriorityFeePerGas, networkFee: review.networkFee, log: [{ at: ports.now(), status: 'awaiting_wallet', note: 'Wallet request opened' }] }
        journal.save(record) // Durable BEFORE the only wallet write call.
        intent = null; requested = true
        emit({ phase: 'awaiting_wallet', attempt: record, walletRequestOpen: true })
        try {
          const hash = await provider.request({ method: 'eth_sendTransaction', params: [sent] })
          if (!isHash(hash)) throw new Error('hash')
          record = withLog({ ...record, hash }, 'pending', 'Submitted to the network')
          emit({ phase: 'pending', attempt: record, nextCheckMs: APPROVAL_CHECK_MS }) // the hash is shown before anything else can fail
          try { journal.save(record) } catch { emit({ phase: 'pending', attempt: record, nextCheckMs: APPROVAL_CHECK_MS, error: approvalMessage('storage') }) }
        } catch (error) {
          const rejected = (error as { code?: unknown })?.code === 4001
          record = withLog(record, rejected ? 'rejected' : 'unknown', rejected ? 'Rejected in the wallet' : 'The wallet did not return a hash')
          emit({ phase: record.status, attempt: record, error: approvalMessage(rejected ? 'rejected' : 'wallet_timeout') })
          try { journal.save(record) } catch { /* The durable awaiting_wallet record still blocks. */ }
        }
      })
    } catch (error) {
      if (!requested) emit({ phase: 'idle', error: failureMessage(error) })
    } finally { busy = false }
  }
  async function reconcile(ownerInput?: string, id?: string) {
    const owner = ownerInput ?? ports.context().owner
    if (!owner || tracking) return
    tracking = true
    try {
      let records: ApprovalAttempt[]
      try { records = journal.read(owner) } catch { emit({ phase: 'idle', error: approvalMessage('storage') }); return }
      // A hash the wallet returned but the journal could not record is still tracked from memory.
      const known = (a: ApprovalAttempt): ApprovalAttempt => (!a.hash && view.attempt?.id === a.id && view.attempt.hash ? { ...a, hash: view.attempt.hash } : a)
      for (const stored of records.map(known).filter(a => (id ? a.id === id : unresolved(a) || a.status === 'mismatch') && a.hash)) {
        emit({ ...view, phase: stored.status === 'awaiting_wallet' ? 'unknown' : stored.status, attempt: stored, checking: true })
        try {
          const outcome = await ports.result(stored)
          failures.delete(stored.id); unverified.delete(stored.id)
          let next: ApprovalAttempt
          if (outcome.status === 'pending') next = withLog(stored, 'pending', 'Still pending')
          else if (outcome.state === 'reverted') next = { ...withLog(stored, 'failed', 'Reverted on chain'), fee: outcome.fee, blockNumber: outcome.blockNumber }
          else if (outcome.bound && outcome.allowanceOk) next = { ...withLog(stored, 'confirmed', 'Confirmed: matches the reviewed approval'), fee: outcome.fee, blockNumber: outcome.blockNumber }
          else next = { ...withLog(stored, 'mismatch', 'Blockchain transaction succeeded, but it is not the reviewed approval'), fee: outcome.fee, blockNumber: outcome.blockNumber, note: outcome.bound ? 'The chain does not hold exactly the approved allowance.' : 'The transaction differs from the reviewed approval.' }
          if (next.status !== stored.status || next.fee !== stored.fee) journal.save(next)
          emit({ phase: next.status, attempt: next, checking: false, observedAt: ports.now(), nextCheckMs: next.status === 'pending' ? APPROVAL_CHECK_MS : null })
          if (['confirmed', 'failed', 'mismatch'].includes(next.status)) { try { ports.settled?.(structuredClone(next)) } catch { /* refresh only */ } }
        } catch (error) {
          const retryable = !(error instanceof ExecutionVerificationError) || error.retryable
          const count = (failures.get(stored.id) ?? 0) + 1
          if (stored.status !== 'pending' || !retryable) unverified.add(stored.id)
          if (retryable) failures.set(stored.id, count)
          const delay = retryable && count < APPROVAL_MAX_FAILURES ? APPROVAL_TRANSIENT_DELAYS_MS[Math.min(count - 1, APPROVAL_TRANSIENT_DELAYS_MS.length - 1)] : null
          emit({ phase: stored.status, attempt: stored, checking: false, observedAt: ports.now(), nextCheckMs: delay, error: approvalMessage('verification') })
        }
      }
    } finally { tracking = false }
  }
  // A wallet request whose hash was never returned: the user pastes the hash their wallet shows. It is accepted only if the public
  // chain shows that exact hash is the reviewed approval from this wallet at the recorded nonce (verified by the same result check).
  async function recover(ownerInput: string, hashInput: string) {
    const owner = ownerInput
    if (tracking || busy || !isHash(hashInput)) { emit({ ...view, error: approvalMessage('verification') }); return }
    const target = journal.read(owner).find(a => unresolved(a) && !a.hash)
    if (!target) return
    tracking = true
    try {
      const candidate = { ...target, hash: hashInput as Hex }
      const outcome = await ports.result(candidate)
      // A hash the network has never shown is not saved: it would replace the means of finding the real transaction.
      if (outcome.status === 'pending' && outcome.identified !== true) { emit({ ...view, phase: target.status, attempt: target, error: approvalMessage('recovery_unknown') }); return }
      const next = outcome.status === 'pending' ? withLog(candidate, 'pending', 'Hash supplied by the user; still pending') : withLog(candidate, 'unknown', 'Hash supplied by the user; verifying')
      journal.save(next)
      emit({ phase: next.status, attempt: next, nextCheckMs: APPROVAL_CHECK_MS })
    } catch { emit({ ...view, error: approvalMessage('verification') }) }
    finally { tracking = false }
    await reconcile(owner)
  }
  return {
    view: () => structuredClone(view), plan, inspect, prepare, confirm, reconcile, recover,
    history: (owner: string) => journal.read(owner),
    blocking: (owner: string) => { try { return journal.read(owner).some(blocking) } catch { return true } },
    invalidate() { version++; intent = null; if (['review', 'checking', 'preparing'].includes(view.phase)) emit({ phase: 'idle' }) },
  }
}
