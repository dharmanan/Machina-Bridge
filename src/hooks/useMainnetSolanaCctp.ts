import { useCallback, useMemo, useState } from 'react'
import { useAccount, useWalletClient } from 'wagmi'
import { BridgeKit } from '@circle-fin/bridge-kit'
import { createAdapterFromProvider as createEvmAdapterFromProvider } from '@circle-fin/adapter-viem-v2'
import { createSolanaAdapterFromProvider } from '@circle-fin/adapter-solana'
import { createPublicClient, formatUnits, http, parseAbi, parseUnits, type Hex } from 'viem'
import { ARC_MAINNET_EVM_CHAIN, ARC_MAINNET_EVM_CHAIN_ID, addChainToWallet } from '../lib/chains'
import { deriveSolanaUsdcAta } from '../lib/solana'

import {
  isMainnetSolanaCanaryWriteEnabled,
  MAINNET_SOLANA_CCTP_CANARY_MAX_AMOUNT_RAW,
  type MainnetSolanaCanaryDirection,
} from '../config/mainnetSolanaCanary'
import { MAINNET_SOLANA_CCTP_CANARY_ENABLED } from '../config/runtime'
import { MAINNET_NETWORKS } from '../config/mainnetNetworks'
import { fetchMainnetCctpAttestation } from '../lib/mainnetCctpTransfer'

type BridgeKitChain = ReturnType<BridgeKit['getSupportedChains']>[number]

const ERC20_BALANCE_ABI = parseAbi([
  'function balanceOf(address account) view returns (uint256)',
])

interface WalletClientLike {
  transport: {
    request(args: { method: string; params?: unknown[] | Record<string, unknown> }): Promise<unknown>
  }
}

interface Eip1193LikeProvider {
  request(args: { method: string; params?: unknown[] | Record<string, unknown> }): Promise<unknown>
  on?(event: string, listener: (...args: unknown[]) => void): void
  removeListener?(event: string, listener: (...args: unknown[]) => void): void
}

export type MainnetSolanaCanaryState = {
  isLoading: boolean
  error: string | null
  status: string | null
  result: unknown | null
}

function getSolanaAddress(provider: PhantomSolanaProvider) {
  const key = provider.publicKey
  if (!key) return null
  return typeof key.toBase58 === 'function' ? key.toBase58() : key.toString()
}

function createStrictSolanaProvider(
  provider: PhantomSolanaProvider,
): Parameters<typeof createSolanaAdapterFromProvider>[0]['provider'] {
  const signOne = async (transaction: unknown) => {
    if (!provider.signTransaction) {
      throw new Error('Connected Solana wallet cannot sign transactions.')
    }
    return provider.signTransaction(transaction)
  }

  return {
    get isConnected() {
      return Boolean(provider.isConnected)
    },
    get publicKey() {
      const address = getSolanaAddress(provider)
      return address ? { toString: () => address } : undefined
    },
    connect: async () => {
      const result = await provider.connect()
      const key = result.publicKey
      const address = key
        ? (typeof key.toBase58 === 'function' ? key.toBase58() : key.toString())
        : getSolanaAddress(provider)

      if (!address) throw new Error('Solana wallet did not return an address.')
      return { publicKey: { toString: () => address } }
    },
    disconnect: async () => provider.disconnect(),
    signTransaction: signOne,
    signAllTransactions: async (transactions: unknown[]) =>
      provider.signAllTransactions
        ? provider.signAllTransactions(transactions)
        : Promise.all(transactions.map(signOne)),
    signMessage: provider.signMessage
      ? async (message: Uint8Array) => provider.signMessage!(message) as Promise<{ signature: Uint8Array }>
      : undefined,
  }
}

