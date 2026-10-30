// Chromium: EVM CCTP approval/burn send safety in the real useMainnetCctp hook
// and the real transfer queue + recovery loop. Controlled wallet client and Arc
// RPC (no network, no real signature or transaction).
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'
const require = createRequire(import.meta.url), v = require('viem')
let chromium; try { ({ chromium } = require('playwright-core')) } catch { ({ chromium } = require('/opt/codex/runtimes/cua/lib/node_modules/playwright-core')) }
const root = fileURLToPath(new URL('..', import.meta.url))
const OWNER = '0xafbb6cc5c0a9c0eb1bff8db2ed807e83aab8e321', OTHER = '0x' + '11'.repeat(20)
const TM = '0x28b5a0e9c621a5badaa536219b3a228c8168cf5d', USDC = '0x3600000000000000000000000000000000000000'
const DEPOSIT = v.encodeEventTopics({ abi: v.parseAbi(['event DepositForBurn(address indexed burnToken,uint256 amount,address indexed depositor,bytes32 mintRecipient,uint32 destinationDomain,bytes32 destinationTokenMessenger,bytes32 destinationCaller,uint256 maxFee,uint32 indexed minFinalityThreshold,bytes hookData)']), eventName: 'DepositForBurn' })[0]
// wagmi stand-in: identity + a wallet client whose sendTransaction the test controls.
const wagmiMock = `import { useSyncExternalStore } from 'react'
const W = window.cctpTest
export function useAccount(){ const s = useSyncExternalStore(l => { W.listeners.add(l); return () => W.listeners.delete(l) }, () => W.snapshot); return { address: s.address, isConnected: Boolean(s.address), chainId: 5042, connector: { name: 'MetaMask' } } }
export function useSwitchChain(){ return { switchChainAsync: async () => {} } }
export function useReadContract(){ return { data: undefined, refetch: async () => ({ data: undefined }) } }`
const actionsMock = `export async function getWalletClient(){ const W = window.cctpTest; return { sendTransaction: async tx => { W.state.sends.push({ to: tx.to, data: tx.data }); const mode = W.state.send.shift() ?? 'hash'; await new Promise(r => setTimeout(r, W.state.sendDelay ?? 0))
  if (mode === 'reject') { const e = new Error('User rejected the request.'); e.name = 'UserRejectedRequestError'; e.code = 4001; throw e }
  if (mode === 'lost') throw new Error('Wallet connection lost before it reported a hash.')
  const hash = '0x' + (W.state.sends.length).toString(16).padStart(64, 'a'); W.state.hashes.push(hash); return hash } } }`
const server = await createServer({ root, configFile: false, cacheDir: '/tmp/machina-cctp-send-ui', plugins: [{ name: 'cctp-send', enforce: 'pre',
  resolveId(id) { if (id === 'wagmi') return '\0cs-wagmi'; if (id === 'wagmi/actions') return '\0cs-actions'; if (id.endsWith('/lib/wagmi.config')) return '\0cs-config' },
  load(id) { if (id === '\0cs-wagmi') return wagmiMock; if (id === '\0cs-actions') return actionsMock; if (id === '\0cs-config') return 'export const wagmiConfig={}' },
  configureServer(s) { s.middlewares.use('/__cctp', async (_q, res) => { res.setHeader('Content-Type', 'text/html'); res.end(await s.transformIndexHtml('/__cctp', `<!doctype html><html><body><div id="root"></div><script>window.cctpTest={state:{address:'${OWNER}',send:[],sends:[],hashes:[]},listeners:new Set()};window.cctpTest.snapshot={address:'${OWNER}'};window.cctpTest.setAddress=a=>{window.cctpTest.state.address=a;window.cctpTest.snapshot={address:a};window.cctpTest.listeners.forEach(l=>l())}</script><script type="module" src="/scripts/fixtures/mainnet-cctp-send.tsx"></script></body></html>`)) }) } }], server: { host: '127.0.0.1', port: 0 } })

