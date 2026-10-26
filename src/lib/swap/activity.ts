import { formatUnits } from 'viem'
import { ARC_TOKENS, type ArcSymbol } from '../uniswapArcPolicy'
import type { AttemptStatus, StatusLogEntry, StoredHistory, SwapAttempt } from '../uniswapArcExecution'
import type { ApprovalAttempt, StoredApprovals } from './uniswapApprovals'
import type { CircleSwapAttempt, StoredCircleHistory } from './circleSwap'
import { statusPresentation, type StatusPresentation } from './presentation'
import type { SwapProviderId } from './tokens'

// One list for everything a wallet has asked this app to send: swaps (Uniswap, and Circle when present) and the approvals that
// precede them. Built only from the records stored in this browser, so the list is available without a connected wallet, on another
// network and whichever provider or pair is selected. Records are read, never edited or removed.
export interface ActivityLive { checking?: boolean; error?: string; walletRequestOpen?: boolean; walletWindowMs?: number; replaced?: boolean; diagnostic?: string }
export interface ActivityStep { label: string; status: string; fee: string | null; hash?: string }
export interface ActivityItem {
  key: string; id: string; kind: 'swap' | 'approval'; provider: SwapProviderId; owner: string; createdAt: number
  status: AttemptStatus; hash?: string; title: string; presentation: StatusPresentation; log: StatusLogEntry[]; note?: string; live?: ActivityLive
  // Circle swaps are several wallet steps (a permit or approval, then the swap); each is listed with its own state and fee.
  steps?: ActivityStep[]
  // The chain can be asked about this record: it has a swap/approval hash, or a Circle approval was submitted and the swap not yet.
  trackable?: boolean
  // What a fresh start would be (only for a swap that certainly did not happen): the same pair and amount with the same provider.
  again?: { provider: SwapProviderId; tokenIn: ArcSymbol; tokenOut: ArcSymbol; amount: string }
  // Moved out of the active journal when it filled up. Still stored and shown; it is settled and is not re-read from the chain.
  archived?: boolean
}
const amountText = (units: string, symbol: keyof typeof ARC_TOKENS) => `${formatUnits(BigInt(units), ARC_TOKENS[symbol].decimals)} ${symbol}`
const stamp = (at: number) => new Date(at).toISOString().slice(0, 19).replace('T', ' ') + ' UTC'
// Everything the plain view leaves out, for the closed "Technical details" disclosure: wallet, hash, raw findings, the status log.
export function activityTechnical(item: ActivityItem): string[] {
  return [`Wallet: ${item.owner}`, ...(item.hash ? [`Transaction: ${item.hash}`] : []), ...item.presentation.technical,
    ...(item.steps ?? []).map(step => `step: ${step.label} · ${step.status}${step.fee ? ` · fee ${step.fee}` : ''}${step.hash ? ` · ${step.hash}` : ''}`),
    ...(item.live?.diagnostic ? [`diagnostic: ${item.live.diagnostic}`] : []),
    ...item.log.map(entry => `${stamp(entry.at)} · ${entry.status} · ${entry.note}`)]
}

