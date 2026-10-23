import { useRef, useState } from 'react'
import { useAccount, useBalance } from 'wagmi'
import { formatUnits } from 'viem'
import { ArrowDown, Loader2 } from 'lucide-react'
import { Container } from './ui'
import { useUniswapArcPreview } from './UniswapArcPreview'
import { UniswapReviewDialog, useUniswapArcExecution } from './UniswapArcExecution'
import { CircleReviewDialog, useCircleSwapExecution } from './CircleExecution'
import { ApprovalsPanel, useUniswapApprovals } from './UniswapApprovals'
import { SwapActivityPanel } from './SwapActivity'
import { useCircleSwapPreview } from './MainnetSwapPreview'
import { MAINNET_SWAP_TOKENS, type MainnetSwapToken } from '../config/mainnetSwap'
import { SWAP_EXECUTION } from '../config/swapExecution'
import { plainMessage } from '../lib/swap/userMessages'
import { PlainMessage } from './PlainMessage'
import { ARC_ROUTER, ARC_INPUT_CAPS } from '../lib/uniswapArcPolicy'
import { decimalUnits } from '../lib/mainnetSwap'
import { exchangeRate, shortenAmount } from '../lib/swapDisplay'
import { useSwapAutoQuote } from './useSwapAutoQuote'
import { NATIVE_SWAP_FEE_RESERVE, swapShortcutAmount } from '../lib/swapAmountShortcuts'
import { ARC_PILOT_MAX_INPUT } from '../lib/uniswapArcPilot'
import { executionChip, swapExecutionRestriction } from '../lib/swap/executionMode'
import { approvalActivity, circleActivity, splitActivity, storedApprovalActivity, storedCircleActivity, storedSwapActivity, swapActivity, type ActivityItem } from '../lib/swap/activity'
import { CIRCLE_SWAP_WRITES_ENABLED, validateCircleRequest, type CircleSwapRequest } from '../lib/swap/circleSwap'
import { executionInBuild, supportFor } from '../lib/swap/support'
import { APPROVAL_FEE_CEILING } from '../lib/swap/uniswapApprovals'
import { circleFeeCeiling } from '../lib/swap/circleSwap'

type Provider = 'uniswap' | 'circle'
const PROVIDER_NAME: Record<Provider, string> = { uniswap: 'Uniswap', circle: 'Circle Swap Kit' }
// Each provider offers its own slippage values; a value a provider does not offer is said so, never silently replaced.
const SLIPPAGE_BPS: Record<Provider, readonly number[]> = { uniswap: [10, 50, 100], circle: [50, 100, 300] }
const ALL_SLIPPAGE_BPS = [10, 50, 100, 300]
const DEFAULT_SLIPPAGE_BPS = 50
const CHIP_CLASS = { live: 'border-[#66D121]/40 bg-[#eef7e8] text-[#2F6E0C]', pilot: 'border-sky-300 bg-sky-50 text-sky-800', quotes: 'border-slate-300 bg-slate-100 text-slate-700' }

interface ProviderQuote {
  provider: Provider; state: 'idle' | 'loading' | 'quoted' | 'error' | 'unsupported'
  estimated?: string; estimatedUnits?: bigint; minimum?: string; fee?: string; otherFees?: string; route?: string; expiresIn?: number; message?: string
}

