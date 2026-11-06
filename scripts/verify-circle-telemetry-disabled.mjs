// F5: Circle SDK telemetry (POST https://api.circle.com/v1/stablecoinKits/logs) stays off in production.
// 1) Inventory: every BridgeKit / EarnKit / SwapKit / BorrowKit constructor in production code uses the
//    supported opt-out options (no alias, no dynamic import, no option the SDK version does not support).
// 2) Real SDKs, fetch fully intercepted: the default options report to Circle; the production options do not,
//    while every operational Circle API request, result and error stays identical.
// No network, no wallet, no signature, no transaction.
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { BridgeKit } from '@circle-fin/bridge-kit'
import { EarnKit } from '@circle-fin/earn-kit'
import { SwapKit } from '@circle-fin/swap-kit'
import { BorrowKit } from '@circle-fin/borrow-kit'

const root = fileURLToPath(new URL('..', import.meta.url))
const TELEMETRY = 'https://api.circle.com/v1/stablecoinKits/logs'
const OPTIONS = {
  BridgeKit: '{ disableErrorReporting: true }', // BridgeKit 1.15.1 has no disableAnalytics option
  EarnKit: '{ disableAnalytics: true, disableErrorReporting: true }',
  SwapKit: '{ disableAnalytics: true, disableErrorReporting: true }',
  BorrowKit: '{ disableAnalytics: true, disableErrorReporting: true }',
}
// Production constructor inventory. A new constructor must be added here deliberately (and configured).
const EXPECTED = { BridgeKit: 13, EarnKit: 2, SwapKit: 2, BorrowKit: 1 }
const PACKAGE = { BridgeKit: 'bridge-kit', EarnKit: 'earn-kit', SwapKit: 'swap-kit', BorrowKit: 'borrow-kit' }
const PROD = { bridge: { disableErrorReporting: true }, earn: { disableAnalytics: true, disableErrorReporting: true } }

let count = 0
async function test(name, fn) { await fn(); count++; console.log('PASS ' + name) }
const files = dir => readdirSync(dir).flatMap(n => { const p = join(dir, n); return statSync(p).isDirectory() ? files(p) : /\.(tsx?|m?js)$/.test(n) ? [p] : [] })
const production = ['src', 'api', 'server'].flatMap(d => files(join(root, d))).map(p => ({ path: relative(root, p), text: readFileSync(p, 'utf8') }))

await test('installed SDK versions are the audited ones (options verified against these versions)', () => {
  const lock = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8')).packages
  for (const [pkg, version] of [['bridge-kit', '1.15.1'], ['earn-kit', '1.7.0'], ['swap-kit', '1.7.0'], ['borrow-kit', '1.0.0']]) {
    assert.equal(lock[`node_modules/@circle-fin/${pkg}`].version, version, `${pkg}: re-audit telemetry options before upgrading`)
    assert.equal(JSON.parse(readFileSync(join(root, `node_modules/@circle-fin/${pkg}/package.json`), 'utf8')).version, version)
  }
  const bridgeTypes = readFileSync(join(root, 'node_modules/@circle-fin/bridge-kit/index.d.ts'), 'utf8')
  assert.match(bridgeTypes, /disableErrorReporting\?: boolean/); assert.doesNotMatch(bridgeTypes, /disableAnalytics/)
  for (const pkg of ['earn-kit', 'swap-kit', 'borrow-kit']) {
    const types = readFileSync(join(root, `node_modules/@circle-fin/${pkg}/index.d.ts`), 'utf8')
    assert.match(types, /disableAnalytics\?: boolean/); assert.match(types, /disableErrorReporting\?: boolean/)
  }
})
await test(`every production constructor uses the opt-out options (BridgeKit ${EXPECTED.BridgeKit}, EarnKit ${EXPECTED.EarnKit}, SwapKit ${EXPECTED.SwapKit}, BorrowKit ${EXPECTED.BorrowKit})`, () => {
  for (const [kit, options] of Object.entries(OPTIONS)) {
    const found = production.flatMap(f => [...f.text.matchAll(new RegExp(`new ${kit}\\(([^)]*)\\)`, 'g'))].map(m => ({ path: f.path, args: m[1].trim() })))
    assert.equal(found.length, EXPECTED[kit], `${kit} constructors: ${found.map(f => f.path).join(', ')}`)
    for (const f of found) assert.equal(f.args, options, `${f.path}: new ${kit}(${f.args})`)
  }
})
await test('no alias, re-export, dynamic import, indirect construction or override of the telemetry endpoint', () => {
  for (const f of production) {
    for (const [kit, pkg] of Object.entries(PACKAGE)) {
      assert.doesNotMatch(f.text, new RegExp(`\\b${kit}\\s+as\\s+\\w+`), `${f.path}: ${kit} alias`)
      assert.doesNotMatch(f.text, new RegExp(`import\\(\\s*['"]@circle-fin/${pkg}['"]`), `${f.path}: dynamic import of ${pkg}`)
      assert.doesNotMatch(f.text, new RegExp(`export\\s*\\{[^}]*\\b${kit}\\b[^}]*\\}\\s*from`), `${f.path}: ${kit} re-export`)
      assert.doesNotMatch(f.text, new RegExp(`Reflect\\.construct\\(\\s*${kit}|new\\s+\\(\\s*${kit}`), `${f.path}: indirect ${kit} construction`)
    }
    assert.doesNotMatch(f.text, /STABLECOIN_KITS_TELEMETRY_URL/, `${f.path}: telemetry endpoint override`)
  }
})

