// Keeps CI scope consistent with the product. No network, no wallets.
// - every scripts/verify-*.mjs is classified exactly once (CI group, manual, or pattern);
// - every ACTIVE feature has CI coverage; no PAUSED/RETIRED suite runs in normal or release CI
//   except its explicit "guard" (e.g. the Borrow source-gate check);
// - a PAUSED/RETIRED feature that becomes reachable from src/main.tsx again fails here until it is
//   marked ACTIVE and its suites are restored;
// - the workflow runs the manifest groups through scripts/run-suites.mjs and only runs legacy on request.
import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const manifest = JSON.parse(readFileSync(join(root, 'scripts/ci-suites.json'), 'utf8'))
const workflow = readFileSync(join(root, '.github/workflows/machina-production-verification.yml'), 'utf8')
let count = 0
function test(name, run) { run(); count++; console.log('PASS ' + name) }
const ciGroups = ['fast', 'full', 'browser'], ci = new Set(ciGroups.flatMap(g => manifest.groups[g]))
const status = f => manifest.features[f]?.status

test('every verify script is classified exactly once and every listed suite exists', () => {
  const files = readdirSync(join(root, 'scripts')).filter(f => /^verify-.*\.mjs$/.test(f)).map(f => f.slice(0, -4))
  const grouped = Object.entries(manifest.groups).filter(([g]) => !g.startsWith('before-')).flatMap(([, s]) => s)
  assert.equal(new Set(grouped).size, grouped.length, 'a suite is listed in two groups')
  for (const s of grouped) assert.ok(files.includes(s), `listed suite is missing: ${s}`)
  for (const s of files) {
    // A pattern only classifies files that are neither grouped nor listed as manual.
    const explicit = [grouped.includes(s), s in manifest.manual].filter(Boolean).length
    assert.ok(explicit === 1 || (explicit === 0 && manifest.patterns.some(p => new RegExp(p.regex).test(s))), `unclassified or double-classified suite: ${s}`)
  }
})
test('every grouped suite names a known feature; ACTIVE features are covered in CI', () => {
  for (const s of Object.values(manifest.groups).flat()) if (!s.startsWith('before-')) assert.ok(status(manifest.feature[s]), `suite without a known feature: ${s}`)
  for (const [f, v] of Object.entries(manifest.features)) {
    if (v.status !== 'ACTIVE') continue
    const covered = [...ci].some(s => manifest.feature[s] === f) || (v.coveredBy && ci.has(v.coveredBy))
    assert.ok(covered, `ACTIVE feature without CI coverage: ${f}`)
  }
})
test('PAUSED/RETIRED suites stay out of normal and release CI, except explicit guards', () => {
  for (const s of ci) {
    const f = manifest.feature[s], v = manifest.features[f]
    if (v.status === 'ACTIVE') continue
    assert.ok(v.guards?.includes(s), `${v.status} feature suite runs in CI: ${s}`)
  }
  for (const s of manifest.groups.legacy) assert.notEqual(status(manifest.feature[s]), 'ACTIVE', `ACTIVE suite parked in legacy: ${s}`)
  for (const [, v] of Object.entries(manifest.features)) for (const g of v.guards ?? []) assert.ok(manifest.groups.fast.includes(g), `guard must run on every push: ${g}`)
})
test('PAUSED/RETIRED features are not reachable from the application entry', () => {
  const seen = new Set()
  const resolveImport = (from, spec) => { if (!spec.startsWith('.')) return null; const b = resolve(dirname(from), spec); for (const c of [b, b + '.ts', b + '.tsx', b + '/index.ts', b + '/index.tsx']) if (existsSync(c) && statSync(c).isFile()) return c; return null }
  const walk = f => { if (seen.has(f) || !/\.(tsx?|jsx?)$/.test(f)) return; seen.add(f); for (const m of readFileSync(f, 'utf8').matchAll(/(?:import|export)[^'"]*?from\s*['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)|import\s+['"]([^'"]+)['"]/g)) { const r = resolveImport(f, m[1] || m[2] || m[3]); if (r) walk(r) } }
  walk(join(root, 'src/main.tsx'))
  const reachable = new Set([...seen].map(f => relative(root, f)))
  for (const [f, v] of Object.entries(manifest.features)) for (const e of v.entries ?? []) {
    assert.ok(existsSync(join(root, e)), `${f} entry no longer exists: ${e} (update the manifest)`)
    assert.ok(!reachable.has(e), `${f} is ${v.status} but ${e} is reachable from the app again: mark it ACTIVE and move its suites back into CI`)
  }
})
test('the workflow runs manifest groups via run-suites.mjs; legacy only on explicit request', () => {
  for (const g of ciGroups) assert.match(workflow, new RegExp(`node scripts/run-suites\\.mjs ${g}\\b`), `workflow does not run group ${g}`)
  const jobs = workflow.slice(workflow.indexOf('\njobs:')).split(/\n  (?=[\w-]+:\n)/)
  const legacyJobs = jobs.filter(j => j.includes('run-suites.mjs legacy'))
  assert.equal(legacyJobs.length, 1, 'legacy group must be runnable in exactly one job')
  assert.match(legacyJobs[0], /\n    if: github\.event_name == 'workflow_dispatch' && inputs\.legacy\n/, 'legacy suites must only run on manual request')
  for (const j of jobs) if (j !== legacyJobs[0]) assert.doesNotMatch(j, /run-suites\.mjs legacy/)
  for (const s of [...Object.values(manifest.groups).flat()]) if (!s.startsWith('before-')) assert.doesNotMatch(workflow, new RegExp(`node scripts/${s}\\.mjs`), `workflow runs ${s} outside the manifest runner`)
  for (const g of Object.keys(manifest.groups)) assert.ok(!g.startsWith('before-'), `temporary group left in manifest: ${g}`)
})
console.log(`RESULT ${count}/${count} CI coverage groups PASS; manifest, app entry graph and workflow are consistent`)
