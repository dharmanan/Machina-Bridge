import { controlledSwapRelease } from '../lib/swap/executionMode'

// Restore the existing Mainnet Live Swap product rather than silently downgrading
// an unset/legacy "canary" build to restricted access. Explicit off/false remains
// an immediate kill switch, and explicit pilot remains the 0.1 USDC fallback.
// No wallet approval, fee, minimum-output, simulation or receipt guard is bypassed.
const configuredMode = import.meta.env.VITE_SWAP_EXECUTION_MODE
export const SWAP_EXECUTION = controlledSwapRelease(
  import.meta.env.VITE_UNISWAP_ARC_PILOT_ENABLED ?? 'true',
  import.meta.env.VITE_UNISWAP_ARC_PILOT_WALLET,
  configuredMode === undefined || configuredMode === 'canary' ? 'open' : configuredMode,
)
