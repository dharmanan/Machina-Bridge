import { useCallback, useEffect, useState } from 'react'
import {
  listMainnetSolanaActivity,
  subscribeMainnetSolanaActivity,
  type MainnetSolanaActivityRecord,
} from '../lib/mainnetSolanaActivity'

export function useMainnetSolanaActivity(
  evmWallet?: string,
  solanaWallet?: string | null,
) {
  const [records, setRecords] = useState<MainnetSolanaActivityRecord[]>(() =>
    listMainnetSolanaActivity(evmWallet, solanaWallet ?? undefined),
  )

  const refresh = useCallback(() => {
    setRecords(listMainnetSolanaActivity(evmWallet, solanaWallet ?? undefined))
  }, [evmWallet, solanaWallet])

  useEffect(() => {
    refresh()
    return subscribeMainnetSolanaActivity(refresh)
  }, [refresh])

  return { records, refresh }
}