function createStrictEvmProvider(
  walletClient: WalletClientLike,
): Parameters<typeof createEvmAdapterFromProvider>[0]['provider'] {
  const providerSource = walletClient.transport as unknown as Eip1193LikeProvider

  return {
    on: ((event, listener) => {
      providerSource.on?.(event as string, listener as (...args: unknown[]) => void)
    }) as Parameters<typeof createEvmAdapterFromProvider>[0]['provider']['on'],
    removeListener: ((event, listener) => {
      providerSource.removeListener?.(event as string, listener as (...args: unknown[]) => void)
    }) as Parameters<typeof createEvmAdapterFromProvider>[0]['provider']['removeListener'],
    request: ((args) => {
      if (providerSource.request) {
        return providerSource.request({
          method: args.method,
          params: args.params as unknown[] | Record<string, unknown> | undefined,
        })
      }

      return walletClient.transport.request({
        method: args.method,
        params: args.params as unknown[] | Record<string, unknown> | undefined,
      })
    }) as Parameters<typeof createEvmAdapterFromProvider>[0]['provider']['request'],
  }
}

function resolveChains(kit: BridgeKit) {
  const chains = kit.getSupportedChains()
  const solana = chains.find(
    (chain: any) =>
      !('chainId' in chain)
      && chain.isTestnet === false
      && String(chain.name ?? '').toLowerCase().includes('solana'),
  )
  const arc = chains.find(
    (chain: any) =>
      'chainId' in chain
      && Number(chain.chainId) === ARC_MAINNET_EVM_CHAIN_ID,
  )

  if (!solana) throw new Error('Bridge Kit does not expose Solana mainnet.')
  if (!arc) throw new Error('Bridge Kit does not expose Arc mainnet.')

  return { solana: solana as BridgeKitChain, arc: arc as BridgeKitChain }
}

