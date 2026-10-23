import { formatUnits } from 'viem'
import { ARC_TOKENS, type ArcSymbol } from '../uniswapArcPolicy'
import type { AttemptStatus } from '../uniswapArcExecution'
import type { ChainSummary, IntentSummary } from './transactionEvidence'

// How a transaction's state is worded. Two separate answers are always kept apart:
//   chain   what the network says (pending, succeeded, reverted)
//   review  whether the transaction that succeeded is the one the user reviewed and approved
// "Confirmed" is used only when both hold. A chain success that cannot be matched to the Review is shown as exactly that.
export type Tone = 'neutral' | 'progress' | 'success' | 'warning' | 'danger'
export interface StatusInput {
  status: AttemptStatus; hash?: string; chain?: ChainSummary; intent?: IntentSummary; output?: string; fee?: string
  tokenIn?: ArcSymbol; tokenOut?: ArcSymbol; amountIn?: string
}
export interface StatusPresentation {
  headline: string; tone: Tone
  chain: { label: string; tone: Tone } | null
  review: { label: string; tone: Tone; details: string[] } | null
  received: string | null; paid: string | null; fee: string | null
}
const fmt = (value: string | null | undefined, decimals: number) => (value ? formatUnits(BigInt(value), decimals) : null)

export function statusPresentation(input: StatusInput): StatusPresentation {
  const { status, chain, intent } = input
  const out = input.tokenOut ? ARC_TOKENS[input.tokenOut] : null, inp = input.tokenIn ? ARC_TOKENS[input.tokenIn] : null
  const receivedUnits = chain?.received ?? (status === 'confirmed' || status === 'mismatch' ? input.output ?? null : null)
  const received = out && receivedUnits && receivedUnits !== '0' ? `${fmt(receivedUnits, out.decimals)} ${input.tokenOut}` : null
  const paid = inp && chain?.sent ? `${fmt(chain.sent, inp.decimals)} ${input.tokenIn}` : null
  const feeUnits = chain?.fee ?? (['confirmed', 'failed', 'mismatch'].includes(status) ? input.fee ?? null : null)
  const fee = feeUnits ? `${fmt(feeUnits, 18)} USDC` : null
  const none = { chain: null, review: null }
  const base = { received, paid, fee }
  switch (status) {
    case 'awaiting_wallet': return { headline: 'Awaiting wallet confirmation', tone: 'progress', ...none, ...base }
    case 'rejected': return { headline: 'Wallet request rejected', tone: 'neutral', ...none, ...base }
    case 'pending': return { headline: 'Pending — waiting for Arc', tone: 'progress', chain: { label: 'Blockchain: not yet final', tone: 'progress' }, review: null, ...base }
    case 'failed': return { headline: 'Failed — transaction reverted', tone: 'danger', chain: { label: 'Blockchain: transaction reverted', tone: 'danger' }, review: null, ...base }
    case 'confirmed': {
      const notes = intent?.verdict === 'verified_with_notes'
      return { headline: 'Confirmed', tone: 'success', chain: { label: 'Blockchain transaction successful', tone: 'success' },
        review: { label: notes ? 'Matches your Review (wallet adjusted gas fields within the approved fee ceiling)' : 'Matches your Review', tone: 'success', details: [] }, ...base }
    }
    case 'mismatch': {
      const differences = intent?.differences ?? []
      return { headline: 'Blockchain transaction successful — not verified against your Review', tone: 'warning', chain: { label: 'Blockchain transaction successful', tone: 'success' },
        review: { label: 'Not verified: the transaction that succeeded differs from the Review you approved', tone: 'warning', details: differences }, ...base }
    }
    case 'unknown': default: {
      // The chain may already have answered while the Review comparison could not be completed, or the chain itself could not be read.
      if (chain?.state === 'success') return { headline: 'Blockchain transaction successful — Review verification incomplete', tone: 'warning', chain: { label: 'Blockchain transaction successful', tone: 'success' },
        review: { label: 'Review verification incomplete: evidence is missing, nothing is claimed', tone: 'warning', details: intent?.differences ?? [] }, ...base }
      return { headline: 'Status not yet verified', tone: 'warning', chain: { label: 'Blockchain: status could not be read yet', tone: 'warning' }, review: null, ...base }
    }
  }
}

export const STATUS_TONE_CLASS: Record<Tone, string> = {
  neutral: 'text-slate-700', progress: 'text-sky-800', success: 'text-[#2F6E0C]', warning: 'text-amber-800', danger: 'text-red-700',
}
export const shortHash = (hash: string) => `${hash.slice(0, 10)}…${hash.slice(-8)}`
