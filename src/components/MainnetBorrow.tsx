import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useAccount } from 'wagmi'
import {
  AlertTriangle,
  Banknote,
  CheckCircle2,
  Clock,
  HelpCircle,
  Info,
  Lock,
  MinusCircle,
  RefreshCw,
  ShieldAlert,
  ShieldCheck,
  Wallet,
  XCircle,
} from 'lucide-react'
import {
  formatDecimalString,
  formatRatioPercent,
  formatUtcDateTime,
  loadArcBorrowMarkets,
  shortenMarketId,
  type BorrowMarketState,
} from '../lib/arcIntelligence'
import {
  compareDecimals,
  compareHealthFactor,
  describeBorrowError,
  describeVerificationReason,
  displayDigits,
  evaluateBorrowRisk,
  formatHealthFactor,
  formatOraclePrice,
  formatUnitsText,
  healthBandLabel,
  healthBandTone,
  illustrativeYearlyInterest,
  isHighUtilization,
  isZeroDecimal,
  liquidityStatus,
  marketLiquidity,
  parsePositiveAmount,
  sanitizeDecimalInput,
  smallestShown,
  summarizeRisk,
  thresholdStatus,
  totalGasWei,
  type HealthTone,
  type Reading,
  type RiskReport,
  type RiskStatus,
} from '../lib/borrowPreview'
import { createViemMarketReader, verifyBorrowMarket, type MarketChainReader, type MarketVerification } from '../lib/borrowMarketVerification'
import {
  getBorrowLoans,
  quoteBorrow,
  quoteMaxBorrow,
  quoteRequiredCollateral,
  type BorrowAmount,
  type BorrowAvailability,
  type BorrowError,
  type BorrowHealthBand,
  type BorrowMarket,
  type BorrowPosition,
  type BorrowQuote,
  type BorrowReadClient,
} from '../lib/mainnetBorrow'
import { MAINNET_BORROW_HIGH_UTILIZATION, MAINNET_BORROW_MAX_LTV } from '../config/mainnetBorrow'
import { MAINNET_CONFIG } from '../config/mainnet'
import { MAINNET_ARC_NATIVE_CURRENCY } from '../config/mainnetNetworks'
import { Container } from './ui'

// Borrow tab (Mainnet), read only. Every number comes from the guarded Borrow Kit reads in src/lib/mainnetBorrow.ts, the
// same-origin market proxy or Morpho Blue on-chain (view calls); a missing value is shown as "Not reported", never
// estimated. This module imports no write path (executeBorrowWrite, planBorrowWrite, wallet capability probes): it cannot
// sign, approve or send anything, and its only action buttons are permanently disabled.

const TARGET_HEALTH_FACTORS = [1.25, 1.5, 2] as const
const POSITIONS_PAGE_SIZE = 20
const DEBOUNCE_MS = 450

const UNEXPECTED: BorrowAvailability<never> = { status: 'unavailable', error: { code: 'unexpected_error', retryable: false } }

type Query<T> = { status: 'idle' } | { status: 'loading' } | BorrowAvailability<T>
type IconType = typeof Clock

let chainReader: MarketChainReader | null = null
// Public Arc RPC view calls only; one reader (and its chain ID check) is shared by every market check.
const defaultVerifyMarket = (market: BorrowMarket) => verifyBorrowMarket(market, (chainReader ??= createViemMarketReader(MAINNET_CONFIG.arcRpcUrl)))

const shortAddress = (value: string) => (value.length > 12 ? `${value.slice(0, 6)}...${value.slice(-4)}` : value)

function useDebounced<T>(value: T, ms = DEBOUNCE_MS): T {
  const [debounced, setDebounced] = useState(value)
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), ms)
    return () => clearTimeout(timer)
  }, [value, ms])
  return debounced
}

// One read keyed by its inputs. A null key is idle; a result for an older key is never shown for the current one.
function useBorrowRead<T>(key: string | null, load: () => Promise<BorrowAvailability<T>>): Query<T> {
  const [settled, setSettled] = useState<{ key: string; result: BorrowAvailability<T> } | null>(null)
  const loadRef = useRef(load)
  loadRef.current = load
  useEffect(() => {
    if (key === null) return undefined
    let live = true
    loadRef.current().then(
      (result) => { if (live) setSettled({ key, result }) },
      () => { if (live) setSettled({ key, result: UNEXPECTED }) },
    )
    return () => { live = false }
  }, [key])
  if (key === null) return { status: 'idle' }
  return settled?.key === key ? settled.result : { status: 'loading' }
}

type MorePositions = { key: string; items: BorrowPosition[]; next: string | null; busy: boolean; error: BorrowError | null }

