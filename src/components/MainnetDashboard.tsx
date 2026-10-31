import { MainnetTransferRecovery } from './MainnetTransferRecovery'
import BridgeHistoryList from './BridgeHistoryList'
import { useEffect, useState } from 'react'
import { createPublicClient, formatUnits, http, parseAbi } from 'viem'
import {
  AlertCircle,
  ExternalLink,
  RefreshCw,
  RotateCcw,
  TrendingUp,
  Wallet,
} from 'lucide-react'
import { useAccount } from 'wagmi'
import { MAINNET_NETWORKS } from '../config/mainnetNetworks'
import { SOLANA_MAINNET_CCTP } from '../config/mainnetSolana'
import { usePhantomSolana } from '../hooks/usePhantomSolana'
import { useMainnetTransferQueue } from '../hooks/useMainnetTransferQueue'
import { useMainnetSolanaActivity } from '../hooks/useMainnetSolanaActivity'
import { useSuiWallet } from '../hooks/useSuiWallet'
import { useBridgeHistory } from '../hooks/useBridgeHistory'
import {
  updateMainnetSolanaActivity,
  type MainnetSolanaActivityRecord,
} from '../lib/mainnetSolanaActivity'
import {
  loadMainnetSolanaRefundMetadata,
  reclaimMainnetSolanaDeposit,
  type MainnetSolanaRefundMetadata,
} from '../lib/mainnetSolanaReclaim'
import { deriveSolanaUsdcAta } from '../lib/solana'
import { Card, Container } from './ui'

const ERC20_BALANCE_ABI = parseAbi([
  'function balanceOf(address account) view returns (uint256)',
])

type BalanceState = {
  value: string | null
  loading: boolean
  error: string | null
}

const EMPTY_BALANCE: BalanceState = {
  value: null,
  loading: false,
  error: null,
}

function mask(value?: string | null) {
  if (!value) return 'Not connected'
  return `${value.slice(0, 8)}...${value.slice(-6)}`
}

