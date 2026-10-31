import { useCallback, useEffect, useMemo, useState } from 'react'
import { useWalletClient } from 'wagmi'
import { createPublicClient, http, type Hex } from 'viem'
import { CIRCLE_MAINNET } from '../config/circle'
import { MAINNET_NETWORKS } from '../config/mainnetNetworks'
import { ARC_MAINNET_EVM_CHAIN, addChainToWallet } from '../lib/chains'
import { verifyArcMintTx } from '../lib/arcMintProof'
import { readMainnetSolanaActivity, recordMainnetSolanaActivity, updateMainnetSolanaActivity } from '../lib/mainnetSolanaActivity'
import { readSolanaSendAttempts } from '../lib/solanaSendGuard'
import { solanaRpc, solanaSendEvidence } from '../lib/solanaSendRuntime'
import {
  completeSolanaArcReceive, inspectSolanaToArcRecovery, readReceiveRecords, receiveRecordFor, releaseReceiveAfterReview, solanaArcCandidates,
  isOpenReceive, type ArcReceiveDeps, type SolanaArcRecoveryPorts, type SolanaArcRecoveryResult,
} from '../lib/solanaArcRecovery'

const arcClient = () => createPublicClient({ chain: ARC_MAINNET_EVM_CHAIN, transport: http(MAINNET_NETWORKS.arc.rpcUrls[0], { timeout: 15_000, retryCount: 1 }) })

// Production read ports: Solana through the site's RPC proxy, Circle Iris, Arc RPC. Read-only.
export const solanaArcRecoveryPorts = (): SolanaArcRecoveryPorts => ({
  async solanaSource(signature) {
    const [statuses, transaction] = await Promise.all([
      solanaRpc<{ value?: unknown[] }>('getSignatureStatuses', [[signature], { searchTransactionHistory: true }]),
      solanaRpc<any>('getTransaction', [signature, { maxSupportedTransactionVersion: 0, commitment: 'confirmed', encoding: 'json' }]),
    ])
    if (!statuses || !Array.isArray(statuses.value)) throw new Error('Solana signature status is unavailable.')
    return { status: (statuses.value[0] as any) ?? null, transaction: transaction ?? null }
  },
  async circleMessages(signature) {
    const response = await fetch(`${CIRCLE_MAINNET.irisApiBase}/v2/messages/5?transactionHash=${encodeURIComponent(signature)}`, { headers: { Accept: 'application/json' } })
    if (response.status === 404) return []
    if (!response.ok) throw new Error(`Circle API HTTP ${response.status}. Nothing was requested.`)
    const payload = await response.json()
    return Array.isArray(payload?.messages) ? payload.messages : []
  },
  arc: arcClient(),
})

type CheckState = { busy?: boolean; result?: SolanaArcRecoveryResult; error?: string; done?: string }

function markActivityComplete(result: SolanaArcRecoveryResult, txHash?: string) {
  const record = readMainnetSolanaActivity().find(x => x.direction === 'solana-to-arc' && x.sourceTxHash === result.signature)
  const patch = { status: 'complete' as const, ...(txHash ? { destinationTxHash: txHash } : {}) }
  if (record) updateMainnetSolanaActivity(record.id, patch)
  else recordMainnetSolanaActivity({ evmWallet: result.evmOwner, solanaWallet: result.solanaOwner, direction: 'solana-to-arc', amount: result.amount, sourceTxHash: result.signature, ...patch })
}

