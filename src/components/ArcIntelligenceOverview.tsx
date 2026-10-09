import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import {
  Activity, AlertCircle, ArrowDown, ArrowDownLeft, ArrowLeftRight, ArrowRight, ArrowUpRight, Banknote, Building2, Clock, Coins,
  Droplets, Landmark, Layers, Radar, RefreshCw, Rocket, Search, Store,
} from 'lucide-react'
import {
  ARC_INTELLIGENCE_BACKEND_WINDOWS,
  ARC_INTELLIGENCE_WINDOWS,
  type ArcIntelligenceWindow,
} from '../config/arcIntelligenceUiScope'
import { MAINNET_BORROW_WRITES_ENABLED } from '../config/mainnetBorrow'
import {
  ARC_KNOWN_TOKENS,
  formatCompact,
  formatCompactRaw,
  formatCount,
  formatDecimal,
  formatDecimalString,
  formatRatioPercent,
  formatSignedPercent,
  formatTokenAmount,
  formatUsdCompact,
  formatUsdMicros,
  formatUtcDateTime,
  formatUtcDay,
  formatUtcHour,
  formatUtcPeriodRange,
  isFiniteNumber,
  loadArcBorrowMarkets,
  loadArcIntelligence,
  metricAmount,
  metricNumber,
  metricSum,
  percentChange,
  shortenAddress,
  shortenHash,
  shortenMarketId,
  usdMicrosToNumber,
  usdVolumeStatus,
  V4_SWAP_TO_BLOCKER,
  V4_SWAP_TO_TEXT,
  verifiedAssetItems,
  windowStatus,
  type ArcActivity,
  type ArcActivityRow,
  type ArcActivityType,
  type ArcIntelligenceLoad,
  type ArcPools,
  type BorrowMarketState,
  type ArcSummary,
  type ArcTimeseries,
  type FamilyWindow,
  type IntelligenceDataStatus,
  type PoolToken,
  type ProtocolUsd,
  type SwapFeesWindow,
  type UsdVolumeWindow,
} from '../lib/arcIntelligence'

// Arc Intelligence section of the Mainnet Dashboard. Every capability of src/config/arcIntelligenceUiScope.ts has a
// permanent place here, marked with data-intel-section / data-intel-item. Missing data keeps its place and shows a calm
// status; it is never drawn as zero, replaced by another window, or filled with an estimate.

type DisplayStatus = IntelligenceDataStatus | 'loading'
// ready: the selected window loaded. history: a window the API has no history for yet (never requested).
type Mode = 'loading' | 'ready' | 'history' | 'failed'

type ViewContext = {
  mode: Mode
  windowLabel: string
  // 24H charts are hourly; 7D and 30D charts show complete UTC days, from midnight to midnight.
  period: 'hour' | 'day'
  // hours the selected window covers once complete (24, 168 or 720)
  windowHours: number
  historyNote: string
  summary: ArcSummary | null
  timeseries: ArcTimeseries | null
  collectingNote: string
  // Pools of the selected window and recent activity (null when a read failed or the view is not ready)
  pools: { v3: ArcPools | null; v4: ArcPools | null } | null
  activity: Partial<Record<ArcActivityType, ArcActivity | null>> | null
  // Arc explorer base URL for transaction links, passed in by the page; without it a hash is shown as text
  explorerUrl: string | null
}

type Cell = { status: DisplayStatus; raw?: string | number; text?: string; note?: string; title?: string }

const STATUS_TEXT: Record<DisplayStatus, string> = {
  available: 'Available',
  collecting: 'Collecting',
  unavailable: 'Unavailable',
  source_pending: 'Not available yet',
  loading: 'Loading',
}

const PILL_CLASS: Record<DisplayStatus, string> = {
  available: 'border-[#d5e9c7] bg-[#eef7e8] text-[#2F6E0C]',
  collecting: 'border-[#d5e9c7] bg-[#eef7e8] text-[#2F6E0C]',
  unavailable: 'border-amber-200 bg-amber-50 text-amber-700',
  source_pending: 'border-slate-200 bg-slate-50 text-slate-500',
  loading: 'border-slate-200 bg-slate-50 text-slate-400 animate-pulse',
}

const V3_BAR = 'bg-[#2F6E0C]'
const V4_BAR = 'bg-[#9CCB7F]'
const ADDRESS_BAR = 'bg-[#4C8F25]'

const AAVE_ACTIONS = ['supplyCount', 'withdrawCount', 'borrowCount', 'repayCount', 'liquidationCount'] as const
const MORPHO_BLUE_ACTIONS = ['supplyCount', 'withdrawCount', 'borrowCount', 'repayCount', 'supplyCollateralCount',
  'withdrawCollateralCount', 'liquidationCount'] as const
const MORPHO_VAULT_ACTIONS = ['depositCount', 'withdrawCount'] as const

function markerProps(item: string, status: DisplayStatus, value?: string | number | null): Record<string, string> {
  return {
    'data-intel-item': item,
    'data-intel-status': status,
    ...(status === 'available' && value !== undefined && value !== null ? { 'data-intel-value': String(value) } : {}),
  }
}

function liveStatus(ctx: ViewContext, entry: { status: string; reason?: string } | null | undefined): DisplayStatus {
  if (ctx.mode === 'loading') return 'loading'
  if (ctx.mode === 'history') return 'collecting'
  if (ctx.mode === 'failed') return 'unavailable'
  return windowStatus(entry)
}

function noteFor(ctx: ViewContext, status: DisplayStatus, pendingNote = 'Not available yet'): string | undefined {
  if (status === 'loading') return 'Loading verified data'
  if (status === 'collecting') return ctx.collectingNote
  if (status === 'unavailable') return ctx.mode === 'failed' ? 'Could not be loaded right now' : 'Not verified for this window'
  if (status === 'source_pending') return pendingNote
  return undefined
}

// Plain words for every reason a value is not shown. A reason never becomes a number, and an unknown one reads as not verified.
const REASON_TEXT: Record<string, string> = {
  insufficient_coverage: 'History is still being collected.',
  valuation_not_ready: 'USD valuation rows are missing from this snapshot.',
  valuation_not_processed: 'Some hours of this window are not valued yet.',
  valuation_hour_unavailable: 'Some hours of this window have no verified USD value.',
  prices_unavailable: 'No verified price for a token in some hour of this window.',
  no_verified_price: 'No verified price',
  fee_inputs_unavailable: 'Fee details of some swaps are missing.',
  family_hour_unavailable: 'Some hours of this window are not verified.',
  family_not_processed: 'Some hours of this window are not verified yet.',
  unverified_token: 'Includes a token that is not a verified Arc asset, so it has no USD value.',
  decimals_mismatch: 'Token units do not match the verified asset, so no USD value is given.',
  tvl_not_collected: 'Pool holdings have not been read yet. They are read every hour for the top pools.',
  tvl_not_collected_for_pool: 'Holdings are read for the top pools of the latest hour only.',
  hook_may_hold_pool_value: 'This pool\'s hook may hold part of its value, so its holdings are not stated.',
  tvl_scan_unbounded: 'This pool has too many price ranges to read its holdings exactly.',
  tvl_state_inconsistent: 'Pool holdings could not be read consistently.',
  tick_out_of_range: 'Pool holdings could not be read consistently.',
  balance_unreadable: 'A token balance of this pool could not be read.',
  pool_not_initialized: 'This pool has no price yet.',
  identity_retention_exceeded: 'Unique addresses are counted within 24H only. Longer windows would count the same address more than once.',
}
const reasonText = (reason: string | null | undefined, fallback = 'Not verified for this window.') => (reason && REASON_TEXT[reason]) || fallback

// The first reason that explains an unavailable entry: a specific hour reason before the generic window reason.
const firstReason = (entry: { reason?: string | null; reasons?: string[] } | null | undefined) =>
  entry?.reasons?.find((reason) => reason in REASON_TEXT) ?? entry?.reason ?? null

// "History is still being collected (52 of 168 hours so far)." while a long window fills.
function collectingText(ctx: ViewContext): string {
  const stored = ctx.summary ? Math.min(ctx.summary.coverage.storedHours, ctx.windowHours) : 0
  return stored > 0 && stored < ctx.windowHours ? `History is still being collected (${stored} of ${ctx.windowHours} hours so far).`
    : 'History is still being collected.'
}

function numberCell(ctx: ViewContext, entry: { status: string; reason?: string } | null | undefined, value: number | null,
  format: (value: number) => string): Cell {
  const status = liveStatus(ctx, entry)
  if (status === 'available' && value !== null) return { status, raw: value, text: format(value) }
  const shown = status === 'available' ? 'unavailable' : status
  return { status: shown, note: noteFor(ctx, shown) }
}

const tokenName = (address: string, symbol?: string | null) =>
  symbol ?? ARC_KNOWN_TOKENS[address.toLowerCase()]?.symbol ?? shortenAddress(address)

function objectEntries(value: unknown): [string, Record<string, unknown>][] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return []
  return Object.entries(value as Record<string, unknown>)
    .filter((entry): entry is [string, Record<string, unknown>] => Boolean(entry[1]) && typeof entry[1] === 'object')
}

// Per-token amounts of one family, summed per token in that token's own units (never across tokens, never in USD).
type TokenFlow = { token: string; label: string; verified: boolean; decimals: number | null; amounts: bigint[] }

function tokenFlows(rows: { token: unknown; symbol?: unknown; decimals: unknown; amounts: unknown[] }[]): TokenFlow[] {
  const flows = new Map<string, TokenFlow>()
  for (const row of rows) {
    if (typeof row.token !== 'string') continue
    const values = row.amounts.map((amount) => (typeof amount === 'string' && /^\d+$/.test(amount) ? BigInt(amount) : null))
    if (values.some((amount) => amount === null)) continue
    const key = row.token.toLowerCase()
    const decimals = isFiniteNumber(row.decimals) ? row.decimals : null
    const symbol = typeof row.symbol === 'string' ? row.symbol : null
    const flow = flows.get(key) ?? { token: key, label: tokenName(key, symbol), verified: Boolean(symbol ?? ARC_KNOWN_TOKENS[key]),
      decimals, amounts: values.map(() => 0n) }
    if (flow.decimals !== decimals) flow.decimals = null
    flow.amounts = flow.amounts.map((amount, index) => amount + (values[index] as bigint))
    flows.set(key, flow)
  }
  return [...flows.values()].sort((a, b) => Number(b.verified) - Number(a.verified) || a.label.localeCompare(b.label))
}

// Tokens with 8 or more decimals (cirBTC, WETH) carry meaningful value below 0.01, so they show four decimals.
const shownDigits = (decimals: number) => (decimals >= 8 ? 4 : 2)
const formatAmount = (raw: string, decimals: number) => formatTokenAmount(raw, decimals, shownDigits(decimals))

function formatFlowAmount(flow: TokenFlow, index: number): string | null {
  return flow.decimals === null ? null : formatAmount(flow.amounts[index].toString(10), flow.decimals)
}

// ---------------------------------------------------------------------------------------------------------------------
// Small building blocks

function StatusPill({ status }: { status: DisplayStatus }) {
  return (
    <span data-status-pill="" className={`inline-flex shrink-0 items-center whitespace-nowrap rounded-full border px-2.5 py-0.5 text-[11px] font-semibold ${PILL_CLASS[status]}`}>
      {STATUS_TEXT[status]}
    </span>
  )
}

function TabButton({ selected, onClick, children, disabled, marker }: {
  selected: boolean
  onClick?: () => void
  children: ReactNode
  disabled?: boolean
  marker?: Record<string, string>
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={selected}
      disabled={disabled}
      onClick={onClick}
      {...marker}
      className={`rounded-lg border px-3 py-1.5 text-xs font-semibold transition-colors disabled:cursor-not-allowed ${
        selected
          ? 'border-[#2F6E0C] bg-[#2F6E0C] text-white shadow-sm'
          : 'border-slate-300 bg-white text-slate-600 hover:bg-slate-50'
      }`}
    >
      {children}
    </button>
  )
}

function GroupHeader({ title, icon: Icon }: { title: string; icon?: typeof Activity }) {
  return (
    <div className="flex items-center gap-2 pt-2">
      {Icon && <Icon aria-hidden="true" className="h-3.5 w-3.5 text-[#2F6E0C]" />}
      <h3 className="text-xs font-semibold uppercase tracking-[0.18em] text-[#2F6E0C]">{title}</h3>
      <div className="h-px flex-1 bg-[#dfead8]" />
    </div>
  )
}

function CardTitle({ title, subtitle, right }: { title: string; subtitle?: string; right?: ReactNode }) {
  return (
    <div>
      <div className="flex items-start justify-between gap-3">
        <h4 className="min-w-0 text-base font-semibold text-slate-950">{title}</h4>
        {right && <div className="shrink-0">{right}</div>}
      </div>
      {subtitle && <p className="mt-0.5 text-xs leading-5 text-slate-500">{subtitle}</p>}
    </div>
  )
}

const CARD = 'rounded-2xl border border-slate-200 bg-white p-4 shadow-sm sm:p-5'

function Banner({ tone, children }: { tone: 'info' | 'warn'; children: ReactNode }) {
  const style = tone === 'warn' ? 'border-amber-200 bg-amber-50 text-amber-800' : 'border-[#d5e9c7] bg-[#eef7e8] text-[#25580A]'
  const Icon = tone === 'warn' ? AlertCircle : Clock
  return (
    <div className={`flex items-start gap-2 rounded-xl border px-3 py-2.5 text-sm ${style}`}>
      <Icon className="mt-0.5 h-4 w-4 shrink-0" />
      <p className="leading-6">{children}</p>
    </div>
  )
}

// A permanent slot whose verified data is not available: keeps its place, never shows a number.
function EmptyState({ status, title, detail, className = '' }: { status: DisplayStatus; title: string; detail?: string; className?: string }) {
  return (
    <div className={`rounded-xl border border-dashed border-slate-200 bg-[#f8faf7] px-4 py-5 text-center ${className}`}>
      <StatusPill status={status} />
      <p className="mt-2 text-sm font-medium text-slate-700">{title}</p>
      {detail && <p className="mx-auto mt-1 max-w-md text-xs leading-5 text-slate-500">{detail}</p>}
    </div>
  )
}

// ---------------------------------------------------------------------------------------------------------------------
// Chart: hourly (24H) or daily (7D, 30D) bars with axes, UTC labels, honest gaps and a hover or tap tooltip.

// note: why a gap has no value (a day still filling says how many of its hours are stored)
type ChartPoint = { start: string; end: string; values: number[] | null; note?: string }
type ChartSeries = { name: string; barClass: string }

function niceMax(value: number): number {
  if (value <= 0) return 1
  const magnitude = 10 ** Math.floor(Math.log10(value))
  for (const step of [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]) if (step * magnitude >= value) return step * magnitude
  return 10 * magnitude
}

const pointTotal = (point: ChartPoint) => (point.values ? point.values.reduce((sum, value) => sum + value, 0) : null)

const withUnit = (text: string, unit: string) => (unit ? `${text} ${unit}` : text)

