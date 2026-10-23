// Transaction verification: chain facts and Review verification are separate answers.
// Includes the regression for the first real Arc swap (0x1a5e6d2d…a921) using the RPC evidence stored in the repository.
// Controlled ports only: no network, no wallet, no signatures, no transactions.
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
const require = createRequire(import.meta.url), ts = require('typescript')
require.extensions['.ts'] = (mod, file) => mod._compile(ts.transpileModule(readFileSync(file, 'utf8'), { fileName: file,
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText, file)
const root = fileURLToPath(new URL('..', import.meta.url))
const p = require(`${root}src/lib/uniswapArcPolicy.ts`), e = require(`${root}src/lib/uniswapArcExecution.ts`)
const { createArcExecutionRpc } = require(`${root}src/lib/uniswapArcExecutionRpc.ts`)
const ev = require(`${root}src/lib/swap/transactionEvidence.ts`), ur = require(`${root}src/lib/swap/universalRouter.ts`)
const fresh = require(`${root}scripts/fixtures/uniswap-arc/execution-review.cjs`)
const { formatTransaction, formatTransactionReceipt, decodeFunctionData, decodeAbiParameters, encodeAbiParameters, encodeFunctionData } = require('viem')
let count = 0, external = 0
globalThis.fetch = async () => { external++; throw Error('network_forbidden') }
async function test(name, fn) { await fn(); count++; console.log(`PASS ${name}`) }
const owner = '0xafbB6Cc5C0a9C0eB1BfF8dB2eD807e83aAB8e321', other = '0x2222222222222222222222222222222222222222'
const FEE_RECIPIENT = '0x147CF09E7373B8FDA6f12021F1b0f98D6da1A566'
const HASH = '0x1a5e6d2db765c80787cc428163e6fc0defe2f329b594d775715371a1e5efa921'

// --- the real first swap, as recorded from Arc RPC (eth_getTransactionByHash / receipt / block) -------------------------
const raw = JSON.parse(readFileSync(`${root}scripts/fixtures/uniswap-arc/first-pilot-result.json`, 'utf8'))
const realTx = formatTransaction(raw.eth_getTransactionByHash), realReceipt = formatTransactionReceipt(raw.eth_getTransactionReceipt)
const realBlock = { hash: raw.eth_getBlockByNumber.hash, timestamp: BigInt(raw.eth_getBlockByNumber.timestamp), number: BigInt(raw.eth_getBlockByNumber.number) }
const chainTx = { hash: realTx.hash, from: realTx.from, to: realTx.to, chainId: realTx.chainId, nonce: realTx.nonce, type: realTx.type, value: realTx.value, gas: realTx.gas,
  maxFeePerGas: realTx.maxFeePerGas, maxPriorityFeePerGas: realTx.maxPriorityFeePerGas, input: realTx.input }
const chainReceipt = { transactionHash: realReceipt.transactionHash, from: realReceipt.from, to: realReceipt.to, status: realReceipt.status, blockNumber: realReceipt.blockNumber, blockHash: realReceipt.blockHash,
  transactionIndex: realReceipt.transactionIndex, gasUsed: realReceipt.gasUsed, effectiveGasPrice: realReceipt.effectiveGasPrice, logs: realReceipt.logs }
const EURC = p.ARC_OUTPUTS.EURC.address

await test('first real swap: the chain facts are success, block 27278158, 0.1 USDC in, 0.087854 EURC net out, 0.003800899 USDC fee', () => {
  assert.equal(realTx.hash, HASH); assert.equal(realTx.chainId, 5042); assert.equal(realReceipt.status, 'success'); assert.equal(realReceipt.blockNumber, 27278158n)
  assert.equal(raw.eth_getBlockByNumber.hash, realReceipt.blockHash); assert.equal(realTx.value, 10n ** 17n)
  assert.equal(realReceipt.gasUsed * realReceipt.effectiveGasPrice, 3800899000000000n)
  const flows = ev.ownerFlows(chainReceipt, owner, [EURC, p.ARC_USDC])
  assert.equal(flows.ok, true); assert.equal(flows.flows.get(EURC.toLowerCase()).net, 87854n); assert.equal(flows.flows.get(EURC.toLowerCase()).sent, 0n)
  // 0.1 USDC left the wallet as native value; nothing came back as a refund.
  assert.equal(flows.nativeRefund, 0n); assert.equal(realTx.maxPriorityFeePerGas, 1500000000n)
})
await test('first real swap: the on-chain calldata decodes fully; it carries a 1.60% TAKE_PORTION to a third party the Review policy never allowed', () => {
  const decoded = ur.decodeUniversalRouterCalldata(realTx.input); assert.equal(decoded.ok, true)
  const program = decoded.program
  assert.equal(program.signature, 'V4_SWAP[SWAP_EXACT_IN,SETTLE,TAKE_PORTION,TAKE]+SWEEP'); assert.equal(program.swapKind, 'v4-path'); assert.deepEqual(program.unknown, [])
  assert.equal(program.amountIn, 100000n); assert.equal(program.swapMinimum, 88746n); assert.equal(program.deadline, 1792669644n)
  assert.equal(program.portions.length, 1); assert.equal(program.portions[0].bips, 160n); assert.equal(program.portions[0].recipient, FEE_RECIPIENT); assert.equal(program.portions[0].token, EURC)
  assert.ok(program.takes.some(t => t.kind === 'take' && p.sameAddress(t.recipient, owner) && p.sameAddress(t.token, EURC)))
  // The router enforces 88,746 on the gross output; the portion is taken afterwards, so only 88,746 x 98.4% is guaranteed.
  assert.equal(ur.guaranteedNetMinimum(program), 87326n); assert.equal(ur.portionRecipients(program, owner).length, 1)
  // The actual net 87,854 respects that guarantee but is below the swap's own declared minimum.
  assert.ok(87854n >= 87326n && 87854n < 88746n)
})
await test('the review gate is NOT weakened: that calldata is still refused for a new review (no third-party portion is accepted)', () => {
  const suffixId = realTx.input.slice(-32), quoteId = [suffixId.slice(0, 8), suffixId.slice(8, 12), suffixId.slice(12, 16), suffixId.slice(16, 20), suffixId.slice(20)].join('-')
  const request = p.validateArcRequest({ chainId: 5042, tokenIn: 'USDC', tokenOut: 'EURC', owner, recipient: owner, amount: '0.1', minimumOutput: '1', slippageBps: 100, maxNetworkFee: '100000000000000000' })
  assert.throws(() => p.decodeNativeEconomics({ chainId: 5042, from: realTx.from, to: realTx.to, data: realTx.input, value: raw.eth_getTransactionByHash.value }, request, 1n, quoteId), /unsupported_actions/)
})

// A SYNTHETIC reconstruction of what the gate would have accepted: the same program without TAKE_PORTION. It is NOT the original saved
// Review (that lives only in the user's browser) and is used only to exercise the comparison logic.
function reconstructedReviewWithoutPortion() {
  const outer = decodeFunctionData({ abi: p.EXECUTE_ABI, data: realTx.input }), canonical = encodeFunctionData({ abi: p.EXECUTE_ABI, functionName: 'execute', args: outer.args })
  const suffix = realTx.input.slice(canonical.length)
  const [, params] = decodeAbiParameters(p.V4_ENVELOPE, outer.args[1][0])
  const inputs = [...outer.args[1]]
  inputs[0] = encodeAbiParameters(p.V4_ENVELOPE, ['0x070b0e', [params[0], params[1], params[3]]])
  const data = encodeFunctionData({ abi: p.EXECUTE_ABI, functionName: 'execute', args: [outer.args[0], inputs, outer.args[2]] }) + suffix
  return data
}
function intent(over = {}) {
  return { owner, recipient: owner, router: p.ARC_ROUTER, chainId: 5042, nonce: realTx.nonce, value: realTx.value, calldata: realTx.input,
    gasLimit: realTx.gas, maxFeePerGas: realTx.maxFeePerGas, maxPriorityFeePerGas: 0n, feeCeiling: realTx.gas * realTx.maxFeePerGas, outputToken: EURC, requiredMinimum: 87000n,
    outputSymbol: 'EURC', outputDecimals: 6, ...over }
}
const observation = { canonical: true, latestBlock: realReceipt.blockNumber + 5n, blockTimestamp: realBlock.timestamp }
const compare = (reviewed, over = {}) => ev.compareToReview({ attemptHash: HASH, tx: chainTx, receipt: chainReceipt, observation, reviewed, received: 87854n, ...over })

await test('a wallet-added priority fee is allowed only inside the approved fee ceiling; calldata that equals the Review then verifies with notes', () => {
  const report = compare(intent())
  assert.equal(report.verdict, 'verified_with_notes')
  const fee = report.checks.find(c => c.id === 'fee-fields'); assert.equal(fee.status, 'allowed'); assert.match(fee.detail, /priority fee 1.5 gwei \(reviewed 0 gwei\)/)
  assert.equal(report.checks.find(c => c.id === 'calldata').status, 'match')
  // The same transaction against a smaller approved ceiling is a mismatch: the wallet raised the worst-case fee.
  const tight = compare(intent({ feeCeiling: 4000000000000000n, gasLimit: 130000n, maxFeePerGas: 20000000000n }))
  assert.equal(tight.verdict, 'mismatch'); assert.equal(tight.checks.find(c => c.id === 'fee-fields').status, 'mismatch')
  assert.equal(compare(intent({ feeCeiling: 3000000000000000n })).checks.find(c => c.id === 'fee-actual').status, 'mismatch')
})
await test('first real swap vs a Review without the portion: chain SUCCESS but NOT verified; the extra fee and the missed minimum are named', () => {
  const reviewedData = reconstructedReviewWithoutPortion()
  const report = compare(intent({ calldata: reviewedData, requiredMinimum: 88746n }))
  assert.equal(report.verdict, 'mismatch')
  assert.equal(report.checks.find(c => c.id === 'calldata').status, 'mismatch'); assert.equal(report.checks.find(c => c.id === 'minimum').status, 'mismatch')
  assert.ok(report.differences.some(line => /1\.60% of the output \(TAKE_PORTION\) to 0x147C…A566/.test(line)), report.differences.join(' | '))
  assert.ok(report.differences.some(line => /Program differs: reviewed V4_SWAP\[SWAP_EXACT_IN,SETTLE,TAKE\]\+SWEEP; on chain V4_SWAP\[SWAP_EXACT_IN,SETTLE,TAKE_PORTION,TAKE\]\+SWEEP/.test(line)))
  assert.ok(report.differences.some(line => /0\.087854 EURC, below the reviewed minimum 0\.088746/.test(line)))
  // The chain facts did not change: the transaction itself succeeded.
  assert.equal(chainReceipt.status, 'success')
})
await test('binding failures are "unbound": a different hash, sender, nonce or network is not the reviewed transaction at all', () => {
  assert.equal(compare(intent(), { attemptHash: '0x' + 'c'.repeat(64) }).verdict, 'unbound')
  for (const over of [{ owner: other }, { nonce: 99 }, { chainId: 1 }]) assert.equal(compare(intent(over)).verdict, 'unbound', JSON.stringify(over))
  assert.equal(compare(null).verdict, 'no_review'); assert.match(compare(null).differences[0], /No stored Review/)
  assert.equal(compare(null, { attemptHash: '0x' + 'c'.repeat(64) }).verdict, 'unbound')
})
await test('value, router, type, deadline and missing evidence each prevent verification', () => {
  assert.equal(compare(intent({ value: 1n })).verdict, 'mismatch'); assert.equal(compare(intent({ router: other })).verdict, 'mismatch')
  assert.equal(compare(intent(), { tx: { ...chainTx, type: 'legacy' } }).verdict, 'mismatch')
  assert.equal(compare(intent(), { observation: { ...observation, blockTimestamp: 1792669645n } }).checks.find(c => c.id === 'deadline').status, 'mismatch')
  assert.equal(compare(intent(), { observation: { ...observation, blockTimestamp: null } }).verdict, 'incomplete')
  assert.equal(compare(intent(), { received: null }).verdict, 'incomplete')
  assert.equal(compare(intent(), { received: 1n }).verdict, 'mismatch')
})
await test('a reverted transaction is a chain failure and never "received"; it is bound by identity but not judged against the minimum', () => {
  const reverted = { ...chainReceipt, status: 'reverted', logs: [] }
  const report = ev.compareToReview({ attemptHash: HASH, tx: chainTx, receipt: reverted, observation, reviewed: intent(), received: null })
  assert.notEqual(report.verdict, 'unbound'); assert.equal(report.checks.find(c => c.id === 'minimum').status, 'match')
})

// --- controller behaviour with the new result type ---------------------------------------------------------------------
const hash = HASH
function setup(options = {}) {
  const data = options.data ?? new Map(), locks = new Set(), seen = [], settled = [], wallet = []
  const clock = { now: Date.now() }, context = { owner, connected: true, chainId: 5042, connectorId: 'c' }
  const input = p.validateArcRequest({ chainId: 5042, tokenIn: 'USDC', tokenOut: 'EURC', owner, recipient: owner, amount: '0.1', minimumOutput: '1', slippageBps: 50, maxNetworkFee: '100000000000000000' })
  const stats = { quotes: 0, results: 0 }
  const provider = { request: async args => { wallet.push(args); if (args.method === 'eth_chainId') return '0x13b2'; if (args.method === 'eth_accounts') return [owner]; if (args.method === 'eth_getTransactionCount') return '0x7'; if (args.method === 'eth_sendTransaction') return hash; throw Error('unexpected') } }
  const ports = { context: () => context, input: () => input, fresh: async request => { stats.quotes++; return fresh(request, clock.now) }, quoteNow: () => clock.now,
    preflight: async () => ({ nonce: 7, latestNonce: 7 }), provider: async () => provider,
    result: async attempt => { stats.results++; return options.result ? options.result(attempt, stats.results) : { status: 'pending' } },
    storage: { getItem: key => data.get(key) ?? null, setItem: (key, value) => { data.set(key, value) } },
    lock: async (account, run) => { const key = account.toLowerCase(); if (locks.has(key)) throw Error('lock'); locks.add(key); try { return await run() } finally { locks.delete(key) } },
    authorize: () => true, enabled: () => true, changed: view => seen.push(view), settled: attempt => settled.push(attempt) }
  const controller = e.createUniswapArcExecution(ports)
  return { controller, data, stats, seen, settled, ports, wallet, sent: () => wallet.filter(x => x.method === 'eth_sendTransaction'),
    async review() { await controller.prepare(); assert.equal(controller.current().phase, 'review', controller.current().error); return controller.current().approvalId } }
}
const settledResult = (verdict, state = 'success', extra = {}) => async attempt => ({
  status: 'settled', output: state === 'success' ? attempt.review.requiredMinimum : '0', fee: '100000000000000',
  chain: { state, blockNumber: '27278158', blockHash: '0x' + 'b'.repeat(64), gasUsed: '100000', effectiveGasPrice: '1000000000', fee: '100000000000000', received: state === 'success' ? attempt.review.requiredMinimum : null, sent: null, checkedAt: Date.now() },
  intent: { verdict, checks: [{ id: 'calldata', status: verdict === 'mismatch' ? 'mismatch' : 'match', detail: 'x' }], differences: verdict === 'mismatch' ? ['On-chain calldata sends 1.60% of the output (TAKE_PORTION) to 0x147C…A566; the review contained no such fee.'] : [], checkedAt: Date.now() }, ...extra })

await test('chain SUCCESS + verified Review = Confirmed; chain SUCCESS + mismatch = Mismatch (never Confirmed); REVERT = Failed', async () => {
  for (const [verdict, state, expected] of [['verified', 'success', 'confirmed'], ['verified_with_notes', 'success', 'confirmed'], ['mismatch', 'success', 'mismatch'], ['verified', 'reverted', 'failed'], ['mismatch', 'reverted', 'failed']]) {
    const f = setup({ result: settledResult(verdict, state) }); await f.controller.confirm(await f.review())
    assert.equal(f.controller.current().phase, expected, `${verdict}/${state}`); const saved = f.controller.history()[0]
    assert.equal(saved.status, expected); assert.equal(saved.intent.verdict, verdict); assert.equal(saved.chain.state, state)
    assert.equal(f.settled.length, 1); assert.equal(f.controller.current().nextCheckMs, null)
    if (expected === 'mismatch') assert.match(f.controller.current().error, /succeeded, but it is not the transaction you reviewed/)
  }
})
await test('incomplete evidence is Unknown (retried), never Confirmed or Failed; an unbound hash is Unknown and stops automatic checks', async () => {
  const incomplete = setup({ result: settledResult('incomplete') }); await incomplete.controller.confirm(await incomplete.review())
  assert.equal(incomplete.controller.current().phase, 'unknown'); assert.equal(incomplete.controller.current().nextCheckMs, 5000)
  const unbound = setup({ result: async () => { throw new e.ExecutionVerificationError('binding', false) } }); await unbound.controller.confirm(await unbound.review())
  assert.equal(unbound.controller.current().phase, 'unknown'); assert.equal(unbound.controller.current().nextCheckMs, null); assert.match(unbound.controller.current().error, /does not identify the reviewed swap/)
})
await test('a Mismatch is a settled result: it does not block the next swap, a Confirmed one does not either, but Unknown and Pending still do', async () => {
  for (const [result, blocks] of [[settledResult('mismatch'), false], [settledResult('verified'), false], [settledResult('verified', 'reverted'), false], [async () => ({ status: 'pending' }), true], [async () => { throw Error('rpc') }, true]]) {
    const f = setup({ result }); await f.controller.confirm(await f.review()); const quotes = f.stats.quotes
    await f.controller.prepare(); assert.equal(f.stats.quotes, blocks ? quotes : quotes + 1)
  }
})
await test('status lookups never make the known status disappear: the checking flag is separate and phases stay on the recorded status', async () => {
  const f = setup({ result: settledResult('verified') }); await f.controller.confirm(await f.review())
  const reload = setup({ data: f.data, result: settledResult('verified') }); await reload.controller.reconcile()
  const phases = reload.seen.map(view => view.phase)
  assert.ok(phases.length >= 2 && phases.every(phase => phase === 'confirmed'), phases.join(','))
  assert.deepEqual(reload.seen.map(view => view.checking), [true, false])
  // Pending checks keep Pending visible; they never flip through Unknown or Idle.
  const pending = setup({ result: async () => ({ status: 'pending' }) }); await pending.controller.confirm(await pending.review()); pending.seen.length = 0
  await pending.controller.reconcile(owner); await pending.controller.reconcile(owner)
  assert.ok(pending.seen.every(view => view.phase === 'pending'), pending.seen.map(view => view.phase).join(','))
})
await test('transient read failures back off 5s, 10s, 20s, 40s, 60s and stop automatically after 8; deterministic results never retry; terminal and pending schedule correctly', async () => {
  const f = setup({ result: async () => { throw Error('rpc down') } }); await f.controller.confirm(await f.review())
  const delays = [f.controller.current().nextCheckMs]
  for (let i = 0; i < 7; i++) { await f.controller.reconcile(owner); delays.push(f.controller.current().nextCheckMs) }
  assert.deepEqual(delays, [5000, 10000, 20000, 40000, 60000, 60000, 60000, null]); assert.match(f.controller.current().error, /Automatic checks stopped/)
  assert.equal(f.controller.current().phase, 'pending') // the last known status stays visible; the read problem is explained, not turned into another status
  const pending = setup({ result: async () => ({ status: 'pending' }) }); await pending.controller.confirm(await pending.review()); assert.equal(pending.controller.current().nextCheckMs, 5000)
  // A manual check after the automatic stop still works and clears the failure counter when the chain answers.
  f.ports.result = settledResult('verified'); await f.controller.reconcile(owner); assert.equal(f.controller.current().phase, 'confirmed')
})
await test('the original saved Review is never rewritten; only status, chain, intent and an append-only log change', async () => {
  const f = setup({ result: async () => { throw Error('rpc') } }); await f.controller.confirm(await f.review())
  const before = JSON.stringify(f.controller.history()[0].review)
  f.ports.result = async () => ({ status: 'pending' }); await f.controller.reconcile(owner)
  f.ports.result = settledResult('mismatch'); await f.controller.reconcile(owner)
  const after = f.controller.history()[0]; assert.equal(JSON.stringify(after.review), before)
  assert.deepEqual(after.log.map(entry => entry.status), ['pending', 'mismatch']); assert.equal(after.status, 'mismatch'); assert.ok(after.log.every(entry => entry.note.length > 0))
  f.ports.result = settledResult('mismatch'); await f.controller.reconcile(owner); assert.equal(f.controller.history()[0].log.length, 2) // no duplicate log entry for an unchanged status
})
await test('stored records stay readable: an old-format record loads, new fields are validated, oversized or unknown fields are refused', async () => {
  const f = setup({ result: settledResult('mismatch') }); await f.controller.confirm(await f.review())
  const key = [...f.data.keys()][0], records = JSON.parse(f.data.get(key)), legacy = JSON.parse(JSON.stringify(records))
  delete legacy[0].chain; delete legacy[0].intent; delete legacy[0].log; legacy[0].status = 'unknown'
  const loaded = e.createExecutionJournal({ getItem: () => JSON.stringify(legacy), setItem() {} }).read(owner); assert.equal(loaded[0].intent, undefined)
  for (const mutate of [r => { r[0].intent.verdict = 'nonsense' }, r => { r[0].chain.state = 'done' }, r => { r[0].extra = 1 }, r => { r[0].log = new Array(41).fill({ at: 1, status: 'pending', note: 'x' }) },
    r => { r[0].intent.differences = new Array(9).fill('x') }, r => { r[0].intent.checks[0].detail = 'x'.repeat(501) }, r => { r[0].status = 'invented' }]) {
    const bad = JSON.parse(JSON.stringify(records)); mutate(bad)
    assert.throws(() => e.createExecutionJournal({ getItem: () => JSON.stringify(bad), setItem() {} }).read(owner), /storage/)
  }
  // A fee above the approved ceiling is a valid MISMATCH record (the chain charged it) but can never be a stored Confirmed one.
  const high = JSON.parse(JSON.stringify(records)); high[0].fee = String(BigInt(high[0].review.networkFee) + 1n)
  assert.equal(e.createExecutionJournal({ getItem: () => JSON.stringify(high), setItem() {} }).read(owner)[0].status, 'mismatch')
  high[0].status = 'confirmed'; assert.throws(() => e.createExecutionJournal({ getItem: () => JSON.stringify(high), setItem() {} }).read(owner), /storage/)
})
await test('a record that is full prefers evicting settled, unremarkable records; mismatch and unresolved records are kept', () => {
  const f = setup({ result: settledResult('mismatch') })
  return (async () => {
    await f.controller.confirm(await f.review()); const mismatch = f.controller.history()[0]
    const journal = e.createExecutionJournal(f.ports.storage)
    for (let i = 0; i < 25; i++) journal.save({ ...structuredClone(mismatch), id: crypto.randomUUID(), status: 'confirmed', intent: undefined, chain: undefined, log: undefined, createdAt: Date.now() + i })
    const kept = journal.read(owner); assert.equal(kept.length, 20); assert.ok(kept.some(a => a.id === mismatch.id), 'the mismatch record is retained')
    // Nothing is deleted: the 6 records that left the active journal (26 saved in total, 20 kept active) are in the archive, with the same content.
    const archived = journal.archived(owner); assert.equal(archived.length + kept.length, 26); assert.equal(archived.length, 6); assert.ok(archived.every(a => a.status === 'confirmed'))
  })()
})
assert.equal(external, 0)

const archive = require(`${root}src/lib/swap/journalArchive.ts`), approvalsLib = require(`${root}src/lib/swap/uniswapApprovals.ts`), circleLib = require(`${root}src/lib/swap/circleSwap.ts`)
await test('records are moved to an archive, never deleted; a full or unreadable archive refuses the NEW record instead of dropping an old one', async () => {
  const f = setup({ result: settledResult('verified') }); await f.controller.confirm(await f.review()); const template = f.controller.history()[0]
  const data = new Map(), storage = { getItem: k => (data.has(k) ? data.get(k) : null), setItem: (k, v) => { if (storage.full && k.includes('archive')) throw Error('quota'); data.set(k, v) } }
  const journal = e.createExecutionJournal(storage), ids = []
  for (let i = 0; i < 20; i++) { const id = crypto.randomUUID(); ids.push(id); journal.save({ ...structuredClone(template), id, createdAt: i + 1 }) }
  // The archive cannot take a record: the 21st save is refused and all 20 are still active.
  storage.full = true; assert.throws(() => journal.save({ ...structuredClone(template), id: crypto.randomUUID(), createdAt: 99 }), /storage/); assert.equal(journal.read(owner).length, 20); assert.deepEqual(journal.read(owner).map(a => a.id).sort(), [...ids].sort())
  storage.full = false; journal.save({ ...structuredClone(template), id: crypto.randomUUID(), createdAt: 100 }); assert.equal(journal.read(owner).length, 20); assert.equal(journal.archived(owner).length, 1)
  assert.ok(ids.includes(journal.archived(owner)[0].id)); assert.equal(journal.read(owner).some(a => a.id === journal.archived(owner)[0].id), false)
  // An unreadable archive is never overwritten.
  data.set(`machina.uniswap.arc.execution.archive.v1:${owner.toLowerCase()}`, '{broken'); assert.throws(() => journal.save({ ...structuredClone(template), id: crypto.randomUUID(), createdAt: 101 }), /storage/); assert.equal(journal.read(owner).length, 20)
  assert.equal(data.get(`machina.uniswap.arc.execution.archive.v1:${owner.toLowerCase()}`), '{broken')
  // The stored list shows archived records (marked), with the active ones.
  data.set(`machina.uniswap.arc.execution.archive.v1:${owner.toLowerCase()}`, JSON.stringify([journal.read(owner)[0]].map(a => ({ ...a, id: crypto.randomUUID() }))))
  const listed = e.listStoredAttempts({ length: data.size, key: i => [...data.keys()][i], getItem: k => data.get(k) ?? null }); assert.equal(listed[0].archived.length, 1)
  // The archive's own size limit is a refusal, not a deletion.
  assert.throws(() => archive.archiveRecord({ getItem: () => null, setItem() {} }, 'k', { id: 'x', pad: 'x'.repeat(archive.ARCHIVE_MAX_CHARS) }, v => v), /storage/)
  assert.throws(() => archive.archiveRecord({ getItem: () => null, setItem() {} }, 'k', { id: 'x' }, v => v), /storage/) // read-back mismatch
  assert.equal(archive.readArchive({ getItem: () => null }, 'k', v => v).length, 0)
})
await test('the approval and Circle journals archive the same way', () => {
  for (const [name, make, key] of [['approvals', approvalsLib.createApprovalJournal, 'machina.uniswap.arc.approvals.archive.v1:'], ['circle', circleLib.createCircleJournal, 'machina.circle.swap.execution.archive.v1:']]) {
    const data = new Map(), storage = { getItem: k => data.get(k) ?? null, setItem: (k, v) => { data.set(k, v) } }, journal = make(storage)
    assert.equal(typeof journal.archived, 'function', name); assert.deepEqual(journal.archived(owner), [])
    assert.ok(key.startsWith('machina.'), name)
  }
})

// --- read-only look-up by hash (the stored Review is missing) -------------------------------------------------------------------------
const lookup = require(`${root}src/lib/swap/hashLookup.ts`)
const lookupRpc = (changes = {}) => ({ getTransaction: async () => realTx, getTransactionReceipt: async () => realReceipt, getBlockNumber: async () => 27278200n, ...changes })
await test('look-up by hash without a stored Review: the first real swap shows what the chain proves, the third-party portion, and that no Review comparison was possible', async () => {
  const r = await lookup.inspectHash(HASH, lookupRpc())
  assert.equal(r.state, 'success'); assert.equal(r.final, true); assert.equal(r.fee, '3800899000000000'); assert.equal(r.blockNumber, '27278158'); assert.equal(r.nonce, 12); assert.ok(p.sameAddress(r.from, owner))
  assert.deepEqual(r.flows, [{ symbol: 'EURC', received: '0.087854', sent: '0' }]); assert.equal(r.nativeValue, (10n ** 17n).toString())
  assert.equal(r.program.kind, 'uniswap-router'); assert.match(r.program.summary, /V4_SWAP\[SWAP_EXACT_IN,SETTLE,TAKE_PORTION,TAKE\]\+SWEEP/); assert.equal(r.program.thirdPartyPortions.length, 1); assert.match(r.program.thirdPartyPortions[0], /^1\.6% of the output to 0x147CF09E/)
  assert.ok(r.notRechecked[0].startsWith('No stored Review record was found')); assert.ok(r.notRechecked.some(t => /fee portion to a third party/.test(t)))
  assert.doesNotMatch(JSON.stringify(r), /Confirmed|confirmed/) // a look-up never claims Confirmed
})
await test('look-up states are honest: invalid, unknown hash, pending, reverted, wrong network and RPC trouble are different answers and none is called a result about the swap', async () => {
  assert.equal((await lookup.inspectHash('0x12', lookupRpc())).state, 'invalid')
  const notFound = () => { const e = new Error('x'); e.name = 'TransactionNotFoundError'; throw e }, noReceipt = () => { const e = new Error('x'); e.name = 'TransactionReceiptNotFoundError'; throw e }
  assert.equal((await lookup.inspectHash(HASH, lookupRpc({ getTransaction: async () => notFound() }))).state, 'not_found')
  assert.equal((await lookup.inspectHash(HASH, lookupRpc({ getTransactionReceipt: async () => noReceipt() }))).state, 'pending')
  assert.equal((await lookup.inspectHash(HASH, lookupRpc({ getTransaction: async () => { throw new Error('timeout') } }))).state, 'unreadable')
  assert.equal((await lookup.inspectHash(HASH, lookupRpc({ getBlockNumber: async () => { throw new Error('timeout') } }))).state, 'unreadable')
  const reverted = await lookup.inspectHash(HASH, lookupRpc({ getTransactionReceipt: async () => ({ ...realReceipt, status: 'reverted', logs: [] }) })); assert.equal(reverted.state, 'reverted'); assert.deepEqual(reverted.flows, []); assert.equal(reverted.fee, '3800899000000000')
  const wrong = await lookup.inspectHash(HASH, lookupRpc({ getTransaction: async () => ({ ...realTx, chainId: 1 }) })); assert.equal(wrong.state, 'unreadable'); assert.ok(wrong.notRechecked.some(t => /not on Arc Mainnet/.test(t)))
  const shallow = await lookup.inspectHash(HASH, lookupRpc({ getBlockNumber: async () => 27278158n })); assert.equal(shallow.final, false)
  const other = await lookup.inspectHash(HASH, lookupRpc({ getTransaction: async () => ({ ...realTx, to: '0x2222222222222222222222222222222222222222' }) })); assert.equal(other.program.kind, 'other-contract')
  for (const r of [reverted, wrong, shallow, other]) assert.ok(r.notRechecked[0].startsWith('No stored Review record was found'))
})

console.log(`${count} swap verification groups PASS. Real first-swap evidence from the repository, controlled ports only; zero network, signatures or transactions.`)
