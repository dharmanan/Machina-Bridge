import { useEffect, useRef, useState } from 'react'
import { useAccount } from 'wagmi'
import { useQueryClient } from '@tanstack/react-query'
import { formatUnits } from 'viem'
import { ARC_TOKENS, requestKey, sameAddress, tokenUnits, type ArcRequest } from '../lib/uniswapArcPolicy'
import { connectedExecutionProvider } from '../lib/uniswapArcWalletRpc'
import { browserExecutionLock, type ExecutionContext } from '../lib/uniswapArcExecution'
import { swapExecutionRestriction } from '../lib/swap/executionMode'
import { APPROVAL_STORAGE_PREFIX, createUniswapApprovals, listStoredApprovals, type ApprovalAttempt, type ApprovalPlan, type ApprovalView, type StoredApprovals } from '../lib/swap/uniswapApprovals'
import { createApprovalRpc } from '../lib/swap/uniswapApprovalsRpc'
import { SWAP_EXECUTION } from '../config/swapExecution'
import { PlainMessage } from './PlainMessage'

const rpc = createApprovalRpc()

export type PlanState = { state: 'idle' } | { state: 'loading' } | { state: 'error' } | ApprovalPlan

// Approvals for an ERC-20 input. Each approval is reviewed and confirmed on its own; this hook never sends anything by itself.
export function useUniswapApprovals(input: ArcRequest | null, blockedBy: (owner: string) => boolean = () => false) {
  const { address, chainId, isConnected, connector } = useAccount()
  const queryClient = useQueryClient()
  const [view, setView] = useState<ApprovalView>({ phase: 'idle' })
  const [plan, setPlan] = useState<PlanState>({ state: 'idle' })
  const [history, setHistory] = useState<ApprovalAttempt[]>([])
  const [stored, setStored] = useState<StoredApprovals[]>([])
  const alive = useRef(true)
  const context = useRef<ExecutionContext>({ owner: '', connected: false, chainId: 0, connectorId: '' })
  const currentInput = useRef(input), currentConnector = useRef(connector), currentBlockedBy = useRef(blockedBy)
  context.current = { owner: address ?? '', connected: isConnected, chainId: chainId ?? 0, connectorId: connector?.uid ?? '' }
  currentInput.current = input; currentConnector.current = connector; currentBlockedBy.current = blockedBy
  const [controller] = useState(() => createUniswapApprovals({
    context: () => alive.current ? context.current : { ...context.current, connected: false },
    authorize: (request, current) => swapExecutionRestriction(SWAP_EXECUTION, request, current) === null,
    blockedBy: owner => currentBlockedBy.current(owner),
    reads: rpc.reads, estimate: rpc.estimate, nonces: rpc.nonces, result: rpc.result,
    provider: () => connectedExecutionProvider(currentConnector.current),
    storage: { getItem: key => window.localStorage.getItem(key), setItem: (key, value) => window.localStorage.setItem(key, value) },
    lock: browserExecutionLock, now: () => Date.now(),
    changed: next => { if (alive.current) setView(next) },
    settled: attempt => {
      void queryClient.invalidateQueries({ predicate: query => {
        const key = query.queryKey, args = key[1] as { address?: string; chainId?: number } | undefined
        return Boolean(args && args.chainId === 5042 && (key[0] === 'balance' || key[0] === 'readContract') && attempt.owner)
      } })
    },
  }))
  const inputKey = input ? requestKey(input) : null
  const binding = JSON.stringify([address, chainId, isConnected, connector?.uid, inputKey])
  const needsApproval = Boolean(input && input.tokenIn !== 'USDC' && isConnected && chainId === 5042 && sameAddress(address, input.owner))

  // The plan is read from the chain for the exact amount; it is refreshed when the inputs change and after every approval settles.
  const planVersion = useRef(0)
  async function refreshPlan() {
    const version = ++planVersion.current, request = currentInput.current
    if (!request || !needsApproval) { setPlan({ state: 'idle' }); return }
    setPlan(previous => (previous.state === 'needed' || previous.state === 'complete' ? previous : { state: 'loading' }))
    try {
      const next = await controller.plan(request)
      if (version === planVersion.current && alive.current) setPlan(next)
    } catch { if (version === planVersion.current && alive.current) setPlan({ state: 'error' }) }
  }
  useEffect(() => {
    controller.invalidate()
    const timer = setTimeout(() => { void refreshPlan() }, 400)
    return () => clearTimeout(timer)
  }, [binding, needsApproval])
  useEffect(() => { if (['confirmed', 'failed', 'mismatch', 'rejected'].includes(view.phase)) void refreshPlan() }, [view.phase])
  useEffect(() => {
    if (!address || !isConnected) { setHistory([]); return }
    try { setHistory(controller.history(address)) } catch { setHistory([]) }
    void controller.reconcile(address)
  }, [address, isConnected, controller, view.phase])
  useEffect(() => { try { setStored(listStoredApprovals(window.localStorage)) } catch { setStored([]) } }, [address, isConnected, view])
  useEffect(() => {
    alive.current = true
    const changed = (event: StorageEvent) => { if (event.key?.startsWith(APPROVAL_STORAGE_PREFIX)) { controller.invalidate(); void controller.reconcile() } }
    window.addEventListener('storage', changed)
    return () => { alive.current = false; controller.invalidate(); window.removeEventListener('storage', changed) }
  }, [controller])
  const [, tick] = useState(0)
  useEffect(() => {
    if (!view.review) return
    const timer = setInterval(() => tick(n => n + 1), 500)
    return () => clearInterval(timer)
  }, [Boolean(view.review)])
  const [pageHidden, setPageHidden] = useState(() => typeof document !== 'undefined' && document.hidden)
  useEffect(() => {
    const visibility = () => setPageHidden(document.hidden)
    document.addEventListener('visibilitychange', visibility)
    return () => document.removeEventListener('visibilitychange', visibility)
  }, [])
  useEffect(() => {
    const delay = view.nextCheckMs
    if (typeof delay !== 'number' || view.checking || pageHidden || !isConnected || !view.attempt?.hash || !sameAddress(address, view.attempt.owner)) return
    const owner = view.attempt.owner, timer = setTimeout(() => { if (!document.hidden) void controller.reconcile(owner) }, delay)
    return () => clearTimeout(timer)
  }, [view.nextCheckMs, view.checking, view.attempt?.id, view.observedAt, view.phase, pageHidden, controller, address, isConnected])

  const visibleView: ApprovalView = !isConnected || !sameAddress(address, view.attempt?.owner ?? view.review?.request.owner ?? address ?? '') ? { phase: 'idle' } : view
  return {
    view: visibleView, plan, history, stored, needsApproval, remainingMs: view.review ? Math.max(0, view.review.expiresAt - Date.now()) : 0,
    blocking: (owner: string) => controller.blocking(owner),
    prepare: () => (currentInput.current ? controller.prepare(currentInput.current) : Promise.resolve()),
    confirm: () => (view.review ? controller.confirm(view.review.id) : Promise.resolve()),
    cancel: () => controller.invalidate(),
    check: (owner?: string, id?: string) => controller.reconcile(owner ?? address, id),
    recover: (hash: string) => controller.recover(address ?? '', hash),
  }
}
export type UniswapApprovals = ReturnType<typeof useUniswapApprovals>

