// Browser-only controlled port harness. Never shipped by the application entry.
import { browserSuiWriteEnvironment, createSuiWriteController, type SuiWriteIntent, type SuiWritePort, type SuiWriteReview } from '../../src/lib/mainnetSuiExecution'
const i: SuiWriteIntent = { action: 'sui-burn', suiOwner: '0x' + '11'.repeat(32), evmOwner: '0x' + '22'.repeat(20), amount: 100000n, maxCctpFee: 100n, gasCeiling: 50000000n }
const state = { signatures: 0, broadcasts: 0, checks: 0, holdCheck: false, holdSign: false, current: true, expiry: Date.now() + 100000 }
let releaseCheck: (() => void) | undefined, releaseSign: (() => void) | undefined, review: SuiWriteReview
const port: SuiWritePort = {
  prepare: async () => ({ bytes: new Uint8Array([1,2,3]), digest: 'controlled-browser-digest', binding: 'controlled', expiresAt: state.expiry, maximumGas: 2n, estimatedGas: 1n }),
  async recheck() { state.checks++; if (state.holdCheck) await new Promise<void>(resolve => { releaseCheck = resolve }) },
  async sign(_i, bytes) { state.signatures++; if (state.holdSign) await new Promise<void>(resolve => { releaseSign = resolve }); return { bytes, signature: 'CONTROLLED-NEVER-PERSIST' } },
  validateSigned: async () => 'controlled-browser-digest',
  broadcast: async () => { state.broadcasts++ },
  recover: async () => 'verified',
}
const productionEnvironment = browserSuiWriteEnvironment(() => state.current)
// Explicitly local test authority. Production factory NEVER supplies this override.
const env = { ...productionEnvironment, gate: () => true }
const api = createSuiWriteController(port, env)
const harness = {
  state,
  productionGate: () => productionEnvironment.gate(),
  prepare: async () => { review = await api.prepare(i); return review.id },
  confirm: () => api.confirm(review),
  invalidate: () => api.invalidate(),
  recover: () => api.recover(),
  releaseCheck() { state.holdCheck = false; releaseCheck?.() },
  releaseSign() { state.holdSign = false; releaseSign?.() },
  load: () => env.load(),
}
;(window as unknown as { suiWriteHarness: typeof harness }).suiWriteHarness = harness
document.body.textContent = 'Controlled Sui write lifecycle harness · no live wallet or RPC'
