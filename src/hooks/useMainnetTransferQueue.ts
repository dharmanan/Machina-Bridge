import { useCallback, useEffect, useMemo, useState } from 'react'
import { createPublicClient, fallback, http, type Hex } from 'viem'
import { getMainnetCctpRoute } from '../config/mainnetCctp'
import { fetchMainnetCctpAttestation } from '../lib/mainnetCctpTransfer'
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

  if (record.stage === 'waiting_attestation' && record.sourceTxHash) {
    try {
      const result = await fetchMainnetCctpAttestation({
        sourceChainId: record.sourceChainId,
        transactionHash: record.sourceTxHash as Hex,
      })

      if (result.status === 'complete') {
        transitionMainnetTransfer(record.id, 'ready_to_mint', {
          attestationReadyAt: Date.now(),
          lastError: undefined,
        })
      }
    } catch (error) {
      updateMainnetTransferRecord(record.id, {
        lastError: error instanceof Error ? error.message : 'Attestation check failed.',
      })
    }
    return
  }

  if (record.stage === 'minting' && record.destinationTxHash) {
    const client = makePublicClient(route.destination.rpcUrls)
    try {
      const receipt = await client.getTransactionReceipt({ hash: record.destinationTxHash as Hex })
      if (receipt.status === 'success') {
        transitionMainnetTransfer(record.id, 'complete', { lastError: undefined })
      } else {
        transitionMainnetTransfer(record.id, 'ready_to_mint', {
          lastError: 'Mint transaction reverted.',
        })
      }
    } catch {
      // Receipt not available yet.
    }
  }
}

export function useMainnetTransferQueue(walletAddress?: string) {
  const [transfers, setTransfers] = useState<MainnetTransferRecord[]>(() =>
    listMainnetTransfers(walletAddress),
  )

  const refresh = useCallback(() => {
    setTransfers(listMainnetTransfers(walletAddress))
  }, [walletAddress])

  useEffect(() => {
    refresh()
    return subscribeMainnetTransferQueue(refresh)
  }, [refresh])

  const recover = useCallback(async () => {
    const current = listMainnetTransfers(walletAddress)
    const recoverable = current.filter((record) =>
      ['approving', 'burning', 'waiting_attestation', 'minting'].includes(record.stage),
    )

    if (recoverable.length === 0) return

    await Promise.allSettled(recoverable.map((record) => recoverTransactionStage(record)))
    refresh()
  }, [refresh, walletAddress])

  const hasRecoverable = transfers.some((record) =>
    ['approving', 'burning', 'waiting_attestation', 'minting'].includes(record.stage),
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
