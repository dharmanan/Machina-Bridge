// Solana reclaim: the transaction Phantom signs must be exactly the simulated one.
// Real src/lib/mainnetSolanaReclaim.ts and real web3.js signing with generated keys ("Phantom" is a
// Keypair that really signs, optionally after changing the transaction the way a wallet could).
// Chain reads are controlled per test; deposits are generated (fixtures/solana-refund-deposits.cjs).
// No network, real wallet, signature on a real key, or transaction.
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
const require = createRequire(import.meta.url), ts = require('typescript'), root = fileURLToPath(new URL('..', import.meta.url))
require.extensions['.ts'] = (m, f) => m._compile(ts.transpileModule(readFileSync(f, 'utf8').replaceAll('import.meta.env', '({})'), { fileName: f,
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText, f)
const { Keypair, PublicKey, Connection, Transaction, TransactionInstruction, ComputeBudgetProgram, Message } = require('@solana/web3.js')
const { makeDeposit, randomKey } = require('./fixtures/solana-refund-deposits.cjs')
const sol = require(root + 'src/lib/mainnetSolanaReclaim.ts'), { SOLANA_MAINNET_CCTP: SC } = require(root + 'src/config/mainnetSolana.ts')
globalThis.window = { localStorage: { getItem: () => null, setItem() {}, removeItem() {} }, dispatchEvent() {}, addEventListener() {}, removeEventListener() {} }
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { locks: { request: async (_n, _o, run) => run({}) } } })
globalThis.fetch = async input => { throw new Error(`Network forbidden: ${String(input)}`) }

const CB = ComputeBudgetProgram.programId.toBase58(), MT = new PublicKey(SC.messageTransmitterProgram)
const DAY = 86_400, now = () => Math.floor(Date.now() / 1000)
let plan, calls
const blockhash = () => Keypair.generate().publicKey.toBase58()
const answers = {
  getAccountInfo: () => plan.info,
  getSlot: () => 1, getBlockTime: () => now(),
  getLatestBlockhash: () => ({ blockhash: plan.blockhash, lastValidBlockHeight: 100 }),
  getRecentPrioritizationFees: () => { if (plan.feesError) throw new Error('fees unavailable'); return plan.fees.map((prioritizationFee, slot) => ({ slot, prioritizationFee })) },
  simulateTransaction: tx => { calls.simulated.push(Buffer.from(tx.serializeMessage())); const units = plan.units(calls.simulated.length); return { context: { slot: 1 }, value: { err: plan.simErr ?? null, unitsConsumed: units, logs: [] } } },
  sendRawTransaction: raw => { calls.sent.push(Buffer.from(raw)); return 'controlled-signature' },
  confirmTransaction: () => ({ value: { err: null } }),
}
for (const [name, fn] of Object.entries(answers)) Connection.prototype[name] = async function (...args) { calls.rpc.push(name); return fn(...args) }
Connection.prototype.getParsedTransaction = async () => { throw new Error('not used') }

function setup(over = {}) {
  const phantom = Keypair.generate(), wallet = phantom.publicKey.toBase58()
  const d = makeDeposit({ wallet, createdAtSec: now() - 6 * DAY, lamports: over.lamports ?? 3_900_000 })
  const data = Buffer.from(d.accountInfo.data[0], 'base64')
  plan = { info: { owner: MT, lamports: d.lamports, data, executable: false }, blockhash: blockhash(), fees: [0, 0, 0, 0], units: () => 145_226, ...over.plan }
  calls = { simulated: [], sent: [], rpc: [], signs: 0, shown: null }
  const metadata = { sourceTxHash: d.signature, messageSentEventAccount: d.eventAccount, refundableDepositSol: '0.0039', refundAvailableAt: (d.createdAtSec + 5 * DAY) * 1000,
    refundDestinationMessage: d.attestedMessage, refundAttestation: d.iris.messages[0].attestation }
  return { phantom, wallet, d, metadata }
}
// "Phantom": optionally rewrites the transaction (as a wallet could), then really signs it.
const provider = (phantom, mutate) => ({ publicKey: phantom.publicKey, signTransaction: async tx => {
  calls.signs++; calls.shown = Buffer.from(tx.serializeMessage())
  const out = mutate ? mutate(tx) : tx
  out.partialSign(phantom); return out
} })
const rebuild = (tx, { feePayer = tx.feePayer, recentBlockhash = tx.recentBlockhash, instructions = tx.instructions } = {}) =>
  new Transaction({ feePayer, recentBlockhash }).add(...instructions)
