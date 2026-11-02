// Arc -> Solana recovery receive: evidence journal, signing wrapper and evidence-based settlement.
//
// The receive of an existing Arc burn may end with an unclear SDK error (network, timeout, wallet).
// A second receive cannot mint twice (the message nonce is consumed on chain), but Machina still
// never requests a new receive while an earlier one could land. Instead of locking forever, every
// attempt records, before the SDK can broadcast anything:
//   - the time of the real wallet request (not the Activity record's createdAt, which is kept from
//     the first record of the same source hash),
//   - the blockhash of the transaction shown to the wallet,
//   - the signature and blockhash of the signed transaction (written before it is handed back).
// An unclear attempt is settled only from chain evidence read over HTTP: the nonce (two readers,
// confirmed and finalized), the exact signature status, and blockhash validity. A failed read keeps
// the lock. Older records without this evidence are never unlocked by time: they need several
// independent chain checks and an explicit user confirmation after a plain risk warning.
import { PublicKey } from '@solana/web3.js'
import { SOLANA_MAINNET_CCTP } from '../config/mainnetSolana'
import { decodeCctpRecoveryMessage } from './mainnetCctpRecovery'
import { solanaSignatureOf } from './solanaSendGuard'

export const ARC_SOLANA_RECEIVE_KEY = 'machina_arc_solana_receive_v1'
export type ReceivePhase = 'prepared' | 'requesting' | 'signed' | 'sent' | 'unknown' | 'failed' | 'complete' | 'released'
export type ReceiveFailure = 'pre-wallet' | 'user-rejected' | 'chain-failed' | 'expired'
export type ReceiveSigned = { signature: string; blockhash?: string; lastValidBlockHeight?: number; receive: boolean; at: number }
export type ReceiveError = { name?: string; code?: string | number; message?: string; at: number }
export type ReceiveEntry = {
  id: string
  sourceTxHash: string // lower case Arc burn hash
  owner: string // Phantom wallet that receives
  phase: ReceivePhase
  createdAt: number
  updatedAt: number
  walletRequestedAt?: number // the last real request to the wallet for this attempt
  receiveRequestedAt?: number // when the receive transaction itself (not an ATA-only one) was shown to the wallet
  requestedBlockhash?: string // blockhash of that receive transaction
  signed?: ReceiveSigned[]
  signature?: string // signature of the receive transaction handed to the SDK
  failure?: ReceiveFailure
  lastError?: ReceiveError
  legacy?: boolean
  manuallyReleased?: boolean
  note?: string
}
const OPEN: ReceivePhase[] = ['prepared', 'requesting', 'signed', 'sent', 'unknown']
const ACTIVE: ReceivePhase[] = ['requesting', 'signed']

export class ReceiveLockedError extends Error {
  constructor(public reason: string) { super(`${reason} No second receive was requested.`); this.name = 'ReceiveLockedError' }
}
export class LegacyReceiveReviewRequired extends Error {
  constructor() { super('An earlier receive request from this browser has no saved signature, so it cannot be checked automatically. Review it on chain and confirm before a new receive is requested.'); this.name = 'LegacyReceiveReviewRequired' }
}

// ---- journal ----
function storage() { const s = globalThis.localStorage; if (!s) throw new Error('Browser storage is unavailable; no receive is requested.'); return s }
export function readReceiveEntries(): ReceiveEntry[] {
  const raw = storage().getItem(ARC_SOLANA_RECEIVE_KEY)
  if (!raw) return []
  const parsed = JSON.parse(raw) // unreadable journal throws: callers stop, nothing is requested
  if (!Array.isArray(parsed)) throw new Error('The receive journal is unreadable; no receive is requested.')
  return parsed
}
function persist(entry: ReceiveEntry) {
  const all = readReceiveEntries().filter(e => e.id !== entry.id)
  const keep = [entry, ...all.filter(e => OPEN.includes(e.phase)), ...all.filter(e => !OPEN.includes(e.phase)).slice(0, 40)]
  storage().setItem(ARC_SOLANA_RECEIVE_KEY, JSON.stringify(keep))
  const back = readReceiveEntries().find(e => e.id === entry.id)
  if (!back || back.phase !== entry.phase || back.signature !== entry.signature || back.walletRequestedAt !== entry.walletRequestedAt) throw new Error('The receive journal could not be saved; no receive is requested.')
  return entry
}
export function updateReceiveEntry(id: string, patch: Partial<ReceiveEntry>, now = Date.now()) {
  const current = readReceiveEntries().find(e => e.id === id)
  if (!current) throw new Error('The receive journal entry is missing; no receive is requested.')
  return persist({ ...current, ...patch, updatedAt: now })
}
export function latestReceiveEntry(sourceTxHash: string) {
  return readReceiveEntries().filter(e => e.sourceTxHash === sourceTxHash.toLowerCase()).sort((a, b) => b.createdAt - a.createdAt)[0]
}
export function createReceiveEntry(sourceTxHash: string, owner: string, now = Date.now()) {
  const id = typeof globalThis.crypto?.randomUUID === 'function' ? globalThis.crypto.randomUUID() : `recv-${now}-${Math.random().toString(36).slice(2)}`
  return persist({ id, sourceTxHash: sourceTxHash.toLowerCase(), owner, phase: 'prepared', createdAt: now, updatedAt: now })
}

