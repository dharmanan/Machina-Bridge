import { ARC_INTELLIGENCE_BACKEND_WINDOWS, type ArcIntelligenceWindow } from '../config/arcIntelligenceUiScope'
import type { BorrowMarket } from './mainnetBorrow'

// Client for the compact Arc Intelligence API (summary.v1 / timeseries.v1 / pools.v1 / activity.v1) behind the
// /api/intelligence proxy, plus the small helpers the dashboard uses to turn it into display states. Missing evidence is
// never a number: helpers return null, and the dashboard shows a status instead.

export const SUMMARY_SCHEMA = 'machina.intelligence.summary.v1'
export const TIMESERIES_SCHEMA = 'machina.intelligence.timeseries.v1'
export const POOLS_SCHEMA = 'machina.intelligence.pools.v1'
export const ACTIVITY_SCHEMA = 'machina.intelligence.activity.v1'
export const ECOSYSTEM_SCHEMA = 'machina.intelligence.ecosystem.v1'

export type IntelligenceDataStatus = 'available' | 'collecting' | 'unavailable' | 'source_pending'

// Metric availability describes verified values within this interval; coverage describes
// whether that interval fills the selected window. Partial totals are never full 30D totals.
export type WindowCoverage = { status: 'partial' | 'complete'; expectedHours: number; availableHours: number;
  missingHours: number; start: string; end: string; completedUtcDays: number }
export type IntelligenceWindow = { key: string; hours: number; start: string; end: string; coverage?: WindowCoverage }

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
  verifiedSubset?: { status: 'available'; scope: 'verified_hours_only'; metrics: Record<string, unknown>;
    coverage: { expectedHours: number; availableHours: number; missingHours: number; verifiedHours: string[] } }
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

// DEX USD volume of a window (server/compact/valuation.js): every swap valued once, by its USDC side or by the side with a
// verified hourly on-chain price; swaps without one are counted as unvalued, never as zero. Amounts are exact micro-USD
// integer strings. Absent when the API predates USD valuation (shown as not available yet).
export type UsdVolumeWindow = {
  status: 'available' | 'unavailable'
  reason: string | null
  reasons?: string[]
  unavailableHours?: string[]
  start?: string
  end?: string
  totalUsdMicros: string | null
  byProtocol: { uniswapV3: string; uniswapV4: string } | null
  valuedSwaps: number | null
  unvaluedSwaps: number | null
  previous?: UsdVolumeWindow
}

// Estimated pool swap fees and their average per valued swap. Hourly flow summaries omit per-step integer rounding.
// Hook-taken fees are never included; swaps whose fee cannot be valued are counted, never zero.
export type SwapFeesWindow = {
  calculation?: 'estimated'
  basis?: string
  status: 'available' | 'unavailable'
  reason: string | null
  reasons?: string[]
  unavailableHours?: string[]
  totalFeeUsdMicros: string | null
  byProtocol: { uniswapV3: string; uniswapV4: string } | null
  valuedSwaps: number | null
  unvaluedSwaps: number | null
  averageFeeUsdMicros: string | null
  previous?: SwapFeesWindow
}

// USD value of another protocol's amounts over the window, per action (never added across actions, legs or protocols).
export type ProtocolUsd = { status: 'available' | 'unavailable'; reason: string | null; values: Record<string, string> | null; failedHour?: string;
  unavailableHours?: string[]; actions?: Record<string, { status: 'complete' | 'partial' | 'unavailable';
    scope: 'all_verified_window_amounts' | 'verified_priced_subset'; usdMicros: string | null;
    coverage: { expectedHours: number; storedHours: number; fullyValuedHours: number };
    assets: { token: string; symbol: string | null; verified: boolean; decimals: number | null; amountRaw: string;
      valuedAmountRaw: string; unvaluedAmountRaw: string; usdMicros: string | null;
      blockers: { reason: string; firstHour: string; lastHour: string; hours: number; amountRaw?: string }[] }[] }> }

export type ArcSummary = {
  schema: typeof SUMMARY_SCHEMA
  window: IntelligenceWindow
  freshness: ArcFreshness
  network: NetworkWindow
  assets: { usdc: FamilyWindow; verifiedAssets: FamilyWindow }
  dex: { uniswapV3: FamilyWindow; uniswapV4: FamilyWindow; officialV3Pools: { status: BackendStatus; count: number | null }; usdVolume?: UsdVolumeWindow;
    swapFees?: SwapFeesWindow }
  lending: { aaveV4: FamilyWindow; morphoBlue: FamilyWindow; morphoVaultsV2: FamilyWindow }
  protocolUsd?: Partial<Record<'cctp' | 'gateway' | 'across' | 'aaveV4' | 'morphoBlue' | 'morphoVaultsV2', ProtocolUsd>>
  crossChain: { cctp: FamilyWindow; gateway: FamilyWindow; across: FamilyWindow }
  coverage: { firstStoredHour: string; storedHours: number; checkpointHour: string; verifiedThrough: string }
}

export type TimeseriesFamily = { status: 'available' | 'unavailable'; reason?: string } & Record<string, unknown>

