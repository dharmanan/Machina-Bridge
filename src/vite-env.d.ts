/// <reference types="vite/client" />

declare module 'vite/client' {
  interface ImportMetaEnv {
    readonly VITE_SEPOLIA_RPC: string
    readonly VITE_ARC_TESTNET_RPC: string
    readonly VITE_BASE_SEPOLIA_RPC: string
    readonly VITE_OPTIMISM_SEPOLIA_RPC: string
    readonly VITE_ARBITRUM_SEPOLIA_RPC: string
    readonly VITE_SOLANA_DEVNET_RPC: string
    readonly VITE_CIRCLE_APP_ID: string
    readonly VITE_WALLETCONNECT_PROJECT_ID: string
  }
  interface ImportMeta {
    readonly env: ImportMetaEnv
  }
}

interface PhantomSolanaPublicKey {
  toBase58(): string
  toString(): string
}

interface PhantomSolanaConnectResult {
  publicKey: PhantomSolanaPublicKey
}

interface PhantomSolanaProvider {
  isConnected?: boolean
  isPhantom?: boolean
  publicKey?: PhantomSolanaPublicKey | null
  connect(options?: { onlyIfTrusted?: boolean }): Promise<PhantomSolanaConnectResult>
  disconnect(): Promise<void>
  on?(event: 'connect' | 'disconnect' | 'accountChanged', listener: (publicKey?: PhantomSolanaPublicKey | null) => void): void
  off?(event: 'connect' | 'disconnect' | 'accountChanged', listener: (publicKey?: PhantomSolanaPublicKey | null) => void): void
  removeListener?(event: 'connect' | 'disconnect' | 'accountChanged', listener: (publicKey?: PhantomSolanaPublicKey | null) => void): void
  signTransaction(transaction: unknown): Promise<unknown>
  signAllTransactions?(transactions: unknown[]): Promise<unknown[]>
  signMessage?(message: Uint8Array | number[] | string, display?: string): Promise<unknown>
}

interface Window {
  ethereum?: {
    request?: (args: { method: string; params?: unknown[] }) => Promise<unknown>
  }
}

interface Window {
  phantom?: {
    solana?: PhantomSolanaProvider
  }
  solana?: PhantomSolanaProvider
}
