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
console.log('tokenDecimal fixtures passed: valid 0/6/18 retained; empty/null/undefined/malformed/negative rejected')

const earnVaults = [
  '0x8E357432CC12ff425c36432F312968aEb16112AF',
  '0xdECcd53BE5453215821184824B519E04C7e00bC7',
]
const cctpMessenger = '0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d'
const cctpTransmitter = '0x81D40F21F12A8F0E3252Bccb954D722d4c464B64'

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
      return { MAINNET_EARN_SELECTED_VAULT_ADDRESSES: earnVaults }
    }
  }
  return originalRequire.call(this, specifier)
}

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

const modulePath = fileURLToPath(new URL('../src/lib/mainnetWalletActivity.ts', import.meta.url))
const { normalizeWalletActivity } = require(modulePath)
Module.prototype.require = originalRequire

const tokenA = '0xcccccccccccccccccccccccccccccccccccccccc'
const tokenB = '0xdddddddddddddddddddddddddddddddddddddddd'
const cctpDepositSelector = toFunctionSelector(
  'depositForBurn(uint256,uint32,bytes32,address,bytes32,uint256,uint32)',
)
const movement = (hash, contractAddress, from, to, decimals = 6) => ({
  hash,
  contractAddress,
  from,
  to,
  value: '1000000',
  symbol: 'FIX',
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
  ],
  tokenTransfers: [
    movement(`0x${'2'.repeat(64)}`, tokenA, wallet, other),
    movement(`0x${'2'.repeat(64)}`, tokenB, other, wallet),
    movement(`0x${'3'.repeat(64)}`, tokenA, wallet, earnVaults[0]),
    movement(`0x${'4'.repeat(64)}`, tokenA, wallet, cctpMessenger),
    movement(`0x${'5'.repeat(64)}`, tokenA, wallet, other),
    movement(`0x${'6'.repeat(64)}`, tokenB, wallet, other, 0),
    movement(`0x${'7'.repeat(64)}`, tokenA, other, wallet),
  ],
})
const byHash = new Map(classificationFixtures.map((item) => [item.txHash, item]))
assert.equal(byHash.get(`0x${'2'.repeat(64)}`).type, 'interaction', 'unverified selector target must not be Swap')
assert.equal(byHash.get(`0x${'3'.repeat(64)}`).type, 'earn', 'configured vault classification must remain')
assert.equal(byHash.get(`0x${'4'.repeat(64)}`).type, 'bridge', 'known CCTP classification must remain')
assert.equal(byHash.get(`0x${'5'.repeat(64)}`).type, 'send', 'outgoing token transfer must remain Send')
assert.equal(byHash.get(`0x${'6'.repeat(64)}`).amount, '1,000,000 FIX', 'zero-decimal amount must remain unscaled')
assert.equal(byHash.get(`0x${'7'.repeat(64)}`).type, 'receive', 'incoming-only token transfer must remain Receive')
console.log('classification fixtures passed: unknown swap target falls back; Earn, CCTP, Send, Receive, and zero-decimal formatting remain correct')

const dashboardSource = readFileSync(
  fileURLToPath(new URL('../src/components/MainnetDashboard.tsx', import.meta.url)),
  'utf8',
)
assert.match(dashboardSource, /requestId === walletActivityRequestId\.current/)
assert.match(dashboardSource, /walletActivityAddressRef\.current === addressIdentity/)
assert.match(dashboardSource, /!controller\.signal\.aborted/)
assert.match(dashboardSource, /onClick=\{\(\) => address && void loadWalletActivity\(address\)\}/)
assert.match(dashboardSource, /const visibleWalletActivity = walletActivityDataAddress === walletActivityAddress/)
console.log('request lifecycle guards passed: generation, wallet identity, abort, manual refresh, and address-scoped rendering')
