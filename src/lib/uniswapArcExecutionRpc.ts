import { createPublicClient, defineChain, erc20Abi, http, keccak256, type Hex, type Transport } from 'viem'
import { ARC_OUTPUTS, ARC_ROUTER, ARC_ROUTER_HASH, decodeNativeEconomics, nativeAmount, sameAddress, uint, type ArcReview } from './uniswapArcPolicy'
import { ExecutionNonceObservationError, executionTransaction, type ChainResult, type SwapAttempt } from './uniswapArcExecution'

const RPC = 'https://rpc.mainnet.arc.io'
const chain = defineChain({ id: 5042, name: 'Arc Mainnet', nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 }, rpcUrls: { default: { http: [RPC] } } })
export function assertExecutionReadMethod(method: string) {
  if (!['eth_chainId', 'eth_blockNumber', 'eth_getCode', 'eth_getBalance', 'eth_call', 'eth_estimateGas', 'eth_gasPrice',
    'eth_getTransactionCount', 'eth_getTransactionByHash', 'eth_getTransactionReceipt', 'eth_getBlockByNumber'].includes(method)) throw new Error('read_only_rpc')
}
const transport: Transport = options => {
  const underlying = http(RPC, { timeout: 8000, retryCount: 0 })(options)
  return { ...underlying, request(args, requestOptions) { assertExecutionReadMethod(args.method); return underlying.request(args, requestOptions) } }
}
const client = createPublicClient({ chain, transport, ccipRead: false, cacheTime: 0 })
const hash = (value: unknown): value is Hex => typeof value === 'string' && /^0x[a-f0-9]{64}$/i.test(value)
const reject = (): never => { throw new Error('verification') }
const transferTopic = keccak256(new TextEncoder().encode('Transfer(address,address,uint256)'))

