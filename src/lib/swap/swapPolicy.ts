import {
  ARC_ROUTER_HASH, fail, minimumAtSlippage, nativeAmount, sameAddress, uint, validateArcRequest, validateArcReview,
  type ArcRequest, type ArcReview, type ArcSymbol,
} from '../uniswapArcPolicy'
import { routeTransactionValue, verifyRouteCalldata } from './uniswapRouteProgram'

// One entry point for every Review, whatever produced it:
//   source 'api' (or absent): Trading API calldata for native USDC to EURC/cirBTC, decoded by the legacy profiles (uniswapArcPolicy)
//   source 'onchain'        : locally built V3 route calldata (uniswapRouteProgram), quoted by an eth_call simulation
// Both kinds are held to the same economic, timing, fee, wallet and flag rules. A review that claims one source is never judged by
// the other source's decoder.
export interface ReviewContext { owner: string; chainId: number; connected: boolean }

export function validateOnchainReview(review: ArcReview, context: ReviewContext, now: number): void {
  const r = validateArcRequest(review.request)
  if (!context.connected || context.chainId !== 5042 || !sameAddress(context.owner, r.owner)) fail('wallet_context_changed')
  if (review.source !== 'onchain' || review.quoteId !== undefined || review.writesEnabled !== false || review.executionBound !== false || review.simulation !== 'passed' || review.routerHash !== ARC_ROUTER_HASH) fail('unverified_review')
  const estimated = uint(review.estimatedOutput), minimum = uint(review.requiredMinimum)
  if (minimum > estimated || minimum < minimumAtSlippage(estimated, r.slippageBps)) fail('economic_mismatch')
  if (!Number.isSafeInteger(review.requestStartedAt) || !Number.isSafeInteger(review.expiresAt) || review.expiresAt <= review.requestStartedAt || review.expiresAt > review.requestStartedAt + 30000 || now < review.requestStartedAt || now >= review.expiresAt) fail('quote_expired')
  const economics = verifyRouteCalldata(review.transaction, r, minimum, now)
  if (typeof review.route !== 'string' || review.route !== economics.routeText) fail('unverified_review')
  const gas = uint(review.gasLimit), price = uint(review.maxFeePerGas), tip = uint(review.maxPriorityFeePerGas)
  if (gas < 21000n || gas > 2000000n || price <= 0n || price > 100000000000n || tip > price) fail('gas_limit')
  const fee = gas * price
  if (fee !== uint(review.networkFee) || fee > uint(r.maxNetworkFee) || uint(review.nativeBalance) < routeTransactionValue(r) + fee) fail('balance_or_fee')
}

export function validateReview(review: ArcReview, context: ReviewContext, now = Date.now()): void {
  if (review.source === 'onchain') return validateOnchainReview(review, context, now)
  if (review.source !== undefined && review.source !== 'api') fail('unverified_review')
  // Legacy profiles exist only for native USDC to EURC or cirBTC; anything else needs an 'onchain' review.
  const request = validateArcRequest(review.request)
  if (request.tokenIn !== 'USDC' || (request.tokenOut !== 'EURC' && request.tokenOut !== 'cirBTC')) fail('unsupported_direction')
  validateArcReview(review, context, now)
}
// Native value the transaction must carry: the input amount for native USDC, nothing for an ERC-20 input.
export const reviewValue = (review: ArcReview): bigint => (review.source === 'onchain' ? routeTransactionValue(review.request) : nativeAmount(review.request.amount))
export const reviewUsesPermit2 = (request: ArcRequest): boolean => request.tokenIn !== 'USDC'
export const isNativeInput = (symbol: ArcSymbol) => symbol === 'USDC'