// format: how one bar value reads (counts by default; USD charts pass a dollar format and no unit).
function BarChart({ points, series, unit, period = 'hour', format = formatCount, axisFormat = formatCompact }: { points: ChartPoint[]; series: ChartSeries[];
  unit: string; period?: 'hour' | 'day'; format?: (value: number) => string; axisFormat?: (value: number) => string }) {
  const [active, setActive] = useState<number | null>(null)
  const totals = points.map(pointTotal)
  const max = niceMax(Math.max(0, ...totals.filter((total): total is number => total !== null)))
  const count = points.length
  const labelEvery = period === 'day' ? (count > 12 ? 5 : 1) : count > 12 ? 6 : 2
  const range = (point: ChartPoint) => formatUtcPeriodRange(point.start, point.end, period)
  const activePoint = active === null ? null : points[active]
  const activeShare = active === null ? 0 : (active + 0.5) / count
  const shift = activeShare < 0.2 ? '-10%' : activeShare > 0.8 ? '-90%' : '-50%'

  return (
    <div className="mt-4" onMouseLeave={() => setActive(null)}>
      <div className="relative h-44 sm:h-52">
        {[1, 0.5, 0].map((fraction) => (
          <div key={fraction} className="absolute inset-x-0 flex items-center gap-2" style={{ bottom: `${fraction * 100}%`, transform: 'translateY(50%)' }}>
            <span className="w-9 shrink-0 text-right text-[10px] tabular-nums text-slate-400">{axisFormat(max * fraction)}</span>
            <span className="h-px flex-1 bg-slate-100" />
          </div>
        ))}
        <div className="absolute inset-y-0 left-11 right-0 flex items-end gap-[2px]">
          {points.map((point, index) => {
            const total = totals[index]
            const label = point.values && total !== null
              ? `${range(point)}: ${withUnit(format(total), unit)}`
              : `${range(point)}: ${point.note ?? 'no verified data'}`
            return (
              <button key={point.start} type="button" aria-label={label} onMouseEnter={() => setActive(index)}
                onFocus={() => setActive(index)} onClick={() => setActive(index)}
                className="relative flex h-full min-w-0 flex-1 flex-col justify-end rounded-t-[3px] focus:outline-none focus-visible:ring-2 focus-visible:ring-[#66D121]/40">
                {point.values && total !== null ? (
                  <span className={`flex w-full flex-col-reverse overflow-hidden rounded-t-[3px] ${active === index ? 'opacity-100' : 'opacity-85'}`}
                    style={{ height: `${(total / max) * 100}%` }}>
                    {point.values.map((value, seriesIndex) => (
                      <span key={series[seriesIndex]?.name ?? seriesIndex} className={`block w-full ${series[seriesIndex]?.barClass ?? V3_BAR}`}
                        style={{ height: total > 0 ? `${(value / total) * 100}%` : '0%' }} />
                    ))}
                  </span>
                ) : (
                  <span className="block h-full w-full rounded-t-[3px]"
                    style={{ backgroundImage: 'repeating-linear-gradient(135deg, #f1f5f9 0, #f1f5f9 3px, transparent 3px, transparent 6px)' }} />
                )}
              </button>
            )
          })}
        </div>
        {activePoint && (
          <div className="pointer-events-none absolute top-0 z-10 w-max max-w-[240px] rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs shadow-lg"
            style={{ left: `calc(2.75rem + (100% - 2.75rem) * ${activeShare})`, transform: `translateX(${shift})` }}>
            <p className="font-semibold text-slate-900">{range(activePoint)}</p>
            {activePoint.values ? (
              <div className="mt-1 space-y-0.5">
                {series.length > 1 && activePoint.values.map((value, index) => (
                  <p key={series[index]?.name ?? index} className="flex items-center gap-1.5 text-slate-600">
                    <span className={`h-2 w-2 rounded-sm ${series[index]?.barClass ?? V3_BAR}`} />
                    {series[index]?.name}: <span className="font-semibold tabular-nums text-slate-900">{format(value)}</span>
                  </p>
                ))}
                <p className="text-slate-600">
                  {series.length > 1 ? 'Total' : series[0]?.name}: <span className="font-semibold tabular-nums text-slate-900">{format(totals[active ?? 0] ?? 0)}</span>{unit && ` ${unit}`}
                </p>
              </div>
            ) : (
              <p className="mt-1 text-slate-500">{activePoint.note ?? `No verified data for this ${period} yet`}</p>
            )}
          </div>
        )}
      </div>
      <div className="ml-11 mt-1.5 flex gap-[2px]">
        {points.map((point, index) => (
          <span key={point.start} className="relative h-4 min-w-0 flex-1">
            {index % labelEvery === 0 && (
              <span className="absolute left-0 whitespace-nowrap text-[10px] tabular-nums text-slate-400">
                {period === 'day' ? formatUtcDay(point.start) : formatUtcHour(point.start)}
              </span>
            )}
          </span>
        ))}
      </div>
      <p className="mt-1 text-right text-[10px] text-slate-400">
        {period === 'day' ? 'Days in UTC, each from midnight to midnight' : 'Hours in UTC'}
      </p>
    </div>
  )
}

// Latest complete hour (chronologically last verified hour) and peak hour, labeled separately.
function HourReadout({ item, status, points, unit, period = 'hour', format = formatCount, note }: { item: string; status: DisplayStatus; points: ChartPoint[];
  unit: string; period?: 'hour' | 'day'; format?: (value: number) => string; note?: string }) {
  const verified = points.filter((point) => point.values)
  const latest = verified[verified.length - 1] ?? null
  const peak = verified.reduce<ChartPoint | null>((best, point) => (best === null || (pointTotal(point) ?? 0) > (pointTotal(best) ?? 0) ? point : best), null)
  const shown: DisplayStatus = status === 'available' && !latest ? 'collecting' : status
  const tiles = [{ label: `Latest complete ${period}`, point: latest }, { label: `Peak ${period} in window`, point: peak }]
  return (
    <div {...markerProps(item, shown, latest ? pointTotal(latest) : null)} className="mt-3 grid grid-cols-2 gap-2">
      {tiles.map(({ label, point }) => (
        <div key={label} className="min-w-0 rounded-xl bg-[#f8faf7] px-3 py-2">
          <p className="text-[11px] text-slate-500">{label}</p>
          {shown === 'available' && point ? (
            <>
              <p className="text-sm font-semibold tabular-nums text-slate-950">
                {format(pointTotal(point) ?? 0)}{unit && <span className="font-normal text-slate-500"> {unit}</span>}
              </p>
              <p className="text-[11px] text-slate-400">{formatUtcPeriodRange(point.start, point.end, period)}</p>
            </>
          ) : status === 'loading' ? (
            <div className="mt-1.5"><span aria-hidden="true" className="inline-block h-3 w-16 rounded bg-slate-100 align-middle" /></div>
          ) : (
            <p className="mt-0.5 text-[11px] leading-4 text-slate-500">{note ?? STATUS_TEXT[shown]}</p>
          )}
        </div>
      ))}
    </div>
  )
}

function chartStatus(ctx: ViewContext, points: ChartPoint[] | null): DisplayStatus {
  if (ctx.mode !== 'ready') return liveStatus(ctx, null)
  if (!points) return 'unavailable'
  return points.some((point) => point.values) ? 'available' : 'collecting'
}

// Why one hour or day of the USD chart has no value.
const GAP_TEXT: Record<string, string> = { valuation_not_processed: 'not valued yet', valuation_not_ready: 'not valued yet',
  prices_unavailable: 'no verified price', fee_inputs_unavailable: 'no verified data' }

// A day still filling says how many of its hours are stored; it is a gap, never a partial total.
const bucketNote = (bucket: ArcTimeseries['buckets'][number]) => (bucket.status === 'incomplete' && isFiniteNumber(bucket.storedHours)
  ? `${bucket.storedHours} of 24 hours stored so far` : undefined)

function swapPoints(timeseries: ArcTimeseries | null): ChartPoint[] | null {
  if (!timeseries) return null
  return timeseries.buckets.map((bucket) => {
    const v3 = bucket.status === 'committed' ? bucket.families?.uniswapV3 : undefined
    const v4 = bucket.status === 'committed' ? bucket.families?.uniswapV4 : undefined
    const complete = v3?.status === 'available' && v4?.status === 'available' && isFiniteNumber(v3.swapCount) && isFiniteNumber(v4.swapCount)
    return { start: bucket.start, end: bucket.end, values: complete ? [v3.swapCount as number, v4.swapCount as number] : null, note: bucketNote(bucket) }
  })
}

// Hourly DEX USD volume [V3, V4] in dollars. null when the API predates USD valuation (no bucket carries it).
function usdPoints(timeseries: ArcTimeseries | null): ChartPoint[] | null {
  if (!timeseries || !timeseries.buckets.some((bucket) => bucket.dexUsdVolume !== undefined)) return null
  return timeseries.buckets.map((bucket) => {
    const hour = bucket.status === 'committed' ? bucket.dexUsdVolume : null
    const v3 = hour?.status === 'available' ? usdMicrosToNumber(hour.uniswapV3UsdMicros) : null
    const v4 = hour?.status === 'available' ? usdMicrosToNumber(hour.uniswapV4UsdMicros) : null
    return { start: bucket.start, end: bucket.end, values: v3 !== null && v4 !== null ? [v3, v4] : null,
      note: bucketNote(bucket) ?? (hour?.status === 'unavailable' ? GAP_TEXT[hour.reason ?? ''] : undefined) }
  })
}

// Display state of the hourly USD chart: not available yet before the API values swaps; collecting while no hour is
// valued yet and every gap is an hour still waiting for its valuation.
function usdChartStatus(ctx: ViewContext, points: ChartPoint[] | null): DisplayStatus {
  if (ctx.mode !== 'ready') return liveStatus(ctx, null)
  if (!ctx.timeseries) return 'unavailable'
  if (!points) return 'source_pending'
  if (points.some((point) => point.values)) return 'available'
  const reasons = ctx.timeseries.buckets.map((bucket) => (bucket.status === 'committed' ? bucket.dexUsdVolume?.reason : 'not_stored'))
  return reasons.every((reason) => reason === 'valuation_not_processed' || reason === 'not_stored') ? 'collecting' : 'unavailable'
}

const unvaluedSwapsIn = (timeseries: ArcTimeseries | null) => (timeseries?.buckets ?? []).reduce((total, bucket) => {
  const hour = bucket.status === 'committed' ? bucket.dexUsdVolume : null
  return total + (hour?.status === 'available' && isFiniteNumber(hour.unvaluedSwaps) ? hour.unvaluedSwaps : 0)
}, 0)

// The reason the USD chart has no valued hour: the first stored hour's own reason, in plain words.
function usdGapReason(timeseries: ArcTimeseries | null): string {
  const reason = timeseries?.buckets.find((bucket) => bucket.status === 'committed' && bucket.dexUsdVolume?.status === 'unavailable')?.dexUsdVolume?.reason
  return reasonText(reason, 'No hour of this window has a verified USD value.')
}

const usdText = (value: number) => formatUsdCompact(value)

function addressPoints(timeseries: ArcTimeseries | null): ChartPoint[] | null {
  if (!timeseries) return null
  return timeseries.buckets.map((bucket) => {
    const daily = timeseries.bucketHours === 24
    const verified = !daily || bucket.network?.uniqueActiveAddressesStatus?.status === 'available'
    const value = bucket.status === 'committed' && verified ? bucket.network?.uniqueActiveAddresses : undefined
    return { start: bucket.start, end: bucket.end, values: isFiniteNumber(value) ? [value] : null,
      note: bucketNote(bucket) ?? (daily && !verified ? 'No stored verified daily distinct count' : undefined) }
  })
}

// ---------------------------------------------------------------------------------------------------------------------
// Sections

function KpiCard({ item, label, caption, cell, delta, windowLabel }: {
  item: string
  label: string
  caption: string
  cell: Cell
  delta?: number | null
  windowLabel: string
}) {
  return (
    <div {...markerProps(item, cell.status, cell.raw)} className="min-w-0 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
      <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-400">{label}</p>
      {cell.status === 'available'
        ? <p className="mt-2 truncate text-2xl font-bold tracking-tight text-slate-950 tabular-nums sm:text-3xl" title={cell.title}>{cell.text}</p>
        : <div className="mt-3"><StatusPill status={cell.status} /></div>}
      <p className="mt-2 text-xs leading-5 text-slate-500">{cell.status === 'available' ? caption : cell.note}</p>
      {cell.status === 'available' && delta !== null && delta !== undefined && (
        <p className={`mt-1 text-xs font-semibold ${delta >= 0 ? 'text-[#2F6E0C]' : 'text-rose-600'}`}>
          {formatSignedPercent(delta)} <span className="font-normal text-slate-500">vs previous {windowLabel}</span>
        </p>
      )}
    </div>
  )
}

const DEX_VOLUME_SCOPE = 'USD-valued Uniswap V3 and V4 swaps on Arc.'

// Note of a USD entry that is not shown: the window still filling, hours not valued yet, or the exact reason.
function usdNote(ctx: ViewContext, status: DisplayStatus, entry: { reason?: string | null; reasons?: string[]; unavailableHours?: string[] } | null | undefined, pending: string): string | undefined {
  if (status === 'source_pending') return pending
  if ((status === 'collecting' || status === 'unavailable') && ctx.mode === 'ready') {
    const reason = entry?.reason === 'insufficient_coverage' ? collectingText(ctx) : reasonText(firstReason(entry))
    const missing = entry?.unavailableHours?.length ?? 0
    const backfillCutoff = Date.parse(ctx.summary?.window.end ?? '') - 72 * 3_600_000
    const olderMissing = entry?.unavailableHours?.some((hour) => Date.parse(hour) < backfillCutoff) ?? false
    const backfillLimit = ctx.windowHours > 72 && olderMissing
      ? ' The historical valuation backfill covers the latest 72 hours at most; older missing hours require additional verified history.' : ''
    return `${reason}${missing > 0 ? ' Some hourly valuations are missing in this window.' : ''}${backfillLimit}`
  }
  return noteFor(ctx, status)
}

// Total DEX USD volume of the window. An API without USD valuation reads as not available yet; a window whose hours are
// not all valued yet is collecting; anything else missing is unavailable with its reason. Never a number without its source.
function usdVolumeCell(ctx: ViewContext, entry: UsdVolumeWindow | null | undefined): Cell {
  if (ctx.mode !== 'ready') {
    const status = liveStatus(ctx, null)
    return { status, note: `${DEX_VOLUME_SCOPE} ${noteFor(ctx, status) ?? ''}`.trim() }
  }
  const status = usdVolumeStatus(entry)
  const value = status === 'available' ? usdMicrosToNumber(entry?.totalUsdMicros) : null
  if (status === 'available' && value !== null && entry?.totalUsdMicros) {
    return { status, raw: entry.totalUsdMicros, text: usdText(value), title: formatUsdMicros(entry.totalUsdMicros) }
  }
  const shown: DisplayStatus = status === 'available' ? 'unavailable' : status
  return { status: shown, note: `${DEX_VOLUME_SCOPE} ${usdNote(ctx, shown, entry, 'Verified data does not include DEX USD valuations yet.')}` }
}

// Average DEX pool fee: estimated Uniswap pool fees / fee-valued swaps. This is not Arc gas. Same states as the
// volume; a window without a valued swap has no average, never a zero.
function averageFeeCell(ctx: ViewContext, entry: SwapFeesWindow | null | undefined): Cell {
  if (ctx.mode !== 'ready') {
    const status = liveStatus(ctx, null)
    return { status, note: noteFor(ctx, status) }
  }
  const status = usdVolumeStatus(entry)
  if (status === 'available' && entry?.averageFeeUsdMicros && entry.totalFeeUsdMicros) {
    const value = usdMicrosToNumber(entry.averageFeeUsdMicros)
    if (value !== null) return { status, raw: entry.averageFeeUsdMicros, text: usdText(value), title: formatUsdMicros(entry.averageFeeUsdMicros) }
  }
  if (status === 'available') return { status: 'unavailable', note: 'No valued swaps in this window, so there is no average fee.' }
  return { status, note: usdNote(ctx, status, entry, 'Verified data does not include estimated swap fees yet.') }
}

// Unique active addresses: exact within 24H; over 7D and 30D never counted, because identities are kept for one day only.
function activeAddressesCell(ctx: ViewContext): Cell {
  const uniques = ctx.summary?.network?.uniqueActiveAddresses ?? null
  if (ctx.mode === 'ready' && ctx.windowHours > 24) return { status: 'unavailable', note: reasonText('identity_retention_exceeded') }
  return numberCell(ctx, uniques, uniques && isFiniteNumber(uniques.value) ? uniques.value : null, formatCount)
}

