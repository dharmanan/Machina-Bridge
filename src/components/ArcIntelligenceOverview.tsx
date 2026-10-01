import { useCallback, useEffect, useMemo, useState } from 'react'
import { Activity, AlertCircle, RefreshCw, ShieldCheck } from 'lucide-react'
import {
  bucketValue,
  fetchArcIntelligenceView,
  fetchArcTimeseries,
  formatCount,
  formatHourLabel,
  formatPercent,
  formatTimestamp,
  type ArcIntelligenceRuntime,
  type ArcTimeseriesBucket,
  type ArcTimeseriesResponse,
  type ArcTimeseriesWindow,
} from '../lib/arcIntelligence'
import { Card } from './ui'

type LoadState = {
  timeseries: ArcTimeseriesResponse | null
  runtime: ArcIntelligenceRuntime | null
  loading: boolean
  refreshing: boolean
  error: string | null
}

type MetricKey = keyof ArcTimeseriesBucket['metrics']

const initialState: LoadState = {
  timeseries: null,
  runtime: null,
  loading: true,
  refreshing: false,
  error: null,
}

function MetricCard({ label, value, note }: { label: string; value: string; note: string }) {
  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
      <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-400">{label}</p>
      <p className="mt-2 text-3xl font-bold tracking-tight text-slate-950">{value}</p>
      <p className="mt-1 text-xs text-slate-500">{note}</p>
    </div>
  )
}

function chartSegments(points: Array<{ x: number; y: number; value: number | null }>) {
  const segments: string[][] = []
  let current: string[] = []
  for (const point of points) {
    if (point.value === null) {
      if (current.length) segments.push(current)
      current = []
      continue
    }
    current.push(`${current.length ? 'L' : 'M'} ${point.x.toFixed(2)} ${point.y.toFixed(2)}`)
  }
  if (current.length) segments.push(current)
  return segments
}

function LineChart({ title, buckets, metric, color = '#2F6E0C' }: {
  title: string
  buckets: ArcTimeseriesBucket[]
  metric: MetricKey
  color?: string
}) {
  const values = buckets.map((bucket) => bucketValue(bucket, metric))
  const present = values.filter((value): value is number => value !== null)
  const max = Math.max(...present, 1)
  const width = 520
  const height = 180
  const padX = 24
  const padY = 22
  const points = values.map((value, index) => {
    const x = buckets.length <= 1 ? width / 2 : padX + ((width - padX * 2) * index) / (buckets.length - 1)
    const y = value === null ? height - padY : padY + (height - padY * 2) * (1 - value / max)
    return { x, y, value }
  })
  const segments = chartSegments(points)
  const first = buckets[0]?.start
  const last = buckets.length ? buckets[buckets.length - 1]?.start : undefined

  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h4 className="font-semibold text-slate-950">{title}</h4>
          <p className="mt-1 text-xs text-slate-500">Verified hourly values only. Gaps mean evidence is not complete.</p>
        </div>
        <span className="rounded-full bg-[#eef7e8] px-2.5 py-1 text-[11px] font-semibold text-[#2F6E0C]">
          {present.length} points
        </span>
      </div>
      <div className="mt-4 overflow-hidden rounded-xl bg-[#f8faf7] p-3">
        <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`${title} chart`} className="h-48 w-full">
          <line x1={padX} y1={height - padY} x2={width - padX} y2={height - padY} stroke="#cbd5e1" strokeWidth="1" />
          {points.map((point, index) => point.value === null ? (
            <line key={`gap-${buckets[index]?.start}`} x1={point.x} y1={padY} x2={point.x} y2={height - padY} stroke="#cbd5e1" strokeWidth="1" strokeDasharray="4 5" />
          ) : null)}
          {segments.map((segment, index) => (
            <path key={index} d={segment.join(' ')} fill="none" stroke={color} strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
          ))}
          {points.map((point, index) => point.value !== null ? (
            <circle key={buckets[index]?.start} cx={point.x} cy={point.y} r="4" fill="white" stroke={color} strokeWidth="2">
              <title>{`${formatHourLabel(buckets[index].start)}: ${formatCount(point.value)}`}</title>
            </circle>
          ) : null)}
        </svg>
        <div className="mt-2 flex items-center justify-between text-[11px] text-slate-500">
          <span>{first ? formatHourLabel(first) : 'Unavailable'}</span>
          <span>{last ? formatHourLabel(last) : 'Unavailable'}</span>
        </div>
      </div>
    </div>
  )
}

