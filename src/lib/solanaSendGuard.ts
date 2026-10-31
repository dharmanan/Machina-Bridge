// One Solana bridge transfer at a time per wallet, and never a second burn while the
// outcome of an earlier one is unknown.
//
// Phases of an attempt (persisted before any wallet request):
//   prepared  record written; the burn has not been requested from a wallet yet
//   signing   the burn request was handed to the wallet (EVM eth_sendTransaction /
//             Solana signTransaction); its outcome is not known yet
//   signed    Solana returned the signed burn: its signature and blockhash are known
//   sent      the EVM wallet returned the burn transaction hash
//   unknown   the wallet failed in a way that does not prove the burn was not sent
//   released  proven not sent (never requested, rejected, reverted, or the transaction the wallet
//             signed can no longer land), or unlocked by the user after an explicit warning
//   burned    the source burn is proven on chain. This says nothing about the destination mint:
//             receiving is verified by the receive/recovery paths, never by this record.
//
// signing / signed / sent / unknown block new transfers for both wallets until chain evidence
// settles them. Time alone never unlocks: a wallet may still approve an old request later.
// prepared never blocks: no burn was requested.

export const SOLANA_SEND_JOURNAL_KEY = 'machina_mainnet_solana_send_v1'
export const SOLANA_SEND_JOURNAL_EVENT = 'machina:mainnet-solana-send'
const MAX_RECORDS = 50

export type SolanaSendDirection = 'arc-to-solana' | 'solana-to-arc'
export type SolanaSendPhase = 'prepared' | 'signing' | 'signed' | 'sent' | 'unknown' | 'released' | 'burned'

export type SolanaSendAttempt = {
  id: string
  direction: SolanaSendDirection
  evmWallet: string
  solanaWallet: string
  amount: string
  createdAt: number
  updatedAt: number
  phase: SolanaSendPhase
  signingAt?: number
  // arc-to-solana: Arc block read before the transfer (start of the burn search window)
  arcBlockBefore?: string
  burnTxHash?: string
  solanaSignature?: string
  // Solana: the blockhash of the transaction handed to the wallet (read before signing), or of the signed one
  solanaBlockhash?: string
  manuallyReleased?: boolean
  note?: string
}

const BLOCKING: ReadonlySet<SolanaSendPhase> = new Set(['signing', 'signed', 'sent', 'unknown'])
export const isBlocking = (attempt: SolanaSendAttempt) => BLOCKING.has(attempt.phase)


type Storage = Pick<globalThis.Storage, 'getItem' | 'setItem'>
const storage = (): Storage | null => (typeof globalThis.localStorage === 'undefined' ? null : globalThis.localStorage)
const sameEvm = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase()

export function readSolanaSendAttempts(): SolanaSendAttempt[] {
  const s = storage()
  if (!s) return []
  try {
    const parsed = JSON.parse(s.getItem(SOLANA_SEND_JOURNAL_KEY) ?? '[]')
    return Array.isArray(parsed) ? parsed.filter(x => x && typeof x === 'object' && typeof x.id === 'string' && typeof x.phase === 'string') : []
  } catch {
    // An unreadable journal cannot prove that no burn is open.
    throw new Error('The Solana transfer record could not be read. New transfers stay locked so nothing is sent twice.')
  }
}

function writeAttempts(attempts: SolanaSendAttempt[]) {
  const s = storage()
  if (!s) throw new Error('Browser storage is required to record the transfer before any wallet request.')
  const kept = [...attempts].sort((a, b) => b.updatedAt - a.updatedAt)
  // Blocking attempts are never dropped by the size limit.
  const trimmed = [...kept.filter(isBlocking), ...kept.filter(a => !isBlocking(a))].slice(0, Math.max(MAX_RECORDS, kept.filter(isBlocking).length))
  s.setItem(SOLANA_SEND_JOURNAL_KEY, JSON.stringify(trimmed))
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(SOLANA_SEND_JOURNAL_EVENT))
}

