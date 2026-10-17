// Deterministic checks of the read-only Borrow tab: the pure helpers (src/lib/borrowPreview.ts) and the rules the tab
// source must keep (no write path, only disabled action buttons, only read functions imported). No network, no wallet.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
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
const preview = require(fileURLToPath(new URL('../src/lib/borrowPreview.ts', import.meta.url)))
const verification = require(fileURLToPath(new URL('../src/lib/borrowMarketVerification.ts', import.meta.url)))
const intelligence = require(fileURLToPath(new URL('../src/lib/arcIntelligence.ts', import.meta.url)))
const proxy = await import('../api/_lib/borrow-markets-proxy.js')
const config = require(fileURLToPath(new URL('../src/config/mainnetBorrow.ts', import.meta.url)))
const { MAINNET_BORROW_WRITES_ENABLED } = config
const tabSource = readFileSync(`${root}src/components/MainnetBorrow.tsx`, 'utf8')
const appSource = readFileSync(`${root}src/App.tsx`, 'utf8')
const helperSource = readFileSync(`${root}src/lib/borrowPreview.ts`, 'utf8')
const code = (source) => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')

let passed = 0
function test(name, run) {
  run()
  passed += 1
  console.log(`PASS ${name}`)
}
async function atest(name, run) {
  await run()
  passed += 1
  console.log(`PASS ${name}`)
}

test('the write gate is still off', () => {
  assert.equal(MAINNET_BORROW_WRITES_ENABLED, false)
})

test('amount input keeps digits and one dot and cuts to the token precision', () => {
  assert.equal(preview.sanitizeDecimalInput('abc1.2.3x', 8), '1.23')
  assert.equal(preview.sanitizeDecimalInput('.5', 6), '0.5')
  assert.equal(preview.sanitizeDecimalInput('007', 6), '7')
  assert.equal(preview.sanitizeDecimalInput('0.123456789', 8), '0.12345678')
  assert.equal(preview.sanitizeDecimalInput('12.3456789', 6), '12.345678')
  assert.equal(preview.sanitizeDecimalInput('1e5', 6), '15')
  assert.equal(preview.sanitizeDecimalInput('-5', 6), '5')
  assert.equal(preview.sanitizeDecimalInput('', 6), '')
  assert.equal(preview.sanitizeDecimalInput('1.', 6), '1.')
  assert.ok(preview.sanitizeDecimalInput('9'.repeat(80), 6).length <= 30)
})

test('only a positive plain decimal becomes a request amount', () => {
  assert.equal(preview.parsePositiveAmount('1.5'), '1.5')
  assert.equal(preview.parsePositiveAmount('1.'), '1')
  assert.equal(preview.parsePositiveAmount('0.00000001'), '0.00000001')
  for (const rejected of ['', '0', '0.0', '.', '-1', '1e3', '1,5', ' 1', 'abc', '0x10']) {
    assert.equal(preview.parsePositiveAmount(rejected), null, JSON.stringify(rejected))
  }
})

test('decimal comparison is exact and never uses floating point', () => {
  assert.equal(preview.compareDecimals('0.1', '0.10'), 0)
  assert.equal(preview.compareDecimals('2', '10'), -1)
  assert.equal(preview.compareDecimals('977415.429911', '977415.429912'), -1)
  assert.equal(preview.compareDecimals('1000000.000001', '1000000'), 1)
  assert.equal(preview.compareDecimals('9007199254740993', '9007199254740992'), 1)
  assert.equal(preview.compareDecimals('0.30000000000000004', '0.3'), 1)
  assert.equal(preview.isZeroDecimal('0.000'), true)
  assert.equal(preview.isZeroDecimal('0.001'), false)
})

test('gas is summed in wei and shown in the native unit without rounding up', () => {
  assert.equal(preview.totalGasWei([]), null)
  const step = (feeWei) => ({ name: 'step', gasUnits: '1', gasPriceWei: '1', feeWei })
  assert.equal(preview.totalGasWei([step('33600000000000000'), step('1')]), 33600000000000001n)
  assert.equal(preview.formatUnitsText(33600000000000000n, 18, 6), '0.0336')
  assert.equal(preview.formatUnitsText(1234500000000000000n, 18, 6), '1.2345')
  assert.equal(preview.formatUnitsText(1n, 18, 6), '<0.000001')
  assert.equal(preview.formatUnitsText(0n, 18, 6), '0')
  assert.equal(preview.formatUnitsText(1999999999999999999n, 18, 2), '1.99')
})

