import { useCallback, useState } from 'react'
import { createPublicClient, formatUnits, http, pad, parseAbi, parseUnits, zeroAddress } from 'viem'
import { useAccount, useSwitchChain, useWalletClient } from 'wagmi'
import { getWalletClient } from 'wagmi/actions'
import { ARC_EVM_CHAIN, ARC_EVM_CHAIN_ID, SEPOLIA_EVM_CHAIN, SEPOLIA_EVM_CHAIN_ID } from '../lib/chains'
import { wagmiConfig } from '../lib/wagmi.config'
import {
  deriveSolanaUsdcAta,
  fetchSolanaUsdcBalance,
  SOLANA_DEVNET_DOMAIN_ID,
  SOLANA_DEVNET_GATEWAY_MINTER,
  SOLANA_DEVNET_NAME,
  SOLANA_DEVNET_USDC_MINT,
  toSolanaBytes32Hex,
} from '../lib/solana'

const GATEWAY_API_BASE = 'https://gateway-api-testnet.circle.com'
const GATEWAY_WALLET_ADDRESS = '0x0077777d7EBA4688BDeF3E311b846F25870A19B9'
const TRANSFER_POLL_INTERVAL_MS = 5_000
const TRANSFER_POLL_TIMEOUT_MS = 300_000
const DESTINATION_BALANCE_POLL_INTERVAL_MS = 5_000
const DESTINATION_BALANCE_POLL_TIMEOUT_MS = 180_000
const RECEIPT_WAIT_TIMEOUT_MS = 45_000
const APPROVAL_ALLOWANCE_POLL_TIMEOUT_MS = 30_000
const APPROVAL_ALLOWANCE_POLL_INTERVAL_MS = 3_000
const WALLET_CLIENT_REFRESH_TIMEOUT_MS = 15_000
const WALLET_CLIENT_REFRESH_INTERVAL_MS = 500
const MIN_FORWARD_FEE_BUFFER_RAW = 10_000n
const FORWARD_FEE_BUFFER_BPS = 300n
const GATEWAY_BALANCE_TYPE_AVAILABLE = 1n

const ERC20_ABI = parseAbi([
  'function approve(address spender, uint256 amount) external returns (bool)',
  'function allowance(address owner, address spender) external view returns (uint256)',
  'function balanceOf(address account) external view returns (uint256)',
])

const GATEWAY_WALLET_ABI = parseAbi([
  'function deposit(address token, uint256 value) external',
  'function balanceOf(address depositor, uint256 id) external view returns (uint256)',
])

const TRANSFER_SPEC_TYPES = [
  { name: 'version', type: 'uint32' },
  { name: 'sourceDomain', type: 'uint32' },
  { name: 'destinationDomain', type: 'uint32' },
  { name: 'sourceContract', type: 'bytes32' },
  { name: 'destinationContract', type: 'bytes32' },
  { name: 'sourceToken', type: 'bytes32' },
  { name: 'destinationToken', type: 'bytes32' },
  { name: 'sourceDepositor', type: 'bytes32' },
  { name: 'destinationRecipient', type: 'bytes32' },
  { name: 'sourceSigner', type: 'bytes32' },
  { name: 'destinationCaller', type: 'bytes32' },
  { name: 'value', type: 'uint256' },
  { name: 'salt', type: 'bytes32' },
  { name: 'hookData', type: 'bytes' },
] as const

const BURN_INTENT_TYPES = [
  { name: 'maxBlockHeight', type: 'uint256' },
  { name: 'maxFee', type: 'uint256' },
  { name: 'spec', type: 'TransferSpec' },
] as const

const GATEWAY_SOURCE_CHAINS = {
  [SEPOLIA_EVM_CHAIN_ID]: {
    chainId: SEPOLIA_EVM_CHAIN_ID,
    name: 'Sepolia',
    domainId: 0,
    usdcAddress: '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238',
    chain: SEPOLIA_EVM_CHAIN,
  },
  [ARC_EVM_CHAIN_ID]: {
    chainId: ARC_EVM_CHAIN_ID,
    name: 'Arc Testnet',
    domainId: 26,
    usdcAddress: '0x3600000000000000000000000000000000000000',
    chain: ARC_EVM_CHAIN,
  },
} as const

const gatewayPublicClients = {
  [SEPOLIA_EVM_CHAIN_ID]: createPublicClient({
    chain: SEPOLIA_EVM_CHAIN,
    transport: http(import.meta.env.VITE_SEPOLIA_RPC?.trim() || SEPOLIA_EVM_CHAIN.rpcUrls.default.http[0]),
  }),
  [ARC_EVM_CHAIN_ID]: createPublicClient({
    chain: ARC_EVM_CHAIN,
    transport: http(import.meta.env.VITE_ARC_TESTNET_RPC?.trim() || ARC_EVM_CHAIN.rpcUrls.default.http[0]),
  }),
} as const

type GatewaySourceChainId = keyof typeof GATEWAY_SOURCE_CHAINS
type GatewayWalletClient = NonNullable<Awaited<ReturnType<typeof getWalletClient>>>
type GatewayWriteRequest = Record<string, unknown> & {
  account?: `0x${string}`
}

export type GatewayForwardingStep =
  | 'idle'
  | 'switching-network'
  | 'validating-recipient'
  | 'estimating'
  | 'signing-burn-intent'
  | 'submitting-transfer'
  | 'waiting-finality'
  | 'success'
  | 'error'

export interface GatewayForwardingState {
  step: GatewayForwardingStep
  error: string | null
  isLoading: boolean
  transferId?: string
  status?: string
  recipientAta?: string
  destinationBalanceBefore?: string
  destinationBalanceAfter?: string
  fundsArrivalChecked?: boolean
  fundsArrived?: boolean
  sourceChainId?: GatewaySourceChainId
  result: unknown | null
}

