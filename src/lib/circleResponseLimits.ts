// Permanent, origin/path-scoped guard, never a temporary fetch replacement around an awaited SDK call.
// Bounded: Borrow/Swap service bodies, Circle Iris CCTP message reads and Circle EarnKit service responses.
// Iris fee quotes and reattestation, wallet RPC and unrelated origins pass through unchanged.
export const CIRCLE_RESPONSE_LIMITS = Object.freeze({ bytes: 256 * 1024, nodes: 8192, depth: 32, width: 256, string: 128 * 1024, timeoutMs: 8000 })
// Iris messages: a real Mainnet response is ~1.3 KB per message; app recovery already caps it at 256 KiB/10 s.
// BridgeKit polling passes its own 2 s abort signal, which still wins for SDK calls. Non-2xx bodies keep their
// bytes, status and headers unparsed (404/429/5xx handling stays with the caller and the SDK retry policy).
export const IRIS_MESSAGES_RESPONSE_LIMITS = Object.freeze({ bytes: 256 * 1024, nodes: 8192, depth: 32, width: 256, string: 128 * 1024, timeoutMs: 10_000 })
// F4-B2: separately sized for Earn's growing vault discovery. Observed Mainnet explore: 50.18 KiB,
// 2562 nodes, 38 vaults, 371 ms; position/quotes: < 0.5 KiB, < 500 ms. Other legitimate
// responses and future vault growth remain uncertain. Error bodies keep their SDK semantics.
export const EARN_RESPONSE_LIMITS = Object.freeze({ bytes: 2 * 1024 * 1024, nodes: 65_536, depth: 48, width: 1_024, string: 128 * 1024, timeoutMs: 15_000 })
type CircleResponseLimits = Readonly<Record<'bytes' | 'nodes' | 'depth' | 'width' | 'string' | 'timeoutMs', number>>
type GuardProfile = { limits: CircleResponseLimits; validateErrorBodies: boolean }
const SERVICE_PROFILE: GuardProfile = { limits: CIRCLE_RESPONSE_LIMITS, validateErrorBodies: true }
const IRIS_MESSAGES_PROFILE: GuardProfile = { limits: IRIS_MESSAGES_RESPONSE_LIMITS, validateErrorBodies: false }
const EARN_PROFILE: GuardProfile = { limits: EARN_RESPONSE_LIMITS, validateErrorBodies: false }
export class CircleResponseLimitError extends Error {
  constructor(readonly code: 'body_size' | 'json_shape' | 'timeout' | 'invalid_json') { super(`Circle service response unavailable (${code}).`); this.name = 'CircleResponseLimitError' }
}
const guarded = new WeakSet<typeof fetch>()
function guardProfile(input: RequestInfo | URL): GuardProfile | null {
  try {
    const url = new URL(input instanceof Request ? input.url : String(input))
    if (url.origin === 'https://api.circle.com' && (url.pathname.startsWith('/v1/borrowKit/') || url.pathname.startsWith('/v1/stablecoinKits/'))) return SERVICE_PROFILE
    if (url.origin === 'https://api.circle.com' && url.pathname.startsWith('/v1/earnKit/')) return EARN_PROFILE
    if (url.origin === 'https://iris-api.circle.com' && url.pathname.startsWith('/v2/messages/')) return IRIS_MESSAGES_PROFILE
    return null
  } catch { return null }
}
export function isCircleGuardedRequest(input: RequestInfo | URL): boolean {
  return guardProfile(input) !== null
}
export function assertBoundedCircleJson(text: string, limits: CircleResponseLimits = CIRCLE_RESPONSE_LIMITS): void {
  let data: unknown
  try { data = JSON.parse(text) } catch { throw new CircleResponseLimitError('invalid_json') }
  const pending: { value: unknown; depth: number }[] = [{ value: data, depth: 0 }]
  let nodes = 0
  while (pending.length) {
    const { value, depth } = pending.pop()!
    if (++nodes > limits.nodes || depth > limits.depth) throw new CircleResponseLimitError('json_shape')
    if (typeof value === 'string' && value.length > limits.string) throw new CircleResponseLimitError('json_shape')
    if (!value || typeof value !== 'object') continue
    if (Array.isArray(value) && value.length > limits.width) throw new CircleResponseLimitError('json_shape')
    const keys = Object.keys(value)
    if (keys.length > limits.width) throw new CircleResponseLimitError('json_shape')
    for (const key of keys) {
      if (key.length > limits.string) throw new CircleResponseLimitError('json_shape')
      pending.push({ value: (value as Record<string, unknown>)[key], depth: depth + 1 })
    }
  }
}
export function createBoundedCircleFetch(underlying: typeof fetch): typeof fetch {
  const bounded: typeof fetch = async (input, init) => {
    const profile = guardProfile(input)
    if (!profile) return underlying(input, init)
    const limits = profile.limits
    const controller = new AbortController(), signal = init?.signal ?? (input instanceof Request ? input.signal : undefined)
    if (signal?.aborted) throw signal.reason ?? new DOMException('Aborted', 'AbortError')
    let rejectAbort: (reason: unknown) => void = () => {}
    const interrupted = new Promise<never>((_resolve, reject) => { rejectAbort = reject })
    const abort = () => { controller.abort(signal?.reason); rejectAbort(signal?.reason ?? new DOMException('Aborted', 'AbortError')) }
    signal?.addEventListener('abort', abort, { once: true })
    let timer: ReturnType<typeof setTimeout> | undefined, reader: ReadableStreamDefaultReader<Uint8Array> | undefined
    let timeout = false
    const work = async () => {
      const response = await underlying(input, { ...init, signal: controller.signal })
      if (controller.signal.aborted) { void response.body?.cancel().catch(() => {}); throw controller.signal.reason }
      if (!response.body) return response
      const declared = response.headers.get('content-length')
      if (declared !== null && /^\d+$/.test(declared) && BigInt(declared) > BigInt(limits.bytes)) {
        void response.body.cancel().catch(() => {}); throw new CircleResponseLimitError('body_size')
      }
      reader = response.body.getReader()
      let size = 0
      const chunks: Uint8Array[] = []
      for (;;) {
        if (controller.signal.aborted) throw controller.signal.reason
        const { done, value } = await reader.read()
        if (done) break
        size += value.byteLength
        if (size > limits.bytes) throw new CircleResponseLimitError('body_size')
        chunks.push(value)
      }
      const bytes = new Uint8Array(size)
      let offset = 0
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
      // Error bodies of profiles that do not validate them stay byte-bounded but unparsed (HTML/plain error pages pass).
      if (size && (response.ok || profile.validateErrorBodies)) {
        let text: string
        try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes) } catch { throw new CircleResponseLimitError('invalid_json') }
        assertBoundedCircleJson(text, limits)
      }
      // Preserve original JSON bytes: no number/decimal/calldata reserialization.
      const headers = new Headers(response.headers); headers.delete('content-encoding'); headers.delete('content-length')
      const result = new Response(size ? bytes : null, { status: response.status, statusText: response.statusText, headers })
      Object.defineProperties(result, { url: { value: response.url }, redirected: { value: response.redirected }, type: { value: response.type } })
      return result
    }
    try {
      return await Promise.race([interrupted, work(), new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => { timeout = true; controller.abort(); reject(new CircleResponseLimitError('timeout')) }, limits.timeoutMs)
      })])
    } catch (error) {
      controller.abort()
      if (reader) void reader.cancel().catch(() => {})
      if (timeout) throw new CircleResponseLimitError('timeout')
      throw error
    } finally { if (timer !== undefined) clearTimeout(timer); signal?.removeEventListener('abort', abort) }
  }
  guarded.add(bounded)
  return bounded
}
export function installCircleResponseLimits(): void {
  if (!guarded.has(globalThis.fetch)) globalThis.fetch = createBoundedCircleFetch(globalThis.fetch)
}
