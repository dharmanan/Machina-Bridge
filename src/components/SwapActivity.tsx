import { useState } from 'react'
import { ARC_EXECUTION_EXPLORER } from '../lib/uniswapArcExecution'
import { STATUS_TONE_CLASS, shortHash } from '../lib/swap/presentation'
import { unresolvedActivity, type ActivityItem } from '../lib/swap/activity'
import { HashLookup } from './HashLookup'

// One transactions panel: the latest transaction in full, and every earlier record below it. The status that is known never
// disappears while the chain is being read again: only the small "Checking" marker on the right changes, and its space is reserved
// so nothing on the page moves.
interface Props {
  latest: ActivityItem | null; earlier: ActivityItem[]; busy: boolean
  onCheck(item: ActivityItem): void
  onRecover?(hash: string): void
  unreadable?: boolean
  // Archived records that today's rules cannot display. They stay in storage untouched.
  archiveUnreadable?: number
}
export function SwapActivityPanel({ latest, earlier, busy, onCheck, onRecover, unreadable, archiveUnreadable = 0 }: Props) {
  const [recovery, setRecovery] = useState('')
  const providerName = (item: ActivityItem) => (item.provider === 'uniswap' ? 'Uniswap' : 'Circle Swap Kit')
  return <section aria-label="Swap transactions" className="space-y-3 rounded-2xl border border-slate-200 bg-white p-4 text-sm shadow-sm">
    <h2 className="text-base font-semibold text-slate-900">Transactions · Arc Mainnet</h2>
    {unreadable && <p role="status" className="text-amber-800">Some local records could not be read safely. New submissions remain protected by the transaction journal.</p>}
    {archiveUnreadable > 0 && <p role="status" className="text-xs text-slate-500">{archiveUnreadable} archived {archiveUnreadable === 1 ? 'record is' : 'records are'} kept in this browser but cannot be displayed by this version. Nothing was deleted.</p>}
    {latest && <Card item={latest} busy={busy} onCheck={onCheck} headingLevel="latest"
      extra={((latest.status === 'unknown' && !latest.hash) || latest.live?.replaced === true) && !latest.live?.walletRequestOpen && onRecover ? <div className="space-y-2">
        <label className="block">{latest.live?.replaced ? 'Hash of the replacement transaction' : 'Transaction hash from your wallet'}<input aria-label="Recover transaction hash" value={recovery} onChange={event => setRecovery(event.target.value)} maxLength={66} className="mt-1 w-full rounded-lg border border-slate-300 p-2" /></label>
        <button type="button" onClick={() => onRecover(recovery)} className="underline">Verify and track hash</button></div> : null} />}
    <HashLookup />
    {earlier.length > 0 && <details aria-label="Swap history" className="rounded-xl border border-slate-100 p-3" open={earlier.some(unresolvedActivity)}>
      <summary className="cursor-pointer font-medium text-slate-800">History · {earlier.length} earlier {earlier.length === 1 ? 'record' : 'records'}</summary>
      <p className="mt-2 text-xs text-slate-500">Stored in this browser. Records are never deleted by the app. Recheck reads the chain again.</p>
      <div className="mt-2 space-y-3">{earlier.map(item => <Card key={item.key} item={item} busy={busy} onCheck={onCheck} headingLevel="history" provider={providerName(item)} />)}</div>
    </details>}
  </section>
}
function Card({ item, busy, onCheck, headingLevel, extra, provider }: { item: ActivityItem; busy: boolean; onCheck(item: ActivityItem): void; headingLevel: 'latest' | 'history'; extra?: React.ReactNode; provider?: string }) {
  const p = item.presentation, checking = item.live?.checking === true
  return <article aria-label={headingLevel === 'latest' ? 'Latest transaction' : `Transaction ${item.id.slice(0, 8)}`} className={`space-y-1 ${headingLevel === 'history' ? 'border-t border-slate-100 pt-2' : ''}`}>
    <div className="flex min-h-[1.5rem] items-start justify-between gap-3">
      <p role={headingLevel === 'latest' ? 'status' : undefined} className={`font-semibold ${STATUS_TONE_CLASS[p.tone]}`}>{p.headline}</p>
      <span aria-live="polite" className="min-w-[5.5rem] shrink-0 text-right text-xs text-slate-500">{checking ? 'Checking…' : ''}</span>
    </div>
    <p className="text-slate-700">{item.title}{provider ? ` · ${provider}` : ''}{item.kind === 'approval' ? ' · approval' : ''}</p>
    <p className="break-all text-xs text-slate-500">Wallet: {item.owner}</p>
    {item.status === 'awaiting_wallet' && item.live?.walletWindowMs !== undefined && <p>Approve within at most {Math.floor(item.live.walletWindowMs / 1000)} seconds of the wallet request opening. If the window ends, cancel the request in your wallet. The app cannot cancel it.</p>}
    {p.chain && <p className={STATUS_TONE_CLASS[p.chain.tone]}>{p.chain.label}</p>}
    {p.review && <div className={STATUS_TONE_CLASS[p.review.tone]}>
      <p>{p.review.label}</p>
      {p.review.details.length > 0 && <ul className="mt-1 list-disc space-y-1 pl-5 text-xs">{p.review.details.map(detail => <li key={detail}>{detail}</li>)}</ul>}
    </div>}
    {item.steps && item.steps.length > 0 && <ul aria-label="Wallet steps" className="space-y-0.5 text-xs text-slate-600">{item.steps.map((step, index) => <li key={`${step.label}-${index}`}>{step.label}: {step.status.replace('_', ' ')}{step.fee ? ` · fee ${step.fee}` : ''}</li>)}</ul>}
    {(p.paid || p.received) && <p>{p.paid ? `Paid ${p.paid}` : ''}{p.paid && p.received ? ' · ' : ''}{p.received ? `Received ${p.received}` : ''}</p>}
    {p.fee && <p>Network fee: {p.fee}</p>}
    {item.hash && <a href={ARC_EXECUTION_EXPLORER + item.hash} target="_blank" rel="noopener noreferrer" className="block break-all text-[#2F6E0C] underline">View on Arc Explorer · {headingLevel === 'latest' ? item.hash : shortHash(item.hash)}</a>}
    {item.live?.error && <p role="alert" className="break-words text-xs text-amber-800">{item.live.error}</p>}
    {(item.hash || item.trackable) && !item.archived && !item.live?.walletRequestOpen && (item.status !== 'awaiting_wallet') && <button type="button" disabled={busy || checking} onClick={() => onCheck(item)} className="underline disabled:opacity-50">
      {headingLevel === 'latest' ? 'Check transaction status' : `Recheck ${item.id.slice(0, 8)}`}</button>}
    {item.log.length > 1 && <details className="text-xs text-slate-500"><summary className="cursor-pointer">Status log</summary>
      <ol className="mt-1 space-y-1">{item.log.map((entry, index) => <li key={`${entry.at}-${index}`}>{new Date(entry.at).toISOString().slice(0, 19).replace('T', ' ')} UTC · {entry.status} · {entry.note}</li>)}</ol></details>}
    {extra}
  </article>
}
