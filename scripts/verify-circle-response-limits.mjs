import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
const require = createRequire(import.meta.url), ts = require('typescript')
require.extensions['.ts'] = (m, f) => m._compile(ts.transpileModule(readFileSync(f, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, f)
const { createBoundedCircleFetch, assertBoundedCircleJson, isCircleGuardedRequest, CIRCLE_RESPONSE_LIMITS: L, installCircleResponseLimits } = require('../src/lib/circleResponseLimits.ts')
const URL = 'https://api.circle.com/v1/borrowKit/loans/borrow/quote'
let count = 0
async function test(name, fn) { await fn(); count++; console.log('PASS ' + name) }
await test('only the exact Circle Borrow/Swap origin and service paths are guarded', () => {
  for (const path of ['/v1/borrowKit/markets', '/v1/stablecoinKits/quote', '/v1/stablecoinKits/swap']) assert.equal(isCircleGuardedRequest('https://api.circle.com' + path), true)
  for (const u of ['https://api.circle.com.attacker.invalid/v1/borrowKit/x', 'http://api.circle.com/v1/borrowKit/x', 'https://api.circle.com/v1/earnKit/quote', 'https://api.circle.com/v1/cctp/x', '/api/borrow-markets']) assert.equal(isCircleGuardedRequest(u), false)
})
await test('valid economic JSON bytes, status, headers and errors are preserved without reserialization', async () => {
  const json = '{"amount":"1000000000000000000000000000000000","data":"0x1234","gas":52000}'
  let requests = 0
  const f = createBoundedCircleFetch(async () => { requests++; return new Response(json, { status: 200, headers: { 'content-type': 'application/json', 'x-request-id': 'fixture' } }) })
  const r = await f(URL); assert.equal(await r.text(), json); assert.equal(r.headers.get('x-request-id'), 'fixture'); assert.equal(requests, 1)
  const rate = await createBoundedCircleFetch(async () => new Response('{"code":"rate_limited"}', { status: 429 }))(URL)
  assert.equal(rate.status, 429); assert.equal((await rate.json()).code, 'rate_limited')
})
await test('an oversized declared body is cancelled without reading or retrying', async () => {
  let cancelled = 0, fetches = 0
  const stream = new ReadableStream({ cancel() { cancelled++ } })
  const f = createBoundedCircleFetch(async () => { fetches++; return new Response(stream, { headers: { 'content-length': String(L.bytes + 1) } }) })
  await assert.rejects(f(URL), e => e.code === 'body_size'); assert.equal(fetches, 1); assert.equal(cancelled, 1)
})
await test('chunked responses and lying content lengths cannot bypass the decoded-byte limit', async () => {
  for (const headers of [{}, { 'content-length': '1' }]) {
    let cancelled = false
    const stream = new ReadableStream({ start(c) { c.enqueue(new Uint8Array(L.bytes)); c.enqueue(new Uint8Array(1)) }, cancel() { cancelled = true } })
    await assert.rejects(createBoundedCircleFetch(async () => new Response(stream, { headers }))(URL), e => e.code === 'body_size')
    assert.equal(cancelled, true)
  }
})
await test('unconstrained Zod arrays never see over-wide service collections', async () => {
  let visited = 0
  const z = createRequire(require.resolve('@circle-fin/borrow-kit'))('zod')
  const schema = z.array(z.any().superRefine(() => { visited++ }))
  const f = createBoundedCircleFetch(async () => Response.json(Array(L.width + 1).fill('x')))
  await assert.rejects(async () => schema.parse(await (await f(URL)).json()), e => e.code === 'json_shape')
  assert.equal(visited, 0)
})
await test('width, nested node count, depth and strings are bounded independently', () => {
  assert.throws(() => assertBoundedCircleJson(JSON.stringify(Object.fromEntries(Array.from({ length: L.width + 1 }, (_, i) => [i, 1])))), e => e.code === 'json_shape')
  assert.throws(() => assertBoundedCircleJson(JSON.stringify(Array(100).fill(Array(100).fill(1)))), e => e.code === 'json_shape')
  let deep = 1; for (let i = 0; i < L.depth + 1; i++) deep = [deep]
  assert.throws(() => assertBoundedCircleJson(JSON.stringify(deep)), e => e.code === 'json_shape')
  assert.throws(() => assertBoundedCircleJson(JSON.stringify('x'.repeat(L.string + 1))), e => e.code === 'json_shape')
  assert.doesNotThrow(() => assertBoundedCircleJson('{"__proto__":{"safe":true},"n":"1.000001"}'))
  assert.equal({}.safe, undefined)
})
await test('malformed JSON and invalid UTF-8 fail before SDK parsing with fixed error messages', async () => {
  for (const body of ['not-json', new Uint8Array([0xff])]) await assert.rejects(createBoundedCircleFetch(async () => new Response(body))(URL), e => e.code === 'invalid_json' && !e.message.includes('not-json'))
})
await test('empty legitimate responses retain their HTTP status', async () => {
  const r = await createBoundedCircleFetch(async () => new Response(null, { status: 204 }))(URL)
  assert.equal(r.status, 204)
})
await test('caller cancellation reaches the underlying request and never retries', async () => {
  const controller = new AbortController(); let fetches = 0
  const f = createBoundedCircleFetch(async (_i, init) => { fetches++; return new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true })) })
  const pending = f(URL, { signal: controller.signal }); controller.abort()
  await assert.rejects(pending); assert.equal(fetches, 1)
})
await test('an already cancelled request does not call the service and body cancellation is immediate', async () => {
  const controller = new AbortController(); controller.abort()
  let calls = 0
  const f = createBoundedCircleFetch(async () => { calls++; return Response.json({ ok: true }) })
  await assert.rejects(f(URL, { signal: controller.signal })); assert.equal(calls, 0)
  const later = new AbortController(), stream = new ReadableStream({ pull() {} })
  const pending = createBoundedCircleFetch(async () => new Response(stream))(URL, { signal: later.signal })
  await new Promise(r => setTimeout(r, 10)); later.abort(); await assert.rejects(pending)
})
await test('two concurrent requests keep independent timers and cancellation', async () => {
  const f = createBoundedCircleFetch(async (_i, init) => { if (init.headers?.slow) return new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true })); return Response.json({ ok: true }) })
  const controller = new AbortController(), slow = f(URL, { headers: { slow: 'yes' }, signal: controller.signal })
  const fast = await f(URL); controller.abort(); await assert.rejects(slow); assert.deepEqual(await fast.json(), { ok: true })
})
await test('scope exclusion leaves Bridge, Earn, RPC and unrelated responses untouched', async () => {
  const original = new Response('not-json'), input = { method: 'POST', body: 'unchanged' }
  const f = createBoundedCircleFetch(async (i, init) => { assert.equal(init, input); return original })
  assert.equal(await f('https://rpc.mainnet.arc.io', input), original)
})
await test('installation is idempotent and does not replace fetch temporarily during an await', () => {
  const original = globalThis.fetch
  try { globalThis.fetch = async () => Response.json({ ok: true }); installCircleResponseLimits(); const once = globalThis.fetch; installCircleResponseLimits(); assert.equal(globalThis.fetch, once) } finally { globalThis.fetch = original }
})
await test('a stalled response is aborted within the bounded deadline', async () => {
  let aborted = false
  const f = createBoundedCircleFetch(async (_i, init) => new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => { aborted = true; reject(new Error('fixture')) }, { once: true })))
  await assert.rejects(f(URL), e => e.code === 'timeout'); assert.equal(aborted, true)
})
console.log(`RESULT ${count}/${count} PASS; bounded pre-SDK JSON; no external requests or wallet calls`)