function persist(next: SolanaSendAttempt) {
  const others = readSolanaSendAttempts().filter(a => a.id !== next.id)
  writeAttempts([next, ...others])
  // Read back: a record that is not stored cannot protect the next page load.
  const stored = readSolanaSendAttempts().find(a => a.id === next.id)
  if (!stored || stored.phase !== next.phase || stored.burnTxHash !== next.burnTxHash || stored.solanaSignature !== next.solanaSignature) {
    throw new Error('The Solana transfer record could not be saved. No wallet request is allowed.')
  }
  return next
}

export function openSolanaSendAttempt(evmWallet: string, solanaWallet: string) {
  return readSolanaSendAttempts().find(a => isBlocking(a) && (sameEvm(a.evmWallet, evmWallet) || a.solanaWallet === solanaWallet)) ?? null
}

// Attempts left in "prepared" by an earlier page never reached the burn request.
export function releaseStalePrepared(evmWallet: string, solanaWallet: string, keepId?: string) {
  for (const a of readSolanaSendAttempts()) {
    if (a.phase === 'prepared' && a.id !== keepId && (sameEvm(a.evmWallet, evmWallet) || a.solanaWallet === solanaWallet)) {
      persist({ ...a, phase: 'released', updatedAt: Date.now(), note: 'The burn was never requested from a wallet.' })
    }
  }
}

export function createSolanaSendAttempt(input: Pick<SolanaSendAttempt, 'direction' | 'evmWallet' | 'solanaWallet' | 'amount' | 'arcBlockBefore'>) {
  const now = Date.now()
  const id = typeof globalThis.crypto?.randomUUID === 'function' ? globalThis.crypto.randomUUID() : `solana-send-${now}-${Math.random().toString(36).slice(2)}`
  return persist({ ...input, id, createdAt: now, updatedAt: now, phase: 'prepared' })
}

export function updateSolanaSendAttempt(id: string, patch: Partial<Omit<SolanaSendAttempt, 'id' | 'createdAt'>>) {
  const current = readSolanaSendAttempts().find(a => a.id === id)
  if (!current) throw new Error('The Solana transfer record is missing. New transfers stay locked so nothing is sent twice.')
  return persist({ ...current, ...patch, updatedAt: Date.now() })
}

export function isUserRejection(error: unknown) {
  const e = error as { code?: unknown; message?: unknown; name?: unknown } | null
  if (e && (e.code === 4001 || e.code === 'ACTION_REJECTED')) return true
  const text = `${String(e?.name ?? '')} ${String(e?.message ?? error ?? '')}`
  return /user rejected|rejected the request|request rejected|user denied|denied transaction|user cancel/i.test(text)
}

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
function base58(bytes: Uint8Array) {
  let n = 0n
  for (const b of bytes) n = n * 256n + BigInt(b)
  let out = ''
  while (n > 0n) { out = B58[Number(n % 58n)] + out; n /= 58n }
  for (const b of bytes) { if (b !== 0) break; out = '1' + out }
  return out
}

// The fee payer's signature (index 0) is the transaction signature; wallets sign as fee payer.
export function solanaSignatureOf(signed: unknown): { signature?: string; blockhash?: string } {
  const tx = signed as { signatures?: unknown[]; signature?: unknown; message?: { recentBlockhash?: unknown }; recentBlockhash?: unknown } | null
  const raw = Array.isArray(tx?.signatures) ? (tx!.signatures[0] as { signature?: unknown } | Uint8Array | undefined) : tx?.signature
  const bytes = raw instanceof Uint8Array ? raw : (raw as { signature?: unknown } | undefined)?.signature instanceof Uint8Array ? (raw as { signature: Uint8Array }).signature : null
  const signature = bytes && bytes.length === 64 && bytes.some(b => b !== 0) ? base58(bytes) : undefined
  const blockhash = typeof tx?.message?.recentBlockhash === 'string' ? tx.message.recentBlockhash : typeof tx?.recentBlockhash === 'string' ? tx.recentBlockhash : undefined
  return { signature, blockhash }
}

