// Real BorrowKit -> real BorrowServiceProvider -> real alias /next adapter -> bounded wallet facade.
// Only HTTP envelopes, RPC and the EIP-1193 wallet are synthetic. No external request or real key/signature.
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
const require = createRequire(import.meta.url), ts = require('typescript')
require.extensions['.ts'] = (m, p) => m._compile(ts.transpileModule(readFileSync(p, 'utf8').replace(/import\.meta\.env/g, '({})'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText, p)
const { BorrowKit } = require('@circle-fin/borrow-kit'), { BorrowServiceProvider } = require('@circle-fin/provider-borrow-service')
const { encodeAbiParameters, encodeFunctionResult, parseAbiParameters, decodeFunctionData, parseAbi, toHex, encodeEventTopics } = require('viem')
const f = require('./fixtures/borrow/operations.ts'), b = require('./fixtures/borrow/batch.ts')
const t = require('../src/lib/borrowSdkTransport.ts'), r = require('../src/lib/borrowRecovery.ts'), policy = require('../src/lib/borrowBatchPolicy.ts'), safety = require('../src/lib/borrowWriteSafety.ts')
const ops = require('../src/lib/borrowOperations.ts')
const BLUE = '0x34cd04070dd72b14e241112f6d83812df5af7fcd', ADAPTER = '0x7FB8c7260b63934d8da38aF902f87ae6e284a845'
const HASH = '0x' + 'aa'.repeat(32), BLOCK = '0x' + 'bb'.repeat(32), owner = f.WALLET
const stateAbi = parseAbi(['function price() view returns(uint256)', 'function accrueInterest((address loanToken,address collateralToken,address oracle,address irm,uint256 lltv) params)', 'function isAuthorized(address owner,address authorized) view returns(bool)'])
let count = 0, external = 0
async function test(name, run) { await run(); count++; console.log('PASS ' + name) }
async function setup(kind = 'borrow', initialMode = '', canary = false) {
  const owner = canary ? require('../src/config/borrowCanary.ts').BORROW_CANARY.wallet.toLowerCase() : f.WALLET
  let mode = initialMode
  const built = await f.build(kind, d => { if (mode === 'full-repay') { d.action.repayAmount = '1000.25'; d.response.repayAmount.amount = '1000.25' } }), now = Date.now(); built.context.quote.fetchedAt = now
  if (canary) {
    const rebind = value => typeof value === 'string' ? value.replaceAll(f.WALLET, owner) : Array.isArray(value) ? value.map(rebind) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([k,v]) => [k,rebind(v)])) : value
    built.context = rebind(built.context)
  }
  const review = { action: built.action, prepared: built.context.quote, evidence: built.context.evidence, wallet: built.context.wallet, expiresAt: now + 60000, actionId: safety.borrowActionId(built.action, owner), maxGasCostWei: 10n ** 18n }
  const x = b.batchFixture(kind, now, review.prepared, owner)
  const before = { collateral: kind === 'borrow' ? 0n : 5000000n, debtShares: kind === 'borrow' ? 0n : 1000250000000000n }
  const borrowShares = x.review.borrowAssets * 1000000n, repayAssets = kind === 'close-loan' ? before.debtShares / 1000000n : x.review.repayAssets
  const repayShares = kind === 'close-loan' ? before.debtShares : repayAssets * 1000000n
  if (kind === 'close-loan' || mode === 'full-repay') { x.review.repayShares = before.debtShares; const leg = x.params.instructions[0]; leg.data = require('viem').encodeFunctionData({ abi: policy.BORROW_MORPHO_ABI, functionName: 'repay', args: [x.review.market, 0n, before.debtShares, owner, '0x'] }) }
  const after = { collateral: before.collateral + x.review.collateralIn - x.review.collateralOut, debtShares: before.debtShares + borrowShares - repayShares }
  const walletRequests = [], persisted = [], storage = f.fakeStorage(), store = r.createBorrowRecoveryStore(storage, owner); let currentBound, mined = false, hashCallbacks = 0
  const block = { number: 100n, hash: BLOCK, timestamp: BigInt(Math.floor(now / 1000)), baseFeePerGas: 25000000000n }
  const request = async ({ method, params }) => {
    walletRequests.push({ method, params })
    if (method === 'eth_chainId') {
      if (mode === 'expire-final-wallet-read' && persisted.length) review.expiresAt = Date.now() - 1
      return '0x13b2'
    }
    if (method === 'eth_accounts') return [owner]
    if (method === 'wallet_getCapabilities') {
      if (mode === 'atomic-wallet') return { '0x13b2': { atomic: { status: 'supported' } } }
      throw Object.assign(Error('unsupported'), { code: 4200 })
    }
    if (method === 'eth_getTransactionCount') return mode === 'wallet-nonce' ? '0x8' : '0x7'
    if (method === 'eth_sendTransaction') { if (mode === 'send-rpc-error') throw Object.assign(Error('Temporary provider connection failure'), { code: -32603 }); if (mode === 'reject') throw Object.assign(Error('declined'), { code: 4001 }); mined = true; return HASH }
    throw Error('Unexpected wallet method ' + method)
  }
  const price = 8140086n * 10n ** 32n
  const rpc = {
    getChainId: async () => 5042, getBlock: async ({ blockNumber } = {}) => ({ ...block, number: blockNumber ?? 100n, hash: mode === 'reorg' ? '0x' + 'dd'.repeat(32) : blockNumber === 101n ? '0x' + 'cc'.repeat(32) : BLOCK }), getBlockNumber: async () => 102n,
    getCode: async ({ address }) => address.toLowerCase() === owner.toLowerCase() ? '0x' : '0x6000',
    getBalance: async () => mode === 'balance' ? 0n : 10n ** 25n, getGasPrice: async () => mode === 'fee' ? 10n ** 20n : 25000000000n,
    getTransactionCount: async () => mode === 'pending' ? 8 : 7,
    readContract: async ({ functionName, address, blockNumber }) => {
      if (functionName === 'allowance') return 0n
      if (functionName === 'decimals') return address.toLowerCase() === x.review.market.loanToken.toLowerCase() ? 6 : 8
      if (functionName === 'isAuthorized') return false
      if (functionName === 'balanceOf') return 10n ** 25n
      if (functionName === 'position') return [0n, before.debtShares, before.collateral]
      if (functionName === 'market') return [10n ** 14n, 10n ** 20n, 10n ** 12n, 10n ** 18n, block.timestamp, 0n]
      if (functionName === 'price') return price
      throw Error('Unexpected read ' + functionName)
    },
    call: async ({ data, blockNumber }) => {
      assert.ok(blockNumber === 100n || blockNumber === 101n)
      if (mode === 'simulation') throw Error('signed execution reverted')
      const decoded = decodeFunctionData({ abi: t.BORROW_AGGREGATE_ABI, data }), calls = decoded.args[0]
      const returns = calls.map((c, i) => {
        if (c.callData.startsWith('0x5c60da1b')) throw Error('Unexpected implementation')
        const selector = c.callData.slice(0, 10)
        for (const [abi, functionName, value] of [[t.BORROW_CHAIN_ABI, 'market', [10n ** 14n, 10n ** 20n, 10n ** 12n, 10n ** 18n, block.timestamp, 0n]], [t.BORROW_CHAIN_ABI, 'position', [0n, mode === 'reverted' ? before.debtShares : after.debtShares, mode === 'reverted' ? before.collateral : after.collateral]], [stateAbi, 'price', price], [stateAbi, 'isAuthorized', false]]) {
          const name = require('viem').toFunctionSelector(abi.find(a => a.name === functionName))
          if (selector === name) return { success: true, returnData: encodeFunctionResult({ abi, functionName, result: value }) }
        }
        return { success: true, returnData: '0x' }
      })
      return { data: encodeFunctionResult({ abi: t.BORROW_AGGREGATE_ABI, functionName: 'aggregate3', result: returns }) }
    },
    estimateGas: async ({ blockNumber }) => { if (blockNumber !== undefined) assert.equal(blockNumber, 100n); return 400000n },
    waitForTransactionReceipt: async () => { if (mode === 'timeout') throw Error('controlled timeout'); return { status: 'success', logs: [] } },
  }
  const transport = t.createBorrowSdkTransport({ review, request, client: rpc, requireCanary: canary, isCurrent: () => mode !== 'context-changed', persist: record => { if (mode === 'storage-after-hash' && record.txHash) throw Error('controlled storage failure'); store.save(record); currentBound = structuredClone(record); persisted.push(currentBound) }, submitted: h => { hashCallbacks++; assert.equal(h, HASH) } })
  const signed = { loanId: '11111111-1111-4111-8111-111111111111', chain: 'Arc', executionParams: x.params, signature: '0x' + '11'.repeat(65) }
  const client = new BorrowKit({ disableAnalytics: true, disableErrorReporting: true, providers: [new BorrowServiceProvider()] })
  const serviceRequests = []
  const previousFetch = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    const u = new URL(String(url)); serviceRequests.push(u.pathname)
    if (u.hostname !== 'api.circle.com' || !u.pathname.startsWith('/v1/borrowKit/loans/')) { external++; throw Error('Unexpected service endpoint') }
    if (!u.pathname.endsWith('/quote')) {
      if (!/\/(borrow|repay|closeLoan|addCollateral|withdrawCollateral)$/.test(u.pathname)) { external++; throw Error('Unexpected signed endpoint') }
      const data = { ...signed, chain: 'ARC', execId: '1', fees: [] }
      if (kind === 'withdraw-collateral') delete data.chain
      return new Response(JSON.stringify({ data }, (_k, v) => typeof v === 'bigint' ? v.toString() : v), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    const quote = { ...structuredClone(f.RESPONSES[kind]), chain: 'ARC' }, native = amount => ({ token: 'USDC', tokenAddress: x.review.market.loanToken, amount, decimals: 18 })
    if (mode === 'full-repay') quote.repayAmount.amount = '1000.25'
    quote.gasFees = ['Approve', 'Borrow', 'Repay', 'CloseLoan', 'SupplyCollateral', 'WithdrawCollateral'].map(name => ({ name, fees: { gas: '400000', gasPrice: native('0.000000025'), fee: native('0.01') } }))
    if (quote.bundledRepayment) quote.repayAmount = quote.bundledRepayment
    return new Response(JSON.stringify({ data: quote }), { status: 200, headers: { 'content-type': 'application/json' } })
  }
  const run = async () => {
    const from = { chain: 'Arc', adapter: transport.adapter }
    try {
      if (kind === 'borrow' || kind === 'borrow-more') return await client.borrow({ from, ...(kind === 'borrow' ? { marketId: x.review.marketId } : { loanId: signed.loanId }), borrowAmount: '1000' })
      if (kind === 'repay') return await client.repay({ from, loanId: signed.loanId, repayAmount: review.action.repayAmount })
      if (kind === 'close-loan') return await client.closeLoan({ from, loanId: signed.loanId })
      if (kind === 'add-collateral') return await client.addCollateral({ from, loanId: signed.loanId, collateralAmount: '0.01' })
      return await client.withdrawCollateralRepayIfNeeded({ from, loanId: signed.loanId, collateralAmount: '0.01' })
    } finally { globalThis.fetch = previousFetch }
  }
  return { context: built.context, serviceRequests, storage, store, callbacks: () => hashCallbacks, setMode: m => { mode = m }, borrowShares, repayShares, repayAssets, run, transport, walletRequests, persisted, getBound: () => currentBound, x, rpc, request, before, after, review, mined: () => mined }
}
for (const kind of Object.keys(f.ACTIONS)) await test(kind + ': actual SDK builds the validated atomic batch and the wallet receives bounded gas/fee/nonce', async () => {
  const s = await setup(kind); await s.run(); const sends = s.walletRequests.filter(r => r.method === 'eth_sendTransaction')
  assert.equal(sends.length, 1); const tx = sends[0].params[0], record = s.getBound()
  assert.equal(tx.to.toLowerCase(), t.BORROW_BATCHER.toLowerCase()); assert.equal(tx.nonce, '0x7')
  assert.ok(BigInt(tx.gas) * BigInt(tx.maxFeePerGas) <= 10n ** 18n)
  assert.equal(policy.borrowBatchCommitment(t.decodeBorrowAggregate(tx.data)), record.callsHash)
  assert.ok(s.serviceRequests.some(p => !p.endsWith('/quote')), 'the actual SDK fetched and validated the signed HTTP envelope, no resume fixture bypass')
  assert.equal(record.txHash, HASH); assert.ok(s.persisted.length >= 2)
})
for (const kind of Object.keys(f.ACTIONS)) await test(kind + ': attested approved-wallet canary crosses the closed public SDK gate with all normal checks', async () => {
  const s = await setup(kind, '', true), main = require('../src/lib/mainnetBorrow.ts')
  const canaryOwner = s.review.wallet.address
  assert.equal(t.borrowCanaryAdapterOwner(s.transport.adapter), canaryOwner.toLowerCase())
  const attempts = f.persistent(s.storage, 'canary', canaryOwner)
  const result = await main.executeBorrowWrite({ canaryAdapter: s.transport.adapter, action: s.review.action, reviewedQuote: s.review.prepared,
    confirmedActionId: safety.borrowActionId(s.review.action, canaryOwner), readWallet: async () => s.review.wallet,
    refresh: async () => ({ quote: s.review.prepared, evidence: s.review.evidence }), getAdapter: async () => s.transport.adapter,
    attempts, client: Object.fromEntries(main.MAINNET_BORROW_WRITE_METHODS.map(k => [k, s.run])) })
  assert.notEqual(result.status, 'refused', JSON.stringify(result))
  assert.equal(s.walletRequests.filter(r => r.method === 'eth_sendTransaction').length, 1)
})
await test('forged canary adapters and another wallet cannot cross the public gate or request a transaction', async () => {
  const s = await setup('borrow', '', true), main = require('../src/lib/mainnetBorrow.ts')
  assert.equal(t.borrowCanaryAdapterOwner({ ...s.transport.adapter }), null)
  const request = { canaryAdapter: { ...s.transport.adapter }, readWallet: async () => { throw Error('must not read') } }
  assert.equal((await main.executeBorrowWrite(request)).status, 'refused')
  const result = await main.executeBorrowWrite({ canaryAdapter: s.transport.adapter, action: s.review.action,
    readWallet: async () => ({ ...s.review.wallet, address: f.WALLET }), attempts: f.persistent(s.storage), getAdapter: async () => s.transport.adapter })
  assert.equal(result.status, 'refused'); assert.equal(s.walletRequests.length, 0)
})
for (const mode of ['fee', 'wallet-nonce', 'pending', 'balance', 'simulation', 'atomic-wallet', 'context-changed']) await test('approved-wallet canary still refuses ' + mode + ' before sending', async () => {
  const s = await setup('borrow', mode, true); await assert.rejects(s.run()); assert.equal(s.walletRequests.filter(r => r.method === 'eth_sendTransaction').length, 0)
})
for (const mode of ['fee', 'wallet-nonce', 'pending', 'balance', 'simulation', 'atomic-wallet', 'context-changed']) await test(mode + ': real SDK stops before any wallet transaction', async () => {
  const s = await setup('borrow', mode); await assert.rejects(s.run()); assert.equal(s.walletRequests.filter(r => r.method === 'eth_sendTransaction').length, 0)
})
await test('actual SDK timeout preserves the early hash and never emits a second transaction', async () => {
  const s = await setup('borrow', 'timeout'); await s.run(); assert.equal(s.getBound().txHash, HASH); assert.equal(s.walletRequests.filter(r => r.method === 'eth_sendTransaction').length, 1)
})
await test('actual provider rejection is never automatically resubmitted', async () => {
  const s = await setup('borrow', 'reject'); await assert.rejects(s.run()); assert.equal(s.walletRequests.filter(r => r.method === 'eth_sendTransaction').length, 1)
  assert.equal(s.transport.sealUnsent().basis, 'provider-user-rejected')
})

function attachReceipt(s, status = 'success') {
  const record = s.getBound(), tx = s.walletRequests.find(x => x.method === 'eth_sendTransaction').params[0], logs = []
  const event = (address, name, args) => {
    const abi = r.BORROW_RECOVERY_ABI, def = abi.find(x => x.name === name)
    logs.push({ address, topics: encodeEventTopics({ abi, eventName: name, args }), data: encodeAbiParameters(def.inputs.filter(x => !x.indexed), def.inputs.filter(x => !x.indexed).map(x => args[x.name])), logIndex: logs.length, removed: false, transactionHash: HASH, blockNumber: 101n, blockHash: '0x' + 'cc'.repeat(32) })
  }
  const base = { id: record.terms.marketId, caller: ADAPTER, onBehalf: owner, receiver: ADAPTER }
  if (status === 'success') {
    if (record.terms.collateralIn) event(BLUE, 'SupplyCollateral', { ...base, assets: record.terms.collateralIn })
    if (record.terms.borrowAssets) event(BLUE, 'Borrow', { ...base, assets: record.terms.borrowAssets, shares: s.borrowShares })
    if (record.terms.repayAssets) event(BLUE, 'Repay', { ...base, assets: s.repayAssets, shares: s.repayShares })
    if (record.terms.collateralOut) event(BLUE, 'WithdrawCollateral', { ...base, assets: record.terms.collateralOut })
    const transfer = (token, from, to, value) => { if (value) event(token, 'Transfer', { from, to, value }) }
    transfer(record.terms.market.collateralToken, owner, ADAPTER, record.terms.collateralIn)
    transfer(record.terms.market.collateralToken, ADAPTER, owner, record.terms.collateralOut)
    transfer(record.terms.market.loanToken, owner, ADAPTER, record.terms.repayAssets)
    transfer(record.terms.market.loanToken, ADAPTER, owner, record.terms.repayAssets - s.repayAssets)
    transfer(record.terms.market.loanToken, ADAPTER, owner, record.terms.borrowAssets)
  }
  const receipt = { from: owner, to: t.BORROW_BATCHER, transactionHash: HASH, blockNumber: 101n, blockHash: '0x' + 'cc'.repeat(32), gasUsed: 300000n, effectiveGasPrice: 25000000000n, status, logs }
  s.rpc.getTransactionReceipt = async () => receipt
  s.rpc.getTransaction = async () => ({ hash: HASH, blockNumber: 101n, blockHash: '0x' + 'cc'.repeat(32), from: owner, to: tx.to, input: tx.data, gas: BigInt(tx.gas), maxFeePerGas: BigInt(tx.maxFeePerGas), chainId: 5042, value: 0n, nonce: 7 })
  return { record, receipt }
}
for (const kind of Object.keys(f.ACTIONS)) await test(kind + ': independent recovery verifies receipt, transfer/Morpho logs and pinned accrued position', async () => {
  const s = await setup(kind); await s.run(); const { record } = attachReceipt(s)
  const result = await r.recoverBorrowTransaction(s.rpc, record)
  assert.equal(result.status, 'verified'); assert.equal(result.proof.gasCostWei, 7500000000000000n)
  const reloaded = r.createBorrowRecoveryStore(s.storage, owner); assert.equal(reloaded.get(record.scopeId).txHash, HASH)
  const again = await r.recoverBorrowTransaction(s.rpc, reloaded.get(record.scopeId)); assert.equal(again.status, 'verified')
})
for (const mode of ['rpc-error','missing-receipt','reorg','calldata','gas','wrong-event','wrong-transfer','wrong-tx-hash','foreign-log','missing-chain-id']) await test(mode + ': recovery cannot falsely claim a verified result', async () => {
  const s = await setup(); await s.run(); const { record, receipt } = attachReceipt(s)
  if (mode === 'rpc-error') s.rpc.getTransactionReceipt = async () => { throw Error('private timeout') }
  if (mode === 'missing-receipt') s.rpc.getTransactionReceipt = async () => { const e = Error('not found'); e.name = 'TransactionReceiptNotFoundError'; throw e }
  if (mode === 'reorg') s.setMode('reorg')
  if (mode === 'calldata' || mode === 'gas') { const original = s.rpc.getTransaction; s.rpc.getTransaction = async () => { const tx = await original(); if (mode === 'calldata') tx.input += '00'; else tx.maxFeePerGas *= 10n; return tx } }
  if (mode === 'missing-chain-id') { const read = s.rpc.getTransaction; s.rpc.getTransaction = async () => ({ ...await read(), chainId: undefined }) }
  if (mode === 'wrong-tx-hash') { const read = s.rpc.getTransaction; s.rpc.getTransaction = async () => ({ ...await read(), hash: '0x' + 'ee'.repeat(32) }) }
  if (mode === 'foreign-log') receipt.logs[0].transactionHash = '0x' + 'ee'.repeat(32)
  if (mode === 'wrong-event') receipt.logs.shift()
  if (mode === 'wrong-transfer') receipt.logs.pop()
  const result = await r.recoverBorrowTransaction(s.rpc, record); assert.ok(!['verified','failed'].includes(result.status))
})
await test('reverted receipt is independently failed with gas, not SDK confirmed', async () => {
  const s = await setup(); await s.run(); s.setMode('reverted'); const { record } = attachReceipt(s, 'reverted')
  assert.equal((await r.recoverBorrowTransaction(s.rpc, record)).status, 'failed')
})
await test('a signature or calldata cannot be accidentally added to persistent recovery metadata', async () => {
  const s = await setup(); await s.run(); const record = s.getBound()
  assert.throws(() => s.store.save({ ...record, signature: 'SECRET' }))
  assert.throws(() => s.store.save({ ...record, before: { ...record.before, calldata: 'SECRET' } }))
  for (const text of s.storage.data.values()) assert.ok(!text.includes('SECRET'))
})
await test('storage failure after a returned hash never hides the hash or resends', async () => {
  const s = await setup('borrow', 'storage-after-hash'); await s.run()
  assert.equal(s.transport.getBound().txHash, HASH); assert.equal(s.callbacks(), 1)
  assert.equal(s.walletRequests.filter(r => r.method === 'eth_sendTransaction').length, 1)
})
for (const mutation of ['target','amount','sweep','extra-call']) await test('real SDK signed-envelope manipulation: ' + mutation + ' stops before wallet', async () => {
  const s = await setup()
  if (mutation === 'target') s.x.params.instructions[0].target = owner
  if (mutation === 'amount') s.x.params.instructions[0].amountToApprove++
  if (mutation === 'sweep') s.x.params.tokens[0].beneficiary = '0x' + '22'.repeat(20)
  if (mutation === 'extra-call') s.x.params.instructions.push({ ...s.x.params.instructions[0] })
  await assert.rejects(s.run()); assert.equal(s.walletRequests.filter(x => x.method === 'eth_sendTransaction').length, 0)
})
await test('wired production submit is independently closed before any SDK, RPC or wallet request', async () => {
  const production = require('../src/lib/borrowProduction.ts')
  const ports = production.createProductionBorrowPorts({ currentOwner: () => undefined, attempts: f.persistent(f.fakeStorage()), storage: () => f.fakeStorage(), request: () => { throw Error('must not read') }, readWallet: async () => { throw Error('must not read') }, prepare: async () => { throw Error('must not read') } })
  await assert.rejects(ports.submit({}, () => {}), /closed/)
})

await test('unsent evidence seals the transport; fabricated evidence cannot release a failed attempt', async () => {
  const { createBorrowSubmissionGuard } = require('../src/lib/borrowSubmissionGuard.ts')
  const x = await f.build('borrow'), attempts = f.persistent(f.fakeStorage()), scope = safety.borrowAttemptScope(x.action, owner)
  const binding = { owner: owner.toLowerCase(), scopeId: scope, actionId: safety.borrowActionId(x.action, owner), idempotencyKey: '33333333-3333-4333-8333-333333333333' }
  assert.equal(attempts.begin({ scopeId: binding.scopeId, actionId: binding.actionId, kind: 'borrow', idempotencyKey: binding.idempotencyKey }, Date.now()), true); attempts.finish(scope, 'failed', Date.now())
  attempts.discard(scope, { ...binding }); assert.ok(attempts.get(scope))
  const guard = createBorrowSubmissionGuard(binding), proof = guard.sealUnsent()
  assert.throws(() => guard.check()); assert.throws(() => guard.markRequested())
  attempts.discard(scope, proof); assert.equal(attempts.get(scope), null)
  const submitted = createBorrowSubmissionGuard(binding); submitted.markRequested(); assert.equal(submitted.sealUnsent(), null)
})
await test('known unsent failure returns to a fresh review instead of locking an unsent transaction as unknown', async () => {
  const x = await f.build('borrow'), attempts = f.persistent(f.fakeStorage())
  const controller = ops.createBorrowOperationController({ attempts, locks: { request: async (_n, _o, fn) => fn({}) }, now: () => f.NOW,
    readWallet: async () => x.context.wallet, prepare: async () => x.context, executionBlocker: () => null,
    submit: async () => { throw new ops.BorrowNotRequestedError('No wallet request was made.') }, verify: async () => null })
  await controller.prepare(x.action, 1.5, '1'); await controller.confirm(); assert.equal(controller.getState().phase, 'blocked')
  assert.match(controller.getState().message, /No wallet request/)
})

await test('a new unsent proof cannot discard an earlier in-flight attempt with a different idempotency key', async () => {
  const { createBorrowSubmissionGuard } = require('../src/lib/borrowSubmissionGuard.ts'), x = await f.build('borrow'), attempts = f.persistent(f.fakeStorage())
  const scopeId = safety.borrowAttemptScope(x.action, owner), actionId = safety.borrowActionId(x.action, owner)
  attempts.begin({ scopeId, actionId, kind: 'borrow', idempotencyKey: '33333333-3333-4333-8333-333333333333' }, Date.now())
  const guard = createBorrowSubmissionGuard({ owner: owner.toLowerCase(), scopeId, actionId, idempotencyKey: '44444444-4444-4444-8444-444444444444' })
  attempts.discard(scopeId, guard.sealUnsent()); assert.equal(attempts.get(scopeId).status, 'in-flight')
})

await test('an unresolved operation on another loan blocks this wallet even after its Web Lock has been released', async () => {
  const x = await f.build('borrow'), attempts = f.persistent(f.fakeStorage()), oldScope = '5042|' + owner.toLowerCase() + '|11111111-1111-4111-8111-111111111111'
  attempts.begin({ scopeId: oldScope, actionId: 'repay|5042|' + owner.toLowerCase() + '|11111111-1111-4111-8111-111111111111|1|none', kind: 'repay', idempotencyKey: '33333333-3333-4333-8333-333333333333' }, f.NOW)
  attempts.finish(oldScope, 'submitted', f.NOW, { txHash: HASH })
  let sends = 0
  const controller = ops.createBorrowOperationController({ attempts, locks: { request: async (_n, _o, fn) => fn({}) }, now: () => f.NOW, readWallet: async () => x.context.wallet,
    prepare: async () => x.context, executionBlocker: () => null, submit: async () => { sends++; return { batchId: HASH, txHash: HASH } }, verify: async () => null })
  await controller.prepare(x.action, 1.5, '1'); await controller.confirm(); assert.equal(sends, 0)
  assert.equal(controller.getState().phase, 'blocked'); assert.match(controller.getState().message, /unresolved Borrow operation/)
})

await test('full Repay uses current debt shares, exact USDC ceiling and independent zero-debt recovery', async () => {
  const s = await setup('repay', 'full-repay'); await s.run(); const { record } = attachReceipt(s)
  assert.equal((await r.recoverBorrowTransaction(s.rpc, record)).status, 'verified')
  assert.equal(s.after.debtShares, 0n)
})
await test('valid numeric pending nonce is accepted only for the wallet pending read', async () => {
  const reads = [], nonce = await t.borrowStableNonce({ getTransactionCount: async () => 7 }, async ({ params }) => { reads.push(params[1]); return params[1] === 'pending' ? 7 : '0x7' }, owner)
  assert.equal(nonce, 7); assert.deepEqual(reads, ['latest', 'pending', 'latest'])
})
await test('invalid wallet pending quantities never get a public-RPC fallback', async () => {
  for (const value of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1, '7', null, { result: '0x7' }]) {
    await assert.rejects(t.borrowStableNonce({ getTransactionCount: async () => 7 }, async ({ params }) => params[1] === 'pending' ? value : '0x7', owner))
  }
})
await test('a review that expires during SDK preparation stops before the wallet', async () => {
  const s = await setup(); s.review.expiresAt = Date.now() - 1
  await assert.rejects(s.run()); assert.equal(s.walletRequests.filter(x => x.method === 'eth_sendTransaction').length, 0)
})

