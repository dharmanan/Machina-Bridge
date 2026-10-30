import { useEffect, useRef, useState, type ReactNode } from 'react'
import { formatUnits } from 'viem'
import type { SuiArcMethod, SuiWriteAction, SuiWriteAttempt, SuiWriteIntent, SuiWriteReconciliation, SuiWriteReview } from '../lib/mainnetSuiExecution'
import type { SuiTransferWriter } from '../hooks/useSuiMainnetWrite'
import { arcTx, suiTx } from '../lib/bridgeHistory'
import { feeEstimate, feeLimit } from '../lib/feeDisplay'

// Explicit network-fee ceilings. The prepared transaction must stay within them;
// they are never raised automatically.
export const SUI_GAS_CEILING_MIST = 50_000_000n // 0.05 SUI
export const ARC_GAS_CEILING_WEI = 20_000_000_000_000_000n // 0.02 USDC (Arc native gas, 18 decimals)
export const actionLabels: Record<SuiWriteAction, string> = {
  'sui-burn': 'Send USDC from Sui', 'arc-approval': 'Allow the bridge to use your USDC', 'arc-burn': 'Send USDC from Arc',
  'sui-mint': 'Receive USDC on Sui', 'arc-mint': 'Receive USDC on Arc',
}
export const attemptLabels: Record<SuiWriteAttempt['state'], string> = {
  signing: 'Waiting for your wallet', sending: 'Waiting for your wallet', broadcasting: 'Sent · confirming on chain',
  pending: 'Sent · confirming on chain', verified: 'Transaction confirmed on chain', reverted: 'The transaction failed on chain · no USDC moved',
  rejected: 'You declined in your wallet · nothing was sent', unknown: 'Wallet result not confirmed yet',
  mismatch: 'Your wallet sent a different transaction', reconciled: 'Different transaction reviewed and released · not a completed transfer',
}
// A mismatch stays unresolved: nothing new may start until it is reconciled.
export const unresolvedAttempt = (a: SuiWriteAttempt | null) => Boolean(a && !['verified', 'reverted', 'rejected', 'reconciled'].includes(a.state))
const methodLabels: Record<SuiArcMethod, string> = { 'sign-only': 'Sign only — Machina broadcasts the exact reviewed transaction', 'wallet-send': 'Wallet signs and sends (works with MetaMask)' }
export const arcExplorer = (hash: string) => arcTx(hash)!
export const suiExplorer = (digest: string) => suiTx(digest)!
const walletOf = (action: SuiWriteAction, evmWallet: string) => action.startsWith('sui-') ? 'Slush' : evmWallet
// Exact (Technical details) and readable (review row) network fee text; the bigint values are unchanged.
function gasText(action: SuiWriteAction, value: bigint) { return action.startsWith('sui-') ? `${formatUnits(value, 9)} SUI` : `${formatUnits(value, 18)} USDC` }
function gasShort(action: SuiWriteAction, estimate: bigint, limit: bigint) { const [d, u] = action.startsWith('sui-') ? [9, 'SUI'] : [18, 'USDC']; return `${feeEstimate(estimate, d, u)} · max ${feeLimit(limit, d, u)}` }
function message(error: unknown) { return error instanceof Error && error.message ? error.message : 'The operation could not be verified. Nothing further will be sent.' }

export type SuiStepBase = { suiOwner: string; evmOwner: string; amount: bigint; maxCctpFee?: bigint; sourceId?: string }
export type SuiStepReviewProps = {
  writer: SuiTransferWriter
  action: SuiWriteAction
  base: SuiStepBase | null
  ready: boolean
  evmWallet?: string
  // Preparation is read-only (simulation, no wallet prompt); it may start on its own.
  autoPrepare?: boolean
  explain?: ReactNode
  // Inside the bridge panel: no own card frame or title (the panel's step list names the step).
  bare?: boolean
  // Shown next to the advanced options (e.g. the panel's Cancel link).
  aside?: ReactNode
  onPhase?(phase: SuiStepPhase): void
  onAttempt(attempt: SuiWriteAttempt | null): void
}
// What this step currently waits for: our read-only preparation, or the user.
export type SuiStepPhase = 'idle' | 'preparing' | 'review' | 'expired' | 'confirming'
const short = (v: string) => v.length > 14 ? `${v.slice(0, 6)}…${v.slice(-4)}` : v

