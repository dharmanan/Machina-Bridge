import { decodeAbiParameters, decodeFunctionData, encodeAbiParameters, encodeFunctionData, formatUnits, recoverTypedDataAddress, type Hex } from 'viem'
import { ARC_PERMIT2, ARC_ROUTER, ARC_TOKENS, EXECUTE_ABI, sameAddress, tokenUnits, type ArcReview } from '../uniswapArcPolicy'
import { decodeRouteProgram } from './uniswapRouteProgram'

// Only AllowanceTransfer PermitSingle on the pinned Arc router. Signatures live in memory, never in the journal.
export const PERMIT_SINGLE_TYPES = {
  PermitDetails: [{ name: 'token', type: 'address' }, { name: 'amount', type: 'uint160' }, { name: 'expiration', type: 'uint48' }, { name: 'nonce', type: 'uint48' }],
  PermitSingle: [{ name: 'details', type: 'PermitDetails' }, { name: 'spender', type: 'address' }, { name: 'sigDeadline', type: 'uint256' }],
} as const
export const PERMIT_INPUT = [{ type: 'tuple', components: [
  { name: 'details', type: 'tuple', components: [{ name: 'token', type: 'address' }, { name: 'amount', type: 'uint160' }, { name: 'expiration', type: 'uint48' }, { name: 'nonce', type: 'uint48' }] },
  { name: 'spender', type: 'address' }, { name: 'sigDeadline', type: 'uint256' },
] }, { type: 'bytes' }] as const
export const PERMIT_DOMAIN = { name: 'Permit2', chainId: 5042, verifyingContract: ARC_PERMIT2 } as const
const deny = (): never => { throw new Error('permit_invalid') }
export function permitMessage(review: ArcReview, nonce: number, timestamp: bigint) {
  if (review.source !== 'onchain' || review.request.tokenIn === 'USDC' || !Number.isSafeInteger(nonce) || nonce < 0 || nonce >= 2 ** 48) deny()
  const deadline = decodeFunctionData({ abi: EXECUTE_ABI, data: review.transaction.data }).args[2]
  if (deadline <= timestamp || deadline > timestamp + 120n) deny()
  const amount = tokenUnits(review.request.amount, ARC_TOKENS[review.request.tokenIn].decimals)
  if (amount <= 0n || amount >= 2n ** 160n) deny()
  return { details: { token: ARC_TOKENS[review.request.tokenIn].address, amount, expiration: Number(deadline), nonce }, spender: ARC_ROUTER as Hex, sigDeadline: deadline }
}
export async function attachPermit(review: ArcReview, nonce: number, timestamp: bigint, signature: unknown): Promise<Hex> {
  if (typeof signature !== 'string' || !/^0x(?:[a-f0-9]{128}|[a-f0-9]{130})$/i.test(signature)) deny()
  const message = permitMessage(review, nonce, timestamp)
  const signer = await recoverTypedDataAddress({ domain: PERMIT_DOMAIN, types: PERMIT_SINGLE_TYPES, primaryType: 'PermitSingle', message, signature: signature as Hex })
  if (!sameAddress(signer, review.request.owner)) deny()
  const unsigned = decodeFunctionData({ abi: EXECUTE_ABI, data: review.transaction.data }).args
  decodeRouteProgram(review.transaction, review.request, BigInt(review.requiredMinimum))
  const data = encodeFunctionData({ abi: EXECUTE_ABI, functionName: 'execute', args: ['0x0a00', [encodeAbiParameters(PERMIT_INPUT, [message, signature as Hex]), unsigned[1][0]], unsigned[2]] })
  await validatePermitCalldata(review, data, nonce, timestamp)
  return data
}
// Verify the exact economic program, canonical encoding, domain, signature, nonce and both time bounds. No generic command allowance.
export async function validatePermitCalldata(review: ArcReview, data: Hex, nonce: number, timestamp: bigint): Promise<void> {
  const outer = decodeFunctionData({ abi: EXECUTE_ABI, data }).args
  if (outer[0] !== '0x0a00' || outer[1].length !== 2 || encodeFunctionData({ abi: EXECUTE_ABI, functionName: 'execute', args: outer }).toLowerCase() !== data.toLowerCase()) deny()
  const [message, signature] = decodeAbiParameters(PERMIT_INPUT, outer[1][0])
  const expected = permitMessage(review, nonce, timestamp)
  if (encodeAbiParameters(PERMIT_INPUT, [expected, signature]).toLowerCase() !== outer[1][0].toLowerCase()) deny()
  const base = encodeFunctionData({ abi: EXECUTE_ABI, functionName: 'execute', args: ['0x00', [outer[1][1]], outer[2]] })
  if (base.toLowerCase() !== review.transaction.data.toLowerCase()) deny()
  decodeRouteProgram({ ...review.transaction, data: base }, review.request, BigInt(review.requiredMinimum))
  const signer = await recoverTypedDataAddress({ domain: PERMIT_DOMAIN, types: PERMIT_SINGLE_TYPES, primaryType: 'PermitSingle', message, signature })
  if (!sameAddress(signer, review.request.owner)) deny()
}

// Disclose the existing first-layer grant, without changing it or suggesting an unnecessary approval.
export function existingAllowanceNotice(reviewRequest: ArcReview['request'], allowance: bigint): string | null {
  if (reviewRequest.tokenIn === 'USDC') return null
  const token = ARC_TOKENS[reviewRequest.tokenIn], need = tokenUnits(reviewRequest.amount, token.decimals)
  if (allowance <= need) return null
  const existing = allowance === 2n ** 256n - 1n ? 'unlimited' : `${formatUnits(allowance, token.decimals)} ${reviewRequest.tokenIn}, above this swap amount`
  return `Existing ${reviewRequest.tokenIn} → Permit2 token allowance: ${existing}. It will be reused without another approval and will not be automatically increased or revoked. This swap's PermitSingle authorizes only ${reviewRequest.amount} ${reviewRequest.tokenIn} and expires with the transaction deadline (at most 120 seconds when prepared).`
}

// A PermitSingle authorizes only token/amount/spender/time, not a swap price. Reuse it only after a fresh,
// independently validated Review, with its original deadline and bounds preserved. Never write this result to storage.
export async function reusePermit(review: ArcReview, signedData: Hex, timestamp: bigint): Promise<Hex> {
  const [commands, inputs] = decodeFunctionData({ abi: EXECUTE_ABI, data: signedData }).args
  if (commands !== '0x0a00' || inputs.length !== 2) deny()
  const [message, signature] = decodeAbiParameters(PERMIT_INPUT, inputs[0])
  const expected = permitMessage(review, message.details.nonce, timestamp)
  if (encodeAbiParameters(PERMIT_INPUT, [expected, signature]).toLowerCase() !== inputs[0].toLowerCase()) deny()
  return attachPermit(review, message.details.nonce, timestamp, signature)
}
