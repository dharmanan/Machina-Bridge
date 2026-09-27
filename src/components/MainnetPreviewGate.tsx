import { useCallback, useEffect, useMemo, useState } from 'react'
import { formatUnits } from 'viem'
import { useAccount } from 'wagmi'
import { ArrowLeftRight, Bell, CheckCircle2, ExternalLink, LockKeyhole, RefreshCw, Wallet, X } from 'lucide-react'
import { getCircleMainnetReadiness } from '../config/circle'
import { getMainnetReadiness } from '../config/mainnet'
import { probeArcMainnetCapabilities, type MainnetCapabilityProbeResult } from '../config/mainnetProbe'
import { MAINNET_NETWORKS } from '../config/mainnetNetworks'
import {
  getMainnetCanaryMaxAmountRaw,
  getMainnetCanaryRoute,
  isMainnetCanaryRouteWriteEnabled,
  MAINNET_ARC_BRIDGE_NETWORK_KEYS,
} from '../config/mainnetCanary'
import {
  getDefaultMainnetCctpTransferMode,
  probeMainnetCctpRoute,
  type MainnetCctpRouteProbe,
} from '../config/mainnetCctp'
import { MAINNET_RUNTIME_IMPLEMENTED } from '../config/runtime'
import { useMainnetCctp } from '../hooks/useMainnetCctp'
import { useMainnetTransferQueue } from '../hooks/useMainnetTransferQueue'
import MainnetSolanaCanary from './MainnetSolanaCanary'
import type { MainnetTransferStage } from '../lib/mainnetTransferQueue'
import type { MainnetCctpQuote } from '../lib/mainnetCctpTransfer'
import {
  probeMainnetCctpDestinationGas,
  type MainnetCctpDestinationGasProbe,
  type MainnetCctpSourceSimulation,
} from '../lib/mainnetCctpSimulation'

type RouteEndpoint = (typeof MAINNET_ARC_BRIDGE_NETWORK_KEYS)[number]

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

