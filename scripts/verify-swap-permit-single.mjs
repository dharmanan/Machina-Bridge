// Controlled, disposable test-key signatures only. No network, wallet connection, approval or broadcast.
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
const require = createRequire(import.meta.url), ts = require('typescript')
require.extensions['.ts'] = (mod, file) => mod._compile(ts.transpileModule(readFileSync(file, 'utf8'), { fileName: file,
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText, file)
const p = require('../src/lib/uniswapArcPolicy.ts'), permit = require('../src/lib/swap/permitSingle.ts')
const e = require('../src/lib/uniswapArcExecution.ts'), onchain = require('../src/lib/swap/uniswapOnchain.ts')
const { createArcExecutionRpc } = require('../src/lib/uniswapArcExecutionRpc.ts')
const evidence = require('../src/lib/swap/transactionEvidence.ts')
const { privateKeyToAccount } = require('viem/accounts')
const { decodeFunctionData, encodeFunctionData, encodeAbiParameters, keccak256, toHex, decodeAbiParameters } = require('viem')
const account = privateKeyToAccount('0x' + '00'.repeat(31) + '01'), owner = account.address
const other = privateKeyToAccount('0x' + '00'.repeat(31) + '02')
const NOW = 1_800_000_000_000, TS = BigInt(NOW / 1000), HASH = '0x' + 'ab'.repeat(32)
const runtime = readFileSync(new URL('./fixtures/uniswap-arc/router-runtime.hex', import.meta.url), 'utf8').trim()
let count = 0, network = 0
const realFetch = globalThis.fetch
globalThis.fetch = async () => { network++; throw Error('external_network_forbidden') }
async function test(name, run) { await run(); count++; console.log('PASS', name) }
const request = p.validateArcRequest({ chainId: 5042, owner, recipient: owner, tokenIn: 'EURC', tokenOut: 'USDC', amount: '1', slippageBps: 50, minimumOutput: '1', maxNetworkFee: '100000000000000000' })
const context = { owner, connected: true, chainId: 5042, connectorId: 'test' }
const review = await onchain.createOnchainReview(request, { now: () => NOW, chain: async () => ({ blockNumber: 1n, timestamp: TS, gasPrice: 20_000_000_000n, nativeBalance: 10n ** 20n, routerHash: p.ARC_ROUTER_HASH }),
  simulate: async () => ({ spent: 1_000_000n, received: 1_119_200n, gas: 140_000n }) }, context)
const message = permit.permitMessage(review, 7, TS)
const typed = { domain: permit.PERMIT_DOMAIN, types: permit.PERMIT_SINGLE_TYPES, primaryType: 'PermitSingle', message }
const signature = await account.signTypedData(typed)
const signed = await permit.attachPermit(review, 7, TS, signature)
function rawSigned(message, signature, commands = '0x0a00', swap = decodeFunctionData({ abi: p.EXECUTE_ABI, data: review.transaction.data }).args[1][0]) {
  return encodeFunctionData({ abi: p.EXECUTE_ABI, functionName: 'execute', args: [commands, [encodeAbiParameters(permit.PERMIT_INPUT, [message, signature]), swap], message.sigDeadline] })
}
for (const [symbol, amount] of [['EURC', '1'], ['WETH', '0.0003'], ['cirBTC', '0.00001']]) {
  await test(`${symbol}: excessive and unlimited existing token allowances are explicitly disclosed, exact/short allowances need no warning`, () => {
    const r = { ...request, tokenIn: symbol, amount }, need = p.tokenUnits(amount, p.ARC_TOKENS[symbol].decimals)
    assert.equal(permit.existingAllowanceNotice(r, need), null); assert.equal(permit.existingAllowanceNotice(r, need - 1n), null)
    assert.match(permit.existingAllowanceNotice(r, need + 1n), /above this swap amount/)
    const notice = permit.existingAllowanceNotice(r, 2n ** 256n - 1n)
    assert.match(notice, /unlimited/); assert.ok(notice.includes(`${symbol} → Permit2`)); assert.ok(notice.includes(`only ${amount} ${symbol}`))
    assert.match(notice, /without another approval/); assert.match(notice, /not be automatically increased or revoked/); assert.match(notice, /at most 120 seconds/)
  })
}
await test('valid canonical PermitSingle binds the exact Arc token, router, amount, nonce and both deadlines', async () => {
  await permit.validatePermitCalldata(review, signed, 7, TS)
  assert.equal(decodeFunctionData({ abi: p.EXECUTE_ABI, data: signed }).args[0], '0x0a00')
  assert.equal(message.details.amount, 1_000_000n); assert.equal(message.details.expiration, Number(message.sigDeadline))
})
for (const [label, changed] of [['chain', { ...permit.PERMIT_DOMAIN, chainId: 1 }], ['contract', { ...permit.PERMIT_DOMAIN, verifyingContract: p.ARC_ROUTER }], ['name', { ...permit.PERMIT_DOMAIN, name: 'NotPermit2' }]]) {
  await test(`a signature for the wrong domain ${label} is rejected`, async () => {
    const sig = await account.signTypedData({ ...typed, domain: changed })
    await assert.rejects(permit.attachPermit(review, 7, TS, sig))
  })
}
for (const [label, changed] of [
  ['spender', { ...message, spender: other.address }], ['amount', { ...message, details: { ...message.details, amount: 2_000_000n } }],
  ['token', { ...message, details: { ...message.details, token: p.ARC_TOKENS.WETH.address } }], ['nonce', { ...message, details: { ...message.details, nonce: 8 } }],
  ['expiration', { ...message, details: { ...message.details, expiration: Number(TS) + 3600 } }], ['signature deadline', { ...message, sigDeadline: TS + 3600n }],
]) await test(`even a valid signature for changed ${label} fails the exact reviewed binding`, async () => {
  const sig = await account.signTypedData({ ...typed, message: changed })
  await assert.rejects(permit.validatePermitCalldata(review, rawSigned(changed, sig), 7, TS))
})
await test('wrong signer, malformed or modified signature, stale nonce and expired permit all fail closed', async () => {
  await assert.rejects(permit.attachPermit(review, 7, TS, await other.signTypedData(typed)))
  for (const sig of ['0x', signature.slice(0, -2), signature.replace(/^0x../, '0xff')]) await assert.rejects(permit.attachPermit(review, 7, TS, sig))
  await assert.rejects(permit.validatePermitCalldata(review, signed, 8, TS))
  await assert.rejects(permit.validatePermitCalldata(review, signed, 7, TS + 120n))
})
await test('extra commands, allow-revert bits, suffixes, manipulated recipient and weaker minimum are rejected', async () => {
  for (const commands of ['0x0a06', '0x8a00', '0x000a']) await assert.rejects(permit.validatePermitCalldata(review, rawSigned(message, signature, commands), 7, TS))
  await assert.rejects(permit.validatePermitCalldata(review, signed + '00', 7, TS))
  const { V3_INPUT } = p, base = decodeFunctionData({ abi: p.EXECUTE_ABI, data: review.transaction.data }).args
  const { decodeAbiParameters } = require('viem')
  const values = decodeAbiParameters(V3_INPUT, base[1][0])
  for (const swap of [encodeAbiParameters(V3_INPUT, [other.address, ...values.slice(1)]), encodeAbiParameters(V3_INPUT, [values[0], values[1], 1n, ...values.slice(3)])])
    await assert.rejects(permit.validatePermitCalldata(review, rawSigned(message, signature, '0x0a00', swap), 7, TS))
})
function fixture(options = {}) {
  const world = { time: NOW, nonce: 3, permitNonce: 7, tokenAllowance: 1_000_000n, sends: [], signs: [], calls: [], estimates: 150_000n, ctx: { ...context }, ...options }
  const input = p.validateArcRequest({ ...request, amount: world.amount ?? '1' }), inputUnits = p.tokenUnits(input.amount, 6)
  const data = new Map(), storage = { getItem: key => data.get(key) ?? null, setItem: (key, value) => data.set(key, value) }
  const rpc = { getChainId: async () => 5042, getBlockNumber: async () => 1n, getBlock: async () => ({ timestamp: BigInt(Math.floor(world.time / 1000)), baseFeePerGas: 20_000_000_000n }),
    getCode: async ({ address }) => p.sameAddress(address, p.ARC_ROUTER) ? runtime : p.sameAddress(address, owner) ? '0x' : '0x6000',
    readContract: async ({ address, functionName }) => functionName === 'decimals' ? 6 : functionName === 'balanceOf' ? world.tokenBalance ?? 5_000_000n : p.sameAddress(address, p.ARC_PERMIT2) ? [0n, 0, world.permitNonce] : world.tokenAllowance,
    getBalance: async () => 10n ** 20n, getGasPrice: async () => 20_000_000_000n,
    getTransactionCount: async () => world.nonce, call: async call => { world.calls.push(call); if (world.simulationFails) throw Error('reverted'); return { data: '0x' } }, estimateGas: async () => world.estimates }
  const adapter = createArcExecutionRpc(rpc)
  const provider = { request: async ({ method, params }) => {
    if (method === 'eth_chainId') return '0x13b2'; if (method === 'eth_accounts') return [owner]
    if (method === 'eth_getTransactionCount') return toHex(world.walletNonce ?? world.nonce)
    if (method === 'eth_signTypedData_v4') {
      world.signs.push(params); if (world.reject) throw Object.assign(Error('private error'), { code: 4001 })
      world.time += world.signDelay ?? 0; const payload = JSON.parse(params[1]); delete payload.types.EIP712Domain
      if (world.signOutput !== undefined) world.output = world.signOutput
      if (world.failFreshAfterSign) world.freshFails = true
      if (world.changePermitNonce) world.permitNonce++
      if (world.changeTokenAllowance) world.tokenAllowance = 2n ** 256n - 1n
      if (world.changeContext) world.ctx = { ...world.ctx, chainId: 1 }
      if (world.changePublicNonce) { world.nonce++; world.walletNonce = 3 }
      return account.signTypedData(payload)
    }
    if (method === 'eth_sendTransaction') { world.sends.push(params[0]); return HASH }
    throw Error('unexpected method')
  } }
  const ports = { context: () => world.ctx, input: () => input, fresh: async () => {
      if (world.freshFails) throw Error('quote_unavailable')
      return onchain.createOnchainReview(input, { now: () => world.time, chain: async () => ({ blockNumber: 1n, timestamp: BigInt(Math.floor(world.time / 1000)), gasPrice: 20_000_000_000n, nativeBalance: 10n ** 20n, routerHash: p.ARC_ROUTER_HASH }),
        simulate: async () => ({ spent: inputUnits, received: world.output ?? inputUnits * 11192n / 10000n, gas: 140_000n }) }, world.ctx)
    }, quoteNow: () => world.time,
    preflight: adapter.preflight, signPermit: adapter.signPermit, provider: async () => provider, result: async () => ({ status: 'pending', identified: true }),
    storage, lock: async (_owner, run) => run(), enabled: () => true, authorize: () => true }
  return { world, data, storage, adapter, controller: e.createUniswapArcExecution(ports), ports }
}
await test('existing token allowance: Review requests nothing; Confirm signs once and sends only the exact simulated atomic swap', async () => {
  const f = fixture(); await f.controller.prepare(); assert.equal(f.controller.current().phase, 'review')
  assert.equal(f.world.signs.length, 0); assert.equal(f.world.sends.length, 0)
  await f.controller.confirm(f.controller.current().approvalId)
  assert.equal(f.controller.current().permitSigned, true); assert.equal(f.world.sends.length, 0)
  await f.controller.confirm(f.controller.current().approvalId)
  assert.equal(f.world.signs.length, 1); assert.equal(f.world.sends.length, 1); assert.equal(f.world.calls.length, 2)
  assert.equal(f.world.calls[0].stateOverride, undefined); assert.equal(f.world.calls[0].data, f.world.sends[0].data)
  const record = e.createExecutionJournal(f.storage).read(owner)[0]
  assert.equal(record.submittedCalldataHash, keccak256(f.world.sends[0].data)); assert.equal(record.review.transaction.data.toLowerCase(), review.transaction.data.toLowerCase())
  const actualSignature = (await account.signTypedData(JSON.parse(f.world.signs[0][1])))
  assert.equal([...f.data.values()].some(value => value.includes(actualSignature.slice(2))), false)
  await f.controller.confirm(f.controller.current().approvalId); assert.equal(f.world.sends.length, 1)
  const recovered = e.createUniswapArcExecution(f.ports); await recovered.prepare(); assert.equal(recovered.current().phase, 'pending'); assert.equal(f.world.sends.length, 1)
})
for (const [label, options] of [
  ['broader token allowance appears while signing', { changeTokenAllowance: true }], ['missing token allowance', { tokenAllowance: 0n }], ['signature rejected', { reject: true }], ['signed deadline lacks wallet/mining time', { signDelay: 76_000 }],
  ['Permit2 nonce changes while signing', { changePermitNonce: true }], ['public/wallet nonce disagree', { walletNonce: 4 }], ['network changes while signing', { changeContext: true }], ['public/wallet diverge after signing', { changePublicNonce: true }],
  ['signed simulation reverts', { simulationFails: true }], ['signed gas exceeds Review limit', { estimates: 2_000_001n }],
]) await test(`${label}: no transaction and no on-chain Permit2 fallback`, async () => {
  const f = fixture(options); await f.controller.prepare(); if (f.controller.current().phase === 'review') await f.controller.confirm(f.controller.current().approvalId)
  assert.equal(f.world.sends.length, 0)
  const blocked = f.controller.current()
  if (blocked.phase === 'review') { assert.equal(blocked.recheckRequired, true); await f.controller.confirm(blocked.approvalId); assert.equal(f.world.sends.length, 0) }
  else assert.equal(blocked.phase, 'idle')
})
await test('unlimited pre-existing allowance is disclosed in fresh Review, reused unchanged, and still produces one exact short-lived signature and only the router transaction', async () => {
  const unlimited = 2n ** 256n - 1n, f = fixture({ tokenAllowance: unlimited })
  await f.controller.prepare(); assert.match(f.controller.current().allowanceNotice, /unlimited/)
  await f.controller.confirm(f.controller.current().approvalId)
  assert.equal(f.world.sends.length, 0); await f.controller.confirm(f.controller.current().approvalId)
  assert.equal(f.world.tokenAllowance, unlimited); assert.equal(f.world.sends.length, 1); assert.ok(p.sameAddress(f.world.sends[0].to, p.ARC_ROUTER))
  assert.equal(f.world.signs.length, 1); const signedPermit = JSON.parse(f.world.signs[0][1]).message
  assert.equal(BigInt(signedPermit.details.amount), 1_000_000n); assert.ok(BigInt(signedPermit.details.expiration) <= TS + 120n)
  assert.equal(BigInt(signedPermit.details.expiration), BigInt(signedPermit.sigDeadline))
})
await test('an undisclosed broader allowance appearing after Review stops before requesting a signature or transaction', async () => {
  const f = fixture(); await f.controller.prepare(); assert.equal(f.controller.current().allowanceNotice, undefined)
  f.world.tokenAllowance = 2n ** 256n - 1n; await f.controller.confirm(f.controller.current().approvalId)
  assert.equal(f.world.signs.length, 0); assert.equal(f.world.sends.length, 0); assert.match(f.controller.current().error, /allowance changed/)
})
await test('simultaneous Confirm clicks produce one signature and one send, and bad stored commitments cannot recover as authority', async () => {
  const f = fixture(); await f.controller.prepare(); const id = f.controller.current().approvalId
  await Promise.all([f.controller.confirm(id), f.controller.confirm(id)])
  assert.equal(f.world.sends.length, 0)
  const finalId = f.controller.current().approvalId
  await Promise.all([f.controller.confirm(finalId), f.controller.confirm(finalId)])
  assert.equal(f.world.signs.length, 1); assert.equal(f.world.sends.length, 1)
  const key = [...f.data.keys()][0], stored = JSON.parse(f.data.get(key)); stored[0].submittedCalldataHash = '0x1234'; f.data.set(key, JSON.stringify(stored))
  assert.throws(() => e.createExecutionJournal(f.storage).read(owner), /storage/)
})
for (const delay of [31_000, 45_000]) await test(`a ${delay / 1000}s signature refreshes the 30s price, preserves the original deadline/ceiling/minimum, and requires a final Confirm`, async () => {
  const f = fixture({ signDelay: delay, signOutput: 1_230_000n }); await f.controller.prepare()
  const original = f.controller.current().review
  await f.controller.confirm(f.controller.current().approvalId)
  const next = f.controller.current(); assert.equal(next.phase, 'review'); assert.equal(next.permitSigned, true)
  assert.equal(f.world.sends.length, 0); assert.ok(next.review.expiresAt > f.world.time)
  assert.notEqual(next.review.estimatedOutput, original.estimatedOutput); assert.equal(next.review.estimatedOutput, '1230000')
  assert.equal(e.executionDeadlineMs(next.review), e.executionDeadlineMs(original)); assert.equal(next.review.networkFee, original.networkFee)
  assert.ok(BigInt(next.review.requiredMinimum) >= BigInt(original.requiredMinimum)); assert.equal(next.review.estimatedNetworkFee, '3000000000000000')
  await f.controller.confirm(next.approvalId); assert.equal(f.world.sends.length, 1); assert.equal(f.world.signs.length, 1)
  const sent = f.world.sends[0], outer = decodeFunctionData({ abi: p.EXECUTE_ABI, data: sent.data }).args
  const finalSwap = decodeAbiParameters(p.V3_INPUT, outer[1][1])
  assert.equal(finalSwap[2].toString(), next.review.requiredMinimum)
  assert.equal(outer[1][1], decodeFunctionData({ abi: p.EXECUTE_ABI, data: next.review.transaction.data }).args[1][0])
  assert.equal(f.world.calls.at(-1).data, sent.data); assert.equal(outer[2], message.sigDeadline)
  const [signedMessage] = decodeAbiParameters(permit.PERMIT_INPUT, outer[1][0])
  assert.equal(signedMessage.details.amount, message.details.amount); assert.equal(signedMessage.sigDeadline, message.sigDeadline)
  await permit.validatePermitCalldata(next.review, sent.data, 7, BigInt(f.world.time / 1000))
})
await test('an expired refreshed price requires explicit refresh; the same live permission is reused without another signature', async () => {
  const f = fixture(); await f.controller.prepare(); await f.controller.confirm(f.controller.current().approvalId)
  f.world.time += 31_000; await f.controller.refresh()
  assert.equal(f.controller.current().phase, 'review'); assert.equal(f.world.signs.length, 1); assert.equal(f.world.sends.length, 0)
  await f.controller.confirm(f.controller.current().approvalId); assert.equal(f.world.sends.length, 1)
})
for (const mode of ['price', 'rpc', 'expiry', 'nonce', 'account']) await test(`post-sign ${mode} change stops before any send`, async () => {
  const f = fixture(); await f.controller.prepare(); await f.controller.confirm(f.controller.current().approvalId)
  if (mode === 'price') f.world.output = 900_000n
  if (mode === 'rpc') f.world.freshFails = true
  if (mode === 'expiry') f.world.time += 121_000
  if (mode === 'nonce') f.world.nonce++
  if (mode === 'account') f.world.ctx = { ...f.world.ctx, owner: other.address }
  await f.controller.refresh(); assert.equal(f.world.sends.length, 0)
  const blocked = f.controller.current()
  if (blocked.phase === 'review') { assert.equal(blocked.recheckRequired, true); await f.controller.confirm(blocked.approvalId); assert.equal(f.world.sends.length, 0) }
  else assert.equal(blocked.phase, 'idle')
})
for (const afterSign of [false, true]) await test(`transient price RPC failure ${afterSign ? 'immediately after signing' : 'on return'} retains permission, disables Confirm and recovers without a second signature`, async () => {
  const f = fixture({ failFreshAfterSign: afterSign }); await f.controller.prepare(); await f.controller.confirm(f.controller.current().approvalId)
  if (!afterSign) { f.world.freshFails = true; await f.controller.refresh() }
  const paused = f.controller.current(); assert.equal(paused.phase, 'review'); assert.equal(paused.recheckRequired, true); assert.equal(paused.permitSigned, true)
  await f.controller.confirm(paused.approvalId); assert.equal(f.world.sends.length, 0)
  f.world.freshFails = false; await f.controller.refresh()
  assert.equal(f.controller.current().recheckRequired, undefined); assert.equal(f.world.signs.length, 1)
  await f.controller.confirm(f.controller.current().approvalId); assert.equal(f.world.sends.length, 1)
})
await test('Retry review cannot forget a higher nonce observed while retaining the same signed intent', async () => {
  const f = fixture(); await f.controller.prepare(); await f.controller.confirm(f.controller.current().approvalId)
  f.world.nonce = 4; f.world.walletNonce = 3; await f.controller.refresh()
  assert.equal(f.controller.current().recheckRequired, true)
  f.world.nonce = 3; await f.controller.refresh()
  assert.equal(f.controller.current().recheckRequired, true); assert.match(f.controller.current().error, /moved backwards/)
  await f.controller.confirm(f.controller.current().approvalId); assert.equal(f.world.sends.length, 0)
})
await test('early and mined integrity comparisons use only the signed calldata commitment; mutations remain mismatches', async () => {
  const reviewed = { owner, recipient: owner, router: p.ARC_ROUTER, chainId: 5042, nonce: 3, value: 0n, calldata: review.transaction.data, calldataHash: keccak256(signed),
    gasLimit: BigInt(review.gasLimit), maxFeePerGas: BigInt(review.maxFeePerGas), maxPriorityFeePerGas: 0n, feeCeiling: BigInt(review.networkFee), outputToken: p.ARC_TOKENS.USDC.address, requiredMinimum: BigInt(review.requiredMinimum), outputSymbol: 'USDC', outputDecimals: 6 }
  const tx = { hash: HASH, from: owner, to: p.ARC_ROUTER, chainId: 5042, nonce: 3, type: 'eip1559', value: 0n, gas: reviewed.gasLimit, maxFeePerGas: reviewed.maxFeePerGas, maxPriorityFeePerGas: 0n, input: signed }
  const args = { attemptHash: HASH, tx, receipt: null, observation: { canonical: false, latestBlock: 0n, blockTimestamp: null }, reviewed, received: null }
  assert.equal(evidence.compareToReview(args).verdict, 'incomplete')
  assert.equal(evidence.compareToReview({ ...args, tx: { ...tx, input: signed + '00' } }).verdict, 'mismatch')
  const blockHash = '0x' + 'bc'.repeat(32), receipt = { transactionHash: HASH, from: owner, to: p.ARC_ROUTER, status: 'success', blockNumber: 1n, blockHash, transactionIndex: 0, gasUsed: 150_000n, effectiveGasPrice: 20_000_000_000n, logs: [] }
  const mined = { ...args, receipt, observation: { canonical: true, latestBlock: 2n, blockTimestamp: TS + 1n }, received: BigInt(review.estimatedOutput) }
  assert.equal(evidence.compareToReview(mined).verdict, 'verified')
  assert.equal(evidence.compareToReview({ ...mined, tx: { ...tx, input: signed + '00' } }).verdict, 'mismatch')
})
await test('large exact PermitSingle amounts survive signature encoding and reject any minimum or amount mutation', async () => {
  for (const value of ['1000.123456', '9007199254740993.123456']) {
    const input = p.validateArcRequest({ ...request, amount: value }), units = p.tokenUnits(value, 6)
    const big = await onchain.createOnchainReview(input, { now: () => NOW, chain: async () => ({ blockNumber: 1n, timestamp: TS, gasPrice: 20_000_000_000n, nativeBalance: 10n ** 20n, routerHash: p.ARC_ROUTER_HASH }),
      simulate: async () => ({ spent: units, received: units * 11n / 10n, gas: 140_000n }) }, context)
    const msg = permit.permitMessage(big, 7, TS), sig = await account.signTypedData({ ...typed, message: msg })
    const data = await permit.attachPermit(big, 7, TS, sig)
    await permit.validatePermitCalldata(big, data, 7, TS)
    assert.equal(msg.details.amount, units); assert.equal(msg.sigDeadline, TS + 120n)
    await assert.rejects(permit.validatePermitCalldata({ ...big, request: { ...big.request, amount: require('viem').formatUnits(units + 1n, 6) } }, data, 7, TS))
    await assert.rejects(permit.validatePermitCalldata({ ...big, requiredMinimum: (BigInt(big.requiredMinimum) + 1n).toString() }, data, 7, TS))
  }
})
await test('large input completes preflight, explicit signature, signed simulation and exactly one explicit send; insufficient funds still stop before signing', async () => {
  const amount = '9007199254740993.123456', need = p.tokenUnits(amount, 6)
  const f = fixture({ amount, tokenAllowance: need, tokenBalance: need })
  await f.controller.prepare(); assert.equal(f.controller.current().phase, 'review')
  assert.equal(f.world.signs.length, 0); assert.equal(f.world.sends.length, 0)
  await f.controller.confirm(f.controller.current().approvalId)
  assert.equal(f.controller.current().permitSigned, true); assert.equal(f.world.sends.length, 0)
  assert.equal(BigInt(JSON.parse(f.world.signs[0][1]).message.details.amount), need)
  await f.controller.confirm(f.controller.current().approvalId)
  assert.equal(f.world.sends.length, 1); assert.equal(f.world.calls.length, 2)
  assert.equal(f.world.calls[0].data, f.world.sends[0].data)
  const missing = fixture({ amount, tokenAllowance: need, tokenBalance: need - 1n })
  await missing.controller.prepare(); assert.equal(missing.controller.current().phase, 'idle')
  assert.equal(missing.world.signs.length, 0); assert.equal(missing.world.sends.length, 0)
})
assert.equal(network, 0); globalThis.fetch = realFetch
console.log(`${count} PermitSingle/security groups PASS; disposable local test-key signatures only, zero external RPC or broadcasts.`)
