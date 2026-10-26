// Compatible backport of GHSA-mrhx-c7xc-m3w5 to the installed Zod v3 parsers.
// Package identities/versions and npm audit output are deliberately unchanged.
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const sha256 = text => createHash('sha256').update(text).digest('hex')
function replaceOnce(text, pattern, replacement) {
  const matches = [...text.matchAll(new RegExp(pattern.source, 'g'))]
  if (matches.length !== 1) throw new Error('Unexpected Zod parser shape; update and review the backport before building.')
  return text.replace(pattern, replacement)
}
export function backportZodCollections(source) {
  const sections = [
    { name: 'ZodArray', end: 'get element()', patches: [
      [/message: def\.exactLength\.message,[\s\S]*?status\.dirty\(\);/, true],
      [/message: def\.maxLength\.message,[\s\S]*?status\.dirty\(\);/, false],
    ] },
    { name: 'ZodSet', end: 'min(minSize', patches: [[/message: def\.maxSize\.message,[\s\S]*?status\.dirty\(\);/, false]] },
  ]
  let output = source
  for (const section of sections) {
    const start = output.indexOf(`class ${section.name} extends ZodType {`)
    const end = output.indexOf(section.end, start)
    if (start < 0 || end < start) throw new Error('Missing reviewed Zod parser section.')
    let part = output.slice(start, end)
    const invalid = part.match(/return ([\w.]*INVALID);/)?.[1]
    if (!invalid) throw new Error('Missing reviewed Zod rejection sentinel.')
    for (const [pattern, exact] of section.patches) part = replaceOnce(part, pattern, match => {
      const indent = match.match(/\n([ \t]*)status\.dirty\(\);$/)?.[1]
      if (indent === undefined) throw new Error('Unexpected Zod parser indentation.')
      return `${match}\n${indent}// MACHINA_GHSA_MRHX_C7XC_M3W5: reject before visiting collection elements.\n${indent}${exact ? 'if (tooBig) ' : ''}return ${invalid};`
    })
    output = output.slice(0, start) + part + output.slice(end)
  }
  return output
}

export function applyZodCollectionBackport(root = repoRoot, { check = false } = {}) {
  const manifest = JSON.parse(readFileSync(resolve(repoRoot, 'docs/dependency-security/zod-v3-backport.json'), 'utf8'))
  const lock = JSON.parse(readFileSync(resolve(root, 'package-lock.json'), 'utf8'))
  const packages = Object.entries(lock.packages).filter(([path]) => path.endsWith('/zod'))
  if (!packages.length) throw new Error('No locked Zod packages found; review the security check.')
  const pending = [], checked = []
  // Validate every file before changing any. Unknown versions, missing files and drift fail installation/build.
  for (const [path, locked] of packages) {
    if (!path.startsWith('node_modules/') || path.split('/').includes('..')) throw new Error('Invalid locked package path.')
    const spec = manifest.versions[locked.version]
    if (!spec) throw new Error(`Zod ${locked.version} has not been reviewed for the collection backport.`)
    const installed = JSON.parse(readFileSync(resolve(root, path, 'package.json'), 'utf8'))
    if (installed.name !== 'zod' || installed.version !== locked.version) throw new Error('Installed Zod does not match the lockfile.')
    for (const [relative, hashes] of Object.entries(spec)) {
      if (relative.split('/').includes('..')) throw new Error('Invalid backport manifest path.')
      const file = resolve(root, path, relative), source = readFileSync(file, 'utf8'), hash = sha256(source)
      if (hash === hashes.after) { checked.push(file); continue }
      if (hash !== hashes.before) throw new Error(`Zod parser differs from the reviewed upstream bytes: ${path}/${relative}`)
      if (check) throw new Error(`Zod security backport is missing: ${path}/${relative}. Run the normal install lifecycle.`)
      const patched = backportZodCollections(source)
      if (sha256(patched) !== hashes.after) throw new Error('Backport output differs from the reviewed patch.')
      pending.push({ file, patched }); checked.push(file)
    }
  }
  for (const { file, patched } of pending) writeFileSync(file, patched)
  // Verify again after writes. No build may rely on a partly applied patch.
  if (pending.length) return applyZodCollectionBackport(root, { check: true })
  return { packages: packages.length, files: checked.length }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = applyZodCollectionBackport(repoRoot, { check: process.argv.includes('--check') })
  console.log(`PASS Zod collection backport: ${result.packages} locked packages, ${result.files} reviewed parser files; npm audit remains unsuppressed.`)
}