function NetworkSection({ ctx, header }: { ctx: ViewContext; header: ReactNode }) {
  const network = ctx.summary?.network ?? null
  const active = activeAddressesCell(ctx)
  const transactions = numberCell(ctx, network, network && isFiniteNumber(network.transactions) ? network.transactions : null, formatCount)
  const previous = network?.previous
  const previousUniques = previous?.uniqueActiveAddresses
  const activeDelta = previousUniques?.status === 'available' && isFiniteNumber(previousUniques.value) && active.status === 'available'
    ? percentChange(Number(active.raw), previousUniques.value) : null
  const transactionsDelta = previous?.status === 'available' && isFiniteNumber(previous.transactions) && transactions.status === 'available'
    ? percentChange(Number(transactions.raw), previous.transactions) : null
  const blocks = numberCell(ctx, network, network && isFiniteNumber(network.blocks) ? network.blocks : null, formatCount)
  const tps = numberCell(ctx, network, network && isFiniteNumber(network.transactionsPerSecond) ? network.transactionsPerSecond : null,
    (value) => formatDecimal(value, 2))
  const gasStatus = liveStatus(ctx, network)
  const gas: Cell = gasStatus === 'available' && network?.gasUsedRaw && /^\d+$/.test(network.gasUsedRaw)
    ? { status: 'available', raw: network.gasUsedRaw, text: formatCompactRaw(network.gasUsedRaw) }
    : { status: gasStatus === 'available' ? 'unavailable' : gasStatus }
  const usdVolume = ctx.summary?.dex.usdVolume
  const volume = usdVolumeCell(ctx, usdVolume)
  const previousVolume = usdVolume?.previous?.status === 'available' ? usdMicrosToNumber(usdVolume.previous.totalUsdMicros) : null
  const volumeDelta = volume.status === 'available' ? percentChange(usdMicrosToNumber(String(volume.raw)), previousVolume) : null
  const unvalued = usdVolume?.status === 'available' && isFiniteNumber(usdVolume.unvaluedSwaps) ? usdVolume.unvaluedSwaps : 0
  const volumeCaption = `${DEX_VOLUME_SCOPE} Total, last ${ctx.windowLabel}.${unvalued > 0
    ? ` ${formatCount(unvalued)} swaps without a verified price excluded.` : ''}`
  const swapFees = ctx.summary?.dex.swapFees
  const fee = averageFeeCell(ctx, swapFees)
  const previousFee = swapFees?.previous?.status === 'available' ? usdMicrosToNumber(swapFees.previous.averageFeeUsdMicros) : null
  const feeDelta = fee.status === 'available' ? percentChange(usdMicrosToNumber(String(fee.raw)), previousFee) : null
  const feeTotal = fee.status === 'available' ? usdMicrosToNumber(swapFees?.totalFeeUsdMicros) : null
  const unvaluedFees = fee.status === 'available' && isFiniteNumber(swapFees?.unvaluedSwaps) ? swapFees.unvaluedSwaps : 0
  const feeCaption = `Estimated Uniswap V3 and V4 pool fee per fee-valued swap, last ${ctx.windowLabel}. This is not Arc gas or a network transaction fee. Does not include per step rounding or hook fees.${feeTotal !== null && isFiniteNumber(swapFees?.valuedSwaps)
    ? ` ${usdText(feeTotal)} estimated pool fees across ${formatCount(swapFees.valuedSwaps)} fee-valued swaps.` : ''}${unvaluedFees > 0
    ? ` ${formatCount(unvaluedFees)} swaps without a valued fee excluded from this fee estimate.` : ''}`

  return (
    <section data-intel-section="network" aria-label="Network Activity" className="space-y-4">
      {header}
      <GroupHeader title="Network Activity" />
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <KpiCard item="network.active-addresses" label="Active Addresses" cell={active} delta={activeDelta} windowLabel={ctx.windowLabel}
          caption={`Unique addresses, last ${ctx.windowLabel}`} />
        <KpiCard item="network.transactions" label="Transactions" cell={transactions} delta={transactionsDelta} windowLabel={ctx.windowLabel}
          caption={`Total transactions, last ${ctx.windowLabel}`} />
        <KpiCard item="network.total-volume" label="DEX Volume" cell={volume} delta={volumeDelta} windowLabel={ctx.windowLabel} caption={volumeCaption} />
        <KpiCard item="network.average-fee" label="Avg DEX Pool Fee" cell={fee} delta={feeDelta} windowLabel={ctx.windowLabel} caption={feeCaption} />
      </div>
      <div className="grid grid-cols-1 divide-y divide-slate-100 rounded-2xl border border-slate-200 bg-white px-4 shadow-sm sm:grid-cols-3 sm:divide-x sm:divide-y-0 sm:px-0">
        {([
          ['network.blocks', 'Blocks', `Total, last ${ctx.windowLabel}`, blocks, ''],
          ['network.tps', 'Transactions per second', `Average over the last ${ctx.windowLabel}`, tps, ''],
          ['network.gas-used', 'Gas used', `Total, last ${ctx.windowLabel}`, gas, 'gas'],
        ] as const).map(([item, label, caption, cell, unit]) => (
          <div key={item} {...markerProps(item, cell.status, cell.raw)} className="flex items-center justify-between gap-3 py-3 sm:px-4">
            <div className="min-w-0">
              <p className="text-sm font-medium text-slate-700">{label}</p>
              <p className="text-[11px] text-slate-400">{caption}</p>
            </div>
            {cell.status === 'available'
              ? <p className="shrink-0 text-base font-semibold tabular-nums text-slate-950">{cell.text}{unit && <span className="ml-1 text-xs font-normal text-slate-500">{unit}</span>}</p>
              : <StatusPill status={cell.status} />}
          </div>
        ))}
      </div>
    </section>
  )
}

function VolumeChartSection({ ctx, initialView }: { ctx: ViewContext; initialView: 'volume' | 'swaps' }) {
  // Volume is the primary DEX metric and the default view; Swaps is the secondary, verified count view.
  const [tab, setTab] = useState<'volume' | 'swaps'>(initialView)
  const points = ctx.mode === 'ready' ? swapPoints(ctx.timeseries) : null
  const status = chartStatus(ctx, points)
  const usd = ctx.mode === 'ready' ? usdPoints(ctx.timeseries) : null
  const usdStatus = usdChartStatus(ctx, usd)
  const unvalued = usdStatus === 'available' ? unvaluedSwapsIn(ctx.timeseries) : 0
  const shownStatus = tab === 'volume' ? usdStatus : status
  const series: ChartSeries[] = [{ name: 'Uniswap V3', barClass: V3_BAR }, { name: 'Uniswap V4', barClass: V4_BAR }]
  return (
    <section data-intel-section="volume-chart" aria-label="DEX Activity" className={`${CARD} min-w-0 lg:col-span-3`}>
      <CardTitle
        title={tab === 'volume' ? 'DEX Volume' : 'DEX Swaps'}
        subtitle={tab === 'volume'
          ? `${DEX_VOLUME_SCOPE} USD value per ${ctx.period === 'day' ? 'day' : 'UTC hour'} across all verified pairs, last ${ctx.windowLabel}. Each swap is counted once.`
          : `Swap events per ${ctx.period === 'day' ? 'day' : 'UTC hour'} across all verified Uniswap V3 and V4 pairs, last ${ctx.windowLabel}. Counts, not amounts.`}
        right={(
          <div role="tablist" aria-label="DEX chart" className="flex gap-1.5">
            <TabButton selected={tab === 'volume'} onClick={() => setTab('volume')} marker={markerProps('volume-chart.volume', usdStatus)}>Volume</TabButton>
            <TabButton selected={tab === 'swaps'} onClick={() => setTab('swaps')} marker={markerProps('volume-chart.swaps', status)}>Swaps</TabButton>
          </div>
        )}
      />
      {tab === 'volume' ? (
        usdStatus === 'available' && usd ? (
          <>
            <HourReadout item="volume-chart.latest" status={usdStatus} points={usd} unit="" period={ctx.period} format={usdText} />
            <BarChart points={usd} series={series} unit="" period={ctx.period} format={usdText} axisFormat={usdText} />
            <p className="mt-1 text-[11px] leading-4 text-slate-400">
              Each swap counts once, valued by its USDC side or by a verified hourly price from Arc USDC pools.
              {unvalued > 0 && ` ${formatCount(unvalued)} swaps between tokens without a verified price are not included.`}
            </p>
          </>
        ) : (
          <>
            <HourReadout item="volume-chart.latest" status={usdStatus} points={[]} unit="" period={ctx.period}
              note={usdStatus === 'collecting' ? 'Not valued yet' : undefined} />
            <EmptyState status={usdStatus} className="mt-4 flex min-h-[11rem] flex-col items-center justify-center"
              title={usdStatus === 'source_pending' ? 'DEX volume is not available yet'
                : ctx.mode === 'history' ? 'History is still being collected'
                  : usdStatus === 'collecting' ? 'DEX volume is still being collected' : `DEX volume per ${ctx.period} is not available right now`}
              detail={usdStatus === 'source_pending' ? 'Verified data does not include hourly DEX USD valuations yet. Swap counts are available in the Swaps tab.'
                : ctx.mode === 'history' ? ctx.historyNote
                  : usdStatus === 'collecting' ? `${ctx.period === 'day' ? 'Days' : 'Hours'} appear here once their swaps are valued.`
                    : ctx.mode === 'ready' ? usdGapReason(ctx.timeseries) : noteFor(ctx, usdStatus)} />
          </>
        )
      ) : status === 'available' && points ? (
        <>
          <HourReadout item="volume-chart.latest" status={status} points={points} unit="swaps" period={ctx.period} />
          <BarChart points={points} series={series} unit="swaps" period={ctx.period} />
        </>
      ) : (
        <>
          <HourReadout item="volume-chart.latest" status={status} points={[]} unit="swaps" period={ctx.period} />
          <EmptyState status={status} className="mt-4 flex min-h-[11rem] flex-col items-center justify-center"
            title={ctx.mode === 'history' ? 'History is still being collected' : status === 'collecting' ? 'History is still being collected'
              : `Swaps per ${ctx.period} are not available right now`}
            detail={ctx.mode === 'history' ? ctx.historyNote : status === 'collecting' ? collectingText(ctx) : noteFor(ctx, status)} />
        </>
      )}
      <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1.5 text-xs text-slate-600">
        <span {...markerProps('volume-chart.uniswap-v3', shownStatus)} className="inline-flex items-center gap-1.5"><span className={`h-2.5 w-2.5 rounded-sm ${V3_BAR}`} />Uniswap V3</span>
        <span {...markerProps('volume-chart.uniswap-v4', shownStatus)} className="inline-flex items-center gap-1.5"><span className={`h-2.5 w-2.5 rounded-sm ${V4_BAR}`} />Uniswap V4</span>
        <span {...markerProps('volume-chart.other', 'source_pending')} className="inline-flex items-center gap-1.5 text-slate-400"><span className="h-2.5 w-2.5 rounded-sm border border-dashed border-slate-300" />Other DEX protocols: not available yet</span>
      </div>
    </section>
  )
}

// A daily distinct count must come from its own stored verification. 30D can show those
// counts; the 7D presentation remains unchanged, and hourly counts are never added together.
function ActiveAddressesChartSection({ ctx }: { ctx: ViewContext }) {
  const daily = ctx.period === 'day'
  const storedDaily = ctx.summary?.window.key === '30d'
  const points = ctx.mode === 'ready' && (!daily || storedDaily) ? addressPoints(ctx.timeseries) : null
  const status: DisplayStatus = daily && ctx.mode === 'ready'
    ? points?.some((point) => point.values) ? 'available' : 'unavailable' : chartStatus(ctx, points)
  return (
    <section data-intel-section="active-addresses-chart" aria-label="Active Addresses" className={`${CARD} min-w-0 lg:col-span-2`}>
      <CardTitle title="Active Addresses"
        subtitle={daily
          ? storedDaily ? 'Verified distinct addresses per completed UTC day. Daily counts are never added together.'
            : 'Unique addresses are counted per UTC hour, within the 24H view.'
          : 'Unique addresses active in each UTC hour. Hourly values are not added together.'} />
      <div {...markerProps('active-addresses-chart.series', status)}>
        {status === 'available' && points ? (
          <>
            <HourReadout item="active-addresses-chart.latest" status={status} points={points} unit="addresses" period={ctx.period} />
            <BarChart points={points} series={[{ name: 'Active addresses', barClass: ADDRESS_BAR }]} unit="addresses" period={ctx.period} />
          </>
        ) : daily && ctx.mode === 'ready' ? (
          <>
            <HourReadout item="active-addresses-chart.latest" status={status} points={[]} unit="addresses" period="day" note="Not counted per day" />
            <EmptyState status={status} className="mt-4 flex min-h-[11rem] flex-col items-center justify-center"
              title="Daily active addresses are not available" detail={storedDaily
                ? 'No stored verified daily distinct counts are available. Hourly unique counts are never added together.'
                : `${reasonText('identity_retention_exceeded')} Switch to 24H for hourly counts.`} />
          </>
        ) : (
          <>
            <HourReadout item="active-addresses-chart.latest" status={status} points={[]} unit="addresses" period={ctx.period} />
            <EmptyState status={status} className="mt-4 flex min-h-[11rem] flex-col items-center justify-center"
              title={ctx.mode === 'history' || status === 'collecting' ? 'History is still being collected' : 'Hourly active addresses are not available right now'}
              detail={ctx.mode === 'history' ? ctx.historyNote : status === 'collecting' ? collectingText(ctx) : noteFor(ctx, status)} />
          </>
        )}
      </div>
    </section>
  )
}

// ---------------------------------------------------------------------------------------------------------------------
// Lower half building blocks. One status badge per card with a short line of text; cells without verified data show a
// quiet gap, never a digit; every bar is a real count relative to the other real counts beside it, never a share of an
// unverified total.

const INLINE_STATUS_CLASS: Record<DisplayStatus, string> = {
  available: 'text-[#2F6E0C]',
  collecting: 'text-[#2F6E0C]',
  unavailable: 'text-amber-700',
  source_pending: 'text-slate-400',
  loading: 'text-slate-400',
}

function InlineStatus({ status }: { status: DisplayStatus }) {
  return <span className={`whitespace-nowrap text-[11px] font-medium ${INLINE_STATUS_CLASS[status]}`}>{STATUS_TEXT[status]}</span>
}

function ValueGap({ className = 'w-10' }: { className?: string }) {
  return <span aria-hidden="true" className={`inline-block h-3 rounded bg-slate-100 align-middle ${className}`} />
}

// The status every cell of a card shares, shown once; null when the cells differ or all are available.
function sharedStatus(statuses: DisplayStatus[]): DisplayStatus | null {
  const first = statuses[0]
  return first && first !== 'available' && statuses.every((status) => status === first) ? first : null
}

// Activity bar: a real count relative to the largest real count beside it. A tiny non-zero count keeps a visible sliver.
function ActivityBar({ value, max, barClass = 'bg-[#2F6E0C]' }: { value: number | null; max: number; barClass?: string }) {
  const width = value === null || value <= 0 || max <= 0 ? 0 : Math.max((value / max) * 100, 1.5)
  return (
    <span className="block h-1.5 w-full overflow-hidden rounded-full bg-slate-100">
      {value !== null && (
        <span data-activity-bar="" data-activity-value={value} className={`block h-full rounded-full ${barClass}`} style={{ width: `${width}%` }} />
      )}
    </span>
  )
}

const ASSET_CATEGORY: Record<string, string> = {
  USDC: 'Stablecoin',
  EURC: 'Stablecoin',
  cirBTC: 'Tokenized bitcoin',
  WETH: 'Wrapped asset',
  USYC: 'Tokenized fund',
}
const CATEGORY_TONE: Record<string, string> = {
  Stablecoin: 'bg-[#eef7e8] text-[#2F6E0C]',
  'Tokenized bitcoin': 'bg-amber-50 text-amber-700',
  'Wrapped asset': 'bg-sky-50 text-sky-700',
  'Tokenized fund': 'bg-teal-50 text-teal-700',
}
const NEUTRAL_TONE = 'bg-slate-100 text-slate-600'
const toneFor = (symbol: string) => CATEGORY_TONE[ASSET_CATEGORY[symbol] ?? ''] ?? NEUTRAL_TONE

// Machina has no token logo assets and none are invented: a neutral initial avatar, tinted by asset category.
function TokenAvatar({ symbol, size = 'md' }: { symbol: string; size?: 'sm' | 'md' }) {
  const initial = symbol.startsWith('0x') ? '0x' : symbol.replace(/[^A-Za-z]/g, '').charAt(0).toUpperCase() || '?'
  return (
    <span aria-hidden="true" className={`inline-flex shrink-0 items-center justify-center rounded-full font-bold ${toneFor(symbol)} ${
      size === 'sm' ? 'h-5 w-5 text-[9px]' : 'h-8 w-8 text-xs'}`}>
      {initial}
    </span>
  )
}

function Chip({ children, tone = NEUTRAL_TONE }: { children: ReactNode; tone?: string }) {
  return <span className={`inline-flex shrink-0 items-center rounded-md px-1.5 py-px text-[10px] font-semibold ${tone}`}>{children}</span>
}

const LABEL = 'text-[10px] font-semibold uppercase tracking-[0.1em] text-slate-400'

