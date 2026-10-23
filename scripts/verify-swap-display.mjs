// How the Swap screen words things: status wording (chain result and Review verification kept apart), the single transactions list,
// the mode chip, exchange rates. Pure functions only: no network, no wallet, no transactions.
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
const require = createRequire(import.meta.url), ts = require('typescript')
require.extensions['.ts'] = (mod, file) => mod._compile(ts.transpileModule(readFileSync(file, 'utf8'), { fileName: file,
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText, file)
const root = fileURLToPath(new URL('..', import.meta.url))
const pres = require(`${root}src/lib/swap/presentation.ts`), act = require(`${root}src/lib/swap/activity.ts`), mode = require(`${root}src/lib/swap/executionMode.ts`)
const display = require(`${root}src/lib/swapDisplay.ts`), p = require(`${root}src/lib/uniswapArcPolicy.ts`)
let count = 0
async function test(name, fn) { await fn(); count++; console.log(`PASS ${name}`) }
const owner = '0xafbB6Cc5C0a9C0eB1BfF8dB2eD807e83aAB8e321'
const HASH = `0x${'1a'.repeat(32)}`

await test('exchange rates are computed from exact amounts and formatted without grouping the decimals', () => {
  const r = display.exchangeRate
  assert.equal(r(1000000n, 6, 892564n, 6), '0.89256'); assert.equal(r(1000000n, 6, 1119247n, 6), '1.1192'); assert.equal(r(1000000n, 6, 1225n, 8), '0.00001225')
  assert.equal(r(1000n, 8, 61481396n, 6), '6,148,139.6'); assert.equal(r(10n ** 18n, 18, 2400n * 10n ** 6n, 6), '2,400'); assert.equal(r(1000000n, 6, 123456789000n, 6), '123,456.79')
  assert.equal(r(1n, 6, 0n, 6), null); assert.equal(r(0n, 6, 1n, 6), null)
})
await test('the mode chip describes the route and the build, never whether an amount was typed', () => {
  const pilot = mode.swapExecutionConfig('true', owner), open = mode.swapExecutionConfig('true', undefined, 'open'), off = mode.swapExecutionConfig('false', owner)
  const u = (tokenIn, tokenOut) => ({ provider: 'uniswap', tokenIn, tokenOut })
  assert.deepEqual(mode.executionChip(off, u('USDC', 'EURC')), { label: 'Preview only', tone: 'quotes' })
  assert.deepEqual(mode.executionChip(pilot, u('USDC', 'EURC')), { label: 'Controlled pilot', tone: 'pilot' })
  assert.deepEqual(mode.executionChip(pilot, u('EURC', 'USDC')), { label: 'Quotes only', tone: 'quotes' })
  assert.deepEqual(mode.executionChip(pilot, { provider: 'circle', tokenIn: 'USDC', tokenOut: 'EURC' }), { label: 'Quotes only', tone: 'quotes' })
  assert.deepEqual(mode.executionChip(open, u('WETH', 'cirBTC')), { label: 'Live swap', tone: 'live' })
  assert.deepEqual(mode.executionChip(open, { provider: 'circle', tokenIn: 'WETH', tokenOut: 'cirBTC' }), { label: 'Quotes only', tone: 'quotes' })
  assert.deepEqual(mode.executionChip(open, { provider: 'circle', tokenIn: 'WETH', tokenOut: 'cirBTC' }, true), { label: 'Live swap', tone: 'live' })
  assert.equal(mode.executionChip.length >= 2, true)
})
const chain = { state: 'success', blockNumber: '27278158', blockHash: `0x${'bb'.repeat(32)}`, gasUsed: '176786', effectiveGasPrice: '21500000000', fee: '3800899000000000', received: '87854', sent: '100000', checkedAt: 1 }
const base = { hash: HASH, tokenIn: 'USDC', tokenOut: 'EURC', amountIn: '0.1', fee: '3800899000000000', output: '87854' }
await test('status wording keeps the chain result and the Review verification apart: the first real swap reads as success on chain, not verified against the Review', () => {
  const mismatch = pres.statusPresentation({ ...base, status: 'mismatch', chain, intent: { verdict: 'mismatch', checks: [], differences: ['The on-chain program adds a 1.60% fee portion to 0x147C…A566 that the Review did not contain.'], checkedAt: 1 } })
  assert.equal(mismatch.headline, 'Blockchain transaction successful — not verified against your Review'); assert.equal(mismatch.tone, 'warning')
  assert.equal(mismatch.chain.label, 'Blockchain transaction successful'); assert.equal(mismatch.chain.tone, 'success'); assert.match(mismatch.review.label, /^Not verified/); assert.equal(mismatch.review.details.length, 1)
  assert.equal(mismatch.received, '0.087854 EURC'); assert.equal(mismatch.paid, '0.1 USDC'); assert.equal(mismatch.fee, '0.003800899 USDC')
  assert.notEqual(mismatch.headline, 'Confirmed'); assert.doesNotMatch(JSON.stringify(mismatch), /Confirmed/)
})
await test('Confirmed is worded only for a verified result; wallet-adjusted fees are noted, never hidden', () => {
  const ok = pres.statusPresentation({ ...base, status: 'confirmed', chain, intent: { verdict: 'verified', checks: [], differences: [], checkedAt: 1 } })
  assert.equal(ok.headline, 'Confirmed'); assert.equal(ok.tone, 'success'); assert.equal(ok.review.label, 'Matches your Review'); assert.equal(ok.chain.label, 'Blockchain transaction successful')
  const noted = pres.statusPresentation({ ...base, status: 'confirmed', chain, intent: { verdict: 'verified_with_notes', checks: [], differences: [], checkedAt: 1 } })
  assert.match(noted.review.label, /wallet adjusted gas fields within the approved fee ceiling/)
})
await test('every other status has its own honest wording; Pending and unknown never claim success', () => {
  const s = (status, extra = {}) => pres.statusPresentation({ ...base, status, ...extra })
  assert.equal(s('awaiting_wallet').headline, 'Awaiting wallet confirmation'); assert.equal(s('rejected').headline, 'Wallet request rejected')
  assert.equal(s('pending').headline, 'Pending — waiting for Arc'); assert.equal(s('pending').received, null); assert.equal(s('pending').fee, null)
  const failed = s('failed', { chain: { ...chain, state: 'reverted', received: null, sent: null } }); assert.equal(failed.headline, 'Failed — transaction reverted'); assert.equal(failed.tone, 'danger'); assert.equal(failed.chain.label, 'Blockchain: transaction reverted'); assert.equal(failed.fee, '0.003800899 USDC')
  const unknown = s('unknown'); assert.equal(unknown.headline, 'Status not yet verified'); assert.doesNotMatch(unknown.chain.label, /successful/); assert.equal(unknown.received, null)
  const incomplete = s('unknown', { chain, intent: { verdict: 'incomplete', checks: [], differences: [], checkedAt: 1 } }); assert.match(incomplete.headline, /Blockchain transaction successful — Review verification incomplete/); assert.match(incomplete.review.label, /nothing is claimed/)
  for (const status of ['awaiting_wallet', 'pending', 'confirmed', 'failed', 'rejected', 'unknown', 'mismatch']) assert.ok(s(status).headline.length > 5)
})
function swapAttempt(id, createdAt, status = 'confirmed', who = owner) {
  const request = p.validateArcRequest({ chainId: 5042, tokenIn: 'USDC', tokenOut: 'EURC', owner: who, recipient: who, amount: '0.1', minimumOutput: '1', slippageBps: 50, maxNetworkFee: '100000000000000000' })
  return { id, review: { request }, nonce: 1, status, createdAt, hash: HASH, chain: status === 'confirmed' || status === 'mismatch' ? chain : undefined, intent: status === 'mismatch' ? { verdict: 'mismatch', checks: [], differences: ['x'], checkedAt: 1 } : undefined, output: '87854', fee: '3800899000000000', log: [] }
}
await test('one transactions list: the latest in full, every other record in the history, nothing twice, other wallets included, no wallet needed', () => {
  const other = '0x2222222222222222222222222222222222222222'
  const stored = [{ owner, attempts: [swapAttempt('a1', 10), swapAttempt('a2', 30, 'mismatch')], unreadable: false }, { owner: other, attempts: [swapAttempt('b1', 20, 'pending', other)], unreadable: false }]
  const items = act.storedSwapActivity(stored)
  const noWallet = act.splitActivity(items, null); assert.equal(noWallet.latest.id, 'a2'); assert.deepEqual(noWallet.earlier.map(i => i.id), ['b1', 'a1'])
  const mine = act.splitActivity(items, null, other); assert.equal(mine.latest.id, 'b1'); assert.deepEqual(mine.earlier.map(i => i.id), ['a2', 'a1'])
  const live = act.splitActivity([...items, { ...items[0], live: { checking: true } }], items[0].key, owner); assert.equal(live.latest.key, items[0].key); assert.equal(live.latest.live.checking, true); assert.equal(live.earlier.length, 2)
  const all = [live.latest, ...live.earlier].map(i => i.key); assert.equal(new Set(all).size, all.length)
  assert.deepEqual(act.splitActivity([], null), { latest: null, earlier: [] })
  assert.equal(act.unresolvedActivity(items.find(i => i.id === 'b1')), true); assert.equal(act.unresolvedActivity(items.find(i => i.id === 'a1')), false)
  assert.equal(items.find(i => i.id === 'a2').presentation.headline, 'Blockchain transaction successful — not verified against your Review')
})
await test('approval records read as approvals, with the same chain / Review separation', () => {
  const step = { kind: 'token', token: 'EURC', spender: p.ARC_PERMIT2, amount: '1000000', expiration: 0 }
  const a = { id: 'p1', owner, step, transaction: {}, nonce: 1, status: 'confirmed', createdAt: 5, gas: '1', maxFeePerGas: '1', maxPriorityFeePerGas: '0', networkFee: '1', hash: HASH, fee: '921000000000000', log: [] }
  const item = act.approvalActivity(a)
  assert.equal(item.kind, 'approval'); assert.equal(item.title, 'Approve 1 EURC for Permit2'); assert.equal(item.presentation.headline, 'Confirmed'); assert.equal(item.presentation.fee, '0.000921 USDC')
  const mismatch = act.approvalActivity({ ...a, status: 'mismatch', note: 'The chain does not hold exactly the approved allowance.' })
  assert.match(mismatch.presentation.headline, /not verified against your Review/); assert.deepEqual(mismatch.presentation.review.details, ['The chain does not hold exactly the approved allowance.'])
  const permit = act.approvalActivity({ ...a, step: { ...step, kind: 'permit2', spender: p.ARC_ROUTER, expiration: 99 } }); assert.equal(permit.title, 'Permit2 allowance 1 EURC for the Router')
})
console.log(`${count} Swap display groups PASS. Pure functions only; zero network, signatures or transactions.`)
