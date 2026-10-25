import { swapExecutionConfig } from '../lib/swap/executionMode'

// Public build configuration, not authentication. Both the exact execution switch "true" and an explicit
// VITE_SWAP_EXECUTION_MODE=open or pilot are required. Missing/invalid modes disable execution for both providers.
// The explicit pilot additionally restricts wallet, direction, amount and provider. No mode bypasses safety checks.
export const SWAP_EXECUTION = swapExecutionConfig(import.meta.env.VITE_UNISWAP_ARC_PILOT_ENABLED, import.meta.env.VITE_UNISWAP_ARC_PILOT_WALLET, import.meta.env.VITE_SWAP_EXECUTION_MODE)
