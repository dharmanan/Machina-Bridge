import { fallback, http } from 'viem'
import { createConfig } from 'wagmi'
import { connectorsForWallets } from '@rainbow-me/rainbowkit'
import { coinbaseWallet, injectedWallet, metaMaskWallet, rabbyWallet, walletConnectWallet } from '@rainbow-me/rainbowkit/wallets'
import { APP_NETWORK } from '../config/runtime'
import {
  ARBITRUM_MAINNET_EVM_CHAIN,
  ARBITRUM_SEPOLIA_EVM_CHAIN,
  ARC_EVM_CHAIN,
  ARC_MAINNET_EVM_CHAIN,
  BASE_MAINNET_EVM_CHAIN,
  BASE_SEPOLIA_EVM_CHAIN,
  ETHEREUM_MAINNET_EVM_CHAIN,
  MAINNET_SUPPORTED_EVM_CHAINS,
  OPTIMISM_MAINNET_EVM_CHAIN,
  OPTIMISM_SEPOLIA_EVM_CHAIN,
  SEPOLIA_EVM_CHAIN,
  TESTNET_SUPPORTED_EVM_CHAINS,
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

const testnetWagmiConfig = createConfig({
  chains: TESTNET_SUPPORTED_EVM_CHAINS,
  connectors,
  transports: {
    [SEPOLIA_EVM_CHAIN.id]: fallback(SEPOLIA_EVM_CHAIN.rpcUrls.default.http.map((url) => http(url))),
    [ARC_EVM_CHAIN.id]: fallback(ARC_EVM_CHAIN.rpcUrls.default.http.map((url) => http(url))),
    [BASE_SEPOLIA_EVM_CHAIN.id]: fallback(BASE_SEPOLIA_EVM_CHAIN.rpcUrls.default.http.map((url) => http(url))),
    [OPTIMISM_SEPOLIA_EVM_CHAIN.id]: fallback(OPTIMISM_SEPOLIA_EVM_CHAIN.rpcUrls.default.http.map((url) => http(url))),
    [ARBITRUM_SEPOLIA_EVM_CHAIN.id]: fallback(ARBITRUM_SEPOLIA_EVM_CHAIN.rpcUrls.default.http.map((url) => http(url))),
  },
  ssr: false,
})

const mainnetWagmiConfig = createConfig({
  chains: MAINNET_SUPPORTED_EVM_CHAINS,
  connectors,
  transports: {
    [ETHEREUM_MAINNET_EVM_CHAIN.id]: fallback(ETHEREUM_MAINNET_EVM_CHAIN.rpcUrls.default.http.map((url) => http(url))),
    [ARC_MAINNET_EVM_CHAIN.id]: fallback(ARC_MAINNET_EVM_CHAIN.rpcUrls.default.http.map((url) => http(url))),
    [BASE_MAINNET_EVM_CHAIN.id]: fallback(BASE_MAINNET_EVM_CHAIN.rpcUrls.default.http.map((url) => http(url))),
    [OPTIMISM_MAINNET_EVM_CHAIN.id]: fallback(OPTIMISM_MAINNET_EVM_CHAIN.rpcUrls.default.http.map((url) => http(url))),
    [ARBITRUM_MAINNET_EVM_CHAIN.id]: fallback(ARBITRUM_MAINNET_EVM_CHAIN.rpcUrls.default.http.map((url) => http(url))),
  },
  ssr: false,
})

export const wagmiConfig = APP_NETWORK === 'mainnet'
  ? mainnetWagmiConfig
  : testnetWagmiConfig
