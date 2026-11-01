// Focused source-burn regression: public Mainnet fixtures, real B1/G2 and installed SDK;
// all wallet, broadcast and confirmation ports are controlled. No real signing/network.
import assert from 'node:assert/strict'
import { createRequire, Module } from 'node:module'
import { readFileSync } from 'node:fs'
import { PublicKey, VersionedTransaction } from '@solana/web3.js'
import { BridgeKit } from '@circle-fin/bridge-kit'
import { createSolanaAdapterFromProvider } from '@circle-fin/adapter-solana'
const require = createRequire(import.meta.url), ts = require('typescript')
require.extensions['.ts'] = (m, f) => m._compile(ts.transpileModule(readFileSync(f, 'utf8').replaceAll('import.meta.env', '({})'), { fileName: f, compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true, jsx: ts.JsxEmit.ReactJSX } }).outputText, f)
const store = new Map()
globalThis.localStorage = { getItem: k => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) }
globalThis.window = { localStorage, dispatchEvent() {}, addEventListener() {}, removeEventListener() {}, setTimeout, clearTimeout }
// Any accidental fetch fails locally; specific read-only scanner tests replace this temporarily.
globalThis.fetch = async () => { throw new Error('Network forbidden in controlled regression') }
const G = require('../src/lib/solanaSendGuard.ts'), R = require('../src/lib/solanaSendRuntime.ts')
const P = require('../src/lib/solanaBridgeTxPolicy.ts'), C = require('../src/lib/solanaBridgeConnection.ts')
const { isSolanaArcBurn } = require('../src/lib/solanaSourceBurn.ts')
const fixture = require('./fixtures/solana-source-burn-evidence.json').transactions
const real = require('./fixtures/solana-bridge-real-tx.json')
const owner = real.burn.owner, evm = real.burn.evmRecipient
const input = { direction: 'solana-to-arc', amount: '0.1', evmWallet: evm, solanaWallet: owner }
const tx = () => VersionedTransaction.deserialize(Buffer.from(real.burn.base64, 'base64'))
const expect = { kind: 'burn', owner, amountRaw: 100000n, evmRecipient: evm }
const ev = (o = {}) => ({ arcLatestBlock: async () => 1n, arcReceipt: async () => null, arcBurnsSince: async () => [], arcNothingPending: async () => true,
  solanaSignatureStatus: async () => ({ found: false }), solanaBlockhashValid: async () => true, solanaBurnsSince: async () => [], now: () => Date.now(), ...o })
