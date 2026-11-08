// F3: request/upstream limits of the same-origin Solana RPC proxies (api/solana-rpc.js, api/solana-read.js).
// Runs the real handlers and the real web3.js Connection used by the Solana bridge SDK path. Every upstream
// RPC is a local fake: no network, no wallet, no new signature. The signed transactions are public Mainnet
// fixtures (scripts/fixtures/solana-bridge-real-tx.json) and are never broadcast.
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { Keypair, PublicKey, TransactionMessage, VersionedTransaction } from '@solana/web3.js'

const require = createRequire(import.meta.url), ts = require('typescript')
require.extensions['.ts'] = (m, f) => m._compile(ts.transpileModule(readFileSync(f, 'utf8'), { fileName: f,
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText, f)
const { createSolanaBridgeConnection } = require('../src/lib/solanaBridgeConnection.ts')
const { default: rpcHandler } = await import('../api/solana-rpc.js')
const { default: readHandler } = await import('../api/solana-read.js')
const guard = await import('../api/_lib/solana-rpc-guard.js')
const real = require('./fixtures/solana-bridge-real-tx.json')

const ORIGIN = 'https://machina.test'
const CCTP = 'CCTPV2Sm4AdWt5296sk4P66VBZ7bEhcARwFaaS9YPbeC'
const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGXPXeVvGDQaGkvhvKHE7UZy'
const payee = real.burn.owner
const signature = real.burn.signature
const address = n => new PublicKey(Uint8Array.from({ length: 32 }, (_, i) => (i * 7 + n) % 256)).toBase58()
const PROVIDERS = ['https://solana-rpc.publicnode.com', 'https://solana.drpc.org', 'https://api.mainnet-beta.solana.com',
  'https://api.mainnet.solana.com', 'https://rpc.ankr.com/solana']
const READ_PROVIDERS = ['https://api.mainnet.solana.com', 'https://api.mainnet-beta.solana.com', 'https://solana-rpc.publicnode.com', 'https://solana.drpc.org']
delete process.env.SOLANA_MAINNET_RPC

// ---- Fake upstream: plausible answers per method; records every forwarded body. ----
const ctx = { context: { slot: 1 } }
const RESULTS = {
  getLatestBlockhash: { ...ctx, value: { blockhash: address(1), lastValidBlockHeight: 100 } },
  getBalance: { ...ctx, value: 5 },
  getAccountInfo: { ...ctx, value: null },
  getSignatureStatuses: { ...ctx, value: [{ slot: 1, confirmations: null, err: null, confirmationStatus: 'confirmed' }] },
  simulateTransaction: { ...ctx, value: { err: null, logs: [], accounts: null, unitsConsumed: 1, returnData: null } },
  sendTransaction: signature,
  getFeeForMessage: { ...ctx, value: 5000 },
  getBlockHeight: 50,
  getRecentPrioritizationFees: [],
  getGenesisHash: address(2),
  getTokenAccountBalance: { ...ctx, value: { amount: '1', decimals: 6, uiAmount: 0.000001, uiAmountString: '0.000001' } },
  getSlot: 1,
  getTransaction: null,
  isBlockhashValid: { ...ctx, value: true },
  getMinimumBalanceForRentExemption: 3863040,
  getProgramAccounts: [],
  getSignaturesForAddress: [],
}
let upstream = []
let upstreamImpl = null
const defaultUpstream = (url, body) => new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: RESULTS[body.method] }), { status: 200 })

function mockRes() {
  const headers = {}
  return {
    statusCode: 0, body: '', headers,
    status(code) { this.statusCode = code; return this },
    setHeader(k, v) { headers[k.toLowerCase()] = v; return this },
    getHeader(k) { return headers[k.toLowerCase()] },
    send(b) { this.body = b; return this },
  }
}
const lower = h => Object.fromEntries(Object.entries(h || {}).map(([k, v]) => [k.toLowerCase(), v]))
// Simulates Vercel: an application/json body arrives parsed; anything else arrives as a string.
function vercelRequest({ method = 'POST', headers = {}, body }) {
  const h = lower(headers)
  const parsed = typeof body === 'string' && (h['content-type'] || '').startsWith('application/json') ? JSON.parse(body) : body
  return { method, headers: h, body: parsed }
}
async function call(handler, reqInit) {
  const res = mockRes()
  await handler(vercelRequest(reqInit), res)
  return { status: res.statusCode, json: res.body ? JSON.parse(res.body) : null }
}
const jsonHeaders = { 'content-type': 'application/json' }
const rpc = (method, params, extra = {}) => call(rpcHandler, { headers: jsonHeaders, body: { jsonrpc: '2.0', id: 1, method, params, ...extra } })
const read = (method, params) => call(readHandler, { headers: jsonHeaders, body: { method, params } })