const run = (s, mutate) => sol.reclaimMainnetSolanaDeposit({ connectedWallet: s.wallet, originalWallet: s.wallet, metadata: s.metadata, provider: provider(s.phantom, mutate) })
  .then(ok => ({ ok }), e => ({ error: e.message }))
const programs = buf => { const m = Message.from(buf); return m.instructions.map(i => m.accountKeys[i.programIdIndex].toBase58()) }
const budgetOf = buf => { const m = Message.from(buf), out = {}
  for (const i of m.instructions) if (m.accountKeys[i.programIdIndex].toBase58() === CB) { const b = Buffer.from(require('bs58').default?.decode?.(i.data) ?? require('bs58').decode(i.data))
    if (b[0] === 2) out.limit = b.readUInt32LE(1); if (b[0] === 3) out.price = Number(b.readBigUInt64LE(1)) }
  return out }

let count = 0
async function test(name, fn) { await fn(); count++; console.log(`PASS ${name}`) }
const blocked = (r, what) => { assert.match(r.error, new RegExp(`Phantom changed the reclaim transaction \\((?:${what})\\); broadcasting is blocked`)); assert.equal(calls.sent.length, 0, 'nothing is broadcast'); assert.equal(calls.signs, 1) }

// ---------------------------------------------------------------- root cause, reproduced
await test('cause: a wallet adding set_compute_unit_price/limit to the reclaim changes the signed message and is blocked (no broadcast)', async () => {
  const s = setup()
  const r = await run(s, tx => rebuild(tx, { instructions: [ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 50_000 }), ComputeBudgetProgram.setComputeUnitLimit({ units: 180_000 }),
    ...tx.instructions.filter(i => !i.programId.equals(ComputeBudgetProgram.programId))] }))
  blocked(r, 'compute budget \\(fee\\) values|compute budget instructions added or removed')
})
await test('the reclaim now carries its own compute budget: [limit, price, reclaim_event_account], the exact transaction is simulated, signed once and broadcast', async () => {
  const s = setup()
  const r = await run(s)
  assert.deepEqual(r.ok, { txHash: 'controlled-signature', alreadyClosed: false }); assert.equal(calls.signs, 1); assert.equal(calls.sent.length, 1)
  assert.deepEqual(programs(calls.shown), [CB, CB, SC.messageTransmitterProgram])
  assert.ok(calls.simulated.at(-1).equals(calls.shown), 'the transaction shown to Phantom is the one simulated last')
  const sent = Transaction.from(calls.sent[0]); assert.ok(sent.serializeMessage().equals(calls.shown)); assert.ok(sent.verifySignatures(), 'a valid signature of the rent payer')
  const m = Message.from(calls.shown), reclaim = m.instructions[2]
  assert.deepEqual(reclaim.accounts.map(k => [m.accountKeys[k].toBase58(), m.isAccountSigner(k), m.isAccountWritable(k)]),
    [[s.wallet, true, true], [PublicKey.findProgramAddressSync([Buffer.from('message_transmitter')], MT)[0].toBase58(), false, true], [s.d.eventAccount, false, true]])
  assert.equal(m.accountKeys[0].toBase58(), s.wallet, 'fee payer = rent payer')
  const b = budgetOf(calls.shown); assert.equal(b.limit, Math.ceil(145_226 * 1.2) + 1000); assert.equal(b.price, sol.RECLAIM_MIN_CU_PRICE_MICROLAMPORTS)
})
await test('a wallet that leaves the transaction unchanged (re-serialized, same bytes) passes', async () => {
  const s = setup()
  const r = await run(s, tx => Transaction.from(tx.serialize({ requireAllSignatures: false, verifySignatures: false })))
  assert.ok(r.ok); assert.equal(calls.sent.length, 1)
})

