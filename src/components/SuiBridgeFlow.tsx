import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { AlertTriangle, ArrowDownUp, CheckCircle2, Circle, Loader2, MousePointerClick } from 'lucide-react'
import { formatUnits, parseUnits } from 'viem'
import type { SuiWriteAction, SuiWriteAttempt } from '../lib/mainnetSuiExecution'
import type { SuiRecoveryInput, SuiRecoveryResult } from '../lib/mainnetSuiRecovery'
import { suiTransferIdentity, type SuiRecoveryRecord } from '../lib/mainnetSuiQueue'
import { noteSuiSessionCheck } from '../lib/bridgeHistory'
import type { SuiTransferWriter } from '../hooks/useSuiMainnetWrite'
import SuiStepReview, { SUI_GAS_CEILING_MIST, SuiAttemptCard, arcExplorer, attemptLabels, suiExplorer, unresolvedAttempt, type SuiStepPhase } from './MainnetSuiTransfer'

type Direction = SuiRecoveryInput['direction']
type Stage = SuiRecoveryResult['stage']
export type SuiBridgeFlowProps = {
  writer: SuiTransferWriter
  // desktopHint: a phone browser with no injected EVM wallet (e.g. the Slush app browser), where MetaMask can only be
  // reached through WalletConnect and that hand-off is not dependable.
  evm: { address?: string; walletName?: string; onArc: boolean; desktopHint?: boolean }
  sui: { address?: string; walletName?: string; ready: boolean; usdc?: string | null; gas?: string | null }
  arc: { usdcUnits?: bigint; refresh(): Promise<{ allowanceUnits?: bigint }> }
  records: SuiRecoveryRecord[]
  // Fresh, read-only source/Circle/destination check; saves the result to history.
  inspect(input: SuiRecoveryInput): Promise<SuiRecoveryResult>
  pollMs?: { status: number; attestation: number }
}

const DRAFT = 'machina_sui_bridge_draft_v1'
const chainOf = (d: Direction, side: 'from' | 'to') => (d === 'arc-to-sui') === (side === 'from') ? 'Arc' : 'Sui'
const short = (v?: string) => !v ? '' : v.length > 14 ? `${v.slice(0, 6)}…${v.slice(-4)}` : v
const sourceLink = (r: { direction: Direction; sourceId: string }) => r.direction === 'arc-to-sui' ? arcExplorer(r.sourceId) : suiExplorer(r.sourceId)
const destinationLink = (r: { direction: Direction; destinationTx?: string }) => !r.destinationTx ? null : r.direction === 'arc-to-sui' ? suiExplorer(r.destinationTx) : arcExplorer(r.destinationTx)
const directionOf = (a: SuiWriteAction): Direction => a === 'arc-approval' || a === 'arc-burn' || a === 'sui-mint' ? 'arc-to-sui' : 'sui-to-arc'
const stepOf = (a: SuiWriteAction): StepKey => a === 'arc-approval' ? 'approve' : a === 'sui-mint' || a === 'arc-mint' ? 'receive' : 'send'
export function stageTitle(stage: Stage, d: Direction) {
  return stage === 'waiting_attestation' ? 'Your transfer is being verified' : stage === 'ready_to_mint' ? `Your USDC is ready to be received in your ${chainOf(d, 'to')} wallet` : 'Transfer complete'
}
function parseAmount(text: string) {
  if (!/^(?:0|[1-9][0-9]{0,11})(?:\.[0-9]{1,6})?$/.test(text.trim())) return null
  const v = parseUnits(text.trim(), 6); return v > 0n ? v : null
}
// Display balances ('0.3', '1.25') to base units; undefined when unknown or malformed.
function unitsOf(text: string | null | undefined, decimals: number) {
  if (typeof text !== 'string' || !/^[0-9]{1,30}(?:\.[0-9]+)?$/.test(text)) return undefined
  const [i, f = ''] = text.split('.'); return f.length > decimals ? undefined : parseUnits(`${i}.${f || '0'}`, decimals)
}
// The source time from the chain when known; otherwise when this browser recorded it. Never a check time.
function whenRow(r: { sourceTime?: number; createdAt?: number }): [string, string] {
  return r.sourceTime ? ['Started', new Date(r.sourceTime).toLocaleString()] : r.createdAt ? ['Recorded here', new Date(r.createdAt).toLocaleString()] : ['Started', 'not known yet']
}
const whenText = (r: { sourceTime?: number; createdAt?: number }) => { const [k, v] = whenRow(r); return `${k === 'Recorded here' ? 'Recorded in this browser' : k} ${v}` }
function readDraft(): { direction: Direction; amount: string } | null {
  try { const d = JSON.parse(window.sessionStorage.getItem(DRAFT) ?? 'null'); return d && ['arc-to-sui', 'sui-to-arc'].includes(d.direction) && typeof d.amount === 'string' && d.amount.length < 24 ? d : null } catch { return null }
}
function writeDraft(direction: Direction, amount: string) { try { window.sessionStorage.setItem(DRAFT, JSON.stringify({ direction, amount })) } catch { /* optional convenience */ } }

