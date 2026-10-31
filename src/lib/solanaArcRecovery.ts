// Solana -> Arc recovery: finish the Arc receive of an EXISTING Solana burn. Nothing here can
// burn: the only write is MessageTransmitterV2.receiveMessage on Arc for a Circle-attested message
// whose Solana source transaction, sender, recipient and amount are checked first. A used Arc nonce
// means the burn was already received and nothing is requested. A receive journal (this browser)
// plus the Arc nonce (any browser) keep a second receive from being requested while one may be
// in flight. All reads go through injected ports so the logic is testable without a network.
import { encodeFunctionData, formatUnits, getAddress, type Hex } from 'viem'
import { PublicKey } from '@solana/web3.js'
import { getMainnetCctpChain, CCTP_V2_MESSAGE_TRANSMITTER_ABI } from '../config/mainnetCctp'
import { SOLANA_MAINNET_CCTP } from '../config/mainnetSolana'
import { CCTP_RECOVERY_ABI, decodeCctpRecoveryMessage } from './mainnetCctpRecovery'
import { verifyArcMintTx } from './arcMintProof'

const ZERO = '0x' + '00'.repeat(32)
const SIGNATURE = /^[1-9A-HJ-NP-Za-km-z]{64,90}$/
const lower = (s: string) => s.toLowerCase()
const pubkeyWord = (key: string) => lower('0x' + Array.from(new PublicKey(key).toBytes(), b => b.toString(16).padStart(2, '0')).join(''))
const evmWord = (address: string) => lower('0x' + getAddress(address).slice(2).padStart(64, '0'))

export type SolanaSourceTx = {
  // getSignatureStatuses result for the signature (null when the cluster does not know it).
  status: { confirmationStatus?: string | null; err?: unknown } | null
  // getTransaction (json) result; null when not available yet.
  transaction: { meta?: { err?: unknown; logMessages?: string[] | null } | null; transaction?: { message?: { accountKeys?: unknown[]; header?: { numRequiredSignatures?: number } } } } | null
}
export type SolanaArcRecoveryPorts = {
  solanaSource(signature: string): Promise<SolanaSourceTx>
  // Circle Iris v2 messages for this Solana transaction (raw JSON "messages" array, [] when unknown).
  circleMessages(signature: string): Promise<any[]>
  // Arc read client (viem public client shape): getChainId, getBlock, readContract, getTransactionReceipt.
  arc: any
}
export type SolanaArcRecoveryInput = { signature: string; solanaOwner: string; evmOwner: string; destinationHints?: (string | undefined | null)[] }
export type SolanaArcRecoveryResult = {
  stage: 'waiting_attestation' | 'ready_to_mint' | 'complete'
  signature: string; solanaOwner: string; evmOwner: string
  amount: string; feeUsdc?: string; receivedUsdc?: string
  nonce?: Hex; message?: Hex; attestation?: Hex; destinationTx?: string; checkedAt: number
}

// 1) The Solana source: confirmed, error-free, signed by the connected Phantom wallet, CCTP invoked.
export function checkSolanaSource(src: SolanaSourceTx, signature: string, solanaOwner: string) {
  if (!SIGNATURE.test(signature)) throw new Error('This is not a Solana transaction signature.')
  const s = src.status
  if (!s) throw new Error('This Solana transaction is not found on chain (yet). Nothing was requested.')
  if (s.err != null) throw new Error('This Solana transaction failed, so nothing was burned. Nothing to recover.')
  if (!['confirmed', 'finalized'].includes(String(s.confirmationStatus))) throw new Error('This Solana transaction is not confirmed yet. Check again shortly.')
  const tx = src.transaction
  if (!tx?.transaction?.message) throw new Error('The Solana transaction details are not available yet. Check again shortly.')
  if (tx.meta?.err != null) throw new Error('This Solana transaction failed, so nothing was burned. Nothing to recover.')
  const keys = (tx.transaction.message.accountKeys ?? []).map(k => typeof k === 'string' ? k : (k as { pubkey?: string })?.pubkey ?? '')
  const signers = keys.slice(0, Math.max(1, tx.transaction.message.header?.numRequiredSignatures ?? 1))
  if (!signers.includes(solanaOwner)) throw new Error('This Solana transaction was not signed by the connected Phantom wallet. Connect the wallet that sent it.')
  const invoked = (tx.meta?.logMessages ?? []).some(l => l.startsWith(`Program ${SOLANA_MAINNET_CCTP.tokenMessengerMinterProgram} invoke`))
  if (!invoked) throw new Error('This Solana transaction is not a CCTP burn.')
}