export function useMainnetSolanaCctp(
  phantomProvider: PhantomSolanaProvider | null,
  phantomAddress: string | null,
) {
  const { address: evmAddress } = useAccount()
  const { data: walletClient } = useWalletClient()
  const [state, setState] = useState<MainnetSolanaCanaryState>({
    isLoading: false,
    error: null,
    status: null,
    result: null,
  })
  const [arcBalance, setArcBalance] = useState<string | null>(null)
  const [arcBalanceError, setArcBalanceError] = useState<string | null>(null)
  const [solanaBalance, setSolanaBalance] = useState<string | null>(null)
  const [solanaBalanceError, setSolanaBalanceError] = useState<string | null>(null)

  const kitSupport = useMemo(() => {
    try {
      const kit = new BridgeKit()
      const { solana, arc } = resolveChains(kit)
      return { ready: true, solanaName: solana.name, arcName: arc.name, error: null }
    } catch (error) {
      return {
        ready: false,
        solanaName: null,
        arcName: null,
        error: error instanceof Error ? error.message : 'Bridge Kit support check failed.',
      }
    }
  }, [])

  const refreshArcBalance = useCallback(async () => {
    if (!evmAddress) {
      setArcBalance(null)
      setArcBalanceError(null)
      return null
    }

    setArcBalanceError(null)

    try {
      const arc = MAINNET_NETWORKS.arc
      const client = createPublicClient({
        transport: http(arc.rpcUrls[0], {
          timeout: 10_000,
          retryCount: 0,
        }),
      })

      const raw = await client.readContract({
        address: arc.usdcAddress,
        abi: ERC20_BALANCE_ABI,
        functionName: 'balanceOf',
        args: [evmAddress],
      })

      const formatted = formatUnits(raw, 6)
      setArcBalance(formatted)
      return formatted
    } catch (error) {
      const message = error instanceof Error
        ? error.message
        : 'Unable to read Arc mainnet USDC balance.'
      setArcBalance(null)
      setArcBalanceError(message)
      throw error
    }
  }, [evmAddress])

  const refreshSolanaBalance = useCallback(async () => {
    if (!phantomAddress) {
      setSolanaBalance(null)
      setSolanaBalanceError(null)
      return null
    }

    setSolanaBalanceError(null)

    try {
      const { ata } = deriveSolanaUsdcAta(phantomAddress, 'mainnet')

      const response = await fetch('https://solana-rpc.publicnode.com', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'getAccountInfo',
          params: [
            ata.toBase58(),
            {
              encoding: 'jsonParsed',
              commitment: 'confirmed',
            },
          ],
        }),
      })

      if (!response.ok) {
        throw new Error(`Solana RPC HTTP ${response.status}`)
      }

      const payload = await response.json()
      if (payload?.error) {
        throw new Error(payload.error.message || 'Solana RPC error')
      }

      const tokenAmount = payload?.result?.value?.data?.parsed?.info?.tokenAmount
      const raw = tokenAmount?.amount

      if (typeof raw !== 'string' || !/^\d+$/.test(raw)) {
        throw new Error('USDC associated token account balance was not returned.')
      }

      const formatted =
        typeof tokenAmount?.uiAmountString === 'string'
          ? tokenAmount.uiAmountString
          : formatUnits(BigInt(raw), 6)

      setSolanaBalance(formatted)
      return formatted
    } catch (error) {
      const message = error instanceof Error
        ? error.message
        : 'Unable to read Solana mainnet USDC balance.'
      setSolanaBalance(null)
      setSolanaBalanceError(message)
      throw error
    }
  }, [phantomAddress])

  const recoverArcToSolana = useCallback(async (
    sourceTxHash: Hex,
  ) => {
    setState({
      isLoading: true,
      error: null,
      status: 'Checking Circle attestation for the existing Arc burn...',
      result: null,
    })

    try {
      if (!phantomProvider || !phantomAddress) {
        throw new Error('Connect Phantom before recovering the Solana mint.')
      }

      const attestation = await fetchMainnetCctpAttestation({
        sourceChainId: ARC_MAINNET_EVM_CHAIN_ID,
        transactionHash: sourceTxHash,
      })

      if (
        attestation.status !== 'complete'
        || !attestation.message
        || !attestation.attestation
        || !attestation.eventNonce
      ) {
        throw new Error('Circle attestation is not complete yet. No new burn was submitted.')
      }

      const decodedMessage = attestation.decodedMessage as
        | { recipient?: string }
        | undefined

      if (!decodedMessage?.recipient) {
        throw new Error('Circle attestation is missing the mint recipient.')
      }

      const kit = new BridgeKit()
      const { solana, arc } = resolveChains(kit)
      const solanaRecoveryChain = {
        ...(solana as any),
        rpcEndpoints: ['https://solana-rpc.publicnode.com'],
      } as BridgeKitChain

      const solanaAdapter = await createSolanaAdapterFromProvider({
        provider: createStrictSolanaProvider(phantomProvider),
        capabilities: {
          addressContext: 'user-controlled',
          supportedChains: [solanaRecoveryChain],
        },
      })

      setState({
        isLoading: true,
        error: null,
        status: 'Attestation ready. Confirm the existing transfer mint in Phantom.',
        result: null,
      })

      const action = await (solanaAdapter as any).actionRegistry.executeAction(
        'cctp.v2.receiveMessage',
        {
          attestation: attestation.attestation,
          message: attestation.message,
          eventNonce: attestation.eventNonce,
          mintRecipient: decodedMessage.recipient,
          fromChain: arc,
          toChain: solanaRecoveryChain,
        },
        {
          chain: solanaRecoveryChain,
          address: phantomAddress,
        },
      )

      if (!action?.execute) {
        throw new Error('Solana receiveMessage action could not be prepared.')
      }

      const destinationTxHash = await action.execute()

      if (destinationTxHash && (solanaAdapter as any).waitForTransaction) {
        await (solanaAdapter as any).waitForTransaction(
          destinationTxHash,
          {},
          solanaRecoveryChain,
        )
      }

      setState({
        isLoading: false,
        error: null,
        status: 'Existing Arc burn was minted on Solana.',
        result: {
          sourceTxHash,
          destinationTxHash,
          recovered: true,
        },
      })

      void refreshArcBalance().catch(() => undefined)
      void refreshSolanaBalance().catch(() => undefined)

      return destinationTxHash
    } catch (error) {
      const message = error instanceof Error
        ? error.message
        : 'Arc to Solana recovery failed.'

      setState({
        isLoading: false,
        error: message,
        status: null,
        result: {
          sourceTxHash,
          recovered: false,
        },
      })

      throw error
    }
  }, [
    phantomAddress,
    phantomProvider,
    refreshArcBalance,
    refreshSolanaBalance,
  ])

  const runCanary = useCallback(async (
    direction: MainnetSolanaCanaryDirection,
    amount: string,
  ) => {
    setState({ isLoading: true, error: null, status: 'Preparing canary...', result: null })

    try {
      if (!MAINNET_SOLANA_CCTP_CANARY_ENABLED) {
        throw new Error('Solana mainnet CCTP canary is globally locked.')
      }

      if (!isMainnetSolanaCanaryWriteEnabled(direction)) {
        throw new Error(`${direction} route is read-only.`)
      }

      const amountRaw = parseUnits(amount, 6)
      if (amountRaw <= 0n || amountRaw > MAINNET_SOLANA_CCTP_CANARY_MAX_AMOUNT_RAW) {
        throw new Error('Solana mainnet canary maximum is 0.1 USDC.')
      }

      if (!evmAddress || !walletClient) {
        throw new Error('Connect the EVM wallet used for Arc first.')
      }

      if (!phantomProvider || !phantomAddress) {
        throw new Error('Connect Phantom on Solana mainnet first.')
      }

      const kit = new BridgeKit()
      const { solana, arc } = resolveChains(kit)
      const solanaAdapter = await createSolanaAdapterFromProvider({
        provider: createStrictSolanaProvider(phantomProvider),
        capabilities: {
          addressContext: 'user-controlled',
          supportedChains: [solana],
        },
      })
      const evmAdapter = await createEvmAdapterFromProvider({
        provider: createStrictEvmProvider(walletClient as WalletClientLike),
      })

      const request = async (args: { method: string; params?: unknown[] }) =>
        walletClient.transport.request(args as never)

      await addChainToWallet(ARC_MAINNET_EVM_CHAIN, request)

      setState((previous) => ({
        ...previous,
        status: direction === 'solana-to-arc'
          ? 'Confirm the Solana mainnet CCTP transfer in Phantom.'
          : 'Confirm the Arc mainnet CCTP transfer in your EVM wallet.',
      }))

      const result = direction === 'solana-to-arc'
        ? await kit.bridge({
            from: { adapter: solanaAdapter, chain: solana },
            to: { adapter: evmAdapter, chain: arc, recipientAddress: evmAddress },
            amount,
          } as any)
        : await kit.bridge({
            from: { adapter: evmAdapter, chain: arc },
            to: { adapter: solanaAdapter, chain: solana, recipientAddress: phantomAddress },
            amount,
          } as any)

      if ((result as any)?.state === 'error') {
        throw new Error('Bridge Kit returned an error state.')
      }

      setState({
        isLoading: false,
        error: null,
        status: 'Solana mainnet canary completed.',
        result,
      })

      void refreshArcBalance().catch(() => undefined)
      void refreshSolanaBalance().catch(() => undefined)
      return result
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Solana mainnet canary failed.'
      setState({
        isLoading: false,
        error: message,
        status: null,
        result: null,
      })
      throw error
    }
  }, [
    evmAddress,
    phantomAddress,
    phantomProvider,
    refreshArcBalance,
    refreshSolanaBalance,
    walletClient,
  ])

  return {
    state,
    kitSupport,
    arcBalance,
    arcBalanceError,
    refreshArcBalance,
    solanaBalance,
    solanaBalanceError,
    refreshSolanaBalance,
    recoverArcToSolana,
    runCanary,
  }
}