// ---- Step list -------------------------------------------------------------
// 'run' = a process is running (spinner); 'action' = waiting for the user (no spinner);
// 'warn' = uncertain or retrying; 'error' = locked until resolved.
type StepKey = 'approve' | 'send' | 'verify' | 'receive'
type StepState = 'pending' | 'run' | 'action' | 'warn' | 'error' | 'done'
export type SuiFlowStep = { key: StepKey; state: StepState; label: string }
export type SuiFlowView = { steps: SuiFlowStep[]; headline: string; detail?: string }
export function describeSuiFlow(x: {
  direction: Direction; approval: boolean; evmWallet: string
  attempt: SuiWriteAttempt | null; open: boolean; step: SuiWriteAction | null; phase: SuiStepPhase
  stage: Stage | null; hasFresh: boolean; checkFailed: boolean; justSent: boolean
}): SuiFlowView {
  const from = chainOf(x.direction, 'from'), to = chainOf(x.direction, 'to')
  const walletFor = (k: StepKey) => (k === 'receive' ? to : from) === 'Sui' ? 'Slush' : x.evmWallet
  const keys: StepKey[] = [...(x.approval ? ['approve' as const] : []), 'send', 'verify', 'receive']
  const done: Record<StepKey, string> = { approve: 'USDC approved for the bridge', send: `Sent from your ${from} wallet`, verify: 'Verified by Circle', receive: `Received in your ${to} wallet` }
  const pending: Record<StepKey, string> = { approve: 'Approve USDC for the bridge', send: `Send from your ${from} wallet`, verify: 'Circle verifies the transfer', receive: `Delivered to your ${to} wallet` }
  let cursor: StepKey, state: StepState, label: string, headline: string, detail: string | undefined
  const reviewing = (k: StepKey, rejected: boolean): [StepState, string, string, string?] => {
    const w = walletFor(k), what = k === 'approve' ? 'the USDC approval' : k === 'receive' ? 'receiving your USDC' : 'the transfer'
    switch (x.phase) {
      case 'preparing': return ['run', k === 'receive' ? 'Preparing your receive review…' : 'Preparing your review…', 'Preparing your review', 'Machina simulates the transaction first. Your wallet is not asked yet.']
      case 'review': return ['action', `Check the review, then confirm in ${w}`, 'Check the review below', `Nothing is sent until you confirm ${what} in ${w}.`]
      case 'confirming': return ['action', `Confirm in ${w}`, `Confirm in ${w}`, `Open ${w} and confirm. Do not close this tab.`]
      case 'expired': return ['action', 'Review expired · review again', 'This review expired', 'Reviews are valid for a short time so fees and state stay accurate.']
      default: return rejected ? ['action', `You declined in ${w} · nothing was sent`, 'Nothing was sent', 'Review again when you are ready.'] : k === 'receive' ? ['action', `Review to receive in your ${to} wallet`, 'Ready to receive', `Circle verified the transfer. Receiving needs one confirmation in ${w}.`] : ['action', 'Review to continue', 'Review to continue']
    }
  }
  if (x.attempt && x.open) {
    cursor = stepOf(x.attempt.intent.action)
    const chain = cursor === 'receive' ? to : from, w = walletFor(cursor)
    const s = x.attempt.state
    if (s === 'signing' || s === 'sending') { state = 'action'; label = `Waiting for your confirmation in ${w}`; headline = `Confirm in ${w}` }
    else if (s === 'broadcasting') { state = 'run'; label = `Sending to ${chain}…`; headline = `Sending to ${chain}` }
    else if (s === 'pending') { state = 'run'; label = `Confirming on ${chain}…`; headline = cursor === 'receive' ? `Confirming receipt on ${chain}` : `Confirming on ${chain}` }
    else if (s === 'mismatch') { state = 'error'; label = 'Different transaction detected · transfers locked'; headline = 'New transfers are locked' }
    else { state = 'warn'; label = 'Result not confirmed yet · checking automatically'; headline = 'Checking your wallet result' }
  } else if (x.step) {
    cursor = stepOf(x.step)
    const rejected = x.attempt?.state === 'rejected' && stepOf(x.attempt.intent.action) === cursor;
    [state, label, headline, detail] = reviewing(cursor, rejected)
  } else if (x.stage) {
    if (x.stage === 'complete') return { steps: keys.map(k => ({ key: k, state: 'done', label: done[k] })), headline: stageTitle('complete', x.direction) }
    headline = stageTitle(x.stage, x.direction)
    if (x.stage === 'waiting_attestation') {
      cursor = 'verify'
      if (x.checkFailed) { state = 'warn'; label = 'Connection problem · retrying automatically'; detail = 'Arc, Sui or Circle did not answer. Nothing was sent; the next check runs on its own.' }
      else { state = 'run'; label = 'Circle is verifying the transfer…'; detail = 'Circle usually confirms within a few minutes. This page keeps checking on its own.' }
    } else {
      cursor = 'receive'
      if (x.justSent) { state = 'run'; label = `Confirming receipt on ${to}…`; headline = `Confirming receipt on ${to}` }
      else if (!x.hasFresh) { state = x.checkFailed ? 'warn' : 'run'; label = x.checkFailed ? 'Could not check the chains · use Check now' : 'Checking the chains before you can receive…' }
      else [state, label, , detail] = reviewing('receive', x.attempt?.state === 'rejected' && stepOf(x.attempt.intent.action) === 'receive')
    }
  } else if (x.attempt?.state === 'verified' && x.attempt.intent.action === 'arc-approval') {
    cursor = 'send'; state = 'run'; label = 'Preparing your review…'; headline = 'Approval confirmed'
  } else if (x.attempt?.state === 'verified' && stepOf(x.attempt.intent.action) === 'send') {
    cursor = 'verify'; state = 'run'; label = 'Checking the chains…'; headline = 'Transfer sent'
  } else { cursor = keys[0]; state = 'action'; label = 'Review to continue'; headline = 'Review to continue' }
  const at = keys.indexOf(cursor)
  return { steps: keys.map((k, n) => n < at ? { key: k, state: 'done', label: done[k] } : n === at ? { key: k, state, label } : { key: k, state: 'pending', label: pending[k] }), headline, detail }
}