// One hour's DEX USD volume (exact micro-USD strings), or unavailable with its reason.
export type HourUsdVolume = { status: 'available' | 'unavailable'; reason?: string; totalUsdMicros?: string; uniswapV3UsdMicros?: string;
  uniswapV4UsdMicros?: string; valuedSwaps?: number; unvaluedSwaps?: number }

// One bucket: an hour (24H) or a 24-hour period (7D, 30D). A 24-hour bucket is committed only when all its hours are; it
// carries no unique active addresses (hourly uniques never add up).
export type TimeseriesBucket = {
  start: string
  end: string
  status: 'committed' | 'not_stored' | 'incomplete'
  storedHours?: number
  network: { blocks: number; transactions: number; uniqueActiveAddresses: number | null; gasUsedRaw: string;
    uniqueActiveAddressesStatus?: { status: string; reason?: string; value: number | null } } | null
  families: Record<string, TimeseriesFamily> | null
  dexUsdVolume?: HourUsdVolume | null
}

export type ArcTimeseries = {
  schema: typeof TIMESERIES_SCHEMA
  window: IntelligenceWindow
  freshness: ArcFreshness
  bucketHours?: number
  buckets: TimeseriesBucket[]
}

// A pool side. symbol and decimals come only from the verified Arc asset registry (native: Uniswap V4's currency 0x0, Arc's
// native USDC with 18 decimals); any other token keeps null. contractMetadata: what an unverified token's own contract
// answered (read once by the indexer), shown as an unverified label, never as a verified identity; null when unread or
// rejected, in which case the token is shown by its shortened address.
export type ContractMetadata = { symbol: string; name: string | null; decimals: number }
export type PoolToken = { address: string; symbol: string | null; decimals: number | null; verified: boolean; native: boolean;
  contractMetadata?: ContractMetadata | null }

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
  // USD value of the pool's swaps in the window (each swap once); unavailable when any of its swap hours has no verified value
  usdVolume?: { status: 'available' | 'unavailable'; reason: string | null; usdMicros: string | null; basis: string | null }
  // Value held in the pool: pool state at the latest verified hour's last block, valued with that hour's prices. Never
  // derived from add or remove activity.
  liquidityUsd?: { status: 'available' | 'unavailable'; reason: string | null; usdMicros: string | null; amount0Raw: string | null;
    amount1Raw: string | null; asOfBlock: number | null; calculation?: 'balance_snapshot' | 'estimated_principal_reserves';
    asOfHour?: string; ageHours?: number; snapshotStatus?: 'latest_hour' | 'older_stored_snapshot';
    blockedTokens?: { token: string; reason: string }[] }
}

// Top pools of one Uniswap version, ranked by swap count. USD volume and USD liquidity are shown beside the count.
export type ArcPools = {
  schema: typeof POOLS_SCHEMA
  protocol: 'v3' | 'v4'
  window: IntelligenceWindow
  freshness: ArcFreshness
  status: 'available' | 'unavailable'
  reason: string | null
  ranking: { by: 'swap_count'; usdVolume: { status: 'available' | 'unavailable' | 'source_pending'; reason?: string | null; reasons?: string[] };
    liquidityUsd: { status: 'available' | 'unavailable' | 'source_pending'; reason?: string | null; asOfHour?: string | null;
      snapshotScope?: 'per_pool_latest_stored_snapshot' } }
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
  // Why To is empty: a Uniswap V4 swap records no recipient and no trace data is available (never filled from transaction-level target fields)
  toReason?: string | null
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
  // Pools of the selected window and the shared recent activity. A read that failed or did not match its exact shape is
  // null: the section shows a status, never a guess.
  pools?: { v3: ArcPools | null; v4: ArcPools | null }
  activity?: Record<ArcActivityType, ArcActivity | null>
  ecosystem?: ArcEcosystem | null
  readErrors?: Partial<Record<ArcReadSection, 'request_failed' | 'invalid_response'>>
  refresh?: Partial<Record<ArcReadSection, {
    lastSuccessAt: string | null
    verifiedThrough: string | null
    error: 'request_failed' | 'invalid_response' | null
    retained: boolean
  }>>
}

export const ARC_READ_SECTIONS = ['summary', 'timeseries', 'poolsV3', 'poolsV4', 'ecosystem',
  'activity:all', 'activity:swaps', 'activity:adds', 'activity:removes'] as const
export type ArcReadSection = typeof ARC_READ_SECTIONS[number]

function sectionValue(load: ArcIntelligenceLoad, section: ArcReadSection) {
  if (section === 'poolsV3' || section === 'poolsV4') return load.pools?.[section === 'poolsV3' ? 'v3' : 'v4'] ?? null
  if (section.startsWith('activity:')) return load.activity?.[section.slice(9) as ArcActivityType] ?? null
  return load[section as 'summary' | 'timeseries' | 'ecosystem'] ?? null
}

export function hasArcIntelligenceData(load: ArcIntelligenceLoad): boolean {
  return ARC_READ_SECTIONS.some((section) => sectionValue(load, section) !== null)
}

