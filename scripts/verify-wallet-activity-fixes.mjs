import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import handler from '../api/arc-wallet-activity.js'

const require = createRequire(import.meta.url)
const Module = require('node:module')
const ts = require('typescript')
const originalRequire = Module.prototype.require
const { toFunctionSelector } = await import('viem')

require.extensions['.ts'] = (loadedModule, filename) => {
  const source = readFileSync(filename, 'utf8')
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
    fileName: filename,
  })
  loadedModule._compile(outputText, filename)
}

const earnConfigPath = fileURLToPath(new URL('../src/config/mainnetEarn.ts', import.meta.url))
const earnConfig = require(earnConfigPath)
const earnVaults = earnConfig.MAINNET_EARN_SELECTED_VAULT_ADDRESSES
const vaultMetadata = earnConfig.MAINNET_EARN_VAULT_METADATA
const cctpMessenger = '0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d'
const cctpTransmitter = '0x81D40F21F12A8F0E3252Bccb954D722d4c464B64'

function assertVaultMetadataInvariant(selectedAddresses, metadata) {
  const byAddress = new Set()
  for (const vault of metadata) {
    const key = vault.address.toLowerCase()
    if (byAddress.has(key)) throw new Error(`duplicate vault metadata address: ${vault.address}`)
    byAddress.add(key)
  }
  for (const address of selectedAddresses) {
    if (!byAddress.has(address.toLowerCase())) throw new Error(`missing selected vault metadata: ${address}`)
  }
}

assert.doesNotThrow(() => assertVaultMetadataInvariant(earnVaults, vaultMetadata))
assert.throws(
  () => assertVaultMetadataInvariant(earnVaults, [...vaultMetadata, { ...vaultMetadata[0], address: vaultMetadata[0].address.toLowerCase() }]),
  /duplicate vault metadata address/,
)
assert.throws(
  () => assertVaultMetadataInvariant(earnVaults, vaultMetadata.slice(1)),
  /missing selected vault metadata/,
)
const futureDropdownMetadata = [...vaultMetadata, {
  address: '0x9999999999999999999999999999999999999999',
  label: 'Future Curator USDC',
}]
assert.equal(
  earnConfig.getMainnetEarnVaultLabel(futureDropdownMetadata[2].address, futureDropdownMetadata),
  'Future Curator USDC',
)
assert.equal(earnConfig.getMainnetEarnVaultLabel('0x7777777777777777777777777777777777777777'), 'Earn vault')
console.log('Earn metadata fixtures passed: case insensitive selected address coverage; duplicate and missing entries fail; future dropdown label resolves by address')

const wallet = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const other = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
const txHash = `0x${'1'.repeat(64)}`
const decimalFixtures = [
  ['0', 0],
  ['6', 6],
  ['18', 18],
  ['', null],
  [null, null],
  [undefined, null],
  ['abc', null],
  ['-1', null],
]

const tokenRows = decimalFixtures.map(([tokenDecimal], index) => ({
  hash: `0x${String(index + 1).padStart(64, '0')}`,
  contractAddress: `0x${String(index + 1).padStart(40, '0')}`,
  from: wallet,
  to: other,
  value: '1000000',
  timeStamp: index === 0 ? '1700000100' : index === 1 ? '1700000100x' : undefined,
  confirmations: index === 0 ? '3' : index === 1 ? 4 : Number.MAX_SAFE_INTEGER + 1,
  tokenSymbol: 'FIX',
  ...(tokenDecimal === undefined ? {} : { tokenDecimal }),
}))

const originalFetch = globalThis.fetch
const originalApiKey = process.env.BLOCKSCOUT_PRO_API_KEY
process.env.BLOCKSCOUT_PRO_API_KEY = 'wallet-activity-fixture-key'
process.on('exit', () => {
  if (originalApiKey === undefined) delete process.env.BLOCKSCOUT_PRO_API_KEY
  else process.env.BLOCKSCOUT_PRO_API_KEY = originalApiKey
})
const blockAddress = hash => hash == null ? null : { hash }
const blockTransaction = row => ({
  hash: row.hash, timestamp: row.timeStamp, from: blockAddress(row.from), to: blockAddress(row.to), value: row.value,
  raw_input: row.input, block_number: 1,
  status: row.isError === '1' || row.txreceipt_status === '0' ? 'error' : row.isError === '0' || row.txreceipt_status === '1' ? 'ok' : null,
})
const blockTransfer = (row, log_index) => ({
  transaction_hash: row.hash, from: blockAddress(row.from), to: blockAddress(row.to),
  total: { value: row.value }, token: { address_hash: row.contractAddress, symbol: row.tokenSymbol, decimals: row.tokenDecimal, type: 'ERC-20' },
  timestamp: row.timeStamp, confirmations: row.confirmations, log_index,
})
const pageResponse = (items, next_page_params = null) => new Response(JSON.stringify({ items, next_page_params }), {
  headers: { 'content-type': 'application/json' },
})
globalThis.fetch = async (input) => {
  const transfers = new URL(String(input)).pathname.endsWith('/token-transfers')
  return pageResponse(transfers ? tokenRows.map(blockTransfer) : [])
}

const responseHeaders = {}
const response = {
  statusCode: 200,
  body: null,
  setHeader(name, value) {
    responseHeaders[name] = value
    return this
  },
  status(code) {
    this.statusCode = code
    return this
  },
  send(body) {
    this.body = body
    return this
  },
}

try {
  await handler({
    method: 'GET',
    query: { address: wallet, limit: 25 },
    headers: { 'x-vercel-forwarded-for': '192.0.2.10' },
  }, response)
} finally {
  globalThis.fetch = originalFetch
}

assert.equal(response.statusCode, 200)
const apiPayload = JSON.parse(response.body)
assert.deepEqual(apiPayload.tokenTransfers.map((row) => row.decimals), [0, 6, 18])
assert.equal(apiPayload.tokenTransfers[0].value, '1000000')
assert.equal(apiPayload.tokenTransfers[0].timeStamp, '1700000100')
assert.equal(apiPayload.tokenTransfers[1].timeStamp, null)
assert.deepEqual(apiPayload.tokenTransfers.map((row) => row.confirmations), ['3', '4', null])
console.log('tokenDecimal fixtures passed: valid 0/6/18 retained; empty/null/undefined/malformed/negative rejected')
console.log('token timestamp fixtures passed: digits-only value preserved; malformed value normalized to null')
console.log('token confirmations API fixtures passed: digit string and safe integer retained; unsafe integer normalized to null')

