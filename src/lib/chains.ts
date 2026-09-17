import type { Chain } from 'viem'
import {
  arcTestnet,
  arbitrum,
  arbitrumSepolia,
  base,
  baseSepolia,
  mainnet,
  optimism,
  optimismSepolia,
  sepolia,
} from 'viem/chains'
import { APP_NETWORK } from '../config/runtime'
import { MAINNET_ARC_NATIVE_CURRENCY, MAINNET_NETWORKS } from '../config/mainnetNetworks'
import { TESTNET_ARC_NATIVE_CURRENCY, TESTNET_NETWORKS } from '../config/testnet'

type WalletRequest = (args: { method: string; params?: unknown[] }) => Promise<unknown>

const SEPOLIA_DEFAULT_RPC_URLS = TESTNET_NETWORKS.ethereum.rpcUrls
const ARC_DEFAULT_RPC_URLS = TESTNET_NETWORKS.arc.rpcUrls
const BASE_SEPOLIA_DEFAULT_RPC_URLS = TESTNET_NETWORKS.base.rpcUrls
const OPTIMISM_SEPOLIA_DEFAULT_RPC_URLS = TESTNET_NETWORKS.optimism.rpcUrls
const ARBITRUM_SEPOLIA_DEFAULT_RPC_URLS = TESTNET_NETWORKS.arbitrum.rpcUrls

const ETHEREUM_MAINNET_DEFAULT_RPC_URLS = MAINNET_NETWORKS.ethereum.rpcUrls
const ARC_MAINNET_DEFAULT_RPC_URLS = MAINNET_NETWORKS.arc.rpcUrls
const BASE_MAINNET_DEFAULT_RPC_URLS = MAINNET_NETWORKS.base.rpcUrls
const OPTIMISM_MAINNET_DEFAULT_RPC_URLS = MAINNET_NETWORKS.optimism.rpcUrls
const ARBITRUM_MAINNET_DEFAULT_RPC_URLS = MAINNET_NETWORKS.arbitrum.rpcUrls

export const SEPOLIA_EVM_RPC_URL = SEPOLIA_DEFAULT_RPC_URLS[0]
export const ARC_EVM_RPC_URL = ARC_DEFAULT_RPC_URLS[0]
export const BASE_SEPOLIA_EVM_RPC_URL = BASE_SEPOLIA_DEFAULT_RPC_URLS[0]
export const OPTIMISM_SEPOLIA_EVM_RPC_URL = OPTIMISM_SEPOLIA_DEFAULT_RPC_URLS[0]
export const ARBITRUM_SEPOLIA_EVM_RPC_URL = ARBITRUM_SEPOLIA_DEFAULT_RPC_URLS[0]

export const ETHEREUM_MAINNET_EVM_RPC_URL = ETHEREUM_MAINNET_DEFAULT_RPC_URLS[0]
export const ARC_MAINNET_EVM_RPC_URL = ARC_MAINNET_DEFAULT_RPC_URLS[0]
export const BASE_MAINNET_EVM_RPC_URL = BASE_MAINNET_DEFAULT_RPC_URLS[0]
export const OPTIMISM_MAINNET_EVM_RPC_URL = OPTIMISM_MAINNET_DEFAULT_RPC_URLS[0]
export const ARBITRUM_MAINNET_EVM_RPC_URL = ARBITRUM_MAINNET_DEFAULT_RPC_URLS[0]

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

export const ETHEREUM_MAINNET_EVM_CHAIN: Chain = {
  ...mainnet,
  id: MAINNET_NETWORKS.ethereum.chainId,
  name: MAINNET_NETWORKS.ethereum.name,
  rpcUrls: {
    default: { http: [...ETHEREUM_MAINNET_DEFAULT_RPC_URLS] },
    public: { http: [...ETHEREUM_MAINNET_DEFAULT_RPC_URLS] },
  },
}

