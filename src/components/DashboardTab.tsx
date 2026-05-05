import { useAccount } from 'wagmi'
import { useEffect, useState, useCallback } from 'react'
import { Card, Container } from './ui'
import { Wallet, TrendingUp, Loader2, AlertCircle, RefreshCw } from 'lucide-react'
import { useBridgeKit, SEPOLIA_CHAIN_ID, ARC_CHAIN_ID, BASE_CHAIN_ID, OPTIMISM_CHAIN_ID, ARBITRUM_CHAIN_ID } from '../hooks/useBridgeKit'
import { usePhantomSolana } from '../hooks/usePhantomSolana'
import {
  ARC_EVM_CHAIN,
  ARBITRUM_SEPOLIA_EVM_CHAIN,
  BASE_SEPOLIA_EVM_CHAIN,
  OPTIMISM_SEPOLIA_EVM_CHAIN,
  SEPOLIA_EVM_CHAIN,
  getSupportedEvmChainName,
} from '../lib/chains'
import { fetchSolanaUsdcBalance } from '../lib/solana'

interface Transaction {
  id: string;
  type: string;
  direction: string;
  amount: string;
  fromNetwork: string;
  toNetwork: string;
  timestamp: string;
  sourceTxHash?: string;
  receiveTxHash?: string;
  transferId?: string;
  recipientAta?: string;
  status?: string;
}

const SOLANA_DEVNET_EXPLORER_BASE_URL = 'https://explorer.solana.com/tx'

function getExplorerBaseUrl(network?: string) {
  const normalized = (network || '').trim().toLowerCase()

  if (!normalized) return undefined
  if (normalized.includes('solana')) return SOLANA_DEVNET_EXPLORER_BASE_URL
  if (normalized.includes('arc')) return ARC_EVM_CHAIN.blockExplorers?.default.url
  if (normalized.includes('arbitrum')) return ARBITRUM_SEPOLIA_EVM_CHAIN.blockExplorers?.default.url
  if (normalized.includes('optimism') || normalized.startsWith('op ')) return OPTIMISM_SEPOLIA_EVM_CHAIN.blockExplorers?.default.url
  if (normalized.includes('base')) return BASE_SEPOLIA_EVM_CHAIN.blockExplorers?.default.url
  if (normalized.includes('sepolia') || normalized.includes('ethereum')) return SEPOLIA_EVM_CHAIN.blockExplorers?.default.url

  return undefined
}

function getTransactionExplorerUrl(txHash?: string, network?: string) {
  if (!txHash) return undefined

  const explorerBaseUrl = getExplorerBaseUrl(network)
  if (!explorerBaseUrl) return undefined

  if ((network || '').trim().toLowerCase().includes('solana')) {
    return `${explorerBaseUrl}/${txHash}?cluster=devnet`
  }

  return `${explorerBaseUrl}/tx/${txHash}`
}

function formatNetworkLabel(network?: string) {
  const normalized = (network || '').trim().toLowerCase()

  if (!normalized) return 'Unknown'
  if (normalized.includes('solana')) return 'Solana Devnet'
  if (normalized.includes('arbitrum')) return 'Arbitrum'
  if (normalized.includes('optimism') || normalized.startsWith('op ')) return 'Optimism'
  if (normalized.includes('base')) return 'Base'
  if (normalized.includes('arc')) return 'Arc'
  if (normalized.includes('sepolia') || normalized.includes('ethereum')) return 'Sepolia'

  return network as string
}

function parseDirectionRoute(direction?: string) {
  if (!direction || !direction.includes('-to-')) {
    return { fromNetwork: undefined, toNetwork: undefined }
  }

  const [fromRaw, toRaw] = direction.split('-to-')
  const toTitle = (value?: string) =>
    value
      ? value
          .split('-')
          .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
          .join(' ')
      : undefined

  return {
    fromNetwork: toTitle(fromRaw),
    toNetwork: toTitle(toRaw),
  }
}

