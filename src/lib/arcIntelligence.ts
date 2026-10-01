export type ArcIntelligenceView = 'latest' | 'coverage' | 'runtime'
export type ArcTimeseriesWindow = '6h' | '24h'

export type ArcRuntimeLane = {
  status?: string | null
  processedThrough?: number | null
  contiguousCompleteThrough?: number | null
  observedHead?: number | null
  currentErrorCode?: string | null
  updatedAt?: string | null
}

export type ArcIntelligenceRuntime = {
  generatedAt?: string | null
  runtimeMode?: string | null
  chain?: ArcRuntimeLane | null
  receipts?: ArcRuntimeLane | null
  lags?: {
    headToChain?: number | null
    chainToReceipts?: number | null
  } | null
  work?: {
    outstanding?: number | null
    pending?: number | null
    retrying?: number | null
    leased?: number | null
  } | null
}

export type ArcTimeseriesBucket = {
  start: string
  end: string
  status: 'available' | 'partial' | 'unavailable' | 'missing' | string
  metrics: {
    transactions: number | null
    activeAddresses: number | null
    successfulTransactions: number | null
    failedTransactions: number | null
    blocks: number | null
    contractCreations: number | null
    canonicalUsdcTransfers: number | null
    canonicalUsdcMints: number | null
    canonicalUsdcBurns: number | null
  }
}

export type ArcTimeseriesResponse = {
  generatedAt: string
  window: ArcTimeseriesWindow
  summary: { uniqueActiveAddresses: number | null; scope: 'verified_hours' }
  coverage: {
    expectedHours: number
    availableHours: number
    partialHours: number
    missingHours: number
    verifiedThrough: string | null
  }
  buckets: ArcTimeseriesBucket[]
}

async function fetchJson<T>(url: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(url, {
    method: 'GET',
    headers: { accept: 'application/json' },
    signal,
  })

  if (!response.ok) {
    throw new Error('Arc Intelligence is temporarily unavailable')
  }

  const payload: unknown = await response.json()
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('Arc Intelligence is temporarily unavailable')
  }
  return payload as T
}

export function fetchArcIntelligenceView<T>(view: ArcIntelligenceView, signal?: AbortSignal): Promise<T> {
  return fetchJson<T>(`/api/intelligence?view=${view}`, signal)
}

export function fetchArcTimeseries(window: ArcTimeseriesWindow, signal?: AbortSignal): Promise<ArcTimeseriesResponse> {
  return fetchJson<ArcTimeseriesResponse>(`/api/intelligence?view=timeseries&window=${window}`, signal)
}

export function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

export function formatCount(value: unknown): string {
  return isFiniteNumber(value) ? value.toLocaleString('en-US') : 'Unavailable'
}

export function formatPercent(value: number | null): string {
  return value === null ? 'Unavailable' : `${value.toFixed(1)}%`
}

export function formatTimestamp(value: unknown): string {
  if (typeof value === 'string') {
    const parsed = Date.parse(value)
    return Number.isNaN(parsed) ? 'Unavailable' : new Date(parsed).toLocaleString()
  }
  if (!isFiniteNumber(value)) return 'Unavailable'
  return new Date(value * 1000).toLocaleString()
}

export function formatHourLabel(value: string): string {
  const parsed = Date.parse(value)
  if (Number.isNaN(parsed)) return 'Unavailable'
  return new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' }).format(new Date(parsed))
}

export function bucketValue(bucket: ArcTimeseriesBucket, key: keyof ArcTimeseriesBucket['metrics']): number | null {
  if (bucket.status !== 'available') return null
  const value = bucket.metrics[key]
  return isFiniteNumber(value) ? value : null
}