function timeUntil(timestamp: number) {
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

function WalletCard({ name, purpose, address, state }: { name: string; purpose: string; address?: string | null; state: { label: string; tone: 'ok' | 'warn' | 'off' } }) {
  const tone = state.tone === 'ok' ? 'bg-[#eef7e8] text-[#2F6E0C]' : state.tone === 'warn' ? 'bg-amber-100 text-amber-700' : 'bg-slate-100 text-slate-500'
  return (
    <div aria-label={`${name} connection`} className="rounded-xl border border-slate-200 bg-[#f8faf7] p-4">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="font-semibold">{name}</p>
          <p className="text-sm text-slate-500">{purpose}</p>
        </div>
        <span className={`shrink-0 rounded-full px-2.5 py-1 text-xs font-medium ${tone}`}>{state.label}</span>
      </div>
      <p className="mt-3 font-mono text-sm">{address ? mask(address) : 'Connect in the top bar'}</p>
    </div>
  )
}

function BalanceValue({ balance, idle }: { balance: BalanceState; idle?: string | null }) {
  // A balance that is not loaded yet or failed to load is never shown as 0.
  if (idle) return <span className="text-sm text-slate-400">{idle}</span>
  if (balance.loading && balance.value === null) return <span className="text-sm text-slate-400">Loading...</span>
  if (balance.error) {
    return (
      <span className="inline-flex items-center gap-1 text-xs text-amber-700" title={balance.error}>
        <AlertCircle size={13} />
        Unavailable
      </span>
    )
  }
  return <span className="text-lg font-semibold">{balance.value ?? '—'} USDC</span>
}

export default function MainnetDashboard() {
  const { address, isConnected } = useAccount()
  const {
    address: phantomAddress,
    isConnected: phantomConnected,
    isPhantomInstalled,
    provider: phantomProvider,
  } = usePhantomSolana()
  // Keeps the EVM transfer records progressing exactly as before; the list below reads them.
  useMainnetTransferQueue(address)
  const { records: solanaActivity } = useMainnetSolanaActivity(address, phantomAddress)
  const sui = useSuiWallet('mainnet')
  const { items: bridgeHistory, stats: routeStats } = useBridgeHistory({ evm: address, solana: phantomAddress, sui: sui.address })
  const suiBalance: BalanceState = {
    value: sui.usdcBalance,
    loading: sui.isLoadingBalance,
    error: sui.address && sui.walletSupportsNetwork ? sui.balanceError : null,
  }
  const anyWallet = Boolean(isConnected || phantomAddress || sui.address)

  const [balances, setBalances] = useState<Record<string, BalanceState>>(() =>
    Object.fromEntries(
      Object.keys(MAINNET_NETWORKS).map((key) => [key, { ...EMPTY_BALANCE }]),
    ),
  )
  const [solanaBalance, setSolanaBalance] = useState<BalanceState>({ ...EMPTY_BALANCE })
  const [refundActions, setRefundActions] = useState<Record<string, {
    loading: boolean
    error: string | null
  }>>({})
  const [, setRefundClock] = useState(() => Date.now())
  const loadEvmBalance = async (key: keyof typeof MAINNET_NETWORKS) => {
    if (!address) return

    const network = MAINNET_NETWORKS[key]
    setBalances((current) => ({
      ...current,
      [key]: { ...current[key], loading: true, error: null },
    }))

    try {
      const client = createPublicClient({
        transport: http(network.rpcUrls[0], {
          timeout: 10_000,
          retryCount: 0,
        }),
      })

      const raw = await client.readContract({
        address: network.usdcAddress,
        abi: ERC20_BALANCE_ABI,
        functionName: 'balanceOf',
        args: [address],
      })

      setBalances((current) => ({
        ...current,
        [key]: {
          value: formatUnits(raw, 6),
          loading: false,
          error: null,
        },
      }))
    } catch (error) {
      setBalances((current) => ({
        ...current,
        [key]: {
          value: null,
          loading: false,
          error: error instanceof Error ? error.message : 'Balance unavailable',
        },
      }))
    }
  }

  const loadAllEvmBalances = async () => {
    if (!address) return
    await Promise.allSettled(
      (Object.keys(MAINNET_NETWORKS) as Array<keyof typeof MAINNET_NETWORKS>)
        .map((key) => loadEvmBalance(key)),
    )
  }

  const loadSolanaBalance = async () => {
    if (!phantomAddress) {
      setSolanaBalance({ ...EMPTY_BALANCE })
      return
    }

    setSolanaBalance((current) => ({ ...current, loading: true, error: null }))

    try {
      const { ata } = deriveSolanaUsdcAta(phantomAddress, 'mainnet')
      const response = await fetch('https://solana-rpc.publicnode.com', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'getAccountInfo',
          params: [
            ata.toBase58(),
            {
              encoding: 'jsonParsed',
              commitment: 'confirmed',
            },
          ],
        }),
      })

      if (!response.ok) throw new Error(`Solana RPC HTTP ${response.status}`)
      const payload = await response.json()
      if (payload?.error) throw new Error(payload.error.message || 'Solana RPC error')

      const value = payload?.result?.value?.data?.parsed?.info?.tokenAmount?.uiAmountString
      if (typeof value !== 'string') throw new Error('Solana USDC balance unavailable')

      setSolanaBalance({ value, loading: false, error: null })
    } catch (error) {
      setSolanaBalance({
        value: null,
        loading: false,
        error: error instanceof Error ? error.message : 'Solana balance unavailable',
      })
    }
  }

  useEffect(() => {
    if (address) void loadAllEvmBalances()
  }, [address])

  useEffect(() => {
    void loadSolanaBalance()
  }, [phantomAddress])

  useEffect(() => {
    const timer = window.setInterval(() => setRefundClock(Date.now()), 60_000)
    return () => window.clearInterval(timer)
  }, [])

  const pendingRefunds = solanaActivity.filter(
    (item) =>
      item.direction === 'solana-to-arc'
      && item.refundableDepositSol
      && item.refundAvailableAt,
  )

  const getRefundMetadata = async (
    item: MainnetSolanaActivityRecord,
  ): Promise<MainnetSolanaRefundMetadata> => {
    if (
      item.messageSentEventAccount
      && item.refundDestinationMessage
      && item.refundAttestation
      && item.refundAvailableAt
      && item.refundableDepositSol
    ) {
      return {
        sourceTxHash:item.sourceTxHash,
        messageSentEventAccount: item.messageSentEventAccount,
        refundDestinationMessage: item.refundDestinationMessage,
        refundAttestation: item.refundAttestation,
        refundAvailableAt: item.refundAvailableAt,
        refundableDepositSol: item.refundableDepositSol,
      }
    }

    if (!item.sourceTxHash) {
      throw new Error('Solana source transaction is missing from this activity record.')
    }

    const metadata = await loadMainnetSolanaRefundMetadata(
      item.sourceTxHash,
      item.solanaWallet,
    )

    updateMainnetSolanaActivity(item.id, {
      ...metadata,
      refundStatus: item.refundStatus ?? 'pending',
    })

    return metadata
  }

  const handleRefund = async (item: MainnetSolanaActivityRecord) => {
    setRefundActions((current) => ({
      ...current,
      [item.id]: { loading: true, error: null },
    }))

    try {
      if (!phantomProvider || !phantomAddress) {
        throw new Error('Connect Phantom before reclaiming the refundable SOL deposit.')
      }

      const metadata = await getRefundMetadata(item)
      const result = await reclaimMainnetSolanaDeposit({
        provider: phantomProvider,
        connectedWallet: phantomAddress,
        originalWallet: item.solanaWallet,
        metadata,
      })

      updateMainnetSolanaActivity(item.id, {
        ...metadata,
        refundStatus: 'reclaimed',
        refundTxHash: result.txHash,
        reclaimedAt: Date.now(),
      })

      setRefundActions((current) => ({
        ...current,
        [item.id]: { loading: false, error: null },
      }))
    } catch (error) {
      setRefundActions((current) => ({
        ...current,
        [item.id]: {
          loading: false,
          error: error instanceof Error ? error.message : 'SOL reclaim failed.',
        },
      }))
    }
  }

  return (
    <Container className="py-10">
      <div className="space-y-6">
        <div>
          <div className="flex flex-wrap items-center gap-2.5">
            <h2 className="text-3xl font-bold tracking-tight">Mainnet Dashboard</h2>
            <span className="inline-flex shrink-0 items-center rounded-full border border-slate-200 bg-slate-50 px-2.5 py-0.5 text-xs font-medium text-slate-600">Beta</span>
          </div>
          <p className="mt-2 text-sm text-slate-500">
            EVM, Solana and Sui wallets, USDC balances and bridge transfers in one place.
          </p>
        </div>

        {!anyWallet ? (
          <Card className="text-center">
            <Wallet size={44} className="mx-auto mb-4 text-slate-400" />
            <h2 className="text-xl font-semibold">Connect a wallet</h2>
            <p className="mt-2 text-sm text-slate-500">
              Connect your EVM wallet (Arc), Phantom (Solana) or Slush (Sui) in the top bar to view balances and bridge activity.
            </p>
          </Card>
        ) : (
          <>
            <Card>
          <h3 className="text-lg font-semibold">Wallet Connections</h3>
          <div className="mt-4 grid gap-3 md:grid-cols-3">
            <WalletCard
              name="EVM Wallet"
              purpose="Arc and verified EVM mainnet routes."
              address={address}
              state={isConnected ? { label: 'Connected', tone: 'ok' } : { label: 'Not connected', tone: 'off' }}
            />
            <WalletCard
              name="Phantom Solana"
              purpose="Required for Arc ↔ Solana transfers."
              address={phantomAddress}
              state={phantomConnected ? { label: 'Connected', tone: 'ok' } : isPhantomInstalled ? { label: 'Ready', tone: 'warn' } : { label: 'Not installed', tone: 'off' }}
            />
            <WalletCard
              name="Slush Sui"
              purpose="Required for Arc ↔ Sui transfers."
              address={sui.address}
              state={!sui.address ? (sui.isWalletAvailable ? { label: 'Ready', tone: 'warn' } : { label: 'Not installed', tone: 'off' }) : sui.walletSupportsNetwork ? { label: 'Connected', tone: 'ok' } : { label: 'Not on Sui Mainnet', tone: 'warn' }}
            />
          </div>
        </Card>

        <Card>
          <div className="flex items-center justify-between gap-4">
            <h3 className="flex items-center gap-2 text-lg font-semibold">
              <TrendingUp size={19} />
              USDC Balances
            </h3>
            <button
              type="button"
              onClick={() => {
                void loadAllEvmBalances()
                void loadSolanaBalance()
                if (sui.address && sui.walletSupportsNetwork) void sui.refetchBalance()
              }}
              className="inline-flex items-center gap-1.5 rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs font-semibold text-slate-600 hover:bg-slate-50"
            >
              <RefreshCw size={13} />
              Refresh
            </button>
          </div>

          <div className="mt-4 space-y-3">
            {(Object.keys(MAINNET_NETWORKS) as Array<keyof typeof MAINNET_NETWORKS>).map((key) => {
              const network = MAINNET_NETWORKS[key]
              const balance = balances[key] ?? EMPTY_BALANCE

              return (
                <div key={key} className="flex items-center justify-between rounded-xl border border-slate-200 bg-[#f8faf7] p-4">
                  <div>
                    <p className="font-semibold">USDC ({network.name})</p>
                    <p className="text-sm text-slate-500">{network.name} Mainnet</p>
                  </div>
                  <div className="text-right">
                    <BalanceValue balance={balance} idle={!address ? 'Connect EVM wallet' : null} />
                  </div>
                </div>
              )
            })}

            <div className="flex items-center justify-between rounded-xl border border-slate-200 bg-[#f8faf7] p-4">
              <div>
                <p className="font-semibold">USDC (Solana)</p>
                <p className="text-sm text-slate-500">Solana Mainnet</p>
              </div>
              <div className="text-right">
                <BalanceValue balance={solanaBalance} idle={!phantomAddress ? 'Connect Phantom' : null} />
              </div>
            </div>

            <div aria-label="Sui USDC balance" className="flex items-center justify-between rounded-xl border border-slate-200 bg-[#f8faf7] p-4">
              <div>
                <p className="font-semibold">USDC (Sui)</p>
                <p className="text-sm text-slate-500">Sui Mainnet</p>
              </div>
              <div className="text-right">
                <BalanceValue balance={suiBalance} idle={!sui.address ? 'Connect Slush' : !sui.walletSupportsNetwork ? 'Switch Slush to Sui Mainnet' : null} />
              </div>
            </div>
          </div>
        </Card>

        {pendingRefunds.length > 0 && (
          <Card>
            <h3 className="text-lg font-semibold">Solana Refundable Deposits</h3>
            <p className="mt-1 text-xs leading-5 text-slate-500">
              Circle creates a temporary account for Solana → Arc transfers. After the five-day window, the same Phantom wallet can close it here and reclaim the deposited SOL.
            </p>
            <div className="mt-4 space-y-3">
              {pendingRefunds.map((item) => {
                const action = refundActions[item.id]
                const reclaimed = item.refundStatus === 'reclaimed'
                const eligible = Boolean(
                  item.refundAvailableAt
                  && Date.now() >= item.refundAvailableAt
                )
                const correctWallet = Boolean(
                  phantomConnected
                  && phantomAddress
                  && phantomAddress === item.solanaWallet
                )

                return (
                  <div
                    key={item.id}
                    className={`rounded-xl border p-4 ${
                      reclaimed
                        ? 'border-emerald-200 bg-emerald-50'
                        : 'border-amber-200 bg-amber-50'
                    }`}
                  >
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <div>
                        <p className="font-semibold text-slate-900">
                          {item.refundableDepositSol} SOL refundable
                        </p>
                        <p className="mt-1 text-xs text-slate-600">
                          {reclaimed
                            ? 'Reclaimed'
                            : item.refundAvailableAt
                              ? timeUntil(item.refundAvailableAt)
                              : 'Eligibility time unknown'}
                        </p>
                      </div>

                      {reclaimed ? (
                        <span className="rounded-full bg-white px-2.5 py-1 text-[11px] font-semibold text-emerald-800">
                          Reclaimed
                        </span>
                      ) : (
                        <button
                          type="button"
                          disabled={!eligible || !correctWallet || action?.loading}
                          onClick={() => void handleRefund(item)}
                          className="inline-flex h-10 items-center justify-center gap-2 rounded-xl bg-slate-900 px-4 text-xs font-semibold text-white disabled:cursor-not-allowed disabled:bg-slate-200 disabled:text-slate-500"
                        >
                          <RotateCcw size={14} />
                          {action?.loading
                            ? 'Preparing reclaim...'
                            : !eligible
                              ? item.refundAvailableAt
                                ? timeUntil(item.refundAvailableAt)
                                : 'Not ready'
                              : !correctWallet
                                ? 'Connect original Phantom'
                                : `Reclaim ${item.refundableDepositSol} SOL`}
                        </button>
                      )}
                    </div>

                    {!reclaimed && (
                      <p className="mt-3 text-[11px] leading-5 text-amber-900/80">
                        Phantom shows the reclaim transaction before signing. Only the original rent-paying Phantom wallet can receive this SOL.
                      </p>
                    )}

                    {item.refundTxHash && (
                      <a
                        href={`${SOLANA_MAINNET_CCTP.explorerUrl}/tx/${item.refundTxHash}`}
                        target="_blank"
                        rel="noreferrer"
                        className="mt-3 inline-flex items-center gap-1 text-[11px] font-medium text-emerald-800 hover:underline"
                      >
                        Reclaim transaction <ExternalLink size={11} />
                      </a>
                    )}

                    {action?.error && (
                      <p className="mt-3 rounded-xl border border-red-200 bg-white px-3 py-2 text-[11px] leading-5 text-red-700">
                        {action.error}
                      </p>
                    )}
                  </div>
                )
              })}
            </div>
          </Card>
        )}

        <Card>
          <h3 className="text-lg font-semibold">Bridge Transactions</h3>
          <p className="mt-1 text-xs text-slate-500">Completed transfers per route: EVM, Solana and Sui.</p>
          {routeStats.length === 0 ? (
            <p className="mt-3 text-sm text-slate-500">No completed mainnet transfers recorded in this browser yet.</p>
          ) : (
            <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
              {routeStats.map((item) => (
                <div key={item.label} aria-label={`${item.label} completed`} className="rounded-xl border border-slate-200 bg-[#f8faf7] p-4 text-center">
                  <p className="text-xs leading-snug text-slate-500">{item.label}</p>
                  <p className="mt-1 text-2xl font-bold text-sky-600">{item.count}</p>
                </div>
              ))}
            </div>
          )}
        </Card>

        <Card>
          <h3 className="text-lg font-semibold">Bridge Activity</h3>
          <p className="mt-1 text-xs text-slate-500">
            EVM, Solana and Sui transfers recorded in this browser for the connected wallets, newest first. This is not a full chain history scan: transfers made on another device or browser do not appear here until you recover them below.
          </p>
          <BridgeHistoryList items={bridgeHistory} empty="No mainnet bridge activity yet." />
        </Card>

        <Card>
          <h3 className="text-lg font-semibold">Recover a transfer</h3>
          <p className="mt-1 text-xs leading-5 text-slate-500">
            EVM routes can be recovered here from the source transaction. Sui ↔ Arc transfers are found in Bridge → Sui Bridge → “Recover a transfer from another device or browser”; Arc → Solana transfers in Bridge → Solana Bridge → “Recover an older Arc → Solana transfer”.
          </p>
          <MainnetTransferRecovery />
        </Card>
          </>
        )}
      </div>
    </Container>
  )
}