export function DashboardTab() {
  const { address, isConnected, chainId } = useAccount()
  const {
    address: phantomSolanaAddress,
    isConnected: isPhantomConnected,
    isPhantomInstalled,
  } = usePhantomSolana()
  const {
    fetchTokenBalance,
    tokenBalance: sepoliaBalance,
    isLoadingBalance: sepoliaLoading,
    balanceError: sepoliaError,
  } = useBridgeKit()
  const {
    fetchTokenBalance: fetchArcBalance,
    tokenBalance: arcBalance,
    isLoadingBalance: arcLoading,
    balanceError: arcError,
  } = useBridgeKit()
  const {
    fetchTokenBalance: fetchBaseBalance,
    tokenBalance: baseBalance,
    isLoadingBalance: baseLoading,
    balanceError: baseError,
  } = useBridgeKit()
  const {
    fetchTokenBalance: fetchOptimismBalance,
    tokenBalance: optimismBalance,
    isLoadingBalance: optimismLoading,
    balanceError: optimismError,
  } = useBridgeKit()
  const {
    fetchTokenBalance: fetchArbitrumBalance,
    tokenBalance: arbitrumBalance,
    isLoadingBalance: arbitrumLoading,
    balanceError: arbitrumError,
  } = useBridgeKit()

  const [transactions, setTransactions] = useState<Transaction[]>([])
  const [solanaBalance, setSolanaBalance] = useState<string | null>(null)
  const [solanaBalanceLoading, setSolanaBalanceLoading] = useState(false)
  const [solanaBalanceError, setSolanaBalanceError] = useState<string | null>(null)

  const loadSolanaBalance = useCallback(async (ownerAddress: string) => {
    setSolanaBalanceLoading(true)
    setSolanaBalanceError(null)
    try {
      const bal = await fetchSolanaUsdcBalance(ownerAddress)
      setSolanaBalance(bal)
    } catch {
      setSolanaBalanceError('Failed to fetch Solana Devnet USDC balance.')
    } finally {
      setSolanaBalanceLoading(false)
    }
  }, [])

  // Fetch balances on mount and when address changes
  useEffect(() => {
    if (isConnected && address) {
      // Fetch Sepolia balance
      fetchTokenBalance('USDC', SEPOLIA_CHAIN_ID)
      
      // Fetch Arc balance
      fetchArcBalance('USDC', ARC_CHAIN_ID)
      // Fetch Base Sepolia balance
      fetchBaseBalance('USDC', BASE_CHAIN_ID)
      // Fetch Optimism Sepolia balance
      fetchOptimismBalance('USDC', OPTIMISM_CHAIN_ID)
      // Fetch Arbitrum Sepolia balance
      fetchArbitrumBalance('USDC', ARBITRUM_CHAIN_ID)
    }
  }, [address, isConnected, fetchTokenBalance, fetchArcBalance, fetchBaseBalance, fetchOptimismBalance, fetchArbitrumBalance])

  useEffect(() => {
    if (phantomSolanaAddress) {
      loadSolanaBalance(phantomSolanaAddress)
    } else {
      setSolanaBalance(null)
      setSolanaBalanceError(null)
    }
  }, [phantomSolanaAddress, loadSolanaBalance])

  // Load transactions from localStorage
  useEffect(() => {
    const savedTransactions = JSON.parse(localStorage.getItem('bridgeTransactions') || '[]')
    setTransactions(savedTransactions)
  }, [])

  // Dynamically compute bridge statistics grouped by route
  const bridgeRouteStats = transactions.reduce<Record<string, { from: string; to: string; count: number }>>(
    (acc, tx) => {
      const from = tx.fromNetwork || 'Unknown'
      const to = tx.toNetwork || 'Unknown'
      const key = `${from}→${to}`
      if (!acc[key]) acc[key] = { from, to, count: 0 }
      acc[key].count++
      return acc
    },
    {}
  )
  const bridgeRoutes = Object.values(bridgeRouteStats)

  const getTransactionRoute = (transaction: Transaction) => {
    const parsedDirectionRoute = parseDirectionRoute(transaction.direction)
    const fallbackFromNetwork = transaction.fromNetwork || parsedDirectionRoute.fromNetwork || 'Sepolia'
    const fallbackToNetwork = transaction.toNetwork || parsedDirectionRoute.toNetwork || 'Arc Testnet'

    if (transaction.type === 'solana-bridge' || transaction.direction === 'solana-to-arc' || transaction.fromNetwork === 'Solana Devnet') {
      return {
        label: 'Bridge',
        fromNetwork: 'Solana Devnet',
        toNetwork: 'Arc Testnet',
        sourceExplorerUrl: getTransactionExplorerUrl(transaction.sourceTxHash, 'Solana Devnet'),
      }
    }

    if (transaction.type === 'solana-forward' || transaction.direction.includes('solana') || transaction.toNetwork === 'Solana Devnet') {
      return {
        label: 'Solana Forward',
        fromNetwork: fallbackFromNetwork,
        toNetwork: 'Solana Devnet',
        sourceExplorerUrl: getTransactionExplorerUrl(transaction.sourceTxHash, fallbackFromNetwork),
      }
    }

    if (transaction.direction === 'arc-to-sepolia') {
      return {
        label: 'Bridge',
        fromNetwork: 'Arc Testnet',
        toNetwork: 'Sepolia',
        sourceExplorerUrl: getTransactionExplorerUrl(transaction.sourceTxHash, 'Arc Testnet'),
      }
    }

    const fromNetwork = fallbackFromNetwork
    const toNetwork = fallbackToNetwork

    return {
      label: 'Bridge',
      fromNetwork,
      toNetwork,
      sourceExplorerUrl: getTransactionExplorerUrl(transaction.sourceTxHash, fromNetwork),
    }
  }

  if (!isConnected) {
    return (
      <Container className="py-12">
        <Card className="text-center">
          <Wallet size={48} className="mx-auto mb-4 text-slate-400" />
          <h2 className="text-xl font-semibold mb-2">Connect Your Wallet</h2>
          <p className="text-slate-500">Connect your wallet to see your balances and transaction history</p>
        </Card>
      </Container>
    )
  }

  return (
    <Container className="py-12">
      <div className="space-y-6">
        <div>
          <h2 className="text-3xl font-bold">Dashboard</h2>
          <p className="mt-2 text-sm text-slate-500">A simpler view of balances, wallet readiness, and recent bridge activity.</p>
        </div>

        {/* Account Info */}
        <Card>
          <h3 className="text-lg font-semibold mb-4">Account</h3>
          <div className="space-y-2">
            <div className="flex justify-between">
              <span className="text-slate-500">Address</span>
              <span className="font-mono text-sm">{address?.slice(0, 6)}...{address?.slice(-4)}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-slate-500">Current Network</span>
              <span className="font-semibold">
                {chainId ? getSupportedEvmChainName(chainId) : 'Unknown network'}
              </span>
            </div>
          </div>
        </Card>

        <Card>
          <h3 className="text-lg font-semibold mb-4">Wallet Connections</h3>
          <div className="space-y-3">
            <div className="rounded-xl border border-slate-200 bg-[#f8faf7] p-4">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <p className="font-semibold">EVM Wallet</p>
                  <p className="text-sm text-slate-500">Used for Sepolia, Arc, and Arc-side mint signing.</p>
                </div>
                <span className={`rounded-full px-2.5 py-1 text-xs font-medium ${isConnected ? 'bg-[#eef7e8] text-[#2F6E0C]' : 'bg-slate-100 text-slate-500'}`}>
                  {isConnected ? 'Connected' : 'Disconnected'}
                </span>
              </div>
              <p className="mt-3 font-mono text-sm text-slate-900">
                {address ? `${address.slice(0, 8)}...${address.slice(-6)}` : 'No EVM wallet connected'}
              </p>
            </div>

            <div className="rounded-xl border border-slate-200 bg-[#f8faf7] p-4">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <p className="font-semibold">Phantom Solana</p>
                  <p className="text-sm text-slate-500">Used for Solana Devnet source burns and Solana-side signing.</p>
                </div>
                <span className={`rounded-full px-2.5 py-1 text-xs font-medium ${isPhantomConnected ? 'bg-[#eef7e8] text-[#2F6E0C]' : isPhantomInstalled ? 'bg-amber-100 text-amber-700' : 'bg-slate-100 text-slate-500'}`}>
                  {isPhantomConnected ? 'Connected' : isPhantomInstalled ? 'Ready' : 'Not Installed'}
                </span>
              </div>
              <p className="mt-3 font-mono text-sm text-slate-900">
                {phantomSolanaAddress ? `${phantomSolanaAddress.slice(0, 8)}...${phantomSolanaAddress.slice(-6)}` : 'No Phantom Solana wallet connected'}
              </p>
            </div>

            <div className="rounded-xl border border-[#2F6E0C]/15 bg-[#eef7e8] p-4 text-sm text-slate-700">
              {isConnected && isPhantomConnected
                ? 'Dual-wallet mode is ready: EVM wallet handles Arc-side actions, Phantom handles Solana-side signing.'
                : isConnected
                  ? 'EVM wallet is ready. Connect Phantom as well if you want to use Solana as the source chain.'
                  : isPhantomConnected
                    ? 'Phantom is ready. Connect an EVM wallet too so Arc can receive the destination mint.'
                    : 'Connect both wallets to use the Solana → Arc flow end-to-end.'}
            </div>
          </div>
        </Card>

        {/* Balances */}
        <Card>
          <h3 className="text-lg font-semibold mb-4 flex items-center gap-2">
            <TrendingUp size={20} />
            Balances
          </h3>
          <div className="space-y-3">
            {/* Sepolia USDC */}
            <div className="flex items-center justify-between rounded-xl border border-slate-200 bg-[#f8faf7] p-4">
              <div>
                <p className="font-semibold">USDC (Sepolia)</p>
                <p className="text-sm text-slate-500">Ethereum Sepolia Testnet</p>
              </div>
              <div className="text-right">
                {sepoliaLoading ? (
                  <Loader2 size={16} className="animate-spin ml-auto" />
                ) : sepoliaError ? (
                  <div className="flex items-center gap-2 justify-end text-red-400">
                    <AlertCircle size={14} className="flex-shrink-0" />
                    <button
                      onClick={() => fetchTokenBalance('USDC', SEPOLIA_CHAIN_ID)}
                      className="text-xs hover:text-red-300 transition-colors"
                      title={sepoliaError}
                    >
                      Retry
                    </button>
                    <RefreshCw size={12} />
                  </div>
                ) : (
                  <span className="text-lg font-semibold">{sepoliaBalance} USDC</span>
                )}
              </div>
            </div>

            {/* Arc USDC */}
            <div className="flex items-center justify-between rounded-xl border border-slate-200 bg-[#f8faf7] p-4">
              <div>
                <p className="font-semibold">USDC (Arc)</p>
                <p className="text-sm text-slate-500">Arc Testnet</p>
              </div>
              <div className="text-right">
                {arcLoading ? (
                  <Loader2 size={16} className="animate-spin ml-auto" />
                ) : arcError ? (
                  <div className="flex items-center gap-2 justify-end text-red-400">
                    <AlertCircle size={14} className="flex-shrink-0" />
                    <button
                      onClick={() => fetchArcBalance('USDC', ARC_CHAIN_ID)}
                      className="text-xs hover:text-red-300 transition-colors"
                      title={arcError ?? undefined}
                    >
                      Retry
                    </button>
                    <RefreshCw size={12} />
                  </div>
                ) : (
                  <span className="text-lg font-semibold">{arcBalance} USDC</span>
                )}
              </div>
            </div>

            {/* Solana Devnet USDC */}
            <div className="flex items-center justify-between rounded-xl border border-slate-200 bg-[#f8faf7] p-4">
              <div>
                <p className="font-semibold">USDC (Solana)</p>
                <p className="text-sm text-slate-500">Solana Devnet</p>
              </div>
              <div className="text-right">
                {!phantomSolanaAddress ? (
                  <span className="text-sm text-slate-400">Connect Phantom</span>
                ) : solanaBalanceLoading ? (
                  <Loader2 size={16} className="animate-spin ml-auto" />
                ) : solanaBalanceError ? (
                  <div className="flex items-center gap-2 justify-end text-red-400">
                    <AlertCircle size={14} className="flex-shrink-0" />
                    <button
                      onClick={() => loadSolanaBalance(phantomSolanaAddress)}
                      className="text-xs hover:text-red-300 transition-colors"
                      title={solanaBalanceError}
                    >
                      Retry
                    </button>
                    <RefreshCw size={12} />
                  </div>
                ) : (
                  <span className="text-lg font-semibold">{solanaBalance} USDC</span>
                )}
              </div>
            </div>

            {/* Base Sepolia USDC */}
            <div className="flex items-center justify-between rounded-xl border border-slate-200 bg-[#f8faf7] p-4">
              <div>
                <p className="font-semibold">USDC (Base)</p>
                <p className="text-sm text-slate-500">Base Sepolia Testnet</p>
              </div>
              <div className="text-right">
                {baseLoading ? (
                  <Loader2 size={16} className="animate-spin ml-auto" />
                ) : baseError ? (
                  <div className="flex items-center gap-2 justify-end text-red-400">
                    <AlertCircle size={14} className="flex-shrink-0" />
                    <button onClick={() => fetchBaseBalance('USDC', BASE_CHAIN_ID)} className="text-xs hover:text-red-300 transition-colors" title={baseError ?? undefined}>Retry</button>
                    <RefreshCw size={12} />
                  </div>
                ) : (
                  <span className="text-lg font-semibold">{baseBalance} USDC</span>
                )}
              </div>
            </div>

            {/* Optimism Sepolia USDC */}
            <div className="flex items-center justify-between rounded-xl border border-slate-200 bg-[#f8faf7] p-4">
              <div>
                <p className="font-semibold">USDC (Optimism)</p>
                <p className="text-sm text-slate-500">Optimism Sepolia Testnet</p>
              </div>
              <div className="text-right">
                {optimismLoading ? (
                  <Loader2 size={16} className="animate-spin ml-auto" />
                ) : optimismError ? (
                  <div className="flex items-center gap-2 justify-end text-red-400">
                    <AlertCircle size={14} className="flex-shrink-0" />
                    <button onClick={() => fetchOptimismBalance('USDC', OPTIMISM_CHAIN_ID)} className="text-xs hover:text-red-300 transition-colors" title={optimismError ?? undefined}>Retry</button>
                    <RefreshCw size={12} />
                  </div>
                ) : (
                  <span className="text-lg font-semibold">{optimismBalance} USDC</span>
                )}
              </div>
            </div>

            {/* Arbitrum Sepolia USDC */}
            <div className="flex items-center justify-between rounded-xl border border-slate-200 bg-[#f8faf7] p-4">
              <div>
                <p className="font-semibold">USDC (Arbitrum)</p>
                <p className="text-sm text-slate-500">Arbitrum Sepolia Testnet</p>
              </div>
              <div className="text-right">
                {arbitrumLoading ? (
                  <Loader2 size={16} className="animate-spin ml-auto" />
                ) : arbitrumError ? (
                  <div className="flex items-center gap-2 justify-end text-red-400">
                    <AlertCircle size={14} className="flex-shrink-0" />
                    <button onClick={() => fetchArbitrumBalance('USDC', ARBITRUM_CHAIN_ID)} className="text-xs hover:text-red-300 transition-colors" title={arbitrumError ?? undefined}>Retry</button>
                    <RefreshCw size={12} />
                  </div>
                ) : (
                  <span className="text-lg font-semibold">{arbitrumBalance} USDC</span>
                )}
              </div>
            </div>
          </div>
        </Card>

        {/* Bridge Statistics */}
        <Card>
          <h3 className="text-lg font-semibold mb-4">Bridge Transactions</h3>
          {bridgeRoutes.length === 0 ? (
            <p className="text-sm text-slate-500">No bridge transactions recorded yet.</p>
          ) : (
            <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
              {bridgeRoutes.map((route) => (
                <div key={`${route.from}→${route.to}`} className="rounded-xl border border-slate-200 bg-[#f8faf7] p-4 text-center">
                  <p className="mb-1 text-xs text-slate-500 leading-snug">{formatNetworkLabel(route.from)} → {formatNetworkLabel(route.to)}</p>
                  <p className="text-2xl font-bold text-sky-600">{route.count}</p>
                </div>
              ))}
            </div>
          )}
        </Card>

        {/* Recent Transactions */}
        <Card>
          <h3 className="text-lg font-semibold mb-4">Recent Transactions</h3>
          {transactions.length > 0 ? (
            <div className="space-y-3">
              {transactions.slice(0, 5).map((tx) => {
                const route = getTransactionRoute(tx)

                return (
                <div key={tx.id} className="rounded-xl border border-slate-200 bg-[#f8faf7] p-4">
                  <div className="flex justify-between items-start">
                    <div>
                      <p className="font-semibold text-sm">
                        {route.label} {tx.amount} USDC
                      </p>
                      <p className="text-xs text-slate-500">
                        {formatNetworkLabel(route.fromNetwork)} → {formatNetworkLabel(route.toNetwork)}
                      </p>
                      <p className="text-xs text-slate-500">
                        {new Date(tx.timestamp).toLocaleString()}
                      </p>
                    </div>
                    <div className="text-right">
                      {route.sourceExplorerUrl && (
                        <a
                          href={route.sourceExplorerUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-blue-400 hover:text-blue-300 text-xs"
                        >
                          View Tx
                        </a>
                      )}
                    </div>
                  </div>
                </div>
              )})}
            </div>
          ) : (
            <div className="py-8 text-center text-slate-500">
              <p>No recent transactions</p>
            </div>
          )}
        </Card>
      </div>
    </Container>
  )
}
