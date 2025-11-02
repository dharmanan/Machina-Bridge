import { useAccount, useBalance } from 'wagmi'
import { Card, Container } from './ui'
import { Wallet, TrendingUp } from 'lucide-react'

export function DashboardTab() {
  const { address, isConnected } = useAccount()
  const { data: ethBalance } = useBalance({ address })

  if (!isConnected) {
    return (
      <Container className="py-12">
        <Card className="text-center">
          <Wallet size={48} className="mx-auto mb-4 text-dark-400" />
          <h2 className="text-xl font-semibold mb-2">Connect Your Wallet</h2>
          <p className="text-dark-400">Connect your wallet to see your balances and transaction history</p>
        </Card>
      </Container>
    )
  }

  return (
    <Container className="py-12">
      <div className="space-y-6">
        <h2 className="text-3xl font-bold">Dashboard</h2>

        {/* Account Info */}
        <Card>
          <h3 className="text-lg font-semibold mb-4">Account</h3>
          <div className="space-y-2">
            <div className="flex justify-between">
              <span className="text-dark-400">Address</span>
              <span className="font-mono text-sm">{address?.slice(0, 6)}...{address?.slice(-4)}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-dark-400">Network</span>
              <span>Sepolia</span>
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
            <div className="flex justify-between items-center p-3 bg-dark-700 rounded-lg">
              <div>
                <p className="font-semibold">ETH</p>
                <p className="text-sm text-dark-400">Ethereum</p>
              </div>
              <span className="text-lg font-semibold">
                {ethBalance?.formatted || '0'} ETH
              </span>
            </div>
            <div className="flex justify-between items-center p-3 bg-dark-700 rounded-lg">
              <div>
                <p className="font-semibold">USDC</p>
                <p className="text-sm text-dark-400">USD Coin</p>
              </div>
              <span className="text-lg font-semibold">0 USDC</span>
            </div>
          </div>
        </Card>

        {/* Recent Transactions */}
        <Card>
          <h3 className="text-lg font-semibold mb-4">Recent Transactions</h3>
          <div className="text-center py-8 text-dark-400">
            <p>No recent transactions</p>
          </div>
        </Card>
      </div>
    </Container>
  )
}
