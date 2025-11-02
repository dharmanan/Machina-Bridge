import { useEffect, useState } from 'react'
import { useAccount } from 'wagmi'
import { ethers } from 'ethers'
import { Card, Button, Input, Container } from './ui'
import { UNISWAP_SEPOLIA } from '../config/networks'
import { ArrowDownUp } from 'lucide-react'

// Uniswap V2 Router ABI (minimal)
const ROUTER_ABI = [
  'function getAmountsOut(uint amountIn, address[] calldata path) external view returns (uint[] memory amounts)',
  'function swapExactETHForTokens(uint amountOutMin, address[] calldata path, address to, uint deadline) external payable returns (uint[] memory amounts)',
  'function swapExactTokensForETH(uint amountIn, uint amountOutMin, address[] calldata path, address to, uint deadline) external returns (uint[] memory amounts)',
]

// ERC20 ABI minimal
const ERC20_ABI = [
  'function approve(address spender, uint256 amount) external returns (bool)',
  'function balanceOf(address account) external view returns (uint256)',
  'function allowance(address owner, address spender) external view returns (uint256)',
]

export function SwapTab() {
  const { address } = useAccount()
  const [amountIn, setAmountIn] = useState('')
  const [estimatedOut, setEstimatedOut] = useState<string>('')
  const [isReversed, setIsReversed] = useState(false)
  const [slippage, setSlippage] = useState('0.5')
  const [isLoading, setIsLoading] = useState(false)
  const [provider, setProvider] = useState<any>(null)

  // Setup provider
  useEffect(() => {
    if (typeof window !== 'undefined' && (window as any).ethereum) {
      const ethProvider = new ethers.BrowserProvider((window as any).ethereum)
      setProvider(ethProvider)
    }
  }, [])

  const tokenIn = isReversed ? UNISWAP_SEPOLIA.USDC : UNISWAP_SEPOLIA.WETH
  const tokenOut = isReversed ? UNISWAP_SEPOLIA.WETH : UNISWAP_SEPOLIA.USDC
  const tokenInSymbol = isReversed ? 'USDC' : 'ETH'
  const tokenOutSymbol = isReversed ? 'ETH' : 'USDC'
  const decimalsIn = isReversed ? 6 : 18
  const decimalsOut = isReversed ? 18 : 6

  // Estimate swap output
  const estimateSwap = async () => {
    if (!provider || !amountIn) {
      setEstimatedOut('')
      return
    }

    try {
      const router = new ethers.Contract(
        UNISWAP_SEPOLIA.ROUTER,
        ROUTER_ABI,
        provider
      )

      const amountInWei = ethers.parseUnits(amountIn, decimalsIn)
      const path = [tokenIn, tokenOut]

      const amounts = await router.getAmountsOut(amountInWei, path)
      const outAmount = ethers.formatUnits(amounts[1], decimalsOut)

      setEstimatedOut(outAmount)
    } catch (error) {
      console.error('Estimation error:', error)
      setEstimatedOut('')
    }
  }

  // Re-estimate when inputs change
  useEffect(() => {
    const timer = setTimeout(() => {
      estimateSwap()
    }, 500)

    return () => clearTimeout(timer)
  }, [amountIn, isReversed, provider])

  const handleSwap = async () => {
    if (!address || !provider || !amountIn || !estimatedOut) {
      alert('Missing swap details')
      return
    }

    setIsLoading(true)
    try {
      const signer = await provider.getSigner()
      const router = new ethers.Contract(
        UNISWAP_SEPOLIA.ROUTER,
        ROUTER_ABI,
        signer
      )

      const amountInWei = ethers.parseUnits(amountIn, decimalsIn)
      const slippageDecimal = parseFloat(slippage) / 100
      const minOut = ethers.parseUnits(
        (parseFloat(estimatedOut) * (1 - slippageDecimal)).toString(),
        decimalsOut
      )

      const path = [tokenIn, tokenOut]
      const deadline = Math.floor(Date.now() / 1000) + 60 * 20 // 20 minutes

      let tx

      if (isReversed) {
        // USDC -> ETH
        const token = new ethers.Contract(tokenIn, ERC20_ABI, signer)
        const allowance = await token.allowance(address, UNISWAP_SEPOLIA.ROUTER)

        if (allowance < amountInWei) {
          const approveTx = await token.approve(
            UNISWAP_SEPOLIA.ROUTER,
            amountInWei
          )
          await approveTx.wait()
        }

        tx = await router.swapExactTokensForETH(
          amountInWei,
          minOut,
          path,
          address,
          deadline
        )
      } else {
        // ETH -> USDC
        tx = await router.swapExactETHForTokens(
          minOut,
          path,
          address,
          deadline,
          { value: amountInWei }
        )
      }

      await tx.wait()
      alert('Swap successful!')
      setAmountIn('')
      setEstimatedOut('')
    } catch (error) {
      console.error('Swap error:', error)
      alert('Swap failed: ' + (error instanceof Error ? error.message : 'Unknown error'))
    } finally {
      setIsLoading(false)
    }
  }

  return (
    <Container className="py-12">
      <div className="max-w-md mx-auto">
        <Card>
          <h2 className="text-2xl font-bold mb-6">Swap Tokens</h2>

          <div className="space-y-4">
            {/* Amount In */}
            <div>
              <div className="flex justify-between mb-2">
                <label className="text-sm font-medium text-dark-300">From</label>
                <span className="text-xs text-dark-400">Balance: --</span>
              </div>
              <div className="flex gap-2">
                <Input
                  type="number"
                  placeholder="0.0"
                  value={amountIn}
                  onChange={(e: React.ChangeEvent<HTMLInputElement>) => setAmountIn(e.target.value)}
                  className="flex-1"
                />
                <button className="px-4 py-2 bg-dark-700 hover:bg-dark-600 rounded-lg font-semibold transition-colors">
                  {tokenInSymbol}
                </button>
              </div>
            </div>

            {/* Swap Button */}
            <div className="flex justify-center">
              <button
                onClick={() => setIsReversed(!isReversed)}
                className="p-2 bg-dark-700 hover:bg-dark-600 rounded-lg transition-colors"
              >
                <ArrowDownUp size={20} />
              </button>
            </div>

            {/* Amount Out */}
            <div>
              <div className="flex justify-between mb-2">
                <label className="text-sm font-medium text-dark-300">To</label>
                <span className="text-xs text-dark-400">Balance: --</span>
              </div>
              <div className="flex gap-2">
                <Input
                  type="number"
                  placeholder="0.0"
                  value={estimatedOut}
                  disabled
                  className="flex-1"
                />
                <button className="px-4 py-2 bg-dark-700 hover:bg-dark-600 rounded-lg font-semibold transition-colors">
                  {tokenOutSymbol}
                </button>
              </div>
              {estimatedOut && (
                <p className="text-xs text-dark-400 mt-1">
                  Price: 1 {tokenInSymbol} = {(parseFloat(estimatedOut) / parseFloat(amountIn)).toFixed(6)} {tokenOutSymbol}
                </p>
              )}
            </div>

            {/* Slippage */}
            <div>
              <label className="text-sm font-medium text-dark-300 block mb-2">
                Slippage Tolerance: {slippage}%
              </label>
              <input
                type="range"
                min="0.1"
                max="5"
                step="0.1"
                value={slippage}
                onChange={(e) => setSlippage(e.target.value)}
                className="w-full"
              />
            </div>

            {/* Swap Button */}
            <Button
              onClick={handleSwap}
              loading={isLoading}
              disabled={!address || !amountIn || !estimatedOut || isLoading}
              className="w-full mt-6"
            >
              {!address ? 'Connect Wallet' : isLoading ? 'Swapping...' : 'Swap'}
            </Button>
          </div>
        </Card>
      </div>
    </Container>
  )
}