const records = () => G.readSolanaSendAttempts()
let count = 0
async function test(name, fn) { store.clear(); await fn(); console.log('PASS ' + name); count++ }
const copy = x => structuredClone(x)
await test('finalized QsF23 burn accepted; finalized 39hGR receive excluded despite CCTP program presence', () => {
  assert.equal(isSolanaArcBurn(fixture.burn.result, owner, fixture.burn.signature), true)
  assert.equal(isSolanaArcBurn(fixture.receive.result, owner, fixture.receive.signature), false)
})
await test('source proof refuses wrong signer/signature, failed transaction, wrong domain and missing SPL burn', () => {
  assert.equal(isSolanaArcBurn(fixture.burn.result, evm, fixture.burn.signature), false)
  assert.equal(isSolanaArcBurn(fixture.burn.result, owner, fixture.receive.signature), false)
  for (const edit of [t => { t.meta.err = { InstructionError: [0, 'Custom'] } }, t => { t.meta.innerInstructions = [] }, t => { t.meta.preTokenBalances[0].mint = P.SOLANA_BRIDGE_PROGRAMS.system }, t => { t.meta.preTokenBalances[0].owner = evm }]) {
    const t = copy(fixture.burn.result); edit(t); assert.equal(isSolanaArcBurn(t, owner, fixture.burn.signature), false)
  }
  // Mutate CCTP amount/destination/mint recipient as serialized bytes, leaving real SPL Burn intact.
  const bs58 = require('bs58')
  for (const offset of [8, 16, 20]) {
    const t = copy(fixture.burn.result), ix = t.meta.innerInstructions[0].instructions[0]
    const d = bs58.decode(ix.data); d[offset] ^= 1; ix.data = bs58.encode(d)
    assert.equal(isSolanaArcBurn(t, owner, fixture.burn.signature), false)
  }
  assert.equal(isSolanaArcBurn(null, owner, fixture.burn.signature), false)
})
await test('real scanner uses read-only HTTP methods and never offers an incoming receive as a burn', async () => {
  const original = fetch, calls = []
  globalThis.fetch = async (url, options) => {
    assert.equal(url, '/api/solana-rpc'); const r = JSON.parse(options.body); calls.push(r.method)
    const result = r.method === 'getSignaturesForAddress' ? Object.values(fixture).map(f => ({ signature: f.signature, err: null, blockTime: f.result.blockTime }))
      : Object.values(fixture).find(f => f.signature === r.params[0])?.result
    return { ok: true, json: async () => ({ result }) }
  }
  try { assert.deepEqual(await R.solanaSendEvidence.solanaBurnsSince(owner, 0), [fixture.burn.signature]); assert.deepEqual(calls, ['getSignaturesForAddress', 'getTransaction', 'getTransaction']) } finally { globalThis.fetch = original }
})
await test('missing RPC transaction evidence throws rather than proving there was no burn', async () => {
  const original = fetch
  globalThis.fetch = async (_u, options) => ({ ok: true, json: async () => ({ result: JSON.parse(options.body).method === 'getSignaturesForAddress' ? [{ signature: fixture.burn.signature, err: null, blockTime: 1 }] : null }) })
  try { await assert.rejects(R.solanaSendEvidence.solanaBurnsSince(owner, 0), /unavailable/) } finally { globalThis.fetch = original }
})
await test('same execution cannot request a second burn, even through a new wrapper; first journal signature is preserved', async () => {
  let asked = 0; const stages = []
  await R.withSolanaSendGuard({ ...input, onSourceStage: s => stages.push(s) }, async guard => {
    const wallet = { signTransaction: async t => { asked++; return t } }
    await guard.solana(wallet).signTransaction(tx())
    const before = copy(records()[0])
    await assert.rejects(guard.solana(wallet).signTransaction(tx()), /No second wallet signature/)
    assert.equal(records()[0].solanaSignature, before.solanaSignature); assert.equal(records()[0].signingAt, before.signingAt)
  }, ev())
  assert.equal(asked, 1); assert.equal(records()[0].phase, 'signed')
  assert.deepEqual(stages, ['wallet-requested', 'wallet-signed', 'repeat-blocked'])
  assert.equal('onSourceStage' in records()[0], false)
})
await test('concurrent requests, wallet rejection and unknown response cannot trigger another signature inside the same run', async () => {
  for (const error of [Object.assign(new Error('user rejected'), { code: 4001 }), new Error('network timeout')]) {
    store.clear(); let asked = 0
    await R.withSolanaSendGuard(input, async guard => {
      const w = guard.solana({ signTransaction: async () => { asked++; throw error } })
      const results = await Promise.allSettled([w.signTransaction(tx()), w.signTransaction(tx())])
      assert.equal(results.every(r => r.status === 'rejected'), true)
    }, ev())
    assert.equal(asked, 1); assert.equal(records()[0].phase, error.code === 4001 ? 'released' : 'unknown')
  }
})
await test('multi-burn signAll refused; G2 rejection still creates no signing record or wallet request', async () => {
  let asked = 0
  await R.withSolanaSendGuard(input, async guard => {
    const w = guard.solana({ signAllTransactions: async x => { asked++; return x } })
    assert.throws(() => w.signAllTransactions([tx(), tx()]), /Exactly one/)
    const strict = guard.solana({ signTransaction: async x => { asked++; return x } }, () => { throw new P.SolanaTxPolicyError('amount', 'Unexpected amount') })
    await assert.rejects(strict.signTransaction(tx()), /before your wallet saw/)
    assert.equal(records()[0].phase, 'prepared'); assert.equal(records()[0].signingAt, undefined)
  }, ev())
  assert.equal(asked, 0); assert.equal(records()[0].phase, 'released')
})
await test('diagnostics cannot affect the guard; unknown stays locked and no sensitive provider error enters fixed messages', async () => {
  await R.withSolanaSendGuard({ ...input, onSourceStage: () => { throw new Error('diagnostic consumer failed') } }, async guard => {
    await assert.rejects(guard.solana({ signTransaction: async () => { throw new Error('private provider URL and payload') } }).signTransaction(tx()))
  }, ev())
  assert.equal(records()[0].phase, 'unknown')
  await assert.rejects(R.withSolanaSendGuard(input, async () => assert.fail('no second run'), ev()), /no verified outcome/)
  for (const s of ['preparing', 'policy-blocked', 'wallet-requested', 'wallet-rejected', 'wallet-unknown', 'wallet-signed', 'repeat-blocked']) {
    assert.doesNotMatch(C.solanaSourceFailure(s), /https:|private provider|payload|7bJT|afbb/i)
  }
  assert.match(C.solanaSourceFailure('policy-blocked'), /Machina G2/)
  assert.match(C.solanaSourceFailure('wallet-unknown'), /unknown outcome/)
  assert.doesNotMatch(C.solanaSourceFailure('wallet-unknown'), /G2 rejected|Phantom.*security/)
})
const chains = new BridgeKit().getSupportedChains()
const solana = { ...chains.find(c => !('chainId' in c) && !c.isTestnet && c.name.toLowerCase().includes('solana')), rpcEndpoints: [C.SOLANA_BRIDGE_SDK_RPC] }
await test('installed adapter creates the same HTTP/WSS endpoint pair used by successful receive recovery', async () => {
  const adapter = await createSolanaAdapterFromProvider({ provider: { connect: async () => {}, disconnect: async () => {}, isConnected: true, publicKey: new PublicKey(owner), signTransaction: async () => assert.fail('not requested') }, capabilities: { addressContext: 'user-controlled', supportedChains: [solana] } })
  const connection = adapter.getConnection(solana)
  assert.equal(connection.rpcEndpoint, C.SOLANA_BRIDGE_SDK_RPC)
  assert.equal(connection._rpcWsEndpoint, 'wss://solana-rpc.publicnode.com')
  assert.equal(typeof connection.confirmTransaction, 'function')
})
await test('real installed SDK execute: simulation → wallet → broadcast → confirmation; no real send; failures do not repeat wallet request', async () => {
  const adapter = await createSolanaAdapterFromProvider({ provider: { connect: async () => {}, disconnect: async () => {}, isConnected: true, publicKey: new PublicKey(owner), signTransaction: async t => t }, capabilities: { addressContext: 'user-controlled', supportedChains: [solana] } })
  for (const failure of [null, 'broadcast', 'confirmation']) {
    const seen = [], signer = { publicKey: new PublicKey(owner), isProviderSigner: true, signTransaction: async t => { seen.push('wallet'); return t } }
    const connection = {
      simulateTransaction: async () => { seen.push('simulation'); return { value: { err: null } } },
      getLatestBlockhash: async () => ({ blockhash: tx().message.recentBlockhash, lastValidBlockHeight: 999 }),
      sendTransaction: async (_t, opts) => { seen.push('broadcast'); assert.equal(opts.maxRetries, 0); if (failure === 'broadcast') throw new Error('Network connection failed'); return real.burn.signature },
      confirmTransaction: async (params, commitment) => { seen.push('confirmation'); assert.equal(params.signature, real.burn.signature); assert.equal(commitment, 'confirmed'); if (failure === 'confirmation') throw new Error('Network connection failed'); return { value: { err: null } } },
    }
    const p = adapter.execute(connection, signer, { serializedTransaction: Buffer.from(real.burn.base64, 'base64') })
    if (failure) await assert.rejects(p); else assert.equal(await p, real.burn.signature)
    assert.deepEqual(seen, failure === 'broadcast' ? ['simulation', 'wallet', 'broadcast'] : ['simulation', 'wallet', 'broadcast', 'confirmation'])
  }
})

