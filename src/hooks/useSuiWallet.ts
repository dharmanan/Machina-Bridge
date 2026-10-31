import { useCallback, useEffect, useMemo } from 'react'
import {
  useConnectWallet,
  useCurrentAccount,
  useCurrentWallet,
  useDisconnectWallet,
  useWallets,
  useSuiClientContext,
} from '@mysten/dapp-kit'
import { useQuery } from '@tanstack/react-query'
import { SuiGrpcClient } from '@mysten/sui/grpc'
import { SUI_NETWORKS, type SuiNetwork } from '../config/sui'
import { readSuiWalletBalances, validateSuiWalletAccount } from '../lib/suiBalances'

const SLUSH_WEB_WALLET_ID = 'com.mystenlabs.suiwallet.web'

const suiClients = {
  mainnet: new SuiGrpcClient({ network: 'mainnet', baseUrl: SUI_NETWORKS.mainnet.url, timeout: 10_000 }),
  testnet: new SuiGrpcClient({ network: 'testnet', baseUrl: SUI_NETWORKS.testnet.url, timeout: 10_000 }),
}

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

export function useSuiWallet(requestedNetwork?: SuiNetwork) {
  const context = useSuiClientContext()
  const network: SuiNetwork = requestedNetwork ?? (context.network === 'mainnet' ? 'mainnet' : 'testnet')
  useEffect(() => { if (context.network !== network) context.selectNetwork(network) }, [context, network])
  const wallets = useWallets()
  const currentAccount = useCurrentAccount()
  const currentWalletState = useCurrentWallet()
  const connectWallet = useConnectWallet()
  const disconnectWallet = useDisconnectWallet()

  const walletNames = useMemo(() => wallets.map((wallet) => wallet.name), [wallets])
  const defaultWalletName = useMemo(() => pickDefaultWalletName(walletNames), [walletNames])

  const suiAddress = currentAccount?.address ?? null

  let accountError: string | null = null
  try { if (currentAccount) validateSuiWalletAccount(currentAccount, network) } catch (e) { accountError = e instanceof Error ? e.message : 'Unsupported Sui wallet account.' }
  const { data: balances, isFetching: isLoadingBalance, refetch: refetchBalance, error: balanceError } = useQuery({
    queryKey: ['machina-sui-balances', network, suiAddress],
    queryFn: ({ signal }) => readSuiWalletBalances(suiClients[network].core, suiAddress!, network, signal),
    enabled: Boolean(suiAddress) && !accountError,
    gcTime: 30_000, staleTime: 10_000, retry: false,
  })
  const usdcBalance = !accountError && !balanceError ? balances?.usdcDisplay ?? null : null

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
    // A Sui wallet injected through the Wallet Standard (Slush app browser, extension), as opposed to
    // the Slush web wallet popup that dApp Kit registers itself (id com.mystenlabs.suiwallet.web).
    hasInjectedWallet: wallets.some((wallet) => (wallet as { id?: string }).id !== SLUSH_WEB_WALLET_ID),
    network,
    walletSupportsNetwork: Boolean(suiAddress) && !accountError,
    balanceError: accountError ?? (balanceError ? 'Sui balance or network verification is unavailable. No transfer is allowed.' : null),
    suiBalance: !accountError && !balanceError ? balances?.suiDisplay ?? null : null,
    balances: !accountError && !balanceError ? balances ?? null : null,
    refetchBalance,
    usdcBalance,
    walletNames,
  }
}
