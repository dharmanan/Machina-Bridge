// Test-only entry point. Not imported by the application or production build.
import React, { useMemo, useState } from 'react'
import { createRoot } from 'react-dom/client'
import '../../../src/index.css'
import { BorrowOperations } from '../../../src/components/BorrowOperations'
import { browserBorrowLocks } from '../../../src/lib/borrowOperationLock'
import { borrowAttemptScope } from '../../../src/lib/borrowWriteSafety'
import { verifyBorrowSettlement } from '../../../src/lib/borrowSettlement'
import { build, persistent, WALLET, MARKET_DATA, POSITION, NOW } from './operations'
import { batchFixture, settlementFixture } from './batch'
const control = { mode: 'verified', sends: 0, refreshes: 0, time: NOW, hold: false, release: null as null | (() => void), proofs: new Map() }
;(window as any).borrowTest = control
function App() {
  const [reset, setReset] = useState(0)
  const ports = useMemo(() => {
    const attempts = persistent(localStorage, `browser-${crypto.randomUUID()}`)
    return { attempts, locks: browserBorrowLocks(), now: () => control.time,
      executionBlocker: () => control.mode === 'production-closed' ? 'Real transactions are closed.' : null,
      readWallet: async () => ({ address: WALLET, chainId: 5042, atomicBatch: 'supported' as const, atomicBatchFor: `${WALLET}@5042` }),
      prepare: async (action) => {
        if (control.mode === 'rpc-failed') throw new Error('private RPC failure')
        const { context } = await build(action.kind)
        return context
      },
      submit: async (review, onSubmitted) => {
        control.sends++
        if (control.mode === 'rejected') throw new Error('wallet rejection')
        const scope = borrowAttemptScope(review.action, WALLET)
        if (!attempts.begin({ scopeId: scope, actionId: review.actionId, kind: review.action.kind, idempotencyKey: crypto.randomUUID() }, control.time)) throw new Error('unresolved')
        const batch = batchFixture(review.action.kind, control.time, review.prepared), e = settlementFixture(batch.review, batch.calls, scope)
        const proof = verifyBorrowSettlement(batch.review, scope, batch.calls, e)
        control.proofs.set(e.txHash, proof)
        attempts.finish(scope, 'submitted', control.time, { batchId: 'test-batch', txHash: e.txHash }); onSubmitted('test-batch', e.txHash)
        if (control.hold) await new Promise<void>(resolve => { control.release = resolve })
        return { batchId: 'test-batch', txHash: e.txHash }
      },
      verify: async (_r, _b, hash) => control.mode === 'verified' ? control.proofs.get(hash) : null,
    }
  }, [reset])
  ;(window as any).resetBorrowTest = () => { localStorage.clear(); control.sends = 0; control.time = NOW; setReset(x => x + 1) }
  return <main className="mx-auto max-w-3xl p-4"><BorrowOperations key={reset} ports={ports} wallet={{ address: WALLET, chainId: 5042, atomicBatch: 'supported', atomicBatchFor: `${WALLET}@5042` }} market={MARKET_DATA} positions={[POSITION]} attempts={ports.attempts} onVerified={() => { control.refreshes++ }} /></main>
}
createRoot(document.getElementById('root')!).render(<App />)
