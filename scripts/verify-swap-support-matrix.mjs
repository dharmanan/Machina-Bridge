// The 24-combination support matrix (4 tokens x 12 directions x 2 providers) against the code that runs and the live evidence file.
// Hermetic: reads only repository files. The evidence file itself comes from the read-only scripts/discover-swap-evidence.mjs.
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
const require = createRequire(import.meta.url), ts = require('typescript')
require.extensions['.ts'] = (mod, file) => mod._compile(ts.transpileModule(readFileSync(file, 'utf8'), { fileName: file,
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText, file)
const root = fileURLToPath(new URL('..', import.meta.url))
const m = require(`${root}src/lib/swap/support.ts`), tokens = require(`${root}src/lib/swap/tokens.ts`), pools = require(`${root}src/lib/swap/uniswapPools.ts`)
const mode = require(`${root}src/lib/swap/executionMode.ts`), approvals = require(`${root}src/lib/swap/uniswapApprovals.ts`), circle = require(`${root}src/lib/swap/circleSwap.ts`), p = require(`${root}src/lib/uniswapArcPolicy.ts`)
const evidence = JSON.parse(readFileSync(`${root}scripts/fixtures/swap/provider-evidence.json`, 'utf8'))
const fixtures = JSON.parse(readFileSync(`${root}scripts/fixtures/swap/circle/arc-circle-swaps.json`, 'utf8'))
const dec = { USDC: 6, EURC: 6, cirBTC: 8, WETH: 18 }
let count = 0
async function test(name, fn) { await fn(); count++; console.log(`PASS ${name}`) }
const owner = '0xafbB6Cc5C0a9C0eB1BfF8dB2eD807e83aAB8e321'

await test('the matrix has exactly 24 entries: every ordered pair of the four tokens for both providers, no duplicates', () => {
  assert.equal(m.SUPPORT_MATRIX.length, 24); assert.equal(new Set(m.SUPPORT_MATRIX.map(e => e.id)).size, 24)
  for (const provider of ['uniswap', 'circle']) for (const { tokenIn, tokenOut } of tokens.SWAP_DIRECTIONS) assert.ok(m.supportFor(provider, tokenIn, tokenOut), `${provider} ${tokenIn}>${tokenOut}`)
  assert.equal(m.supportFor('uniswap', 'USDC', 'USDC'), undefined)
})
await test('every quote claim has live evidence: Uniswap routes were simulated on the real router, Circle quotes were returned by its estimate, for all 12 directions', () => {
  assert.equal(evidence.chainId, 5042); assert.match(evidence.collectedAt, /^2026-/); assert.equal(evidence.uniswap.router.present, true); assert.equal(evidence.uniswap.router.hash, p.ARC_ROUTER_HASH)
  assert.equal(evidence.uniswap.permit2.present, true); assert.equal(evidence.circle.adapterContract.present, true)
  for (const { tokenIn, tokenOut } of tokens.SWAP_DIRECTIONS) {
    const key = `${tokenIn}>${tokenOut}`, u = evidence.uniswap.directions[key], c = evidence.circle.directions[key]
    assert.ok(u && u.best && Number(u.best.estimatedOut) > 0 && !u.error, `uniswap ${key}`); assert.equal(u.review.built, true, `uniswap review ${key}`)
    assert.ok(c && c.estimate && Number(c.estimate.out) > 0 && Number(c.estimate.minimum) > 0 && !c.error, `circle ${key}`)
    assert.deepEqual(u.candidates, pools.candidateRoutes(tokenIn, tokenOut).map(r => r.id)) // the evidence was produced with the routes the app considers
    assert.ok(m.supportFor('uniswap', tokenIn, tokenOut).routes.includes(u.best.route))
  }
  for (const pool of evidence.uniswap.pools) assert.equal(pool.factoryAgrees, true); assert.equal(evidence.uniswap.pools.length, pools.V3_POOLS.length)
})
await test('prices from both providers agree to within a few percent for every direction (a sanity bound, not a promise)', () => {
  for (const { tokenIn, tokenOut } of tokens.SWAP_DIRECTIONS) {
    const key = `${tokenIn}>${tokenOut}`, u = Number(evidence.uniswap.directions[key].best.estimatedOut), c = Number(evidence.circle.directions[key].estimate.out)
    // WETH is quoted at a different input amount for each provider's evidence run only if the amounts differ; they are the same here.
    if (evidence.uniswap.directions[key].amountIn === evidence.circle.directions[key].amountIn) assert.ok(Math.abs(u - c) / Math.max(u, c) < 0.06, `${key}: ${u} vs ${c}`)
  }
})
await test('approval claims match the code of each controller', () => {
  for (const e of m.SUPPORT_MATRIX) {
    if (e.provider === 'uniswap') {
      const request = p.validateArcRequest({ chainId: 5042, tokenIn: e.tokenIn, tokenOut: e.tokenOut, owner, recipient: owner, amount: e.tokenIn === 'cirBTC' ? '0.00001' : e.tokenIn === 'WETH' ? '0.0003' : '1', minimumOutput: '1', slippageBps: 50, maxNetworkFee: '100000000000000000' })
      const plan = approvals.planApprovals(request, { timestamp: 1_800_000_000n, balance: 10n ** 24n, tokenAllowance: 0n, permitAmount: 0n, permitExpiration: 0n, nativeBalance: 10n ** 20n, gasPrice: 1n })
      if (e.tokenIn === 'USDC') { assert.equal(plan.state, 'native_input'); assert.equal(e.approval.kind, 'none'); assert.equal(e.approval.steps, 0) }
      else { assert.equal(plan.state, 'needed'); assert.equal(plan.steps.length, e.approval.steps); assert.equal(e.approval.kind, 'permit2_exact') }
    } else {
      const strategy = circle.circleStrategy({ tokenIn: e.tokenIn }); assert.equal(strategy, e.tokenIn === 'USDC' ? 'permit' : 'approve'); assert.equal(e.approval.kind, strategy === 'permit' ? 'adapter_permit' : 'adapter_exact'); assert.equal(e.approval.steps, 1)
    }
  }
})
await test('execution claims match the real gates: the explicit pilot allows exactly Uniswap USDC>EURC; explicit open allows all Uniswap and all Circle directions; Circle is never in the pilot', () => {
  const pilot = mode.swapExecutionConfig('true', owner, 'pilot'), open = mode.swapExecutionConfig('true', undefined, 'open'), ctx = { connected: true, owner, chainId: 5042 }
  const req = (tokenIn, tokenOut, extra = {}) => p.validateArcRequest({ chainId: 5042, tokenIn, tokenOut, owner, recipient: owner, amount: tokenIn === 'cirBTC' ? '0.00001' : tokenIn === 'WETH' ? '0.0003' : '0.1', minimumOutput: '1', slippageBps: 50, maxNetworkFee: '100000000000000000', ...extra })
  let pilotEnabled = 0
  for (const e of m.SUPPORT_MATRIX) {
    if (e.provider === 'uniswap') {
      const inPilot = mode.swapExecutionRestriction(pilot, req(e.tokenIn, e.tokenOut), ctx) === null, inOpen = mode.swapExecutionRestriction(open, req(e.tokenIn, e.tokenOut), ctx) === null
      assert.equal(inPilot, e.execution.pilot === 'enabled', e.id); assert.equal(inOpen, true, e.id); if (inPilot) pilotEnabled++
    } else {
      assert.notEqual(mode.circleExecutionRestriction(pilot, { owner }, ctx, true), null); assert.equal(mode.circleExecutionRestriction(open, { owner }, ctx, true), null); assert.equal(mode.circleExecutionRestriction(open, { owner }, ctx, false), 'provider_closed')
      assert.equal(e.execution.pilot, 'quotes_only')
    }
    assert.equal(e.execution.open, 'enabled')
  }
  assert.equal(pilotEnabled, 1); assert.equal(circle.CIRCLE_SWAP_WRITES_ENABLED, true)
  const buildStates = (config, circleOpen) => m.SUPPORT_MATRIX.map(e => m.executionInBuild(e, config, circleOpen).available)
  assert.equal(buildStates(pilot, false).filter(Boolean).length, 1); assert.equal(buildStates(open, false).filter(Boolean).length, 12); assert.equal(buildStates(open, true).filter(Boolean).length, 24)
  for (const invalid of [undefined, '', 'OPEN', 'PILOT', 'open ', ' pilot', 'invalid']) {
    const closed = mode.swapExecutionConfig('true', owner, invalid)
    assert.equal(closed.enabled, false)
    assert.equal(buildStates(closed, true).filter(Boolean).length, 0, String(invalid))
    assert.equal(mode.executionChip(closed, { provider: 'uniswap', tokenIn: 'USDC', tokenOut: 'EURC' }, true).label, 'Preview only')
    assert.equal(mode.executionChip(closed, { provider: 'circle', tokenIn: 'EURC', tokenOut: 'USDC' }, true).label, 'Preview only')
  }
  assert.equal(buildStates(mode.swapExecutionConfig('false', owner, 'pilot'), true).filter(Boolean).length, 0)
})
await test('Circle fixture claims match the decoded real transactions: 8 swaps over 7 directions; the other 5 are stated as not seen, never implied', () => {
  const symbolOf = a => tokens.SWAP_SYMBOLS.find(s => tokens.swapToken(s).address.toLowerCase() === a.toLowerCase())
  const adapter = require(`${root}src/lib/swap/circleAdapterDecode.ts`), seen = new Set()
  for (const v of Object.values(fixtures)) { const call = adapter.decodeAdapterExecute(v.tx.input).call, swap = call.instructions.find(i => i.tokenOut !== '0x0000000000000000000000000000000000000000'); seen.add(`${symbolOf(call.tokenInputs[0].token)}>${symbolOf(swap.tokenOut)}`) }
  assert.equal(Object.keys(fixtures).length, 8); assert.deepEqual([...seen].sort(), [...m.CIRCLE_FIXTURE_DIRECTIONS].sort())
  for (const e of m.SUPPORT_MATRIX.filter(x => x.provider === 'circle')) assert.equal(/Real swaps on this direction by other wallets/.test(e.liveTransaction), seen.has(`${e.tokenIn}>${e.tokenOut}`), e.id)
})
await test('no entry claims a live transaction by this application except the one real pilot swap; the unproven parts are always stated', () => {
  for (const e of m.SUPPORT_MATRIX) {
    const claimed = /^Yes:/.test(e.liveTransaction); assert.equal(claimed, e.id === 'uniswap:USDC>EURC', e.id)
    if (!claimed) assert.match(e.liveTransaction, /^None/)
    assert.ok(e.verification.length > 20 && e.execution.text.length > 20 && e.approval.text.length > 10)
  }
})
await test('the summary table the report prints covers all 24 combinations with a status for quote, routing, approval, execution and verification', () => {
  const rows = m.SUPPORT_MATRIX.map(e => [e.id, e.quote ? 'quote' : '', e.routes.length ? 'route' : '', e.approval.kind, e.execution.pilot, e.execution.open, e.verification ? 'verify' : ''])
  assert.equal(rows.length, 24); assert.ok(rows.every(r => r.every(cell => cell !== '')))
})
console.log(`${count} support matrix groups PASS. Repository files only; zero network, signatures or transactions.`)
