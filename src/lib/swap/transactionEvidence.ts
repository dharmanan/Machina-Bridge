import { keccak256, type Hex } from 'viem'
import { sameAddress } from '../uniswapArcPolicy'
import { decodeUniversalRouterCalldata, describeProgramDifferences, guaranteedNetMinimum, type RouterDecode } from './universalRouter'

// Provider-neutral evidence about ONE on-chain transaction, kept apart from the question "did it match the Review?".
//   chain fact    : what the network says (status, block, gas, fee, token movements of the owner)
//   intent report : how that transaction compares with the Review the user approved
// A transaction can be a chain success and still fail the intent comparison (for example a wallet that rewrote the calldata).
// Neither answer is ever derived from the other, and a failed intent comparison never turns a success into a failure.

export const NATIVE_TRANSFER_EMITTER = '0xfffffffffffffffffffffffffffffffffffffffe'
export const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'
export const MAX_GAS_LIMIT = 2_000_000n

export interface ChainTx {
  hash: Hex; from: Hex; to: Hex | null; chainId: number; nonce: number; type: string
  value: bigint; gas: bigint; maxFeePerGas: bigint; maxPriorityFeePerGas: bigint; input: Hex
}
export interface ChainLog {
  address: Hex; topics: readonly (Hex | null)[]; data: Hex; logIndex: number | null; removed: boolean
  transactionHash: Hex | null; blockHash: Hex | null; blockNumber: bigint | null; transactionIndex: number | null
}
export interface ChainReceipt {
  transactionHash: Hex; from: Hex; to: Hex | null; status: 'success' | 'reverted'; blockNumber: bigint; blockHash: Hex
  transactionIndex: number; gasUsed: bigint; effectiveGasPrice: bigint; logs: readonly ChainLog[]
}
// What the application observed around the receipt. `canonical` = the block at that height still has the receipt's hash.
export interface ChainObservation { canonical: boolean; latestBlock: bigint; blockTimestamp: bigint | null }

export type IntentStatus = 'match' | 'allowed' | 'mismatch' | 'unavailable'
export interface IntentCheck { id: string; label: string; status: IntentStatus; detail: string }
// verified            every reviewed field matches and the result is inside the reviewed limits
// verified_with_notes only wallet-adjustable fee fields differ, all inside the approved fee ceiling
// mismatch            the transaction is not what was reviewed (calldata, value, target, limits or result)
// incomplete          some evidence is missing (for example the block time); nothing is claimed
// unbound             the hash does not identify the attempt (other sender, nonce or network)
// no_review           there is no stored Review to compare against
export type IntentVerdict = 'verified' | 'verified_with_notes' | 'mismatch' | 'incomplete' | 'unbound' | 'no_review'
export interface IntentReport { verdict: IntentVerdict; checks: IntentCheck[]; differences: string[] }

export interface ReviewedIntent {
  owner: Hex; recipient: Hex; router: Hex; chainId: number; nonce: number
  value: bigint; calldata: Hex
  gasLimit: bigint; maxFeePerGas: bigint; maxPriorityFeePerGas: bigint; feeCeiling: bigint
  outputToken: Hex; requiredMinimum: bigint
  // Token symbols/decimals only for readable messages.
  outputSymbol: string; outputDecimals: number
}

export interface TokenFlow { token: Hex; received: bigint; sent: bigint; net: bigint }
export type FlowResult = { ok: true; flows: Map<string, TokenFlow>; nativeRefund: bigint } | { ok: false; reason: string }

const lc = (value: string) => value.toLowerCase()
const topicAddress = (topic: string | null | undefined): Hex | null => (typeof topic === 'string' && /^0x0{24}[0-9a-fA-F]{40}$/.test(topic) ? (`0x${topic.slice(-40)}` as Hex) : null)

