// Unified Swap screen in real Chromium (React + wagmi mock connector + localStorage + Web Locks), the default (multi-direction) execution mode.
// Arc RPC, Circle estimator and wallet are controlled test doubles: quotes are simulated by the fake RPC, wallet sends are recorded and
// never broadcast. This verifies the product flows end to end; it is NOT live evidence and signs or sends nothing real.
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
const root = fileURLToPath(new URL('..', import.meta.url))
const p = require(`${root}src/lib/uniswapArcPolicy.ts`), e = require(`${root}src/lib/uniswapArcExecution.ts`), simulator = require(`${root}src/lib/swap/simulatorCode.ts`)
const tokens = require(`${root}src/lib/swap/tokens.ts`), pools = require(`${root}src/lib/swap/uniswapPools.ts`), adapter = require(`${root}src/lib/swap/circleAdapterDecode.ts`)
const viem = require('viem'), { toHex, decodeFunctionData, decodeAbiParameters, parseAbiParameters, encodeEventTopics, encodeAbiParameters, parseUnits, formatUnits } = viem
const { createFakeArcRpc } = await import(`${root}scripts/fixtures/swap/fake-arc-rpc.mjs`)
const fresh = require(`${root}scripts/fixtures/uniswap-arc/execution-review.cjs`)
const runtime = readFileSync(`${root}scripts/fixtures/uniswap-arc/router-runtime.hex`, 'utf8').trim()
const real = JSON.parse(readFileSync(`${root}scripts/fixtures/uniswap-arc/first-pilot-result.json`, 'utf8'))
const FIRST_HASH = '0x1a5e6d2db765c80787cc428163e6fc0defe2f329b594d775715371a1e5efa921'
const owner = '0xafbB6Cc5C0a9C0eB1BfF8dB2eD807e83aAB8e321'
const V3_INPUT = parseAbiParameters('address recipient,uint256 amountIn,uint256 amountOutMinimum,bytes path,bool payerIsUser,uint256[] minHopPriceX36')
const dec = { USDC: 6, EURC: 6, cirBTC: 8, WETH: 18 }
const AMOUNT = { USDC: '1', EURC: '1', cirBTC: '0.00001', WETH: '0.0003' }
// Execution state the scenarios drive. clockOffset follows the page's fake clock so Arc's block time and the device clock stay consistent.
const world = { receipts: new Map(), hidden: new Set(), walletAdjusts: false, rpcDown: new Set(), reads: [], errors: [], circleCalls: 0, circleBias: 99n, circleDelayMs: 0, external: 0, clockOffset: 0, blockSeq: 0 }
const rpc = createFakeArcRpc({ viem, policy: p, simulator, routerRuntime: runtime, now: () => Date.now() + world.clockOffset })
rpc.state.owner = owner; rpc.state.block = 27_300_000n; rpc.state.gasPrice = 20_000_000_000n // about Arc's real gas price (21.5 gwei in the first swap)
const FIRST_BLOCK = BigInt(real.eth_getTransactionReceipt.blockNumber)

const server = await createServer({ configFile: false, root, define: { 'import.meta.env.VITE_UNISWAP_ARC_PILOT_ENABLED': JSON.stringify('true'), 'import.meta.env.VITE_UNISWAP_ARC_PILOT_WALLET': JSON.stringify(owner) },
  cacheDir: `${root}.verification/vite-unified-ui`, server: { host: '127.0.0.1', port: 0 }, plugins: [{
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
    },
  }, {
    // TEST ONLY: replace the network-bound SDK and the adapter code-hash read with the fixture doubles. Circle's source gate is the real one (open in this build).
    name: 'circle-execution-test-doubles', enforce: 'pre', transform(code, id) {
      const file = id.split('?')[0]
      if (file === `${root}src/lib/swap/circleSdk.ts`) return code.replace('export const circleChainRpc =', 'const realCircleChainRpc =').replace('export function circleSdk(', 'function realCircleSdk(') +
        "\nimport { fakeCircleSdk, fakeCircleChainRpc } from '/scripts/fixtures/swap/circle-fake-sdk'\nexport const circleChainRpc = fakeCircleChainRpc(realCircleChainRpc)\nexport const circleSdk = fakeCircleSdk as never\nvoid realCircleSdk\n"
    },
  }, {
    name: 'unified-ui-harness', configureServer(server) {
      server.middlewares.use('/__swap_ui_test', async (_req, res) => {
        res.setHeader('Content-Type', 'text/html')
        res.end(await server.transformIndexHtml('/__swap_ui_test', '<!doctype html><html><body><div id="root"></div><script type="module" src="/scripts/fixtures/swap/unified-ui-harness.tsx"></script></body></html>'))
      })
    },
  }] })
await server.listen()
const base = `http://127.0.0.1:${server.httpServer.address().port}`
let browser, page, count = 0
const errors = [], methods = []
async function test(name, fn) {
  try { await fn(); count++; console.log(`PASS ${name}`) }
  catch (error) { console.error('Diagnostics:', (await page.locator('body').innerText()).slice(0, 1800), '\nRPC errors:', world.errors.slice(-6), '\nRecent reads:', world.reads.slice(-4).map(r => r.method)); throw error }
}

