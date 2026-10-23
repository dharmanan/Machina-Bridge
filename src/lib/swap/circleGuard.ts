import { keccak256, stringToHex, type Hex } from 'viem'
import { checkSwapCalldata, decodeApprove, CIRCLE_MAX_GAS_LIMIT, PERMIT_TYPES, MAX_PERMIT_DEADLINE_SECONDS, type CircleSwapIntent } from './circleAdapterDecode'

// The only object the Circle SDK ever sees as "the wallet". The SDK has a single place that sends a transaction
// (`walletClient.sendTransaction`) and a single place that signs typed data (`walletClient.signTypedData`). Both go through this guard,
// which decodes what the SDK is about to hand to the wallet and lets through only:
//   approve  : ERC-20 `approve(adapter, exactly the reviewed amount)` on the reviewed input token
//   swap     : Circle adapter `execute(...)` whose decoded instructions pull exactly the reviewed amount, guarantee at least the reviewed
//              minimum, pay the connected wallet, and expire shortly (see circleAdapterDecode.checkSwapCalldata)
//   permit   : (only when the Review chose the permit strategy) EIP-2612 `Permit` for exactly the reviewed amount to the adapter
// Everything else (other targets, other selectors, unlimited approvals, native value, raw transactions, batches, other wallet methods)
// is refused BEFORE the wallet is contacted. Each guarded client sends at most one approval and one swap and is sealed afterwards.

export type CircleGuardCode =
  | 'method_blocked' | 'sealed' | 'account' | 'network' | 'extra_field' | 'wrong_target' | 'value' | 'approve_data' | 'approve_amount' | 'approve_spender'
  | 'swap_calldata' | 'step_order' | 'duplicate_send' | 'fee_ceiling' | 'gas_limit' | 'typed_data' | 'step_declined' | 'step_timeout' | 'hash'

export class CircleGuardError extends Error {
  constructor(readonly code: CircleGuardCode, readonly detail = '') { super(code) }
}
export type CircleStepKind = 'approve' | 'permit' | 'swap'

// What the user is asked to confirm and what is journaled before the wallet is contacted. Amounts are base-unit decimal text.
export interface CircleStepInfo {
  index: number; kind: CircleStepKind; to: Hex; token: Hex; amount: string
  spender?: Hex; minimumOut?: string; deadline?: number; dataHash: Hex
  gasLimit?: string; maxFeePerGas?: string; worstCaseFee?: string
  // Swap step: the provider fee taken from the input by this very transaction (input-token base units).
  feeAmount?: string
}
// Fee and nonce plan for one wallet request, decided by the controller (never by the SDK or the wallet).
export interface CircleStepPlan { nonce: number; gas: bigint; maxFeePerGas: bigint; maxPriorityFeePerGas: bigint }
// rejected: the wallet user declined. unknown: the wallet answered ambiguously. blocked: journaled, wallet never contacted. refused: nothing journaled.
export type CircleStepOutcome = 'rejected' | 'unknown' | 'blocked' | 'refused'

export interface CircleGuardPolicy extends CircleSwapIntent {
  now(): number            // wall clock, milliseconds
  maxFeePerGas: bigint
  maxPriorityFeePerGas: bigint
  // What is left of the reviewed fee ceiling for ALL steps, at call time (the ceiling minus fees already charged).
  feeBudget(): bigint
}
export interface CircleGuardHooks {
  // The user's in-app confirmation for this exact step. Throws CircleGuardError('step_declined' | 'step_timeout') to stop the flow.
  gate(step: CircleStepInfo): Promise<void>
  // Journal the step as awaiting_wallet and return the plan. MUST fail (throw) when recording is impossible: the wallet is not contacted then.
  before(step: CircleStepInfo, estimate: { gas: bigint | null; data: Hex }): Promise<CircleStepPlan>
  sent(step: CircleStepInfo, hash: Hex): void
  failed(step: CircleStepInfo, outcome: CircleStepOutcome, error: unknown): void
  signed?(step: CircleStepInfo): void
}
// The wallet underneath (a viem WalletClient over the connected EIP-1193 provider). Structural, so tests supply a fake.
export interface CircleInnerWallet {
  getChainId(): Promise<number>
  getAddresses(): Promise<readonly string[]>
  sendTransaction(params: Record<string, unknown>): Promise<unknown>
  signTypedData(params: Record<string, unknown>): Promise<unknown>
}
export interface GuardedWallet {
  account: { address: Hex; type: 'json-rpc' }
  getAddresses(): Promise<Hex[]>
  getChainId(): Promise<number>
  switchChain(params: { id: number }): Promise<void>
  sendTransaction(params: Record<string, unknown>): Promise<Hex>
  signTypedData(params: Record<string, unknown>): Promise<Hex>
  seal(): void
  // A snapshot: changing it changes nothing inside the guard.
  readonly sent: Readonly<{ approve: number; swap: number; permit: number }>
}

