// F4-B1: Circle Iris `/v2/messages/` responses are byte/time bounded by the app's startup guard
// (src/lib/circleResponseLimits.ts). Runs the REAL Circle CCTP v2 provider polling loop, the REAL app
// recovery readers and real Mainnet Iris fixtures against controlled transports only.
// No network, no wallet, no signature, no transaction.
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { CCTPV2BridgingProvider } from '@circle-fin/provider-cctp-v2'
import { BridgeKit } from '@circle-fin/bridge-kit'

const require = createRequire(import.meta.url), ts = require('typescript')
require.extensions['.ts'] = (m, f) => m._compile(ts.transpileModule(readFileSync(f, 'utf8').replaceAll('import.meta.env', '({})'), { fileName: f,
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText, f)
const store = new Map()
globalThis.localStorage = { getItem: k => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)), removeItem: k => store.delete(k) }
globalThis.window = { location: { origin: 'https://machina.test' }, localStorage, dispatchEvent() {}, addEventListener() {}, removeEventListener() {}, setTimeout, clearTimeout }
globalThis.fetch = async input => { throw new Error(`Network forbidden: ${String(input)}`) }

const L = require('../src/lib/circleResponseLimits.ts')
const R = require('../src/lib/mainnetCctpRecovery.ts')
const S = require('../src/lib/solanaSendRuntime.ts')
const FX = require('./fixtures/cctp-recovery.cjs')
const arcSolana = require('./fixtures/real-arc-solana-bridgekit-burn.json')
const pendingReceive = require('./fixtures/arc-solana-pending-receive.json')
const suiArc = require('./fixtures/real-arc-mints.json')

const IRIS = 'https://iris-api.circle.com/v2/messages/26?transactionHash=' + arcSolana.sourceTxHash
const LIMIT = 256 * 1024
let count = 0
async function test(name, fn) { await fn(); count++; console.log('PASS ' + name) }
const bytesOf = async r => new Uint8Array(await r.arrayBuffer())
const guardOver = underlying => L.createBoundedCircleFetch(underlying)
// A valid JSON document of exactly n bytes (pad strings stay under the per-string limit).
function jsonOfSize(n) {
  const base = { messages: [], a: '', b: '' }, room = n - Buffer.byteLength(JSON.stringify(base))
  base.a = 'x'.repeat(Math.floor(room / 2)); base.b = 'x'.repeat(room - base.a.length)
  const text = JSON.stringify(base); assert.equal(Buffer.byteLength(text), n); return text
}
const slowStream = () => { let cancelled = false; return { cancelled: () => cancelled, stream: new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('{"messages":[')) }, pull() { return new Promise(() => {}) }, cancel() { cancelled = true } }) } }