// One wallet step: prepare (read-only) -> Review -> explicit Confirm. Nothing is
// signed or sent without the user's click on the Review currently shown.
export default function SuiStepReview({ writer, action, base, ready, evmWallet = 'your EVM wallet', autoPrepare = false, explain, bare = false, aside, onPhase, onAttempt }: SuiStepReviewProps) {
  const arcStep = action.startsWith('arc-')
  // Explicit, reviewed choice; never switched by the app after a failure.
  const [method, setMethod] = useState<SuiArcMethod>(writer.walletSendEnabled ? 'wallet-send' : 'sign-only')
  const [held, setHeld] = useState<{ key: string; review: SuiWriteReview } | null>(null)
  const [busy, setBusy] = useState<'prepare' | 'confirm' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [now, setNow] = useState(() => Date.now())
  const key = JSON.stringify([action, arcStep ? method : '', base?.suiOwner ?? '', base?.evmOwner ?? '', ready, base ? [String(base.amount), String(base.maxCctpFee ?? ''), base.sourceId ?? ''] : null])
  const live = useRef(key); live.current = key
  // A Review renders and confirms ONLY for the exact inputs it was prepared for,
  // synchronously in the same render; the effect below then drops it for good.
  const review = held && held.key === key ? held.review : null

  useEffect(() => { writer.invalidate(); setHeld(null); setError(null) }, [writer, key])
  useEffect(() => { if (!review) return; const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t) }, [review])

  async function intent(): Promise<SuiWriteIntent> {
    if (!base) throw new Error('Connect both wallets and enter an amount.')
    const gasCeiling = action.startsWith('sui-') ? SUI_GAS_CEILING_MIST : ARC_GAS_CEILING_WEI
    const arcMethod = arcStep ? { arcMethod: method } : {}
    let maxCctpFee = base.maxCctpFee
    if (maxCctpFee === undefined) {
      const bps = await writer.feeBps(action === 'sui-burn' ? 'sui-to-arc' : 'arc-to-sui')
      // Ceil to base units so the reviewed maximum is never below Circle's minimum.
      maxCctpFee = (base.amount * BigInt(Math.ceil(bps * 1000)) + 9_999_999n) / 10_000_000n
    }
    return { action, suiOwner: base.suiOwner, evmOwner: base.evmOwner, amount: base.amount, maxCctpFee, gasCeiling, ...(base.sourceId ? { sourceId: base.sourceId } : {}), ...arcMethod }
  }
  async function prepare() {
    const k = key; setBusy('prepare'); setError(null); setHeld(null)
    try { const r = await writer.prepare(await intent()); if (live.current === k) setHeld({ key: k, review: r }) }
    catch (e) { if (live.current === k) setError(message(e)) }
    finally { setBusy(null) }
  }
  // Only when the step first opens. After any wallet, network or input change the
  // user asks for a new review explicitly; nothing is re-prepared behind their back.
  const auto = useRef(false)
  useEffect(() => {
    if (!autoPrepare || !ready || !base || !writer.writesEnabled || auto.current) return
    auto.current = true; void prepare()
  }, [autoPrepare, ready, key, writer])
  async function confirm() {
    const r = review
    // Explicit click only, on the review currently displayed for these exact inputs.
    if (!r || live.current !== key || Date.now() >= r.expiresAt || r.intent.action !== action || (r.intent.arcMethod ?? 'sign-only') !== (arcStep ? method : 'sign-only') || r.intent.suiOwner !== base?.suiOwner || r.intent.evmOwner !== base?.evmOwner) { setHeld(null); setError('This review changed or expired. Review it again.'); return }
    setBusy('confirm'); setError(null); setHeld(null)
    try { onAttempt(await writer.confirm(r)) }
    catch (e) { setError(message(e)); try { onAttempt(writer.saved()) } catch { /* journal error already blocks sends */ } }
    finally { setBusy(null) }
  }
  const expired = review ? now >= review.expiresAt : false
  const wallet = walletOf(action, evmWallet)
  const phase: SuiStepPhase = busy === 'confirm' ? 'confirming' : busy === 'prepare' ? 'preparing' : review ? (expired ? 'expired' : 'review') : 'idle'
  const phaseRef = useRef(onPhase); phaseRef.current = onPhase
  useEffect(() => { phaseRef.current?.(phase) }, [phase])
  useEffect(() => () => phaseRef.current?.('idle'), [])

  return <div className={bare ? 'space-y-3 text-sm' : 'space-y-3 rounded-2xl border border-slate-200 p-4 text-sm'} aria-label="Transfer step">
    {!bare && <p className="font-semibold">{actionLabels[action]}</p>}
    {explain && !bare && <div className="text-xs leading-5 text-slate-600">{explain}</div>}
    {!writer.writesEnabled && <p className="rounded-lg bg-slate-100 p-2 text-xs leading-5 text-slate-600">Sending is disabled on this deployment. Nothing can be signed or submitted here.</p>}
    {!review && busy !== 'confirm' && <button type="button" onClick={() => void prepare()} disabled={!writer.writesEnabled || !ready || !base || Boolean(busy)} className="w-full rounded-xl bg-[#66D121] px-4 py-3 font-semibold text-slate-950 disabled:cursor-not-allowed disabled:bg-slate-200 disabled:text-slate-500">{!writer.writesEnabled ? 'Sui transfers locked' : busy === 'prepare' ? 'Preparing your review…' : `Review: ${actionLabels[action]}`}</button>}
    {review && <section role="region" aria-label="Transaction review" className="space-y-1 rounded-xl bg-slate-50 p-3 text-xs leading-5 break-words">
      <p className="text-sm font-semibold">Review · {actionLabels[review.intent.action]}</p>
      <Row k="Amount" v={`${formatUnits(review.intent.amount, 6)} USDC`} />
      {review.intent.action !== 'arc-approval' && <Row k="Maximum Circle fee" v={`${formatUnits(review.intent.maxCctpFee, 6)} USDC`} />}
      <Row k="Network fee" v={gasShort(review.intent.action, review.estimatedGas, review.maximumGas)} />
      <Row k="Wallets" v={`Arc ${short(review.intent.evmOwner)} · Sui ${short(review.intent.suiOwner)}`} title={`Arc ${review.intent.evmOwner} · Sui ${review.intent.suiOwner}`} mono />
      {review.intent.action.startsWith('arc-') && review.intent.arcMethod === 'wallet-send' && <p className="rounded-lg bg-amber-50 p-2 text-amber-900">{wallet} signs and sends this itself. Machina then checks on chain that it matches this review; if not, new transfers stay locked and it is never shown as complete.</p>}
      <details><summary className="cursor-pointer font-medium text-slate-600">Technical details</summary>
        <ul className="mt-1 list-disc pl-4 font-mono text-[11px]"><li className="break-all">Wallet to confirm {wallet}</li><li className="break-all">Estimated network fee {gasText(review.intent.action, review.estimatedGas)} · limit {gasText(review.intent.action, review.maximumGas)}</li><li className="break-all">Sui wallet {review.intent.suiOwner}</li><li className="break-all">Arc wallet {review.intent.evmOwner}</li>{review.content.map((l, n) => <li key={n} className="break-all">{l}</li>)}</ul>
        <p className="mt-1 font-mono text-[11px] break-all">Commitment {review.commitment}{review.digest ? ` · digest ${review.digest}` : ''}</p>
        {review.intent.action.startsWith('arc-') && <p className="mt-1">Signing method: {methodLabels[review.intent.arcMethod ?? 'sign-only']}</p>}
      </details>
      <p className={expired ? 'font-semibold text-amber-800' : 'text-slate-500'}>{expired ? 'This review expired. Review it again.' : `Valid for ${Math.max(0, Math.ceil((review.expiresAt - now) / 1000))} s. Changing a wallet, network or amount cancels it.`}</p>
      <button type="button" onClick={() => void confirm()} disabled={!writer.writesEnabled || expired || Boolean(busy)} className="mt-1 w-full rounded-xl bg-[#66D121] px-4 py-3 text-sm font-semibold text-slate-950 disabled:cursor-not-allowed disabled:bg-slate-200 disabled:text-slate-500">{writer.writesEnabled ? `Confirm in ${wallet}` : 'Confirm locked'}</button>
      {expired && <button type="button" onClick={() => void prepare()} disabled={Boolean(busy)} className="w-full text-center font-semibold underline">Review again</button>}
    </section>}
    {busy === 'confirm' && <p className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs leading-5 text-amber-900">Waiting for your confirmation in {wallet}. If its window did not open, open {wallet} yourself. Do not close this tab.</p>}
    {(aside || (arcStep && writer.walletSendEnabled)) && <div className="flex flex-wrap items-start gap-x-4 gap-y-1">{aside}
      {arcStep && writer.walletSendEnabled && <details className="min-w-0 flex-1 text-xs"><summary className="cursor-pointer text-slate-500">Advanced: signing method</summary>
      <fieldset className="mt-2 space-y-1"><legend className="sr-only">Arc signing method</legend>
        {(['wallet-send', 'sign-only'] as const).map(m => <label key={m} className="flex items-start gap-1.5"><input type="radio" name={`arc-method-${action}`} className="mt-1" checked={method === m} onChange={() => setMethod(m)} /><span>{methodLabels[m]}</span></label>)}
        <p className="leading-5 text-slate-500">Sign only is stronger: the exact signed bytes are checked before anything is sent, but many wallets, including MetaMask, do not support it. Changing this cancels the current review.</p>
      </fieldset></details>}</div>}
    {error && <p role="alert" className="rounded-xl bg-amber-50 p-3 text-xs leading-5 text-amber-900">{error}{arcStep && method === 'sign-only' && /cannot sign separately/.test(error) ? ' Choose "Wallet signs and sends" under Advanced and review again; nothing switches automatically.' : ''}</p>}
  </div>
}
function Row({ k, v, mono = false, title }: { k: string; v: string; mono?: boolean; title?: string }) {
  return <div className="flex flex-wrap justify-between gap-x-3"><span className="text-slate-500">{k}</span><span title={title} className={`min-w-0 break-all text-right ${mono ? 'font-mono text-[11px]' : 'font-medium'}`}>{v}</span></div>
}

