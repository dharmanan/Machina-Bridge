import { useEffect, useRef, useState } from 'react'
import { useAccount } from 'wagmi'
import { useQueryClient } from '@tanstack/react-query'
import { formatUnits } from 'viem'
import { connectedExecutionProvider } from '../lib/uniswapArcWalletRpc'
import { sameAddress } from '../lib/uniswapArcPolicy'
import { circleExecutionRestriction, executionRestrictionMessage } from '../lib/swap/executionMode'
import {
  CIRCLE_SWAP_WRITES_ENABLED, browserCircleLock, circleRequestKey, createCircleSwapExecution, listStoredCircleAttempts,
  type CircleContext, type CircleSwapAttempt, type CircleSwapRequest, type CircleView, type StoredCircleHistory,
} from '../lib/swap/circleSwap'
import { buildCircleReview, circleChainRpc, circleReviewDeps, circleSdk } from '../lib/swap/circleSdk'
import { swapToken } from '../lib/swap/tokens'
import { CIRCLE_ADAPTER } from '../lib/swap/circleAdapterDecode'
import { SWAP_EXECUTION } from '../config/swapExecution'

// Circle Swap Kit execution through the connected wagmi wallet. The SDK only ever sees the guarded wallet; every step is confirmed in the
// app first, then in the wallet. `blocked` lets the caller hold a swap while another provider's transaction of the same wallet is unresolved.
export function useCircleSwapExecution(input: CircleSwapRequest | null, blocked: (owner: string) => boolean = () => false) {
  const { address, chainId, isConnected, connector } = useAccount()
  const queryClient = useQueryClient()
  const [history, setHistory] = useState<CircleSwapAttempt[]>([])
  const [historyError, setHistoryError] = useState(false)
  const [view, setView] = useState<CircleView>({ phase: 'idle' })
  const [, tick] = useState(0)
  const alive = useRef(true)
  const context = useRef<CircleContext>({ owner: '', connected: false, chainId: 0, connectorId: '' })
  const currentInput = useRef(input), currentConnector = useRef(connector), currentBlocked = useRef(blocked)
  context.current = { owner: address ?? '', connected: isConnected, chainId: chainId ?? 0, connectorId: connector?.uid ?? '' }
  currentInput.current = input; currentConnector.current = connector; currentBlocked.current = blocked
  const [controller] = useState(() => createCircleSwapExecution({
    context: () => alive.current ? context.current : { ...context.current, connected: false }, input: () => alive.current ? currentInput.current : null, now: () => Date.now(),
    fresh: request => buildCircleReview(request, circleReviewDeps()),
    preflight: circleChainRpc.preflight, publicNonce: circleChainRpc.publicNonce, estimateGas: circleChainRpc.estimateGas, simulate: circleChainRpc.simulate, approval: circleChainRpc.approval, result: circleChainRpc.result,
    provider: () => connectedExecutionProvider(currentConnector.current), sdk: circleSdk,
    storage: { getItem: key => window.localStorage.getItem(key), setItem: (key, value) => window.localStorage.setItem(key, value) },
    lock: browserCircleLock, enabled: () => CIRCLE_SWAP_WRITES_ENABLED,
    authorize: (request, current) => circleExecutionRestriction(SWAP_EXECUTION, request, current, CIRCLE_SWAP_WRITES_ENABLED) === null,
    blockedElsewhere: owner => currentBlocked.current(owner),
    changed: next => { if (alive.current) setView(next) },
    settled: () => {
      // Refresh this wallet's Arc balances (native and tokens) so the screen shows what the swap really changed.
      void queryClient.invalidateQueries({ predicate: query => { const args = query.queryKey[1] as { chainId?: number } | undefined; return Boolean(args && args.chainId === 5042 && (query.queryKey[0] === 'balance' || query.queryKey[0] === 'readContract')) } })
    },
  }))
  useEffect(() => {
    if (!address || !isConnected) { setHistory([]); setHistoryError(false); return }
    try { setHistory(controller.history(address)); setHistoryError(false) } catch { setHistory([]); setHistoryError(true) }
  }, [address, isConnected, controller, view])
  const binding = JSON.stringify([address, chainId, isConnected, connector?.uid, input ? circleRequestKey(input) : null])
  useEffect(() => { controller.invalidate() }, [binding, controller])
  useEffect(() => { if (address && isConnected) void controller.reconcile(address) }, [address, isConnected, controller])
  useEffect(() => {
    alive.current = true
    const changed = (event: StorageEvent) => { if (event.key?.startsWith('machina.circle.swap.execution.v1:')) { controller.invalidate(); void controller.reconcile() } }
    // A hidden page drops a Review that is merely open; a flow already in progress goes on (a wallet app in the foreground hides the page).
    const hidden = () => { if (document.hidden) controller.hidden() }
    window.addEventListener('storage', changed); document.addEventListener('visibilitychange', hidden)
    return () => { alive.current = false; controller.invalidate(); window.removeEventListener('storage', changed); document.removeEventListener('visibilitychange', hidden) }
  }, [controller])
  useEffect(() => {
    if (!view.review && !view.step) return
    const timer = setInterval(() => tick(n => n + 1), 500)
    return () => clearInterval(timer)
  }, [Boolean(view.review), Boolean(view.step)])
  const [pageHidden, setPageHidden] = useState(() => typeof document !== 'undefined' && document.hidden)
  useEffect(() => {
    const visibility = () => setPageHidden(document.hidden)
    document.addEventListener('visibilitychange', visibility)
    return () => document.removeEventListener('visibilitychange', visibility)
  }, [])
  useEffect(() => {
    const delay = view.nextCheckMs
    // A swap hash, or an approval that was submitted without a swap yet, is something the chain can be asked about.
    const trackable = Boolean(view.attempt && (view.attempt.hash || view.attempt.steps.some(step => step.hash && step.status === 'pending')))
    if (typeof delay !== 'number' || view.checking || pageHidden || !isConnected || !trackable || !view.attempt || !sameAddress(address, view.attempt.review.request.owner)) return
    const owner = view.attempt.review.request.owner, timer = setTimeout(() => { if (!document.hidden) void controller.reconcile(owner) }, delay)
    return () => clearTimeout(timer)
  }, [view.nextCheckMs, view.checking, view.attempt?.id, view.observedAt, view.phase, pageHidden, controller, address, isConnected])
  const [stored, setStored] = useState<StoredCircleHistory[]>([])
  useEffect(() => { try { setStored(listStoredCircleAttempts(window.localStorage)) } catch { setStored([]) } }, [address, isConnected, view])
  const visibleView: CircleView = !isConnected || !sameAddress(address, view.attempt?.review.request.owner ?? view.review?.request.owner ?? address ?? '') ? { phase: 'idle' } : view
  const restriction = circleExecutionRestriction(SWAP_EXECUTION, input, context.current, CIRCLE_SWAP_WRITES_ENABLED)
  return {
    view: visibleView, stored, history: isConnected ? history.filter(a => sameAddress(a.review.request.owner, address ?? '')) : [], historyError,
    remainingMs: view.review ? Math.max(0, view.review.expiresAt - Date.now()) : 0,
    restriction, restrictionMessage: restriction ? executionRestrictionMessage(restriction) : null, enabled: CIRCLE_SWAP_WRITES_ENABLED && restriction === null,
    blocking: (owner: string) => controller.blocking(owner),
    prepare: () => controller.prepare(), confirm: () => (view.approvalId ? controller.confirm(view.approvalId) : Promise.resolve()),
    // Bound to the step on screen: a late click meant for an earlier step cannot confirm the next one.
    continueStep: () => { if (view.step) controller.continueStep(controller.stepKey(view.step)) }, cancelStep: () => controller.cancelStep(), cancel: () => controller.invalidate(),
    recover: (hash: string) => controller.reconcile(view.attempt?.review.request.owner, hash), checkAttempt: (id: string, owner?: string) => controller.reconcile(owner ?? address, undefined, id),
  }
}
export type CircleExecution = ReturnType<typeof useCircleSwapExecution>

