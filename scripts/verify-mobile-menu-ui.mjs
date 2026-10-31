// Chromium: the phone header and its right-side menu (navigation, wallets, network,
// links) on the REAL application entry, at 320/375/390/430 px, and the unchanged
// desktop header at 1280 px. Phantom is injected per scenario; every non-local request
// is aborted. No real wallet, signature or transaction.
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'
import react from '@vitejs/plugin-react'
const require = createRequire(import.meta.url)
let chromium; try { ({ chromium } = require('playwright-core')) } catch { ({ chromium } = require(process.env.PLAYWRIGHT_CORE_PATH ?? '/opt/codex/runtimes/cua/lib/node_modules/playwright-core')) }
const root = fileURLToPath(new URL('..', import.meta.url)), shots = process.env.MACHINA_MOBILE_SCREEN_DIR
if (shots) mkdirSync(shots, { recursive: true })
const SOL = '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU'
const server = await createServer({ root, configFile: false, plugins: [react()], cacheDir: '/tmp/machina-mobile-menu-ui', server: { host: '127.0.0.1', port: 0 }, logLevel: 'silent' })
// Phantom as its in-app browser injects it; `mode` decides what connect() does.
const phantom = mode => `(() => { const listeners = {}; window.phantomTest = { calls: [] }
  const key = { toBase58: () => '${SOL}', toString: () => '${SOL}' }
  const provider = { isPhantom: true, publicKey: null,
    on: (e, f) => { (listeners[e] ||= []).push(f) }, off: (e, f) => { listeners[e] = (listeners[e] || []).filter(x => x !== f) },
    connect: async () => { window.phantomTest.calls.push('connect'); if (${JSON.stringify(mode)} === 'reject') { throw new Error('User rejected the request.') } provider.publicKey = key; return { publicKey: key } },
    disconnect: async () => { window.phantomTest.calls.push('disconnect'); provider.publicKey = null },
    signTransaction: async () => { window.phantomTest.calls.push('sign'); throw new Error('no signing in tests') } }
  window.phantom = { solana: provider } })()`
// The Slush app browser exposes its wallet through the Wallet Standard (not the web-wallet popup).
const SUI_ADDR = '0x' + 'ab'.repeat(32)
const injectedSlush = `(() => { window.slushTest = { connects: 0 }; const accounts = []; const listeners = []
  const wallet = { version: '1.0.0', name: 'Slush', id: 'com.mystenlabs.suiwallet', icon: 'data:image/svg+xml;base64,PHN2Zy8+', chains: ['sui:mainnet', 'sui:testnet'],
    get accounts() { return accounts.slice() },
    features: {
      'standard:connect': { version: '1.0.0', connect: async () => { window.slushTest.connects++; if (!accounts.length) accounts.push({ address: '${SUI_ADDR}', publicKey: new Uint8Array(32), chains: ['sui:mainnet'], features: ['sui:signTransaction'], label: 'Slush' }); listeners.forEach(f => f({ accounts: accounts.slice() })); return { accounts: accounts.slice() } } },
      'standard:disconnect': { version: '1.0.0', disconnect: async () => { accounts.length = 0; listeners.forEach(f => f({ accounts: [] })) } },
      'standard:events': { version: '1.0.0', on: (event, f) => { if (event === 'change') listeners.push(f); return () => {} } },
      'sui:signTransaction': { version: '2.0.0', signTransaction: async () => { throw new Error('no signing in tests') } },
      'sui:signTransactionBlock': { version: '1.0.0', signTransactionBlock: async () => { throw new Error('no signing in tests') } },
      'sui:signPersonalMessage': { version: '1.0.0', signPersonalMessage: async () => { throw new Error('no signing in tests') } } } }
  window.addEventListener('wallet-standard:app-ready', event => event.detail.register(wallet)) })()`
