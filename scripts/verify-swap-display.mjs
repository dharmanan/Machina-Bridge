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
  const pilot = mode.swapExecutionConfig('true', owner, 'pilot'), open = mode.swapExecutionConfig('true', undefined, 'open'), off = mode.swapExecutionConfig('false', owner, 'pilot')
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
const JARGON = /calldata|TAKE_PORTION|PAY_PORTION|SWEEP|V4_SWAP|Universal Router|Permit2|0x[0-9a-fA-F]{6}/i
const plainText = pres => JSON.stringify({ ...pres, technical: undefined })
await test('the first real swap reads as completed with a plain warning: amounts, the 1.60% fee and the reason, and no program jargon on the user-facing fields', () => {
  const differences = ['On-chain calldata sends 1.60% of the output (TAKE_PORTION) to 0x147C…A566; the review contained no such fee.', 'After its fee portions the on-chain program only guarantees 0.086 EURC, below the reviewed minimum.']
  const mismatch = pres.statusPresentation({ ...base, status: 'mismatch', chain, intent: { verdict: 'mismatch', checks: [{ id: 'calldata', status: 'mismatch', detail: 'The calldata differs from the Review.' }], differences, checkedAt: 1 }, reviewedMinimum: '86000' })
  assert.equal(mismatch.headline, 'Swap completed'); assert.equal(mismatch.tone, 'warning'); assert.equal(mismatch.short, 'Completed · differs from review')
  assert.equal(mismatch.received, '0.087854 EURC'); assert.equal(mismatch.paid, '0.1 USDC'); assert.equal(mismatch.fee, '0.003800899 USDC')
  assert.equal(mismatch.amounts, 'Paid 0.1 USDC · Received 0.087854 EURC · Network fee 0.003800899 USDC')
  assert.equal(mismatch.notice.title, 'This swap differs from your review')
  assert.deepEqual(mismatch.notice.lines, ['A fee of 1.60% was taken from the amount you received. It was not part of your review.', 'After that fee, the minimum you were guaranteed was lower than the minimum shown in your review.'])
  assert.equal(mismatch.retry, false); assert.equal(mismatch.working, false)
  assert.doesNotMatch(plainText(mismatch), JARGON); assert.doesNotMatch(plainText(mismatch), /Confirmed|Blockchain/)
  // Nothing is hidden: the raw findings remain for the closed technical details.
  assert.ok(mismatch.technical.some(line => /TAKE_PORTION/.test(line))); assert.ok(mismatch.technical.some(line => /calldata \(mismatch\)/.test(line)))
})
await test('a difference without a plain wording still warns; an actual minimum shortfall is worded with the amounts; a higher fee than the Review is named', () => {
  const s = (checks, differences, extra = {}) => pres.statusPresentation({ ...base, status: 'mismatch', chain, intent: { verdict: 'mismatch', checks, differences, checkedAt: 1 }, reviewedMinimum: '90000', ...extra })
  const unknown = s([{ id: 'calldata', status: 'mismatch', detail: 'x' }], ['The calldata suffix differs.']); assert.deepEqual(unknown.notice.lines, ['The transaction your wallet sent was not exactly the one you reviewed.'])
  const short = s([{ id: 'minimum', status: 'mismatch', detail: 'x' }], ['The wallet received 0.087854 EURC, below the reviewed minimum 0.09 EURC.']); assert.deepEqual(short.notice.lines, ['You received 0.087854 EURC, below the minimum of 0.09 EURC shown in your review.'])
  const fee = s([{ id: 'fee-actual', status: 'mismatch', detail: 'x' }], ['The network fee charged exceeds the approved ceiling.']); assert.deepEqual(fee.notice.lines, ['The network fee was higher than the maximum shown in your review.'])
  const both = s([{ id: 'calldata', status: 'mismatch', detail: 'x' }], ['On-chain calldata sends 0.50% of the output (PAY_PORTION) to 0x1111…2222; the review contained no such fee.', 'Deadline differs: reviewed 1; on chain 2.'])
  assert.equal(both.notice.lines.length, 2); assert.match(both.notice.lines[0], /^A fee of 0.50%/); assert.match(both.notice.lines[1], /not exactly the one you reviewed/)
  const empty = s([], []); assert.equal(empty.notice.lines.length, 1); assert.equal(empty.headline, 'Swap completed')
  for (const item of [unknown, short, fee, both, empty]) assert.doesNotMatch(plainText(item), JARGON)
})
await test('Swap completed has no warning for a verified result; wallet-adjusted fees are noted in plain words, never hidden', () => {
  const ok = pres.statusPresentation({ ...base, status: 'confirmed', chain, intent: { verdict: 'verified', checks: [], differences: [], checkedAt: 1 } })
  assert.equal(ok.headline, 'Swap completed'); assert.equal(ok.tone, 'success'); assert.equal(ok.notice, null); assert.equal(ok.short, 'Completed'); assert.equal(ok.detail, null)
  assert.equal(ok.amounts, 'Paid 0.1 USDC · Received 0.087854 EURC · Network fee 0.003800899 USDC'); assert.equal(ok.retry, false)
  const noted = pres.statusPresentation({ ...base, status: 'confirmed', chain, intent: { verdict: 'verified_with_notes', checks: [], differences: [], checkedAt: 1 } })
  assert.match(noted.detail, /wallet adjusted the network fee slightly; it stayed within the maximum you approved/); assert.equal(noted.notice, null)
})
await test('every other status has its own honest wording; only a certain failure or a declined request offers a safe retry; an unfinished one never does', () => {
  const s = (status, extra = {}) => pres.statusPresentation({ ...base, status, ...extra })
  const awaiting = s('awaiting_wallet'); assert.equal(awaiting.headline, 'Confirm in your wallet'); assert.equal(awaiting.working, true); assert.equal(awaiting.retry, false)
  const rejected = s('rejected'); assert.equal(rejected.headline, 'Swap cancelled'); assert.equal(rejected.retry, true); assert.equal(rejected.working, false); assert.match(rejected.detail, /Nothing was sent/)
  const pending = s('pending'); assert.equal(pending.headline, 'Verifying transaction'); assert.equal(pending.received, null); assert.equal(pending.fee, null); assert.equal(pending.working, true); assert.equal(pending.retry, false); assert.match(pending.detail, /don’t send it again/)
  const failed = s('failed', { chain: { ...chain, state: 'reverted', received: null, sent: null } }); assert.equal(failed.headline, 'Swap failed'); assert.equal(failed.tone, 'danger'); assert.equal(failed.fee, '0.003800899 USDC')
  assert.equal(failed.retry, true); assert.equal(failed.working, false); assert.match(failed.detail, /no tokens were swapped\. Only the network fee was charged/); assert.equal(failed.received, null)
  const unknown = s('unknown'); assert.equal(unknown.headline, 'Verifying transaction'); assert.equal(unknown.retry, false); assert.equal(unknown.working, true); assert.equal(unknown.received, null)
  const noHash = pres.statusPresentation({ status: 'unknown', tokenIn: 'USDC', tokenOut: 'EURC', amountIn: '0.1' }); assert.equal(noHash.headline, 'Waiting for confirmation'); assert.equal(noHash.retry, false); assert.equal(noHash.working, true)
  const incomplete = s('unknown', { chain, intent: { verdict: 'incomplete', checks: [{ id: 'deadline', status: 'unavailable', detail: 'x' }], differences: [], checkedAt: 1 } })
  assert.equal(incomplete.headline, 'Swap completed'); assert.equal(incomplete.tone, 'warning'); assert.equal(incomplete.retry, false); assert.match(incomplete.notice.title, /couldn’t finish checking this swap against your review/)
  // A swap that happened is never offered again, whatever the verification says.
  for (const status of ['confirmed', 'mismatch', 'pending', 'awaiting_wallet', 'unknown']) assert.equal(s(status).retry, false, status)
  for (const status of ['awaiting_wallet', 'pending', 'confirmed', 'failed', 'rejected', 'unknown', 'mismatch']) { assert.ok(s(status).headline.length > 5); assert.doesNotMatch(plainText(s(status)), JARGON, status) }
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
  const a2 = items.find(i => i.id === 'a2'); assert.equal(a2.presentation.headline, 'Swap completed'); assert.notEqual(a2.presentation.notice, null); assert.equal(a2.again, undefined)
})
await test('approval records read as approvals, in plain words, with the same completed / differs-from-review separation', () => {
  const step = { kind: 'token', token: 'EURC', spender: p.ARC_PERMIT2, amount: '1000000', expiration: 0 }
  const a = { id: 'p1', owner, step, transaction: {}, nonce: 1, status: 'confirmed', createdAt: 5, gas: '1', maxFeePerGas: '1', maxPriorityFeePerGas: '0', networkFee: '1', hash: HASH, fee: '921000000000000', log: [] }
  const item = act.approvalActivity(a)
  assert.equal(item.kind, 'approval'); assert.equal(item.title, 'Approval · let Uniswap use 1 EURC'); assert.equal(item.presentation.headline, 'Approval completed'); assert.equal(item.presentation.fee, '0.000921 USDC'); assert.equal(item.presentation.amounts, 'Network fee 0.000921 USDC')
  const mismatch = act.approvalActivity({ ...a, status: 'mismatch', note: 'The chain does not hold exactly the approved allowance.' })
  assert.equal(mismatch.presentation.headline, 'Approval completed'); assert.equal(mismatch.presentation.notice.title, 'This approval differs from your review'); assert.deepEqual(mismatch.presentation.notice.lines, ['The permission on chain is not exactly the amount you approved.'])
  assert.ok(mismatch.presentation.technical.some(line => /does not hold exactly the approved allowance/.test(line))) // kept for the technical details
  const permit = act.approvalActivity({ ...a, step: { ...step, kind: 'permit2', spender: p.ARC_ROUTER, expiration: 99 } }); assert.equal(permit.title, 'Approval · let the Uniswap router use 1 EURC')
  for (const status of ['awaiting_wallet', 'rejected', 'pending', 'failed', 'confirmed', 'mismatch', 'unknown']) {
    const x = act.approvalActivity({ ...a, status }).presentation; assert.doesNotMatch(plainText(x), /Permit2|calldata|spender|allowance\(/i, status); assert.equal(x.retry, false, status)
    assert.equal(x.working, ['awaiting_wallet', 'pending', 'unknown'].includes(status), status)
  }
})
await test('the technical details keep everything the plain view leaves out: wallet, hash, raw findings and the status log; a certain failure offers the same swap again', () => {
  const failed = act.swapActivity({ ...swapAttempt('f1', 40, 'failed'), chain: { ...chain, state: 'reverted', received: null, sent: null }, log: [{ at: 1_800_000_000_000, status: 'failed', note: 'Reverted on chain.' }] })
  assert.deepEqual(failed.again, { provider: 'uniswap', tokenIn: 'USDC', tokenOut: 'EURC', amount: '0.1' })
  const lines = act.activityTechnical(failed); assert.equal(lines[0], `Wallet: ${owner}`); assert.ok(lines.includes(`Transaction: ${HASH}`)); assert.ok(lines.some(line => /Reverted on chain\./.test(line))); assert.ok(lines.some(line => /transaction reverted in block/.test(line)))
  const rejected = act.swapActivity(swapAttempt('r1', 41, 'rejected')); assert.equal(rejected.presentation.headline, 'Swap cancelled'); assert.notEqual(rejected.again, undefined)
  for (const status of ['pending', 'awaiting_wallet', 'unknown', 'confirmed', 'mismatch']) assert.equal(act.swapActivity(swapAttempt(`s-${status}`, 42, status)).again, undefined, status)
  assert.equal(act.circleActivity.length, 1)
})
console.log(`${count} Swap display groups PASS. Pure functions only; zero network, signatures or transactions.`)
