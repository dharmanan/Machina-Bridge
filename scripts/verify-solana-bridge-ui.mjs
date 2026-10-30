// Chromium: the Solana Bridge panel uses the same layout as the Sui Bridge
// (From / switch / To cards, Amount, fee rows, one Review action, collapsible
// recovery) and adds a Review -> Confirm step before any wallet request.
// The real component renders; wagmi, Phantom and the Solana CCTP hook are
// controlled stand-ins. No network, no signature, no transaction.
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'
import react from '@vitejs/plugin-react'
const require = createRequire(import.meta.url)
let chromium; try { ({ chromium } = require('playwright-core')) } catch { ({ chromium } = require(process.env.PLAYWRIGHT_CORE_PATH ?? '/opt/codex/runtimes/cua/lib/node_modules/playwright-core')) }
const root = fileURLToPath(new URL('..', import.meta.url))
const EVM = '0xafbb6cc5c0a9c0eb1bff8db2ed807e83aab8e321', SOL = '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU'

const store = `import { useSyncExternalStore } from 'react'
const T = window.solTest
export const useT = () => useSyncExternalStore(l => { T.listeners.add(l); return () => T.listeners.delete(l) }, () => T.snapshot)`
const wagmiMock = `import { useT } from '\\0sb-store'
export function useAccount(){ const s = useT(); return { address: s.evm, isConnected: Boolean(s.evm), chainId: 5042, connector: s.evm ? { name: 'MetaMask' } : undefined } }`
const phantomMock = `import { useT } from '\\0sb-store'
export function usePhantomSolana(){ const s = useT(); return { address: s.sol, isConnected: Boolean(s.sol), isConnecting: false, provider: s.sol ? {} : null, connect: async () => {}, disconnect: async () => {} } }`
const cctpMock = `import { useT } from '\\0sb-store'
const T = window.solTest
export function useMainnetSolanaCctp(){
  const s = useT()
  return {
    state: s.state, kitSupport: { ready: true, error: null },
    arcBalance: s.arcBalance, arcBalanceError: null, refreshArcBalance: async () => { T.calls.refresh++ },
    solanaBalance: s.solanaBalance, solanaBalanceError: null, refreshSolanaBalance: async () => { T.calls.refresh++ },
    pendingArcToSolanaTx: null, pendingArcToSolanaError: null,
    feeEstimate: s.fee, feeEstimateError: null, isEstimatingFees: false,
    estimateCanary: async (direction, amount) => { T.calls.estimates.push([direction, amount]); T.set({ fee: { bridgeFee: '0', receiveAmount: amount, gasFees: [{ name: 'Mint', token: direction === 'arc-to-solana' ? 'SOL' : 'USDC', amount: direction === 'arc-to-solana' ? '0.00001' : '0.01' }], solanaEventRentSol: direction === 'solana-to-arc' ? '0.0031' : null, solanaEventRentRefundableAfterDays: direction === 'solana-to-arc' ? 5 : null } }) },
    findPendingArcToSolanaBurn: async () => null, recoverPendingArcToSolana: async hash => { T.calls.recover.push(hash ?? null) },
    runCanary: async (direction, amount) => { T.calls.runs.push([direction, amount]); return null },
  }
}`
const reclaimMock = `export async function discoverMainnetSolanaRefunds(){ window.solTest.calls.refunds++; return [] }
export async function loadMainnetSolanaRefundMetadata(){ return {} }
export async function reclaimMainnetSolanaDeposit(){ throw new Error('not used') }`
const boot = `<script>(() => { const T = window.solTest = { listeners: new Set(), calls: { runs: [], estimates: [], recover: [], refresh: 0, refunds: 0 } }
  T.snapshot = { evm: '${EVM}', sol: '${SOL}', arcBalance: '0.453737', solanaBalance: '0.46088', fee: null, state: { isLoading: false, error: null, status: null, result: null } }
  T.set = p => { T.snapshot = { ...T.snapshot, ...p }; T.listeners.forEach(l => l()) } })()</script>`
