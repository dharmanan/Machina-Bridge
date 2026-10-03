import { ARC_INTELLIGENCE_BACKEND_WINDOWS, type ArcIntelligenceWindow } from '../config/arcIntelligenceUiScope'
import type { BorrowMarket } from './mainnetBorrow'

// Client for the compact Arc Intelligence API (summary.v1 / timeseries.v1) behind the /api/intelligence proxy, plus the
// small helpers the dashboard uses to turn it into display states. Missing evidence is never a number: helpers return
// null, and the dashboard shows a status instead.

export const SUMMARY_SCHEMA = 'machina.intelligence.summary.v1'
export const TIMESERIES_SCHEMA = 'machina.intelligence.timeseries.v1'

export type IntelligenceDataStatus = 'available' | 'collecting' | 'unavailable' | 'source_pending'

type BackendStatus = 'available' | 'unavailable' | 'not_supported'

export type UniqueCount = { status: BackendStatus; reason?: string; value: number | null }

export type NetworkWindow = {
  status: 'available' | 'unavailable'
  reason?: string
  start: string
  end: string
  blocks: number | null
  transactions: number | null
  transactionsPerSecond: number | null
  averageTransactionsPerBlock: number | null
  gasUsedRaw: string | null
  uniqueActiveAddresses: UniqueCount
  previous?: NetworkWindow
}

export type FamilyWindow = {
  status: 'available' | 'unavailable'
  reason?: string
  reasons?: string[]
  unavailableHours?: string[]
  start?: string
  end?: string
  metrics: Record<string, unknown> | null
  previous?: FamilyWindow
}

export type ArcFreshness = {
  checkpointHour: string
  verifiedThrough: string
  checkpointBlock: number
  latestCompleteHour: string
  lagHours: number
  stale: boolean
}

export type ArcSummary = {
  schema: typeof SUMMARY_SCHEMA
  window: { key: string; hours: number; start: string; end: string }
  freshness: ArcFreshness
  network: NetworkWindow
  assets: { usdc: FamilyWindow; verifiedAssets: FamilyWindow }
  dex: { uniswapV3: FamilyWindow; uniswapV4: FamilyWindow; officialV3Pools: { status: BackendStatus; count: number | null } }
  lending: { aaveV4: FamilyWindow; morphoBlue: FamilyWindow; morphoVaultsV2: FamilyWindow }
  crossChain: { cctp: FamilyWindow; gateway: FamilyWindow; across: FamilyWindow }
  coverage: { firstStoredHour: string; storedHours: number; checkpointHour: string; verifiedThrough: string }
}

export type TimeseriesFamily = { status: 'available' | 'unavailable'; reason?: string } & Record<string, unknown>

export type TimeseriesBucket = {
  start: string
  end: string
  status: 'committed' | 'not_stored'
  network: { blocks: number; transactions: number; uniqueActiveAddresses: number; gasUsedRaw: string } | null
  families: Record<string, TimeseriesFamily> | null
}

export type ArcTimeseries = {
  schema: typeof TIMESERIES_SCHEMA
  window: { key: string; hours: number; start: string; end: string }
  freshness: ArcFreshness
  buckets: TimeseriesBucket[]
}

export type ArcIntelligenceLoad = {
  window: ArcIntelligenceWindow
  summary: ArcSummary | null
  timeseries: ArcTimeseries | null
  // true when the data the selected window needs could not be loaded (network, proxy or schema failure)
  failed: boolean
}

// The only requests the dashboard makes. Windows the API cannot answer (7D, 30D) are never requested at all.
export const ARC_INTELLIGENCE_REQUESTS = Object.freeze({
  summary24h: '/api/intelligence?view=summary&window=24h',
  timeseries24h: '/api/intelligence?view=timeseries&window=24h',
})

// Verified Arc assets (same addresses and decimals as api/_lib/arc-intelligence/assets.js, checked by the dashboard
// verifier). Used only to name a token; any other address is shown shortened, never hidden.
export const ARC_KNOWN_TOKENS: Readonly<Record<string, { symbol: string; decimals: number }>> = Object.freeze({
  '0x3600000000000000000000000000000000000000': { symbol: 'USDC', decimals: 6 },
  '0xbef5f6d51cb62b58e6a8f77868681825c6fe21c1': { symbol: 'EURC', decimals: 6 },
  '0x171a4217b86a807a64eb94757db6849fb4bdbaa0': { symbol: 'cirBTC', decimals: 8 },
  '0x128cc466b61f542da60c70e3aa11c10e19b84edb': { symbol: 'WETH', decimals: 18 },
  '0x8a5d989bbb96929f689b0200f435f53da42bf490': { symbol: 'USYC', decimals: 6 },
})

