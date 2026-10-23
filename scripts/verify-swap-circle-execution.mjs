// Circle Swap Kit execution: decoder, wallet guard, step state machine, journal, recovery and chain verification.
// Controlled ports only (fake SDK, EIP-1193 wallet, RPC, clock, storage, lock): no network, no wallet, no signatures, no transactions.
// Section E runs the REAL @circle-fin/swap-kit 1.7.0 and ViemAdapter (installed in node_modules) against the guarded wallet, with a stubbed HTTP
// service and a fake JSON-RPC: nothing leaves the process.
// Real data: scripts/fixtures/swap/circle/arc-circle-swaps.json = 8 real Arc Mainnet Circle swaps (tx + receipt + block, read from the public RPC
// on 2026-10-22) and arc-adapter-earn-txs.json = 2 real adapter transactions that are not swaps.
import assert from 'node:assert/strict'
import { mock } from 'node:test'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
const require = createRequire(import.meta.url), ts = require('typescript')
require.extensions['.ts'] = (mod, file) => mod._compile(ts.transpileModule(readFileSync(file, 'utf8'), { fileName: file,
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText, file)
const root = fileURLToPath(new URL('..', import.meta.url))
const d = require(`${root}src/lib/swap/circleAdapterDecode.ts`), g = require(`${root}src/lib/swap/circleGuard.ts`), c = require(`${root}src/lib/swap/circleSwap.ts`)
const tk = require(`${root}src/lib/swap/tokens.ts`), ev = require(`${root}src/lib/swap/transactionEvidence.ts`), x = require(`${root}src/lib/uniswapArcExecution.ts`)
const { encodeFunctionData, encodeAbiParameters, parseAbiParameters, keccak256, formatTransaction, formatTransactionReceipt, parseUnits } = require('viem')
const swaps = JSON.parse(readFileSync(`${root}scripts/fixtures/swap/circle/arc-circle-swaps.json`, 'utf8'))
const earn = JSON.parse(readFileSync(`${root}scripts/fixtures/swap/circle/arc-adapter-earn-txs.json`, 'utf8'))
let count = 0, external = 0
globalThis.fetch = async () => { external++; throw Error('network_forbidden') }
async function test(name, fn) { await fn(); count++; console.log(`PASS ${name}`) }
// setImmediate, not setTimeout: the timer tests mock setTimeout.
const waitFor = async predicate => { for (let i = 0; i < 20000; i++) { if (predicate()) return; await new Promise(resolve => setImmediate(resolve)) } assert.fail('Expected asynchronous state') }
const owner = '0xafbB6Cc5C0a9C0eB1BfF8dB2eD807e83aAB8e321', other = '0x2222222222222222222222222222222222222222', ZERO = '0x' + '0'.repeat(40)
const T = symbol => tk.swapToken(symbol), ADAPTER = d.CIRCLE_ADAPTER
const gwei = n => BigInt(n) * 10n ** 9n

// --- builders ---------------------------------------------------------------------------------------------------------------
const NOW_MS = 1_800_000_000_000
const AMOUNTS = { USDC: '1', EURC: '1', cirBTC: '0.0001', WETH: '0.001' }
function serviceCall({ who = owner, tokenIn = 'EURC', tokenOut = 'USDC', amountIn, minOut, strategy = 'approve', deadline, fees, tweak }) {
  const inAddr = T(tokenIn).address, outAddr = T(tokenOut).address, feeList = fees ?? [amountIn / 5000n], feeTotal = feeList.reduce((a, b) => a + b, 0n)
  const instructions = [
    ...feeList.map(fee => ({ target: d.CIRCLE_FEE_TARGET, data: '0x7ebc46f0' + '00'.repeat(128), value: 0n, tokenIn: inAddr, amountToApprove: fee, tokenOut: ZERO, minTokenOut: 0n })),
    { target: d.CIRCLE_SWAP_EXECUTOR, data: '0x4666fc80', value: 0n, tokenIn: inAddr, amountToApprove: amountIn - feeTotal, tokenOut: outAddr, minTokenOut: minOut }]
  const permit = strategy === 'permit'
    ? { permitType: 1, permitCalldata: encodeAbiParameters(parseAbiParameters('uint256 value, uint256 deadline, uint8 v, bytes32 r, bytes32 s'), [amountIn, BigInt(deadline + 3000), 27, '0x' + '11'.repeat(32), '0x' + '22'.repeat(32)]) }
    : { permitType: 0, permitCalldata: '0x' }
  const call = { params: { instructions, tokens: [{ token: inAddr, beneficiary: who }, { token: outAddr, beneficiary: who }], execId: 123n, deadline: BigInt(deadline), metadata: '0x' },
    tokenInputs: [{ ...permit, token: inAddr, amount: amountIn }], signature: '0x' + 'ab'.repeat(65) }
  tweak?.(call)
  return encodeFunctionData({ abi: d.ADAPTER_ABI, functionName: 'execute', args: [call.params, call.tokenInputs, call.signature] })
}
const reencode = call => encodeFunctionData({ abi: d.ADAPTER_ABI, functionName: 'execute', args: [call.params ?? { instructions: call.instructions, tokens: call.tokens, execId: call.execId, deadline: call.deadline, metadata: call.metadata }, call.tokenInputs, call.signature] })
const intentOf = (over = {}) => ({ owner, adapter: ADAPTER, inputToken: T('EURC').address, outputToken: T('USDC').address, amountIn: 1_000_000n, minimumOut: 900_000n, strategy: 'approve', chainId: 5042, ...over })

// Real swap fixtures -> viem-typed chain objects and the intent that matches each transaction.
const realSwaps = Object.entries(swaps).map(([hash, v]) => {
  const tx = formatTransaction(v.tx), receipt = formatTransactionReceipt(v.receipt), call = d.decodeAdapterExecute(v.tx.input).call
  const swap = call.instructions.find(i => i.tokenOut !== ZERO), symbol = address => Object.keys(tk.SWAP_SYMBOLS.reduce((m, s) => ({ ...m, [s]: 1 }), {})).find(s => T(s).address.toLowerCase() === address.toLowerCase())
  return { hash, v, tx, receipt, call, swap, tokenIn: symbol(call.tokenInputs[0].token), tokenOut: symbol(swap.tokenOut), blockTime: parseInt(v.block.timestamp, 16),
    intent: { owner: tx.from, adapter: ADAPTER, inputToken: call.tokenInputs[0].token, outputToken: swap.tokenOut, amountIn: call.tokenInputs[0].amount, minimumOut: swap.minTokenOut,
      strategy: call.tokenInputs[0].permitType === 1 ? 'permit' : 'approve', chainId: 5042 } }
})
const chainTxOf = tx => ({ hash: tx.hash, from: tx.from, to: tx.to, chainId: tx.chainId, nonce: tx.nonce, type: tx.type, value: tx.value, gas: tx.gas, maxFeePerGas: tx.maxFeePerGas, maxPriorityFeePerGas: tx.maxPriorityFeePerGas, input: tx.input })
const chainReceiptOf = r => ({ transactionHash: r.transactionHash, from: r.from, to: r.to, status: r.status, blockNumber: r.blockNumber, blockHash: r.blockHash, transactionIndex: r.transactionIndex, gasUsed: r.gasUsed, effectiveGasPrice: r.effectiveGasPrice, logs: r.logs })

// =============================================================================================================================
// A. Adapter decoder and calldata policy, on real transactions
// =============================================================================================================================
await test('the pinned adapter ABI decodes every real transaction canonically: 8 swaps and 2 Earn operations', () => {
  assert.equal(d.ADAPTER_EXECUTE_SELECTOR, '0xaa3e079c'); assert.equal(d.CIRCLE_ADAPTER, '0x7FB8c7260b63934d8da38aF902f87ae6e284a845')
  assert.equal(realSwaps.length, 8)
  for (const { v } of realSwaps) { const r = d.decodeAdapterExecute(v.tx.input); assert.equal(r.ok, true); assert.equal(v.tx.to.toLowerCase(), ADAPTER.toLowerCase()) }
  for (const v of Object.values(earn)) assert.equal(d.decodeAdapterExecute(v.tx.input).ok, true)
  // The 8 real swaps cover every pair shape seen on chain: permit and pre-approved input, two or three instructions, multi-hop residual sweeps.
  assert.deepEqual(new Set(realSwaps.map(s => `${s.tokenIn}>${s.tokenOut}`)), new Set(['USDC>EURC', 'EURC>USDC', 'WETH>USDC', 'cirBTC>EURC', 'USDC>cirBTC', 'cirBTC>USDC', 'EURC>cirBTC']))
  assert.ok(realSwaps.some(s => s.call.instructions.length === 3) && realSwaps.some(s => s.call.tokens.length === 3))
})
await test('real swaps share one structure: a fee instruction, one swap instruction, approvals that add up to the input, sweeps to the wallet, a deadline about 600 s ahead', () => {
  for (const s of realSwaps) {
    const { call } = s
    assert.equal(call.tokenInputs.length, 1); assert.equal(call.signature.length, 132)
    const sum = call.instructions.reduce((a, i) => a + i.amountToApprove, 0n); assert.equal(sum, call.tokenInputs[0].amount)
    for (const i of call.instructions) { assert.equal(i.value, 0n); assert.ok(d.CIRCLE_INSTRUCTION_TARGETS.some(t => t.toLowerCase() === i.target.toLowerCase())) }
    assert.equal(call.instructions.filter(i => i.tokenOut !== ZERO).length, 1)
    for (const t of call.tokens) assert.equal(t.beneficiary.toLowerCase(), s.tx.from.toLowerCase())
    const ahead = Number(call.deadline) - s.blockTime; assert.ok(ahead > 300 && ahead < 700, `${ahead}`)
    assert.equal(s.receipt.status, 'success'); assert.equal(s.tx.type, 'eip1559'); assert.equal(s.tx.value, 0n)
  }
})
await test('the calldata policy accepts every real swap, before sending (wall clock) and when verifying (block time)', () => {
  for (const s of realSwaps) {
    const send = d.checkSwapCalldata(s.v.tx.input, s.intent, Number(s.call.deadline) - 590, 'send'), verify = d.checkSwapCalldata(s.v.tx.input, s.intent, s.blockTime, 'verify')
    assert.equal(send.ok, true, `${s.tokenIn}>${s.tokenOut} ${send.code}`); assert.equal(verify.ok, true, `${s.tokenIn}>${s.tokenOut} ${verify.code}`)
  }
})
await test('Earn operations (not swaps) are refused as swaps', () => {
  for (const [hash, v] of Object.entries(earn)) {
    const call = d.decodeAdapterExecute(v.tx.input).call
    const result = d.checkSwapCalldata(v.tx.input, { owner: v.tx.from, adapter: ADAPTER, inputToken: call.tokenInputs[0].token, outputToken: T('EURC').address, amountIn: call.tokenInputs[0].amount, minimumOut: 1n, strategy: 'permit', chainId: 5042 }, parseInt(v.block.timestamp, 16))
    assert.equal(result.ok, false, hash); assert.match(result.code, /target_not_allowed|swap_instruction|instruction_token_out|fee_instruction/)
  }
})
const base = () => { const s = realSwaps.find(r => r.tokenIn === 'EURC' && r.call.instructions.length === 2); return { s, nowSec: Number(s.call.deadline) - 590, call: structuredClone({ params: { instructions: s.call.instructions, tokens: s.call.tokens, execId: s.call.execId, deadline: s.call.deadline, metadata: s.call.metadata }, tokenInputs: s.call.tokenInputs, signature: s.call.signature }) } }
const bigintCopy = value => (typeof value === 'bigint' ? value : Array.isArray(value) ? value.map(bigintCopy) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, bigintCopy(v)])) : value)
const mutate = fn => { const { s, nowSec } = base(), call = bigintCopy({ params: { instructions: s.call.instructions, tokens: s.call.tokens, execId: s.call.execId, deadline: s.call.deadline, metadata: s.call.metadata }, tokenInputs: s.call.tokenInputs, signature: s.call.signature }); fn(call, s); return d.checkSwapCalldata(reencode(call), s.intent, nowSec, 'send') }
await test('calldata policy matrix: every deviation from the reviewed swap is refused with its own reason', () => {
  const cases = [
    ['input amount +1', call => { call.tokenInputs[0].amount += 1n }, 'input_amount'],
    ['other input token', call => { call.tokenInputs[0].token = T('USDC').address }, 'input_amount'],
    ['two token inputs', call => { call.tokenInputs.push(call.tokenInputs[0]) }, 'token_inputs'],
    ['permit while approve was reviewed', call => { call.tokenInputs[0].permitType = 1; call.tokenInputs[0].permitCalldata = '0x00' }, 'permit_type'],
    ['approvals above the input', call => { call.params.instructions[0].amountToApprove += 1n }, 'approval_sum'],
    ['instruction target not part of the route', call => { call.params.instructions[1].target = other }, 'target_not_allowed'],
    ['instruction with native value', call => { call.params.instructions[0].value = 1n }, 'instruction_value'],
    ['instruction approves another token', call => { call.params.instructions[0].tokenIn = T('USDC').address }, 'instruction_token_in'],
    ['fee instruction declares an output floor', call => { call.params.instructions[0].minTokenOut = 1n }, 'instruction_token_out'],
    ['swap produces another token', call => { call.params.instructions[1].tokenOut = T('cirBTC').address }, 'instruction_token_out'],
    ['swap run by the fee contract', call => { call.params.instructions[1].target = d.CIRCLE_FEE_TARGET }, 'instruction_token_out'],
    ['two swap instructions', call => { call.params.instructions.push({ ...call.params.instructions[1], amountToApprove: 0n }) }, 'swap_instruction'],
    ['swap instruction turned into a no-output instruction, executor still targeted', call => { call.params.instructions[1].tokenOut = ZERO; call.params.instructions[1].minTokenOut = 0n }, 'fee_instruction'],
    ['no swap instruction at all (every instruction has the fee shape)', call => { const fee = call.params.instructions[0]; call.params.instructions[1] = { ...fee, amountToApprove: call.params.instructions[1].amountToApprove } }, 'swap_instruction'],
    ['approvals below the input (unspent input would stay in the adapter)', call => { call.params.instructions[1].amountToApprove -= 1n }, 'approval_sum'],
    ['executor instruction with no output and arbitrary data', call => { const swap = call.params.instructions[1]; call.params.instructions[1] = { ...swap, tokenOut: ZERO, minTokenOut: 0n, data: '0xdeadbeef' + '11'.repeat(200) }; call.params.instructions.push({ ...swap, amountToApprove: 0n }) }, 'fee_instruction'],
    ['fee instruction with another selector', call => { call.params.instructions[0].data = '0xdeadbeef' + call.params.instructions[0].data.slice(10) }, 'fee_instruction'],
    ['fee instruction with a longer call', call => { call.params.instructions[0].data += '00'.repeat(32) }, 'fee_instruction'],
    ['swap instruction with another entry point', call => { call.params.instructions[1].data = '0xdeadbeef' + call.params.instructions[1].data.slice(10) }, 'swap_instruction'],
    ['fee instructions take a large share of the input', (call, s) => { const take = s.intent.amountIn / 4n; call.params.instructions[0].amountToApprove += take; call.params.instructions[1].amountToApprove -= take }, 'fee_share'],
    ['input token not swept back to the wallet', (call, s) => { call.params.tokens = call.params.tokens.filter(entry => entry.token.toLowerCase() === s.intent.outputToken.toLowerCase()) }, 'beneficiary'],
    ['output floor below the reviewed minimum', (call, s) => { call.params.instructions[1].minTokenOut = s.intent.minimumOut - 1n }, 'min_output'],
    ['zero output floor', call => { call.params.instructions[1].minTokenOut = 0n }, 'min_output'],
    ['output swept to a third party', call => { call.params.tokens[1].beneficiary = other }, 'beneficiary'],
    ['input residue swept to a third party', call => { call.params.tokens[0].beneficiary = other }, 'beneficiary'],
    ['output token not swept at all', (call, s) => { call.params.tokens = [call.params.tokens[0]]; call.params.tokens[0].token = s.intent.inputToken }, 'beneficiary'],
    ['residual token outside the swap tokens', call => { call.params.tokens.push({ token: other, beneficiary: call.params.tokens[0].beneficiary }) }, 'token_not_allowed'],
    ['deadline already passed', (call, s) => { call.params.deadline = BigInt(base().nowSec + 5) }, 'deadline_passed'],
    ['deadline too far', call => { call.params.deadline += 10_000n }, 'deadline_far'],
    ['signature of the wrong size', call => { call.signature = '0x' + 'ab'.repeat(64) }, 'shape'],
  ]
  for (const [name, fn, code] of cases) { const r = mutate(fn); assert.equal(r.ok, false, name); assert.equal(r.code, code, `${name}: got ${r.code}`) }
  assert.equal(mutate(() => {}).ok, true)
})
await test('non-canonical, truncated or other-selector calldata is refused', () => {
  const { s, nowSec } = base(), input = s.v.tx.input
  for (const [data, code] of [[input + '00', 'noncanonical_calldata'], [input.slice(0, input.length - 8), /noncanonical_calldata|undecodable_execute/], ['0xa9059cbb' + input.slice(10), 'not_adapter_execute'], ['0x', 'invalid_calldata'], [undefined, 'invalid_calldata'], ['0xzz', 'invalid_calldata'], ['0x' + 'aa'.repeat(40000), 'invalid_calldata']]) {
    const r = d.checkSwapCalldata(data, s.intent, nowSec); assert.equal(r.ok, false); if (code instanceof RegExp) assert.match(r.code, code); else assert.equal(r.code, code)
  }
})
await test('the permit strategy requires an exact-amount EIP-2612 permit with a deadline of at most an hour', () => {
  const deadline = Math.floor(NOW_MS / 1000) + 600, common = { tokenIn: 'USDC', tokenOut: 'EURC', amountIn: 1_000_000n, minOut: 900_000n, strategy: 'permit', deadline }
  const intent = intentOf({ inputToken: T('USDC').address, outputToken: T('EURC').address, strategy: 'permit' })
  assert.equal(d.checkSwapCalldata(serviceCall(common), intent, deadline - 590).ok, true)
  assert.equal(d.checkSwapCalldata(serviceCall(common), intentOf({ ...intent, strategy: 'approve' }), deadline - 590).code, 'permit_type')
  const bad = (value, dl) => serviceCall({ ...common, tweak: call => { call.tokenInputs[0].permitCalldata = encodeAbiParameters(parseAbiParameters('uint256 value, uint256 deadline, uint8 v, bytes32 r, bytes32 s'), [value, dl, 27, '0x' + '11'.repeat(32), '0x' + '22'.repeat(32)]) } })
  assert.equal(d.checkSwapCalldata(bad(1_000_001n, BigInt(deadline + 3000)), intent, deadline - 590).code, 'permit_value')
  assert.equal(d.checkSwapCalldata(bad(1_000_000n, BigInt(deadline - 600)), intent, deadline - 590).code, 'permit_value')
  assert.equal(d.checkSwapCalldata(bad(1_000_000n, BigInt(deadline + 90_000)), intent, deadline - 590).code, 'permit_value')
  assert.equal(d.checkSwapCalldata(serviceCall({ ...common, tweak: call => { call.tokenInputs[0].permitCalldata = '0x1234' } }), intent, deadline - 590).code, 'permit_value')
})
await test('approve calldata: only a canonical approve decodes; spender and amount are returned exactly', () => {
  const data = d.encodeApprove(ADAPTER, 1_000_000n), decoded = d.decodeApprove(data)
  assert.equal(decoded.spender.toLowerCase(), ADAPTER.toLowerCase()); assert.equal(decoded.amount, 1_000_000n)
  assert.equal(d.decodeApprove(data + '00'), null); assert.equal(d.decodeApprove('0xa9059cbb' + data.slice(10)), null); assert.equal(d.decodeApprove('0x'), null); assert.equal(d.decodeApprove(undefined), null)
  assert.equal(d.decodeApprove(d.encodeApprove(ADAPTER, 2n ** 256n - 1n)).amount, 2n ** 256n - 1n)
})

