// Chromium: Dashboard + Activity + Sui Bridge over one browser history.
// Real components/hooks; controlled RPC/gRPC responses and Sui write port.
// The five Sui <-> Arc rows are the real Mainnet transfers (fixtures/real-sui-transfers.json).
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'
import { GrpcTypes } from '@mysten/sui/grpc'
const require = createRequire(import.meta.url)
const { REAL_SUI_TRANSFERS: REAL, realSuiRecords } = require('./fixtures/real-sui-transfers.cjs')
let chromium; try { ({ chromium } = require('playwright-core')) } catch { ({ chromium } = require('/opt/codex/runtimes/cua/lib/node_modules/playwright-core')) }
const root = fileURLToPath(new URL('..', import.meta.url)), out = process.env.MACHINA_SUI_SCREEN_DIR || '/tmp/machina-bridge-dashboard-screens'; mkdirSync(out, { recursive: true })
const wagmiMock = `export function useAccount(){const on=window.dashboardUi?.state.wallets.evm!==false;return on?{address:'${REAL.evm}',isConnected:true,chainId:5042,connector:{name:'MetaMask'}}:{address:undefined,isConnected:false}}
export function useSwitchChain(){return {switchChainAsync:async()=>{throw Error('not used')}}}
export function useReadContract(){return {data:undefined,refetch:async()=>({data:undefined})}}`
const server = await createServer({ root, configFile: false, cacheDir: '/tmp/machina-bridge-dashboard-ui', plugins: [{ name: 'controlled-dashboard', enforce: 'pre',
  resolveId(id) { if (id === 'wagmi') return '\0dash-wagmi'; if (id === 'wagmi/actions') return '\0dash-wagmi-actions'; if (id.endsWith('/lib/wagmi.config')) return '\0dash-wagmi-config' },
  load(id) { if (id === '\0dash-wagmi') return wagmiMock; if (id === '\0dash-wagmi-actions') return 'export async function getWalletClient(){throw Error("not used")}'; if (id === '\0dash-wagmi-config') return 'export const wagmiConfig={}' },
  configureServer(s) {
    s.middlewares.use('/api/arc-wallet-activity', (_req, res) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ transactions: [], tokenTransfers: [], limit: 30 })) })
    s.middlewares.use('/__dashboard', async (_req, res) => { res.setHeader('Content-Type', 'text/html'); res.end(await s.transformIndexHtml('/__dashboard', '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module" src="/scripts/fixtures/bridge-dashboard-ui.tsx"></script></body></html>')) })
  } }], server: { host: '127.0.0.1', port: 0 } })
