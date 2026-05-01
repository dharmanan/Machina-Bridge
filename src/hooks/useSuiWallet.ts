import { useCallback, useMemo } from 'react'
import {
  useConnectWallet,
  useCurrentAccount,
  useCurrentWallet,
  useDisconnectWallet,
  useWallets,
  useSuiClientQuery,
} from '@mysten/dapp-kit'

const SUI_TESTNET_USDC_COIN_TYPE =
  '0xa1ec7fc00a6f40db9693ad1415d0c193ad3906494428cf252621037bd7117e29::usdc::USDC'

function normalizeWalletName(name: string) {
  return name.trim().toLowerCase()
}

function pickDefaultWalletName(walletNames: string[]) {
  const slush = walletNames.find((name) => normalizeWalletName(name).includes('slush'))
  if (slush) {
    return slush
  }

  return walletNames[0] ?? null
}

export function useSuiWallet() {
  const wallets = useWallets()
  const currentAccount = useCurrentAccount()
  const currentWalletState = useCurrentWallet()
  const connectWallet = useConnectWallet()
  const disconnectWallet = useDisconnectWallet()

  const walletNames = useMemo(() => wallets.map((wallet) => wallet.name), [wallets])
  const defaultWalletName = useMemo(() => pickDefaultWalletName(walletNames), [walletNames])

  const suiAddress = currentAccount?.address ?? null

  const { data: allBalancesData, isPending: isLoadingBalance, refetch: refetchBalance } = useSuiClientQuery(
    'getAllBalances',
    { owner: suiAddress ?? '' },
    { enabled: Boolean(suiAddress), gcTime: 30_000, staleTime: 10_000 },
  )

  const usdcBalanceRaw = useMemo(() => {
    if (!allBalancesData) return null
    const entry = allBalancesData.find(
      (b) => b.coinType === SUI_TESTNET_USDC_COIN_TYPE,
    )
    return entry ? entry.totalBalance : null
  }, [allBalancesData])

  const usdcBalance = usdcBalanceRaw !== null
    ? (Number(usdcBalanceRaw) / 1_000_000).toFixed(6)
    : null

  const connect = useCallback(
    async (walletName?: string | null) => {
      const targetName = walletName?.trim() || defaultWalletName || ''
      const targetWallet =
        wallets.find((wallet) => normalizeWalletName(wallet.name) === normalizeWalletName(targetName)) ??
        wallets.find((wallet) => normalizeWalletName(wallet.name).includes('slush')) ??
        wallets[0]

      if (!targetWallet) {
        throw new Error('No Sui wallet was detected in this browser session.')
      }

      await connectWallet.mutateAsync({ wallet: targetWallet })
      return targetWallet.name
    },
    [connectWallet, defaultWalletName, wallets],
  )

  const disconnect = useCallback(async () => {
    if (!currentWalletState.isConnected) {
      return
    }

    await disconnectWallet.mutateAsync()
  }, [currentWalletState.isConnected, disconnectWallet])

  return {
    address: suiAddress,
    connect,
    currentWalletName: currentWalletState.currentWallet?.name ?? null,
    defaultWalletName,
    disconnect,
    error: connectWallet.error?.message ?? disconnectWallet.error?.message ?? null,
    isConnected: currentWalletState.isConnected,
    isConnecting: currentWalletState.isConnecting || connectWallet.isPending,
    isLoadingBalance,
    isWalletAvailable: wallets.length > 0,
    refetchBalance,
    usdcBalance,
    walletNames,
  }
}