const server = await createServer({ root, configFile: false, cacheDir: '/tmp/machina-solana-bridge-ui', plugins: [react(), { name: 'solana-bridge-ui', enforce: 'pre',
  resolveId(id) { if (id === '\0sb-store') return id; if (id === 'wagmi') return '\0sb-wagmi'; if (id.endsWith('/hooks/usePhantomSolana')) return '\0sb-phantom'; if (id.endsWith('/hooks/useMainnetSolanaCctp')) return '\0sb-cctp'; if (id.endsWith('/lib/mainnetSolanaReclaim')) return '\0sb-reclaim' },
  load(id) { return { '\0sb-store': store, '\0sb-wagmi': wagmiMock, '\0sb-phantom': phantomMock, '\0sb-cctp': cctpMock, '\0sb-reclaim': reclaimMock }[id] },
  configureServer(s) { s.middlewares.use('/__solana', async (_q, res) => { res.setHeader('Content-Type', 'text/html'); res.end(await s.transformIndexHtml('/__solana', `<!doctype html><html><head><link rel="stylesheet" href="/src/index.css"></head><body><div id="root"></div>${boot}<script type="module" src="/scripts/fixtures/solana-bridge-ui.tsx"></script></body></html>`)) }) } }], server: { host: '127.0.0.1', port: 0 } })
