// Controlled EIP-1193, RPC, clock, storage and lock ports. No real signatures, sends or network.
import assert from 'node:assert/strict'
import { mock } from 'node:test'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
const require = createRequire(import.meta.url), ts = require('typescript')
require.extensions['.ts'] = (mod, file) => mod._compile(ts.transpileModule(readFileSync(file, 'utf8'), { fileName: file,
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText, file)
const root = fileURLToPath(new URL('..', import.meta.url)), p = require(`${root}src/lib/uniswapArcPolicy.ts`)
const e = require(`${root}src/lib/uniswapArcExecution.ts`), { createArcExecutionRpc, assertExecutionReadMethod } = require(`${root}src/lib/uniswapArcExecutionRpc.ts`)
const pilot = require(`${root}src/lib/uniswapArcPilot.ts`)
const fresh = require(`${root}scripts/fixtures/uniswap-arc/execution-review.cjs`)
const evidence = require(`${root}src/lib/swap/transactionEvidence.ts`)
const { decodeFunctionData, decodeAbiParameters, encodeFunctionData, encodeEventTopics, encodeAbiParameters, parseAbiParameters, keccak256 } = require('viem')
const runtime = readFileSync(`${root}scripts/fixtures/uniswap-arc/router-runtime.hex`, 'utf8').trim()
let external = 0, count = 0
globalThis.fetch = async () => { external++; throw Error('network_forbidden') }
const owner = '0xafbB6Cc5C0a9C0eB1BfF8dB2eD807e83aAB8e321', other = '0x2222222222222222222222222222222222222222'
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
    preflight: async review => { stats.preflight++; return options.preflight ? options.preflight(review, stats.preflight) : { nonce: 7, latestNonce: 7 } },
    provider: async () => provider,
    result: async (attempt, submitted) => { stats.results++; return options.result ? options.result(attempt, submitted) : { status: 'pending' } },
    storage: { getItem: key => data.get(key) ?? null, setItem: (key, value) => { stats.writes++; if (options.write) options.write(stats.writes); data.set(key, value) } },
    lock: async (account, run) => { const key = account.toLowerCase(); if (locks.has(key)) throw Error('lock'); locks.add(key); try { return await run() } finally { locks.delete(key) } },
    // Generic engine scenarios retain both route profiles. Pilot authorization is tested separately below.
    authorize: () => true,
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
function withDeadline(review, seconds) {
  const args = decodeFunctionData({ abi: p.EXECUTE_ABI, data: review.transaction.data }).args
  const canonical = encodeFunctionData({ abi: p.EXECUTE_ABI, functionName: 'execute', args })
  review.transaction.data = encodeFunctionData({ abi: p.EXECUTE_ABI, functionName: 'execute', args: [args[0], args[1], BigInt(Math.floor(review.requestStartedAt / 1000) + seconds)] }) + review.transaction.data.slice(canonical.length)
  return review
}
await test('approved source gate still blocks preparation without pilot authorization', async () => {
  assert.equal(p.UNISWAP_ARC_WRITES_ENABLED, true)
  const f = setup({ ports: { enabled: undefined, authorize: undefined } }); await f.controller.prepare(); await f.controller.confirm('forged')
  assert.equal(f.stats.quotes, 0); assert.equal(f.stats.preflight, 0); assert.equal(f.sent().length, 0)
  assert.match(f.controller.current().error, /pilot/)
  await assert.rejects(p.submitUniswapArcSwap(), /writes_disabled/)
})
await test('pilot config is default off; missing, malformed, zero, router or non-exact enabled flags fail closed', () => {
  for (const [flag, wallet] of [[undefined, undefined], ['true', undefined], ['true', 'bad'], ['true', '0x' + '0'.repeat(40)], ['true', p.ARC_ROUTER], ['true', '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266'], ['TRUE', owner], ['false', owner], [' true ', owner]]) {
    assert.equal(pilot.arcPilotConfig(flag, wallet).enabled, false)
  }
  assert.equal(pilot.arcPilotConfig('true', owner).enabled, true)
})
await test('pilot permits only configured-wallet native USDC to EURC at or below 0.1 USDC', async () => {
  const config = pilot.arcPilotConfig('true', owner)
  for (const amount of ['0.1', '0.100000', '0.01']) {
    const f = setup({ amount, ports: { authorize: (input, context) => pilot.arcPilotAllows(config, input, context) } })
    await f.controller.confirm(await f.review()); assert.equal(f.sent().length, 1)
    assert.ok(BigInt(f.sent()[0].params[0].value) <= pilot.ARC_PILOT_MAX_INPUT)
  }
})
await test('wrong wallet, chain, direction, recipient and over-limit input cannot request even a fresh execution quote', async () => {
  const config = pilot.arcPilotConfig('true', owner)
  for (const mutate of [f => f.setInput({ ...f.ports.input(), amount: '0.100001' }), f => f.setInput({ ...f.ports.input(), tokenOut: 'cirBTC' }),
    f => { f.context.owner = other }, f => { f.context.chainId = 1 }, f => { f.context.connected = false },
    f => f.setInput({ ...f.ports.input(), recipient: other }), f => f.setInput({ ...f.ports.input(), owner: other, recipient: other }),
    f => f.setInput({ ...f.ports.input(), tokenIn: 'EURC' }), f => f.setInput(null)]) {
    const f = setup({ amount: '0.1', ports: { authorize: (input, context) => pilot.arcPilotAllows(config, input, context) } })
    mutate(f); await f.controller.prepare()
    assert.equal(f.stats.quotes, 0); assert.equal(f.sent().length, 0); assert.match(f.controller.current().error, /pilot/)
  }
})
await test('no authorization callback or disabled pilot blocks execution even with a test-open release gate', async () => {
  for (const authorize of [undefined, (input, context) => pilot.arcPilotAllows(pilot.arcPilotConfig('false', owner), input, context)]) {
    const f = setup({ amount: '0.1', ports: { authorize } })
    await f.controller.prepare(); assert.equal(f.stats.quotes, 0); assert.equal(f.sent().length, 0)
  }
})
await test('configured pilot cannot bypass an explicitly closed source gate', async () => {
  const config = pilot.arcPilotConfig('true', owner)
  const f = setup({ amount: '0.1', ports: { enabled: () => false, authorize: (input, context) => pilot.arcPilotAllows(config, input, context) } })
  await f.controller.prepare(); assert.equal(f.stats.quotes, 0); assert.equal(f.sent().length, 0); assert.match(f.controller.current().error, /disabled/)
})
await test('production source gate permits only approved-wallet pilot configuration; forged configuration fails closed', async () => {
  assert.equal(pilot.ARC_PILOT_APPROVED_WALLET, owner)
  const config = pilot.arcPilotConfig('true', owner.toLowerCase())
  assert.equal(config.wallet, owner)
  const f = setup({ amount: '0.1', ports: { enabled: undefined, authorize: (input, context) => pilot.arcPilotAllows(config, input, context) } })
  await f.controller.confirm(await f.review()); assert.equal(f.sent().length, 1)
  assert.equal(pilot.arcPilotAllows({ enabled: true, wallet: other }, { ...f.ports.input(), owner: other, recipient: other }, { ...f.context, owner: other }), false)
  const closed = setup({ amount: '0.1', ports: { enabled: undefined, authorize: (input, context) => pilot.arcPilotAllows(pilot.arcPilotConfig(), input, context) } })
  await closed.controller.prepare(); assert.equal(closed.stats.quotes, 0); assert.equal(closed.sent().length, 0)
})
await test('being inside the pilot amount limit never overrides an unrepresentable economic output floor', async () => {
  const config = pilot.arcPilotConfig('true', owner)
  const f = setup({ amount: '0.000001', ports: { authorize: (input, context) => pilot.arcPilotAllows(config, input, context) } })
  assert.equal(pilot.arcPilotAllows(config, f.ports.input(), f.context), true)
  await f.controller.prepare(); assert.equal(f.controller.current().phase, 'idle'); assert.equal(f.sent().length, 0)
})
await test('pilot authorization is rechecked after review and during final simulation; closing it never sends', async () => {
  for (const stage of ['after_review', 'during_preflight']) {
    let config = pilot.arcPilotConfig('true', owner)
    const f = setup({ amount: '0.1', preflight: async (_review, n) => { if (stage === 'during_preflight' && n === 2) config = pilot.arcPilotConfig('false', owner); return { nonce: 7, latestNonce: 7 } },
      ports: { authorize: (input, context) => pilot.arcPilotAllows(config, input, context) } })
    const id = await f.review()
    if (stage === 'after_review') config = pilot.arcPilotConfig('true', other)
    await f.controller.confirm(id); assert.equal(f.sent().length, 0); assert.match(f.controller.current().error, /pilot/)
  }
})
await test('both routes prepare from fresh API data, never an existing preview authorization', async () => {
  for (const symbol of ['EURC', 'cirBTC']) {
    const f = setup({ symbol, amount: '0.1' }); await f.review()
    assert.equal(f.stats.quotes, 1); assert.equal(f.stats.preflight, 1); assert.equal(f.sent().length, 0)
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
    assert.equal(before[0], after[0]); assert.deepEqual(before[1], after[1]); assert.ok(after[2] <= before[2])
    assert.ok(Number(after[2]) * 1000 > original.expiresAt)
    assert.ok(Number(after[2]) * 1000 <= original.requestStartedAt + e.EXECUTION_DEADLINE_WINDOW_MS)
    assert.equal(reviewed.expiresAt, original.expiresAt)
    assert.equal(reviewed.requiredMinimum, original.requiredMinimum); assert.deepEqual(reviewed.request, original.request)
    assert.equal(original.transaction.data.slice(-44), reviewed.transaction.data.slice(-44))
    assert.equal(reviewed.transaction.value, original.transaction.value)
    p.validateArcReview(reviewed, f.context, f.clock.now)
  }
})
await test('deadline cap never extends Uniswap original deadline or changes the 30-second quote freshness', () => {
  const f = setup()
  for (const seconds of [20, 45, 60, 120, 600]) {
    const original = withDeadline(fresh(f.ports.input(), f.clock.now), seconds)
    const reviewed = e.tightenExecutionReview(original, f.context, f.clock.now)
    assert.equal(e.executionDeadlineMs(reviewed), Math.floor(f.clock.now / 1000) * 1000 + Math.min(seconds, 120) * 1000)
    assert.equal(reviewed.expiresAt, f.clock.now + 30000)
    assert.equal(reviewed.requiredMinimum, original.requiredMinimum)
  }
})
await test('an original deadline without at least 30 seconds for approval plus 15 for inclusion blocks wallet access', async () => {
  const f = setup({ ports: { fresh: async input => withDeadline(fresh(input, f.clock.now), 44) } })
  await f.controller.prepare(); assert.equal(f.controller.current().phase, 'idle'); assert.match(f.controller.current().error, /expired/)
  assert.equal(f.sent().length, 0)
})
await test('quote expiry during final simulation still prevents opening a wallet request', async () => {
  const f = setup({ preflight: async (_review, n) => { if (n === 2) f.clock.now += 31000; return { nonce: 7, latestNonce: 7 } } })
  await f.controller.confirm(await f.review()); assert.equal(f.sent().length, 0); assert.match(f.controller.current().error, /expired/)
})
await test('45-second wallet approval outlives the quote TTL while preserving the exact approved transaction on both routes', async () => {
  for (const symbol of ['EURC', 'cirBTC']) {
    let release
    const f = setup({ symbol }), original = f.provider.request, id = await f.review()
    f.provider.request = args => args.method === 'eth_sendTransaction' ? (f.wallet.push(args), new Promise(resolve => { release = resolve })) : original(args)
    mock.timers.enable({ apis: ['setTimeout'] })
    try {
      const pending = f.controller.confirm(id)
      for (let i = 0; i < 100 && !release; i++) await Promise.resolve()
      assert.ok(release); const transaction = structuredClone(f.sent()[0].params[0])
      f.clock.now += 45000; mock.timers.tick(45000)
      assert.equal(f.controller.current().phase, 'awaiting_wallet')
      assert.ok(e.executionDeadlineMs(f.controller.current().attempt.review) > f.clock.now)
      release(hash); await pending
      assert.equal(f.controller.current().phase, 'pending'); assert.equal(f.controller.current().attempt.hash, hash)
      assert.deepEqual(f.sent()[0].params[0], transaction); assert.equal(f.stats.preflight, 2); assert.equal(f.sent().length, 1)
    } finally { mock.timers.reset() }
  }
})
await test('bounded approval timeout persists Unknown, keeps the lock, blocks retries and captures even a post-deadline hash', async () => {
  let release
  const data = new Map(), locks = new Set(), f = setup({ data, locks }), original = f.provider.request, id = await f.review()
  f.provider.request = args => args.method === 'eth_sendTransaction' ? (f.wallet.push(args), new Promise(resolve => { release = resolve })) : original(args)
  mock.timers.enable({ apis: ['setTimeout'] })
  try {
    const pending = f.controller.confirm(id)
    for (let i = 0; i < 100 && !release; i++) await Promise.resolve()
    assert.ok(release); const window = f.controller.current().walletWindowMs
    assert.ok(window >= 30000 && window <= 105000)
    mock.timers.tick(window - 1); assert.equal(f.controller.current().phase, 'awaiting_wallet')
    mock.timers.tick(1); assert.equal(f.controller.current().phase, 'unknown')
    assert.match(f.controller.current().error, /Cancel the open request.*cannot cancel.*charge gas/)
    assert.equal(e.createExecutionJournal(f.ports.storage).read(owner)[0].status, 'unknown')
    assert.equal(locks.has(owner.toLowerCase()), true)
    f.controller.invalidate(); await f.controller.prepare(); await f.controller.confirm(id)
    const second = setup({ data, locks }); await second.controller.prepare()
    assert.equal(f.sent().length, 1); assert.equal(second.stats.quotes, 0); assert.equal(second.sent().length, 0)
    f.clock.now += 130000; mock.timers.tick(130000)
    release(hash); await pending
    assert.equal(f.controller.current().phase, 'pending'); assert.equal(f.controller.current().attempt.hash, hash)
    assert.equal(e.createExecutionJournal(f.ports.storage).read(owner)[0].hash, hash)
    assert.equal(locks.size, 0); assert.equal(f.sent().length, 1)
  } finally { mock.timers.reset() }
})
await test('a wallet rejection after the approval cutoff is recorded as Rejected without retry', async () => {
  let reject
  const f = setup(), original = f.provider.request, id = await f.review()
  f.provider.request = args => args.method === 'eth_sendTransaction' ? (f.wallet.push(args), new Promise((_resolve, fail) => { reject = fail })) : original(args)
  mock.timers.enable({ apis: ['setTimeout'] })
  try {
    const pending = f.controller.confirm(id)
    for (let i = 0; i < 100 && !reject; i++) await Promise.resolve()
    assert.ok(reject); mock.timers.tick(120000)
    assert.equal(f.controller.current().phase, 'unknown')
    reject({ code: 4001 }); await pending
    assert.equal(f.controller.current().phase, 'rejected'); assert.equal(f.sent().length, 1)
    assert.equal(e.createExecutionJournal(f.ports.storage).read(owner)[0].status, 'rejected')
    mock.timers.tick(120000); assert.equal(f.controller.current().phase, 'rejected')
  } finally { mock.timers.reset() }
})
await test('review, cancel and forged approval IDs never request a wallet transaction', async () => {
  const f = setup(); await f.review(); await f.controller.confirm('forged-id'); assert.equal(f.sent().length, 0)
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
    assert.deepEqual(f.wallet.map(x => x.method), [...Array(2).fill(['eth_chainId', 'eth_accounts', 'eth_getTransactionCount', 'eth_getTransactionCount', 'eth_getTransactionCount', 'eth_chainId', 'eth_accounts']).flat(), 'eth_sendTransaction'])
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
  const f = setup({ preflight: async (_review, n) => { if (n === 2) await new Promise(resolve => { release = resolve }); return { nonce: 7, latestNonce: 7 } } })
  const id = await f.review(), pending = f.controller.confirm(id)
  await waitFor(() => Boolean(release)); f.context.chainId = 1; f.controller.invalidate(); release(); await pending
  assert.equal(f.sent().length, 0)
})
await test('expired review, disabled gate and changed pending nonce stop before wallet write', async () => {
  let enabled = true
  for (const kind of ['expiry', 'gate', 'nonce']) {
    const f = setup({ enabled: () => enabled, preflight: async (_review, n) => ({ nonce: kind === 'nonce' && n === 2 ? 8 : 7, latestNonce: kind === 'nonce' && n === 2 ? 8 : 7 }) })
    const id = await f.review()
    if (kind === 'expiry') f.clock.now += 31000
    if (kind === 'gate') enabled = false
    await f.controller.confirm(id); assert.equal(f.sent().length, 0)
    enabled = true
  }
})
await test('wallet RPC chain, account and nonce are rechecked independently of React context', async () => {
  for (const [method, result] of [['eth_chainId', '0x1'], ['eth_accounts', [other]], ['eth_getTransactionCount', '0x8']]) {
    const f = setup(), original = f.provider.request, id = await f.review()
    f.provider.request = args => args.method === method ? Promise.resolve(result) : original(args)
    await f.controller.confirm(id); assert.equal(f.sent().length, 0)
  }
})
await test('nonce reconciliation requires exact latest/pending agreement and rejects occupied nonces', () => {
  for (const nonce of [0, 7, 12, Number.MAX_SAFE_INTEGER]) {
    assert.equal(e.reconcileExecutionNonce({ nonce, latestNonce: nonce }, { nonce, latestNonce: nonce }, nonce), nonce)
  }
  assert.throws(() => e.reconcileExecutionNonce({ nonce: 8, latestNonce: 7 }, { nonce: 8, latestNonce: 7 }), /^Error: nonce_pending$/)
  assert.throws(() => e.reconcileExecutionNonce({ nonce: 7, latestNonce: 7 }, { nonce: 8, latestNonce: 7 }), /^Error: nonce_rpc$/)
  assert.throws(() => e.reconcileExecutionNonce({ nonce: 8, latestNonce: 8 }, { nonce: 8, latestNonce: 8 }, 7), /^Error: nonce$/)
})
await test('persistent RPC disagreement is rejected during Review, with safe nonce diagnostics and no review loop', async () => {
  const f = setup(), original = f.provider.request
  f.provider.request = args => args.method === 'eth_getTransactionCount' ? Promise.resolve('0x6') : original(args)
  await f.controller.prepare()
  assert.equal(f.controller.current().phase, 'idle'); assert.equal(f.stats.preflight, 2); assert.equal(f.stats.quotes, 1)
  assert.match(f.controller.current().error, /Review nonce check: Public latest\/pending 7\/7; wallet latest\/pending 6\/6/)
  assert.match(f.controller.current().error, /repeating Review alone will not resolve/)
  assert.equal(f.sent().length, 0); assert.equal(e.createExecutionJournal(f.ports.storage).read(owner).length, 0)
})
await test('transient stale RPC can converge forward once, only after repeating the entire preflight', async () => {
  const f = setup({ preflight: async (_review, n) => ({ nonce: n === 1 ? 6 : 7, latestNonce: n === 1 ? 6 : 7 }) })
  const id = await f.review(); assert.equal(f.stats.preflight, 2); assert.equal(f.stats.quotes, 1)
  await f.controller.confirm(id); assert.equal(f.sent().length, 1); assert.equal(f.stats.preflight, 3)
  assert.equal(f.sent()[0].params[0].nonce, '0x7')
})
await test('Confirm disagreement is distinct from a real agreed nonce change and never opens the wallet', async () => {
  const f = setup(), id = await f.review(), original = f.provider.request
  f.provider.request = args => args.method === 'eth_getTransactionCount' ? Promise.resolve('0x6') : original(args)
  await f.controller.confirm(id)
  assert.match(f.controller.current().error, /Confirm nonce check: Public latest\/pending 7\/7; wallet latest\/pending 6\/6/)
  assert.equal(f.stats.preflight, 3); assert.equal(f.sent().length, 0)
})
await test('a real nonce change agreed by both sources after Review requires a new explicitly reviewed intent', async () => {
  const f = setup({ preflight: async (_review, n) => ({ nonce: n === 1 ? 7 : 8, latestNonce: n === 1 ? 7 : 8 }) })
  const id = await f.review(), original = f.provider.request
  f.provider.request = args => args.method === 'eth_getTransactionCount' ? Promise.resolve('0x8') : original(args)
  await f.controller.confirm(id)
  assert.match(f.controller.current().error, /Confirm nonce check: The account nonce changed since Review/)
  assert.equal(f.stats.preflight, 2); assert.equal(f.sent().length, 0)
})
await test('pending transactions visible to both or just one RPC never permit reusing a nonce', async () => {
  for (const [publicPending, walletPending] of [[8, 8], [8, 7], [7, 8]]) {
    const f = setup({ preflight: async () => ({ nonce: publicPending, latestNonce: 7 }) }), original = f.provider.request
    f.provider.request = args => args.method === 'eth_getTransactionCount' ? Promise.resolve(args.params[1] === 'pending' ? '0x' + walletPending.toString(16) : '0x7') : original(args)
    await f.controller.prepare(); assert.equal(f.sent().length, 0)
    assert.match(f.controller.current().error, publicPending === walletPending ? /another pending transaction/ : /RPC and wallet RPC disagree/)
  }
})
await test('pending activity appearing after Review blocks Confirm instead of sending a replacement', async () => {
  const f = setup({ preflight: async (_review, n) => ({ nonce: n === 1 ? 7 : 8, latestNonce: 7 }) }), id = await f.review(), original = f.provider.request
  f.provider.request = args => args.method === 'eth_getTransactionCount' ? Promise.resolve(args.params[1] === 'pending' ? '0x8' : '0x7') : original(args)
  await f.controller.confirm(id); assert.match(f.controller.current().error, /Confirm nonce check: RPC reports another pending/)
  assert.equal(f.sent().length, 0); assert.equal(f.stats.preflight, 2)
})
await test('bounded reconciliation never discards a higher observed nonce to accept a lower RPC result', async () => {
  const f = setup({ preflight: async (_review, n) => ({ nonce: n === 1 ? 8 : 7, latestNonce: n === 1 ? 8 : 7 }) })
  await f.controller.prepare(); assert.equal(f.stats.preflight, 2); assert.equal(f.sent().length, 0)
  assert.match(f.controller.current().error, /nonce observations moved backwards/)
})
await test('higher nonces in unstable public or wallet snapshots survive the bounded retry', async () => {
  for (const source of ['public', 'wallet']) {
    let reads = 0
    const f = setup({ preflight: async () => {
      if (source === 'public' && reads++ === 0) throw new e.ExecutionNonceObservationError('public', 8)
      return { nonce: 7, latestNonce: 7 }
    } }), original = f.provider.request
    if (source === 'wallet') f.provider.request = args => args.method === 'eth_getTransactionCount'
      ? Promise.resolve(['0x7', '0x8', '0x8'][reads++] ?? '0x7') : original(args)
    await f.controller.prepare(); assert.match(f.controller.current().error, /moved backwards/)
    assert.equal(f.stats.preflight, 2); assert.equal(f.sent().length, 0)
  }
})
await test('malformed or unavailable wallet nonce fails at the wallet stage without leaking provider payloads', async () => {
  for (const value of [undefined, 7, '7', '0x-1', '0x20000000000000', new Error('sensitive-provider-payload')]) {
    const f = setup(), original = f.provider.request
    f.provider.request = args => args.method === 'eth_getTransactionCount' ? (value instanceof Error ? Promise.reject(value) : Promise.resolve(value)) : original(args)
    await f.controller.prepare(); assert.match(f.controller.current().error, /Review nonce check: The wallet RPC/)
    assert.equal(f.stats.preflight, 1); assert.equal(f.sent().length, 0); assert.equal(JSON.stringify(f.controller.current()).includes('sensitive-provider-payload'), false)
  }
})
await test('wallet identity must remain unchanged through all nonce reads', async () => {
  let reads = 0
  const f = setup(), original = f.provider.request
  f.provider.request = args => {
    if (args.method === 'eth_getTransactionCount') reads++
    return args.method === 'eth_chainId' && reads >= 3 ? Promise.resolve('0x1') : original(args)
  }
  await f.controller.prepare(); assert.match(f.controller.current().error, /wallet, network, provider/); assert.equal(f.sent().length, 0)
})
await test('quote expiry during bounded nonce reconciliation cannot be bypassed by a retry', async () => {
  const f = setup({ preflight: async (_review, n) => { if (n === 3) f.clock.now += 26000; return { nonce: 7, latestNonce: 7 } } })
  const id = await f.review(), original = f.provider.request
  f.provider.request = args => args.method === 'eth_getTransactionCount' ? Promise.resolve('0x6') : original(args)
  await f.controller.confirm(id); assert.match(f.controller.current().error, /expired/); assert.equal(f.sent().length, 0)
})
const walletRpc = require(`${root}src/lib/uniswapArcWalletRpc.ts`)
await test('connected provider acquisition never requests a chain switch and preserves provider this', async () => {
  const provider = { value: '0x7', async request(args) { assert.equal(this, provider); assert.deepEqual(args, { method: 'eth_getTransactionCount', params: [owner, 'pending'] }); return this.value } }
  const connector = { async getProvider(...args) { assert.equal(this, connector); assert.equal(args.length, 0); return provider } }
  const connected = await walletRpc.connectedExecutionProvider(connector)
  assert.equal(await walletRpc.walletRpcRead(connected, 'pending', owner), '0x7')
})
await test('provider acquisition failures expose only stage, recognized numeric code and category', async () => {
  for (const code of [4001, 4100, 4200, 4900, 4901, -32601, -32602, -32000]) {
    const f = setup({ ports: { provider: () => walletRpc.connectedExecutionProvider({ getProvider: async () => { throw { code, message: 'SECRET', data: 'SECRET' } } }) } })
    await f.controller.prepare(); const message = f.controller.current().error
    assert.match(message, /connector.getProvider/); assert.ok(message.includes(`code ${code}`)); assert.ok(!message.includes('SECRET')); assert.equal(f.sent().length, 0)
  }
  for (const provider of [undefined, {}, { request: 123 }]) await assert.rejects(walletRpc.connectedExecutionProvider({ getProvider: async () => provider }), error => error.stage === 'provider' && error.kind === 'invalid-response')
})
await test('every identity/nonce RPC failure has a precise stage in both Review and Confirm', async () => {
  const labels = ['eth_chainId before nonce', 'eth_accounts before nonce', 'eth_getTransactionCount(latest) before pending', 'eth_getTransactionCount(pending)', 'eth_getTransactionCount(latest) after pending', 'eth_chainId after nonce', 'eth_accounts after nonce']
  for (const confirm of [false, true]) for (let fail = 0; fail < labels.length; fail++) {
    const f = setup(), id = confirm ? await f.review() : undefined, original = f.provider.request; let call = 0
    f.provider.request = args => { if (call++ === fail) return Promise.reject({ code: -32601, message: 'SECRET URL TOKEN', stack: 'SECRET' }); return original(args) }
    if (confirm) await f.controller.confirm(id); else await f.controller.prepare()
    const message = f.controller.current().error
    assert.ok(message.includes(labels[fail]), message); assert.match(message, /method unsupported.*code -32601/)
    assert.ok(message.startsWith(confirm ? 'Confirm' : 'Review')); assert.ok(!message.includes('SECRET')); assert.equal(f.sent().length, 0)
  }
})
await test('EIP-1193 rejection, permissions, unsupported methods and connectivity remain distinct from nonce disagreement', async () => {
  for (const [code, label] of [[4001, 'request rejected'], [4100, 'authorization unavailable'], [4200, 'method unsupported'], [-32601, 'method unsupported'], [4900, 'provider disconnected'], [4901, 'requested chain'], [-32602, 'invalid RPC request'], [-32000, 'RPC error']]) {
    const f = setup(), original = f.provider.request
    f.provider.request = args => args.method === 'eth_getTransactionCount' ? Promise.reject({ cause: { data: { originalError: { code, message: 'SECRET' } } } }) : original(args)
    await f.controller.prepare(); const message = f.controller.current().error
    assert.ok(message.includes(label), message); assert.ok(message.includes(`code ${code}`), message)
    assert.ok(!message.includes('disagree')); assert.ok(!message.includes('SECRET')); assert.equal(f.stats.preflight, 1); assert.equal(f.sent().length, 0)
  }
})
await test('unrecognized or hostile error objects cannot leak arbitrary fields, names or codes', async () => {
  const cycle = {}; cycle.cause = cycle
  const hostile = { get code() { throw Error('SECRET') }, cause: cycle, name: 'SECRET', message: 'SECRET' }
  for (const raw of [hostile, cycle, { code: '4200', message: 'SECRET' }, { code: 999999, data: 'SECRET' }, 'SECRET']) {
    const f = setup(), original = f.provider.request
    f.provider.request = args => args.method === 'eth_getTransactionCount' ? Promise.reject(raw) : original(args)
    await f.controller.prepare(); const message = f.controller.current().error
    assert.match(message, /unclassified provider failure/); assert.ok(!message.includes('SECRET')); assert.ok(!message.includes('999999')); assert.equal(f.sent().length, 0)
  }
})
await test('strict quantity decoding rejects JSON-RPC envelopes, bigint and unsafe or malformed hex quantities', async () => {
  for (const value of [null, true, 7n, '7', '0x', '0x00', '0x-1', '0x20000000000000', { result: '0x7' }, '0x' + 'f'.repeat(10000)])
    assert.throws(() => walletRpc.walletRpcQuantity(value, 'pending'), error => error.kind === 'invalid-response' && error.stage === 'pending')
  for (const n of [0, 7, 12, Number.MAX_SAFE_INTEGER]) assert.equal(walletRpc.walletRpcQuantity('0x' + n.toString(16), 'pending'), n)
})
await test('only wallet pending accepts nonnegative safe integer numbers; other RPC stages remain hex-only', () => {
  for (const value of [0, 7, 12, Number.MAX_SAFE_INTEGER]) {
    assert.equal(walletRpc.walletRpcQuantity(value, 'pending'), value)
    assert.equal(walletRpc.walletRpcQuantity(value, 'pending', true), value)
    assert.equal(walletRpc.walletRpcQuantity('0x' + value.toString(16), 'pending'), value)
    for (const stage of ['chain-before', 'chain-after', 'latest-before', 'latest-after'])
      assert.throws(() => walletRpc.walletRpcQuantity(value, stage, true), error => error.kind === 'invalid-response' && error.responseShape === undefined)
  }
})
await test('numeric pending compatibility never coerces invalid numbers or other response types', () => {
  for (const value of [-1, -0.5, 0.5, NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1, '7', '0', '7.0', 7n, null, undefined, true, { result: 7 }, Object(7)])
    assert.throws(() => walletRpc.walletRpcQuantity(value, 'pending', true), error => error.kind === 'invalid-response' && error.responseShape !== undefined)
})
await test('numeric pending can prepare with matching public nonce and never sends merely by reviewing', async () => {
  const f = setup(), original = f.provider.request, tags = []
  f.provider.request = args => {
    if (args.method === 'eth_getTransactionCount') tags.push(args.params[1])
    return args.method === 'eth_getTransactionCount' && args.params[1] === 'pending' ? Promise.resolve(7) : original(args)
  }
  const id = await f.review(); assert.ok(id); assert.equal(f.sent().length, 0)
  assert.deepEqual(tags, ['latest', 'pending', 'latest']); assert.deepEqual([...f.data], [])
  f.controller.invalidate(); assert.equal(f.sent().length, 0)
})
await test('numeric pending preserves public-wallet disagreement and occupied nonce blocking in Review and Confirm', async () => {
  for (const confirm of [false, true]) for (const publicPending of [7, 8]) {
    const f = setup(), id = confirm ? await f.review() : undefined, original = f.provider.request
    f.ports.preflight = async () => ({ nonce: publicPending, latestNonce: 7 })
    f.provider.request = args => args.method === 'eth_getTransactionCount' && args.params[1] === 'pending' ? Promise.resolve(8) : original(args)
    if (confirm) await f.controller.confirm(id); else await f.controller.prepare()
    assert.match(f.controller.current().error, publicPending === 7 ? /RPC and wallet RPC disagree/ : /another pending transaction/)
    assert.equal(f.sent().length, 0); assert.deepEqual([...f.data], [])
  }
})
await test('numeric pending still binds Confirm to reviewed nonce and rejects a real account nonce change', async () => {
  const f = setup(), original = f.provider.request
  f.provider.request = args => args.method === 'eth_getTransactionCount' && args.params[1] === 'pending' ? Promise.resolve(7) : original(args)
  const id = await f.review()
  f.ports.preflight = async () => ({ nonce: 8, latestNonce: 8 })
  f.provider.request = args => args.method === 'eth_getTransactionCount' ? Promise.resolve(args.params[1] === 'pending' ? 8 : '0x8') : original(args)
  await f.controller.confirm(id); assert.match(f.controller.current().error, /account nonce changed/); assert.equal(f.sent().length, 0)
})
await test('synthetic Confirm serializes numeric pending once into the verified transaction without changing nonce', async () => {
  const f = setup(), original = f.provider.request
  f.provider.request = args => args.method === 'eth_getTransactionCount' && args.params[1] === 'pending' ? Promise.resolve(7) : original(args)
  const id = await f.review(); await f.controller.confirm(id); await f.controller.confirm(id)
  assert.equal(f.sent().length, 1); assert.equal(f.sent()[0].params[0].nonce, '0x7')
})
await test('pending failure diagnostics use only allowlisted shape fields from the original response', async () => {
  const samples = [
    [undefined, 'undefined', 'n/a', 'n/a'], [null, 'null', 'n/a', 'n/a'], [12.5, 'number', 'n/a', 'n/a'], [12n, 'bigint', 'n/a', 'n/a'],
    ['0x0c', 'string', 4, 'no'], ['0x' + '0'.repeat(63) + 'c', 'string', 66, 'no'], ['0x20000000000000', 'string', 16, 'yes'],
    [{ result: 'SECRET-NONCE', url: 'SECRET-URL', session: 'SECRET-SESSION' }, 'object', 'n/a', 'n/a'],
    ['SECRET-RESPONSE', 'string', 15, 'no'], ['0x' + 'f'.repeat(10000), 'string', 10002, 'not-checked-length'],
  ]
  for (const [raw, type, length, canonical] of samples) for (const confirm of [false, true]) {
    const f = setup(), id = confirm ? await f.review() : undefined, original = f.provider.request, calls = []
    f.provider.request = args => { calls.push([args.method, args.params?.[1]]); return args.method === 'eth_getTransactionCount' && args.params[1] === 'pending' ? Promise.resolve(raw) : original(args) }
    if (confirm) await f.controller.confirm(id); else await f.controller.prepare()
    const view = f.controller.current(), expected = `Response shape: type=${type}; stringLength=${length}; canonicalHexQuantity=${canonical}.`
    assert.ok(view.error.endsWith(expected), view.error)
    assert.deepEqual(calls, [['eth_chainId', undefined], ['eth_accounts', undefined], ['eth_getTransactionCount', 'latest'], ['eth_getTransactionCount', 'pending']])
    assert.equal(f.sent().length, 0); assert.equal(f.stats.preflight, confirm ? 2 : 1)
    assert.deepEqual([...f.data], []); assert.equal(view.approvalId, undefined)
    for (const sensitive of ['SECRET', owner, '0x20000000000000', '0x0c']) assert.ok(!JSON.stringify(view).includes(sensitive))
  }
})
await test('shape classification never traverses objects, calls getters or coerces response values', () => {
  const hostile = new Proxy({}, { get() { throw Error('SECRET') }, ownKeys() { throw Error('SECRET') } })
  const revoked = Proxy.revocable({}, {}); revoked.revoke()
  for (const raw of [hostile, revoked.proxy, { get result() { throw Error('SECRET') }, toString() { throw Error('SECRET') } }]) {
    assert.throws(() => walletRpc.walletRpcQuantity(raw, 'pending', true), error => error.responseShape === 'Response shape: type=object; stringLength=n/a; canonicalHexQuantity=n/a.')
  }
})
await test('diagnostics are opt-in, pending-only and cannot alter quantity acceptance or rejection', () => {
  for (const raw of [null, '0x00', { result: '0xc' }, -1]) {
    for (const stage of ['chain-before', 'latest-before', 'latest-after'])
      assert.throws(() => walletRpc.walletRpcQuantity(raw, stage, true), error => error.kind === 'invalid-response' && error.responseShape === undefined)
    assert.throws(() => walletRpc.walletRpcQuantity(raw, 'pending'), error => error.kind === 'invalid-response' && error.responseShape === undefined)
  }
  for (const n of [0, 12, Number.MAX_SAFE_INTEGER]) {
    const raw = '0x' + n.toString(16)
    assert.equal(walletRpc.walletRpcQuantity(raw, 'pending', true), walletRpc.walletRpcQuantity(raw, 'pending'))
  }
})
await test('unauthorized pilot paths and rejected RPC requests never produce response-shape diagnostics', async () => {
  for (const ports of [{ authorize: () => false }, { enabled: () => false }]) {
    const f = setup({ ports }); await f.controller.prepare()
    assert.equal(f.wallet.length, 0); assert.ok(!f.controller.current().error.includes('Response shape'))
  }
  const f = setup(), original = f.provider.request
  f.provider.request = args => args.method === 'eth_getTransactionCount' && args.params[1] === 'pending' ? Promise.reject({ code: -32601, message: 'SECRET' }) : original(args)
  await f.controller.prepare(); assert.ok(!f.controller.current().error.includes('Response shape')); assert.equal(f.sent().length, 0)
})
await test('unstable wallet snapshots are diagnosed separately without losing bounded retry or high-water protection', async () => {
  for (const values of [[7, 7, 8], [7, 6, 7]]) {
    const f = setup(), original = f.provider.request; let i = 0
    f.provider.request = args => args.method === 'eth_getTransactionCount' ? Promise.resolve('0x' + values[i++ % 3].toString(16)) : original(args)
    await f.controller.prepare(); assert.match(f.controller.current().error, /inconsistent eth_getTransactionCount/)
    assert.equal(f.stats.preflight, 2); assert.equal(f.sent().length, 0)
  }
})
await test('nonce read timeout is bounded and a late result cannot authorize a transaction', async () => {
  mock.timers.enable({ apis: ['setTimeout'] })
  try {
    let release
    const f = setup(), original = f.provider.request
    f.provider.request = args => args.method === 'eth_getTransactionCount' ? new Promise(resolve => { release = resolve }) : original(args)
    const pending = f.controller.prepare()
    for (let i = 0; i < 100 && !release; i++) await Promise.resolve()
    assert.ok(release); mock.timers.tick(3000); await pending
    assert.match(f.controller.current().error, /latest.*RPC read timed out/); release('0x7'); await Promise.resolve()
    assert.equal(f.controller.current().phase, 'idle'); assert.equal(f.sent().length, 0)
  } finally { mock.timers.reset() }
})
await test('provider acquisition timeout and malformed identity data never produce a prepared intent', async () => {
  mock.timers.enable({ apis: ['setTimeout'] })
  try {
    const f = setup({ ports: { provider: () => walletRpc.connectedExecutionProvider({ getProvider: () => new Promise(() => {}) }) } })
    const pending = f.controller.prepare()
    for (let i = 0; i < 60; i++) await Promise.resolve()
    mock.timers.tick(5000); await pending
    assert.match(f.controller.current().error, /connector.getProvider.*timed out/); assert.equal(f.sent().length, 0)
  } finally { mock.timers.reset() }
  for (const [method, raw] of [['eth_chainId', 5042], ['eth_accounts', { result: [owner] }], ['eth_accounts', ['SECRET']]]) {
    const f = setup(), original = f.provider.request
    f.provider.request = args => args.method === method ? Promise.resolve(raw) : original(args)
    await f.controller.prepare(); assert.match(f.controller.current().error, /invalid EIP-1193 response/); assert.equal(f.sent().length, 0)
  }
})
await test('installed WalletConnect provider routes controlled EIP-1193 reads to its active CAIP chain', async () => {
  const { EthereumProvider } = await import('@walletconnect/ethereum-provider')
  const calls = []
  const receiver = { chainId: 5042, formatChainId: n => `eip155:${n}`, signer: { request: async (args, chain) => { calls.push({ args, chain }); return '0x7' } } }
  const connected = await walletRpc.connectedExecutionProvider({ getProvider: async () => ({ request: args => EthereumProvider.prototype.request.call(receiver, args) }) })
  for (const stage of ['latest-before', 'pending', 'latest-after']) assert.equal(await walletRpc.walletRpcRead(connected, stage, owner), '0x7')
  assert.deepEqual(calls, ['latest', 'pending', 'latest'].map(tag => ({ args: { method: 'eth_getTransactionCount', params: [owner, tag] }, chain: 'eip155:5042' })))
  receiver.signer.request = async () => { throw { code: -32601, message: 'SECRET' } }
  await assert.rejects(walletRpc.walletRpcRead(connected, 'pending', owner), error => error.kind === 'unsupported' && error.rpcCode === -32601)
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
  await f.controller.confirm(await f.review())
  // A read failure teaches nothing: the transaction stays Pending (with the reason), never Failed, Confirmed or silently Unknown.
  assert.equal(f.controller.current().phase, 'pending'); assert.match(f.controller.current().error, /could not be read just now/)
  assert.equal(f.controller.current().attempt.hash, hash); assert.equal(f.controller.current().nextCheckMs, 5000)
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
await test('a persisted Confirmed status is rechecked after reload; an RPC failure keeps the recorded status visible but blocks a new send until re-verified', async () => {
  const f = setup({ result: async attempt => ({ status: 'confirmed', output: attempt.review.requiredMinimum, fee: '0' }) })
  await f.controller.confirm(await f.review())
  const reload = setup({ data: f.data, result: async () => { throw Error('rpc-down') } }); await reload.controller.reconcile()
  // The recorded result is not lost or downgraded by a read failure; the lookup indicator is separate and the failure is explained.
  assert.equal(reload.controller.current().phase, 'confirmed'); assert.equal(reload.controller.current().checking, false)
  assert.match(reload.controller.current().error, /could not be read just now/)
  assert.equal(e.createExecutionJournal(reload.ports.storage).read(owner)[0].status, 'confirmed')
  await reload.controller.prepare(); assert.equal(reload.stats.quotes, 0); assert.match(reload.controller.current().error, /unresolved/)
  // Once the chain is read again the block is lifted by evidence, not by waiting.
  reload.ports.result = async attempt => ({ status: 'confirmed', output: attempt.review.requiredMinimum, fee: '0' })
  await reload.controller.reconcile(); await reload.controller.prepare(); assert.equal(reload.stats.quotes, 1)
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
  const reload = setup({ data: f.data, result: async () => ({ status: 'pending', identified: true }) }); await reload.controller.reconcile(owner, hash)
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
// A transaction is "not verified" when the adapter refuses to bind it (reject) or reports a settled result whose Review comparison is not verified.
async function notVerified(f) {
  try { const r = await f.adapter.result(f.attempt); return r.status === 'settled' ? ['verified', 'verified_with_notes'].includes(r.intent.verdict) === false : false } catch { return true }
}
await test('submitted transaction comparison runs before a receipt is available, with no false settlement or gas warning', async () => {
  const missingReceipt = () => { throw Object.assign(Error('not mined'), { name: 'TransactionReceiptNotFoundError' }) }
  for (const change of [{}, { maxPriorityFeePerGas: 1n }, { gas: 120000n }, { to: other }, { value: 1n }, { input: '0x12345678' }, { from: other }, { nonce: 8 }, { chainId: 1 }]) {
    let observed
    const f = rpcFixture('EURC', { getTransactionReceipt: async () => { assert.ok(observed, 'comparison precedes receipt read'); return missingReceipt() } })
    Object.assign(f.tx, change)
    const run = f.adapter.result(f.attempt, report => { observed = report })
    if ('from' in change || 'nonce' in change || 'chainId' in change) await assert.rejects(run, error => error.reason === 'binding')
    else assert.equal((await run).status, 'pending')
    assert.equal(observed.verdict, Object.keys(change).some(k => ['to', 'value', 'input'].includes(k)) ? 'mismatch' : ['from', 'nonce', 'chainId'].some(k => k in change) ? 'unbound' : 'incomplete')
    if ('gas' in change || 'maxPriorityFeePerGas' in change) assert.equal(observed.checks.find(c => c.id === 'fee-fields').status, 'allowed')
  }
})
await test('read-only mainnet calldata fixtures distinguish the extra PAY_PORTION and changed recipient from the normal V3 program', () => {
  const captured = JSON.parse(readFileSync(`${root}scripts/fixtures/swap/uniswap-integrity-transactions.json`, 'utf8'))
  assert.equal(captured.transactions.length, 2)
  for (const [index, raw] of captured.transactions.entries()) {
    const tx = { ...raw, chainId: Number(BigInt(raw.chainId)), nonce: Number(BigInt(raw.nonce)), type: 'eip1559',
      value: BigInt(raw.value), gas: BigInt(raw.gas), maxFeePerGas: BigInt(raw.maxFeePerGas), maxPriorityFeePerGas: BigInt(raw.maxPriorityFeePerGas) }
    const [commands, inputs, deadline] = decodeFunctionData({ abi: p.EXECUTE_ABI, data: tx.input }).args
    assert.equal(commands, index === 0 ? '0x00060404' : '0x0004')
    const swap = [...decodeAbiParameters(p.V3_INPUT, inputs[0])]
    let expected = tx.input
    if (index === 0) {
      const [token, recipient, bips] = decodeAbiParameters(parseAbiParameters('address,address,uint256'), inputs[1])
      assert.ok(p.sameAddress(token, p.ARC_OUTPUTS.EURC.address)); assert.equal(bips, 160n)
      assert.ok(p.sameAddress(recipient, '0x147cf09e7373b8fda6f12021f1b0f98d6da1a566'))
      // Policy-compatible comparison fixture, NOT a claim to possess this transaction's historical Review.
      swap[0] = tx.from
      expected = encodeFunctionData({ abi: p.EXECUTE_ABI, functionName: 'execute', args: ['0x0004', [encodeAbiParameters(p.V3_INPUT, swap), inputs[2]], deadline] })
    }
    const reviewed = { owner: tx.from, recipient: tx.from, router: p.ARC_ROUTER, chainId: 5042, nonce: tx.nonce, value: tx.value, calldata: expected,
      gasLimit: tx.gas, maxFeePerGas: tx.maxFeePerGas, maxPriorityFeePerGas: tx.maxPriorityFeePerGas, feeCeiling: tx.gas * tx.maxFeePerGas,
      outputToken: p.ARC_OUTPUTS.EURC.address, requiredMinimum: swap[2], outputSymbol: 'EURC', outputDecimals: 6 }
    const report = evidence.compareToReview({ attemptHash: tx.hash, tx, receipt: null, observation: { canonical: false, latestBlock: 0n, blockTimestamp: null }, reviewed, received: null })
    assert.equal(report.verdict, index === 0 ? 'mismatch' : 'incomplete')
    if (index === 0) assert.match(report.differences.join(' '), /1\.60%/)
    else {
      assert.equal(report.checks.find(c => c.id === 'calldata').status, 'match')
      const changed = [...swap]; changed[0] = other
      const altered = { ...tx, input: encodeFunctionData({ abi: p.EXECUTE_ABI, functionName: 'execute', args: [commands, [encodeAbiParameters(p.V3_INPUT, changed), inputs[1]], deadline] }) }
      assert.equal(evidence.compareToReview({ attemptHash: tx.hash, tx: altered, receipt: null, observation: { canonical: false, latestBlock: 0n, blockTimestamp: null }, reviewed, received: null }).verdict, 'mismatch')
    }
  }
})
await test('unknown transaction and RPC errors are not evidence of a security violation; a receipt outage cannot erase an observed mismatch', async () => {
  for (const failure of [Object.assign(Error('not found'), { name: 'TransactionNotFoundError' }), Error('RPC unavailable')]) {
    let count = 0
    const f = rpcFixture('EURC', { getTransaction: async () => { throw failure } })
    try { await f.adapter.result(f.attempt, () => { count++ }) } catch (error) { assert.equal(error.reason, 'rpc') }
    assert.equal(count, 0)
  }
  const f = rpcFixture('EURC', { getTransactionReceipt: async () => { throw Error('RPC down') } }); f.tx.to = other
  let observed
  await assert.rejects(f.adapter.result(f.attempt, report => { observed = report }), error => error.reason === 'rpc')
  assert.equal(observed.verdict, 'mismatch')
})
await test('a slow receipt cannot postpone an already visible calldata warning', async () => {
  let release, observed, finished = false
  const f = rpcFixture('EURC', { getTransactionReceipt: () => new Promise(resolve => { release = resolve }) }); f.tx.input = '0x12345678'
  const pending = f.adapter.result(f.attempt, report => { observed = report }).then(result => { finished = true; return result })
  await waitFor(() => release !== undefined)
  assert.equal(observed.verdict, 'mismatch'); assert.equal(finished, false)
  release(f.receipt); const result = await pending
  assert.equal(result.status, 'settled'); assert.equal(result.chain.state, 'success'); assert.equal(result.intent.verdict, 'mismatch')
})
await test('an early unbound report cannot persist an unverified recovery hash', async () => {
  const f = setup(), original = f.provider.request
  let requests = 0
  f.provider.request = args => { if (args.method === 'eth_sendTransaction') { requests++; return Promise.reject(Error('unknown submission')) } return original(args) }
  await f.controller.confirm(await f.review())
  f.ports.result = async (_attempt, submitted) => {
    submitted?.({ verdict: 'unbound', checks: [], differences: ['Different sender.'], checkedAt: 1 })
    throw new e.ExecutionVerificationError('binding', false)
  }
  await f.controller.reconcile(owner, hash)
  const stored = e.createExecutionJournal(f.ports.storage).read(owner)[0]
  assert.equal(stored.hash, undefined); assert.equal(stored.intent, undefined); assert.equal(requests, 1)
})
await test('an early mismatch is durable through a receipt outage and reload, blocks resubmission and still settles normally', async () => {
  const f = setup({ result: async (attempt, submitted) => {
    const rpc = rpcFixture(); rpc.tx.input = '0x12345678'
    rpc.rpc.getTransactionReceipt = async () => { throw Error('RPC down') }
    return rpc.adapter.result({ ...rpc.attempt, review: attempt.review, nonce: attempt.nonce }, submitted)
  } })
  await f.controller.confirm(await f.review())
  assert.equal(f.controller.current().attempt.intent.verdict, 'mismatch'); assert.equal(f.controller.current().phase, 'pending')
  const restored = setup({ data: f.data }); assert.equal(restored.controller.history()[0].intent.verdict, 'mismatch')
  await restored.controller.prepare(); assert.equal(restored.sent().length, 0)
  f.ports.result = async attempt => {
    const rpc = rpcFixture(); rpc.tx.input = '0x12345678'
    return rpc.adapter.result({ ...rpc.attempt, review: attempt.review, nonce: attempt.nonce })
  }
  await f.controller.reconcile(owner); assert.equal(f.controller.current().phase, 'mismatch')
  assert.equal(f.controller.current().attempt.chain.state, 'success'); assert.equal(f.sent().length, 1)
})
await test('actual preflight adapter rechecks both routes, runtime, decimals, balances, fees, gas and exact simulation', async () => {
  for (const symbol of ['EURC', 'cirBTC']) {
    const f = rpcFixture(symbol); assert.deepEqual(await f.adapter.preflight(f.review), { nonce: 7, latestNonce: 7 })
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
await test('actual public adapter brackets pending with latest reads and rejects moving or malformed state', async () => {
  const f = rpcFixture(), tags = []
  f.rpc.getTransactionCount = async args => { tags.push(args.blockTag); return 7 }
  assert.deepEqual(await f.adapter.preflight(f.review), { nonce: 7, latestNonce: 7 })
  assert.deepEqual(tags, ['latest', 'pending', 'latest'])
  for (const values of [[7, 8, 8], [7, 6, 7], [7, NaN, 7]]) {
    const bad = rpcFixture(); let index = 0
    bad.rpc.getTransactionCount = async () => values[index++]
    await assert.rejects(bad.adapter.preflight(bad.review), /public_nonce/)
  }
  const pending = rpcFixture()
  pending.rpc.getTransactionCount = async args => args.blockTag === 'pending' ? 8 : 7
  assert.deepEqual(await pending.adapter.preflight(pending.review), { nonce: 8, latestNonce: 7 })
})
await test('receipt success requires exact transaction binding, two observed blocks and actual output Transfer logs', async () => {
  for (const symbol of ['EURC', 'cirBTC']) {
    const f = rpcFixture(symbol), result = await f.adapter.result(f.attempt)
    assert.equal(result.status, 'settled'); assert.equal(result.chain.state, 'success'); assert.equal(result.intent.verdict, 'verified')
    assert.equal(result.output, f.review.requiredMinimum); assert.equal(result.fee, '100000000000000'); assert.equal(result.chain.received, f.review.requiredMinimum)
  }
})
await test('real first pilot actions are unsupported by this HEAD and never silently accepted as an approved review', () => {
  const raw = JSON.parse(readFileSync(`${root}scripts/fixtures/uniswap-arc/first-pilot-result.json`, 'utf8'))
  const tx = raw.eth_getTransactionByHash, outer = decodeFunctionData({ abi: p.EXECUTE_ABI, data: tx.input })
  const [actions, params] = decodeAbiParameters(p.V4_ENVELOPE, outer.args[1][0])
  assert.equal(outer.args[0], '0x1004'); assert.equal(actions, '0x070b100e'); assert.equal(params.length, 4)
  const suffixId = tx.input.slice(-32), quoteId = [suffixId.slice(0, 8), suffixId.slice(8, 12), suffixId.slice(12, 16), suffixId.slice(16, 20), suffixId.slice(20)].join('-')
  const request = { ...setup().ports.input(), amount: '0.1' }
  assert.throws(() => p.decodeNativeEconomics({ chainId: 5042, from: tx.from, to: tx.to, data: tx.input, value: tx.value }, request, 1n, quoteId), /unsupported_actions/)
})
await test('a deterministic binding failure stays unknown, stops automatic checks, explains itself and blocks another send', async () => {
  const f = setup({ result: async () => { throw new e.ExecutionVerificationError('binding', false) } })
  await f.controller.confirm(await f.review())
  assert.equal(f.controller.current().phase, 'unknown'); assert.match(f.controller.current().error, /does not identify the reviewed swap/)
  assert.equal(f.controller.current().nextCheckMs, null); assert.equal(f.stats.results, 1)
  await f.controller.prepare(); assert.equal(f.sent().length, 1)
})
await test('wallet-scoped history and targeted old-record checks cannot bypass unresolved attempts or restore send authority', async () => {
  const f = setup({ result: async () => ({ status: 'confirmed', output: '1000000', fee: '1' }) })
  await f.controller.confirm(await f.review()); const first = f.controller.history()[0]
  await f.controller.confirm(await f.review()); const records = f.controller.history()
  assert.equal(records.length, 2); assert.deepEqual(f.controller.history(other), [])
  const snapshot = f.controller.history(); snapshot[0].status = 'unknown'; assert.equal(f.controller.history()[0].status, 'confirmed')
  f.ports.result = async () => { throw Error('rpc-down') }
  await f.controller.reconcile(owner, undefined, first.id)
  // A failed re-check keeps the recorded Confirmed visible (nothing is downgraded or lost) but still blocks a new send until re-verified.
  assert.equal(f.controller.current().phase, 'confirmed'); assert.match(f.controller.current().error, /could not be read just now/)
  assert.equal(f.controller.current().attempt.id, first.id)
  await f.controller.prepare(); assert.equal(f.sent().length, 2)
  const reload = setup({ data: f.data }); assert.equal(reload.controller.history().length, 2)
  await reload.controller.confirm(first.id); assert.equal(reload.sent().length, 0)
})
await test('wrong hash/from/router/value/calldata/nonce/chain/gas ceiling/fee ceiling/type can never be verified', async () => {
  // Identity fields (hash, sender, nonce, network) make the hash unrelated to the attempt: refused outright.
  for (const delta of [{ hash: '0x' + 'c'.repeat(64) }, { from: other }, { nonce: 8 }, { chainId: 1 }]) {
    const f = rpcFixture(); Object.assign(f.tx, delta); await assert.rejects(f.adapter.result(f.attempt), error => error instanceof e.ExecutionVerificationError && error.retryable === false)
  }
  // Everything else is a real chain result that is NOT the reviewed transaction: reported, never Confirmed.
  for (const delta of [{ to: other }, { value: 1n }, { input: '0x' + '00'.repeat(4) }, { gas: 130001n }, { maxFeePerGas: 3000000000n }, { type: 'legacy' }]) {
    const f = rpcFixture(); Object.assign(f.tx, delta); assert.equal(await notVerified(f), true, JSON.stringify(delta, (k, v) => typeof v === 'bigint' ? v.toString() : v))
  }
  // A wallet that only raises the priority fee, or lowers the gas limit, stays inside the approved ceiling: verified with notes.
  for (const delta of [{ maxPriorityFeePerGas: 1n }, { maxPriorityFeePerGas: 1500000000n, maxFeePerGas: 2000000000n }, { gas: 120000n }]) {
    const f = rpcFixture(); Object.assign(f.tx, delta); const r = await f.adapter.result(f.attempt)
    assert.equal(r.intent.verdict, 'verified_with_notes'); assert.equal(r.chain.state, 'success')
  }
})
await test('success status without enough output to the correct recipient/token is a chain success that does not match the Review', async () => {
  for (const change of ['none', 'low', 'recipient', 'token', 'outgoing']) {
    const f = rpcFixture(), log = f.receipt.logs[0]
    if (change === 'none') f.receipt.logs = []
    if (change === 'low') log.data = '0x' + '0'.repeat(63) + '1'
    if (change === 'recipient') log.topics[2] = '0x' + other.slice(2).padStart(64, '0')
    if (change === 'token') log.address = p.ARC_OUTPUTS.cirBTC.address
    if (change === 'outgoing') log.topics = [log.topics[0], log.topics[2], log.topics[1]]
    const r = await f.adapter.result(f.attempt)
    assert.equal(r.status, 'settled'); assert.equal(r.chain.state, 'success'); assert.equal(r.intent.verdict, 'mismatch', change)
    assert.ok(r.intent.checks.some(c => c.id === 'minimum' && c.status === 'mismatch'))
  }
})
await test('duplicated or cross-transaction Transfer logs cannot inflate verified output: the amount is unavailable and nothing is confirmed', async () => {
  for (const kind of ['duplicate', 'hash', 'block', 'index']) {
    const f = rpcFixture(), log = f.receipt.logs[0]
    if (kind === 'duplicate') f.receipt.logs.push(structuredClone(log))
    if (kind === 'hash') log.transactionHash = '0x' + 'c'.repeat(64)
    if (kind === 'block') log.blockHash = '0x' + 'c'.repeat(64)
    if (kind === 'index') log.transactionIndex = 1
    const r = await f.adapter.result(f.attempt)
    assert.equal(r.intent.verdict, 'incomplete', kind); assert.equal(r.chain.received, null)
  }
  // The controller treats incomplete evidence as unknown (retried with backoff), never Confirmed.
  const f = setup({ result: async attempt => { const r = rpcFixture(); r.receipt.logs = [structuredClone(r.receipt.logs[0]), structuredClone(r.receipt.logs[0])]; return r.adapter.result({ ...r.attempt, review: attempt.review, nonce: attempt.nonce }) } })
  await f.controller.confirm(await f.review()); assert.notEqual(f.controller.current().phase, 'confirmed')
})
await test('reverts are Failed; missing receipt, insufficient confirmations and reorg remain Pending', async () => {
  const reverted = rpcFixture(); reverted.receipt.status = 'reverted'; const revertedResult = await reverted.adapter.result(reverted.attempt)
  assert.equal(revertedResult.status, 'settled'); assert.equal(revertedResult.chain.state, 'reverted'); assert.equal(revertedResult.output, '0')
  for (const changes of [{ getTransactionReceipt: async () => { throw Object.assign(Error('not found'), { name: 'TransactionReceiptNotFoundError' }) } },
    { getBlockNumber: async () => 100n }, { getBlock: async () => ({ hash: '0x' + 'c'.repeat(64) }) }]) {
    const f = rpcFixture('EURC', changes); assert.equal((await f.adapter.result(f.attempt)).status, 'pending')
  }
})
await test('receipt block identity and spent gas cannot exceed the approved transaction budget', async () => {
  for (const delta of [{ transactionHash: '0x' + 'c'.repeat(64) }, { from: other }]) {
    const f = rpcFixture(); Object.assign(f.receipt, delta); await assert.rejects(f.adapter.result(f.attempt))
  }
  for (const delta of [{ to: other }, { gasUsed: 130001n }, { effectiveGasPrice: 3000000000n }]) {
    const f = rpcFixture(); Object.assign(f.receipt, delta); assert.equal(await notVerified(f), true, JSON.stringify(delta, (k, v) => typeof v === 'bigint' ? v.toString() : v))
  }
})
await test('read-only RPC allowlist never permits signing, sends, approvals or arbitrary wallet calls', () => {
  for (const method of ['eth_sendTransaction', 'eth_sendRawTransaction', 'personal_sign', 'eth_signTypedData_v4', 'wallet_sendCalls', 'eth_requestAccounts', 'debug_traceCall', 'evm_mine']) assert.throws(() => assertExecutionReadMethod(method), /read_only_rpc/)
  for (const method of ['eth_chainId', 'eth_getTransactionCount', 'eth_getTransactionReceipt']) assertExecutionReadMethod(method)
})
// --- Findings of the adversarial review ----------------------------------------------------------------------------------------
const settledFor = attempt => ({ status: 'settled', output: attempt.review.requiredMinimum, fee: '100000', chain: { state: 'success', blockNumber: '100', blockHash, gasUsed: '100000', effectiveGasPrice: '1000000000', fee: '100000', received: attempt.review.requiredMinimum, sent: null, checkedAt: Date.now() },
  intent: { verdict: 'verified', checks: [], differences: [], checkedAt: Date.now() } })
async function lostHash(options = {}) {
  const f = setup(options), original = f.provider.request
  f.provider.request = args => args.method === 'eth_sendTransaction' ? Promise.reject(Object.assign(Error('internal'), { code: -32603 })) : original(args)
  await f.controller.confirm(await f.review()); assert.equal(f.controller.current().phase, 'unknown'); return f
}
await test('recovery: a hash the network has never shown is not saved, so the real hash can still be supplied afterwards', async () => {
  const wrong = '0x' + 'c'.repeat(64), real = '0x' + 'd'.repeat(64)
  const lost = await lostHash(), result = async attempt => (attempt.hash === real ? { status: 'pending', identified: true } : { status: 'pending', identified: false })
  const reload = setup({ data: lost.data, result }); const journal = () => e.createExecutionJournal(reload.ports.storage).read(owner)[0]
  await reload.controller.reconcile(owner, wrong); assert.match(reload.controller.current().error, /does not know that hash/); assert.equal(journal().hash, undefined); assert.equal(reload.controller.current().phase, 'unknown')
  await reload.controller.prepare(); assert.match(reload.controller.current().error, /unresolved/); assert.equal(reload.sent().length, 0)
  await reload.controller.reconcile(owner, real); assert.equal(journal().hash, real); assert.equal(reload.controller.current().phase, 'pending')
  assert.equal(e.createExecutionJournal(reload.ports.storage).read(owner).length, 1) // the original record, not a second one
})
await test('replaced transaction: a different hash takes over only when the recorded one is unknown AND its nonce was used by something else; the new hash is then verified like any other', async () => {
  const second = '0x' + 'd'.repeat(64)
  const make = async nonceUsed => { const f = setup({ result: async attempt => (attempt.hash === second ? settledFor(attempt) : { status: 'pending', identified: false, ...(nonceUsed === undefined ? {} : { nonceUsed }) }) }); await f.controller.confirm(await f.review()); return f }
  const unproven = await make(false); await unproven.controller.reconcile(owner); assert.equal(unproven.controller.current().replaced, undefined); assert.equal(unproven.controller.current().phase, 'pending')
  await unproven.controller.reconcile(owner, second); assert.match(unproven.controller.current().error, /does not identify/); assert.equal(e.createExecutionJournal(unproven.ports.storage).read(owner)[0].hash, hash)
  const unread = await make(undefined); await unread.controller.reconcile(owner, second); assert.match(unread.controller.current().error, /does not identify/)
  const replaced = await make(true); await replaced.controller.reconcile(owner)
  assert.equal(replaced.controller.current().replaced, true); assert.match(replaced.controller.current().error, /nonce was used by another transaction/); assert.equal(replaced.controller.current().phase, 'pending')
  assert.equal((await replaced.controller.prepare(), replaced.sent().length), 1) // still blocks a new swap
  await replaced.controller.reconcile(owner, second)
  const record = e.createExecutionJournal(replaced.ports.storage).read(owner)[0]; assert.equal(record.hash, second); assert.equal(record.status, 'confirmed')
  assert.ok(record.log.some(entry => entry.note.includes(hash) && entry.note.includes('nonce was used by another transaction'))); assert.equal(replaced.controller.blocking(owner), false)
  // a replacement the network does not show yet is not saved
  const early = await make(true); early.ports.result = async () => ({ status: 'pending', identified: false, nonceUsed: true }); await early.controller.reconcile(owner, second)
  assert.match(early.controller.current().error, /does not know that hash/); assert.equal(e.createExecutionJournal(early.ports.storage).read(owner)[0].hash, hash)
})
await test('incomplete evidence is stored with its chain facts, claims nothing, keeps blocking, and its re-reads back off and stop', async () => {
  const f = setup({ result: async attempt => ({ ...settledFor(attempt), chain: { ...settledFor(attempt).chain, received: null }, intent: { verdict: 'incomplete', checks: [], differences: [], checkedAt: 1 } }) })
  await f.controller.confirm(await f.review()); const delays = [f.controller.current().nextCheckMs] // the check that follows the send is the first
  for (let i = 0; i < 8; i++) { await f.controller.reconcile(owner); delays.push(f.controller.current().nextCheckMs) }
  assert.deepEqual(delays, [5000, 10000, 20000, 40000, 60000, 60000, 60000, null, null]); const record = e.createExecutionJournal(f.ports.storage).read(owner)[0]
  assert.equal(record.status, 'unknown'); assert.equal(record.chain.state, 'success'); assert.equal(f.controller.blocking(owner), true); assert.match(f.controller.current().error, /Automatic checks stopped/)
})
await test('the adapter reports whether the node knows the hash and whether its nonce was used; a read problem leaves the nonce question open', async () => {
  const notFound = Object.assign(Error('x'), { name: 'TransactionNotFoundError' })
  const gone = rpcFixture('EURC', { getTransaction: async () => { throw notFound }, getTransactionCount: async () => 8 }); assert.deepEqual(await gone.adapter.result(gone.attempt), { status: 'pending', identified: false, nonceUsed: true })
  const free = rpcFixture('EURC', { getTransaction: async () => { throw notFound }, getTransactionCount: async () => 7 }); assert.deepEqual(await free.adapter.result(free.attempt), { status: 'pending', identified: false, nonceUsed: false })
  const blind = rpcFixture('EURC', { getTransaction: async () => { throw notFound }, getTransactionCount: async () => { throw Error('down') } }); assert.deepEqual(await blind.adapter.result(blind.attempt), { status: 'pending', identified: false })
  const unmined = rpcFixture('EURC', { getTransactionReceipt: async () => { throw Object.assign(Error('x'), { name: 'TransactionReceiptNotFoundError' }) } }); assert.deepEqual(await unmined.adapter.result(unmined.attempt), { status: 'pending', identified: true })
})
await test('eviction never moves a record this session could not re-verify, and an archive entry today\'s rules reject is kept, counted and never fatal', async () => {
  const f = setup(); await f.controller.confirm(await f.review()); const base = e.createExecutionJournal(f.ports.storage).read(owner)[0]
  const store = new Map(), pinned = new Set(), journal = e.createExecutionJournal({ getItem: k => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) }, id => pinned.has(id))
  const record = n => { const copy = structuredClone(base); for (const key of ['hash', 'output', 'fee', 'chain', 'intent', 'log']) delete copy[key]; return { ...copy, id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`, status: 'rejected' } }
  for (let n = 1; n <= 20; n++) journal.save(record(n)); pinned.add(record(1).id); journal.save(record(21))
  assert.ok(journal.read(owner).some(a => a.id === record(1).id)); assert.ok(!journal.read(owner).some(a => a.id === record(2).id)); assert.deepEqual(journal.archived(owner).map(a => a.id), [record(2).id])
  const archiveKey = `machina.uniswap.arc.execution.archive.v1:${owner.toLowerCase()}`, activeKey = `machina.uniswap.arc.execution.v1:${owner.toLowerCase()}`
  const stored = JSON.parse(store.get(archiveKey)); stored.push({ id: 'legacy', note: 'old' }); store.set(archiveKey, JSON.stringify(stored))
  assert.equal(journal.archiveUnreadable(owner), 1); journal.save(record(22)); assert.equal(journal.read(owner).length, 20)
  assert.ok(JSON.parse(store.get(archiveKey)).some(entry => entry.id === 'legacy')); assert.equal(journal.archived(owner).length, 2)
  const view = key => ({ length: 2, key: i => [activeKey, archiveKey][i], getItem: k => (k === archiveKey && key === 'broken' ? '{' : store.get(k) ?? null) })
  const listed = e.listStoredAttempts(view('fine')); assert.equal(listed[0].attempts.length, 20); assert.equal(listed[0].archived.length, 2); assert.equal(listed[0].archiveUnreadable, 1); assert.equal(listed[0].unreadable, false)
  const broken = e.listStoredAttempts(view('broken')); assert.equal(broken[0].attempts.length, 20); assert.deepEqual(broken[0].archived, []); assert.equal(broken[0].unreadable, true) // the active records stay visible
  const noActive = e.listStoredAttempts({ length: 1, key: () => activeKey, getItem: () => '{' }); assert.equal(noActive[0].unreadable, true); assert.deepEqual(noActive[0].attempts, [])
})
await test('the controller reports whether a wallet is held by an unresolved record, and unreadable storage counts as held', async () => {
  const f = setup(); assert.equal(f.controller.blocking(owner), false); await f.controller.confirm(await f.review()); assert.equal(f.controller.blocking(owner), true)
  const broken = setup({ data: new Map([[`machina.uniswap.arc.execution.v1:${owner.toLowerCase()}`, '{']]) }); assert.equal(broken.controller.blocking(owner), true)
})
await test('the read-only client refuses every non-read method on both of its request paths and never reaches the network', async () => {
  const { arcReadClient } = require(`${root}src/lib/uniswapArcExecutionRpc.ts`)
  for (const request of [arcReadClient.request, arcReadClient.transport.request]) for (const method of ['eth_sendRawTransaction', 'eth_sendTransaction', 'personal_sign', 'eth_signTypedData_v4', 'wallet_switchEthereumChain'])
    await assert.rejects(Promise.resolve().then(() => request({ method, params: [] })), /read_only_rpc/, method)
})
assert.equal(external, 0)
console.log(`${count} Uniswap execution/security groups PASS. Synthetic wallet requests and RPC only; zero live signatures, sends, approvals or transfers.`)
