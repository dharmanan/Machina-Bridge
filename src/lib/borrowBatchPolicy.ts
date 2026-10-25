// Independent, deliberately narrow decoder for Circle Adapter.execute. Not a replacement Borrow engine.
// Unknown commands, fee recipients, permits, metadata or dynamic Morpho callbacks are rejected.
import { decodeFunctionData, encodeFunctionData, keccak256, parseAbi, type Hex, type Abi } from 'viem'
import { MAINNET_BORROW_ADAPTER_CONTRACT as ADAPTER, MAINNET_BORROW_CHAIN_ID, MAINNET_BORROW_MORPHO_BLUE as BLUE } from '../config/mainnetBorrow'
import { computeMarketId, type MorphoMarketParams } from './borrowMarketVerification'
import type { BorrowWriteAction } from './borrowWriteSafety'

export const BORROW_ADAPTER_ABI = parseAbi([
  'function execute(((address target,bytes data,uint256 value,address tokenIn,uint256 amountToApprove,address tokenOut,uint256 minTokenOut)[] instructions,(address token,address beneficiary)[] tokens,uint256 execId,uint256 deadline,bytes metadata) params,(uint8 permitType,address token,uint256 amount,bytes permitCalldata)[] tokenInputs,bytes signature) payable',
])
export const BORROW_MORPHO_ABI = parseAbi([
  'function setAuthorization(address authorized,bool newIsAuthorized)',
  'function supplyCollateral((address loanToken,address collateralToken,address oracle,address irm,uint256 lltv) marketParams,uint256 assets,address onBehalf,bytes data)',
  'function borrow((address loanToken,address collateralToken,address oracle,address irm,uint256 lltv) marketParams,uint256 assets,uint256 shares,address onBehalf,address receiver)',
  'function repay((address loanToken,address collateralToken,address oracle,address irm,uint256 lltv) marketParams,uint256 assets,uint256 shares,address onBehalf,bytes data)',
  'function withdrawCollateral((address loanToken,address collateralToken,address oracle,address irm,uint256 lltv) marketParams,uint256 assets,address onBehalf,address receiver)',
])
export const BORROW_TOKEN_ABI = parseAbi(['function approve(address spender,uint256 amount) returns(bool)'])
export type BorrowCall = { to: Hex; data: Hex; value?: bigint }
export type BorrowBatchReview = {
  chainId: number; owner: Hex; marketId: Hex; market: MorphoMarketParams; kind: BorrowWriteAction['kind']
  collateralIn: bigint; collateralOut: bigint; borrowAssets: bigint; repayAssets: bigint; repayShares: bigint
  // Snapshot shares are necessary to prove full close without an invented debt estimate.
  maxGasCostWei: bigint; minHealthFactor: number; startingAllowances: Record<string, bigint>; reviewedAt: number; quoteExpiresAt: number
}
const ZERO = '0x0000000000000000000000000000000000000000'
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()
const fail = (code: string): never => { throw new Error(code) }
function canonical<const TAbi extends Abi>(abi: TAbi, data: Hex) {
  const decoded = decodeFunctionData({ abi, data })
  if (encodeFunctionData({ abi: abi as Abi, functionName: decoded.functionName as string, args: decoded.args as readonly unknown[] }).toLowerCase() !== data.toLowerCase()) fail('borrow_noncanonical_calldata')
  return decoded
}
export function borrowBatchCommitment(calls: readonly BorrowCall[]): Hex {
  // Includes native value; key ordering and BigInt representation are fixed.
  return keccak256(new TextEncoder().encode(JSON.stringify(calls.map(c => [c.to.toLowerCase(), c.data.toLowerCase(), String(c.value ?? 0n)]))))
}
export function verifyBorrowAtomicBatch(review: BorrowBatchReview, calls: readonly BorrowCall[], now = Date.now()): { commitment: Hex; deadline: number; validation: 'shape-only' } {
  if (!Number.isFinite(review.minHealthFactor) || review.minHealthFactor <= 1 || review.chainId !== MAINNET_BORROW_CHAIN_ID || now < review.reviewedAt || now >= review.quoteExpiresAt || review.maxGasCostWei <= 0n) fail('borrow_review_expired_or_invalid')
  if (!same(computeMarketId(review.market), review.marketId) || calls.length < 1 || calls.length > 5) fail('borrow_batch_context')
  for (const n of [review.collateralIn, review.collateralOut, review.borrowAssets, review.repayAssets, review.repayShares]) if (n < 0n) fail('borrow_negative_amount')
  if (calls.some(c => (c.value ?? 0n) !== 0n)) fail('borrow_native_value')
  const executeIndex = calls.findIndex(c => same(c.to, ADAPTER))
  if (executeIndex < 0 || calls.filter(c => same(c.to, ADAPTER)).length !== 1) fail('borrow_execution_target')
  const execute = canonical(BORROW_ADAPTER_ABI, calls[executeIndex].data)
  if (execute.functionName !== 'execute') fail('borrow_execution_method')
  const [params, inputs, signature] = execute.args!
  if (params.metadata !== '0x' || signature.length !== 132 || params.deadline <= BigInt(Math.floor(now / 1000)) || params.deadline > BigInt(Math.floor(now / 1000) + 600)) fail('borrow_execution_deadline_or_metadata')
  const add = review.kind === 'add-collateral'
  if (add) { if (executeIndex !== calls.length - 1) fail('borrow_extra_calls') }
  else {
    if (executeIndex < 1 || executeIndex !== calls.length - 2) fail('borrow_authorization_order')
    for (const [index, value] of [[executeIndex - 1, true], [executeIndex + 1, false]] as const) {
      if (!same(calls[index].to, BLUE)) fail('borrow_authorization_target')
      const decoded = canonical(BORROW_MORPHO_ABI, calls[index].data)
      if (decoded.functionName !== 'setAuthorization' || !same(decoded.args[0], ADAPTER) || decoded.args[1] !== value) fail('borrow_authorization_order')
    }
  }
  const spends = new Map<string, bigint>()
  if (review.collateralIn > 0n) spends.set(review.market.collateralToken.toLowerCase(), review.collateralIn)
  if (review.repayAssets > 0n) spends.set(review.market.loanToken.toLowerCase(), review.repayAssets)
  if (inputs.length !== spends.size) fail('borrow_token_inputs')
  const seen = new Set<string>()
  for (const input of inputs) {
    const token = input.token.toLowerCase()
    if (seen.has(token) || input.permitType !== 0 || input.permitCalldata !== '0x' || spends.get(token) !== input.amount) fail('borrow_token_inputs')
    seen.add(token)
  }
  const approvalEnd = add ? executeIndex : executeIndex - 1
  const approved = new Set<string>(), resets = new Set<string>()
  for (let i = 0; i < approvalEnd; i++) {
    const decoded = canonical(BORROW_TOKEN_ABI, calls[i].data), token = calls[i].to.toLowerCase()
    if (decoded.functionName !== 'approve' || !same(decoded.args[0], ADAPTER) || approved.has(token) || !spends.has(token)) fail('borrow_approval_not_exact')
    const prior = review.startingAllowances[token]
    if (prior === undefined || prior < 0n || prior >= spends.get(token)!) fail('borrow_allowance_context')
    if (decoded.args[1] === 0n && prior > 0n && !resets.has(token)) { resets.add(token); continue }
    if (spends.get(token) !== decoded.args[1]) fail('borrow_approval_not_exact')
    approved.add(token)
  }
  for (const [token, amount] of spends) {
    const prior = review.startingAllowances[token]
    if (prior === undefined || prior < 0n || (prior < amount && !approved.has(token)) || (resets.has(token) && !approved.has(token))) fail('borrow_allowance_context')
  }
  const sweeps = new Set<string>()
  for (const t of params.tokens) {
    const token = t.token.toLowerCase()
    if (!same(t.beneficiary, review.owner) || sweeps.has(token) || ![review.market.loanToken.toLowerCase(), review.market.collateralToken.toLowerCase()].includes(token)) fail('borrow_sweep_recipient')
    sweeps.add(token)
  }
  if ((review.borrowAssets > 0n || review.repayAssets > 0n) && !sweeps.has(review.market.loanToken.toLowerCase())) fail('borrow_missing_refund')
  if ((review.collateralIn > 0n || review.collateralOut > 0n) && !sweeps.has(review.market.collateralToken.toLowerCase())) fail('borrow_missing_refund')
  const actual: string[] = []
  for (const instruction of params.instructions) {
    if (!same(instruction.target, BLUE) || instruction.value !== 0n || instruction.minTokenOut !== 0n || !same(instruction.tokenOut, ZERO)) fail('borrow_instruction_target')
    const decoded = canonical(BORROW_MORPHO_ABI, instruction.data)
    if (decoded.functionName === 'setAuthorization') fail('borrow_inner_authorization')
    if (!same(computeMarketId(decoded.args[0] as MorphoMarketParams), review.marketId)) fail('borrow_instruction_market')
    if (decoded.functionName === 'borrow') {
      const [, assets, shares, owner, receiver] = decoded.args
      if (assets !== review.borrowAssets || assets <= 0n || shares !== 0n || !same(owner, review.owner) || !same(receiver, ADAPTER) || instruction.amountToApprove !== 0n || !same(instruction.tokenIn, ZERO)) fail('borrow_amount_or_recipient')
    } else if (decoded.functionName === 'supplyCollateral') {
      const [, assets, owner, data] = decoded.args
      if (assets !== review.collateralIn || assets <= 0n || !same(owner, review.owner) || data !== '0x' || !same(instruction.tokenIn, review.market.collateralToken) || instruction.amountToApprove !== assets) fail('borrow_collateral_in')
    } else if (decoded.functionName === 'repay') {
      const [, assets, shares, owner, data] = decoded.args
      if (!same(owner, review.owner) || data !== '0x' || !same(instruction.tokenIn, review.market.loanToken) || instruction.amountToApprove !== review.repayAssets
        || (review.kind === 'close-loan' ? shares !== review.repayShares || shares <= 0n || assets !== 0n : shares !== 0n || assets !== review.repayAssets || assets <= 0n)) fail('borrow_repay_amount')
    } else if (decoded.functionName === 'withdrawCollateral') {
      const [, assets, owner, receiver] = decoded.args
      if (assets !== review.collateralOut || assets <= 0n || !same(owner, review.owner) || !same(receiver, ADAPTER) || instruction.amountToApprove !== 0n || !same(instruction.tokenIn, ZERO)) fail('borrow_collateral_out')
    }
    actual.push(decoded.functionName)
  }
  const expected = [
    ...(review.collateralIn > 0n ? ['supplyCollateral'] : []),
    ...(review.borrowAssets > 0n ? ['borrow'] : []),
    ...(review.repayAssets > 0n ? ['repay'] : []),
    ...(review.collateralOut > 0n ? ['withdrawCollateral'] : []),
  ]
  const kinds: Record<BorrowWriteAction['kind'], boolean> = {
    borrow: review.borrowAssets > 0n && review.repayAssets === 0n && review.collateralOut === 0n,
    'borrow-more': review.borrowAssets > 0n && review.repayAssets === 0n && review.collateralOut === 0n,
    repay: review.repayAssets > 0n && review.collateralIn === 0n && review.collateralOut === 0n && review.borrowAssets === 0n,
    'close-loan': review.repayAssets > 0n && review.collateralOut > 0n && review.collateralIn === 0n && review.borrowAssets === 0n,
    'add-collateral': review.collateralIn > 0n && review.repayAssets === 0n && review.borrowAssets === 0n && review.collateralOut === 0n,
    'withdraw-collateral': review.collateralOut > 0n && review.collateralIn === 0n && review.borrowAssets === 0n,
  }
  if (!kinds[review.kind] || JSON.stringify(expected) !== JSON.stringify(actual)) fail('borrow_instruction_sequence')
  return { commitment: borrowBatchCommitment(calls), deadline: Number(params.deadline) * 1000, validation: 'shape-only' }
}
// EIP-5792 itself does not carry an enforceable gas ceiling in these SDK call tuples.
// An estimate/simulation must never be promoted into a wallet fee-cap guarantee.
export function assertBorrowFeeBinding(cap: bigint, gasLimit: bigint, maxFeePerGas: bigint, transportEnforcesCap: boolean) {
  if (!transportEnforcesCap || cap <= 0n || gasLimit <= 0n || maxFeePerGas <= 0n || gasLimit * maxFeePerGas > cap) fail('borrow_fee_ceiling_unbound')
}
