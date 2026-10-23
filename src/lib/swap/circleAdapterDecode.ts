import { decodeAbiParameters, decodeFunctionData, encodeFunctionData, keccak256, parseAbi, type Hex } from 'viem'
import type { ChainObservation, ChainReceipt, ChainTx, IntentCheck, IntentReport, IntentStatus, IntentVerdict } from './transactionEvidence'
import { SWAP_SYMBOLS, swapToken } from './tokens'

// Circle Swap Kit executes through ONE pinned Adapter contract: `execute(params, tokenInputs, signature)`. The service signs `params`
// (instructions the adapter runs, residual recipients, execId, deadline); the application can neither build nor alter it, so it checks
// what it can: the pulled amount, who ends up with the funds, the minimum output and the deadline. The ABI below is the SDK's
// IAdapter.execute. Its shape was read from 384 real Arc Mainnet adapter transactions (2026-10-22), 165 USDC->EURC and 192 EURC->USDC among them:
//   tokenInputs : one entry, the input token and the exact amount (permitType 1 = EIP-2612 for USDC, 0 = pre-approved allowance)
//   instructions: one or two FEE instructions (target FEE, tokenIn = input, amountToApprove = fee, tokenOut = 0, minTokenOut = 0)
//                 then ONE swap instruction (target EXECUTOR, tokenIn = input, amountToApprove = the rest, tokenOut = output, minTokenOut)
//                 the approvals add up to exactly the input amount; every instruction carries value 0 (all of this is enforced)
//   tokens      : sweeps to the wallet: the input token, the output token and, for multi-hop routes, the intermediate token
//   deadline    : the service issues it about 600 s ahead (426-597 s before the block time in the sample)
export const CIRCLE_ADAPTER = '0x7FB8c7260b63934d8da38aF902f87ae6e284a845' as const
// keccak256 of the adapter's runtime bytecode on Arc Mainnet (813-byte proxy), read from eth_getCode on 2026-10-22.
export const CIRCLE_ADAPTER_CODEHASH = '0xa7bf56ff347a9755b51029c5e0e36b7e751ee85f595d121cf09ce24b3d4b11f8' as const
// The adapter is an upgradeable ERC-1967 proxy, so its own code says nothing about what runs. The implementation behind it (EIP-1967
// implementation slot) and that implementation's runtime code hash are pinned as well, read from Arc Mainnet on 2026-10-22 (block 27359135):
// an upgrade changes either value and closes Circle swaps (fail closed) until the new implementation has been reviewed.
export const CIRCLE_ADAPTER_IMPLEMENTATION_SLOT = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc' as const
export const CIRCLE_ADAPTER_IMPLEMENTATION = '0x3d99dd2ad6a35bc0e7d04cd14f57743a8cc82dd8' as const
export const CIRCLE_ADAPTER_IMPLEMENTATION_CODEHASH = '0x07c762f64cc564002b6371579f179f24a6a2e3cbbdf372e3a1f50025329c7b4d' as const
export const ADAPTER_EXECUTE_SELECTOR = '0xaa3e079c'
export const ERC20_APPROVE_SELECTOR = '0x095ea7b3'
// Circle's service issues 600 s deadlines (observed 590-592 s on real adapter transactions). 900 s leaves room for clock skew only.
export const MAX_DEADLINE_SECONDS = 900
// A wallet confirmation takes at least 30 s and the transaction must still be mined (15 s): a swap with less time left is not sent.
export const MIN_DEADLINE_SECONDS = 45
// The SDK signs EIP-2612 permits with a one-hour deadline (computeDefaultDeadline); the permit is for the exact amount and one use.
export const MAX_PERMIT_DEADLINE_SECONDS = 3720
// The two contracts every same-chain swap instruction on Arc Mainnet targets (381 and 376 of the 384 sampled adapter transactions; the other
// targets belong to Circle's Earn products). Any other target is refused: the service signature would still be valid, but the application
// never asked for such a route.
export const CIRCLE_FEE_TARGET = '0xf992EFCB5FA2eD7cB48310D9dd8Cb4ce5FB7DdC9' as const
export const CIRCLE_SWAP_EXECUTOR = '0xA4072583658Fae592A3506A42431cb6316a8d40b' as const
export const CIRCLE_INSTRUCTION_TARGETS: readonly string[] = [CIRCLE_FEE_TARGET, CIRCLE_SWAP_EXECUTOR]
// The exact shape of the two instruction kinds in every sampled real swap: the fee instruction calls the FEE target with this selector and a
// 4 + 4 x 32 byte argument block; the swap instruction calls the EXECUTOR with this selector (route data of varying length).
export const CIRCLE_FEE_SELECTOR = '0x7ebc46f0'
export const CIRCLE_FEE_DATA_BYTES = 132
export const CIRCLE_SWAP_SELECTOR = '0x4666fc80'
// Fee instructions together take at most this share of the input (sampled: 0.017 % to 0.27 %; one unit of a very small amount can be 0.64 %).
export const CIRCLE_MAX_FEE_BPS = 200n
// Real Circle swaps used a gas limit of 435,323 to 3,071,388 (median 1.05 M); the reviewed fee ceiling bounds the cost, this bounds malformed values.
export const CIRCLE_MAX_GAS_LIMIT = 4_000_000n
const MAX_INSTRUCTIONS = 8, MAX_TOKENS = 4, MAX_CALLDATA_CHARS = 65536
const ZERO = '0x0000000000000000000000000000000000000000'

