import { useEffect, useMemo, useRef, useState } from 'react'
import { formatUnits } from 'viem'
import { MAINNET_CONFIG } from '../config/mainnet'
import { MAINNET_BORROW_CHAIN_ID } from '../config/mainnetBorrow'
import { createProductionBorrowPorts, detectBorrowAtomicSupport } from '../lib/borrowProduction'
import { browserAttemptStorage } from '../lib/borrowAttemptLedger'
import { browserBorrowLocks } from '../lib/borrowOperationLock'
import { createBorrowOperationController, productionBorrowExecutionBlocker, readBorrowOperation, type BorrowOperationPorts, type BorrowOperationState } from '../lib/borrowOperations'
import { borrowWalletSession, borrowActionAmount, describeBorrowWrite, type BorrowWalletState, type BorrowWriteAction } from '../lib/borrowWriteSafety'
import { detectAtomicBatchCapability, type BorrowMarket, type BorrowPosition, type BorrowReadClient, type Eip1193Request } from '../lib/mainnetBorrow'
import type { BorrowAttemptLedger } from '../lib/borrowAttemptLedger'
import { createViemMarketReader, verifyBorrowMarket, type MarketVerification } from '../lib/borrowMarketVerification'
import { createViemBalanceReader, type WalletBalanceReader } from '../lib/borrowWalletBalances'