async function normalizeApiTransactions(transactionRows) {
  const previousFetch = globalThis.fetch
  globalThis.fetch = async input => pageResponse(new URL(String(input)).pathname.endsWith('/transactions') ? transactionRows.map(blockTransaction) : [])
  const apiResponse = {
    statusCode: 200,
    body: null,
    setHeader() { return this },
    status(code) { this.statusCode = code; return this },
    send(body) { this.body = body; return this },
  }
  try {
    await handler({ method: 'GET', query: { address: wallet, limit: 25 }, headers: { 'x-vercel-forwarded-for': '192.0.2.11' } }, apiResponse)
  } finally {
    globalThis.fetch = previousFetch
  }
  assert.equal(apiResponse.statusCode, 200)
  return JSON.parse(apiResponse.body)
}

Module.prototype.require = function (specifier) {
  if (this.filename.endsWith('/src/lib/mainnetWalletActivity.ts')) {
    if (specifier === 'viem') {
      return { toFunctionSelector }
    }
    if (specifier === '../config/mainnetCctp') {
      return {
        MAINNET_CCTP_MESSAGE_TRANSMITTER: cctpTransmitter,
        MAINNET_CCTP_TOKEN_MESSENGER: cctpMessenger,
      }
    }
    if (specifier === '../config/mainnetEarn') {
      return {
        MAINNET_EARN_SELECTED_VAULT_ADDRESSES: earnVaults,
        MAINNET_EARN_VAULT_METADATA: vaultMetadata,
      }
    }
    if (specifier === '../config/mainnet') {
      return { MAINNET_CONFIG: { arcUsdcAddress: '0x3600000000000000000000000000000000000000' } }
    }
  }
  return originalRequire.call(this, specifier)
}

const modulePath = fileURLToPath(new URL('../src/lib/mainnetWalletActivity.ts', import.meta.url))
const { normalizeWalletActivity } = require(modulePath)
Module.prototype.require = originalRequire

const tokenA = '0xcccccccccccccccccccccccccccccccccccccccc'
const tokenB = '0xdddddddddddddddddddddddddddddddddddddddd'
const arcUsdc = '0x3600000000000000000000000000000000000000'
const cctpDepositSelector = toFunctionSelector(
  'depositForBurn(uint256,uint32,bytes32,address,bytes32,uint256,uint32)',
)
const movement = (hash, contractAddress, from, to, decimals = 6, symbol = 'FIX', value = '1000000', confirmations = null) => ({
  hash,
  contractAddress,
  from,
  to,
  value,
  timeStamp: '1700000100',
  confirmations,
  symbol,
  decimals,
})
const transaction = (hash, to, input, from = wallet) => ({
  hash,
  timeStamp: '1700000000',
  from,
  to,
  value: '0',
  input,
  isError: '0',
  receiptStatus: '1',
})
const classificationFixtures = normalizeWalletActivity(wallet, {
  limit: 20,
  transactions: [
    transaction(`0x${'2'.repeat(64)}`, other, '0x38ed1739'),
    transaction(`0x${'3'.repeat(64)}`, earnVaults[0], '0x6e553f65'),
    transaction(`0x${'4'.repeat(64)}`, cctpMessenger, cctpDepositSelector),
    transaction(`0x${'5'.repeat(64)}`, tokenA, '0xa9059cbb'),
    transaction(`0x${'6'.repeat(64)}`, tokenB, '0xa9059cbb'),
    transaction(`0x${'8'.repeat(64)}`, other, '0x'),
  ],
  tokenTransfers: [
    movement(`0x${'2'.repeat(64)}`, tokenA, wallet, other),
    movement(`0x${'2'.repeat(64)}`, tokenB, other, wallet),
    movement(`0x${'3'.repeat(64)}`, arcUsdc, wallet, other, 6, 'USDC', '100000'),
    movement(`0x${'3'.repeat(64)}`, earnVaults[0], other, wallet, 18, 'arcUSDC', '100047248648048185'),
    movement(`0x${'4'.repeat(64)}`, tokenA, wallet, cctpMessenger),
    movement(`0x${'5'.repeat(64)}`, tokenA, wallet, other),
    movement(`0x${'6'.repeat(64)}`, tokenB, wallet, other, 0),
    movement(`0x${'7'.repeat(64)}`, tokenA, other, wallet),
    movement(`0x${'9'.repeat(64)}`, tokenA, other, wallet, 6, 'FIX', '1000000', '0'),
    movement(`0x${'9'.repeat(64)}`, tokenA, other, wallet, 6, 'FIX', '1000000', '2'),
    movement(`0x${'c'.repeat(64)}`, tokenA, other, wallet, 6, 'FIX', '1000000', 'malformed'),
    movement(`0x${'d'.repeat(64)}`, tokenA, other, wallet),
  ],
})
const orderedFixtures = normalizeWalletActivity(wallet, {
  limit: 2,
  transactions: [transaction(`0x${'a'.repeat(64)}`, other, '0x')],
  tokenTransfers: [movement(`0x${'b'.repeat(64)}`, tokenA, other, wallet)],
})
const byHash = new Map(classificationFixtures.map((item) => [item.txHash, item]))
assert.equal(byHash.get(`0x${'2'.repeat(64)}`).type, 'interaction', 'unverified selector target must not be Swap')
assert.equal(byHash.get(`0x${'3'.repeat(64)}`).type, 'earn', 'configured vault classification must remain')
assert.equal(byHash.get(`0x${'4'.repeat(64)}`).type, 'bridge', 'known CCTP classification must remain')
assert.equal(byHash.get(`0x${'5'.repeat(64)}`).type, 'send', 'outgoing token transfer must remain Send')
assert.equal(byHash.get(`0x${'6'.repeat(64)}`).amount, '−1,000,000 FIX', 'zero-decimal amount must remain unscaled and directional')
assert.equal(byHash.get(`0x${'7'.repeat(64)}`).type, 'receive', 'incoming-only token transfer must remain Receive')
assert.equal(byHash.get(`0x${'9'.repeat(64)}`).type, 'receive', 'incoming-only token transfer must remain Receive')
assert.equal(byHash.get(`0x${'9'.repeat(64)}`).timestamp, 1700000100 * 1000)
assert.equal(byHash.get(`0x${'9'.repeat(64)}`).status, 'Confirmed', 'any valid positive transfer confirmation confirms token-only activity')
assert.equal(byHash.get(`0x${'c'.repeat(64)}`).status, 'Unknown', 'malformed confirmations must not change conservative token-only status')
assert.equal(byHash.get(`0x${'d'.repeat(64)}`).status, 'Unknown', 'missing confirmations must not change conservative token-only status')
assert.equal(orderedFixtures[0].txHash, `0x${'b'.repeat(64)}`, 'newer token-only activity must sort ahead of an older normal transaction')
assert.equal(orderedFixtures[0].timestamp, 1700000100 * 1000)
assert.equal(orderedFixtures[0].status, 'Unknown', 'missing token-only confirmations remain Unknown')
console.log('token-only fixtures passed: newer incoming Receive sorts first; any related positive confirmation gives Confirmed; malformed/missing remain Unknown')