function aggregate(buckets: ArcTimeseriesBucket[]) {
  const available = buckets.filter((bucket) => bucket.status === 'available')
  const sum = (key: MetricKey) => available.reduce((total, bucket) => {
    const value = bucketValue(bucket, key)
    return value === null ? total : total + value
  }, 0)
  const successful = sum('successfulTransactions')
  const failed = sum('failedTransactions')
  const denominator = successful + failed
  const usdcTransfers = available.some((bucket) => bucketValue(bucket, 'canonicalUsdcTransfers') !== null)
    ? sum('canonicalUsdcTransfers')
    : null
  return {
    availableHours: available.length,
    transactions: sum('transactions'),
    successRate: denominator > 0 ? (successful / denominator) * 100 : null,
    usdcTransfers,
  }
}

export default function ArcIntelligenceOverview() {
  const [window, setWindow] = useState<ArcTimeseriesWindow>('24h')
  const [state, setState] = useState<LoadState>(initialState)

  const load = useCallback(async (selectedWindow: ArcTimeseriesWindow, refreshing = false) => {
    const controller = new AbortController()
    setState((current) => ({ ...current, loading: !current.timeseries, refreshing, error: null }))
    try {
      const [timeseries, runtime] = await Promise.allSettled([
        fetchArcTimeseries(selectedWindow, controller.signal),
        fetchArcIntelligenceView<ArcIntelligenceRuntime>('runtime', controller.signal),
      ])
      if (timeseries.status === 'rejected') throw timeseries.reason
      setState({
        timeseries: timeseries.value,
        runtime: runtime.status === 'fulfilled' ? runtime.value : null,
        loading: false,
        refreshing: false,
        error: null,
      })
    } catch (error) {
      setState((current) => ({
        ...current,
        loading: false,
        refreshing: false,
        error: error instanceof Error ? error.message : 'Arc Intelligence is temporarily unavailable',
      }))
    }
    return () => controller.abort()
  }, [])

  useEffect(() => {
    const controller = new AbortController()
    setState((current) => ({ ...current, loading: true, error: null }))
    Promise.allSettled([
      fetchArcTimeseries(window, controller.signal),
      fetchArcIntelligenceView<ArcIntelligenceRuntime>('runtime', controller.signal),
    ]).then(([timeseries, runtime]) => {
      if (controller.signal.aborted) return
      if (timeseries.status === 'rejected') {
        setState((current) => ({
          ...current,
          loading: false,
          error: timeseries.reason instanceof Error ? timeseries.reason.message : 'Arc Intelligence is temporarily unavailable',
        }))
        return
      }
      setState({
        timeseries: timeseries.value,
        runtime: runtime.status === 'fulfilled' ? runtime.value : null,
        loading: false,
        refreshing: false,
        error: null,
      })
    })
    return () => controller.abort()
  }, [window])

  const series = state.timeseries
  const totals = useMemo(() => aggregate(series?.buckets ?? []), [series])
  const expectedHours = series?.coverage.expectedHours ?? (window === '24h' ? 24 : 6)
  const availableHours = series?.coverage.availableHours ?? 0
  const verifiedThrough = series?.coverage.verifiedThrough
  const hasBuckets = Boolean(series?.buckets.length)
  const hasVerifiedHours = availableHours > 0
  const catchup = (state.runtime?.lags?.headToChain ?? 0) > 0 || availableHours < expectedHours

  if (state.loading) {
    return (
      <Card className="overflow-hidden border-[#dfead8] bg-gradient-to-br from-white to-[#f8faf7]">
        <div className="animate-pulse space-y-5">
          <div className="h-5 w-48 rounded bg-slate-200" />
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {Array.from({ length: 4 }).map((_, index) => <div key={index} className="h-24 rounded-2xl bg-slate-100" />)}
          </div>
          <div className="grid gap-4 lg:grid-cols-2">
            <div className="h-72 rounded-2xl bg-slate-100" />
            <div className="h-72 rounded-2xl bg-slate-100" />
          </div>
        </div>
      </Card>
    )
  }

  if (state.error || !series) {
    return (
      <Card className="border-amber-200 bg-amber-50">
        <div className="flex items-start gap-3">
          <AlertCircle size={20} className="mt-0.5 text-amber-700" />
          <div>
            <h3 className="font-semibold text-amber-950">Arc Intelligence is temporarily unavailable</h3>
            <p className="mt-1 text-sm text-amber-900/80">
              The dashboard keeps Bridge and Earn usable while network analytics are unavailable.
            </p>
            <button
              type="button"
              onClick={() => void load(window, true)}
              className="mt-4 inline-flex items-center gap-2 rounded-xl border border-amber-300 bg-white px-3 py-2 text-xs font-semibold text-amber-900 hover:bg-amber-50"
            >
              <RefreshCw size={13} />
              Retry
            </button>
          </div>
        </div>
      </Card>
    )
  }

  return (
    <Card className="overflow-hidden border-[#dfead8] bg-gradient-to-br from-white via-white to-[#f8faf7]">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div>
          <div className="inline-flex items-center gap-2 rounded-full bg-[#eef7e8] px-3 py-1 text-xs font-semibold uppercase tracking-[0.16em] text-[#2F6E0C]">
            <ShieldCheck size={14} />
            Arc Intelligence
          </div>
          <h3 className="mt-3 text-3xl font-bold tracking-tight text-slate-950">Arc Network Activity</h3>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-600">Verified onchain activity across Arc.</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {(['6h', '24h'] as const).map((item) => (
            <button
              key={item}
              type="button"
              onClick={() => setWindow(item)}
              className={`rounded-xl px-3 py-2 text-xs font-semibold transition-colors ${
                window === item ? 'bg-[#2F6E0C] text-white' : 'border border-slate-200 bg-white text-slate-600 hover:bg-slate-50'
              }`}
            >
              {item.toUpperCase()}
            </button>
          ))}
          <button
            type="button"
            onClick={() => void load(window, true)}
            disabled={state.refreshing}
            className="inline-flex items-center justify-center gap-2 rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs font-semibold text-slate-600 hover:bg-slate-50 disabled:opacity-60"
          >
            <RefreshCw size={13} className={state.refreshing ? 'animate-spin' : ''} />
            Refresh
          </button>
        </div>
      </div>

      {!hasBuckets || !hasVerifiedHours ? (
        <div className="mt-6 rounded-3xl border border-slate-200 bg-white p-8 text-center">
          <Activity size={36} className="mx-auto text-slate-300" />
          <h4 className="mt-4 text-lg font-semibold text-slate-950">Verified historical activity is still being prepared.</h4>
          <p className="mx-auto mt-2 max-w-xl text-sm leading-6 text-slate-500">
            Charts will appear after complete hourly evidence is available. Missing hours are kept as gaps instead of zero activity.
          </p>
        </div>
      ) : (
        <>
          <div className="mt-6 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <MetricCard label="Transactions" value={formatCount(totals.transactions)} note={`${availableHours} verified hour${availableHours === 1 ? '' : 's'}`} />
            <MetricCard label="Active Addresses" value={formatCount(series?.summary?.uniqueActiveAddresses)} note="Unique across verified hours" />
            <MetricCard label="Success Rate" value={formatPercent(totals.successRate)} note="Verified successes and failures" />
            {totals.usdcTransfers !== null && (
              <MetricCard label="USDC Transfers" value={formatCount(totals.usdcTransfers)} note="Canonical verified count" />
            )}
          </div>

          <div className="mt-6 grid gap-4 xl:grid-cols-2">
            <LineChart title="Transactions over time" buckets={series.buckets} metric="transactions" />
            <LineChart title="Active addresses over time" buckets={series.buckets} metric="activeAddresses" color="#0f766e" />
            {series.buckets.some((bucket) => bucketValue(bucket, 'canonicalUsdcTransfers') !== null) && (
              <LineChart title="USDC transfers over time" buckets={series.buckets} metric="canonicalUsdcTransfers" color="#2563eb" />
            )}
          </div>
        </>
      )}

      <div className="mt-6 rounded-2xl border border-slate-200 bg-white p-4">
        <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
          <div>
            <h4 className="font-semibold text-slate-950">Data coverage</h4>
            <p className="mt-1 text-sm text-slate-500">
              {availableHours} of {expectedHours} hours verified{verifiedThrough ? ` · Verified through ${formatTimestamp(verifiedThrough)}` : ''}
            </p>
          </div>
          {catchup && (
            <span className="rounded-full bg-amber-100 px-3 py-1 text-xs font-semibold text-amber-800">
              Indexer is catching up. Charts include only verified hours.
            </span>
          )}
        </div>
      </div>
    </Card>
  )
}
