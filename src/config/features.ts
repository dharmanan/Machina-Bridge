import { getCircleMainnetReadiness } from './circle'
import { getMainnetReadiness } from './mainnet'
import { APP_NETWORK, MAINNET_RUNTIME_IMPLEMENTED } from './runtime'

export type RuntimeCapabilities = {
  swap: boolean
  evmBridge: boolean
  gateway: boolean
  countdown: boolean
  faucet: boolean
  realValueTransfers: boolean
}

export function getRuntimeCapabilities(): RuntimeCapabilities {
  if (APP_NETWORK === 'testnet') {
    return {
      swap: true,
      evmBridge: true,
      gateway: true,
      countdown: true,
      faucet: true,
      realValueTransfers: false,
    }
  }

  const arcReady = getMainnetReadiness().ready
  const circleReady = getCircleMainnetReadiness()
  const runtimeUnlocked = MAINNET_RUNTIME_IMPLEMENTED === true

  return {
    swap: false,
    evmBridge: runtimeUnlocked && arcReady && circleReady.cctpReady,
    gateway: runtimeUnlocked && arcReady && circleReady.gatewayReady,
    countdown: false,
    faucet: false,
    realValueTransfers: runtimeUnlocked && arcReady && circleReady.cctpReady,
  }
}
