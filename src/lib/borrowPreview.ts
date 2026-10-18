import type { MarketVerification, MarketVerificationReason } from './borrowMarketVerification'
import type { BorrowAmount, BorrowError, BorrowGasEstimate, BorrowHealthBand, BorrowMarket } from './mainnetBorrow'

// Pure helpers for the read-only Borrow preview (MainnetBorrow). No SDK, wallet or network access: everything here is
// string / number arithmetic on values the Borrow Service already reported or the user typed.

// What a user may type in an amount field: digits and one dot. Anything else is dropped, and the fraction is cut to the
// token's own precision (the Borrow Service rejects extra digits instead of rounding them).
export function sanitizeDecimalInput(raw: string, maxDecimals: number): string {
  const cleaned = raw.replace(/[^\d.]/g, '')
  const firstDot = cleaned.indexOf('.')
  if (firstDot === -1) return trimWhole(cleaned).slice(0, 30)
  const whole = trimWhole(cleaned.slice(0, firstDot)) || '0'
  const fraction = cleaned.slice(firstDot + 1).replace(/\./g, '').slice(0, Math.max(0, maxDecimals))
  return `${whole.slice(0, 30)}.${fraction}`
}

function trimWhole(whole: string): string {
  return whole.replace(/^0+(?=\d)/, '')
}

// A request-ready amount, or null when the text is empty, zero or not a plain decimal. "1." reads as "1".
export function parsePositiveAmount(text: string): string | null {
  const value = text.endsWith('.') ? text.slice(0, -1) : text
  return /^\d+(\.\d+)?$/.test(value) && /[1-9]/.test(value) ? value : null
}

// Exact comparison of two plain decimal strings; never goes through floating point.
export function compareDecimals(left: string, right: string): -1 | 0 | 1 {
  const [leftWhole, leftFraction = ''] = left.split('.')
  const [rightWhole, rightFraction = ''] = right.split('.')
  const places = Math.max(leftFraction.length, rightFraction.length)
  const a = BigInt(leftWhole + leftFraction.padEnd(places, '0'))
  const b = BigInt(rightWhole + rightFraction.padEnd(places, '0'))
  return a === b ? 0 : a > b ? 1 : -1
}

export function isZeroDecimal(value: string): boolean {
  return !/[1-9]/.test(value)
}

// Total native-gas fee of a quote in wei, or null when the quote carries no gas estimate at all.
export function totalGasWei(gasFees: readonly BorrowGasEstimate[]): bigint | null {
  if (gasFees.length === 0) return null
  return gasFees.reduce((sum, entry) => sum + BigInt(entry.feeWei), 0n)
}

// Integer atoms to a grouped decimal string truncated to `digits`; a positive value below that precision reads "<0.0…1".
export function formatUnitsText(value: bigint, decimals: number, digits: number): string {
  const base = 10n ** BigInt(decimals)
  const whole = value / base
  const fraction = (value % base).toString().padStart(decimals, '0').slice(0, digits).replace(/0+$/, '')
  const grouped = whole.toLocaleString('en-US')
  if (whole === 0n && !fraction && value > 0n) return `<0.${'0'.repeat(Math.max(0, digits - 1))}1`
  return `${grouped}${fraction ? `.${fraction}` : ''}`
}