// ------------------------------------------------------------------ scope
await test('Iris messages and Earn service use separately scoped profiles; fee quote, reattest, sandbox and RPC pass through', async () => {
  for (const u of [IRIS, 'https://iris-api.circle.com/v2/messages/5?transactionHash=x', 'https://iris-api.circle.com/v2/messages/8?transactionHash=x',
    'https://api.circle.com/v1/stablecoinKits/quote', 'https://api.circle.com/v1/borrowKit/markets']) assert.equal(L.isCircleGuardedRequest(u), true, u)
  for (const u of ['https://api.circle.com/v1/earnKit/vaults/explore?chain=ARC', 'https://api.circle.com/v1/earnKit/deposit/quote']) assert.equal(L.isCircleGuardedRequest(u), true, u)
  const untouched = ['https://iris-api.circle.com/v2/burn/USDC/fees/26/5', 'https://iris-api.circle.com/v2/reattest/0xabc', 'https://iris-api.circle.com/v2/quote/burn/usdc/26/5',
    'https://iris-api.circle.com/v2/messages', 'https://iris-api.circle.com/v2/messagesX/5', 'https://iris-api-sandbox.circle.com/v2/messages/26?transactionHash=x',
    'http://iris-api.circle.com/v2/messages/26', 'https://iris-api.circle.com.attacker.invalid/v2/messages/26', 'https://api.circle.com/v2/messages/26', '/api/solana-rpc', 'https://rpc.mainnet.arc.io']
  for (const u of untouched) {
    assert.equal(L.isCircleGuardedRequest(u), false, u)
    const original = new Response('<html>not json</html>', { status: 503 }), init = { method: 'POST', body: '{"x":1}', headers: { a: 'b' } }
    let seen
    const f = guardOver(async (i, o) => { seen = [i, o]; return original })
    assert.equal(await f(u, init), original, 'the very same Response object is returned')
    assert.equal(seen[0], u); assert.equal(seen[1], init, 'the very same init object (method, body, headers, signal) is forwarded')
  }
})
await test('Swap/Borrow service profile is unchanged (limits, 8 s deadline, error bodies still validated)', async () => {
  assert.deepEqual({ ...L.CIRCLE_RESPONSE_LIMITS }, { bytes: 262144, nodes: 8192, depth: 32, width: 256, string: 131072, timeoutMs: 8000 })
  await assert.rejects(guardOver(async () => new Response('not-json', { status: 500 }))('https://api.circle.com/v1/stablecoinKits/quote'), e => e.code === 'invalid_json')
  assert.deepEqual({ ...L.IRIS_MESSAGES_RESPONSE_LIMITS }, { bytes: 262144, nodes: 8192, depth: 32, width: 256, string: 131072, timeoutMs: 10000 })
})

// ------------------------------------------------------------------ real Mainnet fixtures, bytes/status/headers
await test('real Mainnet Iris messages (Arc->Solana complete, Arc->Solana pending receive, Sui->Arc) keep their exact bytes, status and headers', async () => {
  const bodies = [JSON.stringify(arcSolana.iris),
    JSON.stringify({ messages: [{ status: pendingReceive.status, eventNonce: pendingReceive.eventNonce, message: pendingReceive.message, attestation: pendingReceive.attestation }] }),
    JSON.stringify({ messages: suiArc.transfers.map(t => ({ status: 'complete', message: t.message, attestation: t.attestation })) })]
  for (const text of bodies) {
    const original = new TextEncoder().encode(text)
    const r = await guardOver(async () => new Response(original, { status: 200, statusText: 'OK', headers: { 'content-type': 'application/json', 'x-request-id': 'iris-fixture', 'content-length': String(original.length) } }))(IRIS)
    assert.equal(r.status, 200); assert.equal(r.statusText, 'OK')
    assert.equal(r.headers.get('content-type'), 'application/json'); assert.equal(r.headers.get('x-request-id'), 'iris-fixture')
    assert.deepEqual(await bytesOf(r), original)
  }
  assert.equal(Buffer.byteLength(JSON.stringify(arcSolana.iris)) < 2048, true, 'a real single-message response is ~1.3 KB, far below 256 KiB')
})
await test('Iris pending shape (pending_confirmations / PENDING) and empty messages pass unchanged', async () => {
  for (const body of [{ messages: [{ status: 'pending_confirmations', message: '0x', attestation: 'PENDING', eventNonce: '0x' + '00'.repeat(32) }] }, { messages: [] }]) {
    const r = await guardOver(async () => Response.json(body))(IRIS)
    assert.deepEqual(await r.json(), body)
  }
})

