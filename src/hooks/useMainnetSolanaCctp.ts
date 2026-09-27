import { useCallback, useMemo, useRef, useState } from 'react'
import { useAccount, useWalletClient } from 'wagmi'
import { BridgeKit } from '@circle-fin/bridge-kit'
import { createAdapterFromProvider as createEvmAdapterFromProvider } from '@circle-fin/adapter-viem-v2'
import { createSolanaAdapterFromProvider } from '@circle-fin/adapter-solana'
import { createPublicClient, formatUnits, http, parseAbi, parseAbiItem, parseUnits, type Hex } from 'viem'
import { ARC_MAINNET_EVM_CHAIN, ARC_MAINNET_EVM_CHAIN_ID, addChainToWallet } from '../lib/chains'
import { deriveSolanaUsdcAta } from '../lib/solana'

import {
  isMainnetSolanaCanaryWriteEnabled,
  MAINNET_SOLANA_CCTP_CANARY_MAX_AMOUNT_RAW,
  type MainnetSolanaCanaryDirection,
} from '../config/mainnetSolanaCanary'
import { MAINNET_SOLANA_CCTP_CANARY_ENABLED } from '../config/runtime'
import { MAINNET_NETWORKS } from '../config/mainnetNetworks'
import { MAINNET_CONFIG } from '../config/mainnet'
import { fetchMainnetCctpAttestation } from '../lib/mainnetCctpTransfer'

type BridgeKitChain = ReturnType<BridgeKit['getSupportedChains']>[number]

const ERC20_BALANCE_ABI = parseAbi([
  'function balanceOf(address account) view returns (uint256)',
])

const DEPOSIT_FOR_BURN_EVENT = parseAbiItem(
  'event DepositForBurn(address indexed burnToken,uint256 amount,address indexed depositor,bytes32 mintRecipient,uint32 destinationDomain,bytes32 destinationTokenMessenger,bytes32 destinationCaller,uint256 maxFee,uint32 indexed minFinalityThreshold,bytes hookData)',
)

const RECOVERED_ARC_SOLANA_TXS_KEY = 'machina_arc_solana_recovered_txs_v1'

