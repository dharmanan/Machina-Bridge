import { useCallback, useEffect, useState } from 'react'
import { Wallet, RefreshCw, RotateCcw, LockKeyhole, ExternalLink, ChevronDown } from 'lucide-react'
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
  const { address: evmAddress, isConnected: evmConnected } = useAccount()
  const {
    address: phantomAddress,
    connect,
    disconnect,
    isConnected: phantomConnected,
    isConnecting,
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
  const [costDetailsOpen, setCostDetailsOpen] = useState(false)
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

  const amountValid =
    Number.isFinite(Number(amount))
    && Number(amount) > 0

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
      void estimateCanary(direction, amount).catch(() => undefined)
    }, 450)

    return () => window.clearTimeout(timer)
  }, [
    amount,
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

  const handleBridge = async () => {
    const result = await runCanary(direction, amount) as {
      sourceTxHash?: string
      destinationTxHash?: string
    } | null

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
      amount,
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

  const actionLabel = !kitSupport.ready
    ? 'Bridge unavailable'
    : !evmConnected
      ? 'Connect EVM wallet'
      : !phantomConnected
        ? 'Connect Phantom'
        : !globalWriteEnabled
          ? 'Transfers temporarily unavailable'
          : !routeWriteEnabled
            ? 'Route unavailable'
            : !amountValid
              ? 'Enter a valid amount'
              : state.isLoading
                ? 'Transfer in progress...'
                : direction === 'arc-to-solana'
                  ? `Bridge ${amount} USDC Arc → Solana`
                  : `Bridge ${amount} USDC Solana → Arc`

  return (
    <div className="mt-5 rounded-3xl border border-slate-200 bg-white p-6 shadow-[0_16px_45px_rgba(15,23,42,0.06)]">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h3 className="text-lg font-semibold text-slate-900">
            Solana Bridge
          </h3>
          <p className="mt-1 text-sm leading-6 text-slate-500">
            Bridge USDC between Arc and Solana.
          </p>
        </div>
        <span className="rounded-full border border-[#66D121]/30 bg-[#eef7e8] px-2.5 py-1 text-xs font-semibold text-[#2F6E0C]">
          {phase === 'verified' ? 'Verified' : 'Limited'}
        </span>
      </div>

      <div className="mt-5 grid gap-3 sm:grid-cols-2">
        <div className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3">
          <p className="text-xs font-medium text-slate-500">Arc wallet</p>
          <p className="mt-1 text-sm font-semibold text-slate-800">
            {mask(evmAddress)}
          </p>
          <p className="mt-2 text-xs text-slate-500">
            USDC: {arcBalance ?? '—'}
          </p>
          {arcBalanceError && (
            <p className="mt-2 text-[11px] leading-4 text-amber-700">
              Arc mainnet USDC balance could not be read.
            </p>
          )}
        </div>

        <div className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3">
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="text-xs font-medium text-slate-500">Solana wallet</p>
              <p className="mt-1 text-sm font-semibold text-slate-800">
                {mask(phantomAddress)}
              </p>
            </div>
            <button
              type="button"
              onClick={() => void (phantomConnected ? disconnect() : connect())}
              disabled={isConnecting}
              className="rounded-xl border border-slate-200 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 disabled:opacity-50"
            >
              {phantomConnected ? 'Disconnect' : isConnecting ? 'Connecting...' : 'Connect'}
            </button>
          </div>
          <p className="mt-2 text-xs text-slate-500">
            USDC: {solanaBalance ?? '—'}
          </p>
          {solanaBalanceError && (
            <p className="mt-2 text-[11px] leading-4 text-amber-700">
              Solana mainnet USDC balance could not be read.
            </p>
          )}
        </div>
      </div>

      <div className="mt-4 rounded-2xl border border-slate-200 bg-slate-50 p-4">
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => setDirection('arc-to-solana')}
            className={`rounded-xl px-3 py-2 text-xs font-semibold ${
              direction === 'arc-to-solana'
                ? 'bg-slate-900 text-white'
                : 'border border-slate-200 bg-white text-slate-700'
            }`}
          >
            Arc → Solana
          </button>
          <button
            type="button"
            onClick={() => setDirection('solana-to-arc')}
            className={`rounded-xl px-3 py-2 text-xs font-semibold ${
              direction === 'solana-to-arc'
                ? 'bg-slate-900 text-white'
                : 'border border-slate-200 bg-white text-slate-700'
            }`}
          >
            Solana → Arc
          </button>

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
            className="ml-auto inline-flex items-center gap-1 rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs font-semibold text-slate-700 disabled:opacity-50"
          >
            <RefreshCw size={13} />
            Refresh
          </button>
        </div>

        <input
          value={amount}
          onChange={(event) => setAmount(event.target.value)}
          inputMode="decimal"
          className="mt-4 h-11 w-full rounded-xl border border-slate-200 bg-white px-3 text-sm outline-none focus:border-slate-400"
          aria-label="Bridge amount"
        />

        <div className="mt-3 text-xs text-slate-500">
          Amount
        </div>

        <div className="mt-3 rounded-2xl border border-slate-200 bg-white p-3.5">
          <div className="flex items-center justify-between gap-3">
            <p className="text-sm font-semibold text-slate-900">Estimated cost</p>
            <span className="text-[11px] font-medium text-slate-400">
              {isEstimatingFees ? 'Updating...' : 'Live estimate'}
            </span>
          </div>

          {feeEstimate ? (
            <div className="mt-3 space-y-2 text-xs">
              <div className="flex items-center justify-between gap-3">
                <span className="text-slate-500">Bridge fee</span>
                <span className="font-semibold text-slate-800">
                  {feeEstimate.bridgeFee} USDC
                </span>
              </div>
              <div className="flex items-center justify-between gap-3">
                <span className="text-slate-500">Machina fee</span>
                <span className="font-semibold text-emerald-700">0 USDC</span>
              </div>

              {direction === 'solana-to-arc' && feeEstimate.solanaEventRentSol && (
                <>
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-slate-500">Expected Phantom debit</span>
                    <span className="font-semibold text-slate-800">
                      ~0.003–0.004 SOL
                    </span>
                  </div>

                  <button
                    type="button"
                    onClick={() => setCostDetailsOpen((open) => !open)}
                    className="flex w-full items-center justify-between gap-3 rounded-xl bg-slate-50 px-3 py-2.5 text-left text-[11px] font-semibold text-slate-600 transition-colors hover:bg-slate-100"
                  >
                    <span>Why does Solana require this?</span>
                    <ChevronDown
                      size={15}
                      className={`transition-transform ${costDetailsOpen ? 'rotate-180' : ''}`}
                    />
                  </button>

                  {costDetailsOpen && (
                    <div className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-3 text-[11px] leading-5 text-slate-600">
                      <div className="space-y-1.5">
                        <div className="flex items-center justify-between gap-3">
                          <span>Refundable Circle deposit</span>
                          <span className="font-semibold text-slate-800">
                            {feeEstimate.solanaEventRentSol} SOL
                          </span>
                        </div>
                        <div className="flex items-center justify-between gap-3">
                          <span>Solana network / priority fee</span>
                          <span className="font-semibold text-slate-800">
                            Variable
                          </span>
                        </div>
                      </div>

                      <p className="mt-3">
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
                    </div>
                  )}
                </>
              )}

              {feeEstimate.gasFees
                .filter((fee) => !(direction === 'solana-to-arc' && fee.token.toUpperCase() === 'SOL'))
                .map((fee, index) => (
                  <div
                    key={`${fee.name}-${fee.token}-${index}`}
                    className="flex items-center justify-between gap-3"
                  >
                    <span className="text-slate-500">
                      {fee.name?.toLowerCase() === 'mint'
                        ? direction === 'solana-to-arc'
                          ? 'Arc receive gas'
                          : 'Solana receive gas'
                        : fee.name || 'Network fee'}
                    </span>
                    <span className="font-semibold text-slate-800">
                      {fee.amount ?? '—'} {fee.token}
                    </span>
                  </div>
                ))}

              <div className="border-t border-slate-200 pt-2">
                <div className="flex items-center justify-between gap-3">
                  <span className="text-slate-600">Estimated received</span>
                  <span className="font-semibold text-slate-900">
                    {feeEstimate.receiveAmount} USDC
                  </span>
                </div>
              </div>
            </div>
          ) : (
            <p className="mt-2 text-xs leading-5 text-slate-500">
              {feeEstimateError
                ? 'Fee estimate is temporarily unavailable.'
                : !evmConnected || !phantomConnected
                  ? 'Connect both wallets to see the current bridge and network fees.'
                  : !amountValid
                    ? 'Enter an amount to calculate the current bridge and network fees.'
                    : 'Calculating current bridge and network fees...'}
            </p>
          )}
        </div>

        {kitSupport.error && (
          <p className="mt-3 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
            {kitSupport.error}
          </p>
        )}

        {state.error && (
          <p className="mt-3 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
            {state.error}
          </p>
        )}

        {state.status && !state.error && (
          <p className="mt-3 rounded-xl border border-sky-200 bg-sky-50 px-3 py-2 text-xs text-sky-800">
            {state.status}
          </p>
        )}

        {transferResult?.sourceTxHash && transferResult?.destinationTxHash && (
          <div className="mt-4 rounded-2xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-xs text-emerald-900">
            <p className="font-semibold">
              {transferResult.direction === 'solana-to-arc'
                ? 'Solana → Arc transfer complete'
                : 'Arc → Solana transfer complete'}
            </p>
            <div className="mt-2 flex flex-wrap gap-x-4 gap-y-2">
              <a
                href={
                  transferResult.direction === 'solana-to-arc'
                    ? `${SOLANA_MAINNET_CCTP.explorerUrl}/tx/${transferResult.sourceTxHash}`
                    : `${MAINNET_NETWORKS.arc.explorerUrl}/tx/${transferResult.sourceTxHash}`
                }
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 underline underline-offset-2"
              >
                Source tx: {txMask(transferResult.sourceTxHash)}
                <ExternalLink size={12} />
              </a>
              <a
                href={
                  transferResult.direction === 'solana-to-arc'
                    ? `${MAINNET_NETWORKS.arc.explorerUrl}/tx/${transferResult.destinationTxHash}`
                    : `${SOLANA_MAINNET_CCTP.explorerUrl}/tx/${transferResult.destinationTxHash}`
                }
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 underline underline-offset-2"
              >
                Destination tx: {txMask(transferResult.destinationTxHash)}
                <ExternalLink size={12} />
              </a>
            </div>
          </div>
        )}

        {direction === 'solana-to-arc' && phantomConnected && (
          <div className="mt-4 overflow-hidden rounded-2xl border border-slate-200 bg-white">
            <button
              type="button"
              onClick={() => setRefundPanelOpen((open) => !open)}
              className="flex w-full items-center justify-between gap-4 px-4 py-3.5 text-left transition-colors hover:bg-slate-50"
              aria-expanded={refundPanelOpen}
            >
              <div className="min-w-0">
                <p className="text-sm font-semibold text-slate-900">Refundable SOL deposits</p>
                <p className="mt-0.5 text-[11px] leading-5 text-slate-500">
                  {refundsLoading
                    ? 'Checking this Phantom wallet...'
                    : refunds.length > 0
                      ? `${refunds.length} open deposit${refunds.length === 1 ? '' : 's'} found`
                      : 'Circle deposits from Solana → Arc transfers'}
                </p>
              </div>
              <ChevronDown
                size={17}
                className={`flex-shrink-0 text-slate-400 transition-transform ${refundPanelOpen ? 'rotate-180' : ''}`}
              />
            </button>

            {refundPanelOpen && (
              <div className="border-t border-slate-100 px-4 pb-4 pt-3">
                <div className="flex items-start justify-between gap-3">
                  <p className="max-w-md text-[11px] leading-5 text-slate-500">
                    Circle temporarily locks SOL for each Solana → Arc transfer. After the waiting period, return the eligible deposit to this same Phantom wallet.
                  </p>
                  <button
                    type="button"
                    onClick={() => void refreshRefunds()}
                    disabled={refundsLoading}
                    className="inline-flex flex-shrink-0 items-center gap-1 rounded-xl border border-slate-200 bg-white px-3 py-2 text-[11px] font-semibold text-slate-600 disabled:opacity-50"
                  >
                    <RefreshCw size={12} className={refundsLoading ? 'animate-spin' : ''} />
                    Refresh
                  </button>
                </div>

                {refundsLoading && refunds.length === 0 ? (
                  <p className="mt-3 text-xs text-slate-500">
                    Checking refundable deposits...
                  </p>
                ) : refundsError && refunds.length === 0 ? null : refunds.length === 0 ? (
                  <p className="mt-3 rounded-xl bg-slate-50 px-3 py-3 text-xs leading-5 text-slate-500">
                    No open refundable Circle deposit was found for this Phantom wallet.
                  </p>
                ) : (
                  <div className="mt-3 space-y-3">
                    {refunds.map((refund) => {
                      const eligible = Date.now() >= refund.refundAvailableAt
                      const reclaiming =
                        reclaimingRefund === refund.messageSentEventAccount

                      return (
                        <div
                          key={refund.messageSentEventAccount}
                          className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-3"
                        >
                          <div className="flex flex-wrap items-center justify-between gap-3">
                            <div>
                              <p className="text-sm font-semibold text-slate-900">
                                {refund.refundableDepositSol} SOL refundable
                              </p>
                              <p className="mt-1 text-[11px] text-slate-500">
                                {refundTiming(refund.refundAvailableAt)}
                              </p>
                            </div>

                            <button
                              type="button"
                              disabled={!eligible || reclaiming}
                              onClick={() => void handleReclaim(refund)}
                              className="inline-flex h-10 items-center justify-center gap-2 rounded-xl bg-slate-900 px-4 text-xs font-semibold text-white disabled:cursor-not-allowed disabled:bg-slate-200 disabled:text-slate-500"
                            >
                              <RotateCcw size={13} />
                              {reclaiming
                                ? 'Returning SOL...'
                                : eligible
                                  ? `Return ${refund.refundableDepositSol} SOL`
                                  : refundTiming(refund.refundAvailableAt)}
                            </button>
                          </div>

                          <a
                            href={`${SOLANA_MAINNET_CCTP.explorerUrl}/tx/${refund.sourceTxHash}`}
                            target="_blank"
                            rel="noreferrer"
                            className="mt-2 inline-flex items-center gap-1 text-[11px] font-medium text-slate-600 hover:text-slate-900 hover:underline"
                          >
                            Source transaction: {txMask(refund.sourceTxHash)}
                            <ExternalLink size={11} />
                          </a>
                        </div>
                      )
                    })}
                  </div>
                )}

                {refundsError && (
                  <p
                    className="mt-3 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-[11px] leading-5 text-amber-800"
                    title={refundsError}
                  >
                    Refundable deposit check is temporarily unavailable. Please try Refresh again.
                  </p>
                )}

                {reclaimError && (
                  <p className="mt-3 rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-[11px] leading-5 text-red-700">
                    {reclaimError}
                  </p>
                )}

                {reclaimSuccessTx && (
                  <p className="mt-3 rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-2 text-[11px] leading-5 text-emerald-800">
                    {reclaimSuccessTx === 'already-closed'
                      ? 'This Circle deposit was already returned or closed.'
                      : 'SOL deposit returned successfully.'}
                  </p>
                )}
              </div>
            )}
          </div>
        )}

        {direction === 'arc-to-solana' && !state.isLoading && pendingArcToSolanaTx && (
          <div className="mt-4 rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-xs text-amber-900">
            <p className="font-semibold">Pending Arc → Solana transfer detected</p>
            <a
              href={`${MAINNET_NETWORKS.arc.explorerUrl}/tx/${pendingArcToSolanaTx}`}
              target="_blank"
              rel="noreferrer"
              className="mt-2 inline-flex items-center gap-1 underline underline-offset-2"
            >
              Source tx: {pendingArcToSolanaTx.slice(0, 10)}...{pendingArcToSolanaTx.slice(-6)}
              <ExternalLink size={12} />
            </a>
            <button
              type="button"
              disabled={state.isLoading || !phantomConnected}
              onClick={() => void recoverPendingArcToSolana().catch(() => undefined)}
              className="mt-3 inline-flex h-11 w-full items-center justify-center rounded-2xl border border-amber-300 bg-white px-4 text-sm font-semibold text-amber-900 disabled:cursor-not-allowed disabled:opacity-50"
            >
              Complete pending Arc → Solana transfer
            </button>
          </div>
        )}

        {direction === 'arc-to-solana' && !state.isLoading && !pendingArcToSolanaTx && pendingArcToSolanaError && (
          <p className="mt-3 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
            Pending transfer check failed: {pendingArcToSolanaError}
          </p>
        )}

        <button
          type="button"
          disabled={!canRun}
          onClick={() => void handleBridge().catch(() => undefined)}
          className="mt-4 inline-flex h-11 w-full items-center justify-center gap-2 rounded-2xl bg-[#66D121] px-4 text-sm font-semibold text-slate-950 disabled:cursor-not-allowed disabled:bg-[#9fbd90] disabled:text-white"
        >
          {canRun ? <Wallet size={16} /> : <LockKeyhole size={16} />}
          {actionLabel}
        </button>
      </div>
    </div>
  )
}
