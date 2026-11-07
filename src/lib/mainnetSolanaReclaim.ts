import { Buffer } from 'buffer'
import {
  ComputeBudgetProgram,
  Connection,
  Message,
  PublicKey,
  Transaction,
  TransactionInstruction,
  VersionedTransaction,
} from '@solana/web3.js'
import { decodeCctpRecoveryMessage, immutableMessageMatches, readBoundCctpAttestation, cctpWord } from './mainnetCctpRecovery'
import { getMainnetCctpChain } from '../config/mainnetCctp'
import { CIRCLE_MAINNET } from '../config/circle'
import { SOLANA_MAINNET_CCTP } from '../config/mainnetSolana'
import { LIGHTHOUSE_PROGRAM_ID, SYSVAR_CLOCK_ID, LighthousePolicyError, decodeLighthouseAssertion, lighthouseAccountRule, lighthouseInstructionName } from './solanaLighthousePolicy'

// Anchor discriminators:
// account:MessageSent -> 83648538a6e1973c
// global:reclaim_event_account -> 5ec6b49f83ec0fae
const MESSAGE_SENT_ACCOUNT_DISCRIMINATOR = Buffer.from('83648538a6e1973c', 'hex')
const RECLAIM_EVENT_ACCOUNT_DISCRIMINATOR = Buffer.from('5ec6b49f83ec0fae', 'hex')
const EVENT_ACCOUNT_WINDOW_MS = 5 * 24 * 60 * 60 * 1000

// Compute budget of the reclaim transaction. Wallets (Phantom) add their own compute budget instructions
// to a transaction that has none, which changes the signed message and must block the broadcast. The
// reclaim therefore carries its own, bounded, budget: the limit comes from simulating this exact
// reclaim, the price from recent fees on its writable accounts, and the priority fee is capped.
// A real Mainnet reclaim_event_account consumed ~145k CU (under the 200k default per instruction).
export const RECLAIM_MAX_COMPUTE_UNITS = 400_000
export const RECLAIM_MIN_CU_PRICE_MICROLAMPORTS = 1_000
export const RECLAIM_MAX_PRIORITY_FEE_LAMPORTS = 50_000 // 0.00005 SOL
const RECLAIM_BASE_FEE_LAMPORTS = 5_000 // one signature (the rent payer)

// dRPC rejects Solana on its free plan (HTTP 400, JSON-RPC 35 "chain is not available on free plan"),
// so it can never serve a reclaim; it only hid the real cause as the last fallback.
const RECLAIM_EXCLUDED_RPCS = new Set(['https://solana.drpc.org'])
export const SOLANA_RECLAIM_RPCS = Array.from(new Set([
  'https://solana-rpc.publicnode.com',
  ...SOLANA_MAINNET_CCTP.rpcUrls,
])).filter((rpcUrl) => !RECLAIM_EXCLUDED_RPCS.has(rpcUrl))

// Provider-availability failures (plan, auth, rate limit, outage, transport). Any other error is the
// real answer of a working provider (e.g. a preflight or program error) and must be the one reported.
const RPC_UNAVAILABLE = /free plan|chain is not available|personal token|api key|unauthori[sz]ed|forbidden|too many requests|rate limit|\b(401|403|408|429|5\d\d)\b|fetch failed|failed to fetch|network|timed? ?out|unavailable/i
function reclaimRpcFailure(errors: unknown[], fallback: string): Error {
  const failures = errors.filter((error): error is Error => error instanceof Error)
  return failures.find((error) => !RPC_UNAVAILABLE.test(error.message)) ?? failures[0] ?? new Error(fallback)
}

export type MainnetSolanaRefundMetadata = {
  sourceTxHash?: string
  messageSentEventAccount: string
  refundableDepositSol: string
  refundAvailableAt: number
  refundDestinationMessage: string
  refundAttestation: string
}

export type MainnetSolanaReclaimResult = {
  txHash?: string
  alreadyClosed: boolean
}

export type MainnetSolanaDiscoveredRefund = MainnetSolanaRefundMetadata & {
  sourceTxHash: string
  createdAt: number
}

// A deposit proven by loadMainnetSolanaRefundMetadata, bound to the wallet it was verified for.
export type MainnetSolanaVerifiedRefund = MainnetSolanaDiscoveredRefund & {
  solanaWallet: string
}

function formatLamports(lamports: number) {
  const whole = Math.floor(lamports / 1_000_000_000)
  const fraction = String(lamports % 1_000_000_000)
    .padStart(9, '0')
    .replace(/0+$/, '')
  return fraction ? `${whole}.${fraction}` : String(whole)
}

function readI64Le(buffer: Buffer, offset: number) {
  let value = 0n
  for (let index = 0; index < 8; index += 1) {
    value |= BigInt(buffer[offset + index] ?? 0) << BigInt(index * 8)
  }

  const signBit = 1n << 63n
  return value & signBit ? value - (1n << 64n) : value
}

function hexBytes(value: string, label: string) {
  const normalized = value.startsWith('0x') ? value.slice(2) : value
  if (!normalized || normalized.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(normalized)) {
    throw new Error(`${label} is not valid hex data.`)
  }
  return Buffer.from(normalized, 'hex')
}

function borshVec(bytes: Buffer) {
  const length = Buffer.alloc(4)
  length.writeUInt32LE(bytes.length, 0)
  return Buffer.concat([length, bytes])
}

async function fetchSolanaSourceAttestation(sourceTxHash: string, sourceMessage: string) {
  const fields = decodeCctpRecoveryMessage(sourceMessage)
  if (fields.sourceDomain !== SOLANA_MAINNET_CCTP.cctpDomain) throw new Error('Wrong Solana source domain.')
  const result = await readBoundCctpAttestation({ fields, sourceTxHash })
  if (result.status !== 'complete' || !result.message || !result.attestation) throw new Error('Circle attestation for this deposit is pending. Recheck later.')
  return { refundDestinationMessage: result.message, refundAttestation: result.attestation }
}

function readU32Be(buffer: Buffer, offset: number) {
  if (buffer.length < offset + 4) {
    throw new Error('Circle MessageSent account is too short.')
  }
  return buffer.readUInt32BE(offset)
}

