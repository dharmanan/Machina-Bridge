import type { MainnetCctpTransferMode } from '../config/mainnetCctp'

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
  mode: MainnetCctpTransferMode
  recipient: string
  destinationCaller: string
  stage: MainnetTransferStage
  approvalRequired: boolean
  createdAt: number
  updatedAt: number
  approvalTxHash?: string
  recovered?: boolean
  sourceLogIndex?: number
  mintRequestedAt?: number
  sourceTxHash?: string
  destinationTxHash?: string
  attestationReadyAt?: number
  lastError?: string
  // Evidence taken right before the last approval/burn wallet request (account nonce, block).
  attemptNonce?: number
  attemptBlock?: number
}

export type CreateMainnetTransferInput = {
  walletAddress: string
  sourceChainId: number
  destinationChainId: number
  amount: string
  recipient: string
  destinationCaller: string
  approvalRequired: boolean
  mode: MainnetCctpTransferMode
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
  try { return typeof window !== 'undefined' && typeof window.localStorage !== 'undefined' } catch { return false }
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

export function isValidMainnetTransferRecord(value: unknown): value is MainnetTransferRecord {
  if (!value || typeof value !== 'object') return false
  const r = value as MainnetTransferRecord
  return typeof r.id === 'string' && r.id.length > 0 && r.id.length < 200
    && [r.walletAddress, r.recipient, r.destinationCaller].every(x => typeof x === 'string' && /^0x[0-9a-f]{40}$/i.test(x))
    && [r.sourceChainId, r.destinationChainId, r.createdAt, r.updatedAt].every(x => Number.isSafeInteger(x) && x > 0)
    && r.sourceChainId !== r.destinationChainId && typeof r.amount === 'string' && r.amount.length < 100 && /^[0-9]+(?:\.[0-9]{1,6}0*)?$/.test(r.amount) && /[1-9]/.test(r.amount)
    && r.token === 'USDC' && ['fast','standard'].includes(r.mode) && Object.prototype.hasOwnProperty.call(ALLOWED_TRANSITIONS, r.stage)
    && typeof r.approvalRequired === 'boolean'
    && [r.sourceTxHash, r.destinationTxHash, r.approvalTxHash].every(x => x === undefined || typeof x === 'string' && /^0x[0-9a-f]{64}$/i.test(x))
    && (r.sourceLogIndex === undefined || Number.isSafeInteger(r.sourceLogIndex) && r.sourceLogIndex >= 0)
    && [r.attemptNonce, r.attemptBlock].every(x => x === undefined || Number.isSafeInteger(x) && x >= 0)
}

export function importRecoveredMainnetTransfer(input: CreateMainnetTransferInput & { sourceTxHash: string; sourceLogIndex: number; stage: 'waiting_attestation' | 'ready_to_mint' | 'complete' }): MainnetTransferRecord {
  const records = readMainnetTransferQueue(), hash = input.sourceTxHash.toLowerCase()
  const existing = records.find(r => r.sourceChainId === input.sourceChainId && r.sourceTxHash?.toLowerCase() === hash && (r.sourceLogIndex === undefined || r.sourceLogIndex === input.sourceLogIndex))
  if (existing && normalizeWallet(existing.walletAddress) !== normalizeWallet(input.walletAddress)) throw new Error('This source transaction is bound to another wallet.')
  if (existing?.stage === 'complete' && input.stage !== 'complete') throw new Error('Stored completion cannot be reconciled on-chain. No second mint is allowed.')
  const now = Date.now()
  const record: MainnetTransferRecord = { ...existing, ...input, id: existing?.id ?? `cctp-${input.sourceChainId}-${hash}-${input.sourceLogIndex}`, walletAddress: normalizeWallet(input.walletAddress), token:'USDC', recovered:true, createdAt:existing?.createdAt ?? now, updatedAt:now,
    stage: existing && (existing.stage === 'minting' || existing.mintRequestedAt || existing.destinationTxHash) && input.stage !== 'complete' ? 'minting' : input.stage,
    lastError: undefined }
  if (!isValidMainnetTransferRecord(record)) throw new Error('Recovered transfer has invalid fields.')
  writeMainnetTransferQueue([record, ...records.filter(r => r.id !== record.id)])
  return record
}

export function readMainnetTransferQueue(): MainnetTransferRecord[] {
  if (!canUseStorage()) return []

  try {
    const raw = window.localStorage.getItem(MAINNET_TRANSFER_QUEUE_KEY)
    const parsed = raw ? JSON.parse(raw) : []
    if (!Array.isArray(parsed)) return []
    return prune(parsed.filter(isValidMainnetTransferRecord))
  } catch {
    return []
  }
}

function writeMainnetTransferQueue(records: MainnetTransferRecord[]) {
  if (!canUseStorage()) throw new Error('Persistent transfer storage is unavailable. No wallet transaction is allowed.')

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
    mode: input.mode,
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
