import { decodeFunctionResult, encodeFunctionData, erc20Abi, formatUnits, keccak256, type Hex, type PublicClient } from 'viem'
import { SIMULATOR_ABI, SIMULATOR_RUNTIME } from './simulatorCode'
import { MAINNET_SWAP_QUOTE_TTL_MS, MAINNET_SWAP_SLIPPAGE_BPS } from '../../config/mainnetSwap'
import {
  ExecutionNonceObservationError, ExecutionVerificationError, MAX_AUTOMATIC_CHECK_FAILURES, PENDING_CHECK_MS, TRANSIENT_CHECK_DELAYS_MS, isIntentVerified, isTransactionHash, reconcileExecutionNonce,
  type AttemptStatus, type ExecutionNonceState, type StatusLogEntry,
} from '../uniswapArcExecution'
import { CIRCLE_ADAPTER, CIRCLE_ADAPTER_CODEHASH, CIRCLE_ADAPTER_IMPLEMENTATION, CIRCLE_ADAPTER_IMPLEMENTATION_CODEHASH, CIRCLE_ADAPTER_IMPLEMENTATION_SLOT, compareCircleSwap, type CircleReviewedIntent } from './circleAdapterDecode'
import {
  CircleGuardError, bufferedGas, createGuardedWalletClient,
  type CircleGuardHooks, type CircleGuardPolicy, type CircleInnerWallet, type CircleStepInfo, type CircleStepKind, type CircleStepOutcome, type CircleStepPlan, type GuardedWallet,
} from './circleGuard'
import { SWAP_INPUT_CAPS, isSwapSymbol, swapToken, type SwapSymbol } from './tokens'
import { archiveRecord, archiveUnreadable, readArchive } from './journalArchive'
import { viemInnerWallet } from './circleWallet'
import { ownerFlows, summarizeIntent, type ChainLog, type ChainReceipt, type ChainSummary, type ChainTx, type IntentSummary } from './transactionEvidence'

// Circle Swap Kit execution on Arc Mainnet. Mirrors the Uniswap controller (uniswapArcExecution.ts): the application, not the SDK or the
// wallet, decides what may be sent. The SDK runs unchanged but only ever sees the guarded wallet (circleGuard.ts); every wallet request is
// journaled BEFORE the wallet is contacted, bound to the Review, and the result is verified from the chain, separately from the Review.

// Source gate of Circle execution. It is open: what the real SDK and the real Circle service do was exercised read-only for all 12 directions
// (fresh service responses pass the calldata policy, the fee instructions equal the quoted provider fee, the exact calldata was simulated
// against the live adapter), and every wallet request still passes the guarded wallet, the independent price check and the outcome simulation.
// Execution additionally needs the build's execution switch and mode (ports.authorize); a missing authorisation fails closed.
export const CIRCLE_SWAP_WRITES_ENABLED = true
export const CIRCLE_CHAIN_ID = 5042
export const CIRCLE_EXPLORER = 'https://explorer.arc.io/tx/'
// Fee ceiling for ALL steps of one attempt (approval plus swap), in 18-decimal native units. Real Circle swaps on Arc cost 0.007-0.048 USDC
// (median 0.0125); the worst case the SDK asks the wallet for is its gas limit (median 1.05 M, up to 3.1 M) times the Review's fee cap.
export const CIRCLE_FEE_CEILING_CAP = 10n ** 17n         // 0.1 USDC
export const CIRCLE_FEE_UNKNOWN = 5n * 10n ** 16n        // 0.05 USDC when no gas estimate exists
export const CIRCLE_FEE_MARGIN = 2n * 10n ** 16n         // 0.02 USDC
export const circleFeeCeiling = (estimatedGasFee: bigint | null): bigint => {
  if (estimatedGasFee === null || estimatedGasFee <= 0n) return CIRCLE_FEE_UNKNOWN
  const wanted = estimatedGasFee * 3n + CIRCLE_FEE_MARGIN
  return wanted < CIRCLE_FEE_CEILING_CAP ? wanted : CIRCLE_FEE_CEILING_CAP
}
export const STEP_CONFIRM_TIMEOUT_MS = 120_000
export const APPROVAL_WALLET_WINDOW_MS = 120_000
export const CIRCLE_MINING_BUFFER_MS = 15_000
export const CIRCLE_MIN_SWAP_WINDOW_MS = 30_000
export const CIRCLE_STALL_BEFORE_STEP_MS = 90_000, CIRCLE_STALL_AFTER_APPROVAL_MS = 180_000, CIRCLE_STALL_AFTER_FAILURE_MS = 30_000
const MAX_FEE_PER_GAS = 100_000_000_000n // 100 gwei
const APPROVAL_POLLS = 5, APPROVAL_POLL_MS = 1500
const ADDRESS = /^0x[0-9a-fA-F]{40}$/
const lc = (value: string) => value.toLowerCase()
const same = (a: unknown, b: string) => typeof a === 'string' && ADDRESS.test(a) && lc(a) === lc(b)
const stop = (code: string): never => { throw new Error(code) }
const isNonce = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0
const decimalText = (v: unknown): v is string => typeof v === 'string' && /^\d{1,78}$/.test(v)
const boundedText = (v: unknown, max: number): v is string => typeof v === 'string' && v.length <= max
const uint = (value: unknown): bigint => { if (!decimalText(value)) return stop('invalid_integer'); return BigInt(value) }

// --- Request and Review ----------------------------------------------------------------------------------------------------
export type CircleStrategy = 'approve' | 'permit'
export interface CircleSwapRequest {
  chainId: 5042; tokenIn: SwapSymbol; tokenOut: SwapSymbol; owner: string
  amount: string            // human decimal text, at most the input token's decimals
  slippageBps: number; allowanceStrategy?: CircleStrategy
}
// Everything below is produced by the hook's read-only quote and balance layer and RE-VALIDATED here (validateCircleReview); a Review that
// does not satisfy the rules is never presented as executable.
export interface CircleSwapReview {
  request: CircleSwapRequest
  amountIn: string                    // base units of the input token
  estimatedOutput: string; requiredMinimum: string   // base units of the output token; requiredMinimum is the quote's stop limit
  networkFee: string                  // fee ceiling for every step, 18-decimal native units
  maxFeePerGas: string; maxPriorityFeePerGas: string
  nativeBalance: string; tokenBalance: string
  allowance: string                   // current allowance(owner, adapter) of the input token; the SDK still approves the exact amount (see report)
  fees: { type: string; token: string; amount: string | null }[]   // provider/swap fees from the quote, display only
  requestStartedAt: number; expiresAt: number
  route?: string
  // An independent price for the same swap (the keyless Uniswap quote), used to refuse a Circle quote that is far below the market.
  // Required for a fresh Review to be executable (see independentPriceCheck); old stored records do not carry it.
  reference?: { source: 'uniswap'; estimatedOutput: string }
}
export interface CircleContext { owner: string; connected: boolean; chainId: number; connectorId: string }
export interface CircleProvider { request(args: { method: string; params?: unknown[] }): Promise<unknown> }

const REQUEST_KEYS = ['chainId', 'tokenIn', 'tokenOut', 'owner', 'amount', 'slippageBps', 'allowanceStrategy']
export function parseCircleAmount(amount: unknown, decimals: number): bigint {
  if (typeof amount !== 'string' || amount.length > 70 || !/^(0|[1-9]\d{0,29})(\.\d+)?$/.test(amount)) return stop('invalid_amount')
  const [whole, fraction = ''] = amount.split('.')
  if (fraction.length > decimals) return stop('invalid_amount')
  return BigInt(whole + fraction.padEnd(decimals, '0'))
}
export function validateCircleRequest(input: unknown): CircleSwapRequest {
  const r = input as Record<string, unknown> | null
  if (!r || typeof r !== 'object' || Object.keys(r).some(key => !REQUEST_KEYS.includes(key))) return stop('invalid_request')
  if (r.chainId !== CIRCLE_CHAIN_ID) return stop('wrong_network')
  if (!isSwapSymbol(r.tokenIn) || !isSwapSymbol(r.tokenOut) || r.tokenIn === r.tokenOut) return stop('unsupported_route')
  if (typeof r.owner !== 'string' || !ADDRESS.test(r.owner) || /^0x0{40}$/i.test(r.owner)) return stop('wallet_required')
  if (!(MAINNET_SWAP_SLIPPAGE_BPS as readonly number[]).includes(r.slippageBps as number)) return stop('invalid_slippage')
  // USDC is signed for (EIP-2612 permit, exact amount, one use): the SDK's own default, and the path every USDC-input swap in the 384 sampled
  // Arc transactions took. The SDK's alternative for USDC is `increaseAllowance`, which ADDS to an existing allowance instead of setting an exact
  // one, so it is not offered. Every other token has no permit; it gets an exact on-chain `approve`.
  const strategy = r.allowanceStrategy === undefined ? (r.tokenIn === 'USDC' ? 'permit' : 'approve') : r.allowanceStrategy
  if (strategy !== 'approve' && strategy !== 'permit') return stop('invalid_request')
  if ((strategy === 'permit') !== (r.tokenIn === 'USDC')) return stop('invalid_strategy')
  const units = parseCircleAmount(r.amount, swapToken(r.tokenIn).decimals)
  if (units <= 0n) return stop('invalid_amount')
  if (units > SWAP_INPUT_CAPS[r.tokenIn]) return stop('amount_cap')
  return { chainId: CIRCLE_CHAIN_ID, tokenIn: r.tokenIn, tokenOut: r.tokenOut, owner: r.owner, amount: r.amount as string, slippageBps: r.slippageBps as number, allowanceStrategy: strategy }
}
export const circleRequestKey = (request: CircleSwapRequest): string => {
  const r = validateCircleRequest(request)
  return JSON.stringify([r.chainId, r.tokenIn, r.tokenOut, lc(r.owner), r.amount, r.slippageBps, r.allowanceStrategy])
}
export function validateCircleReview(review: CircleSwapReview, context: Pick<CircleContext, 'owner' | 'connected' | 'chainId'>, now: number): void {
  const request = validateCircleRequest(review?.request)
  if (!context.connected || context.chainId !== CIRCLE_CHAIN_ID || !same(context.owner, request.owner)) stop('context')
  const tokenIn = swapToken(request.tokenIn)
  const amountIn = uint(review.amountIn), estimated = uint(review.estimatedOutput), minimum = uint(review.requiredMinimum)
  if (amountIn !== parseCircleAmount(request.amount, tokenIn.decimals)) stop('economic_mismatch')
  // The stop limit is the quote's guaranteed floor: positive, not above the estimate, and no looser than the slippage the user chose.
  if (estimated <= 0n || minimum <= 0n || minimum > estimated || minimum < estimated * BigInt(10_000 - request.slippageBps) / 10_000n) stop('economic_mismatch')
  if (!Number.isSafeInteger(review.requestStartedAt) || !Number.isSafeInteger(review.expiresAt) || review.expiresAt <= review.requestStartedAt ||
    review.expiresAt > review.requestStartedAt + MAINNET_SWAP_QUOTE_TTL_MS || now < review.requestStartedAt || now >= review.expiresAt) stop('expired')
  const fee = uint(review.networkFee), price = uint(review.maxFeePerGas), tip = uint(review.maxPriorityFeePerGas)
  if (fee <= 0n || fee > CIRCLE_FEE_CEILING_CAP || price <= 0n || price > MAX_FEE_PER_GAS || tip > price) stop('fee_ceiling')
  // USDC is also the gas token: an input of USDC and the fee ceiling come out of the same balance (6-decimal token units x 10^12).
  const native = uint(review.nativeBalance), held = uint(review.tokenBalance), reserve = request.tokenIn === 'USDC' ? amountIn * 10n ** 12n : 0n
  if (held < amountIn) stop('insufficient_input_balance')
  if (native < fee + reserve) stop('insufficient_gas')
  uint(review.allowance)
  if (!Array.isArray(review.fees) || review.fees.length > 16) stop('invalid_request')
  for (const item of review.fees) if (!item || !boundedText(item.type, 24) || !boundedText(item.token, 24) || (item.amount !== null && !boundedText(item.amount, 80))) stop('invalid_request')
  if (review.route !== undefined && !boundedText(review.route, 200)) stop('invalid_request')
  if (review.reference !== undefined && (review.reference.source !== 'uniswap' || !decimalText(review.reference.estimatedOutput))) stop('invalid_request')
}

