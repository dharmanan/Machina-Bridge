import { useCallback, useState } from 'react'
import { useAccount, useWalletClient } from 'wagmi'
import { BridgeKit } from '@circle-fin/bridge-kit'
import { createAdapterFromProvider as createEvmAdapterFromProvider } from '@circle-fin/adapter-viem-v2'
import { createSolanaAdapterFromProvider } from '@circle-fin/adapter-solana'
import { ARC_EVM_CHAIN, ARC_EVM_CHAIN_ID, addChainToWallet } from '../lib/chains'
import { logger } from '../lib/logger'
import { createSolanaDevnetConnection, fetchSolanaUsdcBalance } from '../lib/solana'

export type SolanaBridgeStep =
  | 'idle'
  | 'signing-source'
  | 'waiting-attestation'
  | 'signing-destination'
  | 'success'
  | 'error'

interface BridgeKitStepResult {
  name?: string
  state?: string
  txHash?: string
  errorMessage?: string
}

interface BridgeKitResult {
  state?: string
  steps?: BridgeKitStepResult[]
}

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

export interface SolanaBridgeState {
  step: SolanaBridgeStep
  error: string | null
  isLoading: boolean
  result: unknown | null
  sourceTxHash?: string
  receiveTxHash?: string
  status: string | null
}

function getResultStep(result: BridgeKitResult | null | undefined, stepName: string) {
  return result?.steps?.find((step) => step.name === stepName)
}

function extractStepTxHash(step: BridgeKitStepResult | null | undefined) {
  if (!step) {
    return undefined
  }

  const stepRecord = step as Record<string, unknown>
  const valuesRecord = stepRecord.values as Record<string, unknown> | undefined

  return (
    (typeof step.txHash === 'string' ? step.txHash : undefined)
    || (typeof stepRecord.transactionHash === 'string' ? stepRecord.transactionHash : undefined)
    || (typeof stepRecord.hash === 'string' ? stepRecord.hash : undefined)
    || (typeof valuesRecord?.txHash === 'string' ? valuesRecord.txHash : undefined)
    || (typeof valuesRecord?.transactionHash === 'string' ? valuesRecord.transactionHash : undefined)
    || (typeof valuesRecord?.signature === 'string' ? valuesRecord.signature : undefined)
  )
}

function extractEventTxHash(event: unknown) {
  if (!event || typeof event !== 'object') {
    return undefined
  }

  const eventRecord = event as Record<string, unknown>
  const valuesRecord = eventRecord.values as Record<string, unknown> | undefined

  return (
    (typeof valuesRecord?.txHash === 'string' ? valuesRecord.txHash : undefined)
    || (typeof valuesRecord?.transactionHash === 'string' ? valuesRecord.transactionHash : undefined)
    || (typeof valuesRecord?.signature === 'string' ? valuesRecord.signature : undefined)
    || (typeof eventRecord.txHash === 'string' ? eventRecord.txHash : undefined)
    || (typeof eventRecord.transactionHash === 'string' ? eventRecord.transactionHash : undefined)
    || (typeof eventRecord.signature === 'string' ? eventRecord.signature : undefined)
  )
}

function findResultStepByKeywords(result: BridgeKitResult | null | undefined, keywords: string[]) {
  const normalizedKeywords = keywords.map((keyword) => keyword.toLowerCase())

  return result?.steps?.find((step) => {
    const name = String(step.name ?? '').toLowerCase()
    if (!name) {
      return false
    }

    return normalizedKeywords.some((keyword) => name.includes(keyword))
  })
}

function getBridgeTxHashes(result: BridgeKitResult | null | undefined) {
  const burnStep = getResultStep(result, 'burn') || findResultStepByKeywords(result, ['burn', 'depositforburn'])
  const mintStep = getResultStep(result, 'mint') || findResultStepByKeywords(result, ['mint', 'receive', 'reclaim'])

  return {
    sourceTxHash: extractStepTxHash(burnStep),
    receiveTxHash: extractStepTxHash(mintStep),
  }
}

function getSolanaAddressString(publicKey?: { toBase58?: () => string; toString(): string } | null) {
  if (!publicKey) {
    return undefined
  }

  if (typeof publicKey.toBase58 === 'function') {
    return publicKey.toBase58()
  }

  return publicKey.toString()
}