export function parseOpenMessageSentAccount(input: {
  pubkey: PublicKey
  lamports: number
  data: Buffer
  owner: PublicKey
  payee: PublicKey
}) {
  const { pubkey, lamports, data, payee, owner } = input
  if (!owner.equals(new PublicKey(SOLANA_MAINNET_CCTP.messageTransmitterProgram))) throw new Error('Solana RPC returned a deposit owned by another program.')

  if (data.length < 52 + 376 || data.readUInt32LE(48) !== 376 || !Number.isSafeInteger(lamports) || lamports <= 0) return null
  if (!data.subarray(0, 8).equals(MESSAGE_SENT_ACCOUNT_DISCRIMINATOR)) return null

  const rentPayer = new PublicKey(data.subarray(8, 40))
  if (!rentPayer.equals(payee)) return null

  const createdAtSeconds = readI64Le(data, 40)
  if (createdAtSeconds <= 0n || createdAtSeconds > BigInt(Math.floor(Number.MAX_SAFE_INTEGER / 1000))) return null

  // MessageSent layout:
  // discriminator(8) + rent_payer(32) + created_at(8) + vec_len(4) + message(...)
  // CCTP V2 message destinationDomain is bytes 8..12 within the message.
  const messageOffset = 52
  const destinationDomain = readU32Be(data, messageOffset + 8)
  const sourceMessage = '0x' + data.subarray(messageOffset, messageOffset + 376).toString('hex')
  const parsed = decodeCctpRecoveryMessage(sourceMessage)
  const solanaWord = (key: string) => ('0x' + new PublicKey(key).toBuffer().toString('hex')).toLowerCase()
  if (parsed.burnToken !== solanaWord(SOLANA_MAINNET_CCTP.usdcMint) || parsed.sender !== solanaWord(SOLANA_MAINNET_CCTP.tokenMessengerMinterProgram) || parsed.recipient !== cctpWord(getMainnetCctpChain(5042)!.tokenMessengerAddress).toLowerCase() || parsed.amount <= 0n) throw new Error('Deposit is not a supported Solana USDC CCTP message.')
  if (parsed.sourceDomain !== 5 || parsed.messageSender !== ('0x' + payee.toBuffer().toString('hex')).toLowerCase()) throw new Error('Solana deposit message belongs to a different source wallet.')

  return {
    messageSentEventAccount: pubkey.toBase58(),
    refundableDepositSol: formatLamports(lamports),
    refundAvailableAt: Number(createdAtSeconds) * 1000 + EVENT_ACCOUNT_WINDOW_MS,
    createdAt: Number(createdAtSeconds) * 1000,
    destinationDomain,
    sourceMessage,
  }
}

const keyOf = (x: any): string | undefined => typeof x === 'string' ? x : x?.toBase58?.()

export function isSolanaEventCreation(tx: any, eventAccount: PublicKey): boolean {
  const key = keyOf
  if (!tx?.meta || tx.meta.err !== null || !tx.transaction?.message?.accountKeys?.some((k: any)=>k.signer === true && key(k.pubkey) === eventAccount.toBase58())) return false
  const instructions = [...(tx.transaction.message.instructions ?? []), ...(tx.meta.innerInstructions?.flatMap((x: any)=>x.instructions) ?? [])]
  return instructions.some((i: any)=>key(i.programId) === SOLANA_MAINNET_CCTP.messageTransmitterProgram && i.accounts?.some((a: any)=>key(a) === eventAccount.toBase58()))
}
async function findSourceTransactionForEventAccount(connection: Connection, eventAccount: PublicKey, _createdAtMs: number) {
  const signatures = await connection.getSignaturesForAddress(eventAccount,{limit:10},'finalized')
  const found: string[] = []
  for (const s of signatures.filter(s=>!s.err)) {
    const tx = await connection.getParsedTransaction(s.signature,{commitment:'finalized',maxSupportedTransactionVersion:0})
    if (isSolanaEventCreation(tx,eventAccount)) found.push(s.signature)
  }
  if (found.length !== 1) throw new Error('The exact source transaction for this deposit could not be proven within the bounded lookup.')
  return found[0]
}

async function callSameOriginSolanaRpc(
  method: string,
  params: unknown[],
) {
  const response = await fetch('/api/solana-rpc', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method,
      params,
    }),
  })

  const payload = await response.json().catch(() => null)
  if (!response.ok || payload?.error) {
    throw new Error(
      payload?.error?.message
      || payload?.error
      || `Solana RPC HTTP ${response.status}`,
    )
  }

  return payload?.result
}

// The proxy asks the next provider when one answers null (pruned history), so null here means that
// no provider returned the transaction: it is "not available yet", never proof that it does not exist.
async function readSourceTransactionThroughProxy(sourceTxHash: string): Promise<any> {
  const tx = await callSameOriginSolanaRpc('getTransaction', [sourceTxHash, {
    encoding: 'jsonParsed',
    commitment: 'finalized',
    maxSupportedTransactionVersion: 0,
  }])
  if (tx === null || tx === undefined) throw new Error('The Solana source transaction is not available from the Solana RPC providers yet. Nothing was signed or recorded; retry later.')
  if (tx?.transaction?.signatures?.[0] !== sourceTxHash) throw new Error('Solana RPC returned a different transaction than the one requested. Nothing was signed or recorded.')
  return tx
}

async function discoverProgramAccountsThroughProxy(
  programId: PublicKey,
  payee: PublicKey,
) {
  const result = await callSameOriginSolanaRpc('getProgramAccounts', [
    programId.toBase58(),
    {
      commitment: 'confirmed',
      encoding: 'base64',
      filters: [
        {
          memcmp: {
            offset: 8,
            bytes: payee.toBase58(),
          },
        },
      ],
    },
  ])

  if (!Array.isArray(result) || result.length > 256) throw new Error('Solana deposit scan returned invalid or excessive accounts.')

  return result.map((item: any) => ({
    pubkey: new PublicKey(String(item?.pubkey || '')),
    lamports: Number(item?.account?.lamports ?? 0),
    data: Buffer.from(String(item?.account?.data?.[0] || ''), 'base64'),
    owner: new PublicKey(String(item?.account?.owner || '')),
  }))
}

