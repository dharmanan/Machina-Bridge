import { getMainnetReadiness } from '../config/mainnet'
import { MAINNET_RUNTIME_IMPLEMENTED } from '../config/runtime'

export default function MainnetPreviewGate() {
  const readiness = getMainnetReadiness()

  return (
    <main className="min-h-screen bg-slate-50 px-4 py-12 text-slate-900">
      <div className="mx-auto max-w-2xl rounded-3xl border border-slate-200 bg-white p-6 shadow-sm sm:p-8">
        <div className="inline-flex rounded-full border border-amber-200 bg-amber-50 px-3 py-1 text-xs font-semibold uppercase tracking-[0.16em] text-amber-800">
          Hidden mainnet preview
        </div>

        <h1 className="mt-5 text-3xl font-semibold tracking-tight">Machina Bridge Mainnet</h1>
        <p className="mt-3 text-sm leading-6 text-slate-600 sm:text-base">
          This deployment is intentionally locked. Real-value transactions remain disabled until Arc and Circle mainnet parameters are officially published, verified, and reviewed in this repository.
        </p>

        <div className="mt-6 rounded-2xl border border-slate-200 bg-slate-50 p-5">
          <div className="flex items-center justify-between gap-4">
            <span className="text-sm font-semibold">Transaction runtime</span>
            <span className="rounded-full bg-slate-200 px-2.5 py-1 text-xs font-semibold text-slate-700">
              {MAINNET_RUNTIME_IMPLEMENTED ? 'implemented' : 'locked'}
            </span>
          </div>

          <div className="mt-4 flex items-center justify-between gap-4">
            <span className="text-sm font-semibold">Official Arc configuration</span>
            <span className="rounded-full bg-slate-200 px-2.5 py-1 text-xs font-semibold text-slate-700">
              {readiness.ready ? 'complete' : 'incomplete'}
            </span>
          </div>

          {!readiness.ready && (
            <div className="mt-4">
              <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Still required</p>
              <ul className="mt-2 space-y-2 text-sm text-slate-600">
                {readiness.missing.map((item) => (
                  <li key={item}>• {item}</li>
                ))}
              </ul>
            </div>
          )}
        </div>

        <div className="mt-6 rounded-2xl border border-red-200 bg-red-50 p-4 text-sm leading-6 text-red-900">
          No bridge, swap, Gateway, or other real-fund transaction can be initiated from this preview.
        </div>
      </div>
    </main>
  )
}
