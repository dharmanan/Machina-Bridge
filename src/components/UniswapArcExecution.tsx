import { useEffect, useRef, useState } from 'react'
import { useAccount } from 'wagmi'
import { useQueryClient } from '@tanstack/react-query'
import { formatUnits } from 'viem'
import { ARC_OUTPUTS, ARC_ROUTER, ARC_USDC, UNISWAP_ARC_WRITES_ENABLED, nativeAmount, requestKey, sameAddress, type ArcRequest } from '../lib/uniswapArcPolicy'
import { createUniswapArcPreviewReader } from '../lib/uniswapArcPreview'
import { ARC_EXECUTION_EXPLORER, browserExecutionLock, createUniswapArcExecution, executionDeadlineMs, type ExecutionContext, type ExecutionProvider, type ExecutionView } from '../lib/uniswapArcExecution'
import { arcExecutionRpc } from '../lib/uniswapArcExecutionRpc'
import { arcPilotAllows, arcPilotConfig } from '../lib/uniswapArcPilot'

const pilot = arcPilotConfig(import.meta.env.VITE_UNISWAP_ARC_PILOT_ENABLED, import.meta.env.VITE_UNISWAP_ARC_PILOT_WALLET)

// Uses the already connected wagmi connector. No new wallet, signing SDK, service or login.
export function useUniswapArcExecution(input: ArcRequest | null) {
  const { address, chainId, isConnected, connector } = useAccount()
  const queryClient = useQueryClient()
  const [view, setView] = useState<ExecutionView>({ phase: 'idle' })
  const [, tick] = useState(0)
  const alive = useRef(true)
  const context = useRef<ExecutionContext>({ owner: '', connected: false, chainId: 0, connectorId: '' })
  const currentInput = useRef(input), currentConnector = useRef(connector)
  context.current = { owner: address ?? '', connected: isConnected, chainId: chainId ?? 0, connectorId: connector?.uid ?? '' }
  currentInput.current = input; currentConnector.current = connector
  const [reader] = useState(() => createUniswapArcPreviewReader(() => alive.current ? context.current : { ...context.current, connected: false }))
  const [controller] = useState(() => createUniswapArcExecution({
    context: () => alive.current ? context.current : { ...context.current, connected: false }, input: () => alive.current ? currentInput.current : null,
    authorize: (request, current) => arcPilotAllows(pilot, request, current),
    fresh: request => reader.read(request), quoteNow: request => reader.validationTime(request),
    preflight: arcExecutionRpc.preflight, result: arcExecutionRpc.result,
    provider: async () => {
      const provider = await currentConnector.current?.getProvider({ chainId: 5042 })
      if (!provider || typeof (provider as ExecutionProvider).request !== 'function') throw new Error('context')
      return { request: args => (provider as ExecutionProvider).request(args) }
    },
    storage: { getItem: key => window.localStorage.getItem(key), setItem: (key, value) => window.localStorage.setItem(key, value) },
    lock: browserExecutionLock,
    changed: next => { if (alive.current) setView(next) },
    settled: attempt => {
      const owner = attempt.review.request.owner, output = ARC_OUTPUTS[attempt.review.request.tokenOut].address
      // Refresh only this wallet's Arc balance queries, preserving other product flows.
      void queryClient.invalidateQueries({ predicate: query => {
        const key = query.queryKey, args = key[1] as { address?: string; chainId?: number; args?: unknown[] } | undefined
        if (!args || args.chainId !== 5042) return false
        return (key[0] === 'balance' && sameAddress(args.address, owner)) ||
          (key[0] === 'readContract' && (sameAddress(args.address, output) || sameAddress(args.address, ARC_USDC)) && args.args?.some(a => sameAddress(a, owner)) === true)
      } })
    },
  }))
  const binding = JSON.stringify([address, chainId, isConnected, connector?.uid, input ? requestKey(input) : null])
  useEffect(() => {
    controller.invalidate(); reader.invalidate()
  }, [binding, controller, reader])
  useEffect(() => {
    if (address && isConnected) void controller.reconcile(address)
  }, [address, isConnected, controller])
  useEffect(() => {
    alive.current = true
    const changed = (event: StorageEvent) => {
      if (event.key?.startsWith('machina.uniswap.arc.execution.v1:')) { controller.invalidate(); void controller.reconcile() }
    }
    const hidden = () => { if (document.hidden) { controller.invalidate(); reader.invalidate() } }
    window.addEventListener('storage', changed); document.addEventListener('visibilitychange', hidden)
    return () => {
      alive.current = false; controller.invalidate(); reader.invalidate()
      window.removeEventListener('storage', changed); document.removeEventListener('visibilitychange', hidden)
    }
  }, [controller, reader])
  useEffect(() => {
    if (!view.review) return
    const timer = setInterval(() => tick(n => n + 1), 500)
    return () => clearInterval(timer)
  }, [Boolean(view.review)])
  useEffect(() => {
    if (!view.attempt?.hash || !['pending', 'unknown'].includes(view.phase)) return
    const owner = view.attempt.review.request.owner
    const timer = setInterval(() => { if (!document.hidden) void controller.reconcile(owner) }, 5000)
    return () => clearInterval(timer)
  }, [view.phase, view.attempt?.hash, controller])
  let remainingMs = 0
  if (view.review) { try { remainingMs = Math.max(0, view.review.expiresAt - reader.validationTime(view.review.request)) } catch { /* expired */ } }
  return { view, remainingMs, enabled: UNISWAP_ARC_WRITES_ENABLED && arcPilotAllows(pilot, input, context.current),
    prepare: () => controller.prepare(), confirm: () => view.approvalId ? controller.confirm(view.approvalId) : Promise.resolve(),
    cancel: () => { controller.invalidate(); reader.invalidate() },
    recover: (hash: string) => controller.reconcile(view.attempt?.review.request.owner, hash),
    check: () => controller.reconcile(view.attempt?.review.request.owner),
  }
}

