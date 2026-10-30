import { ExternalLink } from 'lucide-react'
import type { BridgeHistoryItem } from '../lib/bridgeHistory'

const tone: Record<BridgeHistoryItem['status'], string> = {
  complete: 'bg-[#eef7e8] text-[#2F6E0C]', action: 'bg-amber-100 text-amber-800', in_progress: 'bg-sky-50 text-sky-800',
  failed: 'bg-red-50 text-red-700', unknown: 'bg-slate-100 text-slate-600',
}
const familyLabel = { evm: 'EVM', solana: 'Solana', sui: 'Sui' } as const

// Shared, read-only transfer list (Dashboard and Activity show the same rows and statuses).
export default function BridgeHistoryList({ items, empty, limit = 30 }: { items: BridgeHistoryItem[]; empty: string; limit?: number }) {
  if (!items.length) return <p className="py-8 text-center text-sm text-slate-500">{empty}</p>
  return <ul aria-label="Bridge transfers" className="mt-4 space-y-3">
    {items.slice(0, limit).map(item => <li key={item.key} aria-label="Bridge transfer" className="rounded-xl border border-slate-200 bg-[#f8faf7] p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-semibold">{item.from} → {item.to} · {item.amount} USDC</p>
          <p className="text-xs text-slate-500">{familyLabel[item.family]} bridge · {item.timestampKind === 'started' ? '' : 'last checked '}{new Date(item.timestamp).toLocaleString()}</p>
          <p className="mt-1 text-[11px] text-slate-400">{item.verification === 'session' ? `Verified on chain at ${new Date(item.verifiedAt!).toLocaleTimeString()}` : 'Saved status in this browser · not re-checked now'}</p>
          {item.refund && <p className="mt-2 text-xs font-medium text-amber-700">Refundable deposit: {item.refund}</p>}
        </div>
        <div className="flex flex-col items-end gap-2">
          <span className={`rounded-full px-2.5 py-1 text-[11px] font-medium ${tone[item.status]}`}>{item.statusLabel}</span>
          <div className="flex flex-wrap justify-end gap-2 text-[11px]">
            {item.sourceUrl && <a href={item.sourceUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-blue-600 hover:underline">Source <ExternalLink size={11} /></a>}
            {item.destinationUrl ? <a href={item.destinationUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-blue-600 hover:underline">Destination <ExternalLink size={11} /></a> : item.status === 'complete' && <span className="text-slate-400">Destination tx not found yet</span>}
          </div>
        </div>
      </div>
    </li>)}
  </ul>
}