// 2) The Circle message: exactly one, Solana -> Arc, from this wallet to the connected Arc wallet.
export function pickSolanaArcMessage(messages: any[], solanaOwner: string, evmOwner: string) {
  if (!Array.isArray(messages) || messages.length > 64) throw new Error('Circle returned a malformed response. Nothing was requested.')
  const arc = getMainnetCctpChain(5042)!, owner = evmWord(evmOwner), sender = pubkeyWord(solanaOwner)
  const ours = messages.filter(v => {
    try {
      const m = decodeCctpRecoveryMessage(v?.message)
      return m.sourceDomain === 5 && m.destinationDomain === 26 && m.mintRecipient === owner && m.messageSender === sender
        && m.sender === pubkeyWord(SOLANA_MAINNET_CCTP.tokenMessengerMinterProgram) && m.recipient === evmWord(arc.tokenMessengerAddress)
        && m.burnToken === pubkeyWord(SOLANA_MAINNET_CCTP.usdcMint) && [ZERO, owner].includes(m.destinationCaller)
    } catch { return false }
  })
  if (ours.length > 1) throw new Error('Several Circle messages match this transaction. Recovery stops rather than guessing.')
  if (!ours.length) {
    const pending = messages.every(v => v?.status !== 'complete' && (!v?.message || v.message === '0x'))
    if (pending) return null
    throw new Error('The Circle message of this transaction is not a Solana → Arc transfer to the connected Arc wallet.')
  }
  const v = ours[0]
  if (v.status !== 'complete') return null
  const m = decodeCctpRecoveryMessage(v.message)
  if (!/^0x(?:[0-9a-f]{130})+$/i.test(String(v.attestation)) || m.nonce === ZERO || m.executedFinality < m.minFinality || m.feeExecuted > m.maxFee || m.feeExecuted >= m.amount) throw new Error('Circle attestation, nonce, finality or fee is invalid. Nothing was requested.')
  if (v.eventNonce !== undefined && lower(String(v.eventNonce)) !== m.nonce) throw new Error('Circle event nonce does not match the signed message.')
  const hint = typeof v.destinationMintTxHash === 'string' && /^0x[0-9a-f]{64}$/i.test(v.destinationMintTxHash) ? lower(v.destinationMintTxHash) : undefined
  return { message: v.message as Hex, attestation: v.attestation as Hex, fields: m, hint }
}

