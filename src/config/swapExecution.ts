import { swapExecutionConfig } from '../lib/swap/executionMode'

// Public build configuration (not a credential and not a server-side boundary). Execution is off unless
// VITE_UNISWAP_ARC_PILOT_ENABLED is exactly "true" (the kill switch of the build). The mode is the full multi-direction swap
// ("open": every direction, both providers, any wallet, per-token ceilings) unless VITE_SWAP_EXECUTION_MODE is exactly "pilot",
// which restores the earlier controlled pilot (approved wallet, USDC to EURC, at most 0.1 USDC, Uniswap only).
export const SWAP_EXECUTION = swapExecutionConfig(import.meta.env.VITE_UNISWAP_ARC_PILOT_ENABLED, import.meta.env.VITE_UNISWAP_ARC_PILOT_WALLET, import.meta.env.VITE_SWAP_EXECUTION_MODE)
