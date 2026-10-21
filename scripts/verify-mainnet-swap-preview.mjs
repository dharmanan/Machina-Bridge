// Read-only deterministic regressions. SDK HTTP and RPC are mocked; no keys, signatures or funds.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
const require = createRequire(import.meta.url)
const ts = require('typescript')
for (const extension of ['.ts', '.tsx']) require.extensions[extension] = (module, filename) => {
  const { outputText } = ts.transpileModule(readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true }, fileName: filename,
  })
  module._compile(outputText, filename)
}
const root = fileURLToPath(new URL('..', import.meta.url))
const config = require(`${root}src/config/mainnetSwap.ts`)
const swap = require(`${root}src/lib/mainnetSwap.ts`)
const { getChainByEnum } = require('@circle-fin/swap-kit')
const { MAINNET_SWAP_TOKENS: tokens } = config
const address = '0x1111111111111111111111111111111111111111' // synthetic, never queried on a live endpoint
const request = { address, chainId: 5042, tokenIn: 'USDC', tokenOut: 'EURC', amount: '7', slippageBps: 100 }
const raw = (input = request) => ({
  tokenIn: input.tokenIn, tokenOut: input.tokenOut, amountIn: input.amount,
  chain: 'Arc', chainIn: 'Arc', chainOut: 'Arc', fromAddress: address, toAddress: address,
  estimatedOutput: { token: input.tokenOut, amount: '6.2' }, stopLimit: { token: input.tokenOut, amount: '6.138' },
  fees: [{ type: 'provider', token: 'USDC', amount: '0.0014' }, { type: 'gas', token: 'USDC', amount: '0.02070858705783893' }],
})
let passed = 0
async function test(name, run) { await run(); passed++; console.log(`PASS ${name}`) }
await test('Preview enabled and writes unconditionally disabled', () => {
  assert.equal(config.MAINNET_SWAP_READ_ONLY_ENABLED, true)
  assert.equal(config.MAINNET_SWAP_WRITES_ENABLED, false)
  assert.equal(config.MAINNET_SWAP_CHAIN_ID, 5042)
  assert.equal(getChainByEnum('Arc').chainId, 5042)
  assert.equal(getChainByEnum('Arc').isTestnet, false)
})
await test('all four pinned Arc contracts and decimals are offered', () => {
  assert.deepEqual(Object.keys(tokens), ['USDC', 'EURC', 'cirBTC', 'WETH'])
  assert.deepEqual(Object.values(tokens).map(({ address, decimals }) => [address.toLowerCase(), decimals]), [
    ['0x3600000000000000000000000000000000000000', 6],
    ['0xbef5f6d51cb62b58e6a8f77868681825c6fe21c1', 6],
    ['0x171a4217b86a807a64eb94757db6849fb4bdbaa0', 8],
    ['0x128cc466b61f542da60c70e3aa11c10e19b84edb', 18],
  ])
})
await test('amount math preserves values above Number precision and cirBTC base units', () => {
  assert.equal(swap.decimalUnits('9007199254740993.123456', 6), 9007199254740993123456n)
  assert.equal(swap.decimalUnits('0.00000001', 8), 1n)
  for (const amount of ['', '-1', '1e6', ' 1', '1,2', 'NaN', '0x10', '1.0000001', '01']) {
    assert.throws(() => swap.validateSwapRequest({ ...request, amount }))
  }
  assert.throws(() => swap.validateSwapRequest({ ...request, amount: '0' }))
})
await test('wallet, network, pair and slippage gates fail closed', () => {
  assert.equal(swap.swapWalletState(false), 'disconnected')
  assert.equal(swap.swapWalletState(true, 1), 'wrong_network')
  assert.equal(swap.swapWalletState(true, 5042), 'ready')
  for (const change of [{ address: '' }, { address: `0x${'0'.repeat(40)}` }, { chainId: 1 }, { chainId: 5042002 }, { tokenOut: 'DAI' }, { tokenIn: 'constructor' }, { tokenOut: 'USDC' }, { tokenIn: 'cirBTC' }, { slippageBps: 0 }, { slippageBps: 301 }]) {
    assert.throws(() => swap.validateSwapRequest({ ...request, ...change }))
  }
})
await test('insufficient token balances are exact, and unavailable balances are never zero', () => {
  assert.equal(swap.hasInsufficientSwapBalance('7', 'USDC', 6999999n), true)
  assert.equal(swap.hasInsufficientSwapBalance('7', 'USDC', 7000000n), false)
  assert.equal(swap.hasInsufficientSwapBalance('7', 'USDC', undefined), false)
  assert.equal(swap.hasInsufficientSwapBalance('0.00000001', 'cirBTC', 0n), true)
})
await test('successful quote preserves exact output, minimum and distinct native gas precision', () => {
  const quote = swap.normalizeSwapQuote(raw(), request, 1000)
  assert.equal(quote.estimatedOutput, '6.2')
  assert.equal(quote.minimumOutput, '6.138')
  assert.equal(quote.fees[1].amount, '0.02070858705783893')
  assert.equal(quote.expiresAt, 31000)
})

