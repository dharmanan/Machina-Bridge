// All inputs below are local fixtures. No network, RPC, wallet, or transaction.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { applyZodCollectionBackport } from './apply-zod-collection-backport.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..'), require = createRequire(import.meta.url)
let count = 0
async function test(name, run) { await run(); count++; console.log(`PASS ${name}`) }
await test('every locked parser is patched; a second installation is idempotent', () => {
  const before = applyZodCollectionBackport(root, { check: true })
  assert.deepEqual(applyZodCollectionBackport(root), before)
  assert.equal(before.packages, 16)
})

async function checkParser(z, label) {
  await test(`${label}: oversized collections never visit elements or outer refinements (sync/async)`, async () => {
    let visited = 0, refined = 0
    const element = z.string().superRefine(() => { visited++ })
    for (const schema of [z.array(element).max(2, 'bounded'), z.array(element).length(2, 'bounded')]) {
      const guarded = schema.superRefine(() => { refined++ })
      for (const data of [['a', 'b', 'c'], [1, 2, 3], new Array(100000)]) {
        const r = guarded.safeParse(data)
        assert.equal(r.success, false); assert.equal(r.error.issues.length, 1)
        assert.equal(r.error.issues[0].code, 'too_big'); assert.equal(r.error.issues[0].message, 'bounded')
      }
      assert.equal((await guarded.safeParseAsync(['a', 'b', 'c'])).success, false)
    }
    for (const schema of [z.set(element).max(2, 'bounded'), z.set(element).size(2, 'bounded')]) {
      const r = schema.superRefine(() => { refined++ }).safeParse(new Set(['a', 'b', 'c']))
      assert.equal(r.success, false); assert.equal(r.error.issues.length, 1)
      assert.equal(r.error.issues[0].code, 'too_big'); assert.equal(r.error.issues[0].message, 'bounded')
      assert.equal((await schema.safeParseAsync(new Set(['a', 'b', 'c']))).success, false)
    }
    assert.equal(visited, 0); assert.equal(refined, 0)
    const unreadable = new Proxy(['a', 'b', 'c'], { get(target, key, receiver) {
      if (key === Symbol.iterator || /^\d+$/.test(String(key))) throw new Error('Oversized array elements must never be accessed')
      return Reflect.get(target, key, receiver)
    } })
    assert.equal(z.array(element).max(2).safeParse(unreadable).success, false)
    const uniterable = new Set(['a', 'b', 'c'])
    uniterable.values = () => { throw new Error('Oversized set must never be iterated') }
    assert.equal(z.set(element).max(2).safeParse(uniterable).success, false)
    const nested = z.object({ a: z.array(element).max(1) }).safeParse({ a: [1, 2] })
    assert.equal(nested.success, false); assert.deepEqual(nested.error.issues[0].path, ['a']); assert.equal(visited, 0)
  })
  await test(`${label}: valid data, lower bounds, wrong types and v3 SDK APIs retain their contract`, async () => {
    const strings = z.array(z.string().transform(x => x.toUpperCase())).min(1).max(2)
    assert.deepEqual(strings.parse(['a', 'b']), ['A', 'B'])
    assert.deepEqual(await strings.parseAsync(['a']), ['A'])
    assert.equal(strings.safeParse([]).success, false)
    assert.equal(strings.safeParse('a').error.issues[0].code, 'invalid_type')
    assert.equal(z.array(z.string()).length(2).safeParse(['a']).error.issues[0].code, 'too_small')
    assert.equal(z.array(z.string()).max(2).safeParse(['a', 2]).error.issues[0].code, 'invalid_type')
    assert.deepEqual([...z.set(z.string()).size(2).parse(new Set(['a', 'b']))], ['a', 'b'])
    assert.equal(z.set(z.string()).size(2).safeParse(new Set(['a'])).error.issues[0].code, 'too_small')
    assert.equal(z.set(z.string()).max(1).safeParse(['a']).error.issues[0].code, 'invalid_type')
    const fn = z.function().args(z.string()).returns(z.string()).implement(s => s.toUpperCase())
    assert.equal(fn('a'), 'A'); assert.throws(() => fn(2))
    assert.deepEqual(z.record(z.number()).parse({ a: 1 }), { a: 1 })
    assert.equal(z.record(z.number()).safeParse({ a: '1' }).success, false)
    assert.deepEqual(z.object({ a: z.string() }).passthrough().parse({ a: 'x', b: 1 }), { a: 'x', b: 1 })
    assert.deepEqual(z.array(z.string()).max(1).catch(['fallback']).parse(['a', 'b']), ['fallback'])
    // v3 has no native bounded Map API. No invented .max semantics or arbitrary input cap is added.
    assert.equal(typeof z.map(z.string(), z.number()).max, 'undefined')
    assert.equal(z.map(z.string(), z.number()).safeParse(new Map([['x', 'bad']])).success, false)
  })
}

