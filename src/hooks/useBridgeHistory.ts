import { useEffect, useMemo, useState } from 'react'
import { buildBridgeHistory, bridgeRouteStats, readSuiSessionChecks, subscribeSuiSessionChecks } from '../lib/bridgeHistory'
import { listMainnetTransfers, subscribeMainnetTransferQueue } from '../lib/mainnetTransferQueue'
import { listMainnetSolanaActivity, subscribeMainnetSolanaActivity } from '../lib/mainnetSolanaActivity'
import { readSuiRecoveryQueue, subscribeSuiRecovery } from '../lib/mainnetSuiQueue'

// One read-only list for Dashboard and Activity: the EVM, Solana and Sui transfer
// records this browser knows for the connected wallets. No polling, no chain reads.
export function useBridgeHistory(wallets: { evm?: string | null; solana?: string | null; sui?: string | null }) {
  const evm = wallets.evm?.toLowerCase() ?? '', solana = wallets.solana ?? '', sui = wallets.sui?.toLowerCase() ?? ''
  const [version, setVersion] = useState(0)
  useEffect(() => {
    const bump = () => setVersion(v => v + 1)
    const off = [subscribeMainnetTransferQueue(bump), subscribeMainnetSolanaActivity(bump), subscribeSuiRecovery(bump), subscribeSuiSessionChecks(bump)]
    return () => off.forEach(f => f())
  }, [])
  const items = useMemo(() => {
    if (!evm && !solana && !sui) return []
    return buildBridgeHistory({
      evm: evm ? listMainnetTransfers(evm) : [],
      solana: evm || solana ? listMainnetSolanaActivity(evm || undefined, solana || undefined) : [],
      sui: readSuiRecoveryQueue().filter(r => (evm && r.evmOwner.toLowerCase() === evm) || (sui && r.suiOwner.toLowerCase() === sui)),
      suiChecks: readSuiSessionChecks(),
    })
  }, [evm, solana, sui, version])
  const stats = useMemo(() => bridgeRouteStats(items), [items])
  return { items, stats }
}
