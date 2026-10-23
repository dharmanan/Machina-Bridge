import { createPublicClient, defineChain, erc20Abi, formatUnits, http, parseUnits, type Hex, type Transport } from 'viem'
import { ViemAdapter } from '@circle-fin/adapter-viem-v2'
import { SwapKit, getChainByEnum } from '@circle-fin/swap-kit'
import { assertCircleExecutionReadMethod, circleFeeCeiling, createCircleChainRpc, type CircleSwapRequest, type CircleSwapReview } from './circleSwap'
import type { GuardedWallet } from './circleGuard'
import { readMainnetSwapQuote, decimalUnits, type PreviewQuote } from '../mainnetSwap'
import { swapToken } from './tokens'
import { CIRCLE_ADAPTER } from './circleAdapterDecode'
import { MAINNET_SWAP_QUOTE_TTL_MS } from '../../config/mainnetSwap'
import { validateArcRequest } from '../uniswapArcPolicy'
import { createOnchainReview } from './uniswapOnchain'
import { createOnchainPorts } from './uniswapOnchainRpc'
import type { CirclePerformance } from './circlePerformance'

// The pinned, read-only Arc client for Circle execution: only the read methods in assertCircleExecutionReadMethod can pass, so neither the
// SDK nor anything else can send, sign or approve through it. The only write path is the guarded wallet (circleGuard).
const RPC = 'https://rpc.mainnet.arc.io'
const chain = defineChain({ id: 5042, name: 'Arc Mainnet', nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 }, rpcUrls: { default: { http: [RPC] } } })
const transport: Transport = options => {
  const underlying = http(RPC, { timeout: 8000, retryCount: 0 })(options)
  // Both the client's request and the transport's own request are guarded; nothing reaches the network layer without the read-only check.
  const guarded: typeof underlying.request = (args, requestOptions) => { assertCircleExecutionReadMethod(args.method); return underlying.request(args, requestOptions) }
  const rawGuarded = (args: { method: string; params?: unknown }) => { assertCircleExecutionReadMethod(args.method); return underlying.config.request(args as never) }
  return { ...underlying, config: { ...underlying.config, request: rawGuarded as never }, request: guarded }
}
export const circleReadClient = createPublicClient({ chain, transport, ccipRead: false, cacheTime: 0 })
export const circleChainRpc = createCircleChainRpc(circleReadClient)

// Builds the SDK around the guarded wallet: the adapter's public client is the read-only client above and its wallet client is the guard.
export function circleSdk(wallet: GuardedWallet) {
  const adapter = new ViemAdapter({ getPublicClient: () => circleReadClient, getWalletClient: () => wallet as never }, { addressContext: 'user-controlled', supportedChains: [getChainByEnum('Arc')] })
  return { kit: new SwapKit({ disableAnalytics: true, disableErrorReporting: true }) as unknown as { swap(params: Record<string, unknown>): Promise<unknown> }, adapter }
}

// Chain facts a Review needs, read at one pinned block.
export interface CircleReviewFacts { nativeBalance: bigint; tokenBalance: bigint; allowance: bigint; gasPrice: bigint; baseFee: bigint | null }
export async function readCircleReviewFacts(owner: string, tokenIn: ReturnType<typeof swapToken>, rpc: typeof circleReadClient = circleReadClient): Promise<CircleReviewFacts> {
  const blockNumber = await rpc.getBlockNumber({ cacheTime: 0 })
  const [block, nativeBalance, tokenBalance, allowance, gasPrice] = await Promise.all([
    rpc.getBlock({ blockNumber }), rpc.getBalance({ address: owner as Hex, blockNumber }),
    rpc.readContract({ address: tokenIn.address as Hex, abi: erc20Abi, functionName: 'balanceOf', args: [owner as Hex], blockNumber }),
    rpc.readContract({ address: tokenIn.address as Hex, abi: erc20Abi, functionName: 'allowance', args: [owner as Hex, CIRCLE_ADAPTER as Hex], blockNumber }),
    rpc.getGasPrice(),
  ])
  return { nativeBalance, tokenBalance, allowance, gasPrice, baseFee: typeof block.baseFeePerGas === 'bigint' ? block.baseFeePerGas : null }
}