export function swapActivity(attempt: SwapAttempt, provider: SwapProviderId = 'uniswap'): ActivityItem {
  const r = attempt.review.request
  const presentation = statusPresentation({ status: attempt.status, hash: attempt.hash, chain: attempt.chain, intent: attempt.intent, output: attempt.output, fee: attempt.fee, tokenIn: r.tokenIn, tokenOut: r.tokenOut, amountIn: r.amount,
    reviewedMinimum: attempt.review.requiredMinimum, feeCeiling: attempt.review.networkFee })
  return { key: `${provider}:swap:${attempt.id}`, id: attempt.id, kind: 'swap', provider, owner: r.owner, createdAt: attempt.createdAt, status: attempt.status, hash: attempt.hash,
    title: `${r.amount} ${r.tokenIn} → ${r.tokenOut}`, log: attempt.log ?? [], presentation, again: presentation.retry ? { provider, tokenIn: r.tokenIn, tokenOut: r.tokenOut, amount: r.amount } : undefined }
}
export function circleActivity(attempt: CircleSwapAttempt): ActivityItem {
  const r = attempt.review.request
  const stepLabel = (kind: string) => (kind === 'permit' ? 'Permission signature' : kind === 'approve' ? 'Approval' : 'Swap transaction')
  const presentation = statusPresentation({ status: attempt.status, hash: attempt.hash, chain: attempt.chain, intent: attempt.intent, output: attempt.output, fee: attempt.fee, tokenIn: r.tokenIn, tokenOut: r.tokenOut, amountIn: r.amount,
    reviewedMinimum: attempt.review.requiredMinimum, feeCeiling: attempt.review.networkFee })
  return { key: `circle:swap:${attempt.id}`, id: attempt.id, kind: 'swap', provider: 'circle', owner: r.owner, createdAt: attempt.createdAt, status: attempt.status, hash: attempt.hash,
    title: `${r.amount} ${r.tokenIn} → ${r.tokenOut}`, log: attempt.log ?? [],
    trackable: Boolean(attempt.hash || attempt.steps.some(step => step.hash && step.status === 'pending')),
    steps: attempt.steps.map(step => ({ label: stepLabel(step.kind), status: step.status, fee: step.fee ? `${formatUnits(BigInt(step.fee), 18)} USDC` : null, hash: step.hash })),
    presentation, again: presentation.retry ? { provider: 'circle', tokenIn: r.tokenIn, tokenOut: r.tokenOut, amount: r.amount } : undefined }
}
export function approvalActivity(attempt: ApprovalAttempt): ActivityItem {
  const step = attempt.step
  const presentation = approvalPresentation(attempt)
  return { key: `uniswap:approval:${attempt.id}`, id: attempt.id, kind: 'approval', provider: 'uniswap', owner: attempt.owner, createdAt: attempt.createdAt, status: attempt.status, hash: attempt.hash,
    title: step.kind === 'token' ? `Approval · let Uniswap use ${amountText(step.amount, step.token)}` : `Approval · let the Uniswap router use ${amountText(step.amount, step.token)}`, log: attempt.log ?? [], note: attempt.note, presentation }
}
function approvalPresentation(attempt: ApprovalAttempt): StatusPresentation {
  const fee = attempt.fee ? `${formatUnits(BigInt(attempt.fee), 18)} USDC` : null
  const amounts = fee ? `Network fee ${fee}` : null
  const technical = attempt.note ? [`note: ${attempt.note}`] : []
  const base = { received: null, paid: null, fee, amounts, technical, notice: null as StatusPresentation['notice'], retry: false }
  switch (attempt.status) {
    case 'awaiting_wallet': return { headline: 'Confirm in your wallet', tone: 'progress', detail: 'Waiting for your approval of this one-time permission.', short: 'Waiting for wallet', working: true, ...base }
    case 'rejected': return { headline: 'Approval cancelled', tone: 'neutral', detail: 'You declined the request in your wallet. Nothing was sent.', short: 'Cancelled', working: false, ...base }
    case 'pending': return { headline: 'Verifying approval', tone: 'progress', detail: 'This usually takes a few seconds. Please don’t send it again.', short: 'Verifying', working: true, ...base }
    case 'failed': return { headline: 'Approval failed', tone: 'danger', detail: 'The network rejected this approval. You can start it again below.', short: 'Failed', working: false, ...base }
    case 'confirmed': return { headline: 'Approval completed', tone: 'success', detail: null, short: 'Completed', working: false, ...base }
    case 'mismatch': return { headline: 'Approval completed', tone: 'warning', detail: null, short: 'Completed · differs from review', working: false, ...base,
      notice: { tone: 'warning', title: 'This approval differs from your review', lines: [/allowance/i.test(attempt.note ?? '') ? 'The permission on chain is not exactly the amount you approved.' : 'The transaction your wallet sent was not exactly the approval you reviewed.'] } }
    default: return { headline: attempt.hash ? 'Verifying approval' : 'Waiting for confirmation', tone: 'warning', detail: 'We couldn’t read the result just now. Please don’t approve again until it is settled.', short: 'Verifying', working: true, ...base }
  }
}
export function storedSwapActivity(stored: StoredHistory[], provider: SwapProviderId = 'uniswap'): ActivityItem[] { return stored.flatMap(history => [...history.attempts.map(a => swapActivity(a, provider)), ...(history.archived ?? []).map(a => ({ ...swapActivity(a, provider), archived: true }))]) }
export function storedCircleActivity(stored: StoredCircleHistory[]): ActivityItem[] { return stored.flatMap(history => [...history.attempts.map(circleActivity), ...(history.archived ?? []).map(a => ({ ...circleActivity(a), archived: true }))]) }
export function storedApprovalActivity(stored: StoredApprovals[]): ActivityItem[] { return stored.flatMap(history => [...history.attempts.map(approvalActivity), ...(history.archived ?? []).map(a => ({ ...approvalActivity(a), archived: true }))]) }

// The latest item is the one in progress (or just settled) in this session, otherwise the newest record. Everything else is history.
// An item never appears twice: not as the latest and again in the history.
export function splitActivity(items: ActivityItem[], activeKey: string | null, wallet?: string): { latest: ActivityItem | null; earlier: ActivityItem[] } {
  const unique = new Map<string, ActivityItem>()
  for (const item of items) unique.set(item.key, item)
  const all = [...unique.values()].sort((a, b) => b.createdAt - a.createdAt)
  const active = activeKey ? all.find(item => item.key === activeKey) : undefined
  const mine = wallet ? all.find(item => item.owner.toLowerCase() === wallet.toLowerCase()) : undefined
  const latest = active ?? mine ?? all[0] ?? null
  return { latest, earlier: all.filter(item => item !== latest) }
}
export const unresolvedActivity = (item: ActivityItem) => ['awaiting_wallet', 'pending', 'unknown'].includes(item.status)