const lc = (value: string) => value.toLowerCase()
const same = (a: unknown, b: string) => typeof a === 'string' && /^0x[0-9a-fA-F]{40}$/.test(a) && lc(a) === lc(b)
const isHash = (value: unknown): value is Hex => typeof value === 'string' && /^0x[0-9a-fA-F]{64}$/.test(value)
const SEND_KEYS = new Set(['account', 'chain', 'to', 'data', 'value', 'gas', 'maxFeePerGas', 'maxPriorityFeePerGas', 'nonce', 'kzg', 'type'])
const TYPED_KEYS = new Set(['account', 'domain', 'types', 'primaryType', 'message'])
const DOMAIN_TYPES = [{ name: 'name', type: 'string' }, { name: 'version', type: 'string' }, { name: 'chainId', type: 'uint256' }, { name: 'verifyingContract', type: 'address' }]
// Names a wallet client could be asked for that this guard answers by refusing. Anything not listed below is refused as well.
const GAS_BUFFER_NUM = 130n, GAS_BUFFER_DEN = 100n

const bigintOrNull = (value: unknown): bigint | null => (typeof value === 'bigint' ? value : value === undefined ? null : typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? BigInt(value) : null)

export function createGuardedWalletClient(inner: CircleInnerWallet, policy: CircleGuardPolicy, hooks: CircleGuardHooks): GuardedWallet {
  let sealed = false, inFlight = false, steps = 0
  const sent = { approve: 0, swap: 0, permit: 0 }
  const account = Object.freeze({ address: policy.owner, type: 'json-rpc' as const })
  const accountOk = (value: unknown) => same(typeof value === 'string' ? value : (value as { address?: unknown } | null | undefined)?.address, policy.owner)

  async function walletContext() {
    let chainId: number, addresses: readonly string[]
    try { chainId = await inner.getChainId(); addresses = await inner.getAddresses() } catch { throw new CircleGuardError('network', 'The wallet network or account could not be read.') }
    if (chainId !== policy.chainId) throw new CircleGuardError('network', `The wallet is on network ${chainId}, not Arc Mainnet ${policy.chainId}.`)
    if (!addresses.length || !same(addresses[0], policy.owner)) throw new CircleGuardError('account', 'The wallet account is no longer the reviewed account.')
  }

  function classify(params: Record<string, unknown>): { kind: CircleStepKind; info: Omit<CircleStepInfo, 'index'>; data: Hex } {
    if (!params || typeof params !== 'object') throw new CircleGuardError('extra_field', 'No transaction parameters.')
    for (const key of Object.keys(params)) if (params[key] !== undefined && !SEND_KEYS.has(key)) throw new CircleGuardError('extra_field', `Unexpected transaction field "${key}".`)
    if (params.kzg !== undefined) throw new CircleGuardError('extra_field', 'Unexpected transaction field "kzg".')
    if (params.type !== undefined && params.type !== 'eip1559') throw new CircleGuardError('extra_field', 'Only EIP-1559 transactions are allowed.')
    if (!accountOk(params.account)) throw new CircleGuardError('account', 'The transaction is not from the reviewed account.')
    const chain = params.chain as { id?: unknown } | undefined | null
    if (chain !== undefined && chain !== null && chain.id !== policy.chainId) throw new CircleGuardError('network', 'The transaction is for another network.')
    const value = params.value
    if (value !== undefined && value !== 0n && value !== 0) throw new CircleGuardError('value', 'ERC-20 swaps carry no native value.')
    if (typeof params.to !== 'string' || typeof params.data !== 'string' || !/^0x[0-9a-fA-F]*$/.test(params.data)) throw new CircleGuardError('wrong_target', 'The transaction has no recipient or data.')
    const data = params.data as Hex
    if (same(params.to, policy.inputToken)) {
      if (policy.strategy !== 'approve') throw new CircleGuardError('step_order', 'The reviewed strategy is a permit signature; an on-chain approval is not allowed.')
      const approval = decodeApprove(data)
      if (!approval) throw new CircleGuardError('approve_data', 'The call to the input token is not a plain ERC-20 approve.')
      if (!same(approval.spender, policy.adapter)) throw new CircleGuardError('approve_spender', 'The approval is not for the Circle adapter.')
      if (approval.amount !== policy.amountIn) throw new CircleGuardError('approve_amount', 'The approval is not for exactly the reviewed amount.')
      return { kind: 'approve', data, info: { kind: 'approve', to: policy.inputToken, token: policy.inputToken, amount: approval.amount.toString(), spender: policy.adapter, dataHash: keccak256(data) } }
    }
    if (same(params.to, policy.adapter)) {
      const nowSeconds = Math.floor(policy.now() / 1000)
      const result = checkSwapCalldata(data, policy, nowSeconds)
      if (!result.ok) throw new CircleGuardError('swap_calldata', `${result.detail} (${result.code})`)
      return { kind: 'swap', data, info: { kind: 'swap', to: policy.adapter, token: policy.inputToken, amount: policy.amountIn.toString(), minimumOut: policy.minimumOut.toString(), deadline: Number(result.call.deadline), feeAmount: result.feeUnits.toString(), dataHash: keccak256(data) } }
    }
    throw new CircleGuardError('wrong_target', 'The transaction is not addressed to the reviewed token or the Circle adapter.')
  }

  const rejectedByUser = (error: unknown) => {
    const code = (error as { code?: unknown } | null)?.code, cause = (error as { cause?: { code?: unknown; name?: unknown } } | null)?.cause
    return code === 4001 || cause?.code === 4001 || (error as { name?: unknown } | null)?.name === 'UserRejectedRequestError' || cause?.name === 'UserRejectedRequestError'
  }
  // A request that never got as far as a step of its own (it could not even be classified) is still reported, so the application knows why the
  // SDK stopped. The placeholder carries no amounts and is never journaled.
  const placeholder = (kind: CircleStepKind): CircleStepInfo => ({ index: steps, kind, to: kind === 'swap' ? policy.adapter : policy.inputToken, token: policy.inputToken, amount: '0', dataHash: `0x${'0'.repeat(64)}` })

  async function sendTransaction(params: Record<string, unknown>): Promise<Hex> {
    if (sealed) throw new CircleGuardError('sealed', 'This swap session is closed.')
    let step: CircleStepInfo | undefined, owns = false, journaled = false, requested = false
    try {
      step = placeholder(same(params?.to, policy.adapter) ? 'swap' : 'approve')
      const { kind, info, data } = classify(params)
      const to = (kind === 'swap' ? policy.adapter : policy.inputToken) as Hex // classify() proved params.to equals this address
      step = placeholder(kind)
      // Order and uniqueness: one approval, then one swap; never two requests at the same time, never a repeat.
      if (inFlight) throw new CircleGuardError('duplicate_send', 'A wallet request is already open.')
      if (sent[kind] > 0) throw new CircleGuardError('duplicate_send', `A ${kind} transaction was already requested.`)
      if (kind === 'swap' && policy.strategy === 'approve' && sent.approve === 0) throw new CircleGuardError('step_order', 'The swap may only follow the exact approval.')
      inFlight = true; owns = true
      const own: CircleStepInfo = { ...info, index: steps }
      step = own
      // Fee ceiling before anything else: the SDK may supply a gas limit; the fee caps are the Review's, never the wallet's.
      let gas = bigintOrNull(params.gas)
      if (params.gas !== undefined && gas === null) throw new CircleGuardError('gas_limit', 'The gas limit is malformed.')
      if (gas !== null && (gas <= 0n || gas > CIRCLE_MAX_GAS_LIMIT)) throw new CircleGuardError('gas_limit', 'The gas limit is outside the allowed range.')
      const cap = bigintOrNull(params.maxFeePerGas), tip = bigintOrNull(params.maxPriorityFeePerGas)
      if ((params.maxFeePerGas !== undefined && cap === null) || (params.maxPriorityFeePerGas !== undefined && tip === null)) throw new CircleGuardError('fee_ceiling', 'The fee caps are malformed.')
      if (cap !== null && cap > policy.maxFeePerGas) throw new CircleGuardError('fee_ceiling', 'The requested fee cap is above the reviewed fee cap.')
      if (gas !== null && gas * policy.maxFeePerGas > policy.feeBudget()) throw new CircleGuardError('fee_ceiling', 'The network fee for this step would exceed the reviewed fee ceiling.')
      if (gas !== null) { own.gasLimit = gas.toString(); own.maxFeePerGas = policy.maxFeePerGas.toString(); own.worstCaseFee = (gas * policy.maxFeePerGas).toString() }
      await walletContext()
      await hooks.gate(own)
      await walletContext() // the user may have changed wallet state while the confirmation was open
      // A request that waited at the gate is judged again: the session may have been closed, and a swap deadline keeps running.
      if (sealed) throw new CircleGuardError('sealed', 'This swap session was closed while the request waited.')
      if (kind === 'swap') {
        const again = checkSwapCalldata(data, policy, Math.floor(policy.now() / 1000))
        if (!again.ok) throw new CircleGuardError('swap_calldata', `${again.detail} (${again.code})`)
      }
      const plan = await hooks.before(own, { gas, data })
      journaled = true
      if (sealed) throw new CircleGuardError('sealed', 'This swap session was closed while the request was prepared.')
      await walletContext()
      if (!Number.isSafeInteger(plan.nonce) || plan.nonce < 0 || plan.gas <= 0n || plan.gas > CIRCLE_MAX_GAS_LIMIT || plan.maxFeePerGas > policy.maxFeePerGas || plan.maxPriorityFeePerGas > plan.maxFeePerGas) throw new CircleGuardError('fee_ceiling', 'The step plan is invalid.')
      if (plan.gas * plan.maxFeePerGas > policy.feeBudget()) throw new CircleGuardError('fee_ceiling', 'The network fee for this step would exceed the reviewed fee ceiling.')
      gas = plan.gas
      sent[kind]++; steps++; requested = true
      let hash: unknown
      try {
        // Only values the guard itself checked and holds: the reviewed account, the validated target, calldata and plan. Nothing the SDK
        // owns (its account or chain objects) is forwarded, so changing it after the checks cannot change what the wallet is asked.
        hash = await inner.sendTransaction({ account: policy.owner, to, data, value: 0n, gas, nonce: plan.nonce, type: 'eip1559', maxFeePerGas: plan.maxFeePerGas, maxPriorityFeePerGas: plan.maxPriorityFeePerGas })
      } catch (error) {
        try { hooks.failed(own, rejectedByUser(error) ? 'rejected' : 'unknown', error) } catch { /* Recording problems cannot change what the wallet answered. */ }
        throw error
      }
      if (!isHash(hash)) {
        try { hooks.failed(own, 'unknown', new Error('hash')) } catch { /* see above */ }
        throw new CircleGuardError('hash', 'The wallet did not return a transaction hash.')
      }
      try { hooks.sent(own, hash) } catch { /* The hash is returned to the SDK regardless; the journal keeps the pending record. */ }
      return hash
    } catch (error) {
      // `blocked`: the step was journaled but the wallet was never contacted. `refused`: nothing was journaled at all.
      if (!requested && step) { try { hooks.failed(step, journaled ? 'blocked' : 'refused', error) } catch { /* nothing was requested */ } }
      throw error
    } finally { if (owns) inFlight = false }
  }

  async function signTypedData(params: Record<string, unknown>): Promise<Hex> {
    if (sealed) throw new CircleGuardError('sealed', 'This swap session is closed.')
    let step: CircleStepInfo = placeholder('permit'), owns = false, requested = false
    try {
      if (policy.strategy !== 'permit') throw new CircleGuardError('method_blocked', 'Signatures are not part of the reviewed strategy.')
      for (const key of Object.keys(params ?? {})) if (params[key] !== undefined && !TYPED_KEYS.has(key)) throw new CircleGuardError('typed_data', `Unexpected signature field "${key}".`)
      if (!accountOk(params.account)) throw new CircleGuardError('account', 'The signature is not for the reviewed account.')
      const domain = params.domain as Record<string, unknown> | undefined, message = params.message as Record<string, unknown> | undefined, types = params.types as Record<string, unknown> | undefined
      if (!domain || !message || !types || params.primaryType !== 'Permit') throw new CircleGuardError('typed_data', 'Only an EIP-2612 Permit may be signed.')
      const typeNames = Object.keys(types).filter(name => name !== 'EIP712Domain')
      const fields = types.Permit as { name?: unknown; type?: unknown }[] | undefined
      if (typeNames.length !== 1 || typeNames[0] !== 'Permit' || !Array.isArray(fields) || fields.length !== PERMIT_TYPES.length || fields.some((field, i) => field?.name !== PERMIT_TYPES[i].name || field?.type !== PERMIT_TYPES[i].type)) throw new CircleGuardError('typed_data', 'The signed type is not the standard Permit.')
      // A domain type, when present, must be the four standard fields: a domain that leaves out chain or contract is not the reviewed token on Arc.
      const domainType = types.EIP712Domain as { name?: unknown; type?: unknown }[] | undefined
      if (domainType !== undefined && (!Array.isArray(domainType) || domainType.length !== DOMAIN_TYPES.length || domainType.some((field, i) => field?.name !== DOMAIN_TYPES[i].name || field?.type !== DOMAIN_TYPES[i].type))) throw new CircleGuardError('typed_data', 'The signature domain is not the standard four-field domain.')
      if (Number(domain.chainId) !== policy.chainId || !same(domain.verifyingContract, policy.inputToken) || domain.name !== 'USDC' || domain.version !== '2') throw new CircleGuardError('typed_data', 'The signature domain is not the reviewed token on Arc Mainnet.')
      const nowSeconds = BigInt(Math.floor(policy.now() / 1000)), deadline = bigintOrNull(message.deadline), value = bigintOrNull(message.value), permitNonce = bigintOrNull(message.nonce)
      if (!same(message.owner, policy.owner) || !same(message.spender, policy.adapter) || value !== policy.amountIn) throw new CircleGuardError('typed_data', 'The permit is not for exactly the reviewed amount to the Circle adapter.')
      if (deadline === null || deadline <= nowSeconds || deadline > nowSeconds + BigInt(MAX_PERMIT_DEADLINE_SECONDS)) throw new CircleGuardError('typed_data', 'The permit deadline is not in the future or is more than an hour away.')
      if (permitNonce === null) throw new CircleGuardError('typed_data', 'The permit nonce is malformed.')
      if (inFlight) throw new CircleGuardError('duplicate_send', 'A wallet request is already open.')
      if (sent.permit > 0) throw new CircleGuardError('duplicate_send', 'A permit was already requested.')
      inFlight = true; owns = true
      // What the wallet signs is rebuilt here from the values just checked (fresh primitives), never the SDK's objects: a gate wait of up to two
      // minutes follows, during which the SDK could otherwise still change them.
      const signed = {
        account: policy.owner, primaryType: 'Permit' as const,
        domain: { name: 'USDC', version: '2', chainId: policy.chainId, verifyingContract: policy.inputToken },
        types: { Permit: PERMIT_TYPES.map(field => ({ name: field.name, type: field.type })) },
        message: { owner: policy.owner, spender: policy.adapter, value: policy.amountIn, nonce: permitNonce, deadline },
      }
      step = { index: steps, kind: 'permit', to: policy.inputToken, token: policy.inputToken, amount: policy.amountIn.toString(), spender: policy.adapter, deadline: Number(deadline), dataHash: keccak256(stringToHex(JSON.stringify([signed.message.owner, signed.message.spender, String(signed.message.value), String(signed.message.nonce), String(signed.message.deadline)]))) }
      await walletContext()
      await hooks.gate(step)
      await walletContext()
      if (sealed) throw new CircleGuardError('sealed', 'This swap session was closed while the request waited.')
      if (deadline <= BigInt(Math.floor(policy.now() / 1000))) throw new CircleGuardError('typed_data', 'The permit deadline passed while the request waited.')
      // A signature is not a transaction: it does not take a step index, so journaled steps stay numbered 0, 1 in order.
      sent.permit++; requested = true
      let signature: unknown
      try { signature = await inner.signTypedData(signed) }
      catch (error) { try { hooks.failed(step, rejectedByUser(error) ? 'rejected' : 'unknown', error) } catch { /* see above */ } throw error }
      if (typeof signature !== 'string' || !/^0x[0-9a-fA-F]{130}$/.test(signature)) { try { hooks.failed(step, 'unknown', new Error('signature')) } catch { /* see above */ } throw new CircleGuardError('hash', 'The wallet did not return a signature.') }
      try { hooks.signed?.(step) } catch { /* A signature is not a transaction; nothing to recover. */ }
      return signature as Hex
    } catch (error) {
      if (!requested) { try { hooks.failed(step, 'refused', error) } catch { /* nothing was requested */ } }
      throw error
    } finally { if (owns) inFlight = false }
  }

  // The adapter's `switchToChain` calls this on every send. A prompt to switch networks in the middle of a swap is never started:
  // the wallet must already be on Arc Mainnet.
  async function switchChain(params: { id: number }): Promise<void> {
    if (sealed) throw new CircleGuardError('sealed', 'This swap session is closed.')
    if (params?.id !== policy.chainId) throw new CircleGuardError('network', 'Only Arc Mainnet is allowed.')
    await walletContext()
  }
  const allowed: Record<string, unknown> = { account, getAddresses: async () => { await walletContext(); return [policy.owner] }, getChainId: async () => { await walletContext(); return policy.chainId },
    switchChain, sendTransaction, signTypedData, seal: () => { sealed = true }, get sent() { return Object.freeze({ ...sent }) } }
  // Not functions on purpose: the SDK probes these to decide whether to batch (EIP-5792). Absent means "unsupported", the safe answer.
  const absent = new Set(['getCapabilities', 'sendCalls', 'getCallsStatus', 'waitForCallsStatus', 'showCallsStatus', 'then', 'toJSON', 'catch', 'finally', 'inspect', 'nodeType', 'constructor'])
  return new Proxy(allowed, {
    get(target, property) {
      if (typeof property === 'symbol') return undefined
      if (Object.prototype.hasOwnProperty.call(target, property)) return target[property]
      if (absent.has(property)) return undefined
      return () => { throw new CircleGuardError('method_blocked', `Wallet method "${property}" is not allowed.`) }
    },
    has: (target, property) => typeof property === 'string' && Object.prototype.hasOwnProperty.call(target, property),
    set() { return false },
    defineProperty() { return false },
    deleteProperty() { return false },
  }) as unknown as GuardedWallet
}
// The gas limit used when the SDK supplies none: the public node's estimate plus a safety margin (the same 1.3x the SDK applies).
export const bufferedGas = (estimate: bigint) => (estimate * GAS_BUFFER_NUM + GAS_BUFFER_DEN - 1n) / GAS_BUFFER_DEN
