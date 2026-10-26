import { useState } from 'react'
import { ARC_EXECUTION_EXPLORER } from '../lib/uniswapArcExecution'
import { STATUS_TONE_CLASS } from '../lib/swap/presentation'
import { activityTechnical, type ActivityItem } from '../lib/swap/activity'
import { HashLookup } from './HashLookup'

// The swaps of this browser, in plain words. The latest swap is shown in full (what happened, what was paid and received, the fee, and a
// short warning if it differs from what the user reviewed). Earlier swaps are a closed list of one-line summaries that open on demand.
// Nothing is deleted and nothing is hidden: a swap that differs from its Review keeps its warning, a swap that is still being verified is
// counted next to the closed history, and the raw findings live in a closed "Technical details" disclosure for support. The status that is
// known never disappears while the chain is read again: only the small "Checking" marker changes, and its space is reserved.
interface Props {
  latest: ActivityItem | null; earlier: ActivityItem[]; busy: boolean
  onCheck(item: ActivityItem): void
  onRecover?(hash: string): void
  // A fresh start of a swap that certainly did not happen (failed on chain, or declined in the wallet): sets the same swap up again.
  onRetry?(item: ActivityItem): void
  unreadable?: boolean
  // Archived records that today's rules cannot display. They stay in storage untouched.
  archiveUnreadable?: number
}
const PROVIDER_NAME = { uniswap: 'Uniswap', circle: 'Circle' }
// The wallet steps of a Circle swap (permission or approval, then the swap), one plain word each.
const STEP_WORD: Record<string, string> = { confirmed: 'done', pending: 'verifying', awaiting_wallet: 'waiting for wallet', failed: 'failed', rejected: 'cancelled', unknown: 'not confirmed yet', mismatch: 'done, differs from review' }
const when = (at: number) => new Date(at).toISOString().slice(0, 16).replace('T', ' ') + ' UTC'

export function SwapActivityPanel({ latest, earlier, busy, onCheck, onRecover, onRetry, unreadable, archiveUnreadable = 0 }: Props) {
  const [recovery, setRecovery] = useState('')
  const verifying = earlier.filter(item => item.presentation.working).length, differing = earlier.filter(item => item.presentation.notice !== null).length
  const needsHash = latest !== null && ((latest.status === 'unknown' && !latest.hash) || latest.live?.replaced === true) && !latest.live?.walletRequestOpen && onRecover !== undefined
  return <section aria-label="Swap transactions" className="space-y-3 rounded-2xl border border-slate-200 bg-white p-4 text-sm shadow-sm">
    <h2 className="text-base font-semibold text-slate-900">Your swaps</h2>
    {unreadable && <p role="status" className="text-amber-800">Some saved records couldn’t be read. New swaps stay protected.</p>}
    {archiveUnreadable > 0 && <p role="status" className="text-xs text-slate-500">{archiveUnreadable} older {archiveUnreadable === 1 ? 'record is' : 'records are'} kept in this browser but can’t be displayed by this version. Nothing was deleted.</p>}
    {latest && <Record item={latest} busy={busy} onCheck={onCheck} onRetry={onRetry} level="latest"
      extra={needsHash ? <div className="space-y-2">
        <label className="block">{latest.live?.replaced ? 'Hash of the replacement transaction' : 'Transaction hash from your wallet'}<input aria-label="Recover transaction hash" value={recovery} onChange={event => setRecovery(event.target.value)} maxLength={66} className="mt-1 w-full rounded-lg border border-slate-300 p-2" /></label>
        <button type="button" onClick={() => onRecover?.(recovery)} className="underline">Verify and track hash</button></div> : null} />}
    <HashLookup />
    {earlier.length > 0 && <details aria-label="Swap history" className="rounded-xl border border-slate-100 p-3">
      <summary className="cursor-pointer font-medium text-slate-800">History · {earlier.length} earlier {earlier.length === 1 ? 'swap' : 'swaps'}{verifying > 0 ? ` · ${verifying} still being verified` : ''}{differing > 0 ? ` · ${differing} differ${differing === 1 ? 's' : ''} from the review` : ''}</summary>
      <p className="mt-2 text-xs text-slate-500">Saved in this browser. Nothing is deleted. Open a swap to see more.</p>
      <ul className="mt-2 space-y-1">{earlier.map(item => <li key={item.key}><details aria-label={`Swap ${item.id.slice(0, 8)}`} className="rounded-lg border border-slate-100 px-2 py-1">
        <summary className="flex cursor-pointer flex-wrap items-baseline justify-between gap-x-3 text-slate-800">
          <span><span className={`font-medium ${STATUS_TONE_CLASS[item.presentation.tone]}`}>{item.presentation.short}</span> · {item.title}{item.kind === 'approval' ? '' : ` · ${PROVIDER_NAME[item.provider]}`}</span>
          <span className="text-xs text-slate-500">{when(item.createdAt)}</span>
        </summary>
        <Record item={item} busy={busy} onCheck={onCheck} level="history" />
      </details></li>)}</ul>
    </details>}
  </section>
}

