import { useEffect, useRef, useState } from 'react'
import { useAccount, useReadContract } from 'wagmi'
import { erc20Abi, formatUnits } from 'viem'
import { ArrowDownUp } from 'lucide-react'
import { Container } from './ui'
import {
  MAINNET_SWAP_CHAIN_ID, MAINNET_SWAP_READ_ONLY_ENABLED, MAINNET_SWAP_WRITES_ENABLED,
  MAINNET_SWAP_TOKENS, MAINNET_SWAP_SLIPPAGE_BPS, type MainnetSwapToken,
} from '../config/mainnetSwap'
import {
  hasInsufficientSwapBalance, isCurrentSwapQuote, readMainnetSwapQuote, swapPreviewError, swapRequestKey,
  swapWalletState, validateSwapRequest, type PreviewQuote, type SwapQuoteRequest,
} from '../lib/mainnetSwap'

export default function MainnetSwapPreview() {
  const { address, isConnected, chainId } = useAccount()
  const [tokenIn, setTokenIn] = useState<MainnetSwapToken>('USDC')
  const [tokenOut, setTokenOut] = useState<MainnetSwapToken>('EURC')
  const [amount, setAmount] = useState('')
  const [slippageBps, setSlippageBps] = useState(100)
  const [quote, setQuote] = useState<PreviewQuote | null>(null)
  const [error, setError] = useState<{ key: string; message: string } | null>(null)
  const [loading, setLoading] = useState(false)
  const [now, setNow] = useState(Date.now)
  const controller = useRef<AbortController | null>(null)
  const generation = useRef(0)
  const walletState = swapWalletState(isConnected, chainId)
  const request: SwapQuoteRequest | null = address && walletState === 'ready'
    ? { address, chainId: MAINNET_SWAP_CHAIN_ID, tokenIn, tokenOut, amount, slippageBps } : null
  const contextKey = request ? swapRequestKey(request) : `${walletState}:${tokenIn}:${tokenOut}:${amount}:${slippageBps}`
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
  const current = isCurrentSwapQuote(quote, request, now) && !insufficientBalance ? quote : null

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
    if (!request || !validAmount || insufficientBalance || loading) return
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
  function selectToken(side: 'in' | 'out', token: MainnetSwapToken) {
    // Initial Preview only offers USDC pairs; other combinations have no verified route.
    if (side === 'in') {
      setTokenIn(token)
      if (token === tokenOut || (token !== 'USDC' && tokenOut !== 'USDC')) setTokenOut(token === 'USDC' ? 'EURC' : 'USDC')
    } else {
      setTokenOut(token)
      if (token === tokenIn || (token !== 'USDC' && tokenIn !== 'USDC')) setTokenIn(token === 'USDC' ? 'EURC' : 'USDC')
    }
  }
  const fieldClass = 'w-full min-w-0 rounded-xl border border-slate-200 bg-white px-4 py-3 text-slate-900 focus:outline-none focus:ring-2 focus:ring-[#66D121]/60'
  return (
    <Container className="py-8 sm:py-12">
      <section className="mx-auto max-w-2xl space-y-5" aria-labelledby="mainnet-swap-title">
        <header>
          <div className="flex flex-wrap items-center gap-3">
            <h1 id="mainnet-swap-title" className="text-3xl font-bold text-slate-900">Mainnet Swap</h1>
            <span className="rounded-full border border-[#66D121]/40 bg-[#eef7e8] px-3 py-1 text-sm font-medium text-[#2F6E0C]">Read-only Preview</span>
          </div>
          <p className="mt-3 text-slate-600">Explore live Circle Swap Kit quotes on Arc Mainnet. Swaps and approvals are disabled.</p>
        </header>
        <div className="space-y-5 rounded-3xl border border-slate-200 bg-white p-5 shadow-sm sm:p-7">
          <div className="grid min-w-0 gap-4 sm:grid-cols-2">
            <label className="min-w-0 space-y-2 text-sm font-medium text-slate-600">From token
              <select aria-label="From token" className={fieldClass} value={tokenIn} onChange={(event) => selectToken('in', event.target.value as MainnetSwapToken)}>
                {Object.keys(MAINNET_SWAP_TOKENS).map((symbol) => <option key={symbol}>{symbol}</option>)}
              </select>
            </label>
            <label className="min-w-0 space-y-2 text-sm font-medium text-slate-600">To token
              <select aria-label="To token" className={fieldClass} value={tokenOut} onChange={(event) => selectToken('out', event.target.value as MainnetSwapToken)}>
                {Object.keys(MAINNET_SWAP_TOKENS).map((symbol) => <option key={symbol}>{symbol}</option>)}
              </select>
            </label>
          </div>
          <button type="button" className="inline-flex items-center gap-2 rounded-xl border border-slate-200 px-3 py-2 text-sm text-slate-600 hover:bg-slate-50" onClick={() => { setTokenIn(tokenOut); setTokenOut(tokenIn); setAmount('') }}>
            <ArrowDownUp size={16} aria-hidden="true" /> Reverse direction
          </button>
          <label className="block space-y-2 text-sm font-medium text-slate-600">Amount ({tokenIn})
            <input aria-label="Swap amount" inputMode="decimal" autoComplete="off" maxLength={40} placeholder="0.00" className={fieldClass} value={amount} onChange={(event) => setAmount(event.target.value)} />
          </label>
          <p className="break-words text-sm text-slate-500">
            {walletState !== 'ready' ? 'Balance is not checked until your wallet is connected to Arc Mainnet.'
              : balance.isSuccess && typeof balance.data === 'bigint' ? `ERC-20 balance: ${formatUnits(balance.data, MAINNET_SWAP_TOKENS[tokenIn].decimals)} ${tokenIn}`
                : balance.isError ? 'Balance unavailable. A quote does not confirm spending capacity.' : 'Checking ERC-20 balance…'}
            {' '}A token balance does not confirm gas coverage or transaction success.
          </p>
          <label className="block space-y-2 text-sm font-medium text-slate-600">Slippage tolerance
            <select className={fieldClass} value={slippageBps} onChange={(event) => setSlippageBps(Number(event.target.value))}>
              {MAINNET_SWAP_SLIPPAGE_BPS.map((bps) => <option key={bps} value={bps}>{bps / 100}%</option>)}
            </select>
          </label>
          <p className="text-sm text-slate-500">Route availability is confirmed only by a successful quote, including reverse directions. WETH is not enabled.</p>
          {walletState === 'disconnected' && <p role="status" className="text-sm text-slate-600">Connect your wallet using the header to request a quote. No signature is requested.</p>}
          {walletState === 'wrong_network' && <p role="status" className="text-sm text-amber-700">Select Arc Mainnet (chain ID 5042) in your wallet. Quotes are disabled on other networks.</p>}
          {insufficientBalance && <p role="status" className="text-sm text-amber-700">Insufficient token balance for this amount.</p>}
          {error?.key === contextKey && <p role="alert" className="break-words text-sm text-red-700">{error.message}</p>}
          <button type="button" className="w-full rounded-xl bg-[#2F6E0C] px-5 py-3 font-semibold text-white disabled:cursor-not-allowed disabled:opacity-50" disabled={!MAINNET_SWAP_READ_ONLY_ENABLED || MAINNET_SWAP_WRITES_ENABLED || !request || !validAmount || insufficientBalance || loading} onClick={() => { void loadQuote() }}>
            {loading ? 'Requesting quote…' : quote ? 'Refresh quote' : 'Get live quote'}
          </button>
          <div aria-live="polite" aria-atomic="true">
            {current ? <>
              <h2 className="mb-3 font-semibold text-slate-900">Quote available for this direction</h2>
              <dl className="space-y-3 text-sm">
                <QuoteLine label="Estimated receive" value={`${current.estimatedOutput} ${tokenOut}`} />
                <QuoteLine label="Minimum receive" value={`${current.minimumOutput} ${tokenOut}`} />
                <QuoteLine label="Slippage tolerance" value={`${slippageBps / 100}%`} />
                {(['provider', 'gas', 'swap', 'developer'] as const).map((type) => {
                  const fees = current.fees.filter((fee) => fee.type === type)
                  if (!fees.length && (type === 'swap' || type === 'developer')) return null
                  const label = { provider: 'Provider fee', gas: 'Estimated network fee', swap: 'Swap fee', developer: 'Developer fee' }[type]
                  return <QuoteLine key={type} label={label} value={fees.length ? fees.map((fee) => fee.amount === null ? 'Not estimated' : `${fee.amount} ${fee.token}`).join(' + ') : 'Not reported'} />
                })}
                <QuoteLine label="Received" value={new Date(current.receivedAt).toISOString()} />
                <QuoteLine label="Local freshness remaining" value={`${Math.max(0, Math.ceil((current.expiresAt - now) / 1000))} seconds`} />
              </dl>
              <p className="mt-3 text-xs text-slate-500">Local freshness is limited to 30 seconds from the request, not a provider guarantee. Fees and output may change. Native gas is denominated in USDC; it is not an additional token balance.</p>
            </> : <p className="text-sm text-slate-500">{quote && request && quote.requestKey === swapRequestKey(request) && now >= quote.expiresAt ? 'Quote expired. Refresh to see current amounts and fees.' : 'No current verified quote. No output or fees are assumed.'}</p>}
          </div>
          <button type="button" disabled className="w-full cursor-not-allowed rounded-xl border border-slate-200 bg-slate-100 px-5 py-3 font-semibold text-slate-500">Swap disabled in Preview</button>
        </div>
        <details className="rounded-2xl border border-slate-200 bg-white p-4 text-sm text-slate-600">
          <summary className="cursor-pointer font-medium">Verified token contracts · Arc Mainnet 5042</summary>
          <ul className="mt-3 space-y-3">{Object.values(MAINNET_SWAP_TOKENS).map((token) => <li key={token.symbol} className="break-all"><strong>{token.symbol}</strong> · {token.decimals} decimals<br />{token.address}</li>)}</ul>
          <a href="https://docs.arc.io/arc/references/contract-addresses" target="_blank" rel="noopener noreferrer" className="mt-3 inline-block underline">Official Arc contract registry</a>
        </details>
      </section>
    </Container>
  )
}
function QuoteLine({ label, value }: { label: string; value: string }) {
  return <div className="grid min-w-0 gap-1 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] sm:gap-4"><dt className="text-slate-500">{label}</dt><dd className="min-w-0 break-all font-medium text-slate-900 sm:text-right">{value}</dd></div>
}
