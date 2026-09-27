export const MAINNET_SOLANA_ACTIVITY_KEY = 'machina_mainnet_solana_transfers_v1'
export const MAINNET_SOLANA_ACTIVITY_EVENT = 'machina:mainnet-solana-activity'

export type MainnetSolanaActivityDirection = 'arc-to-solana' | 'solana-to-arc'

export type MainnetSolanaActivityRecord = {
  id: string
  evmWallet: string
  solanaWallet: string
  direction: MainnetSolanaActivityDirection
  amount: string
  createdAt: number
  sourceTxHash?: string
  destinationTxHash?: string
  refundableDepositSol?: string
  refundAvailableAt?: number
}

const MAX_RECORDS = 100
const RETENTION_MS = 90 * 24 * 60 * 60 * 1000

function canUseStorage() {
  return typeof window !== 'undefined' && typeof window.localStorage !== 'undefined'
}

function normalize(value: string) {
  return value.trim().toLowerCase()
}

function emitChange() {
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new Event(MAINNET_SOLANA_ACTIVITY_EVENT))
  }
}

export function readMainnetSolanaActivity(): MainnetSolanaActivityRecord[] {
  if (!canUseStorage()) return []

  try {
    const raw = window.localStorage.getItem(MAINNET_SOLANA_ACTIVITY_KEY)
    const parsed = raw ? JSON.parse(raw) : []
    if (!Array.isArray(parsed)) return []

    const cutoff = Date.now() - RETENTION_MS
    return (parsed as MainnetSolanaActivityRecord[])
      .filter((item) => item && typeof item === 'object' && item.createdAt >= cutoff)
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, MAX_RECORDS)
  } catch {
    return []
  }
}

function write(records: MainnetSolanaActivityRecord[]) {
  if (!canUseStorage()) return

  window.localStorage.setItem(
    MAINNET_SOLANA_ACTIVITY_KEY,
    JSON.stringify(records.sort((a, b) => b.createdAt - a.createdAt).slice(0, MAX_RECORDS)),
  )
  emitChange()
}

export function recordMainnetSolanaActivity(
  input: Omit<MainnetSolanaActivityRecord, 'id' | 'createdAt'> & { createdAt?: number },
) {
  const existing = readMainnetSolanaActivity()
  const sourceHash = input.sourceTxHash?.toLowerCase()

  const duplicate = sourceHash
    ? existing.find((item) => item.sourceTxHash?.toLowerCase() === sourceHash)
    : undefined

  const record: MainnetSolanaActivityRecord = {
    id: duplicate?.id
      ?? (typeof globalThis.crypto?.randomUUID === 'function'
        ? globalThis.crypto.randomUUID()
        : `solana-mainnet-${Date.now()}-${Math.random().toString(36).slice(2)}`),
    createdAt: input.createdAt ?? duplicate?.createdAt ?? Date.now(),
    ...duplicate,
    ...input,
  }

  write([record, ...existing.filter((item) => item.id !== record.id)])
  return record
}

export function listMainnetSolanaActivity(
  evmWallet?: string,
  solanaWallet?: string,
) {
  const records = readMainnetSolanaActivity()
  if (!evmWallet && !solanaWallet) return records

  const evm = evmWallet ? normalize(evmWallet) : null
  const solana = solanaWallet ? solanaWallet.trim() : null

  return records.filter((item) =>
    (evm && normalize(item.evmWallet) === evm)
    || (solana && item.solanaWallet === solana),
  )
}

export function subscribeMainnetSolanaActivity(listener: () => void) {
  if (typeof window === 'undefined') return () => undefined

  const onStorage = (event: StorageEvent) => {
    if (event.key === MAINNET_SOLANA_ACTIVITY_KEY) listener()
  }
  const onLocal = () => listener()

  window.addEventListener('storage', onStorage)
  window.addEventListener(MAINNET_SOLANA_ACTIVITY_EVENT, onLocal)

  return () => {
    window.removeEventListener('storage', onStorage)
    window.removeEventListener(MAINNET_SOLANA_ACTIVITY_EVENT, onLocal)
  }
}
