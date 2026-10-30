// Earn deposit/withdraw journal. Every operation is written to storage BEFORE any
// wallet request, bound to account, Arc chain, vault, action and exact amount.
// The wallet provider handed to EarnKit is wrapped so each eth_sendTransaction is
// checked against the reviewed operation and journaled before it reaches the
// wallet, and its hash is stored the moment the wallet returns it (EarnKit itself
// reports the execute hash only after a receipt).
//
// Circle Earn Kit (same-chain, batchTransactions: false) sends, in this order:
//   1. optionally ONE approval to the Earn adapter
//        deposit:  USDC.increaseAllowance(adapter, missing + 1)  (approve for non-USDC tokens)
//        withdraw: vault.approve(adapter, shares + 1)
//   2. ONE Adapter.execute(params, tokenInputs, signature)
// (fixtures/real-earn-txs.json holds real Arc mainnet examples of both.)
//
// An operation leaves its open state only on evidence:
//   * success: the execute receipt is successful, the transaction is this wallet's
//     execute for the reviewed vault/amount, and its logs show the vault movement;
//   * reverted: that execute's receipt reverted;
//   * not_sent: the execute request never reached the wallet, or the wallet
//     explicitly rejected it;
// otherwise it stays `unknown` and blocks new operations for that wallet.
import { decodeFunctionData, decodeEventLog, padHex, parseAbi, parseUnits, type Hex } from 'viem'

export const EARN_JOURNAL_KEY = 'machina.earn.journal.v1'
export const EARN_CHAIN_ID = 5042
export const ARC_USDC = '0x3600000000000000000000000000000000000000'
// Arc mainnet Earn adapter (kitContracts.adapter of the Arc chain in @circle-fin/earn-kit).
export const EARN_ADAPTER = '0x7fb8c7260b63934d8da38af902f87ae6e284a845'
// Earn Kit approves the missing allowance plus one unit (WARM_SLOT_RESIDUAL).
const APPROVAL_RESIDUAL = 1n
const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'
// Bounded log search after the attempt for a hash the wallet never returned
// (the Arc RPC accepts at most 10,000 blocks per eth_getLogs).
export const LOST_EARN_SEARCH = Object.freeze({ windowBlocks: 10_000n, maxWindows: 6 })
const KEEP_SETTLED = 30

const APPROVAL_ABI = parseAbi(['function approve(address spender,uint256 amount)', 'function increaseAllowance(address spender,uint256 addedValue)'])
const EXECUTE_ABI = parseAbi(['function execute(((address target,bytes data,uint256 value,address tokenIn,uint256 amountToApprove,address tokenOut,uint256 minTokenOut)[] instructions,(address token,address beneficiary)[] tokens,uint256 execId,uint256 deadline,bytes metadata) params,(uint8 permitType,address token,uint256 amount,bytes permitCalldata)[] tokenInputs,bytes signature)'])
const INSTRUCTION_ABI = parseAbi(['function deposit(uint256 assets,address receiver)', 'function withdraw(uint256 assets,address receiver,address owner)'])
const TRANSFER_ABI = parseAbi(['event Transfer(address indexed from,address indexed to,uint256 value)'])
const BALANCE_ABI = parseAbi(['function balanceOf(address account) view returns (uint256)'])

export type EarnAction = 'deposit' | 'withdraw'
export type EarnOutcome = 'sending' | 'unknown' | 'success' | 'reverted' | 'not_sent'
export type EarnRequest = { kind: 'approve' | 'execute'; state: 'requested' | 'hash' | 'rejected' | 'failed'; hash?: string }
export type EarnJournalRecord = {
  id: string
  account: string
  chainId: number
  vault: string
  action: EarnAction
  amount: string
  amountRaw: string
  // withdraw only: vault shares held at the attempt (bounds the share approval and pull)
  shareBalanceRaw?: string
  createdAt: number
  updatedAt: number
  attemptNonce: number
  attemptBlock: number
  requests: EarnRequest[]
  outcome: EarnOutcome
  executeHash?: string
  lastError?: string
  // success evidence from the execute receipt: the exact USDC movement and the vault share movement
  evidence?: { block: number; usdc: true; shares: true }
}

export class EarnJournalError extends Error {}

