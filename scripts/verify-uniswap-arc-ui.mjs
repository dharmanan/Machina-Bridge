// Real Chromium + React + wagmi mock connector. HTTP and RPC are test doubles.
// This verifies UI integration, never live Uniswap access or a real wallet/transaction.
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'
const require = createRequire(import.meta.url)
const ts = require('typescript')
require.extensions['.ts'] = (mod, file) => mod._compile(ts.transpileModule(readFileSync(file, 'utf8'), { fileName: file,
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText, file)
let chromium
try { ({ chromium } = require('playwright-core')) }
catch { ({ chromium } = require(process.env.PLAYWRIGHT_CORE_PATH ?? '/opt/codex/runtimes/cua/lib/node_modules/playwright-core')) }
const root = fileURLToPath(new URL('..', import.meta.url))
const p = require(`${root}src/lib/uniswapArcPolicy.ts`)
const service = require(`${root}api/_lib/uniswap-arc-preview.ts`)
const { uniswapArcDevPreview } = require(`${root}api/_lib/uniswap-arc-dev.ts`)
const { decodeFunctionData, encodeFunctionData, decodeAbiParameters, encodeAbiParameters } = require('viem')
const evidence = Object.fromEntries(['EURC', 'cirBTC'].map(symbol => [symbol, JSON.parse(readFileSync(`${root}scripts/fixtures/uniswap-arc/USDC-${symbol}.json`, 'utf8'))]))
const runtime = readFileSync(`${root}scripts/fixtures/uniswap-arc/router-runtime.hex`, 'utf8').trim()
let upstreamCalls = 0
const prepare = service.createArcPreviewService({ now: Date.now, client: {
  getChainId: async () => 5042, getBlockNumber: async () => 27114546n,
  getCode: async ({ address }) => address === p.ARC_ROUTER ? runtime : '0x6000',
  readContract: async ({ address }) => address.toLowerCase() === p.ARC_OUTPUTS.EURC.address.toLowerCase() ? 6 : 8,
  getBalance: async () => 100n * 10n ** 18n, getGasPrice: async () => 1000000000n,
  call: async () => ({ data: '0x' }), estimateGas: async () => 100000n,
}, fetch: async (_url, init) => {
  upstreamCalls++
  const body = JSON.parse(init.body)
  const symbol = Object.keys(p.ARC_OUTPUTS).find(symbol => p.sameAddress(body.tokenOut, p.ARC_OUTPUTS[symbol].address))
  // Deliberately synthetic fresh copy for UI tests. Original archive remains unchanged.
  const raw = structuredClone(evidence[symbol])
  const decoded = decodeFunctionData({ abi: p.EXECUTE_ABI, data: raw.swapTransaction.data })
  const canonical = encodeFunctionData({ abi: p.EXECUTE_ABI, functionName: 'execute', args: decoded.args })
  const suffix = raw.swapTransaction.data.slice(canonical.length)
  const amount = BigInt(body.amount), output = BigInt(raw.quote.output.amount) * amount / 1000000n
  const minimum = p.minimumAtSlippage(output, Math.round(body.slippageTolerance * 100))
  const inputs = [...decoded.args[1]]
  if (symbol === 'EURC') {
    const [actions, params] = decodeAbiParameters(p.V4_ENVELOPE, inputs[0])
    const updated = [...params], [swap] = decodeAbiParameters(p.V4_PATH, params[0])
    updated[0] = encodeAbiParameters(p.V4_PATH, [{ ...swap, amountIn: amount, amountOutMinimum: minimum }])
    inputs[0] = encodeAbiParameters(p.V4_ENVELOPE, [actions, updated])
  } else {
    const values = [...decodeAbiParameters(p.V3_INPUT, inputs[0])]
    values[1] = amount; values[2] = minimum
    inputs[0] = encodeAbiParameters(p.V3_INPUT, values)
  }
  raw.quote.input.amount = raw.quote.input.maximumAmount = amount.toString()
  raw.quote.output.amount = output.toString(); raw.quote.output.minimumAmount = minimum.toString()
  raw.quote.slippage = body.slippageTolerance
  Object.assign(raw.quote.aggregatedOutputs[0], { amount: output.toString(), minAmount: minimum.toString() })
  Object.assign(raw.quote.route[0][0], { amountIn: amount.toString(), amountOut: output.toString() })
  raw.swapTransaction.value = (amount * 10n ** 12n).toString()
  raw.swapTransaction.data = encodeFunctionData({ abi: p.EXECUTE_ABI, functionName: 'execute', args: [decoded.args[0], inputs, BigInt(Math.floor(Date.now() / 1000) + 120)] }) + suffix
  raw.isTokenApprovalApplicable = false; raw.permitData = null
  return Response.json(raw)
} })
const server = await createServer({ configFile: false, root, cacheDir: `${root}.verification/vite-ui-cache`, server: { host: '127.0.0.1', port: 0 }, plugins: [uniswapArcDevPreview(), {
  name: 'local-uniswap-ui-harness', configureServer(server) {
    server.middlewares.use('/__uniswap_ui_test', async (_req, res) => {
      res.setHeader('Content-Type', 'text/html')
      res.end(await server.transformIndexHtml('/__uniswap_ui_test', '<!doctype html><html><body><div id="root"></div><script type="module" src="/scripts/fixtures/uniswap-arc/ui-harness.tsx"></script></body></html>'))
    })
  },
}] })
await server.listen()
const base = `http://127.0.0.1:${server.httpServer.address().port}`
let browser, count = 0, external = 0, apiCalls = 0, mode = 'normal', held
const pageErrors = [], requests = []
const previousOrigin = process.env.UNISWAP_ARC_ALLOWED_ORIGIN, previousKey = process.env.UNISWAP_TRADING_API_KEY
async function test(name, fn) { await fn(); count++; console.log(`PASS ${name}`) }
try {
  await test('Vite serves the real API handler: method, origin, body limit and missing server key fail closed', async () => {
    process.env.UNISWAP_ARC_ALLOWED_ORIGIN = base
    delete process.env.UNISWAP_TRADING_API_KEY
    const endpoint = base + '/api/uniswap-arc-preview'
    assert.equal((await fetch(endpoint)).status, 405)
    assert.equal((await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://other.test' }, body: '{}' })).status, 403)
    const headers = { 'Content-Type': 'application/json', Origin: base }
    assert.equal((await fetch(endpoint, { method: 'POST', headers, body: 'x'.repeat(8193) })).status, 413)
    const raw = evidence.EURC
    const input = { chainId: 5042, tokenIn: 'USDC', tokenOut: 'EURC', owner: raw.swapTransaction.from, recipient: raw.swapTransaction.from, amount: '1', slippageBps: 50, minimumOutput: '1', maxNetworkFee: '100000000000000000' }
    const blocked = await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify(input) })
    assert.equal(blocked.status, 503)
    assert.deepEqual(await blocked.json(), { error: 'uniswap_arc_review_blocked', writesEnabled: false })
  })
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? '/usr/bin/chromium', headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] })
  const page = await browser.newPage()
  page.setDefaultTimeout(15000)
  await page.addInitScript(({ skew }) => {
    const originalNow = Date.now.bind(Date)
    window.uniswapUiClockSkew = skew
    Date.now = () => originalNow() + window.uniswapUiClockSkew
  }, { skew: Number(process.env.UNISWAP_UI_CLOCK_SKEW_MS ?? 0) })
  page.on('pageerror', error => pageErrors.push(error.message))
  await page.route('**/*', async route => {
    const req = route.request()
    if (!req.url().startsWith(base + '/')) { external++; await route.abort(); return }
    if (new URL(req.url()).pathname !== '/api/uniswap-arc-preview') return route.continue()
    apiCalls++; const input = req.postDataJSON(); requests.push({ input, headers: req.headers() })
    if (mode === 'held') await new Promise(resolve => { held = resolve })
    if (mode === 'public-disabled') return route.fulfill({ status: 503, headers: { 'X-Uniswap-Preview-Status': 'public-disabled' }, json: { error: 'uniswap_arc_public_preview_disabled', writesEnabled: false, executionBound: false } })
    if (mode === 'error' || mode === 'origin' || mode === 'rate') return route.fulfill({ status: mode === 'origin' ? 403 : mode === 'rate' ? 429 : 503, json: { error: 'blocked', secret: 'never-display-upstream' } })
    try {
      const review = await prepare(input, 'synthetic-server-only-test-key')
      if (mode === 'forged-output') review.estimatedOutput = '99999999999999999'
      if (mode === 'expired') review.expiresAt = Date.now() - 1
      if (mode === 'write-flag') review.executionBound = true
      const headers = { 'X-Preview-Request-Id': req.headers()['x-preview-request-id'], 'X-Preview-Server-Time': String(Date.now()) }
      if (mode === 'missing-timing') delete headers['X-Preview-Server-Time']
      if (mode === 'wrong-nonce') headers['X-Preview-Request-Id'] = crypto.randomUUID()
      await route.fulfill({ json: review, headers })
    } catch { await route.fulfill({ status: 503, json: { error: 'blocked' } }) }
  })
  await page.goto(base + '/__uniswap_ui_test')
  const preview = page.getByRole('button', { name: /^(Get|Refresh) quote$/ })
  const amount = page.getByRole('textbox', { name: 'Swap amount' })
  const receive = () => page.getByLabel('Estimated receive')
  const receiveText = async () => (await receive().innerText()).trim()
  const noReceive = () => page.waitForFunction(() => document.querySelector('output[aria-label="Estimated receive"]')?.textContent === '0.00')
  async function success(symbol = 'EURC') {
    mode = 'normal'
    await page.getByRole('combobox', { name: 'To token' }).selectOption(symbol)
    await amount.fill('1'); await preview.click()
    await page.getByText(/Read-only simulation passed/).waitFor()
  }
  await test('single Swap screen defaults to Uniswap USDC->EURC, is Preview only and keeps execution disabled', async () => {
    await page.getByRole('heading', { name: 'Swap', exact: true }).waitFor()
    await page.getByText('Preview only', { exact: true }).waitFor()
    assert.deepEqual(await page.getByRole('combobox', { name: 'To token' }).locator('option').allTextContents(), ['USDC', 'EURC', 'cirBTC', 'WETH'])
    assert.equal(await page.getByRole('combobox', { name: 'Quote source' }).inputValue(), 'uniswap')
    assert.equal(await page.getByRole('button', { name: 'Swap disabled in Preview' }).isDisabled(), true)
    assert.equal(await page.getByRole('button', { name: /Uniswap Preview|Circle Preview/ }).count(), 0)
  })
  await test('disconnected and wrong-chain wagmi wallet cannot request preview', async () => {
    await amount.fill('1'); assert.equal(await preview.isDisabled(), true)
    await page.evaluate(() => window.uniswapUiTest.connect(1))
    await page.getByText('Select Arc Mainnet (chain ID 5042) in your wallet.').waitFor()
    assert.equal(await preview.isDisabled(), true); assert.equal(apiCalls, 0)
    await page.evaluate(() => window.uniswapUiTest.chain(5042))
    await preview.waitFor({ state: 'visible' })
  })
  await test('EURC actual component calls same-origin API and displays server-validated output, minimum, gas and fee budget', async () => {
    await success()
    assert.equal(await receiveText(), '0.890112')
    assert.equal(await page.getByText('1 EURC ≈ 1.12 USDC', { exact: true }).count(), 1)
    for (const text of ['0.885661 EURC', '130000', '0.00026 USDC']) assert.equal(await page.getByText(text, { exact: true }).count() > 0, true)
    assert.equal(requests.at(-1).input.chainId, 5042); assert.equal(requests.at(-1).input.amount, '1')
    assert.equal(requests.at(-1).headers['x-api-key'], undefined)
    assert.equal(JSON.stringify(requests.at(-1)).includes('synthetic-server-only-test-key'), false)
  })
  await test('output change invalidates quote; cirBTC uses independent V3 payload and output decimals', async () => {
    await page.getByRole('combobox', { name: 'To token' }).selectOption('cirBTC')
    assert.equal(await receiveText(), '0.00')
    await success('cirBTC')
    assert.equal(await receiveText(), '0.00001193')
    assert.equal(await page.getByText('0.00001187 cirBTC', { exact: true }).count(), 1)
  })
  await test('amount and slippage changes clear current review and invalid amounts never call API', async () => {
    await amount.fill('2'); assert.equal(await receiveText(), '0.00')
    await success()
    await page.getByRole('combobox', { name: 'Slippage tolerance' }).selectOption('100'); assert.equal(await receiveText(), '0.00')
    const before = apiCalls
    for (const value of ['0', '11', '1e6', '1.0000001', '-1']) { await amount.fill(value); assert.equal(await preview.isDisabled(), true) }
    assert.equal(apiCalls, before)
    await page.getByRole('combobox', { name: 'Slippage tolerance' }).selectOption('50')
  })
  await test('wallet account changes, network changes and disconnect hide prior amounts immediately', async () => {
    await success(); await page.evaluate(() => window.uniswapUiTest.account(true))
    await noReceive()
    await page.evaluate(() => window.uniswapUiTest.account(false))
    await success(); await page.evaluate(() => window.uniswapUiTest.chain(1))
    await noReceive(); assert.equal(await preview.isDisabled(), true)
    await page.evaluate(() => window.uniswapUiTest.chain(5042))
    await success(); await page.evaluate(() => window.uniswapUiTest.disconnect())
    await noReceive(); assert.equal(await preview.isDisabled(), true)
    await page.evaluate(() => window.uniswapUiTest.connect(5042))
  })
  await test('pending response cannot publish after input changes; duplicate clicks do not start extra requests', async () => {
    await amount.fill('1'); mode = 'held'; held = undefined; const before = apiCalls
    await preview.click(); await page.waitForFunction(() => document.querySelector('button') !== null)
    for (let i = 0; i < 50 && !held; i++) await new Promise(resolve => setTimeout(resolve, 20))
    assert.ok(held)
    assert.equal(await page.getByRole('button', { name: 'Getting quote…' }).isDisabled(), true)
    assert.equal(apiCalls, before + 1)
    await amount.fill('2'); held(); mode = 'normal'
    await page.waitForTimeout(150); assert.equal(await receiveText(), '0.00')
  })
  await test('forged output/slippage, expired response and enabled execution flag fail closed in UI', async () => {
    await amount.fill('1')
    for (const value of ['forged-output', 'expired', 'write-flag']) {
      mode = value; await preview.click(); await page.getByRole('alert').waitFor()
      assert.equal(await receiveText(), '0.00')
      assert.equal(await page.getByRole('button', { name: 'Swap disabled in Preview' }).isDisabled(), true)
    }
  })
  await test('API errors are generic; upstream body and secrets never appear in screen', async () => {
    mode = 'error'; await preview.click(); await page.getByRole('alert').waitFor()
    assert.equal((await page.locator('body').innerText()).includes('never-display-upstream'), false)
    assert.equal((await page.locator('body').innerText()).includes('synthetic-server-only-test-key'), false)
  })
  await test('HTTP failures identify origin/rate/service stages without exposing server payloads', async () => {
    for (const [value, text] of [['origin', 'This site address is not allowed'], ['rate', 'Too many preview requests'], ['error', 'The server could not verify a current quote']]) {
      mode = value; await preview.click(); await page.getByRole('alert').filter({ hasText: text }).waitFor()
      assert.equal(await receiveText(), '0.00')
    }
  })
  await test('disabled public Uniswap API is explicit, shows no fabricated output and preserves Circle selection', async () => {
    mode = 'public-disabled'; await preview.click()
    await page.getByRole('alert').filter({ hasText: 'Public Uniswap previews are disabled' }).waitFor()
    assert.equal(await receiveText(), '0.00')
    await page.getByRole('combobox', { name: 'Quote source' }).selectOption('circle')
    assert.equal(await page.getByRole('combobox', { name: 'Quote source' }).inputValue(), 'circle')
    assert.equal(await page.getByRole('button', { name: 'Swap disabled in Preview' }).isDisabled(), true)
    await page.getByRole('combobox', { name: 'Quote source' }).selectOption('uniswap')
  })
  await test('missing freshness envelope or mismatched request nonce is a precise timing failure', async () => {
    for (const value of ['missing-timing', 'wrong-nonce']) {
      mode = value; await preview.click(); await page.getByRole('alert').filter({ hasText: 'Preview freshness could not be verified' }).waitFor()
      assert.equal(await receiveText(), '0.00')
    }
  })
  await test('browser clock ahead or behind server still displays verified 0.1-USDC EURC quote with bounded TTL', async () => {
    for (const skew of [-60000, 60000, -3600000, 3600000]) {
      await page.evaluate(value => { window.uniswapUiClockSkew = value }, skew)
      mode = 'normal'; await amount.fill('0.1'); await preview.click()
      await page.getByText(/Read-only simulation passed/).waitFor()
      assert.equal(await receiveText(), '0.089011')
      assert.equal(await page.getByText('0.088565 EURC', { exact: true }).count(), 1)
      const ttl = await page.locator('dt').filter({ hasText: /^Quote expires in$/ }).locator('..').locator('dd').innerText()
      assert.ok(parseInt(ttl) > 0 && parseInt(ttl) <= 30)
    }
    await page.evaluate(() => { window.uniswapUiClockSkew = 0 })
  })
  await test('expiry timer removes previously displayed output without another request', async () => {
    await success(); const before = apiCalls
    await page.clock.install(); await page.clock.fastForward(31000)
    await noReceive(); assert.equal(apiCalls, before)
    await page.clock.setSystemTime(new Date())
  })
  await test('Circle-only routes switch provider and hide Uniswap; Uniswap routes offer both sources', async () => {
    await page.getByRole('combobox', { name: 'Quote source' }).selectOption('circle')
    await page.locator('dt').filter({ hasText: /^Provider$/ }).locator('..').locator('dd').filter({ hasText: /^Circle Swap Kit$/ }).waitFor()
    await page.getByRole('combobox', { name: 'Quote source' }).selectOption('uniswap')
    await page.getByRole('combobox', { name: 'From token' }).selectOption('WETH')
    assert.equal(await page.getByRole('combobox', { name: 'Quote source' }).count(), 0)
    assert.equal(await page.getByRole('combobox', { name: 'To token' }).inputValue(), 'USDC')
    assert.equal(await page.getByText('Uniswap (Arc router)', { exact: true }).count(), 0)
    await page.getByRole('combobox', { name: 'From token' }).selectOption('USDC')
    await page.getByRole('combobox', { name: 'To token' }).selectOption('EURC')
    assert.equal(await receiveText(), '0.00')
  })
  await test('zero external requests and zero uncaught browser errors; submit stays disabled', async () => {
    assert.equal(external, 0); assert.deepEqual(pageErrors, [])
    assert.ok(upstreamCalls > 0)
    assert.equal(await page.getByRole('button', { name: 'Swap disabled in Preview' }).isDisabled(), true)
  })
  console.log(`${count} Chromium UI integration groups PASS. Real React/wagmi mock connector; synthetic HTTP/RPC only; zero real signing or transactions.`)
} finally {
  if (browser) await browser.close()
  await server.close()
  if (previousOrigin === undefined) delete process.env.UNISWAP_ARC_ALLOWED_ORIGIN; else process.env.UNISWAP_ARC_ALLOWED_ORIGIN = previousOrigin
  if (previousKey === undefined) delete process.env.UNISWAP_TRADING_API_KEY; else process.env.UNISWAP_TRADING_API_KEY = previousKey
}
