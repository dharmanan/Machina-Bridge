// Controlled Review/Confirm harness. Real controller, real browser journal and
// Web Locks; controlled ports only. Never imported by the application entry.
import React, { useState } from 'react'
import { createRoot } from 'react-dom/client'
import MainnetSuiTransfer from '../../src/components/MainnetSuiTransfer'
import { browserSuiWriteEnvironment, createSuiWriteController, SuiWriteSignatureRejected, type SuiWriteIntent, type SuiWritePort, type SuiWriteReview } from '../../src/lib/mainnetSuiExecution'
import type { SuiTransferWriter } from '../../src/hooks/useSuiMainnetWrite'
import type { SuiRecoveryResult } from '../../src/lib/mainnetSuiRecovery'
import { keccak256, stringToHex } from 'viem'
import type { SuiWriteAttempt, SuiWriteReconciliation } from '../../src/lib/mainnetSuiExecution'
import '../../src/index.css'

const sui = '0x' + '11'.repeat(32), evm = '0x' + '22'.repeat(20)
const state = { prepares: 0, signatures: 0, broadcasts: 0, walletSends: 0, holdSend: false, signUnsupported: false, evidence: ['controlled mismatch evidence line'] as string[], evidenceFail: false, reconcileReads: 0, locate: null as string | null, failBroadcast: false, recoverTo: 'verified' as 'pending' | 'verified' | 'reverted' | 'mismatch', ttl: 100_000, intents: [] as SuiWriteIntent[], reviews: [] as SuiWriteReview[] }
const port: SuiWritePort = {
  async prepare(i) {
    state.prepares++; state.intents.push(i)
    return { bytes: new TextEncoder().encode(JSON.stringify([i.action, String(i.amount), i.sourceId ?? ''])), digest: i.action.startsWith('sui-') ? 'CtrDigest11111111111111111111111111111111111' : '0x' + 'ab'.repeat(32), binding: 'controlled', expiresAt: Date.now() + state.ttl, ...(i.arcMethod === 'wallet-send' ? { arc: { to: ('0x' + '33'.repeat(20)) as `0x${string}`, dataHash: ('0x' + '44'.repeat(32)) as `0x${string}`, nonce: 7, gas: 120_000n, maxFeePerGas: 30_000_000_000n, fromBlock: 100n } } : {}), estimatedGas: i.action.startsWith('sui-') ? 5_754_400n : 3_700_000_000_000_000n, maximumGas: i.action.startsWith('sui-') ? 50_000_000n : 4_400_000_000_000_000n, content: [`controlled ${i.action} bytes`, `owner ${i.action.startsWith('sui-') ? i.suiOwner : i.evmOwner}`] }
  },
  async recheck() {},
  async sign(_i, bytes) { state.signatures++; if (state.signUnsupported) throw new SuiWriteSignatureRejected('unsupported'); return { bytes, signature: 'CONTROLLED-NEVER-PERSIST' } },
  async validateSigned(i) { return i.action.startsWith('sui-') ? 'CtrDigest11111111111111111111111111111111111' : '0x' + 'ab'.repeat(32) },
  async broadcast() { state.broadcasts++; if (state.failBroadcast) throw new Error('lost response') },
  async recover() { return state.recoverTo },
  // Controlled wallet-send: counts the single request; may hold it to test tabs/reload.
  async send() { state.walletSends++; if (state.holdSend) await new Promise(() => {}); return '0x' + 'cd'.repeat(32) },
  async locate() { return state.locate },
  // Controlled read-only evidence; the key binds the lines exactly like the real port.
  async reconcile(a) { state.reconcileReads++; if (state.evidenceFail) throw new Error('The mismatched receipt is not yet canonical and deep enough. The transfer stays locked.'); const lines = [...state.evidence]; return { key: keccak256(stringToHex(JSON.stringify(lines))), digest: a.digest!, lines } },
}
const ctx = { suiOwner: sui, evmOwner: evm, ready: true }
const productionEnvironment = browserSuiWriteEnvironment(i => ctx.ready && i.suiOwner === ctx.suiOwner && i.evmOwner === ctx.evmOwner)
// Explicit local test authority. The production writer (useSuiMainnetWrite) has no such override.
const api = createSuiWriteController(port, { ...productionEnvironment, gate: () => true })
function writer(enabled: boolean): SuiTransferWriter {
  return {
    writesEnabled: enabled, walletSendEnabled: enabled,
    prepare: async i => { if (!enabled) throw new Error('locked'); const r = await api.prepare(i); state.reviews.push(r); return r },
    confirm: r => { if (!enabled) throw new Error('locked'); return api.confirm(r) },
    recover: () => api.recover(), saved: () => api.saved(), inspectMismatch: async () => await api.reconcile() as SuiWriteReconciliation, reconcile: async k => await api.reconcile(k) as SuiWriteAttempt, invalidate: () => api.invalidate(), feeBps: async () => 0,
  }
}
const enabledWriter = writer(true), lockedWriter = writer(false)
let set: (v: Partial<View>) => void = () => {}
type View = { direction: 'sui-to-arc' | 'arc-to-sui'; suiOwner?: string; evmOwner?: string; ready: boolean; recovery: SuiRecoveryResult | null; enabled: boolean; sources: string[] }
function App() {
  const [v, setV] = useState<View>({ direction: 'sui-to-arc', suiOwner: sui, evmOwner: evm, ready: true, recovery: null, enabled: new URLSearchParams(location.search).get('gate') !== 'production', sources: [] })
  set = p => setV(old => { const n = { ...old, ...p }; ctx.suiOwner = n.suiOwner ?? ''; ctx.evmOwner = n.evmOwner ?? ''; ctx.ready = n.ready; return n })
  return <div className="mx-auto max-w-xl p-4"><MainnetSuiTransfer writer={v.enabled ? enabledWriter : lockedWriter} direction={v.direction} suiOwner={v.suiOwner} evmOwner={v.evmOwner} ready={v.ready} recovery={v.recovery} onSource={(d, id) => setV(o => ({ ...o, sources: [...o.sources, `${d}:${id}`] }))} /><p data-testid="sources">{v.sources.join(',')}</p></div>
}
;(window as unknown as { reviewUi: unknown }).reviewUi = { state, sui, evm, set: (p: Partial<View>) => set(p), productionGate: () => productionEnvironment.gate(), directPrepare: () => api.prepare({ ...state.intents[state.intents.length - 1] }).then(() => 'UNSAFE', e => e.message), staleConfirm: (back = 1) => api.confirm(state.reviews[state.reviews.length - back]).then(() => 'UNSAFE', e => e.message) }
createRoot(document.getElementById('root')!).render(<App />)
