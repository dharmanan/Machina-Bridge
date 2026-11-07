// Solana refundable-deposit reclaim: RPC provider fallback, error reporting and post-signature safety.
// Real src/lib/mainnetSolanaReclaim.ts with per-provider controlled answers. No network, wallet or transaction.
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
const require = createRequire(import.meta.url), ts = require('typescript'), root = fileURLToPath(new URL('..', import.meta.url))
require.extensions['.ts'] = (m, f) => m._compile(ts.transpileModule(readFileSync(f, 'utf8').replaceAll('import.meta.env', '({})'), { fileName: f,
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText, f)
const { PublicKey, Keypair, Connection } = require('@solana/web3.js'), { Buffer } = require('buffer')
const sol = require(root + 'src/lib/mainnetSolanaReclaim.ts'), { SOLANA_MAINNET_CCTP } = require(root + 'src/config/mainnetSolana.ts')
const { owner, nonce, zero, word, message, source, sc } = require('./fixtures/cctp-recovery.cjs')
globalThis.window = { localStorage: { getItem: () => null, setItem() {}, removeItem() {} }, dispatchEvent() {}, addEventListener() {}, removeEventListener() {} }
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { locks: { request: async (_n, _o, run) => run({}) } } })
globalThis.fetch = async input => { throw new Error(`Network forbidden: ${String(input)}`) }

const wallet = Keypair.generate().publicKey, eventAccount = Keypair.generate().publicKey, program = new PublicKey(sc.messageTransmitterProgram)
const solWord = x => '0x' + new PublicKey(x).toBuffer().toString('hex')
const msg = extra => message({ src: 5, dst: 26, sender: solWord(sc.tokenMessengerMinterProgram), recipient: word(source.tokenMessengerAddress), caller: zero, burn: solWord(sc.usdcMint), mint: word(owner), from: solWord(wallet), ...extra })
const solMessage = msg({}), solSigned = msg({ nonce, executed: 2000 })
function account(age = 6 * 86400) {
  const data = Buffer.alloc(428); Buffer.from('83648538a6e1973c', 'hex').copy(data); wallet.toBuffer().copy(data, 8)
  data.writeBigInt64LE(BigInt(Math.floor(Date.now() / 1000) - age), 40); data.writeUInt32LE(376, 48); Buffer.from(solMessage.slice(2), 'hex').copy(data, 52)
  return { owner: program, lamports: 2000000, data }
}
const creation = { meta: { err: null, innerInstructions: [] }, transaction: { message: { accountKeys: [{ pubkey: eventAccount, signer: true }, { pubkey: wallet, signer: true }], instructions: [{ programId: program, accounts: [eventAccount, wallet] }] } } }
const metadata = { sourceTxHash: 'source-signature', messageSentEventAccount: eventAccount.toBase58(), refundableDepositSol: '0.002', refundAvailableAt: Date.now() - 1000, refundDestinationMessage: solSigned, refundAttestation: '0x' + 'ab'.repeat(65) }

// Provider answers observed in production / encoded in api/solana-rpc.js (free plan, personal token).
const DRPC = new Error('SolanaJSONRPCError: chain is not available on free plan (code 35)')
const ANKR = new Error('Unauthorized: You must authenticate your request with an API key (personal token)')
const DOWN = new Error('failed to get info about account: 503 Service Unavailable')
const LIMIT = new Error('failed to get info about account: 429 Too Many Requests')
const PREFLIGHT = new Error('Transaction simulation failed: Error processing Instruction 0: custom program error: 0x1771')
const INVALID = new Error('failed to get info about account: Invalid param: WrongSize')
const EXPIRED = new Error('TransactionExpiredBlockheightExceededError: Signature has expired: block height exceeded.')
const all = e => ({ read: e, simulate: e, send: e, confirm: e })
const unavailable = { 'rpc.ankr.com': all(ANKR), 'solana.drpc.org': all(DRPC) }

