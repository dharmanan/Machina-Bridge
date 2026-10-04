import { ARC_INTELLIGENCE_BACKEND_WINDOWS, type ArcIntelligenceWindow } from '../config/arcIntelligenceUiScope'
import type { BorrowMarket } from './mainnetBorrow'

// Client for the compact Arc Intelligence API (summary.v1 / timeseries.v1 / pools.v1 / activity.v1) behind the
// /api/intelligence proxy, plus the small helpers the dashboard uses to turn it into display states. Missing evidence is
// never a number: helpers return null, and the dashboard shows a status instead.

export const SUMMARY_SCHEMA = 'machina.intelligence.summary.v1'
export const TIMESERIES_SCHEMA = 'machina.intelligence.timeseries.v1'
export const POOLS_SCHEMA = 'machina.intelligence.pools.v1'
export const ACTIVITY_SCHEMA = 'machina.intelligence.activity.v1'

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

// A pool side. symbol and decimals come only from the verified Arc asset registry (native: Uniswap V4's currency 0x0, Arc's
// native USDC with 18 decimals); any other token keeps null and is shown by its shortened address.
export type PoolToken = { address: string; symbol: string | null; decimals: number | null; verified: boolean; native: boolean }

export type ArcPool = {
  pool: string
  createdBlock: number
  token0: PoolToken
  token1: PoolToken
  fee: number
  tickSpacing: number
  hooks: string | null
  // swap events of the pool in the window: the interim ranking, always shown as a count
  swapCount: number
  flowsRaw: { token0In: string; token0Out: string; token1In: string; token1Out: string }
}

// Top pools of one Uniswap version, ranked by swap count. USD volume and USD liquidity are source_pending.
export type ArcPools = {
  schema: typeof POOLS_SCHEMA
  protocol: 'v3' | 'v4'
  window: { key: string; hours: number; start: string; end: string }
  freshness: ArcFreshness
  status: 'available' | 'unavailable'
  reason: string | null
  ranking: { by: 'swap_count'; usdVolume: { status: 'source_pending' }; liquidityUsd: { status: 'source_pending' } }
  poolsTracked: number | null
  newPools: number | null
  pools: ArcPool[]
}

export type ArcActivityType = 'all' | 'swaps' | 'adds' | 'removes'
export const ARC_ACTIVITY_TYPES: readonly ArcActivityType[] = ['all', 'swaps', 'adds', 'removes']

// One verified DEX event. from: the transaction sender. to: only what the event itself records (Uniswap V3 swap
// recipient, V3 position owner, V4 liquidity sender); null when the event records none (Uniswap V4 swaps).
// amounts: raw signed integers as emitted (v3_pool_delta: positive = paid into the pool; v4_swap_delta: negative = paid
// into the pool), unsigned V3 liquidity amounts, or not_supported (V4 liquidity changes carry no token amounts).
export type ArcActivityRow = {
  time: string
  blockNumber: number
  logIndex: number
  txHash: string
  protocol: 'uniswap_v3' | 'uniswap_v4'
  kind: 'swap' | 'add' | 'remove'
  pool: string
  pair: { token0: PoolToken; token1: PoolToken; fee: number; tickSpacing: number; hooks: string | null }
  amounts: { status: 'available' | 'not_supported'; reason?: string; basis: 'v3_pool_delta' | 'v3_liquidity_amount' | 'v4_swap_delta' | 'none';
    amount0Raw: string | null; amount1Raw: string | null }
  from: string
  to: string | null
  toKind: 'swap_recipient' | 'liquidity_owner' | 'event_sender' | 'none'
}

export type ArcActivity = {
  schema: typeof ACTIVITY_SCHEMA
  type: ArcActivityType
  freshness: ArcFreshness
  status: 'available' | 'unavailable'
  reason: string | null
  limit: number
  rows: ArcActivityRow[]
}

export type ArcIntelligenceLoad = {
  window: ArcIntelligenceWindow
  summary: ArcSummary | null
  timeseries: ArcTimeseries | null
  // true when the data the selected window needs could not be loaded (network, proxy or schema failure)
  failed: boolean
  // 24H only. A read that failed or did not match its exact shape is null: the section shows a status, never a guess.
  pools?: { v3: ArcPools | null; v4: ArcPools | null }
  activity?: Record<ArcActivityType, ArcActivity | null>
}

