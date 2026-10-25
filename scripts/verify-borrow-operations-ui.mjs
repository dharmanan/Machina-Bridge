// Real Chromium/React/Web Locks/two tabs; all service, wallet and receipt ports are controlled fixtures.
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'
const require = createRequire(import.meta.url)
let chromium; try { ({ chromium } = require('playwright-core')) } catch { ({ chromium } = require('/opt/codex/runtimes/cua/lib/node_modules/playwright-core')) }
const root = fileURLToPath(new URL('..', import.meta.url)), artifacts = '/workspace/artifacts/borrow-production-ui'
mkdirSync(artifacts, { recursive: true })
const server = await createServer({ root, configFile: false, cacheDir: '/tmp/machina-borrow-vite-cache', server: { host: '127.0.0.1', port: 0 }, plugins: [{ name: 'borrow-controlled-ui', configureServer(s) {
  s.middlewares.use('/__borrow_test', async (_req, res) => { res.setHeader('Content-Type', 'text/html'); res.end(await s.transformIndexHtml('/__borrow_test', '<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div id="root"></div><script type="module" src="/scripts/fixtures/borrow/ui.tsx"></script></body></html>')) })
} }] })
await server.listen(); const base = `http://127.0.0.1:${server.httpServer.address().port}`
let browser, page, count = 0, external = 0; const errors = []
async function test(name, run) { await run(); count++; console.log('PASS ' + name) }
async function reset(p = page, mode = 'verified') {
  await p.evaluate(mode => { window.borrowTest.mode = mode; window.resetBorrowTest() }, mode)
  await p.locator('[data-borrow-operations][data-phase=idle]').waitFor()
}
async function review(p = page, kind = 'borrow') {
  await p.getByLabel('Borrow action', { exact: true }).selectOption(kind)
  if (kind !== 'close-loan') await p.getByLabel('Operation amount', { exact: true }).fill(kind.includes('collateral') ? '0.01' : kind === 'repay' ? '10' : '1000')
  await p.getByLabel('Maximum gas cost', { exact: true }).fill('1')
  await p.getByRole('button', { name: 'Get operation review', exact: true }).click()
  await p.getByRole('region', { name: 'Borrow review' }).waitFor()
}
const phase = (p = page, status) => p.locator(`[data-borrow-operations][data-phase=${status}]`).waitFor()
try {
  browser = await chromium.launch({ executablePath: '/usr/bin/chromium', headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] })
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } })
  await context.route('**/*', route => { if (route.request().url().startsWith(base + '/')) return route.continue(); if (route.request().url().startsWith('https://fonts.googleapis.com/')) return route.fulfill({ contentType: 'text/css', body: '' }); external++; return route.abort() })
  page = await context.newPage(); page.setDefaultTimeout(20000); page.on('pageerror', e => errors.push(e.message))
  await page.goto(base + '/__borrow_test'); await page.getByLabel('Borrow action', { exact: true }).waitFor()
  await test('production blocker disables Confirm; review never submits', async () => {
    await reset(page, 'production-closed'); await review(); assert.ok(await page.getByRole('button', { name: 'Confirm Borrow', exact: true }).isDisabled())
    assert.equal(await page.evaluate(() => window.borrowTest.sends), 0)
    await page.screenshot({ path: artifacts + '/desktop-closed-review.png', fullPage: true })
  })
  for (const kind of ['borrow', 'borrow-more', 'repay', 'close-loan', 'add-collateral', 'withdraw-collateral']) await test(kind + ' explicit Review/Confirm → controlled verified result and refresh', async () => {
    await reset(); await review(page, kind); const before = await page.evaluate(() => window.borrowTest.refreshes)
    assert.equal(await page.evaluate(() => window.borrowTest.sends), 0)
    await page.getByRole('button', { name: /^Confirm / }).click(); await phase(page, 'verified')
    assert.equal(await page.evaluate(() => window.borrowTest.sends), 1); assert.equal(await page.evaluate(() => window.borrowTest.refreshes), before + 1)
    if (kind !== 'close-loan') assert.equal(await page.getByLabel('Operation amount', { exact: true }).inputValue(), '')
    assert.match(await page.locator('body').innerText(), /Actual verified gas cost: 0.0001 USDC/)
  })
  await test('expired review is blocked before wallet', async () => {
    await reset(); await review(); await page.evaluate(() => { window.borrowTest.time += 61000 })
    await page.getByRole('button', { name: 'Confirm Borrow', exact: true }).click(); await phase(page, 'blocked')
    assert.equal(await page.evaluate(() => window.borrowTest.sends), 0)
  })
  await test('unknown result retains amount/history and reload blocks resend', async () => {
    await reset(page, 'pending'); await review(); await page.getByRole('button', { name: 'Confirm Borrow', exact: true }).click(); await phase(page, 'unknown')
    assert.equal(await page.getByLabel('Operation amount', { exact: true }).inputValue(), '1000')
    await page.reload(); await page.getByLabel('Borrow action', { exact: true }).waitFor()
    await page.getByLabel('Operation amount', { exact: true }).fill('1000'); await page.getByLabel('Maximum gas cost', { exact: true }).fill('1')
    await page.getByRole('button', { name: 'Get operation review', exact: true }).click(); await phase(page, 'blocked')
    assert.equal(await page.evaluate(() => window.borrowTest.sends), 0)
  })
  await test('two real browser tabs share exclusive Web Lock; no second submission', async () => {
    await reset(); const peer = await context.newPage(); peer.setDefaultTimeout(20000); await peer.goto(base + '/__borrow_test'); await peer.getByLabel('Borrow action', { exact: true }).waitFor()
    await review(); await review(peer)
    await page.evaluate(() => { window.borrowTest.mode = 'pending'; window.borrowTest.hold = true })
    await page.getByRole('button', { name: 'Confirm Borrow', exact: true }).click(); await phase(page, 'pending')
    await peer.bringToFront(); await peer.getByRole('button', { name: 'Confirm Borrow', exact: true }).click(); await phase(peer, 'blocked')
    assert.equal(await peer.evaluate(() => window.borrowTest.sends), 0)
    assert.match(await peer.getByRole('status').innerText(), /Another tab/)
    await page.evaluate(() => { window.borrowTest.hold = false; window.borrowTest.release() }); await phase(page, 'unknown'); await peer.close()
  })
  await test('wallet rejection is ambiguous, never auto-retried', async () => {
    await reset(page, 'rejected'); await review(); await page.getByRole('button', { name: 'Confirm Borrow', exact: true }).click(); await phase(page, 'unknown')
    assert.equal(await page.evaluate(() => window.borrowTest.sends), 1)
  })
  await test('mobile review retains warnings, fee distinction and no horizontal overflow', async () => {
    await reset(page, 'production-closed'); await page.setViewportSize({ width: 390, height: 844 }); await review(page, 'close-loan')
    assert.match(await page.locator('body').innerText(), /transport enforcement not yet available/)
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
    await page.screenshot({ path: artifacts + '/mobile-close-review.png', fullPage: true })
  })
  assert.deepEqual(errors, []); assert.equal(external, 0)
  console.log(`RESULT ${count}/${count} PASS; real external requests/signatures/transactions=0; Chromium controlled ports`)
} catch (error) {
  console.error(await page?.locator('body').innerText()); throw error
} finally { await browser?.close(); await server.close() }
