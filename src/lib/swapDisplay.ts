import { formatUnits } from 'viem'

// Display only, with all amounts in 18-decimal USDC. Do not convert other tokens
// or substitute a fee ceiling for a missing estimate. 10% is a notice threshold,
// never an execution limit; listed provider fees are already reflected in price.
export function quoteCostWarning(amount: bigint, gasEstimate: bigint | null | undefined, listedFees: bigint | null | undefined): string | null {
  if (amount <= 0n || gasEstimate == null || gasEstimate <= 0n || listedFees == null || listedFees < 0n) return null
  const cost = gasEstimate + listedFees
  if (cost * 10n < amount) return null
  const tenths = (cost * 1000n + amount / 2n) / amount
  return `Estimated network and listed provider fees are about ${formatUnits(tenths, 1)}% of this USDC amount. Listed provider fees are already included in the price.`
}

const group = (whole: string) => whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',')

// Display-only: truncates (never rounds up) to 6 decimals, or 6 significant digits below 1. Exact values stay in the quote.
export function shortenAmount(value: string): string {
  const [whole, fraction = ''] = value.split('.')
  if (!/^\d+$/.test(whole) || !/^\d*$/.test(fraction)) return value
  let kept: string
  if (whole !== '0') kept = fraction.slice(0, 6)
  else {
    const zeros = fraction.match(/^0*/)![0].length
    kept = fraction.slice(0, zeros + 6)
  }
  kept = kept.replace(/0+$/, '')
  return kept ? `${group(whole)}.${kept}` : group(whole)
}

// USDC per one unit of the non-USDC token, from the exact quoted amounts. Fees are not part of either amount.
export function unitPriceInUsdc(usdcUnits: bigint, tokenUnits: bigint, tokenDecimals: number): string | null {
  if (usdcUnits <= 0n || tokenUnits <= 0n) return null
  const price = usdcUnits * 10n ** BigInt(tokenDecimals) * 10n ** 18n / (tokenUnits * 10n ** 6n)
  if (price <= 0n) return null
  if (price >= 10n ** 18n) {
    const cents = (price + 5n * 10n ** 15n) / 10n ** 16n
    return `${group((cents / 100n).toString())}.${(cents % 100n).toString().padStart(2, '0')}`
  }
  const leadingZeros = 18 - price.toString().length
  const decimals = Math.min(18, leadingZeros + 4)
  const rounded = (price + 10n ** BigInt(17 - decimals) * 5n) / 10n ** BigInt(18 - decimals)
  return formatUnits(rounded, decimals).replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '')
}

// How many output tokens one input token buys, from the exact quoted amounts (fees are not part of either amount). Display only:
// five decimals below 1, four decimals from 1, two decimals from 100 up; never shows a value for a non-positive amount.
export function exchangeRate(inUnits: bigint, inDecimals: number, outUnits: bigint, outDecimals: number): string | null {
  if (inUnits <= 0n || outUnits <= 0n) return null
  const scale = 10n ** 24n
  const rate = outUnits * 10n ** BigInt(inDecimals) * scale / (inUnits * 10n ** BigInt(outDecimals))
  if (rate <= 0n) return null
  const digits = rate.toString().length - 24 // digits before the decimal point (<= 0 means below 1)
  const decimals = digits >= 3 ? 2 : digits >= 1 ? 4 : Math.min(24, 3 + (1 - digits) + 1)
  const quantum = 10n ** BigInt(24 - decimals), rounded = (rate + quantum / 2n) / quantum
  const [whole, fraction = ''] = formatUnits(rounded, decimals).replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '').split('.')
  return fraction ? `${group(whole)}.${fraction}` : group(whole)
}
