import { useCallback, useMemo, useState } from 'react'
import { useAccount, useSwitchChain } from 'wagmi'
import { getWalletClient } from 'wagmi/actions'
import { createPublicClient, fallback, http, type Hex } from 'viem'
import { getRuntimeCapabilities } from '../config/features'
import { getMainnetCctpRoute } from '../config/mainnetCctp'
import { MAINNET_RUNTIME_IMPLEMENTED } from '../config/runtime'
import { wagmiConfig } from '../lib/wagmi.config'
import {
  fetchMainnetCctpAttestation,
  prepareMainnetCctpApproval,
  prepareMainnetCctpBurn,
  prepareMainnetCctpMint,
  quoteMainnetCctpTransfer,
  type MainnetCctpAttestation,
  type MainnetCctpQuote,
  type MainnetCctpTransferMode,
} from '../lib/mainnetCctpTransfer'
import { simulateMainnetCctpSource } from '../lib/mainnetCctpSimulation'

export type MainnetCctpStep =
  | 'idle'
  | 'quoting'
  | 'simulating'
  | 'switching-network'
  | 'approving'
  | 'burning'
  | 'waiting-attestation'
  | 'minting'
  | 'success'
  | 'error'

export type MainnetCctpState = {
  step: MainnetCctpStep
  error: string | null
  sourceTxHash?: Hex
  destinationTxHash?: Hex
  isLoading: boolean
}

function makePublicClient(rpcUrls: readonly string[]) {
  const transports = rpcUrls.map((url) => http(url, { timeout: 10_000, retryCount: 0 }))
  return createPublicClient({
    transport: transports.length === 1 ? transports[0] : fallback(transports),
  })
}

function assertMainnetWritesEnabled() {
  const capabilities = getRuntimeCapabilities('mainnet')
  if (!MAINNET_RUNTIME_IMPLEMENTED || !capabilities.evmBridge || !capabilities.realValueTransfers) {
    throw new Error('Mainnet CCTP transactions are locked until final readiness review and deliberate runtime unlock.')
  }
}