const approvalSelector = toFunctionSelector('approve(address,uint256)')
const spender = '0x7fb8c7260b63934d8da38af902f87ae6e284a845'
const futureVaultAddress = '0x9999999999999999999999999999999999999999'
const futureVault = { address: futureVaultAddress, label: 'Future Curator USDC', shareSymbol: 'fUSDC', shareDecimals: 18 }
const unverifiedVaultAddress = '0x8888888888888888888888888888888888888888'
const unverifiedVault = { address: unverifiedVaultAddress, label: 'Unverified Vault' }
const extendedVaultMetadata = [...vaultMetadata, futureVault, unverifiedVault]
const addressWord = (address) => address.slice(2).toLowerCase().padStart(64, '0')
const amountWord = (amount) => BigInt(amount).toString(16).padStart(64, '0')
const approveInput = (token, amount) => `${approvalSelector}${addressWord(token)}${amountWord(amount)}`
const approvalCases = [
  { hash: `0x${'a'.repeat(64)}`, to: earnVaults[0], input: approveInput(spender, '100047248648048185') },
  { hash: `0x${'b'.repeat(64)}`, to: earnVaults[1], input: approveInput(spender, '99975421462314666') },
  { hash: `0x${'c'.repeat(64)}`, to: arcUsdc, input: approveInput(spender, '100000') },
  { hash: `0x${'d'.repeat(64)}`, to: tokenA, input: approveInput(spender, '1000000') },
  { hash: `0x${'e'.repeat(64)}`, to: earnVaults[0], input: `${approvalSelector}${'1'}${'0'.repeat(63)}${amountWord('1000000')}` },
  { hash: `0x${'f'.repeat(64)}`, to: arcUsdc, input: approveInput(spender, (2n ** 256n - 1n).toString()) },
  { hash: `0x${'0'.repeat(64)}`, to: arcUsdc, input: `${approvalSelector}${'a'.repeat(100_000)}` },
  { hash: `0x${'9'.repeat(64)}`, to: futureVaultAddress, input: approveInput(spender, '250000000000000000') },
  { hash: `0x${'8'.repeat(64)}`, to: unverifiedVaultAddress, input: approveInput(spender, '500000000000000000') },
]
const normalizedApprovalPayload = await normalizeApiTransactions(approvalCases.map((item) => ({
  ...item,
  from: wallet,
  timeStamp: '1700000200',
  value: '0',
  isError: '0',
  txreceipt_status: '1',
})))
assert.equal(normalizedApprovalPayload.transactions[0].approval.spender, spender)
assert.equal(normalizedApprovalPayload.transactions[0].approval.amount, '100047248648048185')
assert.equal(normalizedApprovalPayload.transactions[4].approval, null, 'malformed spender padding must not decode')
assert.equal(normalizedApprovalPayload.transactions[5].approval.amount, (2n ** 256n - 1n).toString(), 'uint256 max must survive as a decimal string')
assert.equal(normalizedApprovalPayload.transactions[6].input, approvalSelector)
assert.equal(normalizedApprovalPayload.transactions[6].approval, null)
assert.doesNotMatch(JSON.stringify(normalizedApprovalPayload.transactions[6]), /a{1000}/, 'large calldata must not reach the browser response')
const approvalActivities = normalizeWalletActivity(wallet, {
  transactions: normalizedApprovalPayload.transactions,
  tokenTransfers: [],
  limit: 20,
}, extendedVaultMetadata)
const approvalsByHash = new Map(approvalActivities.map((item) => [item.txHash, item]))
assert.equal(approvalsByHash.get(approvalCases[0].hash).title, 'Earn approval · Galaxy USDC')
assert.equal(approvalsByHash.get(approvalCases[0].hash).amount, 'Limit 0.100047 arcUSDC')
assert.equal(approvalsByHash.get(approvalCases[0].hash).approvalAmountRaw, '100047248648048185')
assert.equal(approvalsByHash.get(approvalCases[1].hash).title, 'Earn approval · Gauntlet USDC Prime')
assert.equal(approvalsByHash.get(approvalCases[1].hash).amount, 'Limit 0.099975 gtusdcp')
assert.equal(approvalsByHash.get(approvalCases[1].hash).approvalAmountRaw, '99975421462314666')
assert.equal(approvalsByHash.get(approvalCases[2].hash).title, 'Token approval')
assert.equal(approvalsByHash.get(approvalCases[2].hash).amount, 'Limit 0.1 USDC')
assert.equal(approvalsByHash.get(approvalCases[3].hash).title, 'Token approval')
assert.equal(approvalsByHash.get(approvalCases[3].hash).amount, null, 'unknown approval token must not receive a fabricated amount')
assert.equal(approvalsByHash.get(approvalCases[4].hash).amount, null, 'malformed approval calldata must not create an amount')
assert.ok(approvalsByHash.get(approvalCases[5].hash).amount.startsWith('Limit 115,792,089'))
assert.ok(approvalsByHash.get(approvalCases[5].hash).amount.endsWith('.639935 USDC'))
assert.equal(approvalsByHash.get(approvalCases[7].hash).title, 'Earn approval · Future Curator USDC')
assert.equal(approvalsByHash.get(approvalCases[7].hash).amount, 'Limit 0.25 fUSDC')
assert.equal(approvalsByHash.get(approvalCases[7].hash).approvalAmountRaw, '250000000000000000')
assert.equal(approvalsByHash.get(approvalCases[8].hash).title, 'Earn approval · Unverified Vault')
assert.equal(approvalsByHash.get(approvalCases[8].hash).amount, null, 'unverified share metadata must not produce a formatted amount')
console.log('approval fixtures passed: six digit display, exact raw preservation, metadata driven labels, unknown/malformed omission, uint256 max stays bigint safe')

