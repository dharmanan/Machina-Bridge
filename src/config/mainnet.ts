type MainnetConfig = {
  arcRpcUrl: string
  arcExplorerUrl: string
  arcChainId?: number
  arcUsdcAddress: string
  arcCctpDomain?: number
}

function readPositiveInteger(value: string | undefined) {
  const normalized = value?.trim()
  if (!normalized) return undefined

  const parsed = Number(normalized)
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined
}

export const MAINNET_CONFIG: MainnetConfig = {
  arcRpcUrl: import.meta.env.VITE_ARC_MAINNET_RPC?.trim() || '',
  arcExplorerUrl: import.meta.env.VITE_ARC_MAINNET_EXPLORER?.trim() || '',
  arcChainId: readPositiveInteger(import.meta.env.VITE_ARC_MAINNET_CHAIN_ID),
  arcUsdcAddress: import.meta.env.VITE_ARC_MAINNET_USDC?.trim() || '',
  arcCctpDomain: readPositiveInteger(import.meta.env.VITE_ARC_MAINNET_CCTP_DOMAIN),
}

export type MainnetReadiness = {
  ready: boolean
  missing: string[]
}

export function getMainnetReadiness(): MainnetReadiness {
  const missing: string[] = []

  if (!MAINNET_CONFIG.arcRpcUrl) missing.push('Arc mainnet RPC')
  if (!MAINNET_CONFIG.arcExplorerUrl) missing.push('Arc mainnet explorer')
  if (!MAINNET_CONFIG.arcChainId) missing.push('Arc mainnet chain ID')
  if (!MAINNET_CONFIG.arcUsdcAddress) missing.push('Arc mainnet USDC address')
  if (!MAINNET_CONFIG.arcCctpDomain) missing.push('Arc mainnet CCTP domain')

  return {
    ready: missing.length === 0,
    missing,
  }
}
