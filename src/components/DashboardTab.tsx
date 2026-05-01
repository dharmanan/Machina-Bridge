import { useAccount } from 'wagmi'
import { useEffect, useState } from 'react'
import { Card, Container } from './ui'
import { Wallet, TrendingUp, Loader2, AlertCircle, RefreshCw } from 'lucide-react'
import { useBridgeKit, SEPOLIA_CHAIN_ID, ARC_CHAIN_ID } from '../hooks/useBridgeKit'
import { usePhantomSolana } from '../hooks/usePhantomSolana'
import { getSupportedEvmChainName } from '../lib/chains'

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

  const [transactions, setTransactions] = useState<Transaction[]>([])

  // Fetch balances on mount and when address changes
  useEffect(() => {
    if (isConnected && address) {
      // Fetch Sepolia balance
      fetchTokenBalance('USDC', SEPOLIA_CHAIN_ID)
      
      // Fetch Arc balance
      fetchArcBalance('USDC', ARC_CHAIN_ID)
    }
  }, [address, isConnected, fetchTokenBalance, fetchArcBalance])

  // Load transactions from localStorage
  useEffect(() => {
    const savedTransactions = JSON.parse(localStorage.getItem('bridgeTransactions') || '[]')
    setTransactions(savedTransactions)
  }, [])

  // Calculate bridge statistics
  const sepoliaToArcCount = transactions.filter(t => t.direction === 'sepolia-to-arc').length
  const arcToSepoliaCount = transactions.filter(t => t.direction === 'arc-to-sepolia').length
  const solanaForwardCount = transactions.filter(
    (t) => t.type === 'solana-forward' || t.direction.includes('solana') || t.toNetwork === 'Solana Devnet'
  ).length
  const solanaToArcCount = transactions.filter(
    (t) => t.type === 'solana-bridge' || t.direction === 'solana-to-arc' || t.fromNetwork === 'Solana Devnet'
  ).length

  const getTransactionRoute = (transaction: Transaction) => {
    if (transaction.type === 'solana-bridge' || transaction.direction === 'solana-to-arc' || transaction.fromNetwork === 'Solana Devnet') {
      return {
        label: 'Bridge',
        fromNetwork: 'Solana Devnet',
        toNetwork: 'Arc Testnet',
        sourceExplorerUrl: transaction.sourceTxHash
          ? `https://explorer.solana.com/tx/${transaction.sourceTxHash}?cluster=devnet`
          : undefined,
      }
    }

    if (transaction.type === 'solana-forward' || transaction.direction.includes('solana') || transaction.toNetwork === 'Solana Devnet') {
      return {
        label: 'Solana Forward',
        fromNetwork: transaction.fromNetwork || (transaction.direction === 'arc-to-solana' ? 'Arc Testnet' : 'Sepolia'),
        toNetwork: 'Solana Devnet',
        sourceExplorerUrl:
          transaction.sourceTxHash
            ? transaction.fromNetwork === 'Arc Testnet' || transaction.direction === 'arc-to-solana'
              ? `https://testnet.arcscan.app/tx/${transaction.sourceTxHash}`
              : `https://sepolia.etherscan.io/tx/${transaction.sourceTxHash}`
            : undefined,
      }
    }

    if (transaction.direction === 'arc-to-sepolia') {
      return {
        label: 'Bridge',
        fromNetwork: 'Arc Testnet',
        toNetwork: 'Sepolia',
        sourceExplorerUrl: transaction.sourceTxHash ? `https://testnet.arcscan.app/tx/${transaction.sourceTxHash}` : undefined,
      }
    }

    return {
      label: 'Bridge',
      fromNetwork: 'Sepolia',
      toNetwork: 'Arc Testnet',
      sourceExplorerUrl: transaction.sourceTxHash ? `https://sepolia.etherscan.io/tx/${transaction.sourceTxHash}` : undefined,
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
                      title={arcError}
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
          </div>
        </Card>

        {/* Bridge Statistics */}
        <Card>
          <h3 className="text-lg font-semibold mb-4">Bridge Transactions</h3>
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
            <div className="rounded-xl border border-slate-200 bg-[#f8faf7] p-4 text-center">
              <p className="mb-1 text-sm text-slate-500">Sepolia → Arc</p>
              <p className="text-2xl font-bold text-green-400">{sepoliaToArcCount}</p>
            </div>
            <div className="rounded-xl border border-slate-200 bg-[#f8faf7] p-4 text-center">
              <p className="mb-1 text-sm text-slate-500">Arc → Sepolia</p>
              <p className="text-2xl font-bold text-sky-600">{arcToSepoliaCount}</p>
            </div>
            <div className="rounded-xl border border-slate-200 bg-[#f8faf7] p-4 text-center">
              <p className="mb-1 text-sm text-slate-500">To Solana</p>
              <p className="text-2xl font-bold text-amber-600">{solanaForwardCount}</p>
            </div>
            <div className="rounded-xl border border-slate-200 bg-[#f8faf7] p-4 text-center">
              <p className="mb-1 text-sm text-slate-500">Solana → Arc</p>
              <p className="text-2xl font-bold text-cyan-600">{solanaToArcCount}</p>
            </div>
          </div>
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
                        {route.fromNetwork} → {route.toNetwork}
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
