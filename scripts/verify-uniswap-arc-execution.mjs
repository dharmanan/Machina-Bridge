// Controlled EIP-1193, RPC, clock, storage and lock ports. No real signatures, sends or network.
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
const require = createRequire(import.meta.url), ts = require('typescript')
require.extensions['.ts'] = (mod, file) => mod._compile(ts.transpileModule(readFileSync(file, 'utf8'), { fileName: file,
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText, file)
const root = fileURLToPath(new URL('..', import.meta.url)), p = require(`${root}src/lib/uniswapArcPolicy.ts`)
const e = require(`${root}src/lib/uniswapArcExecution.ts`), { createArcExecutionRpc, assertExecutionReadMethod } = require(`${root}src/lib/uniswapArcExecutionRpc.ts`)
const fresh = require(`${root}scripts/fixtures/uniswap-arc/execution-review.cjs`)
const { decodeFunctionData, encodeEventTopics, encodeAbiParameters, parseAbiParameters, keccak256 } = require('viem')
const runtime = readFileSync(`${root}scripts/fixtures/uniswap-arc/router-runtime.hex`, 'utf8').trim()
let external = 0, count = 0
globalThis.fetch = async () => { external++; throw Error('network_forbidden') }
const owner = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266', other = '0x2222222222222222222222222222222222222222'
const hash = '0x' + 'a'.repeat(64), blockHash = '0x' + 'b'.repeat(64)
function setup(options = {}) {
  const data = options.data ?? new Map(), locks = options.locks ?? new Set(), seen = [], wallet = [], settled = []
  const clock = { now: Date.now() }, context = { owner, connected: true, chainId: 5042, connectorId: 'existing-wagmi-connector' }
  let input = p.validateArcRequest({ chainId: 5042, tokenIn: 'USDC', tokenOut: options.symbol ?? 'EURC', owner, recipient: owner, amount: options.amount ?? '1', minimumOutput: '1', slippageBps: 50, maxNetworkFee: '100000000000000000' })
  const stats = { quotes: 0, preflight: 0, results: 0, writes: 0 }
  const provider = { request: async args => {
    wallet.push(structuredClone(args))
    if (options.wallet) return options.wallet(args)
    if (args.method === 'eth_chainId') return '0x13b2'
    if (args.method === 'eth_accounts') return [owner]
    if (args.method === 'eth_getTransactionCount') return '0x7'
    if (args.method === 'eth_sendTransaction') return hash
    throw Error('unexpected_wallet_method')
  } }
  const ports = {
    context: () => context, input: () => input, fresh: async request => { stats.quotes++; return fresh(request, clock.now) }, quoteNow: () => clock.now,
    preflight: async review => { stats.preflight++; return options.preflight ? options.preflight(review, stats.preflight) : { nonce: 7 } },
    provider: async () => provider,
    result: async attempt => { stats.results++; return options.result ? options.result(attempt) : { status: 'pending' } },
    storage: { getItem: key => data.get(key) ?? null, setItem: (key, value) => { stats.writes++; if (options.write) options.write(stats.writes); data.set(key, value) } },
    lock: async (account, run) => { const key = account.toLowerCase(); if (locks.has(key)) throw Error('lock'); locks.add(key); try { return await run() } finally { locks.delete(key) } },
    enabled: options.enabled ?? (() => true), changed: view => seen.push(view), settled: attempt => settled.push(attempt),
    ...options.ports,
  }
  const controller = e.createUniswapArcExecution(ports)
  return { controller, clock, context, data, stats, seen, settled, ports, provider, wallet, setInput: next => { input = next },
    sent: () => wallet.filter(x => x.method === 'eth_sendTransaction'),
    async review() { await controller.prepare(); assert.equal(controller.current().phase, 'review', controller.current().error); return controller.current().approvalId },
  }
}
async function test(name, fn) { await fn(); count++; console.log(`PASS ${name}`) }
const waitFor = async predicate => { for (let i = 0; i < 100; i++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 1)) } assert.fail('Expected asynchronous state') }
await test('production source gate defaults false and blocks preparation, wallet and RPC', async () => {
  assert.equal(p.UNISWAP_ARC_WRITES_ENABLED, false)
  const f = setup({ ports: { enabled: undefined } }); await f.controller.prepare(); await f.controller.confirm('forged')
  assert.equal(f.stats.quotes, 0); assert.equal(f.stats.preflight, 0); assert.equal(f.sent().length, 0)
  assert.match(f.controller.current().error, /disabled/)
  await assert.rejects(p.submitUniswapArcSwap(), /writes_disabled/)
})
await test('both routes prepare from fresh API data, never an existing preview authorization', async () => {
  for (const symbol of ['EURC', 'cirBTC']) {
    const f = setup({ symbol, amount: '0.1' }); await f.review()
    assert.equal(f.stats.quotes, 1); assert.equal(f.stats.preflight, 1); assert.equal(f.wallet.length, 0)
    const view = f.controller.current(); assert.equal(view.review.request.tokenOut, symbol)
    assert.equal(view.review.executionBound, false); assert.equal(view.review.writesEnabled, false)
  }
})
await test('deadline only tightens; real V4/V3 economics, refund and exact unix suffix stay bound', async () => {
  for (const symbol of ['EURC', 'cirBTC']) {
    const f = setup({ symbol }); const original = fresh(f.ports.input(), f.clock.now); await f.review()
    const reviewed = f.controller.current().review
    const before = decodeFunctionData({ abi: p.EXECUTE_ABI, data: original.transaction.data }).args
    const after = decodeFunctionData({ abi: p.EXECUTE_ABI, data: reviewed.transaction.data }).args
    assert.equal(before[0], after[0]); assert.deepEqual(before[1], after[1]); assert.ok(after[2] < before[2])
    assert.ok(Number(after[2]) * 1000 < original.expiresAt)
    assert.equal(original.transaction.data.slice(-44), reviewed.transaction.data.slice(-44))
    assert.equal(reviewed.transaction.value, original.transaction.value)
    p.validateArcReview(reviewed, f.context, f.clock.now)
  }
})
await test('review, cancel and forged approval IDs never request a wallet transaction', async () => {
  const f = setup(); await f.review(); await f.controller.confirm('forged-id'); assert.equal(f.wallet.length, 0)
  f.controller.invalidate(); await f.controller.confirm(f.controller.current().approvalId); assert.equal(f.sent().length, 0)
})
await test('untrusted fresh quotes fail the existing economic policy before execution preflight', async () => {
  for (const mutate of [r => { r.transaction.to = other }, r => { r.transaction.data += '00' }, r => { r.transaction.value = '1' },
    r => { r.requiredMinimum = '1' }, r => { r.executionBound = true }, r => { r.request = { ...r.request, tokenOut: 'USDC' } }]) {
    const f = setup({ ports: { fresh: async input => { const r = fresh(input); mutate(r); return r } } })
    await f.controller.prepare(); assert.equal(f.stats.preflight, 0); assert.equal(f.sent().length, 0)
  }
})
await test('Confirm resimulates then sends one exact native EIP-1559 transaction with nonce and capped fees', async () => {
  for (const [symbol, amount] of [['EURC', '1'], ['EURC', '0.1'], ['cirBTC', '1'], ['cirBTC', '0.1']]) {
    const f = setup({ symbol, amount }); const id = await f.review(), reviewed = f.controller.current().review
    await f.controller.confirm(id)
    assert.equal(f.stats.preflight, 2); assert.equal(f.sent().length, 1)
    assert.deepEqual(f.sent()[0].params, [e.executionTransaction(reviewed, 7)])
    assert.deepEqual(f.wallet.map(x => x.method), ['eth_chainId', 'eth_accounts', 'eth_getTransactionCount', 'eth_sendTransaction'])
    assert.equal(f.controller.current().phase, 'pending')
  }
})
await test('editing a rendered review cannot mutate the private transaction to be sent', async () => {
  const f = setup(), id = await f.review(), view = f.controller.current()
  view.review.transaction.to = other; view.review.transaction.value = '0'; view.review.requiredMinimum = '1'
  await f.controller.confirm(id)
  assert.equal(f.sent()[0].params[0].to, p.ARC_ROUTER); assert.equal(f.sent()[0].params[0].value, '0xde0b6b3a7640000')
})
await test('wallet, chain, connector and amount changes invalidate prepared authority', async () => {
  for (const mutate of [f => { f.context.owner = other }, f => { f.context.chainId = 1 }, f => { f.context.connected = false }, f => { f.context.connectorId = 'other' },
    f => f.setInput({ ...f.ports.input(), amount: '2' }), f => f.setInput(null)]) {
    const f = setup(), id = await f.review(); mutate(f); await f.controller.confirm(id); assert.equal(f.sent().length, 0)
  }
})
await test('context change during final simulation cannot open a later wallet request', async () => {
  let release
  const f = setup({ preflight: async (_review, n) => { if (n === 2) await new Promise(resolve => { release = resolve }); return { nonce: 7 } } })
  const id = await f.review(), pending = f.controller.confirm(id)
  await waitFor(() => Boolean(release)); f.context.chainId = 1; f.controller.invalidate(); release(); await pending
  assert.equal(f.sent().length, 0)
})
await test('expired review, disabled gate and changed pending nonce stop before wallet write', async () => {
  let enabled = true
  for (const kind of ['expiry', 'gate', 'nonce']) {
    const f = setup({ enabled: () => enabled, preflight: async (_review, n) => ({ nonce: kind === 'nonce' && n === 2 ? 8 : 7 }) })
    const id = await f.review()
    if (kind === 'expiry') f.clock.now += 31000
    if (kind === 'gate') enabled = false
    await f.controller.confirm(id); assert.equal(f.sent().length, 0)
    enabled = true
  }
})
await test('wallet RPC chain, account and nonce are rechecked independently of React context', async () => {
  for (const [method, result] of [['eth_chainId', '0x1'], ['eth_accounts', [other]], ['eth_getTransactionCount', '0x8']]) {
    const f = setup(), original = f.provider.request
    f.provider.request = args => args.method === method ? Promise.resolve(result) : original(args)
    await f.controller.confirm(await f.review()); assert.equal(f.sent().length, 0)
  }
})
await test('double Confirm, repeated Prepare and a stale approval ID cannot submit twice', async () => {
  let release
  const f = setup(), original = f.provider.request
  f.provider.request = args => args.method === 'eth_sendTransaction' ? (f.wallet.push(args), new Promise(resolve => { release = resolve })) : original(args)
  const id = await f.review(), first = f.controller.confirm(id)
  await waitFor(() => Boolean(release)); await f.controller.confirm(id); await f.controller.prepare()
  assert.equal(f.sent().length, 1); assert.equal(f.stats.quotes, 1)
  release(hash); await first; await f.controller.confirm(id); assert.equal(f.sent().length, 1)
})
await test('cross-tab lock and durable journal block a second controller before another send', async () => {
  const data = new Map(), locks = new Set(), a = setup({ data, locks }), b = setup({ data, locks })
  const aid = await a.review(), bid = await b.review()
  await Promise.all([a.controller.confirm(aid), b.controller.confirm(bid)])
  assert.equal(a.sent().length + b.sent().length, 1)
  const reloaded = setup({ data, locks }); await reloaded.controller.prepare()
  assert.match(reloaded.controller.current().error, /unresolved/); assert.equal(reloaded.sent().length, 0)
})
await test('submission intent is durable before eth_sendTransaction, hash is recorded before chain lookup', async () => {
  const f = setup({ result: async attempt => {
    const records = e.createExecutionJournal(f.ports.storage).read(owner)
    assert.equal(records[0].hash, hash); assert.equal(attempt.hash, hash)
    return { status: 'pending' }
  } }), original = f.provider.request
  f.provider.request = async args => {
    if (args.method === 'eth_sendTransaction') assert.equal(e.createExecutionJournal(f.ports.storage).read(owner)[0].status, 'awaiting_wallet')
    return original(args)
  }
  await f.controller.confirm(await f.review())
  assert.equal(e.createExecutionJournal(f.ports.storage).read(owner)[0].hash, hash)
})
await test('blocked storage or corrupt records fail closed without a wallet request', async () => {
  const f = setup({ write: () => { throw Error('quota') } })
  await f.controller.confirm(await f.review()); assert.equal(f.sent().length, 0)
  const corrupt = setup({ data: new Map([[`machina.uniswap.arc.execution.v1:${owner.toLowerCase()}`, '{']]) })
  await corrupt.controller.prepare(); assert.equal(corrupt.sent().length, 0); assert.match(corrupt.controller.current().error, /recording/)
})
await test('invalidation immediately after durable intent recording still prevents a wallet request', async () => {
  const f = setup({ write: n => { if (n === 1) f.controller.invalidate() } })
  await f.controller.confirm(await f.review()); assert.equal(f.sent().length, 0)
  assert.equal(e.createExecutionJournal(f.ports.storage).read(owner)[0].status, 'rejected')
})
await test('post-broadcast storage failure retains the hash in memory and durable unresolved intent', async () => {
  const f = setup({ write: n => { if (n > 1) throw Error('quota-after-broadcast') } })
  await f.controller.confirm(await f.review())
  assert.equal(f.sent().length, 1); assert.equal(f.controller.current().attempt.hash, hash)
  assert.equal(e.createExecutionJournal(f.ports.storage).read(owner)[0].status, 'awaiting_wallet')
  await f.controller.prepare(); assert.equal(f.sent().length, 1)
})
await test('wallet rejection is distinct from ambiguous transport errors and neither auto-retries', async () => {
  for (const code of [4001, -32000]) {
    const f = setup(), original = f.provider.request
    f.provider.request = args => args.method === 'eth_sendTransaction' ? (f.wallet.push(args), Promise.reject({ code, message: 'sensitive-provider-detail' })) : original(args)
    await f.controller.confirm(await f.review())
    assert.equal(f.controller.current().phase, code === 4001 ? 'rejected' : 'unknown')
    assert.equal(JSON.stringify(f.controller.current()).includes('sensitive-provider-detail'), false)
    if (code !== 4001) { await f.controller.prepare(); assert.equal(f.sent().length, 1) }
  }
})
await test('invalid hash and interrupted awaiting-wallet state remain unresolved after reload', async () => {
  const f = setup(), original = f.provider.request
  f.provider.request = args => args.method === 'eth_sendTransaction' ? Promise.resolve('not-a-hash') : original(args)
  await f.controller.confirm(await f.review()); assert.equal(f.controller.current().phase, 'unknown')
  const reload = setup({ data: f.data }); await reload.controller.reconcile()
  assert.equal(reload.controller.current().phase, 'unknown'); await reload.controller.prepare(); assert.equal(reload.stats.quotes, 0)
})
await test('late hash after wallet/network change is still recorded under the original wallet', async () => {
  let release
  const f = setup(), original = f.provider.request
  f.provider.request = args => args.method === 'eth_sendTransaction' ? new Promise(resolve => { release = resolve }) : original(args)
  const pending = f.controller.confirm(await f.review()); await waitFor(() => Boolean(release))
  f.context.owner = other; f.controller.invalidate(); release(hash); await pending
  assert.equal(e.createExecutionJournal(f.ports.storage).read(owner)[0].hash, hash)
  assert.deepEqual(e.createExecutionJournal(f.ports.storage).read(other), [])
})
await test('pending receipt and RPC errors never become Failed or Confirmed', async () => {
  const f = setup({ result: async () => { throw Error('timeout-sensitive-detail') } })
  await f.controller.confirm(await f.review()); assert.equal(f.controller.current().phase, 'unknown')
  assert.equal(f.controller.current().attempt.hash, hash)
  const reload = setup({ data: f.data }); await reload.controller.reconcile(); assert.equal(reload.controller.current().phase, 'pending')
})
await test('confirmed and reverted results persist, refresh balances and survive a read-only reload', async () => {
  for (const status of ['confirmed', 'failed']) {
    const result = async attempt => ({ status, output: status === 'confirmed' ? attempt.review.requiredMinimum : '0', fee: '100000000000000' })
    const f = setup({ result }); await f.controller.confirm(await f.review())
    assert.equal(f.controller.current().phase, status); assert.equal(f.settled.length, 1)
    const reload = setup({ data: f.data, result, enabled: () => false }); await reload.controller.reconcile()
    assert.equal(reload.controller.current().phase, status); assert.equal(reload.sent().length, 0)
  }
})
await test('a persisted Confirmed status is rechecked rather than trusted after reload', async () => {
  const f = setup({ result: async attempt => ({ status: 'confirmed', output: attempt.review.requiredMinimum, fee: '0' }) })
  await f.controller.confirm(await f.review())
  const reload = setup({ data: f.data, result: async () => { throw Error('rpc-down') } }); await reload.controller.reconcile()
  assert.equal(reload.controller.current().phase, 'unknown')
})
await test('a formerly confirmed transaction becoming Pending again is durably unresolved', async () => {
  const f = setup({ result: async attempt => ({ status: 'confirmed', output: attempt.review.requiredMinimum, fee: '0' }) })
  await f.controller.confirm(await f.review())
  const reload = setup({ data: f.data }); await reload.controller.reconcile(); await reload.controller.prepare()
  assert.match(reload.controller.current().error, /unresolved/)
  assert.equal(e.createExecutionJournal(reload.ports.storage).read(owner)[0].status, 'pending')
})
await test('hash recovery is read-only and cannot restore a serialized send authorization', async () => {
  const f = setup(), original = f.provider.request
  f.provider.request = args => args.method === 'eth_sendTransaction' ? Promise.reject(Error('disconnected')) : original(args)
  await f.controller.confirm(await f.review())
  const reload = setup({ data: f.data }); await reload.controller.reconcile(owner, hash)
  assert.equal(reload.controller.current().attempt.hash, hash); assert.equal(reload.sent().length, 0)
  await reload.controller.confirm(e.createExecutionJournal(reload.ports.storage).read(owner)[0].id); assert.equal(reload.sent().length, 0)
})

