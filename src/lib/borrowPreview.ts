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

// Quoted health factor against the one the user chose, compared at the two decimals shown.
export function compareHealthFactor(target: number, quoted: number): { delta: number; relation: 'below' | 'at' | 'above' } {
  const delta = Math.round((quoted - target) * 100) / 100
  return { delta, relation: delta < 0 ? 'below' : delta > 0 ? 'above' : 'at' }
}

// 'skipped' is a check that does not apply to this input (optional collateral left empty). It is not a pass, it blocks nothing,
// and it is not waiting for anything.
export type RiskStatus = 'pass' | 'warn' | 'fail' | 'unknown' | 'pending' | 'skipped'

export type RiskCheck = { id: string; status: RiskStatus; text: string }

// A Borrow Service read: its value, null when the read failed or the service did not answer, 'pending' while it is not
// requested yet or still loading.
export type Reading<T> = T | null | 'pending'

export type RiskInput = {
  market: BorrowMarket | null
  verification: MarketVerification | null
  borrowAmount: string | null
  collateralAmount: string | null
  targetHealthFactor: number
  maxBorrow: Reading<BorrowAmount>
  sizing: Reading<{ healthFactor: number | null }>
  full: Reading<{ ltv: number | null; healthFactor: number | null }>
  limits: { maxLtv: number; highUtilization: number }
}

export type RiskReport = {
  checks: RiskCheck[]
  // A failed check or one that cannot be evaluated (the source did not report) would stop a future borrow.
  blocked: boolean
  // Some checks are still waiting for input or data; the report is not final.
  pending: boolean
}

const percent = (ratio: number) => `${(ratio * 100).toLocaleString('en-US', { maximumFractionDigits: 1 })}%`

// Pure and read only. Missing data is never a pass: it is "unknown" and blocks. A pass is not a guarantee against liquidation.
export function evaluateBorrowRisk(input: RiskInput): RiskReport {
  const { market, verification, limits } = input
  if (!market) return { checks: [], blocked: false, pending: true }
  const checks: RiskCheck[] = []
  const add = (id: string, status: RiskStatus, text: string) => checks.push({ id, status, text })

  // Verification against Morpho on-chain.
  if (!verification || verification.status === 'checking') add('verification', 'pending', 'Checking the market against Morpho on-chain.')
  else if (verification.status === 'verified') add('verification', 'pass', 'Market ID, tokens, LLTV, oracle and rate model match Morpho on-chain.')
  else if (verification.status === 'unverified') add('verification', 'fail', `Not verified on-chain. ${verification.reasons.map(describeVerificationReason).join(' ')}`)
  else add('verification', 'unknown', 'Morpho could not be read on-chain, so this market is not verified.')

  // Oracle.
  const details = verification && (verification.status === 'verified' || verification.status === 'unverified') ? verification.details : null
  if (!verification || verification.status === 'checking') add('oracle', 'pending', 'Oracle data is being read.')
  else if (details && details.oraclePrice !== null) add('oracle', 'pass', 'The market oracle returns a price.')
  else if (details) add('oracle', 'fail', 'Oracle data is missing: the oracle has no readable price.')
  else add('oracle', 'unknown', 'Oracle data could not be read.')

  // Liquidity.
  const liquidity = liquidityStatus(marketLiquidity(market, verification), input.borrowAmount, displayDigits(market.loanAsset.decimals))
  if (liquidity.status === 'unknown') add('liquidity', 'unknown', 'Liquidity is not reported, so it cannot be checked.')
  else if (liquidity.status === 'none') add('liquidity', 'fail', 'Insufficient Liquidity: no usable liquidity is available to borrow.')
  else if (liquidity.status === 'short') add('liquidity', 'fail', 'Insufficient Liquidity: the borrow amount is above the available liquidity.')
  else if (liquidity.status === 'unchecked') add('liquidity', 'pending', 'Enter a borrow amount to compare it with the available liquidity.')
  else add('liquidity', 'pass', 'The borrow amount is within the available liquidity.')

  // Utilization.
  if (market.utilization === null) add('utilization', 'unknown', 'Utilization is not reported.')
  else if (isHighUtilization(market.utilization, limits.highUtilization)) {
    // A market-wide rate risk. It says nothing about the absolute amount available; the liquidity check covers that.
    add('utilization', 'warn', `High market utilization (${percent(market.utilization)}): most supplied funds are already lent out, so the variable borrow rate can rise quickly. This flags rate risk; it does not mean the available amount is small.`)
  } else add('utilization', 'pass', `Utilization is ${percent(market.utilization)}, below the ${percent(limits.highUtilization)} flag.`)

  // Borrow amount against the service maximum for the collateral. The collateral is optional: without it only this comparison
  // is skipped, every other check still runs on the quote.
  if (!input.collateralAmount) add('max-borrow', 'skipped', 'Skipped: no collateral entered. The optional "Collateral you hold" field is needed to compare with the service maximum.')
  else if (!input.borrowAmount) add('max-borrow', 'pending', 'Enter a borrow amount to compare with the service maximum.')
  else if (input.maxBorrow === 'pending') add('max-borrow', 'pending', 'Reading the service maximum for this collateral.')
  else if (input.maxBorrow === null) add('max-borrow', 'unknown', 'The Borrow Service maximum for this collateral is not available.')
  else if (compareDecimals(input.borrowAmount, input.maxBorrow.amount) > 0) add('max-borrow', 'fail', 'The borrow amount is above the maximum the Borrow Service reports for this collateral.')
  else add('max-borrow', 'pass', 'The borrow amount is within the service maximum, which itself sits at the liquidation threshold.')

  // LTV cap: the Borrow Kit quote's own LTV, else LLTV divided by the sized health factor (Morpho: health = LLTV / LTV).
  const { full, sizing } = input
  let ltv: number | null = null
  let source = ''
  if (full && full !== 'pending' && full.ltv !== null) { ltv = full.ltv; source = 'Borrow Kit quote' }
  else if (sizing && sizing !== 'pending' && sizing.healthFactor !== null && sizing.healthFactor > 0 && market.lltv !== null) {
    ltv = market.lltv / sizing.healthFactor
    source = 'derived: LLTV ÷ health factor'
  }
  if (ltv !== null) {
    add('ltv', ltv > limits.maxLtv ? 'fail' : 'pass', ltv > limits.maxLtv
      ? `Loan-to-value ${percent(ltv)} is above the ${percent(limits.maxLtv)} starting limit (${source}).`
      : `Loan-to-value ${percent(ltv)} is within the ${percent(limits.maxLtv)} starting limit (${source}). This is not a guarantee against liquidation.`)
  } else if (!input.borrowAmount || sizing === 'pending' || (sizing !== null && full === 'pending')) {
    // Waiting for input, or for a read that can still arrive. A failed sizing read is not waited for.
    add('ltv', 'pending', `Enter a borrow amount and wait for the quote to check the ${percent(limits.maxLtv)} loan-to-value limit.`)
  } else add('ltv', 'unknown', 'The quotes do not report a loan-to-value or health factor, so the limit cannot be checked.')

  // The health factor the Borrow Kit quote actually gives against the target the user chose.
  if (full && full !== 'pending' && full.healthFactor !== null) {
    const gap = compareHealthFactor(input.targetHealthFactor, full.healthFactor)
    // Below the target the user picked is a blocker, not a warning: a future borrow would not go ahead on this quote.
    add('target-health-factor', gap.relation === 'below' ? 'fail' : 'pass', gap.relation === 'below'
      ? `Selected safety target not met: the quote's health factor ${formatHealthFactor(full.healthFactor)} is ${Math.abs(gap.delta).toFixed(2)} below the ${input.targetHealthFactor.toFixed(2)} you selected. A future borrow would be blocked.`
      : `The quote's health factor ${formatHealthFactor(full.healthFactor)} meets your ${input.targetHealthFactor.toFixed(2)} target.`)
  } else if (full === null) add('target-health-factor', 'unknown', 'The full quote is not available, so its health factor cannot be compared with your target.')
  else if (full && full !== 'pending') add('target-health-factor', 'unknown', 'The quote does not report a health factor.')
  else add('target-health-factor', 'pending', 'The full wallet quote is needed to compare its health factor with your target.')

  return {
    checks: orderRiskChecks(checks),
    blocked: checks.some((check) => check.status === 'fail' || check.status === 'unknown'),
    pending: checks.some((check) => check.status === 'pending'),
  }
}

