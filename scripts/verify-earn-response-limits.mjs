// F4-B2: validate the app startup Circle EarnKit fetch guard using controlled responses.
// Mainnet measurements (Nov 2026): explore 50.18 KiB / 2562 nodes / 38 vaults / 371 ms;
// position 0.44 KiB / 23 nodes; deposit quote 0.48 KiB / 27 nodes;
// withdrawal quote 0.49 KiB / 29 nodes. These are observations, not SDK fixtures.
// No live network, signatures or wallet operations.
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
const require = createRequire(import.meta.url), ts = require('typescript')
require.extensions['.ts'] = (m, f) => m._compile(ts.transpileModule(readFileSync(f, 'utf8'), {
  fileName: f, compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
}).outputText, f)
const G = require('../src/lib/circleResponseLimits.ts')
const base = 'https://api.circle.com/v1/earnKit/'
const explore = base + 'vaults/explore'
const position = base + 'position/0x' + '11'.repeat(20)
const depositQuote = base + 'deposit/quote'
const withdrawQuote = base + 'withdraw/quote'
let passed = 0
async function test(name, run) { await run(); passed++; console.log('PASS ' + name) }
const wrap = f => G.createBoundedCircleFetch(f)
const bytes = async r => new Uint8Array(await r.arrayBuffer())

