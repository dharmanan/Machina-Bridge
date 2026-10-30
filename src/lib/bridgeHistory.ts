// Read-only view over the transfer records this browser keeps for each bridge
// (EVM CCTP queue, Solana activity, Sui recovery queue). Nothing here sends,
// mints or rewrites a record; it only merges them into one time-ordered list.
import { MAINNET_NETWORKS } from '../config/mainnetNetworks'
import { SOLANA_MAINNET_CCTP } from '../config/mainnetSolana'
import type { MainnetTransferRecord } from './mainnetTransferQueue'
import { mainnetSolanaTransferStatus, type MainnetSolanaActivityRecord } from './mainnetSolanaActivity'
import type { SuiRecoveryRecord } from './mainnetSuiQueue'
import type { SuiRecoveryResult } from './mainnetSuiRecovery'

export type BridgeHistoryStatus = 'complete' | 'in_progress' | 'action' | 'failed' | 'unknown'
export type BridgeHistoryItem = {
  key: string
  family: 'evm' | 'solana' | 'sui'
  from: string
  to: string
  amount: string
  // 'started': chain time of the source burn, or the time this browser started the transfer.
  // 'recorded': when this browser first saw it (e.g. recovered later). 'checked': only the last check is known.
  timestamp: number
  timestampKind: 'started' | 'recorded' | 'checked'
  status: BridgeHistoryStatus
  statusLabel: string
  // 'session': independently re-read from the chains on this page since it was opened.
  // 'saved': the status stored in this browser; not re-verified now.
  verification: 'session' | 'saved'
  verifiedAt?: number
  sourceId?: string
  sourceEventIndex?: number
  sourceUrl?: string
  destinationUrl?: string
  refund?: string | null
}

// ---- Sui checks made on this page (display only; never mint authority) ----
const SUI_CHECKED_EVENT = 'machina:sui-session-checks'
const suiChecks = new Map<string, { stage: SuiRecoveryResult['stage']; checkedAt: number }>()
export function noteSuiSessionCheck(id: string, result: Pick<SuiRecoveryResult, 'stage' | 'checkedAt'>) {
  suiChecks.set(id, { stage: result.stage, checkedAt: result.checkedAt })
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(SUI_CHECKED_EVENT))
}
export function readSuiSessionChecks() { return new Map(suiChecks) }
export function subscribeSuiSessionChecks(listener: () => void) {
  if (typeof window === 'undefined') return () => undefined
  window.addEventListener(SUI_CHECKED_EVENT, listener)
  return () => window.removeEventListener(SUI_CHECKED_EVENT, listener)
}

const networkName = (chainId: number) => Object.values(MAINNET_NETWORKS).find(n => n.chainId === chainId)?.name ?? `Chain ${chainId}`
function evmTx(chainId: number, hash?: string) {
  const url = Object.values(MAINNET_NETWORKS).find(n => n.chainId === chainId)?.explorerUrl
  return hash && url ? `${url.replace(/\/$/, '')}/tx/${hash}` : undefined
}
// One link format per chain, shared by the Sui Bridge, Dashboard and Activity.
export const arcTx = (hash?: string) => evmTx(MAINNET_NETWORKS.arc.chainId, hash)
const solanaTx = (sig?: string) => sig ? `${SOLANA_MAINNET_CCTP.explorerUrl}/tx/${sig}` : undefined
export const suiTx = (digest?: string) => digest ? `https://suiscan.xyz/mainnet/tx/${encodeURIComponent(digest)}` : undefined

const EVM_LABELS: Record<string, string> = {
  ready: 'Ready to send', approval_required: 'Approval required', approving: 'Approving', approved: 'Ready to send', burning: 'Sending',
  waiting_attestation: 'Waiting for Circle', ready_to_mint: 'Ready to receive', minting: 'Receiving', complete: 'Complete', failed: 'Needs attention',
}
export const SUI_STAGE_LABELS: Record<SuiRecoveryResult['stage'], string> = { waiting_attestation: 'Waiting for Circle', ready_to_mint: 'Ready to receive', complete: 'Complete' }