await test('WETH output, minimum, slippage and fee amounts retain all 18 decimals', () => {
  const input = { ...request, tokenOut: 'WETH' }
  const data = raw(input)
  data.estimatedOutput = { token: tokens.WETH.address, amount: '0.004123456789012345' }
  data.stopLimit = { token: tokens.WETH.address, amount: '0.004082222221122221' }
  data.fees = [
    { type: 'provider', token: 'USDC', amount: '0.0014' },
    { type: 'gas', token: 'USDC', amount: '0.022822750974000829' },
    { type: 'swap', token: tokens.WETH.address, amount: '0.000000000000000001' },
  ]
  const quote = swap.normalizeSwapQuote(data, input, 1000)
  assert.equal(quote.estimatedOutput, '0.004123456789012345')
  assert.equal(quote.minimumOutput, '0.004082222221122221')
  assert.equal(quote.fees[1].amount, '0.022822750974000829')
  assert.equal(quote.fees[2].amount, '0.000000000000000001')
  assert.equal(swap.decimalUnits(quote.estimatedOutput, 18), 4123456789012345n)
  const belowTolerance = { ...data, stopLimit: { token: 'WETH', amount: '0.004082222221122220' } }
  assert.throws(() => swap.normalizeSwapQuote(belowTolerance, input, 1000), /invalid_quote/)
  assert.throws(() => swap.normalizeSwapQuote({ ...data, fees: [{ type: 'gas', token: 'WETH', amount: '0.01' }] }, input, 1000), /invalid_quote/)
  assert.throws(() => swap.normalizeSwapQuote({ ...data, estimatedOutput: { token: 'ETH', amount: '0.004123456789012345' } }, input, 1000), /invalid_quote/)
  for (const field of ['estimatedOutput', 'stopLimit']) {
    assert.throws(() => swap.normalizeSwapQuote({ ...data, [field]: { token: 'WETH', amount: '0.0041234567890123451' } }, input, 1000))
  }
})
await test('WETH input and balances use exact 18-decimal units and still require Arc USDC pairs', () => {
  const input = { ...request, tokenIn: 'WETH', tokenOut: 'USDC', amount: '0.004123456789012345' }
  assert.doesNotThrow(() => swap.validateSwapRequest(input))
  assert.equal(swap.hasInsufficientSwapBalance(input.amount, 'WETH', 4123456789012344n), true)
  assert.equal(swap.hasInsufficientSwapBalance(input.amount, 'WETH', 4123456789012345n), false)
  assert.equal(swap.hasInsufficientSwapBalance(input.amount, 'WETH', undefined), false)
  assert.throws(() => swap.validateSwapRequest({ ...input, amount: '0.0041234567890123451' }))
  assert.throws(() => swap.validateSwapRequest({ ...input, tokenOut: 'EURC' }), /unsupported_route/)
  assert.throws(() => swap.validateSwapRequest({ ...input, chainId: 1 }), /wrong_network/)
})

