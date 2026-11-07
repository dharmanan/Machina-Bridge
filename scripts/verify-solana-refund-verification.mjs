// Solana refundable-deposit verification: one algorithm for every Solana -> Arc deposit.
// Real code end to end: the client verifier (src/lib/mainnetSolanaReclaim.ts) calls the real same-origin
// proxy handler (api/solana-rpc.js), which calls controlled fake Solana providers; Circle Iris is a fake
// too. Every wallet, signature, event account, nonce, date and rent amount is generated per test
// (fixtures/solana-refund-deposits.cjs). No network, wallet, signature or transaction.
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
const require = createRequire(import.meta.url), ts = require('typescript'), root = fileURLToPath(new URL('..', import.meta.url))
require.extensions['.ts'] = (m, f) => m._compile(ts.transpileModule(readFileSync(f, 'utf8').replaceAll('import.meta.env', '({})'), { fileName: f,
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText, f)
const { makeDeposit, randomKey, randomSignature, accountData } = require('./fixtures/solana-refund-deposits.cjs')
const sol = require(root + 'src/lib/mainnetSolanaReclaim.ts'), activity = require(root + 'src/lib/mainnetSolanaActivity.ts')
const { SOLANA_MAINNET_CCTP: SC } = require(root + 'src/config/mainnetSolana.ts')
delete process.env.SOLANA_MAINNET_RPC
const { default: proxy } = await import('../api/solana-rpc.js')

class Store { data = new Map(); getItem(k) { return this.data.get(k) ?? null } setItem(k, v) { this.data.set(k, String(v)) } removeItem(k) { this.data.delete(k) } clear() { this.data.clear() } }
const storage = new Store()
globalThis.window = { localStorage: storage, dispatchEvent() {}, addEventListener() {}, removeEventListener() {} }
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { locks: { request: async (_n, _o, run) => run({}) } } })

const DAY = 86_400, now = () => Math.floor(Date.now() / 1000)
const P = { publicnode: 'https://solana-rpc.publicnode.com', drpc: 'https://solana.drpc.org', beta: 'https://api.mainnet-beta.solana.com',
  mainnet: 'https://api.mainnet.solana.com', ankr: 'https://rpc.ankr.com/solana' }

// ---- the controlled Solana world: chain state and per-provider behaviour ----
let world
function resetWorld() {
  world = { txs: new Map(), accounts: new Map(), iris: new Map(), upstream: [], irisCalls: [],
    // As observed on Mainnet: publicnode has no old history, dRPC rejects Solana on the free plan,
    // Ankr requires a key, the Solana Foundation endpoints serve the history.
    providers: {
      [P.publicnode]: { history: false }, [P.drpc]: { fail: () => Response.json({ jsonrpc: '2.0', id: 1, error: { code: 35, message: 'chain is not available on free plan' } }, { status: 400 }) },
      [P.beta]: { history: true }, [P.mainnet]: { history: true }, [P.ankr]: { fail: () => Response.json({ error: 'API key is not allowed to access blockchain' }, { status: 403 }) },
    } }
}
function add(deposit) { world.txs.set(deposit.signature, deposit.tx); world.accounts.set(deposit.eventAccount, deposit.accountInfo); world.iris.set(deposit.signature, deposit.iris); return deposit }
function providerAnswer(url, body) {
  const p = world.providers[url]
  if (p.fail) return p.fail(body)
  const ok = result => Response.json({ jsonrpc: '2.0', id: body.id, result })
  if (body.method === 'getTransaction') return ok(p.history ? world.txs.get(body.params[0]) ?? null : null)
  if (body.method === 'getMultipleAccounts') return ok({ context: { slot: 1 }, value: body.params[0].map(a => world.accounts.get(a) ?? null) })
  if (body.method === 'getAccountInfo') return ok({ context: { slot: 1 }, value: world.accounts.get(body.params[0]) ?? null })
  return Response.json({ jsonrpc: '2.0', id: body.id, error: { code: -32601, message: 'not in this test' } })
}
const mockRes = () => ({ statusCode: 0, body: '', headers: {}, status(c) { this.statusCode = c; return this }, setHeader(k, v) { this.headers[k] = v; return this }, send(b) { this.body = b; return this } })
globalThis.fetch = async (input, init = {}) => {
  const url = String(input)
  if (url === '/api/solana-rpc') {
    const res = mockRes()
    await proxy({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.parse(init.body) }, res)
    return new Response(res.body, { status: res.statusCode, headers: { 'content-type': 'application/json' } })
  }
  if (world.providers[url]) {
    const body = JSON.parse(init.body); world.upstream.push(`${new URL(url).hostname} ${body.method}`)
    return providerAnswer(url, body)
  }
  if (url.startsWith('https://iris-api.circle.com/v2/messages/5?transactionHash=')) {
    const sig = decodeURIComponent(url.split('transactionHash=')[1]); world.irisCalls.push(sig)
    const payload = world.iris.get(sig)
    return payload ? Response.json(payload) : new Response(null, { status: 404 })
  }
  throw new Error(`Network forbidden: ${url}`)
}
const rpc = async (method, params) => { const r = await globalThis.fetch('/api/solana-rpc', { body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) }); return { status: r.status, json: await r.json() } }
const verify = (d, wallet = d.wallet) => sol.loadMainnetSolanaRefundMetadata(d.signature, wallet)
const fails = async (promise, pattern) => { const e = await promise.then(() => null, x => x); assert.ok(e, 'expected a refusal'); assert.match(e.message, pattern); return e }

