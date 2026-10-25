// Controlled unit/integration evidence. No network, wallet, signature or live transaction.
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
const require = createRequire(import.meta.url), ts = require('typescript')
require.extensions['.ts'] = (mod, file) => mod._compile(ts.transpileModule(readFileSync(file, 'utf8'), { fileName: file, compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText, file)
globalThis.fetch = async () => { throw new Error('No external requests allowed') }
const f = require('./fixtures/borrow/operations.ts'), b = require('./fixtures/borrow/batch.ts')
const policy = require('../src/lib/borrowBatchPolicy.ts'), settlement = require('../src/lib/borrowSettlement.ts')
const operations = require('../src/lib/borrowOperations.ts'), locks = require('../src/lib/borrowOperationLock.ts')
const safety = require('../src/lib/borrowWriteSafety.ts'), market = require('../src/lib/borrowMarketVerification.ts')
const config = require('../src/config/mainnetBorrow.ts'), viem = require('viem')
let count = 0, mockSubmissions = 0
async function test(name, work) { await work(); count++; console.log('PASS ' + name) }
const kinds = Object.keys(f.ACTIONS)
function manager() { let held = false; return { async request(_name, _opts, fn) { if (held) return fn(null); held = true; try { return await fn({ name: _name }) } finally { held = false } } } }
async function setup(kind = 'borrow', opts = {}) {
  const { action, context } = await f.build(kind), attempts = f.persistent(f.fakeStorage())
  let clock = f.NOW, result = null, submits = 0
  const ports = { attempts, locks: manager(), now: () => clock, readWallet: async () => context.wallet,
    prepare: async () => structuredClone(context), executionBlocker: () => null,
    submit: async (review, onSubmitted) => { submits++; mockSubmissions++; const scope = safety.borrowAttemptScope(action, f.WALLET)
      assert.equal(ports.attempts.begin({ scopeId: scope, actionId: review.actionId, kind, idempotencyKey: '33333333-3333-4333-8333-333333333333' }, clock), true)
      const batch = b.batchFixture(kind, clock, review.prepared), evidence = b.settlementFixture(batch.review, batch.calls, scope)
      result = settlement.verifyBorrowSettlement(batch.review, scope, batch.calls, evidence)
      ports.attempts.finish(scope, 'submitted', clock, { batchId: 'controlled-batch', txHash: evidence.txHash }); onSubmitted('controlled-batch', evidence.txHash)
      return { batchId: 'controlled-batch', txHash: evidence.txHash } },
    verify: async () => result, ...opts }
  const controller = operations.createBorrowOperationController(ports)
  return { controller, ports, context, action, attempts, advance: ms => { clock += ms }, submits: () => submits }
}
await test('production gate and independent transport binding remain closed', () => {
  assert.equal(config.MAINNET_BORROW_WRITES_ENABLED, false); assert.equal(config.MAINNET_BORROW_EXECUTION_BOUND, false)
  assert.match(operations.productionBorrowExecutionBlocker(), /closed/)
})
for (const kind of kinds) {
  await test(kind + ': independent ABI shape check, exact amounts and atomic authorization', () => {
    const x = b.batchFixture(kind); assert.equal(policy.verifyBorrowAtomicBatch(x.review, x.calls).validation, 'shape-only')
  })
  await test(kind + ': controlled quote → review → wallet → receipt/state verified lifecycle', async () => {
    const x = await setup(kind), phases = []; x.controller.subscribe(s => phases.push(s.phase))
    await x.controller.prepare(x.action, 1.5, '1'); assert.equal(x.controller.getState().phase, 'review')
    assert.equal(x.submits(), 0); await x.controller.confirm(); assert.equal(x.controller.getState().phase, 'verified')
    for (const p of ['quoting', 'review', 'checking', 'wallet', 'pending', 'verified']) assert.ok(phases.includes(p))
    assert.equal(x.submits(), 1)
  })
}
for (const kind of kinds) await test(kind + ': shared read preparation uses the existing SDK quote/position reads only', async () => {
  const { client, calls } = f.fakeClient({ [f.METHOD[kind]]: f.RESPONSES[kind], getMarket: f.MARKET_WIRE, getPosition: f.LOAN_WIRE, getLoans: { loans: [f.LOAN_WIRE], pagination: {} } })
  const verification = structuredClone(f.VERIFIED); verification.details.block = { number: 123n, hash: '0x' + 'aa'.repeat(32), timestamp: BigInt(Math.floor(Date.now() / 1000)) }
  const result = await operations.readBorrowOperation(f.ACTIONS[kind], f.READY_WALLET, 1.5, { client, verifyMarket: async () => verification, balances: async () => f.BALANCES })
  assert.equal(result.quote.request.kind, kind); assert.equal(result.evidence.verification.result.details.block.number, 123n)
  assert.ok(!calls.some(c => ['borrow', 'repay', 'closeLoan', 'addCollateral', 'withdrawCollateralRepayIfNeeded', 'retry'].includes(c.method)))
})
const bad = (name, mutate) => test(name, () => { const x = b.batchFixture(); mutate(x); assert.throws(() => policy.verifyBorrowAtomicBatch(x.review, x.calls)) })
await bad('wrong chain rejects', x => { x.review.chainId = 1 })
await bad('expired quote rejects', x => { x.review.quoteExpiresAt = Date.now() - 1 })
await bad('different market rejects', x => { x.review.marketId = '0x' + 'cc'.repeat(32) })
await bad('native USDC transfer cannot replace six-decimal ERC20 approval', x => { x.calls[0].value = 1n })
await bad('approval must be exact and target the adapter', x => { x.calls[0].data = viem.encodeFunctionData({ abi: policy.BORROW_TOKEN_ABI, functionName: 'approve', args: [config.MAINNET_BORROW_ADAPTER_CONTRACT, 2n ** 256n - 1n] }) })
await bad('unknown router call rejects', x => { x.calls.push({ to: f.WALLET, data: '0x' }) })
await bad('missing revoke rejects', x => { x.calls.pop() })
await bad('wrong authorization order rejects', x => { [x.calls[1], x.calls[3]] = [x.calls[3], x.calls[1]] })
await bad('different refund recipient rejects', x => { x.params.tokens[0].beneficiary = '0x' + '22'.repeat(20); x.calls = x.encode() })
await bad('different instruction target rejects', x => { x.params.instructions[0].target = f.WALLET; x.calls = x.encode() })
await bad('modified economic calldata rejects', x => { x.params.instructions[1].data = viem.encodeFunctionData({ abi: policy.BORROW_MORPHO_ABI, functionName: 'borrow', args: [x.review.market, 101n, 0n, f.WALLET, config.MAINNET_BORROW_ADAPTER_CONTRACT] }); x.calls = x.encode() })
await bad('expired signed envelope deadline rejects', x => { x.params.deadline = 1n; x.calls = x.encode() })
await bad('unbounded deadline rejects', x => { x.params.deadline += 10000n; x.calls = x.encode() })
await bad('permit insertion rejects', x => { x.tokenInputs[0].permitType = 1; x.calls = x.encode() })
await bad('noncanonical trailing calldata rejects', x => { x.calls[2].data += '00' })
await bad('insufficient allowance without approval rejects', x => { x.calls.shift() })
await test('sufficient prior allowance reuses it without an extra approval', () => {
  const x = b.batchFixture(); x.review.startingAllowances[x.review.market.collateralToken.toLowerCase()] = 100n; x.calls.shift()
  assert.equal(policy.verifyBorrowAtomicBatch(x.review, x.calls).validation, 'shape-only')
})
await test('unbound fee transport is rejected, not treated as an estimate guarantee', () => {
  assert.throws(() => policy.assertBorrowFeeBinding(100n, 10n, 10n, false)); assert.throws(() => policy.assertBorrowFeeBinding(99n, 10n, 10n, true))
  policy.assertBorrowFeeBinding(100n, 10n, 10n, true)
})
await test('production UI controller never reaches submit', async () => {
  const x = await setup('borrow', { executionBlocker: operations.productionBorrowExecutionBlocker })
  await x.controller.prepare(x.action, 1.5, '1'); await x.controller.confirm(); assert.equal(x.submits(), 0)
})
await test('double confirm submits only once', async () => {
  const x = await setup(); await x.controller.prepare(x.action, 1.5, '1'); await Promise.all([x.controller.confirm(), x.controller.confirm()]); assert.equal(x.submits(), 1)
})
await test('missing browser Web Locks fails closed', async () => {
  const x = await setup('borrow', { locks: null }); await x.controller.prepare(x.action, 1.5, '1'); await x.controller.confirm(); assert.equal(x.submits(), 0); assert.equal(x.controller.getState().phase, 'blocked')
})
await test('shared lock excludes two simultaneous controller submissions', async () => {
  let release; const held = new Promise(r => { release = r }), m = manager()
  const running = locks.withBorrowOperationLock(f.WALLET, () => held, m)
  await assert.rejects(locks.withBorrowOperationLock(f.WALLET, async () => {}, m), /busy/); release(); await running
})
await test('review expiry never reaches a wallet submission', async () => {
  const x = await setup(); await x.controller.prepare(x.action, 1.5, '1'); x.advance(config.MAINNET_BORROW_MAX_EVIDENCE_AGE_MS + 1000); await x.controller.confirm(); assert.equal(x.submits(), 0)
})
await test('changed chain/account blocks before submission', async () => {
  for (const wallet of [{ address: f.WALLET, chainId: 1 }, { address: '0x' + '22'.repeat(20), chainId: 5042 }]) {
    const x = await setup(); await x.controller.prepare(x.action, 1.5, '1'); x.ports.readWallet = async () => wallet; await x.controller.confirm(); assert.equal(x.submits(), 0)
  }
})
await test('changed inputs invalidate old review', async () => {
  const x = await setup(); await x.controller.prepare(x.action, 1.5, '1'); x.controller.invalidate(); await x.controller.confirm(); assert.equal(x.submits(), 0)
})
await test('fee drift above user cap blocks before wallet', async () => {
  const x = await setup(); await x.controller.prepare(x.action, 1.5, '1'); x.ports.prepare = async () => { const c = structuredClone(x.context); c.quote.quote.gasFees[0].feeWei = '2000000000000000000'; return c }
  await x.controller.confirm(); assert.equal(x.submits(), 0)
})
await test('service fee drift requires a new review', async () => {
  const x = await setup(); await x.controller.prepare(x.action, 1.5, '1'); x.ports.prepare = async () => { const c = structuredClone(x.context); c.quote.quote.fees = [{ type: 'circle', amount: { token: 'USDC', tokenAddress: '0x3600000000000000000000000000000000000000', amount: '1', decimals: 6 } }]; return c }
  await x.controller.confirm(); assert.equal(x.submits(), 0)
})
await test('user maximum fee must be covered by the native balance', async () => {
  const x = await setup(); await x.controller.prepare(x.action, 1.5, '6000'); assert.equal(x.controller.getState().phase, 'blocked'); assert.equal(x.submits(), 0)
})
await test('receipt proof resolves only its exact persisted hash, owner and scope', async () => {
  const { action } = await f.build('borrow'), scope = safety.borrowAttemptScope(action, f.WALLET), batch = b.batchFixture(), e = b.settlementFixture(batch.review, batch.calls, scope)
  const attempts = f.persistent(f.fakeStorage())
  assert.equal(attempts.begin({ scopeId: scope, actionId: safety.borrowActionId(action, f.WALLET), kind: 'borrow', idempotencyKey: '33333333-3333-4333-8333-333333333333' }, f.NOW), true)
  attempts.finish(scope, 'submitted', f.NOW, { txHash: e.txHash })
  const proof = settlement.verifyBorrowSettlement(batch.review, scope, batch.calls, e)
  assert.equal(attempts.resolve(scope, { acknowledged: true, positionReadAt: f.NOW + 1, settlement: { ...proof } }), false)
  assert.equal(attempts.resolve(scope, { acknowledged: true, positionReadAt: f.NOW + 1, settlement: proof }), true)
})
await test('repayment and gas budget share native USDC backing, using 18 and 6 decimals correctly', async () => {
  const x = await setup('repay'); assert.equal(operations.borrowNativeBudget(x.context.quote, 10n ** 18n), 11n * 10n ** 18n)
})
await test('a genuine proof for a different amount cannot confirm this quote', async () => {
  const x = await setup('borrow', { verify: async review => {
    const batch = b.batchFixture('borrow'), scope = safety.borrowAttemptScope(review.action, f.WALLET), e = b.settlementFixture(batch.review, batch.calls, scope)
    return settlement.verifyBorrowSettlement(batch.review, scope, batch.calls, e)
  } })
  await x.controller.prepare(x.action, 1.5, '1'); await x.controller.confirm(); assert.equal(x.controller.getState().phase, 'unknown')
})
await test('RPC timeout before boundary blocks without a send', async () => {
  const x = await setup(); await x.controller.prepare(x.action, 1.5, '1'); x.ports.prepare = async () => { throw new Error('sensitive RPC data') }; await x.controller.confirm()
  assert.equal(x.submits(), 0); assert.ok(!x.controller.getState().message.includes('sensitive'))
})
await test('user rejection/ambiguous boundary never automatically retries', async () => {
  let requests = 0; const x = await setup('borrow', { submit: async () => { requests++; throw Object.assign(new Error('private wallet details'), { code: 4001 }) } })
  await x.controller.prepare(x.action, 1.5, '1'); await x.controller.confirm(); assert.equal(x.controller.getState().phase, 'unknown')
  await x.controller.confirm(); await x.controller.prepare(x.action, 1.5, '1'); assert.equal(requests, 1)
})
await test('SDK confirmed or fabricated receipt is insufficient', async () => {
  const x = await setup('borrow', { verify: async () => ({ status: 'verified', owner: f.WALLET, chainId: 5042 }) })
  await x.controller.prepare(x.action, 1.5, '1'); await x.controller.confirm(); assert.equal(x.controller.getState().phase, 'unknown')
})
await test('reload retains unresolved attempt and blocks new preparation', async () => {
  const storage = f.fakeStorage(), attempts = f.persistent(storage), x = await setup('borrow', { attempts, verify: async () => null })
  await x.controller.prepare(x.action, 1.5, '1'); await x.controller.confirm()
  const reloaded = f.persistent(storage, 'new-page'); assert.equal(reloaded.list().length, 1)
  const y = await setup('borrow', { attempts: reloaded }); await y.controller.prepare(y.action, 1.5, '1'); assert.equal(y.controller.getState().phase, 'blocked')
})
for (const [name, mutate] of Object.entries({
  'reorg': e => { e.canonicalBlockHash = '0x' + 'cc'.repeat(32) },
  'batch mismatch': e => { e.decodedCalls = [] },
  'missing event verification': e => { e.morphoEventsVerified = false },
  'wrong owner': e => { e.sender = '0x' + '22'.repeat(20) },
  'gas over cap': e => { e.receipt.effectiveGasPrice = 10n ** 18n },
  'wrong position delta': e => { e.after.collateral++ },
  'invalid numeric health factor': e => { e.after.healthFactor = NaN },
  'unhealthy position': e => { e.after.healthFactor = 1.1 },
  '70 percent product LTV breached': e => { e.after.ltv = 0.71 },
})) await test('independent settlement rejects ' + name, () => { const x = b.batchFixture(), e = b.settlementFixture(x.review, x.calls, 'scope'); mutate(e); assert.equal(settlement.verifyBorrowSettlement(x.review, 'scope', x.calls, e), null) })
await test('reverted receipt is failed, gas charged, no successful position claimed', () => {
  const x = b.batchFixture(), e = b.settlementFixture(x.review, x.calls, 'scope'); e.receipt.status = 'reverted'; e.after = { ...e.before, healthFactor: 2, ltv: 0.4 }
  const proof = settlement.verifyBorrowSettlement(x.review, 'scope', x.calls, e); assert.equal(proof.status, 'failed'); assert.equal(proof.gasCostWei, 100000000000000n)
})
await test('market params, state and oracle share a block; reorg is rejected', async () => {
  const blocks = [], x = b.batchFixture(), block = { number: 123n, hash: '0x' + 'aa'.repeat(32), timestamp: BigInt(Math.floor(Date.now() / 1000)) }
  const input = { ...f.MARKET_DATA, marketId: x.review.marketId }, reader = { chainId: async () => 5042, snapshot: async () => block, canonical: async () => true,
    marketParams: async (_id, n) => { blocks.push(n); return x.review.market }, marketState: async (_id, n) => { blocks.push(n); return { totalSupplyAssets: 100n, totalBorrowAssets: 0n } }, oraclePrice: async (_a, n) => { blocks.push(n); return 1n } }
  assert.equal((await market.verifyBorrowMarket(input, reader)).status, 'verified'); assert.deepEqual(blocks, [123n, 123n, 123n])
  reader.canonical = async () => false; assert.deepEqual((await market.verifyBorrowMarket(input, reader)).reasons, ['block_context_changed'])
  delete reader.canonical; assert.equal((await market.verifyBorrowMarket(input, reader)).status, 'unavailable')
})
console.log(`RESULT ${count}/${count} PASS; controlled submissions=${mockSubmissions}; real network/signatures/transactions=0`)
