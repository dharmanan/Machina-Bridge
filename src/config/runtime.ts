export type AppNetwork = 'testnet' | 'mainnet'

function readBoolean(value: string | undefined) {
  return value?.trim().toLowerCase() === 'true'
}

const requestedNetwork = import.meta.env.VITE_APP_NETWORK?.trim().toLowerCase()

export const APP_NETWORK: AppNetwork = requestedNetwork === 'mainnet' ? 'mainnet' : 'testnet'
export const IS_MAINNET_PROFILE = APP_NETWORK === 'mainnet'
export const IS_TESTNET_PROFILE = APP_NETWORK === 'testnet'

// Deliberately false until the mainnet chain/Circle runtime has been fully
// migrated and verified. A mainnet-profile deployment must remain read-only
// until this code-level lock is intentionally removed in a reviewed change.
export const MAINNET_RUNTIME_IMPLEMENTED = false as const

// This flag only exposes the hidden/read-only mainnet preview. It does not
// unlock transactions.
export const MAINNET_PREVIEW_ENABLED = readBoolean(import.meta.env.VITE_ENABLE_MAINNET_PREVIEW)

export const MAINNET_APP_URL = import.meta.env.VITE_MAINNET_APP_URL?.trim() || ''

export function getAppNetworkLabel() {
  return IS_MAINNET_PROFILE ? 'Mainnet' : 'Testnet'
}
