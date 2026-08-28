const BRIDGE_ACTIVITY_KEY = 'arc_bridge_activity'

type LocalBridgeActivity = {
  id?: string
  sourceTxHash?: string
  status?: string
  updatedAt?: number
  [key: string]: unknown
}

export function dismissLocalBridgeActivity(id?: string, sourceTxHash?: string) {
  try {
    const raw = localStorage.getItem(BRIDGE_ACTIVITY_KEY)
    const parsed = raw ? JSON.parse(raw) : []
    if (!Array.isArray(parsed)) {
      return false
    }

    const normalizedId = id?.toLowerCase()
    const normalizedSourceTxHash = sourceTxHash?.toLowerCase()
    let changed = false

    const next = parsed.map((entry: LocalBridgeActivity) => {
      const entryId = typeof entry?.id === 'string' ? entry.id.toLowerCase() : undefined
      const entrySourceTxHash = typeof entry?.sourceTxHash === 'string' ? entry.sourceTxHash.toLowerCase() : undefined
      const matches = Boolean(
        (normalizedId && entryId === normalizedId)
        || (normalizedSourceTxHash && entrySourceTxHash === normalizedSourceTxHash),
      )

      if (!matches) {
        return entry
      }

      changed = true
      return {
        ...entry,
        status: 'dismissed',
        updatedAt: Date.now(),
      }
    })

    if (changed) {
      localStorage.setItem(BRIDGE_ACTIVITY_KEY, JSON.stringify(next))
    }

    return changed
  } catch {
    return false
  }
}
