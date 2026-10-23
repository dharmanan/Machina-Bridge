import { createPublicClient, defineChain, erc20Abi, http, type Transport } from 'viem'
import { ViemAdapter } from '@circle-fin/adapter-viem-v2'
import { SwapKit, getChainByEnum } from '@circle-fin/swap-kit'
import {
  MAINNET_SWAP_CHAIN_ID, MAINNET_SWAP_RPC, MAINNET_SWAP_TOKENS,
  MAINNET_SWAP_READ_ONLY_ENABLED, MAINNET_SWAP_WRITES_ENABLED,
  MAINNET_SWAP_QUOTE_TTL_MS, MAINNET_SWAP_TIMEOUT_MS, MAINNET_SWAP_SLIPPAGE_BPS,
  type MainnetSwapToken,
} from '../config/mainnetSwap'

export interface SwapQuoteRequest {
  address: `0x${string}`
  chainId: number
  tokenIn: MainnetSwapToken
  tokenOut: MainnetSwapToken
  amount: string
  slippageBps: number
}
export interface PreviewQuote {
  requestKey: string
  estimatedOutput: string
  minimumOutput: string
  receivedAt: number
  expiresAt: number
  fees: { type: 'provider' | 'swap' | 'gas' | 'developer'; token: MainnetSwapToken; amount: string | null }[]
}
const addressPattern = /^0x[0-9a-fA-F]{40}$/
const fail = (code: string): never => { throw new Error(code) }
export function decimalUnits(value: unknown, decimals: number): bigint {
  if (typeof value !== 'string' || value.length > 70 || !/^(0|[1-9]\d{0,29})(\.\d+)?$/.test(value)) return fail('invalid_amount')
  const [whole, fraction = ''] = value.split('.')
  if (fraction.length > decimals) return fail('invalid_amount')
  return BigInt(whole + fraction.padEnd(decimals, '0'))
}
export function validateSwapRequest(request: SwapQuoteRequest): void {
  if (!MAINNET_SWAP_READ_ONLY_ENABLED || MAINNET_SWAP_WRITES_ENABLED) fail('read_only_gate')
  if (!addressPattern.test(request.address) || /^0x0{40}$/i.test(request.address)) fail('wallet_required')
  if (request.chainId !== MAINNET_SWAP_CHAIN_ID) fail('wrong_network')
  if (!Object.prototype.hasOwnProperty.call(MAINNET_SWAP_TOKENS, request.tokenIn) || !Object.prototype.hasOwnProperty.call(MAINNET_SWAP_TOKENS, request.tokenOut)) fail('unsupported_token')
  // Circle's service quotes every ordered pair of the four Arc tokens (verified live for all 12 directions); an identical pair is not a swap.
  if (request.tokenIn === request.tokenOut) fail('unsupported_route')
  if (!(MAINNET_SWAP_SLIPPAGE_BPS as readonly number[]).includes(request.slippageBps)) fail('invalid_slippage')
  if (decimalUnits(request.amount, MAINNET_SWAP_TOKENS[request.tokenIn].decimals) <= 0n) fail('invalid_amount')
}
export function swapRequestKey(request: SwapQuoteRequest): string {
  return [request.address.toLowerCase(), request.chainId, request.tokenIn, request.tokenOut, request.amount, request.slippageBps].join(':')
}
function matchesToken(value: unknown, token: MainnetSwapToken): boolean {
  return typeof value === 'string' && (value.toLowerCase() === token.toLowerCase() || value.toLowerCase() === MAINNET_SWAP_TOKENS[token].address.toLowerCase())
}
export function normalizeSwapQuote(raw: unknown, request: SwapQuoteRequest, receivedAt: number, requestedAt = receivedAt): PreviewQuote {
  validateSwapRequest(request)
  const data = raw as Record<string, any> | null
  if (!data) return fail('invalid_quote')
  if (data.chainIn !== 'Arc' || data.chainOut !== 'Arc' || data.chain !== 'Arc'
      || !matchesToken(data.tokenIn, request.tokenIn) || !matchesToken(data.tokenOut, request.tokenOut)
      || typeof data.fromAddress !== 'string' || data.fromAddress.toLowerCase() !== request.address.toLowerCase()
      || typeof data.toAddress !== 'string' || data.toAddress.toLowerCase() !== request.address.toLowerCase()
      || decimalUnits(data.amountIn, MAINNET_SWAP_TOKENS[request.tokenIn].decimals) !== decimalUnits(request.amount, MAINNET_SWAP_TOKENS[request.tokenIn].decimals)
      || !matchesToken(data.estimatedOutput?.token, request.tokenOut) || !matchesToken(data.stopLimit?.token, request.tokenOut)) fail('invalid_quote')
  const estimated = decimalUnits(data.estimatedOutput.amount, MAINNET_SWAP_TOKENS[request.tokenOut].decimals)
  const minimum = decimalUnits(data.stopLimit.amount, MAINNET_SWAP_TOKENS[request.tokenOut].decimals)
  if (estimated <= 0n || minimum <= 0n || minimum > estimated || minimum < estimated * BigInt(10_000 - request.slippageBps) / 10_000n) fail('invalid_quote')
  if (!Number.isSafeInteger(receivedAt) || receivedAt < requestedAt || receivedAt >= requestedAt + MAINNET_SWAP_QUOTE_TTL_MS) fail('quote_expired')
  if (data.fees !== undefined && (!Array.isArray(data.fees) || data.fees.length > 16)) fail('invalid_quote')
  const fees = (data.fees ?? []).map((fee: any) => {
    if (!fee || !['provider', 'swap', 'gas', 'developer'].includes(fee.type)) return fail('invalid_quote')
    const token = (Object.keys(MAINNET_SWAP_TOKENS) as MainnetSwapToken[]).find((symbol) => matchesToken(fee.token, symbol))
    if (!token || (fee.type === 'gas' && token !== 'USDC')) return fail('invalid_quote')
    if (fee.amount !== null) decimalUnits(fee.amount, fee.type === 'gas' ? 18 : MAINNET_SWAP_TOKENS[token].decimals)
    // Swap Kit can emit gas=0 when the service supplied no gas limit. It is not proof of free gas.
    return { type: fee.type, token, amount: fee.type === 'gas' && fee.amount !== null && decimalUnits(fee.amount, 18) === 0n ? null : fee.amount }
  })
  return {
    requestKey: swapRequestKey(request), estimatedOutput: data.estimatedOutput.amount,
    minimumOutput: data.stopLimit.amount, fees, receivedAt, expiresAt: requestedAt + MAINNET_SWAP_QUOTE_TTL_MS,
  }
}
export function hasInsufficientSwapBalance(amount: string, token: MainnetSwapToken, balance: bigint | undefined): boolean {
  return balance !== undefined && decimalUnits(amount, MAINNET_SWAP_TOKENS[token].decimals) > balance
}
export function swapWalletState(connected: boolean, chainId?: number): 'disconnected' | 'wrong_network' | 'ready' {
  return !connected ? 'disconnected' : chainId !== MAINNET_SWAP_CHAIN_ID ? 'wrong_network' : 'ready'
}
export function isCurrentSwapQuote(quote: PreviewQuote | null, request: SwapQuoteRequest | null, now: number): boolean {
  return Boolean(quote && request && quote.requestKey === swapRequestKey(request) && now < quote.expiresAt)
}
export const CIRCLE_NO_ROUTE_MESSAGE = 'Circle cannot provide a quote for this amount. No route with available liquidity right now; try another amount or Uniswap.'
export function swapPreviewError(error: unknown): string {
  const code = error instanceof Error ? error.message : ''
  if (/timeout/i.test(code)) return 'The quote request timed out. Try again shortly.'
  if (/quote_busy/.test(code)) return 'The previous quote request is still finishing. Try again shortly.'
  if (/expired/.test(code)) return 'The quote is no longer fresh. Request a new quote.'
  if (/wrong_network/.test(code)) return 'Select Arc Mainnet in your wallet to request a quote.'
  // The pair is supported, but Circle has no route at quote time for this amount (SDK code 1003).
  if (/no route available/i.test(code)) return CIRCLE_NO_ROUTE_MESSAGE
  if (/insufficient swap amount/i.test(code)) return 'Circle cannot quote such a small amount. Increase it within the swap limit.'
  if (/liquidity|route|not supported|unsupported/i.test(code)) return 'No supported quote is available for this direction. Try another pair.'
  if (/invalid_amount/.test(code)) return 'Enter a positive amount within the token precision.'
  return 'A verified quote could not be loaded. Try again shortly.'
}

