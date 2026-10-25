// Official 1.19.0 /next package must be supplied outside the application's dependency tree.
// Every client below is a test double. No real provider, RPC, signature or transaction is used.
import assert from 'node:assert/strict'
import { pathToFileURL } from 'node:url'
import { readFileSync } from 'node:fs'
import { getChainByEnum, Blockchain } from '@circle-fin/borrow-kit'
import { decodeFunctionData, parseAbi } from 'viem'
const packageRoot = process.env.BORROW_ADAPTER_119_PATH
if (!packageRoot) throw new Error('Supply an isolated official 1.19.0 package; do not update shared dependencies.')
assert.equal(JSON.parse(readFileSync(packageRoot + '/package.json')).version, '1.19.0')
const sdk = await import(pathToFileURL(packageRoot + '/next.mjs'))
const chain = getChainByEnum(Blockchain.Arc), owner = '0x' + '11'.repeat(20), hash = '0x' + 'aa'.repeat(32)
const abi = parseAbi(['function aggregate3((address target,bool allowFailure,bytes callData)[] calls) payable returns ((bool success,bytes returnData)[] returnData)'])
let count = 0
async function test(name, work) { await work(); count++; console.log('PASS ' + name) }
function build(mode = 'eoa') {
  const sends = [], wallet = { account: { address: owner, type: 'json-rpc' }, getChainId: async () => 5042, getCapabilities: async () => ({}), sendTransaction: async p => { sends.push(p); return hash } }
  const publicClient = { getCode: async ({ address }) => address.toLowerCase() === owner ? mode === 'contract' ? '0x6000' : '0x' : mode === 'missing' ? '0x' : '0x6000', estimateGas: async () => 100000n,
    waitForTransactionReceipt: async () => { if (mode === 'timeout') throw new Error('controlled timeout'); return { status: 'success', logs: [] } } }
  const ctx = sdk.createViemAdapterContext({ capabilities: { addressContext: 'user-controlled', supportedChains: [chain] }, getWalletClient: () => wallet, getPublicClient: () => publicClient })
  return { adapter: sdk.createViemAdapterFromContext(ctx), sends }
}
const calls = [{ to: chain.kitContracts.adapter, data: '0x12345678', value: 0n }]
await test('EOA without wallet EIP-5792 is offered deployed sender-preserving batcher', async () => {
  assert.equal(await build().adapter.supportsAtomicBatch(chain), true)
})
await test('contract account / missing batcher are not misclassified as EOA support', async () => {
  assert.equal(await build('contract').adapter.supportsAtomicBatch(chain), false)
  assert.equal(await build('missing').adapter.supportsAtomicBatch(chain), false)
})
await test('fromAddress must match the actual bound wallet', async () => {
  await assert.rejects(build().adapter.supportsAtomicBatch(chain, { fromAddress: '0x' + '22'.repeat(20) }))
})
await test('one aggregate3 with allowFailure=false preserves atomicity; no sequential fallback', async () => {
  const x = build(); const result = await x.adapter.batchExecute(calls, chain, { atomicRequired: true })
  assert.equal(x.sends.length, 1); assert.equal(result.batchId, hash)
  const decoded = decodeFunctionData({ abi, data: x.sends[0].data }); assert.equal(decoded.args[0][0].allowFailure, false)
  assert.equal(decoded.args[0][0].target.toLowerCase(), calls[0].to.toLowerCase())
  // No enforceable fee-price cap is attached by this SDK API path.
  assert.equal(x.sends[0].maxFeePerGas, undefined); assert.equal(x.sends[0].gasPrice, undefined)
})
await test('native value is rejected before any send', async () => {
  const x = build(); await assert.rejects(x.adapter.batchExecute([{ ...calls[0], value: 1n }], chain)); assert.equal(x.sends.length, 0)
})
await test('confirmation timeout retains the already-broadcast hash; no second send', async () => {
  const x = build('timeout'), result = await x.adapter.batchExecute(calls, chain)
  assert.equal(result.batchId, hash); assert.ok(result.error); assert.equal(x.sends.length, 1)
})
console.log(`RESULT ${count}/${count} PASS; isolated SDK, synthetic clients only. MetaMask/Mainnet compatibility remains unverified.`)
