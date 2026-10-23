import { SWAP_DIRECTIONS, type SwapProviderId, type SwapSymbol } from './tokens'
import { candidateRoutes, describeRoute } from './uniswapPools'
import { CIRCLE_ADAPTER } from './circleAdapterDecode'
import type { SwapExecutionConfig } from './executionMode'

// What each provider can do for each of the 12 directions, derived from the code that actually runs (the pinned pool registry, the
// allowance rules of each controller, the execution gates) and checked against the live evidence file by scripts/verify-swap-support-matrix.mjs.
// "Supported" here means: quoted from live data, built, tested and verified end to end with controlled doubles. Whether a real transaction has
// ever been sent by this application is stated separately (liveTransaction) and is never implied.
export type ApprovalKind = 'none' | 'permit2_exact' | 'adapter_permit' | 'adapter_exact'
export interface SupportEntry {
  id: string; provider: SwapProviderId; tokenIn: SwapSymbol; tokenOut: SwapSymbol
  quote: string                 // where the price comes from
  routing: string               // how the swap is routed
  routes: string[]              // every route the app will consider (Uniswap) or the single provider route (Circle)
  approval: { kind: ApprovalKind; steps: number; text: string }
  verification: string
  // Execution in each build mode. 'pilot' is the production build today; 'open' needs a separate release decision.
  execution: { pilot: 'enabled' | 'quotes_only'; open: 'enabled' | 'gated'; text: string }
  liveTransaction: string       // evidence that this application itself has sent a real transaction on this route
}

const PILOT_ROUTE = (tokenIn: SwapSymbol, tokenOut: SwapSymbol) => tokenIn === 'USDC' && tokenOut === 'EURC'
function uniswapEntry(tokenIn: SwapSymbol, tokenOut: SwapSymbol): SupportEntry {
  const routes = candidateRoutes(tokenIn, tokenOut).map(describeRoute), native = tokenIn === 'USDC', pilot = PILOT_ROUTE(tokenIn, tokenOut)
  return {
    id: `uniswap:${tokenIn}>${tokenOut}`, provider: 'uniswap', tokenIn, tokenOut,
    quote: pilot ? 'Uniswap Trading API through the server preview route (pilot build); keyless pool simulation in open mode' : 'Read-only simulation of the real Universal Router against the real pools (keyless)',
    routing: pilot ? 'Uniswap Universal Router, V4 pool (pilot) or V3 pools (open mode)' : 'Uniswap Universal Router, V3 pools from the pinned registry',
    routes, approval: native ? { kind: 'none', steps: 0, text: 'Native USDC is sent as transaction value; no approval.' } : { kind: 'permit2_exact', steps: 2, text: `Two exact approvals: ${tokenIn} to Permit2, then Permit2 to the Router (valid 15 minutes). Never unlimited.` },
    verification: 'Strict calldata decoder before the wallet; receipt, transfers and fee ceiling checked after, separately from the Review.',
    execution: { pilot: pilot ? 'enabled' : 'quotes_only', open: 'gated', text: pilot ? 'Enabled in the controlled pilot (approved wallet, up to 0.1 USDC).' : 'Built and tested; quotes only in the pilot build. Opens with the execution mode, a separate release decision.' },
    liveTransaction: pilot ? 'Yes: one real swap (0x1a5e…a921) through the Trading API path; its verification is reported separately.' : 'None yet. The keyless route was only simulated read-only against the live router.',
  }
}
function circleEntry(tokenIn: SwapSymbol, tokenOut: SwapSymbol, seenOnChain: boolean): SupportEntry {
  const permit = tokenIn === 'USDC'
  return {
    id: `circle:${tokenIn}>${tokenOut}`, provider: 'circle', tokenIn, tokenOut,
    quote: 'Circle Swap Kit estimate (service quote, read-only)', routing: `Circle Swap Kit adapter ${CIRCLE_ADAPTER}`, routes: ['Circle Swap Kit router'],
    approval: permit ? { kind: 'adapter_permit', steps: 1, text: 'One-time EIP-2612 permit signature for exactly the amount (a signature, not a transaction).' } : { kind: 'adapter_exact', steps: 1, text: `One exact ${tokenIn} approval for the Circle adapter, then the swap.` },
    verification: 'Pinned adapter-call decoder before the wallet (guarded wallet); receipt, transfers and fee ceiling checked after, separately from the Review.',
    execution: { pilot: 'quotes_only', open: 'gated', text: 'Built and tested with the real SDK against controlled doubles; switched off by its own source gate until a live test is approved. Never part of the pilot.' },
    liveTransaction: seenOnChain ? 'None by this application. Real swaps on this direction by other wallets are on chain and were decoded as fixtures.' : 'None by this application, and no real swap of this direction was found among the decoded fixtures.',
  }
}
// Directions with a real Circle adapter swap among the decoded on-chain fixtures (scripts/fixtures/swap/circle/arc-circle-swaps.json).
export const CIRCLE_FIXTURE_DIRECTIONS: readonly string[] = ['USDC>EURC', 'EURC>USDC', 'WETH>USDC', 'cirBTC>EURC', 'USDC>cirBTC', 'cirBTC>USDC', 'EURC>cirBTC']
export const SUPPORT_MATRIX: readonly SupportEntry[] = SWAP_DIRECTIONS.flatMap(({ tokenIn, tokenOut }) => [uniswapEntry(tokenIn, tokenOut), circleEntry(tokenIn, tokenOut, CIRCLE_FIXTURE_DIRECTIONS.includes(`${tokenIn}>${tokenOut}`))])
export const supportFor = (provider: SwapProviderId, tokenIn: SwapSymbol, tokenOut: SwapSymbol): SupportEntry | undefined => SUPPORT_MATRIX.find(entry => entry.provider === provider && entry.tokenIn === tokenIn && entry.tokenOut === tokenOut)

// What the selected build lets this provider do for a route right now (the screen shows this; it never claims more).
export function executionInBuild(entry: SupportEntry, config: SwapExecutionConfig, circleOpen: boolean): { available: boolean; text: string } {
  if (!config.enabled) return { available: false, text: 'Execution is switched off in this build: quotes only.' }
  if (config.mode === 'open') return entry.provider === 'circle' && !circleOpen ? { available: false, text: 'Switched off until a live test is approved: quotes only.' } : { available: true, text: 'Available.' }
  return entry.execution.pilot === 'enabled' ? { available: true, text: 'Available in the controlled pilot (approved wallet, up to 0.1 USDC).' } : { available: false, text: 'Quotes only in the controlled pilot.' }
}
