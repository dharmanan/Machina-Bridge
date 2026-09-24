export type AppNetwork = 'testnet' | 'mainnet'

function readBoolean(value: string | undefined) {
  return value?.trim().toLowerCase() === 'true'
}

const requestedNetwork = import.meta.env.VITE_APP_NETWORK?.trim().toLowerCase()

export const APP_NETWORK: AppNetwork = requestedNetwork === 'mainnet' ? 'mainnet' : 'testnet'
export const IS_MAINNET_PROFILE = APP_NETWORK === 'mainnet'
export const IS_TESTNET_PROFILE = APP_NETWORK === 'testnet'

// Deliberately false until the mainnet EVM/Circle runtime has been fully
// migrated, preflight-hardened and verified. A mainnet-profile deployment must
// remain read-only until this code-level lock is intentionally removed in a
// reviewed change.
export const MAINNET_RUNTIME_IMPLEMENTED: boolean = false

// Gateway has its own lock because the existing forwarding flow still includes
// Solana Devnet-specific behavior. Unlocking EVM CCTP must never implicitly
// enable that flow on mainnet.
export const MAINNET_GATEWAY_RUNTIME_IMPLEMENTED: boolean = false

// This flag only exposes the hidden/read-only mainnet preview. It does not
// unlock transactions.
export const MAINNET_PREVIEW_ENABLED = readBoolean(import.meta.env.VITE_ENABLE_MAINNET_PREVIEW)

export const MAINNET_APP_URL = import.meta.env.VITE_MAINNET_APP_URL?.trim() || ''

export function getAppNetworkLabel() {
  return IS_MAINNET_PROFILE ? 'Mainnet' : 'Testnet'
}


export const APP_NETWORK_STORAGE_KEY = 'machina_app_network'

export function readStoredAppNetwork(): AppNetwork {
  if (typeof window === 'undefined') return 'testnet'
  return window.localStorage.getItem(APP_NETWORK_STORAGE_KEY) === 'mainnet' ? 'mainnet' : 'testnet'
}

export function storeAppNetwork(network: AppNetwork) {
  if (typeof window !== 'undefined') {
    window.localStorage.setItem(APP_NETWORK_STORAGE_KEY, network)
  }
}
