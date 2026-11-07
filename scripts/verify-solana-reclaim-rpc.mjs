// Solana refundable-deposit reclaim: RPC provider fallback, error reporting and post-signature safety.
// Real src/lib/mainnetSolanaReclaim.ts with per-provider controlled answers. No network, wallet or transaction.
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
const require = createRequire(import.meta.url), ts = require('typescript'), root = fileURLToPath(new URL('..', import.meta.url))
require.extensions['.ts'] = (m, f) => m._compile(ts.transpileModule(readFileSync(f, 'utf8').replaceAll('import.meta.env', '({})'), { fileName: f,
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText, f)
const { PublicKey, Keypair, Connection, VersionedTransaction } = require('@solana/web3.js'), { Buffer } = require('buffer')
const sol = require(root + 'src/lib/mainnetSolanaReclaim.ts'), { SOLANA_MAINNET_CCTP } = require(root + 'src/config/mainnetSolana.ts')
const { owner, nonce, zero, word, message, source, sc } = require('./fixtures/cctp-recovery.cjs')
globalThis.window = { localStorage: { getItem: () => null, setItem() {}, removeItem() {} }, dispatchEvent() {}, addEventListener() {}, removeEventListener() {} }
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { locks: { request: async (_n, _o, run) => run({}) } } })
// The reclaim reads the source transaction of a closed account through the same-origin proxy (history is
// not readable from browsers); plan.proxyTx controls that answer. Everything else is forbidden.
globalThis.fetch = async (input, init) => {
  if (String(input) === '/api/solana-rpc') {
    const { method, params } = JSON.parse(init.body); log.push(`proxy ${method}`)
    const result = method === 'getSignaturesForAddress' ? (plan.proxySigs ?? [])
      : method === 'getSignatureStatuses' ? { context: { slot: 1 }, value: [plan.proxyStatus ?? null] }
      : params[0] === 'source-signature' ? (plan.proxyTx === undefined ? creation : plan.proxyTx) : (plan.proxyReclaimTx ?? null)
    return Response.json({ jsonrpc: '2.0', id: 1, result })
  }
  throw new Error(`Network forbidden: ${String(input)}`)
}

const walletKey = Keypair.generate(), wallet = walletKey.publicKey, eventAccount = Keypair.generate().publicKey, program = new PublicKey(sc.messageTransmitterProgram)
const solWord = x => '0x' + new PublicKey(x).toBuffer().toString('hex')
const msg = extra => message({ src: 5, dst: 26, sender: solWord(sc.tokenMessengerMinterProgram), recipient: word(source.tokenMessengerAddress), caller: zero, burn: solWord(sc.usdcMint), mint: word(owner), from: solWord(wallet), ...extra })
const solMessage = msg({}), solSigned = msg({ nonce, executed: 2000 })
function account(age = 6 * 86400) {
  const data = Buffer.alloc(428); Buffer.from('83648538a6e1973c', 'hex').copy(data); wallet.toBuffer().copy(data, 8)
  data.writeBigInt64LE(BigInt(Math.floor(Date.now() / 1000) - age), 40); data.writeUInt32LE(376, 48); Buffer.from(solMessage.slice(2), 'hex').copy(data, 52)
  return { owner: program, lamports: 2000000, data }
}
const creation = { meta: { err: null, innerInstructions: [] }, transaction: { signatures: ['source-signature'], message: { accountKeys: [{ pubkey: eventAccount, signer: true }, { pubkey: wallet, signer: true }], instructions: [{ programId: program, accounts: [eventAccount, wallet] }] } } }
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
const kinds = { getAccountInfo: 'read', getSlot: 'read', getBlockTime: 'read', getLatestBlockhash: 'read', getRecentPrioritizationFees: 'read', getBalance: 'read', getSignatureStatuses: 'read', simulateTransaction: 'simulate', sendRawTransaction: 'send', confirmTransaction: 'confirm' }
const answers = {
  getAccountInfo: h => (plan[h] && 'info' in plan[h] ? plan[h].info : plan.info === undefined ? account() : plan.info),
  getSlot: () => 1, getBlockTime: () => Math.floor(Date.now() / 1000),
  getLatestBlockhash: () => ({ blockhash: '11111111111111111111111111111111', lastValidBlockHeight: 100 }),
  getRecentPrioritizationFees: () => [],
  getBalance: () => 10_000_000,
  getSignatureStatuses: () => ({ context: { slot: 1 }, value: [plan.status ?? null] }),
  // The signed bytes (VersionedTransaction) are re-simulated: a successful reclaim credits the deposit.
  simulateTransaction: (_h, tx) => tx instanceof VersionedTransaction
    ? { value: { err: plan.simErr ?? null, unitsConsumed: 150_000, accounts: [{ lamports: 10_000_000 + 2_000_000 }, null] } }
    : { value: { err: plan.simErr ?? null, unitsConsumed: 145_000 } }, sendRawTransaction: () => 'controlled-signature', confirmTransaction: () => ({ value: { err: plan.confirmErr ?? null } }),
}
for (const [name, kind] of Object.entries(kinds)) Connection.prototype[name] = async function (...args) {
  const h = host(this); log.push(`${h} ${name}`)
  if (name === 'sendRawTransaction') sent.push(Buffer.from(args[0]).toString('hex'))
  const e = plan[h]?.[kind]; if (e) throw e
  return answers[name](h, ...args)
}
// Browser-direct history reads fail on public RPCs (publicnode: no history, Foundation: 403 for browser origins).
Connection.prototype.getParsedTransaction = async function () { log.push(`${host(this)} getParsedTransaction`); throw new Error('direct history read is not allowed in reclaim') }
const run = (o = {}) => sol.reclaimMainnetSolanaDeposit({ connectedWallet: o.connected ?? wallet.toBase58(), originalWallet: wallet.toBase58(), metadata,
  provider: { signTransaction: async tx => { signs++; tx.partialSign(walletKey); return tx } } })
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
    assert.ok(log.includes('solana-rpc.publicnode.com getAccountInfo') && log.includes('api.mainnet.solana.com getAccountInfo'))
    assert.ok(log.includes('proxy getTransaction'), 'the source transaction is read through the proxy') })
