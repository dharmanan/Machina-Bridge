import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ArrowDownUp, CheckCircle2, Circle, Loader2 } from 'lucide-react'
import { formatUnits, parseUnits } from 'viem'
import type { SuiWriteAction, SuiWriteAttempt } from '../lib/mainnetSuiExecution'
import type { SuiRecoveryInput, SuiRecoveryResult } from '../lib/mainnetSuiRecovery'
import { suiTransferIdentity, type SuiRecoveryRecord } from '../lib/mainnetSuiQueue'
import type { SuiTransferWriter } from '../hooks/useSuiMainnetWrite'
import { MAINNET_SUI_CCTP_TEST_MAX_UNITS } from '../config/sui'
import SuiStepReview, { SuiAttemptCard, arcExplorer, attemptLabels, suiExplorer, unresolvedAttempt } from './MainnetSuiTransfer'

type Direction = SuiRecoveryInput['direction']
type Stage = SuiRecoveryResult['stage']
export type SuiBridgeFlowProps = {
  writer: SuiTransferWriter
  evm: { address?: string; walletName?: string; onArc: boolean }
  sui: { address?: string; walletName?: string; ready: boolean; usdc?: string | null; gas?: string | null }
  arc: { usdcUnits?: bigint; refresh(): Promise<{ allowanceUnits?: bigint }> }
  records: SuiRecoveryRecord[]
  // Fresh, read-only source/Circle/destination check; saves the result to history.
  inspect(input: SuiRecoveryInput): Promise<SuiRecoveryResult>
  pollMs?: { status: number; attestation: number }
  compact?: boolean
}

const MAX = MAINNET_SUI_CCTP_TEST_MAX_UNITS
const DRAFT = 'machina_sui_bridge_draft_v1'
const chainOf = (d: Direction, side: 'from' | 'to') => (d === 'arc-to-sui') === (side === 'from') ? 'Arc' : 'Sui'
const short = (v?: string) => !v ? '' : v.length > 14 ? `${v.slice(0, 6)}…${v.slice(-4)}` : v
const sourceLink = (r: { direction: Direction; sourceId: string }) => r.direction === 'arc-to-sui' ? arcExplorer(r.sourceId) : suiExplorer(r.sourceId)
const destinationLink = (r: { direction: Direction; destinationTx?: string }) => !r.destinationTx ? null : r.direction === 'arc-to-sui' ? suiExplorer(r.destinationTx) : arcExplorer(r.destinationTx)
export function stageTitle(stage: Stage, d: Direction) {
  return stage === 'waiting_attestation' ? 'Your transfer is being verified' : stage === 'ready_to_mint' ? `Your USDC is ready to be received in your ${chainOf(d, 'to')} wallet` : 'Transfer complete'
}
function parseAmount(text: string) {
  if (!/^(?:0|[1-9][0-9]{0,11})(?:\.[0-9]{1,6})?$/.test(text.trim())) return null
  const v = parseUnits(text.trim(), 6); return v > 0n ? v : null
}
function readDraft(): { direction: Direction; amount: string } | null {
  try { const d = JSON.parse(window.sessionStorage.getItem(DRAFT) ?? 'null'); return d && ['arc-to-sui', 'sui-to-arc'].includes(d.direction) && typeof d.amount === 'string' && d.amount.length < 24 ? d : null } catch { return null }
}
function writeDraft(direction: Direction, amount: string) { try { window.sessionStorage.setItem(DRAFT, JSON.stringify({ direction, amount })) } catch { /* optional convenience */ } }

