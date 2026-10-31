import { useCallback, useEffect, useRef, useState } from 'react'
import { Wallet, RefreshCw, RotateCcw, LockKeyhole, ExternalLink, ArrowDownUp, Loader2 } from 'lucide-react'
import { useAccount } from 'wagmi'
import { usePhantomSolana } from '../hooks/usePhantomSolana'
import { useMainnetSolanaCctp } from '../hooks/useMainnetSolanaCctp'
import {
  MAINNET_SOLANA_CCTP_CANARY_ROUTES,
  type MainnetSolanaCanaryDirection,
} from '../config/mainnetSolanaCanary'
import { MAINNET_SOLANA_CCTP_CANARY_ENABLED } from '../config/runtime'
import { MAINNET_NETWORKS } from '../config/mainnetNetworks'
import { SOLANA_MAINNET_CCTP } from '../config/mainnetSolana'
import { parseUsdcAmountInput } from '../lib/usdcAmountInput'
import {
  listMainnetSolanaActivity,
  recordMainnetSolanaActivity,
  updateMainnetSolanaActivity,
} from '../lib/mainnetSolanaActivity'
import {
  discoverMainnetSolanaRefunds,
  loadMainnetSolanaRefundMetadata,
  reclaimMainnetSolanaDeposit,
  type MainnetSolanaDiscoveredRefund,
} from '../lib/mainnetSolanaReclaim'

function mask(address?: string | null) {
  if (!address) return 'Not connected'
  return `${address.slice(0, 6)}...${address.slice(-4)}`
}

function txMask(hash?: string | null) {
  if (!hash) return '—'
  return `${hash.slice(0, 8)}...${hash.slice(-6)}`
}

function refundTiming(timestamp: number) {
  const diff = timestamp - Date.now()
  if (diff <= 0) return 'Eligible now'

  const hours = Math.ceil(diff / (60 * 60 * 1000))
  if (hours < 24) return `Eligible in ${hours}h`

  const days = Math.floor(hours / 24)
  const remainingHours = hours % 24
  return remainingHours > 0
    ? `Eligible in ${days}d ${remainingHours}h`
    : `Eligible in ${days}d`
}

