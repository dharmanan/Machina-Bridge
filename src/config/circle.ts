import { APP_NETWORK } from './runtime'
import { MAINNET_CONFIG, getArcMainnetNetworkReadiness } from './mainnet'
import { MAINNET_NETWORKS } from './mainnetNetworks'
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
      cctpDomain: 6,
      usdcAddress: TESTNET_NETWORKS.base.usdcAddress,
    },
    optimism: {
      chainId: TESTNET_NETWORKS.optimism.chainId,
      cctpDomain: 2,
      usdcAddress: TESTNET_NETWORKS.optimism.usdcAddress,
    },
    arbitrum: {
      chainId: TESTNET_NETWORKS.arbitrum.chainId,
      cctpDomain: 3,
      usdcAddress: TESTNET_NETWORKS.arbitrum.usdcAddress,
    },
  },
} as const

export const CIRCLE_MAINNET = {
  irisApiBase: 'https://iris-api.circle.com',
  gatewayApiBase: MAINNET_CONFIG.circleGatewayApiBase,
  gatewayWalletAddress: MAINNET_CONFIG.arcGatewayWalletAddress,
  gatewayMinterAddress: MAINNET_CONFIG.arcGatewayMinterAddress,
  chains: {
    ethereum: {
      chainId: MAINNET_NETWORKS.ethereum.chainId,
      cctpDomain: MAINNET_NETWORKS.ethereum.cctpDomain,
      usdcAddress: MAINNET_NETWORKS.ethereum.usdcAddress,
    },
    arc: {
      chainId: MAINNET_CONFIG.arcChainId,
      cctpDomain: MAINNET_CONFIG.arcCctpDomain,
      usdcAddress: MAINNET_CONFIG.arcUsdcAddress,
      tokenMessengerAddress: MAINNET_CONFIG.arcCctpTokenMessengerAddress,
      messageTransmitterAddress: MAINNET_CONFIG.arcCctpMessageTransmitterAddress,
    },
    base: {
      chainId: MAINNET_NETWORKS.base.chainId,
      cctpDomain: MAINNET_NETWORKS.base.cctpDomain,
      usdcAddress: MAINNET_NETWORKS.base.usdcAddress,
    },
    optimism: {
      chainId: MAINNET_NETWORKS.optimism.chainId,
      cctpDomain: MAINNET_NETWORKS.optimism.cctpDomain,
      usdcAddress: MAINNET_NETWORKS.optimism.usdcAddress,
    },
    arbitrum: {
      chainId: MAINNET_NETWORKS.arbitrum.chainId,
      cctpDomain: MAINNET_NETWORKS.arbitrum.cctpDomain,
      usdcAddress: MAINNET_NETWORKS.arbitrum.usdcAddress,
    },
  },
} as const

export type CircleMainnetReadiness = {
  cctpReady: boolean
  gatewayReady: boolean
  cctpMissing: string[]
  gatewayMissing: string[]
  missing: string[]
}

export function getCircleRuntimeConfig() {
  return APP_NETWORK === 'mainnet' ? CIRCLE_MAINNET : CIRCLE_TESTNET
}

export function getCircleMainnetReadiness(): CircleMainnetReadiness {
  const networkReadiness = getArcMainnetNetworkReadiness()
  const cctpMissing = [...networkReadiness.missing]
  const gatewayMissing = [...networkReadiness.missing]

  if (!CIRCLE_MAINNET.chains.arc.cctpDomain) {
    cctpMissing.push('Circle CCTP mainnet domain for Arc')
  }

  if (!CIRCLE_MAINNET.chains.arc.tokenMessengerAddress) {
    cctpMissing.push('Circle CCTP TokenMessenger mainnet contract for Arc')
  }

  if (!CIRCLE_MAINNET.chains.arc.messageTransmitterAddress) {
    cctpMissing.push('Circle CCTP MessageTransmitter mainnet contract for Arc')
  }

  if (!CIRCLE_MAINNET.gatewayApiBase) {
    gatewayMissing.push('Circle Gateway mainnet API support for Arc')
  }

  if (!CIRCLE_MAINNET.gatewayWalletAddress) {
    gatewayMissing.push('Circle Gateway mainnet wallet contract for Arc')
  }

  if (!CIRCLE_MAINNET.gatewayMinterAddress) {
    gatewayMissing.push('Circle Gateway mainnet minter contract for Arc')
  }

  const missing = Array.from(new Set([...cctpMissing, ...gatewayMissing]))

  return {
    cctpReady: cctpMissing.length === 0,
    gatewayReady: gatewayMissing.length === 0,
    cctpMissing,
    gatewayMissing,
    missing,
  }
}