// The quote service decides the guaranteed minimum, so a quote that is wrong but self-consistent would otherwise be accepted. A fresh Review
// must therefore carry an independent price, and its guaranteed minimum may not be further below that price than the slippage the user chose
// plus a fixed tolerance for ordinary differences between venues (measured on the live service: well under 1%).
export const CIRCLE_REFERENCE_TOLERANCE_BPS = 250
export function independentPriceCheck(review: CircleSwapReview): void {
  if (!review.reference || review.reference.source !== 'uniswap') return stop('price_check_unavailable')
  const reference = uint(review.reference.estimatedOutput), minimum = uint(review.requiredMinimum)
  if (reference <= 0n) return stop('price_check_unavailable')
  if (minimum * 10_000n < reference * BigInt(10_000 - review.request.slippageBps - CIRCLE_REFERENCE_TOLERANCE_BPS)) stop('price_check')
}
// The provider fee the Review showed, in base units of the input token (undefined when the quote showed none).
export function providerFeeUnits(review: CircleSwapReview): bigint | undefined {
  const input = swapToken(review.request.tokenIn)
  const fees = review.fees.filter(fee => fee.type === 'provider' && fee.token === review.request.tokenIn && fee.amount !== null)
  if (fees.length === 0) return undefined
  return fees.reduce((sum, fee) => sum + parseCircleAmount(fee.amount as string, input.decimals), 0n)
}

// Facts read from the chain, read-only, right before a wallet request.
export interface CirclePreflightFacts {
  chainId: number; blockNumber: bigint; blockTimestamp: bigint
  walletCode: string | undefined          // '0x' or undefined for a plain EOA
  adapterCodeHash: string | null          // keccak256 of the runtime code at the pinned adapter
  adapterImplementation: string | null    // the EIP-1967 implementation the adapter proxy points to
  implementationCodeHash: string | null   // keccak256 of that implementation's runtime code
  tokenCodesPresent: boolean; tokenInDecimals: number; tokenOutDecimals: number
  tokenBalance: bigint; nativeBalance: bigint; allowance: bigint
  gasPrice: bigint; baseFee: bigint | null
}
// `feeLeft` is the part of the fee ceiling not yet spent by this attempt's earlier steps (the full ceiling before the first step).
export function evaluatePreflight(review: CircleSwapReview, facts: CirclePreflightFacts, feeLeft?: bigint): void {
  const request = review.request, tokenIn = swapToken(request.tokenIn), tokenOut = swapToken(request.tokenOut)
  if (facts.chainId !== CIRCLE_CHAIN_ID) stop('preflight')
  if (facts.walletCode && facts.walletCode !== '0x') stop('smart_wallet')
  if (!facts.adapterCodeHash || lc(facts.adapterCodeHash) !== lc(CIRCLE_ADAPTER_CODEHASH)) stop('adapter_identity')
  // The proxy is upgradeable: the implementation behind it must be the reviewed one, or the code the swap would run is unknown.
  if (!facts.adapterImplementation || lc(facts.adapterImplementation) !== lc(CIRCLE_ADAPTER_IMPLEMENTATION) || !facts.implementationCodeHash || lc(facts.implementationCodeHash) !== lc(CIRCLE_ADAPTER_IMPLEMENTATION_CODEHASH)) stop('adapter_identity')
  if (!facts.tokenCodesPresent || facts.tokenInDecimals !== tokenIn.decimals || facts.tokenOutDecimals !== tokenOut.decimals) stop('preflight')
  const amountIn = uint(review.amountIn), fee = feeLeft ?? uint(review.networkFee), price = uint(review.maxFeePerGas)
  if (facts.tokenBalance < amountIn) stop('insufficient_input_balance')
  if (facts.nativeBalance < fee + (request.tokenIn === 'USDC' ? amountIn * 10n ** 12n : 0n)) stop('insufficient_gas')
  if (facts.gasPrice <= 0n || facts.gasPrice > price || (facts.baseFee !== null && facts.baseFee > price)) stop('preflight')
}

// --- Attempts ---------------------------------------------------------------------------------------------------------------
export type CircleStepStatus = 'awaiting_wallet' | 'pending' | 'confirmed' | 'failed' | 'rejected' | 'unknown'
export interface CircleStepRecord {
  index: number; kind: CircleStepKind; to: Hex; token: Hex; amount: string; spender?: Hex; minimumOut?: string; deadline?: number; dataHash: Hex
  nonce: number; status: CircleStepStatus; at: number
  hash?: Hex; gasLimit?: string; maxFee?: string; maxTip?: string; fee?: string   // maxFee and maxTip are the fee caps handed to the wallet; fee is what the chain charged
}
export interface CircleSwapAttempt {
  id: string; review: CircleSwapReview; status: AttemptStatus; createdAt: number; steps: CircleStepRecord[]
  hash?: Hex; output?: string; fee?: string     // hash = the swap transaction; fee = total network fee across the steps
  chain?: ChainSummary; intent?: IntentSummary; log?: StatusLogEntry[]
}
export interface CircleView {
  phase: 'idle' | 'preparing' | 'review' | 'checking' | 'awaiting_step' | AttemptStatus
  approvalId?: string; review?: CircleSwapReview; attempt?: CircleSwapAttempt; error?: string
  // The step waiting for the user's in-app confirmation (phase awaiting_step). Nothing reaches the wallet before continueStep().
  step?: CircleStepInfo; stepWindowMs?: number
  walletWindowMs?: number; walletRequestOpen?: boolean
  checking?: boolean; nextCheckMs?: number | null; observedAt?: number
  // The recorded swap hash is unknown to the network and its nonce was used by another transaction: the replacement's hash can be supplied.
  replaced?: boolean
}
export type CircleChainResult =
  // identified: the node knows this exact transaction and it is bound to the attempt (sender, nonce, network). nonceUsed: the recorded hash
  // is unknown AND its nonce was already used by another transaction, so it can never execute (a speed-up or cancel replaced it).
  | { status: 'pending'; identified?: boolean; nonceUsed?: boolean }
  | { status: 'settled'; chain: ChainSummary; intent: IntentSummary; output: string; fee: string; approvals: { index: number; status: 'confirmed' | 'failed' | 'pending'; fee: string }[] }
export type CircleApprovalState = { status: 'pending' } | { status: 'confirmed' | 'failed'; fee: string }
export interface CircleKitLike { swap(params: Record<string, unknown>): Promise<unknown> }

export interface CirclePorts {
  context(): CircleContext; input(): CircleSwapRequest | null
  now(): number
  // Fresh read-only quote, balances and fee data. Re-validated by validateCircleReview.
  fresh(input: CircleSwapRequest): Promise<CircleSwapReview>
  preflight(review: CircleSwapReview): Promise<CirclePreflightFacts>
  publicNonce(owner: string): Promise<ExecutionNonceState>
  provider(): Promise<CircleProvider>
  // The wallet below the guard. Defaults to a viem WalletClient over the connected provider (viemInnerWallet).
  wallet?(provider: CircleProvider, owner: Hex): CircleInnerWallet
  // Builds the SDK around the guarded wallet: a ViemAdapter whose getWalletClient returns `wallet` and whose public client is the pinned
  // read-only Arc client, plus the SwapKit.
  sdk(wallet: GuardedWallet): Promise<{ kit: CircleKitLike; adapter: unknown }> | { kit: CircleKitLike; adapter: unknown }
  // eth_estimateGas on the exact transaction: a revert throws, so it doubles as the simulation before the wallet is asked.
  estimateGas(tx: { from: Hex; to: Hex; data: Hex; value: bigint }): Promise<bigint>
  // A test run of the exact swap calldata against the live adapter and the wallet's real balances (read-only eth_call): what the wallet would
  // receive and spend. Required before an approval-strategy swap is requested; a permit swap cannot be run this way (its signature belongs to the
  // wallet, not to a test run) and is covered by estimateGas and the on-chain check.
  simulate?(owner: Hex, data: Hex, tokenIn: Hex, tokenOut: Hex): Promise<{ received: bigint; spent: bigint }>
  approval(attempt: CircleSwapAttempt, step: CircleStepRecord): Promise<CircleApprovalState>
  result(attempt: CircleSwapAttempt, submitted?: (intent: IntentSummary) => void): Promise<CircleChainResult>
  storage: Pick<Storage, 'getItem' | 'setItem'>
  lock<T>(owner: string, run: () => Promise<T>): Promise<T>
  changed?(view: CircleView): void; settled?(attempt: CircleSwapAttempt): void
  // True while the other provider (Uniswap) has an unresolved transaction for this wallet: one wallet, one open transaction.
  blockedElsewhere?(owner: string): boolean
  authorize?(input: CircleSwapRequest | null, context: CircleContext): boolean
  enabled?(): boolean
  pause?(ms: number): Promise<void>
}

const unresolved = (a: CircleSwapAttempt) => ['awaiting_wallet', 'pending', 'unknown'].includes(a.status)
const TERMINAL: AttemptStatus[] = ['confirmed', 'failed', 'mismatch']
const storageKey = (owner: string) => `machina.circle.swap.execution.v1:${owner.toLowerCase()}`
const archiveKey = (owner: string) => `machina.circle.swap.execution.archive.v1:${owner.toLowerCase()}`
const ATTEMPT_STATUSES = ['awaiting_wallet', 'pending', 'confirmed', 'failed', 'rejected', 'unknown', 'mismatch']
const STEP_STATUSES = ['awaiting_wallet', 'pending', 'confirmed', 'failed', 'rejected', 'unknown']
const STEP_KINDS = ['approve', 'permit', 'swap']
const INTENT_VERDICTS = ['verified', 'verified_with_notes', 'mismatch', 'incomplete', 'unbound', 'no_review']
const INTENT_STATUSES = ['match', 'allowed', 'mismatch', 'unavailable']

