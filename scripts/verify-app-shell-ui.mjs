import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'
import react from '@vitejs/plugin-react'
const require = createRequire(import.meta.url)
let chromium; try { ({ chromium } = require('playwright-core')) } catch { ({ chromium } = require('/opt/codex/runtimes/cua/lib/node_modules/playwright-core')) }
const root = fileURLToPath(new URL('..', import.meta.url)), out = process.env.MACHINA_SUI_SCREEN_DIR || '/tmp/machina-wallet-bar-screens'; mkdirSync(out, { recursive: true })
// The real application entry (index.html -> main.tsx -> App). Every non-local request is aborted.
const server = await createServer({ root, configFile: false, plugins: [react()], cacheDir: '/tmp/machina-wallet-bar-ui', server: { host: '127.0.0.1', port: 0 }, logLevel: 'error' })
let browser, passed = 0; const external = []
async function test(name, fn) { await fn(); passed++; console.log('PASS ' + name) }
try {
  await server.listen(); const base = `http://127.0.0.1:${server.httpServer.address().port}/`
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] })
  const context = await browser.newContext(); await context.route('**/*', route => { const u = new URL(route.request().url()); if (u.hostname === '127.0.0.1') return route.continue(); external.push(u.hostname); return route.abort() })
  const page = await context.newPage(); const pageErrors = []; page.on('pageerror', e => pageErrors.push(e.message))
  // Any wallet request would go through window.ethereum; none is injected, so none can happen silently.
  for (const network of ['mainnet', 'testnet']) await test(`${network}: the top bar shows EVM, Solana (Phantom) and Sui (Slush) wallets side by side, each with its own connect control`, async () => {
    await page.goto(base); await page.evaluate(n => localStorage.setItem('machina_app_network', n), network); await page.goto(base)
    for (const family of ['EVM', 'Solana', 'Sui']) { const chip = page.getByLabel(`${family} wallet`); await chip.waitFor(); assert.match(await chip.innerText(), /Not connected/); assert.equal(await chip.getByRole('button').count(), 1) }
    assert.equal(await page.getByRole('banner').getByText(/Sui/).count() > 0, true)
  })
  await test('mainnet Bridge with the Sui view: one Sui transfer flow, no Connect Slush inside it and no generic EVM Recover Transfer panel', async () => {
    await page.evaluate(() => localStorage.setItem('machina_app_network', 'mainnet')); await page.goto(base)
    await page.getByRole('button', { name: /^Sui/ }).first().click()
    const bridge = page.getByRole('region', { name: 'Sui Mainnet bridge' }); await bridge.waitFor()
    assert.equal(await bridge.getByRole('button', { name: /Connect Slush/ }).count(), 0)
    await bridge.getByText('Connect your EVM wallet (Arc) in the top bar.').waitFor()
    assert.equal(await page.getByText('Recover Transfer', { exact: true }).count(), 0)
    await page.getByRole('button', { name: 'EVM' }).first().click().catch(() => {})
  })
  await test('the EVM bridge view keeps its own Recover Transfer panel', async () => {
    await page.goto(base); await page.getByText('Recover Transfer', { exact: true }).waitFor()
  })
  for (const [network, tabs] of [['mainnet', ['Bridge', 'Swap', 'Earn', 'Dashboard', 'Activity']], ['testnet', ['Swap', 'Bridge', 'Dashboard']]]) await test(`${network}: every product tab opens without an uncaught page error (smoke: ${tabs.join(', ')})`, async () => {
    await page.setViewportSize({ width: 1280, height: 900 }); await page.goto(base); await page.evaluate(n => localStorage.setItem('machina_app_network', n), network); await page.goto(base)
    for (const tab of tabs) { const before = pageErrors.length; await page.getByRole('button', { name: tab, exact: true }).first().click(); await page.waitForTimeout(400); assert.ok(await page.locator('main, #root').first().innerText().then(t => t.length > 40), `${network} ${tab} rendered`); assert.deepEqual(pageErrors.slice(before), [], `${network} ${tab}`) }
  })
  await test('desktop and mobile top bar and Sui bridge fit without horizontal overflow', async () => {
    await page.evaluate(() => localStorage.setItem('machina_app_network', 'mainnet'))
    for (const [name, width, height] of [['desktop', 1280, 900], ['mobile', 390, 844]]) {
      // Phones use the compact header and menu (verify-mobile-menu-ui); the desktop wallet chips exist only from md up.
      await page.setViewportSize({ width, height }); await page.goto(base); await (name === 'desktop' ? page.getByLabel('Sui wallet').waitFor() : page.getByRole('button', { name: 'Open menu' }).waitFor())
      const notice = page.getByRole('button', { name: 'Continue on mobile' }); if (await notice.isVisible().catch(() => false)) await notice.click() // the app's own mobile notice
      await page.getByRole('button', { name: /^Sui/ }).first().click(); await page.getByRole('region', { name: 'Sui Mainnet bridge' }).waitFor()
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, name)
      await page.screenshot({ path: `${out}/app-sui-${name}.png`, fullPage: false })
    }
  })
  assert.deepEqual(pageErrors, []); console.log(`RESULT ${passed}/${passed} Chromium app shell groups PASS; real App entry, no wallet connected, external requests aborted (${new Set(external).size} hosts).`)
} finally { await browser?.close(); await server.close() }