async function findSourceTransactionThroughProxy(eventAccount: PublicKey, _createdAtMs: number) {
  const signatures = await callSameOriginSolanaRpc('getSignaturesForAddress',[eventAccount.toBase58(),{limit:10,commitment:'finalized'}])
  if (!Array.isArray(signatures) || signatures.length>10) throw new Error('Invalid Solana source lookup response.')
  const found: string[] = []
  for (const s of signatures.filter(s=>!s.err && typeof s.signature === 'string')) {
    const tx = await callSameOriginSolanaRpc('getTransaction',[s.signature,{encoding:'jsonParsed',commitment:'finalized',maxSupportedTransactionVersion:0}])
    if (tx?.transaction?.signatures?.[0] === s.signature && isSolanaEventCreation(tx,eventAccount)) found.push(s.signature)
  }
  if (found.length !== 1) throw new Error('The exact Solana source transaction could not be proven. No amount/time matching is used.')
  return found[0]
}

async function hydrateRefundCandidates(
  candidates: Array<{
    messageSentEventAccount: string
    refundableDepositSol: string
    refundAvailableAt: number
    createdAt: number
    destinationDomain: number
    sourceMessage: string
  }>,
  findSourceTx: (
    eventAccount: PublicKey,
    createdAtMs: number,
  ) => Promise<string | null>,
) {
  const refunds: MainnetSolanaDiscoveredRefund[] = []

  for (const candidate of candidates) {
    try {
      const sourceTxHash = await findSourceTx(
        new PublicKey(candidate.messageSentEventAccount),
        candidate.createdAt,
      )
      if (!sourceTxHash) continue

      const attestation = await fetchSolanaSourceAttestation(sourceTxHash, candidate.sourceMessage)

      refunds.push({
        sourceTxHash,
        createdAt: candidate.createdAt,
        messageSentEventAccount: candidate.messageSentEventAccount,
        refundableDepositSol: candidate.refundableDepositSol,
        refundAvailableAt: candidate.refundAvailableAt,
        ...attestation,
      })
    } catch {
      // A single stale/pending account must not hide other deposits.
    }
  }

  if (candidates.length && !refunds.length) throw new Error('Open Solana deposits were found, but their source transaction or attestation is not yet verified. Refresh later; no reclaim is allowed.')
  return refunds.sort((a, b) => a.refundAvailableAt - b.refundAvailableAt)
}

export async function discoverMainnetSolanaRefunds(
  solanaWallet: string,
): Promise<MainnetSolanaDiscoveredRefund[]> {
  if (!solanaWallet) return []

  const payee = new PublicKey(solanaWallet)
  const programId = new PublicKey(SOLANA_MAINNET_CCTP.messageTransmitterProgram)
  let proxyError: unknown = null

  try {
    const accounts = await discoverProgramAccountsThroughProxy(programId, payee)
    const candidates = accounts
      .map(({ pubkey, lamports, data, owner }) =>
        parseOpenMessageSentAccount({
          pubkey,
          lamports,
          data,
          owner,
          payee,
        }),
      )
      .filter((item): item is NonNullable<typeof item> => Boolean(item))
      .filter(
        (item) =>
          item.destinationDomain === CIRCLE_MAINNET.chains.arc.cctpDomain,
      )

    if (candidates.length === 0) {
      return []
    }

    return await hydrateRefundCandidates(
      candidates,
      findSourceTransactionThroughProxy,
    )
  } catch (error) {
    proxyError = error
  }

  let lastDirectError: unknown = null

  for (const rpcUrl of SOLANA_RECLAIM_RPCS) {
    try {
      const connection = new Connection(rpcUrl, 'confirmed')
      const accounts = await connection.getProgramAccounts(programId, {
        commitment: 'confirmed',
        filters: [
          {
            memcmp: {
              offset: 8,
              bytes: payee.toBase58(),
            },
          },
        ],
      })

      const candidates = accounts
        .map(({ pubkey, account }) =>
          parseOpenMessageSentAccount({
            pubkey,
            lamports: account.lamports,
            data: Buffer.from(account.data),
            owner: account.owner,
            payee,
          }),
        )
        .filter((item): item is NonNullable<typeof item> => Boolean(item))
        .filter(
          (item) =>
            item.destinationDomain === CIRCLE_MAINNET.chains.arc.cctpDomain,
        )

      if (candidates.length === 0) {
        return []
      }

      return await hydrateRefundCandidates(
        candidates,
        (eventAccount, createdAtMs) =>
          findSourceTransactionForEventAccount(
            connection,
            eventAccount,
            createdAtMs,
          ),
      )
    } catch (error) {
      lastDirectError = error
    }
  }

  const error = lastDirectError ?? proxyError
  throw error instanceof Error
    ? error
    : new Error('Unable to scan Solana refundable Circle deposits.')
}

async function getReclaimConnection(eventAccount: PublicKey) {
  const errors: unknown[] = []

  for (const rpcUrl of SOLANA_RECLAIM_RPCS) {
    try {
      const connection = new Connection(rpcUrl, 'confirmed')
      const eventInfo = await connection.getAccountInfo(eventAccount, 'finalized')
      return { connection, eventInfo }
    } catch (error) {
      errors.push(error)
    }
  }

  throw reclaimRpcFailure(errors, 'Solana mainnet RPC is unavailable for reclaim.')
}

// Proof that `payee` itself closed the deposit: a finalized, successful transaction signed by the payee
// whose Circle MessageTransmitterV2 instruction uses this event account and the payee and logs
// ReclaimEventAccount (the only instruction that closes a MessageSent account, to its rent payer).
async function reclaimedByPayee(eventAccount: PublicKey, payee: PublicKey): Promise<boolean> {
  const signatures = await callSameOriginSolanaRpc('getSignaturesForAddress', [eventAccount.toBase58(), { limit: 10, commitment: 'finalized' }])
  if (!Array.isArray(signatures)) return false
  for (const s of signatures.filter((x: any) => x && !x.err && typeof x.signature === 'string')) {
    const tx = await callSameOriginSolanaRpc('getTransaction', [s.signature, { encoding: 'jsonParsed', commitment: 'finalized', maxSupportedTransactionVersion: 0 }]).catch(() => null)
    if (!tx || tx.transaction?.signatures?.[0] !== s.signature || !tx.meta || tx.meta.err !== null) continue
    const keys: any[] = tx.transaction.message?.accountKeys ?? []
    if (!keys.some((k) => k?.signer === true && keyOf(k.pubkey) === payee.toBase58())) continue
    const instructions = [...(tx.transaction.message?.instructions ?? []), ...(tx.meta.innerInstructions?.flatMap((x: any) => x.instructions) ?? [])]
    const usesBoth = instructions.some((i: any) => keyOf(i.programId) === SOLANA_MAINNET_CCTP.messageTransmitterProgram
      && i.accounts?.some((a: any) => keyOf(a) === eventAccount.toBase58()) && i.accounts?.some((a: any) => keyOf(a) === payee.toBase58()))
    const logged = (tx.meta.logMessages ?? []).includes('Program log: Instruction: ReclaimEventAccount')
    if (usesBoth && logged) return true
  }
  return false
}

