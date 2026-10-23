import { formatUnits } from 'viem'
import { ARC_TOKENS } from '../uniswapArcPolicy'
import type { AttemptStatus, StatusLogEntry, StoredHistory, SwapAttempt } from '../uniswapArcExecution'
import type { ApprovalAttempt, StoredApprovals } from './uniswapApprovals'
import type { CircleSwapAttempt, StoredCircleHistory } from './circleSwap'
import { statusPresentation, type StatusPresentation } from './presentation'
import type { SwapProviderId } from './tokens'

// One list for everything a wallet has asked this app to send: swaps (Uniswap, and Circle when present) and the approvals that
// precede them. Built only from the records stored in this browser, so the list is available without a connected wallet, on another
// network and whichever provider or pair is selected. Records are read, never edited or removed.
export interface ActivityLive { checking?: boolean; error?: string; walletRequestOpen?: boolean; walletWindowMs?: number; replaced?: boolean }
export interface ActivityStep { label: string; status: string; fee: string | null; hash?: string }
export interface ActivityItem {
  key: string; id: string; kind: 'swap' | 'approval'; provider: SwapProviderId; owner: string; createdAt: number
  status: AttemptStatus; hash?: string; title: string; presentation: StatusPresentation; log: StatusLogEntry[]; note?: string; live?: ActivityLive
  // Circle swaps are several wallet steps (a permit or approval, then the swap); each is listed with its own state and fee.
  steps?: ActivityStep[]
  // The chain can be asked about this record: it has a swap/approval hash, or a Circle approval was submitted and the swap not yet.
  trackable?: boolean
  // Moved out of the active journal when it filled up. Still stored and shown; it is settled and is not re-read from the chain.
  archived?: boolean
}
const amountText = (units: string, symbol: keyof typeof ARC_TOKENS) => `${formatUnits(BigInt(units), ARC_TOKENS[symbol].decimals)} ${symbol}`

export function swapActivity(attempt: SwapAttempt, provider: SwapProviderId = 'uniswap'): ActivityItem {
  const r = attempt.review.request
  return { key: `${provider}:swap:${attempt.id}`, id: attempt.id, kind: 'swap', provider, owner: r.owner, createdAt: attempt.createdAt, status: attempt.status, hash: attempt.hash,
    title: `${r.amount} ${r.tokenIn} → ${r.tokenOut}`, log: attempt.log ?? [],
    presentation: statusPresentation({ status: attempt.status, hash: attempt.hash, chain: attempt.chain, intent: attempt.intent, output: attempt.output, fee: attempt.fee, tokenIn: r.tokenIn, tokenOut: r.tokenOut, amountIn: r.amount }) }
}
export function circleActivity(attempt: CircleSwapAttempt): ActivityItem {
  const r = attempt.review.request
  const stepLabel = (kind: string) => (kind === 'permit' ? 'Permit signature' : kind === 'approve' ? 'Approval' : 'Swap transaction')
  return { key: `circle:swap:${attempt.id}`, id: attempt.id, kind: 'swap', provider: 'circle', owner: r.owner, createdAt: attempt.createdAt, status: attempt.status, hash: attempt.hash,
    title: `${r.amount} ${r.tokenIn} → ${r.tokenOut}`, log: attempt.log ?? [],
    trackable: Boolean(attempt.hash || attempt.steps.some(step => step.hash && step.status === 'pending')),
    steps: attempt.steps.map(step => ({ label: stepLabel(step.kind), status: step.status, fee: step.fee ? `${formatUnits(BigInt(step.fee), 18)} USDC` : null, hash: step.hash })),
    presentation: statusPresentation({ status: attempt.status, hash: attempt.hash, chain: attempt.chain, intent: attempt.intent, output: attempt.output, fee: attempt.fee, tokenIn: r.tokenIn, tokenOut: r.tokenOut, amountIn: r.amount }) }
}
export function approvalActivity(attempt: ApprovalAttempt): ActivityItem {
  const step = attempt.step
  return { key: `uniswap:approval:${attempt.id}`, id: attempt.id, kind: 'approval', provider: 'uniswap', owner: attempt.owner, createdAt: attempt.createdAt, status: attempt.status, hash: attempt.hash,
    title: step.kind === 'token' ? `Approve ${amountText(step.amount, step.token)} for Permit2` : `Permit2 allowance ${amountText(step.amount, step.token)} for the Router`, log: attempt.log ?? [], note: attempt.note,
    presentation: approvalPresentation(attempt) }
}
function approvalPresentation(attempt: ApprovalAttempt): StatusPresentation {
  const fee = attempt.fee ? `${formatUnits(BigInt(attempt.fee), 18)} USDC` : null
  const base = { received: null, paid: null, fee }
  switch (attempt.status) {
    case 'awaiting_wallet': return { headline: 'Awaiting wallet confirmation', tone: 'progress', chain: null, review: null, ...base }
    case 'rejected': return { headline: 'Wallet request rejected', tone: 'neutral', chain: null, review: null, ...base }
    case 'pending': return { headline: 'Pending — waiting for Arc', tone: 'progress', chain: { label: 'Blockchain: not yet final', tone: 'progress' }, review: null, ...base }
    case 'failed': return { headline: 'Failed — transaction reverted', tone: 'danger', chain: { label: 'Blockchain: transaction reverted', tone: 'danger' }, review: null, ...base }
    case 'confirmed': return { headline: 'Confirmed', tone: 'success', chain: { label: 'Blockchain transaction successful', tone: 'success' }, review: { label: 'Matches your reviewed approval; the chain holds exactly that allowance', tone: 'success', details: [] }, ...base }
    case 'mismatch': return { headline: 'Blockchain transaction successful — not verified against your Review', tone: 'warning', chain: { label: 'Blockchain transaction successful', tone: 'success' },
      review: { label: 'Not verified: the approval on chain is not exactly the approval you reviewed', tone: 'warning', details: attempt.note ? [attempt.note] : [] }, ...base }
    default: return { headline: 'Status not yet verified', tone: 'warning', chain: { label: 'Blockchain: status could not be read yet', tone: 'warning' }, review: null, ...base }
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
