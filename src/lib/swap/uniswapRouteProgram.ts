import { decodeAbiParameters, decodeFunctionData, encodeAbiParameters, encodeFunctionData, keccak256, type Hex } from 'viem'
import {
  ARC_NATIVE, ARC_ROUTER, ARC_TOKENS, EXECUTE_ABI, NATIVE_REFUND, V3_INPUT, fail, nativeAmount, sameAddress, tokenUnits, transactionValue, uint, validateArcRequest,
  type ArcRequest, type ArcSymbol, type ArcTransaction,
} from '../uniswapArcPolicy'
import { decodeV3Path } from './universalRouter'
import { routeId, routeIsRegistered, describeRoute, type UniswapRoute, type V3Hop } from './uniswapPools'

// Locally built Universal Router programs for exact-input swaps over the pinned V3 pool registry, and the strict decoder that accepts
// exactly those programs and nothing else. One shape per input kind:
//   native USDC in : execute(0x0004, [V3_SWAP_EXACT_IN(payerIsUser=false), SWEEP(native -> owner, 0)])   value = amount
//   ERC-20 in      : execute(0x00,   [V3_SWAP_EXACT_IN(payerIsUser=true)])                                 value = 0, pulled through Permit2
// The recipient is always the owner, the path always starts at the input token and ends at the output token over registered pools,
// no fee portion, no suffix, no hop price bound. A program that is not byte-for-byte canonical for these rules is refused.

export const ROUTE_PROFILE = 'arc-v3-route'
export interface RouteProgramInput { request: ArcRequest; route: UniswapRoute; minimumOutput: bigint; deadline: bigint; recipient?: Hex }
export const routeTransactionValue = (request: ArcRequest): bigint => (request.tokenIn === 'USDC' ? nativeAmount(request.amount) : 0n)
const inputUnits = (request: ArcRequest) => tokenUnits(request.amount, ARC_TOKENS[request.tokenIn].decimals)

function encodePath(route: { hops: readonly V3Hop[] }): Hex {
  const tokens = [route.hops[0].tokenIn, ...route.hops.map(hop => hop.tokenOut)]
  return `0x${tokens.map((symbol, i) => ARC_TOKENS[symbol].address.slice(2) + (i < route.hops.length ? route.hops[i].fee.toString(16).padStart(6, '0') : '')).join('')}` as Hex
}
export function buildRouteCalldata(input: RouteProgramInput): Hex {
  const request = validateArcRequest(input.request)
  if (!routeIsRegistered(input.route) || input.route.hops[0].tokenIn !== request.tokenIn || input.route.hops[input.route.hops.length - 1].tokenOut !== request.tokenOut) fail('route_not_registered')
  if (input.minimumOutput <= 0n) fail('invalid_minimum_or_slippage')
  const nativeIn = request.tokenIn === 'USDC'
  const recipient = input.recipient ?? (request.recipient as Hex)
  const swap = encodeAbiParameters(V3_INPUT, [recipient, inputUnits(request), input.minimumOutput, encodePath(input.route), !nativeIn, []])
  const inputs = nativeIn ? [swap, encodeAbiParameters(NATIVE_REFUND, [ARC_NATIVE, recipient, 0n])] : [swap]
  return encodeFunctionData({ abi: EXECUTE_ABI, functionName: 'execute', args: [nativeIn ? '0x0004' : '0x00', inputs, input.deadline] })
}

