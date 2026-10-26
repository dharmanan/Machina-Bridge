import { build } from 'vite'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { applyZodCollectionBackport } from './apply-zod-collection-backport.mjs'
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const backport = applyZodCollectionBackport(root, { check: true })
const report = { backport, renderedZod: {}, historicalV4: [], renderedElliptic: [], scope: 'Browser production bundle; no runtime/network/wallet operation. Package presence alone is not exploitability proof.' }
await build({ root, build: { write: false, reportCompressedSize: false }, plugins: [{ name: 'security-bundle-evidence', generateBundle(_options, bundle) {
  for (const chunk of Object.values(bundle)) {
    if (chunk.type !== 'chunk') continue
    for (const [raw, info] of Object.entries(chunk.modules)) {
      if (info.renderedLength <= 0) continue
      const id = raw.replace(/^\0/, '').split('?')[0]
      if (id.includes('/node_modules/elliptic/')) report.renderedElliptic.push(id)
      const match = id.match(/(.*\/node_modules\/zod)\/(.*)/)
      if (!match) continue
      const pkg = JSON.parse(readFileSync(match[1] + '/package.json', 'utf8'))
      report.renderedZod[pkg.version] = (report.renderedZod[pkg.version] ?? 0) + 1
      if (pkg.version.startsWith('3.') && /(^|\/)v4\//.test(match[2])) report.historicalV4.push(id)
    }
  }
} }] })
const output = process.argv[2] ?? resolve(root, 'node_modules/.cache/machina-security-bundle.json')
mkdirSync(dirname(resolve(output)), { recursive: true })
writeFileSync(output, JSON.stringify(report, null, 2))
console.log('SECURITY_BUNDLE_EVIDENCE', JSON.stringify(report))
if (report.historicalV4.length) throw new Error('Unpatched historical Zod v4 is rendered; the v3 backport does not cover it.')