// Real blockers first (failed or not evaluable), then warnings, then what is waiting, skipped, and passing. Stable within a group.
const RISK_ORDER: Record<RiskStatus, number> = { fail: 0, unknown: 0, warn: 1, pending: 2, skipped: 3, pass: 4 }
export function orderRiskChecks(checks: RiskCheck[]): RiskCheck[] {
  return checks.map((check, index) => ({ check, index }))
    .sort((a, b) => RISK_ORDER[a.check.status] - RISK_ORDER[b.check.status] || a.index - b.index)
    .map(({ check }) => check)
}

export type RiskSummary = { tone: 'fail' | 'warn' | 'pending' | 'pass'; text: string }

// One short line for the main screen; the individual checks stay behind "Show risk checks".
export function summarizeRisk(report: RiskReport): RiskSummary {
  const count = (status: RiskStatus) => report.checks.filter((check) => check.status === status).length
  const failed = count('fail')
  const unknown = count('unknown')
  const warnings = count('warn')
  const skipped = count('skipped')
  const warningText = `${warnings} warning${warnings === 1 ? '' : 's'}`
  const skippedText = skipped > 0 ? ` ${skipped} skipped.` : ''
  // Blockers are named first, then warnings.
  if (report.blocked) {
    const parts = [failed ? `${failed} failed` : null, unknown ? `${unknown} cannot be evaluated` : null, warnings ? warningText : null].filter(Boolean)
    return { tone: 'fail', text: `Would be blocked: ${parts.join(', ')}.` }
  }
  if (report.pending) return { tone: 'pending', text: 'Some checks are still waiting for input or data.' }
  if (warnings > 0) return { tone: 'warn', text: `No check failed, ${warningText}.${skippedText}` }
  return { tone: 'pass', text: skipped > 0 ? `All applicable checks pass.${skippedText}` : 'All checks pass.' }
}
