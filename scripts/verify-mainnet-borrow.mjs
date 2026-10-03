// Deterministic Borrow Kit adapter checks. No network, no wallet, no writes:
// fetch is replaced below, so even the real SDK cannot leave this process.
import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const ts = require('typescript')

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

const root = fileURLToPath(new URL('..', import.meta.url))
const configPath = join(root, 'src/config/mainnetBorrow.ts')
const libPath = join(root, 'src/lib/mainnetBorrow.ts')
const configSource = readFileSync(configPath, 'utf8')
const libSource = readFileSync(libPath, 'utf8')

const sdk = require('@circle-fin/borrow-kit')
const config = require(configPath)

// Every request the real SDK makes is captured here and answered locally.
// The default answer is an HTTP 400, which the SDK does not retry.
const fetchRequests = []
const rejectRequest = () => new Response(JSON.stringify({ code: 400, message: 'fixture rejection' }), {
  status: 400,
  headers: { 'Content-Type': 'application/json' },
})
let fetchResponder = rejectRequest
globalThis.fetch = async (input, init = {}) => {
  const url = new URL(String(input))
  fetchRequests.push({
    url,
    method: init.method ?? 'GET',
    headers: { ...(init.headers ?? {}) },
    body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined,
  })
  return fetchResponder(url, init)
}

// Count real BorrowKit instantiations and capture their config. Reads stay
// real; every SDK method that can write is replaced by a recorder that throws.
const RealBorrowKit = sdk.BorrowKit
const SDK_WRITE_METHODS = [
  'borrow', 'repay', 'addCollateral', 'withdrawCollateralRepayIfNeeded', 'closeLoan',
  'retry', 'claimRewards', 'registerWebhook', 'setIntegratorConfig',
]
const instantiations = []
const defaultKitWriteCalls = []
sdk.BorrowKit = class extends RealBorrowKit {
  constructor(options) {
    super(options)
    instantiations.push(options)
  }
}
for (const method of SDK_WRITE_METHODS) {
  sdk.BorrowKit.prototype[method] = async function recordWrite() {
    defaultKitWriteCalls.push(method)
    throw new Error(`write method ${method} must not run`)
  }
}
const borrow = require(libPath)

const defined = (value) => Object.fromEntries(Object.entries(value).filter(([, field]) => field !== undefined))

let passed = 0
async function test(name, run) {
  await run()
  passed += 1
  console.log(`PASS ${name}`)
}

const WALLET = '0x1111111111111111111111111111111111111111'
const OTHER = '0x2222222222222222222222222222222222222222'
const MARKET = `0x${'ab'.repeat(32)}`
const LOAN = '11111111-1111-4111-8111-111111111111'
const USDC = '0x3600000000000000000000000000000000000000'
const COLLATERAL = '0x4444444444444444444444444444444444444444'

const usdc = (amount) => ({ token: 'USDC', tokenAddress: USDC, amount, decimals: 6 })
const collateral = (amount) => ({ token: 'cirBTC', tokenAddress: COLLATERAL, amount, decimals: 8 })
const gas = [{ name: 'execute', fees: { gas: '210000', gasPrice: '160000000000', fee: '33600000000000000' } }]

const MARKET_INFO = {
  marketId: MARKET,
  protocol: 'morpho',
  chain: 'Arc',
  loanAsset: { symbol: 'USDC', address: USDC, decimals: 6 },
  collateralAsset: { symbol: 'cirBTC', address: COLLATERAL, decimals: 8 },
  lltv: 0.86,
  borrowCap: null,
  borrowAssets: usdc('1250000.5'),
  liquidity: usdc('400000'),
  borrowApy: 0.0612,
  utilization: 0.757,
  refreshedAt: '2026-10-01T12:00:00.000Z',
}

const READY_LOAN = {
  loanId: LOAN,
  chain: 'Arc',
  marketId: MARKET,
  walletAddress: WALLET,
  dataStatus: 'READY',
  collateral: collateral('0.05'),
  borrowed: usdc('1000.25'),
  principalBorrowed: usdc('1000'),
  accruedInterest: usdc('0.25'),
  borrowApy: 0.0612,
  ltv: 0.33,
  healthFactor: 2.6,
  healthFactorBand: 'SAFE',
  liquidationPrice: usdc('23255.81'),
  status: 'active',
}

const PENDING_LOAN = {
  ...READY_LOAN,
  loanId: '22222222-2222-4222-8222-222222222222',
  dataStatus: 'PENDING',
  collateral: null,
  borrowed: null,
  principalBorrowed: null,
  accruedInterest: null,
  borrowApy: null,
  ltv: null,
  healthFactor: null,
  healthFactorBand: null,
  liquidationPrice: null,
  status: undefined,
}

const QUOTES = {
  getBorrowQuote: {
    chain: 'Arc',
    collateralAmount: collateral('0.05'),
    loanAssetAmount: usdc('1000'),
    borrowApy: 0.0612,
    fees: [{ type: 'circle', token: 'USDC', amount: usdc('1.5') }],
    gasFees: gas,
    resultingHealthFactor: 2.6,
    resultingLtv: 0.33,
    resultingBand: 'SAFE',
    liquidationPrice: usdc('23255.81'),
  },
  getRequiredCollateral: { chain: 'Arc', requiredCollateral: collateral('0.07'), resultingHealthFactor: 1.5, liquidationPrice: usdc('30000') },
  getMaxBorrow: { chain: 'Arc', maxBorrowAmount: usdc('2100'), resultingHealthFactor: 1.01, liquidationPrice: null },
  getRepayQuote: {
    chain: 'Arc', repayAmount: usdc('10'), fees: [], gasFees: gas,
    resultingHealthFactor: 2.7, resultingLtv: 0.32, resultingBand: 'SAFE', liquidationPrice: usdc('23000'),
  },
  getCloseLoanQuote: {
    chain: 'Arc', bundledRepayment: usdc('1030.26'), collateralAmount: collateral('0.05'), fees: [], gasFees: gas,
    resultingHealthFactor: null, resultingLtv: null, resultingBand: 'SAFE', liquidationPrice: null,
  },
  getAddCollateralQuote: {
    chain: 'Arc', collateralAmount: collateral('0.01'), fees: [], gasFees: [],
    resultingHealthFactor: 3.1, resultingLtv: 0.27, resultingBand: 'SAFE', liquidationPrice: usdc('19000'),
  },
  getWithdrawCollateralRepayIfNeededQuote: {
    chain: 'Arc', bundledRepayment: usdc('0'), collateralAmount: collateral('0.01'), fees: [], gasFees: gas,
    resultingHealthFactor: 2.1, resultingLtv: 0.41, resultingBand: 'SAFE', liquidationPrice: usdc('28000'),
  },
}

