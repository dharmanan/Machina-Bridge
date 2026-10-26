import { controlledSwapRelease } from '../lib/swap/executionMode'

// Production execution policy: explicit mode=open and enabled=true restores prior Live Swap.
// Missing mode retains the approved-wallet canary; mode=pilot retains the old 0.1 USDC fallback.
// Explicit false/off and malformed modes fail closed. Mode is not transaction authorization;
// simulation, slippage/minimum, fees, wallet and settlement checks are unchanged.
export const SWAP_EXECUTION = controlledSwapRelease(import.meta.env.VITE_UNISWAP_ARC_PILOT_ENABLED, import.meta.env.VITE_UNISWAP_ARC_PILOT_WALLET, import.meta.env.VITE_SWAP_EXECUTION_MODE)
