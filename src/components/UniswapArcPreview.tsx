import { useEffect, useRef, useState } from 'react'
import { useAccount } from 'wagmi'
import { requestKey, validateArcRequest, type ArcRequest, type ArcReview } from '../lib/uniswapArcPolicy'
import { type ArcWalletContext } from '../lib/uniswapArcPreview'
import { ReviewSourceError, createReviewSource, onchainErrorMessage, reviewSourceKind } from '../lib/swap/reviewSource'
import { isSwapSymbol } from '../lib/swap/tokens'
import { SWAP_EXECUTION } from '../config/swapExecution'

// Uniswap quotes exist for every ordered pair of the four Arc tokens. Where they come from (the Trading API for the controlled pilot
// route, the keyless pool route provider for everything else) is decided by reviewSourceKind and never changes silently.
export function isUniswapArcRoute(tokenIn: string, tokenOut: string): boolean {
  return isSwapSymbol(tokenIn) && isSwapSymbol(tokenOut) && tokenIn !== tokenOut
}

export function useUniswapArcPreview(tokenIn: string, tokenOut: string, amount: string, slippageBps: number, active = true) {
  const { address, isConnected, chainId } = useAccount()
  const [review, setReview] = useState<ArcReview | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [, setTick] = useState(0)
  const wallet = useRef<ArcWalletContext>({ owner: '', connected: false, chainId: 0 })
  wallet.current = { owner: address ?? '', connected: isConnected, chainId: chainId ?? 0 }
  const [source] = useState(() => createReviewSource(() => wallet.current, () => SWAP_EXECUTION.mode))
  const generation = useRef(0)
  const supported = isUniswapArcRoute(tokenIn, tokenOut)
  let request: ArcRequest | null = null
  if (supported && address && isConnected && chainId === 5042) {
    try {
      request = validateArcRequest({ chainId: 5042, tokenIn, tokenOut, owner: address, recipient: address,
        amount, slippageBps, minimumOutput: '1', maxNetworkFee: '100000000000000000' })
    } catch { /* Incomplete or out-of-policy input never starts a request. */ }
  }
  const contextKey = JSON.stringify([address, isConnected, chainId, tokenIn, tokenOut, amount, slippageBps, active])
  const current = active && review && request ? source.current(request) : null
  const remainingMs = current && request ? source.remainingMs(request) : 0

  function invalidate() {
    generation.current++
    source.invalidate()
    setReview(null)
    setLoading(false)
    setError(null)
  }
  useEffect(() => {
    invalidate()
    return () => { generation.current++; source.invalidate() }
  }, [contextKey, source])
  useEffect(() => {
    const timer = setInterval(() => setTick(tick => tick + 1), 500)
    const hidden = () => { if (document.hidden) invalidate() }
    document.addEventListener('visibilitychange', hidden)
    return () => { clearInterval(timer); document.removeEventListener('visibilitychange', hidden) }
  }, [source])

  async function load() {
    if (!active || document.hidden || !request || loading) return
    const input = request
    invalidate()
    const expected = generation.current
    setLoading(true)
    try {
      const result = await source.read(input)
      if (generation.current === expected && source.current(input) && requestKey(result.request) === requestKey(input)) {
        setTick(tick => tick + 1)
        setReview(result)
      } else if (generation.current === expected) setError(onchainErrorMessage(new ReviewSourceError('expired')))
    } catch (cause) {
      if (generation.current === expected) setError(onchainErrorMessage(cause))
    } finally {
      if (generation.current === expected) setLoading(false)
    }
  }
  return { supported, request, current, remainingMs, expired: Boolean(review && !current), loading, error, load, cancel: invalidate,
    source: request ? reviewSourceKind(SWAP_EXECUTION.mode, request) : null,
    invalidAmount: Boolean(supported && isConnected && chainId === 5042 && amount && !request) }
}