// ---- helpers that turn the wallet's recorded sends into chain data -------------------------------------------------------------------
const lc = value => String(value).toLowerCase()
function receiptLogs(tx, hash, blockHash, blockNumber) {
  const router = p.sameAddress(tx.to, p.ARC_ROUTER)
  const transfer = (address, from, to, value, logIndex) => ({ address, topics: encodeEventTopics({ abi: [{ type: 'event', name: 'Transfer', inputs: [{ name: 'from', type: 'address', indexed: true }, { name: 'to', type: 'address', indexed: true }, { name: 'value', type: 'uint256', indexed: false }] }], eventName: 'Transfer', args: { from, to } }),
    data: encodeAbiParameters(parseAbiParameters('uint256'), [value]), blockNumber: toHex(blockNumber), transactionHash: hash, transactionIndex: '0x0', blockHash, logIndex: toHex(logIndex), removed: false })
  if (p.sameAddress(tx.to, adapter.CIRCLE_ADAPTER)) {
    // Circle adapter swap: the input leaves the wallet for the adapter, the output comes back (a little above the reviewed minimum).
    const call = adapter.decodeAdapterExecute(tx.data).call, swap = call.instructions.find(i => i.tokenOut !== '0x0000000000000000000000000000000000000000'), input = call.tokenInputs[0]
    const out = swap.minTokenOut * 1005n / 1000n, adapterAddress = adapter.CIRCLE_ADAPTER
    return [transfer(input.token, owner, adapterAddress, input.amount, 0), transfer(swap.tokenOut, adapterAddress, owner, out, 1)]
  }
  if (!router) return []
  const outer = decodeFunctionData({ abi: p.EXECUTE_ABI, data: tx.data }), swap = decodeAbiParameters(V3_INPUT, outer.args[1][0]), path = swap[3], hops = (path.length - 2 - 40) / 46
  const symbolOf = a => rpc.symbolOf(a), fees = []
  for (let i = 0; i < hops; i++) fees.push(parseInt(path.slice(2 + 40 + i * 46, 2 + 40 + i * 46 + 6), 16))
  const symbolIn = symbolOf(`0x${path.slice(2, 42)}`), symbolOut = symbolOf(`0x${path.slice(path.length - 40)}`), out = rpc.quoteOut(symbolIn, symbolOut, swap[1], fees)
  const POOL = '0x6fd5F2fb831940DcD61A98c5B3aCB7D8C6f3bFc1', NATIVE = '0xfffffffffffffffffffffffffffffffffffffffe', logs = []
  logs.push(symbolIn === 'USDC' ? transfer(NATIVE, owner, p.ARC_ROUTER, swap[1] * 10n ** 12n, 0) : transfer(p.ARC_TOKENS[symbolIn].address, owner, POOL, swap[1], 0))
  logs.push(transfer(p.ARC_TOKENS[symbolOut].address, POOL, owner, out, 1))
  if (symbolOut === 'USDC') logs.push(transfer(NATIVE, POOL, owner, out * 10n ** 12n, 2))
  return logs
}
function applyApproval(tx) {
  const approval = require(`${root}src/lib/swap/uniswapApprovals.ts`).decodeApprovalTransaction({ to: tx.to, data: tx.data, value: tx.value })
  if (!approval) return
  if (approval.kind === 'token') rpc.state.tokenAllowance[approval.token] = BigInt(approval.amount)
  else rpc.state.permit[approval.token] = { amount: BigInt(approval.amount), expiration: approval.expiration }
}
async function syncWalletSends() {
  const sent = await page.evaluate(() => window.swapUiTest.state.sent)
  for (const { tx, hash } of sent) if (!world.receipts.has(lc(hash))) world.receipts.set(lc(hash), { tx, hash, mode: 'pending', adjusted: world.walletAdjusts, sentAt: Date.now() + world.clockOffset })
}
function chainFor(hash) {
  const entry = world.receipts.get(lc(hash)); if (!entry) return null
  const { tx, mode, adjusted } = entry, pending = mode === 'pending', blockNumber = entry.block ?? rpc.state.block - 5n
  const maxFee = adjusted ? 28_500_000_000n : BigInt(tx.maxFeePerGas), tip = adjusted ? 1_500_000_000n : BigInt(tx.maxPriorityFeePerGas)
  const chainTx = { value: '0x0', ...tx, hash, input: tx.data, chainId: '0x13b2', blockHash: pending ? null : rpc.BLOCK_HASH, blockNumber: pending ? null : toHex(blockNumber), transactionIndex: pending ? null : '0x0', type: '0x2', accessList: [],
    maxFeePerGas: toHex(maxFee), maxPriorityFeePerGas: toHex(tip), gasPrice: toHex(maxFee), v: '0x0', r: `0x${'1'.repeat(64)}`, s: `0x${'2'.repeat(64)}`, yParity: '0x0' }
  if (pending) return { tx: chainTx, receipt: null }
  const gasUsed = 150_000n, receipt = { transactionHash: hash, from: owner, to: tx.to, blockNumber: toHex(blockNumber), blockHash: rpc.BLOCK_HASH, transactionIndex: '0x0', gasUsed: toHex(gasUsed), cumulativeGasUsed: toHex(gasUsed),
    effectiveGasPrice: toHex(adjusted ? 21_500_000_000n : rpc.state.gasPrice), status: mode === 'reverted' ? '0x0' : '0x1', type: '0x2', logsBloom: `0x${'0'.repeat(512)}`, contractAddress: null,
    logs: mode === 'reverted' ? [] : receiptLogs(tx, hash, rpc.BLOCK_HASH, blockNumber) }
  return { tx: chainTx, receipt }
}
function setReceipt(hash, mode) { const entry = world.receipts.get(lc(hash)); entry.mode = mode; if (mode !== 'pending' && !entry.block) { entry.block = rpc.state.block - 5n - BigInt(++world.blockSeq); rpc.state.blockTimes.set(entry.block, BigInt(Math.floor(entry.sentAt / 1000) + 3)) } if (mode === 'success' && !entry.applied) { entry.applied = true; applyApproval(entry.tx) } }
const lastSent = async () => (await page.evaluate(() => window.swapUiTest.state.sent)).at(-1)

// ---- the first real swap, as recorded from Arc RPC ----------------------------------------------------------------------------------
const firstBlock = real.eth_getBlockByNumber
function firstSwapResponse(method) {
  if (method === 'eth_getTransactionByHash') return real.eth_getTransactionByHash
  return real.eth_getTransactionReceipt
}