await test('expiry during the final awaited wallet context read blocks the actual send and proves no dispatch', async () => {
  const s = await setup('borrow', 'expire-final-wallet-read')
  await assert.rejects(s.run())
  assert.equal(s.walletRequests.filter(x => x.method === 'eth_sendTransaction').length, 0)
  assert.ok(s.transport.sealUnsent(), 'the final context failure happened before any provider send')
})

await test('production recovery uses a durably recorded attempt hash if the metadata hash write was lost', async () => {
  const s = await setup(); await s.run(); const { record } = attachReceipt(s), attempts = f.persistent(s.storage)
  attempts.begin({ scopeId: record.scopeId, actionId: record.actionId, kind: 'borrow', idempotencyKey: '33333333-3333-4333-8333-333333333333' }, f.NOW)
  attempts.finish(record.scopeId, 'submitted', f.NOW, { txHash: HASH, batchId: HASH })
  const preHash = structuredClone(record); delete preHash.txHash; s.store.save(preHash)
  const production = require('../src/lib/borrowProduction.ts'), previous = t.borrowPublicClient
  let ports
  try {
    t.borrowPublicClient = () => s.rpc
    ports = production.createProductionBorrowPorts({ currentOwner: () => undefined, attempts, storage: () => s.storage, request: () => s.request, readWallet: async () => s.review.wallet, prepare: async () => { throw Error('Recovery must never prepare another transaction') } })
  } finally { t.borrowPublicClient = previous }
  assert.equal((await ports.recover(record.scopeId)).status, 'verified')
  assert.equal(await ports.acknowledge(record.scopeId), true)
  assert.equal(attempts.get(record.scopeId), null)
  assert.equal(s.walletRequests.filter(x => x.method === 'eth_sendTransaction').length, 1)
})