let browser, page, count = 0; const errors = []
async function test(name, fn) { try { await fn() } catch (e) { console.log('PAGE:', (await page?.locator('body').innerText().catch(() => ''))?.slice(0, 1500)); throw e } count++; console.log('PASS ' + name) }
try {
  await server.listen(); const base = `http://127.0.0.1:${server.httpServer.address().port}/__solana`
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] })
  const context = await browser.newContext({ viewport: { width: 1280, height: 1000 } })
  await context.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort())
  page = await context.newPage(); page.on('pageerror', e => errors.push(e.message))
  const open = async () => { await page.goto(base, { timeout: 120_000 }); await page.getByLabel('Bridge amount').waitFor() }
  const set = p => page.evaluate(p => window.solTest.set(p), p)
  const calls = () => page.evaluate(() => window.solTest.calls)
  const panel = () => page.getByRole('region', { name: 'Solana transfer panel' })
  const text = async () => (await panel().innerText()).replace(/\s+/g, ' ')
  const reviewBox = () => page.getByLabel('Review Solana transfer')
  // Optional screenshots for a visual check (MACHINA_SOLANA_SCREEN_DIR); assertions never depend on them.
  const shot = async name => { if (process.env.MACHINA_SOLANA_SCREEN_DIR) await page.screenshot({ path: `${process.env.MACHINA_SOLANA_SCREEN_DIR}/${name}.png`, fullPage: true }) }

  await test('same layout as the Sui Bridge: From card (wallet, balance), switch, To card, Amount above its input, fee rows, one Review action; no route badge', async () => {
    await open()
    assert.equal(await page.getByRole('heading', { level: 2 }).innerText(), 'Solana ↔ Arc')
    const t = await text()
    assert.match(t, /From 0\.453737 USDC Arc Mainnet MetaMask · 0xafbb\.\.\.e321/)
    assert.match(t, /To Solana Mainnet Phantom · 7xKXtg\.\.\.gAsU/)
    assert.match(t, /Circle fee .* Machina fee 0 USDC You receive/)
    assert.doesNotMatch(await page.locator('body').innerText(), /\bVerified\b|\bLimited\b/)
    const [labelBottom, inputTop] = await page.evaluate(() => {
      const input = document.querySelector('input[aria-label="Bridge amount"]'), label = input.closest('label'), range = document.createRange()
      range.selectNodeContents(label.firstChild); return [range.getBoundingClientRect().bottom, input.getBoundingClientRect().top]
    })
    assert.equal(await page.evaluate(() => document.querySelector('input[aria-label="Bridge amount"]').closest('label').firstChild.textContent.trim()), 'Amount')
    assert.ok(labelBottom <= inputTop, 'the Amount label sits above its input')
    assert.equal(await page.getByLabel('Bridge amount').getAttribute('placeholder'), '0.00')
    assert.equal(await page.getByRole('button', { name: 'Switch direction' }).count(), 1)
    assert.equal(await page.getByRole('button', { name: /Review transfer|Enter a valid amount/ }).count(), 1)
    assert.equal(await page.getByText('Recover an older Arc → Solana transfer').count(), 1)
  })
  await test('switching direction swaps the cards, the balance and the collapsible sections; nothing is sent', async () => {
    await open(); await page.getByRole('button', { name: 'Switch direction' }).click()
    const t = await text()
    assert.match(t, /From 0\.46088 USDC Solana Mainnet Phantom/); assert.match(t, /To Arc Mainnet MetaMask/)
    assert.equal(await page.getByText('Recover an older Arc → Solana transfer').count(), 0)
    assert.equal(await page.getByText('Refundable SOL deposits').count(), 1)
    assert.equal((await calls()).runs.length, 0)
  })
  await test('Review -> Confirm: the review shows route, wallets, amount and fees; Cancel sends nothing; Confirm starts the existing transfer exactly once', async () => {
    await open(); await page.getByLabel('Bridge amount').fill('0.25')
    await page.waitForFunction(() => window.solTest.calls.estimates.length > 0)
    assert.match(await text(), /Circle fee 0 USDC Machina fee 0 USDC You receive ≈ 0\.25 USDC Solana network fee 0\.00001 SOL · paid when you receive/)
    await shot('solana-form-desktop')
    await page.getByRole('button', { name: 'Review transfer' }).click()
    await shot('solana-review-desktop'); const r = (await reviewBox().innerText()).replace(/\s+/g, ' ')
    assert.match(r, /Review Arc → Solana · 0\.25 USDC/); assert.match(r, /From Arc Mainnet · MetaMask · 0xafbb\.\.\.e321/); assert.match(r, /To Solana Mainnet · Phantom · 7xKXtg\.\.\.gAsU/)
    await page.getByRole('button', { name: 'Cancel' }).click(); assert.equal(await reviewBox().count(), 0); assert.equal((await calls()).runs.length, 0)
    await page.getByRole('button', { name: 'Review transfer' }).click()
    await page.evaluate(() => { const b = [...document.querySelectorAll('button')].find(x => x.textContent.includes('Confirm and start transfer')); b.click(); b.click() })
    await page.waitForFunction(() => window.solTest.calls.runs.length > 0)
    assert.deepEqual((await calls()).runs, [['arc-to-solana', '0.25']])
  })
  await test('editing the amount or the direction drops an open Review', async () => {
    await open(); await page.getByLabel('Bridge amount').fill('0.25'); await page.getByRole('button', { name: 'Review transfer' }).click(); await reviewBox().waitFor()
    await page.getByLabel('Bridge amount').fill('0.3'); await reviewBox().waitFor({ state: 'detached' })
    await page.getByRole('button', { name: 'Review transfer' }).click(); await reviewBox().waitFor()
    await page.getByRole('button', { name: 'Switch direction' }).click(); await reviewBox().waitFor({ state: 'detached' })
    assert.equal((await calls()).runs.length, 0)
  })
  await test('without a Phantom wallet the card says where to connect and Review stays locked', async () => {
    await open(); await set({ sol: null }); await page.getByLabel('Bridge amount').fill('0.25')
    const t = await text(); assert.match(t, /To Solana Mainnet Not connected · use the top bar/); assert.match(t, /Connect Phantom \(Solana\) in the top bar\./)
    assert.equal(await page.getByRole('button', { name: /Review transfer|Enter a valid amount/ }).isDisabled(), true)
  })
  await test('a running transfer locks the form and the direction switch', async () => {
    await open(); await set({ state: { isLoading: true, error: null, status: 'Waiting for MetaMask…', result: null } })
    assert.equal(await page.getByRole('button', { name: 'Transfer in progress…' }).isDisabled(), true)
    assert.equal(await page.getByRole('button', { name: 'Switch direction' }).isDisabled(), true)
    assert.equal(await page.getByLabel('Bridge amount').isDisabled(), true)
    assert.match(await text(), /Waiting for MetaMask…/)
  })
  await test('fits a phone (390 px) without horizontal scrolling', async () => {
    await page.setViewportSize({ width: 390, height: 900 }); await open(); await page.getByLabel('Bridge amount').fill('0.25')
    await page.getByRole('button', { name: 'Review transfer' }).click(); await reviewBox().waitFor()
    await shot('solana-review-mobile'); assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1))
  })
  assert.deepEqual(errors, [], 'no page errors')
  console.log(`RESULT ${count}/${count} Solana Bridge UI groups PASS; real component, controlled wallets and CCTP hook; no network.`)
} finally { await browser?.close(); await server.close() }