export function circleSwapMessage(code: string): string {
  const messages: Record<string, string> = {
    writes_disabled: 'Circle Swap Kit swaps are switched off in this build. Quotes are shown for comparison only.',
    pilot_restricted: 'Execution is restricted to the configured pilot on Arc Mainnet. Live previews remain available.',
    context: 'The wallet, network, provider or swap inputs changed. Review a fresh swap.',
    expired: 'This swap review expired. Review a fresh swap before confirming.',
    busy: 'An earlier wallet request or transaction is unresolved. Check its status before retrying.',
    busy_other: 'Another swap from this wallet (the other provider) is still unresolved. Wait for it to finish before starting a new one.',
    lock: 'Another tab is handling this wallet, or safe browser locking is unavailable.',
    storage: 'Safe transaction recording is unavailable. No new transaction can be requested.',
    nonce: 'The account nonce changed since Review. Check recent transactions before creating a fresh review. No transaction was requested.',
    nonce_rpc: 'Public Arc RPC and wallet RPC disagree about the account nonce. A pending transaction or stale RPC may be involved. No transaction was requested.',
    nonce_pending: 'RPC reports another pending transaction for this account. Wait for it to resolve and check its status before trying again.',
    nonce_regression: 'RPC nonce observations moved backwards. Account state cannot be safely reconciled. No transaction was requested.',
    public_nonce: 'Public Arc RPC could not provide a valid, stable latest/pending nonce. No transaction was requested.',
    wallet_nonce: 'The wallet RPC could not provide a valid, stable latest/pending nonce, or the wallet network or account changed. No transaction was requested.',
    rejected: 'You rejected the wallet request. Nothing further was sent and nothing will be retried automatically.',
    step_declined: 'You did not continue this step. Nothing was sent to the wallet.',
    step_timeout: 'The confirmation window for this step ended. Nothing was sent to the wallet. Review a fresh swap.',
    unknown: 'Submission or confirmation is not yet verified. This does not mean failure. Check your wallet or Arc Explorer; do not submit again.',
    wallet_timeout: 'The wallet approval window ended. Cancel the open request in your wallet; do not approve or submit again. The app cannot cancel it. A late approval or delayed inclusion may revert and still charge gas. Any returned hash will still be tracked.',
    verification: 'The chain could not be read just now (network or RPC trouble). This does not mean the transaction failed or succeeded. The app checks again automatically with growing pauses; you can also check manually. Do not submit another swap.',
    verification_binding: 'This transaction hash does not identify the reviewed swap (its sender, nonce, network or hash differ), so it is not counted as this swap. Check it on Arc Explorer. No further automatic checks will run.',
    verification_stopped: 'Automatic checks stopped after repeated read failures. This does not mean the transaction failed. Use Check transaction status to try again; do not submit another swap.',
    mismatch: 'The blockchain transaction succeeded, but it is not the transaction you reviewed, so it is not marked Confirmed. The differences are listed below.',
    smart_wallet: 'This execution flow supports EOAs only. Contract and delegated wallets remain blocked.',
    insufficient_input_balance: 'The wallet does not hold enough of the input token for this swap. No wallet request was started.',
    insufficient_gas: 'The wallet does not hold enough USDC to cover the network fee (and the input amount, when USDC is being swapped). No wallet request was started.',
    adapter_identity: 'The Circle adapter contract (or the implementation behind it) on Arc does not match the pinned, reviewed identity. No wallet request was started.',
    fee_ceiling: 'The network fee for this step would exceed the fee ceiling shown in the Review. Nothing was sent to the wallet. Review a fresh swap.',
    gas_limit: 'The gas limit requested for this step is outside the allowed range. Nothing was sent to the wallet.',
    simulation: 'The transaction would fail on chain right now (simulation reverted), so it was not sent to the wallet. Review a fresh swap.',
    approval_failed: 'The approval transaction did not succeed on chain, so the swap was not requested.',
    approval_pending: 'The approval is not confirmed on chain yet, so the swap was not requested.',
    approval_missing: 'No confirmed approval was found for this swap, so it was not requested.',
    swap_calldata: 'Circle returned swap instructions that differ from what you reviewed (amount, minimum received, recipient, route or deadline), so the swap was not sent to the wallet. Review a fresh swap.',
    method_blocked: 'The swap software asked the wallet for something outside this swap. It was blocked.',
    wrong_target: 'The swap software tried to send a transaction to a contract that is not part of this swap. It was blocked.',
    approve_amount: 'The approval was not for exactly the reviewed amount, so it was blocked. Nothing was sent to the wallet.',
    approve_spender: 'The approval was not for the Circle adapter, so it was blocked. Nothing was sent to the wallet.',
    approve_data: 'The call to the input token was not a plain approval, so it was blocked. Nothing was sent to the wallet.',
    typed_data: 'The signature requested was not the exact permit you reviewed, so it was blocked.',
    account: 'The wallet account is no longer the reviewed account. Nothing was sent to the wallet.',
    network: 'The wallet is not on Arc Mainnet. Nothing was sent to the wallet.',
    duplicate_send: 'A transaction of this kind was already requested for this swap; a second one was blocked.',
    step_order: 'The swap steps arrived in an unexpected order, so the request was blocked.',
    value: 'The transaction carried native value that an ERC-20 swap never needs, so it was blocked.',
    extra_field: 'The transaction contained unexpected fields, so it was blocked.',
    sealed: 'This swap session is closed.',
    hash: 'The wallet did not return a transaction hash. Check your wallet and Arc Explorer; do not submit again.',
    amount_cap: 'This amount is above the per-transaction limit for this release.',
    invalid_amount: 'Enter a positive amount within the token precision.',
    unsupported_route: 'Choose two different swap tokens.',
    wrong_network: 'Select Arc Mainnet in your wallet.',
    wallet_required: 'Connect a wallet first.',
    invalid_slippage: 'Choose one of the supported slippage values.',
    invalid_request: 'The swap request is not valid. Review a fresh swap.',
    invalid_strategy: 'USDC is swapped with a signed permit and every other token with an exact approval; this combination is not offered.',
    economic_mismatch: 'The quote does not satisfy the slippage you chose. Review a fresh swap.',
    price_check: 'Circle’s price for this swap is well below the independent market price, so it was not prepared. Nothing was sent. Try again later or use the other provider.',
    price_check_unavailable: 'An independent price check could not be completed, so a Circle swap was not prepared. Nothing was sent. Try again in a moment.',
    simulation_outcome: 'A test run of this exact swap on Arc shows you would receive less than your minimum (or spend more than you approved), so it was not sent to your wallet. Nothing was sent. Review a fresh swap.',
    sdk_failed: 'The swap software stopped before any transaction was requested. Nothing was sent. Review a fresh swap.',
    sdk_stalled: 'The swap software did not answer in time, so the flow was ended. Nothing further will be requested. Anything that was already submitted is tracked below. Review a fresh swap.',
    permit_failed: 'The signature request did not complete (declined, not supported by the wallet, or timed out). A signature moves no funds and no transaction was requested. Review a fresh swap.',
    closed_before_wallet: 'The page was closed, or the flow stopped, before any wallet transaction was requested. Nothing was sent, so a new swap can be started.',
    recovery_unknown: 'The network does not know that hash (yet), so it was not saved and nothing was changed. Check the hash in your wallet or on Arc Explorer, then paste it again.',
    replaced: 'The recorded swap is not known to the network, and its nonce was used by another transaction (for example a wallet speed-up or cancel). Paste the hash your wallet shows for the replacement; it is accepted only if it is the swap you reviewed.',
    preflight: 'The current balance, fees, contract identity or simulation could not be verified. No wallet request was started.',
    confirmation: 'The transaction is still being checked. RPC errors and timeouts do not mean it failed.',
  }
  return messages[code] ?? messages.preflight
}

// --- Journal ------------------------------------------------------------------------------------------------------------------
function validateChain(c: unknown) {
  const v = c as Record<string, unknown> | null
  if (!v || typeof v !== 'object' || Object.keys(v).some(k => !['state', 'blockNumber', 'blockHash', 'gasUsed', 'effectiveGasPrice', 'fee', 'received', 'sent', 'checkedAt'].includes(k)) ||
    !['success', 'reverted'].includes(v.state as string) || !decimalText(v.blockNumber) || typeof v.blockHash !== 'string' || !/^0x[a-fA-F0-9]{64}$/.test(v.blockHash) ||
    !decimalText(v.gasUsed) || !decimalText(v.effectiveGasPrice) || !decimalText(v.fee) || (v.received !== null && !decimalText(v.received)) || (v.sent !== null && v.sent !== undefined && !decimalText(v.sent)) ||
    !Number.isSafeInteger(v.checkedAt)) stop('storage')
}
function validateIntent(i: unknown) {
  const v = i as Record<string, unknown> | null
  if (!v || typeof v !== 'object' || Object.keys(v).some(k => !['verdict', 'checks', 'differences', 'checkedAt'].includes(k)) || !INTENT_VERDICTS.includes(v.verdict as string) ||
    !Array.isArray(v.checks) || v.checks.length > 24 || !Array.isArray(v.differences) || v.differences.length > 8 || !Number.isSafeInteger(v.checkedAt)) return stop('storage')
  for (const item of v.checks as Record<string, unknown>[]) if (!item || typeof item !== 'object' || !boundedText(item.id, 40) || !INTENT_STATUSES.includes(item.status as string) || !boundedText(item.detail, 500)) stop('storage')
  for (const text of v.differences as unknown[]) if (!boundedText(text, 500)) stop('storage')
}
function validateLog(l: unknown) {
  if (!Array.isArray(l) || l.length > 40) return stop('storage')
  for (const item of l as Record<string, unknown>[]) if (!item || typeof item !== 'object' || !Number.isSafeInteger(item.at) || !ATTEMPT_STATUSES.includes(item.status as string) || !boundedText(item.note, 300)) stop('storage')
}
function validateStep(value: unknown, index: number): CircleStepRecord {
  const s = value as CircleStepRecord
  if (!s || typeof s !== 'object' || Object.keys(s).some(k => !['index', 'kind', 'to', 'token', 'amount', 'spender', 'minimumOut', 'deadline', 'dataHash', 'nonce', 'status', 'at', 'hash', 'gasLimit', 'maxFee', 'maxTip', 'fee'].includes(k)) ||
    s.index !== index || !STEP_KINDS.includes(s.kind) || !ADDRESS.test(s.to) || !ADDRESS.test(s.token) || !decimalText(s.amount) || (s.spender !== undefined && !ADDRESS.test(s.spender)) ||
    (s.minimumOut !== undefined && !decimalText(s.minimumOut)) || (s.deadline !== undefined && !Number.isSafeInteger(s.deadline)) || !/^0x[a-fA-F0-9]{64}$/.test(s.dataHash) ||
    !isNonce(s.nonce) || !STEP_STATUSES.includes(s.status) || !Number.isSafeInteger(s.at) || (s.hash !== undefined && !isTransactionHash(s.hash)) ||
    (s.gasLimit !== undefined && !decimalText(s.gasLimit)) || (s.maxFee !== undefined && !decimalText(s.maxFee)) || (s.maxTip !== undefined && !decimalText(s.maxTip)) || (s.fee !== undefined && !decimalText(s.fee))) return stop('storage')
  if (['pending', 'confirmed', 'failed'].includes(s.status) && !s.hash) return stop('storage')
  return structuredClone(s)
}
function validateAttempt(value: unknown, owner: string): CircleSwapAttempt {
  if (!value || typeof value !== 'object') return stop('storage')
  const a = value as CircleSwapAttempt
  if (Object.keys(a).some(k => !['id', 'review', 'status', 'createdAt', 'hash', 'output', 'fee', 'steps', 'chain', 'intent', 'log'].includes(k)) ||
    typeof a.id !== 'string' || !/^[a-f0-9-]{36}$/i.test(a.id) || !Number.isSafeInteger(a.createdAt) || !ATTEMPT_STATUSES.includes(a.status) ||
    !a.review || !a.review.request || !same(a.review.request.owner, owner) || (a.hash !== undefined && !isTransactionHash(a.hash)) || !Array.isArray(a.steps) || a.steps.length > 4) return stop('storage')
  // A historical Review is checked at its own timestamp, solely for tracking. It is never restored as send authority.
  validateCircleReview(a.review, { owner, chainId: CIRCLE_CHAIN_ID, connected: true }, a.review.requestStartedAt)
  const steps = a.steps.map((step, index) => validateStep(step, index))
  // A confirmed or mismatching result is about the swap transaction; a failure can also be that of the approval alone.
  if (['confirmed', 'mismatch'].includes(a.status) && !a.hash) return stop('storage')
  if (a.status === 'failed' && !a.hash && !steps.some(step => step.status === 'failed')) return stop('storage')
  if (a.hash !== undefined && !steps.some(step => step.kind === 'swap' && step.hash === a.hash)) return stop('storage')
  if (a.output !== undefined) uint(a.output)
  if (a.fee !== undefined) { const fee = uint(a.fee); if (a.status === 'confirmed' && fee > uint(a.review.networkFee)) return stop('storage') }
  if (a.chain !== undefined) validateChain(a.chain)
  if (a.intent !== undefined) validateIntent(a.intent)
  if (a.log !== undefined) validateLog(a.log)
  return { ...structuredClone(a), steps }
}
export function createCircleJournal(storage: CirclePorts['storage'], pinned: (id: string) => boolean = () => false) {
  function read(owner: string): CircleSwapAttempt[] {
    try {
      const raw = storage.getItem(storageKey(owner))
      if (raw === null) return []
      if (raw.length > 1048576) return stop('storage')
      const data = JSON.parse(raw)
      if (!Array.isArray(data) || data.length > 20) return stop('storage')
      const result = data.map(a => validateAttempt(a, owner))
      if (new Set(result.map(a => a.id)).size !== result.length) return stop('storage')
      return result
    } catch { return stop('storage') }
  }
  return { read, save(attempt: CircleSwapAttempt) {
    try {
      const owner = attempt.review.request.owner, checked = validateAttempt(attempt, owner)
      const records = read(owner).filter(a => a.id !== checked.id)
      if (records.length >= 20) {
        // Oldest settled record first; a record that recorded a mismatch is the last one removed. Unresolved ones never are.
        // A settled record that this session could not re-verify (`pinned`) still blocks new sends, so it is not moved out either.
        const movable = (a: CircleSwapAttempt) => !unresolved(a) && !pinned(a.id)
        const removable = (() => { const index = records.findIndex(a => movable(a) && a.status !== 'mismatch'); return index >= 0 ? index : records.findIndex(movable) })()
        if (removable < 0) return stop('storage')
        // Moved, never deleted: the archive must hold the record before it leaves the active journal.
        archiveRecord(storage, archiveKey(owner), records[removable], value => validateAttempt(value, owner))
        records.splice(removable, 1)
      }
      records.push(checked)
      const text = JSON.stringify(records)
      if (text.length > 1048576) return stop('storage')
      storage.setItem(storageKey(owner), text)
      if (storage.getItem(storageKey(owner)) !== text) return stop('storage')
    } catch { return stop('storage') }
  }, archived(owner: string): CircleSwapAttempt[] {
    try { const active = new Set(read(owner).map(a => a.id)); return readArchive(storage, archiveKey(owner), value => validateAttempt(value, owner)).filter(a => !active.has(a.id)) } catch { return stop('storage') }
  }, archiveUnreadable(owner: string): number {
    try { return archiveUnreadable(storage, archiveKey(owner), value => validateAttempt(value, owner)) } catch { return stop('storage') }
  } }
}
// Read-only enumeration of every wallet's Circle records in this browser, so the history stays reachable without a connected wallet,
// on another network, or while another provider is selected. Unreadable records are reported, never repaired or removed.
export interface StoredCircleHistory { owner: string; attempts: CircleSwapAttempt[]; archived: CircleSwapAttempt[]; unreadable: boolean; archiveUnreadable?: number }
export function listStoredCircleAttempts(storage: Pick<Storage, 'getItem' | 'key' | 'length'>): StoredCircleHistory[] {
  const prefix = 'machina.circle.swap.execution.v1:'
  const owners: string[] = []
  try {
    for (let index = 0; index < Math.min(storage.length, 512); index++) {
      const key = storage.key(index)
      if (key?.startsWith(prefix) && /^0x[a-f0-9]{40}$/.test(key.slice(prefix.length))) owners.push(key.slice(prefix.length))
    }
  } catch { return [] }
  return owners.slice(0, 16).map(owner => {
    // The active records and the archive are read separately: a problem in one never hides the other.
    const journal = createCircleJournal({ getItem: key => storage.getItem(key), setItem: () => stop('storage') })
    let attempts: CircleSwapAttempt[], archived: CircleSwapAttempt[] = [], archiveUnreadable = 0, unreadable = false
    try { attempts = journal.read(owner) } catch { return { owner, attempts: [], archived: [], unreadable: true } }
    try { archived = journal.archived(owner); archiveUnreadable = journal.archiveUnreadable(owner) } catch { unreadable = true }
    return { owner, attempts, archived, unreadable, archiveUnreadable }
  })
}
// The same lock name as the Uniswap flow on purpose: one wallet, one open swap, whichever provider started it.
export async function browserCircleLock<T>(owner: string, run: () => Promise<T>): Promise<T> {
  if (!globalThis.navigator?.locks) return stop('lock')
  return navigator.locks.request(`machina-uniswap-5042:${owner.toLowerCase()}`, { mode: 'exclusive', ifAvailable: true }, lock => lock ? run() : stop('lock'))
}