export const ADAPTER_ABI = [{ type: 'function', name: 'execute', stateMutability: 'payable', inputs: [
  { name: 'params', type: 'tuple', components: [
    { name: 'instructions', type: 'tuple[]', components: [{ name: 'target', type: 'address' }, { name: 'data', type: 'bytes' }, { name: 'value', type: 'uint256' }, { name: 'tokenIn', type: 'address' }, { name: 'amountToApprove', type: 'uint256' }, { name: 'tokenOut', type: 'address' }, { name: 'minTokenOut', type: 'uint256' }] },
    { name: 'tokens', type: 'tuple[]', components: [{ name: 'token', type: 'address' }, { name: 'beneficiary', type: 'address' }] },
    { name: 'execId', type: 'uint256' }, { name: 'deadline', type: 'uint256' }, { name: 'metadata', type: 'bytes' }] },
  { name: 'tokenInputs', type: 'tuple[]', components: [{ name: 'permitType', type: 'uint8' }, { name: 'token', type: 'address' }, { name: 'amount', type: 'uint256' }, { name: 'permitCalldata', type: 'bytes' }] },
  { name: 'signature', type: 'bytes' }], outputs: [] }] as const
export const ERC20_APPROVE_ABI = parseAbi(['function approve(address spender, uint256 amount) returns (bool)'])
export const PERMIT_TYPES = [{ name: 'owner', type: 'address' }, { name: 'spender', type: 'address' }, { name: 'value', type: 'uint256' }, { name: 'nonce', type: 'uint256' }, { name: 'deadline', type: 'uint256' }]

const same = (a: unknown, b: string) => typeof a === 'string' && /^0x[0-9a-fA-F]{40}$/.test(a) && a.toLowerCase() === b.toLowerCase()
const lc = (value: string) => value.toLowerCase()

export interface AdapterInstruction { target: Hex; data: Hex; value: bigint; tokenIn: Hex; amountToApprove: bigint; tokenOut: Hex; minTokenOut: bigint }
export interface DecodedAdapterCall {
  instructions: AdapterInstruction[]; tokens: { token: Hex; beneficiary: Hex }[]; execId: bigint; deadline: bigint; metadata: Hex
  tokenInputs: { permitType: number; token: Hex; amount: bigint; permitCalldata: Hex }[]; signature: Hex
}
export type AdapterDecode = { ok: true; call: DecodedAdapterCall } | { ok: false; error: string }

