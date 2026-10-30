// Controlled Sui Bridge harness. Real flow UI, real controller, real browser
// journal, Web Locks and transfer history; controlled wallet ports and chain
// reads only. Never imported by the application entry.
import React, { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { keccak256, stringToHex } from 'viem'
import SuiBridgeFlow from '../../src/components/SuiBridgeFlow'
import { browserSuiWriteEnvironment, createSuiWriteController, SuiWriteSignatureRejected, type SuiWriteAttempt, type SuiWriteIntent, type SuiWritePort, type SuiWriteReconciliation, type SuiWriteReview } from '../../src/lib/mainnetSuiExecution'
import type { SuiTransferWriter } from '../../src/hooks/useSuiMainnetWrite'
import type { SuiRecoveryInput, SuiRecoveryResult } from '../../src/lib/mainnetSuiRecovery'
import { importSuiRecovery, readSuiRecoveryQueue, subscribeSuiRecovery } from '../../src/lib/mainnetSuiQueue'
import '../../src/index.css'

// Identifiers of the first real Arc -> Sui transfer (2026-10-29).
const REAL = { arcBurn: '0x2cf8f5a53f6c0deb8adeb527bd693e2977f7a403b4750da4a37c6adb5f6eac37', suiMint: '35MLrmr8g8ZD1tw2cY1JuKe3jJGRWaPQ7mnponw6ZPFK', sui: '0xf0d9c71c894a249d7f406f45c98094e92de5d9f95d54c0c628adc51daa1ebeec', evm: '0xafbb6cc5c0a9c0eb1bff8db2ed807e83aab8e321' }
const SUI_BURN = 'CYF6ajsTZgD2dyw2Xdz66bEm2owvhAxnTYNQ7hjFFxf5', ARC_MINT = '0x' + 'ab'.repeat(32), ARC_APPROVAL = '0x' + 'cd'.repeat(32)
const params = new URLSearchParams(location.search), fast = params.get('poll') === 'fast'
const state = {
  prepares: 0, signatures: 0, broadcasts: 0, walletSends: 0, holdSend: false, holdPrepare: false, releasePrepare: null as null | (() => void), releaseSend: null as null | (() => void), signUnsupported: false, failBroadcast: false,
  recoverTo: 'verified' as 'pending' | 'verified' | 'reverted' | 'mismatch', ttl: 100_000, locate: null as string | null,
  evidence: ['controlled mismatch evidence line'] as string[], evidenceFail: false, reconcileReads: 0,
  allowance: 0n, stage: 'waiting_attestation' as SuiRecoveryResult['stage'], inspectFail: '' as string, inspectCalls: 0, inspectAmount: '0.1',
  intents: [] as SuiWriteIntent[], reviews: [] as SuiWriteReview[],
}
const digestOf = (i: SuiWriteIntent) => i.action === 'sui-burn' ? SUI_BURN : i.action === 'sui-mint' ? REAL.suiMint : i.action === 'arc-burn' ? REAL.arcBurn : i.action === 'arc-mint' ? ARC_MINT : ARC_APPROVAL
const port: SuiWritePort = {
  async prepare(i) {
    state.prepares++; state.intents.push(i)
    if (state.holdPrepare) await new Promise<void>(r => { state.releasePrepare = r })
    return { bytes: new TextEncoder().encode(JSON.stringify([i.action, String(i.amount), i.sourceId ?? '', i.arcMethod ?? ''])), digest: i.action.startsWith('sui-') ? digestOf(i) : undefined, binding: 'controlled', expiresAt: Date.now() + state.ttl, ...(i.arcMethod === 'wallet-send' ? { arc: { to: ('0x' + '33'.repeat(20)) as `0x${string}`, dataHash: ('0x' + '44'.repeat(32)) as `0x${string}`, nonce: 7, gas: 120_000n, maxFeePerGas: 30_000_000_000n, fromBlock: 100n } } : {}), estimatedGas: i.action.startsWith('sui-') ? 5_754_400n : 3_700_000_000_000_000n, maximumGas: i.action.startsWith('sui-') ? 50_000_000n : 4_400_000_000_000_000n, content: [`controlled ${i.action} bytes`] }
  },
  async recheck() {},
  async sign(_i, bytes) { state.signatures++; if (state.signUnsupported) throw new SuiWriteSignatureRejected('unsupported'); return { bytes, signature: 'CONTROLLED-NEVER-PERSIST' } },
  async validateSigned(i) { return digestOf(i) },
  async broadcast() { state.broadcasts++; if (state.failBroadcast) throw new Error('lost response') },
  // Mirrors the real port: a verified burn is recorded in history; a verified approval raises the allowance.
  async recover(a: SuiWriteAttempt) {
    if (state.recoverTo === 'verified') {
      const i = a.intent
      if (i.action === 'arc-approval') state.allowance = i.amount
      if (i.action === 'arc-burn' || i.action === 'sui-burn') importSuiRecovery({ direction: i.action === 'arc-burn' ? 'arc-to-sui' : 'sui-to-arc', sourceId: a.digest!, suiOwner: i.suiOwner, evmOwner: i.evmOwner, amount: (i.amount / 1000000n).toString() + '.' + (i.amount % 1000000n).toString().padStart(6, '0'), sourceEventIndex: 6, stage: 'waiting_attestation', checkedAt: Date.now() })
    }
    return state.recoverTo
  },
  async send(i) { state.walletSends++; if (state.holdSend) await new Promise<void>(r => { state.releaseSend = r }); return digestOf(i) },
  async locate() { return state.locate },
  async reconcile(a) { state.reconcileReads++; if (state.evidenceFail) throw new Error('The mismatched receipt is not in the canonical chain served by this RPC. The transfer stays locked.'); const lines = [...state.evidence]; return { key: keccak256(stringToHex(JSON.stringify(lines))), digest: a.digest!, lines } },
}
const ctx = { suiOwner: REAL.sui, evmOwner: REAL.evm, ready: true, usdcUnits: 1_000_000n, suiUsdc: '1', suiGas: '2' }
const productionEnvironment = browserSuiWriteEnvironment(i => ctx.ready && i.suiOwner === ctx.suiOwner && i.evmOwner === ctx.evmOwner)
// Explicit local test authority. The production writer (useSuiMainnetWrite) has no such override.
const api = createSuiWriteController(port, { ...productionEnvironment, gate: () => true })
function writer(enabled: boolean): SuiTransferWriter {
  return {
    writesEnabled: enabled, walletSendEnabled: enabled,
    prepare: async i => { if (!enabled) throw new Error('locked'); const r = await api.prepare(i); state.reviews.push(r); return r },
    confirm: r => { if (!enabled) throw new Error('locked'); return api.confirm(r) },
    recover: () => api.recover(), saved: () => api.saved(), invalidate: () => api.invalidate(), feeBps: async () => Number(params.get('feeBps') ?? 0),
    inspectMismatch: async () => await api.reconcile() as SuiWriteReconciliation, reconcile: async k => await api.reconcile(k) as SuiWriteAttempt,
  }
}
const enabledWriter = writer(true), lockedWriter = writer(false)
async function inspect(input: SuiRecoveryInput): Promise<SuiRecoveryResult> {
  state.inspectCalls++
  if (state.inspectFail) throw new Error(state.inspectFail)
  const complete = state.stage === 'complete'
  const r: SuiRecoveryResult = { ...input, amount: state.inspectAmount, maxFeeUnits: '0', sourceEventIndex: 6, stage: state.stage, ...(state.stage === 'waiting_attestation' ? {} : { feeUsdc: '0', receivedUsdc: state.inspectAmount }), ...(complete ? { destinationTx: input.direction === 'arc-to-sui' ? REAL.suiMint : ARC_MINT } : {}), checkedAt: Date.now() }
  importSuiRecovery(r); return r
}
let set: (v: Partial<typeof ctx>) => void = () => {}
function App() {
  const [c, setC] = useState({ ...ctx })
  const [records, setRecords] = useState(readSuiRecoveryQueue)
  useEffect(() => subscribeSuiRecovery(() => setRecords(readSuiRecoveryQueue())), [])
  set = p => setC(old => { const n = { ...old, ...p }; Object.assign(ctx, n); return n })
  return <div className="mx-auto max-w-xl p-4"><header data-testid="above-panel" className="mb-4 rounded-xl bg-slate-900 p-3 text-sm font-semibold text-white">Machina Bridge · Sui ↔ Arc (layout reference)</header><SuiBridgeFlow writer={params.get('gate') === 'production' ? lockedWriter : enabledWriter} records={records} inspect={inspect}
    pollMs={fast ? { status: 300, attestation: 300 } : { status: 600_000, attestation: 600_000 }}
    evm={{ address: c.evmOwner, walletName: 'MetaMask', onArc: c.ready }} sui={{ address: c.suiOwner, walletName: 'Slush', ready: c.ready, usdc: c.suiUsdc, gas: c.suiGas }}
    arc={{ usdcUnits: c.usdcUnits, refresh: async () => ({ allowanceUnits: state.allowance }) }} /></div>
}
;(window as unknown as { reviewUi: unknown }).reviewUi = { state, REAL, set: (p: Partial<typeof ctx>) => set(p), productionGate: () => productionEnvironment.gate(), staleConfirm: (back = 1) => api.confirm(state.reviews[state.reviews.length - back]).then(() => 'UNSAFE', e => e.message), directPrepare: () => api.prepare({ ...state.intents[state.intents.length - 1] }).then(() => 'UNSAFE', e => e.message) }
createRoot(document.getElementById('root')!).render(<App />)
