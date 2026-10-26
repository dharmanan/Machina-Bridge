// READ-ONLY live evidence for the Swap provider matrix on Arc Mainnet. Calls only eth_call / eth_getCode / eth_getBlock / eth_getBalance
// and the Circle Swap Kit's quote estimate. No wallet, no signature, no approval, no transaction.
//   node scripts/discover-swap-evidence.mjs            writes scripts/fixtures/swap/provider-evidence.json
import { createRequire } from 'node:module'
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
const require = createRequire(import.meta.url), ts = require('typescript')
require.extensions['.ts'] = (mod, file) => mod._compile(ts.transpileModule(readFileSync(file, 'utf8'), { fileName: file,
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText, file)
const root = fileURLToPath(new URL('..', import.meta.url))
const p = require(`${root}src/lib/uniswapArcPolicy.ts`), pools = require(`${root}src/lib/swap/uniswapPools.ts`), tokens = require(`${root}src/lib/swap/tokens.ts`)
const { createOnchainPorts } = require(`${root}src/lib/swap/uniswapOnchainRpc.ts`), { quoteRoutes, createOnchainReview } = require(`${root}src/lib/swap/uniswapOnchain.ts`)
const { arcReadClient } = require(`${root}src/lib/uniswapArcExecutionRpc.ts`)
const { SwapKit, getChainByEnum } = require('@circle-fin/swap-kit'), { ViemAdapter } = require('@circle-fin/adapter-viem-v2')
const { formatUnits, keccak256, parseAbi } = require('viem')
const OWNER = '0xafbB6Cc5C0a9C0eB1BfF8dB2eD807e83aAB8e321' // public approved pilot address, read-only
const AMOUNT = { USDC: '1', EURC: '1', cirBTC: '0.00001', WETH: '0.0003' }
const DECIMALS = { USDC: 6, EURC: 6, cirBTC: 8, WETH: 18 }
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
async function retry(run, attempts = 6) { for (let i = 0; ; i++) { try { return await run() } catch (error) { if (i >= attempts) throw error; await sleep(700 * (i + 1)) } } }

const ports = createOnchainPorts()
const block = await retry(() => arcReadClient.getBlockNumber({ cacheTime: 0 }))
const code = async address => { const c = await retry(() => arcReadClient.getCode({ address })); return c && c !== '0x' ? { present: true, hash: keccak256(c) } : { present: false } }
const uniswap = { router: { address: p.ARC_ROUTER, ...(await code(p.ARC_ROUTER)) }, permit2: { address: p.ARC_PERMIT2, ...(await code(p.ARC_PERMIT2)) }, factory: { address: pools.V3_FACTORY, ...(await code(pools.V3_FACTORY)) },
  pools: [], directions: {} }
const getPool = parseAbi(['function getPool(address,address,uint24) view returns (address)']), liquidity = parseAbi(['function liquidity() view returns (uint128)'])
for (const pool of pools.V3_POOLS) {
  const onchain = await retry(() => arcReadClient.readContract({ address: pools.V3_FACTORY, abi: getPool, functionName: 'getPool', args: [tokens.swapToken(pool.a).address, tokens.swapToken(pool.b).address, pool.fee] }))
  const live = await retry(() => arcReadClient.readContract({ address: pool.address, abi: liquidity, functionName: 'liquidity' }))
  uniswap.pools.push({ pair: `${pool.a}/${pool.b}`, fee: pool.fee, address: pool.address, factoryAgrees: onchain.toLowerCase() === pool.address.toLowerCase(), liquidity: live.toString() })
}
for (const { tokenIn, tokenOut } of tokens.SWAP_DIRECTIONS) {
  const request = { chainId: 5042, tokenIn, tokenOut, owner: OWNER, recipient: OWNER, amount: AMOUNT[tokenIn], minimumOutput: '1', slippageBps: 50, maxNetworkFee: '100000000000000000' }
  const entry = { amountIn: AMOUNT[tokenIn], candidates: pools.candidateRoutes(tokenIn, tokenOut).map(r => r.id) }
  try {
    const quotes = await quoteRoutes(request, ports)
    entry.best = { route: quotes.best.routeText, estimatedOut: formatUnits(quotes.best.received, DECIMALS[tokenOut]), simulatedGas: quotes.best.gas.toString() }
    entry.alternatives = quotes.alternatives.map(a => ({ route: a.routeText, estimatedOut: formatUnits(a.received, DECIMALS[tokenOut]) }))
    entry.failures = quotes.failures.map(f => `${f.routeText}: ${f.reason}`)
    entry.block = quotes.chain.blockNumber.toString()
    try { const review = await createOnchainReview(request, ports, { owner: OWNER, chainId: 5042, connected: true }); entry.review = { built: true, gasLimit: review.gasLimit, networkFeeCeiling: review.networkFee, minimum: review.requiredMinimum } }
    catch (error) { entry.review = { built: false, reason: error.code ?? error.message } }
  } catch (error) { entry.error = error.code ?? error.message }
  uniswap.directions[`${tokenIn}>${tokenOut}`] = entry
  console.log('uniswap', tokenIn, '>', tokenOut, entry.best?.route ?? entry.error)
}

const arc = getChainByEnum('Arc'), kit = new SwapKit({ disableAnalytics: true, disableErrorReporting: true })
const adapter = new ViemAdapter({ getPublicClient: () => arcReadClient, getWalletClient: () => { throw new Error('read_only_wallet') } }, { addressContext: 'developer-controlled', supportedChains: [arc] })
const circle = { sdk: JSON.parse(readFileSync(`${root}node_modules/@circle-fin/swap-kit/package.json`, 'utf8')).version, adapterContract: { address: arc.kitContracts?.adapter ?? null }, directions: {} }
if (circle.adapterContract.address) Object.assign(circle.adapterContract, await code(circle.adapterContract.address))
for (const { tokenIn, tokenOut } of tokens.SWAP_DIRECTIONS) {
  const entry = { amountIn: AMOUNT[tokenIn] }
  try {
    const r = await retry(() => kit.estimate({ from: { adapter, chain: 'Arc', address: OWNER }, tokenIn: tokens.swapToken(tokenIn).address, tokenOut: tokens.swapToken(tokenOut).address, amountIn: AMOUNT[tokenIn], config: { slippageBps: 100 } }), 3)
    entry.estimate = { out: r.estimatedOutput?.amount ?? null, minimum: r.stopLimit?.amount ?? null, fees: (r.fees ?? []).map(f => ({ type: f.type, amount: f.amount ?? null, token: f.token ?? null })) }
  } catch (error) { entry.error = String(error.message ?? error).slice(0, 200) }
  circle.directions[`${tokenIn}>${tokenOut}`] = entry
  console.log('circle', tokenIn, '>', tokenOut, entry.estimate?.out ?? entry.error)
}
const evidence = { collectedAt: new Date().toISOString(), chainId: 5042, block: block.toString(), note: 'Read-only: eth_call, eth_getCode, eth_getBlock, eth_getBalance and Circle Swap Kit estimate. No signature, approval or transaction.', uniswap, circle }
writeFileSync(`${root}scripts/fixtures/swap/provider-evidence.json`, `${JSON.stringify(evidence, null, 1)}\n`)
console.log('wrote scripts/fixtures/swap/provider-evidence.json')