globalThis.fetch = async (input, init = {}) => {
  const url = String(input)
  if (url === `${ORIGIN}/api/solana-rpc`) {
    const res = mockRes()
    await rpcHandler(vercelRequest({ headers: init.headers, body: init.body }), res)
    return new Response(res.body, { status: res.statusCode, headers: { 'content-type': 'application/json' } })
  }
  if (PROVIDERS.includes(url) || READ_PROVIDERS.includes(url)) {
    const body = JSON.parse(init.body)
    upstream.push({ url, body })
    return (upstreamImpl ?? defaultUpstream)(url, body, init)
  }
  throw new Error(`Network forbidden: ${url}`)
}

let count = 0
async function test(name, fn) {
  upstream = []; upstreamImpl = null
  await fn()
  count++; console.log('PASS ' + name)
}
const rejected = (r, status, code) => {
  assert.equal(r.status, status, JSON.stringify(r.json))
  if (code !== undefined) assert.equal(r.json.error.code, code)
  assert.equal(upstream.length, 0, 'a rejected request must not reach any provider')
}

// ---------------------------------------------------------------- normal traffic
await test('Solana bridge SDK Connection works unchanged through the proxy (every SDK read/write method)', async () => {
  const connection = createSolanaBridgeConnection(ORIGIN)
  const burn = VersionedTransaction.deserialize(Buffer.from(real.burn.base64, 'base64'))
  const receive = VersionedTransaction.deserialize(Buffer.from(real.receive.base64, 'base64'))
  const someone = new PublicKey(payee)
  assert.equal((await connection.getLatestBlockhash('confirmed')).lastValidBlockHeight, 100)
  assert.equal(await connection.getBalance(someone), 5)
  assert.equal(await connection.getAccountInfo(someone), null)
  assert.equal((await connection.getSignatureStatuses([signature], { searchTransactionHistory: true })).value.length, 1)
  assert.equal((await connection.simulateTransaction(burn, { sigVerify: false })).value.err, null)
  assert.equal((await connection.getFeeForMessage(burn.message, 'confirmed')).value, 5000)
  assert.equal(await connection.getBlockHeight('confirmed'), 50)
  assert.deepEqual(await connection.getRecentPrioritizationFees(), [])
  assert.equal(await connection.getGenesisHash(), address(2))
  assert.equal((await connection.getTokenAccountBalance(someone)).value.amount, '1')
  assert.equal(await connection.getSlot('confirmed'), 1)
  assert.equal(await connection.getTransaction(signature, { maxSupportedTransactionVersion: 0, commitment: 'confirmed' }), null)
  assert.equal(await connection.getAddressLookupTable(new PublicKey(real.cctpAlt.address)).then(r => r.value), null)
  // Solana source burn and Arc→Solana receive: real signed bytes go through the bridge wrapper unchanged.
  assert.equal(await connection.sendRawTransaction(burn.serialize(), { skipPreflight: false }), signature)
  assert.equal(await connection.sendRawTransaction(receive.serialize(), { skipPreflight: false }), signature)
  const sent = upstream.filter(u => u.body.method === 'sendTransaction')
  assert.equal(sent.length, 2)
  assert.equal(sent[0].body.params[0], Buffer.from(burn.serialize()).toString('base64'))
  assert.equal(sent[1].body.params[0], Buffer.from(receive.serialize()).toString('base64'))
  assert.ok(upstream.filter(u => !['getTransaction', 'getSignaturesForAddress'].includes(u.body.method)).every(u => u.url === PROVIDERS[0]), 'happy path stays on the first provider')
  // getTransaction answered null (no history) by every fake provider: each is asked once, then null is returned.
  assert.deepEqual(upstream.filter(u => u.body.method === 'getTransaction').map(u => u.url), PROVIDERS)
})

