// Controlled Wallet Standard identity. No signing feature is ever exercised.
import React from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { SuiClientProvider, WalletProvider } from '@mysten/dapp-kit'
import { getWallets } from '@mysten/wallet-standard'
import MainnetSuiBridge from '../../src/components/MainnetSuiBridge'
import { SUI_NETWORKS } from '../../src/config/sui'
import '../../src/index.css'
const state = { signatures: 0, address: `0x${'0'.repeat(62)}15`, listeners: new Set<(e: unknown) => void>() }
const account = () => ({ address: state.address, publicKey: new Uint8Array(32), chains: ['sui:mainnet'], features: ['sui:signTransaction'] })
getWallets().register({ version: '1.0.0', name: 'Slush controlled', icon: 'data:image/svg+xml;base64,PHN2Zy8+', chains: ['sui:mainnet'], get accounts() { return [account()] }, features: {
  'standard:connect': { version: '1.0.0', connect: async () => ({ accounts: [account()] }) },
  'standard:events': { version: '1.0.0', on: (_e: string, cb: (e: unknown) => void) => { state.listeners.add(cb); return () => state.listeners.delete(cb) } },
  'sui:signTransaction': { version: '2.0.0', signTransaction: async () => { state.signatures++; throw Error('Unexpected signing request') } },
} } as any)
;(window as any).suiRecoveryUi = { state, evmOwner: '0xafbB6Cc5C0a9C0eB1BfF8dB2eD807e83aAB8e321', change: (address: string) => { state.address = address; for (const cb of state.listeners) cb({ accounts: [account()] }) } }
createRoot(document.getElementById('root')!).render(<QueryClientProvider client={new QueryClient()}><SuiClientProvider networks={SUI_NETWORKS} defaultNetwork="mainnet"><WalletProvider autoConnect={false}><div className="mx-auto max-w-xl p-4"><MainnetSuiBridge /></div></WalletProvider></SuiClientProvider></QueryClientProvider>)
