// Vercel /api/intelligence: a strict read-only proxy to the compact Machina Intelligence API on Railway. Twelve exact
// requests map to twelve fixed upstream URLs from a table; no user input is ever concatenated into a path or origin. The
// upstream body is forwarded byte for byte only after it parses as a JSON object of the expected schema, so a domain-level
// `unavailable` (for example insufficient_coverage) stays an HTTP 200, while a failure of the upstream itself becomes a
// fixed, sanitized error. Data routes are CDN-cacheable (completed-hour data; freshness is inside the payload); health and
// every error are no-store. Only Content-Type, Cache-Control, ETag and Allow are ever set.
const DEFAULT_INTELLIGENCE_ORIGIN = 'https://machina-intelligence-production.up.railway.app'
const REQUEST_TIMEOUT_MS = 8_000
const MAX_UPSTREAM_BYTES = 512 * 1024
const UNAVAILABLE = 'Arc Intelligence is temporarily unavailable'

export const SUMMARY_SCHEMA = 'machina.intelligence.summary.v1'
export const TIMESERIES_SCHEMA = 'machina.intelligence.timeseries.v1'
export const POOLS_SCHEMA = 'machina.intelligence.pools.v1'
export const ACTIVITY_SCHEMA = 'machina.intelligence.activity.v1'
export const DATA_CACHE_CONTROL = 'public, s-maxage=300, stale-while-revalidate=3300, stale-if-error=86400'
export const NO_STORE = 'no-store'
const JSON_TYPE = 'application/json; charset=utf-8'

// The only upstream requests that exist. view=health takes no window; summary and timeseries take exactly one window;
// pools takes exactly a protocol and a window; activity takes exactly a type.
const HEALTH_ROUTE = Object.freeze({ path: '/health', check: (body) => body.status === 'ok', cacheable: false })
const WINDOWED_ROUTES = Object.freeze({
  summary: Object.freeze({
    '1h': Object.freeze({ path: '/v1/intelligence/summary?window=1h', check: (body) => body.schema === SUMMARY_SCHEMA, cacheable: true }),
    '6h': Object.freeze({ path: '/v1/intelligence/summary?window=6h', check: (body) => body.schema === SUMMARY_SCHEMA, cacheable: true }),
    '24h': Object.freeze({ path: '/v1/intelligence/summary?window=24h', check: (body) => body.schema === SUMMARY_SCHEMA, cacheable: true }),
  }),
  timeseries: Object.freeze({
    '6h': Object.freeze({ path: '/v1/intelligence/timeseries?window=6h', check: (body) => body.schema === TIMESERIES_SCHEMA, cacheable: true }),
    '24h': Object.freeze({ path: '/v1/intelligence/timeseries?window=24h', check: (body) => body.schema === TIMESERIES_SCHEMA, cacheable: true }),
  }),
})
const isPools = (body, protocol) => body.schema === POOLS_SCHEMA && body.protocol === protocol && body.window?.key === '24h'
const isActivity = (body, type) => body.schema === ACTIVITY_SCHEMA && body.type === type
const POOLS_ROUTES = Object.freeze({
  v3: Object.freeze({ '24h': Object.freeze({ path: '/v1/intelligence/pools?protocol=v3&window=24h', check: (body) => isPools(body, 'v3'), cacheable: true }) }),
  v4: Object.freeze({ '24h': Object.freeze({ path: '/v1/intelligence/pools?protocol=v4&window=24h', check: (body) => isPools(body, 'v4'), cacheable: true }) }),
})
const ACTIVITY_ROUTES = Object.freeze({
  all: Object.freeze({ path: '/v1/intelligence/activity?type=all', check: (body) => isActivity(body, 'all'), cacheable: true }),
  swaps: Object.freeze({ path: '/v1/intelligence/activity?type=swaps', check: (body) => isActivity(body, 'swaps'), cacheable: true }),
  adds: Object.freeze({ path: '/v1/intelligence/activity?type=adds', check: (body) => isActivity(body, 'adds'), cacheable: true }),
  removes: Object.freeze({ path: '/v1/intelligence/activity?type=removes', check: (body) => isActivity(body, 'removes'), cacheable: true }),
})

// One quoted entity tag, or a short comma-separated list of them (If-None-Match), with nothing else around them.
const ENTITY_TAG = /^(?:W\/)?"[\x21\x23-\x7e]{1,128}"$/
const ENTITY_TAG_LIST = /^(?:W\/)?"[\x21\x23-\x7e]{1,128}"(?:\s*,\s*(?:W\/)?"[\x21\x23-\x7e]{1,128}"){0,7}$/