await test('app direct proxy calls keep their exact shapes (reclaim, recovery, history, rent)', async () => {
  const shapes = [
    ['getProgramAccounts', [CCTP, { commitment: 'confirmed', encoding: 'base64', filters: [{ memcmp: { offset: 8, bytes: payee } }] }]],
    ['getSignaturesForAddress', [payee, { limit: 5 }]],
    ['getSignaturesForAddress', [payee, { limit: 10, commitment: 'finalized' }]],
    ['getSignaturesForAddress', [payee, { limit: 25, commitment: 'confirmed' }]],
    ['getTransaction', [signature, { maxSupportedTransactionVersion: 0, commitment: 'confirmed', encoding: 'json' }]],
    ['getTransaction', [signature, { encoding: 'jsonParsed', commitment: 'finalized', maxSupportedTransactionVersion: 0 }]],
    ['getSignatureStatuses', [[signature], { searchTransactionHistory: true }]],
    ['getMinimumBalanceForRentExemption', [428, { commitment: 'confirmed' }]],
    ['isBlockhashValid', [address(1), { commitment: 'confirmed' }]],
  ]
  for (const [method, params] of shapes) {
    upstream = []
    const r = await rpc(method, params)
    assert.equal(r.status, 200, method)
    assert.deepEqual(r.json.result, RESULTS[method])
    // A null getTransaction (no history on that provider) is asked of every provider; anything else stops at the first.
    // getSignaturesForAddress [] (fake answers have no history) is also asked of every provider.
    assert.equal(upstream.length, ['getTransaction', 'getSignaturesForAddress'].includes(method) ? PROVIDERS.length : 1, method)
    for (const u of upstream) assert.deepEqual(u.body, { jsonrpc: '2.0', id: 1, method, params }, `${method} forwarded unchanged`)
  }
})

await test('solana-read keeps both app reads and its response shape', async () => {
  let r = await read('getSignatureStatuses', [[signature], { searchTransactionHistory: true }])
  assert.equal(r.status, 200); assert.deepEqual(r.json, { result: RESULTS.getSignatureStatuses })
  r = await read('getAccountInfo', [address(3), { encoding: 'base64', commitment: 'confirmed' }])
  assert.equal(r.status, 200); assert.deepEqual(r.json, { result: RESULTS.getAccountInfo })
  assert.equal(upstream[0].url, READ_PROVIDERS[0])
})

await test('content type with charset, string ids (web3.js) and omitted params are accepted', async () => {
  let r = await call(rpcHandler, { headers: { 'Content-Type': 'application/json; charset=utf-8' }, body: { jsonrpc: '2.0', id: 'c5a0f4e2-uuid', method: 'getSlot' } })
  assert.equal(r.status, 200); assert.equal(upstream.at(-1).body.id, 'c5a0f4e2-uuid'); assert.deepEqual(upstream.at(-1).body.params, [])
})

await test('provider fallback is preserved: 429, 403, 5xx and transport errors move to the next provider', async () => {
  for (const failure of [
    () => new Response('{"jsonrpc":"2.0","id":1,"error":{"code":-32005,"message":"Too many requests"}}', { status: 429 }),
    () => new Response('{"error":"Access forbidden"}', { status: 403 }),
    () => new Response('bad gateway', { status: 502 }),
    () => { throw new TypeError('fetch failed') },
  ]) {
    upstream = []
    upstreamImpl = (url, body) => url === PROVIDERS[0] ? failure() : defaultUpstream(url, body)
    const r = await rpc('sendTransaction', [real.burn.base64, { encoding: 'base64' }])
    assert.equal(r.status, 200); assert.equal(r.json.result, signature)
    assert.deepEqual(upstream.map(u => u.url), PROVIDERS.slice(0, 2))
  }
})

