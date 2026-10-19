// Official Arc mainnet deployments: https://docs.arc.io/arc/references/contract-addresses
// USDC uses 6 decimals as ERC-20; the native gas denomination uses 18.
export const MAINNET_SWAP_READ_ONLY_ENABLED = true
export const MAINNET_SWAP_WRITES_ENABLED = false
export const MAINNET_SWAP_CHAIN_ID = 5042
export const MAINNET_SWAP_RPC = 'https://rpc.mainnet.arc.io'
export const MAINNET_SWAP_QUOTE_TTL_MS = 30_000
export const MAINNET_SWAP_TIMEOUT_MS = 15_000
export const MAINNET_SWAP_SLIPPAGE_BPS = [50, 100, 300] as const
export const MAINNET_SWAP_TOKENS = {
  USDC: { symbol: 'USDC', address: '0x3600000000000000000000000000000000000000', decimals: 6 },
  EURC: { symbol: 'EURC', address: '0xbEf5f6d51CB62b58e6A8f77868681825C6fe21c1', decimals: 6 },
  cirBTC: { symbol: 'cirBTC', address: '0x171A4217b86A807A64eB94757Db6849fb4bDbAA0', decimals: 8 },
  WETH: { symbol: 'WETH', address: '0x128cC466B61f542da60c70e3aA11c10e19B84EDB', decimals: 18 },
} as const
export type MainnetSwapToken = keyof typeof MAINNET_SWAP_TOKENS