// Fake SDK client: records every call; write methods must never run.
function fakeClient(overrides = {}) {
  const calls = []
  const responses = {
    exploreMarkets: { markets: [MARKET_INFO], pagination: { pageAfter: 'cursor-2' } },
    getMarket: MARKET_INFO,
    getLoans: { loans: [READY_LOAN, PENDING_LOAN], pagination: {} },
    getPosition: { ...READY_LOAN, walletAddress: undefined, wallet: WALLET },
    ...QUOTES,
    ...overrides,
  }
  const client = {}
  for (const method of borrow.MAINNET_BORROW_READ_METHODS) {
    client[method] = async (params) => {
      calls.push({ method, params })
      const response = responses[method]
      if (response instanceof Error) throw response
      return typeof response === 'function' ? response(params) : structuredClone(response)
    }
  }
  for (const method of borrow.MAINNET_BORROW_WRITE_METHODS) {
    client[method] = async (params) => {
      calls.push({ method, params })
      throw new Error(`write method ${method} must not run`)
    }
  }
  return { client, calls }
}

function writeCalls(calls) {
  return calls.filter(({ method }) => borrow.MAINNET_BORROW_WRITE_METHODS.includes(method))
}

function kitError(details, recoverability = 'FATAL') {
  return new sdk.KitError({ ...details, recoverability, message: `${details.name} fixture` })
}

await test('write gate is a false source constant that no runtime value can change', () => {
  assert.equal(config.MAINNET_BORROW_WRITES_ENABLED, false)
  assert.equal(config.MAINNET_BORROW_READ_ONLY_ENABLED, true)
  assert.match(configSource, /^export const MAINNET_BORROW_WRITES_ENABLED: boolean = false$/m)
  for (const forbidden of ['import.meta', 'process.env', 'localStorage', 'sessionStorage', 'URLSearchParams', 'location', 'window', 'VITE_']) {
    assert.ok(!configSource.includes(forbidden), `config must not read ${forbidden}`)
  }
})

await test('installed SDK maps BorrowChain.Arc to Arc mainnet chain 5042', () => {
  assert.equal(require('@circle-fin/borrow-kit/package.json').version, '1.0.0')
  assert.deepEqual({ ...sdk.BorrowChain }, { Arc: 'Arc', Arc_Testnet: 'Arc_Testnet' })
  const chains = new RealBorrowKit({ disableAnalytics: true, disableErrorReporting: true }).getSupportedChains()
  const arc = chains.find((chain) => chain.chain === 'Arc')
  const testnet = chains.find((chain) => chain.chain === 'Arc_Testnet')
  assert.equal(arc.chainId, 5042)
  assert.equal(arc.isTestnet, false)
  assert.equal(arc.chainId, config.MAINNET_BORROW_CHAIN_ID)
  assert.equal(config.MAINNET_BORROW_CHAIN, sdk.BorrowChain.Arc)
  assert.equal(arc.kitContracts.adapter, config.MAINNET_BORROW_ADAPTER_CONTRACT)
  assert.equal(testnet.chainId, 5042002)
  assert.equal(sdk.getChainByEnum('Arc').chainId, 5042)
})

await test('adapter uses only methods the installed SDK exposes', () => {
  for (const method of [...borrow.MAINNET_BORROW_READ_METHODS, ...borrow.MAINNET_BORROW_WRITE_METHODS]) {
    assert.equal(typeof RealBorrowKit.prototype[method], 'function', `BorrowKit.${method}`)
  }
})

await test('default kit is private, lazy, single and created with Circle telemetry disabled', async () => {
  assert.equal(instantiations.length, 0, 'loading the module creates no kit')
  assert.equal(borrow.getMainnetBorrowKit, undefined)
  const market = await borrow.getBorrowMarket(MARKET)
  const page = await borrow.exploreBorrowMarkets()
  assert.equal(market.status, 'unavailable')
  assert.equal(page.status, 'unavailable')
  assert.deepEqual(instantiations, [{ disableAnalytics: true, disableErrorReporting: true }])
  assert.equal(fetchRequests.length, 2)
  // Both reads failed inside the SDK's error-telemetry wrapper, yet nothing
  // was sent anywhere except the Borrow Service.
  for (const request of fetchRequests) {
    assert.equal(request.url.origin, 'https://api.circle.com')
    assert.ok(request.url.pathname.startsWith('/v1/borrowKit/'), request.url.pathname)
  }
  assert.ok(!fetchRequests.some((request) => request.url.pathname.includes('stablecoinKits')))
})

