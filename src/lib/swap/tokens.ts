import { MAINNET_SWAP_TOKENS, type MainnetSwapToken } from '../../config/mainnetSwap.ts'

// The four tokens of the Arc Mainnet Swap, shared by both providers. Addresses and decimals come from config/mainnetSwap.ts, which is
// pinned to the official Arc contract registry (https://docs.arc.io/arc/references/contract-addresses).
export type SwapSymbol = MainnetSwapToken
export const SWAP_SYMBOLS = Object.keys(MAINNET_SWAP_TOKENS) as SwapSymbol[]
export type SwapProviderId = 'uniswap' | 'circle'
export const SWAP_PROVIDERS: readonly SwapProviderId[] = ['uniswap', 'circle']
export const swapToken = (symbol: SwapSymbol) => MAINNET_SWAP_TOKENS[symbol]
export const isSwapSymbol = (value: unknown): value is SwapSymbol => typeof value === 'string' && Object.prototype.hasOwnProperty.call(MAINNET_SWAP_TOKENS, value)
export const NATIVE_ARC_TOKEN: SwapSymbol = 'USDC' // native gas currency; its ERC-20 interface (6 decimals) shares the same balance

// Every ordered pair of two different tokens: 4 x 3 = 12 directions.
export const SWAP_DIRECTIONS: readonly { tokenIn: SwapSymbol; tokenOut: SwapSymbol }[] = SWAP_SYMBOLS.flatMap(tokenIn => SWAP_SYMBOLS.filter(tokenOut => tokenOut !== tokenIn).map(tokenOut => ({ tokenIn, tokenOut })))

export const SWAP_UINT256_MAX = 2n ** 256n - 1n
export const SWAP_UINT160_MAX = 2n ** 160n - 1n

// ABI bounds, not product-value limits. Never parse token amounts through Number.
export function parseSwapUnits(value: unknown, decimals: number): bigint {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 18 || typeof value !== 'string' || value.length > 97 || !/^(0|[1-9]\d{0,77})(\.\d+)?$/.test(value)) throw Error('invalid_amount')
  const [whole, fraction = ''] = value.split('.')
  if (fraction.length > decimals) throw Error('invalid_amount')
  const units = BigInt(whole + fraction.padEnd(decimals, '0'))
  if (units > SWAP_UINT256_MAX) throw Error('input_range')
  return units
}
export function swapInputUnits(value: unknown, symbol: SwapSymbol): bigint {
  const units = parseSwapUnits(value, swapToken(symbol).decimals)
  if (units <= 0n) throw Error('invalid_amount')
  // Native USDC value is 18-decimal. uint256.max approval means unlimited.
  if (symbol === 'USDC' ? units * 10n ** 12n > SWAP_UINT256_MAX : units === SWAP_UINT256_MAX) throw Error('input_range')
  return units
}
