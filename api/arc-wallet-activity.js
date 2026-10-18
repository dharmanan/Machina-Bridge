const BLOCKSCOUT_API_URL = 'https://api.blockscout.com/5042/api/v2'
const MAX_LIMIT = 30
const MAX_UPSTREAM_ROWS = 100
const MAX_PAGE_ROWS = 50
const MAX_PAGES = 2
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024
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
  if (typeof value === 'string') {
    if (/^\d{1,13}$/.test(value)) return value
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/.test(value)) return null
    const milliseconds = Date.parse(value)
    return Number.isFinite(milliseconds) && milliseconds >= 0 && new Date(milliseconds).toISOString().slice(0, 19) === value.slice(0, 19)
      ? String(Math.floor(milliseconds / 1000)) : null
  }
  return Number.isSafeInteger(value) && value >= 0 ? String(value) : null
}

function normalizeConfirmations(value) {
  if (typeof value === 'string') return /^\d{1,16}$/.test(value) && Number.isSafeInteger(Number(value)) ? value : null
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

function addressOf(value) {
  return safeString(value?.hash, ADDRESS_PATTERN)
}

function rawAmount(value) {
  if (typeof value === 'number' && (!Number.isSafeInteger(value) || value < 0)) return null
  return /^(?:0|[1-9]\d{0,77})$/.test(String(value ?? '')) ? String(value) : null
}

function normalizeTransaction(row) {
  const hash = safeString(row?.hash, HASH_PATTERN)
  if (!hash) return null
  const from = addressOf(row?.from)
  const to = row?.to === null ? null : addressOf(row?.to)
  const value = rawAmount(row?.value)
  if (!from || (row?.to !== null && !to) || value === null) return null
  const fullInput = typeof row?.raw_input === 'string' ? row.raw_input : null
  if (fullInput !== null && (!/^0x[\da-f]*$/i.test(fullInput) || fullInput.length % 2 !== 0)) return null
  const selector = fullInput && /^0x[\da-f]{8}/i.test(fullInput) ? fullInput.slice(0, 10) : fullInput === '0x' ? '0x' : 'unknown'
  const mined = normalizeConfirmations(row?.block_number) !== null && normalizeTimestamp(row?.timestamp) !== null
  const failed = row?.status === 'error'
  const succeeded = row?.status === 'ok' && mined

  return {
    hash,
    timeStamp: normalizeTimestamp(row?.timestamp),
    from,
    to,
    value,
    input: selector,
    approval: fullInput ? normalizeApproval(fullInput) : null,
    isError: failed ? '1' : succeeded ? '0' : '',
    receiptStatus: failed ? '0' : succeeded ? '1' : '',
  }
}

function normalizeTokenTransfer(row) {
  const hash = safeString(row?.transaction_hash, HASH_PATTERN)
  const contractAddress = safeString(row?.token?.address_hash, ADDRESS_PATTERN)
  const from = addressOf(row?.from)
  const to = addressOf(row?.to)
  const value = rawAmount(row?.total?.value)
  const decimals = parseTokenDecimals(row?.token?.decimals)
  const totalDecimals = row?.total?.decimals == null ? decimals : parseTokenDecimals(row.total.decimals)
  const symbol = typeof row?.token?.symbol === 'string' ? row.token.symbol.trim().slice(0, 16) : ''

  if (
    row?.token?.type !== 'ERC-20' || !hash || !contractAddress || contractAddress.toLowerCase() === ARC_NATIVE_SENTINEL
    || !from || !to || !value || decimals === null
    || totalDecimals !== decimals || !symbol || !/^[\w.$-]+$/.test(symbol)
  ) return null

  return {
    hash,
    contractAddress,
    from,
    to,
    value,
    timeStamp: normalizeTimestamp(row?.timestamp),
    confirmations: normalizeConfirmations(row?.confirmations),
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

function pagination(params) {
  if (!params || typeof params !== 'object' || Array.isArray(params) || Object.keys(params).length > 12) throw new Error('upstream')
  const query = new URLSearchParams()
  for (const key of Object.keys(params).sort()) {
    const value = params[key]
    if (value === null) continue
    const numeric = ['block_number', 'index', 'log_index', 'items_count', 'batch_log_index', 'batch_index'].includes(key)
    const hash = ['hash', 'batch_block_hash', 'batch_transaction_hash'].includes(key)
    const decimal = ['value', 'fee'].includes(key)
    const timestamp = key === 'inserted_at'
    const valid = numeric ? normalizeConfirmations(value) !== null
      : hash ? Boolean(safeString(value, HASH_PATTERN))
        : decimal ? (typeof value === 'string' && /^\d{1,78}(?:\.\d{1,36})?$/.test(value))
          || (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0)
          : timestamp && typeof value === 'string' && value.includes('T') && normalizeTimestamp(value) !== null
    if (!valid) throw new Error('upstream')
    query.set(key, String(value))
  }
  if (!query.size) throw new Error('upstream')
  return query.toString()
}

async function readPage(response, signal) {
  if (!response.ok || Number(response.headers.get('content-length')) > MAX_RESPONSE_BYTES || !response.body) throw new Error('upstream')
  const reader = response.body.getReader()
  const cancel = () => { void reader.cancel().catch(() => {}) }
  signal.addEventListener('abort', cancel, { once: true })
  try {
    const chunks = []
    let bytes = 0
    while (true) {
      signal.throwIfAborted()
      const { done, value } = await reader.read()
      signal.throwIfAborted()
      if (done) break
      bytes += value.byteLength
      if (bytes > MAX_RESPONSE_BYTES) throw new Error('upstream')
      chunks.push(value)
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } finally {
    signal.removeEventListener('abort', cancel)
    await reader.cancel().catch(() => {})
  }
}

async function fetchPages(kind, address, apiKey, signal) {
  const rows = [], seen = new Set([''])
  let cursor = '', truncatedHash = null
  for (let page = 0; page < MAX_PAGES; page += 1) {
    signal.throwIfAborted()
    const url = new URL(`${BLOCKSCOUT_API_URL}/addresses/${address}/${kind}`)
    url.search = cursor
    const response = await fetch(url, { method: 'GET', redirect: 'error',
      headers: { accept: 'application/json', Authorization: `Bearer ${apiKey}` }, signal })
    const payload = await readPage(response, signal)
    if (!Array.isArray(payload?.items) || payload.items.length > MAX_PAGE_ROWS) throw new Error('upstream')
    rows.push(...payload.items)
    if (payload.next_page_params === null) break
    cursor = pagination(payload.next_page_params)
    if (seen.has(cursor)) throw new Error('upstream')
    seen.add(cursor)
    if (!payload.items.length) throw new Error('upstream')
    if (rows.length >= MAX_UPSTREAM_ROWS || page === MAX_PAGES - 1) {
      // Do not aggregate a transaction's transfer group cut by the bounded page window.
      truncatedHash = kind === 'token-transfers' ? rows.map(row => safeString(row?.transaction_hash, HASH_PATTERN))
        .findLast(Boolean)?.toLowerCase() ?? null : null
      break
    }
  }
  return { rows, truncatedHash }
}

function selectActivity(transactionPages, transferPages, address, limit) {
  const wallet = address.toLowerCase(), transactions = new Map(), transfers = new Map(), incomplete = new Set()
  const related = row => row.from?.toLowerCase() === wallet || row.to?.toLowerCase() === wallet
  for (const raw of transactionPages.rows) {
    const row = normalizeTransaction(raw)
    if (!row) {
      const hash = safeString(raw?.hash, HASH_PATTERN)?.toLowerCase()
      if (hash) incomplete.add(hash)
      continue
    }
    if (!related(row)) continue
    const hash = row.hash.toLowerCase()
    if (transactions.has(hash) && JSON.stringify(transactions.get(hash)) !== JSON.stringify(row)) throw new Error('upstream')
    transactions.set(hash, row)
  }
  if (transferPages.truncatedHash) incomplete.add(transferPages.truncatedHash)
  for (const raw of transferPages.rows) {
    const hash = safeString(raw?.transaction_hash, HASH_PATTERN)?.toLowerCase()
    if (raw?.token?.type !== 'ERC-20') {
      if (!['ERC-721', 'ERC-1155'].includes(raw?.token?.type) && hash) incomplete.add(hash)
      continue
    }
    const row = normalizeTokenTransfer(raw), index = normalizeConfirmations(raw.log_index)
    if (!row || index === null) { if (hash) incomplete.add(hash); continue }
    if (!related(row)) continue
    const key = `${hash}:${Number(index)}`
    if (transfers.has(key) && JSON.stringify(transfers.get(key)) !== JSON.stringify(row)) throw new Error('upstream')
    transfers.set(key, row)
  }
  const validTransfers = [...transfers.values()].filter(row => !incomplete.has(row.hash.toLowerCase()))
  const times = new Map()
  for (const row of [...transactions.values(), ...validTransfers]) {
    const hash = row.hash.toLowerCase(), time = Number(row.timeStamp ?? 0)
    times.set(hash, Math.max(times.get(hash) ?? 0, time))
  }
  const selected = new Set([...times].sort((a, b) => b[1] - a[1]).slice(0, limit).map(([hash]) => hash))
  return { transactions: [...transactions.values()].filter(row => selected.has(row.hash.toLowerCase())),
    tokenTransfers: validTransfers.filter(row => selected.has(row.hash.toLowerCase())), limit }
}

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET')
    return send(res, 405, { error: 'Method not allowed' })
  }

  const address = typeof req.query?.address === 'string' ? req.query.address : ''
  if (!ADDRESS_PATTERN.test(address)) return send(res, 400, { error: 'Invalid address' })

  const requestedLimit = Number(req.query?.limit ?? 25)
  const limit = Number.isInteger(requestedLimit)
    ? Math.min(Math.max(requestedLimit, 1), MAX_LIMIT)
    : 25

  const apiKey = process.env.BLOCKSCOUT_PRO_API_KEY
  if (!apiKey) return send(res, 503, { error: 'Wallet activity is temporarily unavailable' })
  if (isRateLimited(req)) return send(res, 429, { error: 'Please wait before refreshing wallet activity' })

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
  try {
    const [transactions, tokenTransfers] = await Promise.all([
      fetchPages('transactions', address, apiKey, controller.signal),
      fetchPages('token-transfers', address, apiKey, controller.signal),
    ])
    return send(res, 200, selectActivity(transactions, tokenTransfers, address, limit))
  } catch {
    controller.abort()
    return send(res, 502, { error: 'Wallet activity could not be loaded right now' })
  } finally {
    clearTimeout(timer)
  }
}
