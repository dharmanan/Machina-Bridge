const ETHERSCAN_API_URL = 'https://api.etherscan.io/v2/api'
const ARC_CHAIN_ID = '5042'
const MAX_LIMIT = 30
const MAX_UPSTREAM_ROWS = 100
const REQUEST_TIMEOUT_MS = 10_000
const RATE_WINDOW_MS = 60_000
const RATE_LIMIT = 30
const rateBuckets = new Map()

const ADDRESS_PATTERN = /^0x[a-fA-F0-9]{40}$/
const HASH_PATTERN = /^0x[a-fA-F0-9]{64}$/
const ARC_NATIVE_SENTINEL = '0xfffffffffffffffffffffffffffffffffffffffe'

function send(res, status, body) {
  res.setHeader('Cache-Control', 'no-store')
  res.status(status).setHeader('Content-Type', 'application/json; charset=utf-8')
    .send(JSON.stringify(body))
}

function safeString(value, pattern) {
  if (typeof value !== 'string' || !pattern.test(value)) return null
  return value
}

function parseTokenDecimals(value) {
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) && value >= 0 && value <= 36 ? value : null
  }
  if (typeof value !== 'string' || !/^\d+$/.test(value)) return null

  const decimals = Number(value)
  return Number.isSafeInteger(decimals) && decimals <= 36 ? decimals : null
}

function normalizeTimestamp(value) {
  if (typeof value === 'string') return /^\d+$/.test(value) ? value : null
  return Number.isSafeInteger(value) && value >= 0 ? String(value) : null
}

function normalizeApproval(input) {
  if (typeof input !== 'string' || input.length !== 138 || !/^0x[\da-f]{136}$/i.test(input)) return null
  if (input.slice(0, 10).toLowerCase() !== '0x095ea7b3') return null

  const spenderWord = input.slice(10, 74)
  const amountWord = input.slice(74, 138)
  if (!/^0{24}[\da-f]{40}$/i.test(spenderWord) || !/^[\da-f]{64}$/i.test(amountWord)) return null

  return {
    spender: `0x${spenderWord.slice(24)}`,
    amount: BigInt(`0x${amountWord}`).toString(),
  }
}

function normalizeTransaction(row) {
  const hash = safeString(row?.hash, HASH_PATTERN)
  if (!hash) return null
  const fullInput = typeof row?.input === 'string' ? row.input : null
  const selector = fullInput && /^0x[\da-f]{8}/i.test(fullInput) ? fullInput.slice(0, 10) : '0x'

  return {
    hash,
    timeStamp: normalizeTimestamp(row?.timeStamp),
    from: safeString(row?.from, ADDRESS_PATTERN),
    to: safeString(row?.to, ADDRESS_PATTERN),
    value: /^\d+$/.test(String(row?.value ?? '')) ? String(row.value) : '0',
    input: selector,
    approval: fullInput ? normalizeApproval(fullInput) : null,
    isError: String(row?.isError ?? ''),
    receiptStatus: String(row?.txreceipt_status ?? ''),
  }
}

function normalizeTokenTransfer(row) {
  const hash = safeString(row?.hash, HASH_PATTERN)
  const contractAddress = safeString(row?.contractAddress, ADDRESS_PATTERN)
  const from = safeString(row?.from, ADDRESS_PATTERN)
  const to = safeString(row?.to, ADDRESS_PATTERN)
  const value = /^\d+$/.test(String(row?.value ?? '')) ? String(row.value) : null
  const decimals = parseTokenDecimals(row?.tokenDecimal)
  const symbol = typeof row?.tokenSymbol === 'string' ? row.tokenSymbol.trim().slice(0, 16) : ''

  if (
    !hash || !contractAddress || contractAddress.toLowerCase() === ARC_NATIVE_SENTINEL
    || !from || !to || !value || decimals === null
    || !symbol || !/^[\w.$-]+$/.test(symbol)
  ) return null

  return {
    hash,
    contractAddress,
    from,
    to,
    value,
    timeStamp: normalizeTimestamp(row?.timeStamp),
    symbol,
    decimals,
  }
}

function getClientKey(req) {
  const forwarded = req.headers?.['x-vercel-forwarded-for'] || req.headers?.['x-forwarded-for']
  const value = typeof forwarded === 'string' ? forwarded.split(',')[0].trim() : ''
  return value.slice(0, 80) || 'unknown'
}

function isRateLimited(req) {
  const now = Date.now()
  const key = getClientKey(req)
  const current = rateBuckets.get(key)
  if (!current || current.expiresAt <= now) {
    if (rateBuckets.size >= 1000) {
      const firstKey = rateBuckets.keys().next().value
      if (firstKey) rateBuckets.delete(firstKey)
    }
    rateBuckets.set(key, { count: 1, expiresAt: now + RATE_WINDOW_MS })
    return false
  }

  current.count += 1
  return current.count > RATE_LIMIT
}

async function fetchAction(action, address, offset, apiKey) {
  const url = new URL(ETHERSCAN_API_URL)
  url.search = new URLSearchParams({
    chainid: ARC_CHAIN_ID,
    module: 'account',
    action,
    address,
    sort: 'desc',
    page: '1',
    offset: String(offset),
    apikey: apiKey,
  }).toString()

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
  try {
    const response = await fetch(url, {
      headers: { accept: 'application/json' },
      signal: controller.signal,
    })
    const payload = await response.json().catch(() => null)
    if (!response.ok) throw new Error('upstream')

    if (payload?.status === '1' && Array.isArray(payload.result)) return payload.result
    if (/no transactions found/i.test(String(payload?.result ?? payload?.message ?? ''))) return []
    throw new Error('upstream')
  } finally {
    clearTimeout(timer)
  }
}

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET')
    return send(res, 405, { error: 'Method not allowed' })
  }

  const address = String(req.query?.address ?? '')
  if (!ADDRESS_PATTERN.test(address)) return send(res, 400, { error: 'Invalid address' })

  const requestedLimit = Number(req.query?.limit ?? 25)
  const limit = Number.isInteger(requestedLimit)
    ? Math.min(Math.max(requestedLimit, 1), MAX_LIMIT)
    : 25

  const apiKey = process.env.ETHERSCAN_API_KEY
  if (!apiKey) return send(res, 503, { error: 'Wallet activity is temporarily unavailable' })
  if (isRateLimited(req)) return send(res, 429, { error: 'Please wait before refreshing wallet activity' })

  const offset = Math.min(MAX_UPSTREAM_ROWS, Math.max(50, limit * 4))
  try {
    const [transactions, tokenTransfers] = await Promise.all([
      fetchAction('txlist', address, offset, apiKey),
      fetchAction('tokentx', address, offset, apiKey),
    ])

    return send(res, 200, {
      transactions: transactions.map(normalizeTransaction).filter(Boolean),
      tokenTransfers: tokenTransfers.map(normalizeTokenTransfer).filter(Boolean),
      limit,
    })
  } catch {
    return send(res, 502, { error: 'Wallet activity could not be loaded right now' })
  }
}
