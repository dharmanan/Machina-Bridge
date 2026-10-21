import { useEffect, useRef, useState } from 'react'
import { useAccount } from 'wagmi'
import { ARC_OUTPUTS, requestKey, validateArcRequest, type ArcRequest, type ArcReview } from '../lib/uniswapArcPolicy'
import { ArcPreviewError, createUniswapArcPreviewReader, uniswapArcPreviewErrorMessage, type ArcWalletContext } from '../lib/uniswapArcPreview'

// Uniswap exists only for native USDC -> a verified Arc output token; every other route is Circle-only.
export function isUniswapArcRoute(tokenIn: string, tokenOut: string): tokenOut is keyof typeof ARC_OUTPUTS {
  return tokenIn === 'USDC' && Object.prototype.hasOwnProperty.call(ARC_OUTPUTS, tokenOut)
}

export function useUniswapArcPreview(tokenIn: string, tokenOut: string, amount: string, slippageBps: number, active = true) {
  const { address, isConnected, chainId } = useAccount()
  const [review, setReview] = useState<ArcReview | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [, setTick] = useState(0)
  const wallet = useRef<ArcWalletContext>({ owner: '', connected: false, chainId: 0 })
  wallet.current = { owner: address ?? '', connected: isConnected, chainId: chainId ?? 0 }
  const [reader] = useState(() => createUniswapArcPreviewReader(() => wallet.current))
  const generation = useRef(0)
  const supported = isUniswapArcRoute(tokenIn, tokenOut)
  let request: ArcRequest | null = null
  if (supported && address && isConnected && chainId === 5042) {
    try {
      request = validateArcRequest({ chainId: 5042, tokenIn: 'USDC', tokenOut, owner: address, recipient: address,
        amount, slippageBps, minimumOutput: '1', maxNetworkFee: '100000000000000000' })
    } catch { /* Incomplete or out-of-policy input never starts a request. */ }
  }
  const contextKey = JSON.stringify([address, isConnected, chainId, tokenIn, tokenOut, amount, slippageBps, active])
  const current = active && review && request ? reader.current(request) : null
  const remainingMs = current && request ? reader.remainingMs(request) : 0

  function invalidate() {
    generation.current++
    reader.invalidate()
    setReview(null)
    setLoading(false)
    setError(null)
  }
  useEffect(() => {
    invalidate()
    return () => { generation.current++; reader.invalidate() }
  }, [contextKey, reader])
  useEffect(() => {
    const timer = setInterval(() => setTick(tick => tick + 1), 500)
    const hidden = () => { if (document.hidden) invalidate() }
    document.addEventListener('visibilitychange', hidden)
    return () => { clearInterval(timer); document.removeEventListener('visibilitychange', hidden) }
  }, [reader])

  async function load() {
    if (!active || document.hidden || !request || loading) return
    const input = request
    invalidate()
    const expected = generation.current
    setLoading(true)
    try {
      const result = await reader.read(input)
      if (generation.current === expected && reader.current(input) && requestKey(result.request) === requestKey(input)) {
        setTick(tick => tick + 1)
        setReview(result)
      } else if (generation.current === expected) setError(uniswapArcPreviewErrorMessage(new ArcPreviewError('expired')))
    } catch (cause) {
      if (generation.current === expected) setError(uniswapArcPreviewErrorMessage(cause))
    } finally {
      if (generation.current === expected) setLoading(false)
    }
  }
  return { supported, request, current, remainingMs, expired: Boolean(review && !current), loading, error, load, cancel: invalidate,
    invalidAmount: Boolean(supported && isConnected && chainId === 5042 && amount && !request) }
}
