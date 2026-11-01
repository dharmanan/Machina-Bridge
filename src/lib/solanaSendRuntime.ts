import { useCallback, useEffect, useState } from 'react'
import { createPublicClient, http, parseAbiItem, type Hex } from 'viem'
import { MAINNET_CONFIG } from '../config/mainnet'
import { MAINNET_NETWORKS } from '../config/mainnetNetworks'
import { SOLANA_MAINNET_CCTP } from '../config/mainnetSolana'
import { CIRCLE_MAINNET } from '../config/circle'
import { CIRCLE_KIT_BRIDGE_CONTRACT, decodeCctpRecoveryMessage, readBoundCctpAttestation, readCctpBurnProof } from './mainnetCctpRecovery'
import { verifyArcMintTx } from './arcMintProof'
import { readSolanaCctpMessageUsed } from './mainnetSolanaRecovery'
import { recordMainnetSolanaActivity, readMainnetSolanaActivity } from './mainnetSolanaActivity'
import {
  SOLANA_SEND_JOURNAL_EVENT, SOLANA_SEND_JOURNAL_KEY, applySolanaSendVerdict, createSolanaSendAttempt, isUserRejection,
  openSolanaSendAttempt, readSolanaSendAttempts, releaseSolanaSendAttemptManually, releaseStalePrepared, solanaSignatureOf, updateSolanaSendAttempt,
  verifySolanaSendAttempt, type DestinationEvidence, type SolanaSendAttempt, type SolanaSendDirection, type SolanaSendEvidence, type SolanaSendVerdict,
} from './solanaSendGuard'

const DEPOSIT_FOR_BURN = parseAbiItem('event DepositForBurn(address indexed burnToken,uint256 amount,address indexed depositor,bytes32 mintRecipient,uint32 destinationDomain,bytes32 destinationTokenMessenger,bytes32 destinationCaller,uint256 maxFee,uint32 indexed minFinalityThreshold,bytes hookData)')
const ARC_LOG_SPAN = 5_000n
const ARC_MAX_SPANS = 60 // ~42 h of Arc blocks; an older attempt cannot be proven by this scan and stays locked

const arcClient = () => createPublicClient({ transport: http(MAINNET_NETWORKS.arc.rpcUrls[0], { timeout: 15_000, retryCount: 1 }) })

export async function solanaRpc<T>(method: string, params: unknown[]): Promise<T> {
  const response = await fetch('/api/solana-rpc', { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })
  const payload = await response.json().catch(() => null)
  if (!response.ok || payload?.error) throw new Error(`Solana ${method} could not be read.`)
  return payload.result as T
}

// Read-only destination evidence for the "completed" status. Every read failure throws, which
// verifyTransferDestination turns into "Receive verification pending" (never a failure).
export function destinationEvidence(opts: { evmWallet: string; solanaRecipients: string[]; solanaRead: (method: 'getAccountInfo' | 'getSignatureStatuses', params: unknown[]) => Promise<any> }): DestinationEvidence {
  return {
    async attestedMessage(direction, sourceTxHash) {
      if (direction === 'arc-to-solana') {
        const proof = await readCctpBurnProof({ sourceChainId: 5042, sourceTxHash, owner: opts.evmWallet, mintRecipients: opts.solanaRecipients, allowCircleKitBridge: true })
        const a = await readBoundCctpAttestation(proof)
        return a.status === 'complete' && a.message ? { status: 'complete', message: a.message } : { status: 'pending' }
      }
      // Solana source: Circle's message for this signature, bound to the connected Arc wallet.
      const response = await fetch(`${CIRCLE_MAINNET.irisApiBase}/v2/messages/5?transactionHash=${encodeURIComponent(sourceTxHash)}`, { headers: { Accept: 'application/json' } })
      if (response.status === 404) return { status: 'pending' }
      if (!response.ok) throw new Error(`Circle API HTTP ${response.status}`)
      const payload = await response.json()
      if (!Array.isArray(payload?.messages) || payload.messages.length > 64) throw new Error('Malformed Circle response.')
      const owner = '0x' + opts.evmWallet.slice(2).toLowerCase().padStart(64, '0')
      const ours = payload.messages.filter((v: any) => { try { const m = decodeCctpRecoveryMessage(v.message); return m.sourceDomain === 5 && m.destinationDomain === 26 && m.mintRecipient === owner } catch { return false } })
      if (ours.length > 1) throw new Error('Several Circle messages match; not guessing.')
      if (!ours.length || ours[0].status !== 'complete') return { status: 'pending' }
      return { status: 'complete', message: ours[0].message }
    },
    arcMintMatches: (hash, message, evmWallet) => verifyArcMintTx(arcClient(), hash, message as Hex, evmWallet, 5),
    async solanaSignatureStatus(signature) {
      const r = await opts.solanaRead('getSignatureStatuses', [[signature], { searchTransactionHistory: true }])
      if (!r || !Array.isArray(r.value)) throw new Error('Solana signature status is unavailable.')
      return r.value[0] ?? null
    },
    solanaNonceUsed: message => readSolanaCctpMessageUsed(message, opts.solanaRead as any),
  }
}

