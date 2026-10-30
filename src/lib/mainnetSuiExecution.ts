// Shared Sui/Arc write lifecycle. Ports never own retry or user consent. The
// production factory keeps the source gate closed; controlled tests inject ports.
import { keccak256, type Hex } from 'viem'
import { MAINNET_SUI_CCTP_WRITES_ENABLED } from '../config/sui'

export type SuiWriteAction = 'sui-burn' | 'arc-approval' | 'arc-burn' | 'sui-mint' | 'arc-mint'
export type SuiWriteIntent = {
  action: SuiWriteAction; suiOwner: string; evmOwner: string
  amount: bigint; maxCctpFee: bigint; gasCeiling: bigint
  // Required for mint. Original source digest/hash, never a new burn request.
  sourceId?: string
  // Arc only. Undefined means 'sign-only'. Part of the reviewed intent: changing
  // it invalidates the Review; the controller never switches it by itself.
  arcMethod?: SuiArcMethod
}
// 'sign-only': eth_signTransaction; exact signed bytes are bound BEFORE broadcast.
// 'wallet-send': eth_sendTransaction; the wallet signs AND broadcasts, so the
// sent fields can only be checked AFTER broadcast. That is a weaker guarantee.
export type SuiArcMethod = 'sign-only' | 'wallet-send'
// Durable, non-secret description of the reviewed Arc transaction, persisted
// BEFORE a wallet-send request so a lost hash can be investigated read-only.
export type SuiArcExpected = { to: Hex; dataHash: Hex; nonce: number; gas: bigint; maxFeePerGas: bigint; fromBlock: bigint; cctpNonce?: Hex }
export type SuiWritePrepared = {
  bytes: Uint8Array; digest?: string; estimatedGas: bigint; maximumGas: bigint
  // Decoded from these exact bytes for the Review; display only, never authority.
  content?: readonly string[]
  // Includes current chain/nonce/deployment identity, not a provider URL.
  binding: string; expiresAt: number
  arc?: SuiArcExpected
}
export type SuiWriteReview = Readonly<{
  id: string; intent: Readonly<SuiWriteIntent>; commitment: Hex
  estimatedGas: bigint; maximumGas: bigint; expiresAt: number
  digest?: string; content: readonly string[]
}>
export type SuiWriteAttempt = {
  id: string; intent: SuiWriteIntent; commitment: Hex; createdAt: number
  // 'sending': an eth_sendTransaction request may have reached the wallet.
  // 'mismatch': the wallet broadcast a transaction whose fields differ from the
  // Review. NEVER a success and NEVER a release: it keeps the journal locked
  // until an explicit, evidence-based reconciliation ('reconciled').
  // 'reconciled': a mismatch whose canonical effects and nonce state were
  // independently proven and acknowledged by the user. Still not a success.
  state: 'signing' | 'sending' | 'broadcasting' | 'unknown' | 'pending' | 'verified' | 'reverted' | 'rejected' | 'mismatch' | 'reconciled'
  digest?: string
  expected?: SuiArcExpected
}
export type SuiWritePort = {
  prepare(intent: SuiWriteIntent): Promise<SuiWritePrepared>
  recheck(intent: SuiWriteIntent, prepared: SuiWritePrepared): Promise<void>
  sign(intent: SuiWriteIntent, bytes: Uint8Array, signal: AbortSignal): Promise<{ bytes: Uint8Array; signature: string }>
  validateSigned(intent: SuiWriteIntent, prepared: SuiWritePrepared, signed: { bytes: Uint8Array; signature: string }): Promise<string>
  broadcast(intent: SuiWriteIntent, signed: { bytes: Uint8Array; signature: string }, digest: string): Promise<void>
  // Must use independent canonical chain evidence, not a wallet/execute response.
  recover(attempt: SuiWriteAttempt): Promise<'pending' | 'verified' | 'reverted' | 'mismatch'>
  // wallet-send only. Exactly one eth_sendTransaction; returns the wallet's hash.
  send?(intent: SuiWriteIntent, prepared: SuiWritePrepared): Promise<string>
  // wallet-send only. Read-only search for the hash of a lost send; null when
  // the reviewed nonce is not provably consumed by one identifiable transaction.
  locate?(attempt: SuiWriteAttempt): Promise<string | null>
  // mismatch only. Read-only evidence; throws when anything is undetermined.
  reconcile?(attempt: SuiWriteAttempt): Promise<SuiWriteReconciliation>
}
// Independent, read-only proof of what a mismatched transaction did. The key
// binds every line; a release requires the user to acknowledge THIS key and a
// fresh re-read to produce exactly the same key.
export type SuiWriteReconciliation = Readonly<{ key: Hex; digest: string; lines: readonly string[] }>
export type SuiWriteEnvironment = {
  gate(): boolean
  current(intent: SuiWriteIntent): boolean
  lock<T>(owner: string, fn: () => Promise<T>): Promise<T>
  load(): SuiWriteAttempt | null
  save(attempt: SuiWriteAttempt): void
  now(): number
}
export class SuiWriteSignatureRejected extends Error {
  constructor(readonly reason: 'user' | 'unsupported') { super(reason === 'user' ? 'Wallet signature rejected. No transaction was broadcast by this controller.' : 'This wallet cannot sign separately from sending. This transfer remains blocked; no send fallback is allowed.') }
}
// The port proves no wallet request was issued (e.g. account/chain changed first).
export class SuiWriteNotRequested extends Error {}
// 'mismatch' is deliberately NOT final: it blocks every new preparation.
const FINAL = ['verified', 'reverted', 'rejected', 'reconciled']
const STATES = ['signing', 'sending', 'broadcasting', 'unknown', 'pending', 'mismatch', ...FINAL]
const unresolved = (a: SuiWriteAttempt | null) => a && !FINAL.includes(a.state)
const commitment = (bytes: Uint8Array) => keccak256(bytes)
function cleanIntent(i: SuiWriteIntent): SuiWriteIntent {
  return { action: i.action, suiOwner: i.suiOwner, evmOwner: i.evmOwner, amount: i.amount, maxCctpFee: i.maxCctpFee, gasCeiling: i.gasCeiling, ...(i.sourceId === undefined ? {} : { sourceId: i.sourceId }), ...(i.arcMethod === undefined ? {} : { arcMethod: i.arcMethod }) }
}
function validateIntent(i: SuiWriteIntent) {
  if (!['sui-burn', 'arc-approval', 'arc-burn', 'sui-mint', 'arc-mint'].includes(i.action) || !/^0x[0-9a-f]{64}$/i.test(i.suiOwner) || !/^0x[0-9a-f]{40}$/i.test(i.evmOwner) || /^0x0+$/i.test(i.suiOwner) || /^0x0+$/i.test(i.evmOwner) || typeof i.amount !== 'bigint' || i.amount <= 0n || i.amount >= 1n << 64n || typeof i.maxCctpFee !== 'bigint' || i.maxCctpFee < 0n || i.maxCctpFee >= i.amount || typeof i.gasCeiling !== 'bigint' || i.gasCeiling <= 0n || i.gasCeiling >= 1n << 64n) throw new Error('Invalid Sui/Arc transfer or explicit gas ceiling.')
  if (i.arcMethod !== undefined && (!i.action.startsWith('arc-') || !['sign-only', 'wallet-send'].includes(i.arcMethod))) throw new Error('Arc execution method is invalid for this transfer step.')
  if (i.action.endsWith('mint') && !i.sourceId) throw new Error('Mint requires an independently verified original source transaction.')
  if (i.sourceId !== undefined && (typeof i.sourceId !== 'string' || (i.action === 'sui-mint' ? !/^0x[0-9a-f]{64}$/i.test(i.sourceId) : !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(i.sourceId)))) throw new Error('Source transaction identity has an invalid encoding for this route.')
}
const HASH = /^0x[0-9a-f]{64}$/
const dec = (v: unknown) => { if (typeof v !== 'string' || !/^(0|[1-9][0-9]{0,38})$/.test(v)) throw new Error(); return BigInt(v) }
function validExpected(e: unknown): e is SuiArcExpected {
  const x = e as SuiArcExpected
  return Boolean(x) && /^0x[0-9a-f]{40}$/i.test(x.to) && HASH.test(x.dataHash) && Number.isSafeInteger(x.nonce) && x.nonce >= 0 && [x.gas, x.maxFeePerGas, x.fromBlock].every(v => typeof v === 'bigint' && v >= 0n && v < 1n << 128n) && x.gas > 0n && x.maxFeePerGas > 0n && (x.cctpNonce === undefined || HASH.test(x.cctpNonce))
}
async function bounded<T>(run: () => Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try { return await Promise.race([Promise.resolve().then(run), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms) })]) }
  finally { clearTimeout(timer) }
}

