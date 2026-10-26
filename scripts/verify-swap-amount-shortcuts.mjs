// Integer amount shortcuts only. No RPC, wallet, signature or transaction.
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
const require = createRequire(import.meta.url), ts = require('typescript')
require.extensions['.ts'] = (mod, file) => mod._compile(ts.transpileModule(readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, file)
const { swapShortcutAmount: amount, NATIVE_SWAP_FEE_RESERVE: reserve } = require('../src/lib/swapAmountShortcuts.ts')
let count = 0
function test(name, run) { run(); count++; console.log('PASS ' + name) }
test('ERC-20 shares floor in token base units for EURC, cirBTC and WETH', () => {
  assert.equal(amount(1000001n, 6, 25, false), '0.25')
  assert.equal(amount(123456789n, 8, 75, false), '0.92592591')
  assert.equal(amount(1000000000000000001n, 18, 50, false), '0.5')
  assert.equal(amount(123456789n, 8, 100, false), '1.23456789')
})
test('large balances never pass through floating point', () => {
  assert.equal(amount(900719925474099312345678n, 18, 25, false), '225179.981368524828086419')
})
test('native 18-decimal balance is floored to USDC 6-decimal input precision', () => {
  assert.equal(amount(1000001999999999999n, 6, 25, true), '0.25')
  assert.equal(amount(1000001999999999999n, 6, 75, true), '0.750001')
})
test('MAX reserves the entire existing fee ceiling and pilot cap is independent of fee reserve', () => {
  assert.equal(reserve, 100000000000000000n)
  assert.equal(amount(150000000000000000n, 6, 100, true, reserve, 100000n), '0.05')
  assert.equal(amount(350000000000000000n, 6, 100, true, reserve, 100000n), '0.1')
  assert.equal(amount(10n ** 20n, 6, 25, true, reserve, 100000n), '0.1')
})
test('missing, zero, or insufficient gas budget and dust never become MAX', () => {
  for (const budget of [undefined, 0n, -1n]) assert.throws(() => amount(10n ** 18n, 6, 100, true, budget), /gas/)
  for (const balance of [0n, reserve - 1n, reserve]) assert.throws(() => amount(balance, 6, 100, true, reserve), /gas/)
  assert.throws(() => amount(reserve + 999999999999n, 6, 100, true, reserve), /zero/)
})
test('unavailable or malformed balances and invalid precision/percentages fail closed', () => {
  for (const balance of [undefined, null, '100', 100, -1n, 2n ** 256n]) assert.throws(() => amount(balance, 6, 25, false), /balance/)
  for (const decimals of [-1, 19, 1.5]) assert.throws(() => amount(100n, decimals, 25, false), /balance/)
  for (const share of [0, 30, 101, NaN]) assert.throws(() => amount(100n, 6, share, false), /balance/)
  assert.throws(() => amount(1n, 6, 25, false), /zero/)
})
test('open MAX uses full balances beyond former caps and preserves uint-sized precision', () => {
  assert.equal(amount(100n * 10n ** 18n, 6, 100, true, reserve), '99.9')
  assert.equal(amount(123456789123456789123456n, 6, 100, false), '123456789123456789.123456')
  assert.equal(amount(10n ** 30n, 18, 100, false), '1000000000000')
  const nearUint256 = 2n ** 256n - 2n
  assert.equal(require('viem').parseUnits(amount(nearUint256, 18, 75, false), 18), nearUint256 * 75n / 100n)
})
console.log(`${count} balance shortcut groups PASS; no network or wallet operations.`)
