import { decodeAbiParameters, decodeFunctionData, encodeAbiParameters, encodeFunctionData, getAddress, parseAbiParameters, type AbiParameter, type Hex } from 'viem'
import { CURRENCY_AMOUNT, EXECUTE_ABI, NATIVE_REFUND, V3_INPUT, V4_ENVELOPE, V4_PATH, V4_SETTLE, V4_SINGLE, V4_TAKE, sameAddress } from '../uniswapArcPolicy'

// Strict, read-only decoder for Universal Router `execute(commands, inputs, deadline)` calldata.
// It never sends, signs or simulates anything. Two consumers:
//   * forensic: explain what an on-chain transaction actually asked the router to do (extra actions, third-party
//     portions, minimums), even for programs this application would never prepare;
//   * policy: the review gate (uniswapArcPolicy / swapPolicy) uses the same structure but accepts only canonical,
//     fee-free programs.
// Every nested ABI blob must re-encode to exactly the same bytes, so no ambiguous or padded encoding is accepted.

export const ROUTER_COMMANDS: Record<number, string> = {
  0x00: 'V3_SWAP_EXACT_IN', 0x01: 'V3_SWAP_EXACT_OUT', 0x02: 'PERMIT2_TRANSFER_FROM', 0x03: 'PERMIT2_PERMIT_BATCH', 0x04: 'SWEEP', 0x05: 'TRANSFER',
  0x06: 'PAY_PORTION', 0x08: 'V2_SWAP_EXACT_IN', 0x09: 'V2_SWAP_EXACT_OUT', 0x0a: 'PERMIT2_PERMIT', 0x0b: 'WRAP_ETH', 0x0c: 'UNWRAP_WETH',
  0x0d: 'PERMIT2_TRANSFER_FROM_BATCH', 0x0e: 'BALANCE_CHECK_ERC20', 0x10: 'V4_SWAP', 0x11: 'V3_POSITION_MANAGER_PERMIT', 0x12: 'V3_POSITION_MANAGER_CALL',
  0x13: 'V4_INITIALIZE_POOL', 0x14: 'V4_POSITION_MANAGER_CALL', 0x21: 'EXECUTE_SUB_PLAN',
}
export const V4_ACTIONS: Record<number, string> = {
  0x06: 'SWAP_EXACT_IN_SINGLE', 0x07: 'SWAP_EXACT_IN', 0x08: 'SWAP_EXACT_OUT_SINGLE', 0x09: 'SWAP_EXACT_OUT', 0x0a: 'DONATE', 0x0b: 'SETTLE', 0x0c: 'SETTLE_ALL',
  0x0d: 'SETTLE_PAIR', 0x0e: 'TAKE', 0x0f: 'TAKE_ALL', 0x10: 'TAKE_PORTION', 0x11: 'TAKE_PAIR', 0x12: 'CLOSE_CURRENCY', 0x13: 'CLEAR_OR_TAKE', 0x14: 'SWEEP',
  0x15: 'WRAP', 0x16: 'UNWRAP',
}
export const ROUTER_SELECTOR = '0x3593564c'
export const OPEN_DELTA = 0n // v4 router: "use the full open delta"
const PAY_PORTION = parseAbiParameters('address token,address recipient,uint256 bips')
const TRANSFER = parseAbiParameters('address token,address recipient,uint256 value')

export interface RouterAction { code: number; name: string; params: Hex; decoded?: Record<string, unknown> }
export interface RouterCommand { code: number; name: string; allowRevert: boolean; input: Hex; decoded?: Record<string, unknown>; actions?: RouterAction[] }
export interface RouterPortion { source: 'v4-take-portion' | 'pay-portion'; token: Hex; recipient: Hex; bips: bigint }
export interface RouterTake { token: Hex; recipient: Hex; amount: bigint; kind: 'take' | 'take-all' | 'sweep' | 'transfer' }
export interface RouterProgram {
  deadline: bigint
  trailer: Hex
  commands: RouterCommand[]
  // Order of every command and action, e.g. "V4_SWAP[SWAP_EXACT_IN,SETTLE,TAKE_PORTION,TAKE]+SWEEP".
  signature: string
  swapKind: 'v4-single' | 'v4-path' | 'v3-single' | 'v3-path' | 'none' | 'mixed'
  tokenIn?: Hex
  tokenOut?: Hex
  amountIn?: bigint
  // The minimum the router itself enforces on the swap (before any portion is taken).
  swapMinimum?: bigint
  portions: RouterPortion[]
  takes: RouterTake[]
  payerIsUser?: boolean
  // True when the program contains a command or action this decoder does not recognise.
  unknown: string[]
  allowRevert: boolean
}
export type RouterDecode = { ok: true; program: RouterProgram } | { ok: false; error: string }

