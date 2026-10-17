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

test('the Borrow tab imports only Borrow read functions and no write path', () => {
  const body = code(tabSource)
  const imported = body.match(/import\s*\{([^}]*)\}\s*from\s*'\.\.\/lib\/mainnetBorrow'/)?.[1]
  assert.ok(imported, 'imports the guarded Borrow boundary')
  const names = imported.split(',').map((name) => name.trim()).filter(Boolean)
  const values = names.filter((name) => !name.startsWith('type '))
  assert.deepEqual(values.sort(), ['getBorrowLoans', 'quoteBorrow', 'quoteMaxBorrow', 'quoteRequiredCollateral'])
  assert.ok(!/borrow-kit/.test(body), 'the SDK is only reached through the guarded boundary')
  assert.ok(!/executeBorrowWrite|planBorrowWrite|detectAtomicBatchCapability|BorrowWriteClient|BorrowWriteAction|MAINNET_BORROW_WRITE/.test(body))
  assert.ok(!/useWalletClient|useWriteContract|useSendTransaction|useSignMessage|useSignTypedData|useSwitchChain|walletClient|getAdapter|wallet_|eth_/.test(body))
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
  for (const file of ['src/components/MainnetBorrow.tsx', 'src/lib/borrowPreview.ts']) {
    // Class names (Tailwind opacity like /70) are styling, not thresholds.
    const source = code(readFileSync(`${root}${file}`, 'utf8')).replace(/className=("[^"]*"|\{`[^`]*`\})/g, '').replace(/'[^']*(?:slate|amber|red|emerald|border|bg-|text-)[^']*'/g, '')
    assert.ok(!/\b0\.7\b|\b0\.9\b|\b70\b|\b90\b/.test(source.replace(/toFixed\(\d\)|\b100\b/g, '')), `${file} reads the limits from config`)
    assert.ok(!/(liquidity|apy|price|utilization)\w*\s*[:=<>]+\s*\d/i.test(source), `${file} hardcodes no market figure`)
  }
  assert.match(tabSource, /MAINNET_BORROW_MAX_LTV/); assert.match(tabSource, /MAINNET_BORROW_HIGH_UTILIZATION/)
})

test('compareHealthFactor reports the gap at the two decimals shown', () => {
  assert.deepEqual(preview.compareHealthFactor(1.5, 1.34), { delta: -0.16, relation: 'below' })
  assert.deepEqual(preview.compareHealthFactor(1.5, 1.504), { delta: 0, relation: 'at' })
  assert.deepEqual(preview.compareHealthFactor(1.5, 1.8), { delta: 0.3, relation: 'above' })
})

const riskInput = (over = {}) => ({
  market: borrowMarket(), verification: verifiedState(), borrowAmount: '100', collateralAmount: '0.01', targetHealthFactor: 1.5,
  maxBorrow: { token: 'USDC', tokenAddress: USDC, amount: '800', decimals: 6 }, sizing: { healthFactor: 1.5 }, full: { ltv: 0.6, healthFactor: 1.6 },
  limits: { maxLtv: 0.7, highUtilization: 0.9 }, ...over,
})
const statuses = (report) => Object.fromEntries(report.checks.map((check) => [check.id, check.status]))

