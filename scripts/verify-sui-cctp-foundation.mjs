// Offline SDK/balance boundary checks. NOT an end-to-end transfer or live wallet test.
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
const require = createRequire(import.meta.url), ts = require('typescript')
require.extensions['.ts'] = (m, p) => m._compile(ts.transpileModule(readFileSync(p, 'utf8').replace(/import\.meta\.env/g, '({})'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText, p)
const balance = require('../src/lib/suiBalances.ts'), config = require('../src/config/sui.ts')
const builders = require('../src/lib/suiCctpTransactions.ts'), v = require('viem')
const { bcs } = require('@mysten/sui/bcs')
const { owner, message, nonce, zero } = require('./fixtures/cctp-recovery.cjs')
const id = n => '0x' + n.toString(16).padStart(64, '0')
// Deliberately synthetic. None of these values is a Mainnet deployment claim.
const deployment = { mtPackage: id(10), mtState: id(11), tmmPackage: id(12), tmmState: id(13), handlerPackage: id(14), handlerState: id(15), treasury: id(16), mtOriginalPackage: id(17), tmmOriginalPackage: id(18), inboundAuthRecipient: v.keccak256(v.stringToHex(`${id(18).slice(2)}::message_transmitter_authenticator::MessageTransmitterAuthenticator`)) }
const sender = id(21), usdc = config.SUI_NETWORKS.mainnet.usdcCoinType
const burnInput = { sender, recipient: owner, amount: 1000000n, maxFee: 10n, gasBudget: 50000000n }
const mintInput = { sender, message: message({ dst: 8, recipient: deployment.inboundAuthRecipient, caller: sender, mint: sender, nonce, executed: 2000 }), attestation: '0x' + 'ab'.repeat(65), gasBudget: 50000000n }
let passed = 0
async function test(name, fn) { await fn(); passed++; console.log('PASS ' + name) }
function pure(data, command, arg, type) { const i = data.commands[command].MoveCall.arguments[arg].Input; return bcs[type]().parse(Buffer.from(data.inputs[i].Pure.bytes, 'base64')) }

await test('Mainnet and Testnet use distinct native USDC and explicit RPC networks', () => {
 assert.notEqual(config.SUI_NETWORKS.mainnet.usdcCoinType, config.SUI_NETWORKS.testnet.usdcCoinType)
 assert.equal(config.SUI_NETWORKS.mainnet.network, 'mainnet')
 assert.match(usdc, /^0xdba34672/)
 assert.equal(config.SUI_NETWORKS.mainnet.chainIdentifier, '4btiuiMPvEENsttpZC7CZ53DruC3MAgfznDbASZ7DR6S')
})
await test('controlled live test: writes open only together with the 0.1 USDC per-transaction cap', () => { assert.equal(config.MAINNET_SUI_CCTP_WRITES_ENABLED, true); assert.equal(config.MAINNET_ARC_WALLET_SEND_ENABLED, true); assert.equal(config.MAINNET_SUI_CCTP_TEST_MAX_UNITS, 100000n); assert.match(config.MAINNET_SUI_CCTP_BLOCKER, /at most 0\.1 USDC/); assert.match(config.MAINNET_SUI_CCTP_BLOCKER, /has not been proven/) })
await test('valid account explicitly supports the selected Sui network', () => { assert.equal(balance.validateSuiWalletAccount({ address: sender, chains: ['sui:mainnet'] }, 'mainnet'), sender) })
await test('wrong network, malformed and zero wallet addresses fail closed', () => { for (const a of [null, { address: sender, chains: ['sui:testnet'] }, { address: owner, chains: ['sui:mainnet'] }, { address: zero, chains: ['sui:mainnet'] }]) assert.throws(() => balance.validateSuiWalletAccount(a, 'mainnet')) })
await test('SIP-58 address-only USDC is retained with integer precision', () => { const x = balance.parseSuiBalance({ coinType: usdc, balance: '9007199254740993', coinBalance: '0', addressBalance: '9007199254740993' }, usdc); assert.equal(x.total, 9007199254740993n); assert.equal(x.coins, 0n) })
await test('Coin objects and address balances reconcile without double counting', () => { const x = balance.parseSuiBalance({ coinType: usdc, balance: '100', coinBalance: '40', addressBalance: '60' }, usdc); assert.equal(x.total, 100n) })
await test('wrong token, inconsistent sums and invalid integer encodings are rejected', () => { for (const x of [{ coinType: '0x2::sui::SUI', balance: '10', coinBalance: '10', addressBalance: '0' }, { coinType: usdc, balance: '10', coinBalance: '9', addressBalance: '0' }, ...['-1', '1.1', '01', '1e3', null].map(balance => ({ coinType: usdc, balance, coinBalance: '0', addressBalance: '0' }))]) assert.throws(() => balance.parseSuiBalance(x, usdc)) })
await test('gRPC balance reads verify full chain identity and separate USDC6/SUI9', async () => {
 const calls = [], client = { getChainIdentifier: async () => ({ chainIdentifier: config.SUI_NETWORKS.mainnet.chainIdentifier }), getBalance: async x => { calls.push(x); return { balance: { coinType: x.coinType, balance: '1000000000', coinBalance: '0', addressBalance: '1000000000' } } } }
 const x = await balance.readSuiWalletBalances(client, sender, 'mainnet'); assert.equal(x.usdcDisplay, '1000'); assert.equal(x.suiDisplay, '1'); assert.equal(calls.length, 2)
})
await test('wrong RPC network is blocked before any balance read', async () => { let reads = 0; await assert.rejects(() => balance.readSuiWalletBalances({ getChainIdentifier: async () => ({ chainIdentifier: config.SUI_NETWORKS.testnet.chainIdentifier }), getBalance: async () => { reads++; throw Error() } }, sender, 'mainnet')); assert.equal(reads, 0) })
await test('RPC failure is not returned as zero or an empty successful balance', async () => { await assert.rejects(() => balance.readSuiWalletBalances({ getChainIdentifier: async () => { throw Error('controlled outage') } }, sender, 'mainnet')) })
await test('real Mysten Transaction creates the exact atomic three-call burn sequence', () => {
 const d = builders.buildSuiToArcBurn(deployment, burnInput).getData()
 assert.equal(d.sender, sender); assert.equal(d.gasData.budget, '50000000')
 assert.equal(d.commands[0].$kind, '$Intent')
 const calls = d.commands.slice(1).map(x => `${x.MoveCall.package}::${x.MoveCall.module}::${x.MoveCall.function}`)
 assert.deepEqual(calls, [`${id(12)}::deposit_for_burn::deposit_for_burn`, `${id(14)}::handler::burn`, `${id(12)}::deposit_for_burn::complete_burn`])
 assert.equal(pure(d, 1, 1, 'u32'), 26); assert.equal(pure(d, 1, 5, 'u32'), 2000)
 assert.equal(BigInt(pure(d, 1, 4, 'u256')), 10n)
 assert.equal(d.commands[0].$Intent.data.balance, 1000000n)
})
await test('burn rejects invalid Arc recipient, zero, overflow and fee consuming input', () => { for (const change of [{ recipient: sender }, { recipient: '0x' + '00'.repeat(20) }, { amount: 0n }, { amount: 1n << 64n }, { maxFee: -1n }, { maxFee: 1000000n }]) assert.throws(() => builders.buildSuiToArcBurn(deployment, { ...burnInput, ...change })) })
await test('explicit positive gas budget and valid Sui sender are mandatory', () => { for (const change of [{ gasBudget: 0n }, { gasBudget: -1n }, { sender: owner }]) assert.throws(() => builders.buildSuiToArcBurn(deployment, { ...burnInput, ...change })) })
await test('missing/overlapping shared state and wrong original-package authenticator fail', () => { for (const change of [{ mtState: id(0) }, { mtState: deployment.tmmState }, { inboundAuthRecipient: id(90) }, { tmmOriginalPackage: id(90) }]) assert.throws(() => builders.buildSuiToArcBurn({ ...deployment, ...change }, burnInput)) })
await test('real Mysten Transaction creates all four receive/prepare/mint/complete calls', () => {
 const d = builders.buildArcToSuiMint(deployment, mintInput).getData()
 assert.deepEqual(d.commands.map(x => x.MoveCall.function), ['receive_message', 'prepare_mint', 'mint', 'complete_mint'])
 assert.equal(d.commands[0].MoveCall.package, deployment.mtPackage)
 assert.deepEqual(d.commands[1].MoveCall.typeArguments, [usdc])
 assert.equal(d.commands[3].MoveCall.typeArguments[1], `${deployment.handlerPackage}::handler::Auth`)
})
await test('wrong domains/recipient/caller, unassigned nonce and insufficient finality fail', () => { for (const over of [{ src: 0 }, { dst: 5 }, { mint: id(25) }, { caller: id(25) }, { recipient: id(25) }, { nonce: zero }, { min: 1000 }, { executed: 1000 }]) assert.throws(() => builders.buildArcToSuiMint(deployment, { ...mintInput, message: message({ dst: 8, recipient: deployment.inboundAuthRecipient, caller: sender, mint: sender, nonce, executed: 2000, ...over }) })) })
await test('foreign Arc messenger/token and altered fee economics fail', () => { for (const over of [{ sender: id(60) }, { burn: id(60) }, { fee: 101 }, { max: 100000 }, { amount: 1n << 64n }]) assert.throws(() => builders.buildArcToSuiMint(deployment, { ...mintInput, message: message({ dst: 8, recipient: deployment.inboundAuthRecipient, caller: sender, mint: sender, nonce, executed: 2000, ...over }) })) })
await test('malformed attestation and unsupported hook bytes fail', () => { for (const change of [{ attestation: 'PENDING' }, { attestation: '0xab' }, { message: mintInput.message + '00' }]) assert.throws(() => builders.buildArcToSuiMint(deployment, { ...mintInput, ...change })) })
console.log(`RESULT ${passed}/${passed} offline Sui foundation groups PASS; no RPC, wallet signatures, broadcasts or Mainnet deployment verification. End-to-end transfer/recovery remain BLOCKED.`)
