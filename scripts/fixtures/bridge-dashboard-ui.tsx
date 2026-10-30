// Controlled harness for the Mainnet Dashboard, Activity and Sui Bridge sharing
// one browser history. Real components and hooks (dApp Kit + Wallet Standard
// Slush identity, Phantom provider shape, wagmi account); controlled chain
// responses and a controlled Sui write port. Never imported by the app entry.
import React, { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { SuiClientProvider, WalletProvider } from '@mysten/dapp-kit'
import { getWallets } from '@mysten/wallet-standard'
import MainnetDashboard from '../../src/components/MainnetDashboard'
import MainnetWalletActivity from '../../src/components/MainnetWalletActivity'
import SuiBridgeFlow from '../../src/components/SuiBridgeFlow'
import { useSuiWallet } from '../../src/hooks/useSuiWallet'
import { SUI_NETWORKS } from '../../src/config/sui'
import { browserSuiWriteEnvironment, createSuiWriteController, type SuiWritePort } from '../../src/lib/mainnetSuiExecution'
import type { SuiTransferWriter } from '../../src/hooks/useSuiMainnetWrite'
import type { SuiRecoveryInput, SuiRecoveryResult } from '../../src/lib/mainnetSuiRecovery'
import { importSuiRecovery, readSuiRecoveryQueue, subscribeSuiRecovery } from '../../src/lib/mainnetSuiQueue'
import REAL from './real-sui-transfers.json'
import '../../src/index.css'

const SOLANA = '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU'
const state = { signatures: 0, broadcasts: 0, inspects: 0, stage: 'ready_to_mint' as SuiRecoveryResult['stage'], wallets: { evm: true, phantom: true } }
// Phantom provider shape (read-only use here: the address).
;(window as any).phantom = { solana: { isPhantom: true, isConnected: true, publicKey: { toBase58: () => SOLANA, toString: () => SOLANA }, on() {}, off() {}, connect: async () => ({ publicKey: { toBase58: () => SOLANA } }), disconnect: async () => {} } }
// Slush identity through the Wallet Standard (no signing feature is used by the Dashboard).
const account = () => ({ address: REAL.sui, publicKey: new Uint8Array(32), chains: ['sui:mainnet'], features: ['sui:signTransaction'] })
getWallets().register({ version: '1.0.0', name: 'Slush controlled', icon: 'data:image/svg+xml;base64,PHN2Zy8+', chains: ['sui:mainnet'], get accounts() { return [account()] }, features: {
  'standard:connect': { version: '1.0.0', connect: async () => ({ accounts: [account()] }) },
  'standard:events': { version: '1.0.0', on: () => () => {} },
  'sui:signTransaction': { version: '2.0.0', signTransaction: async () => { throw Error('Unexpected signing request') } },
} } as any)

// The last real transfer (Arc -> Sui 0xe28f…) replayed from "ready to receive" to its real Sui mint.
const last = REAL.transfers[4]
const port: SuiWritePort = {
  async prepare(i) { return { bytes: new TextEncoder().encode(JSON.stringify([i.action, String(i.amount), i.sourceId ?? ''])), digest: last.destination, binding: 'controlled', expiresAt: Date.now() + 100_000, estimatedGas: 5_754_400n, maximumGas: 50_000_000n, content: [`controlled ${i.action} bytes`] } },
  async recheck() {},
  async sign(_i, bytes) { state.signatures++; return { bytes, signature: 'CONTROLLED-NEVER-PERSIST' } },
  async validateSigned() { return last.destination },
  async broadcast() { state.broadcasts++ },
  async recover() { return 'verified' },
  async send() { throw new Error('not used') },
  async locate() { return null },
  async reconcile() { throw new Error('not used') },
}
const api = createSuiWriteController(port, { ...browserSuiWriteEnvironment(i => i.suiOwner === REAL.sui && i.evmOwner === REAL.evm), gate: () => true })
const writer: SuiTransferWriter = { writesEnabled: true, walletSendEnabled: true, prepare: i => api.prepare(i), confirm: r => api.confirm(r), recover: () => api.recover(), saved: () => api.saved(), invalidate: () => api.invalidate(), feeBps: async () => 0, inspectMismatch: async () => { throw new Error('not used') }, reconcile: async () => { throw new Error('not used') } }
async function inspect(input: SuiRecoveryInput): Promise<SuiRecoveryResult> {
  state.inspects++
  const t = REAL.transfers.find(x => x.source.toLowerCase() === input.sourceId.toLowerCase())!
  const r: SuiRecoveryResult = { ...input, sourceTime: Date.parse(t.sourceTime), sourceId: input.direction === 'arc-to-sui' ? input.sourceId.toLowerCase() : input.sourceId, amount: '0.1', maxFeeUnits: '0', sourceEventIndex: t.eventIndex, stage: t === last ? state.stage : 'complete', feeUsdc: '0', receivedUsdc: '0.1', ...(t !== last || state.stage === 'complete' ? { destinationTx: t.destination } : {}), checkedAt: Date.now() }
  importSuiRecovery(r); return r
}

function TopBarStub() { const sui = useSuiWallet('mainnet'); return <button type="button" onClick={() => void sui.connect()}>{sui.isConnected ? 'Slush connected' : 'Connect Slush (top bar)'}</button> }
function Bridge() {
  const [records, setRecords] = useState(readSuiRecoveryQueue)
  useEffect(() => subscribeSuiRecovery(() => setRecords(readSuiRecoveryQueue())), [])
  return <div className="mx-auto max-w-xl p-4"><SuiBridgeFlow writer={writer} records={records} inspect={inspect} pollMs={{ status: 600_000, attestation: 600_000 }}
    evm={{ address: REAL.evm, walletName: 'MetaMask', onArc: true }} sui={{ address: REAL.sui, walletName: 'Slush', ready: true, usdc: '0.3', gas: '1' }}
    arc={{ usdcUnits: 1_000_000n, refresh: async () => ({ allowanceUnits: 0n }) }} /></div>
}
function App() {
  const [tab, setTab] = useState(new URLSearchParams(location.search).get('tab') ?? 'dashboard')
  return <div>
    <nav className="flex gap-2 p-3">{['bridge', 'dashboard', 'activity'].map(t => <button key={t} type="button" onClick={() => setTab(t)} aria-pressed={tab === t}>{t}</button>)}<TopBarStub /></nav>
    {tab === 'bridge' ? <Bridge /> : tab === 'activity' ? <MainnetWalletActivity /> : <MainnetDashboard />}
  </div>
}
;(window as any).dashboardUi = { state, REAL, SOLANA }
createRoot(document.getElementById('root')!).render(<QueryClientProvider client={new QueryClient()}><SuiClientProvider networks={SUI_NETWORKS} defaultNetwork="mainnet"><WalletProvider autoConnect={false}><App /></WalletProvider></SuiClientProvider></QueryClientProvider>)
