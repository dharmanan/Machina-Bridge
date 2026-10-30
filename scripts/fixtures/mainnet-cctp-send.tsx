// Controlled harness for the EVM CCTP approval/burn send path (useMainnetCctp).
// Real hook, real transfer queue and recovery loop; the wallet client and Arc RPC
// are controlled by the test. Never imported by the application entry.
import React, { useEffect } from 'react'
import { parseUnits } from 'viem'
import { createRoot } from 'react-dom/client'
import { useMainnetCctp } from '../../src/hooks/useMainnetCctp'
import { useMainnetTransferQueue } from '../../src/hooks/useMainnetTransferQueue'
import { getMainnetTransfer, readMainnetTransferQueue } from '../../src/lib/mainnetTransferQueue'
import { getDefaultMainnetCctpTransferMode } from '../../src/config/mainnetCctp'

const W = (window as any).cctpTest
function Harness() {
  const cctp = useMainnetCctp()
  useMainnetTransferQueue(W.state.address)
  useEffect(() => {
    W.api = {
      plan: (amount: string, approvalRequired = true) => cctp.createTransferPlan({ sourceChainId: 5042, destinationChainId: 8453, amount, approvalRequired }).id,
      approve: (id: string, amount: string) => cctp.approve({ sourceChainId: 5042, amountRaw: parseUnits(amount, 6), transferId: id }).then(h => ({ ok: h }), e => ({ error: String(e?.message ?? e) })),
      burn: (id: string, amount: string) => {
        const amountRaw = parseUnits(amount, 6)
        const quote = { mode: getDefaultMainnetCctpTransferMode(5042), amount, amountRaw, sourceChainId: 5042, destinationChainId: 8453, sourceDomain: 26, destinationDomain: 6, minimumFeeBps: 0, estimatedProtocolFeeRaw: 0n, maxFeeRaw: 0n, minFinalityThreshold: 2000 }
        return cctp.burn({ quote: quote as any, transferId: id }).then(h => ({ ok: h }), e => ({ error: String(e?.message ?? e) }))
      },
      record: (id: string) => { const r = getMainnetTransfer(id); return r ? JSON.parse(JSON.stringify(r)) : null },
      all: () => JSON.parse(JSON.stringify(readMainnetTransferQueue())),
    }
  }, [cctp])
  return <p>cctp harness</p>
}
createRoot(document.getElementById('root')!).render(<Harness />)