export function decodeAdapterExecute(data: unknown): AdapterDecode {
  if (typeof data !== 'string' || !/^0x[0-9a-fA-F]+$/.test(data) || data.length > MAX_CALLDATA_CHARS) return { ok: false, error: 'invalid_calldata' }
  if (!lc(data).startsWith(ADAPTER_EXECUTE_SELECTOR)) return { ok: false, error: 'not_adapter_execute' }
  try {
    const { args } = decodeFunctionData({ abi: ADAPTER_ABI, data: data as Hex })
    // No trailing bytes and no alternative encoding of the same values: the bytes must be exactly the canonical encoding.
    if (lc(encodeFunctionData({ abi: ADAPTER_ABI, functionName: 'execute', args })) !== lc(data)) return { ok: false, error: 'noncanonical_calldata' }
    const [params, tokenInputs, signature] = args
    return { ok: true, call: { instructions: params.instructions.map(i => ({ ...i })), tokens: params.tokens.map(t => ({ ...t })), execId: params.execId, deadline: params.deadline, metadata: params.metadata,
      tokenInputs: tokenInputs.map(t => ({ ...t })), signature } }
  } catch { return { ok: false, error: 'undecodable_execute' } }
}
export function decodeApprove(data: unknown): { spender: Hex; amount: bigint } | null {
  if (typeof data !== 'string' || !/^0x[0-9a-fA-F]+$/.test(data) || data.length > 2 + 8 + 128) return null
  try {
    const { args } = decodeFunctionData({ abi: ERC20_APPROVE_ABI, data: data as Hex })
    if (lc(encodeFunctionData({ abi: ERC20_APPROVE_ABI, functionName: 'approve', args })) !== lc(data)) return null
    return { spender: args[0], amount: args[1] }
  } catch { return null }
}
export const encodeApprove = (spender: string, amount: bigint) => encodeFunctionData({ abi: ERC20_APPROVE_ABI, functionName: 'approve', args: [spender as Hex, amount] })

// What the user reviewed. `strategy` decides how the input token is authorised: a separate on-chain exact approval (default and the only
// one the controller uses) or an EIP-2612 permit that rides inside the swap transaction.
export interface CircleSwapIntent {
  owner: Hex; adapter: Hex; inputToken: Hex; outputToken: Hex; amountIn: bigint; minimumOut: bigint; strategy: 'approve' | 'permit'; chainId: number
  // The provider fee the Review showed, in input-token base units. The fee instructions of the transaction may not take more (a small rounding
  // allowance aside): a fee that is not in the Review is refused, however small. Without it only the generic share cap applies.
  maxFeeUnits?: bigint
}
export type SwapCheck = { ok: true; call: DecodedAdapterCall; instructions: number; feeUnits: bigint } | { ok: false; code: string; detail: string }
const deny = (code: string, detail: string): SwapCheck => ({ ok: false, code, detail })
const swapTokenAddresses = () => SWAP_SYMBOLS.map(symbol => swapToken(symbol).address as string)

