import { formatUnits } from 'viem'
import { ARC_TOKENS, type ArcSymbol } from '../uniswapArcPolicy'
import type { AttemptStatus } from '../uniswapArcExecution'
import type { ChainSummary, IntentSummary } from './transactionEvidence'

// How a transaction is worded for the person using the Swap screen: plain sentences, amounts and fees, nothing about calldata or contract
// internals. Two answers are still kept apart underneath (what the network says, and whether the transaction that succeeded is the one the
// user reviewed), and nothing is hidden: a transaction that went through but differs from the Review always says so, in plain words,
// with the amounts that differ. The raw findings (check ids, program summaries, status log) are kept in `technical` for a closed
// "Technical details" disclosure meant for support and diagnosis.
export type Tone = 'neutral' | 'progress' | 'success' | 'warning' | 'danger'
export interface StatusInput {
  status: AttemptStatus; hash?: string; chain?: ChainSummary; intent?: IntentSummary; output?: string; fee?: string
  tokenIn?: ArcSymbol; tokenOut?: ArcSymbol; amountIn?: string
  // What the Review promised, in base units: the guaranteed minimum of the output token and the network fee ceiling (18 decimals).
  reviewedMinimum?: string; feeCeiling?: string
}
export interface Notice { tone: Tone; title: string; lines: string[] }
export interface StatusPresentation {
  headline: string; tone: Tone
  detail: string | null                 // one plain sentence under the headline
  amounts: string | null                // "Paid … · Received … · Network fee …"
  notice: Notice | null                 // a plain warning (the swap differs from the Review, or could not be fully checked)
  short: string                         // one or two words for a compact history row
  retry: boolean                        // true only when the transaction is certain not to have happened and a fresh start is safe
  working: boolean                      // true while a result is still to come: nothing may be sent again
  technical: string[]                   // developer diagnostics (closed by default)
  received: string | null; paid: string | null; fee: string | null
}
const fmt = (value: string | null | undefined, decimals: number) => (value ? formatUnits(BigInt(value), decimals) : null)
const trim = (text: string) => text.replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '')
const money = (value: string | null, symbol: string) => (value ? `${trim(value)} ${symbol}` : null)

// A finding of the verification, put into words a person can act on. A finding that has no plain wording still produces a warning that
// the transaction was not exactly the one reviewed: nothing the verification found is dropped.
function plainFindings(input: StatusInput, receivedText: string | null): string[] {
  const out = input.tokenOut ? ARC_TOKENS[input.tokenOut] : null
  const checks = input.intent?.checks ?? [], differences = input.intent?.differences ?? []
  const lines: string[] = [], consumed = new Set<string>()
  const bad = (id: string) => checks.some(check => check.id === id && check.status === 'mismatch')
  const take = (pattern: RegExp, line: (match: RegExpExecArray) => string) => {
    for (const text of differences) { const match = pattern.exec(text); if (match) { lines.push(line(match)); consumed.add(text) } }
  }
  if (bad('minimum')) {
    const minimum = out && input.reviewedMinimum ? money(trim(formatUnits(BigInt(input.reviewedMinimum), out.decimals)), input.tokenOut as string) : null
    lines.push(`You received ${receivedText ?? 'less than expected'}${minimum ? `, below the minimum of ${minimum} shown in your review` : ', below the minimum shown in your review'}.`)
    for (const text of differences) if (/^The wallet received .* below the reviewed minimum/.test(text)) consumed.add(text)
  }
  take(/([0-9.]+)% of the output/, match => `A fee of ${match[1]}% was taken from the amount you received. It was not part of your review.`)
  take(/only guarantees .* below the reviewed minimum/, () => 'After that fee, the minimum you were guaranteed was lower than the minimum shown in your review.')
  if (bad('fee-fields') || bad('fee-actual')) { lines.push('The network fee was higher than the maximum shown in your review.'); for (const text of differences) if (/network fee/i.test(text)) consumed.add(text) }
  const unexplained = differences.some(text => !consumed.has(text)) || checks.some(check => check.status === 'mismatch' && !['minimum', 'fee-fields', 'fee-actual', 'calldata'].includes(check.id))
  if (unexplained) lines.push('The transaction your wallet sent was not exactly the one you reviewed.')
  if (lines.length === 0 && checks.some(check => check.status === 'unavailable')) lines.push('It could not be compared with the swap you reviewed.')
  return [...new Set(lines)].slice(0, 5)
}