function createStrictSolanaProvider(
  provider: PhantomSolanaProvider,
): Parameters<typeof createSolanaAdapterFromProvider>[0]['provider'] {
  const signSingleTransaction = async (transaction: unknown) => {
    if (!provider.signTransaction) {
      throw new Error('The connected Phantom Solana provider cannot sign transactions.')
    }

    return provider.signTransaction(transaction)
  }

  return {
    get isConnected() {
      return Boolean(provider.isConnected)
    },
    get publicKey() {
      const address = getSolanaAddressString(provider.publicKey)
      return address
        ? {
            toString: () => address,
          }
        : undefined
    },
    connect: async () => {
      const result = await provider.connect()
      const address = getSolanaAddressString(result.publicKey)

      if (!address) {
        throw new Error('Phantom did not return a Solana public key.')
      }

      return {
        publicKey: {
          toString: () => address,
        },
      }
    },
    disconnect: async () => provider.disconnect(),
    signTransaction: signSingleTransaction,
    signAllTransactions: async (transactions: unknown[]) => {
      if (provider.signAllTransactions) {
        return provider.signAllTransactions(transactions)
      }

      return Promise.all(transactions.map((transaction) => signSingleTransaction(transaction)))
    },
    signMessage: provider.signMessage
      ? async (message: Uint8Array) => {
          const result = await provider.signMessage!(message)
          return result as { signature: Uint8Array }
        }
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

function getReadableBridgeError(error: unknown, result?: BridgeKitResult | null) {
  const resultErrorMessage = result?.steps?.find((step) => step.state === 'error')?.errorMessage
  const rawMessage = resultErrorMessage || (error instanceof Error ? error.message : 'Solana to Machina Bridge failed.')

  if (rawMessage.includes('User rejected') || rawMessage.includes('user rejected')) {
    return 'You rejected the bridge request in one of your wallets.'
  }

  if (rawMessage.includes('Network mismatch')) {
    return 'Phantom is connected to the wrong Solana network. Switch Phantom to Solana Devnet and try again.'
  }

  if (rawMessage.includes('insufficient') || rawMessage.includes('Insufficient')) {
    return 'Insufficient funds to complete the Solana to Machina Bridge.'
  }

  return rawMessage
}

export function useSolanaBridge() {
  const { address } = useAccount()
  const { data: walletClient } = useWalletClient()

  const [state, setState] = useState<SolanaBridgeState>({
    step: 'idle',
    error: null,
    isLoading: false,
    result: null,
    sourceTxHash: undefined,
    receiveTxHash: undefined,
    status: null,
  })
  const [solanaBalance, setSolanaBalance] = useState('0.000000')
  const [isLoadingBalance, setIsLoadingBalance] = useState(false)
  const [balanceError, setBalanceError] = useState('')

  const fetchBalance = useCallback(async (ownerAddress?: string | null) => {
    if (!ownerAddress) {
      setSolanaBalance('0.000000')
      setBalanceError('')
      return
    }

    setIsLoadingBalance(true)
    setBalanceError('')

    try {
      const nextBalance = await fetchSolanaUsdcBalance(ownerAddress)
      setSolanaBalance(nextBalance)
    } catch (error) {
      logger.warn('Unable to fetch Solana USDC balance:', error)
      setSolanaBalance('0.000000')
      setBalanceError('Failed to read Solana Devnet USDC balance. Confirm Phantom is on Devnet and try again.')
    } finally {
      setIsLoadingBalance(false)
    }
  }, [])

  const reset = useCallback(() => {
    setState({
      step: 'idle',
      error: null,
      isLoading: false,
      result: null,
      sourceTxHash: undefined,
      receiveTxHash: undefined,
      status: null,
    })
  }, [])

  const bridgeToArc = useCallback(
    async ({ amount, solanaProvider }: { amount: string; solanaProvider: PhantomSolanaProvider }) => {
      if (!address) {
        setState({
          step: 'error',
          error: 'Connect your EVM wallet first so Arc can receive the mint.',
          isLoading: false,
          result: null,
          status: null,
        })
        return
      }

      if (!walletClient) {
        setState({
          step: 'error',
          error: 'Connected EVM wallet provider is not available. Reconnect your EVM wallet and try again.',
          isLoading: false,
          result: null,
          status: null,
        })
        return
      }

      const parsedAmount = Number(amount)
      if (!Number.isFinite(parsedAmount) || parsedAmount <= 0) {
        setState({
          step: 'error',
          error: 'Enter a valid USDC amount to bridge from Solana.',
          isLoading: false,
          result: null,
          status: null,
        })
        return
      }

      const strictSolanaProvider = createStrictSolanaProvider(solanaProvider)
      const evmProvider = createStrictEvmProvider(walletClient as WalletClientLike)

      const walletRequest = async (args: { method: string; params?: unknown[] }) => walletClient.transport.request(args as never)

      try {
        await addChainToWallet(ARC_EVM_CHAIN, walletRequest)
      } catch (error) {
        logger.warn('Unable to pre-register Arc in the EVM wallet:', error)
      }

      setState({
        step: 'signing-source',
        error: null,
        isLoading: true,
        result: null,
        sourceTxHash: undefined,
        receiveTxHash: undefined,
        status: 'Confirm the burn on Solana Devnet in Phantom.',
      })

      const kit = new BridgeKit()
      let observedSourceTxHash: string | undefined
      let observedReceiveTxHash: string | undefined

      kit.on('burn', (event: any) => {
        const burnTxHash = extractEventTxHash(event)
        observedSourceTxHash = burnTxHash || observedSourceTxHash

        setState((previousState) => ({
          ...previousState,
          step: 'waiting-attestation',
          sourceTxHash: burnTxHash || previousState.sourceTxHash,
          status: 'Burn confirmed on Solana. Waiting for Circle attestation.',
        }))
      })

      kit.on('fetchAttestation', () => {
        setState((previousState) => ({
          ...previousState,
          step: 'signing-destination',
          status: 'Attestation received. Confirm the mint on Arc in your EVM wallet.',
        }))
      })

      kit.on('mint', (event: any) => {
        const mintTxHash = extractEventTxHash(event)
        observedReceiveTxHash = mintTxHash || observedReceiveTxHash

        setState((previousState) => ({
          ...previousState,
          receiveTxHash: mintTxHash || previousState.receiveTxHash,
          status: 'Mint transaction submitted on Arc.',
        }))
      })

      let result: BridgeKitResult | null = null

      try {
        const supportedChains = kit.getSupportedChains()
        const sourceChain = supportedChains.find(
          (chain: any) => !('chainId' in chain) && chain.isTestnet && chain.name.toLowerCase().includes('solana'),
        )
        const destinationChain = supportedChains.find(
          (chain: any) => 'chainId' in chain && chain.chainId === ARC_EVM_CHAIN_ID,
        )

        if (!sourceChain) {
          throw new Error('Solana Devnet is not available in the installed Bridge Kit version.')
        }

        if (!destinationChain) {
          throw new Error('Arc Testnet is not available in the installed Bridge Kit version.')
        }

        const solanaAdapter = await createSolanaAdapterFromProvider({
          provider: strictSolanaProvider,
          connection: createSolanaDevnetConnection(),
          capabilities: {
            addressContext: 'user-controlled',
            supportedChains: [sourceChain],
          },
        })

        const evmAdapter = await createEvmAdapterFromProvider({
          provider: evmProvider,
        })

        result = (await kit.bridge({
          from: {
            adapter: solanaAdapter,
            chain: sourceChain,
          },
          to: {
            adapter: evmAdapter,
            chain: destinationChain,
            recipientAddress: address,
          },
          amount,
        })) as BridgeKitResult

          const resultHashes = getBridgeTxHashes(result)
          const sourceTxHash = resultHashes.sourceTxHash || observedSourceTxHash
          const receiveTxHash = resultHashes.receiveTxHash || observedReceiveTxHash

        if (result.state === 'error') {
          throw new Error(getReadableBridgeError(null, result))
        }

        setState({
          step: 'success',
          error: null,
          isLoading: false,
          result,
          sourceTxHash,
          receiveTxHash,
          status: 'USDC bridged from Solana Devnet to Arc Testnet.',
        })

        void fetchBalance(getSolanaAddressString(solanaProvider.publicKey) ?? null)
      } catch (error) {
          const resultHashes = getBridgeTxHashes(result)

        setState((previousState) => ({
          ...previousState,
          step: 'error',
          error: getReadableBridgeError(error, result),
          isLoading: false,
          result,
            sourceTxHash: resultHashes.sourceTxHash || observedSourceTxHash || previousState.sourceTxHash,
            receiveTxHash: resultHashes.receiveTxHash || observedReceiveTxHash || previousState.receiveTxHash,
          status: null,
        }))
      }
    },
    [address, fetchBalance, walletClient],
  )

  return {
    state,
    solanaBalance,
    isLoadingBalance,
    balanceError,
    fetchBalance,
    bridgeToArc,
    reset,
  }
}