// 3) The Arc nonce on a canonical block: used = already received; never guessed.
export async function inspectSolanaToArcRecovery(input: SolanaArcRecoveryInput, ports: SolanaArcRecoveryPorts): Promise<SolanaArcRecoveryResult> {
  const signature = input.signature.trim()
  if (!/^0x[0-9a-f]{40}$/i.test(input.evmOwner) || /^0x0{40}$/i.test(input.evmOwner)) throw new Error('Connect the Arc (EVM) wallet that should receive the USDC.')
  new PublicKey(input.solanaOwner)
  checkSolanaSource(await ports.solanaSource(signature), signature, input.solanaOwner)
  const base = { signature, solanaOwner: input.solanaOwner, evmOwner: input.evmOwner }
  const picked = pickSolanaArcMessage(await ports.circleMessages(signature), input.solanaOwner, input.evmOwner)
  if (!picked) return { ...base, stage: 'waiting_attestation', amount: '', checkedAt: Date.now() }
  const { message, attestation, fields: m } = picked
  const arc = getMainnetCctpChain(5042)!, client = ports.arc
  if (await client.getChainId() !== 5042) throw new Error('The Arc RPC is not Arc Mainnet.')
  const block = await client.getBlock()
  if (typeof block?.number !== 'bigint' || !/^0x[0-9a-f]{64}$/i.test(block.hash ?? '')) throw new Error('No canonical Arc block. Nothing was requested.')
  const used = await client.readContract({ address: arc.messageTransmitterAddress, abi: CCTP_RECOVERY_ABI, functionName: 'usedNonces', args: [m.nonce], blockNumber: block.number })
  if (used !== 0n && used !== 1n) throw new Error('Unknown Arc nonce state. Nothing was requested.')
  if (lower((await client.getBlock({ blockNumber: block.number })).hash ?? '') !== lower(block.hash)) throw new Error('The Arc block changed while checking. Check again.')
  const amounts = { amount: formatUnits(m.amount, 6), feeUsdc: formatUnits(m.feeExecuted, 6), receivedUsdc: formatUnits(m.amount - m.feeExecuted, 6) }
  if (used === 1n) {
    // Already received. The receive transaction is shown only when it is proven on chain.
    let destinationTx: string | undefined
    for (const hint of [...new Set([...(input.destinationHints ?? []), picked.hint].filter((h): h is string => typeof h === 'string' && /^0x[0-9a-f]{64}$/i.test(h)).map(lower))]) {
      try { if (await verifyArcMintTx(client, hint, message, input.evmOwner, 5)) { destinationTx = hint; break } } catch { /* display only */ }
    }
    return { ...base, ...amounts, stage: 'complete', nonce: m.nonce, message, attestation, destinationTx, checkedAt: Date.now() }
  }
  if (m.expirationBlock > 0n && block.number >= m.expirationBlock) throw new Error('This Circle attestation has expired on Arc; a fresh attestation is needed. Nothing was requested.')
  return { ...base, ...amounts, stage: 'ready_to_mint', nonce: m.nonce, message, attestation, checkedAt: Date.now() }
}

export function prepareArcReceiveCall(message: Hex, attestation: Hex) {
  const arc = getMainnetCctpChain(5042)!
  return { to: arc.messageTransmitterAddress as Hex, data: encodeFunctionData({ abi: CCTP_V2_MESSAGE_TRANSMITTER_ABI, functionName: 'receiveMessage', args: [message, attestation] }), value: 0n }
}

// ---- Receive journal (this browser) ----
export const SOLANA_ARC_RECEIVE_KEY = 'machina_solana_arc_receive_v1'
export type ReceivePhase = 'requesting' | 'sent' | 'unknown' | 'complete' | 'released'
export type ReceiveRecord = { signature: string; nonce: string; evmWallet: string; phase: ReceivePhase; txHash?: string; updatedAt: number; note?: string }
const OPEN: ReceivePhase[] = ['requesting', 'sent', 'unknown']

export function readReceiveRecords(): ReceiveRecord[] {
  const raw = globalThis.localStorage?.getItem(SOLANA_ARC_RECEIVE_KEY)
  if (!raw) return []
  const parsed = JSON.parse(raw) // an unreadable journal throws: callers stop, nothing is requested
  if (!Array.isArray(parsed)) throw new Error('The receive journal is unreadable. Nothing was requested.')
  return parsed
}
export function writeReceiveRecord(record: ReceiveRecord) {
  const all = readReceiveRecords().filter(r => r.signature !== record.signature)
  const next = [record, ...all.filter(r => OPEN.includes(r.phase)), ...all.filter(r => !OPEN.includes(r.phase)).slice(0, 40)]
  globalThis.localStorage.setItem(SOLANA_ARC_RECEIVE_KEY, JSON.stringify(next))
  const back = readReceiveRecords().find(r => r.signature === record.signature)
  if (!back || back.phase !== record.phase || back.txHash !== record.txHash) throw new Error('The receive journal could not be saved. Nothing was requested.')
  return record
}
export const receiveRecordFor = (signature: string) => readReceiveRecords().find(r => r.signature === signature)
export const isOpenReceive = (r?: ReceiveRecord) => Boolean(r && OPEN.includes(r.phase))

