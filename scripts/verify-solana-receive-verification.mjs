// Solana Bridge "completed" status: shown only when the receive is verified on the destination
// chain (Arc mint proof / Solana signature + used CCTP nonce). Fake chain reads only: no network,
// no signature, no transaction.
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { PublicKey } from '@solana/web3.js'
const require = createRequire(import.meta.url), ts = require('typescript')
require.extensions['.ts'] = (m, f) => m._compile(ts.transpileModule(readFileSync(f, 'utf8').replaceAll('import.meta.env', '({})'), { fileName: f, compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText, f)

const store = new Map()
globalThis.localStorage = { getItem: k => store.has(k) ? store.get(k) : null, setItem: (k, v) => store.set(k, String(v)), removeItem: k => store.delete(k) }
globalThis.window = { localStorage: globalThis.localStorage, dispatchEvent() {}, addEventListener() {}, removeEventListener() {}, setTimeout, clearTimeout }

const G = require('../src/lib/solanaSendGuard.ts')
const { destinationEvidence } = require('../src/lib/solanaSendRuntime.ts')
const { verifyArcMintTx, ARC_MINT_EVENTS_ABI } = require('../src/lib/arcMintProof.ts')
const { SOLANA_MAINNET_CCTP } = require('../src/config/mainnetSolana.ts')
const { encodeEventTopics, encodeAbiParameters, sha256, stringToHex } = require('viem')

const EVM = '0xafbb6cc5c0a9c0eb1bff8db2ed807e83aab8e321', SOL = '8UsDvWtFPzYBjzrgrB3j4oufte5iwm4Mx5A2tZ7ocTGg'
const ATA_WORD = '0x' + 'a7'.repeat(32), SOL_WORD = '0x' + Buffer.from(new PublicKey(SOL).toBytes()).toString('hex')
const ARC_DEST = '0x' + 'd1'.repeat(32), SOL_DEST = '5SsG9DqVnbYq2pCMXYxGhR5nVxkmn2J3c5VwXfEYQjGkgP5sDmxhbiHRaH9yzLgJ1FvmEtFx5rv6WKmWZmL8M1bT'
const SOL_SRC = '3vZ7GhB8WFHp2TQ2qQ7fZx2iN1bVwQ3TGxHqCFeZ8p1b6mM2cRbQnXgMm9HcUe8dAqxpbLvW1jKaRm7nPq3Ttz4X', ARC_SRC = '0x' + 'b1'.repeat(32)
const MT = '0x81d40f21f12a8f0e3252bccb954d722d4c464b64', TM = '0x28b5a0e9c621a5badaa536219b3a228c8168cf5d', USDC = '0x3600000000000000000000000000000000000000'
const w = (v, bytes = 32) => BigInt(v).toString(16).padStart(bytes * 2, '0'), h = x => x.replace(/^0x/, '').padStart(64, '0')
// A CCTP V2 message: 148-byte header + 228-byte burn body.
function message({ src, dst, recipient, amount = 100000n, fee = 2n, nonce = '0x' + '4e'.repeat(32) }) {
  return '0x' + w(1, 4) + w(src, 4) + w(dst, 4) + h(nonce) + h('0x' + '5e'.repeat(32)) + h('0x' + '7e'.repeat(32)) + '00'.repeat(32) + w(1000, 4) + w(1000, 4)
    + w(1, 4) + h('0x' + 'bb'.repeat(32)) + h(recipient) + w(amount) + h('0x' + 'cc'.repeat(32)) + w(3) + w(fee) + w(0)
}
const S2A = message({ src: 5, dst: 26, recipient: EVM }), A2S = message({ src: 26, dst: 5, recipient: ATA_WORD })
const s2a = { direction: 'solana-to-arc', sourceTxHash: SOL_SRC, destinationTxHash: ARC_DEST, evmWallet: EVM, solanaWallet: SOL, amountRaw: 100000n, solanaRecipients: [SOL_WORD, ATA_WORD] }
const a2s = { direction: 'arc-to-solana', sourceTxHash: ARC_SRC, destinationTxHash: SOL_DEST, evmWallet: EVM, solanaWallet: SOL, amountRaw: 100000n, solanaRecipients: [SOL_WORD, ATA_WORD] }
const ev = (o = {}) => ({ attestedMessage: async d => ({ status: 'complete', message: d === 'solana-to-arc' ? S2A : A2S }), arcMintMatches: async () => true,
  solanaSignatureStatus: async () => ({ confirmationStatus: 'finalized', err: null }), solanaNonceUsed: async () => true, ...o })
const rpcDown = async () => { throw new Error('fetch failed: 429 Too Many Requests') }
const isPending = v => { assert.equal(v.verified, false); assert.ok(v.reason) }
let count = 0
async function test(name, fn) { store.clear(); await fn(); count++; console.log('PASS ' + name) }

await test('Solana → Arc is completed only with an Arc mint proof bound to this recipient, amount and attested message', async () => {
  const seen = []
  assert.deepEqual(await G.verifyTransferDestination(s2a, ev({ arcMintMatches: async (...a) => { seen.push(a); return true } })), { verified: true })
  assert.deepEqual(seen, [[ARC_DEST, S2A, EVM]], 'the reported Arc hash is checked against the attested message and the connected wallet')
  isPending(await G.verifyTransferDestination(s2a, ev({ arcMintMatches: async () => false })))
  isPending(await G.verifyTransferDestination({ ...s2a, amountRaw: 200000n }, ev()))
  isPending(await G.verifyTransferDestination(s2a, ev({ attestedMessage: async () => ({ status: 'complete', message: message({ src: 5, dst: 26, recipient: '0x' + '99'.repeat(20) }) }) })))
  isPending(await G.verifyTransferDestination(s2a, ev({ attestedMessage: async () => ({ status: 'complete', message: A2S }) })))
  isPending(await G.verifyTransferDestination(s2a, ev({ attestedMessage: async () => ({ status: 'pending' }) })))
  isPending(await G.verifyTransferDestination({ ...s2a, destinationTxHash: SOL_DEST }, ev()))
  isPending(await G.verifyTransferDestination({ ...s2a, destinationTxHash: undefined }, ev()))
})
await test('the Arc mint proof reuses arcMintProof: a successful canonical receipt with MessageReceived + MintAndWithdraw for the Solana message; Sui default unchanged', async () => {
  const body = '0x' + S2A.slice(2 + 296)
  const received = { address: MT, topics: encodeEventTopics({ abi: ARC_MINT_EVENTS_ABI, eventName: 'MessageReceived', args: { caller: EVM, nonce: '0x' + '4e'.repeat(32), finalityThresholdExecuted: 1000 } }),
    data: encodeAbiParameters([{ type: 'uint32' }, { type: 'bytes32' }, { type: 'bytes' }], [5, '0x' + '5e'.repeat(32), body]) }
  const minted = { address: TM, topics: encodeEventTopics({ abi: ARC_MINT_EVENTS_ABI, eventName: 'MintAndWithdraw', args: { mintRecipient: EVM, mintToken: USDC } }),
    data: encodeAbiParameters([{ type: 'uint256' }, { type: 'uint256' }], [99998n, 2n]) }
  const client = (o = {}) => ({ getTransactionReceipt: async () => ({ status: 'success', transactionHash: ARC_DEST, blockNumber: 7n, blockHash: '0x' + 'aa'.repeat(32), logs: [received, minted], ...o }), getBlock: async () => ({ hash: '0x' + 'aa'.repeat(32) }) })
  assert.equal(await verifyArcMintTx(client(), ARC_DEST, S2A, EVM, 5), true)
  assert.equal(await verifyArcMintTx(client({ status: 'reverted' }), ARC_DEST, S2A, EVM, 5), false, 'a reverted receipt is not a receive')
  assert.equal(await verifyArcMintTx(client({ logs: [received] }), ARC_DEST, S2A, EVM, 5), false, 'no MintAndWithdraw, no receive')
  assert.equal(await verifyArcMintTx(client(), ARC_DEST, S2A, '0x' + '99'.repeat(20), 5), false, 'another recipient')
  assert.equal(await verifyArcMintTx(client(), ARC_DEST, S2A, EVM), false, 'the Sui default (domain 8) does not accept a Solana message')
})
await test('Arc → Solana is completed only with a successful confirmed Solana signature and the CCTP nonce marked used', async () => {
  const sigs = [], nonces = []
  assert.deepEqual(await G.verifyTransferDestination(a2s, ev({ solanaSignatureStatus: async s => { sigs.push(s); return { confirmationStatus: 'confirmed', err: null } }, solanaNonceUsed: async m => { nonces.push(m); return true } })), { verified: true })
  assert.deepEqual(sigs, [SOL_DEST]); assert.deepEqual(nonces, [A2S], 'the nonce of the attested message of this burn is checked')
  isPending(await G.verifyTransferDestination(a2s, ev({ solanaNonceUsed: async () => false })))
  isPending(await G.verifyTransferDestination(a2s, ev({ solanaSignatureStatus: async () => ({ confirmationStatus: 'finalized', err: { InstructionError: [0, 'Custom'] } }) })))
  isPending(await G.verifyTransferDestination(a2s, ev({ solanaSignatureStatus: async () => ({ confirmationStatus: 'processed', err: null }) })))
  isPending(await G.verifyTransferDestination(a2s, ev({ solanaSignatureStatus: async () => null })))
  isPending(await G.verifyTransferDestination(a2s, ev({ attestedMessage: async () => ({ status: 'complete', message: message({ src: 26, dst: 5, recipient: '0x' + '42'.repeat(32) }) }) })))
  isPending(await G.verifyTransferDestination({ ...a2s, amountRaw: 1n }, ev()))
})
await test('an RPC or Circle read error is "Receive verification pending", never a failure, and never throws into a retry', async () => {
  for (const o of [{ attestedMessage: rpcDown }, { arcMintMatches: rpcDown }]) {
    const v = await G.verifyTransferDestination(s2a, ev(o)); isPending(v); assert.match(v.reason, /could not be read/)
  }
  for (const o of [{ solanaSignatureStatus: rpcDown }, { solanaNonceUsed: rpcDown }]) {
    const v = await G.verifyTransferDestination(a2s, ev(o)); isPending(v); assert.match(v.reason, /could not be read/)
  }
  const waits = []
  const v = await G.verifyTransferDestinationWithRetry(a2s, ev({ solanaSignatureStatus: rpcDown }), { attempts: 3, wait: async ms => { waits.push(ms) } })
  isPending(v); assert.equal(waits.length, 2, 'retries a bounded number of times, then stays pending')
  let calls = 0
  assert.deepEqual(await G.verifyTransferDestinationWithRetry(a2s, ev({ solanaNonceUsed: async () => ++calls >= 2 }), { attempts: 3, wait: async () => {} }), { verified: true }, 'indexing lag resolves on a later read')
})
await test('the status text: "completed" only when verified; otherwise "Receive verification pending" with a do-not-resend notice', () => {
  assert.equal(G.solanaTransferOutcomeStatus({ sourceTxHash: ARC_SRC, destinationTxHash: SOL_DEST, destinationVerified: true }), G.RECEIVE_VERIFIED_STATUS)
  assert.match(G.RECEIVE_VERIFIED_STATUS, /completed/)
  for (const tx of [{ sourceTxHash: ARC_SRC, destinationTxHash: SOL_DEST }, { sourceTxHash: ARC_SRC, destinationTxHash: SOL_DEST, destinationVerified: false }, { sourceTxHash: ARC_SRC }]) {
    const s = G.solanaTransferOutcomeStatus(tx)
    assert.doesNotMatch(s, /complete/i); assert.match(s, /^Receive verification pending/); assert.match(s, /do not send again/)
  }
  assert.doesNotMatch(G.solanaTransferOutcomeStatus({}), /complete/i)
})
await test('runtime evidence: Solana reads go through the given reader; the nonce PDA check is the existing readSolanaCctpMessageUsed', async () => {
  const program = new PublicKey(SOLANA_MAINNET_CCTP.messageTransmitterProgram).toBase58()
  const disc = Buffer.from(sha256(stringToHex('account:UsedNonce')).slice(2, 18), 'hex')
  const account = used => ({ value: { owner: program, data: [Buffer.concat([disc, Buffer.from([used])]).toString('base64'), 'base64'] } })
  const reader = (o = {}) => async (method, params) => {
    if (method === 'getSignatureStatuses') { assert.deepEqual(params[0], [SOL_DEST]); return o.status ?? { value: [{ confirmationStatus: 'finalized', err: null }] } }
    if (method === 'getAccountInfo') return o.account ?? account(1)
    throw new Error('unexpected ' + method)
  }
  const real = read => ({ ...destinationEvidence({ evmWallet: EVM, solanaRecipients: [SOL_WORD, ATA_WORD], solanaRead: read }), attestedMessage: async () => ({ status: 'complete', message: A2S }) })
  assert.deepEqual(await G.verifyTransferDestination(a2s, real(reader())), { verified: true })
  isPending(await G.verifyTransferDestination(a2s, real(reader({ account: { value: null } }))))
  isPending(await G.verifyTransferDestination(a2s, real(reader({ account: account(0) }))))
  isPending(await G.verifyTransferDestination(a2s, real(reader({ status: { value: [null] } }))))
  const down = await G.verifyTransferDestination(a2s, real(rpcDown)); isPending(down); assert.match(down.reason, /could not be read/)
  const odd = await G.verifyTransferDestination(a2s, real(reader({ status: { error: 'x' } }))); isPending(odd); assert.match(odd.reason, /could not be read/)
})
console.log(`RESULT ${count}/${count} Solana receive-verification groups PASS; fake chain reads, no network, signatures or transactions.`)
