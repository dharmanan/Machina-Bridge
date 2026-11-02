// F1 / G2: the pre-sign policy for Solana transactions built by Circle Bridge Kit.
// Real mainnet transactions (public chain data in fixtures) must pass; transactions redirected by a
// falsified IDL (Anchor `Program.at` with a fake RPC answer) and every other deviation must be refused
// before the wallet is called. B1's journal must release, never lock, on such a refusal.
// No network, no real wallet, no signature, no transaction.
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
const require = createRequire(import.meta.url), ts = require('typescript')
require.extensions['.ts'] = (m, f) => m._compile(ts.transpileModule(readFileSync(f, 'utf8').replaceAll('import.meta.env', '({})'), { fileName: f, compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText, f)

const store = new Map()
globalThis.localStorage = { getItem: k => store.has(k) ? store.get(k) : null, setItem: (k, v) => store.set(k, String(v)), removeItem: k => store.delete(k) }
globalThis.window = { localStorage: globalThis.localStorage, dispatchEvent() {}, addEventListener() {}, removeEventListener() {}, setTimeout, clearTimeout }

const { VersionedTransaction, TransactionMessage, TransactionInstruction, Transaction, AddressLookupTableAccount, PublicKey, Keypair, SystemProgram, ComputeBudgetProgram } = require('@solana/web3.js')
const { Program, AnchorProvider, BN } = require('@coral-xyz/anchor')
const { deflate } = require('pako')
const P = require('../src/lib/solanaBridgeTxPolicy.ts')
const { withSolanaSendGuard } = require('../src/lib/solanaSendRuntime.ts')
const G = require('../src/lib/solanaSendGuard.ts')

const FX = JSON.parse(readFileSync(new URL('./fixtures/solana-bridge-real-tx.json', import.meta.url)))
const IDL = JSON.parse(readFileSync(new URL('./fixtures/solana-cctp-idl.json', import.meta.url)))
const ATTACKER = Keypair.generate().publicKey, ATTACKER_EVM = '0x' + '99'.repeat(20)
const alt = new AddressLookupTableAccount({ key: new PublicKey(FX.cctpAlt.address), state: AddressLookupTableAccount.deserialize(Buffer.from(FX.cctpAlt.base64, 'base64')) })
const realBurn = () => VersionedTransaction.deserialize(Buffer.from(FX.burn.base64, 'base64'))
const realReceive = () => VersionedTransaction.deserialize(Buffer.from(FX.receive.base64, 'base64'))
const BURN = { kind: 'burn', owner: FX.burn.owner, amountRaw: BigInt(FX.burn.amountRaw), evmRecipient: FX.burn.evmRecipient }
const RECV = { kind: 'receive', owner: FX.receive.owner, amountRaw: BigInt(FX.receive.amountRaw) }
// Decompile -> edit instructions -> recompile, keeping the real blockhash, payer and (for receive) the CCTP ALT.
const edit = (tx, change, alts = []) => {
  const m = TransactionMessage.decompile(tx.message, { addressLookupTableAccounts: alts })
  const ixs = change(m.instructions.map(i => new TransactionInstruction({ programId: i.programId, keys: i.keys.map(k => ({ ...k })), data: Buffer.from(i.data) })), m)
  return new VersionedTransaction(new TransactionMessage({ payerKey: m.payerKey, recentBlockhash: m.recentBlockhash, instructions: ixs }).compileToV0Message(alts))
}
const editBurn = change => edit(realBurn(), change)
const editReceive = change => edit(realReceive(), change, [alt])
const refused = (tx, expected, code) => assert.throws(() => P.assertSolanaBridgeTransaction(tx, expected), e => e instanceof P.SolanaTxPolicyError && e.code === code, `expected refusal ${code}`)
const kitIx = ixs => ixs.findIndex(i => i.programId.toBase58() === P.SOLANA_BRIDGE_PROGRAMS.kitBridge)
const recvIx = ixs => ixs.findIndex(i => i.programId.toBase58() === P.SOLANA_BRIDGE_PROGRAMS.messageTransmitter)
const patchData = (ix, offset, bytes) => { const d = Buffer.from(ix.data); Buffer.from(bytes).copy(d, offset); ix.data = d; return ix }
const le = (v, n) => { const b = Buffer.alloc(n); if (n === 4) b.writeUInt32LE(Number(v)); else b.writeBigUInt64LE(BigInt(v)); return b }
const receiveMessage = tx => '0x' + Buffer.from(tx.message.compiledInstructions.at(-1).data).subarray(12, 12 + 376).toString('hex')

let count = 0
async function test(name, fn) { store.clear(); await fn(); count++; console.log('PASS ' + name) }

await test('[real chain] the real Solana → Arc burn (QsF23bfa…) and Arc → Solana receive (5SsG9DW7…) pass; recovery passes only with the exact attested message', () => {
  P.assertSolanaBridgeTransaction(realBurn(), BURN)
  P.assertSolanaBridgeTransaction(realReceive(), RECV)
  P.assertSolanaBridgeTransaction(realReceive(), { ...RECV, exactMessage: receiveMessage(realReceive()) })
  const m = receiveMessage(realReceive()), flipped = m.slice(0, 40) + (m[40] === 'a' ? 'b' : 'a') + m.slice(41) // a nonce byte
  assert.notEqual(flipped, m)
  refused(realReceive(), { ...RECV, exactMessage: flipped }, 'message')
  P.assertSolanaBridgeTransaction(editBurn(ixs => ixs), BURN) // rebuild round trip used by the mutations below
  P.assertSolanaBridgeTransaction(editReceive(ixs => ixs), RECV)
})

// Anchor `Program.at` with an RPC whose IDL account answer is falsified (G2).
function fakeIdlProvider(name, programId, mutate) {
  const idl = mutate(structuredClone(IDL[name]))
  const json = Buffer.from(deflate(Buffer.from(JSON.stringify(idl))))
  const data = Buffer.concat([Buffer.alloc(8), Buffer.alloc(32), le(json.length, 4), json])
  const connection = { getAccountInfo: async () => ({ data, owner: new PublicKey(programId), lamports: 1, executable: false }) }
  return new AnchorProvider(connection, { publicKey: new PublicKey(FX.burn.owner), signTransaction: async t => t, signAllTransactions: async t => t }, {})
}
const camel = s => s.replace(/_([a-z])/g, (_, c) => c.toUpperCase())
async function anchorBridgeIx(mutate) {
  const program = await Program.at(P.SOLANA_BRIDGE_PROGRAMS.kitBridge, fakeIdlProvider('KitBridge', P.SOLANA_BRIDGE_PROGRAMS.kitBridge, mutate))
  const real = TransactionMessage.decompile(realBurn().message).instructions[3]
  const def = IDL.KitBridge.instructions.find(i => i.name === 'bridge')
  const accounts = Object.fromEntries(def.accounts.map((a, i) => [camel(a.name), real.keys[i].pubkey]))
  const params = { amount: new BN(100000), destinationDomain: 26, mintRecipient: new PublicKey(Buffer.from(FX.burn.evmRecipient.slice(2).padStart(64, '0'), 'hex')), destinationCaller: PublicKey.default, maxFee: new BN(3), minFinalityThreshold: 1000, bridgingKitFee: new BN(0) }
  return { program, ix: await program.methods.bridge(params).accountsStrict(accounts).signers([]).instruction() }
}
await test('G2: a falsified IDL makes Anchor build the burn for another program; the policy refuses it before the wallet', async () => {
  const honest = await anchorBridgeIx(idl => idl)
  assert.equal(honest.program.programId.toBase58(), P.SOLANA_BRIDGE_PROGRAMS.kitBridge)
  P.assertSolanaBridgeTransaction(editBurn(ixs => { ixs[kitIx(ixs)] = honest.ix; return ixs }), BURN) // honest IDL: same as chain
  const fake = await anchorBridgeIx(idl => ({ ...idl, address: ATTACKER.toBase58() }))
  assert.equal(fake.program.programId.toBase58(), ATTACKER.toBase58(), 'Anchor takes the program id from the IDL answer (the G2 mechanism)')
  assert.equal(fake.ix.programId.toBase58(), ATTACKER.toBase58())
  refused(editBurn(ixs => { ixs[kitIx(ixs)] = fake.ix; return ixs }), BURN, 'program')
  // Same program, falsified argument order: mint_recipient and destination_caller swapped.
  const swapped = await anchorBridgeIx(idl => { const t = idl.types.find(x => x.name === 'BridgeParams').type.fields; const i = t.findIndex(f => f.name === 'mint_recipient'); [t[i], t[i + 1]] = [t[i + 1], t[i]]; return idl })
  refused(editBurn(ixs => { ixs[kitIx(ixs)] = swapped.ix; return ixs }), BURN, 'recipient')
  // Falsified account order: the user's ATA and the fee account swapped.
  const reordered = await anchorBridgeIx(idl => { const a = idl.instructions.find(i => i.name === 'bridge').accounts; const i = a.findIndex(x => x.name === 'burn_token_account'), j = a.findIndex(x => x.name === 'protocol_fee_wallet_token_account'); [a[i], a[j]] = [a[j], a[i]]; return idl })
  refused(editBurn(ixs => { ixs[kitIx(ixs)] = reordered.ix; return ixs }), BURN, 'accounts')
})
await test('G2: a falsified MessageTransmitter IDL redirects the receive to another program; the policy refuses it', async () => {
  const program = await Program.at(P.SOLANA_BRIDGE_PROGRAMS.messageTransmitter, fakeIdlProvider('MessageTransmitterV2', P.SOLANA_BRIDGE_PROGRAMS.messageTransmitter, idl => ({ ...idl, address: ATTACKER.toBase58() })))
  assert.equal(program.programId.toBase58(), ATTACKER.toBase58())
  refused(editReceive(ixs => { const i = recvIx(ixs); ixs[i] = new TransactionInstruction({ programId: program.programId, keys: ixs[i].keys, data: ixs[i].data }); return ixs }), RECV, 'program')
})
await test('burn: amount, destination, recipient, caller, fees, finality and discriminator are bound to Machina’s context', () => {
  refused(realBurn(), { ...BURN, amountRaw: 200000n }, 'amount')
  refused(realBurn(), { ...BURN, evmRecipient: ATTACKER_EVM }, 'recipient')
  refused(realBurn(), { ...BURN, owner: ATTACKER.toBase58() }, 'fee_payer')
  refused(realBurn(), { ...BURN, maxFeeRaw: 2n }, 'fee')
  const at = (o, b) => editBurn(ixs => { patchData(ixs[kitIx(ixs)], o, b); return ixs })
  refused(at(16, le(5, 4)), BURN, 'destination')
  refused(at(20, Buffer.alloc(32, 7)), BURN, 'recipient')
  refused(at(52, ATTACKER.toBytes()), BURN, 'destination_caller')
  refused(at(84, le(5000, 8)), BURN, 'fee') // max fee above 1% of 0.1 USDC
  refused(at(96, le(1, 8)), BURN, 'fee')
  refused(at(92, le(0, 4)), BURN, 'finality')
  refused(at(0, Buffer.alloc(8, 1)), BURN, 'instruction')
})
await test('burn: extra instructions, other programs, altered accounts or signers are refused', () => {
  const ATA = new PublicKey(P.solanaAta(FX.burn.owner)), owner = new PublicKey(FX.burn.owner)
  refused(editBurn(ixs => [...ixs.slice(0, -1), new TransactionInstruction({ programId: new PublicKey(P.SOLANA_BRIDGE_PROGRAMS.token), keys: [{ pubkey: ATA, isSigner: false, isWritable: true }, { pubkey: ATTACKER, isSigner: false, isWritable: true }, { pubkey: owner, isSigner: true, isWritable: false }], data: Buffer.from([3, ...le(1, 8)]) }), ixs.at(-1)]), BURN, 'program')
  refused(editBurn(ixs => [SystemProgram.transfer({ fromPubkey: owner, toPubkey: ATTACKER, lamports: 1 }), ...ixs]), BURN, 'system')
  refused(editBurn(ixs => { patchData(ixs[2], 4, le(3_900_001, 8)); return ixs }), BURN, 'system')
  refused(editBurn(ixs => { ixs[2].keys[1] = { pubkey: ATTACKER, isSigner: false, isWritable: true }; return ixs }), BURN, 'system')
  refused(editBurn(ixs => { ixs[kitIx(ixs)].keys[4] = { pubkey: new PublicKey(P.solanaAta(ATTACKER.toBase58())), isSigner: false, isWritable: true }; return ixs }), BURN, 'accounts')
  refused(editBurn(ixs => { ixs[kitIx(ixs)].keys[14] = { pubkey: ATTACKER, isSigner: false, isWritable: false }; return ixs }), BURN, 'accounts')
  refused(editBurn(ixs => { ixs[kitIx(ixs)].keys[1] = { pubkey: ATTACKER, isSigner: true, isWritable: true }; return ixs }), BURN, 'signers')
  refused(editBurn(ixs => { const b = ixs.pop(); return [...ixs, b, ComputeBudgetProgram.setComputeUnitLimit({ units: 1 })] }), BURN, 'program') // bridge not last
  const withLookup = realBurn(); withLookup.message.addressTableLookups.push({ accountKey: ATTACKER, writableIndexes: [], readonlyIndexes: [0] })
  refused(withLookup, BURN, 'lookup_table')
  refused(new Transaction(), BURN, 'format')
  refused({ message: {} }, BURN, 'format')
})
await test('receive: recipient, route, amount, payer/caller, programs and lookup table are bound; the attacker cannot be paid', () => {
  refused(realReceive(), { ...RECV, owner: ATTACKER.toBase58() }, 'fee_payer')
  refused(realReceive(), { ...RECV, amountRaw: 1n }, 'amount')
  const msgAt = (o, b) => editReceive(ixs => { patchData(ixs[recvIx(ixs)], 12 + o, b); return ixs })
  refused(msgAt(184, new PublicKey(P.solanaAta(ATTACKER.toBase58())).toBytes()), RECV, 'recipient')
  refused(msgAt(8, le(0, 4).reverse()), RECV, 'destination') // destination domain 0
  refused(msgAt(108, ATTACKER.toBytes()), RECV, 'destination_caller')
  refused(editReceive(ixs => { patchData(ixs[recvIx(ixs)], 0, Buffer.alloc(8, 2)); return ixs }), RECV, 'instruction')
  refused(editReceive(ixs => { ixs[recvIx(ixs)].keys[1] = { pubkey: ATTACKER, isSigner: true, isWritable: false }; return ixs }), RECV, 'signers')
  refused(editReceive(ixs => [...ixs, SystemProgram.transfer({ fromPubkey: new PublicKey(FX.receive.owner), toPubkey: ATTACKER, lamports: 1 })]), RECV, 'program')
  const otherAlt = realReceive(); otherAlt.message.addressTableLookups[0].accountKey = ATTACKER
  refused(otherAlt, RECV, 'lookup_table')
  refused(realBurn(), { ...RECV, owner: FX.burn.owner }, 'signers') // a burn offered as a receive
  refused(realReceive(), { ...BURN, owner: FX.receive.owner }, 'signers') // a receive offered as a burn
})
await test('[not seen on chain yet] ATA creation: only the burn’s fee accounts or the user’s own USDC account, paid by the user', () => {
  const owner = new PublicKey(FX.burn.owner), USDC = new PublicKey(P.SOLANA_USDC_MINT)
  const ataIx = (payer, ata, own, data = [1]) => new TransactionInstruction({ programId: new PublicKey(P.SOLANA_BRIDGE_PROGRAMS.associatedToken), keys: [
    { pubkey: payer, isSigner: true, isWritable: true }, { pubkey: ata, isSigner: false, isWritable: true }, { pubkey: own, isSigner: false, isWritable: false },
    { pubkey: USDC, isSigner: false, isWritable: false }, { pubkey: SystemProgram.programId, isSigner: false, isWritable: false }, { pubkey: new PublicKey(P.SOLANA_BRIDGE_PROGRAMS.token), isSigner: false, isWritable: false }], data: Buffer.from(data) })
  const real = TransactionMessage.decompile(realBurn().message).instructions[3]
  const protocolFeeAta = real.keys[19].pubkey, devFeeAta = real.keys[20].pubkey
  const feeOwner = new PublicKey('8f9Zu2R7qbfy8AKLrXbn9KJzBvnjTd7TyR4bnSW4ZEsf') // owner of the protocol fee ATA on chain
  assert.equal(P.solanaAta(feeOwner.toBase58()), protocolFeeAta.toBase58())
  P.assertSolanaBridgeTransaction(editBurn(ixs => [...ixs.slice(0, 3), ataIx(owner, protocolFeeAta, feeOwner), ataIx(owner, devFeeAta, PublicKey.default), ixs[3]]), BURN)
  refused(editBurn(ixs => [...ixs.slice(0, 3), ataIx(owner, new PublicKey(P.solanaAta(ATTACKER.toBase58())), ATTACKER), ixs[3]]), BURN, 'ata')
  refused(editBurn(ixs => [...ixs.slice(0, 3), ataIx(owner, new PublicKey(P.solanaAta(owner.toBase58())), owner), ixs[3]]), BURN, 'ata')
  refused(editBurn(ixs => [...ixs.slice(0, 3), ataIx(owner, ATTACKER, feeOwner), ixs[3]]), BURN, 'ata') // not the derived address
  const rOwner = new PublicKey(FX.receive.owner), rAta = new PublicKey(P.solanaAta(FX.receive.owner))
  P.assertSolanaBridgeTransaction(editReceive(ixs => [...ixs.slice(0, 2), ataIx(rOwner, rAta, rOwner, []), ixs[2]]), RECV)
  const fallback = new VersionedTransaction(new TransactionMessage({ payerKey: rOwner, recentBlockhash: realReceive().message.recentBlockhash, instructions: [ComputeBudgetProgram.setComputeUnitLimit({ units: 50_000 }), ataIx(rOwner, rAta, rOwner, [])] }).compileToV0Message())
  P.assertSolanaBridgeTransaction(fallback, RECV) // ATA-only fallback when the combined transaction is too large
  refused(editReceive(ixs => [...ixs.slice(0, 2), ataIx(rOwner, new PublicKey(P.solanaAta(ATTACKER.toBase58())), ATTACKER, []), ixs[2]]), RECV, 'ata')
  refused(editReceive(ixs => [...ixs.slice(0, 2), ataIx(rOwner, rAta, rOwner, [7]), ixs[2]]), RECV, 'ata')
})
await test('[not seen on chain yet] compute budget: real values pass, a higher fee within 0.002 SOL passes, above it or extra budget instructions are refused', () => {
  const setCb = (price, limit) => ixs => [ComputeBudgetProgram.setComputeUnitPrice({ microLamports: price }), ComputeBudgetProgram.setComputeUnitLimit({ units: limit }), ...ixs.slice(2)]
  P.assertSolanaBridgeTransaction(editBurn(setCb(5_000_000, 200_000)), BURN) // 0.001 SOL
  P.assertSolanaBridgeTransaction(editBurn(setCb(10_000_000, 200_000)), BURN) // exactly 0.002 SOL
  refused(editBurn(setCb(10_000_001, 200_000)), BURN, 'compute_budget')
  refused(editBurn(setCb(1, 1_400_001)), BURN, 'compute_budget')
  refused(editBurn(ixs => [ComputeBudgetProgram.setComputeUnitLimit({ units: 1000 }), ...ixs]), BURN, 'compute_budget') // duplicate limit
  refused(editBurn(ixs => [ComputeBudgetProgram.requestHeapFrame({ bytes: 32 * 1024 }), ...ixs]), BURN, 'compute_budget')
  refused(editReceive(ixs => [ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 50_000_000 }), ...ixs.slice(1)]), RECV, 'compute_budget')
})

