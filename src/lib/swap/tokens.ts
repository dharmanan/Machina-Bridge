import { MAINNET_SWAP_TOKENS, type MainnetSwapToken } from '../../config/mainnetSwap'

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

// Largest input the application will prepare per transaction while execution is open beyond the pilot, in base units of the input
// token. Conservative, roughly 10 USD worth each. Raising a cap is a separate, explicit release decision, never a runtime setting.
export const SWAP_INPUT_CAPS: Record<SwapSymbol, bigint> = {
  USDC: 10_000_000n,            // 10 USDC
  EURC: 9_000_000n,             // 9 EURC
  cirBTC: 12_000n,              // 0.00012 cirBTC
  WETH: 4_000_000_000_000_000n, // 0.004 WETH
}
