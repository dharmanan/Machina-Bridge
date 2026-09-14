import { APP_NETWORK } from './runtime'
import { MAINNET_CONFIG, getMainnetReadiness } from './mainnet'
import { TESTNET_NETWORKS } from './testnet'

export const CIRCLE_TESTNET = {
  irisApiBase: 'https://iris-api-sandbox.circle.com',
  gatewayApiBase: 'https://gateway-api-testnet.circle.com',
  gatewayWalletAddress: '0x0077777d7EBA4688BDeF3E311b846F25870A19B9' as const,
  arc: {
    cctpDomain: TESTNET_NETWORKS.arc.cctpDomain,
    usdcAddress: TESTNET_NETWORKS.arc.usdcAddress,
  },
  ethereum: {
    cctpDomain: TESTNET_NETWORKS.ethereum.cctpDomain,
    usdcAddress: TESTNET_NETWORKS.ethereum.usdcAddress,
  },
} as const

export const CIRCLE_MAINNET = {
  irisApiBase: 'https://iris-api.circle.com',
  // Do not populate these until Circle documents Arc mainnet support.
  gatewayApiBase: '',
  gatewayWalletAddress: '' as `0x${string}` | '',
  arc: {
    cctpDomain: MAINNET_CONFIG.arcCctpDomain,
    usdcAddress: MAINNET_CONFIG.arcUsdcAddress,
  },
} as const

export function getCircleRuntimeConfig() {
  return APP_NETWORK === 'mainnet' ? CIRCLE_MAINNET : CIRCLE_TESTNET
}

export function getCircleMainnetReadiness() {
  const missing = [...getMainnetReadiness().missing]

  if (!CIRCLE_MAINNET.gatewayApiBase) {
    missing.push('Circle Gateway mainnet API support for Arc')
  }

  if (!CIRCLE_MAINNET.gatewayWalletAddress) {
    missing.push('Circle Gateway mainnet wallet contract for Arc')
  }

  return {
    cctpReady: getMainnetReadiness().ready,
    gatewayReady: missing.length === 0,
    missing,
  }
}
