import { type Hex } from 'viem'
import {
  ARC_ROUTER, ARC_ROUTER_HASH, ARC_TOKENS, fail, minimumAtSlippage, tokenUnits, validateArcRequest, uint,
  type ArcRequest, type ArcReview, type ArcSymbol,
} from '../uniswapArcPolicy'
import { buildRouteCalldata, routeTransactionValue, verifyRouteCalldata } from './uniswapRouteProgram'
import { candidateRoutes, describeRoute, type UniswapRoute } from './uniswapPools'
import { validateOnchainReview } from './swapPolicy'

// Keyless Uniswap provider for every direction between the four Arc tokens. No API key, no third-party service: a quote is a
// read-only eth_call of the real Universal Router against the real pools (through a read-only simulation helper that plays the
// trader), and the transaction is the canonical calldata built from the pinned pool registry. The wallet only ever receives
// calldata that uniswapRouteProgram's strict decoder reproduces byte for byte.

// The helper contract's address inside a simulation. It is never deployed and holds nothing; it is also the recipient of the
// simulated swap so its balance change can be read.
export const SIMULATION_RECIPIENT: Hex = '0x00000000000000000000000000000000005151a7'
export const GAS_OVERHEAD = 28_000n          // intrinsic gas, calldata and Permit2 cold-storage costs that the simulation does not include
export const GAS_MARGIN_NUM = 3n, GAS_MARGIN_DEN = 2n // 1.5x
export const FEE_CEILING_MULTIPLIER = 2n     // maximum gas price = 2x the current price
export const DEADLINE_WINDOW_SECONDS = 120n  // counted from the latest Arc block, not from the local clock
export const REVIEW_TTL_MS = 30_000

export interface OnchainChain { blockNumber: bigint; timestamp: bigint; gasPrice: bigint; nativeBalance: bigint; routerHash: Hex }
export interface SimulationInput { data: Hex; tokenIn: ArcSymbol; tokenOut: ArcSymbol; amountIn: bigint }
export interface SimulationResult { received: bigint; spent: bigint; gas: bigint }
export interface OnchainPorts {
  now(): number
  chain(owner: Hex): Promise<OnchainChain>
  simulate(input: SimulationInput): Promise<SimulationResult>
}
export type OnchainErrorCode = 'no_route' | 'simulation_failed' | 'router_changed' | 'insufficient_native_balance' | 'rpc_unavailable' | 'clock' | 'fee_limit'
export class OnchainQuoteError extends Error { constructor(readonly code: OnchainErrorCode) { super(code); this.name = 'OnchainQuoteError' } }

export interface RouteOutcome { route: UniswapRoute; routeText: string; received: bigint; gas: bigint }
export interface RouteFailure { route: UniswapRoute; routeText: string; reason: 'reverted' | 'rpc' | 'wrong_amount' | 'zero_output' }
export interface RouteQuotes { chain: OnchainChain; startedAt: number; best: RouteOutcome; alternatives: RouteOutcome[]; failures: RouteFailure[] }

// Simulates every candidate route (best pools first, at most four) and keeps the best real output. A route that reverts, spends
// anything other than exactly the input, or yields nothing is dropped, never guessed at. A read outage is reported as such and
// is never mistaken for "no route".
export async function quoteRoutes(request: ArcRequest, ports: OnchainPorts): Promise<RouteQuotes> {
  const r = validateArcRequest(request), startedAt = ports.now()
  const candidates = candidateRoutes(r.tokenIn, r.tokenOut)
  if (candidates.length === 0) throw new OnchainQuoteError('no_route')
  let chain: OnchainChain
  try { chain = await ports.chain(r.owner as Hex) } catch { throw new OnchainQuoteError('rpc_unavailable') }
  if (chain.routerHash !== ARC_ROUTER_HASH) throw new OnchainQuoteError('router_changed')
  const amountIn = tokenUnits(r.amount, ARC_TOKENS[r.tokenIn].decimals)
  // A scratch request routed to the simulation helper: minimum 1 so the simulation reports the real output instead of reverting on a bound.
  const scratch = { ...r, owner: SIMULATION_RECIPIENT, recipient: SIMULATION_RECIPIENT }
  const deadline = chain.timestamp + DEADLINE_WINDOW_SECONDS
  const settled = await Promise.allSettled(candidates.map(async route => {
    const data = buildRouteCalldata({ request: scratch, route, minimumOutput: 1n, deadline, recipient: SIMULATION_RECIPIENT })
    return { route, simulation: await ports.simulate({ data, tokenIn: r.tokenIn, tokenOut: r.tokenOut, amountIn }) }
  }))
  const outcomes: RouteOutcome[] = [], failures: RouteFailure[] = []
  settled.forEach((result, i) => {
    const route = candidates[i], routeText = describeRoute(route)
    if (result.status === 'rejected') { failures.push({ route, routeText, reason: result.reason instanceof OnchainQuoteError && result.reason.code === 'rpc_unavailable' ? 'rpc' : 'reverted' }); return }
    const { simulation } = result.value
    if (simulation.spent !== amountIn) failures.push({ route, routeText, reason: 'wrong_amount' })
    else if (simulation.received <= 0n) failures.push({ route, routeText, reason: 'zero_output' })
    else outcomes.push({ route, routeText, received: simulation.received, gas: simulation.gas })
  })
  if (outcomes.length === 0) {
    // A read outage is not an absent route: only simulations that really ran and failed can say there is no route.
    if (failures.some(f => f.reason === 'rpc')) throw new OnchainQuoteError('rpc_unavailable')
    throw new OnchainQuoteError(failures.every(f => f.reason === 'reverted') ? 'simulation_failed' : 'no_route')
  }
  outcomes.sort((x, y) => (y.received > x.received ? 1 : y.received < x.received ? -1 : x.route.hops.length - y.route.hops.length))
  return { chain, startedAt, best: outcomes[0], alternatives: outcomes.slice(1), failures }
}