// The injectable client is a test seam; production uses only the pinned, read-only Arc RPC.
export function createArcExecutionRpc(rpc = client) {
  async function preflight(review: ArcReview) {
    const r = review.request, account = r.owner as Hex, output = ARC_OUTPUTS[r.tokenOut]
    if (await rpc.getChainId() !== 5042) reject()
    const blockNumber = await rpc.getBlockNumber({ cacheTime: 0 })
    const [block, code, tokenCode, walletCode, decimals, balance, pendingBalance, price] = await Promise.all([
      rpc.getBlock({ blockNumber }), rpc.getCode({ address: ARC_ROUTER, blockNumber }), rpc.getCode({ address: output.address, blockNumber }),
      rpc.getCode({ address: account, blockNumber }), rpc.readContract({ address: output.address, abi: erc20Abi, functionName: 'decimals', blockNumber }),
      rpc.getBalance({ address: account, blockNumber }), rpc.getBalance({ address: account, blockTag: 'pending' }), rpc.getGasPrice(),
    ])
    if (walletCode && walletCode !== '0x') throw new Error('smart_wallet')
    if (!code || keccak256(code) !== ARC_ROUTER_HASH || !tokenCode || tokenCode === '0x' || decimals !== output.decimals) reject()
    const deadline = decodeNativeEconomics(review.transaction, r, uint(review.requiredMinimum), review.quoteId).deadline
    if (block.timestamp >= BigInt(deadline)) throw new Error('expired')
    if (balance < nativeAmount(r.amount) + uint(review.networkFee) || pendingBalance < nativeAmount(r.amount) + uint(review.networkFee) ||
      price <= 0n || price > uint(review.maxFeePerGas) || typeof block.baseFeePerGas !== 'bigint' || block.baseFeePerGas > uint(review.maxFeePerGas)) reject()
    const call = { account, to: ARC_ROUTER, data: review.transaction.data, value: nativeAmount(r.amount), gas: uint(review.gasLimit),
      maxFeePerGas: uint(review.maxFeePerGas), maxPriorityFeePerGas: uint(review.maxPriorityFeePerGas), blockNumber } as const
    await rpc.call(call) // Exact tightened calldata, no state overrides or fake balances.
    const estimated = await rpc.estimateGas(call)
    if (estimated <= 0n || estimated > uint(review.gasLimit)) reject()
    try {
      const before = await rpc.getTransactionCount({ address: account, blockTag: 'latest' })
      const nonce = await rpc.getTransactionCount({ address: account, blockTag: 'pending' })
      const latestNonce = await rpc.getTransactionCount({ address: account, blockTag: 'latest' })
      if (![before, nonce, latestNonce].every(n => Number.isSafeInteger(n) && n >= 0)) throw new Error('public_nonce')
      if (before !== latestNonce || nonce < latestNonce) throw new ExecutionNonceObservationError('public', Math.max(before, nonce, latestNonce))
      return { nonce, latestNonce }
    } catch (error) { if (error instanceof ExecutionNonceObservationError) throw error; throw new Error('public_nonce') }
  }
  async function result(attempt: SwapAttempt): Promise<ChainResult> {
    if (!hash(attempt.hash) || await rpc.getChainId() !== 5042) reject()
    const expected = executionTransaction(attempt.review, attempt.nonce)
    const tx = await rpc.getTransaction({ hash: attempt.hash! })
    // Wallets can alter requests. Never report success for a hash that fails exact transaction binding.
    if (!sameAddress(tx.from, expected.from) || !sameAddress(tx.to, expected.to) || tx.chainId !== 5042 || tx.nonce !== attempt.nonce || tx.type !== 'eip1559' ||
      tx.input.toLowerCase() !== expected.data.toLowerCase() || tx.value !== BigInt(expected.value) || tx.gas !== BigInt(expected.gas) ||
      tx.maxFeePerGas !== BigInt(expected.maxFeePerGas) || tx.maxPriorityFeePerGas !== BigInt(expected.maxPriorityFeePerGas) || tx.hash.toLowerCase() !== attempt.hash!.toLowerCase()) reject()
    let receipt
    try { receipt = await rpc.getTransactionReceipt({ hash: attempt.hash! }) }
    catch (error) {
      // A missing receipt is pending, not failure. Other RPC errors remain unverified.
      if (error instanceof Error && error.name === 'TransactionReceiptNotFoundError') return { status: 'pending' }
      throw error
    }
    if (receipt.transactionHash.toLowerCase() !== attempt.hash!.toLowerCase() || !sameAddress(receipt.from, expected.from) || !sameAddress(receipt.to, expected.to) ||
      receipt.blockNumber === null || !hash(receipt.blockHash) || receipt.gasUsed <= 0n || receipt.gasUsed > BigInt(expected.gas) || receipt.effectiveGasPrice > BigInt(expected.maxFeePerGas)) reject()
    const block = await rpc.getBlock({ blockNumber: receipt.blockNumber })
    if (block.hash?.toLowerCase() !== receipt.blockHash.toLowerCase()) return { status: 'pending' }
    if (await rpc.getBlockNumber({ cacheTime: 0 }) < receipt.blockNumber + 1n) return { status: 'pending' } // Two observed blocks; not a promise against all reorgs.
    const fee = receipt.gasUsed * receipt.effectiveGasPrice
    if (fee > uint(attempt.review.networkFee)) reject()
    if (receipt.status === 'reverted') return { status: 'failed', fee: fee.toString(), output: '0' }
    if (receipt.status !== 'success') reject()
    let received = 0n
    const logIndexes = new Set<number>()
    const output = ARC_OUTPUTS[attempt.review.request.tokenOut].address, owner = attempt.review.request.recipient
    for (const log of receipt.logs) {
      if (!sameAddress(log.address, output) || log.topics[0]?.toLowerCase() !== transferTopic) continue
      if (log.removed || log.transactionHash?.toLowerCase() !== attempt.hash!.toLowerCase() || log.blockHash?.toLowerCase() !== receipt.blockHash.toLowerCase() ||
        log.blockNumber !== receipt.blockNumber || log.logIndex === null || !Number.isSafeInteger(log.logIndex) || log.logIndex < 0 || logIndexes.has(log.logIndex) ||
        log.transactionIndex !== receipt.transactionIndex || log.topics.length !== 3 || !/^0x[0-9a-fA-F]{64}$/.test(log.data) ||
        !log.topics.slice(1).every(topic => /^0x0{24}[0-9a-fA-F]{40}$/.test(topic ?? ''))) reject()
      logIndexes.add(log.logIndex!)
      const from = `0x${log.topics[1]!.slice(-40)}`, to = `0x${log.topics[2]!.slice(-40)}`, amount = BigInt(log.data)
      if (sameAddress(to, owner)) received += amount
      if (sameAddress(from, owner)) received -= amount
    }
    if (received < uint(attempt.review.requiredMinimum)) reject()
    return { status: 'confirmed', fee: fee.toString(), output: received.toString() }
  }
  return { preflight, result }
}
export const arcExecutionRpc = createArcExecutionRpc()