await test('market reads normalize on Arc and keep unbackfilled economics null', async () => {
  const { client, calls } = fakeClient({
    exploreMarkets: {
      markets: [MARKET_INFO, { ...MARKET_INFO, marketId: `0x${'cd'.repeat(32)}`, lltv: null, borrowAssets: null, liquidity: null, borrowApy: null, utilization: null, refreshedAt: null }],
      pagination: { pageAfter: 'cursor-2' },
    },
  })
  const page = await borrow.exploreBorrowMarkets({ sortBy: 'borrowApy' }, client)
  assert.equal(page.status, 'available')
  assert.equal(page.data.nextPageAfter, 'cursor-2')
  assert.deepEqual(page.data.items[0], {
    marketId: MARKET,
    protocol: 'morpho',
    loanAsset: { symbol: 'USDC', address: USDC, decimals: 6 },
    collateralAsset: { symbol: 'cirBTC', address: COLLATERAL, decimals: 8 },
    lltv: 0.86,
    borrowApy: 0.0612,
    utilization: 0.757,
    borrowAssets: usdc('1250000.5'),
    liquidity: usdc('400000'),
    refreshedAt: '2026-10-01T12:00:00.000Z',
  })
  const unrefreshed = page.data.items[1]
  for (const field of ['lltv', 'borrowApy', 'utilization', 'borrowAssets', 'liquidity', 'refreshedAt']) {
    assert.equal(unrefreshed[field], null, `${field} stays null, not zero`)
  }
  assert.equal(calls.length, 1)
  assert.equal(calls[0].method, 'exploreMarkets')
  assert.deepEqual(defined(calls[0].params), { chain: 'Arc', sortBy: 'borrowApy' })

  const single = await borrow.getBorrowMarket(MARKET, client)
  assert.equal(single.status, 'available')
  assert.equal(calls.at(-1).params.chain, 'Arc')
})

await test('missing or foreign market data is unavailable, never zero', async () => {
  const { loanAsset, ...withoutLoanAsset } = MARKET_INFO
  const missing = await borrow.exploreBorrowMarkets({}, fakeClient({ exploreMarkets: { markets: [withoutLoanAsset], pagination: {} } }).client)
  assert.deepEqual(missing, { status: 'unavailable', error: { code: 'malformed_response', retryable: false, detail: 'markets[0].loanAsset' } })

  const testnet = await borrow.getBorrowMarket(MARKET, fakeClient({ getMarket: { ...MARKET_INFO, chain: 'Arc_Testnet' } }).client)
  assert.equal(testnet.status, 'unavailable')
  assert.equal(testnet.error.code, 'unexpected_chain')

  const otherMarket = await borrow.getBorrowMarket(MARKET, fakeClient({ getMarket: { ...MARKET_INFO, marketId: `0x${'ef'.repeat(32)}` } }).client)
  assert.equal(otherMarket.error.code, 'malformed_response')

  const badAmount = await borrow.getBorrowMarket(MARKET, fakeClient({ getMarket: { ...MARKET_INFO, liquidity: usdc('-1') } }).client)
  assert.deepEqual(badAmount.error, { code: 'malformed_response', retryable: false, detail: 'market.liquidity.amount' })

  const negativeApy = await borrow.getBorrowMarket(MARKET, fakeClient({ getMarket: { ...MARKET_INFO, borrowApy: -0.1 } }).client)
  assert.equal(negativeApy.error.detail, 'market.borrowApy')
})

await test('wallet loans and positions normalize, pending economics stay null', async () => {
  const { client, calls } = fakeClient()
  const loans = await borrow.getBorrowLoans({ walletAddress: WALLET }, client)
  assert.equal(loans.status, 'available')
  assert.equal(loans.data.nextPageAfter, null)
  const [ready, pending] = loans.data.items
  assert.equal(ready.owner, WALLET)
  assert.equal(ready.lifecycle, 'active')
  assert.equal(ready.economics, 'ready')
  assert.deepEqual(ready.borrowed, usdc('1000.25'))
  assert.equal(ready.healthBand, 'SAFE')
  assert.equal(pending.economics, 'pending')
  assert.equal(pending.lifecycle, 'unreported')
  for (const field of ['collateral', 'borrowed', 'principalBorrowed', 'accruedInterest', 'borrowApy', 'ltv', 'healthFactor', 'healthBand', 'liquidationPrice']) {
    assert.equal(pending[field], null, `${field} stays null while pending`)
  }
  assert.equal(calls[0].method, 'getLoans')
  assert.deepEqual(defined(calls[0].params), { chain: 'Arc', walletAddress: WALLET })

  const position = await borrow.getBorrowPosition({ loanId: LOAN, expectedOwner: WALLET }, client)
  assert.equal(position.status, 'available')
  assert.equal(position.data.owner, WALLET)
  assert.deepEqual(calls.at(-1), { method: 'getPosition', params: { loanId: LOAN } })

  const foreignOwner = await borrow.getBorrowPosition({ loanId: LOAN, expectedOwner: OTHER }, client)
  assert.deepEqual(foreignOwner.error, { code: 'unexpected_owner', retryable: false, detail: 'loan.wallet' })

  const foreignLoan = await borrow.getBorrowLoans({ walletAddress: WALLET }, fakeClient({
    getLoans: { loans: [{ ...READY_LOAN, walletAddress: OTHER }], pagination: {} },
  }).client)
  assert.equal(foreignLoan.error.code, 'unexpected_owner')

  const badStatus = await borrow.getBorrowLoans({ walletAddress: WALLET }, fakeClient({
    getLoans: { loans: [{ ...READY_LOAN, status: 'liquidated' }], pagination: {} },
  }).client)
  assert.equal(badStatus.error.detail, 'loans[0].status')
})

