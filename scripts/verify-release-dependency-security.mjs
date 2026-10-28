// Focused compatibility checks for the reviewed dependency changes. No network, wallet or live database.
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { PassThrough } from 'node:stream'
const require = createRequire(import.meta.url)
let count = 0
async function test(name, run) { await run(); count++; console.log('PASS ' + name) }
const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url)))
await test('Sui and RainbowKit CSS supply chain excludes vulnerable deepmerge', () => {
  const lock = JSON.parse(readFileSync(new URL('../package-lock.json', import.meta.url)))
  const packages = lock.packages
  assert.equal(manifest.overrides['@vanilla-extract/css'], '1.21.3')
  assert.equal(packages['node_modules/@vanilla-extract/css']?.version, '1.21.3')
  assert.equal(packages['node_modules/@vanilla-extract/css']?.dependencies['deepmerge-ts'], '^8.0.2')
  assert.equal(packages['node_modules/deepmerge-ts']?.version, '8.0.2')
  assert.equal(packages['node_modules/modern-ahocorasick']?.version, '3.3.0')
  assert.equal(packages['node_modules/@mysten/dapp-kit']?.dependencies['@vanilla-extract/css'], '^1.18.0')
  assert.equal(packages['node_modules/@rainbow-me/rainbowkit']?.dependencies['@vanilla-extract/css'], '1.17.3')
  assert.equal(packages['node_modules/@mysten/dapp-kit/node_modules/@vanilla-extract/css'], undefined)
  assert.ok(Object.entries(packages).every(([path, meta]) => !/(^|\\/)node_modules\\/deepmerge$/.test(path) && !meta.dependencies?.deepmerge), 'vulnerable deepmerge must be absent from the entire lock tree')
})