// Small stat tile for real supporting numbers (new pools, pools tracked, asset counts).
function StatTile({ label, cell, unit, marker }: { label: string; cell: Cell; unit?: string; marker?: Record<string, string> }) {
  return (
    <div {...marker} className="min-w-0 rounded-lg border border-slate-100 bg-[#f8faf7] px-2.5 py-1.5">
      <p className="truncate text-[11px] text-slate-500">{label}</p>
      {cell.status === 'available'
        ? <p className="text-sm font-semibold tabular-nums text-slate-950">{cell.text}{unit && <span className="ml-1 text-[11px] font-normal text-slate-500">{unit}</span>}</p>
        : <p className="flex items-center gap-1.5 pt-0.5"><ValueGap /><InlineStatus status={cell.status} /></p>}
    </div>
  )
}

// A table with permanent column headings (chips below the lg breakpoint, where rows become stacked cards). Each heading carries the
// status of its own column: a column without its verified source stays source_pending even when rows are shown.
type ShellColumn = { item: string; label: string; status?: DisplayStatus }

function ShellTable({ columns, gridClass, children }: { columns: ShellColumn[]; gridClass: string; children: ReactNode }) {
  return (
    <div className="mt-3">
      <div className={`hidden gap-3 border-b border-slate-100 pb-1.5 lg:grid ${gridClass}`}>
        {columns.map((column) => (
          <span key={column.item} {...markerProps(column.item, column.status ?? 'source_pending')} className={LABEL}>{column.label}</span>
        ))}
      </div>
      <div className="flex flex-wrap gap-1.5 lg:hidden">
        {columns.map((column) => (
          <span key={column.item} {...markerProps(column.item, column.status ?? 'source_pending')}
            className="rounded-full border border-slate-200 bg-slate-50 px-2 py-0.5 text-[11px] font-medium text-slate-500">
            {column.label}
          </span>
        ))}
      </div>
      {children}
    </div>
  )
}

function EmptyRows({ title, detail, status }: { title: string; detail: string; status?: DisplayStatus }) {
  return (
    <div className="py-4 text-center">
      {status && <div className="mb-1.5"><StatusPill status={status} /></div>}
      <p className="text-xs font-medium text-slate-600">{title}</p>
      <p className="mx-auto mt-0.5 max-w-md text-[11px] leading-4 text-slate-400">{detail}</p>
    </div>
  )
}

function CardHeader({ title, subtitle, icon: Icon, right }: { title: string; subtitle?: string; icon?: typeof Coins; right?: ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-3">
      <div className="flex min-w-0 items-start gap-2.5">
        {Icon && (
          <span className="mt-0.5 inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-[#eef7e8] text-[#2F6E0C]">
            <Icon className="h-3.5 w-3.5" />
          </span>
        )}
        <div className="min-w-0">
          <h4 className="text-base font-semibold text-slate-950">{title}</h4>
          {subtitle && <p className="text-xs leading-5 text-slate-500">{subtitle}</p>}
        </div>
      </div>
      {right && <div className="shrink-0">{right}</div>}
    </div>
  )
}

// ---------------------------------------------------------------------------------------------------------------------
// Markets

const PROTOCOL_ROWS: { item: string; name: string; category: string; family: (summary: ArcSummary) => FamilyWindow;
  fields: readonly string[]; unit: string }[] = [
  { item: 'top-protocols.uniswap-v3', name: 'Uniswap V3', category: 'DEX', family: (summary) => summary.dex.uniswapV3, fields: ['swapCount'], unit: 'swaps' },
  { item: 'top-protocols.uniswap-v4', name: 'Uniswap V4', category: 'DEX', family: (summary) => summary.dex.uniswapV4, fields: ['swapCount'], unit: 'swaps' },
  { item: 'top-protocols.aave', name: 'Aave', category: 'Lending', family: (summary) => summary.lending.aaveV4, fields: AAVE_ACTIONS, unit: 'lending actions' },
  { item: 'top-protocols.morpho-blue', name: 'Morpho Blue', category: 'Lending', family: (summary) => summary.lending.morphoBlue, fields: MORPHO_BLUE_ACTIONS, unit: 'market actions' },
  { item: 'top-protocols.morpho-vaults', name: 'Morpho Vaults', category: 'Vaults', family: (summary) => summary.lending.morphoVaultsV2, fields: MORPHO_VAULT_ACTIONS, unit: 'vault actions' },
]

function TopProtocolsSection({ ctx }: { ctx: ViewContext }) {
  const rows = PROTOCOL_ROWS.map((row) => {
    const family = ctx.summary ? row.family(ctx.summary) : null
    return { ...row, cell: numberCell(ctx, family, metricSum(family, row.fields), formatCount) }
  })
  const shared = sharedStatus(rows.map((row) => row.cell.status))
  const max = Math.max(0, ...rows.map((row) => (row.cell.status === 'available' ? Number(row.cell.raw) : 0)))
  return (
    <section data-intel-section="top-protocols" aria-label="Top Protocols" className={`${CARD} min-w-0`}>
      <CardHeader title="Top Protocols" subtitle={`Verified Arc protocols, last ${ctx.windowLabel}`} />
      <div {...markerProps('top-protocols.volume-ranking', 'source_pending')}
        className="mt-3 flex items-center justify-between gap-3 rounded-lg border border-dashed border-slate-200 px-3 py-2">
        <div className="min-w-0">
          <p className="text-xs font-semibold text-slate-700">Ranked by USD volume</p>
          <p className="text-[11px] leading-4 text-slate-500">
            Not available: lending and bridge USD values are kept per action (supplied, borrowed, sent), so protocols share no comparable USD volume. Listed in a fixed order.
          </p>
        </div>
        <StatusPill status="source_pending" />
      </div>
      <div className="mt-3 flex items-center justify-between gap-2">
        <p className={LABEL}>Activity, last {ctx.windowLabel}</p>
        {shared && <InlineStatus status={shared} />}
      </div>
      <ul className="mt-1.5 space-y-2.5">
        {rows.map((row) => (
          <li key={row.item} {...markerProps(row.item, row.cell.status, row.cell.raw)}>
            <div className="flex items-baseline justify-between gap-3">
              <p className="flex min-w-0 items-center gap-1.5">
                <span className="truncate text-sm font-semibold text-slate-900">{row.name}</span>
                <Chip>{row.category}</Chip>
              </p>
              {row.cell.status === 'available'
                ? <p className="shrink-0 text-sm font-semibold tabular-nums text-slate-950">{row.cell.text} <span className="text-[11px] font-normal text-slate-500">{row.unit}</span></p>
                : shared ? <ValueGap /> : <InlineStatus status={row.cell.status} />}
            </div>
            <div className="mt-1"><ActivityBar value={row.cell.status === 'available' ? Number(row.cell.raw) : null} max={max} /></div>
          </li>
        ))}
        <li {...markerProps('top-protocols.other', 'source_pending')} className="flex items-center justify-between gap-3 border-t border-dashed border-slate-200 pt-2">
          <p className="min-w-0 truncate text-sm font-medium text-slate-500">Other Arc protocols</p>
          <InlineStatus status="source_pending" />
        </li>
      </ul>
    </section>
  )
}

// Display state of a pools or activity read; outside a ready 24H view the view state decides.
function readStatus(ctx: ViewContext, entry: { status: string; reason: string | null } | null | undefined): DisplayStatus {
  if (ctx.mode !== 'ready') return liveStatus(ctx, null)
  return entry ? windowStatus({ status: entry.status, reason: entry.reason ?? undefined }) : 'unavailable'
}

// A verified token reads as its symbol. Another token reads as the symbol its own contract reports, marked as not verified
// (dotted underline, details on hover), or, without one, as its shortened address. Never a guess.
function TokenLabel({ token }: { token: PoolToken }) {
  if (token.symbol) return <span className="font-semibold text-slate-900">{token.symbol}</span>
  const contract = token.contractMetadata
  if (contract) {
    return (
      <span className="font-medium text-slate-700 underline decoration-slate-300 decoration-dotted underline-offset-2"
        title={`${contract.name ? `${contract.name}, ` : ''}${token.address}. Name from the token contract, not a verified Arc asset.`}>
        {contract.symbol}
      </span>
    )
  }
  return <span className="font-mono text-[11px] font-medium text-slate-500" title={`${token.address} (token details not verified)`}>{shortenAddress(token.address)}</span>
}

// Wraps between the two sides instead of cutting a name off.
function PairLabel({ pair }: { pair: { token0: PoolToken; token1: PoolToken } }) {
  return (
    <span className="inline-flex min-w-0 flex-wrap items-baseline gap-x-1">
      <TokenLabel token={pair.token0} /><span className="text-slate-300">/</span><TokenLabel token={pair.token1} />
    </span>
  )
}
// Uniswap fees are in hundredths of a basis point (500 = 0.05%); V4 pools may instead use a dynamic fee set by their hook.
const V4_DYNAMIC_FEE = 0x800000
const feeText = (fee: number) => (fee === V4_DYNAMIC_FEE ? 'Dynamic fee' : `${(fee / 10_000).toLocaleString('en-US', { maximumFractionDigits: 4 })}%`)
const ZERO_HOOKS = `0x${'0'.repeat(40)}`

// Title and detail of the empty table, by status. No number is ever shown in place of a missing ranking.
function poolsEmpty(ctx: ViewContext, status: DisplayStatus): [string, string] {
  if (status === 'available') return ['No swaps in verified pools in this window', 'Pools appear here once they swap.']
  if (status === 'loading') return ['Loading verified pools', 'Loading verified data']
  if (status === 'collecting') return ['History is still being collected', ctx.mode === 'history' ? ctx.historyNote
    : 'Pool rankings appear once every hour of the window is verified.']
  return ['Pool data is not verified for this window', ctx.mode === 'failed' ? 'Could not be loaded right now. Try Refresh in a moment.'
    : 'Rankings appear once every hour of the window is verified.']
}

const POOL_GRID = 'grid-cols-[1rem_minmax(0,1fr)_auto_auto]'

// One pool's USD volume over the window. A pool whose swaps cannot all be valued says "No verified price"; when the
// table's volume is not available, the shared reason is stated once below the table.
function PoolVolume({ status, volume, reason }: { status: DisplayStatus; volume: ArcPools['pools'][number]['usdVolume']; reason: string }) {
  if (status === 'loading') return <span className="text-right"><ValueGap /></span>
    if (status === 'collecting') {
      return <span className="max-w-[5rem] text-right text-[11px] leading-tight text-slate-400" title={reason}>Not valued yet</span>
    }
    if (status !== 'available') {
      return <span className="max-w-[5rem] text-right text-[11px] leading-tight text-slate-400" title={reason} />
    }
  if (volume?.status === 'available' && volume.usdMicros) {
    const value = usdMicrosToNumber(volume.usdMicros)
    return (
      <p className="text-right leading-tight" title={formatUsdMicros(volume.usdMicros)}>
        <span className="block text-sm font-semibold tabular-nums text-slate-950">{value === null ? '' : usdText(value)}</span>
        <span className="block text-[11px] text-slate-500">volume</span>
      </p>
    )
  }
  return (
    <span className="max-w-[5rem] text-right text-[11px] leading-tight text-slate-400" title="No verified USD price for this pair in every hour of the window">
      No verified price
    </span>
  )
}

type PoolLiquidity = ArcPools['pools'][number]['liquidityUsd']

// Value held in one pool at the end of the latest verified hour, from pool state (never from add or remove activity).
function PoolLiquidityLine({ liquidity }: { liquidity: PoolLiquidity }) {
  if (!liquidity) return null
  if (liquidity.status === 'available' && liquidity.usdMicros) {
    const value = usdMicrosToNumber(liquidity.usdMicros)
    return (
      <p className="mt-0.5 text-[11px] text-slate-500" title={formatUsdMicros(liquidity.usdMicros)}>
        {liquidity.calculation === 'estimated_principal_reserves' ? 'Estimated reserves ' : 'Holds '}<span className="font-semibold tabular-nums text-slate-800">{value === null ? '' : usdText(value)}</span>
      </p>
    )
  }
  const text = POOL_HOLDINGS_TEXT[liquidity.reason ?? ''] ?? 'Holdings not stated'
  return <p className="mt-0.5 text-[11px] leading-4 text-slate-400" title={reasonText(liquidity.reason)}>{text}</p>
}

// Why one pool's holdings are not stated, in a few words (the full reason is on hover).
const POOL_HOLDINGS_TEXT: Record<string, string> = {
  no_verified_price: 'Holdings: no verified price',
  tvl_not_collected: 'Holdings not read at the latest verified hour end block',
  tvl_not_collected_for_pool: 'Holdings not read: only the top pools of the latest hour are read',
  hook_may_hold_pool_value: 'Holdings not stated: its hook may hold part of the value',
  tvl_scan_unbounded: 'Holdings not stated: too many price ranges to read exactly',
  balance_unreadable: 'Holdings not stated: a token balance could not be read',
  pool_not_initialized: 'Holdings not stated: the pool has no price yet',
  tvl_state_inconsistent: 'Holdings not stated: pool state could not be read consistently',
  tick_out_of_range: 'Holdings not stated: pool state could not be read consistently',
}

// Status of the Liquidity column: from the pools read itself (pool state of the latest verified hour); not read yet is
// collecting, an API without it is not available yet.
function liquidityStatus(status: DisplayStatus, ranking: ArcPools['ranking']['liquidityUsd'] | undefined): DisplayStatus {
  if (status !== 'available') return status
  if (!ranking || ranking.status === 'source_pending') return 'source_pending'
  if (ranking.status === 'available') return 'available'
  return ranking.reason === 'tvl_not_collected' ? 'collecting' : 'unavailable'
}

