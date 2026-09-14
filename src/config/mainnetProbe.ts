import { CIRCLE_MAINNET, getCircleMainnetReadiness } from './circle'
import { MAINNET_CONFIG, getArcMainnetNetworkReadiness } from './mainnet'

type ProbeCheck = {
  key: string
  label: string
  ok: boolean
  detail?: string
}

export type MainnetCapabilityProbeResult = {
  ready: boolean
  checkedAt: string
  checks: ProbeCheck[]
  missing: string[]
}

async function rpcCall<T>(method: string, params: unknown[] = []): Promise<T> {
  const response = await fetch(MAINNET_CONFIG.arcRpcUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  })

  if (!response.ok) {
    throw new Error(`Arc mainnet RPC HTTP ${response.status}`)
  }

  const payload = await response.json() as { result?: T; error?: { message?: string } }
  if (payload.error) {
    throw new Error(payload.error.message || `Arc mainnet RPC ${method} failed`)
  }

  return payload.result as T
}

function hasRuntimeCode(value: string | undefined) {
  return typeof value === 'string' && value !== '0x' && value !== '0x0'
}

async function checkContractCode(
  key: string,
  label: string,
  address: `0x${string}` | '',
): Promise<ProbeCheck> {
  if (!address) {
    return { key, label, ok: false, detail: 'not configured' }
  }

  try {
    const code = await rpcCall<string>('eth_getCode', [address, 'latest'])
    return {
      key,
      label,
      ok: hasRuntimeCode(code),
      detail: hasRuntimeCode(code) ? 'bytecode present' : 'no runtime bytecode',
    }
  } catch (error) {
    return {
      key,
      label,
      ok: false,
      detail: error instanceof Error ? error.message : 'RPC check failed',
    }
  }
}

export async function probeArcMainnetCapabilities(): Promise<MainnetCapabilityProbeResult> {
  const networkReadiness = getArcMainnetNetworkReadiness()
  const circleReadiness = getCircleMainnetReadiness()
  const checkedAt = new Date().toISOString()

  const missing = Array.from(new Set([
    ...networkReadiness.missing,
    ...circleReadiness.missing,
  ]))

  if (!networkReadiness.ready || !MAINNET_CONFIG.arcRpcUrl || !MAINNET_CONFIG.arcChainId) {
    return {
      ready: false,
      checkedAt,
      checks: [],
      missing,
    }
  }

  const checks: ProbeCheck[] = []

  try {
    const chainIdHex = await rpcCall<string>('eth_chainId')
    const observedChainId = Number.parseInt(chainIdHex, 16)
    checks.push({
      key: 'chain-id',
      label: 'Arc mainnet chain ID',
      ok: observedChainId === MAINNET_CONFIG.arcChainId,
      detail: `expected ${MAINNET_CONFIG.arcChainId}, observed ${observedChainId}`,
    })
  } catch (error) {
    checks.push({
      key: 'chain-id',
      label: 'Arc mainnet chain ID',
      ok: false,
      detail: error instanceof Error ? error.message : 'RPC check failed',
    })
  }

  const contractChecks = await Promise.all([
    checkContractCode('usdc', 'Arc mainnet USDC', MAINNET_CONFIG.arcUsdcAddress),
    checkContractCode(
      'cctp-token-messenger',
      'Circle CCTP TokenMessenger',
      MAINNET_CONFIG.arcCctpTokenMessengerAddress,
    ),
    checkContractCode(
      'cctp-message-transmitter',
      'Circle CCTP MessageTransmitter',
      MAINNET_CONFIG.arcCctpMessageTransmitterAddress,
    ),
    checkContractCode(
      'gateway-wallet',
      'Circle Gateway wallet',
      CIRCLE_MAINNET.gatewayWalletAddress,
    ),
  ])

  checks.push(...contractChecks)

  if (!CIRCLE_MAINNET.gatewayApiBase) {
    checks.push({
      key: 'gateway-api',
      label: 'Circle Gateway mainnet API',
      ok: false,
      detail: 'not configured from official Circle support documentation',
    })
  }

  return {
    ready: missing.length === 0 && checks.length > 0 && checks.every((check) => check.ok),
    checkedAt,
    checks,
    missing,
  }
}
