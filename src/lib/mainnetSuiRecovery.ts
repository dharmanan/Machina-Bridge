import { formatUnits, isAddress, type Hex } from 'viem'
import { SUI_NETWORKS } from '../config/sui'
import { getMainnetCctpChain } from '../config/mainnetCctp'
import { readCctpBurnProof, readBoundCctpAttestation, decodeCctpRecoveryMessage, cctpRecoveryClient, CCTP_RECOVERY_ABI, cctpWord } from './mainnetCctpRecovery'
import { createSuiMainnetReadPort, readSuiMainnetIdentity, readSuiBurnProof, readSuiNonceStatus, type SuiMainnetReadPort } from './mainnetSuiRead'
import { validateSuiWalletAccount } from './suiBalances'
import { findArcMintForMessage } from './arcMintProof'

export type SuiRecoveryInput = { direction: 'sui-to-arc' | 'arc-to-sui'; sourceId: string; suiOwner: string; evmOwner: string
  // Sui -> Arc only: candidate Arc mint hashes (write journal, saved record). Each is verified on chain before use.
  destinationHints?: string[] }
export type SuiRecoveryResult = SuiRecoveryInput & { stage: 'waiting_attestation' | 'ready_to_mint' | 'complete'; amount: string; sourceEventIndex: number; destinationTx?: string; feeUsdc?: string; receivedUsdc?: string; checkedAt: number
  // Chain time of the source burn (ms): Sui checkpoint or Arc block timestamp. Display only.
  sourceTime?: number
  // Source burn maxFee in USDC base units; a destination-mint review must bind to it exactly.
  maxFeeUnits?: string }

// No signing or submission port exists here. A read-only recovery proof is not
// transaction authority. Keep the existing source write gate false.
export async function inspectSuiMainnetRecovery(input: SuiRecoveryInput, ports: { sui?: SuiMainnetReadPort; arc?: any; fetcher?: typeof fetch } = {}): Promise<SuiRecoveryResult> {
  // Arc hashes are case-insensitive on chain but not in Circle's API: read them in one canonical form.
  if (input.direction === 'arc-to-sui' && typeof input.sourceId === 'string') input = { ...input, sourceId: input.sourceId.trim().toLowerCase() }
  validateSuiWalletAccount({ address: input.suiOwner, chains: ['sui:mainnet'] }, 'mainnet')
  if (!isAddress(input.evmOwner) || /^0x0{40}$/i.test(input.evmOwner) || !['sui-to-arc', 'arc-to-sui'].includes(input.direction)) throw new Error('Connect the original Sui and Arc wallets and select a supported route.')
  const port = ports.sui ?? createSuiMainnetReadPort(), identity = await readSuiMainnetIdentity(port)
  const proof = input.direction === 'sui-to-arc'
    ? await readSuiBurnProof({ digest: input.sourceId, suiOwner: input.suiOwner, evmOwner: input.evmOwner }, identity, port)
    : await readCctpBurnProof({ sourceChainId: 5042, sourceTxHash: input.sourceId, owner: input.evmOwner, mintRecipients: [input.suiOwner], suiDestinationMessenger: identity.inboundAuthRecipient }, ports.arc)
  const sourceTime = 'sourceTime' in proof ? proof.sourceTime : await arcBlockTime(ports.arc ?? cctpRecoveryClient(getMainnetCctpChain(5042)!.rpcUrls), proof.sourceBlockNumber, proof.sourceBlockHash)
  const f = proof.fields, zero = `0x${'0'.repeat(64)}`
  if (f.minFinality !== 2000 || f.amount > (1n << 64n) - 1n || (input.direction === 'arc-to-sui' && (f.destinationDomain !== 8 || ![zero, input.suiOwner.toLowerCase()].includes(f.destinationCaller)))) throw new Error('This transfer is outside the supported standard Sui/Arc recovery policy.')
  const { destinationHints, ...plain } = input
  const base = { ...plain, ...(sourceTime ? { sourceTime } : {}), sourceId: input.direction === 'arc-to-sui' ? input.sourceId.toLowerCase() : input.sourceId, amount: formatUnits(f.amount, 6), maxFeeUnits: f.maxFee.toString(), sourceEventIndex: proof.sourceLogIndex }
  const signed = await readBoundCctpAttestation(proof, ports.fetcher)
  if (signed.status !== 'complete') return { ...base, stage: 'waiting_attestation', checkedAt: Date.now() }
  const message = signed.message!, m = decodeCctpRecoveryMessage(message)
  let used: boolean, destinationTx: string | undefined
  if (input.direction === 'arc-to-sui') {
    // The mint proof uses events/nonce, never a positive current address balance.
    // Minted Coin<USDC> need not have been converted into SIP-58 address funds.
    const status = await readSuiNonceStatus(message, identity, port)
    used = status.used; destinationTx = status.destinationTx
  } else {
    const arc = getMainnetCctpChain(5042)!, client = ports.arc ?? cctpRecoveryClient(arc.rpcUrls)
    if (await client.getChainId() !== 5042) throw new Error('Destination RPC is not Arc Mainnet.')
    const block = await client.getBlock()
    if (typeof block.number !== 'bigint' || !/^0x[0-9a-f]{64}$/i.test(block.hash ?? '')) throw new Error('No canonical Arc destination block.')
    const nonce = await client.readContract({ address: arc.messageTransmitterAddress, abi: CCTP_RECOVERY_ABI, functionName: 'usedNonces', args: [m.nonce], blockNumber: block.number })
    if (nonce !== 0n && nonce !== 1n) throw new Error('Unknown Arc nonce response; no unused nonce is proven.')
    if ((await client.getBlock({ blockNumber: block.number })).hash !== block.hash) throw new Error('Arc canonical block changed.')
    used = nonce === 1n
    if (!used && m.expirationBlock > 0n && block.number >= m.expirationBlock) throw new Error('Arc attestation expired; no mint may be requested.')
    // A used nonce stays complete even when the mint transaction cannot be found;
    // destinationTx is set only for an independently verified Arc transaction.
    if (used) destinationTx = (await findArcMintForMessage(client, { message, evmOwner: input.evmOwner, hints: [...(destinationHints ?? []), signed.destinationTxHint] })).txHash
  }
  return { ...base, stage: used ? 'complete' : 'ready_to_mint', destinationTx, feeUsdc: formatUnits(m.feeExecuted, 6), receivedUsdc: formatUnits(m.amount - m.feeExecuted, 6), checkedAt: Date.now() }
}

