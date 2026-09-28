type EvmTestnetConfig = {
  key: string
  name: string
  chainId: number
  rpcUrls: readonly string[]
  usdcAddress: `0x${string}`
  cctpDomain?: number
  explorerUrl?: string
}

function withRpcOverride(override: string | undefined, defaults: readonly string[]) {
  const normalized = override?.trim()
  return normalized ? [normalized] as const : defaults
}

const SEPOLIA_RPC_DEFAULTS = [
  'https://ethereum-sepolia-rpc.publicnode.com',
  'https://rpc.sepolia.org',
] as const

const ARC_TESTNET_RPC_DEFAULTS = [
  'https://rpc.testnet.arc.io',
] as const

const BASE_SEPOLIA_RPC_DEFAULTS = [
  'https://base-sepolia-rpc.publicnode.com',
  'https://sepolia.base.org',
] as const

const OPTIMISM_SEPOLIA_RPC_DEFAULTS = [
  'https://sepolia.optimism.io',
  'https://optimism-sepolia-rpc.publicnode.com',
] as const

const ARBITRUM_SEPOLIA_RPC_DEFAULTS = [
  'https://sepolia-rollup.arbitrum.io/rpc',
  'https://arbitrum-sepolia-rpc.publicnode.com',
] as const

export const TESTNET_NETWORKS = {
  ethereum: {
    key: 'ethereum-sepolia',
    name: 'Sepolia',
    chainId: 11155111,
    rpcUrls: withRpcOverride(import.meta.env.VITE_SEPOLIA_RPC, SEPOLIA_RPC_DEFAULTS),
    usdcAddress: '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238',
    cctpDomain: 0,
  },
  arc: {
    key: 'arc-testnet',
    name: 'Arc Testnet',
    chainId: 5042002,
    rpcUrls: withRpcOverride(import.meta.env.VITE_ARC_TESTNET_RPC, ARC_TESTNET_RPC_DEFAULTS),
    usdcAddress: '0x3600000000000000000000000000000000000000',
    cctpDomain: 26,
    explorerUrl: 'https://testnet.arcscan.app',
  },
  base: {
    key: 'base-sepolia',
    name: 'Base Sepolia',
    chainId: 84532,
    rpcUrls: withRpcOverride(import.meta.env.VITE_BASE_SEPOLIA_RPC, BASE_SEPOLIA_RPC_DEFAULTS),
    usdcAddress: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
  },
  optimism: {
    key: 'optimism-sepolia',
    name: 'Optimism Sepolia',
    chainId: 11155420,
    rpcUrls: withRpcOverride(import.meta.env.VITE_OPTIMISM_SEPOLIA_RPC, OPTIMISM_SEPOLIA_RPC_DEFAULTS),
    usdcAddress: '0x5fd84259d66Cd46123540766Be93DFE6D43130D7',
  },
  arbitrum: {
    key: 'arbitrum-sepolia',
    name: 'Arbitrum Sepolia',
    chainId: 421614,
    rpcUrls: withRpcOverride(import.meta.env.VITE_ARBITRUM_SEPOLIA_RPC, ARBITRUM_SEPOLIA_RPC_DEFAULTS),
    usdcAddress: '0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d',
  },
} satisfies Record<string, EvmTestnetConfig>

export const TESTNET_ARC_NATIVE_CURRENCY = {
  name: 'USDC',
  symbol: 'USDC',
  decimals: 18,
} as const

export type TestnetNetworkKey = keyof typeof TESTNET_NETWORKS