export function useMainnetCctp() {
  const { address, isConnected, chainId } = useAccount()
  const { switchChainAsync } = useSwitchChain()
  const [state, setState] = useState<MainnetCctpState>({
    step: 'idle',
    error: null,
    isLoading: false,
  })

  const writesUnlocked = useMemo(() => {
    const capabilities = getRuntimeCapabilities('mainnet')
    return MAINNET_RUNTIME_IMPLEMENTED && capabilities.evmBridge && capabilities.realValueTransfers
  }, [])

  const reset = useCallback(() => {
    setState({
      step: 'idle',
      error: null,
      isLoading: false,
    })
  }, [])

  const quote = useCallback(async (input: {
    sourceChainId: number
    destinationChainId: number
    amount: string
    mode?: MainnetCctpTransferMode
  }): Promise<MainnetCctpQuote> => {
    setState((current) => ({ ...current, step: 'quoting', error: null, isLoading: true }))
    try {
      const result = await quoteMainnetCctpTransfer(input)
      setState((current) => ({ ...current, step: 'idle', isLoading: false }))
      return result
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Could not quote mainnet CCTP transfer.'
      setState((current) => ({ ...current, step: 'error', error: message, isLoading: false }))
      throw error
    }
  }, [])

  const simulateSource = useCallback(async (input: {
    sourceChainId: number
    destinationChainId: number
    amount: string
    recipient?: string
    mode?: MainnetCctpTransferMode
  }) => {
    if (!address) {
      throw new Error('Connect a wallet before running account-specific simulation.')
    }

    setState((current) => ({ ...current, step: 'simulating', error: null, isLoading: true }))
    try {
      const result = await simulateMainnetCctpSource({
        ...input,
        account: address,
      })
      setState((current) => ({ ...current, step: 'idle', isLoading: false }))
      return result
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Could not simulate mainnet CCTP transfer.'
      setState((current) => ({ ...current, step: 'error', error: message, isLoading: false }))
      throw error
    }
  }, [address])

  const ensureWalletOnChain = useCallback(async (targetChainId: number) => {
    if (!isConnected || !address) {
      throw new Error('Connect a wallet before submitting a mainnet CCTP transaction.')
    }

    if (chainId !== targetChainId) {
      if (!switchChainAsync) {
        throw new Error(`Switch the wallet to chain ${targetChainId} before continuing.`)
      }
      setState((current) => ({ ...current, step: 'switching-network', error: null, isLoading: true }))
      await switchChainAsync({ chainId: targetChainId })
    }

    const walletClient = await getWalletClient(wagmiConfig, { chainId: targetChainId })
    if (!walletClient) {
      throw new Error('Wallet client is not available on the requested chain.')
    }

    return walletClient
  }, [address, chainId, isConnected, switchChainAsync])

  const approve = useCallback(async (input: {
    sourceChainId: number
    amountRaw: bigint
  }): Promise<Hex> => {
    assertMainnetWritesEnabled()
    const route = getMainnetCctpRoute(input.sourceChainId, 5042)
      ?? getMainnetCctpRoute(input.sourceChainId, 1)
      ?? getMainnetCctpRoute(input.sourceChainId, 8453)
      ?? getMainnetCctpRoute(input.sourceChainId, 10)
      ?? getMainnetCctpRoute(input.sourceChainId, 42161)

    if (!route) {
      throw new Error('Unsupported mainnet CCTP source chain.')
    }

    setState((current) => ({ ...current, step: 'approving', error: null, isLoading: true }))
    try {
      const walletClient = await ensureWalletOnChain(input.sourceChainId)
      const call = prepareMainnetCctpApproval(input)
      const hash = await walletClient.sendTransaction({
        account: address!,
        to: call.to,
        data: call.data,
        value: call.value,
      })

      const publicClient = makePublicClient(route.source.rpcUrls)
      await publicClient.waitForTransactionReceipt({ hash })
      setState((current) => ({ ...current, step: 'idle', isLoading: false }))
      return hash
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Mainnet USDC approval failed.'
      setState((current) => ({ ...current, step: 'error', error: message, isLoading: false }))
      throw error
    }
  }, [address, ensureWalletOnChain])

  const burn = useCallback(async (input: {
    quote: MainnetCctpQuote
    recipient?: string
    destinationCaller?: string
  }): Promise<Hex> => {
    assertMainnetWritesEnabled()
    if (!address) {
      throw new Error('Connect a wallet before submitting a burn transaction.')
    }

    const route = getMainnetCctpRoute(input.quote.sourceChainId, input.quote.destinationChainId)
    if (!route) {
      throw new Error('Unsupported mainnet CCTP route.')
    }

    setState((current) => ({ ...current, step: 'burning', error: null, isLoading: true }))
    try {
      const walletClient = await ensureWalletOnChain(input.quote.sourceChainId)
      const call = prepareMainnetCctpBurn({
        quote: input.quote,
        recipient: input.recipient ?? address,
        destinationCaller: input.destinationCaller ?? address,
      })
      const hash = await walletClient.sendTransaction({
        account: address,
        to: call.to,
        data: call.data,
        value: call.value,
      })

      const publicClient = makePublicClient(route.source.rpcUrls)
      await publicClient.waitForTransactionReceipt({ hash })
      setState((current) => ({
        ...current,
        step: 'waiting-attestation',
        isLoading: false,
        sourceTxHash: hash,
      }))
      return hash
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Mainnet CCTP burn failed.'
      setState((current) => ({ ...current, step: 'error', error: message, isLoading: false }))
      throw error
    }
  }, [address, ensureWalletOnChain])

  const getAttestation = useCallback(async (input: {
    sourceChainId: number
    sourceTxHash: Hex
  }): Promise<MainnetCctpAttestation> => {
    setState((current) => ({ ...current, step: 'waiting-attestation', error: null, isLoading: true }))
    try {
      const result = await fetchMainnetCctpAttestation({
        sourceChainId: input.sourceChainId,
        transactionHash: input.sourceTxHash,
      })
      setState((current) => ({ ...current, step: 'waiting-attestation', isLoading: false }))
      return result
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Could not fetch Circle attestation.'
      setState((current) => ({ ...current, step: 'error', error: message, isLoading: false }))
      throw error
    }
  }, [])

  const mint = useCallback(async (input: {
    destinationChainId: number
    message: Hex
    attestation: Hex
  }): Promise<Hex> => {
    assertMainnetWritesEnabled()
    if (!address) {
      throw new Error('Connect a wallet before submitting the mint transaction.')
    }

    const route = getMainnetCctpRoute(8453, input.destinationChainId)
      ?? getMainnetCctpRoute(1, input.destinationChainId)
      ?? getMainnetCctpRoute(10, input.destinationChainId)
      ?? getMainnetCctpRoute(42161, input.destinationChainId)
      ?? getMainnetCctpRoute(5042, input.destinationChainId)

    if (!route) {
      throw new Error('Unsupported mainnet CCTP destination chain.')
    }

    setState((current) => ({ ...current, step: 'minting', error: null, isLoading: true }))
    try {
      const walletClient = await ensureWalletOnChain(input.destinationChainId)
      const call = prepareMainnetCctpMint(input)
      const hash = await walletClient.sendTransaction({
        account: address,
        to: call.to,
        data: call.data,
        value: call.value,
      })

      const publicClient = makePublicClient(route.destination.rpcUrls)
      await publicClient.waitForTransactionReceipt({ hash })
      setState((current) => ({
        ...current,
        step: 'success',
        isLoading: false,
        destinationTxHash: hash,
      }))
      return hash
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Mainnet CCTP mint failed.'
      setState((current) => ({ ...current, step: 'error', error: message, isLoading: false }))
      throw error
    }
  }, [address, ensureWalletOnChain])

  return {
    state,
    writesUnlocked,
    quote,
    simulateSource,
    approve,
    burn,
    getAttestation,
    mint,
    reset,
  }
}
