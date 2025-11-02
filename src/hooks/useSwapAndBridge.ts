import { useState, useCallback } from 'react'

export function useSwap() {
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const swap = useCallback(async (
    routerAddress: string,
    tokenIn: string,
    tokenOut: string,
    amountIn: string,
    minAmountOut: string,
    recipient: string
  ) => {
    setIsLoading(true)
    setError(null)

    try {
      // Swap logic akan diimplementasikan dengan ethers.js
      console.log('Swap:', {
        routerAddress,
        tokenIn,
        tokenOut,
        amountIn,
        minAmountOut,
        recipient,
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Swap failed'
      setError(message)
      console.error('Swap error:', err)
    } finally {
      setIsLoading(false)
    }
  }, [])

  return { swap, isLoading, error }
}

export function useBridge() {
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const bridge = useCallback(async (
    tokenAddress: string,
    amount: string,
    destChain: string,
    recipient: string
  ) => {
    setIsLoading(true)
    setError(null)

    try {
      // Bridge logic akan diimplementasikan dengan Circle SDK
      console.log('Bridge:', {
        tokenAddress,
        amount,
        destChain,
        recipient,
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Bridge failed'
      setError(message)
      console.error('Bridge error:', err)
    } finally {
      setIsLoading(false)
    }
  }, [])

  return { bridge, isLoading, error }
}
