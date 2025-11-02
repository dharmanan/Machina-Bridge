// Type definitions for the application

export interface Token {
  address: string
  name: string
  symbol: string
  decimals: number
  balance?: string
  logoUrl?: string
}

export interface SwapParams {
  tokenIn: Token
  tokenOut: Token
  amountIn: string
  amountOut: string
  slippage: number
  recipient: string
}

export interface SwapRoute {
  path: string[]
  amounts: string[]
  priceImpact: number
  gasEstimate: bigint
}

export interface BridgeParams {
  token: Token
  amount: string
  fromChain: number
  toChain: number
  recipient: string
}

export interface Transaction {
  hash: string
  from: string
  to?: string
  value: string
  data?: string
  gasPrice: string
  gasLimit: string
  status?: 'pending' | 'success' | 'failed'
  blockNumber?: number
  timestamp?: number
}

export interface SwapTransaction extends Transaction {
  tokenIn: Token
  tokenOut: Token
  amountIn: string
  amountOut: string
}

export interface BridgeTransaction extends Transaction {
  token: Token
  amount: string
  fromChain: number
  toChain: number
}

export interface NetworkConfig {
  id: number
  name: string
  rpc: string
  explorer: string
  nativeCurrency?: {
    name: string
    symbol: string
    decimals: number
  }
}

export interface WalletState {
  address: string | null
  chainId: number | null
  balance: string
  isConnected: boolean
  isConnecting: boolean
}

export interface SwapState {
  tokenIn: Token | null
  tokenOut: Token | null
  amountIn: string
  amountOut: string
  estimatedOut: string
  isLoading: boolean
  error: string | null
  slippage: number
}

export interface BridgeState {
  token: Token | null
  amount: string
  isLoading: boolean
  error: string | null
  txHash: string | null
}

export interface AppConfig {
  network: NetworkConfig
  tokens: Token[]
  uniswapRouter: string
  bridgeConfig: {
    sourceChain: number
    destChain: number
    bridgeAddress?: string
  }
}
