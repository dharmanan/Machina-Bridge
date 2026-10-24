import { getAddress, isAddress } from 'viem'
import { arcPilotAllows, arcPilotConfig, ARC_PILOT_APPROVED_WALLET, ARC_PILOT_MAX_INPUT } from '../uniswapArcPilot'
import { ARC_ROUTER, sameAddress, validateArcRequest, type ArcRequest } from '../uniswapArcPolicy'

// Who may execute which swap. Two modes:
//   open  (the default) every supported direction, both providers, any externally owned wallet.
//         Amounts remain bounded by balances, contract types and the existing economic/transaction checks.
//   pilot the earlier controlled pilot, kept only as an explicit fallback: exactly the approved wallet, native USDC -> EURC, at most
//         0.1 USDC, Uniswap, Trading-API calldata. It is selected only by the exact build value VITE_SWAP_EXECUTION_MODE=pilot.
// In both modes the execution switch itself (VITE_UNISWAP_ARC_PILOT_ENABLED === "true") must be on: it remains the single kill switch of
// the build. Neither mode weakens a transaction check; they only decide whether a request may start.
export type SwapExecutionMode = 'pilot' | 'open'
export interface SwapExecutionConfig { enabled: boolean; mode: SwapExecutionMode; wallet: string }

export function swapExecutionConfig(enabled?: string, wallet?: string, mode?: string): SwapExecutionConfig {
  if (mode === 'pilot') { const pilot = arcPilotConfig(enabled, wallet); return Object.freeze({ enabled: pilot.enabled, mode: 'pilot', wallet: pilot.wallet }) }
  const valid = typeof wallet === 'string' && isAddress(wallet) && BigInt(wallet) > 2n && !sameAddress(wallet, ARC_ROUTER)
  return Object.freeze({ enabled: enabled === 'true', mode: 'open', wallet: valid ? getAddress(wallet) : '' })
}

export type ExecutionRestriction = 'disabled' | 'wallet' | 'network' | 'pilot_direction' | 'pilot_amount' | 'pilot_wallet' | 'request' | 'pilot_provider' | 'provider_closed'
interface WalletContext { connected: boolean; owner: string; chainId: number }

// null means the request may start; otherwise the single reason it may not, so the UI can say exactly why.
export function swapExecutionRestriction(config: SwapExecutionConfig, input: ArcRequest | null, context: WalletContext): ExecutionRestriction | null {
  if (!config.enabled) return 'disabled'
  if (!context.connected) return 'wallet'
  if (context.chainId !== 5042) return 'network'
  let request: ArcRequest
  try { request = validateArcRequest(input) } catch { return 'request' }
  if (!sameAddress(context.owner, request.owner)) return 'wallet'
  if (config.mode === 'open') return null
  if (!sameAddress(config.wallet, ARC_PILOT_APPROVED_WALLET) || !sameAddress(context.owner, config.wallet)) return 'pilot_wallet'
  if (request.tokenIn !== 'USDC' || request.tokenOut !== 'EURC') return 'pilot_direction'
  return arcPilotAllows({ enabled: config.enabled, wallet: config.wallet }, request, context) ? null : 'pilot_amount'
}
// Circle Swap Kit follows the same gates, plus its own source gate (providerOpen). The controlled pilot never includes Circle.
export function circleExecutionRestriction(config: SwapExecutionConfig, input: { owner: string } | null, context: WalletContext, providerOpen: boolean): ExecutionRestriction | null {
  if (!config.enabled) return 'disabled'
  if (!context.connected) return 'wallet'
  if (context.chainId !== 5042) return 'network'
  if (!input || !sameAddress(context.owner, input.owner)) return input ? 'wallet' : 'request'
  if (config.mode !== 'open') return 'pilot_provider'
  return providerOpen ? null : 'provider_closed'
}
export const swapExecutionAllows = (config: SwapExecutionConfig, input: ArcRequest | null, context: WalletContext): boolean => swapExecutionRestriction(config, input, context) === null

export function executionRestrictionMessage(restriction: ExecutionRestriction): string {
  const messages: Record<ExecutionRestriction, string> = {
    disabled: 'Swap execution is switched off in this build. Quotes and routes are shown for comparison only.',
    wallet: 'Connect the wallet that will pay for this swap.',
    network: 'Select Arc Mainnet (chain ID 5042) in your wallet.',
    pilot_wallet: 'Execution is limited to the approved pilot wallet. Quotes and routes are shown for comparison only.',
    pilot_direction: 'Execution is limited to the controlled pilot (USDC → EURC). This route is quoted and verified, but cannot be sent until the pilot limit is lifted by a separate release decision.',
    pilot_amount: `The controlled pilot allows at most ${Number(ARC_PILOT_MAX_INPUT / 10n ** 12n) / 1e6} USDC per swap. Enter a smaller amount to execute.`,
    request: 'Enter a valid amount to review a swap.',
    pilot_provider: 'Circle Swap Kit swaps are not part of the controlled pilot. Quotes are shown for comparison only.',
    provider_closed: 'Circle Swap Kit swaps are switched off in this build. Quotes are shown for comparison only.',
  }
  return messages[restriction]
}

// The label next to the page title. It describes what the selected provider and direction can do in this build, never whether an
// amount has been typed.
export type ChipTone = 'live' | 'pilot' | 'quotes'
export function executionChip(config: SwapExecutionConfig, route: { provider: 'uniswap' | 'circle'; tokenIn: string; tokenOut: string }, circleWritesOpen = false): { label: string; tone: ChipTone } {
  if (!config.enabled) return { label: 'Preview only', tone: 'quotes' }
  if (route.provider === 'circle' && !circleWritesOpen) return { label: 'Quotes only', tone: 'quotes' }
  if (config.mode === 'open') return { label: 'Live swap', tone: 'live' }
  return route.provider === 'uniswap' && route.tokenIn === 'USDC' && route.tokenOut === 'EURC' ? { label: 'Controlled pilot', tone: 'pilot' } : { label: 'Quotes only', tone: 'quotes' }
}