export interface GatewayWalletState {
  availableBalance: string
  onchainAvailableBalance: string
  walletBalance: string
  allowance: string
  pendingDeposits: GatewayPendingDeposit[]
  isLoadingBalances: boolean
  isDepositing: boolean
  isPollingDeposit: boolean
  depositStatus: string | null
  error: string | null
  approvalTxHash?: `0x${string}`
  depositTxHash?: `0x${string}`
}

export interface GatewayPendingDeposit {
  depositor: string
  domain: number
  transactionHash: string
  amount: string
  status: string
  blockHeight?: string
  blockHash?: string
  blockTimestamp?: string
}

interface ForwardToSolanaParams {
  amount: string
  sourceChainId: GatewaySourceChainId
  recipientWalletAddress: string
}

interface GatewayDepositParams {
  amount: string
  sourceChainId: GatewaySourceChainId
}

interface GatewayForwardEstimateResult {
  ataAddress: string
  estimateJson: unknown
  maxBlockHeight: bigint
  maxFeeRaw: bigint
  totalRequiredRaw: bigint
  estimatedFee: string
  feeBuffer: string
  totalRequired: string
  ownerHex: `0x${string}`
  specBytes32: {
    version: number
    sourceDomain: number
    destinationDomain: number
    sourceContract: `0x${string}`
    destinationContract: `0x${string}`
    sourceToken: `0x${string}`
    destinationToken: `0x${string}`
    sourceDepositor: `0x${string}`
    destinationRecipient: `0x${string}`
    sourceSigner: `0x${string}`
    destinationCaller: `0x${string}`
    value: bigint
    salt: `0x${string}`
    hookData: `0x${string}`
  }
}

function serializeBigInts(_key: string, value: unknown) {
  return typeof value === 'bigint' ? value.toString() : value
}

function toRandomHex32() {
  const bytes = new Uint8Array(32)
  globalThis.crypto.getRandomValues(bytes)
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
  return `0x${hex}` as `0x${string}`
}

function delay(milliseconds: number) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

function getErrorMessage(error: unknown) {
  if (error instanceof Error) {
    if (error.message.toLowerCase().includes('replacement transaction underpriced')) {
      return 'A pending wallet transaction with the same nonce is blocking this request. Open MetaMask on the selected source chain, speed up or cancel the pending transaction, then try again.'
    }

    return error.message
  }

  return 'Gateway forwarding failed'
}

function isReplacementUnderpricedError(error: unknown) {
  return getErrorMessage(error).toLowerCase().includes('replacement transaction underpriced')
}

function bumpFee(value: bigint, numerator = 3n, denominator = 2n) {
  return (value * numerator + denominator - 1n) / denominator
}

async function getReplacementFeeOverrides(publicClient: (typeof gatewayPublicClients)[GatewaySourceChainId]) {
  try {
    const feeEstimate = (await publicClient.estimateFeesPerGas()) as {
      gasPrice?: bigint
      maxFeePerGas?: bigint
      maxPriorityFeePerGas?: bigint
    }

    if (feeEstimate.maxFeePerGas && feeEstimate.maxPriorityFeePerGas) {
      return {
        maxFeePerGas: bumpFee(feeEstimate.maxFeePerGas),
        maxPriorityFeePerGas: bumpFee(feeEstimate.maxPriorityFeePerGas, 2n, 1n),
      }
    }

    if (feeEstimate.gasPrice) {
      return {
        gasPrice: bumpFee(feeEstimate.gasPrice),
      }
    }
  } catch {
    // Fall through to gasPrice fallback.
  }

  try {
    const gasPrice = await publicClient.getGasPrice()
    return {
      gasPrice: bumpFee(gasPrice),
    }
  } catch {
    return {}
  }
}

async function writeContractWithReplacementRetry(params: {
  walletClient: GatewayWalletClient
  publicClient: (typeof gatewayPublicClients)[GatewaySourceChainId]
  request: GatewayWriteRequest
  onRetry?: () => void
}) {
  const { walletClient, publicClient, request, onRetry } = params

  try {
    return await walletClient.writeContract(request as never)
  } catch (error) {
    if (!isReplacementUnderpricedError(error)) {
      throw error
    }

    onRetry?.()

    const feeOverrides = await getReplacementFeeOverrides(publicClient)
    const nonce = request.account
      ? await publicClient.getTransactionCount({
          address: request.account,
          blockTag: 'latest',
        })
      : undefined

    try {
      return await walletClient.writeContract(
        {
          ...request,
          ...feeOverrides,
          ...(nonce !== undefined ? { nonce } : {}),
        } as never,
      )
    } catch (retryError) {
      if (isReplacementUnderpricedError(retryError)) {
        throw new Error(
          'A pending wallet transaction with the same nonce is still blocking this request. Open MetaMask on the selected source chain, speed up or cancel the pending transaction, then retry.',
        )
      }

      throw retryError
    }
  }
}

function formatUsdcAmount(value: bigint) {
  return Number(formatUnits(value, 6)).toFixed(6)
}

function parseFormattedUsdcAmount(value: string) {
  try {
    return parseUnits(value, 6)
  } catch {
    return 0n
  }
}

async function waitForSolanaUsdcArrival(params: {
  ownerAddress: string
  baselineRaw: bigint
  expectedIncreaseRaw: bigint
  timeoutMs?: number
}) {
  const { ownerAddress, baselineRaw, expectedIncreaseRaw, timeoutMs = DESTINATION_BALANCE_POLL_TIMEOUT_MS } = params
  const targetRaw = baselineRaw + expectedIncreaseRaw
  const pollStart = Date.now()
  let latestBalanceRaw = baselineRaw

  while (Date.now() - pollStart < timeoutMs) {
    try {
      const latestBalance = await fetchSolanaUsdcBalance(ownerAddress)
      latestBalanceRaw = parseFormattedUsdcAmount(latestBalance)

      if (latestBalanceRaw >= targetRaw) {
        return {
          arrived: true,
          balanceRaw: latestBalanceRaw,
        }
      }
    } catch {
      // Continue polling until timeout.
    }

    await delay(DESTINATION_BALANCE_POLL_INTERVAL_MS)
  }

  return {
    arrived: false,
    balanceRaw: latestBalanceRaw,
  }
}

