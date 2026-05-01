import type { Chain } from 'viem'
import { arcTestnet, arbitrumSepolia, baseSepolia, optimismSepolia, sepolia } from 'viem/chains'

type WalletRequest = (args: { method: string; params?: unknown[] }) => Promise<unknown>

const sepoliaEnvRpc = import.meta.env.VITE_SEPOLIA_RPC?.trim()
const arcEnvRpc = import.meta.env.VITE_ARC_TESTNET_RPC?.trim()
const baseSepoliaEnvRpc = import.meta.env.VITE_BASE_SEPOLIA_RPC?.trim()
const optimismSepoliaEnvRpc = import.meta.env.VITE_OPTIMISM_SEPOLIA_RPC?.trim()
const arbitrumSepoliaEnvRpc = import.meta.env.VITE_ARBITRUM_SEPOLIA_RPC?.trim()

const SEPOLIA_DEFAULT_RPC_URLS = [
  'https://ethereum-sepolia-rpc.publicnode.com',
  'https://rpc.sepolia.org',
]

const ARC_DEFAULT_RPC_URLS = [
  'https://rpc.testnet.arc.network',
]

const BASE_SEPOLIA_DEFAULT_RPC_URLS = [
  'https://base-sepolia-rpc.publicnode.com',
  'https://sepolia.base.org',
]

const OPTIMISM_SEPOLIA_DEFAULT_RPC_URLS = [
  'https://sepolia.optimism.io',
  'https://optimism-sepolia-rpc.publicnode.com',
]

const ARBITRUM_SEPOLIA_DEFAULT_RPC_URLS = [
  'https://sepolia-rollup.arbitrum.io/rpc',
  'https://arbitrum-sepolia-rpc.publicnode.com',
]

export const SEPOLIA_EVM_RPC_URL = sepoliaEnvRpc || SEPOLIA_DEFAULT_RPC_URLS[0]
export const ARC_EVM_RPC_URL = arcEnvRpc || ARC_DEFAULT_RPC_URLS[0]
export const BASE_SEPOLIA_EVM_RPC_URL = baseSepoliaEnvRpc || BASE_SEPOLIA_DEFAULT_RPC_URLS[0]
export const OPTIMISM_SEPOLIA_EVM_RPC_URL = optimismSepoliaEnvRpc || OPTIMISM_SEPOLIA_DEFAULT_RPC_URLS[0]
export const ARBITRUM_SEPOLIA_EVM_RPC_URL = arbitrumSepoliaEnvRpc || ARBITRUM_SEPOLIA_DEFAULT_RPC_URLS[0]

export const SEPOLIA_EVM_CHAIN: Chain = {
  ...sepolia,
  rpcUrls: {
    default: { http: sepoliaEnvRpc ? [sepoliaEnvRpc] : SEPOLIA_DEFAULT_RPC_URLS },
    public: { http: sepoliaEnvRpc ? [sepoliaEnvRpc] : SEPOLIA_DEFAULT_RPC_URLS },
  },
}

export const ARC_EVM_CHAIN: Chain = {
  ...arcTestnet,
  rpcUrls: {
    default: { http: arcEnvRpc ? [arcEnvRpc] : ARC_DEFAULT_RPC_URLS },
    public: { http: arcEnvRpc ? [arcEnvRpc] : ARC_DEFAULT_RPC_URLS },
  },
}

export const BASE_SEPOLIA_EVM_CHAIN: Chain = {
  ...baseSepolia,
  rpcUrls: {
    default: { http: baseSepoliaEnvRpc ? [baseSepoliaEnvRpc] : BASE_SEPOLIA_DEFAULT_RPC_URLS },
    public: { http: baseSepoliaEnvRpc ? [baseSepoliaEnvRpc] : BASE_SEPOLIA_DEFAULT_RPC_URLS },
  },
}

export const OPTIMISM_SEPOLIA_EVM_CHAIN: Chain = {
  ...optimismSepolia,
  rpcUrls: {
    default: { http: optimismSepoliaEnvRpc ? [optimismSepoliaEnvRpc] : OPTIMISM_SEPOLIA_DEFAULT_RPC_URLS },
    public: { http: optimismSepoliaEnvRpc ? [optimismSepoliaEnvRpc] : OPTIMISM_SEPOLIA_DEFAULT_RPC_URLS },
  },
}

export const ARBITRUM_SEPOLIA_EVM_CHAIN: Chain = {
  ...arbitrumSepolia,
  rpcUrls: {
    default: { http: arbitrumSepoliaEnvRpc ? [arbitrumSepoliaEnvRpc] : ARBITRUM_SEPOLIA_DEFAULT_RPC_URLS },
    public: { http: arbitrumSepoliaEnvRpc ? [arbitrumSepoliaEnvRpc] : ARBITRUM_SEPOLIA_DEFAULT_RPC_URLS },
  },
}

export const SEPOLIA_EVM_CHAIN_ID = SEPOLIA_EVM_CHAIN.id
export const ARC_EVM_CHAIN_ID = ARC_EVM_CHAIN.id
export const BASE_SEPOLIA_EVM_CHAIN_ID = BASE_SEPOLIA_EVM_CHAIN.id
export const OPTIMISM_SEPOLIA_EVM_CHAIN_ID = OPTIMISM_SEPOLIA_EVM_CHAIN.id
export const ARBITRUM_SEPOLIA_EVM_CHAIN_ID = ARBITRUM_SEPOLIA_EVM_CHAIN.id

export const SUPPORTED_EVM_CHAINS = [
  SEPOLIA_EVM_CHAIN,
  ARC_EVM_CHAIN,
  BASE_SEPOLIA_EVM_CHAIN,
  OPTIMISM_SEPOLIA_EVM_CHAIN,
  ARBITRUM_SEPOLIA_EVM_CHAIN,
] as const
export const SUPPORTED_EVM_CHAIN_OPTIONS = SUPPORTED_EVM_CHAINS.map((chain) => ({
  id: chain.id,
  name: chain.name,
}))

const supportedEvmChainsById = new Map<number, Chain>(
  SUPPORTED_EVM_CHAINS.map((chain) => [chain.id, chain])
)

export function getSupportedEvmChain(chainId?: number) {
  if (!chainId) return undefined
  return supportedEvmChainsById.get(chainId)
}

export function getSupportedEvmChainName(chainId?: number) {
  return getSupportedEvmChain(chainId)?.name ?? 'Unknown Network'
}

export async function addChainToWallet(chain: Chain, request?: WalletRequest | null) {
  if (!request) return false

  await request({
    method: 'wallet_addEthereumChain',
    params: [
      {
        chainId: `0x${chain.id.toString(16)}`,
        chainName: chain.name,
        nativeCurrency: chain.nativeCurrency,
        rpcUrls: chain.rpcUrls.default.http,
        blockExplorerUrls: chain.blockExplorers?.default?.url ? [chain.blockExplorers.default.url] : [],
      },
    ],
  })

  return true
}