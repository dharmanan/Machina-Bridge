// Vercel /api/borrow-markets: a strict, read-only, same-origin proxy for the Borrow card's market terms. It requests one
// fixed keyless Circle Borrow Kit URL (the same route @circle-fin/borrow-kit exploreMarkets uses for Arc). Only when Circle
// itself returns a next-page cursor does it follow it, at most MAX_PAGES pages in total within the one timeout; the cursor
// must be a short plain token and is the only addition to the URL. No user input reaches the URL, no request header or
// credential is forwarded, and nothing here can sign, approve or write. The upstream wire format ({ data: { markets } } with { raw, decimals } amounts) is validated and mapped the
// way the Borrow Kit SDK maps it (toMarketInfo), with the same rules as the guarded read boundary in
// src/lib/mainnetBorrow.ts: anything malformed fails the whole answer instead of being guessed, and a missing value
// stays null, never zero. Failures become fixed, sanitized errors; success is briefly CDN-cacheable.
//
// The answer is every validated Arc cirBTC/USDC Morpho market, never one picked market. Token identity comes from the
// verified Arc asset registry (address, symbol and decimals), never from a symbol: a market whose token only claims the
// symbol is not this pair, and a canonical address reported with another symbol or decimals fails the whole answer.
// Markets are ordered by market ID so the list is stable; that order is for display only and is not a ranking.
import { ARC_VERIFIED_ASSETS } from './arc-intelligence/assets.js'

const UPSTREAM_URL = 'https://api.circle.com/v1/borrowKit/markets?chain=ARC&pageSize=20'
const UPSTREAM_CHAIN = 'ARC'
const REQUEST_TIMEOUT_MS = 8_000
const MAX_UPSTREAM_BYTES = 256 * 1024
// Circle serves markets in pages of 20 with an opaque cursor; 14 markets fit one page today. The cap keeps the work and the
// memory bounded, and a list that does not finish inside it is reported as incomplete, never as complete.
const MAX_PAGES = 5
const CURSOR = /^[A-Za-z0-9_\-+=.:~/]{1,512}$/
const UNAVAILABLE = 'Borrow market data is temporarily unavailable'

export const BORROW_MARKETS_SCHEMA = 'machina.borrow.markets.v2'
export const BORROW_MARKETS_UPSTREAM_URL = UPSTREAM_URL
export const BORROW_CACHE_CONTROL = 'public, s-maxage=300, stale-while-revalidate=300'
export const NO_STORE = 'no-store'
const JSON_TYPE = 'application/json; charset=utf-8'

const registryAsset = (symbol) => {
  const asset = ARC_VERIFIED_ASSETS.find((entry) => entry.symbol === symbol)
  if (!asset) throw new Error(`verified Arc asset missing: ${symbol}`)
  return Object.freeze({ symbol: asset.symbol, address: asset.address.toLowerCase(), decimals: asset.decimals })
}
export const BORROW_COLLATERAL_ASSET = registryAsset('cirBTC')
export const BORROW_LOAN_ASSET = registryAsset('USDC')
const CANONICAL = new Map([BORROW_COLLATERAL_ASSET, BORROW_LOAN_ASSET].map((asset) => [asset.address, asset]))

const ADDRESS = /^0x[0-9a-fA-F]{40}$/
const BYTES32 = /^0x[0-9a-fA-F]{64}$/
const DIGITS = /^\d+$/

class MalformedMarket extends Error {}
const malformed = () => {
  throw new MalformedMarket('malformed_market')
}
const record = (value) => (value && typeof value === 'object' && !Array.isArray(value) ? value : malformed())
const decimals = (value) => (Number.isInteger(value) && value >= 0 && value <= 36 ? value : malformed())
const ratioOrNull = (value) => {
  if (value === null || value === undefined) return null
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : malformed()
}

function asset(value) {
  const fields = record(value)
  if (typeof fields.symbol !== 'string' || !fields.symbol || fields.symbol.length > 32) malformed()
  if (typeof fields.address !== 'string' || !ADDRESS.test(fields.address)) malformed()
  return { symbol: fields.symbol, address: fields.address, decimals: decimals(fields.decimals) }
}

// { raw, decimals } atoms to an exact decimal string (BigInt), labelled with the loan asset like the SDK does.
function amountOrNull(value, loanAsset) {
  if (value === null || value === undefined) return null
  const fields = record(value)
  if (typeof fields.raw !== 'string' || !DIGITS.test(fields.raw) || fields.raw.length > 78) malformed()
  const places = decimals(fields.decimals)
  const atoms = BigInt(fields.raw)
  const base = 10n ** BigInt(places)
  const fraction = places ? (atoms % base).toString().padStart(places, '0').replace(/0+$/, '') : ''
  return { token: loanAsset.symbol, tokenAddress: loanAsset.address, amount: `${atoms / base}${fraction ? `.${fraction}` : ''}`, decimals: places }
}

function market(value) {
  const fields = record(value)
  if (fields.chain !== UPSTREAM_CHAIN) malformed()
  if (fields.protocol !== 'morpho') malformed()
  if (typeof fields.marketId !== 'string' || !BYTES32.test(fields.marketId)) malformed()
  const refreshedAt = fields.refreshedAt
  if (refreshedAt !== null && refreshedAt !== undefined && (typeof refreshedAt !== 'string' || Number.isNaN(Date.parse(refreshedAt)))) malformed()
  const loanAsset = asset(fields.loanAsset)
  return {
    marketId: fields.marketId,
    protocol: 'morpho',
    loanAsset,
    collateralAsset: asset(fields.collateralAsset),
    lltv: ratioOrNull(fields.lltv),
    borrowApy: ratioOrNull(fields.borrowApy),
    utilization: ratioOrNull(fields.utilization),
    borrowAssets: amountOrNull(fields.borrowAssets, loanAsset),
    liquidity: amountOrNull(fields.liquidity, loanAsset),
    refreshedAt: refreshedAt ?? null,
  }
}

