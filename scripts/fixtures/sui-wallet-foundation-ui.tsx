// Controlled Wallet Standard account. Never signs or broadcasts.
import React, { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { SuiClientProvider, WalletProvider } from '@mysten/dapp-kit'
import { getWallets } from '@mysten/wallet-standard'
import { useSuiWallet } from '../../src/hooks/useSuiWallet'
import { SUI_NETWORKS, type SuiNetwork } from '../../src/config/sui'

const control = { signatures: 0, owner: `0x${'11'.repeat(32)}`, chains: ['sui:mainnet', 'sui:testnet'], listeners: new Set<(event: unknown) => void>() }
function account() { return { address: control.owner, publicKey: new Uint8Array(32), chains: control.chains, features: ['sui:signTransaction'] } }
const wallet = {
  version: '1.0.0' as const, name: 'Slush controlled fixture',
  icon: 'data:image/svg+xml;base64,PHN2Zy8+' as const,
  chains: ['sui:mainnet', 'sui:testnet'] as const,
  get accounts() { return [account()] },
  features: {
    'standard:connect': { version: '1.0.0', connect: async () => ({ accounts: [account()] }) },
    'standard:disconnect': { version: '1.0.0', disconnect: async () => {} },
    'standard:events': { version: '1.0.0', on: (_event: string, cb: (event: unknown) => void) => { control.listeners.add(cb); return () => control.listeners.delete(cb) } },
    'sui:signTransaction': { version: '2.0.0', signTransaction: async () => { control.signatures++; throw Error('Unexpected signing request') } },
  },
}
getWallets().register(wallet as any)
;(window as any).suiFoundation = { control, change: (owner: string, chains: string[]) => { control.owner = owner; control.chains = chains; for (const cb of control.listeners) cb({ accounts: [account()] }) } }

function Probe() {
  const [network, setNetwork] = useState<SuiNetwork>('mainnet')
  const w = useSuiWallet(network)
  return <main style={{ padding: 16, maxWidth: 420, fontFamily: 'sans-serif', overflowWrap: 'anywhere' }}>
    <h1>Sui wallet foundation — controlled test</h1>
    <button onClick={() => void w.connect()}>Connect Slush fixture</button>
    <button onClick={() => setNetwork(network === 'mainnet' ? 'testnet' : 'mainnet')}>Switch network</button>
    <button onClick={() => void w.refetchBalance()}>Refresh balances</button>
    <p data-testid="network">{w.network}</p><p data-testid="address">{w.address ?? 'Disconnected'}</p>
    <p data-testid="usdc">{w.usdcBalance ?? 'Unavailable'} USDC</p><p data-testid="sui">{w.suiBalance ?? 'Unavailable'} SUI</p>
    <p role="status">{w.balanceError ?? (w.isLoadingBalance ? 'Checking network and balances' : 'Ready')}</p>
    <button disabled>Transfers unavailable: Mainnet V2 deployment is not verified</button>
  </main>
}
createRoot(document.getElementById('root')!).render(<QueryClientProvider client={new QueryClient()}><SuiClientProvider networks={SUI_NETWORKS} defaultNetwork="mainnet"><WalletProvider autoConnect={false}><Probe /></WalletProvider></SuiClientProvider></QueryClientProvider>)