await test('O. closed account whose source transaction no provider returns: refused, never alreadyClosed or reclaimed', { info: null, proxyTx: null },
  r => { assert.equal(r.ok, undefined); assert.match(r.error, /not available from the Solana RPC providers yet/); assert.equal(signs, 0) })
await test('P. closed account bound to a source transaction of another wallet or another signature: refused', { info: null,
  proxyTx: { ...creation, transaction: { ...creation.transaction, message: { ...creation.transaction.message, accountKeys: [{ pubkey: eventAccount.toBase58(), signer: true }, { pubkey: Keypair.generate().publicKey.toBase58(), signer: true }] } } } },
  r => { assert.match(r.error, /cannot be bound to a successful Circle source transaction/); assert.equal(signs, 0) })

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
// ---------------------------------------------------------------- a landed reclaim whose confirmation watcher missed it
await test('Q. confirmation watcher expires but the signature status shows the reclaim landed: reported as success, one signature',
  { 'solana-rpc.publicnode.com': { confirm: EXPIRED }, status: { confirmationStatus: 'finalized', err: null, slot: 9 } },
  r => { assert.deepEqual(r.ok, { txHash: 'controlled-signature', alreadyClosed: false }); assert.equal(signs, 1); assert.equal(sent.length, 1) })
await test('R. confirmation watcher expires and the status shows an on-chain failure: definite failure, not unknown, one signature',
  { 'solana-rpc.publicnode.com': { confirm: EXPIRED }, proxyStatus: { confirmationStatus: 'confirmed', err: { InstructionError: [4, { Custom: 1 }] } } },
  r => { assert.match(r.error, /reclaim transaction failed/); assert.doesNotMatch(r.error, /unknown/); assert.equal(signs, 1) })
await test('S. a "processed"-only status is not proof: still unknown, no second signature',
  { 'solana-rpc.publicnode.com': { confirm: EXPIRED }, status: { confirmationStatus: 'processed', err: null } },
  r => { assert.match(r.error, /confirmation is unknown/); assert.equal(signs, 1); assert.equal(sent.length, 1) })
// ---------------------------------------------------------------- closure proven by the payee's own reclaim (browser: no second RPC)
const reclaimTx = (o = {}) => ({ meta: { err: null, innerInstructions: [], logMessages: ['Program CCTPV2Sm4AdWt5296sk4P66VBZ7bEhcARwFaaS9YPbeC invoke [1]', 'Program log: Instruction: ReclaimEventAccount'], ...o.meta },
  transaction: { signatures: ['reclaim-signature'], message: { accountKeys: [{ pubkey: wallet.toBase58(), signer: true }, { pubkey: eventAccount.toBase58(), signer: false }],
    instructions: [{ programId: program.toBase58(), accounts: [wallet.toBase58(), 'mt-pda', eventAccount.toBase58()], data: 'x' }] }, ...o.transaction } })
const closedNoSecondRpc = extra => ({ info: null, 'api.mainnet.solana.com': { read: DOWN }, proxySigs: [{ signature: 'reclaim-signature', err: null }], ...extra })
await test('T. account closed, no second RPC: the payee\'s own successful ReclaimEventAccount proves closure (alreadyClosed, no signature)',
  closedNoSecondRpc({ proxyReclaimTx: reclaimTx() }), r => { assert.deepEqual(r.ok, { alreadyClosed: true }); assert.equal(signs, 0); assert.equal(sent.length, 0) })
await test('U. the closure proof refuses a failed, foreign-signed, other-account or non-reclaim transaction',
  closedNoSecondRpc({ proxyReclaimTx: reclaimTx({ meta: { err: { InstructionError: [0, { Custom: 1 }] } } }) }), r => { assert.match(r.error, /closure could not be confirmed/); assert.equal(signs, 0) })
for (const [name, tx] of [['foreign signer', reclaimTx({ transaction: { message: { accountKeys: [{ pubkey: Keypair.generate().publicKey.toBase58(), signer: true }], instructions: reclaimTx().transaction.message.instructions } } })],
  ['other event account', reclaimTx({ transaction: { message: { accountKeys: reclaimTx().transaction.message.accountKeys, instructions: [{ programId: program.toBase58(), accounts: [wallet.toBase58(), Keypair.generate().publicKey.toBase58()], data: 'x' }] } } })],
  ['no ReclaimEventAccount log', reclaimTx({ meta: { logMessages: ['Program log: Instruction: SendMessage'] } })],
  ['other signature returned', reclaimTx({ transaction: { signatures: ['different'] } })]])
  await test(`U. closure proof refused: ${name}`, closedNoSecondRpc({ proxyReclaimTx: tx }), r => { assert.match(r.error, /closure could not be confirmed/); assert.equal(signs, 0) })
console.log(`RESULT ${count}/${count} Solana reclaim RPC groups PASS; controlled providers, one Phantom signature at most; no network, wallet or transaction`)
