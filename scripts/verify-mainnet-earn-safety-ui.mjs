// Chromium: Earn deposit/withdraw send safety in the real MainnetEarnActions
// component. wagmi, EarnKit and the viem adapter are controlled stand-ins; the
// wallet and the Arc RPC are modelled by the test (no network, no real
// signature or transaction).
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'
const require = createRequire(import.meta.url), v = require('viem')
let chromium; try { ({ chromium } = require('playwright-core')) } catch { ({ chromium } = require('/opt/codex/runtimes/cua/lib/node_modules/playwright-core')) }
const root = fileURLToPath(new URL('..', import.meta.url))
const OWNER = '0xafbb6cc5c0a9c0eb1bff8db2ed807e83aab8e321', OTHER = '0x' + '11'.repeat(20)
const USDC = '0x3600000000000000000000000000000000000000', ADAPTER = '0x7fb8c7260b63934d8da38af902f87ae6e284a845'
const VAULT_A = '0x8E357432CC12ff425c36432F312968aEb16112AF', VAULT_B = '0xdECcd53BE5453215821184824B519E04C7e00bC7'
const TRANSFER = v.encodeEventTopics({ abi: v.parseAbi(['event Transfer(address indexed from,address indexed to,uint256 value)']), eventName: 'Transfer' })[0]
const JOURNAL = 'machina.earn.journal.v1'
const raw = s => v.parseUnits(s, 6)