test('risk checks: pass, fail, unknown and pending are distinct, and missing data never passes', () => {
  const pass = preview.evaluateBorrowRisk(riskInput())
  assert.deepEqual(statuses(pass), { verification: 'pass', oracle: 'pass', liquidity: 'pass', utilization: 'pass', 'max-borrow': 'pass', ltv: 'pass', 'target-health-factor': 'pass' })
  assert.deepEqual([pass.blocked, pass.pending], [false, false])
  const warn = statuses(preview.evaluateBorrowRisk(riskInput({ market: borrowMarket({ utilization: 0.95 }), full: { ltv: 0.6, healthFactor: 1.2 } })))
  assert.deepEqual([warn.utilization, warn['target-health-factor']], ['warn', 'fail'], 'high utilization warns; a quote below the selected target is a blocker')
  const over = preview.evaluateBorrowRisk(riskInput({ full: { ltv: 0.7000001, healthFactor: 1.5 } }))
  assert.equal(statuses(over).ltv, 'fail'); assert.equal(over.blocked, true)
  assert.equal(statuses(preview.evaluateBorrowRisk(riskInput({ full: { ltv: 0.7, healthFactor: 1.5 } }))).ltv, 'pass', 'exactly at the limit is within it')
  assert.equal(statuses(preview.evaluateBorrowRisk(riskInput({ borrowAmount: '2000' }))).liquidity, 'fail')
  assert.equal(statuses(preview.evaluateBorrowRisk(riskInput({ borrowAmount: '900' })))['max-borrow'], 'fail')
  assert.equal(statuses(preview.evaluateBorrowRisk(riskInput({ market: borrowMarket({ liquidity: { token: 'USDC', tokenAddress: USDC, amount: '0', decimals: 6 } }), verification: { status: 'unavailable' } }))).liquidity, 'fail')
  // Missing data: unknown (blocks), never a pass and never a zero.
  const missing = preview.evaluateBorrowRisk(riskInput({ market: borrowMarket({ utilization: null, liquidity: null }), verification: { status: 'unavailable' }, maxBorrow: null, full: null, sizing: null }))
  assert.deepEqual(statuses(missing), { verification: 'unknown', oracle: 'unknown', liquidity: 'unknown', utilization: 'unknown', 'max-borrow': 'unknown', ltv: 'unknown', 'target-health-factor': 'unknown' })
  assert.equal(missing.blocked, true)
  // Not requested yet or still loading: pending, which blocks nothing but is not final.
  const waiting = preview.evaluateBorrowRisk(riskInput({ verification: { status: 'checking' }, borrowAmount: null, collateralAmount: null, maxBorrow: 'pending', sizing: 'pending', full: 'pending' }))
  assert.deepEqual(statuses(waiting), { verification: 'pending', oracle: 'pending', liquidity: 'pending', utilization: 'pass', 'max-borrow': 'skipped', ltv: 'pending', 'target-health-factor': 'pending' })
  assert.deepEqual([waiting.blocked, waiting.pending], [false, true])
  assert.deepEqual(preview.evaluateBorrowRisk(riskInput({ market: null })), { checks: [], blocked: false, pending: true })
})

test('risk checks: a quote below the selected health factor target is a blocker, not a warning', () => {
  // Selected 1.50, the Circle quote comes out at 1.24.
  const missed = preview.evaluateBorrowRisk(riskInput({ full: { ltv: 0.6, healthFactor: 1.24 } }))
  const target = missed.checks.find((c) => c.id === 'target-health-factor')
  assert.equal(target.status, 'fail'); assert.equal(missed.blocked, true)
  assert.match(target.text, /^Selected safety target not met: .*1\.24.*0\.26 below the 1\.50 you selected.*blocked/)
  assert.equal(preview.summarizeRisk(missed).text, 'Would be blocked: 1 failed.')
  assert.equal(statuses(preview.evaluateBorrowRisk(riskInput({ full: { ltv: 0.6, healthFactor: 1.5 } })))['target-health-factor'], 'pass', 'meeting the target passes')
  assert.equal(statuses(preview.evaluateBorrowRisk(riskInput({ full: { ltv: 0.6, healthFactor: 1.496 } })))['target-health-factor'], 'pass', 'the gap is judged at the two decimals shown')
  assert.equal(statuses(preview.evaluateBorrowRisk(riskInput({ full: { ltv: 0.6, healthFactor: 1.49 } })))['target-health-factor'], 'fail')
  assert.equal(statuses(preview.evaluateBorrowRisk(riskInput({ full: { ltv: 0.6, healthFactor: null } })))['target-health-factor'], 'unknown', 'a missing health factor is never a pass')
})

test('risk checks: empty optional collateral skips only the max-borrow check, everything else is still evaluated', () => {
  const noCollateral = preview.evaluateBorrowRisk(riskInput({ collateralAmount: null, maxBorrow: 'pending' }))
  assert.deepEqual(statuses(noCollateral), { verification: 'pass', oracle: 'pass', liquidity: 'pass', utilization: 'pass', 'max-borrow': 'skipped', ltv: 'pass', 'target-health-factor': 'pass' })
  assert.deepEqual([noCollateral.blocked, noCollateral.pending], [false, false], 'skipped neither blocks nor leaves the summary waiting')
  assert.match(noCollateral.checks.find((c) => c.id === 'max-borrow').text, /^Skipped: no collateral entered/)
  assert.deepEqual(preview.summarizeRisk(noCollateral), { tone: 'pass', text: 'All applicable checks pass. 1 skipped.' })
  // The checks that can run still catch problems without collateral.
  const missed = preview.evaluateBorrowRisk(riskInput({ collateralAmount: null, maxBorrow: 'pending', full: { ltv: 0.6, healthFactor: 1.24 } }))
  assert.equal(statuses(missed)['target-health-factor'], 'fail'); assert.equal(missed.blocked, true)
  const short = preview.evaluateBorrowRisk(riskInput({ collateralAmount: null, maxBorrow: 'pending', borrowAmount: '2000' }))
  assert.equal(statuses(short).liquidity, 'fail'); assert.equal(short.blocked, true)
  const warned = preview.evaluateBorrowRisk(riskInput({ collateralAmount: null, maxBorrow: 'pending', market: borrowMarket({ utilization: 0.95 }) }))
  assert.deepEqual(preview.summarizeRisk(warned), { tone: 'warn', text: 'No check failed, 1 warning. 1 skipped.' })
  // A real wait (the quote is still loading) is still a wait; collateral entered but no borrow amount is waiting for input.
  assert.equal(preview.evaluateBorrowRisk(riskInput({ collateralAmount: null, maxBorrow: 'pending', full: 'pending', sizing: 'pending' })).pending, true)
  assert.equal(statuses(preview.evaluateBorrowRisk(riskInput({ borrowAmount: null, maxBorrow: 'pending' })))['max-borrow'], 'pending')
  // With collateral entered the comparison is unchanged.
  assert.equal(statuses(preview.evaluateBorrowRisk(riskInput({ borrowAmount: '900' })))['max-borrow'], 'fail')
  assert.equal(statuses(preview.evaluateBorrowRisk(riskInput({ maxBorrow: null })))['max-borrow'], 'unknown')
})

