// Transaction records are never deleted by the application. When an owner's active journal is full, the oldest settled record moves to an
// archive in the same storage; if the archive cannot take it (storage full, unreadable archive, failed read-back) nothing is evicted and the
// journal refuses the NEW record, so no wallet request is made and no existing record is lost.
// An archived entry that today's rules no longer accept is kept untouched (it is counted, not shown): one old entry never stops the
// journal from recording new ones, and never makes the other records unreadable.
export interface ArchiveStorage { getItem(key: string): string | null; setItem(key: string, value: string): void }
export const ARCHIVE_MAX_CHARS = 2_500_000

function rawEntries(storage: Pick<ArchiveStorage, 'getItem'>, key: string): unknown[] {
  const raw = storage.getItem(key)
  if (raw === null) return []
  if (raw.length > ARCHIVE_MAX_CHARS) throw new Error('storage')
  const data = JSON.parse(raw)
  if (!Array.isArray(data)) throw new Error('storage')
  return data
}
const idOf = (entry: unknown): string | undefined => (entry && typeof entry === 'object' && typeof (entry as { id?: unknown }).id === 'string' ? (entry as { id: string }).id : undefined)

// Entries that pass the current validation; the others are skipped here (see archiveUnreadable) and stay in storage.
export function readArchive<T extends { id: string }>(storage: Pick<ArchiveStorage, 'getItem'>, key: string, validate: (value: unknown) => T): T[] {
  const records: T[] = []
  for (const entry of rawEntries(storage, key)) {
    let record: T
    try { record = validate(entry) } catch { continue }
    if (!records.some(known => known.id === record.id)) records.push(record)
  }
  return records
}
export function archiveUnreadable<T extends { id: string }>(storage: Pick<ArchiveStorage, 'getItem'>, key: string, validate: (value: unknown) => T): number {
  return rawEntries(storage, key).filter(entry => { try { validate(entry); return false } catch { return true } }).length
}
export function archiveRecord<T extends { id: string }>(storage: ArchiveStorage, key: string, evicted: T, validate?: (value: unknown) => T): void {
  if (validate) validate(evicted) // the record being moved is a live, validated one
  const existing = rawEntries(storage, key) // opaque: older entries are carried over exactly as stored
  const next = existing.some(entry => idOf(entry) === evicted.id) ? existing.map(entry => (idOf(entry) === evicted.id ? evicted : entry)) : [...existing, evicted]
  const text = JSON.stringify(next)
  if (text.length > ARCHIVE_MAX_CHARS) throw new Error('storage')
  storage.setItem(key, text)
  if (storage.getItem(key) !== text) throw new Error('storage')
}
