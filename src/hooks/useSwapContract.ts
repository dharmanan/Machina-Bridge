import { useCallback, useState } from 'react'
import { ethers } from 'ethers'
import { SUSHISWAP_SEPOLIA } from '../config/networks'

const ROUTER_ABI = [
  'function getAmountsOut(uint amountIn, address[] calldata path) external view returns (uint[] memory amounts)',
  'function swapExactETHForTokens(uint amountOutMin, address[] calldata path, address to, uint deadline) external payable returns (uint[] memory amounts)',
  'function swapExactTokensForETH(uint amountIn, uint amountOutMin, address[] calldata path, address to, uint deadline) external returns (uint[] memory amounts)',
]

const ERC20_ABI = [
  'function approve(address spender, uint256 amount) external returns (bool)',
  'function balanceOf(address account) external view returns (uint256)',
  'function allowance(address owner, address spender) external view returns (uint256)',
]

export interface SwapParams {
  tokenIn: string
  tokenOut: string
  amountIn: string
  minAmountOut: string
  recipient: string
  slippage: number
}

export interface SwapResult {
  transactionHash: string
  amountIn: string
  amountOut: string
  timestamp: number
}

export function useSwapContract(provider: ethers.BrowserProvider | null) {
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const getAmountsOut = useCallback(
    async (amountIn: string, tokenIn: string, tokenOut: string): Promise<string> => {
      if (!provider) throw new Error('Provider not initialized')

      try {
        const router = new ethers.Contract(
          SUSHISWAP_SEPOLIA.ROUTER,
          ROUTER_ABI,
          provider
        )

        const decimalsIn = tokenIn === SUSHISWAP_SEPOLIA.WETH ? 18 : 6
        const decimalsOut = tokenOut === SUSHISWAP_SEPOLIA.WETH ? 18 : 6

        const amountInWei = ethers.parseUnits(amountIn, decimalsIn)
        const amounts = await router.getAmountsOut(amountInWei, [tokenIn, tokenOut])

        return ethers.formatUnits(amounts[1], decimalsOut)
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Failed to get amounts'
        throw new Error(message)
      }
    },
    [provider]
  )

  const executeSwap = useCallback(
    async (params: SwapParams): Promise<SwapResult> => {
      if (!provider) throw new Error('Provider not initialized')

      setIsLoading(true)
      setError(null)

      try {
        const signer = await provider.getSigner()
        const router = new ethers.Contract(
          SUSHISWAP_SEPOLIA.ROUTER,
          ROUTER_ABI,
          signer
        )

        const decimalsIn = params.tokenIn === SUSHISWAP_SEPOLIA.WETH ? 18 : 6
        const decimalsOut = params.tokenOut === SUSHISWAP_SEPOLIA.WETH ? 18 : 6

        const amountInWei = ethers.parseUnits(params.amountIn, decimalsIn)
        const minOutWei = ethers.parseUnits(params.minAmountOut, decimalsOut)
        const deadline = Math.floor(Date.now() / 1000) + 60 * 20

        let tx

        if (params.tokenIn === SUSHISWAP_SEPOLIA.WETH) {
          // ETH -> Token
          tx = await router.swapExactETHForTokens(
            minOutWei,
            [params.tokenIn, params.tokenOut],
            params.recipient,
            deadline,
            { value: amountInWei }
          )
        } else {
          // Token -> ETH
          const token = new ethers.Contract(params.tokenIn, ERC20_ABI, signer)
          const allowance = await token.allowance(params.recipient, SUSHISWAP_SEPOLIA.ROUTER)

          if (allowance < amountInWei) {
            const approveTx = await token.approve(SUSHISWAP_SEPOLIA.ROUTER, amountInWei)
            await approveTx.wait()
          }

          tx = await router.swapExactTokensForETH(
            amountInWei,
            minOutWei,
            [params.tokenIn, params.tokenOut],
            params.recipient,
            deadline
          )
        }

        const receipt = await tx.wait()

        if (!receipt) throw new Error('Transaction failed')

        return {
          transactionHash: tx.hash,
          amountIn: params.amountIn,
          amountOut: params.minAmountOut,
          timestamp: Date.now(),
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Swap failed'
        setError(message)
        throw err
      } finally {
        setIsLoading(false)
      }
    },
    [provider]
  )

  return {
    getAmountsOut,
    executeSwap,
    isLoading,
    error,
  }
}