const earnAndDirectionHash = (digit) => `0x${digit.repeat(64)}`
const earnScenarios = [
  { hash: earnAndDirectionHash('1'), vault: earnVaults[0], label: 'Galaxy USDC', verb: 'deposit', walletUsdc: true, walletShares: false, rawUsdc: '100000', rawShares: '100047248648048185', expected: '−0.1 USDC' },
  { hash: earnAndDirectionHash('2'), vault: earnVaults[0], label: 'Galaxy USDC', verb: 'withdrawal', walletUsdc: false, walletShares: true, rawUsdc: '100000', rawShares: '100047248648048185', expected: '+0.1 USDC' },
  { hash: earnAndDirectionHash('3'), vault: earnVaults[1], label: 'Gauntlet USDC Prime', verb: 'deposit', walletUsdc: true, walletShares: false, rawUsdc: '200000', rawShares: '200000000000000000', expected: '−0.2 USDC' },
  { hash: earnAndDirectionHash('4'), vault: earnVaults[1], label: 'Gauntlet USDC Prime', verb: 'withdrawal', walletUsdc: false, walletShares: true, rawUsdc: '200000', rawShares: '200000000000000000', expected: '+0.2 USDC' },
]
const earnActivities = normalizeWalletActivity(wallet, {
  limit: 20,
  transactions: earnScenarios.map(({ hash }) => transaction(hash, other, '0x12345678')),
  tokenTransfers: earnScenarios.flatMap((item) => [
    movement(item.hash, arcUsdc, item.walletUsdc ? wallet : other, item.walletUsdc ? other : wallet, 6, 'USDC', item.rawUsdc),
    movement(item.hash, item.vault, item.walletShares ? wallet : other, item.walletShares ? other : wallet, 18, item.vault === earnVaults[0] ? 'arcUSDC' : 'gtusdcp', item.rawShares),
  ]),
})
const earnByHash = new Map(earnActivities.map((item) => [item.txHash, item]))
for (const scenario of earnScenarios) {
  const activity = earnByHash.get(scenario.hash)
  assert.equal(activity.type, 'earn')
  assert.equal(activity.title, `Earn ${scenario.verb} · ${scenario.label}`)
  assert.equal(activity.amount, scenario.expected, `${scenario.label} ${scenario.verb} must display underlying USDC direction`)
}
const futureEarnScenarios = [
  { hash: earnAndDirectionHash('a'), verb: 'deposit', walletUsdc: true, walletShares: false },
  { hash: earnAndDirectionHash('b'), verb: 'withdrawal', walletUsdc: false, walletShares: true },
]
const futureEarnActivities = normalizeWalletActivity(wallet, {
  limit: 20,
  transactions: futureEarnScenarios.map(({ hash }) => transaction(hash, other, '0x12345678')),
  tokenTransfers: futureEarnScenarios.flatMap((scenario) => [
    movement(scenario.hash, arcUsdc, scenario.walletUsdc ? wallet : other, scenario.walletUsdc ? other : wallet, 6, 'USDC', '125000'),
    movement(scenario.hash, futureVaultAddress, scenario.walletShares ? wallet : other, scenario.walletShares ? other : wallet, 18, 'fUSDC', '125000000000000000'),
  ]),
}, extendedVaultMetadata)
for (const scenario of futureEarnScenarios) {
  const activity = futureEarnActivities.find((item) => item.txHash === scenario.hash)
  assert.equal(activity.type, 'earn')
  assert.equal(activity.title, `Earn ${scenario.verb} · Future Curator USDC`)
  assert.equal(activity.amount, scenario.verb === 'deposit' ? '−0.125 USDC' : '+0.125 USDC')
}

const cctpOutHash = earnAndDirectionHash('5')
const cctpInHash = earnAndDirectionHash('6')
const sendHash = earnAndDirectionHash('7')
const receiveHash = earnAndDirectionHash('8')
const semanticActivities = normalizeWalletActivity(wallet, {
  limit: 20,
  transactions: [
    transaction(cctpOutHash, cctpMessenger, cctpDepositSelector),
    transaction(cctpInHash, cctpTransmitter, toFunctionSelector('receiveMessage(bytes,bytes)'), other),
    transaction(sendHash, arcUsdc, '0xa9059cbb'),
    transaction(receiveHash, arcUsdc, '0xa9059cbb', other),
  ],
  tokenTransfers: [
    movement(cctpOutHash, arcUsdc, wallet, cctpMessenger, 6, 'USDC', '100000'),
    movement(cctpInHash, arcUsdc, other, wallet, 6, 'USDC', '99997'),
    movement(sendHash, arcUsdc, wallet, other, 6, 'USDC', '300000'),
    movement(receiveHash, arcUsdc, other, wallet, 6, 'USDC', '531197'),
  ],
})
const semanticByHash = new Map(semanticActivities.map((item) => [item.txHash, item]))
assert.equal(semanticByHash.get(cctpOutHash).amount, '−0.1 USDC')
assert.equal(semanticByHash.get(cctpInHash).amount, '+0.099997 USDC')
assert.equal(semanticByHash.get(sendHash).amount, '−0.3 USDC')
assert.equal(semanticByHash.get(receiveHash).amount, '+0.531197 USDC')
assert.equal(earnByHash.get(earnScenarios[0].hash).type, 'earn', 'paired vault movements must never become Swap')
console.log('Earn and amount fixtures passed: Galaxy/Gauntlet deposit and withdrawal, signed underlying USDC, CCTP direction, Send/Receive, no generic Swap')
console.log('legacy classification fixtures passed: unknown swap target remains interaction; zero-decimal token amount remains unscaled')

