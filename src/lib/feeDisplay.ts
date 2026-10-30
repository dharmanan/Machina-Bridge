// Presentation only: short, honest fee text from exact base units. The bigint
// values used for reviews, ceilings, commitments and signed bytes never pass
// through here; Technical details keep the exact numbers.
import { formatUnits } from 'viem'

// Rounds `value` (in `decimals` base units) to about `significant` digits, at most
// `maxDecimals` decimals. 'up' never understates (for limits), 'nearest' is for estimates.
// A positive value too small to show is '< 0.000001', never '0'.
export function formatFeeAmount(value: bigint, decimals: number, opts: { maxDecimals?: number; significant?: number; round?: 'nearest' | 'up' } = {}) {
  const maxDecimals = Math.min(opts.maxDecimals ?? 6, decimals), significant = opts.significant ?? 2, round = opts.round ?? 'nearest'
  if (value < 0n) throw new Error('Fee cannot be negative.')
  if (value === 0n) return '0'
  const exact = formatUnits(value, decimals), [int, frac = ''] = exact.split('.')
  const leadingZeros = int === '0' ? frac.length - frac.replace(/^0+/, '').length : 0
  const keep = Math.max(2, Math.min(maxDecimals, int === '0' ? leadingZeros + significant : Math.max(0, significant - int.length)))
  const scale = 10n ** BigInt(decimals - keep)
  let q = value / scale; const r = value % scale
  if (round === 'up' ? r > 0n : r * 2n >= scale) q += 1n
  if (q === 0n) return `< ${formatUnits(1n, keep)}`
  return formatUnits(q, keep)
}
export function feeEstimate(value: bigint, decimals: number, unit: string) {
  const v = formatFeeAmount(value, decimals, { round: 'nearest' })
  return v === '0' || v.startsWith('<') ? `${v} ${unit}` : `≈ ${v} ${unit}`
}
export const feeLimit = (value: bigint, decimals: number, unit: string) => `${formatFeeAmount(value, decimals, { round: 'up', significant: 3 })} ${unit}`