export const ARC_MAINNET_EVM_CHAIN: Chain = {
  id: MAINNET_NETWORKS.arc.chainId,
  name: MAINNET_NETWORKS.arc.name,
  nativeCurrency: MAINNET_ARC_NATIVE_CURRENCY,
  rpcUrls: {
    default: { http: [...ARC_MAINNET_DEFAULT_RPC_URLS] },
    public: { http: [...ARC_MAINNET_DEFAULT_RPC_URLS] },
  },
  blockExplorers: MAINNET_NETWORKS.arc.explorerUrl
    ? {
        default: { name: 'Arc Explorer', url: MAINNET_NETWORKS.arc.explorerUrl },
      }
    : undefined,
  testnet: false,
}

export const BASE_MAINNET_EVM_CHAIN: Chain = {
  ...base,
  id: MAINNET_NETWORKS.base.chainId,
  name: MAINNET_NETWORKS.base.name,
  rpcUrls: {
    default: { http: [...BASE_MAINNET_DEFAULT_RPC_URLS] },
    public: { http: [...BASE_MAINNET_DEFAULT_RPC_URLS] },
  },
}

export const OPTIMISM_MAINNET_EVM_CHAIN: Chain = {
  ...optimism,
  id: MAINNET_NETWORKS.optimism.chainId,
  name: MAINNET_NETWORKS.optimism.name,
  rpcUrls: {
    default: { http: [...OPTIMISM_MAINNET_DEFAULT_RPC_URLS] },
    public: { http: [...OPTIMISM_MAINNET_DEFAULT_RPC_URLS] },
  },
}

export const ARBITRUM_MAINNET_EVM_CHAIN: Chain = {
  ...arbitrum,
  id: MAINNET_NETWORKS.arbitrum.chainId,
  name: MAINNET_NETWORKS.arbitrum.name,
  rpcUrls: {
    default: { http: [...ARBITRUM_MAINNET_DEFAULT_RPC_URLS] },
    public: { http: [...ARBITRUM_MAINNET_DEFAULT_RPC_URLS] },
  },
}

export const SEPOLIA_EVM_CHAIN_ID = SEPOLIA_EVM_CHAIN.id
export const ARC_EVM_CHAIN_ID = ARC_EVM_CHAIN.id
export const BASE_SEPOLIA_EVM_CHAIN_ID = BASE_SEPOLIA_EVM_CHAIN.id
export const OPTIMISM_SEPOLIA_EVM_CHAIN_ID = OPTIMISM_SEPOLIA_EVM_CHAIN.id
export const ARBITRUM_SEPOLIA_EVM_CHAIN_ID = ARBITRUM_SEPOLIA_EVM_CHAIN.id

export const ETHEREUM_MAINNET_EVM_CHAIN_ID = ETHEREUM_MAINNET_EVM_CHAIN.id
export const ARC_MAINNET_EVM_CHAIN_ID = ARC_MAINNET_EVM_CHAIN.id
export const BASE_MAINNET_EVM_CHAIN_ID = BASE_MAINNET_EVM_CHAIN.id
export const OPTIMISM_MAINNET_EVM_CHAIN_ID = OPTIMISM_MAINNET_EVM_CHAIN.id
export const ARBITRUM_MAINNET_EVM_CHAIN_ID = ARBITRUM_MAINNET_EVM_CHAIN.id

export const TESTNET_SUPPORTED_EVM_CHAINS = [
  SEPOLIA_EVM_CHAIN,
  ARC_EVM_CHAIN,
  BASE_SEPOLIA_EVM_CHAIN,
  OPTIMISM_SEPOLIA_EVM_CHAIN,
  ARBITRUM_SEPOLIA_EVM_CHAIN,
] as const

export const MAINNET_SUPPORTED_EVM_CHAINS = [
  ETHEREUM_MAINNET_EVM_CHAIN,
  ARC_MAINNET_EVM_CHAIN,
  BASE_MAINNET_EVM_CHAIN,
  OPTIMISM_MAINNET_EVM_CHAIN,
  ARBITRUM_MAINNET_EVM_CHAIN,
] as const

export const SUPPORTED_EVM_CHAINS = APP_NETWORK === 'mainnet'
  ? MAINNET_SUPPORTED_EVM_CHAINS
  : TESTNET_SUPPORTED_EVM_CHAINS

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