// Read-only chain evidence used to settle an attempt. Any read failure throws, which keeps the attempt locked.
export const solanaSendEvidence: SolanaSendEvidence = {
  arcLatestBlock: () => arcClient().getBlockNumber(),
  async arcReceipt(hash) {
    try {
      const receipt = await arcClient().getTransactionReceipt({ hash: hash as Hex })
      return receipt.status === 'success' ? 'success' : 'reverted'
    } catch (error) {
      if ((error as { name?: string })?.name === 'TransactionReceiptNotFoundError') return null
      throw error
    }
  },
  async arcBurnsSince(evmWallet, fromBlock) {
    const client = arcClient(), latest = await client.getBlockNumber()
    if (latest - fromBlock > ARC_LOG_SPAN * BigInt(ARC_MAX_SPANS)) throw new Error('The transfer is too old for the automatic Arc burn search.')
    const candidates = new Set<Hex>()
    for (let from = fromBlock; from <= latest; from += ARC_LOG_SPAN) {
      const to = from + ARC_LOG_SPAN - 1n > latest ? latest : from + ARC_LOG_SPAN - 1n
      const logs = await client.getLogs({ address: MAINNET_CONFIG.arcCctpTokenMessengerAddress, event: DEPOSIT_FOR_BURN, args: { burnToken: MAINNET_NETWORKS.arc.usdcAddress }, fromBlock: from, toBlock: to })
      for (const log of logs) {
        const depositor = String(log.args.depositor ?? '').toLowerCase()
        if (Number(log.args.destinationDomain) === SOLANA_MAINNET_CCTP.cctpDomain && log.transactionHash && (depositor === evmWallet.toLowerCase() || depositor === CIRCLE_KIT_BRIDGE_CONTRACT.toLowerCase())) candidates.add(log.transactionHash)
      }
    }
    const burns: string[] = []
    for (const hash of candidates) if ((await client.getTransaction({ hash })).from.toLowerCase() === evmWallet.toLowerCase()) burns.push(hash)
    return burns
  },
  async arcNothingPending(evmWallet) {
    const client = arcClient(), address = evmWallet as Hex
    const [pending, latest] = await Promise.all([client.getTransactionCount({ address, blockTag: 'pending' }), client.getTransactionCount({ address, blockTag: 'latest' })])
    return pending === latest
  },
  async solanaSignatureStatus(signature) {
    const result = await solanaRpc<{ value: Array<{ err: unknown; confirmationStatus?: string } | null> }>('getSignatureStatuses', [[signature], { searchTransactionHistory: true }])
    const status = result?.value?.[0]
    if (!status) return { found: false }
    return { found: true, err: status.err ?? null, confirmed: status.confirmationStatus === 'confirmed' || status.confirmationStatus === 'finalized' }
  },
  async solanaBlockhashValid(blockhash) {
    const result = await solanaRpc<{ value: boolean }>('isBlockhashValid', [blockhash, { commitment: 'processed' }])
    if (typeof result?.value !== 'boolean') throw new Error('Solana blockhash validity was not returned.')
    return result.value
  },
  async solanaBurnsSince(solanaWallet, sinceMs) {
    const signatures = await solanaRpc<Array<{ signature: string; blockTime?: number | null; err: unknown }>>('getSignaturesForAddress', [solanaWallet, { limit: 25, commitment: 'confirmed' }])
    const burns: string[] = []
    for (const s of signatures ?? []) {
      if (s.err != null || !s.blockTime || s.blockTime * 1000 < sinceMs) continue
      const tx = await solanaRpc<{ transaction?: { message?: { accountKeys?: unknown[] } }; meta?: { loadedAddresses?: { writable?: string[]; readonly?: string[] } } } | null>('getTransaction', [s.signature, { maxSupportedTransactionVersion: 0, commitment: 'confirmed' }])
      const keys = [...(tx?.transaction?.message?.accountKeys ?? []).map(k => typeof k === 'string' ? k : (k as { pubkey?: string })?.pubkey), ...(tx?.meta?.loadedAddresses?.writable ?? []), ...(tx?.meta?.loadedAddresses?.readonly ?? [])]
      if (keys.includes(SOLANA_MAINNET_CCTP.tokenMessengerMinterProgram)) burns.push(s.signature)
    }
    return burns
  },
  now: () => Date.now(),
}

