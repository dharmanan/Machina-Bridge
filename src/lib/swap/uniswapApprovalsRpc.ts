import { erc20Abi, parseAbi, type Hex } from 'viem'
import { ARC_PERMIT2, ARC_ROUTER, ARC_TOKENS, sameAddress, type ArcSymbol } from '../uniswapArcPolicy'
import { arcReadClient } from '../uniswapArcExecutionRpc'
import { ExecutionVerificationError } from '../uniswapArcExecution'
import { decodeApprovalTransaction, type ApprovalAttempt, type ApprovalChainResult, type ApprovalPorts, type ApprovalReads, type ApprovalTransaction } from './uniswapApprovals'

// Public-RPC reads for approvals: current allowances, a gas estimate against real state, the account nonce, and the verification of a
// sent approval (is it exactly the reviewed approval, and does the chain now hold exactly that allowance). Read-only.
const PERMIT_ALLOWANCE = parseAbi(['function allowance(address owner, address token, address spender) view returns (uint160 amount, uint48 expiration, uint48 nonce)'])
const isHash = (v: unknown): v is Hex => typeof v === 'string' && /^0x[a-f0-9]{64}$/i.test(v)

export function createApprovalRpc(rpc: typeof arcReadClient = arcReadClient): Pick<ApprovalPorts, 'reads' | 'estimate' | 'nonces' | 'result'> {
  return {
    async reads(owner, token: ArcSymbol): Promise<ApprovalReads> {
      if (token === 'USDC') throw new Error('not_needed')
      const blockNumber = await rpc.getBlockNumber({ cacheTime: 0 })
      const address = ARC_TOKENS[token].address as Hex
      const [block, balance, tokenAllowance, permit, nativeBalance, price] = await Promise.all([
        rpc.getBlock({ blockNumber }),
        rpc.readContract({ address, abi: erc20Abi, functionName: 'balanceOf', args: [owner], blockNumber }),
        rpc.readContract({ address, abi: erc20Abi, functionName: 'allowance', args: [owner, ARC_PERMIT2 as Hex], blockNumber }),
        rpc.readContract({ address: ARC_PERMIT2 as Hex, abi: PERMIT_ALLOWANCE, functionName: 'allowance', args: [owner, address, ARC_ROUTER as Hex], blockNumber }),
        rpc.getBalance({ address: owner, blockNumber }), rpc.getGasPrice(),
      ])
      const base = typeof block.baseFeePerGas === 'bigint' ? block.baseFeePerGas : 0n
      return { timestamp: block.timestamp, balance, tokenAllowance, permitAmount: permit[0], permitExpiration: BigInt(permit[1]), nativeBalance, gasPrice: price > base ? price : base }
    },
    async estimate(tx: ApprovalTransaction) { return rpc.estimateGas({ account: tx.from, to: tx.to, data: tx.data, value: 0n }) },
    async nonces(owner) {
      const before = await rpc.getTransactionCount({ address: owner, blockTag: 'latest' })
      const pending = await rpc.getTransactionCount({ address: owner, blockTag: 'pending' })
      const after = await rpc.getTransactionCount({ address: owner, blockTag: 'latest' })
      if (before !== after || pending < after) throw new Error('public_nonce')
      return { nonce: pending, latestNonce: after }
    },
    async result(attempt: ApprovalAttempt): Promise<ApprovalChainResult> {
      if (!isHash(attempt.hash)) throw new ExecutionVerificationError('binding', false)
      let tx
      try { tx = await rpc.getTransaction({ hash: attempt.hash }) }
      catch (error) {
        if (error instanceof Error && error.name === 'TransactionNotFoundError') return { status: 'pending', identified: false }
        throw new ExecutionVerificationError('rpc', true)
      }
      if (tx.hash.toLowerCase() !== attempt.hash.toLowerCase() || !sameAddress(tx.from, attempt.owner) || tx.chainId !== 5042 || tx.nonce !== attempt.nonce) throw new ExecutionVerificationError('binding', false)
      let receipt
      try { receipt = await rpc.getTransactionReceipt({ hash: attempt.hash }) }
      catch (error) {
        if (error instanceof Error && error.name === 'TransactionReceiptNotFoundError') return { status: 'pending', identified: true }
        throw new ExecutionVerificationError('rpc', true)
      }
      let latest
      try { latest = await rpc.getBlockNumber({ cacheTime: 0 }) } catch { throw new ExecutionVerificationError('rpc', true) }
      if (latest < receipt.blockNumber + 1n) return { status: 'pending', identified: true }
      const fee = receipt.gasUsed * receipt.effectiveGasPrice
      const ceiling = BigInt(attempt.networkFee)
      // Gas fields the wallet may adjust are judged by the approved fee ceiling; target, data, value and sender never.
      const decoded = decodeApprovalTransaction({ to: tx.to ?? '', data: tx.input, value: tx.value })
      const step = attempt.step
      const same = decoded !== null && decoded.kind === step.kind && decoded.token === step.token && sameAddress(decoded.spender, step.spender) && decoded.amount === step.amount && decoded.expiration === step.expiration
      const within = tx.input.toLowerCase() === attempt.transaction.data.toLowerCase() && sameAddress(tx.to ?? '', attempt.transaction.to) && tx.value === 0n && tx.gas * (tx.maxFeePerGas ?? 0n) <= ceiling && fee <= ceiling && receipt.gasUsed <= tx.gas
      let allowanceOk = false
      if (receipt.status === 'success') {
        const address = ARC_TOKENS[step.token].address as Hex
        try {
          if (step.kind === 'token') allowanceOk = (await rpc.readContract({ address, abi: erc20Abi, functionName: 'allowance', args: [attempt.owner as Hex, ARC_PERMIT2 as Hex], blockNumber: receipt.blockNumber })) === BigInt(step.amount)
          else { const permit = await rpc.readContract({ address: ARC_PERMIT2 as Hex, abi: PERMIT_ALLOWANCE, functionName: 'allowance', args: [attempt.owner as Hex, address, ARC_ROUTER as Hex], blockNumber: receipt.blockNumber }); allowanceOk = permit[0] === BigInt(step.amount) && permit[1] === step.expiration }
        } catch { throw new ExecutionVerificationError('rpc', true) }
      }
      return { status: 'settled', state: receipt.status === 'success' ? 'success' : 'reverted', fee: fee.toString(), blockNumber: receipt.blockNumber.toString(), bound: same && within, allowanceOk }
    },
  }
}
