// Chromium: the EVM "WalletConnect" option on the REAL application entry on an emulated
// iPhone (and its group on desktop). A placeholder project ID enables the option; every non-local
// request is aborted, so no relay, wallet or account is ever reached. Checks that the
// option opens the WalletConnect wallet list, and that a failed WalletConnect start is
// shown to the user instead of leaving a button that silently does nothing.
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'
import react from '@vitejs/plugin-react'
const require = createRequire(import.meta.url)
let chromium; try { ({ chromium } = require('playwright-core')) } catch { ({ chromium } = require(process.env.PLAYWRIGHT_CORE_PATH ?? '/opt/codex/runtimes/cua/lib/node_modules/playwright-core')) }
const root = fileURLToPath(new URL('..', import.meta.url))
process.env.VITE_WALLETCONNECT_PROJECT_ID = 'f'.repeat(32) // placeholder: only enables the option; nothing leaves the machine
const server = await createServer({ root, configFile: false, plugins: [react()], cacheDir: '/tmp/machina-walletconnect-ui', server: { host: '127.0.0.1', port: 0 }, logLevel: 'silent' })
const START_FAILED = /WalletConnect could not start in this browser, so no wallet list opened and nothing was connected\./
const START_SLOW = /WalletConnect has not started after 15 seconds, so no wallet list has opened and nothing is connected\. It may still open/
const IPHONE = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148' }
let browser, passed = 0
async function test(name, fn) { await fn(); passed++; console.log('PASS ' + name) }
try {
  await server.listen(); const base = `http://127.0.0.1:${server.httpServer.address().port}/`
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] })
  // breakStart: the lazily loaded WalletConnect modal (AppKit core) fails to load (true), or is held back until the
  // test releases it ('hold': a slow start), so the WalletConnect provider fails or starts late.
  const held = []
  const open = async ({ phone = true, breakStart = false } = {}) => {
    const context = await browser.newContext(phone ? IPHONE : { viewport: { width: 1280, height: 900 } })
    await context.route('**/*', route => { const u = new URL(route.request().url()); if (u.hostname !== '127.0.0.1') return route.abort(); if (breakStart && /\/deps\/core-[\w-]+\.js$/.test(u.pathname)) return breakStart === 'hold' ? void held.push(route) : route.abort(); return route.continue() })
    const page = await context.newPage(); const accountsRequested = []
    page.on('request', r => { if (/eth_requestAccounts/.test(r.postData() ?? '')) accountsRequested.push(r.url()) })
    await page.goto(base); await page.evaluate(() => localStorage.setItem('machina_app_network', 'mainnet')); await page.goto(base)
    return { context, page, accountsRequested }
  }
  const openConnect = async (page, phone = true) => {
    if (phone) { await page.getByRole('button', { name: 'Open menu' }).click(); await page.getByRole('region', { name: 'Wallets' }).getByRole('button', { name: 'Connect' }).first().click() }
    else await page.getByLabel('EVM wallet').getByRole('button').click()
    await page.getByRole('dialog').last().waitFor(); await page.waitForTimeout(500)
  }
  const tapWalletConnect = page => page.getByTestId('rk-wallet-option-walletConnect').click()
  const walletList = page => page.evaluate(() => { const m = document.querySelector('w3m-modal'); return Boolean(m && (m.hasAttribute('open') || m.open)) })

  await test('iPhone: WalletConnect is listed next to MetaMask; desktop shows it in the same Recommended group (no separate group)', async () => {
    const { context, page } = await open(); await openConnect(page)
    assert.equal(await page.getByTestId('rk-wallet-option-walletConnect').count(), 1); assert.equal(await page.getByTestId('rk-wallet-option-metaMask').count(), 1); await context.close()
    const desktop = await open({ phone: false }); await openConnect(desktop.page, false)
    const text = await desktop.page.getByRole('dialog').last().innerText()
    assert.ok(text.indexOf('Recommended') < text.indexOf('WalletConnect'), 'WalletConnect is in the Recommended group'); assert.doesNotMatch(text, /Other wallets via WalletConnect/); await desktop.context.close()
  })
  await test('iPhone: tapping WalletConnect opens the WalletConnect wallet list ("All Wallets") and shows no error; closing that list is not an error', async () => {
    const { context, page } = await open(); await openConnect(page); await tapWalletConnect(page)
    await page.waitForFunction(() => { const m = document.querySelector('w3m-modal'); return Boolean(m && (m.hasAttribute('open') || m.open)) }, null, { timeout: 15000 })
    assert.equal(await page.getByText(START_FAILED).count(), 0)
    await page.keyboard.press('Escape'); await page.waitForTimeout(1500)
    assert.equal(await page.getByRole('alert').filter({ hasText: /WalletConnect/ }).count(), 0, 'the user closing the list shows no error (hidden desktop bar included)')
    await context.close()
  })
  await test('iPhone: when WalletConnect cannot start, the tap shows a clear error below the bar and in the menu; EVM stays Not connected; a repeated failure shows again after dismissing', async () => {
    const { context, page, accountsRequested } = await open({ breakStart: true }); await openConnect(page); await tapWalletConnect(page)
    const alert = page.getByRole('alert').filter({ hasText: START_FAILED }); await alert.waitFor({ timeout: 20000 })
    assert.equal(await walletList(page), false, 'no wallet list opened')
    // Diagnostics: stage, our code and the error class only; never a URL, token or project ID.
    const shown = await alert.innerText()
    assert.match(shown, /\(stage: start · code: WC_START_FAILED( · [A-Za-z]+Error)?\)/)
    assert.doesNotMatch(shown, /https?:|wss?:|auth|token|f{8}|0x[0-9a-f]{8}/i)
    await page.getByRole('button', { name: 'Open menu' }).click()
    const evmRow = page.getByRole('region', { name: 'Wallets' }); await evmRow.getByText(START_FAILED).waitFor(); await evmRow.getByText('Not connected').first().waitFor()
    await page.getByRole('button', { name: 'Dismiss EVM wallet error' }).click(); assert.equal(await page.getByText(START_FAILED).locator('visible=true').count(), 0, 'dismissed (the desktop bar, hidden on phones, is not counted)')
    await page.getByRole('region', { name: 'Wallets' }).getByRole('button', { name: 'Connect' }).first().click(); await page.getByRole('dialog').last().waitFor(); await page.waitForTimeout(400); await tapWalletConnect(page)
    await page.getByRole('alert').filter({ hasText: START_FAILED }).waitFor({ timeout: 20000 })
    assert.deepEqual(accountsRequested, []); await context.close()
  })
  await test('iPhone: a slow WalletConnect start shows a notice after 15 s without cancelling it; when it starts, the wallet list opens and the notice clears', async () => {
    held.length = 0
    const { context, page } = await open({ breakStart: 'hold' }); await openConnect(page); const tapped = Date.now(); await tapWalletConnect(page)
    const notice = page.getByRole('alert').filter({ hasText: START_SLOW }); await notice.waitFor({ timeout: 30000 })
    assert.ok(Date.now() - tapped >= 14000, 'the notice waits for the 15 s limit'); assert.match(await notice.innerText(), /\(stage: start · code: WC_START_SLOW\)/)
    assert.equal(await walletList(page), false); assert.ok(held.length > 0, 'the start is still pending')
    for (const route of held.splice(0)) await route.continue()
    await page.waitForFunction(() => { const m = document.querySelector('w3m-modal'); return Boolean(m && (m.hasAttribute('open') || m.open)) }, null, { timeout: 20000 })
    assert.equal(await page.getByRole('alert').filter({ hasText: /WalletConnect/ }).count(), 0, 'the late start was not cancelled and its notice cleared')
    await context.close()
  })
  console.log(`RESULT ${passed}/${passed} WalletConnect option groups PASS; real App entry, placeholder project ID, external requests aborted; no wallet, relay or account reached.`)
} finally { await browser?.close(); await server.close() }