// Health factor as the service reports it; very large values are capped for display only.
export function formatHealthFactor(value: number): string {
  if (value >= 1000) return '1,000+'
  return value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

// Machina arithmetic, not a Borrow Service figure: borrowed amount times the quoted APY, as if the variable rate never
// changed for a year. Null when either input is unusable.
export function illustrativeYearlyInterest(borrowAmount: string, apy: number | null): string | null {
  if (apy === null) return null
  const interest = Number(borrowAmount) * apy
  return Number.isFinite(interest) ? interest.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : null
}

export type HealthTone = 'safe' | 'caution' | 'danger'

// Plain status wording for the bands the Borrow Service reports (the band names are the service's). It only says where the
// loan stands against the liquidation threshold, which is a health factor of 1.0.
export function healthBandLabel(band: BorrowHealthBand): string {
  switch (band) {
    case 'SAFE':
      return 'Above liquidation threshold'
    case 'WARN':
      return 'Approaching liquidation threshold'
    case 'URGENT':
      return 'Close to liquidation threshold'
    case 'IMMINENT':
      return 'Very close to liquidation'
    case 'LIQUIDATABLE':
      return 'Below liquidation threshold'
  }
}

// Where a health factor stands against the liquidation threshold, judged on the number as it is shown (two decimals).
export function thresholdStatus(healthFactor: number): { label: string; tone: HealthTone } {
  const shown = healthFactor >= 1000 ? healthFactor : Number(formatHealthFactor(healthFactor))
  if (shown < 1) return { label: 'Below liquidation threshold', tone: 'danger' }
  if (shown === 1) return { label: 'At liquidation threshold', tone: 'danger' }
  return { label: 'Above liquidation threshold', tone: 'safe' }
}

export function healthBandTone(band: BorrowHealthBand): HealthTone {
  if (band === 'SAFE') return 'safe'
  return band === 'WARN' || band === 'URGENT' ? 'caution' : 'danger'
}

// Fail-closed wording: malformed or unverifiable answers are never partially shown.
export function describeBorrowError(error: BorrowError): string {
  switch (error.code) {
    case 'reads_disabled':
      return 'Borrow reads are switched off in this build.'
    case 'invalid_input':
      return 'The request was not valid. Check the amounts and try again.'
    case 'market_not_found':
      return 'The Borrow Service does not know this market.'
    case 'loan_not_found':
      return 'The Borrow Service could not find this loan.'
    case 'unsupported_chain':
      return 'The Borrow Service does not support this network.'
    case 'unexpected_chain':
    case 'unexpected_owner':
    case 'malformed_response':
      return 'The Borrow Service returned data Machina could not verify, so nothing is shown.'
    case 'service_unavailable':
      return 'The Borrow Service is temporarily unavailable. Try again shortly.'
    case 'service_rejected':
      return 'The Borrow Service rejected this request.'
    default:
      return 'Something unexpected went wrong while reading Borrow data.'
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Market checks and read-only risk evaluation

// Integer atoms to an exact decimal string (no rounding, trailing zeros dropped).
export function formatUnitsExact(value: bigint, decimals: number): string {
  const base = 10n ** BigInt(decimals)
  const fraction = (value % base).toString().padStart(decimals, '0').replace(/0+$/, '')
  return `${value / base}${fraction ? `.${fraction}` : ''}`
}

// Morpho oracle price() is scaled by 10^(36 + loan decimals - collateral decimals): the price of one collateral token in
// the loan token. Null when the scale would be negative.
export function formatOraclePrice(price: bigint, loanDecimals: number, collateralDecimals: number): string | null {
  const scale = 36 + loanDecimals - collateralDecimals
  return scale < 0 ? null : formatUnitsText(price, scale, 2)
}

export function describeVerificationReason(reason: MarketVerificationReason): string {
  switch (reason) {
    case 'wrong_chain':
      return 'The RPC is not Arc mainnet.'
    case 'market_missing':
      return 'Morpho has no market with this ID.'
    case 'id_mismatch':
      return 'The on-chain parameters do not hash to this market ID.'
    case 'loan_token_mismatch':
      return 'The on-chain loan token differs from the one Circle reports.'
    case 'collateral_token_mismatch':
      return 'The on-chain collateral token differs from the one Circle reports.'
    case 'lltv_mismatch':
      return 'The on-chain LLTV differs from the one Circle reports.'
    case 'oracle_missing':
      return 'The market has no oracle.'
    case 'oracle_price_unavailable':
      return 'The oracle price could not be read or is zero.'
    case 'irm_missing':
      return 'The market has no interest rate model.'
  }
}

export type LiquidityView = {
  // The smaller of the figures that exist (Circle's cached figure and Morpho's on-chain supply minus borrow); null when
  // neither is available.
  available: string | null
  reported: string | null
  onchain: string | null
}

export function marketLiquidity(market: BorrowMarket, verification: MarketVerification | null | undefined): LiquidityView {
  const reported = market.liquidity?.amount ?? null
  const details = verification && (verification.status === 'verified' || verification.status === 'unverified') ? verification.details : null
  const onchain = details ? formatUnitsExact(details.liquidity, market.loanAsset.decimals) : null
  const figures = [reported, onchain].filter((value): value is string => value !== null)
  const available = figures.length === 0 ? null : figures.reduce((low, value) => (compareDecimals(value, low) < 0 ? value : low))
  return { available, reported, onchain }
}

export type LiquidityStatus =
  | { status: 'unknown' }
  | { status: 'none' }
  | { status: 'short' }
  | { status: 'enough' }
  | { status: 'unchecked' }

// Digits the interface shows for a token: the smallest amount it can display is one unit of the last digit.
export const displayDigits = (decimals: number) => (decimals > 6 ? 8 : 2)
export const smallestShown = (digits: number) => (digits > 0 ? `0.${'0'.repeat(digits - 1)}1` : '1')

// "Insufficient Liquidity" means nothing usable can be borrowed (zero, or less than the smallest amount shown), or the typed
// borrow amount is above what is available. No amount is fixed here: the floor follows the token's display precision.
export function liquidityStatus(view: LiquidityView, borrowAmount: string | null, digits = 2): LiquidityStatus {
  if (view.available === null) return { status: 'unknown' }
  if (isZeroDecimal(view.available) || compareDecimals(view.available, smallestShown(digits)) < 0) return { status: 'none' }
  if (borrowAmount === null) return { status: 'unchecked' }
  return compareDecimals(borrowAmount, view.available) > 0 ? { status: 'short' } : { status: 'enough' }
}

export const isHighUtilization = (utilization: number | null, threshold: number) => utilization !== null && utilization >= threshold