await test('quotes normalize per kind and pass Arc to the SDK', async () => {
  const { client, calls } = fakeClient()
  const borrowQuote = await borrow.quoteBorrow({ marketId: MARKET, walletAddress: WALLET, borrowAmount: '1000' }, client)
  assert.equal(borrowQuote.status, 'available')
  assert.deepEqual(borrowQuote.data, {
    kind: 'borrow',
    collateral: collateral('0.05'),
    loanAsset: usdc('1000'),
    borrowApy: 0.0612,
    resultingHealthFactor: 2.6,
    liquidationPrice: usdc('23255.81'),
    resultingLtv: 0.33,
    resultingBand: 'SAFE',
    fees: [{ type: 'circle', amount: usdc('1.5') }],
    gasFees: [{ name: 'execute', gasUnits: '210000', gasPriceWei: '160000000000', feeWei: '33600000000000000' }],
  })
  assert.deepEqual(defined(calls.at(-1).params), { chain: 'Arc', marketId: MARKET, walletAddress: WALLET, borrowAmount: '1000' })

  await borrow.quoteBorrow({ loanId: LOAN, borrowAmount: '250' }, client)
  assert.deepEqual(defined(calls.at(-1).params), { loanId: LOAN, borrowAmount: '250' })

  const required = await borrow.quoteRequiredCollateral({ marketId: MARKET, borrowAmount: '1000', targetHealthFactor: 1.5 }, client)
  assert.deepEqual(required.data, { kind: 'required-collateral', requiredCollateral: collateral('0.07'), resultingHealthFactor: 1.5, liquidationPrice: usdc('30000') })
  const max = await borrow.quoteMaxBorrow({ marketId: MARKET, collateralAmount: '0.05' }, client)
  assert.deepEqual(max.data, { kind: 'max-borrow', maxBorrow: usdc('2100'), resultingHealthFactor: 1.01, liquidationPrice: null })
  const close = await borrow.quoteCloseLoan({ loanId: LOAN }, client)
  assert.equal(close.data.kind, 'close-loan')
  assert.deepEqual(close.data.maxRepayment, usdc('1030.26'))
  assert.equal(close.data.resultingHealthFactor, null)
  assert.equal((await borrow.quoteRepay({ loanId: LOAN, repayAmount: '10' }, client)).data.kind, 'repay')
  assert.equal((await borrow.quoteAddCollateral({ loanId: LOAN, collateralAmount: '0.01' }, client)).data.kind, 'add-collateral')
  const withdraw = await borrow.quoteWithdrawCollateral({ loanId: LOAN, collateralAmount: '0.01' }, client)
  assert.deepEqual(withdraw.data.maxRepayment, usdc('0'))

  for (const call of calls) {
    // A borrow-more preview resolves its chain from the loan.
    if (call.method === 'getBorrowQuote' && 'loanId' in call.params) continue
    assert.equal(call.params.chain, 'Arc', `${call.method} targets Arc mainnet`)
  }
  assert.deepEqual(writeCalls(calls), [])
})

await test('malformed quotes are unavailable', async () => {
  const badBand = await borrow.quoteRepay({ loanId: LOAN, repayAmount: '10' }, fakeClient({
    getRepayQuote: { ...QUOTES.getRepayQuote, resultingBand: 'FINE' },
  }).client)
  assert.deepEqual(badBand.error, { code: 'malformed_response', retryable: false, detail: 'quote.resultingBand' })
  const badGas = await borrow.quoteRepay({ loanId: LOAN, repayAmount: '10' }, fakeClient({
    getRepayQuote: { ...QUOTES.getRepayQuote, gasFees: [{ name: 'execute', fees: { gas: '1.5', gasPrice: '1', fee: '1' } }] },
  }).client)
  assert.equal(badGas.error.detail, 'quote.gasFees[0].fees.gas')
  const missingFees = await borrow.quoteCloseLoan({ loanId: LOAN }, fakeClient({
    getCloseLoanQuote: { ...QUOTES.getCloseLoanQuote, fees: undefined },
  }).client)
  assert.equal(missingFees.error.detail, 'quote.fees')
})

await test('read failures map to explicit unavailable errors', async () => {
  const notFound = await borrow.getBorrowMarket(MARKET, fakeClient({ getMarket: kitError(sdk.BorrowError.MARKET_NOT_FOUND) }).client)
  assert.deepEqual(notFound, {
    status: 'unavailable',
    error: { code: 'market_not_found', retryable: false, detail: 'BORROW_MARKET_NOT_FOUND', sdkCode: 1207 },
  })
  const loanMissing = await borrow.getBorrowPosition({ loanId: LOAN }, fakeClient({ getPosition: kitError(sdk.BorrowError.LOAN_NOT_FOUND) }).client)
  assert.equal(loanMissing.error.code, 'loan_not_found')
  const outage = await borrow.exploreBorrowMarkets({}, fakeClient({
    exploreMarkets: kitError({ code: 3001, name: 'NETWORK_TIMEOUT', type: 'NETWORK' }, 'RETRYABLE'),
  }).client)
  assert.deepEqual(outage.error, { code: 'service_unavailable', retryable: true, detail: 'NETWORK_TIMEOUT', sdkCode: 3001 })
  const crash = await borrow.getBorrowLoans({ walletAddress: WALLET }, fakeClient({ getLoans: new Error('boom') }).client)
  assert.deepEqual(crash.error, { code: 'unexpected_error', retryable: false })
})

await test('invalid read input is refused before the SDK is called', async () => {
  const { client, calls } = fakeClient()
  const results = [
    await borrow.getBorrowMarket('0x1234', client),
    await borrow.getBorrowLoans({ walletAddress: 'not-an-address' }, client),
    await borrow.getBorrowPosition({ loanId: 'loan-1' }, client),
    await borrow.quoteBorrow({ marketId: MARKET, walletAddress: WALLET, borrowAmount: '0' }, client),
    await borrow.quoteRepay({ loanId: LOAN, repayAmount: '1e3' }, client),
    await borrow.quoteRequiredCollateral({ marketId: MARKET, borrowAmount: '10', targetHealthFactor: 0.9 }, client),
    await borrow.quoteWithdrawCollateral({ loanId: LOAN, collateralAmount: '1', slippageBps: 20_000 }, client),
    await borrow.exploreBorrowMarkets({ pageSize: 0 }, client),
  ]
  for (const result of results) {
    assert.equal(result.status, 'unavailable')
    assert.equal(result.error.code, 'invalid_input')
  }
  assert.deepEqual(calls, [])
})