// Exact request matrix. Returns the fixed upstream route, or null for anything else (extra, missing, repeated keys).
export function resolveIntelligenceRoute(query) {
  if (!query || typeof query !== 'object' || Array.isArray(query)) return null
  const keys = Object.keys(query)
  const view = query.view
  if (view === 'health') return keys.length === 1 ? HEALTH_ROUTE : null
  if (view === 'pools') {
    const { protocol, window } = query
    if (keys.length !== 3 || typeof protocol !== 'string' || typeof window !== 'string' || !Object.hasOwn(POOLS_ROUTES, protocol)) return null
    return Object.hasOwn(POOLS_ROUTES[protocol], window) ? POOLS_ROUTES[protocol][window] : null
  }
  if (view === 'activity') {
    const { type } = query
    if (keys.length !== 2 || typeof type !== 'string') return null
    return Object.hasOwn(ACTIVITY_ROUTES, type) ? ACTIVITY_ROUTES[type] : null
  }
  if (typeof view !== 'string' || !Object.hasOwn(WINDOWED_ROUTES, view)) return null
  const window = query.window
  if (keys.length !== 2 || !keys.includes('window') || typeof window !== 'string') return null
  return Object.hasOwn(WINDOWED_ROUTES[view], window) ? WINDOWED_ROUTES[view][window] : null
}

function upstreamOrigin(env = process.env) {
  const url = new URL(env.INTELLIGENCE_API_URL || DEFAULT_INTELLIGENCE_ORIGIN)
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('invalid_intelligence_origin')
  }
  return url.origin
}

const errorResponse = (status, message = UNAVAILABLE, extraHeaders = {}) => ({
  status,
  headers: { 'Content-Type': JSON_TYPE, 'Cache-Control': NO_STORE, ...extraHeaders },
  body: JSON.stringify({ error: message }),
})

// send({ status, headers, body }): body is a JSON string, or null for a 304 without a body.
export async function handleIntelligenceProxy({ method, headers = {}, query = {}, send, fetchImpl = fetch, env = process.env }) {
  if (method !== 'GET') return send(errorResponse(405, 'Method not allowed', { Allow: 'GET' }))
  if (headers?.['transfer-encoding'] || (headers?.['content-length'] && headers['content-length'] !== '0')) {
    return send(errorResponse(400, 'Request body is not allowed'))
  }
  const route = resolveIntelligenceRoute(query)
  if (!route) return send(errorResponse(400, 'Unsupported intelligence request'))

  let url
  try {
    url = `${upstreamOrigin(env)}${route.path}`
  } catch {
    return send(errorResponse(503))
  }

  const ifNoneMatch = headers?.['if-none-match']
  const forwardValidator = route.cacheable && typeof ifNoneMatch === 'string' && ifNoneMatch.length <= 1024
    && ENTITY_TAG_LIST.test(ifNoneMatch.trim())
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
  let response
  let text
  try {
    response = await fetchImpl(url, {
      method: 'GET',
      headers: { accept: 'application/json', ...(forwardValidator ? { 'if-none-match': ifNoneMatch.trim() } : {}) },
      redirect: 'manual',
      signal: controller.signal,
    })
    if (response.status === 304 && forwardValidator) {
      const etag = response.headers?.get?.('etag')
      return send({ status: 304, headers: { 'Cache-Control': DATA_CACHE_CONTROL, ...(etag && ENTITY_TAG.test(etag) ? { ETag: etag } : {}) }, body: null })
    }
    if (response.status >= 500) return send(errorResponse(503))
    if (response.status !== 200) return send(errorResponse(502))
    text = await response.text()
  } catch {
    return send(errorResponse(503))
  } finally {
    clearTimeout(timer)
  }

  if (typeof text !== 'string' || text.length > MAX_UPSTREAM_BYTES) return send(errorResponse(502))
  let payload
  try {
    payload = JSON.parse(text)
  } catch {
    return send(errorResponse(502))
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload) || !route.check(payload)) return send(errorResponse(502))

  const etag = route.cacheable ? response.headers?.get?.('etag') : null
  return send({
    status: 200,
    headers: {
      'Content-Type': JSON_TYPE,
      'Cache-Control': route.cacheable ? DATA_CACHE_CONTROL : NO_STORE,
      ...(etag && ENTITY_TAG.test(etag) ? { ETag: etag } : {}),
    },
    body: text,
  })
}