await test('only Porto Zod 4 is patched; Circle pinned Zod 3 is not forced across a major API boundary', () => {
  const fromPorto = createRequire(createRequire(require.resolve('@wagmi/connectors')).resolve('porto'))
  assert.equal(fromPorto('zod/package.json').version, '4.6.7')
  const fromCircle = createRequire(require.resolve('@circle-fin/borrow-kit'))
  assert.equal(fromCircle('zod/package.json').version, '3.25.67')
  assert.deepEqual(manifest.overrides.porto, { 'zod@^4.1.5': '4.6.7' })
})
await test('patched Zod array rejects oversized input before visiting its elements', () => {
  const fromPorto = createRequire(createRequire(require.resolve('@wagmi/connectors')).resolve('porto')), z = fromPorto('zod')
  let visited = 0
  const schema = z.array(z.string().refine(() => { visited++; return true })).max(2)
  assert.equal(schema.safeParse(Array(10).fill('x')).success, false)
  assert.equal(visited, 0)
  assert.deepEqual(schema.parse(['x']), ['x']); assert.equal(visited, 1)
})
await test('Porto mini entry retains its supported parser API and early collection bound', () => {
  const fromPorto = createRequire(createRequire(require.resolve('@wagmi/connectors')).resolve('porto')), z = fromPorto('zod/mini')
  assert.equal(z.safeParse(z.array(z.string()).check(z.maxLength(2)), ['a', 'b', 'c']).success, false)
  assert.deepEqual(z.parse(z.object({ method: z.string() }), { method: 'eth_chainId' }), { method: 'eth_chainId' })
})
await test('TOML patched parser preserves the Anchor workspace configuration consumed by the installed caller', () => {
  const fromAnchor = createRequire(require.resolve('@coral-xyz/anchor')), toml = fromAnchor('toml')
  assert.equal(fromAnchor('toml/package.json').version, '5.0.1')
  const input = '[provider]\ncluster="mainnet"\nwallet="local.json"\n[programs.mainnet]\nexample="11111111111111111111111111111111"\n'
  const parsed = toml.parse(input)
  assert.equal(Object.getPrototypeOf(parsed), null)
  assert.deepEqual(JSON.parse(JSON.stringify(parsed)), { provider: { cluster: 'mainnet', wallet: 'local.json' }, programs: { mainnet: { example: '11111111111111111111111111111111' } } })
  const table = Array.from({ length: 1000 }, (_, i) => `[[entry${i}]]\nvalue=${i}\n`).join('')
  assert.equal(Object.keys(toml.parse(table)).length, 1000)
  assert.throws(() => toml.parse('value=' + '9'.repeat(20000)))
})
await test('reviewed Jayson browser API keeps JSON-RPC request/batch/error semantics and removes stream-json', async () => {
  assert.equal(Object.hasOwn(manifest.overrides, 'stream-json'), false)
  assert.equal(require('jayson/package.json').version, '5.0.0')
  assert.equal(Object.hasOwn(require('jayson/package.json').dependencies, 'stream-json'), false)
  const lock = JSON.parse(readFileSync(new URL('../package-lock.json', import.meta.url)))
  assert.equal(Object.keys(lock.packages).some(p => p.endsWith('/stream-json')), false)
  const Client = require('jayson/lib/client/browser')
  const client = new Client((payload, callback) => {
    const request = JSON.parse(payload)
    if (Array.isArray(request)) return callback(null, JSON.stringify(request.map(r => ({ jsonrpc: '2.0', id: r.id, result: r.params[0] }))))
    callback(null, JSON.stringify(request.method === 'error' ? { jsonrpc: '2.0', id: request.id, error: { code: -32602, message: 'Invalid params' } } : { jsonrpc: '2.0', id: request.id, result: request.params[0] }))
  })
  const read = await new Promise((resolve, reject) => client.request('read', ['ok'], (error, value) => error ? reject(error) : resolve(value)))
  assert.equal(read.result, 'ok'); assert.match(read.id, /^[0-9a-f-]{36}$/i)
  const failure = await new Promise((resolve, reject) => client.request('error', [], (error, value) => error ? reject(error) : resolve(value)))
  assert.equal(failure.error.code, -32602)
  const batch = await new Promise((resolve, reject) => client.request([client.request('read', ['a'], 'a'), client.request('read', ['b'], 'b')], (error, value) => error ? reject(error) : resolve(value)))
  assert.deepEqual(batch.map(r => r.result), ['a', 'b'])
  const stream = new PassThrough()
  const parsed = new Promise((resolve, reject) => require('jayson/lib/utils').parseStream(stream, {}, (error, data) => error ? reject(error) : resolve(data)))
  stream.end('{"jsonrpc":"2.0","id":1,"result":"ok"}\n')
  assert.deepEqual(await parsed, { jsonrpc: '2.0', id: 1, result: 'ok' })
})
await test('Solana SDK keeps its real JSON-RPC read path through the reviewed client, with controlled fetch only', async () => {
  const { Connection, PublicKey } = require('@solana/web3.js')
  assert.equal(typeof Connection, 'function')
  assert.equal(new PublicKey('11111111111111111111111111111111').toBase58(), '11111111111111111111111111111111')
  let calls = 0
  const connection = new Connection('https://read-only.invalid', { fetch: async (_url, options) => {
    const request = JSON.parse(options.body); assert.equal(request.method, 'getBlockHeight'); calls++
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: 123 }), { headers: { 'content-type': 'application/json' } })
  } })
  assert.equal(await connection.getBlockHeight(), 123); assert.equal(calls, 1)
})
await test('Circle Zod 3 retains its supported API and rejects oversized constrained arrays before traversal', () => {
  const z = createRequire(require.resolve('@circle-fin/borrow-kit'))('zod'); let visited = 0
  const result = z.array(z.string().refine(() => { visited++; return true })).max(2).safeParse(Array(10).fill('x'))
  assert.equal(result.success, false); assert.equal(visited, 0)
  assert.equal(result.error.issues.length, 1)
  assert.equal(z.function().returns(z.any()).parse(() => 'compatible')(), 'compatible')
  console.log('LOCAL BACKPORT: Circle Zod 3 collection bound is patched; original package versions and raw audit advisories remain visible')
})
console.log(`RESULT ${count}/${count} PASS; dependency compatibility and explicit residual-risk evidence; no network or transactions`)
