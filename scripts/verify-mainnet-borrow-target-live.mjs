// Live, read-only check of how Circle's Borrow Kit sizes collateral against a Health Factor target on Arc mainnet. Keyless Borrow
// Service previews only: no wallet, no signature, no approval, no transaction. A dummy public address prices the first-open quote.
//
//   node scripts/verify-mainnet-borrow-target-live.mjs
//   (behind a proxy: NODE_USE_ENV_PROXY=1 node scripts/verify-mainnet-borrow-target-live.mjs)
//
// What it shows, and what Machina's target search relies on:
//  - a borrow quote and the borrow call take no collateral and no target Health Factor (checked in verify-mainnet-borrow-write-safety.mjs);
//  - the service sizes the exact base collateral for a base Health Factor, and `slippageBps` adds that percentage to the collateral,
//    so the quote's Health Factor is  base x (1 + slippageBps / 10 000);
//  - prepareBorrowQuoteForTarget finds a buffer from that and accepts it only when the quote Circle returns for it reaches the target.
// It does NOT show what a signed borrow envelope supplies on-chain; that needs a real borrow and is a Stage 3 canary item.
//
// Exit 0: every check PASS. Exit 1: the relation no longer holds (the target search must be re-examined). Exit 2: service unreachable.
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const ts = require('typescript')
require.extensions['.ts'] = (loadedModule, filename) => {
  const { outputText } = ts.transpileModule(readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
    fileName: filename,
  })
  loadedModule._compile(outputText, filename)
}
const here = (path) => fileURLToPath(new URL(path, import.meta.url))
const borrow = require(here('../src/lib/mainnetBorrow.ts'))
const { MAINNET_BORROW_WRITES_ENABLED } = require(here('../src/config/mainnetBorrow.ts'))
if (MAINNET_BORROW_WRITES_ENABLED !== false) { console.error('FAIL write gate is not false; refusing to run'); process.exit(1) }

const DUMMY_WALLET = '0x1111111111111111111111111111111111111111'
let worst = 0
const note = (code) => { worst = Math.max(worst, code) }
const pass = (text) => console.log(`PASS ${text}`)
const fail = (text) => { console.log(`FAIL ${text}`); note(1) }
const unreachable = (text) => { console.log(`UNAVAILABLE ${text}`); note(2) }

const markets = await borrow.exploreBorrowMarkets({ pageSize: 20 })
if (markets.status !== 'available') { unreachable(`markets: ${markets.error.code}`); process.exit(2) }
const market = markets.data.items.find((item) => item.loanAsset.symbol === 'USDC' && item.collateralAsset.symbol === 'cirBTC' && item.liquidity && Number(item.liquidity.amount) >= 1000)
if (!market) { unreachable('no cirBTC / USDC market with liquidity on the first page'); process.exit(2) }
console.log(`Market ${market.marketId} (LLTV ${market.lltv})`)

const quoteAt = async (amount, slippageBps) => {
  const result = await borrow.quoteBorrow({ marketId: market.marketId, walletAddress: DUMMY_WALLET, borrowAmount: amount, slippageBps })
  return result.status === 'available' && result.data.kind === 'borrow' ? result.data : null
}

for (const amount of ['10', '1000']) {
  const base = await quoteAt(amount, 0)
  const standard = await quoteAt(amount, undefined)
  if (!base || !standard || base.resultingHealthFactor === null || standard.resultingHealthFactor === null) { unreachable(`${amount} USDC: quote unavailable`); continue }
  console.log(`\n${amount} USDC: exact sizing HF ${base.resultingHealthFactor.toFixed(4)}, Circle's default (300 bps) HF ${standard.resultingHealthFactor.toFixed(4)}`)
  // The collateral grows by the buffer, and the Health Factor with it.
  let linear = true
  for (const bps of [100, 300, 500, 1000, 2500]) {
    const quote = await quoteAt(amount, bps)
    if (!quote || quote.resultingHealthFactor === null) { unreachable(`${amount} USDC at ${bps} bps: quote unavailable`); linear = false; continue }
    const expected = base.resultingHealthFactor * (1 + bps / 10_000)
    const collateral = Number(quote.collateral.amount)
    const expectedCollateral = Number(base.collateral.amount) * (1 + bps / 10_000)
    // Collateral has 8 decimals, so a small borrow rounds visibly: allow a few units of the last digit.
    const slack = Math.max(0.0015, 3 / (Number(base.collateral.amount) * 10 ** base.collateral.decimals))
    const off = Math.abs(quote.resultingHealthFactor - expected) / expected
    if (off > slack || Math.abs(collateral - expectedCollateral) / expectedCollateral > slack) { fail(`${amount} USDC at ${bps} bps: HF ${quote.resultingHealthFactor.toFixed(4)}, expected about ${expected.toFixed(4)}`); linear = false }
  }
  if (linear) pass(`${amount} USDC: collateral and Health Factor scale with the slippage buffer (100 to 2500 bps)`)
}

for (const target of [1.25, 1.5, 2]) {
  const found = await borrow.prepareBorrowQuoteForTarget({ kind: 'borrow', marketId: market.marketId, borrowAmount: '10' }, DUMMY_WALLET, target)
  if (found.status !== 'available') { unreachable(`target ${target}: ${found.error.code}`); continue }
  const { outcome, prepared, slippageBps, reads } = found.data
  const health = prepared.quote.resultingHealthFactor
  const sizing = await borrow.quoteRequiredCollateral({ marketId: market.marketId, borrowAmount: '10', targetHealthFactor: target })
  const sized = sizing.status === 'available' && sizing.data.kind === 'required-collateral' ? Number(sizing.data.requiredCollateral.amount) : null
  const asked = Number(prepared.quote.collateral.amount)
  console.log(`target ${target}: ${outcome}, buffer ${slippageBps ?? 'default'} bps, collateral ${prepared.quote.collateral.amount}, HF ${health?.toFixed(4)}, ${reads} quotes, Circle's separate sizing preview ${sized ?? 'n/a'}`)
  if (outcome === 'not-reached' || health === null || health < target) fail(`target ${target}: not reached (${outcome})`)
  else if (prepared.request.slippageBps !== (slippageBps ?? 300)) fail(`target ${target}: the quote does not carry the buffer the action would`)
  else pass(`target ${target}: a real quote reaches it with ${slippageBps === undefined ? "Circle's default" : `${slippageBps} bps`} of buffer`)
  if (sized !== null && Math.abs(asked - sized) / sized > 0.01) console.log(`  note: the buffered collateral differs from Circle's separate sizing preview by more than 1%`)
}
console.log(worst === 0 ? '\nAll live checks passed.' : worst === 1 ? '\nA live check FAILED: re-examine the target search.' : '\nThe Borrow Service could not be read (not proof of a bug).')
process.exit(worst)