// ------------------------------------------------------------------ size, chunking, content-length, slow body
await test('256 KiB is accepted; 256 KiB + 1 is refused (declared, chunked and lying Content-Length)', async () => {
  const ok = jsonOfSize(LIMIT)
  assert.equal((await bytesOf(await guardOver(async () => new Response(ok))(IRIS))).length, LIMIT)
  const chunked = text => new ReadableStream({ start(c) { const b = new TextEncoder().encode(text); for (let i = 0; i < b.length; i += 4096) c.enqueue(b.slice(i, i + 4096)); c.close() } })
  assert.equal((await bytesOf(await guardOver(async () => new Response(chunked(ok)))(IRIS))).length, LIMIT, 'many small chunks up to the limit are fine')
  const over = jsonOfSize(LIMIT + 1)
  for (const make of [() => new Response(over), () => new Response(chunked(over)), () => new Response(chunked(over), { headers: { 'content-length': '10' } })]) {
    await assert.rejects(guardOver(async () => make())(IRIS), e => e.code === 'body_size')
  }
  let cancelled = false, pulled = 0
  const declared = new Response(new ReadableStream({ pull(c) { pulled++; c.enqueue(new Uint8Array(1)) }, cancel() { cancelled = true } }), { headers: { 'content-length': String(LIMIT + 1) } })
  await assert.rejects(guardOver(async () => declared)(IRIS), e => e.code === 'body_size')
  assert.equal(cancelled, true, 'an oversized declared body is cancelled before it is read')
  assert.ok(pulled <= 1)
})
await test('a slow (stalled) body is aborted at the 10 s Iris deadline and its stream is cancelled', async () => {
  const realSetTimeout = globalThis.setTimeout, delays = []
  globalThis.setTimeout = (cb, ms, ...a) => { delays.push(ms); return realSetTimeout(cb, ms === 10_000 ? 5 : ms, ...a) }
  try {
    const slow = slowStream()
    await assert.rejects(guardOver(async () => new Response(slow.stream))(IRIS), e => e.code === 'timeout')
    assert.ok(delays.includes(10_000)); assert.equal(slow.cancelled(), true)
  } finally { globalThis.setTimeout = realSetTimeout }
})
await test('non-2xx Iris bodies (404, 429, 5xx HTML) keep status, statusText, headers and bytes; they are not parsed', async () => {
  for (const [status, text, type] of [[404, '{"error":"Message not found"}', 'application/json'], [429, '{"error":"Too Many Requests"}', 'application/json'],
    [503, '<html><body>Service Unavailable</body></html>', 'text/html'], [502, 'ÿ not utf8 \ud800', 'text/plain']]) {
    const original = new TextEncoder().encode(text)
    const r = await guardOver(async () => new Response(original, { status, statusText: 'S' + status, headers: { 'content-type': type, 'retry-after': '3' } }))(IRIS)
    assert.equal(r.status, status); assert.equal(r.statusText, 'S' + status); assert.equal(r.ok, false)
    assert.equal(r.headers.get('content-type'), type); assert.equal(r.headers.get('retry-after'), '3')
    assert.deepEqual(await bytesOf(r), original)
  }
  await assert.rejects(guardOver(async () => new Response(jsonOfSize(LIMIT + 1), { status: 503 }))(IRIS), e => e.code === 'body_size', 'error bodies are still byte bounded')
})