const READY_WALLET = { address: WALLET, chainId: 5042, atomicBatch: 'supported' }
const BORROW_QUOTE = { kind: 'borrow', collateral: collateral('0.05'), loanAsset: usdc('1000'), borrowApy: 0.06, resultingHealthFactor: 2.6, liquidationPrice: null, resultingLtv: 0.33, resultingBand: 'SAFE', fees: [], gasFees: [] }
const outcomeOnly = { resultingHealthFactor: 2, liquidationPrice: null, resultingLtv: 0.3, resultingBand: 'SAFE', fees: [], gasFees: [] }
const WRITE_CASES = [
  [{ kind: 'borrow', marketId: MARKET, borrowAmount: '1000' }, BORROW_QUOTE],
  [{ kind: 'borrow-more', loanId: LOAN, borrowAmount: '1000.000' }, BORROW_QUOTE],
  [{ kind: 'repay', loanId: LOAN, repayAmount: '10' }, { kind: 'repay', repayAmount: usdc('10.0'), ...outcomeOnly }],
  [{ kind: 'add-collateral', loanId: LOAN, collateralAmount: '0.01' }, { kind: 'add-collateral', collateral: collateral('0.01'), ...outcomeOnly }],
  [{ kind: 'withdraw-collateral', loanId: LOAN, collateralAmount: '0.01' }, { kind: 'withdraw-collateral', maxRepayment: usdc('0'), collateral: collateral('0.01'), ...outcomeOnly }],
  [{ kind: 'close-loan', loanId: LOAN }, { kind: 'close-loan', maxRepayment: usdc('1030'), collateral: collateral('0.05'), ...outcomeOnly }],
]

await test('with the gate false every write plan is blocked only by writes_disabled', () => {
  for (const [action, quote] of WRITE_CASES) {
    const plan = borrow.planBorrowWrite(action, READY_WALLET, quote)
    assert.deepEqual(plan.blockers, ['writes_disabled'], action.kind)
    assert.equal(plan.ready, false)
    assert.equal(plan.chainId, 5042)
    assert.equal(plan.approvalSpender, config.MAINNET_BORROW_ADAPTER_CONTRACT)
    assert.ok(plan.actionId.startsWith(`${action.kind}|5042|${WALLET}|`))
  }
  const borrowPlan = borrow.planBorrowWrite(WRITE_CASES[0][0], READY_WALLET, WRITE_CASES[0][1])
  assert.deepEqual(borrowPlan.walletRequests, ['collateral-approval-if-short', 'morpho-authorization-grant', 'adapter-execution', 'morpho-authorization-revoke'])
  const repayPlan = borrow.planBorrowWrite(WRITE_CASES[2][0], READY_WALLET, WRITE_CASES[2][1])
  assert.deepEqual(repayPlan.walletRequests, ['usdc-approval-if-short', 'adapter-execution'])
})

await test('wrong chain, missing wallet, missing capability and bad quotes are blocked', () => {
  const [action, quote] = WRITE_CASES[0]
  const blockersOf = (wallet, nextQuote = quote, nextAction = action) => borrow.planBorrowWrite(nextAction, wallet, nextQuote).blockers
  assert.ok(blockersOf({ ...READY_WALLET, chainId: 5042002 }).includes('wrong_chain'))
  assert.ok(blockersOf({ ...READY_WALLET, chainId: 1 }).includes('wrong_chain'))
  assert.deepEqual(blockersOf(null), ['writes_disabled', 'wallet_missing', 'wrong_chain', 'wallet_capability_missing'])
  assert.ok(blockersOf({ ...READY_WALLET, address: undefined }).includes('wallet_missing'))
  assert.ok(blockersOf({ ...READY_WALLET, address: '0x12' }).includes('wallet_missing'))
  assert.ok(blockersOf({ ...READY_WALLET, atomicBatch: 'unsupported' }).includes('wallet_capability_missing'))
  assert.ok(blockersOf({ ...READY_WALLET, atomicBatch: 'unknown' }).includes('wallet_capability_missing'))
  assert.ok(blockersOf(READY_WALLET, null).includes('quote_missing'))
  assert.ok(blockersOf(READY_WALLET, { ...quote, loanAsset: usdc('999') }).includes('quote_mismatch'))
  assert.ok(blockersOf(READY_WALLET, WRITE_CASES[2][1]).includes('quote_mismatch'))
  assert.ok(blockersOf(READY_WALLET, quote, { ...action, borrowAmount: '-5' }).includes('invalid_action'))
  assert.ok(blockersOf(READY_WALLET, quote, { ...action, marketId: 'market' }).includes('invalid_action'))
})

await test('disabled writes refuse before any adapter or SDK write method runs', async () => {
  for (const [action, quote] of WRITE_CASES) {
    const { client, calls } = fakeClient()
    let adapterRequests = 0
    const plan = borrow.planBorrowWrite(action, READY_WALLET, quote)
    const outcome = await borrow.executeBorrowWrite({
      action,
      wallet: READY_WALLET,
      quote,
      confirmedActionId: plan.actionId,
      getAdapter: async () => {
        adapterRequests += 1
        throw new Error('adapter must not be created')
      },
      client,
    })
    assert.deepEqual(outcome, { status: 'refused', blockers: ['writes_disabled'] }, action.kind)
    assert.equal(adapterRequests, 0)
    assert.deepEqual(calls, [])
  }
})

