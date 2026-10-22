import { formatUnits } from 'viem'

// The existing Uniswap policy rejects any network-fee ceiling above 0.1 USDC.
// Reserve that full ceiling, independent of an old or differently-sized quote.
export const NATIVE_SWAP_FEE_RESERVE = 10n ** 17n
export function swapShortcutAmount(balance: bigint, decimals: number, percent: number, native: boolean, reserve?: bigint, cap?: bigint): string {
  if (typeof balance !== 'bigint' || balance < 0n || balance >= 2n ** 256n || !Number.isInteger(decimals) || decimals < 0 || decimals > 18 || ![25, 50, 75, 100].includes(percent)) throw Error('balance')
  let units: bigint
  if (native) {
    if (decimals !== 6) throw Error('balance')
    if (percent === 100) {
      if (typeof reserve !== 'bigint' || reserve <= 0n || balance <= reserve) throw Error('gas')
      units = (balance - reserve) / 10n ** 12n
    } else units = balance * BigInt(percent) / 100n / 10n ** 12n
  } else units = balance * BigInt(percent) / 100n
  if (cap !== undefined) {
    if (typeof cap !== 'bigint' || cap <= 0n) throw Error('balance')
    if (units > cap) units = cap
  }
  if (units <= 0n) throw Error('zero')
  return formatUnits(units, decimals)
}