let count = 0
async function test(name, fn) { resetWorld(); storage.clear(); await fn(); count++; console.log(`PASS ${name}`) }

// ---------------------------------------------------------------- proxy: getTransaction null fallback
await test('proxy: first provider has no history (null), a later provider returns the transaction', async () => {
  const d = add(makeDeposit({ createdAtSec: now() - 6 * DAY }))
  const r = await rpc('getTransaction', [d.signature, { encoding: 'jsonParsed', commitment: 'finalized', maxSupportedTransactionVersion: 0 }])
  assert.equal(r.status, 200); assert.equal(r.json.result.transaction.signatures[0], d.signature)
  assert.deepEqual(world.upstream, ['solana-rpc.publicnode.com getTransaction', 'solana.drpc.org getTransaction', 'api.mainnet-beta.solana.com getTransaction'])
})
await test('proxy: every provider answers null or fails: HTTP 200 result null, each provider asked once', async () => {
  const r = await rpc('getTransaction', [randomSignature(), { encoding: 'jsonParsed', commitment: 'finalized', maxSupportedTransactionVersion: 0 }])
  assert.equal(r.status, 200); assert.equal(r.json.result, null); assert.equal(r.json.error, undefined)
  assert.equal(world.upstream.length, 5)
})
await test('proxy: 429/503 providers are skipped and the first provider that has the transaction answers', async () => {
  const d = add(makeDeposit({ createdAtSec: now() - 7 * DAY }))
  world.providers[P.publicnode] = { fail: () => new Response('busy', { status: 503 }) }
  world.providers[P.beta] = { fail: () => Response.json({ jsonrpc: '2.0', id: 1, error: { code: 429, message: 'Too many requests' } }, { status: 429 }) }
  const r = await rpc('getTransaction', [d.signature, { encoding: 'jsonParsed', commitment: 'finalized', maxSupportedTransactionVersion: 0 }])
  assert.equal(r.json.result.transaction.signatures[0], d.signature)
  assert.equal(world.upstream.at(-1), 'api.mainnet.solana.com getTransaction')
})
await test('proxy: getSignaturesForAddress [] from a provider without history asks the next; [] only when none has history', async () => {
  const sig = { signature: randomSignature(), slot: 1, err: null, memo: null, blockTime: now(), confirmationStatus: 'finalized' }
  world.providers[P.publicnode] = { fail: () => Response.json({ jsonrpc: '2.0', id: 1, result: [] }) }
  world.providers[P.beta] = { fail: () => Response.json({ jsonrpc: '2.0', id: 1, result: [sig] }) }
  const r = await rpc('getSignaturesForAddress', [randomKey(), { limit: 10, commitment: 'finalized' }])
  assert.deepEqual(r.json.result, [sig]); assert.deepEqual(world.upstream, ['solana-rpc.publicnode.com getSignaturesForAddress', 'solana.drpc.org getSignaturesForAddress', 'api.mainnet-beta.solana.com getSignaturesForAddress'])
  world.providers[P.beta] = { fail: () => Response.json({ jsonrpc: '2.0', id: 1, result: [] }) }; world.providers[P.mainnet] = { fail: () => Response.json({ jsonrpc: '2.0', id: 1, result: [] }) }
  const none = await rpc('getSignaturesForAddress', [randomKey(), { limit: 10 }])
  assert.equal(none.status, 200); assert.deepEqual(none.json.result, [])
})
await test('proxy: null is retried for getTransaction only; an absent account (getAccountInfo null) is the first answer', async () => {
  const r = await rpc('getAccountInfo', [randomKey(), { encoding: 'base64' }])
  assert.equal(r.json.result.value, null); assert.deepEqual(world.upstream, ['solana-rpc.publicnode.com getAccountInfo'])
})