export function useSolanaArcRecovery(evmOwner: string | null | undefined, solanaOwner: string | null | undefined) {
  const { data: walletClient } = useWalletClient()
  const [found, setFound] = useState<string[]>([])
  const [known, setKnown] = useState<string[]>([])
  const [checks, setChecks] = useState<Record<string, CheckState>>({})
  const [scan, setScan] = useState<{ busy: boolean; message?: string }>({ busy: false })

  const refresh = useCallback(() => {
    if (!solanaOwner) { setKnown([]); return }
    let sendAttempts: ReturnType<typeof readSolanaSendAttempts> = [], receives: ReturnType<typeof readReceiveRecords> = []
    try { sendAttempts = readSolanaSendAttempts() } catch { /* the send guard shows its own error */ }
    try { receives = readReceiveRecords() } catch { /* shown when a receive is attempted */ }
    setKnown(solanaArcCandidates({ sendAttempts, activity: readMainnetSolanaActivity(), receives }, solanaOwner))
  }, [solanaOwner])
  useEffect(() => { refresh(); setFound([]); setChecks({}) }, [refresh, evmOwner])

  const set = (signature: string, patch: CheckState) => setChecks(c => ({ ...c, [signature]: { ...c[signature], ...patch } }))
  const input = useCallback((signature: string) => {
    if (!evmOwner || !solanaOwner) throw new Error('Connect the Phantom wallet that sent the burn and the Arc wallet that should receive it.')
    const saved = readMainnetSolanaActivity().find(x => x.direction === 'solana-to-arc' && x.sourceTxHash === signature)?.destinationTxHash
    let journal: string | undefined
    try { journal = receiveRecordFor(signature)?.txHash } catch { /* hint only */ }
    return { signature, solanaOwner, evmOwner, destinationHints: [saved, journal] }
  }, [evmOwner, solanaOwner])

  const check = useCallback(async (signature: string) => {
    set(signature, { busy: true, error: undefined, done: undefined })
    try {
      const result = await inspectSolanaToArcRecovery(input(signature), solanaArcRecoveryPorts())
      if (result.stage === 'complete') markActivityComplete(result, result.destinationTx)
      set(signature, { busy: false, result })
    } catch (e) { set(signature, { busy: false, result: undefined, error: e instanceof Error ? e.message : 'The check failed. Nothing was requested.' }) }
  }, [input])

  const findOnChain = useCallback(async () => {
    if (!solanaOwner) return
    setScan({ busy: true })
    try {
      const burns = await solanaSendEvidence.solanaBurnsSince(solanaOwner, 0)
      setFound(burns)
      setScan({ busy: false, message: burns.length ? undefined : 'No CCTP burn among the latest 25 transactions of this Phantom wallet. Paste the signature of an older one.' })
    } catch { setScan({ busy: false, message: 'Solana could not be read. Try again in a moment.' }) }
  }, [solanaOwner])

  const deps = useMemo((): ArcReceiveDeps | null => {
    if (!walletClient) return null
    const client = arcClient()
    return {
      inspect: i => inspectSolanaToArcRecovery(i, solanaArcRecoveryPorts()),
      wallet: {
        async ready(owner) {
          const request = (args: { method: string; params?: unknown[] }) => walletClient.transport.request(args as never) as Promise<unknown>
          await addChainToWallet(ARC_MAINNET_EVM_CHAIN, request)
          const [accounts, chain] = await Promise.all([request({ method: 'eth_accounts' }), request({ method: 'eth_chainId' })])
          if (!Array.isArray(accounts) || String(accounts[0] ?? '').toLowerCase() !== owner.toLowerCase() || Number(chain) !== ARC_MAINNET_EVM_CHAIN.id) throw new Error('Switch the EVM wallet to Arc Mainnet with the receiving account. Nothing was requested.')
        },
        async simulate(call, owner) {
          const [balance, gas] = await Promise.all([client.getBalance({ address: owner as Hex }), client.estimateGas({ account: owner as Hex, ...call })])
          const price = await client.getGasPrice()
          if (balance < gas * price) throw new Error('Not enough Arc gas (USDC) in the receiving wallet for the receive. Nothing was requested.')
        },
        send: call => walletClient.sendTransaction({ account: walletClient.account!, chain: ARC_MAINNET_EVM_CHAIN, ...call }),
      },
      async receipt(hash) {
        try { return (await client.getTransactionReceipt({ hash: hash as Hex })).status === 'success' ? 'success' : 'reverted' }
        catch (e) { if ((e as { name?: string })?.name === 'TransactionReceiptNotFoundError') return null; throw e }
      },
      waitReceipt: async hash => (await client.waitForTransactionReceipt({ hash: hash as Hex, timeout: 120_000 })).status === 'success' ? 'success' : 'reverted',
      mintProven: (hash, message, owner) => verifyArcMintTx(client, hash, message, owner, 5),
      onComplete: markActivityComplete,
    }
  }, [walletClient])

  const complete = useCallback(async (signature: string) => {
    const approved = checks[signature]?.result
    if (!approved || !deps) return
    set(signature, { busy: true, error: undefined })
    try {
      const out = await completeSolanaArcReceive(input(signature), approved, deps)
      set(signature, { busy: false, result: out.result, done: out.kind === 'already-received' ? 'This burn was already received on Arc. No second receive was requested.' : 'Received on Arc and verified on chain.' })
    } catch (e) { set(signature, { busy: false, error: e instanceof Error ? e.message : 'The receive failed. Check it again before retrying.' }) }
    refresh()
  }, [checks, deps, input, refresh])

  const unlock = useCallback((signature: string) => {
    const result = checks[signature]?.result
    try { if (result) { releaseReceiveAfterReview(signature, result); set(signature, { error: undefined }) } }
    catch (e) { set(signature, { error: e instanceof Error ? e.message : 'Could not unlock.' }) }
    refresh()
  }, [checks, refresh])

  // An unclear request (no hash) needs the manual wallet check; a sent one is settled by its Arc receipt.
  const openReceive = useCallback((signature: string) => { try { const rec = receiveRecordFor(signature); return isOpenReceive(rec) && !rec?.txHash } catch { return true } }, [checks])
  const candidates = useMemo(() => [...new Set([...known, ...found])], [known, found])
  return { candidates, checks, scan, check, complete, unlock, findOnChain, openReceive, walletReady: Boolean(deps) }
}
