// Borrow-only binding for the official /next adapter. The shared Swap/Bridge/Earn adapter is unchanged.
import { createPublicClient, createWalletClient, custom, decodeFunctionData, encodeFunctionData, http, parseAbi, type Hex, type PublicClient, type WalletClient, UserRejectedRequestError } from 'viem'
import { getChainByEnum, Blockchain } from '@circle-fin/borrow-kit'
import { createViemAdapterContext, createViemAdapterFromContext } from '@circle-fin/borrow-adapter-viem-v2/next'
import { MAINNET_BORROW_ADAPTER_CONTRACT, MAINNET_BORROW_CHAIN_ID } from '../config/mainnetBorrow'
import { MAINNET_CONFIG } from '../config/mainnet'
import { borrowBatchCommitment, verifyBorrowAtomicBatch, assertBorrowFeeBinding, type BorrowBatchReview, type BorrowCall } from './borrowBatchPolicy'
import { borrowSettlementMatchesQuote, borrowPositionChangeMatches } from './borrowSettlement'
import { borrowAttemptScope, decimalToUnits, type PreparedBorrowQuote } from './borrowWriteSafety'
import { createBorrowSubmissionGuard } from './borrowSubmissionGuard'
import { readBorrowAtomicState } from './borrowRecovery'
import type { BorrowReview } from './borrowOperations'
import type { Eip1193Request } from './mainnetBorrow'

