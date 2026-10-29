import { useEffect, useRef, useState } from 'react'
import { formatUnits, parseUnits } from 'viem'
import type { SuiArcMethod, SuiWriteAction, SuiWriteAttempt, SuiWriteIntent, SuiWriteReconciliation, SuiWriteReview } from '../lib/mainnetSuiExecution'
import type { SuiRecoveryResult } from '../lib/mainnetSuiRecovery'
import type { SuiTransferWriter } from '../hooks/useSuiMainnetWrite'
import { MAINNET_SUI_CCTP_TEST_MAX_UNITS } from '../config/sui'

type Direction = SuiRecoveryResult['direction']
// Explicit network-fee ceilings. The prepared transaction must stay within them;
// they are never raised automatically.
export const SUI_GAS_CEILING_MIST = 50_000_000n // 0.05 SUI
export const ARC_GAS_CEILING_WEI = 20_000_000_000_000_000n // 0.02 USDC (Arc native gas, 18 decimals)
const actionLabels: Record<SuiWriteAction, string> = {
  'sui-burn': 'Burn USDC on Sui', 'arc-approval': 'Approve exact USDC amount on Arc', 'arc-burn': 'Burn USDC on Arc',
  'sui-mint': 'Receive USDC on Sui', 'arc-mint': 'Receive USDC on Arc',
}
const stateLabels: Record<SuiWriteAttempt['state'], string> = {
  signing: 'Waiting for wallet signature', sending: 'Sent to the wallet · result not yet recorded', mismatch: 'Wallet sent a DIFFERENT transaction · not accepted, never completed', reconciled: 'Different transaction reconciled with chain evidence · not a successful transfer', broadcasting: 'Submitted · outcome not yet proven', unknown: 'Outcome unknown · check status before anything else',
  pending: 'Submitted · waiting for canonical chain proof', verified: 'Verified on chain', reverted: 'Failed on chain · no transfer happened', rejected: 'Signature rejected · nothing was sent',
}
// A mismatch stays unresolved: nothing new may start until it is reconciled.
const unresolved = (a: SuiWriteAttempt | null) => Boolean(a && !['verified', 'reverted', 'rejected', 'reconciled'].includes(a.state))
const methodLabels: Record<SuiArcMethod, string> = { 'sign-only': 'Sign only, Machina broadcasts (eth_signTransaction)', 'wallet-send': 'Wallet signs and broadcasts (eth_sendTransaction)' }
const short = (v: string) => v.length > 18 ? `${v.slice(0, 10)}…${v.slice(-6)}` : v
function gasText(action: SuiWriteAction, value: bigint) { return action.startsWith('sui-') ? `${formatUnits(value, 9)} SUI` : `${formatUnits(value, 18)} USDC` }
function parseAmount(text: string) {
  if (!/^(?:0|[1-9][0-9]{0,11})(?:\.[0-9]{1,6})?$/.test(text.trim())) return null
  const v = parseUnits(text.trim(), 6); return v > 0n && v <= MAINNET_SUI_CCTP_TEST_MAX_UNITS ? v : null
}
function message(error: unknown) { return error instanceof Error && error.message ? error.message : 'The operation could not be verified. Nothing further will be sent.' }

export type MainnetSuiTransferProps = {
  writer: SuiTransferWriter
  direction: Direction
  suiOwner?: string
  evmOwner?: string
  ready: boolean
  // A fresh, read-only recovery result for the CURRENT wallets and route. Stored
  // history is never accepted here; it would not be destination-mint authority.
  recovery: SuiRecoveryResult | null
  onSource(direction: Direction, sourceId: string): void
}