const kindText = (step: { kind: string; token: string; amount: string }) => {
  const amount = `${formatUnits(BigInt(step.amount), ARC_TOKENS[step.token as keyof typeof ARC_TOKENS].decimals)} ${step.token}`
  return step.kind === 'token' ? `Let Uniswap use exactly ${amount}` : `Let the Uniswap router use exactly ${amount} for 15 minutes`
}
// Shown only for an ERC-20 input. Says exactly which approvals are missing, for which amount, and what each costs; each one is a
// separate review and wallet confirmation. Nothing here is unlimited.
export function ApprovalsPanel({ approvals, request }: { approvals: UniswapApprovals; request: ArcRequest | null }) {
  const { view, plan } = approvals
  if (!approvals.needsApproval || !request) return null
  const token = ARC_TOKENS[request.tokenIn], amountText = `${formatUnits(tokenUnits(request.amount, token.decimals), token.decimals)} ${request.tokenIn}`
  const busy = ['preparing', 'checking', 'awaiting_wallet', 'pending', 'unknown'].includes(view.phase)
  const review = view.review
  return <section aria-label="Token approvals" className="min-h-[3.5rem] space-y-2 rounded-2xl border border-slate-200 p-4 text-sm">
    <h2 className="font-semibold text-slate-900">Approvals for {request.tokenIn}</h2>
    {plan.state === 'loading' || plan.state === 'idle' ? <p role="status" className="text-slate-500">Checking your current approvals…</p> : null}
    {plan.state === 'error' && <p role="status" className="text-amber-800">We couldn’t read your current approvals just now. Nothing was requested; please try again.</p>}
    {plan.state === 'blocked' && <p role="status" className="text-amber-800">Your wallet does not hold {amountText}.</p>}
    {plan.state === 'complete' && <p role="status" className="text-[#2F6E0C]">Approvals for exactly {amountText} are in place. You can review the swap.</p>}
    {plan.state === 'needed' && !review && <>
      <p className="text-slate-700">This swap needs {plan.steps.length === 1 ? '1 approval' : `${plan.steps.length} approvals`} for exactly {amountText}, never more. Each one is confirmed separately in your wallet and has a small network fee.</p>
      <ol className="list-decimal space-y-1 pl-5 text-slate-700">{plan.steps.map(step => <li key={step.kind}>{kindText(step)}</li>)}</ol>
      <button type="button" onClick={() => { void approvals.prepare() }} disabled={busy}
        className="w-full rounded-xl border border-[#2F6E0C] px-4 py-2 font-semibold text-[#2F6E0C] disabled:opacity-50">{view.phase === 'preparing' ? 'Preparing approval…' : `Review approval 1 of ${plan.steps.length}`}</button>
    </>}
    {review && <div className="space-y-2 rounded-xl bg-slate-50 p-3">
      <p className="font-medium">{kindText(review.step)}</p>
      <dl className="space-y-1">
        <Row label="Amount" value={`${formatUnits(BigInt(review.step.amount), token.decimals)} ${review.step.token} (exact)`} />
        {review.step.expiration > 0 && <Row label="Valid until" value={`${new Date(review.step.expiration * 1000).toISOString().slice(11, 19)} UTC`} />}
        <Row label="Network fee (maximum)" value={`${formatUnits(BigInt(review.networkFee), 18)} USDC`} />
        <Row label="This review expires in" value={`${Math.ceil(approvals.remainingMs / 1000)} seconds`} />
      </dl>
      <details className="text-xs text-slate-500"><summary className="cursor-pointer">Technical details</summary>
        <ul className="mt-1 space-y-1 break-all"><li>Contract: {review.transaction.to}</li><li>Allowed spender: {review.step.spender}</li><li>Transaction number (nonce): {review.nonce}</li><li>Gas limit: {review.gas}</li></ul></details>
      <div className="flex gap-3">
        <button type="button" onClick={approvals.cancel} disabled={view.phase !== 'review'} className="flex-1 rounded-xl border border-slate-300 px-4 py-2 disabled:opacity-50">Cancel</button>
        <button type="button" onClick={() => { void approvals.confirm() }} disabled={view.phase !== 'review' || approvals.remainingMs < 5000}
          className="flex-1 rounded-xl bg-[#2F6E0C] px-4 py-2 font-semibold text-white disabled:opacity-50">{view.phase === 'checking' ? 'Rechecking…' : approvals.remainingMs <= 0 ? 'Review expired' : 'Confirm approval'}</button>
      </div>
    </div>}
    {['awaiting_wallet', 'pending', 'unknown'].includes(view.phase) && view.attempt && <p role="status" className="text-sky-800">
      {view.phase === 'awaiting_wallet' ? 'Confirm the approval in your wallet…' : view.phase === 'pending' ? 'Verifying approval…' : 'We haven’t confirmed this approval yet. Please don’t approve again until it is settled.'}</p>}
    {view.error && !view.attempt && <PlainMessage raw={view.error} />}
  </section>
}
function Row({ label, value }: { label: string; value: string }) {
  return <div className="grid grid-cols-[auto_minmax(0,1fr)] gap-3"><dt className="text-slate-500">{label}</dt><dd className="break-all text-right">{value}</dd></div>
}
