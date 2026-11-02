// Arc -> Solana recovery receive with evidence: the real journal, signing wrapper and settlement
// with a fake Phantom, a fake Bridge Kit send/confirm and controlled HTTP chain answers.
// The pending receive of burn 0x22e768dd… (0.0984 USDC) is recovered without any new burn.
// No network, no real wallet, no signature, no transaction.
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
const require = createRequire(import.meta.url), ts = require('typescript')
require.extensions['.ts'] = (m, f) => m._compile(ts.transpileModule(readFileSync(f, 'utf8').replaceAll('import.meta.env', '({})'), { fileName: f, compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText, f)

const store = new Map()
globalThis.localStorage = { getItem: k => store.has(k) ? store.get(k) : null, setItem: (k, v) => store.set(k, String(v)), removeItem: k => store.delete(k) }
globalThis.window = { localStorage: globalThis.localStorage, dispatchEvent() {}, addEventListener() {}, removeEventListener() {}, setTimeout, clearTimeout }

const { VersionedTransaction, TransactionMessage, TransactionInstruction, PublicKey, ComputeBudgetProgram, SystemProgram } = require('@solana/web3.js')
const E = require('../src/lib/arcSolanaReceiveEvidence.ts')
const { recordMainnetSolanaActivity, readMainnetSolanaActivity } = require('../src/lib/mainnetSolanaActivity.ts')
const { decodeCctpRecoveryMessage } = require('../src/lib/mainnetCctpRecovery.ts')
const FX = JSON.parse(readFileSync(new URL('./fixtures/arc-solana-pending-receive.json', import.meta.url)))
const MT = new PublicKey('CCTPV2Sm4AdWt5296sk4P66VBZ7bEhcARwFaaS9YPbeC'), OWNER = new PublicKey(FX.owner)
const BLOCKHASH = '4sGjMW1sUnHzSxGspuhpqLDx6wiyjNtZAMdL4VZHirAn', B1_KEY = 'machina_mainnet_solana_send_v1'
const le32 = n => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b }
const msg = Buffer.from(FX.message.slice(2), 'hex'), att = Buffer.from(FX.attestation.slice(2), 'hex')
// The receive transaction the SDK would build for this burn (real message + attestation).
const receiveTx = () => new VersionedTransaction(new TransactionMessage({ payerKey: OWNER, recentBlockhash: BLOCKHASH, instructions: [
  ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 300000 }), ComputeBudgetProgram.setComputeUnitLimit({ units: 350000 }),
  new TransactionInstruction({ programId: MT, keys: [{ pubkey: OWNER, isSigner: true, isWritable: true }], data: Buffer.concat([Buffer.from('26907fe11fe1ee19', 'hex'), le32(msg.length), msg, le32(att.length), att]) }),
] }).compileToV0Message())
const ataOnlyTx = () => new VersionedTransaction(new TransactionMessage({ payerKey: OWNER, recentBlockhash: BLOCKHASH, instructions: [ComputeBudgetProgram.setComputeUnitLimit({ units: 50000 }), SystemProgram.transfer({ fromPubkey: OWNER, toPubkey: OWNER, lamports: 0 })] }).compileToV0Message())

