// Synthetic fresh copies of the original uploaded bytes, for controlled tests only.
const { readFileSync } = require('node:fs')
const { resolve } = require('node:path')
const { decodeFunctionData, encodeFunctionData, decodeAbiParameters, encodeAbiParameters } = require('viem')
const p = require('../../../src/lib/uniswapArcPolicy.ts')
module.exports = function freshExecutionReview(request, now = Date.now()) {
  const original = JSON.parse(readFileSync(resolve(__dirname, `USDC-${request.tokenOut}.json`), 'utf8'))
  const raw = JSON.parse(JSON.stringify(original).replace(new RegExp(original.swapTransaction.from.slice(2), 'ig'), request.owner.slice(2)))
  const outer = decodeFunctionData({ abi: p.EXECUTE_ABI, data: raw.swapTransaction.data })
  const canonical = encodeFunctionData({ abi: p.EXECUTE_ABI, functionName: 'execute', args: outer.args })
  const suffix = raw.swapTransaction.data.slice(canonical.length), amount = p.usdcAmount(request.amount)
  const output = BigInt(raw.quote.output.amount) * amount / 1000000n, minimum = p.minimumAtSlippage(output, request.slippageBps)
  const inputs = [...outer.args[1]]
  if (request.tokenOut === 'EURC') {
    const [actions, params] = decodeAbiParameters(p.V4_ENVELOPE, inputs[0]), updated = [...params]
    const [swap] = decodeAbiParameters(p.V4_PATH, params[0])
    updated[0] = encodeAbiParameters(p.V4_PATH, [{ ...swap, amountIn: amount, amountOutMinimum: minimum }])
    inputs[0] = encodeAbiParameters(p.V4_ENVELOPE, [actions, updated])
  } else {
    const values = [...decodeAbiParameters(p.V3_INPUT, inputs[0])]; values[1] = amount; values[2] = minimum
    inputs[0] = encodeAbiParameters(p.V3_INPUT, values)
  }
  raw.swapTransaction.data = encodeFunctionData({ abi: p.EXECUTE_ABI, functionName: 'execute', args: [outer.args[0], inputs, BigInt(Math.floor(now / 1000) + 120)] }) + suffix
  raw.swapTransaction.value = p.nativeAmount(request.amount).toString()
  return { request: p.validateArcRequest(request), transaction: raw.swapTransaction, estimatedOutput: output.toString(), requiredMinimum: minimum.toString(),
    requestStartedAt: now, expiresAt: now + 30000, routerHash: p.ARC_ROUTER_HASH, blockNumber: '27114546', gasLimit: '130000',
    maxFeePerGas: '2000000000', maxPriorityFeePerGas: '0', networkFee: '260000000000000', nativeBalance: '100000000000000000000',
    simulation: 'passed', writesEnabled: false, executionBound: false, quoteId: raw.quote.quoteId }
}
