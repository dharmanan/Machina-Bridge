// B3: quote-based Earn fee display. No RPC, wallet or mainnet interaction.
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
const require = createRequire(import.meta.url)
const ts = require('typescript')
const content = readFileSync(new URL('../src/lib/earnFeeDisclosure.ts', import.meta.url), 'utf8')
const js = ts.transpileModule(content, { compilerOptions: {
  module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022
}, reportDiagnostics: true })
assert.equal(js.diagnostics?.filter(d => d.category === ts.DiagnosticCategory.Error).length ?? 0, 0)
const module = { exports: {} }
new Function('module', 'exports', js.outputText)(module, module.exports)
const { summarizeEarnQuoteFees } = module.exports

const fees = summarizeEarnQuoteFees({ fees: [
  { type: 'circle', amount: '0.00004', symbol: 'USDC' },
  { type: 'protocol', amount: '0.002', symbol: 'USDC' },
], expectedShares: { amount: '0.1983', symbol: 'shares' } })
assert.equal(fees.state, 'reported')
assert.deepEqual(fees.circleFees.map(x => [x.amount, x.symbol]), [['0.00004', 'USDC']])
assert.equal(fees.otherFees[0].label, 'protocol fee')
assert.equal(fees.expectedShares, '0.1983')
console.log('PASS fee entries preserve exact Circle/other amounts, tokens and shares')

const none = summarizeEarnQuoteFees({ fees: [] })
assert.equal(none.state, 'reported')
assert.equal(none.circleFees.length, 0)
// Empty fee arrays must not be advertised as proof that an on-chain fee is zero.
const display = readFileSync(new URL('../src/components/MainnetEarnActions.tsx', import.meta.url), 'utf8')
assert.ok(display.includes('Circle service fee: not listed in this quote.'))
assert.ok(!display.includes('Circle service fee: 0 (no Circle fee listed'))
console.log('PASS empty reported list is not fabricated into a nonzero fee')

assert.equal(summarizeEarnQuoteFees({ amount: '0.1' }).state, 'missing')
assert.equal(summarizeEarnQuoteFees({ fees: [{ type: 'circle', amount: '0x10', symbol: 'USDC' }] }).state, 'invalid')
console.log('PASS absent or invalid fee breakdown is never treated as zero')

const mixed = summarizeEarnQuoteFees({ fees: [{ type: 'circle', amount: '0.1', symbol: 'EURC' }] })
assert.equal(mixed.circleFees[0].symbol, 'EURC')
console.log('PASS token is read from the quote, never assumed to be USDC')
