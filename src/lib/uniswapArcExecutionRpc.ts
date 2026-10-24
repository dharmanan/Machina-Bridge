import { existingAllowanceNotice, attachPermit, permitMessage, PERMIT_DOMAIN, PERMIT_SINGLE_TYPES, validatePermitCalldata } from './swap/permitSingle'
import { createPublicClient, defineChain, erc20Abi, http, keccak256, parseAbi, type Hex, type Transport } from 'viem'
import { ARC_PERMIT2, ARC_ROUTER, ARC_ROUTER_HASH, ARC_TOKENS, sameAddress, tokenUnits, uint, type ArcReview } from './uniswapArcPolicy'
import { reviewValue } from './swap/swapPolicy'
import { ExecutionNonceObservationError, ExecutionVerificationError, executionDeadlineMs, executionTransaction, type ExecutionProvider, type ChainResult, type SwapAttempt } from './uniswapArcExecution'
import { compareToReview, ownerFlows, summarizeIntent, type IntentSummary, type ChainLog, type ChainReceipt, type ChainTx, type ReviewedIntent } from './swap/transactionEvidence'

const RPC = 'https://rpc.mainnet.arc.io'
const chain = defineChain({ id: 5042, name: 'Arc Mainnet', nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 }, rpcUrls: { default: { http: [RPC] } } })
export function assertExecutionReadMethod(method: string) {
  if (!['eth_chainId', 'eth_blockNumber', 'eth_getCode', 'eth_getBalance', 'eth_call', 'eth_estimateGas', 'eth_gasPrice',
    'eth_getTransactionCount', 'eth_getTransactionByHash', 'eth_getTransactionReceipt', 'eth_getBlockByNumber'].includes(method)) throw new Error('read_only_rpc')
}
const transport: Transport = options => {
  const underlying = http(RPC, { timeout: 8000, retryCount: 0 })(options)
  // Both the client's request and the transport's own request are guarded; nothing reaches the network layer without the read-only check.
  const guarded: typeof underlying.request = (args, requestOptions) => { assertExecutionReadMethod(args.method); return underlying.request(args, requestOptions) }
  const rawGuarded = (args: { method: string; params?: unknown }) => { assertExecutionReadMethod(args.method); return underlying.config.request(args as never) }
  return { ...underlying, config: { ...underlying.config, request: rawGuarded as never }, request: guarded }
}
const client = createPublicClient({ chain, transport, ccipRead: false, cacheTime: 0 })
// The one read-only Arc client (guarded to read methods only), shared with the keyless Uniswap quote adapter.
export const arcReadClient = client
const hash = (value: unknown): value is Hex => typeof value === 'string' && /^0x[a-f0-9]{64}$/i.test(value)
const reject = (): never => { throw new Error('verification') }
const PERMIT2_ABI = parseAbi(['function allowance(address owner, address token, address spender) view returns (uint160 amount, uint48 expiration, uint48 nonce)'])
const transferTopic = keccak256(new TextEncoder().encode('Transfer(address,address,uint256)'))