function delay(ms: number) {
  return new Promise((resolve) => window.setTimeout(resolve, ms))
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

function getBridgeKitErrorMessage(result: any) {
  const failedStep = Array.isArray(result?.steps)
    ? result.steps.find((step: any) =>
        step?.state === 'error'
        || step?.status === 'error'
        || step?.error
      )
    : null

  const stepName =
    failedStep?.name
    || failedStep?.id
    || failedStep?.type
    || 'unknown step'

  const message =
    failedStep?.error?.message
    || failedStep?.error
    || result?.error?.message
    || result?.error
    || 'Bridge Kit returned an error state.'

  return `${stepName}: ${String(message)}`
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
  const [pendingArcToSolanaTx, setPendingArcToSolanaTx] = useState<Hex | null>(null)
  const [pendingArcToSolanaError, setPendingArcToSolanaError] = useState<string | null>(null)
  const pendingScanRef = useRef<Promise<Hex | null> | null>(null)

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

  const findPendingArcToSolanaBurn = useCallback(async () => {
    if (!evmAddress || !phantomAddress) return null
    if (pendingScanRef.current) return pendingScanRef.current

    const scan = async () => {
      setPendingArcToSolanaError(null)

      try {
        const arc = MAINNET_NETWORKS.arc
        const client = createPublicClient({
          transport: http(arc.rpcUrls[0], { timeout: 15_000, retryCount: 0 }),
        })
        const latestBlock = await client.getBlockNumber()
        const { ownerHex, ataHex } = deriveSolanaUsdcAta(phantomAddress, 'mainnet')
        const recipients = new Set([ownerHex.toLowerCase(), ataHex.toLowerCase()])

        const recovered = (() => {
          try {
            const raw = window.localStorage.getItem(RECOVERED_ARC_SOLANA_TXS_KEY)
            const values = raw ? JSON.parse(raw) : []
            return new Set<string>(
              Array.isArray(values)
                ? values.map((value) => String(value).toLowerCase())
                : [],
            )
          } catch {
            return new Set<string>()
          }
        })()

        const chunkSize = 500n
        const maxChunks = 8

        for (let index = 0; index < maxChunks; index += 1) {
          const chunkTo = latestBlock - (BigInt(index) * chunkSize)
          if (chunkTo < 0n) break
          const chunkFrom = chunkTo >= chunkSize
            ? chunkTo - chunkSize + 1n
            : 0n

          let logs
          try {
            logs = await client.getLogs({
              address: MAINNET_CONFIG.arcCctpTokenMessengerAddress,
              event: DEPOSIT_FOR_BURN_EVENT,
              args: { burnToken: arc.usdcAddress },
              fromBlock: chunkFrom,
              toBlock: chunkTo,
            })
          } catch (error) {
            const message = error instanceof Error ? error.message.toLowerCase() : ''
            if (!message.includes('rate limit') && !message.includes('defined limit')) {
              throw error
            }
            await delay(1_000)
            logs = await client.getLogs({
              address: MAINNET_CONFIG.arcCctpTokenMessengerAddress,
              event: DEPOSIT_FOR_BURN_EVENT,
              args: { burnToken: arc.usdcAddress },
              fromBlock: chunkFrom,
              toBlock: chunkTo,
            })
          }

          const matches = [...logs].reverse().filter((log: any) => {
            const txHash = String(log.transactionHash || '').toLowerCase()
            return (
              Number(log.args?.destinationDomain) === 5
              && recipients.has(String(log.args?.mintRecipient || '').toLowerCase())
              && Boolean(txHash)
              && !recovered.has(txHash)
            )
          })

          for (const match of matches as any[]) {
            const txHash = match.transactionHash as Hex | undefined
            if (!txHash) continue
            const tx = await client.getTransaction({ hash: txHash })
            if (tx.from.toLowerCase() === evmAddress.toLowerCase()) {
              setPendingArcToSolanaTx(txHash)
              return txHash
            }
          }

          if (chunkFrom === 0n) break
          await delay(650)
        }

        setPendingArcToSolanaTx(null)
        return null
      } catch {
        setPendingArcToSolanaError('Pending burn scan temporarily failed.')
        throw new Error('Pending Arc to Solana burn scan failed.')
      }
    }

    const promise = scan()
    pendingScanRef.current = promise
    try {
      return await promise
    } finally {
      pendingScanRef.current = null
    }
  }, [evmAddress, phantomAddress])

  const recoverPendingArcToSolana = useCallback(async () => {
    const sourceTxHash = pendingArcToSolanaTx || await findPendingArcToSolanaBurn()
    if (!sourceTxHash) throw new Error('No Arc to Solana burn was found for the connected wallets.')
    if (!phantomProvider || !phantomAddress) throw new Error('Connect Phantom first.')

    setState({
      isLoading: true,
      error: null,
      status: 'Recovering the existing Arc burn. No new burn will be created...',
      result: { sourceTxHash },
    })

    try {
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
        throw new Error('Circle attestation is not complete yet.')
      }

      const recipient = (attestation.decodedMessage as { recipient?: string } | undefined)?.recipient
      if (!recipient) throw new Error('Circle attestation is missing the Solana mint recipient.')

      const { ownerHex, ataHex } = deriveSolanaUsdcAta(phantomAddress, 'mainnet')
      if (
        recipient.toLowerCase() !== ownerHex.toLowerCase()
        && recipient.toLowerCase() !== ataHex.toLowerCase()
      ) {
        throw new Error('This burn belongs to a different Solana destination wallet.')
      }

      const kit = new BridgeKit()
      const { solana, arc } = resolveChains(kit)
      const solanaBridgeChain = {
        ...(solana as any),
        rpcEndpoints: ['https://solana-rpc.publicnode.com'],
      } as BridgeKitChain
      const solanaAdapter = await createSolanaAdapterFromProvider({
        provider: createStrictSolanaProvider(phantomProvider),
        capabilities: {
          addressContext: 'user-controlled',
          supportedChains: [solanaBridgeChain],
        },
      })

      const action = await (solanaAdapter as any).actionRegistry.executeAction(
        'cctp.v2.receiveMessage',
        {
          attestation: attestation.attestation,
          message: attestation.message,
          eventNonce: attestation.eventNonce,
          mintRecipient: recipient,
          fromChain: arc,
          toChain: solanaBridgeChain,
        },
        { chain: solanaBridgeChain, address: phantomAddress },
      )
      if (!action?.execute) throw new Error('Solana receiveMessage action could not be prepared.')

      const destinationTxHash = await action.execute()
      if (destinationTxHash && (solanaAdapter as any).waitForTransaction) {
        await (solanaAdapter as any).waitForTransaction(destinationTxHash, {}, solanaBridgeChain)
      }

      try {
        const raw = window.localStorage.getItem(RECOVERED_ARC_SOLANA_TXS_KEY)
        const values = raw ? JSON.parse(raw) : []
        const next = Array.from(new Set([
          ...(Array.isArray(values) ? values.map(String) : []),
          sourceTxHash,
        ]))
        window.localStorage.setItem(
          RECOVERED_ARC_SOLANA_TXS_KEY,
          JSON.stringify(next),
        )
      } catch {
        // Recovery succeeded; persistence is best-effort only.
      }

      setPendingArcToSolanaTx(null)
      setState({
        isLoading: false,
        error: null,
        status: 'Existing Arc burn was minted on Solana.',
        result: { sourceTxHash, destinationTxHash, recovered: true },
      })
      void refreshArcBalance().catch(() => undefined)
      void refreshSolanaBalance().catch(() => undefined)
      return destinationTxHash
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Arc to Solana recovery failed.'
      setState({
        isLoading: false,
        error: message,
        status: null,
        result: { sourceTxHash, recovered: false },
      })
      throw error
    }
  }, [
    findPendingArcToSolanaBurn,
    pendingArcToSolanaTx,
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
      const solanaBridgeChain = {
        ...(solana as any),
        rpcEndpoints: ['https://solana-rpc.publicnode.com'],
      } as BridgeKitChain

      const solanaAdapter = await createSolanaAdapterFromProvider({
        provider: createStrictSolanaProvider(phantomProvider),
        capabilities: {
          addressContext: 'user-controlled',
          supportedChains: [solanaBridgeChain],
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
            from: { adapter: solanaAdapter, chain: solanaBridgeChain },
            to: { adapter: evmAdapter, chain: arc, recipientAddress: evmAddress },
            amount,
          } as any)
        : await kit.bridge({
            from: { adapter: evmAdapter, chain: arc },
            to: { adapter: solanaAdapter, chain: solanaBridgeChain, recipientAddress: phantomAddress },
            amount,
          } as any)

      let finalResult = result as any

      if (finalResult?.state === 'error') {
        setState({
          isLoading: true,
          error: null,
          status: 'Bridge source step completed. Resuming the failed destination step...',
          result: finalResult,
        })

        finalResult = await kit.retry(finalResult, {
          from: direction === 'solana-to-arc' ? solanaAdapter : evmAdapter,
          to: direction === 'solana-to-arc' ? evmAdapter : solanaAdapter,
        } as any)
      }

      if (finalResult?.state === 'error') {
        const errorMessage = getBridgeKitErrorMessage(finalResult)
        setState({
          isLoading: false,
          error: errorMessage,
          status: null,
          result: finalResult,
        })
        return finalResult
      }

      setState({
        isLoading: false,
        error: null,
        status: 'Solana mainnet canary completed.',
        result: finalResult,
      })

      void refreshArcBalance().catch(() => undefined)
      void refreshSolanaBalance().catch(() => undefined)
      return finalResult
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
    pendingArcToSolanaTx,
    pendingArcToSolanaError,
    findPendingArcToSolanaBurn,
    recoverPendingArcToSolana,
    runCanary,
  }
}
