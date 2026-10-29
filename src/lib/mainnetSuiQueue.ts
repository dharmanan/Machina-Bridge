import { assertSuiDigest } from './mainnetSuiRead'
import type { SuiRecoveryResult } from './mainnetSuiRecovery'
import { parseUnits } from 'viem'

const KEY = 'machina_mainnet_sui_transfers_v1'
const EVENT = 'machina:mainnet-sui-transfers'
export type SuiRecoveryRecord = SuiRecoveryResult & { id: string }
export function suiTransferIdentity(r: Pick<SuiRecoveryResult, 'direction' | 'sourceId' | 'sourceEventIndex'>) {
  return `${r.direction}:${r.direction === 'arc-to-sui' ? r.sourceId.toLowerCase() : r.sourceId}:${r.sourceEventIndex}`
}
function valid(r: any): r is SuiRecoveryRecord {
  try {
    if (!r || !['sui-to-arc','arc-to-sui'].includes(r.direction) || !['waiting_attestation','ready_to_mint','complete'].includes(r.stage) || !/^0x[0-9a-f]{64}$/i.test(r.suiOwner) || !/^0x[0-9a-f]{40}$/i.test(r.evmOwner) || !Number.isSafeInteger(r.sourceEventIndex) || r.sourceEventIndex < 0 || !Number.isSafeInteger(r.checkedAt) || r.checkedAt <= 0 || typeof r.amount !== 'string' || r.amount.length > 40 || !/^[0-9]+(?:\.[0-9]{1,6})?$/.test(r.amount) || !/[1-9]/.test(r.amount)) return false
    if (/^0x0+$/i.test(r.suiOwner) || /^0x0+$/i.test(r.evmOwner) || parseUnits(r.amount, 6) > (1n << 64n) - 1n) return false
    if (r.stage !== 'waiting_attestation') {
      if (![r.feeUsdc,r.receivedUsdc].every(v => typeof v === 'string' && v.length < 40 && /^[0-9]+(?:\.[0-9]{1,6})?$/.test(v)) || parseUnits(r.receivedUsdc,6) <= 0n || parseUnits(r.receivedUsdc,6) + parseUnits(r.feeUsdc,6) !== parseUnits(r.amount,6)) return false
    }
    if (r.direction === 'sui-to-arc') assertSuiDigest(r.sourceId)
    else if (!/^0x[0-9a-f]{64}$/i.test(r.sourceId)) return false
    if (r.destinationTx !== undefined) { if (r.direction === 'arc-to-sui') assertSuiDigest(r.destinationTx); else if (!/^0x[0-9a-f]{64}$/i.test(r.destinationTx)) return false }
    return r.id === suiTransferIdentity(r)
  } catch { return false }
}
export function readSuiRecoveryQueue(): SuiRecoveryRecord[] {
  try {
    const raw = window.localStorage.getItem(KEY) ?? '[]'
    if (raw.length > 262144) return []
    const data = JSON.parse(raw)
    if (!Array.isArray(data) || data.length > 500) return []
    const seen = new Set<string>()
    return data.filter(r => { if (!valid(r) || seen.has(r.id)) return false; seen.add(r.id); return true }).slice(0, 50)
  } catch { return [] }
}
export function importSuiRecovery(result: SuiRecoveryResult) {
  const record: SuiRecoveryRecord = { ...result, id: suiTransferIdentity(result) }
  if (!valid(record)) throw new Error('Invalid Sui recovery record.')
  const records = readSuiRecoveryQueue(), old = records.find(r => r.id === record.id)
  if (old && (old.evmOwner.toLowerCase() !== record.evmOwner.toLowerCase() || old.suiOwner.toLowerCase() !== record.suiOwner.toLowerCase() || old.amount !== record.amount)) throw new Error('Stored Sui source identity belongs to a different transfer.')
  if (old?.stage === 'complete' && record.stage !== 'complete') throw new Error('Stored completion cannot be reconciled. Keep history and do not request another mint.')
  // A cached completion never authorizes a send; the UI explicitly marks all
  // persisted rows as history until the user requests a fresh independent read.
  window.localStorage.setItem(KEY, JSON.stringify([record, ...records.filter(r => r.id !== record.id)].slice(0, 50)))
  window.dispatchEvent(new Event(EVENT)); return record
}
export function subscribeSuiRecovery(listener: () => void) {
  const storage = (e: StorageEvent) => { if (e.key === KEY) listener() }
  window.addEventListener(EVENT, listener); window.addEventListener('storage', storage)
  return () => { window.removeEventListener(EVENT, listener); window.removeEventListener('storage', storage) }
}