// The injectable client is a test seam; production uses only the pinned, read-only Arc RPC.
export function createArcExecutionRpc(rpc = client) {
  async function preflight(review: ArcReview, signedData?: Hex) {
    const r = review.request, account = r.owner as Hex, output = ARC_TOKENS[r.tokenOut], input = ARC_TOKENS[r.tokenIn], value = reviewValue(review), erc20Input = r.tokenIn !== 'USDC'
    const needed = tokenUnits(r.amount, input.decimals), fee = uint(review.networkFee)
    if (await rpc.getChainId() !== 5042) reject()
    const blockNumber = await rpc.getBlockNumber({ cacheTime: 0 })
    const [block, code, tokenCode, walletCode, decimals, balance, pendingBalance, price] = await Promise.all([
      rpc.getBlock({ blockNumber }), rpc.getCode({ address: ARC_ROUTER, blockNumber }), rpc.getCode({ address: output.address, blockNumber }),
      rpc.getCode({ address: account, blockNumber }), rpc.readContract({ address: output.address, abi: erc20Abi, functionName: 'decimals', blockNumber }),
      rpc.getBalance({ address: account, blockNumber }), rpc.getBalance({ address: account, blockTag: 'pending' }), rpc.getGasPrice(),
    ])
    if (walletCode && walletCode !== '0x') throw new Error('smart_wallet')
    if (!code || keccak256(code) !== ARC_ROUTER_HASH || !tokenCode || tokenCode === '0x' || decimals !== output.decimals) reject()
    const deadline = executionDeadlineMs(review) / 1000
    if (block.timestamp >= BigInt(deadline)) throw new Error('expired')
    if (balance < value + fee || pendingBalance < value + fee ||
      price <= 0n || price > uint(review.maxFeePerGas) || typeof block.baseFeePerGas !== 'bigint' || block.baseFeePerGas > uint(review.maxFeePerGas)) reject()
    let allowanceNotice: string | null = null
    if (erc20Input) {
      // An ERC-20 input needs a sufficient token -> Permit2 allowance. The second layer is the signed PermitSingle,
      // consumed atomically by the exact signed call below. No on-chain Permit2 approval fallback.
      const [held, toPermit2, permit] = await Promise.all([
        rpc.readContract({ address: input.address, abi: erc20Abi, functionName: 'balanceOf', args: [account], blockNumber }),
        rpc.readContract({ address: input.address, abi: erc20Abi, functionName: 'allowance', args: [account, ARC_PERMIT2], blockNumber }),
        rpc.readContract({ address: ARC_PERMIT2, abi: PERMIT2_ABI, functionName: 'allowance', args: [account, input.address, ARC_ROUTER], blockNumber }),
      ])
      if (held < needed) throw new Error('insufficient_input_balance')
      if (toPermit2 < needed) throw new Error('allowance_missing')
      allowanceNotice = existingAllowanceNotice(r, toPermit2)
      if (signedData) await validatePermitCalldata(review, signedData, permit[2], block.timestamp)
    }
    const call = { account, to: ARC_ROUTER, data: signedData ?? review.transaction.data, value, gas: uint(review.gasLimit),
      maxFeePerGas: uint(review.maxFeePerGas), maxPriorityFeePerGas: uint(review.maxPriorityFeePerGas), blockNumber } as const
    let estimatedNetworkFee: string | undefined
    if (!erc20Input || signedData) {
      await rpc.call(call) // Exact tightened calldata, no state overrides or fake balances.
      const estimated = await rpc.estimateGas(call)
      if (estimated <= 0n || estimated > uint(review.gasLimit)) reject()
      estimatedNetworkFee = (estimated * price).toString()
    } // An unsigned ERC-20 Review is preparation only; signing must be followed by the exact, non-overridden simulation above.
    try {
      const before = await rpc.getTransactionCount({ address: account, blockTag: 'latest' })
      const nonce = await rpc.getTransactionCount({ address: account, blockTag: 'pending' })
      const latestNonce = await rpc.getTransactionCount({ address: account, blockTag: 'latest' })
      if (![before, nonce, latestNonce].every(n => Number.isSafeInteger(n) && n >= 0)) throw new Error('public_nonce')
      if (before !== latestNonce || nonce < latestNonce) throw new ExecutionNonceObservationError('public', Math.max(before, nonce, latestNonce))
      return { nonce, latestNonce, ...(signedData && estimatedNetworkFee ? { estimatedNetworkFee } : {}), ...(allowanceNotice ? { allowanceNotice } : {}) }
    } catch (error) { if (error instanceof ExecutionNonceObservationError) throw error; throw new Error('public_nonce') }
  }
  // The transaction and receipt are read from the public RPC only. The result keeps two separate answers:
  //   chain  : what the network says (success/reverted, block, fee, what the wallet received)
  //   intent : whether that transaction is the one that was reviewed (see swap/transactionEvidence)
  // Wallet-adjusted gas fields are judged by the approved fee ceiling; calldata, value, target, sender and nonce are never adjustable.
  async function result(attempt: SwapAttempt, submitted?: (intent: IntentSummary) => void): Promise<ChainResult> {
    // A transient read problem is a retryable error; a hash that cannot identify the attempt is not.
    if (!hash(attempt.hash)) throw new ExecutionVerificationError('binding', false)
    let chainId: number
    try { chainId = await rpc.getChainId() } catch { throw new ExecutionVerificationError('rpc', true) }
    if (chainId !== 5042) throw new ExecutionVerificationError('rpc', true)
    const expected = executionTransaction(attempt.review, attempt.nonce)
    let tx
    try { tx = await rpc.getTransaction({ hash: attempt.hash! }) }
    catch (error) {
      // A hash that the public node does not know yet is still pending, not failed. Whether its nonce has meanwhile been used by another
      // transaction is read as well: then this hash can never be mined, and only a replacement hash can identify the swap.
      if (error instanceof Error && error.name === 'TransactionNotFoundError') {
        let nonceUsed: boolean | undefined
        try { nonceUsed = (await rpc.getTransactionCount({ address: attempt.review.request.owner as Hex, blockTag: 'latest' })) > attempt.nonce } catch { nonceUsed = undefined }
        return { status: 'pending', identified: false, ...(nonceUsed === undefined ? {} : { nonceUsed }) }
      }
      throw new ExecutionVerificationError('rpc', true)
    }
    const request = attempt.review.request
    const outputToken = ARC_TOKENS[request.tokenOut]
    const reviewed: ReviewedIntent = {
      owner: request.owner as Hex, recipient: request.recipient as Hex, router: ARC_ROUTER as Hex, chainId: 5042, nonce: attempt.nonce,
      value: BigInt(expected.value), calldata: attempt.review.transaction.data, calldataHash: attempt.submittedCalldataHash, gasLimit: BigInt(expected.gas), maxFeePerGas: BigInt(expected.maxFeePerGas),
      maxPriorityFeePerGas: BigInt(expected.maxPriorityFeePerGas), feeCeiling: uint(attempt.review.networkFee), outputToken: outputToken.address as Hex,
      requiredMinimum: uint(attempt.review.requiredMinimum), outputSymbol: request.tokenOut, outputDecimals: outputToken.decimals,
    }
    const chainTx: ChainTx = { hash: tx.hash, from: tx.from, to: tx.to ?? null, chainId: tx.chainId ?? 0, nonce: tx.nonce, type: tx.type, value: tx.value, gas: tx.gas,
      maxFeePerGas: tx.maxFeePerGas ?? 0n, maxPriorityFeePerGas: tx.maxPriorityFeePerGas ?? 0n, input: tx.input }
    submitted?.(summarizeIntent(compareToReview({ attemptHash: attempt.hash!, tx: chainTx, receipt: null,
      observation: { canonical: false, latestBlock: 0n, blockTimestamp: null }, reviewed, received: null }), Date.now()))
    const identityOk = tx.hash.toLowerCase() === attempt.hash!.toLowerCase() && sameAddress(tx.from, expected.from) && tx.chainId === 5042 && tx.nonce === attempt.nonce
    if (!identityOk) throw new ExecutionVerificationError('binding', false)
    let receipt
    try { receipt = await rpc.getTransactionReceipt({ hash: attempt.hash! }) }
    catch (error) {
      // A missing receipt is pending, not failure. Other RPC errors remain unverified (and are retried with backoff).
      if (error instanceof Error && error.name === 'TransactionReceiptNotFoundError') return { status: 'pending', identified: true }
      throw new ExecutionVerificationError('rpc', true)
    }
    if (receipt.blockNumber === null || !hash(receipt.blockHash) || receipt.gasUsed <= 0n) throw new ExecutionVerificationError('malformed', true)
    let block, latest
    try { block = await rpc.getBlock({ blockNumber: receipt.blockNumber }); latest = await rpc.getBlockNumber({ cacheTime: 0 }) }
    catch { throw new ExecutionVerificationError('rpc', true) }
    if (block.hash?.toLowerCase() !== receipt.blockHash.toLowerCase()) return { status: 'pending', identified: true }
    if (latest < receipt.blockNumber + 1n) return { status: 'pending', identified: true } // Two observed blocks; not a promise against all reorgs.
    const chainReceipt: ChainReceipt = { transactionHash: receipt.transactionHash, from: receipt.from, to: receipt.to ?? null, status: receipt.status === 'success' ? 'success' : 'reverted',
      blockNumber: receipt.blockNumber, blockHash: receipt.blockHash, transactionIndex: receipt.transactionIndex, gasUsed: receipt.gasUsed, effectiveGasPrice: receipt.effectiveGasPrice,
      logs: receipt.logs as unknown as readonly ChainLog[] }
    if (receipt.status !== 'success' && receipt.status !== 'reverted') throw new ExecutionVerificationError('malformed', true)
    const fee = receipt.gasUsed * receipt.effectiveGasPrice
    let received: bigint | null = null, sent: bigint | null = null
    if (receipt.status === 'success') {
      const inputToken = ARC_TOKENS[request.tokenIn]
      const flows = ownerFlows(chainReceipt, request.recipient, [outputToken.address, inputToken.address])
      if (flows.ok) {
        received = flows.flows.get(outputToken.address.toLowerCase())?.net ?? 0n
        // What the wallet actually paid: the native value minus any refund for USDC, the token flow for an ERC-20 input.
        const paid = request.tokenIn === 'USDC' ? tx.value - flows.nativeRefund : -(flows.flows.get(inputToken.address.toLowerCase())?.net ?? 0n)
        sent = paid > 0n ? (request.tokenIn === 'USDC' ? paid / 10n ** 12n : paid) : null
      }
    }
    const report = compareToReview({ attemptHash: attempt.hash!, tx: chainTx, receipt: chainReceipt, observation: { canonical: true, latestBlock: latest, blockTimestamp: typeof block.timestamp === 'bigint' ? block.timestamp : null }, reviewed, received })
    if (report.verdict === 'unbound') throw new ExecutionVerificationError('binding', false)
    const checkedAt = Date.now()
    const net = received !== null && received > 0n ? received : 0n
    return {
      status: 'settled', output: net.toString(), fee: fee.toString(), intent: summarizeIntent(report, checkedAt),
      chain: { state: receipt.status === 'success' ? 'success' : 'reverted', blockNumber: receipt.blockNumber.toString(), blockHash: receipt.blockHash, gasUsed: receipt.gasUsed.toString(),
        effectiveGasPrice: receipt.effectiveGasPrice.toString(), fee: fee.toString(), received: received === null ? null : (received < 0n ? '0' : received.toString()), sent: sent === null ? null : sent.toString(), checkedAt },
    }
  }
  async function signPermit(review: ArcReview, provider: ExecutionProvider): Promise<Hex> {
    const blockNumber = await rpc.getBlockNumber({ cacheTime: 0 })
    const [block, allowance] = await Promise.all([rpc.getBlock({ blockNumber }), rpc.readContract({ address: ARC_PERMIT2, abi: PERMIT2_ABI, functionName: 'allowance', args: [review.request.owner as Hex, ARC_TOKENS[review.request.tokenIn].address, ARC_ROUTER], blockNumber })])
    const message = permitMessage(review, allowance[2], block.timestamp)
    const payload = { domain: PERMIT_DOMAIN, types: { ...PERMIT_SINGLE_TYPES, EIP712Domain: [{ name: 'name', type: 'string' }, { name: 'chainId', type: 'uint256' }, { name: 'verifyingContract', type: 'address' }] }, primaryType: 'PermitSingle', message }
    const signature = await provider.request({ method: 'eth_signTypedData_v4', params: [review.request.owner, JSON.stringify(payload, (_, value) => typeof value === 'bigint' ? value.toString() : value)] })
    return attachPermit(review, allowance[2], block.timestamp, signature)
  }
  return { preflight, result, signPermit }
}
export const arcExecutionRpc = createArcExecutionRpc()
