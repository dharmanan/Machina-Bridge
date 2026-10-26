// Reporting succeeds for reviewed findings, not because npm audit was clean. Unknown risks and failed audits still fail.
import { readFileSync, appendFileSync } from 'node:fs'
const [path, statusText] = process.argv.slice(2), status = Number(statusText)
const audit = JSON.parse(readFileSync(path, 'utf8'))
if (![0, 1].includes(status) || audit.error || !audit.metadata?.vulnerabilities || !audit.vulnerabilities) throw new Error('Raw npm audit could not be completed; release evidence is missing.')
const assessed = new Set(['GHSA-mrhx-c7xc-m3w5', 'GHSA-848j-6mx2-7j84'])
const roots = [...new Map(Object.values(audit.vulnerabilities).flatMap(v => v.via.filter(x => typeof x === 'object')).map(v => [v.url, v])).values()]
const unknown = roots.filter(v => !v.url?.startsWith('https://github.com/advisories/') || !assessed.has(v.url.split('/').at(-1)))
const findings = audit.metadata.vulnerabilities
if ((status === 1 && roots.length === 0) || (status === 0 && findings.total > 0)) throw new Error('Audit status and findings are inconsistent; evidence is incomplete.')
const lines = [`Raw npm audit exit: **${status}**`, `Critical ${findings.critical}; high ${findings.high}; moderate ${findings.moderate}; low ${findings.low}.`,
  ...roots.map(v => `- ${v.severity}: ${v.title} — ${v.url}`),
  'Zod backport is partial: collection bounds alone do not protect unconstrained service bodies. Separate response bounds and runtime regressions are required.',
  'Elliptic is not patched. Bundle reachability evidence and current scope must be reviewed. Findings remain in the raw JSON artifact; no clean audit is claimed.']
console.log(lines.join('\n'))
if (roots.length) console.log('::warning::Raw npm audit contains findings. See the complete JSON artifact and assessed-risk summary; runtime safety checks are separate.')
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, lines.join('\n') + '\n')
if (unknown.length || findings.critical) throw new Error('An unassessed dependency root or critical advisory needs review before release.')
