import { getCircleMainnetReadiness } from './circle'
import { getMainnetReadiness } from './mainnet'
import {
  APP_NETWORK,
  MAINNET_GATEWAY_RUNTIME_IMPLEMENTED,
  MAINNET_RUNTIME_IMPLEMENTED,
  type AppNetwork,
} from './runtime'

export type RuntimeCapabilities = {
  swap: boolean
  evmBridge: boolean
  gateway: boolean
  faucet: boolean
  realValueTransfers: boolean
}

export function getRuntimeCapabilities(network: AppNetwork = APP_NETWORK): RuntimeCapabilities {
  if (network === 'testnet') {
    return {
      swap: true,
      evmBridge: true,
      gateway: true,
      faucet: true,
      realValueTransfers: false,
    }
  }

  const arcReady = getMainnetReadiness().ready
  const circleReady = getCircleMainnetReadiness()
  const runtimeUnlocked = MAINNET_RUNTIME_IMPLEMENTED === true
  const gatewayRuntimeUnlocked = MAINNET_GATEWAY_RUNTIME_IMPLEMENTED === true

  return {
    swap: false,
    evmBridge: runtimeUnlocked && arcReady && circleReady.cctpReady,
    gateway: gatewayRuntimeUnlocked && arcReady && circleReady.gatewayReady,
    faucet: false,
    realValueTransfers: runtimeUnlocked && arcReady && circleReady.cctpReady,
  }
}
