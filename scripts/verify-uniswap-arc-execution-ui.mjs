// Real Chromium, React, wagmi connector, Web Locks and localStorage. API/RPC/wallet sends are test doubles.
// Test-only pilot build configuration; controlled API/RPC/wallet responses, no real signatures or sends.
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'
const require = createRequire(import.meta.url), ts = require('typescript')
require.extensions['.ts'] = (mod, file) => mod._compile(ts.transpileModule(readFileSync(file, 'utf8'), { fileName: file,
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText, file)
let chromium
try { ({ chromium } = require('playwright-core')) } catch { ({ chromium } = require(process.env.PLAYWRIGHT_CORE_PATH ?? '/opt/codex/runtimes/cua/lib/node_modules/playwright-core')) }
const root = fileURLToPath(new URL('..', import.meta.url)), p = require(`${root}src/lib/uniswapArcPolicy.ts`)
const { toHex, decodeFunctionData, encodeEventTopics, encodeAbiParameters, parseAbiParameters } = require('viem')
const fresh = require(`${root}scripts/fixtures/uniswap-arc/execution-review.cjs`)
const runtime = readFileSync(`${root}scripts/fixtures/uniswap-arc/router-runtime.hex`, 'utf8').trim()
const owner = '0xafbB6Cc5C0a9C0eB1BfF8dB2eD807e83aAB8e321', blockHash = '0x' + 'b'.repeat(64)
const server = await createServer({ configFile: false, root, define: { 'import.meta.env.VITE_UNISWAP_ARC_PILOT_ENABLED': JSON.stringify('true'), 'import.meta.env.VITE_UNISWAP_ARC_PILOT_WALLET': JSON.stringify(owner) }, cacheDir: `${root}.verification/vite-execution-ui`, server: { host: '127.0.0.1', port: 0 }, plugins: [{
  name: 'execution-fixture-route', configureServer(server) {
  server.middlewares.use('/__execution_ui_test', async (_req, res) => {
    res.setHeader('Content-Type', 'text/html')
    res.end(await server.transformIndexHtml('/__execution_ui_test', '<!doctype html><html><body><div id="root"></div><script type="module" src="/scripts/fixtures/uniswap-arc/execution-ui-harness.tsx"></script></body></html>'))
  })
} }] })
await server.listen()
const base = `http://127.0.0.1:${server.httpServer.address().port}`
let browser, page, count = 0, apiCalls = 0, external = 0, latestReview, receiptMode = 'pending', rpcMode = 'normal', publicLatestNonce = 7, publicPendingNonce = 7, laggedNonceReads = 0
const transactions = new Map(), methods = [], errors = []
async function test(name, fn) {
  try { await fn(); count++; console.log(`PASS ${name}`) }
  catch (error) {
    console.error('Synthetic UI diagnostics:', await page.locator('body').innerText(), await page.evaluate(() => window.executionUiTest.state.requests.map(r => r.method)))
    throw error
  }
}
async function cacheWallet() {
  const state = await page.evaluate(() => window.executionUiTest.state)
  if (state.tx && state.hash) transactions.set(state.hash.toLowerCase(), { tx: state.tx, review: latestReview })
  return state
}
try {
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? '/usr/bin/chromium', headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] })
  const context = await browser.newContext(); page = await context.newPage(); page.setDefaultTimeout(15000)
  page.on('pageerror', e => errors.push(e.message))
  await page.route('**/*', async route => {
    const request = route.request(), url = request.url()
    if (url === base + '/api/uniswap-arc-preview') {
      apiCalls++; const input = p.validateArcRequest(request.postDataJSON()); latestReview = fresh(input)
      return route.fulfill({ json: latestReview, headers: { 'X-Preview-Request-Id': request.headers()['x-preview-request-id'], 'X-Preview-Server-Time': String(Date.now()) } })
    }
    if (url.startsWith(base + '/')) return route.continue()
    if (url.startsWith('https://fonts.googleapis.com/')) return route.fulfill({ contentType: 'text/css', body: '' })
    if (url !== 'https://rpc.mainnet.arc.io/') { external++; return route.abort() }
    const body = request.postDataJSON(), { method, params } = body; methods.push(method)
    let result
    if (method === 'eth_chainId') result = '0x13b2'
    else if (method === 'eth_blockNumber') result = '0x65'
    else if (method === 'eth_getBlockByNumber') result = { number: '0x64', hash: blockHash, parentHash: blockHash, timestamp: toHex(Math.floor(Date.now() / 1000)), baseFeePerGas: '0x3b9aca00', gasLimit: '0x1c9c380', gasUsed: '0x186a0', transactions: [] }
    else if (method === 'eth_getCode') result = p.sameAddress(params[0], owner) ? '0x' : p.sameAddress(params[0], p.ARC_ROUTER) ? rpcMode === 'router' ? '0x6000' : runtime : '0x6000'
    else if (method === 'eth_getBalance') result = rpcMode === 'balance' ? '0x1' : toHex(100n * 10n ** 18n)
    else if (method === 'eth_gasPrice') result = '0x3b9aca00'
    else if (method === 'eth_getTransactionCount') result = toHex(laggedNonceReads > 0 ? (laggedNonceReads--, 6) : params[1] === 'pending' ? publicPendingNonce : publicLatestNonce)
    else if (method === 'eth_estimateGas') result = '0x186a0'
    else if (method === 'eth_call') result = params[0].data === '0x313ce567' ? toHex(p.sameAddress(params[0].to, p.ARC_OUTPUTS.EURC.address) ? 6 : 8, { size: 32 }) : '0x'
    else if (method === 'eth_getTransactionByHash' || method === 'eth_getTransactionReceipt') {
      if (!transactions.has(params[0].toLowerCase())) await cacheWallet()
      const saved = transactions.get(params[0].toLowerCase())
      if (!saved) result = null
      else if (method === 'eth_getTransactionByHash') result = { ...saved.tx, hash: params[0], input: saved.tx.data, chainId: '0x13b2', blockHash: receiptMode === 'pending' ? null : blockHash, blockNumber: receiptMode === 'pending' ? null : '0x64', transactionIndex: receiptMode === 'pending' ? null : '0x0' }
      else if (receiptMode === 'pending') result = null
      else {
        const topics = encodeEventTopics({ abi: [{ type: 'event', name: 'Transfer', inputs: [{ name: 'from', type: 'address', indexed: true }, { name: 'to', type: 'address', indexed: true }, { name: 'value', type: 'uint256', indexed: false }] }], eventName: 'Transfer', args: { from: p.ARC_ROUTER, to: owner } })
        result = { transactionHash: params[0], from: owner, to: p.ARC_ROUTER, blockNumber: '0x64', blockHash, transactionIndex: '0x0', gasUsed: '0x186a0', cumulativeGasUsed: '0x186a0', effectiveGasPrice: '0x3b9aca00', status: receiptMode === 'reverted' ? '0x0' : '0x1', type: '0x2', logsBloom: '0x' + '0'.repeat(512), logs: receiptMode === 'reverted' ? [] : [{ address: p.ARC_OUTPUTS[saved.review.request.tokenOut].address, topics, data: encodeAbiParameters(parseAbiParameters('uint256'), [BigInt(saved.review.requiredMinimum)]), removed: false, transactionHash: params[0], blockNumber: '0x64', blockHash, transactionIndex: '0x0', logIndex: '0x0' }] }
      }
    } else throw new Error(`Unexpected RPC method ${method}`)
    return route.fulfill({ json: { jsonrpc: '2.0', id: body.id, result } })
  })
  await page.goto(base + '/__execution_ui_test')
  const amount = page.getByRole('textbox', { name: 'Swap amount' })
  const review = page.getByRole('button', { name: 'Review Swap', exact: true })
  const confirm = page.getByRole('button', { name: 'Confirm Swap', exact: true })
  const transactionStatus = page.getByRole('article', { name: 'Latest transaction' }) // the latest transaction only; the history is a separate, collapsed list
  const sends = () => page.evaluate(() => window.executionUiTest.state.requests.filter(r => r.method === 'eth_sendTransaction').length)
  async function prepare(symbol = 'EURC') {
    await page.getByRole('combobox', { name: 'To token' }).selectOption(symbol); await amount.fill('0.1'); await review.click()
    await page.getByRole('dialog').waitFor(); await confirm.waitFor()
  }
  await test('existing wallet connection and explicit Review are required; no automatic quote/send on mount', async () => {
    assert.equal(await review.isDisabled(), true); assert.equal(apiCalls, 0)
    await page.evaluate(() => window.executionUiTest.connect(5042)); await amount.fill('0.1')
    assert.equal(await review.isEnabled(), true); assert.equal(await sends(), 0); assert.equal(apiCalls, 0)
  })
  await test('pilot UI blocks other directions, other wallets and more than 0.1 USDC with a stated reason, and without any send', async () => {
    await page.getByRole('combobox', { name: 'To token' }).selectOption('cirBTC')
    assert.equal(await review.isDisabled(), true); await page.getByText(/Execution is limited to the controlled pilot \(USDC → EURC\)/).waitFor()
    await page.getByRole('combobox', { name: 'To token' }).selectOption('EURC')
    await amount.fill('0.100001'); assert.equal(await review.isDisabled(), true); await page.getByText(/controlled pilot allows at most 0\.1 USDC/).waitFor()
    await amount.fill('0.1'); await page.evaluate(() => window.executionUiTest.account(true))
    await page.getByText(/limited to the approved pilot wallet|Connect the wallet that will pay/).waitFor(); assert.equal(await review.isDisabled(), true)
    await page.evaluate(() => window.executionUiTest.account(false)); await page.waitForFunction(() => !document.evaluate("//button[normalize-space()='Review Swap']", document, null, 9, null).singleNodeValue?.disabled)
    assert.equal(await review.isEnabled(), true); assert.equal(await sends(), 0); assert.equal(apiCalls, 0)
  })
  await test('Review fetches fresh data, runs actual read-only client and shows independent approval summary', async () => {
    await page.getByText(/Read-only simulation passed/).waitFor()
    const before = apiCalls
    await prepare(); assert.equal(apiCalls, before + 1); assert.equal(await sends(), 0)
    const dialog = page.getByRole('dialog'); await dialog.getByText('0.088565 EURC', { exact: true }).waitFor()
    await dialog.getByText('0.00026 USDC', { exact: true }).waitFor(); assert.ok(methods.includes('eth_estimateGas'))
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click(); assert.equal(await sends(), 0)
  })
  await test('native balance shortcuts refetch, respect the pilot cap and block unsafe or failed MAX reads', async () => {
    for (const name of ['25%', '50%', '75%', 'MAX']) {
      await amount.fill(''); const before = await page.evaluate(() => window.executionUiTest.state.balanceReads)
      await page.getByRole('button', { name, exact: true }).click()
      await page.waitForFunction(() => document.querySelector('input[aria-label="Swap amount"]').value === '0.1')
      assert.ok(await page.evaluate(() => window.executionUiTest.state.balanceReads) > before); assert.equal(await sends(), 0)
    }
    await page.evaluate(() => { window.executionUiTest.state.balanceMode = 'low' })
    await amount.fill('0.07'); await page.getByRole('button', { name: 'MAX', exact: true }).click()
    await page.getByText(/cannot cover the reserved network fee/).waitFor(); assert.equal(await amount.inputValue(), '0.07')
    await page.evaluate(() => { window.executionUiTest.state.balanceMode = 'error' })
    await page.getByRole('button', { name: '25%', exact: true }).click()
    await page.getByText(/current input-token balance could not be verified/).waitFor(); assert.equal(await amount.inputValue(), '0.07')
    await page.evaluate(() => { window.executionUiTest.state.balanceMode = '' }); await amount.fill('0.1')
  })
  await test('delayed shortcut responses cannot overwrite manual edits or changed wallets/tokens, including switching back', async () => {
    for (const change of ['manual', 'wallet', 'token']) {
      await page.evaluate(() => { window.executionUiTest.state.balanceMode = 'held' })
      await page.getByRole('button', { name: '25%', exact: true }).click()
      await page.getByText('Checking current token balance…').waitFor()
      if (change === 'manual') await amount.fill('0.03')
      if (change === 'wallet') { await page.evaluate(() => window.executionUiTest.account(true)); await page.evaluate(() => window.executionUiTest.account(false)) }
      if (change === 'token') { await page.getByRole('combobox', { name: 'From token' }).selectOption('EURC'); await page.getByRole('combobox', { name: 'From token' }).selectOption('USDC') }
      await page.evaluate(() => { window.executionUiTest.state.balanceMode = ''; window.executionUiTest.releaseBalance() })
      await page.getByText('Checking current token balance…').waitFor({ state: 'hidden' })
      assert.equal(await amount.inputValue(), change === 'manual' ? '0.03' : change === 'token' ? '' : '0.1') // changing the input token clears the amount (its units change); a late balance never refills it
      assert.equal(await sends(), 0)
      await amount.fill('0.1')
    }
  })
  await test('ERC-20 percentages use the selected token decimals and the per-swap ceiling; Circle never enables execution', async () => {
    await page.getByRole('combobox', { name: 'From token' }).selectOption('cirBTC')
    await page.getByRole('button', { name: '75%', exact: true }).click()
    await page.waitForFunction(() => document.querySelector('input[aria-label="Swap amount"]').value === '0.00012') // 0.75 cirBTC held, limited to 0.00012 cirBTC per swap
    assert.equal(await review.isDisabled(), true)
    assert.equal(await page.getByRole('region', { name: 'Token approvals' }).count(), 0) // the pilot build never offers an approval for a route it cannot send
    await page.getByRole('combobox', { name: 'From token' }).selectOption('USDC'); await page.getByRole('combobox', { name: 'To token' }).selectOption('EURC')
    await amount.fill('0.1'); await page.getByRole('radio', { name: 'Circle Swap Kit quote' }).click()
    await page.getByText(/Circle Swap Kit swaps are not part of the controlled pilot/).waitFor(); assert.equal(await review.isDisabled(), true)
    await page.getByRole('radio', { name: 'Uniswap quote' }).click(); await amount.fill('0.1')
  })
  await test('Review reports RPC nonce disagreement before offering confirmation and exposes only safe counts', async () => {
    await page.evaluate(() => { window.executionUiTest.state.walletLatestNonce = 6; window.executionUiTest.state.walletPendingNonce = 6 })
    await review.click()
    await page.getByRole('alert').filter({ hasText: 'Review nonce check: Public latest/pending 7/7; wallet latest/pending 6/6' }).waitFor()
    assert.equal(await page.getByRole('dialog').count(), 0); assert.equal(await sends(), 0)
    await page.evaluate(() => { window.executionUiTest.state.walletLatestNonce = 7; window.executionUiTest.state.walletPendingNonce = 7 })
  })
  await test('Confirm distinguishes wallet RPC disagreement without opening a wallet transaction request', async () => {
    await prepare()
    await page.evaluate(() => { window.executionUiTest.state.walletLatestNonce = 6; window.executionUiTest.state.walletPendingNonce = 6 })
    await confirm.click()
    await page.getByRole('alert').filter({ hasText: 'Confirm nonce check: Public latest/pending 7/7; wallet latest/pending 6/6' }).waitFor()
    assert.equal(await sends(), 0)
    await page.evaluate(() => { window.executionUiTest.state.walletLatestNonce = 7; window.executionUiTest.state.walletPendingNonce = 7 })
  })
  await test('pending transactions and real confirmed nonce changes have distinct blocking messages', async () => {
    for (const latest of [7, 8]) {
      await prepare(); publicLatestNonce = latest; publicPendingNonce = 8
      await page.evaluate(latest => { window.executionUiTest.state.walletLatestNonce = latest; window.executionUiTest.state.walletPendingNonce = 8 }, latest)
      await confirm.click()
      await page.getByRole('alert').filter({ hasText: latest === 7 ? 'another pending transaction' : 'The account nonce changed since Review' }).waitFor()
      assert.equal(await sends(), 0); publicLatestNonce = 7; publicPendingNonce = 7
      await page.evaluate(() => { window.executionUiTest.state.walletLatestNonce = 7; window.executionUiTest.state.walletPendingNonce = 7 })
    }
  })
  await test('one transient stale public nonce is reconciled forward with the real preflight adapter', async () => {
    laggedNonceReads = 3; await prepare(); assert.equal(laggedNonceReads, 0); assert.equal(await sends(), 0)
    await page.getByRole('dialog').getByRole('button', { name: 'Cancel', exact: true }).click()
  })
  await test('wallet RPC unsupported, unauthorized and malformed responses render safe pending-stage diagnostics', async () => {
    for (const [mode, label] of [['unsupported', 'method unsupported (code -32601)'], ['unauthorized', 'wallet authorization unavailable (code 4100)'], ['malformed', 'invalid EIP-1193 response']]) {
      await page.evaluate(mode => { window.executionUiTest.state.walletReadFailure = mode }, mode)
      await review.click()
      const alert = page.getByRole('alert').filter({ hasText: 'eth_getTransactionCount(pending)' })
      await alert.waitFor(); assert.ok((await alert.innerText()).includes(label)); assert.ok(!(await page.locator('body').innerText()).includes('SECRET-PROVIDER-DETAILS'))
      if (mode === 'malformed') {
        assert.ok((await alert.innerText()).endsWith('Response shape: type=object; stringLength=n/a; canonicalHexQuantity=n/a.'))
        assert.equal(await page.evaluate(() => Object.keys(localStorage).filter(key => key.startsWith('machina.uniswap.arc.execution.v1:')).length), 0)
      } else assert.ok(!(await alert.innerText()).includes('Response shape'))
      assert.equal(await page.getByRole('dialog').count(), 0); assert.equal(await sends(), 0)
    }
    await page.evaluate(() => { window.executionUiTest.state.walletReadFailure = '' })
  })
  await test('numeric wallet pending opens Review without sending and retains mismatch/invalid-response blocks', async () => {
    await page.evaluate(() => { window.executionUiTest.state.numericPending = true })
    await prepare(); assert.equal(await sends(), 0)
    await page.getByRole('dialog').getByRole('button', { name: 'Cancel', exact: true }).click()
    await page.evaluate(() => { window.executionUiTest.state.walletPendingNonce = 8 })
    await review.click(); await page.getByRole('alert').filter({ hasText: 'RPC and wallet RPC disagree' }).waitFor()
    assert.equal(await sends(), 0); assert.equal(await page.getByRole('dialog').count(), 0)
    await page.evaluate(() => { window.executionUiTest.state.walletPendingNonce = -1 })
    await review.click()
    await page.getByRole('alert').filter({ hasText: 'Response shape: type=number; stringLength=n/a; canonicalHexQuantity=n/a.' }).waitFor()
    assert.equal(await sends(), 0)
    await page.evaluate(() => { window.executionUiTest.state.walletPendingNonce = 7; window.executionUiTest.state.numericPending = false })
  })
  await test('native browser Web Lock blocks a competing submission without a wallet write', async () => {
    await page.evaluate(() => { navigator.locks.request('machina-uniswap-5042:0xafbb6cc5c0a9c0eb1bff8db2ed807e83aab8e321', () => new Promise(resolve => { window.releaseExecutionLock = resolve })); })
    await prepare(); await confirm.click(); await page.getByRole('alert').filter({ hasText: 'Another tab' }).waitFor()
    assert.equal(await sends(), 0); await page.evaluate(() => window.releaseExecutionLock())
  })
  await test('EURC wallet approval may take 45 seconds without inheriting the 30-second quote deadline', async () => {
    await page.clock.install()
    await prepare(); await page.getByRole('dialog').getByText('Transaction deadline', { exact: true }).waitFor()
    await page.getByRole('dialog').getByText(/The transaction deadline is capped at two minutes/).waitFor()
    await page.evaluate(() => { window.executionUiTest.state.walletMode = 'held' }); await confirm.click()
    await transactionStatus.getByText('Awaiting wallet confirmation', { exact: true }).waitFor()
    assert.equal(await sends(), 1); assert.equal(await review.isDisabled(), true)
    const records = await page.evaluate(() => Object.entries(localStorage).filter(([k]) => k.startsWith('machina.uniswap.arc.execution.v1:')).map(([,v]) => JSON.parse(v)).flat())
    assert.equal(records[0].status, 'awaiting_wallet'); assert.equal(records[0].hash, undefined)
    await transactionStatus.getByText(/Approve within at most/).waitFor()
    assert.ok(Number(decodeFunctionData({ abi: p.EXECUTE_ABI, data: records[0].review.transaction.data }).args[2]) * 1000 > records[0].review.expiresAt)
    await page.clock.fastForward(45000)
    await transactionStatus.getByText('Awaiting wallet confirmation', { exact: true }).waitFor()
    await page.evaluate(() => window.executionUiTest.release()); await transactionStatus.getByText('Pending — waiting for Arc', { exact: true }).waitFor()
    const state = await cacheWallet(); await page.getByRole('link', { name: /View on Arc Explorer/ }).filter({ hasText: state.hash }).waitFor()
  })
  await test('reload resumes pending transaction from localStorage without signing or resending', async () => {
    await page.reload(); await page.evaluate(() => window.executionUiTest.connect(5042))
    await transactionStatus.getByText('Pending — waiting for Arc', { exact: true }).waitFor(); assert.equal(await sends(), 0)
  })
  await test('the pending transaction survives direction and provider changes; rechecks are read-only; other wallets keep their records visible', async () => {
    const before = await sends(), latest = transactionStatus
    await latest.waitFor(); await page.getByRole('button', { name: 'Reverse direction' }).click()
    await latest.getByRole('link', { name: /View on Arc Explorer/ }).waitFor(); assert.equal(await review.isDisabled(), true)
    await page.getByRole('button', { name: 'Reverse direction' }).click()
    await page.getByRole('radio', { name: 'Circle Swap Kit quote' }).click()
    await latest.getByRole('button', { name: 'Check transaction status' }).click()
    await transactionStatus.getByText('Pending — waiting for Arc', { exact: true }).waitFor(); assert.equal(await sends(), before)
    await page.evaluate(() => window.executionUiTest.account(true))
    // The other wallet is connected: the records of the first wallet stay readable (history is not tied to the connected wallet).
    await transactionStatus.getByText(/Wallet: 0xafbB6Cc5/).first().waitFor(); assert.equal(await review.isDisabled(), true)
    await page.evaluate(() => window.executionUiTest.account(false)); await latest.waitFor()
    await page.getByRole('radio', { name: 'Uniswap quote' }).click(); await amount.fill('0.1')
  })
  await test('verified successful receipt shows Confirmed and actual output, then refreshes native balance', async () => {
    const before = await page.evaluate(() => window.executionUiTest.state.balanceReads)
    receiptMode = 'confirmed'
    await transactionStatus.getByText('Confirmed', { exact: true }).waitFor(); await transactionStatus.getByText(/Received 0\.088565 EURC/).waitFor()
    await page.waitForFunction(n => window.executionUiTest.state.balanceReads > n, before)
    assert.equal(await sends(), 0)
  })
  await test('pilot EURC repeated review uses the same controller and a reverted receipt is Failed', async () => {
    receiptMode = 'pending'; await prepare('EURC')
    assert.equal(await review.isDisabled(), true) // the earlier confirmed swap never blocks a new review; an in-progress review blocks another
    await confirm.click()
    await transactionStatus.getByText('Pending — waiting for Arc', { exact: true }).waitFor(); await cacheWallet()
    receiptMode = 'reverted'
    await transactionStatus.getByText('Failed — transaction reverted', { exact: true }).waitFor(); assert.equal(await sends(), 1)
  })
  await test('wallet rejection is understandable and does not retry or expose provider errors', async () => {
    await page.evaluate(() => { window.executionUiTest.state.walletMode = 'reject' }); await prepare(); await confirm.click()
    await transactionStatus.getByText('Wallet request rejected', { exact: true }).waitFor()
    assert.equal((await page.locator('body').innerText()).includes('synthetic-private-error'), false); assert.equal(await sends(), 2)
  })
  await test('ambiguous wallet result stays blocked and supports read-only hash recovery after reload', async () => {
    receiptMode = 'pending'; await page.evaluate(() => { window.executionUiTest.state.walletMode = 'unknown' }); await prepare(); await confirm.click()
    await transactionStatus.getByText('Status not yet verified', { exact: true }).waitFor(); const state = await cacheWallet()
    assert.equal(await review.isDisabled(), true)
    await page.reload(); await page.evaluate(() => window.executionUiTest.connect(5042))
    await page.getByRole('textbox', { name: 'Recover transaction hash' }).fill(state.hash)
    await page.getByRole('button', { name: 'Verify and track hash' }).click()
    await transactionStatus.getByText('Pending — waiting for Arc', { exact: true }).waitFor(); assert.equal(await sends(), 0)
    receiptMode = 'confirmed'
    await transactionStatus.getByText('Confirmed', { exact: true }).waitFor()
  })
  await test('input and wallet network changes close an outstanding review without requesting a transaction', async () => {
    await prepare(); await page.getByRole('dialog').getByRole('button', { name: 'Cancel', exact: true }).click()
    await prepare(); await page.evaluate(() => window.executionUiTest.chain(1)); await page.getByRole('dialog').waitFor({ state: 'hidden' })
    assert.equal(await sends(), 0); await page.evaluate(() => window.executionUiTest.chain(5042))
    await prepare(); await page.evaluate(() => { const input = document.querySelector('input[aria-label="Swap amount"]'); const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; setter.call(input, '2'); input.dispatchEvent(new Event('input', { bubbles: true })) })
    await page.getByRole('dialog').waitFor({ state: 'hidden' }); assert.equal(await sends(), 0)
  })
  await test('failed router/balance preflight cannot open wallet approval', async () => {
    for (const mode of ['router', 'balance']) {
      rpcMode = mode; await amount.fill('0.1'); await review.click(); await page.getByRole('alert').filter({ hasText: 'could not be verified' }).waitFor()
      assert.equal(await sends(), 0)
    }
    rpcMode = 'normal'
  })
  await test('review summary and confirmation controls fit a mobile viewport without horizontal overflow', async () => {
    await page.setViewportSize({ width: 375, height: 812 }); await prepare()
    const bounds = await page.getByRole('dialog').boundingBox()
    assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= 375)
    assert.equal(await page.evaluate(() => document.querySelector('dialog').scrollWidth <= document.querySelector('dialog').clientWidth), true)
    await page.getByRole('dialog').getByRole('button', { name: 'Cancel', exact: true }).click()
    await page.setViewportSize({ width: 1280, height: 720 })
  })
  await test('wallet approval cutoff warns to cancel, blocks another request and tracks a late hash', async () => {
    receiptMode = 'pending'
    await page.evaluate(() => { window.executionUiTest.state.walletMode = 'held' })
    await prepare('EURC'); const before = await sends(); await confirm.click()
    await transactionStatus.getByText('Awaiting wallet confirmation', { exact: true }).waitFor()
    await page.clock.fastForward(121000)
    await transactionStatus.getByText('Status not yet verified', { exact: true }).waitFor()
    await page.getByRole('alert').filter({ hasText: 'The wallet approval window ended. Cancel the open request' }).waitFor()
    assert.equal(await review.isDisabled(), true); assert.equal(await sends(), before + 1)
    const records = await page.evaluate(() => Object.entries(localStorage).filter(([k]) => k.startsWith('machina.uniswap.arc.execution.v1:')).map(([,v]) => JSON.parse(v)).flat())
    assert.equal(records.at(-1).status, 'unknown')
    await page.evaluate(() => window.executionUiTest.release())
    await transactionStatus.getByText('Pending — waiting for Arc', { exact: true }).waitFor()
    const state = await cacheWallet()
    await page.getByRole('link', { name: /View on Arc Explorer/ }).filter({ hasText: state.hash }).waitFor()
    assert.equal(await sends(), before + 1)
    receiptMode = 'reverted'; await page.clock.fastForward(6000)
    await transactionStatus.getByText('Failed — transaction reverted', { exact: true }).waitFor()
    await page.evaluate(() => { window.executionUiTest.state.walletMode = 'hash' })
  })
  await test('expired review cannot confirm; Circle-only routes retain Preview and no execution button', async () => {
    await prepare(); await page.clock.fastForward(31000)
    assert.equal(await page.getByRole('button', { name: 'Review expired', exact: true }).isDisabled(), true)
    await page.getByRole('dialog').getByRole('button', { name: 'Cancel', exact: true }).click()
    await page.getByRole('combobox', { name: 'From token' }).selectOption('WETH')
    await page.getByText('Quotes only', { exact: true }).first().waitFor(); assert.equal(await review.isDisabled(), true)
  })
  await test('no unapproved RPC methods, external traffic, uncaught errors or source gate changes', async () => {
    assert.equal(external, 0); assert.deepEqual(errors, [])
    assert.equal(methods.some(m => /send|sign|approve|wallet_/i.test(m)), false)
    assert.match(readFileSync(`${root}src/lib/uniswapArcPolicy.ts`, 'utf8'), /export const UNISWAP_ARC_WRITES_ENABLED = true/)
  })
  console.log(`${count} Chromium execution UI groups PASS. Explicit test pilot configuration; synthetic API/RPC/wallet only. No real wallet request or broadcast.`)
} finally { await browser?.close(); await server.close() }
