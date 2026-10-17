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
  describeBorrowError,
  describeVerificationReason,
  displayDigits,
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
  thresholdStatus,
  totalGasWei,
  type HealthTone,
} from '../lib/borrowPreview'
import { createViemMarketReader, verifyBorrowMarket, type MarketChainReader, type MarketVerification } from '../lib/borrowMarketVerification'
import { createViemBalanceReader, type WalletBalanceReader, type WalletBalances } from '../lib/borrowWalletBalances'
import {
  borrowReadiness,
  borrowWalletSession,
  healthTargetMet,
  orderWriteChecks,
  unitsToDecimal,
  type BorrowWalletCapability,
  type BorrowWalletState,
  type BorrowWriteAction,
  type BorrowWriteEvidence,
  type PreparedBorrowQuote,
  type WriteCheck,
  type WriteCheckStatus,
} from '../lib/borrowWriteSafety'
import {
  detectAtomicBatchCapability,
  getBorrowLoans,
  getBorrowMarket,
  planBorrowWrite,
  prepareBorrowQuote,
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
  type Eip1193Request,
} from '../lib/mainnetBorrow'
import { MAINNET_BORROW_CHAIN_ID, MAINNET_BORROW_HIGH_UTILIZATION, MAINNET_BORROW_MAX_EVIDENCE_AGE_MS } from '../config/mainnetBorrow'
import { MAINNET_CONFIG } from '../config/mainnet'
import { MAINNET_ARC_NATIVE_CURRENCY } from '../config/mainnetNetworks'
import { Container } from './ui'

// Borrow tab (Mainnet), preview only. Every number comes from the guarded Borrow Kit reads in src/lib/mainnetBorrow.ts, the
// same-origin market proxy or Morpho Blue and the wallet's token balances on-chain (view calls); a missing value is shown as
// "Not reported" or "Unavailable", never estimated. The Transaction Readiness card runs the same shared safety checks the
// write boundary runs (planBorrowWrite), but nothing here can send anything: this module never imports executeBorrowWrite,
// verifyBorrowWriteBoundary or a wallet adapter, and its only action button is permanently disabled. The wallet is asked one
// read-only question (wallet_getCapabilities); it is never asked to sign, approve or send.

const TARGET_HEALTH_FACTORS = [1.25, 1.5, 2] as const
const POSITIONS_PAGE_SIZE = 20
const DEBOUNCE_MS = 450
const CLOCK_TICK_MS = 5_000

const UNEXPECTED: BorrowAvailability<never> = { status: 'unavailable', error: { code: 'unexpected_error', retryable: false } }

// `at` is when the read started, so a slow answer is never made to look younger than it is.
type Stamped = { at: number }
type Query<T> = { status: 'idle' } | { status: 'loading' } | (BorrowAvailability<T> & Stamped)
type IconType = typeof Clock

let chainReader: MarketChainReader | null = null
// Public Arc RPC view calls only; one reader (and its chain ID check) is shared by every market check.
const defaultVerifyMarket = (market: BorrowMarket) => verifyBorrowMarket(market, (chainReader ??= createViemMarketReader(MAINNET_CONFIG.arcRpcUrl)))

let balanceReader: WalletBalanceReader | null = null
const defaultReadBalances: WalletBalanceReader = (owner, loanToken, collateralToken) =>
  (balanceReader ??= createViemBalanceReader(MAINNET_CONFIG.arcRpcUrl))(owner, loanToken, collateralToken)

const shortAddress = (value: string) => (value.length > 12 ? `${value.slice(0, 6)}...${value.slice(-4)}` : value)

function useDebounced<T>(value: T, ms = DEBOUNCE_MS): T {
  const [debounced, setDebounced] = useState(value)
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), ms)
    return () => clearTimeout(timer)
  }, [value, ms])
  return debounced
}

// Ticks, so a read that has aged past its limit stops counting as ready without waiting for a click.
function useNow(ms = CLOCK_TICK_MS): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), ms)
    return () => clearInterval(timer)
  }, [ms])
  return now
}