// Independent check of the swap calldata. `send` runs in the guard before the wallet is contacted (`nowSeconds` = wall clock, the deadline must
// still leave time to be mined). `verify` runs against the chain (`nowSeconds` = block time: the adapter itself rejects a late transaction, so
// here the deadline only has to be consistent with the block it was included in).
export function checkSwapCalldata(data: unknown, intent: CircleSwapIntent, nowSeconds: number, mode: 'send' | 'verify' = 'send'): SwapCheck {
  const decoded = decodeAdapterExecute(data)
  if (!decoded.ok) return deny(decoded.error, 'The calldata is not a canonical Circle adapter execute call.')
  const { call } = decoded
  if (call.instructions.length < 2 || call.instructions.length > MAX_INSTRUCTIONS || call.tokens.length < 1 || call.tokens.length > MAX_TOKENS) return deny('shape', 'The instruction or token list has an unexpected size.')
  if (call.signature.length !== 132) return deny('shape', 'The service signature is not 65 bytes.')
  if (call.tokenInputs.length !== 1) return deny('token_inputs', 'Exactly one token input is expected.')
  const input = call.tokenInputs[0]
  if (!same(input.token, intent.inputToken) || input.amount !== intent.amountIn) return deny('input_amount', 'The token input is not the reviewed token and exact amount.')
  if (intent.strategy === 'approve' ? (input.permitType !== 0 || input.permitCalldata !== '0x') : input.permitType !== 1) return deny('permit_type', 'The token authorisation differs from the reviewed strategy.')
  if (intent.strategy === 'permit') {
    try {
      const [value, deadline] = decodeAbiParameters([{ type: 'uint256' }, { type: 'uint256' }, { type: 'uint8' }, { type: 'bytes32' }, { type: 'bytes32' }], input.permitCalldata)
      if (value !== intent.amountIn || (mode === 'send' && (deadline <= BigInt(nowSeconds) || deadline > BigInt(nowSeconds + MAX_PERMIT_DEADLINE_SECONDS)))) return deny('permit_value', 'The permit is not for the exact amount with a deadline of at most an hour.')
    } catch { return deny('permit_value', 'The permit calldata cannot be decoded.') }
  }
  let approved = 0n, fees = 0n, outputFloor = 0n, swaps = 0
  for (const instruction of call.instructions) {
    if (!CIRCLE_INSTRUCTION_TARGETS.some(target => same(instruction.target, target))) return deny('target_not_allowed', 'An instruction targets a contract that is not part of Circle\'s swap route.')
    if (instruction.value !== 0n) return deny('instruction_value', 'An instruction carries native value; ERC-20 swaps carry none.')
    if (!same(instruction.tokenIn, intent.inputToken)) return deny('instruction_token_in', 'An instruction approves a token other than the reviewed input token.')
    approved += instruction.amountToApprove
    if (same(instruction.tokenOut, ZERO)) {
      // A fee instruction: only the FEE contract, only its known call shape, no output.
      if (instruction.minTokenOut !== 0n) return deny('instruction_token_out', 'A fee instruction declares an output.')
      if (!same(instruction.target, CIRCLE_FEE_TARGET) || lc(instruction.data.slice(0, 10)) !== CIRCLE_FEE_SELECTOR || (instruction.data.length - 2) / 2 !== CIRCLE_FEE_DATA_BYTES) return deny('fee_instruction', 'A fee instruction does not have the known fee call shape.')
      fees += instruction.amountToApprove
      continue
    }
    if (!same(instruction.tokenOut, intent.outputToken) || !same(instruction.target, CIRCLE_SWAP_EXECUTOR)) return deny('instruction_token_out', 'An instruction targets a token other than the reviewed output token.')
    if (lc(instruction.data.slice(0, 10)) !== CIRCLE_SWAP_SELECTOR) return deny('swap_instruction', 'The swap instruction does not call the known swap entry point.')
    swaps++
    if (instruction.minTokenOut > outputFloor) outputFloor = instruction.minTokenOut
  }
  if (swaps !== 1) return deny('swap_instruction', 'Exactly one instruction must produce the reviewed output token.')
  // Every unit pulled in is accounted for: fees plus the swap. Nothing may be left unapproved (it would sit in the adapter), and the fee
  // instructions may not take a large share.
  if (approved !== intent.amountIn) return deny('approval_sum', 'The instructions do not approve exactly the reviewed amount of the input token.')
  if (fees * 10_000n > intent.amountIn * CIRCLE_MAX_FEE_BPS) return deny('fee_share', 'The fee instructions take a larger share of the input than Circle charges.')
  if (intent.maxFeeUnits !== undefined && fees > intent.maxFeeUnits + intent.maxFeeUnits / 100n + 1n) return deny('fee_share', 'The transaction takes a larger fee than the fee shown in the Review.')
  if (outputFloor === 0n || outputFloor < intent.minimumOut) return deny('min_output', 'No instruction guarantees the reviewed minimum output.')
  // The adapter sweeps every listed token to its beneficiary after the instructions: always the wallet itself. Multi-hop routes list their
  // intermediate token too, so any of the four swap tokens is acceptable as a residual.
  const known = swapTokenAddresses()
  for (const entry of call.tokens) {
    if (!same(entry.beneficiary, intent.owner)) return deny('beneficiary', 'A residual recipient is not the connected wallet.')
    if (!known.some(token => same(entry.token, token))) return deny('token_not_allowed', 'A residual token is not one of the swap tokens.')
  }
  if (!call.tokens.some(entry => same(entry.token, intent.outputToken))) return deny('beneficiary', 'The output token is not swept to the wallet.')
  // Whatever of the input token the route leaves behind is swept back as well.
  if (!call.tokens.some(entry => same(entry.token, intent.inputToken))) return deny('beneficiary', 'The input token is not swept back to the wallet.')
  if (call.deadline > BigInt(Number.MAX_SAFE_INTEGER)) return deny('deadline_passed', 'The swap deadline is not a valid time.')
  const remaining = Number(call.deadline) - nowSeconds
  if (mode === 'send' ? remaining < MIN_DEADLINE_SECONDS : remaining < 0) return deny('deadline_passed', mode === 'send' ? 'The swap deadline has passed or is about to.' : 'The transaction was included after its deadline.')
  if (remaining > MAX_DEADLINE_SECONDS) return deny('deadline_far', 'The swap deadline is further away than the service issues.')
  return { ok: true, call, instructions: call.instructions.length, feeUnits: fees }
}