try {
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? '/usr/bin/chromium', headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] })
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } }); page = await context.newPage(); page.setDefaultTimeout(20000)
  page.on('pageerror', error => errors.push(error.message))
  await page.route('**/*', async route => {
    const request = route.request(), url = request.url()
    if (new URL(url).pathname === '/__circle_quote' && url.startsWith(base)) {
      world.circleCalls++; const input = request.postDataJSON(), units = parseUnits(input.amount, dec[input.tokenIn])
      const delay = world.circleDelayMs
      if (delay) await new Promise(resolve => setTimeout(resolve, delay))
      const out = rpc.quoteOut(input.tokenIn, input.tokenOut, units, [3000]) * world.circleBias / 100n, minimum = p.minimumAtSlippage(out, input.slippageBps)
      return route.fulfill({ json: { tokenIn: input.tokenIn, tokenOut: input.tokenOut, amountIn: input.amount, chain: 'Arc', chainIn: 'Arc', chainOut: 'Arc', fromAddress: input.address, toAddress: input.address,
        estimatedOutput: { token: input.tokenOut, amount: formatUnits(out, dec[input.tokenOut]) }, stopLimit: { token: input.tokenOut, amount: formatUnits(minimum, dec[input.tokenOut]) }, fees: [{ type: 'provider', token: input.tokenIn, amount: '0.0002' }, { type: 'gas', token: 'USDC', amount: '0.0218' }] } })
    }
    if (url.startsWith(base + '/')) return route.continue()
    if (url.startsWith('https://fonts.googleapis.com/')) return route.fulfill({ contentType: 'text/css', body: '' })
    if (url !== 'https://rpc.mainnet.arc.io/') { world.external++; return route.abort() }
    const body = request.postDataJSON(), { method, params } = body; methods.push(method)
    if (world.rpcDown.has('everything')) return route.fulfill({ status: 503, body: 'down' })
    try {
      if (method === 'eth_getTransactionByHash' || method === 'eth_getTransactionReceipt') {
        world.reads.push({ method, hash: params[0], at: Date.now() })
        if (world.rpcDown.has(method) || world.rpcDown.has('all')) return route.fulfill({ status: 503, body: 'down' })
        if (lc(params[0]) === FIRST_HASH) return route.fulfill({ json: { jsonrpc: '2.0', id: body.id, result: firstSwapResponse(method) } })
        await syncWalletSends(); const chain = world.hidden.has(lc(params[0])) ? null : chainFor(params[0]) // `hidden`: a hash this node has never seen
        return route.fulfill({ json: { jsonrpc: '2.0', id: body.id, result: chain ? (method === 'eth_getTransactionByHash' ? chain.tx : chain.receipt) : null } })
      }
      if (method === 'eth_getBlockByNumber' && typeof params[0] === 'string' && BigInt(params[0] === 'latest' ? 0 : params[0]) === FIRST_BLOCK) return route.fulfill({ json: { jsonrpc: '2.0', id: body.id, result: firstBlock } })
            return route.fulfill({ json: { jsonrpc: '2.0', id: body.id, result: rpc.handle(method, params) } })
    } catch (error) {
      const revert = error?.code === 3
      if (!revert) world.errors.push(`${method}: ${error.message}`)
      return route.fulfill({ json: { jsonrpc: '2.0', id: body.id, error: revert ? { code: 3, message: 'execution reverted' } : { code: -32603, message: String(error.message) } } })
    }
  })
  await page.goto(base + '/__swap_ui_test')
  const amount = page.getByRole('textbox', { name: 'Swap amount' }), review = page.locator('#review-swap'), confirm = page.getByRole('button', { name: 'Confirm Swap', exact: true })
  const latest = page.getByRole('article', { name: 'Latest transaction' }), uniCard = page.getByRole('radio', { name: 'Uniswap quote' }), circleCard = page.getByRole('radio', { name: 'Circle Swap Kit quote' })
  const sends = () => page.evaluate(() => window.swapUiTest.state.sent.length)
  // A nudge to the status check. Once a result is final the Check status button is gone (nothing is left to check), and the automatic check may already have finished.
  const recheck = async () => { try { await page.getByRole('button', { name: 'Check status' }).first().click({ timeout: 4000 }) } catch { /* settled already */ } }
  const pick = async (from, to) => { await page.getByRole('combobox', { name: 'From token' }).selectOption(from); await page.getByRole('combobox', { name: 'To token' }).selectOption(to) }
  const quoted = async () => { await uniCard.getByText(/Minimum/).waitFor(); await circleCard.getByText(/Minimum/).waitFor() }
  // Runs the page's (fake) timers in small steps so each automatic status lookup can finish before the next timer is due.
  const advanceClock = async (total, step = 2500) => { for (let done = 0; done < total; done += step) { await page.clock.runFor(step); world.clockOffset += step; await page.waitForTimeout(60) } }
  const becomesEnabled = async () => { for (let i = 0; i < 60; i++) { if (await review.isEnabled()) return true; await page.waitForTimeout(100) } return false }
  const shot = async name => { if (process.env.SWAP_UI_SHOTS) await page.screenshot({ path: `${process.env.SWAP_UI_SHOTS}/${name}.png`, fullPage: true }) }
  const bumpNonce = () => page.evaluate(() => { window.swapUiTest.state.walletNonce += 1 })
  const syncNonce = async () => { const n = await page.evaluate(() => window.swapUiTest.state.walletNonce); rpc.state.nonce = { latest: n, pending: n } }
  await syncNonce()

  await test('the mode chip depends on the route and the build, not on whether an amount was typed; both providers are always offered', async () => {
    await page.getByRole('heading', { name: 'Swap', exact: true }).waitFor()
    assert.equal(await page.getByLabel('Swap mode').innerText(), 'Live swap'); assert.equal(await amount.inputValue(), '')
    await circleCard.click(); assert.equal(await page.getByLabel('Swap mode').innerText(), 'Live swap'); await uniCard.click(); assert.equal(await page.getByLabel('Swap mode').innerText(), 'Live swap')
    assert.equal(await page.getByText('Preview only', { exact: true }).count(), 0)
    await page.evaluate(() => window.swapUiTest.connect(5042)); assert.equal(await page.getByLabel('Swap mode').innerText(), 'Live swap')
    assert.equal(await page.getByLabel('Swap activity', { exact: true }).evaluate(node => node.open), false)
    assert.equal(await page.getByLabel('Swap details', { exact: true }).evaluate(node => node.open), false)
    assert.equal(await page.getByRole('region', { name: 'Token approvals' }).count(), 0)
  })

  await test('all 12 directions quote in both providers; the better price is tagged, the other stays selectable, and no provider is switched silently', async () => {
    const seen = new Set()
    for (const { tokenIn, tokenOut } of tokens.SWAP_DIRECTIONS) {
      await pick(tokenIn, tokenOut); await amount.fill(''); await amount.fill(AMOUNT[tokenIn]); await quoted()
      assert.equal(await page.getByRole('combobox', { name: 'From token' }).inputValue(), tokenIn); assert.equal(await page.getByRole('combobox', { name: 'To token' }).inputValue(), tokenOut)
      const units = parseUnits(AMOUNT[tokenIn], dec[tokenIn]), routes = pools.candidateRoutes(tokenIn, tokenOut)
      const best = routes.map(r => rpc.quoteOut(tokenIn, tokenOut, units, r.hops.map(h => h.fee))).reduce((m, x) => (x > m ? x : m))
      const shown = await page.getByLabel('Estimated receive').getAttribute('title'); assert.equal(shown, `${formatUnits(best, dec[tokenOut])} ${tokenOut}`, `${tokenIn}>${tokenOut}`)
      assert.equal(await uniCard.getAttribute('aria-checked'), 'true') // still the provider the user chose
      assert.equal(await page.getByText('Best price', { exact: true }).count(), 1)
      seen.add(`${tokenIn}>${tokenOut}`)
    }
    assert.equal(seen.size, 12)
    world.circleBias = 105n; await pick('EURC', 'USDC'); await amount.fill(''); await amount.fill('1'); await quoted()
    assert.ok(await circleCard.getByText('Best price', { exact: true }).count()); assert.equal(await uniCard.getByText('Best price', { exact: true }).count(), 0)
    assert.equal(await uniCard.getAttribute('aria-checked'), 'true'); world.circleBias = 99n
    await shot('quotes-desktop')
    await page.setViewportSize({ width: 390, height: 844 }); await shot('quotes-mobile')
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth))
    await page.setViewportSize({ width: 1280, height: 900 })
  })

  await test('a slow obsolete Circle quote releases its single SDK slot for the newest edit without extra service calls or wallet requests', async () => {
    await pick('USDC', 'EURC'); await amount.fill(''); await page.waitForTimeout(100)
    const before = world.circleCalls, sent = await sends()
    world.circleDelayMs = 3500; await amount.fill('0.1')
    for (let i = 0; i < 70 && world.circleCalls === before; i++) await page.waitForTimeout(50)
    assert.equal(world.circleCalls, before + 1)
    world.circleDelayMs = 0; await amount.fill('0.2'); await quoted()
    const expected = rpc.quoteOut('USDC', 'EURC', parseUnits('0.2', 6), [3000]) * world.circleBias / 100n
    assert.equal(await circleCard.locator('[title]').first().getAttribute('title'), `${formatUnits(expected, 6)} EURC`)
    assert.equal(world.circleCalls, before + 2); assert.equal(await sends(), sent)
    assert.equal(await page.getByText(/previous quote request is still finishing/).count(), 0)
  })

  await test('the route support panel tells the truth for the selected pair in plain words: route, approvals, availability; the precise findings and what has been proven live sit in each provider\'s Technical details', async () => {
    await page.getByLabel('Swap details', { exact: true }).locator(':scope > summary').click()
    await pick('EURC', 'cirBTC'); const details = page.getByLabel('Route support'); await details.locator(':scope > summary').click()
    const uni = details.getByRole('region', { name: 'Uniswap support' }), circ = details.getByRole('region', { name: 'Circle Swap Kit support' })
    const opened = async () => { await page.evaluate(() => document.querySelectorAll('[aria-label="Route support"] details').forEach(node => { node.open = true })) }
    await uni.getByText(/EURC → USDC \(0\.05%\) → cirBTC \(0\.01%\)/).waitFor(); await uni.getByText(/Two one-time permissions for exactly the amount you swap/).waitFor(); await uni.getByText('Yes', { exact: true }).waitFor()
    await circ.getByText(/One approval for exactly the amount you swap, then the swap\./).waitFor(); await circ.getByText('Yes', { exact: true }).waitFor()
    await opened(); await uni.getByText(/None yet by this application\. The route was only simulated/).waitFor(); await circ.getByText(/Real swaps on this direction by other wallets are on chain/).waitFor()
    await uni.getByText(/Available \(any wallet, up to the per-swap ceiling\)/).waitFor(); await circ.getByText(/Available \(any wallet, up to the per-swap ceiling\)/).waitFor()
    await pick('USDC', 'EURC'); await uni.getByText(/No approval needed: USDC is sent directly with the swap/).waitFor(); await circ.getByText(/One signature \(no fee\) that allows exactly the amount you swap, then the swap\./).waitFor()
    await opened(); await uni.getByText(/one real swap \(0x1a5e…a921\)/).waitFor()
    await pick('USDC', 'WETH'); await opened(); await circ.getByText(/no real swap of this direction was found among the decoded fixtures/).waitFor(); await details.locator(':scope > summary').click()
    await page.getByLabel('Swap details', { exact: true }).locator(':scope > summary').click()
  })

  await test('any token can be paired with any other; choosing the other side token exchanges the sides; the amount clears only when the input token changes', async () => {
    await pick('USDC', 'EURC'); await amount.fill('1')
    await page.getByRole('combobox', { name: 'To token' }).selectOption('cirBTC'); assert.equal(await amount.inputValue(), '1')
    await page.getByRole('combobox', { name: 'To token' }).selectOption('USDC')
    assert.equal(await page.getByRole('combobox', { name: 'From token' }).inputValue(), 'cirBTC'); assert.equal(await page.getByRole('combobox', { name: 'To token' }).inputValue(), 'USDC'); assert.equal(await amount.inputValue(), '')
    await page.getByRole('button', { name: 'Reverse direction' }).click()
    assert.equal(await page.getByRole('combobox', { name: 'From token' }).inputValue(), 'USDC'); assert.equal(await page.getByRole('combobox', { name: 'To token' }).inputValue(), 'cirBTC')
  })

  await test('balance shortcuts use real balances for every token, keep the gas reserve for native USDC and respect the per-swap ceiling', async () => {
    const shortcut = async name => { await page.getByRole('button', { name, exact: true }).click(); await page.waitForTimeout(150) }
    await pick('EURC', 'USDC'); await amount.fill(''); await shortcut('25%'); assert.equal(await amount.inputValue(), '9') // 12.5 EURC held-25%, limited to the 9 EURC ceiling
    await pick('WETH', 'USDC'); await shortcut('25%'); assert.equal(await amount.inputValue(), '0.004') // 0.25 WETH, limited to 0.004 WETH
    await pick('cirBTC', 'USDC'); await amount.fill(''); await shortcut('MAX'); assert.equal(await amount.inputValue(), '0.00012')
    await page.evaluate(() => { window.swapUiTest.state.balances.cirBTC = 5000n }); await amount.fill(''); await shortcut('50%'); assert.equal(await amount.inputValue(), '0.000025')
    await page.evaluate(() => { window.swapUiTest.state.balances.cirBTC = 10_000_000n })
    await pick('USDC', 'EURC'); await amount.fill(''); await shortcut('MAX'); assert.equal(await amount.inputValue(), '10') // 100 USDC held, 0.1 reserved, limited to the 10 USDC ceiling
    await page.evaluate(() => { window.swapUiTest.state.nativeBalance = 5n * 10n ** 18n }); await amount.fill(''); await shortcut('MAX'); assert.equal(await amount.inputValue(), '4.9')
    await page.evaluate(() => { window.swapUiTest.state.nativeBalance = 10n ** 17n }); await amount.fill(''); await shortcut('MAX'); await page.getByText(/cannot cover the reserved network fee/).waitFor()
    await page.evaluate(() => { window.swapUiTest.state.nativeBalance = 100n * 10n ** 18n })
  })

  await test('native USDC to cirBTC: Review shows the route and limits, the wallet receives exactly the reviewed transaction, and the result reads Swap completed with real amounts', async () => {
    await pick('USDC', 'cirBTC'); await amount.fill('1'); await quoted()
    const before = await sends(); await review.click(); await page.getByRole('dialog').waitFor()
    assert.equal(await page.getByRole('button', { name: '↻ Refresh quotes', exact: true }).isDisabled(), true)
    const dialog = page.getByRole('dialog'); await dialog.getByText('USDC → cirBTC (0.01%)', { exact: true }).waitFor(); await dialog.getByText('Most USDC you could spend', { exact: true }).waitFor(); await dialog.getByText('Minimum you receive', { exact: true }).waitFor(); await dialog.getByText('Network fee (maximum)', { exact: true }).waitFor()
    await dialog.getByText(/no fee is taken by anyone else/).waitFor(); assert.equal(await dialog.getByText('Fee to another address').count(), 0); assert.doesNotMatch(await dialog.innerText(), /calldata|TAKE_PORTION|SWEEP|V4_SWAP|Universal Router|Permit2/i) // the plain Review shows every fee and the minimum, no jargon; assert.equal(await sends(), before)
    await confirm.click(); await latest.getByText('Verifying transaction', { exact: true }).waitFor()
    const sent = await lastSent(); assert.equal(await sends(), before + 1)
    assert.ok(p.sameAddress(sent.tx.to, p.ARC_ROUTER)); assert.equal(sent.tx.value, toHex(10n ** 18n)); assert.equal(sent.tx.type, '0x2'); assert.equal(sent.tx.chainId, '0x13b2'); assert.equal(sent.tx.maxPriorityFeePerGas, '0x0')
    const decoded = decodeFunctionData({ abi: p.EXECUTE_ABI, data: sent.tx.data }); assert.equal(decoded.args[0], '0x0004') // native input: V3 swap then sweep
    await syncWalletSends(); setReceipt(sent.hash, 'success'); await recheck()
    await latest.getByText('Swap completed', { exact: true }).waitFor(); assert.equal(await latest.getByRole('note').count(), 0) // verified against the Review: no warning
    await latest.getByText(new RegExp(`Paid 1 USDC · Received ${formatUnits(rpc.quoteOut('USDC', 'cirBTC', 1_000_000n, [100]), 8).replace('.', '\\.')} cirBTC`)).waitFor(); await latest.getByText(/Network fee 0\.003 USDC/).waitFor()
    await bumpNonce(); await syncNonce()
  })

  await test('a wallet that adds its own priority fee completes with the adjustment noted in plain words, because the approved fee ceiling still holds', async () => {
    world.walletAdjusts = true
    await pick('USDC', 'EURC'); await amount.fill('1'); await quoted(); await review.click(); await confirm.click()
    await latest.getByText('Verifying transaction', { exact: true }).waitFor(); const sent = await lastSent(); await syncWalletSends(); setReceipt(sent.hash, 'success')
    await recheck(); await latest.getByText('Swap completed', { exact: true }).waitFor()
    await latest.getByText(/wallet adjusted the network fee slightly; it stayed within the maximum you approved/).waitFor(); assert.equal(await latest.getByRole('note').count(), 0); world.walletAdjusts = false; await bumpNonce(); await syncNonce()
  })

  await test('ERC-20 input: both exact approvals are reviewed and confirmed separately, then the swap runs; nothing is unlimited and nothing else is signed', async () => {
    await pick('EURC', 'USDC'); await amount.fill('1'); await quoted()
    const panel = page.getByRole('region', { name: 'Token approvals' });
    await page.getByRole('button', { name: 'Approve EURC · 2 steps' }).waitFor(); const before = await sends()
    assert.equal(await panel.count(), 0, 'no separate approval panel on the form')
    await review.click(); await panel.getByText('Let Uniswap use exactly 1 EURC').first().waitFor()
    await panel.getByText('1 EURC (exact)').waitFor(); assert.ok((await panel.textContent()).includes(`Allowed spender: ${p.ARC_PERMIT2}`)); assert.equal(await sends(), before) // the spender is in the closed Technical details
    await panel.getByRole('button', { name: 'Confirm approval' }).click(); await latest.getByText('Verifying approval', { exact: false }).waitFor()
    let sent = await lastSent(); assert.ok(p.sameAddress(sent.tx.to, p.ARC_TOKENS.EURC.address)); assert.equal(sent.tx.value, '0x0')
    const approval1 = decodeFunctionData({ abi: viem.parseAbi(['function approve(address spender, uint256 amount)']), data: sent.tx.data }); assert.ok(p.sameAddress(approval1.args[0], p.ARC_PERMIT2)); assert.equal(approval1.args[1], 1_000_000n)
    assert.equal(await review.isDisabled(), true) // an unresolved approval blocks a new swap
    await syncWalletSends(); setReceipt(sent.hash, 'success'); await recheck()
    await latest.getByText('Approval completed', { exact: true }).waitFor(); await bumpNonce(); await syncNonce()
    await page.getByRole('button', { name: 'Approve EURC · 1 step' }).waitFor(); await review.click()
    await panel.getByText(/Let the Uniswap router use exactly 1 EURC for 15 minutes/).first().waitFor(); await panel.getByRole('button', { name: 'Confirm approval' }).click()
    await latest.getByText('Verifying approval', { exact: false }).waitFor(); sent = await lastSent(); assert.ok(p.sameAddress(sent.tx.to, p.ARC_PERMIT2))
    const approval2 = decodeFunctionData({ abi: viem.parseAbi(['function approve(address token, address spender, uint160 amount, uint48 expiration)']), data: sent.tx.data })
    assert.ok(p.sameAddress(approval2.args[1], p.ARC_ROUTER)); assert.equal(approval2.args[2], 1_000_000n); await syncWalletSends(); setReceipt(sent.hash, 'success')
    await recheck(); await page.getByRole('button', { name: 'Review Swap', exact: true }).waitFor(); await bumpNonce(); await syncNonce()
    assert.equal(await becomesEnabled(), true); await review.click(); await page.getByRole('dialog').getByText(/Your exact approvals are already in place/).waitFor()
    await confirm.click(); await latest.getByText('Verifying transaction', { exact: true }).waitFor(); sent = await lastSent(); assert.equal(sent.tx.value, '0x0')
    assert.equal(decodeFunctionData({ abi: p.EXECUTE_ABI, data: sent.tx.data }).args[0], '0x00')
    await syncWalletSends(); setReceipt(sent.hash, 'success'); await recheck()
    await latest.getByText('Swap completed', { exact: true }).waitFor(); await latest.getByText(/Paid 1 EURC · Received 1\.1192 USDC|Paid 1 EURC · Received 1\.119/).waitFor()
    const history = page.getByLabel('Swap history'); await history.getByText(/earlier swaps?/).first().waitFor(); assert.equal(await history.locator('article').filter({ visible: true }).count(), 0) // earlier swaps are a closed list of short summaries; await bumpNonce(); await syncNonce()
    const wallet = await page.evaluate(() => window.swapUiTest.state.requests.map(r => r.method))
    assert.equal(wallet.some(m => /sign|typedData|wallet_|permit/i.test(m)), false)
  })

  await test('all 12 directions can be reviewed, sent and shown as Swap completed with the exact received and paid amounts (approvals already in place for ERC-20 inputs)', async () => {
    for (const symbol of ['EURC', 'cirBTC', 'WETH']) {
      const need = p.tokenUnits(AMOUNT[symbol], dec[symbol]); rpc.state.tokenAllowance[symbol] = need * 100n; rpc.state.permit[symbol] = { amount: need * 100n, expiration: Math.floor(Date.now() / 1000) + 3600 }
    }
    for (const { tokenIn, tokenOut } of tokens.SWAP_DIRECTIONS) {
      await pick(tokenIn, tokenOut); await amount.fill(''); await amount.fill(AMOUNT[tokenIn]); await quoted()
      await page.getByRole('button', { name: 'Review Swap', exact: true }).waitFor()
      const before = await sends(); await review.click(); await confirm.waitFor(); const reviewed = await page.getByRole('dialog').innerText()
      const units = parseUnits(AMOUNT[tokenIn], dec[tokenIn]), routes = pools.candidateRoutes(tokenIn, tokenOut)
      const best = routes.map(r => ({ r, out: rpc.quoteOut(tokenIn, tokenOut, units, r.hops.map(h => h.fee)) })).sort((a, b) => (b.out > a.out ? 1 : -1))[0]
      assert.ok(reviewed.includes(pools.describeRoute(best.r)), `${tokenIn}>${tokenOut} route ${pools.describeRoute(best.r)}`); assert.ok(reviewed.includes(`${formatUnits(best.out, dec[tokenOut])} ${tokenOut}`))
      await confirm.click(); await latest.getByText('Verifying transaction', { exact: true }).waitFor(); assert.equal(await sends(), before + 1)
      const sent = await lastSent(); assert.equal(BigInt(sent.tx.value), tokenIn === 'USDC' ? units * 10n ** 12n : 0n)
      await syncWalletSends(); setReceipt(sent.hash, 'success'); await recheck()
      await latest.getByText('Swap completed', { exact: true }).waitFor(); await latest.getByText(new RegExp(`Paid ${AMOUNT[tokenIn].replace('.', '\\.')} ${tokenIn} · Received ${formatUnits(best.out, dec[tokenOut]).replace('.', '\\.')} ${tokenOut}`)).waitFor()
      await bumpNonce(); await syncNonce()
    }
  })

  await test('Circle Swap Kit (test doubles for the SDK only): an exact approval and the adapter swap, each confirmed in the app first and then in the wallet, verified from the chain', async () => {
    await pick('EURC', 'USDC'); await amount.fill(''); await amount.fill('1'); await quoted(); await circleCard.click(); await circleCard.getByText(/Minimum/).waitFor()
    assert.equal(await page.getByLabel('Swap mode').innerText(), 'Live swap'); assert.equal(await review.isEnabled(), true)
    const before = await sends(); await review.click(); const dialog = page.getByRole('dialog'); await dialog.getByText('Review Circle swap').waitFor()
    await dialog.getByText('Circle fee', { exact: true }).waitFor(); await dialog.getByText('Minimum you receive', { exact: true }).waitFor(); await dialog.getByText('Network fee (maximum, all steps)', { exact: true }).waitFor(); assert.doesNotMatch(await dialog.innerText(), /calldata|adapter|execute|ERC-1967/i)
    await dialog.getByText(/Approve exactly this EURC amount for Circle/).first().waitFor(); assert.equal(await sends(), before)
    await dialog.getByRole('button', { name: 'Confirm Swap' }).click(); await dialog.getByText(/Step 1 of 2: Approve exactly this EURC amount/).waitFor(); assert.equal(await sends(), before) // nothing reaches the wallet before the step is confirmed
    await dialog.getByRole('button', { name: 'Continue to wallet' }).click(); await latest.getByLabel('Wallet steps').getByText(/Approval: verifying/).waitFor(); assert.equal(await sends(), before + 1)
    const approve = await lastSent(); assert.ok(p.sameAddress(approve.tx.to, p.ARC_TOKENS.EURC.address)); assert.equal(adapter.decodeApprove(approve.tx.data).amount, 1_000_000n); assert.ok(p.sameAddress(adapter.decodeApprove(approve.tx.data).spender, adapter.CIRCLE_ADAPTER))
    assert.equal(await dialog.getByText(/Step 2 of 2/).count(), 0) // the swap is not asked for until the approval is mined
    await syncWalletSends(); setReceipt(approve.hash, 'success'); await bumpNonce(); await syncNonce()
    await dialog.getByText(/Step 2 of 2: Send the swap/).waitFor()
    await dialog.getByRole('button', { name: 'Continue to wallet' }).click(); await latest.getByLabel('Wallet steps').getByText(/Swap transaction: verifying/).waitFor(); assert.equal(await sends(), before + 2)
    const swap = await lastSent(); assert.ok(p.sameAddress(swap.tx.to, adapter.CIRCLE_ADAPTER)); assert.equal(adapter.decodeAdapterExecute(swap.tx.data).ok, true)
    await latest.getByLabel('Wallet steps').getByText(/Approval: done/).waitFor(); await latest.getByText('Verifying transaction', { exact: true }).waitFor()
    await syncWalletSends(); setReceipt(swap.hash, 'success'); await recheck()
    await latest.getByText('Swap completed', { exact: true }).waitFor(); await latest.getByText(/Paid 1 EURC · Received /).waitFor()
    await latest.getByLabel('Wallet steps').getByText(/Approval: done/).waitFor(); await bumpNonce(); await syncNonce()
    const wallet = await page.evaluate(() => window.swapUiTest.state.requests.map(r => r.method)); assert.equal(wallet.some(m => /eth_sign$|personal_sign|wallet_/.test(m)), false)
  })

  await test('Circle USDC input uses a one-time permit signature (no approval transaction); a declined step stops the flow and nothing later is requested', async () => {
    await pick('USDC', 'EURC'); await amount.fill(''); await amount.fill('1'); await quoted(); await circleCard.click(); await circleCard.getByText(/Minimum/).waitFor()
    const before = await sends(), signs = () => page.evaluate(() => window.swapUiTest.state.signs.length), signsBefore = await signs()
    await review.click(); const dialog = page.getByRole('dialog'); await dialog.getByText(/Sign a one-time permission for exactly this USDC amount/).first().waitFor()
    await dialog.getByRole('button', { name: 'Confirm Swap' }).click(); await dialog.getByText(/Step 1 of 2: Sign a one-time permission/).waitFor()
    await dialog.getByRole('button', { name: 'Cancel' }).click(); await page.waitForTimeout(400); assert.equal(await sends(), before); assert.equal(await signs(), signsBefore) // declined in the app: the wallet was never contacted
    await review.click(); await dialog.getByRole('button', { name: 'Confirm Swap' }).click(); await dialog.getByText(/Step 1 of 2: Sign a one-time permission/).waitFor(); await dialog.getByRole('button', { name: 'Continue to wallet' }).click()
    await dialog.getByText(/Step 2 of 2: Send the swap/).waitFor(); assert.equal(await signs(), signsBefore + 1); assert.equal(await sends(), before) // the permit is a signature, not a transaction
    await dialog.getByRole('button', { name: 'Continue to wallet' }).click(); await latest.getByLabel('Wallet steps').getByText(/Swap transaction: verifying/).waitFor(); assert.equal(await sends(), before + 1)
    const swap = await lastSent(); assert.equal(swap.tx.value ?? '0x0', '0x0'); await syncWalletSends(); setReceipt(swap.hash, 'success'); await recheck()
    await latest.getByText('Swap completed', { exact: true }).waitFor(); await latest.getByText(/Paid 1 USDC · Received /).waitFor(); await bumpNonce(); await syncNonce()
  })

  await test('an unresolved Circle transaction holds a Uniswap swap of the same wallet (one wallet, one open transaction), and the other way round', async () => {
    await pick('USDC', 'EURC'); await amount.fill(''); await amount.fill('1'); await quoted(); await circleCard.click(); await circleCard.getByText(/Minimum/).waitFor()
    await review.click(); const dialog = page.getByRole('dialog'); await dialog.getByRole('button', { name: 'Confirm Swap' }).click(); await dialog.getByRole('button', { name: 'Continue to wallet' }).click()
    await dialog.getByText(/Step 2 of 2/).waitFor(); await dialog.getByRole('button', { name: 'Continue to wallet' }).click(); await latest.getByLabel('Wallet steps').getByText(/Swap transaction: verifying/).waitFor()
    await uniCard.click(); await uniCard.getByText(/Minimum/).waitFor(); assert.equal(await review.isDisabled(), true)
    const swap = await lastSent(); await syncWalletSends(); setReceipt(swap.hash, 'success'); await recheck(); await latest.getByText('Swap completed', { exact: true }).waitFor()
    await bumpNonce(); await syncNonce(); const enabled = await becomesEnabled()
    assert.equal(enabled, true)
    // And the other way round: an unresolved Uniswap swap holds a Circle swap.
    await review.click(); await confirm.click(); await latest.getByText('Verifying transaction', { exact: true }).waitFor(); await circleCard.click(); await circleCard.getByText(/Minimum/).waitFor()
    assert.equal(await review.isDisabled(), true); await page.getByText(/Another swap or approval from this wallet is still being verified/).waitFor()
    const uniswapSwap = await lastSent(); await syncWalletSends(); setReceipt(uniswapSwap.hash, 'success'); await recheck(); await latest.getByText('Swap completed', { exact: true }).waitFor()
    await bumpNonce(); await syncNonce(); assert.equal(await becomesEnabled(), true); await uniCard.click()
  })

  await test('the first real swap (0x1a5e…a921): completed on the chain with a plain warning that it differs from the stored Review (the 1.6% fee, the amounts); no program jargon on the screen; shown the same with or without a connected wallet', async () => {
    // The user's original Review record lives only in their browser and is not available here. This test stores a SYNTHETIC Review of the same
    // request (clearly not the original) and checks how the screen presents the real on-chain transaction against it.
    const request = p.validateArcRequest({ chainId: 5042, tokenIn: 'USDC', tokenOut: 'EURC', owner, recipient: owner, amount: '0.1', minimumOutput: '1', slippageBps: 100, maxNetworkFee: '100000000000000000' })
    const synthetic = e.tightenExecutionReview({ ...fresh(request), gasLimit: '182952', maxFeePerGas: '43000000000', networkFee: (182952n * 43_000_000_000n).toString() }, { owner, connected: true, chainId: 5042, connectorId: 'c' }, Date.now())
    const attempt = { id: crypto.randomUUID(), review: synthetic, nonce: 12, status: 'unknown', createdAt: Date.now() - 3_600_000, hash: FIRST_HASH }
    const key = `machina.uniswap.arc.execution.v1:${owner.toLowerCase()}`
    // Only this record remains in the (test) browser storage, so it is the latest one.
    await page.evaluate(([k, v]) => { for (const name of Object.keys(localStorage)) if (name.startsWith('machina.')) localStorage.removeItem(name); localStorage.setItem(k, v) }, [key, JSON.stringify([attempt])])
    await page.evaluate(() => window.swapUiTest.disconnect()); await page.reload(); await syncNonce()
    // No wallet connected: the record is still listed, with the status that was saved, and can be re-checked read-only.
    await latest.waitFor(); await latest.getByText('Verifying transaction', { exact: true }).waitFor(); assert.equal(await latest.getByText('Swap completed', { exact: true }).count(), 0) // the saved status was not yet verified
    const readsBefore = world.reads.length; await recheck()
    const headline = 'Swap completed'
    await latest.getByText(headline, { exact: true }).waitFor(); assert.ok(world.reads.length > readsBefore)
    await latest.getByText('This swap differs from your review', { exact: true }).waitFor(); await shot('first-swap-desktop')
    await latest.getByText(/A fee of 1\.6\d?% was taken from the amount you received\. It was not part of your review\./).waitFor()
    await latest.getByText(/Paid 0\.1 USDC · Received 0\.087854 EURC · Network fee 0\.003800899 USDC/).waitFor()
    const text = await latest.innerText(); assert.doesNotMatch(text, /calldata|TAKE_PORTION|PAY_PORTION|SWEEP|V4_SWAP|Blockchain transaction|Confirmed/i) // nothing technical on the normal screen
    assert.ok((await latest.getByRole('note').locator('li').count()) >= 1) // the differences are listed in plain words, not hidden
    assert.match(await latest.textContent(), /TAKE_PORTION/) // the raw findings stay available in the closed Technical details
    assert.equal(await latest.getByRole('button', { name: 'Try again' }).count(), 0) // a swap that happened is never offered again
    // The same with the wallet connected; a new swap is then allowed because a mismatch is terminal and proven.
    await page.evaluate(() => window.swapUiTest.connect(5042)); await latest.getByText(headline, { exact: true }).waitFor(); await pick('USDC', 'EURC'); await amount.fill('0.1'); await quoted()
    assert.equal(await review.isEnabled(), true)
    // Stored status stays visible and nothing polls forever: after the verdict there are no further automatic reads of this hash.
    const reads = world.reads.filter(r => lc(r.hash) === FIRST_HASH).length; await page.waitForTimeout(7000); assert.equal(world.reads.filter(r => lc(r.hash) === FIRST_HASH).length, reads)
    const record = await page.evaluate(k => JSON.parse(localStorage.getItem(k)), key)
    assert.equal(record[0].status, 'mismatch'); assert.equal(record[0].review.transaction.data, synthetic.transaction.data) // the stored Review is never rewritten
    assert.equal(record[0].chain.state, 'success'); assert.equal(record[0].intent.verdict, 'mismatch'); assert.ok(record[0].log.length >= 1)
    await page.evaluate(k => localStorage.removeItem(k), key)
  })

  await test('without any stored record, the first real swap can still be looked up by hash: chain facts are shown, the missing Review is stated, and nothing is called Confirmed', async () => {
    await page.evaluate(() => { for (const name of Object.keys(localStorage)) if (name.startsWith('machina.')) localStorage.removeItem(name) }); await page.reload(); await syncNonce()
    await page.getByLabel('Swap activity', { exact: true }).locator(':scope > summary').click()
    const lookup = page.getByLabel('Look up a transaction'); await lookup.locator('summary').click()
    await lookup.getByLabel('Transaction hash to look up').fill(FIRST_HASH); await lookup.getByRole('button', { name: 'Look up' }).click()
    const result = lookup.getByRole('article', { name: 'Transaction look-up result' }); await result.getByText('This transaction succeeded on Arc.', { exact: true }).waitFor()
    await result.getByText(/received 0\.087854 EURC/).waitFor(); await result.getByText('Network fee: 0.003800899 USDC').waitFor(); await result.getByText(/USDC sent with the transaction: 0\.1/).waitFor()
    await result.getByText(/1\.6% of the amount received was taken as a fee by another address\./).waitFor()
    assert.doesNotMatch(await result.innerText(), /V4_SWAP|TAKE_PORTION|SWEEP|calldata/i) // the contract program is not on the normal screen ...
    await result.locator('summary', { hasText: 'Technical details' }).click()
    await result.getByText(/V4_SWAP\[SWAP_EXACT_IN,SETTLE,TAKE_PORTION,TAKE\]\+SWEEP/).waitFor(); await result.getByText(/fee portion: 1\.6% of the output to 0x147CF09E/).waitFor() // ... but is kept for support
    await result.getByText(/isn’t among the swaps saved in this browser/).waitFor(); assert.equal(await result.getByText(/Confirmed/).count(), 0)
    await lookup.getByLabel('Transaction hash to look up').fill('0xnothash'); await lookup.getByRole('button', { name: 'Look up' }).click(); await result.getByText('That is not a transaction hash.').waitFor()
    await page.evaluate(() => window.swapUiTest.connect(5042))
  })

  await test('Pending keeps its status while the chain is re-read; transient RPC trouble is retried with growing pauses and deterministic errors are not retried', async () => {
    await syncNonce(); await page.clock.install(); await pick('USDC', 'EURC'); await amount.fill('1'); await quoted(); await review.click(); await confirm.click()
    await latest.getByText('Verifying transaction', { exact: true }).waitFor(); const sent = await lastSent(); await syncWalletSends()
    const states = []; await page.evaluate(() => { new MutationObserver(() => { (window.__texts ??= []).push(document.querySelector('article[aria-label="Latest transaction"] p')?.textContent ?? '') }).observe(document.body, { subtree: true, childList: true, characterData: true }) })
    const mine = () => world.reads.filter(r => lc(r.hash) === lc(sent.hash) && r.method === 'eth_getTransactionByHash').length
    const start = mine(); await advanceClock(60_000); await page.waitForTimeout(300); const steady = mine() - start; assert.ok(steady >= 8 && steady <= 14, `steady polling ${steady}`)
    world.rpcDown.add('all'); const downStart = mine(); await advanceClock(300_000, 5000); await page.waitForTimeout(300); const down = mine() - downStart; assert.ok(down >= 3 && down <= 9, `backoff polling ${down}`)
    await latest.getByText('Verifying transaction', { exact: true }).waitFor(); await latest.getByText(/couldn’t reach the network just now|stopped checking automatically/).first().waitFor()
    const flicker = await page.evaluate(() => (window.__texts ?? []).filter(t => t && !/^(Verifying transaction|Confirm in your wallet)$/.test(t)).length); assert.equal(flicker, 0, 'the headline never flickered to another status')
    states.push(down); world.rpcDown.clear()
    // A deterministic result (the hash is a different account's transaction) is not retried.
    const entry = world.receipts.get(lc(sent.hash)); entry.tx = { ...entry.tx, from: '0x2222222222222222222222222222222222222222' }
    await recheck(); await page.waitForTimeout(300)
    await latest.getByRole('alert').getByText(/doesn’t match the swap you reviewed/).waitFor(); const stopped = mine(); await advanceClock(120_000, 5000); await page.waitForTimeout(300); assert.equal(mine(), stopped)
    entry.tx = { ...entry.tx, from: owner }; setReceipt(sent.hash, 'success'); await recheck(); await latest.getByText('Swap completed', { exact: true }).waitFor(); await bumpNonce(); await syncNonce()
  })

  await test('a swap the wallet replaced (speed-up): the recorded hash is unknown and its nonce used; the replacement hash is accepted only after it is verified as the reviewed swap', async () => {
    await syncNonce(); await pick('USDC', 'EURC'); await amount.fill(''); await amount.fill('1'); await quoted(); await review.click(); await confirm.click()
    await latest.getByText('Verifying transaction', { exact: true }).waitFor(); const sent = await lastSent(); await syncWalletSends()
    const nonce = parseInt(sent.tx.nonce, 16), replacement = `0x${'7'.repeat(64)}`, mistyped = `0x${'8'.repeat(64)}`
    world.hidden.add(lc(sent.hash)) // the node no longer knows the first hash ...
    await recheck(); await page.waitForTimeout(300)
    assert.equal(await latest.getByLabel('Recover transaction hash').count(), 0) // ... but while its nonce is free nothing else can take over
    rpc.state.nonce = { latest: nonce + 1, pending: nonce + 1 } // ... and now its nonce was used by another transaction (the speed-up)
    await recheck()
    await latest.getByRole('alert').getByText(/This swap was replaced in your wallet/).waitFor(); await latest.getByText('Verifying transaction', { exact: true }).waitFor()
    await latest.getByText('Hash of the replacement transaction').waitFor(); assert.equal(await review.isDisabled(), true) // a new swap stays blocked
    // the speed-up: the same transaction with a higher fee, mined at the same nonce
    world.receipts.set(lc(replacement), { tx: sent.tx, hash: replacement, mode: 'pending', adjusted: true, sentAt: Date.now() + world.clockOffset }); setReceipt(replacement, 'success')
    await latest.getByLabel('Recover transaction hash').fill(mistyped); await latest.getByRole('button', { name: 'Verify and track hash' }).click()
    await latest.getByRole('alert').getByText(/doesn’t know that transaction hash/).waitFor(); assert.equal(await latest.getByText('Swap completed', { exact: true }).count(), 0)
    await latest.getByLabel('Recover transaction hash').fill(replacement); await latest.getByRole('button', { name: 'Verify and track hash' }).click()
    await latest.getByText('Swap completed', { exact: true }).waitFor(); assert.match(await latest.textContent(), new RegExp(replacement))
    world.hidden.delete(lc(sent.hash)); await bumpNonce(); await syncNonce()
  })

  await test('a double click sends once; an unresolved transaction blocks a new swap and survives a page reload without being resent', async () => {
    await page.reload(); await syncNonce(); await page.evaluate(() => window.swapUiTest.connect(5042)); await pick('USDC', 'EURC'); await amount.fill('1'); await quoted()
    await page.evaluate(() => { window.swapUiTest.state.walletMode = 'held' }); const before = await sends(); await review.click(); await confirm.waitFor()
    await confirm.dblclick({ delay: 5 }); await latest.getByText('Confirm in your wallet', { exact: true }).waitFor(); assert.equal(await sends(), before + 1); assert.equal(await review.isDisabled(), true)
    await page.evaluate(() => window.swapUiTest.release()); await latest.getByText('Verifying transaction', { exact: true }).waitFor()
    await page.evaluate(() => { window.swapUiTest.state.walletMode = 'hash' }); assert.equal(await review.isDisabled(), true); await page.getByText(/still being verified|Verifying transaction/).first().waitFor()
    const pendingHash = (await lastSent()).hash; await page.reload(); await syncNonce(); await page.evaluate(() => window.swapUiTest.connect(5042))
    await latest.getByText('Verifying transaction', { exact: true }).waitFor(); await latest.locator(`a[href$="${pendingHash}"]`).waitFor(); assert.equal(await sends(), 0) // fresh page state: nothing was resent
    await pick('USDC', 'EURC'); await amount.fill('1'); await quoted(); assert.equal(await review.isDisabled(), true)
    await syncWalletSends().catch(() => {}); const entry = world.receipts.get(lc(pendingHash)); entry.mode = 'success'; await recheck()
    await latest.getByText('Swap completed', { exact: true }).waitFor(); await bumpNonce(); await syncNonce()
  })

  await test('a reverted transaction reads Swap failed with the fee and a safe Try again; a declined wallet request is final and also offers it; a read outage is not a chain failure', async () => {
    await pick('USDC', 'EURC'); await amount.fill('1'); await quoted(); await review.click(); await confirm.click(); await latest.getByText('Verifying transaction', { exact: true }).waitFor()
    let sent = await lastSent(); await syncWalletSends(); setReceipt(sent.hash, 'reverted'); await recheck()
    await latest.getByText('Swap failed', { exact: true }).waitFor(); await latest.getByText(/no tokens were swapped\. Only the network fee was charged/).waitFor(); await latest.getByText(/Network fee 0\./).waitFor(); await latest.getByRole('button', { name: 'Try again' }).waitFor(); await bumpNonce(); await syncNonce()
    await page.evaluate(() => { window.swapUiTest.state.walletMode = 'reject' }); await review.click(); await confirm.click(); await latest.getByText('Swap cancelled', { exact: true }).waitFor(); await latest.getByRole('button', { name: 'Try again' }).waitFor()
    assert.equal((await page.locator('body').innerText()).includes('synthetic-private-error'), false); await page.evaluate(() => { window.swapUiTest.state.walletMode = 'hash' })
    world.rpcDown.add('everything'); await pick('USDC', 'EURC'); await amount.fill('2'); await page.getByRole('alert').getByText(/Arc could not be read just now. This is a read problem, not a swap result/).waitFor(); assert.doesNotMatch(await uniCard.innerText(), /revert|failed/i); world.rpcDown.clear() // an outage is never worded as a swap failure
  })

  await test('Try again (only after a certain failure or a declined request) sets the same swap up again with a fresh Review and sends nothing; the swaps that happened offer no Try again', async () => {
    await page.evaluate(() => { window.swapUiTest.state.walletMode = 'reject' }); await pick('USDC', 'EURC'); await amount.fill('1'); await quoted(); await review.click(); await confirm.click()
    await latest.getByText('Swap cancelled', { exact: true }).waitFor(); await page.evaluate(() => { window.swapUiTest.state.walletMode = 'hash' })
    await pick('EURC', 'WETH'); await amount.fill('2')
    const before = await sends(), retry = latest.getByRole('button', { name: 'Try again' }); await retry.click()
    assert.equal(await page.getByRole('combobox', { name: 'From token' }).inputValue(), 'USDC'); assert.equal(await page.getByRole('combobox', { name: 'To token' }).inputValue(), 'EURC'); assert.equal(await amount.inputValue(), '1')
    await page.getByText('The same swap is set up again. Review it to continue; nothing was sent.').waitFor(); assert.equal(await sends(), before); assert.equal(await page.getByRole('dialog').count(), 0)
    await quoted(); assert.equal(await becomesEnabled(), true); await review.click(); await confirm.waitFor(); assert.equal(await sends(), before) // a fresh Review is required; only its confirmation reaches the wallet
    await page.getByRole('dialog').getByRole('button', { name: 'Cancel', exact: true }).click()
    // The swaps that happened never offer it.
    const rows = await page.evaluate(() => { const history = document.querySelector('details[aria-label="Swap history"]'); history.open = true; history.querySelectorAll('details').forEach(node => { node.open = true })
      return [...history.querySelectorAll('article')].map(card => ({ headline: card.querySelector('p')?.textContent ?? '', retry: [...card.querySelectorAll('button')].some(button => button.textContent === 'Try again') })) })
    assert.ok(rows.some(row => row.headline === 'Swap completed')); assert.equal(rows.filter(row => ['Swap completed', 'Verifying transaction'].includes(row.headline) && row.retry).length, 0)
    await page.evaluate(() => { document.querySelector('details[aria-label="Swap history"]').open = false })
  })

  await test('the screen fits a phone without horizontal scrolling, keeps its layout while quotes load and statuses refresh, and keeps one transactions panel', async () => {
    await page.setViewportSize({ width: 390, height: 844 }); await pick('USDC', 'EURC'); await amount.fill(''); await amount.fill('1')
    const overflow = () => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
    await quoted(); await shot('quotes-mobile'); assert.ok((await overflow()) <= 0, 'no horizontal overflow'); const top = () => review.evaluate(node => node.getBoundingClientRect().top + window.scrollY)
    const settled = await top(); await amount.fill(''); await amount.fill('1.5'); await page.getByText('Updating price…').first().waitFor().catch(() => {}); await quoted(); const reloaded = await top()
    assert.ok(Math.abs(settled - reloaded) <= 4, `the Review button moved ${settled - reloaded}px while quotes refreshed`)
    assert.equal(await page.getByRole('region', { name: 'Swap transactions' }).count(), 1); assert.equal(await page.getByRole('article', { name: 'Latest transaction' }).count(), 1)
    const latestText = await latest.innerText(); const history = page.getByLabel('Swap history'); if (await history.count()) assert.equal((await history.innerText()).includes(latestText.split('\n')[0]) && (await history.locator(`article[aria-label^="Transaction"]`).count()) === 0, false)
    await page.setViewportSize({ width: 1280, height: 900 })
  })

  await test('no unapproved wallet or RPC methods, external traffic or uncaught errors; only eth_sendTransaction was ever asked of the wallet', async () => {
    assert.equal(world.external, 0); assert.deepEqual(errors, [])
    assert.equal(methods.some(m => /send|sign|wallet_|personal/i.test(m)), false)
    const wallet = await page.evaluate(() => window.swapUiTest.state.requests.map(r => r.method)); assert.equal(wallet.filter(m => !/^eth_(chainId|accounts|requestAccounts|getTransactionCount|sendTransaction)$/.test(m)).length, 0, wallet.filter(m => !/^eth_(chainId|accounts|requestAccounts|getTransactionCount|sendTransaction)$/.test(m)).join())
  })
  console.log(`${count} Chromium unified Swap UI groups PASS. Controlled Arc RPC, Circle estimator and wallet; no real signature, approval or transaction.`)
} finally { await browser?.close(); await server.close() }
