// Ephemeral, bounded diagnostics. Never accept request parameters, payloads, addresses or error text.
export type CircleTimingStage = 'review_preparation' | 'review' | 'quote' | 'review_facts' | 'reference' | 'provider' | 'preflight' | 'public_nonce' | 'wallet_nonce' | 'sdk_preparation' | 'first_wallet_preparation' | 'create_swap_http' | 'step_preparation'
export type CircleTimingOutcome = 'ok' | 'error' | 'timeout' | 'retry' | 'unavailable'
export type CircleTimingReason = 'none' | 'rpc' | 'nonce_conflict' | 'nonce_observation' | 'expired' | 'context' | 'rejected' | 'unsupported' | 'sdk' | 'unknown' | 'resource_timing_unavailable' | 'http_status_hidden' | 'http_client' | 'http_server' | 'rate_limit' | 'observed_http_only'
export interface CircleTiming { cycle: number; stage: CircleTimingStage; ms: number; outcome: CircleTimingOutcome; reason: CircleTimingReason; pass: number }
export function circleTimingFailure(error: unknown): { outcome: CircleTimingOutcome; reason: CircleTimingReason } {
  // Read only fixed protocol fields; never retain error objects, causes, stacks or arbitrary messages.
  let name: unknown, message: unknown, code: unknown, kind: unknown
  try { const e = error as { name?: unknown; message?: unknown; code?: unknown; kind?: unknown }; name = e?.name; message = e?.message; code = e?.code; kind = e?.kind } catch { /* hostile provider object */ }
  if (name === 'TimeoutError' || name === 'AbortError' || kind === 'timeout' || ['quote_timeout', 'sdk_stalled', 'step_timeout', 'wallet_timeout'].includes(message as string)) return { outcome: 'timeout', reason: message === 'sdk_stalled' ? 'sdk' : 'rpc' }
  if (message === 'nonce_rpc') return { outcome: 'error', reason: 'nonce_conflict' }
  if ((message === 'public_nonce' || message === 'wallet_nonce') && kind === undefined) return { outcome: 'error', reason: 'nonce_observation' }
  if (message === 'expired' || message === 'quote_expired') return { outcome: 'error', reason: 'expired' }
  if (message === 'context') return { outcome: 'error', reason: 'context' }
  if (code === 4001 || kind === 'rejected' || code === 'step_declined') return { outcome: 'error', reason: 'rejected' }
  if (kind === 'unsupported' || code === 4200 || code === -32601) return { outcome: 'error', reason: 'unsupported' }
  if (code === -32603 || code === -32602) return { outcome: 'error', reason: 'rpc' }
  if (message === 'wallet_rpc' || ['rpc-error', 'disconnected', 'wrong-chain'].includes(kind as string)) return { outcome: 'error', reason: 'rpc' }
  let nested = error
  for (let depth = 0; depth < 4; depth++) {
    try {
      const e = nested as { name?: unknown; cause?: unknown }
      if (e?.name === 'TimeoutError' || e?.name === 'AbortError') return { outcome: 'timeout', reason: 'rpc' }
      if (e?.name === 'UserRejectedRequestError') return { outcome: 'error', reason: 'rejected' }
      nested = e?.cause
    } catch { break }
  }
  if (name === 'HttpRequestError' || name === 'RpcRequestError') return { outcome: 'error', reason: 'rpc' }
  return { outcome: 'error', reason: 'unknown' }
}
export function createCirclePerformance(clock: () => number = () => performance.now()) {
  let cycle = 0
  const records: CircleTiming[] = []
  const append = (record: CircleTiming) => { if (record.cycle !== cycle) return; records.push(record); if (records.length > 64) records.shift() }
  function start(stage: CircleTimingStage, pass = 1) {
    const started = clock(), scope = cycle
    let done = false
    return (outcome: CircleTimingOutcome = 'ok', reason: CircleTimingReason = 'none', elapsed?: number) => {
      if (done) return
      done = true
      const ms = elapsed ?? clock() - started
      append({ cycle: scope, stage, ms: Number.isFinite(ms) ? Math.max(0, Math.min(3_600_000, Math.round(ms))) : 0, outcome, reason, pass })
    }
  }
  return {
    start,
    begin() { cycle++; records.length = 0 },
    snapshot: () => records.map(record => ({ ...record })),
    async measure<T>(stage: CircleTimingStage, run: () => Promise<T>, pass = 1): Promise<T> {
      const end = start(stage, pass)
      try { const result = await run(); end(); return result } catch (error) { const failure = circleTimingFailure(error); end(failure.outcome, failure.reason); throw error }
    },
  }
}
export type CirclePerformance = ReturnType<typeof createCirclePerformance>

// Observe actual completed HTTP resources without replacing fetch or inspecting payloads.
// Cross-origin timing/status may be hidden, and concurrent SDK estimate calls use the same URL.
// Consequently these entries are observations, never an asserted SDK retry count or isolated createSwap wall time.
export function observeCircleHttp(metrics: CirclePerformance): () => void {
  if (typeof PerformanceObserver === 'undefined' || !PerformanceObserver.supportedEntryTypes?.includes('resource')) {
    metrics.start('create_swap_http')('unavailable', 'resource_timing_unavailable')
    return () => {}
  }
  const started = performance.now()
  let observed = 0, closed = false
  function consume(entries: PerformanceEntry[]) {
    for (const entry of entries) {
      if (entry.entryType !== 'resource' || entry.startTime < started) continue
      let target: URL
      try { target = new URL(entry.name) } catch { continue }
      if (target.origin !== 'https://api.circle.com' || target.pathname !== '/v1/stablecoinKits/swap') continue
      observed++
      const status = (entry as PerformanceResourceTiming & { responseStatus?: number }).responseStatus
      metrics.start('create_swap_http')(typeof status === 'number' && status >= 400 ? 'error' : status ? 'ok' : 'unavailable',
        status === 429 ? 'rate_limit' : typeof status === 'number' && status >= 500 ? 'http_server' : typeof status === 'number' && status >= 400 ? 'http_client' : status ? 'observed_http_only' : 'http_status_hidden', entry.duration)
    }
  }
  try {
    const observer = new PerformanceObserver(list => { if (!closed) consume(list.getEntries()) })
    observer.observe({ type: 'resource' })
    return () => {
      if (closed) return
      closed = true
      consume(observer.takeRecords()); observer.disconnect()
      if (observed === 0) metrics.start('create_swap_http')('unavailable', 'resource_timing_unavailable')
    }
  } catch {
    metrics.start('create_swap_http')('unavailable', 'resource_timing_unavailable')
    return () => {}
  }
}
