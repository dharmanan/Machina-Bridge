// Checks the Arc cirBTC / USDC Borrow Kit markets against Morpho Blue on Arc mainnet (read-only view calls through the public
// Arc RPC; no wallet, no signature, no transaction).
//
//   node scripts/verify-mainnet-borrow-markets-onchain.mjs            markets from the repository's Circle evidence capture
//   node scripts/verify-mainnet-borrow-markets-onchain.mjs --live     markets from Circle through the proxy code (all pages)
//
// For every market it reads idToMarketParams and market() from Morpho Blue, hashes the parameters back to the market ID,
// compares the tokens and LLTV with what Circle reports, and reads the oracle price. Exit 0: every market verified. Exit 1:
// a market failed a check. Exit 2: Circle or the RPC could not be read (not proof of a bad market).
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { compatibleBorrowMarkets, handleBorrowMarketsProxy, normalizeBorrowMarketsPage } from '../api/_lib/borrow-markets-proxy.js'

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
const { createViemMarketReader, verifyBorrowMarket } = require(here('../src/lib/borrowMarketVerification.ts'))
const { describeVerificationReason, formatOraclePrice, formatUnitsExact } = require(here('../src/lib/borrowPreview.ts'))
const { MAINNET_BORROW_MORPHO_BLUE } = require(here('../src/config/mainnetBorrow.ts'))

const RPC = process.env.ARC_RPC_URL?.trim() || 'https://rpc.mainnet.arc.io'
const live = process.argv.includes('--live')

async function loadMarkets() {
  if (!live) {
    const evidence = JSON.parse(readFileSync(here('../docs/arc-intelligence-pipeline/borrow-mainnet-evidence.json'), 'utf8'))
    console.log(`Markets: Circle evidence capture of ${evidence.checkedAt} (${evidence.marketCount} markets on the page)`)
    return compatibleBorrowMarkets(normalizeBorrowMarketsPage(evidence.response))
  }
  let sent
  await handleBorrowMarketsProxy({ method: 'GET', headers: {}, query: {}, send: (response) => { sent = response } })
  if (sent?.status !== 200) {
    console.log(`UNAVAILABLE Circle markets (proxy answered ${sent?.status})`)
    process.exit(2)
  }
  const body = JSON.parse(sent.body)
  console.log(`Markets: Circle live through the proxy code${body.complete === false ? ' (INCOMPLETE: not every page could be read)' : ''}`)
  return body.markets
}

const markets = await loadMarkets()
console.log(`Morpho Blue ${MAINNET_BORROW_MORPHO_BLUE} via ${RPC}\n${markets.length} cirBTC / USDC market(s)\n`)

const reader = createViemMarketReader(RPC)
let worst = 0
for (const market of markets) {
  const result = await verifyBorrowMarket(market, reader)
  console.log(`${market.marketId}`)
  if (result.status === 'unavailable') {
    worst = Math.max(worst, 2)
    console.log('  UNAVAILABLE the chain could not be read\n')
    continue
  }
  const { details } = result
  if (result.status === 'verified') console.log('  PASS verified: ID hashes from the on-chain parameters; tokens and LLTV match Circle; oracle price readable')
  else {
    worst = Math.max(worst, 1)
    for (const reason of result.reasons) console.log(`  FAIL ${describeVerificationReason(reason)}`)
  }
  if (details) {
    const price = details.oraclePrice === null ? 'n/a' : formatOraclePrice(details.oraclePrice, market.loanAsset.decimals, market.collateralAsset.decimals)
    console.log(`  oracle ${details.params.oracle}  price ${price} ${market.loanAsset.symbol} per ${market.collateralAsset.symbol}`)
    console.log(`  rate model ${details.params.irm}  LLTV ${Number(details.params.lltv) / 1e18}`)
    console.log(`  on-chain liquidity ${formatUnitsExact(details.liquidity, market.loanAsset.decimals)} ${market.loanAsset.symbol} (Circle reports ${market.liquidity?.amount ?? 'not reported'})`)
  }
  console.log('')
}
console.log(worst === 0 ? 'All markets verified on-chain.' : worst === 1 ? 'At least one market FAILED verification.' : 'At least one market could not be checked.')
process.exit(worst)