export type SolanaSendEvidence = {
  arcLatestBlock(): Promise<bigint>
  arcReceipt(hash: string): Promise<'success' | 'reverted' | null>
  // Arc DepositForBurn to Solana sent by this wallet since the block; throws when it cannot be read completely.
  arcBurnsSince(evmWallet: string, fromBlock: bigint): Promise<string[]>
  // true when the wallet has no transaction waiting in the mempool (pending nonce == latest nonce).
  arcNothingPending(evmWallet: string): Promise<boolean>
  solanaSignatureStatus(signature: string): Promise<{ found: false } | { found: true; err: unknown; confirmed: boolean }>
  solanaBlockhashValid(blockhash: string): Promise<boolean>
  // Successful CCTP burns signed by this Solana wallet since the time (ms).
  solanaBurnsSince(solanaWallet: string, sinceMs: number): Promise<string[]>
  now(): number
}

export type SolanaSendVerdict =
  | { kind: 'burned'; txHash: string }
  | { kind: 'not-sent'; reason: string }
  | { kind: 'unknown'; reason: string }

const REVIEW = ' It stays locked: only the wallet can tell whether it still holds this request.'

export async function verifySolanaSendAttempt(a: SolanaSendAttempt, ev: SolanaSendEvidence): Promise<SolanaSendVerdict> {
  if (a.phase === 'prepared') return { kind: 'not-sent', reason: 'The burn was never requested from a wallet.' }
  if (a.phase === 'released') return { kind: 'not-sent', reason: a.note ?? 'Already settled.' }
  if (a.phase === 'burned' && a.burnTxHash) return { kind: 'burned', txHash: a.burnTxHash }
  const since = a.signingAt ?? a.createdAt
  if (a.direction === 'arc-to-solana') {
    // An EVM wallet chooses the nonce when the user approves, so no chain state proves that an
    // old, unanswered request can no longer be sent: only a found burn, a receipt or a rejection settle it.
    if (a.burnTxHash) {
      const status = await ev.arcReceipt(a.burnTxHash)
      if (status === 'success') return { kind: 'burned', txHash: a.burnTxHash }
      if (status === 'reverted') return { kind: 'not-sent', reason: 'The Arc burn reverted: no USDC left your wallet.' }
    }
    if (!a.arcBlockBefore) return { kind: 'unknown', reason: 'No Arc starting block was recorded, so the burn cannot be searched.' + REVIEW }
    // Also catches a burn the wallet re-sent under another hash (speed up / replace).
    const burns = await ev.arcBurnsSince(a.evmWallet, BigInt(a.arcBlockBefore))
    if (burns.length) return { kind: 'burned', txHash: burns[0] }
    const pending = !(await ev.arcNothingPending(a.evmWallet))
    return { kind: 'unknown', reason: (a.burnTxHash ? 'Arc has not confirmed the burn transaction.' : pending ? 'A transaction from your EVM wallet is still pending on Arc.' : 'No burn from your wallet is on Arc.') + REVIEW }
  }
  // Solana: a signed transaction is valid only while its blockhash is; once the blockhash has
  // expired and the transaction is not on chain, it can never land.
  if (a.solanaSignature) {
    const status = await ev.solanaSignatureStatus(a.solanaSignature)
    if (status.found && status.err == null && status.confirmed) return { kind: 'burned', txHash: a.solanaSignature }
    if (status.found && status.err != null) return { kind: 'not-sent', reason: 'The Solana burn failed on chain: no USDC left your wallet.' }
    if (!status.found && a.solanaBlockhash && !(await ev.solanaBlockhashValid(a.solanaBlockhash))) {
      // Re-read after the expiry check, so a burn that landed just before expiring is not missed.
      const again = await ev.solanaSignatureStatus(a.solanaSignature)
      if (again.found) return again.err == null ? { kind: 'burned', txHash: a.solanaSignature } : { kind: 'not-sent', reason: 'The Solana burn failed on chain: no USDC left your wallet.' }
      return { kind: 'not-sent', reason: 'The signed Solana burn expired without landing; it can no longer be sent.' }
    }
    return { kind: 'unknown', reason: 'Solana has not confirmed the burn yet.' }
  }
  const burns = await ev.solanaBurnsSince(a.solanaWallet, since - 60_000)
  if (burns.length) return { kind: 'burned', txHash: burns[0] }
  if (a.solanaBlockhash && !(await ev.solanaBlockhashValid(a.solanaBlockhash))) {
    const again = await ev.solanaBurnsSince(a.solanaWallet, since - 60_000)
    if (again.length) return { kind: 'burned', txHash: again[0] }
    return { kind: 'not-sent', reason: 'The burn your wallet was asked to sign has expired without landing; it can no longer be sent.' }
  }
  return { kind: 'unknown', reason: (a.solanaBlockhash ? 'The burn your wallet was asked to sign is still valid and could still be sent.' : 'The burn your wallet was asked to sign could not be identified.') + REVIEW }
}

