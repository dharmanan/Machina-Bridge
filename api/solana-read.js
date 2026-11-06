import {
  RpcRequestError,
  createDeadline,
  readJsonBody,
  readLimitedText,
  readRpcCall,
} from './_lib/solana-rpc-guard.js'

// Two short reads only; small body and one budget for every provider attempt together.
const MAX_BODY_BYTES = 4 * 1024
const TOTAL_DEADLINE_MS = 20_000
const ATTEMPT_TIMEOUT_MS = 8_000

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

async function callRpc(url, method, params, timeoutMs) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)

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

    const text = await readLimitedText(response)
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

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST')
    return send(res, 405, { error: 'Method not allowed' })
  }

  let call
  try {
    call = readRpcCall(readJsonBody(req, MAX_BODY_BYTES), ALLOWED_METHODS)
  } catch (error) {
    if (!(error instanceof RpcRequestError)) throw error
    return send(res, error.status, { error: error.message })
  }
  const { method, params } = call

  let lastError = null
  const deadline = createDeadline(TOTAL_DEADLINE_MS)
  for (const rpc of RPCS) {
    const timeoutMs = deadline.attemptTimeout(ATTEMPT_TIMEOUT_MS)
    if (!timeoutMs) break
    try {
      const result = await callRpc(rpc, method, params, timeoutMs)
      return send(res, 200, { result })
    } catch (error) {
      if (error instanceof RpcRequestError) return send(res, error.status, { error: error.message })
      lastError = error
    }
  }

  return send(res, 502, {
    error: lastError instanceof Error
      ? lastError.message
      : 'Solana RPC request failed',
  })
}
