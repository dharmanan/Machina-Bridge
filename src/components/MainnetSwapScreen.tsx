import { useState } from 'react'
import { useAccount, useBalance } from 'wagmi'
import { formatUnits } from 'viem'
import { ArrowDown, Loader2 } from 'lucide-react'
import { Container } from './ui'
import { isUniswapArcRoute, useUniswapArcPreview } from './UniswapArcPreview'
import { UniswapArcExecutionPanel, useUniswapArcExecution } from './UniswapArcExecution'
import { useCircleSwapPreview } from './MainnetSwapPreview'
import { MAINNET_SWAP_SLIPPAGE_BPS, MAINNET_SWAP_TOKENS, type MainnetSwapToken } from '../config/mainnetSwap'
import { ARC_OUTPUTS, ARC_ROUTER, usdcAmount } from '../lib/uniswapArcPolicy'
import { CIRCLE_NO_ROUTE_MESSAGE, decimalUnits } from '../lib/mainnetSwap'
import { shortenAmount, unitPriceInUsdc } from '../lib/swapDisplay'
import { useSwapAutoQuote } from './useSwapAutoQuote'

type Provider = 'uniswap' | 'circle'
const PROVIDER_NAME: Record<Provider, string> = { uniswap: 'Uniswap (Arc router)', circle: 'Circle Swap Kit' }
const UNISWAP_SLIPPAGE_BPS = [10, 50, 100]
const DEFAULT_SLIPPAGE_BPS = 50

