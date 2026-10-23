import { swapExecutionConfig } from '../lib/swap/executionMode'

// Public build configuration (not a credential and not a server-side boundary). Execution is off unless
// VITE_UNISWAP_ARC_PILOT_ENABLED is exactly "true"; the mode is "pilot" unless VITE_SWAP_EXECUTION_MODE is exactly "open".
// The production build uses pilot mode: lifting that limit is a separate release decision.
export const SWAP_EXECUTION = swapExecutionConfig(import.meta.env.VITE_UNISWAP_ARC_PILOT_ENABLED, import.meta.env.VITE_UNISWAP_ARC_PILOT_WALLET, import.meta.env.VITE_SWAP_EXECUTION_MODE)
