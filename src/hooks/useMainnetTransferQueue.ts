import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPublicClient, fallback, http, parseUnits, type Hex } from 'viem'
import { getMainnetCctpRoute } from '../config/mainnetCctp'
import { inspectMainnetTransferRecovery } from '../lib/mainnetCctpRecovery'
import {
  listMainnetTransfers,
  subscribeMainnetTransferQueue,
  transitionMainnetTransfer,
  updateMainnetTransferRecord,
  type MainnetTransferRecord,
} from '../lib/mainnetTransferQueue'

const RECOVERY_POLL_MS = 4_000

function makePublicClient(rpcUrls: readonly string[]) {
  const transports = rpcUrls.map((url) => http(url, { timeout: 10_000, retryCount: 0 }))
  return createPublicClient({
    transport: transports.length === 1 ? transports[0] : fallback(transports),
  })
}

async function recoverTransactionStage(record: MainnetTransferRecord) {
  const route = getMainnetCctpRoute(record.sourceChainId, record.destinationChainId)
  if (!route) return

  if (record.stage === 'approving' && record.approvalTxHash) {
    const client = makePublicClient(route.source.rpcUrls)
    try {
      const receipt = await client.getTransactionReceipt({ hash: record.approvalTxHash as Hex })
      if (receipt.status === 'success') {
        transitionMainnetTransfer(record.id, 'approved', { lastError: undefined })
      } else {
        transitionMainnetTransfer(record.id, 'approval_required', {
          lastError: 'Approval transaction reverted.',
        })
      }
    } catch {
      // Receipt not available yet; keep the transfer recoverable in-place.
    }
    return
  }

  if (record.stage === 'burning' && record.sourceTxHash) {
    const client = makePublicClient(route.source.rpcUrls)
    try {
      const receipt = await client.getTransactionReceipt({ hash: record.sourceTxHash as Hex })
      if (receipt.status === 'success') {
        transitionMainnetTransfer(record.id, 'waiting_attestation', { lastError: undefined })
      } else {
        transitionMainnetTransfer(
          record.id,
          record.approvalTxHash ? 'approved' : 'ready',
          { lastError: 'Burn transaction reverted.' },
        )
      }
    } catch {
      // Receipt not available yet.
    }
    return
  }

  if (['waiting_attestation','ready_to_mint','minting'].includes(record.stage) && record.sourceTxHash) {
    try {
      const result = await inspectMainnetTransferRecovery({ sourceChainId: record.sourceChainId, sourceTxHash: record.sourceTxHash, owner:record.walletAddress, sourceLogIndex:record.sourceLogIndex })
      if (result.proof.destinationChainId !== record.destinationChainId || parseUnits(result.proof.amount,6) !== parseUnits(record.amount,6)) throw new Error('Source proof does not match the stored transfer.')
      const stage = result.stage === 'complete' ? 'complete' : record.stage === 'minting' || record.mintRequestedAt || record.destinationTxHash ? 'minting' : result.stage
      updateMainnetTransferRecord(record.id, { stage, sourceLogIndex:result.proof.sourceLogIndex, lastError:undefined, ...(stage === 'ready_to_mint' ? {attestationReadyAt:Date.now()} : {}) })
    } catch {
      updateMainnetTransferRecord(record.id, { lastError:'Transfer status could not be verified. No mint is allowed until a fresh check succeeds.' })
    }
  }
}

export function useMainnetTransferQueue(walletAddress?: string) {
  const [transfers, setTransfers] = useState<MainnetTransferRecord[]>(() =>
    walletAddress ? listMainnetTransfers(walletAddress) : [],
  )

  const refresh = useCallback(() => {
    setTransfers(walletAddress ? listMainnetTransfers(walletAddress) : [])
  }, [walletAddress])

  useEffect(() => {
    refresh()
    return subscribeMainnetTransferQueue(refresh)
  }, [refresh])

  const recovering = useRef(false), cursor = useRef(0), currentWallet = useRef(walletAddress)
  currentWallet.current = walletAddress
  const recover = useCallback(async () => {
    if (!walletAddress || recovering.current) return
    const current = listMainnetTransfers(walletAddress)
    const recoverable = current.filter((record) =>
      ['approving', 'burning', 'waiting_attestation', 'ready_to_mint', 'minting'].includes(record.stage),
    )

    if (recoverable.length === 0) return

    // Full source/nonce proofs cost more than a receipt lookup. Bound fanout and never overlap poll cycles.
    const start = cursor.current % recoverable.length
    const batch = Array.from({length:Math.min(2,recoverable.length)},(_,i)=>recoverable[(start+i)%recoverable.length])
    cursor.current = start + batch.length; recovering.current = true
    try { await Promise.allSettled(batch.map(record=>recoverTransactionStage(record))) }
    finally { recovering.current = false; if (currentWallet.current === walletAddress) refresh() }
  }, [refresh, walletAddress])

  const hasRecoverable = transfers.some((record) =>
    ['approving', 'burning', 'waiting_attestation', 'ready_to_mint', 'minting'].includes(record.stage),
  )

  useEffect(() => {
    if (!hasRecoverable) return

    void recover()
    const interval = window.setInterval(() => {
      void recover()
    }, RECOVERY_POLL_MS)

    return () => window.clearInterval(interval)
  }, [hasRecoverable, recover])

  const activeTransfers = useMemo(
    () => transfers.filter((record) => record.stage !== 'complete'),
    [transfers],
  )

  const readyToMintCount = useMemo(
    () => activeTransfers.filter((record) => record.stage === 'ready_to_mint').length,
    [activeTransfers],
  )

  return {
    transfers,
    activeTransfers,
    readyToMintCount,
    refresh,
    recover,
  }
}
