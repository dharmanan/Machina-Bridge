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
const { Keypair, PublicKey, Connection, Transaction, TransactionInstruction, ComputeBudgetProgram, Message, VersionedTransaction, SystemProgram } = require('@solana/web3.js')
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
  getBalance: () => { if (plan.balanceError) throw new Error('balance unavailable'); return plan.walletBalance },
  simulateTransaction: (tx, cfg) => {
    if (tx instanceof VersionedTransaction) return signedSimulation(tx, cfg) // the exact signed bytes
    calls.simulated.push(Buffer.from(tx.serializeMessage())); const units = plan.units(calls.simulated.length); return { context: { slot: 1 }, value: { err: plan.simErr ?? null, unitsConsumed: units, logs: [] } }
  },
  sendRawTransaction: raw => { calls.sent.push(Buffer.from(raw)); return 'controlled-signature' },
  confirmTransaction: () => ({ value: { err: null } }),
}
// Default chain answer for the signed transaction: a successful reclaim (deposit closed, wallet += deposit - fee).
function signedSimulation(tx, cfg) {
  calls.signedSims.push({ bytes: Buffer.from(tx.serialize()), cfg })
  const m = tx.message, budget = {}
  for (const ix of m.compiledInstructions) if (m.staticAccountKeys[ix.programIdIndex].toBase58() === CB) { const d = Buffer.from(ix.data); if (d[0] === 2) budget.limit = d.readUInt32LE(1); if (d[0] === 3) budget.price = Number(d.readBigUInt64LE(1)) }
  const fee = 5000 * m.header.numRequiredSignatures + Math.ceil((budget.price ?? 0) * (budget.limit ?? 0) / 1e6)
  const o = plan.signed ?? {}
  const after = plan.walletBalance + plan.info.lamports - fee + (o.walletDelta ?? 0)
  return { context: { slot: 1 }, value: { err: o.err ?? null, unitsConsumed: 'units' in o ? o.units : 160_000, logs: [],
    accounts: 'accounts' in o ? o.accounts : [{ lamports: after, owner: SystemProgram.programId.toBase58(), data: ['', 'base64'], executable: false, rentEpoch: 0 }, o.depositOpen ? { lamports: plan.info.lamports, owner: MT.toBase58(), data: ['', 'base64'], executable: false, rentEpoch: 0 } : null] } }
}
for (const [name, fn] of Object.entries(answers)) Connection.prototype[name] = async function (...args) { calls.rpc.push(name); return fn(...args) }
Connection.prototype.getParsedTransaction = async () => { throw new Error('not used') }