function rpcFixture(symbol = 'EURC', changes = {}) {
  const request = setup({ symbol }).ports.input(), review = e.tightenExecutionReview(fresh(request), { owner, connected: true, chainId: 5042, connectorId: 'c' }, Date.now())
  const attempt = { id: crypto.randomUUID(), review, nonce: 7, status: 'pending', hash, createdAt: Date.now() }, expected = e.executionTransaction(review, 7)
  const tx = { hash, from: owner, to: p.ARC_ROUTER, chainId: 5042, nonce: 7, type: 'eip1559', input: expected.data, value: BigInt(expected.value), gas: BigInt(expected.gas), maxFeePerGas: BigInt(expected.maxFeePerGas), maxPriorityFeePerGas: 0n }
  const topics = encodeEventTopics({ abi: [{ type: 'event', name: 'Transfer', inputs: [{ name: 'from', type: 'address', indexed: true }, { name: 'to', type: 'address', indexed: true }, { name: 'value', type: 'uint256', indexed: false }] }], eventName: 'Transfer', args: { from: p.ARC_ROUTER, to: owner } })
  const receipt = { transactionHash: hash, from: owner, to: p.ARC_ROUTER, blockNumber: 100n, blockHash, transactionIndex: 0, gasUsed: 100000n, effectiveGasPrice: 1000000000n, status: 'success', logs: [
    { address: p.ARC_OUTPUTS[symbol].address, topics, data: encodeAbiParameters(parseAbiParameters('uint256'), [BigInt(review.requiredMinimum)]), removed: false, transactionHash: hash, blockHash, blockNumber: 100n, logIndex: 0, transactionIndex: 0 },
  ] }
  const calls = [], rpc = {
    getChainId: async () => 5042, getBlockNumber: async () => 101n,
    getBlock: async () => ({ hash: blockHash, timestamp: BigInt(Math.floor(Date.now() / 1000)), baseFeePerGas: 1000000000n }),
    getCode: async ({ address }) => p.sameAddress(address, p.ARC_ROUTER) ? runtime : p.sameAddress(address, owner) ? undefined : '0x6000',
    readContract: async () => p.ARC_OUTPUTS[symbol].decimals, getBalance: async () => 10n ** 20n, getGasPrice: async () => 1000000000n,
    call: async args => { calls.push(['call', args]); return { data: '0x' } }, estimateGas: async args => { calls.push(['estimateGas', args]); return 100000n },
    getTransactionCount: async () => 7, getTransaction: async () => tx, getTransactionReceipt: async () => receipt, ...changes,
  }
  return { attempt, review, tx, receipt, rpc, calls, adapter: createArcExecutionRpc(rpc) }
}
await test('actual preflight adapter rechecks both routes, runtime, decimals, balances, fees, gas and exact simulation', async () => {
  for (const symbol of ['EURC', 'cirBTC']) {
    const f = rpcFixture(symbol); assert.deepEqual(await f.adapter.preflight(f.review), { nonce: 7 })
    assert.equal(f.calls[0][1].data, f.review.transaction.data); assert.equal(f.calls[0][1].value, 10n ** 18n)
    assert.equal(f.calls[0][1].stateOverride, undefined); assert.equal(f.calls[0][1].gas, 130000n)
  }
})
await test('wrong RPC chain, router/token/decimals, EOA code, balance, fee, gas and simulation fail preflight', async () => {
  const failures = [
    { getChainId: async () => 1 }, { getCode: async () => '0x6000' }, { readContract: async () => 18 },
    { getBalance: async () => 1n }, { getGasPrice: async () => 3000000000n }, { estimateGas: async () => 130001n },
    { call: async () => { throw Error('revert') } }, { getTransactionCount: async () => -1 },
    { getBlock: async () => ({ timestamp: 999999999999n, baseFeePerGas: 1n }) },
  ]
  for (const delta of failures) { const f = rpcFixture('EURC', delta); await assert.rejects(f.adapter.preflight(f.review)) }
  const contract = rpcFixture(); contract.rpc.getCode = async ({ address }) => p.sameAddress(address, p.ARC_ROUTER) ? runtime : '0x6000'
  await assert.rejects(contract.adapter.preflight(contract.review), /smart_wallet/)
})
await test('receipt success requires exact transaction binding, two observed blocks and actual output Transfer logs', async () => {
  for (const symbol of ['EURC', 'cirBTC']) {
    const f = rpcFixture(symbol), result = await f.adapter.result(f.attempt)
    assert.equal(result.status, 'confirmed'); assert.equal(result.output, f.review.requiredMinimum); assert.equal(result.fee, '100000000000000')
  }
})
await test('wrong hash/from/router/value/calldata/nonce/chain/gas/fees/type cannot report success', async () => {
  for (const delta of [{ hash: '0x' + 'c'.repeat(64) }, { from: other }, { to: other }, { value: 1n }, { input: '0x' }, { nonce: 8 }, { chainId: 1 }, { gas: 130001n }, { maxFeePerGas: 3000000000n }, { maxPriorityFeePerGas: 1n }, { type: 'legacy' }]) {
    const f = rpcFixture(); Object.assign(f.tx, delta); await assert.rejects(f.adapter.result(f.attempt))
  }
})
await test('success status without enough output to the correct recipient/token is not a successful swap', async () => {
  for (const change of ['none', 'low', 'recipient', 'token', 'outgoing']) {
    const f = rpcFixture(), log = f.receipt.logs[0]
    if (change === 'none') f.receipt.logs = []
    if (change === 'low') log.data = '0x' + '0'.repeat(63) + '1'
    if (change === 'recipient') log.topics[2] = '0x' + other.slice(2).padStart(64, '0')
    if (change === 'token') log.address = p.ARC_OUTPUTS.cirBTC.address
    if (change === 'outgoing') log.topics = [log.topics[0], log.topics[2], log.topics[1]]
    await assert.rejects(f.adapter.result(f.attempt))
  }
})
await test('duplicated or cross-transaction Transfer logs cannot inflate verified output', async () => {
  for (const kind of ['duplicate', 'hash', 'block', 'index']) {
    const f = rpcFixture(), log = f.receipt.logs[0]
    if (kind === 'duplicate') f.receipt.logs.push(structuredClone(log))
    if (kind === 'hash') log.transactionHash = '0x' + 'c'.repeat(64)
    if (kind === 'block') log.blockHash = '0x' + 'c'.repeat(64)
    if (kind === 'index') log.transactionIndex = 1
    await assert.rejects(f.adapter.result(f.attempt))
  }
})
await test('reverts are Failed; missing receipt, insufficient confirmations and reorg remain Pending', async () => {
  const reverted = rpcFixture(); reverted.receipt.status = 'reverted'; assert.equal((await reverted.adapter.result(reverted.attempt)).status, 'failed')
  for (const changes of [{ getTransactionReceipt: async () => { throw Object.assign(Error('not found'), { name: 'TransactionReceiptNotFoundError' }) } },
    { getBlockNumber: async () => 100n }, { getBlock: async () => ({ hash: '0x' + 'c'.repeat(64) }) }]) {
    const f = rpcFixture('EURC', changes); assert.equal((await f.adapter.result(f.attempt)).status, 'pending')
  }
})
await test('receipt block identity and spent gas cannot exceed the approved transaction budget', async () => {
  for (const delta of [{ transactionHash: '0x' + 'c'.repeat(64) }, { from: other }, { to: other }, { gasUsed: 130001n }, { effectiveGasPrice: 3000000000n }]) {
    const f = rpcFixture(); Object.assign(f.receipt, delta); await assert.rejects(f.adapter.result(f.attempt))
  }
})
await test('read-only RPC allowlist never permits signing, sends, approvals or arbitrary wallet calls', () => {
  for (const method of ['eth_sendTransaction', 'eth_sendRawTransaction', 'personal_sign', 'eth_signTypedData_v4', 'wallet_sendCalls', 'eth_requestAccounts', 'debug_traceCall', 'evm_mine']) assert.throws(() => assertExecutionReadMethod(method), /read_only_rpc/)
  for (const method of ['eth_chainId', 'eth_getTransactionCount', 'eth_getTransactionReceipt']) assertExecutionReadMethod(method)
})
assert.equal(external, 0)
console.log(`${count} Uniswap execution/security groups PASS. Synthetic wallet requests and RPC only; zero live signatures, sends, approvals or transfers.`)
