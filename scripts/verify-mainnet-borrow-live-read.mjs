// Live read-only Borrow Kit check on Arc mainnet. Keyless Borrow Service reads
// only: no wallet, no signature, no approval, no transaction.
//
//   node scripts/verify-mainnet-borrow-live-read.mjs
//   node scripts/verify-mainnet-borrow-live-read.mjs --wallet=0x...   (public loan list)
//
// Exit 0: every read PASS. Exit 2: Borrow Service unreachable or a read was
// unavailable (not proof of a bug). Exit 1: malformed or unexpected data.
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const ts = require('typescript')

require.extensions['.ts'] = (loadedModule, filename) => {
  const source = readFileSync(filename, 'utf8')
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
    fileName: filename,
  })
  loadedModule._compile(outputText, filename)
}

const borrow = require(fileURLToPath(new URL('../src/lib/mainnetBorrow.ts', import.meta.url)))
const { MAINNET_BORROW_WRITES_ENABLED } = require(fileURLToPath(new URL('../src/config/mainnetBorrow.ts', import.meta.url)))

const walletArgument = process.argv.find((argument) => argument.startsWith('--wallet='))?.slice('--wallet='.length)
if (walletArgument !== undefined && !/^0x[0-9a-fA-F]{40}$/.test(walletArgument)) {
  console.error('--wallet must be a 0x-prefixed 20-byte address')
  process.exit(1)
}
if (MAINNET_BORROW_WRITES_ENABLED !== false) {
  console.error('FAIL writes gate is not false; refusing to run')
  process.exit(1)
}

const FAILURE_CODES = new Set(['malformed_response', 'unexpected_chain', 'unexpected_owner', 'invalid_input', 'unexpected_error'])
let worst = 0

function report(label, result, describe) {
  if (result.status === 'available') {
    console.log(`PASS ${label}: ${describe(result.data)}`)
    return result.data
  }
  const failed = FAILURE_CODES.has(result.error.code)
  worst = Math.max(worst, failed ? 1 : 2)
  console.log(`${failed ? 'FAIL' : 'UNAVAILABLE'} ${label}: ${JSON.stringify(result.error)}`)
  return null
}

const amount = (value) => (value ? `${value.amount} ${value.token}` : 'unavailable')
const ratio = (value) => (value === null ? 'not backfilled' : `${(value * 100).toFixed(2)}%`)

const page = report('exploreMarkets Arc', await borrow.exploreBorrowMarkets({ pageSize: 20 }), (data) =>
  `${data.items.length} market(s)${data.nextPageAfter ? ', more pages' : ''}`)

if (page) {
  for (const market of page.items) {
    console.log(`  ${market.marketId} ${market.collateralAsset.symbol}/${market.loanAsset.symbol} lltv=${ratio(market.lltv)} borrowApy=${ratio(market.borrowApy)} liquidity=${amount(market.liquidity)} refreshedAt=${market.refreshedAt ?? 'not backfilled'}`)
  }
  const market = page.items.find((item) => /btc/i.test(item.collateralAsset.symbol) && item.loanAsset.symbol === 'USDC')
    ?? page.items[0]
  if (!market) {
    console.log('UNAVAILABLE no Borrow market returned for Arc')
    worst = Math.max(worst, 2)
  } else {
    report('getMarket', await borrow.getBorrowMarket(market.marketId), (data) =>
      `${data.collateralAsset.symbol}/${data.loanAsset.symbol} utilization=${ratio(data.utilization)}`)
    const unit = market.collateralAsset.decimals >= 8 ? '0.001' : '1'
    report(`getMaxBorrow ${unit} ${market.collateralAsset.symbol}`, await borrow.quoteMaxBorrow({ marketId: market.marketId, collateralAmount: unit }), (data) =>
      `max ${amount(data.kind === 'max-borrow' ? data.maxBorrow : null)} health=${data.resultingHealthFactor ?? 'none'}`)
    report('getRequiredCollateral 10 USDC at health 1.5', await borrow.quoteRequiredCollateral({ marketId: market.marketId, borrowAmount: '10', targetHealthFactor: 1.5 }), (data) =>
      `requires ${amount(data.kind === 'required-collateral' ? data.requiredCollateral : null)}`)
  }
}

if (walletArgument) {
  report('getLoans', await borrow.getBorrowLoans({ walletAddress: walletArgument }), (data) =>
    `${data.items.length} loan(s): ${data.items.map((loan) => `${loan.loanId} ${loan.lifecycle}/${loan.economics} debt=${amount(loan.borrowed)}`).join('; ') || 'none'}`)
}

console.log(worst === 0 ? 'RESULT PASS' : worst === 2 ? 'RESULT UNAVAILABLE (not verified)' : 'RESULT FAIL')
process.exit(worst)