const dashboardSource = readFileSync(
  fileURLToPath(new URL('../src/components/MainnetWalletActivity.tsx', import.meta.url)),
  'utf8',
)
assert.match(dashboardSource, /requestId === walletActivityRequestId\.current/)
assert.match(dashboardSource, /walletActivityAddressRef\.current === addressIdentity/)
assert.match(dashboardSource, /!controller\.signal\.aborted/)
assert.match(dashboardSource, /onClick=\{\(\) => address && void loadWalletActivity\(address\)\}/)
assert.match(dashboardSource, /const visibleWalletActivity = walletActivityDataAddress === walletActivityAddress/)
assert.match(dashboardSource, /item\.status !== 'Unknown'/)
assert.match(dashboardSource, /!item\.title\.includes\(item\.protocol\)/, 'a title that contains its protocol or vault label must not repeat it below')
assert.doesNotMatch(dashboardSource, /max-h-\[|overflow-y-auto/)
const appSource = readFileSync(fileURLToPath(new URL('../src/App.tsx', import.meta.url)), 'utf8')
assert.match(appSource, /id: 'activity' as const, label: 'Activity'/)
assert.match(appSource, /activeTab === 'activity'\s*\? <MainnetWalletActivity \/>/)
const mainnetDashboardSource = readFileSync(
  fileURLToPath(new URL('../src/components/MainnetDashboard.tsx', import.meta.url)),
  'utf8',
)
assert.doesNotMatch(mainnetDashboardSource, /Wallet Activity/)
const earnActionsSource = readFileSync(
  fileURLToPath(new URL('../src/components/MainnetEarnActions.tsx', import.meta.url)),
  'utf8',
)
assert.match(earnActionsSource, /getMainnetEarnVaultLabel\(vaultAddress\)/)
assert.match(earnActionsSource, /getMainnetEarnVaultLabel\(reviewed\.vaultAddress\)/)
assert.doesNotMatch(earnActionsSource, /GALAXY_ADDRESS|Gauntlet USDC Prime/)
const withdrawalReviewSource = earnActionsSource.slice(
  earnActionsSource.indexOf('const reviewWithdrawal'),
  earnActionsSource.indexOf('const executeWithdrawal'),
)
assert.ok(withdrawalReviewSource.indexOf('await readPosition()') < withdrawalReviewSource.indexOf('earnKit.getWithdrawalQuote'))
const withdrawalExecutionSource = earnActionsSource.slice(earnActionsSource.indexOf('const executeWithdrawal'))
assert.ok(withdrawalExecutionSource.indexOf('await readPosition()') < withdrawalExecutionSource.indexOf('earnKit.withdraw'))
const earnPreviewSource = readFileSync(
  fileURLToPath(new URL('../src/components/MainnetEarnPreview.tsx', import.meta.url)),
  'utf8',
)
assert.match(earnPreviewSource, />Withdrawal<\/p>/)
assert.match(earnPreviewSource, />Checked at review<\/p>/)
assert.match(earnPreviewSource, /Compare current rates across selected vaults\./)
assert.doesNotMatch(earnPreviewSource, /available liquidity|withdrawable liquidity/i)
assert.match(earnPreviewSource, /Liquidity may be limited/)
assert.match(earnPreviewSource, /isZeroLiquidity\(vault\.liquidityProfile\?\.available \?\? vault\.liquidity\)/)
assert.doesNotMatch(earnPreviewSource, /formatUsdc\(vault\.liquidityProfile\?\.available \?\? vault\.liquidity\)/)
console.log('request lifecycle guards passed: generation, wallet identity, abort, manual refresh, and address-scoped rendering')
console.log('Activity navigation and UI fixtures passed: mainnet tab, no Dashboard card, hidden Unknown badge, normal page scrolling')
console.log('Earn UI fixtures passed: metadata driven dropdown labels; withdrawal flow order unchanged; Withdrawal/Checked at review copy and conditional liquidity note')

// Blockscout contract regressions: synthetic identities, in-memory Responses, no live requests or credentials.
let blockscoutChecks = 0
let clientSequence = 20
const hashOf = number => `0x${number.toString(16).padStart(64, '0')}`
const ARC_NATIVE_SENTINEL = '0xfffffffffffffffffffffffffffffffffffffffe'
const blockTx = (number, overrides = {}) => ({
  hash: hashOf(number), from: { hash: wallet }, to: { hash: other }, value: '0', raw_input: '0x',
  timestamp: '2026-10-01T12:00:00.000Z', block_number: 123, status: 'ok', ...overrides,
})
const blockToken = (number, overrides = {}) => ({
  transaction_hash: hashOf(number), from: { hash: other }, to: { hash: wallet }, log_index: 0,
  total: { value: '1000000', decimals: '6' }, token: { address_hash: tokenA, symbol: 'FIX', decimals: '6', type: 'ERC-20' },
  timestamp: '2026-10-01T12:01:00Z', confirmations: '3', ...overrides,
})
async function checkBlockscout(name, work) {
  await work()
  blockscoutChecks += 1
  console.log(`PASS Blockscout ${name}`)
}
async function apiCall(fetchImpl, { method = 'GET', query = { address: wallet, limit: '30' }, client } = {}) {
  const saved = globalThis.fetch
  const calls = [], headers = {}
  const result = { statusCode: null, body: null,
    setHeader(name, value) { headers[name] = value; return this },
    status(code) { this.statusCode = code; return this }, send(body) { this.body = JSON.parse(body); return this } }
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init })
    assert.ok(fetchImpl, 'rejected requests must not fetch')
    return fetchImpl(new URL(String(url)), init)
  }
  try {
    await handler({ method, query, headers: { 'x-vercel-forwarded-for': client ?? `192.0.2.${clientSequence++}` } }, result)
  } finally { globalThis.fetch = saved }
  assert.equal(headers['Cache-Control'], 'no-store')
  assert.equal(headers['Content-Type'], 'application/json; charset=utf-8')
  return { ...result, headers, calls }
}
const feeds = (transactions = [], transfers = []) => async url => pageResponse(url.pathname.endsWith('/transactions') ? transactions : transfers)