// ---------------------------------------------------------------- every other change is still blocked
await test('changed compute unit price (wallet raises the fee) is blocked', async () => {
  const s = setup()
  blocked(await run(s, tx => rebuild(tx, { instructions: [tx.instructions[0], ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 5_000_000 }), tx.instructions[2]] })), 'compute budget \\(fee\\) values')
})
await test('changed compute unit limit is blocked', async () => {
  const s = setup()
  blocked(await run(s, tx => rebuild(tx, { instructions: [ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }), tx.instructions[1], tx.instructions[2]] })), 'compute budget \\(fee\\) values')
})
await test('changed fee payer is blocked', async () => {
  const s = setup(), other = Keypair.generate()
  blocked(await run(s, tx => { const t = rebuild(tx, { feePayer: other.publicKey }); t.partialSign(other); return t }), 'fee payer')
})
await test('changed blockhash is blocked', async () => {
  const s = setup()
  blocked(await run(s, tx => rebuild(tx, { recentBlockhash: blockhash() })), 'blockhash')
})
await test('changed instruction order is blocked', async () => {
  const s = setup()
  blocked(await run(s, tx => rebuild(tx, { instructions: [tx.instructions[1], tx.instructions[0], tx.instructions[2]] })), 'compute budget \\(fee\\) values|instruction order or program')
  const s2 = setup()
  blocked(await run(s2, tx => rebuild(tx, { instructions: [tx.instructions[2], tx.instructions[0], tx.instructions[1]] })), 'instruction order or program')
})
await test('changed program id is blocked', async () => {
  const s = setup(), r = tx => new TransactionInstruction({ programId: new PublicKey(randomKey()), keys: tx.instructions[2].keys, data: tx.instructions[2].data })
  blocked(await run(s, tx => rebuild(tx, { instructions: [tx.instructions[0], tx.instructions[1], r(tx)] })), 'instruction order or program')
})
await test('changed account metas (other event account, or a flipped writable flag) are blocked', async () => {
  const s = setup(), ix = (tx, keys) => new TransactionInstruction({ programId: MT, keys, data: tx.instructions[2].data })
  blocked(await run(s, tx => rebuild(tx, { instructions: [tx.instructions[0], tx.instructions[1], ix(tx, [tx.instructions[2].keys[0], tx.instructions[2].keys[1], { pubkey: new PublicKey(randomKey()), isSigner: false, isWritable: true }])] })),
    'instruction accounts|message header or account list')
  const s2 = setup()
  blocked(await run(s2, tx => rebuild(tx, { instructions: [tx.instructions[0], tx.instructions[1], ix(tx, [tx.instructions[2].keys[0], { ...tx.instructions[2].keys[1], isWritable: false }, tx.instructions[2].keys[2]])] })),
    'instruction accounts|message header or account list')
})
await test('changed instruction data (one attestation byte) is blocked', async () => {
  const s = setup()
  blocked(await run(s, tx => { const data = Buffer.from(tx.instructions[2].data); data[20] ^= 1
    return rebuild(tx, { instructions: [tx.instructions[0], tx.instructions[1], new TransactionInstruction({ programId: MT, keys: tx.instructions[2].keys, data })] }) }), 'instruction data')
})
await test('an added instruction (e.g. a SOL transfer) is blocked', async () => {
  const s = setup(), thief = new PublicKey(randomKey())
  blocked(await run(s, tx => rebuild(tx, { instructions: [...tx.instructions, require('@solana/web3.js').SystemProgram.transfer({ fromPubkey: tx.feePayer, toPubkey: thief, lamports: 1_000_000 })] })), 'instructions added or removed')
})
await test('a wallet returning a non-legacy or unsigned object is blocked', async () => {
  const s = setup()
  const r = await sol.reclaimMainnetSolanaDeposit({ connectedWallet: s.wallet, originalWallet: s.wallet, metadata: s.metadata,
    provider: { publicKey: s.phantom.publicKey, signTransaction: async () => { calls.signs++; return { serialize: () => Buffer.from([1]) } } } }).then(ok => ({ ok }), e => ({ error: e.message }))
  blocked(r, 'no signed message was returned')
})

