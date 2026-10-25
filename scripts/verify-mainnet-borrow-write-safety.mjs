// Transaction safety checks for the Borrow writes. No network, no wallet, no writes, and the write gate is never opened: the
// shared safety layer and the write boundary (verifyBorrowWriteBoundary) are checked with fake SDK reads and a fake wallet.
// executeBorrowWrite is only ever called with the gate closed, where it must refuse before touching anything.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const ts = require('typescript')
require.extensions['.ts'] = (loadedModule, filename) => {
  const { outputText } = ts.transpileModule(readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
    fileName: filename,
  })
  loadedModule._compile(outputText, filename)
}

const root = fileURLToPath(new URL('..', import.meta.url))
const configPath = join(root, 'src/config/mainnetBorrow.ts')
const configSource = readFileSync(configPath, 'utf8')

// Nothing here may reach the network: the SDK is only ever given fake clients, and fetch fails loudly.
let fetchCalls = 0
globalThis.fetch = async () => {
  fetchCalls += 1
  throw new Error('no network in this check')
}
const sdk = require('@circle-fin/borrow-kit')
const writeCallsOnDefaultKit = []
for (const method of ['borrow', 'repay', 'addCollateral', 'withdrawCollateralRepayIfNeeded', 'closeLoan', 'retry']) {
  sdk.BorrowKit.prototype[method] = async function recordWrite() {
    writeCallsOnDefaultKit.push(method)
    throw new Error(`write method ${method} must not run`)
  }
}
const config = require(configPath)
const borrow = require(join(root, 'src/lib/mainnetBorrow.ts'))
const safety = require(join(root, 'src/lib/borrowWriteSafety.ts'))
const ledgers = require(join(root, 'src/lib/borrowAttemptLedger.ts'))
assert.equal(config.MAINNET_BORROW_WRITES_ENABLED, false, 'the write gate is closed and this script never opens it')

let passed = 0
async function test(name, run) {
  await run()
  passed += 1
  console.log(`PASS ${name}`)
}

// ---------------------------------------------------------------------------------------------------------------------
// Fixtures

const NOW = 1_800_000_000_000
const SECOND = 1000
const WALLET = '0x1111111111111111111111111111111111111111'
const OTHER = '0x2222222222222222222222222222222222222222'
const MARKET = `0x${'ab'.repeat(32)}`
const OTHER_MARKET = `0x${'cd'.repeat(32)}`
const LOAN = '11111111-1111-4111-8111-111111111111'
const OTHER_LOAN = '22222222-2222-4222-8222-222222222222'
const USDC = '0x3600000000000000000000000000000000000000'
const CIRBTC = '0x171a4217b86a807a64eb94757db6849fb4bdbaa0'
const ORACLE = '0x2AA87fF48933Ce6aBA240BEE916Fc2e6Ec1e51Ab'
const IRM = '0xF02615d094Fc02fC031C35fe705e175aA4653f20'
const SESSION = `${WALLET.toLowerCase()}@5042`
const KEY = '33333333-3333-4333-8333-333333333333'

const usdc = (amount) => ({ token: 'USDC', tokenAddress: USDC, amount, decimals: 6 })
const cirbtc = (amount) => ({ token: 'cirBTC', tokenAddress: CIRBTC, amount, decimals: 8 })
const gas = [{ name: 'execute', fees: { gas: '210000', gasPrice: '160000000000', fee: '33600000000000000' } }]
const READY_WALLET = { address: WALLET, chainId: 5042, atomicBatch: 'supported', atomicBatchFor: SESSION }

const MARKET_WIRE = {
  marketId: MARKET, protocol: 'morpho', chain: 'Arc',
  loanAsset: { symbol: 'USDC', address: USDC, decimals: 6 }, collateralAsset: { symbol: 'cirBTC', address: CIRBTC, decimals: 8 },
  lltv: 0.86, borrowCap: null, borrowAssets: usdc('1250000.5'), liquidity: usdc('400000'), borrowApy: 0.0612, utilization: 0.5,
  refreshedAt: '2026-10-01T12:00:00.000Z',
}
const LOAN_WIRE = {
  loanId: LOAN, chain: 'Arc', marketId: MARKET, walletAddress: WALLET, dataStatus: 'READY', collateral: cirbtc('0.05'), borrowed: usdc('1000.25'),
  principalBorrowed: usdc('1000'), accruedInterest: usdc('0.25'), borrowApy: 0.0612, ltv: 0.4, healthFactor: 2.6, healthFactorBand: 'SAFE',
  liquidationPrice: usdc('23255.81'), status: 'active',
}
const MARKET_DATA = borrow.normalizeBorrowMarket(MARKET_WIRE)
const POSITION = borrow.normalizeBorrowPosition(LOAN_WIRE)
const VERIFIED = {
  status: 'verified',
  details: {
    params: { loanToken: USDC, collateralToken: CIRBTC, oracle: ORACLE, irm: IRM, lltv: 860000000000000000n },
    oraclePrice: 8140086n * 10n ** 32n,
    liquidity: 500_000n * 10n ** 6n,
  },
}
const BALANCES = {
  native: 5000n * 10n ** 18n,
  loanToken: { address: USDC, raw: 5000n * 10n ** 6n },
  collateralToken: { address: CIRBTC, raw: 1n * 10n ** 8n },
}

const ACTIONS = {
  'borrow': { kind: 'borrow', marketId: MARKET, borrowAmount: '1000' },
  'borrow-more': { kind: 'borrow-more', loanId: LOAN, borrowAmount: '1000' },
  'repay': { kind: 'repay', loanId: LOAN, repayAmount: '10' },
  'add-collateral': { kind: 'add-collateral', loanId: LOAN, collateralAmount: '0.01' },
  'withdraw-collateral': { kind: 'withdraw-collateral', loanId: LOAN, collateralAmount: '0.01' },
  'close-loan': { kind: 'close-loan', loanId: LOAN },
}
const METHOD = {
  'borrow': 'getBorrowQuote', 'borrow-more': 'getBorrowQuote', 'repay': 'getRepayQuote', 'add-collateral': 'getAddCollateralQuote',
  'withdraw-collateral': 'getWithdrawCollateralRepayIfNeededQuote', 'close-loan': 'getCloseLoanQuote',
}
const RESPONSES = {
  'borrow': {
    chain: 'Arc', collateralAmount: cirbtc('0.05'), loanAssetAmount: usdc('1000'), borrowApy: 0.0612, fees: [{ type: 'circle', token: 'USDC', amount: usdc('1.5') }],
    gasFees: gas, resultingHealthFactor: 2.6, resultingLtv: 0.33, resultingBand: 'SAFE', liquidationPrice: usdc('23255.81'),
  },
  'repay': { chain: 'Arc', repayAmount: usdc('10'), fees: [], gasFees: gas, resultingHealthFactor: 2.7, resultingLtv: 0.32, resultingBand: 'SAFE', liquidationPrice: usdc('23000') },
  'add-collateral': { chain: 'Arc', collateralAmount: cirbtc('0.01'), fees: [], gasFees: gas, resultingHealthFactor: 3.1, resultingLtv: 0.27, resultingBand: 'SAFE', liquidationPrice: usdc('19000') },
  'withdraw-collateral': {
    chain: 'Arc', bundledRepayment: usdc('0'), collateralAmount: cirbtc('0.01'), fees: [], gasFees: gas, resultingHealthFactor: 2.1, resultingLtv: 0.41, resultingBand: 'SAFE', liquidationPrice: usdc('28000'),
  },
  'close-loan': {
    chain: 'Arc', bundledRepayment: usdc('1030.26'), collateralAmount: cirbtc('0.05'), fees: [], gasFees: gas, resultingHealthFactor: null, resultingLtv: null, resultingBand: 'SAFE', liquidationPrice: null,
  },
}
RESPONSES['borrow-more'] = RESPONSES.borrow

