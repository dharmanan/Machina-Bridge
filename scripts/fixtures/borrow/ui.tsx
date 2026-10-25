// Test-only entry point. Not imported by the application or production build.
import React, { useMemo, useState } from 'react'
import { createRoot } from 'react-dom/client'
import '../../../src/index.css'
import { setupSdk, attachSdkReceipt } from './sdk'
import { recoverBorrowTransaction } from '../../../src/lib/borrowRecovery'
import { BorrowWorkspace } from '../../../src/components/MainnetBorrow'
import { fakeClient, MARKET_WIRE, LOAN_WIRE, RESPONSES, METHOD, VERIFIED, BALANCES } from './operations'
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
function SdkApp() {
  const ports = useMemo(() => {
    const attempts = persistent(localStorage, `sdk-browser-${crypto.randomUUID()}`)
    let sdk: any = null
    return { attempts, locks: browserBorrowLocks(), executionBlocker: () => null, walletStage: 'bound' as const,
      readWallet: async () => ({ address: WALLET, chainId: 5042, atomicBatch: 'supported' as const, atomicBatchFor: `${WALLET}@5042` }),
      prepare: async action => {
        sdk = await setupSdk(action.kind)
        ;(window as any).sdkUi = sdk
        return { wallet: sdk.review.wallet, quote: sdk.review.prepared, evidence: sdk.review.evidence }
      },
      submit: async (review, onSubmitted, onWallet, onPrepared) => {
        Object.assign(sdk.review, review)
        sdk.callbacks.walletRequested = onWallet; sdk.callbacks.prepared = onPrepared
        const scopeId = borrowAttemptScope(review.action, WALLET)
        if (!attempts.begin({ scopeId, actionId: review.actionId, kind: review.action.kind, idempotencyKey: crypto.randomUUID() }, Date.now())) throw Error('unresolved attempt')
        await sdk.run(); const bound = sdk.getBound()
        attempts.finish(scopeId, 'submitted', Date.now(), { batchId: bound.txHash, txHash: bound.txHash }); onSubmitted(bound.txHash, bound.txHash)
        return { batchId: bound.txHash, txHash: bound.txHash }
      },
      verify: async () => {
        const { record } = attachSdkReceipt(sdk), result = await recoverBorrowTransaction(sdk.rpc, record)
        return 'proof' in result ? result.proof : null
      },
    }
  }, [])
  return <main className="mx-auto max-w-3xl p-4"><BorrowOperations ports={ports} wallet={{ address: WALLET, chainId: 5042 }} market={MARKET_DATA} positions={[POSITION]} attempts={ports.attempts} /></main>
}
function Workspace() {
  const client = useMemo(() => fakeClient({ getMarket: MARKET_WIRE, getPosition: LOAN_WIRE, getLoans: { loans: [LOAN_WIRE], pagination: {} }, ...Object.fromEntries(Object.entries(METHOD).map(([kind, method]) => [method, RESPONSES[kind]])) }).client, [])
  const request = async ({ method }) => {
    ;(window as any).workspaceReads ??= []; (window as any).workspaceReads.push(method)
    if (method === 'eth_chainId') return '0x13b2'
    if (method === 'eth_accounts') return [WALLET]
    if (method === 'wallet_getCapabilities') {
      if (location.search.includes('eoa=1')) throw Object.assign(Error('not supported'), { code: 4200 })
      return { '0x13b2': { atomic: { status: 'supported' } } }
    }
    throw Error('No wallet write is allowed in this fixture')
  }
  return <BorrowWorkspace walletAddress={WALLET} walletChainId={5042} requestWallet={request} client={client} loadMarkets={async () => ({ status: 'available', markets: [MARKET_DATA] })}
    verifyMarket={async () => ({ ...VERIFIED, details: { ...VERIFIED.details, block: { number: 100n, hash: ('0x' + 'bb'.repeat(32)) as `0x${string}`, timestamp: BigInt(Math.floor(Date.now() / 1000)) } } })}
    readBalances={async () => BALANCES} />
}
createRoot(document.getElementById('root')!).render(location.pathname === '/__borrow_workspace' ? <Workspace /> : location.pathname === '/__borrow_sdk_ui' ? <SdkApp /> : <App />)