export default function MainnetSuiTransfer({ writer, direction, suiOwner, evmOwner, ready, recovery, onSource }: MainnetSuiTransferProps) {
  const [amount, setAmount] = useState('')
  const [step, setStep] = useState<'approval' | 'burn'>('burn')
  // Explicit user choice only; never switched by the app after a failure.
  const [method, setMethod] = useState<SuiArcMethod>('sign-only')
  const [held, setHeld] = useState<{ key: string; review: SuiWriteReview } | null>(null)
  const [busy, setBusy] = useState<'prepare' | 'confirm' | 'recover' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [attempt, setAttempt] = useState<SuiWriteAttempt | null>(null)
  const [now, setNow] = useState(() => Date.now())
  const [evidence, setEvidence] = useState<SuiWriteReconciliation | null>(null)
  // A ready mint above the live-test cap is not offered; read-only recovery still shows it.
  const mint = recovery?.stage === 'ready_to_mint' && recovery.direction === direction && recovery.maxFeeUnits !== undefined && parseUnits(recovery.amount, 6) <= MAINNET_SUI_CCTP_TEST_MAX_UNITS ? recovery : null
  const action: SuiWriteAction = mint ? (direction === 'sui-to-arc' ? 'arc-mint' : 'sui-mint') : direction === 'sui-to-arc' ? 'sui-burn' : step === 'approval' ? 'arc-approval' : 'arc-burn'
  const arcStep = action.startsWith('arc-')
  const key = JSON.stringify([direction, action, arcStep ? method : '', suiOwner ?? '', evmOwner ?? '', ready, mint ? [mint.sourceId, mint.amount, mint.maxFeeUnits] : amount.trim()])
  const live = useRef(key); live.current = key
  // A Review renders and confirms ONLY for the exact inputs it was prepared for,
  // synchronously in the same render; the effect below then drops it for good.
  const review = held && held.key === key ? held.review : null

  // Any change of route, step, amount, source or wallet cancels the Review and
  // the controller's approval generation; the earlier review can never confirm.
  useEffect(() => { writer.invalidate(); setHeld(null); setError(null) }, [writer, key])
  useEffect(() => { try { setAttempt(writer.saved()) } catch (e) { setError(message(e)) } }, [writer, suiOwner, evmOwner])
  useEffect(() => { if (!review) return; const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t) }, [review])

  const blocked = unresolved(attempt)
  const from = direction === 'sui-to-arc' ? { label: 'From Sui wallet', value: suiOwner } : { label: 'From Arc wallet', value: evmOwner }
  const to = direction === 'sui-to-arc' ? { label: 'To Arc wallet', value: evmOwner } : { label: 'To Sui wallet', value: suiOwner }

  async function intent(): Promise<SuiWriteIntent> {
    if (!suiOwner || !evmOwner) throw new Error('Connect both the Sui and Arc Mainnet wallets.')
    const gasCeiling = action.startsWith('sui-') ? SUI_GAS_CEILING_MIST : ARC_GAS_CEILING_WEI
    const arcMethod = arcStep ? { arcMethod: method } : {}
    if (mint) return { action, suiOwner, evmOwner, amount: parseUnits(mint.amount, 6), maxCctpFee: BigInt(mint.maxFeeUnits!), gasCeiling, sourceId: mint.sourceId, ...arcMethod }
    const value = parseAmount(amount); if (!value) throw new Error('Enter a USDC amount with at most 6 decimals.')
    const bps = await writer.feeBps(direction)
    // Ceil to base units so the reviewed maximum is never below Circle's minimum.
    const milli = BigInt(Math.ceil(bps * 1000))
    return { action, suiOwner, evmOwner, amount: value, maxCctpFee: (value * milli + 9_999_999n) / 10_000_000n, gasCeiling, ...arcMethod }
  }
  async function prepare() {
    const k = key; setBusy('prepare'); setError(null); setHeld(null)
    try { const r = await writer.prepare(await intent()); if (live.current === k) setHeld({ key: k, review: r }) }
    catch (e) { if (live.current === k) setError(message(e)) }
    finally { setBusy(null) }
  }
  async function confirm() {
    const r = review
    // Explicit click only, on the review currently displayed for these exact inputs.
    if (!r || live.current !== key || Date.now() >= r.expiresAt || r.intent.action !== action || (r.intent.arcMethod ?? 'sign-only') !== (arcStep ? method : 'sign-only') || r.intent.suiOwner !== suiOwner || r.intent.evmOwner !== evmOwner) { setHeld(null); setError('Review changed or expired. Prepare a new review.'); return }
    setBusy('confirm'); setError(null); setHeld(null)
    try { setAttempt(await writer.confirm(r)) }
    catch (e) { setError(message(e)); try { setAttempt(writer.saved()) } catch { /* journal error already blocks sends */ } }
    finally { setBusy(null) }
  }
  async function inspectMismatch() {
    setBusy('recover'); setError(null); setEvidence(null)
    try { setEvidence(await writer.inspectMismatch()) } catch (e) { setError(message(e)) } finally { setBusy(null) }
  }
  async function reconcile() {
    const shown = evidence; if (!shown) return
    setBusy('recover'); setError(null)
    try { setAttempt(await writer.reconcile(shown.key)); setEvidence(null) } catch (e) { setEvidence(null); setError(message(e)) } finally { setBusy(null) }
  }
  async function recover() {
    setBusy('recover'); setError(null)
    try { setAttempt(await writer.recover()) } catch (e) { setError(message(e)) } finally { setBusy(null) }
  }
  const expired = review ? now >= review.expiresAt : false
  const canPrepare = writer.writesEnabled && ready && !blocked && !busy && (mint || parseAmount(amount))
  const nextSource = attempt?.state === 'verified' && attempt.digest && (attempt.intent.action === 'sui-burn' || attempt.intent.action === 'arc-burn') ? attempt : null

  return <div className="space-y-3 rounded-xl border border-slate-200 p-3 text-xs" aria-label="Sui transfer review">
    <p className="font-semibold text-sm">{mint ? 'Receive the attested transfer' : 'New transfer'} · {direction === 'sui-to-arc' ? 'Sui → Arc' : 'Arc → Sui'}</p>
    {!writer.writesEnabled && <p className="rounded-lg bg-slate-100 p-2 leading-5 text-slate-600">Sending is disabled on this deployment. Review and Confirm stay locked; nothing can be signed or submitted here.</p>}
    {!mint && <label className="block font-medium">Amount (USDC)<input aria-label="Sui transfer amount" inputMode="decimal" autoComplete="off" value={amount} onChange={e => setAmount(e.target.value)} className="mt-1 w-full min-w-0 rounded-xl border border-slate-200 px-3 py-3" placeholder="0.00" max={formatUnits(MAINNET_SUI_CCTP_TEST_MAX_UNITS, 6)} /><span className="mt-1 block text-[11px] text-slate-500">Test limit: at most {formatUnits(MAINNET_SUI_CCTP_TEST_MAX_UNITS, 6)} USDC per transaction.</span></label>}
    {!mint && direction === 'arc-to-sui' && <fieldset className="flex flex-wrap gap-3"><legend className="mb-1 font-medium">Arc step</legend>
      <label className="flex items-center gap-1"><input type="radio" name="arc-step" checked={step === 'approval'} onChange={() => setStep('approval')} />1 · Approve exact amount</label>
      <label className="flex items-center gap-1"><input type="radio" name="arc-step" checked={step === 'burn'} onChange={() => setStep('burn')} />2 · Burn</label></fieldset>}
    {arcStep && <fieldset className="space-y-1"><legend className="mb-1 font-medium">Arc wallet method</legend>
      {(['sign-only', 'wallet-send'] as const).map(m => <label key={m} className="flex items-start gap-1"><input type="radio" name="arc-method" className="mt-1" checked={method === m} disabled={m === 'wallet-send' && !writer.walletSendEnabled} onChange={() => setMethod(m)} /><span>{methodLabels[m]}{m === 'wallet-send' && !writer.walletSendEnabled ? ' · disabled on this deployment' : ''}</span></label>)}
      {method === 'wallet-send' && <p className="rounded-lg bg-amber-50 p-2 leading-5 text-amber-900">The wallet signs and broadcasts by itself. Machina cannot see or block the signed transaction before it is sent; it only checks afterwards that the chain transaction matches this Review. A mismatch is reported, never completed.</p>}
      {method === 'sign-only' && /cannot sign separately/.test(error ?? '') && <p className="leading-5 text-slate-600">This wallet does not offer sign-only. You can choose "Wallet signs and broadcasts" above and prepare a new Review; nothing switches automatically.</p>}
    </fieldset>}
    {mint && <p className="leading-5">Source {short(mint.sourceId)} · {mint.amount} USDC · attestation checked. The mint is re-verified against the chain before any signature.</p>}
    <button type="button" onClick={() => void prepare()} disabled={!canPrepare} className="w-full rounded-xl border border-slate-300 px-4 py-3 font-semibold disabled:cursor-not-allowed disabled:text-slate-400">{!writer.writesEnabled ? 'Sui transfers locked' : busy === 'prepare' ? 'Preparing and simulating…' : `Review: ${actionLabels[action]}`}</button>
    {review && <section role="region" aria-label="Transaction review" className="space-y-1 rounded-xl bg-slate-50 p-3 leading-5 break-words">
      <p className="font-semibold">{actionLabels[review.intent.action]}</p>
      <p>{from.label}: <span className="font-mono break-all">{from.value}</span></p>
      <p>{to.label}: <span className="font-mono break-all">{to.value}</span></p>
      <p>Signing wallet: {review.intent.action.startsWith('sui-') ? 'Sui (Slush)' : 'Arc EVM wallet'}</p>
      {review.intent.action.startsWith('arc-') && <p>Method: {methodLabels[review.intent.arcMethod ?? 'sign-only']}{review.intent.arcMethod === 'wallet-send' ? ' · verified only after broadcast' : ''}</p>}
      <p>Amount: {formatUnits(review.intent.amount, 6)} USDC</p>
      {review.intent.action !== 'arc-approval' && <p>Maximum Circle fee: {formatUnits(review.intent.maxCctpFee, 6)} USDC</p>}
      <p>Estimated network fee: {gasText(review.intent.action, review.estimatedGas)}</p>
      <p>Network fee ceiling: {gasText(review.intent.action, review.maximumGas)} (limit {gasText(review.intent.action, review.intent.gasCeiling)})</p>
      <details open><summary className="cursor-pointer font-medium">Transaction content (decoded from the exact bytes)</summary><ul className="mt-1 list-disc pl-4 font-mono text-[11px]">{review.content.map((l, n) => <li key={n} className="break-all">{l}</li>)}</ul>
        <p className="mt-1 font-mono text-[11px] break-all">Commitment {review.commitment}{review.digest ? ` · digest ${review.digest}` : ''}</p></details>
      <p className={expired ? 'font-semibold text-amber-800' : 'text-slate-500'}>{expired ? 'Review expired. Prepare a new review.' : `Valid for ${Math.max(0, Math.ceil((review.expiresAt - now) / 1000))} s. Any wallet, network or input change cancels it.`}</p>
      <button type="button" onClick={() => void confirm()} disabled={!writer.writesEnabled || expired || Boolean(busy)} className="mt-2 w-full rounded-xl bg-[#66D121] px-4 py-3 font-semibold text-slate-950 disabled:cursor-not-allowed disabled:bg-slate-200 disabled:text-slate-500">{writer.writesEnabled ? `Confirm in ${review.intent.action.startsWith('sui-') ? 'Slush' : 'Arc wallet'}` : 'Confirm locked'}</button>
    </section>}
    {busy === 'confirm' && <p role="status">Waiting for the wallet. Do not close this tab.</p>}
    {attempt && <div role="status" className="space-y-1 rounded-xl border border-slate-200 p-3 leading-5 break-words">
      <p className="font-semibold">{actionLabels[attempt.intent.action]} · {stateLabels[attempt.state]}</p>
      <p>{formatUnits(attempt.intent.amount, 6)} USDC{attempt.digest ? <> · <span className="font-mono break-all">{attempt.digest}</span></> : ' · no transaction ID recorded'}</p>
      {blocked && attempt.state !== 'mismatch' && <><p>A new transfer is blocked until this one is proven on chain. Nothing will be sent again automatically.</p>
        <button type="button" onClick={() => void recover()} disabled={Boolean(busy)} className="font-semibold underline disabled:text-slate-400">{busy === 'recover' ? 'Checking chain…' : 'Check transaction status'}</button></>}
      {attempt.state === 'mismatch' && <><p>New approvals, burns and mints stay locked. The lock opens only after the chain shows exactly what this transaction did and you acknowledge it.</p>
        <button type="button" onClick={() => void inspectMismatch()} disabled={Boolean(busy)} className="font-semibold underline disabled:text-slate-400">{busy === 'recover' ? 'Reading chain evidence…' : 'Check mismatch evidence'}</button>
        {evidence && <section role="region" aria-label="Mismatch evidence" className="space-y-1 rounded-lg bg-amber-50 p-2 text-amber-950"><ul className="list-disc pl-4 font-mono text-[11px]">{evidence.lines.map((l, n) => <li key={n} className="break-all">{l}</li>)}</ul>
          <button type="button" onClick={() => void reconcile()} disabled={Boolean(busy)} className="mt-1 w-full rounded-lg border border-amber-700 px-3 py-2 font-semibold disabled:text-slate-400">I reviewed this evidence · release the lock</button></section>}</>}
      {nextSource && <button type="button" onClick={() => onSource(nextSource.intent.action === 'sui-burn' ? 'sui-to-arc' : 'arc-to-sui', nextSource.digest!)} className="font-semibold underline">Track attestation and destination for this burn</button>}
    </div>}
    {error && <p role="alert" className="rounded-xl bg-amber-50 p-3 leading-5 text-amber-900">{error}</p>}
  </div>
}
