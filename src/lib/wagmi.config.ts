import { fallback, http } from 'viem'
import { createConfig } from 'wagmi'
import { connectorsForWallets } from '@rainbow-me/rainbowkit'
import { coinbaseWallet, injectedWallet, metaMaskWallet, rabbyWallet, walletConnectWallet } from '@rainbow-me/rainbowkit/wallets'
import {
  MAINNET_SUPPORTED_EVM_CHAINS,
  TESTNET_SUPPORTED_EVM_CHAINS,
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
import { readStoredAppNetwork } from '../config/runtime'

const walletConnectProjectId = import.meta.env.VITE_WALLETCONNECT_PROJECT_ID?.trim() || '00000000000000000000000000000000'
const hasWalletConnect = walletConnectProjectId !== '00000000000000000000000000000000'

// "Browser Wallet" connects the same window.ethereum as the MetaMask option. When that provider is
// MetaMask, the idle Browser Wallet connector takes over the connection on MetaMask's late
// accountsChanged event (wagmi treats it as a connect from the wallet), so the bar shows
// "Browser Wallet". MetaMask keeps its own option; Browser Wallet stays for other injected wallets.
// Many wallets (Rabby, Brave, OKX, Phantom...) also set isMetaMask but add their own isXxx flag, so
// only a provider whose sole wallet flag is isMetaMask counts as MetaMask here.
function isGenuineMetaMask(provider: unknown) {
  if (!provider || typeof provider !== 'object') return false
  const flags = provider as Record<string, unknown>
  return flags.isMetaMask === true && !Object.keys(flags).some(key => key !== 'isMetaMask' && /^is[A-Z]/.test(key) && flags[key] === true)
}
const browserWallet = () => ({
  ...injectedWallet(),
  hidden: () => typeof window !== 'undefined' && isGenuineMetaMask(window.ethereum),
})

const connectors = connectorsForWallets(
  [
    {
      groupName: 'Recommended',
      wallets: [
        metaMaskWallet,
        rabbyWallet,
        coinbaseWallet,
        ...(hasWalletConnect ? [walletConnectWallet] : []),
        browserWallet,
      ],
    },
  ],
  {
    appName: 'Machina Bridge',
    projectId: walletConnectProjectId,
  },
)

// The first chain is RainbowKit's fallback when the wallet's chain is not known at connect
// time (MetaMask on phones before approval, WalletConnect): it follows the stored network
// profile, so a Mainnet connect asks for Ethereum Mainnet instead of Sepolia.
const chains = readStoredAppNetwork() === 'testnet'
  ? [...TESTNET_SUPPORTED_EVM_CHAINS, ...MAINNET_SUPPORTED_EVM_CHAINS] as const
  : [...MAINNET_SUPPORTED_EVM_CHAINS, ...TESTNET_SUPPORTED_EVM_CHAINS] as const

export const wagmiConfig = createConfig({
  // The wallet provider knows both network profiles. The UI decides which
  // profile is exposed; mainnet transaction execution remains separately locked.
  chains,
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