export function UniswapArcExecutionPanel({ execution, canReview }: { execution: ReturnType<typeof useUniswapArcExecution>; canReview: boolean }) {
  const { view, remainingMs } = execution
  const dialog = useRef<HTMLDialogElement>(null), [recovery, setRecovery] = useState('')
  const reviewing = view.phase === 'review' || view.phase === 'checking'
  useEffect(() => {
    const element = dialog.current
    if (reviewing && element && !element.open) element.showModal()
    if (!reviewing && element?.open) element.close()
  }, [reviewing])
  const review = view.review
  const busy = ['preparing', 'checking', 'awaiting_wallet', 'pending', 'unknown'].includes(view.phase)
  const labels: Partial<Record<ExecutionView['phase'], string>> = {
    awaiting_wallet: 'Awaiting wallet confirmation', pending: 'Pending — checking Arc', confirmed: 'Confirmed',
    failed: 'Failed — transaction reverted', rejected: 'Wallet request rejected', unknown: 'Submission or result unverified',
  }
  const status = labels[view.phase]
  return <div className="space-y-3">
    {execution.enabled
      ? <button type="button" onClick={() => { void execution.prepare() }} disabled={!canReview || busy || reviewing}
        className="w-full rounded-xl bg-[#2F6E0C] px-5 py-3 font-semibold text-white disabled:opacity-50">{view.phase === 'preparing' ? 'Preparing swap…' : 'Review Swap'}</button>
      : <button type="button" disabled className="w-full cursor-not-allowed rounded-xl border border-slate-200 bg-slate-100 px-5 py-3 font-semibold text-slate-500">Swap disabled in Preview</button>}
    {view.error && <p role="alert" className="break-words text-sm text-amber-800">{view.error}</p>}
    <dialog ref={dialog} onCancel={execution.cancel} aria-labelledby="uniswap-review-title" className="m-auto max-h-[calc(100dvh_-_2rem)] w-[calc(100%_-_2rem)] max-w-lg overflow-y-auto rounded-2xl border border-slate-200 bg-white p-5 text-slate-900 shadow-xl backdrop:bg-black/40">
      <div className="space-y-4">
        <h2 id="uniswap-review-title" className="text-xl font-semibold">Review Uniswap Swap</h2>
        <p className="text-xs text-slate-600">Controlled pilot · USDC → EURC · maximum 0.1 USDC input.</p>
        {review && <>
          <p>{review.request.amount} USDC → estimated {formatUnits(BigInt(review.estimatedOutput), ARC_OUTPUTS[review.request.tokenOut].decimals)} {review.request.tokenOut}</p>
          <dl className="space-y-2 text-sm">
            <ReviewLine label="Minimum receive" value={`${formatUnits(BigInt(review.requiredMinimum), ARC_OUTPUTS[review.request.tokenOut].decimals)} ${review.request.tokenOut}`} />
            <ReviewLine label="Slippage" value={`${review.request.slippageBps / 100}%`} />
            <ReviewLine label="Network fee ceiling" value={`${formatUnits(BigInt(review.networkFee), 18)} USDC`} />
            <ReviewLine label="Total USDC ceiling" value={formatUnits(nativeAmount(review.request.amount) + BigInt(review.networkFee), 18)} />
            <ReviewLine label="Network" value="Arc Mainnet · 5042" />
            <ReviewLine label="Recipient" value={review.request.recipient} />
            <ReviewLine label="Router" value={ARC_ROUTER} />
            <ReviewLine label="Review expires in" value={`${Math.ceil(remainingMs / 1000)} seconds`} />
            <ReviewLine label="Transaction deadline" value={`${new Date(executionDeadlineMs(review)).toISOString().slice(11, 19)} UTC`} />
          </dl>
          <p className="text-xs text-slate-600">Native USDC only. No token approval or Permit2 signature. Confirm before this review expires. The transaction deadline is capped at two minutes from quote creation and never exceeds Uniswap’s original deadline. The wallet approval window ends 15 seconds earlier to allow inclusion; this buffer is not a guarantee. Cancel an expired wallet request. A late approval or delayed inclusion may revert and still charge gas.</p>
        </>}
        <div className="flex gap-3">
          <button type="button" onClick={execution.cancel} className="flex-1 rounded-xl border border-slate-300 px-4 py-3">Cancel</button>
          <button type="button" onClick={() => { void execution.confirm() }} disabled={view.phase !== 'review' || remainingMs < 5000}
            className="flex-1 rounded-xl bg-[#2F6E0C] px-4 py-3 font-semibold text-white disabled:opacity-50">{view.phase === 'checking' ? 'Rechecking…' : remainingMs <= 0 ? 'Review expired' : remainingMs < 5000 ? 'Review expiring' : 'Confirm Swap'}</button>
        </div>
      </div>
    </dialog>
    {view.attempt && status && <section aria-label="Uniswap transaction status" className="space-y-2 rounded-xl border border-slate-200 p-3 text-sm">
      <p role="status" className="font-semibold">{status}</p>
      {view.phase === 'awaiting_wallet' && view.walletWindowMs !== undefined && <p>Approve within at most {Math.floor(view.walletWindowMs / 1000)} seconds of the wallet request opening. If the window ends, cancel the request in your wallet. The app cannot cancel it.</p>}
      <p className="break-all text-xs text-slate-600">Wallet: {view.attempt.review.request.owner}</p>
      {view.attempt.hash && <a href={ARC_EXECUTION_EXPLORER + view.attempt.hash} target="_blank" rel="noopener noreferrer" className="block break-all text-[#2F6E0C] underline">View on Arc Explorer · {view.attempt.hash}</a>}
      {view.phase === 'confirmed' && view.attempt.output && <p>Received {formatUnits(BigInt(view.attempt.output), ARC_OUTPUTS[view.attempt.review.request.tokenOut].decimals)} {view.attempt.review.request.tokenOut}</p>}
      {['confirmed', 'failed'].includes(view.phase) && view.attempt.fee && <p>Network fee: {formatUnits(BigInt(view.attempt.fee), 18)} USDC</p>}
      {['pending', 'unknown'].includes(view.phase) && !view.walletRequestOpen && <button type="button" onClick={() => { void execution.check() }} className="underline">Check transaction status</button>}
      {view.phase === 'unknown' && !view.attempt.hash && !view.walletRequestOpen && <div className="space-y-2">
        <label className="block">Transaction hash from your wallet<input aria-label="Recover transaction hash" value={recovery} onChange={event => setRecovery(event.target.value)} maxLength={66} className="mt-1 w-full rounded-lg border border-slate-300 p-2" /></label>
        <button type="button" onClick={() => { void execution.recover(recovery) }} className="underline">Verify and track hash</button>
      </div>}
    </section>}
  </div>
}
function ReviewLine({ label, value }: { label: string; value: string }) {
  return <div className="grid grid-cols-[auto_minmax(0,1fr)] gap-3"><dt className="text-slate-500">{label}</dt><dd className="break-all text-right">{value}</dd></div>
}
