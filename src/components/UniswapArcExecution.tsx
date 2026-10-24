import { connectedExecutionProvider } from '../lib/uniswapArcWalletRpc'
import { useEffect, useRef, useState } from 'react'
import { useAccount } from 'wagmi'
import { useQueryClient } from '@tanstack/react-query'
import { formatUnits } from 'viem'
import { ARC_TOKENS, ARC_ROUTER, ARC_USDC, UNISWAP_ARC_WRITES_ENABLED, requestKey, sameAddress, type ArcRequest } from '../lib/uniswapArcPolicy'
import { createReviewSource } from '../lib/swap/reviewSource'
import { reviewValue } from '../lib/swap/swapPolicy'
import { executionRestrictionMessage, swapExecutionRestriction } from '../lib/swap/executionMode'
import { browserExecutionLock, createUniswapArcExecution, executionDeadlineMs, listStoredAttempts, type ExecutionContext, type ExecutionView, type StoredHistory, type SwapAttempt } from '../lib/uniswapArcExecution'
import { arcExecutionRpc } from '../lib/uniswapArcExecutionRpc'
import { SWAP_EXECUTION } from '../config/swapExecution'
import { decodeUniversalRouterCalldata, guaranteedNetMinimum } from '../lib/swap/universalRouter'

// Uses the already connected wagmi connector. No new wallet, signing SDK, service or login.
// `blocked` lets the caller hold a new swap while another transaction of the same wallet (an approval) is unresolved.
export function useUniswapArcExecution(input: ArcRequest | null, blocked: (owner: string) => boolean = () => false) {
  const { address, chainId, isConnected, connector } = useAccount()
  const queryClient = useQueryClient()
  const [history, setHistory] = useState<SwapAttempt[]>([])
  const [historyError, setHistoryError] = useState(false)
  const [view, setView] = useState<ExecutionView>({ phase: 'idle' })
  const [, tick] = useState(0)
  const alive = useRef(true)
  const context = useRef<ExecutionContext>({ owner: '', connected: false, chainId: 0, connectorId: '' })
  const currentInput = useRef(input), currentConnector = useRef(connector), currentBlocked = useRef(blocked)
  context.current = { owner: address ?? '', connected: isConnected, chainId: chainId ?? 0, connectorId: connector?.uid ?? '' }
  currentInput.current = input; currentConnector.current = connector; currentBlocked.current = blocked
  const [source] = useState(() => createReviewSource(() => alive.current ? context.current : { ...context.current, connected: false }, () => SWAP_EXECUTION.mode))
  const [controller] = useState(() => createUniswapArcExecution({
    context: () => alive.current ? context.current : { ...context.current, connected: false }, input: () => alive.current ? currentInput.current : null,
    authorize: (request, current) => swapExecutionRestriction(SWAP_EXECUTION, request, current) === null && !currentBlocked.current(current.owner),
    fresh: request => source.read(request), quoteNow: request => source.now(request),
    preflight: arcExecutionRpc.preflight, signPermit: arcExecutionRpc.signPermit, result: arcExecutionRpc.result,
    provider: () => connectedExecutionProvider(currentConnector.current),
    storage: { getItem: key => window.localStorage.getItem(key), setItem: (key, value) => window.localStorage.setItem(key, value) },
    lock: browserExecutionLock,
    changed: next => { if (alive.current) setView(next) },
    settled: attempt => {
      const { owner, tokenIn, tokenOut } = attempt.review.request
      // Refresh only this wallet's Arc balance queries (native, input and output token), preserving other product flows.
      const tokens = [ARC_TOKENS[tokenIn].address, ARC_TOKENS[tokenOut].address]
      void queryClient.invalidateQueries({ predicate: query => {
        const key = query.queryKey, args = key[1] as { address?: string; chainId?: number; args?: unknown[] } | undefined
        if (!args || args.chainId !== 5042) return false
        return (key[0] === 'balance' && sameAddress(args.address, owner)) ||
          (key[0] === 'readContract' && (tokens.some(t => sameAddress(args.address, t)) || sameAddress(args.address, ARC_USDC)) && args.args?.some(a => sameAddress(a, owner)) === true)
      } })
    },
  }))
  useEffect(() => {
    if (!address || !isConnected) { setHistory([]); setHistoryError(false); return }
    try { setHistory(controller.history(address)); setHistoryError(false) } catch { setHistory([]); setHistoryError(true) }
  }, [address, isConnected, controller, view])
  const binding = JSON.stringify([address, chainId, isConnected, connector?.uid, input ? requestKey(input) : null])
  useEffect(() => {
    controller.invalidate(); source.invalidate()
  }, [binding, controller, source])
  useEffect(() => {
    if (address && isConnected) void controller.reconcile(address)
  }, [address, isConnected, controller])
  useEffect(() => {
    alive.current = true
    const changed = (event: StorageEvent) => {
      if (event.key?.startsWith('machina.uniswap.arc.execution.v1:')) { controller.invalidate(); void controller.reconcile() }
    }
    const hidden = () => {
      const current = controller.current()
      if (document.hidden) {
        // A signed Review belongs to this mounted page only. Hiding it is not a wallet/input change.
        if (!current.walletRequestOpen && !current.permitSigned) { controller.invalidate(); source.invalidate() }
      } else if (current.phase === 'review' && current.permitSigned) {
        // Fresh price, original signed deadline/limits, nonce reconciliation and exact simulation;
        // refresh never signs or broadcasts, and final Confirm remains mandatory.
        void controller.refresh()
      }
    }
    window.addEventListener('storage', changed); document.addEventListener('visibilitychange', hidden)
    return () => {
      alive.current = false; controller.invalidate(); source.invalidate()
      window.removeEventListener('storage', changed); document.removeEventListener('visibilitychange', hidden)
    }
  }, [controller, source])
  useEffect(() => {
    if (!view.review) return
    const timer = setInterval(() => tick(n => n + 1), 500)
    return () => clearInterval(timer)
  }, [Boolean(view.review)])
  // Automatic status lookups follow the schedule the controller publishes (nextCheckMs): steady for Pending, growing pauses after a
  // transient read failure, none after a terminal or deterministic result. They never run for a hidden page and never overlap.
  const [pageHidden, setPageHidden] = useState(() => typeof document !== 'undefined' && document.hidden)
  useEffect(() => {
    const visibility = () => setPageHidden(document.hidden)
    document.addEventListener('visibilitychange', visibility)
    return () => document.removeEventListener('visibilitychange', visibility)
  }, [])
  useEffect(() => {
    const delay = view.nextCheckMs
    if (typeof delay !== 'number' || view.checking || pageHidden || !isConnected || !view.attempt?.hash || !sameAddress(address, view.attempt.review.request.owner)) return
    const owner = view.attempt.review.request.owner
    const timer = setTimeout(() => { if (!document.hidden) void controller.reconcile(owner) }, delay)
    return () => clearTimeout(timer)
  }, [view.nextCheckMs, view.checking, view.attempt?.id, view.observedAt, view.phase, pageHidden, controller, address, isConnected])
  // Every wallet's records stored in this browser, readable without a connected wallet.
  const [stored, setStored] = useState<StoredHistory[]>([])
  useEffect(() => { try { setStored(listStoredAttempts(window.localStorage)) } catch { setStored([]) } }, [address, isConnected, view])
  let remainingMs = 0
  if (view.review) { try { remainingMs = Math.max(0, view.review.expiresAt - source.now(view.review.request)) } catch { /* expired */ } }
  const visibleView: ExecutionView = !isConnected || !sameAddress(address, view.attempt?.review.request.owner ?? view.review?.request.owner ?? address ?? '') ? { phase: 'idle' } : view
  const restriction = swapExecutionRestriction(SWAP_EXECUTION, input, context.current)
  return { view: visibleView, stored, history: isConnected ? history.filter(a => sameAddress(a.review.request.owner, address ?? '')) : [], historyError, remainingMs,
    restriction, restrictionMessage: restriction ? executionRestrictionMessage(restriction) : null, enabled: UNISWAP_ARC_WRITES_ENABLED && restriction === null,
    prepare: () => controller.prepare(), refresh: () => controller.refresh(), confirm: () => view.approvalId ? controller.confirm(view.approvalId) : Promise.resolve(),
    cancel: () => { controller.invalidate(); source.invalidate() },
    recover: (hash: string) => controller.reconcile(view.attempt?.review.request.owner, hash),
    check: () => controller.reconcile(view.attempt?.review.request.owner),
    blocking: (owner: string) => controller.blocking(owner),
    checkAttempt: (id: string, owner?: string) => controller.reconcile(owner ?? address, undefined, id),
  }
}
export type UniswapExecution = ReturnType<typeof useUniswapArcExecution>