test('risk checks: real blockers are listed first, then warnings, then everything else', () => {
  const report = preview.evaluateBorrowRisk(riskInput({
    market: borrowMarket({ utilization: 0.95 }), collateralAmount: null, maxBorrow: 'pending', borrowAmount: '2000', full: { ltv: 0.6, healthFactor: 1.24 },
  }))
  const order = report.checks.map((c) => `${c.id}:${c.status}`)
  assert.deepEqual(order, ['liquidity:fail', 'target-health-factor:fail', 'utilization:warn', 'max-borrow:skipped', 'verification:pass', 'oracle:pass', 'ltv:pass'],
    'blockers keep their evaluation order, warnings follow, skipped and passing checks come last')
  assert.equal(preview.summarizeRisk(report).text, 'Would be blocked: 2 failed, 1 warning.')
  const unknownFirst = preview.evaluateBorrowRisk(riskInput({ market: borrowMarket({ utilization: 0.95 }), verification: { status: 'unavailable' } }))
  assert.deepEqual(unknownFirst.checks.slice(0, 3).map((c) => c.status), ['unknown', 'unknown', 'warn'], 'cannot-be-evaluated counts as a blocker and precedes warnings')
  assert.deepEqual(preview.orderRiskChecks([]), [])
})

test('the utilization text describes market-wide rate risk and does not claim the available amount is small', () => {
  const warn = preview.evaluateBorrowRisk(riskInput({ market: borrowMarket({ utilization: 0.95 }) })).checks.find((c) => c.id === 'utilization')
  assert.equal(warn.status, 'warn')
  assert.match(warn.text, /^High market utilization \(95%\): most supplied funds are already lent out.*variable borrow rate can rise quickly/)
  assert.match(warn.text, /does not mean the available amount is small/)
  assert.ok(!/little liquidity|liquidity is left|low liquidity/i.test(`${warn.text} ${tabSource}`), 'no wording that treats absolute liquidity as low')
  assert.match(tabSource.replace(/\s+/g, ' '), /High market utilization \(at or above .*most supplied funds are already lent out.*variable borrow rate can rise quickly.*rate risk, not the amount available/)
})

test('risk checks: unverified and oracle-less markets block; the 70% cap falls back to LLTV ÷ sized health factor', () => {
  const unverified = preview.evaluateBorrowRisk(riskInput({ verification: { status: 'unverified', reasons: ['id_mismatch'], details: null } }))
  assert.equal(statuses(unverified).verification, 'fail'); assert.match(unverified.checks[0].text, /do not hash to this market ID/); assert.equal(unverified.blocked, true)
  const noOracle = preview.evaluateBorrowRisk(riskInput({ verification: verifiedState(1_000_000_000n, null) }))
  assert.equal(statuses(noOracle).oracle, 'fail'); assert.match(noOracle.checks.find((c) => c.id === 'oracle').text, /Oracle data is missing/)
  const derived = preview.evaluateBorrowRisk(riskInput({ full: 'pending', sizing: { healthFactor: 1.2 } }))
  const ltv = derived.checks.find((c) => c.id === 'ltv')
  assert.equal(ltv.status, 'fail'); assert.match(ltv.text, /71\.7%.*above the 70%.*derived: LLTV ÷ health factor/)
  assert.equal(statuses(preview.evaluateBorrowRisk(riskInput({ full: 'pending', sizing: { healthFactor: 1.5 } }))).ltv, 'pass')
  assert.equal(statuses(preview.evaluateBorrowRisk(riskInput({ full: null, sizing: null }))).ltv, 'unknown')
  const ltvOf = (over) => statuses(preview.evaluateBorrowRisk(riskInput(over))).ltv
  assert.equal(ltvOf({ full: 'pending', sizing: null }), 'unknown', 'no wallet and a failed sizing read: cannot be evaluated, not "waiting"')
  assert.equal(ltvOf({ full: 'pending', sizing: 'pending' }), 'pending')
  assert.equal(ltvOf({ full: null, sizing: 'pending' }), 'pending', 'the sizing read can still arrive')
  assert.equal(ltvOf({ full: 'pending', sizing: { healthFactor: null } }), 'pending')
  assert.equal(ltvOf({ full: null, sizing: { healthFactor: null } }), 'unknown')
  assert.match(preview.evaluateBorrowRisk(riskInput()).checks.find((c) => c.id === 'ltv').text, /not a guarantee against liquidation/)
})

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
  assert.ok(tabSource.includes('Selected safety target not met') && tabSource.includes('a future borrow would be blocked'))
  assert.ok(!tabSource.includes('Below your selected target') && !tabSource.includes('It is not an error'), 'the gap is no longer presented as harmless')
})