await test('non-retryable JSON-RPC errors (e.g. preflight failure) still reach the SDK verbatim', async () => {
  const error = { code: -32002, message: 'Transaction simulation failed: Blockhash not found', data: { logs: [] } }
  upstreamImpl = (url, body) => new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, error }), { status: 200 })
  const r = await rpc('sendTransaction', [real.burn.base64, { encoding: 'base64' }])
  assert.equal(r.status, 200); assert.deepEqual(r.json.error, error); assert.equal(upstream.length, 1)
})

// ---------------------------------------------------------------- malicious / malformed requests
await test('getProgramAccounts accepts only the CCTP payee lookup', async () => {
  const ok = { commitment: 'confirmed', encoding: 'base64', filters: [{ memcmp: { offset: 8, bytes: payee } }] }
  const bad = [
    [TOKEN_PROGRAM, ok],
    [CCTP],
    [CCTP, {}],
    [CCTP, { ...ok, filters: [] }],
    [CCTP, { ...ok, filters: undefined }],
    [CCTP, { ...ok, encoding: 'jsonParsed' }],
    [CCTP, { ...ok, encoding: undefined }],
    [CCTP, { ...ok, dataSlice: { offset: 0, length: 0 } }],
    [CCTP, { ...ok, withContext: true }],
    [CCTP, { ...ok, filters: [{ memcmp: { offset: 0, bytes: payee } }] }],
    [CCTP, { ...ok, filters: [{ memcmp: { offset: 8, bytes: 'not-base58!' } }] }],
    [CCTP, { ...ok, filters: [{ memcmp: { offset: 8, bytes: '2' } }] }],
    [CCTP, { ...ok, filters: [{ memcmp: { offset: 8, bytes: payee, encoding: 'base64' } }] }],
    [CCTP, { ...ok, filters: [{ memcmp: { offset: 8, bytes: payee } }, { dataSize: 428 }] }],
    [CCTP, { ...ok, filters: [{ dataSize: 428 }] }],
    [CCTP, { ...ok, filters: [{ memcmp: { offset: 8, bytes: payee }, dataSize: 428 }] }],
    [CCTP, { ...ok, commitment: 'max' }],
    [CCTP, ok, {}],
  ]
  for (const params of bad) rejected(await rpc('getProgramAccounts', params), 400, -32602)
})

await test('unbounded history and list parameters are refused', async () => {
  for (const params of [[payee], [payee, {}], [payee, { limit: 0 }], [payee, { limit: 101 }], [payee, { limit: 1000 }], [payee, { limit: 1.5 }],
    [payee, { limit: '10' }], ['not-an-address', { limit: 5 }]]) rejected(await rpc('getSignaturesForAddress', params), 400, -32602)
  rejected(await rpc('getMultipleAccounts', [Array.from({ length: 101 }, (_, i) => address(i))]), 400, -32602)
  rejected(await rpc('getMultipleAccounts', [[]]), 400, -32602)
  rejected(await rpc('getSignatureStatuses', [['short']]), 400, -32602)
  rejected(await rpc('getSignatureStatuses', [signature]), 400, -32602)
  rejected(await rpc('getTransaction', [payee]), 400, -32602)
  rejected(await rpc('getAccountInfo', [{ toString: 1 }]), 400, -32602)
  rejected(await rpc('getAccountInfo', [address(1), 'confirmed']), 400, -32602)
  rejected(await rpc('sendTransaction', ['A'.repeat(2049)]), 400, -32602)
  rejected(await rpc('sendTransaction', ['']), 400, -32602)
  rejected(await rpc('simulateTransaction', [42]), 400, -32602)
})