function recordBurn(a: SolanaSendAttempt, txHash: string) {
  // Make the confirmed burn visible in Activity (no status: the mint is not verified here); minting continues
  // through the existing receive/recovery paths, which update the same record.
  const same = (x: { direction: string; sourceTxHash?: string }) => x.direction === a.direction && (a.direction === 'arc-to-solana' ? x.sourceTxHash?.toLowerCase() === txHash.toLowerCase() : x.sourceTxHash === txHash)
  if (!readMainnetSolanaActivity().some(same)) recordMainnetSolanaActivity({ evmWallet: a.evmWallet, solanaWallet: a.solanaWallet, direction: a.direction, amount: a.amount, sourceTxHash: txHash })
}

export async function settleSolanaSendAttempt(a: SolanaSendAttempt, evidence: SolanaSendEvidence = solanaSendEvidence): Promise<{ attempt: SolanaSendAttempt; verdict: SolanaSendVerdict }> {
  let verdict: SolanaSendVerdict
  try { verdict = await verifySolanaSendAttempt(a, evidence) } catch { verdict = { kind: 'unknown', reason: 'The networks could not be read to check the earlier transfer. Try again in a moment.' } }
  const attempt = applySolanaSendVerdict(a, verdict)
  if (verdict.kind === 'burned') recordBurn(attempt, verdict.txHash)
  return { attempt, verdict }
}

export const SOLANA_SEND_BUSY = 'Another tab is already sending a Solana transfer for these wallets. Finish it there first.'
const shortRef = (a: SolanaSendAttempt) => `${a.direction === 'arc-to-solana' ? 'Arc → Solana' : 'Solana → Arc'} ${a.amount} USDC`

type EvmRequest = (args: { method: string; params?: unknown }) => Promise<unknown>
type SolanaSign = { signTransaction?: (tx: unknown) => Promise<unknown>; signAllTransactions?: (txs: unknown[]) => Promise<unknown[]> }