// ---------------------------------------------------------------- the fee is bounded before the wallet sees it
await test('a high recent fee market is capped: priority fee never above the ceiling', async () => {
  const s = setup({ plan: { fees: [10_000_000, 50_000_000, 90_000_000, 90_000_000] } })
  assert.ok((await run(s)).ok)
  const b = budgetOf(calls.shown), priority = Math.ceil(b.price * b.limit / 1e6)
  assert.ok(priority <= sol.RECLAIM_MAX_PRIORITY_FEE_LAMPORTS, `priority ${priority}`); assert.ok(b.price < 10_000_000)
})
await test('recent fees: 75th percentile used; unreadable fees fall back to the floor (no wallet request is blocked by it)', async () => {
  const s = setup({ plan: { fees: [0, 0, 2000, 3000, 4000, 100_000, 0, 0] } })
  assert.ok((await run(s)).ok); assert.equal(budgetOf(calls.shown).price, 4000)
  const s2 = setup({ plan: { feesError: true } })
  assert.ok((await run(s2)).ok); assert.equal(budgetOf(calls.shown).price, sol.RECLAIM_MIN_CU_PRICE_MICROLAMPORTS)
})
await test('simulation failure, missing compute report, or a budget above the maximum never requests a signature', async () => {
  for (const p of [{ simErr: { InstructionError: [2, { Custom: 6033 }] } }, { units: () => undefined }, { units: () => sol.RECLAIM_MAX_COMPUTE_UNITS + 1 }, { units: n => (n === 1 ? 100_000 : 200_000) }]) {
    const s = setup({ plan: p }), r = await run(s)
    assert.match(r.error, /simulation/); assert.equal(calls.signs, 0); assert.equal(calls.sent.length, 0)
  }
})
await test('a deposit smaller than the network fee is refused before any wallet request', async () => {
  const s = setup({ lamports: 5_100 }); s.metadata.refundableDepositSol = '0.0000051'
  const r = await run(s)
  assert.match(r.error, /network fee would exceed the refundable deposit/); assert.equal(calls.signs, 0)
})
await test('Circle checks still precede any budget work: wrong rent payer or unbound attestation never simulates or signs', async () => {
  const s = setup(); s.metadata.refundDestinationMessage = makeDeposit({ createdAtSec: now() - 6 * DAY }).attestedMessage
  assert.match((await run(s)).error, /not bound to this deposit account/); assert.equal(calls.simulated.length, 0); assert.equal(calls.signs, 0)
  const s2 = setup(); s2.metadata = { ...s2.metadata }; plan.info = { ...plan.info, data: Buffer.from(makeDeposit({ createdAtSec: now() - 6 * DAY }).accountInfo.data[0], 'base64') }
  assert.match((await run(s2)).error, /rent payer/); assert.equal(calls.simulated.length, 0); assert.equal(calls.signs, 0)
})
await test('production code holds no specific wallet, signature or account (generated values only in this test)', async () => {
  const text = readFileSync(root + 'src/lib/mainnetSolanaReclaim.ts', 'utf8')
  for (const v of ['7bJT7x7UBeMLS5PwhqazRZPjbZa5amnnRHbD9zrG8YQR', '5BfmjJL8atsQ8LDRr3AoNU4PKu4oy1AH7Bn4Yn846uHz', '8DEFF2A3aQs5Pv5mjYv8bzfF93q1GAtmMzpkwnee4Drq']) assert.ok(!text.includes(v))
})

console.log(`RESULT ${count}/${count} Solana reclaim signing-integrity groups PASS; real web3.js signing with generated keys; no network, real wallet or transaction`)