const wagmiMock = `import { useSyncExternalStore } from 'react'
const W = window.earnTest
export function useAccount(){ const s = useSyncExternalStore(l => { W.listeners.add(l); return () => W.listeners.delete(l) }, () => W.snapshot); return { address: s.address, isConnected: Boolean(s.address), chainId: s.chainId, connector: s.address ? W.connector : undefined } }
const switchChain = { switchChainAsync: async () => {} }
export function useSwitchChain(){ return switchChain }`
const adapterMock = `export function createViemAdapterFromProvider({ provider }){ return { provider } }`
// EarnKit stand-in with the real SDK's send shape (verify-earn-kit-real-provider runs
// the real SDK): optional approval to the Earn adapter (USDC.increaseAllowance for a
// deposit, vault.approve for a withdrawal), then one Adapter.execute whose calldata
// carries the vault call for the requested vault and amount, then a receipt wait.
const earnKitMock = `import { encodeFunctionData, parseAbi, parseUnits } from 'viem'
const W = window.earnTest
const ADAPTER = '${ADAPTER}', USDC = '${USDC}'
const ABI = parseAbi(['function increaseAllowance(address spender,uint256 addedValue)', 'function approve(address spender,uint256 amount)', 'function deposit(uint256 assets,address receiver)', 'function withdraw(uint256 assets,address receiver,address owner)', 'function execute(((address target,bytes data,uint256 value,address tokenIn,uint256 amountToApprove,address tokenOut,uint256 minTokenOut)[] instructions,(address token,address beneficiary)[] tokens,uint256 execId,uint256 deadline,bytes metadata) params,(uint8 permitType,address token,uint256 amount,bytes permitCalldata)[] tokenInputs,bytes signature)'])
function executeData(op, vault, amount, owner){
  const deposit = op === 'deposit', asset = deposit ? USDC : vault, out = deposit ? vault : USDC
  const data = deposit ? encodeFunctionData({ abi: ABI, functionName: 'deposit', args: [amount, ADAPTER] }) : encodeFunctionData({ abi: ABI, functionName: 'withdraw', args: [amount, ADAPTER, ADAPTER] })
  return encodeFunctionData({ abi: ABI, functionName: 'execute', args: [{ instructions: [{ target: vault, data, value: 0n, tokenIn: asset, amountToApprove: amount, tokenOut: out, minTokenOut: deposit ? 1n : amount }], tokens: [{ token: USDC, beneficiary: owner }, { token: vault, beneficiary: owner }], execId: 1n, deadline: 2n ** 40n, metadata: '0x' }, [{ permitType: 0, token: asset, amount, permitCalldata: '0x' }], '0x' + '11'.repeat(65)] })
}
const send = (p, from, to, data) => p.request({ method: 'eth_sendTransaction', params: [{ from, to, data, chainId: '0x13b2' }] })
async function mined(hash, s){ for (;;) { if (s.after === 'throw') throw new Error('Timed out while waiting for transaction with hash "' + hash + '" to be confirmed.'); const st = W.mined[hash]; if (st) return st; await new Promise(r => setTimeout(r, 20)) } }
async function run(op, params){
  W.state.sdkCalls.push({ op, vault: params.vaultAddress, amount: params.amount, config: params.config ?? null })
  const s = W.state.sdk.shift() ?? {}, p = params.from.adapter.provider, [from] = await p.request({ method: 'eth_accounts' })
  const amount = parseUnits(params.amount, 6), sender = s.from ?? from
  if (s.approve) { const h = await send(p, sender, op === 'deposit' ? USDC : params.vaultAddress, encodeFunctionData({ abi: ABI, functionName: op === 'deposit' ? 'increaseAllowance' : 'approve', args: [ADAPTER, amount + 1n] })); if (await mined(h, {}) === 'reverted') throw new Error('Earn ' + op + ' token approval reverted on-chain') }
  const h = await send(p, sender, ADAPTER, executeData(op, params.vaultAddress, amount, sender))
  if (await mined(h, s) === 'reverted') throw new Error('Earn ' + op + ' reverted on-chain')
  return { kind: 'same-chain', txHash: h, explorerUrl: 'https://arcscan.app/tx/' + h, vaultAddress: params.vaultAddress, amount: params.amount }
}
export class EarnKit {
  async getDepositQuote(p){ W.state.quotes.push(['deposit', p.vaultAddress, p.amount]); return { amount: p.amount } }
  async getWithdrawalQuote(p){ W.state.quotes.push(['withdraw', p.vaultAddress, p.amount]); return { amount: p.amount } }
  async getPosition(){ return { currentBalance: W.state.position } }
  deposit(p){ return run('deposit', p) }
  withdraw(p){ return run('withdraw', p) }
  on(){} off(){}
}`
// Wallet: every eth_sendTransaction is recorded; the queue decides its answer.
const boot = `<script>(() => {
  const W = window.earnTest = { state: { address: '${OWNER}', chainId: 5042, send: [], sends: [], hashes: [], sdk: [], sdkCalls: [], quotes: [], position: '0', hold: false }, mined: {}, listeners: new Set() }
  W.snapshot = { address: W.state.address, chainId: 5042 }
  W.setAddress = a => { W.state.address = a; W.snapshot = { address: a, chainId: 5042 }; W.listeners.forEach(l => l()) }
  W.connector = { name: 'MetaMask', getProvider: async () => W.provider }
  W.provider = { request: async ({ method, params }) => {
    if (method === 'eth_accounts' || method === 'eth_requestAccounts') return [W.state.address]
    if (method === 'eth_chainId') return '0x13b2'
    if (method !== 'eth_sendTransaction') throw new Error('Unexpected wallet method ' + method)
    const tx = params[0]; W.state.sends.push({ from: tx.from, to: tx.to, data: tx.data })
    const mode = W.state.send.shift() ?? 'hash'
    while (W.state.hold) await new Promise(r => setTimeout(r, 20))
    if (mode === 'reject') { const e = new Error('User rejected the request.'); e.code = 4001; throw e }
    if (mode === 'lost') throw new Error('Wallet connection lost before it reported a hash.')
    const hash = await window.earnBroadcast({ from: tx.from, to: tx.to, data: tx.data }); W.state.hashes.push(hash)
    if (mode === 'lostAfterBroadcast') throw new Error('Wallet connection lost after broadcasting.')
    return hash
  } }
})()</script>`
const server = await createServer({ root, configFile: false, cacheDir: '/tmp/machina-earn-safety-ui', plugins: [{ name: 'earn-safety', enforce: 'pre',
  resolveId(id) { if (id === 'wagmi') return '\0es-wagmi'; if (id === '@circle-fin/earn-kit') return '\0es-earn'; if (id === '@circle-fin/adapter-viem-v2') return '\0es-adapter' },
  load(id) { if (id === '\0es-wagmi') return wagmiMock; if (id === '\0es-earn') return earnKitMock; if (id === '\0es-adapter') return adapterMock },
  configureServer(s) { s.middlewares.use('/__earn', async (_q, res) => { res.setHeader('Content-Type', 'text/html'); res.end(await s.transformIndexHtml('/__earn', `<!doctype html><html><body><div id="root"></div>${boot}<script type="module" src="/scripts/fixtures/mainnet-earn-actions.tsx"></script></body></html>`)) }) } }], server: { host: '127.0.0.1', port: 0 } })

