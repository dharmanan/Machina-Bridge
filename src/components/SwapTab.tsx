import { useState, useEffect } from 'react'
import { useAccount, useSwitchChain } from 'wagmi'
import { Card, Button, Input, Container } from './ui'
import { ArrowDownUp, Loader2, AlertCircle, CheckCircle, ExternalLink, RefreshCw } from 'lucide-react'
import { useSwap } from '../hooks/useSwap'
import { SEPOLIA_EVM_CHAIN_ID } from '../lib/chains'

export function SwapTab() {
  const { isConnected, chainId } = useAccount()
  const { switchChain, isPending: isSwitchingChain } = useSwitchChain()
  const { state, setInputAmount, toggleDirection, executeSwap, fetchBalances } = useSwap()
  const [localInputAmount, setLocalInputAmount] = useState('')
  const isOnSepolia = chainId === SEPOLIA_EVM_CHAIN_ID

  useEffect(() => {
    setInputAmount(localInputAmount)
  }, [localInputAmount, setInputAmount])

  useEffect(() => {
    if (isConnected && isOnSepolia) {
      fetchBalances()
    }
  }, [isConnected, isOnSepolia, fetchBalances])

  return (
    <Container className="py-12">
      <div className="max-w-lg mx-auto">
        <Card>
          <h2 className="text-2xl font-bold mb-2">ETH ↔ USDC Swap</h2>
          <p className="text-slate-500 text-sm mb-6">Swap on Sepolia using Uniswap V2 Protocol</p>

          {!isConnected && (
            <div className="mb-4 flex items-center gap-3 rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
              <AlertCircle size={16} className="shrink-0" />
              Connect your wallet to swap ETH for USDC on Sepolia.
            </div>
          )}

          <div className="space-y-4">
            <div>
              <label className="text-sm font-medium text-slate-700 mb-2 block">From</label>
              <div className="flex gap-2">
                <Input
                  type="number"
                  placeholder="0.0"
                  value={localInputAmount}
                  onChange={(e) => setLocalInputAmount(e.target.value)}
                  disabled={state.isLoading}
                  className="flex-1"
                />
                <button className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-2 font-semibold text-slate-700 transition-colors hover:bg-slate-100">
                  {state.isEthToUsdc ? 'ETH' : 'USDC'}
                </button>
              </div>
              <div className="flex justify-between items-center mt-2">
                <span className="text-xs text-slate-500">
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
                    className="p-1 text-xs text-[#2F6E0C] transition-colors hover:text-[#25580A]"
                    disabled={state.isLoadingBalance}
                    title="Refresh balance"
                  >
                    <RefreshCw size={12} className={state.isLoadingBalance ? 'animate-spin' : ''} />
                  </button>
                  <button
                    onClick={() => {
                      const balance = state.isEthToUsdc ? state.ethBalance : state.usdcBalance
                      if (!balance || parseFloat(balance) <= 0) return

                      const numericBalance = parseFloat(balance)
                      const maxAmount = state.isEthToUsdc
                        ? Math.max(0, numericBalance - 0.01)
                        : numericBalance

                      setLocalInputAmount(maxAmount.toString())
                    }}
                    className="text-xs text-[#2F6E0C] transition-colors hover:text-[#25580A]"
                    disabled={state.isLoadingBalance || !(state.isEthToUsdc ? state.ethBalance : state.usdcBalance)}
                  >
                    MAX
                  </button>
                </div>
              </div>
            </div>

            <div className="flex justify-center">
              <button
                onClick={toggleDirection}
                className="rounded-xl border border-slate-200 bg-white p-2 text-slate-600 shadow-sm transition-colors hover:bg-slate-50"
                disabled={state.isLoading}
              >
                <ArrowDownUp size={20} />
              </button>
            </div>

            <div>
              <label className="text-sm font-medium text-slate-700 mb-2 block">To (Estimated)</label>
              <div className="flex gap-2">
                <Input
                  type="text"
                  value={state.outputAmount}
                  disabled
                  className="flex-1 opacity-50"
                />
                <button className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-2 font-semibold text-slate-700 transition-colors hover:bg-slate-100">
                  {state.isEthToUsdc ? 'USDC' : 'ETH'}
                </button>
              </div>
              {state.outputAmount && (
                <p className="text-xs text-slate-500 mt-1">
                  Rate: 1 {state.isEthToUsdc ? 'ETH' : 'USDC'} = {state.outputAmount && localInputAmount ? (parseFloat(state.outputAmount) / parseFloat(localInputAmount)).toFixed(6) : '~'} {state.isEthToUsdc ? 'USDC' : 'ETH'}
                </p>
              )}
            </div>

            <div className="rounded-2xl border border-slate-200 bg-[#f8faf7] p-4 text-sm">
              <p className="text-slate-500">Network: <span className="font-semibold text-slate-900">Ethereum Sepolia</span></p>
              <p className="mt-1 text-slate-500">Slippage tolerance: <span className="font-semibold text-slate-900">5%</span></p>
              {!isOnSepolia && (
                <div className="mt-3 flex items-center justify-between gap-3 rounded-xl border border-amber-200 bg-amber-50 p-3">
                  <p className="text-xs text-amber-900">Switch your wallet to Sepolia to read swap balances and quotes.</p>
                  <Button
                    onClick={() => switchChain({ chainId: SEPOLIA_EVM_CHAIN_ID })}
                    loading={isSwitchingChain}
                    className="shrink-0"
                  >
                    Switch to Sepolia
                  </Button>
                </div>
              )}
              {state.isEthToUsdc && (
                <p className="mt-1 text-slate-500">
                  Daily Limit: <span className={state.ethSwapLimitReached ? 'text-red-500' : 'text-[#2F6E0C]'}>
                    {state.ethSwapUsedToday}/0.1 ETH
                  </span>
                  <span className="ml-1 text-[11px] text-slate-400">(browser-side testnet guard)</span>
                </p>
              )}
            </div>

            {state.error && (
              <div className="flex items-start rounded-xl border border-red-200 bg-red-50 p-3 text-red-700">
                <AlertCircle size={16} className="mr-2 mt-0.5 flex-shrink-0" />
                <span className="text-sm">{state.error}</span>
              </div>
            )}

            {state.txHash && !state.isLoading && !state.error && (
              <div className="flex items-start rounded-xl border border-[#66D121]/25 bg-[#eef7e8] p-3 text-[#25580A]">
                <CheckCircle size={16} className="mr-2 mt-0.5 flex-shrink-0" />
                <div className="text-sm">
                  <p className="font-semibold">Latest Successful Swap</p>
                  <a
                    href={`https://sepolia.etherscan.io/tx/${state.txHash}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-xs mt-1 flex items-center gap-1 hover:underline"
                  >
                    View on Etherscan
                    <ExternalLink size={12} />
                  </a>
                </div>
              </div>
            )}

            {state.status && !state.status.includes('successful') && (
              <div className="flex items-center gap-2 rounded-xl border border-slate-200 bg-slate-50 p-3 text-sm text-slate-700">
                <Loader2 size={16} className="animate-spin" />
                {state.status}
              </div>
            )}

            <Button
              onClick={executeSwap}
              loading={state.isLoading}
              disabled={
                !isConnected ||
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

          <div className="mt-6 rounded-2xl border border-slate-200 bg-[#f8faf7] p-4">
            <p className="text-xs text-slate-500">
              ℹ️ <strong>Real swap on Sepolia testnet</strong> using Uniswap V2 Protocol. Requires an EVM wallet connected to Sepolia with ETH or USDC.
            </p>
          </div>
        </Card>
      </div>
    </Container>
  )
}