export function statusPresentation(input: StatusInput): StatusPresentation {
  const { status, chain, intent } = input
  const out = input.tokenOut ? ARC_TOKENS[input.tokenOut] : null, inp = input.tokenIn ? ARC_TOKENS[input.tokenIn] : null
  const receivedUnits = chain?.received ?? (status === 'confirmed' || status === 'mismatch' ? input.output ?? null : null)
  const received = out && receivedUnits && receivedUnits !== '0' ? `${fmt(receivedUnits, out.decimals)} ${input.tokenOut}` : null
  const paid = inp && chain?.sent ? `${fmt(chain.sent, inp.decimals)} ${input.tokenIn}` : null
  const feeUnits = chain?.fee ?? (['confirmed', 'failed', 'mismatch'].includes(status) ? input.fee ?? null : null)
  const fee = feeUnits ? `${fmt(feeUnits, 18)} USDC` : null
  const amounts = [paid ? `Paid ${paid}` : null, received ? `Received ${received}` : null, fee ? `Network fee ${fee}` : null].filter(Boolean).join(' · ') || null
  const technical: string[] = []
  if (chain) technical.push(`Chain: ${chain.state === 'success' ? 'transaction succeeded' : 'transaction reverted'} in block ${chain.blockNumber}`)
  if (intent) {
    technical.push(`Review comparison: ${intent.verdict}`)
    for (const check of intent.checks) technical.push(`${check.id} (${check.status}): ${check.detail}`)
    for (const text of intent.differences) technical.push(`difference: ${text}`)
  }
  const base = { amounts, fee, received, paid, technical, notice: null as Notice | null }
  switch (status) {
    case 'awaiting_wallet': return { headline: 'Confirm in your wallet', tone: 'progress', detail: 'Waiting for your approval. Please keep this page open.', short: 'Waiting for wallet', retry: false, working: true, ...base }
    case 'rejected': return { headline: 'Swap cancelled', tone: 'neutral', detail: 'You declined the request in your wallet. Nothing was sent.', short: 'Cancelled', retry: true, working: false, ...base }
    case 'pending': return { headline: 'Verifying transaction', tone: 'progress', detail: 'This usually takes a few seconds. Please don’t send it again.', short: 'Verifying', retry: false, working: true, ...base }
    case 'failed': return { headline: 'Swap failed', tone: 'danger', detail: `The network rejected this transaction, so no tokens were swapped.${fee ? ' Only the network fee was charged.' : ''}`, short: 'Failed', retry: true, working: false, ...base }
    case 'confirmed': {
      const notes = intent?.verdict === 'verified_with_notes'
      return { headline: 'Swap completed', tone: 'success', detail: notes ? 'Your wallet adjusted the network fee slightly; it stayed within the maximum you approved.' : null, short: 'Completed', retry: false, working: false, ...base }
    }
    case 'mismatch': {
      const lines = plainFindings(input, received)
      return { headline: 'Swap completed', tone: 'warning', detail: null, short: 'Completed · differs from review', retry: false, working: false, ...base,
        notice: { tone: 'warning', title: 'This swap differs from your review', lines: lines.length > 0 ? lines : ['The transaction your wallet sent was not exactly the one you reviewed.'] } }
    }
    case 'unknown': default: {
      // The chain may already have answered while the comparison with the Review could not be completed, or the chain itself could not be read.
      if (chain?.state === 'success') return { headline: 'Swap completed', tone: 'warning', detail: null, short: 'Completed · not fully checked', retry: false, working: false, ...base,
        notice: { tone: 'warning', title: 'We couldn’t finish checking this swap against your review', lines: ['The transaction went through on Arc. One check is still missing, so it is not marked as verified.'] } }
      if (input.hash) return { headline: 'Verifying transaction', tone: 'progress', detail: 'We couldn’t read the result just now and will keep checking. Please don’t send it again.', short: 'Verifying', retry: false, working: true, ...base }
      return { headline: 'Waiting for confirmation', tone: 'warning', detail: 'If you approved this in your wallet, the result will show up here. Please don’t send it again.', short: 'Waiting', retry: false, working: true, ...base }
    }
  }
}

export const STATUS_TONE_CLASS: Record<Tone, string> = {
  neutral: 'text-slate-700', progress: 'text-sky-800', success: 'text-[#2F6E0C]', warning: 'text-amber-800', danger: 'text-red-700',
}
export const shortHash = (hash: string) => `${hash.slice(0, 10)}…${hash.slice(-8)}`
