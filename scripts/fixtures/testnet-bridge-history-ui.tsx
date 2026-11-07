// Testnet Bridge tab with a controlled EVM identity (wagmi is replaced by the test's Vite plugin).
// Any wallet request (chain switch, wallet client, signature) is recorded and refused.
import React from 'react'
import { createRoot } from 'react-dom/client'
import { BridgeTab } from '../../src/components/BridgeTab'
import '../../src/index.css'

const listeners = new Set<() => void>()
;(window as any).bridgeUi = {
  address: (window as any).__initialWallet ?? '0x1111111111111111111111111111111111111111',
  walletRequests: [] as string[],
  subscribe(cb: () => void) { listeners.add(cb); return () => listeners.delete(cb) },
  change(address: string) { (window as any).bridgeUi.address = address; for (const cb of listeners) cb() },
}
createRoot(document.getElementById('root')!).render(<BridgeTab />)