const HASH = /^0x[0-9a-f]{64}$/
const lc = (value: unknown) => String(value ?? '').toLowerCase()
const isRecord = (r: any): r is EarnJournalRecord => Boolean(r) && typeof r.id === 'string' && typeof r.account === 'string' && r.chainId === EARN_CHAIN_ID
  && typeof r.vault === 'string' && (r.action === 'deposit' || r.action === 'withdraw') && /^\d+$/.test(r.amountRaw) && Array.isArray(r.requests)
  && ['sending', 'unknown', 'success', 'reverted', 'not_sent'].includes(r.outcome) && Number.isSafeInteger(r.attemptNonce) && Number.isSafeInteger(r.attemptBlock)
  && (r.executeHash === undefined || HASH.test(r.executeHash)) && (r.shareBalanceRaw === undefined || /^\d+$/.test(r.shareBalanceRaw))

export function readEarnJournal(): EarnJournalRecord[] {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(EARN_JOURNAL_KEY) ?? '[]')
    return Array.isArray(parsed) ? parsed.filter(isRecord) : []
  } catch {
    return []
  }
}

function writeEarnJournal(records: EarnJournalRecord[]) {
  const open = records.filter(r => r.outcome === 'sending' || r.outcome === 'unknown')
  const settled = records.filter(r => !open.includes(r)).sort((a, b) => b.updatedAt - a.updatedAt).slice(0, KEEP_SETTLED)
  const text = JSON.stringify([...open, ...settled])
  try {
    window.localStorage.setItem(EARN_JOURNAL_KEY, text)
    if (window.localStorage.getItem(EARN_JOURNAL_KEY) !== text) throw new Error('read-back mismatch')
  } catch {
    throw new EarnJournalError('The Earn operation record could not be saved in this browser. Nothing was sent.')
  }
}

export function getEarnRecord(id: string) {
  return readEarnJournal().find(r => r.id === id)
}

export function saveEarnRecord(record: EarnJournalRecord) {
  const next = { ...record, updatedAt: Date.now() }
  writeEarnJournal([next, ...readEarnJournal().filter(r => r.id !== record.id)])
  return next
}

function patchEarnRecord(id: string, patch: (r: EarnJournalRecord) => EarnJournalRecord) {
  const current = getEarnRecord(id)
  if (!current) throw new EarnJournalError('The Earn operation record is missing. Nothing was sent.')
  return saveEarnRecord(patch(current))
}

export function openEarnRecordFor(account?: string) {
  if (!account) return undefined
  const a = account.toLowerCase()
  return readEarnJournal().find(r => r.account === a && (r.outcome === 'sending' || r.outcome === 'unknown'))
}

export function settledEarnRecordsFor(account?: string) {
  if (!account) return []
  const a = account.toLowerCase()
  return readEarnJournal().filter(r => r.account === a && r.outcome === 'success').sort((x, y) => y.updatedAt - x.updatedAt)
}

// Exact USDC amounts (6 decimals). Input must be a plain positive decimal.
export function parseUsdcInput(value: string): bigint | null {
  if (!/^(\d+(\.\d{0,6})?|\.\d{1,6})$/.test(value)) return null
  const amount = parseUnits(value.startsWith('.') ? '0' + value : value, 6)
  return amount > 0n ? amount : null
}

// A balance read from an API may carry more than 6 decimals: round DOWN so a
// rounding error can never allow more than the account holds.
export function floorUsdcRaw(value: unknown): bigint | null {
  if (typeof value !== 'string' || !/^\d+(\.\d+)?$/.test(value)) return null
  const [whole, fraction = ''] = value.split('.')
  return BigInt(whole) * 1_000_000n + BigInt((fraction + '000000').slice(0, 6))
}

export function isWalletRejection(error: unknown): boolean {
  for (let e: any = error, n = 0; e && n < 8; e = e.cause, n++) {
    if (e?.code === 4001 || e?.name === 'UserRejectedRequestError') return true
  }
  return false
}

// Attempt evidence right before the operation: no pending wallet transaction,
// so the next mined nonce is the one this operation would use.
export async function readEarnAttempt(client: any, account: string) {
  const [latest, pending, block] = await Promise.all([
    client.getTransactionCount({ address: account, blockTag: 'latest' }),
    client.getTransactionCount({ address: account, blockTag: 'pending' }),
    client.getBlockNumber({ cacheTime: 0 }),
  ])
  if (!Number.isSafeInteger(latest) || latest !== pending || typeof block !== 'bigint') {
    throw new Error('Your wallet has a pending transaction on Arc. Let it finish (or cancel it in the wallet) before starting an Earn operation.')
  }
  return { attemptNonce: latest as number, attemptBlock: Number(block) }
}