test('the tab says "Preview only" and uses status language, never "safe"', () => {
  // Internal identifiers (the service's 'SAFE' band key, the 'safe' colour tone) are never rendered; everything else must be free of it.
  // The one allowed phrase is the label "Selected safety target not met": it names the user's own target, it does not call anything safe.
  const visible = (source) => code(source).replace(/\bsafe: '/g, '').replace(/'(safe|SAFE)'/g, '').replace(/Selected safety target not met/g, '')
  for (const [file, source] of [['MainnetBorrow.tsx', tabSource], ['borrowPreview.ts', helperSource]]) {
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

test('the main screen is short: a six-row quote, one risk line, details behind toggles', () => {
  const body = tabSource
  // The market card button holds only the pair, APY, available liquidity, LLTV and the short labels.
  const start = body.indexOf('<button type="button" role="radio"')
  const card = body.slice(start, body.indexOf('</button>', start))
  assert.deepEqual([...card.matchAll(/<Metric label="([^"]+)"/g)].map((m) => m[1]), ['Borrow APY', 'Available liquidity', 'LLTV'])
  assert.ok(!/<Metric label="(Oracle|Rate model|Utilization|Total borrowed|Market ID|Liquidity on-chain)|shortenMarketId|verificationSentence|details\.params|market\.marketId\}<\/span>/.test(card), 'long details stay out of the card button')
  const details = body.slice(body.indexOf('data-borrow-details'), body.indexOf('function MarketsSection'))
  for (const label of ['Market ID', 'On-chain check', 'Oracle', 'Oracle price', 'Rate model', 'Liquidity on-chain', 'Utilization', 'Total borrowed', 'Updated']) assert.ok(details.includes(`label="${label}"`), label)
  // The summary quote: exactly these six rows, in this order.
  const summary = body.slice(body.indexOf('data-borrow-summary'), body.indexOf('<RiskChecks report={risk} />'))
  assert.deepEqual([...summary.matchAll(/<Metric label="([^"]+)"/g)].map((m) => m[1]), ['Borrow amount', 'Collateral needed', 'Borrow APY', 'Estimated gas', 'Health factor', 'Liquidation price'])
  // Risk checks and the remaining quote rows sit in <details> that start closed, with Show/Hide toggles.
  assert.ok(/<details className="group mt-2" data-borrow-risk-details>/.test(body) && /<details className="group rounded-2xl[^"]*" data-borrow-more>/.test(body))
  assert.ok(!/<details[^>]*\bopen\b/.test(body), 'every details starts closed')
  assert.ok(body.includes('Show {label}') && body.includes('Hide {label}') && body.includes('label="risk checks"') && body.includes('label="quote details"'))
  assert.ok(body.includes('Market details'))
  const summarize = (statuses, flags) => preview.summarizeRisk({ checks: statuses.map((status, i) => ({ id: String(i), status, text: '' })), ...flags })
  assert.equal(summarize(['fail', 'unknown'], { blocked: true, pending: false }).text, 'Would be blocked: 1 failed, 1 cannot be evaluated.')
  assert.deepEqual(summarize(['warn', 'warn'], { blocked: false, pending: false }), { tone: 'warn', text: 'No check failed, 2 warnings.' })
  assert.equal(summarize(['pending'], { blocked: false, pending: true }).tone, 'pending')
  assert.deepEqual(summarize(['pass'], { blocked: false, pending: false }), { tone: 'pass', text: 'All checks pass.' })
})

console.log(`\nBorrow preview checks: ${passed} passed`)
