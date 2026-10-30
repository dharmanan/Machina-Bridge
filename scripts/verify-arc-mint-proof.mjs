// Arc destination (mint) transaction proof for Sui -> Arc transfers. Offline:
// a controlled Arc client serves the REAL receipts and Circle messages of the
// two real transfers (fixtures/real-arc-mints.json). No network.
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
const require = createRequire(import.meta.url), ts = require('typescript')
require.extensions['.ts'] = (m, p) => m._compile(ts.transpileModule(readFileSync(p, 'utf8').replaceAll('import.meta.env', '({})'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText, p)
const { verifyArcMintTx, findArcMintForMessage, ARC_MINT_SEARCH } = require('../src/lib/arcMintProof.ts')
const REAL = require('./fixtures/real-arc-mints.json')
const [A, B] = REAL.transfers, owner = REAL.evmOwner
let count = 0
async function test(name, run) { await run(); count++; console.log('PASS ' + name) }
const toReceipt = r => ({ ...r, status: r.status === '0x1' ? 'success' : 'reverted', blockNumber: BigInt(r.blockNumber), logs: r.logs })
// Controlled Arc read client: real receipts, canonical block hashes, nonce-filtered logs.
function arc({ receipts = [A, B].map(t => t.receipt), mutate = r => r, logsFail = false, canonical = true } = {}) {
  const calls = { receipt: 0, block: 0, logs: [] }, byHash = new Map(receipts.map(r => [r.transactionHash.toLowerCase(), toReceipt(structuredClone(r))]))
  return { calls,
    getTransactionReceipt: async ({ hash }) => { calls.receipt++; const r = byHash.get(hash.toLowerCase()); if (!r) throw new Error(`Transaction receipt with hash "${hash}" could not be found.`); return mutate(structuredClone(r)) },
    getBlock: async ({ blockNumber }) => { calls.block++; const r = [...byHash.values()].find(x => x.blockNumber === blockNumber); return { number: blockNumber, hash: canonical && r ? r.blockHash : '0x' + 'ee'.repeat(32) } },
    getBlockNumber: async () => 28_580_000n,
    request: async ({ method, params }) => { assert.equal(method, 'eth_getLogs'); if (logsFail) throw new Error('HTTP 429'); const [f] = params; calls.logs.push(f); assert.equal(f.topics.length, 3); assert.ok(BigInt(f.toBlock) - BigInt(f.fromBlock) < ARC_MINT_SEARCH.windowBlocks)
      return [...byHash.values()].filter(r => BigInt(f.fromBlock) <= r.blockNumber && r.blockNumber <= BigInt(f.toBlock)).flatMap(r => r.logs.filter(l => l.address.toLowerCase() === f.address.toLowerCase() && l.topics[0] === f.topics[0] && l.topics[2] === f.topics[2]).map(l => ({ ...l, transactionHash: r.transactionHash }))) },
  }
}

await test('the real mints verify against their own Circle messages (8nmDq8Hj… -> 0x363bea9d…, 4u5Nd9c7… -> 0x4ef7796c…)', async () => {
  for (const t of [A, B]) assert.equal(await verifyArcMintTx(arc(), t.destination, t.message, owner), true, t.source)
  assert.equal(A.destination, '0x363bea9d7e221073e48268aaa50d3b8245115bf3fec28b41c6103b3cb3ed44e7')
  assert.equal(B.destination, '0x4ef7796c41ca2c2470e862a12db388622a7e57957096b2eccba4f50155482add')
})
await test('another transfer\'s mint, another owner, a reverted or non-canonical receipt and an unknown hash are never accepted', async () => {
  assert.equal(await verifyArcMintTx(arc(), B.destination, A.message, owner), false, 'wrong nonce / message')
  assert.equal(await verifyArcMintTx(arc(), A.destination, A.message, '0x' + '11'.repeat(20)), false, 'other recipient')
  assert.equal(await verifyArcMintTx(arc({ mutate: r => ({ ...r, status: 'reverted' }) }), A.destination, A.message, owner), false, 'reverted')
  assert.equal(await verifyArcMintTx(arc({ canonical: false }), A.destination, A.message, owner), false, 'block hash differs from the canonical block')
  assert.equal(await verifyArcMintTx(arc(), '0x' + 'ab'.repeat(32), A.message, owner), false, 'unknown hash')
  assert.equal(await verifyArcMintTx(arc(), 'not-a-hash', A.message, owner), false)
})
await test('the MessageReceived event must come from MessageTransmitterV2 and MintAndWithdraw must match the attested amount, fee, token and recipient', async () => {
  const mt = '0x81d40f21f12a8f0e3252bccb954d722d4c464b64', tm = '0x28b5a0e9c621a5badaa536219b3a228c8168cf5d'
  const moved = r => ({ ...r, logs: r.logs.map(l => l.address.toLowerCase() === mt ? { ...l, address: '0x' + '99'.repeat(20) } : l) })
  assert.equal(await verifyArcMintTx(arc({ mutate: moved }), A.destination, A.message, owner), false, 'event from another contract')
  const amount = r => ({ ...r, logs: r.logs.map(l => l.address.toLowerCase() === tm ? { ...l, data: '0x' + (99999n).toString(16).padStart(64, '0') + l.data.slice(66) } : l) })
  assert.equal(await verifyArcMintTx(arc({ mutate: amount }), A.destination, A.message, owner), false, 'minted amount differs')
  const noMint = r => ({ ...r, logs: r.logs.filter(l => l.address.toLowerCase() !== tm) })
  assert.equal(await verifyArcMintTx(arc({ mutate: noMint }), A.destination, A.message, owner), false, 'no MintAndWithdraw')
  const doubled = r => ({ ...r, logs: [...r.logs, ...r.logs.filter(l => l.address.toLowerCase() === mt)] })
  assert.equal(await verifyArcMintTx(arc({ mutate: doubled }), A.destination, A.message, owner), false, 'two matching MessageReceived events')
})
await test('lookup order: a correct hint is verified without any log search; a wrong hint falls back to the nonce-filtered search', async () => {
  let c = arc(); assert.deepEqual(await findArcMintForMessage(c, { message: A.message, evmOwner: owner, hints: [A.destination] }), { txHash: A.destination, status: 'verified', checked: 1 }); assert.equal(c.calls.logs.length, 0)
  c = arc(); const r = await findArcMintForMessage(c, { message: A.message, evmOwner: owner, hints: [B.destination, 'garbage', null] })
  assert.equal(r.txHash, A.destination); assert.equal(r.status, 'verified'); assert.ok(c.calls.logs.length >= 1); assert.ok(c.calls.logs.every(f => f.topics[2] === A.eventNonce), 'every log query is filtered by the Circle-attested nonce')
})
await test('search is bounded: at most the configured windows of the RPC log span; not found stays not found', async () => {
  const c = arc({ receipts: [B.receipt] }), r = await findArcMintForMessage(c, { message: A.message, evmOwner: owner })
  assert.deepEqual([r.status, r.txHash], ['not_found', undefined]); assert.equal(c.calls.logs.length, ARC_MINT_SEARCH.maxWindows)
  const span = c.calls.logs.map(f => [BigInt(f.fromBlock), BigInt(f.toBlock)]); for (let n = 1; n < span.length; n++) assert.equal(span[n][1], span[n - 1][0] - 1n, 'contiguous, newest first')
})
await test('RPC failures and ambiguity report "unavailable", never a hash', async () => {
  assert.deepEqual(await findArcMintForMessage(arc({ logsFail: true }), { message: A.message, evmOwner: owner }), { status: 'unavailable', checked: 0 })
  // Two different verified transactions for one message: blocked, no random choice.
  const twin = { ...A.receipt, transactionHash: '0x' + 'cd'.repeat(32) }
  const r = await findArcMintForMessage(arc({ receipts: [A.receipt, twin] }), { message: A.message, evmOwner: owner, hints: [A.destination, twin.transactionHash] })
  assert.deepEqual([r.status, r.txHash], ['unavailable', undefined])
})
await test('recovery: a used Arc nonce stays complete; destinationTx is set only for a proven mint', async () => {
  const { fixture } = require('./fixtures/sui-mainnet-recovery.cjs'), c = require('../src/lib/mainnetSuiRecovery.ts')
  globalThis.window ??= { localStorage: { getItem: () => null, setItem() {} } }
  const x = fixture(); x.evm.readContract = async () => 1n
  const plain = await c.inspectSuiMainnetRecovery(x.input, { sui: x.port, arc: x.evm, fetcher: x.fetcher })
  assert.equal(plain.stage, 'complete'); assert.equal(plain.destinationTx, undefined, 'no proof, no hash and no invented link')
  const withHint = await c.inspectSuiMainnetRecovery({ ...x.input, destinationHints: [A.destination] }, { sui: x.port, arc: { ...x.evm, ...arc() , getChainId: x.evm.getChainId, readContract: x.evm.readContract, getBlock: async a => a?.blockNumber !== undefined && a.blockNumber !== 100n ? arc().getBlock(a) : x.evm.getBlock() }, fetcher: x.fetcher })
  assert.equal(withHint.stage, 'complete'); assert.equal(withHint.destinationTx, undefined, 'a real mint of ANOTHER message is not accepted for this transfer')
  assert.equal('destinationHints' in withHint, false, 'hints are not stored in the record')
})
console.log(`RESULT ${count}/${count} Arc mint proof groups PASS; real receipts and Circle messages of 2 Sui -> Arc transfers; no network.`)