// ---------------------------------------------------------------- one algorithm for many wallets and deposits
await test('several wallets, several deposits, different dates and rents: each verified from its own chain data', async () => {
  const a1 = add(makeDeposit({ createdAtSec: now() - 9 * DAY, lamports: 3_900_000 }))
  const a2 = add(makeDeposit({ wallet: a1.wallet, createdAtSec: now() - 1 * DAY, lamports: 4_100_000 }))
  const b1 = add(makeDeposit({ createdAtSec: now() - 6 * DAY + 3600, lamports: 2_039_280 }))
  for (const [d, sol_] of [[a1, '0.0039'], [a2, '0.0041'], [b1, '0.00203928']]) {
    const v = await verify(d)
    assert.equal(v.sourceTxHash, d.signature); assert.equal(v.solanaWallet, d.wallet); assert.equal(v.messageSentEventAccount, d.eventAccount)
    assert.equal(v.refundableDepositSol, sol_, 'real lamports, not an estimate')
    assert.equal(v.createdAt, d.createdAtSec * 1000); assert.equal(v.refundAvailableAt, (d.createdAtSec + 5 * DAY) * 1000, 'on-chain created_at + 5 days')
    assert.equal(v.refundDestinationMessage, d.attestedMessage); assert.equal(v.refundAttestation, d.iris.messages[0].attestation)
  }
  assert.ok((await verify(a2)).refundAvailableAt > Date.now(), 'a not yet eligible deposit stays not eligible')
  assert.ok(!world.upstream.some(l => /simulate|send|Blockhash/i.test(l)), 'verification is read-only')
})
await test('source transaction readable only from a later provider (first returns null) is verified through the proxy', async () => {
  const d = add(makeDeposit({ createdAtSec: now() - 6 * DAY }))
  await verify(d)
  assert.ok(world.upstream.includes('solana-rpc.publicnode.com getTransaction') && world.upstream.includes('api.mainnet-beta.solana.com getTransaction'))
})
await test('no provider has the source transaction: refused as "not available yet", nothing recorded', async () => {
  const d = makeDeposit({ createdAtSec: now() - 6 * DAY }); world.accounts.set(d.eventAccount, d.accountInfo)
  await fails(verify(d), /not available from the Solana RPC providers yet.*retry later/)
  assert.equal(world.irisCalls.length, 0)
})
await test('proxy outage (all providers fail) is reported, never treated as verified or as "no deposit"', async () => {
  const d = add(makeDeposit({ createdAtSec: now() - 6 * DAY }))
  for (const url of Object.values(P)) world.providers[url] = { fail: () => new Response('down', { status: 503 }) }
  await fails(verify(d), /503/)
})

