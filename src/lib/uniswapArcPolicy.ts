import { decodeAbiParameters, decodeFunctionData, encodeAbiParameters, encodeFunctionData, getAddress, getCreate2Address, keccak256, parseAbi, parseAbiParameters, type Hex } from 'viem'

// Source release approved for the restricted pilot only. Execution additionally requires
// the default-off pilot configuration, pinned wallet authorization and explicit confirmation.
// Preview server flags, URL parameters and stored records cannot enable execution.
export const UNISWAP_ARC_WRITES_ENABLED = true
export const ARC_ROUTER = '0x8702463e73f74d0b6765aBceb314Ef07aCb92650'
// Observed at user fork block 27114546 and block 27119997; official nonproxy deployment 802fe4c.
export const ARC_ROUTER_HASH = '0x2e80a35dc8a1da121611acc5c31be03c2e63669135461e63947901ecf8a1654d'
export const ARC_NATIVE = '0x0000000000000000000000000000000000000000'
// Canonical Permit2 (code present on Arc Mainnet; the Universal Router pulls ERC-20 inputs through it).
export const ARC_PERMIT2 = '0x000000000022D473030F116dDEE9F6B43aC78BA3'
export const ARC_USDC = '0x3600000000000000000000000000000000000000'
// The API-sourced pilot profiles (Trading API calldata) only exist for USDC to these two outputs.
export const ARC_OUTPUTS = {
  EURC: { address: '0xbEf5f6d51CB62b58e6A8f77868681825C6fe21c1', decimals: 6 },
  cirBTC: { address: '0x171A4217b86A807A64eB94757Db6849fb4bDbAA0', decimals: 8 },
} as const
// All four Swap tokens (official Arc registry; kept equal to config/mainnetSwap.ts by the verification suite). This module has no
// relative imports on purpose: the serverless build compiles it standalone.
export const ARC_TOKENS = {
  USDC: { address: ARC_USDC, decimals: 6 },
  EURC: ARC_OUTPUTS.EURC,
  cirBTC: ARC_OUTPUTS.cirBTC,
  WETH: { address: '0x128cC466B61f542da60c70e3aA11c10e19B84EDB', decimals: 18 },
} as const
export type ArcSymbol = keyof typeof ARC_TOKENS
export const isArcSymbol = (value: unknown): value is ArcSymbol => typeof value === 'string' && Object.prototype.hasOwnProperty.call(ARC_TOKENS, value)
// Largest input per transaction in base units of the input token (about 10 USD each). Raising one is a release decision, not a setting.
export const ARC_INPUT_CAPS: Record<ArcSymbol, bigint> = { USDC: 10_000_000n, EURC: 9_000_000n, cirBTC: 12_000n, WETH: 4_000_000_000_000_000n }
// The API-sourced profiles exist only for native USDC to EURC or cirBTC.
export function legacyApiOutput(request: { tokenIn: ArcSymbol; tokenOut: ArcSymbol }): (typeof ARC_OUTPUTS)[keyof typeof ARC_OUTPUTS] {
  if (request.tokenIn !== 'USDC' || !Object.prototype.hasOwnProperty.call(ARC_OUTPUTS, request.tokenOut)) return fail('unsupported_direction')
  return ARC_OUTPUTS[request.tokenOut as keyof typeof ARC_OUTPUTS]
}
export function tokenUnits(amount: string, decimals: number): bigint {
  const [whole, fraction = ''] = amount.split('.')
  return BigInt(whole) * 10n ** BigInt(decimals) + BigInt(fraction.padEnd(decimals, '0'))
}
export const EXECUTE_ABI = parseAbi(['function execute(bytes commands, bytes[] inputs, uint256 deadline) payable'])
export const V4_ENVELOPE = parseAbiParameters('bytes actions, bytes[] params')
// Pinned periphery 3779387e5d296f39df543d23524b050f89a62917, not current main ABI.
export const V4_SINGLE = parseAbiParameters('((address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks) poolKey,bool zeroForOne,uint128 amountIn,uint128 amountOutMinimum,bytes hookData) swap')
export const CURRENCY_AMOUNT = parseAbiParameters('address currency,uint256 amount')
export const NATIVE_REFUND = parseAbiParameters('address token,address recipient,uint256 minimum')
export const V4_PATH = parseAbiParameters('(address currencyIn,(address intermediateCurrency,uint24 fee,int24 tickSpacing,address hooks,bytes hookData)[] path,uint256[] maxHopSlippage,uint128 amountIn,uint128 amountOutMinimum) swap')
export const V4_SETTLE = parseAbiParameters('address currency,uint256 amount,bool payerIsUser')
export const V4_TAKE = parseAbiParameters('address currency,address recipient,uint256 amount')
export const V3_INPUT = parseAbiParameters('address recipient,uint256 amountIn,uint256 amountOutMinimum,bytes path,bool payerIsUser,uint256[] minHopPriceX36')
const V3_FACTORY = '0xf0db7b58379503491d857db50ac9ece64c653918'
const V3_POOL_INIT_HASH = '0xe34f199b19b2b4f47f68442619d555527d244f78a3297ea89325f843f87b8b54'
const V3_POOL_KEY = parseAbiParameters('address token0,address token1,uint24 fee')
const V4_POOL_KEY = parseAbiParameters('address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks')
export const fail = (code: string): never => { throw new Error(code) }
export function sameAddress(a: unknown, b: string): boolean {
  return typeof a === 'string' && /^0x[0-9a-fA-F]{40}$/.test(a) && a.toLowerCase() === b.toLowerCase()
}
export function uint(value: unknown): bigint {
  if (typeof value !== 'string' || !/^(0|[1-9]\d{0,77})$/.test(value)) throw new Error('invalid_integer')
  const n = BigInt(value)
  if (n >= 2n ** 256n) fail('invalid_integer')
  return n
}
// Only transaction value has an explicitly supported JSON-RPC hex representation.
export function transactionValue(value: unknown): bigint {
  if (typeof value === 'string' && /^0x[0-9a-fA-F]{1,64}$/.test(value)) return BigInt(value)
  return uint(value)
}
export function usdcAmount(amount: string): bigint { return nativeAmount(amount) / 10n ** 12n }
export function minimumAtSlippage(output: bigint, bps: number): bigint {
  if (output <= 0n || !Number.isInteger(bps) || bps < 1 || bps > 100) fail('invalid_minimum_or_slippage')
  // Quantize once to the output token's indivisible base unit. Never subtract a tolerance unit.
  return output * BigInt(10000 - bps) / 10000n
}
export interface ArcRequest { chainId: 5042; tokenIn: ArcSymbol; tokenOut: ArcSymbol; owner: string; recipient: string; amount: string; minimumOutput: string; slippageBps: number; maxNetworkFee: string }
export function validateArcRequest(input: unknown): ArcRequest {
  if (!input || typeof input !== 'object') throw new Error('invalid_request')
  const r = input as ArcRequest
  const keys = ['chainId','tokenIn','tokenOut','owner','recipient','amount','minimumOutput','slippageBps','maxNetworkFee']
  if (Object.keys(r).some(k => !keys.includes(k)) || keys.some(k => !Object.prototype.hasOwnProperty.call(r, k))) fail('invalid_request')
  if (r.chainId !== 5042 || !isArcSymbol(r.tokenIn) || !isArcSymbol(r.tokenOut) || r.tokenIn === r.tokenOut) fail('unsupported_direction')
  if (!sameAddress(r.owner, r.recipient) || !sameAddress(r.owner, getAddress(r.owner)) || BigInt(r.owner) <= 2n || sameAddress(r.owner, ARC_ROUTER)) fail('invalid_recipient')
  const decimals = ARC_TOKENS[r.tokenIn].decimals
  if (typeof r.amount !== 'string' || !new RegExp(`^(0|[1-9]\\d{0,${r.tokenIn === 'USDC' ? 2 : 11}})(\\.\\d{1,${decimals}})?$`).test(r.amount)) fail('invalid_amount')
  const amount = tokenUnits(r.amount, decimals)
  if (amount <= 0n || amount > ARC_INPUT_CAPS[r.tokenIn]) fail('input_limit') // conservative per-token ceiling (USDC: 10)
  if (uint(r.minimumOutput) <= 0n || !Number.isInteger(r.slippageBps) || r.slippageBps < 1 || r.slippageBps > 100) fail('invalid_minimum_or_slippage')
  if (uint(r.maxNetworkFee) <= 0n || uint(r.maxNetworkFee) > 10n ** 17n) fail('fee_limit') // <=0.1 USDC
  return Object.freeze({ chainId: r.chainId, tokenIn: r.tokenIn, tokenOut: r.tokenOut, owner: getAddress(r.owner), recipient: getAddress(r.recipient), amount: r.amount, minimumOutput: r.minimumOutput, slippageBps: r.slippageBps, maxNetworkFee: r.maxNetworkFee })
}
export function nativeAmount(amount: string): bigint {
  const [whole, fraction = ''] = amount.split('.')
  return BigInt(whole) * 10n ** 18n + BigInt(fraction.padEnd(18, '0'))
}
export function requestKey(r: ArcRequest): string { return JSON.stringify(validateArcRequest(r)) }
export interface ArcTransaction { chainId: number; from: string; to: string; data: Hex; value: string }
function suffixForQuote(quoteId: string | undefined): string {
  if (!quoteId || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(quoteId)) throw new Error('invalid_quote_id')
  // Recorded API attribution envelope: ASCII unix + fixed 0000 + the 16-byte quote UUID.
  // It is NOT a signature, command or source-authentication proof. No other trailer is accepted.
  return `756e69780000${quoteId.replace(/-/g, '').toLowerCase()}`
}
export function decodeNativeEconomics(transaction: ArcTransaction, request: ArcRequest, requiredMinimum: bigint, quoteId?: string) {
  const r = validateArcRequest(request)
  const tx = transaction
  if (requiredMinimum <= 0n || requiredMinimum < uint(r.minimumOutput)) fail('economic_mismatch')
  if (tx.chainId !== 5042 || !sameAddress(tx.to, ARC_ROUTER) || !sameAddress(tx.from, r.owner) || transactionValue(tx.value) !== nativeAmount(r.amount)) fail('transaction_context')
  if (typeof tx.data !== 'string' || !/^0x[0-9a-fA-F]+$/.test(tx.data) || tx.data.length > 32768) fail('invalid_calldata')
  const outer = decodeFunctionData({ abi: EXECUTE_ABI, data: tx.data })
  const canonical = encodeFunctionData({ abi: EXECUTE_ABI, functionName: 'execute', args: outer.args }).toLowerCase()
  const supplied = tx.data.toLowerCase()
  if (!supplied.startsWith(canonical)) fail('noncanonical_calldata')
  const trailer = supplied.slice(canonical.length)
  if (trailer && (trailer.length !== 44 || trailer !== suffixForQuote(quoteId))) fail('unknown_calldata_suffix')
  const [commands, inputs, deadline] = outer.args
  if (!['0x1004','0x0004'].includes(commands) || inputs.length !== 2) fail('unsupported_commands')
  const [refundToken, refundRecipient, refundMinimum] = decodeAbiParameters(NATIVE_REFUND, inputs[1])
  if (encodeAbiParameters(NATIVE_REFUND, [refundToken, refundRecipient, refundMinimum]).toLowerCase() !== inputs[1].toLowerCase()) fail('noncanonical_refund')
  if (!sameAddress(refundToken, ARC_NATIVE) || !sameAddress(refundRecipient, r.recipient) || refundMinimum !== 0n) fail('refund_recipient')
  const output = legacyApiOutput(r).address
  const result = (minimum: bigint, profile: string, fee: number, tickSpacing?: number) => {
    if (minimum < requiredMinimum) fail('economic_mismatch')
    const [token0,token1] = [getAddress(ARC_USDC),getAddress(output)].sort((a,b)=>BigInt(a)<BigInt(b)?-1:1)
    const poolIdentity = profile === 'arc-usdc-v3-single-hop'
      ? getCreate2Address({ from: V3_FACTORY, salt: keccak256(encodeAbiParameters(V3_POOL_KEY,[token0,token1,fee])), bytecodeHash: V3_POOL_INIT_HASH })
      : profile === 'arc-usdc-v4-single-hop'
        ? keccak256(encodeAbiParameters(V4_POOL_KEY,[token0,token1,fee,tickSpacing!,ARC_NATIVE])) : undefined
    return { deadline: Number(deadline), minimumOutput: minimum.toString(), calldataHash: keccak256(tx.data), profile, fee, tickSpacing,
      inputToken: profile === 'native-v4-single' ? ARC_NATIVE : ARC_USDC, outputToken: output, poolIdentity, suffix: trailer ? 'unix-0000-quote-uuid' : 'none' }
  }
  if (deadline > BigInt(Number.MAX_SAFE_INTEGER)) fail('deadline')
  if (commands === '0x0004') {
    if (r.tokenOut !== 'cirBTC') fail('unsupported_direction_profile')
    const decoded = decodeAbiParameters(V3_INPUT, inputs[0])
    if (encodeAbiParameters(V3_INPUT, decoded).toLowerCase() !== inputs[0].toLowerCase()) fail('noncanonical_v3')
    const [recipient, amount, minimum, path, payerIsUser, prices] = decoded
    if (!sameAddress(recipient, r.recipient) || payerIsUser || prices.length !== 0 || amount !== usdcAmount(r.amount)) fail('v3_payment_or_amount')
    if (!/^0x[0-9a-fA-F]{86}$/.test(path) || !sameAddress(path.slice(0,42), ARC_USDC) || !sameAddress(`0x${path.slice(48)}`, output)) fail('v3_path')
    const fee = Number(BigInt(`0x${path.slice(42,48)}`))
    if (fee <= 0 || fee > 10000) fail('pool_fee')
    return result(minimum, 'arc-usdc-v3-single-hop', fee)
  }
  const [actions, params] = decodeAbiParameters(V4_ENVELOPE, inputs[0])
  if (encodeAbiParameters(V4_ENVELOPE, [actions, params]).toLowerCase() !== inputs[0].toLowerCase()) fail('noncanonical_v4')
  if (actions === '0x070b0e') {
    if (r.tokenOut !== 'EURC' || params.length !== 3) fail('unsupported_direction_profile')
    const [swap] = decodeAbiParameters(V4_PATH, params[0])
    if (encodeAbiParameters(V4_PATH, [swap]).toLowerCase() !== params[0].toLowerCase()) fail('noncanonical_swap')
    if (!sameAddress(swap.currencyIn, ARC_USDC) || swap.path.length !== 1 || swap.maxHopSlippage.length !== 0 || swap.amountIn !== usdcAmount(r.amount)) fail('v4_path_or_amount')
    const hop = swap.path[0]
    if (!sameAddress(hop.intermediateCurrency, output) || !sameAddress(hop.hooks, ARC_NATIVE) || hop.hookData !== '0x') fail('pool_or_hook')
    if (hop.fee <= 0 || hop.fee > 10000 || hop.tickSpacing < 1 || hop.tickSpacing > 200) fail('pool_fee')
    const settle = decodeAbiParameters(V4_SETTLE, params[1])
    const take = decodeAbiParameters(V4_TAKE, params[2])
    if (encodeAbiParameters(V4_SETTLE, settle).toLowerCase() !== params[1].toLowerCase() || encodeAbiParameters(V4_TAKE, take).toLowerCase() !== params[2].toLowerCase()) fail('noncanonical_settlement')
    // Pinned _mapSettleAmount/_mapTakeAmount interpret 0 as full debt/full credit.
    // payerIsUser=false forbids pulling ERC-20/Permit2 funds from the wallet.
    if (!sameAddress(settle[0], ARC_USDC) || settle[1] !== 0n || settle[2] !== false || !sameAddress(take[0], output) || !sameAddress(take[1], r.recipient) || take[2] !== 0n) fail('settlement_mismatch')
    return result(swap.amountOutMinimum, 'arc-usdc-v4-single-hop', hop.fee, hop.tickSpacing)
  }
  if (actions !== '0x060c0f' || params.length !== 3) fail('unsupported_actions')
  const [swap] = decodeAbiParameters(V4_SINGLE, params[0])
  if (encodeAbiParameters(V4_SINGLE, [swap]).toLowerCase() !== params[0].toLowerCase()) fail('noncanonical_swap')
  const pool = swap.poolKey
  if (!sameAddress(pool.currency0, ARC_NATIVE) || !sameAddress(pool.currency1, output) || !sameAddress(pool.hooks, ARC_NATIVE) || swap.hookData !== '0x' || !swap.zeroForOne) fail('pool_or_hook')
  if (!Number.isInteger(pool.fee) || pool.fee <= 0 || pool.fee > 10000 || pool.tickSpacing < 1 || pool.tickSpacing > 200) fail('pool_fee')
  if (swap.amountIn !== nativeAmount(r.amount) || swap.amountOutMinimum < requiredMinimum || requiredMinimum < uint(r.minimumOutput)) fail('economic_mismatch')
  const [currencyIn, maximum] = decodeAbiParameters(CURRENCY_AMOUNT, params[1])
  const [currencyOut, minimum] = decodeAbiParameters(CURRENCY_AMOUNT, params[2])
  if (encodeAbiParameters(CURRENCY_AMOUNT, [currencyIn, maximum]).toLowerCase() !== params[1].toLowerCase() || encodeAbiParameters(CURRENCY_AMOUNT, [currencyOut, minimum]).toLowerCase() !== params[2].toLowerCase()) fail('noncanonical_settlement')
  if (!sameAddress(currencyIn, ARC_NATIVE) || maximum !== nativeAmount(r.amount) || !sameAddress(currencyOut, output) || minimum < requiredMinimum) fail('settlement_mismatch')
  // TAKE_ALL pays msgSender() == UniversalRouter locker == verified tx.from. No recipient bytes can override it.
  return result(minimum < swap.amountOutMinimum ? minimum : swap.amountOutMinimum, 'native-v4-single', pool.fee, pool.tickSpacing)
}
export function verifyNativeCalldata(transaction: ArcTransaction, request: ArcRequest, requiredMinimum: bigint, now: number, quoteId?: string) {
  const result = decodeNativeEconomics(transaction, request, requiredMinimum, quoteId)
  if (result.deadline <= Math.floor(now / 1000) || result.deadline > Math.floor(now / 1000) + 1800) fail('deadline')
  return result
}
export interface ArcReview {
  // `source` absent or 'api': calldata from the Uniswap Trading API, decoded by the legacy profiles in this module.
  // 'onchain': calldata built locally from the pinned pool registry and quoted by an eth_call simulation (swap/swapPolicy.ts).
  source?: 'api' | 'onchain'
  route?: string
  request: ArcRequest; transaction: ArcTransaction; estimatedOutput: string; requiredMinimum: string; requestStartedAt: number; expiresAt: number
  routerHash: string; blockNumber: string; gasLimit: string; maxFeePerGas: string; maxPriorityFeePerGas: string
  networkFee: string; estimatedNetworkFee?: string; nativeBalance: string; simulation: 'passed'; executionBound: false; writesEnabled: false
  quoteId?: string
}
export function validateArcReview(review: ArcReview, context: { owner: string; chainId: number; connected: boolean }, now = Date.now()): void {
  const r = validateArcRequest(review.request)
  if (!context.connected || context.chainId !== 5042 || !sameAddress(context.owner, r.owner)) fail('wallet_context_changed')
  if (review.writesEnabled !== false || review.executionBound !== false || review.simulation !== 'passed' || review.routerHash !== ARC_ROUTER_HASH) fail('unverified_review')
  const estimated = uint(review.estimatedOutput), minimum = uint(review.requiredMinimum)
  if (minimum > estimated || minimum < minimumAtSlippage(estimated, r.slippageBps)) fail('economic_mismatch')
  if (!Number.isSafeInteger(review.requestStartedAt) || !Number.isSafeInteger(review.expiresAt) || review.expiresAt <= review.requestStartedAt || review.expiresAt > review.requestStartedAt + 30000 || now < review.requestStartedAt || now >= review.expiresAt) fail('quote_expired')
  verifyNativeCalldata(review.transaction, r, uint(review.requiredMinimum), now, review.quoteId)
  const gas = uint(review.gasLimit), price = uint(review.maxFeePerGas), tip = uint(review.maxPriorityFeePerGas)
  if (gas < 21000n || gas > 2000000n || price <= 0n || price > 100000000000n || tip > price) fail('gas_limit')
  const fee = gas * price
  if (fee !== uint(review.networkFee) || fee > uint(r.maxNetworkFee) || uint(review.nativeBalance) < nativeAmount(r.amount) + fee) fail('balance_or_fee')
}
// Legacy preview entry point stays a hard stop. Real execution requires the separately prepared,
// privately retained intent and explicit confirmation in createUniswapArcExecution.
export async function submitUniswapArcSwap(): Promise<never> { return fail('uniswap_arc_writes_disabled') }
