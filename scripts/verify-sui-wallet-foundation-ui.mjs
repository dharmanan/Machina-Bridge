import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'
import { GrpcTypes } from '@mysten/sui/grpc'
const require = createRequire(import.meta.url)
let chromium; try { ({ chromium } = require('playwright-core')) } catch { ({ chromium } = require('/opt/codex/runtimes/cua/lib/node_modules/playwright-core')) }
const root = fileURLToPath(new URL('..', import.meta.url))
const out = process.env.MACHINA_SUI_SCREEN_DIR || '/tmp/machina-sui-foundation-screens'
mkdirSync(out, { recursive: true })
const server = await createServer({ root, configFile: false, cacheDir: '/tmp/machina-sui-foundation-vite', plugins: [{ name: 'sui-foundation-fixture', configureServer(s) { s.middlewares.use('/__sui-foundation', async (_req, res) => { res.setHeader('Content-Type', 'text/html'); res.end(await s.transformIndexHtml('/__sui-foundation', '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module" src="/scripts/fixtures/sui-wallet-foundation-ui.tsx"></script></body></html>')) }) } }], server: { host: '127.0.0.1', port: 0 } })
await server.listen()
const url = `http://127.0.0.1:${server.httpServer.address().port}/__sui-foundation`
let browser, page, passed = 0, mode = '', rpc = 0
const errors = [], external = []
function frame(bytes) { const header = Buffer.alloc(5); header.writeUInt32BE(bytes.length, 1); const trailers = Buffer.from('grpc-status: 0\r\n'), trailerHeader = Buffer.alloc(5); trailerHeader[0] = 128; trailerHeader.writeUInt32BE(trailers.length, 1); return Buffer.concat([header, bytes, trailerHeader, trailers]).toString('base64') }
async function test(name, f) { try { await f() } catch (e) { console.error('Controlled fixture state:', await page?.locator('body').innerText(), { rpc, errors, external }); throw e }; passed++; console.log('PASS ' + name) }
try {
 browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] })
 const context = await browser.newContext()
 await context.route('**/*', async route => {
  const req = route.request(), u = new URL(req.url())
  if (u.hostname === '127.0.0.1') return route.continue()
  if (!['fullnode.mainnet.sui.io', 'fullnode.testnet.sui.io'].includes(u.hostname)) { external.push(req.url()); return route.abort() }
  const headers = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-expose-headers': 'grpc-status,grpc-message', 'content-type': 'application/grpc-web-text', 'grpc-status': '0' }
  if (req.method() === 'OPTIONS') return route.fulfill({ status: 200, headers, body: '' })
  rpc++
  if (mode === 'rpc-error') return route.abort()
  let bytes
  if (u.pathname.endsWith('/GetServiceInfo')) bytes = GrpcTypes.GetServiceInfoResponse.toBinary(GrpcTypes.GetServiceInfoResponse.fromJson({ chainId: mode === 'wrong-chain' ? '69WiPg3DAQiwdxfncX6wYQ2siKwAe6L9BZthQea3JNMD' : u.hostname.includes('mainnet') ? '4btiuiMPvEENsttpZC7CZ53DruC3MAgfznDbASZ7DR6S' : '69WiPg3DAQiwdxfncX6wYQ2siKwAe6L9BZthQea3JNMD' }))
  else if (u.pathname.endsWith('/GetBalance')) {
   const body = Buffer.from(req.postData(), 'base64'), r = GrpcTypes.GetBalanceRequest.fromBinary(body.subarray(5, 5 + body.readUInt32BE(1)))
   bytes = GrpcTypes.GetBalanceResponse.toBinary(GrpcTypes.GetBalanceResponse.fromJson({ balance: { coinType: r.coinType, balance: '1000000000', coinBalance: '0', addressBalance: '1000000000' } }))
  } else throw Error('Unexpected Sui method ' + u.pathname)
  return route.fulfill({ status: 200, headers, body: frame(Buffer.from(bytes)) })
 })
 page = await context.newPage(); page.on('pageerror', e => errors.push(e.message))
 await page.goto(url); await page.getByRole('button', { name: 'Connect Slush fixture' }).waitFor()
 await test('disconnected wallet makes no balance RPC or signing request', async () => { assert.equal(rpc, 0); assert.equal(await page.evaluate(() => window.suiFoundation.control.signatures), 0) })
 await test('Wallet Standard Slush connection uses real hook and real gRPC decoding', async () => {
  await page.getByRole('button', { name: 'Connect Slush fixture' }).click()
  await page.getByTestId('usdc').filter({ hasText: /^1000 USDC$/ }).waitFor()
  assert.equal(await page.getByTestId('sui').textContent(), '1 SUI')
 })
 await test('network switch selects the Testnet RPC and USDC without changing the account', async () => { const owner = await page.getByTestId('address').textContent(); await page.getByRole('button', { name: 'Switch network' }).click(); await page.getByTestId('network').filter({ hasText: /^testnet$/ }).waitFor(); await page.getByTestId('usdc').filter({ hasText: /^1000 USDC$/ }).waitFor(); assert.equal(await page.getByTestId('address').textContent(), owner) })
 await test('unsupported network invalidates displayed balances', async () => { await page.evaluate(() => window.suiFoundation.change('0x' + '11'.repeat(32), ['sui:mainnet'])); await page.getByRole('status').filter({ hasText: /does not support Sui testnet/ }).waitFor(); assert.match(await page.getByTestId('usdc').textContent(), /Unavailable/) })
 await test('wallet change does not retain previous wallet balances', async () => { await page.evaluate(() => window.suiFoundation.change('0x' + '22'.repeat(32), ['sui:mainnet', 'sui:testnet'])); await page.getByTestId('address').filter({ hasText: '0x' + '22'.repeat(32) }).waitFor(); await page.getByTestId('usdc').filter({ hasText: /^1000 USDC$/ }).waitFor() })
 await test('RPC failure hides cached balance instead of showing spendable stale data', async () => { mode = 'rpc-error'; await page.getByRole('button', { name: 'Refresh balances' }).click(); await page.getByRole('status').filter({ hasText: /unavailable/ }).waitFor(); assert.match(await page.getByTestId('usdc').textContent(), /Unavailable/); mode = '' })
 await test('explicit retry recovers read-only balance state without any signature', async () => { await page.getByRole('button', { name: 'Refresh balances' }).click(); await page.getByTestId('usdc').filter({ hasText: /^1000 USDC$/ }).waitFor(); assert.equal(await page.evaluate(() => window.suiFoundation.control.signatures), 0) })
 await test('desktop and mobile wallet information fits without overflow', async () => { for (const [name, width, height] of [['desktop', 1280, 900], ['mobile', 390, 844]]) { await page.setViewportSize({ width, height }); assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true); await page.screenshot({ path: `${out}/sui-foundation-${name}.png`, fullPage: true }) } })
 await test('wrong Mainnet RPC chain identity blocks balance display', async () => { mode = 'wrong-chain'; await page.reload(); await page.getByRole('button', { name: 'Connect Slush fixture' }).click(); await page.getByRole('status').filter({ hasText: /unavailable/ }).waitFor(); assert.match(await page.getByTestId('usdc').textContent(), /Unavailable/) })
 assert.deepEqual(errors, []); assert.deepEqual(external, [])
 console.log(`RESULT ${passed}/${passed} controlled Chromium Sui wallet groups PASS; no live Slush, transfers, signatures or recovery verification.`)
} finally { await browser?.close(); await server.close() }