function parseRawBigInt(value: string | undefined) {
  try {
    return BigInt(value ?? '0')
  } catch {
    return 0n
  }
}

function absoluteBigInt(value: bigint) {
  return value < 0n ? -value : value
}

function parseGatewayApiBalance(value: string | undefined, onchainAvailableBalance: bigint) {
  const normalizedValue = value?.trim() ?? ''
  if (!normalizedValue) {
    return 0n
  }

  const candidates = new Set<bigint>()

  try {
    candidates.add(BigInt(normalizedValue))
  } catch {
    // Ignore parse failures and try decimal parsing below.
  }

  try {
    candidates.add(parseUnits(normalizedValue, 6))
  } catch {
    // Ignore parse failures and fall back to other candidates.
  }

  if (candidates.size === 0) {
    return 0n
  }

  return Array.from(candidates).sort((left, right) => {
    const leftDistance = absoluteBigInt(left - onchainAvailableBalance)
    const rightDistance = absoluteBigInt(right - onchainAvailableBalance)
    return leftDistance < rightDistance ? -1 : leftDistance > rightDistance ? 1 : 0
  })[0]
}

function getGatewayBalanceId(tokenAddress: `0x${string}`, balanceType = GATEWAY_BALANCE_TYPE_AVAILABLE) {
  return (balanceType << 160n) | BigInt(tokenAddress)
}

function applyForwardFeeSafetyBuffer(estimatedMaxFeeRaw: bigint) {
  const percentageBuffer = (estimatedMaxFeeRaw * FORWARD_FEE_BUFFER_BPS + 9_999n) / 10_000n
  const feeBufferRaw = percentageBuffer > MIN_FORWARD_FEE_BUFFER_RAW ? percentageBuffer : MIN_FORWARD_FEE_BUFFER_RAW

  return {
    feeBufferRaw,
    bufferedMaxFeeRaw: estimatedMaxFeeRaw + feeBufferRaw,
  }
}