// Runs one transfer with the wallet locks held and the attempt persisted before any wallet request.
// The wrapped providers record the burn request and its outcome as it happens.
export async function withSolanaSendGuard<T>(
  input: { direction: SolanaSendDirection; amount: string; evmWallet: string; solanaWallet: string },
  run: (guard: { evm<P extends object>(p: P): P; solana<P extends object>(p: P, validate?: (tx: unknown) => void): P }) => Promise<T>,
  evidence: SolanaSendEvidence = solanaSendEvidence,
): Promise<T> {
  const locks = typeof navigator === 'undefined' ? undefined : navigator.locks
  if (!locks) throw new Error('A safe browser transaction lock is required to send a Solana transfer.')
  return locks.request(`machina-solana-send:evm:${input.evmWallet.toLowerCase()}`, { ifAvailable: true }, async evmLock => {
    if (!evmLock) throw new Error(SOLANA_SEND_BUSY)
    return locks.request(`machina-solana-send:sol:${input.solanaWallet}`, { ifAvailable: true }, async solLock => {
      if (!solLock) throw new Error(SOLANA_SEND_BUSY)
      releaseStalePrepared(input.evmWallet, input.solanaWallet)
      const open = openSolanaSendAttempt(input.evmWallet, input.solanaWallet)
      if (open) {
        const { verdict } = await settleSolanaSendAttempt(open, evidence)
        if (verdict.kind === 'unknown') throw new Error(`An earlier transfer (${shortRef(open)}) has no verified outcome yet: ${verdict.reason} New transfers stay locked so nothing is sent twice.`)
        if (verdict.kind === 'burned') throw new Error(`An earlier transfer (${shortRef(open)}) has its burn on chain; receiving it is not verified yet. It is in your activity: check it there before starting another transfer.`)
      }
      const arcBlockBefore = input.direction === 'arc-to-solana' ? String(await evidence.arcLatestBlock()) : undefined
      const attempt = createSolanaSendAttempt({ ...input, arcBlockBefore })
      const isBurnTarget = (to: unknown) => typeof to === 'string' && [MAINNET_CONFIG.arcCctpTokenMessengerAddress, CIRCLE_KIT_BRIDGE_CONTRACT].some(a => a.toLowerCase() === to.toLowerCase())
      const failed = (error: unknown) => {
        try {
          updateSolanaSendAttempt(attempt.id, isUserRejection(error)
            ? { phase: 'released', note: 'You rejected the burn in your wallet; nothing was sent.' }
            : { phase: 'unknown', note: 'The wallet did not confirm whether the burn was sent.' })
        } catch { /* stays in its blocking phase */ }
      }
      const guard = {
        evm<P extends object>(target: P): P {
          if (input.direction !== 'arc-to-solana') return target
          const provider = target as P & { request: EvmRequest }
          return { ...provider, request: async (args: { method: string; params?: unknown }) => {
            const first = Array.isArray(args.params) ? args.params[0] as { to?: unknown; calls?: Array<{ to?: unknown }> } | undefined : undefined
            // The burn is a single transaction, or one call of an EIP-5792 batch (approve + burn).
            const batch = args.method === 'wallet_sendCalls' && Array.isArray(first?.calls) && first.calls.some(c => isBurnTarget(c?.to))
            if (!batch && (args.method !== 'eth_sendTransaction' || !isBurnTarget(first?.to))) return provider.request(args)
            updateSolanaSendAttempt(attempt.id, { phase: 'signing', signingAt: Date.now() }) // throws before any wallet request if it cannot be saved
            let result: unknown
            try { result = await provider.request(args) } catch (error) { failed(error); throw error }
            // Already submitted: a failed save leaves "signing", which the Arc burn search settles.
            try {
              if (batch) updateSolanaSendAttempt(attempt.id, { phase: 'unknown', note: 'The wallet accepted the batch; the burn is confirmed from Arc.' })
              else if (typeof result === 'string') updateSolanaSendAttempt(attempt.id, { phase: 'sent', burnTxHash: result })
            } catch { /* stays signing */ }
            return result
          } } as P
        },
        solana<P extends object>(target: P, validate?: (tx: unknown) => void): P {
          if (input.direction !== 'solana-to-arc') return target
          const provider = target as P & SolanaSign
          const signed = async <R>(unsigned: unknown, sign: () => Promise<R>, first: (r: R) => unknown): Promise<R> => {
            // A transaction refused by the pre-sign policy never reaches the wallet: it is checked before
            // the attempt is marked as signing, so the attempt stays "prepared" and is released, not locked.
            validate?.(unsigned)
            // The blockhash of the transaction handed to the wallet is saved first: once it has expired,
            // that transaction can never land, even if the wallet answer was lost.
            const requested = solanaSignatureOf(unsigned).blockhash
            updateSolanaSendAttempt(attempt.id, { phase: 'signing', signingAt: Date.now(), ...(requested ? { solanaBlockhash: requested } : {}) })
            let result: R
            try { result = await sign() } catch (error) { failed(error); throw error }
            const { signature, blockhash } = solanaSignatureOf(first(result))
            // Saved before the signed burn is handed back for sending; if this throws, nothing is sent.
            if (signature) updateSolanaSendAttempt(attempt.id, { phase: 'signed', solanaSignature: signature, ...(blockhash ? { solanaBlockhash: blockhash } : {}) })
            return result
          }
          return { ...provider,
            signTransaction: (tx: unknown) => signed(tx, () => provider.signTransaction!(tx), r => r),
            ...(provider.signAllTransactions ? { signAllTransactions: (txs: unknown[]) => { txs.forEach(tx => validate?.(tx)); return signed(txs[0], () => provider.signAllTransactions!(txs), r => r[0]) } } : {}),
          } as P
        },
      }
      try {
        return await run(guard)
      } finally {
        const current = readSolanaSendAttempts().find(a => a.id === attempt.id)
        if (current) await settleSolanaSendAttempt(current, evidence)
      }
    })
  })
}