export default function MainnetSwapScreen() {
  const { address, isConnected, chainId } = useAccount()
  const [tokenIn, setTokenIn] = useState<MainnetSwapToken>('USDC')
  const [tokenOut, setTokenOut] = useState<MainnetSwapToken>('EURC')
  const [amount, setAmount] = useState('')
  const [slippageChoice, setSlippageChoice] = useState(DEFAULT_SLIPPAGE_BPS)
  const [preferred, setPreferred] = useState<Provider>('uniswap')

  const uniswapRoute = isUniswapArcRoute(tokenIn, tokenOut)
  const provider: Provider = uniswapRoute && preferred === 'uniswap' ? 'uniswap' : 'circle'
  const slippageOptions: readonly number[] = provider === 'uniswap' ? UNISWAP_SLIPPAGE_BPS : MAINNET_SWAP_SLIPPAGE_BPS
  const slippageBps = slippageOptions.includes(slippageChoice) ? slippageChoice : DEFAULT_SLIPPAGE_BPS
  const uniswap = useUniswapArcPreview(tokenIn, tokenOut, amount, slippageBps, provider === 'uniswap')
  const execution = useUniswapArcExecution(provider === 'uniswap' ? uniswap.request : null)
  const circle = useCircleSwapPreview(tokenIn, tokenOut, amount, slippageBps, provider === 'circle')
  // Native USDC is read directly from Arc RPC; other tokens use the Circle hook's ERC-20 read.
  const nativeBalance = useBalance({ address, chainId: 5042, query: { enabled: isConnected && !!address && tokenIn === 'USDC', refetchInterval: 30000 } })

  const arcReady = isConnected && chainId === 5042
  let balanceText: string | null = null
  if (isConnected && address) {
    if (tokenIn === 'USDC') balanceText = nativeBalance.data ? `${formatUnits(nativeBalance.data.value / 10n ** 12n, 6)} USDC` : nativeBalance.isError ? 'unavailable' : 'loading…'
    else if (arcReady) balanceText = circle.balance.isSuccess && typeof circle.balance.data === 'bigint' ? `${formatUnits(circle.balance.data, MAINNET_SWAP_TOKENS[tokenIn].decimals)} ${tokenIn}`
      : circle.balance.isError ? 'unavailable' : 'loading…'
  }

  function circlePrice(estimatedOutput: string): string | null {
    if (!circle.request) return null
    try {
      const input = decimalUnits(circle.request.amount, MAINNET_SWAP_TOKENS[tokenIn].decimals), output = decimalUnits(estimatedOutput, MAINNET_SWAP_TOKENS[tokenOut].decimals)
      return tokenIn === 'USDC' ? unitPriceInUsdc(input, output, MAINNET_SWAP_TOKENS[tokenOut].decimals) : unitPriceInUsdc(output, input, MAINNET_SWAP_TOKENS[tokenIn].decimals)
    } catch { return null }
  }
  let summary: { estimated: string; minimum: string; price: string | null; fee: string; expiresIn: number; extra: [string, string][] } | null = null
  if (provider === 'uniswap' && uniswap.current && isUniswapArcRoute(tokenIn, tokenOut)) {
    const quote = uniswap.current, decimals = ARC_OUTPUTS[tokenOut].decimals
    summary = {
      estimated: formatUnits(BigInt(quote.estimatedOutput), decimals), minimum: formatUnits(BigInt(quote.requiredMinimum), decimals),
      price: unitPriceInUsdc(usdcAmount(quote.request.amount), BigInt(quote.estimatedOutput), decimals),
      fee: `${formatUnits(BigInt(quote.networkFee), 18)} USDC`, expiresIn: Math.ceil(uniswap.remainingMs / 1000),
      extra: [['Gas limit (includes safety margin)', quote.gasLimit], ['Maximum gas price', `${formatUnits(BigInt(quote.maxFeePerGas), 9)} gwei`],
        ['Native balance at simulation block', `${formatUnits(BigInt(quote.nativeBalance), 18)} USDC`], ['Simulation block', quote.blockNumber]],
    }
  } else if (provider === 'circle' && circle.quote) {
    const quote = circle.quote, gas = quote.fees.filter(fee => fee.type === 'gas')
    summary = {
      estimated: quote.estimatedOutput, minimum: quote.minimumOutput, price: circlePrice(quote.estimatedOutput),
      fee: gas.length ? gas.map(fee => fee.amount === null ? 'Not estimated' : `${fee.amount} ${fee.token}`).join(' + ') : 'Not reported',
      expiresIn: Math.max(0, Math.ceil((quote.expiresAt - circle.now) / 1000)),
      extra: quote.fees.filter(fee => fee.type !== 'gas').map(fee => [`${fee.type[0].toUpperCase()}${fee.type.slice(1)} fee`, fee.amount === null ? 'Not estimated' : `${fee.amount} ${fee.token}`] as [string, string]),
    }
  }
  const priceToken = tokenIn === 'USDC' ? tokenOut : tokenIn
  const active = provider === 'uniswap' ? uniswap : circle
  const loading = active.loading
  // Never switches provider on its own; the user is told which source can still be chosen.
  const error = provider === 'circle' && active.error === CIRCLE_NO_ROUTE_MESSAGE && uniswapRoute
    ? 'Circle cannot provide a quote for this amount. Choose Uniswap as the quote source.' : active.error
  const expired = active.expired
  const canQuote = provider === 'uniswap' ? Boolean(uniswap.request) : Boolean(circle.request && circle.validAmount && !circle.insufficientBalance)
  const executionBusy = !['idle', 'confirmed', 'failed', 'rejected'].includes(execution.view.phase)
  useSwapAutoQuote(JSON.stringify([address, isConnected, chainId, provider, tokenIn, tokenOut, amount, slippageBps]),
    canQuote && !executionBusy, active.load, active.cancel)

  function selectToken(side: 'in' | 'out', token: MainnetSwapToken) {
    // Only USDC pairs have a verified route; other combinations fall back to a USDC pair.
    if (side === 'in') {
      setTokenIn(token)
      if (token === tokenOut || (token !== 'USDC' && tokenOut !== 'USDC')) setTokenOut(token === 'USDC' ? 'EURC' : 'USDC')
    } else {
      setTokenOut(token)
      if (token === tokenIn || (token !== 'USDC' && tokenIn !== 'USDC')) setTokenIn(token === 'USDC' ? 'EURC' : 'USDC')
    }
  }
  const tokens = Object.keys(MAINNET_SWAP_TOKENS) as MainnetSwapToken[]
  const selectClass = 'rounded-xl border border-slate-200 bg-white px-3 py-2 font-semibold text-slate-900 focus:outline-none focus:ring-2 focus:ring-[#66D121]/60'
  const fieldClass = 'w-full min-w-0 rounded-xl border border-slate-200 bg-white px-3 py-2 text-slate-900 focus:outline-none focus:ring-2 focus:ring-[#66D121]/60'

  return <Container className="py-8 sm:py-12">
    <section aria-labelledby="swap-title" className="mx-auto max-w-lg space-y-4">
      <header className="flex flex-wrap items-center gap-3">
        <h1 id="swap-title" className="text-3xl font-bold text-slate-900">Swap</h1>
        <span className="rounded-full border border-[#66D121]/40 bg-[#eef7e8] px-3 py-1 text-sm font-medium text-[#2F6E0C]">{provider === 'uniswap' && execution.enabled ? 'Uniswap Swap' : 'Preview only'}</span>
      </header>
      <p className="text-sm text-slate-600">{provider === 'uniswap' && execution.enabled ? 'Arc Mainnet · Review and confirm before a wallet transaction is requested. No token approval is needed.' : 'Arc Mainnet · live quotes. Swaps, approvals and signatures are disabled.'}</p>
      <div className="space-y-2 rounded-3xl border border-slate-200 bg-white p-4 shadow-sm sm:p-6">
        <div className="space-y-2 rounded-2xl bg-slate-50 p-4">
          <div className="flex items-baseline justify-between gap-3 text-sm text-slate-500">
            <span className="font-medium">You pay</span>
            {balanceText && <span role="status" aria-live="polite" className="text-xs">Balance: {balanceText}</span>}
          </div>
          <div className="flex items-center gap-3">
            <input aria-label="Swap amount" className="min-w-0 flex-1 bg-transparent text-3xl font-semibold text-slate-900 placeholder-slate-300 focus:outline-none"
              inputMode="decimal" autoComplete="off" maxLength={40} placeholder="0.00" value={amount} onChange={event => setAmount(event.target.value)} />
            <select aria-label="From token" className={selectClass} value={tokenIn} onChange={event => selectToken('in', event.target.value as MainnetSwapToken)}>
              {tokens.map(symbol => <option key={symbol}>{symbol}</option>)}
            </select>
          </div>
        </div>
        <div className="flex justify-center">
          <button type="button" aria-label="Reverse direction" className="-my-4 relative z-10 rounded-xl border border-slate-200 bg-white p-2 text-slate-600 shadow-sm hover:bg-slate-50"
            onClick={() => { setTokenIn(tokenOut); setTokenOut(tokenIn); setAmount('') }}>
            <ArrowDown size={16} aria-hidden="true" />
          </button>
        </div>
        <div className="space-y-2 rounded-2xl bg-slate-50 p-4">
          <div className="text-sm font-medium text-slate-500">You receive</div>
          <div className="flex items-center gap-3">
            <output aria-label="Estimated receive" title={summary ? `${summary.estimated} ${tokenOut}` : undefined} className={`min-w-0 flex-1 truncate text-3xl font-semibold ${summary ? 'text-slate-900' : 'text-slate-300'}`}>{summary ? shortenAmount(summary.estimated) : '0.00'}</output>
            <select aria-label="To token" className={selectClass} value={tokenOut} onChange={event => selectToken('out', event.target.value as MainnetSwapToken)}>
              {tokens.map(symbol => <option key={symbol}>{symbol}</option>)}
            </select>
          </div>
          <p className="text-xs text-slate-500">{summary ? (summary.price ? <span aria-label="Unit price">1 {priceToken} ≈ {summary.price} USDC</span> : 'Estimated from a live quote.') : 'No output is assumed until a live quote is received.'}</p>
        </div>

        <div className="grid min-w-0 gap-3 pt-2 sm:grid-cols-2">
          {uniswapRoute && <label className="min-w-0 space-y-1 text-sm font-medium text-slate-600">Quote source
            <select aria-label="Quote source" className={fieldClass} value={provider} onChange={event => setPreferred(event.target.value as Provider)}>
              <option value="uniswap">{PROVIDER_NAME.uniswap}</option>
              <option value="circle">{PROVIDER_NAME.circle}</option>
            </select>
          </label>}
          <label className="min-w-0 space-y-1 text-sm font-medium text-slate-600">Slippage tolerance
            <select aria-label="Slippage tolerance" className={fieldClass} value={slippageBps} onChange={event => setSlippageChoice(Number(event.target.value))}>
              {slippageOptions.map(bps => <option key={bps} value={bps}>{bps / 100}%</option>)}
            </select>
          </label>
        </div>

        <dl className="space-y-2 rounded-2xl border border-slate-200 p-4 text-sm">
          <SummaryLine label="Provider" value={PROVIDER_NAME[provider]} />
          <SummaryLine label="Minimum receive" value={summary ? `${shortenAmount(summary.minimum)} ${tokenOut}` : '—'} title={summary ? `${summary.minimum} ${tokenOut}` : undefined} />
          <SummaryLine label="Slippage" value={`${slippageBps / 100}%`} />
          <SummaryLine label="Network fee ceiling" value={summary ? summary.fee : '—'} />
          <SummaryLine label="Quote expires in" value={summary ? `${summary.expiresIn} seconds` : '—'} />
        </dl>
        {provider === 'uniswap' && <p className="text-xs text-slate-500">Uniswap preview: up to 10 USDC, 6 decimal places; the fee ceiling is paid in addition to the input.</p>}

        {!isConnected && <p role="status" className="text-sm text-slate-600">Connect your wallet using the header to request a quote. No signature is requested.</p>}
        {isConnected && chainId !== 5042 && <p role="status" className="text-sm text-amber-700">Select Arc Mainnet (chain ID 5042) in your wallet. Quotes are disabled on other networks.</p>}
        {provider === 'uniswap' && uniswap.invalidAmount && <p role="status" className="text-sm text-slate-600">Enter a positive amount up to 10 USDC with at most 6 decimal places.</p>}
        {provider === 'circle' && circle.insufficientBalance && <p role="status" className="text-sm text-amber-700">Insufficient token balance for this amount.</p>}
        {error && <p role="alert" className="break-words text-sm text-red-700">{error}</p>}

        {loading && <p role="status" className="flex items-center gap-2 text-xs text-slate-500"><Loader2 size={14} className="animate-spin" aria-hidden="true" />Updating price…</p>}
        <div aria-live="polite" aria-atomic="true">
          {summary ? <p role="status" className="text-xs text-slate-500">{provider === 'uniswap' ? `Read-only simulation passed · ${execution.enabled ? 'Use Review Swap for a separately checked transaction.' : 'Execution disabled.'} A simulation is not a completed transaction; the fee shown is a conservative budget, not a charged fee.` : 'Quote available. Local freshness is limited to 30 seconds, not a provider guarantee. Fees and output may change.'}</p>
            : <p role="status" className="text-xs text-slate-500">{loading ? 'Checking the current quote…' : expired ? 'Quote expired. Change the amount or settings for a new price.' : 'Enter an amount for an automatic quote. No output or fee is assumed.'}</p>}
        </div>
        {provider === 'uniswap' ? <UniswapArcExecutionPanel execution={execution} canReview={Boolean(uniswap.request) && !uniswap.loading} />
          : <button type="button" disabled className="w-full cursor-not-allowed rounded-xl border border-slate-200 bg-slate-100 px-5 py-3 font-semibold text-slate-500">Swap disabled in Preview</button>}
      </div>

      {summary && summary.extra.length > 0 && <details className="rounded-2xl border border-slate-200 bg-white p-4 text-sm text-slate-600">
        <summary className="cursor-pointer font-medium">Quote details</summary>
        <dl className="mt-3 space-y-2">{summary.extra.map(([label, value]) => <SummaryLine key={label} label={label} value={value} />)}</dl>
      </details>}
      <details className="rounded-2xl border border-slate-200 bg-white p-4 text-sm text-slate-600">
        <summary className="cursor-pointer font-medium">Verified contracts · Arc Mainnet 5042</summary>
        <p className="mt-3 break-all">Uniswap Universal Router 2.1.2: {ARC_ROUTER}</p>
        <ul className="mt-3 space-y-3">{Object.values(MAINNET_SWAP_TOKENS).map(token => <li key={token.symbol} className="break-all"><strong>{token.symbol}</strong> · {token.decimals} decimals<br />{token.address}</li>)}</ul>
        <a href="https://docs.arc.io/arc/references/contract-addresses" target="_blank" rel="noopener noreferrer" className="mt-3 inline-block underline">Official Arc contract registry</a>
      </details>
    </section>
  </Container>
}

function SummaryLine({ label, value, title }: { label: string; value: string; title?: string }) {
  return <div className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] gap-3"><dt className="text-slate-500">{label}</dt><dd title={title} className="min-w-0 break-words text-right font-medium text-slate-900">{value}</dd></div>
}