function Record({ item, busy, onCheck, onRetry, level, extra }: { item: ActivityItem; busy: boolean; onCheck(item: ActivityItem): void; onRetry?(item: ActivityItem): void; level: 'latest' | 'history'; extra?: React.ReactNode }) {
  const p = item.presentation, checking = item.live?.checking === true
  const technical = activityTechnical(item)
  const canCheck = (item.hash || item.trackable) && !item.archived && !item.live?.walletRequestOpen && item.status !== 'awaiting_wallet' && (p.working || item.status === 'unknown' || Boolean(item.live?.error))
  return <article aria-label={level === 'latest' ? 'Latest transaction' : `Transaction ${item.id.slice(0, 8)}`} className={`space-y-1 ${level === 'history' ? 'pt-2' : ''}`}>
    {level === 'latest' && <div className="flex min-h-[1.5rem] items-start justify-between gap-3">
      <p role="status" className={`font-semibold ${STATUS_TONE_CLASS[p.tone]}`}>{p.headline}</p>
      <span aria-live="polite" className="min-w-[5.5rem] shrink-0 text-right text-xs text-slate-500">{checking ? 'Checking…' : ''}</span>
    </div>}
    {level === 'history' && <p className={`font-semibold ${STATUS_TONE_CLASS[p.tone]}`}>{p.headline}{checking ? <span className="ml-2 text-xs font-normal text-slate-500">Checking…</span> : null}</p>}
    {level === 'latest' && <p className="text-slate-700">{item.title}{item.kind === 'approval' ? '' : ` · ${PROVIDER_NAME[item.provider]}`}</p>}
    {item.status === 'awaiting_wallet' && item.live?.walletWindowMs !== undefined && <p>Approve within about {Math.floor(item.live.walletWindowMs / 1000)} seconds. If the window closes, cancel the request in your wallet; this page can’t cancel it.</p>}
    {p.detail && <p className="text-slate-700">{p.detail}</p>}
    {p.amounts && <p className="text-slate-800">{p.amounts}</p>}
    {item.steps && item.steps.length > 0 && <ul aria-label="Wallet steps" className="flex flex-wrap gap-x-4 text-xs text-slate-600">{item.steps.map((step, index) => <li key={`${step.label}-${index}`}>{step.label}: {STEP_WORD[step.status] ?? step.status}</li>)}</ul>}
    {p.notice && <div role="note" className="space-y-1 rounded-lg border border-amber-200 bg-amber-50 p-2 text-amber-900">
      <p className="font-medium">{p.notice.title}</p>
      <ul className="list-disc space-y-0.5 pl-5 text-xs">{p.notice.lines.map(line => <li key={line}>{line}</li>)}</ul>
    </div>}
    {item.live?.error && <p role="alert" className="break-words text-xs text-amber-800">{item.live.error}</p>}
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
      {item.again && onRetry && <button type="button" onClick={() => onRetry(item)} disabled={busy} className="rounded-lg border border-[#2F6E0C] px-3 py-1 font-medium text-[#2F6E0C] disabled:opacity-50">Try again</button>}
      {canCheck && <button type="button" disabled={busy || checking} onClick={() => onCheck(item)} className="underline disabled:opacity-50">Check status</button>}
      {item.hash && <a href={ARC_EXECUTION_EXPLORER + item.hash} target="_blank" rel="noopener noreferrer" className="text-[#2F6E0C] underline">View on Arc Explorer</a>}
    </div>
    {extra}
    <details className="text-xs text-slate-500"><summary className="cursor-pointer">Technical details</summary>
      <ul className="mt-1 space-y-1 break-words">{technical.map((line, index) => <li key={`${index}-${line.slice(0, 24)}`}>{line}</li>)}</ul></details>
  </article>
}