// The only requests the dashboard makes. Windows the API cannot answer (7D, 30D) are never requested at all.
export const ARC_INTELLIGENCE_REQUESTS = Object.freeze({
  summary24h: '/api/intelligence?view=summary&window=24h',
  timeseries24h: '/api/intelligence?view=timeseries&window=24h',
  poolsV3_24h: '/api/intelligence?view=pools&protocol=v3&window=24h',
  poolsV4_24h: '/api/intelligence?view=pools&protocol=v4&window=24h',
  activityAll: '/api/intelligence?view=activity&type=all',
  activitySwaps: '/api/intelligence?view=activity&type=swaps',
  activityAdds: '/api/intelligence?view=activity&type=adds',
  activityRemoves: '/api/intelligence?view=activity&type=removes',
})
const ACTIVITY_REQUESTS: Readonly<Record<ArcActivityType, string>> = Object.freeze({ all: ARC_INTELLIGENCE_REQUESTS.activityAll,
  swaps: ARC_INTELLIGENCE_REQUESTS.activitySwaps, adds: ARC_INTELLIGENCE_REQUESTS.activityAdds, removes: ARC_INTELLIGENCE_REQUESTS.activityRemoves })

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

export function shortenHash(hash: string): string {
  return /^0x[0-9a-fA-F]{64}$/.test(hash) ? `${hash.slice(0, 6)}...${hash.slice(-4)}` : hash
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

// Exact shape checks for pools.v1 and activity.v1: a single malformed field makes the whole answer null (fail closed).
const HEX_ADDRESS_LOWER = /^0x[0-9a-f]{40}$/
const HEX_POOL_ID = /^0x[0-9a-f]{64}$/
const UNSIGNED = /^\d+$/
const SIGNED = /^-?\d+$/
const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value)
const isCount = (value: unknown) => Number.isSafeInteger(value) && (value as number) >= 0
const isNullableCount = (value: unknown) => value === null || isCount(value)
const isRawUnsigned = (value: unknown) => typeof value === 'string' && UNSIGNED.test(value)

function isPoolToken(value: unknown): value is PoolToken {
  if (!isRecord(value) || typeof value.address !== 'string' || !HEX_ADDRESS_LOWER.test(value.address) || typeof value.verified !== 'boolean'
    || typeof value.native !== 'boolean') return false
  return value.verified
    ? typeof value.symbol === 'string' && value.symbol.length > 0 && Number.isInteger(value.decimals) && (value.decimals as number) >= 0 && (value.decimals as number) <= 36
    : value.symbol === null && value.decimals === null
}

function isPairFields(value: Record<string, unknown>, protocol: 'v3' | 'v4') {
  return isPoolToken(value.token0) && isPoolToken(value.token1) && Number.isSafeInteger(value.fee) && Number.isSafeInteger(value.tickSpacing)
    && (protocol === 'v4' ? typeof value.hooks === 'string' && HEX_ADDRESS_LOWER.test(value.hooks) : value.hooks === null)
}

function isArcPool(value: unknown, protocol: 'v3' | 'v4'): value is ArcPool {
  if (!isRecord(value) || typeof value.pool !== 'string' || !(protocol === 'v3' ? HEX_ADDRESS_LOWER : HEX_POOL_ID).test(value.pool)) return false
  const flows = value.flowsRaw
  return isPairFields(value, protocol) && isCount(value.createdBlock) && isCount(value.swapCount) && isRecord(flows)
    && ['token0In', 'token0Out', 'token1In', 'token1Out'].every((field) => isRawUnsigned(flows[field]))
}

export function parseArcPools(value: unknown, protocol: 'v3' | 'v4'): ArcPools | null {
  if (!isRecord(value) || value.schema !== POOLS_SCHEMA || value.protocol !== protocol || !isRecord(value.window) || value.window.key !== '24h'
    || !isRecord(value.ranking) || value.ranking.by !== 'swap_count' || !isNullableCount(value.poolsTracked) || !isNullableCount(value.newPools)
    || !Array.isArray(value.pools) || value.pools.length > 10) return null
  if (value.status === 'available') return value.pools.every((pool) => isArcPool(pool, protocol)) ? value as unknown as ArcPools : null
  return value.status === 'unavailable' && value.pools.length === 0 ? value as unknown as ArcPools : null
}

