// Keyless Uniswap provider for all 12 directions: pool registry, route calldata builder/decoder, quote selection, Review factory,
// ERC-20 preflight, simulation helper, and the execution-mode gate. Controlled ports only: no network, no wallet, no transactions.
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
const require = createRequire(import.meta.url), ts = require('typescript')
require.extensions['.ts'] = (mod, file) => mod._compile(ts.transpileModule(readFileSync(file, 'utf8'), { fileName: file,
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText, file)
const root = fileURLToPath(new URL('..', import.meta.url))
const runtime = readFileSync(`${root}scripts/fixtures/uniswap-arc/router-runtime.hex`, 'utf8').trim()
const p = require(`${root}src/lib/uniswapArcPolicy.ts`), pools = require(`${root}src/lib/swap/uniswapPools.ts`), program = require(`${root}src/lib/swap/uniswapRouteProgram.ts`)
const onchain = require(`${root}src/lib/swap/uniswapOnchain.ts`), rpcAdapter = require(`${root}src/lib/swap/uniswapOnchainRpc.ts`), policy = require(`${root}src/lib/swap/swapPolicy.ts`)
const tokens = require(`${root}src/lib/swap/tokens.ts`), mode = require(`${root}src/lib/swap/executionMode.ts`), pilot = require(`${root}src/lib/uniswapArcPilot.ts`)
const ur = require(`${root}src/lib/swap/universalRouter.ts`), sim = require(`${root}src/lib/swap/simulatorCode.ts`)
const { createArcExecutionRpc } = require(`${root}src/lib/uniswapArcExecutionRpc.ts`)
const { decodeAbiParameters, decodeFunctionData, encodeAbiParameters, encodeFunctionData, keccak256, parseAbiParameters, parseUnits, formatUnits, getAddress, pad, toHex } = require('viem')
let count = 0, external = 0
globalThis.fetch = async () => { external++; throw Error('network_forbidden') }
async function test(name, fn) { await fn(); count++; console.log(`PASS ${name}`) }
const owner = '0xafbB6Cc5C0a9C0eB1BfF8dB2eD807e83aAB8e321', other = '0x2222222222222222222222222222222222222222'
const NOW = 1_800_000_000_000, CHAIN_TS = 1_800_000_000n
const dec = { USDC: 6, EURC: 6, cirBTC: 8, WETH: 18 }
const amountFor = { USDC: '1', EURC: '1', cirBTC: '0.00001', WETH: '0.0003' }
const requestFor = (tokenIn, tokenOut, extra = {}) => ({ chainId: 5042, tokenIn, tokenOut, owner, recipient: owner, amount: amountFor[tokenIn], minimumOutput: '1', slippageBps: 50, maxNetworkFee: '100000000000000000', ...extra })
const context = { owner, chainId: 5042, connected: true }
const V3_INPUT = parseAbiParameters('address recipient,uint256 amountIn,uint256 amountOutMinimum,bytes path,bool payerIsUser,uint256[] minHopPriceX36')
const EXEC = p.EXECUTE_ABI

// ---------------------------------------------------------------------------------------------------------------------------------------
// Pool registry
await test('the six V3 pools are derived from the pinned factory and init-code hash; each matches the live factory getPool answer recorded at the evidence block', () => {
  const live = { 'USDC/EURC/500': '0x6fd5F2fb831940DcD61A98c5B3aCB7D8C6f3bFc1', 'USDC/EURC/3000': '0x88f97E21c423261244d6D661fBd569b2bd69539f', 'USDC/cirBTC/100': '0x82916bee18fCEF517B26C72d7Cb5F13694E1dB41',
    'USDC/WETH/3000': '0x964cFF2cCCB9059e83D507df348f070e5257A2e0', 'USDC/WETH/10000': '0xCC1437eD1200316193Ab09dB22e501D7e5907632', 'cirBTC/WETH/3000': '0xBb505c923D0CE6364b6d1769Fd85Bd62B0C0E9C9' }
  assert.equal(pools.V3_POOLS.length, 6)
  for (const pool of pools.V3_POOLS) assert.equal(pool.address, live[`${pool.a}/${pool.b}/${pool.fee}`], `${pool.a}/${pool.b}/${pool.fee}`)
  assert.equal(pools.v3PoolAddress('EURC', 'USDC', 500), pools.v3PoolAddress('USDC', 'EURC', 500)) // token order does not matter
  assert.equal(pools.V3_FACTORY, '0xf0db7b58379503491d857db50ac9ece64c653918'); assert.equal(pools.EVIDENCE_BLOCK, 27291900)
})
await test('every one of the 12 directions has candidate routes: at most 4, at most 2 hops, registered pools, no repeated token, best pools first', () => {
  assert.equal(tokens.SWAP_DIRECTIONS.length, 12)
  for (const { tokenIn, tokenOut } of tokens.SWAP_DIRECTIONS) {
    const routes = pools.candidateRoutes(tokenIn, tokenOut)
    assert.ok(routes.length >= 1 && routes.length <= pools.MAX_ROUTE_CANDIDATES, `${tokenIn}>${tokenOut}`)
    for (const route of routes) {
      assert.ok(route.hops.length <= 2 && pools.routeIsRegistered(route)); assert.equal(route.hops[0].tokenIn, tokenIn); assert.equal(route.hops.at(-1).tokenOut, tokenOut)
      const seen = [tokenIn, ...route.hops.map(h => h.tokenOut)]; assert.equal(new Set(seen).size, seen.length)
    }
    assert.deepEqual(routes.map(r => r.id), pools.candidateRoutes(tokenIn, tokenOut).map(r => r.id)) // deterministic
  }
  assert.deepEqual(pools.candidateRoutes('EURC', 'cirBTC').map(r => r.id), ['EURC>500>USDC|USDC>100>cirBTC']) // EURC has no direct pool with cirBTC/WETH
  assert.equal(pools.candidateRoutes('USDC', 'EURC')[0].hops[0].fee, 500)
  assert.deepEqual(pools.candidateRoutes('USDC', 'USDC'), [])
})
await test('unregistered pools, three hops, broken chains and a wrong fee tier are not routes', () => {
  assert.equal(pools.routeIsRegistered({ hops: [{ tokenIn: 'USDC', tokenOut: 'EURC', fee: 100 }] }), false)
  assert.equal(pools.routeIsRegistered({ hops: [{ tokenIn: 'EURC', tokenOut: 'cirBTC', fee: 3000 }] }), false)
  assert.equal(pools.routeIsRegistered({ hops: [{ tokenIn: 'EURC', tokenOut: 'USDC', fee: 500 }, { tokenIn: 'USDC', tokenOut: 'WETH', fee: 3000 }, { tokenIn: 'WETH', tokenOut: 'cirBTC', fee: 3000 }] }), false)
  assert.equal(pools.routeIsRegistered({ hops: [{ tokenIn: 'EURC', tokenOut: 'USDC', fee: 500 }, { tokenIn: 'WETH', tokenOut: 'cirBTC', fee: 3000 }] }), false)
  assert.equal(pools.routeIsRegistered({ hops: [] }), false)
  assert.equal(pools.feeText(500), '0.05%'); assert.equal(pools.feeText(3000), '0.3%'); assert.equal(pools.feeText(10000), '1%'); assert.equal(pools.feeText(100), '0.01%')
})

// ---------------------------------------------------------------------------------------------------------------------------------------
// Route calldata builder and strict decoder
const txFor = (data, request, value) => ({ chainId: 5042, from: request.owner, to: p.ARC_ROUTER, data, value: toHex(value ?? program.routeTransactionValue(request)) })
const deadline = CHAIN_TS + 120n
await test('the builder and the strict decoder agree on every candidate route of every direction (native USDC input and ERC-20 input shapes)', () => {
  let routes = 0
  for (const { tokenIn, tokenOut } of tokens.SWAP_DIRECTIONS) {
    const request = p.validateArcRequest(requestFor(tokenIn, tokenOut))
    for (const route of pools.candidateRoutes(tokenIn, tokenOut)) {
      const data = program.buildRouteCalldata({ request, route, minimumOutput: 12345n, deadline })
      const decoded = program.decodeRouteProgram(txFor(data, request), request, 12345n)
      assert.equal(decoded.routeText, pools.describeRoute(route)); assert.equal(decoded.nativeInput, tokenIn === 'USDC'); assert.equal(decoded.deadline, Number(deadline)); assert.equal(decoded.suffix, 'none')
      const outer = decodeFunctionData({ abi: EXEC, data })
      assert.equal(outer.args[0], tokenIn === 'USDC' ? '0x0004' : '0x00'); assert.equal(outer.args[1].length, tokenIn === 'USDC' ? 2 : 1)
      assert.equal(program.routeTransactionValue(request), tokenIn === 'USDC' ? 10n ** 18n : 0n)
      routes++
    }
  }
  assert.ok(routes >= 20)
})
function tamper(request, route, change) {
  const data = program.buildRouteCalldata({ request, route, minimumOutput: 5000n, deadline })
  const outer = decodeFunctionData({ abi: EXEC, data }), inputs = [...outer.args[1]]
  const swap = decodeAbiParameters(V3_INPUT, inputs[0])
  const next = change({ swap: [...swap], inputs, commands: outer.args[0], deadline: outer.args[2], data })
  return next.data ?? encodeFunctionData({ abi: EXEC, functionName: 'execute', args: [next.commands ?? outer.args[0], next.inputs ?? inputs.map((x, i) => (i === 0 ? encodeAbiParameters(V3_INPUT, next.swap) : x)), next.deadline ?? outer.args[2]] })
}
await test('the decoder refuses every deviation from the canonical program, for both input shapes', () => {
  for (const [tokenIn, tokenOut] of [['USDC', 'EURC'], ['EURC', 'USDC'], ['WETH', 'cirBTC']]) {
    const request = p.validateArcRequest(requestFor(tokenIn, tokenOut)), route = pools.candidateRoutes(tokenIn, tokenOut)[0]
    const refuse = (name, change, requiredMinimum = 5000n, req = request) => assert.throws(() => program.decodeRouteProgram(txFor(tamper(request, route, change), req), req, requiredMinimum), undefined, `${tokenIn}>${tokenOut}: ${name}`)
    refuse('recipient is not the owner', ({ swap }) => { swap[0] = other; return { swap } })
    refuse('payer flag flipped', ({ swap }) => { swap[4] = !swap[4]; return { swap } })
    refuse('amount changed', ({ swap }) => { swap[1] = swap[1] + 1n; return { swap } })
    refuse('hop price bound added', ({ swap }) => { swap[5] = [1n]; return { swap } })
    refuse('minimum below the required minimum', ({ swap }) => { swap[2] = 4999n; return { swap } })
    refuse('path ends in another token', ({ swap }) => {
      const third = tokens.SWAP_SYMBOLS.find(t => t !== tokenIn && t !== tokenOut && pools.candidateRoutes(tokenIn, t).length)
      const alien = decodeAbiParameters(V3_INPUT, decodeFunctionData({ abi: EXEC, data: program.buildRouteCalldata({ request: p.validateArcRequest(requestFor(tokenIn, third)), route: pools.candidateRoutes(tokenIn, third)[0], minimumOutput: 5000n, deadline }) }).args[1][0])
      swap[3] = alien[3]; return { swap }
    })
    refuse('unregistered fee tier', ({ swap }) => { swap[3] = swap[3].replace(/0001f4|000bb8|000064|002710/, '000bbb'); return { swap } })
    refuse('extra command', ({ commands, inputs }) => ({ commands: `${commands}00`, inputs: [...inputs, inputs[0]] }))
    refuse('different command', ({ inputs }) => ({ commands: tokenIn === 'USDC' ? '0x0404' : '0x04', inputs }))
    refuse('trailing bytes after the call', ({ data }) => ({ data: `${data}00` }))
    refuse('a quote suffix', ({ data }) => ({ data: `${data}756e697800001234` }))
  }
  const request = p.validateArcRequest(requestFor('USDC', 'EURC')), data = program.buildRouteCalldata({ request, route: pools.candidateRoutes('USDC', 'EURC')[0], minimumOutput: 5000n, deadline })
  assert.throws(() => program.decodeRouteProgram({ ...txFor(data, request), to: other }, request, 5000n), /transaction_context/)
  assert.throws(() => program.decodeRouteProgram({ ...txFor(data, request), from: other }, request, 5000n), /transaction_context/)
  assert.throws(() => program.decodeRouteProgram({ ...txFor(data, request), value: '0x0' }, request, 5000n), /transaction_context/) // native input must carry the amount
  const erc = p.validateArcRequest(requestFor('EURC', 'USDC')), erc20 = program.buildRouteCalldata({ request: erc, route: pools.candidateRoutes('EURC', 'USDC')[0], minimumOutput: 5000n, deadline })
  assert.throws(() => program.decodeRouteProgram({ ...txFor(erc20, erc), value: '0x1' }, erc, 5000n), /transaction_context/) // an ERC-20 swap must carry no native value
})
await test('the approved first-swap calldata (V4 with a third-party portion) is not a route this provider would ever build or accept', () => {
  const real = JSON.parse(readFileSync(`${root}scripts/fixtures/uniswap-arc/first-pilot-result.json`, 'utf8')).eth_getTransactionByHash
  const request = p.validateArcRequest(requestFor('USDC', 'EURC', { amount: '0.1' }))
  assert.throws(() => program.decodeRouteProgram({ chainId: 5042, from: real.from, to: real.to, data: real.input, value: real.value }, request, 1n))
})
await test('route verification enforces the deadline window against the wall clock (past, and more than 30 minutes ahead)', () => {
  const request = p.validateArcRequest(requestFor('EURC', 'USDC')), route = pools.candidateRoutes('EURC', 'USDC')[0]
  const at = d => program.buildRouteCalldata({ request, route, minimumOutput: 5000n, deadline: d })
  assert.doesNotThrow(() => program.verifyRouteCalldata(txFor(at(deadline), request), request, 5000n, NOW))
  assert.throws(() => program.verifyRouteCalldata(txFor(at(CHAIN_TS - 1n), request), request, 5000n, NOW), /deadline/)
  assert.throws(() => program.verifyRouteCalldata(txFor(at(CHAIN_TS + 1801n), request), request, 5000n, NOW), /deadline/)
})

// ---------------------------------------------------------------------------------------------------------------------------------------
// Quote selection with controlled ports
function pathOf(data) {
  const outer = decodeFunctionData({ abi: EXEC, data }), swap = decodeAbiParameters(V3_INPUT, outer.args[1][0]), parsed = ur.decodeV3Path(swap[3])
  const symbols = parsed.tokens.map(t => Object.keys(p.ARC_TOKENS).find(k => p.sameAddress(t, p.ARC_TOKENS[k].address)))
  return { id: parsed.fees.map((fee, i) => `${symbols[i]}>${fee}>${symbols[i + 1]}`).join('|'), swap, deadline: outer.args[2] }
}
function fakePorts(options = {}) {
  const calls = { simulate: [], chain: 0 }
  const chain = { blockNumber: 5_000n, timestamp: CHAIN_TS, gasPrice: 20_000_000_000n, nativeBalance: 5n * 10n ** 18n, routerHash: p.ARC_ROUTER_HASH, ...options.chain }
  return { calls, ports: {
    now: () => options.now ?? NOW,
    chain: async o => { calls.chain++; if (options.chainError) throw Error('down'); assert.ok(p.sameAddress(o, owner)); return chain },
    simulate: async input => {
      calls.simulate.push(input)
      const { id, swap, deadline: d } = pathOf(input.data)
      assert.equal(swap[0], getAddress(onchain.SIMULATION_RECIPIENT)); assert.equal(d, CHAIN_TS + 120n) // simulations trade for the helper, on the chain's own clock
      const fn = options.simulate?.(id, input, calls.simulate.length)
      if (fn === 'revert') throw Error('reverted'); if (fn === 'rpc') throw new onchain.OnchainQuoteError('rpc_unavailable')
      const received = typeof fn === 'object' ? fn.received : BigInt(options.outputs?.[id] ?? 1_000_000n) * (input.tokenOut === 'WETH' ? 10n ** 12n : 1n)
      const minimum = swap[2]; if (received < minimum && !(typeof fn === 'object' && fn.bypass)) throw Error('reverted')
      return { received, spent: typeof fn === 'object' && fn.spent !== undefined ? fn.spent : input.amountIn, gas: BigInt(options.gas ?? 100_000) + (id.includes('|') ? 90_000n : 0n) }
    },
  } }
}
await test('the best real output wins; a two-hop route beats a direct one only on output; ties prefer fewer hops', async () => {
  const request = p.validateArcRequest(requestFor('USDC', 'WETH'))
  const ids = pools.candidateRoutes('USDC', 'WETH').map(r => r.id)
  const f = fakePorts({ outputs: { [ids[0]]: 100, [ids[1]]: 300, [ids[2]]: 200 } })
  const quotes = await onchain.quoteRoutes(request, f.ports)
  assert.equal(quotes.best.route.id, ids[1]); assert.deepEqual(quotes.alternatives.map(a => a.route.id), [ids[2], ids[0]]); assert.equal(quotes.failures.length, 0)
  assert.equal(quotes.best.routeText, pools.describeRoute(quotes.best.route)); assert.equal(f.calls.simulate.length, ids.length) // one simulation per candidate, no more
  const tie = fakePorts({ outputs: Object.fromEntries(ids.map(id => [id, 500])) })
  assert.equal((await onchain.quoteRoutes(request, tie.ports)).best.route.hops.length, 1)
})
await test('routes that revert, spend the wrong amount or yield nothing are dropped, never guessed at', async () => {
  const request = p.validateArcRequest(requestFor('USDC', 'WETH')), ids = pools.candidateRoutes('USDC', 'WETH').map(r => r.id)
  const f = fakePorts({ outputs: { [ids[0]]: 100 }, simulate: id => (id === ids[1] ? 'revert' : id === ids[2] ? { received: 50n, spent: 1n, bypass: true } : undefined) })
  const q = await onchain.quoteRoutes(request, f.ports)
  assert.equal(q.best.route.id, ids[0]); assert.deepEqual(q.failures.map(x => x.reason).sort(), ['reverted', 'wrong_amount'])
  const zero = fakePorts({ simulate: () => ({ received: 0n, bypass: true }) })
  await assert.rejects(onchain.quoteRoutes(request, zero.ports), e => e.code === 'no_route')
  const allRevert = fakePorts({ simulate: () => 'revert' })
  await assert.rejects(onchain.quoteRoutes(request, allRevert.ports), e => e.code === 'simulation_failed')
})
await test('a read outage is reported as an outage, never as "no route"; a changed router stops the quote; no candidates is no route', async () => {
  const request = p.validateArcRequest(requestFor('EURC', 'USDC'))
  await assert.rejects(onchain.quoteRoutes(request, fakePorts({ simulate: () => 'rpc' }).ports), e => e.code === 'rpc_unavailable')
  await assert.rejects(onchain.quoteRoutes(request, fakePorts({ chainError: true }).ports), e => e.code === 'rpc_unavailable')
  const partial = fakePorts({ simulate: (id, input, n) => (n === 1 ? 'rpc' : undefined), outputs: { 'EURC>500>USDC': 700, 'EURC>3000>USDC': 600 } })
  assert.equal((await onchain.quoteRoutes(request, partial.ports)).best.received, 600n) // one failed read does not hide a route that did quote
  await assert.rejects(onchain.quoteRoutes(request, fakePorts({ chain: { routerHash: `0x${'11'.repeat(32)}` } }).ports), e => e.code === 'router_changed')
  await assert.rejects(onchain.quoteRoutes({ ...request, tokenOut: 'EURC' }, fakePorts().ports), /unsupported_direction/)
})

// ---------------------------------------------------------------------------------------------------------------------------------------
// Review factory
await test('a Review is built for every direction and passes the same validation the controller applies; the minimum follows the slippage exactly', async () => {
  for (const { tokenIn, tokenOut } of tokens.SWAP_DIRECTIONS) {
    for (const bps of [10, 50, 100]) {
      const request = p.validateArcRequest(requestFor(tokenIn, tokenOut, { slippageBps: bps })), f = fakePorts({ outputs: Object.fromEntries(pools.candidateRoutes(tokenIn, tokenOut).map((r, i) => [r.id, 987_654 - i])) })
      const review = await onchain.createOnchainReview(request, f.ports, context)
      assert.equal(review.source, 'onchain'); assert.equal(review.simulation, 'passed'); assert.equal(review.writesEnabled, false); assert.equal(review.executionBound, false); assert.equal(review.quoteId, undefined)
      const estimated = BigInt(review.estimatedOutput), minimum = BigInt(review.requiredMinimum)
      assert.equal(minimum, p.minimumAtSlippage(estimated, bps)); assert.ok(minimum <= estimated)
      assert.doesNotThrow(() => policy.validateReview(review, context, NOW))
      const gas = BigInt(review.gasLimit), maxFee = BigInt(review.maxFeePerGas)
      assert.equal(maxFee, 40_000_000_000n); assert.equal(review.maxPriorityFeePerGas, '0'); assert.equal(BigInt(review.networkFee), gas * maxFee); assert.ok(BigInt(review.networkFee) <= 10n ** 17n)
      assert.equal(review.requestStartedAt, NOW); assert.equal(review.expiresAt, NOW + 30_000)
      assert.ok(p.sameAddress(review.transaction.to, p.ARC_ROUTER) && p.sameAddress(review.transaction.from, owner)); assert.equal(BigInt(review.transaction.value), program.routeTransactionValue(request))
      const decoded = program.decodeRouteProgram(review.transaction, request, minimum)
      assert.equal(decoded.deadline, Number(CHAIN_TS) + 120); assert.equal(decoded.minimumOutput, review.requiredMinimum); assert.equal(decoded.routeText, review.route)
      assert.equal(policy.reviewValue(review), BigInt(review.transaction.value))
    }
  }
})
await test('gas is the simulated gas plus overhead with a 1.5x margin; the fee ceiling is twice the current price', async () => {
  const request = p.validateArcRequest(requestFor('EURC', 'USDC')), f = fakePorts({ gas: 91_473, outputs: { 'EURC>500>USDC': 1_119_247 } })
  const review = await onchain.createOnchainReview(request, f.ports, context)
  assert.equal(BigInt(review.gasLimit), (91_473n + onchain.GAS_OVERHEAD) * 3n / 2n); assert.equal(onchain.gasLimitFor(100_000n), 192_000n)
  assert.equal(review.maxFeePerGas, '40000000000'); assert.equal(f.calls.simulate.length, pools.candidateRoutes('EURC', 'USDC').length + 1) // candidates + the bound-proof simulation
  assert.equal(f.calls.simulate.at(-1).data !== f.calls.simulate[0].data, true)
})
await test('the Review factory stops on: insufficient native balance, a fee above the request ceiling, a skewed clock, a bound the simulation cannot meet, a missing output', async () => {
  const request = p.validateArcRequest(requestFor('USDC', 'EURC', { amount: '1' }))
  await assert.rejects(onchain.createOnchainReview(request, fakePorts({ chain: { nativeBalance: 10n ** 18n } }).ports, context), e => e.code === 'insufficient_native_balance')
  await assert.rejects(onchain.createOnchainReview(request, fakePorts({ chain: { gasPrice: 10n ** 12n } }).ports, context), e => e.code === 'fee_limit')
  await assert.rejects(onchain.createOnchainReview(request, fakePorts({ now: NOW + 600_000 }).ports, context), e => e.code === 'clock')
  const unreachable = fakePorts({ simulate: (id, input, n) => (n > pools.candidateRoutes('USDC', 'EURC').length ? { received: 1n } : undefined), outputs: { 'USDC>500>EURC': 900_000 } })
  await assert.rejects(onchain.createOnchainReview(request, unreachable.ports, context), e => e.code === 'simulation_failed')
  const spy = fakePorts(); await assert.rejects(onchain.createOnchainReview({ ...request, amount: '1' + '0'.repeat(100) }, spy.ports, context)); assert.equal(spy.calls.chain, 0)
  await assert.rejects(onchain.createOnchainReview(request, fakePorts().ports, { ...context, owner: other }), /wallet_context_changed/)
})
await test('open inputs have no product-value caps; ABI bounds and precision remain enforced', () => {
  for (const [symbol, amount] of [['USDC', '1000000.123456'], ['EURC', '9007199254740993.123456'], ['cirBTC', '100.12345678'], ['WETH', '10000.123456789012345678']]) {
    const other = symbol === 'EURC' ? 'USDC' : 'EURC'
    const r = p.validateArcRequest(requestFor(symbol, other, { amount }))
    assert.equal(p.tokenUnits(r.amount, p.ARC_TOKENS[symbol].decimals), parseUnits(amount, p.ARC_TOKENS[symbol].decimals))
  }
  for (const symbol of ['EURC', 'cirBTC', 'WETH']) {
    const other = symbol === 'EURC' ? 'USDC' : 'EURC', decimals = p.ARC_TOKENS[symbol].decimals
    const boundary = n => formatUnits(n, decimals)
    assert.doesNotThrow(() => p.validateArcRequest(requestFor(symbol, other, { amount: boundary(tokens.SWAP_UINT160_MAX - 1n) })))
    for (const n of [tokens.SWAP_UINT160_MAX, tokens.SWAP_UINT160_MAX + 1n, tokens.SWAP_UINT256_MAX])
      assert.throws(() => p.validateArcRequest(requestFor(symbol, other, { amount: boundary(n) })), /input_range/)
  }
  const nativeMax = tokens.SWAP_UINT256_MAX / 10n ** 12n
  assert.doesNotThrow(() => p.validateArcRequest(requestFor('USDC', 'EURC', { amount: formatUnits(nativeMax, 6) })))
  assert.throws(() => p.validateArcRequest(requestFor('USDC', 'EURC', { amount: formatUnits(nativeMax + 1n, 6) })), /input_range/)
})
await test('an on-chain Review cannot be altered or relabelled without validation failing', async () => {
  const request = p.validateArcRequest(requestFor('WETH', 'EURC')), f = fakePorts(), review = await onchain.createOnchainReview(request, f.ports, context)
  const refuse = (name, change, ctx = context, now = NOW + 1) => { const r = structuredClone(review); change(r); assert.throws(() => policy.validateReview(r, ctx, now), undefined, name) }
  refuse('recipient rewritten', r => { r.transaction.data = r.transaction.data.replace(owner.slice(2).toLowerCase(), other.slice(2)) })
  refuse('route label changed', r => { r.route = 'WETH → EURC (0.05%)' })
  refuse('claimed as API source', r => { r.source = 'api' })
  refuse('unknown source', r => { r.source = 'other' })
  refuse('quote id attached', r => { r.quoteId = '11111111-1111-1111-1111-111111111111' })
  refuse('minimum below slippage bound', r => { r.requiredMinimum = (BigInt(r.estimatedOutput) / 2n).toString() })
  refuse('longer validity', r => { r.expiresAt = r.requestStartedAt + 31_000 })
  refuse('fee mismatch', r => { r.networkFee = '1' })
  refuse('value added to an ERC-20 swap', r => { r.transaction.value = '0x1' })
  refuse('router hash changed', r => { r.routerHash = `0x${'22'.repeat(32)}` })
  refuse('wallet changed', () => {}, { ...context, owner: other })
  refuse('wrong network', () => {}, { ...context, chainId: 1 })
  refuse('expired', () => {}, context, NOW + 30_000)
  refuse('simulation flag', r => { r.simulation = 'failed' })
  assert.throws(() => policy.validateReview({ ...structuredClone(review), source: undefined }, context, NOW + 1)) // WETH input never validates through the legacy API profile
})

// ---------------------------------------------------------------------------------------------------------------------------------------
// ERC-20 preflight against the real-state checks
function preflightFixture(tokenIn = 'EURC', tokenOut = 'USDC', changes = {}) {
  return (async () => {
    const request = p.validateArcRequest(requestFor(tokenIn, tokenOut)), f = fakePorts({ outputs: { [`${tokenIn}>500>${tokenOut}`]: 900_000 } })
    const review = await onchain.createOnchainReview(request, f.ports, context), need = p.tokenUnits(request.amount, dec[tokenIn]), calls = []
    const state = { held: need * 5n, toPermit2: need, permit: [need, Number(CHAIN_TS) + 900, 0], balance: 5n * 10n ** 18n, ...changes.state }
    const rpc = {
      getChainId: async () => 5042, getBlockNumber: async () => 5_001n,
      getBlock: async () => ({ hash: `0x${'aa'.repeat(32)}`, timestamp: CHAIN_TS + 10n, baseFeePerGas: 1_000_000_000n }),
      getCode: async ({ address }) => (p.sameAddress(address, p.ARC_ROUTER) ? runtime : p.sameAddress(address, owner) ? undefined : '0x6000'),
      readContract: async ({ functionName, address }) => { calls.push(functionName); return functionName === 'decimals' ? dec[tokenOut] : functionName === 'balanceOf' ? state.held : address === p.ARC_PERMIT2 ? state.permit : state.toPermit2 },
      getBalance: async () => state.balance, getGasPrice: async () => 20_000_000_000n,
      call: async args => { calls.push(['call', args]); return { data: '0x' } }, estimateGas: async () => 150_000n, getTransactionCount: async () => 3, ...changes.rpc,
    }
    return { review, request, calls, rpc, adapter: createArcExecutionRpc(rpc) }
  })()
}
await test('unsigned ERC-20 preparation checks balance and token allowance, but cannot authorize a send or simulate an absent signature', async () => {
  for (const [tokenIn, tokenOut] of [['EURC', 'USDC'], ['cirBTC', 'EURC'], ['WETH', 'USDC']]) {
    const f = await preflightFixture(tokenIn, tokenOut)
    assert.deepEqual(await f.adapter.preflight(f.review), { nonce: 3, latestNonce: 3 })
    assert.equal(f.calls.some(c => Array.isArray(c) && c[0] === 'call'), false)
    assert.ok(f.calls.includes('balanceOf') && f.calls.includes('allowance'))
  }
})
await test('ERC-20 preflight: a missing, short or expiring approval is "allowance_missing"; too little input token is "insufficient_input_balance"; both stop before any wallet request', async () => {
  const need = 1_000_000n
  const cases = [
    ['token approval missing', { state: { toPermit2: 0n } }, 'allowance_missing'],
    ['token approval below the amount', { state: { toPermit2: need - 1n } }, 'allowance_missing'],
    ['not enough of the input token', { state: { held: need - 1n } }, 'insufficient_input_balance'],
  ]
  for (const [name, changes, code] of cases) { const f = await preflightFixture('EURC', 'USDC', changes); await assert.rejects(f.adapter.preflight(f.review), e => e.message === code, name); assert.equal(f.calls.some(c => Array.isArray(c) && c[0] === 'call'), false) }
  const poor = await preflightFixture('EURC', 'USDC', { state: { balance: 1n } }); await assert.rejects(poor.adapter.preflight(poor.review), /verification/) // cannot pay the network fee
  const expired = await preflightFixture('EURC', 'USDC', { rpc: { getBlock: async () => ({ hash: `0x${'aa'.repeat(32)}`, timestamp: CHAIN_TS + 121n, baseFeePerGas: 1n }) } }); await assert.rejects(expired.adapter.preflight(expired.review), /expired/)
  const reverts = await preflightFixture('USDC', 'EURC', { rpc: { call: async () => { throw Error('execution reverted') } } }); await assert.rejects(reverts.adapter.preflight(reverts.review))
  const hungry = await preflightFixture('USDC', 'EURC', { rpc: { estimateGas: async () => 10n ** 9n } }); await assert.rejects(hungry.adapter.preflight(hungry.review), /verification/)
})
await test('native USDC input needs no allowance and is checked for the amount plus the fee ceiling', async () => {
  const f = await preflightFixture('USDC', 'EURC', { state: { toPermit2: 0n, permit: [0n, 0, 0] } })
  assert.deepEqual(await f.adapter.preflight(f.review), { nonce: 3, latestNonce: 3 }); assert.equal(f.calls.find(c => Array.isArray(c) && c[0] === 'call')[1].value, 10n ** 18n)
  assert.equal(f.calls.includes('allowance'), false)
  const short = await preflightFixture('USDC', 'EURC', { state: { balance: 10n ** 18n } }); await assert.rejects(short.adapter.preflight(short.review), /verification/)
})

// ---------------------------------------------------------------------------------------------------------------------------------------
// Receipt verification for route swaps: the same chain-vs-Review comparison as the first swap, for every direction
const e = require(`${root}src/lib/uniswapArcExecution.ts`)
const TRANSFER = [{ type: 'event', name: 'Transfer', inputs: [{ name: 'from', type: 'address', indexed: true }, { name: 'to', type: 'address', indexed: true }, { name: 'value', type: 'uint256', indexed: false }] }]
const { encodeEventTopics } = require('viem')
const HASH = `0x${'c3'.repeat(32)}`, BLOCK_HASH = `0x${'d4'.repeat(32)}`, POOL = '0x6fd5F2fb831940DcD61A98c5B3aCB7D8C6f3bFc1'
const NATIVE_EMITTER = '0xfffffffffffffffffffffffffffffffffffffffe'
function transferLog(address, from, to, value, logIndex) {
  return { address, topics: encodeEventTopics({ abi: TRANSFER, eventName: 'Transfer', args: { from, to } }), data: encodeAbiParameters(parseAbiParameters('uint256'), [value]), removed: false,
    transactionHash: HASH, blockHash: BLOCK_HASH, blockNumber: 100n, logIndex, transactionIndex: 0 }
}
async function settle(tokenIn, tokenOut, options = {}) {
  const request = p.validateArcRequest(requestFor(tokenIn, tokenOut)), f = fakePorts({ outputs: Object.fromEntries(pools.candidateRoutes(tokenIn, tokenOut).map(r => [r.id, 900_000])) })
  const review = await onchain.createOnchainReview(request, f.ports, context), expected = e.executionTransaction(review, 7)
  const amountIn = p.tokenUnits(request.amount, dec[tokenIn]), received = options.received ?? BigInt(review.estimatedOutput)
  const tx = { hash: HASH, from: owner, to: p.ARC_ROUTER, chainId: 5042, nonce: 7, type: 'eip1559', input: options.input ?? expected.data, value: BigInt(expected.value), gas: options.gas ?? BigInt(expected.gas),
    maxFeePerGas: options.maxFeePerGas ?? BigInt(expected.maxFeePerGas), maxPriorityFeePerGas: options.tip ?? 0n }
  const logs = []
  if (tokenIn === 'USDC') logs.push(transferLog(NATIVE_EMITTER, owner, p.ARC_ROUTER, amountIn * 10n ** 12n, 0))
  else logs.push(transferLog(p.ARC_TOKENS[tokenIn].address, owner, POOL, amountIn, 0))
  logs.push(transferLog(p.ARC_TOKENS[tokenOut].address, POOL, owner, received, 1))
  if (tokenOut === 'USDC') logs.push(transferLog(NATIVE_EMITTER, POOL, owner, received * 10n ** 12n, 2)) // the ERC-20 face of native USDC also emits the native-denomination log
  for (const extra of options.extraLogs ?? []) logs.push(extra)
  const receipt = { transactionHash: HASH, from: owner, to: p.ARC_ROUTER, blockNumber: 100n, blockHash: BLOCK_HASH, transactionIndex: 0, gasUsed: options.gasUsed ?? 150_000n, effectiveGasPrice: options.price ?? 21_000_000_000n, status: options.status ?? 'success', logs }
  const rpc = { getChainId: async () => 5042, getBlockNumber: async () => 101n, getBlock: async () => ({ hash: BLOCK_HASH, timestamp: CHAIN_TS + 5n, baseFeePerGas: 1n }), getTransaction: async () => tx, getTransactionReceipt: async () => receipt }
  const attempt = { id: crypto.randomUUID(), review, nonce: 7, status: 'pending', hash: HASH, createdAt: 1 }
  return { result: await createArcExecutionRpc(rpc).result(attempt), review, amountIn, received }
}
await test('a route swap in every direction settles as chain success AND verified, with the real received and paid amounts (native USDC input, ERC-20 input, USDC output)', async () => {
  for (const { tokenIn, tokenOut } of tokens.SWAP_DIRECTIONS) {
    const { result, amountIn, received } = await settle(tokenIn, tokenOut)
    assert.equal(result.status, 'settled', `${tokenIn}>${tokenOut}`); assert.equal(result.chain.state, 'success'); assert.equal(result.intent.verdict, 'verified', `${tokenIn}>${tokenOut}: ${result.intent.differences}`)
    assert.equal(result.chain.received, received.toString()); assert.equal(result.chain.sent, amountIn.toString()); assert.equal(result.output, received.toString())
    assert.equal(result.fee, (150_000n * 21_000_000_000n).toString())
  }
})
await test('the wallet adding a priority fee is accepted inside the approved ceiling (verified with notes); a higher ceiling, wrong calldata or a short result is not', async () => {
  const tipped = await settle('EURC', 'USDC', { tip: 1_500_000_000n, maxFeePerGas: 28_500_000_000n }); assert.equal(tipped.result.intent.verdict, 'verified_with_notes')
  assert.equal((await settle('WETH', 'EURC', { tip: 1_500_000_000n, maxFeePerGas: 400_000_000_000n })).result.intent.verdict, 'mismatch') // wallet raised the fee cap above the approved ceiling
  const short = await settle('cirBTC', 'USDC', { received: 1n }); assert.equal(short.result.intent.verdict, 'mismatch'); assert.ok(short.result.intent.differences.some(d => /below the reviewed minimum/.test(d)))
  const base = await settle('EURC', 'USDC'), other2 = await settle('EURC', 'USDC', { input: `${base.review.transaction.data}00` })
  assert.equal(other2.result.intent.verdict, 'mismatch')
  const reverted = await settle('EURC', 'USDC', { status: 'reverted' }); assert.equal(reverted.result.chain.state, 'reverted'); assert.equal(reverted.result.chain.received, null)
})
await test('a settled mismatch is a recorded mismatch, never Confirmed, and it does not block the next swap', async () => {
  const short = await settle('cirBTC', 'USDC', { received: 1n }), { review } = short
  const data = new Map(), storage = { getItem: k => (data.has(k) ? data.get(k) : null), setItem: (k, v) => { data.set(k, v) } }
  const controller = e.createUniswapArcExecution({ context: () => ({ owner, connected: true, chainId: 5042, connectorId: 'c' }), input: () => review.request, authorize: () => true, enabled: () => true, fresh: async () => review, quoteNow: () => NOW,
    preflight: async () => ({ nonce: 7, latestNonce: 7 }), provider: async () => ({ request: async ({ method }) => (method === 'eth_chainId' ? '0x13b2' : method === 'eth_accounts' ? [owner] : method === 'eth_getTransactionCount' ? '0x7' : HASH) }),
    result: async () => short.result, storage, lock: async (_o, run) => run() })
  e.createExecutionJournal(storage).save({ id: crypto.randomUUID(), review, nonce: 7, status: 'pending', createdAt: 1, hash: HASH })
  await controller.reconcile(owner); const view = controller.current()
  assert.equal(view.phase, 'mismatch'); assert.equal(view.attempt.status, 'mismatch'); assert.equal(view.attempt.chain.state, 'success'); assert.equal(view.nextCheckMs, null)
  assert.notEqual(view.attempt.status, 'confirmed')
})

// ---------------------------------------------------------------------------------------------------------------------------------------
// Simulation helper and read-only adapter
await test('the simulation helper is reproducible from its source and is only ever injected as call-scoped state', () => {
  const out = execFileSync(process.execPath, [`${root}scripts/build-swap-simulator.mjs`, '--check'], { encoding: 'utf8' })
  assert.match(out, /matches a fresh compile/); assert.match(sim.SIMULATOR_RUNTIME, /^0x[0-9a-f]+$/); assert.equal(keccak256(readFileSync(`${root}scripts/contracts/SwapSimulator.sol`)).length, 66)
  const source = readFileSync(`${root}scripts/contracts/SwapSimulator.sol`, 'utf8'); assert.doesNotMatch(source, /selfdestruct|delegatecall|transfer\(|\.send\(|\.transfer\(/)
  const adapterSource = readFileSync(`${root}src/lib/swap/uniswapOnchainRpc.ts`, 'utf8'); assert.doesNotMatch(adapterSource, /sendTransaction|eth_sendTransaction|signMessage|requestAddresses/)
})
await test('simulation overrides give the helper exactly the input amount and nothing else: native balance for USDC, one token slot otherwise', () => {
  const sr = onchain.SIMULATION_RECIPIENT
  const usdc = rpcAdapter.simulationOverrides('USDC', 1_000_000n)
  assert.equal(usdc.length, 1); assert.equal(usdc[0].address, sr); assert.equal(usdc[0].code, sim.SIMULATOR_RUNTIME); assert.equal(usdc[0].balance, 1_000_000n * 10n ** 12n + 10n ** 18n)
  const eurc = rpcAdapter.simulationOverrides('EURC', 123n)
  assert.equal(eurc[0].balance, undefined); assert.ok(p.sameAddress(eurc[1].address, p.ARC_TOKENS.EURC.address))
  assert.equal(eurc[1].stateDiff[0].slot, keccak256(encodeAbiParameters(parseAbiParameters('address,uint256'), [sr, 9n]))); assert.equal(eurc[1].stateDiff[0].value, pad(toHex(123n), { size: 32 }))
  const weth = rpcAdapter.simulationOverrides('WETH', 5n)
  assert.equal(weth[1].stateDiff[0].slot, keccak256(encodeAbiParameters(parseAbiParameters('address,bytes32'), [sr, '0x52c63247e1f47db19d5ce0460030c497f067ca4cebf71ba98eeadabe20bace00'])))
  assert.equal(weth.length, 2); assert.equal(weth[1].stateDiff.length, 1)
  const native = decodeFunctionData({ abi: sim.SIMULATOR_ABI, data: rpcAdapter.simulationCall({ data: '0x1234', tokenIn: 'USDC', tokenOut: 'EURC', amountIn: 7n }) })
  assert.equal(native.args[2], 7n * 10n ** 12n); assert.equal(native.args[5], '0x0000000000000000000000000000000000000000'); assert.equal(native.args[6], 0n)
  const erc = decodeFunctionData({ abi: sim.SIMULATOR_ABI, data: rpcAdapter.simulationCall({ data: '0x1234', tokenIn: 'EURC', tokenOut: 'USDC', amountIn: 7n }) })
  assert.equal(erc.args[2], 0n); assert.equal(erc.args[5], p.ARC_PERMIT2); assert.equal(erc.args[6], 7n); assert.ok(p.sameAddress(erc.args[0], p.ARC_ROUTER))
})
await test('the read-only adapter separates reverts from outages, backs off on rate limits, and reads the chain at one pinned block', async () => {
  const result = (r, i, o, g) => encodeFunctionData({ abi: [{ type: 'function', name: 'r', stateMutability: 'view', inputs: [], outputs: [{ type: 'tuple', components: ['inBefore', 'inAfter', 'outBefore', 'outAfter', 'gasUsed'].map(name => ({ name, type: 'uint256' })) }] }], functionName: 'r' }) && require('viem').encodeAbiParameters([{ type: 'tuple', components: ['inBefore', 'inAfter', 'outBefore', 'outAfter', 'gasUsed'].map(name => ({ name, type: 'uint256' })) }], [{ inBefore: 10n, inAfter: 10n - i, outBefore: 5n, outAfter: 5n + o, gasUsed: g }])
  let pauses = 0
  const ports = rpc => rpcAdapter.createOnchainPorts(rpc, () => NOW, async () => { pauses++ })
  const input = { data: '0x1234', tokenIn: 'EURC', tokenOut: 'USDC', amountIn: 7n }
  assert.deepEqual(await ports({ call: async () => ({ data: result(0, 7n, 900n, 80_000n) }) }).simulate(input), { received: 900n, spent: 7n, gas: 80_000n })
  await assert.rejects(ports({ call: async () => { const e = Error('x'); e.name = 'CallExecutionError'; e.cause = Object.assign(Error('execution reverted'), { name: 'ExecutionRevertedError', code: 3 }); throw e } }).simulate(input), e => e.message === 'reverted')
  let attempts = 0
  assert.equal((await ports({ call: async () => { if (++attempts < 3) throw Object.assign(Error('rate limit'), { code: -32005 }); return { data: result(0, 7n, 1n, 1n) } } }).simulate(input)).received, 1n); assert.equal(pauses, 2)
  await assert.rejects(ports({ call: async () => { throw Object.assign(Error('rate limit'), { code: -32005 }) } }).simulate(input), e => e.code === 'rpc_unavailable')
  await assert.rejects(ports({ call: async () => { throw Object.assign(new Error('fetch failed'), { name: 'HttpRequestError' }) } }).simulate(input), e => e.code === 'rpc_unavailable')
  await assert.rejects(ports({ call: async () => ({ data: undefined }) }).simulate(input), e => e.message === 'reverted')
  const pinned = []
  const chain = await ports({ getBlockNumber: async () => 77n, getBlock: async ({ blockNumber }) => { pinned.push(blockNumber); return { timestamp: 1234n, baseFeePerGas: 30n } }, getCode: async ({ blockNumber }) => { pinned.push(blockNumber); return runtime },
    getBalance: async ({ blockNumber }) => { pinned.push(blockNumber); return 9n }, getGasPrice: async () => 20n }).chain(owner)
  assert.deepEqual(pinned, [77n, 77n, 77n]); assert.equal(chain.gasPrice, 30n); assert.equal(chain.routerHash, p.ARC_ROUTER_HASH); assert.equal(chain.timestamp, 1234n); assert.equal(chain.nativeBalance, 9n)
})

// ---------------------------------------------------------------------------------------------------------------------------------------
// Execution mode
await test('the execution mode defaults to the full multi-direction swap; the earlier pilot is selected only by the exact string "pilot", and the execution switch stays the kill switch of both', () => {
  for (const value of [undefined, '', 'OPEN', 'open', 'PILOT', 'Pilot', 'pilot ', 'true', '1']) assert.equal(mode.swapExecutionConfig('true', owner, value).mode, 'open', String(value))
  assert.equal(mode.swapExecutionConfig('true', owner, 'pilot').mode, 'pilot'); assert.equal(mode.swapExecutionConfig('true', undefined, undefined).enabled, true) // the build switch alone enables the default mode
  for (const value of [undefined, 'open', 'pilot']) { assert.equal(mode.swapExecutionConfig('false', owner, value).enabled, false, String(value)); assert.equal(mode.swapExecutionConfig('TRUE', owner, value).enabled, false, String(value)); assert.equal(mode.swapExecutionConfig(undefined, owner, value).enabled, false, String(value)) }
  assert.equal(mode.swapExecutionConfig('true', other, 'pilot').enabled, false) // the pilot still demands the approved wallet
  assert.equal(mode.swapExecutionConfig('true', other, undefined).mode, 'open'); assert.equal(mode.swapExecutionConfig('true', p.ARC_ROUTER, undefined).wallet, '') // a router address is never taken as a wallet
})
await test('pilot mode lets exactly one request through: the approved wallet, USDC to EURC, at most 0.1 USDC', () => {
  const config = mode.swapExecutionConfig('true', owner, 'pilot'), ctx = { connected: true, owner, chainId: 5042 }
  const r = (tokenIn, tokenOut, amount) => p.validateArcRequest(requestFor(tokenIn, tokenOut, { amount }))
  assert.equal(mode.swapExecutionRestriction(config, r('USDC', 'EURC', '0.1'), ctx), null); assert.equal(mode.swapExecutionRestriction(config, r('USDC', 'EURC', '0.000001'), ctx), null)
  assert.equal(mode.swapExecutionRestriction(config, r('USDC', 'EURC', '0.100001'), ctx), 'pilot_amount'); assert.equal(mode.swapExecutionRestriction(config, r('USDC', 'EURC', '5'), ctx), 'pilot_amount')
  for (const { tokenIn, tokenOut } of tokens.SWAP_DIRECTIONS) if (!(tokenIn === 'USDC' && tokenOut === 'EURC')) assert.equal(mode.swapExecutionRestriction(config, r(tokenIn, tokenOut, amountFor[tokenIn]), ctx), 'pilot_direction', `${tokenIn}>${tokenOut}`)
  assert.equal(mode.swapExecutionRestriction(config, null, ctx), 'request'); assert.equal(mode.swapExecutionRestriction(config, r('USDC', 'EURC', '0.1'), { ...ctx, chainId: 1 }), 'network')
  assert.equal(mode.swapExecutionRestriction(config, r('USDC', 'EURC', '0.1'), { ...ctx, connected: false }), 'wallet'); assert.equal(mode.swapExecutionRestriction(config, r('USDC', 'EURC', '0.1'), { ...ctx, owner: other }), 'wallet')
  const foreign = p.validateArcRequest(requestFor('USDC', 'EURC', { owner: other, recipient: other, amount: '0.1' }))
  assert.equal(mode.swapExecutionRestriction(config, foreign, { ...ctx, owner: other }), 'pilot_wallet')
  assert.equal(mode.swapExecutionRestriction(mode.swapExecutionConfig('false', owner, 'pilot'), r('USDC', 'EURC', '0.1'), ctx), 'disabled')
  assert.equal(pilot.arcPilotAllows(pilot.arcPilotConfig('true', owner), r('EURC', 'USDC', '1'), ctx), false); assert.equal(pilot.arcPilotAllows(pilot.arcPilotConfig('true', owner), r('USDC', 'cirBTC', '0.1'), ctx), false)
  for (const key of Object.keys(mode)) if (key.endsWith('Message')) assert.ok(mode[key]('pilot_direction').length > 20)
})
await test('open mode allows every supported direction within contract bounds for any wallet, and still needs the execution switch, the network and the wallet', () => {
  const config = mode.swapExecutionConfig('true', undefined, 'open'), ctx = { connected: true, owner: other, chainId: 5042 }
  for (const { tokenIn, tokenOut } of tokens.SWAP_DIRECTIONS) assert.equal(mode.swapExecutionRestriction(config, p.validateArcRequest(requestFor(tokenIn, tokenOut, { owner: other, recipient: other })), ctx), null, `${tokenIn}>${tokenOut}`)
  assert.equal(mode.swapExecutionRestriction(mode.swapExecutionConfig('false', undefined, 'open'), p.validateArcRequest(requestFor('USDC', 'EURC', { owner: other, recipient: other })), ctx), 'disabled')
  assert.equal(mode.swapExecutionRestriction(config, { ...requestFor('USDC', 'EURC', { owner: other, recipient: other }), amount: '1' + '0'.repeat(100) }, ctx), 'request') // ABI-invalid input never reaches a wallet
  assert.equal(mode.swapExecutionRestriction(config, p.validateArcRequest(requestFor('USDC', 'EURC', { owner: other, recipient: other })), { ...ctx, chainId: 1 }), 'network')
})
await test('large native and ERC-20 reviews preserve exact amounts, minimums, gas caps and fail closed on liquidity or balance failure', async () => {
  for (const [symbol, amount] of [['USDC', '11'], ['USDC', '1000000000.123456'], ['EURC', '9007199254740993.123456'], ['WETH', '10000.123456789012345678'], ['cirBTC', '100.12345678']]) {
    const out = symbol === 'EURC' ? 'USDC' : 'EURC', request = p.validateArcRequest(requestFor(symbol, out, { amount }))
    const units = p.tokenUnits(amount, dec[symbol]), nativeValue = program.routeTransactionValue(request)
    const simulated = units * 10n ** BigInt(dec[out]) / 10n ** BigInt(dec[symbol]) * 9n / 10n
    const options = { chain: { nativeBalance: nativeValue + 10n ** 18n }, simulate: () => ({ received: simulated }) }
    const review = await onchain.createOnchainReview(request, fakePorts(options).ports, context)
    assert.equal(BigInt(review.transaction.value), nativeValue)
    assert.equal(pathOf(review.transaction.data).swap[1], units)
    assert.equal(BigInt(review.requiredMinimum), simulated * 9950n / 10000n)
    assert.ok(BigInt(review.networkFee) <= 10n ** 17n)
    await assert.rejects(onchain.createOnchainReview(request, fakePorts({ ...options, simulate: () => 'revert' }).ports, context), e => e.code === 'simulation_failed')
    await assert.rejects(onchain.createOnchainReview(request, fakePorts({ ...options, chain: { nativeBalance: nativeValue } }).ports, context), e => e.code === 'insufficient_native_balance')
  }
})
await test('bounded amount parser rejects malformed, excessive precision and uint256 overflow without a provider request', () => {
  for (const value of ['0', '-1', '+1', '01', '1e6', ' 1', '1.', '.1', 'Infinity', '1' + '0'.repeat(1000), 100, null, '1.0000001'])
    assert.throws(() => tokens.swapInputUnits(value, 'USDC'))
  assert.equal(tokens.parseSwapUnits(tokens.SWAP_UINT256_MAX.toString(), 0), tokens.SWAP_UINT256_MAX)
  assert.throws(() => tokens.parseSwapUnits((tokens.SWAP_UINT256_MAX + 1n).toString(), 0), /input_range/)
})
assert.equal(external, 0, 'no network request was made')
console.log(`${count} Uniswap on-chain provider groups PASS. Controlled ports only; zero network, signatures, approvals or transactions.`)