test('health factor and interest formatting', () => {
  assert.equal(preview.formatHealthFactor(2.6), '2.60')
  assert.equal(preview.formatHealthFactor(1.0049), '1.00')
  assert.equal(preview.formatHealthFactor(2500), '1,000+')
  assert.equal(preview.illustrativeYearlyInterest('1000', 0.0612), '61.20')
  assert.equal(preview.illustrativeYearlyInterest('1000', null), null)
  assert.equal(preview.illustrativeYearlyInterest('not a number', 0.05), null)
  assert.equal(preview.healthBandTone('SAFE'), 'safe')
  assert.equal(preview.healthBandTone('WARN'), 'caution')
  assert.equal(preview.healthBandTone('URGENT'), 'caution')
  assert.equal(preview.healthBandTone('IMMINENT'), 'danger')
  assert.equal(preview.healthBandTone('LIQUIDATABLE'), 'danger')
})

test('every Borrow error code has a plain explanation and none leaks detail', () => {
  const codes = ['reads_disabled', 'invalid_input', 'market_not_found', 'loan_not_found', 'unsupported_chain', 'unexpected_chain',
    'unexpected_owner', 'malformed_response', 'service_unavailable', 'service_rejected', 'unexpected_error']
  const seen = new Set()
  for (const codeName of codes) {
    const text = preview.describeBorrowError({ code: codeName, retryable: false, detail: 'secret.path[0]', sdkCode: 1 })
    assert.ok(text.length > 10 && !text.includes('secret.path') && !text.includes(codeName), codeName)
    seen.add(text)
  }
  assert.ok(seen.size >= 8)
  assert.match(preview.describeBorrowError({ code: 'malformed_response', retryable: false }), /could not verify/)
})

test('helpers are pure: no SDK, wallet, storage or network access', () => {
  assert.ok(!/from '(?!\.\/mainnetBorrow')/.test(code(helperSource).replace(/import type[^\n]*\n/g, '')), 'only a type import')
  assert.ok(!/fetch\(|localStorage|sessionStorage|window\.|ethereum|XMLHttpRequest/.test(code(helperSource)))
})