await checkBlockscout('nested addresses timestamp status and server-only Authorization preserve the public contract', async () => {
  const res = await apiCall(feeds([blockTx(1001, { value: '1000000000000000000' }), blockTx(1002, { status: 'error' }),
    blockTx(1003, { block_number: null, timestamp: null, status: null })]))
  assert.equal(res.statusCode, 200)
  assert.deepEqual(Object.keys(res.body).sort(), ['limit', 'tokenTransfers', 'transactions'])
  assert.deepEqual(Object.keys(res.body.transactions[0]).sort(), ['approval', 'from', 'hash', 'input', 'isError', 'receiptStatus', 'timeStamp', 'to', 'value'])
  const rows = new Map(normalizeWalletActivity(wallet, res.body).map(row => [row.txHash, row]))
  assert.equal(rows.get(hashOf(1001)).status, 'Confirmed')
  assert.equal(rows.get(hashOf(1001)).amount, '−1 USDC')
  assert.equal(rows.get(hashOf(1001)).timestamp, Date.parse('2026-10-01T12:00:00Z'))
  assert.equal(rows.get(hashOf(1002)).status, 'Failed')
  assert.equal(rows.get(hashOf(1002)).amount, null)
  assert.equal(rows.get(hashOf(1003)).status, 'Unknown')
  for (const call of res.calls) {
    const url = new URL(call.url)
    assert.equal(url.origin, 'https://api.blockscout.com')
    assert.match(url.pathname, /^\/5042\/api\/v2\/addresses\/0x[a-f0-9]{40}\/(transactions|token-transfers)$/)
    assert.equal(url.search, '')
    assert.equal(call.init.headers.Authorization, 'Bearer wallet-activity-fixture-key')
    assert.equal(call.init.redirect, 'error')
    assert.equal(call.init.method, 'GET')
  }
  assert.doesNotMatch(JSON.stringify(res.body), /fixture-key|Authorization|raw_input/)
})

await checkBlockscout('transaction_hash transfers and exact amounts join their transaction without duplicate activity', async () => {
  const res = await apiCall(feeds([blockTx(1100, { to: { hash: tokenA }, raw_input: '0xa9059cbb' })], [blockToken(1100, {
    from: { hash: wallet }, to: { hash: other }, total: { value: '12345678901234567890', decimals: '6' },
  }), blockToken(1101)]))
  const rows = normalizeWalletActivity(wallet, res.body)
  assert.equal(rows.length, 2)
  assert.equal(rows.find(row => row.txHash === hashOf(1100)).amount, '−12,345,678,901,234.56789 FIX')
  assert.equal(rows.find(row => row.txHash === hashOf(1101)).amount, '+1 FIX')
  assert.equal(rows.find(row => row.txHash === hashOf(1101)).status, 'Confirmed')
  assert.deepEqual(Object.keys(res.body.tokenTransfers[0]).sort(), ['confirmations', 'contractAddress', 'decimals', 'from', 'hash', 'symbol', 'timeStamp', 'to', 'value'])
})

await checkBlockscout('approval calldata and paired Earn movements retain existing classification', async () => {
  const res = await apiCall(feeds([blockTx(1200, { to: { hash: arcUsdc }, raw_input: approveInput(spender, '2500000') }), blockTx(1201)], [
    blockToken(1201, { from: { hash: wallet }, to: { hash: other }, token: { address_hash: arcUsdc, type: 'ERC-20', symbol: 'USDC', decimals: '6' } }),
    blockToken(1201, { log_index: 1, total: { value: '1000000000000000000', decimals: '18' },
      token: { address_hash: earnVaults[0], type: 'ERC-20', symbol: 'arcUSDC', decimals: '18' } }),
  ]))
  const rows = normalizeWalletActivity(wallet, res.body)
  assert.equal(rows.find(row => row.txHash === hashOf(1200)).amount, 'Limit 2.5 USDC')
  assert.equal(rows.find(row => row.txHash === hashOf(1200)).approvalAmountRaw, '2500000')
  assert.equal(rows.find(row => row.txHash === hashOf(1201)).title, 'Earn deposit · Galaxy USDC')
  assert.equal(rows.find(row => row.txHash === hashOf(1201)).amount, '−1 USDC')
})

await checkBlockscout('empty account stays empty; missing status or confirmations never invent confirmation', async () => {
  const empty = await apiCall(feeds())
  assert.equal(empty.statusCode, 200)
  assert.deepEqual(empty.body, { transactions: [], tokenTransfers: [], limit: 30 })
  const res = await apiCall(feeds([blockTx(1300, { status: null }), blockTx(1301, { status: 'ok', block_number: null })], [
    blockToken(1302, { confirmations: undefined, block_number: 123, block_hash: hashOf(77) }),
    blockToken(1303, { confirmations: '0' }),
  ]))
  assert.ok(normalizeWalletActivity(wallet, res.body).every(row => row.status === 'Unknown'))
})

await checkBlockscout('malformed identities decimals integers NFTs and unrelated rows are not exposed as valid amounts', async () => {
  const transfer = blockToken(1400)
  const bad = [
    { ...transfer, transaction_hash: 'invalid' }, { ...transfer, from: { hash: 'bad' } },
    { ...transfer, total: { value: '-1' } }, { ...transfer, total: { value: Number.MAX_SAFE_INTEGER + 1 } },
    { ...transfer, total: { value: '1', decimals: '18' } }, { ...transfer, token: { ...transfer.token, decimals: 'unknown' } },
    { ...transfer, token: { ...transfer.token, address_hash: ARC_NATIVE_SENTINEL } },
    { ...transfer, token: { ...transfer.token, type: 'ERC-721' } }, { ...transfer, token: { ...transfer.token, symbol: '<svg>' } },
    { ...transfer, from: { hash: tokenA }, to: { hash: tokenB } }, { ...transfer, log_index: -1 },
  ]
  const res = await apiCall(feeds([blockTx(1401, { value: 'bad' }), blockTx(1402, { from: { hash: 'bad' } }),
    blockTx(1403, { raw_input: '0xa9059cbbZZ', value: '1' }), blockTx(1404, { from: { hash: tokenA }, to: { hash: tokenB } })], bad))
  assert.equal(res.statusCode, 200)
  assert.deepEqual(res.body.transactions, [])
  assert.deepEqual(res.body.tokenTransfers, [])
  const conflict = await apiCall(feeds([], [transfer, { ...transfer, log_index: 1, total: { value: 'bad' } }]))
  assert.deepEqual(conflict.body.tokenTransfers, [], 'a malformed ERC20 leg must not leave a misleading partial aggregate')
  const missingType = await apiCall(feeds([], [transfer, { ...transfer, log_index: 1, token: { ...transfer.token, type: undefined } }]))
  assert.deepEqual(missingType.body.tokenTransfers, [], 'a malformed token record cannot be treated as an unrelated NFT')
  const badParent = await apiCall(feeds([blockTx(1400, { value: 'bad' })], [transfer]))
  assert.deepEqual(badParent.body.tokenTransfers, [], 'invalid transaction evidence must not reappear as a confirmed token-only row')
})