export function createSuiWriteController(port: SuiWritePort, env: SuiWriteEnvironment, options: { walletSendTimeoutMs?: number } = {}) {
  let generation = 0, active = false
  let held: { review: SuiWriteReview; prepared: SuiWritePrepared; generation: number } | undefined
  function current(i: SuiWriteIntent, id: number, expiry: number) {
    if (generation !== id || !env.current(i)) throw new Error('Wallet, chain or transfer inputs changed. Review again; nothing further will be sent.')
    if (env.now() >= expiry) throw new Error('Transfer review expired. No stale transaction will be sent.')
  }
  // eth_sendTransaction: the wallet signs AND broadcasts. The reviewed fields are
  // persisted first; the returned hash is checked against them only afterwards
  // (recover). This cannot prevent a wallet from broadcasting different fields.
  async function walletSend(intent: SuiWriteIntent, p: SuiWritePrepared, review: SuiWriteReview): Promise<SuiWriteAttempt> {
    if (!port.send || !validExpected(p.arc)) throw new Error('This transfer cannot be sent through the wallet.')
    let attempt: SuiWriteAttempt = { id: review.id, intent: { ...intent }, commitment: review.commitment, createdAt: env.now(), state: 'sending', expected: { ...p.arc } }
    env.save(attempt) // Durable intent BEFORE the only wallet request; a failed write stops here.
    held = undefined
    const request = Promise.resolve().then(() => port.send!(intent, p))
    // A wallet answer arriving after the timeout is recorded, never re-sent.
    request.then(hash => { try { const cur = env.load(); if (cur?.id === attempt.id && cur.state === 'unknown' && !cur.digest && HASH.test(hash)) env.save({ ...cur, state: 'pending', digest: hash }) } catch { /* journal stays unknown */ } }, () => {})
    let hash: string
    try { hash = await bounded(() => request, options.walletSendTimeoutMs ?? 180_000, 'Wallet did not answer.') }
    catch (error) {
      const rejected = error instanceof SuiWriteSignatureRejected, notSent = error instanceof SuiWriteNotRequested
      attempt = { ...attempt, state: rejected || notSent ? 'rejected' : 'unknown' }; env.save(attempt)
      if (rejected) throw error
      if (notSent) throw new Error((error as Error).message || 'Nothing was sent.')
      throw new Error('Transfer outcome needs checking. No automatic second signature or transaction will be requested.')
    }
    if (typeof hash !== 'string' || !HASH.test(hash)) { attempt = { ...attempt, state: 'unknown' }; env.save(attempt); throw new Error('Wallet returned no valid transaction hash. Outcome unknown; nothing will be sent again.') }
    // Recorded whatever happens next: the wallet has already broadcast it.
    attempt = { ...attempt, state: 'pending', digest: hash }; env.save(attempt)
    return attempt
  }
  return {
    invalidate() { generation++; held = undefined },
    async prepare(input: SuiWriteIntent): Promise<SuiWriteReview> {
      if (active) throw new Error('A wallet operation is already active.')
      validateIntent(input)
      if (unresolved(env.load())) throw new Error('An earlier wallet operation is unresolved. Recover it before preparing another transfer.')
      const i = Object.freeze(cleanIntent(input)), id = ++generation
      held = undefined; active = true
      try {
        const p = await bounded(() => port.prepare(i), 45_000, 'Transfer preparation timed out. No wallet request was made.')
        if (!(p.bytes instanceof Uint8Array) || !p.bytes.length || p.bytes.length > 131072 || !p.binding || !Number.isSafeInteger(p.expiresAt) || p.expiresAt > env.now() + 120_000 || p.maximumGas <= 0n || p.maximumGas > i.gasCeiling || p.estimatedGas < 0n || p.estimatedGas > p.maximumGas) throw new Error('No bounded, simulated transfer can be reviewed.')
        current(i, id, p.expiresAt)
        if (i.arcMethod === 'wallet-send' && !validExpected(p.arc)) throw new Error('No durable wallet-send description can be reviewed.')
        if (p.content !== undefined && (!Array.isArray(p.content) || p.content.length > 40 || p.content.some(l => typeof l !== 'string' || l.length > 400))) throw new Error('No bounded, simulated transfer can be reviewed.')
        const review = Object.freeze({ id: crypto.randomUUID(), intent: i, commitment: commitment(p.bytes), estimatedGas: p.estimatedGas, maximumGas: p.maximumGas, expiresAt: p.expiresAt, digest: p.digest, content: Object.freeze([...(p.content ?? [])]) })
        held = { review, prepared: { ...p, bytes: p.bytes.slice() }, generation: id }
        return review
      } finally { active = false }
    },
    // Explicit caller action only. Review identity, not a caller-supplied payload.
    async confirm(review: SuiWriteReview): Promise<SuiWriteAttempt> {
      if (!env.gate()) throw new Error('Sui Mainnet writes remain disabled. No wallet request was made.')
      const h = held
      if (active || !h || h.review !== review) throw new Error('No current approved review or an operation is already active.')
      active = true
      try {
        return await env.lock(`${review.intent.suiOwner.toLowerCase()}:${review.intent.evmOwner.toLowerCase()}`, async () => {
          if (unresolved(env.load())) throw new Error('An earlier transfer needs recovery. No second wallet request is allowed.')
          const { intent } = review, p = h.prepared
          const check = () => { if (!env.gate()) throw new Error('Sui write gate closed.'); current(intent, h.generation, p.expiresAt); if (commitment(p.bytes) !== review.commitment) throw new Error('Prepared transaction bytes changed.') }
          check()
          await bounded(() => port.recheck(intent, p), 45_000, 'Pre-sign verification timed out.')
          check()
          if (intent.arcMethod === 'wallet-send') return await walletSend(intent, p, review)
          let attempt: SuiWriteAttempt = { id: review.id, intent: { ...intent }, commitment: review.commitment, createdAt: env.now(), state: 'signing', digest: p.digest }
          env.save(attempt) // Fail closed BEFORE requesting a signature.
          held = undefined
          const abort = new AbortController()
          let signed: { bytes: Uint8Array; signature: string } | undefined
          try {
            signed = await bounded(() => port.sign(intent, p.bytes.slice(), abort.signal), Math.min(90_000, p.expiresAt - env.now()), 'Wallet signing timed out. Recover this attempt; no automatic resend.')
            check()
            const digest = await port.validateSigned(intent, p, signed)
            if (!digest || (p.digest && p.digest !== digest)) throw new Error('Signed transaction does not match the reviewed digest.')
            // Re-read balances, deployment, nonce and simulate EXACT signed bytes.
            await bounded(() => port.recheck(intent, p), 45_000, 'Post-sign verification timed out. Nothing was broadcast by this controller.')
            check()
            attempt = { ...attempt, state: 'broadcasting', digest }
            env.save(attempt) // Known digest is durable BEFORE the only broadcast.
            await bounded(() => port.broadcast(intent, signed!, digest), 15_000, 'Submission result unknown. Check the recorded transaction; do not submit again.')
            attempt = { ...attempt, state: 'pending' }; env.save(attempt)
            return attempt
          } catch (error) {
            // Wallet rejection, RPC failures and lost responses cannot authorize
            // another send. No provider error/payload is logged or persisted.
            attempt = { ...attempt, state: !signed && error instanceof SuiWriteSignatureRejected ? 'rejected' : 'unknown' }; env.save(attempt)
            if (error instanceof SuiWriteSignatureRejected && !signed) throw error
            throw new Error('Transfer outcome needs checking. No automatic second signature or transaction will be requested.')
          } finally { abort.abort(); signed = undefined }
        })
      } finally { active = false }
    },
    // Manual reconciliation of a mismatch. Without `acknowledged` it only reads
    // evidence. With the key the user saw, it re-reads everything and releases
    // the lock only if the fresh evidence is identical. Never sends anything.
    async reconcile(acknowledged?: Hex): Promise<SuiWriteReconciliation | SuiWriteAttempt> {
      if (active) throw new Error('A wallet operation is still active.')
      const a = env.load()
      if (!a || a.state !== 'mismatch' || !a.digest || a.intent.arcMethod !== 'wallet-send' || !validExpected(a.expected) || !port.reconcile) throw new Error('Only a recorded wallet-send mismatch can be reconciled.')
      if (!env.current(a.intent)) throw new Error('Reconnect the original wallets to reconcile this transfer.')
      return env.lock(`${a.intent.suiOwner.toLowerCase()}:${a.intent.evmOwner.toLowerCase()}`, async () => {
        const latest = env.load()
        if (!latest || latest.id !== a.id || latest.state !== 'mismatch') throw new Error('The transfer record changed in another tab.')
        const evidence = await bounded(() => port.reconcile!(a), 60_000, 'Reconciliation evidence unavailable. The transfer stays locked.')
        if (!evidence || !HASH.test(evidence.key) || evidence.digest !== a.digest || !Array.isArray(evidence.lines) || !evidence.lines.length || evidence.lines.length > 40) throw new Error('Reconciliation evidence is incomplete. The transfer stays locked.')
        if (acknowledged === undefined) return Object.freeze({ key: evidence.key, digest: evidence.digest, lines: Object.freeze([...evidence.lines]) })
        if (acknowledged !== evidence.key) throw new Error('Chain evidence changed since it was shown. Review it again; the transfer stays locked.')
        if (!env.current(a.intent) || env.load()?.id !== a.id || env.load()?.state !== 'mismatch') throw new Error('Wallet context or transaction record changed. The transfer stays locked.')
        const next: SuiWriteAttempt = { ...a, state: 'reconciled' }; env.save(next); return next
      })
    },
    // Read-only view of the durable journal for Review/recovery UI. Never authority.
    saved(): SuiWriteAttempt | null { return env.load() },
    async recover(): Promise<SuiWriteAttempt | null> {
      if (active) throw new Error('A wallet operation is still active.')
      const a = env.load(); if (!a) return null
      if (FINAL.includes(a.state) || a.state === 'mismatch') return a // a mismatch is never re-judged into success
      const lost = !a.digest && a.intent.arcMethod === 'wallet-send' && validExpected(a.expected) && Boolean(port.locate)
      if (!a.digest && !lost) throw new Error('The wallet attempt has no independently recoverable transaction ID. Do not send again until its outcome is established.')
      if (!env.current(a.intent)) throw new Error('Reconnect the original wallets to check this transfer.')
      // Status checks never sign, broadcast, or release an unproven attempt.
      return env.lock(`${a.intent.suiOwner.toLowerCase()}:${a.intent.evmOwner.toLowerCase()}`, async () => {
        const latest = env.load()
        if (!latest || latest.id !== a.id) throw new Error('The transfer record changed in another tab.')
        let found = a
        if (lost) {
          // Read-only: nonce consumption + CCTP/approval events + bounded block scan.
          const hash = await bounded(() => port.locate!(a), 60_000, 'Lost transaction search unavailable. Keep the record; do not send again.')
          if (!hash || !HASH.test(hash)) throw new Error('No single transaction for the reviewed nonce is proven yet. The transfer stays blocked; do not send again.')
          if (!env.current(a.intent) || env.load()?.id !== a.id) throw new Error('Wallet context or transaction record changed during recovery. Keep the earlier record.')
          found = { ...a, state: 'pending', digest: hash }; env.save(found)
        }
        const state = await bounded(() => port.recover(found), 45_000, 'Recovery unavailable. Keep the transaction record; do not send again.')
        if (!['pending', 'verified', 'reverted', 'mismatch'].includes(state)) throw new Error('Unknown recovery result.')
        if (!env.current(a.intent) || env.load()?.id !== a.id) throw new Error('Wallet context or transaction record changed during recovery. Keep the earlier record.')
        const next = { ...found, state }; env.save(next); return next
      })
    },
  }
}