const TITLES: Record<BorrowWriteAction['kind'], string> = { borrow: 'Borrow', 'borrow-more': 'Borrow more', repay: 'Repay', 'close-loan': 'Close loan', 'add-collateral': 'Add collateral', 'withdraw-collateral': 'Withdraw collateral' }
const inputStyle = 'w-full rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 focus:outline-none focus:ring-2 focus:ring-[#66D121]'
const buttonStyle = 'rounded-xl bg-[#2F6E0C] px-4 py-2 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-50'
export type GuidedBorrowInput = {
  action: BorrowWriteAction | null
  targetHealthFactor: number
  maxGasCost: string | null
  ready: boolean
}
export type BorrowOperationsProps = {
  wallet: BorrowWalletState | null; market: BorrowMarket | null; positions: BorrowPosition[]; attempts: BorrowAttemptLedger | null
  requestWallet?: Eip1193Request; client?: BorrowReadClient; verifyMarket?: (market: BorrowMarket) => Promise<MarketVerification>; readBalances?: WalletBalanceReader
  // Explicit in-process controlled test seam. Production supplies none; no URL/env/browser flag supplies a transport.
  ports?: BorrowOperationPorts
  onVerified?: () => void
  // In the primary Borrow flow this receives the automatic estimate input;
  // it never reuses the preview's prepared quote as execution authority.
  guidedBorrow?: GuidedBorrowInput | null
}
export function BorrowOperations(props: BorrowOperationsProps) {
  const ref = useRef(props); ref.current = props
  const [kind, setKind] = useState<BorrowWriteAction['kind']>('borrow')
  const [amount, setAmount] = useState(''), [maximum, setMaximum] = useState(''), [target, setTarget] = useState('1.5'), [loanId, setLoanId] = useState('')
  const [state, setState] = useState<BorrowOperationState>({ phase: 'idle', review: null, message: '' })
  const reader = useMemo(() => createViemMarketReader(MAINNET_CONFIG.arcRpcUrl), [])
  const balances = useMemo(() => createViemBalanceReader(MAINNET_CONFIG.arcRpcUrl), [])
  const controller = useMemo(() => {
    if (props.ports) return createBorrowOperationController(props.ports)
    if (!props.attempts) return null
    return createBorrowOperationController(createProductionBorrowPorts({
      attempts: props.attempts, request: () => ref.current.requestWallet, storage: browserAttemptStorage,
      currentOwner: () => ref.current.wallet?.address ?? undefined,
      async readWallet() {
        const current = ref.current
        if (!current.wallet?.address || !current.requestWallet) return null
        try {
          const request = current.requestWallet
          const [chain, accounts] = await Promise.all([request({ method: 'eth_chainId' }), request({ method: 'eth_accounts' })])
          if (chain !== '0x13b2' || !Array.isArray(accounts) || typeof accounts[0] !== 'string' || accounts[0].toLowerCase() !== current.wallet.address.toLowerCase()) return null
          const atomicBatch = await detectBorrowAtomicSupport(request, current.wallet.address as `0x${string}`)
          return { address: current.wallet.address, chainId: MAINNET_BORROW_CHAIN_ID, atomicBatch, atomicBatchFor: borrowWalletSession(current.wallet.address, MAINNET_BORROW_CHAIN_ID) }
        } catch { return null }
      },
      prepare: (action, wallet, hf) => readBorrowOperation(action, wallet, hf, { client: ref.current.client,
        verifyMarket: ref.current.verifyMarket ?? (m => verifyBorrowMarket(m, reader)), balances: ref.current.readBalances ?? balances }),
    }))
  }, [props.attempts, props.ports, reader, balances])
  useEffect(() => {
    setState(controller?.getState() ?? { phase: 'idle', review: null, message: '' })
    return controller?.subscribe(setState)
  }, [controller])
  const guided = props.guidedBorrow
  const guideKey = guided?.action ? JSON.stringify(guided.action) + ':' + guided.targetHealthFactor + ':' + guided.maxGasCost : ''
  useEffect(() => { controller?.invalidate() }, [controller, kind, amount, maximum, target, loanId, props.market?.marketId, props.wallet?.address, props.wallet?.chainId, guideKey])
  const [now, setNow] = useState(Date.now())
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer) }, [])
  const handled = useRef<string | undefined>()
  useEffect(() => {
    if (state.phase === 'verified' && state.txHash && handled.current !== state.txHash) {
      handled.current = state.txHash; ref.current.onVerified?.()
      // Only this controller's submitted amount. Editing invalidates generation; unrelated new inputs are preserved.
      if (state.review && amount === borrowActionAmount(state.review.action) && kind === state.review.action.kind && props.wallet?.address?.toLowerCase() === state.review.wallet.address?.toLowerCase()) setAmount('')
    }
  }, [state.phase, state.txHash, state.review, amount, kind, props.wallet?.address])
  const selected = props.positions.find(p => p.loanId === loanId)
  const loan = selected ?? props.positions[0]
  const operationMarket = kind === 'borrow' ? props.market : props.market?.marketId === loan?.marketId ? props.market : null
  const action = (): BorrowWriteAction | null => {
    if (kind === 'borrow') return props.market ? { kind, marketId: props.market.marketId, borrowAmount: amount } : null
    if (!loan) return null
    if (kind === 'borrow-more') return { kind, loanId: loan.loanId, borrowAmount: amount }
    if (kind === 'repay') return { kind, loanId: loan.loanId, repayAmount: amount }
    if (kind === 'close-loan') return { kind, loanId: loan.loanId }
    return { kind, loanId: loan.loanId, collateralAmount: amount }
  }
  const description = state.review ? describeBorrowWrite(state.review.action, state.review.prepared.quote) : null
  const quote = state.review?.prepared.quote
  const gas = quote && 'gasFees' in quote ? quote.gasFees.reduce((sum, f) => sum + BigInt(f.feeWei), 0n) : null
  const expired = state.review ? now >= state.review.expiresAt : false
  const blocked = props.ports ? props.ports.executionBlocker() : productionBorrowExecutionBlocker(props.wallet?.address)
  const busy = ['quoting', 'checking', 'wallet', 'pending', 'unknown'].includes(state.phase)
  const history = props.attempts?.list() ?? props.ports?.attempts.list() ?? []
  const guidedReady = Boolean(guided?.ready && guided.action && guided.maxGasCost && !blocked && !busy)
  const guidedTitle = guided?.action?.kind === 'borrow-more' ? 'Review Borrow more' : 'Review Borrow'
  return <section className={guided ? 'mt-4 min-w-0 border-t border-slate-200 pt-4' : 'min-w-0 rounded-2xl border border-slate-200 bg-white p-4 sm:p-6'} data-borrow-operations data-phase={state.phase}>
    {guided ? (
      <div data-borrow-guided-flow className="space-y-2">
        <h3 className="text-sm font-semibold text-slate-900">Borrow review</h3>
        <p className="text-xs leading-5 text-slate-600">The estimated fee and maximum budget are calculated automatically. Review refreshes the market, wallet, quote and gas checks; nothing is signed until you explicitly confirm.</p>
        {guided.maxGasCost
          ? <p className="text-xs text-slate-600" data-borrow-auto-gas>Maximum fee budget: {guided.maxGasCost} native USDC (automatic, not the expected fee).</p>
          : <p className="text-xs text-amber-800" data-borrow-auto-gas-unavailable>Automatic gas budget unavailable or above the 0.25 USDC safety ceiling. Refresh the estimate or use Advanced loan actions.</p>}
        <button className={buttonStyle} disabled={!controller || !guidedReady} onClick={() => {
          const request = guided?.action
          if (request && guided?.ready && guided.maxGasCost) void controller?.prepare(request, guided.targetHealthFactor, guided.maxGasCost)
        }}>{guidedTitle}</button>
        {!guided.ready && <p className="text-xs text-slate-500" data-borrow-guided-wait>Enter a valid amount and complete the automatic safety checks before reviewing.</p>}
      </div>
    ) : <div>
      <div className="flex flex-wrap items-center justify-between gap-2"><h2 className="font-semibold text-slate-900">Review loan actions</h2><span className="rounded-full bg-amber-50 px-3 py-1 text-xs text-amber-900">{blocked ? 'Transactions closed' : 'Review before wallet confirmation'}</span></div>
      <p className="mt-2 text-xs leading-5 text-slate-600">Prepare a current review for any loan action. Reviewing never requests an approval, signature or transaction.</p>
    </div>}
    {!props.ports && !blocked && <p className="mt-2 text-xs leading-5 text-amber-800">Controlled canary for the approved wallet. Address restriction is not identity authentication. Each operation must still pass independent checks and your explicit wallet confirmation; live Borrow and full exit are not yet verified.</p>}
    {guided ? <details id="borrow-advanced-operations" className="mt-3 rounded-xl border border-slate-200 p-3 text-sm">
      <summary className="cursor-pointer font-medium text-slate-700">Advanced loan actions · repay, close loan and manual review</summary>
      <div className="mt-3">
    <div className="mt-4 grid gap-3 sm:grid-cols-2">
      <label className="text-xs font-medium text-slate-600">Action<select aria-label="Borrow action" value={kind} onChange={e => setKind(e.target.value as BorrowWriteAction['kind'])} className={inputStyle} disabled={busy}>{Object.entries(TITLES).map(([value, title]) => <option value={value} key={value}>{title}</option>)}</select></label>
      {kind === 'borrow' ? <div className="text-xs leading-6 text-slate-600">Morpho market: {operationMarket ? `${operationMarket.collateralAsset.symbol} / ${operationMarket.loanAsset.symbol}` : 'Choose a market above'}<br />Via Circle Borrow Kit{operationMarket && ` · LLTV ${operationMarket.lltv === null ? 'Not reported' : (operationMarket.lltv * 100).toFixed(2) + '%'} · Variable APY ${operationMarket.borrowApy === null ? 'Not reported' : (operationMarket.borrowApy * 100).toFixed(2) + '%'}`}</div>
        : <label className="text-xs font-medium text-slate-600">Position<select aria-label="Borrow position" className={inputStyle} value={loan?.loanId ?? ''} onChange={e => setLoanId(e.target.value)} disabled={busy}>{!props.positions.length && <option value="">No position available</option>}{props.positions.map(p => <option value={p.loanId} key={p.loanId}>{p.loanId.slice(0, 8)} · debt {p.borrowed?.amount ?? 'Not reported'} {p.borrowed?.token ?? ''}</option>)}</select></label>}
      {kind !== 'close-loan' && <label className="text-xs font-medium text-slate-600">{kind === 'add-collateral' || kind === 'withdraw-collateral' ? 'Collateral amount' : 'Loan token amount'}<input aria-label="Operation amount" className={inputStyle} value={amount} onChange={e => setAmount(e.target.value)} inputMode="decimal" disabled={busy} /></label>}
      <label className="text-xs font-medium text-slate-600">Maximum gas cost (native USDC)<input aria-label="Maximum gas cost" className={inputStyle} value={maximum} onChange={e => setMaximum(e.target.value)} inputMode="decimal" placeholder="Your cost limit" disabled={busy} /></label>
      {(kind === 'borrow' || kind === 'borrow-more' || kind === 'withdraw-collateral') && <label className="text-xs font-medium text-slate-600">Minimum resulting health factor<input aria-label="Operation health factor" className={inputStyle} value={target} onChange={e => setTarget(e.target.value)} inputMode="decimal" disabled={busy} /></label>}
    </div>
    <p className="mt-3 text-xs leading-5 text-slate-600">Liquidation can occur if collateral value falls or debt grows. Approvals, when needed, are exact amounts. Morpho authorization must be granted and revoked in the same atomic batch; an existing larger token allowance is not a new exact approval.</p>
    <button className={buttonStyle + ' mt-4'} disabled={!controller || busy || !action()} onClick={() => { const value = action(); if (value) void controller?.prepare(value, Number(target), maximum) }}>Get operation review</button>
      </div>
    </details> : <>
    <div className="mt-4 grid gap-3 sm:grid-cols-2">
      <label className="text-xs font-medium text-slate-600">Action<select aria-label="Borrow action" value={kind} onChange={e => setKind(e.target.value as BorrowWriteAction['kind'])} className={inputStyle} disabled={busy}>{Object.entries(TITLES).map(([value, title]) => <option value={value} key={value}>{title}</option>)}</select></label>
      {kind === 'borrow' ? <div className="text-xs leading-6 text-slate-600">Morpho market: {operationMarket ? `${operationMarket.collateralAsset.symbol} / ${operationMarket.loanAsset.symbol}` : 'Choose a market above'}<br />Via Circle Borrow Kit{operationMarket && ` · LLTV ${operationMarket.lltv === null ? 'Not reported' : (operationMarket.lltv * 100).toFixed(2) + '%'} · Variable APY ${operationMarket.borrowApy === null ? 'Not reported' : (operationMarket.borrowApy * 100).toFixed(2) + '%'}`}</div>
        : <label className="text-xs font-medium text-slate-600">Position<select aria-label="Borrow position" className={inputStyle} value={loan?.loanId ?? ''} onChange={e => setLoanId(e.target.value)} disabled={busy}>{!props.positions.length && <option value="">No position available</option>}{props.positions.map(p => <option value={p.loanId} key={p.loanId}>{p.loanId.slice(0, 8)} · debt {p.borrowed?.amount ?? 'Not reported'} {p.borrowed?.token ?? ''}</option>)}</select></label>}
      {kind !== 'close-loan' && <label className="text-xs font-medium text-slate-600">{kind === 'add-collateral' || kind === 'withdraw-collateral' ? 'Collateral amount' : 'Loan token amount'}<input aria-label="Operation amount" className={inputStyle} value={amount} onChange={e => setAmount(e.target.value)} inputMode="decimal" disabled={busy} /></label>}
      <label className="text-xs font-medium text-slate-600">Maximum gas cost (native USDC)<input aria-label="Maximum gas cost" className={inputStyle} value={maximum} onChange={e => setMaximum(e.target.value)} inputMode="decimal" placeholder="Your cost limit" disabled={busy} /></label>
      {(kind === 'borrow' || kind === 'borrow-more' || kind === 'withdraw-collateral') && <label className="text-xs font-medium text-slate-600">Minimum resulting health factor<input aria-label="Operation health factor" className={inputStyle} value={target} onChange={e => setTarget(e.target.value)} inputMode="decimal" disabled={busy} /></label>}
    </div>
    <p className="mt-3 text-xs leading-5 text-slate-600">Liquidation can occur if collateral value falls or debt grows. Approvals, when needed, are exact amounts. Morpho authorization must be granted and revoked in the same atomic batch; an existing larger token allowance is not a new exact approval.</p>
    <button className={buttonStyle + ' mt-4'} disabled={!controller || busy || !action()} onClick={() => { const value = action(); if (value) void controller?.prepare(value, Number(target), maximum) }}>Get operation review</button>
    </>}
    {state.message && state.phase !== 'idle' && <p role="status" className="mt-3 break-words text-sm leading-6 text-slate-700">{state.message}</p>}
    {state.review && description && <div role="region" aria-label="Borrow review" className="mt-4 rounded-xl border border-slate-200 bg-slate-50 p-4">
      <h3 className="font-semibold text-slate-900">{description.title} review</h3>
      <dl className="mt-3 space-y-2 break-words text-sm">
        <div><dt>Wallet / recipient</dt><dd className="break-all">{state.review.wallet.address}</dd></div>
        <div><dt>Market</dt><dd className="break-all">{state.review.evidence.market?.data.marketId}</dd></div>
        {description.movements.map((m, i) => <div key={i} className="flex flex-wrap justify-between gap-2"><dt>{m.label}</dt><dd className="font-medium tabular-nums">{m.ceiling ? 'Up to ' : ''}{m.amount.amount} {m.amount.token}</dd></div>)}
        <div><dt>Estimated resulting health factor</dt><dd>{quote?.resultingHealthFactor ?? 'Not reported'}</dd></div>
        <div><dt>Circle quote gas estimate</dt><dd>{gas === null ? 'Not reported' : `${formatUnits(gas, 18)} USDC`}</dd></div>
        {state.rpcEstimatedFeeWei !== undefined && <div><dt>Atomic batch RPC fee estimate</dt><dd>{formatUnits(state.rpcEstimatedFeeWei, 18)} USDC</dd></div>}
        {state.requestFeeCeilingWei !== undefined && <div><dt>Maximum fee requested from wallet</dt><dd>{formatUnits(state.requestFeeCeilingWei, 18)} USDC</dd></div>}
        {state.executionDeadlineMs !== undefined && <div><dt>On-chain execution deadline (UTC)</dt><dd>{new Date(state.executionDeadlineMs).toISOString()}</dd></div>}
        <div><dt>Your maximum gas budget</dt><dd>{formatUnits(state.review.maxGasCostWei, 18)} USDC — reject a higher fee in your wallet; unsupported fee transports are blocked</dd></div>
        <div><dt>Service fees</dt><dd>{description.fees.length ? description.fees.map(f => `${f.amount.amount} ${f.amount.token} (${f.type})`).join(', ') : 'None reported in this quote'}</dd></div>
        <div><dt>Quote validity</dt><dd>{expired ? 'Expired — request a new review' : `${Math.max(0, Math.ceil((state.review.expiresAt - now) / 1000))} seconds`}</dd></div>
      </dl>
      <p className="mt-3 text-xs leading-5 text-slate-600">Check final amounts, recipient and additional fees in your wallet. A browser extension may modify a request after this review. The actual signed batch must pass independent decoding and atomic simulation before the wallet is requested. Wallet edits can still change what is signed. Reject a delayed wallet request after expiry: an expired execution can revert and still spend gas; this page cannot cancel it.</p>
      <button className={buttonStyle + ' mt-3'} disabled={Boolean(blocked) || expired || state.phase !== 'review'} onClick={() => void controller?.confirm()}>Confirm {description.title}</button>
    </div>}
    {state.txHash && <p className="mt-3 break-all text-xs"><a target="_blank" rel="noreferrer" href={`https://arcscan.app/tx/${state.txHash}`}>View transaction {state.txHash}</a></p>}
    {state.actualGasWei !== undefined && <p className="mt-2 text-sm">Actual verified gas cost: {formatUnits(state.actualGasWei, 18)} USDC</p>}
    {history.length > 0 && <details className="mt-4 text-xs"><summary>Unresolved operation history ({history.length})</summary>{history.map(row => <div key={row.scopeId} className="mt-2 break-all">{row.kind}: {row.status}{row.batchId && ` · batch ${row.batchId}`}{row.txHash && <a href={`https://arcscan.app/tx/${row.txHash}`} target="_blank" rel="noreferrer"> · Explorer</a>}<p>Do not resubmit an unresolved operation. A new position timestamp alone cannot unlock it.</p><button className="mt-2 underline" onClick={() => void controller?.recover(row.scopeId)}>Recheck on-chain status</button>{['verified', 'failed'].includes(state.phase) && state.txHash === row.txHash && <button className="ml-3 underline" onClick={() => { void controller?.acknowledge(row.scopeId).then(ok => { if (ok) setNow(Date.now()) }) }}>Acknowledge verified result</button>}</div>)}</details>}
  </section>
}