function isActivityRow(value: unknown): value is ArcActivityRow {
  if (!isRecord(value) || typeof value.time !== 'string' || Number.isNaN(Date.parse(value.time)) || !isCount(value.blockNumber) || !isCount(value.logIndex)
    || typeof value.txHash !== 'string' || !HEX_POOL_ID.test(value.txHash) || typeof value.from !== 'string' || !HEX_ADDRESS_LOWER.test(value.from)
    || !isRecord(value.pair) || !isRecord(value.amounts) || !['swap', 'add', 'remove'].includes(value.kind as string)) return false
  const v3 = value.protocol === 'uniswap_v3'
  if (!v3 && value.protocol !== 'uniswap_v4') return false
  if (typeof value.pool !== 'string' || !(v3 ? HEX_ADDRESS_LOWER : HEX_POOL_ID).test(value.pool) || !isPairFields(value.pair, v3 ? 'v3' : 'v4')) return false
  const { amounts } = value
  const swap = value.kind === 'swap'
  // V4 liquidity changes carry no token amounts; every other event carries exactly its two raw amounts.
  const amountsOk = !v3 && !swap
    ? amounts.status === 'not_supported' && amounts.basis === 'none' && amounts.amount0Raw === null && amounts.amount1Raw === null
    : amounts.status === 'available' && amounts.basis === (swap ? (v3 ? 'v3_pool_delta' : 'v4_swap_delta') : 'v3_liquidity_amount')
      && [amounts.amount0Raw, amounts.amount1Raw].every((amount) => typeof amount === 'string' && (swap ? SIGNED : UNSIGNED).test(amount))
  // To: exactly the counterparty the event records; a Uniswap V4 swap records none.
  const expectedKind = swap ? (v3 ? 'swap_recipient' : 'none') : v3 ? 'liquidity_owner' : 'event_sender'
  const toOk = expectedKind === 'none' ? value.to === null : typeof value.to === 'string' && HEX_ADDRESS_LOWER.test(value.to)
  return amountsOk && value.toKind === expectedKind && toOk
}

export function parseArcActivity(value: unknown, type: ArcActivityType): ArcActivity | null {
  if (!isRecord(value) || value.schema !== ACTIVITY_SCHEMA || value.type !== type || !Array.isArray(value.rows) || value.rows.length > 25) return null
  if (value.status === 'unavailable') return value.rows.length === 0 ? value as unknown as ArcActivity : null
  if (value.status !== 'available' || !value.rows.every(isActivityRow)) return null
  const kind = { all: null, swaps: 'swap', adds: 'add', removes: 'remove' }[type]
  return kind === null || value.rows.every((row) => (row as ArcActivityRow).kind === kind) ? value as unknown as ArcActivity : null
}

const settledObject = (result: PromiseSettledResult<Record<string, unknown>>) => (result.status === 'fulfilled' ? result.value : null)

// Never rejects: every failure becomes `failed: true` with null data, so the dashboard keeps its full layout. A window
// without history in the API resolves immediately without any request; it is shown as still being collected. Pools and
// activity are read only for 24H; each one that fails is null on its own and never hides the rest.
export async function loadArcIntelligence(
  selected: ArcIntelligenceWindow,
  { fetchImpl, signal }: { fetchImpl?: FetchLike; signal?: AbortSignal } = {},
): Promise<ArcIntelligenceLoad> {
  const requests = ARC_INTELLIGENCE_BACKEND_WINDOWS[selected] ? WINDOW_REQUESTS[selected] : undefined
  if (!requests) return { window: selected, summary: null, timeseries: null, failed: false }
  const request = fetchImpl ?? (fetch as unknown as FetchLike)
  const read = (url: string) => fetchObject(url, request, signal)
  const [summary, timeseries, poolsV3, poolsV4, ...activity] = await Promise.allSettled([
    read(requests.summary),
    read(requests.timeseries),
    read(ARC_INTELLIGENCE_REQUESTS.poolsV3_24h),
    read(ARC_INTELLIGENCE_REQUESTS.poolsV4_24h),
    ...ARC_ACTIVITY_TYPES.map((type) => read(ACTIVITY_REQUESTS[type])),
  ])
  const summaryValue = summary.status === 'fulfilled' && summary.value.schema === SUMMARY_SCHEMA
    ? summary.value as unknown as ArcSummary : null
  const timeseriesValue = timeseries.status === 'fulfilled' && timeseries.value.schema === TIMESERIES_SCHEMA
    ? timeseries.value as unknown as ArcTimeseries : null
  return {
    window: selected,
    summary: summaryValue,
    timeseries: timeseriesValue,
    failed: summaryValue === null,
    pools: { v3: parseArcPools(settledObject(poolsV3), 'v3'), v4: parseArcPools(settledObject(poolsV4), 'v4') },
    activity: Object.fromEntries(ARC_ACTIVITY_TYPES.map((type, index) => [type, parseArcActivity(settledObject(activity[index]), type)])) as
      Record<ArcActivityType, ArcActivity | null>,
  }
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