await test('JSON-RPC envelope: version, id, method, params and batches', async () => {
  rejected(await call(rpcHandler, { headers: jsonHeaders, body: { jsonrpc: '1.0', id: 1, method: 'getSlot', params: [] } }), 400, -32600)
  rejected(await call(rpcHandler, { headers: jsonHeaders, body: { id: 1, method: 'getSlot', params: [] } }), 400, -32600)
  rejected(await call(rpcHandler, { headers: jsonHeaders, body: { jsonrpc: '2.0', id: { x: 1 }, method: 'getSlot', params: [] } }), 400, -32600)
  rejected(await call(rpcHandler, { headers: jsonHeaders, body: { jsonrpc: '2.0', id: 'x'.repeat(129), method: 'getSlot', params: [] } }), 400, -32600)
  rejected(await call(rpcHandler, { headers: jsonHeaders, body: [{ jsonrpc: '2.0', id: 1, method: 'getSlot', params: [] }] }), 400, -32600)
  for (const method of ['requestAirdrop', 'getBlock', 'getLargestAccounts', 'getProgramAccountsV2', '__proto__', 'constructor']) {
    const r = await rpc(method, []); rejected(r, 400, -32601); assert.equal(r.json.id, 1)
  }
  rejected(await rpc('getSlot', { commitment: 'confirmed' }), 400, -32602)
  rejected(await rpc('getSlot', [1, 2, 3, 4]), 400, -32602)
  rejected(await call(rpcHandler, { method: 'GET', headers: jsonHeaders }), 405)
  rejected(await call(readHandler, { method: 'GET', headers: jsonHeaders }), 405)
  rejected(await read('getProgramAccounts', [CCTP]), 400)
  rejected(await read('sendTransaction', [real.burn.base64]), 400)
})

await test('content type and parse errors: text/plain simple POSTs and malformed JSON are refused', async () => {
  const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'sendTransaction', params: [real.burn.base64] })
  for (const headers of [{ 'content-type': 'text/plain' }, { 'content-type': 'application/x-www-form-urlencoded' }, {}, { 'content-type': 'application/jsonx' }]) {
    rejected(await call(rpcHandler, { headers, body }), 415, -32600)
    rejected(await call(readHandler, { headers, body: JSON.stringify({ method: 'getAccountInfo', params: [address(1)] }) }), 415)
  }
  rejected(await call(rpcHandler, { headers: jsonHeaders, body: Buffer.from('{"jsonrpc":') }), 400, -32700)
  const throwing = { method: 'POST', headers: jsonHeaders, get body() { throw new SyntaxError('Invalid JSON') } }
  const res = mockRes(); await rpcHandler(throwing, res)
  assert.equal(res.statusCode, 400); assert.equal(JSON.parse(res.body).error.code, -32700); assert.equal(upstream.length, 0)
})

// ---------------------------------------------------------------- boundaries
const sized = (bytes) => {
  const base = { jsonrpc: '2.0', id: 1, method: 'getSlot', params: [], pad: '' }
  base.pad = 'x'.repeat(bytes - Buffer.byteLength(JSON.stringify(base)))
  assert.equal(Buffer.byteLength(JSON.stringify(base)), bytes)
  return base
}
await test('body size limit: 16384 bytes pass, 16385 bytes (parsed, string or declared) are refused', async () => {
  assert.equal((await call(rpcHandler, { headers: jsonHeaders, body: sized(16384) })).status, 200)
  upstream = []
  rejected(await call(rpcHandler, { headers: jsonHeaders, body: sized(16385) }), 413, -32600)
  rejected(await call(rpcHandler, { headers: jsonHeaders, body: Buffer.from(JSON.stringify(sized(16385))) }), 413, -32600)
  rejected(await call(rpcHandler, { headers: { ...jsonHeaders, 'content-length': '16385' }, body: { jsonrpc: '2.0', id: 1, method: 'getSlot' } }), 413, -32600)
  rejected(await call(rpcHandler, { headers: { ...jsonHeaders, 'content-length': '1e9' }, body: { jsonrpc: '2.0', id: 1, method: 'getSlot' } }), 413, -32600)
  const readBody = { method: 'getAccountInfo', params: [address(1)], pad: '' }
  readBody.pad = 'x'.repeat(4097 - Buffer.byteLength(JSON.stringify(readBody)))
  rejected(await call(readHandler, { headers: jsonHeaders, body: readBody }), 413)
})

