import { createPublicClient, fallback, http, parseAbi } from 'viem'
import { CIRCLE_MAINNET } from './circle'
import { MAINNET_CONFIG } from './mainnet'
import { MAINNET_NETWORKS } from './mainnetNetworks'

export const MAINNET_CCTP_TOKEN_MESSENGER = MAINNET_CONFIG.arcCctpTokenMessengerAddress
export const MAINNET_CCTP_MESSAGE_TRANSMITTER = MAINNET_CONFIG.arcCctpMessageTransmitterAddress

export const CCTP_V2_CONFIRMED_FINALITY = 1000
export const CCTP_V2_FINALIZED_FINALITY = 2000

export const CCTP_V2_ERC20_ABI = parseAbi([
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function balanceOf(address account) view returns (uint256)',
])

export const CCTP_V2_TOKEN_MESSENGER_ABI = parseAbi([
  'function depositForBurn(uint256 amount, uint32 destinationDomain, bytes32 mintRecipient, address burnToken, bytes32 destinationCaller, uint256 maxFee, uint32 minFinalityThreshold)',
])

export const CCTP_V2_MESSAGE_TRANSMITTER_ABI = parseAbi([
  'function receiveMessage(bytes message, bytes attestation) returns (bool)',
])

type MainnetCctpChain = {
  key: keyof typeof MAINNET_NETWORKS
  name: string
  chainId: number
  cctpDomain: number
  usdcAddress: `0x${string}`
  rpcUrls: readonly string[]
  tokenMessengerAddress: `0x${string}`
  messageTransmitterAddress: `0x${string}`
}

const MAINNET_CCTP_CHAINS = Object.fromEntries(
  Object.entries(MAINNET_NETWORKS).map(([key, network]) => [
    network.chainId,
    {
      key: key as keyof typeof MAINNET_NETWORKS,
      name: network.name,
      chainId: network.chainId,
      cctpDomain: network.cctpDomain,
      usdcAddress: network.usdcAddress,
      rpcUrls: network.rpcUrls,
      tokenMessengerAddress: MAINNET_CCTP_TOKEN_MESSENGER,
      messageTransmitterAddress: MAINNET_CCTP_MESSAGE_TRANSMITTER,
    } satisfies MainnetCctpChain,
  ]),
) as Record<number, MainnetCctpChain>

export type MainnetCctpFee = {
  finalityThreshold: number
  minimumFee: number
}

export type MainnetCctpProbeCheck = {
  key: string
  label: string
  ok: boolean
  detail?: string
}

export type MainnetCctpRouteProbe = {
  ready: boolean
  sourceChainId: number
  destinationChainId: number
  checkedAt: string
  checks: MainnetCctpProbeCheck[]
}

export function getMainnetCctpChain(chainId: number) {
  return MAINNET_CCTP_CHAINS[chainId]
}

export function getMainnetCctpRoute(sourceChainId: number, destinationChainId: number) {
  const source = getMainnetCctpChain(sourceChainId)
  const destination = getMainnetCctpChain(destinationChainId)

  if (!source || !destination || sourceChainId === destinationChainId) {
    return null
  }

  return { source, destination }
}

export async function fetchMainnetCctpFees(
  sourceChainId: number,
  destinationChainId: number,
): Promise<MainnetCctpFee[]> {
  const route = getMainnetCctpRoute(sourceChainId, destinationChainId)
  if (!route) {
    throw new Error('Unsupported CCTP mainnet route')
  }

  const response = await fetch(
    `${CIRCLE_MAINNET.irisApiBase}/v2/burn/USDC/fees/${route.source.cctpDomain}/${route.destination.cctpDomain}`,
    {
      headers: {
        Accept: 'application/json',
      },
    },
  )

  if (!response.ok) {
    throw new Error(`Circle CCTP fee API HTTP ${response.status}`)
  }

  const payload = await response.json()
  if (!Array.isArray(payload)) {
    throw new Error('Circle CCTP fee API returned an invalid payload')
  }

  const fees = payload
    .map((item) => ({
      finalityThreshold: Number(item?.finalityThreshold),
      minimumFee: Number(item?.minimumFee),
    }))
    .filter((item) => Number.isFinite(item.finalityThreshold) && Number.isFinite(item.minimumFee))

  if (fees.length === 0) {
    throw new Error('Circle CCTP fee API returned no usable fee entries')
  }

  return fees
}

function makePublicClient(chain: MainnetCctpChain) {
  const transports = chain.rpcUrls.map((url) => http(url, { timeout: 8_000, retryCount: 0 }))
  return createPublicClient({
    transport: transports.length === 1 ? transports[0] : fallback(transports),
  })
}