await test('contract-address echoes and reversed quotes validate without assuming route availability', () => {
  const input = { ...request, tokenIn: 'cirBTC', tokenOut: 'USDC', amount: '0.0001' }
  const data = raw(input)
  data.tokenIn = tokens.cirBTC.address
  data.tokenOut = tokens.USDC.address
  data.stopLimit.token = tokens.USDC.address
  data.estimatedOutput.token = tokens.USDC.address
  assert.equal(swap.normalizeSwapQuote(data, input, 1000).estimatedOutput, '6.2')
})
await test('mismatched identities, chains, amounts and malformed quotes are rejected', () => {
  for (const change of [{ chainIn: 'Ethereum' }, { chainOut: 'Arc_Testnet' }, { chain: 'Ethereum' }, { tokenIn: 'EURC' }, { tokenOut: 'cirBTC' }, { amountIn: '8' }, { fromAddress: `0x${'2'.repeat(40)}` }, { toAddress: `0x${'2'.repeat(40)}` }, { estimatedOutput: null }, { stopLimit: { token: 'EURC', amount: '6.1' } }, { stopLimit: { token: 'EURC', amount: '7' } }, { stopLimit: { token: 'EURC', amount: '0' } }, { estimatedOutput: { token: 'EURC', amount: '0' } }, { estimatedOutput: { token: 'EURC', amount: '6.1234567' } }]) {
    assert.throws(() => swap.normalizeSwapQuote({ ...raw(), ...change }, request, 1000), JSON.stringify(change))
  }
  for (const data of [null, {}, [], 'not-json']) assert.throws(() => swap.normalizeSwapQuote(data, request, 1000))
})
await test('missing or SDK-zero gas is not represented as free gas', () => {
  const data = raw(); data.fees[1].amount = '0'
  assert.equal(swap.normalizeSwapQuote(data, request, 1000).fees[1].amount, null)
  delete data.fees
  assert.deepEqual(swap.normalizeSwapQuote(data, request, 1000).fees, [])
  for (const fees of [[{ type: 'gas', token: 'ETH', amount: '1' }], [{ type: 'provider', token: 'USDC', amount: '-1' }], [{ type: 'gas', token: 'USDC', amount: '0.0000000000000000001' }], [{ type: 'provider', token: 'USDC', amount: undefined }], 'invalid', Array(17).fill({})]) {
    assert.throws(() => swap.normalizeSwapQuote({ ...raw(), fees }, request, 1000))
  }
})
await test('freshness starts at request time and does not survive expiry or any context change', () => {
  const quote = swap.normalizeSwapQuote(raw(), request, 5000, 1000)
  assert.equal(quote.expiresAt, 31000)
  assert.equal(swap.isCurrentSwapQuote(quote, request, 31000), false)
  assert.equal(swap.isCurrentSwapQuote(quote, request, 30999), true)
  assert.equal(swap.isCurrentSwapQuote(quote, null, 5000), false)
  for (const change of [{ address: `0x${'2'.repeat(40)}` }, { chainId: 1 }, { tokenOut: 'cirBTC' }, { amount: '8' }, { slippageBps: 50 }]) assert.equal(swap.isCurrentSwapQuote(quote, { ...request, ...change }, 5000), false)
  assert.throws(() => swap.normalizeSwapQuote(raw(), request, 31000, 1000), /expired/)
})
await test('timeout does not release the in-flight slot or publish late output', async () => {
  let resolve; let calls = 0
  const read = swap.createSwapQuoteReader(() => { calls++; return new Promise((done) => { resolve = done }) }, 10)
  const signal = new AbortController().signal
  await assert.rejects(read(request, signal), /quote_timeout/)
  await assert.rejects(read(request, signal), /quote_busy/)
  assert.equal(calls, 1)
  resolve(raw())
  await new Promise((done) => setTimeout(done, 0))
})
await test('aborted contexts cannot publish; settled operations allow a fresh request', async () => {
  let resolve
  const read = swap.createSwapQuoteReader(() => new Promise((done) => { resolve = done }), 100)
  const controller = new AbortController()
  const promise = read(request, controller.signal)
  await Promise.resolve(); controller.abort()
  await assert.rejects(promise, /cancelled/)
  await assert.rejects(read(request, new AbortController().signal), /busy/)
  resolve(raw()); await new Promise((done) => setTimeout(done, 0))
  const next = read(request, new AbortController().signal)
  await Promise.resolve(); resolve(raw())
  assert.equal((await next).estimatedOutput, '6.2')
  const already = new AbortController(); already.abort()
  await assert.rejects(read(request, already.signal), /cancelled/)
})
await test('RPC and adapter boundaries deny all transaction/signature and wallet methods', () => {
  for (const method of ['eth_sendRawTransaction', 'eth_sendTransaction', 'eth_sign', 'personal_sign', 'eth_signTypedData_v4', 'wallet_switchEthereumChain', 'eth_requestAccounts']) assert.throws(() => swap.assertSwapReadMethod(method), /read_only/)
  for (const method of ['eth_call', 'eth_chainId', 'eth_getBalance', 'eth_gasPrice']) assert.doesNotThrow(() => swap.assertSwapReadMethod(method))
  const adapter = swap.createSwapReadAdapter()
  for (const method of ['prepare', 'waitForTransaction', 'getAddress']) assert.throws(() => adapter[method](), /read_only/)
  for (const method of ['getWalletClient', 'prepareTransaction', 'signTransaction', 'executeTransaction', 'writeContract', 'approve', 'options', 'getPublicClient']) assert.throws(() => adapter[method], /read_only/)
})
await test('error messages are bounded and do not expose raw provider payloads', () => {
  assert.match(swap.swapPreviewError(new Error('no liquidity')), /No supported quote/)
  assert.match(swap.swapPreviewError(new Error('Stablecoin Service createSwap failed: Route or resource not found. Details: No route available')), /Circle cannot provide a quote for this amount/)
  assert.match(swap.swapPreviewError(new Error('WETH is not supported')), /No supported quote/)
  assert.match(swap.swapPreviewError(new Error('quote_timeout')), /timed out/)
  assert.equal(swap.swapPreviewError(new Error('sensitive body and credentials')), 'A verified quote could not be loaded. Try again shortly.')
})

