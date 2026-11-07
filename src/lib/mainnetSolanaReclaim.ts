import { Buffer } from 'buffer'
import {
  ComputeBudgetProgram,
  Connection,
  Message,
  PublicKey,
  Transaction,
  TransactionInstruction,
} from '@solana/web3.js'
import { decodeCctpRecoveryMessage, immutableMessageMatches, readBoundCctpAttestation, cctpWord } from './mainnetCctpRecovery'
import { getMainnetCctpChain } from '../config/mainnetCctp'
import { CIRCLE_MAINNET } from '../config/circle'
import { SOLANA_MAINNET_CCTP } from '../config/mainnetSolana'

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

async function confirmClosedOnAnotherProvider(eventAccount: PublicKey, checkedRpcUrl: string) {
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
  throw new Error(`The deposit account closure could not be confirmed by a second Solana RPC (${reclaimRpcFailure(errors, 'no other provider').message}). Nothing was signed or recorded; retry later.`)
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
    await confirmClosedOnAnotherProvider(eventAccount, connection.rpcEndpoint)
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

  // The signed message must be byte-for-byte the simulated one: no tolerance for any change
  // (fee payer, blockhash, instructions, order, programs, accounts, data or compute budget).
  const signedMessage = typeof signed.serializeMessage === 'function' ? signed.serializeMessage() : null
  if (!signedMessage || !signedMessage.equals(expectedMessage)) {
    throw new Error(`Phantom changed the reclaim transaction (${describeReclaimMessageChange(expectedMessage, signedMessage)}); broadcasting is blocked. Nothing was sent.`)
  }
  const raw = signed.serialize()
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

export async function reclaimMainnetSolanaDeposit(input: Parameters<typeof performMainnetSolanaReclaim>[0]): Promise<MainnetSolanaReclaimResult> {
  if (typeof navigator === 'undefined' || !navigator.locks) throw new Error('Safe SOL reclaim requires browser transaction locks.')
  return navigator.locks.request(`machina-solana-reclaim:${input.metadata.messageSentEventAccount}`, {ifAvailable:true}, async lock=>{
    if (!lock) throw new Error('Another tab is already reclaiming this deposit. No second wallet request is allowed.')
    return performMainnetSolanaReclaim(input)
  })
}
