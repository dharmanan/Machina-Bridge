import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useAccount, useSwitchChain } from 'wagmi'
import {
  createPublicClient,
  formatUnits,
  http,
  parseAbi,
  type EIP1193Provider,
} from 'viem'
import { EarnKit } from '@circle-fin/earn-kit'
import { createViemAdapterFromProvider } from '@circle-fin/adapter-viem-v2'
import {
  getMainnetEarnVaultLabel,
  MAINNET_EARN_CHAIN,
  MAINNET_EARN_SELECTED_VAULT_ADDRESSES,
} from '../config/mainnetEarn'
import { ARC_MAINNET_EVM_CHAIN_ID } from '../lib/chains'
import { MAINNET_NETWORKS } from '../config/mainnetNetworks'
import {
  EARN_JOURNAL_KEY,
  floorUsdcRaw,
  openEarnRecordFor,
  parseUsdcInput,
  runEarnOperation,
  settledEarnRecordsFor,
  settleEarnRecord,
  type EarnAction,
  type EarnJournalRecord,
  type EarnKitLike,
} from '../lib/earnJournal'

type EarnPosition = {
  currentBalance?: string
  shares?: string
  vaultName?: string
}

// A review is bound to everything the wallet request will use; any change drops it.
type EarnReviewedAction = {
  kind: EarnAction
  vaultAddress: string
  amount: string
  amountRaw: bigint
  account: string
  chainId: number
  reviewedAt: number
  quote: unknown
}

const ERC20_BALANCE_ABI = parseAbi([
  'function balanceOf(address account) view returns (uint256)',
])

const earnKit = new EarnKit()
const DEFAULT_AMOUNT = '0.1'
const REVIEW_TTL_MS = 120_000
const EXPLORER_BASE = MAINNET_NETWORKS.arc.explorerUrl?.replace(/\/$/, '')

function shortAddress(value?: string) {
  if (!value) return ''
  if (value.length <= 12) return value
  return value.slice(0, 6) + '...' + value.slice(-4)
}

function isAllowedVault(address: string) {
  return MAINNET_EARN_SELECTED_VAULT_ADDRESSES.some(
    (vaultAddress) => vaultAddress.toLowerCase() === address.toLowerCase(),
  )
}

function arcClient() {
  return createPublicClient({
    transport: http(MAINNET_NETWORKS.arc.rpcUrls[0], {
      timeout: 10_000,
      retryCount: 0,
    }),
  })
}

function messageOf(cause: unknown, fallback: string) {
  return cause instanceof Error && cause.message ? cause.message : fallback
}

// One Earn operation per wallet across every tab of this browser.
async function withWalletLock<T>(account: string, run: () => Promise<T>) {
  if (typeof navigator === 'undefined' || !navigator.locks) {
    throw new Error('This browser cannot coordinate Earn transactions across tabs. Use a browser with Web Locks support.')
  }
  return navigator.locks.request('machina-earn:' + account.toLowerCase(), { ifAvailable: true }, async (lock) => {
    if (!lock) throw new Error('Another tab is running an Earn operation for this wallet. Check again when it finishes.')
    return run()
  })
}