// ---- error summary: the real cause, without wallet data, transaction content or secrets ----
const scrub = (text: string) => text
  .replace(/https?:\/\/[^\s"')]+/g, u => u.split(/[?#]/)[0]) // drop query strings (API keys)
  .replace(/0x[0-9a-fA-F]{24,}/g, '0x…') // hashes, calldata, addresses
  .replace(/[1-9A-HJ-NP-Za-km-z]{32,}/g, '…') // base58 keys and signatures
  .replace(/[A-Za-z0-9+/]{60,}={0,2}/g, '…') // base64 payloads
  .slice(0, 180)
export function summarizeReceiveError(error: unknown, now = Date.now()): ReceiveError {
  const e = error as any, raw = e?.cause?.trace?.rawError ?? e?.cause?.rawError
  const pick = (x: any) => (x instanceof Error || (x && typeof x === 'object') ? x : { message: String(x ?? '') })
  const inner = raw ? pick(raw) : undefined, outer = pick(e)
  const code = outer?.code ?? inner?.code
  const message = [outer?.message, inner?.message && inner.message !== outer?.message ? `cause: ${inner.message}` : ''].filter(Boolean).join(' | ')
  return { name: typeof outer?.name === 'string' ? outer.name.slice(0, 60) : undefined, code: typeof code === 'number' || typeof code === 'string' ? code : undefined, message: scrub(String(message)), at: now }
}
// Explicit wallet rejection, read from the wallet's own error before any SDK wrapping.
export function isExplicitWalletRejection(error: unknown) {
  const e = error as any
  return e?.code === 4001 || e?.code === 'ACTION_REJECTED' || /^user rejected|user denied|rejected the request|request rejected/i.test(String(e?.message ?? ''))
}

const MESSAGE_TRANSMITTER = SOLANA_MAINNET_CCTP.messageTransmitterProgram
const isReceiveTx = (tx: any) => {
  const keys: string[] = (tx?.message?.staticAccountKeys ?? []).map((k: any) => (typeof k?.toBase58 === 'function' ? k.toBase58() : String(k)))
  return (tx?.message?.compiledInstructions ?? []).some((i: any) => keys[i.programIdIndex] === MESSAGE_TRANSMITTER)
}

// The provider handed to the Bridge Kit Solana adapter. It records the real wallet request and the
// signed transaction before the SDK can broadcast it. Anything that refuses the transaction before
// this wrapper (e.g. the pre-sign policy) leaves no wallet request behind.
type Signer = { signTransaction(tx: unknown): Promise<unknown>; publicKey?: unknown; isConnected?: boolean; connect(): Promise<any>; disconnect(): Promise<void> }
export function createReceiveEvidenceSigner<P extends Signer>(provider: P, entryId: string, now: () => number = Date.now) {
  return {
    get isConnected() { return Boolean(provider.isConnected) },
    get publicKey() { return provider.publicKey },
    connect: () => provider.connect(),
    disconnect: () => provider.disconnect(),
    async signTransaction(tx: unknown) {
      const receive = isReceiveTx(tx), requested = solanaSignatureOf(tx).blockhash
      // Saved first: the wallet is asked only after the request time and blockhash are on disk.
      updateReceiveEntry(entryId, { phase: 'requesting', walletRequestedAt: now(), ...(receive ? { receiveRequestedAt: now(), ...(requested ? { requestedBlockhash: requested } : {}) } : {}) }, now())
      let signed: unknown
      try { signed = await provider.signTransaction(tx) } catch (error) {
        const rejected = isExplicitWalletRejection(error)
        try { updateReceiveEntry(entryId, rejected ? { phase: 'failed', failure: 'user-rejected', lastError: summarizeReceiveError(error, now()) } : { lastError: summarizeReceiveError(error, now()) }, now()) } catch { /* stays requesting: settled by evidence */ }
        throw error
      }
      const { signature, blockhash } = solanaSignatureOf(signed)
      if (!signature) throw new Error('The wallet returned no signature; nothing was sent.')
      const entry = readReceiveEntries().find(e => e.id === entryId)
      const record: ReceiveSigned = { signature, ...(blockhash ? { blockhash } : {}), receive, at: now() }
      // Persisted before the signed transaction is returned to the SDK; if this throws, nothing is broadcast.
      updateReceiveEntry(entryId, { phase: 'signed', signed: [...(entry?.signed ?? []), record], ...(receive ? { signature } : {}) }, now())
      return signed
    },
  }
}

// Normal SDK mint and explicit recovery share the same B2 journal. The caller
// holds the wallet locks throughout the SDK run (including ATA preparation).
export function createBoundReceiveSigner<P extends Signer>(provider: P, input: {
  prepare(): Promise<{ sourceTxHash: string; owner: string; message: string }>
  validate(tx: unknown, message: string): void
  reads: ReceiveReads
}) {
  let entryId: string | undefined, bound: string | undefined, ataRequested = false, receiveRequested = false, inFlight = false, stopped = false
  return {
    get isConnected() { return Boolean(provider.isConnected) },
    get publicKey() { return provider.publicKey },
    connect: () => provider.connect(), disconnect: () => provider.disconnect(),
    entryId: () => entryId,
    fail(error: unknown) { stopped = true; if (entryId) classifyFailedAttempt(entryId, error) },
    async signTransaction(tx: unknown) {
      if (stopped) throw new Error('The earlier destination request did not complete. Check Activity; no second wallet request is allowed.')
      if (inFlight) throw new Error('A destination wallet request is already being prepared. No second request is allowed.')
      inFlight = true
      try {
        const proof = await input.prepare()
        input.validate(tx, proof.message) // G2 must precede every B2 wallet-request record.
        const binding = `${proof.sourceTxHash.toLowerCase()}:${proof.owner}:${proof.message}`
        if (bound && bound !== binding) throw new Error('The source burn or attestation changed; no receive is allowed.')
        const receive = isReceiveTx(tx)
        if (receiveRequested || !receive && ataRequested) throw new Error('A destination wallet request was already made. Check Activity before trying again.')
        if (!entryId) {
          const gate = await openReceiveAttempt({ sourceTxHash: proof.sourceTxHash, owner: proof.owner, message: proof.message }, input.reads)
          if (gate.kind !== 'go') throw new Error('The destination nonce is already consumed. No second mint is allowed.')
          entryId = gate.entryId; bound = binding
        }
        if (receive) receiveRequested = true
        else ataRequested = true
        try { return await createReceiveEvidenceSigner(provider, entryId).signTransaction(tx) }
        catch (error) { stopped = true; throw error }
      } finally { inFlight = false }
    },
  }
}

// After the SDK call failed: a refusal before the wallet or an explicit wallet rejection sent nothing.
// Every other error stays "unknown" and is settled only by chain evidence.
export function classifyFailedAttempt(entryId: string, error: unknown, now = Date.now()) {
  const entry = readReceiveEntries().find(e => e.id === entryId)
  if (!entry) throw new Error('The receive journal entry is missing.')
  if (entry.phase === 'failed' && entry.failure === 'user-rejected') return entry
  if (!entry.walletRequestedAt) return updateReceiveEntry(entryId, { phase: 'failed', failure: 'pre-wallet', lastError: summarizeReceiveError(error, now) }, now)
  return updateReceiveEntry(entryId, { phase: 'unknown', lastError: entry.lastError ?? summarizeReceiveError(error, now) }, now)
}

// ---- chain evidence (HTTP only) ----
export type ReceiveReads = {
  // true = nonce consumed; throws when unreadable or when confirmed and finalized disagree
  nonceUsedA(message: string): Promise<boolean>
  nonceUsedB(message: string): Promise<boolean> // an independent reader (other RPC path)
  signatureStatus(signature: string): Promise<{ found: boolean; err?: unknown; confirmationStatus?: string | null }>
  blockhashValid(blockhash: string): Promise<boolean>
  signaturesTouching(address: string): Promise<number> // count of transactions that touched the address
}
export function usedNoncePda(message: string) {
  const nonce = decodeCctpRecoveryMessage(message).nonce
  return PublicKey.findProgramAddressSync([new TextEncoder().encode('used_nonce'), Uint8Array.from(nonce.slice(2).match(/../g)!.map(b => parseInt(b, 16)))], new PublicKey(MESSAGE_TRANSMITTER))[0].toBase58()
}
async function nonceState(message: string, reads: ReceiveReads) {
  const [a, b] = await Promise.all([reads.nonceUsedA(message), reads.nonceUsedB(message)])
  return a && b ? 'used' : !a && !b ? 'unused' : 'disagree'
}

export type SettleResult = { kind: 'complete' } | { kind: 'released'; reason: string } | { kind: 'locked'; reason: string } | { kind: 'legacy' }
// Settles an open attempt from chain evidence. Never by elapsed time; a failed read throws (lock kept).
export async function settleReceiveEntry(entry: ReceiveEntry, message: string, reads: ReceiveReads, now = Date.now()): Promise<SettleResult> {
  const nonce = await nonceState(message, reads)
  if (nonce === 'used') { updateReceiveEntry(entry.id, { phase: 'complete', note: 'The message nonce is consumed on Solana.' }, now); return { kind: 'complete' } }
  if (nonce === 'disagree') return { kind: 'locked', reason: 'Solana readers disagree about the message nonce. Check again in a moment.' }
  if (entry.phase === 'prepared' && !entry.walletRequestedAt) { updateReceiveEntry(entry.id, { phase: 'released', failure: 'pre-wallet', note: 'The wallet was never asked.' }, now); return { kind: 'released', reason: 'The earlier attempt never reached the wallet.' } }
  if (entry.signature) {
    const status = await reads.signatureStatus(entry.signature)
    if (status.found && status.err) { updateReceiveEntry(entry.id, { phase: 'failed', failure: 'chain-failed', note: 'The receive transaction failed on chain; the nonce is unused.' }, now); return { kind: 'released', reason: 'The earlier receive failed on chain.' } }
    if (status.found) return { kind: 'locked', reason: 'The earlier receive is on chain but the nonce is not visible yet. Check again in a moment.' }
    const blockhash = entry.signed?.find(s => s.signature === entry.signature)?.blockhash
    if (!blockhash) return { kind: 'locked', reason: 'The earlier receive has no saved blockhash to prove it expired.' }
    if (await reads.blockhashValid(blockhash)) return { kind: 'locked', reason: 'The earlier receive could still land: its blockhash is valid. Check again in about a minute.' }
    // Re-read after the expiry check: a landing between the two reads must not be missed.
    const again = await reads.signatureStatus(entry.signature)
    if (again.found) return { kind: 'locked', reason: 'The earlier receive appeared on chain while checking. Check again.' }
    if ((await nonceState(message, reads)) !== 'unused') return { kind: 'locked', reason: 'The nonce changed while checking. Check again.' }
    updateReceiveEntry(entry.id, { phase: 'failed', failure: 'expired', note: 'Signed receive never landed and its blockhash expired.' }, now)
    return { kind: 'released', reason: 'The earlier receive expired without landing.' }
  }
  if (!entry.receiveRequestedAt) {
    // Only an ATA-only transaction (or nothing) reached the wallet: no receive can land for this attempt.
    updateReceiveEntry(entry.id, { phase: 'released', note: 'The receive transaction was never shown to the wallet.' }, now)
    return { kind: 'released', reason: 'The earlier attempt never asked the wallet to sign the receive.' }
  }
  if (entry.requestedBlockhash) {
    // The wallet was asked but returned no signed transaction to the SDK, so the SDK sent nothing;
    // the requested blockhash must still be expired before another request.
    if (await reads.blockhashValid(entry.requestedBlockhash)) return { kind: 'locked', reason: 'The wallet request is recent. Check again in about a minute.' }
    if ((await nonceState(message, reads)) !== 'unused') return { kind: 'locked', reason: 'The nonce changed while checking. Check again.' }
    updateReceiveEntry(entry.id, { phase: 'failed', failure: 'expired', note: 'The wallet returned no signature and the requested blockhash expired.' }, now)
    return { kind: 'released', reason: 'The earlier wallet request expired.' }
  }
  return { kind: 'legacy' }
}

// ---- older records without evidence: independent chain checks + explicit confirmation ----
export type LegacyCheck = { label: string; ok: boolean }
export type LegacyReview = { sourceTxHash: string; eligible: boolean; checks: LegacyCheck[]; reviewedAt: number }
export async function reviewLegacyReceive(sourceTxHash: string, message: string, reads: ReceiveReads, now = Date.now()): Promise<LegacyReview> {
  const checks: LegacyCheck[] = []
  const check = async (label: string, run: () => Promise<boolean>) => { let ok = false; try { ok = await run() } catch { ok = false } checks.push({ label, ok }); return ok }
  await check('Nonce unused on Solana (reader A, confirmed and finalized)', async () => !(await reads.nonceUsedA(message)))
  await check('Nonce unused on Solana (reader B, confirmed and finalized)', async () => !(await reads.nonceUsedB(message)))
  await check('No receive transaction ever touched the nonce account', async () => (await reads.signaturesTouching(usedNoncePda(message))) === 0)
  await check('No active wallet request for this burn in this browser', async () => !readReceiveEntries().some(e => e.sourceTxHash === sourceTxHash.toLowerCase() && ACTIVE.includes(e.phase)))
  return { sourceTxHash: sourceTxHash.toLowerCase(), eligible: checks.every(c => c.ok), checks, reviewedAt: now }
}
// Re-runs every check right before unlocking; the caller holds the per-burn Web Lock.
export async function releaseLegacyReceiveAfterReview(sourceTxHash: string, owner: string, message: string, userConfirmed: boolean, reads: ReceiveReads, now = Date.now()) {
  if (!userConfirmed) throw new Error('Confirm that you understand the risk before unlocking.')
  const review = await reviewLegacyReceive(sourceTxHash, message, reads, now)
  if (!review.eligible) throw new ReceiveLockedError('Not every chain check passed, so the earlier request stays locked.')
  const entry = createReceiveEntry(sourceTxHash, owner, now)
  updateReceiveEntry(entry.id, { phase: 'released', legacy: true, manuallyReleased: true, note: 'Older request without a saved signature, unlocked by you after independent chain checks.' }, now)
  return review
}
// The single gate before a receive: the journal decides when it has a record for this burn; without
// one, an open (pending/unknown) Activity record from the older recovery code needs the manual review.
export type ReceiveGate = { kind: 'already-received' } | { kind: 'go'; entryId: string }
export async function openReceiveAttempt(input: { sourceTxHash: string; owner: string; message: string; legacyActivityStatus?: string }, reads: ReceiveReads, now = Date.now()): Promise<ReceiveGate> {
  const nonce = await nonceState(input.message, reads)
  const latest = latestReceiveEntry(input.sourceTxHash)
  if (nonce === 'used') { if (latest && OPEN.includes(latest.phase)) updateReceiveEntry(latest.id, { phase: 'complete', note: 'The message nonce is consumed on Solana.' }, now); return { kind: 'already-received' } }
  if (nonce === 'disagree') throw new ReceiveLockedError('Solana readers disagree about the message nonce. Check again in a moment.')
  if (latest && OPEN.includes(latest.phase)) {
    const r = await settleReceiveEntry(latest, input.message, reads, now)
    if (r.kind === 'complete') return { kind: 'already-received' }
    if (r.kind === 'locked') throw new ReceiveLockedError(r.reason)
    if (r.kind === 'legacy') throw new LegacyReceiveReviewRequired()
  } else if (!latest && ['pending', 'unknown'].includes(input.legacyActivityStatus ?? '')) throw new LegacyReceiveReviewRequired()
  return { kind: 'go', entryId: createReceiveEntry(input.sourceTxHash, input.owner, now).id }
}
