import type { Hex } from 'viem'
import { borrowBatchCommitment, verifyBorrowAtomicBatch, type BorrowBatchReview, type BorrowCall } from './borrowBatchPolicy'
import { decimalToUnits, type BorrowWriteAction, type PreparedBorrowQuote } from './borrowWriteSafety'
import { MAINNET_BORROW_MAX_LTV } from '../config/mainnetBorrow'

const issued = new WeakSet<object>()
export type BorrowSettlementProof = Readonly<{ owner: string; chainId: number; scopeId: string; status: 'verified' | 'failed'; txHash: Hex; gasCostWei: bigint; blockHash: Hex; terms: Readonly<BorrowBatchReview> }>
export type BorrowSettlementEvidence = {
  txHash: Hex; chainId: number; sender: string; decodedCalls: readonly BorrowCall[]
  receipt: { transactionHash: Hex; status: 'success' | 'reverted'; gasUsed: bigint; effectiveGasPrice: bigint; blockHash: Hex }
  // These are independently read chain facts, not the SDK's confirmed flag. A reader unable to reconstruct the
  // smart-account batch or its position/HF must return unknown instead of inventing these facts.
  canonicalBlockHash: Hex; scopeId: string; owner: string; marketId: string
  before: { collateral: bigint; debtShares: bigint }
  after: { collateral: bigint; debtShares: bigint; healthFactor: number | null; ltv: number | null }
  morphoEventsVerified: boolean
}
export function verifyBorrowSettlement(review: BorrowBatchReview, scopeId: string, calls: readonly BorrowCall[], e: BorrowSettlementEvidence): BorrowSettlementProof | null {
  try { verifyBorrowAtomicBatch(review, calls, review.reviewedAt) } catch { return null }
  const terms = Object.freeze(structuredClone(review))
  const equal = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()
  if (!/^0x[0-9a-fA-F]{64}$/.test(e.txHash) || !/^0x[0-9a-fA-F]{64}$/.test(e.receipt.blockHash)
    || !equal(e.txHash, e.receipt.transactionHash) || !equal(e.receipt.blockHash, e.canonicalBlockHash)
    || !equal(e.owner, review.owner) || !equal(e.sender, review.owner) || e.chainId !== review.chainId || !equal(e.marketId, review.marketId)
    || e.scopeId !== scopeId || borrowBatchCommitment(e.decodedCalls) !== borrowBatchCommitment(calls)) return null
  if (e.receipt.gasUsed <= 0n || e.receipt.effectiveGasPrice <= 0n) return null
  const gasCostWei = e.receipt.gasUsed * e.receipt.effectiveGasPrice
  if (gasCostWei > review.maxGasCostWei) return null
  if (e.receipt.status === 'reverted') {
    if (e.after.collateral !== e.before.collateral || e.after.debtShares !== e.before.debtShares) return null
    const proof = Object.freeze({ owner: e.owner.toLowerCase(), chainId: e.chainId, scopeId, status: 'failed' as const, txHash: e.txHash, gasCostWei, blockHash: e.receipt.blockHash, terms })
    issued.add(proof); return proof
  }
  if (!e.morphoEventsVerified || e.after.collateral !== e.before.collateral + review.collateralIn - review.collateralOut) return null
  if (e.after.healthFactor !== null && (!Number.isFinite(e.after.healthFactor) || e.after.healthFactor <= 0)) return null
  if (e.after.ltv !== null && (!Number.isFinite(e.after.ltv) || e.after.ltv < 0)) return null
  const { kind } = review
  if ((kind === 'borrow' || kind === 'borrow-more') && (e.after.debtShares <= e.before.debtShares || e.after.healthFactor === null || e.after.healthFactor < review.minHealthFactor || e.after.ltv === null || e.after.ltv > MAINNET_BORROW_MAX_LTV)) return null
  if ((kind === 'repay' || kind === 'close-loan') && e.after.debtShares >= e.before.debtShares) return null
  if (kind === 'close-loan' && (e.after.debtShares !== 0n || e.after.collateral !== 0n)) return null
  if (kind === 'add-collateral' && e.after.debtShares !== e.before.debtShares) return null
  if (kind === 'withdraw-collateral' && (e.after.debtShares > e.before.debtShares || (e.after.debtShares > 0n && (e.after.healthFactor === null || e.after.healthFactor < review.minHealthFactor)))) return null
  const proof = Object.freeze({ owner: e.owner.toLowerCase(), chainId: e.chainId, scopeId, status: 'verified' as const, txHash: e.txHash, gasCostWei, blockHash: e.receipt.blockHash, terms })
  issued.add(proof)
  return proof
}
export function isBorrowSettlementProof(proof: unknown): proof is BorrowSettlementProof { return typeof proof === 'object' && proof !== null && issued.has(proof) }

// A valid receipt for another quote (even for the same wallet/market) cannot confirm this review.
export function borrowSettlementMatchesQuote(proof: BorrowSettlementProof, action: BorrowWriteAction, prepared: PreparedBorrowQuote, marketId: string, cap: bigint, target: number | null): boolean {
  const t = proof.terms, q = prepared.quote
  if (t.kind !== action.kind || t.marketId.toLowerCase() !== marketId.toLowerCase() || t.maxGasCostWei !== cap || (target !== null && t.minHealthFactor < target)) return false
  // The narrow decoder admits no third-party fee legs. Nonzero service fees need an explicitly decoded binding.
  if ('fees' in q && q.fees.some(f => decimalToUnits(f.amount.amount, f.amount.decimals) !== 0n)) return false
  const units = (v: { amount: string; decimals: number }) => decimalToUnits(v.amount, v.decimals)
  const collateralIn = q.kind === 'borrow' || q.kind === 'add-collateral' ? units(q.collateral) : 0n
  const collateralOut = q.kind === 'close-loan' || q.kind === 'withdraw-collateral' ? units(q.collateral) : 0n
  const borrowAssets = q.kind === 'borrow' ? units(q.loanAsset) : 0n
  const repayAssets = q.kind === 'repay' ? units(q.repayAmount) : q.kind === 'close-loan' || q.kind === 'withdraw-collateral' ? units(q.maxRepayment) : 0n
  return t.collateralIn === collateralIn && t.collateralOut === collateralOut && t.borrowAssets === borrowAssets && t.repayAssets === repayAssets
}
