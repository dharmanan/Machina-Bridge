type MainnetConfig = {
  arcRpcUrl: string
  arcExplorerUrl: string
  arcChainId?: number
  arcUsdcAddress: `0x${string}` | ''
  arcCctpDomain?: number
  arcCctpTokenMessengerAddress: `0x${string}` | ''
  arcCctpMessageTransmitterAddress: `0x${string}` | ''
  arcGatewayWalletAddress: `0x${string}` | ''
  circleGatewayApiBase: string
}

function readPositiveInteger(value: string | undefined) {
  const normalized = value?.trim()
  if (!normalized) return undefined

  const parsed = Number(normalized)
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined
}

function readEvmAddress(value: string | undefined): `0x${string}` | '' {
  const normalized = value?.trim() || ''
  return /^0x[a-fA-F0-9]{40}$/.test(normalized)
    ? normalized as `0x${string}`
    : ''
}

export const MAINNET_CONFIG: MainnetConfig = {
  arcRpcUrl: import.meta.env.VITE_ARC_MAINNET_RPC?.trim() || '',
  arcExplorerUrl: import.meta.env.VITE_ARC_MAINNET_EXPLORER?.trim() || '',
  arcChainId: readPositiveInteger(import.meta.env.VITE_ARC_MAINNET_CHAIN_ID),
  arcUsdcAddress: readEvmAddress(import.meta.env.VITE_ARC_MAINNET_USDC),
  arcCctpDomain: readPositiveInteger(import.meta.env.VITE_ARC_MAINNET_CCTP_DOMAIN),
  arcCctpTokenMessengerAddress: readEvmAddress(import.meta.env.VITE_ARC_MAINNET_CCTP_TOKEN_MESSENGER),
  arcCctpMessageTransmitterAddress: readEvmAddress(import.meta.env.VITE_ARC_MAINNET_CCTP_MESSAGE_TRANSMITTER),
  arcGatewayWalletAddress: readEvmAddress(import.meta.env.VITE_ARC_MAINNET_GATEWAY_WALLET),
  circleGatewayApiBase: import.meta.env.VITE_CIRCLE_MAINNET_GATEWAY_API_BASE?.trim() || '',
}

export type MainnetReadiness = {
  ready: boolean
  missing: string[]
}

export function getArcMainnetNetworkReadiness(): MainnetReadiness {
  const missing: string[] = []

  if (!MAINNET_CONFIG.arcRpcUrl) missing.push('Arc mainnet RPC')
  if (!MAINNET_CONFIG.arcExplorerUrl) missing.push('Arc mainnet explorer')
  if (!MAINNET_CONFIG.arcChainId) missing.push('Arc mainnet chain ID')
  if (!MAINNET_CONFIG.arcUsdcAddress) missing.push('Arc mainnet USDC address')

  return {
    ready: missing.length === 0,
    missing,
  }
}

// Backward-compatible alias used by the existing runtime gate.
export function getMainnetReadiness(): MainnetReadiness {
  return getArcMainnetNetworkReadiness()
}
