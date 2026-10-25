// Synthetic, independently encoded batches. These are not captured Circle service payloads.
import { encodeFunctionData, parseUnits } from 'viem'
import { BORROW_ADAPTER_ABI, BORROW_MORPHO_ABI, BORROW_TOKEN_ABI } from '../../../src/lib/borrowBatchPolicy'
import { computeMarketId } from '../../../src/lib/borrowMarketVerification'
import { MAINNET_BORROW_ADAPTER_CONTRACT as ADAPTER, MAINNET_BORROW_MORPHO_BLUE as BLUE } from '../../../src/config/mainnetBorrow'
import { VERIFIED, WALLET } from './operations'
export function batchFixture(kind = 'borrow', now = Date.now(), prepared = null) {
  const market = VERIFIED.details.params, zero = '0x0000000000000000000000000000000000000000'
  const review = { chainId: 5042, owner: WALLET, market, marketId: computeMarketId(market), kind,
    collateralIn: ['borrow', 'borrow-more', 'add-collateral'].includes(kind) ? 100n : 0n,
    collateralOut: ['close-loan', 'withdraw-collateral'].includes(kind) ? kind === 'close-loan' ? 1000n : 100n : 0n,
    borrowAssets: ['borrow', 'borrow-more'].includes(kind) ? 100n : 0n,
    repayAssets: ['repay', 'close-loan'].includes(kind) ? 100n : 0n, repayShares: kind === 'close-loan' ? 100n : 0n,
    minHealthFactor: 1.5, startingAllowances: { [market.loanToken.toLowerCase()]: 0n, [market.collateralToken.toLowerCase()]: 0n },
    maxGasCostWei: 10n ** 18n, reviewedAt: now - 1000, quoteExpiresAt: now + 29000 }
  if (prepared) {
    const q = prepared.quote, units = v => parseUnits(v.amount, v.decimals)
    review.collateralIn = q.kind === 'borrow' || q.kind === 'add-collateral' ? units(q.collateral) : 0n
    review.collateralOut = q.kind === 'close-loan' || q.kind === 'withdraw-collateral' ? units(q.collateral) : 0n
    review.borrowAssets = q.kind === 'borrow' ? units(q.loanAsset) : 0n
    review.repayAssets = q.kind === 'repay' ? units(q.repayAmount) : q.kind === 'close-loan' || q.kind === 'withdraw-collateral' ? units(q.maxRepayment) : 0n
  }
  const instructions = []
  const instruction = (functionName, args, tokenIn = zero, amountToApprove = 0n) => instructions.push({ target: BLUE, data: encodeFunctionData({ abi: BORROW_MORPHO_ABI, functionName, args }), value: 0n, tokenIn, amountToApprove, tokenOut: zero, minTokenOut: 0n })
  if (review.collateralIn) instruction('supplyCollateral', [market, review.collateralIn, WALLET, '0x'], market.collateralToken, review.collateralIn)
  if (review.borrowAssets) instruction('borrow', [market, review.borrowAssets, 0n, WALLET, ADAPTER])
  if (review.repayAssets) instruction('repay', [market, kind === 'close-loan' ? 0n : review.repayAssets, review.repayShares, WALLET, '0x'], market.loanToken, review.repayAssets)
  if (review.collateralOut) instruction('withdrawCollateral', [market, review.collateralOut, WALLET, ADAPTER])
  const tokenInputs = []
  if (review.collateralIn) tokenInputs.push({ permitType: 0, token: market.collateralToken, amount: review.collateralIn, permitCalldata: '0x' })
  if (review.repayAssets) tokenInputs.push({ permitType: 0, token: market.loanToken, amount: review.repayAssets, permitCalldata: '0x' })
  const params = { instructions, tokens: [market.loanToken, market.collateralToken].map(token => ({ token, beneficiary: WALLET })), execId: 1n, deadline: BigInt(Math.floor(now / 1000) + 120), metadata: '0x' }
  const signature = '0x' + '11'.repeat(65)
  const auth = value => ({ to: BLUE, data: encodeFunctionData({ abi: BORROW_MORPHO_ABI, functionName: 'setAuthorization', args: [ADAPTER, value] }) })
  const encode = () => [
    ...tokenInputs.map(t => ({ to: t.token, data: encodeFunctionData({ abi: BORROW_TOKEN_ABI, functionName: 'approve', args: [ADAPTER, t.amount] }) })),
    ...(['add-collateral', 'repay'].includes(kind) ? [] : [auth(true)]),
    { to: ADAPTER, data: encodeFunctionData({ abi: BORROW_ADAPTER_ABI, functionName: 'execute', args: [params, tokenInputs, signature] }) },
    ...(['add-collateral', 'repay'].includes(kind) ? [] : [auth(false)]),
  ]
  return { review, calls: encode(), params, tokenInputs, encode }
}
export function settlementFixture(review, calls, scopeId) {
  const hash = '0x' + 'aa'.repeat(32), blockHash = '0x' + 'bb'.repeat(32)
  return { txHash: hash, chainId: 5042, sender: review.owner, owner: review.owner, marketId: review.marketId, scopeId,
    decodedCalls: calls, canonicalBlockHash: blockHash, receipt: { transactionHash: hash, status: 'success', gasUsed: 100000n, effectiveGasPrice: 1000000000n, blockHash },
    before: { collateral: review.kind === 'close-loan' ? review.collateralOut : 100000000n, debtShares: 100n },
    after: { collateral: (review.kind === 'close-loan' ? review.collateralOut : 100000000n) + review.collateralIn - review.collateralOut, debtShares: review.kind === 'close-loan' ? 0n : review.repayAssets ? 50n : review.borrowAssets ? 200n : 100n, healthFactor: 2, ltv: 0.4 }, morphoEventsVerified: true }
}