// The Review dialog. Opens only for a Review the controller prepared, closes when it is cancelled, expired or confirmed.
export function UniswapReviewDialog({ execution }: { execution: UniswapExecution }) {
  const { view, remainingMs } = execution
  const dialog = useRef<HTMLDialogElement>(null)
  const reviewing = view.phase === 'review' || view.phase === 'checking'
  useEffect(() => {
    const element = dialog.current
    if (reviewing && element && !element.open) element.showModal()
    if (!reviewing && element?.open) element.close()
  }, [reviewing])
  const review = view.review
  const out = review ? ARC_TOKENS[review.request.tokenOut] : null, inp = review ? ARC_TOKENS[review.request.tokenIn] : null
  const nativeIn = review?.request.tokenIn === 'USDC'
  const poolFees = review?.route ? [...review.route.matchAll(/\(([0-9.]+%)\)/g)].map(match => match[1]) : []
  // What the reviewed transaction itself does with the output: the fee portions, read from the calldata that will be sent (never assumed).
  let program = '', portions: { percent: string; recipient: string }[] | null = null, netMinimum: bigint | null = null
  if (review) {
    try {
      const decoded = decodeUniversalRouterCalldata(review.transaction.data)
      if (decoded.ok) { program = decoded.program.signature; portions = decoded.program.portions.map(portion => ({ percent: `${(Number(portion.bips) / 100).toFixed(2)}%`, recipient: portion.recipient })); netMinimum = guaranteedNetMinimum(decoded.program) }
    } catch { program = ''; portions = null }
  }
  const feeToOthers = portions !== null && portions.length > 0
  return <dialog ref={dialog} onCancel={execution.cancel} aria-labelledby="uniswap-review-title" className="m-auto max-h-[calc(100dvh_-_2rem)] w-[calc(100%_-_2rem)] max-w-lg overflow-y-auto rounded-2xl border border-slate-200 bg-white p-5 text-slate-900 shadow-xl backdrop:bg-black/40">
    <div className="space-y-4">
      <h2 id="uniswap-review-title" className="text-xl font-semibold">Review Uniswap swap</h2>
      <div className="rounded-xl bg-amber-50 p-3 text-sm text-amber-900">
        <p className="font-medium">Wallet security</p>
        <p>Browser extensions may modify swap transactions before signing. Check the final amount, additional fees and recipient in your wallet. If anything differs from this review, reject the transaction.</p>
      </div>
      {view.allowanceNotice && <p role="note" aria-label="Existing Permit2 token allowance" className="break-words rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">{view.allowanceNotice}</p>}
      {review && inp && out && <>
        <p>You pay {review.request.amount} {review.request.tokenIn} and receive about {formatUnits(BigInt(review.estimatedOutput), out.decimals)} {review.request.tokenOut}.</p>
        <dl className="space-y-2 text-sm">
          <ReviewLine label="You pay" value={`${review.request.amount} ${review.request.tokenIn}`} />
          <ReviewLine label="You receive (estimate)" value={`${formatUnits(BigInt(review.estimatedOutput), out.decimals)} ${review.request.tokenOut}`} />
          <ReviewLine label="Minimum you receive" value={`${formatUnits(BigInt(review.requiredMinimum), out.decimals)} ${review.request.tokenOut}`} />
          {feeToOthers && (portions ?? []).map(portion => <ReviewLine key={portion.recipient} label="Fee to another address" value={`${portion.percent} of what you receive`} />)}
          {feeToOthers && netMinimum !== null && <ReviewLine label="Minimum after that fee" value={`${formatUnits(netMinimum, out.decimals)} ${review.request.tokenOut}`} />}
          <ReviewLine label="Slippage allowed" value={`${review.request.slippageBps / 100}%`} />
          {poolFees.length > 0 && <ReviewLine label="Pool fee (already in the estimate)" value={poolFees.join(' + ')} />}
          {!nativeIn && <ReviewLine label="Remaining wallet interactions" value={view.permitSigned ? '1 blockchain transaction · permission already signed' : '2 · 1 free signature + 1 blockchain transaction'} />}
          {!nativeIn && <ReviewLine label="Permit2 spending permission" value={`${review.request.amount} ${review.request.tokenIn} · expires with transaction deadline`} />}
          <ReviewLine label="Network fee (estimate)" value={review.estimatedNetworkFee !== undefined ? `${formatUnits(BigInt(review.estimatedNetworkFee), 18)} USDC` : 'Available after signing the permission and simulating the complete transaction'} />
          <ReviewLine label="Network fee (maximum)" value={`${formatUnits(BigInt(review.networkFee), 18)} USDC`} />
          {nativeIn && <ReviewLine label="Most USDC you could spend" value={`${formatUnits(reviewValue(review) + BigInt(review.networkFee), 18)} USDC`} />}
          <ReviewLine label="Route" value={review.route ?? `${review.request.tokenIn} → ${review.request.tokenOut}`} />
          <ReviewLine label="This review expires in" value={`${Math.ceil(remainingMs / 1000)} seconds`} />
        </dl>
        {feeToOthers && <p role="note" className="rounded-lg border border-amber-200 bg-amber-50 p-2 text-xs text-amber-900">This swap sends part of what you receive to another address, as shown above. Confirm only if you accept this fee.</p>}
        {portions === null && <p role="note" className="rounded-lg border border-amber-200 bg-amber-50 p-2 text-xs text-amber-900">We couldn’t read every detail of this swap. Don’t confirm it; review a fresh swap.</p>}
        <p className="text-xs text-slate-600">If the price moves so you would receive less than the minimum, the swap does not go through.{portions !== null && !feeToOthers ? ' Checked in the transaction prepared by this app: all swap output goes to your wallet, with no additional recipient fee. Your wallet or browser extensions may change the transaction before signing.' : ''}{nativeIn ? ' Native USDC is sent with the swap, so no approval is needed.' : ' Your token approval is in place. Sign one free, exact-amount permission, then check the refreshed price and confirm one gas-paying swap transaction. Reject either wallet request to stop.'} Confirm before this review expires.</p>
        <details className="text-xs text-slate-500"><summary className="cursor-pointer">Technical details</summary>
          <dl className="mt-2 space-y-1">
            <ReviewLine label="Contract" value={`Uniswap Universal Router · ${ARC_ROUTER}`} />
            <ReviewLine label="Recipient" value={review.request.recipient} />
            {program && <ReviewLine label="Program" value={program} />}
            <ReviewLine label="Gas limit" value={review.gasLimit} />
            <ReviewLine label="Max fee per gas" value={`${formatUnits(BigInt(review.maxFeePerGas), 9)} gwei`} />
            <ReviewLine label="Transaction deadline" value={`${new Date(executionDeadlineMs(review)).toISOString().slice(11, 19)} UTC`} />
            <ReviewLine label="Network" value="Arc Mainnet · 5042" />
          </dl></details>
      </>}
      {view.notice && <p role="status" className="text-sm text-slate-600">{view.notice}</p>}
      {view.phase === 'checking' && view.walletRequestOpen && <p role="status" className="text-sm text-slate-600">{review && executionDeadlineMs(review) - Date.now() <= 15000 ? 'The permission window ended. Reject the outstanding wallet request; no swap will be sent.' : 'Sign the exact-amount permission in your wallet. The price will be refreshed before you confirm the swap; the signature keeps its original deadline.'}</p>}

      <div className="flex gap-3">
        <button type="button" onClick={execution.cancel} className="flex-1 rounded-xl border border-slate-300 px-4 py-3">Cancel</button>
        <button type="button" onClick={() => { void (remainingMs < 5000 ? execution.refresh() : execution.confirm()) }} disabled={view.phase !== 'review' || portions === null}
          className="flex-1 rounded-xl bg-[#2F6E0C] px-4 py-3 font-semibold text-white disabled:opacity-50">{view.phase === 'checking' ? (view.stage === 'permission' ? 'Sign permission in wallet…' : view.stage === 'quote' ? 'Refreshing price…' : view.stage === 'simulation' ? 'Simulating signed swap…' : 'Checking wallet and fees…') : remainingMs < 5000 ? 'Refresh review' : !nativeIn && !view.permitSigned ? 'Sign permission' : 'Confirm Swap'}</button>
      </div>
    </div>
  </dialog>
}
function ReviewLine({ label, value }: { label: string; value: string }) {
  return <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-3"><dt className="text-slate-500">{label}</dt><dd className="min-w-0 break-words text-right">{value}</dd></div>
}