// Retain only schema-validated responses from this exact window. A successful response containing genuine
// unavailable metrics replaces the old response; transport/schema failure alone retains the previous value.
export function retainArcIntelligenceLoad(previous: ArcIntelligenceLoad | undefined, incoming: ArcIntelligenceLoad,
  now = new Date().toISOString()): ArcIntelligenceLoad {
  const prior = previous?.window === incoming.window ? previous : undefined
  const result: ArcIntelligenceLoad = { ...incoming, pools: { v3: null, v4: null },
    activity: {} as Record<ArcActivityType, ArcActivity | null>, refresh: {} }
  for (const section of ARC_READ_SECTIONS) {
    const next = sectionValue(incoming, section)
    const old = prior ? sectionValue(prior, section) : null
    const value = next ?? old
    if (section === 'poolsV3' || section === 'poolsV4') result.pools![section === 'poolsV3' ? 'v3' : 'v4'] = value as ArcPools | null
    else if (section.startsWith('activity:')) result.activity![section.slice(9) as ArcActivityType] = value as ArcActivity | null
    else if (section === 'summary') result.summary = value as ArcSummary | null
    else if (section === 'timeseries') result.timeseries = value as ArcTimeseries | null
    else result.ecosystem = value as ArcEcosystem | null
    result.refresh![section] = next ? { lastSuccessAt: now, verifiedThrough: 'freshness' in next ? next.freshness?.verifiedThrough ?? null : null,
      error: null, retained: false } : { lastSuccessAt: prior?.refresh?.[section]?.lastSuccessAt ?? null,
      verifiedThrough: prior?.refresh?.[section]?.verifiedThrough ?? (old && 'freshness' in old ? old.freshness?.verifiedThrough ?? null : null),
      error: incoming.readErrors?.[section] ?? 'request_failed', retained: old !== null }
  }
  result.failed = !result.summary
  return result
}

// One active refresh batch: repeated timer/manual refreshes coalesce; a window switch cancels the old batch.
// Identity checks also reject late results from transports that do not honor AbortSignal.
export function createArcIntelligenceRefresh({ onResult, onRefreshing, loader = loadArcIntelligence }: {
  onResult: (result: ArcIntelligenceLoad) => void
  onRefreshing: (value: boolean) => void
  loader?: typeof loadArcIntelligence
}) {
  let active: { window: ArcIntelligenceWindow; controller: AbortController; promise: Promise<void> } | null = null
  const cancel = () => { const old = active; active = null; old?.controller.abort() }
  return {
    cancel,
    refresh(window: ArcIntelligenceWindow): Promise<void> {
      if (active?.window === window) return active.promise
      cancel()
      const task = { window, controller: new AbortController(), promise: Promise.resolve() }
      active = task
      onRefreshing(true)
      task.promise = (async () => {
        try {
          const result = await loader(window, { signal: task.controller.signal })
          if (active === task && !task.controller.signal.aborted) onResult(result)
        } catch {
          if (active === task && !task.controller.signal.aborted) onResult({ window, summary: null, timeseries: null, failed: true })
        } finally {
          if (active === task) { active = null; onRefreshing(false) }
        }
      })()
      return task.promise
    },
  }
}

export type DiscoveryActivity = { firstProven: boolean; reason: string | null;
  firstObserved: { timestamp: string; blockNumber: number; logIndex: number; txHash: string } | null }
export type DiscoveryPool = { protocol: string; pool: string; pairedToken: string; creationBlock: number;
  creationTimestamp: string | null; creationTxHash: string; firstSwap: DiscoveryActivity; firstLiquidity: DiscoveryActivity;
  earlyActivity: { status: string; reason: string | null; hourStart: string | null; swapCount: number | null; basis: string } }
export type DiscoveredToken = { address: string; status: 'verified_erc20_like'; verifiedAsset: false; symbol: string | null;
  name: string | null; decimals: number | null; discoveredAt: string; observedBlock: number;
  deployment: { status?: string; reason?: string; timestamp?: string; transactionHash?: string; blockNumber?: number; deployer?: string };
  launch: { status: string; source: string | null; reason?: string; provenance?: unknown; observedAt?: string };
  dex: { status: string; reason?: string; firstPool?: DiscoveryPool | null; observedPools?: DiscoveryPool[];
    firstDexActivity?: { status: string; reason: string | null; firstObserved: { timestamp: string; blockNumber: number; txHash: string; firstProven: boolean } | null } } }
export type ArcEcosystem = { schema: typeof ECOSYSTEM_SCHEMA; window: IntelligenceWindow;
  coverage: { status: string; reason?: string; requiredHours: number; availableHours: number; unresolvedCandidateCount?: number };
  discoveredTokens: { status: string; truncated?: boolean; rows: DiscoveredToken[] };
  launches: { status: string; truncated?: boolean; rows: DiscoveredToken[] };
  otherProtocols: { status: string; reason?: string | null }; exchangeFlows: { status: string; reason?: string | null } }