export default function MainnetSwapScreen() {
  const { address, isConnected, chainId } = useAccount()
  const [tokenIn, setTokenIn] = useState<MainnetSwapToken>('USDC')
  const [tokenOut, setTokenOut] = useState<MainnetSwapToken>('EURC')
  const [amount, setAmount] = useState('')
  const [slippageChoice, setSlippageChoice] = useState(DEFAULT_SLIPPAGE_BPS)
  const [provider, setProvider] = useState<Provider>('uniswap')
  const [showActivity, setShowActivity] = useState(false)
  // Keep a still-current price when selecting a provider. Missing/expired prices may be requested again;
  // Review always obtains its own independent quote and never treats this comparison as transaction authority.
  const [selectionEpoch, setSelectionEpoch] = useState<Record<Provider, number>>({ uniswap: 0, circle: 0 })
  // A fresh start of a swap that certainly did not happen: the same pair, amount and provider are set up again. Nothing is sent; the user
  // reviews the swap anew (fresh quote, fresh checks) and confirms it again.
  const [retried, setRetried] = useState<string | null>(null)
  const choose = (id: Provider) => { if (id !== provider) {
    setProvider(id)
    if (!['quoted', 'loading'].includes(quotes[id].state)) setSelectionEpoch(epoch => ({ ...epoch, [id]: epoch[id] + 1 }))
  } }

  const slippageBps = ALL_SLIPPAGE_BPS.includes(slippageChoice) ? slippageChoice : DEFAULT_SLIPPAGE_BPS
  const uniswapOffers = SLIPPAGE_BPS.uniswap.includes(slippageBps), circleOffers = SLIPPAGE_BPS.circle.includes(slippageBps)
  const uniswap = useUniswapArcPreview(tokenIn, tokenOut, amount, slippageBps, uniswapOffers)
  const circle = useCircleSwapPreview(tokenIn, tokenOut, amount, slippageBps, circleOffers)
  // One wallet, one open transaction: an unresolved record of either provider (or an approval) holds a new swap of the other.
  const other = useRef<{ uniswap: (owner: string) => boolean; circle: (owner: string) => boolean; swapOrCircle: (owner: string) => boolean }>({ uniswap: () => false, circle: () => false, swapOrCircle: () => false })
  // Approvals are offered only where this build could go on to send the swap; a restricted route shows its reason instead.
  const uniswapAllowed = swapExecutionRestriction(SWAP_EXECUTION, uniswap.request, { connected: isConnected, owner: address ?? '', chainId: chainId ?? 0 }) === null
  const approvals = useUniswapApprovals(provider === 'uniswap' && uniswapAllowed ? uniswap.request : null, owner => other.current.swapOrCircle(owner))
  const execution = useUniswapArcExecution(provider === 'uniswap' ? uniswap.request : null, owner => approvals.blocking(owner) || other.current.circle(owner))
  let circleRequest: CircleSwapRequest | null = null
  if (circle.request && circle.validAmount) { try { circleRequest = validateCircleRequest({ chainId: 5042, tokenIn, tokenOut, owner: circle.request.address, amount, slippageBps }) } catch { circleRequest = null } }
  const circleExecution = useCircleSwapExecution(provider === 'circle' ? circleRequest : null, owner => other.current.uniswap(owner))
  // Read from the journals themselves (never from React state) and fail closed when a journal cannot be read.
  other.current = { uniswap: owner => approvals.blocking(owner) || execution.blocking(owner), circle: owner => circleExecution.blocking(owner), swapOrCircle: owner => execution.blocking(owner) || circleExecution.blocking(owner) }
  const arcReady = isConnected && chainId === 5042
  const nativeBalance = useBalance({ address, chainId: 5042, query: { enabled: arcReady && !!address, refetchInterval: 30000 } })
  const inDecimals = MAINNET_SWAP_TOKENS[tokenIn].decimals, outDecimals = MAINNET_SWAP_TOKENS[tokenOut].decimals

  // --- balance shortcuts -------------------------------------------------------------------------------------------------------
  const shortcutKey = JSON.stringify([address, isConnected, chainId, tokenIn, tokenOut, provider, amount])
  const selection = useRef({ key: shortcutKey })
  if (selection.current.key !== shortcutKey) selection.current = { key: shortcutKey }
  const shortcutLock = useRef(false)
  const [shortcutBusy, setShortcutBusy] = useState(false)
  const [shortcutError, setShortcutError] = useState<{ context: { key: string }; message: string } | null>(null)
  const pilotRoute = SWAP_EXECUTION.mode === 'pilot' && provider === 'uniswap' && tokenIn === 'USDC' && tokenOut === 'EURC'
  const inputCap = pilotRoute ? ARC_PILOT_MAX_INPUT / 10n ** 12n : ARC_INPUT_CAPS[tokenIn]
  async function selectBalance(percent: number) {
    if (!arcReady || !address || shortcutLock.current) return
    const selected = selection.current
    shortcutLock.current = true; setShortcutBusy(true); setShortcutError(null)
    try {
      let balance: bigint
      if (tokenIn === 'USDC') {
        const fresh = await nativeBalance.refetch()
        if (fresh.isError || !fresh.data || fresh.data.decimals !== 18) throw Error('balance')
        balance = fresh.data.value
      } else {
        const fresh = await circle.balance.refetch()
        if (fresh.isError || typeof fresh.data !== 'bigint') throw Error('balance')
        balance = fresh.data
      }
      if (selection.current !== selected) return
      setAmount(swapShortcutAmount(balance, inDecimals, percent, tokenIn === 'USDC', tokenIn === 'USDC' ? NATIVE_SWAP_FEE_RESERVE : undefined, inputCap))
    } catch (error) {
      if (selection.current === selected) setShortcutError({ context: selected, message: error instanceof Error && error.message === 'gas'
        ? 'MAX unavailable: the current native USDC balance cannot cover the reserved network fee.'
        : error instanceof Error && error.message === 'zero' ? 'The selected share is below the smallest supported token amount.'
          : 'The current input-token balance could not be verified. Amount unchanged.' })
    } finally { shortcutLock.current = false; setShortcutBusy(false) }
  }
  let balanceText: string | null = null
  if (isConnected && address) {
    if (tokenIn === 'USDC') balanceText = nativeBalance.isError ? 'unavailable' : nativeBalance.data ? `${formatUnits(nativeBalance.data.value / 10n ** 12n, 6)} USDC` : 'loading…'
    else if (arcReady) balanceText = circle.balance.isSuccess && typeof circle.balance.data === 'bigint' ? `${formatUnits(circle.balance.data, inDecimals)} ${tokenIn}`
      : circle.balance.isError ? 'unavailable' : 'loading…'
  }
  const gasBalanceText = tokenIn !== 'USDC' && arcReady && nativeBalance.data ? `${formatUnits(nativeBalance.data.value / 10n ** 12n, 6)} USDC` : null

  // --- the two providers, side by side ----------------------------------------------------------------------------------------
  const walletReady = isConnected && chainId === 5042
  const uniswapQuote: ProviderQuote = !uniswapOffers ? { provider: 'uniswap', state: 'unsupported', message: `Uniswap does not offer ${slippageBps / 100}% slippage. Choose 0.1%, 0.5% or 1%.` }
    : uniswap.current ? { provider: 'uniswap', state: 'quoted', estimatedUnits: BigInt(uniswap.current.estimatedOutput), estimated: formatUnits(BigInt(uniswap.current.estimatedOutput), outDecimals), minimum: formatUnits(BigInt(uniswap.current.requiredMinimum), outDecimals),
      fee: `${formatUnits(BigInt(uniswap.current.networkFee) + (tokenIn === 'USDC' ? 0n : APPROVAL_FEE_CEILING * BigInt(approvals.plan.state === 'needed' ? approvals.plan.steps.length : approvals.plan.state === 'complete' ? 0 : 2)), 18)} USDC`,
      otherFees: 'Pool fees included in price', route: uniswap.current.route ?? `${tokenIn} → ${tokenOut}`, expiresIn: Math.ceil(uniswap.remainingMs / 1000) }
      : uniswap.loading ? { provider: 'uniswap', state: 'loading' } : uniswap.error ? { provider: 'uniswap', state: 'error', message: uniswap.error }
        : uniswap.expired ? { provider: 'uniswap', state: 'error', message: 'Quote expired. Check the price again before continuing.' } : { provider: 'uniswap', state: 'idle' }
  let circleQuote: ProviderQuote
  if (!circleOffers) circleQuote = { provider: 'circle', state: 'unsupported', message: `Circle Swap Kit does not offer ${slippageBps / 100}% slippage. Choose 0.5%, 1% or 3%.` }
  else if (circle.quote) {
    const quote = circle.quote, gas = quote.fees.filter(fee => fee.type === 'gas'), other = quote.fees.filter(fee => fee.type !== 'gas')
    const text = (fee: { amount: string | null; token: string }) => (fee.amount === null ? 'not estimated' : `${fee.amount} ${fee.token}`)
    let units: bigint | undefined
    try { units = decimalUnits(quote.estimatedOutput, outDecimals) } catch { units = undefined }
    const gasEstimate = gas.length > 0 && gas.every(fee => fee.amount !== null) ? gas.reduce((sum, fee) => sum + decimalUnits(fee.amount, 18), 0n) : null
    circleQuote = { provider: 'circle', state: 'quoted', estimated: quote.estimatedOutput, estimatedUnits: units, minimum: quote.minimumOutput,
      fee: `${formatUnits(circleFeeCeiling(gasEstimate), 18)} USDC`, otherFees: other.map(fee => text(fee)).join(' · ') || 'Not reported',
      route: 'Circle Swap Kit router', expiresIn: Math.max(0, Math.ceil((quote.expiresAt - circle.now) / 1000)) }
  } else if (circle.loading) circleQuote = { provider: 'circle', state: 'loading' }
  else if (circle.error) circleQuote = { provider: 'circle', state: 'error', message: circle.error }
  else if (circle.expired) circleQuote = { provider: 'circle', state: 'error', message: 'Quote expired. Check the price again before continuing.' }
  else circleQuote = { provider: 'circle', state: 'idle' }
  const quotes: Record<Provider, ProviderQuote> = { uniswap: uniswapQuote, circle: circleQuote }
  const best: Provider | null = uniswapQuote.estimatedUnits !== undefined && circleQuote.estimatedUnits !== undefined && uniswapQuote.estimatedUnits !== circleQuote.estimatedUnits
    ? (uniswapQuote.estimatedUnits > circleQuote.estimatedUnits ? 'uniswap' : 'circle') : null
  const selected = quotes[provider]
  let rateText: string | null = null
  try {
    if (selected.state === 'quoted' && selected.estimatedUnits !== undefined) rateText = exchangeRate(decimalUnits(amount, inDecimals), inDecimals, selected.estimatedUnits, outDecimals)
  } catch { rateText = null }
  const active = provider === 'uniswap' ? uniswap : circle
  const loading = active.loading
  const busyPhases = ['preparing', 'review', 'checking', 'awaiting_step', 'awaiting_wallet']
  const executionBusy = busyPhases.includes(execution.view.phase) || execution.view.walletRequestOpen === true || busyPhases.includes(approvals.view.phase) ||
    busyPhases.includes(circleExecution.view.phase) || circleExecution.view.walletRequestOpen === true
  const quoteKey = JSON.stringify([address, isConnected, chainId, tokenIn, tokenOut, amount, slippageBps])
  useSwapAutoQuote(`${quoteKey}:uniswap:${selectionEpoch.uniswap}`, Boolean(uniswap.request) && uniswapOffers && !executionBusy, uniswap.load, uniswap.cancel)
  useSwapAutoQuote(`${quoteKey}:circle:${selectionEpoch.circle}`, Boolean(circle.request && circle.validAmount && !circle.insufficientBalance) && circleOffers && !executionBusy, circle.load, circle.cancel)

  function selectToken(side: 'in' | 'out', token: MainnetSwapToken) {
    // Any token can be paired with any other supported token; choosing the other side's token exchanges the two sides.
    // The amount is in units of the input token, so it is cleared only when the input token changes.
    let nextIn = tokenIn, nextOut = tokenOut
    if (side === 'in') { if (token === tokenOut) nextOut = tokenIn; nextIn = token } else { if (token === tokenIn) nextIn = tokenOut; nextOut = token }
    setTokenIn(nextIn); setTokenOut(nextOut)
    if (nextIn !== tokenIn) setAmount('')
  }
  const tokens = Object.keys(MAINNET_SWAP_TOKENS) as MainnetSwapToken[]
  const selectClass = 'rounded-xl border border-slate-200 bg-white px-3 py-2 font-semibold text-slate-900 focus:outline-none focus:ring-2 focus:ring-[#66D121]/60'
  const fieldClass = 'w-full min-w-0 rounded-xl border border-slate-200 bg-white px-3 py-2 text-slate-900 focus:outline-none focus:ring-2 focus:ring-[#66D121]/60'

  // --- what the selected provider can do for this route (independent of whether an amount is typed) ------------------------------
  const chip = executionChip(SWAP_EXECUTION, { provider, tokenIn, tokenOut }, CIRCLE_SWAP_WRITES_ENABLED)
  const erc20Input = tokenIn !== 'USDC'
  const approvalsReady = !erc20Input || approvals.plan.state === 'complete'
  const active_ = provider === 'uniswap' ? execution : circleExecution
  // One wallet, one open transaction: an unresolved swap of the other provider (or an approval) holds a new Review.
  const heldByOther = Boolean(address) && (provider === 'uniswap' ? other.current.circle(address ?? '') : other.current.uniswap(address ?? ''))
  const reviewBlocked = active_.restrictionMessage ?? (heldByOther ? 'Another swap or approval from this wallet is still being verified. You can start a new swap once it is done.'
    : null)
  const hasRequest = provider === 'uniswap' ? Boolean(uniswap.request) : Boolean(circleRequest)
  const canReview = hasRequest && !(provider === 'uniswap' ? uniswap.loading : circle.loading) && active_.enabled && (provider === 'circle' || approvalsReady) && !executionBusy && !heldByOther &&
    !(provider === 'uniswap' ? approvals.blocking(address ?? '') : false)
  const busyPhase = ['preparing', 'checking', 'awaiting_step', 'awaiting_wallet', 'pending', 'unknown'].includes(active_.view.phase)
  const needsApproval = provider === 'uniswap' && erc20Input && approvals.plan.state === 'needed'
  const canApprove = needsApproval && execution.enabled && uniswapAllowed && hasRequest && !executionBusy && !heldByOther && !approvals.blocking(address ?? '')
  const canRetryPrice = hasRequest && selected.state === 'error' && walletReady && !circle.insufficientBalance && !executionBusy && !busyPhase && !heldByOther
  const canContinue = (selected.state === 'quoted' && (canReview || canApprove) && !busyPhase) || canRetryPrice
  const primaryLabel = executionBusy ? 'Preparing…' : canRetryPrice ? 'Check price again' : needsApproval ? `Approve ${tokenIn} · ${approvals.plan.state === 'needed' ? approvals.plan.steps.length : ''} ${approvals.plan.state === 'needed' && approvals.plan.steps.length === 1 ? 'step' : 'steps'}` : 'Review Swap'
  function continueSwap() {
    if (!canContinue) return
    if (canRetryPrice) { setSelectionEpoch(epoch => ({ ...epoch, [provider]: epoch[provider] + 1 })); return }
    setShowActivity(true)
    void (needsApproval ? approvals.prepare() : active_.prepare())
  }

  // --- transactions: one panel for swaps and approvals, built from this browser's records ---------------------------------------
  // The wording of a mismatch lives in the card's own headline and Review lines, so its generic error text is not repeated.
  const live = (attempt: { id: string; status: string }, view: { checking?: boolean; error?: string; walletRequestOpen?: boolean; walletWindowMs?: number; replaced?: boolean }) => ({ checking: view.checking, replaced: view.replaced === true, error: attempt.status === 'mismatch' ? undefined : plainMessage(view.error), diagnostic: view.error, walletRequestOpen: view.walletRequestOpen, walletWindowMs: view.walletWindowMs, id: attempt.id })
  const items: ActivityItem[] = [...storedSwapActivity(execution.stored), ...storedApprovalActivity(approvals.stored), ...storedCircleActivity(circleExecution.stored)]
  let activeKey: string | null = null
  if (execution.view.attempt) { const item = { ...swapActivity(execution.view.attempt), live: live(execution.view.attempt, execution.view) }; items.push(item); activeKey = item.key }
  if (approvals.view.attempt) {
    const item = { ...approvalActivity(approvals.view.attempt), live: live(approvals.view.attempt, { checking: approvals.view.checking, error: approvals.view.error, walletRequestOpen: approvals.view.walletRequestOpen }) }
    items.push(item); if (!activeKey || item.createdAt > (items.find(x => x.key === activeKey)?.createdAt ?? 0)) activeKey = item.key
  }
  if (circleExecution.view.attempt) {
    const item = { ...circleActivity(circleExecution.view.attempt), live: live(circleExecution.view.attempt, circleExecution.view) }
    items.push(item); if (!activeKey || item.createdAt >= (items.find(x => x.key === activeKey)?.createdAt ?? 0)) activeKey = item.key
  }
  const { latest, earlier } = splitActivity(items, activeKey, address)
  const activityUnreadable = execution.historyError || circleExecution.historyError || [...execution.stored, ...approvals.stored, ...circleExecution.stored].some(history => history.unreadable)
  const formKey = [provider, tokenIn, tokenOut, amount].join(':')
  const retryItem = (item: ActivityItem) => {
    if (!item.again) return
    const { provider: again, tokenIn: nextIn, tokenOut: nextOut, amount: nextAmount } = item.again
    setProvider(again); setTokenIn(nextIn); setTokenOut(nextOut); setAmount(nextAmount); setRetried([again, nextIn, nextOut, nextAmount].join(':'))
    window.setTimeout(() => { const button = document.getElementById('review-swap'); button?.scrollIntoView({ block: 'center', behavior: 'smooth' }); button?.focus() }, 50)
  }
  const checkItem = (item: ActivityItem) => { void (item.provider === 'circle' ? circleExecution.checkAttempt(item.id, item.owner) : item.kind === 'swap' ? execution.checkAttempt(item.id, item.owner) : approvals.check(item.owner, item.id)) }

  const summary = selected.state === 'quoted' ? selected : null
  const priceToken = tokenIn
  return <Container className="py-8 sm:py-12">
    <section aria-labelledby="swap-title" className="mx-auto max-w-lg space-y-4">
      <header className="flex flex-wrap items-center gap-3">
        <h1 id="swap-title" className="text-3xl font-bold text-slate-900">Swap</h1>
        <span aria-label="Swap mode" className={`rounded-full border px-3 py-1 text-sm font-medium ${CHIP_CLASS[chip.tone]}`}>{chip.label}</span>
      </header>
      <p className="text-sm text-slate-500">Arc Mainnet{chip.tone === 'quotes' ? ' · Quotes only in this build' : ' · You confirm every wallet step'}</p>
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
          <div className="flex gap-2" aria-label="Input balance shortcuts">
            {[25, 50, 75, 100].map(percent => <button key={percent} type="button" onClick={() => { void selectBalance(percent) }}
              disabled={!arcReady || shortcutBusy}
              className="flex-1 rounded-lg border border-slate-200 bg-white px-2 py-1 text-xs font-medium disabled:opacity-40">{percent === 100 ? 'MAX' : `${percent}%`}</button>)}
          </div>
          <div className="space-y-1 text-xs text-slate-500">
            {shortcutBusy && <p role="status">Checking current token balance…</p>}
            {shortcutError?.context === selection.current && <p role="status" className="text-amber-800">{shortcutError.message}</p>}
            <p>Limit {formatUnits(inputCap, inDecimals)} {tokenIn}{pilotRoute ? ' · Pilot' : ''}{tokenIn === 'USDC' ? ' · MAX keeps 0.1 USDC for fees' : gasBalanceText ? ` · Gas balance ${gasBalanceText}` : ''}</p>
          </div>
        </div>
        <div className="flex justify-center">
          <button type="button" aria-label="Reverse direction" className="-my-4 relative z-10 rounded-xl border border-slate-200 bg-white p-2 text-slate-600 shadow-sm hover:bg-slate-50"
            onClick={() => { setTokenIn(tokenOut); setTokenOut(tokenIn); setAmount('') }}>
            <ArrowDown size={16} aria-hidden="true" />
          </button>
        </div>
        <div className="space-y-2 rounded-2xl bg-slate-50 p-4">
          <div className="text-sm font-medium text-slate-500">You receive · {PROVIDER_NAME[provider]}</div>
          <div className="flex items-center gap-3">
            <output aria-label="Estimated receive" title={summary ? `${summary.estimated} ${tokenOut}` : undefined} className={`min-w-0 flex-1 truncate text-3xl font-semibold ${summary ? 'text-slate-900' : 'text-slate-300'}`}>{summary ? shortenAmount(summary.estimated ?? '0') : '0.00'}</output>
            <select aria-label="To token" className={selectClass} value={tokenOut} onChange={event => selectToken('out', event.target.value as MainnetSwapToken)}>
              {tokens.map(symbol => <option key={symbol}>{symbol}</option>)}
            </select>
          </div>
          <p className="min-h-[1rem] text-xs text-slate-500">{summary ? (rateText ? <span aria-label="Unit price">1 {priceToken} ≈ {rateText} {tokenOut}</span> : 'Estimated from a live quote.') : 'Enter an amount to see what you would receive.'}</p>
        </div>

        <fieldset className="space-y-2 pt-2">
          <legend className="text-sm font-medium text-slate-600">Choose your price <span className="text-xs font-normal text-slate-400">· before network fees</span></legend>
          <div role="radiogroup" aria-label="Quote source" className="grid gap-2 sm:grid-cols-2">
            {(['uniswap', 'circle'] as Provider[]).map(id => <ProviderCard key={id} id={id} quote={quotes[id]} selected={provider === id} best={best === id} tokenOut={tokenOut} onSelect={() => choose(id)}
              quotesOnly={(() => { const entry = supportFor(id, tokenIn, tokenOut); return entry ? !executionInBuild(entry, SWAP_EXECUTION, CIRCLE_SWAP_WRITES_ENABLED).available : true })()}
              onlyOne={quotes[id].state === 'quoted' && quotes[id === 'uniswap' ? 'circle' : 'uniswap'].state !== 'quoted'} />)}
          </div>
        </fieldset>
        <details className="pt-2 text-sm text-slate-600">
          <summary className="cursor-pointer">Slippage · {slippageBps / 100}%</summary>
          <label className="min-w-0 space-y-1 text-sm font-medium text-slate-600">Slippage tolerance
            <select aria-label="Slippage tolerance" className={fieldClass} value={slippageBps} onChange={event => setSlippageChoice(Number(event.target.value))}>
              {ALL_SLIPPAGE_BPS.map(bps => <option key={bps} value={bps}>{bps / 100}%</option>)}
            </select>
          </label>
        </details>

        <dl className="space-y-2 rounded-2xl border border-slate-200 p-4 text-sm">
          <SummaryLine label="Minimum receive" value={summary ? `${shortenAmount(summary.minimum ?? '0')} ${tokenOut}` : '—'} title={summary ? `${summary.minimum} ${tokenOut}` : undefined} />
          <SummaryLine label="Network fee cap · all steps" value={summary ? `≤ ${summary.fee}` : '—'} />
          <SummaryLine label={provider === 'circle' ? 'Circle fees' : 'Trading fees'} value={summary?.otherFees ?? '—'} />
          <SummaryLine label="Quote expires in" value={summary ? `${summary.expiresIn} seconds` : '—'} />
        </dl>

        <div className="min-h-[2.5rem] space-y-1">
          {!isConnected && <p role="status" className="text-sm text-slate-600">Connect your wallet using the header to get a quote. Nothing is signed.</p>}
          {isConnected && chainId !== 5042 && <p role="status" className="text-sm text-amber-700">Switch your wallet to Arc Mainnet to get a quote.</p>}
          {walletReady && uniswap.invalidAmount && <p role="status" className="text-sm text-slate-600">Enter a positive amount of at most {formatUnits(ARC_INPUT_CAPS[tokenIn], inDecimals)} {tokenIn} with at most {inDecimals} decimal places.</p>}
          {walletReady && circle.insufficientBalance && <p role="status" className="text-sm text-amber-700">Insufficient {tokenIn} balance for this amount.</p>}
          {selected.state === 'error' && <p role="alert" className="break-words text-sm text-red-700">{selected.message}</p>}
          {loading && <p role="status" className="flex items-center gap-2 text-xs text-slate-500"><Loader2 size={14} className="animate-spin" aria-hidden="true" />Updating price…</p>}
        </div>
        <div aria-live="polite" aria-atomic="true" className="min-h-[2rem]">
          {summary ? <p role="status" className="text-xs text-slate-500">Estimate only. Final amounts and fee limits are checked again before confirmation.</p>
            : <p role="status" className="text-xs text-slate-500">{loading ? 'Checking the current quote…' : 'Enter an amount to see a price.'}</p>}
        </div>

        <ApprovalsPanel dialogOnly approvals={approvals} request={provider === 'uniswap' && uniswapAllowed ? uniswap.request : null} />
        <div className="space-y-2">
          <button id="review-swap" type="button" onClick={continueSwap} disabled={!canContinue}
            className="w-full rounded-xl bg-[#2F6E0C] px-5 py-3 font-semibold text-white disabled:cursor-not-allowed disabled:opacity-50">{primaryLabel}</button>
          <div className="min-h-[1.25rem]">
            {reviewBlocked && <p role="status" className="text-xs text-slate-600">{reviewBlocked}</p>}
            {!reviewBlocked && retried === formKey && <p role="status" className="text-xs text-slate-600">The same swap is set up again. Review it to continue; nothing was sent.</p>}
            {/* A message about a transaction is shown once, inside that transaction's card; only Review-stage messages appear here. */}
            {active_.view.error && !active_.view.attempt && <PlainMessage raw={active_.view.error} />}
            {provider === 'uniswap' && approvals.view.error && !approvals.view.attempt && <PlainMessage raw={approvals.view.error} />}
            {provider === 'uniswap' && erc20Input && approvals.plan.state === 'error' && <p role="status" className="text-xs text-amber-800">Token permissions could not be checked. Change the amount to try again; nothing was requested.</p>}
            {needsApproval && <p role="status" className="text-xs text-slate-500">Exact amount only. Review each permission before the swap.</p>}
          </div>
        </div>
        <UniswapReviewDialog execution={execution} />
        <CircleReviewDialog execution={circleExecution} />
      </div>

      <details aria-label="Swap activity" open={Boolean((showActivity && latest) || latest?.presentation.working || latest?.presentation.notice || latest?.live?.error || activityUnreadable)}
        onToggle={event => setShowActivity(event.currentTarget.open)} className="rounded-2xl border border-slate-200 bg-white p-4 text-sm text-slate-600">
        <summary className="cursor-pointer font-medium">Your swaps{latest ? ` · ${latest.presentation.short}` : ''}</summary>
        <SwapActivityPanel latest={latest} earlier={earlier} busy={executionBusy} onCheck={checkItem} onRetry={retryItem} onRecover={hash => { void (latest?.provider === 'circle' ? circleExecution.recover(hash) : execution.recover(hash)) }}
        unreadable={activityUnreadable}
        archiveUnreadable={[...execution.stored, ...approvals.stored, ...circleExecution.stored].reduce((sum, history) => sum + (history.archiveUnreadable ?? 0), 0)} />
      </details>

      <details aria-label="Swap details" className="text-sm text-slate-500">
        <summary className="cursor-pointer text-center">Details & contracts</summary>
        <p className="mt-3">{summary?.route ?? `${tokenIn} → ${tokenOut}`} · {PROVIDER_NAME[provider]}</p>
      <details aria-label="Route support" className="rounded-2xl border border-slate-200 bg-white p-4 text-sm text-slate-600">
        <summary className="cursor-pointer font-medium">How {tokenIn} → {tokenOut} works</summary>
        <div className="mt-3 space-y-3">{(['uniswap', 'circle'] as Provider[]).map(id => {
          const entry = supportFor(id, tokenIn, tokenOut)
          if (!entry) return <p key={id}>{PROVIDER_NAME[id]}: this pair is not supported.</p>
          const build = executionInBuild(entry, SWAP_EXECUTION, CIRCLE_SWAP_WRITES_ENABLED)
          const approval = entry.approval.kind === 'none' ? 'No approval needed: USDC is sent directly with the swap.'
            : entry.approval.kind === 'permit2_exact' ? `Two one-time permissions for exactly the amount you swap (never unlimited), each confirmed in your wallet before the swap.`
            : entry.approval.kind === 'adapter_permit' ? 'One signature (no fee) that allows exactly the amount you swap, then the swap.' : 'One approval for exactly the amount you swap, then the swap.'
          return <section key={id} aria-label={`${PROVIDER_NAME[id]} support`} className="space-y-1">
            <h3 className="font-semibold text-slate-900">{PROVIDER_NAME[id]}</h3>
            <p><span className="text-slate-500">Route:</span> {entry.routes.join(' · ')}</p>
            <p><span className="text-slate-500">Approvals:</span> {approval}</p>
            <p><span className="text-slate-500">Available:</span> <strong className={build.available ? 'text-[#2F6E0C]' : 'text-slate-800'}>{build.available ? 'Yes' : 'Quotes only'}</strong></p>
            <details className="text-xs text-slate-500"><summary className="cursor-pointer">Technical details</summary>
              <ul className="mt-1 space-y-1"><li>Price source: {entry.quote}</li><li>Routing: {entry.routing}</li><li>Approval: {entry.approval.text}</li><li>Verification: {entry.verification}</li><li>In this build: {build.text}</li><li>Real transactions by this app: {entry.liveTransaction}</li></ul></details>
          </section>
        })}</div>
      </details>
      <details className="rounded-2xl border border-slate-200 bg-white p-4 text-sm text-slate-600">
        <summary className="cursor-pointer font-medium">Verified contracts · Arc Mainnet 5042</summary>
        <p className="mt-3 break-all">Uniswap Universal Router 2.1.2: {ARC_ROUTER}</p>
        <ul className="mt-3 space-y-3">{Object.values(MAINNET_SWAP_TOKENS).map(token => <li key={token.symbol} className="break-all"><strong>{token.symbol}</strong> · {token.decimals} decimals<br />{token.address}</li>)}</ul>
        <a href="https://docs.arc.io/arc/references/contract-addresses" target="_blank" rel="noopener noreferrer" className="mt-3 inline-block underline">Official Arc contract registry</a>
      </details>
      </details>
    </section>
  </Container>
}

