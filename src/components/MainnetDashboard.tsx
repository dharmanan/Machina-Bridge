import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPublicClient, formatUnits, http, parseAbi } from 'viem'
import {
  AlertCircle,
  ArrowDownLeft,
  ArrowLeftRight,
  ArrowUpRight,
  ExternalLink,
  FileCode2,
  Landmark,
  RefreshCw,
  RotateCcw,
  ShieldCheck,
  TrendingUp,
  Wallet,
} from 'lucide-react'
import { useAccount } from 'wagmi'
import { MAINNET_NETWORKS } from '../config/mainnetNetworks'
import { SOLANA_MAINNET_CCTP } from '../config/mainnetSolana'
import {
  fetchMainnetWalletActivity,
  normalizeWalletActivity,
  shortWalletAddress,
  type WalletActivity,
} from '../lib/mainnetWalletActivity'
import { usePhantomSolana } from '../hooks/usePhantomSolana'
import { useMainnetTransferQueue } from '../hooks/useMainnetTransferQueue'
import { useMainnetSolanaActivity } from '../hooks/useMainnetSolanaActivity'
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

function formatRouteName(chainId: number) {
  return Object.values(MAINNET_NETWORKS).find((network) => network.chainId === chainId)?.name
    ?? `Chain ${chainId}`
}