const kindText = (kind: string, token: string) => (kind === 'permit' ? `Sign a one-time permission for exactly this ${token} amount (a signature: no network fee)` : kind === 'approve' ? `Approve exactly this ${token} amount for Circle (a transaction with a small network fee)` : 'Send the swap')
const utc = (seconds: number) => `${new Date(seconds * 1000).toISOString().slice(11, 19)} UTC`

// The Review dialog and the per-step confirmation. Nothing reaches the wallet until the user confirms the step shown here.
export function CircleReviewDialog({ execution }: { execution: CircleExecution }) {
  const { view, remainingMs } = execution
  const dialog = useRef<HTMLDialogElement>(null)
  const open = view.phase === 'review' || view.phase === 'checking' || view.phase === 'awaiting_step'
  useEffect(() => {
    const element = dialog.current
    if (open && element && !element.open) element.showModal()
    if (!open && element?.open) element.close()
  }, [open])
  const review = view.review ?? view.attempt?.review
  const request = review?.request
  const tokenIn = request ? swapToken(request.tokenIn) : null, tokenOut = request ? swapToken(request.tokenOut) : null
  const step = view.step
  const providerFee = review?.fees.find(fee => fee.type === 'provider'), gasEstimate = review?.fees.find(fee => fee.type === 'gas')
  return <dialog ref={dialog} onCancel={execution.cancel} aria-labelledby="circle-review-title" className="m-auto max-h-[calc(100dvh_-_2rem)] w-[calc(100%_-_2rem)] max-w-lg overflow-y-auto rounded-2xl border border-slate-200 bg-white p-5 text-slate-900 shadow-xl backdrop:bg-black/40">
    <div className="space-y-4">
      <h2 id="circle-review-title" className="text-xl font-semibold">Review Circle swap</h2>
      {review && request && tokenIn && tokenOut && <>
        <p>You pay {request.amount} {request.tokenIn} and receive about {formatUnits(BigInt(review.estimatedOutput), tokenOut.decimals)} {request.tokenOut}.</p>
        <dl className="space-y-2 text-sm">
          <Line label="You pay" value={`${request.amount} ${request.tokenIn}`} />
          <Line label="You receive (estimate)" value={`${formatUnits(BigInt(review.estimatedOutput), tokenOut.decimals)} ${request.tokenOut}`} />
          <Line label="Minimum you receive" value={`${formatUnits(BigInt(review.requiredMinimum), tokenOut.decimals)} ${request.tokenOut}`} />
          <Line label="Slippage allowed" value={`${request.slippageBps / 100}%`} />
          {providerFee && <Line label="Circle fee" value={providerFee.amount === null ? 'not estimated' : `${providerFee.amount} ${providerFee.token}`} />}
          {gasEstimate?.amount != null && <Line label="Network fee (estimate)" value={`about ${Number(gasEstimate.amount).toPrecision(2)} USDC`} />}
          <Line label="Network fee (maximum, all steps)" value={`${formatUnits(BigInt(review.networkFee), 18)} USDC`} />
          {view.phase !== 'awaiting_step' && <Line label="This review expires in" value={`${Math.ceil(remainingMs / 1000)} seconds`} />}
        </dl>
        <div className="space-y-1 rounded-xl bg-slate-50 p-3 text-sm">
          <p className="font-medium">What you will be asked, one step at a time</p>
          <ol className="list-decimal space-y-1 pl-5 text-slate-700">
            <li>{request.tokenIn === 'USDC' ? 'Sign a one-time permission for exactly this USDC amount (a signature: no fee).' : `Approve exactly this ${request.tokenIn} amount for Circle (a transaction; small fee).`}</li>
            <li>Send the swap.</li>
          </ol>
          <p className="text-xs text-slate-600">Never more than the amount above. Each step is confirmed here first, then in your wallet. If a step fails, the next ones are not requested. If the price moves so you would receive less than the minimum, the swap does not go through.</p>
        </div>
        <details className="text-xs text-slate-500"><summary className="cursor-pointer">Technical details</summary>
          <dl className="mt-2 space-y-1">
            <Line label="Contract" value={`Circle adapter · ${CIRCLE_ADAPTER}`} />
            <Line label="Recipient" value={request.owner} />
            <Line label="Network" value="Arc Mainnet · 5042" />
            {review.reference && <Line label="Independent price check" value={`Uniswap reference ${formatUnits(BigInt(review.reference.estimatedOutput), tokenOut.decimals)} ${request.tokenOut}`} />}
          </dl></details>
      </>}
      {step && view.phase === 'awaiting_step' && <div role="status" className="space-y-2 rounded-xl border border-[#2F6E0C]/40 bg-[#f4faef] p-3 text-sm">
        <p className="font-semibold">Step {step.kind === 'swap' ? 2 : 1} of 2: {kindText(step.kind, request?.tokenIn ?? '')}</p>
        <dl className="space-y-1">
          <Line label="Amount" value={tokenIn ? `${formatUnits(BigInt(step.amount), tokenIn.decimals)} ${request?.tokenIn}` : step.amount} />
          {step.kind === 'swap' && step.minimumOut && tokenOut && <Line label="Minimum you receive" value={`${formatUnits(BigInt(step.minimumOut), tokenOut.decimals)} ${request?.tokenOut}`} />}
          {step.kind === 'swap' && step.feeAmount && tokenIn && <Line label="Circle fee in this transaction" value={`${formatUnits(BigInt(step.feeAmount), tokenIn.decimals)} ${request?.tokenIn}`} />}
          {step.kind === 'swap' && step.deadline !== undefined && <Line label="Must complete by" value={utc(step.deadline)} />}
          {step.worstCaseFee && <Line label="Network fee for this step (maximum)" value={`${formatUnits(BigInt(step.worstCaseFee), 18)} USDC`} />}
          {view.stepWindowMs !== undefined && <Line label="Confirm within" value={`${Math.floor(view.stepWindowMs / 1000)} seconds`} />}
        </dl>
        <details className="text-xs text-slate-500"><summary className="cursor-pointer">Technical details</summary>
          <ul className="mt-1 space-y-1 break-all"><li>Contract: {step.to}</li>{step.spender && <li>Allowed spender: {step.spender}</li>}<li>Transaction fingerprint: {step.dataHash}</li></ul></details>
      </div>}
      <div className="flex gap-3">
        <button type="button" onClick={execution.cancel} className="flex-1 rounded-xl border border-slate-300 px-4 py-3">Cancel</button>
        {view.phase === 'awaiting_step'
          ? <button type="button" onClick={execution.continueStep} className="flex-1 rounded-xl bg-[#2F6E0C] px-4 py-3 font-semibold text-white">Continue to wallet</button>
          : <button type="button" onClick={() => { void execution.confirm() }} disabled={view.phase !== 'review' || remainingMs < 5000}
            className="flex-1 rounded-xl bg-[#2F6E0C] px-4 py-3 font-semibold text-white disabled:opacity-50">{view.phase === 'checking' ? 'Rechecking…' : remainingMs <= 0 ? 'Review expired' : remainingMs < 5000 ? 'Review expiring' : 'Confirm Swap'}</button>}
      </div>
    </div>
  </dialog>
}
function Line({ label, value }: { label: string; value: string }) {
  return <div className="grid grid-cols-[auto_minmax(0,1fr)] gap-3"><dt className="text-slate-500">{label}</dt><dd className="break-all text-right">{value}</dd></div>
}
