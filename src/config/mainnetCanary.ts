import { MAINNET_NETWORKS, type MainnetNetworkKey } from './mainnetNetworks'
import {
  MAINNET_CCTP_CANARY_ENABLED,
  MAINNET_CCTP_CANARY_MAX_AMOUNT_RAW,
} from './runtime'

export type MainnetCanaryRoutePhase =
  | 'candidate'
  | 'testing'
  | 'verified'

export type MainnetCanaryRoute = {
  sourceKey: MainnetNetworkKey
  destinationKey: MainnetNetworkKey
  phase: MainnetCanaryRoutePhase
}

export const MAINNET_CCTP_CANARY_ROUTES: readonly MainnetCanaryRoute[] = [
  { sourceKey: 'arc', destinationKey: 'base', phase: 'verified' },
  { sourceKey: 'base', destinationKey: 'arc', phase: 'verified' },

  { sourceKey: 'arc', destinationKey: 'ethereum', phase: 'verified' },
  { sourceKey: 'ethereum', destinationKey: 'arc', phase: 'verified' },

  { sourceKey: 'arc', destinationKey: 'optimism', phase: 'verified' },
  { sourceKey: 'optimism', destinationKey: 'arc', phase: 'verified' },

  { sourceKey: 'arc', destinationKey: 'arbitrum', phase: 'verified' },
  { sourceKey: 'arbitrum', destinationKey: 'arc', phase: 'testing' },
] as const

export const MAINNET_ARC_BRIDGE_NETWORK_KEYS = [
  'arc',
  'base',
  'ethereum',
  'optimism',
  'arbitrum',
] as const satisfies readonly MainnetNetworkKey[]

export function getMainnetCanaryRoute(
  sourceChainId: number,
  destinationChainId: number,
) {
  return MAINNET_CCTP_CANARY_ROUTES.find((route) =>
    MAINNET_NETWORKS[route.sourceKey].chainId === sourceChainId
    && MAINNET_NETWORKS[route.destinationKey].chainId === destinationChainId
  )
}

export function isMainnetCanaryRouteWriteEnabled(
  sourceChainId: number,
  destinationChainId: number,
) {
  if (!MAINNET_CCTP_CANARY_ENABLED) return false

  const route = getMainnetCanaryRoute(
    sourceChainId,
    destinationChainId,
  )

  return route?.phase === 'testing'
    || route?.phase === 'verified'
}

export function getMainnetCanaryMaxAmountRaw() {
  return MAINNET_CCTP_CANARY_MAX_AMOUNT_RAW
}
