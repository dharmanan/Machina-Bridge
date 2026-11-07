// Testnet Bridge history after removing the legacy server transfer storage (Redis/Upstash).
// Real BridgeTab + useBridgeKit + localStorage in Chromium; controlled wallet identity and Iris sandbox.
// No network, no wallet request, signature, burn, mint or claim. Legacy /api/transfers|activities must never be called.
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'

const require = createRequire(import.meta.url)
let chromium
try { ({ chromium } = require(process.env.PLAYWRIGHT_CORE_PATH ?? 'playwright-core')) } catch { ({ chromium } = require('playwright-core')) }
const root = fileURLToPath(new URL('..', import.meta.url))
let count = 0
async function test(name, fn) { await fn(); count++; console.log('PASS ' + name) }

// ---------------- static: the legacy storage is gone from every active path ----------------
const files = dir => readdirSync(dir).flatMap(n => { const p = join(dir, n); return statSync(p).isDirectory() ? files(p) : /\.(tsx?|m?js)$/.test(n) ? [p] : [] })
await test('legacy server transfer storage is removed: no route, helper, client module, script or reference remains', () => {
  for (const f of ['api/transfers.js', 'api/transfers-update.js', 'api/activities.js', 'api/cron/attestations.js', 'api/_lib/redis.js',
    'api/_lib/transfers.js', 'api/_lib/activities.js', 'api/_lib/security.js', 'api/_lib/validate.js', 'src/lib/transferTrackerApi.ts',
    'scripts/flush-redis-bridge-keys.mjs']) assert.equal(existsSync(join(root, f)), false, `${f} must stay removed`)
  const vercel = JSON.parse(readFileSync(join(root, 'vercel.json'), 'utf8'))
  assert.equal(vercel.crons, undefined, 'no scheduled cron')
  for (const p of ['src', 'api', 'server'].flatMap(d => files(join(root, d)))) {
    const text = readFileSync(p, 'utf8'), file = relative(root, p)
    assert.doesNotMatch(text, /redis|upstash/i, `${file}: no Redis/Upstash`)
    assert.doesNotMatch(text, /\/api\/(transfers|activities|cron)\b|transfers-update|transferTrackerApi|BRIDGE_CRON_SECRET|CIRCLE_ATTESTATION_STATUS_URL/, `${file}: no legacy transfer storage path`)
  }
})
await test('Mainnet entry graphs never reach the Testnet history modules', () => {
  const graph = entry => {
    const seen = new Set()
    const walk = f => {
      if (seen.has(f)) return; seen.add(f)
      const t = readFileSync(f, 'utf8')
      for (const m of t.matchAll(/(?:import|export)[^'"]*?from\s*['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/g)) {
        const s = m[1] || m[2]; if (!s.startsWith('.')) continue
        const b = join(f, '..', s)
        for (const c of [b, b + '.ts', b + '.tsx', b + '/index.ts', b + '/index.tsx']) if (existsSync(c) && statSync(c).isFile()) { walk(c); break }
      }
    }
    walk(join(root, entry)); return [...seen].map(f => relative(root, f))
  }
  for (const entry of ['src/components/MainnetPreviewGate.tsx', 'src/components/MainnetDashboard.tsx', 'src/components/MainnetWalletActivity.tsx',
    'src/components/MainnetEarnPreview.tsx', 'src/components/MainnetSwapScreen.tsx']) {
    const g = graph(entry)
    for (const testnetOnly of ['src/lib/localBridgeActivity.ts', 'src/hooks/useBridgeKit.ts', 'src/components/BridgeTab.tsx', 'src/components/DashboardTab.tsx']) {
      assert.equal(g.includes(testnetOnly), false, `${entry} must not reach ${testnetOnly}`)
    }
  }
})

// ---------------- browser: real BridgeTab with local records ----------------
const SEPOLIA = 11155111, ARC = 5042002, A = '0x1111111111111111111111111111111111111111', B = '0x2222222222222222222222222222222222222222'
const hash = n => '0x' + n.repeat(64).slice(0, 64)
const now = Date.now()
const rec = (wallet, id, amount, status, h, extra = {}) => ({ id, walletAddress: wallet, sourceChainId: SEPOLIA, destinationChainId: ARC, amount, token: 'USDC',
  startedAt: now - 600_000, updatedAt: now - 60_000, status, step: status === 'minted' ? 'success' : 'waiting-receive-message', sourceTxHash: h, txHashes: [h], ...extra })
const PENDING_A = rec(A, 'activity-pending-a', '1.11', 'pending_attestation', hash('1'))
const READY_UNVERIFIED_A = rec(A, 'activity-ready-unverified-a', '2.22', 'ready_to_mint', hash('2'))
const MINTED_A = rec(A, 'activity-minted-a', '3.33', 'minted', hash('3'), { receiveTxHash: hash('d') })
const PENDING_B = rec(B, 'activity-pending-b', '4.44', 'pending_attestation', hash('4'))
const READY_VERIFIED_A = rec(A, 'activity-ready-verified-a', '5.55', 'ready_to_mint', hash('5'))
const SEED = [PENDING_A, READY_UNVERIFIED_A, MINTED_A, PENDING_B, READY_VERIFIED_A]
// The resume record of the pending transfer (same id/hash as PENDING_A).
const PENDING_BRIDGE = { ...PENDING_A }
const irisCalls = [], legacyCalls = [], external = []
const iris = sourceTxHash => sourceTxHash.toLowerCase() === READY_VERIFIED_A.sourceTxHash
  ? { messages: [{ status: 'complete', attestation: '0x' + 'ab'.repeat(65), destinationDomain: 26, eventNonce: '0x' + '01'.repeat(32), message: '0x01' }] }
  : { messages: [{ status: 'pending_confirmations', attestation: 'PENDING', message: '0x' }] }

const server = await createServer({ root, configFile: false, cacheDir: '/tmp/machina-testnet-bridge-history-ui', logLevel: 'error', server: { host: '127.0.0.1', port: 0 },
  plugins: [{ name: 'controlled-testnet-wallet', enforce: 'pre',
    resolveId(id) { if (id === 'wagmi') return '\0tb-wagmi'; if (id === 'wagmi/actions') return '\0tb-wagmi-actions'; if (/\/lib\/wagmi\.config(\.ts)?$/.test(id)) return '\0tb-wagmi-config' },
    load(id) {
      if (id === '\0tb-wagmi') return `import { useSyncExternalStore } from 'react'
const s = () => window.bridgeUi
export function useAccount() { const address = useSyncExternalStore(cb => s().subscribe(cb), () => s().address); return { address, isConnected: true, chainId: ${SEPOLIA}, status: 'connected', connector: { name: 'MetaMask' } } }
export function useSwitchChain() { return { switchChainAsync: async () => { s().walletRequests.push('switchChain'); throw new Error('Unexpected wallet request') }, isPending: false } }
export function useWalletClient() { return { data: undefined } }
export function createConfig() { return {} }
export function createConnector(f) { return f }`
      if (id === '\0tb-wagmi-actions') return `export async function getWalletClient() { window.bridgeUi.walletRequests.push('getWalletClient'); throw new Error('Unexpected wallet request') }`
      if (id === '\0tb-wagmi-config') return 'export const wagmiConfig = {}'
    },
    configureServer(s) { s.middlewares.use('/__testnet-bridge', async (_req, res) => { res.setHeader('Content-Type', 'text/html'); res.end(await s.transformIndexHtml('/__testnet-bridge', '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module" src="/scripts/fixtures/testnet-bridge-history-ui.tsx"></script></body></html>')) }) } }] })
await server.listen()
const base = `http://127.0.0.1:${server.httpServer.address().port}/__testnet-bridge`
let browser
try {
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] })
  const context = await browser.newContext()
  await context.route('**/*', route => {
    const u = new URL(route.request().url())
    if (/^\/api\/(transfers|activities|cron)|^\/api\/transfers-update/.test(u.pathname)) { legacyCalls.push(u.pathname); return route.fulfill({ status: 404, body: '' }) }
    if (u.hostname === '127.0.0.1') return route.continue()
    if (u.hostname === 'iris-api-sandbox.circle.com' && u.pathname.startsWith('/v2/messages/')) { irisCalls.push(u.searchParams.get('transactionHash')); return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(iris(u.searchParams.get('transactionHash') ?? '')) }) }
    external.push(u.hostname); return route.abort()
  })
  await context.addInitScript(([seed, pending]) => {
    if (!sessionStorage.getItem('seeded')) { localStorage.setItem('arc_bridge_activity', JSON.stringify(seed)); localStorage.setItem('arc_pending_bridge', JSON.stringify(pending)); sessionStorage.setItem('seeded', '1') }
  }, [SEED, PENDING_BRIDGE])
  const page = await context.newPage()
  const errors = []; page.on('pageerror', e => errors.push(e.message))
  const stored = () => page.evaluate(() => ({ activity: JSON.parse(localStorage.getItem('arc_bridge_activity') || '[]'), pending: localStorage.getItem('arc_pending_bridge'), requests: [...window.bridgeUi.walletRequests] }))
  const activity = () => page.getByRole('dialog', { name: 'Activity' })
  const openActivity = async () => { if (!(await activity().isVisible().catch(() => false))) await page.getByTitle('Open activity').click(); await activity().waitFor() }
  const row = amount => activity().locator('div.rounded-xl').filter({ hasText: `${amount} USDC` })
  const waitIdle = () => page.waitForFunction(() => !document.querySelector('[role="dialog"] .animate-spin'), null, { timeout: 30_000 })

  await page.goto(base); await page.getByRole('heading', { name: 'Bridge USDC' }).waitFor()

  await test('Bridge screen opens with only local records: In Progress, Ready to Mint and Completed for this wallet; no legacy API request', async () => {
    await openActivity(); await waitIdle()
    await row('1.11').first().waitFor(); await row('2.22').first().waitFor(); await row('3.33').first().waitFor(); await row('5.55').first().waitFor()
    assert.equal(await row('4.44').count(), 0, 'another wallet\'s record is not shown')
    assert.deepEqual(legacyCalls, []); assert.deepEqual(errors, [])
  })
  await test('Mint opens only after Iris confirms: local "ready_to_mint" without Iris confirmation stays disabled', async () => {
    await page.waitForFunction(() => [...document.querySelectorAll('[role="dialog"] p')].some(p => p.textContent === 'Verification: confirmed'), null, { timeout: 30_000 })
    const verified = row('5.55').filter({ hasText: 'Ready to mint' }).first(), unverified = row('2.22').filter({ hasText: 'Ready to mint' }).first()
    await verified.getByText('Verification: confirmed').waitFor(); await unverified.getByText('Verification: not confirmed').waitFor()
    assert.equal(await unverified.getByRole('button', { name: 'Mint', exact: true }).isDisabled(), true)
    assert.equal(await verified.getByRole('button', { name: 'Mint', exact: true }).isDisabled(), false)
    assert.ok(irisCalls.some(h => h?.toLowerCase() === READY_VERIFIED_A.sourceTxHash), 'readiness was read from Iris')
    assert.deepEqual((await stored()).requests, [], 'Mint is never clicked here; nothing requested from the wallet')
  })
  await test('Dismiss works without any server: the row disappears and only this wallet\'s local record becomes "dismissed"', async () => {
    const before = await stored()
    await row('2.22').first().getByRole('button', { name: 'Dismiss' }).click()
    await page.waitForFunction(() => ![...document.querySelectorAll('[role="dialog"] p')].some(p => p.textContent === '2.22 USDC'), null, { timeout: 15_000 })
    const after = await stored()
    const byId = list => Object.fromEntries(list.map(r => [r.id, r]))
    assert.equal(byId(after.activity)[READY_UNVERIFIED_A.id].status, 'dismissed')
    for (const r of before.activity.filter(r => r.id !== READY_UNVERIFIED_A.id)) assert.equal(byId(after.activity)[r.id].status, r.status, `${r.id} unchanged`)
    assert.equal(after.pending, before.pending, 'the pending resume record is untouched')
    assert.deepEqual(after.requests, []); assert.deepEqual(legacyCalls, [])
  })
  await test('dismissing the active pending transfer hides its history row but keeps the pending resume record (recovery is not cancelled)', async () => {
    const before = await stored()
    await row('1.11').first().getByRole('button', { name: 'Dismiss' }).click()
    await page.waitForFunction(() => ![...document.querySelectorAll('[role="dialog"] p')].some(p => p.textContent === '1.11 USDC'), null, { timeout: 15_000 })
    const after = await stored()
    assert.equal(after.activity.find(r => r.id === PENDING_A.id).status, 'dismissed')
    // The resume record is kept. useBridgeKit's existing activity->pending status sync (unchanged by this
    // cleanup) mirrors the hidden state; every transfer field needed to track or recover it stays identical.
    assert.ok(after.pending, 'arc_pending_bridge is not removed')
    const { status: beforeStatus, ...beforeFields } = JSON.parse(before.pending), { status: afterStatus, ...afterFields } = JSON.parse(after.pending)
    assert.deepEqual(afterFields, beforeFields, 'id, wallet, chains, amount, source hash and tx hashes unchanged')
    assert.equal(beforeStatus, 'pending_attestation'); assert.ok(['pending_attestation', 'dismissed'].includes(afterStatus), afterStatus)
    const card = await page.getByText('1.11 USDC from').first().locator('..').innerText()
    assert.doesNotMatch(card, /fail|cancel|complete/i, 'hiding the row never presents the on-chain transfer as failed, cancelled or completed')
    assert.deepEqual(after.requests, [])
  })
  await test('after reload: dismissed rows stay hidden, the completed row and the verified ready row remain, the pending transfer is still tracked', async () => {
    await page.reload(); await page.getByRole('heading', { name: 'Bridge USDC' }).waitFor()
    await page.getByText('1.11 USDC from').first().waitFor({ timeout: 30_000 })
    const s = await stored(); assert.ok(s.pending && JSON.parse(s.pending).sourceTxHash === PENDING_A.sourceTxHash, 'pending resume record survived the reload')
    await openActivity(); await waitIdle()
    await row('3.33').first().waitFor(); await row('5.55').first().waitFor()
    assert.equal(await row('2.22').count(), 0); assert.equal(await row('1.11').count(), 0)
    assert.deepEqual(legacyCalls, []); assert.deepEqual(errors, [])
  })
  await test('changing the wallet shows only that wallet\'s history; switching back restores the first wallet\'s view', async () => {
    await page.evaluate(b => window.bridgeUi.change(b), B)
    await row('4.44').first().waitFor({ timeout: 30_000 })
    for (const a of ['1.11', '2.22', '3.33', '5.55']) assert.equal(await row(a).count(), 0, `${a} belongs to wallet A`)
    await page.evaluate(a => window.bridgeUi.change(a), A)
    await row('3.33').first().waitFor({ timeout: 30_000 }); assert.equal(await row('4.44').count(), 0)
  })
  await test('the whole session sent no wallet request, signature, burn, mint or claim, and never called the legacy storage API', async () => {
    const s = await stored()
    assert.deepEqual(s.requests, []); assert.deepEqual(legacyCalls, []); assert.deepEqual(errors, [])
    assert.ok(s.activity.find(r => r.id === MINTED_A.id).status === 'minted' && s.activity.find(r => r.id === PENDING_B.id).status === 'pending_attestation')
  })
} finally { await browser?.close(); await server.close() }
console.log(`RESULT ${count}/${count} Testnet Bridge history groups PASS; real BridgeTab/useBridgeKit/localStorage, controlled wallet and Iris; no legacy storage API, wallet request or transaction (blocked hosts: ${[...new Set(external)].join(', ') || 'none'})`)