// Owner-relative token movements from the receipt. A log that claims to be a Transfer of a token the caller asked about must be
// complete and belong to this exact transaction and block; anything else makes the whole result unusable, never partially used.
export function ownerFlows(receipt: ChainReceipt, owner: string, tokens: readonly string[]): FlowResult {
  const wanted = new Set(tokens.map(lc))
  const flows = new Map<string, TokenFlow>()
  for (const token of wanted) flows.set(token, { token: token as Hex, received: 0n, sent: 0n, net: 0n })
  const seen = new Set<string>()
  let nativeRefund = 0n
  for (const log of receipt.logs) {
    const emitter = lc(log.address)
    const isNative = emitter === NATIVE_TRANSFER_EMITTER
    if (!isNative && !wanted.has(emitter)) continue
    if (lc(log.topics[0] ?? '') !== TRANSFER_TOPIC) continue
    if (log.removed || lc(log.transactionHash ?? '') !== lc(receipt.transactionHash) || lc(log.blockHash ?? '') !== lc(receipt.blockHash) ||
      log.blockNumber !== receipt.blockNumber || log.transactionIndex !== receipt.transactionIndex || log.logIndex === null || !Number.isSafeInteger(log.logIndex) ||
      log.logIndex < 0 || log.topics.length !== 3 || !/^0x[0-9a-fA-F]{64}$/.test(log.data)) return { ok: false, reason: 'malformed_transfer_log' }
    const identity = `${emitter}:${log.logIndex}`
    if (seen.has(identity)) return { ok: false, reason: 'duplicate_log_index' }
    seen.add(identity)
    const from = topicAddress(log.topics[1]), to = topicAddress(log.topics[2])
    if (!from || !to) return { ok: false, reason: 'malformed_transfer_log' }
    const amount = BigInt(log.data)
    if (isNative) { if (sameAddress(to, owner)) nativeRefund += amount; continue }
    const flow = flows.get(emitter)!
    if (sameAddress(to, owner)) flow.received += amount
    if (sameAddress(from, owner)) flow.sent += amount
    flow.net = flow.received - flow.sent
  }
  return { ok: true, flows, nativeRefund }
}

export interface ComparisonInput {
  attemptHash: Hex
  tx: ChainTx
  receipt: ChainReceipt
  observation: ChainObservation
  reviewed: ReviewedIntent | null
  // Net amount of the reviewed output token the owner gained in this transaction (from ownerFlows), or null when unavailable.
  received: bigint | null
}
const check = (id: string, label: string, status: IntentStatus, detail: string): IntentCheck => ({ id, label, status, detail })
const units = (value: bigint, decimals: number) => {
  const text = value.toString().padStart(decimals + 1, '0')
  const whole = text.slice(0, text.length - decimals), fraction = text.slice(text.length - decimals).replace(/0+$/, '')
  return fraction ? `${whole}.${fraction}` : whole
}
const gwei = (value: bigint) => `${units(value, 9)} gwei`
const usdc18 = (value: bigint) => `${units(value, 18)} USDC`

