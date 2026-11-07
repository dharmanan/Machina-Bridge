const BRIDGE_ACTIVITY_KEY = 'arc_bridge_activity'

// A Testnet Bridge history row as shown in the Bridge tab. Built only from this browser's
// local records (arc_bridge_activity / arc_pending_bridge); there is no server-side history.
export interface TrackedTransfer {
  id: string
  walletAddress: string
  sourceChainId: number
  destinationChainId: number
  amount: string
  token: string
  sourceTxHash: string
  destinationTxHash: string | null
  status: 'pending_attestation' | 'ready_to_mint' | 'minted' | 'dismissed'
  createdAt: number
  updatedAt: number
}

type LocalBridgeActivity = {
  id?: string
  walletAddress?: string
  sourceTxHash?: string
  status?: string
  updatedAt?: number
  [key: string]: unknown
}

// Hides a Testnet history row of `walletAddress` in this browser only. It changes nothing on chain:
// no transfer is cancelled, and the pending-bridge resume record (arc_pending_bridge) is not touched.
// Records of other wallets are never changed, even if an id or source hash matches.
export function dismissLocalBridgeActivity(input: { walletAddress: string; id?: string; sourceTxHash?: string }): boolean {
  try {
    const wallet = input.walletAddress?.toLowerCase()
    const normalizedId = input.id?.toLowerCase()
    const normalizedSourceTxHash = input.sourceTxHash?.toLowerCase()
    if (!wallet || (!normalizedId && !normalizedSourceTxHash)) {
      return false
    }

    const raw = localStorage.getItem(BRIDGE_ACTIVITY_KEY)
    const parsed = raw ? JSON.parse(raw) : []
    if (!Array.isArray(parsed)) {
      return false
    }

    let changed = false

    const next = parsed.map((entry: LocalBridgeActivity) => {
      const entryWallet = typeof entry?.walletAddress === 'string' ? entry.walletAddress.toLowerCase() : undefined
      const entryId = typeof entry?.id === 'string' ? entry.id.toLowerCase() : undefined
      const entrySourceTxHash = typeof entry?.sourceTxHash === 'string' ? entry.sourceTxHash.toLowerCase() : undefined
      const matches = entryWallet === wallet && Boolean(
        (normalizedId && entryId === normalizedId)
        || (normalizedSourceTxHash && entrySourceTxHash === normalizedSourceTxHash),
      )

      if (!matches || entry.status === 'dismissed') {
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