// ---------------- runtime: real SDKs, all requests intercepted ----------------
let log = [], operational = () => { throw new TypeError('Network forbidden in F5 probe') }, telemetryDown = false
globalThis.fetch = async (input, init = {}) => {
  const url = String(input instanceof Request ? input.url : input)
  if (url === TELEMETRY) { log.push({ telemetry: JSON.parse(init.body) }); if (telemetryDown) throw new TypeError('fetch failed'); return Response.json({}) }
  log.push({ op: `${init.method ?? 'GET'} ${url}` })
  return operational(url, init)
}
async function observe(fn) {
  log = []
  let outcome
  try { outcome = { ok: await fn() } } catch (e) { outcome = { error: e?.name, code: e?.code } }
  await new Promise(r => setTimeout(r, 20))
  return { outcome, telemetry: log.filter(x => x.telemetry).map(x => x.telemetry), ops: log.filter(x => x.op).map(x => x.op) }
}
function compare(label, dflt, prod, { reports = true } = {}) {
  if (reports) assert.ok(dflt.telemetry.length > 0, `${label}: the default options report (baseline)`)
  assert.deepEqual(prod.telemetry, [], `${label}: production options send no telemetry`)
  assert.deepEqual(prod.ops, dflt.ops, `${label}: identical operational Circle requests`)
  assert.deepEqual(prod.outcome, dflt.outcome, `${label}: identical result / error`)
  return { label, before: dflt.telemetry.length, after: prod.telemetry.length, operational: prod.ops.length }
}
const table = []
const failingAdapter = { getAddress: async () => { throw new Error('controlled adapter failure') } }
const bridgeParams = () => ({ from: { adapter: failingAdapter, chain: 'Arc' }, to: { adapter: failingAdapter, chain: 'Solana' }, amount: '1' })
const earnJson = body => () => Response.json(body)
const status = code => () => new Response('{"message":"controlled"}', { status: code })
const EXPLORE = { data: { vaults: [], pagination: { page: 1, pageSize: 20, totalCount: 0, totalPages: 0 } } }
const VAULTS = { data: { vaults: [], errors: [] } }

