import { useCallback, useEffect, useMemo, useState } from 'react'
import { formatUnits } from 'viem'
import { useAccount } from 'wagmi'
import { ArrowLeftRight, CheckCircle2, LockKeyhole, RefreshCw, Wallet } from 'lucide-react'
import { getCircleMainnetReadiness } from '../config/circle'
import { getMainnetReadiness } from '../config/mainnet'
import { probeArcMainnetCapabilities, type MainnetCapabilityProbeResult } from '../config/mainnetProbe'
import { MAINNET_NETWORKS } from '../config/mainnetNetworks'
import {
  getDefaultMainnetCctpTransferMode,
  probeMainnetCctpRoute,
  type MainnetCctpRouteProbe,
} from '../config/mainnetCctp'
import { MAINNET_RUNTIME_IMPLEMENTED } from '../config/runtime'
import { useMainnetCctp } from '../hooks/useMainnetCctp'
import { useMainnetTransferQueue } from '../hooks/useMainnetTransferQueue'
import type { MainnetTransferStage } from '../lib/mainnetTransferQueue'
import type { MainnetCctpQuote } from '../lib/mainnetCctpTransfer'
import type { MainnetCctpSourceSimulation } from '../lib/mainnetCctpSimulation'

type RouteEndpoint = 'base' | 'arc'

function StatusRow({
  label,
  state,
}: {
  label: string
  state: 'ready' | 'checking' | 'locked' | 'blocked'
}) {
  return (
    <div className="flex items-center justify-between gap-4">
      <span className="text-sm font-medium text-slate-700">{label}</span>
      <span
        className={`rounded-full px-2.5 py-1 text-xs font-semibold ${
          state === 'ready'
            ? 'bg-[#eef7e8] text-[#2F6E0C]'
            : state === 'locked'
              ? 'bg-slate-200 text-slate-700'
              : state === 'blocked'
                ? 'bg-amber-100 text-amber-800'
                : 'bg-slate-100 text-slate-500'
        }`}
      >
        {state === 'blocked' ? 'attention' : state}
      </span>
    </div>
  )
}

function maskAddress(address?: string) {
  if (!address) return 'Not connected'
  return `${address.slice(0, 6)}...${address.slice(-4)}`
}

function chainName(chainId: number) {
  return Object.values(MAINNET_NETWORKS).find((network) => network.chainId === chainId)?.name
    ?? `Chain ${chainId}`
}

function transferStageLabel(stage: MainnetTransferStage) {
  const labels: Record<MainnetTransferStage, string> = {
    ready: 'Ready to burn',
    approval_required: 'Approval required',
    approving: 'Approving',
    approved: 'Approved',
    burning: 'Burning',
    waiting_attestation: 'Waiting attestation',
    ready_to_mint: 'Ready to mint',
    minting: 'Minting',
    complete: 'Complete',
    failed: 'Needs attention',
  }
  return labels[stage]
}