export const gasLimitFor = (simulatedGas: bigint): bigint => (simulatedGas + GAS_OVERHEAD) * GAS_MARGIN_NUM / GAS_MARGIN_DEN

// Builds a Review for the best route: exact calldata for the owner, minimum from the requested slippage, and a fee ceiling the wallet
// cannot silently exceed. The Review is validated by the same rules the controller applies before and after the user confirms.
export async function createOnchainReview(request: ArcRequest, ports: OnchainPorts, context: { owner: string; chainId: number; connected: boolean }): Promise<ArcReview> {
  const r = validateArcRequest(request)
  const quotes = await quoteRoutes(r, ports)
  const { chain, startedAt, best } = quotes
  const estimated = best.received, minimum = minimumAtSlippage(estimated, r.slippageBps)
  if (minimum <= 0n) throw new OnchainQuoteError('no_route')
  const deadline = chain.timestamp + DEADLINE_WINDOW_SECONDS
  if (Math.abs(Number(deadline) * 1000 - (startedAt + Number(DEADLINE_WINDOW_SECONDS) * 1000)) > 60_000) throw new OnchainQuoteError('clock')
  const amountIn = tokenUnits(r.amount, ARC_TOKENS[r.tokenIn].decimals)
  // The Review's own calldata is simulated once more with the minimum bound in place, so the bound itself is proven reachable.
  const bounded = buildRouteCalldata({ request: { ...r, owner: SIMULATION_RECIPIENT, recipient: SIMULATION_RECIPIENT }, route: best.route, minimumOutput: minimum, deadline, recipient: SIMULATION_RECIPIENT })
  let proof: SimulationResult
  try { proof = await ports.simulate({ data: bounded, tokenIn: r.tokenIn, tokenOut: r.tokenOut, amountIn }) } catch { throw new OnchainQuoteError('simulation_failed') }
  if (proof.spent !== amountIn || proof.received < minimum) throw new OnchainQuoteError('simulation_failed')
  const data = buildRouteCalldata({ request: r, route: best.route, minimumOutput: minimum, deadline })
  const gas = gasLimitFor(proof.gas > best.gas ? proof.gas : best.gas), maxFee = chain.gasPrice * FEE_CEILING_MULTIPLIER, fee = gas * maxFee
  if (gas > 2_000_000n || fee > uint(r.maxNetworkFee)) throw new OnchainQuoteError('fee_limit')
  const value = routeTransactionValue(r)
  if (chain.nativeBalance < value + fee) throw new OnchainQuoteError('insufficient_native_balance')
  const expiresAt = Math.min(startedAt + REVIEW_TTL_MS, Number(deadline) * 1000)
  const review: ArcReview = {
    source: 'onchain', route: best.routeText,
    request: r, transaction: { chainId: 5042, from: r.owner, to: ARC_ROUTER, data, value: `0x${value.toString(16)}` },
    estimatedOutput: estimated.toString(), requiredMinimum: minimum.toString(), requestStartedAt: startedAt, expiresAt,
    routerHash: ARC_ROUTER_HASH, blockNumber: chain.blockNumber.toString(), gasLimit: gas.toString(), maxFeePerGas: maxFee.toString(), maxPriorityFeePerGas: '0',
    networkFee: fee.toString(), ...(r.tokenIn === 'USDC' ? { estimatedNetworkFee: (((proof.gas > best.gas ? proof.gas : best.gas) + GAS_OVERHEAD) * chain.gasPrice).toString() } : {}), nativeBalance: chain.nativeBalance.toString(), simulation: 'passed', executionBound: false, writesEnabled: false,
  }
  validateOnchainReview(review, context, startedAt)
  // Defensive: the decoder must reproduce exactly the route that was simulated.
  const decoded = verifyRouteCalldata(review.transaction, r, minimum, startedAt)
  if (decoded.routeText !== best.routeText) fail('unverified_review')
  return review
}