async function postGatewayJson<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(`${GATEWAY_API_BASE}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  })

  return parseJsonResponse(response) as Promise<T>
}

function normalizeGatewayDeposits(deposits: unknown) {
  if (!Array.isArray(deposits)) {
    return [] as GatewayPendingDeposit[]
  }

  return deposits.map((deposit) => {
    const item = deposit as Record<string, unknown>
    return {
      depositor: String(item.depositor ?? ''),
      domain: Number(item.domain ?? 0),
      transactionHash: String(item.transactionHash ?? ''),
      amount: String(item.amount ?? '0'),
      status: String(item.status ?? 'pending'),
      blockHeight: item.blockHeight ? String(item.blockHeight) : undefined,
      blockHash: item.blockHash ? String(item.blockHash) : undefined,
      blockTimestamp: item.blockTimestamp ? String(item.blockTimestamp) : undefined,
    }
  })
}

function buildSolanaGatewaySpec(params: {
  amount: string
  depositor: `0x${string}`
  recipientWalletAddress: string
  sourceChainId: GatewaySourceChainId
  salt?: `0x${string}`
}) {
  const { amount, depositor, recipientWalletAddress, sourceChainId } = params
  const sourceChain = GATEWAY_SOURCE_CHAINS[sourceChainId]

  if (!sourceChain) {
    throw new Error('Selected source chain is not supported for Gateway forwarding.')
  }

  const transferValue = parseUnits(amount, 6)
  if (transferValue <= 0n) {
    throw new Error('Please enter a valid USDC amount')
  }

  const { owner, ata, ownerHex, ataHex } = deriveSolanaUsdcAta(recipientWalletAddress)
  const spec = {
    version: 1,
    sourceDomain: sourceChain.domainId,
    destinationDomain: SOLANA_DEVNET_DOMAIN_ID,
    sourceContract: GATEWAY_WALLET_ADDRESS,
    destinationContract: toSolanaBytes32Hex(SOLANA_DEVNET_GATEWAY_MINTER),
    sourceToken: sourceChain.usdcAddress,
    destinationToken: toSolanaBytes32Hex(SOLANA_DEVNET_USDC_MINT),
    sourceDepositor: depositor,
    destinationRecipient: ataHex,
    sourceSigner: depositor,
    destinationCaller: zeroAddress,
    value: transferValue,
    salt: params.salt ?? toRandomHex32(),
    hookData: '0x' as const,
  }

  const specBytes32 = {
    ...spec,
    sourceContract: pad(spec.sourceContract.toLowerCase() as `0x${string}`, { size: 32 }),
    destinationContract: pad(spec.destinationContract, { size: 32 }),
    sourceToken: pad(spec.sourceToken.toLowerCase() as `0x${string}`, { size: 32 }),
    destinationToken: pad(spec.destinationToken, { size: 32 }),
    sourceDepositor: pad(spec.sourceDepositor.toLowerCase() as `0x${string}`, { size: 32 }),
    destinationRecipient: pad(spec.destinationRecipient, { size: 32 }),
    sourceSigner: pad(spec.sourceSigner.toLowerCase() as `0x${string}`, { size: 32 }),
    destinationCaller: pad(spec.destinationCaller.toLowerCase() as `0x${string}`, { size: 32 }),
  }

  return {
    owner,
    ata,
    ownerHex,
    specBytes32,
    transferValue,
  }
}

async function requestSolanaGatewayEstimate(params: {
  amount: string
  depositor: `0x${string}`
  recipientWalletAddress: string
  sourceChainId: GatewaySourceChainId
}) {
  const { ownerHex, ata, specBytes32, transferValue } = buildSolanaGatewaySpec(params)
  const estimateResponse = await fetch(`${GATEWAY_API_BASE}/v1/estimate?enableForwarder=true`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(
      [
        {
          spec: specBytes32,
          recipientSetupOptions: {
            includeRecipientSetup: true,
            recipientOwnerAddress: ownerHex,
          },
        },
      ],
      serializeBigInts,
    ),
  })

  const estimateJson = await parseJsonResponse(estimateResponse)
  const estimatedBurnIntent = (estimateJson as any)?.body?.[0]?.burnIntent

  if (!estimatedBurnIntent?.maxFee || !estimatedBurnIntent?.maxBlockHeight) {
    throw new Error('Gateway estimate response is missing burn intent details')
  }

  const estimatedMaxFeeRaw = BigInt(estimatedBurnIntent.maxFee)
  const { feeBufferRaw, bufferedMaxFeeRaw } = applyForwardFeeSafetyBuffer(estimatedMaxFeeRaw)
  const maxBlockHeight = BigInt(estimatedBurnIntent.maxBlockHeight)
  const totalRequiredRaw = transferValue + bufferedMaxFeeRaw

  return {
    ataAddress: ata.toBase58(),
    estimateJson,
    maxBlockHeight,
    maxFeeRaw: bufferedMaxFeeRaw,
    totalRequiredRaw,
    estimatedFee: formatUsdcAmount(estimatedMaxFeeRaw),
    feeBuffer: formatUsdcAmount(feeBufferRaw),
    totalRequired: formatUsdcAmount(totalRequiredRaw),
    ownerHex,
    specBytes32,
  } satisfies GatewayForwardEstimateResult
}

async function fetchGatewaySnapshot(sourceChainId: GatewaySourceChainId, depositor: `0x${string}`) {
  const sourceChain = GATEWAY_SOURCE_CHAINS[sourceChainId]
  const publicClient = gatewayPublicClients[sourceChainId]

  if (!sourceChain || !publicClient) {
    throw new Error('Selected source chain is not supported for Gateway snapshot reads.')
  }

  const gatewayAvailableBalanceId = getGatewayBalanceId(sourceChain.usdcAddress as `0x${string}`)

  const [walletBalance, allowance, gatewayAvailableBalance, balancesJson, depositsJson] = await Promise.all([
    publicClient.readContract({
      address: sourceChain.usdcAddress as `0x${string}`,
      abi: ERC20_ABI,
      functionName: 'balanceOf',
      args: [depositor],
    }),
    publicClient.readContract({
      address: sourceChain.usdcAddress as `0x${string}`,
      abi: ERC20_ABI,
      functionName: 'allowance',
      args: [depositor, GATEWAY_WALLET_ADDRESS as `0x${string}`],
    }),
    publicClient.readContract({
      address: GATEWAY_WALLET_ADDRESS as `0x${string}`,
      abi: GATEWAY_WALLET_ABI,
      functionName: 'balanceOf',
      args: [depositor, gatewayAvailableBalanceId],
    }),
    postGatewayJson<{ token: string; balances?: Array<{ balance: string; depositor: string; domain: number }> }>('/v1/balances', {
      token: 'USDC',
      sources: [
        {
          depositor,
          domain: sourceChain.domainId,
        },
      ],
    }),
    postGatewayJson<{ token: string; deposits?: unknown[] }>('/v1/deposits', {
      token: 'USDC',
      sources: [
        {
          depositor,
          domain: sourceChain.domainId,
        },
      ],
    }),
  ])

  const matchingBalance = balancesJson?.balances?.find(
    (balance) => balance.depositor?.toLowerCase() === depositor.toLowerCase() && Number(balance.domain) === sourceChain.domainId,
  )

  const apiAvailableBalanceRaw = parseGatewayApiBalance(matchingBalance?.balance, gatewayAvailableBalance as bigint)

  return {
    walletBalance: walletBalance as bigint,
    allowance: allowance as bigint,
    apiAvailableBalanceRaw,
    onchainAvailableBalanceRaw: gatewayAvailableBalance as bigint,
    pendingDeposits: normalizeGatewayDeposits(depositsJson?.deposits),
  }
}

async function waitForTransactionReceiptWithTimeout(
  publicClient: (typeof gatewayPublicClients)[GatewaySourceChainId],
  hash: `0x${string}`,
  timeoutMs = RECEIPT_WAIT_TIMEOUT_MS,
) {
  const pollStart = Date.now()

  while (Date.now() - pollStart < timeoutMs) {
    try {
      const receipt = await publicClient.getTransactionReceipt({ hash })
      return receipt
    } catch {
      await delay(APPROVAL_ALLOWANCE_POLL_INTERVAL_MS)
    }
  }

  return null
}

async function waitForAllowanceAtLeast(params: {
  publicClient: (typeof gatewayPublicClients)[GatewaySourceChainId]
  tokenAddress: `0x${string}`
  owner: `0x${string}`
  spender: `0x${string}`
  minimumAllowance: bigint
}) {
  const { publicClient, tokenAddress, owner, spender, minimumAllowance } = params
  const pollStart = Date.now()

  while (Date.now() - pollStart < APPROVAL_ALLOWANCE_POLL_TIMEOUT_MS) {
    try {
      const allowance = await publicClient.readContract({
        address: tokenAddress,
        abi: ERC20_ABI,
        functionName: 'allowance',
        args: [owner, spender],
      })

      if ((allowance as bigint) >= minimumAllowance) {
        return allowance as bigint
      }
    } catch {
      // Keep polling until timeout.
    }

    await delay(APPROVAL_ALLOWANCE_POLL_INTERVAL_MS)
  }

  return null
}

async function parseJsonResponse(response: Response) {
  const text = await response.text()

  if (!response.ok) {
    let message = text

    try {
      const parsed = JSON.parse(text)
      message = parsed.message ?? parsed.error ?? text
    } catch {
      // Use raw text when the response is not JSON.
    }

    throw new Error(`Gateway API error: ${response.status} ${message}`)
  }

  return text ? JSON.parse(text) : null
}

export function useGatewayForwarding() {
  const { address, chainId, isConnected } = useAccount()
  const { switchChainAsync } = useSwitchChain()
  const { data: walletClient } = useWalletClient()

  const [state, setState] = useState<GatewayForwardingState>({
    step: 'idle',
    error: null,
    isLoading: false,
    result: null,
  })
  const [walletState, setWalletState] = useState<GatewayWalletState>({
    availableBalance: '0.000000',
    onchainAvailableBalance: '0.000000',
    walletBalance: '0.000000',
    allowance: '0.000000',
    pendingDeposits: [],
    isLoadingBalances: false,
    isDepositing: false,
    isPollingDeposit: false,
    depositStatus: null,
    error: null,
  })

  const reset = useCallback(() => {
    setState({
      step: 'idle',
      error: null,
      isLoading: false,
      result: null,
    })
  }, [])

  const fetchGatewayBalances = useCallback(
    async (sourceChainId: GatewaySourceChainId) => {
      if (!address) {
        setWalletState((previousState) => ({
          ...previousState,
          availableBalance: '0.000000',
          onchainAvailableBalance: '0.000000',
          walletBalance: '0.000000',
          allowance: '0.000000',
          pendingDeposits: [],
          isLoadingBalances: false,
          error: null,
          approvalTxHash: undefined,
        }))
        return
      }

      setWalletState((previousState) => ({
        ...previousState,
        isLoadingBalances: true,
        error: null,
      }))

      try {
        const snapshot = await fetchGatewaySnapshot(sourceChainId, address as `0x${string}`)

        setWalletState((previousState) => {
          const trackedDeposit = previousState.depositTxHash
            ? snapshot.pendingDeposits.find(
                (deposit) => deposit.transactionHash.toLowerCase() === previousState.depositTxHash?.toLowerCase(),
              )
            : undefined
          const previousAvailableBalance = parseFormattedUsdcAmount(previousState.availableBalance)
          const previousOnchainAvailableBalance = parseFormattedUsdcAmount(previousState.onchainAvailableBalance)
          const trackedDepositAmount = parseRawBigInt(trackedDeposit?.amount)
          const apiDepositFinalized = Boolean(previousState.depositTxHash) && (
            trackedDeposit
              ? snapshot.apiAvailableBalanceRaw >= previousAvailableBalance + trackedDepositAmount
              : snapshot.apiAvailableBalanceRaw > previousAvailableBalance
          )
          const onchainDepositObserved = Boolean(previousState.depositTxHash) && (
            trackedDeposit
              ? snapshot.onchainAvailableBalanceRaw >= previousOnchainAvailableBalance + trackedDepositAmount
              : snapshot.onchainAvailableBalanceRaw > previousOnchainAvailableBalance
          )

          return {
            ...previousState,
            availableBalance: formatUsdcAmount(snapshot.apiAvailableBalanceRaw),
            onchainAvailableBalance: formatUsdcAmount(snapshot.onchainAvailableBalanceRaw),
            walletBalance: formatUsdcAmount(snapshot.walletBalance),
            allowance: formatUsdcAmount(snapshot.allowance),
            pendingDeposits: snapshot.pendingDeposits,
            isLoadingBalances: false,
            isPollingDeposit: apiDepositFinalized ? false : previousState.isPollingDeposit,
            depositStatus: apiDepositFinalized
              ? 'Deposit ready. You can forward now.'
              : onchainDepositObserved
                ? 'Deposit received. Waiting for Circle to finish processing it...'
              : trackedDeposit && previousState.depositTxHash
                ? `Deposit processing: ${trackedDeposit.status}. Waiting for Circle...`
                : previousState.depositStatus,
            error: null,
          }
        })
      } catch (error) {
        setWalletState((previousState) => ({
          ...previousState,
          isLoadingBalances: false,
          error: getErrorMessage(error),
        }))
      }
    },
    [address],
  )

  const resolveWalletClientForChain = useCallback(
    async (targetChainId: GatewaySourceChainId) => {
      if (walletClient && walletClient.chain?.id === targetChainId) {
        return walletClient
      }

      const pollStart = Date.now()
      while (Date.now() - pollStart < WALLET_CLIENT_REFRESH_TIMEOUT_MS) {
        try {
          const refreshedWalletClient = await getWalletClient(wagmiConfig, { chainId: targetChainId })
          if (refreshedWalletClient && refreshedWalletClient.chain?.id === targetChainId) {
            return refreshedWalletClient
          }
        } catch {
          // Keep polling until the wallet client updates to the target chain.
        }

        await delay(WALLET_CLIENT_REFRESH_INTERVAL_MS)
      }

      throw new Error('Wallet stayed on the previous network. Switch to the selected source chain in your wallet and try again.')
    },
    [walletClient],
  )

  const pollGatewayDeposit = useCallback(
    async (params: {
      sourceChainId: GatewaySourceChainId
      depositTxHash: `0x${string}`
      initialAvailableBalance: bigint
      depositValue: bigint
    }) => {
      if (!address) {
        return false
      }

      const { sourceChainId, depositTxHash, initialAvailableBalance, depositValue } = params
      const expectedAvailableBalance = initialAvailableBalance + depositValue
      const normalizedDepositHash = depositTxHash.toLowerCase()
      const pollStart = Date.now()
      let depositIndexed = false

      while (Date.now() - pollStart < TRANSFER_POLL_TIMEOUT_MS) {
        try {
          const snapshot = await fetchGatewaySnapshot(sourceChainId, address as `0x${string}`)
          const matchingDeposit = snapshot.pendingDeposits.find(
            (deposit) => deposit.transactionHash.toLowerCase() === normalizedDepositHash,
          )
          depositIndexed = depositIndexed || Boolean(matchingDeposit)
          const apiAvailableBalanceReached = snapshot.apiAvailableBalanceRaw >= expectedAvailableBalance
          const onchainAvailableBalanceReached = snapshot.onchainAvailableBalanceRaw >= expectedAvailableBalance

          setWalletState((previousState) => ({
            ...previousState,
            walletBalance: formatUsdcAmount(snapshot.walletBalance),
            allowance: formatUsdcAmount(snapshot.allowance),
            availableBalance: formatUsdcAmount(snapshot.apiAvailableBalanceRaw),
            onchainAvailableBalance: formatUsdcAmount(snapshot.onchainAvailableBalanceRaw),
            pendingDeposits: snapshot.pendingDeposits,
            isPollingDeposit: !apiAvailableBalanceReached,
            depositTxHash,
            depositStatus: apiAvailableBalanceReached
              ? 'Deposit ready. You can forward now.'
              : onchainAvailableBalanceReached
                ? 'Deposit received. Waiting for Circle to finish processing it...'
              : matchingDeposit
                ? `Deposit processing: ${matchingDeposit.status}. Waiting for Circle...`
                : depositIndexed
                  ? 'Waiting for Circle to finish processing your deposit...'
                  : 'Waiting for Circle to find your deposit...',
            error: null,
            isLoadingBalances: false,
          }))

          if (apiAvailableBalanceReached) {
            return true
          }
        } catch (error) {
          setWalletState((previousState) => ({
            ...previousState,
            isPollingDeposit: true,
            depositTxHash,
            depositStatus: 'Gateway polling temporarily failed. Retrying...',
            error: getErrorMessage(error),
          }))
        }

        await delay(TRANSFER_POLL_INTERVAL_MS)
      }

      setWalletState((previousState) => ({
        ...previousState,
        isPollingDeposit: false,
        depositTxHash,
          depositStatus: 'Deposit was sent, but Circle has not finished processing it yet. Check again shortly.',
      }))

      return false
    },
    [address],
  )

  const depositToGateway = useCallback(
    async ({ amount, sourceChainId }: GatewayDepositParams) => {
      if (!isConnected || !address) {
        setWalletState((previousState) => ({
          ...previousState,
          error: 'Please connect your wallet first',
          isDepositing: false,
        }))
        return
      }

      if (!walletClient) {
        setWalletState((previousState) => ({
          ...previousState,
          error: 'Wallet client not ready yet. Please reconnect your wallet and try again.',
          isDepositing: false,
        }))
        return
      }

      const sourceChain = GATEWAY_SOURCE_CHAINS[sourceChainId]
      const publicClient = gatewayPublicClients[sourceChainId]
      if (!sourceChain || !publicClient) {
        setWalletState((previousState) => ({
          ...previousState,
          error: 'Selected source chain is not supported for Gateway deposits.',
          isDepositing: false,
        }))
        return
      }

      try {
        const depositValue = parseUnits(amount, 6)
        if (depositValue <= 0n) {
          throw new Error('Please enter a valid USDC amount to deposit')
        }

        setWalletState((previousState) => ({
          ...previousState,
          isDepositing: true,
          error: null,
          depositStatus: 'Preparing your deposit...',
          approvalTxHash: undefined,
          depositTxHash: undefined,
        }))

        if (chainId !== sourceChainId && switchChainAsync) {
          setWalletState((previousState) => ({
            ...previousState,
            depositStatus: `Switching to ${sourceChain.name}...`,
          }))

          await switchChainAsync({ chainId: sourceChainId })
        }

        const activeWalletClient = await resolveWalletClientForChain(sourceChainId)

        const initialSnapshot = await fetchGatewaySnapshot(sourceChainId, address as `0x${string}`)

        if (initialSnapshot.walletBalance < depositValue) {
          throw new Error('Wallet USDC balance is too low for this Gateway deposit')
        }

        if (initialSnapshot.allowance < depositValue) {
          setWalletState((previousState) => ({
            ...previousState,
            depositStatus: 'Approve USDC in your wallet to continue.',
          }))

          const approvalHash = await writeContractWithReplacementRetry({
            walletClient: activeWalletClient,
            publicClient,
            request: {
              account: address as `0x${string}`,
              chain: sourceChain.chain,
              address: sourceChain.usdcAddress as `0x${string}`,
              abi: ERC20_ABI,
              functionName: 'approve',
              args: [GATEWAY_WALLET_ADDRESS as `0x${string}`, depositValue],
            },
            onRetry: () => {
              setWalletState((previousState) => ({
                ...previousState,
                depositStatus: 'A pending approval was detected. Retrying with a higher gas fee...',
              }))
            },
          })

          setWalletState((previousState) => ({
            ...previousState,
            approvalTxHash: approvalHash,
            depositStatus: 'Approval submitted. Waiting for chain confirmation...',
          }))

          const approvalReceipt = await waitForTransactionReceiptWithTimeout(publicClient, approvalHash)
          if (approvalReceipt?.status === 'reverted') {
            throw new Error('Approval transaction reverted on-chain')
          }

          const confirmedAllowance =
            approvalReceipt?.status === 'success'
              ? await publicClient.readContract({
                  address: sourceChain.usdcAddress as `0x${string}`,
                  abi: ERC20_ABI,
                  functionName: 'allowance',
                  args: [address as `0x${string}`, GATEWAY_WALLET_ADDRESS as `0x${string}`],
                })
              : await waitForAllowanceAtLeast({
                  publicClient,
                  tokenAddress: sourceChain.usdcAddress as `0x${string}`,
                  owner: address as `0x${string}`,
                  spender: GATEWAY_WALLET_ADDRESS as `0x${string}`,
                  minimumAllowance: depositValue,
                })

          if (!confirmedAllowance || (confirmedAllowance as bigint) < depositValue) {
            throw new Error('Approval did not confirm on-chain. Check the approval transaction in your wallet and try the deposit again.')
          }

          setWalletState((previousState) => ({
            ...previousState,
            allowance: formatUsdcAmount(confirmedAllowance as bigint),
            depositStatus: 'Approval confirmed. Confirm the Gateway deposit in your wallet now.',
          }))
        }

        setWalletState((previousState) => ({
          ...previousState,
          depositStatus: 'Waiting for your wallet to confirm the Gateway deposit...',
        }))

        const depositHash = await writeContractWithReplacementRetry({
          walletClient: activeWalletClient,
          publicClient,
          request: {
            account: address as `0x${string}`,
            chain: sourceChain.chain,
            address: GATEWAY_WALLET_ADDRESS as `0x${string}`,
            abi: GATEWAY_WALLET_ABI,
            functionName: 'deposit',
            args: [sourceChain.usdcAddress as `0x${string}`, depositValue],
          },
          onRetry: () => {
            setWalletState((previousState) => ({
              ...previousState,
              depositStatus: 'A pending deposit transaction was detected. Retrying with a higher gas fee...',
            }))
          },
        })

        await publicClient.waitForTransactionReceipt({ hash: depositHash })

        setWalletState((previousState) => ({
          ...previousState,
          isDepositing: false,
          isPollingDeposit: true,
          depositTxHash: depositHash,
          depositStatus: 'Deposit sent. Waiting for Circle to finish processing it...',
          error: null,
        }))

        await pollGatewayDeposit({
          sourceChainId,
          depositTxHash: depositHash,
          initialAvailableBalance: initialSnapshot.apiAvailableBalanceRaw,
          depositValue,
        })
      } catch (error) {
        setWalletState((previousState) => ({
          ...previousState,
          isDepositing: false,
          isPollingDeposit: false,
          error: getErrorMessage(error),
          depositStatus: 'Gateway deposit was not completed.',
        }))
      }
    },
    [address, chainId, isConnected, pollGatewayDeposit, resolveWalletClientForChain, switchChainAsync, walletClient],
  )

  const estimateSolanaForwarding = useCallback(
    async ({ amount, sourceChainId, recipientWalletAddress }: ForwardToSolanaParams) => {
      if (!address) {
        throw new Error('Please connect your wallet first')
      }

      return requestSolanaGatewayEstimate({
        amount,
        depositor: address as `0x${string}`,
        recipientWalletAddress,
        sourceChainId,
      })
    },
    [address],
  )

  const forwardToSolana = useCallback(
    async ({ amount, sourceChainId, recipientWalletAddress }: ForwardToSolanaParams) => {
      if (!isConnected || !address) {
        setState({
          step: 'error',
          error: 'Please connect your wallet first',
          isLoading: false,
          result: null,
        })
        return
      }

      if (!walletClient) {
        setState({
          step: 'error',
          error: 'Wallet client not ready yet. Please reconnect your wallet and try again.',
          isLoading: false,
          result: null,
        })
        return
      }

      const sourceChain = GATEWAY_SOURCE_CHAINS[sourceChainId]
      if (!sourceChain) {
        setState({
          step: 'error',
          error: 'Selected source chain is not supported for Gateway forwarding.',
          isLoading: false,
          result: null,
        })
        return
      }

      try {
        const transferValue = parseUnits(amount, 6)
        if (transferValue <= 0n) {
          throw new Error('Please enter a valid USDC amount')
        }

        setState({
          step: 'validating-recipient',
          error: null,
          isLoading: true,
          result: null,
          destinationBalanceBefore: undefined,
          destinationBalanceAfter: undefined,
          fundsArrivalChecked: false,
          fundsArrived: false,
          sourceChainId,
        })

        const { ata } = deriveSolanaUsdcAta(recipientWalletAddress)
        let destinationBalanceBeforeRaw: bigint | null = null

        try {
          const balanceBefore = await fetchSolanaUsdcBalance(recipientWalletAddress)
          destinationBalanceBeforeRaw = parseFormattedUsdcAmount(balanceBefore)

          setState((previousState) => ({
            ...previousState,
            destinationBalanceBefore: balanceBefore,
          }))
        } catch {
          // Continue forwarding even if recipient balance cannot be fetched up-front.
        }

        if (chainId !== sourceChainId && switchChainAsync) {
          setState((previousState) => ({
            ...previousState,
            step: 'switching-network',
            recipientAta: ata.toBase58(),
          }))

          await switchChainAsync({ chainId: sourceChainId })
        }

        const activeWalletClient = await resolveWalletClientForChain(sourceChainId)

        setState((previousState) => ({
          ...previousState,
          step: 'estimating',
          recipientAta: ata.toBase58(),
        }))

        const estimate = await requestSolanaGatewayEstimate({
          amount,
          depositor: address as `0x${string}`,
          recipientWalletAddress,
          sourceChainId,
        })

        const { estimateJson, maxBlockHeight, maxFeeRaw: maxFee, ownerHex, specBytes32, totalRequiredRaw } = estimate
        const latestSnapshot = await fetchGatewaySnapshot(sourceChainId, address as `0x${string}`)
        const requiredBalance = totalRequiredRaw

        if (latestSnapshot.apiAvailableBalanceRaw < requiredBalance) {
          const availableFormatted = formatUsdcAmount(latestSnapshot.apiAvailableBalanceRaw)
          const requiredFormatted = formatUsdcAmount(requiredBalance)
          const onchainFormatted = formatUsdcAmount(latestSnapshot.onchainAvailableBalanceRaw)

          if (latestSnapshot.onchainAvailableBalanceRaw >= requiredBalance && latestSnapshot.apiAvailableBalanceRaw < requiredBalance) {
            throw new Error(
              `Circle is still processing your deposit. Ready to send: ${availableFormatted} USDC. Needed including fee: ${requiredFormatted} USDC. Deposit already received: ${onchainFormatted} USDC. Try again after the balance finishes updating.`,
            )
          }

          throw new Error(
            `Ready to send balance is too low. ${requiredFormatted} USDC is needed including fee, but only ${availableFormatted} USDC is ready right now.`,
          )
        }

        setState((previousState) => ({
          ...previousState,
          step: 'signing-burn-intent',
          status: `Estimated max fee with buffer ${formatUnits(maxFee, 6)} USDC`,
          result: estimateJson,
        }))

        const signature = await activeWalletClient.signTypedData({
          account: address as `0x${string}`,
          domain: {
            name: 'GatewayWallet',
            version: '1',
          },
          types: {
            TransferSpec: TRANSFER_SPEC_TYPES,
            BurnIntent: BURN_INTENT_TYPES,
          },
          primaryType: 'BurnIntent',
          message: {
            maxBlockHeight,
            maxFee,
            spec: specBytes32,
          },
        } as never)

        setState((previousState) => ({
          ...previousState,
          step: 'submitting-transfer',
        }))

        const transferResponse = await fetch(`${GATEWAY_API_BASE}/v1/transfer?enableForwarder=true`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(
            [
              {
                burnIntent: {
                  maxBlockHeight,
                  maxFee,
                  spec: specBytes32,
                  recipientSetupOptions: {
                    includeRecipientSetup: true,
                    recipientOwnerAddress: ownerHex,
                  },
                },
                signature,
              },
            ],
            serializeBigInts,
          ),
        })

        const transferJson = await parseJsonResponse(transferResponse)
        const transferId = transferJson?.transferId

        if (!transferId) {
          throw new Error('Gateway transfer response is missing transferId')
        }

        setState((previousState) => ({
          ...previousState,
          step: 'waiting-finality',
          transferId,
          status: 'pending',
          result: transferJson,
        }))

        const pollStart = Date.now()
        while (Date.now() - pollStart < TRANSFER_POLL_TIMEOUT_MS) {
          const pollResponse = await fetch(`${GATEWAY_API_BASE}/v1/transfer/${transferId}`)

          if (!pollResponse.ok) {
            await delay(TRANSFER_POLL_INTERVAL_MS)
            continue
          }

          const details = await pollResponse.json()
          const transferStatus = details?.status ?? 'unknown'

          if (transferStatus === 'finalized' || transferStatus === 'confirmed') {
            setState((previousState) => ({
              ...previousState,
              step: 'waiting-finality',
              transferId,
              status: 'Gateway finalized. Verifying recipient Solana balance...',
              result: details,
            }))

            let fundsArrived = false
            let destinationBalanceAfterRaw: bigint | null = null

            if (destinationBalanceBeforeRaw !== null) {
              const arrivalResult = await waitForSolanaUsdcArrival({
                ownerAddress: recipientWalletAddress,
                baselineRaw: destinationBalanceBeforeRaw,
                expectedIncreaseRaw: transferValue,
              })

              fundsArrived = arrivalResult.arrived
              destinationBalanceAfterRaw = arrivalResult.balanceRaw
            } else {
              try {
                const latestBalance = await fetchSolanaUsdcBalance(recipientWalletAddress)
                destinationBalanceAfterRaw = parseFormattedUsdcAmount(latestBalance)
              } catch {
                destinationBalanceAfterRaw = null
              }
            }

            setState({
              step: 'success',
              error: null,
              isLoading: false,
              transferId,
              status: transferStatus,
              recipientAta: ata.toBase58(),
              destinationBalanceBefore:
                destinationBalanceBeforeRaw !== null ? formatUsdcAmount(destinationBalanceBeforeRaw) : undefined,
              destinationBalanceAfter:
                destinationBalanceAfterRaw !== null ? formatUsdcAmount(destinationBalanceAfterRaw) : undefined,
              fundsArrivalChecked: true,
              fundsArrived,
              sourceChainId,
              result: details,
            })
            return
          }

          if (transferStatus === 'failed') {
            throw new Error(details?.forwardingDetails?.failureReason ?? 'Gateway forwarding failed on the destination chain')
          }

          if (transferStatus === 'expired') {
            throw new Error('Gateway transfer expired before forwarding completed')
          }

          setState((previousState) => ({
            ...previousState,
            step: 'waiting-finality',
            transferId,
            status: transferStatus,
            result: details,
          }))

          await delay(TRANSFER_POLL_INTERVAL_MS)
        }

        throw new Error('Gateway transfer polling timed out')
      } catch (error) {
        setState((previousState) => ({
          ...previousState,
          step: 'error',
          error: getErrorMessage(error),
          isLoading: false,
        }))
      }
    },
    [address, chainId, isConnected, resolveWalletClientForChain, switchChainAsync, walletClient],
  )

  return {
    state,
    walletState,
    estimateSolanaForwarding,
    forwardToSolana,
    fetchGatewayBalances,
    depositToGateway,
    reset,
    destinationName: SOLANA_DEVNET_NAME,
    sourceChains: Object.values(GATEWAY_SOURCE_CHAINS),
  }
}