await checkBlockscout('UTC fractional timestamps are seconds, invalid calendars are not fabricated, contract creation stays supported', async () => {
  const res = await apiCall(feeds([blockTx(1500, { timestamp: '2026-10-01T12:00:00.123456Z', to: null }),
    blockTx(1501, { timestamp: '2026-02-30T12:00:00Z' }), blockTx(1502, { raw_input: undefined, value: '1000000' })]))
  const byHash = new Map(res.body.transactions.map(row => [row.hash, row]))
  assert.equal(byHash.get(hashOf(1500)).to, null)
  assert.equal(byHash.get(hashOf(1500)).timeStamp, String(Date.parse('2026-10-01T12:00:00Z') / 1000))
  assert.equal(byHash.get(hashOf(1501)).timeStamp, null)
  assert.equal(byHash.get(hashOf(1501)).receiptStatus, '')
  assert.equal(normalizeWalletActivity(wallet, res.body).find(row => row.txHash === hashOf(1502)).type, 'interaction')
})

await checkBlockscout('bounded cursor pagination deduplicates events across pages and retains distinct same-amount logs', async () => {
  const res = await apiCall(async url => {
    if (url.pathname.endsWith('/transactions')) return pageResponse([blockTx(1600, { to: { hash: tokenA }, raw_input: '0xa9059cbb' })])
    if (!url.search) return pageResponse([blockToken(1600, { from: { hash: wallet }, to: { hash: other } }),
      blockToken(1600, { from: { hash: wallet }, to: { hash: other }, log_index: 1 })], { block_number: 123, index: 1, items_count: 50, batch_block_hash: null })
    assert.equal(url.searchParams.get('block_number'), '123')
    return pageResponse([blockToken(1600, { from: { hash: wallet }, to: { hash: other }, log_index: 1 }),
      blockToken(1600, { from: { hash: wallet }, to: { hash: other }, log_index: 2 }), blockToken(1601)])
  })
  assert.equal(res.statusCode, 200)
  assert.equal(res.calls.length, 3)
  assert.equal(res.body.tokenTransfers.filter(row => row.hash === hashOf(1600)).length, 3)
  assert.equal(normalizeWalletActivity(wallet, res.body).find(row => row.txHash === hashOf(1600)).amount, '−3 FIX')
})

await checkBlockscout('at most four HTTP reads and 100 raw rows per feed; a cut transfer group is not summed', async () => {
  const res = await apiCall(async url => {
    const second = Boolean(url.search), first = second ? 51 : 1
    const rows = url.pathname.endsWith('/transactions') ? Array.from({ length: 50 }, (_, i) => blockTx(1700 + first + i))
      : Array.from({ length: 50 }, (_, i) => blockToken(1999, { log_index: first + i }))
    return pageResponse(rows, { block_number: second ? 100 : 123, index: 1, items_count: 50 })
  })
  assert.equal(res.statusCode, 200)
  assert.equal(res.calls.length, 4)
  assert.equal(res.body.tokenTransfers.length, 0, 'the boundary transaction has more logs: no partial amount')
  assert.equal(res.body.transactions.length, 30)
  assert.equal(normalizeWalletActivity(wallet, res.body).length, 30)
})

await checkBlockscout('observed six-field transaction and two-field transfer cursors retain exact decimals and microseconds across 50-row pages', async () => {
  const timestamp = '2026-10-18T18:38:59.000000Z'
  const transactionCursor = { index: 49, value: '542090165354999999092', hash: hashOf(3049),
    inserted_at: '2026-10-18T18:38:59.123456Z', block_number: 123, fee: '12345678901234567890.000000001' }
  const transferCursor = { index: 49, block_number: 123 }
  const amount = '542090165354999999092'
  const res = await apiCall(async url => {
    const transactions = url.pathname.endsWith('/transactions')
    const second = Boolean(url.search)
    const cursor = transactions ? transactionCursor : transferCursor
    if (second) assert.deepEqual(Object.fromEntries(url.searchParams),
      Object.fromEntries(Object.entries(cursor).map(([key, value]) => [key, String(value)])), 'cursor values are not rounded or converted to seconds')
    const items = Array.from({ length: 50 }, (_, index) => {
      if (!transactions) return blockToken(3000, { from: { hash: wallet }, to: { hash: other }, log_index: index + (second ? 50 : 0),
        timestamp, total: { decimals: '18', ui_multiplier: null, value: amount },
        token: { address_hash: tokenA, type: 'ERC-20', decimals: '18', symbol: 'FIX' } })
      const number = 3000 + index + (second ? 50 : 0)
      return blockTx(number, { timestamp, to: { hash: number === 3003 ? arcUsdc : tokenA },
        raw_input: number === 3003 ? approveInput(spender, '2500000') : '0xa9059cbb', status: number === 3002 ? 'error' : 'ok' })
    })
    return pageResponse(items, second ? null : cursor)
  })
  assert.equal(res.statusCode, 200)
  assert.equal(res.calls.length, 4)
  assert.equal(res.body.transactions.length, 30)
  assert.equal(res.body.tokenTransfers.length, 100, 'all 100 related logs survive; the 30 limit counts transactions, not their legs')
  for (const transfer of res.body.tokenTransfers) {
    assert.equal(transfer.hash, hashOf(3000))
    assert.equal(transfer.value, amount)
    assert.equal(transfer.decimals, 18)
    assert.equal(transfer.timeStamp, String(Date.parse(timestamp) / 1000))
  }
  const rows = new Map(normalizeWalletActivity(wallet, res.body).map(row => [row.txHash, row]))
  assert.equal(rows.size, 30)
  assert.equal(rows.get(hashOf(3000)).amount, '−54,209.016535 FIX')
  assert.equal(rows.get(hashOf(3000)).status, 'Confirmed')
  assert.equal(rows.get(hashOf(3002)).status, 'Failed')
  assert.equal(rows.get(hashOf(3002)).amount, null)
  assert.equal(rows.get(hashOf(3003)).amount, 'Limit 2.5 USDC')
})