function TopPoolsSection({ ctx, version }: { ctx: ViewContext; version: 'v3' | 'v4' }) {
  const id = version === 'v3' ? 'top-pools-v3' : 'top-pools-v4'
  const family = ctx.summary ? (version === 'v3' ? ctx.summary.dex.uniswapV3 : ctx.summary.dex.uniswapV4) : null
  const newPools = numberCell(ctx, family, metricNumber(family, version === 'v3' ? 'poolCreatedCount' : 'initializeCount'), formatCount)
  const registry = ctx.summary?.dex.officialV3Pools
  const poolCountStatus: DisplayStatus = ctx.mode !== 'ready' ? liveStatus(ctx, null)
    : registry?.status === 'available' && isFiniteNumber(registry.count) ? 'available' : 'unavailable'
  const poolCount: Cell = poolCountStatus === 'available' && registry && isFiniteNumber(registry.count)
    ? { status: 'available', raw: registry.count, text: formatCount(registry.count) } : { status: poolCountStatus }
  const label = version === 'v3' ? 'V3' : 'V4'
  const data = ctx.pools?.[version] ?? null
  const status = readStatus(ctx, data)
  const rows = status === 'available' && data ? data.pools : []
  // USD volume of the listed pools: from the pools read itself (never from counts); an API without it is not available yet.
  const ranking = data?.ranking.usdVolume
  const volumeStatus: DisplayStatus = status !== 'available' ? status
    : ranking?.status === 'source_pending' ? 'source_pending' : usdVolumeStatus(ranking ?? null)
  const volumeReason = volumeStatus === 'collecting' && ranking?.reason === 'insufficient_coverage' ? collectingText(ctx)
    : volumeStatus === 'source_pending' ? 'Verified data does not include pool USD valuations yet.' : reasonText(firstReason(ranking))
  const holdings = data?.ranking.liquidityUsd
  const holdingsStatus = liquidityStatus(status, holdings)
  const asOf = holdings?.asOfHour && !Number.isNaN(Date.parse(holdings.asOfHour)) ? new Date(Date.parse(holdings.asOfHour) + 3_600_000).toISOString() : null
  const holdingsText = holdingsStatus === 'available'
    ? `${version === 'v4' ? 'Estimated principal reserves, excluding uncollected fees and position rounding' : 'Token balances held by each pool'} at ${asOf ? formatUtcDateTime(asOf) : 'the end of the latest verified hour'}, valued with that hour's verified prices.`
    : holdingsStatus === 'source_pending' ? 'Verified data does not include pool balance or reserve snapshots yet.' : reasonText(holdings?.reason)
  const [emptyTitle, emptyDetail] = poolsEmpty(ctx, status)
  return (
    <section data-intel-section={id} aria-label={`Top Pools (Uniswap ${label})`} className={`${CARD} min-w-0`}>
      <CardHeader title={`Top Pools (Uniswap ${label})`} subtitle={`All verified ${label} pairs, ranked by swap count, last ${ctx.windowLabel}`} />
      <div className={`mt-3 grid gap-2 ${version === 'v3' ? 'grid-cols-2' : 'grid-cols-1'}`}>
        <StatTile marker={markerProps(`${id}.new-pools`, newPools.status, newPools.raw)} label={`New pools, ${ctx.windowLabel}`} cell={newPools} />
        {version === 'v3' && (
          <StatTile marker={markerProps('top-pools-v3.pool-count', poolCount.status, poolCount.raw)} label="Verified pools tracked" cell={poolCount} />
        )}
      </div>
      <div className={`mt-3 grid ${POOL_GRID} gap-x-3 border-b border-slate-100 pb-1.5`}>
        <span className={LABEL}>#</span>
        <span {...markerProps(`${id}.all-pairs`, status)} className={LABEL}>Pair and fee</span>
        <span {...markerProps(`${id}.volume`, volumeStatus)} className={`${LABEL} text-right`}>Volume</span>
        <span {...markerProps(`${id}.swaps`, status)} className={`${LABEL} text-right`}>Swaps</span>
      </div>
      {rows.length ? (
        <ol>
          {rows.map((pool, index) => (
            <li key={pool.pool} data-pool-row={pool.pool} className={`grid ${POOL_GRID} items-center gap-x-3 border-b border-slate-50 py-2 last:border-0`}>
              <span className="self-start pt-0.5 text-[11px] tabular-nums text-slate-400">{index + 1}</span>
              <div className="min-w-0">
                <p className="text-sm leading-5"><PairLabel pair={pool} /></p>
                <p className="mt-0.5 flex flex-wrap gap-1">
                  <Chip>{feeText(pool.fee)}</Chip>
                  {pool.hooks && pool.hooks !== ZERO_HOOKS && <Chip>Hooks</Chip>}
                </p>
                <PoolLiquidityLine liquidity={pool.liquidityUsd} />
              </div>
              <PoolVolume status={volumeStatus} volume={pool.usdVolume} reason={volumeReason} />
              <p className="text-right leading-tight">
                <span className="block text-sm font-semibold tabular-nums text-slate-950">{formatCount(pool.swapCount)}</span>
                <span className="block text-[11px] text-slate-500">swaps</span>
              </p>
            </li>
          ))}
        </ol>
      ) : (
        <EmptyRows status={status === 'available' ? undefined : status} title={emptyTitle} detail={emptyDetail} />
      )}
      {/* Volume and Liquidity state their status and reason once here; a missing value is never a number. */}
      <div className="mt-2 space-y-1 rounded-lg bg-slate-50 px-3 py-1.5 text-[11px] text-slate-600">
        {volumeStatus !== 'available' && rows.length > 0 && (
          <div>
            <p className="flex items-center justify-between gap-3"><span>Volume (USD)</span><InlineStatus status={volumeStatus} /></p>
            {volumeStatus !== 'loading' && <p className="text-slate-400">{volumeReason}</p>}
          </div>
        )}
        <div {...markerProps(`${id}.liquidity`, holdingsStatus)}>
          <p className="flex items-center justify-between gap-3"><span>Liquidity</span><InlineStatus status={holdingsStatus} /></p>
          {holdingsStatus !== 'loading' && status === 'available' && <p className="text-slate-400">{holdingsText}</p>}
        </div>
      </div>
      <p className="mt-1 text-[11px] leading-4 text-slate-400">
        Every verified Uniswap {label} pair is ranked by swaps, not only USDC pairs. Volume is the USD value of the pool's swaps, each counted once. Liquidity uses {version === 'v4' ? 'estimated principal reserves from pool state' : 'token balances held by the pool'}. Tokens without verified details show their shortened address.
      </p>
    </section>
  )
}

// ---------------------------------------------------------------------------------------------------------------------
// Recent activity and launches

// Permanent column order. From is the transaction sender; To is only an exact event-level recipient or owner (never the
// called contract), and is unavailable for rows whose event records none (Uniswap V4 swaps).
const RECENT_ACTIVITY_COLUMNS = [
  { item: 'recent-activity.time', label: 'Time (UTC)' },
  { item: 'recent-activity.type', label: 'Type' },
  { item: 'recent-activity.protocol', label: 'Protocol' },
  { item: 'recent-activity.pair', label: 'Pair' },
  { item: 'recent-activity.amounts', label: 'Amount' },
  { item: 'recent-activity.from', label: 'From' },
  { item: 'recent-activity.to', label: 'To' },
  { item: 'recent-activity.transaction-links', label: 'Tx' },
]

const ACTIVITY_TABS: readonly (readonly [ArcActivityType, string])[] = [['all', 'All'], ['swaps', 'Swaps'], ['adds', 'Adds'], ['removes', 'Removes']]
const KIND_TEXT: Record<ArcActivityRow['kind'], string> = { swap: 'Swap', add: 'Add', remove: 'Remove' }
// Eight columns from the lg breakpoint (shortened addresses and hashes need their width); stacked cards below it, four
// cells wide on tablets.
const ACTIVITY_GRID = 'lg:grid-cols-[0.8fr_0.5fr_0.7fr_1.2fr_2fr_0.85fr_0.85fr_0.9fr]'
const PROTOCOL_TEXT: Record<ArcActivityRow['protocol'], string> = { uniswap_v3: 'Uniswap V3', uniswap_v4: 'Uniswap V4' }

// Stablecoins read in cents; other tokens keep four decimals when they have 8 or more.
const amountDigits = (token: PoolToken, decimals: number) => (ASSET_CATEGORY[token.symbol ?? ''] === 'Stablecoin' ? 2 : shownDigits(decimals))

type AmountSide = { raw: string; token: PoolToken; direction: 'to pool' | 'from pool' | null }

// Token amounts of one event. Swaps are pool deltas as emitted (V3: positive is paid into the pool; V4: negative is paid
// into the pool), shown from the pool's side; V3 liquidity changes are exact token amounts; V4 liquidity changes carry
// none. null: the event records no token amounts.
function activitySides(row: ArcActivityRow): AmountSide[] | null {
  const { amounts, pair } = row
  if (amounts.status !== 'available' || amounts.amount0Raw === null || amounts.amount1Raw === null) return null
  const sides: [string, PoolToken][] = [[amounts.amount0Raw, pair.token0], [amounts.amount1Raw, pair.token1]]
  if (row.kind !== 'swap') return sides.map(([raw, token]) => ({ raw, token, direction: null }))
  const toPool = (raw: string) => (amounts.basis === 'v3_pool_delta' ? !raw.startsWith('-') : raw.startsWith('-'))
  return sides.filter(([raw]) => BigInt(raw) !== 0n)
    .map(([raw, token]) => ({ raw: raw.replace(/^-/, ''), token, direction: toPool(raw) ? 'to pool' : 'from pool' }))
}

// A verified token reads in its own decimals; another token in the decimals its own contract reports, with its unverified
// label. A token without either has no known decimals, so no decimal amount is invented: the line says "Raw amount" and
// the exact integer stays one tap away (and in the hover title).
function AmountLine({ side }: { side: AmountSide }) {
  const direction = side.direction && <span className="text-slate-400"> {side.direction}</span>
  const decimals = side.token.decimals ?? side.token.contractMetadata?.decimals ?? null
  if (decimals !== null) {
    return (
      <span className="block tabular-nums text-slate-700">
        {formatTokenAmount(side.raw, decimals, amountDigits(side.token, decimals))} {side.token.symbol ?? <TokenLabel token={side.token} />}{direction}
      </span>
    )
  }
  return (
    <details className="block text-slate-700" title={`Exact raw amount: ${side.raw}`}>
      <summary className="cursor-pointer list-none [&::-webkit-details-marker]:hidden">
        <span className="font-medium">Raw amount</span> <TokenLabel token={side.token} />{direction}
      </summary>
      <span className="block break-all font-mono text-[10px] text-slate-500">{side.raw}</span>
    </details>
  )
}

// Compact UTC time; the column heading already says UTC.
const activityTime = (iso: string) => formatUtcDateTime(iso).replace(/ UTC$/, '')

function ActivityCell({ label, children, className = '' }: { label: string; children: ReactNode; className?: string }) {
  return (
    <div className={`min-w-0 ${className}`}>
      <span className="block text-[10px] font-semibold uppercase tracking-[0.1em] text-slate-400 lg:hidden">{label}</span>
      {children}
    </div>
  )
}

const ADDRESS_TEXT = 'tabular-nums text-slate-700'

// sharedTx: this transaction emitted more than one listed event, so each row names its own log (never merged).
function ActivityRowView({ row, explorerUrl, sharedTx }: { row: ArcActivityRow; explorerUrl: string | null; sharedTx: boolean }) {
  const sides = activitySides(row)
  const hash = shortenHash(row.txHash)
  return (
    <li data-activity-row={row.txHash} data-log-index={row.logIndex}
      className={`grid grid-cols-2 gap-x-3 gap-y-1.5 border-b border-slate-50 py-2 text-xs last:border-0 md:grid-cols-4 lg:items-center ${ACTIVITY_GRID}`}>
      <ActivityCell label="Time (UTC)"><span className="tabular-nums text-slate-600">{activityTime(row.time)}</span></ActivityCell>
      <ActivityCell label="Type"><span className="font-semibold text-slate-900">{KIND_TEXT[row.kind]}</span></ActivityCell>
      <ActivityCell label="Protocol"><span className="text-slate-700">{PROTOCOL_TEXT[row.protocol]}</span></ActivityCell>
      <ActivityCell label="Pair"><PairLabel pair={row.pair} /></ActivityCell>
      <ActivityCell label="Amount" className="col-span-2 lg:col-span-1">
        {sides
          ? sides.map((side) => <AmountLine key={`${side.token.address}:${side.direction}`} side={side} />)
          : <span className="text-slate-400">Token amounts not recorded</span>}
      </ActivityCell>
      <ActivityCell label="From"><span className={ADDRESS_TEXT} title={row.from}>{shortenAddress(row.from)}</span></ActivityCell>
      <ActivityCell label="To">
        {row.to ? <span className={ADDRESS_TEXT} title={row.to}>{shortenAddress(row.to)}</span> : (
          <span title={row.toReason === V4_SWAP_TO_BLOCKER ? V4_SWAP_TO_TEXT : undefined}><InlineStatus status="unavailable" /></span>
        )}
      </ActivityCell>
      <ActivityCell label="Tx">
        {explorerUrl
          ? (
            <a href={`${explorerUrl}/tx/${row.txHash}`} target="_blank" rel="noopener noreferrer" title={row.txHash}
              className="inline-flex items-center gap-0.5 tabular-nums text-[#2F6E0C] hover:underline">
              {hash}<ArrowUpRight aria-hidden="true" className="h-3 w-3" />
            </a>
          )
          : <span className={ADDRESS_TEXT} title={row.txHash}>{hash}</span>}
        {sharedTx && (
          <span className="block text-[10px] text-slate-400" title="This transaction emitted several events; each one is listed on its own row.">
            {`Log #${row.logIndex}`}
          </span>
        )}
      </ActivityCell>
    </li>
  )
}

const ACTIVITY_DESCRIPTION = 'Each swap, add and remove appears here with its time, protocol, pair, token amounts, sender, recipient where the event '
  + 'records one, and a link to the transaction on the Arc explorer.'

function activityEmpty(ctx: ViewContext, status: DisplayStatus): [string, string] {
  if (status === 'available') return ['No events of this type yet', ACTIVITY_DESCRIPTION]
  if (status === 'loading') return ['Loading verified activity', ACTIVITY_DESCRIPTION]
  if (status === 'collecting') return ['Recent activity is shown in the 24H view', ACTIVITY_DESCRIPTION]
  return ['The verified activity feed is not available right now', ctx.mode === 'failed' ? 'Could not be loaded right now. Try Refresh in a moment.'
    : 'It returns once the latest verified hour includes its activity.']
}

function RecentActivitySection({ ctx, initialType }: { ctx: ViewContext; initialType: ArcActivityType }) {
  const [tab, setTab] = useState<ArcActivityType>(initialType)
  const statusOf = (type: ArcActivityType) => readStatus(ctx, ctx.activity?.[type] ?? null)
  const status = statusOf(tab)
  const feed = ctx.activity?.[tab] ?? null
  const rows = status === 'available' && feed ? feed.rows : []
  const txCounts = new Map<string, number>()
  for (const row of rows) txCounts.set(row.txHash, (txCounts.get(row.txHash) ?? 0) + 1)
  return (
    <section data-intel-section="recent-activity" aria-label="Recent Activity" className={CARD}>
      <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-2">
        <div className="min-w-[10rem] flex-1">
          <h4 className="text-base font-semibold text-slate-950">Latest DEX activity</h4>
          <p className="text-xs leading-5 text-slate-500">Newest swaps and liquidity changes across all verified Uniswap pairs, newest first</p>
        </div>
        <div role="tablist" aria-label="Activity type" className="flex flex-wrap gap-1.5">
          {ACTIVITY_TABS.map(([key, label]) => (
            <TabButton key={key} selected={tab === key} onClick={() => setTab(key)} marker={markerProps(`recent-activity.${key}`, statusOf(key))}>{label}</TabButton>
          ))}
        </div>
      </div>
      <ShellTable
        gridClass={ACTIVITY_GRID}
        columns={RECENT_ACTIVITY_COLUMNS.map((column) => ({ ...column, status }))}
      >
        {rows.length ? (
          <ol className="mt-1">
            {rows.map((row) => (
              <ActivityRowView key={`${row.blockNumber}:${row.logIndex}`} row={row} explorerUrl={ctx.explorerUrl} sharedTx={(txCounts.get(row.txHash) ?? 0) > 1} />
            ))}
          </ol>
        ) : (
          <EmptyRows status={status === 'available' ? undefined : status} title={activityEmpty(ctx, status)[0]} detail={activityEmpty(ctx, status)[1]} />
        )}
      </ShellTable>
      <p className="mt-1 text-[11px] leading-4 text-slate-400">
        From is the wallet that sent the transaction. To is shown only when the event itself records the recipient or owner; otherwise it reads unavailable.
        {' '}Uniswap V4 swaps: {V4_SWAP_TO_TEXT}
      </p>
    </section>
  )
}

const LAUNCH_CAPABILITIES = [
  { icon: Search, title: 'Token discovery', detail: 'New tokens created on Arc' },
  { icon: Rocket, title: 'Launch source', detail: 'Where and how each token launched' },
  { icon: Droplets, title: 'First pool + DEX activity', detail: 'First trading pair and early swaps' },
]

function LaunchesSection({ ctx }: { ctx: ViewContext }) {
  return (
    <section data-intel-section="launches" aria-label="New Token Launches" className={CARD}>
      <CardHeader title="Newly launched tokens" subtitle={`Tokens launched on Arc, last ${ctx.windowLabel}`} right={<StatusPill status="source_pending" />} />
      <div className="mt-3 grid gap-2 sm:grid-cols-3">
        {LAUNCH_CAPABILITIES.map(({ icon: Icon, title, detail }) => (
          <div key={title} className="flex items-start gap-2.5 rounded-lg border border-slate-100 bg-[#f8faf7] px-3 py-2">
            <span className="mt-0.5 inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-white text-slate-500 ring-1 ring-slate-200">
              <Icon className="h-3.5 w-3.5" />
            </span>
            <div className="min-w-0">
              <p className="text-xs font-semibold text-slate-800">{title}</p>
              <p className="text-[11px] leading-4 text-slate-500">{detail}</p>
              <p className="mt-0.5 text-[11px] font-medium text-slate-400">Not available yet</p>
            </div>
          </div>
        ))}
      </div>
      <ShellTable
        gridClass="grid-cols-8"
        columns={[
          { item: 'launches.token', label: 'Token' },
          { item: 'launches.symbol-address', label: 'Symbol and address' },
          { item: 'launches.source', label: 'Launched via' },
          { item: 'launches.time', label: 'Launch time' },
          { item: 'launches.transaction', label: 'Transaction' },
          { item: 'launches.initial-pool', label: 'First pool' },
          { item: 'launches.dex-activity', label: 'DEX activity' },
          { item: 'launches.status', label: 'Status' },
        ]}
      >
        <EmptyRows title="No launches listed yet" detail="Launches appear here once token discovery is verified. No sample tokens are shown." />
      </ShellTable>
    </section>
  )
}

