import {
  createPublicClient,
  fallback,
  formatUnits,
  getAddress,
  http,
  isAddress,
} from 'viem'
import {
  CCTP_V2_ERC20_ABI,
  MAINNET_CCTP_TOKEN_MESSENGER,
  getMainnetCctpRoute,
} from '../config/mainnetCctp'
import {
  prepareMainnetCctpApproval,
  prepareMainnetCctpBurn,
  quoteMainnetCctpTransfer,
  type MainnetCctpPreparedCall,
  type MainnetCctpQuote,
  type MainnetCctpTransferMode,
} from './mainnetCctpTransfer'

export type MainnetCctpSimulationCheck = {
  key: string
  label: string
  status: 'pass' | 'blocked' | 'skipped'
  detail?: string
}

export type MainnetCctpSimulatedCall = {
  call: MainnetCctpPreparedCall
  simulated: boolean
  estimatedGas?: bigint
  gasPrice?: bigint
  estimatedGasCostRaw?: bigint
  error?: string
}

export type MainnetCctpSourceSimulation = {
  checkedAt: string
  sourceChainId: number
  destinationChainId: number
  account: `0x${string}`
  recipient: `0x${string}`
  quote: MainnetCctpQuote
  balanceRaw: bigint
  allowanceRaw: bigint
  nativeBalanceRaw: bigint
  approvalRequired: boolean
  readyForApproval: boolean
  readyForBurn: boolean
  approval?: MainnetCctpSimulatedCall
  burn?: MainnetCctpSimulatedCall
  checks: MainnetCctpSimulationCheck[]
}