await test('BridgeKit: failed bridge() and estimate() report by default; production options send nothing, same Iris reads and errors', async () => {
  operational = url => url.includes('/v2/cctpx/tokens') ? Response.json({ tokens: [] }) : status(404)()
  for (const op of ['bridge', 'estimate']) {
    const dflt = await observe(() => new BridgeKit()[op](bridgeParams())), prod = await observe(() => new BridgeKit(PROD.bridge)[op](bridgeParams()))
    assert.ok(dflt.telemetry.every(t => t.sdkName === 'bridge-kit' && t.eventType === `bridge_${op}` && t.errorDetails?.errorType))
    table.push(compare(`BridgeKit ${op}() failure`, dflt, prod))
  }
  telemetryDown = true
  const down = await observe(() => new BridgeKit().bridge(bridgeParams())), prod = await observe(() => new BridgeKit(PROD.bridge).bridge(bridgeParams()))
  telemetryDown = false
  assert.deepEqual(prod.outcome, down.outcome, 'telemetry endpoint availability never changes the SDK error')
})
await test('EarnKit: discovery, position and quotes (success and Circle 4xx/5xx) — same Earn API requests and results, no telemetry', async () => {
  const cases = [
    ['exploreVaults success', earnJson(EXPLORE), k => k.exploreVaults({ chain: 'Arc' })],
    ['exploreVaults 500', status(500), k => k.exploreVaults({ chain: 'Arc' })],
    ['getVaults success', earnJson(VAULTS), k => k.getVaults({ vaults: [{ chain: 'Arc', vaultAddress: '0x8E357432CC12ff425c36432F312968aEb16112AF' }] })],
    ['getVaults 503', status(503), k => k.getVaults({ vaults: [{ chain: 'Arc', vaultAddress: '0x8E357432CC12ff425c36432F312968aEb16112AF' }] })],
    ['getDepositQuote invalid adapter', status(400), k => k.getDepositQuote({ from: { adapter: failingAdapter, chain: 'Arc' }, vaultAddress: '0x8E357432CC12ff425c36432F312968aEb16112AF', amount: '1' })],
    ['getWithdrawalQuote invalid adapter', status(400), k => k.getWithdrawalQuote({ from: { adapter: failingAdapter, chain: 'Arc' }, vaultAddress: '0x8E357432CC12ff425c36432F312968aEb16112AF', amount: '1' })],
    ['getPosition invalid adapter', status(400), k => k.getPosition({ from: { adapter: failingAdapter, chain: 'Arc' }, vaultAddress: '0x8E357432CC12ff425c36432F312968aEb16112AF' })],
  ]
  for (const [label, transport, call] of cases) {
    operational = transport
    const dflt = await observe(() => call(new EarnKit())), prod = await observe(() => call(new EarnKit(PROD.earn)))
    assert.ok(dflt.telemetry.every(t => t.sdkName === 'earn-kit'))
    table.push(compare(`EarnKit ${label}`, dflt, prod))
  }
  assert.ok(table.some(r => r.label === 'EarnKit exploreVaults success' && r.operational === 1), 'the operational vault discovery request still goes out')
})
await test('SwapKit and BorrowKit keep their existing opt-out: the app options stay silent where the defaults report', async () => {
  operational = status(500)
  const swap = o => new SwapKit(o).estimate({ from: { adapter: failingAdapter, chain: 'Arc' }, tokenIn: 'USDC', tokenOut: 'EURC', amountIn: '1' })
  table.push(compare('SwapKit estimate failure', await observe(() => swap()), await observe(() => swap({ disableAnalytics: true, disableErrorReporting: true }))))
  const borrow = o => new BorrowKit(o).exploreMarkets({ chain: 'Arc' })
  table.push(compare('BorrowKit exploreMarkets 500', await observe(() => borrow()), await observe(() => borrow({ disableAnalytics: true, disableErrorReporting: true }))))
})

console.log('\nTelemetry POSTs to /v1/stablecoinKits/logs (default options -> production options; operational requests unchanged):')
for (const r of table) console.log(`  ${r.label.padEnd(42)} ${r.before} -> ${r.after}   (operational: ${r.operational})`)
console.log(`RESULT ${count}/${count} Circle SDK telemetry groups PASS; production constructors covered; real SDKs, no network, wallet or transaction`)
