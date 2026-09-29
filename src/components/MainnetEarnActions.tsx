import { useCallback, useEffect, useState } from 'react'
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
  MAINNET_EARN_CHAIN,
  MAINNET_EARN_SELECTED_VAULT_ADDRESSES,
} from '../config/mainnetEarn'
import { ARC_MAINNET_EVM_CHAIN_ID } from '../lib/chains'
import { MAINNET_NETWORKS } from '../config/mainnetNetworks'

type EarnPosition = {
  currentBalance?: string
  shares?: string
  vaultName?: string
}

type EarnReviewedAction = {
  kind: 'deposit' | 'withdraw'
  vaultAddress: string
  amount: string
  account?: string
  quote: unknown
}

type EarnWriteResult = {
  txHash?: string
  explorerUrl?: string
  amount?: string
}

type EarnActivityItem = {
  kind: 'deposit' | 'withdraw'
  amount: string
  txHash: string
  explorerUrl: string
}

const ERC20_BALANCE_ABI = parseAbi([
  'function balanceOf(address account) view returns (uint256)',
])

const earnKit = new EarnKit()
const DEFAULT_AMOUNT = '0.1'
const GALAXY_ADDRESS = '0x8E357432CC12ff425c36432F312968aEb16112AF'

function shortAddress(value?: string) {
  if (!value) return ''
  if (value.length <= 12) return value
  return value.slice(0, 6) + '...' + value.slice(-4)
}

function vaultName(address: string) {
  if (address.toLowerCase() === GALAXY_ADDRESS.toLowerCase()) {
    return 'Galaxy USDC'
  }

  return 'Gauntlet USDC Prime'
}

function validateAmount(value: string) {
  if (!/^\d*\.?\d{0,6}$/.test(value)) return null

  const numericAmount = Number(value)
  if (!Number.isFinite(numericAmount) || numericAmount <= 0) {
    return null
  }

  return value
}