// Arc source block time, only when the block at that height still has the proven hash.
async function arcBlockTime(client: any, blockNumber: bigint, blockHash: string) {
  try { const b = await client.getBlock({ blockNumber }); return b?.hash && b.hash.toLowerCase() === blockHash.toLowerCase() && typeof b.timestamp === 'bigint' && b.timestamp > 0n ? Number(b.timestamp) * 1000 : undefined } catch { return undefined }
}

export function suiRecoveryContext(input: SuiRecoveryInput) {
  return [input.direction, input.direction === 'arc-to-sui' ? input.sourceId.toLowerCase() : input.sourceId, input.evmOwner.toLowerCase(), input.suiOwner.toLowerCase()].join(':')
}

// Bounded controller owns only read jobs. Superseded/late reads may finish in
// the transport, but cannot publish a result or import a stale wallet's record.
export function createSuiRecoveryController(inspect = inspectSuiMainnetRecovery) {
  let generation = 0, busy = false
  return {
    invalidate() { generation++; busy = false },
    async inspect(input: SuiRecoveryInput, isCurrent: () => boolean, save: (result: SuiRecoveryResult) => void) {
      if (busy) throw new Error('A Sui status check is already running.')
      busy = true; const id = ++generation; let timer: ReturnType<typeof setTimeout> | undefined
      try {
        const result = await Promise.race([inspect(input), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Sui status check timed out. No transaction was requested.')), 45_000) })])
        if (id !== generation || !isCurrent()) throw new Error('Wallet, route or source transaction changed. Discarded the previous check.')
        save(result); return result
      } finally { if (timer) clearTimeout(timer); if (id === generation) { generation++; busy = false } }
    },
  }
}

// Explicit route display only; no forwarding service or Fast source fallback.
export const SUI_RECOVERY_ROUTE_POLICY = Object.freeze({ sourceFinality: 2000, forwarding: false, coinType: SUI_NETWORKS.mainnet.usdcCoinType })