// ---------------------------------------------------------------------------------------------------------------------
// Assets

function AssetsSection({ ctx }: { ctx: ViewContext }) {
  const usdc = ctx.summary?.assets.usdc ?? null
  const verified = ctx.summary?.assets.verifiedAssets ?? null
  const items = verifiedAssetItems(verified)
  type AssetRow = { item: string; symbol: string; cell: Cell; transfers?: number; mints?: number; burns?: number; amount?: string | null }
  const usdcStatus = liveStatus(ctx, usdc)
  const usdcCounts = [metricNumber(usdc, 'transferCount'), metricNumber(usdc, 'mintCount'), metricNumber(usdc, 'burnCount')]
  const usdcAmount = metricAmount(usdc, 'amountRaw')
  const usdcDecimals = metricNumber(usdc, 'rawDecimals')
  const rows: AssetRow[] = [usdcStatus === 'available' && usdcCounts.every((value) => value !== null)
    ? { item: 'assets.usdc', symbol: 'USDC', cell: { status: 'available', raw: usdcCounts[0] as number },
      transfers: usdcCounts[0] as number, mints: usdcCounts[1] as number, burns: usdcCounts[2] as number,
      amount: usdcAmount !== null && usdcDecimals !== null ? `${formatTokenAmount(usdcAmount, usdcDecimals)} USDC` : null }
    : { item: 'assets.usdc', symbol: 'USDC', cell: { status: usdcStatus === 'available' ? 'unavailable' : usdcStatus } }]
  const assetStatus = liveStatus(ctx, verified)
  for (const [item, symbol] of [['assets.eurc', 'EURC'], ['assets.cirbtc', 'cirBTC'], ['assets.weth', 'WETH'], ['assets.usyc', 'USYC']] as const) {
    if (assetStatus !== 'available' || !items) {
      rows.push({ item, symbol, cell: { status: assetStatus === 'available' ? 'unavailable' : assetStatus } })
      continue
    }
    const found = items.find((entry) => entry.symbol === symbol)
    // The window is fully verified: an asset without an entry, or with no events, had no transfers in it.
    rows.push(found && found.transferCount + found.mintCount + found.burnCount > 0
      ? { item, symbol, cell: { status: 'available', raw: found.transferCount }, transfers: found.transferCount,
        mints: found.mintCount, burns: found.burnCount, amount: `${formatAmount(found.amountRaw, found.decimals)} ${symbol}` }
      : { item, symbol, cell: { status: 'available', raw: 0 } })
  }
  const shared = sharedStatus(rows.map((row) => row.cell.status))
  const maxTransfers = Math.max(0, ...rows.map((row) => row.transfers ?? 0))
  const pendingRows = [
    { item: 'assets.other-verified', label: 'Other verified Arc assets', detail: 'More assets as they are verified' },
    { item: 'assets.new-tokens', label: 'Newly discovered tokens', detail: 'Shown with a shortened address until verified' },
  ]
  const grid = 'md:grid-cols-[1.5fr_1.6fr_0.6fr_0.6fr_1.4fr]'
  return (
    <section data-intel-section="assets" aria-label="Assets" className={CARD}>
      <CardHeader title="Verified asset transfers"
        subtitle={`Transfer, mint and burn events of verified Arc assets, last ${ctx.windowLabel}. Amounts are in token units, not USD.`}
        right={shared ? <StatusPill status={shared} /> : undefined} />
      <div className={`mt-3 hidden gap-4 border-b border-slate-100 pb-1.5 md:grid ${grid}`}>
        <span className={LABEL}>Asset</span><span className={LABEL}>Transfer activity</span><span className={`${LABEL} text-right`}>Mints</span>
        <span className={`${LABEL} text-right`}>Burns</span><span className={`${LABEL} text-right`}>Amount moved</span>
      </div>
      <ul className="mt-3 space-y-2 md:mt-0 md:space-y-0">
        {rows.map((row) => (
          <li key={row.item} {...markerProps(row.item, row.cell.status, row.cell.raw)}
            className={`rounded-xl border border-slate-100 p-3 md:grid md:items-center md:gap-4 md:rounded-none md:border-0 md:border-b md:px-0 md:py-2.5 ${grid}`}>
            <div className="flex min-w-0 items-center gap-2.5">
              <TokenAvatar symbol={row.symbol} />
              <div className="min-w-0">
                <p className="text-sm font-semibold text-slate-900">{row.symbol}</p>
                <Chip tone={toneFor(row.symbol)}>{ASSET_CATEGORY[row.symbol]}</Chip>
              </div>
            </div>
            {row.cell.status !== 'available' ? (
              <div className="mt-2 md:col-span-4 md:mt-0">{shared ? <ValueGap className="w-24" /> : <InlineStatus status={row.cell.status} />}</div>
            ) : row.transfers === undefined ? (
              <p className="mt-2 text-xs text-slate-500 md:col-span-4 md:mt-0">No verified transfers in this window</p>
            ) : (
              <>
                <div className="mt-2 md:mt-0">
                  <p className="flex items-baseline justify-between gap-2 text-sm">
                    <span className="text-slate-500 md:hidden">Transfers</span>
                    <span className="font-semibold tabular-nums text-slate-950">{formatCount(row.transfers)}</span>
                  </p>
                  <div className="mt-1"><ActivityBar value={row.transfers} max={maxTransfers} /></div>
                </div>
                {([['Mints', row.mints], ['Burns', row.burns]] as const).map(([label, value]) => (
                  <p key={label} className="mt-1 flex justify-between gap-3 text-sm md:mt-0 md:block md:text-right">
                    <span className="text-slate-500 md:hidden">{label}</span>
                    <span className="font-semibold tabular-nums text-slate-950">{formatCount(value ?? 0)}</span>
                  </p>
                ))}
                <p className="mt-1 flex justify-between gap-3 text-sm md:mt-0 md:block md:text-right">
                  <span className="shrink-0 text-slate-500 md:hidden">Amount moved</span>
                  {row.amount ? <span className="text-right font-semibold tabular-nums text-slate-950">{row.amount}</span> : <InlineStatus status="unavailable" />}
                </p>
              </>
            )}
          </li>
        ))}
        {pendingRows.map((row) => (
          <li key={row.item} {...markerProps(row.item, 'source_pending')}
            className={`flex items-center justify-between gap-3 rounded-xl border border-dashed border-slate-200 p-3 md:grid md:gap-4 md:rounded-none md:border-0 md:border-b md:border-dashed md:px-0 md:py-2.5 ${grid}`}>
            <div className="flex min-w-0 items-center gap-2.5">
              <span aria-hidden="true" className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-dashed border-slate-300 text-xs font-semibold text-slate-400">+</span>
              <div className="min-w-0">
                <p className="text-sm font-semibold text-slate-500">{row.label}</p>
                <p className="text-[11px] text-slate-400">{row.detail}</p>
              </div>
            </div>
            <div className="shrink-0 md:col-span-4 md:text-right"><InlineStatus status="source_pending" /></div>
          </li>
        ))}
      </ul>
    </section>
  )
}

// ---------------------------------------------------------------------------------------------------------------------
// Borrow: the existing guarded Circle Borrow Kit product (src/lib/mainnetBorrow.ts), shown read only. Every validated Arc
// cirBTC/USDC market is listed the same way, by market ID; none is selected, ranked or recommended. There is no Borrow
// route in Machina yet, so no action or market selection is offered; MAINNET_BORROW_WRITES_ENABLED decides the note.

function BorrowAsset({ symbol, role }: { symbol: string; role: string }) {
  return (
    <div className="flex min-w-0 flex-1 items-center gap-3 rounded-xl border border-slate-200 bg-[#f8faf7] px-3 py-2.5">
      <TokenAvatar symbol={symbol} />
      <div className="min-w-0">
        <p className="text-sm font-semibold text-slate-950">{symbol}</p>
        <p className="text-[11px] text-slate-500">{role}</p>
      </div>
    </div>
  )
}

type BorrowMarket = Extract<BorrowMarketState, { status: 'available' }>['markets'][number]

const BORROW_TERM_LABELS = ['Borrow APY', 'Liquidation LTV', 'Utilization', 'Available liquidity'] as const

// Only terms the Borrow Service reports for that market; a missing term is left out, never estimated.
function borrowTerms(market: BorrowMarket): [string, string][] {
  const reported: [string, string | null][] = [
    ['Borrow APY', market.borrowApy !== null ? formatRatioPercent(market.borrowApy) : null],
    ['Liquidation LTV', market.lltv !== null ? formatRatioPercent(market.lltv) : null],
    ['Utilization', market.utilization !== null ? formatRatioPercent(market.utilization) : null],
    ['Available liquidity', market.liquidity ? amountText(market.liquidity.amount, market.liquidity.token) : null],
  ]
  return reported.filter((entry): entry is [string, string] => entry[1] !== null)
}

// One read only market record. No control, badge or emphasis: every listed market is shown the same way.
function BorrowMarketRecord({ market, label, idStatus, termsStatus }: {
  market: BorrowMarket | null
  label: string
  idStatus: DisplayStatus
  termsStatus: DisplayStatus
}) {
  const terms = market ? borrowTerms(market) : []
  return (
    <li className="min-w-0 rounded-lg border border-slate-100 bg-[#f8faf7] px-3 py-2">
      <div {...markerProps('borrow.market-id', idStatus, market?.marketId)} className="flex items-center justify-between gap-2">
        <p className="text-xs font-semibold text-slate-800">{label}</p>
        {market
          ? <span title={market.marketId} className="font-mono text-[11px] text-slate-500">{shortenMarketId(market.marketId)}</span>
          : <ValueGap className="w-20" />}
      </div>
      <dl {...markerProps('borrow.market-terms', termsStatus, market?.marketId)} className="mt-1.5 space-y-1">
        {market && !terms.length && <p className="text-[11px] text-slate-500">Terms are not reported yet</p>}
        {(market ? terms : BORROW_TERM_LABELS.map((term): [string, string | null] => [term, null])).map(([term, value]) => (
          <div key={term} className="flex items-baseline justify-between gap-3 text-xs">
            <dt className="text-slate-500">{term}</dt>
            <dd className="text-right font-semibold tabular-nums text-slate-950">{value ?? <ValueGap />}</dd>
          </div>
        ))}
      </dl>
    </li>
  )
}

function BorrowSection({ borrowMarket }: { borrowMarket: BorrowMarketState }) {
  const markets = borrowMarket.status === 'available' ? borrowMarket.markets : []
  const listStatus: DisplayStatus = borrowMarket.status === 'loading' ? 'loading' : markets.length ? 'available' : 'unavailable'
  const termsStatus: DisplayStatus = listStatus !== 'available' ? listStatus
    : markets.some((market) => borrowTerms(market).length > 0) ? 'available' : 'unavailable'
  return (
    <section data-intel-section="borrow" aria-label="Borrow on Arc" className={CARD}>
      <CardHeader title="Borrow on Arc" subtitle="Powered by Circle Borrow Kit on Arc" icon={Banknote}
        right={<span className="inline-flex items-center rounded-full border border-slate-200 bg-slate-50 px-2.5 py-0.5 text-[11px] font-semibold text-slate-600">
          {MAINNET_BORROW_WRITES_ENABLED ? 'Read only here' : 'Preview'}
        </span>} />
      <div className="mt-4 grid gap-4 lg:grid-cols-[1fr_1.35fr]">
        <div {...markerProps('borrow.route', 'available')} className="min-w-0">
          <div className="flex flex-col items-stretch gap-2 sm:flex-row sm:items-center">
            <BorrowAsset symbol="cirBTC" role="Collateral" />
            <span className="flex justify-center text-slate-400">
              <ArrowDown className="h-4 w-4 sm:hidden" />
              <ArrowRight className="hidden h-4 w-4 sm:block" />
            </span>
            <BorrowAsset symbol="USDC" role="Borrow" />
          </div>
          <p className="mt-2 text-[11px] text-slate-500">Deposit cirBTC as collateral and borrow USDC from a Morpho market on Arc.</p>
        </div>
        <div {...markerProps('borrow.market-list', listStatus, markets.length || null)} className="min-w-0">
          <div className="flex items-center justify-between gap-2">
            <p className={LABEL}>Arc cirBTC / USDC markets</p>
            {listStatus !== 'available' && <InlineStatus status={listStatus} />}
          </div>
          <ul className={`mt-1.5 grid gap-2 ${markets.length > 1 ? 'sm:grid-cols-2' : ''}`}>
            {listStatus === 'available'
              ? markets.map((market, index) => (
                <BorrowMarketRecord key={market.marketId} market={market} label={`Market ${index + 1}`} idStatus="available" termsStatus={termsStatus} />
              ))
              : <BorrowMarketRecord market={null} label="Market" idStatus={listStatus} termsStatus={listStatus} />}
          </ul>
          <p className="mt-1.5 text-[11px] text-slate-400">
            {listStatus === 'available'
              ? 'Read only from Circle Borrow Kit. Listed by market ID; the order is not a ranking.'
              : listStatus === 'loading' ? 'Reading market terms from Circle Borrow Kit' : 'Market terms could not be read right now.'}
          </p>
        </div>
      </div>
      <div {...markerProps('borrow.action', 'source_pending')} className="mt-4 flex items-start gap-2 rounded-lg border border-dashed border-slate-200 px-3 py-2">
        <Clock className="mt-0.5 h-3.5 w-3.5 shrink-0 text-slate-400" />
        <p className="text-xs text-slate-600">
          {MAINNET_BORROW_WRITES_ENABLED
            ? 'Borrowing is not offered from this dashboard.'
            : 'Preview only. Borrowing from Machina is not enabled yet, so no wallet action is offered here.'}
        </p>
      </div>
    </section>
  )
}

function amountText(amount: string, token: string): string | null {
  const shown = formatDecimalString(amount)
  return shown === null ? null : `${shown} ${token}`
}

// ---------------------------------------------------------------------------------------------------------------------
// Lending

type EventField = { label: string; field: string; dot: string }
const SUPPLY: EventField = { label: 'Supply', field: 'supplyCount', dot: 'bg-[#2F6E0C]' }
const WITHDRAW: EventField = { label: 'Withdraw', field: 'withdrawCount', dot: 'bg-[#9CCB7F]' }
const BORROW: EventField = { label: 'Borrow', field: 'borrowCount', dot: 'bg-amber-400' }
const REPAY: EventField = { label: 'Repay', field: 'repayCount', dot: 'bg-sky-400' }
const LIQUIDATIONS: EventField = { label: 'Liquidations', field: 'liquidationCount', dot: 'bg-rose-400' }

function EventCell({ entry, value }: { entry: EventField; value: number | null }) {
  return (
    <div className="min-w-0 rounded-lg bg-[#f8faf7] px-2.5 py-1.5">
      <p className="flex items-center gap-1.5 truncate text-[11px] text-slate-500"><span className={`h-1.5 w-1.5 shrink-0 rounded-full ${entry.dot}`} />{entry.label}</p>
      {value !== null ? <p className="text-base font-semibold tabular-nums text-slate-950">{formatCount(value)}</p> : <p className="pt-1"><ValueGap /></p>}
    </div>
  )
}

// Event mix: real event counts side by side as one bar. Not a volume and not a share of value.
function EventMix({ fields, family }: { fields: EventField[]; family: FamilyWindow | null }) {
  const counts = fields.map((entry) => ({ ...entry, count: metricNumber(family, entry.field) }))
  if (counts.some((entry) => entry.count === null)) return null
  const total = counts.reduce((sum, entry) => sum + (entry.count ?? 0), 0)
  return (
    <div className="mt-3">
      <p className={LABEL}>Event mix</p>
      <div className="mt-1 flex h-2 w-full overflow-hidden rounded-full bg-slate-100">
        {total > 0 && counts.map((entry) => (entry.count ? (
          <span key={entry.field} data-mix-segment={entry.field} data-mix-count={entry.count} className={entry.dot}
            style={{ width: `${((entry.count ?? 0) / total) * 100}%` }} />
        ) : null))}
      </div>
      {total === 0 && <p className="mt-1 text-[11px] text-slate-400">No events in this window</p>}
    </div>
  )
}