// Arc RPC model. receipts: hash -> 'success' | 'reverted' | 'pending'; rpcDown makes every read fail.
// receiptDown: only receipt/transaction reads fail (the wallet already returned a hash).
const chain = { block: 1000, nonce: { latest: 7, pending: 7 }, allowance: 0n, receipts: {}, burns: [], rpcDown: false, receiptDown: false, calls: [] }
const hexn = n => '0x' + BigInt(n).toString(16)
function receipt(hash, status) { return { transactionHash: hash, blockHash: '0x' + 'bb'.repeat(32), blockNumber: hexn(chain.block - 1), transactionIndex: '0x0', from: OWNER, to: TM, status: status === 'success' ? '0x1' : '0x0', logs: [], logsBloom: '0x' + '0'.repeat(512), gasUsed: '0x5208', cumulativeGasUsed: '0x5208', effectiveGasPrice: '0x1', contractAddress: null, type: '0x2' } }
function answer(body) {
  chain.calls.push(body.method)
  switch (body.method) {
    case 'eth_chainId': return '0x13b2'
    case 'eth_blockNumber': return hexn(chain.block)
    case 'eth_getBlockByNumber': return { number: hexn(chain.block), hash: '0x' + 'bb'.repeat(32), parentHash: '0x' + 'cc'.repeat(32), timestamp: '0x6000', gasLimit: '0x1', gasUsed: '0x0', baseFeePerGas: '0x1', transactions: [], nonce: '0x0000000000000000', difficulty: '0x0', size: '0x1', extraData: '0x', miner: OWNER, logsBloom: '0x' + '0'.repeat(512), sha3Uncles: '0x' + '00'.repeat(32), stateRoot: '0x' + '00'.repeat(32), receiptsRoot: '0x' + '00'.repeat(32), transactionsRoot: '0x' + '00'.repeat(32) }
    case 'eth_getTransactionReceipt': { const s = chain.receipts[body.params[0]]; return s && s !== 'pending' ? receipt(body.params[0], s) : null }
    case 'eth_getTransactionByHash': { const h = body.params[0], s = chain.receipts[h]; if (s === undefined) return null; return { hash: h, from: OWNER, to: TM, nonce: hexn(chain.nonce.latest), input: '0x', value: '0x0', gas: '0x5208', maxFeePerGas: '0x2', maxPriorityFeePerGas: '0x1', type: '0x2', chainId: '0x13b2', v: '0x0', r: '0x1', s: '0x1', yParity: '0x0', accessList: [], blockHash: s === 'pending' ? null : '0x' + 'bb'.repeat(32), blockNumber: s === 'pending' ? null : hexn(chain.block - 1), transactionIndex: s === 'pending' ? null : '0x0' } }
    case 'eth_getTransactionCount': return hexn(body.params[1] === 'pending' ? chain.nonce.pending : chain.nonce.latest)
    case 'eth_call': return '0x' + chain.allowance.toString(16).padStart(64, '0')
    case 'eth_getLogs': { const f = body.params[0]; return chain.burns.filter(b => b.block >= Number(BigInt(f.fromBlock)) && b.block <= Number(BigInt(f.toBlock))).map(b => ({ address: TM, topics: [DEPOSIT, '0x' + USDC.slice(2).padStart(64, '0'), '0x' + OWNER.slice(2).padStart(64, '0'), hexn(2000).replace('0x', '0x' + '0'.repeat(62))], data: v.encodeAbiParameters(v.parseAbiParameters('uint256,bytes32,uint32,bytes32,bytes32,uint256,bytes'), [b.amount, '0x' + OWNER.slice(2).padStart(64, '0'), 6, '0x' + '00'.repeat(32), '0x' + OWNER.slice(2).padStart(64, '0'), 0n, '0x']), blockNumber: hexn(b.block), transactionHash: b.hash, logIndex: '0x0', blockHash: '0x' + 'bb'.repeat(32), transactionIndex: '0x0', removed: false })) }
    default: throw new Error('Unexpected Arc method ' + body.method)
  }
}
let browser, page, count = 0; const errors = []
const failures = []
// REPORT_ALL=1 lists every failing group (used to show the defects before a fix).
async function test(name, fn) { try { await fn() } catch (e) { if (process.env.REPORT_ALL) { failures.push(name); console.log('FAIL ' + name + ' :: ' + String(e.message).split('\n')[0]); return } console.error('records:', JSON.stringify(await page.evaluate(() => window.cctpTest.api?.all()).catch(() => null)).slice(0, 1500), 'state:', JSON.stringify(await page.evaluate(() => ({ sends: window.cctpTest.state.sends.length, hashes: window.cctpTest.state.hashes }))), chain.calls.slice(-10)); throw e } count++; console.log('PASS ' + name) }
try {
  await server.listen(); const base = `http://127.0.0.1:${server.httpServer.address().port}/__cctp`
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] })
  const context = await browser.newContext()
  await context.route('**/*', async route => {
    const req = route.request(), url = new URL(req.url())
    if (url.hostname === '127.0.0.1') return route.continue()
    if (url.hostname === 'rpc.mainnet.arc.io' && req.method() === 'POST') {
      if (chain.rpcDown) return route.fulfill({ status: 503, body: 'down' })
      const body = req.postDataJSON(), many = Array.isArray(body)
      if (chain.receiptDown && (many ? body : [body]).some(b => ['eth_getTransactionReceipt', 'eth_getTransactionByHash'].includes(b.method))) return route.fulfill({ status: 503, body: 'down' })
      try { const out = (many ? body : [body]).map(b => ({ jsonrpc: '2.0', id: b.id, result: answer(b) })); return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(many ? out : out[0]) }) }
      catch (e) { errors.push(e.message); return route.fulfill({ status: 500, body: e.message }) }
    }
    return route.abort()
  })
  page = await context.newPage(); page.on('pageerror', e => errors.push(e.message))
  const open = async () => { await page.goto(base); await page.waitForFunction(() => Boolean(window.cctpTest.api)) }
  const fresh = async () => { await open(); await page.evaluate(() => localStorage.clear()); Object.assign(chain, { block: 1000, nonce: { latest: 7, pending: 7 }, allowance: 0n, receipts: {}, burns: [], rpcDown: false, receiptDown: false }); await open() }
  const api = (fn, ...a) => page.evaluate(([fn, a]) => window.cctpTest.api[fn](...a), [fn, a])
  const st = p => page.evaluate(p => Object.assign(window.cctpTest.state, p), p)
  const sends = () => page.evaluate(() => window.cctpTest.state.sends.length)
  const lastHash = () => page.evaluate(() => window.cctpTest.state.hashes.at(-1))
  const waitStage = (id, stage, ms = 15000) => page.waitForFunction(([id, stage]) => window.cctpTest.api.record(id)?.stage === stage, [id, stage], { timeout: ms })
  // Mines the next wallet send: the hash appears with the given receipt status.
  const mine = status => page.evaluate(() => window.cctpTest.state.hashes.length).then(async n => { for (let i = 0; i < 100 && (await page.evaluate(() => window.cctpTest.state.hashes.length)) === n; i++) await page.waitForTimeout(20) }).then(async () => { chain.receipts[await lastHash()] = status; chain.block += 2 })

  await test('a successful approval and burn keep the existing flow (approved, then waiting for Circle)', async () => {
    await fresh(); const id = await api('plan', '1.5')
    const p = api('approve', id, '1.5'); await mine('success'); assert.ok((await p).ok); assert.equal((await api('record', id)).stage, 'approved')
    const b = api('burn', id, '1.5'); await mine('success'); assert.ok((await b).ok); const r = await api('record', id); assert.equal(r.stage, 'waiting_attestation'); assert.equal(r.sourceTxHash, await lastHash())
  })
  await test('a REVERTED approval is never treated as approved; the hash is kept as evidence', async () => {
    await fresh(); const id = await api('plan', '1.5')
    const p = api('approve', id, '1.5'); await mine('reverted'); const res = await p
    const r = await api('record', id); assert.ok(res.error, 'the caller sees a failure'); assert.equal(r.stage, 'approval_required'); assert.match(r.lastError, new RegExp((await lastHash()).slice(2, 12)))
  })
  await test('a REVERTED burn never moves to waiting for Circle; the transfer returns to its approved state with the hash as evidence', async () => {
    await fresh(); const id = await api('plan', '1.5')
    const p = api('approve', id, '1.5'); await mine('success'); await p
    const b = api('burn', id, '1.5'); await mine('reverted'); const res = await b
    const r = await api('record', id); assert.ok(res.error); assert.equal(r.stage, 'approved'); assert.match(r.lastError, new RegExp((await lastHash()).slice(2, 12))); assert.notEqual(r.sourceTxHash, await lastHash(), 'a reverted burn is not the source transaction')
  })
  await test('RPC failure after the wallet returned a hash: the outcome stays unknown and locked, no second approval or burn; recovery confirms it later', async () => {
    await fresh(); const id = await api('plan', '1.5')
    chain.receiptDown = true; const p = api('approve', id, '1.5'); const res = await p
    let r = await api('record', id); assert.ok(res.error); assert.equal(r.stage, 'approving'); assert.equal(r.approvalTxHash, await lastHash()); assert.match(r.lastError, /not confirmed yet/)
    assert.ok((await api('approve', id, '1.5')).error); assert.equal(await sends(), 1, 'no second approval request')
    chain.receiptDown = false; chain.receipts[await lastHash()] = 'success'; await waitStage(id, 'approved')
  })
  await test('no new transfer can start for the same wallet while an approval or burn outcome is unresolved', async () => {
    await fresh(); const id = await api('plan', '1.5'); chain.receiptDown = true; await api('approve', id, '1.5')
    const second = await page.evaluate(() => { try { window.cctpTest.api.plan('2'); return 'created' } catch (e) { return e.message } })
    assert.match(second, /unresolved|pending|not confirmed/i)
    chain.receiptDown = false; chain.receipts[await lastHash()] = 'success'; await waitStage(id, 'approved')
    const third = await page.evaluate(() => { try { return typeof window.cctpTest.api.plan('2') } catch (e) { return e.message } })
    assert.equal(third, 'string', 'allowed again once the chain confirmed the earlier step')
  })
  await test('the wallet errors without a hash (lost hash): the step stays locked as unknown; no second approval request', async () => {
    await fresh(); const id = await api('plan', '1.5'); await st({ send: ['lost'] })
    const res = await api('approve', id, '1.5'); const r = await api('record', id)
    assert.ok(res.error); assert.equal(r.stage, 'approving', 'not released for a retry'); assert.match(r.lastError, /did not confirm whether/i)
    assert.ok((await api('approve', id, '1.5')).error); assert.equal(await sends(), 1)
  })
  await test('lost approval hash: released only by chain evidence (allowance covers it -> approved; nonce used without allowance -> approval required)', async () => {
    await fresh(); let id = await api('plan', '1.5'); await st({ send: ['lost'] }); await api('approve', id, '1.5')
    chain.allowance = 1_500_000n; await waitStage(id, 'approved')
    await fresh(); id = await api('plan', '1.5'); await st({ send: ['lost'] }); await api('approve', id, '1.5')
    await page.waitForTimeout(5000); assert.equal((await api('record', id)).stage, 'approving', 'nonce unchanged: still unknown')
    chain.nonce = { latest: 8, pending: 8 }; await waitStage(id, 'approval_required')
  })
  await test('lost burn hash: a matching DepositForBurn after the attempt is adopted; anything else (another amount, a moved nonce) keeps it locked', async () => {
    await fresh(); let id = await api('plan', '1.5', false); await st({ send: ['lost'] }); await api('burn', id, '1.5'); assert.equal((await api('record', id)).stage, 'burning')
    const hash = '0x' + 'de'.repeat(32); chain.nonce = { latest: 8, pending: 8 }; chain.burns.push({ block: chain.block + 1, amount: 1_500_000n, hash }); chain.receipts[hash] = 'success'; chain.block += 3
    await waitStage(id, 'waiting_attestation'); assert.equal((await api('record', id)).sourceTxHash, hash)
    await fresh(); id = await api('plan', '1.5', false); await st({ send: ['lost'] }); await api('burn', id, '1.5')
    chain.burns.push({ block: chain.block + 1, amount: 2_000_000n, hash: '0x' + 'ef'.repeat(32) }); chain.block += 3
    await page.waitForTimeout(5000); assert.equal((await api('record', id)).stage, 'burning', 'a burn of another amount is not adopted; nonce unchanged keeps it locked')
    // A moved nonce is not proof: the wallet may still broadcast the burn later. Only a matching burn releases the step.
    chain.nonce = { latest: 9, pending: 9 }; chain.block += 3; await page.waitForTimeout(5000)
    const r = await api('record', id); assert.equal(r.stage, 'burning'); assert.equal(r.sourceTxHash, undefined)
  })
  await test('no second burn while the first burn is unresolved (RPC timeout after the hash, or a lost hash): the wallet is never asked again until the source burn is proven', async () => {
    for (const mode of ['receiptDown', 'lost']) {
      await fresh(); const id = await api('plan', '1.5', false)
      if (mode === 'receiptDown') chain.receiptDown = true; else await st({ send: ['lost'] })
      const first = await api('burn', id, '1.5'); assert.ok(first.error, mode)
      assert.equal((await api('record', id)).stage, 'burning', mode); assert.equal(await sends(), 1)
      const again = await api('burn', id, '1.5'); assert.ok(again.error, mode + ': a second burn of the same transfer is refused'); assert.equal(await sends(), 1, mode)
      const other = await page.evaluate(() => { try { window.cctpTest.api.plan('2', false); return 'created' } catch (e) { return e.message } })
      assert.match(other, /not confirmed/i, mode + ': no other transfer from this wallet either')
      chain.nonce = { latest: 8, pending: 8 }; chain.block += 3; await page.waitForTimeout(3000)
      assert.equal((await api('record', id)).stage, 'burning', mode + ': still locked after the nonce moved'); assert.equal(await sends(), 1)
      if (mode === 'receiptDown') { chain.receiptDown = false; chain.receipts[await lastHash()] = 'success'; await waitStage(id, 'waiting_attestation') }
    }
  })
  await test('RPC unavailable before the wallet request: no wallet request is made and the step can be reviewed again', async () => {
    await fresh(); const id = await api('plan', '1.5'); chain.rpcDown = true
    assert.ok((await api('approve', id, '1.5')).error); assert.equal(await sends(), 0); assert.equal((await api('record', id)).stage, 'approval_required')
  })
  await test('a wallet with a pending transaction (pending nonce ahead) is not asked for another one', async () => {
    await fresh(); const id = await api('plan', '1.5'); chain.nonce = { latest: 7, pending: 8 }
    const res = await api('approve', id, '1.5'); assert.match(res.error, /pending transaction/); assert.equal(await sends(), 0)
  })
  await test('a user rejection (4001) is certain: the step returns to its previous state and can be reviewed again', async () => {
    await fresh(); const id = await api('plan', '1.5'); await st({ send: ['reject'] })
    assert.ok((await api('approve', id, '1.5')).error); assert.equal((await api('record', id)).stage, 'approval_required')
  })
  await test('double click: two concurrent approvals send one wallet request', async () => {
    await fresh(); const id = await api('plan', '1.5'); await st({ sendDelay: 300 })
    const [a, b] = await Promise.all([api('approve', id, '1.5'), api('approve', id, '1.5'), mine('success')]).then(x => x.slice(0, 2))
    assert.equal(await sends(), 1); assert.ok([a, b].some(x => x.error))
  })
  await test('refresh during an unknown burn keeps the lock and the recovery continues after reload', async () => {
    await fresh(); const id = await api('plan', '1.5', false); chain.receiptDown = true; await api('burn', id, '1.5'); const hash = await lastHash()
    await open(); assert.equal((await api('record', id)).stage, 'burning'); assert.ok((await api('burn', id, '1.5')).error, 'no second burn after reload'); chain.receiptDown = false; chain.receipts[hash] = 'success'; await waitStage(id, 'waiting_attestation')
  })
  await test('wallet switch: another connected account cannot approve or burn this transfer', async () => {
    await fresh(); const id = await api('plan', '1.5'); await page.evaluate(a => window.cctpTest.setAddress(a), OTHER)
    assert.ok((await api('approve', id, '1.5')).error); assert.equal(await sends(), 0)
  })
  if (failures.length) throw new Error(`${failures.length} group(s) failed`)
  assert.deepEqual(errors, [])
  console.log(`RESULT ${count}/${count} Chromium EVM CCTP send-safety groups PASS; real hook/queue/recovery, controlled wallet and Arc RPC; real network/signatures/transactions=0.`)
} finally { await browser?.close(); await server.close() }