// One global cross-tab wallet lock and one durable unresolved attempt. Storage
// is a journal, NOT a lock. Missing Web Locks/storage must never enable a send.
export function browserSuiWriteEnvironment(current: (i: SuiWriteIntent) => boolean): SuiWriteEnvironment {
  const key = 'machina_mainnet_sui_write_attempt_v1'
  return {
    gate: () => MAINNET_SUI_CCTP_WRITES_ENABLED,
    current, now: () => Date.now(),
    async lock(_owner, fn) {
      if (!navigator.locks) throw new Error('This browser cannot safely coordinate Sui transfers between tabs.')
      return navigator.locks.request('machina:mainnet-sui-wallet-write', { ifAvailable: true }, async lock => { if (!lock) throw new Error('Another tab has an active wallet operation.'); return fn() })
    },
    load() {
      const raw = window.localStorage.getItem(key); if (raw === null) return null
      try {
        if (raw.length > 8192) throw new Error()
        const a = JSON.parse(raw), i = a.intent
        if (!['amount','maxCctpFee','gasCeiling'].every(k => typeof i[k] === 'string' && /^(0|[1-9][0-9]*)$/.test(i[k]) && i[k].length <= 20)) throw new Error()
        const intent = cleanIntent({ ...i, amount: BigInt(i.amount), maxCctpFee: BigInt(i.maxCctpFee), gasCeiling: BigInt(i.gasCeiling) })
        validateIntent(intent)
        const x = a.expected, expected = x === undefined ? undefined : { to: x.to, dataHash: x.dataHash, nonce: x.nonce, gas: dec(x.gas), maxFeePerGas: dec(x.maxFeePerGas), fromBlock: dec(x.fromBlock), ...(x.cctpNonce === undefined ? {} : { cctpNonce: x.cctpNonce }) }
        if ((expected !== undefined && !validExpected(expected)) || (intent.arcMethod === 'wallet-send' && a.state !== 'rejected' && !expected) || !STATES.includes(a.state) || typeof a.id !== 'string' || !/^0x[0-9a-f]{64}$/.test(a.commitment) || !Number.isSafeInteger(a.createdAt) || a.createdAt <= 0 || (a.digest !== undefined && (typeof a.digest !== 'string' || a.digest.length > 80))) throw new Error()
        return { id: a.id, intent, commitment: a.commitment, createdAt: a.createdAt, state: a.state, digest: a.digest, ...(expected ? { expected } : {}) }
      } catch { throw new Error('Sui transaction journal is unreadable. Recover the wallet activity before sending again.') }
    },
    save(a) {
      // Whitelist only recovery metadata. Never store signed bytes/signatures,
      // attestation, RPC response objects or provider/session data.
      const raw = JSON.stringify({ id: a.id, intent: cleanIntent(a.intent), commitment: a.commitment, createdAt: a.createdAt, state: a.state, digest: a.digest, expected: a.expected }, (_, v) => typeof v === 'bigint' ? v.toString() : v)
      window.localStorage.setItem(key, raw)
      if (window.localStorage.getItem(key) !== raw) throw new Error('Could not persist the Sui transaction journal.')
    },
  }
}