export function parseArcEcosystem(value: Record<string, unknown> | null, selected: string): ArcEcosystem | null {
  if (!value || value.schema !== ECOSYSTEM_SCHEMA || !validWindowCoverage(value.window)) return null
  const data = value as unknown as ArcEcosystem
  if (data.window?.key !== selected || !data.coverage || !data.discoveredTokens || !data.launches
    || !data.otherProtocols || !data.exchangeFlows) return null
  const date = (value: unknown) => typeof value === 'string' && Number.isFinite(Date.parse(value))
  const hash = (value: unknown) => typeof value === 'string' && /^0x[0-9a-f]{64}$/.test(value)
  const count = (value: unknown) => Number.isSafeInteger(value) && (value as number) >= 0
  const activity = (value: unknown) => isRecord(value) && typeof value.firstProven === 'boolean'
    && (value.firstObserved === null || isRecord(value.firstObserved) && date(value.firstObserved.timestamp)
      && count(value.firstObserved.blockNumber) && hash(value.firstObserved.txHash))
  const pool = (value: unknown) => isRecord(value) && (value.protocol === 'uniswap_v3' || value.protocol === 'uniswap_v4')
    && typeof value.pool === 'string' && (value.protocol === 'uniswap_v3' ? /^0x[0-9a-f]{40}$/ : /^0x[0-9a-f]{64}$/).test(value.pool)
    && count(value.creationBlock) && hash(value.creationTxHash) && activity(value.firstSwap) && activity(value.firstLiquidity)
    && isRecord(value.earlyActivity) && typeof value.earlyActivity.status === 'string'
    && (value.earlyActivity.swapCount === null || count(value.earlyActivity.swapCount))
  if (!count(data.coverage.availableHours) || !count(data.coverage.requiredHours) || data.coverage.requiredHours > 720
    || data.coverage.availableHours > data.coverage.requiredHours || !date(data.window.start) || !date(data.window.end)) return null
  const validTokens = (rows: unknown) => Array.isArray(rows) && rows.length <= 50 && rows.every((row) => row
    && /^0x[0-9a-f]{40}$/.test(row.address) && row.status === 'verified_erc20_like' && row.verifiedAsset === false
    && typeof row.discoveredAt === 'string' && Number.isFinite(Date.parse(row.discoveredAt))
    && Number.isSafeInteger(row.observedBlock) && row.deployment && row.launch && row.dex
    && typeof row.launch.status === 'string' && (row.launch.source === null || typeof row.launch.source === 'string')
    && (row.deployment.transactionHash === undefined || hash(row.deployment.transactionHash))
    && (row.deployment.timestamp === undefined || date(row.deployment.timestamp))
    && (row.dex.firstPool === undefined || row.dex.firstPool === null || pool(row.dex.firstPool))
    && (row.dex.observedPools === undefined || Array.isArray(row.dex.observedPools) && row.dex.observedPools.length <= 50 && row.dex.observedPools.every(pool))
    && (row.dex.firstDexActivity?.firstObserved == null || date(row.dex.firstDexActivity.firstObserved.timestamp)
      && count(row.dex.firstDexActivity.firstObserved.blockNumber) && hash(row.dex.firstDexActivity.firstObserved.txHash))
    && (row.symbol === null || typeof row.symbol === 'string' && row.symbol.length <= 128))
  if (!validTokens(data.discoveredTokens.rows) || !validTokens(data.launches.rows)
    || data.launches.rows.some((row) => !['direct_deployment', 'verified_factory', 'verified_launchpad'].includes(row.launch.status))) return null
  return data
}

