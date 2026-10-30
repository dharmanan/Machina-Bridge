// MANUAL, LIVE, READ-ONLY: recovery of the real Mainnet transfers through the
// real Sui Bridge UI in Chromium, then Dashboard/Activity consistency.
// Only allow-listed READ methods are forwarded to Arc (JSON-RPC), Sui (gRPC-web)
// and Circle Iris (GET); everything else is aborted and reported. The wallets
// expose identities only: no provider, no signing, no transaction.
//   NODE_USE_ENV_PROXY=1 node scripts/verify-sui-live-recovery.mjs
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdirSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'
const require = createRequire(import.meta.url)
const REAL = require('./fixtures/real-sui-transfers.json')
let chromium; try { ({ chromium } = require('playwright-core')) } catch { ({ chromium } = require('/opt/codex/runtimes/cua/lib/node_modules/playwright-core')) }
const root = fileURLToPath(new URL('..', import.meta.url)), out = process.env.MACHINA_SUI_SCREEN_DIR || '/tmp/machina-sui-live-recovery'; mkdirSync(out, { recursive: true })
const ARC = REAL.transfers[0], SUI = REAL.transfers[2] // 0x2cf8f5a5… (Arc -> Sui) and 8nmDq8Hj… (Sui -> Arc)
assert.equal(ARC.source, '0x2cf8f5a53f6c0deb8adeb527bd693e2977f7a403b4750da4a37c6adb5f6eac37'); assert.equal(SUI.source, '8nmDq8Hj7kTSG5nZ7HHY7hxSzkTDKP7R7pLxP33khehb')
// wagmi stand-in: the EVM identity (address/chain) only; there is no connector provider, so no wallet request is possible.
const wagmiMock = `import { useSyncExternalStore } from 'react'
const evm = window.__evm ??= { address: '${REAL.evm}', chainId: 5042, listeners: new Set() }
window.__setEvm = p => { Object.assign(evm, p); evm.snapshot = { ...evm }; evm.listeners.forEach(l => l()) }; evm.snapshot = { ...evm }
export function useAccount(){ const s = useSyncExternalStore(l => { evm.listeners.add(l); return () => evm.listeners.delete(l) }, () => evm.snapshot); return { address: s.address, isConnected: Boolean(s.address), chainId: s.chainId, connector: { name: 'MetaMask (identity only)' } } }
export function useSwitchChain(){ return { switchChainAsync: async () => { throw Error('not available') } } }
export function useReadContract(){ return { data: undefined, refetch: async () => ({ data: undefined }) } }`
const server = await createServer({ root, configFile: false, cacheDir: '/tmp/machina-sui-live-recovery', plugins: [{ name: 'live-recovery', enforce: 'pre',
  resolveId(id) { if (id === 'wagmi') return '\0live-wagmi'; if (id === 'wagmi/actions') return '\0live-wagmi-actions'; if (id.endsWith('/lib/wagmi.config')) return '\0live-wagmi-config' },
  load(id) { if (id === '\0live-wagmi') return wagmiMock; if (id === '\0live-wagmi-actions') return 'export async function getWalletClient(){throw Error("not available")}'; if (id === '\0live-wagmi-config') return 'export const wagmiConfig={}' },
  configureServer(s) {
    s.middlewares.use('/api/arc-wallet-activity', (_q, res) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ transactions: [], tokenTransfers: [], limit: 30 })) })
    s.middlewares.use('/__live', async (_q, res) => { res.setHeader('Content-Type', 'text/html'); res.end(await s.transformIndexHtml('/__live', '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module" src="/scripts/fixtures/live-recovery-ui.tsx"></script></body></html>')) })
  } }], server: { host: '127.0.0.1', port: 0 } })

