import {
  encodeFunctionData,
  getAddress,
  isAddress,
  padHex,
  parseUnits,
  type Hex,
} from 'viem'
import { CIRCLE_MAINNET } from '../config/circle'
import {
  CCTP_V2_CONFIRMED_FINALITY,
  CCTP_V2_ERC20_ABI,
  CCTP_V2_FINALIZED_FINALITY,
  CCTP_V2_MESSAGE_TRANSMITTER_ABI,
  CCTP_V2_TOKEN_MESSENGER_ABI,
  fetchMainnetCctpFees,
  getDefaultMainnetCctpTransferMode,
  getMainnetCctpRoute,
  isMainnetCctpFastTransferSupported,
  type MainnetCctpTransferMode,
} from '../config/mainnetCctp'

export type { MainnetCctpTransferMode } from '../config/mainnetCctp'

export type MainnetCctpQuote = {
  mode: MainnetCctpTransferMode
  amount: string
  amountRaw: bigint
  sourceChainId: number
  destinationChainId: number
  sourceDomain: number
  destinationDomain: number
  minimumFeeBps: number
  estimatedProtocolFeeRaw: bigint
  maxFeeRaw: bigint
  minFinalityThreshold: number
}

export type MainnetCctpPreparedCall = {
  chainId: number
  to: `0x${string}`
  data: Hex
  value: bigint
  description: string
}

export type MainnetCctpAttestation = {
  status: 'pending' | 'complete'
  message?: Hex
  attestation?: Hex
  eventNonce?: string
  decodedMessage?: unknown
}

const ZERO_BYTES32 = `0x${'00'.repeat(32)}` as Hex
const FEE_RATE_SCALE = 10_000_000n
const MILLI_BPS_PER_BPS = 1_000n

function ceilDiv(value: bigint, divisor: bigint) {
  return (value + divisor - 1n) / divisor
}

export function addressToCctpBytes32(address: string): Hex {
  if (!isAddress(address)) {
    throw new Error('Invalid EVM recipient address')
  }

  return padHex(getAddress(address), { size: 32 })
}

export async function quoteMainnetCctpTransfer(input: {
  sourceChainId: number
  destinationChainId: number
  amount: string
  mode?: MainnetCctpTransferMode
}): Promise<MainnetCctpQuote> {
  const route = getMainnetCctpRoute(input.sourceChainId, input.destinationChainId)

  if (!route) {
    throw new Error('Unsupported CCTP mainnet route')
  }

  const mode = input.mode ?? getDefaultMainnetCctpTransferMode(input.sourceChainId)
  if (mode === 'fast' && !isMainnetCctpFastTransferSupported(input.sourceChainId)) {
    throw new Error(`${route.source.name} does not support CCTP Fast Transfer as a source chain`)
  }

  const amountRaw = parseUnits(input.amount, 6)
  if (amountRaw <= 0n) {
    throw new Error('Transfer amount must be greater than zero')
  }

  const finalityThreshold = mode === 'fast'
    ? CCTP_V2_CONFIRMED_FINALITY
    : CCTP_V2_FINALIZED_FINALITY

  const fees = await fetchMainnetCctpFees(input.sourceChainId, input.destinationChainId)
  const fee = fees.find((item) => item.finalityThreshold === finalityThreshold)

  if (!fee) {
    throw new Error(`Circle did not return a ${mode} CCTP fee option for this route`)
  }

  const milliBps = BigInt(Math.ceil(fee.minimumFee * 1_000))
  const estimatedProtocolFeeRaw = milliBps === 0n
    ? 0n
    : ceilDiv(amountRaw * milliBps, FEE_RATE_SCALE)

  const maxFeeRaw = mode === 'fast' && milliBps > 0n
    ? ceilDiv(amountRaw * (milliBps + MILLI_BPS_PER_BPS), FEE_RATE_SCALE)
    : estimatedProtocolFeeRaw > 0n
      ? estimatedProtocolFeeRaw
      : 1n

  if (maxFeeRaw >= amountRaw) {
    throw new Error('Calculated CCTP max fee must be less than the transfer amount')
  }

  return {
    mode,
    amount: input.amount,
    amountRaw,
    sourceChainId: route.source.chainId,
    destinationChainId: route.destination.chainId,
    sourceDomain: route.source.cctpDomain,
    destinationDomain: route.destination.cctpDomain,
    minimumFeeBps: fee.minimumFee,
    estimatedProtocolFeeRaw,
    maxFeeRaw,
    minFinalityThreshold: finalityThreshold,
  }
}