// --- Wallet side reads ------------------------------------------------------------------------------------------------------
const WALLET_READ_MS = 3000
async function walletRead(provider: CircleProvider, method: string, params?: unknown[]): Promise<unknown> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([Promise.resolve().then(() => provider.request(params ? { method, params } : { method })),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('wallet_nonce')), WALLET_READ_MS) })])
  } catch { return stop('wallet_nonce') } finally { clearTimeout(timer) }
}
const walletQuantity = (raw: unknown): number => {
  if (typeof raw === 'number' && Number.isSafeInteger(raw) && raw >= 0) return raw
  if (typeof raw !== 'string' || raw.length > 16 || !/^0x(?:0|[1-9a-f][0-9a-f]*)$/i.test(raw)) return stop('wallet_nonce')
  const value = BigInt(raw)
  return value > BigInt(Number.MAX_SAFE_INTEGER) ? stop('wallet_nonce') : Number(value)
}
// The wallet's own view of the account: network and first account before and after, and latest/pending/latest counts that must agree.
export async function readWalletNonceState(provider: CircleProvider, owner: string): Promise<ExecutionNonceState> {
  async function identity() {
    if (walletQuantity(await walletRead(provider, 'eth_chainId')) !== CIRCLE_CHAIN_ID) stop('wallet_nonce')
    const accounts = await walletRead(provider, 'eth_accounts')
    if (!Array.isArray(accounts) || !accounts.every(a => typeof a === 'string' && ADDRESS.test(a)) || !same(accounts[0], owner)) stop('wallet_nonce')
  }
  await identity()
  const before = walletQuantity(await walletRead(provider, 'eth_getTransactionCount', [owner, 'latest']))
  const nonce = walletQuantity(await walletRead(provider, 'eth_getTransactionCount', [owner, 'pending']))
  const latestNonce = walletQuantity(await walletRead(provider, 'eth_getTransactionCount', [owner, 'latest']))
  if (before !== latestNonce || nonce < latestNonce) throw new ExecutionNonceObservationError('wallet', Math.max(before, nonce, latestNonce), before !== latestNonce ? 'latest-changed' : 'pending-behind-latest')
  await identity()
  return { nonce, latestNonce }
}
// Parameters for SwapKit.swap. batchTransactions is false and the guarded wallet has no EIP-5792 methods: approval and swap are separate
// wallet confirmations. stopLimit repeats the Review's guaranteed minimum so the service cannot quote a lower floor.
export function buildCircleSwapParams(review: CircleSwapReview, adapter: unknown): Record<string, unknown> {
  const request = validateCircleRequest(review.request), tokenIn = swapToken(request.tokenIn), tokenOut = swapToken(request.tokenOut)
  return {
    // No explicit address: the SDK refuses one for a user-controlled adapter and resolves it from the wallet; the guard checks it is the reviewed owner.
    from: { adapter, chain: 'Arc' }, tokenIn: tokenIn.address, tokenOut: tokenOut.address, amountIn: request.amount,
    config: { slippageBps: request.slippageBps, allowanceStrategy: circleStrategy(request), batchTransactions: false, stopLimit: formatUnits(uint(review.requiredMinimum), tokenOut.decimals) },
  }
}
export const circleGuardPolicy = (review: CircleSwapReview, now: () => number, feeBudget: () => bigint): CircleGuardPolicy => {
  const request = validateCircleRequest(review.request)
  return { owner: request.owner as Hex, adapter: CIRCLE_ADAPTER, inputToken: swapToken(request.tokenIn).address as Hex, outputToken: swapToken(request.tokenOut).address as Hex,
    amountIn: uint(review.amountIn), minimumOut: uint(review.requiredMinimum), strategy: circleStrategy(request), chainId: CIRCLE_CHAIN_ID,
    now, maxFeePerGas: uint(review.maxFeePerGas), maxPriorityFeePerGas: uint(review.maxPriorityFeePerGas), feeBudget, maxFeeUnits: providerFeeUnits(review) }
}
// The strategy a request resolves to. Stored Reviews always carry it explicitly; this keeps any older record readable.
export const circleStrategy = (request: Pick<CircleSwapRequest, 'tokenIn' | 'allowanceStrategy'>): CircleStrategy => request.allowanceStrategy ?? (request.tokenIn === 'USDC' ? 'permit' : 'approve')
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))
const guardCode = (error: unknown): string => {
  if (error instanceof CircleGuardError) return error.code
  const code = error instanceof Error ? error.message : ''
  return ['writes_disabled', 'pilot_restricted', 'context', 'nonce', 'nonce_rpc', 'nonce_pending', 'nonce_regression', 'public_nonce', 'wallet_nonce', 'storage', 'lock', 'busy', 'busy_other', 'smart_wallet', 'expired',
    'insufficient_input_balance', 'insufficient_gas', 'adapter_identity', 'approval_failed', 'approval_pending', 'approval_missing', 'simulation', 'simulation_outcome', 'price_check', 'price_check_unavailable', 'fee_ceiling', 'step_declined', 'step_timeout'].includes(code) ? code
    : ['deadline', 'quote_expired'].includes(code) ? 'expired' : 'preflight'
}

// --- Controller -------------------------------------------------------------------------------------------------------------
interface Deferred<T> { promise: Promise<T>; resolve(value: T): void }
const deferred = <T>(): Deferred<T> => { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r }); return { promise, resolve } }