// Arc chain model: wallet broadcasts take the next pending nonce; mine() lands one.
const chain = {}
function resetChain() { Object.assign(chain, { block: 5000, nonce: { latest: 3, pending: 3 }, balance: raw('10'), txs: {}, receipts: {}, transfers: [], rpcDown: false, receiptDown: false, seq: 0, calls: [] }) }
resetChain()
const hexn = n => '0x' + BigInt(n).toString(16), pad = a => '0x' + a.slice(2).toLowerCase().padStart(64, '0')
const transferLog = (t, i = 0) => ({ address: t.token ?? USDC, topics: [TRANSFER, pad(t.from), pad(t.to)], data: '0x' + t.value.toString(16).padStart(64, '0'), blockNumber: hexn(t.block), transactionHash: t.hash, logIndex: hexn(i), blockHash: '0x' + 'bb'.repeat(32), transactionIndex: '0x0', removed: false })
function receipt(hash) { const r = chain.receipts[hash], tx = chain.txs[hash]; return { transactionHash: hash, blockHash: '0x' + 'bb'.repeat(32), blockNumber: hexn(r.block), transactionIndex: '0x0', from: tx.from, to: tx.to, status: r.status === 'success' ? '0x1' : '0x0', logs: chain.transfers.filter(t => t.hash === hash).map(transferLog), logsBloom: '0x' + '0'.repeat(512), gasUsed: '0x5208', cumulativeGasUsed: '0x5208', effectiveGasPrice: '0x1', contractAddress: null, type: '0x2' } }
function answer(body) {
  chain.calls.push(body.method)
  const [a0, a1] = body.params ?? []
  switch (body.method) {
    case 'eth_chainId': return '0x13b2'
    case 'eth_blockNumber': return hexn(chain.block)
    case 'eth_getTransactionCount': return hexn(a1 === 'pending' ? chain.nonce.pending : chain.nonce.latest)
    case 'eth_call': if (a0.data.startsWith('0x70a08231')) return '0x' + chain.balance.toString(16).padStart(64, '0'); throw new Error('Unexpected eth_call ' + a0.data.slice(0, 10))
    case 'eth_getTransactionReceipt': return chain.receipts[a0] ? receipt(a0) : null
    case 'eth_getTransactionByHash': { const tx = chain.txs[a0]; if (!tx) return null; const r = chain.receipts[a0]; return { hash: a0, from: tx.from, to: tx.to, nonce: hexn(tx.nonce), input: tx.data, value: '0x0', gas: '0x5208', maxFeePerGas: '0x2', maxPriorityFeePerGas: '0x1', type: '0x2', chainId: '0x13b2', v: '0x0', r: '0x1', s: '0x1', yParity: '0x0', accessList: [], blockHash: r ? '0x' + 'bb'.repeat(32) : null, blockNumber: r ? hexn(r.block) : null, transactionIndex: r ? '0x0' : null } }
    case 'eth_getLogs': { const f = a0, [t0, t1, t2] = f.topics; assert.equal(t0, TRANSFER); assert.equal(f.address.toLowerCase(), USDC); assert.ok(BigInt(f.toBlock) - BigInt(f.fromBlock) < 10_000n, 'bounded log window')
      return chain.transfers.filter(t => (t.token ?? USDC) === USDC && t.block >= Number(BigInt(f.fromBlock)) && t.block <= Number(BigInt(f.toBlock)) && (!t1 || t1 === pad(t.from)) && (!t2 || t2 === pad(t.to))).map(t => transferLog(t)) }
    default: throw new Error('Unexpected Arc method ' + body.method)
  }
}
let browser, context, page, count = 0; const errors = [], failures = []
async function test(name, fn) { try { await fn() } catch (e) { if (process.env.REPORT_ALL) { failures.push(name); if (process.env.DEBUG_TEXT) for (const p of context.pages()) console.log('  page text:', (await p.locator('#root').innerText().catch(() => '')).replace(/\s+/g, ' ').slice(0, 600), '| journal:', (await p.evaluate(k => localStorage.getItem(k), JOURNAL).catch(() => '')).slice(0, 400)); console.log('FAIL ' + name + ' :: ' + String(e.message).replace(/\s+/g, ' ').slice(0, 300) + ' @' + (String(e.stack).match(/verify-mainnet-earn-safety-ui\.mjs:(\d+)/)?.[1] ?? '?')); return } console.error('journal:', JSON.stringify(await page.evaluate(k => localStorage.getItem(k), JOURNAL).catch(() => null))?.slice(0, 1500), 'calls:', chain.calls.slice(-12)); throw e } count++; console.log('PASS ' + name) }
try {
  await server.listen(); const base = `http://127.0.0.1:${server.httpServer.address().port}/__earn`
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] })
  context = await browser.newContext()
  await context.exposeFunction('earnBroadcast', tx => { const hash = '0x' + (++chain.seq).toString(16).padStart(64, 'e'); chain.txs[hash] = { ...tx, nonce: chain.nonce.pending++ }; return hash })
  await context.route('**/*', async route => {
    const req = route.request(), url = new URL(req.url())
    if (url.hostname === '127.0.0.1') return route.continue()
    if (url.hostname === 'rpc.mainnet.arc.io' && req.method() === 'POST') {
      if (chain.rpcDown) return route.fulfill({ status: 503, body: 'down' })
      const body = req.postDataJSON(), many = Array.isArray(body)
      if (chain.receiptDown && (many ? body : [body]).some(b => ['eth_getTransactionReceipt', 'eth_getTransactionByHash', 'eth_getLogs'].includes(b.method))) return route.fulfill({ status: 503, body: 'down' })
      try { const out = (many ? body : [body]).map(b => ({ jsonrpc: '2.0', id: b.id, result: answer(b) })); return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(many ? out : out[0]) }) }
      catch (e) { errors.push(e.message); return route.fulfill({ status: 500, body: e.message }) }
    }
    return route.abort()
  })
  const pages = []
  const openPage = async p => { await p.goto(base); await p.getByLabel('Earn amount').waitFor() }
  const fresh = async () => { for (const p of pages.splice(0)) await p.close(); page = await context.newPage(); page.on('pageerror', e => errors.push(e.message)); pages.push(page); await openPage(page); await page.evaluate(() => localStorage.clear()); resetChain(); await openPage(page) }
  const extraTab = async () => { const p = await context.newPage(); p.on('pageerror', e => errors.push(e.message)); pages.push(p); await openPage(p); return p }
  const st = (p, patch) => p.evaluate(patch => Object.assign(window.earnTest.state, patch), patch)
  const W = (p, fn) => p.evaluate(fn)
  const sends = (p = page) => W(p, () => window.earnTest.state.sends.length)
  const hashes = (p = page) => W(p, () => window.earnTest.state.hashes)
  const journal = (p = page) => p.evaluate(k => JSON.parse(localStorage.getItem(k) ?? '[]'), JOURNAL)
  const text = (p = page) => p.locator('#root').innerText()
  const setAmount = (amount, p = page) => p.getByLabel('Earn amount').fill(amount)
  const btn = (name, p = page) => p.getByRole('button', { name })
  // Lands a broadcast transaction; a successful execute moves USDC and vault shares between the wallet and the Earn adapter (as on Arc mainnet).
  async function mine(hash, status, moves = []) {
    const tx = chain.txs[hash]; assert.ok(tx, 'unknown hash ' + hash); chain.block += 2; chain.receipts[hash] = { status, block: chain.block }; chain.nonce.latest = Math.max(chain.nonce.latest, tx.nonce + 1)
    if (status === 'success') for (const m of moves) chain.transfers.push({ hash, block: chain.block, ...m })
    for (const p of pages) await p.evaluate(([h, s]) => { window.earnTest.mined[h] = s }, [hash, status]).catch(() => {})
  }
  const VA = VAULT_A.toLowerCase()
  const deposited = value => [{ token: USDC, from: OWNER, to: ADAPTER, value }, { token: VA, from: ADAPTER, to: OWNER, value: 10n ** 17n }]
  const withdrawn = value => [{ token: USDC, from: ADAPTER, to: OWNER, value }, { token: VA, from: OWNER, to: ADAPTER, value: 10n ** 17n }]
  const waitHashes = (n, p = page) => p.waitForFunction(n => window.earnTest.state.hashes.length >= n, n, { timeout: 5000 })
  const waitText = (re, p = page) => p.waitForFunction(([src, flags]) => new RegExp(src, flags).test(document.getElementById('root').innerText), [re.source, re.flags], { timeout: 6000 })
  const reviewDeposit = async (amount, p = page) => { await setAmount(amount, p); await btn(/Review .* deposit/, p).click(); await btn(/^Deposit .* USDC$/, p).waitFor({ timeout: 5000 }) }
  // The panel appears as soon as the operation is journaled ('sending'); wait for the settled outcome.
  const settledTo = (outcome, p = page) => p.waitForFunction(([k, o]) => JSON.parse(localStorage.getItem(k) ?? '[]')[0]?.outcome === o, [JOURNAL, outcome], { timeout: 6000 })
  const pendingPanel = (p = page) => p.locator('[data-testid="earn-pending"]')

  await test('a successful deposit sends exactly one sequential execute, verifies it on chain and records the journal entry', async () => {
    await fresh(); await reviewDeposit('0.25')
    await btn('Deposit 0.25 USDC').click(); await waitHashes(1); const [h] = await hashes(); await mine(h, 'success', deposited(raw('0.25')))
    await waitText(/Deposit 0\.25 USDC confirmed/)
    const [call] = await W(page, () => window.earnTest.state.sdkCalls); assert.equal(call.config?.batchTransactions, false, 'batching off: every wallet transaction is visible to the journal')
    const [j] = await journal(); assert.equal(j.outcome, 'success'); assert.equal(j.action, 'deposit'); assert.equal(j.account, OWNER); assert.equal(j.chainId, 5042); assert.equal(j.vault, VAULT_A.toLowerCase()); assert.equal(j.amountRaw, '250000'); assert.equal(j.executeHash, h); assert.deepEqual([j.evidence?.usdc, j.evidence?.shares], [true, true], 'exact USDC movement and vault share movement in the execute receipt')
    assert.equal(await pendingPanel().count(), 0)
  })
  await test('a successful withdrawal is verified the same way', async () => {
    await fresh(); await st(page, { position: '1.5' }); await setAmount('0.4'); await btn('Review withdrawal').click(); await btn('Withdraw 0.4 USDC').click(); await waitHashes(1)
    const [h] = await hashes(); await mine(h, 'success', withdrawn(raw('0.4'))); await waitText(/Withdrawal 0\.4 USDC confirmed/)
    const [j] = await journal(); assert.deepEqual([j.action, j.outcome, j.amountRaw, j.executeHash], ['withdraw', 'success', '400000', h])
  })
  await test('a double click starts one operation and one wallet request', async () => {
    await fresh(); await reviewDeposit('0.25')
    await page.evaluate(() => { const b = [...document.querySelectorAll('button')].find(b => b.textContent === 'Deposit 0.25 USDC'); b.click(); b.click() })
    await waitHashes(1); await page.waitForTimeout(300)
    assert.equal(await W(page, () => window.earnTest.state.sdkCalls.length), 1); assert.equal(await sends(), 1)
    await mine((await hashes())[0], 'success', deposited(raw('0.25'))); await waitText(/confirmed/)
  })
  await test('an SDK error AFTER the wallet returned a hash keeps the operation locked with the hash; no second deposit; Check status settles it from the receipt', async () => {
    await fresh(); await st(page, { sdk: [{ after: 'throw' }] }); await reviewDeposit('0.25'); await btn('Deposit 0.25 USDC').click()
    await pendingPanel().waitFor({ timeout: 5000 }); await settledTo('unknown'); const [h] = await hashes()
    let [j] = await journal(); assert.equal(j.outcome, 'unknown'); assert.equal(j.executeHash, h)
    assert.match(await pendingPanel().innerText(), new RegExp(h.slice(2, 10)))
    assert.ok(await btn(/Review .* deposit/).isDisabled(), 'no new review while the outcome is open'); assert.ok(await btn('Review withdrawal').isDisabled())
    await btn('Check status').click(); await page.waitForTimeout(400); [j] = await journal(); assert.equal(j.outcome, 'unknown', 'no receipt yet: still unknown')
    await mine(h, 'success', deposited(raw('0.25'))); await btn('Check status').click(); await waitText(/Deposit 0\.25 USDC confirmed/)
    ;[j] = await journal(); assert.equal(j.outcome, 'success'); assert.equal(await pendingPanel().count(), 0); assert.equal(await sends(), 1)
  })
  await test('a REVERTED execute found by Check status unlocks without a success entry', async () => {
    await fresh(); await st(page, { sdk: [{ after: 'throw' }] }); await reviewDeposit('0.25'); await btn('Deposit 0.25 USDC').click(); await pendingPanel().waitFor({ timeout: 5000 }); await settledTo('unknown')
    const [h] = await hashes(); await mine(h, 'reverted'); await btn('Check status').click(); await waitText(/reverted/i)
    const [j] = await journal(); assert.equal(j.outcome, 'reverted'); assert.equal(await pendingPanel().count(), 0); assert.doesNotMatch(await text(), /confirmed/)
    assert.equal(await btn(/Review .* deposit/).isDisabled(), false, 'unlocked: a reverted transaction moved no funds')
  })
  await test('a LOST hash (wallet error after broadcast) stays unknown until one matching chain transfer from this wallet after the attempt is found and verified', async () => {
    await fresh(); await st(page, { send: ['lostAfterBroadcast'] }); await reviewDeposit('0.25'); await btn('Deposit 0.25 USDC').click(); await pendingPanel().waitFor({ timeout: 5000 }); await settledTo('unknown')
    let [j] = await journal(); assert.equal(j.outcome, 'unknown'); assert.equal(j.executeHash, undefined)
    await btn('Check status').click(); await page.waitForTimeout(400); [j] = await journal(); assert.equal(j.outcome, 'unknown', 'nonce not moved: unknown')
    const h = Object.keys(chain.txs)[0]
    // A transfer of ANOTHER amount from this wallet is not adopted.
    chain.block += 2; for (const m of deposited(raw('0.3'))) chain.transfers.push({ hash: '0x' + 'ab'.repeat(32), block: chain.block, ...m }); chain.txs['0x' + 'ab'.repeat(32)] = { from: OWNER, to: ADAPTER, data: '0x', nonce: 3 }
    await btn('Check status').click(); await page.waitForTimeout(400); [j] = await journal(); assert.equal(j.outcome, 'unknown', 'wrong amount is not adopted')
    delete chain.txs['0x' + 'ab'.repeat(32)]; chain.transfers.length = 0
    await mine(h, 'success', deposited(raw('0.25'))); await btn('Check status').click(); await waitText(/Deposit 0\.25 USDC confirmed/)
    ;[j] = await journal(); assert.equal(j.outcome, 'success'); assert.equal(j.executeHash, h); assert.equal(await sends(), 1)
  })
  await test('an explicit wallet rejection proves nothing was sent: unlocked at once', async () => {
    await fresh(); await st(page, { send: ['reject'] }); await reviewDeposit('0.25'); await btn('Deposit 0.25 USDC').click(); await waitText(/rejected|cancel/i)
    const [j] = await journal(); assert.equal(j.outcome, 'not_sent'); assert.equal(await pendingPanel().count(), 0); assert.equal(await btn(/Review .* deposit/).isDisabled(), false)
  })
  await test('refresh: an open outcome survives a reload and still blocks new operations; Check status works after reload', async () => {
    await fresh(); await st(page, { sdk: [{ after: 'throw' }] }); await reviewDeposit('0.25'); await btn('Deposit 0.25 USDC').click(); await pendingPanel().waitFor({ timeout: 5000 }); await settledTo('unknown')
    const [h] = await hashes(); await openPage(page); await pendingPanel().waitFor({ timeout: 5000 })
    assert.ok(await btn(/Review .* deposit/).isDisabled()); await mine(h, 'success', deposited(raw('0.25'))); await btn('Check status').click(); await waitText(/Deposit 0\.25 USDC confirmed/)
  })
  await test('two tabs: while one tab is sending, the other cannot start or settle an operation for the same wallet', async () => {
    await fresh(); await st(page, { hold: true }); await reviewDeposit('0.25'); await btn('Deposit 0.25 USDC').click()
    await page.waitForFunction(() => window.earnTest.state.sends.length === 1, null, { timeout: 5000 })
    const tab2 = await extraTab(); await pendingPanel(tab2).waitFor({ timeout: 5000 })
    assert.ok(await btn(/Review .* deposit/, tab2).isDisabled()); assert.ok(await btn('Review withdrawal', tab2).isDisabled())
    await btn('Check status', tab2).click(); await waitText(/another tab/i, tab2); assert.equal((await journal(tab2))[0].outcome, 'sending')
    // Background tabs get throttled timers; bring the sending tab back to the front.
    await page.bringToFront(); await st(page, { hold: false }); await waitHashes(1); await mine((await hashes())[0], 'success', deposited(raw('0.25'))); await waitText(/confirmed/)
    // The other tab follows the journal through storage events; Check status (if still shown) settles nothing new.
    await tab2.bringToFront(); if (await btn('Check status', tab2).count()) await btn('Check status', tab2).click().catch(() => {}); await pendingPanel(tab2).waitFor({ state: 'detached', timeout: 5000 }); assert.equal(await sends(tab2), 0)
  })
  await test('wallet switch: a review is dropped on account change; an open outcome belongs to its wallet only and returns with it', async () => {
    await fresh(); await reviewDeposit('0.25'); await page.evaluate(a => window.earnTest.setAddress(a), OTHER)
    await btn(/^Deposit .* USDC$/).waitFor({ state: 'detached', timeout: 3000 })
    await page.evaluate(a => window.earnTest.setAddress(a), OWNER); await st(page, { sdk: [{ after: 'throw' }] }); await reviewDeposit('0.25'); await btn('Deposit 0.25 USDC').click(); await pendingPanel().waitFor({ timeout: 5000 }); await settledTo('unknown')
    await page.evaluate(a => window.earnTest.setAddress(a), OTHER); await pendingPanel().waitFor({ state: 'detached', timeout: 3000 }); assert.equal(await btn(/Review .* deposit/).isDisabled(), false)
    await page.evaluate(a => window.earnTest.setAddress(a), OWNER); await pendingPanel().waitFor({ timeout: 3000 })
  })
  await test('wrong vault, wrong account and journal binding: changing the vault drops the review; a transaction from another account is never forwarded', async () => {
    await fresh(); await reviewDeposit('0.25'); await page.locator('select').selectOption(VAULT_B); await btn(/^Deposit .* USDC$/).waitFor({ state: 'detached', timeout: 3000 })
    await st(page, { sdk: [{ from: OTHER }] }); await reviewDeposit('0.25'); await btn('Deposit 0.25 USDC').click(); await waitText(/wallet account/i)
    assert.equal(await sends(), 0, 'nothing reached the wallet'); const [j] = await journal(); assert.equal(j.outcome, 'not_sent'); assert.equal(j.vault, VAULT_B.toLowerCase())
  })
  await test('amounts are compared exactly (bigint): balance, precision and position limits', async () => {
    await fresh(); chain.balance = raw('0.2'); await setAmount('0.25'); await btn(/Review .* deposit/).click(); await waitText(/exceeds your Arc USDC balance/)
    // Float comparison treats 9007199254.740994 and 9007199254.740993 as equal.
    chain.balance = 9007199254740993n; await setAmount('9007199254.740994'); await btn(/Review .* deposit/).click(); await waitText(/exceeds your Arc USDC balance/)
    await setAmount('0.0000001'); await btn(/Review .* deposit/).click(); await waitText(/valid USDC amount/)
    await st(page, { position: '0.300000000000000001' }); await setAmount('0.300001'); await btn('Review withdrawal').click(); await waitText(/exceeds your current vault position/)
    assert.equal((await W(page, () => window.earnTest.state.quotes)).length, 0, 'no quote for an invalid amount'); assert.equal(await sends(), 0)
  })
  await test('the journal must be written before the request: if storage fails, nothing is sent', async () => {
    await fresh(); await reviewDeposit('0.25')
    await page.evaluate(k => { const set = Storage.prototype.setItem; Storage.prototype.setItem = function (key, value) { if (key === k) throw new Error('QuotaExceededError'); return set.call(this, key, value) } }, JOURNAL)
    await btn('Deposit 0.25 USDC').click(); await waitText(/could not be saved/i)
    assert.equal(await W(page, () => window.earnTest.state.sdkCalls.length), 0); assert.equal(await sends(), 0)
  })
  await test('no attempt evidence, no send: an unreachable Arc RPC or a pending wallet transaction blocks the request', async () => {
    await fresh(); await reviewDeposit('0.25'); chain.rpcDown = true; await btn('Deposit 0.25 USDC').click(); await page.waitForTimeout(600)
    assert.equal(await sends(), 0); chain.rpcDown = false
    await reviewDeposit('0.25'); chain.nonce.pending = chain.nonce.latest + 1; await btn('Deposit 0.25 USDC').click(); await waitText(/pending transaction/i)
    assert.equal(await sends(), 0); assert.equal(await pendingPanel().count(), 0)
  })
  if (failures.length) { console.log(`RESULT ${count} PASS, ${failures.length} FAIL`); process.exitCode = 1 }
  else { assert.deepEqual(errors.filter(e => !/Unexpected Arc method eth_getBlockByNumber/.test(e)), [], 'no page or RPC errors'); console.log(`RESULT ${count}/${count} Earn send safety groups PASS; controlled wallet, EarnKit stand-in and Arc RPC; no network.`) }
} finally { await browser?.close(); await server.close() }
