// Runs one suite group from scripts/ci-suites.json with bounded concurrency.
// Every suite runs to completion; output is printed per suite (grouped in CI)
// with its duration, and the run fails if ANY suite fails. Nothing is skipped.
//   node scripts/run-suites.mjs <group> [--concurrency N] [--timings file.json]
import { spawn } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { availableParallelism } from 'node:os'

const args = process.argv.slice(2), group = args[0]
const option = name => { const i = args.indexOf(name); return i > 0 ? args[i + 1] : undefined }
const manifest = JSON.parse(readFileSync(new URL('./ci-suites.json', import.meta.url), 'utf8'))
const suites = manifest.groups[group]
if (!Array.isArray(suites) || !suites.length) { console.error(`Unknown or empty suite group: ${group}`); process.exit(2) }
const concurrency = Math.max(1, Number(option('--concurrency') ?? manifest.concurrency?.[group] ?? Math.min(4, availableParallelism())))
const ci = Boolean(process.env.GITHUB_ACTIONS)

function run(suite) {
  return new Promise(resolve => {
    const started = Date.now(), child = spawn(process.execPath, [`scripts/${suite}.mjs`], { cwd: new URL('..', import.meta.url), env: process.env })
    let out = ''
    child.stdout.on('data', d => { out += d }); child.stderr.on('data', d => { out += d })
    child.on('close', code => resolve({ suite, code, seconds: (Date.now() - started) / 1000, out }))
  })
}
const started = Date.now(), queue = [...suites], results = []
await Promise.all(Array.from({ length: Math.min(concurrency, suites.length) }, async () => {
  while (queue.length) {
    const r = await run(queue.shift()); results.push(r)
    const head = `${r.code === 0 ? 'PASS' : 'FAIL'} ${r.suite} (${r.seconds.toFixed(1)} s)`
    console.log(ci ? `::group::${head}` : `── ${head}`); process.stdout.write(r.out.endsWith('\n') ? r.out : r.out + '\n'); if (ci) console.log('::endgroup::')
  }
}))
const total = (Date.now() - started) / 1000, failed = results.filter(r => r.code !== 0)
console.log(`\nSuite timings (${group}, concurrency ${concurrency}, wall ${total.toFixed(1)} s):`)
for (const r of [...results].sort((a, b) => b.seconds - a.seconds)) console.log(`  ${r.code === 0 ? 'pass' : 'FAIL'}  ${r.seconds.toFixed(1).padStart(6)} s  ${r.suite}`)
const file = option('--timings'); if (file) writeFileSync(file, JSON.stringify({ group, concurrency, wallSeconds: total, suites: results.map(({ suite, code, seconds }) => ({ suite, code, seconds })) }, null, 2))
if (failed.length) { console.error(`\n${failed.length} suite(s) failed: ${failed.map(r => r.suite).join(', ')}`); process.exit(1) }
console.log(`\nRESULT ${results.length}/${suites.length} suites PASS in group ${group}`)
