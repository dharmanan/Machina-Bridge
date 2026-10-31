// Solana -> Arc recovery (B2): the real recovery module, receive journal and Web Locks with fake
// Solana / Circle / Arc reads and a fake wallet. No network, no signature, no transaction.
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { PublicKey } from '@solana/web3.js'
const require = createRequire(import.meta.url), ts = require('typescript')
require.extensions['.ts'] = (m, f) => m._compile(ts.transpileModule(readFileSync(f, 'utf8').replaceAll('import.meta.env', '({})'), { fileName: f, compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText, f)

const store = new Map()
globalThis.localStorage = { getItem: k => store.has(k) ? store.get(k) : null, setItem: (k, v) => store.set(k, String(v)), removeItem: k => store.delete(k) }
globalThis.window = { localStorage: globalThis.localStorage, dispatchEvent() {}, addEventListener() {}, removeEventListener() {}, setTimeout, clearTimeout }
assert.ok(globalThis.navigator?.locks, 'Web Locks are available')

const R = require('../src/lib/solanaArcRecovery.ts')
const { readSolanaSendAttempts, SOLANA_SEND_JOURNAL_KEY } = require('../src/lib/solanaSendGuard.ts')
const { SOLANA_MAINNET_CCTP } = require('../src/config/mainnetSolana.ts')
const { decodeFunctionData, parseAbi } = require('viem')

const EVM = '0xafbb6cc5c0a9c0eb1bff8db2ed807e83aab8e321', OTHER_EVM = '0x' + '99'.repeat(20)
const SOL = '8UsDvWtFPzYBjzrgrB3j4oufte5iwm4Mx5A2tZ7ocTGg', OTHER_SOL = '7bJT7x7UBeMLS5PwhqazRZPjbZa5amnnRHbD9zrG8YQR'
const SIG = '3vZ7GhB8WFHp2TQ2qQ7fZx2iN1bVwQ3TGxHqCFeZ8p1b6mM2cRbQnXgMm9HcUe8dAqxpbLvW1jKaRm7nPq3Ttz4X'
const MT = '0x81d40f21f12a8f0e3252bccb954d722d4c464b64', TM = '0x28b5a0e9c621a5badaa536219b3a228c8168cf5d', RECEIVE_TX = '0x' + 'e1'.repeat(32)
const pk = k => Buffer.from(new PublicKey(k).toBytes()).toString('hex')
const w = (v, bytes = 32) => BigInt(v).toString(16).padStart(bytes * 2, '0'), h = x => x.replace(/^0x/, '').padStart(64, '0')
function message(o = {}) {
  const f = { src: 5, dst: 26, nonce: '0x' + '4e'.repeat(32), sender: pk(SOLANA_MAINNET_CCTP.tokenMessengerMinterProgram), recipient: h(TM), caller: '00'.repeat(32),
    token: pk(SOLANA_MAINNET_CCTP.usdcMint), mintRecipient: h(EVM), amount: 100000n, messageSender: pk(SOL), fee: 2n, exp: 0n, ...o }
  return '0x' + w(1, 4) + w(f.src, 4) + w(f.dst, 4) + h(f.nonce) + f.sender + f.recipient + f.caller + w(1000, 4) + w(1000, 4)
    + w(1, 4) + f.token + f.mintRecipient + w(f.amount) + f.messageSender + w(3) + w(f.fee) + w(f.exp)
}
const ATT = '0x' + 'ab'.repeat(130)
const circle = (o = {}, extra = {}) => [{ status: 'complete', message: message(o), attestation: ATT, eventNonce: '0x' + '4e'.repeat(32), ...extra }]
const source = (o = {}) => ({ status: { confirmationStatus: 'finalized', err: null }, transaction: { meta: { err: null, logMessages: [`Program ${SOLANA_MAINNET_CCTP.tokenMessengerMinterProgram} invoke [1]`] }, transaction: { message: { accountKeys: [SOL, 'Other111111111111111111111111111111111111111'], header: { numRequiredSignatures: 1 } } } }, ...o })
// A fake chain: Arc nonce state, receipts; counters for every read.
function chain(o = {}) {
  const c = { used: 0n, messages: circle(), src: source(), receipts: {}, reads: 0, fail: null, ...o }
  c.ports = {
    solanaSource: async () => { c.reads++; if (c.fail === 'solana') throw new Error('fetch failed'); return c.src },
    circleMessages: async () => { if (c.fail === 'circle') throw new Error('Circle API HTTP 503'); return c.messages },
    arc: { getChainId: async () => 5042, getBlock: async () => ({ number: 100n, hash: '0x' + 'aa'.repeat(32) }),
      readContract: async ({ functionName, args }) => { assert.equal(functionName, 'usedNonces'); assert.equal(args[0], '0x' + '4e'.repeat(32)); if (c.fail === 'arc') throw new Error('rpc 429'); return c.used },
      getTransactionReceipt: async () => { throw new Error('not used') } },
  }
  return c
}
const input = (o = {}) => ({ signature: SIG, solanaOwner: SOL, evmOwner: EVM, ...o })
const RECEIVE_ABI = parseAbi(['function receiveMessage(bytes message, bytes attestation) returns (bool)'])
// Fake wallet + receive deps over a fake chain. send() simulates the mined receive by marking the nonce used.
function deps(c, o = {}) {
  const sent = []
  const d = {
    sent,
    inspect: i => R.inspectSolanaToArcRecovery(i, c.ports),
    wallet: { ready: async () => {}, simulate: async () => {}, send: async call => { sent.push(call); c.used = 1n; return RECEIVE_TX } },
    receipt: async hash => c.receipts[hash] ?? null,
    waitReceipt: async () => 'success',
    mintProven: async () => true,
    ...o,
  }
  return d
}
const journal = () => R.readReceiveRecords()
let count = 0
async function test(name, fn) { store.clear(); await fn(); count++; console.log('PASS ' + name) }

await test('the Solana source must be a confirmed, error-free CCTP burn signed by the connected Phantom wallet', async () => {
  const ok = chain()
  assert.equal((await R.inspectSolanaToArcRecovery(input(), ok.ports)).stage, 'ready_to_mint')
  const cases = [
    [{ src: source({ status: null }) }, /not found on chain/],
    [{ src: source({ status: { confirmationStatus: 'finalized', err: { InstructionError: [0, 'x'] } } }) }, /failed, so nothing was burned/],
    [{ src: source({ status: { confirmationStatus: 'processed', err: null } }) }, /not confirmed yet/],
    [{ src: { ...source(), transaction: { ...source().transaction, transaction: { message: { accountKeys: [OTHER_SOL], header: { numRequiredSignatures: 1 } } } } } }, /not signed by the connected Phantom wallet/],
    [{ src: { ...source(), transaction: { ...source().transaction, meta: { err: null, logMessages: ['Program 11111111111111111111111111111111 invoke [1]'] } } } }, /not a CCTP burn/],
    [{ src: { ...source(), transaction: null } }, /details are not available yet/],
  ]
  for (const [o, re] of cases) await assert.rejects(R.inspectSolanaToArcRecovery(input(), chain(o).ports), re)
  await assert.rejects(R.inspectSolanaToArcRecovery(input({ signature: '0x' + 'b1'.repeat(32) }), ok.ports), /not a Solana transaction signature/)
})
await test('the Circle message must be Solana -> Arc, from this Phantom wallet to the connected Arc wallet, with a valid attestation', async () => {
  for (const o of [{ mintRecipient: h(OTHER_EVM) }, { messageSender: pk(OTHER_SOL) }, { dst: 8 }, { recipient: h(OTHER_EVM) }, { caller: h(OTHER_EVM) }, { token: pk(OTHER_SOL) }])
    await assert.rejects(R.inspectSolanaToArcRecovery(input(), chain({ messages: circle(o) }).ports), /not a Solana → Arc transfer to the connected Arc wallet/)
  await assert.rejects(R.inspectSolanaToArcRecovery(input(), chain({ messages: [...circle(), ...circle()] }).ports), /Several Circle messages/)
  await assert.rejects(R.inspectSolanaToArcRecovery(input(), chain({ messages: circle({}, { attestation: '0x1234' }) }).ports), /attestation, nonce, finality or fee is invalid/)
  await assert.rejects(R.inspectSolanaToArcRecovery(input(), chain({ messages: circle({ fee: 100000n }) }).ports), /invalid/)
  assert.equal((await R.inspectSolanaToArcRecovery(input(), chain({ messages: [] }).ports)).stage, 'waiting_attestation')
  assert.equal((await R.inspectSolanaToArcRecovery(input(), chain({ messages: circle({}, { status: 'pending_confirmations' }) }).ports)).stage, 'waiting_attestation')
  const ok = await R.inspectSolanaToArcRecovery(input(), chain({ messages: circle({ caller: h(EVM) }) }).ports)
  assert.deepEqual([ok.stage, ok.amount, ok.feeUsdc, ok.receivedUsdc], ['ready_to_mint', '0.1', '0.000002', '0.099998'])
  await assert.rejects(R.inspectSolanaToArcRecovery(input(), chain({ messages: circle({ exp: 50n }) }).ports), /expired on Arc/)
})
await test('already minted on Arc (used nonce): shown as received and nothing is sent, in this or any browser', async () => {
  const c = chain({ used: 1n }), d = deps(c)
  const res = await R.inspectSolanaToArcRecovery(input(), c.ports)
  assert.equal(res.stage, 'complete')
  const completed = []
  const out = await R.completeSolanaArcReceive(input(), res, { ...d, onComplete: (r, tx) => completed.push([r.stage, tx]) })
  assert.equal(out.kind, 'already-received'); assert.equal(d.sent.length, 0, 'no wallet request'); assert.deepEqual(journal(), [], 'nothing journaled')
  assert.deepEqual(completed, [['complete', undefined]])
})
await test('mint missing: only after review, one receiveMessage of exactly the attested message to the Arc MessageTransmitter; journaled before the wallet; verified after', async () => {
  const c = chain(), order = []
  const d = deps(c, { wallet: { ready: async () => order.push('ready'), simulate: async () => order.push('simulate'),
    send: async call => { order.push('send:' + R.readReceiveRecords()[0]?.phase); c.used = 1n; return RECEIVE_TX } } })
  const reviewed = await R.inspectSolanaToArcRecovery(input(), c.ports)
  let sentCall
  d.wallet.send = (orig => async call => { sentCall = call; return orig(call) })(d.wallet.send)
  const out = await R.completeSolanaArcReceive(input(), reviewed, d)
  assert.equal(out.kind, 'received'); assert.equal(out.txHash, RECEIVE_TX)
  assert.deepEqual(order, ['ready', 'simulate', 'send:requesting'], 'the request is saved before the wallet sees it')
  assert.equal(sentCall.to.toLowerCase(), MT); assert.equal(sentCall.value, 0n)
  const decoded = decodeFunctionData({ abi: RECEIVE_ABI, data: sentCall.data })
  assert.equal(decoded.functionName, 'receiveMessage'); assert.equal(decoded.args[0], message()); assert.equal(decoded.args[1], ATT)
  assert.equal(journal()[0].phase, 'complete'); assert.equal(journal()[0].txHash, RECEIVE_TX)
  assert.deepEqual(readSolanaSendAttempts(), [], 'no burn attempt is created: recovery never burns')
  assert.equal(store.get(SOLANA_SEND_JOURNAL_KEY), undefined)
})
await test('a changed transfer since review, a failed pre-check or an unreadable network sends nothing and journals nothing', async () => {
  const c = chain(), reviewed = await R.inspectSolanaToArcRecovery(input(), c.ports)
  await assert.rejects(R.completeSolanaArcReceive(input(), { ...reviewed, receivedUsdc: '0.5' }, deps(c)), /changed since you reviewed it/)
  await assert.rejects(R.completeSolanaArcReceive(input({ evmOwner: OTHER_EVM }), reviewed, deps(c)), /connected Arc wallet|changed since/)
  const d = deps(c, { wallet: { ...deps(c).wallet, simulate: async () => { throw new Error('Not enough Arc gas') } } })
  await assert.rejects(R.completeSolanaArcReceive(input(), reviewed, d), /Not enough Arc gas/)
  for (const fail of ['solana', 'circle', 'arc']) {
    const f = chain({ fail }), fd = deps(f)
    await assert.rejects(R.completeSolanaArcReceive(input(), reviewed, fd)); assert.equal(fd.sent.length, 0)
  }
  assert.deepEqual(journal(), [])
})
await test('wallet rejection releases the request (a later receive may follow); an unclear wallet error keeps it locked', async () => {
  const c = chain(), reviewed = await R.inspectSolanaToArcRecovery(input(), c.ports)
  const rejecting = deps(c, { wallet: { ready: async () => {}, send: async () => { throw Object.assign(new Error('User rejected the request.'), { code: 4001 }) } } })
  await assert.rejects(R.completeSolanaArcReceive(input(), reviewed, rejecting), /rejected/)
  assert.equal(journal()[0].phase, 'released')
  const unclear = deps(c, { wallet: { ready: async () => {}, send: async () => { throw new Error('Internal JSON-RPC error.') } } })
  await assert.rejects(R.completeSolanaArcReceive(input(), reviewed, unclear), /Internal JSON-RPC/)
  assert.equal(journal()[0].phase, 'unknown')
  const again = deps(c)
  await assert.rejects(R.completeSolanaArcReceive(input(), reviewed, again), /no known outcome/)
  assert.equal(again.sent.length, 0)
})
await test('page reload: an unclear request stays locked until the nonce shows it received, or the user unlocks it after a check', async () => {
  const c = chain(), reviewed = await R.inspectSolanaToArcRecovery(input(), c.ports)
  R.writeReceiveRecord({ signature: SIG, nonce: '0x' + '4e'.repeat(32), evmWallet: EVM, phase: 'requesting', updatedAt: 1 }) // left by a closed page
  const d = deps(c)
  await assert.rejects(R.completeSolanaArcReceive(input(), reviewed, d), /no known outcome/); assert.equal(d.sent.length, 0)
  assert.throws(() => R.releaseReceiveAfterReview(SIG, { ...reviewed, stage: 'complete' }), /Check the transfer on chain first/)
  R.releaseReceiveAfterReview(SIG, reviewed)
  assert.equal(journal()[0].phase, 'released'); assert.match(journal()[0].note, /Unlocked by you/)
  assert.equal((await R.completeSolanaArcReceive(input(), reviewed, d)).kind, 'received'); assert.equal(d.sent.length, 1)
  // The same left-over request, but the earlier receive did land: settled as received, nothing sent.
  store.clear(); c.used = 1n
  R.writeReceiveRecord({ signature: SIG, nonce: '0x' + '4e'.repeat(32), evmWallet: EVM, phase: 'unknown', updatedAt: 1 })
  const d2 = deps(c)
  assert.equal((await R.completeSolanaArcReceive(input(), reviewed, d2)).kind, 'already-received'); assert.equal(d2.sent.length, 0)
  assert.equal(journal()[0].phase, 'complete')
})
await test('page reload with a sent receive: pending blocks, reverted allows one new request, success with a used nonce completes', async () => {
  const c = chain(), reviewed = await R.inspectSolanaToArcRecovery(input(), c.ports)
  const sent = { signature: SIG, nonce: '0x' + '4e'.repeat(32), evmWallet: EVM, phase: 'sent', txHash: '0x' + 'f0'.repeat(32), updatedAt: 1 }
  R.writeReceiveRecord(sent)
  const d = deps(c)
  await assert.rejects(R.completeSolanaArcReceive(input(), reviewed, d), /still pending on Arc/); assert.equal(d.sent.length, 0)
  c.receipts[sent.txHash] = 'reverted'
  assert.equal((await R.completeSolanaArcReceive(input(), reviewed, d)).kind, 'received'); assert.equal(d.sent.length, 1)
  store.clear(); c.used = 1n; R.writeReceiveRecord(sent)
  assert.equal((await R.completeSolanaArcReceive(input(), reviewed, deps(c))).kind, 'already-received')
})
await test('another browser (empty journal): the Arc nonce decides; a receive whose mint cannot be proven yet says do not send again', async () => {
  const c = chain(), reviewed = await R.inspectSolanaToArcRecovery(input(), c.ports)
  const d = deps(c, { mintProven: async () => false })
  await assert.rejects(R.completeSolanaArcReceive(input(), reviewed, d), /not independently verified yet\. Do not send again/)
  assert.equal(journal()[0].phase, 'sent', 'stays open with its hash')
  c.receipts[RECEIVE_TX] = 'success'
  const d2 = deps(c)
  assert.equal((await R.completeSolanaArcReceive(input(), reviewed, d2)).kind, 'already-received'); assert.equal(d2.sent.length, 0)
})
await test('second tab: while one tab holds the receive lock, another cannot request the same receive', async () => {
  const c = chain(), reviewed = await R.inspectSolanaToArcRecovery(input(), c.ports)
  let release
  const holding = navigator.locks.request(`machina-solana-arc-receive:${SIG}`, () => new Promise(r => { release = r }))
  await new Promise(r => setTimeout(r, 10))
  const d = deps(c)
  await assert.rejects(R.completeSolanaArcReceive(input(), reviewed, d), /Another tab is already completing this receive/)
  assert.equal(d.sent.length, 0); release(); await holding
})
await test('candidates come from the send journal, Activity and open receives of this Phantom wallet only', () => {
  const S2 = SIG.slice(0, -1) + 'Y', S3 = SIG.slice(0, -1) + 'Z'
  const list = R.solanaArcCandidates({
    sendAttempts: [{ direction: 'solana-to-arc', solanaWallet: SOL, evmWallet: EVM, solanaSignature: SIG, phase: 'burned' }, { direction: 'solana-to-arc', solanaWallet: SOL, evmWallet: EVM, solanaSignature: S3, phase: 'released' }, { direction: 'arc-to-solana', solanaWallet: SOL, evmWallet: EVM, phase: 'burned' }],
    activity: [{ direction: 'solana-to-arc', solanaWallet: SOL, sourceTxHash: S2 }, { direction: 'solana-to-arc', solanaWallet: SOL, sourceTxHash: S3, status: 'complete' }, { direction: 'solana-to-arc', solanaWallet: OTHER_SOL, sourceTxHash: S3 }],
    receives: [],
  }, SOL)
  assert.deepEqual(list.sort(), [SIG, S2].sort())
})
console.log(`RESULT ${count}/${count} Solana -> Arc recovery groups PASS; fake Solana/Circle/Arc reads and wallet, real journal and Web Locks; no network, signatures or transactions.`)
