// Solana Bridge second-burn guard (B1): the real journal and the real withSolanaSendGuard with
// Node's Web Locks, fake wallets and fake chain evidence. No network, no signature, no transaction.
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { VersionedTransaction, TransactionMessage, PublicKey } from '@solana/web3.js'
const require = createRequire(import.meta.url), ts = require('typescript')
require.extensions['.ts'] = (m, f) => m._compile(ts.transpileModule(readFileSync(f, 'utf8').replaceAll('import.meta.env', '({})'), { fileName: f, compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true, jsx: ts.JsxEmit.ReactJSX } }).outputText, f)

const store = new Map()
globalThis.localStorage = { getItem: k => store.has(k) ? store.get(k) : null, setItem: (k, v) => store.set(k, String(v)), removeItem: k => store.delete(k) }
assert.ok(globalThis.navigator?.locks, 'Web Locks are available')
globalThis.window = { localStorage: globalThis.localStorage, dispatchEvent() {}, addEventListener() {}, removeEventListener() {}, setTimeout, clearTimeout } // Activity records use window.localStorage

const G = require('../src/lib/solanaSendGuard.ts')
const { withSolanaSendGuard, SOLANA_SEND_BUSY } = require('../src/lib/solanaSendRuntime.ts')
const { readMainnetSolanaActivity, mainnetSolanaTransferStatus } = require('../src/lib/mainnetSolanaActivity.ts')
const { CIRCLE_KIT_BRIDGE_CONTRACT } = require('../src/lib/mainnetCctpRecovery.ts')
const { MAINNET_CONFIG } = require('../src/config/mainnet.ts')

const EVM = '0xafbb6cc5c0a9c0eb1bff8db2ed807e83aab8e321', SOL = '8UsDvWtFPzYBjzrgrB3j4oufte5iwm4Mx5A2tZ7ocTGg'
const USDC = '0x3600000000000000000000000000000000000000', BURN_HASH = '0x' + 'b1'.repeat(32)
let count = 0
async function test(name, fn) { store.clear(); await fn(); count++; console.log('PASS ' + name) }
const attempts = () => G.readSolanaSendAttempts()
// Chain evidence; each field can be overridden per scenario.
const evidence = (o = {}) => ({ arcLatestBlock: async () => 1000n, arcReceipt: async () => null, arcBurnsSince: async () => [], arcNothingPending: async () => true,
  solanaSignatureStatus: async () => ({ found: false }), solanaBlockhashValid: async () => true, solanaBurnsSince: async () => [], now: () => Date.now(), ...o })
const arcInput = { direction: 'arc-to-solana', amount: '0.1', evmWallet: EVM, solanaWallet: SOL }
const solInput = { direction: 'solana-to-arc', amount: '0.1', evmWallet: EVM, solanaWallet: SOL }
const rejection = () => Object.assign(new Error('MetaMask Tx Signature: User denied transaction signature.'), { code: 4001 })
// A fake Bridge Kit run: approve (USDC), then the burn (TokenMessenger / Bridge Kit contract), through the guarded provider.
const evmRun = (burnResult, { to = MAINNET_CONFIG.arcCctpTokenMessengerAddress, seen } = {}) => async guard => {
  const provider = guard.evm({ on() {}, removeListener() {}, request: async ({ method, params }) => {
    seen?.push(params?.[0]?.to)
    if (method !== 'eth_sendTransaction') return null
    if (params[0].to === USDC) return '0x' + 'a0'.repeat(32) // approval
    return burnResult()
  } })
  await provider.request({ method: 'eth_sendTransaction', params: [{ to: USDC, data: '0x095ea7b3' }] })
  return provider.request({ method: 'eth_sendTransaction', params: [{ to, data: '0x8e0250ee' }] })
}
function signedSolanaTx() {
  const payer = new PublicKey(SOL), blockhash = '4sGjMW1sUnHzSxGspuhpqLDx6wiyjNtZAMdL4VZHirAn'
  const tx = new VersionedTransaction(new TransactionMessage({ payerKey: payer, recentBlockhash: blockhash, instructions: [] }).compileToV0Message())
  tx.signatures[0] = Uint8Array.from({ length: 64 }, (_, i) => (i * 7 + 3) % 256)
  return { tx, blockhash }
}