// Applies a verdict: burned -> burned (source burn known; the mint is not verified here),
// not-sent -> released, unknown -> unchanged.
export function applySolanaSendVerdict(a: SolanaSendAttempt, v: SolanaSendVerdict) {
  if (v.kind === 'burned') return updateSolanaSendAttempt(a.id, { phase: 'burned', burnTxHash: v.txHash, note: 'The source burn is on chain; receiving is not verified by this record.' })
  if (v.kind === 'not-sent') return updateSolanaSendAttempt(a.id, { phase: 'released', note: v.reason })
  return updateSolanaSendAttempt(a.id, { note: v.reason })
}

// Manual review: the user confirmed, after an explicit warning, that no wallet still holds the
// request. Only for an attempt that chain evidence could not settle (the caller re-checks first).
export function releaseSolanaSendAttemptManually(a: SolanaSendAttempt) {
  if (!isBlocking(a)) throw new Error('This transfer is not locked.')
  return updateSolanaSendAttempt(a.id, { phase: 'released', manuallyReleased: true, note: 'Unlocked by you after checking your wallets; no burn was found on chain at that time.' })
}

// "Completed" needs the receive proven on the destination chain by Machina itself; the SDK's
// destination hash alone is only a candidate. Anything short of proof is "pending", never a
// failure: an unreadable network says nothing about the transfer and must not invite a resend.
export const RECEIVE_PENDING_STATUS = 'Receive verification pending. The source burn is on chain; do not send again. Check it in Activity.'
export const RECEIVE_VERIFIED_STATUS = 'Solana mainnet transfer completed. The receive is verified on the destination chain.'

export type AttestedMessage = { status: 'complete'; message: string } | { status: 'pending' }
export type DestinationEvidence = {
  // Circle-attested CCTP message of this source burn, bound to the recipient checks below.
  attestedMessage(direction: SolanaSendDirection, sourceTxHash: string): Promise<AttestedMessage>
  // Arc: successful canonical receipt whose MessageReceived/MintAndWithdraw match the message.
  arcMintMatches(destinationTxHash: string, message: string, evmWallet: string): Promise<boolean>
  // Solana: signature status (null when not found).
  solanaSignatureStatus(signature: string): Promise<{ confirmationStatus?: string | null; err?: unknown } | null>
  // Solana: the message nonce is marked used by the MessageTransmitter.
  solanaNonceUsed(message: string): Promise<boolean>
}
export type DestinationInput = { direction: SolanaSendDirection; sourceTxHash?: string; destinationTxHash?: string; evmWallet: string; solanaWallet: string; amountRaw: bigint; solanaRecipients: string[] }
export type DestinationVerdict = { verified: true } | { verified: false; reason: string }

