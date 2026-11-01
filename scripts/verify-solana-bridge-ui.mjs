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
export function useAccount(){ const s = useT(); return { address: s.evm, isConnected: Boolean(s.evm), chainId: 5042, connector: s.evm ? { name: 'MetaMask' } : undefined } }
const W = window.solTest.wallet = { transport: { request: async a => { window.solTest.calls.wallet.push(a.method); return null } }, account: { address: '${EVM}' }, sendTransaction: async () => { window.solTest.calls.wallet.push('sendTransaction'); throw new Error('test wallet never sends') } }
export function useWalletClient(){ const s = useT(); return { data: s.evm ? W : undefined } }`
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
    arcSolanaReceiveReview: s.review ?? null, confirmArcSolanaReceiveRelease: async ok => { T.calls.release.push(ok); T.set({ review: null }) },
    runCanary: async (direction, amount) => { T.calls.runs.push([direction, amount]); return null },
  }
}`
const reclaimMock = `export async function discoverMainnetSolanaRefunds(){ window.solTest.calls.refunds++; return [] }
export async function loadMainnetSolanaRefundMetadata(){ return {} }
export async function reclaimMainnetSolanaDeposit(){ throw new Error('not used') }`
const boot = `<script>(() => { const T = window.solTest = { listeners: new Set(), calls: { runs: [], estimates: [], recover: [], refresh: 0, refunds: 0, wallet: [], release: [] } }
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
  await test('an earlier burn with an unverified outcome (any tab, after a reload) locks Review; Check on chain is read-only, a check that found nothing keeps the lock, and only a warned, confirmed manual review unlocks it', async () => {
    await open()
    await page.evaluate(({ evm, sol }) => localStorage.setItem('machina_mainnet_solana_send_v1', JSON.stringify([{ id: 'open-burn', direction: 'arc-to-solana', evmWallet: evm, solanaWallet: sol, amount: '0.2', createdAt: Date.now() - 60_000, updatedAt: Date.now() - 60_000, signingAt: Date.now() - 60_000, phase: 'unknown', arcBlockBefore: '1000' }])), { evm: EVM, sol: SOL })
    await open(); await page.getByLabel('Bridge amount').fill('0.25')
    const notice = page.getByRole('alert', { name: 'Earlier Solana transfer not verified' }); await notice.waitFor()
    assert.match(await notice.innerText(), /earlier Arc → Solana transfer of 0\.2 USDC .*has no verified outcome\. New transfers stay locked/)
    assert.equal(await page.getByRole('button', { name: /Review transfer|Enter a valid amount/ }).isDisabled(), true, 'Review locked')
    await notice.getByRole('button', { name: 'Check on chain' }).click(); await page.waitForTimeout(1500)
    assert.match(await notice.innerText(), /could not be read/, 'networks unreadable: the lock stays and says why')
    assert.equal(await notice.getByText('I checked my wallets: unlock manually').count(), 0, 'no manual unlock when the check could not complete')
    assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('machina_mainnet_solana_send_v1'))[0].phase), 'unknown')
    assert.deepEqual((await calls()).runs, [], 'no transfer was started')
    // A completed check (Arc answers: no burn, nothing pending) still does not unlock by itself: time is not evidence.
    await page.route('https://rpc.mainnet.arc.io/**', route => { const m = JSON.parse(route.request().postData() || '{}').method; const result = m === 'eth_blockNumber' ? '0x3e8' : m === 'eth_getLogs' ? [] : m === 'eth_getTransactionCount' ? '0x5' : m === 'eth_chainId' ? '0x13b2' : null; return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ jsonrpc: '2.0', id: JSON.parse(route.request().postData() || '{}').id ?? 1, result }) }) })
    await notice.getByRole('button', { name: 'Check on chain' }).click()
    await notice.getByText(/No burn from your wallet is on Arc\. It stays locked: only the wallet can tell/).waitFor({ timeout: 15000 })
    assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('machina_mainnet_solana_send_v1'))[0].phase), 'unknown', 'still locked after a completed check that found nothing')
    assert.equal(await page.getByRole('button', { name: /Review transfer|Enter a valid amount/ }).isDisabled(), true)
    // Manual review: explicit warning and confirmation are required.
    await notice.getByText('I checked my wallets: unlock manually').click()
    assert.match(await notice.innerText(), /reject it there first\. If an old request is approved later, a second transfer is sent/)
    const unlock = notice.getByRole('button', { name: 'Unlock new transfers' })
    assert.equal(await unlock.isDisabled(), true, 'disabled until the warning is confirmed')
    await notice.getByRole('checkbox').check(); await unlock.click()
    await page.getByRole('alert', { name: 'Earlier Solana transfer not verified' }).waitFor({ state: 'detached', timeout: 15000 })
    const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('machina_mainnet_solana_send_v1'))[0])
    assert.equal(saved.phase, 'released'); assert.equal(saved.manuallyReleased, true)
    assert.deepEqual((await calls()).runs, [], 'unlocking sends nothing')
    await page.unroute('https://rpc.mainnet.arc.io/**')
    await page.evaluate(() => localStorage.removeItem('machina_mainnet_solana_send_v1')); await open(); await page.getByLabel('Bridge amount').fill('0.25')
    assert.equal(await page.getByRole('alert', { name: 'Earlier Solana transfer not verified' }).count(), 0)
    assert.equal(await page.getByRole('button', { name: 'Review transfer' }).isDisabled(), false, 'Review available again once settled')
  })
  await test('Solana -> Arc recovery: a burn known after a reload is checked read-only; already received on Arc sends nothing; a missing receive needs review and wallet approval; another browser can paste the signature', async () => {
    const { PublicKey } = require('@solana/web3.js')
    const SIG = '3vZ7GhB8WFHp2TQ2qQ7fZx2iN1bVwQ3TGxHqCFeZ8p1b6mM2cRbQnXgMm9HcUe8dAqxpbLvW1jKaRm7nPq3Ttz4X'
    const pk = k => Buffer.from(new PublicKey(k).toBytes()).toString('hex'), hx = x => x.replace(/^0x/, '').padStart(64, '0'), wd = (v, n = 32) => BigInt(v).toString(16).padStart(n * 2, '0')
    const msg = '0x' + wd(1, 4) + wd(5, 4) + wd(26, 4) + '4e'.repeat(32) + pk('CCTPV2vPZJS2u2BBsUoscuikbYjnpFmbFsvVuJdgUMQe') + hx('0x28b5a0e9c621a5badaa536219b3a228c8168cf5d') + '00'.repeat(32) + wd(1000, 4) + wd(1000, 4)
      + wd(1, 4) + pk('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v') + hx(EVM) + wd(100000) + pk(SOL) + wd(3) + wd(2) + wd(0)
    let used = 1n
    const rpc = route => { const b = JSON.parse(route.request().postData() || '{}'), block = { number: '0x64', hash: '0x' + 'aa'.repeat(32), parentHash: '0x' + 'bb'.repeat(32), timestamp: '0x1', gasLimit: '0x1', gasUsed: '0x0', transactions: [], logsBloom: '0x' + '00'.repeat(256), miner: '0x' + '00'.repeat(20), difficulty: '0x0', extraData: '0x', size: '0x1', nonce: '0x0000000000000000', sha3Uncles: '0x' + '00'.repeat(32), stateRoot: '0x' + '00'.repeat(32), receiptsRoot: '0x' + '00'.repeat(32), transactionsRoot: '0x' + '00'.repeat(32), uncles: [] }
      const result = b.method === 'eth_chainId' ? '0x13b2' : b.method === 'eth_getBlockByNumber' ? block : b.method === 'eth_call' ? '0x' + wd(used) : null
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ jsonrpc: '2.0', id: b.id ?? 1, result }) }) }
    await page.route('https://rpc.mainnet.arc.io/**', rpc)
    await page.route('**/api/solana-rpc', route => { const b = JSON.parse(route.request().postData() || '{}')
      const result = b.method === 'getSignatureStatuses' ? { value: [{ confirmationStatus: 'finalized', err: null }] } : b.method === 'getTransaction' ? { meta: { err: null, logMessages: ['Program CCTPV2vPZJS2u2BBsUoscuikbYjnpFmbFsvVuJdgUMQe invoke [1]'] }, transaction: { message: { accountKeys: [SOL], header: { numRequiredSignatures: 1 } } } } : null
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ jsonrpc: '2.0', id: 1, result }) }) })
    await page.route('https://iris-api.circle.com/**', route => route.fulfill({ contentType: 'application/json', body: JSON.stringify({ messages: [{ status: 'complete', message: msg, attestation: '0x' + 'ab'.repeat(130), eventNonce: '0x' + '4e'.repeat(32) }] }) }))
    // A burn this browser recorded (Activity, receive not verified), then a reload.
    await open()
    await page.evaluate(({ evm, sol, sig }) => { localStorage.removeItem('machina_mainnet_solana_send_v1'); localStorage.setItem('machina_mainnet_solana_transfers_v1', JSON.stringify([{ id: 'r1', evmWallet: evm, solanaWallet: sol, direction: 'solana-to-arc', amount: '0.1', sourceTxHash: sig, createdAt: Date.now() }])) }, { evm: EVM, sol: SOL, sig: SIG })
    await open(); await page.getByRole('button', { name: 'Switch direction' }).click()
    const item = page.getByLabel(/^Solana burn 3vZ7GhB8/); await item.waitFor()
    await item.getByRole('button', { name: 'Check on chain' }).click()
    await item.getByText(/Already received on Arc \(0\.099998 USDC\)\. Nothing more to do\./).waitFor({ timeout: 15000 })
    assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('machina_mainnet_solana_transfers_v1'))[0].status), 'complete', 'Activity marked complete from the used Arc nonce')
    assert.equal(await item.getByRole('button', { name: 'Complete receive on Arc' }).count(), 0)
    assert.deepEqual((await calls()).wallet, [], 'already received: no wallet request')
    // Another browser: nothing saved; the signature is pasted. The receive is missing on Arc.
    used = 0n
    await page.evaluate(() => localStorage.clear()); await open(); await page.getByRole('button', { name: 'Switch direction' }).click()
    await page.getByText('Recover a Solana → Arc transfer').click()
    await page.getByLabel('Solana to Arc recovery source signature').fill(SIG)
    await page.getByRole('button', { name: 'Check', exact: true }).click()
    const pasted = page.getByLabel(/^Solana burn 3vZ7GhB8/); await pasted.getByText('Not received on Arc yet').waitFor({ timeout: 15000 })
    const t = (await pasted.innerText()).replace(/\s+/g, ' ')
    assert.match(t, /Burned on Solana 0\.1 USDC Circle fee 0\.000002 USDC You receive on Arc 0\.099998 USDC To 0xafbb6c…b8e321/)
    const go = pasted.getByRole('button', { name: 'Complete receive on Arc' })
    assert.equal(await go.isDisabled(), true, 'disabled until the review is confirmed')
    await pasted.getByRole('checkbox').check(); assert.equal(await go.isDisabled(), false)
    // The test wallet is not on Arc with the account: the request stops before anything is journaled or sent.
    await go.click(); await pasted.getByRole('alert').waitFor({ timeout: 15000 })
    assert.match(await pasted.getByRole('alert').innerText(), /Switch the EVM wallet to Arc Mainnet with the receiving account\. Nothing was requested\./)
    assert.ok(!(await calls()).wallet.includes('sendTransaction'), 'no transaction was requested')
    assert.equal(await page.evaluate(() => localStorage.getItem('machina_solana_arc_receive_v1')), null, 'nothing journaled')
    assert.equal(await page.evaluate(() => localStorage.getItem('machina_mainnet_solana_send_v1')), null, 'recovery never creates a burn attempt')
    assert.deepEqual((await calls()).runs, [], 'no transfer (burn) was started')
    await page.unroute('https://rpc.mainnet.arc.io/**'); await page.unroute('**/api/solana-rpc'); await page.unroute('https://iris-api.circle.com/**')
    await page.evaluate(() => localStorage.clear())
  })
  await test('an older Arc -> Solana receive without saved evidence: the chain checks and a risk warning are shown; unlocking needs the explicit confirmation; failed checks offer no unlock; nothing is sent', async () => {
    const checks = [{ label: 'Nonce unused on Solana (reader A, confirmed and finalized)', ok: true }, { label: 'Nonce unused on Solana (reader B, confirmed and finalized)', ok: true }, { label: 'No receive transaction ever touched the nonce account', ok: true }, { label: 'No active wallet request for this burn in this browser', ok: true }]
    await open(); await page.getByText('Recover an older Arc → Solana transfer').click()
    await set({ review: { sourceTxHash: '0x22e768dd', eligible: true, checks, reviewedAt: Date.now(), message: '0x', owner: SOL } })
    const box = page.getByRole('alert', { name: 'Earlier Solana receive needs review' }); await box.waitFor()
    const t = (await box.innerText()).replace(/\s+/g, ' ')
    assert.match(t, /no saved signature/); assert.match(t, /✓ Nonce unused on Solana \(reader A/); assert.match(t, /✓ No active wallet request/)
    assert.match(t, /It cannot mint twice .* but it can cost a Solana network fee/)
    const unlock = box.getByRole('button', { name: 'Unlock this receive' })
    assert.equal(await unlock.isDisabled(), true, 'disabled until the risk is confirmed')
    await box.getByRole('checkbox').check(); await unlock.click()
    await box.waitFor({ state: 'detached', timeout: 15000 })
    assert.deepEqual((await calls()).release, [true]); assert.deepEqual((await calls()).runs, [], 'unlocking sends nothing')
    await set({ review: { sourceTxHash: '0x22e768dd', eligible: false, checks: [checks[0], { ...checks[2], ok: false }], reviewedAt: Date.now(), message: '0x', owner: SOL } })
    const bad = page.getByRole('alert', { name: 'Earlier Solana receive needs review' }); await bad.waitFor()
    assert.match(await bad.innerText(), /✗ No receive transaction ever touched the nonce account/)
    assert.match(await bad.innerText(), /Not every check passed, so the earlier request stays locked/)
    assert.equal(await bad.getByRole('button', { name: 'Unlock this receive' }).count(), 0)
    await set({ review: null })
  })
  await test('fits a phone (390 px) without horizontal scrolling', async () => {
    await page.setViewportSize({ width: 390, height: 900 }); await open(); await page.getByLabel('Bridge amount').fill('0.25')
    await page.getByRole('button', { name: 'Review transfer' }).click(); await reviewBox().waitFor()
    await shot('solana-review-mobile'); assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1))
  })
  assert.deepEqual(errors, [], 'no page errors')
  console.log(`RESULT ${count}/${count} Solana Bridge UI groups PASS; real component, controlled wallets and CCTP hook; no network.`)
} finally { await browser?.close(); await server.close() }
