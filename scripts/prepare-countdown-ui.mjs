import fs from 'node:fs'
import path from 'node:path'

const filePath = path.join(process.cwd(), 'src', 'countdown', 'CountdownPage.tsx')
let source = fs.readFileSync(filePath, 'utf8')

source = source.replace(/\n\s*Download,/, '')

const downloadStart = source.indexOf('  const download = async () => {')
const canClaimStart = source.indexOf('  const canClaim =', downloadStart)
if (downloadStart !== -1 && canClaimStart !== -1) {
  source = source.slice(0, downloadStart) + source.slice(canClaimStart)
}

source = source.replace(
  /\n\s*<button\n\s*type="button"\n\s*onClick=\{\(\) => void download\(\)\}[\s\S]*?<\/button>/,
  '',
)

if (source.includes('Download card') || source.includes('const download = async')) {
  throw new Error('Countdown UI preparation failed: Download card code is still present.')
}

fs.writeFileSync(filePath, source)
console.log('Prepared countdown UI without Download card.')