const word32 = (hex: string) => '0x' + hex.replace(/^0x/i, '').toLowerCase().padStart(64, '0')
function messageFields(message: string) {
  // CCTP V2 offsets (header 148 bytes, burn body after it); hooks are not supported.
  if (!/^0x[0-9a-f]+$/i.test(message) || message.length !== 2 + (148 + 228) * 2) return null
  const at = (o: number, n: number) => BigInt('0x' + message.slice(2 + o * 2, 2 + (o + n) * 2))
  return { sourceDomain: Number(at(4, 4)), destinationDomain: Number(at(8, 4)), mintRecipient: '0x' + message.slice(2 + 184 * 2, 2 + 216 * 2).toLowerCase(), amount: at(216, 32) }
}

export async function verifyTransferDestination(input: DestinationInput, ev: DestinationEvidence): Promise<DestinationVerdict> {
  const pending = (reason: string): DestinationVerdict => ({ verified: false, reason })
  if (!input.sourceTxHash) return pending('The source burn hash is missing.')
  if (!input.destinationTxHash) return pending('No receive transaction was reported yet.')
  try {
    const attested = await ev.attestedMessage(input.direction, input.sourceTxHash)
    if (attested.status !== 'complete') return pending('Circle has not attested the source burn yet.')
    const m = messageFields(attested.message)
    if (!m) return pending('The attested message could not be decoded.')
    if (m.amount !== input.amountRaw) return pending('The attested amount does not match this transfer.')
    if (input.direction === 'solana-to-arc') {
      if (m.sourceDomain !== 5 || m.destinationDomain !== 26 || m.mintRecipient !== word32(input.evmWallet)) return pending('The attested message is not for this Arc wallet.')
      if (!/^0x[0-9a-f]{64}$/i.test(input.destinationTxHash)) return pending('The receive transaction hash is not an Arc hash.')
      return await ev.arcMintMatches(input.destinationTxHash, attested.message, input.evmWallet)
        ? { verified: true } : pending('The Arc receive is not proven on chain yet.')
    }
    if (m.sourceDomain !== 26 || m.destinationDomain !== 5 || !input.solanaRecipients.map(word32).includes(m.mintRecipient)) return pending('The attested message is not for this Solana wallet.')
    const status = await ev.solanaSignatureStatus(input.destinationTxHash)
    if (!status) return pending('The Solana receive transaction is not found yet.')
    if (status.err) return pending('The reported Solana receive transaction did not succeed; the burn is still recoverable from Activity.')
    if (!['confirmed', 'finalized'].includes(String(status.confirmationStatus))) return pending('The Solana receive transaction is not confirmed yet.')
    return await ev.solanaNonceUsed(attested.message)
      ? { verified: true } : pending('The CCTP nonce is not marked used on Solana yet.')
  } catch {
    return pending('The networks could not be read to verify the receive.')
  }
}

// Retries "not proven yet" a few times (RPC indexing lag); the result stays pending, never failed.
export async function verifyTransferDestinationWithRetry(input: DestinationInput, ev: DestinationEvidence, opts: { attempts?: number; wait?: (ms: number) => Promise<void> } = {}): Promise<DestinationVerdict> {
  const attempts = opts.attempts ?? 6, wait = opts.wait ?? (ms => new Promise(r => setTimeout(r, ms)))
  let last: DestinationVerdict = { verified: false, reason: 'Not checked.' }
  for (let i = 0; i < attempts; i++) {
    last = await verifyTransferDestination(input, ev)
    if (last.verified || !input.sourceTxHash || !input.destinationTxHash) return last
    if (i + 1 < attempts) await wait(5_000)
  }
  return last
}

export function solanaTransferOutcomeStatus(tx: { sourceTxHash?: string; destinationTxHash?: string; destinationVerified?: boolean }) {
  if (tx.destinationTxHash && tx.destinationVerified === true) return RECEIVE_VERIFIED_STATUS
  if (tx.sourceTxHash) return RECEIVE_PENDING_STATUS
  return 'The transfer result could not be verified. Check Activity before sending again.'
}