// Manual review: unlock an attempt that chain evidence cannot settle, after the user confirmed
// (behind an explicit warning) that no wallet still holds the request. It takes the same wallet
// locks (refused while another tab is sending) and re-checks the chains first: a burn found now
// is recorded instead, and a proven outcome is applied as usual.
export async function releaseSolanaSendAttemptAfterReview(id: string, evidence: SolanaSendEvidence = solanaSendEvidence): Promise<SolanaSendVerdict | { kind: 'released-by-user' }> {
  const locks = typeof navigator === 'undefined' ? undefined : navigator.locks
  if (!locks) throw new Error('A safe browser transaction lock is required.')
  const target = readSolanaSendAttempts().find(a => a.id === id)
  if (!target) throw new Error('The locked transfer record was not found.')
  return locks.request(`machina-solana-send:evm:${target.evmWallet.toLowerCase()}`, { ifAvailable: true }, async evmLock => {
    if (!evmLock) throw new Error(SOLANA_SEND_BUSY)
    return locks.request(`machina-solana-send:sol:${target.solanaWallet}`, { ifAvailable: true }, async solLock => {
      if (!solLock) throw new Error(SOLANA_SEND_BUSY)
      const current = readSolanaSendAttempts().find(a => a.id === id)
      if (!current) throw new Error('The locked transfer record was not found.')
      const { attempt, verdict } = await settleSolanaSendAttempt(current, evidence)
      if (verdict.kind !== 'unknown') return verdict
      // A read failure is not "no burn": only an evidence check that completed allows the manual unlock.
      if (/could not be read/.test(verdict.reason)) throw new Error(verdict.reason)
      releaseSolanaSendAttemptManually(attempt)
      return { kind: 'released-by-user' as const }
    })
  })
}

// The attempt that blocks new transfers for the connected wallets, kept in sync across tabs.
export function useOpenSolanaSendAttempt(evmWallet: string | null | undefined, solanaWallet: string | null | undefined) {
  const read = useCallback(() => {
    if (!evmWallet || !solanaWallet) return null
    try { return openSolanaSendAttempt(evmWallet, solanaWallet) } catch { return { id: 'unreadable', direction: 'arc-to-solana', evmWallet, solanaWallet, amount: '?', createdAt: 0, updatedAt: 0, phase: 'unknown', note: 'The Solana transfer record could not be read.' } as SolanaSendAttempt }
  }, [evmWallet, solanaWallet])
  const [open, setOpen] = useState<SolanaSendAttempt | null>(read)
  const [checking, setChecking] = useState(false)
  useEffect(() => {
    setOpen(read())
    const refresh = () => setOpen(read())
    const onStorage = (e: StorageEvent) => { if (e.key === SOLANA_SEND_JOURNAL_KEY) refresh() }
    window.addEventListener(SOLANA_SEND_JOURNAL_EVENT, refresh); window.addEventListener('storage', onStorage)
    return () => { window.removeEventListener(SOLANA_SEND_JOURNAL_EVENT, refresh); window.removeEventListener('storage', onStorage) }
  }, [read])
  const check = useCallback(async () => {
    const current = read()
    if (!current || current.id === 'unreadable' || checking) return null
    setChecking(true)
    try { return (await settleSolanaSendAttempt(current)).verdict } finally { setChecking(false); setOpen(read()) }
  }, [read, checking])
  const releaseAfterReview = useCallback(async () => {
    const current = read()
    if (!current || current.id === 'unreadable' || checking) return null
    setChecking(true)
    try { return await releaseSolanaSendAttemptAfterReview(current.id) } finally { setChecking(false); setOpen(read()) }
  }, [read, checking])
  return { open, checking, check, releaseAfterReview }
}