export default function MainnetEarnActions() {
  const {
    address,
    chainId,
    connector,
    isConnected,
  } = useAccount()
  const { switchChainAsync } = useSwitchChain()

  const [selectedVault, setSelectedVault] = useState<string>(
    MAINNET_EARN_SELECTED_VAULT_ADDRESSES[0],
  )
  const [amount, setAmount] = useState(DEFAULT_AMOUNT)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [reviewed, setReviewed] = useState<EarnReviewedAction | null>(null)
  const [position, setPosition] = useState<EarnPosition | null>(null)
  const [walletBalance, setWalletBalance] = useState<string | null>(null)
  const [walletBalanceLoading, setWalletBalanceLoading] = useState(false)
  const [journalVersion, setJournalVersion] = useState(0)
  const inFlight = useRef(false)

  const refreshJournal = useCallback(() => setJournalVersion((v) => v + 1), [])
  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key === null || event.key === EARN_JOURNAL_KEY) refreshJournal()
    }
    window.addEventListener('storage', onStorage)
    return () => window.removeEventListener('storage', onStorage)
  }, [refreshJournal])

  const openRecord = useMemo(() => openEarnRecordFor(address), [address, journalVersion])
  const activity = useMemo(() => settledEarnRecordsFor(address).slice(0, 5), [address, journalVersion])

  // A wallet or network change drops the review.
  useEffect(() => {
    setReviewed((current) => current && (
      current.account !== address?.toLowerCase()
      || chainId !== ARC_MAINNET_EVM_CHAIN_ID
    ) ? null : current)
  }, [address, chainId])

  const loadWalletBalance = useCallback(async () => {
    if (!address) {
      setWalletBalance(null)
      return null
    }

    setWalletBalanceLoading(true)

    try {
      const network = MAINNET_NETWORKS.arc
      const raw = await arcClient().readContract({
        address: network.usdcAddress,
        abi: ERC20_BALANCE_ABI,
        functionName: 'balanceOf',
        args: [address],
      })

      setWalletBalance(formatUnits(raw, 6))
      return raw
    } catch {
      setWalletBalance(null)
      return null
    } finally {
      setWalletBalanceLoading(false)
    }
  }, [address])

  useEffect(() => {
    if (address) {
      void loadWalletBalance()
    }
  }, [address, loadWalletBalance])

  const getWalletProvider = useCallback(async () => {
    if (!connector || !isConnected) {
      throw new Error('Connect your wallet first.')
    }

    if (chainId !== ARC_MAINNET_EVM_CHAIN_ID) {
      await switchChainAsync({ chainId: ARC_MAINNET_EVM_CHAIN_ID })
    }

    return await connector.getProvider() as EIP1193Provider
  }, [chainId, connector, isConnected, switchChainAsync])

  // Read-only SDK calls (quotes, position) use the wallet provider directly.
  const getAdapter = useCallback(async () => (
    createViemAdapterFromProvider({ provider: await getWalletProvider() })
  ), [getWalletProvider])

  const readPosition = useCallback(async () => {
    const adapter = await getAdapter()

    const nextPosition = await earnKit.getPosition({
      from: { adapter, chain: MAINNET_EARN_CHAIN },
      vaultAddress: selectedVault,
    } as never) as unknown as EarnPosition

    setPosition(nextPosition)
    return nextPosition
  }, [getAdapter, selectedVault])

  useEffect(() => {
    if (!isConnected || !address || !connector) {
      setPosition(null)
      return
    }

    if (chainId !== ARC_MAINNET_EVM_CHAIN_ID) {
      setPosition(null)
      return
    }

    let cancelled = false

    void readPosition()
      .then((nextPosition) => {
        if (!cancelled) {
          setPosition(nextPosition)
        }
      })
      .catch(() => {
        if (!cancelled) {
          setPosition(null)
        }
      })

    return () => {
      cancelled = true
    }
  }, [
    address,
    chainId,
    connector,
    isConnected,
    readPosition,
    selectedVault,
  ])

  const review = useCallback(async (kind: EarnAction) => {
    if (inFlight.current) return
    setBusy(kind === 'deposit' ? 'depositQuote' : 'withdrawQuote')
    setError(null)
    try {
      const amountRaw = parseUsdcInput(amount)
      if (amountRaw === null || !address) {
        throw new Error('Enter a valid USDC amount using up to 6 decimal places.')
      }

      if (!isAllowedVault(selectedVault)) {
        throw new Error('This vault is not enabled for Machina Earn.')
      }

      if (openEarnRecordFor(address)) {
        throw new Error('An earlier Earn operation from this wallet is not confirmed yet. Check its status first.')
      }

      if (kind === 'deposit') {
        const balanceRaw = await loadWalletBalance()
        if (balanceRaw != null && amountRaw > balanceRaw) {
          throw new Error('Amount exceeds your Arc USDC balance.')
        }
      } else {
        const positionRaw = floorUsdcRaw((await readPosition()).currentBalance ?? '0')
        if (positionRaw === null || positionRaw <= 0n) {
          throw new Error('No position is available to withdraw.')
        }
        if (amountRaw > positionRaw) {
          throw new Error('Amount exceeds your current vault position.')
        }
      }

      const adapter = await getAdapter()
      const quoteParams = {
        from: { adapter, chain: MAINNET_EARN_CHAIN },
        vaultAddress: selectedVault,
        amount,
      }
      const quote = kind === 'deposit'
        ? await earnKit.getDepositQuote(quoteParams as never)
        : await earnKit.getWithdrawalQuote(quoteParams as never)

      setReviewed({
        kind,
        vaultAddress: selectedVault,
        amount,
        amountRaw,
        account: address.toLowerCase(),
        chainId: ARC_MAINNET_EVM_CHAIN_ID,
        reviewedAt: Date.now(),
        quote,
      })
    } catch (cause) {
      setReviewed(null)
      setError(messageOf(cause, kind === 'deposit' ? 'Deposit quote failed.' : 'Withdrawal quote failed.'))
    } finally {
      setBusy(null)
    }
  }, [address, amount, getAdapter, loadWalletBalance, readPosition, selectedVault])

  const reportSettled = useCallback((record: EarnJournalRecord, sdkError: unknown) => {
    if (record.outcome === 'success') {
      setError(null)
    } else if (record.outcome === 'reverted') {
      setError(record.lastError ?? 'The transaction reverted on chain. No funds moved.')
    } else if (record.outcome === 'not_sent') {
      setError(record.lastError ?? messageOf(sdkError, 'The operation stopped before anything was sent.'))
    }
  }, [])

  const execute = useCallback(async () => {
    if (inFlight.current) return
    const current = reviewed
    if (
      !current
      || !address
      || current.account !== address.toLowerCase()
      || current.vaultAddress !== selectedVault
      || current.amount !== amount
    ) {
      setReviewed(null)
      setError('Review the current quote first.')
      return
    }
    if (chainId !== ARC_MAINNET_EVM_CHAIN_ID || Date.now() - current.reviewedAt > REVIEW_TTL_MS) {
      setReviewed(null)
      setError('The quote expired or the network changed. Review it again.')
      return
    }

    inFlight.current = true
    setBusy(current.kind)
    setError(null)

    try {
      await withWalletLock(address, async () => {
        if (openEarnRecordFor(address)) {
          throw new Error('An earlier Earn operation from this wallet is not confirmed yet. Check its status first.')
        }
        if (!isAllowedVault(current.vaultAddress)) {
          throw new Error('This vault is not enabled for Machina Earn.')
        }

        if (current.kind === 'deposit') {
          const balanceRaw = await loadWalletBalance()
          if (balanceRaw == null || current.amountRaw > balanceRaw) {
            throw new Error('Your Arc USDC balance changed. Review the deposit again.')
          }
        } else {
          const positionRaw = floorUsdcRaw((await readPosition()).currentBalance ?? '0')
          if (positionRaw === null || current.amountRaw > positionRaw) {
            throw new Error('Your vault position changed. Review the withdrawal again.')
          }
        }

        const walletProvider = await getWalletProvider()
        // Attempt evidence, journal entry (written and read back before any wallet
        // request), guarded provider, the SDK call and the settled outcome.
        const { record: settled, sdkError } = await runEarnOperation({
          kit: earnKit as unknown as EarnKitLike,
          walletProvider: walletProvider as never,
          client: arcClient(),
          createAdapter: async (provider) => createViemAdapterFromProvider({ provider: provider as unknown as EIP1193Provider }),
          chain: MAINNET_EARN_CHAIN,
          account: address,
          vault: current.vaultAddress,
          action: current.kind,
          amount: current.amount,
          amountRaw: current.amountRaw,
          onRecorded: () => {
            refreshJournal()
            setReviewed(null)
          },
        })
        reportSettled(settled, sdkError)
        if (settled.outcome === 'success') {
          await Promise.allSettled([readPosition(), loadWalletBalance()])
        }
      })
    } catch (cause) {
      setError(messageOf(cause, current.kind === 'deposit' ? 'Deposit failed.' : 'Withdrawal failed.'))
    } finally {
      inFlight.current = false
      setBusy(null)
      refreshJournal()
    }
  }, [
    address,
    amount,
    chainId,
    getWalletProvider,
    loadWalletBalance,
    readPosition,
    refreshJournal,
    reportSettled,
    reviewed,
    selectedVault,
  ])

  // Read-only: settles an open operation only from chain evidence.
  const checkStatus = useCallback(async () => {
    if (inFlight.current || !address) return
    inFlight.current = true
    setBusy('status')
    setError(null)
    try {
      await withWalletLock(address, async () => {
        const open = openEarnRecordFor(address)
        if (!open) return
        const settled = await settleEarnRecord(open.id, arcClient())
        reportSettled(settled, undefined)
        if (settled.outcome === 'success') {
          await Promise.allSettled([readPosition(), loadWalletBalance()])
        }
      })
    } catch (cause) {
      setError(messageOf(cause, 'Status check failed.'))
    } finally {
      inFlight.current = false
      setBusy(null)
      refreshJournal()
    }
  }, [address, loadWalletBalance, readPosition, refreshJournal, reportSettled])

  const checkPosition = useCallback(async () => {
    setBusy('position')
    setError(null)

    try {
      await readPosition()
    } catch (cause) {
      setPosition(null)
      setError(messageOf(cause, 'Position check failed.'))
    } finally {
      setBusy(null)
    }
  }, [readPosition])

  const locked = busy !== null || Boolean(openRecord)

  return (
    <div className="mt-5 rounded-2xl border border-slate-200 bg-slate-50 p-4">
      <div>
        <p className="text-sm font-semibold text-slate-900">Manage position</p>
        <p className="mt-1 text-xs leading-5 text-slate-500">
          Choose a vault and amount, review the quote, then confirm the transaction in your wallet.
        </p>
      </div>

      <div className="mt-4 grid gap-3 sm:grid-cols-3">
        <label className="text-xs font-medium text-slate-600">
          Vault
          <select
            value={selectedVault}
            onChange={(event) => {
              setSelectedVault(event.target.value)
              setReviewed(null)
              setPosition(null)
              setError(null)
            }}
            className="mt-1 h-10 w-full rounded-xl border border-slate-200 bg-white px-3 text-sm text-slate-900"
          >
            {MAINNET_EARN_SELECTED_VAULT_ADDRESSES.map((vaultAddress) => (
              <option key={vaultAddress} value={vaultAddress}>
                {getMainnetEarnVaultLabel(vaultAddress)}
              </option>
            ))}
          </select>
        </label>

        <label className="text-xs font-medium text-slate-600">
          Amount
          <div className="mt-1 flex h-10 items-center rounded-xl border border-slate-200 bg-white px-3">
            <input
              type="text"
              inputMode="decimal"
              value={amount}
              onChange={(event) => {
                setAmount(event.target.value)
                setReviewed(null)
                setError(null)
              }}
              className="min-w-0 flex-1 bg-transparent text-sm text-slate-900 outline-none"
              aria-label="Earn amount"
            />
            <span className="ml-2 text-xs font-semibold text-slate-500">USDC</span>
          </div>
        </label>

        <div className="rounded-xl border border-sky-100 bg-white px-3 py-2">
          <p className="text-[11px] text-slate-500">Wallet</p>
          <p className="mt-1 text-sm font-semibold text-slate-900">
            {isConnected && address ? shortAddress(address) : 'Connect wallet above'}
          </p>
          <p className="mt-0.5 text-[11px] text-slate-500">
            {chainId === ARC_MAINNET_EVM_CHAIN_ID ? 'Arc Mainnet' : 'Arc Mainnet required'}
          </p>
          <p className="mt-1 text-[11px] text-slate-500">
            Balance:{' '}
            <span className="font-semibold text-slate-700">
              {walletBalanceLoading
                ? 'Loading...'
                : walletBalance == null
                  ? 'Unavailable'
                  : walletBalance + ' USDC'}
            </span>
          </p>
        </div>
      </div>

      <div className="mt-4 grid gap-2 sm:grid-cols-3">
        <button
          type="button"
          onClick={() => void review('deposit')}
          disabled={!isConnected || locked}
          className="rounded-xl border border-sky-200 bg-white px-3 py-2 text-xs font-semibold text-sky-900 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {busy === 'depositQuote'
            ? 'Checking quote...'
            : 'Review ' + (amount || '0') + ' USDC deposit'}
        </button>

        <button
          type="button"
          onClick={() => void checkPosition()}
          disabled={!isConnected || busy !== null}
          className="rounded-xl border border-sky-200 bg-white px-3 py-2 text-xs font-semibold text-sky-900 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {busy === 'position' ? 'Checking position...' : 'Refresh position'}
        </button>

        <button
          type="button"
          onClick={() => void review('withdraw')}
          disabled={!isConnected || locked}
          className="rounded-xl border border-sky-200 bg-white px-3 py-2 text-xs font-semibold text-sky-900 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {busy === 'withdrawQuote' ? 'Checking quote...' : 'Review withdrawal'}
        </button>
      </div>

      {openRecord && (
        <div
          data-testid="earn-pending"
          className="mt-4 rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900"
        >
          <p className="font-semibold">
            {openRecord.action === 'deposit' ? 'Deposit ' : 'Withdrawal '}
            {openRecord.amount} USDC
            {openRecord.outcome === 'sending' ? ' is in progress' : ': result not confirmed yet'}
          </p>
          <p className="mt-1 leading-5">
            {openRecord.outcome === 'sending'
              ? 'Waiting for the wallet and the Arc network. '
              : (openRecord.lastError ? openRecord.lastError + ' ' : '')}
            New Earn operations stay locked for this wallet until the result is confirmed on chain. Do not send it again.
          </p>
          {openRecord.executeHash && (
            <p className="mt-1 break-all font-mono text-[11px]">
              {EXPLORER_BASE
                ? <a href={EXPLORER_BASE + '/tx/' + openRecord.executeHash} target="_blank" rel="noreferrer" className="underline">{openRecord.executeHash}</a>
                : openRecord.executeHash}
            </p>
          )}
          <button
            type="button"
            onClick={() => void checkStatus()}
            disabled={busy !== null}
            className="mt-2 rounded-xl border border-amber-300 bg-white px-3 py-1.5 text-xs font-semibold text-amber-900 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {busy === 'status' ? 'Checking...' : 'Check status'}
          </button>
        </div>
      )}

      {reviewed && !openRecord && (
        <div className="mt-4 rounded-xl border border-sky-200 bg-white p-3">
          <p className="text-xs font-semibold text-slate-900">
            {reviewed.kind === 'deposit' ? 'Deposit ' : 'Withdraw '}
            {reviewed.amount} USDC
            {reviewed.kind === 'deposit' ? ' into ' : ' from '}
            {getMainnetEarnVaultLabel(reviewed.vaultAddress)}
          </p>
          <p className="mt-1 text-[11px] leading-5 text-slate-500">
            Quote received. Your wallet will show the transaction and network fee before you sign.
          </p>
          <button
            type="button"
            onClick={() => void execute()}
            disabled={busy !== null}
            className="mt-3 rounded-xl bg-sky-700 px-4 py-2 text-xs font-semibold text-white disabled:cursor-not-allowed disabled:opacity-50"
          >
            {busy === 'deposit' || busy === 'withdraw'
              ? 'Waiting for wallet...'
              : reviewed.kind === 'deposit'
                ? 'Deposit ' + reviewed.amount + ' USDC'
                : 'Withdraw ' + reviewed.amount + ' USDC'}
          </button>
        </div>
      )}

      {position && (
        <div className="mt-3 rounded-xl border border-sky-100 bg-white px-3 py-2 text-xs text-slate-700">
          Current position: <span className="font-semibold">{position.currentBalance ?? '0'} USDC</span>
        </div>
      )}

      {activity.length > 0 && (
        <div className="mt-3 space-y-2">
          {activity.map((item) => (
            <a
              key={item.id}
              href={EXPLORER_BASE && item.executeHash ? EXPLORER_BASE + '/tx/' + item.executeHash : undefined}
              target="_blank"
              rel="noreferrer"
              className="flex items-center justify-between rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-900 hover:bg-emerald-100"
            >
              <span>
                {item.action === 'deposit' ? 'Deposit' : 'Withdrawal'} {item.amount} USDC confirmed
              </span>
              <span className="font-mono">{shortAddress(item.executeHash)}</span>
            </a>
          ))}
        </div>
      )}

      {error && (
        <div className="mt-3 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs leading-5 text-amber-900">
          {error}
        </div>
      )}
    </div>
  )
}
