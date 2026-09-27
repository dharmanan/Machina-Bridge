import { Buffer } from 'buffer'
import {
  Connection,
  PublicKey,
  Transaction,
  TransactionInstruction,
} from '@solana/web3.js'
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

    const keys = parsed.transaction.message.accountKeys.map((item) =>
      new PublicKey(item.pubkey.toBase58()),
    )
    const infos = await connection.getMultipleAccountsInfo(keys, 'confirmed')

    for (let index = 0; index < keys.length; index += 1) {
      const info = infos[index]
      if (!info || !info.owner.equals(programId)) continue

      const data = Buffer.from(info.data)
      if (data.length < 52) continue
      if (!data.subarray(0, 8).equals(MESSAGE_SENT_ACCOUNT_DISCRIMINATOR)) continue

      const rentPayer = new PublicKey(data.subarray(8, 40))
      if (!rentPayer.equals(payee)) continue

      const createdAtSeconds = readI64Le(data, 40)
      if (createdAtSeconds <= 0n) continue

      return {
        messageSentEventAccount: keys[index].toBase58(),
        refundableDepositSol: formatLamports(info.lamports),
        refundAvailableAt: Number(createdAtSeconds) * 1000 + EVENT_ACCOUNT_WINDOW_MS,
      }
    }

    return null
  })
}

async function fetchSolanaSourceAttestation(sourceTxHash: string) {
  const response = await fetch(
    `${CIRCLE_MAINNET.irisApiBase}/v2/messages/${SOLANA_MAINNET_CCTP.cctpDomain}?transactionHash=${encodeURIComponent(sourceTxHash)}`,
    { headers: { Accept: 'application/json' } },
  )

  if (!response.ok) {
    throw new Error(`Circle CCTP messages API HTTP ${response.status}`)
  }

  const payload = await response.json()
  const message = Array.isArray(payload?.messages)
    ? payload.messages.find((item: any) =>
        item?.status === 'complete'
        && typeof item?.message === 'string'
        && typeof item?.attestation === 'string'
      )
    : undefined

  if (!message) {
    throw new Error('Circle attestation for this Solana transfer is not available yet.')
  }

  return {
    refundDestinationMessage: String(message.message),
    refundAttestation: String(message.attestation),
  }
}

async function getReclaimConnection(eventAccount: PublicKey) {
  let lastError: unknown = null

  for (const rpcUrl of SOLANA_RECLAIM_RPCS) {
    try {
      const connection = new Connection(rpcUrl, 'confirmed')
      const eventInfo = await connection.getAccountInfo(eventAccount, 'confirmed')
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

  const [eventAccount, iris] = await Promise.all([
    findMessageSentEventAccount(sourceTxHash, solanaWallet),
    fetchSolanaSourceAttestation(sourceTxHash),
  ])

  return {
    ...eventAccount,
    ...iris,
  }
}

export async function reclaimMainnetSolanaDeposit(input: {
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

  // Phantom signs exactly once. RPC failover never causes a second wallet prompt.
  const signed = await input.provider.signTransaction(transaction) as Transaction
  if (!signed || typeof signed.serialize !== 'function') {
    throw new Error('Phantom did not return a signed Solana transaction.')
  }

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
