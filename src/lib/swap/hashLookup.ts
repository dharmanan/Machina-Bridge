import { formatUnits, type Hex } from 'viem'
import { ARC_ROUTER, ARC_TOKENS, sameAddress, type ArcSymbol } from '../uniswapArcPolicy'
import { arcReadClient } from '../uniswapArcExecutionRpc'
import { decodeAdapterExecute, CIRCLE_ADAPTER } from './circleAdapterDecode'
import { decodeUniversalRouterCalldata } from './universalRouter'
import { ownerFlows, type ChainLog, type ChainReceipt } from './transactionEvidence'

// Read-only look-up of ANY transaction hash on Arc, for when the stored Review of a transaction is missing (cleared browser data, another
// device). It reports only what the chain proves and says plainly what could not be checked. It never reconstructs a Review, never marks a
// transaction Confirmed, stores nothing and asks no wallet for anything.
export interface HashInspection {
  hash: Hex
  state: 'invalid' | 'not_found' | 'pending' | 'success' | 'reverted' | 'unreadable'
  final: boolean
  from?: Hex; to?: Hex | null; nonce?: number; blockNumber?: string; fee?: string
  // What the sender's wallet gained and lost in the four Swap tokens (6/8/18-decimal units formatted by symbol).
  flows: { symbol: ArcSymbol; received: string; sent: string }[]
  nativeValue?: string
  program: { kind: 'uniswap-router' | 'circle-adapter' | 'other-contract' | 'none'; summary: string; thirdPartyPortions: string[] }
  notRechecked: string[]
}
const HASH = /^0x[0-9a-fA-F]{64}$/
const NO_REVIEW = 'No stored Review record was found for this transaction, so it cannot be compared with anything you approved. Only the chain facts below are verified.'

export async function inspectHash(hashInput: string, rpc: typeof arcReadClient = arcReadClient): Promise<HashInspection> {
  const empty = { flows: [], program: { kind: 'none' as const, summary: '', thirdPartyPortions: [] }, notRechecked: [NO_REVIEW] }
  if (!HASH.test(hashInput.trim())) return { hash: hashInput as Hex, state: 'invalid', final: false, ...empty }
  const hash = hashInput.trim() as Hex
  let tx
  try { tx = await rpc.getTransaction({ hash }) }
  catch (error) { return { hash, state: error instanceof Error && error.name === 'TransactionNotFoundError' ? 'not_found' : 'unreadable', final: false, ...empty } }
  if (tx.chainId !== 5042) return { hash, state: 'unreadable', final: false, ...empty, notRechecked: [NO_REVIEW, 'The transaction is not on Arc Mainnet (5042).'] }
  let receipt
  try { receipt = await rpc.getTransactionReceipt({ hash }) }
  catch (error) { return { hash, state: error instanceof Error && error.name === 'TransactionReceiptNotFoundError' ? 'pending' : 'unreadable', final: false, from: tx.from, to: tx.to ?? null, nonce: tx.nonce, ...empty } }
  let latest: bigint
  try { latest = await rpc.getBlockNumber({ cacheTime: 0 }) } catch { return { hash, state: 'unreadable', final: false, ...empty } }
  const chainReceipt: ChainReceipt = { transactionHash: receipt.transactionHash, from: receipt.from, to: receipt.to ?? null, status: receipt.status === 'success' ? 'success' : 'reverted', blockNumber: receipt.blockNumber,
    blockHash: receipt.blockHash, transactionIndex: receipt.transactionIndex, gasUsed: receipt.gasUsed, effectiveGasPrice: receipt.effectiveGasPrice, logs: receipt.logs as unknown as readonly ChainLog[] }
  const symbols = Object.keys(ARC_TOKENS) as ArcSymbol[]
  const flows = receipt.status === 'success' ? ownerFlows(chainReceipt, tx.from, symbols.map(symbol => ARC_TOKENS[symbol].address)) : null
  const program: HashInspection['program'] = { kind: 'none', summary: 'A plain transfer or call that this application does not recognise.', thirdPartyPortions: [] }
  const notRechecked = [NO_REVIEW]
  if (tx.to && sameAddress(tx.to, ARC_ROUTER)) {
    const decoded = decodeUniversalRouterCalldata(tx.input)
    if (decoded.ok) {
      program.kind = 'uniswap-router'; program.summary = `Uniswap Universal Router: ${decoded.program.signature}`
      program.thirdPartyPortions = decoded.program.portions.filter(portion => !sameAddress(portion.recipient, tx.from)).map(portion => `${Number(portion.bips) / 100}% of the output to ${portion.recipient}`)
      if (program.thirdPartyPortions.length) notRechecked.push('The calldata sends a fee portion to a third party. This application never prepares such a transaction.')
    } else { program.kind = 'uniswap-router'; program.summary = 'Uniswap Universal Router call this application could not decode.' }
  } else if (tx.to && sameAddress(tx.to, CIRCLE_ADAPTER)) {
    const decoded = decodeAdapterExecute(tx.input)
    program.kind = 'circle-adapter'; program.summary = decoded.ok ? `Circle Swap Kit adapter call with ${decoded.call.instructions.length} instructions.` : 'Circle adapter call this application could not decode.'
  } else if (tx.to) { program.kind = 'other-contract'; program.summary = `A call to ${tx.to}, which is not a contract this application swaps through.` }
  return {
    hash, state: receipt.status === 'success' ? 'success' : 'reverted', final: latest >= receipt.blockNumber + 1n, from: tx.from, to: tx.to ?? null, nonce: tx.nonce, blockNumber: receipt.blockNumber.toString(),
    fee: (receipt.gasUsed * receipt.effectiveGasPrice).toString(), nativeValue: tx.value > 0n ? tx.value.toString() : undefined,
    flows: flows && flows.ok ? symbols.flatMap(symbol => { const f = flows.flows.get(ARC_TOKENS[symbol].address.toLowerCase()); return f && (f.received > 0n || f.sent > 0n) ? [{ symbol, received: formatUnits(f.received, ARC_TOKENS[symbol].decimals), sent: formatUnits(f.sent, ARC_TOKENS[symbol].decimals) }] : [] }) : [],
    program, notRechecked: flows && !flows.ok ? [...notRechecked, 'The receipt logs could not be read consistently, so no token amounts are shown.'] : notRechecked,
  }
}