function makePublicClient(rpcUrls: readonly string[]) {
  const transports = rpcUrls.map((url) => http(url, { timeout: 10_000, retryCount: 0 }))
  return createPublicClient({
    transport: transports.length === 1 ? transports[0] : fallback(transports),
  })
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

async function simulatePreparedCall(input: {
  client: ReturnType<typeof makePublicClient>
  account: `0x${string}`
  call: MainnetCctpPreparedCall
  nativeBalanceRaw: bigint
  gasPrice: bigint
}): Promise<MainnetCctpSimulatedCall> {
  try {
    // eth_call and eth_estimateGas only; this function never signs or broadcasts.
    await input.client.call({
      account: input.account,
      to: input.call.to,
      data: input.call.data,
      value: input.call.value,
    })

    const estimatedGas = await input.client.estimateGas({
      account: input.account,
      to: input.call.to,
      data: input.call.data,
      value: input.call.value,
    })

    const estimatedGasCostRaw = estimatedGas * input.gasPrice

    if (input.nativeBalanceRaw < estimatedGasCostRaw) {
      return {
        call: input.call,
        simulated: false,
        estimatedGas,
        gasPrice: input.gasPrice,
        estimatedGasCostRaw,
        error: 'Insufficient native gas balance for the estimated transaction cost',
      }
    }

    return {
      call: input.call,
      simulated: true,
      estimatedGas,
      gasPrice: input.gasPrice,
      estimatedGasCostRaw,
    }
  } catch (error) {
    return {
      call: input.call,
      simulated: false,
      error: errorMessage(error),
    }
  }
}

export async function simulateMainnetCctpSource(input: {
  sourceChainId: number
  destinationChainId: number
  account: string
  recipient?: string
  amount: string
  mode?: MainnetCctpTransferMode
}): Promise<MainnetCctpSourceSimulation> {
  const checkedAt = new Date().toISOString()
  const route = getMainnetCctpRoute(input.sourceChainId, input.destinationChainId)

  if (!route) {
    throw new Error('Unsupported CCTP mainnet route')
  }

  if (!isAddress(input.account)) {
    throw new Error('Invalid source wallet address')
  }

  const recipientInput = input.recipient ?? input.account
  if (!isAddress(recipientInput)) {
    throw new Error('Invalid destination recipient address')
  }

  const account = getAddress(input.account)
  const recipient = getAddress(recipientInput)
  const quote = await quoteMainnetCctpTransfer({
    sourceChainId: input.sourceChainId,
    destinationChainId: input.destinationChainId,
    amount: input.amount,
    mode: input.mode,
  })

  const client = makePublicClient(route.source.rpcUrls)
  const checks: MainnetCctpSimulationCheck[] = []

  const [balanceRaw, allowanceRaw, nativeBalanceRaw, gasPrice] = await Promise.all([
    client.readContract({
      address: route.source.usdcAddress,
      abi: CCTP_V2_ERC20_ABI,
      functionName: 'balanceOf',
      args: [account],
    }),
    client.readContract({
      address: route.source.usdcAddress,
      abi: CCTP_V2_ERC20_ABI,
      functionName: 'allowance',
      args: [account, MAINNET_CCTP_TOKEN_MESSENGER],
    }),
    client.getBalance({ address: account }),
    client.getGasPrice(),
  ])

  const hasTokenBalance = balanceRaw >= quote.amountRaw
  checks.push({
    key: 'usdc-balance',
    label: `${route.source.name} USDC balance`,
    status: hasTokenBalance ? 'pass' : 'blocked',
    detail: `${formatUnits(balanceRaw, 6)} USDC available; ${quote.amount} USDC requested`,
  })

  const approvalRequired = allowanceRaw < quote.amountRaw
  let approval: MainnetCctpSimulatedCall | undefined
  let readyForApproval = false

  if (approvalRequired) {
    const approvalCall = prepareMainnetCctpApproval({
      sourceChainId: input.sourceChainId,
      amountRaw: quote.amountRaw,
    })

    approval = await simulatePreparedCall({
      client,
      account,
      call: approvalCall,
      nativeBalanceRaw,
      gasPrice,
    })

    readyForApproval = approval.simulated
    checks.push({
      key: 'allowance',
      label: 'TokenMessengerV2 allowance',
      status: 'blocked',
      detail: `${formatUnits(allowanceRaw, 6)} USDC approved; approval required before burn`,
    })
    checks.push({
      key: 'approval-simulation',
      label: 'USDC approval simulation',
      status: approval.simulated ? 'pass' : 'blocked',
      detail: approval.simulated
        ? `eth_call + gas estimate passed (${approval.estimatedGas?.toString() ?? 'unknown'} gas)`
        : approval.error,
    })
  } else {
    readyForApproval = true
    checks.push({
      key: 'allowance',
      label: 'TokenMessengerV2 allowance',
      status: 'pass',
      detail: `${formatUnits(allowanceRaw, 6)} USDC already approved`,
    })
    checks.push({
      key: 'approval-simulation',
      label: 'USDC approval simulation',
      status: 'skipped',
      detail: 'existing allowance is already sufficient',
    })
  }

  let burn: MainnetCctpSimulatedCall | undefined
  let readyForBurn = false

  if (!hasTokenBalance) {
    checks.push({
      key: 'burn-simulation',
      label: 'CCTP V2 depositForBurn simulation',
      status: 'skipped',
      detail: 'insufficient USDC balance',
    })
  } else if (approvalRequired) {
    checks.push({
      key: 'burn-simulation',
      label: 'CCTP V2 depositForBurn simulation',
      status: 'skipped',
      detail: 'approval must exist onchain before an accurate burn simulation can pass',
    })
  } else {
    const burnCall = prepareMainnetCctpBurn({ quote, recipient })
    burn = await simulatePreparedCall({
      client,
      account,
      call: burnCall,
      nativeBalanceRaw,
      gasPrice,
    })
    readyForBurn = burn.simulated

    checks.push({
      key: 'burn-simulation',
      label: 'CCTP V2 depositForBurn simulation',
      status: burn.simulated ? 'pass' : 'blocked',
      detail: burn.simulated
        ? `eth_call + gas estimate passed (${burn.estimatedGas?.toString() ?? 'unknown'} gas)`
        : burn.error,
    })
  }

  return {
    checkedAt,
    sourceChainId: input.sourceChainId,
    destinationChainId: input.destinationChainId,
    account,
    recipient,
    quote,
    balanceRaw,
    allowanceRaw,
    nativeBalanceRaw,
    approvalRequired,
    readyForApproval,
    readyForBurn,
    approval,
    burn,
    checks,
  }
}
