const DEFAULT_INTELLIGENCE_ORIGIN = 'https://machina-intelligence-production.up.railway.app'
const REQUEST_TIMEOUT_MS = 8_000
const VIEW_PATHS = Object.freeze({
  latest: '/v1/intelligence/latest',
  coverage: '/v1/intelligence/coverage',
  runtime: '/v1/intelligence/runtime',
})
const TIMESERIES_WINDOWS = new Set(['6h', '24h'])

export function sendJson(res, status, body) {
  res.setHeader('Cache-Control', 'no-store')
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.status(status).send(JSON.stringify(body))
}

function upstreamOrigin(env = process.env) {
  const value = env.INTELLIGENCE_API_URL || DEFAULT_INTELLIGENCE_ORIGIN
  const url = new URL(value)
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('invalid_intelligence_origin')
  }
  return url.origin
}

export function intelligencePathForView(view) {
  return typeof view === 'string' && Object.hasOwn(VIEW_PATHS, view) ? VIEW_PATHS[view] : null
}

export async function handleIntelligenceProxy({ method, headers = {}, query = {}, send, fetchImpl = fetch, env = process.env }) {
  if (method !== 'GET') {
    return send(405, { error: 'Method not allowed' }, { allow: 'GET' })
  }

  if (headers?.['transfer-encoding'] || (headers?.['content-length'] && headers['content-length'] !== '0')) {
    return send(400, { error: 'Request body is not allowed' })
  }

  const queryKeys = Object.keys(query ?? {})
  const view = query.view
  let path
  if (view === 'timeseries') {
    if (queryKeys.length !== 2 || !queryKeys.includes('view') || !queryKeys.includes('window') || !TIMESERIES_WINDOWS.has(query.window)) {
      return send(400, { error: 'Unsupported intelligence view' })
    }
    path = `/v1/intelligence/timeseries?window=${query.window}`
  } else {
    if (queryKeys.length !== 1 || queryKeys[0] !== 'view') {
      return send(400, { error: 'Unsupported intelligence view' })
    }
    path = intelligencePathForView(view)
    if (!path) {
      return send(400, { error: 'Unsupported intelligence view' })
    }
  }

  let url
  try {
    url = `${upstreamOrigin(env)}${path}`
  } catch {
    return send(503, { error: 'Arc Intelligence is temporarily unavailable' })
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
  try {
    const response = await fetchImpl(url, {
      method: 'GET',
      headers: { accept: 'application/json' },
      signal: controller.signal,
    })
    const payload = await response.json().catch(() => null)
    if (!response.ok || !payload || typeof payload !== 'object' || Array.isArray(payload)) {
      return send(response.status >= 400 && response.status <= 599 ? response.status : 502, {
        error: 'Arc Intelligence is temporarily unavailable',
      })
    }
    return send(200, payload)
  } catch {
    return send(503, { error: 'Arc Intelligence is temporarily unavailable' })
  } finally {
    clearTimeout(timer)
  }
}