let plan, log, signs, sent
const host = c => new URL(c.rpcEndpoint).hostname
const kinds = { getAccountInfo: 'read', getParsedTransaction: 'read', getSlot: 'read', getBlockTime: 'read', getLatestBlockhash: 'read', simulateTransaction: 'simulate', sendRawTransaction: 'send', confirmTransaction: 'confirm' }
const answers = {
  getAccountInfo: h => (plan[h] && 'info' in plan[h] ? plan[h].info : plan.info === undefined ? account() : plan.info),
  getParsedTransaction: () => creation, getSlot: () => 1, getBlockTime: () => Math.floor(Date.now() / 1000),
  getLatestBlockhash: () => ({ blockhash: '11111111111111111111111111111111', lastValidBlockHeight: 100 }),
  simulateTransaction: () => ({ value: { err: plan.simErr ?? null } }), sendRawTransaction: () => 'controlled-signature', confirmTransaction: () => ({ value: { err: plan.confirmErr ?? null } }),
}
for (const [name, kind] of Object.entries(kinds)) Connection.prototype[name] = async function (...args) {
  const h = host(this); log.push(`${h} ${name}`)
  if (name === 'sendRawTransaction') sent.push(Buffer.from(args[0]).toString('hex'))
  const e = plan[h]?.[kind]; if (e) throw e
  return answers[name](h)
}
const run = (o = {}) => sol.reclaimMainnetSolanaDeposit({ connectedWallet: o.connected ?? wallet.toBase58(), originalWallet: wallet.toBase58(), metadata,
  provider: { signTransaction: async tx => { signs++; return { serialize: () => Buffer.from([1, 2, 3]), serializeMessage: () => tx.serializeMessage() } } } })
let count = 0
async function test(name, p, check, o) {
  plan = { ...unavailable, ...p }; log = []; signs = 0; sent = []
  const r = await run(o).then(ok => ({ ok }), e => ({ error: e.message }))
  check(r)
  assert.ok(!log.some(l => l.startsWith('solana.drpc.org')), 'dRPC is never called by reclaim')
  count++; console.log(`PASS ${name}`)
}
const after = l => log.slice(log.findIndex(x => x.includes('sendRawTransaction')))

await test('reclaim candidates exclude dRPC only; the shared Solana RPC list used by other flows is unchanged', {}, () => {
  assert.deepEqual(sol.SOLANA_RECLAIM_RPCS, ['https://solana-rpc.publicnode.com', 'https://api.mainnet.solana.com', 'https://rpc.ankr.com/solana'])
  assert.ok(SOLANA_MAINNET_CCTP.rpcUrls.includes('https://solana.drpc.org'), 'other Solana flows keep their list')
})
await test('A. all reads fail: the first provider\'s real cause is reported, not a later plan/auth message; no signature',
  { 'solana-rpc.publicnode.com': { read: DOWN }, 'api.mainnet.solana.com': { read: LIMIT } },
  r => { assert.match(r.error, /503 Service Unavailable/); assert.doesNotMatch(r.error, /free plan|personal token/); assert.equal(signs, 0); assert.ok(!log.some(l => /simulate|sendRaw/.test(l))) })
await test('B. broadcast refused by preflight on the working provider: that cause is reported, as outcome-unknown; signed once',
  { 'solana-rpc.publicnode.com': { send: PREFLIGHT }, 'api.mainnet.solana.com': { send: LIMIT } },
  r => { assert.match(r.error, /custom program error: 0x1771/); assert.match(r.error, /may still be processed/); assert.equal(signs, 1) })
await test('C. a substantive read error outranks outage messages from other providers; no signature',
  { 'solana-rpc.publicnode.com': { read: DOWN }, 'api.mainnet.solana.com': { read: INVALID } },
  r => { assert.match(r.error, /WrongSize/); assert.equal(signs, 0) })
await test('D. failed simulation never requests a Phantom signature or broadcast', { simErr: { InstructionError: [0, { Custom: 1 }] } },
  r => { assert.match(r.error, /simulation failed; no wallet signature/); assert.equal(signs, 0); assert.equal(sent.length, 0) })
