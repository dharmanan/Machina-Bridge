import { useState } from 'react'
import { ExternalLink } from 'lucide-react'
import { MAINNET_NETWORKS } from '../config/mainnetNetworks'
import { SOLANA_MAINNET_CCTP } from '../config/mainnetSolana'
import { useSolanaArcRecovery } from '../hooks/useSolanaArcRecovery'

const mask = (s: string) => `${s.slice(0, 8)}…${s.slice(-6)}`
const SIGNATURE = /^[1-9A-HJ-NP-Za-km-z]{64,90}$/

// Finishes the Arc receive of an existing Solana -> Arc burn. Never burns: it checks the Solana
// source and the Circle message, skips burns already received on Arc, and asks for a receive only
// after the user reviews it and approves it in the wallet.
export default function SolanaArcRecoveryPanel({ evmAddress, phantomAddress, busy }: { evmAddress: string | null | undefined; phantomAddress: string | null | undefined; busy: boolean }) {
  const r = useSolanaArcRecovery(evmAddress, phantomAddress)
  const [pasted, setPasted] = useState('')
  const [manual, setManual] = useState<string[]>([])
  const [reviewed, setReviewed] = useState<Record<string, boolean>>({})
  const [walletChecked, setWalletChecked] = useState<Record<string, boolean>>({})
  const ready = Boolean(evmAddress && phantomAddress)
  const list = [...new Set([...manual, ...r.candidates])]

  return (
    <details className="rounded-2xl border border-slate-200 p-4 text-sm" open={r.candidates.length > 0 || undefined}>
      <summary className="cursor-pointer font-semibold">Recover a Solana → Arc transfer</summary>
      <p className="mt-2 text-xs leading-5 text-slate-500">
        For a Solana burn whose Arc receive did not finish. Connect the Phantom wallet that sent it and the Arc wallet that should receive it.
        This never burns USDC again: it checks the Solana transaction and Circle's message, and if the USDC is already on Arc nothing is sent.
      </p>
      <div className="mt-3 grid gap-2 sm:grid-cols-[1fr_auto_auto]">
        <input aria-label="Solana to Arc recovery source signature" className="min-w-0 rounded-lg border border-slate-200 p-2 font-mono text-xs" placeholder="Solana transaction signature"
          autoComplete="off" spellCheck={false} value={pasted} onChange={e => setPasted(e.target.value)} disabled={busy} />
        <button type="button" className="rounded-lg border border-slate-300 px-3 py-2 text-xs font-semibold disabled:text-slate-400"
          disabled={busy || !ready || !SIGNATURE.test(pasted.trim())}
          onClick={() => { const s = pasted.trim(); setManual(m => [...new Set([s, ...m])]); setPasted(''); void r.check(s) }}>Check</button>
        <button type="button" className="rounded-lg border border-slate-300 px-3 py-2 text-xs font-semibold disabled:text-slate-400"
          disabled={busy || !phantomAddress || r.scan.busy} onClick={() => void r.findOnChain()}>{r.scan.busy ? 'Searching…' : 'Find my Solana burns'}</button>
      </div>
      {!ready && <p className="mt-2 text-xs text-slate-500">Connect both wallets to check a transfer.</p>}
      {r.scan.message && <p className="mt-2 text-xs text-slate-600">{r.scan.message}</p>}

      <ul className="mt-3 space-y-2">
        {list.map(sig => {
          const c = r.checks[sig] ?? {}, res = c.result, open = r.openReceive(sig)
          return (
            <li key={sig} aria-label={`Solana burn ${mask(sig)}`} className="space-y-2 rounded-xl border border-slate-200 p-3 text-xs">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <a href={`${SOLANA_MAINNET_CCTP.explorerUrl}/tx/${sig}`} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 font-mono underline underline-offset-2">{mask(sig)} <ExternalLink size={12} /></a>
                <button type="button" className="rounded-lg border border-slate-300 px-3 py-1.5 font-semibold disabled:text-slate-400" disabled={busy || !ready || c.busy} onClick={() => void r.check(sig)}>
                  {c.busy ? 'Checking…' : res ? 'Check again' : 'Check on chain'}
                </button>
              </div>
              {c.error && <p role="alert" className="rounded-lg bg-amber-50 p-2 leading-5 text-amber-900">{c.error}</p>}
              {c.done && <p className="rounded-lg bg-emerald-50 p-2 leading-5 text-emerald-800">{c.done}</p>}
              {res?.stage === 'waiting_attestation' && <p className="text-slate-600">The Solana burn is confirmed. Circle has not attested it yet; check again in a few minutes.</p>}
              {res?.stage === 'complete' && (
                <p className="rounded-lg bg-emerald-50 p-2 leading-5 text-emerald-800">
                  Already received on Arc ({res.receivedUsdc} USDC). Nothing more to do.
                  {res.destinationTx && <> <a className="underline" target="_blank" rel="noreferrer" href={`${MAINNET_NETWORKS.arc.explorerUrl}/tx/${res.destinationTx}`}>Arc transaction</a></>}
                </p>
              )}
              {res?.stage === 'ready_to_mint' && !c.done && (
                <div className="space-y-2 rounded-lg bg-slate-50 p-2 leading-5">
                  <p className="font-semibold">Not received on Arc yet</p>
                  <dl className="space-y-0.5">
                    <div className="flex justify-between gap-2"><dt className="text-slate-500">Burned on Solana</dt><dd>{res.amount} USDC</dd></div>
                    <div className="flex justify-between gap-2"><dt className="text-slate-500">Circle fee</dt><dd>{res.feeUsdc} USDC</dd></div>
                    <div className="flex justify-between gap-2"><dt className="text-slate-500">You receive on Arc</dt><dd>{res.receivedUsdc} USDC</dd></div>
                    <div className="flex justify-between gap-2"><dt className="text-slate-500">To</dt><dd className="font-mono">{mask(res.evmOwner)}</dd></div>
                  </dl>
                  {open ? (
                    <div className="space-y-2">
                      <p className="text-amber-900">An earlier receive request from this browser has no known outcome. Check your EVM wallet activity first.</p>
                      <label className="flex items-start gap-2"><input type="checkbox" checked={!!walletChecked[sig]} onChange={e => setWalletChecked(w => ({ ...w, [sig]: e.target.checked }))} />
                        <span>I checked my wallet: there is no pending or sent receive for this transfer.</span></label>
                      <button type="button" className="rounded-lg border border-amber-300 bg-white px-3 py-1.5 font-semibold text-amber-900 disabled:opacity-50" disabled={!walletChecked[sig] || c.busy} onClick={() => r.unlock(sig)}>I checked my wallet: unlock</button>
                    </div>
                  ) : (
                    <>
                      <label className="flex items-start gap-2"><input type="checkbox" checked={!!reviewed[sig]} onChange={e => setReviewed(v => ({ ...v, [sig]: e.target.checked }))} />
                        <span>I reviewed this receive. It finishes the existing burn; no new burn is made.</span></label>
                      <button type="button" className="w-full rounded-xl bg-slate-900 px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-50" disabled={busy || c.busy || !reviewed[sig] || !r.walletReady}
                        onClick={() => void r.complete(sig)}>Complete receive on Arc</button>
                      <p className="text-slate-500">You approve one Arc transaction in your EVM wallet (Arc gas is paid in USDC).</p>
                    </>
                  )}
                </div>
              )}
            </li>
          )
        })}
      </ul>
    </details>
  )
}
