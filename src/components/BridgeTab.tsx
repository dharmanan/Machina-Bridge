import { useState, useEffect } from 'react'
import { useAccount } from 'wagmi'
import { Card, Button, Input, Container } from './ui'
import { useBridgeKit, BridgeToken, SEPOLIA_CHAIN_ID, ARC_CHAIN_ID, CHAIN_TOKENS } from '../hooks/useBridgeKit'
import { ArrowLeftRight, Loader2, CheckCircle, AlertCircle, ExternalLink } from 'lucide-react'

export function BridgeTab() {
  const { address, isConnected, chainId } = useAccount()
  const { state, tokenBalance, isLoadingBalance, balanceError, fetchTokenBalance, bridge, reset } = useBridgeKit()
  
  const [amount, setAmount] = useState('')
  const [direction, setDirection] = useState<'sepolia-to-arc' | 'arc-to-sepolia'>('sepolia-to-arc')
  const [selectedToken] = useState<BridgeToken>('USDC')

  const sourceChainId = direction === 'sepolia-to-arc' ? SEPOLIA_CHAIN_ID : ARC_CHAIN_ID
  const destinationChainId = direction === 'sepolia-to-arc' ? ARC_CHAIN_ID : SEPOLIA_CHAIN_ID
  const sourceChainName = direction === 'sepolia-to-arc' ? 'Sepolia' : 'Arc Testnet'
  const destinationChainName = direction === 'sepolia-to-arc' ? 'Arc Testnet' : 'Sepolia'

  // Fetch balance when direction changes or address changes
  useEffect(() => {
    if (address && isConnected) {
      fetchTokenBalance(selectedToken, sourceChainId)
    }
  }, [address, isConnected, selectedToken, sourceChainId, fetchTokenBalance])

  const handleBridge = async () => {
    if (!amount || parseFloat(amount) <= 0) {
      alert('Please enter a valid amount')
      return
    }
    await bridge(selectedToken, amount, direction)
  }

  const handleSwapDirection = () => {
    setDirection(direction === 'sepolia-to-arc' ? 'arc-to-sepolia' : 'sepolia-to-arc')
    setAmount('')
  }

  if (!isConnected) {
    return (
      <Container className="py-12">
        <Card className="text-center">
          <ArrowLeftRight size={48} className="mx-auto mb-4 text-dark-400" />
          <h2 className="text-xl font-semibold mb-2">Connect Your Wallet</h2>
          <p className="text-dark-400">Connect your wallet to bridge USDC between Sepolia and Arc Testnet</p>
        </Card>
      </Container>
    )
  }

  return (
    <Container className="py-12">
      <div className="max-w-md mx-auto">
        <Card>
          <h2 className="text-2xl font-bold mb-6">Bridge USDC</h2>

          <div className="space-y-4">
            {/* Chain Selection */}
            <div className="bg-dark-700 rounded-lg p-4">
              <div className="flex items-center justify-between">
                <div className="text-center flex-1">
                  <p className="text-xs text-dark-400 mb-1">From</p>
                  <p className="font-semibold">{sourceChainName}</p>
                </div>
                <button
                  onClick={handleSwapDirection}
                  className="mx-4 p-2 bg-blue-600 hover:bg-blue-700 rounded-lg transition-colors"
                  disabled={state.isLoading}
                >
                  <ArrowLeftRight size={18} />
                </button>
                <div className="text-center flex-1">
                  <p className="text-xs text-dark-400 mb-1">To</p>
                  <p className="font-semibold">{destinationChainName}</p>
                </div>
              </div>
            </div>

            {/* Token Selection (USDC only) */}
            <div>
              <label className="text-sm font-medium text-dark-300 mb-2 block">Token</label>
              <div className="px-4 py-3 bg-dark-700 rounded-lg">
                <span className="font-semibold">USDC</span>
                <span className="text-sm text-dark-400 ml-2">(USD Coin)</span>
              </div>
            </div>

            {/* Balance Display */}
            {isLoadingBalance ? (
              <div className="flex items-center justify-center p-3 bg-dark-700 rounded-lg">
                <Loader2 size={16} className="animate-spin mr-2" />
                <span className="text-sm">Loading balance...</span>
              </div>
            ) : balanceError ? (
              <div className="flex items-center p-3 bg-red-500/20 rounded-lg text-red-300">
                <AlertCircle size={16} className="mr-2" />
                <span className="text-sm">{balanceError}</span>
              </div>
            ) : (
              <div className="p-3 bg-dark-700 rounded-lg">
                <p className="text-xs text-dark-400 mb-1">{sourceChainName} {selectedToken} Balance</p>
                <p className="text-lg font-semibold">{tokenBalance} {selectedToken}</p>
              </div>
            )}

            {/* Amount Input */}
            <div>
              <label className="text-sm font-medium text-dark-300 mb-2 block">Amount</label>
              <Input
                type="number"
                placeholder="0.00"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                disabled={state.isLoading}
                className="w-full"
              />
              {parseFloat(amount) > parseFloat(tokenBalance) && (
                <p className="text-xs text-red-400 mt-1">Amount exceeds balance</p>
              )}
            </div>

            {/* Status Messages */}
            {state.error && (
              <div className="flex items-start p-3 bg-red-500/20 rounded-lg text-red-300">
                <AlertCircle size={16} className="mr-2 mt-0.5 flex-shrink-0" />
                <span className="text-sm">{state.error}</span>
              </div>
            )}

            {state.isLoading && state.step !== 'success' && (
              <div className="flex items-start p-3 bg-blue-500/20 rounded-lg text-blue-300">
                <Loader2 size={16} className="mr-2 mt-0.5 flex-shrink-0 animate-spin" />
                <div className="text-sm">
                  <p className="font-semibold">
                    {state.step === 'switching-network' && 'Switching to source network...'}
                    {state.step === 'approving' && 'Approving USDC spend...'}
                    {state.step === 'signing-bridge' && 'Signing bridge transaction...'}
                    {state.step === 'waiting-receive-message' && 'Waiting for receive confirmation...'}
                    {!['switching-network', 'approving', 'signing-bridge', 'waiting-receive-message'].includes(state.step) && 'Processing...'}
                  </p>
                </div>
              </div>
            )}

            {state.step === 'success' && (
              <div className="space-y-2 p-3 bg-green-500/20 rounded-lg text-green-300">
                <div className="flex items-start gap-2">
                  <CheckCircle size={16} className="mt-0.5 flex-shrink-0" />
                  <div className="text-sm">
                    <p className="font-semibold">Bridge Successful! 🎉</p>
                    <p className="text-xs mt-1">USDC successfully transferred from {sourceChainName} to {destinationChainName}</p>
                  </div>
                </div>
                
                {/* Transaction Links */}
                <div className="space-y-1 mt-3 pt-3 border-t border-green-400/20">
                  {state.sourceTxHash && (
                    <a
                      href={
                        sourceChainId === SEPOLIA_CHAIN_ID
                          ? `https://sepolia.etherscan.io/tx/${state.sourceTxHash}`
                          : `https://testnet.arcscan.app/tx/${state.sourceTxHash}`
                      }
                      target="_blank"
                      rel="noopener noreferrer"
                      className="flex items-center gap-2 text-xs hover:text-green-100 transition-colors"
                    >
                      <span>View {sourceChainName} Tx</span>
                      <ExternalLink size={12} />
                    </a>
                  )}
                  {state.receiveTxHash && (
                    <a
                      href={
                        destinationChainId === SEPOLIA_CHAIN_ID
                          ? `https://sepolia.etherscan.io/tx/${state.receiveTxHash}`
                          : `https://testnet.arcscan.app/tx/${state.receiveTxHash}`
                      }
                      target="_blank"
                      rel="noopener noreferrer"
                      className="flex items-center gap-2 text-xs hover:text-green-100 transition-colors"
                    >
                      <span>View {destinationChainName} Tx</span>
                      <ExternalLink size={12} />
                    </a>
                  )}
                </div>
              </div>
            )}

            {/* Bridge Button */}
            <Button
              onClick={handleBridge}
              disabled={state.isLoading || !amount || parseFloat(amount) <= 0 || parseFloat(amount) > parseFloat(tokenBalance)}
              loading={state.isLoading}
              className="w-full"
            >
              {state.isLoading ? (
                <>
                  <Loader2 size={16} className="animate-spin mr-2" />
                  {state.step === 'switching-network' ? 'Switching Network...' : 'Bridging...'}
                </>
              ) : state.step === 'success' ? (
                'Bridge Complete'
              ) : (
                `Bridge ${amount || '0'} ${selectedToken}`
              )}
            </Button>

            {/* Reset Button (after success) */}
            {state.step === 'success' && (
              <button
                onClick={() => {
                  reset()
                  setAmount('')
                }}
                className="w-full px-4 py-2 bg-dark-700 hover:bg-dark-600 rounded-lg transition-colors text-sm"
              >
                Bridge Again
              </button>
            )}
          </div>
        </Card>

        {/* Info Box */}
        <div className="mt-6 p-4 bg-dark-800 border border-dark-700 rounded-lg">
          <p className="text-sm text-dark-400">
            Bridge USDC bidirectionally between Ethereum Sepolia and Arc Testnet using Circle Bridge Kit.
          </p>
        </div>
      </div>
    </Container>
  )
}