async function confirmClosedOnAnotherProvider(eventAccount: PublicKey, checkedRpcUrl: string, payee?: PublicKey) {
  const errors: unknown[] = []
  for (const rpcUrl of SOLANA_RECLAIM_RPCS) {
    if (rpcUrl === checkedRpcUrl) continue
    try {
      const info = await new Connection(rpcUrl, 'confirmed').getAccountInfo(eventAccount, 'finalized')
      if (info) throw new Error('Solana RPC providers disagree about this deposit account. Nothing was signed or recorded; retry later.')
      return
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('Solana RPC providers disagree')) throw error
      errors.push(error)
    }
  }
  // Browsers cannot reach a second independent RPC (public archive RPCs refuse browser origins): accept
  // instead the payee's own successful reclaim transaction for this account, read through the proxy.
  if (payee && await reclaimedByPayee(eventAccount, payee).catch(() => false)) return
  throw new Error(`The deposit account closure could not be confirmed by a second Solana RPC (${reclaimRpcFailure(errors, 'no other provider').message}). Nothing was signed or recorded; retry later.`)
}

// After a confirmation error the transaction may still have landed (the confirmation watcher can miss it).
// The signature status decides: landed, failed on chain, or still unknown. Read-only; never re-signs.
async function settleSubmittedReclaim(connection: Connection, txHash: string): Promise<'landed' | 'unknown' | { failed: unknown }> {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const reads = [
      connection.getSignatureStatuses([txHash], { searchTransactionHistory: true }).then((r) => r?.value?.[0] ?? null),
      callSameOriginSolanaRpc('getSignatureStatuses', [[txHash], { searchTransactionHistory: true }]).then((r: any) => r?.value?.[0] ?? null),
    ]
    for (const read of reads) {
      const status: any = await read.catch(() => null)
      if (!status || !['confirmed', 'finalized'].includes(status.confirmationStatus)) continue
      return status.err === null || status.err === undefined ? 'landed' : { failed: status.err }
    }
    if (attempt < 5) await new Promise((resolve) => setTimeout(resolve, 2_500))
  }
  return 'unknown'
}

// Verifies one Solana -> Arc deposit from chain and Circle data only (read-only, never a wallet request):
// 1. the source transaction, read through the same-origin proxy (browsers cannot read history directly:
//    public archive RPCs refuse browser origins), is exactly the requested signature, succeeded and was
//    signed by `solanaWallet`;
// 2. it created exactly one Circle MessageTransmitter event account (a co-signer used by that program);
// 3. that account is open now, owned by MessageTransmitterV2, its rent payer and message sender are
//    `solanaWallet`, and its message is a supported USDC burn to Arc;
// 4. Circle Iris returns a complete attestation for this transaction whose message matches the account.
// Amount and refund time come from the account (lamports, on-chain created_at + 5 days), never estimates.
export async function loadMainnetSolanaRefundMetadata(
  sourceTxHash: string,
  solanaWallet: string,
): Promise<MainnetSolanaVerifiedRefund> {
  if (!sourceTxHash) throw new Error('Solana source transaction is missing.')
  if (!solanaWallet) throw new Error('Original Phantom wallet is missing.')
  const payee = new PublicKey(solanaWallet)

  const tx = await readSourceTransactionThroughProxy(sourceTxHash)
  if (!tx.meta || tx.meta.err !== null) throw new Error('The Solana source transaction did not succeed. Nothing can be reclaimed from it.')
  const accountKeys: any[] = Array.isArray(tx.transaction?.message?.accountKeys) ? tx.transaction.message.accountKeys : []
  if (!accountKeys.some((k) => k?.signer === true && keyOf(k.pubkey) === payee.toBase58())) {
    throw new Error('The Solana source transaction was not signed by this Phantom wallet.')
  }
  const candidates = accountKeys
    .filter((k) => k?.signer === true && keyOf(k.pubkey) !== payee.toBase58())
    .map((k) => new PublicKey(String(keyOf(k.pubkey))))
    .filter((key) => isSolanaEventCreation(tx, key))
  if (candidates.length !== 1) throw new Error('The source transaction does not create exactly one Circle deposit account.')
  const eventAccount = candidates[0]

  const accounts = await callSameOriginSolanaRpc('getMultipleAccounts', [[eventAccount.toBase58()], { encoding: 'base64', commitment: 'finalized' }])
  if (!Array.isArray(accounts?.value) || accounts.value.length !== 1) throw new Error('Invalid Solana account response. Nothing was recorded.')
  const info = accounts.value[0]
  if (!info) throw new Error('The Circle deposit account of this transfer is closed or not visible yet. Nothing was signed or recorded.')
  if (!Array.isArray(info.data) || info.data[1] !== 'base64') throw new Error('Invalid Solana account encoding. Nothing was recorded.')
  const deposit = parseOpenMessageSentAccount({
    pubkey: eventAccount,
    lamports: Number(info.lamports),
    data: Buffer.from(String(info.data[0]), 'base64'),
    owner: new PublicKey(String(info.owner)),
    payee,
  })
  if (!deposit) throw new Error('The Circle deposit account is not an open deposit paid by this Phantom wallet.')
  if (deposit.destinationDomain !== CIRCLE_MAINNET.chains.arc.cctpDomain) throw new Error('This deposit is not a Solana to Arc transfer.')

  const iris = await fetchSolanaSourceAttestation(sourceTxHash, deposit.sourceMessage)
  return {
    sourceTxHash,
    solanaWallet: payee.toBase58(),
    createdAt: deposit.createdAt,
    messageSentEventAccount: deposit.messageSentEventAccount,
    refundableDepositSol: deposit.refundableDepositSol,
    refundAvailableAt: deposit.refundAvailableAt,
    ...iris,
  }
}