await test('a rejected burn request was never sent: the attempt is released and the next transfer may start', async () => {
  await assert.rejects(withSolanaSendGuard(arcInput, evmRun(async () => { throw rejection() }), evidence()), /User denied/)
  assert.equal(attempts()[0].phase, 'released'); assert.match(attempts()[0].note, /rejected the burn/)
  assert.equal(G.openSolanaSendAttempt(EVM, SOL), null)
  assert.equal(await withSolanaSendGuard(arcInput, async () => 'second run allowed', evidence()), 'second run allowed')
})
await test('a failure before the burn request (only the approval ran) releases the attempt: nothing was burned', async () => {
  await assert.rejects(withSolanaSendGuard(arcInput, async guard => { const p = guard.evm({ request: async () => '0x' + 'a0'.repeat(32) }); await p.request({ method: 'eth_sendTransaction', params: [{ to: USDC }] }); throw new Error('estimate failed') }, evidence()), /estimate failed/)
  assert.equal(attempts()[0].phase, 'released'); assert.equal(G.openSolanaSendAttempt(EVM, SOL), null)
})
await test('an unclear wallet error after the burn request keeps every new transfer locked, in this tab and after a reload', async () => {
  await assert.rejects(withSolanaSendGuard(arcInput, evmRun(async () => { throw new Error('Internal JSON-RPC error.') }), evidence({ arcNothingPending: async () => false })), /JSON-RPC/)
  assert.equal(attempts()[0].phase, 'unknown')
  // "Reload": a new run only sees the persisted journal.
  let ran = false
  await assert.rejects(withSolanaSendGuard(arcInput, async () => { ran = true }, evidence({ arcNothingPending: async () => false })), /no verified outcome yet: A transaction from your EVM wallet is still pending/)
  assert.equal(ran, false, 'no wallet request in the blocked run')
  // The other direction with either wallet is blocked too.
  await assert.rejects(withSolanaSendGuard(solInput, async () => { ran = true }, evidence({ arcNothingPending: async () => false })), /no verified outcome/)
  assert.equal(ran, false)
})
await test('EVM: time alone never unlocks an unanswered burn request (the wallet may approve it later); a burn found on Arc settles it, without calling the transfer complete', async () => {
  await assert.rejects(withSolanaSendGuard(arcInput, evmRun(async () => { throw new Error('disconnected') }), evidence({ arcNothingPending: async () => false })), /disconnected/)
  const start = attempts()[0].signingAt
  for (const later of [11 * 60_000, 24 * 3_600_000]) {
    await assert.rejects(withSolanaSendGuard(arcInput, async () => 'x', evidence({ now: () => start + later })), /No burn from your wallet is on Arc\. It stays locked: only the wallet can tell/)
    assert.equal(attempts()[0].phase, 'unknown', `still locked after ${later / 60_000} min with no burn and nothing pending`)
  }
  // The burn did reach Arc: it is recorded as a burn (not a completed transfer) and shown in Activity as unverified.
  let fromBlock
  await assert.rejects(withSolanaSendGuard(arcInput, async () => 'x', evidence({ arcBurnsSince: async (_w, b) => { fromBlock = b; return [BURN_HASH] } })), /has its burn on chain; receiving it is not verified yet/)
  assert.equal(fromBlock, 1000n, 'searched from the block read before the transfer')
  const settled = attempts().find(a => a.burnTxHash === BURN_HASH)
  assert.equal(settled.phase, 'burned'); assert.doesNotMatch(settled.note, /complete/i)
  const record = readMainnetSolanaActivity().find(r => r.sourceTxHash === BURN_HASH && r.direction === 'arc-to-solana')
  assert.ok(record, 'the found burn is in Activity'); assert.equal(record.status, undefined)
  assert.equal(mainnetSolanaTransferStatus(record), 'Outcome unverified', 'Activity does not show it as complete')
  assert.equal(await withSolanaSendGuard(arcInput, async () => 'next transfer allowed', evidence()), 'next transfer allowed')
})
await test('a returned burn hash: locked until Arc confirms it; a successful receipt settles it, a reverted one releases it', async () => {
  const res = await withSolanaSendGuard(arcInput, evmRun(async () => BURN_HASH, { to: CIRCLE_KIT_BRIDGE_CONTRACT }), evidence({ arcReceipt: async () => null }))
  assert.equal(res, BURN_HASH); assert.equal(attempts()[0].phase, 'sent'); assert.equal(attempts()[0].burnTxHash, BURN_HASH)
  await assert.rejects(withSolanaSendGuard(arcInput, async () => 'x', evidence({ arcReceipt: async () => null })), /Arc has not confirmed the burn/)
  await assert.rejects(withSolanaSendGuard(arcInput, async () => 'x', evidence({ arcReceipt: async () => 'success' })), /has its burn on chain; receiving it is not verified yet/)
  assert.equal(attempts()[0].phase, 'burned')
  store.clear()
  await withSolanaSendGuard(arcInput, evmRun(async () => BURN_HASH), evidence({ arcReceipt: async () => null }))
  assert.equal(await withSolanaSendGuard(arcInput, async () => 'allowed', evidence({ arcReceipt: async () => 'reverted' })), 'allowed')
  assert.match(attempts().find(a => a.burnTxHash === BURN_HASH).note, /reverted/)
})
await test('a finished run with a successful burn receipt unlocks and records only the burn (the mint is verified elsewhere)', async () => {
  await withSolanaSendGuard(arcInput, evmRun(async () => BURN_HASH), evidence({ arcReceipt: async () => 'success' }))
  assert.equal(attempts()[0].phase, 'burned'); assert.equal(G.openSolanaSendAttempt(EVM, SOL), null)
})
await test('second tab: while one tab holds the wallet lock, another cannot start a transfer for either wallet', async () => {
  let release; const holding = new Promise(r => { release = r })
  const first = withSolanaSendGuard(arcInput, async () => { await holding; return 'first' }, evidence())
  await new Promise(r => setTimeout(r, 20))
  await assert.rejects(withSolanaSendGuard(arcInput, async () => 'second', evidence()), new RegExp(SOLANA_SEND_BUSY.slice(0, 30)))
  await assert.rejects(withSolanaSendGuard({ ...solInput, evmWallet: '0x' + '22'.repeat(20) }, async () => 'other evm, same Phantom', evidence()), /Another tab/)
  release(); assert.equal(await first, 'first')
})
await test('Solana burn: the signature is saved before the signed burn is handed back; an expired blockhash releases it, a landed burn settles it', async () => {
  const { tx, blockhash } = signedSolanaTx(), expected = G.solanaSignatureOf(tx)
  assert.equal(expected.blockhash, blockhash); assert.equal(expected.signature, (require('bs58').default ?? require('bs58')).encode(tx.signatures[0]), 'signature encoded like Solana does')
  let savedBeforeReturn = null
  await withSolanaSendGuard(solInput, async guard => {
    const signer = guard.solana({ signTransaction: async () => tx })
    const signed = await signer.signTransaction({})
    savedBeforeReturn = attempts()[0]
    return signed
  }, evidence())
  assert.equal(savedBeforeReturn.phase, 'signed'); assert.equal(savedBeforeReturn.solanaSignature, expected.signature); assert.equal(savedBeforeReturn.solanaBlockhash, blockhash)
  await assert.rejects(withSolanaSendGuard(solInput, async () => 'x', evidence()), /Solana has not confirmed the burn yet/)
  assert.equal(await withSolanaSendGuard(solInput, async () => 'allowed', evidence({ solanaBlockhashValid: async () => false })), 'allowed')
  assert.match(attempts().find(a => a.solanaSignature).note, /expired without landing/)
  store.clear()
  await withSolanaSendGuard(solInput, async guard => guard.solana({ signTransaction: async () => tx }).signTransaction({}), evidence())
  await assert.rejects(withSolanaSendGuard(solInput, async () => 'x', evidence({ solanaSignatureStatus: async () => ({ found: true, err: null, confirmed: true }) })), /has its burn on chain; receiving it is not verified yet/)
  assert.ok(readMainnetSolanaActivity().some(r => r.sourceTxHash === expected.signature && r.direction === 'solana-to-arc'))
})
await test('Solana: if the signature cannot be saved, the signed burn is not handed back (nothing is sent); a rejected signature releases', async () => {
  const { tx } = signedSolanaTx()
  const realSet = globalThis.localStorage.setItem
  let handedBack = false
  await assert.rejects(withSolanaSendGuard(solInput, async guard => {
    const signer = guard.solana({ signTransaction: async () => { globalThis.localStorage.setItem = () => { throw new Error('quota') }; return tx } })
    await signer.signTransaction({}); handedBack = true
  }, evidence()), /quota/)
  globalThis.localStorage.setItem = realSet
  assert.equal(handedBack, false)
  store.clear()
  await assert.rejects(withSolanaSendGuard(solInput, async guard => guard.solana({ signTransaction: async () => { throw Object.assign(new Error('User rejected the request.'), { code: 4001 }) } }).signTransaction({}), evidence()), /User rejected/)
  assert.equal(attempts()[0].phase, 'released')
})
await test('Solana, no signature known (wallet answer lost): time alone never unlocks; the requested transaction\'s expired blockhash (re-checked) does, a found burn settles it', async () => {
  const { tx, blockhash } = signedSolanaTx()
  await assert.rejects(withSolanaSendGuard(solInput, async guard => guard.solana({ signTransaction: async () => { throw new Error('Phantom closed') } }).signTransaction(tx), evidence()), /Phantom closed/)
  const start = attempts()[0].signingAt
  assert.equal(attempts()[0].phase, 'unknown'); assert.equal(attempts()[0].solanaBlockhash, blockhash, 'blockhash of the requested transaction saved before the wallet request')
  await assert.rejects(withSolanaSendGuard(solInput, async () => 'x', evidence({ now: () => start + 24 * 3_600_000 })), /still valid and could still be sent\. It stays locked/)
  // Expired, but the re-check right after expiry finds the burn: it is a burn, not a release.
  let calls = 0
  await assert.rejects(withSolanaSendGuard(solInput, async () => 'x', evidence({ solanaBlockhashValid: async () => false, solanaBurnsSince: async () => (++calls === 1 ? [] : ['SoLbUrN1']) })), /has its burn on chain; receiving it is not verified yet/)
  assert.equal(attempts()[0].phase, 'burned')
  store.clear()
  await assert.rejects(withSolanaSendGuard(solInput, async guard => guard.solana({ signTransaction: async () => { throw new Error('Phantom closed') } }).signTransaction(tx), evidence()), /Phantom closed/)
  const start2 = attempts()[0].signingAt
  let since
  assert.equal(await withSolanaSendGuard(solInput, async () => 'allowed', evidence({ solanaBlockhashValid: async () => false, solanaBurnsSince: async (_w, s) => { since = s; return [] } })), 'allowed')
  assert.match(attempts().find(a => a.solanaBlockhash === blockhash).note, /expired without landing; it can no longer be sent/)
  assert.equal(since, start2 - 60_000, 'searched from shortly before the signing request')
  // Without a readable blockhash there is no expiry proof: it stays locked.
  store.clear()
  await assert.rejects(withSolanaSendGuard(solInput, async guard => guard.solana({ signTransaction: async () => { throw new Error('Phantom closed') } }).signTransaction({}), evidence()), /Phantom closed/)
  await assert.rejects(withSolanaSendGuard(solInput, async () => 'x', evidence({ solanaBlockhashValid: async () => false })), /could not be identified\. It stays locked/)
})
await test('Solana, signature known: an expired blockhash releases only if the signature is still not on chain when re-read', async () => {
  const { tx } = signedSolanaTx()
  await withSolanaSendGuard(solInput, async guard => guard.solana({ signTransaction: async () => tx }).signTransaction(tx), evidence())
  let reads = 0
  await assert.rejects(withSolanaSendGuard(solInput, async () => 'x', evidence({ solanaBlockhashValid: async () => false, solanaSignatureStatus: async () => (++reads === 1 ? { found: false } : { found: true, err: null, confirmed: true }) })), /has its burn on chain; receiving it is not verified yet/)
  assert.equal(attempts()[0].phase, 'burned', 'landed just before expiry: a burn, not a release')
})
await test('manual review: offered only after a completed check could not settle it; it takes the wallet locks, re-checks the chains, and a burn found then is recorded instead of unlocked', async () => {
  const { releaseSolanaSendAttemptAfterReview } = require('../src/lib/solanaSendRuntime.ts')
  await assert.rejects(withSolanaSendGuard(arcInput, evmRun(async () => { throw new Error('disconnected') }), evidence()), /disconnected/)
  const id = attempts()[0].id
  // Read failure is not "no burn": the manual unlock is refused.
  await assert.rejects(releaseSolanaSendAttemptAfterReview(id, evidence({ arcBurnsSince: async () => { throw new Error('rpc down') } })), /could not be read/)
  assert.equal(attempts()[0].phase, 'unknown')
  // Refused while another tab is sending for these wallets.
  let release; const holding = new Promise(r => { release = r })
  const other = navigator.locks.request(`machina-solana-send:evm:${EVM}`, async () => { await holding })
  await new Promise(r => setTimeout(r, 20))
  await assert.rejects(releaseSolanaSendAttemptAfterReview(id, evidence()), /Another tab/)
  release(); await other
  // A burn found during the review is recorded as a burn, not unlocked by hand.
  assert.deepEqual(await releaseSolanaSendAttemptAfterReview(id, evidence({ arcBurnsSince: async () => [BURN_HASH] })), { kind: 'burned', txHash: BURN_HASH })
  assert.equal(attempts()[0].phase, 'burned'); assert.equal(attempts()[0].manuallyReleased, undefined)
  // Nothing found after a completed check: the user's confirmed review unlocks, and it is marked as manual.
  store.clear()
  await assert.rejects(withSolanaSendGuard(arcInput, evmRun(async () => { throw new Error('disconnected') }), evidence()), /disconnected/)
  assert.deepEqual(await releaseSolanaSendAttemptAfterReview(attempts()[0].id, evidence()), { kind: 'released-by-user' })
  assert.equal(attempts()[0].phase, 'released'); assert.equal(attempts()[0].manuallyReleased, true); assert.match(attempts()[0].note, /Unlocked by you after checking your wallets/)
  assert.equal(await withSolanaSendGuard(arcInput, async () => 'allowed', evidence()), 'allowed')
})
// The "completed" status (destination receive verification) is covered by verify-solana-receive-verification.mjs.
await test('the guard only watches the burn: approvals and the destination receive step pass through untouched', async () => {
  const seen = []
  await withSolanaSendGuard(arcInput, async guard => {
    const sig = guard.solana({ signTransaction: async x => x })
    assert.equal(await sig.signTransaction('mint-on-solana'), 'mint-on-solana', 'arc-to-solana: the Solana receive is not the burn')
    return evmRun(async () => BURN_HASH, { seen })(guard)
  }, evidence({ arcReceipt: async () => 'success' }))
  assert.deepEqual(seen, [USDC, MAINNET_CONFIG.arcCctpTokenMessengerAddress])
  store.clear()
  await withSolanaSendGuard(solInput, async guard => {
    const evm = guard.evm({ request: async () => '0x' + 'c0'.repeat(32) })
    await evm.request({ method: 'eth_sendTransaction', params: [{ to: MAINNET_CONFIG.arcCctpTokenMessengerAddress }] })
  }, evidence())
  assert.equal(attempts()[0].phase, 'released', 'solana-to-arc: an EVM transaction is the Arc receive, never treated as the burn')
})
await test('an EIP-5792 batch (approve + burn) is the burn request: rejected releases, accepted stays locked until the burn is found on Arc', async () => {
  const batchRun = result => async guard => guard.evm({ request: async () => result() }).request({ method: 'wallet_sendCalls', params: [{ calls: [{ to: USDC }, { to: CIRCLE_KIT_BRIDGE_CONTRACT }] }] })
  await assert.rejects(withSolanaSendGuard(arcInput, batchRun(async () => { throw rejection() }), evidence()), /User denied/)
  assert.equal(attempts()[0].phase, 'released')
  store.clear()
  await withSolanaSendGuard(arcInput, batchRun(async () => ({ id: 'batch-1' })), evidence({ arcNothingPending: async () => false }))
  assert.equal(attempts()[0].phase, 'unknown', 'a batch id is not a burn hash')
  await assert.rejects(withSolanaSendGuard(arcInput, async () => 'x', evidence({ arcBurnsSince: async () => [BURN_HASH] })), /has its burn on chain; receiving it is not verified yet/)
  assert.equal(attempts()[0].burnTxHash, BURN_HASH)
})
await test('no record, no request: an unsaved attempt or a missing Arc start block stops before any wallet request; an unreadable journal stays locked', async () => {
  let asked = false
  await assert.rejects(withSolanaSendGuard(arcInput, async () => { asked = true }, evidence({ arcLatestBlock: async () => { throw new Error('Arc RPC down') } })), /Arc RPC down/)
  assert.equal(asked, false); assert.equal(attempts().length, 0)
  const realSet = globalThis.localStorage.setItem; globalThis.localStorage.setItem = () => {}
  await assert.rejects(withSolanaSendGuard(arcInput, async () => { asked = true }, evidence()), /could not be saved. No wallet request/)
  globalThis.localStorage.setItem = realSet; assert.equal(asked, false)
  store.set(G.SOLANA_SEND_JOURNAL_KEY, '{broken')
  await assert.rejects(withSolanaSendGuard(arcInput, async () => { asked = true }, evidence()), /could not be read. New transfers stay locked/)
  assert.equal(asked, false)
})
await test('a "prepared" attempt left by an earlier page never reached the wallet and does not block; settled attempts are kept beyond the size limit only while blocking', async () => {
  const a = G.createSolanaSendAttempt({ direction: 'arc-to-solana', evmWallet: EVM, solanaWallet: SOL, amount: '0.1', arcBlockBefore: '1' })
  assert.equal(G.openSolanaSendAttempt(EVM, SOL), null)
  assert.equal(await withSolanaSendGuard(arcInput, async () => 'allowed', evidence()), 'allowed')
  assert.equal(attempts().find(x => x.id === a.id).phase, 'released')
  const blocking = G.createSolanaSendAttempt({ direction: 'arc-to-solana', evmWallet: EVM, solanaWallet: SOL, amount: '0.2', arcBlockBefore: '1' })
  G.updateSolanaSendAttempt(blocking.id, { phase: 'unknown' })
  for (let i = 0; i < 60; i++) G.updateSolanaSendAttempt(G.createSolanaSendAttempt({ direction: 'arc-to-solana', evmWallet: '0x' + 'ee'.repeat(20), solanaWallet: 'x' + i, amount: '1', arcBlockBefore: '1' }).id, { phase: 'released' })
  assert.equal(G.openSolanaSendAttempt(EVM, SOL)?.id, blocking.id, 'the blocking attempt survives 60 newer records')
})
await test('wallet rejection detection is specific: rejections release, other wallet errors do not', () => {
  for (const e of [rejection(), { code: 'ACTION_REJECTED' }, new Error('User rejected the request.'), new Error('Transaction request rejected')]) assert.equal(G.isUserRejection(e), true)
  for (const e of [new Error('Internal JSON-RPC error.'), new Error('timeout'), { code: -32603 }, new Error('nonce too low')]) assert.equal(G.isUserRejection(e), false)
})
console.log(`RESULT ${count}/${count} Solana send-guard groups PASS; real journal and Web Locks, fake wallets and chain evidence; no network, signatures or transactions.`)
