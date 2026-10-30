// Read-only proof of the Arc transaction that received (minted) a CCTP V2
// message from Sui. A hash is returned only when the chain itself shows it:
// a successful canonical receipt whose MessageTransmitterV2 MessageReceived
// event carries exactly this message (source domain 8, Circle-attested nonce,
// sender, finality, body) and whose TokenMessengerV2 MintAndWithdraw minted
// the attested amount to the attested recipient. Hints (write journal, saved
// record, Circle's destinationMintTxHash) are only candidates; each is
// verified the same way. Nothing here signs or sends.
import { decodeEventLog, encodeEventTopics, getAddress, parseAbi, type Hex } from 'viem'
import { getMainnetCctpChain } from '../config/mainnetCctp'
import { decodeCctpRecoveryMessage } from './mainnetCctpRecovery'

export const ARC_MINT_EVENTS_ABI = parseAbi([
  'event MessageReceived(address indexed caller,uint32 sourceDomain,bytes32 indexed nonce,bytes32 sender,uint32 indexed finalityThresholdExecuted,bytes messageBody)',
  'event MintAndWithdraw(address indexed mintRecipient,uint256 amount,address indexed mintToken,uint256 feeCollected)',
])
const RECEIVED_TOPIC = encodeEventTopics({ abi: ARC_MINT_EVENTS_ABI, eventName: 'MessageReceived' })[0]
const HASH = /^0x[0-9a-f]{64}$/i
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()
// Bounded fallback search: at most this many log windows of the RPC's maximum span.
export const ARC_MINT_SEARCH = Object.freeze({ windowBlocks: 10_000n, maxWindows: 6 })

export type ArcMintLookup = { txHash?: Hex; status: 'verified' | 'not_found' | 'unavailable'; checked: number }

// Verifies one candidate; returns false for anything that is not this exact mint.
export async function verifyArcMintTx(client: any, hash: string, message: Hex, evmOwner: string): Promise<boolean> {
  if (!HASH.test(hash)) return false
  const arc = getMainnetCctpChain(5042)!, m = decodeCctpRecoveryMessage(message)
  if (m.sourceDomain !== 8 || m.destinationDomain !== 26) return false
  const receipt = await client.getTransactionReceipt({ hash: hash as Hex }).catch((e: any) => { if (/not found|could not be found/i.test(String(e?.message ?? e))) return null; throw e })
  if (!receipt || receipt.status !== 'success' || !same(receipt.transactionHash, hash) || typeof receipt.blockNumber !== 'bigint' || !receipt.blockHash) return false
  const block = await client.getBlock({ blockNumber: receipt.blockNumber })
  if (!block?.hash || !same(block.hash, receipt.blockHash)) return false
  const body = ('0x' + message.slice(2 + 148 * 2)).toLowerCase()
  const received = receipt.logs.filter((l: any) => same(l.address, arc.messageTransmitterAddress) && same(l.topics?.[0] ?? '', RECEIVED_TOPIC))
  const matches = received.filter((l: any) => {
    try {
      const e = decodeEventLog({ abi: ARC_MINT_EVENTS_ABI, eventName: 'MessageReceived', data: l.data, topics: l.topics }).args as any
      return e.sourceDomain === 8 && same(e.nonce, m.nonce) && same(e.sender, m.sender) && e.finalityThresholdExecuted === m.executedFinality && same(e.messageBody, body)
    } catch { return false }
  })
  if (matches.length !== 1) return false
  const recipient = getAddress('0x' + m.mintRecipient.slice(-40))
  if (!same(recipient, evmOwner)) return false
  const mints = receipt.logs.filter((l: any) => same(l.address, arc.tokenMessengerAddress)).flatMap((l: any) => { try { const d = decodeEventLog({ abi: ARC_MINT_EVENTS_ABI, data: l.data, topics: l.topics }); return d.eventName === 'MintAndWithdraw' ? [d.args as any] : [] } catch { return [] } })
  return mints.length === 1 && same(mints[0].mintRecipient, recipient) && same(mints[0].mintToken, arc.usdcAddress) && mints[0].amount === m.amount - m.feeExecuted && mints[0].feeCollected === m.feeExecuted
}

// Finds the mint of a message whose Arc nonce is already used. Never guesses:
// two different verified transactions for one message block the result.
export async function findArcMintForMessage(client: any, input: { message: Hex; evmOwner: string; hints?: (string | undefined | null)[] }, search = ARC_MINT_SEARCH): Promise<ArcMintLookup> {
  const arc = getMainnetCctpChain(5042)!, m = decodeCctpRecoveryMessage(input.message)
  const verified = new Set<string>(); let checked = 0
  try {
    for (const hint of [...new Set((input.hints ?? []).filter((h): h is string => typeof h === 'string' && HASH.test(h)).map(h => h.toLowerCase()))]) {
      checked++
      if (await verifyArcMintTx(client, hint, input.message, input.evmOwner)) verified.add(hint)
    }
    if (!verified.size) {
      // MessageReceived indexes the nonce, so each window asks for this message only.
      let to = await client.getBlockNumber({ cacheTime: 0 }) as bigint
      for (let n = 0; n < search.maxWindows && to >= 0n && !verified.size; n++) {
        const from = to >= search.windowBlocks - 1n ? to - search.windowBlocks + 1n : 0n
        // Raw eth_getLogs: the topic filter (event + nonce) is applied by the node.
        const logs = await client.request({ method: 'eth_getLogs', params: [{ address: arc.messageTransmitterAddress, topics: [RECEIVED_TOPIC, null, m.nonce], fromBlock: `0x${from.toString(16)}`, toBlock: `0x${to.toString(16)}` }] })
        if (!Array.isArray(logs) || logs.length > 8) throw new Error('Unexpected Arc log response.')
        for (const hash of new Set<string>(logs.map((l: any) => String(l.transactionHash).toLowerCase()))) { checked++; if (await verifyArcMintTx(client, hash, input.message, input.evmOwner)) verified.add(hash) }
        to = from - 1n
      }
    }
  } catch { return { status: 'unavailable', checked } }
  if (verified.size > 1) return { status: 'unavailable', checked }
  const [txHash] = [...verified]
  return txHash ? { txHash: txHash as Hex, status: 'verified', checked } : { status: 'not_found', checked }
}
