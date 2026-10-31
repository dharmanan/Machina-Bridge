// Arc -> Solana: (1) the typed amount is normalized once ("0,1" -> "0.1") and ambiguous
// input is refused; (2) the real Bridge Kit burn 0xb2099a7f…bf50ad is proven for its
// wallet, its Circle message binds to it, and the recent-burn scan offers a mint only
// with full CCTP evidence. Offline: real receipt and Circle response from fixtures.
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
const require = createRequire(import.meta.url), ts = require('typescript')
require.extensions['.ts'] = (m, f) => m._compile(ts.transpileModule(readFileSync(f, 'utf8').replaceAll('import.meta.env', '({})'), { fileName: f, compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText, f)
const { parseUsdcAmountInput } = require('../src/lib/usdcAmountInput.ts')
const { readCctpBurnProof, readBoundCctpAttestation, CIRCLE_KIT_BRIDGE_CONTRACT } = require('../src/lib/mainnetCctpRecovery.ts')
const { classifyArcSolanaBurn, keyedSingleFlight } = require('../src/lib/arcSolanaBurnScan.ts')
const { SolanaNoncePendingError } = require('../src/lib/mainnetSolanaRecovery.ts')
const REAL = JSON.parse(readFileSync(new URL('./fixtures/real-arc-solana-bridgekit-burn.json', import.meta.url), 'utf8'))
const USER = REAL.tx.from, ATA_HEX = '0xf99b03cf03d7e41ba2db805bfaebbd7d8094e7e7128c868c17b9ca5275d85ce6', OTHER = '0x' + '11'.repeat(20)
let count = 0
async function test(name, fn) { await fn(); count++; console.log('PASS ' + name) }

await test('amount input: comma and point decimals give one canonical value with exact 6-decimal units', () => {
  for (const [input, value, raw] of [['0,1', '0.1', 100000n], ['0.1', '0.1', 100000n], ['0,000001', '0.000001', 1n], [',5', '0.5', 500000n], ['12,5', '12.5', 12500000n], ['0,100', '0.1', 100000n], [' 2,25 ', '2.25', 2250000n], ['3', '3', 3000000n]]) {
    const r = parseUsdcAmountInput(input); assert.deepEqual([r.value, r.raw], [value, raw], input)
  }
})
await test('amount input: thousand separators, both/repeated separators, >6 decimals, zero and ambiguous groups are refused', () => {
  for (const input of ['1.000,5', '1,000.5', '1,000,000', '1 000', '1.2.3', '0,0000001', '0', '0,0', '', '1,', 'abc', '-1', '1e3', '1,500', '1.500', '25,000']) assert.ok('error' in parseUsdcAmountInput(input), input)
  assert.match(parseUsdcAmountInput('1,500').error, /ambiguous.*Write 1,5/)
})

const toBig = r => ({ ...r, blockNumber: BigInt(r.blockNumber), logs: r.logs.map(l => ({ ...l, blockNumber: BigInt(l.blockNumber) })) })
function client({ tx = {}, mutateLogs = l => l } = {}) {
  const receipt = toBig(REAL.receipt); receipt.logs = mutateLogs(receipt.logs)
  return { getChainId: async () => 5042, getTransaction: async () => ({ ...REAL.tx, blockNumber: BigInt(REAL.tx.blockNumber), ...tx }), getTransactionReceipt: async () => receipt, getBlock: async () => ({ number: receipt.blockNumber, hash: receipt.blockHash }) }
}
const input = (over = {}) => ({ sourceChainId: 5042, sourceTxHash: REAL.sourceTxHash, owner: USER, mintRecipients: [ATA_HEX], allowCircleKitBridge: true, ...over })

await test('the real Bridge Kit burn is proven for its wallet: depositor is Circle\'s bridge contract, tx.from is the wallet, MessageSent matches', async () => {
  assert.equal(REAL.tx.to.toLowerCase(), CIRCLE_KIT_BRIDGE_CONTRACT.toLowerCase())
  const proof = await readCctpBurnProof(input(), client())
  assert.equal(proof.owner.toLowerCase(), USER.toLowerCase()); assert.equal(proof.amount, '0.1'); assert.equal(proof.fields.destinationDomain, 5)
  assert.equal(proof.fields.mintRecipient.toLowerCase(), ATA_HEX); assert.equal(proof.fields.messageSender.toLowerCase(), '0x' + CIRCLE_KIT_BRIDGE_CONTRACT.slice(2).toLowerCase().padStart(64, '0'))
})
await test('the same receipt is refused for another wallet, for a bridge-contract deposit not called by this transaction, and for another recipient', async () => {
  await assert.rejects(readCctpBurnProof(input({ owner: OTHER }), client()), /No unique USDC DepositForBurn/)
  await assert.rejects(readCctpBurnProof(input(), client({ tx: { to: OTHER } })), /No unique USDC DepositForBurn/, 'depositor is the bridge contract but the wallet did not call it')
  await assert.rejects(readCctpBurnProof(input({ mintRecipients: ['0x' + '22'.repeat(32)] }), client()), /No unique USDC DepositForBurn/)
  const otherDepositor = logs => logs.map(l => l.topics.length === 4 && l.address.toLowerCase() === '0x28b5a0e9c621a5badaa536219b3a228c8168cf5d' ? { ...l, topics: [l.topics[0], l.topics[1], '0x' + OTHER.slice(2).padStart(64, '0'), l.topics[3]] } : l)
  await assert.rejects(readCctpBurnProof(input(), client({ mutateLogs: otherDepositor })), /No unique USDC DepositForBurn/, 'an arbitrary contract as depositor is never accepted')
})
await test('the bridge-contract exception is limited: only when the Arc -> Solana recovery opts in, with the connected wallet as sender, to Solana; EVM and Sui recovery keep depositor = sender', async () => {
  await assert.rejects(readCctpBurnProof(input({ allowCircleKitBridge: undefined }), client()), /No unique USDC DepositForBurn/, 'EVM/Sui callers (no opt-in) do not accept the bridge contract')
  await assert.rejects(readCctpBurnProof(input({ owner: undefined }), client()), /No unique USDC DepositForBurn/, 'no connected wallet, no exception')
  const v = require('viem'), ABI = v.parseAbi(['event DepositForBurn(address indexed burnToken,uint256 amount,address indexed depositor,bytes32 mintRecipient,uint32 destinationDomain,bytes32 destinationTokenMessenger,bytes32 destinationCaller,uint256 maxFee,uint32 indexed minFinalityThreshold,bytes hookData)'])
  const toBase = logs => logs.map(l => {
    if (l.address.toLowerCase() !== '0x28b5a0e9c621a5badaa536219b3a228c8168cf5d') return l
    const d = v.decodeEventLog({ abi: ABI, data: l.data, topics: l.topics }).args
    return { ...l, data: v.encodeAbiParameters(v.parseAbiParameters('uint256,bytes32,uint32,bytes32,bytes32,uint256,bytes'), [d.amount, d.mintRecipient, 6, d.destinationTokenMessenger, d.destinationCaller, d.maxFee, d.hookData]) }
  })
  await assert.rejects(readCctpBurnProof(input(), client({ mutateLogs: toBase })), /No unique USDC DepositForBurn/, 'a bridge-contract burn to another destination (Base) is not accepted')
})
await test('Circle\'s real attested message binds to the proven burn (complete)', async () => {
  const proof = await readCctpBurnProof(input(), client())
  const attested = await readBoundCctpAttestation(proof, async () => new Response(JSON.stringify(REAL.iris), { status: 200 }))
  assert.equal(attested.status, 'complete'); assert.equal(attested.message.toLowerCase(), REAL.iris.messages[0].message.toLowerCase())
})

// The scan's decision for one candidate, with the real proof and Circle message.
const realDeps = (nonceUsed, attestation) => ({
  proof: () => readCctpBurnProof(input(), client()),
  attestation: attestation ?? (proof => readBoundCctpAttestation(proof, async () => new Response(JSON.stringify(REAL.iris), { status: 200 }))),
  nonceUsed,
})
await test('scan: a used Solana nonce proves the transfer complete; only an unused nonce (confirmed = finalized) is mint-ready', async () => {
  assert.deepEqual(await classifyArcSolanaBurn('0x' + '33'.repeat(32), realDeps(async () => true)), { kind: 'complete', amount: '0.1' })
  assert.deepEqual(await classifyArcSolanaBurn('0x' + '33'.repeat(32), realDeps(async () => false)), { kind: 'mint_ready', amount: '0.1' })
})
await test('scan: no evidence, no pending — nonce still settling, Solana RPC failure, Circle still attesting or an unproven burn are never mint-ready', async () => {
  const owner = '0x' + '33'.repeat(32)
  assert.equal((await classifyArcSolanaBurn(owner, realDeps(async () => { throw new SolanaNoncePendingError() }))).kind, 'unknown', 'confirmed and finalized disagree (right after a real mint)')
  assert.equal((await classifyArcSolanaBurn(owner, realDeps(async () => { throw new Error('Solana read proxy HTTP 502') }))).kind, 'unknown')
  assert.equal((await classifyArcSolanaBurn(owner, realDeps(async () => false, async () => ({ status: 'pending' })))).kind, 'waiting_attestation')
  assert.equal((await classifyArcSolanaBurn(owner, realDeps(async () => false, async () => { throw new Error('HTTP 429') }))).kind, 'unknown')
  const unproven = { ...realDeps(async () => false), proof: () => readCctpBurnProof(input({ owner: OTHER }), client()) }
  assert.equal((await classifyArcSolanaBurn(owner, unproven)).kind, 'unknown')
  const notSolana = { ...realDeps(async () => false), proof: async () => ({ amount: '1', fields: { destinationDomain: 6, destinationCaller: '0x' + '00'.repeat(32) } }) }
  assert.equal((await classifyArcSolanaBurn(owner, notSolana)).kind, 'not_ours')
  const otherCaller = { ...realDeps(async () => false), proof: async () => ({ amount: '1', fields: { destinationDomain: 5, destinationCaller: '0x' + '44'.repeat(32) } }) }
  assert.equal((await classifyArcSolanaBurn(owner, otherCaller)).kind, 'not_ours')
})
await test('scan in flight for one wallet pair is never handed to another pair (wallet switch)', async () => {
  const flight = keyedSingleFlight(); let runs = 0, release
  const slow = () => new Promise(r => { runs++; release = r })
  const a1 = flight('evmA|solA', slow), a2 = flight('evmA|solA', slow)
  assert.equal(a1, a2, 'same wallets share the scan'); assert.equal(runs, 1)
  const b = flight('evmA|solB', async () => { runs++; return 'B' })
  assert.notEqual(b, a1); assert.equal(await b, 'B'); assert.equal(runs, 2)
  release('A'); assert.equal(await a1, 'A')
  assert.equal(await flight('evmA|solA', async () => 'A2'), 'A2', 'a finished scan is not reused')
})
console.log(`RESULT ${count}/${count} Arc -> Solana amount/scan groups PASS; real Bridge Kit burn and Circle message from fixtures; no network.`)
