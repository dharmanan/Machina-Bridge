// Focused source-burn regression: public Mainnet fixtures, real B1/G2 and installed SDK;
// all wallet, broadcast and confirmation ports are controlled. No real signing/network.
import assert from 'node:assert/strict'
import { createRequire, Module } from 'node:module'
import { readFileSync } from 'node:fs'
import { Connection, PublicKey, VersionedTransaction } from '@solana/web3.js'
import { BridgeKit } from '@circle-fin/bridge-kit'
import { createSolanaAdapterFromProvider } from '@circle-fin/adapter-solana'
const require = createRequire(import.meta.url), ts = require('typescript')
require.extensions['.ts'] = (m, f) => m._compile(ts.transpileModule(readFileSync(f, 'utf8').replaceAll('import.meta.env', '({})'), { fileName: f, compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true, jsx: ts.JsxEmit.ReactJSX } }).outputText, f)
const store = new Map()
globalThis.localStorage = { getItem: k => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) }
globalThis.window = { location: { origin: 'https://machina.test' }, localStorage, dispatchEvent() {}, addEventListener() {}, removeEventListener() {}, setTimeout, clearTimeout }
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
await test('real adapter confirmation probe reproduces old same-origin WSS mistake and uses provider WSS with the fixed connection', async () => {
  const previous = globalThis.WebSocket, probes = []
  // Only the socket transport is controlled: run the installed adapter's actual
  // confirmation/capability code, without opening any real socket or signing.
  globalThis.WebSocket = class {
    constructor(url) { probes.push(url); queueMicrotask(() => this.onopen?.()) }
    send(raw) { const request = JSON.parse(raw); assert.equal(request.method, 'signatureSubscribe'); queueMicrotask(() => this.onmessage?.({ data: JSON.stringify({ jsonrpc: '2.0', id: request.id, result: 1 }) })) }
    close() {}
  }
  try {
    const old = new Connection('https://machina.test/api/solana-rpc', { wsEndpoint: 'wss://solana-rpc.publicnode.com' })
    const fixed = C.createSolanaBridgeConnection(window.location.origin)
    for (const connection of [old, fixed]) {
      const adapter = await createSolanaAdapterFromProvider({ connection, provider: { connect: async () => assert.fail('no connect'), disconnect: async () => {}, isConnected: true, publicKey: new PublicKey(owner), signTransaction: async () => assert.fail('no signing') }, capabilities: { addressContext: 'user-controlled', supportedChains: [solana] } })
      assert.equal(adapter.getConnection(solana), connection, 'SDK must retain the explicit Connection instance')
      assert.equal(adapter.getConnection(solana)._rpcWsEndpoint, 'wss://solana-rpc.publicnode.com')
      let confirmations = 0
      connection.confirmTransaction = async (params, commitment) => {
        confirmations++; assert.equal(params.signature, real.burn.signature); assert.equal(commitment, 'confirmed')
        return { context: { slot: 1 }, value: { err: null } }
      }
      assert.equal(await adapter.confirmAndValidate(connection, real.burn.signature, tx().message.recentBlockhash, 999), real.burn.signature)
      assert.equal(confirmations, 1)
    }
    assert.deepEqual(probes, ['wss://machina.test/api/solana-rpc', 'wss://solana-rpc.publicnode.com'])
  } finally { globalThis.WebSocket = previous }
})
await test('real adapter Connection routes HTTP reads through proxy and stops serialized broadcast at a local transport boundary', async () => {
  const previous = globalThis.fetch, calls = []
  globalThis.fetch = async (url, init) => {
    assert.equal(url, 'https://machina.test/api/solana-rpc')
    const request = JSON.parse(init.body); calls.push(request.method)
    if (request.method === 'isBlockhashValid') {
      assert.equal(request.params[0], tx().message.recentBlockhash)
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { context: { slot: 1 }, value: true } }), { status: 200 })
    }
    if (request.method === 'sendTransaction') {
      assert.equal(request.params[1].maxRetries, 0)
      assert.equal(request.params[1].skipPreflight, true)
      throw new Error('LOCAL_BROADCAST_STOP') // no packet leaves this process
    }
    assert.equal(request.method, 'getLatestBlockhash')
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { context: { slot: 1 }, value: { blockhash: tx().message.recentBlockhash, lastValidBlockHeight: 999 } } }), { status: 200 })
  }
  try {
    const connection = C.createSolanaBridgeConnection(window.location.origin)
    const adapter = await createSolanaAdapterFromProvider({ connection, provider: { connect: async () => assert.fail('no connect'), disconnect: async () => {}, isConnected: true, publicKey: new PublicKey(owner), signTransaction: async () => assert.fail('no wallet signatures') }, capabilities: { addressContext: 'user-controlled', supportedChains: [solana] } })
    assert.equal(adapter.getConnection(solana), connection)
    assert.equal((await adapter.getConnection(solana).getLatestBlockhash()).lastValidBlockHeight, 999)
    // Reuse immutable historical fixture bytes. The controlled signer returns
    // them unchanged; it generates no signature. The actual web3 transport
    // serializes the SDK send but its fetch port always refuses publication.
    const historical = tx(), original = Buffer.from(historical.serialize())
    await assert.rejects(adapter.sendWithProviderSigner(connection, { publicKey: new PublicKey(owner), isProviderSigner: true, signTransaction: async t => t }, historical, [], historical.message.recentBlockhash, 999), /LOCAL_BROADCAST_STOP/)
    assert.deepEqual(Buffer.from(historical.serialize()), original)
    assert.deepEqual(calls, ['getLatestBlockhash', 'isBlockhashValid', 'sendTransaction'])
  } finally { globalThis.fetch = previous }
})
await test('expired signed blockhash or failed expiry read never reaches broadcast and never refreshes signed bytes', async () => {
  const previous = globalThis.fetch
  try {
    for (const unreadable of [false, true]) {
      const methods = [], bytes = Buffer.from(real.burn.base64, 'base64'), copy = Buffer.from(bytes)
      globalThis.fetch = async (_url, init) => {
        const q = JSON.parse(init.body); methods.push(q.method)
        assert.equal(q.method, 'isBlockhashValid')
        if (unreadable) throw new Error('controlled read failure')
        return new Response(JSON.stringify({ jsonrpc: '2.0', id: q.id, result: { context: { slot: 1 }, value: false } }))
      }
      const connection = C.createSolanaBridgeConnection(window.location.origin)
      await assert.rejects(connection.sendRawTransaction(bytes, { maxRetries: 0 }), unreadable ? /controlled read failure/ : /expired before broadcast/)
      assert.deepEqual(methods, ['isBlockhashValid']); assert.deepEqual(bytes, copy)
    }
  } finally { globalThis.fetch = previous }
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
  if (name === '@circle-fin/adapter-solana') return { createSolanaAdapterFromProvider: async opts => {
    assert.equal(opts.connection.rpcEndpoint, C.SOLANA_BRIDGE_SDK_RPC)
    assert.equal(opts.connection._rpcWsEndpoint, 'wss://solana-rpc.publicnode.com')
    assert.equal(opts.capabilities.supportedChains[0].rpcEndpoints[0], opts.connection.rpcEndpoint)
    return opts
  } }
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