async function performMainnetSolanaReclaim(input: {
  provider: PhantomSolanaProvider
  connectedWallet: string
  originalWallet: string
  metadata: MainnetSolanaRefundMetadata
}): Promise<MainnetSolanaReclaimResult> {
  if (input.connectedWallet !== input.originalWallet) {
    throw new Error('Connect the same Phantom wallet that created this Solana transfer.')
  }

  if (Date.now() < input.metadata.refundAvailableAt) {
    throw new Error('This refundable Circle deposit is not eligible yet.')
  }

  const payee = new PublicKey(input.connectedWallet)
  const eventAccount = new PublicKey(input.metadata.messageSentEventAccount)
  const programId = new PublicKey(SOLANA_MAINNET_CCTP.messageTransmitterProgram)
  const [messageTransmitter] = PublicKey.findProgramAddressSync(
    [Buffer.from('message_transmitter')],
    programId,
  )

  const { connection, eventInfo } = await getReclaimConnection(eventAccount)
  if (!eventInfo) {
    if (!input.metadata.sourceTxHash) throw new Error('Account is absent, but its source identity cannot be verified. No reclaim is requested.')
    // History is read through the proxy: browser-origin reads of old transactions fail on public RPCs.
    const source = await readSourceTransactionThroughProxy(input.metadata.sourceTxHash)
    const provesIdentity = isSolanaEventCreation(source, eventAccount) && source.transaction.message.accountKeys.some((k: any) => k?.signer === true && keyOf(k.pubkey) === payee.toBase58())
    if (!provesIdentity) throw new Error('The absent account cannot be bound to a successful Circle source transaction.')
    // One RPC answering "no account" is not proof of closure (it may lag or misbehave). An independent
    // provider must also see the account absent; otherwise nothing is signed and nothing is recorded.
    await confirmClosedOnAnotherProvider(eventAccount, connection.rpcEndpoint, payee)
    return { alreadyClosed: true }
  }

  if (!eventInfo.owner.equals(programId)) {
    throw new Error('Refund account is not owned by Circle MessageTransmitterV2.')
  }

  const eventData = Buffer.from(eventInfo.data)
  if (
    eventData.length < 40
    || !eventData.subarray(0, 8).equals(MESSAGE_SENT_ACCOUNT_DISCRIMINATOR)
  ) {
    throw new Error('Refund account is not a valid Circle MessageSent account.')
  }

  const rentPayer = new PublicKey(eventData.subarray(8, 40))
  if (!rentPayer.equals(payee)) {
    throw new Error('Connected Phantom wallet is not the rent payer for this deposit.')
  }

  const actual = parseOpenMessageSentAccount({ pubkey:eventAccount,lamports:eventInfo.lamports,data:eventData,owner:eventInfo.owner,payee })
  if (!actual || !immutableMessageMatches(decodeCctpRecoveryMessage(actual.sourceMessage), decodeCctpRecoveryMessage(input.metadata.refundDestinationMessage))) throw new Error('The refund attestation is not bound to this deposit account.')
  const chainTime = await connection.getBlockTime(await connection.getSlot('finalized'))
  if (typeof chainTime !== 'number' || chainTime * 1000 < actual.refundAvailableAt) throw new Error('The five-day refund window is not proven elapsed on Solana.')
  const attestation = hexBytes(input.metadata.refundAttestation, 'Circle attestation')
  const destinationMessage = hexBytes(
    input.metadata.refundDestinationMessage,
    'Circle destination message',
  )

  const instructionData = Buffer.concat([
    RECLAIM_EVENT_ACCOUNT_DISCRIMINATOR,
    borshVec(attestation),
    borshVec(destinationMessage),
  ])

  const reclaimInstruction = new TransactionInstruction({
    programId,
    keys: [
      { pubkey: payee, isSigner: true, isWritable: true },
      { pubkey: messageTransmitter, isSigner: false, isWritable: true },
      { pubkey: eventAccount, isSigner: false, isWritable: true },
    ],
    data: instructionData,
  })
  const latest = await connection.getLatestBlockhash('confirmed')
  const build = (units: number, microLamports: number) => new Transaction({
    feePayer: payee,
    recentBlockhash: latest.blockhash,
  }).add(
    ComputeBudgetProgram.setComputeUnitLimit({ units }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports }),
    reclaimInstruction,
  )

  // 1) Measure the reclaim with the maximum budget.
  const recentPrice = await reclaimComputeUnitPrice(connection, [messageTransmitter, eventAccount])
  const probe = await connection.simulateTransaction(build(RECLAIM_MAX_COMPUTE_UNITS, recentPrice))
  if (probe.value.err) throw new Error('Solana reclaim simulation failed; no wallet signature was requested.')
  const used = probe.value.unitsConsumed
  if (typeof used !== 'number' || !Number.isSafeInteger(used) || used <= 0 || used > RECLAIM_MAX_COMPUTE_UNITS) {
    throw new Error('Solana reclaim simulation did not report a usable compute budget; no wallet signature was requested.')
  }
  const units = Math.min(RECLAIM_MAX_COMPUTE_UNITS, Math.ceil(used * 1.2) + 1_000)
  // The price is lowered (never the cap raised) so the priority fee stays within the ceiling.
  const microLamports = Math.min(recentPrice, Math.floor((RECLAIM_MAX_PRIORITY_FEE_LAMPORTS * 1_000_000) / units))
  const priorityFee = Math.ceil((microLamports * units) / 1_000_000)
  if (microLamports < 0 || priorityFee > RECLAIM_MAX_PRIORITY_FEE_LAMPORTS) throw new Error('The reclaim priority fee is above the allowed ceiling; no wallet signature was requested.')
  if (RECLAIM_BASE_FEE_LAMPORTS + priorityFee >= eventInfo.lamports) throw new Error('The reclaim network fee would exceed the refundable deposit; no wallet signature was requested.')

  // 2) The exact transaction Phantom is asked to sign is simulated as built.
  const transaction = build(units, microLamports)
  const simulation = await connection.simulateTransaction(transaction)
  const simulatedUnits = simulation.value.unitsConsumed
  if (simulation.value.err || typeof simulatedUnits !== 'number' || simulatedUnits > units) {
    throw new Error('Solana reclaim simulation failed; no wallet signature was requested.')
  }
  const expectedMessage = transaction.serializeMessage()
  if (input.provider.publicKey && input.provider.publicKey.toBase58() !== input.connectedWallet) throw new Error('Phantom account changed before signing.')
  // Phantom signs exactly once. RPC failover never causes a second wallet prompt.
  const signed = await input.provider.signTransaction(transaction) as Transaction
  if (!signed || typeof signed.serialize !== 'function') {
    throw new Error('Phantom did not return a signed Solana transaction.')
  }

  // The signed message must be byte-for-byte the simulated one, with a single narrow exception:
  // read-only Lighthouse assertions that Phantom inserts (verifyWalletAssertions). Any other change
  // (fee payer, blockhash, signers, writable accounts, the three original instructions, order,
  // programs, accounts, data or compute budget) blocks the broadcast.
  let signedMessage: Buffer | null = null
  try { signedMessage = typeof signed.serializeMessage === 'function' ? signed.serializeMessage() : null } catch { signedMessage = null }
  if (!signedMessage || !signedMessage.equals(expectedMessage)) {
    const assertions = signedMessage ? verifyWalletAssertions(expectedMessage, signedMessage) : { ok: false as const, reason: '' }
    if (!assertions.ok) {
      const details = reclaimMessageDiagnostics(expectedMessage, signedMessage)
      throw new Error(`Phantom changed the reclaim transaction (${describeReclaimMessageChange(expectedMessage, signedMessage)}); broadcasting is blocked. Nothing was sent.${assertions.reason ? ` Reason: ${assertions.reason}.` : ''}${details ? ` Details: ${details}` : ''}`)
    }
  }
  // Exactly one signature, by the rent payer, valid for the message Phantom returned.
  const signature = signed.signatures?.[0]
  if (signed.signatures?.length !== 1 || !signature?.signature || !signature.publicKey.equals(payee) || !signed.verifySignatures()) {
    throw new Error('Phantom returned a missing or invalid signature; broadcasting is blocked. Nothing was sent.')
  }
  const raw = signed.serialize()
  // The exact signed bytes are simulated again with signature verification; their wallet and deposit
  // effects must match a reclaim before anything is sent.
  await assertSignedReclaimSimulation(connection, raw, {
    payee,
    eventAccount,
    eventLamports: eventInfo.lamports,
    units,
    fee: RECLAIM_BASE_FEE_LAMPORTS + priorityFee,
  })
  let txHash: string | null = null
  const sendErrors: unknown[] = []

  for (const rpcUrl of SOLANA_RECLAIM_RPCS) {
    try {
      const rpc = rpcUrl === connection.rpcEndpoint
        ? connection
        : new Connection(rpcUrl, 'confirmed')
      txHash = await rpc.sendRawTransaction(raw, {
        skipPreflight: false,
        maxRetries: 3,
      })
      break
    } catch (error) {
      sendErrors.push(error)
    }
  }

  // After the single Phantom signature an RPC error does not prove the transaction was not broadcast.
  // Report the outcome as unknown; no second signature or new reclaim transaction is created here.
  if (!txHash) {
    const cause = reclaimRpcFailure(sendErrors, 'Unable to submit the Solana reclaim transaction.')
    throw new Error(`The signed reclaim could not be confirmed as submitted (${cause.message}). It may still be processed: re-check the deposit before signing again.`)
  }

  let confirmation: Awaited<ReturnType<Connection['confirmTransaction']>>
  try {
    confirmation = await connection.confirmTransaction({
      signature: txHash,
      blockhash: latest.blockhash,
      lastValidBlockHeight: latest.lastValidBlockHeight,
    }, 'confirmed')
  } catch (error) {
    const outcome = await settleSubmittedReclaim(connection, txHash)
    if (outcome === 'landed') return { txHash, alreadyClosed: false }
    if (outcome !== 'unknown') throw new Error(`Solana reclaim transaction failed: ${JSON.stringify(outcome.failed)}`)
    throw new Error(`Solana reclaim ${txHash} was submitted but its confirmation is unknown (${error instanceof Error ? error.message : String(error)}). Re-check the deposit before signing again.`)
  }

  if (confirmation.value.err) {
    throw new Error(`Solana reclaim transaction failed: ${JSON.stringify(confirmation.value.err)}`)
  }

  return {
    txHash,
    alreadyClosed: false,
  }
}

