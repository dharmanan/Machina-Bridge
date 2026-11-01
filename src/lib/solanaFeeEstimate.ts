import { parseUnits } from 'viem'

// Fee quotes authorize a fee cap, not Fast settlement or a guaranteed receive amount.
export const SOLANA_FEE_ESTIMATE_MAX_AGE_MS = 60_000
export type SolanaFeeBinding = { direction: string; evmWallet: string; solanaWallet: string; checkedAt: number }
type Quote = { amount: string; bridgeFee: string; binding?: SolanaFeeBinding }
type Intent = { direction: string; amount: string; evmWallet?: string | null; solanaWallet?: string | null }
const decimal = (v: unknown): v is string => typeof v === 'string' && /^\d+(\.\d{1,6})?$/.test(v)

export function solanaFeeEstimateIssue(quote: Quote | null | undefined, intent: Intent, now = Date.now()): string | null {
  if (!quote?.binding) return 'A current fee estimate is required. Recalculate fees before reviewing this transfer.'
  const b = quote.binding
  if (b.direction !== intent.direction || !intent.evmWallet || !intent.solanaWallet
    || b.evmWallet.toLowerCase() !== intent.evmWallet.toLowerCase() || b.solanaWallet !== intent.solanaWallet
    || quote.amount !== intent.amount) return 'The fee estimate belongs to a different transfer or wallet. Recalculate fees.'
  if (!Number.isFinite(b.checkedAt) || b.checkedAt > now || now - b.checkedAt >= SOLANA_FEE_ESTIMATE_MAX_AGE_MS)
    return 'The fee estimate expired. Recalculate fees and review again.'
  if (!decimal(quote.bridgeFee) || !decimal(intent.amount) || parseUnits(intent.amount, 6) <= 0n
    || parseUnits(quote.bridgeFee, 6) >= parseUnits(intent.amount, 6)) return 'The fee estimate is invalid. Recalculate fees.'
  return null // a validated "0" is valid; a missing/failed estimate is not zero
}

export function assertSolanaFeeEstimate(quote: Quote | null | undefined, intent: Intent): bigint {
  const issue = solanaFeeEstimateIssue(quote, intent)
  if (issue) throw new Error(issue)
  return parseUnits(quote!.bridgeFee, 6)
}

// The SDK omits a fulfilled zero-fee entry, but represents a failed fee lookup with
// amount:null/error. Never let the existing display normalizer turn that failure into zero.
export function validateSolanaSdkFees(estimate: unknown): void {
  const fees = (estimate as { fees?: unknown })?.fees
  if (!Array.isArray(fees) || fees.some(f => !f || f.error != null || f.token !== 'USDC' || !decimal(f.amount)))
    throw new Error('Circle did not return a valid fee estimate. Recalculate fees.')
}