function isAllowedVault(address: string) {
  return MAINNET_EARN_SELECTED_VAULT_ADDRESSES.some(
    (vaultAddress) => vaultAddress.toLowerCase() === address.toLowerCase(),
  )
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
  const [activity, setActivity] = useState<EarnActivityItem[]>([])

  const loadWalletBalance = useCallback(async () => {
    if (!address) {
      setWalletBalance(null)
      return
    }

    setWalletBalanceLoading(true)

    try {
      const network = MAINNET_NETWORKS.arc
      const client = createPublicClient({
        transport: http(network.rpcUrls[0], {
          timeout: 10_000,
          retryCount: 0,
        }),
      })

      const raw = await client.readContract({
        address: network.usdcAddress,
        abi: ERC20_BALANCE_ABI,
        functionName: 'balanceOf',
        args: [address],
      })

      const formatted = formatUnits(raw, 6)
      setWalletBalance(formatted)
      return formatted
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

  const addActivity = useCallback((
    kind: 'deposit' | 'withdraw',
    amount: string,
    result: EarnWriteResult,
  ) => {
    if (!result.txHash) return

    if (!/^0x[a-fA-F0-9]{64}$/.test(result.txHash)) return

    const explorerBase = MAINNET_NETWORKS.arc.explorerUrl?.replace(/\/$/, '')
    if (!explorerBase) return

    const explorerUrl = explorerBase + '/tx/' + result.txHash

    setActivity((current) => [
      {
        kind,
        amount,
        txHash: result.txHash as string,
        explorerUrl,
      },
      ...current,
    ])
  }, [])

  const getAdapter = useCallback(async () => {
    if (!connector || !isConnected) {
      throw new Error('Connect your wallet first.')
    }

    if (chainId !== ARC_MAINNET_EVM_CHAIN_ID) {
      await switchChainAsync({ chainId: ARC_MAINNET_EVM_CHAIN_ID })
    }

    const provider = await connector.getProvider() as EIP1193Provider
    return createViemAdapterFromProvider({ provider })
  }, [chainId, connector, isConnected, switchChainAsync])

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

  const reviewDeposit = useCallback(async () => {
    setBusy('depositQuote')
    setError(null)
    try {
      const validatedAmount = validateAmount(amount)
      if (!validatedAmount) {
        throw new Error('Enter a valid USDC amount using up to 6 decimal places.')
      }

      if (!isAllowedVault(selectedVault)) {
        throw new Error('This vault is not enabled for Machina Earn.')
      }

      const currentWalletBalance = await loadWalletBalance()

      if (
        currentWalletBalance != null
        && Number.isFinite(Number(currentWalletBalance))
        && Number(validatedAmount) > Number(currentWalletBalance)
      ) {
        throw new Error('Amount exceeds your Arc USDC balance.')
      }

      const adapter = await getAdapter()
      const quote = await earnKit.getDepositQuote({
        from: { adapter, chain: MAINNET_EARN_CHAIN },
        vaultAddress: selectedVault,
        amount: validatedAmount,
      } as never)

      setReviewed({
        kind: 'deposit',
        vaultAddress: selectedVault,
        amount: validatedAmount,
        account: address,
        quote,
      })
    } catch (cause) {
      setReviewed(null)
      setError(cause instanceof Error ? cause.message : 'Deposit quote failed.')
    } finally {
      setBusy(null)
    }
  }, [address, amount, getAdapter, loadWalletBalance, selectedVault])

  const executeDeposit = useCallback(async () => {
    if (
      !reviewed
      || reviewed.kind !== 'deposit'
      || reviewed.vaultAddress !== selectedVault
      || reviewed.account !== address
    ) {
      setError('Review the current deposit quote first.')
      return
    }

    setBusy('deposit')
    setError(null)

    try {
      if (!isAllowedVault(selectedVault)) {
        throw new Error('This vault is not enabled for Machina Earn.')
      }

      const currentWalletBalance = await loadWalletBalance()
      if (
        currentWalletBalance == null
        || !Number.isFinite(Number(currentWalletBalance))
        || Number(reviewed.amount) > Number(currentWalletBalance)
      ) {
        throw new Error('Your Arc USDC balance changed. Review the deposit again.')
      }

      const adapter = await getAdapter()
      const nextResult = await earnKit.deposit({
        from: { adapter, chain: MAINNET_EARN_CHAIN },
        vaultAddress: selectedVault,
        amount: reviewed.amount,
      } as never) as unknown as EarnWriteResult

      addActivity('deposit', reviewed.amount, nextResult)
      setReviewed(null)
      await Promise.all([
        readPosition(),
        loadWalletBalance(),
      ])
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Deposit failed.')
    } finally {
      setBusy(null)
    }
  }, [
    addActivity,
    address,
    getAdapter,
    loadWalletBalance,
    readPosition,
    reviewed,
    selectedVault,
  ])

  const checkPosition = useCallback(async () => {
    setBusy('position')
    setError(null)

    try {
      await readPosition()
    } catch (cause) {
      setPosition(null)
      setError(cause instanceof Error ? cause.message : 'Position check failed.')
    } finally {
      setBusy(null)
    }
  }, [readPosition])

  const reviewWithdrawal = useCallback(async () => {
    setBusy('withdrawQuote')
    setError(null)
    try {
      const requestedAmount = validateAmount(amount)
      if (!requestedAmount) {
        throw new Error('Enter a valid USDC amount using up to 6 decimal places.')
      }

      if (!isAllowedVault(selectedVault)) {
        throw new Error('This vault is not enabled for Machina Earn.')
      }

      const currentPosition = await readPosition()
      const positionBalance = Number(currentPosition.currentBalance ?? '0')

      if (!Number.isFinite(positionBalance) || positionBalance <= 0) {
        throw new Error('No position is available to withdraw.')
      }

      if (Number(requestedAmount) > positionBalance) {
        throw new Error('Amount exceeds your current vault position.')
      }

      const validatedAmount = requestedAmount

      const adapter = await getAdapter()
      const quote = await earnKit.getWithdrawalQuote({
        from: { adapter, chain: MAINNET_EARN_CHAIN },
        vaultAddress: selectedVault,
        amount: validatedAmount,
      } as never)

      setReviewed({
        kind: 'withdraw',
        vaultAddress: selectedVault,
        amount: validatedAmount,
        account: address,
        quote,
      })
    } catch (cause) {
      setReviewed(null)
      setError(cause instanceof Error ? cause.message : 'Withdrawal quote failed.')
    } finally {
      setBusy(null)
    }
  }, [address, amount, getAdapter, readPosition, selectedVault])

  const executeWithdrawal = useCallback(async () => {
    if (
      !reviewed
      || reviewed.kind !== 'withdraw'
      || reviewed.vaultAddress !== selectedVault
      || reviewed.account !== address
    ) {
      setError('Review the current withdrawal quote first.')
      return
    }

    setBusy('withdraw')
    setError(null)

    try {
      if (!isAllowedVault(selectedVault)) {
        throw new Error('This vault is not enabled for Machina Earn.')
      }

      const freshPosition = await readPosition()
      const freshBalance = Number(freshPosition.currentBalance ?? '0')
      if (
        !Number.isFinite(freshBalance)
        || freshBalance <= 0
        || Number(reviewed.amount) > freshBalance
      ) {
        throw new Error('Your vault position changed. Review the withdrawal again.')
      }

      const adapter = await getAdapter()
      const nextResult = await earnKit.withdraw({
        from: { adapter, chain: MAINNET_EARN_CHAIN },
        vaultAddress: selectedVault,
        amount: reviewed.amount,
      } as never) as unknown as EarnWriteResult

      addActivity('withdraw', reviewed.amount, nextResult)
      setReviewed(null)
      await Promise.all([
        readPosition(),
        loadWalletBalance(),
      ])
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Withdrawal failed.')
    } finally {
      setBusy(null)
    }
  }, [
    addActivity,
    address,
    getAdapter,
    loadWalletBalance,
    readPosition,
    reviewed,
    selectedVault,
  ])

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
                {vaultName(vaultAddress)}
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
          onClick={() => void reviewDeposit()}
          disabled={!isConnected || busy !== null}
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
          onClick={() => void reviewWithdrawal()}
          disabled={!isConnected || busy !== null}
          className="rounded-xl border border-sky-200 bg-white px-3 py-2 text-xs font-semibold text-sky-900 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {busy === 'withdrawQuote' ? 'Checking quote...' : 'Review withdrawal'}
        </button>
      </div>

      {reviewed && (
        <div className="mt-4 rounded-xl border border-sky-200 bg-white p-3">
          <p className="text-xs font-semibold text-slate-900">
            {reviewed.kind === 'deposit' ? 'Deposit ' : 'Withdraw '}
            {reviewed.amount} USDC
            {reviewed.kind === 'deposit' ? ' into ' : ' from '}
            {vaultName(reviewed.vaultAddress)}
          </p>
          <p className="mt-1 text-[11px] leading-5 text-slate-500">
            Quote received. Your wallet will show the transaction and network fee before you sign.
          </p>
          <button
            type="button"
            onClick={() => void (
              reviewed.kind === 'deposit'
                ? executeDeposit()
                : executeWithdrawal()
            )}
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
              key={item.txHash}
              href={item.explorerUrl}
              target="_blank"
              rel="noreferrer"
              className="flex items-center justify-between rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-900 hover:bg-emerald-100"
            >
              <span>
                {item.kind === 'deposit' ? 'Deposit' : 'Withdrawal'} {item.amount} USDC confirmed
              </span>
              <span className="font-mono">{shortAddress(item.txHash)}</span>
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
