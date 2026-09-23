import { useEffect, useState } from 'react'
import { getCircleMainnetReadiness } from '../config/circle'
import { getMainnetReadiness } from '../config/mainnet'
import { probeArcMainnetCapabilities, type MainnetCapabilityProbeResult } from '../config/mainnetProbe'
import { MAINNET_NETWORKS } from '../config/mainnetNetworks'
import {
  probeMainnetCctpRoute,
  type MainnetCctpRouteProbe,
} from '../config/mainnetCctp'
import { MAINNET_RUNTIME_IMPLEMENTED } from '../config/runtime'

function RouteProbeCard({
  title,
  probe,
}: {
  title: string
  probe: MainnetCctpRouteProbe | null
}) {
  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-4">
      <div className="flex items-center justify-between gap-4">
        <span className="text-sm font-semibold">{title}</span>
        <span className="rounded-full bg-slate-100 px-2.5 py-1 text-xs font-semibold text-slate-700">
          {!probe ? 'checking' : probe.ready ? 'ready' : 'blocked'}
        </span>
      </div>

      {probe && (
        <ul className="mt-3 space-y-1.5 text-xs leading-5 text-slate-600">
          {probe.checks.map((check) => (
            <li key={check.key}>
              • {check.label}: {check.ok ? 'pass' : 'blocked'}
              {check.detail ? ` — ${check.detail}` : ''}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

export default function MainnetPreviewGate() {
  const readiness = getMainnetReadiness()
  const circleReadiness = getCircleMainnetReadiness()
  const [probe, setProbe] = useState<MainnetCapabilityProbeResult | null>(null)
  const [baseToArcProbe, setBaseToArcProbe] = useState<MainnetCctpRouteProbe | null>(null)
  const [arcToBaseProbe, setArcToBaseProbe] = useState<MainnetCctpRouteProbe | null>(null)

  useEffect(() => {
    let cancelled = false

    void Promise.all([
      probeArcMainnetCapabilities(),
      probeMainnetCctpRoute(MAINNET_NETWORKS.base.chainId, MAINNET_NETWORKS.arc.chainId),
      probeMainnetCctpRoute(MAINNET_NETWORKS.arc.chainId, MAINNET_NETWORKS.base.chainId),
    ]).then(([arcProbe, baseToArc, arcToBase]) => {
      if (cancelled) {
        return
      }

      setProbe(arcProbe)
      setBaseToArcProbe(baseToArc)
      setArcToBaseProbe(arcToBase)
    })

    return () => {
      cancelled = true
    }
  }, [])

  return (
    <main className="min-h-screen bg-slate-50 px-4 py-12 text-slate-900">
      <div className="mx-auto max-w-3xl rounded-3xl border border-slate-200 bg-white p-6 shadow-sm sm:p-8">
        <div className="inline-flex rounded-full border border-amber-200 bg-amber-50 px-3 py-1 text-xs font-semibold uppercase tracking-[0.16em] text-amber-800">
          Hidden mainnet preview
        </div>

        <h1 className="mt-5 text-3xl font-semibold tracking-tight">Machina Bridge Mainnet</h1>
        <p className="mt-3 text-sm leading-6 text-slate-600 sm:text-base">
          Mainnet infrastructure is being verified against live Arc and Circle production services.
          This preview is intentionally read-only while the transaction runtime remains locked.
        </p>

        <div className="mt-6 rounded-2xl border border-slate-200 bg-slate-50 p-5">
          <div className="flex items-center justify-between gap-4">
            <span className="text-sm font-semibold">Transaction runtime</span>
            <span className="rounded-full bg-slate-200 px-2.5 py-1 text-xs font-semibold text-slate-700">
              {MAINNET_RUNTIME_IMPLEMENTED ? 'implemented' : 'locked'}
            </span>
          </div>

          <div className="mt-4 flex items-center justify-between gap-4">
            <span className="text-sm font-semibold">Official Arc network configuration</span>
            <span className="rounded-full bg-slate-200 px-2.5 py-1 text-xs font-semibold text-slate-700">
              {readiness.ready ? 'complete' : 'incomplete'}
            </span>
          </div>

          <div className="mt-4 flex items-center justify-between gap-4">
            <span className="text-sm font-semibold">Circle CCTP mainnet support</span>
            <span className="rounded-full bg-slate-200 px-2.5 py-1 text-xs font-semibold text-slate-700">
              {circleReadiness.cctpReady ? 'configured' : 'not ready'}
            </span>
          </div>

          <div className="mt-4 flex items-center justify-between gap-4">
            <span className="text-sm font-semibold">Circle Gateway mainnet support</span>
            <span className="rounded-full bg-slate-200 px-2.5 py-1 text-xs font-semibold text-slate-700">
              {circleReadiness.gatewayReady ? 'configured' : 'not ready'}
            </span>
          </div>

          <div className="mt-4 flex items-center justify-between gap-4">
            <span className="text-sm font-semibold">Arc live capability probe</span>
            <span className="rounded-full bg-slate-200 px-2.5 py-1 text-xs font-semibold text-slate-700">
              {!probe ? 'checking' : probe.ready ? 'ready' : 'blocked'}
            </span>
          </div>

          {circleReadiness.missing.length > 0 && (
            <div className="mt-5">
              <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Still required</p>
              <ul className="mt-2 space-y-2 text-sm text-slate-600">
                {circleReadiness.missing.map((item) => (
                  <li key={item}>• {item}</li>
                ))}
              </ul>
            </div>
          )}

          {probe && probe.checks.length > 0 && (
            <div className="mt-5 border-t border-slate-200 pt-5">
              <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Arc live checks</p>
              <ul className="mt-2 space-y-2 text-sm text-slate-600">
                {probe.checks.map((check) => (
                  <li key={check.key}>
                    • {check.label}: {check.ok ? 'pass' : 'blocked'}
                    {check.detail ? ` — ${check.detail}` : ''}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>

        <div className="mt-6">
          <div className="mb-3">
            <p className="text-xs font-semibold uppercase tracking-[0.14em] text-slate-500">
              Live CCTP route probes
            </p>
            <p className="mt-1 text-sm leading-6 text-slate-600">
              These checks read production RPCs, deployed contracts, and Circle fee availability.
              They do not connect a wallet or submit a transaction.
            </p>
          </div>

          <div className="grid gap-3 md:grid-cols-2">
            <RouteProbeCard title="Base → Arc" probe={baseToArcProbe} />
            <RouteProbeCard title="Arc → Base" probe={arcToBaseProbe} />
          </div>
        </div>

        <div className="mt-6 rounded-2xl border border-red-200 bg-red-50 p-4 text-sm leading-6 text-red-900">
          No bridge, swap, Gateway, wallet signature, approval, burn, mint, or other real-fund transaction can be initiated from this preview.
        </div>
      </div>
    </main>
  )
}
