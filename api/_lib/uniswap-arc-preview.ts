// SERVER ONLY. Never import this module from src. Secrets and upstream JSON stay here.
import { createPublicClient, defineChain, erc20Abi, http, keccak256, type Transport } from 'viem'
import { ARC_NATIVE, ARC_USDC, ARC_ROUTER, legacyApiOutput, ARC_ROUTER_HASH, decodeNativeEconomics, fail, minimumAtSlippage, nativeAmount, usdcAmount, sameAddress, uint, validateArcRequest, validateArcReview, verifyNativeCalldata, type ArcRequest, type ArcReview, type ArcTransaction } from '../../src/lib/uniswapArcPolicy.ts'

const API = 'https://trade-api.gateway.uniswap.org/v1/quote'
const RPC = 'https://rpc.mainnet.arc.io'
const MAX_BYTES = 128 * 1024
export function assertArcReadMethod(method: string): void {
  if (!['eth_chainId','eth_blockNumber','eth_getCode','eth_getBalance','eth_call','eth_estimateGas','eth_gasPrice'].includes(method)) fail('read_only_rpc')
}
const chain = defineChain({ id: 5042, name: 'Arc Mainnet', nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 }, rpcUrls: { default: { http: [RPC] } } })
const transport: Transport = options => {
  const underlying = http(RPC, { timeout: 8000, retryCount: 0 })(options)
  return { ...underlying, request: (args, requestOptions) => {
    assertArcReadMethod(args.method)
    return underlying.request(args, requestOptions)
  } }
}
const client = createPublicClient({ chain, transport })
async function boundedJson(response: Response) {
  if (!response.ok || !response.headers.get('content-type')?.includes('application/json') || !response.body) fail('uniswap_unavailable')
  const reader = response.body!.getReader()
  const chunks: Uint8Array[] = []; let size = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.length
      if (size > MAX_BYTES) fail('upstream_too_large')
      chunks.push(value)
    }
  } finally { await reader.cancel().catch(() => undefined) }
  const joined = new Uint8Array(size); let offset = 0
  for (const chunk of chunks) { joined.set(chunk, offset); offset += chunk.length }
  return JSON.parse(new TextDecoder().decode(joined))
}
function hasFailure(value: unknown): boolean {
  return value !== undefined && value !== null && value !== '' && (!Array.isArray(value) || value.length > 0)
}
export function quoteBody(request: ArcRequest) {
  const r = validateArcRequest(request)
  return { type: 'EXACT_INPUT', amount: usdcAmount(r.amount).toString(), tokenInChainId: 5042, tokenOutChainId: 5042,
    tokenIn: ARC_USDC, tokenOut: legacyApiOutput(r).address, swapper: r.owner, recipient: r.recipient,
    protocols: r.tokenOut === 'EURC' ? ['V4'] : ['V3'], ...(r.tokenOut === 'EURC' ? { hooksOptions: 'V4_NO_HOOKS' } : {}), routingPreference: 'BEST_PRICE', slippageTolerance: r.slippageBps / 100,
    permitAmount: 'EXACT', generatePermitAsTransaction: false }
}
function inspectQuoteEconomics(raw: unknown, request: ArcRequest) {
  // Untrusted service schema; do not pass through arbitrary transactions or telemetry.
  const r = validateArcRequest(request)
  if (!raw || typeof raw !== 'object') throw new Error('invalid_quote')
  const response = raw as Record<string, any> // bounded JSON, checked below
  const q = response.quote
  if (response.routing !== 'CLASSIC' || (response.isTokenApprovalApplicable !== undefined && response.isTokenApprovalApplicable !== false) || response.permitData != null || response.permitTransaction != null || response.approval != null || !q) fail('approval_or_routing_blocked')
  for (const value of [response.txFailureReason,response.txFailureReasons,q.txFailureReason,q.txFailureReasons]) if (hasFailure(value)) fail('simulation_failed')
  const erc20 = sameAddress(q.input?.token, ARC_USDC)
  const expectedInput = erc20 ? usdcAmount(r.amount) : nativeAmount(r.amount)
  if (q.chainId !== 5042 || !sameAddress(q.swapper, r.owner) || (!erc20 && !sameAddress(q.input?.token, ARC_NATIVE)) || uint(q.input?.amount) !== expectedInput || !sameAddress(q.output?.token, legacyApiOutput(r).address)) fail('quote_context')
  if ((q.tradeType !== undefined && q.tradeType !== 'EXACT_INPUT') || (erc20 && (q.tradeType !== 'EXACT_INPUT' || uint(q.input.maximumAmount) !== expectedInput))) fail('quote_trade_type')
  if (q.output.recipient !== undefined && !sameAddress(q.output.recipient, r.recipient)) fail('quote_recipient')
  if ((q.portionBips !== undefined && uint(String(q.portionBips)) !== 0n) || (q.portionAmount !== undefined && uint(q.portionAmount) !== 0n)) fail('unsupported_fee_or_split')
  const estimated = uint(q.output.amount)
  let required = minimumAtSlippage(estimated, r.slippageBps)
  if (q.slippage !== undefined) {
    if (typeof q.slippage !== 'number' || !Number.isFinite(q.slippage)) fail('invalid_slippage')
    const bps = Math.round(q.slippage * 100)
    if (Math.abs(bps / 100 - q.slippage) > 1e-12 || bps > r.slippageBps) fail('invalid_slippage')
    const quotedFloor = minimumAtSlippage(estimated, bps)
    if (quotedFloor > required) required = quotedFloor
  }
  if (erc20 || q.output.minimumAmount !== undefined) {
    const apiMinimum = uint(q.output.minimumAmount)
    if (apiMinimum < required || apiMinimum > estimated) fail('invalid_api_minimum')
    required = apiMinimum
  }
  const minimum = required > uint(r.minimumOutput) ? required : uint(r.minimumOutput)
  if (estimated <= 0n || minimum > estimated) fail('invalid_output')
  if (erc20 || q.aggregatedOutputs !== undefined) {
    if (!Array.isArray(q.aggregatedOutputs) || q.aggregatedOutputs.length !== 1) fail('unsupported_fee_or_split')
    const aggregated = q.aggregatedOutputs[0]
    if (!aggregated || !sameAddress(aggregated.token, legacyApiOutput(r).address) || !sameAddress(aggregated.recipient, r.recipient) || aggregated.bps !== 10000 || uint(aggregated.amount) !== estimated || uint(aggregated.minAmount) !== uint(q.output.minimumAmount) || (aggregated.fee !== undefined && uint(String(aggregated.fee)) !== 0n)) fail('aggregated_output_mismatch')
    if (Object.keys(aggregated).some(k => !['token','recipient','bps','amount','minAmount','fee'].includes(k))) fail('unsupported_aggregated_field')
  }
  const rawTx = response.swapTransaction
  if (!rawTx || typeof rawTx !== 'object') fail('prepared_transaction_missing')
  if (rawTx.authorizationList !== undefined || rawTx.accessList !== undefined || rawTx.blobs !== undefined || rawTx.kzg !== undefined) fail('unexpected_transaction_fields')
  const tx: ArcTransaction = { chainId: rawTx.chainId, from: rawTx.from, to: rawTx.to, data: rawTx.data, value: rawTx.value }
  const quoteId = typeof q.quoteId === 'string' ? q.quoteId : undefined
  const economics = decodeNativeEconomics(tx, r, minimum, quoteId)
  if (!sameAddress(economics.inputToken, q.input.token)) fail('route_input_encoding_mismatch')
  if (erc20) {
    if (!Array.isArray(q.route) || q.route.length !== 1 || !Array.isArray(q.route[0]) || q.route[0].length !== 1) fail('unsupported_route_graph')
    const pool = q.route[0][0]
    const expectedType = economics.profile === 'arc-usdc-v4-single-hop' ? 'v4-pool' : 'v3-pool'
    if (typeof pool.address !== 'string' || pool.address.toLowerCase() !== economics.poolIdentity?.toLowerCase()) fail('pool_identity_mismatch')
    if (pool.type !== expectedType || !sameAddress(pool.tokenIn?.address, ARC_USDC) || !sameAddress(pool.tokenOut?.address, legacyApiOutput(r).address) || pool.tokenIn.chainId !== 5042 || pool.tokenOut.chainId !== 5042 || String(pool.tokenIn.decimals) !== '6' || String(pool.tokenOut.decimals) !== String(legacyApiOutput(r).decimals) || uint(pool.amountIn) !== expectedInput || uint(pool.amountOut) !== estimated || uint(pool.fee) !== BigInt(economics.fee)) fail('route_metadata_mismatch')
    if (expectedType === 'v4-pool' && (!sameAddress(pool.hooks, ARC_NATIVE) || uint(pool.tickSpacing) !== BigInt(economics.tickSpacing!))) fail('route_hook_or_tick')
  }
  return { transaction: tx, estimatedOutput: estimated.toString(), requiredMinimum: minimum.toString(), economics, quoteId }
}
// Archive-only result is intentionally NOT an ArcReview and can never authorize a live operation.
// Missing capture fields remain unknown; no permission flag or timestamp is manufactured.
export function inspectCapturedArcQuote(raw: unknown, request: ArcRequest, now = Date.now()) {
  const result = inspectQuoteEconomics(raw, request)
  return { ...result, evidenceStatus: 'ECONOMICS_VERIFIED_ARCHIVE' as const, expired: result.economics.deadline * 1000 <= now,
    permissionEvidence: 'REQUIRES_FRESH_LIVE_RESPONSE' as const, liveEligible: false as const, writesEnabled: false as const, executionBound: false as const }
}
export function parsePreparedQuote(raw: unknown, request: ArcRequest, now: number) {
  if (!raw || typeof raw !== 'object') throw new Error('invalid_quote')
  const response = raw as Record<string, unknown>
  if (response.isTokenApprovalApplicable !== false || response.permitData !== null) fail('approval_evidence_missing_or_required')
  const result = inspectQuoteEconomics(raw, request)
  verifyNativeCalldata(result.transaction, request, uint(result.requiredMinimum), now, result.quoteId)
  return result
}
// Injected ports are a test seam, never selected by HTTP requests. No signing port exists.
export function createArcPreviewService(ports = { fetch: globalThis.fetch, client, now: Date.now }) {
  let pending = 0
  return async (input: unknown, apiKey: string): Promise<ArcReview> => {
    const request = validateArcRequest(input)
    if (!apiKey) fail('uniswap_api_key_missing')
    if (pending >= 2) fail('preview_busy')
    pending++
    const requestStartedAt = ports.now()
    const abort = new AbortController()
    const timer = setTimeout(() => abort.abort(), 20000)
    try {
      if (await ports.client.getChainId() !== 5042) fail('wrong_rpc_chain')
      const blockNumber = await ports.client.getBlockNumber({ cacheTime: 0 })
      const output = legacyApiOutput(request)
      const [code, tokenCode, decimals, nativeBalance, gasPrice] = await Promise.all([
        ports.client.getCode({ address: ARC_ROUTER, blockNumber }),
        ports.client.getCode({ address: output.address, blockNumber }),
        ports.client.readContract({ address: output.address, abi: erc20Abi, functionName: 'decimals', blockNumber }),
        ports.client.getBalance({ address: request.owner as `0x${string}`, blockNumber }), ports.client.getGasPrice(),
      ])
      if (!code || code === '0x' || keccak256(code) !== ARC_ROUTER_HASH) fail('router_code_mismatch')
      if (!tokenCode || tokenCode === '0x' || decimals !== output.decimals) fail('output_contract_mismatch')
      if (nativeBalance < nativeAmount(request.amount) || gasPrice <= 0n || gasPrice > 50000000000n) fail('balance_or_gas_price')
      const response = await ports.fetch(API, { method: 'POST', redirect: 'error', signal: abort.signal,
        headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'x-universal-router-version': '2.1.2', 'x-permit2-disabled': 'false' }, body: JSON.stringify(quoteBody(request)) })
      const prepared = parsePreparedQuote(await boundedJson(response), request, ports.now())
      const tx = prepared.transaction
      const call = { account: request.owner as `0x${string}`, to: ARC_ROUTER, data: tx.data, value: nativeAmount(request.amount) } as const
      // Simulate the exact API transaction; no state overrides, fake balance or approvals.
      await ports.client.call({ ...call, blockNumber })
      const estimatedGas = await ports.client.estimateGas({ ...call, blockNumber })
      const gasLimit = (estimatedGas * 130n + 99n) / 100n
      const maxFeePerGas = gasPrice * 2n
      const review: ArcReview = { request, transaction: tx, estimatedOutput: prepared.estimatedOutput, requiredMinimum: prepared.requiredMinimum, requestStartedAt,
        expiresAt: Math.min(requestStartedAt + 30000, prepared.economics.deadline * 1000), routerHash: ARC_ROUTER_HASH,
        blockNumber: blockNumber.toString(), gasLimit: gasLimit.toString(), maxFeePerGas: maxFeePerGas.toString(), maxPriorityFeePerGas: '0',
        networkFee: (gasLimit * maxFeePerGas).toString(), nativeBalance: nativeBalance.toString(), simulation: 'passed', executionBound: false, writesEnabled: false, quoteId: prepared.quoteId }
      validateArcReview(review, { owner: request.owner, chainId: 5042, connected: true }, ports.now())
      if (abort.signal.aborted || ports.now() - requestStartedAt >= 20000) fail('preview_timeout')
      return review
    } finally { clearTimeout(timer); pending-- }
  }
}
export const prepareArcPreview = createArcPreviewService()