function PreviewStep({
  index,
  title,
  detail,
  state,
}: {
  index: number
  title: string
  detail: string
  state: 'complete' | 'current' | 'locked'
}) {
  return (
    <div className="flex items-start gap-3">
      <div
        className={`mt-0.5 flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full text-xs font-semibold ${
          state === 'complete'
            ? 'bg-[#eef7e8] text-[#2F6E0C]'
            : state === 'current'
              ? 'bg-slate-900 text-white'
              : 'bg-slate-100 text-slate-400'
        }`}
      >
        {state === 'complete' ? '✓' : index}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center justify-between gap-3">
          <p className={`text-sm font-semibold ${state === 'locked' ? 'text-slate-400' : 'text-slate-900'}`}>
            {title}
          </p>
          <span
            className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${
              state === 'complete'
                ? 'bg-[#eef7e8] text-[#2F6E0C]'
                : state === 'current'
                  ? 'bg-slate-900 text-white'
                  : 'bg-slate-100 text-slate-400'
            }`}
          >
            {state === 'complete' ? 'ready' : state === 'current' ? 'next' : 'locked'}
          </span>
        </div>
        <p className={`mt-1 text-xs leading-5 ${state === 'locked' ? 'text-slate-400' : 'text-slate-500'}`}>
          {detail}
        </p>
      </div>
    </div>
  )
}

export default function MainnetPreviewGate() {
  const readiness = getMainnetReadiness()
  const circleReadiness = getCircleMainnetReadiness()
  const { address, isConnected } = useAccount()
  const { state: cctpState, quote, simulateSource, writesUnlocked } = useMainnetCctp()
  const { activeTransfers, readyToMintCount } = useMainnetTransferQueue(address)

  const [probe, setProbe] = useState<MainnetCapabilityProbeResult | null>(null)
  const [baseToArcProbe, setBaseToArcProbe] = useState<MainnetCctpRouteProbe | null>(null)
  const [arcToBaseProbe, setArcToBaseProbe] = useState<MainnetCctpRouteProbe | null>(null)
  const [source, setSource] = useState<RouteEndpoint>('base')
  const [amount, setAmount] = useState('')
  const [quoteResult, setQuoteResult] = useState<MainnetCctpQuote | null>(null)
  const [simulation, setSimulation] = useState<MainnetCctpSourceSimulation | null>(null)
  const [readOnlyError, setReadOnlyError] = useState<string | null>(null)

  const destination: RouteEndpoint = source === 'base' ? 'arc' : 'base'
  const sourceName = source === 'base' ? 'Base' : 'Arc'
  const destinationName = destination === 'base' ? 'Base' : 'Arc'
  const sourceChainId = source === 'base' ? MAINNET_NETWORKS.base.chainId : MAINNET_NETWORKS.arc.chainId
  const destinationChainId = destination === 'base' ? MAINNET_NETWORKS.base.chainId : MAINNET_NETWORKS.arc.chainId
  const activeRouteProbe = source === 'base' ? baseToArcProbe : arcToBaseProbe
  const selectedMode = getDefaultMainnetCctpTransferMode(sourceChainId)
  const transferModeLabel = selectedMode === 'fast' ? 'Fast' : 'Standard'
  const hasValidAmount = Boolean(amount) && Number.isFinite(Number(amount)) && Number(amount) > 0

  useEffect(() => {
    let cancelled = false

    const run = async () => {
      const [arcResult, baseToArcResult, arcToBaseResult] = await Promise.allSettled([
        probeArcMainnetCapabilities(),
        probeMainnetCctpRoute(MAINNET_NETWORKS.base.chainId, MAINNET_NETWORKS.arc.chainId),
        probeMainnetCctpRoute(MAINNET_NETWORKS.arc.chainId, MAINNET_NETWORKS.base.chainId),
      ])

      if (cancelled) return

      if (arcResult.status === 'fulfilled') setProbe(arcResult.value)
      if (baseToArcResult.status === 'fulfilled') setBaseToArcProbe(baseToArcResult.value)
      if (arcToBaseResult.status === 'fulfilled') setArcToBaseProbe(arcToBaseResult.value)
    }

    void run()

    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    setQuoteResult(null)
    setSimulation(null)
    setReadOnlyError(null)
  }, [source, amount, address])

  const arcStatus = useMemo<'ready' | 'checking' | 'blocked'>(() => {
    if (!probe) return 'checking'
    return readiness.ready && probe.ready ? 'ready' : 'blocked'
  }, [probe, readiness.ready])

  const circleStatus: 'ready' | 'blocked' = circleReadiness.cctpReady ? 'ready' : 'blocked'
  const routeStatus: 'ready' | 'checking' | 'blocked' = !activeRouteProbe
    ? 'checking'
    : activeRouteProbe.ready
      ? 'ready'
      : 'blocked'

  const swapRoute = () => {
    setSource((current) => (current === 'base' ? 'arc' : 'base'))
  }

  const runReadOnlyCheck = useCallback(async () => {
    if (!hasValidAmount) return

    setReadOnlyError(null)
    setQuoteResult(null)
    setSimulation(null)

    try {
      if (isConnected && address) {
        const result = await simulateSource({
          sourceChainId,
          destinationChainId,
          amount,
          recipient: address,
        })
        setSimulation(result)
        setQuoteResult(result.quote)
        return
      }

      const result = await quote({
        sourceChainId,
        destinationChainId,
        amount,
      })
      setQuoteResult(result)
    } catch (error) {
      setReadOnlyError(error instanceof Error ? error.message : 'Read-only mainnet check failed.')
    }
  }, [
    address,
    amount,
    destinationChainId,
    hasValidAmount,
    isConnected,
    quote,
    simulateSource,
    sourceChainId,
  ])

  useEffect(() => {
    if (!hasValidAmount) return

    const timer = window.setTimeout(() => {
      void runReadOnlyCheck()
    }, 500)

    return () => window.clearTimeout(timer)
  }, [runReadOnlyCheck, hasValidAmount])

  const simulationSummary = simulation
    ? simulation.readyForBurn
      ? 'Burn simulation passed'
      : simulation.approvalRequired && simulation.readyForApproval
        ? 'Approval simulation passed; approval would be required'
        : simulation.approvalRequired
          ? 'Approval would be required'
          : 'Wallet is not ready for burn'
    : null

  const preflightReady = Boolean(
    quoteResult
    && simulation
    && arcStatus === 'ready'
    && circleStatus === 'ready'
    && routeStatus === 'ready',
  )
  const approvalIsNext = Boolean(preflightReady && simulation?.approvalRequired)
  const burnIsNext = Boolean(preflightReady && simulation && !simulation.approvalRequired && simulation.readyForBurn)
  const lockedActionLabel = !preflightReady
    ? 'Run preflight checks'
    : approvalIsNext
      ? `Approve ${amount} USDC`
      : burnIsNext
        ? `Burn ${amount} USDC`
        : 'Transfer not ready'

  return (
    <section className="bg-slate-50 px-4 py-5 text-slate-900">
      <div className="mx-auto max-w-xl">
        <div className="rounded-3xl border border-slate-200 bg-white p-6 shadow-[0_16px_45px_rgba(15,23,42,0.08)]">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h2 className="text-2xl font-semibold tracking-tight text-slate-900">Bridge USDC</h2>
              <p className="mt-2 text-sm leading-6 text-slate-500">
                Choose a mainnet route, connect a wallet, and run read-only checks before transfers are enabled.
              </p>
            </div>
            <span className="rounded-full border border-amber-200 bg-amber-50 px-3 py-1 text-xs font-semibold text-amber-800">
              Mainnet
            </span>
          </div>

          <div className="mt-5 flex items-center justify-between rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3">
            <div className="flex min-w-0 items-center gap-2">
              <Wallet size={16} className="flex-shrink-0 text-slate-500" />
              <div className="min-w-0">
                <p className="text-xs font-medium text-slate-500">EVM wallet</p>
                <p className="truncate text-sm font-semibold text-slate-800">{maskAddress(address)}</p>
              </div>
            </div>
            <span className={`rounded-full px-2.5 py-1 text-xs font-semibold ${
              isConnected ? 'bg-[#eef7e8] text-[#2F6E0C]' : 'bg-slate-200 text-slate-600'
            }`}>
              {isConnected ? 'connected' : 'connect above'}
            </span>
          </div>

          <div className="mt-5 rounded-2xl border border-slate-200 bg-slate-50 p-4">
            <div className="grid grid-cols-[1fr_auto_1fr] items-end gap-3">
              <label className="min-w-0">
                <span className="mb-2 block text-center text-xs font-medium text-slate-500">From</span>
                <select
                  value={source}
                  onChange={(event) => setSource(event.target.value as RouteEndpoint)}
                  className="h-11 w-full rounded-xl border border-slate-200 bg-white px-3 text-sm font-semibold text-slate-900 outline-none transition-colors focus:border-[#66D121]"
                >
                  <option value="base">Base</option>
                  <option value="arc">Arc</option>
                </select>
              </label>

              <button
                type="button"
                onClick={swapRoute}
                className="mb-0.5 inline-flex h-10 w-10 items-center justify-center rounded-xl border border-slate-200 bg-white text-slate-500 shadow-sm transition-colors hover:border-[#66D121]/40 hover:text-[#2F6E0C]"
                aria-label="Swap mainnet route"
              >
                <ArrowLeftRight size={16} />
              </button>

              <label className="min-w-0">
                <span className="mb-2 block text-center text-xs font-medium text-slate-500">To</span>
                <select
                  value={destination}
                  onChange={(event) => {
                    const nextDestination = event.target.value as RouteEndpoint
                    setSource(nextDestination === 'arc' ? 'base' : 'arc')
                  }}
                  className="h-11 w-full rounded-xl border border-slate-200 bg-white px-3 text-sm font-semibold text-slate-900 outline-none transition-colors focus:border-[#66D121]"
                >
                  <option value="arc">Arc</option>
                  <option value="base">Base</option>
                </select>
              </label>
            </div>
          </div>

          <div className="mt-5">
            <label className="text-sm font-medium text-slate-700">Token</label>
            <div className="mt-2 rounded-2xl border border-slate-200 bg-white px-4 py-4">
              <span className="font-semibold text-slate-900">USDC</span>
              <span className="ml-2 text-sm text-slate-500">(USD Coin)</span>
            </div>
          </div>

          <div className="mt-5">
            <label htmlFor="mainnet-preview-amount" className="text-sm font-medium text-slate-700">
              Amount
            </label>
            <input
              id="mainnet-preview-amount"
              type="number"
              min="0"
              step="0.01"
              inputMode="decimal"
              value={amount}
              onChange={(event) => setAmount(event.target.value)}
              placeholder="0.00"
              className="mt-2 h-12 w-full rounded-2xl border border-slate-200 bg-white px-4 text-base text-slate-900 outline-none transition-colors placeholder:text-slate-400 focus:border-[#66D121]"
            />
          </div>

          <div className="mt-5 rounded-2xl border border-blue-200 bg-blue-50 px-4 py-3 text-xs leading-5 text-blue-900">
            Read-only checks use production RPCs and Circle services. Wallet balance, allowance and transaction simulation are read without requesting a signature or broadcasting a transaction.
          </div>

          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            <div className="rounded-2xl border border-slate-200 bg-white px-4 py-3">
              <p className="text-xs font-medium text-slate-500">Transfer speed</p>
              <p className="mt-1 text-sm font-semibold text-slate-900">{transferModeLabel} CCTP</p>
              <p className="mt-1 text-xs leading-5 text-slate-500">
                {selectedMode === 'fast'
                  ? `Fast Transfer is selected for ${sourceName} as the source chain.`
                  : 'Arc uses the Standard CCTP source path; Fast Transfer is not required for Arc source transfers.'}
              </p>
            </div>
            <div className="rounded-2xl border border-slate-200 bg-white px-4 py-3">
              <p className="text-xs font-medium text-slate-500">Destination completion</p>
              <p className="mt-1 text-sm font-semibold text-slate-900">Manual mint</p>
              <p className="mt-1 text-xs leading-5 text-slate-500">
                Forwarding is off. The connected wallet remains the authorized destination caller.
              </p>
            </div>
          </div>

          <button
            type="button"
            onClick={() => void runReadOnlyCheck()}
            disabled={!hasValidAmount || cctpState.isLoading}
            className="mt-4 inline-flex h-11 w-full items-center justify-center gap-2 rounded-2xl border border-[#66D121]/30 bg-[#eef7e8] px-4 text-sm font-semibold text-[#2F6E0C] transition-colors hover:bg-[#e4f1db] disabled:cursor-not-allowed disabled:opacity-50"
          >
            <RefreshCw size={15} className={cctpState.isLoading ? 'animate-spin' : ''} />
            {cctpState.isLoading
              ? 'Checking...'
              : hasValidAmount
                ? 'Refresh checks'
                : 'Enter an amount'}
          </button>

          {(quoteResult || simulation || readOnlyError || cctpState.error) && (
            <div className="mt-4 rounded-2xl border border-slate-200 bg-slate-50 p-3.5">
              <div className="mb-2.5 flex items-center justify-between gap-3">
                <p className="text-sm font-semibold text-slate-900">Read-only result</p>
                <span className="rounded-full bg-[#eef7e8] px-2.5 py-1 text-[11px] font-semibold text-[#2F6E0C]">
                  {quoteResult?.mode === 'fast' ? 'Fast' : 'Standard'}
                </span>
              </div>

              {quoteResult && (
                <div className="space-y-2">
                  <StatusRow label={`Circle ${transferModeLabel} route quote`} state="ready" />
                  <div className="flex items-center justify-between gap-4 text-sm">
                    <span className="text-slate-600">{transferModeLabel} fee quote</span>
                    <span className="font-semibold text-slate-800">
                      {formatUnits(quoteResult.estimatedProtocolFeeRaw, 6)} USDC
                    </span>
                  </div>
                  <div className="flex items-center justify-between gap-4 text-sm">
                    <span className="text-slate-600">Fee rate</span>
                    <span className="font-semibold text-slate-800">
                      {quoteResult.minimumFeeBps} bps
                    </span>
                  </div>
                  <div className="flex items-center justify-between gap-4 text-sm">
                    <span className="text-slate-600">Mint delivery</span>
                    <span className="font-semibold text-slate-800">manual · forwarding off</span>
                  </div>
                </div>
              )}

              {simulation && (
                <div className="mt-2 space-y-2 border-t border-slate-200 pt-2.5">
                  <div className="flex items-center justify-between gap-4 text-sm">
                    <span className="text-slate-600">{sourceName} USDC balance</span>
                    <span className="font-semibold text-slate-800">{formatUnits(simulation.balanceRaw, 6)} USDC</span>
                  </div>
                  <div className="flex items-center justify-between gap-4 text-sm">
                    <span className="text-slate-600">Token allowance</span>
                    <span className="font-semibold text-slate-800">
                      {simulation.approvalRequired ? 'approval required' : 'sufficient'}
                    </span>
                  </div>
                  <div className="flex items-center justify-between gap-4 text-sm">
                    <span className="text-slate-600">Source simulation</span>
                    <span className={`font-semibold ${
                      simulation.readyForBurn || simulation.readyForApproval
                        ? 'text-[#2F6E0C]'
                        : 'text-amber-700'
                    }`}>
                      {simulationSummary}
                    </span>
                  </div>
                </div>
              )}

              {(readOnlyError || cctpState.error) && (
                <p className="mt-2 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs leading-5 text-amber-800">
                  {readOnlyError ?? cctpState.error}
                </p>
              )}
            </div>
          )}

          <div className="mt-4 rounded-2xl border border-slate-200 bg-slate-50 p-3.5">
            <div className="mb-2.5 flex items-center gap-2">
              <CheckCircle2 size={16} className="text-[#2F6E0C]" />
              <p className="text-sm font-semibold text-slate-900">Mainnet status</p>
            </div>
            <div className="space-y-2">
              <StatusRow label="Arc Mainnet" state={arcStatus} />
              <StatusRow label="Circle CCTP" state={circleStatus} />
              <StatusRow label={`${sourceName} → ${destinationName} route`} state={routeStatus} />
              <StatusRow label="Transactions" state={writesUnlocked && MAINNET_RUNTIME_IMPLEMENTED ? 'ready' : 'locked'} />
            </div>
          </div>

          {activeTransfers.length > 0 && (
            <div className="mt-4 rounded-2xl border border-slate-200 bg-white p-4">
              <div className="mb-3 flex items-center justify-between gap-3">
                <div>
                  <p className="text-sm font-semibold text-slate-900">Pending transfers</p>
                  <p className="mt-1 text-xs text-slate-500">
                    Transfers continue to be tracked independently while other transfers can start.
                  </p>
                </div>
                {readyToMintCount > 0 && (
                  <span className="rounded-full bg-[#eef7e8] px-2.5 py-1 text-xs font-semibold text-[#2F6E0C]">
                    {readyToMintCount} ready to mint
                  </span>
                )}
              </div>

              <div className="space-y-2.5">
                {activeTransfers.slice(0, 5).map((transfer) => (
                  <div
                    key={transfer.id}
                    className="rounded-xl border border-slate-200 bg-slate-50 px-3.5 py-3"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <p className="text-sm font-semibold text-slate-900">
                          {transfer.amount} USDC
                        </p>
                        <p className="mt-1 text-xs text-slate-500">
                          {chainName(transfer.sourceChainId)} → {chainName(transfer.destinationChainId)}
                        </p>
                      </div>
                      <span className={`rounded-full px-2.5 py-1 text-[11px] font-semibold ${
                        transfer.stage === 'ready_to_mint'
                          ? 'bg-[#eef7e8] text-[#2F6E0C]'
                          : transfer.stage === 'failed'
                            ? 'bg-amber-100 text-amber-800'
                            : 'bg-sky-100 text-sky-700'
                      }`}>
                        {transferStageLabel(transfer.stage)}
                      </span>
                    </div>

                    {transfer.sourceTxHash && (
                      <p className="mt-2 text-[11px] text-slate-400">
                        Source tx: {maskAddress(transfer.sourceTxHash)}
                      </p>
                    )}
                    {transfer.lastError && (
                      <p className="mt-2 text-xs leading-5 text-amber-700">
                        {transfer.lastError}
                      </p>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className="mt-5 rounded-2xl border border-slate-200 bg-white p-4">
            <div className="mb-4 flex items-start justify-between gap-4">
              <div>
                <p className="text-sm font-semibold text-slate-900">Transfer flow</p>
                <p className="mt-1 text-xs leading-5 text-slate-500">
                  Each transaction stays explicit. Attestation is monitored automatically; destination mint remains manual.
                </p>
              </div>
              <span className="rounded-full border border-slate-200 bg-slate-50 px-2.5 py-1 text-[11px] font-semibold text-slate-500">
                preview
              </span>
            </div>

            <div className="space-y-4">
              <PreviewStep
                index={1}
                title="Preflight"
                detail="Route, live fee, balance, allowance and source simulation."
                state={preflightReady ? 'complete' : 'current'}
              />
              <PreviewStep
                index={2}
                title="Approve USDC"
                detail={simulation?.approvalRequired
                  ? `Authorize exactly ${amount || '0'} USDC for Circle TokenMessenger.`
                  : 'Skipped when the existing allowance is sufficient.'}
                state={approvalIsNext ? 'current' : preflightReady && !simulation?.approvalRequired ? 'complete' : 'locked'}
              />
              <PreviewStep
                index={3}
                title="Burn on source"
                detail={`Confirm the ${sourceName} CCTP burn and lock the destination caller to this wallet.`}
                state={burnIsNext ? 'current' : 'locked'}
              />
              <PreviewStep
                index={4}
                title={`${transferModeLabel} attestation`}
                detail={selectedMode === 'fast'
                  ? 'Circle Fast attestation is monitored in the background while other transfers can continue.'
                  : 'Circle Standard attestation is monitored in the background; Arc source finality is already rapid.'}
                state="locked"
              />
              <PreviewStep
                index={5}
                title={`Mint on ${destinationName}`}
                detail={`Only ${maskAddress(address)} is configured to complete the destination receiveMessage call.`}
                state="locked"
              />
            </div>

            <button
              type="button"
              disabled
              className="mt-5 inline-flex h-12 w-full cursor-not-allowed items-center justify-center gap-2 rounded-2xl bg-[#9fbd90] px-4 text-sm font-semibold text-white opacity-90"
            >
              <LockKeyhole size={16} />
              {lockedActionLabel}
            </button>

            <p className="mt-3 text-center text-xs leading-5 text-slate-500">
              Preview only. Mainnet transaction writes remain code-locked until the production runtime is deliberately unlocked.
            </p>
          </div>
        </div>
      </div>
    </section>
  )
}