export default function SuiBridgeFlow({ writer, evm, sui, arc, records, inspect, pollMs = { status: 15_000, attestation: 20_000 } }: SuiBridgeFlowProps) {
  const [direction, setDirection] = useState<Direction>(() => readDraft()?.direction ?? 'arc-to-sui')
  const [amount, setAmount] = useState(() => readDraft()?.amount ?? '')
  const [attempt, setAttempt] = useState<SuiWriteAttempt | null>(null)
  const [journalError, setJournalError] = useState<string | null>(null)
  const [step, setStep] = useState<{ action: Exclude<SuiWriteAction, 'sui-mint' | 'arc-mint'>; units: bigint; note?: string } | null>(null)
  // The transfer started from this form: kept from Review to completion so the panel never falls back to the form mid-way.
  const [flow, setFlow] = useState<{ direction: Direction; units: bigint; approval: boolean } | null>(null)
  const [phase, setPhase] = useState<SuiStepPhase>('idle')
  const [attemptChecking, setAttemptChecking] = useState(false)
  const [activeId, setActiveId] = useState<string | null>(null)
  const [closed, setClosed] = useState<string[]>([])
  const [fresh, setFresh] = useState<Record<string, SuiRecoveryResult>>({})
  const [checking, setChecking] = useState<string | null>(null)
  const [checkError, setCheckError] = useState<{ source: string | null; message: string } | null>(null)
  const [feeBps, setFeeBps] = useState<number | null>(null)
  const [nextCheckAt, setNextCheckAt] = useState<number | null>(null)
  const [now, setNow] = useState(() => Date.now())
  const [findHash, setFindHash] = useState(''), [findDirection, setFindDirection] = useState<Direction>('arc-to-sui')
  const findRef = useRef(findHash); findRef.current = findHash
  const ready = Boolean(evm.address && evm.onArc && sui.address && sui.ready)
  const owners = `${sui.address ?? ''}|${evm.address ?? ''}`.toLowerCase()
  const ownersRef = useRef(owners); ownersRef.current = owners
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
    const who = ownersRef.current
    setChecking(r.sourceId)
    try {
      const res = await inspect({ direction: r.direction, sourceId: r.sourceId, suiOwner: sui.address, evmOwner: evm.address })
      const id = suiTransferIdentity(res)
      setFresh(f => ({ ...f, [id]: res })); noteSuiSessionCheck(id, res); setCheckError(null); return { id, res }
    } catch (e) { if (ownersRef.current !== who) return null; setCheckError({ source: r.sourceId, message: e instanceof Error ? e.message : 'The transfer status could not be verified. Nothing was sent.' }); return null }
    finally { setChecking(null) }
  }, [inspect, sui.address, evm.address])

  // The transfer this screen follows: the one opened from history, otherwise the
  // newest unfinished one for these wallets. Stored rows are never mint authority.
  const active = (activeId ? mine.find(r => r.id === activeId) : null) ?? mine.find(r => view(r).stage !== 'complete' && !closed.includes(r.id)) ?? null
  const activeStage = active ? view(active).stage : null
  const activeRef = useRef(active?.id); activeRef.current = active?.id
  // Keep following an automatically picked transfer, so its completion is shown instead of the panel jumping back to the form.
  useEffect(() => { if (active && activeId !== active.id && !(activeId && mine.some(r => r.id === activeId))) setActiveId(active.id) }, [active?.id, activeId, mine])
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

  // A wallet step that ended without moving USDC (failed on chain, or a mismatch
  // released after review) ends this flow; the form opens again.
  useEffect(() => { if (attempt && !step && (attempt.state === 'reverted' || attempt.state === 'reconciled')) { setFlow(null); setPhase('idle') } }, [attempt, step])

  // Completed records saved before the Arc mint hash or the chain start time were
  // recorded get one silent, read-only re-check per page session, one at a time,
  // never during a wallet step. It only reads; nothing is sent.
  const backfilled = useRef(new Set<string>())
  useEffect(() => {
    if (!ready || checking || open || step || (active && activeStage !== 'complete')) return
    const r = mine.find(x => x.stage === 'complete' && (!x.destinationTx || !x.sourceTime) && !backfilled.current.has(x.id))
    if (!r) return
    backfilled.current.add(r.id); setChecking(r.sourceId)
    inspect({ direction: r.direction, sourceId: r.sourceId, suiOwner: sui.address!, evmOwner: evm.address! })
      .then(res => { const id = suiTransferIdentity(res); setFresh(f => ({ ...f, [id]: res })); noteSuiSessionCheck(id, res) }, () => { /* stays "not found yet"; Check status retries */ })
      .finally(() => setChecking(null))
  }, [ready, checking, open, step, active?.id, activeStage, mine])

  // Fresh check when a transfer becomes active, then read-only polling while
  // Circle verifies it (backing off; paused in a hidden tab).
  const lastChecked = useRef<string | null>(null)
  useEffect(() => {
    if (!active || open) return
    if (lastChecked.current !== active.id) { lastChecked.current = active.id; void check(active) }
    if (activeStage !== 'waiting_attestation') return
    let delay = pollMs.attestation, timer: ReturnType<typeof setTimeout>
    const tick = () => { setNextCheckAt(Date.now() + delay); timer = setTimeout(() => { if (!document.hidden) void check(active); delay = Math.min(delay * 2, 120_000); tick() }, delay) }
    tick(); return () => { clearTimeout(timer); setNextCheckAt(null) }
  }, [active?.id, activeStage, open])
  // A one-second clock only while a check is scheduled, for the "next check" countdown.
  useEffect(() => { if (nextCheckAt === null) return; const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t) }, [nextCheckAt])

  const units = parseAmount(amount)
  const fee = units !== null && feeBps !== null ? (units * BigInt(Math.ceil(feeBps * 1000)) + 9_999_999n) / 10_000_000n : null
  const sourceUnits = direction === 'arc-to-sui' ? arc.usdcUnits : unitsOf(sui.usdc, 6)
  const sourceBalance = sourceUnits !== undefined ? formatUnits(sourceUnits, 6) : null
  const suiGas = unitsOf(sui.gas, 9)
  // No product cap: the amount must be valid base units, covered by the wallet and above the Circle fee.
  // Protocol limits (CCTP burn limit per message, u64 amounts), exact balances and gas are proven again at Review.
  const amountError = amount.trim() && units === null ? 'Enter a positive USDC amount with up to 6 decimals.'
    : units === null ? null
    : sourceUnits !== undefined && units > sourceUnits ? `Not enough USDC: your ${chainOf(direction, 'from')} balance is ${formatUnits(sourceUnits, 6)} USDC.`
    : fee !== null && fee >= units ? 'This amount does not cover the Circle fee.'
    : direction === 'sui-to-arc' && suiGas !== undefined && suiGas < SUI_GAS_CEILING_MIST ? `Not enough SUI for the Sui network fee (up to ${formatUnits(SUI_GAS_CEILING_MIST, 9)} SUI).`
    : null
  const [starting, setStarting] = useState(false)
  async function startReview() {
    if (!units || amountError || !ready || starting) return
    setCheckError(null)
    if (direction === 'sui-to-arc') { setFlow({ direction, units, approval: false }); setPhase('idle'); setStep({ action: 'sui-burn', units }); return }
    let allowance: bigint | undefined
    setStarting(true)
    try { allowance = (await arc.refresh()).allowanceUnits } catch { allowance = undefined } finally { setStarting(false) }
    if (allowance === undefined) { setCheckError({ source: null, message: 'Your Arc USDC allowance could not be read. Nothing was sent; try again.' }); return }
    const approval = allowance < units
    setFlow({ direction, units, approval }); setPhase('idle'); setStep({ action: approval ? 'arc-approval' : 'arc-burn', units })
  }
  function reset() { setStep(null); setFlow(null); setPhase('idle'); setActiveId(null) }
  const walletName = evm.walletName ?? 'your EVM wallet'
  const base = ready && step ? { suiOwner: sui.address!, evmOwner: evm.address!, amount: step.units } : null
  const receive = activeFresh?.stage === 'ready_to_mint' && activeFresh.maxFeeUnits !== undefined ? activeFresh : null

  const renderHistory = (tracking: SuiRecoveryRecord | null) => <details className="rounded-2xl border border-slate-200 p-4 text-sm">
    <summary className="cursor-pointer font-semibold">Transfer history ({mine.length})</summary>
    {!sui.address || !evm.address ? <p className="mt-2 text-xs text-slate-500">Connect your Arc and Sui wallets in the top bar to see their transfers.</p> : mine.length === 0 && <p className="mt-2 text-xs text-slate-500">No Sui transfers for these wallets yet.</p>}
    <ul className="mt-2 divide-y divide-slate-100">{mine.map(r => { const v = view(r), dest = destinationLink(v); return <li key={r.id} className="space-y-1 py-3 text-xs" aria-label="Transfer">
      <div className="flex flex-wrap items-center justify-between gap-2"><span className="font-semibold">{chainOf(r.direction, 'from')} → {chainOf(r.direction, 'to')} · {r.amount} USDC</span><span className={v.stage === 'complete' ? 'text-[#2F6E0C]' : 'text-amber-800'}>{stageTitle(v.stage, r.direction)}</span></div>
      <div className="flex flex-wrap gap-3"><a className="underline" href={sourceLink(r)} target="_blank" rel="noreferrer">Source transaction</a>{dest ? <a className="underline" href={dest} target="_blank" rel="noreferrer">Destination transaction</a> : v.stage === 'complete' && <span className="text-slate-500">Destination transaction not found yet</span>}
        <button type="button" className="font-semibold underline disabled:text-slate-400" disabled={!ready || Boolean(checking) || Boolean(step) || open} onClick={() => { setClosed(c => c.filter(x => x !== r.id)); setFlow(null); setActiveId(r.id); lastChecked.current = null; void check(r) }}>{checking === r.sourceId ? 'Checking…' : fresh[r.id] ? 'Check again' : 'Check status'}</button></div>
      <p className="text-slate-500">{whenText({ sourceTime: v.sourceTime ?? r.sourceTime, createdAt: r.createdAt })}</p>
      <p className="text-slate-400">{fresh[r.id] ? `Verified on chain at ${new Date(fresh[r.id].checkedAt).toLocaleTimeString()}` : 'Saved status in this browser; check it to read the chains again.'}</p>
    </li> })}</ul>
  </details>

  // One recovery form for a transfer started elsewhere: paste its source transaction; the direction follows from its format.
  const findReady = ready && !checking && !step && !open
  const renderRecovery = (tracking: SuiRecoveryRecord | null) => <details className="rounded-2xl border border-slate-200 p-4 text-sm">
    <summary className="cursor-pointer font-semibold">Recover a transfer from another device or browser</summary>
    <p className="mt-2 text-xs leading-5 text-slate-500">Paste the source transaction of a transfer made with the wallets connected now. Machina reads the burn, Circle's message and the destination chain and adds the transfer to this browser's history. It sends nothing; if your USDC is still waiting, you confirm the receive step in your wallet. Machina does not scan wallet history, so transfers made elsewhere appear only after you add them here.</p>
    <div className="mt-3 grid gap-2 sm:grid-cols-[auto_1fr_auto]">
      <select aria-label="Transfer direction to find" value={findDirection} onChange={e => setFindDirection(e.target.value as Direction)} className="rounded-lg border border-slate-200 bg-white p-2 text-xs"><option value="arc-to-sui">Arc → Sui</option><option value="sui-to-arc">Sui → Arc</option></select>
      <input aria-label="Source transaction to find" value={findHash} onChange={e => { const v = e.target.value; setFindHash(v); if (/^0x/i.test(v.trim())) setFindDirection('arc-to-sui'); else if (/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(v.trim())) setFindDirection('sui-to-arc') }} maxLength={66} autoComplete="off" spellCheck={false} placeholder="Arc hash (0x…) or Sui digest" className="min-w-0 rounded-lg border border-slate-200 p-2 font-mono text-xs" />
      <button type="button" disabled={!findReady || !findHash.trim()} onClick={() => { const searched = findHash.trim(), who = owners; void check({ direction: findDirection, sourceId: searched }).then(x => {
        // A late answer for other wallets or a since-edited hash never takes over the panel or touches newer input.
        if (!x || ownersRef.current !== who) return
        // Edited since: keep it in history only; do not let auto-follow move the panel to it in this session.
        if (findRef.current.trim() !== searched) { setClosed(c => c.includes(x.id) || x.id === activeRef.current ? c : [...c, x.id]); return }
        setFlow(null); setActiveId(x.id); setFindHash('')
      }) }} className="rounded-lg border border-slate-300 px-3 py-2 text-xs font-semibold disabled:text-slate-400">{checking && checking === findHash.trim() ? 'Checking…' : 'Find'}</button>
    </div>
    {!ready && <p className="mt-2 text-xs text-slate-500">Connect the wallets that made the transfer: MetaMask on Arc Mainnet and Slush on Sui Mainnet.</p>}
    {checkError?.source && checkError.source !== tracking?.sourceId && <p role="alert" className="mt-2 rounded-xl bg-amber-50 p-3 text-xs leading-5 text-amber-900">{checkError.message}</p>}
  </details>

  const lastFinal = attempt && !open && attempt.state !== 'verified' ? attempt : null
  // Errors stay next to what they are about: the form (allowance read), the followed transfer, or the history/find form.
  const errorFor = (source: string | null) => checkError && checkError.source === source ? checkError.message : null
  // Which transfer the panel describes. A tracked record only drives it once this flow's own burn is recorded.
  const tracking = active && (!flow || (!step && !open && !(attempt?.state === 'verified' && attempt.intent.action === 'arc-approval'))) ? active : null
  const operating = Boolean(journalError || (attempt && open) || step || flow || tracking)
  let panel: ReactNode, panelPhase: string
  if (journalError) {
    panelPhase = 'journal-error'
    panel = <p role="alert" className="rounded-xl bg-amber-50 p-4 text-sm text-amber-900">{journalError} New transfers stay locked so nothing is sent twice.</p>
  } else if (operating) {
    const opDirection = attempt && open ? directionOf(attempt.intent.action) : step ? directionOf(step.action) : flow?.direction ?? tracking!.direction
    const opUnits = attempt && open ? attempt.intent.amount : step ? step.units : flow ? flow.units : parseUnits(tracking!.amount, 6)
    const v = tracking ? view(tracking) : null
    const approval = Boolean(flow?.approval || step?.action === 'arc-approval' || (attempt && open && attempt.intent.action === 'arc-approval'))
    const justSent = Boolean(tracking && attempt?.state === 'verified' && stepOf(attempt.intent.action) === 'receive' && attempt.intent.sourceId?.toLowerCase() === tracking.sourceId.toLowerCase() && v?.stage !== 'complete')
    const d = describeSuiFlow({ direction: opDirection, approval, evmWallet: walletName, attempt, open, step: step?.action ?? null, phase,
      stage: !(attempt && open) && !step ? v?.stage ?? null : null, hasFresh: Boolean(activeFresh),
      checkFailed: Boolean(tracking && errorFor(tracking.sourceId)), justSent })
    // In a wallet step the panel explains that step in its own words (the step component is bare).
    if (step && !(attempt && open)) d.detail = step.note ?? (step.action === 'arc-approval' ? `First, ${walletName} asks you to let the bridge use exactly ${formatUnits(step.units, 6)} USDC. This is a separate approval and moves no USDC. You then confirm the transfer itself.` : step.action === 'arc-burn' ? `Your USDC leaves your Arc wallet and is sent to your Sui wallet. Nothing is sent until you confirm in ${walletName}.` : 'Your USDC leaves your Sui wallet and is sent to your Arc wallet. Nothing is sent until you confirm in Slush.')
    else if (receive && tracking && !justSent && phase !== 'idle') d.detail = `Receive ${receive.receivedUsdc ?? receive.amount} USDC in your ${chainOf(tracking.direction, 'to')} wallet. Confirm in ${tracking.direction === 'arc-to-sui' ? 'Slush' : walletName}; the ${chainOf(tracking.direction, 'to')} network fee is paid there.`
    const current = d.steps.find(s => s.state !== 'done' && s.state !== 'pending')
    panelPhase = `${current?.key ?? 'done'}:${current?.state ?? 'done'}`
    const isChecking = Boolean(checking && tracking && checking === tracking.sourceId) || attemptChecking
    const statusLine = isChecking ? 'Checking now…' : tracking && v?.stage === 'waiting_attestation' && nextCheckAt ? `Next automatic check in ${Math.max(1, Math.ceil((nextCheckAt - now) / 1000))} s${activeFresh ? ` · last checked ${new Date(activeFresh.checkedAt).toLocaleTimeString()}` : ''}` : null
    const dest = v ? destinationLink(v) : null
    let action: ReactNode
    if (attempt && open) action = <SuiAttemptCard bare writer={writer} attempt={attempt} evmWallet={walletName} pollMs={pollMs.status} onChecking={setAttemptChecking} onAttempt={a => { setAttempt(a); if (!a) reload() }} />
    else if (step) action = <SuiStepReview key={`${step.action}:${step.units}`} bare writer={writer} action={step.action} base={base} ready={ready} evmWallet={walletName} autoPrepare onPhase={setPhase} onAttempt={a => { setAttempt(a); if (a && a.state !== 'rejected') { setStep(null); setPhase('idle') } }}
      aside={<button type="button" onClick={reset} className="text-xs font-semibold text-slate-500 underline">Cancel</button>} />
    else if (tracking && v) {
      const stage = v.stage
      action = <div className="space-y-3">
        {receive && !justSent && <SuiStepReview key={receive.sourceId} bare writer={writer} action={tracking.direction === 'arc-to-sui' ? 'sui-mint' : 'arc-mint'} ready={ready} evmWallet={walletName} onPhase={setPhase} onAttempt={a => { setAttempt(a); setPhase('idle') }}
          base={{ suiOwner: sui.address!, evmOwner: evm.address!, amount: parseUnits(receive.amount, 6), maxCctpFee: BigInt(receive.maxFeeUnits!), sourceId: receive.sourceId }}
          explain={<p>Receive {receive.receivedUsdc ?? receive.amount} USDC in your {chainOf(tracking.direction, 'to')} wallet. Confirm in {tracking.direction === 'arc-to-sui' ? 'Slush' : walletName}; the {chainOf(tracking.direction, 'to')} network fee is paid there.</p>} />}
        {!(receive && phase !== 'idle') && <Summary rows={[['Amount', `${tracking.amount} USDC`], ['Circle fee', v.feeUsdc !== undefined ? `${v.feeUsdc} USDC` : 'known after verification'], [stage === 'complete' ? 'You received' : 'You receive', v.receivedUsdc !== undefined ? `${v.receivedUsdc} USDC` : `≈ ${tracking.amount} USDC`], whenRow({ sourceTime: v.sourceTime ?? tracking.sourceTime, createdAt: tracking.createdAt })]} />}
        {stage === 'complete' && <p className="text-xs text-slate-600">You received {v.receivedUsdc ?? tracking.amount} USDC{v.feeUsdc && v.feeUsdc !== '0' ? ` (Circle fee ${v.feeUsdc} USDC)` : ''}.</p>}
        <div className="flex flex-wrap gap-3 text-xs"><a className="underline" href={sourceLink(tracking)} target="_blank" rel="noreferrer">Source transaction</a>{dest ? <a className="underline" href={dest} target="_blank" rel="noreferrer">Destination transaction</a> : v.stage === 'complete' && <span className="text-slate-500">Destination transaction not found yet</span>}</div>
      </div>
    } else action = flow ? <div className="space-y-2"><Summary rows={[['Amount', `${formatUnits(flow.units, 6)} USDC`], ['Route', `${chainOf(flow.direction, 'from')} → ${chainOf(flow.direction, 'to')}`]]} />
      {!(attempt?.state === 'verified') && <button type="button" onClick={reset} className="text-xs font-semibold text-slate-500 underline">Cancel</button>}</div> : null
    const err = tracking ? errorFor(tracking.sourceId) : errorFor(null)
    panel = <>
      <div className="flex min-h-[1.75rem] flex-wrap items-center justify-between gap-2"><p className="font-semibold">{chainOf(opDirection, 'from')} → {chainOf(opDirection, 'to')} · {formatUnits(opUnits, 6)} USDC</p>{isChecking && <span className="inline-flex items-center gap-1 text-xs text-slate-500"><Loader2 size={12} className="animate-spin" aria-hidden />Checking</span>}</div>
      <p role="status" aria-live="polite" className="mt-1 text-base font-semibold">{d.headline}</p>
      <ol aria-label="Transfer steps" className="mt-3 space-y-2 text-sm">{d.steps.map(s => <StepRow key={s.key} step={s} />)}</ol>
      <p className="mt-2 min-h-[2.5rem] text-xs leading-5 text-slate-500">{d.detail}{statusLine && <span className="block">{statusLine}</span>}</p>
      <div className="mt-2 flex-1">{action}</div>
      {err && <p role="alert" className="mt-3 rounded-xl bg-amber-50 p-3 text-xs leading-5 text-amber-900">{err}</p>}
      {tracking && !step && !(attempt && open) && <div className="mt-3 flex flex-wrap gap-4 text-xs">
        {view(tracking).stage === 'complete'
          ? <button type="button" onClick={() => { setClosed(c => [...c, tracking.id]); reset(); setAmount('') }} className="w-full rounded-xl bg-[#66D121] px-4 py-3 text-sm font-semibold text-slate-950">Start a new transfer</button>
          : <><button type="button" disabled={Boolean(checking)} onClick={() => void check(tracking)} className="font-semibold underline disabled:text-slate-400">{checking === tracking.sourceId ? 'Checking…' : 'Check now'}</button><button type="button" onClick={() => { setClosed(c => [...c, tracking.id]); reset() }} className="font-semibold text-slate-500 underline">Hide and start another transfer</button></>}
      </div>}
    </>
  } else {
    panelPhase = 'form'
    panel = <div className="flex flex-1 flex-col gap-3" aria-label="New Sui transfer">
      <Side label="From" chain={chainOf(direction, 'from')} wallet={direction === 'arc-to-sui' ? (evm.address ? `${walletName} · ${short(evm.address)}` : null) : (sui.address ? `${sui.walletName ?? 'Slush'} · ${short(sui.address)}` : null)} balance={sourceBalance} />
      <div className="-my-1 flex justify-center"><button type="button" aria-label="Switch direction" onClick={() => setDirection(d => d === 'arc-to-sui' ? 'sui-to-arc' : 'arc-to-sui')} className="rounded-full border border-slate-200 bg-white p-2 text-slate-600 shadow-sm hover:text-[#2F6E0C]"><ArrowDownUp size={16} /></button></div>
      <Side label="To" chain={chainOf(direction, 'to')} wallet={direction === 'arc-to-sui' ? (sui.address ? `${sui.walletName ?? 'Slush'} · ${short(sui.address)}` : null) : (evm.address ? `${walletName} · ${short(evm.address)}` : null)} />
      <label className="block text-sm font-medium">Amount<div className="mt-1 flex items-center gap-2 rounded-xl border border-slate-200 px-3"><input aria-label="Sui transfer amount" inputMode="decimal" autoComplete="off" value={amount} onChange={e => setAmount(e.target.value)} className="min-w-0 flex-1 bg-transparent py-3 text-lg outline-none" placeholder="0.00" /><span className="text-sm text-slate-500">USDC</span></div></label>
      <p className="text-xs text-slate-500">{sourceBalance !== null ? `Balance: ${sourceBalance} USDC.` : 'Balance not loaded yet; it is checked again at Review.'} Real Mainnet USDC; every step is confirmed in your wallet.</p>
      {amountError && <p className="text-xs text-amber-800">{amountError}</p>}
      <dl className="space-y-1 rounded-xl bg-slate-50 p-3 text-xs">
        <Line k="Circle fee" v={fee === null ? (feeBps === null ? 'Checking…' : '—') : `${formatUnits(fee, 6)} USDC`} />
        <Line k="You receive" v={units !== null && fee !== null && fee < units ? `≈ ${formatUnits(units - fee, 6)} USDC` : '—'} />
        <Line k={`${chainOf(direction, 'from')} network fee`} v={direction === 'arc-to-sui' ? 'up to 0.02 USDC · exact in review' : 'up to 0.05 SUI · exact in review'} />
        <Line k={`${chainOf(direction, 'to')} network fee`} v={direction === 'arc-to-sui' ? 'up to 0.05 SUI · paid when you receive' : 'up to 0.02 USDC · paid when you receive'} />
      </dl>
      <div className="mt-auto space-y-2">
        {lastFinal && <p className="rounded-xl bg-slate-50 p-3 text-xs text-slate-600">Last wallet step: {attemptLabels[lastFinal.state]}.</p>}
        {errorFor(null) && <p role="alert" className="rounded-xl bg-amber-50 p-3 text-xs leading-5 text-amber-900">{errorFor(null)}</p>}
        {!ready && <p className="rounded-xl bg-slate-50 p-3 text-xs text-slate-600">{!evm.address ? (evm.desktopHint ? 'This phone browser has no built-in EVM wallet. Sui ↔ Arc needs MetaMask and Slush connected in the same browser, and connecting MetaMask from here through WalletConnect is not reliable in wallet app browsers. Use a desktop browser with the MetaMask and Slush extensions.' : 'Connect your EVM wallet (Arc) in the top bar.') : !evm.onArc ? 'Switch your EVM wallet to Arc Mainnet in the top bar.' : !sui.address ? 'Connect Slush (Sui) in the top bar.' : 'Use a Slush account on Sui Mainnet.'}</p>}
        <button type="button" onClick={() => void startReview()} disabled={!ready || !units || Boolean(amountError) || !writer.writesEnabled || starting} className="inline-flex w-full items-center justify-center gap-2 rounded-xl bg-[#66D121] px-4 py-3 font-semibold text-slate-950 disabled:cursor-not-allowed disabled:bg-slate-200 disabled:text-slate-500">{starting && <Loader2 size={16} className="animate-spin" aria-hidden />}{!writer.writesEnabled ? 'Sui transfers locked' : starting ? 'Checking your allowance…' : 'Review transfer'}</button>
      </div>
    </div>
  }

  return <div className="space-y-4">
    {/* One panel for the whole transfer: same frame in every phase. The reserved height fits the form and every
        progress/waiting step; only a wallet Review sheet may extend it downward (nothing above moves). */}
    <section aria-label="Sui transfer panel" data-phase={panelPhase} className="flex min-h-[37rem] flex-col sm:min-h-[34rem] rounded-2xl border border-slate-200 p-4 text-sm">{panel}</section>
    {renderHistory(tracking)}
    {renderRecovery(tracking)}
  </div>
}
function StepRow({ step }: { step: SuiFlowStep }) {
  const icon = step.state === 'done' ? <CheckCircle2 size={16} className="text-[#2F6E0C]" />
    : step.state === 'run' ? <Loader2 size={16} className="animate-spin text-slate-700" data-spinner />
    : step.state === 'action' ? <MousePointerClick size={16} className="text-amber-700" />
    : step.state === 'warn' || step.state === 'error' ? <AlertTriangle size={16} className={step.state === 'error' ? 'text-red-700' : 'text-amber-700'} />
    : <Circle size={16} className="text-slate-300" />
  const color = step.state === 'done' ? 'text-[#2F6E0C]' : step.state === 'pending' ? 'text-slate-400' : step.state === 'error' ? 'text-red-800' : step.state === 'warn' || step.state === 'action' ? 'text-amber-900' : 'text-slate-900'
  return <li data-step={step.key} data-state={step.state} aria-current={step.state !== 'done' && step.state !== 'pending' ? 'step' : undefined} className={`flex min-h-[1.5rem] items-center gap-2 ${color} ${step.state !== 'done' && step.state !== 'pending' ? 'font-semibold' : ''}`}><span className="shrink-0" aria-hidden>{icon}</span><span>{step.label}</span></li>
}
function Summary({ rows }: { rows: [string, string][] }) {
  return <dl className="space-y-1 rounded-xl bg-slate-50 p-3 text-xs">{rows.map(([k, v]) => <Line key={k} k={k} v={v} />)}</dl>
}
function Side({ label, chain, wallet, balance }: { label: string; chain: string; wallet: string | null; balance?: string | null }) {
  return <div className="rounded-2xl border border-slate-200 p-3 text-sm"><div className="flex items-center justify-between gap-2"><span className="text-xs text-slate-500">{label}</span>{balance != null && <span className="text-xs text-slate-500">{balance} USDC</span>}</div>
    <p className="mt-1 font-semibold">{chain} Mainnet</p><p className="truncate text-xs text-slate-600">{wallet ?? 'Not connected · use the top bar'}</p></div>
}
function Line({ k, v }: { k: string; v: string }) { return <div className="flex flex-wrap justify-between gap-x-3"><dt className="text-slate-500">{k}</dt><dd className="text-right font-medium">{v}</dd></div> }
