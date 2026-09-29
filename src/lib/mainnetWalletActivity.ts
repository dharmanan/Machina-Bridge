import { toFunctionSelector } from 'viem'
import { MAINNET_CCTP_MESSAGE_TRANSMITTER, MAINNET_CCTP_TOKEN_MESSENGER } from '../config/mainnetCctp'
import { MAINNET_EARN_SELECTED_VAULT_ADDRESSES } from '../config/mainnetEarn'

export type WalletActivityType = 'send' | 'receive' | 'swap' | 'bridge' | 'earn' | 'approve' | 'interaction'
export type WalletActivityStatus = 'Confirmed' | 'Failed' | 'Unknown'

export type WalletActivity = {
  id: string
  txHash: string
  timestamp: number | null
  status: WalletActivityStatus
  type: WalletActivityType
  title: string
  amount: string | null
  counterparty: string | null
  protocol: string | null
}

type Transaction = {
  hash: string
  timeStamp: string | null
  from: string | null
  to: string | null
  value: string
  input: string
  isError: string
  receiptStatus: string
  tokenOnly?: boolean
}

type TokenTransfer = {
  hash: string
  contractAddress: string
  from: string
  to: string
  value: string
  symbol: string
  decimals: number
}

export type WalletActivityResponse = {
  transactions: Transaction[]
  tokenTransfers: TokenTransfer[]
  limit: number
}

const VAULTS = new Map<string, string>([
  [MAINNET_EARN_SELECTED_VAULT_ADDRESSES[0].toLowerCase(), 'Galaxy USDC'],
  [MAINNET_EARN_SELECTED_VAULT_ADDRESSES[1].toLowerCase(), 'Gauntlet USDC Prime'],
])

const ERC4626_SELECTORS = new Map<string, string>([
  [toFunctionSelector('deposit(uint256,address)'), 'deposit'],
  [toFunctionSelector('mint(uint256,address)'), 'mint'],
  [toFunctionSelector('withdraw(uint256,address,address)'), 'withdraw'],
  [toFunctionSelector('redeem(uint256,address,address)'), 'redeem'],
])

const CCTP_DEPOSIT_SELECTOR = toFunctionSelector(
  'depositForBurn(uint256,uint32,bytes32,address,bytes32,uint256,uint32)',
)
const CCTP_RECEIVE_SELECTOR = toFunctionSelector('receiveMessage(bytes,bytes)')
const APPROVE_SELECTOR = toFunctionSelector('approve(address,uint256)')
const ERC20_TRANSFER_SELECTORS = new Set<string>([
  toFunctionSelector('transfer(address,uint256)'),
  toFunctionSelector('transferFrom(address,address,uint256)'),
])
const SWAP_SELECTORS = new Set([
  '0x38ed1739', // swapExactTokensForTokens
  '0x04e45aaf', // exactInputSingle
  '0xb858183f', // exactInput
])
const ARC_NATIVE_DECIMALS = 18
const ARC_NATIVE_SENTINEL = '0xfffffffffffffffffffffffffffffffffffffffe'

type Movement = {
  key: string
  symbol: string
  decimals: number
  value: bigint
  outgoing: boolean
}

function getMovements(wallet: string, transfers: TokenTransfer[]): Movement[] {
  const grouped = new Map<string, Movement>()
  for (const transfer of transfers) {
    if (transfer.contractAddress.toLowerCase() === ARC_NATIVE_SENTINEL) continue
    const outgoing = transfer.from.toLowerCase() === wallet
    const incoming = transfer.to.toLowerCase() === wallet
    if (outgoing === incoming) continue

    const key = `${transfer.contractAddress.toLowerCase()}:${transfer.decimals}:${outgoing ? 'out' : 'in'}`
    const current = grouped.get(key)
    if (current) current.value += BigInt(transfer.value)
    else grouped.set(key, {
      key: transfer.contractAddress.toLowerCase(),
      symbol: transfer.symbol,
      decimals: transfer.decimals,
      value: BigInt(transfer.value),
      outgoing,
    })
  }
  return [...grouped.values()]
}

