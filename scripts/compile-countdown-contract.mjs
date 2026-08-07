import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import solc from 'solc'

const root = process.cwd()
const outputPath = path.join(root, 'src', 'countdown', 'contractArtifact.generated.ts')
const V3_COMMIT = 'f81d42689027a01ecbf39143243d51e1696eb2d4'
const V3_PATH = 'contracts/MachinaCountdown1155.sol'

const source = execFileSync('git', ['show', `${V3_COMMIT}:${V3_PATH}`], {
  cwd: root,
  encoding: 'utf8',
})

if (!source.includes('METADATA_VERSION = 3')) {
  throw new Error('V3 compile guard failed: expected metadata V3 source.')
}

const input = {
  language: 'Solidity',
  sources: {
    'MachinaCountdown1155.sol': { content: source },
  },
  settings: {
    optimizer: { enabled: true, runs: 200 },
    outputSelection: {
      '*': {
        '*': ['abi', 'evm.bytecode.object'],
      },
    },
  },
}

const output = JSON.parse(solc.compile(JSON.stringify(input)))
const errors = (output.errors ?? []).filter((entry) => entry.severity === 'error')
if (errors.length > 0) {
  console.error(errors.map((entry) => entry.formattedMessage).join('\n'))
  process.exit(1)
}

const artifact = output.contracts?.['MachinaCountdown1155.sol']?.MachinaCountdown1155
if (!artifact?.evm?.bytecode?.object) {
  throw new Error('MachinaCountdown1155 V3 bytecode was not produced.')
}

const file = `// AUTO-GENERATED from known-good metadata V3 commit. Do not edit.\n` +
  `export const COUNTDOWN_DEPLOY_ABI = ${JSON.stringify(artifact.abi, null, 2)} as const\n` +
  `export const COUNTDOWN_DEPLOY_BYTECODE = '0x${artifact.evm.bytecode.object}' as const\n`

fs.writeFileSync(outputPath, file)
console.log(`Generated countdown deployment artifact from V3 commit ${V3_COMMIT}.`)