// =============================================================================================================================
// B. Wallet guard
// =============================================================================================================================
function guardFixture(over = {}) {
  const clock = { ms: NOW_MS }, w = { chainId: 5042, accounts: [owner], calls: [], send: undefined, sign: undefined }
  const inner = {
    getChainId: async () => w.chainId, getAddresses: async () => w.accounts,
    sendTransaction: async params => { w.calls.push(['send', params]); if (w.send) return w.send(params); return '0x' + (w.calls.length).toString(16).padStart(64, '0') },
    signTypedData: async params => { w.calls.push(['sign', params]); if (w.sign) return w.sign(params); return '0x' + 'cd'.repeat(65) },
  }
  const log = [], overrides = over.hooks ?? {}
  const hooks = {
    gate: async step => { log.push(['gate', step.kind]); await overrides.gate?.(step) },
    before: async (step, est) => { log.push(['before', step.kind, est.gas]); if (overrides.before) return overrides.before(step, est); return { nonce: 7 + step.index, gas: est.gas ?? 100_000n, maxFeePerGas: gwei(30), maxPriorityFeePerGas: gwei(1) } },
    sent: (step, hash) => log.push(['sent', step.kind, hash]), failed: (step, outcome, error) => log.push(['failed', step.kind, outcome, error?.code ?? error?.message]), signed: step => log.push(['signed', step.kind]),
  }
  const policy = { owner, adapter: ADAPTER, inputToken: T('EURC').address, outputToken: T('USDC').address, amountIn: 1_000_000n, minimumOut: 900_000n, strategy: 'approve', chainId: 5042,
    now: () => clock.ms, maxFeePerGas: gwei(30), maxPriorityFeePerGas: gwei(1), feeBudget: () => 10n ** 17n, ...over.policy }
  const wallet = g.createGuardedWalletClient(inner, policy, hooks)
  const deadline = Math.floor(clock.ms / 1000) + 600
  const params = (to, data, extra = {}) => ({ account: wallet.account, chain: { id: 5042 }, to, data, kzg: undefined, ...extra })
  const approve = (amount = 1_000_000n, spender = ADAPTER, extra = {}) => params(policy.inputToken, d.encodeApprove(spender, amount), extra)
  const swap = (tweak, extra = {}) => params(ADAPTER, serviceCall({ tokenIn: 'EURC', tokenOut: 'USDC', amountIn: 1_000_000n, minOut: 900_000n, deadline, tweak }), { gas: 1_050_000n, ...extra })
  return { wallet, w, log, policy, clock, approve, swap, params, deadline, inner }
}
const refused = async (promise, code) => { try { await promise } catch (error) { assert.equal(error?.code, code, `expected ${code}, got ${error?.code ?? error?.message}`); return } assert.fail(`expected ${code}`) }
await test('guard: the exact approval and the swap reach the wallet in order, each after the user gate and the journal hook, with the fee caps and nonce the controller chose', async () => {
  const f = guardFixture()
  const first = await f.wallet.sendTransaction(f.approve())
  assert.match(first, /^0x[0-9a-f]{64}$/); assert.deepEqual(f.log.slice(0, 3).map(e => e[0]), ['gate', 'before', 'sent'])
  const [, sent] = f.w.calls[0]
  assert.equal(sent.to, f.policy.inputToken); assert.equal(sent.value, 0n); assert.equal(sent.type, 'eip1559'); assert.equal(sent.nonce, 7); assert.equal(sent.maxFeePerGas, gwei(30)); assert.equal(sent.maxPriorityFeePerGas, gwei(1)); assert.ok(sent.gas > 0n)
  await f.wallet.sendTransaction(f.swap())
  assert.equal(f.w.calls.length, 2); assert.equal(f.w.calls[1][1].to, ADAPTER); assert.equal(f.w.calls[1][1].gas, 1_050_000n); assert.equal(f.w.calls[1][1].nonce, 8)
  assert.deepEqual(f.wallet.sent, { approve: 1, swap: 1, permit: 0 })
})
await test('guard: approvals other than exactly the reviewed amount to the adapter on the reviewed token are refused before the wallet', async () => {
  for (const [name, params, code] of [
    ['unlimited', f => f.approve(2n ** 256n - 1n), 'approve_amount'], ['amount + 1', f => f.approve(1_000_001n), 'approve_amount'], ['amount - 1', f => f.approve(999_999n), 'approve_amount'], ['zero', f => f.approve(0n), 'approve_amount'],
    ['other spender', f => f.approve(1_000_000n, other), 'approve_spender'],
    ['not an approve', f => f.params(f.policy.inputToken, '0xa9059cbb' + '00'.repeat(64)), 'approve_data'],
    ['other token', f => f.params(T('WETH').address, d.encodeApprove(ADAPTER, 1_000_000n)), 'wrong_target'],
    ['other target', f => f.params(other, d.encodeApprove(ADAPTER, 1_000_000n)), 'wrong_target'],
    ['native value', f => f.approve(1_000_000n, ADAPTER, { value: 1n }), 'value'],
    ['legacy gas price', f => f.approve(1_000_000n, ADAPTER, { gasPrice: 1n }), 'extra_field'], ['authorization list', f => f.approve(1_000_000n, ADAPTER, { authorizationList: [] }), 'extra_field'],
    ['blobs', f => f.approve(1_000_000n, ADAPTER, { blobs: ['0x'] }), 'extra_field'], ['legacy type', f => f.approve(1_000_000n, ADAPTER, { type: 'legacy' }), 'extra_field'],
    ['other account', f => ({ ...f.approve(), account: { address: other, type: 'json-rpc' } }), 'account'],
    ['other chain', f => ({ ...f.approve(), chain: { id: 1 } }), 'network'],
    ['huge gas', f => f.approve(1_000_000n, ADAPTER, { gas: 5_000_000n }), 'gas_limit'],
    ['fee cap above the reviewed cap', f => f.approve(1_000_000n, ADAPTER, { maxFeePerGas: gwei(31) }), 'fee_ceiling'],
  ]) {
    const f = guardFixture(); await refused(f.wallet.sendTransaction(params(f)), code); assert.equal(f.w.calls.length, 0, name); assert.ok(f.log.length > 0, 'no hook call for: ' + name)
    assert.deepEqual(f.log.map(e => e[0]), ['failed']); assert.equal(f.log[0][2], 'refused'); assert.equal(f.log[0][3], code); assert.deepEqual(f.wallet.sent, { approve: 0, swap: 0, permit: 0 })
  }
})
await test('guard: swap calldata that differs from the review never reaches the wallet; the swap also needs the approval first', async () => {
  const f = guardFixture()
  await refused(f.wallet.sendTransaction(f.swap()), 'step_order'); assert.equal(f.w.calls.length, 0)
  await f.wallet.sendTransaction(f.approve()); f.w.calls.length = 0
  for (const [name, tweak, ] of [['lower minimum', call => { call.params.instructions[1].minTokenOut = 899_999n }], ['third-party sweep', call => { call.params.tokens[1].beneficiary = other }], ['more input', call => { call.tokenInputs[0].amount = 1_000_001n }],
    ['other route target', call => { call.params.instructions[1].target = other }], ['stale deadline', call => { call.params.deadline = BigInt(f.deadline - 590) }]]) {
    await refused(f.wallet.sendTransaction(f.swap(tweak)), 'swap_calldata'); assert.equal(f.w.calls.length, 0, name)
  }
  await refused(f.wallet.sendTransaction(f.swap(undefined, { value: 1n })), 'value'); await refused(f.wallet.sendTransaction(f.swap(undefined, { account: { address: other } })), 'account')
  assert.equal(f.w.calls.length, 0); await f.wallet.sendTransaction(f.swap()); assert.equal(f.w.calls.length, 1)
})
await test('guard: one approval and one swap per session; a repeat or concurrent request is refused', async () => {
  const f = guardFixture(); await f.wallet.sendTransaction(f.approve())
  await refused(f.wallet.sendTransaction(f.approve()), 'duplicate_send'); await f.wallet.sendTransaction(f.swap()); await refused(f.wallet.sendTransaction(f.swap()), 'duplicate_send'); assert.equal(f.w.calls.length, 2)
  const slow = guardFixture({ hooks: { gate: () => new Promise(() => {}) } }); const first = slow.wallet.sendTransaction(slow.approve()); first.catch(() => {})
  await refused(slow.wallet.sendTransaction(slow.approve()), 'duplicate_send'); assert.equal(slow.w.calls.length, 0)
})
await test('guard: the fee ceiling is enforced before the wallet, with the budget evaluated at call time', async () => {
  let budget = 10n ** 17n
  const f = guardFixture({ policy: { feeBudget: () => budget } }); await f.wallet.sendTransaction(f.approve())
  budget = 3n * 10n ** 16n // 1,050,000 gas x 30 gwei = 0.0315 USDC > 0.03 left
  await refused(f.wallet.sendTransaction(f.swap()), 'fee_ceiling'); assert.equal(f.w.calls.length, 1)
  const g2 = guardFixture({ hooks: { before: async () => ({ nonce: 1, gas: 3_900_000n, maxFeePerGas: gwei(30), maxPriorityFeePerGas: gwei(1) }) } })
  await refused(g2.wallet.sendTransaction(g2.approve()), 'fee_ceiling'); assert.equal(g2.w.calls.length, 0)
  // the plan was already journaled by `before`, so this refusal is reported as `blocked` (record exists, wallet never contacted)
  assert.deepEqual(g2.log.map(e => e[0]), ['gate', 'before', 'failed']); assert.equal(g2.log[2][2], 'blocked')
  const g3 = guardFixture({ hooks: { before: async () => ({ nonce: 1, gas: 100_000n, maxFeePerGas: gwei(40), maxPriorityFeePerGas: gwei(1) }) } })
  await refused(g3.wallet.sendTransaction(g3.approve()), 'fee_ceiling')
  const g4 = guardFixture({ hooks: { before: async () => ({ nonce: -1, gas: 100_000n, maxFeePerGas: gwei(30), maxPriorityFeePerGas: gwei(1) }) } })
  await refused(g4.wallet.sendTransaction(g4.approve()), 'fee_ceiling'); assert.equal(g4.w.calls.length, 0)
})
await test('guard: wallet network or account changes are caught before the request and again after the confirmation, never mid-flow switched', async () => {
  const f = guardFixture(); f.w.chainId = 1; await refused(f.wallet.sendTransaction(f.approve()), 'network'); assert.equal(f.w.calls.length, 0)
  const g2 = guardFixture(); g2.w.accounts = [other, owner]; await refused(g2.wallet.sendTransaction(g2.approve()), 'account')
  const g3 = guardFixture({ hooks: { gate: async () => { g3.w.chainId = 137 } } }); await refused(g3.wallet.sendTransaction(g3.approve()), 'network'); assert.equal(g3.w.calls.length, 0)
  const g4 = guardFixture({ hooks: { gate: async () => { g4.w.accounts = [other] } } }); await refused(g4.wallet.sendTransaction(g4.approve()), 'account'); assert.equal(g4.w.calls.length, 0)
  const g5 = guardFixture(); await g5.wallet.switchChain({ id: 5042 }); assert.equal(g5.w.calls.length, 0)
  await refused(g5.wallet.switchChain({ id: 1 }), 'network'); g5.w.chainId = 1; await refused(g5.wallet.switchChain({ id: 5042 }), 'network')
})
await test('guard: a declined or timed-out confirmation, or a journal that cannot record, stops before the wallet', async () => {
  const declined = guardFixture({ hooks: { gate: async () => { throw new g.CircleGuardError('step_declined') } } }); await refused(declined.wallet.sendTransaction(declined.approve()), 'step_declined')
  assert.equal(declined.w.calls.length, 0); assert.deepEqual(declined.log.map(e => e[0]), ['gate', 'failed']); assert.equal(declined.log[1][2], 'refused')
  const storage = guardFixture({ hooks: { before: async () => { throw new Error('storage') } } }); await assert.rejects(storage.wallet.sendTransaction(storage.approve()), /storage/)
  assert.equal(storage.w.calls.length, 0); assert.deepEqual(storage.wallet.sent, { approve: 0, swap: 0, permit: 0 })
})
await test('guard: a rejection or an ambiguous wallet error is reported with its outcome, a second request is blocked, and a bad hash is never passed on', async () => {
  const rejected = guardFixture(); rejected.w.send = () => { throw Object.assign(new Error('User rejected'), { code: 4001 }) }
  await assert.rejects(rejected.wallet.sendTransaction(rejected.approve())); assert.deepEqual(rejected.log.at(-1).slice(0, 3), ['failed', 'approve', 'rejected'])
  await refused(rejected.wallet.sendTransaction(rejected.approve()), 'duplicate_send')
  const wrapped = guardFixture(); wrapped.w.send = () => { throw Object.assign(new Error('wrapped'), { cause: { name: 'UserRejectedRequestError' } }) }
  await assert.rejects(wrapped.wallet.sendTransaction(wrapped.approve())); assert.equal(wrapped.log.at(-1)[2], 'rejected')
  const ambiguous = guardFixture(); ambiguous.w.send = () => { throw Object.assign(new Error('internal'), { code: -32603 }) }
  await assert.rejects(ambiguous.wallet.sendTransaction(ambiguous.approve())); assert.equal(ambiguous.log.at(-1)[2], 'unknown')
  const bad = guardFixture(); bad.w.send = () => 'not-a-hash'; await refused(bad.wallet.sendTransaction(bad.approve()), 'hash'); assert.equal(bad.log.at(-1)[2], 'unknown'); assert.equal(bad.log.filter(e => e[0] === 'sent').length, 0)
})
await test('guard: no other wallet capability exists: raw, batch, contract-write, message and request methods are blocked or absent, and the object cannot be altered', async () => {
  const f = guardFixture()
  for (const name of ['sendRawTransaction', 'writeContract', 'signMessage', 'signTransaction', 'request', 'prepareTransactionRequest', 'deployContract', 'addChain', 'watchAsset', 'requestPermissions', 'signAuthorization', 'extend']) {
    assert.throws(() => f.wallet[name](), error => error.code === 'method_blocked', name)
  }
  for (const name of ['getCapabilities', 'sendCalls', 'getCallsStatus', 'waitForCallsStatus', 'then', 'toJSON']) assert.equal(f.wallet[name], undefined, name)
  assert.equal(f.wallet.account.address, owner); assert.equal(f.wallet.account.type, 'json-rpc'); assert.throws(() => { 'use strict'; f.wallet.account.address = other })
  assert.equal(Reflect.set(f.wallet, 'sendTransaction', () => {}), false); assert.equal(Reflect.deleteProperty(f.wallet, 'sendTransaction'), false); assert.equal(Reflect.defineProperty(f.wallet, 'x', { value: 1 }), false)
  assert.deepEqual(await f.wallet.getAddresses(), [owner]); assert.equal(await f.wallet.getChainId(), 5042)
  await refused(f.wallet.signTypedData({ account: f.wallet.account, domain: {}, types: {}, primaryType: 'Permit', message: {} }), 'method_blocked')
  f.wallet.seal(); await refused(f.wallet.sendTransaction(f.approve()), 'sealed'); await refused(f.wallet.switchChain({ id: 5042 }), 'sealed'); assert.equal(f.w.calls.length, 0)
})
await test('guard: the permit strategy signs only the exact EIP-2612 Permit for the reviewed amount to the adapter, once, and forbids an on-chain approval', async () => {
  const policy = { strategy: 'permit', inputToken: T('USDC').address, outputToken: T('EURC').address }
  const f = guardFixture({ policy }), nowSec = Math.floor(NOW_MS / 1000)
  const typed = (over = {}) => ({ account: f.wallet.account, domain: { name: 'USDC', version: '2', chainId: 5042, verifyingContract: T('USDC').address, ...over.domain }, types: over.types ?? { Permit: d.PERMIT_TYPES },
    primaryType: over.primaryType ?? 'Permit', message: { owner, spender: ADAPTER, value: 1_000_000n, nonce: 0n, deadline: BigInt(nowSec + 3600), ...over.message }, ...over.extra })
  await refused(f.wallet.sendTransaction(f.params(T('USDC').address, d.encodeApprove(ADAPTER, 1_000_000n))), 'step_order')
  for (const [name, over] of [['other value', { message: { value: 1_000_001n } }], ['other spender', { message: { spender: other } }], ['other owner', { message: { owner: other } }], ['other token', { domain: { verifyingContract: T('EURC').address } }],
    ['other chain', { domain: { chainId: 1 } }], ['other name', { domain: { name: 'Evil' } }], ['other version', { domain: { version: '1' } }], ['other primary type', { primaryType: 'Order' }],
    ['past deadline', { message: { deadline: BigInt(nowSec - 1) } }], ['far deadline', { message: { deadline: BigInt(nowSec + 10 * 3600) } }], ['extra type', { types: { Permit: d.PERMIT_TYPES, Mail: [] } }],
    ['altered fields', { types: { Permit: d.PERMIT_TYPES.slice(0, 4) } }], ['extra parameter', { extra: { verifier: other } }]]) {
    await refused(f.wallet.signTypedData(typed(over)), 'typed_data'); assert.equal(f.w.calls.length, 0, name)
  }
  assert.match(await f.wallet.signTypedData(typed()), /^0x[0-9a-f]{130}$/); assert.equal(f.w.calls.length, 1); await refused(f.wallet.signTypedData(typed()), 'duplicate_send')
  assert.deepEqual(f.log.filter(e => e[0] === 'signed' || e[0] === 'gate').map(e => e.join(':')), ['gate:permit', 'signed:permit'])
  const permitCall = serviceCall({ tokenIn: 'USDC', tokenOut: 'EURC', amountIn: 1_000_000n, minOut: 900_000n, strategy: 'permit', deadline: f.deadline })
  await f.wallet.sendTransaction(f.params(ADAPTER, permitCall, { gas: 1_050_000n })); assert.equal(f.w.calls.length, 2)
})

// =============================================================================================================================
// C. Controller: fake SDK, wallet, chain, storage, lock
// =============================================================================================================================
function setup(options = {}) {
  const symbolIn = options.tokenIn ?? 'EURC', symbolOut = options.tokenOut ?? 'USDC', strategy = options.strategy ?? (symbolIn === 'USDC' ? 'permit' : 'approve')
  const data = options.data ?? new Map(), locks = options.locks ?? new Set(), seen = [], settled = []
  const clock = { now: options.now ?? NOW_MS }, context = { owner, connected: true, chainId: 5042, connectorId: 'existing-wagmi-connector' }
  let input = { chainId: 5042, tokenIn: symbolIn, tokenOut: symbolOut, owner, amount: options.amount ?? AMOUNTS[symbolIn], slippageBps: 50, allowanceStrategy: strategy }
  const world = { chainId: 5042, accounts: [owner], latest: 7, pending: 7, estimateSwap: 600_000n, estimateApprove: 50_000n, estimateFails: false, approvals: new Map(), results: new Map(), sends: [], signs: [], sdkCalls: [], quotes: 0, preflights: 0,
    approvalOutcome: 'confirmed', journalCheck: [], issued: new Set(), wallet: undefined, serviceTweak: undefined, kit: undefined, resultCalls: 0, autoSettle: options.autoSettle ?? false, writes: 0, storageFail: undefined }
  const storageKey = `machina.circle.swap.execution.v1:${owner.toLowerCase()}`
  const records = () => JSON.parse(data.get(storageKey) ?? '[]')
  const provider = { request: async args => {
    if (args.method === 'eth_chainId') return '0x' + world.chainId.toString(16)
    if (args.method === 'eth_accounts') return world.accounts
    if (args.method === 'eth_getTransactionCount') return '0x' + (args.params[1] === 'pending' ? world.pending : world.latest).toString(16)
    throw Error(`unexpected_wallet_method_${args.method}`)
  } }
  const inner = {
    getChainId: async () => world.chainId, getAddresses: async () => world.accounts,
    sendTransaction: async params => {
      // Journal-before-wallet: the step this very request belongs to must already be durable as awaiting_wallet.
      const dataHash = keccak256(params.data), attempt = records().at(-1), step = attempt?.steps.find(s => s.dataHash === dataHash)
      world.journalCheck.push(Boolean(step && step.status === 'awaiting_wallet' && step.nonce === params.nonce && attempt.status === 'awaiting_wallet'))
      world.sends.push(params)
      if (world.wallet) return world.wallet(params, world.sends.length)
      const hash = '0x' + (0xa000 + world.sends.length).toString(16).padStart(64, '0'); world.issued.add(hash)
      world.latest++; world.pending++
      if (params.to.toLowerCase() === ADAPTER.toLowerCase()) { if (world.autoSettle) world.results.set(hash, 'settle') } else world.approvals.set(hash, { status: world.approvalOutcome, fee: '1000000000000000' })
      return hash
    },
    signTypedData: async params => { world.signs.push(params); if (world.signError) throw world.signError; return '0x' + '11'.repeat(32) + '22'.repeat(32) + '1b' }, // r, s, v = 27: the real SDK validates the shape
  }
  const reviewFor = (request, now) => {
    const inT = T(request.tokenIn), outT = T(request.tokenOut), amountIn = c.parseCircleAmount(request.amount, inT.decimals)
    const estimated = amountIn * 10n ** BigInt(outT.decimals) / 10n ** BigInt(inT.decimals) * 90n / 100n, minimum = estimated * BigInt(10_000 - request.slippageBps) / 10_000n
    return { request: structuredClone(request), amountIn: amountIn.toString(), estimatedOutput: estimated.toString(), requiredMinimum: minimum.toString(), networkFee: (5n * 10n ** 16n).toString(),
      maxFeePerGas: gwei(30).toString(), maxPriorityFeePerGas: gwei(1).toString(), nativeBalance: (5n * 10n ** 18n).toString(), tokenBalance: (amountIn * 10n).toString(), allowance: '0',
      fees: [{ type: 'provider', token: request.tokenIn, amount: '0.0002' }], requestStartedAt: now, expiresAt: now + 30_000, route: 'Circle Swap Kit',
      reference: { source: 'uniswap', estimatedOutput: estimated.toString() } }
  }
  const settleResult = attempt => ({ status: 'settled', output: attempt.review.requiredMinimum, fee: '12000000000000000', approvals: attempt.steps.filter(s => s.kind === 'approve' && s.hash).map(s => ({ index: s.index, status: 'confirmed', fee: '1000000000000000' })),
    chain: { state: 'success', blockNumber: '100', blockHash: '0x' + '11'.repeat(32), gasUsed: '500000', effectiveGasPrice: '21000000000', fee: '11000000000000000', received: attempt.review.requiredMinimum, sent: attempt.review.amountIn, checkedAt: Date.now() },
    intent: { verdict: 'verified_with_notes', checks: [], differences: [], checkedAt: Date.now() } })
  const real = options.real ? realSdk(world, clock) : null
  const ports = {
    context: () => context, input: () => input, now: () => clock.now,
    fresh: async request => { world.quotes++; return options.fresh ? options.fresh(request, clock.now) : reviewFor(request, clock.now) },
    preflight: async review => { world.preflights++; return options.preflight ? options.preflight(review) : { chainId: 5042, blockNumber: 100n, blockTimestamp: BigInt(Math.floor(clock.now / 1000)), walletCode: '0x', adapterCodeHash: d.CIRCLE_ADAPTER_CODEHASH, adapterImplementation: d.CIRCLE_ADAPTER_IMPLEMENTATION, implementationCodeHash: d.CIRCLE_ADAPTER_IMPLEMENTATION_CODEHASH,
      tokenCodesPresent: true, tokenInDecimals: T(review.request.tokenIn).decimals, tokenOutDecimals: T(review.request.tokenOut).decimals, tokenBalance: BigInt(review.tokenBalance), nativeBalance: BigInt(review.nativeBalance),
      allowance: 0n, gasPrice: gwei(21), baseFee: gwei(20) } },
    publicNonce: async () => ({ nonce: world.pending, latestNonce: world.latest }),
    provider: async () => provider, wallet: () => inner,
    sdk: wallet => { if (real) return real(wallet); const adapter = { wallet }; return { kit: world.kit ?? fakeKit(world, clock), adapter } },
    estimateGas: async tx => { if (world.estimateFails) throw Error('execution reverted'); return tx.to.toLowerCase() === ADAPTER.toLowerCase() ? world.estimateSwap : world.estimateApprove },
    approval: async (attempt, step) => world.approvals.get(step.hash) ?? { status: 'pending' },
    result: async attempt => { world.resultCalls++; if (options.result) return options.result(attempt, world); const r = world.results.get(attempt.hash); if (r === 'settle') return settleResult(attempt); if (r instanceof Error) throw r; return r ?? { status: 'pending' } },
    storage: { getItem: key => data.get(key) ?? null, setItem: (key, value) => { world.writes++; world.storageFail?.(world.writes, key, value); data.set(key, value) } },
    lock: async (account, run) => { const key = account.toLowerCase(); if (locks.has(key)) throw Error('lock'); locks.add(key); try { return await run() } finally { locks.delete(key) } },
    authorize: () => true, enabled: options.enabled ?? (() => true), changed: view => seen.push(view), settled: attempt => settled.push(attempt), pause: async () => {},
    ...options.ports,
  }
  const controller = c.createCircleSwapExecution(ports)
  return { controller, world, clock, context, data, seen, settled, ports, provider, records, setInput: next => { input = next }, input: () => input, storageKey,
    async review() { await controller.prepare(); assert.equal(controller.current().phase, 'review', controller.current().error); return controller.current().approvalId },
    // Runs a whole attempt: confirm, then the user continues each step as it appears (a step is identified by its kind and index).
    async run(id) {
      const done = controller.confirm(id); let finished = false; done.then(() => { finished = true }, () => { finished = true })
      const seenSteps = new Set(), key = step => `${step.kind}:${step.index}`
      while (!finished) {
        await waitFor(() => finished || (controller.current().phase === 'awaiting_step' && !seenSteps.has(key(controller.current().step))))
        if (finished) break
        seenSteps.add(key(controller.current().step)); controller.continueStep()
      }
      await done
    },
  }
}
// The SDK as it behaves in the real Swap Kit 1.7.0: approve (exact amount), wait, ask the service, swap. Nothing here is trusted by the application.
function fakeKit(world, clock) {
  return { async swap(params) {
    world.sdkCalls.push({ tokenIn: params.tokenIn, tokenOut: params.tokenOut, amountIn: params.amountIn, config: structuredClone(params.config), from: { chain: params.from.chain } })
    const wallet = params.from.adapter.wallet, who = wallet.account.address, nowSec = Math.floor(clock.now / 1000)
    const symbolOf = address => tk.SWAP_SYMBOLS.find(s => T(s).address.toLowerCase() === address.toLowerCase())
    const tokenIn = symbolOf(params.tokenIn), tokenOut = symbolOf(params.tokenOut), amountIn = parseUnits(params.amountIn, T(tokenIn).decimals), minOut = parseUnits(params.config.stopLimit, T(tokenOut).decimals)
    const strategy = params.config.allowanceStrategy
    if (strategy === 'approve') {
      await wallet.switchChain({ id: 5042 })
      await wallet.sendTransaction({ account: wallet.account, chain: { id: 5042 }, kzg: undefined, to: T(tokenIn).address, data: d.encodeApprove(ADAPTER, amountIn) })
    } else {
      await wallet.signTypedData({ account: wallet.account, domain: { name: 'USDC', version: '2', chainId: 5042, verifyingContract: T(tokenIn).address }, types: { Permit: d.PERMIT_TYPES }, primaryType: 'Permit',
        message: { owner: who, spender: ADAPTER, value: amountIn, nonce: 0n, deadline: BigInt(nowSec + 3600) } })
    }
    await wallet.switchChain({ id: 5042 })
    const calldata = serviceCall({ who, tokenIn, tokenOut, amountIn, minOut, strategy, deadline: nowSec + 600, tweak: world.serviceTweak })
    const txHash = await wallet.sendTransaction({ account: wallet.account, chain: { id: 5042 }, kzg: undefined, to: ADAPTER, data: calldata, gas: 1_050_000n })
    return { txHash }
  } }
}

