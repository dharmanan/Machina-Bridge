import { BorrowOperations } from './BorrowOperations'
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useAccount } from 'wagmi'
import {
  AlertTriangle,
  Banknote,
  CheckCircle2,
  ChevronDown,
  Clock,
  HelpCircle,
  Info,
  Lock,
  MinusCircle,
  RefreshCw,
  ShieldAlert,
  ShieldCheck,
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
import { browserAttemptStorage, createPersistentAttemptLedger, type BorrowAttemptLedger, type StorageLike } from '../lib/borrowAttemptLedger'
import {
  borrowAttemptScope,
  borrowReadiness,
  borrowWalletSession,
  explainAttempt,
  explainAttemptLog,
  healthTargetMet,
  unitsToDecimal,
  type AttemptLogHealth,
  type BorrowAttemptRecord,
  type BorrowWalletCapability,
  type BorrowWalletState,
  type BorrowWriteAction,
  type BorrowWriteEvidence,
  type WriteCheck,
  type WriteCheckStatus,
} from '../lib/borrowWriteSafety'
import {
  detectAtomicBatchCapability,
  getBorrowLoans,
  getBorrowMarket,
  planBorrowWrite,
  prepareBorrowQuoteForTarget,
  quoteMaxBorrow,
  quoteRequiredCollateral,
  summarizeCapabilityAnswer,
  type BorrowAmount,
  type BorrowAvailability,
  type BorrowError,
  type BorrowHealthBand,
  type BorrowMarket,
  type BorrowPage,
  type BorrowPosition,
  type BorrowQuote,
  type BorrowReadClient,
  type Eip1193Request,
  type TargetQuoteSearch,
} from '../lib/mainnetBorrow'
import {
  MAINNET_BORROW_ADAPTER_CONTRACT,
  MAINNET_BORROW_CHAIN_ID,
  MAINNET_BORROW_HIGH_UTILIZATION,
  MAINNET_BORROW_MAX_EVIDENCE_AGE_MS,
  MAINNET_BORROW_MAX_LTV,
} from '../config/mainnetBorrow'
import { MAINNET_CONFIG } from '../config/mainnet'
import { MAINNET_ARC_NATIVE_CURRENCY } from '../config/mainnetNetworks'
import { chooseBorrowStatus, groupWriteChecks, type BorrowStatus } from '../lib/borrowStatus'
import { Container } from './ui'

// Borrow tab (Mainnet), preview only. Every number comes from the guarded Borrow Kit reads in src/lib/mainnetBorrow.ts, the
// same-origin market proxy or Morpho Blue and the wallet's token balances on-chain (view calls); a missing value is shown as
// "Not reported" or "Unavailable", never estimated. One screen, two depths: the standard view answers what a person needs (the
// market, the loan, the estimate and one status), and Advanced details holds every technical check and piece of evidence in
// sections that are closed until opened. The status is chosen from the shared safety checks (planBorrowWrite, via
// src/lib/borrowStatus.ts); it never replaces, hides or overrides one. Nothing here can send anything: this module never
// imports executeBorrowWrite, verifyBorrowWriteBoundary or a wallet adapter, and its only action button is permanently disabled.
// The wallet is asked one read-only question (wallet_getCapabilities); it is never asked to sign, approve or send.

const TARGET_HEALTH_FACTORS = [1.25, 1.5, 2] as const
const POSITIONS_PAGE_SIZE = 20
const DEBOUNCE_MS = 450
const CLOCK_TICK_MS = 1_000
// The most loan pages read for the checks of one borrow (20 loans each). More than that is reported as not fully read.
const MAX_LOAN_PAGES = 5

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

function usePositions(walletAddress: string | null, client: BorrowReadClient | undefined, epoch: string) {
  const key = walletAddress ? `loans:${walletAddress.toLowerCase()}:${epoch}` : null
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
// "compat" is the plain state shown to the person; "summary" is what the wallet actually answered, for the technical details.
type WalletCompat = 'no-wallet' | 'wrong-network' | 'checking' | BorrowWalletCapability
type WalletProbe = { session: string; capability: BorrowWalletCapability; summary: string }
type WalletView = { session: string | null; state: BorrowWalletState | null; compat: WalletCompat; summary: string | null }

function useWalletState(address: string | null, chainId: number | null, requestWallet: Eip1193Request | undefined): WalletView {
  const session = borrowWalletSession(address, chainId)
  const [probe, setProbe] = useState<WalletProbe | null>(null)
  const requestRef = useRef(requestWallet)
  requestRef.current = requestWallet
  const hasRequest = requestWallet !== undefined
  useEffect(() => {
    if (!address || !session || chainId !== MAINNET_BORROW_CHAIN_ID) return undefined
    const request = requestRef.current
    if (!request) {
      setProbe({ session, capability: 'unknown', summary: 'No wallet provider is available to ask.' })
      return undefined
    }
    let live = true
    // What the wallet said, kept as it comes back so the technical details can show it. Nothing else is ever asked of the wallet.
    const seen: { outcome: 'none' | 'response' | 'error'; value?: unknown } = { outcome: 'none' }
    const recording: Eip1193Request = async (args) => {
      try {
        const response = await request(args)
        seen.outcome = 'response'
        seen.value = response
        return response
      } catch (error) {
        seen.outcome = 'error'
        seen.value = error
        throw error
      }
    }
    detectAtomicBatchCapability(recording, address).then(
      (capability) => {
        if (!live) return
        const answer = seen.outcome === 'response' ? { response: seen.value } : seen.outcome === 'error' ? { error: seen.value } : { timedOut: true }
        setProbe({ session, capability, summary: summarizeCapabilityAnswer(answer) })
      },
      () => { if (live) setProbe({ session, capability: 'unknown', summary: 'The question to the wallet failed.' }) },
    )
    return () => { live = false }
  }, [address, chainId, session, hasRequest])
  // An answer read for another address or network is never used for this one.
  const current = probe && probe.session === session ? probe : null
  const compat: WalletCompat = !address ? 'no-wallet' : chainId !== MAINNET_BORROW_CHAIN_ID ? 'wrong-network' : current ? current.capability : 'checking'
  if (!address) return { session, state: null, compat, summary: null }
  return { session, state: { address, chainId, atomicBatch: current ? current.capability : 'unknown', atomicBatchFor: current ? current.session : null }, compat, summary: current ? current.summary : null }
}

async function readBalancesOf(owner: string, market: BorrowMarket, reader: WalletBalanceReader | undefined): Promise<BorrowAvailability<WalletBalances>> {
  try {
    return { status: 'available', data: await (reader ?? defaultReadBalances)(owner, market.loanAsset.address, market.collateralAsset.address) }
  } catch {
    return UNEXPECTED
  }
}

// The wallet's real token balances for the selected market, read on-chain. Separate from the collateral a user may type.
function useWalletBalances(owner: string | null, session: string | null, market: BorrowMarket | null, readBalances: WalletBalanceReader | undefined, epoch: string): Query<WalletBalances> {
  const key = owner && market ? `balances:${session ?? 'none'}:${owner.toLowerCase()}:${market.marketId}:${epoch}` : null
  const readRef = useRef(readBalances)
  readRef.current = readBalances
  return useBorrowRead<WalletBalances>(key, async () => (owner && market ? readBalancesOf(owner, market, readRef.current) : UNEXPECTED))
}

type LoanSnapshot = { items: BorrowPosition[]; complete: boolean }

// Every loan of the wallet, page after page (bounded). `complete` is true only when the last page was reached.
async function readAllLoans(walletAddress: string, client: BorrowReadClient | undefined): Promise<BorrowAvailability<LoanSnapshot>> {
  const items: BorrowPosition[] = []
  let after: string | null = null
  for (let page = 0; page < MAX_LOAN_PAGES; page += 1) {
    const result: BorrowAvailability<BorrowPage<BorrowPosition>> = await getBorrowLoans({ walletAddress, pageSize: POSITIONS_PAGE_SIZE, ...(after ? { pageAfter: after } : {}) }, client)
    if (result.status === 'unavailable') return result
    items.push(...result.data.items)
    if (result.data.nextPageAfter === null) return { status: 'available', data: { items, complete: true } }
    after = result.data.nextPageAfter
  }
  return { status: 'available', data: { items, complete: false } }
}

type Snapshot<T> = BorrowAvailability<T> & Stamped

type BorrowReads = {
  // The real quote for this borrow and how it was found, or null when no quote can be asked for yet (a new loan needs a wallet).
  search: BorrowAvailability<TargetQuoteSearch> | null
  market: Snapshot<BorrowMarket>
  verification: { result: MarketVerification; at: number } | null
  // The wallet's loans and token balances, read at the same moment as the quote, so everything a borrow depends on ages together
  // and is read again together. Null without a wallet.
  loans: Snapshot<LoanSnapshot> | null
  balances: Snapshot<WalletBalances> | null
}

type BaseBorrowAction = Extract<BorrowWriteAction, { kind: 'borrow' | 'borrow-more' }>

// The reads a borrow transaction would depend on, taken fresh for this exact action: the wallet-bound quote that reaches the
// selected Health Factor target (or the best Circle gives), the market itself and its on-chain check, and the wallet's loans and
// balances. Nothing is reused from the market list. The quote is found with prepareBorrowQuoteForTarget: Circle's quote has no
// target or collateral parameter, so the collateral buffer (its slippage setting) is the one supported lever, and the target is
// never lowered. Every read is stamped with the moment it started.
function useBorrowReads(base: BaseBorrowAction | null, market: BorrowMarket | null, walletAddress: string | null, session: string | null, targetHealthFactor: number,
  client: BorrowReadClient | undefined, verifyMarket: ((market: BorrowMarket) => Promise<MarketVerification>) | undefined, readBalances: WalletBalanceReader | undefined, epoch: string): Query<BorrowReads> {
  const marketId = market?.marketId ?? null
  const key = base && marketId ? `reads:${session ?? 'none'}:${JSON.stringify(base)}:${targetHealthFactor}:${epoch}` : null
  const verifyRef = useRef(verifyMarket)
  verifyRef.current = verifyMarket
  const balancesRef = useRef(readBalances)
  balancesRef.current = readBalances
  return useBorrowRead<BorrowReads>(key, async () => {
    if (!base || !marketId || !market) return UNEXPECTED
    const startedAt = Date.now()
    const [search, marketRead, loans, balances] = await Promise.all([
      walletAddress || base.kind !== 'borrow' ? prepareBorrowQuoteForTarget(base, walletAddress, targetHealthFactor, client) : Promise.resolve(null),
      getBorrowMarket(marketId, client),
      walletAddress ? readAllLoans(walletAddress, client) : Promise.resolve(null),
      walletAddress ? readBalancesOf(walletAddress, market, balancesRef.current) : Promise.resolve(null),
    ])
    let verification: BorrowReads['verification'] = null
    if (marketRead.status === 'available') {
      const at = Date.now()
      try {
        verification = { result: await (verifyRef.current ?? defaultVerifyMarket)(marketRead.data), at }
      } catch {
        verification = { result: { status: 'unavailable' }, at }
      }
    }
    return {
      status: 'available',
      data: {
        search,
        market: { ...marketRead, at: startedAt },
        verification,
        loans: loans ? { ...loans, at: startedAt } : null,
        balances: balances ? { ...balances, at: startedAt } : null,
      },
    }
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
function healthValue(value: number | null, band: BorrowHealthBand | null, align: 'start' | 'end' = 'end'): ReactNode | null {
  if (value === null && band === null) return null
  const status = band ? { label: healthBandLabel(band), tone: healthBandTone(band) } : value !== null ? thresholdStatus(value) : null
  return (
    <span className={`inline-flex flex-wrap items-center gap-2 ${align === 'end' ? 'justify-end' : 'justify-start'}`}>
      {value !== null && <span>{formatHealthFactor(value)}</span>}
      {status && <span className={`rounded-lg border px-2 py-0.5 text-right text-[11px] font-semibold leading-4 ${TONE_CLASS[status.tone]}`}>{status.label}</span>}
    </span>
  )
}

// ---------------------------------------------------------------------------------------------------------------------
// Small building blocks

function Metric({ label, note, value, strong = false }: { label: string; note?: ReactNode; value: ReactNode | null; strong?: boolean }) {
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

// ---------------------------------------------------------------------------------------------------------------------
// Disclosures: everything technical sits in one of these, closed until a person opens it

function Disclosure({ id, title, hint, level = 'inner', children }: { id: string; title: ReactNode; hint?: ReactNode; level?: 'outer' | 'inner'; children: ReactNode }) {
  return (
    <details data-borrow-disclosure={id}
      className={`group min-w-0 ${level === 'outer'
        ? 'rounded-2xl border border-slate-200 bg-white px-4 py-3.5 shadow-[0_18px_40px_rgba(15,23,42,0.06)] sm:px-6'
        : 'rounded-xl border border-slate-200 bg-slate-50/60 px-3 py-2.5'}`}>
      <summary className="flex cursor-pointer select-none list-none items-center justify-between gap-3 [&::-webkit-details-marker]:hidden">
        <span className="min-w-0">
          <span className={`block font-semibold text-slate-800 ${level === 'outer' ? 'text-sm' : 'text-xs'}`}>{title}</span>
          {hint && <span className="mt-0.5 block text-[11px] leading-4 text-slate-500">{hint}</span>}
        </span>
        <ChevronDown size={14} className="shrink-0 text-slate-400 transition-transform group-open:rotate-180" />
      </summary>
      <div className="mt-3">{children}</div>
    </details>
  )
}

function SubHeading({ children }: { children: ReactNode }) {
  return <h4 className="mb-1 text-xs font-semibold text-slate-700">{children}</h4>
}

// ---------------------------------------------------------------------------------------------------------------------
// Header and the one-line risk

function BorrowHeader({ loading, onRefresh }: { loading: boolean; onRefresh: () => void }) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <Banknote size={22} className="text-[#2F6E0C]" />
          <h1 className="text-2xl font-semibold tracking-tight text-slate-900">Borrow USDC</h1>
          <span className="inline-flex items-center gap-1 rounded-full border border-[#66D121]/30 bg-[#eef7e8] px-2.5 py-0.5 text-xs font-medium text-[#2F6E0C]" data-borrow-preview-chip>
            <Lock size={11} />
            Preview only
          </span>
        </div>
        <p className="mt-1 text-sm leading-6 text-slate-500">Use cirBTC as collateral to borrow USDC on Arc.</p>
      </div>
      <button type="button" onClick={onRefresh} disabled={loading}
        className="inline-flex items-center gap-1.5 rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs font-semibold text-slate-600 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-60">
        <RefreshCw size={13} className={loading ? 'animate-spin' : ''} />
        Refresh
      </button>
    </div>
  )
}

function RiskLine() {
  return (
    <section aria-label="Borrowing risks" data-borrow-section="risks" className="rounded-xl border border-amber-200 bg-amber-50/70 px-4 py-2.5">
      <p className="flex items-start gap-2 text-xs font-medium leading-5 text-amber-900">
        <ShieldAlert size={14} className="mt-0.5 shrink-0" />
        Your collateral can be liquidated if its value falls or your debt grows.
      </p>
      <details data-borrow-disclosure="risks" className="group mt-1">
        <summary className="flex cursor-pointer select-none list-none items-center gap-1 text-xs font-semibold text-amber-900/80 [&::-webkit-details-marker]:hidden">
          Understand the risks
          <ChevronDown size={12} className="transition-transform group-open:rotate-180" />
        </summary>
        <ul className="mt-2 space-y-2 pb-1 text-xs leading-5 text-amber-950/90">
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
      </details>
    </section>
  )
}

// ---------------------------------------------------------------------------------------------------------------------
// Markets: a short card to choose from; the evidence is under Advanced details

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

// The long form of the verification result, shown only inside Market details.
function verificationSentence(verification: MarketVerification | undefined): string {
  if (!verification || verification.status === 'checking') return 'Checking against Morpho on Arc.'
  if (verification.status === 'verified') return 'Verified on-chain. Matches Morpho on Arc: the ID hashes from the on-chain parameters, and the tokens, LLTV, oracle and rate model check out.'
  if (verification.status === 'unverified') return `Not verified. ${verification.reasons.map(describeVerificationReason).join(' ')}`
  return 'Not verified. Morpho could not be read on-chain, so this market is not verified. Do not rely on it.'
}

function DetailRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5 sm:flex-row sm:justify-between sm:gap-3">
      <dt className="shrink-0 text-slate-400">{label}</dt>
      <dd className="min-w-0 break-all text-slate-700 sm:text-right">{children}</dd>
    </div>
  )
}

// What a market card says in one short label. The first thing that applies wins; nothing is hidden, all of it is in Market details.
function marketStatus(market: BorrowMarket, verification: MarketVerification | undefined, borrowAmount: string | null) {
  const details = verification && (verification.status === 'verified' || verification.status === 'unverified') ? verification.details : null
  const liquidity = liquidityStatus(marketLiquidity(market, verification), borrowAmount, displayDigits(market.loanAsset.decimals))
  if (liquidity.status === 'none') return { tone: 'bad' as const, icon: XCircle, label: 'Unavailable for borrowing' }
  if (details !== null && details.oraclePrice === null) return { tone: 'bad' as const, icon: XCircle, label: 'Oracle data missing' }
  if (verification && verification.status !== 'checking' && verification.status !== 'verified') return { tone: verification.status === 'unverified' ? 'bad' as const : 'warn' as const, icon: ShieldAlert, label: 'Not verified' }
  if (!verification || verification.status === 'checking') return { tone: 'neutral' as const, icon: Clock, label: 'Checking' }
  if (liquidity.status === 'short') return { tone: 'warn' as const, icon: AlertTriangle, label: 'Not enough liquidity for this amount' }
  if (liquidity.status === 'unknown') return { tone: 'warn' as const, icon: AlertTriangle, label: 'Liquidity not reported' }
  return { tone: 'good' as const, icon: ShieldCheck, label: 'Available' }
}

function MarketCard({ market, verification, borrowAmount, selected, onSelect }: {
  market: BorrowMarket
  verification: MarketVerification | undefined
  borrowAmount: string | null
  selected: boolean
  onSelect: () => void
}) {
  const status = marketStatus(market, verification, borrowAmount)
  return (
    <div
      data-borrow-card={market.marketId}
      className={`min-w-0 overflow-hidden rounded-2xl border transition-colors ${
        selected ? 'border-[#66D121]/60 bg-[#eef7e8] ring-1 ring-[#66D121]/30' : 'border-slate-200 bg-white hover:border-slate-300'
      }`}
    >
      <button type="button" role="radio" aria-checked={selected} onClick={onSelect} data-borrow-market={market.marketId} className="block w-full p-4 text-left">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <span className="text-sm font-semibold text-slate-900">{market.collateralAsset.symbol} / {market.loanAsset.symbol}</span>
            {/* Both markets carry the same pair; the short ID is what tells them apart. */}
            <span className="ml-2 font-mono text-[11px] text-slate-400" title={market.marketId}>{shortenMarketId(market.marketId)}</span>
          </div>
          <span className={`shrink-0 text-[11px] font-semibold ${selected ? 'text-[#2F6E0C]' : 'text-slate-400'}`}>{selected ? 'Selected' : 'Select'}</span>
        </div>
        <div className="mt-2 flex flex-wrap gap-1.5" data-borrow-flags>
          <Badge tone={status.tone} icon={status.icon}>{status.label}</Badge>
          {isHighUtilization(market.utilization, MAINNET_BORROW_HIGH_UTILIZATION) && <Badge tone="warn" icon={AlertTriangle}>High utilization</Badge>}
        </div>
        <dl className="mt-3 grid grid-cols-2 gap-3">
          <div className="min-w-0">
            <dt className="text-[11px] text-slate-500">Borrow APY · variable</dt>
            <dd className="mt-0.5 text-base font-semibold tabular-nums text-slate-900">{percentText(market.borrowApy) ?? <span className="text-sm font-normal text-slate-400">{NOT_REPORTED}</span>}</dd>
          </div>
          <div className="min-w-0">
            <dt className="text-[11px] text-slate-500">Available liquidity</dt>
            <dd className="mt-0.5 break-words text-base font-semibold tabular-nums text-slate-900">{amountText(market.liquidity) ?? <span className="text-sm font-normal text-slate-400">{NOT_REPORTED}</span>}</dd>
          </div>
        </dl>
      </button>
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
        <SectionTitle title="Choose a market" />
        {state.status === 'loading' && <LoadingBars rows={3} />}
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
      </div>
    </Panel>
  )
}

// Everything technical about one market: the Market details group of Advanced details.
function MarketDetailsBlock({ market, verification, borrowAmount, selected }: { market: BorrowMarket; verification: MarketVerification | undefined; borrowAmount: string | null; selected: boolean }) {
  const details = verification && (verification.status === 'verified' || verification.status === 'unverified') ? verification.details : null
  const view = marketLiquidity(market, verification)
  const loanDigits = displayDigits(market.loanAsset.decimals)
  const liquidity = liquidityStatus(view, borrowAmount, loanDigits)
  const insufficient = liquidity.status === 'none' || liquidity.status === 'short'
  const highUtilization = isHighUtilization(market.utilization, MAINNET_BORROW_HIGH_UTILIZATION)
  const oraclePrice = details && details.oraclePrice !== null
    ? formatOraclePrice(details.oraclePrice, market.loanAsset.decimals, market.collateralAsset.decimals) : null
  const loanText = (value: string | null) => {
    const shown = value === null ? null : formatDecimalString(value, loanDigits)
    return shown === null ? null : `${shown} ${market.loanAsset.symbol}`
  }
  return (
    <div className="min-w-0" data-borrow-details={market.marketId}>
      <p className="text-xs font-semibold text-slate-700">
        {market.collateralAsset.symbol} / {market.loanAsset.symbol} <span className="font-mono font-normal text-slate-400">{shortenMarketId(market.marketId)}</span>
        {selected && <span className="ml-2 text-[11px] font-semibold text-[#2F6E0C]">Selected</span>}
      </p>
      <dl className="mt-1.5 space-y-1.5 text-[11px] leading-5">
        <DetailRow label="Market ID"><span className="font-mono">{market.marketId}</span></DetailRow>
        <DetailRow label="On-chain verification">{verificationSentence(verification)}</DetailRow>
        {details && (
          <>
            <DetailRow label="Oracle"><span className="font-mono">{details.params.oracle}</span></DetailRow>
            <DetailRow label="Oracle price">{oraclePrice === null ? 'Not available' : `${oraclePrice} ${market.loanAsset.symbol} per ${market.collateralAsset.symbol}`}</DetailRow>
            <DetailRow label="Rate model"><span className="font-mono">{details.params.irm}</span></DetailRow>
          </>
        )}
        <DetailRow label="LLTV (liquidation LTV)">{percentText(market.lltv) ?? NOT_REPORTED}</DetailRow>
        <DetailRow label="Available liquidity (Circle)">{amountText(market.liquidity) ?? NOT_REPORTED}</DetailRow>
        {view.onchain !== null && <DetailRow label="Liquidity on-chain">{loanText(view.onchain)}</DetailRow>}
        <DetailRow label="Utilization">{percentText(market.utilization) ?? NOT_REPORTED}</DetailRow>
        <DetailRow label="Total borrowed">{amountText(market.borrowAssets) ?? NOT_REPORTED}</DetailRow>
        <DetailRow label="Data timestamp">{market.refreshedAt ? formatUtcDateTime(market.refreshedAt) : NOT_REPORTED}</DetailRow>
      </dl>
      {insufficient && (
        <p className="mt-1.5 text-[11px] leading-4 text-red-700">
          {liquidity.status === 'none'
            ? `Insufficient Liquidity: less than ${smallestShown(loanDigits)} ${market.loanAsset.symbol} is available to borrow.`
            : `Insufficient Liquidity: only ${loanText(view.available) ?? 'a smaller amount'} is available, below your borrow amount.`}
        </p>
      )}
      {highUtilization && (
        <p className="mt-1.5 text-[11px] leading-4 text-amber-800">
          High market utilization (at or above {formatRatioPercent(MAINNET_BORROW_HIGH_UTILIZATION)}): most supplied funds are already lent out, so the
          variable borrow rate can rise quickly. This flags rate risk, not the amount available.
        </p>
      )}
    </div>
  )
}


// ---------------------------------------------------------------------------------------------------------------------
// Current loan: a short summary per loan; the full detail is under Advanced details

function Stat({ label, value }: { label: string; value: ReactNode | null }) {
  return (
    <div className="min-w-0">
      <dt className="text-[11px] text-slate-500">{label}</dt>
      <dd className="mt-0.5 break-words text-sm font-semibold tabular-nums text-slate-900">{value ?? <span className="font-normal text-slate-400">{NOT_REPORTED}</span>}</dd>
    </div>
  )
}

function LoanSummaryCard({ position, known }: { position: BorrowPosition; known: BorrowMarket | null }) {
  const pending = position.economics === 'pending'
  const noDebt = !pending && position.borrowed !== null && isZeroDecimal(position.borrowed.amount)
  return (
    <li data-borrow-position={position.loanId} className="min-w-0 rounded-xl border border-slate-200 bg-white p-3.5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="min-w-0 text-sm font-semibold text-slate-900">
          {known ? `${known.collateralAsset.symbol} / ${known.loanAsset.symbol}` : 'Borrow market'}
          <span className="ml-2 font-mono text-[11px] font-normal text-slate-400" title={position.marketId}>{shortenMarketId(position.marketId)}</span>
        </p>
        <span className="rounded-full border border-slate-200 bg-slate-50 px-2.5 py-0.5 text-[11px] font-semibold text-slate-600">
          {position.lifecycle === 'active' ? 'Active' : 'Status not reported'}
        </span>
      </div>
      {pending ? (
        <p className="mt-2 text-xs leading-5 text-slate-500">This loan exists but its collateral and debt are not indexed yet. Refresh in a moment.</p>
      ) : (
        <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-2.5">
          <Stat label="Current debt" value={amountText(position.borrowed)} />
          <Stat label="Collateral" value={amountText(position.collateral)} />
          <Stat label="Current Health Factor" value={noDebt && position.healthFactor === null ? 'No outstanding debt' : healthValue(position.healthFactor, position.healthBand, 'start')} />
          <Stat label="Liquidation Price" value={noDebt && position.liquidationPrice === null ? 'No outstanding debt' : amountText(position.liquidationPrice)} />
        </dl>
      )}
    </li>
  )
}

// Each loan keeps its own Health Factor. No wallet-wide Health Factor is ever computed: with several loans there is none, and
// with no active loan it does not apply. "No active loan" is only said after a complete, successful read; a failed read says "Unavailable".
function loanOverview(walletAddress: string | null, positions: Positions) {
  const { first, extra, next, moreError } = positions
  const loaded = first.status === 'available' ? [...first.data.items, ...extra] : []
  const active = loaded.filter((position) => position.lifecycle === 'active')
  const unreported = loaded.filter((position) => position.lifecycle === 'unreported')
  const closed = loaded.filter((position) => position.lifecycle === 'closed')
  const noActive = first.status === 'available' && active.length === 0 && unreported.length === 0 && next === null && moreError === null
  const text: string | null = !walletAddress ? 'Connect a wallet to see it'
    : first.status === 'unavailable' ? 'Unavailable'
      : noActive ? 'No active loan'
        : first.status === 'available' && active.length === 0 ? (unreported.length > 0 ? 'Status not reported' : 'Not all loans are loaded yet')
          : null
  return { active, unreported, closed, text }
}

function CurrentLoan({ walletAddress, positions, markets, bump }: { walletAddress: string | null; positions: Positions; markets: BorrowMarket[]; bump: () => void }) {
  const { first, next, busy, moreError, loadMore } = positions
  const { active, unreported, text } = loanOverview(walletAddress, positions)
  const marketById = useMemo(() => new Map(markets.map((market) => [market.marketId.toLowerCase(), market])), [markets])
  const cards = [...active, ...unreported]
  return (
    <section data-borrow-section="positions" className="min-w-0 rounded-2xl border border-slate-200 bg-white px-4 py-3.5 shadow-[0_18px_40px_rgba(15,23,42,0.06)] sm:px-6">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-sm font-semibold text-slate-900">Current loan</h2>
        {walletAddress && first.status === 'loading' ? <span className="h-4 w-24 animate-pulse rounded bg-slate-100" aria-hidden="true" />
          : text !== null && <span className="text-sm font-medium text-slate-800" data-current-loan>{text}</span>}
      </div>
      {walletAddress && first.status === 'unavailable' && <div className="mt-2"><ReadFailure error={first.error} onRetry={bump} /></div>}
      {cards.length > 0 && (
        <ul className={`mt-2.5 grid gap-3 ${cards.length > 1 ? 'lg:grid-cols-2' : ''}`}>
          {cards.map((position) => <LoanSummaryCard key={position.loanId} position={position} known={marketById.get(position.marketId.toLowerCase()) ?? null} />)}
        </ul>
      )}
      {moreError && <div className="mt-3"><ReadFailure error={moreError} /></div>}
      {next && (
        <button type="button" onClick={() => void loadMore()} disabled={busy}
          className="mt-3 rounded-xl border border-slate-200 bg-white px-4 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-60">
          {busy ? 'Loading…' : 'Load more loans'}
        </button>
      )}
    </section>
  )
}

// The full position, only under Advanced details. Its action buttons are permanently disabled.
function PositionCard({ position, known, listLoaded }: { position: BorrowPosition; known: BorrowMarket | null; listLoaded: boolean }) {
  const pending = position.economics === 'pending'
  const noDebt = !pending && position.borrowed !== null && isZeroDecimal(position.borrowed.amount)
  const lifecycle = position.lifecycle === 'active' ? 'Active' : position.lifecycle === 'closed' ? 'Closed' : 'Status not reported'
  return (
    <li data-borrow-position-full={position.loanId} className={`min-w-0 rounded-xl border p-3 ${position.lifecycle === 'closed' ? 'border-slate-200 bg-slate-50/60' : 'border-slate-200 bg-white'}`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <p className="text-sm font-semibold text-slate-900">
            {known ? `${known.collateralAsset.symbol} / ${known.loanAsset.symbol}` : listLoaded ? 'Market outside the cirBTC / USDC list' : 'Borrow market'}
          </p>
          <p className="break-all font-mono text-[11px] text-slate-400">{position.marketId}</p>
          <p className="break-all font-mono text-[11px] text-slate-400">Loan {position.loanId}</p>
        </div>
        <span className="rounded-full border border-slate-200 bg-slate-50 px-2.5 py-0.5 text-[11px] font-semibold text-slate-600">{lifecycle}</span>
      </div>
      {pending && <div className="mt-2"><Notice tone="info">This loan exists but its collateral and debt are not indexed yet, so none are shown. Refresh in a moment.</Notice></div>}
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

function LoanDetails({ walletAddress, positions, markets }: { walletAddress: string | null; positions: Positions; markets: BorrowMarket[] }) {
  const { first, extra } = positions
  const { active, unreported, closed, text } = loanOverview(walletAddress, positions)
  const ordered = [...active, ...unreported, ...closed]
  const marketById = new Map(markets.map((market) => [market.marketId.toLowerCase(), market]))
  const noActive = text === 'No active loan'
  return (
    <div className="min-w-0">
      <dl className="divide-y divide-slate-100" data-borrow-current-loan={text ?? 'active'}>
        <Metric label="Current loan" value={text ?? `${active.length + unreported.length} loan${active.length + unreported.length === 1 ? '' : 's'}`} />
        <Metric label="Current Health Factor" value={noActive || !walletAddress ? <span data-current-health-factor>Not applicable</span> : first.status === 'unavailable' ? 'Unavailable' : 'Shown for each loan below'} />
      </dl>
      {ordered.length > 0 && (
        <ul className="mt-2 grid gap-3 lg:grid-cols-2">
          {ordered.map((position) => <PositionCard key={position.loanId} position={position} known={marketById.get(position.marketId.toLowerCase()) ?? null} listLoaded={markets.length > 0} />)}
        </ul>
      )}
      {extra.length > 0 && <p className="mt-2 text-[11px] text-slate-500">{extra.length} more loaded from further pages.</p>}
    </div>
  )
}

// ---------------------------------------------------------------------------------------------------------------------
// The one result

const STATUS_STYLE = {
  ready: { box: 'border-emerald-200 bg-emerald-50', icon: CheckCircle2, iconClass: 'text-emerald-600', title: 'text-emerald-900', text: 'text-emerald-900/80' },
  blocked: { box: 'border-red-200 bg-red-50', icon: XCircle, iconClass: 'text-red-600', title: 'text-red-800', text: 'text-red-900/80' },
  waiting: { box: 'border-amber-200 bg-amber-50', icon: Clock, iconClass: 'text-amber-600', title: 'text-amber-900', text: 'text-amber-900/80' },
  info: { box: 'border-slate-200 bg-slate-50', icon: Info, iconClass: 'text-slate-500', title: 'text-slate-800', text: 'text-slate-600' },
} as const

function StatusCard({ status, walletSupported, onRefresh }: { status: BorrowStatus; walletSupported: boolean; onRefresh: () => void }) {
  const style = STATUS_STYLE[status.tone]
  return (
    <div className={`rounded-2xl border p-4 ${style.box}`} data-borrow-status={status.id} data-borrow-status-tone={status.tone}>
      <div className="flex items-start gap-3">
        <style.icon size={20} className={`mt-0.5 shrink-0 ${style.iconClass}`} />
        <div className="min-w-0 flex-1">
          <p className={`text-base font-semibold leading-6 ${style.title}`} data-status-title>{status.title}{status.id === 'checks-passed' ? ' — Preview only' : ''}</p>
          <p className={`mt-0.5 text-xs leading-5 [overflow-wrap:anywhere] ${style.text}`} data-status-detail>{status.detail}</p>
          {status.canRefresh && (
            <button type="button" onClick={onRefresh} data-borrow-refresh-quote
              className="mt-2.5 inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50">
              <RefreshCw size={12} />
              Refresh quote
            </button>
          )}
          {walletSupported && status.id === 'checks-passed' && (
            <p className="mt-2 flex items-center gap-1.5 text-[11px] font-medium text-emerald-800" data-borrow-wallet-ok>
              <CheckCircle2 size={12} />
              Wallet supports atomic transactions on Arc
            </p>
          )}
        </div>
      </div>
      <div className="mt-3 space-y-2 border-t border-black/5 pt-3">
        <button type="button" disabled aria-disabled="true" data-borrow-action="borrow" title="Borrowing is not enabled in this release"
          className="inline-flex w-full cursor-not-allowed items-center justify-center gap-2 rounded-xl border border-slate-200 bg-slate-100 px-4 py-2.5 text-sm font-semibold text-slate-400">
          <Lock size={14} />
          Borrow USDC · not enabled
        </button>
        <p className="text-[11px] leading-4 text-slate-500" data-borrow-preview-note>Preview only: real borrowing is not enabled in this version. Nothing is sent: no signature, approval or transaction.</p>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------------------------------------------------
// New borrow: the model behind the estimate, the one status and the technical details

type QuoteInputs = {
  collateralText: string
  borrowText: string
  targetHealthFactor: number
  setCollateralText: (value: string) => void
  setBorrowText: (value: string) => void
  setTargetHealthFactor: (value: number) => void
}

function AmountField({ id, label, symbol, value, onChange, disabled, hint }: {
  id: string
  label: string
  symbol: string
  value: string
  onChange: (value: string) => void
  disabled: boolean
  hint?: string
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
      {hint && <p className="mt-1 text-[11px] leading-4 text-slate-400">{hint}</p>}
    </div>
  )
}

function QueryState({ query, idle, onRetry }: { query: Query<BorrowQuote>; idle: string; onRetry?: () => void }) {
  if (query.status === 'idle') return <p className="text-xs leading-5 text-slate-400">{idle}</p>
  if (query.status === 'loading') return <LoadingBars rows={3} />
  if (query.status === 'unavailable') return <ReadFailure error={query.error} onRetry={onRetry} />
  return null
}

// Two decimals, unless the two figures would look the same at two decimals: then enough digits to tell them apart.
function healthPair(value: number, other: number): string {
  const short = formatHealthFactor(value)
  if (short !== formatHealthFactor(other)) return short
  return String(Number(value.toFixed(6)))
}

const plainSpaces = (text: string) => text.replace(/ /g, ' ')

// The wallet's balance of the collateral token as text, or null when it was not read.
function collateralBalanceText(balances: Query<WalletBalances>, market: BorrowMarket | null): string | null {
  if (balances.status !== 'available' || !market || balances.data.collateralToken.raw === null) return null
  const decimals = market.collateralAsset.decimals
  const shown = formatDecimalString(unitsToDecimal(balances.data.collateralToken.raw, decimals), displayDigits(decimals))
  return shown === null ? null : `${shown} ${market.collateralAsset.symbol}`
}

function balanceLine(walletAddress: string | null, balances: Query<WalletBalances>, market: BorrowMarket | null): string {
  if (!walletAddress) return 'Connect a wallet'
  if (balances.status === 'idle' || balances.status === 'loading') return 'Reading…'
  return collateralBalanceText(balances, market) ?? 'Unavailable'
}

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

type WalletCompatView = { state: WalletCompat; label: string; tone: 'ok' | 'bad' | 'wait'; summary: string | null }

// The three answers a person needs about the wallet. Anything but "supported" is not suitable for Borrow.
function walletCompatView(compat: WalletCompat, summary: string | null): WalletCompatView | null {
  switch (compat) {
    case 'no-wallet': return null
    case 'wrong-network': return { state: compat, label: `Switch to Arc Mainnet (${MAINNET_BORROW_CHAIN_ID})`, tone: 'bad', summary: null }
    case 'checking': return { state: compat, label: 'Checking…', tone: 'wait', summary: null }
    case 'supported': return { state: compat, label: 'Atomic transactions supported', tone: 'ok', summary }
    case 'unsupported': return { state: compat, label: 'Not supported', tone: 'bad', summary }
    default: return { state: 'unknown', label: 'Could not verify', tone: 'bad', summary }
  }
}

const WALLET_TONE = { ok: 'text-emerald-700', bad: 'text-red-700', wait: 'text-slate-500' } as const

type BorrowModelArgs = {
  market: BorrowMarket | null
  verification: MarketVerification | undefined
  walletAddress: string | null
  wallet: WalletView
  attemptLedger: BorrowAttemptLedger | null
  positions: Positions
  client: BorrowReadClient | undefined
  verifyMarket: ((market: BorrowMarket) => Promise<MarketVerification>) | undefined
  readBalances: WalletBalanceReader | undefined
  epoch: string
  inputs: QuoteInputs
}

// Everything the estimate, the status and the technical details of one new borrow are built from. All the reads and the shared
// safety checks run here, once; the standard view and Advanced details only present what comes out.
function useBorrowModel({ market, verification, walletAddress, wallet, attemptLedger, positions, client, verifyMarket, readBalances, epoch, inputs }: BorrowModelArgs) {
  const { collateralText, borrowText, targetHealthFactor } = inputs

  const collateralInput = useDebounced(market ? parsePositiveAmount(collateralText) : null)
  const borrowInput = useDebounced(market ? parsePositiveAmount(borrowText) : null)
  const marketId = market?.marketId ?? null
  const collateralSymbol = market?.collateralAsset.symbol ?? 'cirBTC'
  const loanSymbol = market?.loanAsset.symbol ?? 'USDC'
  const target = targetHealthFactor.toFixed(2)
  const session = wallet.session

  // Optional comparison, outside the main flow: the service maximum for a collateral amount the user types.
  const maxBorrow = useBorrowRead(
    marketId && collateralInput ? `max:${marketId}:${collateralInput}:${epoch}` : null,
    () => quoteMaxBorrow({ marketId: marketId ?? '', collateralAmount: collateralInput ?? '' }, client),
  )
  // Reference only: what Circle's separate sizing preview says the collateral for the target would be. It is not a quote for a
  // transaction: the borrow call takes no collateral, so nothing can be prepared or sent with it.
  const sizing = useBorrowRead(
    marketId && borrowInput ? `size:${marketId}:${borrowInput}:${targetHealthFactor}:${epoch}` : null,
    () => quoteRequiredCollateral({ marketId: marketId ?? '', borrowAmount: borrowInput ?? '', targetHealthFactor }, client),
  )

  // One loan per market and wallet: with an existing loan in the selected market the borrow is "Borrow more" on that loan. While
  // the loans are still being read nobody knows which one it is, so no request is made yet.
  const loansRead = positions.first
  const allLoans = loansRead.status === 'available' ? [...loansRead.data.items, ...positions.extra] : []
  const activeLoan = market ? allLoans.find((loan) => loan.marketId.toLowerCase() === market.marketId.toLowerCase() && loan.lifecycle !== 'closed') ?? null : null
  const loansPending = walletAddress !== null && loansRead.status === 'loading'
  const baseAction: BaseBorrowAction | null = market && borrowInput && !loansPending
    ? activeLoan ? { kind: 'borrow-more', loanId: activeLoan.loanId, borrowAmount: borrowInput } : { kind: 'borrow', marketId: market.marketId, borrowAmount: borrowInput }
    : null

  const reads = useBorrowReads(baseAction, market, walletAddress, session, targetHealthFactor, client, verifyMarket, readBalances, epoch)
  const displayBalances = useWalletBalances(walletAddress, session, market, readBalances, epoch)
  const now = useNow()

  const readsData = reads.status === 'available' ? reads.data : null
  const searchRead = readsData?.search ?? null
  const search = searchRead?.status === 'available' ? searchRead.data : null
  const prepared = search ? search.prepared : null
  const walletQuoteError = searchRead?.status === 'unavailable' ? searchRead.error : null
  // The action carries the very collateral buffer the quote was found for, so the quote and the write are one request.
  const action: BorrowWriteAction | null = baseAction ? (search && search.slippageBps !== undefined ? { ...baseAction, slippageBps: search.slippageBps } : baseAction) : null
  const full = prepared && prepared.quote.kind === 'borrow' ? prepared.quote : null
  const max = maxBorrow.status === 'available' && maxBorrow.data.kind === 'max-borrow' ? maxBorrow.data : null
  const required = sizing.status === 'available' && sizing.data.kind === 'required-collateral' ? sizing.data : null

  // Only a real quote for this wallet is shown as the estimate: it is what a transaction would be prepared from. The sizing
  // preview is reference only and lives under Advanced details.
  const shown = full
    ? { collateral: full.collateral, healthFactor: full.resultingHealthFactor, band: full.resultingBand as BorrowHealthBand | null, liquidationPrice: full.liquidationPrice, apy: full.borrowApy }
    : null
  const bufferPercent = search && search.slippageBps !== undefined ? `${(search.slippageBps / 100).toFixed(2)}%` : null

  const gasWei = full ? totalGasWei(full.gasFees) : null
  const feeParts = full ? [
    gasWei === null ? null : `${formatUnitsText(gasWei, MAINNET_ARC_NATIVE_CURRENCY.decimals, 6)} ${MAINNET_ARC_NATIVE_CURRENCY.symbol} gas`,
    ...full.fees.map((fee) => { const text = amountText(fee.amount); return text === null ? null : `${text} ${fee.type} fee` }),
  ].filter((part): part is string => part !== null) : []
  const gasFeesText = full ? (feeParts.length === 0 ? null : full.fees.length === 0 ? `${feeParts.join(' + ')}, no service fee reported in this quote` : feeParts.join(' + ')) : null
  // Raw comparison with the selected target; the two-decimal display never decides it.
  const met = shown ? healthTargetMet(shown.healthFactor, targetHealthFactor) : null
  const interest = full ? illustrativeYearlyInterest(full.loanAsset.amount, full.borrowApy) : null
  const loanDigits = displayDigits(market?.loanAsset.decimals ?? 6)
  const borrowShown = borrowInput ? `${formatDecimalString(borrowInput, loanDigits) ?? borrowInput} ${loanSymbol}` : null
  const collateralNotice = collateralInput && required
    ? compareDecimals(collateralInput, required.requiredCollateral.amount) < 0
      ? { tone: 'note' as const, text: `The collateral you typed is below the ${amountText(required.requiredCollateral)} in Circle's sizing preview for a ${target} health factor.` }
      : { tone: 'info' as const, text: `The collateral you typed covers the ${amountText(required.requiredCollateral)} in Circle's sizing preview for a ${target} health factor.` }
    : null
  const unverified = market !== null && verification !== undefined && verification.status !== 'verified' && verification.status !== 'checking'

  // The safety checks: the shared ones, run on reads taken for this exact action.
  const loansSnapshot = readsData?.loans ?? null
  const snapshotLoans = loansSnapshot?.status === 'available' ? loansSnapshot.data.items : null
  const snapshotLoan = market && snapshotLoans ? snapshotLoans.find((loan) => loan.marketId.toLowerCase() === market.marketId.toLowerCase() && loan.lifecycle !== 'closed') ?? null : null
  const balancesSnapshot = readsData?.balances ?? null
  const evidence: BorrowWriteEvidence | null = session && readsData && market ? {
    session,
    market: readsData.market.status === 'available' ? { data: readsData.market.data, fetchedAt: readsData.market.at } : null,
    verification: readsData.verification ? { marketId: market.marketId, result: readsData.verification.result, checkedAt: readsData.verification.at } : null,
    position: snapshotLoan && loansSnapshot?.status === 'available' ? { data: snapshotLoan, fetchedAt: loansSnapshot.at } : null,
    loans: loansSnapshot?.status === 'available' ? { data: loansSnapshot.data, fetchedAt: loansSnapshot.at } : null,
    balances: balancesSnapshot?.status === 'available' ? { data: balancesSnapshot.data, fetchedAt: balancesSnapshot.at } : null,
    targetHealthFactor,
  } : null
  // The attempt history is read again at every render (the clock ticks), so another tab's attempt is seen at once.
  const attemptList = attemptLedger ? attemptLedger.list() : []
  const attemptLog: AttemptLogHealth | null = attemptLedger ? attemptLedger.health() : null
  const plan = action ? planBorrowWrite(action, { wallet: walletAddress ? wallet.state : null, quote: prepared, evidence, attempts: attemptList, attemptLog, now }) : null
  const checking = market !== null && borrowInput !== null && (loansPending || reads.status === 'loading')
  // Why nothing can continue when an earlier write is unresolved or the history cannot be trusted, even before an amount is typed.
  const scopes = walletAddress ? [
    market ? borrowAttemptScope({ kind: 'borrow', marketId: market.marketId, borrowAmount: '1' }, walletAddress) : '',
    activeLoan ? borrowAttemptScope({ kind: 'borrow-more', loanId: activeLoan.loanId, borrowAmount: '1' }, walletAddress) : '',
  ] : []
  const unresolvedRecord: BorrowAttemptRecord | undefined = scopes.length ? attemptList.find((record) => record.scopeId !== '' && scopes.includes(record.scopeId)) : undefined
  const unresolvedText = unresolvedRecord ? explainAttempt(unresolvedRecord, false, unresolvedRecord.scopeId === scopes[1] ? 'loan' : 'market') : null
  const unreliableText = !unresolvedRecord && attemptLog !== null && !(attemptLog.ok && attemptLog.persistent) ? explainAttemptLog(attemptLog) : null

  // The balance the checks used when there is one; the separate balance read until then.
  const balanceQuery: Query<WalletBalances> = balancesSnapshot ?? displayBalances
  const balanceNow = collateralBalanceText(balanceQuery, market)
  const marketNow = readsData && readsData.market.status === 'available' ? readsData.market.data : market
  const liquidityView = marketNow ? marketLiquidity(marketNow, readsData?.verification?.result ?? verification) : null
  const liquidityShown = liquidityView && liquidityView.available !== null ? formatDecimalString(liquidityView.available, loanDigits) : null

  const status: BorrowStatus = chooseBorrowStatus({
    marketChosen: market !== null,
    amountEntered: borrowInput !== null,
    walletConnected: walletAddress !== null,
    wallet: wallet.compat === 'no-wallet' ? 'checking' : wallet.compat,
    history: { unresolved: unresolvedText, unreliable: unreliableText },
    checking,
    checks: plan ? plan.checks : null,
    quoteFailure: walletQuoteError ? describeBorrowError(walletQuoteError) : null,
    facts: {
      collateralSymbol,
      loanSymbol,
      collateralBalance: balanceNow === null ? null : plainSpaces(balanceNow),
      collateralNeeded: full ? plainSpaces(amountText(full.collateral) ?? '') || null : null,
      borrowAmount: borrowShown,
      liquidityAvailable: liquidityShown === null ? null : `${liquidityShown} ${loanSymbol}`,
      estimatedHealthFactor: shown && shown.healthFactor !== null ? healthPair(shown.healthFactor, targetHealthFactor) : null,
      targetHealthFactor: target,
      maxLtv: formatRatioPercent(MAINNET_BORROW_MAX_LTV),
    },
  })

  const ageOf = (at: number | null | undefined) => (at === null || at === undefined ? null : { seconds: Math.max(0, Math.round((now - at) / 1000)), expired: now - at > MAINNET_BORROW_MAX_EVIDENCE_AGE_MS })
  const evidenceAges = [
    { label: 'Circle Borrow Kit quote', age: ageOf(prepared?.fetchedAt) },
    { label: 'Market data', age: ageOf(readsData?.market.at) },
    { label: 'On-chain market check', age: ageOf(readsData?.verification?.at) },
    { label: 'Your loans', age: ageOf(loansSnapshot?.at) },
    { label: 'Your token balances', age: ageOf(balancesSnapshot?.at) },
  ]

  return {
    market, marketId, collateralSymbol, loanSymbol, target, targetHealthFactor,
    walletAddress, wallet, walletView: walletCompatView(wallet.compat, wallet.summary),
    borrowInput, borrowShown, action, activeLoan, reads, readsData,
    maxBorrow, max, sizing, required, collateralInput, collateralNotice,
    search, prepared, full, shown, walletQuoteError, bufferPercent, gasFeesText, met, interest,
    balanceQuery, balanceText: balanceLine(walletAddress, balanceQuery, market),
    unverified, plan, checks: plan ? plan.checks : null, checking, unresolvedText, unreliableText,
    quoteAgeSeconds: prepared ? Math.max(0, Math.round((now - prepared.fetchedAt) / 1000)) : null,
    evidenceAges, status,
  }
}

type BorrowModel = ReturnType<typeof useBorrowModel>

// ---------------------------------------------------------------------------------------------------------------------
// The standard view of a new borrow: two inputs, the estimate and the one status

function EstimateCard({ model }: { model: BorrowModel }) {
  const { market, borrowInput, borrowShown, shown, full, reads, status, target, met, walletAddress, bufferPercent, gasFeesText, balanceText } = model
  const expired = status.id === 'quote-expired'
  const loading = reads.status === 'loading' || model.checking
  const targetNote = met === null ? undefined : (
    <span data-borrow-target-status={met ? 'met' : 'not-met'}>
      Your target: {target} — <span className={`font-semibold ${met ? 'text-emerald-700' : 'text-red-700'}`}>{met ? 'Met' : 'Not met'}</span>
    </span>
  )
  let body: ReactNode
  if (!market) body = <p className="text-xs leading-5 text-slate-400">Choose a market to see an estimate.</p>
  else if (borrowInput === null) body = <p className="text-xs leading-5 text-slate-400">Enter a borrow amount to see the estimate.</p>
  else if (expired) {
    body = (
      <>
        <dl className="divide-y divide-slate-100"><Metric label="Borrow Amount" value={borrowShown} strong /></dl>
        <p className="mt-2 text-xs leading-5 text-slate-500" data-borrow-estimate-hidden>The figures are hidden until the quote is refreshed.</p>
      </>
    )
  } else if (loading && !shown) body = <LoadingBars rows={7} />
  else if (shown && full) {
    body = (
      <dl className="divide-y divide-slate-100" data-borrow-estimate>
        <Metric label="Borrow Amount" value={borrowShown} strong />
        <Metric label="Collateral Required" note={bufferPercent ? `Includes a ${bufferPercent} collateral buffer. Not a separate fee.` : 'Sized by the Borrow Service'} value={amountText(shown.collateral)} strong />
        <Metric label="Wallet Collateral Balance" value={<span data-borrow-wallet-balance className={status.id === 'insufficient-collateral' ? 'text-red-700' : undefined}>{balanceText}</span>} />
        <Metric label="Borrow APY (variable)" value={percentText(shown.apy)} />
        <Metric label="Estimated Gas / Fees" value={gasFeesText} />
        <Metric label="Estimated Health Factor" note={targetNote} value={healthValue(shown.healthFactor, shown.band)} />
        <Metric label="Liquidation Price" value={amountText(shown.liquidationPrice)} />
      </dl>
    )
  } else {
    body = (
      <>
        <dl className="divide-y divide-slate-100"><Metric label="Borrow Amount" value={borrowShown} strong /></dl>
        <p className="mt-2 text-xs leading-5 text-slate-500">
          {walletAddress ? 'No quote is available yet. The status below says why.' : 'Connect a wallet to see the collateral, fees and Health Factor.'}
        </p>
      </>
    )
  }
  return (
    <div className="rounded-2xl border border-slate-200 bg-slate-50/60 p-4" data-borrow-summary>
      <h3 className="text-sm font-semibold text-slate-900">Estimate</h3>
      <div className="mt-1.5">{body}</div>
    </div>
  )
}

function NewBorrow({ model, inputs, onRefreshQuote }: { model: BorrowModel; inputs: QuoteInputs; onRefreshQuote: () => void }) {
  const { market, loanSymbol, target, targetHealthFactor, status, action, unverified } = model
  const noMarket = market === null
  return (
    <Panel>
      <div data-borrow-section="quote">
        <SectionTitle
          title="New borrow estimate"
          hint={noMarket ? 'Choose a market above to start.' : undefined}
          right={market && (
            <span className="min-w-0 text-xs text-slate-500" data-borrow-selected>
              <span className="font-semibold text-slate-800">{market.collateralAsset.symbol} / {market.loanAsset.symbol}</span>{' '}
              <span className="font-mono" title={market.marketId}>{shortenMarketId(market.marketId)}</span>
              {action?.kind === 'borrow-more' && <span className="ml-2 font-semibold text-slate-700" data-borrow-kind="borrow-more">Borrow more on your existing loan</span>}
            </span>
          )}
        />
        {unverified && status.id !== 'market-unavailable' && (
          <div className="mb-3" data-borrow-unverified>
            <Notice tone="warn">This market is not verified on-chain. Treat these numbers as unconfirmed.</Notice>
          </div>
        )}
        <div className="grid gap-4 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)] lg:gap-x-6">
          <div className="min-w-0 space-y-4 lg:col-start-1 lg:row-start-1">
            <AmountField id="borrow-amount" label={`Borrow amount (${loanSymbol})`} symbol={loanSymbol} value={inputs.borrowText}
              disabled={noMarket} onChange={(value) => inputs.setBorrowText(sanitizeDecimalInput(value, market?.loanAsset.decimals ?? 6))} />
            <div>
              <p className="text-sm font-medium text-slate-700">Target Health Factor</p>
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
              <p className="mt-1 text-[11px] leading-4 text-slate-500" data-borrow-hf-help>
                1.0 is the liquidation threshold. A higher target keeps more distance from it, but even {target} is no guarantee.
              </p>
            </div>
          </div>
          <div className="min-w-0 lg:col-start-2 lg:row-span-2 lg:row-start-1">
            <EstimateCard model={model} />
          </div>
          <div className="min-w-0 lg:col-start-1 lg:row-start-2">
            <StatusCard status={status} walletSupported={model.wallet.compat === 'supported'} onRefresh={onRefreshQuote} />
          </div>
        </div>
      </div>
    </Panel>
  )
}

// ---------------------------------------------------------------------------------------------------------------------
// Advanced details: every technical check and piece of evidence, in sections that stay closed until opened

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

const SEARCH_OUTCOME = {
  'as-requested': 'Circle\'s default quote reaches the target.',
  'buffered': 'A collateral buffer was added to reach the target.',
  'not-reached': 'The target was not reached, even with the largest collateral buffer Machina allows.',
} as const

const detailRows = 'space-y-1.5 text-[11px] leading-5'

function QuoteDetails({ model, inputs, onRefreshQuote }: { model: BorrowModel; inputs: QuoteInputs; onRefreshQuote: () => void }) {
  const { market, full, shown, search, walletQuoteError, target, targetHealthFactor, met, bufferPercent, interest, collateralSymbol, loanSymbol, required, sizing, max, maxBorrow, collateralNotice, quoteAgeSeconds } = model
  const noMarket = market === null
  const idle = !market ? 'Choose a market first.'
    : model.borrowInput === null ? 'Enter a borrow amount to read a quote.'
      : !model.walletAddress ? 'Connect a wallet to read a quote. Circle prices a new borrow for a wallet, and Machina only shows a quote a transaction could be prepared from.'
        : model.reads.status === 'loading' ? 'Reading the quote…'
          : 'No quote was returned.'
  return (
    <div className="space-y-4" data-borrow-quote-details>
      <section>
        <SubHeading>Circle Borrow Kit quote</SubHeading>
        {walletQuoteError && <ReadFailure error={walletQuoteError} onRetry={onRefreshQuote} />}
        {!full && !walletQuoteError && <p className="text-[11px] leading-4 text-slate-500">{idle}</p>}
        {full && shown && (
          <>
            <dl className={detailRows}>
              <DetailRow label="Quote age">{quoteAgeSeconds === null ? NOT_REPORTED : `${quoteAgeSeconds} s. A quote is only used for ${MAINNET_BORROW_MAX_EVIDENCE_AGE_MS / 1000} s.`}</DetailRow>
              <DetailRow label="Loan amount in the quote">{amountText(full.loanAsset) ?? NOT_REPORTED}</DetailRow>
              <DetailRow label="Collateral in the quote">{amountText(full.collateral) ?? NOT_REPORTED}</DetailRow>
              <DetailRow label="Resulting LTV">{percentText(full.resultingLtv) ?? NOT_REPORTED} <span className="text-slate-400">(Machina starting limit {formatRatioPercent(MAINNET_BORROW_MAX_LTV)})</span></DetailRow>
              <DetailRow label="Health Factor in the quote">{shown.healthFactor === null ? NOT_REPORTED : healthPair(shown.healthFactor, targetHealthFactor)}</DetailRow>
              <DetailRow label="Target Health Factor">{target}{met !== null && <span className={`ml-2 font-semibold ${met ? 'text-emerald-700' : 'text-red-700'}`}>{met ? 'Met' : 'Not met'}</span>}</DetailRow>
              <DetailRow label="Collateral buffer (slippage)">{bufferPercent ?? 'None (service default)'}</DetailRow>
              {search && <DetailRow label="How the quote was found">{SEARCH_OUTCOME[search.outcome]} {search.reads} read{search.reads === 1 ? '' : 's'}.</DetailRow>}
              {search && search.requestedHealthFactor !== null && <DetailRow label="Health Factor of the default quote">{healthPair(search.requestedHealthFactor, targetHealthFactor)}</DetailRow>}
              {search && search.baseHealthFactor !== null && <DetailRow label="Health Factor without any buffer">{healthPair(search.baseHealthFactor, targetHealthFactor)}</DetailRow>}
              <DetailRow label="Liquidation price">{amountText(shown.liquidationPrice) ?? NOT_REPORTED}</DetailRow>
              <DetailRow label="Borrow APY (variable)">{percentText(shown.apy) ?? NOT_REPORTED}</DetailRow>
              {full.fees.map((fee, index) => <DetailRow key={`${fee.type}-${index}`} label={`Service fee · ${fee.type}`}>{amountText(fee.amount) ?? NOT_REPORTED}</DetailRow>)}
              {full.fees.length === 0 && <DetailRow label="Service fees">None in this quote</DetailRow>}
              {full.gasFees.map((entry, index) => (
                <DetailRow key={`${entry.name}-${index}`} label={`Gas · ${entry.name}`}>
                  {entry.gasUnits} gas × {entry.gasPriceWei} wei = {formatUnitsText(BigInt(entry.feeWei), MAINNET_ARC_NATIVE_CURRENCY.decimals, 6)} {MAINNET_ARC_NATIVE_CURRENCY.symbol}
                </DetailRow>
              ))}
              {full.gasFees.length === 0 && <DetailRow label="Gas">No gas estimate in this quote</DetailRow>}
              <DetailRow label="Illustrative interest, one year">{interest === null ? NOT_REPORTED : `≈ ${interest} ${full.loanAsset.token}`} <span className="text-slate-400">Machina arithmetic: amount × quoted APY, if the rate never changed. Not a service figure.</span></DetailRow>
            </dl>
            {met !== null && (
              <div className="mt-2" data-borrow-target-note={met ? 'met' : 'below'}>
                {!met && shown.healthFactor !== null ? (
                  <Notice tone="error">
                    <p><span className="font-semibold" data-borrow-hf-gap="below">Selected safety target not met.</span> The quote is {healthPair(shown.healthFactor, targetHealthFactor)} against
                      your {target} target{search?.outcome === 'not-reached' ? ', even with the largest collateral buffer Machina allows' : ''}. Machina does not lower your target or
                      prepare a different borrow, so this borrow is blocked.</p>
                  </Notice>
                ) : (
                  <p className="text-[11px] font-semibold text-emerald-700" data-borrow-hf-gap="met">
                    Meets your selected target of {target}.
                    {search?.outcome === 'buffered' && search.requestedHealthFactor !== null && bufferPercent && (
                      <span className="font-normal text-slate-500"> Circle&apos;s default quote gives {healthPair(search.requestedHealthFactor, targetHealthFactor)}; this one adds a {bufferPercent} collateral buffer to reach your target.</span>
                    )}
                  </p>
                )}
              </div>
            )}
            <p className="mt-2 text-[11px] leading-4 text-slate-500" data-borrow-buffer-note>
              The collateral buffer is part of the collateral shown as Collateral Required, so the Health Factor reaches your target. It is not a separate fee.
            </p>
          </>
        )}
      </section>

      <section>
        <SubHeading>Reference only: Circle&apos;s sizing preview for {target}</SubHeading>
        <p className="mb-1 text-[11px] leading-4 text-slate-500" data-borrow-reference-note>
          A separate preview of the collateral for your target. It is not a quote for a transaction and nothing can be sent with it.
        </p>
        <QueryState query={sizing} idle="Enter a borrow amount to see it." onRetry={onRefreshQuote} />
        {required && (
          <dl className={detailRows}>
            <DetailRow label="Collateral in the preview">{amountText(required.requiredCollateral) ?? NOT_REPORTED}</DetailRow>
            <DetailRow label="Health factor in the preview">{required.resultingHealthFactor === null ? NOT_REPORTED : formatHealthFactor(required.resultingHealthFactor)}</DetailRow>
            <DetailRow label="Liquidation price in the preview">{amountText(required.liquidationPrice) ?? NOT_REPORTED}</DetailRow>
          </dl>
        )}
      </section>

      <Disclosure id="collateral-comparison" title="Optional collateral comparison" hint="Theoretical maximum borrow for a collateral amount you type">
        <div className="space-y-3" data-borrow-optional>
          <AmountField id="borrow-collateral" label={`Collateral to compare (${collateralSymbol}, optional)`} symbol={collateralSymbol} value={inputs.collateralText}
            disabled={noMarket} hint={`Typed by you. It is not your wallet balance and it is not used for the estimate or the checks. Up to ${market?.collateralAsset.decimals ?? 8} decimals.`}
            onChange={(value) => inputs.setCollateralText(sanitizeDecimalInput(value, market?.collateralAsset.decimals ?? 8))} />
          <QueryState query={maxBorrow} idle="Type a collateral amount to see the service maximum for it." onRetry={onRefreshQuote} />
          {max && (
            <>
              <dl className={detailRows}>
                <DetailRow label="Maximum borrow">{amountText(max.maxBorrow) ?? NOT_REPORTED}</DetailRow>
                <DetailRow label="Health factor at that borrow">{max.resultingHealthFactor === null ? NOT_REPORTED : formatHealthFactor(max.resultingHealthFactor)}</DetailRow>
                <DetailRow label="Liquidation price">{amountText(max.liquidationPrice) ?? NOT_REPORTED} <span className="text-slate-400">({collateralSymbol} price in {loanSymbol} at which the loan can be liquidated)</span></DetailRow>
              </dl>
              <p className="text-[11px] leading-4 text-slate-500" data-borrow-max-note>
                The maximum sits at the liquidation threshold (health factor {max.resultingHealthFactor === null ? 'not reported' : formatHealthFactor(max.resultingHealthFactor)}).
                A price move or accrued interest can take the loan below it.
              </p>
            </>
          )}
          {collateralNotice && <Notice tone={collateralNotice.tone}>{collateralNotice.text}</Notice>}
        </div>
      </Disclosure>
    </div>
  )
}

function ChecksDetails({ model, walletChainId, onRefreshQuote }: { model: BorrowModel; walletChainId: number | null; onRefreshQuote: () => void }) {
  const { walletView, plan, checks, checking, evidenceAges, action, unresolvedText, unreliableText } = model
  const historyNote = unresolvedText ?? unreliableText
  const readiness = checks && !checking ? borrowReadiness(checks) : null
  const chip = checking ? READINESS_CHIP.checking : readiness ? READINESS_CHIP[readiness.status] : null
  const groups = checks && !checking ? groupWriteChecks(checks) : []
  const reason = !action ? (model.market ? 'Enter a borrow amount to run the checks.' : 'Choose a market to run the checks.')
    : checking ? 'Reading the quote, the market, your wallet and your loans.'
      : readiness?.status === 'ready' ? `All checks pass for this ${action.kind === 'borrow-more' ? 'borrow more' : 'borrow'}.${readiness.warnings > 0 ? ` ${readiness.warnings} warning${readiness.warnings === 1 ? '' : 's'}.` : ''}`
        : readiness?.reason ?? ''
  return (
    <div className="space-y-4" data-borrow-readiness={checking ? 'checking' : readiness ? readiness.status : 'idle'}>
      <section>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <SubHeading>Result of the checks</SubHeading>
          {chip && <span className={`rounded-lg border px-2 py-0.5 text-[11px] font-semibold leading-4 ${chip.className}`} data-readiness-status>{chip.label}</span>}
        </div>
        <p className="text-[11px] leading-5 text-slate-700" data-readiness-reason>{reason}</p>
        <p className="mt-1 text-[11px] leading-4 text-slate-500">Preview only: real transactions are switched off in this release, whatever the result.</p>
      </section>

      <section data-borrow-wallet-compat={walletView ? walletView.state : 'no-wallet'}>
        <SubHeading>Wallet</SubHeading>
        <dl className={detailRows}>
          <DetailRow label="Atomic transactions (EIP-5792)">
            <span className={`font-semibold ${walletView ? WALLET_TONE[walletView.tone] : 'text-slate-500'}`} data-wallet-compat-label>{walletView ? walletView.label : 'No wallet connected'}</span>
            {walletView && walletView.tone === 'bad' && walletView.state !== 'wrong-network' && <span className="text-slate-500"> (not suitable for Borrow)</span>}
          </DetailRow>
          <DetailRow label="Wallet network (chain ID)">{walletChainId === null ? 'Not connected' : walletChainId} <span className="text-slate-400">Arc Mainnet required: {MAINNET_BORROW_CHAIN_ID}</span></DetailRow>
          <DetailRow label="Borrow Adapter"><span className="font-mono">{MAINNET_BORROW_ADAPTER_CONTRACT}</span></DetailRow>
        </dl>
        {walletView?.summary && (
          <p className="mt-1 text-[11px] leading-4 text-slate-500" data-borrow-wallet-details>
            Machina asked your wallet one read-only question, <span className="font-mono">wallet_getCapabilities</span> for Arc ({`0x${MAINNET_BORROW_CHAIN_ID.toString(16)}`}); it never asks for a signature or approval. {walletView.summary}
          </p>
        )}
      </section>

      {historyNote && <div data-borrow-history-note><Notice tone="warn">{historyNote}</Notice></div>}

      <section>
        <SubHeading>Data used for these checks</SubHeading>
        <dl className={detailRows} data-borrow-evidence-ages>
          {evidenceAges.map((item) => (
            <DetailRow key={item.label} label={item.label}>
              {item.age === null ? 'Not read' : item.age.expired
                ? <span className="font-semibold text-amber-700" data-evidence-expired>{item.age.seconds} s old · expired (limit {MAINNET_BORROW_MAX_EVIDENCE_AGE_MS / 1000} s)</span>
                : `${item.age.seconds} s old`}
            </DetailRow>
          ))}
        </dl>
      </section>

      {groups.map((group) => (
        <section key={group.id} data-readiness-group={group.id}>
          <SubHeading>
            {group.title}
            <span className="ml-2 font-normal text-slate-400">
              {[group.blocked > 0 ? `${group.blocked} blocked` : null, group.unavailable > 0 ? `${group.unavailable} unavailable` : null,
                group.warnings > 0 ? `${group.warnings} warning${group.warnings === 1 ? '' : 's'}` : null, group.passed > 0 ? `${group.passed} passed` : null].filter(Boolean).join(' · ')}
            </span>
          </SubHeading>
          <ul className="space-y-1.5">
            {group.checks.map((check) => {
              const style = CHECK_STYLE[check.status]
              return (
                <li key={check.id} data-readiness-check={check.id} data-readiness-check-status={check.status} className="flex items-start gap-2 text-[11px] leading-5 text-slate-700">
                  <style.icon size={13} className={`mt-0.5 shrink-0 ${style.className}`} />
                  <span className="min-w-0 [overflow-wrap:anywhere]"><span className={`font-semibold ${style.className}`}>{style.label}.</span> {check.text}</span>
                </li>
              )
            })}
          </ul>
        </section>
      ))}

      {plan && !checking && <p className="text-[11px] leading-4 text-slate-500">{requestsSentence(plan.walletRequests)}</p>}
      <button type="button" onClick={onRefreshQuote} className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-2.5 py-1 text-[11px] font-semibold text-slate-600 hover:bg-slate-50">
        <RefreshCw size={11} />
        Read again
      </button>
    </div>
  )
}

function AdvancedDetails({ model, inputs, markets, verifications, selectedId, borrowAmount, walletChainId, positions, onRefreshQuote }: {
  model: BorrowModel
  inputs: QuoteInputs
  markets: BorrowMarket[]
  verifications: Record<string, MarketVerification>
  selectedId: string | null
  borrowAmount: string | null
  walletChainId: number | null
  positions: Positions
  onRefreshQuote: () => void
}) {
  return (
    <Disclosure id="advanced" level="outer" title="Advanced details" hint="Market evidence, quote terms and every transaction check">
      <div className="space-y-2.5" data-borrow-section="advanced">
        <Disclosure id="market-details" title="Market details" hint="Market ID, oracle, rate model, on-chain verification, LLTV, liquidity, utilization">
          <p className="mb-3 text-[11px] leading-4 text-slate-500">
            Terms come from Circle Borrow Kit and can be up to five minutes old. Each market is also checked against Morpho on Arc; a market that
            cannot be checked is never shown as verified. Markets are listed by ID and are not ranked.
          </p>
          {markets.length === 0 && <p className="text-[11px] text-slate-500">No market is loaded.</p>}
          <div className="space-y-3 divide-y divide-slate-200 [&>*:not(:first-child)]:pt-3">
            {markets.map((market) => (
              <MarketDetailsBlock key={market.marketId} market={market} verification={verifications[market.marketId.toLowerCase()]} borrowAmount={borrowAmount} selected={market.marketId === selectedId} />
            ))}
          </div>
        </Disclosure>
        <Disclosure id="quote-details" title="Quote details" hint="Circle Borrow Kit quote, Health Factor check, fees and gas, optional comparison">
          <QuoteDetails model={model} inputs={inputs} onRefreshQuote={onRefreshQuote} />
        </Disclosure>
        <Disclosure id="wallet-checks" title="Wallet and transaction checks" hint="Wallet capability, every Pass, Warning, Blocked and Unavailable result">
          <ChecksDetails model={model} walletChainId={walletChainId} onRefreshQuote={onRefreshQuote} />
        </Disclosure>
        <Disclosure id="loan-details" title="Loan details" hint="Collateral, debt, interest, LTV and Health Factor for each loan">
          <LoanDetails walletAddress={model.walletAddress} positions={positions} markets={markets} />
        </Disclosure>
      </div>
    </Disclosure>
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
  // Where the attempt history is saved. Production passes none (browser storage); null means there is no storage.
  attemptStorage?: StorageLike | null
}

export function BorrowWorkspace({ walletAddress, walletChainId = null, requestWallet, client, loadMarkets, verifyMarket, readBalances, attemptStorage }: BorrowWorkspaceProps) {
  const [refresh, setRefresh] = useState(0)
  // "Refresh quote": reads the quote and everything it depends on again (read only). It never touches what was typed.
  const [quoteTick, setQuoteTick] = useState(0)
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

  const epoch = `${refresh}.${quoteTick}`
  const wallet = useWalletState(walletAddress, walletChainId, requestWallet)
  const positions = usePositions(walletAddress, client, epoch)
  // The record of writes started from this browser for this wallet on Arc, saved across reloads. The same ledger is what a future
  // write would register in, so what is shown here is what would stop it.
  const attemptLedger = useMemo(
    () => (walletAddress ? createPersistentAttemptLedger(attemptStorage === undefined ? browserAttemptStorage() : attemptStorage, walletAddress, MAINNET_BORROW_CHAIN_ID) : null),
    [walletAddress, attemptStorage],
  )

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
  const refreshQuote = useCallback(() => setQuoteTick((value) => value + 1), [])
  const inputs: QuoteInputs = { collateralText, borrowText, targetHealthFactor, setCollateralText, setBorrowText, setTargetHealthFactor }
  const borrowAmount = parsePositiveAmount(borrowText)
  const model = useBorrowModel({
    market: selected, verification: selected ? verifications[selected.marketId.toLowerCase()] : undefined, walletAddress, wallet, attemptLedger,
    positions, client, verifyMarket, readBalances, epoch, inputs,
  })

  return (
    <Container className="py-6">
      <BorrowHeader loading={marketsState.status === 'loading'} onRefresh={bump} />
      <div className="mt-4 space-y-4">
        <RiskLine />
        <MarketsSection state={marketsState} verifications={verifications} borrowAmount={borrowAmount} selectedId={selectedId} onSelect={setSelectedId} onReload={bump} />
        <CurrentLoan walletAddress={walletAddress} positions={positions} markets={markets} bump={bump} />
        <NewBorrow model={model} inputs={inputs} onRefreshQuote={refreshQuote} />
        <BorrowOperations wallet={walletAddress ? wallet.state : null} market={selected}
          positions={positions.first.status === 'available' ? [...positions.first.data.items, ...positions.extra] : []}
          attempts={attemptLedger} requestWallet={requestWallet} client={client} verifyMarket={verifyMarket} readBalances={readBalances} onVerified={bump} />
        <AdvancedDetails model={model} inputs={inputs} markets={markets} verifications={verifications} selectedId={selectedId} borrowAmount={borrowAmount}
          walletChainId={walletChainId} positions={positions} onRefreshQuote={refreshQuote} />
      </div>

      <p className="mt-5 text-[11px] leading-5 text-slate-500">
        Borrow markets are operated by third-party protocols (Morpho) and read through Circle Borrow Kit. Quotes are estimates and can change before
        any action. Every check Machina runs is listed under Advanced details. Machina does not take custody of your funds.
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