export default function MainnetSolanaCanary() {
  const { address: evmAddress, isConnected: evmConnected, connector } = useAccount()
  const {
    address: phantomAddress,
    isConnected: phantomConnected,
    provider,
  } = usePhantomSolana()

  const {
    state,
    kitSupport,
    arcBalance,
    arcBalanceError,
    refreshArcBalance,
    solanaBalance,
    solanaBalanceError,
    refreshSolanaBalance,
    pendingArcToSolanaTx,
    pendingArcToSolanaError,
    feeEstimate,
    feeEstimateError,
    isEstimatingFees,
    estimateCanary,
    findPendingArcToSolanaBurn,
    recoverPendingArcToSolana,
    runCanary,
  } = useMainnetSolanaCctp(provider, phantomAddress)

  const [direction, setDirection] =
    useState<MainnetSolanaCanaryDirection>('arc-to-solana')
  const [amount, setAmount] = useState('')
  const [recoveryHash, setRecoveryHash] = useState('')
  const [costDetailsOpen, setCostDetailsOpen] = useState(false)
  const [reviewing, setReviewing] = useState(false)
  const [refundPanelOpen, setRefundPanelOpen] = useState(false)
  const [refunds, setRefunds] = useState<MainnetSolanaDiscoveredRefund[]>([])
  const [refundsLoading, setRefundsLoading] = useState(false)
  const [refundsError, setRefundsError] = useState<string | null>(null)
  const [reclaimingRefund, setReclaimingRefund] = useState<string | null>(null)
  const [reclaimError, setReclaimError] = useState<string | null>(null)
  const [reclaimSuccessTx, setReclaimSuccessTx] = useState<string | null>(null)
  const [, setRefundClock] = useState(() => Date.now())

  const transferResult =
    state.result && typeof state.result === 'object'
      ? state.result as {
          sourceTxHash?: string
          destinationTxHash?: string
          recovered?: boolean
          direction?: MainnetSolanaCanaryDirection
        }
      : null

  // One canonical amount ("0,1" -> "0.1") for the fee quote, the Review and the signed transfer.
  const parsedAmount = parseUsdcAmountInput(amount)
  const amountValid = 'value' in parsedAmount
  const normalizedAmount = 'value' in parsedAmount ? parsedAmount.value : ''
  const amountError = amount.trim() && 'error' in parsedAmount ? parsedAmount.error : null

  useEffect(() => {
    if (evmAddress) {
      void refreshArcBalance().catch(() => undefined)
    }
    if (phantomAddress) {
      void refreshSolanaBalance().catch(() => undefined)
    }
  }, [evmAddress, phantomAddress, refreshArcBalance, refreshSolanaBalance])

  const refreshRefunds = useCallback(async () => {
    if (!phantomAddress) {
      setRefunds([])
      setRefundsError(null)
      return
    }

    setRefundsLoading(true)
    setRefundsError(null)

    try {
      const found = await discoverMainnetSolanaRefunds(phantomAddress)
      setRefunds(found)
    } catch (error) {
      setRefundsError(
        error instanceof Error
          ? error.message
          : 'Could not scan refundable Circle deposits.',
      )
    } finally {
      setRefundsLoading(false)
    }
  }, [phantomAddress])

  useEffect(() => {
    if (direction !== 'solana-to-arc' || !phantomAddress) {
      return
    }
    void refreshRefunds()
  }, [direction, phantomAddress, refreshRefunds])

  useEffect(() => {
    const timer = window.setInterval(() => setRefundClock(Date.now()), 60_000)
    return () => window.clearInterval(timer)
  }, [])

  const handleReclaim = useCallback(async (
    refund: MainnetSolanaDiscoveredRefund,
  ) => {
    if (!provider || !phantomAddress) {
      setReclaimError('Connect Phantom before returning SOL.')
      return
    }

    setReclaimingRefund(refund.messageSentEventAccount)
    setReclaimError(null)
    setReclaimSuccessTx(null)

    try {
      const result = await reclaimMainnetSolanaDeposit({
        provider,
        connectedWallet: phantomAddress,
        originalWallet: phantomAddress,
        metadata: refund,
      })

      const localRecord = listMainnetSolanaActivity(
        evmAddress,
        phantomAddress,
      ).find(
        (item) =>
          item.sourceTxHash?.toLowerCase() === refund.sourceTxHash.toLowerCase(),
      )

      if (localRecord) {
        updateMainnetSolanaActivity(localRecord.id, {
          ...refund,
          refundStatus: 'reclaimed',
          refundTxHash: result.txHash,
          reclaimedAt: Date.now(),
        })
      }

      setReclaimSuccessTx(result.txHash ?? 'already-closed')
      await refreshRefunds()
    } catch (error) {
      setReclaimError(
        error instanceof Error ? error.message : 'SOL return failed.',
      )
    } finally {
      setReclaimingRefund(null)
    }
  }, [evmAddress, phantomAddress, provider, refreshRefunds])

  useEffect(() => {
    if (!evmAddress || !phantomAddress || state.isLoading) return
    void findPendingArcToSolanaBurn().catch(() => undefined)
  }, [evmAddress, phantomAddress, state.isLoading, findPendingArcToSolanaBurn])

  useEffect(() => {
    if (
      !evmConnected
      || !phantomConnected
      || !amountValid
      || state.isLoading
    ) {
      return
    }

    const timer = window.setTimeout(() => {
      void estimateCanary(direction, normalizedAmount).catch(() => undefined)
    }, 450)

    return () => window.clearTimeout(timer)
  }, [
    normalizedAmount,
    amountValid,
    direction,
    estimateCanary,
    evmConnected,
    phantomConnected,
    state.isLoading,
  ])

  const phase = MAINNET_SOLANA_CCTP_CANARY_ROUTES[direction]
  const routeWriteEnabled = phase === 'testing' || phase === 'verified'
  const globalWriteEnabled = MAINNET_SOLANA_CCTP_CANARY_ENABLED
  const canRun =
    kitSupport.ready
    && evmConnected
    && phantomConnected
    && globalWriteEnabled
    && routeWriteEnabled
    && amountValid
    && !state.isLoading

  // One transfer at a time: a second click in the same tick (before React re-renders the
  // disabled button) must not start a second transfer. runCanary itself has no in-flight guard.
  const bridgeStarted = useRef(false)
  const handleBridge = async () => {
    if (bridgeStarted.current) return
    bridgeStarted.current = true
    let result: { sourceTxHash?: string; destinationTxHash?: string } | null
    try {
      result = await runCanary(direction, normalizedAmount) as typeof result
    } finally {
      bridgeStarted.current = false
    }

    if (!result?.sourceTxHash || !result?.destinationTxHash || !evmAddress || !phantomAddress) {
      return
    }

    const refundableDepositSol =
      direction === 'solana-to-arc'
        ? feeEstimate?.solanaEventRentSol ?? undefined
        : undefined
    const refundAvailableAt =
      direction === 'solana-to-arc'
      && feeEstimate?.solanaEventRentRefundableAfterDays
        ? Date.now() + (feeEstimate.solanaEventRentRefundableAfterDays * 24 * 60 * 60 * 1000)
        : undefined

    const activityRecord = recordMainnetSolanaActivity({
      evmWallet: evmAddress,
      solanaWallet: phantomAddress,
      direction,
      amount: normalizedAmount,
      sourceTxHash: result.sourceTxHash,
      destinationTxHash: result.destinationTxHash,
      refundableDepositSol,
      refundAvailableAt,
      refundStatus: direction === 'solana-to-arc' ? 'pending' : undefined,
    })

    if (direction === 'solana-to-arc') {
      try {
        const refundMetadata = await loadMainnetSolanaRefundMetadata(
          result.sourceTxHash,
          phantomAddress,
        )
        updateMainnetSolanaActivity(activityRecord.id, {
          ...refundMetadata,
          refundStatus: 'pending',
        })
      } catch {
        // Transfer is already complete. On-chain discovery below remains the
        // source of truth even if metadata hydration is temporarily unavailable.
      }

      void refreshRefunds()
    }
  }

  const fromChain = direction === 'arc-to-solana' ? 'Arc' : 'Solana'
  const toChain = direction === 'arc-to-solana' ? 'Solana' : 'Arc'
  const evmLabel = evmAddress ? `${connector?.name ?? 'EVM wallet'} · ${mask(evmAddress)}` : null
  const solanaLabel = phantomAddress ? `Phantom · ${mask(phantomAddress)}` : null
  const sourceBalance = direction === 'arc-to-solana' ? arcBalance : solanaBalance
  const sourceBalanceError = direction === 'arc-to-solana' ? arcBalanceError : solanaBalanceError
  const networkFees = feeEstimate?.gasFees
    .filter((fee) => !(direction === 'solana-to-arc' && fee.token.toUpperCase() === 'SOL')) ?? []

  // A Review is bound to the direction and amount it shows; any edit drops it.
  useEffect(() => {
    setReviewing(false)
  }, [amount, direction])

  const notReady = !kitSupport.ready
    ? 'The bridge is unavailable right now.'
    : !evmConnected
      ? 'Connect your EVM wallet (Arc) in the top bar.'
      : !phantomConnected
        ? 'Connect Phantom (Solana) in the top bar.'
        : !globalWriteEnabled
          ? 'Solana transfers are temporarily unavailable.'
          : !routeWriteEnabled
            ? `${fromChain} → ${toChain} is not available right now.`
            : null

  const confirm = () => {
    setReviewing(false)
    void handleBridge().catch(() => undefined)
  }

  return (
    <section aria-label="Solana Mainnet bridge" className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm">
      <h2 className="text-xl font-semibold">Solana ↔ Arc</h2>
      <p className="mb-4 mt-1 text-xs leading-5 text-slate-500">
        Mainnet transfer with real USDC. Nothing is sent until you review it and confirm each step in your wallet.
      </p>

      <div className="space-y-4">
        <section aria-label="Solana transfer panel" data-phase={state.isLoading ? 'running' : reviewing ? 'review' : 'form'} className="flex flex-col gap-3 rounded-2xl border border-slate-200 p-4 text-sm">
          <Side
            label="From"
            chain={fromChain}
            wallet={direction === 'arc-to-solana' ? evmLabel : solanaLabel}
            balance={sourceBalance}
          />
          <div className="-my-1 flex justify-center">
            <button
              type="button"
              aria-label="Switch direction"
              disabled={state.isLoading}
              onClick={() => setDirection((d) => d === 'arc-to-solana' ? 'solana-to-arc' : 'arc-to-solana')}
              className="rounded-full border border-slate-200 bg-white p-2 text-slate-600 shadow-sm hover:text-[#2F6E0C] disabled:opacity-50"
            >
              <ArrowDownUp size={16} />
            </button>
          </div>
          <Side label="To" chain={toChain} wallet={direction === 'arc-to-solana' ? solanaLabel : evmLabel} />

          <label className="block text-sm font-medium">
            Amount
            <div className="mt-1 flex items-center gap-2 rounded-xl border border-slate-200 px-3">
              <input
                value={amount}
                onChange={(event) => setAmount(event.target.value)}
                inputMode="decimal"
                autoComplete="off"
                disabled={state.isLoading}
                placeholder="0.00"
                className="min-w-0 flex-1 bg-transparent py-3 text-lg outline-none"
                aria-label="Bridge amount"
              />
              <span className="text-sm text-slate-500">USDC</span>
            </div>
          </label>
          {amountError && <p role="alert" className="text-xs text-amber-800">{amountError}</p>}
          <p className="flex flex-wrap items-center gap-x-2 text-xs text-slate-500">
            <span>
              {sourceBalance != null ? `Balance: ${sourceBalance} USDC.` : sourceBalanceError ? `${fromChain} USDC balance could not be read.` : 'Balance not loaded yet.'} Real Mainnet USDC; every step is confirmed in your wallet.
            </span>
            <button
              type="button"
              onClick={() => {
                void refreshArcBalance().catch(() => undefined)
                void refreshSolanaBalance().catch(() => undefined)
                if (direction === 'solana-to-arc') {
                  void refreshRefunds()
                }
              }}
              disabled={!phantomConnected}
              className="inline-flex items-center gap-1 font-semibold text-slate-600 underline disabled:no-underline disabled:opacity-50"
            >
              <RefreshCw size={12} />
              Refresh
            </button>
          </p>

          <dl aria-label="Estimated cost" className="space-y-1 rounded-xl bg-slate-50 p-3 text-xs">
            <Line k="Circle fee" v={feeEstimate ? `${feeEstimate.bridgeFee} USDC` : isEstimatingFees ? 'Checking…' : '—'} />
            <Line k="Machina fee" v="0 USDC" />
            <Line k="You receive" v={feeEstimate ? `≈ ${feeEstimate.receiveAmount} USDC` : '—'} />
            {networkFees.map((fee, index) => (
              <Line
                key={`${fee.name}-${fee.token}-${index}`}
                k={fee.name?.toLowerCase() === 'mint' ? `${toChain} network fee` : fee.name || 'Network fee'}
                v={`${fee.amount ?? '—'} ${fee.token}${fee.name?.toLowerCase() === 'mint' ? ' · paid when you receive' : ''}`}
              />
            ))}
            {direction === 'solana-to-arc' && feeEstimate?.solanaEventRentSol && (
              <Line k="Solana network fee" v="~0.003–0.004 SOL · includes a refundable deposit" />
            )}
          </dl>
          {!feeEstimate && (
            <p className="text-xs text-slate-500">
              {feeEstimateError
                ? 'Fee estimate is temporarily unavailable.'
                : !evmConnected || !phantomConnected
                  ? 'Connect both wallets to see the current bridge and network fees.'
                  : !amountValid
                    ? 'Enter an amount to calculate the current bridge and network fees.'
                    : 'Calculating current bridge and network fees…'}
            </p>
          )}

          {direction === 'solana-to-arc' && feeEstimate?.solanaEventRentSol && (
            <details
              open={costDetailsOpen}
              onToggle={(event) => setCostDetailsOpen((event.target as HTMLDetailsElement).open)}
              className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-[11px] leading-5 text-slate-600"
            >
              <summary className="cursor-pointer font-semibold">Why does Solana require a deposit?</summary>
              <div className="mt-2 space-y-1.5">
                <Line k="Refundable Circle deposit" v={`${feeEstimate.solanaEventRentSol} SOL`} />
                <Line k="Solana network / priority fee" v="Variable" />
              </div>
              <p className="mt-2">
                Circle creates a temporary Solana account for each Solana → Arc transfer. The deposit funds that account and does not go to Machina.
              </p>
              {feeEstimate.solanaEventRentRefundableAfterDays && (
                <p className="mt-1.5">
                  After {feeEstimate.solanaEventRentRefundableAfterDays} days, the temporary account can be closed and its deposit returned to the same Phantom wallet.
                </p>
              )}
              <p className="mt-1.5">
                The final SOL amount shown by Phantom can be higher than this live estimate because Solana priority fees vary at signing time.
              </p>
            </details>
          )}

          {kitSupport.error && (
            <p role="alert" className="rounded-xl bg-amber-50 p-3 text-xs leading-5 text-amber-900">{kitSupport.error}</p>
          )}
          {state.error && (
            <p role="alert" className="rounded-xl bg-amber-50 p-3 text-xs leading-5 text-amber-900">{state.error}</p>
          )}
          {state.status && !state.error && (
            <p role="status" aria-live="polite" className="rounded-xl bg-sky-50 p-3 text-xs leading-5 text-sky-900">{state.status}</p>
          )}

          {transferResult?.sourceTxHash && transferResult?.destinationTxHash && (
            <div className="rounded-xl bg-emerald-50 p-3 text-xs text-emerald-900">
              <p className="font-semibold">
                {transferResult.direction === 'solana-to-arc' ? 'Solana → Arc transfer complete' : 'Arc → Solana transfer complete'}
              </p>
              <div className="mt-2 flex flex-wrap gap-x-4 gap-y-2">
                <a
                  href={transferResult.direction === 'solana-to-arc'
                    ? `${SOLANA_MAINNET_CCTP.explorerUrl}/tx/${transferResult.sourceTxHash}`
                    : `${MAINNET_NETWORKS.arc.explorerUrl}/tx/${transferResult.sourceTxHash}`}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1 underline underline-offset-2"
                >
                  Source transaction: {txMask(transferResult.sourceTxHash)}
                  <ExternalLink size={12} />
                </a>
                <a
                  href={transferResult.direction === 'solana-to-arc'
                    ? `${MAINNET_NETWORKS.arc.explorerUrl}/tx/${transferResult.destinationTxHash}`
                    : `${SOLANA_MAINNET_CCTP.explorerUrl}/tx/${transferResult.destinationTxHash}`}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1 underline underline-offset-2"
                >
                  Destination transaction: {txMask(transferResult.destinationTxHash)}
                  <ExternalLink size={12} />
                </a>
              </div>
            </div>
          )}

          {direction === 'arc-to-solana' && !state.isLoading && pendingArcToSolanaTx && (
            <div className="rounded-xl bg-amber-50 p-3 text-xs text-amber-900">
              <p className="font-semibold">Pending Arc → Solana transfer detected</p>
              <a
                href={`${MAINNET_NETWORKS.arc.explorerUrl}/tx/${pendingArcToSolanaTx}`}
                target="_blank"
                rel="noreferrer"
                className="mt-2 inline-flex items-center gap-1 underline underline-offset-2"
              >
                Source transaction: {pendingArcToSolanaTx.slice(0, 10)}...{pendingArcToSolanaTx.slice(-6)}
                <ExternalLink size={12} />
              </a>
              <button
                type="button"
                disabled={state.isLoading || !phantomConnected}
                onClick={() => void recoverPendingArcToSolana().catch(() => undefined)}
                className="mt-3 inline-flex w-full items-center justify-center rounded-xl border border-amber-300 bg-white px-4 py-3 text-sm font-semibold text-amber-900 disabled:cursor-not-allowed disabled:opacity-50"
              >
                Complete pending Arc → Solana transfer
              </button>
            </div>
          )}
          {direction === 'arc-to-solana' && !state.isLoading && !pendingArcToSolanaTx && pendingArcToSolanaError && (
            <p role="alert" className="rounded-xl bg-amber-50 p-3 text-xs leading-5 text-amber-900">
              {pendingArcToSolanaError}
            </p>
          )}

          <div className="mt-auto space-y-2">
            {notReady && <p className="rounded-xl bg-slate-50 p-3 text-xs text-slate-600">{notReady}</p>}
            {reviewing && canRun ? (
              <div aria-label="Review Solana transfer" className="space-y-3 rounded-xl border border-slate-200 p-3">
                <p className="font-semibold">Review {fromChain} → {toChain} · {normalizedAmount} USDC</p>
                <dl className="space-y-1 rounded-xl bg-slate-50 p-3 text-xs">
                  <Line k="From" v={`${fromChain} Mainnet · ${(direction === 'arc-to-solana' ? evmLabel : solanaLabel) ?? '—'}`} />
                  <Line k="To" v={`${toChain} Mainnet · ${(direction === 'arc-to-solana' ? solanaLabel : evmLabel) ?? '—'}`} />
                  <Line k="Amount" v={`${normalizedAmount} USDC`} />
                  <Line k="Circle fee" v={feeEstimate ? `${feeEstimate.bridgeFee} USDC` : 'checked again before signing'} />
                  <Line k="You receive" v={feeEstimate ? `≈ ${feeEstimate.receiveAmount} USDC` : 'checked again before signing'} />
                </dl>
                <p className="text-xs leading-5 text-slate-500">
                  Your wallets ask you to confirm each step: the transfer in your {fromChain} wallet, then the receive step in your {toChain} wallet.
                </p>
                <div className="flex flex-wrap items-center gap-3">
                  <button
                    type="button"
                    onClick={confirm}
                    className="inline-flex flex-1 items-center justify-center gap-2 rounded-xl bg-[#66D121] px-4 py-3 font-semibold text-slate-950"
                  >
                    <Wallet size={16} />
                    Confirm and start transfer
                  </button>
                  <button type="button" onClick={() => setReviewing(false)} className="text-xs font-semibold text-slate-500 underline">
                    Cancel
                  </button>
                </div>
              </div>
            ) : (
              <button
                type="button"
                disabled={!canRun}
                onClick={() => setReviewing(true)}
                className="inline-flex w-full items-center justify-center gap-2 rounded-xl bg-[#66D121] px-4 py-3 font-semibold text-slate-950 disabled:cursor-not-allowed disabled:bg-slate-200 disabled:text-slate-500"
              >
                {state.isLoading ? <Loader2 size={16} className="animate-spin" aria-hidden /> : !canRun && <LockKeyhole size={16} />}
                {state.isLoading
                  ? 'Transfer in progress…'
                  : !globalWriteEnabled
                    ? 'Solana transfers locked'
                    : !amountValid && !notReady
                      ? 'Enter a valid amount'
                      : 'Review transfer'}
              </button>
            )}
          </div>
        </section>

        {direction === 'solana-to-arc' && phantomConnected && (
          <details
            open={refundPanelOpen}
            onToggle={(event) => setRefundPanelOpen((event.target as HTMLDetailsElement).open)}
            className="rounded-2xl border border-slate-200 p-4 text-sm"
          >
            <summary className="cursor-pointer font-semibold">
              Refundable SOL deposits
              <span className="ml-2 text-xs font-normal text-slate-500">
                {refundsLoading
                  ? 'Checking this Phantom wallet…'
                  : refunds.length > 0
                    ? `${refunds.length} open deposit${refunds.length === 1 ? '' : 's'} found`
                    : 'Circle deposits from Solana → Arc transfers'}
              </span>
            </summary>
            <div className="mt-2 flex items-start justify-between gap-3">
              <p className="max-w-md text-xs leading-5 text-slate-500">
                Circle temporarily locks SOL for each Solana → Arc transfer. After the waiting period, return the eligible deposit to this same Phantom wallet.
              </p>
              <button
                type="button"
                onClick={() => void refreshRefunds()}
                disabled={refundsLoading}
                className="inline-flex flex-shrink-0 items-center gap-1 rounded-lg border border-slate-300 px-3 py-2 text-xs font-semibold disabled:opacity-50"
              >
                <RefreshCw size={12} className={refundsLoading ? 'animate-spin' : ''} />
                Refresh
              </button>
            </div>

            {refundsLoading && refunds.length === 0 ? (
              <p className="mt-3 text-xs text-slate-500">Checking refundable deposits…</p>
            ) : refundsError && refunds.length === 0 ? null : refunds.length === 0 ? (
              <p className="mt-3 text-xs text-slate-500">No open refundable Circle deposit was found for this Phantom wallet.</p>
            ) : (
              <ul className="mt-2 divide-y divide-slate-100">
                {refunds.map((refund) => {
                  const eligible = Date.now() >= refund.refundAvailableAt
                  const reclaiming = reclaimingRefund === refund.messageSentEventAccount
                  return (
                    <li key={refund.messageSentEventAccount} className="space-y-1 py-3 text-xs">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <span className="font-semibold">{refund.refundableDepositSol} SOL refundable</span>
                        <button
                          type="button"
                          disabled={!eligible || reclaiming}
                          onClick={() => void handleReclaim(refund)}
                          className="inline-flex items-center gap-1 rounded-lg bg-slate-900 px-3 py-2 font-semibold text-white disabled:cursor-not-allowed disabled:bg-slate-200 disabled:text-slate-500"
                        >
                          <RotateCcw size={12} />
                          {reclaiming ? 'Returning SOL…' : eligible ? `Return ${refund.refundableDepositSol} SOL` : refundTiming(refund.refundAvailableAt)}
                        </button>
                      </div>
                      <p className="text-slate-500">{refundTiming(refund.refundAvailableAt)}</p>
                      <a
                        href={`${SOLANA_MAINNET_CCTP.explorerUrl}/tx/${refund.sourceTxHash}`}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex items-center gap-1 underline"
                      >
                        Source transaction: {txMask(refund.sourceTxHash)}
                        <ExternalLink size={11} />
                      </a>
                    </li>
                  )
                })}
              </ul>
            )}

            {refundsError && (
              <p role="alert" className="mt-3 rounded-xl bg-amber-50 p-3 text-xs leading-5 text-amber-900" title={refundsError}>
                Refundable deposit check is temporarily unavailable. Please try Refresh again.
              </p>
            )}
            {reclaimError && (
              <p role="alert" className="mt-3 rounded-xl bg-red-50 p-3 text-xs leading-5 text-red-700">{reclaimError}</p>
            )}
            {reclaimSuccessTx && (
              <p className="mt-3 rounded-xl bg-emerald-50 p-3 text-xs leading-5 text-emerald-800">
                {reclaimSuccessTx === 'already-closed'
                  ? 'This Circle deposit was already returned or closed.'
                  : 'SOL deposit returned successfully.'}
              </p>
            )}
          </details>
        )}

        {direction === 'arc-to-solana' && (
          <details className="rounded-2xl border border-slate-200 p-4 text-sm">
            <summary className="cursor-pointer font-semibold">Recover an older Arc → Solana transfer</summary>
            <p className="mt-2 text-xs leading-5 text-slate-500">
              The automatic check covers only the latest 4,000 Arc blocks. For an older burn, enter its source hash. Connect the original EVM and Phantom wallets. This never burns USDC again; recovery checks the existing message before requesting a destination mint.
            </p>
            <div className="mt-3 grid gap-2 sm:grid-cols-[1fr_auto]">
              <input
                aria-label="Arc to Solana recovery source hash"
                className="min-w-0 rounded-lg border border-slate-200 p-2 font-mono text-xs"
                placeholder="0x…"
                autoComplete="off"
                spellCheck={false}
                value={recoveryHash}
                onChange={(e) => setRecoveryHash(e.target.value)}
                disabled={state.isLoading}
              />
              <button
                type="button"
                className="rounded-lg border border-slate-300 px-3 py-2 text-xs font-semibold disabled:text-slate-400"
                disabled={state.isLoading || !evmConnected || !phantomConnected || !/^0x[0-9a-f]{64}$/i.test(recoveryHash.trim())}
                onClick={() => void recoverPendingArcToSolana(recoveryHash.trim() as `0x${string}`).catch(() => undefined)}
              >
                Recover existing burn
              </button>
            </div>
            <p className="mt-2 text-xs text-slate-500">If the burn is eligible, you confirm the receive step in Phantom.</p>
          </details>
        )}
      </div>
    </section>
  )
}

function Side({ label, chain, wallet, balance }: { label: string; chain: string; wallet: string | null; balance?: string | null }) {
  return (
    <div className="rounded-2xl border border-slate-200 p-3 text-sm">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs text-slate-500">{label}</span>
        {balance != null && <span className="text-xs text-slate-500">{balance} USDC</span>}
      </div>
      <p className="mt-1 font-semibold">{chain} Mainnet</p>
      <p className="truncate text-xs text-slate-600">{wallet ?? 'Not connected · use the top bar'}</p>
    </div>
  )
}

function Line({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex flex-wrap justify-between gap-x-3">
      <dt className="text-slate-500">{k}</dt>
      <dd className="text-right font-medium">{v}</dd>
    </div>
  )
}