// --- Comparison of an on-chain swap transaction with the Review ----------------------------------------------------------
export interface CircleReviewedIntent extends CircleSwapIntent {
  feeCeiling: bigint
  inputSymbol: string; inputDecimals: number; outputSymbol: string; outputDecimals: number
  // Known only when the application recorded them before the wallet request.
  nonce?: number; sentDataHash?: Hex
  // Network fees already charged by this attempt's verified approval transactions.
  approvalFees: bigint
  // The gas fields the application asked the wallet to use, when they were journaled. The wallet may legitimately replace them.
  planned?: { gas: bigint; maxFeePerGas: bigint; maxPriorityFeePerGas: bigint }
}
export interface CircleComparisonInput {
  attemptHash: Hex; tx: ChainTx; receipt: ChainReceipt | null; observation: ChainObservation
  reviewed: CircleReviewedIntent | null
  received: bigint | null // net output token gained by the owner
  sent: bigint | null     // net input token given up by the owner
}
const check = (id: string, label: string, status: IntentStatus, detail: string): IntentCheck => ({ id, label, status, detail })
const units = (value: bigint, decimals: number) => {
  const text = value.toString().padStart(decimals + 1, '0')
  const whole = text.slice(0, text.length - decimals), fraction = text.slice(text.length - decimals).replace(/0+$/, '')
  return fraction ? `${whole}.${fraction}` : whole
}
const gwei = (value: bigint) => `${units(value, 9)} gwei`
const usdc18 = (value: bigint) => `${units(value, 18)} USDC`