// Recent priority fee (75th percentile) on the reclaim's writable accounts, with a small floor.
// A failed read falls back to the floor; the cap is applied by the caller.
async function reclaimComputeUnitPrice(connection: Connection, accounts: PublicKey[]): Promise<number> {
  try {
    const fees = await connection.getRecentPrioritizationFees({ lockedWritableAccounts: accounts })
    const values = (Array.isArray(fees) ? fees : [])
      .map((fee) => fee?.prioritizationFee)
      .filter((fee): fee is number => Number.isSafeInteger(fee) && fee >= 0)
      .sort((a, b) => a - b)
    const p75 = values.length ? values[Math.min(values.length - 1, Math.floor(values.length * 0.75))] : 0
    return Math.max(RECLAIM_MIN_CU_PRICE_MICROLAMPORTS, p75)
  } catch {
    return RECLAIM_MIN_CU_PRICE_MICROLAMPORTS
  }
}

const COMPUTE_BUDGET_PROGRAM = ComputeBudgetProgram.programId.toBase58()
const MAX_WALLET_ASSERTIONS = 8

// Accepts a signed message that equals the expected one except for inserted read-only Lighthouse
// assertions (exact program id, allowed type, strictly decoded body, one target already in the reclaim).
export function verifyWalletAssertions(expected: Buffer, signed: Buffer): { ok: true; added: { index: number; name: string }[] } | { ok: false; reason: string } {
  const fail = (reason: string) => ({ ok: false as const, reason })
  let a: Message, b: Message
  try { a = Message.from(expected); b = Message.from(signed) } catch { return fail('the signed message could not be read') }
  const key = (m: Message, i: number) => m.accountKeys[i]?.toBase58()
  if (!a.accountKeys[0] || !b.accountKeys[0] || !a.accountKeys[0].equals(b.accountKeys[0])) return fail('the fee payer changed')
  if (a.recentBlockhash !== b.recentBlockhash) return fail('the blockhash changed')
  if (a.header.numRequiredSignatures !== b.header.numRequiredSignatures) return fail('the signers changed')
  const expectedKeys = new Set(a.accountKeys.map((k) => k.toBase58()))
  const roles = (m: Message, pick: (i: number) => boolean) => m.accountKeys.map((k, i) => (pick(i) ? k.toBase58() : null)).filter(Boolean).sort().join(',')
  // New keys: only the Lighthouse program and, for AssertSysvarClock alone, the read-only Clock sysvar (checked below).
  for (const k of b.accountKeys) if (!expectedKeys.has(k.toBase58()) && k.toBase58() !== LIGHTHOUSE_PROGRAM_ID && k.toBase58() !== SYSVAR_CLOCK_ID) return fail('a new account was added')
  if (roles(a, (i) => a.isAccountSigner(i)) !== roles(b, (i) => b.isAccountSigner(i))) return fail('the signers changed')
  if (roles(a, (i) => a.isAccountWritable(i)) !== roles(b, (i) => b.isAccountWritable(i))) return fail('the writable accounts changed')
  const resolve = (m: Message) => m.compiledInstructions.map((ix) => ({
    program: key(m, ix.programIdIndex),
    accounts: ix.accountKeyIndexes.map((i) => `${key(m, i)}:${m.isAccountSigner(i)}:${m.isAccountWritable(i)}`).join(','),
    targets: ix.accountKeyIndexes.map((i) => key(m, i)),
    data: Buffer.from(ix.data),
  }))
  const original = resolve(a), returned = resolve(b)
  const kept = returned.filter((x) => x.program !== LIGHTHOUSE_PROGRAM_ID)
  if (kept.length !== original.length || !kept.every((x, i) => x.program === original[i].program && x.accounts === original[i].accounts && x.data.equals(original[i].data))) {
    return fail('the original reclaim or compute budget instructions changed')
  }
  const added: { index: number; name: string }[] = []
  for (let index = 0; index < returned.length; index += 1) {
    const x = returned[index]
    if (x.program !== LIGHTHOUSE_PROGRAM_ID) continue
    let name = lighthouseInstructionName(x.data[0])
    try { name = decodeLighthouseAssertion(x.data).name } catch (error) {
      return fail(error instanceof LighthousePolicyError ? `${error.message} (#${index})` : `Lighthouse ${name} could not be verified (#${index})`)
    }
    if (index < 2) return fail(`Lighthouse ${name} was placed before the compute budget (#${index})`)
    if (lighthouseAccountRule(x.data[0]) === 'clock-only') {
      // No account, or exactly the Clock sysvar (read-only, never a signer: the role checks above).
      if (x.targets.length > 1 || (x.targets.length === 1 && x.targets[0] !== SYSVAR_CLOCK_ID)) return fail(`Lighthouse ${name} may reference only the Clock sysvar (#${index})`)
      added.push({ index, name })
      continue
    }
    if (x.targets.length !== 1) return fail(`Lighthouse ${name} must target exactly one account (#${index})`)
    const target = x.targets[0]
    if (!target || !expectedKeys.has(target) || target === LIGHTHOUSE_PROGRAM_ID) return fail(`Lighthouse ${name} targets an account outside the reclaim (#${index})`)
    added.push({ index, name })
  }
  // The Clock sysvar may appear only as the single account of AssertSysvarClock, never as a program.
  if (!expectedKeys.has(SYSVAR_CLOCK_ID) && b.accountKeys.some((k) => k.toBase58() === SYSVAR_CLOCK_ID)) {
    const clockUses = returned.filter((x) => x.program === SYSVAR_CLOCK_ID || x.targets.includes(SYSVAR_CLOCK_ID))
    if (!clockUses.length || clockUses.some((x) => x.program !== LIGHTHOUSE_PROGRAM_ID || lighthouseAccountRule(x.data[0]) !== 'clock-only')) return fail('the Clock sysvar was added outside AssertSysvarClock')
  }
  if (added.length === 0) return fail('the message changed without an added assertion')
  if (added.length > MAX_WALLET_ASSERTIONS) return fail('too many wallet assertions')
  return { ok: true, added }
}