// ---------------------------------------------------------------- wrong source, wallet, account or attestation
await test('wrong wallet: a deposit is never verified for a wallet that did not sign and pay for it', async () => {
  const a = add(makeDeposit({ createdAtSec: now() - 6 * DAY })), b = add(makeDeposit({ createdAtSec: now() - 6 * DAY }))
  await fails(verify(a, b.wallet), /not signed by this Phantom wallet/)
  await fails(verify(b, a.wallet), /not signed by this Phantom wallet/)
})
await test('invalid source transaction: failed, or a provider answering with a different transaction', async () => {
  const failed = add(makeDeposit({ createdAtSec: now() - 6 * DAY })); failed.tx.meta.err = { InstructionError: [2, { Custom: 1 }] }
  await fails(verify(failed), /did not succeed/)
  const swapped = add(makeDeposit({ createdAtSec: now() - 6 * DAY })); swapped.tx.transaction.signatures[0] = randomSignature()
  await fails(verify(swapped), /different transaction than the one requested/)
})
await test('wrong event account: not used by Circle MessageTransmitter, or two candidates', async () => {
  const notCircle = add(makeDeposit({ createdAtSec: now() - 6 * DAY }))
  notCircle.tx.meta.innerInstructions[0].instructions[1].accounts = [notCircle.wallet, randomKey()]
  await fails(verify(notCircle), /exactly one Circle deposit account/)
  const twice = add(makeDeposit({ createdAtSec: now() - 6 * DAY })), extra = randomKey()
  twice.tx.transaction.message.accountKeys.push({ pubkey: extra, signer: true, writable: true, source: 'transaction' })
  twice.tx.meta.innerInstructions[0].instructions[1].accounts.push(extra)
  await fails(verify(twice), /exactly one Circle deposit account/)
})
await test('deposit account paid by another wallet, owned by another program, or holding another wallet\'s message', async () => {
  const otherPayer = add(makeDeposit({ createdAtSec: now() - 6 * DAY }))
  otherPayer.accountInfo.data[0] = accountData({ rentPayer: randomKey(), createdAtSec: otherPayer.createdAtSec, onChainMessage: otherPayer.onChainMessage }).toString('base64')
  await fails(verify(otherPayer), /not an open deposit paid by this Phantom wallet/)
  const otherOwner = add(makeDeposit({ createdAtSec: now() - 6 * DAY })); otherOwner.accountInfo.owner = randomKey()
  await fails(verify(otherOwner), /owned by another program/)
  const otherSender = add(makeDeposit({ createdAtSec: now() - 6 * DAY })), foreign = makeDeposit({ createdAtSec: otherSender.createdAtSec })
  otherSender.accountInfo.data[0] = accountData({ rentPayer: otherSender.wallet, createdAtSec: otherSender.createdAtSec, onChainMessage: foreign.onChainMessage }).toString('base64')
  await fails(verify(otherSender), /different source wallet/)
})
await test('closed deposit account: refused (never "reclaimed" or "already closed" from verification), nothing recorded', async () => {
  const d = add(makeDeposit({ createdAtSec: now() - 9 * DAY })); world.accounts.delete(d.eventAccount)
  storage.setItem(activity.MAINNET_SOLANA_ACTIVITY_KEY, JSON.stringify([{ id: 'r', evmWallet: d.evm, solanaWallet: d.wallet, direction: 'solana-to-arc', amount: '0.1', sourceTxHash: d.signature, createdAt: Date.now(), refundStatus: 'pending' }]))
  await fails(verify(d), /closed or not visible yet/)
  const [record] = activity.readMainnetSolanaActivity()
  assert.equal(record.refundStatus, 'pending'); assert.equal(record.refundVerifiedAt, undefined); assert.equal(record.messageSentEventAccount, undefined)
})
await test('missing or mismatching Circle attestation: never verified', async () => {
  const none = add(makeDeposit({ createdAtSec: now() - 6 * DAY })); world.iris.delete(none.signature)
  await fails(verify(none), /attestation for this deposit is pending/)
  const pending = add(makeDeposit({ createdAtSec: now() - 6 * DAY })); pending.iris.messages[0].status = 'pending_confirmations'
  await fails(verify(pending), /pending/)
  const mismatch = add(makeDeposit({ createdAtSec: now() - 6 * DAY })), other = makeDeposit({ wallet: mismatch.wallet, createdAtSec: mismatch.createdAtSec, amount: 250_000 })
  world.iris.set(mismatch.signature, other.iris)
  await fails(verify(mismatch), /does not match the source-chain burn evidence/)
})

// ---------------------------------------------------------------- local records: exact wallet + source match only
const seedRecords = records => storage.setItem(activity.MAINNET_SOLANA_ACTIVITY_KEY, JSON.stringify(records))
const rec = (d, extra = {}) => ({ id: 'id-' + d.signature.slice(0, 10) + (extra.idSuffix ?? ''), evmWallet: d.evm, solanaWallet: d.wallet, direction: 'solana-to-arc', amount: '0.1',
  sourceTxHash: d.signature, createdAt: Date.now() - 1000, refundStatus: 'pending', estimatedRefundableDepositSol: '0.0031', estimatedRefundAvailableAt: Date.now() - 1, ...extra })
