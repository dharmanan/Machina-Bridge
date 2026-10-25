import { MAINNET_BORROW_CHAIN_ID } from '../config/mainnetBorrow'
import type { AttemptLogHealth, BorrowAttemptRecord, BorrowAttemptStatus, BorrowWriteAction } from './borrowWriteSafety'
import { isBorrowUnsentProof, type BorrowUnsentProof } from './borrowSubmissionGuard'
import { isBorrowSettlementProof, type BorrowSettlementProof } from './borrowSettlement'

// The record of Borrow writes that were started from this browser, so a double click, a page reload or an unclear answer from the
// wallet or the RPC cannot send the same write twice. Pure apart from the storage handed in; it has no wallet, SDK or network
// access and it never sends anything.
//
// Rules this module keeps:
//  - fail closed: if the history cannot be read, written or understood, it says so (health().ok is false) and nothing is
//    prepared. It is never emptied, repaired or reset on its own, because an empty history would allow a second send;
//  - an attempt that is running, submitted, interrupted by a reload, failed or finished is "unresolved" until a person has
//    acknowledged an independently verified receipt/position proof (resolve); nothing clears it automatically, not even time;
//  - what is saved is public and small: the wallet address and network the record belongs to, the market or loan, the amount,
//    the status, an idempotency key and, if known, a batch ID or transaction hash. No key, seed phrase, signature, balance or
//    quote is ever saved;
//  - records are only applied to the wallet and network they were saved for, and one that does not match is treated as unreadable,
//    not skipped.
//
// This ledger is not a cross-tab mutex. Submission must additionally hold the wallet-wide Web Lock.
// Limits (also reported to the user): browser storage does not follow the person to another device or browser, and it can be
// cleared by the person or the browser. It protects against reloads and double clicks, not against those.

export type BorrowAttemptLedger = {
  health(): AttemptLogHealth
  list(): BorrowAttemptRecord[]
  get(scopeId: string): BorrowAttemptRecord | null
  // Registers an attempt before anything is sent. False when one already exists for the scope, when the history cannot be trusted
  // or when the record could not be saved, so two clicks cannot both go ahead and nothing goes ahead unrecorded.
  begin(record: { scopeId: string; actionId: string; kind: BorrowWriteAction['kind']; idempotencyKey: string }, now: number): boolean
  // Removes an attempt that provably never reached the SDK (the adapter could not be built or belongs to another wallet).
  discard(scopeId: string, unsent?: BorrowUnsentProof): void
  finish(scopeId: string, status: Exclude<BorrowAttemptStatus, 'in-flight' | 'interrupted'>, now: number, detail?: { batchId?: string; txHash?: string; errorCode?: string }): void
  // Clears an unresolved attempt only with acknowledgment, a fresh position and independently issued settlement proof. Returns
  // whether it cleared.
  resolve(scopeId: string, proof: { positionReadAt: number; acknowledged: boolean; settlement?: BorrowSettlementProof }): boolean
}