await test('E. publicnode fully down: api.mainnet.solana.com serves read, clock, blockhash, simulate, send and confirm', { 'solana-rpc.publicnode.com': all(DOWN) },
  r => { assert.deepEqual(r.ok, { txHash: 'controlled-signature', alreadyClosed: false }); assert.equal(signs, 1)
    for (const m of ['getAccountInfo', 'getSlot', 'getBlockTime', 'getLatestBlockhash', 'simulateTransaction', 'sendRawTransaction', 'confirmTransaction']) assert.ok(log.includes('api.mainnet.solana.com ' + m), m) })
await test('F. wallet mismatch is refused before any RPC call or signature', {},
  r => { assert.match(r.error, /same Phantom wallet/); assert.equal(signs, 0); assert.equal(log.length, 0) }, { connected: Keypair.generate().publicKey.toBase58() })
await test('G. five-day window: eligible-looking metadata is still refused by the on-chain clock; no signature', { info: account(3600) },
  r => { assert.match(r.error, /five-day refund window/); assert.equal(signs, 0) })
await test('H. control: healthy first provider completes with exactly one signature', {},
  r => { assert.ok(r.ok && !r.ok.alreadyClosed); assert.equal(signs, 1); assert.equal(sent.length, 1) })

// ---------------- closed-account proof: one lagging RPC can never produce "already closed"
await test('I. one RPC says "no account" while another still sees it open: no alreadyClosed, nothing signed or recorded',
  { 'solana-rpc.publicnode.com': { info: null } },
  r => { assert.equal(r.ok, undefined); assert.match(r.error, /disagree about this deposit account/); assert.equal(signs, 0); assert.equal(sent.length, 0) })
await test('J. "no account" without any second provider able to confirm: refused, nothing signed or recorded',
  { 'solana-rpc.publicnode.com': { info: null }, 'api.mainnet.solana.com': { read: DOWN } },
  r => { assert.match(r.error, /closure could not be confirmed by a second Solana RPC \(failed to get info about account: 503/); assert.equal(signs, 0) })
await test('K. closure confirmed by an independent provider plus the bound source transaction: alreadyClosed, no signature', { info: null },
  r => { assert.deepEqual(r.ok, { alreadyClosed: true }); assert.equal(signs, 0); assert.equal(sent.length, 0)
    assert.ok(log.includes('solana-rpc.publicnode.com getAccountInfo') && log.includes('api.mainnet.solana.com getAccountInfo')) })

// ---------------- after the single Phantom signature: never assume "not sent", never sign again
await test('L. every broadcast attempt errors: outcome reported as unknown; same signed bytes only, one signature, no new reclaim built',
  { 'solana-rpc.publicnode.com': { send: DOWN }, 'api.mainnet.solana.com': { send: LIMIT } },
  r => { assert.match(r.error, /could not be confirmed as submitted/); assert.match(r.error, /re-check the deposit before signing again/)
    assert.equal(signs, 1); assert.ok(sent.length >= 2 && sent.every(b => b === sent[0]), 'only the one signed transaction is re-sent')
    assert.ok(!after().some(l => /getLatestBlockhash|simulateTransaction|getAccountInfo/.test(l)), 'no new reclaim is prepared after signing') })
await test('M. confirmation unknown after submission: the signature is reported and no second signature is requested',
  { 'solana-rpc.publicnode.com': { confirm: EXPIRED } },
  r => { assert.match(r.error, /controlled-signature was submitted but its confirmation is unknown/); assert.equal(signs, 1); assert.equal(sent.length, 1) })
await test('N. a landed-but-failed reclaim stays a definite failure (not unknown)', { confirmErr: { InstructionError: [0, { Custom: 2 }] } },
  r => { assert.match(r.error, /reclaim transaction failed/); assert.doesNotMatch(r.error, /unknown/); assert.equal(signs, 1) })
console.log(`RESULT ${count}/${count} Solana reclaim RPC groups PASS; controlled providers, one Phantom signature at most; no network, wallet or transaction`)