const sameBytes = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()
const bytesOf = (hex: Hex): number[] => {
  const body = hex.slice(2)
  if (body.length % 2 !== 0) return []
  return Array.from({ length: body.length / 2 }, (_, i) => parseInt(body.slice(i * 2, i * 2 + 2), 16))
}
function canonical(types: readonly AbiParameter[], values: readonly unknown[], original: Hex): boolean {
  try { return sameBytes(encodeAbiParameters(types, values as never), original) } catch { return false }
}
function pathTokens(path: Hex): { tokens: Hex[]; fees: number[] } | null {
  // v3 path: token (20) [fee (3) token (20)]+
  const body = path.slice(2)
  if (body.length < 86 || (body.length - 40) % 46 !== 0) return null
  const tokens: Hex[] = [`0x${body.slice(0, 40)}` as Hex], fees: number[] = []
  for (let offset = 40; offset < body.length; offset += 46) {
    fees.push(parseInt(body.slice(offset, offset + 6), 16))
    tokens.push(`0x${body.slice(offset + 6, offset + 46)}` as Hex)
  }
  return { tokens: tokens.map(token => getAddress(token) as Hex), fees }
}
export function decodeV3Path(path: Hex) { return pathTokens(path) }

function decodeAction(code: number, params: Hex): RouterAction {
  const name = V4_ACTIONS[code] ?? `UNKNOWN_0x${code.toString(16).padStart(2, '0')}`
  try {
    if (code === 0x06) {
      const [swap] = decodeAbiParameters(V4_SINGLE, params)
      if (!canonical(V4_SINGLE, [swap], params)) return { code, name, params }
      return { code, name, params, decoded: { swap } }
    }
    if (code === 0x07) {
      const [swap] = decodeAbiParameters(V4_PATH, params)
      if (!canonical(V4_PATH, [swap], params)) return { code, name, params }
      return { code, name, params, decoded: { swap } }
    }
    if (code === 0x0b) {
      const values = decodeAbiParameters(V4_SETTLE, params)
      if (!canonical(V4_SETTLE, values, params)) return { code, name, params }
      return { code, name, params, decoded: { currency: values[0], amount: values[1], payerIsUser: values[2] } }
    }
    if (code === 0x0c || code === 0x0f) {
      const values = decodeAbiParameters(CURRENCY_AMOUNT, params)
      if (!canonical(CURRENCY_AMOUNT, values, params)) return { code, name, params }
      return { code, name, params, decoded: { currency: values[0], amount: values[1] } }
    }
    if (code === 0x0e) {
      const values = decodeAbiParameters(V4_TAKE, params)
      if (!canonical(V4_TAKE, values, params)) return { code, name, params }
      return { code, name, params, decoded: { currency: values[0], recipient: values[1], amount: values[2] } }
    }
    if (code === 0x10) {
      // TAKE_PORTION(currency, recipient, bips): a share of the open credit goes to `recipient`.
      const values = decodeAbiParameters(V4_TAKE, params)
      if (!canonical(V4_TAKE, values, params)) return { code, name, params }
      return { code, name, params, decoded: { currency: values[0], recipient: values[1], bips: values[2] } }
    }
  } catch { /* undecodable: left without `decoded`, reported as unknown */ }
  return { code, name, params }
}

