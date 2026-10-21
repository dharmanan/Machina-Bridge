// Deterministic protocol/error regressions; HTTP/RPC/clock are test doubles. No live API or writes.
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
const require = createRequire(import.meta.url), ts = require('typescript')
require.extensions['.ts'] = (mod, file) => mod._compile(ts.transpileModule(readFileSync(file, 'utf8'), { fileName: file,
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText, file)
const root = fileURLToPath(new URL('..', import.meta.url))
let network = 0
globalThis.fetch = async () => { network++; throw new Error('external_network_forbidden') }
const p = require(`${root}src/lib/uniswapArcPolicy.ts`)
const server = require(`${root}api/_lib/uniswap-arc-preview.ts`)
const handler = require(`${root}api/uniswap-arc-preview.ts`).default
const { createUniswapArcPreviewReader, ArcPreviewError, uniswapArcPreviewErrorMessage } = require(`${root}src/lib/uniswapArcPreview.ts`)
const { decodeFunctionData, encodeFunctionData } = require('viem')
const raw = JSON.parse(readFileSync(`${root}scripts/fixtures/uniswap-arc/USDC-EURC.json`, 'utf8'))
const base = Date.now()
const request = { chainId: 5042, tokenIn: 'USDC', tokenOut: 'EURC', owner: raw.swapTransaction.from, recipient: raw.swapTransaction.from, amount: '1', minimumOutput: '1', slippageBps: 50, maxNetworkFee: '100000000000000000' }
const ctx = { owner: request.owner, chainId: 5042, connected: true }
function review() {
  const tx = structuredClone(raw.swapTransaction), outer = decodeFunctionData({ abi: p.EXECUTE_ABI, data: tx.data })
  const canonical = encodeFunctionData({ abi: p.EXECUTE_ABI, functionName: 'execute', args: outer.args })
  tx.data = encodeFunctionData({ abi: p.EXECUTE_ABI, functionName: 'execute', args: [outer.args[0], outer.args[1], BigInt(Math.floor(base / 1000) + 120)] }) + tx.data.slice(canonical.length)
  return { request, transaction: tx, estimatedOutput: raw.quote.output.amount, requiredMinimum: raw.quote.output.minimumAmount,
    requestStartedAt: base, expiresAt: base + 30000, routerHash: p.ARC_ROUTER_HASH, blockNumber: '27114546', gasLimit: '130000',
    maxFeePerGas: '2000000000', maxPriorityFeePerGas: '0', networkFee: '260000000000000', nativeBalance: '100000000000000000000',
    simulation: 'passed', writesEnabled: false, executionBound: false, quoteId: raw.quote.quoteId }
}
function reader(options = {}) {
  const state = { wall: base + (options.skew ?? 0), mono: 1000 }
  const r = createUniswapArcPreviewReader(() => options.context ?? ctx, async (_url, init) => {
    state.mono += options.rtt ?? 50; state.wall += options.rtt ?? 50
    if (options.transportError) throw new Error('secret-server-payload')
    const headers = { 'X-Preview-Request-Id': init.headers['X-Preview-Request-Id'], 'X-Preview-Server-Time': String(base + (options.preparation ?? 0)), ...options.headers }
    return options.response ?? Response.json(options.review ?? review(), { headers, status: options.status ?? 200 })
  }, { wallNow: () => state.wall, monotonicNow: () => state.mono })
  return { r, state }
}
let count = 0
async function test(name, run) { await run(); count++; console.log(`PASS ${name}`) }
await test('fixed client/server clock offsets are not quote age; all economics remain enforced', async () => {
  for (const skew of [-3600000, -60000, 0, 60000, 3600000]) {
    const { r } = reader({ skew })
    await r.read(request)
    assert.ok(r.current(request)); assert.ok(r.remainingMs(request) <= 29950)
  }
})
await test('monotonic expiry and full measured RTT consume the original TTL without any tolerance extension', async () => {
  const { r, state } = reader(); await r.read(request)
  state.mono += 10000; state.wall += 10000
  assert.equal(r.remainingMs(request), 19950)
  state.mono += 20000; state.wall += 20000
  assert.equal(r.current(request), null)
  await assert.rejects(reader({ rtt: 19000, preparation: 19000 }).r.read(request), error => error.code === 'expired')
  await assert.rejects(reader({ rtt: 22000 }).r.read(request), error => error.code === 'timing')
})
await test('wall-clock rollback never extends TTL; forward jumps/suspension and monotonic reset invalidate', async () => {
  const back = reader(); await back.r.read(request)
  back.state.mono += 31000; back.state.wall -= 3600000
  assert.equal(back.r.current(request), null)
  const forward = reader(); await forward.r.read(request); forward.state.wall += 3600000
  assert.equal(forward.r.current(request), null)
  const reset = reader(); await reset.r.read(request); reset.state.mono = 0
  assert.equal(reset.r.current(request), null)
})
await test('missing/malformed/unsafe server time and absent/mismatched request nonce reject replay', async () => {
  for (const headers of [{ 'X-Preview-Server-Time': '' }, { 'X-Preview-Server-Time': 'NaN' }, { 'X-Preview-Server-Time': '9007199254740992' },
    { 'X-Preview-Server-Time': String(base - 1) }, { 'X-Preview-Request-Id': '' }, { 'X-Preview-Request-Id': crypto.randomUUID() }]) {
    await assert.rejects(reader({ headers }).r.read(request), error => error.code === 'timing')
  }
})
await test('expired quote, false simulation and economic mismatch remain blocked independent of clock offset', async () => {
  for (const [change, expected] of [[{ expiresAt: base - 1 }, 'expired'], [{ executionBound: true }, 'policy'], [{ estimatedOutput: '999999999999' }, 'policy'], [{ simulation: 'failed' }, 'policy']]) {
    await assert.rejects(reader({ skew: -3600000, review: { ...review(), ...change } }).r.read(request), error => error.code === expected)
  }
})
await test('request mismatch and changed wallet are classified separately from HTTP and economic rejection', async () => {
  await assert.rejects(reader({ review: { ...review(), request: { ...request, amount: '0.1' } } }).r.read(request), error => error.code === 'context')
  await assert.rejects(reader({ context: { ...ctx, connected: false } }).r.read(request), error => error.code === 'context')
})
await test('HTTP/transport/JSON failures expose only allowlisted stage messages and bounded status', async () => {
  for (const [status, code] of [[403, 'http_origin'], [429, 'http_rate'], [503, 'http_unavailable'], [404, 'http_route'], [400, 'http_request']]) {
    await assert.rejects(reader({ status }).r.read(request), error => error.code === code && error.status === status && uniswapArcPreviewErrorMessage(error).includes(`HTTP ${status}`))
  }
  await assert.rejects(reader({ transportError: true }).r.read(request), error => error.code === 'transport' && !uniswapArcPreviewErrorMessage(error).includes('secret'))
  await assert.rejects(reader({ response: Response.json({ bad: true }) }).r.read(request), error => error.code === 'response')
  assert.equal(uniswapArcPreviewErrorMessage(new Error('private-key-secret')).includes('private-key-secret'), false)
  assert.ok(uniswapArcPreviewErrorMessage(new ArcPreviewError('policy')).includes('safety'))
})
await test('actual API handler binds successful response to request nonce and stamps checked server time; origin remains strict', async () => {
  const oldPrepare = server.prepareArcPreview, oldOrigin = process.env.UNISWAP_ARC_ALLOWED_ORIGIN
  server.prepareArcPreview = async () => review()
  process.env.UNISWAP_ARC_ALLOWED_ORIGIN = 'https://allowed.test'
  async function invoke(headers) {
    const result = { headers: {}, status: 0, body: null }
    const response = { setHeader(k, v) { result.headers[k] = v }, status(n) { result.status = n; return response }, json(v) { result.body = v } }
    await handler({ method: 'POST', headers, body: request }, response)
    return result
  }
  try {
    const id = crypto.randomUUID(), headers = { origin: 'https://allowed.test', 'content-type': 'application/json', 'x-preview-request-id': id }
    const success = await invoke(headers)
    assert.equal(success.status, 200); assert.equal(success.headers['X-Preview-Request-Id'], id)
    assert.ok(Number(success.headers['X-Preview-Server-Time']) >= base)
    assert.equal(success.headers['Cache-Control'], 'no-store')
    assert.equal((await invoke({ ...headers, origin: 'https://other.test' })).status, 403)
    assert.equal((await invoke({ ...headers, 'x-preview-request-id': 'arbitrary-header-injection' })).status, 400)
    server.prepareArcPreview = async () => ({ ...review(), expiresAt: base - 1 })
    assert.equal((await invoke(headers)).status, 503)
  } finally {
    server.prepareArcPreview = oldPrepare
    if (oldOrigin === undefined) delete process.env.UNISWAP_ARC_ALLOWED_ORIGIN; else process.env.UNISWAP_ARC_ALLOWED_ORIGIN = oldOrigin
  }
})
assert.equal(network, 0)
console.log(`${count} timing/error/API protocol groups PASS; zero external requests or transactions.`)