await checkBlockscout('shared 30-transaction cap preserves all associated transfers of selected transactions', async () => {
  const txs = Array.from({ length: 35 }, (_, i) => blockTx(2000 + i))
  const res = await apiCall(feeds(txs, [blockToken(2100), blockToken(2100, { log_index: 1 }), blockToken(2000, { log_index: 2 })]),
    { query: { address: wallet, limit: '9999' } })
  const hashes = new Set([...res.body.transactions, ...res.body.tokenTransfers].map(row => row.hash))
  assert.equal(res.body.limit, 30)
  assert.equal(hashes.size, 30)
  assert.equal(res.body.tokenTransfers.filter(row => row.hash === hashOf(2100)).length, 2)
  assert.equal(normalizeWalletActivity(wallet, res.body).length, 30)
})

await checkBlockscout('repeated conflicting or unsafe cursors fail closed without following an arbitrary URL', async () => {
  for (const cursor of [{ url: 'https://invalid.example/' }, { address: other }, { block_number: -1 },
    { index: Number.MAX_SAFE_INTEGER + 1 }, { hash: 'bad' }, { value: '-1' }, { value: '1e18' },
    { fee: '1&url=https://invalid.example' }, { inserted_at: '2026-02-30T12:00:00Z' }, { inserted_at: '1700000000' }, [], {}]) {
    const res = await apiCall(async () => pageResponse([blockTx(2200)], cursor))
    assert.equal(res.statusCode, 502)
    assert.ok(res.calls.every(call => new URL(call.url).origin === 'https://api.blockscout.com'))
  }
  const repeated = await apiCall(async url => url.pathname.endsWith('/transactions')
    ? pageResponse([blockTx(2200)], { block_number: 1, index: 1 }) : pageResponse([]))
  assert.equal(repeated.statusCode, 502)
  const duplicate = await apiCall(feeds([], [blockToken(2201), blockToken(2201, { total: { value: '2000000', decimals: '6' } })]))
  assert.equal(duplicate.statusCode, 502)
  const conflictingStatus = await apiCall(feeds([blockTx(2202), blockTx(2202, { status: 'error' })]))
  assert.equal(conflictingStatus.statusCode, 502)
})

await checkBlockscout('HTTP authorization rate-limit redirects malformed JSON and schemas return only sanitized errors', async () => {
  for (const status of [302, 401, 403, 429, 500]) {
    const res = await apiCall(async () => new Response('provider-private-details', { status }))
    assert.equal(res.statusCode, 502)
    assert.deepEqual(res.body, { error: 'Wallet activity could not be loaded right now' })
  }
  for (const reply of [() => new Response('<html>invalid</html>'), () => new Response(JSON.stringify({ result: [] })),
    () => new Response(JSON.stringify({ items: {}, next_page_params: null })), () => pageResponse(Array(51).fill(blockTx(2300))),
    () => { throw Error('provider-private-details') }]) {
    const res = await apiCall(reply)
    assert.equal(res.statusCode, 502)
    assert.doesNotMatch(JSON.stringify(res.body), /provider|html|fixture-key/)
  }
})

await checkBlockscout('response size and body-read errors fail safely and cancel the other feed', async () => {
  for (const reply of [() => new Response('oversized', { headers: { 'content-length': String(2 * 1024 * 1024 + 1) } }),
    () => new Response(new Uint8Array(2 * 1024 * 1024 + 1)),
    () => new Response(new ReadableStream({ start(controller) { controller.error(Error('private body error')) } }))]) {
    const res = await apiCall(reply)
    assert.equal(res.statusCode, 502)
    assert.ok(res.calls.every(call => call.init.signal.aborted))
  }
})

await checkBlockscout('method address and missing server key checks reject before any provider call', async () => {
  const post = await apiCall(null, { method: 'POST' })
  assert.equal(post.statusCode, 405)
  assert.equal(post.headers.Allow, 'GET')
  for (const address of ['bad', [wallet], ` ${wallet}`]) assert.equal((await apiCall(null, { query: { address } })).statusCode, 400)
  delete process.env.BLOCKSCOUT_PRO_API_KEY
  try { assert.equal((await apiCall(null)).statusCode, 503) }
  finally { process.env.BLOCKSCOUT_PRO_API_KEY = 'wallet-activity-fixture-key' }
})

await checkBlockscout('existing 30-per-minute local refresh limit is preserved', async () => {
  const client = '198.51.100.200'
  for (let i = 0; i < 30; i += 1) assert.equal((await apiCall(feeds(), { client })).statusCode, 200)
  const res = await apiCall(null, { client })
  assert.equal(res.statusCode, 429)
  assert.deepEqual(res.body, { error: 'Please wait before refreshing wallet activity' })
})

await checkBlockscout('one shared 10-second deadline covers stalled headers and stalled body reads without more pages', async () => {
  for (const stalledBody of [false, true]) {
    const savedSet = globalThis.setTimeout, savedClear = globalThis.clearTimeout
    let expire, cancelled = 0, cleared = false
    globalThis.setTimeout = (callback, milliseconds) => {
      assert.equal(milliseconds, 10_000)
      expire = callback
      return 12345
    }
    globalThis.clearTimeout = () => { cleared = true }
    try {
      const pending = apiCall(async (_url, init) => stalledBody
        ? new Response(new ReadableStream({ cancel() { cancelled += 1 } }))
        : new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(Error('private timeout')), { once: true })))
      for (let i = 0; i < 5; i += 1) await Promise.resolve()
      assert.ok(expire)
      expire()
      const res = await pending
      assert.equal(res.statusCode, 502)
      assert.equal(res.calls.length, 2)
      assert.ok(res.calls.every(call => call.init.signal.aborted))
      assert.equal(cleared, true)
      if (stalledBody) assert.equal(cancelled, 2)
    } finally { globalThis.setTimeout = savedSet; globalThis.clearTimeout = savedClear }
  }
})
console.log(`VERIFIER PASS wallet-activity: existing classification regressions and ${blockscoutChecks} Blockscout checks; mocks only`)