test('the Borrow tab imports only read functions, the pure plan and the read-only capability query, and no execution path', () => {
  const body = code(tabSource)
  const names = (path) => (body.match(new RegExp(`import\\s*\\{([^}]*)\\}\\s*from\\s*'${path}'`))?.[1] ?? '').split(',').map((name) => name.trim()).filter(Boolean)
  const values = (path) => names(path).filter((name) => !name.startsWith('type ')).sort()
  assert.ok(names('../lib/mainnetBorrow').length > 0, 'imports the guarded Borrow boundary')
  assert.deepEqual(values('../lib/mainnetBorrow'), ['detectAtomicBatchCapability', 'getBorrowLoans', 'getBorrowMarket', 'planBorrowWrite', 'prepareBorrowQuote', 'quoteMaxBorrow', 'quoteRequiredCollateral'])
  assert.deepEqual(values('../lib/borrowWriteSafety'), ['borrowReadiness', 'borrowWalletSession', 'healthTargetMet', 'orderWriteChecks', 'unitsToDecimal'])
  assert.ok(!/borrow-kit/.test(body), 'the SDK is only reached through the guarded boundary')
  assert.ok(!/executeBorrowWrite|verifyBorrowWriteBoundary|createBorrowAttemptLedger|BorrowWriteClient|MAINNET_BORROW_WRITE/.test(body), 'no execution, boundary or attempt path')
  assert.ok(!/useWalletClient|useWriteContract|useSendTransaction|useSignMessage|useSignTypedData|useSwitchChain|walletClient|getAdapter|wallet_(?!getCapabilities)|eth_/.test(body.replace(/wallet_getCapabilities/g, '')), 'the only wallet request is the read-only capability question')
  assert.ok(!/signTypedData|sendTransaction|writeContract|approve\(|\.borrow\(|\.repay\(|\.closeLoan\(|\.addCollateral\(/.test(body))
  assert.ok(!/localStorage|sessionStorage|document\.cookie/.test(body), 'no stored state, amounts or addresses')
})

test('every action button in the Borrow tab is permanently disabled and has no handler', () => {
  const lines = tabSource.split('\n').filter((line) => line.includes('data-borrow-action'))
  assert.ok(lines.length >= 2, 'a primary and per-loan action buttons exist')
  for (const line of lines) {
    assert.match(line, /<button\b/, line)
    assert.ok(line.includes('disabled aria-disabled="true"'), `disabled: ${line.trim()}`)
    assert.ok(!/onClick|onSubmit|onPointer|onMouse/.test(line), `no handler: ${line.trim()}`)
  }
  assert.ok(!/<form\b|type="submit"/.test(tabSource), 'nothing can submit')
  // Only these controls may carry a handler; none of them names an action the tab cannot perform.
  const handlers = [...tabSource.matchAll(/<button\b[^>]*?onClick=\{([^}]*)\}/g)].map((match) => match[1].trim())
  assert.ok(handlers.every((handler) => /^(bump|onRetry|onReload|onSelect|\(\) => (inputs\.setTargetHealthFactor\(value\)|void loadMore\(\)))$/.test(handler)), handlers.join(' | '))
})

test('the Borrow tab states the risks and never recommends a market or amount', () => {
  for (const phrase of ['Liquidation risk', 'health factor falls', 'Below 1.0', 'Variable interest', 'not a fixed rate', 'Limited liquidity',
    'Borrowing itself is not enabled yet', 'Nothing is sent from this page: no signature, approval or transaction']) {
    assert.ok(tabSource.includes(phrase) || tabSource.replace(/\s+/g, ' ').includes(phrase), phrase)
  }
  assert.ok(!/recommend(ed)? (market|amount)|best (rate|market)|safe amount to borrow|guaranteed/i.test(code(tabSource)))
  assert.ok(tabSource.includes('are not ranked'))
  assert.ok(tabSource.includes('Not reported') && !/\?\? 0\b|\|\| 0\b/.test(code(tabSource)), 'missing values stay "Not reported", never 0')
})

test('the tab is wired into the Mainnet navigation only, and loads lazily', () => {
  assert.match(appSource, /const MainnetBorrow = lazy\(\(\) => import\('\.\/components\/MainnetBorrow'\)\)/)
  assert.match(appSource, /id: 'borrow' as const, label: 'Borrow'/)
  assert.ok(!/import MainnetBorrow from/.test(appSource), 'not statically imported')
  const mainnetNav = appSource.slice(appSource.indexOf("appNetwork === 'mainnet' && ("), appSource.indexOf('<main'))
  assert.ok(mainnetNav.includes("id: 'borrow'"))
  const testnetNav = appSource.slice(appSource.indexOf("appNetwork === 'testnet' && (\n        <div className=\"border-b"), appSource.indexOf("appNetwork === 'mainnet' && ("))
  assert.ok(!/borrow/i.test(testnetNav), 'no Borrow tab on testnet')
})


// ---------------------------------------------------------------------------------------------------------------------
// Market verification against Morpho (pure logic; the live read is scripts/verify-mainnet-borrow-markets-onchain.mjs)

const USDC = '0x3600000000000000000000000000000000000000'
const CIRBTC = '0x171a4217b86a807a64eb94757db6849fb4bdbaa0'
const IRM = '0xF02615d094Fc02fC031C35fe705e175aA4653f20'
// Read from Morpho Blue on Arc mainnet (block 26439311) with idToMarketParams: the IDs Circle lists for cirBTC / USDC.
const GOLDEN = [
  { id: '0xc2db905f174e5defcce01d321b09f15f78856a36a21b90cc7e1abbc29225815d', oracle: '0x2AA87fF48933Ce6aBA240BEE916Fc2e6Ec1e51Ab' },
  { id: '0xabd1763943714b96b6590238d484a240019b4b842eb67fbcff7d96c081b7b566', oracle: '0x2DE8026f00061170e1297d438967752b6671dd1d' },
]
const goldenParams = (oracle) => ({ loanToken: USDC, collateralToken: CIRBTC, oracle, irm: IRM, lltv: 860000000000000000n })
const marketFor = (golden, over = {}) => ({
  marketId: golden.id, loanAsset: { symbol: 'USDC', address: USDC, decimals: 6 }, collateralAsset: { symbol: 'cirBTC', address: CIRBTC, decimals: 8 }, lltv: 0.86, ...over,
})
const onchainFor = (golden, over = {}) => ({ chainId: 5042, params: goldenParams(golden.oracle), oraclePrice: 81400n * 10n ** 34n, totalSupplyAssets: 1000n, totalBorrowAssets: 400n, ...over })

test('the market ID hashes from the real on-chain parameters (Morpho Blue on Arc)', () => {
  for (const golden of GOLDEN) assert.equal(verification.computeMarketId(goldenParams(golden.oracle)), golden.id)
  assert.notEqual(verification.computeMarketId(goldenParams(GOLDEN[1].oracle)), GOLDEN[0].id)
  assert.equal(config.MAINNET_BORROW_MORPHO_BLUE, readFileSync(`${root}server/compact/protocols/morpho.js`, 'utf8').match(/blue: '(0x[0-9a-f]{40})'/)[1])
  // An independent encoder (ethers) produces the same hash.
  const { AbiCoder, keccak256 } = require('ethers')
  const p = goldenParams(GOLDEN[0].oracle)
  assert.equal(keccak256(AbiCoder.defaultAbiCoder().encode(['address', 'address', 'address', 'address', 'uint256'], [p.loanToken, p.collateralToken, p.oracle, p.irm, p.lltv])), GOLDEN[0].id)
})

test('a market is verified only when every on-chain check matches what Circle reports', () => {
  const [g] = GOLDEN
  const ok = verification.evaluateMarketVerification(marketFor(g), onchainFor(g))
  assert.equal(ok.status, 'verified')
  assert.equal(ok.details.liquidity, 600n)
  const bad = (market, onchain) => verification.evaluateMarketVerification(market, onchain)
  const reasons = (result) => (result.status === 'unverified' ? result.reasons : [result.status])
  assert.deepEqual(reasons(bad(marketFor(g), onchainFor(g, { params: { ...goldenParams(g.oracle), oracle: GOLDEN[1].oracle } }))), ['id_mismatch'])
  assert.deepEqual(reasons(bad(marketFor(g, { loanAsset: { symbol: 'USDC', address: CIRBTC, decimals: 6 } }), onchainFor(g))), ['loan_token_mismatch'])
  assert.deepEqual(reasons(bad(marketFor(g, { collateralAsset: { symbol: 'cirBTC', address: USDC, decimals: 8 } }), onchainFor(g))), ['collateral_token_mismatch'])
  assert.deepEqual(reasons(bad(marketFor(g, { lltv: 0.915 }), onchainFor(g))), ['lltv_mismatch'])
  assert.deepEqual(reasons(bad(marketFor(g), onchainFor(g, { oraclePrice: null }))), ['oracle_price_unavailable'])
  assert.deepEqual(reasons(bad(marketFor(g), onchainFor(g, { oraclePrice: 0n }))), ['oracle_price_unavailable'])
  assert.deepEqual(reasons(bad(marketFor(g), onchainFor(g, { chainId: 1 }))), ['wrong_chain'])
  const zero = '0x0000000000000000000000000000000000000000'
  assert.deepEqual(reasons(bad(marketFor(g), onchainFor(g, { params: { loanToken: zero, collateralToken: zero, oracle: zero, irm: zero, lltv: 0n } }))), ['market_missing'])
  assert.ok(reasons(bad(marketFor(g), onchainFor(g, { params: { ...goldenParams(zero) } }))).includes('oracle_missing'))
  assert.equal(bad(marketFor(g, { lltv: null }), onchainFor(g)).status, 'verified', 'an LLTV Circle did not report cannot disagree with the chain')
  assert.equal(bad(marketFor(g), onchainFor(g, { totalSupplyAssets: 5n, totalBorrowAssets: 9n })).details.liquidity, 0n, 'liquidity never goes negative')
})

await atest('the chain reader failing never produces "verified"', async () => {
  const [g] = GOLDEN
  const reader = (over = {}) => ({
    chainId: async () => 5042,
    marketParams: async () => goldenParams(g.oracle),
    marketState: async () => ({ totalSupplyAssets: 10n, totalBorrowAssets: 1n }),
    oraclePrice: async () => 5n,
    ...over,
  })
  assert.equal((await verification.verifyBorrowMarket(marketFor(g), reader())).status, 'verified')
  assert.equal((await verification.verifyBorrowMarket(marketFor(g), reader({ chainId: async () => { throw new Error('rpc down') } }))).status, 'unavailable')
  assert.equal((await verification.verifyBorrowMarket(marketFor(g), reader({ marketParams: async () => { throw new Error('revert') } }))).status, 'unavailable')
  assert.equal((await verification.verifyBorrowMarket(marketFor(g), reader({ marketState: async () => { throw new Error('revert') } }))).status, 'unavailable')
  const noPrice = await verification.verifyBorrowMarket(marketFor(g), reader({ oraclePrice: async () => { throw new Error('revert') } }))
  assert.deepEqual([noPrice.status, noPrice.reasons], ['unverified', ['oracle_price_unavailable']])
  const wrong = await verification.verifyBorrowMarket(marketFor(g), reader({ chainId: async () => 8453 }))
  assert.deepEqual([wrong.status, wrong.reasons], ['unverified', ['wrong_chain']])
})

test('the chain reader uses view functions only', () => {
  const source = code(readFileSync(`${root}src/lib/borrowMarketVerification.ts`, 'utf8'))
  const functions = [...source.matchAll(/'function [^']+'/g)].map((match) => match[0])
  assert.equal(functions.length, 3)
  assert.ok(functions.every((fn) => /\) view returns/.test(fn)), functions.join('\n'))
  assert.ok(!/writeContract|sendTransaction|signMessage|signTypedData|walletClient|createWalletClient|eth_send|personal_sign|window\.ethereum/.test(source))
  assert.ok(!/localStorage|sessionStorage|document\.cookie/.test(source))
})

// ---------------------------------------------------------------------------------------------------------------------
// Liquidity, utilization and risk checks

const borrowMarket = (over = {}) => ({
  marketId: GOLDEN[0].id, protocol: 'morpho', loanAsset: { symbol: 'USDC', address: USDC, decimals: 6 }, collateralAsset: { symbol: 'cirBTC', address: CIRBTC, decimals: 8 },
  lltv: 0.86, borrowApy: 0.024, utilization: 0.5, borrowAssets: null, liquidity: { token: 'USDC', tokenAddress: USDC, amount: '1000', decimals: 6 }, refreshedAt: null, ...over,
})
const verifiedState = (liquidity = 1_000_000_000n, oraclePrice = 5n) => ({ status: 'verified', details: { params: goldenParams(GOLDEN[0].oracle), oraclePrice, liquidity } })

test('Insufficient Liquidity: none, a dust amount below what the UI can show, or a borrow above the lower of the two figures', () => {
  const view = (reported, onchain) => ({ available: [reported, onchain].filter((v) => v !== null).reduce((a, b) => (preview.compareDecimals(b, a) < 0 ? b : a), '999999999999'), reported, onchain })
  assert.equal(preview.liquidityStatus({ available: null, reported: null, onchain: null }, '5').status, 'unknown')
  assert.equal(preview.liquidityStatus(view('0', null), null).status, 'none')
  assert.equal(preview.liquidityStatus(view('0.000003', '0.01'), null).status, 'none', 'dust below 0.01 USDC counts as none')
  assert.equal(preview.liquidityStatus(view('0.01', null), null).status, 'unchecked')
  assert.equal(preview.liquidityStatus(view('500', null), '500.000001').status, 'short')
  assert.equal(preview.liquidityStatus(view('500', null), '500').status, 'enough')
  const m = borrowMarket()
  assert.equal(preview.marketLiquidity(m, verifiedState(10_000_000n)).available, '10', 'the on-chain figure (10 USDC) is lower than the 1000 USDC reported, so it decides')
  assert.equal(preview.marketLiquidity(m, { status: 'unavailable' }).available, '1000')
  assert.equal(preview.marketLiquidity(borrowMarket({ liquidity: null }), { status: 'unavailable' }).available, null)
  assert.equal(preview.displayDigits(6), 2); assert.equal(preview.displayDigits(8), 8)
  assert.equal(preview.smallestShown(2), '0.01'); assert.equal(preview.smallestShown(8), '0.00000001')
  assert.equal(preview.isHighUtilization(0.9, 0.9), true); assert.equal(preview.isHighUtilization(0.89, 0.9), false); assert.equal(preview.isHighUtilization(null, 0.9), false)
})

test('the thresholds are fixed labels in config; no liquidity amount, APY or price is hardcoded', () => {
  assert.equal(config.MAINNET_BORROW_MAX_LTV, 0.7)
  assert.equal(config.MAINNET_BORROW_HIGH_UTILIZATION, 0.9)
  for (const file of ['src/components/MainnetBorrow.tsx', 'src/lib/borrowPreview.ts', 'src/lib/borrowWriteSafety.ts']) {
    // Class names (Tailwind opacity like /70) are styling, not thresholds.
    const source = code(readFileSync(`${root}${file}`, 'utf8')).replace(/className=("[^"]*"|\{`[^`]*`\})/g, '').replace(/'[^']*(?:slate|amber|red|emerald|border|bg-|text-)[^']*'/g, '')
    assert.ok(!/\b0\.7\b|\b0\.9\b|\b70\b|\b90\b/.test(source.replace(/toFixed\(\d\)|\b100\b/g, '')), `${file} reads the limits from config`)
    assert.ok(!/(liquidity|apy|price|utilization)\w*\s*[:=<>]+\s*\d/i.test(source), `${file} hardcodes no market figure`)
  }
  assert.match(tabSource, /MAINNET_BORROW_HIGH_UTILIZATION/)
  const safetySource = readFileSync(`${root}src/lib/borrowWriteSafety.ts`, 'utf8')
  for (const name of ['MAINNET_BORROW_MAX_LTV', 'MAINNET_BORROW_HIGH_UTILIZATION', 'MAINNET_BORROW_MAX_EVIDENCE_AGE_MS', 'MAINNET_BORROW_MAX_SLIPPAGE_BPS']) assert.match(safetySource, new RegExp(name), `the safety layer reads ${name} from config`)
  assert.equal(config.MAINNET_BORROW_MAX_EVIDENCE_AGE_MS, 60_000); assert.equal(config.MAINNET_BORROW_MAX_SLIPPAGE_BPS, 500)
})

// The risk model that used to live here (risk checks, target Health Factor, LTV, ordering) is now the shared safety layer in
// src/lib/borrowWriteSafety.ts, which the transaction boundary runs too. It is checked on raw values in
// scripts/verify-mainnet-borrow-write-safety.mjs.

// ---------------------------------------------------------------------------------------------------------------------
// Bounded pagination in the market proxy

const rawId = (n) => `0x${n.toString(16).padStart(64, '0')}`
const rawMarket = (n, over = {}) => ({
  marketId: rawId(n), protocol: 'morpho', chain: 'ARC',
  loanAsset: { symbol: 'USDC', address: USDC, decimals: 6 }, collateralAsset: { symbol: 'cirBTC', address: CIRBTC, decimals: 8 },
  lltv: 0.86, borrowAssets: { raw: '1000000', decimals: 6 }, liquidity: { raw: '500000', decimals: 6 }, borrowApy: 0.02, utilization: 0.5, refreshedAt: '2026-10-03T22:14:00.000Z', ...over,
})
const page = (markets, cursor) => ({ data: { markets, pagination: cursor === undefined ? {} : { pageAfter: cursor } } })
const reply = (body, status = 200) => ({ status, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) })
async function proxyCall(responder) {
  const urls = []
  let sent = null
  await proxy.handleBorrowMarketsProxy({
    method: 'GET', headers: {}, query: {}, send: (response) => { sent = response },
    fetchImpl: async (url, options) => { urls.push(url); assert.equal(options.method, 'GET'); assert.equal(options.redirect, 'manual'); assert.ok(options.signal instanceof AbortSignal); return responder(urls.length, url) },
  })
  return { urls, sent, body: sent.status === 200 ? JSON.parse(sent.body) : null }
}

await atest('proxy: one page stays one request and the body is unchanged', async () => {
  const { urls, sent, body } = await proxyCall(() => reply(page([rawMarket(2), rawMarket(1)])))
  assert.deepEqual(urls, [proxy.BORROW_MARKETS_UPSTREAM_URL])
  assert.equal(sent.headers['Cache-Control'], proxy.BORROW_CACHE_CONTROL)
  assert.deepEqual(Object.keys(body), ['schema', 'chain', 'pair', 'markets'], 'a complete list carries no extra field')
  assert.deepEqual(body.markets.map((m) => m.marketId), [rawId(1), rawId(2)], 'ordered by market ID')
})

await atest('proxy: follows Circle\'s cursor, merges the pages and stays cacheable when complete', async () => {
  const { urls, sent, body } = await proxyCall((n) => reply(n === 1 ? page([rawMarket(3)], 'abc_DEF-123=') : page([rawMarket(1), rawMarket(2)])))
  assert.deepEqual(urls, [proxy.BORROW_MARKETS_UPSTREAM_URL, `${proxy.BORROW_MARKETS_UPSTREAM_URL}&pageAfter=abc_DEF-123%3D`])
  assert.equal(body.markets.length, 3); assert.equal('complete' in body, false)
  assert.equal(sent.headers['Cache-Control'], proxy.BORROW_CACHE_CONTROL)
})

await atest('proxy: at most five pages; a list that does not finish is marked incomplete and not cached', async () => {
  const { urls, sent, body } = await proxyCall((n) => reply(page([rawMarket(n)], `cursor${n}`)))
  assert.equal(urls.length, 5)
  assert.equal(body.complete, false); assert.equal(body.markets.length, 5)
  assert.equal(sent.headers['Cache-Control'], 'no-store')
  const source = readFileSync(`${root}api/_lib/borrow-markets-proxy.js`, 'utf8')
  assert.equal([...source.matchAll(/fetchImpl\(/g)].length, 1, 'one fetch call site; the loop is bounded by MAX_PAGES')
  assert.match(source, /const MAX_PAGES = 5/); assert.match(source, /const REQUEST_TIMEOUT_MS = 8_000/)
})

await atest('proxy: a repeated, unsafe or oversized cursor is never followed; the list is incomplete', async () => {
  for (const cursor of ['x'.repeat(513), 'a b', 'a&chain=ETH', 'a#frag', 'a?b', 'a%2Fb', 7, { a: 1 }, '']) {
    const { urls, body } = await proxyCall(() => reply(page([rawMarket(1)], cursor)))
    assert.equal(urls.length, 1, `cursor ${JSON.stringify(cursor)} is not followed`)
    assert.equal(body.complete, false, JSON.stringify(cursor))
  }
  // A token made only of allowed characters is sent as one encoded query value: it cannot change the host, path or chain.
  const dotted = await proxyCall((n) => reply(n === 1 ? page([rawMarket(1)], '../loans') : page([rawMarket(2)])))
  const second = new URL(dotted.urls[1])
  assert.deepEqual([second.origin, second.pathname, second.searchParams.get('chain'), second.searchParams.get('pageAfter')], ['https://api.circle.com', '/v1/borrowKit/markets', 'ARC', '../loans'])
  assert.equal(second.searchParams.getAll('chain').length, 1)
  const loop = await proxyCall((n) => reply(page([rawMarket(n)], 'same')))
  assert.equal(loop.urls.length, 2, 'a cursor that repeats stops the walk'); assert.equal(loop.body.complete, false)
})

await atest('proxy: a later page that fails leaves the validated pages shown as incomplete; the first page failing is still an error', async () => {
  for (const second of [() => reply('x', 503), () => reply('x', 429), () => reply('not json'), () => reply(page([rawMarket(9, { chain: 'ETH' })])), () => { throw new Error('boom') }]) {
    const { body, sent } = await proxyCall((n) => (n === 1 ? reply(page([rawMarket(1)], 'next')) : second()))
    assert.equal(sent.status, 200); assert.equal(body.complete, false); assert.deepEqual(body.markets.map((m) => m.marketId), [rawId(1)])
  }
  assert.equal((await proxyCall(() => reply('x', 503))).sent.status, 503)
  assert.equal((await proxyCall(() => reply('{"nope":1}'))).sent.status, 502)
  const duplicate = await proxyCall((n) => reply(n === 1 ? page([rawMarket(1)], 'next') : page([rawMarket(1)])))
  assert.equal(duplicate.sent.status, 502, 'a market ID repeated across pages fails closed')
})

await atest('the browser loader marks an incomplete list and leaves a complete one exactly as before', async () => {
  const serve = (extra) => async () => ({ ok: true, json: async () => ({ schema: intelligence.BORROW_MARKETS_SCHEMA, chain: 'Arc', markets: [{
    marketId: rawId(1), protocol: 'morpho', loanAsset: { symbol: 'USDC', address: USDC, decimals: 6 }, collateralAsset: { symbol: 'cirBTC', address: CIRBTC, decimals: 8 },
    lltv: 0.86, borrowApy: 0.02, utilization: 0.5, borrowAssets: null, liquidity: null, refreshedAt: null }], ...extra }) })
  const complete = await intelligence.loadArcBorrowMarkets({ fetchImpl: serve({}) })
  assert.deepEqual(Object.keys(complete).sort(), ['markets', 'status'])
  const incomplete = await intelligence.loadArcBorrowMarkets({ fetchImpl: serve({ complete: false }) })
  assert.equal(incomplete.complete, false); assert.equal(incomplete.markets.length, 1)
  assert.equal((await intelligence.loadArcBorrowMarkets({ fetchImpl: serve({ complete: 'yes' }) })).complete, undefined, 'only an explicit false marks a list incomplete')
})

test('the tab shows the pair and short ID, flags facts only, and never ranks or recommends', () => {
  const body = code(tabSource)
  assert.ok(!/Market \$\{|`Market |label=\{`Market/.test(body), 'no "Market 1/2" labels')
  assert.match(body, /market\.collateralAsset\.symbol\} \/ \{market\.loanAsset\.symbol\}/)
  assert.match(body, /shortenMarketId\(market\.marketId\)/)
  for (const flag of ['Insufficient Liquidity', 'High utilization', 'Oracle data missing', 'Verified on-chain', 'Not verified']) assert.ok(tabSource.includes(flag), flag)
  assert.ok(!/\.sort\(|\.toSorted\(|reduce\(\s*\(best/.test(body.replace(/\[\.\.\.[^\]]+\]\.sort/g, '')), 'the tab never reorders markets')
  assert.ok(!/best (rate|market)|recommended|safest|top pick|lowest (rate|apy)|highest (liquidity|apy)/i.test(body))
  assert.ok(tabSource.includes('The maximum sits at the liquidation threshold'))
  assert.ok(tabSource.includes('Selected safety target not met') && tabSource.includes('does not prepare a transaction with different collateral'))
  assert.ok(!tabSource.includes('Below your selected target') && !tabSource.includes('It is not an error'), 'the gap is no longer presented as harmless')
})

test('the tab says "Preview only" and uses status language, never "safe"', () => {
  // Internal identifiers (the service's 'SAFE' band key, the 'safe' colour tone) are never rendered; everything else must be free of it.
  // The one allowed phrase is the label "Selected safety target not met": it names the user's own target, it does not call anything safe.
  const visible = (source) => code(source).replace(/\bsafe: '/g, '').replace(/\bTONE_CLASS\.safe\b/g, '').replace(/'(safe|SAFE)'/g, '').replace(/Selected safety target not met/g, '')
  for (const [file, source] of [['MainnetBorrow.tsx', tabSource], ['borrowPreview.ts', helperSource], ['borrowWriteSafety.ts', readFileSync(`${root}src/lib/borrowWriteSafety.ts`, 'utf8')]]) {
    assert.ok(!/\bsafe\w*/i.test(visible(source)), `${file} has no "safe" wording`)
  }
  assert.ok(!/\bSAFE\b/.test(visible(tabSource)), 'the service band name is never shown')
  assert.deepEqual(['SAFE', 'WARN', 'URGENT', 'IMMINENT', 'LIQUIDATABLE'].map(preview.healthBandLabel), [
    'Above liquidation threshold', 'Approaching liquidation threshold', 'Close to liquidation threshold', 'Very close to liquidation', 'Below liquidation threshold'])
  assert.deepEqual([2.6, 1.004, 1, 0.99, 0.5].map((hf) => preview.thresholdStatus(hf).label), [
    'Above liquidation threshold', 'At liquidation threshold', 'At liquidation threshold', 'Below liquidation threshold', 'Below liquidation threshold'])
  assert.equal(preview.thresholdStatus(1.2).tone, 'safe'); assert.equal(preview.thresholdStatus(0.9).tone, 'danger')
  for (const phrase of ['Preview only', 'Selected safety target not met']) assert.ok(tabSource.includes(phrase), phrase)
})

test('the screen separates the current loan from the new estimate, stays short, and keeps details behind toggles', () => {
  const body = tabSource
  // The market card button holds only the pair, APY, available liquidity, LLTV and the short labels.
  const start = body.indexOf('<button type="button" role="radio"')
  const card = body.slice(start, body.indexOf('</button>', start))
  assert.deepEqual([...card.matchAll(/<Metric label="([^"]+)"/g)].map((m) => m[1]), ['Borrow APY', 'Available liquidity', 'LLTV'])
  assert.ok(!/<Metric label="(Oracle|Rate model|Utilization|Total borrowed|Market ID|Liquidity on-chain)|shortenMarketId|verificationSentence|details\.params|market\.marketId\}<\/span>/.test(card), 'long details stay out of the card button')
  const details = body.slice(body.indexOf('data-borrow-details'), body.indexOf('function MarketsSection'))
  for (const label of ['Market ID', 'On-chain check', 'Oracle', 'Oracle price', 'Rate model', 'Liquidity on-chain', 'Utilization', 'Total borrowed', 'Updated']) assert.ok(details.includes(`label="${label}"`), label)

  // New Borrow Estimate: exactly these rows, in this order. Estimated and Target Health Factor are separate rows.
  const summary = body.slice(body.indexOf('data-borrow-summary'), body.indexOf('<ReadinessCard view'))
  assert.deepEqual([...summary.matchAll(/<Metric label="([^"]+)"/g)].map((m) => m[1]),
    ['Borrow Amount', 'Collateral Required', 'Borrow APY', 'Estimated Gas / Fees', 'Estimated Health Factor', 'Target Health Factor', 'Liquidation Price'])
  assert.ok(summary.includes('not your current Health Factor') && summary.includes('not a current loan'), 'the estimate says it is not the current loan')
  assert.ok(body.includes('healthTargetMet(shown.healthFactor, targetHealthFactor)'), 'Met / Not met is judged on the raw value')

  // Your loans: each loan keeps its own Health Factor; nothing is aggregated; "No active loan" is only said after a successful read.
  const loans = body.slice(body.indexOf('function PositionsSection'), body.indexOf('// Page'))
  for (const text of ['No active loan', 'Not applicable', 'Unavailable', 'Current loan', 'Current Health Factor', 'Connect a wallet to see it']) assert.ok(loans.includes(text), text)
  assert.ok(body.slice(body.indexOf('function PositionCard'), body.indexOf('function PositionsSection')).includes('label="Current Health Factor"'))
  assert.ok(/first\.status === 'unavailable' \? \{ loan: 'Unavailable', health: 'Unavailable' \}/.test(loans), 'a failed read says Unavailable, never No active loan')
  assert.ok(/noActive = first\.status === 'available' && active\.length === 0 && unreported\.length === 0 && next === null/.test(loans), 'No active loan needs a complete, successful read')
  assert.ok(!/reduce\(|Math\.min\(|Math\.max\(/.test(loans.slice(0, loans.indexOf('return ('))), 'no wallet-wide Health Factor is computed')
  assert.ok(body.indexOf('<PositionsSection walletAddress') < body.indexOf('<QuoteBuilder market'), 'the current loan comes before the new estimate')

  // Collateral: the typed field is not a wallet balance, the wallet balance is shown on its own, and the optional comparison is out of the main flow.
  assert.ok(!body.includes('Collateral you hold'))
  assert.ok(body.includes('Typed by you. It is not your wallet balance') && body.includes('data-borrow-wallet-balance'))
  assert.ok(body.indexOf('data-borrow-optional') > body.indexOf('data-borrow-wallet-balance') && body.indexOf('data-borrow-optional') < body.indexOf('data-borrow-summary'), 'the optional comparison sits below the main inputs')
  for (const state of ['Connect a wallet', 'Reading…', 'Unavailable']) assert.ok(body.slice(body.indexOf('function balanceLine'), body.indexOf('function QuoteBuilder')).includes(state), `balance line: ${state}`)

  // Transaction Readiness: short words on the main screen; technical checks, the closed toggle and the permanent Preview wording.
  for (const label of ['Ready for review', 'Blocked', 'Unavailable', 'Checking']) assert.ok(body.includes(`label: '${label}'`), label)
  assert.ok(body.includes('Preview only: real transactions are switched off in this release, whatever the status.'))
  assert.ok(/<details className="group mt-2" data-borrow-readiness-details>/.test(body) && /<details className="group rounded-2xl[^"]*" data-borrow-more>/.test(body) && /<details className="group rounded-xl[^"]*" data-borrow-optional>/.test(body))
  assert.ok(!/<details[^>]*\bopen\b/.test(body), 'every details starts closed')
  assert.ok(body.includes('Show {label}') && body.includes('Hide {label}') && body.includes('label="technical checks"') && body.includes('label="estimate details"') && body.includes('label="optional collateral comparison"'))
  assert.ok(body.includes('Market details'))
  assert.ok(!/RiskChecks|Risk summary|Show risk checks/.test(body), 'the old risk card is replaced by Transaction Readiness')
})

console.log(`\nBorrow preview checks: ${passed} passed`)