const originalFetch = globalThis.fetch
let rpcCalls = [], serviceBodies = []
let incorrectDecimals = false
let rejectReverse = false
// Exercise the actual installed SDK and real Viem adapter with local mock responses.
globalThis.fetch = async (url, init) => {
  const endpoint = String(url)
  const body = JSON.parse(init.body)
  if (endpoint.startsWith(config.MAINNET_SWAP_RPC)) {
    const batches = Array.isArray(body) ? body : [body]
    const results = batches.map((entry) => {
      rpcCalls.push(entry.method); swap.assertSwapReadMethod(entry.method)
      let result
      if (entry.method === 'eth_chainId') result = '0x13b2'
      else if (entry.method === 'eth_gasPrice') result = '0x2540be400'
      else if (entry.method === 'eth_call') {
        const token = Object.values(tokens).find((token) => token.address.toLowerCase() === entry.params[0].to.toLowerCase())
        assert.ok(token)
        result = `0x${BigInt(incorrectDecimals ? 17 : token.decimals).toString(16).padStart(64, '0')}`
      } else throw new Error(`Unexpected RPC ${entry.method}`)
      return { jsonrpc: '2.0', id: entry.id, result }
    })
    return Response.json(Array.isArray(body) ? results : results[0])
  }
  assert.equal(endpoint, 'https://api.circle.com/v1/stablecoinKits/swap')
  assert.equal(init.method, 'POST') // quote preparation, never broadcast
  assert.equal(new Headers(init.headers).get('Authorization'), null)
  serviceBodies.push(body)
  const outputs = { EURC: ['6200000', '6138000'], cirBTC: ['12345', '12221'], WETH: ['4123456789012345', '4082222221122221'], USDC: ['6200000', '6138000'] }
  const outputToken = Object.values(tokens).find(token => token.address.toLowerCase() === body.tokenOutAddress.toLowerCase())
  assert.ok(outputToken, 'SDK must send a pinned contract address, never an unverified alias')
  const output = outputs[outputToken.symbol]
  if (rejectReverse && body.tokenInAddress.toLowerCase() === tokens.WETH.address.toLowerCase()) {
    return Response.json({ message: 'No liquidity route available' }, { status: 400 })
  }
  return Response.json({
    ...body, tokenOutChain: 'Arc', estimatedAmount: output[0], stopLimit: output[1],
    fees: { provider: [{ amount: '1400', token: tokens.USDC.address, symbol: 'USDC', decimals: 6 }] },
    transaction: { signature: 'mock-service-signature-not-a-wallet-signature', gasLimit: '0x5208', executionParams: { execId: 'mock', deadline: '9999999999', metadata: '0x00', tokens: [], instructions: [] } },
  })
}
try {
  await test('real SDK estimate preserves existing USDC routes and adds WETH by contract address', async () => {
    for (const tokenOut of ['EURC', 'cirBTC', 'WETH']) {
      const result = await swap.readMainnetSwapQuote({ ...request, tokenOut }, new AbortController().signal)
      const expected = { EURC: ['6.2', '6.138'], cirBTC: ['0.00012345', '0.00012221'], WETH: ['0.004123456789012345', '0.004082222221122221'] }[tokenOut]
      assert.equal(result.estimatedOutput, expected[0])
      assert.equal(result.minimumOutput, expected[1])
      assert.equal(result.fees.find((fee) => fee.type === 'provider').amount, '0.0014')
      assert.ok(result.fees.find((fee) => fee.type === 'gas').amount)
    }
    assert.equal(serviceBodies.length, 3)
    const wethBody = serviceBodies.find(body => body.tokenOutAddress.toLowerCase() === tokens.WETH.address.toLowerCase())
    assert.ok(wethBody)
    assert.equal(wethBody.amount, '7000000')
    assert.equal(wethBody.tokenInAddress.toLowerCase(), tokens.USDC.address.toLowerCase())
    assert.ok(rpcCalls.includes('eth_call') && rpcCalls.includes('eth_gasPrice'))
    assert.ok(serviceBodies.every((body) => body.tokenInChain === 'Arc' && body.tokenOutChain === 'Arc' && body.slippageBps === 100))
  })
  await test('WETH reverse direction requires a successful SDK quote and preserves 18-decimal input', async () => {
    const input = { ...request, tokenIn: 'WETH', tokenOut: 'USDC', amount: '0.004123456789012345' }
    const result = await swap.readMainnetSwapQuote(input, new AbortController().signal)
    assert.equal(result.estimatedOutput, '6.2')
    assert.equal(serviceBodies.at(-1).tokenInAddress.toLowerCase(), tokens.WETH.address.toLowerCase())
    assert.equal(serviceBodies.at(-1).amount, '4123456789012345')
    rejectReverse = true
    await assert.rejects(swap.readMainnetSwapQuote(input, new AbortController().signal))
    rejectReverse = false
  })
  await test('wrong on-chain decimals is rejected by the adapter', async () => {
    incorrectDecimals = true
    const adapter = swap.createSwapReadAdapter()
    await assert.rejects(adapter.getTokenDecimals(tokens.cirBTC.address, getChainByEnum('Arc')), /token_decimals_mismatch/)
    await assert.rejects(adapter.getTokenDecimals(tokens.WETH.address, getChainByEnum('Arc')), /token_decimals_mismatch/)
    await assert.rejects(adapter.getTokenDecimals(tokens.EURC.address, getChainByEnum('Ethereum')), /unsupported_chain/)
    await assert.rejects(adapter.getTokenDecimals(`0x${'9'.repeat(40)}`, getChainByEnum('Arc')), /unsupported_token/)
  })
} finally { globalThis.fetch = originalFetch }

