import {
  RpcRequestError,
  createClientRateLimiter,
  createDeadline,
  readJsonBody,
  readLimitedText,
  readRequestId,
  readRpcCall,
} from './_lib/solana-rpc-guard.js'

// One budget for every provider attempt together, kept below common serverless limits.
const TOTAL_DEADLINE_MS = 25_000
const ATTEMPT_TIMEOUT_MS = 12_000

const DEFAULT_RPCS = [
  'https://solana-rpc.publicnode.com',
  'https://solana.drpc.org',
  'https://api.mainnet-beta.solana.com',
  'https://api.mainnet.solana.com',
  'https://rpc.ankr.com/solana',
]

const ALLOWED_METHODS = new Set([
  'getAccountInfo',
  'getBalance',
  'getBlockHeight',
  'getEpochInfo',
  'getFeeForMessage',
  'getGenesisHash',
  'getLatestBlockhash',
  'getMinimumBalanceForRentExemption',
  'getMultipleAccounts',
  'getProgramAccounts',
  'getSignaturesForAddress',
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

const rateLimiter = createClientRateLimiter()

function send(res, status, body) {
  res
    .status(status)
    .setHeader('Content-Type', 'application/json; charset=utf-8')
    .send(JSON.stringify(body))
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
    || message.includes('free plan')
    || message.includes('chain is not available')
    || message.includes('rate limit')
    || message.includes('too many requests')
    || message.includes('node is unhealthy')
    || message.includes('service unavailable')
    || message.includes('temporarily unavailable')
  )
}

async function callRpc(url, body, timeoutMs) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)

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

    const text = await readLimitedText(response)
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

  const wait = rateLimiter.retryAfter(req)
  if (wait) {
    res.setHeader('Retry-After', String(wait))
    return send(res, 429, {
      jsonrpc: '2.0',
      id: null,
      error: { code: -32005, message: 'Too many Solana RPC requests. Try again shortly.' },
    })
  }

  let id = null
  let call
  try {
    const body = readJsonBody(req)
    id = readRequestId(body)
    if (id === undefined || body.jsonrpc !== '2.0') {
      id = null
      throw new RpcRequestError(400, -32600, 'Invalid request')
    }
    call = readRpcCall(body, ALLOWED_METHODS)
  } catch (error) {
    if (!(error instanceof RpcRequestError)) throw error
    return send(res, error.status, {
      jsonrpc: '2.0',
      id,
      error: { code: error.code, message: error.message },
    })
  }
  const { method, params } = call

  const requestBody = {
    jsonrpc: '2.0',
    id,
    method,
    params,
  }

  let lastTransportError = null
  // History reads: a provider without this history (pruned ledger) answers getTransaction with
  // result:null and getSignaturesForAddress with []. That is "not on this provider", not proof that
  // nothing exists, so the next provider is asked. The empty answer is returned only when no provider
  // has the history.
  let notFoundPayload = null
  const deadline = createDeadline(TOTAL_DEADLINE_MS)

  for (const rpc of getRpcCandidates()) {
    const timeoutMs = deadline.attemptTimeout(ATTEMPT_TIMEOUT_MS)
    if (!timeoutMs) {
      lastTransportError = lastTransportError || 'Solana RPC time budget exhausted'
      break
    }
    try {
      const { response, payload } = await callRpc(rpc, requestBody, timeoutMs)

      if (response.ok && payload && !payload.error) {
        const noHistory = (method === 'getTransaction' && payload.result === null)
          || (method === 'getSignaturesForAddress' && Array.isArray(payload.result) && payload.result.length === 0)
        if (noHistory) {
          notFoundPayload = payload
          continue
        }
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
      // An oversized answer would be just as large from the next provider: stop here.
      if (error instanceof RpcRequestError) {
        return send(res, error.status, {
          jsonrpc: '2.0',
          id,
          error: { code: error.code, message: error.message },
        })
      }
      lastTransportError = error instanceof Error ? error.message : String(error)
    }
  }

  if (notFoundPayload) return send(res, 200, notFoundPayload)

  return send(res, 502, {
    jsonrpc: '2.0',
    id,
    error: {
      code: -32000,
      message: lastTransportError || 'All Solana RPC providers failed',
    },
  })
}