const lock = JSON.parse(readFileSync(resolve(root, 'package-lock.json'), 'utf8'))
for (const [path, { version }] of Object.entries(lock.packages).filter(([path]) => path.endsWith('/zod'))) {
  const base = resolve(root, path), pkg = JSON.parse(readFileSync(resolve(base, 'package.json'), 'utf8'))
  const cjs = version.startsWith('4.') ? require(resolve(base, 'v3/index.cjs')) : require(base)
  const esm = version.startsWith('4.') ? 'v3/index.js' : pkg.module
  await checkParser(cjs.z ?? cjs, `${path} ${version} CJS`)
  const imported = await import(pathToFileURL(resolve(base, esm)).href)
  await checkParser(imported.z ?? imported, `${path} ${version} ESM`)
  if (version === '3.22.4') await checkParser(require(resolve(base, 'lib/index.umd.js')), `${path} UMD`)
}

await test('unknown versions, missing/unpatched/drifting files and lock mismatch fail closed before mutation', () => {
  const temp = mkdtempSync(resolve(tmpdir(), 'machina-zod-backport-'))
  try {
    const base = resolve(temp, 'node_modules/zod'); mkdirSync(base, { recursive: true })
    const lockPath = resolve(temp, 'package-lock.json'), packagePath = resolve(base, 'package.json')
    const setVersion = version => {
      writeFileSync(lockPath, JSON.stringify({ packages: { 'node_modules/zod': { version } } }))
      writeFileSync(packagePath, JSON.stringify({ name: 'zod', version }))
    }
    setVersion('99.0.0'); assert.throws(() => applyZodCollectionBackport(temp), /not been reviewed/)
    setVersion('3.25.76'); assert.throws(() => applyZodCollectionBackport(temp), /ENOENT/)
    const dir = resolve(base, 'v3'); mkdirSync(dir)
    const manifest = JSON.parse(readFileSync(resolve(root, 'docs/dependency-security/zod-v3-backport.json'), 'utf8'))
    for (const file of ['types.cjs', 'types.js']) {
      const installed = readFileSync(resolve(root, 'node_modules/zod/v3', file), 'utf8')
      const original = installed.replace(/\n[ \t]*\/\/ MACHINA_GHSA_MRHX_C7XC_M3W5:[^\n]*\n[ \t]*(?:if \(tooBig\) )?return [\w.]*INVALID;/g, '')
      assert.equal(createHash('sha256').update(original).digest('hex'), manifest.versions['3.25.76'][`v3/${file}`].before)
      writeFileSync(resolve(dir, file), original)
    }
    assert.throws(() => applyZodCollectionBackport(temp, { check: true }), /backport is missing/)
    const untouched = readFileSync(resolve(dir, 'types.cjs'), 'utf8')
    writeFileSync(resolve(dir, 'types.js'), 'second file drift')
    assert.throws(() => applyZodCollectionBackport(temp), /reviewed upstream bytes/)
    assert.equal(readFileSync(resolve(dir, 'types.cjs'), 'utf8'), untouched, 'validate all files before any write')
    writeFileSync(resolve(dir, 'types.js'), readFileSync(resolve(root, 'node_modules/zod/v3/types.js'), 'utf8'))
    assert.deepEqual(applyZodCollectionBackport(temp), { packages: 1, files: 2 })
    assert.deepEqual(applyZodCollectionBackport(temp, { check: true }), { packages: 1, files: 2 })
    writeFileSync(resolve(dir, 'types.cjs'), 'drift'); assert.throws(() => applyZodCollectionBackport(temp), /reviewed upstream bytes/)
    assert.equal(readFileSync(resolve(dir, 'types.cjs'), 'utf8'), 'drift')
    writeFileSync(packagePath, JSON.stringify({ name: 'zod', version: '3.22.4' })); assert.throws(() => applyZodCollectionBackport(temp), /match the lockfile/)
  } finally { rmSync(temp, { recursive: true, force: true }) }
})
await test('upstream package identities, versions and lockfile integrity are not rewritten to suppress audit', () => {
  for (const [path, value] of Object.entries(lock.packages).filter(([path]) => path.endsWith('/zod'))) {
    const pkg = JSON.parse(readFileSync(resolve(root, path, 'package.json'), 'utf8'))
    assert.equal(pkg.name, 'zod'); assert.equal(pkg.version, value.version)
    assert.ok(value.integrity.startsWith('sha512-'))
  }
  const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'))
  assert.match(pkg.scripts.postinstall, /apply-zod-collection-backport/)
  assert.match(pkg.scripts.prebuild, /apply-zod-collection-backport\.mjs --check/)
  const manifest = JSON.parse(readFileSync(resolve(root, 'docs/dependency-security/zod-v3-backport.json'), 'utf8'))
  assert.equal(manifest.upstreamPatchSha256.length, createHash('sha256').digest('hex').length)
})
console.log(`RESULT ${count}/${count} PASS; API-compatible local backport; raw npm audit is not claimed clean.`)