// Exercise the actual hook/controller with controlled SDK/wallet ports. Real G1/G2/B1
// wrappers remain in the execution path. These are not live Phantom/Mainnet tests.
let sdkRun, latestState, retryCalls = 0, walletCalls = 0
const originalLoad = Module._load, viem = require('viem')
const walletClient = { transport: { request: async ({ method }) => method === 'eth_chainId' ? '0x13b2' : method === 'eth_accounts' ? [evm] : null } }
const fakeKit = class {
  getSupportedChains() { return chains }
  async bridge(args) { return sdkRun(args) }
  async retry() { retryCalls++; throw new Error('retry must never run') }
}
Module._load = function (name, ...rest) {
  if (name === 'react') return { useCallback: f => f, useEffect: () => {}, useMemo: f => f(), useRef: x => ({ current: x === null ? { amount: '0.1', bridgeFee: '0', binding: { direction: 'solana-to-arc', evmWallet: evm, solanaWallet: owner, checkedAt: Date.now() } } : x }), useState: initial => { let v = initial; return [v, next => { v = typeof next === 'function' ? next(v) : next; if (v && typeof v === 'object' && 'isLoading' in v) latestState = v }] } }
  if (name === 'wagmi') return { useAccount: () => ({ address: evm }), useWalletClient: () => ({ data: walletClient }) }
  if (name === '@circle-fin/bridge-kit') return { BridgeKit: fakeKit }
  if (name === '@circle-fin/adapter-solana') return { createSolanaAdapterFromProvider: async opts => opts }
  if (name === '@circle-fin/adapter-viem-v2') return { createAdapterFromProvider: async opts => opts }
  if (name === 'viem') return { ...viem, createPublicClient: () => ({ readContract: async () => 1000000n }) }
  return originalLoad.call(this, name, ...rest)
}
let useHook
try { ({ useMainnetSolanaCctp: useHook } = require('../src/hooks/useMainnetSolanaCctp.ts')) } finally { Module._load = originalLoad }
const phantom = { publicKey: new PublicKey(owner), isConnected: true, signTransaction: async t => { walletCalls++; return t } }
const realEvidence = { ...R.solanaSendEvidence }
async function hookRun(fn, extraEvidence = {}) {
  Object.assign(R.solanaSendEvidence, ev(extraEvidence)); retryCalls = 0; walletCalls = 0; sdkRun = fn
  try { return await useHook(phantom, owner).runCanary('solana-to-arc', '0.1') } finally { Object.assign(R.solanaSendEvidence, realEvidence) }
}
await test('actual hook: SDK burn error after signing stops; no kit.retry and no second Phantom request', async () => {
  await hookRun(async args => { await args.from.adapter.provider.signTransaction(tx()); return { state: 'error', steps: [{ name: 'burn', state: 'error' }] } })
  assert.equal(walletCalls, 1); assert.equal(retryCalls, 0); assert.equal(records()[0].phase, 'signed')
  assert.match(latestState.error, /broadcast or confirmation could not be verified/)
})
await test('actual hook: verified burn plus destination failure offers only recovery, not another burn', async () => {
  await hookRun(async args => { await args.from.adapter.provider.signTransaction(tx()); return { state: 'error', steps: [{ name: 'burn', state: 'success' }, { name: 'mint', state: 'error' }] } }, { solanaSignatureStatus: async () => ({ found: true, err: null, confirmed: true }) })
  assert.equal(walletCalls, 1); assert.equal(retryCalls, 0); assert.equal(records()[0].phase, 'burned')
  assert.match(latestState.status, /burn is verified.*Activity/); assert.equal(latestState.result.destinationVerified, false)
})
await test('actual hook: G2 refusal remains pre-wallet/pre-B1 and is distinguished from wallet/network errors', async () => {
  await hookRun(async args => { const changed = tx(); changed.message.compiledInstructions.at(-1).data[8] ^= 1; try { await args.from.adapter.provider.signTransaction(changed) } catch { return { state: 'error' } } })
  assert.equal(walletCalls, 0); assert.equal(retryCalls, 0); assert.equal(records()[0].phase, 'released'); assert.equal(records()[0].signingAt, undefined)
  assert.match(latestState.error, /Machina G2 rejected/)
})
await test('actual hook: ordinary successful SDK flow still signs once and uses independent destination verification', async () => {
  await hookRun(async args => { await args.from.adapter.provider.signTransaction(tx()); return { state: 'success', sourceTxHash: real.burn.signature } }, { solanaSignatureStatus: async () => ({ found: true, err: null, confirmed: true }) })
  assert.equal(walletCalls, 1); assert.equal(retryCalls, 0)
  assert.equal(latestState.result.destinationVerified, false, 'SDK success alone cannot claim destination success')
  assert.match(latestState.status, /Receive verification pending/)
})
console.log(`RESULT ${count}/${count} focused Solana source stability groups PASS; historical chain fixtures + controlled wallet/RPC/SDK ports, no real signatures or sends.`)
