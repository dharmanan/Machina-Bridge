import { useEffect, useRef, useState } from 'react'
import { useAccount, useReadContract } from 'wagmi'
import { erc20Abi } from 'viem'
import {
  MAINNET_SWAP_CHAIN_ID, MAINNET_SWAP_READ_ONLY_ENABLED, MAINNET_SWAP_WRITES_ENABLED,
  MAINNET_SWAP_TOKENS, type MainnetSwapToken,
} from '../config/mainnetSwap'
import {
  hasInsufficientSwapBalance, isCurrentSwapQuote, readMainnetSwapQuote, swapPreviewError, swapRequestKey,
  swapWalletState, validateSwapRequest, type PreviewQuote, type SwapQuoteRequest,
} from '../lib/mainnetSwap'

export function useCircleSwapPreview(tokenIn: MainnetSwapToken, tokenOut: MainnetSwapToken, amount: string, slippageBps: number, active = true) {
  const { address, isConnected, chainId } = useAccount()
  const [quote, setQuote] = useState<PreviewQuote | null>(null)
  const [error, setError] = useState<{ key: string; message: string } | null>(null)
  const [loading, setLoading] = useState(false)
  const [now, setNow] = useState(Date.now)
  const controller = useRef<AbortController | null>(null)
  const generation = useRef(0)
  const walletState = swapWalletState(isConnected, chainId)
  const request: SwapQuoteRequest | null = address && walletState === 'ready'
    ? { address, chainId: MAINNET_SWAP_CHAIN_ID, tokenIn, tokenOut, amount, slippageBps } : null
  const contextKey = `${active}:${request ? swapRequestKey(request) : `${walletState}:${tokenIn}:${tokenOut}:${amount}:${slippageBps}`}`
  const balance = useReadContract({
    address: MAINNET_SWAP_TOKENS[tokenIn].address, abi: erc20Abi,
    functionName: 'balanceOf', args: address ? [address] : undefined,
    chainId: MAINNET_SWAP_CHAIN_ID, query: { enabled: walletState === 'ready' && Boolean(address), refetchInterval: 30_000 },
  })
  let validAmount = false
  let insufficientBalance = false
  if (request) {
    try {
      validateSwapRequest(request)
      validAmount = true
      // Never use a previous wallet/token's cached balance, or treat a failed read as zero.
      insufficientBalance = balance.isSuccess && hasInsufficientSwapBalance(amount, tokenIn, balance.data)
    } catch { /* Incomplete input is not a quote request. */ }
  }
  const current = active && isCurrentSwapQuote(quote, request, now) && !insufficientBalance ? quote : null

  function invalidate() {
    generation.current += 1
    controller.current?.abort()
    setLoading(false)
    setQuote(null)
    setError(null)
  }

  useEffect(() => {
    generation.current += 1
    controller.current?.abort()
    setLoading(false)
    setQuote(null)
    setError(null)
    return () => { generation.current += 1; controller.current?.abort() }
  }, [contextKey])
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1_000)
    return () => clearInterval(timer)
  }, [])

  async function loadQuote() {
    if (!active || document.hidden || !MAINNET_SWAP_READ_ONLY_ENABLED || MAINNET_SWAP_WRITES_ENABLED || !request || !validAmount || insufficientBalance || loading) return
    const expectedGeneration = ++generation.current
    controller.current?.abort()
    const nextController = new AbortController()
    controller.current = nextController
    setLoading(true)
    setQuote(null)
    setError(null)
    try {
      const result = await readMainnetSwapQuote(request, nextController.signal)
      if (generation.current === expectedGeneration && !nextController.signal.aborted) {
        setNow(Date.now())
        setQuote(result)
      }
    } catch (cause) {
      if (generation.current === expectedGeneration && !nextController.signal.aborted) setError({ key: contextKey, message: swapPreviewError(cause) })
    } finally {
      if (generation.current === expectedGeneration) setLoading(false)
    }
  }
  return { walletState, request, validAmount, insufficientBalance, balance, quote: current, expired: Boolean(quote && !current && request && quote.requestKey === swapRequestKey(request)), loading,
    error: error?.key === contextKey ? error.message : null, load: loadQuote, cancel: invalidate, now }
}