function ProviderCard({ id, quote, selected, best, tokenOut, onSelect, onlyOne, quotesOnly }: { id: Provider; quote: ProviderQuote; selected: boolean; best: boolean; tokenOut: string; onSelect(): void; onlyOne: boolean; quotesOnly: boolean }) {
  return <button type="button" role="radio" aria-checked={selected} aria-label={`${PROVIDER_NAME[id]} quote`} onClick={onSelect}
    className={`min-h-[5.5rem] w-full rounded-2xl border p-3 text-left text-sm transition-colors ${selected ? 'border-[#2F6E0C] bg-[#f4faef]' : 'border-slate-200 bg-white hover:bg-slate-50'}`}>
    <span className="flex items-center justify-between gap-2">
      <span className="font-semibold text-slate-900">{id === 'circle' ? 'Circle' : 'Uniswap'}</span>
      <span className="flex flex-wrap items-center justify-end gap-1 text-xs">{best && <span className="rounded-full bg-[#2F6E0C] px-2 py-0.5 font-medium text-white">Best price</span>}{quotesOnly && <span className="rounded-full border border-slate-300 px-2 py-0.5 text-slate-600">Quotes only</span>}{selected && <span aria-hidden="true" className="text-[#2F6E0C]">✓</span>}</span>
    </span>
    {quote.state === 'quoted' && <span className="mt-1 block space-y-0.5">
      <span className="block text-base font-semibold text-slate-900" title={`${quote.estimated} ${tokenOut}`}>{shortenAmount(quote.estimated ?? '0')} {tokenOut}</span>
      <span className="block text-xs text-slate-600">Minimum {shortenAmount(quote.minimum ?? '0')} {tokenOut}{onlyOne ? ' · only available quote' : ''}</span>
    </span>}
    {quote.state === 'loading' && <span className="mt-1 flex items-center gap-2 text-xs text-slate-500"><Loader2 size={12} className="animate-spin" aria-hidden="true" />Updating price…</span>}
    {quote.state === 'idle' && <span className="mt-1 block text-xs text-slate-500">Enter an amount to see this provider’s price.</span>}
    {quote.state === 'unsupported' && <span role="status" className="mt-1 block break-words text-xs text-amber-800">{quote.message}</span>}
    {/* The selected provider's error is announced once, below; the other provider's is shown here. */}
    {quote.state === 'error' && <span role={selected ? undefined : 'status'} className="mt-1 block break-words text-xs text-amber-800">{selected ? 'Quote unavailable' : quote.message}</span>}
  </button>
}
function SummaryLine({ label, value, title }: { label: string; value: string; title?: string }) {
  return <div className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] gap-3"><dt className="text-slate-500">{label}</dt><dd title={title} className="min-w-0 break-words text-right font-medium text-slate-900">{value}</dd></div>
}