await test('the private default kit is never reached for writes, even through executeBorrowWrite', async () => {
  const requestsBefore = fetchRequests.length
  for (const [action, quote] of WRITE_CASES) {
    let adapterRequests = 0
    const plan = borrow.planBorrowWrite(action, READY_WALLET, quote)
    const outcome = await borrow.executeBorrowWrite({
      action,
      wallet: READY_WALLET,
      quote,
      confirmedActionId: plan.actionId,
      getAdapter: async () => {
        adapterRequests += 1
        throw new Error('adapter must not be created')
      },
    })
    assert.deepEqual(outcome, { status: 'refused', blockers: ['writes_disabled'] }, action.kind)
    assert.equal(adapterRequests, 0)
  }
  assert.deepEqual(defaultKitWriteCalls, [])
  assert.equal(fetchRequests.length, requestsBefore, 'no Borrow Service call either')
})

// Every export the application may import. A new export must be added here
// on purpose, after checking it cannot hand out the raw kit.
const PUBLIC_EXPORTS = [
  'MAINNET_BORROW_READ_METHODS',
  'MAINNET_BORROW_WRITE_METHODS',
  'detectAtomicBatchCapability',
  'executeBorrowWrite',
  'exploreBorrowMarkets',
  'getBorrowLoans',
  'getBorrowMarket',
  'getBorrowPosition',
  'normalizeBorrowMarket',
  'normalizeBorrowPosition',
  'normalizeBorrowQuote',
  'planBorrowWrite',
  'quoteAddCollateral',
  'quoteBorrow',
  'quoteCloseLoan',
  'quoteMaxBorrow',
  'quoteRepay',
  'quoteRequiredCollateral',
  'quoteWithdrawCollateral',
  'toBorrowError',
]

// Fields the adapter may send per SDK read. Anything else is an injection.
const REQUEST_FIELDS = {
  exploreMarkets: ['chain', 'sortBy', 'pageSize', 'pageAfter'],
  getMarket: ['chain', 'marketId'],
  getRequiredCollateral: ['chain', 'marketId', 'borrowAmount', 'targetHealthFactor'],
  getMaxBorrow: ['chain', 'marketId', 'collateralAmount'],
  getBorrowQuote: ['chain', 'marketId', 'walletAddress', 'loanId', 'borrowAmount', 'slippageBps'],
  getLoans: ['chain', 'walletAddress', 'pageSize', 'pageAfter'],
  getPosition: ['loanId'],
  getRepayQuote: ['chain', 'loanId', 'repayAmount'],
  getCloseLoanQuote: ['chain', 'loanId', 'slippageBps'],
  getAddCollateralQuote: ['chain', 'loanId', 'collateralAmount'],
  getWithdrawCollateralRepayIfNeededQuote: ['chain', 'loanId', 'collateralAmount', 'slippageBps'],
}

const HOSTILE = {
  chain: 'Arc_Testnet',
  config: { baseUrl: 'https://attacker.example', apiKey: 'TEST_API_KEY:fixture:fixture' },
  baseUrl: 'https://attacker.example',
  apiKey: 'TEST_API_KEY:fixture:fixture',
  providers: [],
}

// Calls every public read with valid inputs plus the given extra fields.
async function callEveryRead(client, extra) {
  return [
    await borrow.exploreBorrowMarkets({ sortBy: 'lltv', ...extra }, client),
    await borrow.getBorrowMarket(MARKET, client),
    await borrow.quoteRequiredCollateral({ marketId: MARKET, borrowAmount: '10', targetHealthFactor: 1.5, ...extra }, client),
    await borrow.quoteMaxBorrow({ marketId: MARKET, collateralAmount: '0.01', ...extra }, client),
    await borrow.quoteBorrow({ marketId: MARKET, walletAddress: WALLET, borrowAmount: '10', ...extra }, client),
    await borrow.quoteBorrow({ loanId: LOAN, borrowAmount: '10', ...extra }, client),
    await borrow.getBorrowLoans({ walletAddress: WALLET, ...extra }, client),
    await borrow.getBorrowPosition({ loanId: LOAN, ...extra }, client),
    await borrow.quoteRepay({ loanId: LOAN, repayAmount: '10', ...extra }, client),
    await borrow.quoteCloseLoan({ loanId: LOAN, ...extra }, client),
    await borrow.quoteAddCollateral({ loanId: LOAN, collateralAmount: '0.01', ...extra }, client),
    await borrow.quoteWithdrawCollateral({ loanId: LOAN, collateralAmount: '0.01', ...extra }, client),
  ]
}

function assertPlainData(value, path = 'result') {
  if (value === null || typeof value !== 'object') {
    assert.notEqual(typeof value, 'function', `${path} must not be a function`)
    return
  }
  const prototype = Object.getPrototypeOf(value)
  assert.ok(prototype === Object.prototype || prototype === Array.prototype || prototype === null, `${path} must be plain data`)
  for (const [key, field] of Object.entries(value)) assertPlainData(field, `${path}.${key}`)
}