// ------------------------------------------------------------------ real SDK polling (BridgeKit attestation)
const arc = new BridgeKit({ disableErrorReporting: true }).getSupportedChains().find(c => c.chainId === 5042)
const source = { chain: arc, adapter: { prepare: async () => ({}), waitForTransaction: async () => ({}) }, address: '0x' + '11'.repeat(20) }
const sdkMessage = { ...arcSolana.iris.messages[0], cctpVersion: 2, decodedMessage: { sourceDomain: '26', destinationDomain: '5' } }
async function withTransport(underlying, fn, { guard = true } = {}) {
  const saved = globalThis.fetch
  globalThis.fetch = guard ? guardOver(underlying) : underlying
  try { return await fn() } finally { globalThis.fetch = saved }
}
await test('real CCTP v2 provider: a real complete attestation returns the same message with and without the guard', async () => {
  const transport = async () => Response.json({ messages: [sdkMessage] })
  const p = new CCTPV2BridgingProvider()
  const plain = await withTransport(transport, () => p.fetchAttestation(source, arcSolana.sourceTxHash, { maxRetries: 2, retryDelay: 1 }), { guard: false })
  const guarded = await withTransport(transport, () => p.fetchAttestation(source, arcSolana.sourceTxHash, { maxRetries: 2, retryDelay: 1 }))
  assert.deepEqual(guarded, plain); assert.equal(guarded.message, arcSolana.iris.messages[0].message)
})
await test('real CCTP v2 provider: pending -> complete polling is unchanged (same attempt count with and without the guard)', async () => {
  for (const guard of [false, true]) {
    let calls = 0
    const transport = async () => { calls++; return calls < 3 ? Response.json({ messages: [{ ...sdkMessage, status: 'pending_confirmations', attestation: 'PENDING' }] }) : Response.json({ messages: [sdkMessage] }) }
    const r = await withTransport(transport, () => new CCTPV2BridgingProvider().fetchAttestation(source, arcSolana.sourceTxHash, { maxRetries: 5, retryDelay: 1 }), { guard })
    assert.equal(r.status, 'complete'); assert.equal(calls, 3, `guard=${guard}`)
  }
})
await test('real CCTP v2 provider: 404, 429 and 5xx keep the SDK retry decision; a 4xx client error still stops at once', async () => {
  for (const [status, body] of [[404, '{"error":"Message not found"}'], [429, '{"error":"slow down"}'], [503, '<html>down</html>']]) {
    for (const guard of [false, true]) {
      let calls = 0
      const transport = async () => { calls++; return calls < 3 ? new Response(body, { status, statusText: 'S' }) : Response.json({ messages: [sdkMessage] }) }
      const r = await withTransport(transport, () => new CCTPV2BridgingProvider().fetchAttestation(source, arcSolana.sourceTxHash, { maxRetries: 5, retryDelay: 1 }), { guard })
      assert.equal(r.status, 'complete'); assert.equal(calls, 3, `${status} guard=${guard}`)
    }
  }
  for (const guard of [false, true]) {
    let calls = 0
    const err = await withTransport(async () => { calls++; return new Response('{"error":"bad"}', { status: 400, statusText: 'Bad Request' }) },
      () => new CCTPV2BridgingProvider().fetchAttestation(source, arcSolana.sourceTxHash, { maxRetries: 5, retryDelay: 1 }).catch(e => e), { guard })
    assert.match(err.message, /HTTP 400/); assert.equal(calls, 1, `400 guard=${guard}`)
  }
})
await test('real CCTP v2 provider: oversized bodies are retried at most maxRetries times, then fail (no endless polling)', async () => {
  for (const maxRetries of [3, 600]) {
    let calls = 0
    const err = await withTransport(async () => { calls++; return new Response(new ReadableStream({ pull(c) { c.enqueue(new Uint8Array(1)) } }), { headers: { 'content-length': String(LIMIT + 1) } }) },
      () => new CCTPV2BridgingProvider().fetchAttestation(source, arcSolana.sourceTxHash, { maxRetries, retryDelay: 0 }).catch(e => e))
    assert.equal(calls, maxRetries)
    assert.match(err.message, new RegExp(`Maximum retry attempts \\(${maxRetries}\\) exceeded: Circle service response unavailable \\(body_size\\)`))
  }
})
await test('real CCTP v2 provider: a stalled body hangs forever without the guard; with it, the SDK timeout aborts each attempt and polling ends', async () => {
  // Without the guard the SDK clears its timer after headers; response.json() then waits indefinitely.
  const unguarded = slowStream()
  const hung = withTransport(async () => new Response(unguarded.stream), () => new CCTPV2BridgingProvider().fetchAttestation(source, arcSolana.sourceTxHash, { maxRetries: 2, retryDelay: 1, timeout: 50 }), { guard: false })
  const state = await Promise.race([hung.then(() => 'settled', () => 'settled'), new Promise(r => setTimeout(() => r('still pending'), 600))])
  assert.equal(state, 'still pending', 'pre-existing behaviour: an unbounded body read never ends')
  unguarded.stream.cancel().catch(() => {})
  // With the guard the SDK's own abort signal (50 ms here, 2 s by default) covers the body; every attempt ends.
  let calls = 0, aborted = 0
  const err = await withTransport(async (_u, init) => { calls++; init.signal.addEventListener('abort', () => aborted++, { once: true }); return new Response(slowStream().stream) },
    () => new CCTPV2BridgingProvider().fetchAttestation(source, arcSolana.sourceTxHash, { maxRetries: 3, retryDelay: 1, timeout: 50 }).catch(e => e))
  assert.equal(calls, 3); assert.equal(aborted, 3)
  assert.match(err.message, /Maximum retry attempts \(3\) exceeded/)
})

