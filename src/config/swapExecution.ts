import { controlledSwapRelease } from '../lib/swap/executionMode'

// Source-controlled approved-wallet canary, not authentication. No build value grants public execution in this release.
// Explicit false/off is the kill switch. The explicit legacy pilot remains a restricted rollback option.
// Missing mode selects this canary without the old 0.1-USDC product cap. Economic checks still apply.
export const SWAP_EXECUTION = controlledSwapRelease(import.meta.env.VITE_UNISWAP_ARC_PILOT_ENABLED, import.meta.env.VITE_UNISWAP_ARC_PILOT_WALLET, import.meta.env.VITE_SWAP_EXECUTION_MODE)
