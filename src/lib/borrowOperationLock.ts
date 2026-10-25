import { MAINNET_BORROW_CHAIN_ID } from '../config/mainnetBorrow'

export type BorrowLockManager = Pick<LockManager, 'request'>
export function browserBorrowLocks(): BorrowLockManager | null {
  try { return typeof navigator !== 'undefined' && navigator.locks ? navigator.locks : null } catch { return null }
}
// Held across preparation at the send boundary, submission and durable attempt update. localStorage is NOT a mutex.
// Wallet-wide: opening by market and later managing by loan must not race through different lock names.
export async function withBorrowOperationLock<T>(owner: string, work: () => Promise<T>, locks = browserBorrowLocks()): Promise<T> {
  if (!/^0x[0-9a-fA-F]{40}$/.test(owner) || !locks) throw new Error('borrow_lock_unavailable')
  return locks.request(`machina.borrow.execution:${MAINNET_BORROW_CHAIN_ID}:${owner.toLowerCase()}`, { mode: 'exclusive', ifAvailable: true }, async lock => {
    if (!lock) throw new Error('borrow_operation_busy')
    return work()
  })
}