export function createEarnRecord(input: { account: string; vault: string; action: EarnAction; amount: string; amountRaw: bigint; attemptNonce: number; attemptBlock: number; shareBalanceRaw?: bigint }) {
  const id = typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`
  return saveEarnRecord({
    id,
    account: input.account.toLowerCase(),
    chainId: EARN_CHAIN_ID,
    vault: input.vault.toLowerCase(),
    action: input.action,
    amount: input.amount,
    amountRaw: input.amountRaw.toString(),
    ...(input.shareBalanceRaw !== undefined ? { shareBalanceRaw: input.shareBalanceRaw.toString() } : {}),
    createdAt: Date.now(),
    updatedAt: Date.now(),
    attemptNonce: input.attemptNonce,
    attemptBlock: input.attemptBlock,
    requests: [],
    outcome: 'sending',
  })
}

class EarnRequestMismatch extends Error {
  constructor(detail: string) { super(`The wallet request does not match the reviewed Earn operation (${detail}). Nothing was sent.`) }
}

// Adapter.execute calldata must be exactly the reviewed operation: one vault
// instruction on the reviewed vault for the reviewed amount, tokens pulled only
// from this wallet's reviewed asset, and every output token returned to this wallet.
export function assertEarnExecuteMatches(record: Pick<EarnJournalRecord, 'account' | 'vault' | 'action' | 'amountRaw' | 'shareBalanceRaw'>, data: unknown) {
  let decoded
  try {
    decoded = decodeFunctionData({ abi: EXECUTE_ABI, data: data as Hex })
  } catch {
    throw new EarnRequestMismatch('not an Earn adapter execute call')
  }
  const [params, tokenInputs] = decoded.args
  const amount = BigInt(record.amountRaw), vault = record.vault, account = record.account
  const asset = record.action === 'deposit' ? ARC_USDC : vault, output = record.action === 'deposit' ? vault : ARC_USDC
  if (params.instructions.length !== 1) throw new EarnRequestMismatch('instruction count')
  const instruction = params.instructions[0]
  if (lc(instruction.target) !== vault) throw new EarnRequestMismatch('vault')
  if (instruction.value !== 0n || lc(instruction.tokenIn) !== asset || lc(instruction.tokenOut) !== output) throw new EarnRequestMismatch('instruction tokens')
  let inner
  try {
    inner = decodeFunctionData({ abi: INSTRUCTION_ABI, data: instruction.data })
  } catch {
    throw new EarnRequestMismatch('vault call')
  }
  const forUs = (address: string) => lc(address) === EARN_ADAPTER || lc(address) === account
  if (record.action === 'deposit') {
    if (inner.functionName !== 'deposit') throw new EarnRequestMismatch('vault call')
    const [assets, receiver] = inner.args
    if (assets !== amount || !forUs(receiver) || instruction.amountToApprove !== amount) throw new EarnRequestMismatch('amount')
  } else {
    if (inner.functionName !== 'withdraw') throw new EarnRequestMismatch('vault call')
    const [assets, receiver, owner] = inner.args
    if (assets !== amount || !forUs(receiver) || !forUs(owner) || instruction.minTokenOut > amount) throw new EarnRequestMismatch('amount')
  }
  // What the adapter pulls from the wallet: the reviewed USDC amount, or at most the shares held.
  if (!tokenInputs.length) throw new EarnRequestMismatch('token inputs')
  let pulled = 0n
  for (const input of tokenInputs) {
    if (input.permitType !== 0 || lc(input.token) !== asset || input.permitCalldata !== '0x') throw new EarnRequestMismatch('token inputs')
    pulled += input.amount
  }
  const pullLimit = record.action === 'deposit' ? amount : BigInt(record.shareBalanceRaw ?? '0')
  if (record.action === 'deposit' ? pulled !== pullLimit : pulled === 0n || pulled > pullLimit) throw new EarnRequestMismatch('token inputs')
  // Every token the adapter hands out (shares, refunds) goes to this wallet.
  const tokens = params.tokens.map(t => [lc(t.token), lc(t.beneficiary)])
  if (!tokens.length || tokens.some(([, beneficiary]) => beneficiary !== account) || !tokens.some(([t]) => t === output) || !tokens.some(([t]) => t === asset)) throw new EarnRequestMismatch('beneficiary')
}

// Which reviewed step a wallet request is. Anything else never reaches the wallet.
export function classifyEarnRequest(record: Pick<EarnJournalRecord, 'account' | 'vault' | 'action' | 'amountRaw' | 'shareBalanceRaw'>, tx: any): 'approve' | 'execute' {
  if (lc(tx?.from) !== record.account) throw new Error('The transaction was prepared for another wallet account. Nothing was sent.')
  if (tx.chainId !== undefined && Number(tx.chainId) !== EARN_CHAIN_ID) throw new Error('The transaction was prepared for another network. Nothing was sent.')
  if (tx.value !== undefined && BigInt(tx.value) !== 0n) throw new EarnRequestMismatch('value')
  if (lc(tx.to) === EARN_ADAPTER) {
    assertEarnExecuteMatches(record, tx.data)
    return 'execute'
  }
  // Approval of exactly the reviewed asset to the Earn adapter, bounded by what the operation needs.
  if (lc(tx.to) !== (record.action === 'deposit' ? ARC_USDC : record.vault)) throw new EarnRequestMismatch('contract')
  let approval
  try {
    approval = decodeFunctionData({ abi: APPROVAL_ABI, data: tx.data })
  } catch {
    throw new EarnRequestMismatch('approval call')
  }
  const [spender, value] = approval.args
  const limit = (record.action === 'deposit' ? BigInt(record.amountRaw) : BigInt(record.shareBalanceRaw ?? '0')) + APPROVAL_RESIDUAL
  if (lc(spender) !== EARN_ADAPTER) throw new EarnRequestMismatch('spender')
  if (value === 0n || value > limit) throw new EarnRequestMismatch('approval amount')
  return 'approve'
}

type Eip1193 = { request: (args: { method: string; params?: any }) => Promise<any> }

// Wallet provider for one journaled operation: at most one approval followed by
// exactly one execute, each matching the review, each journaled before it is sent.
export function guardEarnProvider(provider: Eip1193, recordId: string): Eip1193 {
  const refuse = (reason: string): never => {
    try {
      patchEarnRecord(recordId, r => r.outcome === 'sending' ? { ...r, lastError: reason } : r)
    } catch { /* the error itself still stops the request */ }
    throw new Error(reason)
  }
  return {
    request: async args => {
      if (['wallet_sendCalls', 'eth_sendRawTransaction', 'eth_signTransaction'].includes(args.method)) {
        refuse('Machina Earn sends one wallet transaction at a time. Nothing was sent.')
      }
      if (args.method !== 'eth_sendTransaction') return provider.request(args)
      const tx = args.params?.[0] ?? {}
      const record = getEarnRecord(recordId)
      if (!record || record.outcome !== 'sending') return refuse('This Earn operation is no longer active. Nothing was sent.')
      let kind: 'approve' | 'execute'
      try {
        kind = classifyEarnRequest(record, tx)
      } catch (error) {
        return refuse(error instanceof Error ? error.message : 'The wallet request does not match the reviewed Earn operation. Nothing was sent.')
      }
      if (record.requests.some(r => r.kind === 'execute')) return refuse('This Earn operation already sent its transaction. Nothing more was sent.')
      if (kind === 'approve' && record.requests.some(r => r.kind === 'approve')) return refuse('This Earn operation already requested its approval. Nothing more was sent.')
      const index = record.requests.length
      // Throws (and nothing reaches the wallet) when the request cannot be journaled.
      saveEarnRecord({ ...record, requests: [...record.requests, { kind, state: 'requested' }] })
      const mark = (request: EarnRequest, executeHash?: string) => {
        try {
          patchEarnRecord(recordId, r => ({ ...r, requests: r.requests.map((q, i) => i === index ? request : q), ...(executeHash ? { executeHash } : {}) }))
        } catch { /* stays 'requested': settles as unknown, never as not sent */ }
      }
      let hash: unknown
      try {
        hash = await provider.request(args)
      } catch (error) {
        mark({ kind, state: isWalletRejection(error) ? 'rejected' : 'failed' })
        throw error
      }
      const normalized = lc(hash)
      if (!HASH.test(normalized)) {
        mark({ kind, state: 'failed' })
        throw new Error('The wallet returned an unreadable transaction hash.')
      }
      mark({ kind, state: 'hash', hash: normalized }, kind === 'execute' ? normalized : undefined)
      return hash
    },
  }
}

// Transfer logs of one token in a receipt.
function transfers(logs: any[], token: string) {
  return logs.flatMap(l => {
    if (lc(l.address) !== token || l.topics?.[0] !== TRANSFER_TOPIC || l.topics.length !== 3) return []
    try {
      const { args } = decodeEventLog({ abi: TRANSFER_ABI, data: l.data, topics: l.topics })
      return [{ from: lc(args.from), to: lc(args.to), value: args.value }]
    } catch {
      return []
    }
  })
}

// The vault movement of the reviewed operation, read from the execute receipt.
function vaultMovementProven(record: EarnJournalRecord, logs: any[]) {
  const amount = BigInt(record.amountRaw), usdc = transfers(logs, ARC_USDC), shares = transfers(logs, record.vault)
  return record.action === 'deposit'
    ? usdc.some(t => t.from === record.account && t.to === EARN_ADAPTER && t.value === amount) && shares.some(t => t.to === record.account && t.value > 0n)
    : usdc.some(t => t.from === EARN_ADAPTER && t.to === record.account && t.value === amount) && shares.some(t => t.from === record.account && t.to === EARN_ADAPTER && t.value > 0n)
}

type Settled = Pick<EarnJournalRecord, 'outcome' | 'executeHash' | 'evidence' | 'lastError'>

async function verifyExecute(record: EarnJournalRecord, hash: string, client: any): Promise<Settled> {
  let receipt: any, tx: any
  try {
    [receipt, tx] = await Promise.all([client.getTransactionReceipt({ hash }), client.getTransaction({ hash })])
  } catch {
    return { outcome: 'unknown', executeHash: hash, lastError: `Transaction ${hash} is not confirmed yet.` }
  }
  // The transaction itself must be this wallet's execute of the reviewed operation.
  try {
    if (lc(tx?.from) !== record.account || lc(tx?.to) !== EARN_ADAPTER || lc(receipt?.from) !== record.account || lc(receipt?.to) !== EARN_ADAPTER) throw new Error('sender')
    assertEarnExecuteMatches(record, tx.input)
  } catch {
    return { outcome: 'unknown', executeHash: hash, lastError: `Transaction ${hash} is not the reviewed Earn ${record.action}. Check the explorer before trying again.` }
  }
  if (receipt.status === 'reverted') return { outcome: 'reverted', executeHash: hash, lastError: `Earn ${record.action} ${hash} reverted on chain. No funds moved.` }
  if (receipt.status !== 'success') return { outcome: 'unknown', executeHash: hash }
  if (!vaultMovementProven(record, receipt.logs ?? [])) {
    return { outcome: 'unknown', executeHash: hash, lastError: `Transaction ${hash} succeeded, but the expected vault movement was not found in its logs. Check your position before trying again.` }
  }
  return { outcome: 'success', executeHash: hash, lastError: undefined, evidence: { block: Number(receipt.blockNumber), usdc: true, shares: true } }
}

// The wallet may have broadcast the execute without returning its hash: look for
// exactly one transaction of this wallet, at or after the attempt nonce, whose
// execute calldata is the reviewed operation and whose USDC moved the exact amount
// between this wallet and the Earn adapter.
async function findLostExecute(record: EarnJournalRecord, client: any): Promise<string | 'unknown'> {
  const head = await client.getBlockNumber({ cacheTime: 0 }) as bigint
  const account = padHex(record.account as Hex, { size: 32 }), adapter = padHex(EARN_ADAPTER as Hex, { size: 32 })
  const topics = record.action === 'deposit' ? [TRANSFER_TOPIC, account, adapter] : [TRANSFER_TOPIC, adapter, account]
  const known = new Set(readEarnJournal().filter(r => r.id !== record.id && r.executeHash).map(r => r.executeHash!))
  const candidates = new Set<string>()
  let from = BigInt(record.attemptBlock)
  for (let n = 0; n < LOST_EARN_SEARCH.maxWindows && from <= head; n++) {
    const to = from + LOST_EARN_SEARCH.windowBlocks - 1n < head ? from + LOST_EARN_SEARCH.windowBlocks - 1n : head
    const logs = await client.request({ method: 'eth_getLogs', params: [{ address: ARC_USDC, topics, fromBlock: `0x${from.toString(16)}`, toBlock: `0x${to.toString(16)}` }] })
    if (!Array.isArray(logs) || logs.length > 256) return 'unknown'
    for (const l of logs) {
      try {
        if (BigInt(l.data) === BigInt(record.amountRaw) && !known.has(lc(l.transactionHash))) candidates.add(lc(l.transactionHash))
      } catch { /* not a Transfer value */ }
    }
    from = to + 1n
  }
  if (from <= head || candidates.size > 16) return 'unknown'
  const owned: string[] = []
  for (const hash of candidates) {
    const tx = await client.getTransaction({ hash }).catch(() => null)
    if (!tx || lc(tx.from) !== record.account || lc(tx.to) !== EARN_ADAPTER || Number(tx.nonce) < record.attemptNonce) continue
    try {
      assertEarnExecuteMatches(record, tx.input)
      owned.push(hash)
    } catch { /* another operation */ }
  }
  return owned.length === 1 ? owned[0] : 'unknown'
}

// Decide an operation from the journal and the chain. Read-only on chain.
export async function settleEarnRecord(id: string, client: any, sdkTxHash?: string): Promise<EarnJournalRecord> {
  const record = getEarnRecord(id)
  if (!record) throw new EarnJournalError('The Earn operation record is missing.')
  if (record.outcome === 'success' || record.outcome === 'reverted' || record.outcome === 'not_sent') return record
  const execute = record.requests.find(r => r.kind === 'execute')
  let settled: Settled
  try {
    if (record.executeHash) {
      if (sdkTxHash && lc(sdkTxHash) !== record.executeHash) settled = { outcome: 'unknown', lastError: 'Earn reported a different transaction than the wallet. Check the explorer before trying again.' }
      else settled = await verifyExecute(record, record.executeHash, client)
    } else if (!execute || execute.state === 'rejected') {
      // The execute transaction never reached the wallet, or the wallet refused it.
      settled = { outcome: 'not_sent', lastError: execute ? 'You rejected the request in your wallet. Nothing was sent.' : record.lastError }
    } else {
      const found = await findLostExecute(record, client)
      settled = found === 'unknown'
        ? { outcome: 'unknown', lastError: 'The wallet did not report whether the transaction was sent. Do not send it again; check the status here or in your wallet.' }
        : await verifyExecute(record, found, client)
    }
  } catch {
    settled = { outcome: 'unknown', lastError: 'The Arc network could not be read. The result is not confirmed yet.' }
  }
  if (settled.outcome === 'unknown' && record.outcome === 'unknown' && settled.lastError === undefined) settled.lastError = record.lastError
  return patchEarnRecord(id, r => ({ ...r, ...settled }))
}

export type EarnKitLike = { deposit: (params: any) => Promise<any>; withdraw: (params: any) => Promise<any> }

// One journaled Earn operation, from attempt evidence to a settled record.
// Throws only before anything could be sent.
export async function runEarnOperation(input: {
  kit: EarnKitLike
  walletProvider: Eip1193
  client: any
  createAdapter: (provider: Eip1193) => Promise<unknown>
  chain: string
  account: string
  vault: string
  action: EarnAction
  amount: string
  amountRaw: bigint
  onRecorded?: () => void
}) {
  const { client, account, vault, action } = input
  if (openEarnRecordFor(account)) throw new Error('An earlier Earn operation from this wallet is not confirmed yet. Check its status first.')
  const unreadable = (cause: unknown) => cause instanceof Error && /pending transaction/.test(cause.message) ? cause : new Error('The Arc network could not be read. Nothing was sent.')
  const attempt = await readEarnAttempt(client, account).catch(cause => { throw unreadable(cause) })
  const shareBalanceRaw = action === 'withdraw'
    ? await client.readContract({ address: vault, abi: BALANCE_ABI, functionName: 'balanceOf', args: [account] }).catch((cause: unknown) => { throw unreadable(cause) }) as bigint
    : undefined
  const record = createEarnRecord({ account, vault, action, amount: input.amount, amountRaw: input.amountRaw, shareBalanceRaw, ...attempt })
  input.onRecorded?.()
  let sdkTxHash: string | undefined
  let sdkError: unknown
  try {
    const adapter = await input.createAdapter(guardEarnProvider(input.walletProvider, record.id))
    const params = {
      from: { adapter, chain: input.chain },
      vaultAddress: vault,
      amount: input.amount,
      // Sequential approve -> execute: every wallet transaction passes the journal.
      config: { batchTransactions: false },
    }
    const result = action === 'deposit' ? await input.kit.deposit(params) : await input.kit.withdraw(params)
    sdkTxHash = typeof result?.txHash === 'string' ? result.txHash : undefined
  } catch (cause) {
    sdkError = cause
  }
  return { record: await settleEarnRecord(record.id, client, sdkTxHash), sdkError }
}
