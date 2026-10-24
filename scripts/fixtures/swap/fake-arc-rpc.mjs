// A controlled stand-in for the public Arc RPC, for UI tests only. It answers the read-only methods the Swap screen's adapters use
// (quotes by simulation, balances, allowances, gas, nonces, transactions and receipts). No network, no keys, no real chain.
// Prices are synthetic and fixed (cents per whole token); every pool charges its fee tier per hop.
export function createFakeArcRpc({ viem, policy, simulator, routerRuntime, now = () => Date.now() }) {
  const { decodeFunctionData, decodeAbiParameters, encodeAbiParameters, encodeFunctionData, parseAbiParameters, toHex, keccak256, encodeEventTopics, getAddress } = viem
  const SIM = '0x00000000000000000000000000000000005151a7'
  const BLOCK_HASH = `0x${'b'.repeat(64)}`
  const state = {
    block: 100n, gasPrice: 1_000_000_000n, nonce: { latest: 7, pending: 7 }, nativeBalance: 100n * 10n ** 18n, mode: 'normal',
    cents: { USDC: 100n, EURC: 112n, cirBTC: 8_100_000n, WETH: 240_000n }, simulateGas: 100_000n,
    balances: { EURC: 50_000_000n, cirBTC: 10_000_000n, WETH: 10n ** 18n }, // wallet token balances (base units)
    tokenAllowance: {}, permit: {},                                   // `${token}` -> bigint / { amount, expiration }
    txs: new Map(),                                                   // hash -> { tx, receipt }
    blockTimes: new Map(),                                            // block number -> immutable timestamp (seconds)
    calls: [], methods: [], simulations: [],
  }
  const decimals = { USDC: 6, EURC: 6, cirBTC: 8, WETH: 18 }
  const symbolOf = address => Object.keys(policy.ARC_TOKENS).find(symbol => policy.sameAddress(address, policy.ARC_TOKENS[symbol].address))
  const V3_INPUT = parseAbiParameters('address recipient,uint256 amountIn,uint256 amountOutMinimum,bytes path,bool payerIsUser,uint256[] minHopPriceX36')
  const result = parseAbiParameters('(uint256 inBefore,uint256 inAfter,uint256 outBefore,uint256 outAfter,uint256 gasUsed) r')
  const word = value => toHex(value, { size: 32 })
  function quoteOut(tokenIn, tokenOut, amountIn, fees) {
    let units = amountIn * state.cents[tokenIn] * 10n ** BigInt(decimals[tokenOut]) / (state.cents[tokenOut] * 10n ** BigInt(decimals[tokenIn]))
    for (const fee of fees) units = units * (1_000_000n - BigInt(fee)) / 1_000_000n
    return units
  }
  function simulate(data) {
    const call = decodeFunctionData({ abi: simulator.SIMULATOR_ABI, data })
    const [, routerData, , tokenIn, tokenOut, , permitAmount] = call.args, native = policy.sameAddress(tokenIn, policy.ARC_USDC)
    const outer = decodeFunctionData({ abi: policy.EXECUTE_ABI, data: routerData }), swap = decodeAbiParameters(V3_INPUT, outer.args[1][0])
    const path = swap[3], hops = (path.length - 2 - 40) / 46 + 0, fees = []
    for (let i = 0; i < hops; i++) fees.push(parseInt(path.slice(2 + 40 + i * 46, 2 + 40 + i * 46 + 6), 16))
    const symbolIn = symbolOf(tokenIn), symbolOut = symbolOf(tokenOut), amountIn = swap[1]
    state.simulations.push({ tokenIn: symbolIn, tokenOut: symbolOut, amountIn, fees, native, permitAmount })
    if (state.mode === 'simulation-reverts') throw Object.assign(new Error('execution reverted'), { code: 3 })
    const out = quoteOut(symbolIn, symbolOut, amountIn, fees)
    if (out < swap[2]) throw Object.assign(new Error('execution reverted'), { code: 3 })
    const gas = state.simulateGas + 90_000n * BigInt(Math.max(0, hops - 1))
    return encodeAbiParameters(result, [{ inBefore: 10n ** 24n, inAfter: 10n ** 24n - amountIn, outBefore: 0n, outAfter: out, gasUsed: gas }])
  }
  const selectors = {
    decimals: '0x313ce567', balanceOf: '0x70a08231', allowance: '0xdd62ed3e', permitAllowance: '0x927da105',
  }
  function call(params) {
    const { to, data } = params[0]
    if (policy.sameAddress(to, SIM)) return simulate(data)
    const symbol = symbolOf(to)
    if (data === selectors.decimals) return word(BigInt(decimals[symbol] ?? 18))
    if (data.startsWith(selectors.balanceOf) && symbol) return word(symbol === 'USDC' ? state.nativeBalance / 10n ** 12n : state.balances[symbol] ?? 0n)
    if (data.startsWith(selectors.allowance) && symbol) return word(state.tokenAllowance[symbol] ?? 0n)
    if (data.startsWith(selectors.permitAllowance) && policy.sameAddress(to, policy.ARC_PERMIT2)) {
      const token = symbolOf(`0x${data.slice(10 + 64 + 24, 10 + 64 + 64)}`), entry = state.permit[token] ?? { amount: 0n, expiration: 0 }
      return `0x${word(entry.amount).slice(2)}${word(BigInt(entry.expiration)).slice(2)}${word(0n).slice(2)}`
    }
    state.calls.push({ to, data, value: params[0].value ?? '0x0' })
    if (state.mode === 'swap-call-reverts') throw Object.assign(new Error('execution reverted'), { code: 3 })
    return '0x'
  }
  const block = number => {
    // A historical block cannot acquire a new timestamp between snapshot checks.
    if (!state.blockTimes.has(number)) state.blockTimes.set(number, BigInt(Math.floor(now() / 1000)))
    return { number: toHex(number), hash: BLOCK_HASH, parentHash: BLOCK_HASH, timestamp: toHex(state.blockTimes.get(number)), baseFeePerGas: toHex(state.gasPrice), gasLimit: '0x1c9c380', gasUsed: '0x186a0', transactions: [] }
  }
  function handle(method, params) {
    state.methods.push(method)
    switch (method) {
      case 'eth_chainId': return '0x13b2'
      case 'eth_blockNumber': return toHex(++state.block)
      case 'eth_getBlockByNumber': return block(typeof params[0] === 'string' && params[0].startsWith('0x') && params[0] !== 'latest' ? BigInt(params[0]) : state.block)
      case 'eth_getStorageAt': return '0x' + '00'.repeat(32)
      case 'eth_getCode': return policy.sameAddress(params[0], policy.ARC_ROUTER) ? routerRuntime : policy.sameAddress(params[0], state.owner ?? '0x0000000000000000000000000000000000000001') ? '0x' : '0x6000'
      case 'eth_getBalance': return toHex(state.mode === 'low-balance' ? 1n : state.nativeBalance)
      case 'eth_gasPrice': return toHex(state.gasPrice)
      case 'eth_getTransactionCount': return toHex(params[1] === 'pending' ? state.nonce.pending : state.nonce.latest)
      case 'eth_estimateGas': return toHex(state.estimate ?? 100_000n)
      case 'eth_call': return call(params)
      case 'eth_getTransactionByHash': { const saved = state.txs.get(params[0].toLowerCase()); return saved ? saved.tx : null }
      case 'eth_getTransactionReceipt': { const saved = state.txs.get(params[0].toLowerCase()); return saved?.receipt ?? null }
      default: throw new Error(`unexpected_rpc_method:${method}`)
    }
  }
  return { state, handle, quoteOut, symbolOf, BLOCK_HASH, SIM }
}
