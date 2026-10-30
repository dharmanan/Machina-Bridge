// The REAL Circle Earn Kit (EarnKit + provider-earn-service) and the REAL viem
// adapter, wired through Machina's Earn journal and wallet-provider guard, against
//   * a controlled Arc chain model (allowances, nonces, receipts and logs shaped
//     like the real Earn executions in fixtures/real-earn-txs.json), and
//   * controlled Circle Earn API responses (the signed execution params).
// No network, no real signature, no real transaction.
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
const require = createRequire(import.meta.url), ts = require('typescript')
require.extensions['.ts'] = (m, f) => m._compile(ts.transpileModule(readFileSync(f, 'utf8').replaceAll('import.meta.env', '({})'), { fileName: f, compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText, f)
const store = new Map()
globalThis.window = { localStorage: { getItem: k => store.has(k) ? store.get(k) : null, setItem: (k, v) => { if (storageBroken) throw new Error('QuotaExceededError'); store.set(k, String(v)) }, removeItem: k => store.delete(k) } }
let storageBroken = false
const J = require('../src/lib/earnJournal.ts')
const v = require('viem')
const { EarnKit } = await import('@circle-fin/earn-kit')
const { createViemAdapterFromProvider } = await import('@circle-fin/adapter-viem-v2')
const REAL = JSON.parse(readFileSync(new URL('./fixtures/real-earn-txs.json', import.meta.url), 'utf8'))

const OWNER = '0xafbb6cc5c0a9c0eb1bff8db2ed807e83aab8e321', ATTACKER = '0x' + '66'.repeat(20)
const ADAPTER = REAL.adapter, USDC = '0x3600000000000000000000000000000000000000'
const VAULT_A = '0x8e357432cc12ff425c36432f312968aeb16112af', VAULT_B = '0xdeccd53be5453215821184824b519e04c7e00bc7'
const ERC20 = v.parseAbi(['function approve(address spender,uint256 amount)', 'function increaseAllowance(address spender,uint256 addedValue)', 'function allowance(address owner,address spender) view returns (uint256)', 'function balanceOf(address) view returns (uint256)', 'function decimals() view returns (uint8)', 'event Transfer(address indexed from,address indexed to,uint256 value)', 'event Approval(address indexed owner,address indexed spender,uint256 value)'])
const VAULT_EVENTS = v.parseAbi(['event Deposit(address indexed sender,address indexed owner,uint256 assets,uint256 shares)', 'event Withdraw(address indexed sender,address indexed receiver,address indexed owner,uint256 assets,uint256 shares)'])
const EXEC = v.parseAbi(['function execute(((address target,bytes data,uint256 value,address tokenIn,uint256 amountToApprove,address tokenOut,uint256 minTokenOut)[] instructions,(address token,address beneficiary)[] tokens,uint256 execId,uint256 deadline,bytes metadata) params,(uint8 permitType,address token,uint256 amount,bytes permitCalldata)[] tokenInputs,bytes signature)'])
const INNER = v.parseAbi(['function deposit(uint256 assets,address receiver)', 'function withdraw(uint256 assets,address receiver,address owner)', 'function redeem(uint256 shares,address receiver,address owner)', 'function claim(address[] users,address[] tokens,uint256[] amounts,bytes32[][] proofs)'])
const raw = s => v.parseUnits(s, 6), hexn = n => '0x' + BigInt(n).toString(16), lc = a => a.toLowerCase()

// ---------- controlled Arc chain ----------
let chain, hashSeq = 0 // hashes stay unique across tests, so a late timer can never touch a later test's chain
function resetChain() {
  chain = { block: 9000n, nonce: 40, pending: 40, usdc: { [OWNER]: raw('100') }, shares: { [VAULT_A]: { [OWNER]: 50n * 10n ** 18n }, [VAULT_B]: { [OWNER]: 50n * 10n ** 18n } }, allowance: {}, txs: {}, receipts: {}, logs: [], seq: 0,
    autoMine: true, holdExecute: false, receiptDown: false, executeOutcome: 'success', executeLogs: 'real', approveOutcome: 'success', calls: [] }
}
const allowanceKey = (token, owner, spender) => `${lc(token)}:${lc(owner)}:${lc(spender)}`
const log = (address, event, args, hash) => { const topics = v.encodeEventTopics({ abi: event.abi, eventName: event.name, args }); return { address, topics, data: v.encodeAbiParameters(event.abi.find(e => e.name === event.name).inputs.filter(i => !i.indexed), event.data), transactionHash: hash } }
const T = { abi: ERC20, name: 'Transfer' }, A = { abi: ERC20, name: 'Approval' }
function mine(hash) {
  const tx = chain.txs[hash]; if (!tx || chain.receipts[hash]) return
  chain.block += 1n; chain.nonce = Math.max(chain.nonce, tx.nonce + 1); let status = 'success'; const logs = []
  const to = lc(tx.to), sel = tx.data.slice(0, 10)
  if ((to === USDC || to === VAULT_A || to === VAULT_B) && (sel === '0x095ea7b3' || sel === '0x39509351')) {
    const d = v.decodeFunctionData({ abi: ERC20, data: tx.data }), k = allowanceKey(to, tx.from, d.args[0])
    if (chain.approveOutcome === 'reverted') status = 'reverted'
    else { chain.allowance[k] = (sel === '0x39509351' ? (chain.allowance[k] ?? 0n) : 0n) + d.args[1]; logs.push(log(to, { ...A, data: [chain.allowance[k]] }, { owner: tx.from, spender: d.args[0] }, hash)) }
  } else if (to === lc(ADAPTER)) {
    const d = v.decodeFunctionData({ abi: EXEC, data: tx.data }), [params, inputs] = d.args, ins = params.instructions[0], inner = v.decodeFunctionData({ abi: INNER, data: ins.data })
    if (chain.executeOutcome === 'reverted') status = 'reverted'
    else if (chain.executeLogs === 'real') {
      const vault = lc(ins.target), shares = 3n * 10n ** 17n
      if (inner.functionName === 'deposit') {
        const amount = inputs[0].amount
        logs.push(log(USDC, { ...T, data: [amount] }, { from: tx.from, to: ADAPTER }, hash), log(vault, { ...T, data: [shares] }, { from: v.zeroAddress, to: ADAPTER }, hash),
          log(vault, { abi: VAULT_EVENTS, name: 'Deposit', data: [amount, shares] }, { sender: ADAPTER, owner: ADAPTER }, hash), log(vault, { ...T, data: [shares] }, { from: ADAPTER, to: tx.from }, hash))
      } else {
        const assets = inner.args[0]
        logs.push(log(vault, { ...T, data: [inputs[0].amount] }, { from: tx.from, to: ADAPTER }, hash), log(USDC, { ...T, data: [assets] }, { from: vault, to: ADAPTER }, hash),
          log(vault, { abi: VAULT_EVENTS, name: 'Withdraw', data: [assets, shares] }, { sender: ADAPTER, receiver: ADAPTER, owner: ADAPTER }, hash), log(USDC, { ...T, data: [assets] }, { from: ADAPTER, to: tx.from }, hash))
      }
    } else if (chain.executeLogs === 'unrelated') logs.push(log(USDC, { ...T, data: [1n] }, { from: tx.from, to: ATTACKER }, hash))
  }
  logs.forEach((l, i) => Object.assign(l, { blockNumber: hexn(chain.block), logIndex: hexn(chain.logs.length + i), blockHash: '0x' + 'bb'.repeat(32), transactionIndex: '0x0', removed: false }))
  chain.receipts[hash] = { status, block: chain.block, logs }; chain.logs.push(...logs)
}
function broadcast(tx) {
  const hash = v.keccak256(v.toHex(`machina-earn-test-${++hashSeq}`))
  chain.txs[hash] = { from: lc(tx.from), to: lc(tx.to), data: tx.data ?? '0x', nonce: chain.pending++ }
  if (chain.autoMine && !(chain.holdExecute && lc(tx.to) === lc(ADAPTER))) setTimeout(() => mine(hash), 5)
  return hash
}
const receiptJson = hash => { const r = chain.receipts[hash], tx = chain.txs[hash]; return { transactionHash: hash, blockHash: '0x' + 'bb'.repeat(32), blockNumber: hexn(r.block), transactionIndex: '0x0', from: tx.from, to: tx.to, status: r.status === 'success' ? '0x1' : '0x0', logs: r.logs, logsBloom: '0x' + '0'.repeat(512), gasUsed: '0x5208', cumulativeGasUsed: '0x5208', effectiveGasPrice: '0x1', contractAddress: null, type: '0x2' } }
function rpc(method, params = []) {
  chain.calls.push(method)
  if (chain.receiptDown && ['eth_getTransactionReceipt', 'eth_getTransactionByHash', 'eth_getLogs'].includes(method)) { const e = new Error('HTTP 503 upstream unavailable'); e.code = -32603; throw e }
  switch (method) {
    case 'eth_chainId': return '0x13b2'
    case 'eth_blockNumber': return hexn(chain.block)
    case 'eth_getBlockByNumber': return { number: hexn(chain.block), hash: '0x' + 'bb'.repeat(32), parentHash: '0x' + 'cc'.repeat(32), timestamp: hexn(Math.floor(Date.now() / 1000)), gasLimit: '0x1c9c380', gasUsed: '0x0', baseFeePerGas: '0x1', transactions: [], nonce: '0x0000000000000000', difficulty: '0x0', size: '0x1', extraData: '0x', miner: OWNER, logsBloom: '0x' + '0'.repeat(512), sha3Uncles: '0x' + '00'.repeat(32), stateRoot: '0x' + '00'.repeat(32), receiptsRoot: '0x' + '00'.repeat(32), transactionsRoot: '0x' + '00'.repeat(32) }
    case 'eth_gasPrice': case 'eth_maxPriorityFeePerGas': return '0x1'
    case 'eth_estimateGas': return '0x30000'
    case 'eth_getTransactionCount': return hexn(params[1] === 'pending' ? chain.pending : chain.nonce)
    case 'eth_call': {
      const { to, data } = params[0]
      // Pre-send simulations of approve / increaseAllowance / Adapter.execute succeed (a revert, when modelled, happens on chain).
      if (lc(to) === lc(ADAPTER)) return '0x'
      if (['0x095ea7b3', '0x39509351'].includes(data.slice(0, 10))) return v.encodeAbiParameters([{ type: 'bool' }], [true])
      const d = v.decodeFunctionData({ abi: ERC20, data })
      if (d.functionName === 'allowance') return v.encodeAbiParameters([{ type: 'uint256' }], [chain.allowance[allowanceKey(to, d.args[0], d.args[1])] ?? 0n])
      if (d.functionName === 'balanceOf') return v.encodeAbiParameters([{ type: 'uint256' }], [lc(to) === USDC ? chain.usdc[lc(d.args[0])] ?? 0n : chain.shares[lc(to)]?.[lc(d.args[0])] ?? 0n])
      if (d.functionName === 'decimals') return v.encodeAbiParameters([{ type: 'uint8' }], [lc(to) === USDC ? 6 : 18])
      throw new Error('unexpected eth_call ' + d.functionName)
    }
    case 'eth_getTransactionReceipt': return chain.receipts[params[0]] ? receiptJson(params[0]) : null
    case 'eth_getTransactionByHash': { const h = params[0], tx = chain.txs[h], r = chain.receipts[h]; if (!tx) return null; return { hash: h, from: tx.from, to: tx.to, nonce: hexn(tx.nonce), input: tx.data, value: '0x0', gas: '0x30000', maxFeePerGas: '0x2', maxPriorityFeePerGas: '0x1', type: '0x2', chainId: '0x13b2', v: '0x0', r: '0x1', s: '0x1', yParity: '0x0', accessList: [], blockHash: r ? '0x' + 'bb'.repeat(32) : null, blockNumber: r ? hexn(r.block) : null, transactionIndex: r ? '0x0' : null } }
    case 'eth_getLogs': { const f = params[0], from = BigInt(f.fromBlock), to = BigInt(f.toBlock), addrs = [f.address].flat().filter(Boolean).map(lc)
      assert.ok(to - from < 10_000n, 'log window within the Arc RPC limit (10,000 blocks)')
      return chain.logs.filter(l => BigInt(l.blockNumber) >= from && BigInt(l.blockNumber) <= to && (!addrs.length || addrs.includes(lc(l.address))) && (f.topics ?? []).every((t, i) => t === null || t === undefined || lc(l.topics[i] ?? '') === lc(t))) }
    default: throw new Error('unexpected Arc method ' + method)
  }
}
const transport = v.custom({ request: async ({ method, params }) => { try { return rpc(method, params) } catch (e) { if (process.env.DEBUG_RPC) console.log("RPC ERR", method, JSON.stringify(params)?.slice(0, 300), e.message); throw e } } })
const publicClient = v.createPublicClient({ transport, pollingInterval: 20 })

// ---------- controlled wallet (EIP-1193) ----------
let wallet
function resetWallet() { wallet = { sends: [], queue: [], account: OWNER } }
const walletProvider = { request: async ({ method, params }) => {
  if (method === 'eth_requestAccounts' || method === 'eth_accounts') return [wallet.account]
  if (method === 'eth_chainId') return '0x13b2'
  if (method === 'wallet_switchEthereumChain') return null
  if (method === 'eth_sendTransaction') {
    const tx = params[0]; wallet.sends.push({ to: lc(tx.to), data: tx.data, from: lc(tx.from) })
    const mode = wallet.queue.shift() ?? 'ok'
    if (mode === 'reject') { const e = new Error('User rejected the request.'); e.code = 4001; throw e }
    if (mode === 'lost') throw new Error('Wallet connection lost before it reported a hash.')
    const hash = broadcast(tx)
    if (mode === 'lostAfterBroadcast') throw new Error('Wallet connection lost after broadcasting.')
    return hash
  }
  return rpc(method, params)
} }

// ---------- controlled Circle Earn API (signed execution params) ----------
let api
const deadline = () => String(Math.floor(Date.now() / 1000) + 600)
function depositParams({ vault = VAULT_A, amount, receiver = ADAPTER, beneficiary = OWNER, extra = [], tokenInputExtra = 0n, target }) {
  return { instructions: [{ target: target ?? vault, data: v.encodeFunctionData({ abi: INNER, functionName: 'deposit', args: [amount, receiver] }), value: '0', tokenIn: USDC, amountToApprove: (amount + tokenInputExtra).toString(), tokenOut: vault, minTokenOut: '1' }, ...extra],
    tokens: [{ token: USDC, beneficiary }, { token: vault, beneficiary }], execId: '0x' + 'ab'.repeat(16), deadline: deadline(), metadata: '0x' }
}
function withdrawParams({ vault = VAULT_A, amount, shares = 4n * 10n ** 17n, receiver = ADAPTER, beneficiary = OWNER, tokenOut = USDC, fn = 'withdraw' }) {
  const data = fn === 'redeem' ? v.encodeFunctionData({ abi: INNER, functionName: 'redeem', args: [shares, receiver, receiver] }) : v.encodeFunctionData({ abi: INNER, functionName: 'withdraw', args: [amount, receiver, receiver] })
  return { instructions: [{ target: vault, data, value: '0', tokenIn: vault, amountToApprove: shares.toString(), tokenOut, minTokenOut: (amount * 995n / 1000n).toString() }],
    tokens: [{ token: USDC, beneficiary }, { token: vault, beneficiary }], execId: '0x' + 'cd'.repeat(16), deadline: deadline(), metadata: '0x' }
}
const realFetch = globalThis.fetch
globalThis.fetch = async (input, init = {}) => {
  const url = new URL(typeof input === 'string' ? input : input.url)
  if (url.origin !== 'https://api.circle.com') throw new Error('unexpected network request ' + url)
  const body = init.body ? JSON.parse(init.body) : {}
  if (url.pathname.endsWith('/earnKit/deposit') || url.pathname.endsWith('/earnKit/withdraw')) {
    api.requests.push({ path: url.pathname, body })
    const executionParams = api.params(body)
    return Response.json({ data: { execId: randomUUID(), executionParams, signature: '0x' + '11'.repeat(65) } })
  }
  if (url.pathname.endsWith('/earnKit/transactionReport')) return Response.json({ data: { status: 'recorded' } })
  return new Response('{"message":"not found"}', { status: 404 })
}
void realFetch

// ---------- one Earn operation, exactly as the app runs it ----------
const kit = new EarnKit()
// createViemAdapterFromProvider is async (returns a Promise).
const createAdapter = async provider => createViemAdapterFromProvider({ provider, getPublicClient: () => publicClient })
async function run(action, amount, vault = VAULT_A) {
  const amountRaw = raw(amount)
  if (J.runEarnOperation) return J.runEarnOperation({ kit, walletProvider, client: publicClient, createAdapter, chain: 'Arc', account: wallet.account, vault, action, amount, amountRaw })
  // Before the fix: the same sequence the component used.
  const attempt = await J.readEarnAttempt(publicClient, wallet.account)
  const record = J.createEarnRecord({ account: wallet.account, vault, action, amount, amountRaw, ...attempt })
  let sdkTxHash, sdkError
  try { const r = await kit[action]({ from: { adapter: await createAdapter(J.guardEarnProvider(walletProvider, record.id)), chain: 'Arc' }, vaultAddress: vault, amount, config: { batchTransactions: false } }); sdkTxHash = r?.txHash } catch (e) { sdkError = e }
  return { record: await J.settleEarnRecord(record.id, publicClient, sdkTxHash), sdkError }
}
const fresh = () => { store.clear(); storageBroken = false; resetChain(); resetWallet(); api = { requests: [], params: b => depositParams({ amount: BigInt(v.parseUnits(b.amount, 6)) }) } }
const sentKinds = () => wallet.sends.map(s => s.to === lc(ADAPTER) ? 'execute' : s.data.slice(0, 10) === '0x39509351' ? 'increaseAllowance' : s.data.slice(0, 10) === '0x095ea7b3' ? 'approve' : 'other')
const failures = []; let count = 0
async function test(name, fn) { try { await fn(); count++; console.log('PASS ' + name) } catch (e) { failures.push(name); console.log('FAIL ' + name + ' :: ' + String(e?.message ?? e).replace(/\s+/g, ' ').slice(0, 400)); if (!process.env.REPORT_ALL) { console.log(e?.stack); process.exit(1) } } }

// =========================================================================
await test('real SDK order, deposit needing an approval: USDC increaseAllowance(adapter) then ONE execute; both pass the guard and the deposit is verified', async () => {
  fresh(); const { record, sdkError } = await run('deposit', '1.25')
  assert.equal(sdkError, undefined, String(sdkError?.message))
  assert.deepEqual(sentKinds(), ['increaseAllowance', 'execute'], 'the real Earn Kit approves USDC with increaseAllowance, not approve')
  const inc = v.decodeFunctionData({ abi: ERC20, data: wallet.sends[0].data }); assert.equal(lc(inc.args[0]), lc(ADAPTER)); assert.equal(inc.args[1], raw('1.25') + 1n, 'SDK adds a 1-unit warm-slot residual')
  assert.equal(record.outcome, 'success'); assert.deepEqual(record.requests.map(r => [r.kind, r.state]), [['approve', 'hash'], ['execute', 'hash']])
  assert.equal(record.executeHash, Object.keys(chain.txs)[1])
})
await test('deposit with enough allowance: no approval, one execute, verified', async () => {
  fresh(); chain.allowance[allowanceKey(USDC, OWNER, ADAPTER)] = raw('5'); const { record } = await run('deposit', '1.25')
  assert.deepEqual(sentKinds(), ['execute']); assert.equal(record.outcome, 'success')
})
await test('withdraw needing a share approval: vault approve(adapter) then ONE execute; verified by USDC adapter -> wallet', async () => {
  fresh(); api.params = b => withdrawParams({ amount: v.parseUnits(b.amount, 6) }); const { record, sdkError } = await run('withdraw', '0.4')
  assert.equal(sdkError, undefined, String(sdkError?.message)); assert.deepEqual(sentKinds(), ['approve', 'execute']); assert.equal(wallet.sends[0].to, VAULT_A)
  assert.equal(record.outcome, 'success'); assert.deepEqual(record.requests.map(r => r.kind), ['approve', 'execute'])
})

// ---------- ground truth: real Arc mainnet Earn transactions ----------
const realRecord = (e, overrides = {}) => {
  const d = v.decodeFunctionData({ abi: EXEC, data: e.input }), ins = d.args[0].instructions[0], inner = v.decodeFunctionData({ abi: INNER, data: ins.data })
  return { account: lc(e.from), vault: lc(ins.target), action: e.kind, amountRaw: String(e.kind === 'deposit' ? d.args[1][0].amount : inner.args[0]), shareBalanceRaw: e.kind === 'withdraw' ? String(d.args[1][0].amount + 10n ** 18n) : undefined, ...overrides }
}
await test('the guard accepts every real Earn execute and approval (6 executions, 4 approvals from Arc mainnet) for their own wallet, vault and amount', () => {
  assert.equal(REAL.executions.length, 6); assert.equal(REAL.approvals.length, 4)
  for (const e of REAL.executions) assert.equal(J.classifyEarnRequest(realRecord(e), { from: e.from, to: e.to, data: e.input, value: '0x0' }), 'execute', e.hash)
  for (const a of REAL.approvals) {
    const exec = REAL.executions.find(e => lc(e.from) === lc(a.owner)), rec = realRecord(exec)
    assert.equal(J.classifyEarnRequest(rec, { from: a.owner, to: a.to, data: a.input }), 'approve', a.hash)
  }
  assert.equal(lc(J.EARN_ADAPTER), lc(ADAPTER))
})
await test('real executions are refused for another wallet, vault, amount or action; approvals for another spender, token or a larger amount are refused', () => {
  const dep = REAL.executions.find(e => e.kind === 'deposit'), wd = REAL.executions.find(e => e.kind === 'withdraw'), tx = e => ({ from: e.from, to: e.to, data: e.input })
  const refused = (rec, t, re) => assert.throws(() => J.classifyEarnRequest(rec, t), re)
  refused(realRecord(dep, { account: OWNER }), tx(dep), /another wallet account/)
  refused(realRecord(dep, { vault: VAULT_B }), tx(dep), /vault/)
  refused(realRecord(dep, { amountRaw: String(BigInt(realRecord(dep).amountRaw) - 1n) }), tx(dep), /amount/)
  refused(realRecord(dep, { action: 'withdraw', shareBalanceRaw: '1' }), tx(dep), /does not match/)
  refused(realRecord(wd, { amountRaw: '19000000' }), tx(wd), /amount/)
  refused(realRecord(wd, { shareBalanceRaw: '1000' }), tx(wd), /token inputs/, 'cannot pull more shares than the wallet holds')
  refused(realRecord(dep), { ...tx(dep), value: '0x1' }, /value/)
  const appr = REAL.approvals[0], rec = realRecord(REAL.executions.find(e => lc(e.from) === lc(appr.owner)))
  const enc = (fn, spender, amount) => v.encodeFunctionData({ abi: ERC20, functionName: fn, args: [spender, amount] })
  refused(rec, { from: appr.owner, to: USDC, data: enc('increaseAllowance', ATTACKER, 10n) }, /spender/)
  refused(rec, { from: appr.owner, to: USDC, data: enc('approve', ADAPTER, v.maxUint256) }, /approval amount/, 'no unlimited approval')
  refused(rec, { from: appr.owner, to: USDC, data: enc('increaseAllowance', ADAPTER, BigInt(rec.amountRaw) + 2n) }, /approval amount/)
  refused(rec, { from: appr.owner, to: VAULT_B, data: enc('approve', ADAPTER, 1n) }, /contract/)
  refused(rec, { from: appr.owner, to: USDC, data: v.encodeFunctionData({ abi: ERC20, functionName: 'balanceOf', args: [ADAPTER] }) }, /approval call/)
})
await test('success needs the real receipt evidence: all 6 real executions settle as success; the same receipts without the vault movement, or for another amount, do not', async () => {
  for (const e of REAL.executions) {
    for (const [mutate, expected] of [[r => r, 'success'], [r => ({ ...r, logs: r.logs.filter(l => lc(l.address) !== USDC) }), 'unknown'], [r => ({ ...r, logs: r.logs.filter(l => lc(l.address) !== lc(realRecord(e).vault)) }), 'unknown']]) {
      store.clear(); const rr = realRecord(e)
      const rec = J.createEarnRecord({ account: rr.account, vault: rr.vault, action: rr.action, amount: '0', amountRaw: BigInt(rr.amountRaw), shareBalanceRaw: rr.shareBalanceRaw && BigInt(rr.shareBalanceRaw), attemptNonce: e.nonce, attemptBlock: 1 })
      J.saveEarnRecord({ ...rec, requests: [{ kind: 'execute', state: 'hash', hash: e.hash }], executeHash: e.hash })
      const r = mutate(e.receipt), client = { getTransactionReceipt: async () => ({ ...r, status: r.status, from: e.from, to: e.to, blockNumber: BigInt(r.blockNumber) }), getTransaction: async () => ({ from: e.from, to: e.to, input: e.input, nonce: e.nonce }) }
      assert.equal((await J.settleEarnRecord(rec.id, client)).outcome, expected, e.hash + ' ' + expected)
    }
  }
  // A real successful receipt of ANOTHER operation (different amount) is never this operation's success.
  store.clear(); const e = REAL.executions[0], rr = realRecord(e)
  const rec = J.createEarnRecord({ account: rr.account, vault: rr.vault, action: 'deposit', amount: '0', amountRaw: BigInt(rr.amountRaw) + 1n, attemptNonce: 0, attemptBlock: 1 })
  J.saveEarnRecord({ ...rec, requests: [{ kind: 'execute', state: 'hash', hash: e.hash }], executeHash: e.hash })
  const s = await J.settleEarnRecord(rec.id, { getTransactionReceipt: async () => ({ ...e.receipt, from: e.from, to: e.to, blockNumber: 1n }), getTransaction: async () => ({ from: e.from, to: e.to, input: e.input, nonce: 1 }) })
  assert.equal(s.outcome, 'unknown'); assert.match(s.lastError, /not the reviewed/)
})

// ---------- one operation, one execute ----------
await test('a second execute (or a late approval) in the same operation never reaches the wallet; a second operation cannot start while one is open', async () => {
  fresh(); chain.autoMine = false
  const amountRaw = raw('1'), attempt = await J.readEarnAttempt(publicClient, OWNER)
  const rec = J.createEarnRecord({ account: OWNER, vault: VAULT_A, action: 'deposit', amount: '1', amountRaw, ...attempt }), guard = J.guardEarnProvider(walletProvider, rec.id)
  const p = depositParams({ amount: amountRaw }), execData = v.encodeFunctionData({ abi: EXEC, functionName: 'execute', args: [{ ...p, instructions: p.instructions.map(i => ({ ...i, value: 0n, amountToApprove: BigInt(i.amountToApprove), minTokenOut: 1n })), execId: 1n, deadline: BigInt(p.deadline) }, [{ permitType: 0, token: USDC, amount: amountRaw, permitCalldata: '0x' }], '0x' + '11'.repeat(65)] })
  const execTx = { from: OWNER, to: ADAPTER, data: execData }
  await guard.request({ method: 'eth_sendTransaction', params: [execTx] })
  await assert.rejects(guard.request({ method: 'eth_sendTransaction', params: [execTx] }), /already sent/)
  await assert.rejects(guard.request({ method: 'eth_sendTransaction', params: [{ from: OWNER, to: USDC, data: v.encodeFunctionData({ abi: ERC20, functionName: 'increaseAllowance', args: [ADAPTER, amountRaw] }) }] }), /already sent/)
  await assert.rejects(guard.request({ method: 'wallet_sendCalls', params: [{}] }), /one wallet transaction at a time/)
  assert.equal(wallet.sends.length, 1)
  await assert.rejects(run('deposit', '1'), /not confirmed yet/); assert.equal(wallet.sends.length, 1, 'no second deposit while the first is open')
})

// ---------- tampered Circle API responses (the SDK would sign what the API returns) ----------
for (const [label, action, params, expectApprovalSent] of [
  ['another vault as the deposit target', 'deposit', a => depositParams({ amount: a, target: VAULT_B }), true],
  ['a larger amount pulled than reviewed', 'deposit', a => depositParams({ amount: a, tokenInputExtra: 1n }), false],
  ['outputs (shares/refunds) sent to another beneficiary', 'deposit', a => depositParams({ amount: a, beneficiary: ATTACKER }), true],
  ['the vault deposit credited to another receiver', 'deposit', a => depositParams({ amount: a, receiver: ATTACKER }), true],
  ['an extra instruction', 'deposit', a => depositParams({ amount: a, extra: [depositParams({ amount: 1n, vault: VAULT_B }).instructions[0]] }), true],
  ['a withdrawal of less than reviewed', 'withdraw', a => withdrawParams({ amount: a - 1n }), true],
  ['a redeem instead of the reviewed withdraw', 'withdraw', a => withdrawParams({ amount: a, fn: 'redeem' }), true],
  ['withdrawn USDC routed to another beneficiary', 'withdraw', a => withdrawParams({ amount: a, beneficiary: ATTACKER }), true],
]) await test(`tampered Circle response (${label}) through the real SDK: the execute never reaches the wallet; nothing was sent`, async () => {
  fresh(); api.params = b => params(v.parseUnits(b.amount, 6))
  const { record } = await run(action, '1')
  assert.ok(!sentKinds().includes('execute'), 'no execute request reached the wallet: ' + sentKinds())
  if (!expectApprovalSent) assert.equal(wallet.sends.length, 0, 'an approval above the reviewed amount is refused too')
  assert.equal(record.outcome, 'not_sent'); assert.match(record.lastError ?? '', /does not match|Nothing was sent/)
  assert.equal(record.executeHash, undefined)
})

// ---------- receipt success alone is not success ----------
for (const logs of ['none', 'unrelated']) await test(`a successful execute receipt WITHOUT the vault movement (${logs} logs) stays unknown, never success`, async () => {
  fresh(); chain.executeLogs = logs; const { record } = await run('deposit', '1')
  assert.equal(record.outcome, 'unknown'); assert.match(record.lastError, /expected vault movement was not found/); assert.ok(record.executeHash)
  assert.equal(J.openEarnRecordFor(OWNER)?.id, record.id, 'the wallet stays locked')
})

// ---------- lost hash, unresponsive RPC, approval then failing execute ----------
await test('SDK/wallet lose the execute hash after broadcast: unknown until exactly that execute is found on chain, then verified', async () => {
  fresh(); chain.autoMine = false; chain.allowance[allowanceKey(USDC, OWNER, ADAPTER)] = raw('5'); wallet.queue = ['lostAfterBroadcast']
  let { record } = await run('deposit', '1'); assert.equal(record.outcome, 'unknown'); assert.equal(record.executeHash, undefined)
  // Another transfer of the same amount from this wallet to the adapter, but for another vault: not adopted.
  const other = broadcast({ from: OWNER, to: ADAPTER, data: v.encodeFunctionData({ abi: EXEC, functionName: 'execute', args: [{ instructions: [{ target: VAULT_B, data: v.encodeFunctionData({ abi: INNER, functionName: 'deposit', args: [raw('1'), ADAPTER] }), value: 0n, tokenIn: USDC, amountToApprove: raw('1'), tokenOut: VAULT_B, minTokenOut: 1n }], tokens: [{ token: USDC, beneficiary: OWNER }, { token: VAULT_B, beneficiary: OWNER }], execId: 2n, deadline: 2n ** 40n, metadata: '0x' }, [{ permitType: 0, token: USDC, amount: raw('1'), permitCalldata: '0x' }], '0x'] }) })
  mine(other); record = await J.settleEarnRecord(record.id, publicClient); assert.equal(record.outcome, 'unknown', 'a different vault is not adopted')
  const lost = Object.keys(chain.txs).find(h => h !== other); mine(lost)
  record = await J.settleEarnRecord(record.id, publicClient); assert.equal(record.outcome, 'success'); assert.equal(record.executeHash, lost)
})
await test('the wallet broadcast the execute but the RPC stops answering: unknown WITH the hash, no second request; settles when the RPC answers again', async () => {
  fresh(); chain.allowance[allowanceKey(USDC, OWNER, ADAPTER)] = raw('5'); chain.receiptDown = true
  let { record, sdkError } = await run('deposit', '1')
  assert.ok(sdkError, 'the real SDK reports a failure'); assert.equal(record.outcome, 'unknown'); assert.ok(record.executeHash); assert.deepEqual(sentKinds(), ['execute'])
  await assert.rejects(run('deposit', '1'), /not confirmed yet/); assert.equal(wallet.sends.length, 1)
  chain.receiptDown = false; record = await J.settleEarnRecord(record.id, publicClient); assert.equal(record.outcome, 'success')
})
await test('a real approval is mined, then the execute REVERTS: reverted (approval kept as evidence), unlocked', async () => {
  fresh(); chain.executeOutcome = 'reverted'; const { record } = await run('deposit', '1')
  assert.deepEqual(sentKinds(), ['increaseAllowance', 'execute']); assert.equal(record.outcome, 'reverted'); assert.equal(record.requests[0].state, 'hash')
  assert.equal(chain.receipts[record.requests[0].hash].status, 'success'); assert.equal(J.openEarnRecordFor(OWNER), undefined)
})
await test('a real approval is mined, then the wallet REJECTS the execute: not sent, unlocked', async () => {
  fresh(); wallet.queue = ['ok', 'reject']; const { record } = await run('deposit', '1')
  assert.deepEqual(sentKinds(), ['increaseAllowance', 'execute']); assert.equal(record.outcome, 'not_sent'); assert.match(record.lastError, /rejected/)
})
await test('a real approval is mined, then the execute is broadcast but its hash is lost and it is not mined yet: unknown and locked; verified once mined', async () => {
  fresh(); chain.holdExecute = true; wallet.queue = ['ok', 'lostAfterBroadcast']
  let { record } = await run('deposit', '1')
  assert.deepEqual(sentKinds(), ['increaseAllowance', 'execute']); assert.equal(chain.receipts[record.requests[0].hash].status, 'success', 'the approval is mined')
  assert.equal(record.outcome, 'unknown'); assert.equal(record.executeHash, undefined); assert.equal(J.openEarnRecordFor(OWNER)?.id, record.id)
  await assert.rejects(run('deposit', '1'), /not confirmed yet/); assert.equal(wallet.sends.length, 2, 'no second deposit')
  const exec = Object.keys(chain.txs).find(h => chain.txs[h].to === lc(ADAPTER)); mine(exec)
  record = await J.settleEarnRecord(record.id, publicClient); assert.equal(record.outcome, 'success'); assert.equal(record.executeHash, exec)
})
await test('the approval itself reverts: the SDK never requests the execute; not sent, unlocked', async () => {
  fresh(); chain.approveOutcome = 'reverted'; const { record } = await run('deposit', '1')
  assert.deepEqual(sentKinds(), ['increaseAllowance']); assert.equal(record.outcome, 'not_sent')
})
await test('the journal cannot be written: the real SDK is never called and nothing reaches the wallet', async () => {
  fresh(); storageBroken = true; await assert.rejects(run('deposit', '1'), /could not be saved/); assert.equal(wallet.sends.length, 0); assert.equal(api.requests.length, 0)
})
if (failures.length) { console.log(`RESULT ${count} PASS, ${failures.length} FAIL`); process.exit(1) }
console.log(`RESULT ${count}/${count} real Earn Kit provider groups PASS; real EarnKit + viem adapter, controlled Arc chain and Circle API; no network.`)