function formatAmount(value: bigint, decimals: number, symbol: string) {
  if (value <= 0n || decimals < 0 || decimals > 36) return null
  const base = 10n ** BigInt(decimals)
  const integer = value / base
  const fractional = value % base
  const integerText = new Intl.NumberFormat('en-US').format(integer)
  const fractionText = decimals > 0
    ? fractional.toString().padStart(decimals, '0').slice(0, 6).replace(/0+$/, '')
    : ''
  return `${integerText}${fractionText ? `.${fractionText}` : ''} ${symbol}`
}

function statusFor(transaction: Transaction): WalletActivityStatus {
  if (transaction.isError === '1' || transaction.receiptStatus === '0') return 'Failed'
  if (transaction.isError === '0' || transaction.receiptStatus === '1') return 'Confirmed'
  return 'Unknown'
}

function humanize(type: WalletActivityType, verb?: string, vault?: string) {
  if (type === 'earn') return `Earn ${verb ?? 'interaction'} · ${vault ?? 'Vault'}`
  if (type === 'bridge') return 'Bridge transfer'
  if (type === 'approve') return 'Token approval'
  if (type === 'swap') return 'Swap'
  if (type === 'send') return 'Send'
  if (type === 'receive') return 'Receive'
  return vault ? `Contract interaction · ${vault}` : 'Contract interaction'
}

function classify(
  wallet: string,
  transaction: Transaction,
  transfers: TokenTransfer[],
): Omit<WalletActivity, 'timestamp' | 'status'> {
  const recipient = transaction.to?.toLowerCase() ?? ''
  const from = transaction.from?.toLowerCase() ?? ''
  const selector = transaction.input.slice(0, 10).toLowerCase()
  const movements = getMovements(wallet, transfers)
  const hasMovementEvidence = movements.length > 0
  const vault = VAULTS.get(recipient)
  const earnAction = ERC4626_SELECTORS.get(selector)

  if (transaction.isError === '1' || transaction.receiptStatus === '0') {
    return {
      id: transaction.hash,
      txHash: transaction.hash,
      type: 'interaction',
      title: 'Failed transaction',
      amount: null,
      counterparty: transaction.to,
      protocol: null,
    }
  }

  if (vault && earnAction && hasMovementEvidence) {
    const movement = movements.length === 1 ? movements[0] : null
    return {
      id: transaction.hash,
      txHash: transaction.hash,
      type: 'earn',
      title: humanize('earn', earnAction, vault),
      amount: movement ? formatAmount(movement.value, movement.decimals, movement.symbol) : null,
      counterparty: null,
      protocol: vault,
    }
  }

  if (
    (recipient === MAINNET_CCTP_TOKEN_MESSENGER.toLowerCase() && selector === CCTP_DEPOSIT_SELECTOR)
    || (recipient === MAINNET_CCTP_MESSAGE_TRANSMITTER.toLowerCase() && selector === CCTP_RECEIVE_SELECTOR)
  ) {
    return {
      id: transaction.hash,
      txHash: transaction.hash,
      type: 'bridge',
      title: humanize('bridge'),
      amount: movements.length === 1
        ? formatAmount(movements[0].value, movements[0].decimals, movements[0].symbol)
        : null,
      counterparty: null,
      protocol: 'Circle CCTP',
    }
  }

  if (selector === APPROVE_SELECTOR) {
    return {
      id: transaction.hash,
      txHash: transaction.hash,
      type: 'approve',
      title: humanize('approve'),
      amount: null,
      counterparty: transaction.to,
      protocol: null,
    }
  }

  const nativeValue = BigInt(transaction.value || '0')
  if (nativeValue > 0n && selector === '0x' && from === wallet && recipient && recipient !== wallet) {
    return {
      id: transaction.hash,
      txHash: transaction.hash,
      type: 'send',
      title: humanize('send'),
      amount: formatAmount(nativeValue, ARC_NATIVE_DECIMALS, 'USDC'),
      counterparty: transaction.to,
      protocol: null,
    }
  }
  if (nativeValue > 0n && selector === '0x' && recipient === wallet && from !== wallet) {
    return {
      id: transaction.hash,
      txHash: transaction.hash,
      type: 'receive',
      title: humanize('receive'),
      amount: formatAmount(nativeValue, ARC_NATIVE_DECIMALS, 'USDC'),
      counterparty: transaction.from,
      protocol: null,
    }
  }

  if (movements.length === 1) {
    const movement = movements[0]
    if (
      (recipient === movement.key && ERC20_TRANSFER_SELECTORS.has(selector))
      || (transaction.tokenOnly === true && !movement.outgoing)
    ) {
      return {
        id: transaction.hash,
        txHash: transaction.hash,
        type: movement.outgoing ? 'send' : 'receive',
        title: humanize(movement.outgoing ? 'send' : 'receive'),
        amount: formatAmount(movement.value, movement.decimals, movement.symbol),
        counterparty: movement.outgoing ? transaction.to : transaction.from,
        protocol: null,
      }
    }
  }

  const hasIncoming = movements.some((movement) => !movement.outgoing)
  const hasOutgoing = movements.some((movement) => movement.outgoing)
  if (
    hasIncoming
    && hasOutgoing
    && new Set(movements.map((movement) => movement.key)).size > 1
    && SWAP_SELECTORS.has(selector)
  ) {
    return {
      id: transaction.hash,
      txHash: transaction.hash,
      type: 'swap',
      title: humanize('swap'),
      amount: null,
      counterparty: transaction.to,
      protocol: null,
    }
  }

  return {
    id: transaction.hash,
    txHash: transaction.hash,
    type: 'interaction',
    title: humanize('interaction', undefined, vault),
    amount: null,
    counterparty: transaction.to,
    protocol: vault ?? null,
  }
}

