import { borrowCanaryAllows } from '../config/borrowCanary'
// Trusted-code identity of the guarded transport, not wallet authentication. Only borrowSdkTransport registers adapters.
const adapters = new WeakMap<object, string>()
export function attestBorrowCanaryAdapter(adapter: object, owner: string): void {
  if (!borrowCanaryAllows(owner)) throw new Error('borrow_canary_wallet')
  adapters.set(adapter, owner.toLowerCase())
}
export function borrowCanaryAdapterOwner(adapter: unknown): string | null {
  if (!adapter || typeof adapter !== 'object') return null
  const owner = adapters.get(adapter)
  return owner && borrowCanaryAllows(owner) ? owner : null
}
