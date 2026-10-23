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
const { decodeFunctionData, encodeFunctionData, decodeAbiParameters, encodeAbiParameters, formatUnits } = require('viem')
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
// This suite covers the Trading-API preview route, which is the route of the explicit pilot build (the default build quotes on chain, keyless; see verify-swap-unified-ui.mjs).
const server = await createServer({ configFile: false, root, define: { 'import.meta.env.VITE_SWAP_EXECUTION_MODE': JSON.stringify('pilot') }, cacheDir: `${root}.verification/vite-ui-cache`, server: { host: '127.0.0.1', port: 0 }, plugins: [uniswapArcDevPreview(), {
  name: 'controlled-circle-estimator', enforce: 'pre', transform(code, id) {
    if (id.split('?')[0] !== `${root}src/lib/mainnetSwap.ts`) return
    return code.replace('export function readMainnetSwapQuote(', 'function originalReadMainnetSwapQuote(') + `
const testCircleReader = createSwapQuoteReader(async input => {
  const response = await fetch('/__circle_quote', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) });
  if (!response.ok) throw new Error('quote_unavailable');
  return response.json();
});
export const readMainnetSwapQuote = testCircleReader;
`
  }
}, {
  name: 'local-uniswap-ui-harness', configureServer(server) {
    server.middlewares.use('/__uniswap_ui_test', async (_req, res) => {
      res.setHeader('Content-Type', 'text/html')
      res.end(await server.transformIndexHtml('/__uniswap_ui_test', '<!doctype html><html><body><div id="root"></div><script type="module" src="/scripts/fixtures/uniswap-arc/ui-harness.tsx"></script></body></html>'))
    })
  },
}] })
await server.listen()
const base = `http://127.0.0.1:${server.httpServer.address().port}`
let browser, count = 0, external = 0, apiCalls = 0, mode = 'normal', held, circleHeld, circleMode = 'normal', circleCalls = 0
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
    if (new URL(req.url()).pathname === '/__circle_quote') {
      circleCalls++; const input = req.postDataJSON(), selected = circleMode
      if (selected === 'held') await new Promise(resolve => { circleHeld = resolve })
      if (selected === 'error') return route.fulfill({ status: 503, json: { secret: 'never-display-upstream' } })
      const decimals = input.tokenOut === 'cirBTC' ? 8 : input.tokenOut === 'WETH' ? 18 : 6
      const output = p.nativeAmount(input.amount) * 2n / (10n ** BigInt(18 - decimals))
      return route.fulfill({ json: { tokenIn: input.tokenIn, tokenOut: input.tokenOut, amountIn: input.amount,
        chain: 'Arc', chainIn: 'Arc', chainOut: 'Arc', fromAddress: input.address, toAddress: input.address,
        estimatedOutput: { token: input.tokenOut, amount: formatUnits(output, decimals) },
        stopLimit: { token: input.tokenOut, amount: formatUnits(p.minimumAtSlippage(output, input.slippageBps), decimals) },
        fees: [{ type: 'gas', token: 'USDC', amount: '0.001' }] } }).catch(() => {})
    }
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
  await page.clock.install()
  await page.clock.pauseAt(new Date(Date.now() + 1000))
  const amount = page.getByRole('textbox', { name: 'Swap amount' })
  const receiveText = async () => (await page.getByLabel('Estimated receive').innerText()).trim()
  const noReceive = () => page.waitForFunction(() => document.querySelector('output[aria-label="Estimated receive"]')?.textContent === '0.00')
  async function advance(ms = 2600) {
    await page.waitForTimeout(35); await page.clock.fastForward(ms); await page.waitForTimeout(100)
  }
  async function change(value = '1') { await amount.fill(''); await amount.fill(value); await advance() }
  async function success(symbol = 'EURC') {
    mode = 'normal'; await page.getByRole('combobox', { name: 'To token' }).selectOption(symbol)
    await change(); await page.getByText(/Estimate only\./).waitFor()
  }
  await test('single Swap screen removes manual quote buttons and keeps default pilot disabled', async () => {
    await page.getByRole('heading', { name: 'Swap', exact: true }).waitFor()
    assert.equal(await page.getByRole('button', { name: /^(Get|Refresh) quote$/ }).count(), 0)
    assert.equal(await page.getByRole('button', { name: 'Review Swap', exact: true }).isDisabled(), true)
  })
  await test('disconnected, wrong-chain and invalid input never start automatic API calls', async () => {
    await amount.fill('1'); await advance(); assert.equal(apiCalls, 0)
    await page.evaluate(() => window.uniswapUiTest.connect(1)); await advance(); assert.equal(apiCalls, 0)
    await amount.fill(''); await page.evaluate(() => window.uniswapUiTest.chain(5042))
    for (const value of ['0', '11', '1e6', '1.0000001', '-1']) { await amount.fill(value); await advance() }
    assert.equal(apiCalls, 0)
  })
  await test('rapid typing debounces for 700ms and only the last amount is queried', async () => {
    const circleBefore = circleCalls
    await amount.fill('0.'); await advance(250); await amount.fill('0.1'); await advance(250); await amount.fill('0.12')
    await advance(600); assert.equal(apiCalls, 0)
    await advance(150); await page.getByText(/Estimate only\./).waitFor()
    assert.equal(apiCalls, 1); assert.equal(requests.at(-1).input.amount, '0.12')
    assert.equal(circleCalls - circleBefore, 1) // both providers are quoted for comparison, each once for the last amount
  })
  await test('automatic EURC quote shows independently checked output, minimum, fee and bounded TTL', async () => {
    await success(); assert.equal(await receiveText(), '0.890112')
    for (const text of ['0.885661 EURC', '0.00026 USDC ceiling']) assert.ok(await page.getByText(text, { exact: true }).count(), text)
    assert.equal(requests.at(-1).headers['x-api-key'], undefined)
    const ttl = await page.locator('dt').filter({ hasText: /^Quote expires in$/ }).locator('..').locator('dd').innerText()
    assert.ok(parseInt(ttl) > 0 && parseInt(ttl) <= 30)
  })
  await test('slippage changes automatically fetch the selected quote; Uniswap slippage values Circle does not offer are said so, never replaced', async () => {
    await page.getByRole('combobox', { name: 'Slippage tolerance' }).selectOption('100'); await noReceive(); await advance()
    await page.getByText(/Estimate only\./).waitFor(); assert.equal(requests.at(-1).input.slippageBps, 100)
    await page.getByRole('combobox', { name: 'Slippage tolerance' }).selectOption('10'); await noReceive(); await advance()
    await page.getByText(/Estimate only\./).waitFor(); assert.equal(requests.at(-1).input.slippageBps, 10)
    await page.getByText(/Circle Swap Kit does not offer 0\.1% slippage/).waitFor()
    await page.getByRole('combobox', { name: 'Slippage tolerance' }).selectOption('300'); await noReceive()
    await page.getByText(/Uniswap does not offer 3% slippage/).waitFor()
    await page.getByRole('combobox', { name: 'Slippage tolerance' }).selectOption('50')
  })
  await test('a cancelled late response cannot overwrite the next automatic amount; loading is visible', async () => {
    mode = 'held'; held = undefined; await change('0.1')
    for (let i = 0; i < 50 && !held; i++) await page.waitForTimeout(20)
    assert.ok(held); await page.getByText('Updating price…', { exact: true }).first().waitFor()
    const before = apiCalls; await amount.fill('0.2'); await noReceive(); held(); mode = 'normal'
    await advance(); await page.getByText(/Estimate only\./).waitFor()
    assert.equal(requests.at(-1).input.amount, '0.2'); assert.equal(apiCalls, before + 1)
  })
  await test('automatic requests are paced at least 2.5 seconds apart', async () => {
    await success(); const before = apiCalls
    await amount.fill('0.3'); await advance(750); assert.equal(apiCalls, before)
    await advance(1800); await page.getByText(/Estimate only\./).waitFor(); assert.equal(apiCalls, before + 1)
  })
  await test('automatic pricing preserves server-clock freshness with browser clocks ahead or behind', async () => {
    for (const skew of [-60000, 60000, -3600000, 3600000]) {
      await page.clock.setSystemTime(new Date(Date.now() + skew)); await success()
      assert.equal(await receiveText(), '0.890112')
      const ttl = await page.locator('dt').filter({ hasText: /^Quote expires in$/ }).locator('..').locator('dd').innerText()
      assert.ok(parseInt(ttl) > 0 && parseInt(ttl) <= 30)
    }
    await page.clock.setSystemTime(new Date())
  })
  await test('expired automatic quotes disappear without polling or automatic resubmission', async () => {
    await success(); const before = apiCalls; await advance(31000); await noReceive()
    assert.equal(apiCalls, before); await page.getByText(/Quote expired. Change the amount/).first().waitFor()
    await advance(60000); assert.equal(apiCalls, before)
  })
  await test('HTTP 429 and API errors stay bounded and never cause infinite retries', async () => {
    for (const [value, text] of [['rate', 'Too many preview requests'], ['error', 'The server could not verify a current quote'], ['origin', 'This site address is not allowed'], ['public-disabled', 'Public Uniswap previews are disabled']]) {
      mode = value; await change('0.1'); await page.getByRole('alert').filter({ hasText: text }).waitFor()
      const before = apiCalls; await advance(60000); assert.equal(apiCalls, before); assert.equal(await receiveText(), '0.00')
      assert.equal((await page.locator('body').innerText()).includes('never-display-upstream'), false)
    }
  })
  await test('forged economics, expired quotes and missing freshness proof still fail closed', async () => {
    for (const value of ['forged-output', 'expired', 'write-flag', 'missing-timing', 'wrong-nonce']) {
      mode = value; await change('0.1'); await page.getByRole('alert').waitFor(); assert.equal(await receiveText(), '0.00')
    }
  })
  await test('hidden edits and pending debounce make no background quote requests', async () => {
    mode = 'normal'; await amount.fill(''); await advance()
    await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, value: true }); document.dispatchEvent(new Event('visibilitychange')) })
    const before = apiCalls; await amount.fill('0.1'); await advance(10000); assert.equal(apiCalls, before)
    await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, value: false }); document.dispatchEvent(new Event('visibilitychange')) })
    await advance(); await page.getByText(/Estimate only\./).waitFor(); assert.equal(apiCalls, before + 1)
    await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, value: true }); document.dispatchEvent(new Event('visibilitychange')) })
    await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, value: false }); document.dispatchEvent(new Event('visibilitychange')) })
    await advance(10000); assert.equal(apiCalls, before + 1); await noReceive()
  })
  await test('both providers are quoted for comparison; selecting Circle only changes the selected provider, and amount/slippage changes refresh both', async () => {
    const before = apiCalls; await page.getByRole('radio', { name: 'Circle Swap Kit quote' }).click(); await advance()
    await page.getByText(/Estimate only\./).waitFor(); assert.equal(await receiveText(), '0.2'); assert.equal(apiCalls, before)
    const calls = circleCalls; await amount.fill('0.2'); await advance(); await page.getByText(/Estimate only\./).waitFor()
    assert.equal(circleCalls, calls + 1); assert.equal(await receiveText(), '0.4'); assert.equal(apiCalls, before + 1) // both providers refresh for a new amount
    await page.getByRole('combobox', { name: 'Slippage tolerance' }).selectOption('100'); await advance()
    assert.equal(circleCalls, calls + 2); assert.equal(apiCalls, before + 2)
  })
  await test('Circle ignores cancelled late SDK responses and never auto-retries failures', async () => {
    circleMode = 'held'; circleHeld = undefined; await change('0.1')
    for (let i = 0; i < 50 && !circleHeld; i++) await page.waitForTimeout(20)
    assert.ok(circleHeld); await amount.fill('0.3'); await noReceive(); circleMode = 'normal'; circleHeld()
    await advance(); await page.getByText(/Estimate only\./).waitFor(); assert.equal(await receiveText(), '0.6')
    circleMode = 'error'; await change('0.1'); await page.getByText(/No quote from this provider/).first().waitFor()
    const before = circleCalls; await advance(60000); assert.equal(circleCalls, before)
    circleMode = 'normal'
  })
  await test('non-USDC pairs (WETH to EURC) are accepted as chosen, auto-quote, and execution stays disabled in the pilot build', async () => {
    await page.getByRole('combobox', { name: 'From token' }).selectOption('WETH'); await change('0.1')
    await page.getByText(/Estimate only\./).waitFor(); assert.equal(await page.getByRole('combobox', { name: 'To token' }).inputValue(), 'EURC') // no silent fallback to a USDC leg
    assert.equal(await page.getByRole('button', { name: 'Review Swap', exact: true }).isDisabled(), true)
  })
  await test('wallet changes invalidate amounts and disconnect never queries', async () => {
    await page.evaluate(() => window.uniswapUiTest.account(true)); await noReceive(); await advance()
    await page.getByText(/Estimate only\./).waitFor()
    await page.evaluate(() => window.uniswapUiTest.disconnect()); await noReceive()
    const before = apiCalls + circleCalls; await amount.fill('0.2'); await advance(10000); assert.equal(apiCalls + circleCalls, before)
  })
  await test('all quote controls remain read-only with zero external traffic or uncaught errors', async () => {
    assert.equal(external, 0); assert.deepEqual(pageErrors, [])
    assert.equal(await page.getByRole('button', { name: /^(Get|Refresh) quote$/ }).count(), 0)
    assert.ok(upstreamCalls > 0)
  })
  console.log(`${count} Chromium UI integration groups PASS. Real React/wagmi mock connector; synthetic HTTP/RPC only; zero real signing or transactions.`)
} finally {
  if (browser) await browser.close()
  await server.close()
  if (previousOrigin === undefined) delete process.env.UNISWAP_ARC_ALLOWED_ORIGIN; else process.env.UNISWAP_ARC_ALLOWED_ORIGIN = previousOrigin
  if (previousKey === undefined) delete process.env.UNISWAP_TRADING_API_KEY; else process.env.UNISWAP_TRADING_API_KEY = previousKey
}
