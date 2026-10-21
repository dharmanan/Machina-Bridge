// No live API, RPC, real wallet, signature or transaction. Exercise the actual handler boundaries.
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
const require = createRequire(import.meta.url), ts = require('typescript')
require.extensions['.ts'] = (mod, file) => mod._compile(ts.transpileModule(readFileSync(file, 'utf8'), { fileName: file,
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText, file)
const root = fileURLToPath(new URL('..', import.meta.url))
let external = 0, preparations = 0, count = 0
globalThis.fetch = async () => { external++; throw new Error('network_forbidden') }
const p = require(`${root}src/lib/uniswapArcPolicy.ts`)
const service = require(`${root}api/_lib/uniswap-arc-preview.ts`)
const { createUniswapArcPreviewReader, uniswapArcPreviewErrorMessage } = require(`${root}src/lib/uniswapArcPreview.ts`)
const { decodeFunctionData, encodeFunctionData } = require('viem')
const raw = JSON.parse(readFileSync(`${root}scripts/fixtures/uniswap-arc/USDC-EURC.json`, 'utf8'))
const input = { chainId: 5042, tokenIn: 'USDC', tokenOut: 'EURC', amount: '1', owner: raw.swapTransaction.from, recipient: raw.swapTransaction.from,
  slippageBps: 50, minimumOutput: '1', maxNetworkFee: '100000000000000000' }
const origin = 'https://swap.example.test', key = 'synthetic-server-key-never-returned'
const nonce = crypto.randomUUID()
const headers = { origin, 'content-type': 'application/json', 'x-preview-request-id': nonce }
const production = { NODE_ENV: 'production', VERCEL: '1', VERCEL_ENV: 'production', UNISWAP_ARC_PREVIEW_ENABLED: 'true' }
const envKeys = ['NODE_ENV','VERCEL','VERCEL_ENV','CODESPACES','CODESPACE_NAME','GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN','UNISWAP_ARC_ALLOWED_ORIGIN','UNISWAP_TRADING_API_KEY','UNISWAP_ARC_PREVIEW_ENABLED']
const saved = Object.fromEntries(envKeys.map(k => [k, process.env[k]]))
const oldPrepare = service.prepareArcPreview
function runtime(values = {}) {
  for (const k of envKeys) delete process.env[k]
  Object.assign(process.env, { UNISWAP_ARC_ALLOWED_ORIGIN: origin, UNISWAP_TRADING_API_KEY: key, ...values })
}
function load() {
  const filename = `${root}api/uniswap-arc-preview.ts`
  delete require.cache[require.resolve(filename)]
  return require(filename)
}
function makeReview(request) {
  const now = Date.now(), tx = structuredClone(raw.swapTransaction)
  const outer = decodeFunctionData({ abi: p.EXECUTE_ABI, data: tx.data })
  const canonical = encodeFunctionData({ abi: p.EXECUTE_ABI, functionName: 'execute', args: outer.args })
  tx.data = encodeFunctionData({ abi: p.EXECUTE_ABI, functionName: 'execute', args: [outer.args[0], outer.args[1], BigInt(Math.floor(now / 1000) + 120)] }) + tx.data.slice(canonical.length)
  return { request, transaction: tx, estimatedOutput: raw.quote.output.amount, requiredMinimum: raw.quote.output.minimumAmount,
    requestStartedAt: now, expiresAt: now + 30000, routerHash: p.ARC_ROUTER_HASH, blockNumber: '27114546', gasLimit: '130000',
    maxFeePerGas: '2000000000', maxPriorityFeePerGas: '0', networkFee: '260000000000000', nativeBalance: '100000000000000000000',
    simulation: 'passed', writesEnabled: false, executionBound: false, quoteId: raw.quote.quoteId }
}
service.prepareArcPreview = async (request, apiKey) => {
  preparations++; assert.equal(apiKey, key)
  return makeReview(request)
}
async function invoke(handler, changes = {}) {
  const result = { status: 0, headers: {}, body: null }
  const response = { setHeader(k, v) { result.headers[k] = v }, status(n) { result.status = n; return response }, json(v) { result.body = v } }
  await handler({ method: 'POST', headers, body: input, ...changes }, response)
  assert.equal(JSON.stringify(result).includes(key), false)
  return result
}
async function test(name, fn) { await fn(); count++; console.log(`PASS ${name}`) }
try {
  await test('public entry point defaults closed in production, preview, development and unknown runtimes', async () => {
    for (const env of [{}, { NODE_ENV: 'production' }, { NODE_ENV: 'development' }, { VERCEL: '1', VERCEL_ENV: 'preview' },
      { NODE_ENV: 'production', VERCEL: '1', VERCEL_ENV: 'production' },
      { NODE_ENV: 'development', CODESPACES: 'true', UNISWAP_ARC_PREVIEW_ENABLED: 'true' }]) {
      runtime(env); const before = preparations
      const result = await invoke(load().default)
      assert.equal(result.status, 503)
      assert.deepEqual(result.body, { error: 'uniswap_arc_public_preview_disabled', writesEnabled: false, executionBound: false })
      assert.equal(result.headers['X-Uniswap-Preview-Status'], 'public-disabled')
      assert.equal(result.headers['Cache-Control'], 'no-store')
      assert.equal(preparations, before)
    }
  })
  await test('only exact true in a verified Vercel production runtime opts in', async () => {
    for (const env of [{ ...production, UNISWAP_ARC_PREVIEW_ENABLED: '' }, { ...production, UNISWAP_ARC_PREVIEW_ENABLED: 'false' },
      { ...production, UNISWAP_ARC_PREVIEW_ENABLED: '1' }, { ...production, UNISWAP_ARC_PREVIEW_ENABLED: 'TRUE' },
      { ...production, UNISWAP_ARC_PREVIEW_ENABLED: 'true ' }, { ...production, VERCEL_ENV: 'preview' },
      { ...production, VERCEL_ENV: 'development' }, { ...production, VERCEL: '' },
      { ...production, NODE_ENV: 'development' }, { UNISWAP_ARC_PREVIEW_ENABLED: 'true' }]) {
      runtime(env); const before = preparations
      assert.equal((await invoke(load().default)).status, 503)
      assert.equal(preparations, before)
    }
  })
  await test('production opt-in returns the same verified read-only review and freshness protocol', async () => {
    runtime(production)
    const result = await invoke(load().default)
    assert.equal(result.status, 200); assert.equal(result.headers['X-Uniswap-Preview-Status'], undefined)
    assert.equal(result.body.simulation, 'passed'); assert.equal(result.body.writesEnabled, false); assert.equal(result.body.executionBound, false)
    assert.equal(result.headers['X-Preview-Request-Id'], nonce)
    p.validateArcReview(result.body, { owner: input.owner, chainId: 5042, connected: true }, Number(result.headers['X-Preview-Server-Time']))
  })
  await test('turning off the server opt-in immediately stops further preparations', async () => {
    runtime(production); const api = load()
    assert.equal((await invoke(api.default)).status, 200)
    delete process.env.UNISWAP_ARC_PREVIEW_ENABLED
    const before = preparations
    assert.equal((await invoke(api.default)).status, 503); assert.equal(preparations, before)
  })
  await test('enabled production rejects wrong Origin, non-JSON and non-HTTPS configuration without upstream work', async () => {
    runtime(production); const api = load(), before = preparations
    for (const change of [{ origin: 'https://other.test' }, { origin: undefined }, { origin: [origin] }, { 'content-type': 'text/plain' }])
      assert.equal((await invoke(api.default, { headers: { ...headers, ...change } })).status, 403)
    for (const allowed of ['*', 'http://swap.example.test', origin + '/', origin + '/path']) {
      process.env.UNISWAP_ARC_ALLOWED_ORIGIN = allowed
      assert.equal((await invoke(api.default, { headers: { ...headers, origin: allowed } })).status, 403)
    }
    delete process.env.UNISWAP_ARC_ALLOWED_ORIGIN
    assert.equal((await invoke(api.default)).status, 403)
    assert.equal(preparations, before)
  })
  await test('enabled production enforces size, nonce and instance budget before preparation', async () => {
    runtime(production); const api = load(), before = preparations
    assert.equal((await invoke(api.default, { body: 'x'.repeat(8193) })).status, 413)
    assert.equal((await invoke(api.default, { headers: { ...headers, 'x-preview-request-id': 'malformed' } })).status, 400)
    for (let i = 0; i < 25; i++) assert.equal((await invoke(api.default, { body: { ...input, chainId: 1 } })).status, 503)
    assert.equal(preparations, before)
    for (let i = 0; i < 20; i++) assert.equal((await invoke(api.default)).status, 200)
    const rejected = await invoke(api.default)
    assert.equal(rejected.status, 429); assert.equal(rejected.headers['Retry-After'], '60'); assert.equal(preparations, before + 20)
  })
  await test('enabled production sanitizes service errors and preserves economic/write validation', async () => {
    runtime(production); const api = load(), original = service.prepareArcPreview
    try {
      for (const prepare of [async () => { throw new Error(key + ' private-upstream-payload') },
        async request => ({ ...makeReview(request), executionBound: true }),
        async request => ({ ...makeReview(request), requiredMinimum: '0' })]) {
        service.prepareArcPreview = prepare
        const result = await invoke(api.default)
        assert.equal(result.status, 503); assert.equal(JSON.stringify(result).includes('private-upstream-payload'), false)
        assert.equal(result.body.writesEnabled, false)
      }
    } finally { service.prepareArcPreview = original }
  })
  await test('spoofed Origin/Referer/Fetch Metadata/forwarded/auth/development headers never unlock the public API', async () => {
    runtime({ NODE_ENV: 'development', CODESPACES: 'true' })
    const api = load(), before = preparations
    const spoofed = { ...headers, origin: 'https://localhost:4173', referer: origin + '/', 'x-forwarded-host': 'swap.example.test',
      'sec-fetch-site': 'same-origin', 'x-forwarded-for': '127.0.0.1', 'x-preview-mode': 'development', authorization: 'Bearer fabricated' }
    assert.equal((await invoke(api.default, { headers: spoofed, developmentServer: true })).status, 503)
    assert.equal(preparations, before)
  })
  await test('public denial happens before body serialization, API-key use or outbound work', async () => {
    runtime(); const before = preparations
    const body = { toJSON() { throw new Error('body_must_not_be_touched') } }
    assert.equal((await invoke(load().default, { body })).status, 503)
    assert.equal(preparations, before); assert.equal(external, 0)
  })
  await test('process recycling/multiple independent instances cannot reopen the public quota path', async () => {
    runtime(); const before = preparations
    for (let i = 0; i < 10; i++) assert.equal((await invoke(load().default)).status, 503)
    assert.equal(preparations, before)
  })
  await test('GET/HEAD/OPTIONS are not paid preparation paths and do not enable CORS', async () => {
    runtime(); const handler = load().default, before = preparations
    for (const method of ['GET', 'HEAD', 'OPTIONS']) {
      const result = await invoke(handler, { method })
      assert.equal(result.status, 405); assert.equal(result.headers.Allow, 'POST')
      assert.equal(result.headers['Access-Control-Allow-Origin'], undefined)
    }
    assert.equal(preparations, before)
  })
  await test('private Vite handler refuses production/unknown NODE_ENV and all Vercel runtime markers', async () => {
    for (const env of [{}, { NODE_ENV: 'production' }, { NODE_ENV: 'development', VERCEL: '0' },
      { NODE_ENV: 'development', VERCEL: '1' }, { NODE_ENV: 'development', VERCEL_ENV: 'development' }, production]) {
      runtime(env); const before = preparations
      assert.equal((await invoke(load().handleDevelopmentArcPreview)).status, 503)
      assert.equal(preparations, before)
    }
  })
  await test('private local Vite still returns verified read-only review and exact freshness binding', async () => {
    runtime({ NODE_ENV: 'development' })
    const result = await invoke(load().handleDevelopmentArcPreview)
    assert.equal(result.status, 200); assert.equal(result.body.simulation, 'passed')
    assert.equal(result.body.writesEnabled, false); assert.equal(result.body.executionBound, false)
    assert.equal(result.headers['X-Preview-Request-Id'], nonce)
    p.validateArcReview(result.body, { owner: input.owner, chainId: 5042, connected: true }, Number(result.headers['X-Preview-Server-Time']))
  })
  const codespace = { NODE_ENV: 'development', CODESPACES: 'true', CODESPACE_NAME: 'specific-workspace', GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN: 'app.github.dev',
    UNISWAP_ARC_ALLOWED_ORIGIN: 'https://specific-workspace-4173.app.github.dev' }
  const proxyHeaders = { ...headers, origin: 'https://localhost:4173', 'x-forwarded-host': 'specific-workspace-4173.app.github.dev',
    referer: 'https://specific-workspace-4173.app.github.dev/swap', 'sec-fetch-site': 'same-origin' }
  await test('production opt-in cannot inherit the Codespaces rewritten-Origin exception', async () => {
    runtime({ ...codespace, ...production }); const before = preparations
    assert.equal((await invoke(load().default, { headers: proxyHeaders })).status, 403)
    assert.equal(preparations, before)
  })
  await test('existing Codespaces rewrite works only in Vite development and for the exact runtime Codespace/port/domain', async () => {
    runtime(codespace)
    assert.equal((await invoke(load().handleDevelopmentArcPreview, { headers: proxyHeaders })).status, 200)
    const before = preparations
    assert.equal((await invoke(load().default, { headers: proxyHeaders })).status, 503)
    assert.equal(preparations, before)
  })
  await test('missing/false Codespaces flag, different workspace and missing forwarding domain reject the exception', async () => {
    for (const change of [{ CODESPACES: 'false' }, { CODESPACE_NAME: 'different' }, { GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN: '' }]) {
      runtime({ ...codespace, ...change }); const before = preparations
      assert.equal((await invoke(load().handleDevelopmentArcPreview, { headers: proxyHeaders })).status, 403)
      assert.equal(preparations, before)
    }
  })
  await test('Codespaces proxy exception rejects mismatched port, host, Referer and Fetch Metadata', async () => {
    runtime(codespace); const handler = load().handleDevelopmentArcPreview, before = preparations
    for (const change of [{ origin: 'https://localhost:4174' }, { origin: 'https://localhost:99999' }, { origin: 'http://localhost:4173' },
      { 'x-forwarded-host': 'other.app.github.dev' }, { referer: 'https://evil.test/' }, { 'sec-fetch-site': 'cross-site' }, { 'x-forwarded-host': ['specific-workspace-4173.app.github.dev'] }]) {
      assert.equal((await invoke(handler, { headers: { ...proxyHeaders, ...change } })).status, 403)
    }
    assert.equal(preparations, before)
  })
  await test('origin remains exact/canonical and Content-Type remains strict without wildcard fallback', async () => {
    runtime({ NODE_ENV: 'development' }); const handler = load().handleDevelopmentArcPreview, before = preparations
    for (const change of [{ origin: 'https://other.test' }, { origin: 'null' }, { origin: [origin] }, { 'content-type': 'application/json; charset=UTF-8' }]) {
      assert.equal((await invoke(handler, { headers: { ...headers, ...change } })).status, 403)
    }
    for (const allowed of ['*', origin + '/', origin + '/path', 'null']) {
      process.env.UNISWAP_ARC_ALLOWED_ORIGIN = allowed
      assert.equal((await invoke(handler, { headers: { ...headers, origin: allowed } })).status, 403)
    }
    assert.equal(preparations, before)
  })
  await test('oversized/invalid/unsupported request bodies cannot consume the development paid-call budget', async () => {
    runtime({ NODE_ENV: 'development' }); const handler = load().handleDevelopmentArcPreview, before = preparations
    assert.equal((await invoke(handler, { body: 'x'.repeat(8193) })).status, 413)
    for (let i = 0; i < 25; i++) {
      const body = [null, '{', {}, { ...input, chainId: 1 }, { ...input, apiKey: 'forbidden' }][i % 5]
      assert.equal((await invoke(handler, { body })).status, 503)
    }
    assert.equal(preparations, before)
    assert.equal((await invoke(handler)).status, 200)
  })
  await test('development process budget admits 20 valid preparations then rejects before the next preparation', async () => {
    runtime({ NODE_ENV: 'development' }); const handler = load().handleDevelopmentArcPreview, before = preparations
    for (let i = 0; i < 20; i++) assert.equal((await invoke(handler)).status, 200)
    assert.equal((await invoke(handler)).status, 429)
    assert.equal(preparations, before + 20)
  })
  await test('server-only key stays absent from errors, quotes and headers; malformed nonce fails before preparation', async () => {
    runtime({ NODE_ENV: 'development' }); const handler = load().handleDevelopmentArcPreview, before = preparations
    assert.equal((await invoke(handler, { headers: { ...headers, 'x-preview-request-id': ['invalid'] } })).status, 400)
    assert.equal(preparations, before)
    const original = service.prepareArcPreview
    try {
      service.prepareArcPreview = async () => { throw new Error(key + ' private-upstream-payload') }
      const result = await invoke(handler)
      assert.equal(result.status, 503); assert.equal(JSON.stringify(result).includes('private-upstream-payload'), false)
    } finally { service.prepareArcPreview = original }
  })
  await test('browser reports the intentional public closure and cannot display it as a verified quote', async () => {
    const reader = createUniswapArcPreviewReader(() => ({ owner: input.owner, chainId: 5042, connected: true }), async () =>
      Response.json({ error: 'uniswap_arc_public_preview_disabled' }, { status: 503, headers: { 'X-Uniswap-Preview-Status': 'public-disabled' } }))
    await assert.rejects(reader.read(input), error => error.code === 'public_disabled' && uniswapArcPreviewErrorMessage(error).includes('Circle previews remain available'))
    assert.equal(reader.current(input), null)
    assert.equal(p.UNISWAP_ARC_WRITES_ENABLED, false)
    await assert.rejects(p.submitUniswapArcSwap(), /writes_disabled/)
  })
  assert.equal(external, 0)
  console.log(`${count} API security groups PASS. Disabled paths made zero preparations; enabled/development preparations are test doubles only. Zero live API/RPC calls.`)
} finally {
  service.prepareArcPreview = oldPrepare
  for (const [k, value] of Object.entries(saved)) if (value === undefined) delete process.env[k]; else process.env[k] = value
}
