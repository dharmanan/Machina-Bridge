import { prepareArcPreview } from './_lib/uniswap-arc-preview'
import { validateArcReview } from '../src/lib/uniswapArcPolicy'

interface Request { method?: string; headers: Record<string, string | string[] | undefined>; body?: unknown }
interface Response { setHeader(name: string, value: string): void; status(code: number): Response; json(body: unknown): void }
// Codespaces' proxy rewrites Origin to https://localhost:<port>; accept that only when the forwarded host,
// Referer and Fetch Metadata all prove the same exact allowed origin.
function originAllowed(h: Request['headers'], allowed: string) {
  if (h.origin === allowed) return true
  let url: URL
  try { url = new URL(allowed) } catch { return false }
  const referer = typeof h.referer === 'string' ? h.referer : ''
  let refOrigin = ''
  try { refOrigin = new URL(referer).origin } catch { /* invalid */ }
  return typeof h.origin === 'string' && /^https:\/\/localhost:\d+$/.test(h.origin) && h['x-forwarded-host'] === url.host &&
    h['sec-fetch-site'] === 'same-origin' && refOrigin === url.origin
}
// Local budget protects the paid read API within an instance, not a distributed auth system.
let windowStart = 0, count = 0
export default async function handler(req: Request, res: Response) {
  res.setHeader('Cache-Control', 'no-store')
  res.setHeader('X-Content-Type-Options', 'nosniff')
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return res.status(405).json({ error: 'method_not_allowed' }) }
  const origin = process.env.UNISWAP_ARC_ALLOWED_ORIGIN
  if (!origin || !originAllowed(req.headers, origin) || req.headers['content-type'] !== 'application/json') return res.status(403).json({ error: 'preview_origin_blocked' })
  const requestId = req.headers['x-preview-request-id']
  if (requestId !== undefined && (typeof requestId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(requestId))) return res.status(400).json({ error: 'invalid_preview_request' })
  const now = Date.now()
  if (now - windowStart >= 60000) { windowStart = now; count = 0 }
  if (++count > 20) return res.status(429).json({ error: 'preview_rate_limited' })
  try {
    const text = typeof req.body === 'string' ? req.body : JSON.stringify(req.body)
    if (!text || Buffer.byteLength(text, 'utf8') > 8192) return res.status(413).json({ error: 'request_too_large' })
    // Key is never accepted from the browser, logged or returned to the browser.
    const review = await prepareArcPreview(JSON.parse(text), process.env.UNISWAP_TRADING_API_KEY ?? '')
    const serverTime = Date.now()
    validateArcReview(review, { owner: review.request.owner, chainId: 5042, connected: true }, serverTime)
    if (typeof requestId === 'string') res.setHeader('X-Preview-Request-Id', requestId)
    res.setHeader('X-Preview-Server-Time', String(serverTime))
    return res.status(200).json(review)
  } catch {
    // Neither upstream errors nor request bodies (potentially containing secrets) escape.
    return res.status(503).json({ error: 'uniswap_arc_review_blocked', writesEnabled: false })
  }
}
