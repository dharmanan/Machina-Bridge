// Vercel /api/borrow-markets: a strict, read-only, same-origin proxy for the Borrow card's market terms. It makes exactly
// one request, to one fixed keyless Circle Borrow Kit URL (the same route @circle-fin/borrow-kit exploreMarkets uses for
// Arc); no user input reaches the URL, no request header or credential is forwarded, and nothing here can sign, approve
// or write. The upstream wire format ({ data: { markets } } with { raw, decimals } amounts) is validated and mapped the
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

// send({ status, headers, body }): body is always a JSON string.
export async function handleBorrowMarketsProxy({ method, headers = {}, query = {}, send, fetchImpl = fetch }) {
  if (method !== 'GET') return send(errorResponse(405, 'Method not allowed', { Allow: 'GET' }))
  if (headers?.['transfer-encoding'] || (headers?.['content-length'] && headers['content-length'] !== '0')) {
    return send(errorResponse(400, 'Request body is not allowed'))
  }
  if (query && typeof query === 'object' && Object.keys(query).length > 0) return send(errorResponse(400, 'Unsupported borrow market request'))

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
  let response
  let text
  try {
    response = await fetchImpl(UPSTREAM_URL, {
      method: 'GET',
      headers: { accept: 'application/json' },
      redirect: 'manual',
      signal: controller.signal,
    })
    if (response.status >= 500) return send(errorResponse(503))
    if (response.status !== 200) return send(errorResponse(502))
    text = await response.text()
  } catch {
    return send(errorResponse(503))
  } finally {
    clearTimeout(timer)
  }

  if (typeof text !== 'string' || text.length > MAX_UPSTREAM_BYTES) return send(errorResponse(502))
  let markets
  try {
    markets = compatibleBorrowMarkets(normalizeBorrowMarketsPage(JSON.parse(text)))
  } catch {
    return send(errorResponse(502))
  }
  return send({
    status: 200,
    headers: { 'Content-Type': JSON_TYPE, 'Cache-Control': BORROW_CACHE_CONTROL },
    body: JSON.stringify({ schema: BORROW_MARKETS_SCHEMA, chain: 'Arc', pair: { collateral: BORROW_COLLATERAL_ASSET, loan: BORROW_LOAN_ASSET }, markets }),
  })
}