// ------------------------------------------------------------------ app recovery readers (direct Iris reads)
await test('CCTP recovery (readBoundCctpAttestation via inspectMainnetTransferRecovery): identical results with and without the guard', async () => {
  const outcomes = []
  for (const guard of [false, true]) {
    const row = []
    for (const make of [f => f.fetcher, () => async () => Response.json({ messages: [{ status: 'pending_confirmations', message: '0x', attestation: 'PENDING' }] }),
      () => async () => new Response('{"error":"Message not found"}', { status: 404 }), () => async () => new Response('{"error":"x"}', { status: 429 }),
      () => async () => new Response('<html>down</html>', { status: 503 })]) {
      const f = FX.fixture(), fetcher = guard ? guardOver(make(f)) : make(f)
      const r = await R.inspectMainnetTransferRecovery(f.input, { source: f.s, destination: f.d, fetcher }).then(v => ({ stage: v.stage, status: v.status, message: v.message, attestation: v.attestation }), e => ({ error: e.message }))
      row.push(r)
    }
    outcomes.push(row)
  }
  assert.deepEqual(outcomes[1], outcomes[0])
  assert.equal(outcomes[0][1].stage, 'waiting_attestation'); assert.equal(outcomes[0][2].stage, 'waiting_attestation')
  assert.match(outcomes[0][3].error, /HTTP 429/); assert.match(outcomes[0][4].error, /HTTP 503/)
})
await test('Solana->Arc receive evidence (solanaSendRuntime): 404, 5xx and empty answers behave the same with the guard', async () => {
  const evidence = S.destinationEvidence({ evmWallet: '0x' + 'aa'.repeat(20), solanaRecipients: [], solanaRead: async () => { throw new Error('unused') } })
  for (const [response, expect] of [[() => new Response('', { status: 404 }), { status: 'pending' }], [() => Response.json({ messages: [] }), { status: 'pending' }],
    [() => new Response('<html>down</html>', { status: 503 }), /Circle API HTTP 503/]]) {
    for (const guard of [false, true]) {
      const r = await withTransport(async () => response(), () => evidence.attestedMessage('solana-to-arc', 'QsF23bfaQ5Wh1w6nxseNfqfYgvQztM4F2mMjweRhTY9fGMuMxNo1GB73uMRcBCsdysq8MZTexGhssrrhkp5y853').catch(e => e), { guard })
      if (expect instanceof RegExp) assert.match(r.message, expect); else assert.deepEqual(r, expect)
    }
  }
  const big = await withTransport(async () => new Response(jsonOfSize(LIMIT + 1)), () => evidence.attestedMessage('solana-to-arc', 'QsF23').catch(e => e))
  assert.equal(big.code, 'body_size', 'an oversized 2xx body fails closed before JSON.parse')
})
await test('startup installation is idempotent and composes with the existing Swap/Borrow install calls', () => {
  const saved = globalThis.fetch
  try {
    globalThis.fetch = async () => Response.json({ ok: true })
    L.installCircleResponseLimits(); const once = globalThis.fetch
    L.installCircleResponseLimits(); L.installCircleResponseLimits()
    assert.equal(globalThis.fetch, once)
  } finally { globalThis.fetch = saved }
  const main = readFileSync(new URL('../src/main.tsx', import.meta.url), 'utf8')
  assert.equal((main.match(/installCircleResponseLimits\(\)/g) ?? []).length, 1)
  assert.ok(main.indexOf('installCircleResponseLimits()') < main.indexOf('createRoot('), 'installed before the first render')
})

console.log(`RESULT ${count}/${count} Iris response-limit groups PASS; real CCTP v2 provider polling and app recovery readers; no network, wallet or transaction`)