export function shortenAddress(address: string): string {
  return /^0x[0-9a-fA-F]{40}$/.test(address) ? `${address.slice(0, 6)}...${address.slice(-4)}` : address
}

const WINDOW_REQUESTS: Partial<Record<ArcIntelligenceWindow, { summary: string; timeseries: string }>> = {
  '24h': { summary: ARC_INTELLIGENCE_REQUESTS.summary24h, timeseries: ARC_INTELLIGENCE_REQUESTS.timeseries24h },
}

type FetchLike = (url: string, init: { method: 'GET'; headers: Record<string, string>; signal?: AbortSignal }) => Promise<{
  ok: boolean
  json(): Promise<unknown>
}>

async function fetchObject(url: string, fetchImpl: FetchLike, signal?: AbortSignal): Promise<Record<string, unknown>> {
  const response = await fetchImpl(url, { method: 'GET', headers: { accept: 'application/json' }, signal })
  if (!response.ok) throw new Error('intelligence_unavailable')
  const payload: unknown = await response.json()
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('intelligence_unavailable')
  return payload as Record<string, unknown>
}

// Never rejects: every failure becomes `failed: true` with null data, so the dashboard keeps its full layout. A window
// without history in the API resolves immediately without any request; it is shown as still being collected.
export async function loadArcIntelligence(
  selected: ArcIntelligenceWindow,
  { fetchImpl, signal }: { fetchImpl?: FetchLike; signal?: AbortSignal } = {},
): Promise<ArcIntelligenceLoad> {
  const requests = ARC_INTELLIGENCE_BACKEND_WINDOWS[selected] ? WINDOW_REQUESTS[selected] : undefined
  if (!requests) return { window: selected, summary: null, timeseries: null, failed: false }
  const request = fetchImpl ?? (fetch as unknown as FetchLike)
  const [summary, timeseries] = await Promise.allSettled([
    fetchObject(requests.summary, request, signal),
    fetchObject(requests.timeseries, request, signal),
  ])
  const summaryValue = summary.status === 'fulfilled' && summary.value.schema === SUMMARY_SCHEMA
    ? summary.value as unknown as ArcSummary : null
  const timeseriesValue = timeseries.status === 'fulfilled' && timeseries.value.schema === TIMESERIES_SCHEMA
    ? timeseries.value as unknown as ArcTimeseries : null
  return { window: selected, summary: summaryValue, timeseries: timeseriesValue, failed: summaryValue === null }
}

// Display state of one backend window entry. insufficient_coverage means the window is still filling with history.
export function windowStatus(entry: { status: string; reason?: string } | null | undefined): IntelligenceDataStatus {
  if (!entry) return 'unavailable'
  if (entry.status === 'available') return 'available'
  if (entry.reason === 'insufficient_coverage') return 'collecting'
  return 'unavailable'
}

export function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

// A family metric, only when the family window is available and the value is a real number.
export function metricNumber(family: FamilyWindow | null | undefined, field: string): number | null {
  if (!family || family.status !== 'available' || !family.metrics) return null
  const value = family.metrics[field]
  return isFiniteNumber(value) ? value : null
}

// Sum of counters of one family; null unless every counter is present.
export function metricSum(family: FamilyWindow | null | undefined, fields: readonly string[]): number | null {
  const values = fields.map((field) => metricNumber(family, field))
  return values.every((value): value is number => value !== null) ? values.reduce((total, value) => total + value, 0) : null
}

export function metricAmount(family: FamilyWindow | null | undefined, field: string): string | null {
  if (!family || family.status !== 'available' || !family.metrics) return null
  const value = family.metrics[field]
  return typeof value === 'string' && /^\d+$/.test(value) ? value : null
}

export type VerifiedAssetItem = { symbol: string; address: string; decimals: number; transferCount: number; mintCount: number;
  burnCount: number; amountRaw: string }

export function verifiedAssetItems(family: FamilyWindow | null | undefined): VerifiedAssetItem[] | null {
  if (!family || family.status !== 'available' || !family.metrics || !Array.isArray(family.metrics.items)) return null
  return (family.metrics.items as unknown[]).filter((item): item is VerifiedAssetItem => {
    const candidate = item as VerifiedAssetItem
    return Boolean(candidate) && typeof candidate.symbol === 'string' && isFiniteNumber(candidate.transferCount)
      && isFiniteNumber(candidate.mintCount) && isFiniteNumber(candidate.burnCount) && isFiniteNumber(candidate.decimals)
      && typeof candidate.amountRaw === 'string' && /^\d+$/.test(candidate.amountRaw)
  })
}