export function normalizeWalletActivity(
  walletAddress: string,
  response: WalletActivityResponse,
): WalletActivity[] {
  const wallet = walletAddress.toLowerCase()
  const transfersByHash = new Map<string, TokenTransfer[]>()
  for (const transfer of response.tokenTransfers) {
    const hash = transfer.hash.toLowerCase()
    transfersByHash.set(hash, [...(transfersByHash.get(hash) ?? []), transfer])
  }

  const rows = new Map<string, Transaction>()
  for (const transaction of response.transactions) rows.set(transaction.hash.toLowerCase(), transaction)
  for (const transfer of response.tokenTransfers) {
    const hash = transfer.hash.toLowerCase()
    if (!rows.has(hash)) {
      rows.set(hash, {
        hash: transfer.hash,
        timeStamp: null,
        from: transfer.from,
        to: transfer.to,
        value: '0',
        input: '0x',
        isError: '',
        receiptStatus: '',
        tokenOnly: true,
      })
    }
  }

  return [...rows.values()]
    .map((transaction) => {
      const base = classify(wallet, transaction, transfersByHash.get(transaction.hash.toLowerCase()) ?? [])
      const timestamp = Number(transaction.timeStamp)
      return {
        ...base,
        timestamp: Number.isFinite(timestamp) && timestamp > 0 ? timestamp * 1000 : null,
        status: statusFor(transaction),
      }
    })
    .sort((a, b) => (b.timestamp ?? 0) - (a.timestamp ?? 0))
    .slice(0, response.limit)
}

export async function fetchMainnetWalletActivity(
  address: string,
  signal?: AbortSignal,
): Promise<WalletActivityResponse> {
  const params = new URLSearchParams({ address, limit: '30' })
  const response = await fetch(`/api/arc-wallet-activity?${params}`, {
    headers: { accept: 'application/json' },
    signal,
  })
  const payload = await response.json().catch(() => null)
  if (!response.ok || !Array.isArray(payload?.transactions) || !Array.isArray(payload?.tokenTransfers)) {
    throw new Error(typeof payload?.error === 'string' ? payload.error : 'Wallet activity is unavailable')
  }
  return payload as WalletActivityResponse
}

export function shortWalletAddress(value: string) {
  return `${value.slice(0, 6)}…${value.slice(-4)}`
}