// Controlled HTTP chain answers.
function chain(o = {}) {
  const c = { nonceA: false, nonceB: false, statuses: new Map(), valid: new Set([BLOCKHASH]), pdaTx: 0, fail: null, reads: [], ...o }
  const read = (name, v) => { c.reads.push(name); if (c.fail === name || c.fail === 'all') throw new Error(`${name} unreachable`); return v }
  c.reads_ = {
    nonceUsedA: async m => { assert.equal(m, FX.message); return read('nonceA', c.nonceA) },
    nonceUsedB: async m => { assert.equal(m, FX.message); return read('nonceB', c.nonceB) },
    signatureStatus: async s => read('status', c.statuses.get(s) ?? { found: false }),
    blockhashValid: async b => read('blockhash', c.valid.has(b)),
    signaturesTouching: async a => { assert.equal(a, FX.usedNoncePda); return read('pda', c.pdaTx) },
  }
  return c
}
// Fake Phantom: what the wallet does with the request.
function phantom(mode = 'sign') {
  const calls = []
  return { calls, isConnected: true, publicKey: OWNER, connect: async () => ({ publicKey: OWNER }), disconnect: async () => {},
    async signTransaction(tx) {
      calls.push('signTransaction')
      if (mode === 'reject') throw Object.assign(new Error('User rejected the request.'), { code: 4001 })
      if (mode === 'error') throw new Error('Unexpected error')
      tx.signatures[0] = Uint8Array.from({ length: 64 }, (_, i) => (i * 13 + calls.length) % 256)
      return tx
    } }
}
// Fake Bridge Kit execute(): sign, then broadcast/confirm with the given outcome. Like the SDK, every
// error is wrapped (code 3001 "Network connection failed for Solana" or an unknown blockchain error).
const kitError = (raw, network) => Object.assign(new Error(network ? 'Network connection failed for Solana' : `Unknown blockchain error: ${raw.message}`), { name: 'KitError', code: network ? 3001 : 9001, cause: { trace: { rawError: raw } } })
function sdk(c, outcome, txs = [receiveTx()]) {
  const seen = { broadcastSawSigned: [] }
  seen.execute = async provider => {
    let signature
    for (const tx of txs) {
      let signed
      try { signed = await provider.signTransaction(tx) } catch (e) { throw e?.name === 'SolanaTxPolicyError' ? e : kitError(e, /network|timeout/i.test(e.message)) }
      signature = require('../src/lib/solanaSendGuard.ts').solanaSignatureOf(signed).signature
      // Broadcast happens only after the wallet returned: the journal must already hold the signature.
      const entry = E.readReceiveEntries()[0]
      seen.broadcastSawSigned.push(Boolean(entry.signed?.some(s => s.signature === signature)))
    }
    if (outcome === 'ok') { c.statuses.set(signature, { found: true, err: null, confirmationStatus: 'confirmed' }); c.nonceA = c.nonceB = true; return signature }
    if (outcome === 'network') throw kitError(new Error(`504 Gateway Timeout: upstream timed out for ${signature} at https://rpc.example.com/?api-key=SECRET123 data 0x${'ab'.repeat(40)}`), true)
    if (outcome === 'landed-but-timeout') { c.statuses.set(signature, { found: true, err: null, confirmationStatus: 'confirmed' }); c.nonceA = c.nonceB = true; throw kitError(new Error('Signature has expired: block height exceeded.'), false) }
    if (outcome === 'failed-on-chain') { c.statuses.set(signature, { found: true, err: { InstructionError: [2, 'Custom'] } }); throw kitError(new Error('Transaction failed: {"InstructionError":[2,"Custom"]}'), false) }
    throw new Error('unknown outcome')
  }
  return seen
}
// Mirrors the hook's recovery sequence with the same exported functions.
async function recover(c, wallet, outcome, { policy, legacyActivityStatus, txs } = {}) {
  const gate = await E.openReceiveAttempt({ sourceTxHash: FX.sourceTxHash, owner: FX.owner, message: FX.message, legacyActivityStatus }, c.reads_)
  if (gate.kind === 'already-received') return { kind: 'already-received' }
  const signer = E.createReceiveEvidenceSigner(wallet, gate.entryId)
  const provider = policy ? { ...signer, signTransaction: async tx => { policy(tx); return signer.signTransaction(tx) } } : signer // a pre-sign policy runs before the wallet wrapper
  const run = sdk(c, outcome, txs)
  try {
    const signature = await run.execute(provider)
    E.updateReceiveEntry(gate.entryId, { phase: 'sent' })
    if (!(await c.reads_.nonceUsedA(FX.message))) throw new Error('not verified')
    E.updateReceiveEntry(gate.entryId, { phase: 'complete' })
    return { kind: 'received', signature, run }
  } catch (e) { const entry = E.classifyFailedAttempt(gate.entryId, e); e.entry = entry; e.run = run; throw e }
}
const latest = () => E.latestReceiveEntry(FX.sourceTxHash)
const sameMessage = () => { const m = decodeCctpRecoveryMessage(FX.message); assert.equal(m.amount, 98400n); assert.equal(m.destinationDomain, 5) }
let count = 0
async function test(name, fn) { store.clear(); await fn(); count++; console.log('PASS ' + name) }