export function decodeUniversalRouterCalldata(data: unknown): RouterDecode {
  if (typeof data !== 'string' || !/^0x[0-9a-fA-F]+$/.test(data) || data.length > 65536) return { ok: false, error: 'invalid_calldata' }
  if (!data.toLowerCase().startsWith(ROUTER_SELECTOR)) return { ok: false, error: 'not_universal_router_execute' }
  let outer: ReturnType<typeof decodeFunctionData<typeof EXECUTE_ABI>>
  try { outer = decodeFunctionData({ abi: EXECUTE_ABI, data: data as Hex }) } catch { return { ok: false, error: 'undecodable_execute' } }
  const rebuilt = encodeFunctionData({ abi: EXECUTE_ABI, functionName: 'execute', args: outer.args })
  if (!data.toLowerCase().startsWith(rebuilt.toLowerCase())) return { ok: false, error: 'noncanonical_calldata' }
  const [commandBytes, inputs, deadline] = outer.args
  const trailer = (`0x${data.slice(rebuilt.length)}`) as Hex
  const codes = bytesOf(commandBytes)
  if (codes.length === 0 || codes.length !== inputs.length) return { ok: false, error: 'commands_inputs_mismatch' }
  const program: RouterProgram = { deadline, trailer, commands: [], signature: '', swapKind: 'none', portions: [], takes: [], unknown: [], allowRevert: false }
  const sig: string[] = []
  const swaps: { kind: RouterProgram['swapKind'] }[] = []
  codes.forEach((byte, index) => {
    const code = byte & 0x3f, allowRevert = (byte & 0x80) !== 0
    const input = inputs[index] as Hex
    const name = ROUTER_COMMANDS[code] ?? `UNKNOWN_0x${code.toString(16).padStart(2, '0')}`
    const command: RouterCommand = { code, name, allowRevert, input }
    if (allowRevert) program.allowRevert = true
    if (ROUTER_COMMANDS[code] === undefined) program.unknown.push(name)
    try {
      if (code === 0x00) {
        const values = decodeAbiParameters(V3_INPUT, input)
        if (canonical(V3_INPUT, values, input)) {
          const [recipient, amountIn, minimum, path, payerIsUser, prices] = values
          const decodedPath = pathTokens(path)
          command.decoded = { recipient, amountIn, minimum, path, payerIsUser, minHopPriceX36: prices, tokens: decodedPath?.tokens, fees: decodedPath?.fees }
          if (decodedPath) {
            swaps.push({ kind: decodedPath.fees.length === 1 ? 'v3-single' : 'v3-path' })
            program.tokenIn ??= decodedPath.tokens[0]; program.tokenOut = decodedPath.tokens[decodedPath.tokens.length - 1]
            program.amountIn ??= amountIn; program.swapMinimum = minimum; program.payerIsUser = payerIsUser
            program.takes.push({ token: program.tokenOut, recipient, amount: minimum, kind: 'transfer' })
          } else program.unknown.push('V3_SWAP_EXACT_IN:path')
        } else program.unknown.push('V3_SWAP_EXACT_IN:noncanonical')
      } else if (code === 0x04) {
        const values = decodeAbiParameters(NATIVE_REFUND, input)
        if (canonical(NATIVE_REFUND, values, input)) {
          command.decoded = { token: values[0], recipient: values[1], minimum: values[2] }
          program.takes.push({ token: values[0] as Hex, recipient: values[1] as Hex, amount: values[2], kind: 'sweep' })
        } else program.unknown.push('SWEEP:noncanonical')
      } else if (code === 0x05) {
        const values = decodeAbiParameters(TRANSFER, input)
        if (canonical(TRANSFER, values, input)) {
          command.decoded = { token: values[0], recipient: values[1], value: values[2] }
          program.takes.push({ token: values[0] as Hex, recipient: values[1] as Hex, amount: values[2], kind: 'transfer' })
        } else program.unknown.push('TRANSFER:noncanonical')
      } else if (code === 0x06) {
        const values = decodeAbiParameters(PAY_PORTION, input)
        if (canonical(PAY_PORTION, values, input)) {
          command.decoded = { token: values[0], recipient: values[1], bips: values[2] }
          program.portions.push({ source: 'pay-portion', token: values[0] as Hex, recipient: values[1] as Hex, bips: values[2] })
        } else program.unknown.push('PAY_PORTION:noncanonical')
      } else if (code === 0x10) {
        const [actionBytes, params] = decodeAbiParameters(V4_ENVELOPE, input)
        if (!canonical(V4_ENVELOPE, [actionBytes, params], input)) { program.unknown.push('V4_SWAP:noncanonical'); }
        else {
          const codesOfActions = bytesOf(actionBytes)
          if (codesOfActions.length !== params.length) program.unknown.push('V4_SWAP:actions_params_mismatch')
          else {
            command.actions = codesOfActions.map((actionCode, i) => decodeAction(actionCode, params[i] as Hex))
            for (const action of command.actions) {
              if (V4_ACTIONS[action.code] === undefined || (action.decoded === undefined && ![0x08, 0x09].includes(action.code))) program.unknown.push(`V4:${action.name}`)
              if (action.code === 0x06 || action.code === 0x07) {
                const swap = action.decoded?.swap as Record<string, any> | undefined
                if (!swap) continue
                if (action.code === 0x06) {
                  const pool = swap.poolKey as { currency0: Hex; currency1: Hex }
                  swaps.push({ kind: 'v4-single' })
                  program.tokenIn ??= (swap.zeroForOne ? pool.currency0 : pool.currency1) as Hex
                  program.tokenOut = (swap.zeroForOne ? pool.currency1 : pool.currency0) as Hex
                } else {
                  swaps.push({ kind: swap.path.length === 1 ? 'v4-path' : 'v4-path' })
                  program.tokenIn ??= swap.currencyIn as Hex
                  program.tokenOut = swap.path[swap.path.length - 1].intermediateCurrency as Hex
                }
                program.amountIn ??= swap.amountIn as bigint; program.swapMinimum = swap.amountOutMinimum as bigint
              }
              if (action.code === 0x0b) program.payerIsUser = action.decoded?.payerIsUser as boolean
              if (action.code === 0x0e || action.code === 0x0f) {
                program.takes.push({ token: action.decoded?.currency as Hex, recipient: (action.decoded?.recipient ?? '0x') as Hex, amount: action.decoded?.amount as bigint, kind: action.code === 0x0f ? 'take-all' : 'take' })
              }
              if (action.code === 0x10 && action.decoded) program.portions.push({ source: 'v4-take-portion', token: action.decoded.currency as Hex, recipient: action.decoded.recipient as Hex, bips: action.decoded.bips as bigint })
            }
          }
        }
      }
    } catch { program.unknown.push(`${name}:undecodable`) }
    program.commands.push(command)
    sig.push(command.actions ? `${name}[${command.actions.map(a => a.name).join(',')}]` : name)
  })
  program.signature = sig.join('+')
  const kinds = new Set(swaps.map(s => s.kind))
  program.swapKind = kinds.size === 0 ? 'none' : kinds.size === 1 ? [...kinds][0] : 'mixed'
  return { ok: true, program }
}