const byId = id => activity.readMainnetSolanaActivity().find(r => r.id === id)
await test('verified metadata is written only to the record of the same wallet and source signature', async () => {
  const a1 = add(makeDeposit({ createdAtSec: now() - 9 * DAY })), a2 = add(makeDeposit({ wallet: a1.wallet, createdAtSec: now() - 2 * DAY }))
  const b1 = add(makeDeposit({ createdAtSec: now() - 6 * DAY }))
  // A record of wallet B that (corruptly) carries A1's signature must not receive A1's deposit.
  seedRecords([rec(a1), rec(a2), rec(b1), { ...rec(a1, { idSuffix: '-b' }), solanaWallet: b1.wallet }])
  const v = await verify(a1)
  assert.ok(activity.applyVerifiedSolanaRefund(v))
  const r1 = byId(rec(a1).id)
  assert.equal(r1.messageSentEventAccount, a1.eventAccount); assert.equal(r1.refundableDepositSol, '0.0039'); assert.equal(r1.refundAvailableAt, (a1.createdAtSec + 5 * DAY) * 1000)
  assert.equal(typeof r1.refundVerifiedAt, 'number'); assert.ok(activity.isVerifiedSolanaRefund(r1))
  assert.equal(r1.estimatedRefundableDepositSol, '0.0031', 'the estimate stays separate')
  for (const id of [rec(a2).id, rec(b1).id, rec(a1, { idSuffix: '-b' }).id]) {
    const r = byId(id); assert.equal(r.refundVerifiedAt, undefined, id); assert.equal(r.messageSentEventAccount, undefined, id); assert.ok(!activity.isVerifiedSolanaRefund(r))
  }
  // B's verification result never lands on A's record and vice versa.
  assert.equal(activity.applyVerifiedSolanaRefund({ ...(await verify(b1)), sourceTxHash: a2.signature }), null)
  assert.equal(byId(rec(a2).id).refundVerifiedAt, undefined)
  // Signature case matters on Solana (base58): a case-changed hash matches nothing.
  assert.equal(activity.findSolanaRefundRecord(a1.wallet, a1.signature.toLowerCase()), null)
})
await test('ambiguous (duplicate) records, reclaimed records, Arc->Solana records and malformed metadata are never written', async () => {
  const d = add(makeDeposit({ createdAtSec: now() - 8 * DAY })), v = await verify(d)
  seedRecords([rec(d), rec(d, { idSuffix: '-dup' })])
  assert.equal(activity.applyVerifiedSolanaRefund(v), null, 'two records of the same wallet and source: nothing is written')
  seedRecords([rec(d, { refundStatus: 'reclaimed', refundTxHash: randomSignature() })])
  assert.equal(activity.applyVerifiedSolanaRefund(v), null); assert.equal(activity.readMainnetSolanaActivity()[0].refundStatus, 'reclaimed')
  seedRecords([{ ...rec(d), direction: 'arc-to-solana' }])
  assert.equal(activity.applyVerifiedSolanaRefund(v), null)
  seedRecords([rec(d)])
  for (const bad of [{ refundAttestation: 'PENDING' }, { refundDestinationMessage: '' }, { refundAvailableAt: NaN }, { refundableDepositSol: '~0.003' }, { messageSentEventAccount: 'x' }])
    assert.equal(activity.applyVerifiedSolanaRefund({ ...v, ...bad }), null, JSON.stringify(bad))
  assert.equal(activity.readMainnetSolanaActivity()[0].refundVerifiedAt, undefined)
})
await test('legacy record (estimate in the main fields) keeps the estimate apart after verification; errors go to the matching record only', async () => {
  const d = add(makeDeposit({ createdAtSec: now() - 3 * DAY, lamports: 4_000_000 })), other = add(makeDeposit({ createdAtSec: now() - 3 * DAY }))
  const legacyAt = Date.now() - 60_000
  seedRecords([{ id: 'legacy', evmWallet: d.evm, solanaWallet: d.wallet, direction: 'solana-to-arc', amount: '0.1', sourceTxHash: d.signature, createdAt: Date.now() - 1000, refundStatus: 'pending', refundableDepositSol: '0.0031', refundAvailableAt: legacyAt }, rec(other)])
  assert.ok(!activity.isVerifiedSolanaRefund(byId('legacy')), 'an estimate-only legacy record is not verified')
  activity.recordSolanaRefundVerificationError(d.wallet, d.signature, 'controlled failure')
  assert.equal(byId('legacy').refundVerificationError, 'controlled failure'); assert.equal(byId(rec(other).id).refundVerificationError, undefined)
  assert.ok(activity.applyVerifiedSolanaRefund(await verify(d)))
  const r = byId('legacy')
  assert.equal(r.estimatedRefundableDepositSol, '0.0031'); assert.equal(r.estimatedRefundAvailableAt, legacyAt)
  assert.equal(r.refundableDepositSol, '0.004'); assert.equal(r.refundAvailableAt, (d.createdAtSec + 5 * DAY) * 1000)
  assert.ok(r.refundAvailableAt > Date.now(), 'the passed estimate does not make it eligible: the chain time is 2 days ahead')
  assert.equal(r.refundVerificationError, undefined)
})

