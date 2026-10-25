// No SDK, network, wallet or environment mutation. These tests ensure the CI guard rejects actual gate openings.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { assertBorrowSourceGates, BORROW_SOURCE_GATES } from './verify-borrow-source-gates.mjs'
let count = 0
function test(name, run) { run(); count++; console.log('PASS ' + name) }
const source = readFileSync(new URL('../src/config/mainnetBorrow.ts', import.meta.url), 'utf8')
test('the actual source with explicit boolean types remains closed', () => assertBorrowSourceGates(source))
for (const typed of [true, false]) test('literal false with ' + (typed ? 'typed' : 'inferred') + ' declaration is accepted', () => {
  assertBorrowSourceGates(BORROW_SOURCE_GATES.map(n => `export const ${n}${typed ? ': boolean' : ''} = false`).join('\n'))
})
for (const name of BORROW_SOURCE_GATES) for (const value of ['true', '"false"', 'Boolean(false)', 'false || true']) test(name + ' rejects ' + value, () => {
  assert.throws(() => assertBorrowSourceGates(source.replace(new RegExp(`(${name}\\s*:\\s*boolean\\s*=\\s*)false`), '$1' + value)))
})
test('comments and strings cannot forge closed declarations', () => {
  const fake = BORROW_SOURCE_GATES.map(n => `export const ${n} = false`).join('\n')
  assert.throws(() => assertBorrowSourceGates('// ' + fake.replaceAll('\n', '\n// ')))
  assert.throws(() => assertBorrowSourceGates('export const note = ' + JSON.stringify(fake)))
})
test('duplicate or mutable declarations are rejected', () => {
  assert.throws(() => assertBorrowSourceGates(source + `\nexport const ${BORROW_SOURCE_GATES[0]} = false`))
  assert.throws(() => assertBorrowSourceGates(source.replace('export const MAINNET_BORROW_WRITES_ENABLED', 'export let MAINNET_BORROW_WRITES_ENABLED')))
})
test('CI invokes the checked file and retains the real audit failure gate', () => {
  const workflow = readFileSync(new URL('../.github/workflows/machina-production-verification.yml', import.meta.url), 'utf8')
  assert.match(workflow, /run: node scripts\/verify-borrow-source-gates\.mjs/)
  assert.match(workflow, /run: npm audit --omit=dev --audit-level=high/)
  assert.doesNotMatch(workflow, /continue-on-error|npm audit[^\n]*\|\|\s*true/)
})
console.log(`RESULT ${count}/${count} CI gate regressions PASS; no live traffic or wallet calls`)