function usePositions(walletAddress: string | null, client: BorrowReadClient | undefined, refresh: number) {
  const key = walletAddress ? `loans:${walletAddress.toLowerCase()}:${refresh}` : null
  const first = useBorrowRead(key, () => getBorrowLoans({ walletAddress: walletAddress ?? '', pageSize: POSITIONS_PAGE_SIZE }, client))
  const [more, setMore] = useState<MorePositions | null>(null)
  const current = more && more.key === key ? more : null

  const loadMore = useCallback(async () => {
    if (!key || !walletAddress || first.status !== 'available') return
    const base: MorePositions = current ?? { key, items: [], next: first.data.nextPageAfter, busy: false, error: null }
    if (!base.next || base.busy) return
    setMore({ ...base, busy: true, error: null })
    const result = await getBorrowLoans({ walletAddress, pageSize: POSITIONS_PAGE_SIZE, pageAfter: base.next }, client)
    setMore((latest) => {
      if (!latest || latest.key !== key) return latest
      if (result.status === 'unavailable') return { ...latest, busy: false, error: result.error }
      return { ...latest, busy: false, error: null, items: [...base.items, ...result.data.items], next: result.data.nextPageAfter }
    })
  }, [key, walletAddress, first, current, client])

  return {
    first,
    extra: current?.items ?? [],
    next: first.status === 'available' ? (current ? current.next : first.data.nextPageAfter) : null,
    busy: current?.busy ?? false,
    moreError: current?.error ?? null,
    loadMore,
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Formatting

const NOT_REPORTED = 'Not reported'

function amountText(amount: BorrowAmount | null): string | null {
  if (!amount) return null
  const shown = formatDecimalString(amount.amount, displayDigits(amount.decimals))
  return shown === null ? null : `${shown}\u00a0${amount.token}`
}

const percentText = (ratio: number | null) => (ratio === null ? null : formatRatioPercent(ratio))

const TONE_CLASS: Record<HealthTone, string> = {
  safe: 'border-emerald-200 bg-emerald-50 text-emerald-800',
  caution: 'border-amber-200 bg-amber-50 text-amber-800',
  danger: 'border-red-200 bg-red-50 text-red-700',
}

// Null when the service reported neither a health factor nor a band, so the row reads "Not reported". The status says where
// the loan stands against the liquidation threshold: the service's band when it gave one, otherwise the health factor itself.
function healthValue(value: number | null, band: BorrowHealthBand | null): ReactNode | null {
  if (value === null && band === null) return null
  const status = band ? { label: healthBandLabel(band), tone: healthBandTone(band) } : value !== null ? thresholdStatus(value) : null
  return (
    <span className="inline-flex flex-wrap items-center justify-end gap-2">
      {value !== null && <span>{formatHealthFactor(value)}</span>}
      {status && <span className={`rounded-lg border px-2 py-0.5 text-right text-[11px] font-semibold leading-4 ${TONE_CLASS[status.tone]}`}>{status.label}</span>}
    </span>
  )
}

// ---------------------------------------------------------------------------------------------------------------------
// Small building blocks

function Metric({ label, note, value, strong = false }: { label: string; note?: string; value: ReactNode | null; strong?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-1.5 text-sm">
      <dt className="min-w-0 flex-1 text-slate-500">
        {label}
        {note && <span className="block text-[11px] leading-4 text-slate-400">{note}</span>}
      </dt>
      <dd className={`max-w-[62%] shrink-0 break-words text-right tabular-nums ${strong ? 'font-semibold text-slate-900' : 'font-medium text-slate-800'}`}>
        {value ?? <span className="font-normal text-slate-400">{NOT_REPORTED}</span>}
      </dd>
    </div>
  )
}

function Notice({ tone, children }: { tone: 'info' | 'note' | 'warn' | 'error'; children: ReactNode }) {
  const style = tone === 'warn' || tone === 'note'
    ? 'border-amber-200 bg-amber-50 text-amber-900'
    : tone === 'error'
      ? 'border-red-200 bg-red-50 text-red-800'
      : 'border-slate-200 bg-slate-50 text-slate-600'
  const Icon = tone === 'info' || tone === 'note' ? Info : AlertTriangle
  return (
    <div className={`flex items-start gap-2 rounded-xl border px-3 py-2.5 text-xs leading-5 ${style}`}>
      <Icon size={14} className="mt-0.5 shrink-0" />
      <div className="min-w-0 [overflow-wrap:anywhere]">{children}</div>
    </div>
  )
}

function ReadFailure({ error, onRetry }: { error: BorrowError; onRetry?: () => void }) {
  return (
    <Notice tone="warn">
      <p>{describeBorrowError(error)}</p>
      <p className="mt-1 font-mono text-[11px] text-amber-800/80">{error.code}{error.sdkCode !== undefined ? ` · ${error.sdkCode}` : ''}</p>
      {onRetry && error.retryable && (
        <button type="button" onClick={onRetry} className="mt-2 font-semibold underline underline-offset-2">Try again</button>
      )}
    </Notice>
  )
}

function Panel({ children }: { children: ReactNode }) {
  return (
    <section className="min-w-0 rounded-2xl border border-slate-200 bg-white p-4 shadow-[0_18px_40px_rgba(15,23,42,0.06)] sm:p-6">
      {children}
    </section>
  )
}

function SectionTitle({ title, hint, right }: { title: string; hint?: string; right?: ReactNode }) {
  return (
    <div className="mb-3 flex flex-wrap items-start justify-between gap-2">
      <div className="min-w-0">
        <h2 className="text-base font-semibold text-slate-900">{title}</h2>
        {hint && <p className="mt-0.5 text-xs leading-5 text-slate-500">{hint}</p>}
      </div>
      {right}
    </div>
  )
}

function LoadingBars({ rows = 3 }: { rows?: number }) {
  return (
    <div className="animate-pulse space-y-2" aria-hidden="true">
      {Array.from({ length: rows }, (_, index) => <div key={index} className="h-4 rounded bg-slate-100" />)}
    </div>
  )
}

function RiskNotice() {
  return (
    <section aria-label="Borrowing risks" data-borrow-section="risks" className="rounded-2xl border border-amber-200 bg-amber-50/70 p-4 sm:p-5">
      <div className="flex items-center gap-2 text-sm font-semibold text-amber-900">
        <ShieldAlert size={16} />
        Understand the risks before borrowing
      </div>
      <ul className="mt-3 space-y-2.5 text-xs leading-5 text-amber-950/90">
        <li>
          <span className="font-semibold">Liquidation risk.</span> Your cirBTC is locked as collateral. If its price falls or your debt grows, your
          health factor falls. Below 1.0 the loan can be liquidated: others may repay part of your debt and take your collateral, so you can lose
          part or all of it. The maximum borrow the service reports sits at that threshold. Keep a wide margin above 1.0 and monitor the position.
        </li>
        <li>
          <span className="font-semibold">Variable interest.</span> The borrow rate is set by the market and can change at any time. The APY shown
          is a snapshot, not a fixed rate or a promise. Interest keeps accruing on the debt, so your cost can rise.
        </li>
        <li>
          <span className="font-semibold">Limited liquidity.</span> The available liquidity of a market caps how much can be borrowed from it.
        </li>
      </ul>
    </section>
  )
}

// ---------------------------------------------------------------------------------------------------------------------
// Markets

type BadgeTone = 'good' | 'bad' | 'warn' | 'neutral'

const BADGE_CLASS: Record<BadgeTone, string> = {
  good: 'border-emerald-200 bg-emerald-50 text-emerald-800',
  bad: 'border-red-200 bg-red-50 text-red-700',
  warn: 'border-amber-200 bg-amber-50 text-amber-800',
  neutral: 'border-slate-200 bg-slate-50 text-slate-600',
}

function Badge({ tone, icon: Icon, title, children }: { tone: BadgeTone; icon: IconType; title?: string; children: ReactNode }) {
  return (
    <span title={title} className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-semibold ${BADGE_CLASS[tone]}`}>
      <Icon size={11} />
      {children}
    </span>
  )
}

// Only a completed on-chain match is "verified"; every other state, including a failed check, reads as not verified.
function VerificationBadge({ verification }: { verification: MarketVerification | undefined }) {
  if (!verification || verification.status === 'checking') return <Badge tone="neutral" icon={Clock}>Checking</Badge>
  if (verification.status === 'verified') return <Badge tone="good" icon={ShieldCheck}>Verified on-chain</Badge>
  return <Badge tone={verification.status === 'unverified' ? 'bad' : 'warn'} icon={ShieldAlert}>Not verified</Badge>
}

// The long form of the verification result, shown only inside "Market details".
function verificationSentence(verification: MarketVerification | undefined): string {
  if (!verification || verification.status === 'checking') return 'Checking against Morpho on Arc.'
  if (verification.status === 'verified') return 'Matches Morpho on Arc: the ID hashes from the on-chain parameters, and the tokens, LLTV, oracle and rate model check out.'
  if (verification.status === 'unverified') return verification.reasons.map(describeVerificationReason).join(' ')
  return 'Morpho could not be read on-chain, so this market is not verified. Do not rely on it.'
}

function DetailRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5 sm:flex-row sm:justify-between sm:gap-3">
      <dt className="shrink-0 text-slate-400">{label}</dt>
      <dd className="min-w-0 break-all text-slate-700 sm:text-right">{children}</dd>
    </div>
  )
}

// A market card: the pair, APY, available liquidity, LLTV and short status labels. Everything else is under "Market details".
function MarketCard({ market, verification, borrowAmount, selected, onSelect }: {
  market: BorrowMarket
  verification: MarketVerification | undefined
  borrowAmount: string | null
  selected: boolean
  onSelect: () => void
}) {
  const details = verification && (verification.status === 'verified' || verification.status === 'unverified') ? verification.details : null
  const view = marketLiquidity(market, verification)
  const loanDigits = displayDigits(market.loanAsset.decimals)
  const liquidity = liquidityStatus(view, borrowAmount, loanDigits)
  const insufficient = liquidity.status === 'none' || liquidity.status === 'short'
  const highUtilization = isHighUtilization(market.utilization, MAINNET_BORROW_HIGH_UTILIZATION)
  const oracleMissing = details !== null && details.oraclePrice === null
  const oraclePrice = details && details.oraclePrice !== null
    ? formatOraclePrice(details.oraclePrice, market.loanAsset.decimals, market.collateralAsset.decimals) : null
  const loanText = (value: string | null) => {
    const shown = value === null ? null : formatDecimalString(value, loanDigits)
    return shown === null ? null : `${shown} ${market.loanAsset.symbol}`
  }
  return (
    <div
      data-borrow-card={market.marketId}
      className={`min-w-0 overflow-hidden rounded-2xl border transition-colors ${
        selected ? 'border-[#66D121]/60 bg-[#eef7e8] ring-1 ring-[#66D121]/30' : 'border-slate-200 bg-white hover:border-slate-300'
      }`}
    >
      <button type="button" role="radio" aria-checked={selected} onClick={onSelect} data-borrow-market={market.marketId} className="block w-full p-4 text-left">
        <div className="flex items-center justify-between gap-2">
          <span className="text-sm font-semibold text-slate-900">{market.collateralAsset.symbol} / {market.loanAsset.symbol}</span>
          <span className={`text-[11px] font-semibold ${selected ? 'text-[#2F6E0C]' : 'text-slate-400'}`}>{selected ? 'Selected' : 'Select'}</span>
        </div>
        <div className="mt-2 flex flex-wrap gap-1.5" data-borrow-flags>
          <VerificationBadge verification={verification} />
          {insufficient && <Badge tone="bad" icon={XCircle}>Insufficient Liquidity</Badge>}
          {highUtilization && <Badge tone="warn" icon={AlertTriangle}>High utilization</Badge>}
          {oracleMissing && <Badge tone="bad" icon={XCircle}>Oracle data missing</Badge>}
        </div>
        <dl className="mt-2 divide-y divide-slate-100">
          <Metric label="Borrow APY" note="Variable" value={percentText(market.borrowApy)} strong />
          <Metric label="Available liquidity" value={amountText(market.liquidity)} />
          <Metric label="LLTV" value={percentText(market.lltv)} />
        </dl>
      </button>
      <details className="border-t border-slate-100 px-4" data-borrow-details>
        <summary className="cursor-pointer select-none py-2.5 text-xs font-semibold text-slate-600">Market details</summary>
        <dl className="space-y-1.5 pb-3 text-[11px] leading-5">
          <DetailRow label="Market ID"><span className="font-mono">{market.marketId}</span></DetailRow>
          <DetailRow label="On-chain check">{verificationSentence(verification)}</DetailRow>
          {details && (
            <>
              <DetailRow label="Oracle"><span className="font-mono">{details.params.oracle}</span></DetailRow>
              <DetailRow label="Oracle price">{oraclePrice === null ? 'Not available' : `${oraclePrice} ${market.loanAsset.symbol} per ${market.collateralAsset.symbol}`}</DetailRow>
              <DetailRow label="Rate model"><span className="font-mono">{details.params.irm}</span></DetailRow>
            </>
          )}
          {view.onchain !== null && <DetailRow label="Liquidity on-chain">{loanText(view.onchain)}</DetailRow>}
          <DetailRow label="Utilization">{percentText(market.utilization) ?? NOT_REPORTED}</DetailRow>
          <DetailRow label="Total borrowed">{amountText(market.borrowAssets) ?? NOT_REPORTED}</DetailRow>
          <DetailRow label="Updated">{market.refreshedAt ? formatUtcDateTime(market.refreshedAt) : NOT_REPORTED}</DetailRow>
        </dl>
        {insufficient && (
          <p className="pb-3 text-[11px] leading-4 text-red-700">
            {liquidity.status === 'none'
              ? `No usable liquidity: less than ${smallestShown(loanDigits)} ${market.loanAsset.symbol} is available to borrow.`
              : `Only ${loanText(view.available) ?? 'a smaller amount'} is available, below your borrow amount.`}
          </p>
        )}
        {highUtilization && (
          <p className="pb-3 text-[11px] leading-4 text-amber-800">
            High market utilization (at or above {formatRatioPercent(MAINNET_BORROW_HIGH_UTILIZATION)}): most supplied funds are already lent out, so the
            variable borrow rate can rise quickly. This flags rate risk, not the amount available.
          </p>
        )}
      </details>
    </div>
  )
}

function MarketsSection({ state, verifications, borrowAmount, selectedId, onSelect, onReload }: {
  state: BorrowMarketState
  verifications: Record<string, MarketVerification>
  borrowAmount: string | null
  selectedId: string | null
  onSelect: (marketId: string) => void
  onReload: () => void
}) {
  const markets = state.status === 'available' ? state.markets : []
  return (
    <Panel>
      <div data-borrow-section="markets">
        <SectionTitle title="Arc cirBTC / USDC markets" hint="Choose the market to quote. Markets are listed by ID and are not ranked." />
        {state.status === 'loading' && <LoadingBars rows={4} />}
        {state.status === 'unavailable' && (
          <Notice tone="warn">
            <p>Market data could not be read right now, so no market is shown and no quote can be made.</p>
            <button type="button" onClick={onReload} className="mt-2 font-semibold underline underline-offset-2">Try again</button>
          </Notice>
        )}
        {state.status === 'available' && state.complete === false && (
          <div className="mb-3" data-borrow-incomplete>
            <Notice tone="warn">
              The market list may be incomplete: Circle reported more markets than could be read in one request. Try again later.
            </Notice>
          </div>
        )}
        {state.status === 'available' && (
          <div role="radiogroup" aria-label="Borrow market" className={`grid gap-3 ${markets.length > 1 ? 'md:grid-cols-2' : ''}`}>
            {markets.map((market) => (
              <MarketCard key={market.marketId} market={market} verification={verifications[market.marketId.toLowerCase()]}
                borrowAmount={borrowAmount} selected={market.marketId === selectedId} onSelect={() => onSelect(market.marketId)} />
            ))}
          </div>
        )}
        {state.status === 'available' && (
          <p className="mt-3 text-[11px] leading-5 text-slate-400">
            Terms come from Circle Borrow Kit and can be up to five minutes old. Each market is also checked against Morpho on Arc; open Market details
            for the evidence. A market that cannot be checked is never shown as verified.
          </p>
        )}
      </div>
    </Panel>
  )
}

// ---------------------------------------------------------------------------------------------------------------------
// Quote builder

function AmountField({ id, label, symbol, value, onChange, disabled, hint }: {
  id: string
  label: string
  symbol: string
  value: string
  onChange: (value: string) => void
  disabled: boolean
  hint: string
}) {
  return (
    <div>
      <label htmlFor={id} className="text-sm font-medium text-slate-700">{label}</label>
      <div className="relative mt-1.5">
        <input
          id={id}
          type="text"
          inputMode="decimal"
          autoComplete="off"
          spellCheck={false}
          placeholder="0.0"
          value={value}
          disabled={disabled}
          onChange={(event) => onChange(event.target.value)}
          className="w-full rounded-xl border border-slate-300 bg-white px-4 py-3 pr-20 text-slate-900 placeholder-slate-400 focus:border-[#2F6E0C] focus:outline-none focus:ring-4 focus:ring-[#66D121]/15 disabled:cursor-not-allowed disabled:bg-slate-50"
        />
        <span className="pointer-events-none absolute right-4 top-1/2 -translate-y-1/2 text-sm font-semibold text-slate-500">{symbol}</span>
      </div>
      <p className="mt-1 text-[11px] leading-4 text-slate-400">{hint}</p>
    </div>
  )
}

function quoteOf<K extends BorrowQuote['kind']>(query: Query<BorrowQuote>, kind: K): Extract<BorrowQuote, { kind: K }> | null {
  return query.status === 'available' && query.data.kind === kind ? (query.data as Extract<BorrowQuote, { kind: K }>) : null
}

// A read for the risk checks: its value, null when the read failed, 'pending' while it is idle or loading.
function reading<T>(query: Query<BorrowQuote>, pick: (quote: BorrowQuote) => T | null): Reading<T> {
  if (query.status === 'available') return pick(query.data)
  return query.status === 'unavailable' ? null : 'pending'
}

function QueryState({ query, idle, onRetry }: { query: Query<BorrowQuote>; idle: string; onRetry?: () => void }) {
  if (query.status === 'idle') return <p className="text-xs leading-5 text-slate-400">{idle}</p>
  if (query.status === 'loading') return <LoadingBars rows={3} />
  if (query.status === 'unavailable') return <ReadFailure error={query.error} onRetry={onRetry} />
  return null
}

const RISK_STYLE: Record<RiskStatus, { icon: IconType; className: string; label: string }> = {
  pass: { icon: CheckCircle2, className: 'text-emerald-600', label: 'Pass' },
  warn: { icon: AlertTriangle, className: 'text-amber-600', label: 'Warning' },
  fail: { icon: XCircle, className: 'text-red-600', label: 'Fail' },
  unknown: { icon: HelpCircle, className: 'text-red-600', label: 'Cannot be evaluated' },
  pending: { icon: Clock, className: 'text-slate-400', label: 'Waiting' },
  skipped: { icon: MinusCircle, className: 'text-slate-400', label: 'Not applicable' },
}

const SUMMARY_CLASS = { fail: 'text-red-700', warn: 'text-amber-700', pending: 'text-slate-500', pass: 'text-emerald-700' } as const

// Toggle text for a native <details>: "Show ..." while closed, "Hide ..." while open.
function ToggleSummary({ label }: { label: string }) {
  return (
    <summary className="cursor-pointer select-none text-xs font-semibold text-slate-600">
      <span className="group-open:hidden">Show {label}</span>
      <span className="hidden group-open:inline">Hide {label}</span>
    </summary>
  )
}

// One short summary on the main screen; the individual checks stay behind "Show risk checks".
function RiskChecks({ report }: { report: RiskReport }) {
  if (report.checks.length === 0) return null
  const summary = summarizeRisk(report)
  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-4" data-borrow-risk>
      <h3 className="text-sm font-semibold text-slate-900">Risk summary</h3>
      <p className={`mt-1 text-xs font-semibold ${SUMMARY_CLASS[summary.tone]}`} data-risk-summary>{summary.text}</p>
      <details className="group mt-2" data-borrow-risk-details>
        <ToggleSummary label="risk checks" />
        <p className="mb-2 mt-2 text-[11px] leading-4 text-slate-500">
          Limits Machina would apply to a future borrow: {formatRatioPercent(MAINNET_BORROW_MAX_LTV)} loan-to-value and a {formatRatioPercent(MAINNET_BORROW_HIGH_UTILIZATION)} utilization
          flag. They are fixed labels, not market data, and a pass is not a guarantee against liquidation. Missing data is never counted as a pass.
        </p>
        <ul className="space-y-2">
          {report.checks.map((check) => {
            const style = RISK_STYLE[check.status]
            return (
              <li key={check.id} data-risk-check={check.id} data-risk-status={check.status} className="flex items-start gap-2 text-xs leading-5 text-slate-700">
                <style.icon size={14} className={`mt-0.5 shrink-0 ${style.className}`} />
                <span className="min-w-0 [overflow-wrap:anywhere]"><span className={`font-semibold ${style.className}`}>{style.label}.</span> {check.text}</span>
              </li>
            )
          })}
        </ul>
      </details>
    </div>
  )
}

type QuoteInputs = {
  collateralText: string
  borrowText: string
  targetHealthFactor: number
  setCollateralText: (value: string) => void
  setBorrowText: (value: string) => void
  setTargetHealthFactor: (value: number) => void
}

function SubHeading({ children }: { children: ReactNode }) {
  return <h4 className="mb-1 text-xs font-semibold text-slate-700">{children}</h4>
}

function QuoteBuilder({ market, verification, walletAddress, client, refresh, bump, inputs }: {
  market: BorrowMarket | null
  verification: MarketVerification | undefined
  walletAddress: string | null
  client: BorrowReadClient | undefined
  refresh: number
  bump: () => void
  inputs: QuoteInputs
}) {
  const { collateralText, borrowText, targetHealthFactor } = inputs

  const collateralInput = useDebounced(market ? parsePositiveAmount(collateralText) : null)
  const borrowInput = useDebounced(market ? parsePositiveAmount(borrowText) : null)
  const marketId = market?.marketId ?? null
  const collateralSymbol = market?.collateralAsset.symbol ?? 'cirBTC'
  const loanSymbol = market?.loanAsset.symbol ?? 'USDC'
  const target = targetHealthFactor.toFixed(2)

  const maxBorrow = useBorrowRead(
    marketId && collateralInput ? `max:${marketId}:${collateralInput}:${refresh}` : null,
    () => quoteMaxBorrow({ marketId: marketId ?? '', collateralAmount: collateralInput ?? '' }, client),
  )
  const sizing = useBorrowRead(
    marketId && borrowInput ? `size:${marketId}:${borrowInput}:${targetHealthFactor}:${refresh}` : null,
    () => quoteRequiredCollateral({ marketId: marketId ?? '', borrowAmount: borrowInput ?? '', targetHealthFactor }, client),
  )
  const borrowQuote = useBorrowRead(
    marketId && borrowInput && walletAddress ? `borrow:${marketId}:${walletAddress.toLowerCase()}:${borrowInput}:${refresh}` : null,
    () => quoteBorrow({ marketId: marketId ?? '', walletAddress: walletAddress ?? '', borrowAmount: borrowInput ?? '' }, client),
  )

  const max = quoteOf(maxBorrow, 'max-borrow')
  const required = quoteOf(sizing, 'required-collateral')
  const full = quoteOf(borrowQuote, 'borrow')

  const risk = evaluateBorrowRisk({
    market,
    verification: market ? verification ?? { status: 'checking' } : null,
    borrowAmount: borrowInput,
    collateralAmount: collateralInput,
    targetHealthFactor,
    maxBorrow: reading(maxBorrow, (quote) => (quote.kind === 'max-borrow' ? quote.maxBorrow : null)),
    sizing: reading(sizing, (quote) => (quote.kind === 'required-collateral' ? { healthFactor: quote.resultingHealthFactor } : null)),
    full: reading(borrowQuote, (quote) => (quote.kind === 'borrow' ? { ltv: quote.resultingLtv, healthFactor: quote.resultingHealthFactor } : null)),
    limits: { maxLtv: MAINNET_BORROW_MAX_LTV, highUtilization: MAINNET_BORROW_HIGH_UTILIZATION },
  })

  // The main quote is the wallet's Borrow Kit quote. Without a wallet (or when that quote fails) it falls back to the collateral
  // the Borrow Service sizes for the selected target, which needs no wallet.
  const primary = walletAddress ? borrowQuote : sizing
  const sizedOnly = full === null && required !== null && (!walletAddress || borrowQuote.status === 'unavailable')
  const shown = full
    ? { collateral: full.collateral, healthFactor: full.resultingHealthFactor, band: full.resultingBand as BorrowHealthBand | null, liquidationPrice: full.liquidationPrice, apy: full.borrowApy }
    : sizedOnly && required
      ? { collateral: required.requiredCollateral, healthFactor: required.resultingHealthFactor, band: null, liquidationPrice: required.liquidationPrice, apy: market?.borrowApy ?? null }
      : null

  const gasWei = full ? totalGasWei(full.gasFees) : null
  const quotedHealthFactor = full ? full.resultingHealthFactor : null
  const gap = quotedHealthFactor !== null ? compareHealthFactor(targetHealthFactor, quotedHealthFactor) : null
  const interest = full ? illustrativeYearlyInterest(full.loanAsset.amount, full.borrowApy) : null
  const loanDigits = displayDigits(market?.loanAsset.decimals ?? 6)
  const borrowShown = borrowInput ? `${formatDecimalString(borrowInput, loanDigits) ?? borrowInput} ${loanSymbol}` : null
  const collateralNotice = collateralInput && required
    ? compareDecimals(collateralInput, required.requiredCollateral.amount) < 0
      ? { tone: 'note' as const, text: `Your collateral is below the ${amountText(required.requiredCollateral)} sized for a ${target} health factor.` }
      : { tone: 'info' as const, text: `Your collateral covers the ${amountText(required.requiredCollateral)} sized for a ${target} health factor.` }
    : null
  const noMarket = market === null
  const unverified = market && verification && verification.status !== 'verified' && verification.status !== 'checking'

  return (
    <Panel>
      <div data-borrow-section="quote">
        <SectionTitle
          title="Borrow quote"
          hint="Enter what you want to borrow. Quotes are estimates read from the Borrow Service."
          right={<span className="inline-flex items-center gap-1 rounded-full border border-slate-200 bg-slate-50 px-2.5 py-0.5 text-[11px] font-semibold text-slate-600"><Lock size={11} />Preview only</span>}
        />
        {noMarket && <div className="mb-4"><Notice tone="info">Choose a market above to start a quote.</Notice></div>}
        {market && (
          <p className="mb-3 text-xs text-slate-500" data-borrow-selected>
            Quoting <span className="font-semibold text-slate-800">{market.collateralAsset.symbol} / {market.loanAsset.symbol}</span>{' '}
            <span className="font-mono" title={market.marketId}>{shortenMarketId(market.marketId)}</span>
          </p>
        )}
        {unverified && (
          <div className="mb-4" data-borrow-unverified>
            <Notice tone="warn">This market is not verified on-chain. Treat these numbers as unconfirmed.</Notice>
          </div>
        )}
        <div className="grid gap-6 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]">
          <div className="min-w-0 space-y-4">
            <AmountField id="borrow-amount" label={`Borrow amount (${loanSymbol})`} symbol={loanSymbol} value={borrowText}
              disabled={noMarket} hint={`Up to ${market?.loanAsset.decimals ?? 6} decimals.`}
              onChange={(value) => inputs.setBorrowText(sanitizeDecimalInput(value, market?.loanAsset.decimals ?? 6))} />
            <AmountField id="borrow-collateral" label={`Collateral you hold (${collateralSymbol})`} symbol={collateralSymbol} value={collateralText}
              disabled={noMarket} hint={`Optional, up to ${market?.collateralAsset.decimals ?? 8} decimals. Used for the quote details.`}
              onChange={(value) => inputs.setCollateralText(sanitizeDecimalInput(value, market?.collateralAsset.decimals ?? 8))} />
            <div>
              <p className="text-sm font-medium text-slate-700">Target health factor</p>
              <div className="mt-1.5 inline-flex rounded-xl border border-slate-200 bg-slate-50 p-0.5" role="group" aria-label="Target health factor">
                {TARGET_HEALTH_FACTORS.map((value) => (
                  <button key={value} type="button" aria-pressed={targetHealthFactor === value} onClick={() => inputs.setTargetHealthFactor(value)}
                    className={`h-8 rounded-[9px] px-3 text-xs font-semibold transition-colors ${
                      targetHealthFactor === value ? 'bg-white text-slate-900 shadow-sm ring-1 ring-[#66D121]/30' : 'text-slate-500 hover:bg-white/70 hover:text-slate-800'
                    }`}>
                    {value.toFixed(2)}
                  </button>
                ))}
              </div>
              <p className="mt-1 text-[11px] leading-4 text-slate-400">Higher keeps more distance from the liquidation threshold (1.0).</p>
            </div>
            {!walletAddress && (
              <Notice tone="info">
                <span className="inline-flex items-center gap-1.5 font-semibold"><Wallet size={12} />No wallet connected</span>
                <p className="mt-1">Connect a wallet for the full quote with estimated gas.</p>
              </Notice>
            )}
          </div>

          <div className="min-w-0 space-y-4">
            <div className="rounded-2xl border border-slate-200 bg-slate-50/60 p-4" data-borrow-summary>
              <h3 className="text-sm font-semibold text-slate-900">Your quote</h3>
              <p className="mb-2 mt-0.5 text-[11px] leading-4 text-slate-500">
                {full ? 'Borrow Kit quote for your wallet. Preview only.'
                  : shown ? `Sized for your selected target of ${target}. Preview only.` : 'Preview only.'}
              </p>
              {borrowInput === null && <p className="text-xs leading-5 text-slate-400">Enter a borrow amount to see your quote.</p>}
              {borrowInput !== null && primary.status === 'loading' && <LoadingBars rows={5} />}
              {borrowInput !== null && primary.status === 'unavailable' && <ReadFailure error={primary.error} onRetry={bump} />}
              {borrowInput !== null && shown && (
                <>
                  <dl className="divide-y divide-slate-100">
                    <Metric label="Borrow amount" value={borrowShown} strong />
                    <Metric label="Collateral needed" value={amountText(shown.collateral)} strong />
                    <Metric label="Borrow APY" note="Variable" value={percentText(shown.apy)} />
                    <Metric label="Estimated gas" value={full
                      ? (gasWei === null ? null : `${formatUnitsText(gasWei, MAINNET_ARC_NATIVE_CURRENCY.decimals, 6)} ${MAINNET_ARC_NATIVE_CURRENCY.symbol}`)
                      : <span className="font-normal text-slate-400">{walletAddress ? 'Not available' : 'Needs a wallet'}</span>} />
                    <Metric label="Health factor" value={healthValue(shown.healthFactor, shown.band)} />
                    <Metric label="Liquidation price" value={amountText(shown.liquidationPrice)} />
                  </dl>
                  {full && gap && (
                    <div className="mt-3" data-borrow-target-note={gap.relation}>
                      {gap.relation === 'below' ? (
                        <Notice tone="error">
                          <p><span className="font-semibold" data-borrow-hf-gap="below">Selected safety target not met.</span> You selected {target}; this quote
                            comes out at {formatHealthFactor(gap.delta + targetHealthFactor)}. The Borrow Service sizes the collateral itself, so a gap like this
                            is not a service error, but a future borrow would be blocked on this quote.{required ? ` Collateral for ${target} is ${amountText(required.requiredCollateral)}.` : ''}</p>
                        </Notice>
                      ) : (
                        <p className="text-[11px] font-semibold text-emerald-700" data-borrow-hf-gap={gap.relation}>Meets your selected target of {target}.</p>
                      )}
                    </div>
                  )}
                </>
              )}
            </div>

            <RiskChecks report={risk} />

            <details className="group rounded-2xl border border-slate-200 bg-white p-4" data-borrow-more>
              <ToggleSummary label="quote details" />
              <div className="mt-3 space-y-4">
                <section>
                  <SubHeading>For your collateral</SubHeading>
                  <QueryState query={maxBorrow} idle="Enter the collateral you hold to see the maximum borrow." onRetry={bump} />
                  {max && (
                    <>
                      <dl className="divide-y divide-slate-100">
                        <Metric label="Maximum borrow" value={amountText(max.maxBorrow)} strong />
                        <Metric label="Health factor at that borrow" value={healthValue(max.resultingHealthFactor, null)} />
                        <Metric label="Liquidation price" note={`${collateralSymbol} price in ${loanSymbol} at which the loan can be liquidated`} value={amountText(max.liquidationPrice)} />
                      </dl>
                      <p className="mt-1 text-[11px] leading-4 text-slate-500" data-borrow-max-note>
                        The maximum sits at the liquidation threshold (health factor {max.resultingHealthFactor === null ? 'not reported' : formatHealthFactor(max.resultingHealthFactor)}).
                        A price move or accrued interest can take the loan below it. Preview only.
                      </p>
                    </>
                  )}
                </section>
                <section>
                  <SubHeading>Collateral sized for your selected target ({target})</SubHeading>
                  <QueryState query={sizing} idle="Enter a borrow amount to size the collateral." onRetry={bump} />
                  {required && (
                    <dl className="divide-y divide-slate-100">
                      <Metric label="Collateral needed" value={amountText(required.requiredCollateral)} strong />
                      <Metric label="Health factor" value={healthValue(required.resultingHealthFactor, null)} />
                      <Metric label="Liquidation price" value={amountText(required.liquidationPrice)} />
                    </dl>
                  )}
                  {collateralNotice && <div className="mt-2"><Notice tone={collateralNotice.tone}>{collateralNotice.text}</Notice></div>}
                </section>
                {full && (
                  <section>
                    <SubHeading>From your wallet quote</SubHeading>
                    <dl className="divide-y divide-slate-100">
                      {full.fees.map((fee, index) => (
                        <Metric key={`${fee.type}-${index}`} label={`Fee · ${fee.type}`} value={amountText(fee.amount)} />
                      ))}
                      {full.fees.length === 0 && <Metric label="Fees" value="None in this quote" />}
                      <Metric label="Resulting LTV" value={percentText(full.resultingLtv)} />
                      <Metric label="Illustrative interest, one year" note="Machina arithmetic: amount × quoted APY, if the rate never changed. Not a service figure."
                        value={interest === null ? null : `≈ ${interest} ${full.loanAsset.token}`} />
                    </dl>
                  </section>
                )}
              </div>
            </details>
          </div>
        </div>

        <div className="mt-5 flex flex-col gap-3 border-t border-slate-100 pt-4 sm:flex-row sm:items-center">
          <button type="button" disabled aria-disabled="true" data-borrow-action="borrow"
            title="Borrowing is not enabled in this release"
            className="inline-flex w-full cursor-not-allowed items-center justify-center gap-2 rounded-xl border border-slate-200 bg-slate-100 px-5 py-3 text-sm font-semibold text-slate-400 sm:w-auto">
            <Lock size={14} />
            Preview only · borrowing not enabled
          </button>
          <p className="min-w-0 flex-1 text-[11px] leading-5 text-slate-400">
            Nothing is sent from this page: no signature, approval or transaction.
          </p>
        </div>
      </div>
    </Panel>
  )
}

// ---------------------------------------------------------------------------------------------------------------------
// Positions

function PositionCard({ position, known, listLoaded }: { position: BorrowPosition; known: BorrowMarket | null; listLoaded: boolean }) {
  const pending = position.economics === 'pending'
  const noDebt = !pending && position.borrowed !== null && isZeroDecimal(position.borrowed.amount)
  const lifecycle = position.lifecycle === 'active' ? 'Active' : position.lifecycle === 'closed' ? 'Closed' : 'Status not reported'
  return (
    <li data-borrow-position={position.loanId} className={`min-w-0 rounded-2xl border p-4 ${position.lifecycle === 'closed' ? 'border-slate-200 bg-slate-50/60' : 'border-slate-200 bg-white'}`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <p className="text-sm font-semibold text-slate-900">
            {known ? `${known.collateralAsset.symbol} / ${known.loanAsset.symbol}` : listLoaded ? 'Market outside the cirBTC / USDC list' : 'Borrow market'}
          </p>
          <p className="font-mono text-[11px] text-slate-400" title={position.marketId}>{shortenMarketId(position.marketId)}</p>
        </div>
        <span className="rounded-full border border-slate-200 bg-slate-50 px-2.5 py-0.5 text-[11px] font-semibold text-slate-600">{lifecycle}</span>
      </div>
      {pending && (
        <div className="mt-3"><Notice tone="info">This loan exists but its collateral and debt are not indexed yet, so none are shown. Refresh in a moment.</Notice></div>
      )}
      <dl className="mt-2 grid gap-x-6 divide-y divide-slate-100 sm:grid-cols-2 sm:divide-y-0">
        <Metric label="Collateral" value={amountText(position.collateral)} strong />
        <Metric label="Debt" value={amountText(position.borrowed)} strong />
        <Metric label="Principal" value={amountText(position.principalBorrowed)} />
        <Metric label="Accrued interest" value={amountText(position.accruedInterest)} />
        <Metric label="Borrow APY" note="Variable" value={percentText(position.borrowApy)} />
        <Metric label="LTV" value={percentText(position.ltv)} />
        <Metric label="Health factor" value={noDebt && position.healthFactor === null ? 'No outstanding debt' : healthValue(position.healthFactor, position.healthBand)} />
        <Metric label="Liquidation price" value={noDebt && position.liquidationPrice === null ? 'No outstanding debt' : amountText(position.liquidationPrice)} />
      </dl>
      <div className="mt-3 flex flex-wrap gap-2 border-t border-slate-100 pt-3">
        {['Repay', 'Add collateral', 'Withdraw', 'Close'].map((action) => (
          <button key={action} type="button" disabled aria-disabled="true" title="Not available in this release" data-borrow-action={action.toLowerCase().replace(' ', '-')}
            className="cursor-not-allowed rounded-lg border border-slate-200 bg-slate-100 px-3 py-1.5 text-xs font-semibold text-slate-400">
            {action}
          </button>
        ))}
      </div>
    </li>
  )
}

function PositionsSection({ walletAddress, client, markets, refresh, bump }: {
  walletAddress: string | null
  client: BorrowReadClient | undefined
  markets: BorrowMarket[]
  refresh: number
  bump: () => void
}) {
  const { first, extra, next, busy, moreError, loadMore } = usePositions(walletAddress, client, refresh)
  const items = first.status === 'available' ? [...first.data.items, ...extra] : []
  const marketById = useMemo(() => new Map(markets.map((market) => [market.marketId.toLowerCase(), market])), [markets])
  return (
    <Panel>
      <div data-borrow-section="positions">
        <SectionTitle
          title="Your loans"
          hint="Read only. Collateral, debt and health come from the Borrow Service for the connected wallet."
          right={walletAddress && (
            <button type="button" onClick={bump} disabled={first.status === 'loading'}
              className="inline-flex items-center gap-1.5 rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs font-semibold text-slate-600 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-60">
              <RefreshCw size={13} className={first.status === 'loading' ? 'animate-spin' : ''} />
              Refresh
            </button>
          )}
        />
        {!walletAddress && <Notice tone="info">Connect a wallet to see its Borrow positions on Arc. Nothing is read until a wallet is connected.</Notice>}
        {walletAddress && first.status === 'loading' && <LoadingBars rows={4} />}
        {walletAddress && first.status === 'unavailable' && <ReadFailure error={first.error} onRetry={bump} />}
        {walletAddress && first.status === 'available' && items.length === 0 && (
          <Notice tone="info">The Borrow Service reports no loans for this wallet on Arc. Debt and collateral are not available because no loan exists.</Notice>
        )}
        {items.length > 0 && (
          <ul className="grid gap-3 lg:grid-cols-2">
            {items.map((position) => (
              <PositionCard key={position.loanId} position={position} known={marketById.get(position.marketId.toLowerCase()) ?? null} listLoaded={markets.length > 0} />
            ))}
          </ul>
        )}
        {moreError && <div className="mt-3"><ReadFailure error={moreError} /></div>}
        {next && (
          <button type="button" onClick={() => void loadMore()} disabled={busy}
            className="mt-3 rounded-xl border border-slate-200 bg-white px-4 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-60">
            {busy ? 'Loading…' : 'Load more loans'}
          </button>
        )}
      </div>
    </Panel>
  )
}

// ---------------------------------------------------------------------------------------------------------------------
// Page

export type BorrowWorkspaceProps = {
  walletAddress: string | null
  // Test seams. Production passes none: reads go through the guarded Borrow Kit boundary, the market proxy and the Arc RPC.
  client?: BorrowReadClient
  loadMarkets?: () => Promise<BorrowMarketState>
  verifyMarket?: (market: BorrowMarket) => Promise<MarketVerification>
}

export function BorrowWorkspace({ walletAddress, client, loadMarkets, verifyMarket }: BorrowWorkspaceProps) {
  const [refresh, setRefresh] = useState(0)
  const [marketsState, setMarketsState] = useState<BorrowMarketState>({ status: 'loading' })
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [verifications, setVerifications] = useState<Record<string, MarketVerification>>({})
  const [collateralText, setCollateralText] = useState('')
  const [borrowText, setBorrowText] = useState('')
  const [targetHealthFactor, setTargetHealthFactor] = useState<number>(1.5)
  const loadMarketsRef = useRef(loadMarkets)
  loadMarketsRef.current = loadMarkets
  const verifyMarketRef = useRef(verifyMarket)
  verifyMarketRef.current = verifyMarket

  useEffect(() => {
    let live = true
    setMarketsState({ status: 'loading' })
    void (loadMarketsRef.current ?? (() => loadArcBorrowMarkets()))().then((state) => {
      if (!live) return
      setMarketsState(state)
      if (state.status !== 'available') return
      // One market is the only choice; several need an explicit pick. A pick that disappeared is dropped.
      setSelectedId((current) => (state.markets.length === 1 ? state.markets[0].marketId
        : state.markets.some((market) => market.marketId === current) ? current : null))
    })
    return () => { live = false }
  }, [refresh])

  // Every listed market is checked against Morpho on-chain; the check never changes which markets are listed or their order.
  useEffect(() => {
    if (marketsState.status !== 'available') return undefined
    let live = true
    const verify = verifyMarketRef.current ?? defaultVerifyMarket
    setVerifications(Object.fromEntries(marketsState.markets.map((market) => [market.marketId.toLowerCase(), { status: 'checking' } as MarketVerification])))
    for (const market of marketsState.markets) {
      verify(market).then(
        (result) => { if (live) setVerifications((current) => ({ ...current, [market.marketId.toLowerCase()]: result })) },
        () => { if (live) setVerifications((current) => ({ ...current, [market.marketId.toLowerCase()]: { status: 'unavailable' } })) },
      )
    }
    return () => { live = false }
  }, [marketsState])

  const markets = marketsState.status === 'available' ? marketsState.markets : []
  const selected = markets.find((market) => market.marketId === selectedId) ?? null
  const bump = useCallback(() => setRefresh((value) => value + 1), [])
  const inputs: QuoteInputs = { collateralText, borrowText, targetHealthFactor, setCollateralText, setBorrowText, setTargetHealthFactor }

  return (
    <Container className="py-8">
      <div className="mb-6 flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <Banknote size={22} className="text-[#2F6E0C]" />
            <h1 className="text-2xl font-semibold tracking-tight text-slate-900">Borrow</h1>
            <span className="inline-flex items-center rounded-full border border-[#66D121]/30 bg-[#eef7e8] px-2.5 py-0.5 text-xs font-medium text-[#2F6E0C]">Read-only preview</span>
          </div>
          <p className="mt-1 max-w-2xl text-sm leading-6 text-slate-500">
            Borrow USDC against cirBTC on Arc through Morpho markets, powered by Circle Borrow Kit. See live terms, price a borrow and review your
            loans. Borrowing itself is not enabled yet.
          </p>
        </div>
        <button type="button" onClick={bump} disabled={marketsState.status === 'loading'}
          className="inline-flex items-center gap-1.5 rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs font-semibold text-slate-600 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-60">
          <RefreshCw size={13} className={marketsState.status === 'loading' ? 'animate-spin' : ''} />
          Refresh
        </button>
      </div>

      <div className="space-y-5">
        <RiskNotice />
        <MarketsSection state={marketsState} verifications={verifications} borrowAmount={parsePositiveAmount(borrowText)} selectedId={selectedId}
          onSelect={setSelectedId} onReload={bump} />
        <QuoteBuilder market={selected} verification={selected ? verifications[selected.marketId.toLowerCase()] : undefined}
          walletAddress={walletAddress} client={client} refresh={refresh} bump={bump} inputs={inputs} />
        <PositionsSection walletAddress={walletAddress} client={client} markets={markets} refresh={refresh} bump={bump} />
      </div>

      <p className="mt-6 text-[11px] leading-5 text-slate-500">
        Borrow markets are operated by third-party protocols (Morpho) and read through Circle Borrow Kit. Quotes are estimates and can change before
        any action. Machina does not take custody of your funds.
      </p>
    </Container>
  )
}

export default function MainnetBorrow() {
  const { address } = useAccount()
  return <BorrowWorkspace walletAddress={address ?? null} />
}
