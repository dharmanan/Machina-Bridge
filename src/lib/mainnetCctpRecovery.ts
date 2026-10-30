import { createPublicClient, decodeEventLog, fallback, formatUnits, getAddress, http, isAddress, padHex, parseAbi, type Hex } from 'viem'
import { CIRCLE_MAINNET } from '../config/circle'
import { getMainnetCctpChain } from '../config/mainnetCctp'
import { SOLANA_MAINNET_CCTP } from '../config/mainnetSolana'
import { getMainnetCanaryRoute } from '../config/mainnetCanary'

// Circle's official evm-cctp-contracts src/v2/{TokenMessengerV2,MessageTransmitterV2}.sol.
// V2 uses a bytes32 nonce directly, NOT the V1 sourceDomain/uint64 nonce hash.
export const CCTP_RECOVERY_ABI = parseAbi([
  'event DepositForBurn(address indexed burnToken,uint256 amount,address indexed depositor,bytes32 mintRecipient,uint32 destinationDomain,bytes32 destinationTokenMessenger,bytes32 destinationCaller,uint256 maxFee,uint32 indexed minFinalityThreshold,bytes hookData)',
  'event MessageSent(bytes message)',
  'function usedNonces(bytes32 nonce) view returns(uint256)',
])
const ZERO = ('0x' + '00'.repeat(32)) as Hex
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()
export function cctpWord(address: string): Hex { return padHex(getAddress(address), { size: 32 }) }
export function assertSourceHash(hash: string): asserts hash is Hex {
  if (!/^0x[\da-f]{64}$/i.test(hash) || /^0x0{64}$/i.test(hash)) throw new Error('Enter a valid source transaction hash (0x and 64 hexadecimal characters).')
}
export function cctpRecoveryClient(rpcUrls: readonly string[]) {
  const transports = rpcUrls.map(url => http(url, { timeout: 10_000, retryCount: 0 }))
  return createPublicClient({ transport: transports.length === 1 ? transports[0] : fallback(transports) })
}
export function decodeCctpRecoveryMessage(message: string) {
  if (!/^0x(?:[\da-f]{2})+$/i.test(message) || message.length !== 2 + (148 + 228) * 2) throw new Error('Unsupported or malformed CCTP V2 message (hooks are not supported).')
  const word = (offset: number, size = 32) => ('0x' + message.slice(2 + offset * 2, 2 + (offset + size) * 2)).toLowerCase() as Hex
  const number = (offset: number, size = 4) => BigInt(word(offset, size))
  if (number(0) !== 1n || number(148) !== 1n) throw new Error('Unsupported CCTP message version.')
  return { sourceDomain: Number(number(4)), destinationDomain: Number(number(8)), nonce: word(12), sender: word(44), recipient: word(76), destinationCaller: word(108), minFinality: Number(number(140)), executedFinality: Number(number(144)), burnToken: word(152), mintRecipient: word(184), amount: number(216, 32), messageSender: word(248), maxFee: number(280, 32), feeExecuted: number(312, 32), expirationBlock: number(344, 32) }
}
export type CctpBurnProof = {
  sourceChainId: number; destinationChainId: number | null; sourceTxHash: Hex; sourceLogIndex: number
  owner: Hex; amount: string; mode: 'fast' | 'standard'; sourceBlockNumber: bigint; sourceBlockHash: Hex
  sourceMessage: Hex; fields: ReturnType<typeof decodeCctpRecoveryMessage>
}
// Injected ports are test-only read clients; production always uses configured mainnet RPCs.
export async function readCctpBurnProof(input: { sourceChainId: number; sourceTxHash: string; owner?: string; sourceLogIndex?: number; mintRecipients?: readonly string[]; suiDestinationMessenger?: Hex }, client: any = undefined): Promise<CctpBurnProof> {
  assertSourceHash(input.sourceTxHash)
  const source = getMainnetCctpChain(input.sourceChainId)
  if (!source || (input.owner !== undefined && !isAddress(input.owner))) throw new Error('Unsupported source chain or invalid connected wallet.')
  client ??= cctpRecoveryClient(source.rpcUrls)
  if (await client.getChainId() !== source.chainId) throw new Error('Source RPC returned the wrong chain.')
  const [tx, receipt] = await Promise.all([client.getTransaction({ hash: input.sourceTxHash }), client.getTransactionReceipt({ hash: input.sourceTxHash })])
  if (receipt.status !== 'success' || typeof receipt.blockNumber !== 'bigint' || receipt.blockNumber < 0n || tx.blockNumber !== receipt.blockNumber || !same(receipt.transactionHash, input.sourceTxHash) || !same(tx.hash, input.sourceTxHash) || !receipt.blockHash || !same(tx.blockHash ?? '', receipt.blockHash)) throw new Error('The source transaction is not a successful confirmed burn.')
  const block = await client.getBlock({ blockNumber: receipt.blockNumber })
  if (typeof receipt.blockNumber !== 'bigint' || block.number !== receipt.blockNumber || tx.blockNumber !== receipt.blockNumber || !same(block.hash ?? '', receipt.blockHash)) throw new Error('The source receipt is no longer canonical. Retry the read.')
  const deposits: any[] = [], messages: Hex[] = []
  for (const log of receipt.logs) {
    if (log.removed || log.blockNumber !== receipt.blockNumber || !same(log.transactionHash ?? '', input.sourceTxHash) || !same(log.blockHash ?? '', receipt.blockHash)) throw new Error('Removed or misattributed source log; recovery is blocked.')
    try {
      const decoded = decodeEventLog({ abi: CCTP_RECOVERY_ABI, data: log.data, topics: log.topics })
      if (decoded.eventName === 'DepositForBurn' && same(log.address, source.tokenMessengerAddress)) deposits.push({ ...decoded.args, logIndex: log.logIndex })
      if (decoded.eventName === 'MessageSent' && same(log.address, source.messageTransmitterAddress)) messages.push(decoded.args.message)
    } catch { /* Unrelated receipt logs are not CCTP evidence. */ }
  }
  const candidates = deposits.filter(d => same(d.depositor, tx.from) && (!input.owner || same(d.depositor, input.owner)) && same(d.burnToken, source.usdcAddress) && d.amount > 0n && (!input.mintRecipients || input.mintRecipients.some(a => same(a, d.mintRecipient))) && (input.sourceLogIndex === undefined || d.logIndex === input.sourceLogIndex))
  if (candidates.length !== 1) throw new Error('No unique USDC DepositForBurn matches the source wallet and selected transfer. Recovery is blocked.')
  const d = candidates[0]
  const matched = messages.filter(raw => {
    try {
      const m = decodeCctpRecoveryMessage(raw)
      return m.sourceDomain === source.cctpDomain && m.destinationDomain === d.destinationDomain && same(m.sender, cctpWord(source.tokenMessengerAddress)) && same(m.recipient, d.destinationTokenMessenger) && same(m.burnToken, cctpWord(d.burnToken)) && same(m.messageSender, cctpWord(d.depositor)) && same(m.mintRecipient, d.mintRecipient) && same(m.destinationCaller, d.destinationCaller) && m.amount === d.amount && m.maxFee === d.maxFee && m.minFinality === d.minFinalityThreshold && d.hookData === '0x'
    } catch { return false }
  })
  if (matched.length !== 1 || !Number.isSafeInteger(d.logIndex)) throw new Error('Source MessageSent evidence is missing or ambiguous. No message will be guessed.')
  const fields = decodeCctpRecoveryMessage(matched[0])
  if (![1000, 2000].includes(fields.minFinality) || fields.maxFee >= fields.amount) throw new Error('Unsupported finality or invalid CCTP fee bound.')
  const destination = [1, 5042, 8453, 10, 42161].map(getMainnetCctpChain).find(c => c?.cctpDomain === fields.destinationDomain)
  if (destination && !same(fields.recipient, cctpWord(destination.tokenMessengerAddress))) throw new Error('Unexpected destination TokenMessenger.')
  const solanaDestination = fields.destinationDomain === 5 && same(fields.recipient, ('0x' + BufferlessSolanaProgram()) as Hex)
  // Explicit read-only proof extension. Existing EVM mint execution still
  // requires a non-null allowlisted destinationChainId and cannot use this.
  const suiDestination = fields.destinationDomain === 8 && input.suiDestinationMessenger && same(fields.recipient, input.suiDestinationMessenger)
  if (!destination && !solanaDestination && !suiDestination) throw new Error('Unsupported destination domain or TokenMessenger.')
  return { sourceChainId: source.chainId, destinationChainId: destination?.chainId ?? null, sourceTxHash: input.sourceTxHash, sourceLogIndex: d.logIndex, owner: getAddress(d.depositor), amount: formatUnits(fields.amount, 6), mode: fields.minFinality === 1000 ? 'fast' : 'standard', sourceBlockNumber: receipt.blockNumber, sourceBlockHash: receipt.blockHash, sourceMessage: matched[0], fields }
}
// Solana program's base58 bytes, derived by the same PublicKey implementation used by the existing bridge.
import { PublicKey } from '@solana/web3.js'
function BufferlessSolanaProgram() { return Array.from(new PublicKey(SOLANA_MAINNET_CCTP.tokenMessengerMinterProgram).toBytes(), b => b.toString(16).padStart(2, '0')).join('') }
export function immutableMessageMatches(a: CctpBurnProof['fields'], b: CctpBurnProof['fields']) {
  return ['sourceDomain','destinationDomain','sender','recipient','destinationCaller','minFinality','burnToken','mintRecipient','amount','messageSender','maxFee'].every(k => String(a[k as keyof typeof a]).toLowerCase() === String(b[k as keyof typeof b]).toLowerCase())
}
export async function readBoundCctpAttestation(proof: Pick<CctpBurnProof, 'fields'> & {sourceTxHash:string}, fetcher: typeof fetch = fetch): Promise<{ status: 'pending' | 'complete'; message?: Hex; attestation?: Hex; eventNonce?: string; destinationTxHint?: Hex }> {
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 10_000)
  try {
    const response = await fetcher(`${CIRCLE_MAINNET.irisApiBase}/v2/messages/${proof.fields.sourceDomain}?transactionHash=${encodeURIComponent(proof.sourceTxHash)}`, { headers: { Accept: 'application/json' }, signal: controller.signal })
    if (response.status === 404) return { status: 'pending' }
    if (!response.ok) throw new Error(`Circle recovery API HTTP ${response.status}; no mint was requested.`)
    const reader = response.body?.getReader(); if (!reader) throw new Error('Circle recovery response is missing.')
    const chunks: Uint8Array[] = []; let size = 0
    try { for (;;) { const r = await reader.read(); if (r.done) break; size += r.value.length; if (size > 262144) throw new Error('Circle recovery response exceeds the safety limit.'); chunks.push(r.value) } } finally { void reader.cancel().catch(() => {}) }
    const bytes = new Uint8Array(size); let offset = 0; for (const c of chunks) { bytes.set(c, offset); offset += c.length }
    const payload = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
    if (!Array.isArray(payload?.messages) || payload.messages.length > 64) throw new Error('Circle recovery returned malformed or excessive messages.')
    const matches = payload.messages.filter((v: any) => { try { return typeof v.message === 'string' && immutableMessageMatches(proof.fields, decodeCctpRecoveryMessage(v.message)) } catch { return false } })
    if (matches.length > 1) throw new Error('Multiple Circle messages match this burn. Recovery is blocked rather than guessing.')
    if (!matches.length) {
      if (!payload.messages.length || payload.messages.every((v: any) => v?.status !== 'complete' && (!v?.message || (v?.status === 'pending_confirmations' && v?.message === '0x' && v?.attestation === 'PENDING')))) return { status: 'pending' }
      throw new Error('Circle message does not match the source-chain burn evidence.')
    }
    const v = matches[0], m = decodeCctpRecoveryMessage(v.message)
    if (v.status !== 'complete') return { status: 'pending' }
    if (!/^0x(?:[\da-f]{130})+$/i.test(v.attestation) || m.nonce === ZERO || m.executedFinality < m.minFinality || m.feeExecuted > m.maxFee || m.feeExecuted >= m.amount) throw new Error('Circle attestation, nonce, finality or fee is invalid.')
    if (v.eventNonce !== undefined && !same(String(v.eventNonce), m.nonce)) throw new Error('Circle event nonce does not match the signed message.')
    // Circle's destinationMintTxHash is only a candidate; callers verify it on chain before use.
    const hint = typeof v.destinationMintTxHash === 'string' && /^0x[\da-f]{64}$/i.test(v.destinationMintTxHash) ? v.destinationMintTxHash.toLowerCase() as Hex : undefined
    return { status: 'complete', message: v.message, attestation: v.attestation, eventNonce: m.nonce, ...(hint ? { destinationTxHint: hint } : {}) }
  } finally { clearTimeout(timer) }
}
export async function inspectMainnetTransferRecovery(input: { sourceChainId: number; sourceTxHash: string; owner: string; sourceLogIndex?: number }, ports: { source?: any; destination?: any; fetcher?: typeof fetch } = {}) {
  const proof = await readCctpBurnProof({ ...input, mintRecipients: [cctpWord(input.owner)] }, ports.source)
  if (!proof.destinationChainId || !getMainnetCanaryRoute(proof.sourceChainId, proof.destinationChainId) || (!same(proof.fields.destinationCaller, ZERO) && !same(proof.fields.destinationCaller, cctpWord(input.owner)))) throw new Error('This burn is not an existing supported same-wallet EVM route.')
  const result = await readBoundCctpAttestation(proof, ports.fetcher)
  if (result.status !== 'complete') return { proof, ...result, stage: 'waiting_attestation' as const }
  const destination = getMainnetCctpChain(proof.destinationChainId)!, client = ports.destination ?? cctpRecoveryClient(destination.rpcUrls)
  if (await client.getChainId() !== destination.chainId) throw new Error('Destination RPC returned the wrong chain.')
  const block = await client.getBlock()
  if (typeof block.number !== 'bigint' || !/^0x[0-9a-f]{64}$/i.test(block.hash ?? '')) throw new Error('Destination canonical block is unavailable; mint is blocked.')
  const used = await client.readContract({ address: destination.messageTransmitterAddress, abi: CCTP_RECOVERY_ABI, functionName: 'usedNonces', args: [decodeCctpRecoveryMessage(result.message!).nonce], blockNumber: block.number })
  if (used !== 0n && used !== 1n) throw new Error('Unexpected destination nonce state; mint is blocked.')
  if (!same((await client.getBlock({ blockNumber: block.number })).hash, block.hash)) throw new Error('Destination block changed; retry recovery.')
  if (used === 0n && decodeCctpRecoveryMessage(result.message!).expirationBlock > 0n && block.number >= decodeCctpRecoveryMessage(result.message!).expirationBlock) throw new Error('CCTP attestation expired; request a fresh attestation.')
  return { proof, ...result, stage: used === 1n ? 'complete' as const : 'ready_to_mint' as const }
}
