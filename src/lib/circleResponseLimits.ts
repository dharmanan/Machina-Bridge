// Permanent, origin/path-scoped guard, never a temporary fetch replacement around an awaited SDK call.
// Only Borrow/Swap service bodies are bounded. Bridge/Earn, wallet RPC and all other fetches pass through unchanged.
export const CIRCLE_RESPONSE_LIMITS = Object.freeze({ bytes: 256 * 1024, nodes: 8192, depth: 32, width: 256, string: 128 * 1024, timeoutMs: 8000 })
export class CircleResponseLimitError extends Error {
  constructor(readonly code: 'body_size' | 'json_shape' | 'timeout' | 'invalid_json') { super(`Circle service response unavailable (${code}).`); this.name = 'CircleResponseLimitError' }
}
const guarded = new WeakSet<typeof fetch>()
export function isCircleGuardedRequest(input: RequestInfo | URL): boolean {
  try {
    const url = new URL(input instanceof Request ? input.url : String(input))
    return url.origin === 'https://api.circle.com' && (url.pathname.startsWith('/v1/borrowKit/') || url.pathname.startsWith('/v1/stablecoinKits/'))
  } catch { return false }
}
export function assertBoundedCircleJson(text: string): void {
  let data: unknown
  try { data = JSON.parse(text) } catch { throw new CircleResponseLimitError('invalid_json') }
  const pending: { value: unknown; depth: number }[] = [{ value: data, depth: 0 }]
  let nodes = 0
  while (pending.length) {
    const { value, depth } = pending.pop()!
    if (++nodes > CIRCLE_RESPONSE_LIMITS.nodes || depth > CIRCLE_RESPONSE_LIMITS.depth) throw new CircleResponseLimitError('json_shape')
    if (typeof value === 'string' && value.length > CIRCLE_RESPONSE_LIMITS.string) throw new CircleResponseLimitError('json_shape')
    if (!value || typeof value !== 'object') continue
    if (Array.isArray(value) && value.length > CIRCLE_RESPONSE_LIMITS.width) throw new CircleResponseLimitError('json_shape')
    const keys = Object.keys(value)
    if (keys.length > CIRCLE_RESPONSE_LIMITS.width) throw new CircleResponseLimitError('json_shape')
    for (const key of keys) {
      if (key.length > CIRCLE_RESPONSE_LIMITS.string) throw new CircleResponseLimitError('json_shape')
      pending.push({ value: (value as Record<string, unknown>)[key], depth: depth + 1 })
    }
  }
}
export function createBoundedCircleFetch(underlying: typeof fetch): typeof fetch {
  const bounded: typeof fetch = async (input, init) => {
    if (!isCircleGuardedRequest(input)) return underlying(input, init)
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
      if (declared !== null && /^\d+$/.test(declared) && BigInt(declared) > BigInt(CIRCLE_RESPONSE_LIMITS.bytes)) {
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
        if (size > CIRCLE_RESPONSE_LIMITS.bytes) throw new CircleResponseLimitError('body_size')
        chunks.push(value)
      }
      const bytes = new Uint8Array(size)
      let offset = 0
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
      if (size) {
        let text: string
        try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes) } catch { throw new CircleResponseLimitError('invalid_json') }
        assertBoundedCircleJson(text)
      }
      // Preserve original JSON bytes: no number/decimal/calldata reserialization.
      const headers = new Headers(response.headers); headers.delete('content-encoding'); headers.delete('content-length')
      const result = new Response(size ? bytes : null, { status: response.status, statusText: response.statusText, headers })
      Object.defineProperties(result, { url: { value: response.url }, redirected: { value: response.redirected }, type: { value: response.type } })
      return result
    }
    try {
      return await Promise.race([interrupted, work(), new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => { timeout = true; controller.abort(); reject(new CircleResponseLimitError('timeout')) }, CIRCLE_RESPONSE_LIMITS.timeoutMs)
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