await test('exact origin and Earn namespace only, existing Borrow/Swap/Iris profiles preserved', () => {
  for (const u of [explore, position, depositQuote, withdrawQuote, base + 'vaults/get',
    base + 'deposit', base + 'withdraw', base + 'transactionReport'])
    assert.equal(G.isCircleGuardedRequest(u), true, u)
  for (const u of ['http://api.circle.com/v1/earnKit/deposit/quote',
    'https://api.circle.com.attacker.invalid/v1/earnKit/deposit/quote',
    'https://api.circle.com/v1/earnKit', 'https://api.circle.com/v1/earnKitX/deposit/quote',
    'https://iris-api.circle.com/v2/burn/USDC/fees/26/5',
    'https://api.circle.com/v2/earnKit/deposit/quote', 'https://rpc.mainnet.arc.io'])
    assert.equal(G.isCircleGuardedRequest(u), false, u)
  assert.deepEqual({ ...G.CIRCLE_RESPONSE_LIMITS }, { bytes: 262144, nodes: 8192, depth: 32, width: 256, string: 131072, timeoutMs: 8000 })
  assert.deepEqual({ ...G.IRIS_MESSAGES_RESPONSE_LIMITS }, { bytes: 262144, nodes: 8192, depth: 32, width: 256, string: 131072, timeoutMs: 10000 })
  assert.deepEqual({ ...G.EARN_RESPONSE_LIMITS }, { bytes: 2097152, nodes: 65536, depth: 48, width: 1024, string: 131072, timeoutMs: 15000 })
})
await test('non-Earn calls return the exact Response and forward the exact init', async () => {
  const response = new Response('<html>not json</html>', { status: 503 })
  const init = { method: 'POST', headers: { test: 'x' }, body: '{}' }
  for (const u of ['https://rpc.mainnet.arc.io', 'https://api.circle.com/v1/earnKitX/explore']) {
    const f = wrap(async (input, opts) => { assert.equal(input, u); assert.equal(opts, init); return response })
    assert.equal(await f(u, init), response)
  }
})
await test('observed-style explore/position/quotes and signed execution payload keep exact bytes, metadata and request args', async () => {
  const vaults = Array.from({ length: 38 }, (_, index) => ({
    address: '0x' + index.toString(16).padStart(40, '0'),
    symbol: 'USDC', name: 'Arc vault ' + index,
    stats: { apy: '0.042', tvl: '25000.123456', users: 200 },
    description: 'v'.repeat(1150)
  }))
  const cases = [
    [explore, { vaults, pagination: { next: null } }],
    [position, { currentBalance: '1.23456', vault: '0x' + '22'.repeat(20) }],
    [depositQuote, { amount: '0.1', fee: '0', minShares: '0.099' }],
    [withdrawQuote, { amount: '0.1', fee: '0', minAssets: '0.099' }],
    [base + 'deposit', { data: { execId: '0xabc', signature: '0xdead', executionParams: { instructions: [] } } }],
    [base + 'withdraw', { data: { execId: '0xabc', signature: '0xdead', executionParams: { instructions: [] } } }]
  ]
  for (const [url, payload] of cases) {
    const source = new TextEncoder().encode(JSON.stringify(payload))
    const init = { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } }
    let count = 0
    const f = wrap(async (i, args) => {
      assert.equal(i, url); assert.equal(args.method, init.method); assert.equal(args.body, init.body)
      count++
      return new Response(source, { status: 200, statusText: 'OK', headers: { 'x-request-id': 'fixture', 'content-type': 'application/json', 'content-length': String(source.length) } })
    })
    const result = await f(url, init)
    assert.equal(result.status, 200); assert.equal(result.statusText, 'OK')
    assert.equal(result.headers.get('x-request-id'), 'fixture')
    assert.deepEqual(await bytes(result), source)
    assert.equal(count, 1)
  }
})
await test('declared and chunked oversize responses fail closed despite a lying Content-Length', async () => {
  const limit = G.EARN_RESPONSE_LIMITS.bytes
  const big = JSON.stringify({ pad: 'x'.repeat(limit) })
  await assert.rejects(wrap(async () => new Response(big))(explore), e => e.code === 'body_size')
  const chunks = () => new ReadableStream({ start(c) { const b = new TextEncoder().encode(big); for (let i = 0; i < b.length; i += 8192) c.enqueue(b.slice(i, i + 8192)); c.close() } })
  await assert.rejects(wrap(async () => new Response(chunks(), { headers: { 'content-length': '1' } }))(explore), e => e.code === 'body_size')
  let cancelled = false
  const overDeclared = new Response(new ReadableStream({ pull() {}, cancel() { cancelled = true } }), { headers: { 'content-length': String(limit + 1) } })
  await assert.rejects(wrap(async () => overDeclared)(explore), e => e.code === 'body_size')
  assert.equal(cancelled, true)
})
await test('oversized JSON width, nodes, depth and strings fail even when bytes are below limit', async () => {
  const values = [
    { data: Array(1025).fill(0) },
    { data: Array.from({ length: 513 }, () => Array(128).fill(0)) },
    { data: 'x'.repeat(131073) }
  ]
  let deep = 0
  for (let i = 0; i < 50; i++) deep = { nested: deep }
  values.push(deep)
  for (const value of values)
    await assert.rejects(wrap(async () => Response.json(value))(explore), e => e.code === 'json_shape')
  await assert.rejects(wrap(async () => new Response('{invalid', { status: 200 }))(explore), e => e.code === 'invalid_json')
})
await test('404/429/503 including HTML and binary bytes preserve status, headers and body for SDK handling', async () => {
  for (const status of [404, 429, 503]) {
    const source = new Uint8Array([0xff, 0xfe, 0x3c, 0x68, 0x74, 0x6d, 0x6c, 0x3e])
    const result = await wrap(async () => new Response(source, { status, statusText: 'service error', headers: { 'retry-after': '2' } }))(position)
    assert.equal(result.status, status); assert.equal(result.statusText, 'service error')
    assert.equal(result.headers.get('retry-after'), '2')
    assert.deepEqual(await bytes(result), source)
  }
})
await test('stalled Earn response body is cancelled by the 15-second deadline', async () => {
  const oldTimer = globalThis.setTimeout
  const delays = []
  globalThis.setTimeout = (fn, ms, ...args) => {
    delays.push(ms)
    return oldTimer(fn, ms === 15000 ? 5 : ms, ...args)
  }
  let cancelled = false
  try {
    const stream = new ReadableStream({ start(c) { c.enqueue(new Uint8Array([123])) },
      pull() { return new Promise(() => {}) }, cancel() { cancelled = true } })
    await assert.rejects(wrap(async () => new Response(stream))(explore), e => e.code === 'timeout')
    assert.ok(delays.includes(15000)); assert.equal(cancelled, true)
  } finally { globalThis.setTimeout = oldTimer }
})
await test('abort signal and idempotent startup installation remain intact', async () => {
  const controller = new AbortController(); controller.abort()
  let calls = 0
  await assert.rejects(wrap(async () => { calls++; return Response.json({ ok: true }) })(position, { signal: controller.signal }))
  assert.equal(calls, 0)
  const original = globalThis.fetch
  try {
    globalThis.fetch = async () => Response.json({ ok: true })
    G.installCircleResponseLimits()
    const once = globalThis.fetch
    G.installCircleResponseLimits()
    assert.equal(globalThis.fetch, once)
  } finally { globalThis.fetch = original }
})
console.log('RESULT ' + passed + '/' + passed + ' PASS; no live network or wallet actions')
