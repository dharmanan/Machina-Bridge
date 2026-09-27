import { useEffect, useState } from 'react'
import { Wallet, RefreshCw, LockKeyhole, ExternalLink, ChevronDown } from 'lucide-react'
import { useAccount } from 'wagmi'
import { usePhantomSolana } from '../hooks/usePhantomSolana'
import { useMainnetSolanaCctp } from '../hooks/useMainnetSolanaCctp'
import {
  MAINNET_SOLANA_CCTP_CANARY_MAX_AMOUNT_RAW,
  MAINNET_SOLANA_CCTP_CANARY_ROUTES,
  type MainnetSolanaCanaryDirection,
} from '../config/mainnetSolanaCanary'
import { MAINNET_SOLANA_CCTP_CANARY_ENABLED } from '../config/runtime'
import { formatUnits } from 'viem'
import { MAINNET_NETWORKS } from '../config/mainnetNetworks'
import { SOLANA_MAINNET_CCTP } from '../config/mainnetSolana'
import { recordMainnetSolanaActivity } from '../lib/mainnetSolanaActivity'

function mask(address?: string | null) {
  if (!address) return 'Not connected'
  return `${address.slice(0, 6)}...${address.slice(-4)}`
}

function txMask(hash?: string | null) {
  if (!hash) return '—'
  return `${hash.slice(0, 8)}...${hash.slice(-6)}`
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
  const [amount, setAmount] = useState('0.1')
  const [costDetailsOpen, setCostDetailsOpen] = useState(false)

  const transferResult =
    state.result && typeof state.result === 'object'
      ? state.result as {
          sourceTxHash?: string
          destinationTxHash?: string
          recovered?: boolean
          direction?: MainnetSolanaCanaryDirection
        }
      : null

  const maxAmount = formatUnits(MAINNET_SOLANA_CCTP_CANARY_MAX_AMOUNT_RAW, 6)
  const amountValid =
    Number.isFinite(Number(amount))
    && Number(amount) > 0
    && Number(amount) <= Number(maxAmount)

  useEffect(() => {
    if (evmAddress) {
      void refreshArcBalance().catch(() => undefined)
    }
    if (phantomAddress) {
      void refreshSolanaBalance().catch(() => undefined)
    }
  }, [evmAddress, phantomAddress, refreshArcBalance, refreshSolanaBalance])

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

    recordMainnetSolanaActivity({
      evmWallet: evmAddress,
      solanaWallet: phantomAddress,
      direction,
      amount,
      sourceTxHash: result.sourceTxHash,
      destinationTxHash: result.destinationTxHash,
      refundableDepositSol,
      refundAvailableAt,
    })
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
              ? `Maximum ${maxAmount} USDC`
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
            Bridge USDC between Arc and Solana. Maximum {maxAmount} USDC per transfer.
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

        <div className="mt-3 flex items-center justify-between gap-3 text-xs text-slate-500">
          <span>Amount</span>
          <span>Max {maxAmount} USDC</span>
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
                        ? 'Arc receive gas'
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
                : 'Connect both wallets to see the current bridge and network fees.'}
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
