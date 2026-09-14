import { APP_NETWORK } from './runtime'
import { MAINNET_CONFIG, getMainnetReadiness } from './mainnet'
import { TESTNET_NETWORKS } from './testnet'

export const CIRCLE_TESTNET = {
  irisApiBase: 'https://iris-api-sandbox.circle.com',
  gatewayApiBase: 'https://gateway-api-testnet.circle.com',
  gatewayWalletAddress: '0x0077777d7EBA4688BDeF3E311b846F25870A19B9' as const,
  chains: {
    ethereum: {
      chainId: TESTNET_NETWORKS.ethereum.chainId,
      cctpDomain: TESTNET_NETWORKS.ethereum.cctpDomain,
      usdcAddress: TESTNET_NETWORKS.ethereum.usdcAddress,
    },
    arc: {
      chainId: TESTNET_NETWORKS.arc.chainId,
      cctpDomain: TESTNET_NETWORKS.arc.cctpDomain,
      usdcAddress: TESTNET_NETWORKS.arc.usdcAddress,
    },
    base: {
      chainId: TESTNET_NETWORKS.base.chainId,
      usdcAddress: TESTNET_NETWORKS.base.usdcAddress,
    },
    optimism: {
      chainId: TESTNET_NETWORKS.optimism.chainId,
      usdcAddress: TESTNET_NETWORKS.optimism.usdcAddress,
    },
    arbitrum: {
      chainId: TESTNET_NETWORKS.arbitrum.chainId,
      usdcAddress: TESTNET_NETWORKS.arbitrum.usdcAddress,
    },
  },
} as const

export const CIRCLE_MAINNET = {
  irisApiBase: 'https://iris-api.circle.com',
  // Do not populate these until Circle documents Arc mainnet Gateway support.
  gatewayApiBase: '',
  gatewayWalletAddress: '' as `0x${string}` | '',
  chains: {
    arc: {
      chainId: MAINNET_CONFIG.arcChainId,
      cctpDomain: MAINNET_CONFIG.arcCctpDomain,
      usdcAddress: MAINNET_CONFIG.arcUsdcAddress,
    },
  },
} as const

export function getCircleRuntimeConfig() {
  return APP_NETWORK === 'mainnet' ? CIRCLE_MAINNET : CIRCLE_TESTNET
}

export function getCircleMainnetReadiness() {
  const mainnetReadiness = getMainnetReadiness()
  const gatewayMissing: string[] = []

  if (!CIRCLE_MAINNET.gatewayApiBase) {
    gatewayMissing.push('Circle Gateway mainnet API support for Arc')
  }

  if (!CIRCLE_MAINNET.gatewayWalletAddress) {
    gatewayMissing.push('Circle Gateway mainnet wallet contract for Arc')
  }

  return {
    cctpReady: mainnetReadiness.ready,
    gatewayReady: mainnetReadiness.ready && gatewayMissing.length === 0,
    missing: [...mainnetReadiness.missing, ...gatewayMissing],
  }
}