let browser, count = 0; const errors = []
// MOBILE_MENU_ONLY=<regex> runs only the matching groups (targeted checks).
async function test(name, fn) { if (process.env.MOBILE_MENU_ONLY && !new RegExp(process.env.MOBILE_MENU_ONLY).test(name)) return; await fn(); count++; console.log('PASS ' + name) }
try {
  await server.listen(); const base = `http://127.0.0.1:${server.httpServer.address().port}/`
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] })
  async function open({ width = 390, height = 844, mobile = true, phantomMode = null, network = 'mainnet', slushInjected = false } = {}) {
    const context = await browser.newContext({ viewport: { width, height }, isMobile: mobile, hasTouch: mobile })
    const blocked = []
    await context.route('**/*', route => { const u = new URL(route.request().url()); if (u.hostname === '127.0.0.1') return route.continue(); blocked.push(u.href); return route.abort() })
    if (phantomMode) await context.addInitScript(phantom(phantomMode))
    if (slushInjected) await context.addInitScript(injectedSlush)
    await context.addInitScript(n => { try { if (!sessionStorage.getItem('seeded')) { localStorage.setItem('machina_app_network', n); sessionStorage.setItem('seeded', '1') } } catch {} }, network)
    const page = await context.newPage(); page.on('pageerror', e => errors.push(`${width}: ${e.message}`))
    await page.goto(base, { timeout: 120_000 })
    // The old full-screen mobile notice is gone: the page is usable at once, its wallet guidance lives in the menu.
    await page.getByRole('button', { name: mobile ? 'Open menu' : 'Bridge' }).first().waitFor({ timeout: 60_000 })
    assert.equal(await page.getByRole('button', { name: 'Continue on mobile' }).count(), 0, 'no mobile notice dialog')
    return { context, page, blocked }
  }
  const menu = page => page.getByRole('dialog', { name: 'Menu' })
  const trigger = page => page.getByRole('button', { name: 'Open menu' })
  const openMenu = async page => { await trigger(page).click(); await menu(page).waitFor() }
  const row = (page, family) => menu(page).getByLabel(`${family} wallet`, { exact: true })

  for (const width of [320, 375, 390, 430]) await test(`${width} px: one compact header row (logo, name, network, menu); the product tab row is hidden; no horizontal scroll; the menu opens from the right and closes without covering the page`, async () => {
    const { context, page } = await open({ width })
    const bar = page.getByRole('banner', { name: 'Machina Bridge' }), box = await bar.boundingBox()
    assert.ok(box.height <= 64, `header height ${box.height}`)
    for (const el of [bar.getByRole('heading', { name: 'Machina Bridge' }), bar.getByLabel('Network: Mainnet'), trigger(page)]) {
      const b = await el.boundingBox(); assert.ok(b && b.y >= box.y && b.y + b.height <= box.y + box.height, 'on the single header row')
    }
    for (const tab of ['Swap', 'Earn', 'Dashboard', 'Activity']) assert.equal(await page.getByRole('button', { name: tab, exact: true }).count(), 0, `${tab} tab row hidden on phones`)
    for (const family of ['EVM', 'Solana', 'Sui']) assert.equal(await page.getByLabel(`${family} wallet`, { exact: true }).first().isVisible(), false, 'desktop wallet chips hidden on phones')
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth))
    assert.equal(await trigger(page).getAttribute('aria-expanded'), 'false'); assert.equal(await menu(page).count(), 0, 'closed menu is not rendered')
    if (shots) await page.screenshot({ path: `${shots}/${width}.png` })
    await openMenu(page)
    const m = await menu(page).boundingBox()
    assert.ok(Math.abs(m.x + m.width - width) <= 1, 'anchored to the right edge'); assert.ok(m.width < width, 'narrower than the screen'); assert.ok(m.width <= 352)
    assert.equal(await trigger(page).getAttribute('aria-expanded'), 'true'); assert.equal(await menu(page).getAttribute('aria-modal'), 'true')
    for (const section of ['Navigation', 'Wallets', 'Network', 'Links']) await menu(page).getByRole('region', { name: section }).waitFor()
    await menu(page).getByRole('link', { name: 'GitHub' }).scrollIntoViewIfNeeded(); assert.ok(await menu(page).getByRole('link', { name: 'GitHub' }).isVisible(), 'last section reachable by scrolling')
    assert.equal(await menu(page).getByRole('link', { name: 'GitHub' }).getAttribute('href'), 'https://github.com/dharmanan/Machina-Bridge')
    assert.equal(await menu(page).getByRole('link', { name: 'X' }).getAttribute('href'), 'https://x.com/KohenEric')
    if (shots) await page.screenshot({ path: `${shots}/${width}-menu.png` })
    await menu(page).getByRole('button', { name: 'Close menu' }).click(); await menu(page).waitFor({ state: 'detached' })
    assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('aria-label')), 'Open menu', 'focus returns to the menu button')
    assert.equal(await page.evaluate(() => document.body.style.overflow), '', 'page scroll restored')
    await context.close()
  })

  for (const width of [320, 375]) await test(`${width} px: the EVM Bridge card fits: title on one row, description at full width, no clipped wallet status, From above To`, async () => {
    const { context, page } = await open({ width })
    const title = page.getByRole('heading', { name: 'Bridge USDC' }), t = await title.boundingBox()
    assert.ok(t.height < 36, `title on one line (${t.height}px)`)
    const status = page.getByText('Not connected', { exact: true }).first()
    assert.ok(await status.evaluate(e => e.scrollWidth <= e.clientWidth), '"Not connected" is not truncated')
    const from = await page.locator('select').nth(0).boundingBox(), to = await page.locator('select').nth(1).boundingBox()
    assert.ok(to.y > from.y + from.height, 'To sits below From'); assert.ok(from.width > width * 0.6, 'full-width network selects')
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth))
    await context.close()
  })

  await test('navigation: every tab is reachable from the menu, the menu closes on selection and marks the current page', async () => {
    const { context, page } = await open()
    for (const tab of ['Swap', 'Earn', 'Dashboard', 'Activity', 'Bridge']) {
      const before = errors.length
      await openMenu(page); await menu(page).getByRole('button', { name: tab }).click(); await menu(page).waitFor({ state: 'detached' })
      await page.waitForTimeout(300); assert.deepEqual(errors.slice(before), [], tab)
      await openMenu(page); assert.equal(await menu(page).getByRole('button', { name: tab }).getAttribute('aria-current'), 'page', tab)
      await page.keyboard.press('Escape'); await menu(page).waitFor({ state: 'detached' })
    }
    await context.close()
  })

  await test('Escape, a tap outside and the close button close the menu; Tab keeps focus inside it', async () => {
    const { context, page } = await open()
    await openMenu(page); assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('aria-label')), 'Close menu', 'focus moves into the menu')
    await page.keyboard.press('Escape'); await menu(page).waitFor({ state: 'detached' })
    await openMenu(page); await page.mouse.click(10, 400); await menu(page).waitFor({ state: 'detached' })
    await openMenu(page)
    for (let i = 0; i < 40; i++) { await page.keyboard.press('Tab'); assert.ok(await page.evaluate(() => Boolean(document.activeElement?.closest('#mobile-menu'))), `focus left the menu after ${i + 1} Tab`) }
    for (let i = 0; i < 5; i++) { await page.keyboard.press('Shift+Tab'); assert.ok(await page.evaluate(() => Boolean(document.activeElement?.closest('#mobile-menu')))) }
    await context.close()
  })

  await test('Phantom not injected on a phone (e.g. Safari with the Phantom app installed): no dead Install button; Open in Phantom uses the official browse link for this page', async () => {
    const { context, page } = await open()
    await openMenu(page); const sol = row(page, 'Solana')
    const link = sol.getByRole('link', { name: 'Open in Phantom' }), url = new URL(page.url()), here = `${url.origin}${url.pathname}`
    assert.equal(await link.getAttribute('href'), `https://phantom.app/ul/browse/${encodeURIComponent(here)}?ref=${encodeURIComponent(url.origin)}`)
    assert.equal(await sol.getByRole('button', { name: 'Install' }).count(), 0)
    assert.match(await sol.innerText(), /only inside the Phantom app’s browser/)
    await context.close()
  })

  await test('wallet compatibility guidance from the old mobile notice is in the menu: in-app browsers explained, Open in MetaMask uses its dapp link', async () => {
    const { context, page } = await open()
    await openMenu(page); const wallets = menu(page).getByRole('region', { name: 'Wallets' })
    assert.match(await wallets.innerText(), /most reliably inside its own app’s browser/)
    const url = new URL(page.url())
    assert.equal(await row(page, 'EVM').getByRole('link', { name: 'Open in MetaMask' }).getAttribute('href'), `https://metamask.app.link/dapp/${url.host}${url.pathname}`)
    await context.close()
  })

  await test('Phantom injected (its in-app browser): Connect and Disconnect from the menu update the row; nothing is signed', async () => {
    const { context, page } = await open({ phantomMode: 'accept' })
    await openMenu(page); const sol = row(page, 'Solana')
    await sol.getByRole('button', { name: 'Connect' }).click(); await sol.getByText('Phantom · 7xKXtg…gAsU').waitFor(); await sol.getByText('Solana Mainnet').waitFor()
    await sol.getByRole('button', { name: 'Disconnect' }).click(); await sol.getByRole('button', { name: 'Connect' }).waitFor()
    assert.deepEqual(await page.evaluate(() => window.phantomTest.calls), ['connect', 'disconnect'])
    await context.close()
  })

  await test('a wallet error shows under its own wallet in the menu, never as a line on the page; it can be closed and stays closed after reopening the menu', async () => {
    const { context, page } = await open({ phantomMode: 'reject' })
    await openMenu(page); const sol = row(page, 'Solana')
    await sol.getByRole('button', { name: 'Connect' }).click()
    const alert = sol.getByRole('alert'); await alert.waitFor(); assert.match(await alert.innerText(), /User rejected the request\./)
    assert.equal(await page.getByRole('alert').evaluateAll(els => els.filter(e => e.getClientRects().length > 0).length), 1, 'the only visible alert is inside the Solana row')
    await page.keyboard.press('Escape'); await menu(page).waitFor({ state: 'detached' })
    const visibleErrors = await page.getByText('User rejected the request.').evaluateAll(els => els.filter(e => e.getClientRects().length > 0).length)
    assert.equal(visibleErrors, 0, 'no error line visible on the page while the menu is closed')
    await openMenu(page); await row(page, 'Solana').getByRole('alert').waitFor()
    await row(page, 'Solana').getByRole('button', { name: 'Dismiss Solana wallet error' }).click(); assert.equal(await row(page, 'Solana').getByRole('alert').count(), 0)
    await page.keyboard.press('Escape'); await openMenu(page); assert.equal(await row(page, 'Solana').getByRole('alert').count(), 0, 'stays closed')
    await context.close()
  })

  await test('Sui in Safari (only the Slush web wallet): Open in Slush is the main action with the official browse link; the web wallet stays secondary and explained; opening the app is not a connection', async () => {
    const { context, page, blocked } = await open()
    await openMenu(page); const sui = row(page, 'Sui'), url = new URL(page.url())
    const open_ = sui.getByRole('link', { name: 'Open in Slush' })
    assert.equal(await open_.getAttribute('href'), `https://my.slush.app/browse/${url.origin}${url.pathname}`)
    assert.equal(await sui.getByRole('button', { name: 'Connect', exact: true }).count(), 0, 'Connect is not the main action')
    const text = await sui.innerText()
    assert.match(text, /Not connected/); assert.match(text, /Your EVM wallet is not connected there automatically/)
    assert.match(text, /separate web session/); assert.match(text, /cannot hand over to the Slush app/)
    // Only a real Sui address means connected: before (and after leaving for the app) the row stays not connected.
    assert.equal(await sui.getByRole('button', { name: 'Disconnect' }).count(), 0)
    const popup = context.waitForEvent('page', { timeout: 15_000 }); await sui.getByRole('button', { name: 'Use the Slush web wallet' }).click()
    const win = await popup
    for (let i = 0; i < 100 && !blocked.some(u => u.startsWith('https://my.slush.app/')); i++) await page.waitForTimeout(50)
    assert.ok(blocked.some(u => u.startsWith('https://my.slush.app/')), 'the secondary action opens the Slush web wallet'); await win.close()
    const alert = sui.getByRole('alert'); await alert.waitFor({ timeout: 15_000 }); assert.match(await alert.innerText(), /closed/i)
    assert.match(await sui.innerText(), /Not connected/, 'a closed or handed-over window never reads as connected')
    await sui.getByRole('button', { name: 'Dismiss Sui wallet error' }).click(); assert.equal(await sui.getByRole('alert').count(), 0)
    await context.close()
  })

  await test('Sui inside the Slush app browser (injected wallet): no Open in Slush; Connect is shown and only a returned Sui address turns the row connected; the EVM wallet is not assumed', async () => {
    const { context, page } = await open({ slushInjected: true })
    await openMenu(page); const sui = row(page, 'Sui')
    assert.equal(await sui.getByRole('link', { name: 'Open in Slush' }).count(), 0)
    assert.match(await sui.innerText(), /Not connected/)
    await sui.getByRole('button', { name: 'Connect', exact: true }).click()
    await sui.getByText(/Slush · 0xabab…abab/).waitFor({ timeout: 15_000 }); await sui.getByRole('button', { name: 'Disconnect' }).waitFor()
    assert.equal(await page.evaluate(() => window.slushTest.connects), 1)
    const evm = row(page, 'EVM'); assert.match(await evm.innerText(), /Not connected/); await evm.getByRole('button', { name: 'Connect' }).waitFor()
    await context.close()
  })

  await test('EVM Connect closes the menu and opens the existing RainbowKit wallet dialog on top', async () => {
    const { context, page } = await open()
    await openMenu(page); await row(page, 'EVM').getByRole('button', { name: 'Connect' }).click()
    await menu(page).waitFor({ state: 'detached' })
    await page.getByRole('dialog').filter({ hasText: /Connect a Wallet/i }).waitFor()
    await context.close()
  })

  await test('network: the menu switches Mainnet/Testnet; the header shows it; testnet keeps its own items (Lending, Faucet)', async () => {
    const { context, page } = await open()
    await openMenu(page); await menu(page).getByRole('button', { name: 'Testnet' }).click()
    await page.getByLabel('Network: Testnet').waitFor()
    assert.equal(await menu(page).getByRole('button', { name: 'Testnet' }).getAttribute('aria-pressed'), 'true')
    const nav = menu(page).getByRole('region', { name: 'Navigation' })
    for (const tab of ['Swap', 'Bridge', 'Dashboard']) await nav.getByRole('button', { name: tab }).waitFor()
    assert.equal(await nav.getByRole('button', { name: 'Earn' }).count(), 0)
    assert.equal(await nav.getByRole('link', { name: /Arc Machina/ }).getAttribute('href'), 'https://arcmachina.xyz/')
    assert.equal(await nav.getByRole('link', { name: /Faucet/ }).getAttribute('href'), 'https://faucet.circle.com/')
    await menu(page).getByRole('button', { name: 'Mainnet' }).click(); await page.getByLabel('Network: Mainnet').waitFor()
    for (const tab of ['Bridge', 'Swap', 'Earn', 'Dashboard', 'Activity']) await nav.getByRole('button', { name: tab }).waitFor()
    await context.close()
  })

  await test('navigating while transfers are open leaves journals, recovery records and locks untouched and asks no wallet for anything', async () => {
    const { context, page } = await open({ phantomMode: 'accept' })
    const owner = '0xafbb6cc5c0a9c0eb1bff8db2ed807e83aab8e321'
    await page.evaluate(owner => {
      localStorage.setItem('machina.earn.journal.v1', JSON.stringify([{ id: 'earn-open', account: owner, chainId: 5042, vault: '0x8e357432cc12ff425c36432f312968aeb16112af', action: 'deposit', amount: '0.25', amountRaw: '250000', createdAt: 1, updatedAt: 1, attemptNonce: 3, attemptBlock: 5000, requests: [{ kind: 'execute', state: 'hash', hash: '0x' + 'ab'.repeat(32) }], outcome: 'unknown', executeHash: '0x' + 'ab'.repeat(32) }]))
      localStorage.setItem('machina_mainnet_transfers_v1', JSON.stringify([{ id: 'evm-burning', stage: 'burning', walletAddress: owner }]))
      localStorage.setItem('machina_mainnet_sui_transfers_v1', JSON.stringify([{ id: 'sui-open', stage: 'waiting_attestation' }]))
    }, owner)
    await page.reload(); await trigger(page).waitFor()
    const snapshot = () => page.evaluate(() => Object.fromEntries(['machina.earn.journal.v1', 'machina_mainnet_transfers_v1', 'machina_mainnet_sui_transfers_v1'].map(k => [k, localStorage.getItem(k)])))
    const locks = () => page.evaluate(async () => { const q = await navigator.locks.query(); return { held: q.held.map(l => l.name), pending: q.pending.map(l => l.name) } })
    await page.waitForTimeout(800); const before = await snapshot(), locksBefore = await locks()
    for (const tab of ['Earn', 'Swap', 'Dashboard', 'Activity', 'Bridge', 'Earn']) { await openMenu(page); await menu(page).getByRole('button', { name: tab }).click(); await menu(page).waitFor({ state: 'detached' }); await page.waitForTimeout(250) }
    await openMenu(page); await page.keyboard.press('Escape')
    assert.deepEqual(await snapshot(), before, 'journal, EVM and Sui transfer records unchanged by navigation')
    assert.deepEqual(await locks(), locksBefore, 'no lock taken or released by navigation')
    assert.deepEqual(await page.evaluate(() => window.phantomTest.calls), [], 'no wallet request')
    await context.close()
  })

  await test('desktop (1280 px): the existing header, tab row and wallet chips are unchanged and no menu button exists; a wallet error now sits under its own chip and can be closed', async () => {
    const { context, page } = await open({ width: 1280, height: 900, mobile: false, phantomMode: 'reject' })
    assert.equal(await trigger(page).count(), 0)
    for (const tab of ['Bridge', 'Swap', 'Earn', 'Dashboard', 'Activity']) await page.getByRole('button', { name: tab, exact: true }).waitFor()
    for (const family of ['EVM', 'Solana', 'Sui']) await page.getByLabel(`${family} wallet`, { exact: true }).waitFor()
    await page.getByLabel('Network environment').waitFor()
    await page.getByLabel('Solana wallet', { exact: true }).getByRole('button', { name: 'Connect' }).click()
    const alert = page.getByRole('alert').filter({ hasText: 'User rejected the request.' }); await alert.waitFor()
    const chip = await page.getByLabel('Solana wallet', { exact: true }).boundingBox(), a = await alert.boundingBox()
    assert.ok(a.y >= chip.y + chip.height - 1 && Math.abs(a.x - chip.x) < 2, 'directly under the Solana chip')
    await page.getByRole('button', { name: 'Dismiss Solana wallet error' }).click(); assert.equal(await alert.count(), 0)
    await context.close()
  })

  assert.deepEqual(errors, [], 'no uncaught page errors')
  console.log(`RESULT ${count}/${count} mobile header/menu groups PASS; real App entry at 320/375/390/430 px and desktop; no network, signatures or transactions.`)
} finally { await browser?.close(); await server.close() }