export interface RouteEconomics {
  profile: typeof ROUTE_PROFILE; deadline: number; minimumOutput: string; calldataHash: Hex; route: UniswapRoute; routeText: string
  inputToken: Hex; outputToken: Hex; nativeInput: boolean; suffix: 'none'
}
export function decodeRouteProgram(transaction: ArcTransaction, requestInput: ArcRequest, requiredMinimum: bigint): RouteEconomics {
  const r = validateArcRequest(requestInput), nativeIn = r.tokenIn === 'USDC'
  if (requiredMinimum <= 0n || requiredMinimum < uint(r.minimumOutput)) fail('economic_mismatch')
  if (transaction.chainId !== 5042 || !sameAddress(transaction.to, ARC_ROUTER) || !sameAddress(transaction.from, r.owner) || transactionValue(transaction.value) !== routeTransactionValue(r)) fail('transaction_context')
  if (typeof transaction.data !== 'string' || !/^0x[0-9a-fA-F]+$/.test(transaction.data) || transaction.data.length > 8192) fail('invalid_calldata')
  const outer = decodeFunctionData({ abi: EXECUTE_ABI, data: transaction.data })
  const canonical = encodeFunctionData({ abi: EXECUTE_ABI, functionName: 'execute', args: outer.args })
  if (transaction.data.toLowerCase() !== canonical.toLowerCase()) fail(transaction.data.toLowerCase().startsWith(canonical.toLowerCase()) ? 'unknown_calldata_suffix' : 'noncanonical_calldata')
  const [commands, inputs, deadline] = outer.args
  if (commands !== (nativeIn ? '0x0004' : '0x00') || inputs.length !== (nativeIn ? 2 : 1)) fail('unsupported_commands')
  const decoded = decodeAbiParameters(V3_INPUT, inputs[0])
  if (encodeAbiParameters(V3_INPUT, decoded).toLowerCase() !== inputs[0].toLowerCase()) fail('noncanonical_v3')
  const [recipient, amountIn, minimum, path, payerIsUser, prices] = decoded
  if (!sameAddress(recipient, r.recipient) || payerIsUser !== !nativeIn || prices.length !== 0 || amountIn !== inputUnits(r)) fail('v3_payment_or_amount')
  const parsed = decodeV3Path(path)
  if (!parsed || parsed.fees.length < 1 || parsed.fees.length > 2) fail('v3_path')
  const symbols = parsed!.tokens.map(token => (Object.keys(ARC_TOKENS) as ArcSymbol[]).find(symbol => sameAddress(token, ARC_TOKENS[symbol].address)))
  if (symbols.some(symbol => symbol === undefined) || symbols[0] !== r.tokenIn || symbols[symbols.length - 1] !== r.tokenOut || new Set(symbols).size !== symbols.length) fail('v3_path')
  const hops: V3Hop[] = parsed!.fees.map((fee, i) => ({ tokenIn: symbols[i] as ArcSymbol, tokenOut: symbols[i + 1] as ArcSymbol, fee }))
  const route: UniswapRoute = { id: routeId(hops), kind: 'v3', hops }
  if (!routeIsRegistered(route)) fail('route_not_registered')
  if (minimum < requiredMinimum) fail('economic_mismatch')
  if (nativeIn) {
    const [token, refundRecipient, refundMinimum] = decodeAbiParameters(NATIVE_REFUND, inputs[1])
    if (encodeAbiParameters(NATIVE_REFUND, [token, refundRecipient, refundMinimum]).toLowerCase() !== inputs[1].toLowerCase()) fail('noncanonical_refund')
    if (!sameAddress(token, ARC_NATIVE) || !sameAddress(refundRecipient, r.recipient) || refundMinimum !== 0n) fail('refund_recipient')
  }
  if (deadline > BigInt(Number.MAX_SAFE_INTEGER)) fail('deadline')
  return { profile: ROUTE_PROFILE, deadline: Number(deadline), minimumOutput: minimum.toString(), calldataHash: keccak256(transaction.data), route, routeText: describeRoute(route),
    inputToken: ARC_TOKENS[r.tokenIn].address, outputToken: ARC_TOKENS[r.tokenOut].address, nativeInput: nativeIn, suffix: 'none' }
}
export function verifyRouteCalldata(transaction: ArcTransaction, request: ArcRequest, requiredMinimum: bigint, now: number): RouteEconomics {
  const result = decodeRouteProgram(transaction, request, requiredMinimum)
  if (result.deadline <= Math.floor(now / 1000) || result.deadline > Math.floor(now / 1000) + 1800) fail('deadline')
  return result
}
