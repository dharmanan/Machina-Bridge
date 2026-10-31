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
  await test('EVM recovery sits inside the EVM bridge card, below the form; the Solana view has only its own Solana recovery', async () => {
    await page.goto(base); const recovery = page.locator('details', { hasText: 'Recover Transfer' }); await recovery.waitFor()
    const placement = await recovery.evaluate(el => { const card = el.closest('.rounded-3xl'), button = [...card.querySelectorAll('button')].find(b => /Bridge|Connect|Review|Unlock|locked/i.test(b.textContent) && b.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING); return { inCard: Boolean(card && card.textContent.includes('Bridge USDC')), afterAction: Boolean(button) } })
    assert.deepEqual(placement, { inCard: true, afterAction: true })
    await page.getByRole('button', { name: 'Solana Bridge' }).click(); await page.getByRole('region', { name: 'Solana Mainnet bridge' }).waitFor()
    assert.equal(await page.getByText('Recover Transfer', { exact: true }).count(), 0)
    await page.getByText('Recover an older Arc → Solana transfer').waitFor()
  })
  await test('desktop and mobile: EVM, Solana and Sui bridge cards share the same position, width, padding and frame', async () => {
    for (const [name, width, height] of [['desktop', 1280, 900], ['mobile', 390, 844]]) {
      await page.setViewportSize({ width, height }); await page.goto(base)
      const frame = loc => loc.evaluate(el => { const r = el.getBoundingClientRect(), s = getComputedStyle(el); return { x: Math.round(r.x), w: Math.round(r.width), pad: s.paddingLeft, radius: s.borderTopLeftRadius, shadow: s.boxShadow } })
      const evmCard = page.getByText('Bridge USDC').first().locator('xpath=ancestor::div[contains(@class,"rounded-3xl")][1]'); await evmCard.waitFor()
      const evm = await frame(evmCard)
      await page.getByRole('button', { name: 'Solana Bridge' }).click(); const sol = await frame(page.getByRole('region', { name: 'Solana Mainnet bridge' }))
      await page.getByRole('button', { name: 'Sui Bridge' }).click(); const sui = await frame(page.getByRole('region', { name: 'Sui Mainnet bridge' }))
      assert.deepEqual(sol, evm, `${name} Solana card`); assert.deepEqual(sui, evm, `${name} Sui card`)
    }
    await page.setViewportSize({ width: 1280, height: 900 })
  })
  await test('EVM connect list: when the browser wallet is MetaMask, only the MetaMask option is offered (no second "Browser Wallet" on the same provider); Rabby, other injected wallets and no wallet keep "Browser Wallet"; Rabby and Coinbase options stay', async () => {
    for (const [name, provider] of [['MetaMask', { isMetaMask: true }], ['Rabby (also sets isMetaMask)', { isMetaMask: true, isRabby: true }], ['other wallet', { isMetaMask: false }], ['none', null]]) {
      const desk = await browser.newContext({ viewport: { width: 1280, height: 900 } })
      await desk.route('**/*', route => { const u = new URL(route.request().url()); if (u.hostname === '127.0.0.1') return route.continue(); external.push(u.hostname); return route.abort() })
      if (provider) await desk.addInitScript(flags => { window.ethereum = { ...flags, request: async ({ method }) => method === 'eth_accounts' ? [] : method === 'eth_chainId' ? '0x1' : null, on() {}, removeListener() {} } }, provider)
      const p = await desk.newPage(); await p.goto(base); await p.evaluate(() => localStorage.setItem('machina_app_network', 'mainnet')); await p.goto(base)
      await p.getByLabel('EVM wallet').getByRole('button').click(); const list = p.getByRole('dialog').last(); await list.waitFor(); await p.waitForTimeout(500)
      assert.equal(await p.getByTestId('rk-wallet-option-metaMask').count(), 1, `${name}: MetaMask offered`)
      for (const id of ['rabby', 'coinbase']) assert.equal(await p.getByTestId(`rk-wallet-option-${id}`).count(), 1, `${name}: ${id} offered`)
      assert.equal(await p.getByTestId('rk-wallet-option-injected').count(), name === 'MetaMask' ? 0 : 1, `${name}: Browser Wallet ${name === 'MetaMask' ? 'hidden' : 'kept'}`)
      await desk.close()
    }
  })
  await test('EVM: the connected wallet keeps the connection; an idle option on the same browser provider (Rabby falls back to window.ethereum) does not take it over on the wallet\'s accountsChanged event', async () => {
    const desk = await browser.newContext({ viewport: { width: 1280, height: 900 } })
    await desk.route('**/*', route => { const u = new URL(route.request().url()); if (u.hostname === '127.0.0.1') return route.continue(); external.push(u.hostname); return route.abort() })
    // A non-MetaMask browser wallet (so "Browser Wallet" is offered) that approves eth_requestAccounts and can emit events.
    await desk.addInitScript(() => {
      const listeners = {}, account = '0x' + 'ab'.repeat(20); let approved = false
      window.ethereum = {
        request: async ({ method }) => method === 'eth_requestAccounts' ? (approved = true, [account]) : method === 'eth_accounts' ? (approved ? [account] : []) : method === 'eth_chainId' ? '0x13b2' : method === 'wallet_requestPermissions' ? [{ parentCapability: 'eth_accounts' }] : method === 'wallet_getPermissions' ? [] : null,
        on(e, f) { (listeners[e] ||= []).push(f) }, removeListener(e, f) { listeners[e] = (listeners[e] || []).filter(x => x !== f) },
      }
      window.emitWallet = (e, v) => (listeners[e] || []).slice().forEach(f => f(v))
    })
    const p = await desk.newPage(); await p.goto(base); await p.evaluate(() => localStorage.setItem('machina_app_network', 'mainnet')); await p.goto(base)
    const chip = p.getByLabel('EVM wallet')
    await chip.getByRole('button').click(); await p.getByRole('dialog').last().waitFor(); await p.getByTestId('rk-wallet-option-injected').click()
    await chip.getByText(/^Browser Wallet · 0xabab/i).waitFor({ timeout: 20000 })
    // The wallet re-announces its accounts (as MetaMask does after connecting); every idle option on this provider hears it.
    await p.evaluate(() => window.emitWallet('accountsChanged', ['0x' + 'ab'.repeat(20)])); await p.waitForTimeout(1500)
    assert.match(await chip.innerText(), /Browser Wallet · 0xabab/i, 'the connected option keeps the connection')
    assert.doesNotMatch(await chip.innerText(), /Rabby/)
    await desk.close()
  })
  await test('iPhone browser without an EVM wallet (e.g. the Slush app browser): Sui Bridge recommends a desktop browser instead of the WalletConnect hand-off; with an injected EVM wallet it asks to connect as usual', async () => {
    for (const injected of [false, true]) {
      const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148' })
      await phone.route('**/*', route => { const u = new URL(route.request().url()); if (u.hostname === '127.0.0.1') return route.continue(); external.push(u.hostname); return route.abort() })
      if (injected) await phone.addInitScript(() => { window.ethereum = { request: async ({ method }) => method === 'eth_accounts' || method === 'eth_requestAccounts' ? [] : method === 'eth_chainId' ? '0x1' : null, on() {}, removeListener() {} } })
      const p = await phone.newPage(); const errs = []; p.on('pageerror', e => errs.push(e.message))
      await p.goto(base); await p.evaluate(() => localStorage.setItem('machina_app_network', 'mainnet')); await p.goto(base)
      await p.getByRole('button', { name: 'Sui Bridge' }).click(); const bridge = p.getByRole('region', { name: 'Sui Mainnet bridge' }); await bridge.waitFor()
      const hint = bridge.getByText(/This phone browser has no built-in EVM wallet\..*Use a desktop browser with the MetaMask and Slush extensions\./)
      if (injected) { await bridge.getByText('Connect your EVM wallet (Arc) in the top bar.').waitFor(); assert.equal(await hint.count(), 0) }
      else { await hint.waitFor(); assert.equal(await bridge.getByText('Connect your EVM wallet (Arc) in the top bar.').count(), 0); await p.screenshot({ path: `${out}/sui-phone-desktop-hint.png`, fullPage: true }) }
      assert.deepEqual(errs, []); await phone.close()
    }
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
