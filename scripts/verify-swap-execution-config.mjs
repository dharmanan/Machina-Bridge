// What the production build actually grants for each Swap build variable. Evaluates
// the real src/config/swapExecution.ts with controlled import.meta.env values.
// Pins current behaviour: it changes no access. Hermetic, no network.
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
const require = createRequire(import.meta.url), ts = require('typescript')
require.extensions['.ts'] = (mod, file) => mod._compile(ts.transpileModule(readFileSync(file, 'utf8').replaceAll('import.meta.env', 'globalThis.__SWAP_ENV'), { fileName: file,
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText, file)
const root = fileURLToPath(new URL('..', import.meta.url))
const mode = require(`${root}src/lib/swap/executionMode.ts`), p = require(`${root}src/lib/uniswapArcPolicy.ts`), pilot = require(`${root}src/lib/uniswapArcPilot.ts`)
const CONFIG = `${root}src/config/swapExecution.ts`
function build(env) {
  globalThis.__SWAP_ENV = env
  delete require.cache[CONFIG]
  return require(CONFIG).SWAP_EXECUTION
}
const APPROVED = pilot.ARC_PILOT_APPROVED_WALLET, STRANGER = '0x' + '22'.repeat(20)
const ctx = who => ({ connected: true, owner: who, chainId: 5042 })
const request = (who, tokenIn = 'USDC', tokenOut = 'EURC', amount = '1') => p.validateArcRequest({ chainId: 5042, tokenIn, tokenOut, owner: who, recipient: who, amount, minimumOutput: '1', slippageBps: 50, maxNetworkFee: '100000000000000000' })
// Who can execute: public (any wallet, any direction), pilot (approved wallet, USDC->EURC, <= 0.1), or nobody.
function access(cfg) {
  if (!cfg.enabled) return 'off'
  if (mode.swapExecutionRestriction(cfg, request(STRANGER, 'EURC', 'USDC'), ctx(STRANGER)) === null) return 'public'
  const small = mode.swapExecutionRestriction(cfg, request(APPROVED, 'USDC', 'EURC', '0.1'), ctx(APPROVED))
  const big = mode.swapExecutionRestriction(cfg, request(APPROVED, 'USDC', 'EURC', '1'), ctx(APPROVED))
  if (small === null && big !== null) return 'pilot'
  if (small === null && big === null) return 'approved-wallet-only'
  return 'off'
}
let count = 0
function test(name, fn) { fn(); count++; console.log('PASS ' + name) }

const cases = [
  [{}, 'public', 'unset mode and unset switch (current Vercel default unless the project sets them)'],
  [{ VITE_SWAP_EXECUTION_MODE: 'open' }, 'public', 'explicit open'],
  [{ VITE_SWAP_EXECUTION_MODE: 'canary' }, 'public', 'legacy canary value is mapped to open, NOT to a canary wallet'],
  [{ VITE_SWAP_EXECUTION_MODE: 'canary', VITE_UNISWAP_ARC_PILOT_WALLET: STRANGER }, 'public', 'a canary wallet variable does not restrict open'],
  [{ VITE_SWAP_EXECUTION_MODE: 'pilot' }, 'pilot', 'explicit pilot'],
  [{ VITE_SWAP_EXECUTION_MODE: 'pilot', VITE_UNISWAP_ARC_PILOT_WALLET: STRANGER }, 'off', 'pilot with another wallet fails closed'],
  [{ VITE_SWAP_EXECUTION_MODE: 'off' }, 'off', 'explicit off'],
  [{ VITE_SWAP_EXECUTION_MODE: 'Open' }, 'off', 'misspelled mode fails closed'],
  [{ VITE_SWAP_EXECUTION_MODE: ' open' }, 'off', 'padded mode fails closed'],
  [{ VITE_SWAP_EXECUTION_MODE: '' }, 'off', 'empty mode fails closed'],
  [{ VITE_UNISWAP_ARC_PILOT_ENABLED: 'false' }, 'off', 'kill switch with unset mode'],
  [{ VITE_UNISWAP_ARC_PILOT_ENABLED: 'false', VITE_SWAP_EXECUTION_MODE: 'open' }, 'off', 'kill switch beats open'],
  [{ VITE_UNISWAP_ARC_PILOT_ENABLED: 'TRUE' }, 'off', 'switch must be exactly "true"'],
]
for (const [env, expected, label] of cases) test(`${label}: ${JSON.stringify(env)} -> ${expected}`, () => assert.equal(access(build(env)), expected))

test('public mode keeps the chain, wallet-owner and request gates', () => {
  const cfg = build({})
  assert.equal(cfg.canaryWallet, undefined)
  assert.equal(mode.swapExecutionRestriction(cfg, request(STRANGER), { ...ctx(STRANGER), chainId: 1 }), 'network')
  assert.equal(mode.swapExecutionRestriction(cfg, request(STRANGER), { ...ctx(STRANGER), connected: false }), 'wallet')
  assert.equal(mode.swapExecutionRestriction(cfg, request(APPROVED), ctx(STRANGER)), 'wallet')
  assert.equal(mode.swapExecutionRestriction(cfg, null, ctx(STRANGER)), 'request')
})
test('the documented build table matches this behaviour', () => {
  const doc = readFileSync(`${root}docs/swap-unified.md`, 'utf8')
  assert.doesNotMatch(doc, /Unset or anything else/, 'a misspelled mode is off, not the default mode')
  assert.match(doc, /`canary`/)
})
console.log(`RESULT ${count}/${count} Swap build-access cases PASS; real config module, no network.`)