function setup(over = {}) {
  const phantom = Keypair.generate(), wallet = phantom.publicKey.toBase58()
  const d = makeDeposit({ wallet, createdAtSec: now() - 6 * DAY, lamports: over.lamports ?? 3_900_000 })
  const data = Buffer.from(d.accountInfo.data[0], 'base64')
  plan = { info: { owner: MT, lamports: d.lamports, data, executable: false }, blockhash: blockhash(), fees: [0, 0, 0, 0], units: () => 145_226, walletBalance: 50_000_000, ...over.plan }
  calls = { simulated: [], signedSims: [], sent: [], rpc: [], signs: 0, shown: null }
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
// ---------------------------------------------------------------- change diagnostics (UI error text only)
// What the error may show: positions, program ids (known by name, others shortened), account counts and
// the compute unit limit/price. What it must never show: signatures, transaction bytes, instruction data
// (attestation, Circle message) or full addresses. Every changed transaction stays unbroadcast.
const short = id => `${id.slice(0, 6)}…${id.slice(-4)}`
const details = r => { const m = /Details: (.*)$/.exec(r.error); assert.ok(m, 'a Details section'); return m[1] }
function assertPrivate(r, s, extra = []) {
  const text = r.error, signedSig = calls.sentSignature
  for (const secret of [s.wallet, s.d.eventAccount, s.metadata.refundAttestation.slice(2), s.metadata.refundAttestation.slice(2, 40), s.d.attestedMessage.slice(2, 60),
    s.metadata.refundDestinationMessage.slice(2), s.phantom.secretKey && Buffer.from(s.phantom.secretKey).toString('hex').slice(0, 32), ...extra].filter(Boolean))
    assert.ok(!text.includes(secret), `the error leaks ${String(secret).slice(0, 8)}…`)
  assert.ok(!/[0-9a-f]{64}/i.test(text), 'no long hex (bytes, attestation, message)')
  assert.ok(!/[1-9A-HJ-NP-Za-km-z]{32,}/.test(text), 'no full base58 address or signature')
  assert.ok(text.length <= 900, `bounded error text (${text.length})`)
}
const withQuietSinks = async fn => {
  const seen = []
  const methods = ['log', 'info', 'warn', 'error', 'debug', 'trace']
  const saved = Object.fromEntries(methods.map(m => [m, console[m]]))
  const savedSet = globalThis.window.localStorage.setItem, savedFetch = globalThis.fetch
  for (const m of methods) console[m] = (...a) => seen.push(`console.${m}`)
  globalThis.window.localStorage.setItem = () => seen.push('localStorage.setItem')
  globalThis.fetch = async u => { seen.push(`fetch ${u}`); throw new Error('Network forbidden') }
  try { return await fn() } finally { Object.assign(console, saved); globalThis.window.localStorage.setItem = savedSet; globalThis.fetch = savedFetch; assert.deepEqual(seen, [], 'nothing written to console, storage or network') }
}
const signedWith = (tx, instructions) => rebuild(tx, { instructions })
const foreignIx = (tx, accounts = 4) => new TransactionInstruction({ programId: new PublicKey(randomKey()),
  keys: [tx.instructions[2].keys[0], tx.instructions[2].keys[2], ...Array.from({ length: accounts - 2 }, () => ({ pubkey: new PublicKey(randomKey()), isSigner: false, isWritable: false }))],
  data: Buffer.from(tx.instructions[2].data).subarray(0, 120) })

await test('diagnostics: an appended non-Compute-Budget instruction is named by position and short program id; limit/price shown as same; nothing leaks or is written anywhere', async () => {
  const s = setup(); let extra
  const r = await withQuietSinks(() => run(s, tx => { extra = foreignIx(tx); return signedWith(tx, [...tx.instructions, extra]) }))
  blocked(r, 'instructions added or removed')
  const d = details(r), b = budgetOf(calls.shown)
  assert.match(d, /^instructions expected 3, signed 4; /)
  assert.ok(d.includes(`added: #3 program ${short(extra.programId.toBase58())} (4 accounts)`), d)
  assert.ok(d.includes('removed: none'), d); assert.ok(d.includes('order differs'), d)
  assert.ok(d.includes(`limit same (${b.limit})`) && d.includes(`price same (${b.price})`), d)
  assertPrivate(r, s, [extra.programId.toBase58()])
})
await test('diagnostics: instructions inserted before and between the reclaim are listed with their signed positions', async () => {
  const s = setup(); let x, y
  const r = await run(s, tx => { x = foreignIx(tx, 3); y = foreignIx(tx, 5); return signedWith(tx, [x, tx.instructions[0], tx.instructions[1], y, tx.instructions[2]]) })
  blocked(r, 'instructions added or removed')
  const d = details(r)
  assert.ok(d.includes(`added: #0 program ${short(x.programId.toBase58())} (3 accounts), #3 program ${short(y.programId.toBase58())} (5 accounts)`), d)
  assert.ok(d.includes('removed: none'), d); assertPrivate(r, s)
})
await test('diagnostics: a removed reclaim instruction is named (CircleMessageTransmitterV2)', async () => {
  const s = setup()
  const r = await run(s, tx => signedWith(tx, [tx.instructions[0], tx.instructions[1]]))
  blocked(r, 'instructions added or removed')
  const d = details(r)
  assert.ok(d.includes('instructions expected 3, signed 2'), d); assert.ok(d.includes('added: none; removed: #2 CircleMessageTransmitterV2'), d); assertPrivate(r, s)
})
await test('diagnostics: replaced instruction (reclaim swapped for another program) shows both the removal and the addition', async () => {
  const s = setup(); let x
  const r = await run(s, tx => { x = foreignIx(tx); return signedWith(tx, [tx.instructions[0], tx.instructions[1], x]) })
  blocked(r, 'instruction order or program')
  const d = details(r)
  assert.ok(d.includes(`added: #2 program ${short(x.programId.toBase58())} (4 accounts); removed: #2 CircleMessageTransmitterV2`), d); assertPrivate(r, s)
})
await test('diagnostics: changed price and limit are reported as values (old -> new), never as added/removed', async () => {
  const s = setup()
  const r = await run(s, tx => signedWith(tx, [ComputeBudgetProgram.setComputeUnitLimit({ units: 300_000 }), ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 777_777 }), tx.instructions[2]]))
  blocked(r, 'compute budget \\(fee\\) values')
  const d = details(r), e = budgetOf(calls.shown)
  assert.ok(d.includes('added: none; removed: none; order same'), d)
  assert.ok(d.includes(`limit ${e.limit} -> 300000 (changed)`) && d.includes(`price ${e.price} -> 777777 (changed)`), d); assertPrivate(r, s)
})
await test('diagnostics: a third Compute Budget instruction (e.g. loaded-accounts data limit) is named by its type; limit and price compared', async () => {
  const s = setup()
  const r = await run(s, tx => signedWith(tx, [new TransactionInstruction({ programId: ComputeBudgetProgram.programId, keys: [], data: Buffer.from([4, 0, 0, 4, 0]) }), ...tx.instructions]))
  blocked(r, 'compute budget instructions added or removed')
  const d = details(r)
  assert.ok(d.includes('added: #0 ComputeBudget:type4'), d); assert.match(d, /limit same \(\d+\), price same \(\d+\)/); assertPrivate(r, s)
})
await test('diagnostics: compute budget removed by the wallet shows limit/price as absent in the signed message', async () => {
  const s = setup()
  const r = await run(s, tx => signedWith(tx, [tx.instructions[2]]))
  blocked(r, 'compute budget instructions added or removed')
  const d = details(r)
  assert.ok(d.includes('removed: #0 ComputeBudget:limit, #1 ComputeBudget:price'), d); assert.match(d, /limit \d+ -> absent \(changed\), price \d+ -> absent \(changed\)/); assertPrivate(r, s)
})
await test('diagnostics: reordered instructions are reported as an order change; the list is bounded for many added instructions', async () => {
  const s = setup()
  const r = await run(s, tx => signedWith(tx, [tx.instructions[2], tx.instructions[0], tx.instructions[1]]))
  blocked(r, 'instruction order or program'); assert.ok(details(r).includes('order differs') || details(r).includes('order changed')); assertPrivate(r, s)
  const s2 = setup()
  const r2 = await run(s2, tx => signedWith(tx, [...tx.instructions, ...Array.from({ length: 9 }, () => new TransactionInstruction({ programId: new PublicKey(randomKey()), keys: [], data: Buffer.alloc(0) }))]))
  blocked(r2, 'instructions added or removed')
  const d2 = details(r2); assert.ok(d2.includes('+3 more'), d2); assert.ok(d2.includes('signed 12'), d2); assertPrivate(r2, s2)
})
await test('no general exception: an added instruction of any program other than Lighthouse is blocked', async () => {
  for (let n = 0; n < 3; n++) { const s = setup(); blocked(await run(s, tx => signedWith(tx, [...tx.instructions, foreignIx(tx, 2 + n)])), 'instructions added or removed') }
})
await test('diagnostics helper is pure and safe on malformed input', async () => {
  const s = setup(); await run(s)
  assert.equal(sol.reclaimMessageDiagnostics(calls.shown, null), '')
  assert.equal(sol.reclaimMessageDiagnostics(calls.shown, Buffer.from([1, 2, 3])), 'the signed message could not be read.')
  assert.match(sol.reclaimMessageDiagnostics(calls.shown, calls.shown), /^instructions expected 3, signed 3; added: none; removed: none; order same; compute budget limit same \(\d+\), price same \(\d+\)\.$/)
})
// ---------------------------------------------------------------- Lighthouse assertions (Phantom transaction guard)
// Encoders mirror the Lighthouse program layout (Borsh, u8 tags, CompactU64 = unsigned LEB128): jac0xb/lighthouse
// programs/lighthouse/src/instruction.rs and lighthouse-sdk 2.1.0. Phantom's real reclaim placed three at #2, #3, #5.
const LH = new PublicKey('L2TExMFKdjpN9kozasaurPirfHy9P8sbXoAN1qA3S95')
const leb = n => { const out = []; do { let b = n % 128; n = Math.floor(n / 128); if (n) b |= 0x80; out.push(b) } while (n); return out }
const u64le = v => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(v)); return [...b] }
const LHD = {
  infoLamports: (min = 1, log = 0) => Buffer.from([5, log, 0, ...u64le(min), 4]),                   // AssertAccountInfo Lamports >= min
  infoOwner: owner => Buffer.from([5, 0, 2, ...new PublicKey(owner).toBuffer(), 0]),               // AssertAccountInfo Owner ==
  infoMulti: () => Buffer.from([6, 1, ...leb(3), 0, ...u64le(10), 4, 5, 1, 0, 8, ...Buffer.alloc(32, 7), ...leb(0), ...leb(300)]), // lamports, IsSigner, VerifyDatahash
  data: () => Buffer.from([2, 2, ...leb(8), 7, ...u64le(5), 2]),                                  // AssertAccountData U64 at 8 > 5
  dataMulti: () => Buffer.from([3, 3, ...leb(2), ...leb(0), 1, 0x83, 0, ...leb(200), 11, ...leb(3), 1, 2, 3, 0]), // U8 at 0, Bytes at 200
  memoryWrite: () => Buffer.from([0, 0, 0, 0, 0]),
  memoryClose: () => Buffer.from([1, 0, 0]),
  delta: () => Buffer.from([4, 0, 0, ...u64le(0), ...u64le(0), 0]),
  clock: () => Buffer.from([15, 0, 0, ...u64le(1), 4]),
  token: () => Buffer.from([9, 0, 0, ...Buffer.alloc(32), 0]),
  unknown: () => Buffer.from([42, 0, 0]),
}
const ro = pubkey => ({ pubkey: typeof pubkey === 'string' ? new PublicKey(pubkey) : pubkey, isSigner: false, isWritable: false })
const lh = (data, keys, programId = LH) => new TransactionInstruction({ programId, keys, data })
// Phantom-like: [limit, price, assert wallet, assert deposit, reclaim, assert wallet afterwards]
const guarded = (s, extra = {}) => tx => signedWith(tx, [tx.instructions[0], tx.instructions[1],
  extra.first ?? lh(LHD.infoLamports(1), [ro(s.wallet)]), extra.second ?? lh(LHD.data(), [ro(s.d.eventAccount)]),
  extra.reclaim ?? tx.instructions[2], extra.last ?? lh(LHD.infoMulti(), [ro(s.wallet)]), ...(extra.more ?? [])])