// No preview object, DOM state or localStorage value can be passed to confirm as transaction authority.
export function createCircleSwapExecution(ports: CirclePorts) {
  const journal = createCircleJournal(ports.storage, id => unverified.has(id))
  const enabled = ports.enabled ?? (() => CIRCLE_SWAP_WRITES_ENABLED)
  const pause = ports.pause ?? sleep
  let view: CircleView = { phase: 'idle' }, version = 0, busy = false, tracking = false, sending = false
  // A settled record whose chain re-check failed in this session keeps its recorded status, but still blocks a new send until it is
  // re-verified: a stored status is a record, not a fresh observation.
  const unverified = new Set<string>(), failures = new Map<string, number>()
  // Why a swap was not requested, kept for the moment the approval that did go out is resolved (the explanation must survive that update).
  const reasons = new Map<string, string>()
  const blocking = (a: CircleSwapAttempt) => unresolved(a) || unverified.has(a.id)
  const withLog = (a: CircleSwapAttempt, status: AttemptStatus, note: string, at = Date.now(), force = false): CircleSwapAttempt => {
    if (!force && a.status === status && a.log && a.log.length > 0) return { ...a, status }
    return { ...a, status, log: [...(a.log ?? []), { at, status, note: note.slice(0, 290) }].slice(-40) }
  }
  interface Selected { id: string; review: CircleSwapReview; nonce: number; context: string; version: number }
  let intent: Selected | null = null
  let stepGate: { step: CircleStepInfo; resolve(): void; reject(error: unknown): void; timer: ReturnType<typeof setTimeout>; selected: Selected } | null = null
  const contextKey = () => { const c = ports.context(); return JSON.stringify([c.owner.toLowerCase(), c.connected, c.chainId, c.connectorId]) }
  function emit(next: CircleView) { view = structuredClone(next); try { ports.changed?.(structuredClone(view)) } catch { /* An observer cannot interrupt recording. */ } }
  function requireEnabled() {
    if (!enabled()) stop('writes_disabled')
    if (!ports.authorize?.(ports.input(), ports.context())) stop('pilot_restricted')
  }
  const outstanding = (owner: string, memory?: CircleSwapAttempt): CircleSwapAttempt | 'elsewhere' | undefined => {
    const persisted = journal.read(owner).find(blocking)
    const inMemory = memory && same(memory.review.request.owner, owner) && unresolved(memory) ? memory : undefined
    if (inMemory ?? persisted) return inMemory ?? persisted
    return ports.blockedElsewhere?.(owner) ? 'elsewhere' : undefined
  }
  // The identity of the Review at the moment it may open a wallet request. The quote's freshness is only required to START the flow:
  // each later step is judged by the guard against the Review's guaranteed minimum, not by the age of the quote.
  function sameContext(selected: Selected) {
    const input = ports.input()
    if (selected.version !== version || contextKey() !== selected.context || !input || circleRequestKey(input) !== circleRequestKey(selected.review.request)) stop('context')
  }
  function ready(selected: Selected) {
    requireEnabled(); sameContext(selected)
    validateCircleReview(selected.review, ports.context(), ports.now())
    independentPriceCheck(selected.review)
    if (selected.review.expiresAt - ports.now() < 5000) stop('expired')
  }
  function failureMessage(error: unknown, stage: 'Review' | 'Confirm') {
    const code = guardCode(error), message = circleSwapMessage(code)
    if (!['nonce', 'nonce_rpc', 'nonce_pending', 'nonce_regression', 'public_nonce', 'wallet_nonce'].includes(code)) return message
    const detail = error instanceof ExecutionNonceObservationError && error.message === 'wallet_nonce' ? ` The wallet RPC returned inconsistent latest/pending observations (${error.reason === 'latest-changed' ? 'latest changed during the reads' : 'pending was below latest'}).` : ''
    return `${stage} nonce check: ${message}${detail}`
  }
  // Public RPC and wallet RPC must agree on the account nonce, with nothing pending. One bounded recheck can reconcile a moving head.
  interface NonceOptions { expected?: number; preflight?: boolean; feeLeft?: bigint; expiry?: boolean }
  async function checkedNonce(selected: Selected, provider: CircleProvider, { expected, preflight = true, feeLeft, expiry = true }: NonceOptions = {}) {
    let highestObserved = -1
    // Quote freshness is required to start a flow, not to continue one; identity, context and the guard's own checks apply to every step.
    const still = () => { if (expiry) ready(selected); else { requireEnabled(); sameContext(selected) } }
    for (let pass = 0; pass < 2; pass++) {
      try {
        still()
        if (preflight) evaluatePreflight(selected.review, await ports.preflight(structuredClone(selected.review)), feeLeft)
        const owner = selected.review.request.owner
        const publicState = await ports.publicNonce(owner)
        if (!isNonce(publicState.nonce) || !isNonce(publicState.latestNonce) || publicState.nonce < publicState.latestNonce) stop('public_nonce')
        highestObserved = Math.max(highestObserved, publicState.nonce)
        still()
        const walletState = await readWalletNonceState(provider, owner)
        highestObserved = Math.max(highestObserved, walletState.nonce)
        still()
        if (publicState.nonce === walletState.nonce && walletState.nonce < highestObserved) stop('nonce_regression')
        return reconcileExecutionNonce(publicState, walletState, expected)
      } catch (error) {
        const code = error instanceof Error ? error.message : ''
        if (error instanceof ExecutionNonceObservationError && isNonce(error.highestObserved)) highestObserved = Math.max(highestObserved, error.highestObserved)
        if (pass === 0 && (code === 'nonce_rpc' || error instanceof ExecutionNonceObservationError)) continue
        throw error
      }
    }
    return stop('nonce_rpc')
  }
  async function prepare() {
    if (busy || tracking) return
    busy = true
    const currentVersion = ++version
    intent = null
    try {
      requireEnabled()
      const input = validateCircleRequest(ports.input()), expectedContext = contextKey()
      const found = outstanding(input.owner, view.attempt)
      if (found) {
        emit(found === 'elsewhere' ? { phase: 'idle', error: circleSwapMessage('busy_other') } : { phase: found.hash ? 'pending' : 'unknown', attempt: found, error: circleSwapMessage('busy') })
        return
      }
      emit({ phase: 'preparing' })
      const fresh = await ports.fresh(input)
      if (currentVersion !== version || contextKey() !== expectedContext || !ports.input() || circleRequestKey(ports.input()!) !== circleRequestKey(input) || circleRequestKey(fresh.request) !== circleRequestKey(input)) stop('context')
      validateCircleReview(fresh, ports.context(), ports.now())
      independentPriceCheck(fresh)
      const selected: Selected = { id: crypto.randomUUID(), review: structuredClone(fresh), nonce: 0, context: expectedContext, version: currentVersion }
      const provider = await ports.provider()
      selected.nonce = await checkedNonce(selected, provider)
      ready(selected)
      intent = selected
      emit({ phase: 'review', approvalId: selected.id, review: selected.review })
    } catch (error) { if (currentVersion === version) emit({ phase: 'idle', error: failureMessage(error, 'Review') }) }
    finally { busy = false }
  }

  // One run of the SDK for one attempt. Everything the SDK asks of the wallet passes through the hooks below.
  interface Run { attempt: CircleSwapAttempt; selected: Selected; provider: CircleProvider; swapSettled: Deferred<void>; stalled: Deferred<void>; lastCode?: string; walletTimer?: ReturnType<typeof setTimeout>; stallTimer?: ReturnType<typeof setTimeout> }
  // The SDK cannot be cancelled, so a flow that is waiting for it (the quote service, a receipt) is ended after a while with nothing open:
  // not while the user is at a confirmation or a wallet request is open (those have their own windows). Whatever was already submitted
  // stays recorded and tracked; the guard is sealed, so the SDK can send nothing afterwards.
  const armStall = (run: Run, ms: number) => { disarmStall(run); run.stallTimer = setTimeout(() => { run.stallTimer = undefined; if (!stepGate && !run.walletTimer) run.stalled.resolve() }, ms) }
  function disarmStall(run: Run) { if (run.stallTimer !== undefined) { clearTimeout(run.stallTimer); run.stallTimer = undefined } }
  const committedFee = (steps: CircleStepRecord[]) => steps.reduce((sum, step) => {
    if (!step.hash) return sum
    if (step.fee !== undefined) return sum + uint(step.fee)
    return sum + (step.gasLimit !== undefined && step.maxFee !== undefined ? uint(step.gasLimit) * uint(step.maxFee) : 0n)
  }, 0n)
  const saveStrict = (attempt: CircleSwapAttempt) => { try { journal.save(attempt) } catch { stop('storage') } }
  function clearWalletTimer(run: Run) { if (run.walletTimer !== undefined) { clearTimeout(run.walletTimer); run.walletTimer = undefined } }
  function setStep(run: Run, index: number, patch: Partial<CircleStepRecord>) {
    run.attempt = { ...run.attempt, steps: run.attempt.steps.map(step => (step.index === index ? { ...step, ...patch } : step)) }
  }
  function hooksFor(run: Run): CircleGuardHooks {
    return {
      gate(step) {
        disarmStall(run)
        return new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => { if (stepGate?.timer === timer) stepGate = null; reject(new CircleGuardError('step_timeout')) }, STEP_CONFIRM_TIMEOUT_MS)
          stepGate = { step, resolve, reject, timer, selected: run.selected }
          emit({ phase: 'awaiting_step', attempt: run.attempt, step, stepWindowMs: STEP_CONFIRM_TIMEOUT_MS })
        })
      },
      async before(step, { gas, data }): Promise<CircleStepPlan> {
        requireEnabled(); sameContext(run.selected)
        const review = run.selected.review, owner = review.request.owner as Hex
        const strategy = circleStrategy(review.request)
        // The swap follows an approval only once the chain shows that approval succeeded (the SDK does not check its status).
        if (step.kind === 'swap' && strategy === 'approve') {
          const approve = run.attempt.steps.find(item => item.kind === 'approve')
          if (!approve?.hash) stop('approval_missing')
          let state: CircleApprovalState = { status: 'pending' }
          for (let poll = 0; poll < APPROVAL_POLLS; poll++) {
            state = await ports.approval(structuredClone(run.attempt), structuredClone(approve!))
            if (state.status !== 'pending') break
            await pause(APPROVAL_POLL_MS)
          }
          if (state.status === 'pending') stop('approval_pending')
          const checked = { ...run.attempt, steps: run.attempt.steps.map(item => (item.index === approve!.index ? { ...item, status: state.status, fee: state.status === 'pending' ? undefined : state.fee } : item)) }
          saveStrict(checked)
          run.attempt = checked
          if (state.status !== 'confirmed') stop('approval_failed')
        }
        const last = run.attempt.steps[run.attempt.steps.length - 1]
        const nonce = await checkedNonce(run.selected, run.provider, { expected: last ? last.nonce + 1 : run.selected.nonce, preflight: step.kind === 'swap', feeLeft: uint(review.networkFee) - committedFee(run.attempt.steps), expiry: false })
        let estimate: bigint
        try { estimate = await ports.estimateGas({ from: owner, to: step.to, data, value: 0n }) } catch { return stop('simulation') }
        if (estimate <= 0n) stop('simulation')
        // The exact swap, run against the live adapter with the wallet's real balances and the approval that is now on chain: what would be
        // received and spent. The adapter's own minimum is thereby checked before the wallet is asked, not only afterwards.
        if (step.kind === 'swap' && strategy === 'approve' && ports.simulate) {
          let outcome: { received: bigint; spent: bigint }
          try { outcome = await ports.simulate(owner, data, swapToken(review.request.tokenIn).address as Hex, swapToken(review.request.tokenOut).address as Hex) } catch { return stop('simulation_outcome') }
          if (outcome.received < uint(review.requiredMinimum) || outcome.spent > uint(review.amountIn)) stop('simulation_outcome')
        }
        // The last await is behind us: the flow must still be the reviewed one, enabled and unchanged, before anything is journaled for the wallet.
        requireEnabled(); sameContext(run.selected)
        const limit = gas !== null && gas >= estimate ? gas : bufferedGas(estimate)
        const plan: CircleStepPlan = { nonce, gas: limit, maxFeePerGas: uint(review.maxFeePerGas), maxPriorityFeePerGas: uint(review.maxPriorityFeePerGas) }
        if (limit * plan.maxFeePerGas > uint(review.networkFee) - committedFee(run.attempt.steps)) stop('fee_ceiling')
        // The step is journaled as awaiting_wallet BEFORE the wallet can be contacted; a failed write stops the flow here.
        // Only the journaled fields: the guard's display-only extras (planned fee text) are not part of the record.
        const record: CircleStepRecord = { index: step.index, kind: step.kind, to: step.to, token: step.token, amount: step.amount, dataHash: step.dataHash, nonce, status: 'awaiting_wallet', at: Date.now(),
          gasLimit: limit.toString(), maxFee: plan.maxFeePerGas.toString(), maxTip: plan.maxPriorityFeePerGas.toString(),
          ...(step.spender !== undefined ? { spender: step.spender } : {}), ...(step.minimumOut !== undefined ? { minimumOut: step.minimumOut } : {}), ...(step.deadline !== undefined ? { deadline: step.deadline } : {}) }
        const journaledAttempt = withLog({ ...run.attempt, steps: [...run.attempt.steps, record] }, 'awaiting_wallet', `${step.kind} step: waiting for the wallet.`)
        saveStrict(journaledAttempt)
        run.attempt = journaledAttempt // in memory only once it is durable: a step that could not be recorded was never requested
        const windowMs = step.kind === 'swap' && step.deadline !== undefined ? Math.max(CIRCLE_MIN_SWAP_WINDOW_MS, step.deadline * 1000 - ports.now() - CIRCLE_MINING_BUFFER_MS) : APPROVAL_WALLET_WINDOW_MS
        sending = true
        emit({ phase: 'awaiting_wallet', attempt: run.attempt, walletWindowMs: windowMs, walletRequestOpen: true })
        // EIP-1193 cannot cancel an open request. Stop presenting it as approvable at the cutoff, but keep observing it so a late hash is
        // recorded. A timeout never authorises another send.
        run.walletTimer = setTimeout(() => {
          const open = run.attempt.steps.find(item => item.index === step.index)
          if (!open || open.status !== 'awaiting_wallet') return
          setStep(run, step.index, { status: 'unknown' }); run.attempt = withLog(run.attempt, 'unknown', 'The wallet approval window ended without an answer.')
          emit({ phase: 'unknown', attempt: run.attempt, error: circleSwapMessage('wallet_timeout'), walletRequestOpen: true })
          try { journal.save(run.attempt) } catch { /* The original durable awaiting_wallet record still blocks a retry. */ }
        }, windowMs)
        disarmStall(run)
        return plan
      },
      sent(step, hash) {
        clearWalletTimer(run)
        setStep(run, step.index, { status: 'pending', hash })
        run.attempt = withLog(step.kind === 'swap' ? { ...run.attempt, hash } : run.attempt, 'pending', step.kind === 'swap' ? 'Swap transaction submitted; waiting for inclusion.' : 'Approval submitted; waiting for inclusion.')
        sending = step.kind !== 'swap'
        emit({ phase: 'pending', attempt: run.attempt }) // Never lose the hash to a later RPC or storage error.
        try { journal.save(run.attempt) } catch { emit({ phase: 'pending', attempt: run.attempt, error: circleSwapMessage('storage') }) }
        if (step.kind === 'swap') run.swapSettled.resolve(); else armStall(run, CIRCLE_STALL_AFTER_APPROVAL_MS)
      },
      failed(step, outcome: CircleStepOutcome, error) {
        // A request refused before it had a step of its own (misclassified, repeated, out of order) touches no record and no open wallet
        // request; it only explains why the SDK stopped.
        if (outcome === 'refused') { if (!run.lastCode) run.lastCode = guardCode(error); return }
        clearWalletTimer(run)
        // A signature has no on-chain effect: whatever went wrong with it, nothing was sent, so it is never an "unknown" outcome that would lock the wallet.
        run.lastCode = outcome === 'rejected' ? 'rejected' : outcome === 'unknown' ? (step.kind === 'permit' ? 'permit_failed' : 'unknown') : guardCode(error)
        const recorded = run.attempt.steps.find(item => item.index === step.index && item.kind === step.kind && item.status !== 'rejected')
        // `blocked` after the step was journaled means the wallet was never contacted; before that nothing was journaled at all.
        if (recorded && recorded.status !== 'pending' && recorded.status !== 'confirmed') {
          setStep(run, recorded.index, { status: outcome === 'unknown' ? 'unknown' : 'rejected' })
          try { journal.save(run.attempt) } catch { /* The earlier awaiting_wallet record still blocks. */ }
        }
        sending = false
        if (step.kind === 'swap') run.swapSettled.resolve(); else armStall(run, CIRCLE_STALL_AFTER_FAILURE_MS)
      },
    }
  }

  async function confirm(approvalId: string) {
    if (busy || tracking || !intent || view.phase !== 'review' || approvalId !== intent.id) return
    busy = true
    const selected = intent
    let run: Run | undefined, journaled = false
    try {
      ready(selected)
      emit({ phase: 'checking', approvalId, review: selected.review })
      await ports.lock(selected.review.request.owner, async () => {
        ready(selected)
        const found = outstanding(selected.review.request.owner)
        if (found) stop(found === 'elsewhere' ? 'busy_other' : 'busy')
        const provider = await ports.provider()
        await checkedNonce(selected, provider, { expected: selected.nonce })
        ready(selected)
        const record: CircleSwapAttempt = { id: selected.id, review: structuredClone(selected.review), createdAt: Date.now(), status: 'awaiting_wallet', steps: [] }
        journal.save(record) // The intent is durable BEFORE the SDK or the wallet are touched.
        journaled = true
        const current: Run = { attempt: record, selected, provider, swapSettled: deferred<void>(), stalled: deferred<void>() }
        run = current
        armStall(current, CIRCLE_STALL_BEFORE_STEP_MS)
        intent = null; sending = true
        const feeBudget = () => uint(selected.review.networkFee) - committedFee(current.attempt.steps)
        const guarded = createGuardedWalletClient((ports.wallet ?? viemInnerWallet)(provider, selected.review.request.owner as Hex), circleGuardPolicy(selected.review, ports.now, feeBudget), hooksFor(current))
        let finished: 'done' | 'error' = 'done'
        try {
          const { kit, adapter } = await ports.sdk(guarded)
          // The SDK keeps polling Circle's own status service after the swap is sent. The application does not depend on it: once the swap
          // hash is journaled the chain is the only source, so the wait ends there and the SDK is left to finish (or fail) on its own.
          const sdkRun = Promise.resolve().then(() => kit.swap(buildCircleSwapParams(selected.review, adapter))).then(() => 'done' as const, () => 'error' as const)
          finished = await Promise.race([sdkRun, current.swapSettled.promise.then(() => 'done' as const), current.stalled.promise.then(() => { current.lastCode ??= 'sdk_stalled'; return 'error' as const })])
        } catch { finished = 'error' } finally { guarded.seal(); disarmStall(current) }
        clearWalletTimer(current)
        sending = false
        finalizeUnsent(current, finished)
      })
    } catch (error) {
      intent = null
      sending = false
      if (!journaled) emit({ phase: 'idle', error: failureMessage(error, 'Confirm') })
      else if (run) finalizeUnsent(run, 'error', guardCode(error))
    } finally { busy = false }
    const finalAttempt = run?.attempt
    if (finalAttempt && (finalAttempt.hash || finalAttempt.steps.some(step => step.hash && step.status === 'pending'))) await reconcile(finalAttempt.review.request.owner, undefined, finalAttempt.id)
  }
  // The flow ended. A swap hash means the chain takes over; without one, the record says exactly what did and did not happen.
  function finalizeUnsent(run: Run, finished: 'done' | 'error', code?: string) {
    const attempt = run.attempt
    if (attempt.hash) return
    const reason = code ?? run.lastCode ?? (finished === 'error' ? 'sdk_failed' : 'unknown')
    const uncertain = attempt.steps.some(step => step.status === 'unknown' || step.status === 'awaiting_wallet') || reason === 'unknown'
    const waiting = attempt.steps.some(step => step.hash && step.status === 'pending')
    let next: CircleSwapAttempt, phase: AttemptStatus
    if (uncertain) { phase = 'unknown'; next = withLog({ ...attempt }, 'unknown', 'A wallet request was made but its outcome is not known.') }
    else if (attempt.steps.some(step => step.status === 'failed')) { phase = 'failed'; next = withLog({ ...attempt }, 'failed', 'The approval transaction reverted on chain; the swap was never requested.') }
    else if (waiting) { phase = 'pending'; reasons.set(attempt.id, reason); next = withLog({ ...attempt }, 'pending', `The approval was submitted; the swap was not requested. ${circleSwapMessage(reason)}`, Date.now(), true) }
    else {
      const approved = attempt.steps.some(step => step.kind === 'approve' && step.status === 'confirmed')
      phase = 'rejected'; next = withLog({ ...attempt }, 'rejected', `${approved ? 'Approval confirmed on chain; the swap was not requested. ' : ''}${circleSwapMessage(reason)}`)
    }
    run.attempt = next
    try { journal.save(next) } catch { /* The earlier durable record still blocks a retry. */ }
    emit({ phase, attempt: next, error: circleSwapMessage(phase === 'unknown' ? 'unknown' : reason), nextCheckMs: null })
  }

  // The confirmation is for one exact step: a late click that was meant for an earlier step cannot approve the next one.
  const stepKey = (step: CircleStepInfo) => `${step.kind}:${step.index}:${step.dataHash}`
  function continueStep(key?: string) {
    const open = stepGate
    if (!open || view.phase !== 'awaiting_step') return
    if (key !== undefined && key !== stepKey(open.step)) return
    stepGate = null; clearTimeout(open.timer)
    // The wallet, network or inputs may have changed while the confirmation was open: then the step is declined, never sent.
    try { sameContext(open.selected); open.resolve() } catch { open.reject(new CircleGuardError('step_declined', 'context')) }
  }
  function cancelStep() {
    const open = stepGate
    if (!open) return
    stepGate = null; clearTimeout(open.timer)
    open.reject(new CircleGuardError('step_declined'))
  }

  async function reconcile(owner = ports.context().owner, recoveredHash?: string, attemptId?: string) {
    if (busy || tracking || !/^0x[a-fA-F0-9]{40}$/.test(owner)) return
    tracking = true
    try {
      await ports.lock(owner, async () => {
        const records = journal.read(owner)
        const stored = attemptId ? records.find(a => a.id === attemptId) : [...records].reverse().find(blocking) ?? records[records.length - 1]
        if (!stored || stored.status === 'rejected') return
        let attempt = stored
        // A swap hash the wallet returned but the journal could not record is still tracked from memory (it is bound to nonce, sender and
        // calldata when the chain is read, so adopting it is safe); the record is written again with the result.
        const memory = view.attempt
        if (memory && memory.id === stored.id && memory.hash && !stored.hash) attempt = structuredClone(memory)
        // The lock is held, so no flow of this wallet is running in any tab. A record with no wallet transaction step and no hash proves that no
        // transaction was ever requested (every transaction step is journaled before the wallet is contacted; a permit is only a signature):
        // the page was closed, or the flow stopped, before the first wallet request. It is closed, not left to lock the wallet out.
        if (!attempt.hash && attempt.steps.length === 0 && recoveredHash === undefined && !sending && (attempt.status === 'awaiting_wallet' || attempt.status === 'unknown')) {
          const closed = withLog({ ...attempt }, 'rejected', 'The page was closed, or the flow stopped, before any wallet transaction was requested. Nothing was sent.')
          try { journal.save(closed) } catch { emit({ phase: 'unknown', attempt, error: circleSwapMessage('storage'), nextCheckMs: null }); return }
          unverified.delete(closed.id)
          emit({ phase: 'rejected', attempt: closed, nextCheckMs: null, error: circleSwapMessage('closed_before_wallet') })
          return
        }
        // `base` is what is recorded (plus a hash the wallet itself returned). A hash the user typed is `unrecorded` until the network has shown
        // that exact transaction: a mistyped or foreign hash must never replace the means of finding the real one.
        let base = attempt
        let unrecorded = false, replaced: Hex | undefined
        const swapStep = attempt.steps.find(step => step.kind === 'swap')
        if (recoveredHash !== undefined) {
          const known = attempt.hash ?? swapStep?.hash
          if (!isTransactionHash(recoveredHash) || !swapStep) throw new ExecutionVerificationError('binding', false)
          if (known && lc(known) !== lc(recoveredHash)) {
            // A different hash can take over only when the recorded one provably cannot execute any more: unknown to the node AND its nonce
            // already used by another transaction. The new hash is then verified like any other (sender, nonce, calldata, fees, minimum).
            const probe = await ports.result(structuredClone({ ...attempt, hash: known }))
            if (!(probe.status === 'pending' && probe.identified === false && probe.nonceUsed === true)) throw new ExecutionVerificationError('binding', false)
            replaced = known
          }
          unrecorded = !known || replaced !== undefined
          attempt = { ...attempt, hash: recoveredHash, steps: attempt.steps.map(step => (step.kind === 'swap' ? { ...step, hash: recoveredHash, status: 'pending' as const } : step)) }
        }
        if (!attempt.hash) {
          // No swap hash. Either an approval-only attempt (the SDK flow did not survive) or a wallet request whose answer is unknown.
          if (attempt.steps.some(step => step.status === 'unknown' || step.status === 'awaiting_wallet')) { emit({ phase: 'unknown', attempt, error: circleSwapMessage('unknown'), nextCheckMs: null }); return }
          const approve = attempt.steps.find(step => step.kind === 'approve' && step.hash && step.status === 'pending')
          if (!approve) { emit({ phase: attempt.status, attempt, nextCheckMs: null }); return }
          emit({ phase: 'pending', attempt, checking: true, nextCheckMs: null, observedAt: view.observedAt })
          try {
            const state = await ports.approval(structuredClone(attempt), structuredClone(approve))
            const observedAt = Date.now()
            if (state.status === 'pending') { emit({ phase: 'pending', attempt, checking: false, nextCheckMs: PENDING_CHECK_MS, observedAt }); return }
            const steps = attempt.steps.map(step => (step.index === approve.index ? { ...step, status: state.status, fee: state.fee } : step))
            const done = withLog({ ...attempt, steps }, state.status === 'confirmed' ? 'rejected' : 'failed',
              state.status === 'confirmed' ? 'Approval confirmed on chain; the swap was never requested.' : 'The approval transaction reverted; the swap was never requested.', observedAt)
            journal.save(done); unverified.delete(done.id)
            const why = reasons.get(done.id)
            emit({ phase: done.status, attempt: done, checking: false, nextCheckMs: null, observedAt, ...(why ? { error: circleSwapMessage(why) } : {}) })
          } catch { emit({ phase: 'pending', attempt, checking: false, nextCheckMs: TRANSIENT_CHECK_DELAYS_MS[0], error: circleSwapMessage('verification'), observedAt: view.observedAt }) }
          return
        }
        emit({ phase: attempt.status === 'awaiting_wallet' ? 'unknown' : attempt.status, attempt, checking: true, nextCheckMs: null, observedAt: view.attempt?.id === attempt.id ? view.observedAt : undefined })
        // The record of a replacement keeps the earlier hash in its log, so nothing about the first attempt is lost.
        const withReplacement = (a: CircleSwapAttempt, at: number): CircleSwapAttempt => replaced === undefined ? a
          : { ...a, log: [...(a.log ?? []), { at, status: a.status, note: `Tracked under the hash you supplied. The previously recorded hash ${replaced} is unknown to the network and its nonce was used by another transaction.`.slice(0, 290) }].slice(-40) }
        try {
          const result = await ports.result(structuredClone(attempt), intent => {
            if (unrecorded || !unresolved(attempt) || !['mismatch', 'unbound'].includes(intent.verdict)) return
            attempt = { ...attempt, intent }
            journal.save(attempt)
            base = attempt
            emit({ ...view, attempt })
          })
          const observedAt = Date.now()
          if (result.status === 'pending') {
            failures.delete(attempt.id)
            if (unrecorded && result.identified !== true) {
              // Nothing is saved: the recorded state (and the means to find the real transaction) stays exactly as it was.
              emit({ phase: base.status === 'awaiting_wallet' ? 'unknown' : base.status, attempt: base, checking: false, nextCheckMs: null, error: circleSwapMessage('recovery_unknown'), observedAt: view.observedAt, ...(replaced ? { replaced: true } : {}) })
              return
            }
            // A reorg of a formerly settled record must become durable Pending again, blocking another send.
            unverified.delete(attempt.id)
            const pending = withReplacement(withLog({ ...attempt, status: attempt.status }, 'pending', 'Waiting for inclusion and two observed blocks.', observedAt), observedAt)
            journal.save(pending)
            const gone = result.identified === false && result.nonceUsed === true
            emit({ phase: 'pending', attempt: pending, checking: false, nextCheckMs: PENDING_CHECK_MS, observedAt, ...(gone ? { replaced: true, error: circleSwapMessage('replaced') } : {}) })
            return
          }
          const verified = isIntentVerified(result.intent.verdict)
          const status: AttemptStatus = result.chain.state === 'reverted' ? 'failed' : verified ? 'confirmed' : result.intent.verdict === 'mismatch' ? 'mismatch' : 'unknown'
          const steps = attempt.steps.map(step => {
            const approval = result.approvals.find(item => item.index === step.index)
            if (approval) return { ...step, status: approval.status === 'pending' ? step.status : approval.status, fee: approval.fee }
            return step.kind === 'swap' && status !== 'unknown' ? { ...step, status: (result.chain.state === 'reverted' ? 'failed' : 'confirmed') as CircleStepStatus, fee: result.chain.fee } : step
          })
          if (status === 'unknown') {
            // The chain answered (success) but the evidence needed to compare it with the Review is incomplete. The chain facts are kept and shown;
            // nothing about the Review is claimed. It stays unresolved (blocks a new send) and is re-read with growing pauses that end.
            const count = (failures.get(attempt.id) ?? 0) + 1
            failures.set(attempt.id, count)
            const wait = count < MAX_AUTOMATIC_CHECK_FAILURES ? TRANSIENT_CHECK_DELAYS_MS[Math.min(count - 1, TRANSIENT_CHECK_DELAYS_MS.length - 1)] : null
            const incomplete = withReplacement(withLog({ ...attempt, steps, output: result.output, fee: result.fee, chain: result.chain, intent: result.intent }, 'unknown', 'Chain success; evidence to compare with the Review is incomplete. Nothing is claimed.', observedAt), observedAt)
            journal.save(incomplete)
            unverified.delete(attempt.id)
            emit({ phase: 'unknown', attempt: incomplete, checking: false, nextCheckMs: wait, observedAt, error: circleSwapMessage(wait === null ? 'verification_stopped' : 'verification') })
            return
          }
          if (status === 'confirmed' && (uint(result.fee) > uint(attempt.review.networkFee) || uint(result.output) < uint(attempt.review.requiredMinimum))) throw new ExecutionVerificationError('malformed', false)
          const note = status === 'confirmed' ? (result.intent.verdict === 'verified_with_notes' ? 'Chain success; matches the Review (wallet adjusted gas fields within the approved ceiling).' : 'Chain success; matches the Review.')
            : status === 'failed' ? `Chain: the swap transaction reverted.${attempt.steps.some(step => step.kind === 'approve' && step.status === 'confirmed') ? ' The exact approval stays in place.' : ''}` : `Chain success; not the reviewed transaction: ${result.intent.differences[0] ?? 'see the intent checks'}`
          const next = withReplacement(withLog({ ...attempt, steps, output: result.output, fee: result.fee, chain: result.chain, intent: result.intent }, status, note, observedAt), observedAt)
          failures.delete(attempt.id)
          journal.save(next)
          unverified.delete(attempt.id)
          emit({ phase: status, attempt: next, checking: false, nextCheckMs: null, observedAt, ...(status === 'mismatch' ? { error: circleSwapMessage('mismatch') } : {}) })
          try { ports.settled?.(structuredClone(next)) } catch { /* Balance refresh cannot change chain truth. */ }
        } catch (error) {
          const deterministic = error instanceof ExecutionVerificationError && !error.retryable
          const storageFailure = error instanceof Error && error.message === 'storage'
          const count = (failures.get(attempt.id) ?? 0) + 1
          failures.set(attempt.id, count)
          const automatic = !deterministic && count < MAX_AUTOMATIC_CHECK_FAILURES
          const delay = automatic ? TRANSIENT_CHECK_DELAYS_MS[Math.min(count - 1, TRANSIENT_CHECK_DELAYS_MS.length - 1)] : null
          const message = circleSwapMessage(storageFailure ? 'storage' : deterministic ? 'verification_binding' : automatic ? 'verification' : 'verification_stopped')
          if ((TERMINAL.includes(attempt.status) || attempt.status === 'pending') && !deterministic) {
            // A read failure teaches nothing about the chain. A settled record is not downgraded, and a Pending transaction stays Pending: the last
            // known status remains on screen (with the reason it could not be refreshed), it keeps blocking new sends until the chain is read again.
            unverified.add(attempt.id)
            emit({ phase: attempt.status, attempt: base, checking: false, nextCheckMs: delay, error: message, observedAt: view.observedAt })
          } else {
            const unknown = withLog({ ...attempt }, 'unknown', deterministic ? 'The hash does not identify the reviewed transaction.' : 'The chain could not be read; outcome not yet verified.')
            // Do not persist an unverified recovery hash; keep the original record recoverable.
            if (!unrecorded) { try { journal.save(unknown) } catch { /* The previous unresolved record remains. */ } }
            emit({ phase: 'unknown', attempt: unrecorded ? base : unknown, checking: false, nextCheckMs: delay, error: message, observedAt: view.observedAt })
          }
        }
      })
    } catch (error) {
      // A temporarily held cross-tab lock does not turn a transaction into a failure.
      if (!(error instanceof Error && error.message === 'lock')) emit({ ...view, checking: false, error: circleSwapMessage(error instanceof ExecutionVerificationError ? (error.retryable ? 'verification' : 'verification_binding') : error instanceof Error && error.message === 'verification' ? 'verification' : 'storage') })
    } finally { tracking = false }
  }
  // The page was hidden. A Review that is merely open is dropped; a flow already in progress is left alone: a wallet app in the foreground hides
  // the page, and ending the flow then would strand an approval that was already paid for.
  function hidden() { if (busy || sending) return; invalidate() }
  function invalidate() {
    version++; intent = null
    // A confirmation that is still waiting for the user belongs to a Review that no longer applies; nothing has reached the wallet.
    cancelStep()
    if (!sending && !['pending', 'unknown', 'confirmed', 'failed', 'rejected', 'mismatch', 'awaiting_step', 'awaiting_wallet'].includes(view.phase)) emit({ phase: 'idle' })
  }
  return { prepare, confirm, continueStep, cancelStep, reconcile, invalidate, hidden, stepKey, history: (owner = ports.context().owner) => journal.read(owner), current: () => structuredClone(view),
    // True while a record of this wallet is unresolved or could not be re-verified in this session. Unreadable storage counts as blocking.
    blocking: (owner: string) => { try { return journal.read(owner).some(blocking) } catch { return true } } }
}

