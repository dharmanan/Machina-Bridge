import { fallback, http } from 'viem'
import { createConfig } from 'wagmi'
import { coinbaseWallet, injected, walletConnect } from 'wagmi/connectors'
import {
  ARBITRUM_SEPOLIA_EVM_CHAIN,
  ARC_EVM_CHAIN,
  BASE_SEPOLIA_EVM_CHAIN,
  OPTIMISM_SEPOLIA_EVM_CHAIN,
  SEPOLIA_EVM_CHAIN,
  SUPPORTED_EVM_CHAINS,
} from './chains'

const walletConnectProjectId = import.meta.env.VITE_WALLETCONNECT_PROJECT_ID?.trim()

const connectors = [
  injected({ shimDisconnect: true }),
  coinbaseWallet({ appName: 'Arc Bridge' }),
  ...(walletConnectProjectId
    ? [
        walletConnect({
          projectId: walletConnectProjectId,
          showQrModal: true,
        }),
      ]
    : []),
]

export const wagmiConfig = createConfig({
  chains: SUPPORTED_EVM_CHAINS,
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