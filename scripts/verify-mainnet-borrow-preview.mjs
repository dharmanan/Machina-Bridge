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
const statusModule = require(fileURLToPath(new URL('../src/lib/borrowStatus.ts', import.meta.url)))
const statusSource = readFileSync(`${root}src/lib/borrowStatus.ts`, 'utf8')
const safetySource = readFileSync(`${root}src/lib/borrowWriteSafety.ts`, 'utf8')
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
  assert.deepEqual(values('../lib/mainnetBorrow'), ['detectAtomicBatchCapability', 'getBorrowLoans', 'getBorrowMarket', 'planBorrowWrite', 'prepareBorrowQuoteForTarget', 'quoteMaxBorrow', 'quoteRequiredCollateral', 'summarizeCapabilityAnswer'])
  assert.deepEqual(values('../lib/borrowWriteSafety'), ['borrowAttemptScope', 'borrowReadiness', 'borrowWalletSession', 'explainAttempt', 'explainAttemptLog', 'healthTargetMet', 'unitsToDecimal'])
  assert.deepEqual(values('../lib/borrowStatus'), ['chooseBorrowStatus', 'groupWriteChecks'], 'the status is chosen by the pure presentation module')
  assert.deepEqual(values('../lib/borrowAttemptLedger'), ['browserAttemptStorage', 'createPersistentAttemptLedger'], 'only the persistent ledger; never the in-memory one')
  assert.ok(!/borrow-kit/.test(body), 'the SDK is only reached through the guarded boundary')
  assert.ok(!/executeBorrowWrite|verifyBorrowWriteBoundary|createBorrowAttemptLedger|BorrowWriteClient|MAINNET_BORROW_WRITE/.test(body), 'no execution, boundary or attempt path')
  assert.ok(!/useWalletClient|useWriteContract|useSendTransaction|useSignMessage|useSignTypedData|useSwitchChain|walletClient|getAdapter|wallet_(?!getCapabilities)|eth_/.test(body.replace(/wallet_getCapabilities/g, '')), 'the only wallet request is the read-only capability question')
  assert.ok(!/signTypedData|sendTransaction|writeContract|approve\(|\.borrow\(|\.repay\(|\.closeLoan\(|\.addCollateral\(/.test(body))
  assert.ok(!/localStorage|sessionStorage|document\.cookie|indexedDB/.test(body), 'the tab touches no storage itself: the attempt ledger module is the only place, and it saves attempts only')
  assert.ok(!/[lL]edger\??\.(begin|finish|resolve|discard)\(/.test(body) && /attemptLedger \? attemptLedger\.list\(\)/.test(body), 'the tab only reads the attempt history; it never writes or clears it')
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
  assert.ok(handlers.every((handler) => /^(bump|onRetry|onReload|onSelect|onRefresh|onRefreshQuote|\(\) => (inputs\.setTargetHealthFactor\(value\)|void loadMore\(\)))$/.test(handler)), handlers.join(' | '))
})

test('the Borrow tab states the risks and never recommends a market or amount', () => {
  for (const phrase of ['Liquidation risk', 'health factor falls', 'Below 1.0', 'Variable interest', 'not a fixed rate', 'Limited liquidity',
    'Your collateral can be liquidated if its value falls or your debt grows.', 'Understand the risks',
    'Preview only: real borrowing is not enabled in this version. Nothing is sent: no signature, approval or transaction']) {
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
  for (const flag of ['Insufficient Liquidity', 'High utilization', 'Oracle data missing', 'Verified on-chain', 'Not verified', 'Unavailable for borrowing']) assert.ok(tabSource.includes(flag), flag)
  assert.ok(!/\.sort\(|\.toSorted\(|reduce\(\s*\(best/.test(body.replace(/\[\.\.\.[^\]]+\]\.sort/g, '')), 'the tab never reorders markets')
  assert.ok(!/best (rate|market)|recommended|safest|top pick|lowest (rate|apy)|highest (liquidity|apy)/i.test(body))
  assert.ok(tabSource.includes('The maximum sits at the liquidation threshold'))
  assert.ok(tabSource.includes('Selected safety target not met') && tabSource.replace(/\s+/g, ' ').includes('Machina does not lower your target or prepare a different borrow'))
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

test('automatic Borrow estimate connects to one guarded Review, leaving manual controls in Advanced', () => {
  const body = tabSource
  const operations = readFileSync(`${root}src/components/BorrowOperations.tsx`, 'utf8')
  assert.match(body, /const controlled = borrowCanaryAllows\(walletAddress\)/)
  assert.match(body, /<NewBorrow model=\{model\} inputs=\{inputs\} onRefreshQuote=\{refreshQuote\} controlled=\{controlled\}/)
  assert.match(body, /actions=\{controlled \? <BorrowOperations guidedBorrow=\{guidedBorrow\}/)
  assert.match(body, /model\.status\.id === 'checks-passed'/)
  assert.match(body, /automaticGasCeilingWei <= 250_000_000_000_000_000n/)
  assert.match(body, /data-borrow-review-guidance/)
  assert.match(operations, /<details id="borrow-advanced-operations"/)
  assert.match(operations, /data-borrow-guided-flow/)
  assert.match(operations, /controller\?\.prepare\(request, guided\.targetHealthFactor, guided\.maxGasCost\)/)
  assert.match(operations, /disabled=\{!controller \|\| !guidedReady\}/)
  assert.ok(!body.includes('borrow-optional-estimate'))
})

test('the standard screen is short and plain; every technical detail sits in a closed section', () => {
  const body = tabSource
  const flat = body.replace(/\s+/g, ' ')
  const fn = (name, next) => body.slice(body.indexOf(`function ${name}`), body.indexOf(`function ${next}`))

  // Header and risk: one line, with the full text one click away.
  for (const phrase of ['Borrow USDC', 'Use cirBTC as collateral to borrow USDC on Arc.', 'Preview only', 'Your collateral can be liquidated if its value falls or your debt grows.', 'Understand the risks']) assert.ok(flat.includes(phrase), phrase)
  assert.ok(/<details data-borrow-disclosure="risks"/.test(body) && body.indexOf('Liquidation risk.') > body.indexOf('data-borrow-disclosure="risks"'), 'the long risk text is inside the closed disclosure')

  // The market card holds only the pair, the short ID, a short status, APY and available liquidity.
  const start = body.indexOf('<button type="button" role="radio"')
  const card = body.slice(start, body.indexOf('</button>', start))
  assert.deepEqual([...card.matchAll(/<dt[^>]*>([^<]+)<\/dt>/g)].map((m) => m[1]), ['Borrow APY · variable', 'Available liquidity'])
  assert.ok(!/Oracle|Rate model|>Utilization|Total borrowed|Market ID|Liquidity on-chain|LLTV|verificationSentence|details\.params/.test(card), 'long details stay out of the card button')
  assert.ok(card.includes('shortenMarketId(market.marketId)'), 'the short ID tells the two markets apart')
  for (const label of ['Unavailable for borrowing', 'Oracle data missing', 'Not verified', 'Not enough liquidity for this amount', 'Liquidity not reported', 'Available']) assert.ok(body.includes(`label: '${label}'`), label)

  // Market details (Advanced): everything that was on the card before, plus the evidence.
  const marketDetails = fn('MarketDetailsBlock', 'MarketDetailsBlock'.replace('MarketDetailsBlock', 'loanOverviewMarker'))
  void marketDetails
  const details = body.slice(body.indexOf('function MarketDetailsBlock'), body.indexOf('// Current loan'))
  for (const label of ['Market ID', 'On-chain verification', 'Oracle', 'Oracle price', 'Rate model', 'LLTV (liquidation LTV)', 'Available liquidity (Circle)', 'Liquidity on-chain', 'Utilization', 'Total borrowed', 'Data timestamp']) assert.ok(details.includes(`label="${label}"`), label)
  assert.ok(body.includes('are not ranked') && body.includes('never shown as verified'))
  assert.ok(body.includes('On-chain lending protocol:') && body.includes('Morpho lending market · Circle Borrow Kit quotes'), 'the market provider is visible without opening Advanced details')
  assert.ok(readFileSync(`${root}src/components/BorrowOperations.tsx`, 'utf8').includes('Morpho market:'), 'the selected action identifies its protocol')

  // New borrow estimate: exactly these rows, in this order. Estimated Health Factor carries the target relation.
  const estimateStart = body.indexOf('data-borrow-estimate>')
  const estimate = body.slice(estimateStart, body.indexOf('</dl>', estimateStart))
  const estimateCard = body.slice(body.indexOf('function EstimateCard'), body.indexOf('function NewBorrow'))
  assert.deepEqual([...estimate.matchAll(/<Metric label="([^"]+)"/g)].map((m) => m[1]),
    ['Borrow Amount', 'Collateral Required', 'Wallet Collateral Balance', 'Borrow APY (variable)', 'Estimated Gas / Fees', 'Estimated Health Factor', 'Liquidation Price'])
  assert.ok(estimateCard.includes('Your target: {target} —') && estimateCard.includes("'Met' : 'Not met'") && estimateCard.includes('Includes a ${bufferPercent} collateral buffer. Not a separate fee.'))
  assert.ok(body.includes('healthTargetMet(shown.healthFactor, targetHealthFactor)'), 'Met / Not met is judged on the raw value')
  assert.ok(flat.includes('1.0 is the liquidation threshold. A higher target keeps more distance from it, but even {target} is no guarantee.'))
  assert.ok(estimateCard.includes('The figures are hidden until the quote is refreshed.'), 'an expired quote shows no figures')
  assert.ok(!/Target Health Factor"/.test(estimate), 'no separate target row duplicates the number')

  // The two inputs and the one status are the top of the new borrow; the comparison and the sizing preview are not in the standard view.
  const newBorrow = body.slice(body.indexOf('function NewBorrow'), body.indexOf('// Advanced details'))
  assert.ok(newBorrow.indexOf('id="borrow-amount"') < newBorrow.indexOf('<EstimateCard') && newBorrow.includes('<StatusCard'))
  assert.ok(!/borrow-collateral|maxBorrow|sizing|Reference only|Illustrative interest/.test(newBorrow), 'the comparison, the sizing preview and the interest illustration are Advanced details only')

  // Current loan: each loan keeps its own Health Factor; nothing is aggregated; "No active loan" is only said after a successful read.
  const loans = body.slice(body.indexOf('function loanOverview'), body.indexOf('function CurrentLoan'))
  for (const text of ['No active loan', 'Unavailable', 'Connect a wallet to see it']) assert.ok(loans.includes(text), text)
  for (const label of ['Current debt', 'Collateral', 'Current Health Factor', 'Liquidation Price']) assert.ok(body.slice(body.indexOf('function LoanSummaryCard'), body.indexOf('function loanOverview')).includes(`label="${label}"`), label)
  assert.ok(/first\.status === 'unavailable' \? 'Unavailable'/.test(loans), 'a failed read says Unavailable, never No active loan')
  assert.ok(/noActive = first\.status === 'available' && active\.length === 0 && unreported\.length === 0 && next === null/.test(loans), 'No active loan needs a complete, successful read')
  assert.ok(!/reduce\(|Math\.min\(|Math\.max\(/.test(loans), 'no wallet-wide Health Factor is computed')
  assert.ok(body.slice(body.indexOf('function PositionCard'), body.indexOf('function LoanDetails')).includes('label="Current Health Factor"'))
  assert.ok(body.indexOf('<CurrentLoan walletAddress') < body.indexOf('<NewBorrow model'), 'the current loan comes before the new estimate')

  // Collateral: the typed field is not a wallet balance, the wallet balance is shown on its own.
  assert.ok(!body.includes('Collateral you hold'))
  assert.ok(body.includes('Typed by you. It is not your wallet balance') && body.includes('data-borrow-wallet-balance'))
  for (const state of ['Connect a wallet', 'Reading…', 'Unavailable']) assert.ok(body.slice(body.indexOf('function balanceLine'), body.indexOf('// What the wallet would be asked')).includes(state), `balance line: ${state}`)

  // One status, from the shared checks; the checks themselves are all kept in Advanced details.
  assert.ok(body.includes('chooseBorrowStatus({') && body.includes('checks: plan ? plan.checks : null'), 'the status reads the shared safety checks')
  assert.ok(body.includes('groupWriteChecks(checks)') && body.includes('data-readiness-check={check.id}'), 'every check is listed, grouped, in Advanced details')
  for (const label of ['Ready for review', 'Blocked', 'Unavailable', 'Checking']) assert.ok(body.includes(`label: '${label}'`), label)
  assert.ok(body.includes('Preview only: real transactions are switched off for this wallet.'))
  assert.ok(body.includes('Use Review loan actions for the approved-wallet canary; fresh batch, simulation and fee checks remain mandatory.'))
  assert.ok(body.includes('data-borrow-refresh-quote') && body.includes('Refresh quote'), 'an expired quote has one Refresh quote control')

  // Everything technical is a closed disclosure; none starts open.
  assert.ok(!/<details[^>]*\bopen\b/.test(body), 'every details starts closed')
  for (const id of ['advanced', 'market-details', 'quote-details', 'wallet-checks', 'loan-details', 'collateral-comparison']) assert.ok(body.includes(`id="${id}"`), `Advanced details: ${id}`)
  assert.ok(/<Disclosure id="advanced" level="outer"/.test(body))

  // Wallet compatibility, in the words a person needs; anything but "supported" is not suitable.
  for (const label of ['Atomic transactions supported', 'Not supported', 'Could not verify']) assert.ok(body.includes(`label: '${label}'`), label)
  assert.ok(body.includes('(not suitable for Borrow)') && body.includes('data-borrow-wallet-compat') && body.includes('Wallet network (chain ID)') && body.includes('MAINNET_BORROW_ADAPTER_CONTRACT'))
  assert.ok(body.includes('Machina asked your wallet one read-only question'), 'the details say what the wallet was asked')
  // Why nothing can continue after an unresolved attempt.
  assert.ok(body.includes('data-borrow-history-note') && body.includes('explainAttempt(') && body.includes('explainAttemptLog('))
  // Only a real quote for the wallet is the estimate; Circle's sizing preview is reference only.
  assert.ok(!/sizedOnly/.test(body) && body.includes('Reference only') && body.includes('not a quote for a transaction and nothing can be sent with it'))
  assert.ok(body.includes('The collateral buffer is part of the collateral shown as Collateral Required') && body.includes('It is not a separate fee.'))
  // The data the checks use is read together, so everything expires together and a refresh reads it all again; typed values live above it.
  assert.ok(body.includes('readAllLoans(walletAddress, client)') && body.includes('readBalancesOf(walletAddress, market') && body.includes('const refreshQuote = useCallback(() => setQuoteTick'))
  assert.ok(!/setBorrowText\(''\)|setCollateralText\(''\)|setTargetHealthFactor\(1\.5\)/.test(body.slice(body.indexOf('const refreshQuote'))), 'a refresh never clears what was typed')
})

// ---------------------------------------------------------------------------------------------------------------------
// What the screen says first (src/lib/borrowStatus.ts): one reason, in a fixed order, from the shared checks

const chk = (id, blocker, status, text = `${id} ${status}`) => ({ id, blocker, status, text })
const facts = { collateralSymbol: 'cirBTC', loanSymbol: 'USDC', collateralBalance: '0 cirBTC', collateralNeeded: '0.00021459 cirBTC', borrowAmount: '10 USDC', liquidityAvailable: '0.5 USDC', estimatedHealthFactor: '1.24', targetHealthFactor: '1.50', maxLtv: '70%' }
const ready = () => [chk('wallet', 'wallet_missing', 'pass'), chk('quote-fresh', 'quote_stale', 'pass'), chk('balance', 'insufficient_balance', 'pass'), chk('slippage', 'slippage_invalid', 'warn')]
const input = (over = {}) => ({ marketChosen: true, amountEntered: true, walletConnected: true, wallet: 'supported', history: { unresolved: null, unreliable: null }, checking: false, checks: ready(), quoteFailure: null, facts, ...over })
const choose = (over) => statusModule.chooseBorrowStatus(input(over))

test('status: the first thing a person needs to do or know, in a fixed order', () => {
  assert.equal(choose({ marketChosen: false }).title, 'Choose a market')
  assert.equal(choose({ walletConnected: false }).title, 'Connect your wallet')
  assert.equal(choose({ walletConnected: false, amountEntered: false }).title, 'Connect your wallet')
  assert.equal(choose({ amountEntered: false, checks: null }).title, 'Enter a borrow amount')
  assert.equal(choose({ wallet: 'wrong-network' }).title, 'Switch to Arc Mainnet')
  assert.equal(choose({ wallet: 'unsupported' }).title, 'Wallet not supported')
  assert.equal(choose({ wallet: 'unknown' }).title, 'Wallet not verified')
  assert.match(choose({ wallet: 'unknown' }).detail, /treated as not supported/)
  assert.equal(choose({ wallet: 'checking' }).tone, 'waiting')
  assert.equal(choose({ history: { unresolved: 'An earlier borrow is not settled.', unreliable: null } }).title, 'Earlier transaction not settled')
  assert.equal(choose({ history: { unresolved: null, unreliable: 'The history cannot be read.' }, amountEntered: false }).title, 'Transaction history unavailable')
  const passed = choose()
  assert.deepEqual([passed.id, passed.tone, passed.title, passed.canRefresh], ['checks-passed', 'ready', 'Transaction checks passed', false])
  assert.equal(choose({ checking: true, checks: null }).title, 'Checking your borrow')
})

test('status: the real reason first, in the words the brief asks for', () => {
  const only = (check, over = {}) => choose({ checks: [...ready().filter((item) => item.id !== check.id), check], ...over })
  const cases = [
    [chk('balance', 'insufficient_balance', 'fail'), 'Insufficient collateral', 'Your wallet has 0 cirBTC. You need 0.00021459 cirBTC for this borrow.'],
    [chk('health-target', 'health_target_not_met', 'fail'), 'Target Health Factor not met', "Circle's quote gives 1.24 against your 1.50 target. Machina does not lower your target for you."],
    [chk('liquidity', 'insufficient_liquidity', 'fail'), 'Insufficient liquidity', 'This market has 0.5 USDC available and you asked for 10 USDC. Try a smaller amount or another market.'],
    [chk('market-verified', 'market_unverified', 'fail'), 'Market unavailable', "This market did not pass Machina's on-chain checks. Choose another market."],
    [chk('market-verified', 'market_unverified', 'unknown'), 'Market unavailable', "This market could not be checked against Morpho right now. Refresh, or choose another market."],
    [chk('ltv', 'ltv_above_limit', 'fail'), 'Borrow too large for its collateral', 'This borrow would be above the 70% loan-to-value starting limit.'],
    [chk('balance', 'balance_unknown', 'unknown'), 'Wallet balance unavailable', 'Your wallet balance could not be read, so Machina cannot tell whether you have enough collateral.'],
    [chk('loan-exists', 'loan_exists', 'fail', 'The wallet already has a loan in this market.'), 'Loan check failed', 'The wallet already has a loan in this market.'],
    [chk('attempt', 'attempt_unresolved', 'fail', 'An earlier borrow is not settled.'), 'Earlier transaction not settled', 'An earlier borrow is not settled.'],
  ]
  for (const [check, title, detail] of cases) {
    const result = only(check)
    assert.equal(result.title, title, JSON.stringify(check)); assert.equal(result.detail, detail, title)
    assert.notEqual(result.tone, 'ready')
  }
  assert.equal(only(chk('wallet', 'wallet_missing', 'unknown')).id, 'cannot-continue', 'a check the screen has no words for is still reported, never passed')
  assert.equal(choose({ checks: ready(), quoteFailure: 'Circle could not price this borrow.' }).title, 'Quote unavailable', 'a quote that failed is never reported as passed')
  assert.deepEqual([choose({ checks: [chk('quote', 'quote_missing', 'unknown')], quoteFailure: 'Circle could not price this borrow.' })].map((r) => [r.title, r.detail, r.canRefresh]), [['Quote unavailable', 'Circle could not price this borrow.', true]])
})

test('status: an expired quote is one message, however many checks have aged out', () => {
  const stale = [chk('quote-fresh', 'quote_stale', 'unknown'), chk('market', 'evidence_stale', 'unknown'), chk('market-verified', 'evidence_stale', 'unknown'), chk('loan-exists', 'evidence_stale', 'unknown'),
    chk('balance', 'evidence_stale', 'unknown'), chk('liquidity', 'liquidity_unknown', 'unknown'), chk('ltv', 'ltv_unknown', 'unknown'), chk('health-target', 'health_unknown', 'unknown'), chk('oracle', 'oracle_unavailable', 'unknown')]
  const expired = choose({ checks: stale })
  assert.deepEqual([expired.id, expired.title, expired.detail, expired.canRefresh, expired.tone], ['quote-expired', 'Quote expired', 'Refresh to get current terms.', true, 'waiting'])
  assert.equal(choose({ checks: [chk('balance', 'evidence_stale', 'unknown')] }).title, 'Quote expired', 'any aged-out read expires the quote')
  assert.equal(choose({ checks: stale, checking: true }).title, 'Checking your borrow', 'while it is read again nothing else is claimed')
  assert.equal(choose({ checks: stale, wallet: 'unsupported' }).title, 'Wallet not supported', 'a wallet that cannot run Borrow is said first')
  assert.equal(choose({ checks: [chk('attempt', 'attempt_unresolved', 'fail'), ...stale] }).title, 'Earlier transaction not settled', 'an unsettled transaction is said before the quote')
})

test('status: nothing is ever "passed" unless every check has passed', () => {
  for (const status of ['fail', 'unknown']) {
    for (const blocker of ['wallet_missing', 'quote_stale', 'insufficient_balance', 'health_target_not_met', 'ltv_above_limit', 'market_unverified', 'loan_exists', 'attempt_store_unreliable', 'slippage_invalid', 'gas_unknown', null]) {
      assert.notEqual(choose({ checks: [...ready(), chk('x', blocker, status)] }).id, 'checks-passed', `${status} ${blocker}`)
    }
  }
  for (const empty of [null, []]) assert.notEqual(choose({ checks: empty }).id, 'checks-passed', 'no checks yet is not a pass')
  assert.equal(choose({ checks: [...ready(), chk('utilization', null, 'warn'), chk('oracle', 'oracle_unavailable', 'not-applicable')] }).id, 'checks-passed', 'warnings and not-applicable checks do not block, as in the safety layer')
  assert.ok(/Transaction checks passed/.test(tabSource) === false && statusSource.includes("'Transaction checks passed'"), 'the wording lives in one place')
})

test('status: every safety check lands in a group, none is dropped, blocked ones come first', () => {
  const ids = [...new Set([...safetySource.matchAll(/add\('([a-z-]+)'/g)].map((match) => match[1]))]
  assert.ok(ids.length >= 30, `${ids.length} check ids in the safety layer`)
  const all = ids.map((id, index) => chk(id, null, ['pass', 'fail', 'unknown', 'warn', 'not-applicable'][index % 5]))
  const groups = statusModule.groupWriteChecks(all)
  assert.ok(!groups.some((group) => group.id === 'other'), `every check id has a group: ${groups.find((group) => group.id === 'other')?.checks.map((check) => check.id)}`)
  assert.equal(groups.reduce((sum, group) => sum + group.checks.length, 0), all.length, 'no check is dropped or repeated')
  assert.deepEqual(statusModule.groupWriteChecks([chk('mystery', null, 'pass')]).map((group) => [group.id, group.checks.length]), [['other', 1]], 'an unknown check goes to Other, never away')
  for (const group of groups) {
    const rank = { fail: 0, unknown: 1, warn: 2, pass: 3, 'not-applicable': 4 }
    assert.deepEqual(group.checks.map((check) => rank[check.status]), [...group.checks.map((check) => rank[check.status])].sort((a, b) => a - b), `${group.id}: blocked first`)
    assert.equal(group.blocked + group.unavailable + group.warnings + group.passed <= group.checks.length, true)
  }
})

test('the standard screen cannot change a check or open a transaction path', () => {
  const status = code(statusSource)
  assert.ok(!/import[^\n]*(mainnetBorrow|borrowAttemptLedger|wagmi|viem)/.test(status.replace(/import type[^\n]*\n/g, '')), 'the status module is pure: no SDK, ledger, wallet or network')
  assert.ok(!/fetch\(|localStorage|sessionStorage|window\.|Date\.now|setTimeout/.test(status))
  assert.ok(!/\.status = |\.blocker = |\.text = |checks\.(push|splice|pop|shift)|\.filter\([^)]*=> false/.test(status), 'checks are read, never changed')
  assert.ok(!/MAINNET_BORROW_WRITES_ENABLED|executeBorrowWrite|verifyBorrowWriteBoundary/.test(code(tabSource)), 'the screen never reads or opens the write gate')
})

console.log(`\nBorrow preview checks: ${passed} passed`)