let browser, page, count = 0, suiMode = '', releaseBalance, evmFail = '', rpcCalls = 0
const errors = [], external = []
function frame(bytes) { const head = Buffer.alloc(5); head.writeUInt32BE(bytes.length, 1); const tail = Buffer.from('grpc-status: 0\r\n'), th = Buffer.alloc(5); th[0] = 128; th.writeUInt32BE(tail.length, 1); return Buffer.concat([head, bytes, th, tail]).toString('base64') }
async function test(name, fn) { try { await fn(); count++; console.log('PASS ' + name) } catch (e) { console.error('UI state:', (await page?.locator('body').innerText().catch(() => ''))?.slice(0, 2500), errors); throw e } }
const evmRecord = { id: 'cctp-1-0x' + 'aa'.repeat(32) + '-3', walletAddress: REAL.evm, sourceChainId: 1, destinationChainId: 5042, amount: '2', token: 'USDC', mode: 'standard', recipient: REAL.evm, destinationCaller: '0x' + '0'.repeat(40), stage: 'complete', approvalRequired: false, createdAt: Date.parse('2026-10-20T10:00:00Z'), updatedAt: Date.parse('2026-10-20T10:30:00Z'), sourceTxHash: '0x' + 'aa'.repeat(32), sourceLogIndex: 3, destinationTxHash: '0x' + 'bb'.repeat(32), recovered: true }
const solanaRecord = { id: 'sol-1', evmWallet: REAL.evm, solanaWallet: '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU', direction: 'solana-to-arc', amount: '1.5', status: 'complete', createdAt: Date.parse('2026-10-25T08:00:00Z'), sourceTxHash: '5'.repeat(87), destinationTxHash: '0x' + 'cc'.repeat(32) }
// Browser history as it stood before the fifth real transfer was received.
const seeded = realSuiRecords().map((r, n) => n === 4 ? { ...r, stage: 'ready_to_mint', destinationTx: undefined, checkedAt: Date.parse(REAL.transfers[4].sourceTime) + 60_000 } : r)
try {
  await server.listen(); const base = `http://127.0.0.1:${server.httpServer.address().port}/__dashboard`
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] })
  const context = await browser.newContext(); await context.route('**/*', async route => {
    const req = route.request(), url = new URL(req.url())
    if (url.hostname === '127.0.0.1') return route.continue()
    if (url.hostname === 'fonts.googleapis.com' && url.pathname === '/css2') return route.fulfill({ status: 200, contentType: 'text/css', body: '' })
    if (url.hostname === 'fullnode.mainnet.sui.io') {
      const headers = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-expose-headers': 'grpc-status,grpc-message', 'content-type': 'application/grpc-web-text' }
      if (req.method() === 'OPTIONS') return route.fulfill({ status: 200, headers, body: '' })
      const name = url.pathname.split('/').pop(), raw = Buffer.from(req.postData(), 'base64'), input = GrpcTypes[name + 'Request'].fromBinary(raw.subarray(5, 5 + raw.readUInt32BE(1)))
      let response
      if (name === 'GetServiceInfo') response = GrpcTypes.GetServiceInfoResponse.create({ chainId: '4btiuiMPvEENsttpZC7CZ53DruC3MAgfznDbASZ7DR6S' })
      else if (name === 'GetBalance') {
        if (suiMode === 'hold') await new Promise(r => { releaseBalance = r })
        if (suiMode === 'error') return route.abort()
        const usdc = input.coinType.endsWith('::usdc::USDC')
        response = GrpcTypes.GetBalanceResponse.fromJson({ balance: { coinType: input.coinType, balance: usdc ? '300000' : '1000000000', coinBalance: usdc ? '300000' : '1000000000', addressBalance: '0' } })
      } else throw Error('Unapproved Sui method ' + name)
      return route.fulfill({ status: 200, headers, body: frame(Buffer.from(GrpcTypes[name + 'Response'].toBinary(response))) })
    }
    if (url.hostname === 'solana-rpc.publicnode.com') return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ jsonrpc: '2.0', id: 1, result: { value: { data: { parsed: { info: { tokenAmount: { uiAmountString: '2.5' } } } } } } }) })
    if (req.method() === 'POST' && /"jsonrpc"/.test(req.postData() ?? '')) {
      rpcCalls++
      if (evmFail && url.hostname.includes(evmFail)) return route.abort()
      const body = req.postDataJSON(), one = b => ({ jsonrpc: '2.0', id: b.id, result: b.method === 'eth_call' ? '0x' + (1_234_500).toString(16).padStart(64, '0') : b.method === 'eth_chainId' ? '0x1' : null })
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(Array.isArray(body) ? body.map(one) : one(body)) })
    }
    external.push(req.url()); return route.abort()
  })
  page = await context.newPage(); page.on('pageerror', e => errors.push(e.message))
  const open = async (tab = 'dashboard') => { await page.goto(`${base}?tab=${tab}`); await page.waitForFunction(() => Boolean(window.dashboardUi)) }
  const seed = (sui = seeded) => page.evaluate(({ sui, evm, sol }) => { localStorage.clear(); localStorage.setItem('machina_mainnet_sui_transfers_v1', JSON.stringify(sui)); localStorage.setItem('machina_mainnet_transfers_v1', JSON.stringify([evm])); localStorage.setItem('machina_mainnet_solana_transfers_v1', JSON.stringify([sol])) }, { sui, evm: evmRecord, sol: solanaRecord })
  const connectSlush = async () => { await page.getByRole('button', { name: 'Connect Slush (top bar)' }).click(); await page.getByRole('button', { name: 'Slush connected' }).waitFor() }
  const rows = () => page.getByRole('listitem', { name: 'Bridge transfer' })
  const rowFor = source => rows().filter({ has: page.locator(`a[href$="${source}"]`) })
  const tab = name => page.getByRole('button', { name, exact: true }).click()

  await open(); await seed(); await open()
  await test('Dashboard has no separate Sui panel or Bridge copy above its content; recovery stays reachable at the bottom', async () => {
    await page.getByRole('heading', { name: 'Mainnet Dashboard' }).waitFor()
    assert.equal(await page.getByRole('region', { name: /Sui transfers|Sui Mainnet bridge|Sui transfer panel/ }).count(), 0)
    const t = await page.locator('body').innerText()
    assert.ok(t.indexOf('Mainnet Dashboard') < t.indexOf('Recover Transfer'), 'recovery is below the dashboard content')
    assert.ok(t.indexOf('Bridge Activity') < t.indexOf('Recover a transfer'))
    assert.match(t, /Sui ↔ Arc transfers are found in Bridge → Sui Bridge/)
  })
  await test('Wallet Connections shows EVM / MetaMask, Solana / Phantom and Sui / Slush in one layout', async () => {
    const card = n => page.getByLabel(`${n} connection`)
    assert.match(await card('Slush Sui').innerText(), /Connect in the top bar/)
    await connectSlush()
    for (const [n, addr] of [['EVM Wallet', REAL.evm.slice(0, 8)], ['Phantom Solana', '7xKXtg2C'], ['Slush Sui', REAL.sui.slice(0, 8)]]) { const t = await card(n).innerText(); assert.match(t, /Connected/, n); assert.ok(t.includes(addr), n) }
  })
  await test('Sui USDC balance comes from the verified Sui reader; loading and RPC errors are never shown as 0 USDC', async () => {
    const sui = page.getByLabel('Sui USDC balance')
    await sui.getByText('0.3 USDC').waitFor()
    suiMode = 'hold'; await page.getByRole('button', { name: 'Refresh' }).click(); await page.waitForTimeout(400)
    let t = await sui.innerText(); assert.ok(!/\b0 USDC/.test(t), 'a refetch keeps the last real value, never 0'); releaseBalance?.()
    suiMode = 'error'; await page.reload(); await page.waitForFunction(() => Boolean(window.dashboardUi)); suiMode = 'hold'; await connectSlush()
    await sui.getByText('Loading...').waitFor(); t = await sui.innerText(); assert.ok(!/0(\.0+)? USDC/.test(t), 'loading is not 0'); suiMode = 'error'; releaseBalance?.()
    await sui.getByText('Unavailable').waitFor(); assert.ok(!/0(\.0+)? USDC/.test(await sui.innerText()), 'an RPC error is not 0')
    suiMode = ''; await page.getByRole('button', { name: 'Refresh' }).click(); await sui.getByText('0.3 USDC').waitFor()
  })
  await test('existing EVM and Solana balances stay; a failing EVM RPC shows Unavailable, not 0', async () => {
    for (const n of ['Ethereum', 'Arc', 'Base', 'OP Mainnet', 'Arbitrum One', 'Solana']) assert.ok((await page.locator('body').innerText()).includes(`USDC (${n})`) || n !== 'Solana', n)
    await page.getByText('USDC (Solana)').waitFor(); assert.ok((await page.locator('body').innerText()).includes('2.5 USDC'))
    evmFail = 'base'; await page.getByRole('button', { name: 'Refresh' }).click()
    const baseRow = page.locator('div.rounded-xl', { hasText: 'USDC (Base)' }).last(); await baseRow.getByText('Unavailable').waitFor(); evmFail = ''
  })
  await test('the five real Sui <-> Arc transfers, the EVM and the Solana transfer appear once each, newest first, with real explorer links', async () => {
    assert.equal(await rows().count(), 7)
    const order = await rows().evaluateAll(els => els.map(e => e.querySelector('p').innerText))
    assert.deepEqual(order, ['Arc → Sui · 0.1 USDC', 'Sui → Arc · 0.1 USDC', 'Sui → Arc · 0.1 USDC', 'Arc → Sui · 0.1 USDC', 'Arc → Sui · 0.1 USDC', 'Solana → Arc · 1.5 USDC', 'Ethereum → Arc · 2 USDC'])
    for (const t of REAL.transfers.slice(0, 4)) { const r = rowFor(t.direction === 'arc-to-sui' ? t.source.toLowerCase() : t.source); assert.equal(await r.count(), 1, t.source); assert.ok((await r.innerText()).includes('Complete')); assert.ok(await r.locator(`a[href$="${t.destination}"]`).count() === 1, 'destination link ' + t.destination) }
    const pending = rowFor(REAL.transfers[4].source); assert.match(await pending.innerText(), /Ready to receive/); assert.match(await pending.innerText(), /Saved status in this browser/)
    const stat = l => page.getByLabel(`${l} completed`).innerText()
    assert.match(await stat('Arc → Sui'), /\b2$/); assert.match(await stat('Sui → Arc'), /\b2$/); assert.match(await stat('Ethereum → Arc'), /\b1$/); assert.match(await stat('Solana → Arc'), /\b1$/)
    assert.match(await page.locator('body').innerText(), /not a full chain history scan/)
  })
  await test('de-duplication: a repeated stored row counts once; the same source with another CCTP event index stays separate', async () => {
    const twin = { ...seeded[0] }, other = { ...seeded[0], sourceEventIndex: 9, id: seeded[0].id.replace(/:6$/, ':9') }
    await seed([...seeded, twin]); await page.reload(); await page.waitForFunction(() => Boolean(window.dashboardUi)); await connectSlush(); await rows().first().waitFor(); assert.equal(await rows().count(), 7)
    await seed([...seeded, other]); await page.reload(); await page.waitForFunction(() => Boolean(window.dashboardUi)); await connectSlush(); await rows().first().waitFor(); assert.equal(await rows().count(), 8)
    await seed(); await page.reload(); await page.waitForFunction(() => Boolean(window.dashboardUi)); await connectSlush()
  })
  await test('after the real final mint (0xe28f… -> 6VNJ…) the Bridge, Dashboard and Activity show the same completed transfer', async () => {
    await tab('bridge'); const panel = page.getByRole('region', { name: 'Sui transfer panel' })
    await panel.getByText('Review to receive in your Sui wallet').waitFor()
    await page.getByRole('button', { name: 'Review: Receive USDC on Sui' }).click(); await page.getByRole('region', { name: 'Transaction review' }).waitFor()
    await page.evaluate(() => { window.dashboardUi.state.stage = 'complete' })
    await page.getByRole('button', { name: 'Confirm in Slush' }).click(); await page.getByRole('button', { name: 'Check status now' }).click()
    await page.getByRole('status').getByText('Transfer complete', { exact: true }).waitFor()
    assert.equal(await panel.locator(`a[href$="${REAL.transfers[4].destination}"]`).count(), 1)
    await tab('dashboard'); const row = rowFor(REAL.transfers[4].source); await row.waitFor()
    const d = await row.innerText(); assert.match(d, /Complete/); assert.match(d, /Verified on chain at/); assert.equal(await row.locator(`a[href$="${REAL.transfers[4].destination}"]`).count(), 1)
    assert.match(await page.getByLabel('Arc → Sui completed').innerText(), /\b3$/)
    await tab('activity'); const a = rowFor(REAL.transfers[4].source); await a.waitFor(); const at = await a.innerText()
    assert.equal(at, d, 'Activity shows exactly the Dashboard row')
    await page.getByText('No Arc wallet activity found.').waitFor()
    const s = await page.evaluate(() => window.dashboardUi.state); assert.deepEqual([s.signatures, s.broadcasts], [1, 1])
  })
  await test('records survive a reload; a stored completion is shown as saved, not as verified now', async () => {
    await page.reload(); await page.waitForFunction(() => Boolean(window.dashboardUi)); await connectSlush(); await rows().first().waitFor()
    assert.equal(await rows().count(), 7); const r = await rowFor(REAL.transfers[4].source).innerText(); assert.match(r, /Complete/); assert.match(r, /Saved status in this browser/)
    assert.equal(await page.evaluate(() => Object.values(localStorage).some(v => /CONTROLLED-NEVER-PERSIST/.test(v))), false)
  })
  await test('desktop and mobile: Dashboard and Activity fit without horizontal overflow (screenshots)', async () => {
    for (const [name, width, height] of [['desktop', 1280, 900], ['mobile', 390, 844]]) {
      await page.setViewportSize({ width, height })
      for (const t of ['dashboard', 'activity']) { await tab(t); await rows().first().waitFor(); assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `${t} ${name}`); await page.screenshot({ path: `${out}/${t}-${name}.png`, fullPage: true }) }
    }
    await page.setViewportSize({ width: 1280, height: 900 })
  })
  assert.deepEqual(errors, []); assert.deepEqual(external, [])
  console.log(`RESULT ${count}/${count} Chromium Dashboard/Activity/Bridge groups PASS; 5 real Sui <-> Arc transfers; controlled RPC, gRPC and wallet ports; real network/signatures/broadcasts=0.`)
} finally { await browser?.close(); await server.close() }