const ARC_READ = new Set(['eth_chainId', 'eth_blockNumber', 'eth_getBlockByNumber', 'eth_getTransactionByHash', 'eth_getTransactionReceipt', 'eth_call', 'eth_getLogs'])
const SUI_READ = new Set(['GetServiceInfo', 'GetBalance', 'GetPackage', 'GetObject', 'BatchGetObjects', 'GetTransaction', 'GetCheckpoint'])
const seen = { arc: {}, sui: {}, iris: 0, blocked: [] }
const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'GET,POST,OPTIONS', 'access-control-expose-headers': 'grpc-status,grpc-message' }
async function forward(route, req) {
  const headers = Object.fromEntries(Object.entries(await req.allHeaders()).filter(([k]) => /^(content-type|accept|x-grpc-web|x-user-agent|grpc-timeout)$/i.test(k)))
  for (let n = 0; ; n++) {
    const r = await fetch(req.url(), { method: req.method(), headers, body: req.method() === 'POST' ? req.postDataBuffer() : undefined })
    if (r.status === 429 && n < 4) { await new Promise(x => setTimeout(x, 1500 * (n + 1))); continue }
    const h = Object.fromEntries([...r.headers].filter(([k]) => /^(content-type|grpc-status|grpc-message)$/i.test(k)))
    return route.fulfill({ status: r.status, headers: { ...h, ...cors }, body: Buffer.from(await r.arrayBuffer()) })
  }
}
let browser, count = 0; const errors = []
async function test(page, name, fn) { try { await fn() } catch (e) { console.error('UI:', (await page.locator('body').innerText().catch(() => '')).slice(0, 2500)); throw e } count++; console.log('PASS ' + name) }
try {
  await server.listen(); const base = `http://127.0.0.1:${server.httpServer.address().port}/__live`
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] })
  async function profile() {
    const context = await browser.newContext({ timezoneId: 'UTC', locale: 'en-US', viewport: { width: 1280, height: 900 } })
    await context.route('**/*', async route => {
      const req = route.request(), url = new URL(req.url())
      if (url.hostname === '127.0.0.1') return route.continue()
      if (url.hostname === 'fonts.googleapis.com') return route.fulfill({ status: 200, contentType: 'text/css', body: '' })
      if (req.method() === 'OPTIONS' && ['rpc.mainnet.arc.io', 'fullnode.mainnet.sui.io'].includes(url.hostname)) return route.fulfill({ status: 204, headers: cors, body: '' })
      if (url.hostname === 'rpc.mainnet.arc.io' && req.method() === 'POST') { const b = req.postDataJSON(), calls = Array.isArray(b) ? b : [b]; if (calls.every(c => ARC_READ.has(c.method))) { calls.forEach(c => seen.arc[c.method] = (seen.arc[c.method] ?? 0) + 1); return forward(route, req) } }
      if (url.hostname === 'fullnode.mainnet.sui.io' && req.method() === 'POST') { const m = url.pathname.split('/').pop(); if (SUI_READ.has(m)) { seen.sui[m] = (seen.sui[m] ?? 0) + 1; return forward(route, req) } }
      if (url.hostname === 'iris-api.circle.com' && req.method() === 'GET') { seen.iris++; return forward(route, req) }
      seen.blocked.push(`${req.method()} ${url.hostname}${url.pathname}${req.method() === 'POST' && /jsonrpc/.test(req.postData() ?? '') ? ' ' + req.postDataJSON().method : ''}`); return route.abort()
    })
    const page = await context.newPage(); page.on('pageerror', e => errors.push(e.message)); await page.goto(base); await page.waitForFunction(() => Boolean(window.liveUi))
    await page.getByRole('button', { name: 'Connect Slush (top bar)' }).click(); await page.getByRole('button', { name: 'Slush connected' }).waitFor()
    return { context, page }
  }
  const recover = async (page, hash) => { if (!(await page.getByLabel('Source transaction to find').isVisible().catch(() => false))) await page.getByText('Recover a transfer from another device or browser').click(); await page.getByLabel('Source transaction to find').fill(hash); await page.getByRole('button', { name: 'Find', exact: true }).click() }
  const panel = page => page.getByRole('region', { name: 'Sui transfer panel' })
  const stored = page => page.evaluate(() => JSON.parse(localStorage.getItem('machina_mainnet_sui_transfers_v1') || '[]'))

  const A = await profile(), p = A.page
  await test(p, 'empty browser: Arc -> Sui 0x2cf8f5a5… is recovered from its source hash: burn, Circle message, Sui nonce read; complete with real source/destination links and the chain start time', async () => {
    assert.deepEqual(await stored(p), [])
    await recover(p, ARC.source); await panel(p).getByRole('status').getByText('Transfer complete', { exact: true }).waitFor({ timeout: 90_000 })
    assert.equal(await panel(p).locator(`a[href="https://explorer.arc.io/tx/${ARC.source}"]`).count(), 1)
    assert.equal(await panel(p).locator(`a[href="https://suiscan.xyz/mainnet/tx/${ARC.destination}"]`).count(), 1)
    assert.match(await panel(p).innerText(), /Started\s+10\/29\/2026, 7:08:35 PM/)
    await panel(p).screenshot({ path: `${out}/live-arc-to-sui-recovered.png` })
  })
  await test(p, 'empty browser: Sui -> Arc 8nmDq8Hj… is recovered; the Arc mint is proven on chain (0x363bea9d…) and linked', async () => {
    await p.getByRole('button', { name: 'Start a new transfer' }).click()
    await recover(p, SUI.source); await panel(p).getByRole('status').getByText('Transfer complete', { exact: true }).waitFor({ timeout: 90_000 })
    assert.equal(await panel(p).locator(`a[href="https://suiscan.xyz/mainnet/tx/${SUI.source}"]`).count(), 1)
    assert.equal(await panel(p).locator(`a[href="https://explorer.arc.io/tx/${SUI.destination}"]`).count(), 1)
    assert.match(await panel(p).innerText(), /Started\s+10\/30\/2026, 12:41:01 AM/)
    const rows = await stored(p); assert.equal(rows.length, 2); assert.deepEqual(rows.map(r => r.destinationTx).sort(), [ARC.destination, SUI.destination].sort())
  })
  await test(p, 'duplicates: recovering the same source again (also as upper-case hex) keeps one row per CCTP event', async () => {
    await p.getByRole('button', { name: 'Start a new transfer' }).click()
    await recover(p, '0x' + ARC.source.slice(2).toUpperCase()); await panel(p).getByRole('status').getByText('Transfer complete', { exact: true }).waitFor({ timeout: 90_000 })
    const rows = await stored(p); assert.equal(rows.length, 2); assert.equal(new Set(rows.map(r => r.id)).size, 2)
    await p.getByText('Transfer history (2)').waitFor()
  })
  await test(p, 'wrong wallets and wrong network are refused with a clear message; nothing is added', async () => {
    await p.evaluate(() => window.liveUi.changeSui('0x' + '0'.repeat(62) + '16')); await p.getByText('Transfer history (0)').waitFor()
    await recover(p, SUI.source); await p.getByRole('alert').getByText('Sui source transaction belongs to another wallet.').waitFor({ timeout: 90_000 })
    await p.evaluate(r => window.liveUi.changeSui(r), REAL.sui); await p.getByText('Transfer history (2)').waitFor()
    await p.evaluate(() => window.__setEvm({ address: '0x' + '11'.repeat(20) })); await p.getByText('Transfer history (0)').waitFor()
    await recover(p, ARC.source); const a = p.getByRole('alert'); await a.waitFor({ timeout: 90_000 }); assert.match(await a.innerText(), /Nothing was sent|No unique|another wallet|original wallets/)
    await p.evaluate(e => window.__setEvm({ address: e, chainId: 1 }), REAL.evm)
    assert.equal(await p.getByRole('button', { name: 'Find', exact: true }).isDisabled(), true); await p.getByText('Connect the wallets that made the transfer: MetaMask on Arc Mainnet and Slush on Sui Mainnet.').waitFor()
    await p.evaluate(() => window.__setEvm({ chainId: 5042 })); await p.getByText('Transfer history (2)').waitFor()
    assert.equal((await stored(p)).length, 2)
  })
  await test(p, 'same browser: after a reload the history is kept, shown as saved, and a check reads the chains again without any wallet request', async () => {
    await p.reload(); await p.waitForFunction(() => Boolean(window.liveUi)); await p.getByRole('button', { name: 'Connect Slush (top bar)' }).click()
    await p.getByText('Transfer history (2)').click()
    const saved = await p.locator('li[aria-label="Transfer"]').allInnerTexts(); assert.equal(saved.length, 2); for (const t of saved) assert.match(t, /Saved status in this browser/)
    await p.locator('li[aria-label="Transfer"]').filter({ hasText: 'Sui → Arc' }).getByRole('button', { name: 'Check status' }).click()
    await p.locator('li[aria-label="Transfer"]').filter({ hasText: 'Sui → Arc' }).getByText(/Verified on chain at/).waitFor({ timeout: 90_000 })
  })
  await test(p, 'Dashboard and Activity show the same rows, statuses, start times and links as the Bridge', async () => {
    const rowsOf = async () => p.getByRole('listitem', { name: 'Bridge transfer' }).allInnerTexts()
    await p.getByRole('button', { name: 'dashboard', exact: true }).click(); await p.getByRole('listitem', { name: 'Bridge transfer' }).first().waitFor(); const d = await rowsOf()
    await p.getByRole('button', { name: 'activity', exact: true }).click(); await p.getByRole('listitem', { name: 'Bridge transfer' }).first().waitFor(); const a = await rowsOf()
    assert.deepEqual(a, d); assert.equal(d.length, 2)
    assert.match(d.find(t => t.includes('Sui → Arc')), /started 10\/30\/2026, 12:41:01 AM[\s\S]*Verified on chain at[\s\S]*Complete/)
    assert.match(d.find(t => t.includes('Arc → Sui')), /started 10\/29\/2026, 7:08:35 PM[\s\S]*Complete/)
    for (const href of [`https://explorer.arc.io/tx/${ARC.source}`, `https://suiscan.xyz/mainnet/tx/${ARC.destination}`, `https://suiscan.xyz/mainnet/tx/${SUI.source}`, `https://explorer.arc.io/tx/${SUI.destination}`]) assert.equal(await p.locator(`li[aria-label="Bridge transfer"] a[href="${href}"]`).count(), 1, href)
    await p.screenshot({ path: `${out}/live-activity.png`, fullPage: true })
  })
  const B = await profile()
  await test(B.page, 'a second, empty browser profile recovers the Sui -> Arc transfer on its own (no shared storage)', async () => {
    assert.deepEqual(await stored(B.page), [])
    await recover(B.page, SUI.source); await panel(B.page).getByRole('status').getByText('Transfer complete', { exact: true }).waitFor({ timeout: 90_000 })
    assert.equal(await panel(B.page).locator(`a[href="https://explorer.arc.io/tx/${SUI.destination}"]`).count(), 1)
    await panel(B.page).screenshot({ path: `${out}/live-sui-to-arc-second-profile.png` })
  })
  for (const page of [p, B.page]) assert.equal(await page.evaluate(() => window.liveUi.state.signatures), 0)
  const blockedWrites = seen.blocked.filter(b => /sendRawTransaction|sendTransaction|ExecuteTransaction|SimulateTransaction|signTransaction/i.test(b))
  assert.deepEqual(blockedWrites, [], 'no write was even attempted')
  assert.deepEqual(errors, [])
  writeFileSync(`${out}/live-reads.json`, JSON.stringify(seen, null, 1))
  console.log('Forwarded reads:', JSON.stringify({ arc: seen.arc, sui: seen.sui, iris: seen.iris }), 'Blocked (non-allow-listed):', seen.blocked.length)
  console.log(`RESULT ${count}/${count} LIVE read-only recovery groups PASS; real Arc/Sui/Circle reads; signatures, writes and transactions = 0.`)
} finally { await browser?.close(); await server.close() }