await test('source gate: Circle execution is open in the source but still needs the build switch and the mode authorisation; without them nothing is quoted or recorded', async () => {
  assert.equal(c.CIRCLE_SWAP_WRITES_ENABLED, true)
  const f = setup({ ports: { enabled: () => false } }); await f.controller.prepare()
  assert.equal(f.world.quotes, 0); assert.match(f.controller.current().error, /switched off/)
  const g2 = setup({ ports: { authorize: undefined } }); await g2.controller.prepare(); assert.equal(g2.world.quotes, 0); assert.match(g2.controller.current().error, /pilot/)
  await g2.controller.confirm('forged'); assert.equal(g2.world.sends.length, 0); assert.equal(g2.data.size, 0)
  const g3 = setup({ ports: { authorize: () => false } }); await g3.controller.prepare(); assert.match(g3.controller.current().error, /pilot/)
})
await test('review: a quote that breaks the rules (slippage, expiry, balances, fee ceiling, wallet) is never presented as executable', async () => {
  const reference = setup() // a well-formed Review for the same request, then broken one rule at a time
  const mutateReview = fn => async (request, now) => { const review = await reference.ports.fresh(request); review.requestStartedAt = now; review.expiresAt = now + 30_000; fn(review); return review }
  for (const [name, fn] of [
    ['minimum below slippage floor', r => { r.requiredMinimum = (BigInt(r.requiredMinimum) - 1n).toString() }], ['minimum above estimate', r => { r.requiredMinimum = (BigInt(r.estimatedOutput) + 1n).toString() }], ['zero minimum', r => { r.requiredMinimum = '0' }],
    ['amount mismatch', r => { r.amountIn = (BigInt(r.amountIn) + 1n).toString() }], ['expired', r => { r.expiresAt = r.requestStartedAt - 1 }], ['quote lives too long', r => { r.expiresAt = r.requestStartedAt + 60_000 }],
    ['fee ceiling above the cap', r => { r.networkFee = (c.CIRCLE_FEE_CEILING_CAP + 1n).toString() }], ['zero fee ceiling', r => { r.networkFee = '0' }], ['absurd fee cap', r => { r.maxFeePerGas = gwei(1000).toString() }],
    ['not enough tokens', r => { r.tokenBalance = (BigInt(r.amountIn) - 1n).toString() }], ['not enough gas', r => { r.nativeBalance = '1' }], ['other request', r => { r.request.amount = '0.5' }],
  ]) {
    const f = setup({ fresh: mutateReview(fn) }); await f.controller.prepare(); assert.equal(f.controller.current().phase, 'idle', name); assert.ok(f.controller.current().error, name); assert.equal(f.world.sends.length, 0)
  }
})
await test('review rules: per-token caps, USDC permit only, USDC input must leave room for gas, supported slippage and distinct tokens', () => {
  const ok = { chainId: 5042, tokenIn: 'USDC', tokenOut: 'EURC', owner, amount: '1', slippageBps: 50 }
  // USDC is signed for (permit), every other token gets an exact approval; the SDK's increaseAllowance for USDC is not offered.
  assert.equal(c.validateCircleRequest(ok).allowanceStrategy, 'permit'); assert.equal(c.validateCircleRequest({ ...ok, tokenIn: 'EURC', tokenOut: 'USDC' }).allowanceStrategy, 'approve')
  assert.throws(() => c.validateCircleRequest({ ...ok, allowanceStrategy: 'approve' }), /invalid_strategy/); assert.throws(() => c.validateCircleRequest({ ...ok, tokenIn: 'cirBTC', tokenOut: 'USDC', amount: '0.0001', allowanceStrategy: 'permit' }), /invalid_strategy/)
  assert.equal(c.circleStrategy({ tokenIn: 'USDC' }), 'permit'); assert.equal(c.circleStrategy({ tokenIn: 'WETH' }), 'approve'); assert.equal(c.circleStrategy({ tokenIn: 'WETH', allowanceStrategy: 'approve' }), 'approve')
  for (const [name, over] of [['over the USDC cap', { amount: '10.000001' }], ['over the EURC cap', { tokenIn: 'EURC', tokenOut: 'USDC', amount: '9.000001' }], ['over the cirBTC cap', { tokenIn: 'cirBTC', amount: '0.00012001' }],
    ['over the WETH cap', { tokenIn: 'WETH', amount: '0.004000000000000001' }], ['too many decimals', { amount: '1.0000001' }], ['same token', { tokenOut: 'USDC' }], ['unknown token', { tokenOut: 'DAI' }], ['wrong network', { chainId: 1 }],
    ['unsupported slippage', { slippageBps: 75 }], ['permit for EURC', { tokenIn: 'EURC', tokenOut: 'USDC', allowanceStrategy: 'permit' }], ['zero', { amount: '0' }], ['no owner', { owner: ZERO }], ['extra field', { recipient: other }]]) {
    assert.throws(() => c.validateCircleRequest({ ...ok, ...over }), undefined, name)
  }
  assert.equal(c.validateCircleRequest({ ...ok, allowanceStrategy: 'permit' }).allowanceStrategy, 'permit')
  // MAX of USDC: input and fee come from the same balance, in different decimals.
  const fx = setup({ tokenIn: 'USDC', tokenOut: 'EURC', amount: '1' }), review = fx.ports.fresh(fx.input()); return review.then(r => {
    assert.doesNotThrow(() => c.validateCircleReview(r, fx.context, NOW_MS))
    const tight = { ...r, nativeBalance: (10n ** 18n + BigInt(r.networkFee) - 1n).toString() }; assert.throws(() => c.validateCircleReview(tight, fx.context, NOW_MS), /insufficient_gas/)
    assert.doesNotThrow(() => c.validateCircleReview({ ...r, nativeBalance: (10n ** 18n + BigInt(r.networkFee)).toString() }, fx.context, NOW_MS))
    assert.equal(c.circleFeeCeiling(null), c.CIRCLE_FEE_UNKNOWN); assert.equal(c.circleFeeCeiling(0n), c.CIRCLE_FEE_UNKNOWN); assert.equal(c.circleFeeCeiling(10n ** 16n), 5n * 10n ** 16n); assert.equal(c.circleFeeCeiling(10n ** 18n), c.CIRCLE_FEE_CEILING_CAP)
  })
})
await test('sdk parameters: separate approval confirmations (no batching), the review as stop limit, the chosen allowance strategy and nothing else', () => {
  const fx = setup({ tokenIn: 'cirBTC', tokenOut: 'WETH' })
  return fx.ports.fresh(fx.input()).then(review => {
    const p = c.buildCircleSwapParams(review, { adapter: 1 })
    assert.deepEqual(Object.keys(p).sort(), ['amountIn', 'config', 'from', 'tokenIn', 'tokenOut']); assert.equal(p.config.batchTransactions, false); assert.equal(p.config.allowanceStrategy, 'approve')
    assert.equal(p.tokenIn, T('cirBTC').address); assert.equal(p.tokenOut, T('WETH').address); assert.equal(p.amountIn, '0.0001'); assert.deepEqual(Object.keys(p.from).sort(), ['adapter', 'chain']); assert.equal(p.from.chain, 'Arc') // the SDK refuses an explicit address for a user-controlled adapter
    assert.equal(parseUnits(p.config.stopLimit, 18), BigInt(review.requiredMinimum)); assert.equal(p.config.slippageBps, 50); assert.deepEqual(Object.keys(p.config).sort(), ['allowanceStrategy', 'batchTransactions', 'slippageBps', 'stopLimit'])
  })
})
await test('happy path with an approval: Review -> approval confirmation -> wallet -> swap confirmation -> wallet -> Pending -> Confirmed, with the journal ahead of every wallet request', async () => {
  const f = setup({ autoSettle: false }), id = await f.review()
  const done = f.controller.confirm(id)
  await waitFor(() => f.controller.current().phase === 'awaiting_step')
  const first = f.controller.current(); assert.equal(first.step.kind, 'approve'); assert.equal(first.step.amount, '1000000'); assert.equal(first.step.spender.toLowerCase(), ADAPTER.toLowerCase()); assert.equal(f.world.sends.length, 0)
  assert.equal(f.records()[0].status, 'awaiting_wallet'); assert.equal(f.records()[0].steps.length, 0) // the intent is durable before any step
  f.controller.continueStep()
  await waitFor(() => f.controller.current().phase === 'awaiting_step' && f.controller.current().step.kind === 'swap')
  assert.equal(f.world.sends.length, 1); const swapStep = f.controller.current().step
  assert.equal(swapStep.minimumOut, f.records()[0].review.requiredMinimum); assert.ok(swapStep.deadline > NOW_MS / 1000)
  f.controller.continueStep(); await done
  assert.deepEqual(f.world.journalCheck, [true, true]); assert.equal(f.world.sends.length, 2)
  const [approve, swap] = f.world.sends; assert.equal(approve.nonce, 7); assert.equal(swap.nonce, 8); assert.equal(swap.type, 'eip1559'); assert.equal(approve.value, 0n); assert.equal(swap.value, 0n)
  assert.equal(c.CIRCLE_EXPLORER, 'https://explorer.arc.io/tx/')
  const view = f.controller.current(); assert.equal(view.phase, 'pending'); assert.equal(view.attempt.status, 'pending'); assert.equal(view.nextCheckMs, 5000); assert.equal(view.attempt.hash, '0x' + (0xa002).toString(16).padStart(64, '0'))
  assert.deepEqual(view.attempt.steps.map(s => [s.kind, s.status]), [['approve', 'confirmed'], ['swap', 'pending']]); assert.equal(view.attempt.steps[0].fee, '1000000000000000')
  assert.equal(f.records()[0].hash, view.attempt.hash)
  // The chain settles it.
  f.world.results.set(view.attempt.hash, 'settle'); await f.controller.reconcile()
  const final = f.controller.current(); assert.equal(final.phase, 'confirmed'); assert.equal(final.nextCheckMs, null); assert.equal(final.attempt.status, 'confirmed')
  assert.equal(final.attempt.fee, '12000000000000000'); assert.equal(final.attempt.output, f.records()[0].review.requiredMinimum); assert.deepEqual(final.attempt.steps.map(s => s.status), ['confirmed', 'confirmed'])
  assert.equal(f.settled.length, 1); assert.equal(f.sdkCallsOf?.length ?? f.world.sdkCalls.length, 1)
  // History is complete and survives a reload; a new swap is possible again.
  const again = setup({ data: f.data }); assert.equal(again.controller.history()[0].status, 'confirmed'); assert.equal(await again.review().then(Boolean), true)
})
await test('permit strategy (USDC): one signature step and one swap step, no on-chain approval, no approval fee', async () => {
  const f = setup({ tokenIn: 'USDC', tokenOut: 'EURC', strategy: 'permit' }), id = await f.review()
  const done = f.controller.confirm(id)
  await waitFor(() => f.controller.current().phase === 'awaiting_step'); assert.equal(f.controller.current().step.kind, 'permit'); f.controller.continueStep()
  await waitFor(() => f.controller.current().phase === 'awaiting_step' && f.controller.current().step.kind === 'swap'); f.controller.continueStep(); await done
  assert.equal(f.world.signs.length, 1); assert.equal(f.world.sends.length, 1); assert.equal(f.world.sends[0].to.toLowerCase(), ADAPTER.toLowerCase()); assert.equal(f.world.sends[0].nonce, 7)
  assert.equal(f.controller.current().phase, 'pending'); assert.deepEqual(f.controller.current().attempt.steps.map(s => s.kind), ['swap']) // a signature is not a transaction
})
await test('all 12 directions end to end (fake SDK): tokens, decimals, approval or permit, stop limit and verification are exact for every pair', async () => {
  assert.equal(tk.SWAP_DIRECTIONS.length, 12)
  for (const { tokenIn, tokenOut } of tk.SWAP_DIRECTIONS) {
    const f = setup({ tokenIn, tokenOut }), id = await f.review(); await f.run(id)
    const view = f.controller.current(), attempt = view.attempt, label = `${tokenIn}>${tokenOut}`; assert.equal(view.phase, 'pending', `${label} ${view.error}`)
    const amountIn = parseUnits(AMOUNTS[tokenIn], T(tokenIn).decimals), usdcInput = tokenIn === 'USDC'
    if (usdcInput) { assert.deepEqual(attempt.steps.map(s => s.kind), ['swap'], label); assert.equal(f.world.signs.length, 1, label); assert.equal(f.world.sends.length, 1, label); assert.equal(f.world.signs[0].message.value, amountIn) }
    else {
      assert.deepEqual(attempt.steps.map(s => s.kind), ['approve', 'swap'], label); assert.equal(f.world.signs.length, 0, label)
      assert.equal(f.world.sends[0].to.toLowerCase(), T(tokenIn).address.toLowerCase()); assert.equal(f.world.sends[0].data, d.encodeApprove(ADAPTER, amountIn)); assert.equal(attempt.steps[0].amount, amountIn.toString())
    }
    const sdk = f.world.sdkCalls[0]; assert.equal(sdk.tokenIn, T(tokenIn).address); assert.equal(sdk.tokenOut, T(tokenOut).address); assert.equal(sdk.amountIn, AMOUNTS[tokenIn]); assert.equal(sdk.config.allowanceStrategy, usdcInput ? 'permit' : 'approve')
    const swapSend = f.world.sends.at(-1), decoded = d.decodeAdapterExecute(swapSend.data).call; assert.equal(decoded.tokenInputs[0].amount, amountIn); assert.equal(decoded.instructions.find(i => i.tokenOut !== ZERO).tokenOut, T(tokenOut).address)
    assert.equal(decoded.instructions.find(i => i.tokenOut !== ZERO).minTokenOut.toString(), attempt.review.requiredMinimum)
    f.world.results.set(attempt.hash, 'settle'); await f.controller.reconcile(); assert.equal(f.controller.current().phase, 'confirmed', label)
    assert.ok(f.world.journalCheck.every(Boolean) && f.world.journalCheck.length === f.world.sends.length, label)
  }
})
await test('the user can decline either step: nothing reaches the wallet, nothing is left blocking, and the record says what happened', async () => {
  const f = setup(), id = await f.review(); const done = f.controller.confirm(id)
  await waitFor(() => f.controller.current().phase === 'awaiting_step'); f.controller.cancelStep(); await done
  assert.equal(f.world.sends.length, 0); const view = f.controller.current(); assert.equal(view.phase, 'rejected'); assert.match(view.error, /did not continue/); assert.equal(view.attempt.steps.length, 0)
  assert.equal(f.records()[0].status, 'rejected'); assert.equal(await f.review().then(Boolean), true) // not blocking
  // declining the swap after a confirmed approval
  const g2 = setup(), id2 = await g2.review(); const run2 = g2.controller.confirm(id2)
  await waitFor(() => g2.controller.current().phase === 'awaiting_step'); g2.controller.continueStep()
  await waitFor(() => g2.controller.current().phase === 'awaiting_step' && g2.controller.current().step.kind === 'swap'); g2.controller.cancelStep(); await run2
  const v2 = g2.controller.current(); assert.equal(v2.phase, 'rejected'); assert.equal(g2.world.sends.length, 1); assert.match(v2.attempt.log.at(-1).note, /Approval confirmed on chain; the swap was never requested/); assert.equal(v2.attempt.steps[0].fee, '1000000000000000')
  assert.deepEqual(v2.attempt.steps.map(s => s.status), ['confirmed'])
})
await test('a wallet rejection of the approval ends the attempt: no retry, no swap, no blocking record', async () => {
  const f = setup(); f.world.wallet = () => { throw Object.assign(new Error('User rejected the request'), { code: 4001 }) }
  const id = await f.review(); await f.run(id); const view = f.controller.current()
  assert.equal(view.phase, 'rejected'); assert.match(view.error, /rejected the wallet request/); assert.equal(f.world.sends.length, 1); assert.deepEqual(view.attempt.steps.map(s => s.status), ['rejected'])
  assert.equal(f.records()[0].status, 'rejected'); assert.equal(await f.review().then(Boolean), true)
})
await test('a wallet rejection of the swap after a confirmed approval: rejected, the approval stays on the record, nothing is resent', async () => {
  const f = setup(); let calls = 0
  f.world.wallet = (params, n) => { if (n === 1) { const hash = '0x' + 'a1'.repeat(32); f.world.latest++; f.world.pending++; f.world.approvals.set(hash, { status: 'confirmed', fee: '1000000000000000' }); return hash } calls++; throw Object.assign(new Error('User rejected the request'), { code: 4001 }) }
  const id = await f.review(); await f.run(id); const view = f.controller.current()
  assert.equal(view.phase, 'rejected'); assert.equal(calls, 1); assert.equal(f.world.sends.length, 2); assert.deepEqual(view.attempt.steps.map(s => s.status), ['confirmed', 'rejected']); assert.match(view.attempt.log.at(-1).note, /Approval confirmed on chain/)
  assert.equal(f.world.sdkCalls.length, 1)
})
await test('an approval that reverted on chain stops the flow before the swap is ever requested: Failed, with the real reason', async () => {
  const f = setup(); f.world.approvalOutcome = 'failed'
  const id = await f.review(); await f.run(id); const view = f.controller.current()
  assert.equal(view.phase, 'failed'); assert.equal(f.world.sends.length, 1); assert.deepEqual(view.attempt.steps.map(s => s.status), ['failed']); assert.match(view.attempt.log.at(-1).note, /approval transaction reverted/)
})
await test('an approval that is not confirmed yet blocks the swap request, and an approval without evidence is never assumed', async () => {
  const f = setup(); f.world.approvalOutcome = 'pending'; f.world.approvals.get = () => ({ status: 'pending' })
  const id = await f.review(); await f.run(id); const view = f.controller.current()
  assert.equal(f.world.sends.length, 1); assert.equal(view.phase, 'pending'); assert.equal(view.attempt.hash, undefined); assert.deepEqual(view.attempt.steps.map(s => s.status), ['pending'])
  assert.equal(f.records()[0].status, 'pending') // still blocks: the approval can land at any time
  await f.controller.prepare(); assert.match(f.controller.current().error, /unresolved/)
  // after a reload the pending approval resolves on its own and the attempt is closed as "swap never requested"
  const approvalHash = view.attempt.steps[0].hash, g2 = setup({ data: f.data }); g2.world.approvals.set(approvalHash, { status: 'confirmed', fee: '1000000000000000' })
  await g2.controller.reconcile(); const after = g2.controller.current(); assert.equal(after.phase, 'rejected'); assert.match(after.attempt.log.at(-1).note, /swap was never requested/); assert.equal(await g2.review().then(Boolean), true)
})
await test('Circle returning swap instructions that differ from the review: blocked before the wallet, approval kept on record, nothing sent', async () => {
  for (const [name, tweak, text] of [['lower minimum', call => { call.params.instructions[1].minTokenOut -= 1n }, /differ from what you reviewed/], ['third-party recipient', call => { call.params.tokens[1].beneficiary = other }, /differ from what you reviewed/],
    ['more input', call => { call.tokenInputs[0].amount += 1n }, /differ from what you reviewed/]]) {
    const f = setup(); f.world.serviceTweak = tweak; const id = await f.review(); await f.run(id); const view = f.controller.current()
    assert.equal(view.phase, 'rejected', name); assert.match(view.error, text, name); assert.ok(view.attempt.log.some(entry => text.test(entry.note)), name); assert.match(view.attempt.log.at(-1).note, /Approval confirmed on chain; the swap was never requested/)
    assert.equal(f.world.sends.length, 1, name); assert.deepEqual(view.attempt.steps.map(s => s.status), ['confirmed'], name); assert.equal(f.records()[0].status, 'rejected')
  }
})
await test('the SDK cannot widen the request: unlimited approvals, other recipients, batches, raw sends, signatures and a second swap are all blocked, and no wallet call is made', async () => {
  const attempts = {
    unlimited: async (w, p) => w.sendTransaction({ account: w.account, chain: { id: 5042 }, to: T('EURC').address, data: d.encodeApprove(ADAPTER, 2n ** 256n - 1n) }),
    otherSpender: async w => w.sendTransaction({ account: w.account, chain: { id: 5042 }, to: T('EURC').address, data: d.encodeApprove(other, 1_000_000n) }),
    transfer: async w => w.sendTransaction({ account: w.account, chain: { id: 5042 }, to: T('EURC').address, data: '0xa9059cbb' + '00'.repeat(64) }),
    nativeValue: async w => w.sendTransaction({ account: w.account, chain: { id: 5042 }, to: other, data: '0x', value: 1n }),
    batch: async w => { assert.equal(w.sendCalls, undefined); return w.writeContract() },
    raw: async w => w.sendRawTransaction(), sign: async w => w.signTypedData({ account: w.account, domain: {}, types: {}, primaryType: 'Permit', message: {} }),
  }
  for (const [name, attempt] of Object.entries(attempts)) {
    const f = setup(); f.world.kit = { swap: async params => { await attempt(params.from.adapter.wallet, params); throw Error('should not get here') } }
    const id = await f.review(); await f.run(id); const view = f.controller.current()
    assert.equal(view.phase, 'rejected', name); assert.equal(f.world.sends.length, 0, name); assert.equal(f.world.signs.length, 0, name); assert.equal(f.records()[0].status, 'rejected')
  }
  // a SDK that tries to send the swap twice
  const f = setup(); f.world.kit = { swap: async params => { const w = params.from.adapter.wallet, fake = fakeKit(f.world, f.clock); await fake.swap(params); return w.sendTransaction({ account: w.account, chain: { id: 5042 }, to: ADAPTER, data: '0x' }).catch(() => 'blocked') } }
  const id = await f.review(); await f.run(id); assert.equal(f.world.sends.length, 2)
})
await test('SDK failure before any wallet request: Rejected with a clear message, nothing sent, nothing blocking', async () => {
  const f = setup(); f.world.kit = { swap: async () => { throw Error('Circle service unavailable') } }
  const id = await f.review(); await f.run(id); const view = f.controller.current()
  assert.equal(view.phase, 'rejected'); assert.match(view.error, /stopped before any transaction was requested/); assert.equal(f.world.sends.length, 0); assert.equal(f.records()[0].status, 'rejected'); assert.equal(await f.review().then(Boolean), true)
  const g2 = setup({ ports: { sdk: () => { throw Error('adapter creation failed') } } }); const id2 = await g2.review(); await g2.controller.confirm(id2); assert.equal(g2.controller.current().phase, 'rejected'); assert.equal(g2.world.sends.length, 0)
})
await test('the fee ceiling holds across steps: a huge gas limit from the SDK is refused before the wallet, and the approval fee counts against the ceiling', async () => {
  const f = setup(); f.world.kit = { swap: async params => { const w = params.from.adapter.wallet; await w.sendTransaction({ account: w.account, chain: { id: 5042 }, to: T('EURC').address, data: d.encodeApprove(ADAPTER, 1_000_000n), gas: 3_900_000n }) } }
  let id = await f.review(); await f.run(id); assert.equal(f.controller.current().phase, 'rejected'); assert.equal(f.world.sends.length, 0)
  const g2 = setup({ fresh: async (request, now) => { const r = await setup().ports.fresh(request); return { ...r, requestStartedAt: now, expiresAt: now + 30_000, networkFee: (3n * 10n ** 16n).toString() } } })
  id = await g2.review(); await g2.run(id) // swap gas 1,050,000 x 30 gwei = 0.0315 USDC > the whole 0.03 ceiling
  assert.equal(g2.controller.current().phase, 'rejected'); assert.match(g2.controller.current().error, /fee ceiling/); assert.ok(g2.controller.current().attempt.log.some(entry => /fee ceiling/.test(entry.note))); assert.equal(g2.world.sends.length, 1)
  const g3 = setup({ fresh: async (request, now) => { const r = await setup().ports.fresh(request); return { ...r, requestStartedAt: now, expiresAt: now + 30_000, networkFee: (4n * 10n ** 16n).toString() } } })
  g3.world.approvals.get = hash => ({ status: 'confirmed', fee: (2n * 10n ** 16n).toString() }) // the approval already used half of it
  id = await g3.review(); await g3.run(id); assert.equal(g3.controller.current().phase, 'rejected'); assert.match(g3.controller.current().error, /fee ceiling/); assert.ok(g3.controller.current().attempt.log.some(entry => /fee ceiling/.test(entry.note)))
})
await test('a simulation that would revert stops the step before the wallet; an unreadable simulation also stops it', async () => {
  const f = setup(); f.world.estimateFails = true; const id = await f.review(); await f.run(id)
  assert.equal(f.controller.current().phase, 'rejected'); assert.equal(f.world.sends.length, 0); assert.match(f.controller.current().attempt.log.at(-1).note, /simulation reverted/)
  const g2 = setup(); g2.world.estimateApprove = 0n; const id2 = await g2.review(); await g2.run(id2); assert.equal(g2.world.sends.length, 0)
})
await test('journal first: when a step cannot be recorded, the wallet is never contacted', async () => {
  const f = setup(); let writes = 0
  f.world.storageFail = () => { writes++; if (writes >= 2) throw Error('quota') } // write 1 = the attempt intent, write 2 = the approval step
  const id = await f.review(); await f.run(id); assert.equal(f.world.sends.length, 0); assert.equal(f.controller.current().phase, 'rejected'); assert.match(f.controller.current().error, /Safe transaction recording is unavailable|stopped/)
  const g2 = setup(); g2.world.storageFail = () => { throw Error('quota') }; const id2 = await g2.review(); await g2.controller.confirm(id2); assert.equal(g2.world.sends.length, 0); assert.equal(g2.world.sdkCalls.length, 0)
  assert.match(g2.controller.current().error, /Safe transaction recording is unavailable/)
})
await test('one wallet, one open swap: a second confirm, a second review, another tab and the other provider are all blocked', async () => {
  const f = setup(), id = await f.review(); const done = f.controller.confirm(id)
  await waitFor(() => f.controller.current().phase === 'awaiting_step'); await f.controller.confirm(id); await f.controller.prepare(); assert.equal(f.world.sdkCalls.length, 1); assert.equal(f.world.sends.length, 0)
  f.controller.continueStep(); await waitFor(() => f.controller.current().phase === 'awaiting_step' && f.controller.current().step.kind === 'swap'); f.controller.continueStep(); await done
  assert.equal(f.world.sends.length, 2); await f.controller.confirm(id); assert.equal(f.world.sends.length, 2); assert.equal(f.world.sdkCalls.length, 1) // approvalId is single use
  await f.controller.prepare(); assert.match(f.controller.current().error, /unresolved/)
  const other1 = setup({ locks: new Set([owner.toLowerCase()]) }); const id1 = await other1.review(); await other1.controller.confirm(id1); assert.equal(other1.world.sdkCalls.length, 0); assert.match(other1.controller.current().error, /Another tab/)
  const g3 = setup({ ports: { blockedElsewhere: () => true } }); await g3.controller.prepare(); assert.match(g3.controller.current().error, /other provider/)
  const g4 = setup(); const id4 = await g4.review(); g4.ports.blockedElsewhere = () => true; await g4.controller.confirm(id4); assert.equal(g4.world.sdkCalls.length, 0); assert.match(g4.controller.current().error, /other provider/)
})
await test('nonce discipline: disagreeing public and wallet nonces, a pending transaction, a moved nonce or inconsistent wallet reads block the swap before any request', async () => {
  let f = setup(); f.ports.publicNonce = async () => ({ nonce: 8, latestNonce: 8 }); await f.controller.prepare(); assert.match(f.controller.current().error, /disagree about the account nonce/)
  f = setup(); f.world.pending = 8; await f.controller.prepare(); assert.match(f.controller.current().error, /pending transaction/)
  f = setup(); const origin = f.provider.request; let reads = 0
  f.provider.request = async args => { if (args.method === 'eth_getTransactionCount' && args.params[1] === 'latest') { reads++; return '0x' + (7 + (reads % 2)).toString(16) } return origin(args) }
  await f.controller.prepare(); assert.match(f.controller.current().error, /inconsistent latest\/pending/)
  f = setup(); f.world.chainId = 1; await f.controller.prepare(); assert.match(f.controller.current().error, /wallet RPC could not provide|network/)
  f = setup(); f.world.accounts = [other]; await f.controller.prepare(); assert.equal(f.controller.current().phase, 'idle')
  // the nonce moves between Review and Confirm
  f = setup(); const id = await f.review(); f.world.latest = 9; f.world.pending = 9; await f.controller.confirm(id); assert.equal(f.world.sdkCalls.length, 0); assert.equal(f.world.sends.length, 0); assert.match(f.controller.current().error, /nonce changed since Review/)
  // the nonce moves between the approval and the swap: the swap is not requested
  f = setup(); f.world.wallet = (params, n) => { const hash = '0x' + (0xb000 + n).toString(16).padStart(64, '0'); if (n === 1) { f.world.latest += 2; f.world.pending += 2; f.world.approvals.set(hash, { status: 'confirmed', fee: '1' }) } return hash }
  const id2 = await f.review(); await f.run(id2); assert.equal(f.world.sends.length, 1); assert.equal(f.controller.current().phase, 'rejected'); assert.match(f.controller.current().attempt.log.at(-1).note, /nonce changed/)
})
await test('the sent transactions carry exactly the reviewed nonce, then the next one; the wallet is also checked after each confirmation', async () => {
  const f = setup(), id = await f.review(); await f.run(id); assert.deepEqual(f.world.sends.map(s => s.nonce), [7, 8]); assert.deepEqual(f.world.sends.map(s => s.maxFeePerGas), [gwei(30), gwei(30)]); assert.deepEqual(f.world.sends.map(s => s.maxPriorityFeePerGas), [gwei(1), gwei(1)])
  const g2 = setup(), id2 = await g2.review(); const done = g2.controller.confirm(id2)
  await waitFor(() => g2.controller.current().phase === 'awaiting_step'); g2.world.chainId = 137; g2.controller.continueStep(); await done
  assert.equal(g2.world.sends.length, 0); assert.equal(g2.controller.current().phase, 'rejected'); assert.match(g2.controller.current().error, /not on Arc Mainnet|wallet RPC/)
})
await test('wallet, network or input changes while a confirmation is open cancel the step; nothing reaches the wallet', async () => {
  for (const change of [f => { f.context.chainId = 1 }, f => { f.context.owner = other }, f => { f.context.connected = false }, f => f.setInput({ ...f.input(), amount: '0.5' }), f => { f.context.connectorId = 'another' }]) {
    const f = setup(), id = await f.review(), done = f.controller.confirm(id); await waitFor(() => f.controller.current().phase === 'awaiting_step'); change(f); f.controller.continueStep(); await done
    assert.equal(f.world.sends.length, 0); assert.equal(f.controller.current().phase, 'rejected')
  }
  const f = setup(), id = await f.review(), done = f.controller.confirm(id); await waitFor(() => f.controller.current().phase === 'awaiting_step'); f.controller.invalidate(); await done
  assert.equal(f.world.sends.length, 0); assert.equal(f.controller.current().phase, 'rejected')
  const g2 = setup(); await g2.review(); g2.controller.invalidate(); assert.equal(g2.controller.current().phase, 'idle'); await g2.controller.confirm('forged'); assert.equal(g2.world.sdkCalls.length, 0)
})
await test('an expired quote cannot start a flow, but a flow that started is not cut off by the quote clock', async () => {
  const f = setup(), id = await f.review(); f.clock.now += 26_000; await f.controller.confirm(id); assert.equal(f.world.sdkCalls.length, 0); assert.match(f.controller.current().error, /expired/)
  const g2 = setup(), id2 = await g2.review(); const done = g2.controller.confirm(id2)
  await waitFor(() => g2.controller.current().phase === 'awaiting_step'); g2.clock.now += 60_000 // well past the 30 s quote, still inside the service's own ~600 s window
  g2.controller.continueStep(); await waitFor(() => g2.controller.current().phase === 'awaiting_step' && g2.controller.current().step.kind === 'swap'); g2.controller.continueStep(); await done
  assert.equal(g2.world.sends.length, 2); assert.equal(g2.controller.current().phase, 'pending')
})
await test('timers: an unanswered step confirmation expires without a wallet request, and an unanswered wallet request becomes Unknown yet keeps a late hash', async () => {
  mock.timers.enable({ apis: ['setTimeout'] })
  try {
    const f = setup(), id = await f.review(), done = f.controller.confirm(id)
    await waitFor(() => f.controller.current().phase === 'awaiting_step'); mock.timers.tick(c.STEP_CONFIRM_TIMEOUT_MS - 1); assert.equal(f.controller.current().phase, 'awaiting_step'); mock.timers.tick(1); await done
    assert.equal(f.controller.current().phase, 'rejected'); assert.match(f.controller.current().error, /confirmation window/); assert.equal(f.world.sends.length, 0)
    // wallet window
    const g2 = setup(); let release; g2.world.wallet = () => new Promise(resolve => { release = resolve })
    const id2 = await g2.review(), run2 = g2.controller.confirm(id2)
    await waitFor(() => g2.controller.current().phase === 'awaiting_step'); g2.controller.continueStep(); await waitFor(() => g2.controller.current().phase === 'awaiting_wallet')
    assert.equal(g2.controller.current().walletWindowMs, c.APPROVAL_WALLET_WINDOW_MS); assert.equal(g2.controller.current().walletRequestOpen, true)
    mock.timers.tick(c.APPROVAL_WALLET_WINDOW_MS - 1); assert.equal(g2.controller.current().phase, 'awaiting_wallet'); mock.timers.tick(1)
    assert.equal(g2.controller.current().phase, 'unknown'); assert.match(g2.controller.current().error, /approval window ended/); assert.equal(g2.records()[0].status, 'unknown')
    await g2.controller.prepare(); assert.equal(g2.controller.current().phase, 'unknown'); assert.equal(g2.world.quotes, 1) // no new review while the request may still be answered
    const sibling = setup({ data: g2.data, locks: new Set() }); await sibling.controller.prepare(); assert.match(sibling.controller.current().error, /unresolved/) // and a reload sees the durable record
    const hash = '0x' + 'a1'.repeat(32); g2.world.approvals.set(hash, { status: 'confirmed', fee: '1' }); g2.world.latest++; g2.world.pending++
    release(hash); await waitFor(() => g2.world.sends.length === 1 && g2.controller.current().attempt?.steps[0]?.hash === hash)
    // the late hash is recorded; the flow goes on to the swap gate
    await waitFor(() => g2.controller.current().phase === 'awaiting_step'); g2.controller.cancelStep(); await run2
  } finally { mock.timers.reset() }
})
await test('a wallet that never returns a hash is Unknown and blocks; a bad hash is not trusted; a late 4001 turns Unknown into Rejected', async () => {
  const f = setup(); f.world.wallet = () => { throw Object.assign(new Error('internal'), { code: -32603 }) }
  let id = await f.review(); await f.run(id); assert.equal(f.controller.current().phase, 'unknown'); assert.match(f.controller.current().error, /not yet verified/); assert.equal(f.records()[0].status, 'unknown')
  await f.controller.prepare(); assert.match(f.controller.current().error, /unresolved/); assert.equal(f.world.sends.length, 1)
  const g2 = setup(); g2.world.wallet = () => 'not-a-hash'; id = await g2.review(); await g2.run(id); assert.equal(g2.controller.current().phase, 'unknown'); assert.equal(g2.controller.current().attempt.hash, undefined)
})
await test('statuses and polling: pending is polled every 5 s with the status kept visible; terminal and deterministic results stop automatic checks', async () => {
  const f = setup({ autoSettle: false }), id = await f.review(); await f.run(id)
  const hash = f.controller.current().attempt.hash; f.seen.length = 0
  await f.controller.reconcile(); let view = f.controller.current(); assert.equal(view.phase, 'pending'); assert.equal(view.nextCheckMs, x.PENDING_CHECK_MS); assert.equal(view.checking, false)
  // during a check the known status stays on screen and only the indicator changes
  assert.ok(f.seen.some(v => v.checking === true && v.phase === 'pending' && v.attempt.status === 'pending')); assert.ok(f.seen.every(v => v.phase !== 'idle'))
  assert.ok(f.seen.filter(v => v.checking === false).every(v => typeof v.observedAt === 'number'))
  // transient trouble backs off 5, 10, 20, 40, 60, 60, 60 and then stops
  f.world.results.set(hash, new x.ExecutionVerificationError('rpc', true)); const delays = []
  for (let i = 0; i < 9; i++) { await f.controller.reconcile(); delays.push(f.controller.current().nextCheckMs) }
  assert.deepEqual(delays, [5000, 10000, 20000, 40000, 60000, 60000, 60000, null, null]); assert.equal(f.controller.current().phase, 'pending'); assert.match(f.controller.current().error, /Automatic checks stopped/); assert.equal(f.controller.blocking(owner), true) // a read problem teaches nothing about the chain: Pending stays Pending
  // a hash that is not the attempt's transaction is deterministic: one answer, no automatic retry
  f.world.results.set(hash, new x.ExecutionVerificationError('binding', false)); await f.controller.reconcile(); view = f.controller.current(); assert.equal(view.nextCheckMs, null); assert.match(view.error, /does not identify the reviewed swap/)
  // recovery: the chain answers
  f.world.results.set(hash, 'settle'); await f.controller.reconcile(); assert.equal(f.controller.current().phase, 'confirmed'); assert.equal(f.controller.current().nextCheckMs, null)
})
await test('chain success that is not the reviewed transaction is Mismatch, never Confirmed; a revert is Failed; incomplete evidence claims nothing', async () => {
  const outcome = async (result) => { const f = setup(); const id = await f.review(); await f.run(id); f.world.results.set(f.controller.current().attempt.hash, result); await f.controller.reconcile(); return f }
  const settled = (over = {}) => ({ status: 'settled', output: '800000', fee: '12000000000000000', approvals: [{ index: 0, status: 'confirmed', fee: '1000000000000000' }],
    chain: { state: 'success', blockNumber: '5', blockHash: '0x' + '22'.repeat(32), gasUsed: '1', effectiveGasPrice: '1', fee: '11000000000000000', received: '800000', sent: '1000000', checkedAt: 1 },
    intent: { verdict: 'mismatch', checks: [], differences: ['The wallet sent different calldata than the application allowed.'], checkedAt: 1 }, ...over })
  let f = await outcome(settled()); assert.equal(f.controller.current().phase, 'mismatch'); assert.match(f.controller.current().error, /not the transaction you reviewed/); assert.equal(f.controller.current().attempt.chain.state, 'success'); assert.equal(f.settled[0].status, 'mismatch')
  assert.match(f.controller.current().attempt.log.at(-1).note, /not the reviewed transaction/); assert.equal(f.records()[0].status, 'mismatch') // original review data untouched
  f = await outcome(settled({ chain: { ...settled().chain, state: 'reverted', received: null }, intent: { verdict: 'verified', checks: [], differences: [], checkedAt: 1 } })); assert.equal(f.controller.current().phase, 'failed'); assert.match(f.controller.current().attempt.log.at(-1).note, /reverted\. The exact approval stays in place/)
  f = await outcome(settled({ intent: { verdict: 'incomplete', checks: [], differences: [], checkedAt: 1 } })); assert.equal(f.controller.current().phase, 'unknown'); assert.ok(f.controller.current().nextCheckMs > 0)
  f = await outcome(settled({ output: '1', intent: { verdict: 'verified', checks: [], differences: [], checkedAt: 1 } })); assert.notEqual(f.controller.current().phase, 'confirmed') // below the reviewed minimum
  f = await outcome(settled({ fee: (10n ** 18n).toString(), intent: { verdict: 'verified', checks: [], differences: [], checkedAt: 1 } })); assert.notEqual(f.controller.current().phase, 'confirmed') // above the fee ceiling
  f = await outcome(settled({ intent: { verdict: 'unbound', checks: [], differences: [], checkedAt: 1 } })); assert.equal(f.controller.current().phase, 'unknown')
})
await test('a settled record is never downgraded by a read failure and keeps blocking new swaps until it is read again', async () => {
  const f = setup(), id = await f.review(); await f.run(id); const hash = f.controller.current().attempt.hash; f.world.results.set(hash, 'settle'); await f.controller.reconcile(); assert.equal(f.controller.current().phase, 'confirmed')
  f.world.results.set(hash, new x.ExecutionVerificationError('rpc', true)); await f.controller.reconcile(); const view = f.controller.current()
  assert.equal(view.phase, 'confirmed'); assert.equal(view.attempt.status, 'confirmed'); assert.match(view.error, /could not be read/); assert.equal(f.records()[0].status, 'confirmed')
  await f.controller.prepare(); assert.match(f.controller.current().error, /unresolved/)
  f.world.results.set(hash, 'settle'); await f.controller.reconcile(); await f.controller.prepare(); assert.equal(f.controller.current().phase, 'review')
})
await test('reload recovery: a pending swap, an unknown wallet request and a recovered hash are handled from the journal alone; a wrong hash is refused', async () => {
  const f = setup(), id = await f.review(); await f.run(id); const attempt = f.controller.current().attempt
  const reloaded = setup({ data: f.data }); reloaded.world.results.set(attempt.hash, 'settle'); await reloaded.controller.reconcile(); assert.equal(reloaded.controller.current().phase, 'confirmed')
  // a settled record is re-read from the chain on every reload; if the chain no longer shows it (reorg), it becomes durable Pending again and blocks
  const blocked = setup({ data: f.data }); blocked.world.results.set(attempt.hash, 'settle'); await blocked.controller.reconcile(); assert.equal(blocked.controller.current().phase, 'confirmed')
  const reorged = setup({ data: f.data }); await reorged.controller.reconcile(); assert.equal(reorged.controller.current().phase, 'pending'); assert.equal(JSON.parse(reorged.data.get(reorged.storageKey))[0].status, 'pending')
  await reorged.controller.prepare(); assert.match(reorged.controller.current().error, /unresolved/)
  // unknown wallet request without a hash
  const u = setup(); u.world.wallet = () => { throw Object.assign(new Error('internal'), { code: -32603 }) }; const uid = await u.review(); await u.run(uid)
  const again = setup({ data: u.data }); await again.controller.reconcile(); assert.equal(again.controller.current().phase, 'unknown'); assert.equal(again.controller.current().nextCheckMs, null)
  assert.equal(again.world.resultCalls, 0)
  // the approval is the unknown step, so a swap hash cannot be recovered for it
  await again.controller.reconcile(owner, '0x' + 'cc'.repeat(32)); assert.match(again.controller.current().error, /does not identify/)
  // swap unknown (wallet answered nothing for the swap): the hash found in the wallet can be recovered, verified against the journal
  const s = setup(); s.world.wallet = (params, n) => { if (n === 1) { const hash = '0x' + 'a1'.repeat(32); s.world.latest++; s.world.pending++; s.world.approvals.set(hash, { status: 'confirmed', fee: '1' }); return hash } throw Object.assign(new Error('internal'), { code: -32603 }) }
  const sid = await s.review(); await s.run(sid); assert.equal(s.controller.current().phase, 'unknown'); const recovered = '0x' + 'dd'.repeat(32)
  const r1 = setup({ data: s.data }); r1.world.results.set(recovered, new x.ExecutionVerificationError('binding', false)); await r1.controller.reconcile(owner, recovered)
  assert.match(r1.controller.current().error, /does not identify/); assert.equal(JSON.parse(r1.data.get(r1.storageKey))[0].hash, undefined) // an unverified hash is never stored
  const r2 = setup({ data: s.data }); r2.world.results.set(recovered, 'settle'); await r2.controller.reconcile(owner, recovered); assert.equal(r2.controller.current().phase, 'confirmed'); assert.equal(JSON.parse(r2.data.get(r2.storageKey))[0].hash, recovered)
  await r2.controller.reconcile(owner, '0x' + 'ee'.repeat(32)); assert.match(r2.controller.current().error, /does not identify|checked/)
})
await test('journal: records are validated strictly, tampering fails closed without deleting anything, history is listed across wallets and providers, eviction never drops an unresolved or mismatching record', async () => {
  const f = setup(), id = await f.review(); await f.run(id); const key = f.storageKey, good = f.data.get(key), attempts = JSON.parse(good)
  const tamper = fn => { const copy = structuredClone(attempts); fn(copy[0]); return JSON.stringify(copy) }
  for (const [name, text] of [['unknown key', tamper(a => { a.extra = 1 })], ['bad status', tamper(a => { a.status = 'done' })], ['bad step kind', tamper(a => { a.steps[0].kind = 'transfer' })], ['step index gap', tamper(a => { a.steps[1].index = 5 })],
    ['hash without a matching swap step', tamper(a => { a.hash = '0x' + 'ff'.repeat(32) })], ['pending step without a hash', tamper(a => { delete a.steps[1].hash })], ['other owner', tamper(a => { a.review.request.owner = other })], ['bad review', tamper(a => { a.review.requiredMinimum = '0' })],
    ['not json', '{'], ['not an array', '{}'], ['oversize', 'x'.repeat(1048577)]]) {
    const g2 = setup({ data: new Map([[key, text]]) }); await g2.controller.prepare(); assert.equal(g2.controller.current().phase, 'idle', name); assert.match(g2.controller.current().error, /Safe transaction recording is unavailable/, name)
    assert.equal(g2.data.get(key), text, name); assert.throws(() => g2.controller.history(), /storage/)
  }
  const storage = { length: 2, key: i => [key, 'other-key'][i], getItem: k => (k === key ? good : null) }
  const listed = c.listStoredCircleAttempts(storage); assert.equal(listed.length, 1); assert.equal(listed[0].owner, owner.toLowerCase()); assert.equal(listed[0].unreadable, false); assert.equal(listed[0].attempts[0].id, attempts[0].id)
  assert.deepEqual(c.listStoredCircleAttempts({ length: 1, key: () => key, getItem: () => '{' }), [{ owner: owner.toLowerCase(), attempts: [], archived: [], unreadable: true }]); assert.deepEqual(c.listStoredCircleAttempts({ get length() { throw Error('x') }, key: () => null, getItem: () => null }), [])
  // eviction: 20 records max; oldest settled first; mismatch last; unresolved never
  const journal = c.createCircleJournal({ getItem: k => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) }), store = new Map()
  const record = (n, status, extra = {}) => { const base = structuredClone(attempts[0]), keep = status === 'mismatch'; return { ...base, id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`, status, ...extra, steps: keep ? base.steps : [], hash: keep ? base.hash : undefined } } // a mismatch is about a swap transaction, so it keeps its steps and hash
  for (let n = 1; n <= 20; n++) journal.save(record(n, n === 1 ? 'mismatch' : n === 2 ? 'pending' : 'rejected'))
  assert.equal(journal.read(owner).length, 20); journal.save(record(21, 'rejected')); const ids = journal.read(owner).map(a => a.id)
  assert.equal(ids.length, 20); assert.ok(ids.includes(record(1, 'x').id)); assert.ok(ids.includes(record(2, 'x').id)); assert.ok(!ids.includes(record(3, 'x').id))
  // Nothing is deleted: the record that left the active journal is in the archive.
  assert.deepEqual(journal.archived(owner).map(a => a.id), [record(3, 'x').id])
  for (let n = 30; n < 60; n++) { try { journal.save(record(n, 'pending')) } catch (error) { assert.match(error.message, /storage/) } }
  assert.ok(journal.read(owner).filter(a => a.status === 'pending').length >= 2)
})
await test('messages: every guard and controller reason has its own readable explanation', () => {
  const codes = ['method_blocked', 'sealed', 'account', 'network', 'extra_field', 'wrong_target', 'value', 'approve_data', 'approve_amount', 'approve_spender', 'swap_calldata', 'step_order', 'duplicate_send', 'fee_ceiling', 'gas_limit', 'typed_data', 'step_declined', 'step_timeout', 'hash',
    'writes_disabled', 'pilot_restricted', 'context', 'expired', 'busy', 'busy_other', 'lock', 'storage', 'nonce', 'nonce_rpc', 'nonce_pending', 'nonce_regression', 'public_nonce', 'wallet_nonce', 'rejected', 'unknown', 'wallet_timeout', 'verification', 'verification_binding', 'verification_stopped',
    'mismatch', 'smart_wallet', 'insufficient_input_balance', 'insufficient_gas', 'adapter_identity', 'simulation', 'approval_failed', 'approval_pending', 'approval_missing', 'sdk_failed']
  const generic = c.circleSwapMessage('preflight'), seen = new Set()
  for (const code of codes) { const message = c.circleSwapMessage(code); assert.ok(message.length > 20, code); if (code !== 'preflight') assert.notEqual(message, generic, code); seen.add(message) }
  assert.equal(seen.size, codes.length); assert.equal(c.circleSwapMessage('no-such-code'), generic)
})
await test('wallet nonce reads and the real viem wallet path: a stable account passes, inconsistencies fail, and eth_sendTransaction carries the reviewed fields', async () => {
  const provider = (over = {}) => ({ request: async ({ method, params }) => { if (over[method]) return over[method](params); if (method === 'eth_chainId') return '0x13b2'; if (method === 'eth_accounts') return [owner]; if (method === 'eth_getTransactionCount') return '0x7'; throw Error('unexpected') } })
  assert.deepEqual(await c.readWalletNonceState(provider(), owner), { nonce: 7, latestNonce: 7 })
  for (const [name, over] of [['wrong chain', { eth_chainId: () => '0x1' }], ['other account', { eth_accounts: () => [other] }], ['no accounts', { eth_accounts: () => [] }], ['bad quantity', { eth_getTransactionCount: () => '7' }], ['padded quantity', { eth_getTransactionCount: () => '0x07' }],
    ['huge quantity', { eth_getTransactionCount: () => '0x20000000000001' }], ['wallet error', { eth_getTransactionCount: () => { throw Error('boom') } }], ['pending behind latest', { eth_getTransactionCount: params => (params[1] === 'pending' ? '0x6' : '0x7') }]]) {
    await assert.rejects(c.readWalletNonceState(provider(over), owner), error => /wallet_nonce/.test(error.message), name)
  }
  const sent = []; const inner = c.viemInnerWallet({ request: async ({ method, params }) => { if (method === 'eth_chainId') return '0x13b2'; if (method === 'eth_accounts') return [owner]; if (method === 'eth_sendTransaction') { sent.push(params[0]); return '0x' + 'ab'.repeat(32) } throw Error(`unexpected ${method}`) } }, owner)
  assert.equal(await inner.getChainId(), 5042); assert.deepEqual(await inner.getAddresses(), [owner])
  const hash = await inner.sendTransaction({ account: { address: owner, type: 'json-rpc' }, chain: { id: 5042, name: 'Arc', nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 }, rpcUrls: { default: { http: ['https://rpc.mainnet.arc.io'] } } }, to: T('EURC').address, data: d.encodeApprove(ADAPTER, 1_000_000n), value: 0n, gas: 60000n, nonce: 7, type: 'eip1559', maxFeePerGas: gwei(30), maxPriorityFeePerGas: gwei(1) })
  assert.equal(hash, '0x' + 'ab'.repeat(32)); assert.equal(sent.length, 1); assert.equal(sent[0].from.toLowerCase(), owner.toLowerCase()); assert.equal(sent[0].to.toLowerCase(), T('EURC').address.toLowerCase()); assert.equal(sent[0].nonce, '0x7'); assert.equal(sent[0].gas, '0xea60')
  assert.equal(sent[0].maxFeePerGas, '0x' + gwei(30).toString(16)); assert.equal(sent[0].type, '0x2')
  for (const method of ['eth_sendRawTransaction', 'eth_sendTransaction', 'eth_sign', 'personal_sign', 'eth_getLogs', 'debug_traceTransaction']) assert.throws(() => c.assertCircleExecutionReadMethod(method), /read_only_rpc/, method)
  for (const method of ['eth_chainId', 'eth_call', 'eth_getTransactionReceipt', 'eth_estimateGas', 'eth_getBlockByNumber']) assert.doesNotThrow(() => c.assertCircleExecutionReadMethod(method))
})

// =============================================================================================================================
// D. Chain verification (real transactions)
// =============================================================================================================================
const feeOfReal = s => s.receipt.gasUsed * s.receipt.effectiveGasPrice
function fakeRpc(entry, over = {}) {
  const tx = formatTransaction(entry.v.tx), receipt = formatTransactionReceipt(entry.v.receipt), latest = over.latest ?? receipt.blockNumber + 5n
  const rpc = {
    getChainId: async () => over.chainId ?? 5042, getBlockNumber: async () => latest,
    getTransaction: async ({ hash }) => { if (over.tx) return over.tx(hash); if (hash === entry.hash) { if (over.noTx) { const error = new Error('x'); error.name = 'TransactionNotFoundError'; throw error } return over.mutateTx ? over.mutateTx(tx) : tx } return over.approveTx(hash) },
    getTransactionReceipt: async ({ hash }) => { if (hash === entry.hash) { if (over.noReceipt) { const error = new Error('x'); error.name = 'TransactionReceiptNotFoundError'; throw error } return over.mutateReceipt ? over.mutateReceipt(receipt) : receipt } return over.approveReceipt(hash) },
    getBlock: async ({ blockNumber }) => ({ hash: blockNumber === receipt.blockNumber ? (over.blockHash ?? receipt.blockHash) : '0x' + '77'.repeat(32), timestamp: over.timestamp === undefined ? BigInt(entry.blockTime) : over.timestamp }), readContract: async () => over.allowance ?? 0n,
  }
  if (over.rpcError) for (const key of ['getTransaction', 'getTransactionReceipt', 'getBlock', 'getBlockNumber', 'getChainId']) if (over.rpcError === key) rpc[key] = async () => { throw new Error('rpc down') }
  return rpc
}
function attemptFor(entry, over = {}) {
  const { intent, call, swap } = entry, approve = intent.strategy === 'approve'
  const inSym = entry.tokenIn, outSym = entry.tokenOut
  const review = { request: { chainId: 5042, tokenIn: inSym, tokenOut: outSym, owner: intent.owner, amount: '0.000001', slippageBps: 50, allowanceStrategy: intent.strategy }, amountIn: intent.amountIn.toString(), estimatedOutput: (swap.minTokenOut * 2n).toString(), requiredMinimum: intent.minimumOut.toString(),
    networkFee: (over.ceiling ?? (entry.tx.gas * entry.tx.maxFeePerGas + 2n * 10n ** 16n)).toString(), maxFeePerGas: entry.tx.maxFeePerGas.toString(), maxPriorityFeePerGas: entry.tx.maxPriorityFeePerGas.toString(), nativeBalance: '0', tokenBalance: '0', allowance: '0', fees: [], requestStartedAt: 1, expiresAt: 2 }
  const steps = []
  if (approve) steps.push({ index: 0, kind: 'approve', to: intent.inputToken, token: intent.inputToken, amount: intent.amountIn.toString(), spender: ADAPTER, dataHash: keccak256(d.encodeApprove(ADAPTER, intent.amountIn)), nonce: entry.tx.nonce - 1, status: 'pending', at: 1, hash: '0x' + 'a9'.repeat(32) })
  steps.push({ index: steps.length, kind: 'swap', to: ADAPTER, token: intent.inputToken, amount: intent.amountIn.toString(), minimumOut: intent.minimumOut.toString(), deadline: Number(call.deadline), dataHash: over.dataHash ?? keccak256(entry.v.tx.input), nonce: over.nonce ?? entry.tx.nonce, status: 'pending', at: 2, hash: entry.hash })
  return { id: '00000000-0000-4000-8000-000000000001', review, status: 'pending', createdAt: 1, steps, hash: entry.hash }
}
const approveFixtures = entry => ({
  approveTx: hash => ({ hash, from: entry.tx.from, to: entry.intent.inputToken, chainId: 5042, nonce: entry.tx.nonce - 1, type: 'eip1559', value: 0n, gas: 60000n, input: d.encodeApprove(ADAPTER, entry.intent.amountIn) }),
  approveReceipt: hash => ({ transactionHash: hash, from: entry.tx.from, to: entry.intent.inputToken, status: 'success', blockNumber: entry.receipt.blockNumber - 1n, blockHash: '0x' + '77'.repeat(32), transactionIndex: 0, gasUsed: 46000n, effectiveGasPrice: 21_000_000_000n,
    logs: [{ address: entry.intent.inputToken, topics: ['0x8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925', '0x' + '0'.repeat(24) + entry.tx.from.slice(2).toLowerCase(), '0x' + '0'.repeat(24) + ADAPTER.slice(2).toLowerCase()], data: '0x' + entry.intent.amountIn.toString(16).padStart(64, '0'), logIndex: 0, removed: false, transactionHash: hash, blockHash: '0x' + '77'.repeat(32), blockNumber: entry.receipt.blockNumber - 1n, transactionIndex: 0 }] }),
})
const verifyEntry = async (entry, over = {}, rpcOver = {}) => {
  const rpc = c.createCircleChainRpc({ ...fakeRpc(entry, { ...approveFixtures(entry), ...rpcOver }) }, () => 1234), attempt = attemptFor(entry, over)
  return { result: await rpc.result(attempt), attempt, rpc }
}
const ids = report => Object.fromEntries(report.intent.checks.map(item => [item.id, item.status]))
await test('Circle checks submitted bytes, target, value and identity before receipt availability; bounded wallet gas adjustments are allowed', async () => {
  const entry = realSwaps[0]
  for (const delta of [{}, { gas: entry.tx.gas - 1n }, { input: '0x12345678' }, { to: other }, { value: 1n }, { from: other }, { nonce: entry.tx.nonce + 1 }, { chainId: 1 }]) {
    let observed
    const rpc = c.createCircleChainRpc(fakeRpc(entry, { ...approveFixtures(entry), noReceipt: true, mutateTx: tx => ({ ...tx, ...delta }) }), () => 1)
    const run = rpc.result(attemptFor(entry), report => { observed = report })
    if ('from' in delta || 'nonce' in delta || 'chainId' in delta) await assert.rejects(run, error => error.reason === 'binding')
    else assert.equal((await run).status, 'pending')
    assert.equal(observed.verdict, ['from', 'nonce', 'chainId'].some(k => k in delta) ? 'unbound' : ['input', 'to', 'value'].some(k => k in delta) ? 'mismatch' : 'incomplete')
    if ('gas' in delta) assert.equal(observed.checks.find(c => c.id === 'fee-fields').status, 'allowed')
  }
})
await test('Circle missing hashes and RPC read failures cause no false integrity alert; receipt outages retain the submitted comparison', async () => {
  const entry = realSwaps[0]
  for (const over of [{ noTx: true }, { rpcError: 'getTransaction' }]) {
    let observed = 0
    const rpc = c.createCircleChainRpc(fakeRpc(entry, { ...approveFixtures(entry), ...over }), () => 1)
    try { await rpc.result(attemptFor(entry), () => { observed++ }) } catch (error) { assert.equal(error.reason, 'rpc') }
    assert.equal(observed, 0)
  }
  let observed
  const rpc = c.createCircleChainRpc(fakeRpc(entry, { ...approveFixtures(entry), rpcError: 'getTransactionReceipt', mutateTx: tx => ({ ...tx, to: other }) }), () => 1)
  await assert.rejects(rpc.result(attemptFor(entry), report => { observed = report }), error => error.reason === 'rpc')
  assert.equal(observed.verdict, 'mismatch')
})
await test('Circle exposes a calldata warning while the receipt request is still waiting', async () => {
  const entry = realSwaps[0], rpc = fakeRpc(entry, { ...approveFixtures(entry), mutateTx: tx => ({ ...tx, input: '0x12345678' }) })
  let release, observed, finished = false
  const getReceipt = rpc.getTransactionReceipt
  rpc.getTransactionReceipt = args => args.hash === entry.hash ? new Promise(resolve => { release = () => resolve(getReceipt(args)) }) : getReceipt(args)
  const pending = c.createCircleChainRpc(rpc, () => 1).result(attemptFor(entry), report => { observed = report }).then(result => { finished = true; return result })
  await waitFor(() => release !== undefined)
  assert.equal(observed.verdict, 'mismatch'); assert.equal(finished, false)
  release(); const result = await pending
  assert.equal(result.status, 'settled'); assert.equal(result.chain.state, 'success'); assert.equal(result.intent.verdict, 'mismatch')
})
await test('Circle cannot persist a supplied recovery hash on an early unbound comparison', async () => {
  const f = setup({ tokenIn: 'USDC', tokenOut: 'EURC' })
  f.world.wallet = () => { throw Error('submission unknown') }
  await f.run(await f.review())
  f.ports.result = async (_attempt, submitted) => {
    submitted?.({ verdict: 'unbound', checks: [], differences: ['Different sender.'], checkedAt: 1 })
    throw new x.ExecutionVerificationError('binding', false)
  }
  await f.controller.reconcile(owner, '0x' + 'd1'.repeat(32))
  assert.equal(f.records()[0].hash, undefined); assert.equal(f.records()[0].intent, undefined)
})
await test('Circle early warnings persist across read failures and reload without resubmission; final settlement still owns the verdict', async () => {
  const warning = { verdict: 'mismatch', checks: [{ id: 'calldata-binding', status: 'mismatch', detail: 'Different calldata.' }], differences: ['Different calldata.'], checkedAt: 1 }
  const f = setup(), originalResult = f.ports.result
  f.ports.result = async (_attempt, submitted) => { submitted?.(warning); throw new x.ExecutionVerificationError('rpc', true) }
  await f.run(await f.review())
  assert.equal(f.controller.current().attempt.intent.verdict, 'mismatch')
  assert.equal(f.controller.current().phase, 'pending')
  const reload = setup({ data: f.data }); assert.equal(reload.records()[0].intent.verdict, 'mismatch')
  await reload.controller.prepare(); assert.equal(reload.world.issued.size, 0)
  f.ports.result = originalResult; f.world.results.set(f.controller.current().attempt.hash, 'settle')
  await f.controller.reconcile(); assert.equal(f.controller.current().phase, 'confirmed')
})
await test('real swaps, verified from the chain: every one of the 8 is Confirmed-grade (verified with notes: the wallet chose the gas fields), with the real received amount and the real fee', async () => {
  for (const entry of realSwaps) {
    const { result } = await verifyEntry(entry), label = `${entry.tokenIn}>${entry.tokenOut}`
    assert.equal(result.status, 'settled', label); assert.equal(result.chain.state, 'success'); assert.equal(result.intent.verdict, 'verified_with_notes', `${label}: ${result.intent.differences}`)
    assert.deepEqual(Object.values(ids(result)).filter(s => s === 'mismatch' || s === 'unavailable'), [], label); assert.equal(ids(result)['fee-fields'], 'allowed'); assert.equal(ids(result)['calldata-binding'], 'match'); assert.equal(ids(result)['calldata-policy'], 'match')
    const flows = ev.ownerFlows(chainReceiptOf(entry.receipt), entry.tx.from, [entry.intent.outputToken]); const received = flows.flows.get(entry.intent.outputToken.toLowerCase()).net
    assert.equal(result.chain.received, received.toString()); assert.equal(result.output, received.toString()); assert.ok(received >= entry.intent.minimumOut, label)
    const swapFee = feeOfReal(entry); assert.equal(result.chain.fee, swapFee.toString()); assert.equal(result.fee, (swapFee + (entry.intent.strategy === 'approve' ? 46000n * 21_000_000_000n : 0n)).toString())
    assert.equal(result.approvals.length, entry.intent.strategy === 'approve' ? 1 : 0)
  }
})
await test('when the application journaled its own gas fields and the wallet kept them, the gas check is an exact match: Verified', async () => {
  const entry = realSwaps[0], attempt = attemptFor(entry); attempt.steps.at(-1).gasLimit = entry.tx.gas.toString(); attempt.steps.at(-1).maxFee = entry.tx.maxFeePerGas.toString(); attempt.steps.at(-1).maxTip = entry.tx.maxPriorityFeePerGas.toString()
  const rpc = c.createCircleChainRpc(fakeRpc(entry, approveFixtures(entry)), () => 1), result = await rpc.result(attempt)
  assert.equal(ids(result)['fee-fields'], 'match'); assert.equal(result.intent.verdict, 'verified')
  attempt.steps.at(-1).gasLimit = (entry.tx.gas - 1n).toString(); assert.equal(ids(await rpc.result(attempt))['fee-fields'], 'allowed')
})
await test('verification never confirms what it cannot prove: reviewed minimum above the result, other calldata, other nonce, tighter fee ceiling, wrong adapter or type each produce their own finding', async () => {
  const entry = realSwaps.find(s => s.tokenIn === 'EURC' && s.call.instructions.length === 2)
  const received = ev.ownerFlows(chainReceiptOf(entry.receipt), entry.tx.from, [entry.intent.outputToken]).flows.get(entry.intent.outputToken.toLowerCase()).net
  let r = await verifyEntry(entry, { }, {}); assert.equal(r.result.intent.verdict, 'verified_with_notes')
  const lifted = attemptFor(entry); lifted.review.requiredMinimum = (received + 1n).toString(); lifted.review.estimatedOutput = (received * 2n).toString()
  r = { result: await c.createCircleChainRpc(fakeRpc(entry, approveFixtures(entry)), () => 1).result(lifted) }; assert.equal(r.result.intent.verdict, 'mismatch'); assert.equal(ids(r.result).minimum, 'mismatch'); assert.equal(ids(r.result)['calldata-policy'], 'mismatch')
  r = await verifyEntry(entry, { dataHash: '0x' + '12'.repeat(32) }); assert.equal(r.result.intent.verdict, 'mismatch'); assert.equal(ids(r.result)['calldata-binding'], 'mismatch'); assert.match(r.result.intent.differences.join(' '), /different calldata/)
  r = await verifyEntry(entry, { ceiling: 10n ** 15n }); assert.equal(r.result.intent.verdict, 'mismatch'); assert.equal(ids(r.result)['fee-fields'], 'mismatch'); assert.equal(ids(r.result)['fee-actual'], 'mismatch')
  r = await verifyEntry(entry, {}, { mutateTx: tx => ({ ...tx, to: other }) }); assert.equal(r.result.intent.verdict, 'mismatch'); assert.equal(ids(r.result).adapter, 'mismatch')
  r = await verifyEntry(entry, {}, { mutateTx: tx => ({ ...tx, value: 1n }) }); assert.equal(ids(r.result).value, 'mismatch'); assert.equal(r.result.intent.verdict, 'mismatch')
  r = await verifyEntry(entry, {}, { mutateTx: tx => ({ ...tx, type: 'legacy' }) }); assert.equal(ids(r.result).type, 'mismatch')
  r = await verifyEntry(entry, {}, { mutateTx: tx => ({ ...tx, gas: entry.receipt.gasUsed - 1n }) }); assert.equal(ids(r.result)['fee-fields'], 'mismatch'); assert.equal(ids(r.result)['receipt-consistency'], 'mismatch') // limit below what was used: inconsistent evidence
  r = await verifyEntry(entry, {}, { timestamp: BigInt(entry.blockTime + 10_000) }); assert.equal(ids(r.result)['calldata-policy'], 'mismatch') // included after its own deadline
  r = await verifyEntry(entry, {}, { timestamp: null }); assert.equal(r.result.intent.verdict, 'incomplete'); assert.equal(ids(r.result)['calldata-policy'], 'unavailable')
  for (const over of [{ nonce: entry.tx.nonce + 1 }]) await assert.rejects(verifyEntry(entry, over), error => error instanceof x.ExecutionVerificationError && error.retryable === false)
  await assert.rejects(verifyEntry(entry, {}, { mutateTx: tx => ({ ...tx, from: other }) }), error => error instanceof x.ExecutionVerificationError && error.retryable === false)
  await assert.rejects(verifyEntry(entry, {}, { mutateTx: tx => ({ ...tx, hash: '0x' + '55'.repeat(32) }) }), error => error instanceof x.ExecutionVerificationError && error.retryable === false)
  await assert.rejects(verifyEntry(entry, {}, { mutateTx: tx => ({ ...tx, chainId: 1 }) }), error => error instanceof x.ExecutionVerificationError && error.retryable === false)
})
await test('verification: a received amount below the reviewed minimum is a Mismatch even when the calldata promised more; leftover input and refunds are counted from the receipt', async () => {
  const entry = realSwaps.find(s => s.tokenIn === 'USDC' && s.tokenOut === 'EURC')
  const low = c.createCircleChainRpc(fakeRpc(entry, { ...approveFixtures(entry), mutateReceipt: r => ({ ...r, logs: r.logs.filter(l => !(l.address.toLowerCase() === entry.intent.outputToken.toLowerCase() && l.topics[2].slice(-40).toLowerCase() === entry.tx.from.slice(2).toLowerCase())) }) }), () => 1)
  const attempt = attemptFor(entry), result = await low.result(attempt)
  assert.equal(result.intent.verdict, 'mismatch'); assert.equal(ids(result).minimum, 'mismatch'); assert.equal(result.chain.state, 'success'); assert.equal(result.output, '0'); assert.equal(result.chain.received, '0')
})
await test('verification: reverted is Failed on chain and judged separately; pending, unknown hash, other block, shallow depth and RPC trouble are never failure', async () => {
  const entry = realSwaps[1]
  const reverted = await verifyEntry(entry, {}, { mutateReceipt: r => ({ ...r, status: 'reverted', logs: [] }) }); assert.equal(reverted.result.chain.state, 'reverted'); assert.equal(ids(reverted.result).minimum, 'match'); assert.equal(reverted.result.output, '0')
  assert.equal((await verifyEntry(entry, {}, { noTx: true })).result.status, 'pending'); assert.equal((await verifyEntry(entry, {}, { noReceipt: true })).result.status, 'pending')
  assert.equal((await verifyEntry(entry, {}, { blockHash: '0x' + '99'.repeat(32) })).result.status, 'pending'); assert.equal((await verifyEntry(entry, {}, { latest: entry.receipt.blockNumber })).result.status, 'pending')
  for (const key of ['getTransaction', 'getTransactionReceipt', 'getBlock', 'getBlockNumber', 'getChainId']) await assert.rejects(verifyEntry(entry, {}, { rpcError: key }), error => error instanceof x.ExecutionVerificationError && error.retryable === true, key)
  await assert.rejects(verifyEntry(entry, {}, { chainId: 1 }), error => error instanceof x.ExecutionVerificationError && error.retryable === true)
  await assert.rejects(verifyEntry(entry, {}, { mutateReceipt: r => ({ ...r, gasUsed: 0n }) }), error => error instanceof x.ExecutionVerificationError)
  const rpc = c.createCircleChainRpc(fakeRpc(entry, approveFixtures(entry)), () => 1)
  for (const broken of [{ ...attemptFor(entry), hash: undefined }, { ...attemptFor(entry), hash: 'nope' }, { ...attemptFor(entry), steps: attemptFor(entry).steps.filter(s => s.kind !== 'swap') }]) await assert.rejects(rpc.result(broken), error => error instanceof x.ExecutionVerificationError && error.retryable === false)
})
await test('approval verification: only the journaled approval counts, proven by the token Approval event or the allowance at its block', async () => {
  const entry = realSwaps.find(s => s.tokenIn === 'EURC' && s.call.instructions.length === 2), fx = approveFixtures(entry), attempt = attemptFor(entry), step = attempt.steps[0]
  const run = (over = {}) => c.createCircleChainRpc(fakeRpc(entry, { ...fx, ...over }), () => 1).approval(attempt, step)
  assert.deepEqual(await run(), { status: 'confirmed', fee: (46000n * 21_000_000_000n).toString() })
  // event missing: the allowance at the receipt's block decides
  const noEvent = { approveReceipt: hash => ({ ...fx.approveReceipt(hash), logs: [] }) }
  assert.equal((await run({ ...noEvent, allowance: entry.intent.amountIn })).status, 'confirmed'); assert.equal((await run({ ...noEvent, allowance: entry.intent.amountIn - 1n })).status, 'failed')
  // event for another spender / amount does not count
  const wrongEvent = { approveReceipt: hash => { const r = fx.approveReceipt(hash); r.logs[0].topics[2] = '0x' + '0'.repeat(24) + other.slice(2); return r } }; assert.equal((await run({ ...wrongEvent, allowance: 0n })).status, 'failed')
  assert.equal((await run({ approveReceipt: hash => ({ ...fx.approveReceipt(hash), status: 'reverted', logs: [] }) })).status, 'failed')
  assert.equal((await run({ approveTx: () => { const error = new Error('x'); error.name = 'TransactionNotFoundError'; throw error } })).status, 'pending')
  await assert.rejects(run({ approveTx: hash => ({ ...fx.approveTx(hash), from: other }) }), error => error.retryable === false)
  await assert.rejects(run({ approveTx: hash => ({ ...fx.approveTx(hash), input: d.encodeApprove(ADAPTER, 2n ** 256n - 1n) }) }), error => error.retryable === false) // not the calldata that was journaled
  await assert.rejects(run({ approveTx: hash => ({ ...fx.approveTx(hash), to: other }) }), error => error.retryable === false)
  await assert.rejects(run({ approveTx: hash => ({ ...fx.approveTx(hash), nonce: 99 }) }), error => error.retryable === false)
  await assert.rejects(c.createCircleChainRpc(fakeRpc(entry, fx), () => 1).approval(attempt, { ...step, kind: 'swap' }), error => error.retryable === false)
})
await test('preflight facts: balances, allowance, adapter identity, token decimals, fee caps, EOA and network are evaluated by the application, from reads only', async () => {
  const review = await (async () => { const f = setup(); return f.ports.fresh(f.input()) })(), good = { chainId: 5042, blockNumber: 1n, blockTimestamp: 1n, walletCode: '0x', adapterCodeHash: d.CIRCLE_ADAPTER_CODEHASH, adapterImplementation: d.CIRCLE_ADAPTER_IMPLEMENTATION, implementationCodeHash: d.CIRCLE_ADAPTER_IMPLEMENTATION_CODEHASH, tokenCodesPresent: true, tokenInDecimals: 6, tokenOutDecimals: 6,
    tokenBalance: BigInt(review.tokenBalance), nativeBalance: BigInt(review.nativeBalance), allowance: 0n, gasPrice: gwei(21), baseFee: gwei(20) }
  assert.doesNotThrow(() => c.evaluatePreflight(review, good))
  for (const [name, over, code] of [['network', { chainId: 1 }, /preflight/], ['contract wallet', { walletCode: '0xef0100' + 'aa'.repeat(20) }, /smart_wallet/], ['adapter replaced', { adapterCodeHash: '0x' + '11'.repeat(32) }, /adapter_identity/], ['adapter missing', { adapterCodeHash: null }, /adapter_identity/],
    ['implementation upgraded', { adapterImplementation: '0x' + '22'.repeat(20) }, /adapter_identity/], ['implementation code replaced', { implementationCodeHash: '0x' + '33'.repeat(32) }, /adapter_identity/], ['implementation unreadable', { adapterImplementation: null }, /adapter_identity/], ['implementation code missing', { implementationCodeHash: null }, /adapter_identity/],
    ['no token code', { tokenCodesPresent: false }, /preflight/], ['decimals', { tokenInDecimals: 18 }, /preflight/], ['token balance', { tokenBalance: 1n }, /insufficient_input_balance/], ['gas balance', { nativeBalance: 1n }, /insufficient_gas/],
    ['gas price above the cap', { gasPrice: gwei(31) }, /preflight/], ['base fee above the cap', { baseFee: gwei(31) }, /preflight/], ['no gas price', { gasPrice: 0n }, /preflight/]]) assert.throws(() => c.evaluatePreflight(review, { ...good, ...over }), code, name)
  assert.throws(() => c.evaluatePreflight(review, { ...good, nativeBalance: 10n ** 16n }, 5n * 10n ** 16n), /insufficient_gas/); assert.doesNotThrow(() => c.evaluatePreflight(review, { ...good, nativeBalance: 10n ** 16n }, 10n ** 16n))
  // the real read path
  const calls = [], rpc = { getChainId: async () => 5042, getBlockNumber: async () => 10n, getBlock: async () => ({ timestamp: 99n, baseFeePerGas: gwei(20) }), getGasPrice: async () => gwei(21), getBalance: async () => 7n,
    getStorageAt: async ({ address, slot }) => { assert.equal(address, ADAPTER); assert.equal(slot, d.CIRCLE_ADAPTER_IMPLEMENTATION_SLOT); return '0x' + '00'.repeat(12) + d.CIRCLE_ADAPTER_IMPLEMENTATION.slice(2) },
    getCode: async ({ address }) => (address === ADAPTER ? '0x6080' : address.toLowerCase() === d.CIRCLE_ADAPTER_IMPLEMENTATION ? '0x6081' : address === owner ? '0x' : '0x60'), readContract: async ({ functionName }) => { calls.push(functionName); return functionName === 'decimals' ? 6 : 5n } }
  const facts = await c.createCircleChainRpc(rpc, () => 1).preflight(review); assert.equal(facts.adapterCodeHash, keccak256('0x6080')); assert.equal(facts.adapterImplementation, d.CIRCLE_ADAPTER_IMPLEMENTATION); assert.equal(facts.implementationCodeHash, keccak256('0x6081')); assert.equal(facts.tokenBalance, 5n); assert.equal(facts.allowance, 5n); assert.equal(facts.nativeBalance, 7n); assert.equal(facts.walletCode, '0x'); assert.equal(facts.tokenCodesPresent, true)
  assert.deepEqual([...new Set(calls)].sort(), ['allowance', 'balanceOf', 'decimals'])
  assert.deepEqual(await c.createCircleChainRpc({ getTransactionCount: async ({ blockTag }) => (blockTag === 'pending' ? 9 : 8) }, () => 1).publicNonce(owner), { nonce: 9, latestNonce: 8 })
  await assert.rejects(c.createCircleChainRpc({ getTransactionCount: async ({ blockTag }) => (blockTag === 'pending' ? 7 : 8) }, () => 1).publicNonce(owner), error => error instanceof x.ExecutionNonceObservationError)
  await assert.rejects(c.createCircleChainRpc({ getTransactionCount: async () => { throw Error('x') } }, () => 1).publicNonce(owner), /public_nonce/)
  assert.equal(await c.createCircleChainRpc({ estimateGas: async args => { assert.equal(args.account, owner); assert.equal(args.value, 0n); return 123n } }, () => 1).estimateGas({ from: owner, to: ADAPTER, data: '0x', value: 0n }), 123n)
})
// =============================================================================================================================
// F. Findings of the adversarial review: guard invariants, recovery, stalled flows, lock-outs
// =============================================================================================================================
const typedData = (f, over = {}) => ({ account: f.wallet.account, domain: { name: 'USDC', version: '2', chainId: 5042, verifyingContract: f.policy.inputToken }, types: { Permit: d.PERMIT_TYPES }, primaryType: 'Permit',
  message: { owner, spender: ADAPTER, value: 1_000_000n, nonce: 0n, deadline: BigInt(Math.floor(NOW_MS / 1000) + 3600), ...over } })
const permitPolicy = { strategy: 'permit', inputToken: T('USDC').address, outputToken: T('EURC').address }
await test('guard: the counters it hands out are a snapshot, so resetting them cannot allow a second approval', async () => {
  const f = guardFixture(); await f.wallet.sendTransaction(f.approve())
  const snapshot = f.wallet.sent; assert.equal(Object.isFrozen(snapshot), true)
  try { snapshot.approve = 0 } catch { /* frozen */ }
  assert.deepEqual(f.wallet.sent, { approve: 1, swap: 0, permit: 0 })
  await refused(f.wallet.sendTransaction(f.approve()), 'duplicate_send'); assert.equal(f.w.calls.length, 1)
})
await test('guard: a request parked at the user gate when the session is sealed never reaches the wallet', async () => {
  let release; const f = guardFixture({ hooks: { gate: () => new Promise(resolve => { release = resolve }) } })
  const parked = f.wallet.sendTransaction(f.approve()); await waitFor(() => release); f.wallet.seal(); release()
  await refused(parked, 'sealed'); assert.equal(f.w.calls.length, 0); assert.ok(f.log.some(entry => entry[0] === 'failed'))
  let releaseSign; const g2 = guardFixture({ policy: permitPolicy, hooks: { gate: () => new Promise(resolve => { releaseSign = resolve }) } })
  const parkedSign = g2.wallet.signTypedData(typedData(g2)); await waitFor(() => releaseSign); g2.wallet.seal(); releaseSign()
  await refused(parkedSign, 'sealed'); assert.equal(g2.w.calls.length, 0)
})
await test('guard: a swap whose deadline runs out while it waits at the gate, and a permit that expires there, are refused', async () => {
  const f = guardFixture({ hooks: { gate: step => { if (step.kind === 'swap') f.clock.ms += 570_000 } } })
  await f.wallet.sendTransaction(f.approve()); await refused(f.wallet.sendTransaction(f.swap()), 'swap_calldata'); assert.equal(f.w.calls.length, 1)
  const g2 = guardFixture({ policy: permitPolicy, hooks: { gate: () => { g2.clock.ms += 4_000_000 } } })
  await refused(g2.wallet.signTypedData(typedData(g2, { deadline: BigInt(Math.floor(NOW_MS / 1000) + 3600) })), 'typed_data'); assert.equal(g2.w.calls.length, 0)
  // a swap with less than the time a wallet confirmation and inclusion need is not sent at all
  const near = guardFixture(); near.clock.ms += 560_000
  await near.wallet.sendTransaction(near.approve()); await refused(near.wallet.sendTransaction(near.swap()), 'swap_calldata')
})
await test('guard: what the wallet is asked is rebuilt from values the guard checked; changing the SDK objects while the gate is open changes nothing', async () => {
  const f = guardFixture({ hooks: { gate: () => { p.account = { address: other, type: 'json-rpc' }; p.chain = { id: 1 }; p.to = other; p.data = '0x' } } }), p = f.approve()
  await f.wallet.sendTransaction(p); const sent = f.w.calls[0][1]
  assert.equal(sent.account, owner); assert.equal(sent.to, f.policy.inputToken); assert.equal(sent.chain, undefined); assert.equal(sent.data, d.encodeApprove(ADAPTER, 1_000_000n))
  const g2 = guardFixture({ policy: permitPolicy, hooks: { gate: () => { typed.message.value = 10n ** 30n; typed.message.spender = other; typed.message.owner = other; typed.domain.name = 'X'; typed.domain.verifyingContract = other; typed.types.Permit = [] } } }), typed = typedData(g2)
  await g2.wallet.signTypedData(typed); const signed = g2.w.calls[0][1]
  assert.equal(signed.message.value, 1_000_000n); assert.equal(signed.message.spender, ADAPTER); assert.equal(signed.message.owner, owner); assert.equal(signed.domain.name, 'USDC'); assert.equal(signed.domain.verifyingContract, permitPolicy.inputToken)
  assert.deepEqual(Object.keys(signed.types), ['Permit']); assert.deepEqual(signed.types.Permit.map(field => field.name), ['owner', 'spender', 'value', 'nonce', 'deadline']); assert.equal(signed.account, owner)
})
await test('guard: a domain type that is not the four standard fields is refused; the standard one is accepted and not forwarded', async () => {
  const short = guardFixture({ policy: permitPolicy }); const partial = typedData(short); partial.types = { EIP712Domain: [{ name: 'name', type: 'string' }, { name: 'version', type: 'string' }], Permit: d.PERMIT_TYPES }
  await refused(short.wallet.signTypedData(partial), 'typed_data'); assert.equal(short.w.calls.length, 0)
  const full = guardFixture({ policy: permitPolicy }); const standard = typedData(full); standard.types = { EIP712Domain: [{ name: 'name', type: 'string' }, { name: 'version', type: 'string' }, { name: 'chainId', type: 'uint256' }, { name: 'verifyingContract', type: 'address' }], Permit: d.PERMIT_TYPES }
  await full.wallet.signTypedData(standard); assert.deepEqual(Object.keys(full.w.calls[0][1].types), ['Permit'])
  const bad = guardFixture({ policy: permitPolicy }); await refused(bad.wallet.signTypedData(typedData(bad, { nonce: 'x' })), 'typed_data')
})
await test('the wallet below the guard is reachable through four requests only and viem never retries or falls back to another method name', async () => {
  const w = require(`${root}src/lib/swap/circleWallet.ts`); assert.deepEqual([...w.CIRCLE_WALLET_METHODS], ['eth_chainId', 'eth_accounts', 'eth_sendTransaction', 'eth_signTypedData_v4'])
  const seen = []; const provider = { request: async ({ method }) => { seen.push(method); if (method === 'eth_chainId') return '0x13b2'; throw Object.assign(new Error('invalid params'), { code: -32602 }) } }
  const inner = w.viemInnerWallet(provider, owner)
  await assert.rejects(inner.sendTransaction({ account: owner, to: ADAPTER, data: '0x', value: 0n, gas: 100_000n, nonce: 1, type: 'eip1559', maxFeePerGas: gwei(30), maxPriorityFeePerGas: gwei(1) }))
  assert.equal(seen.filter(method => method === 'eth_sendTransaction').length, 1); assert.ok(!seen.includes('wallet_sendTransaction'), seen.join()); assert.ok(seen.every(method => w.CIRCLE_WALLET_METHODS.includes(method)))
  // the success paths: exactly the requests the guard allows, with the values the guard passed, and nothing else
  const calls = []; const ok = w.viemInnerWallet({ request: async ({ method, params }) => { calls.push([method, params]); if (method === 'eth_chainId') return '0x13b2'; if (method === 'eth_accounts') return [owner]
    if (method === 'eth_sendTransaction') return '0x' + 'ab'.repeat(32); if (method === 'eth_signTypedData_v4') return '0x' + '11'.repeat(32) + '22'.repeat(32) + '1b'; throw Object.assign(new Error('unexpected'), { code: -32601 }) } }, owner)
  const hash = await ok.sendTransaction({ account: owner, to: ADAPTER, data: d.encodeApprove(ADAPTER, 1n), value: 0n, gas: 100_000n, nonce: 9, type: 'eip1559', maxFeePerGas: gwei(30), maxPriorityFeePerGas: gwei(1) })
  assert.equal(hash, '0x' + 'ab'.repeat(32)); const sentParams = calls.find(([method]) => method === 'eth_sendTransaction')[1][0]
  assert.equal(sentParams.from.toLowerCase(), owner.toLowerCase()); assert.equal(sentParams.nonce, '0x9'); assert.equal(sentParams.gas, '0x186a0'); assert.equal(sentParams.type, '0x2'); assert.ok(calls.some(([method]) => method === 'eth_chainId')) // viem asked the wallet which network it is on before sending
  const signature = await ok.signTypedData({ account: owner, primaryType: 'Permit', domain: { name: 'USDC', version: '2', chainId: 5042, verifyingContract: T('USDC').address }, types: { Permit: d.PERMIT_TYPES }, message: { owner, spender: ADAPTER, value: 1n, nonce: 0n, deadline: 2n ** 40n } })
  assert.match(signature, /^0x[0-9a-f]{130}$/); assert.ok(calls.every(([method]) => w.CIRCLE_WALLET_METHODS.includes(method)), calls.map(c => c[0]).join())
  await assert.rejects(ok.getChainId().then(() => provider.request({ method: 'personal_sign' }).catch(() => { throw Error('expected') })))
})
await test('a flow that is closed before its first wallet request leaves a record that proves nothing was sent: it is closed on reload, not left as a lock-out', async () => {
  const locks = new Set(), f = setup({ locks }), id = await f.review(); const running = f.controller.confirm(id)
  await waitFor(() => f.controller.current().phase === 'awaiting_step')
  const frozen = new Map(f.data); const record = JSON.parse(frozen.get(f.storageKey))[0]
  assert.equal(record.status, 'awaiting_wallet'); assert.equal(record.steps.length, 0); assert.equal(f.world.sends.length, 0) // the state the page died in
  // another tab cannot touch it while the flow is running: the lock is held
  const sibling = setup({ data: f.data, locks }); await sibling.controller.reconcile(owner); assert.equal(JSON.parse(f.data.get(f.storageKey))[0].status, 'awaiting_wallet')
  f.controller.cancelStep(); await running
  // a fresh page over the zombie
  const reload = setup({ data: frozen }); await reload.controller.prepare(); assert.match(reload.controller.current().error, /unresolved/) // before it is reconciled it still blocks
  await reload.controller.reconcile(owner); const after = reload.controller.current()
  assert.equal(after.phase, 'rejected'); assert.match(after.error, /closed, or the flow stopped, before any wallet transaction/); assert.equal(JSON.parse(frozen.get(f.storageKey))[0].status, 'rejected')
  assert.ok(JSON.parse(frozen.get(f.storageKey))[0].log.at(-1).note.includes('Nothing was sent')); assert.equal(reload.world.sends.length, 0)
  await reload.controller.prepare(); assert.equal(reload.controller.current().phase, 'review', reload.controller.current().error)
  // a record WITH a wallet request open is never closed that way
  const g2 = setup(); let release; g2.world.wallet = () => new Promise(resolve => { release = resolve }); const id2 = await g2.review(), run2 = g2.controller.confirm(id2)
  await waitFor(() => g2.controller.current().phase === 'awaiting_step'); g2.controller.continueStep(); await waitFor(() => g2.controller.current().phase === 'awaiting_wallet')
  const reopened = setup({ data: new Map(g2.data) }); await reopened.controller.reconcile(owner); assert.equal(reopened.controller.current().phase, 'unknown'); assert.equal(JSON.parse(reopened.data.get(reopened.storageKey))[0].status, 'awaiting_wallet')
  release('0x' + 'a1'.repeat(32)); g2.world.approvals.set('0x' + 'a1'.repeat(32), { status: 'confirmed', fee: '1' }); g2.world.latest++; g2.world.pending++; await waitFor(() => g2.controller.current().phase === 'awaiting_step'); g2.controller.cancelStep(); await run2
})
await test('a permit signature that fails for any reason moves no funds and never locks the wallet; a rejection is still a rejection', async () => {
  for (const [error, text] of [[Object.assign(Error('method not supported'), { code: 4200 }), /signature request did not complete/], [Object.assign(Error('internal'), { code: -32603 }), /signature request did not complete/], [Error('Request expired'), /signature request did not complete/], [Object.assign(Error('denied'), { code: 4001 }), /rejected the wallet request/]]) {
    const f = setup({ tokenIn: 'USDC', tokenOut: 'EURC' }); f.world.signError = error; const id = await f.review(); await f.run(id)
    assert.equal(f.controller.current().phase, 'rejected'); assert.match(f.controller.current().error, text); assert.equal(f.records()[0].status, 'rejected'); assert.equal(f.world.sends.length, 0); assert.equal(f.controller.blocking(owner), false)
    f.world.signError = undefined; await f.controller.prepare(); assert.equal(f.controller.current().phase, 'review', f.controller.current().error)
  }
})
await test('a swap hash the wallet returned but the journal could not record is not lost: it is tracked from memory and written again with the result', async () => {
  let failed = false; const f = setup({ autoSettle: true }); f.world.storageFail = (_n, _k, value) => { const last = JSON.parse(value).at(-1); if (!failed && last?.steps?.some(step => step.kind === 'swap' && step.hash)) { failed = true; throw Error('quota') } }
  const id = await f.review(); await f.run(id)
  const view = f.controller.current(); assert.equal(failed, true); assert.equal(view.phase, 'confirmed', view.error); assert.ok(view.attempt.hash); assert.ok(f.world.resultCalls >= 1)
  assert.equal(f.records()[0].status, 'confirmed'); assert.equal(f.records()[0].hash, view.attempt.hash)
})
await test('recovery: a hash the network does not know is never saved; the real hash can still be supplied afterwards', async () => {
  const wrong = '0x' + 'bb'.repeat(32), real = '0x' + 'cc'.repeat(32)
  const f = setup({ tokenIn: 'USDC', tokenOut: 'EURC', result: async attempt => (attempt.hash === real ? { status: 'pending', identified: true } : { status: 'pending', identified: false }) })
  f.world.wallet = () => Promise.reject(Object.assign(new Error('internal'), { code: -32603 })); const id = await f.review(); await f.run(id)
  assert.equal(f.controller.current().phase, 'unknown'); assert.equal(f.records()[0].hash, undefined)
  await f.controller.reconcile(owner, wrong); assert.match(f.controller.current().error, /does not know that hash/); assert.equal(f.records()[0].hash, undefined); assert.equal(f.controller.blocking(owner), true); assert.equal(f.controller.current().phase, 'unknown')
  await f.controller.reconcile(owner, real); assert.equal(f.records()[0].hash, real); assert.equal(f.controller.current().phase, 'pending'); assert.equal(f.records()[0].steps.find(step => step.kind === 'swap').hash, real)
})
await test('replaced transaction: only a hash whose nonce was provably used by something else can take over, and it is verified like any other', async () => {
  const first = '0x' + 'a2'.repeat(32), second = '0x' + 'd2'.repeat(32)
  const make = nonceUsed => {
    const f = setup({ tokenIn: 'USDC', tokenOut: 'EURC', autoSettle: false, result: async attempt => {
      if (attempt.hash === second) return f.settleResult(attempt)
      return { status: 'pending', identified: false, ...(nonceUsed === undefined ? {} : { nonceUsed }) } } })
    f.settleResult = attempt => ({ status: 'settled', output: attempt.review.requiredMinimum, fee: '12000000000000000', approvals: [], chain: { state: 'success', blockNumber: '100', blockHash: '0x' + '11'.repeat(32), gasUsed: '500000', effectiveGasPrice: '21000000000', fee: '11000000000000000', received: attempt.review.requiredMinimum, sent: attempt.review.amountIn, checkedAt: Date.now() }, intent: { verdict: 'verified_with_notes', checks: [], differences: [], checkedAt: Date.now() } })
    return f
  }
  const unproven = make(false); { const id = await unproven.review(); await unproven.run(id) }
  const hash = unproven.controller.current().attempt.hash; await unproven.controller.reconcile(owner); assert.equal(unproven.controller.current().replaced, undefined); assert.equal(unproven.controller.current().phase, 'pending')
  await unproven.controller.reconcile(owner, second); assert.match(unproven.controller.current().error, /does not identify/); assert.equal(unproven.records()[0].hash, hash) // nonce not used: nothing else can take over
  const unreadable = make(undefined); { const id = await unreadable.review(); await unreadable.run(id) }
  await unreadable.controller.reconcile(owner, second); assert.match(unreadable.controller.current().error, /does not identify/)
  const replaced = make(true); { const id = await replaced.review(); await replaced.run(id) }
  const original = replaced.controller.current().attempt.hash; await replaced.controller.reconcile(owner)
  assert.equal(replaced.controller.current().replaced, true); assert.match(replaced.controller.current().error, /nonce was used by another transaction/); assert.equal(replaced.controller.current().phase, 'pending'); assert.equal(replaced.controller.blocking(owner), true)
  await replaced.controller.reconcile(owner, second)
  const record = replaced.records()[0]; assert.equal(record.hash, second); assert.equal(record.status, 'confirmed'); assert.equal(record.steps.find(step => step.kind === 'swap').hash, second)
  assert.ok(record.log.some(entry => entry.note.includes(original) && entry.note.includes('nonce was used by another transaction'))); assert.equal(replaced.controller.blocking(owner), false)
  // a replacement hash the network does not show yet is not saved either
  const pendingOnly = make(true); { const id = await pendingOnly.review(); await pendingOnly.run(id) }
  pendingOnly.ports.result = async attempt => ({ status: 'pending', identified: false, nonceUsed: true }); await pendingOnly.controller.reconcile(owner, second)
  assert.match(pendingOnly.controller.current().error, /does not know that hash/); assert.equal(pendingOnly.records()[0].hash, pendingOnly.controller.current().attempt.hash)
})
await test('incomplete evidence is stored with its chain facts, claims nothing, keeps blocking, and its re-reads back off and stop', async () => {
  const f = setup({ autoSettle: false }); const id = await f.review(); await f.run(id); const hash = f.controller.current().attempt.hash
  f.world.results.set(hash, { status: 'settled', output: '800000', fee: '12000000000000000', approvals: [{ index: 0, status: 'confirmed', fee: '1000000000000000' }],
    chain: { state: 'success', blockNumber: '5', blockHash: '0x' + '22'.repeat(32), gasUsed: '1', effectiveGasPrice: '1', fee: '11000000000000000', received: null, sent: null, checkedAt: 1 }, intent: { verdict: 'incomplete', checks: [], differences: [], checkedAt: 1 } })
  const delays = []; for (let i = 0; i < 9; i++) { await f.controller.reconcile(owner); delays.push(f.controller.current().nextCheckMs) }
  assert.deepEqual(delays, [5000, 10000, 20000, 40000, 60000, 60000, 60000, null, null]); assert.equal(f.controller.current().phase, 'unknown'); assert.equal(f.records()[0].status, 'unknown'); assert.equal(f.records()[0].chain.state, 'success'); assert.equal(f.controller.blocking(owner), true)
})
await test('a page that goes to the background mid-flow does not end the flow; one that merely shows a Review does, and a click is bound to the step on screen', async () => {
  const idle = setup(); await idle.review(); idle.controller.hidden(); assert.equal(idle.controller.current().phase, 'idle')
  const f = setup(), id = await f.review(); let release; f.world.wallet = () => new Promise(resolve => { release = resolve })
  const done = f.controller.confirm(id); await waitFor(() => f.controller.current().phase === 'awaiting_step')
  const step = f.controller.current().step; f.controller.continueStep(f.controller.stepKey({ ...step, index: step.index + 1 })); assert.equal(f.controller.current().phase, 'awaiting_step'); assert.equal(f.world.sends.length, 0) // a click for another step does nothing
  f.controller.continueStep(f.controller.stepKey(step)); await waitFor(() => f.controller.current().phase === 'awaiting_wallet'); f.controller.hidden() // the wallet app comes to the front
  const hash = '0x' + 'a1'.repeat(32); f.world.approvals.set(hash, { status: 'confirmed', fee: '1' }); f.world.latest++; f.world.pending++; f.world.wallet = undefined; release(hash)
  await waitFor(() => f.controller.current().phase === 'awaiting_step' && f.controller.current().step.kind === 'swap'); f.controller.hidden(); f.controller.continueStep(f.controller.stepKey(f.controller.current().step)); await done
  assert.equal(f.world.sends.length, 2); assert.equal(f.controller.current().phase, 'pending')
})
await test('the flow is checked once more after the last read before the wallet is contacted', async () => {
  let ctl; const f = setup({ ports: { estimateGas: async () => { ctl.invalidate(); return 50_000n } } }); ctl = f.controller
  const id = await f.review(); await f.run(id); assert.equal(f.world.sends.length, 0); assert.equal(f.controller.current().phase, 'rejected'); assert.equal(f.controller.blocking(owner), false)
})
await test('a flow that waits for the swap software with nothing open is ended after a while; an open confirmation is never ended that way', async () => {
  mock.timers.enable({ apis: ['setTimeout'] })
  try {
    const f = setup(); f.world.kit = { swap: () => new Promise(() => {}) }; const id = await f.review(), done = f.controller.confirm(id)
    await waitFor(() => f.records().length === 1); mock.timers.tick(c.CIRCLE_STALL_BEFORE_STEP_MS - 1); assert.equal(f.controller.current().phase, 'checking'); mock.timers.tick(1); await done
    assert.equal(f.controller.current().phase, 'rejected'); assert.match(f.controller.current().error, /did not answer in time/); assert.equal(f.records()[0].status, 'rejected'); assert.equal(f.world.sends.length, 0)
    await f.controller.prepare(); assert.equal(f.controller.current().phase, 'review', f.controller.current().error)
    const g2 = setup(), id2 = await g2.review(), run2 = g2.controller.confirm(id2)
    await waitFor(() => g2.controller.current().phase === 'awaiting_step'); mock.timers.tick(c.CIRCLE_STALL_BEFORE_STEP_MS + 10_000); assert.equal(g2.controller.current().phase, 'awaiting_step')
    g2.controller.cancelStep(); await run2
    // after an approval went out and the swap software then stalls: ended, and the approval stays tracked
    const h = setup(); const hash = '0x' + 'a1'.repeat(32); h.world.latest = 7; h.world.approvalOutcome = 'pending'; h.world.kit = { async swap(params) {
      const wallet = params.from.adapter.wallet; await wallet.sendTransaction({ account: wallet.account, chain: { id: 5042 }, to: T('EURC').address, data: d.encodeApprove(ADAPTER, 1_000_000n) }); await new Promise(() => {}) } }
    const id3 = await h.review(), run3 = h.controller.confirm(id3); await waitFor(() => h.controller.current().phase === 'awaiting_step'); h.controller.continueStep(); await waitFor(() => h.world.sends.length === 1)
    await waitFor(() => h.controller.current().attempt?.steps[0]?.status === 'pending'); mock.timers.tick(c.CIRCLE_STALL_AFTER_APPROVAL_MS); await run3
    assert.equal(h.controller.current().phase, 'pending'); assert.match(h.controller.current().attempt.log.at(-1).note, /did not answer in time/); assert.equal(h.controller.blocking(owner), true); void hash
  } finally { mock.timers.reset() }
})
await test('eviction never moves a record this session could not re-verify; unreadable archive entries are kept and counted, not fatal', async () => {
  const f = setup(), id = await f.review(); await f.run(id); const base = JSON.parse(f.data.get(f.storageKey))[0]
  const store = new Map(), pinned = new Set(), journal = c.createCircleJournal({ getItem: k => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) }, id => pinned.has(id))
  const record = n => ({ ...structuredClone(base), id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`, status: 'rejected', steps: [], hash: undefined, chain: undefined, intent: undefined, output: undefined, fee: undefined })
  for (let n = 1; n <= 20; n++) journal.save(record(n)); pinned.add(record(1).id); journal.save(record(21))
  assert.ok(journal.read(owner).some(a => a.id === record(1).id)); assert.ok(!journal.read(owner).some(a => a.id === record(2).id)); assert.deepEqual(journal.archived(owner).map(a => a.id), [record(2).id])
  const archiveKey = `machina.circle.swap.execution.archive.v1:${owner.toLowerCase()}`; const stored = JSON.parse(store.get(archiveKey)); stored.push({ id: 'legacy', note: 'an old entry today\'s rules do not accept' }); store.set(archiveKey, JSON.stringify(stored))
  assert.equal(journal.archiveUnreadable(owner), 1); journal.save(record(22)); assert.equal(journal.read(owner).length, 20) // recording continues
  assert.ok(JSON.parse(store.get(archiveKey)).some(entry => entry.id === 'legacy')); assert.equal(journal.archived(owner).length, 2) // nothing deleted, the old entry stays as stored
  const listed = c.listStoredCircleAttempts({ length: 2, key: i => [`machina.circle.swap.execution.v1:${owner.toLowerCase()}`, archiveKey][i], getItem: k => store.get(k) ?? null })
  assert.equal(listed[0].attempts.length, 20); assert.equal(listed[0].archived.length, 2); assert.equal(listed[0].archiveUnreadable, 1); assert.equal(listed[0].unreadable, false)
  const broken = c.listStoredCircleAttempts({ length: 2, key: i => [`machina.circle.swap.execution.v1:${owner.toLowerCase()}`, archiveKey][i], getItem: k => (k === archiveKey ? '{' : store.get(k) ?? null) })
  assert.equal(broken[0].attempts.length, 20); assert.equal(broken[0].archived.length, 0); assert.equal(broken[0].unreadable, true) // a broken archive never hides the active records
})
await test('the read-only Arc client of the Circle flow refuses every non-read method on both of its request paths and never reaches the network', async () => {
  const sdk = require(`${root}src/lib/swap/circleSdk.ts`), before = external
  for (const request of [sdk.circleReadClient.request, sdk.circleReadClient.transport.request]) for (const method of ['eth_sendRawTransaction', 'eth_sendTransaction', 'personal_sign', 'eth_signTypedData_v4', 'wallet_switchEthereumChain'])
    await assert.rejects(Promise.resolve().then(() => request({ method, params: [] })), /read_only_rpc/, method)
  assert.equal(external, before); for (const method of ['eth_getStorageAt', 'eth_getTransactionByHash']) c.assertCircleExecutionReadMethod(method)
})
// =============================================================================================================================
// G. Execution completion: independent price, Review-bound fee, outcome simulation (all read-only)
// =============================================================================================================================
await test('independent price: a fresh Review without a reference price, or with a guaranteed minimum far below it, is never executable; ordinary venue differences are fine', async () => {
  const reference = setup(), base = await reference.ports.fresh(reference.input())
  const mutate = fn => async (request, now) => { const review = await reference.ports.fresh(request); review.requestStartedAt = now; review.expiresAt = now + 30_000; fn(review); return review }
  const noReference = setup({ fresh: mutate(r => { delete r.reference }) }); await noReference.controller.prepare()
  assert.equal(noReference.controller.current().phase, 'idle'); assert.match(noReference.controller.current().error, /independent price check could not be completed/); assert.equal(noReference.world.sends.length, 0)
  const estimated = BigInt(base.estimatedOutput), minimum = BigInt(base.requiredMinimum)
  const edge = c.CIRCLE_REFERENCE_TOLERANCE_BPS
  // the reference must not be more than slippage + tolerance above the guaranteed minimum
  const justOk = minimum * 10_000n / BigInt(10_000 - 50 - edge) // reference at which minimum is exactly at the floor
  for (const [name, referenceOutput, ok] of [['equal to Circle', estimated, true], ['2% above Circle', estimated * 102n / 100n, true], ['at the floor', justOk, true], ['1 unit past the floor', justOk + 2n, false], ['10% above Circle', estimated * 110n / 100n, false], ['zero', 0n, false]]) {
    const f = setup({ fresh: mutate(r => { r.reference = { source: 'uniswap', estimatedOutput: referenceOutput.toString() } }) }); await f.controller.prepare()
    assert.equal(f.controller.current().phase, ok ? 'review' : 'idle', `${name}: ${f.controller.current().error}`)
    if (!ok) assert.match(f.controller.current().error, name === 'zero' ? /independent price check/ : /well below the independent market price/)
  }
  assert.throws(() => c.independentPriceCheck({ ...base, reference: { source: 'other', estimatedOutput: '1' } }), /price_check/)
  assert.doesNotThrow(() => c.validateCircleReview({ ...base, reference: undefined }, { owner, connected: true, chainId: 5042 }, base.requestStartedAt)) // stored records do not carry one
  assert.throws(() => c.validateCircleReview({ ...base, reference: { source: 'other', estimatedOutput: '1' } }, { owner, connected: true, chainId: 5042 }, base.requestStartedAt), /invalid_request/)
})
await test('review building: the reference is read independently, a failing reference read leaves the Review without one, and the real Uniswap reference converts to base units', async () => {
  const sdk = require(`${root}src/lib/swap/circleSdk.ts`)
  const quote = { requestKey: 'k', estimatedOutput: '0.9', minimumOutput: '0.8955', fees: [{ type: 'provider', token: 'EURC', amount: '0.0002' }], receivedAt: NOW_MS, expiresAt: NOW_MS + 30_000 }
  const deps = over => ({ quote: async () => quote, facts: async () => ({ nativeBalance: 5n * 10n ** 18n, tokenBalance: 10n ** 20n, allowance: 0n, gasPrice: gwei(20), baseFee: gwei(20) }), now: () => NOW_MS, ...over })
  const request = { chainId: 5042, tokenIn: 'EURC', tokenOut: 'USDC', owner, amount: '1', slippageBps: 50, allowanceStrategy: 'approve' }
  const withReference = await sdk.buildCircleReview(request, deps({ reference: async () => '0.905' })); assert.deepEqual(withReference.reference, { source: 'uniswap', estimatedOutput: '905000' })
  const failing = await sdk.buildCircleReview(request, deps({ reference: async () => { throw Error('rpc down') } })); assert.equal(failing.reference, undefined)
  assert.equal((await sdk.buildCircleReview(request, deps({ reference: async () => null }))).reference, undefined)
})
await test('the production example preserves 18-decimal gas math, separate 6-decimal provider fees and the existing safety margins', async () => {
  // Controlled reproduction: the exact estimate is inferred from the reported ceiling; the historical raw quote was not supplied.
  const sdk = require(`${root}src/lib/swap/circleSdk.ts`)
  const request = { chainId: 5042, tokenIn: 'USDC', tokenOut: 'EURC', owner, amount: '0.1', slippageBps: 50, allowanceStrategy: 'permit' }
  const review = await sdk.buildCircleReview(request, {
    now: () => NOW_MS,
    quote: async () => ({ estimatedOutput: '0.089297', minimumOutput: '0.08885', expiresAt: NOW_MS + 30_000,
      fees: [{ type: 'provider', token: 'USDC', amount: '0.00002' }, { type: 'gas', token: 'USDC', amount: '0.02357122150215' }] }),
    facts: async () => ({ nativeBalance: 10n ** 18n, tokenBalance: 1_000_000n, allowance: 0n, gasPrice: gwei(20), baseFee: gwei(21) }),
  })
  assert.equal(review.networkFee, '90713664506450000')
  assert.equal(review.maxFeePerGas, gwei(42).toString()); assert.equal(review.maxPriorityFeePerGas, '0')
  assert.equal(review.amountIn, '100000'); assert.equal(review.estimatedOutput, '89297')
  assert.equal(c.providerFeeUnits(review), 20n)
  assert.equal(Number(review.fees.find(f => f.type === 'gas').amount).toPrecision(2), '0.024')
  assert.equal(g.bufferedGas(100001n), 130002n)
  assert.equal(c.circleFeeCeiling(10n ** 18n), c.CIRCLE_FEE_CEILING_CAP)
  const { ViemAdapter } = require('@circle-fin/adapter-viem-v2'), { getChainByEnum } = require('@circle-fin/swap-kit')
  const adapter = new ViemAdapter({ getPublicClient: () => ({ getGasPrice: async () => gwei(20) }), getWalletClient: () => { throw Error('wallet_forbidden') } }, { addressContext: 'user-controlled', supportedChains: [getChainByEnum('Arc')] })
  const estimated = await adapter.calculateTransactionFee(1_000_000n, undefined, getChainByEnum('Arc'))
  assert.equal(estimated.fee, '21000000000000000') // 1M gas x 20 gwei plus the adapter's existing 5% buffer
})
await test('Review-bound fee: the provider fee in the transaction may not exceed the fee the Review showed (rounding aside); real swaps and the real service agree to the unit', () => {
  const real = realSwaps.find(r => r.tokenIn === 'EURC' && r.call.instructions.length === 2), nowSec = Number(real.call.deadline) - 590
  const fee = real.call.instructions.filter(i => i.tokenOut === ZERO).reduce((sum, i) => sum + i.amountToApprove, 0n)
  assert.equal(d.checkSwapCalldata(real.v.tx.input, { ...real.intent, maxFeeUnits: fee }, nowSec).feeUnits, fee)
  assert.equal(d.checkSwapCalldata(real.v.tx.input, { ...real.intent, maxFeeUnits: fee }, nowSec).ok, true)
  const tooSmall = d.checkSwapCalldata(real.v.tx.input, { ...real.intent, maxFeeUnits: fee / 2n }, nowSec); assert.equal(tooSmall.ok, false); assert.equal(tooSmall.code, 'fee_share'); assert.match(tooSmall.detail, /larger fee than the fee shown in the Review/)
  assert.equal(d.checkSwapCalldata(real.v.tx.input, { ...real.intent, maxFeeUnits: fee - 1n }, nowSec).ok, true) // one unit of rounding is tolerated
  assert.equal(c.providerFeeUnits({ request: { tokenIn: 'EURC' }, fees: [{ type: 'provider', token: 'EURC', amount: '0.0002' }, { type: 'gas', token: 'USDC', amount: '0.02' }] }), 200n)
  assert.equal(c.providerFeeUnits({ request: { tokenIn: 'EURC' }, fees: [{ type: 'provider', token: 'USDC', amount: '0.0002' }] }), undefined) // a fee in another token is not a bound for this one
  const f = guardFixture({ policy: { maxFeeUnits: 150n } }); // the synthetic service call carries amountIn / 5000 = 200 units of fee; 1% + 1 unit of rounding is tolerated
  return (async () => { await f.wallet.sendTransaction(f.approve()); await refused(f.wallet.sendTransaction(f.swap()), 'swap_calldata'); const ok = guardFixture({ policy: { maxFeeUnits: 200n } }); await ok.wallet.sendTransaction(ok.approve()); await ok.wallet.sendTransaction(ok.swap()); assert.equal(ok.log.find(e => e[0] === 'gate' && e[1] === 'swap') !== undefined, true) })()
})
await test('outcome simulation: an approval-strategy swap is run against the live adapter first; a shortfall, an overspend or an unreadable run stops it before the wallet; the approval stays tracked', async () => {
  const seen = []
  const ok = setup({ ports: { simulate: async (who, data, tokenIn, tokenOut) => { seen.push({ who, tokenIn, tokenOut, data }); const review = ok.records()[0].review; return { received: BigInt(review.requiredMinimum), spent: BigInt(review.amountIn) } } } })
  await ok.run(await ok.review()); assert.equal(ok.controller.current().phase, 'pending'); assert.equal(ok.world.sends.length, 2); assert.equal(seen.length, 1)
  assert.equal(seen[0].who, owner); assert.equal(seen[0].tokenIn.toLowerCase(), T('EURC').address.toLowerCase()); assert.equal(seen[0].tokenOut.toLowerCase(), T('USDC').address.toLowerCase()); assert.equal(seen[0].data.slice(0, 10), d.ADAPTER_EXECUTE_SELECTOR)
  for (const [name, simulate] of [['shortfall', async () => ({ received: 1n, spent: 1_000_000n })], ['overspend', async () => ({ received: 10n ** 12n, spent: 1_000_001n })], ['unreadable', async () => { throw Error('rpc') }]]) {
    const f = setup({ ports: { simulate } }); await f.run(await f.review())
    assert.equal(f.world.sends.length, 1, name) // the approval went out, the swap never reached the wallet
    assert.match(f.controller.current().error ?? '', /test run of this exact swap|Approval confirmed|swap was not requested/i, name)
    assert.ok(!f.world.sends.some(send => send.to.toLowerCase() === ADAPTER.toLowerCase()), name)
  }
  // a permit swap has no such run (its signature belongs to the wallet); it is covered by the estimate and the on-chain check
  let called = 0; const permit = setup({ tokenIn: 'USDC', tokenOut: 'EURC', ports: { simulate: async () => { called++; return { received: 0n, spent: 0n } } } }); await permit.run(await permit.review())
  assert.equal(called, 0); assert.equal(permit.world.sends.length, 1)
})
await test('outcome simulation, read side: the wallet address carries the helper only inside one eth_call and the helper reports how the balances moved', async () => {
  const sim = require(`${root}src/lib/swap/simulatorCode.ts`), calls = []
  const rpc = { call: async args => { calls.push(args); return { data: encodeAbiParameters(parseAbiParameters('(uint256 inBefore,uint256 inAfter,uint256 outBefore,uint256 outAfter,uint256 gasUsed) r'), [{ inBefore: 5_000_000n, inAfter: 4_000_000n, outBefore: 7n, outAfter: 1_119_610n, gasUsed: 566_804n }]) } } }
  const outcome = await c.createCircleChainRpc(rpc, () => 1).simulate(owner, '0xaa3e079c', T('EURC').address, T('USDC').address)
  assert.deepEqual(outcome, { received: 1_119_603n, spent: 1_000_000n }); const call = calls[0]
  assert.equal(call.to, owner); assert.equal(call.stateOverride.length, 1); assert.equal(call.stateOverride[0].address, owner); assert.equal(call.stateOverride[0].code, sim.SIMULATOR_RUNTIME); assert.equal(call.value, undefined)
  await assert.rejects(c.createCircleChainRpc({ call: async () => ({ data: undefined }) }, () => 1).simulate(owner, '0xaa3e079c', T('EURC').address, T('USDC').address))
})
await test('Circle messages for the new states exist and say what happened', () => {
  for (const code of ['sdk_stalled', 'permit_failed', 'closed_before_wallet', 'recovery_unknown', 'replaced']) assert.notEqual(c.circleSwapMessage(code), c.circleSwapMessage('preflight'), code)
})
await test('sources are read-only where they claim to be: the module never sends raw transactions itself and the SDK is only reachable through the guarded wallet', () => {
  const source = ['circleSwap', 'circleGuard', 'circleAdapterDecode'].map(name => readFileSync(`${root}src/lib/swap/${name}.ts`, 'utf8')).join('\n')
  for (const forbidden of [/eth_sendRawTransaction/, /eth_signTypedData/, /personal_sign/, /privateKey/i, /mnemonic/i, /seed phrase/i, /fetch\(/, /localStorage/, /\.sendCalls\(/, /wallet_switchEthereumChain/, /MaxUint256|2n \*\* 256n - 1n/]) assert.doesNotMatch(source.replace(/\/\/.*$/gm, ''), forbidden)
  assert.equal(external, 0)
})

// =============================================================================================================================
// E. The REAL Circle Swap Kit 1.7.0 and ViemAdapter against the guarded wallet (stubbed HTTP service, fake JSON-RPC, no network)
// =============================================================================================================================
const realKit = require('@circle-fin/swap-kit'), realAdapter = require('@circle-fin/adapter-viem-v2')
const { createPublicClient, custom, defineChain, toHex } = require('viem')
const arcViem = defineChain({ id: 5042, name: 'Arc', nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 }, rpcUrls: { default: { http: ['https://rpc.mainnet.arc.io'] } } })
const word = n => toHex(BigInt(n), { size: 32 })
// The public RPC as the adapter sees it: reads only, receipts for every hash the (fake) wallet issued.
function realSdk(world, clock) {
  const decimals = Object.fromEntries(tk.SWAP_SYMBOLS.map(symbol => [T(symbol).address.toLowerCase(), T(symbol).decimals]))
  world.rpcCalls = []
  const request = async ({ method, params }) => {
    world.rpcCalls.push(method)
    const sec = Math.floor(clock.now / 1000)
    switch (method) {
      case 'eth_chainId': return '0x13b2'
      case 'eth_blockNumber': return '0x64'
      case 'eth_getBlockByNumber': return { number: '0x64', hash: '0x' + '11'.repeat(32), parentHash: '0x' + '10'.repeat(32), timestamp: toHex(sec), baseFeePerGas: toHex(20_000_000_000n), gasLimit: '0x1c9c380', gasUsed: '0x0', transactions: [], miner: owner, nonce: '0x0000000000000000',
        difficulty: '0x0', totalDifficulty: '0x0', extraData: '0x', logsBloom: '0x' + '00'.repeat(256), receiptsRoot: '0x' + '00'.repeat(32), sha3Uncles: '0x' + '00'.repeat(32), size: '0x1', stateRoot: '0x' + '00'.repeat(32), transactionsRoot: '0x' + '00'.repeat(32), uncles: [], mixHash: '0x' + '00'.repeat(32) }
      case 'eth_gasPrice': return toHex(21_000_000_000n)
      case 'eth_maxPriorityFeePerGas': return toHex(1_000_000_000n)
      case 'eth_estimateGas': return toHex(600_000n)
      case 'eth_getTransactionCount': return '0x7'
      case 'eth_getCode': return '0x60'
      case 'eth_getBalance': return toHex(5n * 10n ** 18n)
      case 'eth_call': { const { to, data } = params[0], sel = data.slice(0, 10)
        if (sel === '0x313ce567') return word(decimals[to.toLowerCase()] ?? 6); if (sel === '0x70a08231') return word(10n ** 24n); if (sel === '0xdd62f93f') return word(0); if (sel === '0x7ecebe00') return word(0)
        if (sel === '0x06fdde03') return encodeAbiParameters(parseAbiParameters('string'), ['USDC']); return '0x' }
      case 'eth_getTransactionReceipt': return world.issued.has(params[0]) ? { transactionHash: params[0], blockHash: '0x' + '11'.repeat(32), blockNumber: '0x64', transactionIndex: '0x0', from: owner, to: ADAPTER, status: '0x1', gasUsed: '0x5208', cumulativeGasUsed: '0x5208',
        effectiveGasPrice: '0x4e3b29200', logs: [], logsBloom: '0x' + '00'.repeat(256), type: '0x2', contractAddress: null } : null
      default: throw Object.assign(new Error(`unexpected rpc ${method}`), { code: -32601 })
    }
  }
  const publicClient = createPublicClient({ chain: arcViem, transport: custom({ request }) })
  return wallet => ({ kit: new realKit.SwapKit({ disableAnalytics: true, disableErrorReporting: true }),
    adapter: new realAdapter.ViemAdapter({ getPublicClient: () => publicClient, getWalletClient: () => wallet }, { addressContext: 'user-controlled', supportedChains: [realKit.getChainByEnum('Arc')] }) })
}
// Circle's service, stubbed. The response has the shape the SDK validates with zod: signed execution params built from the request.
const service = { requests: [], tweak: undefined, status: 'down' }
const noNetwork = globalThis.fetch
globalThis.fetch = async (url, init) => {
  const target = String(url)
  if (target.includes('/v1/stablecoinKits/swap/status')) return new Response(JSON.stringify({ message: 'not available in this test' }), { status: 404 })
  if (target.includes('/v1/stablecoinKits/swap')) {
    const body = JSON.parse(init.body); service.requests.push(body)
    const amount = BigInt(body.amount), fee = amount / 5000n, nowSec = Math.floor(service.now / 1000)
    const response = { tokenInAddress: body.tokenInAddress, tokenInChain: body.tokenInChain, tokenOutAddress: body.tokenOutAddress, tokenOutChain: body.tokenOutChain ?? body.tokenInChain, fromAddress: body.fromAddress, toAddress: body.toAddress ?? body.fromAddress,
      amount: body.amount, stopLimit: body.stopLimit ?? '1', estimatedAmount: (amount * 9n / 10n).toString(),
      transaction: { signature: '0x' + 'ab'.repeat(65), gasLimit: '0x' + (1_050_000).toString(16), executionParams: { execId: '123', deadline: String(nowSec + 600), metadata: '0x00',
        tokens: [{ token: body.tokenInAddress, beneficiary: body.fromAddress }, { token: body.tokenOutAddress, beneficiary: body.fromAddress }],
        instructions: [{ target: d.CIRCLE_FEE_TARGET, data: '0x7ebc46f0' + '00'.repeat(128), value: '0', tokenIn: body.tokenInAddress, amountToApprove: fee.toString(), tokenOut: ZERO, minTokenOut: '0' },
          { target: d.CIRCLE_SWAP_EXECUTOR, data: '0x4666fc80', value: '0', tokenIn: body.tokenInAddress, amountToApprove: (amount - fee).toString(), tokenOut: body.tokenOutAddress, minTokenOut: body.stopLimit ?? '1' }] } } }
    service.tweak?.(response)
    return new Response(JSON.stringify(response), { status: 200, headers: { 'content-type': 'application/json' } })
  }
  external++; return noNetwork(url, init)
}
const realNow = () => { const now = Date.now(); service.now = now; return now }
const SELECTOR_APPROVE = '0x095ea7b3'

await test('REAL SDK, all 12 directions through the controller: the unchanged Swap Kit approves exactly (or signs the exact permit for USDC), then swaps, and every wallet request passed the guard', async () => {
  for (const { tokenIn, tokenOut } of tk.SWAP_DIRECTIONS) {
    service.requests.length = 0; service.tweak = undefined
    const f = setup({ tokenIn, tokenOut, real: true, now: realNow() }), id = await f.review(); await f.run(id)
    const view = f.controller.current(), attempt = view.attempt, label = `${tokenIn}>${tokenOut}`; assert.equal(view.phase, 'pending', `${label}: ${view.error}`)
    const amountIn = parseUnits(AMOUNTS[tokenIn], T(tokenIn).decimals), usdcInput = tokenIn === 'USDC'
    // what the real SDK asked the service for
    assert.equal(service.requests.length, 1, label); const asked = service.requests[0]
    assert.equal(asked.tokenInAddress.toLowerCase(), T(tokenIn).address.toLowerCase()); assert.equal(asked.tokenOutAddress.toLowerCase(), T(tokenOut).address.toLowerCase()); assert.equal(asked.amount, amountIn.toString())
    assert.equal(asked.stopLimit, attempt.review.requiredMinimum, label); assert.equal(asked.slippageBps, 50); assert.equal(asked.fromAddress.toLowerCase(), owner.toLowerCase()); assert.ok(asked.toAddress === undefined || asked.toAddress.toLowerCase() === owner.toLowerCase())
    assert.equal(asked.config?.customFee, undefined, label) // no developer fee is ever requested
    // what the real SDK asked of the wallet
    if (usdcInput) {
      assert.equal(f.world.signs.length, 1, label); assert.equal(f.world.signs[0].primaryType, 'Permit'); assert.equal(f.world.signs[0].message.value, amountIn); assert.equal(f.world.signs[0].message.spender.toLowerCase(), ADAPTER.toLowerCase()); assert.equal(f.world.sends.length, 1, label)
      assert.deepEqual(attempt.steps.map(step => step.kind), ['swap'])
    } else {
      assert.equal(f.world.signs.length, 0, label); assert.equal(f.world.sends.length, 2, label); assert.equal(f.world.sends[0].data.slice(0, 10), SELECTOR_APPROVE); assert.equal(f.world.sends[0].data, d.encodeApprove(ADAPTER, amountIn)); assert.equal(f.world.sends[0].to.toLowerCase(), T(tokenIn).address.toLowerCase())
      assert.deepEqual(attempt.steps.map(step => step.kind), ['approve', 'swap'])
    }
    const swapSend = f.world.sends.at(-1); assert.equal(swapSend.to.toLowerCase(), ADAPTER.toLowerCase()); assert.equal(swapSend.value, 0n); assert.equal(swapSend.gas, 1_050_000n); assert.equal(swapSend.type, 'eip1559'); assert.equal(swapSend.nonce, 7 + f.world.sends.length - 1)
    const decoded = d.decodeAdapterExecute(swapSend.data).call; assert.equal(decoded.tokenInputs[0].amount, amountIn); assert.equal(decoded.tokenInputs[0].permitType, usdcInput ? 1 : 0)
    assert.ok(decoded.instructions.every(i => i.value === 0n)); assert.equal(f.world.journalCheck.length, f.world.sends.length); assert.ok(f.world.journalCheck.every(Boolean))
    assert.equal(attempt.steps.at(-1).dataHash, keccak256(swapSend.data)) // the journaled hash is the hash of what the wallet received
    f.world.results.set(attempt.hash, 'settle'); await f.controller.reconcile(); assert.equal(f.controller.current().phase, 'confirmed', label)
  }
})
const tampered = [
  ['lower minimum than the stop limit', r => { r.transaction.executionParams.instructions[1].minTokenOut = (BigInt(r.transaction.executionParams.instructions[1].minTokenOut) - 1n).toString() }, /differ from what you reviewed/],
  ['output swept to a third party', r => { r.transaction.executionParams.tokens[1].beneficiary = other }, /differ from what you reviewed/],
  ['input residue swept to a third party', r => { r.transaction.executionParams.tokens[0].beneficiary = other }, /differ from what you reviewed/],
  ['unknown instruction target', r => { r.transaction.executionParams.instructions[0].target = other }, /differ from what you reviewed/],
  ['more input than the amount', r => { r.transaction.executionParams.instructions[1].amountToApprove = (BigInt(r.transaction.executionParams.instructions[1].amountToApprove) + 10n ** 12n).toString() }, /differ from what you reviewed/],
  // the SDK itself may stop on this one first; either way no adapter transaction may reach the wallet
  ['native value on an instruction', r => { r.transaction.executionParams.instructions[1].value = '1' }, /differ from what you reviewed|stopped before any transaction was requested|native value/],
  ['other output token', r => { r.transaction.executionParams.instructions[1].tokenOut = T('cirBTC').address }, /differ from what you reviewed/],
  ['deadline about to expire', r => { r.transaction.executionParams.deadline = String(Math.floor(service.now / 1000) + 5) }, /differ from what you reviewed/],
  ['deadline far in the future', r => { r.transaction.executionParams.deadline = String(Math.floor(service.now / 1000) + 86_400) }, /differ from what you reviewed/],
]
await test('REAL SDK with a service response that differs from the review: the swap never reaches the wallet, for an approved-token input and for a USDC permit input alike', async () => {
  for (const [name, tweak, text] of tampered) {
    for (const [tokenIn, tokenOut] of [['EURC', 'USDC'], ['USDC', 'EURC']]) {
      service.requests.length = 0; service.tweak = tweak
      const f = setup({ tokenIn, tokenOut, real: true, now: realNow() }), id = await f.review(); await f.run(id)
      const view = f.controller.current(), label = `${name} (${tokenIn})`
      assert.equal(view.phase, 'rejected', `${label}: ${view.error}`); assert.match(view.error, text, label); assert.equal(f.world.sends.filter(send => send.to.toLowerCase() === ADAPTER.toLowerCase()).length, 0, label)
      assert.equal(f.records()[0].hash, undefined); assert.equal(f.records()[0].status, 'rejected'); assert.equal(await f.review().then(Boolean), true, label) // nothing left blocking
    }
  }
  service.tweak = undefined
})
async function direct({ tokenIn, tokenOut, strategy, config = {}, amount = '1' }) {
  service.requests.length = 0; const f = setup({ tokenIn, tokenOut: tokenOut ?? 'USDC', real: true, now: realNow() }), review = await f.ports.fresh(f.input())
  const sends = [], signs = [], issued = f.world.issued, log = []
  const inner = { getChainId: async () => 5042, getAddresses: async () => [owner],
    sendTransaction: async params => { sends.push(params); const hash = '0x' + (0xd000 + sends.length).toString(16).padStart(64, '0'); issued.add(hash); return hash },
    signTypedData: async params => { signs.push(params); return '0x' + '11'.repeat(32) + '22'.repeat(32) + '1b' } }
  const hooks = { gate: async () => {}, before: async (step, est) => ({ nonce: 7 + sends.length, gas: est.gas ?? 70_000n, maxFeePerGas: gwei(30), maxPriorityFeePerGas: gwei(1) }), sent: (step, hash) => log.push(['sent', step.kind]), failed: (step, outcome, error) => log.push(['failed', step.kind, outcome, error?.code]), signed: () => log.push(['signed']) }
  const policy = { owner, adapter: ADAPTER, inputToken: T(tokenIn).address, outputToken: T(tokenOut ?? 'USDC').address, amountIn: BigInt(review.amountIn), minimumOut: BigInt(review.requiredMinimum), strategy, chainId: 5042, now: Date.now, maxFeePerGas: gwei(30), maxPriorityFeePerGas: gwei(1), feeBudget: () => 5n * 10n ** 16n }
  const guarded = g.createGuardedWalletClient(inner, policy, hooks), { kit, adapter } = f.ports.sdk(guarded)
  const params = c.buildCircleSwapParams(review, adapter); Object.assign(params.config, { allowanceStrategy: strategy, ...config })
  let result, error; try { result = await kit.swap(params) } catch (e) { error = e }
  return { sends, signs, log, result, error, guarded }
}
await test('REAL SDK, USDC with the approve strategy: the SDK asks for increaseAllowance (adds to an existing allowance), which the exact-approve rule refuses before the wallet', async () => {
  const r = await direct({ tokenIn: 'USDC', tokenOut: 'EURC', strategy: 'approve' })
  assert.equal(r.sends.length, 0); assert.equal(r.signs.length, 0); assert.ok(r.error); assert.match(String(r.error.message), /approve_data/); assert.deepEqual(r.log.at(-1).slice(0, 4), ['failed', 'approve', 'refused', 'approve_data'])
  // and it is the reason the request layer does not offer it
  assert.throws(() => c.validateCircleRequest({ chainId: 5042, tokenIn: 'USDC', tokenOut: 'EURC', owner, amount: '1', slippageBps: 50, allowanceStrategy: 'approve' }), /invalid_strategy/)
})
await test('REAL SDK, batching asked for: the guarded wallet has no EIP-5792 methods, so the SDK falls back to two separate wallet requests', async () => {
  const r = await direct({ tokenIn: 'EURC', strategy: 'approve', config: { batchTransactions: true } })
  assert.equal(r.error, undefined); assert.deepEqual(r.sends.map(send => send.data.slice(0, 10)), [SELECTOR_APPROVE, d.ADAPTER_EXECUTE_SELECTOR]); assert.equal(r.guarded.sendCalls, undefined); assert.equal(r.guarded.getCapabilities, undefined)
  assert.match(r.result.txHash, /^0x[0-9a-f]{64}$/); assert.equal(r.result.txHash, '0x' + (0xd002).toString(16).padStart(64, '0')); assert.deepEqual(r.log.map(entry => entry[1]), ['approve', 'swap']) // the SDK's result is the swap hash; the approval hash reached the journal hook
})
await test('REAL SDK, permit: the typed data the SDK builds is exactly the EIP-2612 Permit the guard allows (USDC domain on Arc, exact amount, one-hour deadline, adapter as spender)', async () => {
  const r = await direct({ tokenIn: 'USDC', tokenOut: 'EURC', strategy: 'permit' })
  assert.equal(r.error, undefined); assert.equal(r.signs.length, 1); const typed = r.signs[0]
  assert.deepEqual({ name: typed.domain.name, version: typed.domain.version, chainId: Number(typed.domain.chainId), verifyingContract: typed.domain.verifyingContract.toLowerCase() }, { name: 'USDC', version: '2', chainId: 5042, verifyingContract: T('USDC').address.toLowerCase() })
  assert.equal(typed.primaryType, 'Permit'); assert.deepEqual(typed.types.Permit, d.PERMIT_TYPES); assert.equal(typed.message.owner.toLowerCase(), owner.toLowerCase()); assert.equal(typed.message.spender.toLowerCase(), ADAPTER.toLowerCase()); assert.equal(typed.message.value, 1_000_000n)
  const ahead = Number(typed.message.deadline) - Math.floor(Date.now() / 1000); assert.ok(ahead > 3500 && ahead <= 3600, `${ahead}`); assert.deepEqual(Object.keys(typed).sort(), ['account', 'domain', 'message', 'primaryType', 'types'])
  const decoded = d.decodeAdapterExecute(r.sends[0].data).call; assert.equal(decoded.tokenInputs[0].permitType, 1); assert.equal(r.sends.length, 1)
})
await test('REAL SDK: the transactions it hands the wallet carry exactly the fields the guard accepts (account, chain, to, data, kzg undefined, gas override) and nothing else', async () => {
  const r = await direct({ tokenIn: 'EURC', strategy: 'approve' })
  assert.equal(r.error, undefined); assert.equal(r.sends.length, 2)
  // the guard rebuilt each request from checked values; the SDK's own had only keys in the allow-list (otherwise the guard would have refused with extra_field)
  assert.deepEqual(r.log.map(entry => entry[0]), ['sent', 'sent']); for (const send of r.sends) { assert.deepEqual(Object.keys(send).sort(), ['account', 'data', 'gas', 'maxFeePerGas', 'maxPriorityFeePerGas', 'nonce', 'to', 'type', 'value']); assert.equal(send.account, owner) }
})
await test('REAL SDK end to end with the controller and the real read path: Review, approval step, swap step, journal and Pending, with the SDK left running in the background', async () => {
  service.tweak = undefined
  const f = setup({ tokenIn: 'EURC', tokenOut: 'USDC', real: true, now: realNow() }), id = await f.review(); await f.run(id)
  const view = f.controller.current(); assert.equal(view.phase, 'pending'); assert.deepEqual(view.attempt.steps.map(step => [step.kind, step.status]), [['approve', 'confirmed'], ['swap', 'pending']])
  assert.ok(f.world.rpcCalls.includes('eth_getTransactionReceipt')); assert.ok(f.world.rpcCalls.includes('eth_estimateGas')); assert.ok(f.world.rpcCalls.every(method => ['eth_chainId', 'eth_blockNumber', 'eth_getBlockByNumber', 'eth_gasPrice', 'eth_maxPriorityFeePerGas', 'eth_estimateGas', 'eth_getTransactionCount', 'eth_getCode', 'eth_getBalance', 'eth_call', 'eth_getTransactionReceipt'].includes(method)))
  for (const method of new Set(f.world.rpcCalls)) assert.doesNotThrow(() => c.assertCircleExecutionReadMethod(method), method) // the adapter's public client needs nothing outside the read-only allow-list
  assert.equal(f.records()[0].hash, view.attempt.hash)
})
globalThis.fetch = noNetwork
console.log(`\n${count} Circle Swap Kit execution tests passed; ${external} external requests`)
