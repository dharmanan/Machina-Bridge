// ERC-20 input approvals (token -> Permit2, Permit2 -> router): exact amounts, separate confirmations, journaling, verification.
// Controlled ports only: no network, no wallet, no signatures, no transactions.
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
const require = createRequire(import.meta.url), ts = require('typescript')
require.extensions['.ts'] = (mod, file) => mod._compile(ts.transpileModule(readFileSync(file, 'utf8'), { fileName: file,
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText, file)
const root = fileURLToPath(new URL('..', import.meta.url))
const p = require(`${root}src/lib/uniswapArcPolicy.ts`), a = require(`${root}src/lib/swap/uniswapApprovals.ts`), rpcModule = require(`${root}src/lib/swap/uniswapApprovalsRpc.ts`)
const e = require(`${root}src/lib/uniswapArcExecution.ts`)
const { encodeFunctionData, parseAbi, toHex } = require('viem')
let count = 0, external = 0
globalThis.fetch = async () => { external++; throw Error('network_forbidden') }
async function test(name, fn) { await fn(); count++; console.log(`PASS ${name}`) }
const owner = '0xafbB6Cc5C0a9C0eB1BfF8dB2eD807e83aAB8e321', other = '0x2222222222222222222222222222222222222222'
const HASH1 = `0x${'a1'.repeat(32)}`, HASH2 = `0x${'b2'.repeat(32)}`
const request = (tokenIn = 'EURC', amount = '1', extra = {}) => p.validateArcRequest({ chainId: 5042, tokenIn, tokenOut: tokenIn === 'USDC' ? 'EURC' : 'USDC', owner, recipient: owner, amount, minimumOutput: '1', slippageBps: 50, maxNetworkFee: '100000000000000000', ...extra })
const NEED = 1_000_000n, TS = 1_800_000_000n
const historicalPermitStep = { kind: 'permit2', token: 'EURC', spender: p.ARC_ROUTER, amount: NEED.toString(), expiration: Number(TS) + 900 }
const reads = (changes = {}) => ({ timestamp: TS, balance: 5n * NEED, tokenAllowance: 0n, permitAmount: 0n, permitExpiration: 0n, nativeBalance: 5n * 10n ** 18n, gasPrice: 20_000_000_000n, ...changes })

await test('the plan asks only for what is missing, for the exact amount, and reuses approvals that already cover it', () => {
  assert.deepEqual(a.planApprovals(request('USDC'), reads()), { state: 'native_input' })
  assert.deepEqual(a.planApprovals(request(), reads({ balance: NEED - 1n })), { state: 'blocked', reason: 'insufficient_balance' })
  const both = a.planApprovals(request(), reads())
  assert.equal(both.state, 'needed'); assert.deepEqual(both.steps.map(s => s.kind), ['token'])
  assert.ok(both.steps.every(s => s.amount === NEED.toString())); assert.ok(p.sameAddress(both.steps[0].spender, p.ARC_PERMIT2))
  assert.equal(both.steps[0].expiration, 0)
  assert.deepEqual(a.planApprovals(request(), reads({ tokenAllowance: NEED })), { state: 'complete' })
  assert.deepEqual(a.planApprovals(request(), reads({ permitAmount: NEED, permitExpiration: TS + 900n })).steps.map(s => s.kind), ['token'])
  assert.deepEqual(a.planApprovals(request(), reads({ tokenAllowance: NEED, permitAmount: NEED, permitExpiration: TS + 900n })), { state: 'complete' })
  assert.deepEqual(a.planApprovals(request(), reads({ tokenAllowance: 10n * NEED, permitAmount: 10n * NEED, permitExpiration: TS + 900n })), { state: 'complete' }) // larger existing allowances are left alone
  assert.deepEqual(a.planApprovals(request(), reads({ tokenAllowance: NEED, permitAmount: NEED, permitExpiration: TS + 179n })), { state: 'complete' }) // about to expire
  assert.deepEqual(a.planApprovals(request(), reads({ tokenAllowance: NEED, permitAmount: NEED - 1n, permitExpiration: TS + 900n })), { state: 'complete' })
  for (const [symbol, amount, units] of [['cirBTC', '0.00001', 1000n], ['WETH', '0.0003', 300_000_000_000_000n], ['EURC', '1.234567', 1_234_567n]]) assert.equal(a.planApprovals(request(symbol, amount), reads({ balance: 10n ** 21n })).steps[0].amount, units.toString())
})
await test('EURC, WETH and cirBTC existing unlimited allowances are reused without a new approval; a missing allowance always asks for the exact amount', () => {
  for (const [symbol, amount] of [['EURC', '1'], ['WETH', '0.0003'], ['cirBTC', '0.00001']]) {
    const r = request(symbol, amount), need = p.tokenUnits(amount, p.ARC_TOKENS[symbol].decimals)
    assert.deepEqual(a.planApprovals(r, reads({ balance: need, tokenAllowance: 2n ** 256n - 1n })), { state: 'complete' })
    const missing = a.planApprovals(r, reads({ balance: need, tokenAllowance: need - 1n }))
    assert.equal(missing.steps.length, 1); assert.equal(missing.steps[0].kind, 'token'); assert.equal(missing.steps[0].amount, need.toString())
  }
})
await test('no step can be unlimited, to another spender, for another token or amount, or valid for long', () => {
  const r = request(), now = Number(TS) * 1000, good = [...a.planApprovals(r, reads()).steps, historicalPermitStep]
  assert.doesNotThrow(() => a.validateApprovalStep(good[0], r, now)); assert.doesNotThrow(() => a.validateApprovalStep(good[1], r, now))
  const bad = (name, step) => assert.throws(() => a.validateApprovalStep(step, r, now), undefined, name)
  bad('unlimited token approval', { ...good[0], amount: (2n ** 256n - 1n).toString() }); bad('unlimited Permit2 approval', { ...good[1], amount: (2n ** 160n - 1n).toString() })
  bad('one unit too much', { ...good[0], amount: (NEED + 1n).toString() }); bad('one unit too little', { ...good[0], amount: (NEED - 1n).toString() }); bad('zero', { ...good[0], amount: '0' })
  bad('token step to another spender', { ...good[0], spender: other }); bad('token step to the router directly', { ...good[0], spender: p.ARC_ROUTER }); bad('Permit2 step to another spender', { ...good[1], spender: other })
  bad('Permit2 step to Permit2', { ...good[1], spender: p.ARC_PERMIT2 }); bad('another token', { ...good[0], token: 'cirBTC' }); bad('token step with an expiry', { ...good[0], expiration: 5 })
  bad('Permit2 step without expiry', { ...good[1], expiration: 0 }); bad('Permit2 step already expired', { ...good[1], expiration: Number(TS) - 1 }); bad('Permit2 step valid for over 16 minutes', { ...good[1], expiration: Number(TS) + 961 })
  bad('unknown kind', { ...good[0], kind: 'permit' }); bad('extra field', { ...good[0], extra: 1 }); bad('missing field', { kind: 'token', token: 'EURC' }); bad('null', null)
  assert.throws(() => a.validateApprovalStep({ kind: 'token', token: 'USDC', spender: p.ARC_PERMIT2, amount: NEED.toString(), expiration: 0 }, request('USDC'), now)) // native USDC never needs an approval
})
await test('approval transactions are exactly the two approved shapes and decode back to the same step; anything else is not an approval', () => {
  const r = request(), steps = [...a.planApprovals(r, reads()).steps, historicalPermitStep]
  for (const step of steps) {
    const tx = a.approvalTransaction(owner, step)
    assert.equal(tx.value, '0x0'); assert.equal(tx.chainId, 5042); assert.ok(p.sameAddress(tx.from, owner))
    assert.ok(p.sameAddress(tx.to, step.kind === 'token' ? p.ARC_TOKENS.EURC.address : p.ARC_PERMIT2))
    assert.deepEqual(a.decodeApprovalTransaction(tx), { ...step, spender: step.spender })
  }
  const token = a.approvalTransaction(owner, steps[0]), permit = a.approvalTransaction(owner, steps[1])
  const no = (name, tx) => assert.equal(a.decodeApprovalTransaction(tx), null, name)
  no('trailing byte', { ...token, data: `${token.data}00` }); no('value attached', { ...token, value: '0x1' }); no('another selector (transfer)', { to: token.to, data: encodeFunctionData({ abi: parseAbi(['function transfer(address,uint256)']), functionName: 'transfer', args: [other, 1n] }) })
  no('increaseAllowance', { to: token.to, data: encodeFunctionData({ abi: parseAbi(['function increaseAllowance(address,uint256)']), functionName: 'increaseAllowance', args: [p.ARC_PERMIT2, 1n] }) })
  no('another contract', { ...token, to: other }); no('the router', { ...token, to: p.ARC_ROUTER }); no('native USDC ERC-20 face', { ...token, to: p.ARC_USDC }); no('truncated data', { ...token, data: token.data.slice(0, 20) }); no('Permit2 trailing byte', { ...permit, data: `${permit.data}00` })
  no('Permit2 approval for native USDC', { to: p.ARC_PERMIT2, data: encodeFunctionData({ abi: parseAbi(['function approve(address,address,uint160,uint48)']), functionName: 'approve', args: [p.ARC_USDC, p.ARC_ROUTER, 1n, 5] }) })
  no('Permit2 approval for an unknown token', { to: p.ARC_PERMIT2, data: encodeFunctionData({ abi: parseAbi(['function approve(address,address,uint160,uint48)']), functionName: 'approve', args: [other, p.ARC_ROUTER, 1n, 5] }) })
  no('empty', { to: token.to, data: '0x' })
})

// ---------------------------------------------------------------------------------------------------------------------------------------
// Controller
function setup(options = {}) {
  const data = options.data ?? new Map(), clock = { now: 1_800_000_000_000 }
  const world = { reads: reads(options.reads), nonce: 4, estimate: 46_000n, authorized: true, ctx: { owner, connected: true, chainId: 5042, connectorId: 'c1' }, ...options.world }
  const sent = [], views = [], settled = []
  const storage = { getItem: k => (data.has(k) ? data.get(k) : null), setItem: (k, v) => { if (options.storageFails) throw Error('quota'); options.onWrite?.(v); data.set(k, v) } }
  const provider = { request: async ({ method, params }) => {
    if (method === 'eth_chainId') return toHex(world.ctx.chainId); if (method === 'eth_accounts') return [world.ctx.owner]
    if (method === 'eth_getTransactionCount') return toHex(world.nonce)
    if (method === 'eth_sendTransaction') {
      sent.push(params[0])
      const stored = a.createApprovalJournal(storage).read(owner); world.journalAtSend = structuredClone(stored)
      if (options.sendError) throw options.sendError; if (options.sendDelay) await options.sendDelay()
      return options.hash ?? (sent.length === 1 ? HASH1 : HASH2)
    }
    throw Error(`unexpected ${method}`)
  } }
  const ports = { context: () => world.ctx, authorize: () => world.authorized, reads: async () => { if (world.readsFail) throw Error('down'); return structuredClone(world.reads) }, estimate: async () => world.estimate,
    blockedBy: options.blockedBy ?? (() => world.held === true), nonces: async () => ({ nonce: world.nonce, latestNonce: world.nonce }), provider: async () => provider, result: options.result ?? (async () => ({ status: 'pending' })), storage, lock: async (_o, run) => run(), now: () => clock.now,
    changed: v => views.push(v), settled: x => settled.push(x) }
  const controller = a.createUniswapApprovals(ports)
  return { controller, ports, world, sent, views, settled, data, clock, storage, provider,
    async review(r = request()) { await controller.prepare(r); assert.equal(controller.view().phase, 'review', controller.view().error); return controller.view().review.id } }
}
await test('review: the first missing approval, its exact fee ceiling and nonce are shown; nothing is requested from the wallet', async () => {
  const f = setup(), id = await f.review(), v = f.controller.view().review
  assert.ok(id); assert.equal(v.remaining, 1); assert.equal(v.step.kind, 'token'); assert.equal(v.step.amount, NEED.toString()); assert.equal(v.nonce, 4)
  assert.equal(BigInt(v.networkFee), BigInt(v.gas) * BigInt(v.maxFeePerGas)); assert.equal(v.gas, '69000'); assert.equal(v.maxFeePerGas, '40000000000'); assert.ok(BigInt(v.networkFee) <= a.APPROVAL_FEE_CEILING)
  assert.equal(v.maxPriorityFeePerGas, '0'); assert.equal(f.sent.length, 0); assert.equal(f.data.size, 0) // review writes nothing
  assert.equal(JSON.stringify(v.transaction).includes('ffffffff'), false)
})
await test('confirm: the journal is written BEFORE the wallet request; the request is exactly the reviewed approval; the status becomes Pending with the hash', async () => {
  const f = setup(), id = await f.review(); await f.controller.confirm(id)
  assert.equal(f.sent.length, 1); const tx = f.sent[0], review = f.views.find(v => v.phase === 'review').review
  assert.deepEqual(Object.keys(tx).sort(), ['chainId', 'data', 'from', 'gas', 'maxFeePerGas', 'maxPriorityFeePerGas', 'nonce', 'to', 'type', 'value'])
  assert.equal(tx.type, '0x2'); assert.equal(tx.value, '0x0'); assert.equal(tx.chainId, '0x13b2'); assert.equal(tx.nonce, '0x4'); assert.equal(tx.maxPriorityFeePerGas, '0x0'); assert.equal(tx.data, review.transaction.data); assert.ok(p.sameAddress(tx.to, p.ARC_TOKENS.EURC.address))
  assert.equal(f.world.journalAtSend.length, 1); assert.equal(f.world.journalAtSend[0].status, 'awaiting_wallet'); assert.equal(f.world.journalAtSend[0].hash, undefined)
  const view = f.controller.view(); assert.equal(view.phase, 'pending'); assert.equal(view.attempt.hash, HASH1); assert.equal(view.nextCheckMs, a.APPROVAL_CHECK_MS)
  assert.equal(a.createApprovalJournal(f.storage).read(owner)[0].status, 'pending'); assert.deepEqual(a.createApprovalJournal(f.storage).read(owner)[0].log.map(l => l.status), ['awaiting_wallet', 'pending'])
})
await test('a confirmed approval is only "Confirmed" when the sent transaction is the reviewed one AND the chain holds exactly that allowance', async () => {
  const outcomes = [
    [{ status: 'settled', state: 'success', fee: '1000', blockNumber: '9', bound: true, allowanceOk: true }, 'confirmed'],
    [{ status: 'settled', state: 'success', fee: '1000', blockNumber: '9', bound: false, allowanceOk: true }, 'mismatch'],
    [{ status: 'settled', state: 'success', fee: '1000', blockNumber: '9', bound: true, allowanceOk: false }, 'mismatch'],
    [{ status: 'settled', state: 'reverted', fee: '1000', blockNumber: '9', bound: true, allowanceOk: false }, 'failed'],
    [{ status: 'pending' }, 'pending'],
  ]
  for (const [outcome, expected] of outcomes) {
    const f = setup({ result: async () => outcome }); await f.controller.confirm(await f.review()); await f.controller.reconcile(owner)
    const view = f.controller.view(); assert.equal(view.phase, expected); assert.equal(a.createApprovalJournal(f.storage).read(owner)[0].status, expected)
    if (expected !== 'pending') { assert.equal(view.attempt.fee, '1000'); assert.equal(f.settled.length, 1); assert.equal(view.nextCheckMs, null) } else assert.equal(view.nextCheckMs, a.APPROVAL_CHECK_MS)
    assert.equal(f.controller.blocking(owner), expected === 'pending')
  }
})
await test('after the exact token approval, no on-chain Permit2 approval is ever offered; historical decoding remains available', async () => {
  const f = setup({ result: async () => ({ status: 'settled', state: 'success', fee: '5', blockNumber: '9', bound: true, allowanceOk: true }) })
  await f.controller.confirm(await f.review()); await f.controller.reconcile(owner)
  f.world.reads.tokenAllowance = NEED; f.world.nonce = 5
  assert.deepEqual(await f.controller.plan(request()), { state: 'complete' })
  await f.controller.prepare(request()); assert.equal(f.controller.view().phase, 'idle'); assert.match(f.controller.view().error, /already in place/)
  assert.equal(f.sent.length, 1); assert.deepEqual(a.createApprovalJournal(f.storage).read(owner).map(x => x.step.kind), ['token'])
})
await test('nothing is requested when: execution is not authorized, the wallet or network differs, another transaction is unresolved, or the amount is not covered', async () => {
  const gated = setup({ world: { authorized: false } }); await gated.controller.prepare(request()); assert.equal(gated.controller.view().phase, 'idle'); assert.match(gated.controller.view().error, /controlled pilot/); assert.equal(gated.sent.length, 0)
  const wrongChain = setup({ world: { ctx: { owner, connected: true, chainId: 1, connectorId: 'c' } } }); await wrongChain.controller.prepare(request()); assert.equal(wrongChain.controller.view().phase, 'idle'); assert.equal(wrongChain.sent.length, 0)
  const wrongOwner = setup(); await wrongOwner.controller.prepare(request('EURC', '1', { owner: other, recipient: other })); assert.equal(wrongOwner.controller.view().phase, 'idle')
  const poor = setup({ reads: { balance: NEED - 1n } }); await poor.controller.prepare(request()); assert.match(poor.controller.view().error, /does not hold enough/); assert.equal(poor.sent.length, 0)
  const noFee = setup({ reads: { nativeBalance: 1n } }); await noFee.controller.prepare(request()); assert.match(noFee.controller.view().error, /cannot cover the network fee/)
  const down = setup({ world: { readsFail: true } }); await down.controller.prepare(request()); assert.match(down.controller.view().error, /could not be read/); assert.equal(down.sent.length, 0)
  const native = setup(); await native.controller.prepare(request('USDC')); assert.equal(native.controller.view().phase, 'idle'); assert.match(native.controller.view().error, /No approval is needed/)
  const busy = setup(); await busy.controller.confirm(await busy.review()); await busy.controller.prepare(request()); assert.equal(busy.sent.length, 1); assert.match(busy.controller.view().error, /unresolved/)
  const feeRunaway = setup({ world: { estimate: 10n ** 9n } }); await feeRunaway.controller.prepare(request()); assert.equal(feeRunaway.controller.view().phase, 'idle')
})
await test('double confirm, a stale id, an expired review, a changed wallet or changed chain state never send a second or different request', async () => {
  let release
  const slow = setup({ sendDelay: () => new Promise(resolve => { release = resolve }) }), id = await slow.review()
  const first = slow.controller.confirm(id); await new Promise(r => setTimeout(r, 5)); await slow.controller.confirm(id); release(); await first
  assert.equal(slow.sent.length, 1)
  const stale = setup(); await stale.review(); await stale.controller.confirm('not-the-id'); assert.equal(stale.sent.length, 0)
  const expired = setup(), expiredId = await expired.review(); expired.clock.now += a.APPROVAL_REVIEW_TTL_MS + 1; await expired.controller.confirm(expiredId); assert.equal(expired.sent.length, 0); assert.match(expired.controller.view().error, /expired/)
  const wallet = setup(), walletId = await wallet.review(); wallet.world.ctx = { ...wallet.world.ctx, owner: other }; await wallet.controller.confirm(walletId); assert.equal(wallet.sent.length, 0)
  const connector = setup(), connectorId = await connector.review(); connector.world.ctx = { ...connector.world.ctx, connectorId: 'c2' }; await connector.controller.confirm(connectorId); assert.equal(connector.sent.length, 0)
  const changed = setup(), changedId = await changed.review(); changed.world.reads.tokenAllowance = NEED; await changed.controller.confirm(changedId); assert.equal(changed.sent.length, 0); assert.match(changed.controller.view().error, /changed|Review|already in place/)
  const nonce = setup(), nonceId = await nonce.review(); nonce.world.nonce = 9; await nonce.controller.confirm(nonceId); assert.equal(nonce.sent.length, 0); assert.match(nonce.controller.view().error, /nonce/i)
  const gate = setup(), gateId = await gate.review(); gate.world.authorized = false; await gate.controller.confirm(gateId); assert.equal(gate.sent.length, 0)
  const cancelled = setup(), cancelledId = await cancelled.review(); cancelled.controller.invalidate(); await cancelled.controller.confirm(cancelledId); assert.equal(cancelled.sent.length, 0); assert.equal(cancelled.controller.view().phase, 'idle')
})
await test('a journal that cannot be saved means no wallet request at all', async () => {
  const f = setup({ storageFails: true }), id = await f.review(); await f.controller.confirm(id)
  assert.equal(f.sent.length, 0); assert.match(f.controller.view().error, /could not be saved/)
})
await test('wallet outcomes: a rejection is final and unblocks; any other failure without a hash stays unresolved and blocks until the hash is verified', async () => {
  const rejected = setup({ sendError: Object.assign(Error('user rejected'), { code: 4001 }) }); await rejected.controller.confirm(await rejected.review())
  assert.equal(rejected.controller.view().phase, 'rejected'); assert.equal(rejected.controller.blocking(owner), false); assert.match(rejected.controller.view().error, /rejected/)
  await rejected.controller.prepare(request()); assert.equal(rejected.controller.view().phase, 'review') // a fresh review is allowed after a rejection
  const lost = setup({ sendError: Error('disconnected') }); await lost.controller.confirm(await lost.review())
  assert.equal(lost.controller.view().phase, 'unknown'); assert.equal(lost.controller.blocking(owner), true); await lost.controller.prepare(request()); assert.match(lost.controller.view().error, /unresolved/); assert.equal(lost.sent.length, 1)
  await lost.controller.reconcile(owner); assert.equal(lost.controller.blocking(owner), true) // a record without a hash cannot be checked, so it keeps blocking
  // A hash the network has never shown is not saved: it would replace the means of finding the real transaction.
  lost.ports.result = async attempt => { assert.equal(attempt.hash, HASH2); return { status: 'pending', identified: false } }
  await lost.controller.recover(owner, HASH2); assert.equal(a.createApprovalJournal(lost.storage).read(owner)[0].hash, undefined); assert.match(lost.controller.view().error, /does not know that hash/); assert.equal(lost.controller.blocking(owner), true)
  lost.ports.result = async attempt => { assert.equal(attempt.hash, HASH2); return { status: 'pending', identified: true } }
  await lost.controller.recover(owner, 'not-a-hash'); assert.equal(lost.controller.blocking(owner), true)
  await lost.controller.recover(owner, HASH2); assert.equal(lost.controller.view().phase, 'pending'); assert.equal(a.createApprovalJournal(lost.storage).read(owner)[0].hash, HASH2)
  const refused = setup({ sendError: Error('x') }); await refused.controller.confirm(await refused.review()); refused.ports.result = async () => { throw new e.ExecutionVerificationError('binding', false) }
  await refused.controller.recover(owner, HASH1); assert.equal(a.createApprovalJournal(refused.storage).read(owner)[0].hash, undefined) // a hash that is not this approval is never attached
})
await test('status polling keeps the known status visible, backs off on read trouble, and stops on a deterministic answer', async () => {
  let n = 0
  const f = setup({ result: async () => { n++; throw new e.ExecutionVerificationError('rpc', true) } }); await f.controller.confirm(await f.review())
  const delays = []
  for (let i = 0; i < 9; i++) { await f.controller.reconcile(owner); delays.push(f.controller.view().nextCheckMs); assert.equal(f.controller.view().phase, 'pending'); assert.equal(f.controller.view().checking, false) }
  assert.deepEqual(delays, [5000, 10000, 20000, 40000, 60000, 60000, 60000, null, null]); assert.equal(f.controller.blocking(owner), true)
  const det = setup({ result: async () => { throw new e.ExecutionVerificationError('binding', false) } }); await det.controller.confirm(await det.review()); await det.controller.reconcile(owner)
  assert.equal(det.controller.view().nextCheckMs, null); assert.equal(det.controller.blocking(owner), true); assert.match(det.controller.view().error, /could not be verified/)
  const checking = []; const watch = setup({ result: async () => ({ status: 'pending' }) }); await watch.controller.confirm(await watch.review()); watch.views.length = 0; await watch.controller.reconcile(owner)
  assert.ok(watch.views.some(v => v.checking === true && v.phase === 'pending')); assert.equal(watch.views.every(v => v.phase === 'pending'), true) // the indicator changes, the status never flickers
  void checking
})
await test('stored approval records are validated like swap records: tampered, foreign or oversized data is refused, and the history is readable without a wallet', async () => {
  const f = setup({ result: async () => ({ status: 'settled', state: 'success', fee: '5', blockNumber: '9', bound: true, allowanceOk: true }) }); await f.controller.confirm(await f.review()); await f.controller.reconcile(owner)
  const key = `${a.APPROVAL_STORAGE_PREFIX}${owner.toLowerCase()}`, text = f.data.get(key), records = JSON.parse(text)
  const corrupt = change => { const copy = structuredClone(records); change(copy[0]); const d = new Map(f.data); d.set(key, JSON.stringify(copy)); return () => a.createApprovalJournal({ getItem: k => d.get(k) ?? null, setItem() {} }).read(owner) }
  assert.equal(corrupt(() => {})().length, 1)
  for (const [name, change] of [['amount no longer matches the transaction', r => { r.step.amount = '1' }], ['spender changed', r => { r.step.spender = other }], ['foreign owner', r => { r.owner = other }], ['unknown status', r => { r.status = 'done' }],
    ['unknown field', r => { r.extra = 1 }], ['bad hash', r => { r.hash = '0x1' }], ['data rewritten', r => { r.transaction.data = `${r.transaction.data}00` }], ['huge log', r => { r.log = Array(41).fill(r.log[0]) }]]) assert.throws(corrupt(change), /storage/, name)
  const listed = a.listStoredApprovals({ length: 1, key: () => key, getItem: k => f.data.get(k) ?? null }); assert.equal(listed.length, 1); assert.equal(listed[0].attempts[0].status, 'confirmed'); assert.equal(listed[0].unreadable, false)
  assert.equal(a.listStoredApprovals({ length: 1, key: () => key, getItem: () => '{broken' })[0].unreadable, true)
  assert.equal(a.listStoredApprovals({ length: 2, key: i => (i ? 'machina.other' : 'machina.uniswap.arc.approvals.v1:nonsense'), getItem: () => '[]' }).length, 0)
  const reload = setup({ data: f.data }); assert.equal(reload.controller.history(owner)[0].status, 'confirmed'); assert.equal(reload.controller.blocking(owner), false)
})

await test('a full approval journal archives its oldest settled record instead of deleting it; a refusing archive refuses the new record', () => {
  const step = a.planApprovals(request(), reads()).steps[0], tx = a.approvalTransaction(owner, step)
  const record = i => ({ id: `id-${i}`, owner, step, transaction: tx, nonce: i, status: 'confirmed', createdAt: i, gas: '1', maxFeePerGas: '1', maxPriorityFeePerGas: '0', networkFee: '1', hash: `0x${String(i).padStart(64, '0')}`, fee: '1', log: [] })
  const data = new Map(); let refuse = false
  const storage = { getItem: k => data.get(k) ?? null, setItem: (k, v) => { if (refuse && k.includes('archive')) throw Error('quota'); data.set(k, v) } }, journal = a.createApprovalJournal(storage)
  for (let i = 1; i <= 20; i++) journal.save(record(i))
  refuse = true; assert.throws(() => journal.save(record(21)), /storage/); assert.equal(journal.read(owner).length, 20); assert.equal(journal.read(owner)[0].id, 'id-1')
  refuse = false; journal.save(record(21)); assert.equal(journal.read(owner).length, 20); assert.deepEqual(journal.archived(owner).map(x => x.id), ['id-1'])
  const listed = a.listStoredApprovals({ length: data.size, key: i => [...data.keys()][i], getItem: k => data.get(k) ?? null }); assert.equal(listed.find(x => x.owner === owner.toLowerCase()).archived.length, 1)
})

// ---------------------------------------------------------------------------------------------------------------------------------------
// Public-RPC adapter
function rpcFixture(changes = {}) {
  const step = a.planApprovals(request(), reads()).steps[0], tx = a.approvalTransaction(owner, step), calls = []
  const attempt = { id: crypto.randomUUID(), owner, step, transaction: tx, nonce: 4, status: 'pending', createdAt: 1, gas: '69000', maxFeePerGas: '40000000000', maxPriorityFeePerGas: '0', networkFee: (69000n * 40_000_000_000n).toString(), hash: HASH1 }
  const chainTx = { hash: HASH1, from: owner, to: tx.to, chainId: 5042, nonce: 4, input: tx.data, value: 0n, gas: 69000n, maxFeePerGas: 40_000_000_000n, ...changes.tx }
  const receipt = { status: 'success', blockNumber: 100n, gasUsed: 46_000n, effectiveGasPrice: 21_000_000_000n, ...changes.receipt }
  const rpc = { getTransaction: async () => chainTx, getTransactionReceipt: async () => receipt, getBlockNumber: async () => 101n, readContract: async args => { calls.push(args); return changes.allowance ?? NEED }, ...changes.rpc }
  return { attempt, adapter: rpcModule.createApprovalRpc(rpc), calls, rpc }
}
await test('the adapter verifies hash, sender, nonce, target, calldata, value and the fee ceiling, then re-reads the allowance at the receipt block', async () => {
  const ok = rpcFixture(); const r = await ok.adapter.result(ok.attempt)
  assert.deepEqual(r, { status: 'settled', state: 'success', fee: (46_000n * 21_000_000_000n).toString(), blockNumber: '100', bound: true, allowanceOk: true }); assert.equal(ok.calls[0].blockNumber, 100n)
  const permitStep = historicalPermitStep, permitTx = a.approvalTransaction(owner, permitStep)
  const permit = rpcFixture({ allowance: [NEED, permitStep.expiration, 0] }); Object.assign(permit.attempt, { step: permitStep, transaction: permitTx }); permit.rpc.getTransaction = async () => ({ hash: HASH1, from: owner, to: permitTx.to, chainId: 5042, nonce: 4, input: permitTx.data, value: 0n, gas: 69000n, maxFeePerGas: 40_000_000_000n })
  assert.equal((await permit.adapter.result(permit.attempt)).allowanceOk, true)
  const wrongExpiry = rpcFixture({ allowance: [NEED, permitStep.expiration + 1, 0] }); Object.assign(wrongExpiry.attempt, { step: permitStep, transaction: permitTx }); wrongExpiry.rpc.getTransaction = permit.rpc.getTransaction
  assert.equal((await wrongExpiry.adapter.result(wrongExpiry.attempt)).allowanceOk, false)
})
await test('the adapter marks a succeeded transaction as not-bound when calldata, target, value or fee differ from the review; a different sender or nonce is not this attempt at all', async () => {
  const unbound = async changes => (await rpcFixture(changes).adapter.result(rpcFixture(changes).attempt)).bound
  assert.equal(await unbound({ tx: { input: `${rpcFixture().attempt.transaction.data}00` } }), false)
  assert.equal(await unbound({ tx: { to: other } }), false); assert.equal(await unbound({ tx: { value: 1n } }), false)
  assert.equal(await unbound({ tx: { maxFeePerGas: 400_000_000_000n } }), false) // wallet raised the fee ceiling beyond what was approved
  assert.equal(await unbound({ receipt: { effectiveGasPrice: 400_000_000_000n } }), false)
  assert.equal(await unbound({ receipt: { gasUsed: 70_000n } }), false)
  for (const changes of [{ tx: { from: other } }, { tx: { nonce: 5 } }, { tx: { chainId: 1 } }, { tx: { hash: HASH2 } }]) { const f = rpcFixture(changes); await assert.rejects(f.adapter.result(f.attempt), x => x instanceof e.ExecutionVerificationError && x.retryable === false) }
  const noHash = rpcFixture(); delete noHash.attempt.hash; await assert.rejects(noHash.adapter.result(noHash.attempt), x => x.retryable === false)
  const wrongAllowance = rpcFixture({ allowance: NEED + 1n }); assert.equal((await wrongAllowance.adapter.result(wrongAllowance.attempt)).allowanceOk, false)
})
await test('the adapter treats a not-yet-seen transaction or receipt as Pending, a revert as failed, and a read problem as retryable', async () => {
  const notFound = rpcFixture({ rpc: { getTransaction: async () => { throw Object.assign(Error('x'), { name: 'TransactionNotFoundError' }) } } }); assert.deepEqual(await notFound.adapter.result(notFound.attempt), { status: 'pending', identified: false })
  const noReceipt = rpcFixture({ rpc: { getTransactionReceipt: async () => { throw Object.assign(Error('x'), { name: 'TransactionReceiptNotFoundError' }) } } }); assert.deepEqual(await noReceipt.adapter.result(noReceipt.attempt), { status: 'pending', identified: true })
  const fresh = rpcFixture({ rpc: { getBlockNumber: async () => 100n } }); assert.deepEqual(await fresh.adapter.result(fresh.attempt), { status: 'pending', identified: true }) // needs one more block
  const reverted = rpcFixture({ receipt: { status: 'reverted' } }); const r = await reverted.adapter.result(reverted.attempt); assert.equal(r.state, 'reverted'); assert.equal(r.allowanceOk, false); assert.equal(reverted.calls.length, 0)
  for (const rpc of [{ getTransaction: async () => { throw Error('timeout') } }, { getTransactionReceipt: async () => { throw Error('timeout') } }, { getBlockNumber: async () => { throw Error('timeout') } }, { readContract: async () => { throw Error('timeout') } }]) {
    const f = rpcFixture({ rpc }); await assert.rejects(f.adapter.result(f.attempt), x => x instanceof e.ExecutionVerificationError && x.retryable === true)
  }
})
await test('the read adapter reports balance and allowances at one pinned block and refuses native USDC', async () => {
  const pinned = []
  const rpc = { getBlockNumber: async () => 55n, getBlock: async ({ blockNumber }) => { pinned.push(blockNumber); return { timestamp: TS, baseFeePerGas: 30n } },
    readContract: async ({ functionName, blockNumber, address }) => { pinned.push(blockNumber); return functionName === 'balanceOf' ? 9n : p.sameAddress(address, p.ARC_PERMIT2) ? [7n, 100, 1] : 8n },
    getBalance: async ({ blockNumber }) => { pinned.push(blockNumber); return 6n }, getGasPrice: async () => 20n,
    getTransactionCount: async ({ blockTag }) => (blockTag === 'pending' ? 6 : 5) }
  const adapter = rpcModule.createApprovalRpc(rpc), r = await adapter.reads(owner, 'EURC')
  assert.ok(pinned.every(b => b === 55n)); assert.equal(r.gasPrice, 30n); assert.equal(r.timestamp, TS); assert.equal(r.nativeBalance, 6n); assert.equal(r.balance, 9n); assert.equal(r.tokenAllowance, 8n); assert.equal(r.permitAmount, 7n); assert.equal(r.permitExpiration, 100n)
  await assert.rejects(adapter.reads(owner, 'USDC'), /not_needed/)
  assert.deepEqual(await adapter.nonces(owner), { nonce: 6, latestNonce: 5 })
  const moving = rpcModule.createApprovalRpc({ ...rpc, getTransactionCount: (() => { let n = 0; return async () => ++n })() }); await assert.rejects(moving.nonces(owner), /public_nonce/)
  assert.equal(await rpcModule.createApprovalRpc({ estimateGas: async args => { assert.equal(args.value, 0n); return 46_000n } }).estimate(a.approvalTransaction(owner, a.planApprovals(request(), reads()).steps[0])), 46_000n)
})
await test('this module can ask a wallet for nothing but the two approval shapes: it contains no signing, no other write method and no unlimited amounts', () => {
  const source = readFileSync(`${root}src/lib/swap/uniswapApprovals.ts`, 'utf8') + readFileSync(`${root}src/lib/swap/uniswapApprovalsRpc.ts`, 'utf8')
  const methods = [...source.matchAll(/method: '([a-z_A-Z0-9]+)'/g)].map(m => m[1]).filter(m => m.startsWith('eth_') || m.startsWith('personal_') || m.startsWith('wallet_'))
  assert.deepEqual([...new Set(methods)], ['eth_sendTransaction']); assert.equal((source.match(/eth_sendTransaction/g) ?? []).length, 1)
  assert.doesNotMatch(source, /signTypedData|eth_sign|personal_sign|setApprovalForAll|MaxUint|maxUint|2n \*\* 256n|0xffffffff/)
})
// --- Findings of the adversarial review ----------------------------------------------------------------------------------------
await test('an unresolved swap of the same wallet (either provider) holds approvals too: nothing is reviewed or requested while it is open', async () => {
  const held = setup(); held.world.held = true; await held.controller.prepare(request()); assert.equal(held.controller.view().phase, 'idle'); assert.match(held.controller.view().error, /still unresolved/); assert.equal(held.sent.length, 0)
  const later = setup(), id = await later.review(); later.world.held = true; await later.controller.confirm(id)
  assert.equal(later.sent.length, 0); assert.match(later.controller.view().error, /still unresolved/); assert.equal(later.data.size, 0) // nothing was recorded, nothing was requested
  const broken = setup({ blockedBy: () => { throw Error('journal unreadable') } }); await broken.controller.prepare(request()); assert.equal(broken.sent.length, 0); assert.match(broken.controller.view().error, /still unresolved/) // an unreadable answer counts as held
  const free = setup(); await free.review(); assert.equal(free.controller.view().phase, 'review')
})
await test('a hash the wallet returned stays visible and tracked even when the journal write that records it fails', async () => {
  let failures = 0; const f = setup({ onWrite: value => { if (failures === 0 && JSON.parse(value).some(record => record.hash)) { failures++; throw Error('quota') } },
    result: async () => ({ status: 'settled', state: 'success', fee: '1000', blockNumber: '9', bound: true, allowanceOk: true }) })
  await f.controller.confirm(await f.review())
  const view = f.controller.view(); assert.equal(failures, 1); assert.equal(view.phase, 'pending'); assert.equal(view.attempt.hash, HASH1); assert.match(view.error, /could not be saved/)
  assert.equal(a.createApprovalJournal(f.storage).read(owner)[0].hash, undefined); assert.equal(f.controller.blocking(owner), true)
  await f.controller.reconcile(owner); assert.equal(f.controller.view().phase, 'confirmed'); assert.equal(a.createApprovalJournal(f.storage).read(owner)[0].hash, HASH1); assert.equal(a.createApprovalJournal(f.storage).read(owner)[0].status, 'confirmed')
  const refused = setup({ onWrite: value => { if (JSON.parse(value).some(record => record.status === 'unknown')) throw Error('quota') }, sendError: Error('disconnected') }); await refused.controller.confirm(await refused.review())
  assert.equal(refused.controller.view().phase, 'unknown'); assert.equal(a.createApprovalJournal(refused.storage).read(owner)[0].status, 'awaiting_wallet'); assert.equal(refused.controller.blocking(owner), true) // the durable awaiting_wallet record still blocks
})
await test('approval journal: eviction skips a record this session could not re-verify; an archive entry that no longer validates is kept and counted, never fatal', async () => {
  const f = setup(), id = await f.review(); await f.controller.confirm(id); const base = a.createApprovalJournal(f.storage).read(owner)[0]
  const store = new Map(), pinned = new Set(), journal = a.createApprovalJournal({ getItem: k => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) }, x => pinned.has(x))
  const record = n => { const copy = structuredClone(base); delete copy.hash; delete copy.fee; delete copy.blockNumber; return { ...copy, id: `id-${n}`, status: 'rejected' } }
  for (let n = 1; n <= 20; n++) journal.save(record(n)); pinned.add('id-1'); journal.save(record(21))
  assert.ok(journal.read(owner).some(x => x.id === 'id-1')); assert.ok(!journal.read(owner).some(x => x.id === 'id-2')); assert.deepEqual(journal.archived(owner).map(x => x.id), ['id-2'])
  const archiveKey = `machina.uniswap.arc.approvals.archive.v1:${owner.toLowerCase()}`, activeKey = `${a.APPROVAL_STORAGE_PREFIX}${owner.toLowerCase()}`
  store.set(archiveKey, JSON.stringify([...JSON.parse(store.get(archiveKey)), { id: 'legacy', note: 'old' }])); assert.equal(journal.archiveUnreadable(owner), 1)
  journal.save(record(22)); assert.equal(journal.read(owner).length, 20); assert.ok(JSON.parse(store.get(archiveKey)).some(x => x.id === 'legacy'))
  const view = broken => ({ length: 2, key: i => [activeKey, archiveKey][i], getItem: k => (k === archiveKey && broken ? '{' : store.get(k) ?? null) })
  const listed = a.listStoredApprovals(view(false)); assert.equal(listed[0].attempts.length, 20); assert.equal(listed[0].archived.length, 2); assert.equal(listed[0].archiveUnreadable, 1); assert.equal(listed[0].unreadable, false)
  const damaged = a.listStoredApprovals(view(true)); assert.equal(damaged[0].attempts.length, 20); assert.deepEqual(damaged[0].archived, []); assert.equal(damaged[0].unreadable, true)
})
assert.equal(external, 0, 'no network request was made')
console.log(`${count} approval groups PASS. Controlled ports only; zero network, signatures, approvals or transactions.`)