// --- Chain reads (read-only) ----------------------------------------------------------------------------------------------
export function assertCircleExecutionReadMethod(method: string) {
  if (!['eth_chainId', 'eth_blockNumber', 'eth_getCode', 'eth_getBalance', 'eth_call', 'eth_estimateGas', 'eth_gasPrice', 'eth_feeHistory', 'eth_maxPriorityFeePerGas',
    'eth_getTransactionCount', 'eth_getTransactionByHash', 'eth_getTransactionReceipt', 'eth_getBlockByNumber', 'eth_getBlockByHash', 'eth_getStorageAt'].includes(method)) throw new Error('read_only_rpc')
}
const SIMULATION_CALLER: Hex = '0x00000000000000000000000000000000000abc01'
const SIMULATION_GAS = 0x4000000n
const APPROVAL_TOPIC = keccak256(new TextEncoder().encode('Approval(address,address,uint256)'))
const hash = (value: unknown): value is Hex => typeof value === 'string' && /^0x[a-f0-9]{64}$/i.test(value)
const topicAddress = (topic: string | null | undefined) => (typeof topic === 'string' && /^0x0{24}[0-9a-fA-F]{40}$/.test(topic) ? `0x${topic.slice(-40)}` : null)
const toChainTx = (tx: Awaited<ReturnType<PublicClient['getTransaction']>>): ChainTx => ({ hash: tx.hash, from: tx.from, to: tx.to ?? null, chainId: tx.chainId ?? 0, nonce: tx.nonce, type: tx.type, value: tx.value, gas: tx.gas,
  maxFeePerGas: (tx as { maxFeePerGas?: bigint }).maxFeePerGas ?? 0n, maxPriorityFeePerGas: (tx as { maxPriorityFeePerGas?: bigint }).maxPriorityFeePerGas ?? 0n, input: tx.input })
