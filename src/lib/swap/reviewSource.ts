import { requestKey, validateArcRequest, type ArcRequest, type ArcReview } from '../uniswapArcPolicy'
import { createUniswapArcPreviewReader, ArcPreviewError, uniswapArcPreviewErrorMessage, type ArcWalletContext } from '../uniswapArcPreview'
import { OnchainQuoteError, createOnchainReview, type OnchainPorts } from './uniswapOnchain'
import { createOnchainPorts } from './uniswapOnchainRpc'
import { validateReview } from './swapPolicy'
import type { SwapExecutionMode } from './executionMode'

// One source of Uniswap Reviews, chosen by what is being asked, never by what happens to be available:
//   'api'     the controlled pilot route in pilot mode (USDC -> EURC): Uniswap Trading API calldata through the server preview route,
//             exactly the path the first real swap used.
//   'onchain' everything else, and every route in open mode: the keyless pinned-pool provider (swap/uniswapOnchain).
// A request never silently falls from one source to the other: a quote and the Review that is later sent always come from the same one.
export type ReviewSourceKind = 'api' | 'onchain'
export const reviewSourceKind = (mode: SwapExecutionMode, request: Pick<ArcRequest, 'tokenIn' | 'tokenOut'>): ReviewSourceKind =>
  mode === 'pilot' && request.tokenIn === 'USDC' && request.tokenOut === 'EURC' ? 'api' : 'onchain'

export class ReviewSourceError extends Error {
  constructor(readonly code: 'cancelled' | 'busy' | 'context' | 'policy' | 'expired', readonly cause?: unknown) { super(code); this.name = 'ReviewSourceError' }
}
export function onchainErrorMessage(error: unknown): string {
  if (error instanceof OnchainQuoteError) {
    const messages: Record<OnchainQuoteError['code'], string> = {
      no_route: 'Uniswap has no pool route with liquidity for this pair and amount. No quote is shown.',
      simulation_failed: 'Arc rejected the simulated swap for this amount. No quote is shown.',
      router_changed: 'The Universal Router on Arc no longer matches the audited code, so Uniswap quotes are switched off.',
      insufficient_native_balance: 'The native USDC balance cannot cover the network fee ceiling (plus the amount, when USDC is what you pay).',
      snapshot_changed: 'Arc’s block snapshot changed during verification. Request a fresh quote; nothing was sent.',
      rpc_unavailable: 'Arc could not be read just now. This is a read problem, not a swap result; try again.',
      clock: 'This device’s clock differs from Arc’s by more than a minute. Correct the clock and request a new quote.',
      fee_limit: 'The current network fee is above the safety ceiling of 0.1 USDC. No quote is shown.',
    }
    return messages[error.code]
  }
  if (error instanceof ReviewSourceError) {
    const messages = { cancelled: 'The quote was cancelled after the page or wallet changed.', busy: 'A quote for this wallet is still finishing.', context: 'The wallet, network or swap inputs changed. Request a new quote.',
      policy: 'The quote failed transaction safety checks, so its output and fees are not shown as verified.', expired: 'The quote expired during verification. Request a new quote.' }
    return messages[error.code]
  }
  if (error instanceof ArcPreviewError) return uniswapArcPreviewErrorMessage(error)
  const code = error instanceof Error ? error.message : ''
  if (code === 'wallet_context_changed') return onchainErrorMessage(new ReviewSourceError('context'))
  if (code === 'input_range') return 'This amount exceeds the supported contract number range. Enter a smaller amount.'
  if (code === 'invalid_amount' || code === 'invalid_minimum_or_slippage') return 'Enter a valid amount.'
  return onchainErrorMessage(new ReviewSourceError('policy'))
}

export interface ReviewSource {
  kind(request: ArcRequest): ReviewSourceKind
  read(request: ArcRequest): Promise<ArcReview>
  current(request: ArcRequest): ArcReview | null
  // The clock a Review is judged against: the server's for the API source, this device's for the on-chain source.
  now(request: ArcRequest): number
  remainingMs(request: ArcRequest): number
  invalidate(): void
}
export function createReviewSource(getContext: () => ArcWalletContext, mode: () => SwapExecutionMode, ports: OnchainPorts = createOnchainPorts(), fetcher: typeof fetch = (...args) => fetch(...args)): ReviewSource {
  const api = createUniswapArcPreviewReader(getContext, fetcher)
  let generation = 0, held: ArcReview | null = null
  const kind = (request: ArcRequest) => reviewSourceKind(mode(), request)
  function invalidate() { generation++; held = null; api.invalidate() }
  function current(request: ArcRequest): ArcReview | null {
    if (kind(request) === 'api') return api.current(request)
    if (!held) return null
    try {
      if (requestKey(held.request) !== requestKey(request)) throw new ReviewSourceError('context')
      validateReview(held, getContext(), Date.now())
      return structuredClone(held)
    } catch { held = null; return null }
  }
  return {
    kind, current, invalidate,
    now: request => (kind(request) === 'api' ? api.validationTime(request) : Date.now()),
    remainingMs: request => {
      if (kind(request) === 'api') return api.remainingMs(request)
      const review = current(request)
      return review ? Math.max(0, review.expiresAt - Date.now()) : 0
    },
    async read(input) {
      const request = validateArcRequest(input)
      if (kind(request) === 'api') return api.read(request)
      const context = getContext(), version = ++generation
      held = null
      if (!context.connected || context.chainId !== 5042 || context.owner.toLowerCase() !== request.owner.toLowerCase()) throw new ReviewSourceError('context')
      const review = await createOnchainReview(request, ports, context)
      if (version !== generation) throw new ReviewSourceError('cancelled')
      held = structuredClone(review)
      return structuredClone(review)
    },
  }
}
