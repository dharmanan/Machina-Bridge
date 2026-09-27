const RPCS = [
  'https://api.mainnet.solana.com',
  'https://api.mainnet-beta.solana.com',
  'https://solana-rpc.publicnode.com',
  'https://solana.drpc.org',
]

const ALLOWED_METHODS = new Set([
  'getAccountInfo',
  'getSignatureStatuses',
])

function send(res, status, body) {
  res.status(status).setHeader('Content-Type', 'application/json; charset=utf-8').send(JSON.stringify(body))
}

async function callRpc(url, method, params) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 8000)

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method,
        params,
      }),
      signal: controller.signal,
    })

    const text = await response.text()
    let payload = null
    try {
      payload = text ? JSON.parse(text) : null
    } catch {
      payload = null
    }

    if (!response.ok || payload?.error) {
      const message =
        payload?.error?.message
        || `Solana RPC HTTP ${response.status}`
      throw new Error(message)
    }

    return payload?.result
  } finally {
    clearTimeout(timeout)
  }
}

function parseBody(req) {
  if (!req.body) return {}

  if (typeof req.body === 'string') {
    try {
      return JSON.parse(req.body)
    } catch {
      return {}
    }
  }

  return req.body
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST')
    return send(res, 405, { error: 'Method not allowed' })
  }

  const body = parseBody(req)
  const method = typeof body?.method === 'string' ? body.method : ''
  const params = Array.isArray(body?.params) ? body.params : []

  if (!ALLOWED_METHODS.has(method)) {
    return send(res, 400, { error: 'Unsupported Solana RPC method' })
  }

  let lastError = null
  for (const rpc of RPCS) {
    try {
      const result = await callRpc(rpc, method, params)
      return send(res, 200, { result })
    } catch (error) {
      lastError = error
    }
  }

  return send(res, 502, {
    error: lastError instanceof Error
      ? lastError.message
      : 'Solana RPC request failed',
  })
}
