import { useEffect, useMemo, useState } from 'react'
import { ArrowLeftRight, CheckCircle2, LockKeyhole } from 'lucide-react'
import { getCircleMainnetReadiness } from '../config/circle'
import { getMainnetReadiness } from '../config/mainnet'
import { probeArcMainnetCapabilities, type MainnetCapabilityProbeResult } from '../config/mainnetProbe'
import { MAINNET_NETWORKS } from '../config/mainnetNetworks'
import {
  probeMainnetCctpRoute,
  type MainnetCctpRouteProbe,
} from '../config/mainnetCctp'
import { MAINNET_RUNTIME_IMPLEMENTED } from '../config/runtime'

type RouteEndpoint = 'base' | 'arc'

function StatusRow({
  label,
  state,
}: {
  label: string
  state: 'ready' | 'checking' | 'locked' | 'blocked'
}) {
  return (
    <div className="flex items-center justify-between gap-4">
      <span className="text-sm font-medium text-slate-700">{label}</span>
      <span
        className={`rounded-full px-2.5 py-1 text-xs font-semibold ${
          state === 'ready'
            ? 'bg-[#eef7e8] text-[#2F6E0C]'
            : state === 'locked'
              ? 'bg-slate-200 text-slate-700'
              : state === 'blocked'
                ? 'bg-amber-100 text-amber-800'
                : 'bg-slate-100 text-slate-500'
        }`}
      >
        {state === 'blocked' ? 'attention' : state}
      </span>
    </div>
  )
}