// Phantom stand-in: records every signature request.
function phantom(owner) {
  const calls = []
  return { calls, isConnected: true, publicKey: new PublicKey(owner), connect: async () => ({ publicKey: new PublicKey(owner) }), disconnect: async () => {},
    signTransaction: async tx => { calls.push('signTransaction'); tx.signatures[0] = Uint8Array.from({ length: 64 }, (_, i) => i + 1); return tx },
    signAllTransactions: async txs => { calls.push('signAllTransactions'); return txs }, signMessage: async () => { calls.push('signMessage'); return { signature: new Uint8Array(64) } } }
}
await test('the provider given to Bridge Kit exposes only signTransaction; refused transactions never reach Phantom; a changed wallet is refused', async () => {
  const wallet = phantom(FX.burn.owner), strict = P.createStrictSolanaProvider(wallet, BURN)
  assert.equal('signMessage' in strict, false); assert.equal('signAllTransactions' in strict, false)
  await assert.rejects(strict.signTransaction(editBurn(ixs => { patchData(ixs[kitIx(ixs)], 20, Buffer.alloc(32, 7)); return ixs })), e => e.code === 'recipient')
  assert.deepEqual(wallet.calls, [], 'Phantom was never asked')
  await strict.signTransaction(realBurn()); assert.deepEqual(wallet.calls, ['signTransaction'])
  wallet.publicKey = ATTACKER
  await assert.rejects(strict.signTransaction(realBurn()), e => e.code === 'wallet')
  const rWallet = phantom(FX.receive.owner), rStrict = P.createStrictSolanaProvider(rWallet, { ...RECV, exactMessage: receiveMessage(realReceive()) })
  await assert.rejects(rStrict.signTransaction(editReceive(ixs => { patchData(ixs[recvIx(ixs)], 12 + 184, new PublicKey(P.solanaAta(ATTACKER.toBase58())).toBytes()); return ixs })), e => e.code === 'recipient')
  assert.deepEqual(rWallet.calls, [])
})
const evidence = (o = {}) => ({ arcLatestBlock: async () => 1000n, arcReceipt: async () => null, arcBurnsSince: async () => [], arcNothingPending: async () => true,
  solanaSignatureStatus: async () => ({ found: false }), solanaBlockhashValid: async () => true, solanaBurnsSince: async () => [], now: () => Date.now(), ...o })