export const BORROW_BATCHER = '0x522fAf9A91c41c443c66765030741e4AaCe147D0' as const
export const BORROW_AGGREGATE_ABI = parseAbi(['function aggregate3((address target,bool allowFailure,bytes callData)[] calls) payable returns ((bool success,bytes returnData)[] returnData)'])
export const BORROW_CHAIN_ABI = parseAbi([
  'function position(bytes32 id,address owner) view returns (uint256 supplyShares,uint128 borrowShares,uint128 collateral)',
  'function market(bytes32 id) view returns (uint128 totalSupplyAssets,uint128 totalSupplyShares,uint128 totalBorrowAssets,uint128 totalBorrowShares,uint128 lastUpdate,uint128 fee)',
  'function decimals() view returns(uint8)',
  'function allowance(address owner,address spender) view returns(uint256)',
  'function isAuthorized(address owner,address authorized) view returns(bool)',
])
export type BorrowPinnedPosition = { collateral: bigint; debtShares: bigint }
export type BorrowBoundBatch = {
  terms: BorrowBatchReview; callsHash: Hex; scopeId: string; actionId: string; loanId: string | null
  before: BorrowPinnedPosition; blockNumber: bigint; blockHash: Hex; deadline: number
  gas: bigint; maxFeePerGas: bigint; nonce: number; txHash?: Hex
}
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()
function closed(code: string): never { throw new Error(code) }
const rawChain = getChainByEnum(Blockchain.Arc)
const chain = rawChain.type === 'evm' ? rawChain : closed('borrow_invalid_chain_config')
export function borrowPublicClient() { return createPublicClient({ transport: http(MAINNET_CONFIG.arcRpcUrl, { retryCount: 0, timeout: 10_000 }) }) }
export function decodeBorrowAggregate(data: Hex): BorrowCall[] {
  const decoded = decodeFunctionData({ abi: BORROW_AGGREGATE_ABI, data })
  if (encodeFunctionData({ abi: BORROW_AGGREGATE_ABI, functionName: 'aggregate3', args: decoded.args }).toLowerCase() !== data.toLowerCase()) closed('borrow_noncanonical_batch')
  return decoded.args[0].map(c => { if (c.allowFailure) closed('borrow_non_atomic_call'); return { to: c.target, data: c.callData, value: 0n } })
}
export function encodeBorrowAggregate(calls: readonly BorrowCall[]): Hex {
  if (calls.some(c => (c.value ?? 0n) !== 0n)) closed('borrow_native_value')
  return encodeFunctionData({ abi: BORROW_AGGREGATE_ABI, functionName: 'aggregate3', args: [calls.map(c => ({ target: c.to, allowFailure: false, callData: c.data }))] })
}
function quantity(value: unknown, pending = false): bigint {
  if (typeof value === 'string' && /^0x(?:0|[1-9a-f][0-9a-f]*)$/i.test(value)) return BigInt(value)
  if (pending && typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return BigInt(value)
  return closed('borrow_invalid_wallet_nonce')
}
export async function borrowWalletRead(request: Eip1193Request, args: Parameters<Eip1193Request>[0]): Promise<unknown> {
  if (!['eth_chainId','eth_accounts','wallet_getCapabilities','eth_getTransactionCount'].includes(args.method)) closed('borrow_wallet_read_method_blocked')
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([Promise.resolve().then(() => request(args)), new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error('borrow_wallet_read_timeout')), 8_000)
    })])
  } finally { if (timer !== undefined) clearTimeout(timer) }
}
async function walletContext(request: Eip1193Request, owner: Hex) {
  const [id, accounts] = await Promise.all([borrowWalletRead(request, { method: 'eth_chainId' }), borrowWalletRead(request, { method: 'eth_accounts' })])
  if (quantity(id) !== 5042n || !Array.isArray(accounts) || (typeof accounts[0] !== 'string' || !same(accounts[0], owner))) closed('borrow_wallet_changed')
}
async function stableNonce(read: (tag: 'latest' | 'pending') => Promise<bigint>) {
  const first = await read('latest'), pending = await read('pending'), last = await read('latest')
  if (first !== last || pending !== last) closed('borrow_nonce_unstable_or_pending')
  return last
}
export async function borrowStableNonce(client: PublicClient, request: Eip1193Request, owner: Hex): Promise<number> {
  const [publicNonce, walletNonce] = await Promise.all([
    stableNonce(async blockTag => BigInt(await client.getTransactionCount({ address: owner, blockTag }))),
    stableNonce(async tag => quantity(await borrowWalletRead(request, { method: 'eth_getTransactionCount', params: [owner, tag] }), tag === 'pending')),
  ])
  if (publicNonce !== walletNonce || publicNonce > BigInt(Number.MAX_SAFE_INTEGER)) closed('borrow_nonce_sources_disagree')
  return Number(publicNonce)
}
function quoteTerms(prepared: PreparedBorrowQuote) {
  const q = prepared.quote, units = (v: { amount: string; decimals: number }) => {
    const parsed = decimalToUnits(v.amount, v.decimals)
    if (parsed === null) return closed('borrow_amount_precision')
    return parsed
  }
  return { collateralIn: q.kind === 'borrow' || q.kind === 'add-collateral' ? units(q.collateral) : 0n,
    collateralOut: q.kind === 'close-loan' || q.kind === 'withdraw-collateral' ? units(q.collateral) : 0n,
    borrowAssets: q.kind === 'borrow' ? units(q.loanAsset) : 0n,
    repayAssets: q.kind === 'repay' ? units(q.repayAmount) : q.kind === 'close-loan' || q.kind === 'withdraw-collateral' ? units(q.maxRepayment) : 0n }
}
export type BorrowTransportOptions = {
  review: BorrowReview; request: Eip1193Request; client: PublicClient
  // Must durably save the unsigned descriptor before opening the wallet, then save the hash immediately on return.
  persist(record: BorrowBoundBatch): void
  submitted(hash: Hex): void
  prepared?: (details: { rpcEstimatedFeeWei: bigint; requestFeeCeilingWei: bigint; executionDeadlineMs: number }) => void
  isCurrent?: () => boolean
  now?: () => number; idempotencyKey?: string; walletRequested?: () => void
}
export function createBorrowSdkTransport(options: BorrowTransportOptions) {
  const { review, client, request } = options, owner = review.wallet.address as Hex, now = options.now ?? Date.now
  let bound: BorrowBoundBatch | null = null, lastReason = ''
  const guard = createBorrowSubmissionGuard({ owner: owner.toLowerCase(), scopeId: borrowAttemptScope(review.action, owner), actionId: review.actionId, idempotencyKey: options.idempotencyKey ?? '' })
  const raw = createWalletClient({ account: owner, transport: custom({ request: (async (args: Parameters<Eip1193Request>[0]) => {
    if (args.method !== 'eth_sendTransaction') return borrowWalletRead(request, args)
    if (!bound || guard.requested()) closed('borrow_duplicate_or_unbound_dispatch')
    await requireContext()
    if (now() >= bound.deadline) closed('borrow_execution_expired')
    guard.markRequested()
    try { options.walletRequested?.() } catch { /* UI listeners never change transaction safety. */ }
    return request(args)
  }) as any }, { retryCount: 0 }) })
  const requireContext = async () => {
    guard.check()
    if (options.isCurrent?.() === false) closed('borrow_context_changed')
    if (now() >= review.expiresAt) closed('borrow_review_expired')
    await walletContext(request, owner)
    if (now() >= review.expiresAt) closed('borrow_review_expired')
    if (options.isCurrent?.() === false) closed('borrow_context_changed')
  }
  // A narrow wallet facade. No eth_sign, arbitrary sendCalls, request override or client.extend path is exposed.
  const wallet = {
    account: raw.account,
    getChainId: () => raw.getChainId(), getAddresses: () => raw.getAddresses(),
    getCapabilities: (...args: Parameters<typeof raw.getCapabilities>) => raw.getCapabilities(...args),
    async sendCalls() { lastReason = 'atomic_fee_contract'; closed('borrow_atomic_wallet_fee_ceiling_unsupported') },
    async sendTransaction(tx: Record<string, any>) {
      const record = bound
      if (!record || guard.requested() || !same(tx.to ?? '', BORROW_BATCHER) || tx.chain?.id !== 5042 || (tx.value !== undefined && tx.value !== 0n)) closed('borrow_unbound_wallet_request')
      if (Object.keys(tx).some(k => !['to', 'data', 'chain', 'account', 'value', 'gas'].includes(k))) closed('borrow_unexpected_wallet_field')
      if (tx.gas !== undefined && (typeof tx.gas !== 'bigint' || tx.gas <= 0n || tx.gas > record.gas)) closed('borrow_sdk_gas_drift')
      if (borrowBatchCommitment(decodeBorrowAggregate(tx.data)) !== record.callsHash) closed('borrow_wallet_batch_changed')
      await requireContext()
      if (now() >= record.deadline || await borrowStableNonce(client, request, owner) !== record.nonce) closed('borrow_send_context_changed')
      if ((await client.getBlock({ blockNumber: record.blockNumber })).hash !== record.blockHash) closed('borrow_send_reorg')
      await requireContext()
      if (now() >= record.deadline) closed('borrow_execution_expired')
      assertBorrowFeeBinding(review.maxGasCostWei, record.gas, record.maxFeePerGas, true)
      // Persist before the point of no return. A storage failure prevents opening the wallet.
      options.persist(record)
      let hash: Hex
      try { hash = await raw.sendTransaction({ account: owner, chain: tx.chain, to: BORROW_BATCHER, data: tx.data,
        value: 0n, gas: record.gas, maxFeePerGas: record.maxFeePerGas, maxPriorityFeePerGas: 0n, nonce: record.nonce }) } catch (e) {
        let cause: any = e
        for (let i = 0; cause && i < 6; i++, cause = cause.cause) {
          if (cause instanceof UserRejectedRequestError && cause.code === 4001 && guard.requested()) { guard.markProviderRejected(); lastReason = 'borrow_user_rejected'; break }
        }
        throw e
      }
      if (typeof hash !== 'string' || !/^0x[0-9a-f]{64}$/i.test(hash)) closed('borrow_unknown_submission_hash')
      record.txHash = hash
      // Past the point of no return. Preserve/return the hash even if storage or a UI listener fails.
      try { options.persist(record) } catch { /* the durable pre-submit record remains unresolved */ }
      try { options.submitted(hash) } catch { /* the SDK must still receive the known hash */ }
      return hash
    },
  }
  const context = createViemAdapterContext({ capabilities: { addressContext: 'user-controlled', supportedChains: [chain] },
    getPublicClient: () => client, getWalletClient: () => wallet as unknown as WalletClient })
  const adapter = createViemAdapterFromContext(context), delegate = adapter.batchExecute.bind(adapter)
  Object.defineProperty(adapter, 'batchExecute', { value: async (sdkCalls: readonly BorrowCall[], targetChain: typeof chain, opts: any) => {
    try {
    if (bound || targetChain.chainId !== 5042 || !same(opts?.fromAddress ?? '', owner)) closed('borrow_batch_context_changed')
    await requireContext()
    if (await client.getChainId() !== 5042) closed('borrow_wrong_rpc_chain')
    const block = await client.getBlock(), blockNumber = block.number
    if (!block.hash || Math.abs(now() - Number(block.timestamp) * 1000) > 60_000) closed('borrow_stale_block')
    const [code, batcherCode, position, allowances, authorized, precisions] = await Promise.all([
      client.getCode({ address: owner, blockNumber }), client.getCode({ address: BORROW_BATCHER, blockNumber }),
      client.readContract({ address: review.evidence.verification!.result.status === 'verified' ? '0x34cd04070dd72b14e241112f6d83812df5af7fcd' : closed('borrow_market_unverified'), abi: BORROW_CHAIN_ABI, functionName: 'position', args: [review.evidence.market!.data.marketId, owner], blockNumber }),
      Promise.all([review.evidence.market!.data.loanAsset.address, review.evidence.market!.data.collateralAsset.address].map(async token => [token.toLowerCase(), await client.readContract({ address: token as Hex, abi: BORROW_CHAIN_ABI, functionName: 'allowance', args: [owner, MAINNET_BORROW_ADAPTER_CONTRACT], blockNumber })] as const)),
      client.readContract({ address: '0x34cd04070dd72b14e241112f6d83812df5af7fcd', abi: BORROW_CHAIN_ABI, functionName: 'isAuthorized', args: [owner, MAINNET_BORROW_ADAPTER_CONTRACT], blockNumber }),
      Promise.all([review.evidence.market!.data.loanAsset.address, review.evidence.market!.data.collateralAsset.address].map(token => client.readContract({ address: token as Hex, abi: BORROW_CHAIN_ABI, functionName: 'decimals', blockNumber }))),
    ])
    const market = review.evidence.market!.data
    if (precisions[0] !== market.loanAsset.decimals || precisions[1] !== market.collateralAsset.decimals) closed('borrow_token_precision_mismatch')
    const q = review.prepared.quote
    const quoted = q.kind === 'borrow' ? [q.collateral, q.loanAsset] : q.kind === 'repay' ? [q.repayAmount] : q.kind === 'close-loan' || q.kind === 'withdraw-collateral' ? [q.collateral, q.maxRepayment] : q.kind === 'add-collateral' ? [q.collateral] : []
    for (const a of quoted) {
      const index = same(a.tokenAddress, market.loanAsset.address) ? 0 : same(a.tokenAddress, market.collateralAsset.address) ? 1 : -1
      if (index < 0 || a.decimals !== precisions[index]) closed('borrow_quote_token_precision_mismatch')
    }
    if (review.action.kind === 'borrow' && (position[1] !== 0n || position[2] !== 0n)) closed('borrow_existing_onchain_position')
    const held = review.evidence.position?.data.collateral
    if (review.action.kind !== 'borrow' && (!held || decimalToUnits(held.amount, precisions[1]) !== position[2])) closed('borrow_position_changed')
    // Smart/delegated accounts need a wallet-specific outer-call simulation and fee contract. Never pretend EIP-5792 supplies it.
    if ((code && code !== '0x') || !batcherCode || batcherCode === '0x' || authorized) { lastReason = 'atomic_fee_contract'; closed('borrow_eoa_atomic_context_unsupported') }
    const verification = review.evidence.verification!.result
    if (verification.status !== 'verified') closed('borrow_market_unverified')
    const terms: BorrowBatchReview = { chainId: 5042, owner, marketId: review.evidence.market!.data.marketId, market: verification.details.params,
      kind: review.action.kind, ...quoteTerms(review.prepared), repayShares: review.action.kind === 'close-loan' || review.action.kind === 'repay' ? position[1] : 0n,
      minHealthFactor: review.evidence.targetHealthFactor ?? 1.5, maxGasCostWei: review.maxGasCostWei, startingAllowances: Object.fromEntries(allowances),
      reviewedAt: now(), quoteExpiresAt: review.expiresAt }
    // No fabricated proof: only compare the economics helper against the exact terms about to be independently decoded.
    if (!borrowSettlementMatchesQuote({ terms }, review.action, review.prepared, terms.marketId, review.maxGasCostWei, review.evidence.targetHealthFactor)) closed('borrow_quote_terms_unbound')
    const calls = sdkCalls.map(c => ({ to: c.to, data: c.data, value: c.value ?? 0n })), checked = verifyBorrowAtomicBatch(terms, calls, now())
    const data = encodeBorrowAggregate(calls)
    // Circle's signature and every approve/grant/execute/revoke are executed together by eth_call, never by a sequence of independent calls.
    const after = await readBorrowAtomicState(client, terms, blockNumber, calls)
    if (!borrowPositionChangeMatches(terms, { collateral: position[2], debtShares: position[1] }, after)) closed('borrow_simulated_position_mismatch')
    const [estimated, price, nonce] = await Promise.all([
      client.estimateGas({ account: owner, to: BORROW_BATCHER, data, value: 0n, blockNumber }), client.getGasPrice(), borrowStableNonce(client, request, owner),
    ])
    const ratio = opts?.senderPreservingBatcherGasBufferRatio ?? [120n, 100n]
    if (!Array.isArray(ratio) || ratio.length !== 2 || typeof ratio[0] !== 'bigint' || typeof ratio[1] !== 'bigint' || ratio[1] <= 0n || ratio[0] < ratio[1]) closed('borrow_invalid_sdk_gas_buffer')
    const gas = (estimated * ratio[0] + ratio[1] - 1n) / ratio[1], maxFeePerGas = (price > (block.baseFeePerGas ?? 0n) ? price : block.baseFeePerGas!) * 2n
    assertBorrowFeeBinding(review.maxGasCostWei, gas, maxFeePerGas, true)
    const balance = await client.getBalance({ address: owner, blockNumber }), nativeRepay = terms.market.loanToken.toLowerCase() === '0x3600000000000000000000000000000000000000' ? terms.repayAssets * 10n ** 12n : 0n
    if (balance < gas * maxFeePerGas + nativeRepay || (await client.getBlock({ blockNumber })).hash !== block.hash) closed('borrow_balance_or_block_changed')
    await requireContext()
    bound = { terms, callsHash: checked.commitment, scopeId: borrowAttemptScope(review.action, owner), actionId: review.actionId,
      loanId: review.action.kind === 'borrow' ? null : review.action.loanId, before: { collateral: position[2], debtShares: position[1] }, blockNumber,
      blockHash: block.hash, deadline: checked.deadline, gas, maxFeePerGas, nonce }
    options.prepared?.({ rpcEstimatedFeeWei: estimated * price, requestFeeCeilingWei: gas * maxFeePerGas, executionDeadlineMs: checked.deadline })
    return await delegate(calls, targetChain, opts)
    } catch (e) {
      if (e instanceof Error && /^borrow_[a-z_]+$/.test(e.message)) lastReason = e.message
      throw e
    }
  } })
  return { adapter, getBound: () => bound, sealUnsent: guard.sealUnsent, reason: () => lastReason }
}