// Throws MalformedMarket unless the whole page is well formed.
export function normalizeBorrowMarketsPage(payload) {
  const data = record(record(payload).data)
  if (!Array.isArray(data.markets) || data.markets.length > 100) malformed()
  return data.markets.map(market)
}

// Circle's next-page cursor: absent on the last page. A cursor that is not a short plain token is not followed.
export function nextPage(payload) {
  const pagination = record(record(payload).data).pagination
  const after = pagination && typeof pagination === 'object' ? pagination.pageAfter : undefined
  if (after === undefined || after === null) return { more: false, cursor: null }
  return { more: true, cursor: typeof after === 'string' && CURSOR.test(after) ? after : null }
}

// Every validated cirBTC/USDC market of the page, by verified token identity, ordered by market ID (display only).
// Throws MalformedMarket when a canonical token address carries another identity or a market ID repeats.
export function compatibleBorrowMarkets(markets) {
  for (const entry of markets) {
    for (const side of [entry.collateralAsset, entry.loanAsset]) {
      const canonical = CANONICAL.get(side.address.toLowerCase())
      if (canonical && (side.symbol !== canonical.symbol || side.decimals !== canonical.decimals)) malformed()
    }
  }
  const compatible = markets.filter((entry) => entry.collateralAsset.address.toLowerCase() === BORROW_COLLATERAL_ASSET.address
    && entry.loanAsset.address.toLowerCase() === BORROW_LOAN_ASSET.address)
  const ids = compatible.map((entry) => entry.marketId.toLowerCase())
  if (new Set(ids).size !== ids.length) malformed()
  return [...compatible].sort((a, b) => (a.marketId.toLowerCase() < b.marketId.toLowerCase() ? -1 : 1))
}

const errorResponse = (status, message = UNAVAILABLE, extraHeaders = {}) => ({
  status,
  headers: { 'Content-Type': JSON_TYPE, 'Cache-Control': NO_STORE, ...extraHeaders },
  body: JSON.stringify({ error: message }),
})

// One upstream page: { markets, next } or { failure: 503 | 502 }. Never throws and never exposes upstream text.
async function fetchPage(fetchImpl, pageUrl, signal) {
  let text
  try {
    const response = await fetchImpl(pageUrl, {
      method: 'GET',
      headers: { accept: 'application/json' },
      redirect: 'manual',
      signal,
    })
    if (response.status >= 500) return { failure: 503 }
    if (response.status !== 200) return { failure: 502 }
    text = await response.text()
  } catch {
    return { failure: 503 }
  }
  if (typeof text !== 'string' || text.length > MAX_UPSTREAM_BYTES) return { failure: 502 }
  try {
    const payload = JSON.parse(text)
    return { markets: normalizeBorrowMarketsPage(payload), next: nextPage(payload) }
  } catch {
    return { failure: 502 }
  }
}

// send({ status, headers, body }): body is always a JSON string.
export async function handleBorrowMarketsProxy({ method, headers = {}, query = {}, send, fetchImpl = fetch }) {
  if (method !== 'GET') return send(errorResponse(405, 'Method not allowed', { Allow: 'GET' }))
  if (headers?.['transfer-encoding'] || (headers?.['content-length'] && headers['content-length'] !== '0')) {
    return send(errorResponse(400, 'Request body is not allowed'))
  }
  if (query && typeof query === 'object' && Object.keys(query).length > 0) return send(errorResponse(400, 'Unsupported borrow market request'))

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
  const found = []
  const followed = new Set()
  let complete = true
  try {
    let pageUrl = UPSTREAM_URL
    for (let pages = 1; ; pages += 1) {
      const page = await fetchPage(fetchImpl, pageUrl, controller.signal)
      if (page.failure) {
        // The first page decides the answer; a later page that cannot be read only leaves the list incomplete.
        if (pages === 1) return send(errorResponse(page.failure))
        complete = false
        break
      }
      found.push(...page.markets)
      if (!page.next.more) break
      if (page.next.cursor === null || followed.has(page.next.cursor) || pages >= MAX_PAGES) {
        complete = false
        break
      }
      followed.add(page.next.cursor)
      pageUrl = `${UPSTREAM_URL}&pageAfter=${encodeURIComponent(page.next.cursor)}`
    }
  } finally {
    clearTimeout(timer)
  }

  let markets
  try {
    markets = compatibleBorrowMarkets(found)
  } catch {
    return send(errorResponse(502))
  }
  return send({
    status: 200,
    // An incomplete list is not cached, so the next request tries the remaining pages again.
    headers: { 'Content-Type': JSON_TYPE, 'Cache-Control': complete ? BORROW_CACHE_CONTROL : NO_STORE },
    body: JSON.stringify({
      schema: BORROW_MARKETS_SCHEMA,
      chain: 'Arc',
      pair: { collateral: BORROW_COLLATERAL_ASSET, loan: BORROW_LOAN_ASSET },
      markets,
      ...(complete ? {} : { complete: false }),
    }),
  })
}
