import { decodeFunctionResult, encodeFunctionData, parseAbi, parseEventLogs, type Hex, type PublicClient } from 'viem'
import { MAINNET_BORROW_MORPHO_BLUE as BLUE } from '../config/mainnetBorrow'
import { computeMarketId } from './borrowMarketVerification'
import { borrowBatchCommitment, type BorrowBatchReview, type BorrowCall } from './borrowBatchPolicy'
import { verifyBorrowSettlement, type BorrowSettlementProof } from './borrowSettlement'
import { BORROW_AGGREGATE_ABI, BORROW_BATCHER, BORROW_CHAIN_ABI, decodeBorrowAggregate, type BorrowBoundBatch } from './borrowSdkTransport'
import type { StorageLike } from './borrowAttemptLedger'

const ABI = parseAbi([
  'function accrueInterest((address loanToken,address collateralToken,address oracle,address irm,uint256 lltv) marketParams)',
  'function price() view returns(uint256)',
  'function isAuthorized(address owner,address authorized) view returns(bool)',
  'event Transfer(address indexed from,address indexed to,uint256 value)',
  'event Borrow(bytes32 indexed id,address caller,address indexed onBehalf,address indexed receiver,uint256 assets,uint256 shares)',
  'event Repay(bytes32 indexed id,address indexed caller,address indexed onBehalf,uint256 assets,uint256 shares)',
  'event SupplyCollateral(bytes32 indexed id,address indexed caller,address indexed onBehalf,uint256 assets)',
  'event WithdrawCollateral(bytes32 indexed id,address caller,address indexed onBehalf,address indexed receiver,uint256 assets)',
])
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()
const error = (code: string): never => { throw new Error(code) }
export const BORROW_RECOVERY_ABI = ABI
export type BorrowRecoveryResult = { status: 'pending' | 'unknown' | 'mismatch'; message: string } | { status: 'verified' | 'failed'; proof: BorrowSettlementProof; message: string }
export function createBorrowRecoveryStore(storage: StorageLike | null, owner: Hex) {
  const key = `machina.borrow.recovery.v1:5042:${owner.toLowerCase()}`
  const validate = (r: BorrowBoundBatch) => {
    if (!r || !same(r.terms.owner, owner) || r.terms.chainId !== 5042 || computeMarketId(r.terms.market).toLowerCase() !== r.terms.marketId.toLowerCase()
      || !r.scopeId.startsWith(`5042|${owner.toLowerCase()}|`) || !r.actionId.startsWith(`${r.terms.kind}|5042|${owner.toLowerCase()}|`)
      || !/^0x[0-9a-f]{64}$/i.test(r.callsHash) || !/^0x[0-9a-f]{64}$/i.test(r.blockHash) || (r.txHash && !/^0x[0-9a-f]{64}$/i.test(r.txHash))
      || typeof r.gas !== 'bigint' || typeof r.maxFeePerGas !== 'bigint' || r.gas <= 0n || r.maxFeePerGas <= 0n || r.gas * r.maxFeePerGas > r.terms.maxGasCostWei
      || typeof r.before.collateral !== 'bigint' || typeof r.before.debtShares !== 'bigint' || !Number.isSafeInteger(r.nonce) || r.nonce < 0
      || !Number.isSafeInteger(r.deadline) || typeof r.blockNumber !== 'bigint') error('borrow_recovery_record_invalid')
    if (Object.keys(r.before).some(k => !['collateral', 'debtShares'].includes(k)) || r.before.collateral < 0n || r.before.debtShares < 0n
      || Object.keys(r.terms.market).some(k => !['loanToken','collateralToken','oracle','irm','lltv'].includes(k))
      || Object.keys(r.terms.startingAllowances).some(k => ![r.terms.market.loanToken.toLowerCase(), r.terms.market.collateralToken.toLowerCase()].includes(k))
      || !['borrow','borrow-more','repay','close-loan','add-collateral','withdraw-collateral'].includes(r.terms.kind)
      || r.scopeId !== `5042|${owner.toLowerCase()}|${r.terms.kind === 'borrow' ? r.terms.marketId.toLowerCase() : r.loanId?.toLowerCase()}`
      || !Number.isFinite(r.terms.minHealthFactor) || r.terms.minHealthFactor <= 1
      || !Number.isSafeInteger(r.terms.reviewedAt) || !Number.isSafeInteger(r.terms.quoteExpiresAt) || r.terms.quoteExpiresAt <= r.terms.reviewedAt) error('borrow_recovery_context_invalid')
    // No SDK envelope, calldata, signature, wallet balances or RPC response may enter persistent storage.
    if (Object.keys(r).some(k => !['terms','callsHash','scopeId','actionId','loanId','before','blockNumber','blockHash','deadline','gas','maxFeePerGas','nonce','txHash'].includes(k))) error('borrow_recovery_unexpected_field')
    if (Object.keys(r.terms).some(k => !['chainId','owner','marketId','market','kind','collateralIn','collateralOut','borrowAssets','repayAssets','repayShares','maxGasCostWei','minHealthFactor','startingAllowances','reviewedAt','quoteExpiresAt'].includes(k))) error('borrow_recovery_unexpected_terms')
  }
  const read = (): BorrowBoundBatch[] => {
    if (!storage) return error('borrow_recovery_storage_unavailable')
    const text = storage.getItem(key)
    if (text === null) return []
    if (text.length > 300_000) return error('borrow_recovery_storage_invalid')
    const parsed = JSON.parse(text, (_k, v) => typeof v === 'string' && /^bigint:\d+$/.test(v) ? BigInt(v.slice(7)) : v)
    if (parsed?.version !== 1 || !Array.isArray(parsed.records) || parsed.records.length > 100) return error('borrow_recovery_storage_invalid')
    parsed.records.forEach(validate)
    if (new Set(parsed.records.map((r: BorrowBoundBatch) => r.scopeId)).size !== parsed.records.length) return error('borrow_recovery_duplicate_scope')
    return parsed.records
  }
  return { list: read, get: (scopeId: string) => read().find(r => r.scopeId === scopeId) ?? null,
    save(record: BorrowBoundBatch) {
      validate(record)
      const previous = read().filter(r => r.scopeId !== record.scopeId)
      if (previous.length >= 100) error('borrow_recovery_capacity_reached')
      const text = JSON.stringify({ version: 1, records: [...previous, record] }, (_k, v) => typeof v === 'bigint' ? `bigint:${v}` : v)
      storage!.setItem(key, text)
      if (storage!.getItem(key) !== text) error('borrow_recovery_not_persisted')
    } }
}
// Read-only eth_call: accrueInterest is transient within the call, not an on-chain transaction.
// This avoids inventing an interest model or treating an unaccrued market balance as current debt.
export async function readBorrowAtomicState(client: PublicClient, terms: BorrowBatchReview, blockNumber: bigint, prefix: readonly BorrowCall[] = []) {
  const calls = [...prefix.map(c => ({ target: c.to, allowFailure: false, callData: c.data })),
    { target: BLUE, allowFailure: false, callData: encodeFunctionData({ abi: ABI, functionName: 'accrueInterest', args: [terms.market as any] }) },
    { target: BLUE, allowFailure: false, callData: encodeFunctionData({ abi: BORROW_CHAIN_ABI, functionName: 'market', args: [terms.marketId] }) },
    { target: BLUE, allowFailure: false, callData: encodeFunctionData({ abi: BORROW_CHAIN_ABI, functionName: 'position', args: [terms.marketId, terms.owner] }) },
    { target: terms.market.oracle as Hex, allowFailure: false, callData: encodeFunctionData({ abi: ABI, functionName: 'price' }) },
    { target: BLUE, allowFailure: false, callData: encodeFunctionData({ abi: ABI, functionName: 'isAuthorized', args: [terms.owner, '0x7FB8c7260b63934d8da38aF902f87ae6e284a845'] }) },
  ]
  const result = await client.call({ account: terms.owner, to: BORROW_BATCHER, value: 0n, blockNumber,
    data: encodeFunctionData({ abi: BORROW_AGGREGATE_ABI, functionName: 'aggregate3', args: [calls] }) })
  if (!result.data) return error('borrow_atomic_state_missing')
  const decoded = decodeFunctionResult({ abi: BORROW_AGGREGATE_ABI, functionName: 'aggregate3', data: result.data })
  if (decoded.length !== calls.length || decoded.some(r => !r.success)) return error('borrow_atomic_state_failed')
  const start = prefix.length + 1
  const market = decodeFunctionResult({ abi: BORROW_CHAIN_ABI, functionName: 'market', data: decoded[start].returnData })
  const position = decodeFunctionResult({ abi: BORROW_CHAIN_ABI, functionName: 'position', data: decoded[start + 1].returnData })
  const price = decodeFunctionResult({ abi: ABI, functionName: 'price', data: decoded[start + 2].returnData })
  const authorization = decodeFunctionResult({ abi: ABI, functionName: 'isAuthorized', data: decoded[start + 3].returnData })
  if (price <= 0n || authorization || market[2] > market[0]) return error('borrow_state_or_authorization_invalid')
  const denominator = market[3] + 1_000_000n, debt = (position[1] * (market[2] + 1n) + denominator - 1n) / denominator
  const collateralValue = position[2] * price / 10n ** 36n, maxDebt = collateralValue * terms.market.lltv / 10n ** 18n
  const hf = debt === 0n ? null : Number(maxDebt * 10n ** 12n / debt) / 1e12
  const ltv = debt === 0n ? 0 : collateralValue === 0n ? Infinity : Number((debt * 10n ** 12n + collateralValue - 1n) / collateralValue) / 1e12
  return { collateral: position[2], debtShares: position[1], healthFactor: hf, ltv }
}
export async function recoverBorrowTransaction(client: PublicClient, record: BorrowBoundBatch): Promise<BorrowRecoveryResult> {
  const unknown = { status: 'unknown' as const, message: 'This transaction is not independently verified yet. Do not submit again.' }
  try {
    if (!record.txHash) return unknown
    const hash = record.txHash
    if (await client.getChainId() !== 5042) return unknown
    let receipt
    try { receipt = await client.getTransactionReceipt({ hash: record.txHash }) }
    catch (e) { return e instanceof Error && e.name === 'TransactionReceiptNotFoundError' ? { status: 'pending', message: 'Receipt not available yet. No second transaction will be sent.' } : unknown }
    const [tx, block, originalBlock, latest] = await Promise.all([client.getTransaction({ hash: record.txHash }), client.getBlock({ blockNumber: receipt.blockNumber }), client.getBlock({ blockNumber: record.blockNumber }), client.getBlockNumber()])
    if (latest <= receipt.blockNumber) return { status: 'pending', message: 'Waiting for the next canonical block.' }
    if (block.hash !== receipt.blockHash || originalBlock.hash !== record.blockHash || record.blockNumber >= receipt.blockNumber) return unknown
    if (!same(tx.hash, record.txHash) || !same(receipt.transactionHash, record.txHash) || !same(receipt.from, record.terms.owner)
      || !receipt.to || !same(receipt.to, BORROW_BATCHER) || tx.blockHash !== receipt.blockHash || tx.blockNumber !== receipt.blockNumber) return unknown
    if (receipt.logs.some(l => l.removed || !l.transactionHash || !same(l.transactionHash, hash)
      || l.blockHash !== receipt.blockHash || l.blockNumber !== receipt.blockNumber || l.logIndex === null || l.logIndex < 0)
      || new Set(receipt.logs.map(l => l.logIndex)).size !== receipt.logs.length) return unknown
    if (!tx.to || !same(tx.to, BORROW_BATCHER) || !same(tx.from, record.terms.owner) || tx.value !== 0n || tx.nonce !== record.nonce || tx.chainId !== 5042
      || tx.gas > record.gas || (tx.maxFeePerGas ?? tx.gasPrice ?? record.maxFeePerGas + 1n) > record.maxFeePerGas) return { status: 'mismatch', message: 'The submitted transaction differs from the approved batch or fee limits. It cannot be cancelled by this check.' }
    let calls: BorrowCall[]
    try { calls = decodeBorrowAggregate(tx.input) } catch { return { status: 'mismatch', message: 'The submitted calldata is not the reviewed canonical atomic batch.' } }
    if (borrowBatchCommitment(calls) !== record.callsHash) return { status: 'mismatch', message: 'The on-chain batch differs from Review. Do not submit again.' }
    const [before, after] = await Promise.all([
      client.readContract({ address: BLUE, abi: BORROW_CHAIN_ABI, functionName: 'position', args: [record.terms.marketId, record.terms.owner], blockNumber: record.blockNumber }),
      readBorrowAtomicState(client, record.terms, receipt.blockNumber),
    ])
    if (before[1] !== record.before.debtShares || before[2] !== record.before.collateral) return unknown
    const events = parseEventLogs({ abi: ABI, logs: receipt.logs.filter(l => same(l.address, BLUE)), strict: true })
      .filter(e => 'id' in e.args && same(e.args.id!, record.terms.marketId) && 'onBehalf' in e.args && same(e.args.onBehalf!, record.terms.owner))
    const expected = [ ...(record.terms.collateralIn > 0n ? ['SupplyCollateral'] : []), ...(record.terms.borrowAssets > 0n ? ['Borrow'] : []), ...(record.terms.repayAssets > 0n ? ['Repay'] : []), ...(record.terms.collateralOut > 0n ? ['WithdrawCollateral'] : []) ]
    const names = events.map(e => e.eventName)
    let eventsVerified = JSON.stringify(names) === JSON.stringify(expected)
    for (const e of events) {
      const args = e.args
      if ('assets' in args) {
        const expectedAmount = e.eventName === 'Borrow' ? record.terms.borrowAssets : e.eventName === 'SupplyCollateral' ? record.terms.collateralIn : e.eventName === 'WithdrawCollateral' ? record.terms.collateralOut : null
        if (expectedAmount !== null && args.assets !== expectedAmount) eventsVerified = false
        if (e.eventName === 'Repay' && (args.assets! <= 0n || args.assets! > record.terms.repayAssets)) eventsVerified = false
      }
      if ('caller' in args && !same(args.caller!, '0x7FB8c7260b63934d8da38aF902f87ae6e284a845')) eventsVerified = false
      if ('receiver' in args && !same(args.receiver!, '0x7FB8c7260b63934d8da38aF902f87ae6e284a845')) eventsVerified = false
    }
    if (receipt.status === 'success') {
      const borrowedShares = events.reduce((n, e) => n + (e.eventName === 'Borrow' ? e.args.shares! : 0n), 0n)
      const repaidShares = events.reduce((n, e) => n + (e.eventName === 'Repay' ? e.args.shares! : 0n), 0n)
      if (after.debtShares !== record.before.debtShares + borrowedShares - repaidShares) eventsVerified = false
      const transfers = parseEventLogs({ abi: ABI, eventName: 'Transfer', logs: receipt.logs, strict: true })
      const net = (token: string) => transfers.filter(e => same(e.address, token)).reduce((n, e) => n + (same(e.args.to!, record.terms.owner) ? e.args.value! : 0n) - (same(e.args.from!, record.terms.owner) ? e.args.value! : 0n), 0n)
      const repaidAssets = events.reduce((n, e) => n + (e.eventName === 'Repay' ? e.args.assets! : 0n), 0n)
      if (net(record.terms.market.loanToken) !== record.terms.borrowAssets - repaidAssets
        || net(record.terms.market.collateralToken) !== record.terms.collateralOut - record.terms.collateralIn) eventsVerified = false
    }
    // Position is sampled before preparation and at the receipt block. Any intervening activity/delta ambiguity fails closed.
    const proof = verifyBorrowSettlement(record.terms, record.scopeId, calls, { txHash: record.txHash, chainId: 5042, sender: tx.from, owner: record.terms.owner,
      marketId: record.terms.marketId, scopeId: record.scopeId, decodedCalls: calls,
      receipt: { transactionHash: receipt.transactionHash, status: receipt.status, gasUsed: receipt.gasUsed, effectiveGasPrice: receipt.effectiveGasPrice, blockHash: receipt.blockHash },
      canonicalBlockHash: block.hash!, before: record.before, after, morphoEventsVerified: eventsVerified })
    if (!proof || (await client.getBlock({ blockNumber: receipt.blockNumber })).hash !== receipt.blockHash) return unknown
    return { status: proof.status, proof, message: proof.status === 'verified' ? 'Canonical receipt, batch, fees, Morpho events and position independently verified.' : 'The receipt confirms a revert. Gas was spent; no successful loan change is claimed.' }
  } catch { return unknown }
}
