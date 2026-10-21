import { requestKey, validateArcRequest, validateArcReview, type ArcRequest, type ArcReview } from './uniswapArcPolicy'

export interface ArcWalletContext { owner: string; chainId: number; connected: boolean }
export type ArcPreviewErrorCode = 'http_origin' | 'http_rate' | 'http_unavailable' | 'http_route' | 'http_request' | 'transport' | 'timeout' | 'response' | 'timing' | 'expired' | 'context' | 'policy' | 'busy' | 'cancelled'
export class ArcPreviewError extends Error {
  constructor(readonly code: ArcPreviewErrorCode, readonly status?: number) { super(code); this.name = 'ArcPreviewError' }
}
export function uniswapArcPreviewErrorMessage(error: unknown): string {
  const code = error instanceof ArcPreviewError ? error.code : 'response'
  const status = error instanceof ArcPreviewError && error.status ? ` (HTTP ${error.status})` : ''
  const messages: Record<ArcPreviewErrorCode, string> = {
    http_origin: `This site address is not allowed by the preview server${status}. The server origin configuration must match the address in your browser.`,
    http_rate: `Too many preview requests${status}. Wait a minute before requesting another quote.`,
    http_unavailable: `The server could not verify a current quote${status}. No transaction is authorized.`,
    http_route: `The preview API route is unavailable${status}. Open the app through its API-enabled server.`,
    http_request: `The preview request was rejected${status}. No transaction is authorized.`,
    transport: 'The preview server could not be reached. No HTTP response was received.',
    timeout: 'The preview request timed out. Request a fresh quote; no transaction is authorized.',
    response: 'The preview server returned an invalid or incompatible response. No quote was accepted.',
    timing: 'Preview freshness could not be verified. The app and API must use the matching preview protocol; no expired quote was accepted.',
    expired: 'The quote expired during verification. Request a fresh preview.',
    context: 'The wallet, network or quote inputs changed. Request a fresh preview for the current wallet.',
    policy: 'The quote failed transaction safety checks. Its output and fees cannot be displayed as verified.',
    busy: 'A preview request for this wallet is still finishing. Wait for it to finish before requesting another.',
    cancelled: 'The preview was cancelled after the page or wallet context changed.',
  }
  return messages[code]
}
const pendingWallets = new Set<string>()
interface Clock { wallNow(): number; monotonicNow(): number }
const browserClock: Clock = { wallNow: () => Date.now(), monotonicNow: () => performance.now() }
// No wallet provider, signing adapter or direct Uniswap API access in the browser.
export function createUniswapArcPreviewReader(getContext: () => ArcWalletContext, fetcher: typeof fetch = fetch, clock: Clock = browserClock) {
  let generation = 0
  let current: ArcReview | null = null
  let controller: AbortController | null = null
  let receivedMono = 0, receivedWall = 0, serverUpperAtReceipt = 0
  function invalidate() { generation++; current = null; controller?.abort() }
  function serverNow(localWall = clock.wallNow()) {
    const monoElapsed = clock.monotonicNow() - receivedMono
    const wallElapsed = localWall - receivedWall
    if (!Number.isFinite(monoElapsed) || monoElapsed < 0 || !Number.isFinite(wallElapsed)) throw new ArcPreviewError('timing')
    // A forward wall-clock jump expires conservatively. A backward jump never extends TTL.
    return serverUpperAtReceipt + Math.ceil(Math.max(monoElapsed, wallElapsed, 0))
  }
  function checked(expectedRequest: ArcRequest, localWall?: number): ArcReview | null {
    if (!current) return null
    try {
      if (requestKey(current.request) !== requestKey(expectedRequest)) throw new ArcPreviewError('context')
      validateArcReview(current, getContext(), serverNow(localWall))
      return structuredClone(current)
    } catch { invalidate(); return null }
  }
  return {
    invalidate,
    current: checked,
    remainingMs(expectedRequest: ArcRequest): number {
      const review = checked(expectedRequest)
      return review ? Math.max(0, Math.floor(review.expiresAt - serverNow())) : 0
    },
    async read(input: ArcRequest): Promise<ArcReview> {
      const request = validateArcRequest(input)
      const owner = request.owner.toLowerCase()
      if (pendingWallets.has(owner)) throw new ArcPreviewError('busy')
      const context = getContext()
      if (!context.connected || context.chainId !== 5042 || context.owner.toLowerCase() !== owner) throw new ArcPreviewError('context')
      invalidate()
      const version = generation
      const expectedKey = requestKey(request)
      const requestId = crypto.randomUUID()
      const startedMono = clock.monotonicNow()
      const abort = new AbortController(); controller = abort
      let timedOut = false
      const timer = setTimeout(() => { timedOut = true; abort.abort() }, 22000)
      pendingWallets.add(owner)
      try {
        let response: Response
        try {
          response = await fetcher('/api/uniswap-arc-preview', { method: 'POST', credentials: 'same-origin', cache: 'no-store',
            headers: { 'Content-Type': 'application/json', 'X-Preview-Request-Id': requestId }, body: JSON.stringify(request), signal: abort.signal, redirect: 'error' })
        } catch { throw new ArcPreviewError(timedOut ? 'timeout' : version !== generation ? 'cancelled' : 'transport') }
        if (!response.ok) {
          const status = response.status
          throw new ArcPreviewError(status === 403 ? 'http_origin' : status === 429 ? 'http_rate' : status === 404 || status === 405 ? 'http_route' : status >= 500 ? 'http_unavailable' : 'http_request', status)
        }
        if (!response.body || response.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') throw new ArcPreviewError('response')
        const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0
        try {
          while (true) { const chunk = await reader.read(); if (chunk.done) break; size += chunk.value.length; if (size > 131072) throw new ArcPreviewError('response'); chunks.push(chunk.value) }
        } finally { await reader.cancel().catch(() => undefined) }
        const bytes = new Uint8Array(size); let offset = 0
        for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length }
        let review: ArcReview
        try { review = JSON.parse(new TextDecoder().decode(bytes)) as ArcReview } catch { throw new ArcPreviewError('response') }
        if (version !== generation || abort.signal.aborted) throw new ArcPreviewError(timedOut ? 'timeout' : 'cancelled')
        if (!review || typeof review !== 'object' || !review.request) throw new ArcPreviewError('response')
        if (requestKey(review.request) !== expectedKey) throw new ArcPreviewError('context')
        const serverTimeText = response.headers.get('X-Preview-Server-Time')
        if (response.headers.get('X-Preview-Request-Id') !== requestId || !serverTimeText || !/^[1-9]\d{0,15}$/.test(serverTimeText)) throw new ArcPreviewError('timing')
        const serverTime = Number(serverTimeText)
        const finishedMono = clock.monotonicNow(), roundTrip = finishedMono - startedMono
        if (!Number.isSafeInteger(serverTime) || !Number.isFinite(roundTrip) || roundTrip < 0 || roundTrip >= 22000 || serverTime < review.requestStartedAt) throw new ArcPreviewError('timing')
        // The full measured RTT is an upper bound on time since the server stamped its response.
        // Subtract it from remaining validity rather than adding any clock-skew tolerance to TTL.
        const upper = serverTime + Math.ceil(roundTrip)
        if (!Number.isSafeInteger(upper)) throw new ArcPreviewError('timing')
        try { validateArcReview(review, getContext(), upper) } catch (cause) {
          const code = cause instanceof Error ? cause.message : ''
          throw new ArcPreviewError(code === 'quote_expired' || code === 'deadline' ? 'expired' : code === 'wallet_context_changed' ? 'context' : 'policy')
        }
        receivedMono = finishedMono; receivedWall = clock.wallNow(); serverUpperAtReceipt = upper
        current = structuredClone(review)
        return structuredClone(review)
      } catch (cause) {
        if (timedOut) throw new ArcPreviewError('timeout')
        if (version !== generation) throw new ArcPreviewError('cancelled')
        if (cause instanceof ArcPreviewError) throw cause
        throw new ArcPreviewError('response')
      } finally { clearTimeout(timer); pendingWallets.delete(owner) }
    },
  }
}
