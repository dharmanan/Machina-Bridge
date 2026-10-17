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
const { MAINNET_BORROW_WRITES_ENABLED } = require(fileURLToPath(new URL('../src/config/mainnetBorrow.ts', import.meta.url)))
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
  assert.ok(handlers.every((handler) => /^(bump|onRetry|onReload|onSelect|\(\) => (setTargetHealthFactor\(value\)|void loadMore\(\)))$/.test(handler)), handlers.join(' | '))
})

test('the Borrow tab states the risks and never recommends a market or amount', () => {
  for (const phrase of ['Liquidation risk', 'health factor falls', 'Below 1.0', 'Variable interest', 'not a fixed rate', 'Limited liquidity',
    'Borrowing itself is not enabled yet', 'never asks your wallet to sign']) {
    assert.ok(tabSource.includes(phrase) || tabSource.replace(/\s+/g, ' ').includes(phrase), phrase)
  }
  assert.ok(!/recommend(ed)? (market|amount)|best (rate|market)|safe amount to borrow|guaranteed/i.test(code(tabSource)))
  assert.ok(tabSource.includes('the order is not a ranking'))
  assert.ok(tabSource.includes('not a safe amount'))
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

console.log(`\nBorrow preview checks: ${passed} passed`)
