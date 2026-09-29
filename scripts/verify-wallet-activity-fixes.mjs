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
  hash: txHash,
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
process.env.ETHERSCAN_API_KEY = 'wallet-activity-fixture-key'
globalThis.fetch = async (input) => {
  const action = new URL(String(input)).searchParams.get('action')
  return {
    ok: true,
    json: async () => ({
      status: '1',
      result: action === 'tokentx' ? tokenRows : [],
    }),
  }
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
  globalThis.fetch = async (input) => ({
    ok: true,
    json: async () => ({
      status: '1',
      result: new URL(String(input)).searchParams.get('action') === 'txlist' ? transactionRows : [],
    }),
  })
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
assert.match(earnPreviewSource, />Available liquidity<\/p>/)
assert.match(earnPreviewSource, /Compare current rates and available liquidity across selected vaults\./)
assert.doesNotMatch(earnPreviewSource, /withdrawable liquidity/i)
assert.match(earnPreviewSource, /Withdrawal availability is checked when you review a withdrawal\./)
assert.match(earnPreviewSource, /Liquidity is currently limited\. A withdrawal quote may be unavailable\./)
assert.match(earnPreviewSource, /isZeroLiquidity\(vault\.liquidityProfile\?\.available \?\? vault\.liquidity\)/)
console.log('request lifecycle guards passed: generation, wallet identity, abort, manual refresh, and address-scoped rendering')
console.log('Activity navigation and UI fixtures passed: mainnet tab, no Dashboard card, hidden Unknown badge, normal page scrolling')
console.log('Earn UI fixtures passed: metadata driven dropdown labels; withdrawal position, quote, and execution order unchanged; available liquidity copy and zero value warning')
