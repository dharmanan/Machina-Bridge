// Fee presentation (src/lib/feeDisplay.ts): short text from exact base units.
// Only display strings are produced; review/commitment values are untouched.
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { parseUnits } from 'viem'
const require = createRequire(import.meta.url), ts = require('typescript')
require.extensions['.ts'] = (m, p) => m._compile(ts.transpileModule(readFileSync(p, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText, p)
const { formatFeeAmount, feeEstimate, feeLimit } = require('../src/lib/feeDisplay.ts')
let count = 0
function test(name, run) { run(); count++; console.log('PASS ' + name) }

test('real Arc gas values become short estimates and an explicit maximum', () => {
  assert.equal(feeEstimate(3_063_247_218_639_756n, 18, 'USDC'), '≈ 0.0031 USDC')
  assert.equal(feeLimit(4_442_913_771_384_000n, 18, 'USDC'), '0.00445 USDC')
  assert.equal(feeEstimate(5_754_400n, 9, 'SUI'), '≈ 0.0058 SUI')
  assert.equal(feeLimit(50_000_000n, 9, 'SUI'), '0.05 SUI')
  assert.equal(feeEstimate(1_234_567_890_000_000_000n, 18, 'USDC'), '≈ 1.23 USDC')
})
test('zero is 0; a tiny positive fee is never shown as 0; a limit is never shown below its exact value', () => {
  assert.equal(feeEstimate(0n, 18, 'USDC'), '0 USDC')
  assert.equal(feeEstimate(1n, 18, 'USDC'), '< 0.000001 USDC')
  assert.equal(feeEstimate(499_999_999_999n, 18, 'USDC'), '< 0.000001 USDC')
  assert.equal(feeLimit(1n, 18, 'USDC'), '0.000001 USDC')
  assert.equal(feeEstimate(1n, 9, 'SUI'), '< 0.000001 SUI')
  assert.throws(() => formatFeeAmount(-1n, 18))
})
test('property: for 5,000 values across 1 wei .. 10^21 the text is never 0, at most 6 decimals, the limit is >= exact and the estimate within its rounding step', () => {
  let seed = 7n; const next = () => (seed = (seed * 6364136223846793005n + 1442695040888963407n) % (1n << 64n))
  for (let n = 0; n < 5000; n++) {
    const value = 1n + next() % (10n ** BigInt(1 + Number(next() % 21n))), est = formatFeeAmount(value, 18), lim = formatFeeAmount(value, 18, { round: 'up', significant: 3 })
    assert.notEqual(est, '0'); assert.notEqual(lim, '0')
    for (const t of [est, lim]) assert.ok((t.replace('< ', '').split('.')[1] ?? '').length <= 6, t)
    assert.ok(parseUnits(lim, 18) >= value, `limit ${lim} < ${value}`)
    if (!est.startsWith('<')) { const [, f = ''] = est.split('.'); const step = 10n ** BigInt(18 - Math.max(f.length, 2)); const diff = parseUnits(est, 18) - value; assert.ok(diff <= step / 2n + 1n && -diff <= step / 2n, `${est} vs ${value}`) }
  }
})
test('USDC transfer amounts keep 6 decimals: the review rows for amount and Circle fee are not passed through the fee formatter', () => {
  const src = readFileSync(new URL('../src/components/MainnetSuiTransfer.tsx', import.meta.url), 'utf8')
  assert.match(src, /<Row k="Amount" v=\{`\$\{formatUnits\(review\.intent\.amount, 6\)\} USDC`\} \/>/)
  assert.match(src, /<Row k="Maximum Circle fee" v=\{`\$\{formatUnits\(review\.intent\.maxCctpFee, 6\)\} USDC`\} \/>/)
  assert.match(src, /Estimated network fee \{gasText\(review\.intent\.action, review\.estimatedGas\)\} · limit \{gasText\(review\.intent\.action, review\.maximumGas\)\}/, 'Technical details keep the exact values')
})
console.log(`RESULT ${count}/${count} fee display groups PASS; presentation only.`)
