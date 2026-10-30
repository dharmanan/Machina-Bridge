// Live, read-only recovery harness: the real Sui Bridge (MainnetSuiBridge with
// the production recovery controller and readers), Dashboard and Activity. The
// wallets only provide identities (no provider, no signing). Used by
// scripts/verify-sui-live-recovery.mjs, which forwards only allow-listed read
// methods to Arc, Sui and Circle. Never imported by the application entry.
import React, { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { SuiClientProvider, WalletProvider } from '@mysten/dapp-kit'
import { getWallets } from '@mysten/wallet-standard'
import MainnetSuiBridge from '../../src/components/MainnetSuiBridge'
import MainnetDashboard from '../../src/components/MainnetDashboard'
import MainnetWalletActivity from '../../src/components/MainnetWalletActivity'
import { useSuiWallet } from '../../src/hooks/useSuiWallet'
import { SUI_NETWORKS } from '../../src/config/sui'
import REAL from './real-sui-transfers.json'
import '../../src/index.css'

const state = { sui: REAL.sui, signatures: 0, listeners: new Set<(e: unknown) => void>() }
const account = () => ({ address: state.sui, publicKey: new Uint8Array(32), chains: ['sui:mainnet'], features: ['sui:signTransaction'] })
getWallets().register({ version: '1.0.0', name: 'Slush identity', icon: 'data:image/svg+xml;base64,PHN2Zy8+', chains: ['sui:mainnet'], get accounts() { return [account()] }, features: {
  'standard:connect': { version: '1.0.0', connect: async () => ({ accounts: [account()] }) },
  'standard:events': { version: '1.0.0', on: (_e: string, cb: (e: unknown) => void) => { state.listeners.add(cb); return () => state.listeners.delete(cb) } },
  'sui:signTransaction': { version: '2.0.0', signTransaction: async () => { state.signatures++; throw Error('This harness never signs.') } },
} } as any)
function TopBarStub() { const sui = useSuiWallet('mainnet'); return <button type="button" onClick={() => void sui.connect()}>{sui.isConnected ? 'Slush connected' : 'Connect Slush (top bar)'}</button> }
function App() {
  const [tab, setTab] = useState('bridge')
  return <div className="mx-auto max-w-3xl p-3">
    <nav className="mb-3 flex gap-3 text-sm">{['bridge', 'dashboard', 'activity'].map(t => <button key={t} type="button" aria-pressed={tab === t} onClick={() => setTab(t)}>{t}</button>)}<TopBarStub /></nav>
    {tab === 'bridge' ? <MainnetSuiBridge /> : tab === 'dashboard' ? <MainnetDashboard /> : <MainnetWalletActivity />}
  </div>
}
;(window as any).liveUi = { state, REAL, changeSui: (address: string) => { state.sui = address; for (const cb of state.listeners) cb({ accounts: [account()] }) } }
createRoot(document.getElementById('root')!).render(<QueryClientProvider client={new QueryClient()}><SuiClientProvider networks={SUI_NETWORKS} defaultNetwork="mainnet"><WalletProvider autoConnect={false}><App /></WalletProvider></SuiClientProvider></QueryClientProvider>)