await test('only mainnet receives the new lazy Swap tab; legacy routes and default Bridge remain', () => {
  const app = readFileSync(`${root}src/App.tsx`, 'utf8')
  assert.match(app, /const MainnetSwapPreview = lazy/)
  assert.match(app, /readStoredAppNetwork\(\) === 'mainnet' \? 'bridge' : 'swap'/)
  assert.match(app, /id: 'swap' as const, label: 'Swap'/)
  for (const component of ['SwapTab', 'BridgeTab', 'MainnetBorrow', 'MainnetEarnPreview', 'MainnetDashboard', 'MainnetWalletActivity', 'MainnetPreviewGate']) assert.match(app, new RegExp(`<${component}\\b`))
  const activity = readFileSync(`${root}src/components/MainnetWalletActivity.tsx`, 'utf8')
  assert.match(activity, /Activity data provided by Blockscout\./)
})
await test('UI cannot import execution helpers, and all requests are contextual and abortable', () => {
  const component = readFileSync(`${root}src/components/MainnetSwapPreview.tsx`, 'utf8') + readFileSync(`${root}src/components/MainnetSwapScreen.tsx`, 'utf8')
  const library = readFileSync(`${root}src/lib/mainnetSwap.ts`, 'utf8')
  for (const source of [component, library]) assert.doesNotMatch(source, /\.swap\(|\.approve\(|sendTransaction\(|writeContract\(|signTypedData\(|personal_sign|useWalletClient|window\.ethereum|privateKeyToAccount/)
  assert.match(component, /Swap disabled in Preview/)
  assert.match(component, /<button type="button" disabled/)
  assert.match(component, /balance\.isSuccess/)
  assert.match(component, /generation\.current === expectedGeneration/)
  assert.match(component, /controller\.current\?\.abort\(\)/)
  assert.match(component, /sm:grid-cols-2/)
  assert.match(component, /break-all/)
})
console.log(`\n${passed} Mainnet Swap Preview checks passed. No live RPC, wallet or Circle request was sent.`)

const Module = require('node:module')
const originalRequire = Module.prototype.require
const React = require('react')
const { renderToStaticMarkup } = require('react-dom/server')
let wallet = { isConnected: false, chainId: undefined, address: undefined }
let mockBalance = { isSuccess: false, isError: false, data: undefined }
let mockNative = { data: undefined, isError: false }
Module.prototype.require = function (id) {
  if (id === 'wagmi') return { useAccount: () => wallet, useReadContract: () => mockBalance, useBalance: () => mockNative }
  return originalRequire.apply(this, arguments)
}
let Component
try { Component = require(`${root}src/components/MainnetSwapScreen.tsx`).default }
finally { Module.prototype.require = originalRequire }
await test('disconnected DOM keeps quote and execution controls disabled', () => {
  const html = renderToStaticMarkup(React.createElement(Component))
  assert.match(html, /Connect your wallet using the header/)
  assert.match(html, /disabled=""[^>]*>Get quote/)
  assert.match(html, /disabled=""[^>]*>Swap disabled in Preview/)
  assert.doesNotMatch(html, /Estimated from a live quote/)
  assert.match(html, /Preview only/)
  assert.doesNotMatch(html, /Balance:/)
})
await test('wrong-network DOM is explicit and cannot request a quote', () => {
  wallet = { isConnected: true, chainId: 1, address }
  const html = renderToStaticMarkup(React.createElement(Component))
  assert.match(html, /Select Arc Mainnet \(chain ID 5042\)/)
  assert.match(html, /disabled=""[^>]*>Get quote/)
})
await test('Arc wallet DOM shows independent native USDC balance without claiming execution capacity', () => {
  wallet = { isConnected: true, chainId: 5042, address }
  mockNative = { data: { value: 192154955500000000n }, isError: false }
  const html = renderToStaticMarkup(React.createElement(Component))
  assert.match(html, /Balance: (<!-- -->)?0\.192154 USDC/)
  assert.match(html, /disabled=""[^>]*>Swap disabled in Preview/)
  mockNative = { data: undefined, isError: true }
  const errorHtml = renderToStaticMarkup(React.createElement(Component))
  assert.match(errorHtml, /Balance: (<!-- -->)?unavailable/)
  assert.doesNotMatch(errorHtml, /Balance: (<!-- -->)?0/)
})
await test('WETH is selectable in both directions and renders its full ERC-20 balance', () => {
  wallet = { isConnected: true, chainId: 5042, address }
  const initialHtml = renderToStaticMarkup(React.createElement(Component))
  assert.equal((initialHtml.match(/<option>WETH<\/option>/g) ?? []).length, 2)
  assert.doesNotMatch(initialHtml, /WETH is not enabled/)
  const originalUseState = React.useState
  mockBalance = { isSuccess: true, isError: false, data: 4123456789012345n }
  React.useState = (initial) => originalUseState(initial === 'USDC' ? 'WETH' : initial === 'EURC' ? 'USDC' : initial)
  try {
    const html = renderToStaticMarkup(React.createElement(Component))
    assert.match(html, /Balance: (<!-- -->)?0\.004123456789012345 WETH/)
    assert.doesNotMatch(html, /Quote source/)
    assert.match(html, /Circle Swap Kit/)
    assert.match(html, /Swap disabled in Preview/)
  } finally { React.useState = originalUseState }
})
console.log(`${passed} total Mainnet Swap checks passed, including DOM states.`)