await test('parameter boundaries: limit 100, 100 accounts and a 2048-char transaction pass; one more is refused', async () => {
  assert.equal((await rpc('getSignaturesForAddress', [payee, { limit: 100 }])).status, 200)
  assert.equal((await rpc('getSignaturesForAddress', [payee, { limit: 1 }])).status, 200)
  assert.equal((await rpc('getMultipleAccounts', [Array.from({ length: 100 }, (_, i) => address(i))])).status, 200)
  assert.equal((await rpc('simulateTransaction', ['A'.repeat(2048), { encoding: 'base64' }])).status, 200)
  assert.equal((await rpc('getSignatureStatuses', [Array.from({ length: 150 }, () => signature)])).status, 200)
  upstream = []
  rejected(await rpc('simulateTransaction', ['A'.repeat(2049), { encoding: 'base64' }]), 400, -32602)
  // A Solana packet (1232 bytes) always fits the encoded-transaction limit.
  const max = Buffer.alloc(1232, 255)
  assert.ok(max.toString('base64').length <= 2048)
})

await test('base58 address/signature checks match web3.js', async () => {
  for (let i = 0; i < 50; i++) assert.equal(guard.isSolanaAddress(Keypair.generate().publicKey.toBase58()), true)
  assert.equal(guard.isSolanaAddress('11111111111111111111111111111111'), true)
  assert.equal(guard.isSolanaAddress(CCTP), true)
  assert.equal(guard.isSolanaAddress(signature), false)
  assert.equal(guard.isSolanaAddress('1111111111111111111111111111111'), false)
  assert.equal(guard.isSolanaAddress('0OIl'), false)
  const tx = new VersionedTransaction(new TransactionMessage({ payerKey: new PublicKey(payee), recentBlockhash: address(1), instructions: [] }).compileToV0Message())
  assert.equal(tx.signatures.length, 1)
})

const stream = (total, chunk = 64 * 1024, headers = {}) => new Response(new ReadableStream({
  sent: 0,
  pull(c) {
    const n = Math.min(chunk, total - this.sent)
    if (n <= 0) return c.close()
    this.sent += n; c.enqueue(new Uint8Array(n).fill(0x20))
  },
}), { status: 200, headers })
await test('upstream response limit: exactly 2 MiB is read, 2 MiB + 1 aborts without trying more providers', async () => {
  const limit = guard.MAX_UPSTREAM_RESPONSE_BYTES
  assert.equal(limit, 2 * 1024 * 1024)
  const okBody = JSON.stringify({ jsonrpc: '2.0', id: 1, result: 7 })
  upstreamImpl = () => new Response(okBody + ' '.repeat(limit - okBody.length), { status: 200 })
  let r = await rpc('getSlot', [])
  assert.equal(r.status, 200); assert.equal(r.json.result, 7)

  for (const big of [() => stream(limit + 1), () => stream(limit + 1, limit + 1), () => stream(10, 10, { 'content-length': String(limit + 1) })]) {
    upstream = []; upstreamImpl = big
    r = await rpc('getSignaturesForAddress', [payee, { limit: 5 }])
    assert.equal(r.status, 502); assert.equal(r.json.error.code, -32000); assert.match(r.json.error.message, /size limit/)
    assert.equal(upstream.length, 1, 'the next provider would return the same oversized answer')
    upstream = []
    r = await read('getAccountInfo', [address(1)])
    assert.equal(r.status, 502); assert.match(r.json.error, /size limit/); assert.equal(upstream.length, 1)
  }
})

// Deterministic clock: each upstream hangs until its abort timer fires; the timer advances fake time.
async function withFakeClock(fn) {
  const realNow = Date.now, realSetTimeout = globalThis.setTimeout, realClear = globalThis.clearTimeout
  let now = 1_000_000
  const delays = []
  Date.now = () => now
  globalThis.setTimeout = (cb, ms) => { delays.push(ms); const t = { cancelled: false }; setImmediate(() => { if (!t.cancelled) { now += ms; cb() } }); return t }
  globalThis.clearTimeout = t => { if (t && typeof t === 'object' && 'cancelled' in t) t.cancelled = true; else realClear(t) }
  upstreamImpl = (url, body, init) => new Promise((_, rejectFetch) => init.signal.addEventListener('abort', () => rejectFetch(new DOMException('This operation was aborted', 'AbortError'))))
  try { return await fn(delays) } finally { Date.now = realNow; globalThis.setTimeout = realSetTimeout; globalThis.clearTimeout = realClear }
}
await test('total time budget: hanging providers stop at 25 s (rpc) and 20 s (read) instead of 60 s / 32 s', async () => {
  await withFakeClock(async delays => {
    const r = await rpc('getSlot', [])
    assert.equal(r.status, 502)
    assert.deepEqual(delays, [12_000, 12_000, 1_000])
    assert.equal(upstream.length, 3)
  })
  upstream = []
  await withFakeClock(async delays => {
    const r = await read('getAccountInfo', [address(1)])
    assert.equal(r.status, 502)
    assert.deepEqual(delays, [8_000, 8_000, 4_000])
    assert.equal(upstream.length, 3)
  })
  let t = 0
  const d = guard.createDeadline(25_000, () => t)
  assert.equal(d.attemptTimeout(12_000), 12_000); t = 24_000
  assert.equal(d.attemptTimeout(12_000), 1_000); t = 24_001
  assert.equal(d.attemptTimeout(12_000), 0)
})