export function compareCircleSwap(input: CircleComparisonInput): IntentReport {
  const { tx, receipt, reviewed, observation } = input
  const checks: IntentCheck[] = [], differences: string[] = []
  const identity = lc(tx.hash) === lc(input.attemptHash) && (receipt === null || lc(receipt.transactionHash) === lc(input.attemptHash))
  if (!reviewed) {
    checks.push(check('identity', 'Transaction hash', identity ? 'match' : 'mismatch', identity ? 'The hash is the one recorded for this attempt.' : 'The transaction and receipt do not carry the recorded hash.'))
    return { verdict: identity ? 'no_review' : 'unbound', checks, differences: ['No stored Review is available for this transaction, so only the chain facts could be verified.'] }
  }
  const bound: [string, string, boolean, string][] = [
    ['identity', 'Transaction hash', identity, 'The recorded hash must match the transaction and its receipt.'],
    ['chain', 'Network', tx.chainId === reviewed.chainId, `Arc Mainnet ${reviewed.chainId} expected.`],
    ['sender', 'Sender', same(tx.from, reviewed.owner) && (receipt === null || same(receipt.from, reviewed.owner)), 'The transaction must come from the reviewed wallet.'],
    ...(reviewed.nonce === undefined ? [] : [['nonce', 'Nonce', tx.nonce === reviewed.nonce, `Recorded nonce ${reviewed.nonce}.`] as [string, string, boolean, string]]),
  ]
  for (const [id, label, ok, detail] of bound) checks.push(check(id, label, ok ? 'match' : 'mismatch', ok ? `${label} matches the Review.` : detail))
  if (bound.some(item => !item[2])) return { verdict: 'unbound', checks, differences: ['This hash does not identify the reviewed transaction (hash, sender, nonce or network differ).'] }

  const target = tx.to !== null && same(tx.to, reviewed.adapter) && (receipt === null || (receipt.to !== null && same(receipt.to, reviewed.adapter)))
  checks.push(check('adapter', 'Circle adapter', target ? 'match' : 'mismatch', target ? 'The transaction targets the pinned Circle adapter.' : 'The transaction does not target the pinned Circle adapter.'))
  if (!target) differences.push('The transaction was sent to a contract other than the pinned Circle adapter.')
  checks.push(check('type', 'Transaction type', tx.type === 'eip1559' ? 'match' : 'mismatch', tx.type === 'eip1559' ? 'EIP-1559.' : `Transaction type ${tx.type} is not EIP-1559.`))
  checks.push(check('value', 'Native value', tx.value === 0n ? 'match' : 'mismatch', tx.value === 0n ? 'No native value was sent.' : `Native value ${usdc18(tx.value)} was sent; an ERC-20 swap sends none.`))
  if (tx.value !== 0n) differences.push('Native value was sent with an ERC-20 swap.')

  const blockTime = observation.blockTimestamp === null ? null : Number(observation.blockTimestamp)
  const policy = blockTime === null ? null : checkSwapCalldata(tx.input, reviewed, blockTime, 'verify')
  if (policy === null) checks.push(check('calldata-policy', 'Calldata', 'unavailable', 'The block time could not be read, so the deadline cannot be judged.'))
  else if (policy.ok) checks.push(check('calldata-policy', 'Calldata', 'match', `The calldata pulls exactly the reviewed amount, guarantees at least the reviewed minimum and sweeps to the wallet (${policy.instructions} instruction${policy.instructions === 1 ? '' : 's'}).`))
  else { checks.push(check('calldata-policy', 'Calldata', 'mismatch', `${policy.detail} (${policy.code})`)); differences.push(policy.detail) }
  if (reviewed.sentDataHash === undefined) checks.push(check('calldata-binding', 'Calldata as sent', 'unavailable', 'The calldata the application allowed was not recorded, so it cannot be compared byte for byte.'))
  else if (lc(keccak256(tx.input)) === lc(reviewed.sentDataHash)) checks.push(check('calldata-binding', 'Calldata as sent', 'match', 'The on-chain calldata is byte-for-byte the calldata the application allowed.'))
  else { checks.push(check('calldata-binding', 'Calldata as sent', 'mismatch', 'The on-chain calldata differs from the calldata the application allowed to reach the wallet.')); differences.push('The wallet sent different calldata than the application allowed.') }

  const worst = tx.gas * tx.maxFeePerGas
  const feeOk = tx.gas > 0n && tx.gas <= CIRCLE_MAX_GAS_LIMIT && (receipt === null || tx.gas >= receipt.gasUsed) && tx.maxFeePerGas > 0n && tx.maxPriorityFeePerGas <= tx.maxFeePerGas && worst <= reviewed.feeCeiling
  const planned = reviewed.planned, sameFields = planned !== undefined && tx.gas === planned.gas && tx.maxFeePerGas === planned.maxFeePerGas && tx.maxPriorityFeePerGas === planned.maxPriorityFeePerGas
  if (sameFields && feeOk) checks.push(check('fee-fields', 'Gas fields', 'match', 'Gas limit and fee caps are the values the application asked the wallet to use.'))
  else checks.push(check('fee-fields', 'Gas fields', feeOk ? 'allowed' : 'mismatch', feeOk
    ? `The wallet chose gas limit ${tx.gas}, max fee ${gwei(tx.maxFeePerGas)}, priority fee ${gwei(tx.maxPriorityFeePerGas)}. Worst case ${usdc18(worst)} is within the reviewed fee ceiling ${usdc18(reviewed.feeCeiling)}.`
    : `The wallet's gas fields allow up to ${usdc18(worst)}, above the reviewed fee ceiling ${usdc18(reviewed.feeCeiling)}, or are malformed.`))
  if (!feeOk) differences.push('The transaction allowed a higher network fee than the reviewed ceiling.')
  if (receipt === null) return { verdict: checks.some(item => item.status === 'mismatch') ? 'mismatch' : 'incomplete', checks, differences }
  const consistent = receipt.gasUsed <= tx.gas && receipt.effectiveGasPrice <= tx.maxFeePerGas
  checks.push(check('receipt-consistency', 'Receipt consistency', consistent ? 'match' : 'mismatch', consistent ? 'Gas used and the effective price are within the limits the transaction set.' : 'The receipt reports more gas or a higher price than the transaction allowed.'))
  if (!consistent) differences.push('The receipt is inconsistent with the transaction it belongs to.')
  const swapFee = receipt.gasUsed * receipt.effectiveGasPrice, totalFee = swapFee + reviewed.approvalFees
  checks.push(check('fee-actual', 'Network fees charged', totalFee <= reviewed.feeCeiling ? 'match' : 'mismatch', `Charged ${usdc18(totalFee)} (swap ${usdc18(swapFee)}${reviewed.approvalFees > 0n ? `, approval ${usdc18(reviewed.approvalFees)}` : ''}); reviewed ceiling ${usdc18(reviewed.feeCeiling)}.`))
  if (totalFee > reviewed.feeCeiling) differences.push('The network fees charged exceed the reviewed ceiling.')

  if (receipt.status === 'reverted') checks.push(check('minimum', 'Minimum received', 'match', 'The transaction reverted, so nothing was received and no minimum applies.'))
  else if (input.received === null || input.sent === null) checks.push(check('minimum', 'Minimum received', 'unavailable', 'The token movements could not be read from the receipt.'))
  else {
    const ok = input.received >= reviewed.minimumOut
    checks.push(check('minimum', 'Minimum received', ok ? 'match' : 'mismatch', `Received ${units(input.received, reviewed.outputDecimals)} ${reviewed.outputSymbol}; the Review promised at least ${units(reviewed.minimumOut, reviewed.outputDecimals)}.`))
    if (!ok) differences.push(`The wallet received ${units(input.received, reviewed.outputDecimals)} ${reviewed.outputSymbol}, below the reviewed minimum ${units(reviewed.minimumOut, reviewed.outputDecimals)}.`)
    const spentOk = input.sent <= reviewed.amountIn
    checks.push(check('input-spent', 'Input spent', spentOk ? 'match' : 'mismatch', `Spent ${units(input.sent, reviewed.inputDecimals)} ${reviewed.inputSymbol}; the Review allowed ${units(reviewed.amountIn, reviewed.inputDecimals)}.`))
    if (!spentOk) differences.push(`More ${reviewed.inputSymbol} left the wallet than the reviewed amount.`)
  }
  const verdict: IntentVerdict = checks.some(item => item.status === 'mismatch') ? 'mismatch' : checks.some(item => item.status === 'unavailable') ? 'incomplete'
    : checks.some(item => item.status === 'allowed') ? 'verified_with_notes' : 'verified'
  return { verdict, checks, differences }
}
