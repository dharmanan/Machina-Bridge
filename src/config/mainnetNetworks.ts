import { arbitrum, base, mainnet, optimism } from 'viem/chains'
import { MAINNET_CONFIG } from './mainnet'

type EvmMainnetConfig = {
  key: string
  name: string
  chainId: number
  rpcUrls: readonly string[]
  usdcAddress: `0x${string}`
  cctpDomain: number
  explorerUrl?: string
}

function withRpcOverride(override: string | undefined, defaults: readonly string[]) {
  const normalized = override?.trim()
  return normalized ? [normalized] as const : defaults
}

export const MAINNET_NETWORKS = {
  ethereum: {
    key: 'ethereum-mainnet',
    name: 'Ethereum',
    chainId: mainnet.id,
    rpcUrls: withRpcOverride(import.meta.env.VITE_ETHEREUM_MAINNET_RPC, mainnet.rpcUrls.default.http),
    usdcAddress: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
    cctpDomain: 0,
    explorerUrl: mainnet.blockExplorers.default.url,
  },
  arc: {
    key: 'arc-mainnet',
    name: 'Arc',
    chainId: MAINNET_CONFIG.arcChainId,
    rpcUrls: [MAINNET_CONFIG.arcRpcUrl],
    usdcAddress: MAINNET_CONFIG.arcUsdcAddress,
    cctpDomain: MAINNET_CONFIG.arcCctpDomain,
    explorerUrl: MAINNET_CONFIG.arcExplorerUrl,
  },
  base: {
    key: 'base-mainnet',
    name: 'Base',
    chainId: base.id,
    rpcUrls: withRpcOverride(import.meta.env.VITE_BASE_MAINNET_RPC, base.rpcUrls.default.http),
    usdcAddress: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    cctpDomain: 6,
    explorerUrl: base.blockExplorers.default.url,
  },
  optimism: {
    key: 'optimism-mainnet',
    name: 'OP Mainnet',
    chainId: optimism.id,
    rpcUrls: withRpcOverride(import.meta.env.VITE_OPTIMISM_MAINNET_RPC, optimism.rpcUrls.default.http),
    usdcAddress: '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85',
    cctpDomain: 2,
    explorerUrl: optimism.blockExplorers.default.url,
  },
  arbitrum: {
    key: 'arbitrum-mainnet',
    name: 'Arbitrum One',
    chainId: arbitrum.id,
    rpcUrls: withRpcOverride(import.meta.env.VITE_ARBITRUM_MAINNET_RPC, arbitrum.rpcUrls.default.http),
    usdcAddress: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831',
    cctpDomain: 3,
    explorerUrl: arbitrum.blockExplorers.default.url,
  },
} satisfies Record<string, EvmMainnetConfig>

export const MAINNET_ARC_NATIVE_CURRENCY = {
  name: 'USDC',
  symbol: 'USDC',
  decimals: 18,
} as const

export type MainnetNetworkKey = keyof typeof MAINNET_NETWORKS
