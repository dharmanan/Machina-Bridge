import { useEffect, useState } from 'react'
import { Wallet, RefreshCw, LockKeyhole } from 'lucide-react'
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

function mask(address?: string | null) {
  if (!address) return 'Not connected'
  return `${address.slice(0, 6)}...${address.slice(-4)}`
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
    solanaBalance,
    solanaBalanceError,
    refreshSolanaBalance,
    runCanary,
  } = useMainnetSolanaCctp(provider, phantomAddress)

  const [direction, setDirection] =
    useState<MainnetSolanaCanaryDirection>('arc-to-solana')
  const [amount, setAmount] = useState('0.1')

  useEffect(() => {
    if (phantomAddress) {
      void refreshSolanaBalance().catch(() => undefined)
    }
  }, [phantomAddress, refreshSolanaBalance])

  const phase = MAINNET_SOLANA_CCTP_CANARY_ROUTES[direction]
  const routeWriteEnabled = phase === 'testing' || phase === 'verified'
  const globalWriteEnabled = MAINNET_SOLANA_CCTP_CANARY_ENABLED
  const maxAmount = formatUnits(MAINNET_SOLANA_CCTP_CANARY_MAX_AMOUNT_RAW, 6)
  const amountValid =
    Number.isFinite(Number(amount))
    && Number(amount) > 0
    && Number(amount) <= Number(maxAmount)

  const canRun =
    kitSupport.ready
    && evmConnected
    && phantomConnected
    && globalWriteEnabled
    && routeWriteEnabled
    && amountValid
    && !state.isLoading

  const actionLabel = !kitSupport.ready
    ? 'Bridge Kit not ready'
    : !evmConnected
      ? 'Connect EVM wallet'
      : !phantomConnected
        ? 'Connect Phantom'
        : !globalWriteEnabled
          ? 'Solana canary globally locked'
          : !routeWriteEnabled
            ? `${direction} is read-only`
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
            Solana Mainnet Canary
          </h3>
          <p className="mt-1 text-sm leading-6 text-slate-500">
            Separate Arc ↔ Solana CCTP path. Maximum {maxAmount} USDC.
          </p>
        </div>
        <span className="rounded-full border border-slate-200 bg-slate-50 px-2.5 py-1 text-xs font-semibold text-slate-600">
          {phase}
        </span>
      </div>

      <div className="mt-5 grid gap-3 sm:grid-cols-2">
        <div className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3">
          <p className="text-xs font-medium text-slate-500">EVM / Arc wallet</p>
          <p className="mt-1 text-sm font-semibold text-slate-800">
            {mask(evmAddress)}
          </p>
        </div>

        <div className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3">
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="text-xs font-medium text-slate-500">Phantom / Solana</p>
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
              Solana production RPC is unavailable. Configure the server-only SOLANA_MAINNET_RPC environment variable.
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
            onClick={() => void refreshSolanaBalance().catch(() => undefined)}
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
          aria-label="Solana canary amount"
        />

        <div className="mt-3 grid gap-2 text-xs text-slate-600 sm:grid-cols-2">
          <p>Bridge Kit: {kitSupport.ready ? 'ready' : 'blocked'}</p>
          <p>Global write: {globalWriteEnabled ? 'enabled' : 'locked'}</p>
          <p>Route phase: {phase}</p>
          <p>Phantom: {phantomConnected ? 'connected' : 'not connected'}</p>
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

        <button
          type="button"
          disabled={!canRun}
          onClick={() => void runCanary(direction, amount)}
          className="mt-4 inline-flex h-11 w-full items-center justify-center gap-2 rounded-2xl bg-[#66D121] px-4 text-sm font-semibold text-slate-950 disabled:cursor-not-allowed disabled:bg-[#9fbd90] disabled:text-white"
        >
          {canRun ? <Wallet size={16} /> : <LockKeyhole size={16} />}
          {actionLabel}
        </button>
      </div>
    </div>
  )
}