await test('fixture: the real pending message pays 0.0984 USDC to the Phantom ATA; the nonce PDA matches the chain', () => {
  sameMessage(); assert.equal(E.usedNoncePda(FX.message), FX.usedNoncePda)
})
await test('happy path: wallet request time and the signed signature/blockhash are journaled before the SDK broadcasts; receive completes; no burn', async () => {
  const c = chain(), w = phantom()
  const r = await recover(c, w, 'ok')
  assert.equal(r.kind, 'received'); assert.deepEqual(r.run.broadcastSawSigned, [true], 'signature on disk before broadcast')
  const e = latest()
  assert.equal(e.phase, 'complete'); assert.ok(e.walletRequestedAt && e.receiveRequestedAt); assert.equal(e.requestedBlockhash, BLOCKHASH)
  assert.equal(e.signature, r.signature); assert.equal(e.signed[0].blockhash, BLOCKHASH)
  assert.equal(store.get(B1_KEY), undefined, 'B1 burn journal untouched: no burn')
  assert.deepEqual(w.calls, ['signTransaction'])
})
await test('network error after signing (the reported failure): unknown with signature; retry is locked while the blockhash is valid; released only after signature absent + blockhash expired + nonce unused (two readers); then recovered', async () => {
  const c = chain(), w = phantom()
  await assert.rejects(recover(c, w, 'network'), e => e.entry.phase === 'unknown' && e.message === 'Network connection failed for Solana')
  const e = latest()
  assert.ok(e.signature); assert.match(e.lastError.message, /504 Gateway Timeout/); assert.equal(e.lastError.code, 3001)
  assert.doesNotMatch(JSON.stringify(e.lastError), /SECRET123|abababab|[1-9A-HJ-NP-Za-km-z]{60,}/, 'no secrets, payload or signature in the saved error')
  await assert.rejects(recover(c, w, 'ok'), err => err instanceof E.ReceiveLockedError && /blockhash is valid/.test(err.message))
  assert.equal(w.calls.length, 1, 'no second wallet request while the first could land')
  c.valid.clear() // the signed transaction expired
  c.reads.length = 0
  const r = await recover(c, w, 'ok')
  assert.equal(r.kind, 'received'); assert.equal(w.calls.length, 2)
  assert.ok(c.reads.filter(x => x === 'status').length >= 2, 'signature status re-read after the expiry check')
  assert.equal(E.readReceiveEntries().find(x => x.id === e.id).failure, 'expired')
})
await test('the SDK reported a timeout but the receive landed: settled as received, no second wallet request', async () => {
  const c = chain(), w = phantom()
  await assert.rejects(recover(c, w, 'landed-but-timeout'), e => e.entry.phase === 'unknown')
  assert.equal((await recover(c, w, 'ok')).kind, 'already-received'); assert.equal(w.calls.length, 1)
  assert.equal(latest().phase, 'complete')
})
await test('the receive failed on chain (nonce unused): released from the exact signature status, then retried', async () => {
  const c = chain(), w = phantom()
  await assert.rejects(recover(c, w, 'failed-on-chain'))
  assert.equal((await recover(c, w, 'ok')).kind, 'received'); assert.equal(w.calls.length, 2)
})
await test('explicit wallet rejection (4001 from Phantom, wrapped by the SDK) is "not sent"; a generic SDK error is not treated as a rejection', async () => {
  const c = chain()
  await assert.rejects(recover(c, phantom('reject'), 'ok'), e => e.entry.phase === 'failed' && e.entry.failure === 'user-rejected')
  assert.equal((await recover(c, phantom(), 'ok')).kind, 'received', 'next request allowed at once')
  store.clear()
  const c2 = chain(), w2 = phantom('error')
  await assert.rejects(recover(c2, w2, 'ok'), e => e.entry.phase === 'unknown' && !e.entry.failure, 'a non-4001 wallet error stays unknown')
  await assert.rejects(recover(c2, phantom(), 'ok'), err => err instanceof E.ReceiveLockedError && /wallet request is recent/.test(err.message))
  c2.valid.clear()
  assert.equal((await recover(c2, phantom(), 'ok')).kind, 'received', 'released only after the requested blockhash expired')
})
await test('a pre-sign policy refusal never reaches the wallet: "not sent" (G2 policy compatible)', async () => {
  const c = chain(), w = phantom()
  const policy = () => { throw Object.assign(new Error('Machina stopped this Solana transaction before your wallet saw it (program)'), { name: 'SolanaTxPolicyError', code: 'program' }) }
  await assert.rejects(recover(c, w, 'ok', { policy }), e => e.entry.phase === 'failed' && e.entry.failure === 'pre-wallet')
  assert.deepEqual(w.calls, []); assert.equal(latest().walletRequestedAt, undefined)
  assert.equal((await recover(c, w, 'ok')).kind, 'received')
})
await test('any failed chain read keeps the lock and asks nothing; readers that disagree keep it too', async () => {
  for (const fail of ['nonceA', 'nonceB', 'status', 'blockhash']) {
    store.clear(); const c = chain(), w = phantom()
    await assert.rejects(recover(c, w, 'network')); c.valid.clear(); c.fail = fail
    await assert.rejects(recover(c, w, 'ok'), err => /unreachable/.test(err.message)); assert.equal(w.calls.length, 1, `no request when ${fail} fails`)
    assert.equal(latest().phase, 'unknown')
  }
  store.clear(); const c = chain({ nonceA: true, nonceB: false }), w = phantom()
  await assert.rejects(recover(c, w, 'ok'), err => err instanceof E.ReceiveLockedError && /disagree/.test(err.message)); assert.deepEqual(w.calls, [])
})
await test('journal write failures: before the wallet nothing is asked; after signing the signed transaction is not handed to the SDK', async () => {
  const c = chain(), w = phantom(), real = localStorage.setItem
  const gate = await E.openReceiveAttempt({ sourceTxHash: FX.sourceTxHash, owner: FX.owner, message: FX.message }, c.reads_)
  const signer = E.createReceiveEvidenceSigner(w, gate.entryId)
  localStorage.setItem = () => { throw new Error('quota') }
  await assert.rejects(signer.signTransaction(receiveTx()), /quota/); assert.deepEqual(w.calls, [])
  let writes = 0; localStorage.setItem = (k, v) => { if (++writes === 2) throw new Error('quota'); real(k, v) } // 1st = requesting, 2nd = signed
  await assert.rejects(signer.signTransaction(receiveTx()), /quota/); assert.equal(w.calls.length, 1, 'signed, but the signed transaction was not returned')
  localStorage.setItem = real
})
await test('older record without evidence (old createdAt kept by Activity): never unlocked by time; needs independent checks + explicit confirmation', async () => {
  const c = chain()
  recordMainnetSolanaActivity({ evmWallet: '0xafbb6cc5c0a9c0eb1bff8db2ed807e83aab8e321', solanaWallet: FX.owner, direction: 'arc-to-solana', amount: '0.0984', sourceTxHash: FX.sourceTxHash, status: 'unknown', createdAt: Date.now() - 3 * 86400_000 })
  const prior = readMainnetSolanaActivity()[0]
  await assert.rejects(recover(c, phantom(), 'ok', { legacyActivityStatus: prior.status }), err => err instanceof E.LegacyReceiveReviewRequired)
  const review = await E.reviewLegacyReceive(FX.sourceTxHash, FX.message, c.reads_)
  assert.equal(review.eligible, true); assert.equal(review.checks.length, 4)
  await assert.rejects(E.releaseLegacyReceiveAfterReview(FX.sourceTxHash, FX.owner, FX.message, false, c.reads_), /Confirm/)
  for (const [k, v] of [['pdaTx', 1], ['nonceB', true], ['fail', 'pda']]) {
    const bad = chain({ [k]: v }); const r = await E.reviewLegacyReceive(FX.sourceTxHash, FX.message, bad.reads_)
    assert.equal(r.eligible, false, `${k} blocks the manual unlock`)
    await assert.rejects(E.releaseLegacyReceiveAfterReview(FX.sourceTxHash, FX.owner, FX.message, true, bad.reads_), err => err instanceof E.ReceiveLockedError)
  }
  await E.releaseLegacyReceiveAfterReview(FX.sourceTxHash, FX.owner, FX.message, true, c.reads_)
  const w = phantom(); assert.equal((await recover(c, w, 'ok', { legacyActivityStatus: prior.status })).kind, 'received', 'the next receive is checked again and allowed')
})
await test('an active wallet request in this browser blocks the manual unlock', async () => {
  const c = chain()
  const gate = await E.openReceiveAttempt({ sourceTxHash: FX.sourceTxHash, owner: FX.owner, message: FX.message }, c.reads_)
  E.updateReceiveEntry(gate.entryId, { phase: 'requesting', walletRequestedAt: Date.now() })
  const r = await E.reviewLegacyReceive(FX.sourceTxHash, FX.message, c.reads_)
  assert.equal(r.eligible, false); assert.equal(r.checks.find(x => /active wallet request/.test(x.label)).ok, false)
})
await test('ATA-only fallback signed but the receive never shown to the wallet: no receive can land, released; nonce already used: no wallet request at all', async () => {
  const c = chain(), w = phantom()
  await assert.rejects(recover(c, w, 'network', { txs: [ataOnlyTx()] }))
  assert.equal(latest().receiveRequestedAt, undefined)
  assert.equal((await recover(c, w, 'ok')).kind, 'received')
  store.clear(); const used = chain({ nonceA: true, nonceB: true }), w2 = phantom()
  assert.equal((await recover(used, w2, 'ok')).kind, 'already-received'); assert.deepEqual(w2.calls, [])
})
await test('no time-based unlock: an unknown attempt whose blockhash is still valid stays locked even with old timestamps', async () => {
  const c = chain(), w = phantom()
  await assert.rejects(recover(c, w, 'network'))
  const e = latest(); E.updateReceiveEntry(e.id, { createdAt: Date.now() - 86400_000, walletRequestedAt: Date.now() - 86400_000 })
  await assert.rejects(recover(c, w, 'ok'), err => err instanceof E.ReceiveLockedError); assert.equal(w.calls.length, 1)
})
await test('the hook wires the gate, the evidence signer and the classifier into the recovery; the SDK keeps its WebSocket-capable RPC', () => {
  const src = readFileSync(new URL('../src/hooks/useMainnetSolanaCctp.ts', import.meta.url), 'utf8')
  const rec = src.slice(src.indexOf('const recoverPendingArcToSolana'), src.indexOf('const confirmArcSolanaReceiveRelease'))
  for (const s of ['openReceiveAttempt(', 'createReceiveEvidenceSigner(phantomProvider, receiveEntryId)', 'classifyFailedAttempt(receiveEntryId, e)', "updateReceiveEntry(receiveEntryId, { phase: 'complete' })"]) assert.ok(rec.includes(s), s)
  assert.ok(!rec.includes("code===4001?'failed':'unknown'"), 'the old error-code shortcut is gone')
  assert.ok(rec.includes('rpcEndpoints: [SOLANA_BRIDGE_SDK_RPC]'), 'recovery uses the shared SDK endpoint, not the HTTP-only proxy')
  const connection = readFileSync(new URL('../src/lib/solanaBridgeConnection.ts', import.meta.url), 'utf8')
  assert.ok(connection.includes("SOLANA_BRIDGE_SDK_RPC = 'https://solana-rpc.publicnode.com'"), 'the successful recovery endpoint is preserved')
  assert.ok(src.includes('machina-arc-solana-recovery:${review.sourceTxHash}'), 'manual unlock takes the same per-burn lock')
})
await test('normal SDK receive session journals ATA then mint and blocks concurrent or repeated wallet requests', async () => {
  const c = chain(), w = phantom()
  const session = E.createBoundReceiveSigner(w, { reads: c.reads_, prepare: async () => ({sourceTxHash: FX.sourceTxHash, owner: FX.owner, message: FX.message}), validate: (_t, m) => assert.equal(m, FX.message) })
  await session.signTransaction(ataOnlyTx())
  assert.equal(latest().signed.length, 1); assert.equal(latest().receiveRequestedAt, undefined)
  const first = session.signTransaction(receiveTx())
  await assert.rejects(session.signTransaction(receiveTx()), /already being prepared/)
  await first
  assert.equal(latest().signed.length, 2); assert.ok(latest().signature)
  await assert.rejects(session.signTransaction(receiveTx()), /already made/)
  assert.equal(w.calls.length, 2)
})
await test('normal receive policy refusal and consumed nonce never create a wallet request', async () => {
  const c = chain(), w = phantom()
  const prepare = async () => ({sourceTxHash: FX.sourceTxHash, owner: FX.owner, message: FX.message})
  const invalid = E.createBoundReceiveSigner(w, { reads:c.reads_, prepare, validate: () => {throw new Error('controlled G2 refusal')} })
  await assert.rejects(invalid.signTransaction(receiveTx()), /G2 refusal/)
  assert.equal(E.readReceiveEntries().length, 0); assert.equal(w.calls.length, 0)
  c.nonceA = c.nonceB = true
  const consumed = E.createBoundReceiveSigner(w, { reads:c.reads_, prepare, validate:()=>{} })
  await assert.rejects(consumed.signTransaction(receiveTx()), /already consumed/)
  assert.equal(w.calls.length, 0)
})
await test('normal session unknown signature stays locked and stops all subsequent wallet requests', async () => {
  const c = chain(), w = phantom('error')
  let message = FX.message
  const session = E.createBoundReceiveSigner(w, { reads:c.reads_, prepare:async()=>({sourceTxHash:FX.sourceTxHash,owner:FX.owner,message}), validate:()=>{} })
  await assert.rejects(session.signTransaction(receiveTx()))
  session.fail(new Error('controlled SDK error'))
  assert.equal(latest().phase, 'unknown')
  await assert.rejects(E.openReceiveAttempt({sourceTxHash:FX.sourceTxHash,owner:FX.owner,message:FX.message},c.reads_), err=>err instanceof E.ReceiveLockedError)
  message += '00'
  await assert.rejects(session.signTransaction(receiveTx()), /earlier destination request/)
  assert.equal(w.calls.length, 1)
})
await test('an ATA-only wallet failure cannot fall through to a second Phantom mint request', async () => {
  const c=chain(),w=phantom('error')
  const session=E.createBoundReceiveSigner(w,{reads:c.reads_,prepare:async()=>({sourceTxHash:FX.sourceTxHash,owner:FX.owner,message:FX.message}),validate:()=>{}})
  await assert.rejects(session.signTransaction(ataOnlyTx()))
  await assert.rejects(session.signTransaction(receiveTx()),/earlier destination request/)
  assert.equal(w.calls.length,1);assert.equal(latest().receiveRequestedAt,undefined)
})
await test('source proof changes between successful ATA setup and mint are refused before a second signature', async () => {
  const c=chain(),w=phantom();let message=FX.message
  const session=E.createBoundReceiveSigner(w,{reads:c.reads_,prepare:async()=>({sourceTxHash:FX.sourceTxHash,owner:FX.owner,message}),validate:()=>{}})
  await session.signTransaction(ataOnlyTx());message+='00'
  await assert.rejects(session.signTransaction(receiveTx()),/source burn or attestation changed/)
  assert.equal(w.calls.length,1)
})
console.log(`RESULT ${count}/${count} Arc -> Solana receive-evidence groups PASS; real pending message of 0x22e768dd…, fake Phantom/SDK and controlled chain reads; no new burn, network, signature or transaction.`)