// The only requests the dashboard makes. Windows the API cannot answer (1H, 6H) are never requested at all.
export const ARC_INTELLIGENCE_REQUESTS = Object.freeze({
  ecosystem24h: '/api/intelligence?view=ecosystem&window=24h',
  ecosystem7d: '/api/intelligence?view=ecosystem&window=7d',
  ecosystem30d: '/api/intelligence?view=ecosystem&window=30d',
  summary24h: '/api/intelligence?view=summary&window=24h',
  timeseries24h: '/api/intelligence?view=timeseries&window=24h',
  poolsV3_24h: '/api/intelligence?view=pools&protocol=v3&window=24h',
  poolsV4_24h: '/api/intelligence?view=pools&protocol=v4&window=24h',
  activityAll: '/api/intelligence?view=activity&type=all',
  activitySwaps: '/api/intelligence?view=activity&type=swaps',
  activityAdds: '/api/intelligence?view=activity&type=adds',
  activityRemoves: '/api/intelligence?view=activity&type=removes',
  summary7d: '/api/intelligence?view=summary&window=7d',
  timeseries7d: '/api/intelligence?view=timeseries&window=7d',
  poolsV3_7d: '/api/intelligence?view=pools&protocol=v3&window=7d',
  poolsV4_7d: '/api/intelligence?view=pools&protocol=v4&window=7d',
  summary30d: '/api/intelligence?view=summary&window=30d',
  timeseries30d: '/api/intelligence?view=timeseries&window=30d',
  poolsV3_30d: '/api/intelligence?view=pools&protocol=v3&window=30d',
  poolsV4_30d: '/api/intelligence?view=pools&protocol=v4&window=30d',
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

// Why a Uniswap V4 swap has no To (server/compact/read-model.js V4_SWAP_TO_BLOCKER), and what the dashboard says about it.
export const V4_SWAP_TO_BLOCKER = 'v4_swap_recipient_not_emitted_and_trace_unavailable'
export const V4_SWAP_TO_TEXT = 'V4 swap recipient is not emitted by the event and trace data is unavailable.'

export function shortenAddress(address: string): string {
  return /^0x[0-9a-fA-F]{40}$/.test(address) ? `${address.slice(0, 6)}...${address.slice(-4)}` : address
}

export function shortenHash(hash: string): string {
  return /^0x[0-9a-fA-F]{64}$/.test(hash) ? `${hash.slice(0, 6)}...${hash.slice(-4)}` : hash
}

// Per window: its own summary, timeseries and pools reads. Recent activity has no window and is shared.
const WINDOW_REQUESTS: Partial<Record<ArcIntelligenceWindow, { summary: string; timeseries: string; poolsV3: string; poolsV4: string; ecosystem: string }>> = {
  '24h': { summary: ARC_INTELLIGENCE_REQUESTS.summary24h, timeseries: ARC_INTELLIGENCE_REQUESTS.timeseries24h,
    poolsV3: ARC_INTELLIGENCE_REQUESTS.poolsV3_24h, poolsV4: ARC_INTELLIGENCE_REQUESTS.poolsV4_24h, ecosystem: ARC_INTELLIGENCE_REQUESTS.ecosystem24h },
  '7d': { summary: ARC_INTELLIGENCE_REQUESTS.summary7d, timeseries: ARC_INTELLIGENCE_REQUESTS.timeseries7d,
    poolsV3: ARC_INTELLIGENCE_REQUESTS.poolsV3_7d, poolsV4: ARC_INTELLIGENCE_REQUESTS.poolsV4_7d, ecosystem: ARC_INTELLIGENCE_REQUESTS.ecosystem7d },
  '30d': { summary: ARC_INTELLIGENCE_REQUESTS.summary30d, timeseries: ARC_INTELLIGENCE_REQUESTS.timeseries30d,
    poolsV3: ARC_INTELLIGENCE_REQUESTS.poolsV3_30d, poolsV4: ARC_INTELLIGENCE_REQUESTS.poolsV4_30d, ecosystem: ARC_INTELLIGENCE_REQUESTS.ecosystem30d },
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

// Older APIs may omit coverage. A supplied partial contract must be internally consistent
// before any of its values can be described as verified history.
function validWindowCoverage(window: unknown): boolean {
  if (!isRecord(window)) return false
  if (window.coverage === undefined) return true
  const coverage = window.coverage
  if (!isRecord(coverage) || window.key !== '30d' || window.hours !== 720 || coverage.expectedHours !== 720
    || !isCount(coverage.availableHours) || !isCount(coverage.missingHours) || !isCount(coverage.completedUtcDays)
    || (coverage.availableHours as number) < 1 || (coverage.availableHours as number) + (coverage.missingHours as number) !== 720) return false
  const date = (value: unknown) => typeof value === 'string' ? Date.parse(value) : NaN
  const start = date(coverage.start), end = date(coverage.end), selectedStart = date(window.start)
  return Number.isFinite(start) && Number.isFinite(end) && Number.isFinite(selectedStart)
    && start >= selectedStart && end === date(window.end) && end - selectedStart === 720 * 3600_000
    && end - start === (coverage.availableHours as number) * 3600_000
    && [start, end].every((value) => value % 3600_000 === 0)
    && coverage.status === (coverage.availableHours === 720 ? 'complete' : 'partial')
    && coverage.completedUtcDays === Math.max(0, Math.floor(end / 86400_000) - Math.ceil(start / 86400_000))
}

const CONTRACT_SYMBOL = /^[A-Za-z0-9][A-Za-z0-9._+$-]{0,19}$/
const isDecimals0to36 = (value: unknown) => Number.isInteger(value) && (value as number) >= 0 && (value as number) <= 36

function isContractMetadata(value: unknown): value is ContractMetadata {
  return isRecord(value) && typeof value.symbol === 'string' && CONTRACT_SYMBOL.test(value.symbol) && isDecimals0to36(value.decimals)
    && (value.name === null || (typeof value.name === 'string' && value.name.length <= 64))
}

function isPoolToken(value: unknown): value is PoolToken {
  if (!isRecord(value) || typeof value.address !== 'string' || !HEX_ADDRESS_LOWER.test(value.address) || typeof value.verified !== 'boolean'
    || typeof value.native !== 'boolean') return false
  // Contract metadata only ever belongs to an unverified token; absent (older API) is the same as null.
  const metadata = value.contractMetadata
  if (metadata !== undefined && metadata !== null && (value.verified || !isContractMetadata(metadata))) return false
  return value.verified
    ? typeof value.symbol === 'string' && value.symbol.length > 0 && isDecimals0to36(value.decimals)
    : value.symbol === null && value.decimals === null
}

const isUsdMicros = (value: unknown) => typeof value === 'string' && UNSIGNED.test(value)
// Pool liquidity: available carries the exact USD value and the raw held amounts; unavailable carries its reason and no value.
function isPoolLiquidity(value: unknown) {
  if (value === undefined) return true
  if (!isRecord(value)) return false
  if (value.calculation !== undefined && value.calculation !== 'balance_snapshot' && value.calculation !== 'estimated_principal_reserves') return false
  if (value.asOfHour !== undefined && (typeof value.asOfHour !== 'string' || !Number.isFinite(Date.parse(value.asOfHour)))) return false
  if (value.ageHours !== undefined && !isCount(value.ageHours)) return false
  if (value.snapshotStatus !== undefined && value.snapshotStatus !== 'latest_hour' && value.snapshotStatus !== 'older_stored_snapshot') return false
  if (value.snapshotStatus === 'older_stored_snapshot' && (!value.asOfHour || !isCount(value.ageHours) || (value.ageHours as number) < 1)) return false
  if (value.blockedTokens !== undefined && (!Array.isArray(value.blockedTokens) || value.blockedTokens.length > 2
    || !value.blockedTokens.every(token => isRecord(token) && typeof token.token === 'string' && HEX_ADDRESS_LOWER.test(token.token)
      && typeof token.reason === 'string'))) return false
  return value.status === 'available'
    ? isUsdMicros(value.usdMicros) && isRawUnsigned(value.amount0Raw) && isRawUnsigned(value.amount1Raw) && isCount(value.asOfBlock)
    : value.status === 'unavailable' && value.usdMicros === null && typeof value.reason === 'string'
}

function isPoolUsdVolume(value: unknown) {
  if (value === undefined) return true
  if (!isRecord(value)) return false
  return value.status === 'available'
    ? isUsdMicros(value.usdMicros) && typeof value.basis === 'string'
    : value.status === 'unavailable' && value.usdMicros === null
}

function isPairFields(value: Record<string, unknown>, protocol: 'v3' | 'v4') {
  return isPoolToken(value.token0) && isPoolToken(value.token1) && Number.isSafeInteger(value.fee) && Number.isSafeInteger(value.tickSpacing)
    && (protocol === 'v4' ? typeof value.hooks === 'string' && HEX_ADDRESS_LOWER.test(value.hooks) : value.hooks === null)
}

function isArcPool(value: unknown, protocol: 'v3' | 'v4'): value is ArcPool {
  if (!isRecord(value) || typeof value.pool !== 'string' || !(protocol === 'v3' ? HEX_ADDRESS_LOWER : HEX_POOL_ID).test(value.pool)) return false
  const flows = value.flowsRaw
  return isPairFields(value, protocol) && isCount(value.createdBlock) && isCount(value.swapCount) && isRecord(flows)
    && ['token0In', 'token0Out', 'token1In', 'token1Out'].every((field) => isRawUnsigned(flows[field])) && isPoolUsdVolume(value.usdVolume)
    && isPoolLiquidity(value.liquidityUsd)
}

export function parseArcPools(value: unknown, protocol: 'v3' | 'v4', window: ArcIntelligenceWindow = '24h'): ArcPools | null {
  if (!isRecord(value) || value.schema !== POOLS_SCHEMA || value.protocol !== protocol || !isRecord(value.window) || value.window.key !== window
    || !isRecord(value.ranking) || value.ranking.by !== 'swap_count' || !isNullableCount(value.poolsTracked) || !isNullableCount(value.newPools)
    || !Array.isArray(value.pools) || value.pools.length > 10 || !validWindowCoverage(value.window)) return null
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
  // A reason only ever explains an empty To, and it is the exact V4 blocker (absent in an older API).
  const reasonOk = value.toReason === undefined || (expectedKind === 'none' ? value.toReason === V4_SWAP_TO_BLOCKER : value.toReason === null)
  return amountsOk && value.toKind === expectedKind && toOk && reasonOk
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
// activity are read with every window; each one that fails is null on its own and never hides the rest.
export async function loadArcIntelligence(
  selected: ArcIntelligenceWindow,
  { fetchImpl, signal }: { fetchImpl?: FetchLike; signal?: AbortSignal } = {},
): Promise<ArcIntelligenceLoad> {
  const requests = ARC_INTELLIGENCE_BACKEND_WINDOWS[selected] ? WINDOW_REQUESTS[selected] : undefined
  if (!requests) return { window: selected, summary: null, timeseries: null, failed: false }
  const request = fetchImpl ?? (fetch as unknown as FetchLike)
  const read = (url: string) => fetchObject(url, request, signal)
  const urls = [requests.summary, requests.timeseries, requests.poolsV3, requests.poolsV4, requests.ecosystem,
    ...ARC_ACTIVITY_TYPES.map((type) => ACTIVITY_REQUESTS[type])]
  const settled: PromiseSettledResult<Record<string, unknown>>[] = new Array(urls.length)
  let cursor = 0
  // Long-window SQLite reads share one server event loop. Avoid a nine-request burst on every refresh.
  await Promise.all([0, 1].map(async () => {
    while (cursor < urls.length) {
      const index = cursor++
      try {
        if (signal?.aborted) throw new Error('refresh_cancelled')
        settled[index] = { status: 'fulfilled', value: await read(urls[index]) }
      } catch (reason) { settled[index] = { status: 'rejected', reason } }
    }
  }))
  const [summary, timeseries, poolsV3, poolsV4, ecosystem, ...activity] = settled
  const summaryValue = summary.status === 'fulfilled' && summary.value.schema === SUMMARY_SCHEMA
    && isRecord(summary.value.window) && summary.value.window.key === selected && validWindowCoverage(summary.value.window)
    ? summary.value as unknown as ArcSummary : null
  const timeseriesValue = timeseries.status === 'fulfilled' && timeseries.value.schema === TIMESERIES_SCHEMA
    && isRecord(timeseries.value.window) && timeseries.value.window.key === selected && validWindowCoverage(timeseries.value.window)
    ? timeseries.value as unknown as ArcTimeseries : null
  const result: ArcIntelligenceLoad = {
    window: selected,
    ecosystem: parseArcEcosystem(settledObject(ecosystem), selected),
    summary: summaryValue,
    timeseries: timeseriesValue,
    failed: summaryValue === null,
    pools: { v3: parseArcPools(settledObject(poolsV3), 'v3', selected), v4: parseArcPools(settledObject(poolsV4), 'v4', selected) },
    activity: Object.fromEntries(ARC_ACTIVITY_TYPES.map((type, index) => [type, parseArcActivity(settledObject(activity[index]), type)])) as
      Record<ArcActivityType, ArcActivity | null>,
  }
  result.readErrors = Object.fromEntries(ARC_READ_SECTIONS.flatMap((section, index) => sectionValue(result, section) !== null ? []
    : [[section, settled[index].status === 'rejected' ? 'request_failed' : 'invalid_response']]))
  return result
}

// ---------------------------------------------------------------------------------------------------------------------
// USD volume (exact micro-USD strings from the API).

const USD_MICROS = /^\d+$/

// Display state of a USD volume entry. Absent (an API without USD valuation) is not available yet; hours not valued yet,
// or a window still filling, are collecting; anything else is unavailable.
export function usdVolumeStatus(entry: { status: string; reason?: string | null; reasons?: string[] } | null | undefined): IntelligenceDataStatus {
  if (!entry) return 'source_pending'
  if (entry.status === 'available' || verifiedFamilyCoverage(entry as FamilyWindow)) return 'available'
  if (entry.reason === 'insufficient_coverage') return 'collecting'
  const reasons = entry.reasons ?? (entry.reason ? [entry.reason] : [])
  return reasons.length > 0 && reasons.every((reason) => reason === 'valuation_not_processed') ? 'collecting' : 'unavailable'
}

// A micro-USD amount as a number of dollars (for charts and comparisons only; displays use the exact string).
export function usdMicrosToNumber(micros: string | null | undefined): number | null {
  if (typeof micros !== 'string' || !USD_MICROS.test(micros)) return null
  const value = Number(BigInt(micros)) / 1_000_000
  return Number.isFinite(value) ? value : null
}

// "$1,234.56" exactly (BigInt, truncated to cents); a positive amount below one cent reads "<$0.01", never zero.
export function formatUsdMicros(micros: string): string {
  const value = BigInt(micros)
  const whole = value / 1_000_000n
  const cents = (value % 1_000_000n) / 10_000n
  if (value > 0n && whole === 0n && cents === 0n) return '<$0.01'
  return `$${whole.toLocaleString('en-US')}.${cents.toString().padStart(2, '0')}`
}

// "$1.2M" style for tiles and axes.
export function formatUsdCompact(value: number): string {
  if (value > 0 && value < 0.01) return '<$0.01'
  return `$${new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: value < 1000 ? 2 : 1 }).format(value)}`
}

// A subset is displayed only when its hour list and missing-hour evidence reconcile exactly.
export function verifiedFamilyCoverage(family: FamilyWindow | null | undefined) {
  const subset = family?.verifiedSubset
  if (!subset || subset.status !== 'available' || subset.scope !== 'verified_hours_only' || !subset.metrics) return null
  const c = subset.coverage
  if (!c || !Number.isSafeInteger(c.expectedHours) || !Number.isSafeInteger(c.availableHours) || !Number.isSafeInteger(c.missingHours)
    || c.availableHours <= 0 || c.missingHours <= 0 || c.expectedHours > 720 || c.availableHours + c.missingHours !== c.expectedHours
    || !Array.isArray(c.verifiedHours) || c.verifiedHours.length !== c.availableHours
    || new Set(c.verifiedHours).size !== c.availableHours || family?.unavailableHours?.length !== c.missingHours) return null
  const start = Date.parse(family.start ?? ''), end = Date.parse(family.end ?? '')
  if (end - start !== c.expectedHours * 3_600_000) return null
  const covered = new Set(c.verifiedHours)
  if ([...c.verifiedHours, ...(family.unavailableHours ?? [])].some((hour) => {
    const time = Date.parse(hour)
    return !Number.isFinite(time) || time % 3_600_000 !== 0 || time < start || time >= end
  }) || family.unavailableHours?.some((hour) => covered.has(hour))
    || new Set(family.unavailableHours).size !== c.missingHours) return null
  return c
}
export function familyMetrics(family: FamilyWindow | null | undefined): Record<string, unknown> | null {
  if (!family) return null
  return family.status === 'available' ? family.metrics : verifiedFamilyCoverage(family) ? family.verifiedSubset!.metrics : null
}

// Optional scoped valuations fail closed independently of the legacy full-total contract.
export function protocolActions(entry: ProtocolUsd | null | undefined): ProtocolUsd['actions'] | null {
  const actions = entry?.actions
  if (!actions || typeof actions !== 'object' || Object.keys(actions).length > 12) return null
  const raw = (value: unknown): value is string => typeof value === 'string' && /^\d+$/.test(value)
  for (const action of Object.values(actions)) {
    const c = action?.coverage
    if (!action || !['complete', 'partial', 'unavailable'].includes(action.status)
      || !['all_verified_window_amounts', 'verified_priced_subset'].includes(action.scope)
      || !c || !Number.isSafeInteger(c.expectedHours) || c.expectedHours < 1 || c.expectedHours > 720
      || !Number.isSafeInteger(c.storedHours) || c.storedHours < 0 || c.storedHours > c.expectedHours
      || !Number.isSafeInteger(c.fullyValuedHours) || c.fullyValuedHours < 0 || c.fullyValuedHours > c.storedHours
      || !Array.isArray(action.assets) || action.assets.length > 128
      || (action.usdMicros !== null && !raw(action.usdMicros))) return null
    let total = 0n
    for (const asset of action.assets) {
      const identity = asset?.token === '0x0000000000000000000000000000000000000000' ? { symbol: 'USDC', decimals: 18 } : ARC_KNOWN_TOKENS[asset?.token]
      if (!asset || !/^0x[0-9a-f]{40}$/.test(asset.token) || !raw(asset.amountRaw) || !raw(asset.valuedAmountRaw) || !raw(asset.unvaluedAmountRaw)
        || BigInt(asset.amountRaw) !== BigInt(asset.valuedAmountRaw) + BigInt(asset.unvaluedAmountRaw)
        || (asset.usdMicros !== null && !raw(asset.usdMicros)) || typeof asset.verified !== 'boolean'
        || (asset.verified ? !identity || asset.symbol !== identity.symbol || asset.decimals !== identity.decimals
          : asset.symbol !== null || asset.decimals !== null || asset.valuedAmountRaw !== '0' || (asset.usdMicros !== null && asset.usdMicros !== '0'))
        || !Array.isArray(asset.blockers) || asset.blockers.length > 8) return null
      for (const blocker of asset.blockers) if (!blocker || typeof blocker.reason !== 'string'
        || !Number.isSafeInteger(blocker.hours) || blocker.hours < 1 || blocker.hours > c.expectedHours
        || !Number.isFinite(Date.parse(blocker.firstHour)) || !Number.isFinite(Date.parse(blocker.lastHour))
        || (blocker.amountRaw !== undefined && !raw(blocker.amountRaw))) return null
      if (asset.usdMicros !== null) total += BigInt(asset.usdMicros)
    }
    if (action.usdMicros !== null && BigInt(action.usdMicros) !== total) return null
    if (action.status === 'complete' && (c.fullyValuedHours !== c.expectedHours || action.scope !== 'all_verified_window_amounts')) return null
    if (action.status === 'unavailable' && action.usdMicros !== null) return null
  }
  return actions
}

// Display state of one backend window entry. insufficient_coverage means the window is still filling with history.
export function windowStatus(entry: { status: string; reason?: string } | null | undefined): IntelligenceDataStatus {
  if (!entry) return 'unavailable'
  if (entry.status === 'available' || verifiedFamilyCoverage(entry as FamilyWindow)) return 'available'
  if (entry.reason === 'insufficient_coverage') return 'collecting'
  return 'unavailable'
}

export function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

// A family metric, only when the family window is available and the value is a real number.
export function metricNumber(family: FamilyWindow | null | undefined, field: string): number | null {
  const metrics = familyMetrics(family)
  if (!metrics) return null
  const value = metrics[field]
  return isFiniteNumber(value) ? value : null
}

// Sum of counters of one family; null unless every counter is present.
export function metricSum(family: FamilyWindow | null | undefined, fields: readonly string[]): number | null {
  const values = fields.map((field) => metricNumber(family, field))
  return values.every((value): value is number => value !== null) ? values.reduce((total, value) => total + value, 0) : null
}

export function metricAmount(family: FamilyWindow | null | undefined, field: string): string | null {
  const metrics = familyMetrics(family)
  if (!metrics) return null
  const value = metrics[field]
  return typeof value === 'string' && /^\d+$/.test(value) ? value : null
}

export type VerifiedAssetItem = { symbol: string; address: string; decimals: number; transferCount: number; mintCount: number;
  burnCount: number; amountRaw: string }

export function verifiedAssetItems(family: FamilyWindow | null | undefined): VerifiedAssetItem[] | null {
  const metrics = familyMetrics(family)
  if (!metrics || !Array.isArray(metrics.items)) return null
  return (metrics.items as unknown[]).filter((item): item is VerifiedAssetItem => {
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

// "Oct 3" (UTC), for daily chart labels.
export function formatUtcDay(iso: string): string {
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? '' : `${date.toLocaleString('en-US', { month: 'short', timeZone: 'UTC' })} ${date.getUTCDate()}`
}

// The exact range of one chart period: "13:00-14:00 UTC" for an hour, "Oct 2, 00:00 to Oct 3, 00:00 UTC" for a complete UTC day.
export function formatUtcPeriodRange(start: string, end: string, period: 'hour' | 'day'): string {
  if (period === 'hour') return formatUtcHourRange(start, end)
  return `${formatUtcDateTime(start).replace(/ UTC$/, '')} to ${formatUtcDateTime(end)}`
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