export function prepareMainnetCctpApproval(input: {
  sourceChainId: number
  amountRaw: bigint
}): MainnetCctpPreparedCall {
  const route = getMainnetCctpRoute(input.sourceChainId, 5042)
    ?? Object.values([
      getMainnetCctpRoute(input.sourceChainId, 1),
      getMainnetCctpRoute(input.sourceChainId, 8453),
      getMainnetCctpRoute(input.sourceChainId, 10),
      getMainnetCctpRoute(input.sourceChainId, 42161),
    ]).find(Boolean)

  if (!route) {
    throw new Error('Unsupported CCTP mainnet source chain')
  }

  if (input.amountRaw <= 0n) {
    throw new Error('Approval amount must be greater than zero')
  }

  return {
    chainId: route.source.chainId,
    to: route.source.usdcAddress,
    data: encodeFunctionData({
      abi: CCTP_V2_ERC20_ABI,
      functionName: 'approve',
      args: [route.source.tokenMessengerAddress, input.amountRaw],
    }),
    value: 0n,
    description: `Approve ${route.source.name} USDC for CCTP V2 TokenMessenger`,
  }
}

export function prepareMainnetCctpBurn(input: {
  quote: MainnetCctpQuote
  recipient: string
  destinationCaller?: string
}): MainnetCctpPreparedCall {
  const route = getMainnetCctpRoute(input.quote.sourceChainId, input.quote.destinationChainId)
  if (!route) {
    throw new Error('Unsupported CCTP mainnet route')
  }

  const mintRecipient = addressToCctpBytes32(input.recipient)
  const destinationCaller = input.destinationCaller
    ? addressToCctpBytes32(input.destinationCaller)
    : ZERO_BYTES32

  return {
    chainId: route.source.chainId,
    to: route.source.tokenMessengerAddress,
    data: encodeFunctionData({
      abi: CCTP_V2_TOKEN_MESSENGER_ABI,
      functionName: 'depositForBurn',
      args: [
        input.quote.amountRaw,
        route.destination.cctpDomain,
        mintRecipient,
        route.source.usdcAddress,
        destinationCaller,
        input.quote.maxFeeRaw,
        input.quote.minFinalityThreshold,
      ],
    }),
    value: 0n,
    description: `Burn ${input.quote.amount} USDC on ${route.source.name} for ${route.destination.name}`,
  }
}

export async function fetchMainnetCctpAttestation(input: {
  sourceChainId: number
  transactionHash: Hex
}): Promise<MainnetCctpAttestation> {
  const sourceRoute = getMainnetCctpRoute(input.sourceChainId, 5042)
    ?? Object.values([
      getMainnetCctpRoute(input.sourceChainId, 1),
      getMainnetCctpRoute(input.sourceChainId, 8453),
      getMainnetCctpRoute(input.sourceChainId, 10),
      getMainnetCctpRoute(input.sourceChainId, 42161),
    ]).find(Boolean)

  if (!sourceRoute) {
    throw new Error('Unsupported CCTP mainnet source chain')
  }

  const response = await fetch(
    `${CIRCLE_MAINNET.irisApiBase}/v2/messages/${sourceRoute.source.cctpDomain}?transactionHash=${encodeURIComponent(input.transactionHash)}`,
    { headers: { Accept: 'application/json' } },
  )

  if (response.status === 404) {
    return { status: 'pending' }
  }

  if (!response.ok) {
    throw new Error(`Circle CCTP messages API HTTP ${response.status}`)
  }

  const payload = await response.json()
  const message = Array.isArray(payload?.messages) ? payload.messages[0] : undefined

  if (!message || message.status !== 'complete' || !message.message || !message.attestation) {
    return { status: 'pending' }
  }

  return {
    status: 'complete',
    message: message.message as Hex,
    attestation: message.attestation as Hex,
    eventNonce: message.eventNonce != null ? String(message.eventNonce) : undefined,
    decodedMessage: message.decodedMessage,
  }
}

export function prepareMainnetCctpMint(input: {
  destinationChainId: number
  message: Hex
  attestation: Hex
}): MainnetCctpPreparedCall {
  const destinationRoute = getMainnetCctpRoute(8453, input.destinationChainId)
    ?? Object.values([
      getMainnetCctpRoute(1, input.destinationChainId),
      getMainnetCctpRoute(10, input.destinationChainId),
      getMainnetCctpRoute(42161, input.destinationChainId),
      getMainnetCctpRoute(5042, input.destinationChainId),
    ]).find(Boolean)

  if (!destinationRoute) {
    throw new Error('Unsupported CCTP mainnet destination chain')
  }

  return {
    chainId: destinationRoute.destination.chainId,
    to: destinationRoute.destination.messageTransmitterAddress,
    data: encodeFunctionData({
      abi: CCTP_V2_MESSAGE_TRANSMITTER_ABI,
      functionName: 'receiveMessage',
      args: [input.message, input.attestation],
    }),
    value: 0n,
    description: `Submit CCTP V2 attestation on ${destinationRoute.destination.name}`,
  }
}
