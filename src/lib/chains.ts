import type { Chain } from 'viem'
import { arcTestnet, arbitrumSepolia, baseSepolia, optimismSepolia, sepolia } from 'viem/chains'
import { TESTNET_ARC_NATIVE_CURRENCY, TESTNET_NETWORKS } from '../config/testnet'

type WalletRequest = (args: { method: string; params?: unknown[] }) => Promise<unknown>

const SEPOLIA_DEFAULT_RPC_URLS = TESTNET_NETWORKS.ethereum.rpcUrls
const ARC_DEFAULT_RPC_URLS = TESTNET_NETWORKS.arc.rpcUrls
const BASE_SEPOLIA_DEFAULT_RPC_URLS = TESTNET_NETWORKS.base.rpcUrls
const OPTIMISM_SEPOLIA_DEFAULT_RPC_URLS = TESTNET_NETWORKS.optimism.rpcUrls
const ARBITRUM_SEPOLIA_DEFAULT_RPC_URLS = TESTNET_NETWORKS.arbitrum.rpcUrls

export const SEPOLIA_EVM_RPC_URL = SEPOLIA_DEFAULT_RPC_URLS[0]
export const ARC_EVM_RPC_URL = ARC_DEFAULT_RPC_URLS[0]
export const BASE_SEPOLIA_EVM_RPC_URL = BASE_SEPOLIA_DEFAULT_RPC_URLS[0]
export const OPTIMISM_SEPOLIA_EVM_RPC_URL = OPTIMISM_SEPOLIA_DEFAULT_RPC_URLS[0]
export const ARBITRUM_SEPOLIA_EVM_RPC_URL = ARBITRUM_SEPOLIA_DEFAULT_RPC_URLS[0]

export const SEPOLIA_EVM_CHAIN: Chain = {
  ...sepolia,
  id: TESTNET_NETWORKS.ethereum.chainId,
  name: TESTNET_NETWORKS.ethereum.name,
  rpcUrls: {
    default: { http: [...SEPOLIA_DEFAULT_RPC_URLS] },
    public: { http: [...SEPOLIA_DEFAULT_RPC_URLS] },
  },
}

// Do not rely on a possibly stale viem Arc native-currency label here.
// Arc Testnet uses USDC as the native gas asset.
export const ARC_EVM_CHAIN: Chain = {
  ...arcTestnet,
  id: TESTNET_NETWORKS.arc.chainId,
  name: TESTNET_NETWORKS.arc.name,
  nativeCurrency: TESTNET_ARC_NATIVE_CURRENCY,
  rpcUrls: {
    default: { http: [...ARC_DEFAULT_RPC_URLS] },
    public: { http: [...ARC_DEFAULT_RPC_URLS] },
  },
  blockExplorers: {
    default: { name: 'ArcScan', url: TESTNET_NETWORKS.arc.explorerUrl },
  },
  testnet: true,
}

export const BASE_SEPOLIA_EVM_CHAIN: Chain = {
  ...baseSepolia,
  id: TESTNET_NETWORKS.base.chainId,
  name: TESTNET_NETWORKS.base.name,
  rpcUrls: {
    default: { http: [...BASE_SEPOLIA_DEFAULT_RPC_URLS] },
    public: { http: [...BASE_SEPOLIA_DEFAULT_RPC_URLS] },
  },
}

export const OPTIMISM_SEPOLIA_EVM_CHAIN: Chain = {
  ...optimismSepolia,
  id: TESTNET_NETWORKS.optimism.chainId,
  name: TESTNET_NETWORKS.optimism.name,
  rpcUrls: {
    default: { http: [...OPTIMISM_SEPOLIA_DEFAULT_RPC_URLS] },
    public: { http: [...OPTIMISM_SEPOLIA_DEFAULT_RPC_URLS] },
  },
}

export const ARBITRUM_SEPOLIA_EVM_CHAIN: Chain = {
  ...arbitrumSepolia,
  id: TESTNET_NETWORKS.arbitrum.chainId,
  name: TESTNET_NETWORKS.arbitrum.name,
  rpcUrls: {
    default: { http: [...ARBITRUM_SEPOLIA_DEFAULT_RPC_URLS] },
    public: { http: [...ARBITRUM_SEPOLIA_DEFAULT_RPC_URLS] },
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
