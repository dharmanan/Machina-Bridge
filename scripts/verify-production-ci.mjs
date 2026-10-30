// No SDK, network, wallet or environment mutation. These tests ensure the CI guard rejects actual gate openings.
import assert from 'node:assert/strict'
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
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
test('CI records the real audit, reports known risks, preserves JSON and runs full suites only for main release checks and PRs', () => {
  const workflow = readFileSync(new URL('../.github/workflows/machina-production-verification.yml', import.meta.url), 'utf8')
  // The Borrow gate guard runs on every push through the manifest's fast group.
  const suites = JSON.parse(readFileSync(new URL('./ci-suites.json', import.meta.url), 'utf8'))
  assert.ok(suites.groups.fast.includes('verify-borrow-source-gates'))
  assert.match(workflow, /node scripts\/run-suites\.mjs fast/)
  assert.match(workflow, /if npm audit --omit=dev --json > npm-audit-production.json/)
  assert.match(workflow, /report-dependency-audit\.mjs npm-audit-production.json/)
  assert.match(workflow, /actions\/upload-artifact@v4/)
  assert.equal((workflow.match(/contains\(github.event.head_commit.message, '\[release-check\]'\)/g) ?? []).length, 2)
  assert.doesNotMatch(workflow, /feature\/uniswap-swap-preview/)
  assert.match(workflow, /refs\/heads\/main/)
  assert.match(workflow, /pull_request:\n\s+branches: \[main\]/)
  assert.doesNotMatch(workflow, /continue-on-error|npm audit[^\n]*\|\|\s*true/)
})
test('audit reporting retains known findings, rejects unknown roots, and fails on incomplete evidence', () => {
  const temp = mkdtempSync(join(tmpdir(), 'machina-audit-report-')), env = { ...process.env }; delete env.GITHUB_STEP_SUMMARY
  try {
    const file = join(temp, 'audit.json')
    const fixture = id => ({ vulnerabilities: { zod: { via: [{url:'https://github.com/advisories/'+id, severity:'high', title:'controlled fixture'}] } }, metadata: { vulnerabilities: {critical:0,high:1,moderate:0,low:0,total:1} } })
    const run = (data, code) => { writeFileSync(file, JSON.stringify(data)); return spawnSync(process.execPath, ['scripts/report-dependency-audit.mjs', file, String(code)], { cwd:new URL('..',import.meta.url), env, encoding:'utf8' }) }
    let result = run(fixture('GHSA-mrhx-c7xc-m3w5'),1)
    assert.equal(result.status,0); assert.match(result.stdout,/Raw npm audit exit: \*\*1\*\*/); assert.match(result.stdout,/no clean audit is claimed/)
    assert.notEqual(run(fixture('GHSA-unassessed-root'),1).status,0)
    const critical = fixture('GHSA-mrhx-c7xc-m3w5'); critical.metadata.vulnerabilities.critical=1
    assert.notEqual(run(critical,1).status,0)
    assert.notEqual(run({error:{code:'ENETUNREACH'}},2).status,0)
    assert.notEqual(run({vulnerabilities:{},metadata:{vulnerabilities:{critical:0,high:0,total:0}}},1).status,0)
  } finally { rmSync(temp,{recursive:true,force:true}) }
})
test('Vercel installs exactly the lockfile with the same Node major as CI', () => {
  const vercel = JSON.parse(readFileSync(new URL('../vercel.json', import.meta.url), 'utf8'))
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  const workflow = readFileSync(new URL('../.github/workflows/machina-production-verification.yml', import.meta.url), 'utf8')
  assert.equal(vercel.installCommand, 'npm ci')
  const ci = [...new Set([...workflow.matchAll(/node-version: '([^']+)'/g)].map(m => m[1]))]
  assert.deepEqual(ci, ['24'], 'every CI job runs the same Node major')
  assert.equal(pkg.engines?.node, ci[0] + '.x', 'Vercel reads engines.node for its runtime and build image')
  assert.doesNotMatch(workflow, /^\s*- run: npm install\b/m)
})
const { serverError } = await import('../api/_lib/http.js')
test('API 500 responses never echo internal error messages', () => {
  let sent, status; const logged = []; const log = console.error; console.error = (...a) => logged.push(a)
  const res = { status(s) { status = s; return this }, setHeader() { return this }, send(b) { sent = b; return this } }
  try { serverError(res, new Error('connect ECONNREFUSED 10.0.0.7:6379 redis://default:secret@internal')) } finally { console.error = log }
  assert.equal(status, 500); assert.deepEqual(JSON.parse(sent), { error: 'Internal server error' })
  assert.doesNotMatch(sent, /ECONNREFUSED|secret|redis/)
  assert.equal(logged.length, 1, 'the cause stays in the server log')
})
console.log(`RESULT ${count}/${count} CI gate regressions PASS; no live traffic or wallet calls`)