const passes = (r, s) => { assert.ok(r.ok, r.error); assert.equal(calls.signs, 1); assert.equal(calls.sent.length, 1)
  assert.equal(calls.signedSims.length, 1, 'the signed bytes are simulated once'); assert.ok(calls.signedSims[0].bytes.equals(calls.sent[0]), 'the simulated bytes are the broadcast bytes')
  assert.equal(calls.signedSims[0].cfg.sigVerify, true); assert.deepEqual(calls.signedSims[0].cfg.accounts.addresses, [s.wallet, s.d.eventAccount])
  assert.ok(Transaction.from(calls.sent[0]).verifySignatures()) }
const refused = (r, s, reason) => { assert.match(r.error, /broadcasting is blocked\. Nothing was sent\./); if (reason) assert.match(r.error, reason)
  assert.equal(calls.sent.length, 0, 'nothing is broadcast'); assert.equal(calls.signs, 1, 'one wallet request, never a second'); assertPrivate(r, s) }

await test('Lighthouse: Phantom\'s observed shape (#2, #3, #5 read-only assertions) is accepted, re-simulated with signature verification and broadcast once', async () => {
  const s = setup(), r = await run(s, guarded(s))
  passes(r, s)
  const m = Message.from(Transaction.from(calls.sent[0]).serializeMessage())
  assert.deepEqual(m.instructions.map(i => m.accountKeys[i.programIdIndex].toBase58()), [CB, CB, LH.toBase58(), LH.toBase58(), SC.messageTransmitterProgram, LH.toBase58()])
})
await test('Lighthouse: every allowed type (2, 3, 5, 6) with each valid body passes; targets may be the wallet, the deposit, the Circle PDA or a program in the reclaim', async () => {
  const pda = PublicKey.findProgramAddressSync([Buffer.from('message_transmitter')], MT)[0]
  for (const [data, target] of [[LHD.infoLamports(5, 6), 'wallet'], [LHD.infoOwner(SystemProgram.programId), 'wallet'], [LHD.infoMulti(), 'event'], [LHD.data(), 'pda'], [LHD.dataMulti(), 'program']]) {
    const s = setup(), key = { wallet: s.wallet, event: s.d.eventAccount, pda, program: MT }[target]
    passes(await run(s, tx => signedWith(tx, [...tx.instructions, lh(data, [ro(key)])])), s)
  }
})
await test('Lighthouse: MemoryWrite, MemoryClose, AssertAccountDelta, token and unknown types are refused by name', async () => {
  for (const [data, name] of [[LHD.memoryWrite(), 'MemoryWrite'], [LHD.memoryClose(), 'MemoryClose'], [LHD.delta(), 'AssertAccountDelta'], [LHD.token(), 'AssertTokenAccount'], [LHD.unknown(), 'unknown type 42']]) {
    const s = setup(), r = await run(s, guarded(s, { second: lh(data, [ro(s.d.eventAccount)]) }))
    refused(r, s, new RegExp(`Reason: Lighthouse ${name} is not an allowed read-only assertion \\(#3\\)`))
    assert.match(r.error, new RegExp(`Lighthouse:${name.split(' ')[0]}`), 'the type name is also in the instruction list')
  }
})
await test('Lighthouse: a program id that is not exactly the Lighthouse address (look-alike / other program) is not an exception', async () => {
  const s = setup(), fake = new PublicKey(randomKey())
  refused(await run(s, guarded(s, { second: lh(LHD.data(), [ro(s.d.eventAccount)], fake) })), s, /a new account was added|the original reclaim or compute budget instructions changed/)
})
await test('Lighthouse: malformed bodies are refused (trailing byte, truncated, bad log level, operator, variant, boolean, empty or oversized multi, non-canonical length)', async () => {
  const bodies = [Buffer.concat([LHD.infoLamports(), Buffer.from([0])]), LHD.infoLamports().subarray(0, 6), Buffer.from([5, 7, 0, ...u64le(1), 4]), Buffer.from([5, 0, 0, ...u64le(1), 8]),
    Buffer.from([5, 0, 9, ...u64le(1), 4]), Buffer.from([5, 0, 5, 2, 0]), Buffer.from([6, 0, ...leb(0)]), Buffer.from([6, 0, ...leb(17), ...Array(17).fill([0, ...u64le(1), 4]).flat()]),
    Buffer.from([2, 0, 0x88, 0x00, 7, ...u64le(5), 2]), Buffer.from([2, 0, ...leb(0), 13, 0])]
  for (const body of bodies) { const s = setup(); refused(await run(s, guarded(s, { second: lh(body, [ro(s.d.eventAccount)]) })), s, /Reason: Lighthouse .*(malformed body|not an allowed)/) }
})
await test('Lighthouse decoder (pure): limits and exact consumption, independent of transaction size', async () => {
  const { decodeLighthouseAssertion, LIGHTHOUSE_ALLOWED_TYPES, LIGHTHOUSE_PROGRAM_ID } = require(root + 'src/lib/solanaLighthousePolicy.ts')
  assert.equal(LIGHTHOUSE_PROGRAM_ID, LH.toBase58()); assert.deepEqual([...LIGHTHOUSE_ALLOWED_TYPES].sort((a, b) => a - b), [2, 3, 5, 6, 15])
  assert.throws(() => decodeLighthouseAssertion(Buffer.from([2, 0, ...leb(0), 11, ...leb(1025), ...Buffer.alloc(1025), 0])), /byte assertion too long/)
  assert.deepEqual(decodeLighthouseAssertion(Buffer.from([2, 0, ...leb(0), 11, ...leb(1024), ...Buffer.alloc(1024), 1])), { type: 2, name: 'AssertAccountData' })
  assert.throws(() => decodeLighthouseAssertion(Buffer.from([5, 0, 8, ...Buffer.alloc(32), 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x01, 0])), /length out of range|malformed/)
  for (const t of [0, 1, 4, 7, 8, 9, 10, 11, 12, 13, 14, 16, 17, 18, 255]) assert.throws(() => decodeLighthouseAssertion(Buffer.from([t, 0, 0])), /is not an allowed read-only assertion/)
  assert.throws(() => decodeLighthouseAssertion(Buffer.alloc(0)), /not an allowed/)
})
const CLOCK = new PublicKey('SysvarC1ock11111111111111111111111111111111')
await test('Lighthouse AssertSysvarClock (15): accepted with no account or with only the read-only Clock sysvar, every clock variant', async () => {
  for (const [variant, keys] of [[0, () => []], [1, () => [ro(CLOCK)]], [2, () => []], [3, () => [ro(CLOCK)]], [4, () => [ro(CLOCK)]]]) {
    const s = setup()
    passes(await run(s, guarded(s, { first: lh(Buffer.from([15, variant % 7, variant, ...u64le(1), 4]), keys()) })), s)
  }
  const s = setup() // Phantom-like: clock before, data before, info after
  passes(await run(s, guarded(s, { first: lh(LHD.clock(), [ro(CLOCK)]) })), s)
})
await test('Lighthouse AssertSysvarClock (15): any other account shape, a writable Clock, or the Clock used elsewhere is refused', async () => {
  const cases = s => [
    [lh(LHD.clock(), [ro(s.wallet)]), /may reference only the Clock sysvar/],
    [lh(LHD.clock(), [ro(s.d.eventAccount)]), /may reference only the Clock sysvar/],
    [lh(LHD.clock(), [ro(CLOCK), ro(CLOCK)]), /may reference only the Clock sysvar/],
    [lh(LHD.clock(), [ro(CLOCK), ro(s.wallet)]), /may reference only the Clock sysvar/],
    [lh(LHD.clock(), [ro(randomKey())]), /a new account was added/],
    [lh(LHD.clock(), [{ pubkey: CLOCK, isSigner: false, isWritable: true }]), /writable accounts changed/],
    [lh(LHD.infoLamports(), [ro(CLOCK)]), /targets an account outside the reclaim/],
    [lh(LHD.data(), [ro(CLOCK)]), /targets an account outside the reclaim/],
  ]
  for (let i = 0; i < 8; i++) { const s = setup(); const [ix, why] = cases(s)[i]; refused(await run(s, guarded(s, { second: ix })), s, why) }
  // Clock as a program id (not Lighthouse) is not an exception either.
  const s = setup(); refused(await run(s, guarded(s, { more: [new TransactionInstruction({ programId: CLOCK, keys: [], data: Buffer.alloc(0) })] })), s, /original reclaim|Clock sysvar was added outside/)
})
await test('Lighthouse AssertSysvarClock (15): malformed bodies are refused (variant, operator, log level, truncated, trailing)', async () => {
  for (const body of [Buffer.from([15, 0, 5, ...u64le(1), 4]), Buffer.from([15, 0, 0, ...u64le(1), 8]), Buffer.from([15, 7, 0, ...u64le(1), 4]), Buffer.from([15, 0, 0, 1, 2, 3]), Buffer.from([15, 0, 0, ...u64le(1), 4, 0])]) {
    const s = setup(); refused(await run(s, guarded(s, { first: lh(body, []) })), s, /Reason: Lighthouse AssertSysvarClock has a malformed body/)
  }
})
await test('Lighthouse: wrong account shape is refused (two accounts, none, an account outside the reclaim, a new signer or new writable account)', async () => {
  const outsider = Keypair.generate()
  const cases = s => [
    [lh(LHD.data(), [ro(s.d.eventAccount), ro(s.wallet)]), /must target exactly one account/],
    [lh(LHD.data(), []), /must target exactly one account/],
    [lh(LHD.data(), [ro(randomKey())]), /a new account was added/],
    [lh(LHD.data(), [{ pubkey: outsider.publicKey, isSigner: true, isWritable: false }]), /signers changed|a new account was added/],
    [lh(LHD.data(), [{ pubkey: new PublicKey(randomKey()), isSigner: false, isWritable: true }]), /a new account was added|writable accounts changed/],
    [lh(LHD.data(), [ro(LH)]), /targets an account outside the reclaim/],
  ]
  for (let i = 0; i < 6; i++) { const s = setup(); const [ix, why] = cases(s)[i]
    refused(await run(s, tx => { const t = guarded(s, { second: ix })(tx); if (i === 3) t.partialSign(outsider); return t }), s, why) }
})
await test('Lighthouse: an assertion that makes an existing read-only account writable (or a signer) is refused', async () => {
  const s = setup()
  refused(await run(s, guarded(s, { second: lh(LHD.data(), [{ pubkey: MT, isSigner: false, isWritable: true }]) })), s, /writable accounts changed/)
  const s2 = setup(), pda = PublicKey.findProgramAddressSync([Buffer.from('message_transmitter')], MT)[0]
  refused(await run(s2, guarded(s2, { second: lh(LHD.data(), [{ pubkey: ComputeBudgetProgram.programId, isSigner: false, isWritable: true }]) })), s2, /writable accounts changed/)
  void pda
})
await test('Lighthouse: placed before the compute budget, more than 8 assertions, or added to a changed transaction is refused', async () => {
  const s = setup()
  refused(await run(s, tx => signedWith(tx, [lh(LHD.data(), [ro(s.d.eventAccount)]), ...tx.instructions])), s, /placed before the compute budget \(#0\)/)
  const s2 = setup()
  refused(await run(s2, guarded(s2, { more: Array.from({ length: 6 }, () => lh(LHD.infoLamports(), [ro(s2.wallet)])) })), s2, /too many wallet assertions/)
  const s3 = setup()
  refused(await run(s3, tx => { const data = Buffer.from(tx.instructions[2].data); data[30] ^= 1
    return guarded(s3, { reclaim: new TransactionInstruction({ programId: MT, keys: tx.instructions[2].keys, data }) })(tx) }), s3, /original reclaim or compute budget instructions changed/)
  const s4 = setup()
  refused(await run(s4, tx => signedWith(tx, [tx.instructions[0], ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 999_999 }), lh(LHD.data(), [ro(s4.d.eventAccount)]), tx.instructions[2]])), s4, /original reclaim or compute budget instructions changed/)
  const s5 = setup()
  refused(await run(s5, tx => { const t = rebuild(guarded(s5)(tx), { recentBlockhash: blockhash() }); return t }), s5, /blockhash changed/)
  const s6 = setup(), other = Keypair.generate()
  refused(await run(s6, tx => { const t = rebuild(guarded(s6)(tx), { feePayer: other.publicKey }); t.partialSign(other); return t }), s6, /fee payer changed/)
  const s7 = setup()
  refused(await run(s7, guarded(s7, { more: [SystemProgram.transfer({ fromPubkey: new PublicKey(s7.wallet), toPubkey: new PublicKey(randomKey()), lamports: 1_000_000 })] })), s7, /a new account was added|original reclaim/)
})
await test('signatures: a tampered, missing or foreign signature is refused before the final simulation and broadcast', async () => {
  const s = setup()
  refused(await run(s, tx => { const t = guarded(s)(tx); t.partialSign(s.phantom); t.signatures[0].signature[5] ^= 1; return { serializeMessage: () => t.serializeMessage(), serialize: () => t.serialize({ verifySignatures: false }), signatures: t.signatures, verifySignatures: () => t.verifySignatures(), partialSign() {} } }), s, /missing or invalid signature/)
  assert.equal(calls.signedSims.length, 0)
  const s2 = setup()
  refused(await run(s2, tx => ({ serializeMessage: () => tx.serializeMessage(), serialize: () => Buffer.from([1]), signatures: [{ publicKey: new PublicKey(s2.wallet), signature: null }], verifySignatures: () => false, partialSign() {} })), s2, /missing or invalid signature/)
})
await test('final simulation of the signed bytes: failure, budget overrun, missing effects, deposit left open or a short wallet credit block the broadcast', async () => {
  for (const [signed, why] of [[{ err: { InstructionError: [3, { Custom: 6400 }] } }, /would fail/], [{ units: 175_634_000 }, /compute budget was exceeded/], [{ units: undefined }, /compute budget was exceeded or not reported/],
    [{ accounts: undefined }, /account effects were not reported/], [{ accounts: [null, null] }, /wallet effect was not reported/], [{ depositOpen: true }, /deposit account would stay open/], [{ walletDelta: -1 }, /less than the deposit minus the network fee/]]) {
    const s = setup({ plan: { signed } }), r = await run(s, guarded(s))
    refused(r, s, why); assert.equal(calls.signedSims.length, 1)
  }
  const s = setup({ plan: { balanceError: true } }); refused(await run(s, guarded(s)), s, /wallet balance could not be read/)
})
await test('an unchanged signed transaction is also re-simulated with the same effect checks', async () => {
  const s = setup(); passes(await run(s), s)
  const s2 = setup({ plan: { signed: { walletDelta: -5000 } } }); refused(await run(s2), s2, /less than the deposit minus the network fee/)
})
await test('different wallets and deposits: the policy has no wallet- or deposit-specific data', async () => {
  for (const lamports of [2_039_280, 3_900_000, 4_100_000]) { const s = setup({ lamports }); passes(await run(s, guarded(s)), s) }
  const text = readFileSync(root + 'src/lib/solanaLighthousePolicy.ts', 'utf8') + readFileSync(root + 'src/lib/mainnetSolanaReclaim.ts', 'utf8')
  assert.equal((text.match(/L2TExMFKdjpN9kozasaurPirfHy9P8sbXoAN1qA3S95/g) ?? []).length, 2, 'the Lighthouse id appears once as a constant (and once in its evidence note)')
})
await test('production code holds no specific wallet, signature or account (generated values only in this test)', async () => {
  const text = readFileSync(root + 'src/lib/mainnetSolanaReclaim.ts', 'utf8')
  for (const v of ['7bJT7x7UBeMLS5PwhqazRZPjbZa5amnnRHbD9zrG8YQR', '5BfmjJL8atsQ8LDRr3AoNU4PKu4oy1AH7Bn4Yn846uHz', '8DEFF2A3aQs5Pv5mjYv8bzfF93q1GAtmMzpkwnee4Drq']) assert.ok(!text.includes(v))
})

console.log(`RESULT ${count}/${count} Solana reclaim signing-integrity groups PASS; real web3.js signing with generated keys; no network, real wallet or transaction`)