const readMethods = new Set(['eth_chainId', 'eth_call', 'eth_gasPrice', 'eth_getBalance', 'eth_getCode', 'eth_blockNumber', 'eth_getBlockByNumber', 'eth_feeHistory', 'eth_maxPriorityFeePerGas', 'eth_estimateGas'])
export function assertSwapReadMethod(method: string): void {
  if (!readMethods.has(method)) fail('read_only_method')
}
export function createSwapReadAdapter() {
  const arc = getChainByEnum('Arc')
  if (arc.type !== 'evm' || arc.chainId !== MAINNET_SWAP_CHAIN_ID || arc.isTestnet) fail('unsupported_chain')
  const chain = defineChain({ id: MAINNET_SWAP_CHAIN_ID, name: 'Arc', nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 }, rpcUrls: { default: { http: [MAINNET_SWAP_RPC] } } })
  const transport: Transport = (options) => {
    const underlying = http(MAINNET_SWAP_RPC, { timeout: 8_000, retryCount: 0 })(options)
    return { ...underlying, request: (args, requestOptions) => {
      assertSwapReadMethod(args.method)
      return underlying.request(args, requestOptions)
    } }
  }
  const client = createPublicClient({ chain, transport })
  const adapter = new ViemAdapter({
    getPublicClient: ({ chain: requestedChain }) => {
      if (requestedChain.id !== MAINNET_SWAP_CHAIN_ID) fail('unsupported_chain')
      return client
    },
    getWalletClient: () => fail('read_only_wallet'),
  }, {
    // SDK explicit-address mode, NOT a signing account. Only the connected public address is supplied.
    addressContext: 'developer-controlled', supportedChains: [arc],
  })
  const verifiedDecimals = new Map<string, number>()
  const allowed = new Set(['capabilities', 'validateChainSupport', 'getTokenDecimals', 'calculateTransactionFee'])
  return new Proxy(adapter, {
    get(target, property) {
      // SDK schema requires these function shapes even for estimate-only calls.
      // They are deny stubs, never the underlying adapter's execution methods.
      if (['prepare', 'waitForTransaction', 'getAddress'].includes(String(property))) return () => fail('read_only_adapter')
      if (property === 'then' || property === 'catch' || typeof property === 'symbol') return undefined
      if (typeof property !== 'string' || !allowed.has(property)) return fail('read_only_adapter')
      if (property === 'getTokenDecimals') return async (address: string, requestedChain: typeof arc) => {
        if (requestedChain.type !== 'evm' || requestedChain.chainId !== MAINNET_SWAP_CHAIN_ID) return fail('unsupported_chain')
        const token = Object.values(MAINNET_SWAP_TOKENS).find((entry) => entry.address.toLowerCase() === address.toLowerCase())
        if (!token) return fail('unsupported_token')
        const key = address.toLowerCase()
        const cached = verifiedDecimals.get(key)
        if (cached !== undefined) return cached
        if (await client.getChainId() !== MAINNET_SWAP_CHAIN_ID) return fail('wrong_network')
        const decimals = await client.readContract({ address: token.address, abi: erc20Abi, functionName: 'decimals' })
        if (decimals !== token.decimals) return fail('token_decimals_mismatch')
        verifiedDecimals.set(key, decimals)
        return decimals
      }
      const value = Reflect.get(target, property)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
}

// The SDK has no estimate AbortSignal. Keep the in-flight slot until it actually settles,
// even after our UI deadline/abort, so retries cannot accumulate unbounded provider requests.
export function createSwapQuoteReader(estimate: (request: SwapQuoteRequest) => Promise<unknown>, timeoutMs = MAINNET_SWAP_TIMEOUT_MS) {
  let pending: { released: boolean } | null = null
  return async (request: SwapQuoteRequest, signal: AbortSignal): Promise<PreviewQuote> => {
    validateSwapRequest(request)
    if (signal.aborted) return fail('quote_cancelled')
    const requestedAt = Date.now()
    const budgetStarted = performance.now()
    // The SDK cannot abort its HTTP operation. An obsolete consumer releases its UI, NOT its SDK slot.
    // Wait locally for that one slot, with the same deadline; never retry the service or stack SDK calls.
    // Polling owns only a short timer, so cancelled edits cannot accumulate callbacks on a hung SDK promise.
    while (pending?.released) {
      if (signal.aborted) return fail('quote_cancelled')
      if (performance.now() - budgetStarted >= timeoutMs) return fail('quote_timeout')
      await new Promise(resolve => setTimeout(resolve, Math.min(25, timeoutMs)))
    }
    if (signal.aborted) return fail('quote_cancelled')
    if (pending) return fail('quote_busy')
    if (performance.now() - budgetStarted >= timeoutMs) return fail('quote_timeout')
    const slot = { released: false }
    pending = slot
    let timer: ReturnType<typeof setTimeout> | undefined
    let abort: () => void = () => undefined
    const operation = Promise.resolve().then(() => estimate(request)).finally(() => { if (pending === slot) pending = null })
    try {
      const raw = await Promise.race([operation, new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('quote_timeout')), Math.max(1, timeoutMs - (performance.now() - budgetStarted)))
        abort = () => reject(new Error('quote_cancelled'))
        signal.addEventListener('abort', abort, { once: true })
        if (signal.aborted) abort()
      })])
      if (signal.aborted) return fail('quote_cancelled')
      return normalizeSwapQuote(raw, request, Date.now(), requestedAt)
    } finally {
      slot.released = true
      clearTimeout(timer)
      signal.removeEventListener('abort', abort)
    }
  }
}
let reader: ReturnType<typeof createSwapQuoteReader> | undefined
export function readMainnetSwapQuote(request: SwapQuoteRequest, signal: AbortSignal): Promise<PreviewQuote> {
  if (!reader) {
    const kit = new SwapKit({ disableAnalytics: true, disableErrorReporting: true })
    const adapter = createSwapReadAdapter()
    reader = createSwapQuoteReader(async (input) => {
      // Prevent the SDK's raw-unit fallback when a token decimals lookup fails.
      const arc = getChainByEnum('Arc')
      if (arc.type !== 'evm' || arc.chainId !== MAINNET_SWAP_CHAIN_ID) return fail('unsupported_chain')
      await adapter.getTokenDecimals(MAINNET_SWAP_TOKENS[input.tokenIn].address, arc)
      await adapter.getTokenDecimals(MAINNET_SWAP_TOKENS[input.tokenOut].address, arc)
      return kit.estimate({
      from: { adapter, chain: 'Arc', address: input.address },
      tokenIn: MAINNET_SWAP_TOKENS[input.tokenIn].address,
      tokenOut: MAINNET_SWAP_TOKENS[input.tokenOut].address,
      amountIn: input.amount,
      config: { slippageBps: input.slippageBps },
      })
    })
  }
  return reader(request, signal)
}
