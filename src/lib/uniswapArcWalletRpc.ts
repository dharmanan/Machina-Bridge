// Read diagnostics contain only fixed labels and recognized numeric protocol codes.
// Never retain provider messages, stacks, RPC URLs, session data or error payloads.
import type { ExecutionProvider } from './uniswapArcExecution'

export type WalletRpcStage = 'provider' | 'chain-before' | 'accounts-before' | 'latest-before' | 'pending' | 'latest-after' | 'chain-after' | 'accounts-after'
type FailureKind = 'rejected' | 'unauthorized' | 'unsupported' | 'disconnected' | 'wrong-chain' | 'invalid-request' | 'rpc-error' | 'unknown' | 'invalid-response' | 'timeout' | 'network-mismatch' | 'account-mismatch'
export class WalletRpcFailure extends Error {
  constructor(readonly stage: WalletRpcStage, readonly kind: FailureKind, readonly rpcCode?: number, readonly responseShape?: string) { super('wallet_rpc') }
}
function field(value: unknown, key: string): unknown {
  try { return value && typeof value === 'object' ? (value as Record<string, unknown>)[key] : undefined } catch { return undefined }
}
function protocolCode(error: unknown): number | undefined {
  const pending: unknown[] = [error], seen = new Set<unknown>()
  for (let i = 0; i < pending.length && i < 8; i++) {
    const value = pending[i]
    if (!value || typeof value !== 'object' || seen.has(value)) continue
    seen.add(value)
    const code = field(value, 'code')
    if (typeof code === 'number' && Number.isInteger(code) &&
      ([4001, 4100, 4200, 4900, 4901, -32700, -32600, -32601, -32602, -32603].includes(code) || (code >= -32099 && code <= -32000))) return code
    pending.push(field(value, 'cause'), field(value, 'error'), field(field(value, 'data'), 'originalError'))
  }
}
function classify(stage: WalletRpcStage, error: unknown) {
  const code = protocolCode(error)
  const kind: FailureKind = code === 4001 ? 'rejected' : code === 4100 ? 'unauthorized' : code === 4200 || code === -32601 ? 'unsupported'
    : code === 4900 ? 'disconnected' : code === 4901 ? 'wrong-chain' : [-32700, -32600, -32602].includes(code!) ? 'invalid-request'
      : code !== undefined ? 'rpc-error' : 'unknown'
  return new WalletRpcFailure(stage, kind, code)
}
async function bounded<T>(run: () => Promise<T>, stage: WalletRpcStage, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([Promise.resolve().then(run).catch(error => { throw classify(stage, error) }),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new WalletRpcFailure(stage, 'timeout')), ms) })])
  } finally { clearTimeout(timer) }
}
export async function connectedExecutionProvider(connector: { getProvider(): Promise<unknown> } | undefined): Promise<ExecutionProvider> {
  // WalletConnect's getProvider({chainId}) can switch networks. Use the connected
  // provider without mutation, then independently check its chain/accounts.
  const provider = await bounded(async () => connector?.getProvider(), 'provider', 5000)
  if (!provider || typeof field(provider, 'request') !== 'function') throw new WalletRpcFailure('provider', 'invalid-response')
  return { request: args => (provider as ExecutionProvider).request(args) } // Preserve provider `this`.
}
export async function walletRpcRead(provider: ExecutionProvider, stage: WalletRpcStage, owner: string): Promise<unknown> {
  const method = stage.startsWith('chain-') ? 'eth_chainId' : stage.startsWith('accounts-') ? 'eth_accounts' : 'eth_getTransactionCount'
  const params = method === 'eth_getTransactionCount' ? [owner, stage === 'pending' ? 'pending' : 'latest'] : undefined
  return bounded(() => provider.request(params ? { method, params } : { method }), stage, 3000)
}
function rejectedQuantityShape(raw: unknown): string {
  // No coercion, property traversal, value retention or additional RPC. Bound
  // syntax inspection so an oversized response cannot create diagnostic work.
  const type = raw === null ? 'null' : typeof raw
  const length = typeof raw === 'string' ? raw.length : 'n/a'
  const canonical = typeof raw !== 'string' ? 'n/a' : raw.length > 128 ? 'not-checked-length'
    : /^0x(?:0|[1-9a-fA-F][0-9a-fA-F]*)$/.test(raw) ? 'yes' : 'no'
  return `Response shape: type=${type}; stringLength=${length}; canonicalHexQuantity=${canonical}.`
}
export function walletRpcQuantity(raw: unknown, stage: WalletRpcStage, diagnosePending = false): number {
  if (typeof raw !== 'string' || raw.length > 16 || !/^0x(?:0|[1-9a-f][0-9a-f]*)$/i.test(raw) || BigInt(raw) > BigInt(Number.MAX_SAFE_INTEGER)) {
    const shape = diagnosePending && stage === 'pending' ? rejectedQuantityShape(raw) : undefined
    throw new WalletRpcFailure(stage, 'invalid-response', undefined, shape)
  }
  return Number(BigInt(raw))
}
export function walletRpcMessage(error: WalletRpcFailure): string {
  const labels: Record<WalletRpcStage, string> = { provider: 'connector.getProvider()', 'chain-before': 'eth_chainId before nonce', 'accounts-before': 'eth_accounts before nonce',
    'latest-before': 'eth_getTransactionCount(latest) before pending', pending: 'eth_getTransactionCount(pending)', 'latest-after': 'eth_getTransactionCount(latest) after pending',
    'chain-after': 'eth_chainId after nonce', 'accounts-after': 'eth_accounts after nonce' }
  const reasons: Record<FailureKind, string> = { rejected: 'request rejected', unauthorized: 'wallet authorization unavailable', unsupported: 'method unsupported',
    disconnected: 'provider disconnected', 'wrong-chain': 'provider disconnected from the requested chain', 'invalid-request': 'invalid RPC request',
    'network-mismatch': 'wallet, network, provider or swap inputs changed: wallet is not on Arc 5042', 'account-mismatch': 'wallet, network, provider or swap inputs changed: connected account differs from the reviewed account',
    'rpc-error': 'RPC error', unknown: 'unclassified provider failure', 'invalid-response': 'invalid EIP-1193 response', timeout: 'RPC read timed out' }
  return `The wallet RPC check failed at ${labels[error.stage]}: ${reasons[error.kind]}${error.rpcCode === undefined ? '' : ` (code ${error.rpcCode})`}. No transaction was requested. Required wallet nonce verification remains blocked; no alternative RPC fallback was used.${error.responseShape ? ` ${error.responseShape}` : ''}`
}