function TokenFlows({ flows, labels, title = 'Amounts by token' }: { flows: TokenFlow[]; labels: string[]; title?: string }) {
  const shown = flows.slice(0, 4)
  return (
    <div className="mt-3">
      <p className={LABEL}>{title}</p>
      {!flows.length ? <p className="mt-1 text-[11px] text-slate-400">No token amounts in this window</p> : (
        <ul className="mt-1 space-y-1">
          {shown.map((flow) => (
            <li key={flow.token} title={flow.token} className="flex items-center justify-between gap-2 rounded-lg border border-slate-100 px-2 py-1.5">
              <span className="flex shrink-0 items-center gap-1.5">
                <TokenAvatar symbol={flow.label} size="sm" />
                <span className="text-xs font-semibold text-slate-800">{flow.label}</span>
              </span>
              {flow.decimals === null ? (
                <span className="text-right text-[11px] text-slate-500">Token details are not verified yet</span>
              ) : (
                <span className="flex min-w-0 flex-wrap justify-end gap-x-2 text-right text-[11px] text-slate-500">
                  {labels.map((label, index) => (
                    <span key={label}>{label} <span className="font-semibold tabular-nums text-slate-900">{formatFlowAmount(flow, index)}</span></span>
                  ))}
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
      {flows.length > shown.length && <p className="mt-1 text-[11px] text-slate-400">and {flows.length - shown.length} more tokens</p>}
    </div>
  )
}

// USD value of one protocol's amounts over the window, per action (never added across actions, directions or protocols).
type UsdField = readonly [label: string, field: string]
const PROTOCOL_USD_FIELDS: Record<'aaveV4' | 'morphoBlue' | 'morphoVaultsV2' | 'cctp' | 'gateway' | 'across', readonly UsdField[]> = {
  aaveV4: [['Supplied', 'suppliedUsdMicros'], ['Withdrawn', 'withdrawnUsdMicros'], ['Borrowed', 'borrowedUsdMicros'], ['Repaid', 'repaidUsdMicros'],
    ['Debt liquidated', 'liquidatedDebtUsdMicros']],
  morphoBlue: [['Supplied', 'suppliedUsdMicros'], ['Withdrawn', 'withdrawnUsdMicros'], ['Borrowed', 'borrowedUsdMicros'], ['Repaid', 'repaidUsdMicros'],
    ['Collateral added', 'collateralSuppliedUsdMicros'], ['Collateral removed', 'collateralWithdrawnUsdMicros']],
  morphoVaultsV2: [['Deposited', 'depositedUsdMicros'], ['Withdrawn', 'withdrawnUsdMicros']],
  cctp: [['Outbound', 'outboundUsdMicros'], ['Inbound', 'inboundUsdMicros']],
  gateway: [['Deposit', 'depositUsdMicros'], ['Sent', 'outboundBurnUsdMicros'], ['Received', 'inboundMintUsdMicros'], ['Withdraw', 'withdrawalUsdMicros']],
  across: [['Deposits from Arc', 'depositUsdMicros'], ['Fills on Arc', 'fillUsdMicros']],
}

function protocolUsdStatus(ctx: ViewContext, entry: ProtocolUsd | null | undefined): DisplayStatus {
  if (ctx.mode !== 'ready') return liveStatus(ctx, null)
  if (!entry) return 'source_pending'
  if (entry.status === 'available' && entry.values) return 'available'
  return entry.reason === 'insufficient_coverage' ? 'collecting' : 'unavailable'
}

function UsdValues({ ctx, item, name }: { ctx: ViewContext; item: string; name: keyof typeof PROTOCOL_USD_FIELDS }) {
  const entry = ctx.summary?.protocolUsd?.[name]
  const status = protocolUsdStatus(ctx, entry)
  const values = status === 'available' ? entry?.values ?? null : null
  const rows = PROTOCOL_USD_FIELDS[name].map(([label, field]) => [label, values?.[field]] as const)
    .filter(([label, micros]) => typeof micros === 'string' && /^\d+$/.test(micros) && (micros !== '0' || !label.startsWith('Debt')))
  const note = status === 'collecting' ? collectingText(ctx) : status === 'source_pending' ? 'Verified data does not include protocol USD valuations yet.'
    : status === 'unavailable' && ctx.mode === 'ready' ? reasonText(entry?.reason) : noteFor(ctx, status)
  return (
    <div {...markerProps(item, status)} className="mt-3 rounded-lg border border-slate-100 px-2.5 py-2">
      <div className="flex items-center justify-between gap-2">
        <p className={LABEL}>USD value, last {ctx.windowLabel}</p>
        {status !== 'available' && <InlineStatus status={status} />}
      </div>
      {values ? (
        <dl className="mt-1 grid grid-cols-2 gap-x-3 gap-y-0.5">
          {rows.map(([label, micros]) => (
            <div key={label} className="flex items-baseline justify-between gap-2 text-[11px]">
              <dt className="truncate text-slate-500">{label}</dt>
              <dd className="font-semibold tabular-nums text-slate-900" title={formatUsdMicros(micros as string)}>{usdMicrosToNumber(micros) === null
                ? formatUsdMicros(micros as string) : usdText(usdMicrosToNumber(micros) as number)}</dd>
            </div>
          ))}
        </dl>
      ) : status === 'loading' ? <p className="pt-1"><ValueGap /></p> : <p className="mt-0.5 text-[11px] leading-4 text-slate-500">{note}</p>}
      {values && <p className="mt-1 text-[10px] leading-4 text-slate-400">Each action is valued on its own with that hour's verified prices and never added together.</p>}
    </div>
  )
}

function ProtocolCard({ item, cell, title, subtitle, category, children }: {
  item: string
  cell: Cell
  title: string
  subtitle: string
  category: string
  children: ReactNode
}) {
  return (
    <div {...markerProps(item, cell.status, cell.raw)} className={`${CARD} min-w-0`}>
      <CardHeader title={title} subtitle={subtitle} right={cell.status === 'available' ? <Chip>{category}</Chip> : <StatusPill status={cell.status} />} />
      {children}
      {cell.status !== 'available' && cell.note && <p className="mt-3 text-[11px] text-slate-500">{cell.note}</p>}
    </div>
  )
}

function LendingSection({ ctx }: { ctx: ViewContext }) {
  const aave = ctx.summary?.lending.aaveV4 ?? null
  const blue = ctx.summary?.lending.morphoBlue ?? null
  const vaults = ctx.summary?.lending.morphoVaultsV2 ?? null
  const cards = [
    {
      item: 'lending.aave', usdItem: 'lending.aave-usd', usd: 'aaveV4' as const, title: 'Aave', category: 'Lending market',
      subtitle: `Lending events, last ${ctx.windowLabel}`, family: aave,
      total: metricSum(aave, AAVE_ACTIONS), primary: [SUPPLY, WITHDRAW, BORROW, REPAY], secondary: [LIQUIDATIONS],
      flows: tokenFlows(objectEntries(aave?.metrics?.reserves).map(([, entry]) => ({ token: entry.underlying, decimals: entry.decimals,
        amounts: [entry.suppliedRaw, entry.borrowedRaw] }))),
      flowLabels: ['Supplied', 'Borrowed'],
    },
    {
      item: 'lending.morpho-blue', usdItem: 'lending.morpho-blue-usd', usd: 'morphoBlue' as const, title: 'Morpho Blue', category: 'Lending market',
      subtitle: `Market events, last ${ctx.windowLabel}`, family: blue,
      total: metricSum(blue, MORPHO_BLUE_ACTIONS), primary: [SUPPLY, WITHDRAW, BORROW, REPAY],
      secondary: [{ label: 'Collateral +', field: 'supplyCollateralCount', dot: 'bg-teal-500' }, { label: 'Collateral -', field: 'withdrawCollateralCount', dot: 'bg-teal-200' },
        LIQUIDATIONS, { label: 'New markets', field: 'marketCreatedCount', dot: 'bg-slate-300' }],
      flows: tokenFlows(objectEntries(blue?.metrics?.markets).map(([, entry]) => {
        const unit = (entry.units as { loanToken?: { symbol?: unknown; decimals?: unknown } } | undefined)?.loanToken
        return { token: entry.loanToken, symbol: unit?.symbol, decimals: unit?.decimals, amounts: [entry.suppliedRaw, entry.borrowedRaw] }
      })),
      flowLabels: ['Supplied', 'Borrowed'],
    },
    {
      item: 'lending.morpho-vaults', usdItem: 'lending.morpho-vaults-usd', usd: 'morphoVaultsV2' as const, title: 'Morpho Vaults', category: 'Vaults',
      subtitle: `Vault deposits and withdrawals, last ${ctx.windowLabel}`, family: vaults,
      total: metricSum(vaults, MORPHO_VAULT_ACTIONS),
      primary: [{ label: 'Deposits', field: 'depositCount', dot: 'bg-[#2F6E0C]' }, { label: 'Withdrawals', field: 'withdrawCount', dot: 'bg-[#9CCB7F]' }],
      secondary: [] as EventField[],
      flows: tokenFlows(objectEntries(vaults?.metrics?.vaults).map(([, entry]) => {
        const unit = (entry.units as { asset?: { symbol?: unknown; decimals?: unknown } } | undefined)?.asset
        return { token: entry.asset, symbol: unit?.symbol, decimals: unit?.decimals, amounts: [entry.depositedAssetsRaw, entry.withdrawnAssetsRaw] }
      })),
      flowLabels: ['Deposited', 'Withdrawn'],
    },
  ]
  return (
    <section data-intel-section="lending" aria-label="Lending" className="grid gap-4 lg:grid-cols-3">
      {cards.map((card) => {
        const cell = numberCell(ctx, card.family, card.total, formatCount)
        const available = cell.status === 'available'
        return (
          <ProtocolCard key={card.item} item={card.item} cell={cell} title={card.title} subtitle={card.subtitle} category={card.category}>
            <div className="mt-3 grid grid-cols-2 gap-2">
              {card.primary.map((entry) => <EventCell key={entry.field} entry={entry} value={available ? metricNumber(card.family, entry.field) : null} />)}
            </div>
            {card.secondary.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1">
                {card.secondary.map((entry) => {
                  const value = available ? metricNumber(card.family, entry.field) : null
                  return (
                    <span key={entry.field} className="inline-flex items-center gap-1.5 text-[11px] text-slate-500">
                      <span className={`h-1.5 w-1.5 rounded-full ${entry.dot}`} />{entry.label}
                      {value !== null ? <span className="font-semibold tabular-nums text-slate-900">{formatCount(value)}</span> : <ValueGap className="w-5" />}
                    </span>
                  )
                })}
              </div>
            )}
            {available && <EventMix fields={[...card.primary, ...card.secondary]} family={card.family} />}
            {available && <TokenFlows flows={card.flows} labels={card.flowLabels} />}
            <UsdValues ctx={ctx} item={card.usdItem} name={card.usd} />
          </ProtocolCard>
        )
      })}
    </section>
  )
}

// ---------------------------------------------------------------------------------------------------------------------
// Cross-chain: directions stay separate and are never added into a bridge volume.

type Leg = { cell: Cell; amount: string | null }

function usdcLeg(ctx: ViewContext, family: FamilyWindow | null, countField: string, amountField: string): Leg {
  const cell = numberCell(ctx, family, metricNumber(family, countField), formatCount)
  const units = family?.metrics?.units as { decimals?: unknown; symbol?: unknown } | undefined
  const raw = metricAmount(family, amountField)
  const amount = cell.status === 'available' && raw !== null && isFiniteNumber(units?.decimals) && typeof units?.symbol === 'string'
    ? `${formatTokenAmount(raw, units.decimals)} ${units.symbol}` : null
  return { cell, amount }
}

const DIRECTION = {
  out: { icon: ArrowUpRight, tone: 'bg-[#eef7e8] text-[#2F6E0C]', bar: 'bg-[#2F6E0C]' },
  in: { icon: ArrowDownLeft, tone: 'bg-sky-50 text-sky-700', bar: 'bg-sky-400' },
}

function DirectionIcon({ direction }: { direction: 'out' | 'in' }) {
  const { icon: Icon, tone } = DIRECTION[direction]
  return <span className={`inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md ${tone}`}><Icon className="h-3.5 w-3.5" /></span>
}

function DirectionRow({ direction, label, detail, leg, max }: { direction: 'out' | 'in'; label: string; detail: string; leg: Leg; max: number }) {
  const available = leg.cell.status === 'available'
  return (
    <div className="py-2">
      <div className="flex items-center justify-between gap-3">
        <p className="flex min-w-0 items-center gap-2">
          <DirectionIcon direction={direction} />
          <span className="min-w-0">
            <span className="block text-sm font-medium text-slate-800">{label}</span>
            <span className="block text-[11px] text-slate-400">{detail}</span>
          </span>
        </p>
        {available
          ? <p className="shrink-0 text-right text-sm font-semibold tabular-nums text-slate-950">{leg.cell.text} <span className="text-[11px] font-normal text-slate-500">transfers</span></p>
          : <ValueGap />}
      </div>
      <div className="mt-1.5"><ActivityBar value={available ? Number(leg.cell.raw) : null} max={max} barClass={DIRECTION[direction].bar} /></div>
      {available && <p className="mt-1 text-right text-xs tabular-nums text-slate-500">{leg.amount ?? 'Amount not verified'}</p>}
    </div>
  )
}

function LegCell({ label, direction, leg }: { label: string; direction?: 'out' | 'in'; leg: Leg }) {
  const available = leg.cell.status === 'available'
  return (
    <div className="min-w-0 rounded-lg bg-[#f8faf7] px-2.5 py-2">
      <p className="flex items-center gap-1.5 text-[11px] text-slate-500">{direction && <DirectionIcon direction={direction} />}{label}</p>
      {available ? (
        <>
          <p className="mt-0.5 text-base font-semibold tabular-nums text-slate-950">{leg.cell.text}<span className="ml-1 text-[11px] font-normal text-slate-500">transfers</span></p>
          <p className="truncate text-[11px] tabular-nums text-slate-500">{leg.amount ?? 'Amount not verified'}</p>
        </>
      ) : <p className="pt-1.5"><ValueGap /></p>}
    </div>
  )
}

function CrossChainSection({ ctx }: { ctx: ViewContext }) {
  const cctp = ctx.summary?.crossChain.cctp ?? null
  const gateway = ctx.summary?.crossChain.gateway ?? null
  const across = ctx.summary?.crossChain.across ?? null
  const cctpCell = numberCell(ctx, cctp, metricSum(cctp, ['outboundTransferCount', 'inboundMintCount']), formatCount)
  const gatewayCell = numberCell(ctx, gateway, metricSum(gateway, ['depositCount', 'outboundBurnCount', 'inboundMintCount', 'withdrawalCompletedCount']), formatCount)
  const acrossCell = numberCell(ctx, across, metricSum(across, ['depositCount', 'fillCount']), formatCount)
  const outbound = usdcLeg(ctx, cctp, 'outboundTransferCount', 'outboundAmountRaw')
  const inbound = usdcLeg(ctx, cctp, 'inboundMintCount', 'inboundAmountRaw')
  const cctpMax = Math.max(0, ...[outbound, inbound].map((leg) => (leg.cell.status === 'available' ? Number(leg.cell.raw) : 0)))
  const acrossFlows = (field: string, amountField: string) => tokenFlows(objectEntries(across?.metrics?.[field]).map(([token, entry]) => {
    const unit = entry.units as { symbol?: unknown; decimals?: unknown } | undefined
    return { token, symbol: unit?.symbol, decimals: unit?.decimals, amounts: [entry[amountField]] }
  }))
  const acrossLegs = [
    { key: 'deposits', direction: 'out' as const, label: 'Deposits from Arc', cell: numberCell(ctx, across, metricNumber(across, 'depositCount'), formatCount),
      flows: acrossFlows('depositByToken', 'inputAmountRaw'), title: 'Deposited by token' },
    { key: 'fills', direction: 'in' as const, label: 'Fills on Arc', cell: numberCell(ctx, across, metricNumber(across, 'fillCount'), formatCount),
      flows: acrossFlows('fillByToken', 'outputAmountRaw'), title: 'Filled by token' },
  ]
  return (
    <section data-intel-section="cross-chain" aria-label="Cross-chain" className="grid gap-4 lg:grid-cols-3">
      <ProtocolCard item="cross-chain.cctp" cell={cctpCell} title="CCTP" subtitle={`USDC transfers to and from Arc, last ${ctx.windowLabel}`} category="USDC bridge">
        <div className="mt-2 divide-y divide-slate-100">
          <DirectionRow direction="out" label="Outbound" detail="From Arc to other chains" leg={outbound} max={cctpMax} />
          <DirectionRow direction="in" label="Inbound" detail="From other chains to Arc" leg={inbound} max={cctpMax} />
        </div>
        <p className="mt-1 text-[11px] leading-4 text-slate-400">Directions are shown separately and are never added together.</p>
        <UsdValues ctx={ctx} item="cross-chain.cctp-usd" name="cctp" />
      </ProtocolCard>
      <ProtocolCard item="cross-chain.gateway" cell={gatewayCell} title="Gateway" subtitle={`Unified USDC balance activity on Arc, last ${ctx.windowLabel}`} category="Unified balance">
        <div className="mt-3 grid grid-cols-2 gap-2">
          <LegCell label="Deposit" leg={usdcLeg(ctx, gateway, 'depositCount', 'depositAmountRaw')} />
          <LegCell label="Sent" direction="out" leg={usdcLeg(ctx, gateway, 'outboundBurnCount', 'outboundBurnAmountRaw')} />
          <LegCell label="Received" direction="in" leg={usdcLeg(ctx, gateway, 'inboundMintCount', 'inboundMintAmountRaw')} />
          <LegCell label="Withdraw" leg={usdcLeg(ctx, gateway, 'withdrawalCompletedCount', 'withdrawalAmountRaw')} />
        </div>
        <UsdValues ctx={ctx} item="cross-chain.gateway-usd" name="gateway" />
      </ProtocolCard>
      <ProtocolCard item="cross-chain.across" cell={acrossCell} title="Across" subtitle={`Bridge deposits and fills on Arc, last ${ctx.windowLabel}`} category="Bridge">
        <div className="mt-3 space-y-2">
          {acrossLegs.map((leg) => (
            <div key={leg.key} className="rounded-lg border border-slate-100 px-3 py-2">
              <div className="flex items-center justify-between gap-3">
                <p className="flex min-w-0 items-center gap-2"><DirectionIcon direction={leg.direction} /><span className="text-sm font-medium text-slate-800">{leg.label}</span></p>
                {leg.cell.status === 'available'
                  ? <p className="shrink-0 text-sm font-semibold tabular-nums text-slate-950">{leg.cell.text}</p>
                  : <ValueGap />}
              </div>
              {leg.cell.status === 'available' && <TokenFlows flows={leg.flows} labels={['Amount']} title={leg.title} />}
            </div>
          ))}
        </div>
        <UsdValues ctx={ctx} item="cross-chain.across-usd" name="across" />
      </ProtocolCard>
    </section>
  )
}

// ---------------------------------------------------------------------------------------------------------------------
// Ecosystem

const ECOSYSTEM_SLOTS = [
  { item: 'rwa-other.other-protocols', icon: Radar, title: 'Verified Arc protocol activity', detail: 'Activity of further verified Arc protocols' },
  { item: 'rwa-other.exchange-flows', icon: Store, title: 'Exchange flows', detail: 'Flows to and from verified exchange addresses' },
  { item: 'rwa-other.more-protocols', icon: Layers, title: 'Other verified Arc protocols', detail: 'New sources as they are verified' },
]

function RwaOtherSection({ ctx }: { ctx: ViewContext }) {
  const verified = ctx.summary?.assets.verifiedAssets ?? null
  const status = liveStatus(ctx, verified)
  const items = verifiedAssetItems(verified)
  const usycEntry = items?.find((entry) => entry.symbol === 'USYC')
  const usyc = usycEntry && usycEntry.transferCount + usycEntry.mintCount + usycEntry.burnCount > 0 ? usycEntry : undefined
  const shown: DisplayStatus = status === 'available' && !items ? 'unavailable' : status
  return (
    <section data-intel-section="rwa-other" aria-label="RWA and Other Verified Protocols" className="grid gap-4 lg:grid-cols-2">
      <div {...markerProps('rwa-other.rwa', shown, shown === 'available' ? usyc?.transferCount ?? 0 : null)} className={`${CARD} min-w-0`}>
        <CardHeader title="RWA" subtitle={`Tokenized real-world assets on Arc, last ${ctx.windowLabel}`} icon={Building2}
          right={shown !== 'available' ? <StatusPill status={shown} /> : undefined} />
        <div className="mt-3 rounded-xl border border-slate-100 bg-[#f8faf7] p-3">
          <div className="flex items-center gap-3">
            <TokenAvatar symbol="USYC" />
            <div className="min-w-0">
              <p className="text-sm font-semibold text-slate-950">USYC</p>
              <p className="mt-0.5 flex flex-wrap gap-1"><Chip tone={toneFor('USYC')}>Tokenized fund</Chip><Chip>RWA</Chip></p>
            </div>
          </div>
          {shown !== 'available' ? (
            <p className="mt-2 text-xs text-slate-500">{noteFor(ctx, shown)}</p>
          ) : usyc ? (
            <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
              {([['Transfers', formatCount(usyc.transferCount)], ['Mints', formatCount(usyc.mintCount)], ['Burns', formatCount(usyc.burnCount)],
                ['Amount moved', `${formatAmount(usyc.amountRaw, usyc.decimals)} USYC`]] as const).map(([label, value]) => (
                <div key={label} className="min-w-0 rounded-lg bg-white px-2.5 py-1.5 ring-1 ring-slate-100">
                  <p className="text-[11px] text-slate-500">{label}</p>
                  <p className="truncate text-sm font-semibold tabular-nums text-slate-950">{value}</p>
                </div>
              ))}
            </div>
          ) : (
            <p className="mt-2 text-xs text-slate-500">No verified transfers in this window</p>
          )}
          <p className="mt-2 text-[11px] text-slate-400">Amounts are in token units, not USD.</p>
        </div>
      </div>
      <div className={`${CARD} min-w-0`}>
        <CardHeader title="Other Verified Protocols" subtitle="Permanent places for further verified Arc sources" right={<StatusPill status="source_pending" />} />
        <div className="mt-3 grid gap-2 sm:grid-cols-3">
          {ECOSYSTEM_SLOTS.map(({ item, icon: Icon, title, detail }) => (
            <div key={item} {...markerProps(item, 'source_pending')} className="min-w-0 rounded-lg border border-dashed border-slate-200 px-3 py-2.5">
              <Icon className="h-4 w-4 text-slate-400" />
              <p className="mt-1.5 text-xs font-semibold text-slate-700">{title}</p>
              <p className="text-[11px] leading-4 text-slate-500">{detail}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  )
}

// ---------------------------------------------------------------------------------------------------------------------
// Dashboard (pure: renders from props only) and the data-loading wrapper.

export type ArcIntelligenceDashboardProps = {
  selectedWindow: ArcIntelligenceWindow
  // Load result of the selected window; null while its first load runs (or for a window that is never requested).
  data: ArcIntelligenceLoad | null
  refreshing?: boolean
  lastVerifiedThrough?: string | null
  onWindowChange?: (window: ArcIntelligenceWindow) => void
  onRefresh?: () => void
  // Read only Borrow Kit market for the Borrow card; not tied to the selected window.
  borrowMarket?: BorrowMarketState
  initialDexView?: 'volume' | 'swaps'
  // Arc explorer base URL for transaction links (the page passes its configured Arc explorer)
  explorerUrl?: string | null
  initialActivityType?: ArcActivityType
}

export function ArcIntelligenceDashboard({ selectedWindow, data, refreshing = false, lastVerifiedThrough = null, onWindowChange,
  onRefresh, borrowMarket = { status: 'loading' }, initialDexView = 'volume', explorerUrl = null, initialActivityType = 'all' }: ArcIntelligenceDashboardProps) {
  const windowLabel = ARC_INTELLIGENCE_WINDOWS.find((entry) => entry.id === selectedWindow)?.label ?? selectedWindow
  const supported = ARC_INTELLIGENCE_BACKEND_WINDOWS[selectedWindow]
  const loaded = supported && data && data.window === selectedWindow ? data : null
  const mode: Mode = !supported ? 'history' : !loaded ? 'loading' : loaded.failed || !loaded.summary ? 'failed' : 'ready'
  const summary = mode === 'ready' ? loaded?.summary ?? null : null
  const timeseries = mode === 'ready' ? loaded?.timeseries ?? null : null
  const windowHours = summary?.window.hours ?? (selectedWindow === '30d' ? 720 : selectedWindow === '7d' ? 168 : 24)
  const storedHours = summary ? Math.min(summary.coverage.storedHours, windowHours) : 0
  const coverage = selectedWindow === '30d' ? summary?.window.coverage : undefined
  const partialHistory = coverage?.status === 'partial'
  const progress = mode === 'ready' && storedHours > 0 && storedHours < windowHours ? ` (${storedHours} of ${windowHours} hours so far)` : ''
  const days = selectedWindow === '30d' ? 30 : 7
  const historyNote = `The ${windowLabel} view fills in once ${days} full days of verified history are stored.`
  const ctx: ViewContext = { mode, windowLabel: partialHistory ? `${coverage.availableHours} verified hours within 30D` : windowLabel,
    period: selectedWindow === '24h' ? 'hour' : 'day', windowHours: selectedWindow === '30d' ? 720 : selectedWindow === '7d' ? 168 : 24,
    historyNote, summary, timeseries,
    collectingNote: 'History is still being collected', pools: mode === 'ready' ? loaded?.pools ?? null : null,
    activity: mode === 'ready' ? loaded?.activity ?? null : null, explorerUrl }
  const verifiedThrough = summary?.freshness.verifiedThrough ?? timeseries?.freshness.verifiedThrough ?? lastVerifiedThrough
  const networkCollecting = mode === 'ready' && windowStatus(summary?.network) === 'collecting'

  const header = (
    <>
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <div className="flex items-center gap-2.5">
            <span className="inline-flex h-9 w-9 items-center justify-center rounded-xl bg-[#eef7e8] text-[#2F6E0C]">
              <Activity className="h-5 w-5" />
            </span>
            <h2 className="text-xl font-bold tracking-tight text-slate-950">Arc Intelligence</h2>
          </div>
          <p className="mt-1.5 text-sm text-slate-500">Verified Arc network activity</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div role="tablist" aria-label="Time window" className="flex gap-1.5">
            {ARC_INTELLIGENCE_WINDOWS.map((entry) => (
              <TabButton key={entry.id} selected={entry.id === selectedWindow} onClick={() => onWindowChange?.(entry.id)}
                marker={markerProps(`window.${entry.id}`, ARC_INTELLIGENCE_BACKEND_WINDOWS[entry.id] ? 'available' : 'collecting')}>
                {entry.label}
              </TabButton>
            ))}
          </div>
          <button type="button" onClick={onRefresh} disabled={!supported || refreshing}
            className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 transition-colors hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50">
            <RefreshCw className={`h-3.5 w-3.5 ${refreshing ? 'animate-spin' : ''}`} />
            Refresh
          </button>
        </div>
      </div>
      <p className="text-xs text-slate-500">
        {verifiedThrough ? <>Verified through <span className="font-semibold text-slate-700">{formatUtcDateTime(verifiedThrough)}</span></> : 'Verified data, updated every hour'}
      </p>
      {mode === 'history' && (
        <Banner tone="info">History is still being collected. {historyNote}</Banner>
      )}
      {mode === 'failed' && <Banner tone="warn">Arc Intelligence data could not be loaded right now. The layout stays in place; try Refresh in a moment.</Banner>}
      {coverage && (
        <Banner tone="info"><span data-history-coverage={coverage.status}>
          <strong>{partialHistory ? 'Partial history' : 'Full 30D history'}</strong>: {coverage.availableHours} / {coverage.expectedHours} verified hours.
          {' '}{formatUtcDateTime(coverage.start)} – {formatUtcDateTime(coverage.end)}.
          {' '}{coverage.completedUtcDays} completed UTC days.
          {partialHistory && ' Values show available verified history within the selected 30D window.'}
          {' '}Incomplete day intervals remain gaps; missing hours are never counted as zero.
        </span></Banner>
      )}
      {networkCollecting && (
        <Banner tone="info">History is still being collected{progress}. {windowLabel} totals appear once every hour of the window is verified; the {selectedWindow === '24h'
          ? 'hourly charts already show each verified hour' : 'daily charts already show each complete day'}.</Banner>
      )}
      {mode === 'ready' && summary?.freshness.stale && <Banner tone="warn">Updates are delayed. The latest verified hour is older than usual.</Banner>}
    </>
  )

  return (
    <div data-arc-intelligence="" className="space-y-4 rounded-3xl border border-[#dfead8] bg-[#f8faf7] p-4 sm:p-6">
      <NetworkSection ctx={ctx} header={header} />
      <div className="grid gap-4 lg:grid-cols-5">
        <VolumeChartSection ctx={ctx} initialView={initialDexView} />
        <ActiveAddressesChartSection ctx={ctx} />
      </div>
      <GroupHeader title="Markets" />
      <div className="grid gap-4 lg:grid-cols-3">
        <TopProtocolsSection ctx={ctx} />
        <TopPoolsSection ctx={ctx} version="v3" />
        <TopPoolsSection ctx={ctx} version="v4" />
      </div>
      <GroupHeader title="Recent Activity" />
      <RecentActivitySection ctx={ctx} initialType={initialActivityType} />
      <GroupHeader title="Assets" icon={Coins} />
      <AssetsSection ctx={ctx} />
      <GroupHeader title="New Token Launches" icon={Rocket} />
      <LaunchesSection ctx={ctx} />
      <GroupHeader title="Borrow" icon={Banknote} />
      <BorrowSection borrowMarket={borrowMarket} />
      <GroupHeader title="Lending" icon={Landmark} />
      <LendingSection ctx={ctx} />
      <GroupHeader title="Cross-chain" icon={ArrowLeftRight} />
      <CrossChainSection ctx={ctx} />
      <GroupHeader title="Ecosystem" icon={Building2} />
      <RwaOtherSection ctx={ctx} />
    </div>
  )
}

export default function ArcIntelligenceOverview({ explorerUrl = null }: { explorerUrl?: string | null } = {}) {
  const [selectedWindow, setSelectedWindow] = useState<ArcIntelligenceWindow>('24h')
  const [loads, setLoads] = useState<Partial<Record<ArcIntelligenceWindow, ArcIntelligenceLoad>>>({})
  const [refreshing, setRefreshing] = useState(false)
  const [borrowMarket, setBorrowMarket] = useState<BorrowMarketState>({ status: 'loading' })
  const controller = useRef<AbortController | null>(null)

  // Keep the selected view fresh as new stored hours arrive; GET reads start no indexing work.
  const load = useCallback(async (target: ArcIntelligenceWindow) => {
    if (!ARC_INTELLIGENCE_BACKEND_WINDOWS[target]) return
    controller.current?.abort()
    const current = new AbortController()
    controller.current = current
    setRefreshing(true)
    const result = await loadArcIntelligence(target, { signal: current.signal })
    if (current.signal.aborted) return
    setLoads((previous) => ({ ...previous, [target]: result }))
    setRefreshing(false)
  }, [])

  useEffect(() => {
    if (!loads[selectedWindow]) void load(selectedWindow)
    const interval = selectedWindow === '30d' ? window.setInterval(() => void load(selectedWindow), 60_000) : null
    return () => { if (interval !== null) window.clearInterval(interval) }
  }, [selectedWindow])

  useEffect(() => () => controller.current?.abort(), [])

  // Borrow card: one read only market listing through the existing Borrow Kit boundary. No wallet, no write.
  useEffect(() => {
    let active = true
    void loadArcBorrowMarkets().then((state) => {
      if (active) setBorrowMarket(state)
    })
    return () => {
      active = false
    }
  }, [])

  const lastVerifiedThrough = Object.values(loads).map((entry) => entry?.summary?.freshness.verifiedThrough ?? null)
    .filter((value): value is string => Boolean(value)).sort().pop() ?? null

  return (
    <ArcIntelligenceDashboard
      selectedWindow={selectedWindow}
      data={loads[selectedWindow] ?? null}
      refreshing={refreshing}
      lastVerifiedThrough={lastVerifiedThrough}
      onWindowChange={setSelectedWindow}
      onRefresh={() => void load(selectedWindow)}
      borrowMarket={borrowMarket}
      explorerUrl={explorerUrl}
    />
  )
}
