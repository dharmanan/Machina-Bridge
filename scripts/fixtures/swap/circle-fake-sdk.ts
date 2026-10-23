// TEST DOUBLES for the Circle Swap Kit in the Chromium suite only. The real SDK talks to Circle's service over the network; this stands in
// for it: it asks the GUARDED wallet for the same steps the real SDK does (an exact approval or a permit signature, then the adapter swap),
// so the controller, the guard and the screen are exercised for real. Nothing here is trusted by the application.
import { encodeAbiParameters, encodeFunctionData, parseAbiParameters, parseUnits } from 'viem'
import { ADAPTER_ABI, CIRCLE_ADAPTER, CIRCLE_ADAPTER_CODEHASH, CIRCLE_ADAPTER_IMPLEMENTATION, CIRCLE_ADAPTER_IMPLEMENTATION_CODEHASH, CIRCLE_FEE_TARGET, CIRCLE_SWAP_EXECUTOR, PERMIT_TYPES, decodeAdapterExecute, encodeApprove } from '../../../src/lib/swap/circleAdapterDecode'
import { SWAP_SYMBOLS, swapToken } from '../../../src/lib/swap/tokens'

const ZERO = '0x0000000000000000000000000000000000000000'
interface FakeWallet { account: { address: `0x${string}` }; switchChain(p: { id: number }): Promise<void>; sendTransaction(p: Record<string, unknown>): Promise<string>; signTypedData(p: Record<string, unknown>): Promise<string> }
export function fakeCircleSdk(wallet: FakeWallet) {
  const kit = { async swap(params: { tokenIn: string; tokenOut: string; amountIn: string; config: { allowanceStrategy: string; stopLimit: string } }) {
    const who = wallet.account.address, nowSec = Math.floor(Date.now() / 1000)
    const symbolOf = (address: string) => SWAP_SYMBOLS.find(s => swapToken(s).address.toLowerCase() === address.toLowerCase())!
    const tokenIn = symbolOf(params.tokenIn), tokenOut = symbolOf(params.tokenOut), amountIn = parseUnits(params.amountIn, swapToken(tokenIn).decimals), minOut = parseUnits(params.config.stopLimit, swapToken(tokenOut).decimals)
    const inAddr = swapToken(tokenIn).address as `0x${string}`, outAddr = swapToken(tokenOut).address as `0x${string}`
    if (params.config.allowanceStrategy === 'approve') {
      await wallet.switchChain({ id: 5042 })
      const approval = await wallet.sendTransaction({ account: wallet.account, chain: { id: 5042 }, kzg: undefined, to: inAddr, data: encodeApprove(CIRCLE_ADAPTER, amountIn) })
      // Like the real SDK, wait until the approval is mined before asking for the swap.
      for (let attempt = 0; attempt < 240; attempt++) {
        const response = await fetch('https://rpc.mainnet.arc.io/', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_getTransactionReceipt', params: [approval] }) })
        if ((await response.json()).result) break
        await new Promise(resolve => setTimeout(resolve, 250))
      }
    } else {
      await wallet.signTypedData({ account: wallet.account, domain: { name: 'USDC', version: '2', chainId: 5042, verifyingContract: inAddr }, types: { Permit: PERMIT_TYPES }, primaryType: 'Permit',
        message: { owner: who, spender: CIRCLE_ADAPTER, value: amountIn, nonce: 0n, deadline: BigInt(nowSec + 3600) } })
    }
    await wallet.switchChain({ id: 5042 })
    const fee = amountIn / 5000n
    const instructions = [{ target: CIRCLE_FEE_TARGET, data: '0x7ebc46f0' + '00'.repeat(128), value: 0n, tokenIn: inAddr, amountToApprove: fee, tokenOut: ZERO, minTokenOut: 0n },
      { target: CIRCLE_SWAP_EXECUTOR, data: '0x4666fc80', value: 0n, tokenIn: inAddr, amountToApprove: amountIn - fee, tokenOut: outAddr, minTokenOut: minOut }]
    const permit = params.config.allowanceStrategy === 'permit'
      ? { permitType: 1, permitCalldata: encodeAbiParameters(parseAbiParameters('uint256 value, uint256 deadline, uint8 v, bytes32 r, bytes32 s'), [amountIn, BigInt(nowSec + 3600), 27, `0x${'11'.repeat(32)}`, `0x${'22'.repeat(32)}`]) }
      : { permitType: 0, permitCalldata: '0x' as `0x${string}` }
    const data = encodeFunctionData({ abi: ADAPTER_ABI, functionName: 'execute', args: [{ instructions, tokens: [{ token: inAddr, beneficiary: who }, { token: outAddr, beneficiary: who }], execId: 123n, deadline: BigInt(nowSec + 600), metadata: '0x' },
      [{ ...permit, token: inAddr, amount: amountIn }], `0x${'ab'.repeat(65)}`] as never })
    const txHash = await wallet.sendTransaction({ account: wallet.account, chain: { id: 5042 }, kzg: undefined, to: CIRCLE_ADAPTER, data, gas: 1_050_000n })
    return { txHash }
  } }
  return { kit, adapter: { wallet } }
}
// The real chain reads against the controlled RPC, except that the adapter's code hash and implementation are reported as the pinned ones (there is no real adapter code in a test RPC).
// The outcome simulation of the exact adapter calldata runs the real adapter, which a test RPC does not have (the hermetic Circle suite and the
// read-only live probe cover that path). The double reports what the controlled receipts of this suite also show: the minimum plus 0.5% received, the exact input spent.
export function fakeCircleChainRpc<T extends { preflight(review: never): Promise<Record<string, unknown>> }>(real: T): T {
  return { ...real,
    async preflight(review: never) { return { ...(await real.preflight(review)), adapterCodeHash: CIRCLE_ADAPTER_CODEHASH, adapterImplementation: CIRCLE_ADAPTER_IMPLEMENTATION, implementationCodeHash: CIRCLE_ADAPTER_IMPLEMENTATION_CODEHASH } },
    async simulate(_owner: `0x${string}`, data: `0x${string}`) {
      const decoded = decodeAdapterExecute(data); if (!decoded.ok) throw new Error('not an adapter swap')
      const swap = decoded.call.instructions.find(item => item.tokenOut !== ZERO)!, input = decoded.call.tokenInputs[0]
      return { received: (swap.minTokenOut * 1005n) / 1000n, spent: input.amount }
    } } as T
}
