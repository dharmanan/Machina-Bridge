import { Buffer } from 'buffer'
import {
  Connection,
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

const SOLANA_RECLAIM_RPCS = Array.from(new Set([
  'https://solana-rpc.publicnode.com',
  ...SOLANA_MAINNET_CCTP.rpcUrls,
]))

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

async function withReadableSolanaConnection<T>(
  operation: (connection: Connection) => Promise<T | null>,
): Promise<T> {
  let lastError: unknown = null

  for (const rpcUrl of SOLANA_RECLAIM_RPCS) {
    try {
      const result = await operation(new Connection(rpcUrl, 'confirmed'))
      if (result !== null) return result
    } catch (error) {
      lastError = error
    }
  }

  if (lastError instanceof Error) throw lastError
  throw new Error('Solana mainnet RPC did not return the requested reclaim data.')
}

async function findMessageSentEventAccount(
  sourceTxHash: string,
  solanaWallet: string,
) {
  const programId = new PublicKey(SOLANA_MAINNET_CCTP.messageTransmitterProgram)
  const payee = new PublicKey(solanaWallet)

  return withReadableSolanaConnection(async (connection) => {
    const parsed = await connection.getParsedTransaction(sourceTxHash, {
      commitment: 'confirmed',
      maxSupportedTransactionVersion: 0,
    })

    if (!parsed) return null

    if (!parsed.meta || parsed.meta.err !== null || !parsed.transaction.message.accountKeys.some(k => k.signer && k.pubkey.equals(payee))) throw new Error('The Solana source transaction did not succeed for the connected Phantom wallet.')
    const keys = parsed.transaction.message.accountKeys.map(item => new PublicKey(item.pubkey.toBase58()))
    const infos = await connection.getMultipleAccountsInfo(keys, 'finalized')
    const found = infos.flatMap((info, i) => {
      if (!info || !info.owner.equals(programId)) return []
      const candidate = parseOpenMessageSentAccount({pubkey:keys[i],lamports:info.lamports,data:Buffer.from(info.data),owner:info.owner,payee})
      return candidate && isSolanaEventCreation(parsed, keys[i]) ? [candidate] : []
    })
    if (found.length !== 1) throw new Error('No unique open Circle deposit account matches this source transaction.')
    return found[0]
  })
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

export function isSolanaEventCreation(tx: any, eventAccount: PublicKey): boolean {
  const key = (x: any) => typeof x === 'string' ? x : x?.toBase58?.()
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
    if (isSolanaEventCreation(tx,eventAccount)) found.push(s.signature)
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
  let lastError: unknown = null

  for (const rpcUrl of SOLANA_RECLAIM_RPCS) {
    try {
      const connection = new Connection(rpcUrl, 'confirmed')
      const eventInfo = await connection.getAccountInfo(eventAccount, 'finalized')
      return { connection, eventInfo }
    } catch (error) {
      lastError = error
    }
  }

  if (lastError instanceof Error) throw lastError
  throw new Error('Solana mainnet RPC is unavailable for reclaim.')
}

export async function loadMainnetSolanaRefundMetadata(
  sourceTxHash: string,
  solanaWallet: string,
): Promise<MainnetSolanaRefundMetadata> {
  if (!sourceTxHash) throw new Error('Solana source transaction is missing.')
  if (!solanaWallet) throw new Error('Original Phantom wallet is missing.')

  const eventAccount = await findMessageSentEventAccount(sourceTxHash, solanaWallet)
  const iris = await fetchSolanaSourceAttestation(sourceTxHash, eventAccount.sourceMessage)
  return { ...eventAccount, ...iris, sourceTxHash }

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
    const source = await connection.getParsedTransaction(input.metadata.sourceTxHash, {commitment:'finalized',maxSupportedTransactionVersion:0})
    const provesIdentity = isSolanaEventCreation(source, eventAccount) && source!.transaction.message.accountKeys.some(k=>k.signer && k.pubkey.equals(payee))
    if (!provesIdentity) throw new Error('The absent account cannot be bound to a successful Circle source transaction.')
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

  const latest = await connection.getLatestBlockhash('confirmed')
  const transaction = new Transaction({
    feePayer: payee,
    recentBlockhash: latest.blockhash,
  }).add(new TransactionInstruction({
    programId,
    keys: [
      { pubkey: payee, isSigner: true, isWritable: true },
      { pubkey: messageTransmitter, isSigner: false, isWritable: true },
      { pubkey: eventAccount, isSigner: false, isWritable: true },
    ],
    data: instructionData,
  }))

  const simulation = await connection.simulateTransaction(transaction)
  if (simulation.value.err) throw new Error('Solana reclaim simulation failed; no wallet signature was requested.')
  const expectedMessage = transaction.serializeMessage()
  if (input.provider.publicKey && input.provider.publicKey.toBase58() !== input.connectedWallet) throw new Error('Phantom account changed before signing.')
  // Phantom signs exactly once. RPC failover never causes a second wallet prompt.
  const signed = await input.provider.signTransaction(transaction) as Transaction
  if (!signed || typeof signed.serialize !== 'function') {
    throw new Error('Phantom did not return a signed Solana transaction.')
  }

  if (!signed.serializeMessage().equals(expectedMessage)) throw new Error('Phantom changed the reclaim transaction; broadcasting is blocked.')
  const raw = signed.serialize()
  let txHash: string | null = null
  let sendError: unknown = null

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
      sendError = error
    }
  }

  if (!txHash) {
    throw sendError instanceof Error
      ? sendError
      : new Error('Unable to submit the Solana reclaim transaction.')
  }

  const confirmation = await connection.confirmTransaction({
    signature: txHash,
    blockhash: latest.blockhash,
    lastValidBlockHeight: latest.lastValidBlockHeight,
  }, 'confirmed')

  if (confirmation.value.err) {
    throw new Error(`Solana reclaim transaction failed: ${JSON.stringify(confirmation.value.err)}`)
  }

  return {
    txHash,
    alreadyClosed: false,
  }
}

export async function reclaimMainnetSolanaDeposit(input: Parameters<typeof performMainnetSolanaReclaim>[0]): Promise<MainnetSolanaReclaimResult> {
  if (typeof navigator === 'undefined' || !navigator.locks) throw new Error('Safe SOL reclaim requires browser transaction locks.')
  return navigator.locks.request(`machina-solana-reclaim:${input.metadata.messageSentEventAccount}`, {ifAvailable:true}, async lock=>{
    if (!lock) throw new Error('Another tab is already reclaiming this deposit. No second wallet request is allowed.')
    return performMainnetSolanaReclaim(input)
  })
}