// ---- The receive ----
export type ArcReceiveWallet = {
  // Switches to Arc and confirms the connected account; throws if the wallet or network differs.
  ready(evmOwner: string): Promise<void>
  // Requests the transaction in the wallet (the user approves it there) and returns its hash.
  send(call: { to: Hex; data: Hex; value: bigint }): Promise<Hex>
  // Optional pre-check (gas / simulation) before anything is journaled or requested.
  simulate?(call: { to: Hex; data: Hex; value: bigint }, evmOwner: string): Promise<void>
}
export type ArcReceiveDeps = {
  inspect(input: SolanaArcRecoveryInput): Promise<SolanaArcRecoveryResult>
  wallet: ArcReceiveWallet
  // Arc receipt status for a hash: 'success' | 'reverted' | null (not mined yet).
  receipt(hash: string): Promise<'success' | 'reverted' | null>
  waitReceipt(hash: string): Promise<'success' | 'reverted'>
  mintProven(hash: string, message: Hex, evmOwner: string): Promise<boolean>
  onComplete?(result: SolanaArcRecoveryResult, txHash?: string): void
  lock?<T>(name: string, run: () => Promise<T>): Promise<T>
}
export const isWalletRejection = (e: any) => e?.code === 4001 || e?.code === 'ACTION_REJECTED' || /user (rejected|denied)|rejected the request|request rejected/i.test(String(e?.message ?? e?.shortMessage ?? ''))

async function defaultLock<T>(name: string, run: () => Promise<T>) {
  const locks = (globalThis.navigator as any)?.locks
  if (!locks?.request) throw new Error('This browser cannot lock the receive; nothing was requested.')
  return locks.request(name, { ifAvailable: true }, async (lock: unknown) => {
    if (!lock) throw new Error('Another tab is already completing this receive. Nothing was requested here.')
    return run()
  })
}

// Settles an open journal record from chain evidence. Returns true when a new request may follow.
async function settleOpenReceive(record: ReceiveRecord, checked: SolanaArcRecoveryResult, deps: ArcReceiveDeps) {
  if (checked.stage === 'complete') { writeReceiveRecord({ ...record, phase: 'complete', updatedAt: Date.now(), note: 'The Arc nonce shows this burn was received.' }); return false }
  if (record.txHash) {
    const r = await deps.receipt(record.txHash)
    if (r === 'reverted') { writeReceiveRecord({ ...record, phase: 'released', updatedAt: Date.now(), note: 'The earlier receive reverted; the burn is still unreceived.' }); return true }
    throw new Error(r === 'success'
      ? 'The earlier receive succeeded but the Arc nonce is not readable as used yet. Check again; nothing was requested.'
      : 'An earlier receive transaction is still pending on Arc. Wait for it; nothing was requested.')
  }
  throw new Error('An earlier receive request has no known outcome. Check your wallet activity, then use "I checked my wallet" to unlock it. Nothing was requested.')
}