function getMainnetTxExplorerUrl(chainId: number, txHash: string) {
  const network = Object.values(MAINNET_NETWORKS).find(
    (item) => item.chainId === chainId,
  )
  if (!network?.explorerUrl) return undefined
  return `${network.explorerUrl.replace(/\/$/, '')}/tx/${txHash}`
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
  const {
    state: cctpState,
    quote,
    simulateSource,
    writesUnlocked,
    canaryWritesUnlocked,
    createTransferPlan,
    approve,
    burn,
    getAttestation,
    mint,
  } = useMainnetCctp()
  const { transfers, activeTransfers, readyToMintCount } = useMainnetTransferQueue(address)

  const [probe, setProbe] = useState<MainnetCapabilityProbeResult | null>(null)
  const [routeProbe, setRouteProbe] = useState<MainnetCctpRouteProbe | null>(null)
  const [source, setSource] = useState<RouteEndpoint>('arc')
  const [destination, setDestination] = useState<RouteEndpoint>('base')
  const [amount, setAmount] = useState('0.1')
  const [quoteResult, setQuoteResult] = useState<MainnetCctpQuote | null>(null)
  const [simulation, setSimulation] = useState<MainnetCctpSourceSimulation | null>(null)
  const [destinationGas, setDestinationGas] = useState<MainnetCctpDestinationGasProbe | null>(null)
  const [readOnlyError, setReadOnlyError] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [isActivityOpen, setIsActivityOpen] = useState(false)
  const [isTrackerOpen, setIsTrackerOpen] = useState(false)
  const [bridgeView, setBridgeView] = useState<'evm' | 'solana'>('evm')

  const sourceNetwork = MAINNET_NETWORKS[source]
  const destinationNetwork = MAINNET_NETWORKS[destination]
  const sourceName = sourceNetwork.name
  const destinationName = destinationNetwork.name
  const sourceChainId = sourceNetwork.chainId
  const destinationChainId = destinationNetwork.chainId
  const selectedMode = getDefaultMainnetCctpTransferMode(sourceChainId)
  const transferModeLabel = selectedMode === 'fast' ? 'Fast' : 'Standard'
  const hasValidAmount = Boolean(amount) && Number.isFinite(Number(amount)) && Number(amount) > 0

  useEffect(() => {
    let cancelled = false

    const run = async () => {
      const result = await probeArcMainnetCapabilities()
      if (!cancelled) setProbe(result)
    }

    void run()

    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    setRouteProbe(null)

    const run = async () => {
      const result = await probeMainnetCctpRoute(
        sourceChainId,
        destinationChainId,
      )

      if (!cancelled) setRouteProbe(result)
    }

    void run()

    return () => {
      cancelled = true
    }
  }, [sourceChainId, destinationChainId])

  useEffect(() => {
    setQuoteResult(null)
    setSimulation(null)
    setDestinationGas(null)
    setReadOnlyError(null)
    setActionError(null)
  }, [source, destination, amount, address])

  const arcStatus = useMemo<'ready' | 'checking' | 'blocked'>(() => {
    if (!probe) return 'checking'
    return readiness.ready && probe.ready ? 'ready' : 'blocked'
  }, [probe, readiness.ready])

  const circleStatus: 'ready' | 'blocked' = circleReadiness.cctpReady ? 'ready' : 'blocked'
  const routeStatus: 'ready' | 'checking' | 'blocked' = !routeProbe
    ? 'checking'
    : routeProbe.ready
      ? 'ready'
      : 'blocked'

  const swapRoute = () => {
    setSource(destination)
    setDestination(source)
  }

  const selectSource = (nextSource: RouteEndpoint) => {
    setSource(nextSource)

    if (nextSource === 'arc') {
      if (destination === 'arc') setDestination('base')
      return
    }

    setDestination('arc')
  }

  const selectDestination = (nextDestination: RouteEndpoint) => {
    setDestination(nextDestination)

    if (nextDestination === 'arc') {
      if (source === 'arc') setSource('base')
      return
    }

    setSource('arc')
  }

  const runReadOnlyCheck = useCallback(async () => {
    if (!hasValidAmount) return

    setReadOnlyError(null)
    setQuoteResult(null)
    setSimulation(null)
    setDestinationGas(null)

    try {
      if (isConnected && address) {
        const [result, gasResult] = await Promise.all([
          simulateSource({
            sourceChainId,
            destinationChainId,
            amount,
            recipient: address,
          }),
          probeMainnetCctpDestinationGas({
            destinationChainId,
            account: address,
          }),
        ])

        setSimulation(result)
        setDestinationGas(gasResult)
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

  const sourceHasEnoughUsdc = Boolean(
    quoteResult
    && simulation
    && simulation.balanceRaw >= quoteResult.amountRaw
  )

  const sourceActionReady = Boolean(
    simulation
    && (
      simulation.approvalRequired
        ? simulation.readyForApproval
        : simulation.readyForBurn
    )
  )

  const preflightReady = Boolean(
    quoteResult
    && simulation
    && destinationGas?.ready
    && sourceHasEnoughUsdc
    && sourceActionReady
    && arcStatus === 'ready'
    && circleStatus === 'ready'
    && routeStatus === 'ready',
  )
  const canaryAmountRaw = quoteResult?.amountRaw ?? 0n
  const canaryMaxAmountRaw = getMainnetCanaryMaxAmountRaw()
  const canaryMaxAmount = formatUnits(canaryMaxAmountRaw, 6)

  const canaryPolicy = getMainnetCanaryRoute(
    sourceChainId,
    destinationChainId,
  )

  const canaryRouteSelected = Boolean(canaryPolicy)

  const canaryWriteEnabled = isMainnetCanaryRouteWriteEnabled(
    sourceChainId,
    destinationChainId,
  )

  const canaryEligible =
    canaryRouteSelected
    && canaryWriteEnabled
    && canaryAmountRaw > 0n
    && canaryAmountRaw <= canaryMaxAmountRaw
    && quoteResult?.mode === selectedMode

  const matchingTransfer =
    activeTransfers.find((transfer) =>
      transfer.sourceChainId === sourceChainId
      && transfer.destinationChainId === destinationChainId
      && Number(transfer.amount) === Number(amount),
    )
    ?? transfers.find((transfer) =>
      transfer.stage === 'complete'
      && transfer.sourceChainId === sourceChainId
      && transfer.destinationChainId === destinationChainId
      && Number(transfer.amount) === Number(amount),
    )

  const transferStage = matchingTransfer?.stage

  const readyToMintTransfers = transfers.filter(
    (transfer) => transfer.stage === 'ready_to_mint',
  )

  const completedTransfers = transfers.filter(
    (transfer) => transfer.stage === 'complete',
  )

  const inProgressTransfers = transfers.filter(
    (transfer) =>
      transfer.stage !== 'complete'
      && transfer.stage !== 'ready_to_mint',
  )

  const approvalIsNext = transferStage
    ? transferStage === 'approval_required' || transferStage === 'approving'
    : Boolean(preflightReady && simulation?.approvalRequired)

  const burnIsNext = transferStage
    ? transferStage === 'ready'
      || transferStage === 'approved'
      || transferStage === 'burning'
    : Boolean(
        preflightReady
        && simulation
        && !simulation.approvalRequired
        && simulation.readyForBurn,
      )

  const attestationIsNext = transferStage === 'waiting_attestation'
  const mintIsNext =
    transferStage === 'ready_to_mint'
    || transferStage === 'minting'

  const trackerActionLabel = !canaryRouteSelected
    ? 'Select an Arc route'
    : !canaryWriteEnabled
      ? `${sourceName} → ${destinationName} is unavailable`
      : quoteResult && quoteResult.amountRaw > canaryMaxAmountRaw
        ? `Maximum transfer is ${canaryMaxAmount} USDC`
      : !isConnected
        ? 'Connect wallet'
        : transferStage === 'complete'
          ? 'Transfer complete'
          : transferStage === 'approving'
            ? 'Approval pending...'
          : transferStage === 'burning'
            ? 'Sending...'
            : transferStage === 'waiting_attestation'
              ? 'Waiting for Circle...'
              : transferStage === 'minting'
                ? 'Receiving...'
                : transferStage === 'ready_to_mint'
                  ? `Receive on ${destinationName}`
                  : transferStage === 'approved' || transferStage === 'ready'
                    ? `Send ${amount} USDC`
                    : !preflightReady
                      ? 'Checking transfer...'
                      : simulation?.approvalRequired
                        ? `Approve ${amount} USDC`
                        : `Send ${amount} USDC`

  const amountExceedsLimit = hasValidAmount && Number(amount) > Number(canaryMaxAmount)
  const canOpenTracker =
    isConnected
    && hasValidAmount
    && !amountExceedsLimit
    && canaryRouteSelected
    && canaryWriteEnabled

  const mainActionLabel = !isConnected
    ? 'Connect wallet'
    : !hasValidAmount
      ? 'Enter an amount'
      : amountExceedsLimit
        ? `Maximum ${canaryMaxAmount} USDC`
        : matchingTransfer
          ? 'Open bridge tracker'
          : 'Review transfer'

  const actionDisabled =
    !canaryWritesUnlocked
    || !isConnected
    || (!matchingTransfer && (!preflightReady || !canaryEligible))
    || transferStage === 'approving'
    || transferStage === 'burning'
    || transferStage === 'waiting_attestation'
    || transferStage === 'minting'
    || transferStage === 'failed'
    || transferStage === 'complete'
    || cctpState.isLoading

  const runCanaryAction = useCallback(async () => {
    if (!address) return

    setActionError(null)

    try {
      let transfer = matchingTransfer

      if (!transfer) {
        if (!quoteResult || !simulation || !preflightReady || !canaryEligible) {
          throw new Error(`${sourceName} → ${destinationName} transfer checks are not ready.`)
        }

        transfer = createTransferPlan({
          sourceChainId,
          destinationChainId,
          amount,
          approvalRequired: simulation.approvalRequired,
          mode: quoteResult.mode,
          recipient: address,
          destinationCaller: address,
        })
      }

      if (transfer.stage === 'approval_required') {
        if (!quoteResult || !simulation?.readyForApproval) {
          throw new Error(
            'Approval simulation must pass before requesting a signature.',
          )
        }

        await approve({
          sourceChainId: transfer.sourceChainId,
          amountRaw: quoteResult.amountRaw,
          transferId: transfer.id,
        })

        await runReadOnlyCheck()
        return
      }

      if (transfer.stage === 'ready' || transfer.stage === 'approved') {
        const freshSimulation = await simulateSource({
          sourceChainId: transfer.sourceChainId,
          destinationChainId: transfer.destinationChainId,
          amount: transfer.amount,
          recipient: address,
          mode: transfer.mode,
        })

        setSimulation(freshSimulation)
        setQuoteResult(freshSimulation.quote)

        if (!freshSimulation.readyForBurn) {
          throw new Error(
            'Fresh burn simulation did not pass. No transaction was submitted.',
          )
        }

        await burn({
          quote: freshSimulation.quote,
          recipient: address,
          destinationCaller: address,
          transferId: transfer.id,
        })

        return
      }

      if (transfer.stage === 'ready_to_mint') {
        if (!transfer.sourceTxHash) {
          throw new Error(
            'Source transaction hash is missing from the transfer record.',
          )
        }

        const attestation = await getAttestation({
          sourceChainId: transfer.sourceChainId,
          sourceTxHash: transfer.sourceTxHash as `0x${string}`,
          transferId: transfer.id,
        })

        if (
          attestation.status !== 'complete'
          || !attestation.message
          || !attestation.attestation
        ) {
          throw new Error('Circle attestation is not complete yet.')
        }

        await mint({
          destinationChainId: transfer.destinationChainId,
          message: attestation.message,
          attestation: attestation.attestation,
          transferId: transfer.id,
        })
      }
    } catch (error) {
      setActionError(
        error instanceof Error
          ? error.message
          : 'Mainnet transfer failed.',
      )
    }
  }, [
    address,
    amount,
    approve,
    burn,
    canaryEligible,
    createTransferPlan,
    destinationChainId,
    getAttestation,
    matchingTransfer,
    mint,
    preflightReady,
    quoteResult,
    runReadOnlyCheck,
    simulateSource,
    simulation,
    sourceChainId,
  ])

  return (
    <section className="bg-slate-50 px-4 py-5 text-slate-900">
      <div className="mx-auto mb-4 grid max-w-xl grid-cols-2 gap-2 rounded-2xl border border-slate-200 bg-white p-1.5 shadow-[0_10px_28px_rgba(15,23,42,0.05)]">
        <button
          type="button"
          onClick={() => setBridgeView('evm')}
          className={`rounded-xl px-4 py-2.5 text-sm font-semibold transition-colors ${
            bridgeView === 'evm'
              ? 'bg-[#eef7e8] text-[#2F6E0C] ring-1 ring-[#66D121]/35'
              : 'text-slate-500 hover:bg-slate-50 hover:text-slate-900'
          }`}
        >
          EVM Bridge
        </button>
        <button
          type="button"
          onClick={() => setBridgeView('solana')}
          className={`rounded-xl px-4 py-2.5 text-sm font-semibold transition-colors ${
            bridgeView === 'solana'
              ? 'bg-[#eef7e8] text-[#2F6E0C] ring-1 ring-[#66D121]/35'
              : 'text-slate-500 hover:bg-slate-50 hover:text-slate-900'
          }`}
        >
          Solana Bridge
        </button>
      </div>

      {bridgeView === 'evm' ? (
      <div className="mx-auto max-w-xl">
        <div className="rounded-3xl border border-slate-200 bg-white p-6 shadow-[0_16px_45px_rgba(15,23,42,0.08)]">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h2 className="text-2xl font-semibold tracking-tight text-slate-900">Bridge USDC</h2>
              <p className="mt-2 text-sm leading-6 text-slate-500">
                Choose a verified mainnet route, review the transfer checks, and bridge USDC.
              </p>
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setIsActivityOpen(true)}
                className="relative inline-flex h-9 w-9 items-center justify-center rounded-xl border border-slate-200 bg-white text-slate-600 transition-colors hover:bg-slate-50"
                title="Open activity"
                aria-label="Open activity"
              >
                <Bell size={16} />
                {readyToMintCount > 0 && (
                  <span className="absolute -right-1 -top-1 inline-flex min-h-[18px] min-w-[18px] items-center justify-center rounded-full bg-amber-500 px-1 text-[11px] font-semibold text-white">
                    {readyToMintCount}
                  </span>
                )}
              </button>

              <span className="rounded-full border border-amber-200 bg-amber-50 px-3 py-1 text-xs font-semibold text-amber-800">
                Mainnet
              </span>
            </div>
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
                  onChange={(event) => selectSource(event.target.value as RouteEndpoint)}
                  className="h-11 w-full rounded-xl border border-slate-200 bg-white px-3 text-sm font-semibold text-slate-900 outline-none transition-colors focus:border-[#66D121]"
                >
                  {MAINNET_ARC_BRIDGE_NETWORK_KEYS.map((key) => (
                    <option key={key} value={key}>
                      {MAINNET_NETWORKS[key].name}
                    </option>
                  ))}
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
                  onChange={(event) =>
                    selectDestination(event.target.value as RouteEndpoint)
                  }
                  className="h-11 w-full rounded-xl border border-slate-200 bg-white px-3 text-sm font-semibold text-slate-900 outline-none transition-colors focus:border-[#66D121]"
                >
                  {MAINNET_ARC_BRIDGE_NETWORK_KEYS.map((key) => (
                    <option key={key} value={key}>
                      {MAINNET_NETWORKS[key].name}
                    </option>
                  ))}
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

          <div className="mt-5 rounded-2xl border border-slate-200 bg-slate-50 p-4">
            <div className="flex items-center justify-between gap-4">
              <div>
                <p className="text-sm font-semibold text-slate-900">Transfer summary</p>
                <p className="mt-1 text-xs text-slate-500">
                  Network fees are shown by your wallet before each signature.
                </p>
              </div>
              <span className={`rounded-full px-2.5 py-1 text-[11px] font-semibold ${
                routeStatus === 'ready' && circleStatus === 'ready'
                  ? 'bg-[#eef7e8] text-[#2F6E0C]'
                  : routeStatus === 'blocked' || circleStatus === 'blocked'
                    ? 'bg-amber-100 text-amber-800'
                    : 'bg-slate-100 text-slate-500'
              }`}>
                {routeStatus === 'ready' && circleStatus === 'ready'
                  ? 'Route ready'
                  : routeStatus === 'blocked' || circleStatus === 'blocked'
                    ? 'Needs attention'
                    : 'Checking'}
              </span>
            </div>

            <div className="mt-4 space-y-2 text-sm">
              <div className="flex items-center justify-between gap-4">
                <span className="text-slate-500">Amount</span>
                <span className="font-semibold text-slate-900">{amount || '0'} USDC</span>
              </div>
              <div className="flex items-center justify-between gap-4">
                <span className="text-slate-500">Circle fee</span>
                <span className="font-semibold text-slate-900">
                  {quoteResult ? `${formatUnits(quoteResult.estimatedProtocolFeeRaw, 6)} USDC` : 'Checking...'}
                </span>
              </div>
              <div className="flex items-center justify-between gap-4">
                <span className="text-slate-500">Current limit</span>
                <span className="font-semibold text-slate-900">{canaryMaxAmount} USDC</span>
              </div>
            </div>

            {(readOnlyError || cctpState.error || actionError) && (
              <p className="mt-3 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs leading-5 text-amber-800">
                {readOnlyError ?? cctpState.error ?? actionError}
              </p>
            )}
          </div>

          <button
            type="button"
            onClick={() => setIsTrackerOpen(true)}
            disabled={!canOpenTracker}
            className="mt-5 inline-flex h-12 w-full items-center justify-center gap-2 rounded-2xl bg-[#66D121] px-4 text-sm font-semibold text-slate-950 transition-colors hover:bg-[#5bc11c] disabled:cursor-not-allowed disabled:bg-[#9fbd90] disabled:text-white"
          >
            {canOpenTracker ? <Wallet size={16} /> : <LockKeyhole size={16} />}
            {mainActionLabel}
          </button>

          <p className="mt-3 text-center text-xs leading-5 text-slate-500">
            Verified mainnet transfers are currently limited to {canaryMaxAmount} USDC.
          </p>
        </div>
      </div>
      ) : (
        <div className="mx-auto max-w-xl">
          <MainnetSolanaCanary />
        </div>
      )}

      {isTrackerOpen && bridgeView === 'evm' && (
        <div
          className="fixed inset-0 z-[95] flex items-start justify-center overflow-y-auto bg-slate-950/70 px-4 py-6 backdrop-blur-sm sm:items-center"
          onClick={() => setIsTrackerOpen(false)}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="mainnet-bridge-tracker-title"
            className="relative flex max-h-[90vh] w-full max-w-2xl flex-col overflow-hidden rounded-[28px] border border-slate-200 bg-white p-6 shadow-[0_24px_80px_rgba(15,23,42,0.28)]"
            onClick={(event) => event.stopPropagation()}
          >
            <button
              type="button"
              onClick={() => setIsTrackerOpen(false)}
              className="absolute right-4 top-4 rounded-full border border-slate-200 p-2 text-slate-500 transition-colors hover:bg-slate-50 hover:text-slate-800"
              aria-label="Close bridge tracker"
            >
              <X size={16} />
            </button>

            <div className="mb-4 inline-flex h-12 w-12 items-center justify-center rounded-2xl bg-[#eef7e8] text-[#2F6E0C]">
              <CheckCircle2 size={22} />
            </div>

            <h2 id="mainnet-bridge-tracker-title" className="text-2xl font-semibold tracking-tight text-slate-900">
              Bridge Tracker
            </h2>
            <p className="mt-2 text-sm text-slate-500">
              {sourceName} → {destinationName} · {amount || '0'} USDC
            </p>

            <div className="mt-5 overflow-y-auto pr-1">
              <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
                <div className="flex items-center justify-between gap-4">
                  <div>
                    <p className="text-xs uppercase tracking-[0.16em] text-slate-400">Status</p>
                    <p className="mt-1 text-sm font-semibold text-slate-900">
                      {transferStage === 'complete'
                        ? 'Transfer complete'
                        : transferStage === 'waiting_attestation'
                          ? 'Waiting for Circle'
                          : transferStage === 'ready_to_mint'
                            ? `Ready to receive on ${destinationName}`
                            : transferStage === 'approving'
                              ? 'Approval pending'
                              : transferStage === 'burning'
                                ? 'Sending'
                                : preflightReady
                                  ? 'Ready for next step'
                                  : 'Checking route'}
                    </p>
                  </div>
                  <span className="rounded-full bg-white px-2.5 py-1 text-[11px] font-semibold text-slate-600">
                    Mainnet
                  </span>
                </div>
              </div>

              <div className="mt-4 space-y-3">
                <PreviewStep
                  index={1}
                  title="Approve"
                  detail={simulation?.approvalRequired
                    ? `Allow Circle to move exactly ${amount || '0'} USDC.`
                    : 'No approval is needed for this transfer.'}
                  state={
                    transferStage
                      && !['approval_required', 'approving'].includes(transferStage)
                      ? 'complete'
                      : approvalIsNext
                        ? 'current'
                        : preflightReady && !simulation?.approvalRequired
                          ? 'complete'
                          : 'locked'
                  }
                />
                <PreviewStep
                  index={2}
                  title={`Send from ${sourceName}`}
                  detail="Confirm the source transaction in your wallet."
                  state={
                    transferStage
                      && ['waiting_attestation', 'ready_to_mint', 'minting', 'complete'].includes(transferStage)
                      ? 'complete'
                      : burnIsNext
                        ? 'current'
                        : 'locked'
                  }
                />
                <PreviewStep
                  index={3}
                  title="Circle confirmation"
                  detail="Circle confirms the cross-chain transfer automatically in the background."
                  state={
                    transferStage
                      && ['ready_to_mint', 'minting', 'complete'].includes(transferStage)
                      ? 'complete'
                      : attestationIsNext
                        ? 'current'
                        : 'locked'
                  }
                />
                <PreviewStep
                  index={4}
                  title={`Receive on ${destinationName}`}
                  detail="Confirm the destination transaction when it becomes ready."
                  state={transferStage === 'complete' ? 'complete' : mintIsNext ? 'current' : 'locked'}
                />
              </div>

              {transferStage === 'complete' && matchingTransfer && (
                <div className="mt-4 rounded-2xl border border-[#cfe8bf] bg-[#eef7e8] p-4 text-sm text-[#2F6E0C]">
                  <p className="font-semibold">Transfer complete</p>
                  <div className="mt-2 flex flex-wrap gap-3 text-[11px]">
                    {matchingTransfer.sourceTxHash && (() => {
                      const url = getMainnetTxExplorerUrl(
                        matchingTransfer.sourceChainId,
                        matchingTransfer.sourceTxHash,
                      )
                      return url ? (
                        <a href={url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 hover:underline">
                          Source tx <ExternalLink size={11} />
                        </a>
                      ) : null
                    })()}
                    {matchingTransfer.destinationTxHash && (() => {
                      const url = getMainnetTxExplorerUrl(
                        matchingTransfer.destinationChainId,
                        matchingTransfer.destinationTxHash,
                      )
                      return url ? (
                        <a href={url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 hover:underline">
                          Destination tx <ExternalLink size={11} />
                        </a>
                      ) : null
                    })()}
                  </div>
                </div>
              )}

              {actionError && (
                <p className="mt-4 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs leading-5 text-amber-800">
                  {actionError}
                </p>
              )}

              <button
                type="button"
                onClick={() => void runCanaryAction()}
                disabled={actionDisabled}
                className="mt-5 inline-flex h-12 w-full items-center justify-center rounded-2xl bg-[#2F6E0C] px-4 text-sm font-semibold text-white transition-colors hover:bg-[#25580A] disabled:cursor-not-allowed disabled:bg-slate-200 disabled:text-slate-500"
              >
                {trackerActionLabel}
              </button>

              <p className="mt-3 text-center text-[11px] leading-5 text-slate-400">
                Your wallet shows the transaction and network fee before every signature.
              </p>
            </div>
          </div>
        </div>
      )}

      {isActivityOpen && (
        <div
          className="fixed inset-0 z-[100] flex items-center justify-center bg-slate-950/70 px-4 py-6 backdrop-blur-sm"
          onClick={() => setIsActivityOpen(false)}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="mainnet-activity-title"
            className="relative w-full max-w-2xl rounded-[28px] border border-slate-200 bg-white p-6 shadow-[0_24px_80px_rgba(15,23,42,0.28)]"
            onClick={(event) => event.stopPropagation()}
          >
            <button
              type="button"
              onClick={() => setIsActivityOpen(false)}
              className="absolute right-4 top-4 rounded-full border border-slate-200 p-2 text-slate-500 transition-colors hover:bg-slate-50 hover:text-slate-800"
              aria-label="Close activity"
            >
              <X size={16} />
            </button>

            <div className="mb-4 inline-flex h-12 w-12 items-center justify-center rounded-2xl bg-[#eef7e8] text-[#2F6E0C]">
              <Bell size={22} />
            </div>

            <h2
              id="mainnet-activity-title"
              className="text-2xl font-semibold tracking-tight text-slate-900"
            >
              Mainnet Activity
            </h2>

            <p className="mt-2 text-sm leading-6 text-slate-500">
              Pending, ready-to-mint and completed mainnet transfers for this wallet.
            </p>

            <div className="mt-6 max-h-[60vh] space-y-6 overflow-y-auto pr-1">
              {readyToMintTransfers.length > 0 && (
                <div>
                  <div className="mb-2 flex items-center justify-between">
                    <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                      Ready to Mint
                    </h3>
                    <span className="text-xs text-slate-400">
                      {readyToMintTransfers.length}
                    </span>
                  </div>

                  <div className="space-y-2">
                    {readyToMintTransfers.map((transfer) => (
                      <div
                        key={transfer.id}
                        className="rounded-2xl border border-amber-200 bg-amber-50 p-4"
                      >
                        <div className="flex items-start justify-between gap-4">
                          <div>
                            <p className="text-sm font-semibold text-slate-900">
                              {transfer.amount} USDC
                            </p>
                            <p className="mt-1 text-xs text-slate-600">
                              {chainName(transfer.sourceChainId)} → {chainName(transfer.destinationChainId)}
                            </p>
                          </div>

                          <span className="rounded-full bg-amber-100 px-2.5 py-1 text-[11px] font-semibold text-amber-800">
                            Ready to mint
                          </span>
                        </div>

                        {transfer.sourceTxHash && (() => {
                          const sourceTxUrl = getMainnetTxExplorerUrl(
                            transfer.sourceChainId,
                            transfer.sourceTxHash,
                          )

                          return sourceTxUrl ? (
                            <a
                              href={sourceTxUrl}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="mt-3 inline-flex items-center gap-1 text-[11px] font-medium text-slate-600 hover:text-slate-900 hover:underline"
                            >
                              Source tx: {maskAddress(transfer.sourceTxHash)}
                              <ExternalLink size={11} />
                            </a>
                          ) : null
                        })()}
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {completedTransfers.length > 0 && (
                <div>
                  <div className="mb-2 flex items-center justify-between">
                    <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                      Completed
                    </h3>
                    <span className="text-xs text-slate-400">
                      {completedTransfers.length}
                    </span>
                  </div>

                  <div className="space-y-2">
                    {completedTransfers.map((transfer) => (
                      <div
                        key={transfer.id}
                        className="rounded-2xl border border-emerald-200 bg-emerald-50 p-4"
                      >
                        <div className="flex items-start justify-between gap-4">
                          <div>
                            <p className="text-sm font-semibold text-slate-900">
                              {transfer.amount} USDC
                            </p>
                            <p className="mt-1 text-xs text-slate-600">
                              {chainName(transfer.sourceChainId)} → {chainName(transfer.destinationChainId)}
                            </p>
                          </div>

                          <span className="rounded-full bg-emerald-100 px-2.5 py-1 text-[11px] font-semibold text-emerald-800">
                            Complete
                          </span>
                        </div>

                        <div className="mt-3 flex flex-wrap gap-x-3 gap-y-1">
                          {transfer.sourceTxHash && (() => {
                            const sourceTxUrl = getMainnetTxExplorerUrl(
                              transfer.sourceChainId,
                              transfer.sourceTxHash,
                            )

                            return sourceTxUrl ? (
                              <a
                                href={sourceTxUrl}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="inline-flex items-center gap-1 text-[11px] font-medium text-slate-600 hover:text-slate-900 hover:underline"
                              >
                                Source tx: {maskAddress(transfer.sourceTxHash)}
                                <ExternalLink size={11} />
                              </a>
                            ) : null
                          })()}

                          {transfer.destinationTxHash && (() => {
                            const destinationTxUrl = getMainnetTxExplorerUrl(
                              transfer.destinationChainId,
                              transfer.destinationTxHash,
                            )

                            return destinationTxUrl ? (
                              <a
                                href={destinationTxUrl}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="inline-flex items-center gap-1 text-[11px] font-medium text-slate-600 hover:text-slate-900 hover:underline"
                              >
                                Destination tx: {maskAddress(transfer.destinationTxHash)}
                                <ExternalLink size={11} />
                              </a>
                            ) : null
                          })()}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {inProgressTransfers.length > 0 && (
                <div>
                  <div className="mb-2 flex items-center justify-between">
                    <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                      Pending / Failed
                    </h3>
                    <span className="text-xs text-slate-400">
                      {inProgressTransfers.length}
                    </span>
                  </div>

                  <div className="space-y-2">
                    {inProgressTransfers.map((transfer) => (
                      <div
                        key={transfer.id}
                        className="rounded-2xl border border-slate-200 bg-slate-50 p-4"
                      >
                        <div className="flex items-start justify-between gap-4">
                          <div>
                            <p className="text-sm font-semibold text-slate-900">
                              {transfer.amount} USDC
                            </p>
                            <p className="mt-1 text-xs text-slate-600">
                              {chainName(transfer.sourceChainId)} → {chainName(transfer.destinationChainId)}
                            </p>
                          </div>

                          <span className="rounded-full border border-slate-200 bg-white px-2.5 py-1 text-[11px] font-semibold text-slate-600">
                            {transferStageLabel(transfer.stage)}
                          </span>
                        </div>

                        {transfer.sourceTxHash && (() => {
                          const sourceTxUrl = getMainnetTxExplorerUrl(
                            transfer.sourceChainId,
                            transfer.sourceTxHash,
                          )

                          return sourceTxUrl ? (
                            <a
                              href={sourceTxUrl}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="mt-3 inline-flex items-center gap-1 text-[11px] font-medium text-slate-500 hover:text-slate-900 hover:underline"
                            >
                              Source tx: {maskAddress(transfer.sourceTxHash)}
                              <ExternalLink size={11} />
                            </a>
                          ) : null
                        })()}

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

              {transfers.length === 0 && (
                <div className="rounded-2xl border border-dashed border-slate-200 px-4 py-8 text-center">
                  <p className="text-sm font-medium text-slate-700">
                    No mainnet activity yet
                  </p>
                  <p className="mt-1 text-xs leading-5 text-slate-500">
                    Mainnet transfers for this wallet will appear here.
                  </p>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </section>
  )
}