// One read keyed by its inputs. A null key is idle; a result for an older key is never shown for the current one.
function useBorrowRead<T>(key: string | null, load: () => Promise<BorrowAvailability<T>>): Query<T> {
  const [settled, setSettled] = useState<{ key: string; result: BorrowAvailability<T> & Stamped } | null>(null)
  const loadRef = useRef(load)
  loadRef.current = load
  useEffect(() => {
    if (key === null) return undefined
    let live = true
    const at = Date.now()
    loadRef.current().then(
      (result) => { if (live) setSettled({ key, result: { ...result, at } }) },
      () => { if (live) setSettled({ key, result: { ...UNEXPECTED, at } }) },
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

type Positions = ReturnType<typeof usePositions>

// The wallet as the safety checks see it. The atomic batch answer is tied to the address and network it was read for: a
// different wallet or network is a different session, and the old answer (and every read made for it) no longer counts.
function useWalletState(address: string | null, chainId: number | null, requestWallet: Eip1193Request | undefined): { session: string | null; state: BorrowWalletState | null } {
  const session = borrowWalletSession(address, chainId)
  const [answer, setAnswer] = useState<{ session: string; value: BorrowWalletCapability } | null>(null)
  const requestRef = useRef(requestWallet)
  requestRef.current = requestWallet
  const hasRequest = requestWallet !== undefined
  useEffect(() => {
    const request = requestRef.current
    if (!address || !session || chainId !== MAINNET_BORROW_CHAIN_ID || !request) return undefined
    let live = true
    detectAtomicBatchCapability(request, address).then(
      (value) => { if (live) setAnswer({ session, value }) },
      () => { if (live) setAnswer({ session, value: 'unknown' }) },
    )
    return () => { live = false }
  }, [address, chainId, session, hasRequest])
  const current = answer && answer.session === session ? answer : null
  if (!address) return { session, state: null }
  return { session, state: { address, chainId, atomicBatch: current ? current.value : 'unknown', atomicBatchFor: current ? current.session : null } }
}

// The wallet's real token balances for the selected market, read on-chain. Separate from the collateral a user may type.
function useWalletBalances(owner: string | null, session: string | null, market: BorrowMarket | null, readBalances: WalletBalanceReader | undefined, refresh: number): Query<WalletBalances> {
  const key = owner && market ? `balances:${session ?? 'none'}:${owner.toLowerCase()}:${market.marketId}:${refresh}` : null
  const readRef = useRef(readBalances)
  readRef.current = readBalances
  return useBorrowRead<WalletBalances>(key, async () => {
    if (!owner || !market) return UNEXPECTED
    try {
      return { status: 'available', data: await (readRef.current ?? defaultReadBalances)(owner, market.loanAsset.address, market.collateralAsset.address) }
    } catch {
      return UNEXPECTED
    }
  })
}

type BorrowReads = {
  // null when no quote can be asked for (a new loan needs a wallet).
  quote: BorrowAvailability<PreparedBorrowQuote> | null
  market: BorrowAvailability<BorrowMarket> & Stamped
  verification: { result: MarketVerification; at: number } | null
}

// The reads a borrow transaction would depend on, taken fresh for this exact action: the wallet-bound quote, the market
// itself and its on-chain check. Nothing is reused from the market list.
function useBorrowReads(action: BorrowWriteAction | null, marketId: string | null, walletAddress: string | null, session: string | null, client: BorrowReadClient | undefined,
  verifyMarket: ((market: BorrowMarket) => Promise<MarketVerification>) | undefined, refresh: number): Query<BorrowReads> {
  const key = action && marketId ? `reads:${session ?? 'none'}:${JSON.stringify(action)}:${refresh}` : null
  const verifyRef = useRef(verifyMarket)
  verifyRef.current = verifyMarket
  return useBorrowRead<BorrowReads>(key, async () => {
    if (!action || !marketId) return UNEXPECTED
    const marketAt = Date.now()
    const [quote, market] = await Promise.all([
      walletAddress || action.kind !== 'borrow' ? prepareBorrowQuote(action, walletAddress, client) : Promise.resolve(null),
      getBorrowMarket(marketId, client),
    ])
    let verification: BorrowReads['verification'] = null
    if (market.status === 'available') {
      const at = Date.now()
      try {
        verification = { result: await (verifyRef.current ?? defaultVerifyMarket)(market.data), at }
      } catch {
        verification = { result: { status: 'unavailable' }, at }
      }
    }
    return { status: 'available', data: { quote, market: { ...market, at: marketAt }, verification } }
  })
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

function QueryState({ query, idle, onRetry }: { query: Query<BorrowQuote>; idle: string; onRetry?: () => void }) {
  if (query.status === 'idle') return <p className="text-xs leading-5 text-slate-400">{idle}</p>
  if (query.status === 'loading') return <LoadingBars rows={3} />
  if (query.status === 'unavailable') return <ReadFailure error={query.error} onRetry={onRetry} />
  return null
}

// Toggle text for a native <details>: "Show ..." while closed, "Hide ..." while open.
function ToggleSummary({ label }: { label: string }) {
  return (
    <summary className="cursor-pointer select-none text-xs font-semibold text-slate-600">
      <span className="group-open:hidden">Show {label}</span>
      <span className="hidden group-open:inline">Hide {label}</span>
    </summary>
  )
}

// ---------------------------------------------------------------------------------------------------------------------
// Transaction readiness

const CHECK_STYLE: Record<WriteCheckStatus, { icon: IconType; className: string; label: string }> = {
  'pass': { icon: CheckCircle2, className: 'text-emerald-600', label: 'Pass' },
  'warn': { icon: AlertTriangle, className: 'text-amber-600', label: 'Warning' },
  'fail': { icon: XCircle, className: 'text-red-600', label: 'Blocked' },
  'unknown': { icon: HelpCircle, className: 'text-amber-600', label: 'Unavailable' },
  'not-applicable': { icon: MinusCircle, className: 'text-slate-400', label: 'Not applicable' },
}

const READINESS_CHIP = {
  ready: { label: 'Ready for review', className: 'border-emerald-200 bg-emerald-50 text-emerald-800' },
  blocked: { label: 'Blocked', className: 'border-red-200 bg-red-50 text-red-700' },
  unavailable: { label: 'Unavailable', className: 'border-amber-200 bg-amber-50 text-amber-800' },
  checking: { label: 'Checking', className: 'border-slate-200 bg-slate-50 text-slate-600' },
} as const

type ReadinessView =
  | { kind: 'idle'; text: string }
  | { kind: 'checking' }
  | { kind: 'result'; title: string; checks: WriteCheck[]; requests: string[]; quoteAgeSeconds: number | null }

// What the wallet would be asked for if transactions were enabled. Only the kinds of request, never an amount or a prompt.
function requestsSentence(requests: readonly string[]): string {
  const parts = [
    requests.some((request) => request.endsWith('approval-if-short') || request === 'allowance-reset-if-partial')
      ? 'an exact token approval to the Circle Borrow Adapter only, when your allowance is short' : null,
    requests.includes('morpho-authorization-grant') ? 'a temporary Morpho authorization, revoked in the same batch' : null,
    'one atomic batch',
  ].filter(Boolean)
  return `If transactions were enabled, your wallet would be asked for ${parts.join(', ')}. Machina never falls back to separate transactions.`
}

function ReadinessCard({ view, bump }: { view: ReadinessView; bump: () => void }) {
  const readiness = view.kind === 'result' ? borrowReadiness(view.checks) : null
  const chip = view.kind === 'checking' ? READINESS_CHIP.checking : readiness ? READINESS_CHIP[readiness.status] : null
  // Without a wallet every wallet-bound check is waiting too; "+N more" would only repeat "Connect a wallet".
  const extra = readiness && readiness.reasonId !== 'wallet' ? Math.max(0, (readiness.status === 'blocked' ? readiness.failed : readiness.unavailable) - 1) : 0
  const reason = view.kind === 'idle' ? view.text
    : view.kind === 'checking' ? 'Reading the quote, the market, your wallet and your loans.'
      : readiness?.status === 'ready' ? `All checks pass for this ${view.title.toLowerCase()}.${readiness.warnings > 0 ? ` ${readiness.warnings} warning${readiness.warnings === 1 ? '' : 's'}.` : ''}`
        : `${readiness?.reason ?? ''}${extra > 0 ? ` (+${extra} more)` : ''}`
  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-4" data-borrow-readiness={view.kind === 'result' ? readiness?.status : view.kind}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-semibold text-slate-900">Transaction readiness</h3>
        {chip && <span className={`rounded-lg border px-2 py-0.5 text-[11px] font-semibold leading-4 ${chip.className}`} data-readiness-status>{chip.label}</span>}
      </div>
      <p className="mt-1 text-xs leading-5 text-slate-700" data-readiness-reason>{reason}</p>
      <p className="mt-1 text-[11px] leading-4 text-slate-500">Preview only: real transactions are switched off in this release, whatever the status.</p>
      {view.kind === 'result' && (
        <details className="group mt-2" data-borrow-readiness-details>
          <ToggleSummary label="technical checks" />
          <ul className="mt-2 space-y-2">
            {orderWriteChecks(view.checks).map((check) => {
              const style = CHECK_STYLE[check.status]
              return (
                <li key={check.id} data-readiness-check={check.id} data-readiness-check-status={check.status} className="flex items-start gap-2 text-xs leading-5 text-slate-700">
                  <style.icon size={14} className={`mt-0.5 shrink-0 ${style.className}`} />
                  <span className="min-w-0 [overflow-wrap:anywhere]"><span className={`font-semibold ${style.className}`}>{style.label}.</span> {check.text}</span>
                </li>
              )
            })}
          </ul>
          <p className="mt-2 text-[11px] leading-4 text-slate-500">
            {view.quoteAgeSeconds === null ? 'No quote has been read.' : `Quote read ${view.quoteAgeSeconds} s ago; a quote is only used for ${MAINNET_BORROW_MAX_EVIDENCE_AGE_MS / 1000} s.`}{' '}
            {requestsSentence(view.requests)}
          </p>
          <button type="button" onClick={bump} className="mt-2 inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-2.5 py-1 text-[11px] font-semibold text-slate-600 hover:bg-slate-50">
            <RefreshCw size={11} />
            Read again
          </button>
        </details>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------------------------------------------------
// New borrow estimate

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

// Two decimals, unless the two figures would look the same at two decimals: then enough digits to tell them apart.
function healthPair(value: number, other: number): string {
  const short = formatHealthFactor(value)
  if (short !== formatHealthFactor(other)) return short
  return String(Number(value.toFixed(6)))
}

function balanceLine(walletAddress: string | null, balances: Query<WalletBalances>, market: BorrowMarket | null): string {
  if (!walletAddress) return 'Connect a wallet'
  if (balances.status === 'idle' || balances.status === 'loading') return 'Reading…'
  if (balances.status === 'unavailable' || !market || balances.data.collateralToken.raw === null) return 'Unavailable'
  const decimals = market.collateralAsset.decimals
  const shown = formatDecimalString(unitsToDecimal(balances.data.collateralToken.raw, decimals), displayDigits(decimals))
  return shown === null ? 'Unavailable' : `${shown} ${market.collateralAsset.symbol}`
}

function QuoteBuilder({ market, verification, walletAddress, walletState, session, positions, client, verifyMarket, readBalances, refresh, bump, inputs }: {
  market: BorrowMarket | null
  verification: MarketVerification | undefined
  walletAddress: string | null
  walletState: BorrowWalletState | null
  session: string | null
  positions: Positions
  client: BorrowReadClient | undefined
  verifyMarket: ((market: BorrowMarket) => Promise<MarketVerification>) | undefined
  readBalances: WalletBalanceReader | undefined
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

  // Optional comparison, outside the main flow: the service maximum for a collateral amount the user types.
  const maxBorrow = useBorrowRead(
    marketId && collateralInput ? `max:${marketId}:${collateralInput}:${refresh}` : null,
    () => quoteMaxBorrow({ marketId: marketId ?? '', collateralAmount: collateralInput ?? '' }, client),
  )
  // What the Borrow Service would size for the selected target. Information only: there is no write path that takes it.
  const sizing = useBorrowRead(
    marketId && borrowInput ? `size:${marketId}:${borrowInput}:${targetHealthFactor}:${refresh}` : null,
    () => quoteRequiredCollateral({ marketId: marketId ?? '', borrowAmount: borrowInput ?? '', targetHealthFactor }, client),
  )

  // One loan per market and wallet: with an existing loan in the selected market the borrow is "Borrow more" on that loan.
  const loansRead = positions.first
  const allLoans = loansRead.status === 'available' ? [...loansRead.data.items, ...positions.extra] : []
  const activeLoan = market ? allLoans.find((loan) => loan.marketId.toLowerCase() === market.marketId.toLowerCase() && loan.lifecycle !== 'closed') ?? null : null
  const action: BorrowWriteAction | null = market && borrowInput
    ? activeLoan ? { kind: 'borrow-more', loanId: activeLoan.loanId, borrowAmount: borrowInput } : { kind: 'borrow', marketId: market.marketId, borrowAmount: borrowInput }
    : null

  const reads = useBorrowReads(action, marketId, walletAddress, session, client, verifyMarket, refresh)
  const balances = useWalletBalances(walletAddress, session, market, readBalances, refresh)
  const now = useNow()

  const readsData = reads.status === 'available' ? reads.data : null
  const prepared = readsData?.quote?.status === 'available' ? readsData.quote.data : null
  const walletQuoteError = readsData?.quote?.status === 'unavailable' ? readsData.quote.error : null
  const full = prepared && prepared.quote.kind === 'borrow' ? prepared.quote : null
  const max = maxBorrow.status === 'available' && maxBorrow.data.kind === 'max-borrow' ? maxBorrow.data : null
  const required = sizing.status === 'available' && sizing.data.kind === 'required-collateral' ? sizing.data : null

  // The main estimate is the wallet's Borrow Kit quote. Without a wallet (or when that quote fails) it falls back to the
  // collateral the Borrow Service sizes for the selected target, which needs no wallet and cannot be sent.
  const sizedOnly = full === null && required !== null && (!walletAddress || walletQuoteError !== null)
  const shown = full
    ? { collateral: full.collateral, healthFactor: full.resultingHealthFactor, band: full.resultingBand as BorrowHealthBand | null, liquidationPrice: full.liquidationPrice, apy: full.borrowApy }
    : sizedOnly && required
      ? { collateral: required.requiredCollateral, healthFactor: required.resultingHealthFactor, band: null, liquidationPrice: required.liquidationPrice, apy: market?.borrowApy ?? null }
      : null
  const estimateLoading = walletAddress ? reads.status === 'loading' || (reads.status === 'idle' && borrowInput !== null) : sizing.status === 'loading'

  const gasWei = full ? totalGasWei(full.gasFees) : null
  const feeParts = full ? [
    gasWei === null ? null : `${formatUnitsText(gasWei, MAINNET_ARC_NATIVE_CURRENCY.decimals, 6)} ${MAINNET_ARC_NATIVE_CURRENCY.symbol} gas`,
    ...full.fees.map((fee) => { const text = amountText(fee.amount); return text === null ? null : `${text} ${fee.type} fee` }),
  ].filter((part): part is string => part !== null) : []
  const gasFeesText = full ? (feeParts.length === 0 ? null : full.fees.length === 0 ? `${feeParts.join(' + ')}, no service fee` : feeParts.join(' + ')) : null
  // Raw comparison with the selected target; the two-decimal display never decides it.
  const met = shown ? healthTargetMet(shown.healthFactor, targetHealthFactor) : null
  const interest = full ? illustrativeYearlyInterest(full.loanAsset.amount, full.borrowApy) : null
  const loanDigits = displayDigits(market?.loanAsset.decimals ?? 6)
  const borrowShown = borrowInput ? `${formatDecimalString(borrowInput, loanDigits) ?? borrowInput} ${loanSymbol}` : null
  const collateralNotice = collateralInput && required
    ? compareDecimals(collateralInput, required.requiredCollateral.amount) < 0
      ? { tone: 'note' as const, text: `The collateral you typed is below the ${amountText(required.requiredCollateral)} sized for a ${target} health factor.` }
      : { tone: 'info' as const, text: `The collateral you typed covers the ${amountText(required.requiredCollateral)} sized for a ${target} health factor.` }
    : null
  const noMarket = market === null
  const unverified = market && verification && verification.status !== 'verified' && verification.status !== 'checking'

  // Transaction readiness: the shared safety checks, run on reads taken for this exact action.
  const evidence: BorrowWriteEvidence | null = session && readsData && market ? {
    session,
    market: readsData.market.status === 'available' ? { data: readsData.market.data, fetchedAt: readsData.market.at } : null,
    verification: readsData.verification ? { marketId: market.marketId, result: readsData.verification.result, checkedAt: readsData.verification.at } : null,
    position: activeLoan && loansRead.status === 'available' ? { data: activeLoan, fetchedAt: loansRead.at } : null,
    loans: loansRead.status === 'available' ? { data: { items: allLoans, complete: positions.next === null && positions.moreError === null }, fetchedAt: loansRead.at } : null,
    balances: balances.status === 'available' ? { data: balances.data, fetchedAt: balances.at } : null,
    targetHealthFactor,
  } : null
  const plan = action ? planBorrowWrite(action, { wallet: walletAddress ? walletState : null, quote: prepared, evidence, now }) : null
  const checking = action !== null && (reads.status === 'loading' || (walletAddress !== null && (loansRead.status === 'loading' || balances.status === 'loading')))
  const readinessView: ReadinessView = !action ? { kind: 'idle', text: noMarket ? 'Choose a market to check readiness.' : 'Enter a borrow amount to check readiness.' }
    : checking || !plan ? { kind: 'checking' }
      : { kind: 'result', title: action.kind === 'borrow-more' ? 'Borrow more' : 'Borrow', checks: plan.checks, requests: plan.walletRequests, quoteAgeSeconds: prepared ? Math.max(0, Math.round((now - prepared.fetchedAt) / 1000)) : null }

  return (
    <Panel>
      <div data-borrow-section="quote">
        <SectionTitle
          title="New borrow estimate"
          hint="Enter what you want to borrow. This is an estimate for a new borrow, not your current loan."
          right={<span className="inline-flex items-center gap-1 rounded-full border border-slate-200 bg-slate-50 px-2.5 py-0.5 text-[11px] font-semibold text-slate-600"><Lock size={11} />Preview only</span>}
        />
        {noMarket && <div className="mb-4"><Notice tone="info">Choose a market above to start an estimate.</Notice></div>}
        {market && (
          <p className="mb-3 text-xs text-slate-500" data-borrow-selected>
            Estimating <span className="font-semibold text-slate-800">{market.collateralAsset.symbol} / {market.loanAsset.symbol}</span>{' '}
            <span className="font-mono" title={market.marketId}>{shortenMarketId(market.marketId)}</span>
            {action?.kind === 'borrow-more' && <span className="ml-2 font-semibold text-slate-700" data-borrow-kind="borrow-more">Borrow more on your existing loan</span>}
          </p>
        )}
        {unverified && (
          <div className="mb-4" data-borrow-unverified>
            <Notice tone="warn">This market is not verified on-chain. Treat these numbers as unconfirmed.</Notice>
          </div>
        )}
        <div className="grid gap-6 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]">
          <div className="min-w-0 space-y-4">
            <div>
              <AmountField id="borrow-amount" label={`Borrow amount (${loanSymbol})`} symbol={loanSymbol} value={borrowText}
                disabled={noMarket} hint={`Up to ${market?.loanAsset.decimals ?? 6} decimals.`}
                onChange={(value) => inputs.setBorrowText(sanitizeDecimalInput(value, market?.loanAsset.decimals ?? 6))} />
              <p className="mt-2 text-xs text-slate-500" data-borrow-wallet-balance>
                Your wallet {collateralSymbol} balance: <span className="font-semibold text-slate-800">{balanceLine(walletAddress, balances, market)}</span>
              </p>
            </div>
            <div>
              <p className="text-sm font-medium text-slate-700">Your target health factor</p>
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
              <p className="mt-1 text-[11px] leading-4 text-slate-400">The estimate must reach this. Higher keeps more distance from the liquidation threshold (1.0).</p>
            </div>
            {!walletAddress && (
              <Notice tone="info">
                <span className="inline-flex items-center gap-1.5 font-semibold"><Wallet size={12} />No wallet connected</span>
                <p className="mt-1">Connect a wallet for the full estimate with gas and fees, and for transaction readiness.</p>
              </Notice>
            )}
            <details className="group rounded-xl border border-slate-200 bg-white p-3" data-borrow-optional>
              <ToggleSummary label="optional collateral comparison" />
              <div className="mt-3 space-y-3">
                <AmountField id="borrow-collateral" label={`Collateral to compare (${collateralSymbol}, optional)`} symbol={collateralSymbol} value={collateralText}
                  disabled={noMarket} hint={`Typed by you. It is not your wallet balance and it is not used for the estimate or the readiness checks. Up to ${market?.collateralAsset.decimals ?? 8} decimals.`}
                  onChange={(value) => inputs.setCollateralText(sanitizeDecimalInput(value, market?.collateralAsset.decimals ?? 8))} />
                <QueryState query={maxBorrow} idle="Type a collateral amount to see the service maximum for it." onRetry={bump} />
                {max && (
                  <>
                    <dl className="divide-y divide-slate-100">
                      <Metric label="Maximum borrow" value={amountText(max.maxBorrow)} strong />
                      <Metric label="Health factor at that borrow" value={healthValue(max.resultingHealthFactor, null)} />
                      <Metric label="Liquidation price" note={`${collateralSymbol} price in ${loanSymbol} at which the loan can be liquidated`} value={amountText(max.liquidationPrice)} />
                    </dl>
                    <p className="text-[11px] leading-4 text-slate-500" data-borrow-max-note>
                      The maximum sits at the liquidation threshold (health factor {max.resultingHealthFactor === null ? 'not reported' : formatHealthFactor(max.resultingHealthFactor)}).
                      A price move or accrued interest can take the loan below it.
                    </p>
                  </>
                )}
                {collateralNotice && <Notice tone={collateralNotice.tone}>{collateralNotice.text}</Notice>}
              </div>
            </details>
          </div>

          <div className="min-w-0 space-y-4">
            <div className="rounded-2xl border border-slate-200 bg-slate-50/60 p-4" data-borrow-summary>
              <h3 className="text-sm font-semibold text-slate-900">Estimate</h3>
              <p className="mb-2 mt-0.5 text-[11px] leading-4 text-slate-500">
                {full ? 'Borrow Kit quote for your wallet. Preview only.'
                  : shown ? `Sized for your selected target of ${target}; connect a wallet for the exact quote. Preview only.` : 'Preview only.'}
              </p>
              {borrowInput === null && <p className="text-xs leading-5 text-slate-400">Enter a borrow amount to see the estimate.</p>}
              {borrowInput !== null && estimateLoading && !shown && <LoadingBars rows={5} />}
              {borrowInput !== null && walletQuoteError && <ReadFailure error={walletQuoteError} onRetry={bump} />}
              {borrowInput !== null && !walletAddress && sizing.status === 'unavailable' && <ReadFailure error={sizing.error} onRetry={bump} />}
              {borrowInput !== null && shown && (
                <>
                  <dl className="divide-y divide-slate-100">
                    <Metric label="Borrow Amount" value={borrowShown} strong />
                    <Metric label="Collateral Required" note="Sized by the Borrow Service" value={amountText(shown.collateral)} strong />
                    <Metric label="Borrow APY" note="Variable" value={percentText(shown.apy)} />
                    <Metric label="Estimated Gas / Fees" value={full ? gasFeesText
                      : <span className="font-normal text-slate-400">{walletAddress ? 'Not available' : 'Needs a wallet'}</span>} />
                    <Metric label="Estimated Health Factor" note={activeLoan ? 'After borrowing more; not your current Health Factor' : 'For this new borrow; not a current loan'}
                      value={healthValue(shown.healthFactor, shown.band)} />
                    <Metric label="Target Health Factor" note="Your selection" value={(
                      <span className="inline-flex flex-wrap items-center justify-end gap-2">
                        <span>{target}</span>
                        {met !== null && (
                          <span className={`rounded-lg border px-2 py-0.5 text-[11px] font-semibold leading-4 ${met ? TONE_CLASS.safe : TONE_CLASS.danger}`} data-borrow-target-status={met ? 'met' : 'not-met'}>
                            {met ? 'Met' : 'Not met'}
                          </span>
                        )}
                      </span>
                    )} />
                    <Metric label="Liquidation Price" value={amountText(shown.liquidationPrice)} />
                  </dl>
                  {full && met !== null && (
                    <div className="mt-3" data-borrow-target-note={met ? 'met' : 'below'}>
                      {!met && shown.healthFactor !== null ? (
                        <Notice tone="error">
                          <p><span className="font-semibold" data-borrow-hf-gap="below">Selected safety target not met.</span> The estimate is {healthPair(shown.healthFactor, targetHealthFactor)} against
                            your {target} target. The Borrow Service sizes the collateral itself and Machina does not prepare a transaction with different collateral, so this
                            borrow is blocked.{required ? ` Collateral for ${target} would be ${amountText(required.requiredCollateral)}.` : ''}</p>
                        </Notice>
                      ) : (
                        <p className="text-[11px] font-semibold text-emerald-700" data-borrow-hf-gap="met">Meets your selected target of {target}.</p>
                      )}
                    </div>
                  )}
                </>
              )}
            </div>

            <ReadinessCard view={readinessView} bump={bump} />

            <details className="group rounded-2xl border border-slate-200 bg-white p-4" data-borrow-more>
              <ToggleSummary label="estimate details" />
              <div className="mt-3 space-y-4">
                <section>
                  <SubHeading>Collateral sized for your selected target ({target})</SubHeading>
                  <QueryState query={sizing} idle="Enter a borrow amount to size the collateral." onRetry={bump} />
                  {required && (
                    <dl className="divide-y divide-slate-100">
                      <Metric label="Collateral Required" value={amountText(required.requiredCollateral)} strong />
                      <Metric label="Estimated Health Factor" value={healthValue(required.resultingHealthFactor, null)} />
                      <Metric label="Liquidation Price" value={amountText(required.liquidationPrice)} />
                    </dl>
                  )}
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
                        value={interest === null ? null : `≈ ${interest} ${full.loanAsset.token}`} />
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
// Current loans

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
        <Metric label="Current Health Factor" value={noDebt && position.healthFactor === null ? 'No outstanding debt' : healthValue(position.healthFactor, position.healthBand)} />
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

// Each loan keeps its own Health Factor. No wallet-wide Health Factor is ever computed: with several loans there is none, and
// with no active loan it does not apply.
function PositionsSection({ walletAddress, positions, markets, bump }: {
  walletAddress: string | null
  positions: Positions
  markets: BorrowMarket[]
  bump: () => void
}) {
  const { first, extra, next, busy, moreError, loadMore } = positions
  const loaded = first.status === 'available' ? [...first.data.items, ...extra] : []
  const active = loaded.filter((position) => position.lifecycle === 'active')
  const unreported = loaded.filter((position) => position.lifecycle === 'unreported')
  const items = [...active, ...unreported, ...loaded.filter((position) => position.lifecycle === 'closed')]
  const marketById = useMemo(() => new Map(markets.map((market) => [market.marketId.toLowerCase(), market])), [markets])
  // "No active loan" is only said when every loan was read and none is active or of unreported status.
  const noActive = first.status === 'available' && active.length === 0 && unreported.length === 0 && next === null && moreError === null
  const summary: { loan: string; health: string } | null = !walletAddress ? { loan: 'Connect a wallet to see it', health: 'Not applicable' }
    : first.status === 'unavailable' ? { loan: 'Unavailable', health: 'Unavailable' }
      : noActive ? { loan: 'No active loan', health: 'Not applicable' }
        : first.status === 'available' && active.length === 0 ? { loan: unreported.length > 0 ? 'Status not reported' : 'Not all loans are loaded yet', health: 'Not reported' }
          : null
  return (
    <Panel>
      <div data-borrow-section="positions">
        <SectionTitle
          title="Your loans"
          hint="Your current position, read from the Borrow Service for the connected wallet. Separate from any new borrow estimate."
          right={walletAddress && (
            <button type="button" onClick={bump} disabled={first.status === 'loading'}
              className="inline-flex items-center gap-1.5 rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs font-semibold text-slate-600 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-60">
              <RefreshCw size={13} className={first.status === 'loading' ? 'animate-spin' : ''} />
              Refresh
            </button>
          )}
        />
        {walletAddress && first.status === 'loading' && <LoadingBars rows={2} />}
        {summary && (
          <dl className="divide-y divide-slate-100" data-borrow-current-loan={summary.loan}>
            <Metric label="Current loan" value={<span data-current-loan>{summary.loan}</span>} strong />
            <Metric label="Current Health Factor" value={<span data-current-health-factor>{summary.health}</span>} />
          </dl>
        )}
        {walletAddress && first.status === 'unavailable' && <div className="mt-2"><ReadFailure error={first.error} onRetry={bump} /></div>}
        {items.length > 0 && (
          <ul className="mt-3 grid gap-3 lg:grid-cols-2">
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
  walletChainId?: number | null
  // Read-only wallet requests (wallet_getCapabilities). Production passes the connected wallet's EIP-1193 request.
  requestWallet?: Eip1193Request
  // Test seams. Production passes none: reads go through the guarded Borrow Kit boundary, the market proxy and the Arc RPC.
  client?: BorrowReadClient
  loadMarkets?: () => Promise<BorrowMarketState>
  verifyMarket?: (market: BorrowMarket) => Promise<MarketVerification>
  readBalances?: WalletBalanceReader
}

export function BorrowWorkspace({ walletAddress, walletChainId = null, requestWallet, client, loadMarkets, verifyMarket, readBalances }: BorrowWorkspaceProps) {
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

  const wallet = useWalletState(walletAddress, walletChainId, requestWallet)
  const positions = usePositions(walletAddress, client, refresh)

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
        <PositionsSection walletAddress={walletAddress} positions={positions} markets={markets} bump={bump} />
        <QuoteBuilder market={selected} verification={selected ? verifications[selected.marketId.toLowerCase()] : undefined}
          walletAddress={walletAddress} walletState={wallet.state} session={wallet.session} positions={positions} client={client}
          verifyMarket={verifyMarket} readBalances={readBalances} refresh={refresh} bump={bump} inputs={inputs} />
      </div>

      <p className="mt-6 text-[11px] leading-5 text-slate-500">
        Borrow markets are operated by third-party protocols (Morpho) and read through Circle Borrow Kit. Quotes are estimates and can change before
        any action. Machina does not take custody of your funds.
      </p>
    </Container>
  )
}

export default function MainnetBorrow() {
  const { address, chainId, connector } = useAccount()
  // One read-only question to the wallet (wallet_getCapabilities). Never a signature, approval or transaction request.
  const requestWallet = useMemo<Eip1193Request | undefined>(() => (connector ? async (args) => {
    const provider = await connector.getProvider() as { request?: Eip1193Request } | undefined
    if (!provider?.request) throw new Error('wallet provider unavailable')
    return provider.request(args)
  } : undefined), [connector])
  return <BorrowWorkspace walletAddress={address ?? null} walletChainId={chainId ?? null} requestWallet={requestWallet} />
}