function evmExplorer(chainId: number, txHash?: string) {
  if (!txHash) return undefined
  const network = Object.values(MAINNET_NETWORKS).find((item) => item.chainId === chainId)
  if (!network?.explorerUrl) return undefined
  return `${network.explorerUrl.replace(/\/$/, '')}/tx/${txHash}`
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

function userTransferStatus(stage: string) {
  const labels: Record<string, string> = {
    ready: 'Ready to send',
    approval_required: 'Approval required',
    approving: 'Approving',
    approved: 'Ready to send',
    burning: 'Sending',
    waiting_attestation: 'Waiting for Circle',
    ready_to_mint: 'Ready to receive',
    minting: 'Receiving',
    complete: 'Complete',
    failed: 'Needs attention',
  }

  return labels[stage] ?? 'In progress'
}

export default function MainnetDashboard() {
  const { address, isConnected } = useAccount()
  const {
    address: phantomAddress,
    isConnected: phantomConnected,
    isPhantomInstalled,
    provider: phantomProvider,
  } = usePhantomSolana()
  const { transfers } = useMainnetTransferQueue(address)
  const { records: solanaActivity } = useMainnetSolanaActivity(address, phantomAddress)

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
  const [walletActivity, setWalletActivity] = useState<WalletActivity[]>([])
  const [walletActivityLoading, setWalletActivityLoading] = useState(false)
  const [walletActivityError, setWalletActivityError] = useState<string | null>(null)
  const [walletActivityDataAddress, setWalletActivityDataAddress] = useState<string | null>(null)
  const walletActivityDataAddressRef = useRef<string | null>(null)
  const walletActivityRequestId = useRef(0)
  const walletActivityController = useRef<AbortController | null>(null)
  const walletActivityAddress = address?.toLowerCase() ?? null
  const walletActivityAddressRef = useRef(walletActivityAddress)
  walletActivityAddressRef.current = walletActivityAddress

  const loadWalletActivity = useCallback(async (walletAddress: string) => {
    const requestId = ++walletActivityRequestId.current
    const addressIdentity = walletAddress.toLowerCase()
    walletActivityController.current?.abort()
    const controller = new AbortController()
    walletActivityController.current = controller

    if (walletActivityDataAddressRef.current !== addressIdentity) {
      setWalletActivity([])
      walletActivityDataAddressRef.current = addressIdentity
    }
    setWalletActivityDataAddress(addressIdentity)
    setWalletActivityLoading(true)
    setWalletActivityError(null)

    const isCurrentRequest = () =>
      requestId === walletActivityRequestId.current
      && walletActivityAddressRef.current === addressIdentity
      && !controller.signal.aborted

    try {
      const response = await fetchMainnetWalletActivity(walletAddress, controller.signal)
      if (!isCurrentRequest()) return
      setWalletActivity(normalizeWalletActivity(walletAddress, response))
    } catch (error) {
      if (!isCurrentRequest()) return
      setWalletActivityError(error instanceof Error ? error.message : 'Wallet activity is unavailable')
    } finally {
      if (isCurrentRequest()) setWalletActivityLoading(false)
    }
  }, [])

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
    if (!address) {
      walletActivityRequestId.current += 1
      walletActivityController.current?.abort()
      walletActivityController.current = null
      setWalletActivity([])
      setWalletActivityDataAddress(null)
      walletActivityDataAddressRef.current = null
      setWalletActivityLoading(false)
      setWalletActivityError(null)
      return
    }

    void loadWalletActivity(address)
    return () => {
      if (walletActivityAddressRef.current === address.toLowerCase()) {
        walletActivityRequestId.current += 1
        walletActivityController.current?.abort()
        walletActivityController.current = null
      }
    }
  }, [address, loadWalletActivity])

  const visibleWalletActivity = walletActivityDataAddress === walletActivityAddress
    ? walletActivity
    : []
  const visibleWalletActivityLoading = walletActivityAddress !== null
    && (walletActivityDataAddress !== walletActivityAddress || walletActivityLoading)
  const visibleWalletActivityError = walletActivityDataAddress === walletActivityAddress
    ? walletActivityError
    : null

  useEffect(() => {
    void loadSolanaBalance()
  }, [phantomAddress])

  useEffect(() => {
    const timer = window.setInterval(() => setRefundClock(Date.now()), 60_000)
    return () => window.clearInterval(timer)
  }, [])

  const completedEvm = transfers.filter((item) => item.stage === 'complete')

  const routeStats = useMemo(() => {
    const counts = new Map<string, number>()

    for (const item of completedEvm) {
      const key = `${formatRouteName(item.sourceChainId)} → ${formatRouteName(item.destinationChainId)}`
      counts.set(key, (counts.get(key) ?? 0) + 1)
    }

    for (const item of solanaActivity) {
      const key = item.direction === 'solana-to-arc'
        ? 'Solana → Arc'
        : 'Arc → Solana'
      counts.set(key, (counts.get(key) ?? 0) + 1)
    }

    return [...counts.entries()]
      .map(([label, count]) => ({ label, count }))
      .sort((a, b) => b.count - a.count)
  }, [completedEvm, solanaActivity])

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

  const activity = useMemo(() => {
    const evmItems = transfers.map((item) => ({
      id: `evm-${item.id}`,
      timestamp: item.updatedAt,
      title: `${item.amount} USDC`,
      route: `${formatRouteName(item.sourceChainId)} → ${formatRouteName(item.destinationChainId)}`,
      status: userTransferStatus(item.stage),
      sourceUrl: evmExplorer(item.sourceChainId, item.sourceTxHash),
      destinationUrl: evmExplorer(item.destinationChainId, item.destinationTxHash),
      refund: null as null | string,
    }))

    const solanaItems = solanaActivity.map((item) => {
      const sourceIsSolana = item.direction === 'solana-to-arc'
      return {
        id: `solana-${item.id}`,
        timestamp: item.createdAt,
        title: `${item.amount} USDC`,
        route: sourceIsSolana ? 'Solana → Arc' : 'Arc → Solana',
        status: 'Complete',
        sourceUrl: item.sourceTxHash
          ? sourceIsSolana
            ? `${SOLANA_MAINNET_CCTP.explorerUrl}/tx/${item.sourceTxHash}`
            : `${MAINNET_NETWORKS.arc.explorerUrl}/tx/${item.sourceTxHash}`
          : undefined,
        destinationUrl: item.destinationTxHash
          ? sourceIsSolana
            ? `${MAINNET_NETWORKS.arc.explorerUrl}/tx/${item.destinationTxHash}`
            : `${SOLANA_MAINNET_CCTP.explorerUrl}/tx/${item.destinationTxHash}`
          : undefined,
        refund: item.refundableDepositSol && item.refundAvailableAt
          ? `${item.refundableDepositSol} SOL · ${timeUntil(item.refundAvailableAt)}`
          : null,
      }
    })

    return [...evmItems, ...solanaItems]
      .sort((a, b) => b.timestamp - a.timestamp)
      .slice(0, 30)
  }, [transfers, solanaActivity])

  if (!isConnected) {
    return (
      <Container className="py-12">
        <Card className="text-center">
          <Wallet size={44} className="mx-auto mb-4 text-slate-400" />
          <h2 className="text-xl font-semibold">Connect your EVM wallet</h2>
          <p className="mt-2 text-sm text-slate-500">
            Connect the wallet used on Arc to view mainnet balances and bridge activity.
          </p>
        </Card>
      </Container>
    )
  }

  return (
    <Container className="py-10">
      <div className="space-y-6">
        <div>
          <h2 className="text-3xl font-bold tracking-tight">Mainnet Dashboard</h2>
          <p className="mt-2 text-sm text-slate-500">
            Wallets, USDC balances, completed routes, recent activity, and Solana deposit tracking.
          </p>
        </div>

        <Card>
          <h3 className="text-lg font-semibold">Wallet Connections</h3>
          <div className="mt-4 grid gap-3 md:grid-cols-2">
            <div className="rounded-xl border border-slate-200 bg-[#f8faf7] p-4">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <p className="font-semibold">EVM Wallet</p>
                  <p className="text-sm text-slate-500">Arc and verified EVM mainnet routes.</p>
                </div>
                <span className="rounded-full bg-[#eef7e8] px-2.5 py-1 text-xs font-medium text-[#2F6E0C]">
                  Connected
                </span>
              </div>
              <p className="mt-3 font-mono text-sm">{mask(address)}</p>
            </div>

            <div className="rounded-xl border border-slate-200 bg-[#f8faf7] p-4">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <p className="font-semibold">Phantom Solana</p>
                  <p className="text-sm text-slate-500">Required for Arc ↔ Solana transfers.</p>
                </div>
                <span className={`rounded-full px-2.5 py-1 text-xs font-medium ${
                  phantomConnected
                    ? 'bg-[#eef7e8] text-[#2F6E0C]'
                    : isPhantomInstalled
                      ? 'bg-amber-100 text-amber-700'
                      : 'bg-slate-100 text-slate-500'
                }`}>
                  {phantomConnected ? 'Connected' : isPhantomInstalled ? 'Ready' : 'Not installed'}
                </span>
              </div>
              <p className="mt-3 font-mono text-sm">
                {phantomAddress ? mask(phantomAddress) : 'No Phantom wallet connected'}
              </p>
            </div>
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
                    {balance.loading ? (
                      <span className="text-sm text-slate-400">Loading...</span>
                    ) : balance.error ? (
                      <span className="inline-flex items-center gap-1 text-xs text-amber-700" title={balance.error}>
                        <AlertCircle size={13} />
                        Unavailable
                      </span>
                    ) : (
                      <span className="text-lg font-semibold">{balance.value ?? '—'} USDC</span>
                    )}
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
                {!phantomAddress ? (
                  <span className="text-sm text-slate-400">Connect Phantom</span>
                ) : solanaBalance.loading ? (
                  <span className="text-sm text-slate-400">Loading...</span>
                ) : solanaBalance.error ? (
                  <span className="inline-flex items-center gap-1 text-xs text-amber-700" title={solanaBalance.error}>
                    <AlertCircle size={13} />
                    Unavailable
                  </span>
                ) : (
                  <span className="text-lg font-semibold">{solanaBalance.value ?? '—'} USDC</span>
                )}
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
          {routeStats.length === 0 ? (
            <p className="mt-3 text-sm text-slate-500">No completed mainnet transfers recorded in this browser yet.</p>
          ) : (
            <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
              {routeStats.map((item) => (
                <div key={item.label} className="rounded-xl border border-slate-200 bg-[#f8faf7] p-4 text-center">
                  <p className="text-xs leading-snug text-slate-500">{item.label}</p>
                  <p className="mt-1 text-2xl font-bold text-sky-600">{item.count}</p>
                </div>
              ))}
            </div>
          )}
        </Card>

        <Card>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h3 className="text-lg font-semibold">Wallet Activity</h3>
              <p className="mt-1 text-xs text-slate-500">
                Recent read only activity for this Arc wallet. Bridge Activity remains separate.
              </p>
            </div>
            <button
              type="button"
              onClick={() => address && void loadWalletActivity(address)}
              disabled={visibleWalletActivityLoading}
              className="inline-flex items-center gap-1.5 rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs font-semibold text-slate-600 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-60"
            >
              <RefreshCw size={13} className={visibleWalletActivityLoading ? 'animate-spin' : ''} />
              Refresh
            </button>
          </div>

          {visibleWalletActivityLoading && visibleWalletActivity.length === 0 ? (
            <p className="py-8 text-center text-sm text-slate-500">Loading wallet activity...</p>
          ) : (
            <>
              {visibleWalletActivityError && (
                <div className="mt-4 rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800">
                  <div className="flex items-center gap-2">
                    <AlertCircle size={15} />
                    <span>{visibleWalletActivityError}</span>
                  </div>
                  {visibleWalletActivity.length > 0 && (
                    <p className="mt-2 text-xs">Showing the last activity that loaded successfully.</p>
                  )}
                </div>
              )}

              {visibleWalletActivity.length === 0 && !visibleWalletActivityError ? (
                <p className="py-8 text-center text-sm text-slate-500">No Arc wallet activity found.</p>
              ) : visibleWalletActivity.length > 0 ? (
                <div className="mt-4 divide-y divide-slate-100">
                  {visibleWalletActivity.map((item) => {
                    const Icon = item.type === 'send'
                      ? ArrowUpRight
                      : item.type === 'receive'
                        ? ArrowDownLeft
                        : item.type === 'swap'
                          ? ArrowLeftRight
                          : item.type === 'bridge' || item.type === 'earn'
                            ? Landmark
                            : item.type === 'approve'
                              ? ShieldCheck
                              : FileCode2
                    const explorerUrl = `${MAINNET_NETWORKS.arc.explorerUrl}/tx/${item.txHash}`

                    return (
                      <div key={item.id} className="flex flex-wrap items-center justify-between gap-3 py-3 first:pt-0 last:pb-0">
                        <div className="flex min-w-0 items-start gap-3">
                          <span className="mt-0.5 inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[#eef7e8] text-[#2F6E0C]">
                            <Icon size={17} />
                          </span>
                          <div className="min-w-0">
                            <p className="font-semibold text-sm text-slate-900">{item.title}</p>
                            <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-slate-500">
                              {item.amount && <span className="font-medium text-slate-700">{item.amount}</span>}
                              {item.protocol && <span>{item.protocol}</span>}
                              <span>{item.timestamp ? new Date(item.timestamp).toLocaleString() : 'Time unavailable'}</span>
                            </div>
                            <a
                              href={explorerUrl}
                              target="_blank"
                              rel="noreferrer"
                              className="mt-1 inline-flex items-center gap-1 font-mono text-[11px] text-slate-400 hover:text-emerald-800"
                            >
                              {shortWalletAddress(item.txHash)} <ExternalLink size={10} />
                            </a>
                          </div>
                        </div>
                        <span className={`rounded-full px-2.5 py-1 text-[11px] font-medium ${
                          item.status === 'Failed'
                            ? 'bg-red-50 text-red-700'
                            : item.status === 'Confirmed'
                              ? 'bg-[#eef7e8] text-[#2F6E0C]'
                              : 'bg-slate-100 text-slate-500'
                        }`}>
                          {item.status}
                        </span>
                      </div>
                    )
                  })}
                </div>
              ) : null}
            </>
          )}

          <p className="mt-4 border-t border-slate-100 pt-3 text-[10px] text-slate-400">
            Activity data provided by Etherscan.
          </p>
        </Card>

        <Card>
          <h3 className="text-lg font-semibold">Bridge Activity</h3>
          <p className="mt-1 text-xs text-slate-500">
            EVM and Solana mainnet bridge activity stored for this wallet in this browser.
          </p>

          {activity.length === 0 ? (
            <p className="py-8 text-center text-sm text-slate-500">No mainnet bridge activity yet.</p>
          ) : (
            <div className="mt-4 space-y-3">
              {activity.map((item) => (
                <div key={item.id} className="rounded-xl border border-slate-200 bg-[#f8faf7] p-4">
                  <div className="flex items-start justify-between gap-4">
                    <div>
                      <p className="font-semibold text-sm">{item.title}</p>
                      <p className="text-xs text-slate-500">{item.route}</p>
                      <p className="text-xs text-slate-400">{new Date(item.timestamp).toLocaleString()}</p>
                      {item.refund && (
                        <p className="mt-2 text-xs font-medium text-amber-700">
                          Refundable deposit: {item.refund}
                        </p>
                      )}
                    </div>

                    <div className="flex flex-col items-end gap-2">
                      <span className="rounded-full bg-[#eef7e8] px-2.5 py-1 text-[11px] font-medium text-[#2F6E0C]">
                        {item.status}
                      </span>
                      <div className="flex flex-wrap justify-end gap-2 text-[11px]">
                        {item.sourceUrl && (
                          <a
                            href={item.sourceUrl}
                            target="_blank"
                            rel="noreferrer"
                            className="inline-flex items-center gap-1 text-blue-600 hover:underline"
                          >
                            Source <ExternalLink size={11} />
                          </a>
                        )}
                        {item.destinationUrl && (
                          <a
                            href={item.destinationUrl}
                            target="_blank"
                            rel="noreferrer"
                            className="inline-flex items-center gap-1 text-blue-600 hover:underline"
                          >
                            Destination <ExternalLink size={11} />
                          </a>
                        )}
                      </div>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </Card>
      </div>
    </Container>
  )
}