export async function completeSolanaArcReceive(input: SolanaArcRecoveryInput, approved: SolanaArcRecoveryResult, deps: ArcReceiveDeps): Promise<{ kind: 'already-received' | 'received'; result: SolanaArcRecoveryResult; txHash?: string }> {
  const lock = deps.lock ?? defaultLock
  return lock(`machina-solana-arc-receive:${input.signature}`, async () => {
    let checked = await deps.inspect(input)
    const prior = receiveRecordFor(input.signature)
    if (isOpenReceive(prior)) await settleOpenReceive(prior!, checked, deps)
    if (checked.stage === 'complete') { deps.onComplete?.(checked, checked.destinationTx); return { kind: 'already-received' as const, result: checked, txHash: checked.destinationTx } }
    if (checked.stage !== 'ready_to_mint' || !checked.message || !checked.attestation) throw new Error('Circle has not attested this burn yet. Nothing was requested.')
    // The user approved exactly this message and amount; anything else needs a new review.
    if (approved.message?.toLowerCase() !== checked.message.toLowerCase() || approved.receivedUsdc !== checked.receivedUsdc || approved.evmOwner.toLowerCase() !== input.evmOwner.toLowerCase()) throw new Error('The transfer changed since you reviewed it. Check it again; nothing was requested.')
    await deps.wallet.ready(input.evmOwner)
    checked = await deps.inspect(input) // fresh read right before the wallet request
    if (checked.stage === 'complete') { deps.onComplete?.(checked, checked.destinationTx); return { kind: 'already-received' as const, result: checked, txHash: checked.destinationTx } }
    if (checked.stage !== 'ready_to_mint' || checked.message?.toLowerCase() !== approved.message.toLowerCase()) throw new Error('The transfer changed before the wallet request. Check it again; nothing was requested.')
    const call = prepareArcReceiveCall(checked.message!, checked.attestation!)
    await deps.wallet.simulate?.(call, input.evmOwner)
    const record: ReceiveRecord = { signature: input.signature, nonce: checked.nonce!, evmWallet: input.evmOwner, phase: 'requesting', updatedAt: Date.now() }
    writeReceiveRecord(record) // persisted before the wallet sees anything
    let hash: Hex
    try { hash = await deps.wallet.send(call) }
    catch (error) {
      writeReceiveRecord({ ...record, phase: isWalletRejection(error) ? 'released' : 'unknown', updatedAt: Date.now(), note: isWalletRejection(error) ? 'You rejected the receive in the wallet.' : 'The wallet did not return a clear answer.' })
      throw error
    }
    writeReceiveRecord({ ...record, phase: 'sent', txHash: hash, updatedAt: Date.now() })
    const status = await deps.waitReceipt(hash)
    if (status !== 'success') { writeReceiveRecord({ ...record, phase: 'released', txHash: hash, updatedAt: Date.now(), note: 'The receive reverted.' }); throw new Error('The Arc receive reverted. The burn is still unreceived; check it again before retrying.') }
    const after = await deps.inspect({ ...input, destinationHints: [hash] })
    if (after.stage !== 'complete' || !(await deps.mintProven(hash, checked.message!, input.evmOwner))) throw new Error('The receive transaction succeeded, but the mint is not independently verified yet. Do not send again; check it in a moment.')
    writeReceiveRecord({ ...record, phase: 'complete', txHash: hash, updatedAt: Date.now() })
    deps.onComplete?.(after, hash)
    return { kind: 'received' as const, result: after, txHash: hash }
  })
}

// Manual unlock of a receive whose wallet answer was lost, only after a read showed the nonce unused.
export function releaseReceiveAfterReview(signature: string, checked: SolanaArcRecoveryResult) {
  const r = receiveRecordFor(signature)
  if (!r || !isOpenReceive(r) || r.txHash) throw new Error('There is no unclear receive request to unlock.')
  if (checked.stage !== 'ready_to_mint' || checked.signature !== signature) throw new Error('Check the transfer on chain first.')
  return writeReceiveRecord({ ...r, phase: 'released', updatedAt: Date.now(), note: 'Unlocked by you after checking your wallet.' })
}

// Candidate Solana -> Arc burns this browser knows about (send journal, Activity, receive journal).
export function solanaArcCandidates(sources: { sendAttempts: { direction: string; solanaWallet: string; evmWallet: string; solanaSignature?: string; phase: string }[]; activity: { direction: string; solanaWallet: string; sourceTxHash?: string; status?: string }[]; receives: ReceiveRecord[] }, solanaOwner: string) {
  const out = new Set<string>()
  for (const a of sources.sendAttempts) if (a.direction === 'solana-to-arc' && a.solanaWallet === solanaOwner && a.solanaSignature && a.phase !== 'released') out.add(a.solanaSignature)
  for (const a of sources.activity) if (a.direction === 'solana-to-arc' && a.solanaWallet === solanaOwner && a.sourceTxHash && a.status !== 'complete') out.add(a.sourceTxHash)
  for (const r of sources.receives) if (isOpenReceive(r)) out.add(r.signature)
  return [...out].filter(s => SIGNATURE.test(s))
}
