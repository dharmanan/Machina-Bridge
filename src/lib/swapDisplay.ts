import { formatUnits } from 'viem'

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