await test('zero-only padding beyond token decimals preserves the exact reviewed integer amounts', async () => {
  const s = await setup(); s.review.prepared.quote.collateral.amount = '0.050000000000'; s.review.prepared.quote.loanAsset.amount = '1000.000000000000'
  await s.run(); assert.equal(s.walletRequests.filter(x => x.method === 'eth_sendTransaction').length, 1)
  assert.equal(s.getBound().terms.collateralIn, 5000000n); assert.equal(s.getBound().terms.borrowAssets, 1000000000n)
})

await test('an opaque wallet send error is never retried by the Viem transport and remains unknown', async () => {
  const s = await setup('borrow', 'send-rpc-error'); await assert.rejects(s.run())
  assert.equal(s.walletRequests.filter(x => x.method === 'eth_sendTransaction').length, 1)
  assert.equal(s.transport.sealUnsent(), null)
})
await test('read-only wallet calls time out safely and can never dispatch a signature or transaction', async () => {
  let requests = 0
  await assert.rejects(t.borrowWalletRead(async () => { requests++; return null }, { method: 'eth_sendTransaction', params: [] }), /read_method_blocked/)
  assert.equal(requests, 0)
  const original = globalThis.setTimeout
  globalThis.setTimeout = (fn, delay, ...args) => original(fn, delay === 8000 ? 1 : delay, ...args)
  try { await assert.rejects(t.borrowWalletRead(async () => new Promise(() => {}), { method: 'eth_chainId' }), /read_timeout/) }
  finally { globalThis.setTimeout = original }
})
assert.equal(external, 0)
await test('the real public client rejects all signing/send methods on client and transport paths before any network request', async () => {
  const client = t.borrowPublicClient()
  for (const method of ['eth_sendTransaction','eth_sendRawTransaction','eth_sign','eth_signTypedData_v4','personal_sign','wallet_sendCalls']) {
    await assert.rejects(async () => client.request({method}), /borrow_public_rpc_method_blocked/)
    await assert.rejects(async () => client.transport.request({method}), /borrow_public_rpc_method_blocked/)
  }
})
await test('capability discovery recognizes the official EOA path and refuses native atomic transports without rewriting their reply', async () => {
  const production = require('../src/lib/borrowProduction.ts'), originalClient = t.borrowPublicClient
  try {
    const eoa = await setup(); t.borrowPublicClient = () => eoa.rpc
    assert.equal(await production.detectBorrowAtomicSupport(eoa.request, owner), 'supported')
    assert.equal(eoa.walletRequests.filter(x => x.method === 'eth_sendTransaction').length, 0)
    for (const atomic of [{status:'supported'}, {status:'ready'}, {supported:true}]) {
      const native = await setup('borrow', 'atomic-wallet'); t.borrowPublicClient = () => native.rpc
      const reply = { '0x13b2': {atomic} }
      const request = async args => args.method === 'wallet_getCapabilities' ? reply : native.request(args)
      assert.equal(await production.detectBorrowAtomicSupport(request, owner), 'unsupported')
      assert.deepEqual(reply, {'0x13b2':{atomic}})
      assert.equal(native.walletRequests.filter(x => x.method === 'eth_sendTransaction').length, 0)
    }
  } finally { t.borrowPublicClient = originalClient }
})
await test('native EIP-5792 cannot silently switch the guarded transport to an unbound wallet batch', async () => {
  const s = await setup('borrow', 'atomic-wallet')
  // A wallet may claim native atomic batching. Our facade must refuse that
  // execution mode until it exposes enforceable outer gas/fee terms.
  try {
    const result = await s.run()
    assert.notEqual(result?.status, 'confirmed', 'native atomic wallet must not be treated as a completed bounded loan')
  } catch (error) {
    // A rejected SDK execution is expected. The invariant below is more
    // important than the SDK's specific error class or prose.
    void error
  }
  assert.equal(s.walletRequests.filter(x => x.method === 'eth_sendTransaction').length, 0,
    'the adapter must not silently change to a direct EOA send')
  assert.equal(s.walletRequests.filter(x => x.method === 'wallet_sendCalls').length, 0,
    'unbounded EIP-5792 batch must never reach the connected wallet')
  assert.equal(s.mined(), false)
  assert.equal(s.getBound()?.txHash, undefined)
})
await test('fee-bound ordinary EOA SDK route is distinct from the native batch route', async () => {
  const s = await setup('borrow')
  await s.run()
  const requests = s.walletRequests.filter(x => x.method === 'eth_sendTransaction')
  assert.equal(requests.length, 1)
  assert.equal(s.walletRequests.filter(x => x.method === 'wallet_sendCalls').length, 0)
  const record = s.getBound()
  const fields = requests[0].params[0]
  assert.equal(fields.to.toLowerCase(), t.BORROW_BATCHER.toLowerCase())
  assert.ok(BigInt(fields.gas) * BigInt(fields.maxFeePerGas) <= record.terms.maxGasCostWei)
  assert.equal(BigInt(fields.nonce), BigInt(record.nonce))
  assert.equal(policy.borrowBatchCommitment(t.decodeBorrowAggregate(fields.data)), record.callsHash)
})

console.log(`RESULT ${count}/${count} PASS; actual SDK/encoder/adapter, controlled HTTP/RPC/provider; no external traffic or real wallet signatures/transactions`)