await test('history rows say "reclaimable" only from verified chain data; estimates are labelled as estimates', async () => {
  const { solanaHistoryItem } = require(root + 'src/lib/bridgeHistory.ts')
  const d = add(makeDeposit({ createdAtSec: now() - 9 * DAY })), base = rec(d)
  assert.equal(solanaHistoryItem(base).refund, '~0.0031 SOL (estimate) · not verified on Solana yet')
  assert.equal(solanaHistoryItem({ ...base, estimatedRefundableDepositSol: undefined, estimatedRefundAvailableAt: undefined, refundableDepositSol: '0.0031', refundAvailableAt: Date.now() - 1 }).refund,
    '~0.0031 SOL (estimate) · not verified on Solana yet', 'a legacy estimate in the main fields is not "reclaimable now"')
  seedRecords([base]); activity.applyVerifiedSolanaRefund(await verify(d))
  assert.equal(solanaHistoryItem(activity.readMainnetSolanaActivity()[0]).refund, '0.0039 SOL · reclaimable now')
  assert.equal(solanaHistoryItem({ ...activity.readMainnetSolanaActivity()[0], refundStatus: 'reclaimed' }).refund, null)
})

// ---------------------------------------------------------------- reclaim keeps its own gates on verified data
await test('a verified but not yet eligible deposit is refused by reclaim before any RPC or wallet request', async () => {
  const d = add(makeDeposit({ createdAtSec: now() - 2 * DAY })), v = await verify(d)
  let signs = 0
  await fails(sol.reclaimMainnetSolanaDeposit({ connectedWallet: d.wallet, originalWallet: d.wallet, metadata: v, provider: { signTransaction: async () => { signs++ } } }), /not eligible yet/)
  assert.equal(signs, 0)
})
await test('a verified deposit cannot be reclaimed into another Phantom wallet', async () => {
  const d = add(makeDeposit({ createdAtSec: now() - 8 * DAY })), v = await verify(d)
  let signs = 0
  await fails(sol.reclaimMainnetSolanaDeposit({ connectedWallet: randomKey(), originalWallet: d.wallet, metadata: v, provider: { signTransaction: async () => { signs++ } } }), /same Phantom wallet/)
  assert.equal(signs, 0)
})

// ---------------------------------------------------------------- no user-specific data in production code
await test('production code holds no wallet, transaction, event account or nonce of a specific user', async () => {
  // Values of the two real Mainnet deposits used only for the live, read-only check of this fix.
  const realValues = ['QsF23bfaQ5Wh1w6nxseNfqfYgvQztM4F2mMjweRhTY9fGMuMxNo1GB73uMRcBCsdysq8MZTexGhssrrhkp5y853', 'pYhUmz1sPvbQZ2PJRKosdeag1Yh1it7GtRhUobkjF5UKd9845WGZGraiV7otcvMqGn8KxRFLft5yXJ3RMF1JJFF',
    '7bJT7x7UBeMLS5PwhqazRZPjbZa5amnnRHbD9zrG8YQR', '5BfmjJL8atsQ8LDRr3AoNU4PKu4oy1AH7Bn4Yn846uHz', '8DEFF2A3aQs5Pv5mjYv8bzfF93q1GAtmMzpkwnee4Drq', '33b6f5f6618c484cef9a2f24de9e4074', '31a09c65e23b124d5214b2747626cb22']
  const files = []
  const walk = dir => { for (const f of readdirSync(dir)) { const p = join(dir, f); if (statSync(p).isDirectory()) walk(p); else if (/\.(ts|tsx|js|mjs|json)$/.test(f)) files.push(p) } }
  walk(join(root, 'src')); walk(join(root, 'api'))
  for (const file of files) { const text = readFileSync(file, 'utf8'); for (const value of realValues) assert.ok(!text.includes(value), `${value.slice(0, 8)}… hardcoded in ${file}`) }
  assert.ok(files.length > 20)
})

console.log(`RESULT ${count}/${count} Solana refund verification groups PASS; generated wallets/deposits, real proxy handler and verifier; no network, wallet or transaction`)
