type MainnetConfig = {
  arcRpcUrl: string
  arcExplorerUrl: string
  arcChainId: number
  arcUsdcAddress: `0x${string}`
  arcCctpDomain: number
  arcCctpTokenMessengerAddress: `0x${string}`
  arcCctpMessageTransmitterAddress: `0x${string}`
  arcGatewayWalletAddress: `0x${string}`
  arcGatewayMinterAddress: `0x${string}`
  circleGatewayApiBase: string
}

export const ARC_MAINNET_OFFICIAL = {
  rpcUrl: 'https://rpc.mainnet.arc.io',
  explorerUrl: 'https://explorer.arc.io',
  chainId: 5042,
  usdcAddress: '0x3600000000000000000000000000000000000000',
  cctpDomain: 26,
  cctpTokenMessengerAddress: '0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d',
  cctpMessageTransmitterAddress: '0x81D40F21F12A8F0E3252Bccb954D722d4c464B64',
  gatewayWalletAddress: '0x77777777Dcc4d5A8B6E418Fd04D8997ef11000eE',
  gatewayMinterAddress: '0x2222222d7164433c4C09B0b0D809a9b52C04C205',
} as const

export const CIRCLE_GATEWAY_MAINNET_API_BASE = 'https://gateway-api.circle.com' as const

export const MAINNET_CONFIG: MainnetConfig = {
  // RPC/explorer endpoints may be overridden operationally, but chain identity
  // and Circle contract addresses are pinned to the verified official values.
  arcRpcUrl: import.meta.env.VITE_ARC_MAINNET_RPC?.trim() || ARC_MAINNET_OFFICIAL.rpcUrl,
  arcExplorerUrl: import.meta.env.VITE_ARC_MAINNET_EXPLORER?.trim() || ARC_MAINNET_OFFICIAL.explorerUrl,
  arcChainId: ARC_MAINNET_OFFICIAL.chainId,
  arcUsdcAddress: ARC_MAINNET_OFFICIAL.usdcAddress,
  arcCctpDomain: ARC_MAINNET_OFFICIAL.cctpDomain,
  arcCctpTokenMessengerAddress: ARC_MAINNET_OFFICIAL.cctpTokenMessengerAddress,
  arcCctpMessageTransmitterAddress: ARC_MAINNET_OFFICIAL.cctpMessageTransmitterAddress,
  arcGatewayWalletAddress: ARC_MAINNET_OFFICIAL.gatewayWalletAddress,
  arcGatewayMinterAddress: ARC_MAINNET_OFFICIAL.gatewayMinterAddress,
  circleGatewayApiBase:
    import.meta.env.VITE_CIRCLE_MAINNET_GATEWAY_API_BASE?.trim() || CIRCLE_GATEWAY_MAINNET_API_BASE,
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