const sendInput = { direction: 'solana-to-arc', amount: '0.1', evmWallet: FX.burn.evmRecipient, solanaWallet: FX.burn.owner }
await test('B1: a policy refusal before the wallet releases the attempt (no unknown, no lock); the next transfer may start; a valid burn is journaled as before', async () => {
  const wallet = phantom(FX.burn.owner)
  const bad = editBurn(ixs => { ixs[kitIx(ixs)] = new TransactionInstruction({ programId: ATTACKER, keys: ixs[kitIx(ixs)].keys, data: ixs[kitIx(ixs)].data }); return ixs })
  await assert.rejects(withSolanaSendGuard(sendInput, async guard => {
    const provider = guard.solana(P.createStrictSolanaProvider(wallet, BURN), tx => P.assertSolanaBridgeTransaction(tx, BURN))
    assert.equal('signMessage' in provider, false); assert.equal('signAllTransactions' in provider, false)
    return provider.signTransaction(bad)
  }, evidence()), e => e instanceof P.SolanaTxPolicyError && e.code === 'program')
  assert.deepEqual(wallet.calls, [], 'Phantom never saw the redirected burn')
  const [a] = G.readSolanaSendAttempts()
  assert.equal(a.phase, 'released'); assert.equal(G.openSolanaSendAttempt(FX.burn.evmRecipient, FX.burn.owner), null, 'no lock')
  // A valid burn goes through the unchanged B1 path: blockhash and signature are saved before it is returned.
  const signed = await withSolanaSendGuard(sendInput, async guard => guard.solana(P.createStrictSolanaProvider(wallet, BURN), tx => P.assertSolanaBridgeTransaction(tx, BURN)).signTransaction(realBurn()),
    evidence({ solanaSignatureStatus: async () => ({ found: true, err: null, confirmed: true }) }))
  assert.deepEqual(wallet.calls, ['signTransaction']); assert.ok(signed)
  const latest = G.readSolanaSendAttempts()[0]
  assert.ok(latest.solanaSignature && latest.solanaBlockhash, 'signature and blockhash journaled'); assert.equal(latest.phase, 'burned')
})
const E = require('../src/lib/arcSolanaReceiveEvidence.ts')
const sourceHash = '0x' + '54'.repeat(32)
function recoverySigner(wallet) {
  const entry = E.createReceiveEntry(sourceHash, RECV.owner)
  return { entry, provider: P.createStrictSolanaProvider(E.createReceiveEvidenceSigner(wallet, entry.id), { ...RECV, exactMessage: receiveMessage(realReceive()) }) }
}
await test('combined recovery: G2 refusal before evidence signer leaves no wallet request/signature and classifies pre-wallet, not unknown', async () => {
  const wallet = phantom(RECV.owner), { entry, provider } = recoverySigner(wallet)
  const bad = editReceive(ixs => { ixs[recvIx(ixs)] = new TransactionInstruction({ programId: ATTACKER, keys: ixs[recvIx(ixs)].keys, data: ixs[recvIx(ixs)].data }); return ixs })
  let rejected
  try { await provider.signTransaction(bad) } catch(e) { rejected=e }
  assert.ok(rejected instanceof P.SolanaTxPolicyError)
  const wrapped = Object.assign(new Error('SDK wrapped refusal'), {name:'KitError',cause:rejected})
  const record = E.classifyFailedAttempt(entry.id, wrapped)
  assert.equal(record.phase, 'failed'); assert.equal(record.failure, 'pre-wallet')
  assert.equal(record.walletRequestedAt, undefined); assert.equal(record.signature, undefined); assert.deepEqual(wallet.calls, [])
})
await test('combined recovery: valid real receive keeps request timestamp/blockhash and signed signature durable before SDK gets it', async () => {
  const wallet=phantom(RECV.owner),{entry,provider}=recoverySigner(wallet)
  const result=await provider.signTransaction(realReceive())
  const record=E.readReceiveEntries().find(x=>x.id===entry.id)
  assert.equal(record.phase,'signed');assert.ok(record.walletRequestedAt&&record.receiveRequestedAt&&record.requestedBlockhash&&record.signature)
  assert.equal(record.signed[0].signature, G.solanaSignatureOf(result).signature);assert.equal(record.signed[0].blockhash,record.requestedBlockhash)
  assert.deepEqual(wallet.calls,['signTransaction'])
})
await test('combined recovery: explicit Phantom rejection stays user-rejected; unexpected wallet failure stays unknown', async () => {
  for(const reject of [true,false]) {
    store.clear();const wallet=phantom(RECV.owner);wallet.signTransaction=async()=>{wallet.calls.push('signTransaction');throw Object.assign(new Error(reject?'User rejected':'RPC unavailable'), reject?{code:4001}:{})}
    const {entry,provider}=recoverySigner(wallet);let error;try{await provider.signTransaction(realReceive())}catch(e){error=e}
    const record=E.classifyFailedAttempt(entry.id,Object.assign(new Error('SDK error'),{cause:error}))
    assert.equal(record.phase,reject?'failed':'unknown');if(reject)assert.equal(record.failure,'user-rejected')
    assert.equal(wallet.calls.length,1)
  }
})
await test('merged hook keeps G2 outside recovery evidence signer and G1 outside B1; current recovery classifier retained',()=>{
 const src=readFileSync(new URL('../src/hooks/useMainnetSolanaCctp.ts',import.meta.url),'utf8')
 assert.match(src,/createStrictSolanaProvider\(createReceiveEvidenceSigner\(phantomProvider, receiveEntryId\)/)
 assert.match(src,/exactMessage: attestation.message/)
 assert.match(src,/classifyFailedAttempt\(receiveEntryId, e\)/)
 assert.match(src,/createEvmBridgePolicyProvider\(guard.evm\(raw\)/)
 assert.ok(src.includes('const signingProvider = normalReceive ? normalReceive as unknown as PhantomSolanaProvider : phantomProvider'))
 assert.ok(src.includes('normalReceive = createBoundReceiveSigner(phantomProvider,'))
 assert.ok(src.includes("exactMessage: message"))
 assert.match(src,/guard\.solana\(createStrictSolanaProvider\(signingProvider,\s*solanaPolicy\),\s*tx\s*=>\s*\{\s*checkFee\(\);\s*assertSolanaBridgeSigningRequest\(phantomProvider,\s*tx,\s*solanaPolicy\)\s*\}\)/, 'guard.solana must wrap the strict provider and check fees before G2 validates the wallet request')
})
await test('combined B1: changed Phantom account is refused before signing journal, not unknown',async()=>{
 const wallet=phantom(FX.burn.owner);wallet.publicKey=ATTACKER
 await assert.rejects(withSolanaSendGuard(sendInput,async guard=>guard.solana(P.createStrictSolanaProvider(wallet,BURN),tx=>P.assertSolanaBridgeSigningRequest(wallet,tx,BURN)).signTransaction(realBurn()),evidence()),e=>e instanceof P.SolanaTxPolicyError&&e.code==='wallet')
 assert.deepEqual(wallet.calls,[]);const record=G.readSolanaSendAttempts()[0];assert.equal(record.phase,'released');assert.equal(record.signingAt,undefined)
})
console.log(`RESULT ${count}/${count} Solana Bridge transaction-policy groups PASS; real mainnet transactions and IDLs as fixtures, falsified IDL via Anchor Program.at; no network, wallet or signature.`)