export interface CircleReviewDeps {
  performance?: CirclePerformance
  // An independent price for the same swap (the keyless Uniswap quote), or null when none could be read.
  reference?(request: CircleSwapRequest): Promise<string | null>
  quote(request: { address: Hex; chainId: number; tokenIn: CircleSwapRequest['tokenIn']; tokenOut: CircleSwapRequest['tokenOut']; amount: string; slippageBps: number }): Promise<PreviewQuote>
  facts(owner: string, request: CircleSwapRequest): Promise<CircleReviewFacts>
  now(): number
}
export const MAX_FEE_MULTIPLIER = 2n
// A read-only Circle quote and the chain facts, turned into a Review the controller validates again before anything reaches a wallet.
export async function buildCircleReview(request: CircleSwapRequest, deps: CircleReviewDeps): Promise<CircleSwapReview> {
  const run = () => buildCircleReviewData(request, deps)
  return deps.performance ? deps.performance.measure('review', run) : run()
}
async function buildCircleReviewData(request: CircleSwapRequest, deps: CircleReviewDeps): Promise<CircleSwapReview> {
  const tokenIn = swapToken(request.tokenIn), tokenOut = swapToken(request.tokenOut), startedAt = deps.now()
  const measure = <T>(stage: 'quote' | 'review_facts' | 'reference', run: () => Promise<T>) => deps.performance ? deps.performance.measure(stage, run) : run()
  const quote = await measure('quote', () => deps.quote({ address: request.owner as Hex, chainId: 5042, tokenIn: request.tokenIn, tokenOut: request.tokenOut, amount: request.amount, slippageBps: request.slippageBps }))
  // Independent reads for the same request; neither uses the other's response. No cached/partial data is substituted.
  const [facts, referenceOutput] = await Promise.all([
    measure('review_facts', () => deps.facts(request.owner, request)),
    deps.reference ? measure('reference', () => deps.reference!(request)).catch(() => null) : Promise.resolve(null),
  ])
  const gas = quote.fees.filter(fee => fee.type === 'gas')
  // Circle quotes its gas estimate in USDC. When it gives none (or not for every item) the ceiling falls back to its fixed default.
  let estimatedGasFee: bigint | null = null
  if (gas.length > 0 && gas.every(fee => fee.amount !== null && fee.token === 'USDC')) estimatedGasFee = gas.reduce((sum, fee) => sum + parseUnits(fee.amount as string, 18), 0n)
  const price = (facts.baseFee !== null && facts.baseFee > facts.gasPrice ? facts.baseFee : facts.gasPrice) * MAX_FEE_MULTIPLIER
  return {
    request, amountIn: decimalUnits(request.amount, tokenIn.decimals).toString(), estimatedOutput: decimalUnits(quote.estimatedOutput, tokenOut.decimals).toString(),
    requiredMinimum: decimalUnits(quote.minimumOutput, tokenOut.decimals).toString(), networkFee: circleFeeCeiling(estimatedGasFee).toString(), maxFeePerGas: price.toString(), maxPriorityFeePerGas: '0',
    nativeBalance: facts.nativeBalance.toString(), tokenBalance: facts.tokenBalance.toString(), allowance: facts.allowance.toString(),
    fees: quote.fees.map(fee => ({ type: fee.type, token: fee.token, amount: fee.amount })), requestStartedAt: startedAt, expiresAt: Math.min(quote.expiresAt, startedAt + MAINNET_SWAP_QUOTE_TTL_MS), route: 'Circle Swap Kit router',
    ...(referenceOutput !== null ? { reference: { source: 'uniswap' as const, estimatedOutput: decimalUnits(referenceOutput, tokenOut.decimals).toString() } } : {}),
  }
}
// The independent price: what the keyless Uniswap route (the real Universal Router against the real pools, read-only) would pay for the same swap.
// It is only a market reference for the sanity check on Circle's guaranteed minimum; nothing from it is ever sent.
export async function uniswapReferenceOutput(request: CircleSwapRequest, ports = createOnchainPorts()): Promise<string> {
  const arc = validateArcRequest({ chainId: 5042, tokenIn: request.tokenIn, tokenOut: request.tokenOut, owner: request.owner, recipient: request.owner, amount: request.amount,
    minimumOutput: '1', slippageBps: request.slippageBps, maxNetworkFee: '100000000000000000' })
  const review = await createOnchainReview(arc, ports, { owner: request.owner, chainId: 5042, connected: true })
  return formatUnits(BigInt(review.estimatedOutput), swapToken(request.tokenOut).decimals)
}
export const circleReviewDeps = (): CircleReviewDeps => ({
  reference: request => uniswapReferenceOutput(request),
  quote: request => readMainnetSwapQuote(request, new AbortController().signal), facts: (owner, request) => readCircleReviewFacts(owner, swapToken(request.tokenIn)), now: () => Date.now(),
})
