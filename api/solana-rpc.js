const DEFAULT_RPCS = [
  'https://api.mainnet.solana.com',
  'https://api.mainnet-beta.solana.com',
  'https://rpc.ankr.com/solana',
  'https://solana.drpc.org',
  'https://solana-rpc.publicnode.com',
]

const ALLOWED_METHODS = new Set([
  'getAccountInfo',
  'getBalance',
  'getBlockHeight',
  'getEpochInfo',
  'getFeeForMessage',
  'getLatestBlockhash',
  'getMinimumBalanceForRentExemption',
  'getMultipleAccounts',
  'getProgramAccounts',
  'getRecentPrioritizationFees',
  'getSignatureStatuses',
  'getSlot',
  'getTokenAccountBalance',
  'getTokenAccountsByOwner',
  'getTokenSupply',
  'getTransaction',
  'getVersion',
  'isBlockhashValid',
  'sendTransaction',
  'simulateTransaction',
])

function send(res, status, body) {
  res
    .status(status)
    .setHeader('Content-Type', 'application/json; charset=utf-8')
    .send(JSON.stringify(body))
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

function getRpcCandidates() {
  const configured = process.env.SOLANA_MAINNET_RPC?.trim()
  return configured
    ? [configured, ...DEFAULT_RPCS.filter((rpc) => rpc !== configured)]
    : DEFAULT_RPCS
}

function isRetryableRpcFailure(response, payload) {
  if (response.status === 403 || response.status === 408 || response.status === 429) {
    return true
  }

  if (response.status >= 500) {
    return true
  }

  const message = String(
    payload?.error?.message
    || payload?.error
    || '',
  ).toLowerCase()

  return (
    message.includes('access forbidden')
    || message.includes('personal token')
    || message.includes('rate limit')
    || message.includes('too many requests')
    || message.includes('node is unhealthy')
    || message.includes('service unavailable')
    || message.includes('temporarily unavailable')
  )
}

async function callRpc(url, body) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 12_000)

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    })

    const text = await response.text()
    let payload = null

    try {
      payload = text ? JSON.parse(text) : null
    } catch {
      payload = null
    }

    return { response, payload }
  } finally {
    clearTimeout(timeout)
  }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST')
    return send(res, 405, {
      jsonrpc: '2.0',
      id: null,
      error: { code: -32600, message: 'Method not allowed' },
    })
  }

  const body = parseBody(req)
  const method = typeof body?.method === 'string' ? body.method : ''
  const params = Array.isArray(body?.params) ? body.params : []
  const id = body?.id ?? null

  if (body?.jsonrpc !== '2.0' || !ALLOWED_METHODS.has(method)) {
    return send(res, 400, {
      jsonrpc: '2.0',
      id,
      error: { code: -32601, message: 'Unsupported Solana RPC method' },
    })
  }

  const requestBody = {
    jsonrpc: '2.0',
    id,
    method,
    params,
  }

  let lastTransportError = null

  for (const rpc of getRpcCandidates()) {
    try {
      const { response, payload } = await callRpc(rpc, requestBody)

      if (response.ok && payload && !payload.error) {
        return send(res, 200, payload)
      }

      if (isRetryableRpcFailure(response, payload)) {
        lastTransportError =
          payload?.error?.message
          || payload?.error
          || `Solana RPC HTTP ${response.status}`
        continue
      }

      if (payload) {
        return send(res, 200, payload)
      }

      lastTransportError = `Solana RPC HTTP ${response.status}`
    } catch (error) {
      lastTransportError = error instanceof Error ? error.message : String(error)
    }
  }

  return send(res, 502, {
    jsonrpc: '2.0',
    id,
    error: {
      code: -32000,
      message: lastTransportError || 'All Solana RPC providers failed',
    },
  })
}