// Compares an on-chain transaction with the Review it should have come from. Wallet-adjustable gas fields are judged by the fee
// ceiling the user actually approved (gas limit x max fee per gas must not exceed it), not by byte equality: wallets legitimately
// replace the suggested priority fee and gas limit. Calldata, value, target, sender, nonce and chain are never adjustable.
export function compareToReview(input: ComparisonInput): IntentReport {
  const { tx, receipt, reviewed, observation } = input
  const checks: IntentCheck[] = []
  const identity = lc(tx.hash) === lc(input.attemptHash) && lc(receipt.transactionHash) === lc(input.attemptHash)
  if (!reviewed) {
    checks.push(check('identity', 'Transaction hash', identity ? 'match' : 'mismatch', identity ? 'The hash is the one recorded for this attempt.' : 'The transaction and receipt do not carry the recorded hash.'))
    return { verdict: identity ? 'no_review' : 'unbound', checks, differences: ['No stored Review is available for this transaction, so only the chain facts could be verified.'] }
  }
  // Binding: these identify the attempt. If any fails this transaction is not the reviewed one at all.
  const bound: [string, string, boolean, string][] = [
    ['identity', 'Transaction hash', identity, 'The recorded hash must match the transaction and its receipt.'],
    ['chain', 'Network', tx.chainId === reviewed.chainId, `Arc Mainnet ${reviewed.chainId} expected.`],
    ['sender', 'Sender', sameAddress(tx.from, reviewed.owner) && sameAddress(receipt.from, reviewed.owner), 'The transaction must come from the reviewed wallet.'],
    ['nonce', 'Nonce', tx.nonce === reviewed.nonce, `Reviewed nonce ${reviewed.nonce}.`],
  ]
  for (const [id, label, ok, detail] of bound) checks.push(check(id, label, ok ? 'match' : 'mismatch', ok ? `${label} matches the Review.` : detail))
  if (bound.some(item => !item[2])) return { verdict: 'unbound', checks, differences: ['This hash does not identify the reviewed transaction (hash, sender, nonce or network differ).'] }

  const differences: string[] = []
  const target = tx.to !== null && sameAddress(tx.to, reviewed.router) && receipt.to !== null && sameAddress(receipt.to, reviewed.router)
  checks.push(check('router', 'Router', target ? 'match' : 'mismatch', target ? 'The transaction targets the reviewed Universal Router.' : 'The transaction does not target the reviewed router.'))
  if (!target) differences.push('The transaction was sent to a different contract than the reviewed router.')
  checks.push(check('type', 'Transaction type', tx.type === 'eip1559' ? 'match' : 'mismatch', tx.type === 'eip1559' ? 'EIP-1559 as reviewed.' : `Transaction type ${tx.type} differs from the reviewed EIP-1559 transaction.`))
  checks.push(check('value', 'Native value', tx.value === reviewed.value ? 'match' : 'mismatch', tx.value === reviewed.value ? `Value ${usdc18(tx.value)} as reviewed.` : `Value ${usdc18(tx.value)} differs from the reviewed ${usdc18(reviewed.value)}.`))
  if (tx.value !== reviewed.value) differences.push('The native value sent differs from the reviewed value.')

  // Calldata: exact bytes, or an explained difference.
  if (lc(tx.input) === lc(reviewed.calldata)) checks.push(check('calldata', 'Calldata', 'match', 'The calldata is byte-for-byte the reviewed calldata.'))
  else {
    const explained = describeProgramDifferences(decodeUniversalRouterCalldata(reviewed.calldata), decodeUniversalRouterCalldata(tx.input))
    differences.push(...explained)
    checks.push(check('calldata', 'Calldata', 'mismatch', `The calldata differs from the Review. ${explained[0] ?? ''}`.trim()))
  }

  // Fee fields the wallet may adjust.
  const worst = tx.gas * tx.maxFeePerGas
  const sameFields = tx.gas === reviewed.gasLimit && tx.maxFeePerGas === reviewed.maxFeePerGas && tx.maxPriorityFeePerGas === reviewed.maxPriorityFeePerGas
  const feeOk = tx.gas > 0n && tx.gas <= MAX_GAS_LIMIT && tx.gas >= receipt.gasUsed && tx.maxFeePerGas > 0n && tx.maxPriorityFeePerGas <= tx.maxFeePerGas && worst <= reviewed.feeCeiling
  if (sameFields) checks.push(check('fee-fields', 'Gas fields', 'match', 'Gas limit and fee caps are the reviewed values.'))
  else if (feeOk) checks.push(check('fee-fields', 'Gas fields', 'allowed',
    `The wallet adjusted gas fields: limit ${tx.gas} (reviewed ${reviewed.gasLimit}), max fee ${gwei(tx.maxFeePerGas)} (reviewed ${gwei(reviewed.maxFeePerGas)}), priority fee ${gwei(tx.maxPriorityFeePerGas)} (reviewed ${gwei(reviewed.maxPriorityFeePerGas)}). Worst case ${usdc18(worst)} is within the approved ceiling ${usdc18(reviewed.feeCeiling)}.`))
  else {
    checks.push(check('fee-fields', 'Gas fields', 'mismatch', `The wallet's gas fields allow up to ${usdc18(worst)}, above the approved ceiling ${usdc18(reviewed.feeCeiling)}, or are malformed.`))
    differences.push('The transaction allowed a higher network fee than the approved ceiling.')
  }
  // A receipt can never report more gas than the limit or a higher price than the cap the transaction allowed.
  const consistent = receipt.gasUsed <= tx.gas && receipt.effectiveGasPrice <= tx.maxFeePerGas
  checks.push(check('receipt-consistency', 'Receipt consistency', consistent ? 'match' : 'mismatch', consistent ? 'Gas used and the effective gas price are within the limits the transaction set.' : 'The receipt reports more gas or a higher price than the transaction allowed.'))
  if (!consistent) differences.push('The receipt is inconsistent with the transaction it belongs to.')
  const actualFee = receipt.gasUsed * receipt.effectiveGasPrice
  checks.push(check('fee-actual', 'Network fee charged', actualFee <= reviewed.feeCeiling ? 'match' : 'mismatch', `Charged ${usdc18(actualFee)}; approved ceiling ${usdc18(reviewed.feeCeiling)}.`))
  if (actualFee > reviewed.feeCeiling) differences.push('The network fee charged exceeds the approved ceiling.')

  // Deadline versus the block time. The router enforces it on chain; this only confirms the evidence is consistent.
  const decoded: RouterDecode = decodeUniversalRouterCalldata(tx.input)
  if (!decoded.ok || observation.blockTimestamp === null) checks.push(check('deadline', 'Deadline', 'unavailable', 'The deadline or the block time could not be read.'))
  else checks.push(check('deadline', 'Deadline', observation.blockTimestamp <= decoded.program.deadline ? 'match' : 'mismatch',
    observation.blockTimestamp <= decoded.program.deadline ? 'Included before the transaction deadline.' : 'Included after the transaction deadline.'))

  // Result for the reviewed output token. Only a successful transaction is judged against the minimum.
  if (receipt.status === 'reverted') checks.push(check('minimum', 'Minimum received', 'match', 'The transaction reverted, so nothing was received and no minimum applies.'))
  else if (input.received === null) checks.push(check('minimum', 'Minimum received', 'unavailable', 'The amount received could not be read from the receipt.'))
  else {
    const ok = input.received >= reviewed.requiredMinimum
    checks.push(check('minimum', 'Minimum received', ok ? 'match' : 'mismatch',
      `Received ${units(input.received, reviewed.outputDecimals)} ${reviewed.outputSymbol}; the Review promised at least ${units(reviewed.requiredMinimum, reviewed.outputDecimals)}.`))
    if (!ok) differences.push(`The wallet received ${units(input.received, reviewed.outputDecimals)} ${reviewed.outputSymbol}, below the reviewed minimum ${units(reviewed.requiredMinimum, reviewed.outputDecimals)}.`)
  }
  if (decoded.ok && receipt.status === 'success') {
    const net = guaranteedNetMinimum(decoded.program)
    if (net !== null && decoded.program.portions.length > 0 && net < reviewed.requiredMinimum) differences.push(`After its fee portions the on-chain program only guarantees ${units(net, reviewed.outputDecimals)} ${reviewed.outputSymbol}, below the reviewed minimum.`)
  }

  const verdict: IntentVerdict = checks.some(item => item.status === 'mismatch') ? 'mismatch'
    : checks.some(item => item.status === 'unavailable') ? 'incomplete'
      : checks.some(item => item.status === 'allowed') ? 'verified_with_notes' : 'verified'
  return { verdict, checks, differences }
}

// Short, bounded form for local storage and display.
export interface IntentSummary { verdict: IntentVerdict; checks: { id: string; status: IntentStatus; detail: string }[]; differences: string[]; checkedAt: number }
export function summarizeIntent(report: IntentReport, checkedAt: number): IntentSummary {
  const clip = (text: string) => (text.length > 400 ? `${text.slice(0, 397)}...` : text)
  return { verdict: report.verdict, checks: report.checks.slice(0, 24).map(item => ({ id: item.id, status: item.status, detail: clip(item.detail) })), differences: report.differences.slice(0, 8).map(clip), checkedAt }
}

export interface ChainSummary {
  state: 'success' | 'reverted'; blockNumber: string; blockHash: string; gasUsed: string; effectiveGasPrice: string; fee: string
  received: string | null; sent: string | null; checkedAt: number
}
export const programHash = (data: Hex) => keccak256(data)