export default function SuiBridgeFlow({ writer, evm, sui, arc, records, inspect, pollMs = { status: 15_000, attestation: 20_000 }, compact = false }: SuiBridgeFlowProps) {
  const [direction, setDirection] = useState<Direction>(() => readDraft()?.direction ?? 'arc-to-sui')
  const [amount, setAmount] = useState(() => readDraft()?.amount ?? '')
  const [attempt, setAttempt] = useState<SuiWriteAttempt | null>(null)
  const [journalError, setJournalError] = useState<string | null>(null)
  const [step, setStep] = useState<{ action: Exclude<SuiWriteAction, 'sui-mint' | 'arc-mint'>; units: bigint; note?: string } | null>(null)
  const [activeId, setActiveId] = useState<string | null>(null)
  const [closed, setClosed] = useState<string[]>([])
  const [fresh, setFresh] = useState<Record<string, SuiRecoveryResult>>({})
  const [checking, setChecking] = useState<string | null>(null)
  const [checkError, setCheckError] = useState<string | null>(null)
  const [feeBps, setFeeBps] = useState<number | null>(null)
  const [findHash, setFindHash] = useState(''), [findDirection, setFindDirection] = useState<Direction>('arc-to-sui')
  const ready = Boolean(evm.address && evm.onArc && sui.address && sui.ready)
  const owners = `${sui.address ?? ''}|${evm.address ?? ''}`.toLowerCase()
  const mine = useMemo(() => records.filter(r => `${r.suiOwner}|${r.evmOwner}`.toLowerCase() === owners), [records, owners])
  const view = (r: SuiRecoveryRecord) => fresh[r.id] ?? r

  const reload = useCallback(() => { try { setAttempt(writer.saved()); setJournalError(null) } catch (e) { setJournalError(e instanceof Error ? e.message : 'The transfer journal is unreadable.') } }, [writer])
  useEffect(() => { reload() }, [reload, owners])
  useEffect(() => {
    const onStorage = (e: StorageEvent) => { if (e.key === 'machina_mainnet_sui_write_attempt_v1') reload() }
    window.addEventListener('storage', onStorage); return () => window.removeEventListener('storage', onStorage)
  }, [reload])
  useEffect(() => { writeDraft(direction, amount) }, [direction, amount])
  useEffect(() => {
    let live = true; setFeeBps(null)
    writer.feeBps(direction).then(v => { if (live) setFeeBps(v) }, () => { if (live) setFeeBps(null) })
    return () => { live = false }
  }, [writer, direction])

  const check = useCallback(async (r: { direction: Direction; sourceId: string; id?: string }) => {
    if (!sui.address || !evm.address) return null
    setChecking(r.sourceId); setCheckError(null)
    try {
      const res = await inspect({ direction: r.direction, sourceId: r.sourceId, suiOwner: sui.address, evmOwner: evm.address })
      const id = suiTransferIdentity(res)
      setFresh(f => ({ ...f, [id]: res })); return { id, res }
    } catch (e) { setCheckError(e instanceof Error ? e.message : 'The transfer status could not be verified. Nothing was sent.'); return null }
    finally { setChecking(null) }
  }, [inspect, sui.address, evm.address])

  // The transfer this screen follows: the one opened from history, otherwise the
  // newest unfinished one for these wallets. Stored rows are never mint authority.
  const active = (activeId ? mine.find(r => r.id === activeId) : null) ?? mine.find(r => view(r).stage !== 'complete' && !closed.includes(r.id)) ?? null
  const activeStage = active ? view(active).stage : null
  const activeFresh = active ? fresh[active.id] : undefined
  const open = unresolvedAttempt(attempt)

  // React once to each settled wallet operation (also right after a reload).
  const handled = useRef<string | null>(null)
  useEffect(() => {
    if (!attempt || attempt.state !== 'verified') return
    const tag = `${attempt.id}:${attempt.state}`; if (handled.current === tag) return
    handled.current = tag
    const a = attempt.intent.action
    if (a === 'arc-approval') { setStep({ action: 'arc-burn', units: attempt.intent.amount, note: 'Approval confirmed. Now confirm the transfer itself.' }); return }
    if (a === 'arc-burn' || a === 'sui-burn') {
      setStep(null)
      const row = mine.find(r => r.direction === (a === 'arc-burn' ? 'arc-to-sui' : 'sui-to-arc') && (a === 'arc-burn' ? r.sourceId.toLowerCase() === attempt.digest?.toLowerCase() : r.sourceId === attempt.digest))
      if (row) { setActiveId(row.id); void check(row) } else if (attempt.digest) void check({ direction: a === 'arc-burn' ? 'arc-to-sui' : 'sui-to-arc', sourceId: attempt.digest }).then(x => { if (x) setActiveId(x.id) })
      return
    }
    if (active) void check(active)
  }, [attempt, mine, active, check])

  // Fresh check when a transfer becomes active, then read-only polling while
  // Circle verifies it (backing off; paused in a hidden tab).
  const lastChecked = useRef<string | null>(null)
  useEffect(() => {
    if (!active || open || compact) return
    if (lastChecked.current !== active.id) { lastChecked.current = active.id; void check(active) }
    if (activeStage !== 'waiting_attestation') return
    let delay = pollMs.attestation, timer: ReturnType<typeof setTimeout>
    const tick = () => { timer = setTimeout(() => { if (!document.hidden) void check(active); delay = Math.min(delay * 2, 120_000); tick() }, delay) }
    tick(); return () => clearTimeout(timer)
  }, [active?.id, activeStage, open, compact])

  const units = parseAmount(amount)
  const fee = units !== null && feeBps !== null ? (units * BigInt(Math.ceil(feeBps * 1000)) + 9_999_999n) / 10_000_000n : null
  const sourceBalance = direction === 'arc-to-sui' ? (arc.usdcUnits !== undefined ? formatUnits(arc.usdcUnits, 6) : null) : sui.usdc ?? null
  const amountError = amount.trim() && units === null ? 'Enter a USDC amount with up to 6 decimals.' : units !== null && units > MAX ? `This test phase allows at most ${formatUnits(MAX, 6)} USDC per transfer.` : null
  async function startReview() {
    if (!units || units > MAX || !ready) return
    setCheckError(null)
    if (direction === 'sui-to-arc') { setStep({ action: 'sui-burn', units }); return }
    let allowance: bigint | undefined
    try { allowance = (await arc.refresh()).allowanceUnits } catch { allowance = undefined }
    if (allowance === undefined) { setCheckError('Your Arc USDC allowance could not be read. Nothing was sent; try again.'); return }
    setStep({ action: allowance >= units ? 'arc-burn' : 'arc-approval', units })
  }
  const walletName = evm.walletName ?? 'your EVM wallet'
  const base = ready && step ? { suiOwner: sui.address!, evmOwner: evm.address!, amount: step.units } : null
  const receive = activeFresh?.stage === 'ready_to_mint' && activeFresh.maxFeeUnits !== undefined ? activeFresh : null

  const history = <details className="rounded-2xl border border-slate-200 p-4 text-sm" open={compact}>
    <summary className="cursor-pointer font-semibold">Transfer history ({mine.length})</summary>
    {!sui.address || !evm.address ? <p className="mt-2 text-xs text-slate-500">Connect your Arc and Sui wallets in the top bar to see their transfers.</p> : mine.length === 0 && <p className="mt-2 text-xs text-slate-500">No Sui transfers for these wallets yet.</p>}
    <ul className="mt-2 divide-y divide-slate-100">{mine.map(r => { const v = view(r), dest = destinationLink(v); return <li key={r.id} className="space-y-1 py-3 text-xs" aria-label="Transfer">
      <div className="flex flex-wrap items-center justify-between gap-2"><span className="font-semibold">{chainOf(r.direction, 'from')} → {chainOf(r.direction, 'to')} · {r.amount} USDC</span><span className={v.stage === 'complete' ? 'text-[#2F6E0C]' : 'text-amber-800'}>{stageTitle(v.stage, r.direction)}</span></div>
      <div className="flex flex-wrap gap-3"><a className="underline" href={sourceLink(r)} target="_blank" rel="noreferrer">Source transaction</a>{dest && <a className="underline" href={dest} target="_blank" rel="noreferrer">Destination transaction</a>}
        <button type="button" className="font-semibold underline disabled:text-slate-400" disabled={!ready || Boolean(checking)} onClick={() => { setClosed(c => c.filter(x => x !== r.id)); setActiveId(r.id); lastChecked.current = null; void check(r) }}>{checking === r.sourceId ? 'Checking…' : fresh[r.id] ? 'Check again' : 'Check status'}</button></div>
      {!fresh[r.id] && <p className="text-slate-400">Saved status; open it to check the chains again.</p>}
    </li> })}</ul>
    {!compact && <details className="mt-2 text-xs"><summary className="cursor-pointer text-slate-500">Find a transfer made on another device</summary>
      <div className="mt-2 grid gap-2 sm:grid-cols-[auto_1fr_auto]">
        <select aria-label="Transfer direction to find" value={findDirection} onChange={e => setFindDirection(e.target.value as Direction)} className="rounded-lg border border-slate-200 bg-white p-2"><option value="arc-to-sui">Arc → Sui</option><option value="sui-to-arc">Sui → Arc</option></select>
        <input aria-label="Source transaction to find" value={findHash} onChange={e => setFindHash(e.target.value)} maxLength={66} autoComplete="off" spellCheck={false} placeholder={findDirection === 'arc-to-sui' ? 'Arc transaction hash (0x…)' : 'Sui transaction digest'} className="min-w-0 rounded-lg border border-slate-200 p-2 font-mono" />
        <button type="button" disabled={!ready || !findHash.trim() || Boolean(checking)} onClick={() => void check({ direction: findDirection, sourceId: findHash.trim() }).then(x => { if (x) { setActiveId(x.id); setFindHash('') } })} className="rounded-lg border border-slate-300 px-3 py-2 font-semibold disabled:text-slate-400">Find</button>
      </div></details>}
  </details>

  if (compact) return <div className="space-y-3">{checkError && <p role="alert" className="rounded-xl bg-amber-50 p-3 text-xs text-amber-900">{checkError}</p>}{history}</div>

  const lastFinal = attempt && !open && attempt.state !== 'verified' ? attempt : null
  let main: React.ReactNode
  if (journalError) main = <p role="alert" className="rounded-2xl bg-amber-50 p-4 text-sm text-amber-900">{journalError} New transfers stay locked so nothing is sent twice.</p>
  else if (attempt && open) main = <SuiAttemptCard writer={writer} attempt={attempt} evmWallet={walletName} pollMs={pollMs.status} onAttempt={a => { setAttempt(a); if (!a) reload() }} />
  else if (step) main = <div className="space-y-2">
    <SuiStepReview key={`${step.action}:${step.units}`} writer={writer} action={step.action} base={base} ready={ready} evmWallet={walletName} autoPrepare onAttempt={a => { setAttempt(a); if (a && a.state !== 'rejected') setStep(null) }}
      explain={step.note ?? (step.action === 'arc-approval' ? <p>First, {walletName} asks you to let the bridge use exactly {formatUnits(step.units, 6)} USDC. This is a separate approval and moves no USDC. You then confirm the transfer itself.</p> : step.action === 'arc-burn' ? <p>Your USDC leaves your Arc wallet and is sent to your Sui wallet. Confirm in {walletName}.</p> : <p>Your USDC leaves your Sui wallet and is sent to your Arc wallet. Confirm in Slush.</p>)} />
    <button type="button" onClick={() => setStep(null)} className="text-xs font-semibold text-slate-500 underline">Cancel</button>
  </div>
  else if (active) {
    const v = view(active), stage = v.stage, dest = destinationLink(v)
    main = <section aria-label="Transfer progress" className="space-y-3 rounded-2xl border border-slate-200 p-4 text-sm">
      <div className="flex flex-wrap items-center justify-between gap-2"><p className="font-semibold">{chainOf(active.direction, 'from')} → {chainOf(active.direction, 'to')} · {active.amount} USDC</p>{checking === active.sourceId && <span className="inline-flex items-center gap-1 text-xs text-slate-500"><Loader2 size={12} className="animate-spin" />Checking</span>}</div>
      <ol className="space-y-1.5 text-xs">
        <Progress done label={`Sent from your ${chainOf(active.direction, 'from')} wallet`} />
        <Progress done={stage !== 'waiting_attestation'} current={stage === 'waiting_attestation'} label="Verified by Circle" />
        <Progress done={stage === 'complete'} current={stage === 'ready_to_mint'} label={`Received in your ${chainOf(active.direction, 'to')} wallet`} />
      </ol>
      <p role="status" className="font-semibold">{stageTitle(stage, active.direction)}</p>
      {stage === 'waiting_attestation' && <p className="text-xs text-slate-500">Circle confirms the transfer, usually within a few minutes. This page keeps checking on its own.</p>}
      {stage === 'ready_to_mint' && !activeFresh && <p className="text-xs text-slate-500">Checking the chains before you can receive…</p>}
      {stage === 'ready_to_mint' && activeFresh && parseUnits(activeFresh.amount, 6) > MAX && <p className="text-xs text-amber-800">This transfer is above the {formatUnits(MAX, 6)} USDC test limit, so receiving is not offered in this test phase. Nothing was sent.</p>}
      {receive && parseUnits(receive.amount, 6) <= MAX && <SuiStepReview key={receive.sourceId} writer={writer} action={active.direction === 'arc-to-sui' ? 'sui-mint' : 'arc-mint'} ready={ready} evmWallet={walletName} onAttempt={a => setAttempt(a)}
        base={{ suiOwner: sui.address!, evmOwner: evm.address!, amount: parseUnits(receive.amount, 6), maxCctpFee: BigInt(receive.maxFeeUnits!), sourceId: receive.sourceId }}
        explain={<p>Receive {receive.receivedUsdc ?? receive.amount} USDC in your {chainOf(active.direction, 'to')} wallet. Confirm in {active.direction === 'arc-to-sui' ? 'Slush' : walletName}; the {chainOf(active.direction, 'to')} network fee is paid there.</p>} />}
      {stage === 'complete' && <p className="text-xs text-slate-600">You received {v.receivedUsdc ?? active.amount} USDC{v.feeUsdc && v.feeUsdc !== '0' ? ` (Circle fee ${v.feeUsdc} USDC)` : ''}.</p>}
      <div className="flex flex-wrap gap-3 text-xs"><a className="underline" href={sourceLink(active)} target="_blank" rel="noreferrer">Source transaction</a>{dest && <a className="underline" href={dest} target="_blank" rel="noreferrer">Destination transaction</a>}</div>
      {stage === 'complete' && <button type="button" onClick={() => { setClosed(c => [...c, active.id]); setActiveId(null); setAmount('') }} className="w-full rounded-xl bg-[#66D121] px-4 py-3 font-semibold text-slate-950">Start a new transfer</button>}
      {stage !== 'complete' && <div className="flex flex-wrap gap-4 text-xs"><button type="button" disabled={Boolean(checking)} onClick={() => void check(active)} className="font-semibold underline disabled:text-slate-400">{checking === active.sourceId ? 'Checking…' : 'Check now'}</button><button type="button" onClick={() => { setClosed(c => [...c, active.id]); setActiveId(null) }} className="font-semibold text-slate-500 underline">Hide and start another transfer</button></div>}
    </section>
  } else main = <section aria-label="New Sui transfer" className="space-y-3">
    <Side label="From" chain={chainOf(direction, 'from')} wallet={direction === 'arc-to-sui' ? (evm.address ? `${walletName} · ${short(evm.address)}` : null) : (sui.address ? `${sui.walletName ?? 'Slush'} · ${short(sui.address)}` : null)} balance={sourceBalance} />
    <div className="flex justify-center"><button type="button" aria-label="Switch direction" onClick={() => setDirection(d => d === 'arc-to-sui' ? 'sui-to-arc' : 'arc-to-sui')} className="rounded-full border border-slate-200 bg-white p-2 text-slate-600 shadow-sm hover:text-[#2F6E0C]"><ArrowDownUp size={16} /></button></div>
    <Side label="To" chain={chainOf(direction, 'to')} wallet={direction === 'arc-to-sui' ? (sui.address ? `${sui.walletName ?? 'Slush'} · ${short(sui.address)}` : null) : (evm.address ? `${walletName} · ${short(evm.address)}` : null)} />
    <label className="block text-sm font-medium">Amount<div className="mt-1 flex items-center gap-2 rounded-xl border border-slate-200 px-3"><input aria-label="Sui transfer amount" inputMode="decimal" autoComplete="off" value={amount} onChange={e => setAmount(e.target.value)} className="min-w-0 flex-1 bg-transparent py-3 text-lg outline-none" placeholder="0.00" /><span className="text-sm text-slate-500">USDC</span></div></label>
    <p className="text-xs text-slate-500">Test limit: at most {formatUnits(MAX, 6)} USDC per transaction.{sourceBalance !== null ? ` Balance: ${sourceBalance} USDC.` : ''}</p>
    {amountError && <p className="text-xs text-amber-800">{amountError}</p>}
    <dl className="space-y-1 rounded-xl bg-slate-50 p-3 text-xs">
      <Line k="Circle fee" v={fee === null ? (feeBps === null ? 'Checking…' : '—') : `${formatUnits(fee, 6)} USDC`} />
      <Line k="You receive" v={units !== null && fee !== null && units <= MAX ? `≈ ${formatUnits(units - fee, 6)} USDC` : '—'} />
      <Line k={`${chainOf(direction, 'from')} network fee`} v={direction === 'arc-to-sui' ? 'up to 0.02 USDC · exact in review' : 'up to 0.05 SUI · exact in review'} />
      <Line k={`${chainOf(direction, 'to')} network fee`} v={direction === 'arc-to-sui' ? 'up to 0.05 SUI · paid when you receive' : 'up to 0.02 USDC · paid when you receive'} />
    </dl>
    {!ready && <p className="rounded-xl bg-slate-50 p-3 text-xs text-slate-600">{!evm.address ? 'Connect your EVM wallet (Arc) in the top bar.' : !evm.onArc ? 'Switch your EVM wallet to Arc Mainnet in the top bar.' : !sui.address ? 'Connect Slush (Sui) in the top bar.' : 'Use a Slush account on Sui Mainnet.'}</p>}
    <button type="button" onClick={() => void startReview()} disabled={!ready || !units || units > MAX || !writer.writesEnabled} className="w-full rounded-xl bg-[#66D121] px-4 py-3 font-semibold text-slate-950 disabled:cursor-not-allowed disabled:bg-slate-200 disabled:text-slate-500">{writer.writesEnabled ? 'Review transfer' : 'Sui transfers locked'}</button>
  </section>

  return <div className="space-y-4">
    {lastFinal && !step && <p className="rounded-xl bg-slate-50 p-3 text-xs text-slate-600">Last wallet step: {attemptLabels[lastFinal.state]}.</p>}
    {main}
    {checkError && <p role="alert" className="rounded-xl bg-amber-50 p-3 text-xs leading-5 text-amber-900">{checkError}</p>}
    {history}
  </div>
}
function Side({ label, chain, wallet, balance }: { label: string; chain: string; wallet: string | null; balance?: string | null }) {
  return <div className="rounded-2xl border border-slate-200 p-3 text-sm"><div className="flex items-center justify-between gap-2"><span className="text-xs text-slate-500">{label}</span>{balance != null && <span className="text-xs text-slate-500">{balance} USDC</span>}</div>
    <p className="mt-1 font-semibold">{chain} Mainnet</p><p className="truncate text-xs text-slate-600">{wallet ?? 'Not connected · use the top bar'}</p></div>
}
function Line({ k, v }: { k: string; v: string }) { return <div className="flex flex-wrap justify-between gap-x-3"><dt className="text-slate-500">{k}</dt><dd className="text-right font-medium">{v}</dd></div> }
function Progress({ done = false, current = false, label }: { done?: boolean; current?: boolean; label: string }) {
  return <li className={`flex items-center gap-2 ${done ? 'text-[#2F6E0C]' : current ? 'text-slate-900' : 'text-slate-400'}`}>{done ? <CheckCircle2 size={14} /> : current ? <Loader2 size={14} className="animate-spin" /> : <Circle size={14} />}<span>{label}</span></li>
}
