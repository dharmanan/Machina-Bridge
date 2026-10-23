import { decodeFunctionResult, encodeAbiParameters, encodeFunctionData, keccak256, pad, parseAbiParameters, toHex, type Hex } from 'viem'
import { ARC_PERMIT2, ARC_ROUTER, ARC_TOKENS, type ArcSymbol } from '../uniswapArcPolicy'
import { arcReadClient } from '../uniswapArcExecutionRpc'
import { SIMULATOR_ABI, SIMULATOR_RUNTIME } from './simulatorCode'
import { OnchainQuoteError, SIMULATION_RECIPIENT, type OnchainPorts, type SimulationInput } from './uniswapOnchain'

// Read-only adapter for the keyless Uniswap quote. Every call is an eth_call/eth_getBlock/eth_getBalance/eth_getCode/eth_gasPrice on
// the public Arc RPC. A simulation runs the REAL Universal Router against the REAL pools inside state overrides that exist only for
// that one call: the helper contract's code, and a balance for it to trade with. Nothing is sent, signed or approved.
const CALLER: Hex = '0x00000000000000000000000000000000000abc01'
const SIMULATION_GAS = 0x4000000n
const BALANCE_MAPPING_SLOT = 9n // FiatToken balance mapping (EURC, cirBTC)
const WETH_BALANCES_SLOT = '0x52c63247e1f47db19d5ce0460030c497f067ca4cebf71ba98eeadabe20bace00' as const // OpenZeppelin v5 ERC20 namespaced storage
const SLOT_KEY = parseAbiParameters('address holder, uint256 slot'), SLOT_KEY_BYTES = parseAbiParameters('address holder, bytes32 slot')
const NATIVE_HEADROOM = 10n ** 18n

export interface StateOverride { address: Hex; code?: Hex; balance?: bigint; stateDiff?: { slot: Hex; value: Hex }[] }
// What the helper needs in order to trade: native balance for USDC (its ERC-20 face shares the native balance), a token balance slot otherwise.
export function simulationOverrides(tokenIn: ArcSymbol, amountIn: bigint): StateOverride[] {
  const overrides: StateOverride[] = [{ address: SIMULATION_RECIPIENT, code: SIMULATOR_RUNTIME as Hex, ...(tokenIn === 'USDC' ? { balance: amountIn * 10n ** 12n + NATIVE_HEADROOM } : {}) }]
  if (tokenIn !== 'USDC') {
    const slot = tokenIn === 'WETH' ? keccak256(encodeAbiParameters(SLOT_KEY_BYTES, [SIMULATION_RECIPIENT, WETH_BALANCES_SLOT])) : keccak256(encodeAbiParameters(SLOT_KEY, [SIMULATION_RECIPIENT, BALANCE_MAPPING_SLOT]))
    overrides.push({ address: ARC_TOKENS[tokenIn].address as Hex, stateDiff: [{ slot, value: pad(toHex(amountIn), { size: 32 }) }] })
  }
  return overrides
}
export function simulationCall(input: SimulationInput): Hex {
  const native = input.tokenIn === 'USDC'
  return encodeFunctionData({ abi: SIMULATOR_ABI, functionName: 'simulate', args: [
    ARC_ROUTER, input.data, native ? input.amountIn * 10n ** 12n : 0n, ARC_TOKENS[input.tokenIn].address as Hex, ARC_TOKENS[input.tokenOut].address as Hex,
    native ? '0x0000000000000000000000000000000000000000' : ARC_PERMIT2, native ? 0n : input.amountIn] })
}

function describe(error: unknown): { revert: boolean; rateLimited: boolean } {
  const seen = new Set<unknown>(); let revert = false, rateLimited = false
  for (let e: unknown = error, i = 0; e && typeof e === 'object' && !seen.has(e) && i < 8; i++) {
    seen.add(e)
    const { name, code, message, status } = e as { name?: unknown; code?: unknown; message?: unknown; status?: unknown }
    if (name === 'ExecutionRevertedError' || name === 'ContractFunctionRevertedError' || code === 3 || (typeof message === 'string' && /execution reverted|revert/i.test(message) && code !== -32005)) revert = true
    if (code === -32005 || status === 429) rateLimited = true
    e = (e as { cause?: unknown }).cause
  }
  return { revert: revert && !rateLimited, rateLimited }
}
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

export function createOnchainPorts(rpc: typeof arcReadClient = arcReadClient, now: () => number = () => Date.now(), pause: (ms: number) => Promise<unknown> = sleep): OnchainPorts {
  async function withBackoff<T>(run: () => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try { return await run() } catch (error) {
        const kind = describe(error)
        if (kind.revert) throw new Error('reverted')
        if (!kind.rateLimited || attempt >= 3) throw new OnchainQuoteError('rpc_unavailable')
        await pause(400 * (attempt + 1))
      }
    }
  }
  return {
    now,
    async chain(owner) {
      const blockNumber = await withBackoff(() => rpc.getBlockNumber({ cacheTime: 0 }))
      const [block, code, balance, price] = await withBackoff(() => Promise.all([
        rpc.getBlock({ blockNumber }), rpc.getCode({ address: ARC_ROUTER, blockNumber }), rpc.getBalance({ address: owner as Hex, blockNumber }), rpc.getGasPrice()]))
      const base = typeof block.baseFeePerGas === 'bigint' ? block.baseFeePerGas : 0n
      return { blockNumber, timestamp: block.timestamp, gasPrice: price > base ? price : base, nativeBalance: balance, routerHash: code && code !== '0x' ? keccak256(code) : '0x' }
    },
    async simulate(input) {
      const result = await withBackoff(() => rpc.call({ account: CALLER, to: SIMULATION_RECIPIENT, data: simulationCall(input), gas: SIMULATION_GAS, stateOverride: simulationOverrides(input.tokenIn, input.amountIn) }))
      if (!result.data) throw new Error('reverted')
      const out = decodeFunctionResult({ abi: SIMULATOR_ABI, functionName: 'simulate', data: result.data }) as { inBefore: bigint; inAfter: bigint; outBefore: bigint; outAfter: bigint; gasUsed: bigint }
      if (out.outAfter < out.outBefore || out.inBefore < out.inAfter) throw new Error('reverted')
      return { received: out.outAfter - out.outBefore, spent: out.inBefore - out.inAfter, gas: out.gasUsed }
    },
  }
}
