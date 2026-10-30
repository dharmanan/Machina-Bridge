// EVM CCTP approval/burn outcomes that are not known yet. Read-only: nothing here
// sends. A step leaves its locked state only on chain evidence:
//   * approval: the allowance covers the transfer (approved), or the account's
//     nonce moved past the attempt while no allowance appeared (not executed);
//   * burn: exactly one matching DepositForBurn from this wallet after the
//     attempt (adopted). Nothing else releases a burn: a moved nonce does not prove
//     that the wallet will not still broadcast it, so a second burn stays blocked.
import { decodeEventLog, encodeEventTopics, padHex, parseAbi, parseUnits, type Hex } from 'viem'
import { getMainnetCctpRoute, CCTP_V2_ERC20_ABI } from '../config/mainnetCctp'
import { readMainnetTransferQueue, type MainnetTransferRecord } from './mainnetTransferQueue'

const DEPOSIT_ABI = parseAbi(['event DepositForBurn(address indexed burnToken,uint256 amount,address indexed depositor,bytes32 mintRecipient,uint32 destinationDomain,bytes32 destinationTokenMessenger,bytes32 destinationCaller,uint256 maxFee,uint32 indexed minFinalityThreshold,bytes hookData)'])
const DEPOSIT_TOPIC = encodeEventTopics({ abi: DEPOSIT_ABI, eventName: 'DepositForBurn' })[0]
// Bounded log search after the attempt: at most this many windows of the usual RPC span.
export const LOST_BURN_SEARCH = Object.freeze({ windowBlocks: 10_000n, maxWindows: 6 })

// Only an explicit refusal in the wallet proves that nothing was sent.
export function isWalletRejection(error: unknown): boolean {
  for (let e: any = error, n = 0; e && n < 8; e = e.cause, n++) {
    if (e?.code === 4001 || e?.name === 'UserRejectedRequestError') return true
  }
  return false
}

// A wallet with an approval or burn whose outcome is not proven yet may not start another on that chain.
export function unresolvedSendFor(wallet: string, sourceChainId: number, exceptId?: string) {
  const w = wallet.toLowerCase()
  return readMainnetTransferQueue().find(r => r.id !== exceptId && r.walletAddress.toLowerCase() === w && r.sourceChainId === sourceChainId && (r.stage === 'approving' || r.stage === 'burning'))
}
export function assertNoUnresolvedSend(wallet: string, sourceChainId: number, exceptId?: string) {
  if (unresolvedSendFor(wallet, sourceChainId, exceptId)) throw new Error('An earlier approval or transfer from this wallet is not confirmed yet. Machina is checking the chain; nothing new is sent until it is resolved.')
}

// Attempt evidence taken right before the wallet request: the account must have no
// pending transaction, so the next mined nonce is the one this request would use.
export async function readSendAttempt(client: any, wallet: string) {
  const [latest, pending, block] = await Promise.all([
    client.getTransactionCount({ address: wallet, blockTag: 'latest' }),
    client.getTransactionCount({ address: wallet, blockTag: 'pending' }),
    client.getBlockNumber({ cacheTime: 0 }),
  ])
  if (!Number.isSafeInteger(latest) || latest !== pending || typeof block !== 'bigint') throw new Error('Your wallet has a pending transaction on this chain. Let it finish (or cancel it in the wallet) before sending another.')
  return { attemptNonce: latest as number, attemptBlock: Number(block) }
}

export type LostSendDecision =
  | { kind: 'approved' }
  | { kind: 'approval_not_executed' }
  | { kind: 'burn_found'; hash: Hex }
  | { kind: 'unknown' }

export async function reconcileLostSend(record: MainnetTransferRecord, client: any): Promise<LostSendDecision> {
  const route = getMainnetCctpRoute(record.sourceChainId, record.destinationChainId)
  if (!route || record.attemptNonce === undefined || record.attemptBlock === undefined) return { kind: 'unknown' }
  const owner = record.walletAddress as Hex, amountRaw = parseUnits(record.amount, 6)
  if (record.stage === 'approving' && !record.approvalTxHash) {
    const allowance = await client.readContract({ address: route.source.usdcAddress, abi: CCTP_V2_ERC20_ABI, functionName: 'allowance', args: [owner, route.source.tokenMessengerAddress] })
    if (typeof allowance === 'bigint' && allowance >= amountRaw) return { kind: 'approved' }
    const latest = await client.getTransactionCount({ address: owner, blockTag: 'latest' })
    return Number.isSafeInteger(latest) && latest > record.attemptNonce ? { kind: 'approval_not_executed' } : { kind: 'unknown' }
  }
  if (record.stage === 'burning' && !record.sourceTxHash) {
    const head = await client.getBlockNumber({ cacheTime: 0 }) as bigint
    const found = new Set<string>()
    // Burns already recorded for other transfers are never adopted for this one.
    const known = new Set(readMainnetTransferQueue().filter(r => r.id !== record.id && r.sourceTxHash).map(r => r.sourceTxHash!.toLowerCase()))
    let from = BigInt(record.attemptBlock)
    for (let n = 0; n < LOST_BURN_SEARCH.maxWindows && from <= head; n++) {
      const to = from + LOST_BURN_SEARCH.windowBlocks - 1n < head ? from + LOST_BURN_SEARCH.windowBlocks - 1n : head
      const logs = await client.request({ method: 'eth_getLogs', params: [{ address: route.source.tokenMessengerAddress, topics: [DEPOSIT_TOPIC, padHex(route.source.usdcAddress, { size: 32 }), padHex(owner, { size: 32 })], fromBlock: `0x${from.toString(16)}`, toBlock: `0x${to.toString(16)}` }] })
      if (!Array.isArray(logs) || logs.length > 64) return { kind: 'unknown' }
      for (const l of logs) {
        try {
          const e = decodeEventLog({ abi: DEPOSIT_ABI, data: l.data, topics: l.topics }).args as any
          if (e.amount === amountRaw && e.destinationDomain === route.destination.cctpDomain && e.mintRecipient.toLowerCase() === padHex(record.recipient as Hex, { size: 32 }).toLowerCase()) { const h = String(l.transactionHash).toLowerCase(); if (!known.has(h)) found.add(h) }
        } catch { /* not a CCTP V2 deposit */ }
      }
      from = to + 1n
    }
    if (from <= head) return { kind: 'unknown' } // search window exhausted before the chain head
    if (found.size === 1) return { kind: 'burn_found', hash: [...found][0] as Hex }
    if (found.size > 1) return { kind: 'unknown' } // several candidates: never guess
    return { kind: 'unknown' }
  }
  return { kind: 'unknown' }
}