await test('application-facing exports cannot reach the raw Borrow Kit or its write methods', async () => {
  assert.deepEqual(Object.keys(borrow).sort(), PUBLIC_EXPORTS)
  assert.equal(borrow.getMainnetBorrowKit, undefined)
  for (const [name, value] of Object.entries(borrow)) {
    assert.ok(!(value instanceof RealBorrowKit), `${name} is not a kit`)
    if (value !== null && typeof value === 'object') {
      for (const method of SDK_WRITE_METHODS) assert.notEqual(typeof value[method], 'function', `${name}.${method}`)
    }
  }

  // Public reads hand back plain data only, never the kit or a function.
  const { client } = fakeClient()
  const results = await callEveryRead(client, {})
  assert.ok(results.every((result) => result.status === 'available'))
  results.forEach((result, index) => assertPlainData(result, `read[${index}]`))

  // The kit is created once, inside the private getter, and the getter is
  // only used as the reads' default client and behind the write gate.
  assert.equal(libSource.match(/new BorrowKit\(/g)?.length, 1)
  const allowedKitLines = [
    /^let mainnetBorrowKit: BorrowKit \| null = null$/,
    /^function getMainnetBorrowKit\(\): BorrowKit \{$/,
    /^ {2}mainnetBorrowKit \?\?= new BorrowKit\(\{ disableAnalytics: true, disableErrorReporting: true \}\)$/,
    /^ {2}return mainnetBorrowKit$/,
    /^ {2}client: BorrowReadClient = getMainnetBorrowKit\(\),$/,
    /^ {4}const client = request\.client \?\? getMainnetBorrowKit\(\)$/,
  ]
  const kitLines = libSource.split('\n').filter((line) => /\b(getMainnetBorrowKit|mainnetBorrowKit)\b/.test(line))
  for (const line of kitLines) {
    assert.ok(allowedKitLines.some((pattern) => pattern.test(line)), `unexpected use of the raw kit: ${line.trim()}`)
  }
  const readFunctions = PUBLIC_EXPORTS.filter((name) => /^(explore|get|quote)/.test(name)).length
  assert.equal(kitLines.filter((line) => line.includes('client: BorrowReadClient = getMainnetBorrowKit()')).length, readFunctions)
  const executor = libSource.slice(libSource.indexOf('export async function executeBorrowWrite('))
  assert.ok(executor.indexOf('getMainnetBorrowKit()') > executor.indexOf("blockers: ['writes_disabled'] }"), 'the kit is reached only after the gate')

  // No other application module may import the SDK and call it directly.
  const sourceFiles = (directory) => readdirSync(directory).flatMap((entry) => {
    const path = join(directory, entry)
    return statSync(path).isDirectory() ? sourceFiles(path) : [path]
  })
  const sdkImporters = ['src', 'api', 'server']
    .flatMap((directory) => sourceFiles(join(root, directory)))
    .filter((path) => /\.(ts|tsx|js|mjs|cjs)$/.test(path))
    .filter((path) => /(from\s*|require\(\s*|import\(\s*)['"]@circle-fin\/(borrow-kit|provider-borrow-service)['"]/.test(readFileSync(path, 'utf8')))
  assert.deepEqual(sdkImporters, [libPath])
})

await test('caller input cannot override Arc or inject SDK config, base URL or credentials', async () => {
  const { client, calls } = fakeClient()
  const results = await callEveryRead(client, HOSTILE)
  assert.ok(results.every((result) => result.status === 'available'))
  assert.equal(calls.length, 12)
  for (const { method, params } of calls) {
    for (const key of Object.keys(params)) {
      assert.ok(REQUEST_FIELDS[method].includes(key), `${method} must not receive ${key}`)
    }
    // A borrow-more preview and a position read take no chain; the service
    // resolves it from the loan and the response chain is checked instead.
    const chainFree = method === 'getPosition' || (method === 'getBorrowQuote' && 'loanId' in params)
    if (chainFree) assert.ok(!('chain' in params), method)
    else assert.equal(params.chain, sdk.BorrowChain.Arc, method)
  }
  const sent = JSON.stringify(calls)
  for (const injected of ['Arc_Testnet', 'attacker', 'API_KEY', 'baseUrl', 'apiKey', 'providers', 'config']) {
    assert.ok(!sent.includes(injected), `${injected} reached the SDK`)
  }
})

await test('real SDK requests stay on Arc mainnet at api.circle.com with no credential', async () => {
  const start = fetchRequests.length
  const results = await callEveryRead(undefined, HOSTILE)
  const sent = fetchRequests.slice(start)
  assert.ok(results.every((result) => result.status === 'unavailable'), 'every fixture rejection is surfaced')
  assert.equal(sent.length, 12, sent.map((request) => request.url.pathname).join(', '))
  let arcScoped = 0
  for (const request of sent) {
    assert.equal(request.url.origin, 'https://api.circle.com')
    assert.ok(request.url.pathname.startsWith('/v1/borrowKit/'), request.url.pathname)
    assert.ok(!Object.keys(request.headers).some((header) => header.toLowerCase() === 'authorization'))
    const wire = JSON.stringify([request.url.href, request.body ?? null])
    for (const injected of ['ARC-TESTNET', 'Arc_Testnet', 'attacker', 'API_KEY']) {
      assert.ok(!wire.includes(injected), `${injected} reached ${request.url.pathname}`)
    }
    const chains = [
      request.url.searchParams.get('chain'),
      request.body?.chain,
      request.url.pathname.match(/^\/v1\/borrowKit\/markets\/([^/]+)\//)?.[1],
    ].filter((chain) => chain !== null && chain !== undefined)
    for (const chain of chains) assert.equal(chain, 'ARC', request.url.pathname)
    if (chains.length > 0) arcScoped += 1
  }
  assert.ok(arcScoped >= 5, `market, loan list and open-quote requests name ARC (${arcScoped})`)
  assert.deepEqual(defaultKitWriteCalls, [])
  assert.ok(!sent.some((request) => request.url.pathname.includes('stablecoinKits')))
})

await test('real SDK output for a wire-format market page still normalizes', async () => {
  const wireMarket = {
    marketId: MARKET,
    protocol: 'morpho',
    chain: 'ARC',
    marketName: 'cirBTC/USDC',
    loanAsset: { symbol: 'USDC', address: USDC, decimals: 6 },
    collateralAsset: { symbol: 'cirBTC', address: COLLATERAL, decimals: 8 },
    lltv: 0.86,
    borrowAssets: { raw: '15033884374', decimals: 6 },
    liquidity: { raw: '0', decimals: 6 },
    borrowApy: 0.005998,
    utilization: 1,
    refreshedAt: '2026-10-02T22:49:06.068038Z',
  }
  fetchResponder = (url) => (url.pathname === '/v1/borrowKit/markets'
    ? new Response(JSON.stringify({ data: { markets: [wireMarket], pagination: {} } }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    : rejectRequest())
  let page
  try {
    page = await borrow.exploreBorrowMarkets()
  } finally {
    fetchResponder = rejectRequest
  }
  assert.equal(page.status, 'available', JSON.stringify(page))
  assert.equal(page.data.nextPageAfter, null)
  assert.deepEqual(page.data.items, [{
    marketId: MARKET,
    protocol: 'morpho',
    loanAsset: { symbol: 'USDC', address: USDC, decimals: 6 },
    collateralAsset: { symbol: 'cirBTC', address: COLLATERAL, decimals: 8 },
    lltv: 0.86,
    borrowApy: 0.005998,
    utilization: 1,
    borrowAssets: usdc('15033.884374'),
    // A reported zero stays a zero; it is verified data, not a missing value.
    liquidity: usdc('0'),
    refreshedAt: '2026-10-02T22:49:06.068038Z',
  }])
})

await test('EIP-5792 capability detection reads wallet_getCapabilities only', async () => {
  const requests = []
  const wallet = (response) => async (args) => {
    requests.push(args)
    if (response instanceof Error) throw response
    return response
  }
  assert.equal(await borrow.detectAtomicBatchCapability(wallet({ '0x13b2': { atomic: { status: 'supported' } } }), WALLET), 'supported')
  assert.equal(await borrow.detectAtomicBatchCapability(wallet({ '0x13b2': { atomic: { status: 'ready' } } }), WALLET), 'supported')
  assert.equal(await borrow.detectAtomicBatchCapability(wallet({ '0x0': { atomic: { status: 'supported' } } }), WALLET), 'supported')
  assert.equal(await borrow.detectAtomicBatchCapability(wallet({ '0x13b2': { atomic: { status: 'unsupported' } } }), WALLET), 'unsupported')
  assert.equal(await borrow.detectAtomicBatchCapability(wallet({ '0x1': { atomic: { status: 'supported' } } }), WALLET), 'unsupported')
  assert.equal(await borrow.detectAtomicBatchCapability(wallet({}), WALLET), 'unsupported')
  assert.equal(await borrow.detectAtomicBatchCapability(wallet(new Error('Method not found')), WALLET), 'unsupported')
  assert.equal(await borrow.detectAtomicBatchCapability(wallet({ '0x13b2': { atomic: {} } }), WALLET), 'unknown')
  assert.equal(await borrow.detectAtomicBatchCapability(wallet(null), WALLET), 'unknown')
  const before = requests.length
  assert.equal(await borrow.detectAtomicBatchCapability(wallet({}), 'nope'), 'unknown')
  assert.equal(requests.length, before)
  assert.ok(requests.every(({ method, params }) => method === 'wallet_getCapabilities' && params[0] === WALLET && params[1][0] === '0x13b2'))
})

await test('no private key, seed phrase, API key, approval or transaction path in Borrow sources', () => {
  for (const [name, source] of [['config', configSource], ['lib', libSource]]) {
    for (const forbidden of [
      /private\s*key|privateKey|createViemAdapterFromPrivateKey/i,
      /mnemonic|seed\s*phrase|seedPhrase/i,
      /apiKey|API_KEY/,
      /import\.meta\.env|process\.env|localStorage|sessionStorage/,
      /\.approve\(|setAuthorization|maxUint256|MaxUint256/,
      /wallet_sendCalls|eth_sendTransaction|eth_sendRawTransaction|sendTransaction|writeContract|signTypedData|personal_sign/,
    ]) {
      assert.ok(!forbidden.test(source), `${name} must not match ${forbidden}`)
    }
  }
})

await test('SDK write calls exist only behind the write gate in executeBorrowWrite', () => {
  const start = libSource.indexOf('export async function executeBorrowWrite(')
  assert.ok(start > 0)
  const body = libSource.slice(start)
  const gate = body.indexOf("if (MAINNET_BORROW_WRITES_ENABLED !== true) return { status: 'refused', blockers: ['writes_disabled'] }")
  assert.ok(gate > 0, 'gate check present')
  for (const method of borrow.MAINNET_BORROW_WRITE_METHODS) {
    const pattern = new RegExp(`client\\.${method}\\(`, 'g')
    const total = libSource.match(pattern)?.length ?? 0
    const guarded = body.match(pattern)?.length ?? 0
    assert.ok(total > 0, `${method} adapter exists`)
    assert.equal(total, guarded, `${method} is only called inside executeBorrowWrite`)
    assert.ok(body.search(pattern) > gate, `${method} follows the gate`)
  }
  assert.ok(body.indexOf('getAdapter()') > gate, 'adapter is created after the gate')
})

await test('Borrow stays isolated from UI, Earn, Bridge and the intelligence engine', () => {
  const sourceFiles = (directory) => readdirSync(directory).flatMap((entry) => {
    const path = join(directory, entry)
    return statSync(path).isDirectory() ? sourceFiles(path) : [path]
  })
  const importers = sourceFiles(join(root, 'src'))
    .filter((path) => /\.(ts|tsx)$/.test(path) && path !== libPath && path !== configPath)
    .filter((path) => /mainnetBorrow|borrow-kit/.test(readFileSync(path, 'utf8')))
  assert.deepEqual(importers, [], 'no UI or other module imports Borrow yet')
  const engine = sourceFiles(join(root, 'server/compact')).filter((path) => /borrow-kit|mainnetBorrow/.test(readFileSync(path, 'utf8')))
  assert.deepEqual(engine, [])
  assert.ok(!/earn-kit|bridge-kit|server\//.test(libSource))
})

console.log(`\nBorrow adapter checks: ${passed} passed`)
