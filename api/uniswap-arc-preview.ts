import { prepareArcPreview } from './_lib/uniswap-arc-preview'
import { validateArcRequest, validateArcReview } from '../src/lib/uniswapArcPolicy'

interface Request { method?: string; headers: Record<string, string | string[] | undefined>; body?: unknown }
interface Response { setHeader(name: string, value: string): void; status(code: number): Response; json(body: unknown): void }
// Browser consistency checks, not authentication: non-browser clients can forge all these headers.
function originAllowed(h: Request['headers'], allowed: string) {
  let url: URL
  try { url = new URL(allowed) } catch { return false }
  if (url.origin !== allowed || !['http:', 'https:'].includes(url.protocol)) return false
  if (h.origin === allowed) return true
  // Only the Vite development path can reach this exception. Bind it to this Codespace.
  if (process.env.CODESPACES !== 'true') return false
  const name = process.env.CODESPACE_NAME
  const domain = process.env.GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN
  const proxyPort = typeof h.origin === 'string' ? /^https:\/\/localhost:([1-9]\d{0,4})$/.exec(h.origin)?.[1] : undefined
  if (!name || !domain || !proxyPort || Number(proxyPort) > 65535 || url.protocol !== 'https:' || url.host !== `${name}-${proxyPort}.${domain}`) return false
  const referer = typeof h.referer === 'string' ? h.referer : ''
  let refOrigin = ''
  try { refOrigin = new URL(referer).origin } catch { /* invalid */ }
  return h['x-forwarded-host'] === url.host &&
    h['sec-fetch-site'] === 'same-origin' && refOrigin === url.origin
}
// Local budget protects the paid read API within an instance, not a distributed auth system.
let windowStart = 0, count = 0
async function handle(req: Request, res: Response, viteDevelopment: boolean) {
  res.setHeader('Cache-Control', 'no-store')
  res.setHeader('X-Content-Type-Options', 'nosniff')
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return res.status(405).json({ error: 'method_not_allowed' }) }
  // No authenticated/distributed quota boundary exists yet. Public/serverless entry points
  // must stop before reading the API key or making RPC/paid API calls. No env/header unlock.
  if (!viteDevelopment || process.env.NODE_ENV !== 'development' || process.env.VERCEL !== undefined || process.env.VERCEL_ENV !== undefined) {
    res.setHeader('X-Uniswap-Preview-Status', 'public-disabled')
    return res.status(503).json({ error: 'uniswap_arc_public_preview_disabled', writesEnabled: false, executionBound: false })
  }
  const origin = process.env.UNISWAP_ARC_ALLOWED_ORIGIN
  if (!origin || !originAllowed(req.headers, origin) || req.headers['content-type'] !== 'application/json') return res.status(403).json({ error: 'preview_origin_blocked' })
  const requestId = req.headers['x-preview-request-id']
  if (requestId !== undefined && (typeof requestId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(requestId))) return res.status(400).json({ error: 'invalid_preview_request' })
  try {
    const text = typeof req.body === 'string' ? req.body : JSON.stringify(req.body)
    if (!text || Buffer.byteLength(text, 'utf8') > 8192) return res.status(413).json({ error: 'request_too_large' })
    const input = validateArcRequest(JSON.parse(text))
    // Invalid input cannot exhaust the development process's preparation budget.
    const now = Date.now()
    if (now - windowStart >= 60000) { windowStart = now; count = 0 }
    if (++count > 20) return res.status(429).json({ error: 'preview_rate_limited' })
    // Key is never accepted from the browser, logged or returned to the browser.
    const review = await prepareArcPreview(input, process.env.UNISWAP_TRADING_API_KEY ?? '')
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

// Vercel invokes only this default entry point. It is closed regardless of environment flags.
export default function handler(req: Request, res: Response) { return handle(req, res, false) }

// Called only by Vite configureServer, never selected by URL, request headers or browser input.
export function handleDevelopmentArcPreview(req: Request, res: Response) { return handle(req, res, true) }
