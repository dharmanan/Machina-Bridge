export const MAINNET_TRANSFER_QUEUE_KEY = 'machina_mainnet_transfers_v1'
export const MAINNET_TRANSFER_QUEUE_EVENT = 'machina:mainnet-transfer-queue'

export type MainnetTransferStage =
  | 'ready'
  | 'approval_required'
  | 'approving'
  | 'approved'
  | 'burning'
  | 'waiting_attestation'
  | 'ready_to_mint'
  | 'minting'
  | 'complete'
  | 'failed'

export type MainnetTransferRecord = {
  id: string
  walletAddress: string
  sourceChainId: number
  destinationChainId: number
  amount: string
  token: 'USDC'
  mode: 'fast'
  recipient: string
  destinationCaller: string
  stage: MainnetTransferStage
  approvalRequired: boolean
  createdAt: number
  updatedAt: number
  approvalTxHash?: string
  sourceTxHash?: string
  destinationTxHash?: string
  attestationReadyAt?: number
  lastError?: string
}

export type CreateMainnetTransferInput = {
  walletAddress: string
  sourceChainId: number
  destinationChainId: number
  amount: string
  recipient: string
  destinationCaller: string
  approvalRequired: boolean
}

const COMPLETE_RETENTION_MS = 30 * 24 * 60 * 60 * 1000
const MAX_RECORDS = 100

const ALLOWED_TRANSITIONS: Record<MainnetTransferStage, readonly MainnetTransferStage[]> = {
  ready: ['approval_required', 'burning', 'failed'],
  approval_required: ['approving', 'failed'],
  approving: ['approved', 'approval_required', 'failed'],
  approved: ['burning', 'failed'],
  burning: ['waiting_attestation', 'approved', 'ready', 'failed'],
  waiting_attestation: ['ready_to_mint', 'failed'],
  ready_to_mint: ['minting', 'failed'],
  minting: ['complete', 'ready_to_mint', 'failed'],
  complete: [],
  failed: ['ready', 'approval_required', 'approved', 'waiting_attestation', 'ready_to_mint'],
}

function canUseStorage() {
  return typeof window !== 'undefined' && typeof window.localStorage !== 'undefined'
}

function createId() {
  if (typeof globalThis.crypto?.randomUUID === 'function') {
    return globalThis.crypto.randomUUID()
  }
  return `mainnet-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

function normalizeWallet(address: string) {
  return address.trim().toLowerCase()
}

function prune(records: MainnetTransferRecord[]) {
  const completeCutoff = Date.now() - COMPLETE_RETENTION_MS
  return records
    .filter((record) => record.stage !== 'complete' || record.updatedAt >= completeCutoff)
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, MAX_RECORDS)
}

function emitQueueChange() {
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new Event(MAINNET_TRANSFER_QUEUE_EVENT))
  }
}

export function readMainnetTransferQueue(): MainnetTransferRecord[] {
  if (!canUseStorage()) return []

  try {
    const raw = window.localStorage.getItem(MAINNET_TRANSFER_QUEUE_KEY)
    const parsed = raw ? JSON.parse(raw) : []
    if (!Array.isArray(parsed)) return []
    return prune(parsed as MainnetTransferRecord[])
  } catch {
    return []
  }
}

function writeMainnetTransferQueue(records: MainnetTransferRecord[]) {
  if (!canUseStorage()) return

  const next = prune(records)
  window.localStorage.setItem(MAINNET_TRANSFER_QUEUE_KEY, JSON.stringify(next))
  emitQueueChange()
}

export function listMainnetTransfers(walletAddress?: string) {
  const records = readMainnetTransferQueue()
  if (!walletAddress) return records

  const wallet = normalizeWallet(walletAddress)
  return records.filter((record) => normalizeWallet(record.walletAddress) === wallet)
}

export function getMainnetTransfer(id: string) {
  return readMainnetTransferQueue().find((record) => record.id === id)
}

export function createMainnetTransferRecord(
  input: CreateMainnetTransferInput,
): MainnetTransferRecord {
  const now = Date.now()
  const record: MainnetTransferRecord = {
    id: createId(),
    walletAddress: normalizeWallet(input.walletAddress),
    sourceChainId: input.sourceChainId,
    destinationChainId: input.destinationChainId,
    amount: input.amount,
    token: 'USDC',
    mode: 'fast',
    recipient: input.recipient,
    destinationCaller: input.destinationCaller,
    stage: input.approvalRequired ? 'approval_required' : 'ready',
    approvalRequired: input.approvalRequired,
    createdAt: now,
    updatedAt: now,
  }

  writeMainnetTransferQueue([record, ...readMainnetTransferQueue()])
  return record
}

export function updateMainnetTransferRecord(
  id: string,
  patch: Partial<Omit<MainnetTransferRecord, 'id' | 'createdAt'>>,
) {
  const records = readMainnetTransferQueue()
  let updated: MainnetTransferRecord | undefined

  const next = records.map((record) => {
    if (record.id !== id) return record
    updated = {
      ...record,
      ...patch,
      id: record.id,
      createdAt: record.createdAt,
      updatedAt: Date.now(),
    }
    return updated
  })

  if (updated) {
    writeMainnetTransferQueue(next)
  }

  return updated
}

export function transitionMainnetTransfer(
  id: string,
  nextStage: MainnetTransferStage,
  patch: Partial<Omit<MainnetTransferRecord, 'id' | 'createdAt' | 'stage'>> = {},
) {
  const current = getMainnetTransfer(id)
  if (!current) {
    throw new Error('Mainnet transfer record not found')
  }

  if (current.stage !== nextStage && !ALLOWED_TRANSITIONS[current.stage].includes(nextStage)) {
    throw new Error(`Invalid mainnet transfer transition: ${current.stage} -> ${nextStage}`)
  }

  return updateMainnetTransferRecord(id, {
    ...patch,
    stage: nextStage,
  })
}

export function subscribeMainnetTransferQueue(listener: () => void) {
  if (typeof window === 'undefined') return () => undefined

  const handleStorage = (event: StorageEvent) => {
    if (event.key === MAINNET_TRANSFER_QUEUE_KEY) listener()
  }
  const handleLocal = () => listener()

  window.addEventListener('storage', handleStorage)
  window.addEventListener(MAINNET_TRANSFER_QUEUE_EVENT, handleLocal)

  return () => {
    window.removeEventListener('storage', handleStorage)
    window.removeEventListener(MAINNET_TRANSFER_QUEUE_EVENT, handleLocal)
  }
}