// The part of the Web Storage API the ledger uses.
export type StorageLike = {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

const ADDRESS = /^0x[0-9a-fA-F]{40}$/
const KINDS: readonly BorrowWriteAction['kind'][] = ['borrow', 'borrow-more', 'repay', 'add-collateral', 'withdraw-collateral', 'close-loan']
const STATUSES: readonly BorrowAttemptStatus[] = ['in-flight', 'submitted', 'interrupted', 'failed', 'confirmed']
const SCOPE = /^(\d+)\|(0x[0-9a-f]{40})\|(0x[0-9a-f]{64}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/
const MAX_RECORDS = 100
const MAX_TEXT = 300

export const ATTEMPT_STORAGE_PREFIX = 'machina.borrow.attempts.v1'

// Browser localStorage if the browser gives it out. Reading the property can throw (blocked cookies, sandboxed frames), and then
// there is no storage and the ledger reports itself unavailable.
export function browserAttemptStorage(): StorageLike | null {
  try {
    return typeof globalThis.localStorage === 'object' && globalThis.localStorage !== null ? globalThis.localStorage : null
  } catch {
    return null
  }
}

export function attemptStorageKey(address: string, chainId: number): string {
  return `${ATTEMPT_STORAGE_PREFIX}:${address.toLowerCase()}:${chainId}`
}

// A record is written by this module only; anything else in the key is not trusted. Strict: unknown fields, wrong types and a
// record for another wallet or network all make the whole history unreadable.
type StoredRecord = BorrowAttemptRecord & { session: string }

function textOf(value: unknown, max = MAX_TEXT): string | null {
  return typeof value === 'string' && value.length <= max ? value : null
}

function parseRecord(value: unknown, address: string, chainId: number): StoredRecord | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const raw = value as Record<string, unknown>
  const allowed = ['scopeId', 'actionId', 'kind', 'status', 'idempotencyKey', 'startedAt', 'updatedAt', 'batchId', 'txHash', 'errorCode', 'session']
  if (Object.keys(raw).some((key) => !allowed.includes(key))) return null
  const scopeId = textOf(raw.scopeId)
  const actionId = textOf(raw.actionId)
  const idempotencyKey = textOf(raw.idempotencyKey, 64)
  const session = textOf(raw.session, 64)
  const kind = KINDS.find((candidate) => candidate === raw.kind)
  const status = STATUSES.find((candidate) => candidate === raw.status)
  if (scopeId === null || actionId === null || idempotencyKey === null || session === null || !kind || !status) return null
  if (typeof raw.startedAt !== 'number' || typeof raw.updatedAt !== 'number' || !Number.isFinite(raw.startedAt) || !Number.isFinite(raw.updatedAt)
    || raw.startedAt < 0 || raw.updatedAt < raw.startedAt) return null
  // The record must belong to exactly this wallet, this network and this kind of write.
  const scope = SCOPE.exec(scopeId)
  if (!scope || Number(scope[1]) !== chainId || scope[2] !== address.toLowerCase()) return null
  if (!actionId.startsWith(`${kind}|${chainId}|${address.toLowerCase()}|`)) return null
  const optional = (field: 'batchId' | 'txHash' | 'errorCode'): { ok: boolean; value?: string } => {
    if (raw[field] === undefined) return { ok: true }
    const text = textOf(raw[field])
    return text === null ? { ok: false } : { ok: true, value: text }
  }
  const batchId = optional('batchId')
  const txHash = optional('txHash')
  const errorCode = optional('errorCode')
  if (!batchId.ok || !txHash.ok || !errorCode.ok) return null
  return {
    scopeId, actionId, kind, status, idempotencyKey, startedAt: raw.startedAt, updatedAt: raw.updatedAt, session,
    ...(batchId.value !== undefined && { batchId: batchId.value }),
    ...(txHash.value !== undefined && { txHash: txHash.value }),
    ...(errorCode.value !== undefined && { errorCode: errorCode.value }),
  }
}

type Reading = { ok: true; records: StoredRecord[] } | { ok: false; reason: 'storage_unavailable' | 'records_unreadable' }

function newInstanceId(): string {
  try {
    return globalThis.crypto.randomUUID()
  } catch {
    return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}`
  }
}

function strip(record: StoredRecord): BorrowAttemptRecord {
  const { session: _session, ...visible } = record
  void _session
  return visible
}

// In memory only: not saved across reloads, so the boundary never accepts it for a real write. For tests and for callers that
// have no storage; health().persistent is false.
export function createBorrowAttemptLedger(): BorrowAttemptLedger {
  const records = new Map<string, BorrowAttemptRecord>()
  return {
    health: () => ({ ok: true, persistent: false, reason: null }),
    list: () => [...records.values()].map((record) => ({ ...record })),
    get: (scopeId) => (records.has(scopeId) ? { ...(records.get(scopeId) as BorrowAttemptRecord) } : null),
    begin(record, now) {
      if (!record.scopeId || records.has(record.scopeId)) return false
      records.set(record.scopeId, { ...record, status: 'in-flight', startedAt: now, updatedAt: now })
      return true
    },
    discard(scopeId) {
      if (records.get(scopeId)?.status === 'in-flight') records.delete(scopeId)
    },
    finish(scopeId, status, now, detail = {}) {
      const record = records.get(scopeId)
      if (record) records.set(scopeId, { ...record, ...detail, status, updatedAt: now })
    },
    resolve(scopeId, proof) {
      const record = records.get(scopeId)
      if (!proof.acknowledged || !record || record.status === 'in-flight' || !(proof.positionReadAt > record.updatedAt)) return false
      records.delete(scopeId)
      return true
    },
  }
}

// Saved in browser storage for one wallet on one network. Every call reads the storage again, so a second tab's attempt is seen at
// once and nothing is cached that another tab could have changed.
export function createPersistentAttemptLedger(
  storage: StorageLike | null,
  address: string,
  chainId: number = MAINNET_BORROW_CHAIN_ID,
  options: { instanceId?: string } = {},
): BorrowAttemptLedger {
  const instance = options.instanceId ?? newInstanceId()
  const key = ADDRESS.test(address) ? attemptStorageKey(address, chainId) : ''
  let writeFailed = false

  function read(): Reading {
    if (!storage || !key) return { ok: false, reason: 'storage_unavailable' }
    let raw: string | null
    try {
      raw = storage.getItem(key)
    } catch {
      return { ok: false, reason: 'storage_unavailable' }
    }
    if (raw === null) return { ok: true, records: [] }
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      return { ok: false, reason: 'records_unreadable' }
    }
    if (typeof parsed !== 'object' || parsed === null || (parsed as { v?: unknown }).v !== 1) return { ok: false, reason: 'records_unreadable' }
    const list = (parsed as { records?: unknown }).records
    if (!Array.isArray(list) || list.length > MAX_RECORDS) return { ok: false, reason: 'records_unreadable' }
    const records: StoredRecord[] = []
    for (const item of list) {
      const record = parseRecord(item, address, chainId)
      if (!record || records.some((other) => other.scopeId === record.scopeId)) return { ok: false, reason: 'records_unreadable' }
      records.push(record)
    }
    return { ok: true, records }
  }

  // Saved, then read back: a write the browser silently dropped counts as failed.
  function write(records: StoredRecord[]): boolean {
    if (!storage || !key) return false
    const payload = JSON.stringify({ v: 1, records })
    try {
      storage.setItem(key, payload)
      writeFailed = storage.getItem(key) !== payload
    } catch {
      writeFailed = true
    }
    return !writeFailed
  }

  // What this page may call running. A record another page left "in-flight" belongs to a send that was cut off (a reload) or that
  // another tab is making: either way its outcome is not known to this page.
  const view = (record: StoredRecord): StoredRecord => (record.status === 'in-flight' && record.session !== instance ? { ...record, status: 'interrupted' } : record)

  return {
    health() {
      const state = read()
      if (!state.ok) return { ok: false, persistent: true, reason: state.reason }
      return writeFailed ? { ok: false, persistent: true, reason: 'storage_write_failed' } : { ok: true, persistent: true, reason: null }
    },
    list() {
      const state = read()
      return state.ok ? state.records.map((record) => strip(view(record))) : []
    },
    get(scopeId) {
      const state = read()
      const record = state.ok ? state.records.find((candidate) => candidate.scopeId === scopeId) : undefined
      return record ? strip(view(record)) : null
    },
    begin(record, now) {
      const state = read()
      if (!state.ok || !record.scopeId || state.records.some((candidate) => candidate.scopeId === record.scopeId)) return false
      if (state.records.length >= MAX_RECORDS) return false
      return write([...state.records, { ...record, status: 'in-flight', startedAt: now, updatedAt: now, session: instance }])
    },
    discard(scopeId, unsent) {
      const state = read()
      if (!state.ok) return
      const record = state.records.find((candidate) => candidate.scopeId === scopeId)
      // Only this page's own attempt. A post-SDK failure additionally requires a sealed transport proof; a mismatched proof never clears an older in-flight attempt.
      const provenUnsent = record && isBorrowUnsentProof(unsent) && unsent.owner === address.toLowerCase() && unsent.scopeId === record.scopeId
        && unsent.actionId === record.actionId && unsent.idempotencyKey === record.idempotencyKey && !record.txHash && !record.batchId
        && ['in-flight', 'failed'].includes(record.status)
      if (record && record.session === instance && (unsent === undefined ? record.status === 'in-flight' : provenUnsent)) write(state.records.filter((candidate) => candidate !== record))
    },
    finish(scopeId, status, now, detail = {}) {
      const state = read()
      if (!state.ok) return
      const record = state.records.find((candidate) => candidate.scopeId === scopeId)
      if (!record || record.status !== 'in-flight' || record.session !== instance) return
      write(state.records.map((candidate) => (candidate === record ? { ...record, ...detail, status, updatedAt: Math.max(now, record.startedAt) } : candidate)))
    },
    resolve(scopeId, proof) {
      const state = read()
      if (!state.ok || !proof.acknowledged) return false
      const record = state.records.find((candidate) => candidate.scopeId === scopeId)
      // A cut-off attempt (another page's in-flight record) can be resolved like a submitted one; this page's own running attempt cannot.
      const status = record ? view(record).status : null
      if (!record || status === 'in-flight' || !(proof.positionReadAt > record.updatedAt)) return false
      // A fresh service position timestamp is NOT proof that a submitted/unknown batch settled. Keep legacy records
      // without a known hash unresolved; an independent exact-batch/receipt proof is required before re-enabling sends.
      if (!isBorrowSettlementProof(proof.settlement) || !record.txHash
        || proof.settlement.scopeId !== scopeId || proof.settlement.owner !== address.toLowerCase()
        || proof.settlement.chainId !== chainId || proof.settlement.txHash.toLowerCase() !== record.txHash.toLowerCase()) return false
      return write(state.records.filter((candidate) => candidate !== record))
    },
  }
}
