import { useRef, useState } from 'react'
import { useAccount } from 'wagmi'
import { getMainnetCctpChain } from '../config/mainnetCctp'
import { MAINNET_NETWORKS } from '../config/mainnetNetworks'
import { inspectMainnetTransferRecovery } from '../lib/mainnetCctpRecovery'
import { importRecoveredMainnetTransfer, type MainnetTransferRecord } from '../lib/mainnetTransferQueue'
import { useMainnetCctp } from '../hooks/useMainnetCctp'

export function MainnetTransferRecovery() {
  const { address } = useAccount(), { mint, canaryWritesUnlocked, writesUnlocked } = useMainnetCctp()
  const current = useRef(address); current.current = address
  const [source, setSource] = useState(5042), [hash,setHash] = useState(''), [busy,setBusy] = useState(false), [message,setMessage] = useState('')
  const [record,setRecord] = useState<MainnetTransferRecord | null>(null)
  const owner = useRef<string>()
  const inspect = async () => {
    if (!address || busy) return
    owner.current = address; setBusy(true); setMessage('Checking the source burn and destination nonce…'); setRecord(null)
    try {
      const result = await inspectMainnetTransferRecovery({ sourceChainId:source,sourceTxHash:hash.trim(),owner:address })
      if (current.current !== address) throw new Error('Wallet changed. Run recovery for the connected wallet again.')
      const p = result.proof
      const imported = importRecoveredMainnetTransfer({walletAddress:address,sourceChainId:source,destinationChainId:p.destinationChainId!,sourceTxHash:p.sourceTxHash,sourceLogIndex:p.sourceLogIndex,amount:p.amount,mode:p.mode,recipient:address,destinationCaller:('0x'+p.fields.destinationCaller.slice(-40)),approvalRequired:false,stage:result.stage})
      setRecord(imported)
      setMessage(imported.stage === 'complete' ? 'Already received: the destination contract confirms this message was consumed. No second mint will be requested.' : imported.stage === 'minting' ? 'An earlier mint may be pending. Keep this record and recheck; do not submit again.' : imported.stage === 'waiting_attestation' ? 'Burn verified. Waiting for Circle attestation. Recheck later; no transaction was requested.' : 'Burn and unused destination nonce verified. Confirm below to request only the destination mint in your wallet.')
    } catch(e) { setMessage(e instanceof Error ? e.message : 'Recovery is unavailable. No mint was requested.') } finally { setBusy(false) }
  }
  const receive = async () => {
    if (!record || !address || owner.current !== address || busy) return
    setBusy(true)
    try {
      const fresh = await inspectMainnetTransferRecovery({sourceChainId:record.sourceChainId,sourceTxHash:record.sourceTxHash!,owner:address,sourceLogIndex:record.sourceLogIndex})
      if (fresh.stage !== 'ready_to_mint' || !fresh.message || !fresh.attestation || current.current !== address) throw new Error('State changed. Recheck recovery; no mint was requested.')
      await mint({destinationChainId:record.destinationChainId,message:fresh.message,attestation:fresh.attestation,transferId:record.id})
      setRecord(null); setMessage('Destination mint independently verified. The transfer is in Bridge Tracker.')
    } catch(e) { setRecord(null); setMessage(e instanceof Error ? e.message : 'Mint outcome needs a fresh status check. Do not send again.') } finally {setBusy(false)}
  }
  return <details className="mt-4 rounded-2xl border border-slate-200 bg-white p-4">
    <summary className="cursor-pointer text-sm font-semibold">Recover Transfer</summary>
    <p className="mt-2 text-xs leading-5 text-slate-500">Use the original source transaction hash on any device. This checks an existing USDC burn; it never starts a new burn. Only existing supported same-wallet routes can be received.</p>
    <div className="mt-3 grid gap-3 sm:grid-cols-2">
      <label className="text-xs">Source chain<select aria-label="Recovery source chain" className="mt-1 w-full rounded-lg border p-2" disabled={busy} value={source} onChange={e=>{setSource(Number(e.target.value));setRecord(null)}}>{Object.values(MAINNET_NETWORKS).map(n=><option key={n.chainId} value={n.chainId}>{n.name}</option>)}</select></label>
      <label className="min-w-0 text-xs">Source transaction hash<input aria-label="Recovery source transaction hash" className="mt-1 w-full rounded-lg border p-2" value={hash} disabled={busy} onChange={e=>{setHash(e.target.value);setRecord(null)}} placeholder="0x…" /></label>
    </div>
    <button type="button" className="mt-3 rounded-xl border px-4 py-2 text-sm disabled:opacity-50" disabled={!address || busy || !hash.trim()} onClick={()=>void inspect()}>{busy?'Checking…':'Check existing transfer'}</button>
    {!address && <p className="mt-2 text-xs">Connect the original EVM wallet to recover a transfer.</p>}
    {message && <p role="status" className="mt-3 break-words text-xs leading-5">{message}</p>}
    {record && <p className="mt-2 text-xs">{record.amount} USDC · {getMainnetCctpChain(record.sourceChainId)?.name} → {getMainnetCctpChain(record.destinationChainId)?.name}</p>}
    {record?.stage === 'ready_to_mint' && owner.current === address && <button type="button" disabled={busy || !(canaryWritesUnlocked || writesUnlocked)} className="mt-3 rounded-xl bg-[#2F6E0C] px-4 py-2 text-sm text-white disabled:opacity-50" onClick={()=>void receive()}>Confirm destination mint</button>}
  </details>
}
