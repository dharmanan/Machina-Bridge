import { fallback, http } from 'viem'
import { createConfig } from 'wagmi'
import { connectorsForWallets } from '@rainbow-me/rainbowkit'
import { coinbaseWallet, injectedWallet, metaMaskWallet, rabbyWallet, walletConnectWallet } from '@rainbow-me/rainbowkit/wallets'
import {
  ALL_SUPPORTED_EVM_CHAINS,
  ARBITRUM_MAINNET_EVM_CHAIN,
  ARBITRUM_SEPOLIA_EVM_CHAIN,
  ARC_EVM_CHAIN,
  ARC_MAINNET_EVM_CHAIN,
  BASE_MAINNET_EVM_CHAIN,
  BASE_SEPOLIA_EVM_CHAIN,
  ETHEREUM_MAINNET_EVM_CHAIN,
  OPTIMISM_MAINNET_EVM_CHAIN,
  OPTIMISM_SEPOLIA_EVM_CHAIN,
  SEPOLIA_EVM_CHAIN,
} from './chains'

const walletConnectProjectId = import.meta.env.VITE_WALLETCONNECT_PROJECT_ID?.trim() || '00000000000000000000000000000000'
const hasWalletConnect = walletConnectProjectId !== '00000000000000000000000000000000'

const connectors = connectorsForWallets(
  [
    {
      groupName: 'Recommended',
      wallets: [
        metaMaskWallet,
        rabbyWallet,
        coinbaseWallet,
        ...(hasWalletConnect ? [walletConnectWallet] : []),
        injectedWallet,
      ],
    },
  ],
  {
    appName: 'Machina Bridge',
    projectId: walletConnectProjectId,
  },
)

export const wagmiConfig = createConfig({
  // The wallet provider knows both network profiles. The UI decides which
  // profile is exposed; mainnet transaction execution remains separately locked.
  chains: ALL_SUPPORTED_EVM_CHAINS,
  connectors,
  transports: {
    [SEPOLIA_EVM_CHAIN.id]: fallback(SEPOLIA_EVM_CHAIN.rpcUrls.default.http.map((url) => http(url))),
    [ARC_EVM_CHAIN.id]: fallback(ARC_EVM_CHAIN.rpcUrls.default.http.map((url) => http(url))),
    [BASE_SEPOLIA_EVM_CHAIN.id]: fallback(BASE_SEPOLIA_EVM_CHAIN.rpcUrls.default.http.map((url) => http(url))),
    [OPTIMISM_SEPOLIA_EVM_CHAIN.id]: fallback(OPTIMISM_SEPOLIA_EVM_CHAIN.rpcUrls.default.http.map((url) => http(url))),
    [ARBITRUM_SEPOLIA_EVM_CHAIN.id]: fallback(ARBITRUM_SEPOLIA_EVM_CHAIN.rpcUrls.default.http.map((url) => http(url))),
    [ETHEREUM_MAINNET_EVM_CHAIN.id]: fallback(ETHEREUM_MAINNET_EVM_CHAIN.rpcUrls.default.http.map((url) => http(url))),
    [ARC_MAINNET_EVM_CHAIN.id]: fallback(ARC_MAINNET_EVM_CHAIN.rpcUrls.default.http.map((url) => http(url))),
    [BASE_MAINNET_EVM_CHAIN.id]: fallback(BASE_MAINNET_EVM_CHAIN.rpcUrls.default.http.map((url) => http(url))),
    [OPTIMISM_MAINNET_EVM_CHAIN.id]: fallback(OPTIMISM_MAINNET_EVM_CHAIN.rpcUrls.default.http.map((url) => http(url))),
    [ARBITRUM_MAINNET_EVM_CHAIN.id]: fallback(ARBITRUM_MAINNET_EVM_CHAIN.rpcUrls.default.http.map((url) => http(url))),
  },
  ssr: false,
})