const toChainReceipt = (receipt: Awaited<ReturnType<PublicClient['getTransactionReceipt']>>): ChainReceipt => ({ transactionHash: receipt.transactionHash, from: receipt.from, to: receipt.to ?? null,
  status: receipt.status === 'success' ? 'success' : 'reverted', blockNumber: receipt.blockNumber, blockHash: receipt.blockHash, transactionIndex: receipt.transactionIndex, gasUsed: receipt.gasUsed,
  effectiveGasPrice: receipt.effectiveGasPrice, logs: receipt.logs as unknown as readonly ChainLog[] })

// The injectable client is a test seam; production passes the pinned, read-only Arc client.
export function createCircleChainRpc(rpc: PublicClient, clock: () => number = Date.now) {
  async function preflight(review: CircleSwapReview): Promise<CirclePreflightFacts> {
    const request = review.request, owner = request.owner as Hex, tokenIn = swapToken(request.tokenIn), tokenOut = swapToken(request.tokenOut)
    const chainId = await rpc.getChainId()
    if (chainId !== CIRCLE_CHAIN_ID) return stop('preflight')
    const blockNumber = await rpc.getBlockNumber({ cacheTime: 0 })
    const [block, adapterCode, inCode, outCode, walletCode, inDecimals, outDecimals, tokenBalance, allowance, nativeBalance, gasPrice] = await Promise.all([
      rpc.getBlock({ blockNumber }), rpc.getCode({ address: CIRCLE_ADAPTER, blockNumber }), rpc.getCode({ address: tokenIn.address as Hex, blockNumber }), rpc.getCode({ address: tokenOut.address as Hex, blockNumber }),
      rpc.getCode({ address: owner, blockNumber }),
      rpc.readContract({ address: tokenIn.address as Hex, abi: erc20Abi, functionName: 'decimals', blockNumber }), rpc.readContract({ address: tokenOut.address as Hex, abi: erc20Abi, functionName: 'decimals', blockNumber }),
      rpc.readContract({ address: tokenIn.address as Hex, abi: erc20Abi, functionName: 'balanceOf', args: [owner], blockNumber }),
      rpc.readContract({ address: tokenIn.address as Hex, abi: erc20Abi, functionName: 'allowance', args: [owner, CIRCLE_ADAPTER], blockNumber }),
      rpc.getBalance({ address: owner, blockNumber }), rpc.getGasPrice(),
    ])
    // The proxy's implementation (EIP-1967 slot) and the code behind it, at the same block.
    const slot = await rpc.getStorageAt({ address: CIRCLE_ADAPTER, slot: CIRCLE_ADAPTER_IMPLEMENTATION_SLOT, blockNumber })
    const implementation = typeof slot === 'string' && /^0x[0-9a-fA-F]{64}$/.test(slot) && /^0{24}/.test(slot.slice(2)) ? `0x${slot.slice(26)}` : null
    const implementationCode = implementation ? await rpc.getCode({ address: implementation as Hex, blockNumber }) : undefined
    return { chainId, blockNumber, blockTimestamp: block.timestamp, walletCode, adapterCodeHash: adapterCode && adapterCode !== '0x' ? keccak256(adapterCode) : null,
      adapterImplementation: implementation, implementationCodeHash: implementationCode && implementationCode !== '0x' ? keccak256(implementationCode) : null,
      tokenCodesPresent: Boolean(inCode && inCode !== '0x' && outCode && outCode !== '0x'), tokenInDecimals: Number(inDecimals), tokenOutDecimals: Number(outDecimals),
      tokenBalance, nativeBalance, allowance, gasPrice, baseFee: typeof block.baseFeePerGas === 'bigint' ? block.baseFeePerGas : null }
  }
  async function publicNonce(owner: string): Promise<ExecutionNonceState> {
    try {
      const before = await rpc.getTransactionCount({ address: owner as Hex, blockTag: 'latest' })
      const nonce = await rpc.getTransactionCount({ address: owner as Hex, blockTag: 'pending' })
      const latestNonce = await rpc.getTransactionCount({ address: owner as Hex, blockTag: 'latest' })
      if (![before, nonce, latestNonce].every(n => Number.isSafeInteger(n) && n >= 0)) throw new Error('public_nonce')
      if (before !== latestNonce || nonce < latestNonce) throw new ExecutionNonceObservationError('public', Math.max(before, nonce, latestNonce))
      return { nonce, latestNonce }
    } catch (error) { if (error instanceof ExecutionNonceObservationError) throw error; throw new Error('public_nonce') }
  }
  async function estimateGas(tx: { from: Hex; to: Hex; data: Hex; value: bigint }) {
    return rpc.estimateGas({ account: tx.from, to: tx.to, data: tx.data, value: tx.value })
  }
  // The read-only test run. The wallet's address temporarily carries the simulation helper's code inside this one eth_call, so the adapter sees
  // the wallet as the caller with its real balance and allowance; the helper reports how the wallet's balances moved. Nothing is sent or signed.
  async function simulate(owner: Hex, data: Hex, tokenIn: Hex, tokenOut: Hex): Promise<{ received: bigint; spent: bigint }> {
    const call = encodeFunctionData({ abi: SIMULATOR_ABI, functionName: 'simulate', args: [CIRCLE_ADAPTER, data, 0n, tokenIn, tokenOut, '0x0000000000000000000000000000000000000000', 0n] })
    const { data: returned } = await rpc.call({ account: SIMULATION_CALLER, to: owner, data: call, gas: SIMULATION_GAS, stateOverride: [{ address: owner, code: SIMULATOR_RUNTIME as Hex }] })
    if (!returned) throw new ExecutionVerificationError('malformed', true)
    const result = decodeFunctionResult({ abi: SIMULATOR_ABI, functionName: 'simulate', data: returned })
    return { received: result.outAfter - result.outBefore, spent: result.inBefore - result.inAfter }
  }
  // One transaction, read by hash. A transaction or receipt the node does not have yet is `missing` / `unmined` (pending, not failed); any other
  // read problem is retryable; a hash that is not the recorded transaction (sender, nonce, network) is not retryable.
  type Loaded = { state: 'missing' } | { state: 'unmined' } | { state: 'ready'; tx: Awaited<ReturnType<PublicClient['getTransaction']>>; receipt: Awaited<ReturnType<PublicClient['getTransactionReceipt']>>; block: Awaited<ReturnType<PublicClient['getBlock']>>; latest: bigint; canonical: boolean }
  async function load(txHash: Hex, bind: { owner: string; nonce: number }, submitted?: (tx: ChainTx) => void): Promise<Loaded> {
    let chainId: number
    try { chainId = await rpc.getChainId() } catch { throw new ExecutionVerificationError('rpc', true) }
    if (chainId !== CIRCLE_CHAIN_ID) throw new ExecutionVerificationError('rpc', true)
    let tx
    try { tx = await rpc.getTransaction({ hash: txHash }) }
    catch (error) { if (error instanceof Error && error.name === 'TransactionNotFoundError') return { state: 'missing' }; throw new ExecutionVerificationError('rpc', true) }
    submitted?.(toChainTx(tx))
    // From here the node has shown a transaction under this hash; it must be this wallet's transaction at the recorded nonce.
    if (lc(tx.hash) !== lc(txHash) || !same(tx.from, bind.owner) || tx.nonce !== bind.nonce || tx.chainId !== CIRCLE_CHAIN_ID) throw new ExecutionVerificationError('binding', false)
    let receipt
    try { receipt = await rpc.getTransactionReceipt({ hash: txHash }) }
    catch (error) { if (error instanceof Error && error.name === 'TransactionReceiptNotFoundError') return { state: 'unmined' }; throw new ExecutionVerificationError('rpc', true) }
    if (receipt.blockNumber === null || !hash(receipt.blockHash) || receipt.gasUsed <= 0n || (receipt.status !== 'success' && receipt.status !== 'reverted')) throw new ExecutionVerificationError('malformed', true)
    let block, latest
    try { block = await rpc.getBlock({ blockNumber: receipt.blockNumber }); latest = await rpc.getBlockNumber({ cacheTime: 0 }) } catch { throw new ExecutionVerificationError('rpc', true) }
    return { state: 'ready', tx, receipt, block, latest, canonical: block.hash?.toLowerCase() === receipt.blockHash.toLowerCase() }
  }
  async function approval(attempt: CircleSwapAttempt, step: CircleStepRecord): Promise<CircleApprovalState> {
    if (!step.hash || step.kind !== 'approve') throw new ExecutionVerificationError('binding', false)
    const loaded = await load(step.hash, { owner: attempt.review.request.owner, nonce: step.nonce })
    if (loaded.state !== 'ready' || !loaded.canonical) return { status: 'pending' }
    const { tx, receipt } = loaded, request = attempt.review.request, token = swapToken(request.tokenIn).address
    // The approval must be exactly the transaction that was journaled: sender, nonce, token, and the exact calldata that was allowed.
    if (lc(tx.hash) !== lc(step.hash) || !same(tx.from, request.owner) || tx.nonce !== step.nonce || tx.chainId !== CIRCLE_CHAIN_ID || !tx.to || !same(tx.to, token) || lc(keccak256(tx.input)) !== lc(step.dataHash)) throw new ExecutionVerificationError('binding', false)
    const fee = (receipt.gasUsed * receipt.effectiveGasPrice).toString()
    if (receipt.status !== 'success') return { status: 'failed', fee }
    // Proof that the allowance now exists: the token's own Approval event for exactly this owner, spender and amount, or, if the token emitted none,
    // the allowance at the receipt's block.
    const event = receipt.logs.some(log => same(log.address, token) && lc(log.topics[0] ?? '') === APPROVAL_TOPIC && lc(topicAddress(log.topics[1]) ?? '') === lc(request.owner) &&
      lc(topicAddress(log.topics[2]) ?? '') === lc(CIRCLE_ADAPTER) && /^0x[0-9a-fA-F]{64}$/.test(log.data) && BigInt(log.data) === uint(attempt.review.amountIn))
    if (!event) {
      let allowance: bigint
      try { allowance = await rpc.readContract({ address: token as Hex, abi: erc20Abi, functionName: 'allowance', args: [request.owner as Hex, CIRCLE_ADAPTER], blockNumber: receipt.blockNumber }) } catch { throw new ExecutionVerificationError('rpc', true) }
      if (allowance < uint(attempt.review.amountIn)) return { status: 'failed', fee }
    }
    return { status: 'confirmed', fee }
  }
  // The swap transaction. Two answers are kept apart: what the chain says, and whether that transaction is the reviewed one.
  async function result(attempt: CircleSwapAttempt, submitted?: (intent: IntentSummary) => void): Promise<CircleChainResult> {
    const swap = attempt.steps.find(step => step.kind === 'swap')
    if (!hash(attempt.hash) || !swap || !swap.hash || lc(swap.hash) !== lc(attempt.hash)) throw new ExecutionVerificationError('binding', false)
    const request = attempt.review.request, owner = request.owner as Hex, tokenIn = swapToken(request.tokenIn), tokenOut = swapToken(request.tokenOut)
    const reviewed: CircleReviewedIntent = {
      owner, adapter: CIRCLE_ADAPTER, inputToken: tokenIn.address as Hex, outputToken: tokenOut.address as Hex, amountIn: uint(attempt.review.amountIn), minimumOut: uint(attempt.review.requiredMinimum),
      strategy: circleStrategy(request), chainId: CIRCLE_CHAIN_ID, feeCeiling: uint(attempt.review.networkFee), inputSymbol: request.tokenIn, inputDecimals: tokenIn.decimals,
      outputSymbol: request.tokenOut, outputDecimals: tokenOut.decimals, nonce: swap.nonce, sentDataHash: swap.dataHash, approvalFees: 0n, maxFeeUnits: providerFeeUnits(attempt.review),
      planned: swap.gasLimit !== undefined && swap.maxFee !== undefined && swap.maxTip !== undefined ? { gas: uint(swap.gasLimit), maxFeePerGas: uint(swap.maxFee), maxPriorityFeePerGas: uint(swap.maxTip) } : undefined,
    }
    const loaded = await load(attempt.hash, { owner, nonce: swap.nonce }, tx => {
      submitted?.(summarizeIntent(compareCircleSwap({ attemptHash: attempt.hash!, tx, receipt: null,
        observation: { canonical: false, latestBlock: 0n, blockTimestamp: null }, reviewed, received: null, sent: null }), clock()))
    })
    if (loaded.state === 'missing') {
      // Unknown to the node. Whether its nonce has meanwhile been used by another transaction is read as well: then this hash can never be
      // mined, and only a replacement hash can identify the swap.
      let nonceUsed: boolean | undefined
      try { nonceUsed = (await rpc.getTransactionCount({ address: owner, blockTag: 'latest' })) > swap.nonce } catch { nonceUsed = undefined }
      return { status: 'pending', identified: false, ...(nonceUsed === undefined ? {} : { nonceUsed }) }
    }
    if (loaded.state === 'unmined' || !loaded.canonical || loaded.latest < loaded.receipt.blockNumber + 1n) return { status: 'pending', identified: true } // Two observed blocks; not a promise against all reorgs.
    const { tx, receipt, block, latest } = loaded
    // Approval transactions of this attempt: their real fees count toward the ceiling.
    const approvals: { index: number; status: 'confirmed' | 'failed' | 'pending'; fee: string }[] = []
    for (const step of attempt.steps.filter(item => item.kind === 'approve' && item.hash)) {
      const state = await approval(attempt, step)
      approvals.push({ index: step.index, status: state.status, fee: state.status === 'pending' ? '0' : state.fee })
    }
    if (approvals.some(item => item.status === 'pending')) throw new ExecutionVerificationError('rpc', true)
    const approvalFees = approvals.reduce((sum, item) => sum + BigInt(item.fee), 0n)
    const chainTx = toChainTx(tx), chainReceipt = toChainReceipt(receipt)
    const fee = receipt.gasUsed * receipt.effectiveGasPrice
    let received: bigint | null = null, sent: bigint | null = null
    const flows = ownerFlows(chainReceipt, owner, [tokenIn.address, tokenOut.address])
    if (flows.ok) {
      received = flows.flows.get(lc(tokenOut.address))?.net ?? 0n
      const input = flows.flows.get(lc(tokenIn.address))
      sent = input ? input.sent - input.received : 0n
    }
    reviewed.approvalFees = approvalFees
    const report = compareCircleSwap({ attemptHash: attempt.hash, tx: chainTx, receipt: chainReceipt, observation: { canonical: true, latestBlock: latest, blockTimestamp: typeof block.timestamp === 'bigint' ? block.timestamp : null }, reviewed, received, sent })
    if (report.verdict === 'unbound') throw new ExecutionVerificationError('binding', false)
    const checkedAt = clock()
    const net = received !== null && received > 0n ? received : 0n
    const total = fee + approvalFees
    return {
      status: 'settled', output: net.toString(), fee: total.toString(), intent: summarizeIntent(report, checkedAt), approvals,
      chain: { state: receipt.status === 'success' ? 'success' : 'reverted', blockNumber: receipt.blockNumber.toString(), blockHash: receipt.blockHash, gasUsed: receipt.gasUsed.toString(),
        effectiveGasPrice: receipt.effectiveGasPrice.toString(), fee: fee.toString(), received: received === null ? null : (received < 0n ? '0' : received.toString()), sent: sent === null ? null : (sent < 0n ? '0' : sent.toString()), checkedAt },
    }
  }
  return { preflight, publicNonce, estimateGas, simulate, approval, result }
}

// One import surface for the hook: the guard's public types live next to the controller that uses them.
export { viemInnerWallet } from './circleWallet'
export { createGuardedWalletClient, CircleGuardError } from './circleGuard'
export type { CircleGuardCode, CircleStepInfo, CircleStepKind, CircleStepOutcome, CircleStepPlan, CircleInnerWallet, GuardedWallet } from './circleGuard'
export type { ChainSummary, IntentSummary } from './transactionEvidence'