export type SuiAttemptCardProps = { writer: SuiTransferWriter; attempt: SuiWriteAttempt; evmWallet?: string; pollMs?: number; bare?: boolean; onChecking?(checking: boolean): void; onAttempt(attempt: SuiWriteAttempt | null): void }
// The journaled wallet operation. Status checks are read-only and run on their
// own while the outcome is open; nothing is ever re-sent from here.
export function SuiAttemptCard({ writer, attempt, evmWallet = 'your EVM wallet', pollMs = 15_000, bare = false, onChecking, onAttempt }: SuiAttemptCardProps) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [evidence, setEvidence] = useState<SuiWriteReconciliation | null>(null)
  const open = unresolvedAttempt(attempt) && attempt.state !== 'mismatch'
  const running = useRef(false)
  const checkingRef = useRef(onChecking); checkingRef.current = onChecking
  useEffect(() => { checkingRef.current?.(busy) }, [busy])
  useEffect(() => () => checkingRef.current?.(false), [])
  async function recover(silent = false) {
    if (running.current) return
    running.current = true; setBusy(true); if (!silent) setError(null)
    try { onAttempt(await writer.recover()); setError(null) } catch (e) { setError(message(e)) } finally { running.current = false; setBusy(false) }
  }
  useEffect(() => {
    if (!open || pollMs <= 0) return
    const t = setInterval(() => { if (typeof document === 'undefined' || !document.hidden) void recover(true) }, pollMs)
    return () => clearInterval(t)
  }, [open, pollMs, attempt.id, attempt.state])
  async function inspectMismatch() {
    setBusy(true); setError(null); setEvidence(null)
    try { setEvidence(await writer.inspectMismatch()) } catch (e) { setError(message(e)) } finally { setBusy(false) }
  }
  async function reconcile() {
    const shown = evidence; if (!shown) return
    setBusy(true); setError(null)
    try { onAttempt(await writer.reconcile(shown.key)); setEvidence(null) } catch (e) { setEvidence(null); setError(message(e)) } finally { setBusy(false) }
  }
  const wallet = walletOf(attempt.intent.action, evmWallet)
  const link = attempt.digest ? (attempt.intent.action.startsWith('sui-') ? suiExplorer(attempt.digest) : arcExplorer(attempt.digest)) : null
  return <div role="status" aria-label="Wallet operation" className={bare ? 'space-y-2 text-xs leading-5 break-words' : 'space-y-2 rounded-2xl border border-slate-200 p-4 text-xs leading-5 break-words'}>
    {!bare && <p className="text-sm font-semibold">{actionLabels[attempt.intent.action]} · {formatUnits(attempt.intent.amount, 6)} USDC</p>}
    <p className="font-medium">{attemptLabels[attempt.state]}</p>
    {(attempt.state === 'unknown' || attempt.state === 'sending' || attempt.state === 'signing') && <p>We could not confirm your {wallet} transaction yet. Do not send it again — its status is being checked.</p>}
    {(attempt.state === 'pending' || attempt.state === 'broadcasting') && <p>Waiting for the network to confirm it. This page checks on its own; you can leave it open.</p>}
    {link && <a className="inline-block font-semibold underline" href={link} target="_blank" rel="noreferrer">View transaction</a>}
    {open && <><p className="text-slate-500">A new transfer starts only after this one is confirmed. Nothing is sent again automatically.</p>
      <button type="button" onClick={() => void recover()} disabled={busy} className="font-semibold underline disabled:text-slate-400">{busy ? 'Checking…' : 'Check status now'}</button></>}
    {attempt.state === 'mismatch' && <><p>New transfers stay locked. The lock opens only after the chain shows exactly what this transaction did and you acknowledge it.</p>
      <button type="button" onClick={() => void inspectMismatch()} disabled={busy} className="font-semibold underline disabled:text-slate-400">{busy ? 'Reading chain evidence…' : 'Check mismatch evidence'}</button>
      {evidence && <section role="region" aria-label="Mismatch evidence" className="space-y-1 rounded-lg bg-amber-50 p-2 text-amber-950"><ul className="list-disc pl-4 font-mono text-[11px]">{evidence.lines.map((l, n) => <li key={n} className="break-all">{l}</li>)}</ul>
        <button type="button" onClick={() => void reconcile()} disabled={busy} className="mt-1 w-full rounded-lg border border-amber-700 px-3 py-2 font-semibold disabled:text-slate-400">I reviewed this evidence · release the lock</button></section>}</>}
    {error && <p role="alert" className="rounded-lg bg-amber-50 p-2 text-amber-900">{error}</p>}
  </div>
}