// Relative change against an equal previous window; null when either side is missing or the base is zero.
export function percentChange(current: number | null, previous: number | null): number | null {
  if (current === null || previous === null || previous <= 0) return null
  return ((current - previous) / previous) * 100
}

export function formatCount(value: number): string {
  return Math.round(value).toLocaleString('en-US')
}

export function formatDecimal(value: number, digits = 2): string {
  return value.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits })
}

export function formatCompact(value: number): string {
  return new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(value)
}

export function formatSignedPercent(value: number): string {
  return `${value >= 0 ? '+' : ''}${value.toFixed(1)}%`
}

// Exact decimal formatting of a raw integer amount (BigInt, no floating point), grouped, truncated to `fractionDigits`
// decimals. A positive amount below the smallest shown decimal reads as "<0.01", never as zero.
export function formatTokenAmount(raw: string, decimals: number, fractionDigits = 2): string {
  const value = BigInt(raw)
  const base = 10n ** BigInt(decimals)
  const whole = value / base
  const fraction = (value % base).toString().padStart(decimals, '0').slice(0, fractionDigits).replace(/0+$/, '')
  if (value > 0n && whole === 0n && !fraction) return `<0.${'0'.repeat(Math.max(0, fractionDigits - 1))}1`
  return `${whole.toLocaleString('en-US')}${fraction ? `.${fraction}` : ''}`
}

// Large raw integers (gas units) in compact form, computed with BigInt.
export function formatCompactRaw(raw: string): string {
  const value = BigInt(raw)
  const units: [bigint, string][] = [[10n ** 12n, 'T'], [10n ** 9n, 'B'], [10n ** 6n, 'M'], [10n ** 3n, 'K']]
  for (const [size, suffix] of units) {
    if (value >= size) return `${(Number((value * 10n) / size) / 10).toLocaleString('en-US', { maximumFractionDigits: 1 })}${suffix}`
  }
  return value.toLocaleString('en-US')
}

const pad = (value: number) => String(value).padStart(2, '0')

export function formatUtcHour(iso: string): string {
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? '' : `${pad(date.getUTCHours())}:00`
}

export function formatUtcHourRange(start: string, end: string): string {
  return `${formatUtcHour(start)}-${formatUtcHour(end)} UTC`
}

export function formatUtcDateTime(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ''
  const month = date.toLocaleString('en-US', { month: 'short', timeZone: 'UTC' })
  return `${month} ${date.getUTCDate()}, ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())} UTC`
}

export function formatRatioPercent(value: number): string {
  return `${(value * 100).toLocaleString('en-US', { maximumFractionDigits: 2 })}%`
}

// A decimal string exactly as a service reports it ("1234.5678"), grouped and truncated to `digits` decimals, without
// floating point. A positive amount below the shown precision reads as "<0.01", never as zero.
export function formatDecimalString(value: string, digits = 2): string | null {
  if (!/^\d+(\.\d+)?$/.test(value)) return null
  const [whole, fraction = ''] = value.split('.')
  const shown = fraction.slice(0, digits).replace(/0+$/, '')
  const grouped = BigInt(whole).toLocaleString('en-US')
  if (grouped === '0' && !shown && /[1-9]/.test(fraction)) return `<0.${'0'.repeat(Math.max(0, digits - 1))}1`
  return `${grouped}${shown ? `.${shown}` : ''}`
}

// ---------------------------------------------------------------------------------------------------------------------
// Borrow on Arc: market terms of the existing guarded Circle Borrow Kit product (cirBTC collateral, USDC loan), read
// through Machina's own same-origin, read-only /api/borrow-markets proxy. The browser never calls Circle directly and
// never loads the Borrow Kit SDK for this card; writes stay behind MAINNET_BORROW_WRITES_ENABLED in
// src/lib/mainnetBorrow.ts and are never reached from here.
//
// Every validated Arc cirBTC/USDC Morpho market is kept: none is picked, preferred or hidden. Token identity is the
// verified registry identity (address, symbol, decimals), never a symbol alone. Markets are ordered by market ID for a
// stable display only; the order is not a ranking.

export const ARC_BORROW_COLLATERAL_TOKEN = '0x171a4217b86a807a64eb94757db6849fb4bdbaa0' // cirBTC
export const ARC_BORROW_LOAN_TOKEN = '0x3600000000000000000000000000000000000000' // USDC
export const ARC_BORROW_MARKETS_REQUEST = '/api/borrow-markets'
export const BORROW_MARKETS_SCHEMA = 'machina.borrow.markets.v2'