// --- Human-readable comparison ------------------------------------------------------------------------------------
const bpsText = (bips: bigint) => `${(Number(bips) / 100).toFixed(2)}%`
const short = (address: string) => `${address.slice(0, 6)}…${address.slice(-4)}`
export function describeProgramDifferences(reviewed: RouterDecode, onchain: RouterDecode): string[] {
  const lines: string[] = []
  if (!onchain.ok) return [`The on-chain calldata is not a Universal Router execute call this application can decode (${onchain.error}).`]
  if (!reviewed.ok) lines.push(`The reviewed calldata could not be decoded (${reviewed.error}).`)
  const b = onchain.program
  if (!reviewed.ok) return lines
  const a = reviewed.program
  if (a.signature !== b.signature) lines.push(`Program differs: reviewed ${a.signature}; on chain ${b.signature}.`)
  const key = (p: RouterPortion) => `${p.source}:${p.token.toLowerCase()}:${p.recipient.toLowerCase()}:${p.bips}`
  const reviewedPortions = new Set(a.portions.map(key))
  for (const portion of b.portions) {
    if (!reviewedPortions.has(key(portion))) lines.push(`On-chain calldata sends ${bpsText(portion.bips)} of the output (${portion.source === 'v4-take-portion' ? 'TAKE_PORTION' : 'PAY_PORTION'}) to ${short(portion.recipient)}; the review contained no such fee.`)
  }
  if (a.swapMinimum !== undefined && b.swapMinimum !== undefined && a.swapMinimum !== b.swapMinimum) lines.push(`Swap minimum differs: reviewed ${a.swapMinimum}; on chain ${b.swapMinimum} (token base units).`)
  if (a.amountIn !== undefined && b.amountIn !== undefined && a.amountIn !== b.amountIn) lines.push(`Swap input differs: reviewed ${a.amountIn}; on chain ${b.amountIn} (token base units).`)
  if (a.deadline !== b.deadline) lines.push(`Deadline differs: reviewed ${a.deadline}; on chain ${b.deadline}.`)
  if (a.trailer.toLowerCase() !== b.trailer.toLowerCase()) lines.push('The calldata suffix differs.')
  if (b.unknown.length) lines.push(`The on-chain program contains parts this application cannot classify: ${b.unknown.join(', ')}.`)
  if (lines.length === 0) lines.push('The calldata differs from the reviewed bytes in encoding only.')
  return lines
}

// Net amount the recipient is guaranteed by the router for a decoded program, after every portion, or null when the program
// has parts that make the guarantee unknowable. Portions are taken from the open credit after the swap's own minimum check,
// so the guarantee is floor(swapMinimum * (10000 - sum(bips)) / 10000).
export function guaranteedNetMinimum(program: RouterProgram): bigint | null {
  if (program.swapMinimum === undefined || program.unknown.length > 0 || program.allowRevert) return null
  let remaining = 10000n
  for (const portion of program.portions) {
    if (portion.bips < 0n || portion.bips > 10000n) return null
    remaining -= portion.bips
  }
  if (remaining < 0n) return null
  return program.swapMinimum * remaining / 10000n
}
export function portionRecipients(program: RouterProgram, owner: string): RouterPortion[] {
  return program.portions.filter(portion => !sameAddress(portion.recipient, owner))
}