// A fake SDK client: reads answer from the table, write methods fail the check if they are ever reached.
function fakeClient(responses) {
  const calls = []
  const client = {}
  for (const method of borrow.MAINNET_BORROW_READ_METHODS) {
    client[method] = async (params) => {
      calls.push({ method, params })
      const response = responses[method]
      if (response instanceof Error) throw response
      return structuredClone(response)
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
const writeCalls = (calls) => calls.filter(({ method }) => borrow.MAINNET_BORROW_WRITE_METHODS.includes(method))

function baseEvidence(kind) {
  return {
    session: SESSION,
    market: { data: structuredClone(MARKET_DATA), fetchedAt: NOW - 2 * SECOND },
    verification: { marketId: MARKET, result: structuredClone(VERIFIED), checkedAt: NOW - 2 * SECOND },
    position: kind === 'borrow' ? null : { data: structuredClone(POSITION), fetchedAt: NOW - 3 * SECOND },
    loans: { data: { items: kind === 'borrow' ? [] : [structuredClone(POSITION)], complete: true }, fetchedAt: NOW - 3 * SECOND },
    balances: { data: structuredClone(BALANCES), fetchedAt: NOW - 4 * SECOND },
    targetHealthFactor: 1.5,
  }
}

// A complete, valid context for one action kind. The quote goes through the real prepareBorrowQuote with a fake client, so
// the quote is bound to its request exactly as in production. `mutate` edits the SDK answer, action, wallet or evidence first.
async function build(kind, mutate = () => {}) {
  const draft = {
    action: structuredClone(ACTIONS[kind]), response: structuredClone(RESPONSES[kind]), wallet: { ...READY_WALLET },
    evidence: baseEvidence(kind), attempts: [], now: NOW, quoteAt: NOW - SECOND,
  }
  mutate(draft)
  const { client, calls } = fakeClient({ [METHOD[kind]]: draft.response })
  const prepared = await borrow.prepareBorrowQuote(draft.action, WALLET, client, () => draft.quoteAt)
  assert.equal(prepared.status, 'available', `${kind}: the fixture quote normalizes`)
  assert.deepEqual(writeCalls(calls), [])
  return { action: draft.action, context: { wallet: draft.wallet, quote: prepared.data, evidence: draft.evidence, attempts: draft.attempts, attemptLog: HEALTHY_LOG, now: draft.now } }
}

const withoutGate = (plan) => plan.blockers.filter((blocker) => blocker !== 'writes_disabled')
async function blockersOf(kind, mutate, after = () => {}) {
  const { action, context } = await build(kind, mutate)
  after(context)
  return withoutGate(borrow.planBorrowWrite(action, context))
}
const KINDS = Object.keys(ACTIONS)
const HEALTHY_LOG = { ok: true, persistent: true, reason: null }

// Browser storage stand-in: a Map, with switches to make it fail the way real storage can.
function fakeStorage(initial = {}) {
  const data = new Map(Object.entries(initial))
  const storage = {
    data,
    broken: false, // every call throws (storage blocked or unavailable)
    dropWrites: false, // writes are accepted and silently lost
    failWrites: false, // writes throw (quota, private mode)
    getItem(key) { if (storage.broken) throw new Error('SecurityError'); return data.has(key) ? data.get(key) : null },
    setItem(key, value) { if (storage.broken || storage.failWrites) throw new Error('QuotaExceededError'); if (!storage.dropWrites) data.set(key, value) },
  }
  return storage
}
const persistent = (storage, instanceId = 'page-1', address = WALLET) => ledgers.createPersistentAttemptLedger(storage, address, 5042, { instanceId })

// ---------------------------------------------------------------------------------------------------------------------
// The shared layer: exact arithmetic

await test('amounts are exact integer units: finer than the token is refused, never rounded', () => {
  assert.equal(safety.decimalToUnits('1000', 6), 1_000_000_000n)
  assert.equal(safety.decimalToUnits('0.000001', 6), 1n)
  assert.equal(safety.decimalToUnits('1.50', 2), 150n, 'trailing zeros are not extra precision')
  assert.equal(safety.decimalToUnits('0.0000001', 6), null)
  assert.equal(safety.decimalToUnits('1e3', 6), null)
  assert.equal(safety.decimalToUnits('-1', 6), null)
  assert.equal(safety.unitsToDecimal(1_000_000_001n, 6), '1000.000001')
  assert.equal(safety.unitsToDecimal(5n * 10n ** 18n, 18), '5')
})

await test('the wallet session ties address and network together', () => {
  assert.equal(safety.borrowWalletSession(WALLET, 5042), SESSION)
  assert.equal(safety.borrowWalletSession(WALLET.toUpperCase().replace('0X', '0x'), 5042), SESSION)
  assert.notEqual(safety.borrowWalletSession(WALLET, 1), SESSION)
  assert.notEqual(safety.borrowWalletSession(OTHER, 5042), SESSION)
  assert.equal(safety.borrowWalletSession('nope', 5042), null)
  assert.equal(safety.borrowWalletSession(WALLET, null), null)
})

// ---------------------------------------------------------------------------------------------------------------------
// Every action kind has a clean pass path; with the gate closed the only blocker is the gate

await test('all six action kinds are prepared; with every check passing the only blocker is the closed write gate', async () => {
  for (const kind of KINDS) {
    const { action, context } = await build(kind)
    const plan = borrow.planBorrowWrite(action, context)
    assert.deepEqual(plan.blockers, ['writes_disabled'], `${kind}: ${JSON.stringify(plan.checks.filter((c) => c.status === 'fail' || c.status === 'unknown'))}`)
    assert.equal(plan.ready, false, 'never ready while the gate is closed')
    assert.equal(plan.chainId, 5042)
    assert.equal(plan.approvalSpender, config.MAINNET_BORROW_ADAPTER_CONTRACT)
    assert.ok(plan.actionId.startsWith(`${action.kind}|5042|${WALLET}|`))
    assert.equal(safety.borrowReadiness(plan.checks).status, 'ready', kind)
  }
  assert.deepEqual(borrow.planBorrowWrite(ACTIONS.borrow, (await build('borrow')).context).walletRequests,
    ['collateral-approval-if-short', 'morpho-authorization-grant', 'adapter-execution', 'morpho-authorization-revoke'])
  assert.deepEqual(borrow.planBorrowWrite(ACTIONS.repay, (await build('repay')).context).walletRequests, ['usdc-approval-if-short', 'adapter-execution'])
})

// ---------------------------------------------------------------------------------------------------------------------
// Wallet, network, capability, session

await test('wallet: missing, wrong network and incompatible wallets are never ready; no separate-transaction fallback is offered', async () => {
  for (const kind of KINDS) {
    const missing = borrow.planBorrowWrite(ACTIONS[kind], { ...(await build(kind)).context, wallet: null })
    assert.ok(missing.blockers.includes('wallet_missing') && missing.blockers.includes('wrong_chain') && missing.blockers.includes('wallet_capability_missing'), kind)
    assert.equal(safety.borrowReadiness(missing.checks).status, 'unavailable', `${kind}: no wallet is missing data, not a broken rule`)
  }
  for (const [wallet, blocker] of [[{ ...READY_WALLET, chainId: 1, atomicBatchFor: `${WALLET.toLowerCase()}@1` }, 'wrong_chain'], [{ ...READY_WALLET, atomicBatch: 'unsupported' }, 'wallet_capability_missing']]) {
    const built = await build('borrow')
    const plan = borrow.planBorrowWrite(ACTIONS.borrow, { ...built.context, wallet })
    assert.ok(plan.blockers.includes(blocker))
    assert.equal(safety.borrowReadiness(plan.checks).status, 'blocked', 'a wrong network or an unsupported wallet is a block')
  }
  assert.ok((await blockersOf('borrow', (d) => { d.wallet.chainId = 1 })).includes('wrong_chain'))
  assert.ok((await blockersOf('borrow', (d) => { d.wallet.chainId = 5042002 })).includes('wrong_chain'))
  assert.ok((await blockersOf('borrow', (d) => { d.wallet.address = '0x12' })).includes('wallet_missing'))
  assert.ok((await blockersOf('borrow', (d) => { d.wallet.atomicBatch = 'unsupported' })).includes('wallet_capability_missing'))
  assert.ok((await blockersOf('borrow', (d) => { d.wallet.atomicBatch = 'unknown' })).includes('wallet_capability_missing'))
  const { action, context } = await build('borrow', (d) => { d.wallet.atomicBatch = 'unsupported' })
  const unsupported = borrow.planBorrowWrite(action, context)
  const text = unsupported.checks.find((c) => c.id === 'wallet-capability').text
  assert.match(text, /does not fall back to separate approval and borrow transactions/)
  assert.deepEqual(unsupported.walletRequests, ['collateral-approval-if-short', 'morpho-authorization-grant', 'adapter-execution', 'morpho-authorization-revoke'], 'one atomic batch, never a split plan')
})

await test('wallet or network change: the capability answer and every read belong to one session and stop counting when it changes', async () => {
  // The capability was read for another wallet or another network.
  assert.ok((await blockersOf('borrow', (d) => { d.wallet.atomicBatchFor = `${OTHER.toLowerCase()}@5042` })).includes('stale_wallet_session'))
  assert.ok((await blockersOf('borrow', (d) => { d.wallet.atomicBatchFor = `${WALLET.toLowerCase()}@1` })).includes('stale_wallet_session'))
  assert.ok((await blockersOf('borrow', (d) => { d.wallet.atomicBatchFor = undefined })).includes('stale_wallet_session'))
  // Every read was made for another session (the user switched wallet or network after reading).
  assert.ok((await blockersOf('borrow', (d) => { d.evidence.session = `${OTHER.toLowerCase()}@5042` })).includes('stale_wallet_session'))
  assert.ok((await blockersOf('borrow', (d) => { d.evidence.session = `${WALLET.toLowerCase()}@1` })).includes('stale_wallet_session'))
  // The same reads with the wallet switched: the plan is for the new wallet and the old quote does not answer it.
  const { action, context } = await build('borrow')
  const switched = borrow.planBorrowWrite(action, { ...context, wallet: { address: OTHER, chainId: 5042, atomicBatch: 'supported', atomicBatchFor: `${OTHER.toLowerCase()}@5042` } })
  assert.ok(switched.blockers.includes('stale_wallet_session') && switched.blockers.includes('quote_request_mismatch'))
  assert.notEqual(switched.actionId, borrow.planBorrowWrite(action, context).actionId, 'the action ID names the wallet')
  assert.equal(safety.borrowReadiness(switched.checks).status, 'blocked')
})

await test('chain and adapter addresses: the SDK Arc definition must equal the pinned chain and Borrow Adapter', () => {
  const base = { action: ACTIONS.repay, wallet: READY_WALLET, quote: null, evidence: null, attempts: [], attemptLog: HEALTHY_LOG, now: NOW }
  const addresses = (chain) => safety.evaluateBorrowWriteSafety({ ...base, chain }).checks.find((c) => c.id === 'chain-addresses')
  assert.equal(addresses({ chainId: 5042, adapter: config.MAINNET_BORROW_ADAPTER_CONTRACT }).status, 'pass')
  assert.equal(addresses({ chainId: 5042, adapter: config.MAINNET_BORROW_ADAPTER_CONTRACT.toLowerCase() }).status, 'pass')
  assert.equal(addresses({ chainId: 5042, adapter: OTHER }).status, 'fail')
  assert.equal(addresses({ chainId: 1, adapter: config.MAINNET_BORROW_ADAPTER_CONTRACT }).status, 'fail')
  assert.equal(addresses({ chainId: null, adapter: null }).status, 'unknown', 'a missing definition blocks')
})

// ---------------------------------------------------------------------------------------------------------------------
// Quote: bound to its request, fresh, consistent

await test('quote: missing, stale, future-dated and changed quotes are unusable', async () => {
  for (const kind of KINDS) {
    const missing = borrow.planBorrowWrite(ACTIONS[kind], { ...(await build(kind)).context, quote: null })
    assert.ok(missing.blockers.includes('quote_missing'), kind)
    assert.equal(safety.borrowReadiness(missing.checks).status, 'unavailable', 'a missing quote is unavailable, not blocked')
  }
  assert.deepEqual(await blockersOf('borrow', (d) => { d.quoteAt = NOW - 60 * SECOND }), [], 'exactly at the limit is still fresh')
  assert.deepEqual(await blockersOf('borrow', (d) => { d.quoteAt = NOW - 60 * SECOND - 1 }), ['quote_stale'])
  assert.deepEqual(await blockersOf('borrow', (d) => { d.quoteAt = NOW - 10 * 60 * SECOND }), ['quote_stale'])
  assert.deepEqual(await blockersOf('borrow', (d) => { d.quoteAt = NOW + 5 * SECOND }), [], 'a little clock skew is tolerated')
  assert.deepEqual(await blockersOf('borrow', (d) => { d.quoteAt = NOW + 5 * SECOND + 1 }), ['quote_stale'])
  assert.deepEqual(await blockersOf('borrow', (d) => { d.quoteAt = Number.NaN }), ['quote_stale'])
  // A quote that aged out while the page stayed open: same quote, later clock.
  assert.deepEqual(await blockersOf('borrow', (d) => { d.now = NOW + 120 * SECOND }).then((b) => b.includes('quote_stale')), true)
})

await test('quote: bound to market or loan, wallet, amount, slippage and kind', async () => {
  const request = (mutation) => blockersOf('borrow', () => {}, (context) => mutation(context.quote.request))
  assert.deepEqual(await request((r) => { r.amount = '999' }), ['quote_request_mismatch'])
  assert.deepEqual(await request((r) => { r.marketId = OTHER_MARKET }), ['quote_request_mismatch'])
  assert.deepEqual(await request((r) => { r.walletAddress = OTHER }), ['quote_request_mismatch'])
  assert.deepEqual(await request((r) => { r.slippageBps = 100 }), ['quote_request_mismatch'])
  assert.deepEqual(await request((r) => { r.kind = 'borrow-more' }), ['quote_request_mismatch'])
  for (const kind of KINDS.filter((k) => k !== 'borrow')) {
    assert.deepEqual(await blockersOf(kind, () => {}, (context) => { context.quote.request.loanId = OTHER_LOAN }), ['quote_request_mismatch'], kind)
  }
  // The answer itself must be the action's: kind and amount.
  assert.ok((await blockersOf('borrow', () => {}, (c) => { c.quote.quote.loanAsset.amount = '999' })).includes('quote_mismatch'))
  assert.ok((await blockersOf('repay', () => {}, (c) => { c.quote.quote.repayAmount.amount = '9' })).includes('quote_mismatch'))
  assert.ok((await blockersOf('add-collateral', () => {}, (c) => { c.quote.quote.collateral.amount = '0.02' })).includes('quote_mismatch'))
  assert.ok((await blockersOf('withdraw-collateral', () => {}, (c) => { c.quote.quote.collateral.amount = '0.02' })).includes('quote_mismatch'))
  assert.ok((await blockersOf('repay', () => {}, (c) => { c.quote.quote = { ...(c.quote.quote), kind: 'add-collateral' } })).includes('quote_mismatch'))
  // The same decimal written differently is the same amount.
  assert.deepEqual(await blockersOf('borrow', (d) => { d.response.loanAssetAmount = usdc('1000.000') }), [])
})

await test('quote: tokens must be the market\'s own, gas must be reported, slippage stays within the limit', async () => {
  const wrongToken = { token: 'USDC', tokenAddress: OTHER, amount: '1000', decimals: 6 }
  assert.ok((await blockersOf('borrow', () => {}, (c) => { c.quote.quote.loanAsset = wrongToken })).includes('quote_token_mismatch'))
  assert.ok((await blockersOf('borrow', () => {}, (c) => { c.quote.quote.collateral = { ...c.quote.quote.collateral, tokenAddress: OTHER } })).includes('quote_token_mismatch'))
  assert.ok((await blockersOf('borrow', () => {}, (c) => { c.quote.quote.loanAsset = { ...c.quote.quote.loanAsset, decimals: 18 } })).includes('quote_token_mismatch'))
  assert.ok((await blockersOf('close-loan', () => {}, (c) => { c.quote.quote.maxRepayment = { ...c.quote.quote.maxRepayment, tokenAddress: OTHER } })).includes('quote_token_mismatch'))
  for (const kind of KINDS) {
    assert.deepEqual(await blockersOf(kind, (d) => { d.response.gasFees = [] }), ['gas_unknown'], kind)
  }
  assert.deepEqual(await blockersOf('close-loan', (d) => { d.action.slippageBps = 500 }), [])
  assert.deepEqual(await blockersOf('close-loan', (d) => { d.action.slippageBps = 0 }), [], '0 is a valid exact-or-fail bound')
  assert.deepEqual(await blockersOf('close-loan', (d) => { d.action.slippageBps = 501 }), ['slippage_invalid'], 'repayment headroom stays within 5%')
  assert.deepEqual(await blockersOf('withdraw-collateral', (d) => { d.action.slippageBps = 10_000 }), ['slippage_invalid'])
  // For new debt the setting is the collateral buffer Circle adds: any value the SDK accepts, because it can only add collateral and the
  // Health Factor, LTV and balance checks judge the quote it produces.
  assert.deepEqual(await blockersOf('borrow', (d) => { d.action.slippageBps = 2500 }), [])
  assert.deepEqual(await blockersOf('borrow', (d) => { d.action.slippageBps = 0 }), [])
  assert.deepEqual(await blockersOf('borrow-more', (d) => { d.action.slippageBps = 10_000 }), [])
  assert.equal(safety.borrowActionIsValid({ ...ACTIONS.borrow, slippageBps: 10_001 }), false, 'above the SDK maximum is not an action')
  assert.equal(safety.borrowActionIsValid({ ...ACTIONS.borrow, slippageBps: 10_000 }), true)
  const bufferedBuild = await build('borrow', (d) => { d.action.slippageBps = 2500 })
  const buffered = borrow.planBorrowWrite(bufferedBuild.action, bufferedBuild.context)
  assert.match(buffered.checks.find((c) => c.id === 'slippage').text, /^Collateral buffer 25\.00% \(Circle's slippage setting, which adds this much to the collateral it sizes\)/)
  const defaultSlippage = (await build('borrow')).context.quote.request.slippageBps
  assert.equal(defaultSlippage, 300, 'an omitted slippage is the service default, bound into the quote request')
})

// ---------------------------------------------------------------------------------------------------------------------
// Market, oracle, liquidity

await test('market: it must be read, be the action\'s market, be fresh and verified on-chain against Morpho', async () => {
  assert.ok((await blockersOf('borrow', (d) => { d.evidence.market = null })).includes('market_data_missing'))
  assert.ok((await blockersOf('borrow', (d) => { d.evidence.market.data.marketId = OTHER_MARKET })).includes('market_data_missing'))
  assert.ok((await blockersOf('borrow', (d) => { d.evidence.market.fetchedAt = NOW - 61 * SECOND })).includes('evidence_stale'))
  assert.ok((await blockersOf('borrow', (d) => { d.evidence.verification = null })).includes('market_unverified'))
  assert.ok((await blockersOf('borrow', (d) => { d.evidence.verification.marketId = OTHER_MARKET })).includes('market_unverified'))
  assert.ok((await blockersOf('borrow', (d) => { d.evidence.verification.checkedAt = NOW - 61 * SECOND })).includes('evidence_stale'))
  assert.ok((await blockersOf('borrow', (d) => { d.evidence.verification.result = { status: 'checking' } })).includes('market_unverified'))
  assert.ok((await blockersOf('borrow', (d) => { d.evidence.verification.result = { status: 'unavailable' } })).includes('market_unverified'))
  assert.ok((await blockersOf('borrow', (d) => { d.evidence.verification.result = { status: 'unverified', reasons: ['id_mismatch'], details: null } })).includes('market_unverified'))
  assert.ok((await blockersOf('borrow', (d) => { d.evidence.verification.result.details.params.collateralToken = OTHER })).includes('market_unverified'), 'tokens on-chain must be the quoted market\'s tokens')
  // Unavailable is data that is missing, blocked is a rule that is broken.
  const status = async (mutate) => { const { action, context } = await build('borrow', mutate); return safety.borrowReadiness(borrow.planBorrowWrite(action, context).checks).status }
  assert.equal(await status((d) => { d.evidence.verification.result = { status: 'unavailable' } }), 'unavailable')
  assert.equal(await status((d) => { d.evidence.verification.result = { status: 'unverified', reasons: ['id_mismatch'], details: null } }), 'blocked')
  // Loan actions: the market is the loan's market, and a loan in a different market than the one read is refused.
  assert.ok((await blockersOf('repay', (d) => { d.evidence.market.data.marketId = OTHER_MARKET })).includes('position_market_mismatch'))
})

await test('oracle: needed where a price decides the outcome (new debt, withdrawal); repaying and adding collateral do not need it', async () => {
  const noOracle = (d) => { d.evidence.verification.result = { status: 'unverified', reasons: ['oracle_price_unavailable'], details: { ...d.evidence.verification.result.details, oraclePrice: null } } }
  assert.deepEqual(await blockersOf('borrow', noOracle), ['oracle_unavailable'])
  assert.deepEqual(await blockersOf('borrow-more', noOracle), ['oracle_unavailable'])
  assert.deepEqual(await blockersOf('withdraw-collateral', noOracle), ['oracle_unavailable'])
  for (const kind of ['repay', 'add-collateral', 'close-loan']) assert.deepEqual(await blockersOf(kind, noOracle), [], `${kind} does not depend on the oracle price`)
  assert.deepEqual(await blockersOf('borrow', (d) => { d.evidence.verification.result.details.oraclePrice = 0n }), ['oracle_unavailable'])
})

await test('liquidity: compared exactly against the lower of Circle and on-chain; unknown liquidity blocks; only new debt needs it', async () => {
  const atLimit = (d) => { d.action.borrowAmount = '400000'; d.response.loanAssetAmount = usdc('400000') }
  assert.deepEqual(await blockersOf('borrow', atLimit), [], 'exactly the available liquidity')
  const oneUnitOver = (d) => { d.action.borrowAmount = '400000.000001'; d.response.loanAssetAmount = usdc('400000.000001') }
  assert.deepEqual(await blockersOf('borrow', oneUnitOver), ['insufficient_liquidity'], 'one smallest unit over, which a rounded display would hide')
  // Circle reports more than the chain holds: the lower figure wins.
  const chainLower = (d) => { d.evidence.verification.result.details.liquidity = 399_999n * 10n ** 6n }
  assert.deepEqual(await blockersOf('borrow', (d) => { chainLower(d); atLimit(d) }), ['insufficient_liquidity'])
  // Circle lower than the chain: also the lower figure.
  assert.deepEqual(await blockersOf('borrow', (d) => { d.evidence.market.data.liquidity = usdc('999'); d.action.borrowAmount = '1000' }), ['insufficient_liquidity'])
  // Only one source reported: that source decides. Neither: unknown, never "enough".
  assert.deepEqual(await blockersOf('borrow', (d) => { d.evidence.market.data.liquidity = null }), [])
  assert.deepEqual(await blockersOf('borrow', (d) => { d.evidence.market.data.liquidity = null; d.evidence.verification.result.details.liquidity = 999n * 10n ** 6n }), ['insufficient_liquidity'])
  assert.deepEqual(await blockersOf('borrow', (d) => {
    d.evidence.market.data.liquidity = null
    d.evidence.verification.result = { status: 'unverified', reasons: ['oracle_price_unavailable'], details: null }
  }).then((b) => b.includes('liquidity_unknown')), true)
  assert.deepEqual(await blockersOf('borrow', (d) => { d.evidence.market.data.liquidity = usdc('0') }), ['insufficient_liquidity'], 'zero liquidity')
  const text = (await build('borrow', oneUnitOver)).context
  assert.match(borrow.planBorrowWrite(ACTIONS.borrow, { ...text, quote: null }).checks.find((c) => c.id === 'liquidity').text, /Insufficient Liquidity|within/)
  // Repaying and adding collateral never draw on liquidity.
  for (const kind of ['repay', 'add-collateral', 'withdraw-collateral', 'close-loan']) {
    assert.deepEqual(await blockersOf(kind, (d) => { d.evidence.market.data.liquidity = usdc('0') }), [], kind)
  }
})

// ---------------------------------------------------------------------------------------------------------------------
// New debt: 70% LTV and the selected Health Factor target, on raw values

await test('LTV: at most 70%, compared raw; derived from LLTV ÷ health factor when the quote has none; unknown blocks', async () => {
  const ltv = (value, hf = 2.6) => (d) => { d.response.resultingLtv = value; d.response.resultingHealthFactor = hf }
  assert.deepEqual(await blockersOf('borrow', ltv(0.7)), [], 'exactly the limit is within it')
  assert.deepEqual(await blockersOf('borrow', ltv(0.7000001)), ['ltv_above_limit'], 'a figure that displays as 70% but is above it')
  assert.deepEqual(await blockersOf('borrow', ltv(0.7000000001)), ['ltv_above_limit'])
  assert.deepEqual(await blockersOf('borrow', ltv(0.6999999)), [])
  assert.deepEqual(await blockersOf('borrow-more', ltv(0.9)), ['ltv_above_limit'])
  // Derived: 0.86 / 1.2 = 71.7% is above the limit, 0.86 / 1.5 = 57.3% is within.
  assert.deepEqual(await blockersOf('borrow', (d) => { ltv(null, 1.2)(d); d.evidence.targetHealthFactor = 1.1 }), ['ltv_above_limit'])
  assert.deepEqual(await blockersOf('borrow', ltv(null, 1.5)), [])
  assert.deepEqual(await blockersOf('borrow', (d) => { d.response.resultingLtv = null; d.response.resultingHealthFactor = null }).then((b) => b.includes('ltv_unknown')), true)
})

await test('Health Factor target: a quote below the selected target blocks, judged on the raw number (1.24 against 1.50)', async () => {
  const hf = (value, target = 1.5) => (d) => { d.response.resultingHealthFactor = value; d.response.resultingLtv = 0.5; d.evidence.targetHealthFactor = target }
  assert.deepEqual(await blockersOf('borrow', hf(1.24)), ['health_target_not_met'])
  assert.deepEqual(await blockersOf('borrow-more', hf(1.24)), ['health_target_not_met'])
  assert.deepEqual(await blockersOf('borrow', hf(1.5)), [], 'exactly the target')
  assert.deepEqual(await blockersOf('borrow', hf(1.4999999)), ['health_target_not_met'], 'displays as 1.50, is below it')
  assert.deepEqual(await blockersOf('borrow', hf(1.504)), [])
  assert.deepEqual(await blockersOf('borrow', hf(1.9, 2)), ['health_target_not_met'])
  const { action, context } = await build('borrow', hf(1.24))
  const plan = borrow.planBorrowWrite(action, context)
  const readiness = safety.borrowReadiness(plan.checks)
  assert.equal(readiness.status, 'blocked')
  assert.match(readiness.reason, /^Selected safety target not met: .*1\.24.*1\.5/)
  assert.equal(safety.healthTargetMet(1.24, 1.5), false); assert.equal(safety.healthTargetMet(1.4999999, 1.5), false); assert.equal(safety.healthTargetMet(1.5, 1.5), true)
  assert.equal(safety.healthTargetMet(null, 1.5), null)
  // Missing data is not a pass.
  assert.deepEqual(await blockersOf('borrow', (d) => { d.response.resultingHealthFactor = null; d.response.resultingLtv = 0.5 }), ['health_unknown'])
  assert.deepEqual(await blockersOf('borrow', (d) => { d.evidence.targetHealthFactor = null }), ['health_unknown'])
  assert.deepEqual(await blockersOf('borrow', (d) => { d.evidence.targetHealthFactor = 1 }), ['health_unknown'], 'a target at or below the liquidation threshold is no target')
  // Circle's default collateral is the only supported path: no other collateral is ever prepared.
  assert.ok(!('collateralAmount' in ACTIONS.borrow) && !('collateral' in ACTIONS.borrow))
  assert.ok(!/collateralAmount/.test(readFileSync(join(root, 'src/lib/mainnetBorrow.ts'), 'utf8').slice(readFileSync(join(root, 'src/lib/mainnetBorrow.ts'), 'utf8').indexOf('export async function executeBorrowWrite')).match(/client\.borrow\([^)]*\)/g)?.join('') ?? ''), 'borrow() is never given a collateral amount')
})

await test('debt-reducing and collateral-adding actions are not blocked by the new-borrow rules', async () => {
  const riskyButHelpful = (d) => { d.response.resultingLtv = 0.95; d.response.resultingHealthFactor = 1.05; d.evidence.targetHealthFactor = 2 }
  assert.deepEqual(await blockersOf('repay', riskyButHelpful), [], 'repay on a loan that stays above 70% LTV and below the target')
  assert.deepEqual(await blockersOf('add-collateral', riskyButHelpful), [])
  assert.deepEqual(await blockersOf('repay', (d) => { riskyButHelpful(d); d.evidence.market.data.utilization = 0.999; d.evidence.market.data.liquidity = usdc('0') }), [])
  const liquidatable = (d) => { d.evidence.position.data.healthFactor = 0.9; d.evidence.position.data.healthBand = 'LIQUIDATABLE' }
  assert.deepEqual(await blockersOf('repay', liquidatable), [], 'a loan already below the threshold can still be repaid')
  assert.deepEqual(await blockersOf('add-collateral', liquidatable), [])
  for (const kind of ['repay', 'add-collateral']) {
    const checks = borrow.planBorrowWrite(ACTIONS[kind], (await build(kind, riskyButHelpful)).context).checks
    assert.equal(checks.find((c) => c.id === 'ltv').status, 'not-applicable', kind)
  }
  // Borrow and Borrow more keep their risk limits under the very same numbers.
  assert.deepEqual(await blockersOf('borrow', riskyButHelpful), ['ltv_above_limit', 'health_target_not_met'])
})

await test('utilization is a warning, never a blocker, and says nothing about the amount available', async () => {
  const { action, context } = await build('borrow', (d) => { d.evidence.market.data.utilization = 0.95 })
  const plan = borrow.planBorrowWrite(action, context)
  assert.deepEqual(withoutGate(plan), [])
  const warn = plan.checks.find((c) => c.id === 'utilization')
  assert.equal(warn.status, 'warn')
  assert.match(warn.text, /High market utilization \(95\.0%\): most supplied funds are already lent out.*variable borrow rate can rise quickly.*rate risk, not the amount available/)
  assert.equal(safety.borrowReadiness(plan.checks).status, 'ready')
  assert.equal(safety.borrowReadiness(plan.checks).warnings, 1)
})

// ---------------------------------------------------------------------------------------------------------------------
// Loans: owner, state, first open vs borrow more

await test('first borrow: an existing loan in the market means Borrow more; the wallet\'s loans must be fully read and fresh', async () => {
  assert.deepEqual(await blockersOf('borrow', (d) => { d.evidence.loans.data.items = [structuredClone(POSITION)] }), ['loan_exists'])
  assert.deepEqual(await blockersOf('borrow', (d) => { d.evidence.loans.data.items = [{ ...structuredClone(POSITION), lifecycle: 'closed' }] }), [], 'a closed loan does not count')
  assert.deepEqual(await blockersOf('borrow', (d) => { d.evidence.loans.data.items = [{ ...structuredClone(POSITION), marketId: OTHER_MARKET }] }), [], 'a loan in another market does not count')
  assert.deepEqual(await blockersOf('borrow', (d) => { d.evidence.loans.data.items = [{ ...structuredClone(POSITION), lifecycle: 'unreported' }] }), ['loan_exists'])
  assert.deepEqual(await blockersOf('borrow', (d) => { d.evidence.loans.data.complete = false }), ['loans_unknown'])
  assert.deepEqual(await blockersOf('borrow', (d) => { d.evidence.loans = null }), ['loans_unknown'])
  assert.deepEqual(await blockersOf('borrow', (d) => { d.evidence.loans.fetchedAt = NOW - 61 * SECOND }), ['evidence_stale'])
})

await test('loan actions: the real loan must be read, be the wallet\'s, be active and indexed, and be fresh', async () => {
  for (const kind of KINDS.filter((k) => k !== 'borrow')) {
    assert.ok((await blockersOf(kind, (d) => { d.evidence.position = null })).includes('position_missing'), `${kind}: not read`)
    assert.ok((await blockersOf(kind, (d) => { d.evidence.position.fetchedAt = NOW - 61 * SECOND })).includes('evidence_stale'), `${kind}: stale`)
    assert.ok((await blockersOf(kind, (d) => { d.evidence.position.data.loanId = OTHER_LOAN })).includes('position_missing'), `${kind}: another loan was read`)
    assert.ok((await blockersOf(kind, (d) => { d.evidence.position.data.owner = OTHER })).includes('position_not_owned'), `${kind}: another wallet's loan`)
    assert.ok((await blockersOf(kind, (d) => { d.evidence.position.data.lifecycle = 'closed' })).includes('position_not_active'), `${kind}: closed`)
    assert.ok((await blockersOf(kind, (d) => { d.evidence.position.data.lifecycle = 'unreported' })).includes('position_not_active'), `${kind}: status not reported`)
    assert.ok((await blockersOf(kind, (d) => { d.evidence.position.data.economics = 'pending' })).includes('position_not_active'), `${kind}: not indexed yet`)
  }
  const { action, context } = await build('repay', (d) => { d.evidence.position.data.owner = OTHER })
  assert.equal(safety.borrowReadiness(borrow.planBorrowWrite(action, context).checks).status, 'blocked')
  const status = async (mutate) => { const built = await build('repay', mutate); return safety.borrowReadiness(borrow.planBorrowWrite(built.action, built.context).checks).status }
  assert.equal(await status((d) => { d.evidence.position = null }), 'unavailable')
  assert.equal(await status((d) => { d.evidence.position.data.economics = 'pending' }), 'unavailable')
})

// ---------------------------------------------------------------------------------------------------------------------
// Repay, Close, Withdraw, Add collateral

await test('repay: stays below the debt (interest keeps accruing); a full repayment is Close loan', async () => {
  const repay = (amount) => (d) => { d.action.repayAmount = amount; d.response.repayAmount = usdc(amount) }
  assert.deepEqual(await blockersOf('repay', repay('1000.249999')), [])
  assert.deepEqual(await blockersOf('repay', repay('1000.25')), ['repay_exceeds_debt'], 'exactly the debt leaves interest-sized dust')
  assert.deepEqual(await blockersOf('repay', repay('2000')), ['repay_exceeds_debt'])
  const note = borrow.planBorrowWrite(ACTIONS.repay, (await build('repay')).context).checks.find((c) => c.id === 'repay-debt').text
  assert.match(note, /990\.25 USDC of debt remains \(plus interest that keeps accruing\)/)
  assert.deepEqual(await blockersOf('repay', (d) => { d.evidence.position.data.borrowed = null }), ['repay_exceeds_debt'])
})

await test('close loan: the ceiling must cover the debt, the collateral must be the loan\'s, and the wallet must be able to fund it', async () => {
  assert.deepEqual(await blockersOf('close-loan', (d) => { d.response.bundledRepayment = usdc('1000.25') }), [], 'a ceiling equal to the debt covers it')
  assert.deepEqual(await blockersOf('close-loan', (d) => { d.response.bundledRepayment = usdc('1000.249999') }), ['residual_debt'])
  assert.deepEqual(await blockersOf('close-loan', (d) => { d.evidence.position.data.borrowed = usdc('1031') }), ['residual_debt'], 'interest accrued since the quote: debt above the ceiling')
  assert.deepEqual(await blockersOf('close-loan', (d) => { d.evidence.position.data.borrowed = null }), ['residual_debt'])
  assert.deepEqual(await blockersOf('close-loan', (d) => { d.response.collateralAmount = cirbtc('0.04') }), ['quote_mismatch'])
  assert.deepEqual(await blockersOf('close-loan', (d) => { d.evidence.balances.data.loanToken.raw = 1030_259_999n }), ['insufficient_balance'], 'one unit short of the ceiling')
  assert.deepEqual(await blockersOf('close-loan', (d) => { d.evidence.balances.data.loanToken.raw = 1_030_260_000n }), [])
  assert.deepEqual(await blockersOf('close-loan', (d) => { d.evidence.position.data.borrowed = usdc('0'); d.response.bundledRepayment = usdc('0') }), [], 'a loan with no debt closes by returning its collateral')
})

await test('withdraw collateral: must stay within the loan\'s collateral and must meet the selected Health Factor target', async () => {
  assert.deepEqual(await blockersOf('withdraw-collateral', (d) => { d.action.collateralAmount = '0.05'; d.response.collateralAmount = cirbtc('0.05') }), [])
  assert.deepEqual(await blockersOf('withdraw-collateral', (d) => { d.action.collateralAmount = '0.050001'; d.response.collateralAmount = cirbtc('0.050001') }), ['withdraw_exceeds_collateral'])
  assert.deepEqual(await blockersOf('withdraw-collateral', (d) => { d.response.resultingHealthFactor = 1.24 }), ['withdraw_unhealthy'])
  assert.deepEqual(await blockersOf('withdraw-collateral', (d) => { d.response.resultingHealthFactor = 1.0 }), ['withdraw_unhealthy'])
  assert.deepEqual(await blockersOf('withdraw-collateral', (d) => { d.response.resultingHealthFactor = 1.4999999 }), ['withdraw_unhealthy'], 'raw, not rounded')
  assert.deepEqual(await blockersOf('withdraw-collateral', (d) => { d.response.resultingHealthFactor = 1.5 }), [])
  assert.deepEqual(await blockersOf('withdraw-collateral', (d) => { d.response.resultingHealthFactor = null }), ['health_unknown'], 'debt remains and no health factor is reported')
  assert.deepEqual(await blockersOf('withdraw-collateral', (d) => { d.evidence.targetHealthFactor = null }), ['health_unknown'])
  // No debt: nothing to liquidate, so no health factor is needed.
  assert.deepEqual(await blockersOf('withdraw-collateral', (d) => { d.evidence.position.data.borrowed = usdc('0'); d.response.resultingHealthFactor = null }), [])
  // The service sized a repayment inside the withdrawal: the wallet must be able to fund its ceiling.
  assert.deepEqual(await blockersOf('withdraw-collateral', (d) => { d.response.bundledRepayment = usdc('50'); d.evidence.balances.data.loanToken.raw = 49_999_999n }), ['insufficient_balance'])
  assert.deepEqual(await blockersOf('withdraw-collateral', (d) => { d.response.bundledRepayment = usdc('50') }), [])
})

await test('add collateral: needs the loan and the collateral in the wallet, nothing else', async () => {
  assert.deepEqual(await blockersOf('add-collateral', (d) => { d.evidence.balances.data.collateralToken.raw = 999_999n }), ['insufficient_balance'])
  assert.deepEqual(await blockersOf('add-collateral', (d) => { d.evidence.balances.data.collateralToken.raw = 1_000_000n }), [])
})

// ---------------------------------------------------------------------------------------------------------------------
// Balances and gas

await test('balances: a balance that is missing, stale, for other tokens or too small blocks; USDC gas and USDC repayment are checked together', async () => {
  for (const kind of KINDS) {
    assert.ok((await blockersOf(kind, (d) => { d.evidence.balances = null })).includes('balance_unknown'), kind)
    assert.ok((await blockersOf(kind, (d) => { d.evidence.balances.fetchedAt = NOW - 61 * SECOND })).includes('evidence_stale'), kind)
    assert.ok((await blockersOf(kind, (d) => { d.evidence.balances.data.native = null })).includes('balance_unknown'), `${kind}: native balance unreadable`)
    assert.ok((await blockersOf(kind, (d) => { d.evidence.balances.data.native = 33_599_999_999_999_999n })).includes('insufficient_gas_balance'), `${kind}: one wei short of gas`)
  }
  assert.ok((await blockersOf('borrow', (d) => { d.evidence.balances.data.loanToken.address = OTHER })).includes('balance_unknown'))
  assert.ok((await blockersOf('borrow', (d) => { d.evidence.balances.data.collateralToken.raw = null })).includes('balance_unknown'), 'an unreadable balance is never zero or enough')
  assert.deepEqual(await blockersOf('borrow', (d) => { d.evidence.balances.data.collateralToken.raw = 4_999_999n }), ['insufficient_balance'], 'one unit short of the 0.05 cirBTC collateral')
  assert.deepEqual(await blockersOf('borrow', (d) => { d.evidence.balances.data.collateralToken.raw = 5_000_000n }), [])
  // A borrow receives USDC: only gas is needed in the wallet. A repayment of USDC also leaves through the same USDC gas balance.
  assert.deepEqual(await blockersOf('borrow', (d) => { d.evidence.balances.data.loanToken.raw = 0n; d.evidence.balances.data.native = 33_600_000_000_000_000n }), [])
  assert.deepEqual(await blockersOf('repay', (d) => { d.evidence.balances.data.native = 5n * 10n ** 18n }), ['insufficient_gas_balance'], 'a 10 USDC repayment does not fit in 5 USDC of native balance even though the token balance is enough')
  assert.deepEqual(await blockersOf('repay', (d) => { d.evidence.balances.data.native = 10n * 10n ** 18n }), ['insufficient_gas_balance'], '10 USDC repayment + gas does not fit in 10 USDC')
  assert.deepEqual(await blockersOf('repay', (d) => { d.evidence.balances.data.native = 10_033_600_000_000_000_000n }), [])
  assert.deepEqual(await blockersOf('repay', (d) => { d.evidence.balances.data.native = 10_033_599_999_999_999_999n }), ['insufficient_gas_balance'])
})

// ---------------------------------------------------------------------------------------------------------------------
// Readiness status words

await test('readiness: Ready for review needs every check; Blocked is a broken rule; Unavailable is missing data; warnings never block', () => {
  const check = (status) => ({ id: status, blocker: 'quote_missing', status, text: status })
  assert.equal(safety.borrowReadiness([check('pass'), check('not-applicable'), check('warn')]).status, 'ready')
  assert.equal(safety.borrowReadiness([check('pass'), check('unknown')]).status, 'unavailable')
  assert.equal(safety.borrowReadiness([check('unknown'), check('fail')]).status, 'blocked')
  assert.equal(safety.borrowReadiness([check('unknown'), check('fail')]).reason, 'fail', 'the broken rule is the reason, ahead of missing data')
  assert.equal(safety.borrowReadiness([]).status, 'ready', 'no checks is not evidence; the planner always produces checks')
  const ordered = safety.orderWriteChecks([check('pass'), check('warn'), check('unknown'), check('not-applicable'), check('fail'), check('pass')]).map((c) => c.status)
  assert.deepEqual(ordered, ['fail', 'unknown', 'warn', 'pass', 'pass', 'not-applicable'])
})

// ---------------------------------------------------------------------------------------------------------------------
// Attempts: double clicks, unknown outcomes, a second send

const SCOPE_A = `5042|${WALLET.toLowerCase()}|${MARKET}`
const RECORD = (over = {}) => ({ scopeId: SCOPE_A, actionId: `borrow|5042|${WALLET.toLowerCase()}|${MARKET}|1000|300`, kind: 'borrow', idempotencyKey: KEY, ...over })

await test('attempts: one unresolved write per wallet, network and market or loan, whatever its amount, buffer or kind', async () => {
  const { action, context } = await build('borrow')
  const plan = borrow.planBorrowWrite(action, context)
  assert.equal(plan.scopeId, SCOPE_A)
  assert.equal(safety.borrowAttemptScope(action, WALLET), SCOPE_A)
  assert.equal(safety.borrowAttemptScope({ ...action, borrowAmount: '1', slippageBps: 4000 }, WALLET), SCOPE_A, 'another amount and buffer: same scope')
  assert.notEqual(safety.borrowAttemptScope(action, OTHER), SCOPE_A, 'another wallet: another scope')
  assert.equal(safety.borrowAttemptScope({ ...ACTIONS.repay }, WALLET), `5042|${WALLET.toLowerCase()}|${LOAN}`)
  assert.equal(safety.borrowAttemptScope({ ...ACTIONS.repay, kind: 'add-collateral', collateralAmount: '1' }, WALLET), safety.borrowAttemptScope(ACTIONS.repay, WALLET), 'a repay and an added collateral on one loan share a scope')
  assert.equal(safety.borrowAttemptScope(ACTIONS.repay, null), '')
  for (const status of ['in-flight', 'submitted', 'interrupted', 'failed', 'confirmed']) {
    const record = { ...RECORD({ actionId: `borrow|5042|${WALLET.toLowerCase()}|${MARKET}|7|417` }), status, startedAt: 1, updatedAt: 2 }
    const blocked = borrow.planBorrowWrite(action, { ...context, attempts: [record] })
    assert.ok(blocked.blockers.includes('attempt_unresolved'), `${status}: a different amount and buffer on the same market is still blocked`)
    assert.equal(safety.borrowReadiness(blocked.checks).status, 'blocked')
    assert.match(blocked.checks.find((c) => c.id === 'attempt').text, /on this market/)
  }
  const interrupted = borrow.planBorrowWrite(action, { ...context, attempts: [{ ...RECORD(), status: 'interrupted', startedAt: 1, updatedAt: 2 }] })
  assert.match(interrupted.checks.find((c) => c.id === 'attempt').text, /closed or reloaded.*not known.*checked the loan and confirmed/)
  // Another loan or another wallet is not blocked.
  const other = await build('repay')
  assert.ok(!borrow.planBorrowWrite(other.action, { ...other.context, attempts: [{ ...RECORD(), status: 'submitted', startedAt: 1, updatedAt: 2 }] }).blockers.includes('attempt_unresolved'))
})

await test('attempt history: it must be saved across reloads and readable, or nothing is prepared', async () => {
  const check = async (log) => { const { action, context } = await build('repay'); const plan = borrow.planBorrowWrite(action, { ...context, attemptLog: log }); return { plan, check: plan.checks.find((c) => c.id === 'attempt-log') } }
  assert.equal((await check(HEALTHY_LOG)).check.status, 'pass')
  assert.match((await check(HEALTHY_LOG)).check.text, /do not cover other devices or cleared browser data/)
  for (const [log, text] of [
    [null, /not checked/],
    [{ ok: true, persistent: false, reason: null }, /not saved across reloads/],
    [{ ok: false, persistent: true, reason: 'storage_unavailable' }, /storage is not available/],
    [{ ok: false, persistent: true, reason: 'records_unreadable' }, /could not be read.*not cleared automatically/],
    [{ ok: false, persistent: true, reason: 'storage_write_failed' }, /refused the last write/],
  ]) {
    const { plan, check: c } = await check(log)
    assert.equal(c.status, 'unknown'); assert.match(c.text, text)
    assert.ok(plan.blockers.includes('attempt_store_unreliable'))
    assert.equal(safety.borrowReadiness(plan.checks).status, 'unavailable', 'an untrustworthy history is Unavailable, not a pass')
  }
  // A plan made without saying anything about the history is not ready either.
  const { action, context } = await build('repay')
  const unspecified = borrow.planBorrowWrite(action, { wallet: context.wallet, quote: context.quote, evidence: context.evidence, now: context.now })
  assert.ok(unspecified.blockers.includes('attempt_store_unreliable'))
})

await test('persistent ledger: records survive a reload, a cut-off send becomes "interrupted", and nothing clears on its own', () => {
  const storage = fakeStorage()
  const page1 = persistent(storage, 'page-1')
  assert.deepEqual(page1.health(), { ok: true, persistent: true, reason: null })
  assert.equal(page1.begin(RECORD(), 100), true)
  assert.equal(page1.begin(RECORD({ actionId: `borrow|5042|${WALLET.toLowerCase()}|${MARKET}|5|417` }), 101), false, 'a second click, or another amount, on the same market')
  assert.equal(page1.get(SCOPE_A).status, 'in-flight', 'this page sees its own send as running')
  const saved = [...storage.data.values()][0]
  assert.match(saved, /"status":"in-flight"/)
  // The page is reloaded while the send was running: a new page instance reads the same storage.
  const page2 = persistent(storage, 'page-2')
  assert.equal(page2.get(SCOPE_A).status, 'interrupted', 'the outcome of a cut-off send is unknown, not "failed" and not absent')
  assert.equal(page2.list().length, 1)
  assert.equal(page2.begin(RECORD(), 200), false, 'it cannot be sent again after the reload')
  page2.discard(SCOPE_A); assert.equal(page2.get(SCOPE_A).status, 'interrupted', 'a page cannot discard a send it did not start')
  page2.finish(SCOPE_A, 'failed', 300); assert.equal(page2.get(SCOPE_A).status, 'interrupted', 'nor finish one')
  // Resolving needs the person's confirmation and a position read after the attempt.
  assert.equal(page2.resolve(SCOPE_A, { positionReadAt: 500, acknowledged: false }), false)
  assert.equal(page2.resolve(SCOPE_A, { positionReadAt: 100, acknowledged: true }), false, 'a position read from before the attempt proves nothing')
  assert.equal(page2.resolve(SCOPE_A, { positionReadAt: 500, acknowledged: true }), false, 'a position timestamp cannot prove settlement of an interrupted submission')
  assert.equal(page2.list().length, 1)
  assert.equal(page2.begin(RECORD(), 600), false, 'unknown submissions remain blocked without independent receipt verification')
})

await test('persistent ledger: submitted, failed and confirmed attempts stay until resolved; a running one cannot be resolved', () => {
  const storage = fakeStorage()
  const ledger = persistent(storage)
  assert.equal(ledger.begin(RECORD(), 100), true)
  assert.equal(ledger.resolve(SCOPE_A, { positionReadAt: 999, acknowledged: true }), false, 'a send that is still running cannot be resolved')
  ledger.discard(SCOPE_A); assert.equal(ledger.get(SCOPE_A), null, 'a send that never reached the SDK is removed')
  for (const [status, detail] of [['submitted', { batchId: 'b1' }], ['failed', { errorCode: 'service_unavailable' }], ['confirmed', { batchId: 'b1', txHash: '0xabc' }]]) {
    const storage = fakeStorage(), ledger = persistent(storage)
    assert.equal(ledger.begin(RECORD(), 100), true)
    ledger.finish(SCOPE_A, status, 150, detail)
    const record = ledger.get(SCOPE_A)
    assert.equal(record.status, status); assert.equal(record.updatedAt, 150); assert.equal(record.idempotencyKey, KEY)
    for (const [field, value] of Object.entries(detail)) assert.equal(record[field], value)
    ledger.discard(SCOPE_A); assert.equal(ledger.get(SCOPE_A).status, status, `${status} is never discarded`)
    assert.equal(persistent(storage, 'page-2').get(SCOPE_A).status, status, `${status} survives a reload`)
    assert.equal(ledger.begin(RECORD(), 200), false)
    assert.equal(ledger.resolve(SCOPE_A, { positionReadAt: 150, acknowledged: true }), false, 'a read at the same moment is not after the attempt')
    assert.equal(ledger.resolve(SCOPE_A, { positionReadAt: 151, acknowledged: true }), false, 'SDK status plus a fresh position timestamp is not independent settlement proof')
    assert.equal(persistent(storage).list().length, 1, 'the unresolved record survives')
  }
  assert.equal(persistent(storage).list().length, 0)
})

await test('persistent ledger: records only apply to the wallet and network they were saved for', () => {
  const storage = fakeStorage()
  persistent(storage, 'page-1').begin(RECORD(), 100)
  assert.equal(persistent(storage, 'p', OTHER).list().length, 0, 'another wallet has its own history')
  assert.equal(persistent(storage, 'p', OTHER).health().ok, true)
  assert.equal(ledgers.createPersistentAttemptLedger(storage, WALLET, 1, { instanceId: 'p' }).list().length, 0, 'another network has its own history')
  const key = ledgers.attemptStorageKey(WALLET, 5042)
  assert.equal(key, `machina.borrow.attempts.v1:${WALLET.toLowerCase()}:5042`)
  assert.equal(ledgers.attemptStorageKey(WALLET.toUpperCase().replace('0X', '0x'), 5042), key, 'the address case does not split the history')
  // A record planted under this wallet's key but belonging to another wallet, network or kind makes the history unreadable.
  const foreign = (over) => fakeStorage({ [key]: JSON.stringify({ v: 1, records: [{ ...RECORD(), status: 'submitted', startedAt: 1, updatedAt: 2, session: 's', ...over }] }) })
  for (const [name, over] of [
    ['another wallet', { scopeId: `5042|${OTHER.toLowerCase()}|${MARKET}`, actionId: `borrow|5042|${OTHER.toLowerCase()}|${MARKET}|1|300` }],
    ['another network', { scopeId: `1|${WALLET.toLowerCase()}|${MARKET}` }],
    ['an action of another wallet', { actionId: `borrow|5042|${OTHER.toLowerCase()}|${MARKET}|1|300` }],
    ['a kind that does not match the action', { kind: 'repay' }],
    ['an unknown status', { status: 'done' }],
    ['an unknown field', { privateKey: '0x1' }],
    ['a bad time', { updatedAt: 0, startedAt: 5 }],
    ['a bad scope', { scopeId: 'x' }],
  ]) {
    const ledger = persistent(foreign(over))
    assert.deepEqual(ledger.health(), { ok: false, persistent: true, reason: 'records_unreadable' }, name)
    assert.deepEqual(ledger.list(), [], name)
    assert.equal(ledger.begin(RECORD({ scopeId: `5042|${WALLET.toLowerCase()}|${OTHER_MARKET}`, actionId: `borrow|5042|${WALLET.toLowerCase()}|${OTHER_MARKET}|1|300` }), 1), false, `${name}: nothing is recorded or sent on top of a history that cannot be read`)
  }
})

await test('persistent ledger: unreadable, unavailable or unwritable storage fails closed and is never reset', () => {
  const key = ledgers.attemptStorageKey(WALLET, 5042)
  for (const raw of ['{not json', 'null', '[]', '{"v":2,"records":[]}', '{"v":1}', '{"v":1,"records":"x"}', `{"v":1,"records":${JSON.stringify(Array(101).fill(0))}}`]) {
    const storage = fakeStorage({ [key]: raw })
    const ledger = persistent(storage)
    assert.deepEqual(ledger.health(), { ok: false, persistent: true, reason: 'records_unreadable' }, raw.slice(0, 30))
    assert.equal(ledger.begin(RECORD(), 1), false)
    ledger.discard(SCOPE_A); ledger.finish(SCOPE_A, 'failed', 2); ledger.resolve(SCOPE_A, { positionReadAt: 9, acknowledged: true })
    assert.equal(storage.data.get(key), raw, 'the unreadable history is left exactly as it is: not repaired, not emptied')
  }
  const duplicate = fakeStorage({ [key]: JSON.stringify({ v: 1, records: [1, 2].map(() => ({ ...RECORD(), status: 'submitted', startedAt: 1, updatedAt: 2, session: 's' })) }) })
  assert.equal(persistent(duplicate).health().reason, 'records_unreadable', 'two records for one scope are not understood')
  // No storage at all, or storage that throws.
  assert.deepEqual(ledgers.createPersistentAttemptLedger(null, WALLET, 5042).health(), { ok: false, persistent: true, reason: 'storage_unavailable' })
  const broken = fakeStorage(); broken.broken = true
  const ledger = persistent(broken)
  assert.equal(ledger.health().reason, 'storage_unavailable'); assert.equal(ledger.begin(RECORD(), 1), false); assert.deepEqual(ledger.list(), [])
  assert.equal(ledgers.createPersistentAttemptLedger(fakeStorage(), 'nope', 5042).health().reason, 'storage_unavailable', 'no address, no history')
  // A write that throws or is silently dropped is not a recorded attempt.
  for (const mode of ['failWrites', 'dropWrites']) {
    const storage = fakeStorage(); storage[mode] = true
    const l = persistent(storage)
    assert.equal(l.begin(RECORD(), 1), false, `${mode}: nothing goes ahead unrecorded`)
    assert.equal(l.health().reason, 'storage_write_failed', mode)
    storage[mode] = false
    assert.equal(l.begin(RECORD(), 2), true, `${mode}: once storage works again a new attempt is recorded`)
    assert.equal(l.health().ok, true)
  }
  // The in-memory ledger is never accepted for a real write.
  assert.deepEqual(ledgers.createBorrowAttemptLedger().health(), { ok: true, persistent: false, reason: null })
})

await test('persistent ledger: what is saved is small and public', () => {
  const storage = fakeStorage()
  const ledger = persistent(storage)
  ledger.begin(RECORD(), 100); ledger.finish(SCOPE_A, 'confirmed', 120, { batchId: 'b1', txHash: '0xabc' })
  const [[key, value]] = [...storage.data.entries()]
  assert.equal(key, ledgers.attemptStorageKey(WALLET, 5042))
  const saved = JSON.parse(value)
  assert.deepEqual(Object.keys(saved).sort(), ['records', 'v'])
  assert.deepEqual(Object.keys(saved.records[0]).sort(), ['actionId', 'batchId', 'idempotencyKey', 'kind', 'scopeId', 'session', 'startedAt', 'status', 'txHash', 'updatedAt'])
  assert.ok(!/key|seed|mnemonic|signature|balance|quote|health|collateral/i.test(Object.keys(saved.records[0]).filter((name) => name !== 'idempotencyKey').join(' ')))
  assert.equal(ledgers.browserAttemptStorage === undefined, false)
  const source = readFileSync(join(root, 'src/lib/borrowAttemptLedger.ts'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
  assert.ok(!/privateKey|mnemonic|seedPhrase|signTypedData|personal_sign|sendTransaction|wallet_sendCalls|fetch\(|@circle-fin|BorrowKit|sessionStorage|document\.cookie|indexedDB/.test(source), 'no wallet, SDK, network or other storage')
  const start = source.indexOf('export function browserAttemptStorage()')
  const without = source.slice(0, start) + source.slice(source.indexOf('\n}\n', start))
  assert.ok(start > 0 && !/localStorage/.test(without) && /localStorage/.test(source), 'localStorage is only touched inside browserAttemptStorage')
})

// ---------------------------------------------------------------------------------------------------------------------
// Quote changes between review and execution

await test('a quote that changed after review is not used: other amounts, a lower Health Factor or a higher LTV', async () => {
  const reviewed = (await build('borrow')).context.quote
  const next = async (mutate) => (await build('borrow', mutate)).context.quote
  assert.equal(safety.borrowQuoteChange(reviewed, await next(() => {})), null)
  assert.equal(safety.borrowQuoteChange(reviewed, await next((d) => { d.response.collateralAmount = cirbtc('0.05000001') })), 'amounts')
  assert.equal(safety.borrowQuoteChange(reviewed, await next((d) => { d.response.loanAssetAmount = usdc('999.999999'); d.action.borrowAmount = '999.999999' })), 'request')
  assert.equal(safety.borrowQuoteChange(reviewed, await next((d) => { d.response.resultingHealthFactor = 2.59 })), 'health-factor')
  assert.equal(safety.borrowQuoteChange(reviewed, await next((d) => { d.response.resultingHealthFactor = null })), 'health-factor')
  assert.equal(safety.borrowQuoteChange(reviewed, await next((d) => { d.response.resultingLtv = 0.34 })), 'ltv')
  assert.equal(safety.borrowQuoteChange(reviewed, await next((d) => { d.response.resultingHealthFactor = 2.7; d.response.resultingLtv = 0.3 })), null, 'a safer position is not a change to refuse')
  assert.equal(safety.borrowQuoteChange(reviewed, await next((d) => { d.response.gasFees = [{ name: 'x', fees: { gas: '1', gasPrice: '1', fee: '99' } }] })), null, 'gas is shown again, not compared')
  const other = (await build('borrow-more')).context.quote
  assert.equal(safety.borrowQuoteChange(reviewed, other), 'request')
})

// ---------------------------------------------------------------------------------------------------------------------
// The write boundary (verifyBorrowWriteBoundary): fresh reads, same checks, wallet, double sends. No gate, no SDK write access.

function boundary(kind, overrides = {}, mutate) {
  return build(kind, mutate).then(({ action, context }) => {
    const plan = borrow.planBorrowWrite(action, context)
    const counters = { readWallet: 0, refresh: 0, getAdapter: 0, getAddress: [] }
    const request = {
      action,
      reviewedQuote: context.quote,
      confirmedActionId: plan.actionId,
      readWallet: async () => { counters.readWallet += 1; return { ...READY_WALLET } },
      refresh: async () => { counters.refresh += 1; return { quote: context.quote, evidence: context.evidence } },
      getAdapter: async () => {
        counters.getAdapter += 1
        return { getAddress: async (chain) => { counters.getAddress.push(chain); return WALLET } }
      },
      attempts: persistent(fakeStorage()),
      clock: () => NOW,
      newIdempotencyKey: () => KEY,
      ...overrides,
    }
    return { request, counters, context, action, plan }
  })
}

await test('boundary: fresh reads, the same checks and the right wallet clear a write for every kind, with one registered attempt', async () => {
  for (const kind of KINDS) {
    const { request, counters, action } = await boundary(kind)
    const result = await borrow.verifyBorrowWriteBoundary(request)
    assert.equal(result.status, 'cleared', kind)
    assert.equal(result.idempotencyKey, KEY)
    assert.deepEqual(counters, { readWallet: 1, refresh: 1, getAdapter: 1, getAddress: [counters.getAddress[0]] })
    assert.equal(counters.getAddress[0].chainId, 5042, 'the adapter is asked for its address on the Arc definition')
    assert.equal(request.attempts.get(result.plan.scopeId).status, 'in-flight')
    assert.equal(request.attempts.get(result.plan.scopeId).idempotencyKey, KEY)
    // The plan is the fresh one, and it names the wallet read now.
    assert.ok(result.plan.actionId.startsWith(`${action.kind}|5042|${WALLET}|`))
  }
})

await test('boundary: a second call while one is running, and a call after an unresolved attempt, are refused', async () => {
  const { request, counters } = await boundary('repay')
  const [first, second] = await Promise.all([borrow.verifyBorrowWriteBoundary(request), borrow.verifyBorrowWriteBoundary(request)])
  assert.deepEqual([first.status, second.status].sort(), ['cleared', 'refused'], 'two clicks at once: exactly one goes ahead')
  assert.deepEqual((first.status === 'refused' ? first : second).blockers, ['attempt_unresolved'])
  assert.equal(counters.getAdapter, 1, 'the second call never built an adapter')
  assert.equal(counters.refresh, 1)
  // After the first ends unknown, a third call stays refused until the position is read again.
  const scopeId = (first.status === 'cleared' ? first : second).plan.scopeId
  request.attempts.finish(scopeId, 'submitted', NOW + 1000)
  assert.deepEqual((await borrow.verifyBorrowWriteBoundary(request)).blockers, ['attempt_unresolved'])
  assert.equal(counters.getAdapter, 1)
  assert.equal(request.attempts.resolve(scopeId, { positionReadAt: NOW + 2000, acknowledged: true }), false)
  assert.equal((await borrow.verifyBorrowWriteBoundary(request)).status, 'refused', 'a fresh service position cannot settle an unknown batch')
})

await test('boundary: the confirmed action must be this action for this wallet', async () => {
  const { request, counters } = await boundary('repay', { confirmedActionId: 'repay|5042|other' })
  assert.deepEqual(await borrow.verifyBorrowWriteBoundary(request), { status: 'refused', blockers: ['not_confirmed'] })
  assert.deepEqual([counters.refresh, counters.getAdapter], [0, 0])
  assert.equal(request.attempts.list().length, 0)
  // The wallet was switched after the review: the action ID names the wallet, so the confirmation no longer fits.
  const switched = await boundary('repay', { readWallet: async () => ({ address: OTHER, chainId: 5042, atomicBatch: 'supported', atomicBatchFor: `${OTHER.toLowerCase()}@5042` }) })
  assert.deepEqual(await borrow.verifyBorrowWriteBoundary(switched.request), { status: 'refused', blockers: ['not_confirmed'] })
  assert.deepEqual([switched.counters.refresh, switched.counters.getAdapter], [0, 0])
  const invalid = await boundary('repay', { action: { kind: 'repay', loanId: 'nope', repayAmount: '1' } })
  assert.deepEqual(await borrow.verifyBorrowWriteBoundary(invalid.request), { status: 'refused', blockers: ['invalid_action'] })
  const nobody = await boundary('repay', { readWallet: async () => null })
  assert.deepEqual(await borrow.verifyBorrowWriteBoundary(nobody.request), { status: 'refused', blockers: ['wallet_missing'] })
  const throws = await boundary('repay', { readWallet: async () => { throw new Error('locked') } })
  assert.deepEqual(await borrow.verifyBorrowWriteBoundary(throws.request), { status: 'refused', blockers: ['wallet_missing'] })
})

await test('boundary: network or capability changed since the review is refused on the fresh wallet read', async () => {
  for (const [name, wallet, blocker] of [
    ['wrong network', { ...READY_WALLET, chainId: 1, atomicBatchFor: `${WALLET.toLowerCase()}@1` }, 'wrong_chain'],
    ['lost capability', { ...READY_WALLET, atomicBatch: 'unsupported' }, 'wallet_capability_missing'],
    ['capability read for another session', { ...READY_WALLET, atomicBatchFor: `${WALLET.toLowerCase()}@1` }, 'stale_wallet_session'],
  ]) {
    const { request, counters } = await boundary('borrow', { readWallet: async () => wallet })
    const result = await borrow.verifyBorrowWriteBoundary(request)
    assert.equal(result.status, 'refused', name)
    assert.ok(result.blockers.includes(blocker), `${name}: ${result.blockers}`)
    assert.equal(counters.getAdapter, 0, `${name}: no adapter`)
    assert.equal(request.attempts.list().length, 0, `${name}: the attempt was removed`)
  }
  // Reads made for another wallet session are not accepted for this one.
  const { request, counters } = await boundary('borrow', {}, () => {})
  const stale = { ...request, refresh: async () => ({ quote: (await request.refresh()).quote, evidence: { ...(await request.refresh()).evidence, session: `${OTHER.toLowerCase()}@5042` } }) }
  const result = await borrow.verifyBorrowWriteBoundary(stale)
  assert.ok(result.blockers.includes('stale_wallet_session'))
  assert.equal(counters.getAdapter, 0)
})

await test('boundary: every safety check is run again on the fresh reads, even if the review passed', async () => {
  const scenarios = [
    ['liquidity gone', 'borrow', (d) => { d.evidence.market.data.liquidity = usdc('1') }, 'insufficient_liquidity'],
    ['LTV above 70%', 'borrow', (d) => { d.response.resultingLtv = 0.71 }, 'ltv_above_limit'],
    ['Health Factor 1.24 against 1.50', 'borrow', (d) => { d.response.resultingHealthFactor = 1.24 }, 'health_target_not_met'],
    ['market no longer verified', 'borrow-more', (d) => { d.evidence.verification.result = { status: 'unverified', reasons: ['id_mismatch'], details: null } }, 'market_unverified'],
    ['oracle gone', 'withdraw-collateral', (d) => { d.evidence.verification.result.details.oraclePrice = 0n }, 'oracle_unavailable'],
    ['loan no longer the wallet\'s', 'repay', (d) => { d.evidence.position.data.owner = OTHER }, 'position_not_owned'],
    ['residual debt', 'close-loan', (d) => { d.evidence.position.data.borrowed = usdc('2000') }, 'residual_debt'],
    ['wallet short of tokens', 'add-collateral', (d) => { d.evidence.balances.data.collateralToken.raw = 0n }, 'insufficient_balance'],
    ['stale quote', 'repay', (d) => { d.quoteAt = NOW - 90 * SECOND }, 'quote_stale'],
  ]
  for (const [name, kind, mutate, blocker] of scenarios) {
    // The fresh reads differ from the reviewed ones: the review was taken on a good context.
    const reviewed = await build(kind)
    const fresh = await build(kind, mutate)
    const { request, counters } = await boundary(kind, { reviewedQuote: reviewed.context.quote, refresh: async () => ({ quote: fresh.context.quote, evidence: fresh.context.evidence }) })
    const result = await borrow.verifyBorrowWriteBoundary(request)
    assert.equal(result.status, 'refused', name)
    assert.ok(result.blockers.includes(blocker), `${name}: ${result.blockers}`)
    assert.equal(counters.getAdapter, 0, `${name}: no adapter is built`)
    assert.equal(request.attempts.list().length, 0, `${name}: nothing stays registered`)
  }
})

await test('boundary: a fresh quote that differs from the reviewed one is refused; a safer or equal one is accepted', async () => {
  const reviewed = (await build('borrow')).context.quote
  const run = async (mutate) => {
    const fresh = await build('borrow', mutate)
    const { request, counters } = await boundary('borrow', { reviewedQuote: reviewed, refresh: async () => ({ quote: fresh.context.quote, evidence: fresh.context.evidence }) })
    return { result: await borrow.verifyBorrowWriteBoundary(request), counters, request }
  }
  for (const [name, mutate] of [
    ['more collateral pulled', (d) => { d.response.collateralAmount = cirbtc('0.06') }],
    ['lower Health Factor (still above the target)', (d) => { d.response.resultingHealthFactor = 1.9 }],
    ['higher LTV (still within 70%)', (d) => { d.response.resultingLtv = 0.5 }],
  ]) {
    const { result, counters, request } = await run(mutate)
    assert.deepEqual(result, { status: 'refused', blockers: ['quote_changed'] }, name)
    assert.equal(counters.getAdapter, 0, name)
    assert.equal(request.attempts.list().length, 0, name)
  }
  assert.equal((await run((d) => { d.response.resultingHealthFactor = 2.8; d.response.resultingLtv = 0.3 })).result.status, 'cleared')
  const none = await boundary('borrow', { reviewedQuote: null })
  assert.deepEqual(await borrow.verifyBorrowWriteBoundary(none.request), { status: 'refused', blockers: ['quote_changed'] }, 'nothing was reviewed')
})

await test('boundary: failed reads, a different wallet behind the adapter and a missing adapter are refused and leave nothing registered', async () => {
  const noRefresh = await boundary('repay', { refresh: async () => { throw new Error('service down') } })
  assert.deepEqual(await borrow.verifyBorrowWriteBoundary(noRefresh.request), { status: 'refused', blockers: ['evidence_missing'] })
  assert.equal(noRefresh.request.attempts.list().length, 0, 'a read that failed can be retried')
  const empty = await boundary('repay', { refresh: async () => ({ quote: null, evidence: null }) })
  const emptyResult = await borrow.verifyBorrowWriteBoundary(empty.request)
  assert.equal(emptyResult.status, 'refused'); assert.ok(emptyResult.blockers.includes('quote_missing') && emptyResult.blockers.includes('evidence_missing'))
  const wrongOwner = await boundary('repay', { getAdapter: async () => ({ getAddress: async () => OTHER }) })
  assert.deepEqual(await borrow.verifyBorrowWriteBoundary(wrongOwner.request), { status: 'refused', blockers: ['wallet_changed'] })
  assert.equal(wrongOwner.request.attempts.list().length, 0)
  const noAdapter = await boundary('repay', { getAdapter: async () => { throw new Error('no wallet client') } })
  assert.deepEqual(await borrow.verifyBorrowWriteBoundary(noAdapter.request), { status: 'refused', blockers: ['wallet_changed'] })
  const badAddress = await boundary('repay', { getAdapter: async () => ({ getAddress: async () => undefined }) })
  assert.deepEqual(await borrow.verifyBorrowWriteBoundary(badAddress.request), { status: 'refused', blockers: ['wallet_changed'] })
  const caseOnly = await boundary('repay', { getAdapter: async () => ({ getAddress: async () => WALLET.toUpperCase().replace('0X', '0x') }) })
  assert.equal((await borrow.verifyBorrowWriteBoundary(caseOnly.request)).status, 'cleared', 'address case does not matter')
})

await test('boundary: a ledger that is not saved across reloads, cannot be read or cannot write never lets a write go ahead', async () => {
  const refused = async (attempts, expected, name) => {
    const { request, counters } = await boundary('repay', { attempts })
    const result = await borrow.verifyBorrowWriteBoundary(request)
    assert.deepEqual(result, { status: 'refused', blockers: [expected] }, name)
    assert.deepEqual([counters.refresh, counters.getAdapter], [0, 0], `${name}: no fresh read, no adapter`)
  }
  await refused(ledgers.createBorrowAttemptLedger(), 'attempt_store_unreliable', 'in-memory ledger')
  await refused(ledgers.createPersistentAttemptLedger(null, WALLET, 5042), 'attempt_store_unreliable', 'no storage')
  const corrupt = fakeStorage({ [ledgers.attemptStorageKey(WALLET, 5042)]: '{broken' })
  await refused(persistent(corrupt), 'attempt_store_unreliable', 'unreadable history')
  assert.equal(corrupt.data.get(ledgers.attemptStorageKey(WALLET, 5042)), '{broken', 'and it is left as it was')
  // Storage that cannot save the attempt: the write is not sent unrecorded.
  const full = fakeStorage(); full.failWrites = true
  const { request, counters } = await boundary('repay', { attempts: persistent(full) })
  assert.deepEqual(await borrow.verifyBorrowWriteBoundary(request), { status: 'refused', blockers: ['attempt_store_unreliable'] })
  assert.deepEqual([counters.refresh, counters.getAdapter], [0, 0])
})

await test('boundary: after a reload an attempt that was running is "interrupted" and blocks every write on that loan until it is confirmed resolved', async () => {
  const storage = fakeStorage()
  const first = await boundary('repay', { attempts: persistent(storage, 'page-1') })
  const cleared = await borrow.verifyBorrowWriteBoundary(first.request)
  assert.equal(cleared.status, 'cleared')
  // The page is reloaded before the send finished; a new page reads the same storage and cannot tell whether it landed.
  const sameWrite = await boundary('repay', { attempts: persistent(storage, 'page-2') })
  assert.deepEqual(await borrow.verifyBorrowWriteBoundary(sameWrite.request), { status: 'refused', blockers: ['attempt_unresolved'] })
  assert.deepEqual([sameWrite.counters.refresh, sameWrite.counters.getAdapter], [0, 0], 'refused before any fresh read or adapter')
  // Another amount, and another kind of write on the same loan, are no safer.
  const other = await boundary('repay', { attempts: persistent(storage, 'page-2'), action: { ...ACTIONS.repay, repayAmount: '5' } })
  assert.equal((await borrow.verifyBorrowWriteBoundary({ ...other.request, confirmedActionId: borrow.planBorrowWrite({ ...ACTIONS.repay, repayAmount: '5' }, { ...(await build('repay')).context }).actionId })).status, 'refused')
  const addCollateral = await boundary('add-collateral', { attempts: persistent(storage, 'page-2') })
  assert.deepEqual(await borrow.verifyBorrowWriteBoundary(addCollateral.request), { status: 'refused', blockers: ['attempt_unresolved'] })
  // The plan says why, in the words the user will read.
  const view = persistent(storage, 'page-2')
  const { action, context } = await build('repay')
  const plan = borrow.planBorrowWrite(action, { ...context, attempts: view.list(), attemptLog: view.health() })
  assert.match(plan.checks.find((c) => c.id === 'attempt').text, /closed or reloaded.*not known/)
  assert.equal(safety.borrowReadiness(plan.checks).status, 'blocked')
  // A cleared attempt is not cleared by time, by another page, or by a position read from before it.
  assert.equal(view.resolve(plan.scopeId, { positionReadAt: NOW - 1e9, acknowledged: true }), false)
  assert.equal(view.list().length, 1)
  assert.equal(view.resolve(plan.scopeId, { positionReadAt: NOW + 1e9, acknowledged: false }), false)
  assert.equal(view.resolve(plan.scopeId, { positionReadAt: NOW + 1e9, acknowledged: true }), false, 'failed SDK submissions also require independent settlement')
})

await test('boundary: a write that finished unknown, failed or confirmed stays recorded and blocks the next one', async () => {
  for (const status of ['submitted', 'failed', 'confirmed']) {
    const storage = fakeStorage()
    const ledger = persistent(storage)
    const first = await boundary('repay', { attempts: ledger })
    const cleared = await borrow.verifyBorrowWriteBoundary(first.request)
    ledger.finish(cleared.plan.scopeId, status, NOW + 1, status === 'confirmed' ? { txHash: '0xabc' } : {})
    const reloaded = await boundary('repay', { attempts: persistent(storage, 'page-2') })
    assert.deepEqual(await borrow.verifyBorrowWriteBoundary(reloaded.request), { status: 'refused', blockers: ['attempt_unresolved'] }, status)
  }
})

// ---------------------------------------------------------------------------------------------------------------------
// The gate stays closed: executeBorrowWrite refuses before it touches anything

await test('with the gate closed executeBorrowWrite refuses first: no wallet read, no quote, no adapter, no SDK write, no network', async () => {
  const requestsBefore = fetchCalls
  for (const kind of KINDS) {
    const { request, counters } = await boundary(kind)
    const { client, calls } = fakeClient({})
    const outcome = await borrow.executeBorrowWrite({ ...request, client })
    assert.deepEqual(outcome, { status: 'refused', blockers: ['writes_disabled'] }, kind)
    assert.deepEqual(counters, { readWallet: 0, refresh: 0, getAdapter: 0, getAddress: [] }, `${kind}: nothing was read or built`)
    assert.deepEqual(calls, [], `${kind}: the SDK was not touched`)
    assert.equal(request.attempts.list().length, 0)
    // And without any injected client, so the private default kit would be the only way a write could go out.
    const withoutClient = await borrow.executeBorrowWrite(request)
    assert.deepEqual(withoutClient, { status: 'refused', blockers: ['writes_disabled'] })
  }
  assert.deepEqual(writeCallsOnDefaultKit, [])
  assert.equal(fetchCalls, requestsBefore, 'no Borrow Service call')
  assert.equal(config.MAINNET_BORROW_WRITES_ENABLED, false)
})

// ---------------------------------------------------------------------------------------------------------------------
// Wallet compatibility: what the wallet really answered

await test('wallet capability: the wallet\'s own answers decide; a failure to answer is "could not verify", never "supported"', async () => {
  const asked = []
  const answers = (response) => async (args) => { asked.push(args); if (response instanceof Error || (response && response.code !== undefined && response.message !== undefined && !response['0x13b2'])) throw response; return response }
  const probe = (response, options) => borrow.detectAtomicBatchCapability(answers(response), WALLET, options)
  assert.equal(await probe({ '0x13b2': { atomic: { status: 'supported' } } }), 'supported')
  assert.equal(await probe({ '0x13b2': { atomic: { status: 'ready' } } }), 'supported')
  assert.equal(await probe({ '0x13b2': { atomic: { supported: true } } }), 'supported')
  assert.equal(await probe({ '0x13b2': { atomic: { status: 'unsupported' } } }), 'unsupported')
  assert.equal(await probe({ '0x13b2': { atomic: { supported: false } } }), 'unsupported')
  assert.equal(await probe({ '0x13b2': {} }), 'unsupported', 'the wallet answered but has no atomic capability on Arc')
  assert.equal(await probe({ '0x1': { atomic: { status: 'supported' } } }), 'unsupported', 'it answered for other chains only')
  assert.equal(await probe({ '0x13b2': { atomic: {} } }), 'unknown', 'an atomic entry without a usable status')
  assert.equal(await probe({ '0x13b2': { atomic: { status: 'maybe' } } }), 'unknown')
  assert.equal(await probe(null), 'unknown'); assert.equal(await probe('yes'), 'unknown')
  // Errors: only a clear "that method does not exist" is "not supported". Everything else says nothing about the wallet.
  for (const error of [{ code: 4200, message: 'Unsupported Method' }, { code: -32601, message: 'x' }, new Error('Method not found'), new Error('the method wallet_getCapabilities is not supported'), new Error('Unsupported method: wallet_getCapabilities')]) {
    assert.equal(await probe(error), 'unsupported', JSON.stringify(error.message))
  }
  for (const error of [{ code: 4001, message: 'User rejected the request' }, new Error('network down'), new Error('Internal error'), { code: -32603, message: 'Internal JSON-RPC error' }, 'boom', undefined]) {
    assert.equal(await probe(error), 'unknown', `${JSON.stringify(error?.message ?? error)}: could not verify`)
  }
  // A wallet that never answers.
  assert.equal(await borrow.detectAtomicBatchCapability(() => new Promise(() => {}), WALLET, { timeoutMs: 25 }), 'unknown')
  assert.equal(await borrow.detectAtomicBatchCapability(async () => ({ '0x13b2': { atomic: { status: 'supported' } } }), WALLET, { timeoutMs: 25 }), 'supported', 'a prompt answered in time')
  assert.equal(await borrow.detectAtomicBatchCapability(answers({}), 'nope'), 'unknown'); const before = asked.length
  assert.equal(await borrow.detectAtomicBatchCapability(answers({}), 'nope'), 'unknown'); assert.equal(asked.length, before, 'no question for an address that is not one')
  // Read only: the one thing ever asked is wallet_getCapabilities, for this wallet and Arc.
  assert.ok(asked.length > 10)
  assert.ok(asked.every(({ method, params }) => method === 'wallet_getCapabilities' && params[0] === WALLET && params[1].length === 1 && params[1][0] === '0x13b2'))
})

await test('wallet capability: the answer is summarized in plain words for the technical details', () => {
  const say = borrow.summarizeCapabilityAnswer
  assert.equal(say({ response: { '0x13b2': { atomic: { status: 'supported' } } } }), 'The wallet answered for Arc (0x13b2): atomic.status = "supported".')
  assert.equal(say({ response: { '0x13b2': { atomic: { supported: false } } } }), 'The wallet answered for Arc (0x13b2): atomic.supported = false.')
  assert.equal(say({ response: { '0x13b2': {} } }), "The wallet's entry for Arc (0x13b2) has no atomic capability.")
  assert.equal(say({ response: { '0x1': {} } }), "The wallet's answer has no entry for Arc (0x13b2).")
  assert.equal(say({ response: 7 }), 'The wallet answered with something that is not a capabilities object.')
  assert.equal(say({ error: { code: 4200, message: 'Unsupported   Method' } }), 'The wallet returned an error (code 4200): Unsupported Method')
  assert.equal(say({ error: new Error('x'.repeat(500)) }).length < 200, true, 'the wallet\'s own words are cut short')
  assert.match(say({ timedOut: true }), /^No answer from the wallet within 8 s\./)
  assert.match(say({ response: { '0x13b2': { atomic: { status: '<script>alert(1)</script>'.repeat(5) } } } }), /atomic capability without a status/, 'long or odd statuses are not echoed')
})

// ---------------------------------------------------------------------------------------------------------------------
// Health Factor target: what Circle's Borrow Kit can and cannot do

// A fake Borrow Service that behaves as the live one measured (see scripts/verify-mainnet-borrow-target-live.mjs): the quote's
// collateral is the exactly sized base collateral plus the slippage as a buffer, and the Health Factor follows from it.
function fakeSizingService({ baseHealthFactor = 1.2, decimals = 8, price = 81400, ltvLimit = 0.86, ignoreSlippage = false, failAtBps = null, failBase = false, failFirst = false, roundDown = false } = {}) {
  const calls = []
  const client = {}
  for (const method of borrow.MAINNET_BORROW_READ_METHODS) client[method] = async () => { throw new Error('unexpected read') }
  client.getBorrowQuote = async (params) => {
    calls.push(params)
    const bps = ignoreSlippage ? 300 : params.slippageBps ?? 300
    if (failFirst && params.slippageBps === undefined) throw new Error('boom')
    if (failBase && params.slippageBps === 0) throw new Error('boom')
    if (failAtBps !== null && params.slippageBps === failAtBps) throw new Error('boom')
    const borrowAmount = Number(params.borrowAmount)
    const baseCollateral = (borrowAmount * baseHealthFactor) / (ltvLimit * price)
    const scale = 10 ** decimals
    const raw = baseCollateral * (1 + bps / 10_000) * scale
    const collateral = (roundDown ? Math.floor(raw) : Math.ceil(raw)) / scale
    const hf = (collateral * price * ltvLimit) / borrowAmount
    return { ...RESPONSES.borrow, loanAssetAmount: usdc(String(borrowAmount)), collateralAmount: cirbtc(collateral.toFixed(decimals)), resultingHealthFactor: hf, resultingLtv: ltvLimit / hf }
  }
  return { client, calls }
}
const BORROW_10 = { kind: 'borrow', marketId: MARKET, borrowAmount: '10' }
const search = (action, target, service, clock = () => NOW) => borrow.prepareBorrowQuoteForTarget(action, WALLET, target, service.client, clock)

await test('target Health Factor: the quote and borrow call take no collateral or target; only the slippage buffer moves the collateral', () => {
  const providerSource = readFileSync(join(root, 'node_modules/@circle-fin/provider-borrow-service/index.mjs'), 'utf8')
  // The installed SDK's own (strict) request schemas for a first-open quote and a borrow-more quote.
  const quote = (extra = {}) => sdk.borrowQuoteParamsSchema.safeParse({ chain: 'Arc', marketId: MARKET, walletAddress: WALLET, borrowAmount: '10', ...extra }).success
  const more = (extra = {}) => sdk.borrowQuoteParamsSchema.safeParse({ loanId: LOAN, borrowAmount: '10', ...extra }).success
  assert.ok(quote() && quote({ slippageBps: 2500 }) && quote({ slippageBps: 10_000 }) && more({ slippageBps: 2500 }))
  assert.ok(!quote({ slippageBps: 10_001 }) && !more({ slippageBps: -1 }), 'the buffer is bounded by the SDK itself')
  for (const field of [{ collateralAmount: '0.01' }, { targetHealthFactor: 1.5 }, { collateral: '0.01' }, { healthFactor: 1.5 }]) {
    assert.ok(!quote(field) && !more(field), `a borrow quote accepts no ${Object.keys(field)[0]}`)
  }
  // The target exists only on the separate sizing preview, which no write can use.
  assert.ok(sdk.requiredCollateralParamsSchema.safeParse({ chain: 'Arc', marketId: MARKET, borrowAmount: '10', targetHealthFactor: 1.5 }).success)
  assert.ok(sdk.maxBorrowParamsSchema.safeParse({ chain: 'Arc', marketId: MARKET, collateralAmount: '0.01' }).success)
  // What the provider puts on the wire for a borrow and its quote.
  const wire = providerSource.slice(providerSource.indexOf('async function fetchBorrow('), providerSource.indexOf('Build signed claim rewards'))
  assert.ok(!/targetHealthFactor|collateralAmount/.test(wire.slice(0, wire.indexOf('responseGuard: isBorrowExecution'))), 'the borrow request carries no target and no collateral')
  assert.match(wire, /amount: params\.loanAssetAmount/); assert.match(wire, /slippageBps: params\.slippageBps/)
  // The target is only an input of the separate sizing preview.
  assert.match(providerSource, /targetHealthFactor: toDecimalString\(params\.targetHealthFactor\)/)
})

await test('target Health Factor: a buffer the SDK accepts reaches the target, and every proposal is checked on a real quote', async () => {
  // 10 USDC at 1.50: the default quote gives 1.236 (about 1.24), exact sizing gives 1.20, so 2500 bps of buffer is needed.
  const service = fakeSizingService()
  const result = await search(BORROW_10, 1.5, service)
  assert.equal(result.status, 'available')
  const found = result.data
  assert.equal(found.outcome, 'buffered'); assert.equal(found.slippageBps >= 2500 && found.slippageBps <= 2502, true, String(found.slippageBps))
  assert.ok(Math.abs(found.requestedHealthFactor - 1.236) < 0.001, 'Circle\'s default quote is what the user saw: about 1.24')
  assert.ok(found.prepared.quote.resultingHealthFactor >= 1.5, 'the chosen quote reaches the target on its own raw Health Factor')
  assert.equal(found.prepared.request.slippageBps, found.slippageBps, 'the quote answers the very slippage the action will carry')
  assert.deepEqual(service.calls.map((c) => c.slippageBps), [undefined, 0, ...service.calls.slice(2).map((c) => c.slippageBps)])
  assert.ok(service.calls.length <= 5 && found.reads === service.calls.length)
  assert.ok(service.calls.every((c) => c.walletAddress === WALLET && c.marketId === MARKET && c.borrowAmount === '10'), 'only the buffer changes between requests')
  // The action carrying that buffer is a ready plan on that quote; the same plan on the default quote is blocked on the target.
  const context = { wallet: READY_WALLET, quote: found.prepared, evidence: baseEvidence('borrow'), attempts: [], attemptLog: HEALTHY_LOG, now: NOW }
  const action = { ...BORROW_10, slippageBps: found.slippageBps }
  const buffered = borrow.planBorrowWrite(action, context)
  assert.deepEqual(withoutGate(buffered), [], JSON.stringify(buffered.checks.filter((c) => c.status === 'fail' || c.status === 'unknown')))
  const defaultQuote = (await borrow.prepareBorrowQuote(BORROW_10, WALLET, service.client, () => NOW - SECOND)).data
  assert.ok(withoutGate(borrow.planBorrowWrite(BORROW_10, { ...context, quote: defaultQuote })).includes('health_target_not_met'))
  assert.ok(withoutGate(borrow.planBorrowWrite(BORROW_10, { ...context, quote: found.prepared })).includes('quote_request_mismatch'), 'the buffered quote is not the default request')
  // The target the user picked is never lowered, whatever the service gives.
  for (const target of [1.25, 1.5, 2]) {
    const r = (await search(BORROW_10, target, fakeSizingService())).data
    assert.equal(r.outcome, 'buffered', String(target)); assert.ok(r.prepared.quote.resultingHealthFactor >= target, `${target}: raw ${r.prepared.quote.resultingHealthFactor}`)
    assert.ok(r.prepared.quote.resultingLtv <= 0.7, 'and the loan-to-value falls with it')
  }
})

await test('target Health Factor: a default quote that already reaches it is kept; one that cannot be reached stays blocked and is never rewritten', async () => {
  const already = await search(BORROW_10, 1.2, fakeSizingService())
  assert.equal(already.data.outcome, 'as-requested'); assert.equal(already.data.slippageBps, undefined); assert.equal(already.data.reads, 1)
  // 2.5 needs more buffer than the SDK allows (10 833 bps): not reached, nothing lowered, nothing requested beyond the limit.
  const service = fakeSizingService()
  const unreachable = await search(BORROW_10, 2.5, service)
  assert.equal(unreachable.data.outcome, 'not-reached'); assert.equal(unreachable.data.slippageBps, undefined)
  assert.ok(unreachable.data.prepared.quote.resultingHealthFactor < 2.5, 'the default quote is returned as it is, to show why')
  assert.ok(service.calls.every((c) => c.slippageBps === undefined || c.slippageBps <= 10_000), 'no request above the SDK maximum')
  const blocked = borrow.planBorrowWrite(BORROW_10, { wallet: READY_WALLET, quote: unreachable.data.prepared, evidence: baseEvidence('borrow'), attempts: [], attemptLog: HEALTHY_LOG, now: NOW })
  assert.ok(withoutGate(blocked).includes('health_target_not_met')); assert.equal(safety.borrowReadiness(blocked.checks).status, 'blocked')
  // A service that ignores the buffer: three proposals are tried, none reaches it, and it ends blocked rather than looping.
  const deaf = fakeSizingService({ ignoreSlippage: true })
  const stuck = await search(BORROW_10, 1.5, deaf)
  assert.equal(stuck.data.outcome, 'not-reached'); assert.equal(deaf.calls.length, 5)
  // Reads that fail: the first one is an error; any later one only means the target is not reached.
  assert.equal((await search(BORROW_10, 1.5, fakeSizingService({ failFirst: true }))).status, 'unavailable')
  assert.equal((await search(BORROW_10, 1.5, fakeSizingService({ failBase: true }))).data.outcome, 'not-reached')
  const halfway = fakeSizingService({ failAtBps: 2500 })
  assert.equal((await search(BORROW_10, 1.5, halfway)).data.outcome, 'not-reached', 'a failed proposal stops the search')
  // Rounding of the collateral to 8 decimals can leave the first proposal a hair short: the next one is tried.
  for (const amount of ['10', '1', '0.5']) {
    const rounded = await search({ ...BORROW_10, borrowAmount: amount }, 1.5, fakeSizingService({ roundDown: true }))
    assert.equal(rounded.data.outcome, 'buffered', amount); assert.ok(rounded.data.prepared.quote.resultingHealthFactor >= 1.5, amount)
    assert.ok(rounded.data.reads <= 5, `${amount}: ${rounded.data.reads} quotes`)
  }
  // Bad targets are not searched at all.
  for (const target of [1, 0.5, Number.NaN, Number.POSITIVE_INFINITY]) assert.equal((await search(BORROW_10, target, fakeSizingService())).status, 'unavailable', String(target))
})

await test('target Health Factor: Borrow more uses the same search on the loan, with no wallet needed for the quote', async () => {
  const service = fakeSizingService()
  const result = await borrow.prepareBorrowQuoteForTarget({ kind: 'borrow-more', loanId: LOAN, borrowAmount: '10' }, WALLET, 1.5, service.client, () => NOW)
  assert.equal(result.data.outcome, 'buffered')
  assert.ok(service.calls.every((c) => c.loanId === LOAN && c.walletAddress === undefined && c.marketId === undefined))
  assert.equal(result.data.prepared.request.loanId, LOAN)
})

// ---------------------------------------------------------------------------------------------------------------------
// What the preview shows

await test('the preview description names the movements, fees and slippage per action, and calls a ceiling a ceiling', async () => {
  const describe = async (kind) => { const { action, context } = await build(kind); return safety.describeBorrowWrite(action, context.quote.quote) }
  const borrowing = await describe('borrow')
  assert.equal(borrowing.title, 'Borrow')
  assert.deepEqual(borrowing.movements.map((m) => [m.direction, m.amount.amount]), [['out', '0.05'], ['in', '1000']])
  assert.equal(borrowing.gasWei, 33_600_000_000_000_000n)
  assert.equal(borrowing.fees.length, 1)
  assert.equal(borrowing.slippageBps, 300)
  assert.equal((await describe('borrow-more')).title, 'Borrow more')
  const close = await describe('close-loan')
  assert.deepEqual(close.movements.map((m) => [m.direction, m.ceiling === true, m.amount.amount]), [['out', true, '1030.26'], ['in', false, '0.05']])
  assert.match(close.movements[0].note, /ceiling, not an invoice/)
  assert.deepEqual((await describe('repay')).movements.map((m) => m.direction), ['out'])
  assert.deepEqual((await describe('repay')).slippageBps, null)
  assert.deepEqual((await describe('withdraw-collateral')).movements.map((m) => m.direction), ['in'], 'no repayment line when none is sized')
  assert.equal(safety.describeBorrowWrite(ACTIONS.borrow, null).movements.length, 0)
})

// ---------------------------------------------------------------------------------------------------------------------
// Source guards

await test('the gate, the write calls and the UI boundary stay as designed', () => {
  assert.match(configSource, /^export const MAINNET_BORROW_WRITES_ENABLED: boolean = false$/m)
  const lib = readFileSync(join(root, 'src/lib/mainnetBorrow.ts'), 'utf8')
  const executor = lib.slice(lib.indexOf('export async function executeBorrowWrite('))
  const boundarySource = lib.slice(lib.indexOf('export async function verifyBorrowWriteBoundary('), lib.indexOf('export type BorrowWriteRequest'))
  assert.ok(executor.indexOf("if (MAINNET_BORROW_WRITES_ENABLED !== true) return { status: 'refused', blockers: ['writes_disabled'] }") > 0)
  assert.ok(executor.indexOf('verifyBorrowWriteBoundary(request)') > executor.indexOf('MAINNET_BORROW_WRITES_ENABLED !== true'), 'the boundary runs only after the gate')
  assert.equal(lib.match(/verifyBorrowWriteBoundary\(/g).length, 2, 'declared once and called once, from executeBorrowWrite')
  for (const method of borrow.MAINNET_BORROW_WRITE_METHODS) {
    assert.ok(!new RegExp(`\\.${method}\\(`).test(boundarySource), `the boundary cannot call ${method}`)
    assert.ok(!new RegExp(`\\.${method}\\(`).test(readFileSync(join(root, 'src/lib/borrowWriteSafety.ts'), 'utf8')), `the safety layer cannot call ${method}`)
  }
  assert.ok(!/BorrowKit\b|@circle-fin|getMainnetBorrowKit/.test(readFileSync(join(root, 'src/lib/borrowWriteSafety.ts'), 'utf8').replace(/\/\/.*$/gm, '')), 'the safety layer is pure: no SDK')
  const ui = readFileSync(join(root, 'src/components/MainnetBorrow.tsx'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
  assert.ok(!/executeBorrowWrite|verifyBorrowWriteBoundary|getAdapter|createViemAdapter|useWalletClient|signTypedData|sendTransaction|writeContract|wallet_sendCalls|eth_sendTransaction|personal_sign|wallet_switchEthereumChain/.test(ui),
    'the UI reaches no execution or wallet-request path')
  assert.ok(/planBorrowWrite/.test(ui) && /detectAtomicBatchCapability/.test(ui) && /prepareBorrowQuote/.test(ui), 'the UI uses the shared plan, the read-only capability query and the read-only quote')
  assert.ok(!/\bonClick=\{[^}]*(execute|borrow\(|repay\()/.test(ui))
})

console.log(`\nBorrow write safety checks: ${passed} passed`)