// Re-simulates the exact signed bytes (signature verified) and requires the effects of a reclaim:
// success within the compute limit, the deposit account closed, and the wallet receiving at least the
// deposit minus the fee. Missing or unclear results block the broadcast.
async function assertSignedReclaimSimulation(connection: Connection, raw: Buffer, x: { payee: PublicKey; eventAccount: PublicKey; eventLamports: number; units: number; fee: number }) {
  const blocked = (why: string) => new Error(`The signed reclaim did not pass the final simulation (${why}); broadcasting is blocked. Nothing was sent.`)
  let before: number
  try { before = await connection.getBalance(x.payee, 'confirmed') } catch { throw blocked('the wallet balance could not be read') }
  let result: Awaited<ReturnType<Connection['simulateTransaction']>>
  try {
    result = await connection.simulateTransaction(VersionedTransaction.deserialize(raw), {
      sigVerify: true,
      replaceRecentBlockhash: false,
      commitment: 'confirmed',
      accounts: { encoding: 'base64', addresses: [x.payee.toBase58(), x.eventAccount.toBase58()] },
    })
  } catch {
    throw blocked('the simulation could not be run')
  }
  const v = result?.value
  if (!v || v.err) throw blocked('the signed transaction would fail')
  if (typeof v.unitsConsumed !== 'number' || v.unitsConsumed > x.units) throw blocked('the compute budget was exceeded or not reported')
  const accounts = v.accounts
  if (!Array.isArray(accounts) || accounts.length !== 2) throw blocked('the account effects were not reported')
  const after = accounts[0]?.lamports, deposit = accounts[1]
  if (!Number.isSafeInteger(before) || typeof after !== 'number' || !Number.isSafeInteger(after)) throw blocked('the wallet effect was not reported')
  if (deposit && deposit.lamports !== 0) throw blocked('the deposit account would stay open')
  if (after - before < x.eventLamports - x.fee) throw blocked('the wallet would receive less than the deposit minus the network fee')
}

// Names what a wallet changed in a signed reclaim message (for the error shown to the user only).
export function describeReclaimMessageChange(expected: Buffer, signed: Buffer | null): string {
  if (!signed) return 'no signed message was returned'
  try {
    const a = Message.from(expected), b = Message.from(signed)
    const program = (m: Message, i: number) => m.accountKeys[m.instructions[i].programIdIndex]?.toBase58()
    const metas = (m: Message, i: number) => m.instructions[i].accounts.map((k) => `${m.accountKeys[k]?.toBase58()}:${m.isAccountSigner(k)}:${m.isAccountWritable(k)}`).join(',')
    if (!a.accountKeys[0]?.equals(b.accountKeys[0])) return 'fee payer'
    if (a.recentBlockhash !== b.recentBlockhash) return 'blockhash'
    const budget = (m: Message) => m.instructions.filter((_, i) => program(m, i) === COMPUTE_BUDGET_PROGRAM).length
    if (a.instructions.length !== b.instructions.length) return budget(a) !== budget(b) ? 'compute budget instructions added or removed' : 'instructions added or removed'
    for (let i = 0; i < a.instructions.length; i += 1) {
      if (program(a, i) !== program(b, i)) return 'instruction order or program'
      if (metas(a, i) !== metas(b, i)) return 'instruction accounts'
      if (a.instructions[i].data !== b.instructions[i].data) return program(a, i) === COMPUTE_BUDGET_PROGRAM ? 'compute budget (fee) values' : 'instruction data'
    }
    return 'message header or account list'
  } catch {
    return 'an unreadable message'
  }
}