export type BorrowMarketState =
  | { status: 'loading' }
  | { status: 'available'; markets: BorrowMarket[] }
  | { status: 'unavailable' }

const HEX_ADDRESS = /^0x[0-9a-fA-F]{40}$/
const DECIMAL_STRING = /^\d+(\.\d+)?$/
const isRatioOrNull = (value: unknown) => value === null || (isFiniteNumber(value) && value >= 0)
const isDecimals = (value: unknown) => Number.isInteger(value) && (value as number) >= 0 && (value as number) <= 36
const isAsset = (value: unknown) => {
  const asset = value as Record<string, unknown> | null
  return Boolean(asset) && typeof asset === 'object' && typeof asset?.symbol === 'string' && asset.symbol.length > 0
    && typeof asset.address === 'string' && HEX_ADDRESS.test(asset.address) && isDecimals(asset.decimals)
}
const isAmountOrNull = (value: unknown) => {
  if (value === null) return true
  const amount = value as Record<string, unknown> | undefined
  return Boolean(amount) && typeof amount === 'object' && typeof amount?.token === 'string' && typeof amount.tokenAddress === 'string'
    && HEX_ADDRESS.test(amount.tokenAddress) && typeof amount.amount === 'string' && DECIMAL_STRING.test(amount.amount) && isDecimals(amount.decimals)
}

function isBorrowMarket(value: unknown): value is BorrowMarket {
  const market = value as Record<string, unknown> | null
  return Boolean(market) && typeof market === 'object' && typeof market?.marketId === 'string' && /^0x[0-9a-fA-F]{64}$/.test(market.marketId)
    && market.protocol === 'morpho' && isAsset(market.loanAsset) && isAsset(market.collateralAsset)
    && isRatioOrNull(market.lltv) && isRatioOrNull(market.borrowApy) && isRatioOrNull(market.utilization)
    && isAmountOrNull(market.borrowAssets) && isAmountOrNull(market.liquidity)
    && (market.refreshedAt === null || (typeof market.refreshedAt === 'string' && !Number.isNaN(Date.parse(market.refreshedAt))))
}

// Exact verified identity of one side of the pair: canonical address with the registry's symbol and decimals.
function isCanonical(asset: { symbol: string; address: string; decimals: number }, address: string) {
  const registry = ARC_KNOWN_TOKENS[address]
  return Boolean(registry) && asset.address.toLowerCase() === address && asset.symbol === registry.symbol && asset.decimals === registry.decimals
}

function isArcCirBtcUsdc(market: BorrowMarket) {
  const loanAmounts = [market.liquidity, market.borrowAssets].filter((amount) => amount !== null)
  return isCanonical(market.collateralAsset, ARC_BORROW_COLLATERAL_TOKEN) && isCanonical(market.loanAsset, ARC_BORROW_LOAN_TOKEN)
    && loanAmounts.every((amount) => amount?.tokenAddress.toLowerCase() === ARC_BORROW_LOAN_TOKEN)
}

// Never rejects. Fail closed: a malformed answer, a market whose identity is not exactly Arc cirBTC/USDC, or a repeated
// market ID makes the whole answer unavailable, and so does an answer without any market.
export async function loadArcBorrowMarkets(
  { fetchImpl, signal }: { fetchImpl?: FetchLike; signal?: AbortSignal } = {},
): Promise<BorrowMarketState> {
  try {
    const payload = await fetchObject(ARC_BORROW_MARKETS_REQUEST, fetchImpl ?? (fetch as unknown as FetchLike), signal)
    if (payload.schema !== BORROW_MARKETS_SCHEMA || !Array.isArray(payload.markets)) return { status: 'unavailable' }
    const markets = payload.markets as unknown[]
    if (!markets.every((entry) => isBorrowMarket(entry) && isArcCirBtcUsdc(entry))) return { status: 'unavailable' }
    const valid = markets as BorrowMarket[]
    const ids = valid.map((entry) => entry.marketId.toLowerCase())
    if (!valid.length || new Set(ids).size !== ids.length) return { status: 'unavailable' }
    return { status: 'available', markets: [...valid].sort((a, b) => (a.marketId.toLowerCase() < b.marketId.toLowerCase() ? -1 : 1)) }
  } catch {
    return { status: 'unavailable' }
  }
}

export function shortenMarketId(marketId: string): string {
  return /^0x[0-9a-fA-F]{64}$/.test(marketId) ? `${marketId.slice(0, 6)}...${marketId.slice(-4)}` : marketId
}