function hasRuntimeCode(code?: `0x${string}`) {
  return Boolean(code && code !== '0x' && code !== '0x0')
}

export async function probeMainnetCctpRoute(
  sourceChainId: number,
  destinationChainId: number,
): Promise<MainnetCctpRouteProbe> {
  const checkedAt = new Date().toISOString()
  const route = getMainnetCctpRoute(sourceChainId, destinationChainId)

  if (!route) {
    return {
      ready: false,
      sourceChainId,
      destinationChainId,
      checkedAt,
      checks: [
        {
          key: 'route',
          label: 'CCTP mainnet route',
          ok: false,
          detail: 'unsupported route or identical source/destination chain',
        },
      ],
    }
  }

  const sourceClient = makePublicClient(route.source)
  const destinationClient = makePublicClient(route.destination)
  const checks: MainnetCctpProbeCheck[] = []

  try {
    const observedSourceChainId = await sourceClient.getChainId()
    checks.push({
      key: 'source-chain-id',
      label: `${route.source.name} chain ID`,
      ok: observedSourceChainId === route.source.chainId,
      detail: `expected ${route.source.chainId}, observed ${observedSourceChainId}`,
    })
  } catch (error) {
    checks.push({
      key: 'source-chain-id',
      label: `${route.source.name} chain ID`,
      ok: false,
      detail: error instanceof Error ? error.message : 'RPC check failed',
    })
  }

  try {
    const observedDestinationChainId = await destinationClient.getChainId()
    checks.push({
      key: 'destination-chain-id',
      label: `${route.destination.name} chain ID`,
      ok: observedDestinationChainId === route.destination.chainId,
      detail: `expected ${route.destination.chainId}, observed ${observedDestinationChainId}`,
    })
  } catch (error) {
    checks.push({
      key: 'destination-chain-id',
      label: `${route.destination.name} chain ID`,
      ok: false,
      detail: error instanceof Error ? error.message : 'RPC check failed',
    })
  }

  const contractChecks = await Promise.all([
    sourceClient.getBytecode({ address: route.source.usdcAddress }),
    sourceClient.getBytecode({ address: route.source.tokenMessengerAddress }),
    destinationClient.getBytecode({ address: route.destination.usdcAddress }),
    destinationClient.getBytecode({ address: route.destination.messageTransmitterAddress }),
  ]).catch(() => null)

  if (!contractChecks) {
    checks.push({
      key: 'contracts',
      label: 'CCTP route contracts',
      ok: false,
      detail: 'one or more RPC bytecode checks failed',
    })
  } else {
    const [sourceUsdcCode, tokenMessengerCode, destinationUsdcCode, messageTransmitterCode] = contractChecks
    checks.push(
      {
        key: 'source-usdc',
        label: `${route.source.name} USDC`,
        ok: hasRuntimeCode(sourceUsdcCode),
        detail: hasRuntimeCode(sourceUsdcCode) ? 'bytecode present' : 'no runtime bytecode',
      },
      {
        key: 'token-messenger',
        label: `${route.source.name} TokenMessengerV2`,
        ok: hasRuntimeCode(tokenMessengerCode),
        detail: hasRuntimeCode(tokenMessengerCode) ? 'bytecode present' : 'no runtime bytecode',
      },
      {
        key: 'destination-usdc',
        label: `${route.destination.name} USDC`,
        ok: hasRuntimeCode(destinationUsdcCode),
        detail: hasRuntimeCode(destinationUsdcCode) ? 'bytecode present' : 'no runtime bytecode',
      },
      {
        key: 'message-transmitter',
        label: `${route.destination.name} MessageTransmitterV2`,
        ok: hasRuntimeCode(messageTransmitterCode),
        detail: hasRuntimeCode(messageTransmitterCode) ? 'bytecode present' : 'no runtime bytecode',
      },
    )
  }

  try {
    const fees = await fetchMainnetCctpFees(sourceChainId, destinationChainId)
    checks.push({
      key: 'iris-fees',
      label: 'Circle production CCTP fee API',
      ok: fees.length > 0,
      detail: `${fees.length} fee option(s) returned`,
    })
  } catch (error) {
    checks.push({
      key: 'iris-fees',
      label: 'Circle production CCTP fee API',
      ok: false,
      detail: error instanceof Error ? error.message : 'fee API check failed',
    })
  }

  return {
    ready: checks.length > 0 && checks.every((check) => check.ok),
    sourceChainId,
    destinationChainId,
    checkedAt,
    checks,
  }
}