export function evmHistoryItem(r: MainnetTransferRecord): BridgeHistoryItem {
  return {
    key: `evm:${r.id}`, family: 'evm', from: networkName(r.sourceChainId), to: networkName(r.destinationChainId), amount: r.amount,
    timestamp: r.createdAt, timestampKind: r.recovered ? 'recorded' : 'started',
    status: r.stage === 'complete' ? 'complete' : r.stage === 'failed' ? 'failed' : r.stage === 'ready_to_mint' || r.stage === 'approval_required' ? 'action' : 'in_progress',
    statusLabel: EVM_LABELS[r.stage] ?? 'In progress', verification: 'saved',
    sourceId: r.sourceTxHash?.toLowerCase(), sourceEventIndex: r.sourceLogIndex,
    sourceUrl: evmTx(r.sourceChainId, r.sourceTxHash), destinationUrl: evmTx(r.destinationChainId, r.destinationTxHash), refund: null,
  }
}
export function solanaHistoryItem(r: MainnetSolanaActivityRecord, now = Date.now()): BridgeHistoryItem {
  const fromSolana = r.direction === 'solana-to-arc'
  const complete = r.status === 'complete' || (!r.status && Boolean(r.destinationTxHash))
  return {
    key: `solana:${r.id}`, family: 'solana', from: fromSolana ? 'Solana' : 'Arc', to: fromSolana ? 'Arc' : 'Solana', amount: r.amount,
    timestamp: r.createdAt, timestampKind: 'started',
    status: r.status === 'failed' ? 'failed' : complete ? 'complete' : r.status === 'pending' ? 'in_progress' : 'unknown',
    statusLabel: mainnetSolanaTransferStatus(r), verification: 'saved',
    sourceId: r.sourceTxHash ? (fromSolana ? r.sourceTxHash : r.sourceTxHash.toLowerCase()) : undefined,
    sourceUrl: fromSolana ? solanaTx(r.sourceTxHash) : arcTx(r.sourceTxHash), destinationUrl: fromSolana ? arcTx(r.destinationTxHash) : solanaTx(r.destinationTxHash),
    refund: r.refundableDepositSol && r.refundAvailableAt && r.refundStatus !== 'reclaimed' ? `${r.refundableDepositSol} SOL · ${r.refundAvailableAt <= now ? 'reclaimable now' : `reclaimable from ${new Date(r.refundAvailableAt).toLocaleDateString()}`}` : null,
  }
}
export function suiHistoryItem(r: SuiRecoveryRecord, checks: ReadonlyMap<string, { stage: SuiRecoveryResult['stage']; checkedAt: number }> = suiChecks): BridgeHistoryItem {
  const toSui = r.direction === 'arc-to-sui', check = checks.get(r.id)
  // The stored row already carries the latest saved stage; a check on this page only adds the "verified now" mark.
  const stage = check?.stage ?? r.stage
  return {
    key: `sui:${r.id}`, family: 'sui', from: toSui ? 'Arc' : 'Sui', to: toSui ? 'Sui' : 'Arc', amount: r.amount,
    timestamp: r.sourceTime ?? r.createdAt ?? r.checkedAt, timestampKind: r.sourceTime ? 'started' : r.createdAt ? 'recorded' : 'checked',
    status: stage === 'complete' ? 'complete' : stage === 'ready_to_mint' ? 'action' : 'in_progress', statusLabel: SUI_STAGE_LABELS[stage],
    verification: check ? 'session' : 'saved', verifiedAt: check?.checkedAt,
    sourceId: toSui ? r.sourceId.toLowerCase() : r.sourceId, sourceEventIndex: r.sourceEventIndex,
    sourceUrl: toSui ? arcTx(r.sourceId) : suiTx(r.sourceId), destinationUrl: toSui ? suiTx(r.destinationTx) : arcTx(r.destinationTx), refund: null,
  }
}

const RANK: Record<BridgeHistoryStatus, number> = { complete: 4, failed: 3, action: 2, in_progress: 1, unknown: 0 }
const better = (a: BridgeHistoryItem, b: BridgeHistoryItem) => RANK[b.status] > RANK[a.status] || (RANK[b.status] === RANK[a.status] && (b.verifiedAt ?? 0) > (a.verifiedAt ?? 0)) ? b : a
// One row per source burn event. Rows of the same source transaction merge only
// when they cannot be different CCTP events: same event index, or a row without
// an index next to exactly one indexed row. Different event indexes never merge.
export function dedupeBridgeHistory(items: BridgeHistoryItem[]) {
  const groups = new Map<string, BridgeHistoryItem[]>(), out: BridgeHistoryItem[] = []
  for (const item of items) {
    if (!item.sourceId) { out.push(item); continue }
    const g = `${item.from}>${item.to}:${item.sourceId}`
    groups.set(g, [...(groups.get(g) ?? []), item])
  }
  for (const group of groups.values()) {
    const byIndex = new Map<number, BridgeHistoryItem>(), loose: BridgeHistoryItem[] = []
    for (const item of group) {
      if (item.sourceEventIndex === undefined) loose.push(item)
      else byIndex.set(item.sourceEventIndex, byIndex.has(item.sourceEventIndex) ? better(byIndex.get(item.sourceEventIndex)!, item) : item)
    }
    if (loose.length) {
      const merged = loose.reduce(better)
      if (byIndex.size === 1) { const [i, row] = [...byIndex.entries()][0]; byIndex.set(i, { ...better(row, merged), sourceEventIndex: i }) }
      else out.push(merged)
    }
    out.push(...byIndex.values())
  }
  return out
}

export function buildBridgeHistory(input: { evm?: MainnetTransferRecord[]; solana?: MainnetSolanaActivityRecord[]; sui?: SuiRecoveryRecord[]; suiChecks?: ReadonlyMap<string, { stage: SuiRecoveryResult['stage']; checkedAt: number }>; now?: number }) {
  return dedupeBridgeHistory([
    ...(input.evm ?? []).map(evmHistoryItem),
    ...(input.solana ?? []).map(r => solanaHistoryItem(r, input.now)),
    ...(input.sui ?? []).map(r => suiHistoryItem(r, input.suiChecks ?? suiChecks)),
  ]).sort((a, b) => b.timestamp - a.timestamp || a.key.localeCompare(b.key))
}

export function bridgeRouteStats(items: BridgeHistoryItem[]) {
  const counts = new Map<string, number>()
  for (const item of items) if (item.status === 'complete') counts.set(`${item.from} → ${item.to}`, (counts.get(`${item.from} → ${item.to}`) ?? 0) + 1)
  return [...counts.entries()].map(([label, count]) => ({ label, count })).sort((a, b) => b.count - a.count || a.label.localeCompare(b.label))
}
