import { computeMarketId } from '../../../src/lib/borrowMarketVerification'
import * as borrow from '../../../src/lib/mainnetBorrow'
import * as ledgers from '../../../src/lib/borrowAttemptLedger'
export const NOW = Date.now()
const SECOND = 1000
export const WALLET = '0x1111111111111111111111111111111111111111'
const OTHER = '0x2222222222222222222222222222222222222222'
export const MARKET = computeMarketId({ loanToken: '0x3600000000000000000000000000000000000000', collateralToken: '0x171a4217b86a807a64eb94757db6849fb4bdbaa0', oracle: '0x2AA87fF48933Ce6aBA240BEE916Fc2e6Ec1e51Ab', irm: '0xF02615d094Fc02fC031C35fe705e175aA4653f20', lltv: 860000000000000000n })
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
export const READY_WALLET = { address: WALLET, chainId: 5042, atomicBatch: 'supported', atomicBatchFor: SESSION }

export const MARKET_WIRE = {
  marketId: MARKET, protocol: 'morpho', chain: 'Arc',
  loanAsset: { symbol: 'USDC', address: USDC, decimals: 6 }, collateralAsset: { symbol: 'cirBTC', address: CIRBTC, decimals: 8 },
  lltv: 0.86, borrowCap: null, borrowAssets: usdc('1250000.5'), liquidity: usdc('400000'), borrowApy: 0.0612, utilization: 0.5,
  refreshedAt: '2026-10-01T12:00:00.000Z',
}
export const LOAN_WIRE = {
  loanId: LOAN, chain: 'Arc', marketId: MARKET, walletAddress: WALLET, dataStatus: 'READY', collateral: cirbtc('0.05'), borrowed: usdc('1000.25'),
  principalBorrowed: usdc('1000'), accruedInterest: usdc('0.25'), borrowApy: 0.0612, ltv: 0.4, healthFactor: 2.6, healthFactorBand: 'SAFE',
  liquidationPrice: usdc('23255.81'), status: 'active',
}
export const MARKET_DATA = borrow.normalizeBorrowMarket(MARKET_WIRE)
export const POSITION = borrow.normalizeBorrowPosition(LOAN_WIRE)
export const VERIFIED = {
  status: 'verified',
  details: {
    params: { loanToken: USDC, collateralToken: CIRBTC, oracle: ORACLE, irm: IRM, lltv: 860000000000000000n },
    oraclePrice: 8140086n * 10n ** 32n,
    liquidity: 500_000n * 10n ** 6n,
  },
}
export const BALANCES = {
  native: 5000n * 10n ** 18n,
  loanToken: { address: USDC, raw: 5000n * 10n ** 6n },
  collateralToken: { address: CIRBTC, raw: 1n * 10n ** 8n },
}

export const ACTIONS = {
  'borrow': { kind: 'borrow', marketId: MARKET, borrowAmount: '1000' },
  'borrow-more': { kind: 'borrow-more', loanId: LOAN, borrowAmount: '1000' },
  'repay': { kind: 'repay', loanId: LOAN, repayAmount: '10' },
  'add-collateral': { kind: 'add-collateral', loanId: LOAN, collateralAmount: '0.01' },
  'withdraw-collateral': { kind: 'withdraw-collateral', loanId: LOAN, collateralAmount: '0.01' },
  'close-loan': { kind: 'close-loan', loanId: LOAN },
}
export const METHOD = {
  'borrow': 'getBorrowQuote', 'borrow-more': 'getBorrowQuote', 'repay': 'getRepayQuote', 'add-collateral': 'getAddCollateralQuote',
  'withdraw-collateral': 'getWithdrawCollateralRepayIfNeededQuote', 'close-loan': 'getCloseLoanQuote',
}
export const RESPONSES = {
  'borrow': {
    chain: 'Arc', collateralAmount: cirbtc('0.05'), loanAssetAmount: usdc('1000'), borrowApy: 0.0612, fees: [],
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
export function fakeClient(responses) {
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
export async function build(kind, mutate = () => {}) {
  const draft = {
    action: structuredClone(ACTIONS[kind]), response: structuredClone(RESPONSES[kind]), wallet: { ...READY_WALLET },
    evidence: baseEvidence(kind), attempts: [], now: NOW, quoteAt: NOW - SECOND,
  }
  mutate(draft)
  const { client, calls } = fakeClient({ [METHOD[kind]]: draft.response })
  const prepared = await borrow.prepareBorrowQuote(draft.action, WALLET, client, () => draft.quoteAt)
  if (prepared.status !== 'available') throw new Error('fixture quote failed')
  if (writeCalls(calls).length) throw new Error("fixture write")
  return { action: draft.action, context: { wallet: draft.wallet, quote: prepared.data, evidence: draft.evidence, attempts: draft.attempts, attemptLog: HEALTHY_LOG, now: draft.now } }
}

const HEALTHY_LOG = { ok: true, persistent: true, reason: null }

// Browser storage stand-in: a Map, with switches to make it fail the way real storage can.
export function fakeStorage(initial = {}) {
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
export const persistent = (storage, instanceId = 'page-1', address = WALLET) => ledgers.createPersistentAttemptLedger(storage, address, 5042, { instanceId })