export default function MainnetPreviewGate() {
  const readiness = getMainnetReadiness()
  const circleReadiness = getCircleMainnetReadiness()
  const [probe, setProbe] = useState<MainnetCapabilityProbeResult | null>(null)
  const [baseToArcProbe, setBaseToArcProbe] = useState<MainnetCctpRouteProbe | null>(null)
  const [arcToBaseProbe, setArcToBaseProbe] = useState<MainnetCctpRouteProbe | null>(null)
  const [source, setSource] = useState<RouteEndpoint>('base')
  const [amount, setAmount] = useState('')

  const destination: RouteEndpoint = source === 'base' ? 'arc' : 'base'
  const sourceName = source === 'base' ? 'Base' : 'Arc'
  const destinationName = destination === 'base' ? 'Base' : 'Arc'
  const activeRouteProbe = source === 'base' ? baseToArcProbe : arcToBaseProbe

  useEffect(() => {
    let cancelled = false

    const run = async () => {
      const [arcResult, baseToArcResult, arcToBaseResult] = await Promise.allSettled([
        probeArcMainnetCapabilities(),
        probeMainnetCctpRoute(MAINNET_NETWORKS.base.chainId, MAINNET_NETWORKS.arc.chainId),
        probeMainnetCctpRoute(MAINNET_NETWORKS.arc.chainId, MAINNET_NETWORKS.base.chainId),
      ])

      if (cancelled) return

      if (arcResult.status === 'fulfilled') setProbe(arcResult.value)
      if (baseToArcResult.status === 'fulfilled') setBaseToArcProbe(baseToArcResult.value)
      if (arcToBaseResult.status === 'fulfilled') setArcToBaseProbe(arcToBaseResult.value)
    }

    void run()

    return () => {
      cancelled = true
    }
  }, [])

  const arcStatus = useMemo<'ready' | 'checking' | 'blocked'>(() => {
    if (!probe) return 'checking'
    return readiness.ready && probe.ready ? 'ready' : 'blocked'
  }, [probe, readiness.ready])

  const circleStatus: 'ready' | 'blocked' = circleReadiness.cctpReady ? 'ready' : 'blocked'
  const routeStatus: 'ready' | 'checking' | 'blocked' = !activeRouteProbe
    ? 'checking'
    : activeRouteProbe.ready
      ? 'ready'
      : 'blocked'

  const swapRoute = () => {
    setSource((current) => (current === 'base' ? 'arc' : 'base'))
  }

  return (
    <section className="bg-slate-50 px-4 py-8 text-slate-900">
      <div className="mx-auto max-w-xl">
        <div className="rounded-3xl border border-slate-200 bg-white p-6 shadow-[0_16px_45px_rgba(15,23,42,0.08)]">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h2 className="text-2xl font-semibold tracking-tight text-slate-900">Bridge USDC</h2>
              <p className="mt-2 text-sm leading-6 text-slate-500">
                Choose a mainnet route and review live readiness. Transfers remain locked for now.
              </p>
            </div>
            <span className="rounded-full border border-amber-200 bg-amber-50 px-3 py-1 text-xs font-semibold text-amber-800">
              Mainnet
            </span>
          </div>

          <div className="mt-6 rounded-2xl border border-slate-200 bg-slate-50 p-4">
            <div className="grid grid-cols-[1fr_auto_1fr] items-end gap-3">
              <label className="min-w-0">
                <span className="mb-2 block text-center text-xs font-medium text-slate-500">From</span>
                <select
                  value={source}
                  onChange={(event) => setSource(event.target.value as RouteEndpoint)}
                  className="h-11 w-full rounded-xl border border-slate-200 bg-white px-3 text-sm font-semibold text-slate-900 outline-none transition-colors focus:border-[#66D121]"
                >
                  <option value="base">Base</option>
                  <option value="arc">Arc</option>
                </select>
              </label>

              <button
                type="button"
                onClick={swapRoute}
                className="mb-0.5 inline-flex h-10 w-10 items-center justify-center rounded-xl border border-slate-200 bg-white text-slate-500 shadow-sm transition-colors hover:border-[#66D121]/40 hover:text-[#2F6E0C]"
                aria-label="Swap mainnet route"
              >
                <ArrowLeftRight size={16} />
              </button>

              <label className="min-w-0">
                <span className="mb-2 block text-center text-xs font-medium text-slate-500">To</span>
                <select
                  value={destination}
                  onChange={(event) => {
                    const nextDestination = event.target.value as RouteEndpoint
                    setSource(nextDestination === 'arc' ? 'base' : 'arc')
                  }}
                  className="h-11 w-full rounded-xl border border-slate-200 bg-white px-3 text-sm font-semibold text-slate-900 outline-none transition-colors focus:border-[#66D121]"
                >
                  <option value="arc">Arc</option>
                  <option value="base">Base</option>
                </select>
              </label>
            </div>
          </div>

          <div className="mt-5">
            <label className="text-sm font-medium text-slate-700">Token</label>
            <div className="mt-2 rounded-2xl border border-slate-200 bg-white px-4 py-4">
              <span className="font-semibold text-slate-900">USDC</span>
              <span className="ml-2 text-sm text-slate-500">(USD Coin)</span>
            </div>
          </div>

          <div className="mt-5">
            <label htmlFor="mainnet-preview-amount" className="text-sm font-medium text-slate-700">
              Amount
            </label>
            <input
              id="mainnet-preview-amount"
              type="number"
              min="0"
              step="0.01"
              inputMode="decimal"
              value={amount}
              onChange={(event) => setAmount(event.target.value)}
              placeholder="0.00"
              className="mt-2 h-12 w-full rounded-2xl border border-slate-200 bg-white px-4 text-base text-slate-900 outline-none transition-colors placeholder:text-slate-400 focus:border-[#66D121]"
            />
          </div>

          <div className="mt-5 rounded-2xl border border-blue-200 bg-blue-50 px-4 py-3 text-xs leading-5 text-blue-900">
            Live readiness checks use production RPCs and Circle services in read-only mode. No wallet signature or transaction is submitted.
          </div>

          <div className="mt-5 rounded-2xl border border-slate-200 bg-slate-50 p-4">
            <div className="mb-3 flex items-center gap-2">
              <CheckCircle2 size={16} className="text-[#2F6E0C]" />
              <p className="text-sm font-semibold text-slate-900">Mainnet status</p>
            </div>
            <div className="space-y-3">
              <StatusRow label="Arc Mainnet" state={arcStatus} />
              <StatusRow label="Circle CCTP" state={circleStatus} />
              <StatusRow label={`${sourceName} → ${destinationName} route`} state={routeStatus} />
              <StatusRow label="Transactions" state={MAINNET_RUNTIME_IMPLEMENTED ? 'ready' : 'locked'} />
            </div>
          </div>

          <button
            type="button"
            disabled
            className="mt-5 inline-flex h-12 w-full cursor-not-allowed items-center justify-center gap-2 rounded-2xl bg-[#9fbd90] px-4 text-sm font-semibold text-white opacity-90"
          >
            <LockKeyhole size={16} />
            Bridge {amount && Number(amount) > 0 ? amount : '0'} USDC
          </button>

          <p className="mt-3 text-center text-xs leading-5 text-slate-500">
            Mainnet transfers will remain unavailable until the production transaction runtime is deliberately unlocked.
          </p>
        </div>
      </div>
    </section>
  )
}
