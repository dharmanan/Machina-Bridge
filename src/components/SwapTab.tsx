import { useState, useEffect } from 'react'
import { useAccount } from 'wagmi'
import { Card, Button, Input, Container } from './ui'
import { ArrowDownUp, Loader2, AlertCircle, CheckCircle, ExternalLink, RefreshCw } from 'lucide-react'
import { useSwap } from '../hooks/useSwap'

export function SwapTab() {
  const { isConnected } = useAccount()
  const { state, setInputAmount, toggleDirection, executeSwap, fetchBalances } = useSwap()
  const [localInputAmount, setLocalInputAmount] = useState('')

  // Update parent state when user changes input
  useEffect(() => {
    setInputAmount(localInputAmount)
  }, [localInputAmount, setInputAmount])

  // Auto-fetch balances when component mounts and wallet is connected
  useEffect(() => {
    if (isConnected) {
      fetchBalances()
    }
  }, [isConnected, fetchBalances])

  if (!isConnected) {
    return (
      <Container className="py-12">
        <Card className="text-center">
          <ArrowDownUp size={48} className="mx-auto mb-4 text-dark-400" />
          <h2 className="text-xl font-semibold mb-2">Connect Your Wallet</h2>
          <p className="text-dark-400">Connect your wallet to swap ETH for USDC on Sepolia</p>
        </Card>
      </Container>
    )
  }

  return (
    <Container className="py-12">
      <div className="max-w-md mx-auto">
        <Card>
          <h2 className="text-2xl font-bold mb-2">ETH ↔ USDC Swap</h2>
          <p className="text-dark-400 text-sm mb-6">Swap on Sepolia using Uniswap V2 Protocol</p>

          <div className="space-y-4">
            {/* Input Amount */}
            <div>
              <label className="text-sm font-medium text-dark-300 mb-2 block">From</label>
              <div className="flex gap-2">
                <Input
                  type="number"
                  placeholder="0.0"
                  value={localInputAmount}
                  onChange={(e) => setLocalInputAmount(e.target.value)}
                  disabled={state.isLoading}
                  className="flex-1"
                />
                <button className="px-4 py-2 bg-dark-700 hover:bg-dark-600 rounded-lg font-semibold transition-colors">
                  {state.isEthToUsdc ? 'ETH' : 'USDC'}
                </button>
              </div>
              {/* Balance Display */}
              <div className="flex justify-between items-center mt-2">
                <span className="text-xs text-dark-400">
                  Balance: {state.isLoadingBalance ? (
                    <span className="flex items-center gap-1">
                      <Loader2 size={10} className="animate-spin" />
                      Loading...
                    </span>
                  ) : (
                    (state.isEthToUsdc ? 
                      (state.ethBalance ? `${parseFloat(state.ethBalance).toFixed(4)} ETH` : '0 ETH') :
                      (state.usdcBalance ? `${parseFloat(state.usdcBalance).toFixed(2)} USDC` : '0 USDC')
                    )
                  )}
                </span>
                <div className="flex gap-2">
                  <button
                    onClick={() => fetchBalances()}
                    className="text-xs text-blue-400 hover:text-blue-300 transition-colors p-1"
                    disabled={state.isLoadingBalance}
                    title="Refresh balance"
                  >
                    <RefreshCw size={12} className={state.isLoadingBalance ? 'animate-spin' : ''} />
                  </button>
                  <button
                    onClick={() => {
                      const balance = state.isEthToUsdc ? state.ethBalance : state.usdcBalance
                      if (balance && parseFloat(balance) > 0) {
                        const maxAmount = Math.max(0, parseFloat(balance) - 0.01) // Leave some for gas
                        setLocalInputAmount(maxAmount.toString())
                      }
                    }}
                    className="text-xs text-blue-400 hover:text-blue-300 transition-colors"
                    disabled={state.isLoadingBalance || !state.ethBalance || !state.usdcBalance}
                  >
                    MAX
                  </button>
                </div>
              </div>
            </div>

            {/* Swap Arrow */}
            <div className="flex justify-center">
              <button
                onClick={toggleDirection}
                className="p-2 bg-dark-700 hover:bg-dark-600 rounded-lg transition-colors"
                disabled={state.isLoading}
              >
                <ArrowDownUp size={20} />
              </button>
            </div>

            {/* Output Amount */}
            <div>
              <label className="text-sm font-medium text-dark-300 mb-2 block">To (Estimated)</label>
              <div className="flex gap-2">
                <Input
                  type="text"
                  value={state.outputAmount}
                  disabled
                  className="flex-1 opacity-50"
                />
                <button className="px-4 py-2 bg-dark-700 hover:bg-dark-600 rounded-lg font-semibold transition-colors">
                  {state.isEthToUsdc ? 'USDC' : 'ETH'}
                </button>
              </div>
              {state.outputAmount && (
                <p className="text-xs text-dark-400 mt-1">
                  Rate: 1 {state.isEthToUsdc ? 'ETH' : 'USDC'} = {state.outputAmount && localInputAmount ? (parseFloat(state.outputAmount) / parseFloat(localInputAmount)).toFixed(6) : '~'} {state.isEthToUsdc ? 'USDC' : 'ETH'}
                </p>
              )}
            </div>

            {/* Network Info */}
            <div className="p-3 bg-arc-dark-700 rounded-lg text-sm">
              <p className="text-arc-text-secondary">Network: <span className="text-white font-semibold">Ethereum Sepolia</span></p>
              {state.isEthToUsdc && (
                <p className="text-arc-text-secondary mt-1">
                  Daily Limit: <span className={state.ethSwapLimitReached ? 'text-red-400' : 'text-green-400'}>
                    {state.ethSwapUsedToday}/0.1 ETH
                  </span>
                </p>
              )}
            </div>

            {/* Error Display */}
            {state.error && (
              <div className="flex items-start p-3 bg-red-500/20 rounded-lg text-red-300">
                <AlertCircle size={16} className="mr-2 mt-0.5 flex-shrink-0" />
                <span className="text-sm">{state.error}</span>
              </div>
            )}

            {/* Success Display */}
            {state.status && state.status.includes('successful') && (
              <div className="flex items-start p-3 bg-green-500/20 rounded-lg text-green-300">
                <CheckCircle size={16} className="mr-2 mt-0.5 flex-shrink-0" />
                <div className="text-sm">
                  <p className="font-semibold">Swap Successful!</p>
                  {state.txHash && (
                    <a
                      href={`https://sepolia.etherscan.io/tx/${state.txHash}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-xs mt-1 flex items-center gap-1 hover:underline"
                    >
                      View on Etherscan
                      <ExternalLink size={12} />
                    </a>
                  )}
                </div>
              </div>
            )}

            {/* Status Display */}
            {state.status && !state.status.includes('successful') && (
              <div className="p-3 bg-blue-500/20 rounded-lg text-blue-300 text-sm flex items-center gap-2">
                <Loader2 size={16} className="animate-spin" />
                {state.status}
              </div>
            )}

            {/* Swap Button */}
            <Button
              onClick={executeSwap}
              loading={state.isLoading}
              disabled={
                state.isLoading || 
                !localInputAmount || 
                parseFloat(localInputAmount) <= 0 || 
                !state.outputAmount || 
                parseFloat(state.outputAmount) <= 0 ||
                (state.isEthToUsdc && (state.ethSwapLimitReached || (parseFloat(state.ethSwapUsedToday) + parseFloat(localInputAmount || '0')) > 0.1))
              }
              className="w-full"
            >
              {state.isLoading ? (
                <>
                  <Loader2 size={16} className="animate-spin mr-2" />
                  Processing...
                </>
              ) : (
                `Swap ${localInputAmount || '0'} ${state.isEthToUsdc ? 'ETH' : 'USDC'}`
              )}
            </Button>
          </div>

          <div className="mt-6 p-4 bg-arc-dark-800 rounded-lg border border-arc-dark-700">
            <p className="text-xs text-arc-text-secondary">
              ℹ️ <strong>Real swap on Sepolia testnet</strong> using Uniswap V2 Protocol. Requires MetaMask connected to Sepolia with ETH or USDC.
            </p>
          </div>
        </Card>
      </div>
    </Container>
  )
}