// Bounded, privacy-safe structure of the change, for the UI error text only (never logged or stored).
// It names instructions by position and program (known programs by name, others shortened) and compares
// the compute unit limit and price. It never includes instruction data (attestation, Circle message),
// signatures, transaction bytes or account addresses. It does not accept any change: the caller still
// blocks the broadcast.
const RECLAIM_DIAGNOSTIC_MAX_CHARS = 600
const RECLAIM_DIAGNOSTIC_MAX_INSTRUCTIONS = 64
const RECLAIM_DIAGNOSTIC_MAX_LISTED = 6
type InstructionShape = { index: number; key: string; label: string; limit?: number; price?: bigint }

const shortProgramId = (id?: string) => (id && id.length > 12 ? `${id.slice(0, 6)}…${id.slice(-4)}` : 'unknown')

function instructionShapes(m: Message): InstructionShape[] {
  const known: Record<string, string> = {
    [COMPUTE_BUDGET_PROGRAM]: 'ComputeBudget',
    [SOLANA_MAINNET_CCTP.messageTransmitterProgram]: 'CircleMessageTransmitterV2',
  }
  return m.compiledInstructions.map((ix, index) => {
    const id = m.accountKeys[ix.programIdIndex]?.toBase58()
    if (id === COMPUTE_BUDGET_PROGRAM) {
      const d = Buffer.from(ix.data)
      if (d[0] === 2 && d.length === 5) return { index, key: 'cb:limit', label: 'ComputeBudget:limit', limit: d.readUInt32LE(1) }
      if (d[0] === 3 && d.length === 9) return { index, key: 'cb:price', label: 'ComputeBudget:price', price: d.readBigUInt64LE(1) }
      return { index, key: `cb:type${d[0] ?? '?'}`, label: `ComputeBudget:type${d[0] ?? '?'}` }
    }
    if (id === LIGHTHOUSE_PROGRAM_ID) {
      const type = lighthouseInstructionName(ix.data[0])
      return { index, key: `lh:${ix.data[0] ?? '?'}`, label: `Lighthouse:${type} (${ix.accountKeyIndexes.length} accounts)` }
    }
    const name = id ? known[id] : undefined
    return { index, key: `p:${id ?? '?'}`, label: name ?? `program ${shortProgramId(id)} (${ix.accountKeyIndexes.length} accounts)` }
  })
}

// Order-preserving diff (longest common subsequence) of instruction kinds.
function instructionDiff(a: InstructionShape[], b: InstructionShape[]) {
  const L = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0))
  for (let i = a.length - 1; i >= 0; i -= 1) for (let j = b.length - 1; j >= 0; j -= 1) {
    L[i][j] = a[i].key === b[j].key ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1])
  }
  const removed: InstructionShape[] = [], added: InstructionShape[] = []
  let i = 0, j = 0
  while (i < a.length && j < b.length) {
    if (a[i].key === b[j].key) { i += 1; j += 1 }
    else if (L[i + 1][j] >= L[i][j + 1]) removed.push(a[i++])
    else added.push(b[j++])
  }
  return { removed: [...removed, ...a.slice(i)], added: [...added, ...b.slice(j)] }
}

export function reclaimMessageDiagnostics(expected: Buffer, signed: Buffer | null): string {
  if (!signed) return ''
  try {
    const a = instructionShapes(Message.from(expected)), b = instructionShapes(Message.from(signed))
    if (a.length > RECLAIM_DIAGNOSTIC_MAX_INSTRUCTIONS || b.length > RECLAIM_DIAGNOSTIC_MAX_INSTRUCTIONS) return 'too many instructions to compare.'
    const list = (items: InstructionShape[]) => items.length === 0 ? 'none'
      : items.slice(0, RECLAIM_DIAGNOSTIC_MAX_LISTED).map((x) => `#${x.index} ${x.label}`).join(', ') + (items.length > RECLAIM_DIAGNOSTIC_MAX_LISTED ? ` +${items.length - RECLAIM_DIAGNOSTIC_MAX_LISTED} more` : '')
    const { removed, added } = instructionDiff(a, b)
    const sameKinds = a.length === b.length && a.every((x, i) => x.key === b[i].key)
    const order = sameKinds ? 'same' : removed.length === 0 && added.length === 0 ? 'changed' : 'differs'
    const budget = (name: 'limit' | 'price') => {
      const pick = (s: InstructionShape[]) => s.filter((x) => x.key === `cb:${name}`).map((x) => String(name === 'limit' ? x.limit : x.price))
      const x = pick(a), y = pick(b)
      const show = (v: string[]) => (v.length === 0 ? 'absent' : v.join('+'))
      return x.join(',') === y.join(',') ? `${name} same (${show(x)})` : `${name} ${show(x)} -> ${show(y)} (changed)`
    }
    const text = `instructions expected ${a.length}, signed ${b.length}; added: ${list(added)}; removed: ${list(removed)}; order ${order}; compute budget ${budget('limit')}, ${budget('price')}.`
    return text.length > RECLAIM_DIAGNOSTIC_MAX_CHARS ? `${text.slice(0, RECLAIM_DIAGNOSTIC_MAX_CHARS - 1)}…` : text
  } catch {
    return 'the signed message could not be read.'
  }
}

export async function reclaimMainnetSolanaDeposit(input: Parameters<typeof performMainnetSolanaReclaim>[0]): Promise<MainnetSolanaReclaimResult> {
  if (typeof navigator === 'undefined' || !navigator.locks) throw new Error('Safe SOL reclaim requires browser transaction locks.')
  return navigator.locks.request(`machina-solana-reclaim:${input.metadata.messageSentEventAccount}`, {ifAvailable:true}, async lock=>{
    if (!lock) throw new Error('Another tab is already reclaiming this deposit. No second wallet request is allowed.')
    return performMainnetSolanaReclaim(input)
  })
}