await test('no runtime dependency or external storage; the only state is the in-memory client counter', async () => {
  for (const file of ['api/solana-rpc.js', 'api/solana-read.js', 'api/_lib/solana-rpc-guard.js']) {
    const src = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8')
    const imports = [...src.matchAll(/from\s+['"]([^'"]+)['"]/g)].map(m => m[1])
    assert.ok(imports.every(i => i === './_lib/solana-rpc-guard.js'), `${file} imports ${imports}`)
    assert.doesNotMatch(src, /redis|upstash|kv\.|@vercel\//i, `${file} must not use external storage`)
    assert.equal((src.match(/new Map\(/g) ?? []).length, file === 'api/_lib/solana-rpc-guard.js' ? 1 : 0, `${file}: only the rate counter keeps state`)
  }
})

await test('per-client rate limit: 600 requests per minute pass, the 601st is refused before any provider', async () => {
  let t = 1_000_000
  const limiter = guard.createClientRateLimiter({ now: () => t })
  const client = ip => ({ headers: { 'x-forwarded-for': `${ip}, 10.0.0.1` } })
  for (let i = 0; i < guard.CLIENT_RATE_LIMIT; i += 1) assert.equal(limiter.retryAfter(client('198.51.100.1')), 0)
  assert.equal(limiter.retryAfter(client('198.51.100.1')), 60, 'over the limit: wait for the window')
  assert.equal(limiter.retryAfter(client('198.51.100.2')), 0, 'another client is not affected')
  t += 30_000
  assert.equal(limiter.retryAfter(client('198.51.100.1')), 30)
  t += 30_000
  assert.equal(limiter.retryAfter(client('198.51.100.1')), 0, 'a new window starts after one minute')
  for (let i = 0; i < 1500; i += 1) limiter.retryAfter(client(`203.0.113.${i % 250}-${i}`))
  assert.ok(limiter.size() <= 1000, 'the counter stays bounded')

  // The real handlers: one client is refused with 429 and Retry-After, without reaching a provider.
  for (const [handler, body] of [[rpcHandler, { jsonrpc: '2.0', id: 1, method: 'getSlot', params: [] }], [readHandler, { method: 'getAccountInfo', params: [payee] }]]) {
    const headers = { ...jsonHeaders, 'x-forwarded-for': `192.0.2.${handler === rpcHandler ? 1 : 2}` }
    for (let i = 0; i < guard.CLIENT_RATE_LIMIT; i += 1) {
      const res = mockRes()
      await handler(vercelRequest({ headers, body }), res)
      assert.equal(res.statusCode, 200)
    }
    upstream = []
    const res = mockRes()
    await handler(vercelRequest({ headers, body }), res)
    assert.equal(res.statusCode, 429)
    assert.ok(Number(res.getHeader('retry-after')) >= 1)
    assert.equal(upstream.length, 0, 'a limited request must not reach any provider')
    const other = mockRes()
    await handler(vercelRequest({ headers: { ...jsonHeaders, 'x-forwarded-for': '192.0.2.99' }, body }), other)
    assert.equal(other.statusCode, 200, 'other clients keep working')
  }
})

console.log(`\nRESULT ${count}/${count} Solana RPC proxy security checks PASS (no network, no wallet, no broadcast)`)
