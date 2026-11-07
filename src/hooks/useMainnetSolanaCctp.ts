import { assertSolanaFeeEstimate, solanaFeeEstimateIssue, validateSolanaSdkFees, type SolanaFeeBinding } from '../lib/solanaFeeEstimate'
import { SOLANA_BRIDGE_SDK_RPC, createSolanaBridgeConnection, solanaSourceFailure, type SolanaSourceStage } from '../lib/solanaBridgeConnection'
import { createEvmBridgePolicyProvider } from '../lib/solanaBridgeEvmPolicy'
import { readSolanaSendAttempts } from '../lib/solanaSendGuard'
import { inspectSolanaToArcRecovery } from '../lib/solanaArcRecovery'
import { solanaArcRecoveryPorts } from './useSolanaArcRecovery'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useAccount, useWalletClient } from 'wagmi'
import { BridgeKit, type EstimateResult } from '@circle-fin/bridge-kit'
import { createAdapterFromProvider as createEvmAdapterFromProvider } from '@circle-fin/adapter-viem-v2'
import { createSolanaAdapterFromProvider } from '@circle-fin/adapter-solana'
import { PublicKey } from '@solana/web3.js'
import { createPublicClient, decodeEventLog, formatUnits, http, parseAbi, parseAbiItem, parseUnits, type Hex } from 'viem'
import { ARC_MAINNET_EVM_CHAIN, ARC_MAINNET_EVM_CHAIN_ID, addChainToWallet } from '../lib/chains'
import { deriveSolanaUsdcAta } from '../lib/solana'

import {
  isMainnetSolanaCanaryWriteEnabled,
  type MainnetSolanaCanaryDirection,
} from '../config/mainnetSolanaCanary'
import { MAINNET_SOLANA_CCTP_CANARY_ENABLED } from '../config/runtime'
import { MAINNET_NETWORKS } from '../config/mainnetNetworks'
import { MAINNET_CONFIG } from '../config/mainnet'
import { readCctpBurnProof, readBoundCctpAttestation } from '../lib/mainnetCctpRecovery'
import { classifyArcSolanaBurn, keyedSingleFlight } from '../lib/arcSolanaBurnScan'
import { readSolanaCctpMessageUsed, SolanaNoncePendingError } from '../lib/mainnetSolanaRecovery'
import { recordMainnetSolanaActivity, readMainnetSolanaActivity, updateMainnetSolanaActivity } from '../lib/mainnetSolanaActivity'
import { fetchMainnetCctpAttestation } from '../lib/mainnetCctpTransfer'
import { SOLANA_MAINNET_CCTP } from '../config/mainnetSolana'
import { destinationEvidence, settleSolanaSendAttempt, solanaRpc, withSolanaSendGuard } from '../lib/solanaSendRuntime'
import {
  LegacyReceiveReviewRequired, ReceiveLockedError, classifyFailedAttempt, createBoundReceiveSigner, createReceiveEvidenceSigner, openReceiveAttempt,
  releaseLegacyReceiveAfterReview, reviewLegacyReceive, updateReceiveEntry, type LegacyReview, type ReceiveReads,
} from '../lib/arcSolanaReceiveEvidence'
import { assertSolanaBridgeSigningRequest, createReadOnlySolanaProvider, createStrictSolanaProvider, type SolanaTxExpectation } from '../lib/solanaBridgeTxPolicy'
import { solanaTransferOutcomeStatus, verifyTransferDestinationWithRetry } from '../lib/solanaSendGuard'

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

const SOLANA_BROWSER_READ_RPCS = [
  'https://solana-rpc.publicnode.com',
  'https://solana.drpc.org',
  'https://api.mainnet-beta.solana.com',
]

async function fetchSolanaRpc(
  url: string,
  method: 'getAccountInfo' | 'getSignatureStatuses',
  params: unknown[],
) {
  const controller = new AbortController()
  const timeout = window.setTimeout(() => controller.abort(), 6_000)

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method,
        params,
      }),
      signal: controller.signal,
    })

    const payload = await response.json().catch(() => null)

    if (!response.ok || payload?.error) {
      throw new Error(
        payload?.error?.message
        || payload?.error
        || `Solana RPC HTTP ${response.status}`,
      )
    }

    return payload?.result
  } finally {
    window.clearTimeout(timeout)
  }
}

async function solanaReadRpc(
  method: 'getAccountInfo' | 'getSignatureStatuses',
  params: unknown[],
) {
  let lastError: unknown = null

  for (const rpc of SOLANA_BROWSER_READ_RPCS) {
    try {
      return await fetchSolanaRpc(rpc, method, params)
    } catch (error) {
      lastError = error
    }
  }

  try {
    const response = await fetch('/api/solana-read', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
      },
      body: JSON.stringify({ method, params }),
    })

    const payload = await response.json().catch(() => null)

    if (!response.ok || payload?.error) {
      throw new Error(
        payload?.error
        || `Solana read proxy HTTP ${response.status}`,
      )
    }

    return payload?.result
  } catch (error) {
    lastError = error
  }

  throw lastError instanceof Error
    ? lastError
    : new Error('All Solana balance RPCs failed.')
}

async function readSolanaUsdcRawBalance(ownerAddress: string) {
  const { ata } = deriveSolanaUsdcAta(ownerAddress, 'mainnet')

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

  const raw = payload?.result?.value?.data?.parsed?.info?.tokenAmount?.amount
  if (typeof raw !== 'string' || !/^\d+$/.test(raw)) {
    throw new Error('USDC associated token account balance was not returned.')
  }

  return BigInt(raw)
}

async function isSolanaCctpMessageAlreadyMinted(messageHex: string) {
  return readSolanaCctpMessageUsed(messageHex, solanaReadRpc)
}

// HTTP-only chain evidence for the Arc -> Solana receive (no WebSocket needed). Reader A is the
// browser RPC list used above; reader B is the server proxy with its own provider order. Every
// read failure throws, which keeps an unclear receive locked.
const arcSolanaReceiveReads: ReceiveReads = {
  nonceUsedA: message => isSolanaCctpMessageAlreadyMinted(message),
  nonceUsedB: message => readSolanaCctpMessageUsed(message, (method, params) => solanaRpc(method, params)),
  async signatureStatus(signature) {
    const r = await solanaRpc<{ value?: Array<{ err: unknown; confirmationStatus?: string | null } | null> }>('getSignatureStatuses', [[signature], { searchTransactionHistory: true }])
    if (!r || !Array.isArray(r.value)) throw new Error('Solana signature status is unavailable.')
    const v = r.value[0]
    return v ? { found: true, err: v.err ?? null, confirmationStatus: v.confirmationStatus ?? null } : { found: false }
  },
  async blockhashValid(blockhash) {
    const r = await solanaRpc<{ value?: unknown }>('isBlockhashValid', [blockhash, { commitment: 'processed' }])
    if (typeof r?.value !== 'boolean') throw new Error('Solana blockhash validity is unavailable.')
    return r.value
  },
  async signaturesTouching(address) {
    const r = await solanaRpc<unknown[]>('getSignaturesForAddress', [address, { limit: 5 }])
    if (!Array.isArray(r)) throw new Error('Solana signature history is unavailable.')
    return r.length
  },
}

async function waitForSolanaUsdcCredit(
  ownerAddress: string,
  balanceBefore: bigint,
  expectedCredit: bigint,
) {
  const deadline = Date.now() + 60_000
  let lastError: unknown = null

  while (Date.now() < deadline) {
    try {
      const current = await readSolanaUsdcRawBalance(ownerAddress)
      if (current >= balanceBefore + expectedCredit) {
        return current
      }
      lastError = null
    } catch (error) {
      lastError = error
    }

    await delay(1_000)
  }

  if (lastError instanceof Error) {
    throw new Error(
      `Solana mint confirmation timed out after transient balance-read errors: ${lastError.message}`,
    )
  }

  throw new Error(
    'Solana mint transaction was submitted, but the expected USDC credit was not observed before timeout.',
  )
}

async function waitForArcCctpAttestation(sourceTxHash: Hex) {
  const deadline = Date.now() + 180_000
  let lastError: unknown = null

  while (Date.now() < deadline) {
    try {
      const attestation = await fetchMainnetCctpAttestation({
        sourceChainId: ARC_MAINNET_EVM_CHAIN_ID,
        transactionHash: sourceTxHash,
      })

      if (
        attestation.status === 'complete'
        && attestation.message
        && attestation.attestation
        && attestation.eventNonce
      ) {
        return attestation
      }

      lastError = null
    } catch (error) {
      lastError = error
    }

    await delay(2_000)
  }

  if (lastError instanceof Error) {
    throw new Error(
      `Circle attestation did not become ready before timeout: ${lastError.message}`,
    )
  }

  throw new Error('Circle attestation did not become ready before timeout.')
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

export type MainnetSolanaFeeEstimate = {
  binding?: SolanaFeeBinding
  amount: string
  bridgeFee: string
  networkFeeUsdc: string
  totalUsdcFees: string
  receiveAmount: string
  netUsdcAfterFees: string
  solanaTxFeeSol: string | null
  solanaEventRentSol: string | null
  solanaUpfrontSol: string | null
  solanaEventRentRefundableAfterDays: number | null
  fees: Array<{
    type: string
    amount: string | null
    token: string
  }>
  gasFees: Array<{
    name: string
    amount: string | null
    token: string
  }>
}

function normalizeSolanaFeeEstimate(
  estimate: EstimateResult,
  fallbackAmount: string,
): MainnetSolanaFeeEstimate {
  const rawEstimate = estimate as any
  const amount = typeof rawEstimate?.amount === 'string'
    ? rawEstimate.amount
    : fallbackAmount

  let totalUsdcFeeRaw = 0n

  const fees = Array.isArray(rawEstimate?.fees)
    ? rawEstimate.fees.map((fee: any) => {
        const token = String(fee?.token ?? '')
        const feeAmount = typeof fee?.amount === 'string' ? fee.amount : null

        if (feeAmount && token.toUpperCase() === 'USDC') {
          try {
            totalUsdcFeeRaw += parseUnits(feeAmount, 6)
          } catch {
            // Keep the raw SDK value visible even when it cannot be normalized.
          }
        }

        return {
          type: String(fee?.type ?? 'fee'),
          amount: feeAmount,
          token: token || 'USDC',
        }
      })
    : []

  let networkUsdcFeeRaw = 0n

  const gasFees = Array.isArray(rawEstimate?.gasFees)
    ? rawEstimate.gasFees.map((gasFee: any) => {
        const amount = typeof gasFee?.fees?.fee === 'string'
          ? gasFee.fees.fee
          : gasFee?.fees?.fee != null
            ? String(gasFee.fees.fee)
            : null
        const token = String(gasFee?.token ?? '')

        if (amount && token.toUpperCase() === 'USDC') {
          try {
            networkUsdcFeeRaw += parseUnits(amount, 6)
          } catch {
            // Keep the SDK value visible even when it cannot be normalized.
          }
        }

        return {
          name: String(gasFee?.name ?? 'Network fee'),
          amount,
          token,
        }
      })
    : []

  let amountRaw = 0n
  try {
    amountRaw = parseUnits(amount, 6)
  } catch {
    amountRaw = parseUnits(fallbackAmount, 6)
  }

  const receiveRaw = amountRaw > totalUsdcFeeRaw
    ? amountRaw - totalUsdcFeeRaw
    : 0n
  const totalUsdcFeesRaw = totalUsdcFeeRaw + networkUsdcFeeRaw
  const netUsdcAfterFeesRaw = receiveRaw > networkUsdcFeeRaw
    ? receiveRaw - networkUsdcFeeRaw
    : 0n

  let solanaTxFeeRaw = 0n
  for (const gasFee of gasFees) {
    if (gasFee.amount && gasFee.token.toUpperCase() === 'SOL') {
      try {
        solanaTxFeeRaw += parseUnits(gasFee.amount, 9)
      } catch {
        // Keep the SDK value visible even when it cannot be normalized.
      }
    }
  }

  return {
    amount,
    bridgeFee: formatUnits(totalUsdcFeeRaw, 6),
    networkFeeUsdc: formatUnits(networkUsdcFeeRaw, 6),
    totalUsdcFees: formatUnits(totalUsdcFeesRaw, 6),
    receiveAmount: formatUnits(receiveRaw, 6),
    netUsdcAfterFees: formatUnits(netUsdcAfterFeesRaw, 6),
    solanaTxFeeSol: solanaTxFeeRaw > 0n ? formatUnits(solanaTxFeeRaw, 9) : null,
    solanaEventRentSol: null,
    solanaUpfrontSol: null,
    solanaEventRentRefundableAfterDays: null,
    fees,
    gasFees,
  }
}

// Bridge Kit's Solana signer checks every transaction against Machina's own transfer context before
// Phantom sees it (src/lib/solanaBridgeTxPolicy.ts); the expectation never comes from the SDK or RPC.
function solanaTxExpectation(direction: MainnetSolanaCanaryDirection, amount: string, evmAddress: string, phantomAddress: string): SolanaTxExpectation {
  const amountRaw = parseUnits(amount, 6)
  return direction === 'solana-to-arc'
    ? { kind: 'burn', owner: phantomAddress, amountRaw, evmRecipient: evmAddress }
    : { kind: 'receive', owner: phantomAddress, amountRaw }
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

function extractBridgeStepTxHash(step: any) {
  if (!step || typeof step !== 'object') return undefined

  const values = step.values && typeof step.values === 'object'
    ? step.values as Record<string, unknown>
    : undefined

  return (
    (typeof step.txHash === 'string' ? step.txHash : undefined)
    || (typeof step.transactionHash === 'string' ? step.transactionHash : undefined)
    || (typeof step.hash === 'string' ? step.hash : undefined)
    || (typeof values?.txHash === 'string' ? values.txHash : undefined)
    || (typeof values?.transactionHash === 'string' ? values.transactionHash : undefined)
    || (typeof values?.signature === 'string' ? values.signature : undefined)
  )
}

function getBridgeResultTxHashes(result: any) {
  const steps = Array.isArray(result?.steps) ? result.steps : []

  const findStep = (keywords: string[]) =>
    steps.find((step: any) => {
      const name = String(step?.name ?? step?.id ?? step?.type ?? '').toLowerCase()
      return keywords.some((keyword) => name.includes(keyword))
    })

  const sourceStep = findStep(['burn', 'depositforburn'])
  const destinationStep = findStep(['mint', 'receive', 'reclaim'])

  return {
    sourceTxHash:
      (typeof result?.sourceTxHash === 'string' ? result.sourceTxHash : undefined)
      || extractBridgeStepTxHash(sourceStep),
    destinationTxHash:
      (typeof result?.destinationTxHash === 'string' ? result.destinationTxHash : undefined)
      || (typeof result?.receiveTxHash === 'string' ? result.receiveTxHash : undefined)
      || extractBridgeStepTxHash(destinationStep),
  }
}

function computeActualUsdcCost(
  beforeArc: string | null,
  beforeSolana: string | null,
  afterArc: string | null,
  afterSolana: string | null,
) {
  if (!beforeArc || !beforeSolana || !afterArc || !afterSolana) return undefined

  try {
    const beforeTotal = parseUnits(beforeArc, 6) + parseUnits(beforeSolana, 6)
    const afterTotal = parseUnits(afterArc, 6) + parseUnits(afterSolana, 6)
    const cost = beforeTotal > afterTotal ? beforeTotal - afterTotal : 0n
    return formatUnits(cost, 6)
  } catch {
    return undefined
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
  const recoveryContext = useRef('')
  recoveryContext.current = `${evmAddress?.toLowerCase() ?? ''}|${phantomAddress ?? ''}`
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
  const [feeEstimate, setFeeEstimate] = useState<MainnetSolanaFeeEstimate | null>(null)
  const [feeEstimateError, setFeeEstimateError] = useState<string | null>(null)
  const [isEstimatingFees, setIsEstimatingFees] = useState(false)
  const feeQuote = useRef<MainnetSolanaFeeEstimate | null>(null)
  const feeRequest = useRef(0)
  const g1Live = useRef({ evmAddress, phantomAddress, walletClient, phantomProvider })
  if (g1Live.current.evmAddress !== evmAddress || g1Live.current.phantomAddress !== phantomAddress
    || g1Live.current.walletClient !== walletClient || g1Live.current.phantomProvider !== phantomProvider) {
    // Invalidate synchronously, including disconnect/reconnect of the same account.
    feeQuote.current = null
    feeRequest.current++
  }
  g1Live.current = { evmAddress, phantomAddress, walletClient, phantomProvider }
  useEffect(() => { setFeeEstimate(null); setIsEstimatingFees(false) }, [evmAddress, phantomAddress, walletClient, phantomProvider])
  const feeEstimateIssue = useCallback((direction: MainnetSolanaCanaryDirection, amount: string) =>
    solanaFeeEstimateIssue(feeQuote.current, { direction, amount, evmWallet: g1Live.current.evmAddress, solanaWallet: g1Live.current.phantomAddress }), [])

  // One in-flight recent-burn scan per wallet pair (a scan for other wallets is never reused).
  const pendingScan = useRef(keyedSingleFlight<Hex | null>())

  const kitSupport = useMemo(() => {
    try {
      const kit = new BridgeKit({ disableErrorReporting: true })
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
    const scanKey = `${evmAddress.toLowerCase()}|${phantomAddress}`
    // A result for wallets that are no longer connected never touches the screen.
    const current = () => recoveryContext.current === scanKey

    const scan = async () => {
      if (current()) setPendingArcToSolanaError(null)

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

        let unverified: Hex | undefined
        const chunkSize = 500n
        const maxChunks = 8
        let checkedCandidates = 0

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
            )
          })

          for (const match of matches as any[]) {
            if (++checkedCandidates > 20) { setPendingArcToSolanaError('The bounded recent scan reached its limit. Enter the source transaction hash to recover an older burn.'); return null }
            const txHash = match.transactionHash as Hex | undefined
            if (!txHash) continue

            const tx = await client.getTransaction({ hash: txHash })
            if (tx.from.toLowerCase() !== evmAddress.toLowerCase() || recovered.has(txHash.toLowerCase())) {
              continue
            }

            // Mint-ready only with the full CCTP evidence; see classifyArcSolanaBurn.
            const verdict = await classifyArcSolanaBurn(ownerHex, {
              proof: () => readCctpBurnProof({ sourceChainId: ARC_MAINNET_EVM_CHAIN_ID, sourceTxHash: txHash, owner: evmAddress, mintRecipients: [ownerHex, ataHex], allowCircleKitBridge: true }),
              attestation: (proof) => readBoundCctpAttestation(proof as Parameters<typeof readBoundCctpAttestation>[0]),
              nonceUsed: isSolanaCctpMessageAlreadyMinted,
            })
            if (verdict.kind === 'not_ours') continue
            if (verdict.kind === 'complete') {
              recovered.add(txHash.toLowerCase())
              try {
                window.localStorage.setItem(RECOVERED_ARC_SOLANA_TXS_KEY, JSON.stringify(Array.from(recovered)))
              } catch {
                // On-chain nonce proof is authoritative; local persistence is best-effort.
              }
              if (!readMainnetSolanaActivity().some(x => x.direction === 'arc-to-solana' && x.sourceTxHash?.toLowerCase() === txHash.toLowerCase())) {
                recordMainnetSolanaActivity({ evmWallet: evmAddress, solanaWallet: phantomAddress, direction: 'arc-to-solana', amount: verdict.amount, sourceTxHash: txHash, status: 'complete' })
              }
              continue
            }
            if (verdict.kind !== 'mint_ready') {
              // Not proven either way (Circle still attesting, nonce settling, RPC trouble): never shown as pending.
              unverified ??= txHash
              continue
            }

            if (!current()) return null
            setPendingArcToSolanaTx(txHash)
            return txHash
          }

          if (chunkFrom === 0n) break
          await delay(650)
        }

        if (!current()) return null
        setPendingArcToSolanaTx(null)
        if (unverified) setPendingArcToSolanaError(`A recent Arc → Solana transfer (${unverified.slice(0, 10)}…${unverified.slice(-6)}) is not verified yet: Circle may still be attesting it or Solana is confirming it. Nothing is sent; it is checked again automatically.`)
        return null
      } catch {
        if (current()) setPendingArcToSolanaError('The recent transfer check could not read the network. Nothing is sent; it is checked again automatically.')
        throw new Error('Pending Arc to Solana burn scan failed.')
      }
    }

    return pendingScan.current(scanKey, scan)
  }, [evmAddress, phantomAddress])

  // An older pending/unknown receive record without a saved signature: shown for manual review.
  const [arcSolanaReceiveReview, setArcSolanaReceiveReview] = useState<(LegacyReview & { message: string; owner: string }) | null>(null)
  const recoverPendingArcToSolana = useCallback(async (sourceTxHashOverride?: Hex) => {
    const sourceTxHash =
      sourceTxHashOverride
      || pendingArcToSolanaTx
      || await findPendingArcToSolanaBurn()
    if (!sourceTxHash) throw new Error('No Arc to Solana burn was found for the connected wallets.')
    if (!phantomProvider || !phantomAddress || !evmAddress) throw new Error('Connect the original EVM and Phantom wallets first.')
    if (!isMainnetSolanaCanaryWriteEnabled('arc-to-solana')) throw new Error('Arc to Solana receive is switched off.')
    if (!navigator.locks) throw new Error('A safe browser transaction lock is required for recovery.')
    const expectedContext = recoveryContext.current
    // Normal SDK mint holds these same wallet locks through ATA + receive.
    // Recovery must not race a still-running normal transfer in another tab.
    return navigator.locks.request(`machina-solana-send:evm:${evmAddress.toLowerCase()}`, {ifAvailable:true}, async evmLock=>{
    if (!evmLock) throw new Error('A transfer is still running for these wallets. Check Activity before recovery.')
    return navigator.locks.request(`machina-solana-send:sol:${phantomAddress}`, {ifAvailable:true}, async solLock=>{
    if (!solLock) throw new Error('A transfer is still running for these wallets. Check Activity before recovery.')
    return navigator.locks.request(`machina-arc-solana-recovery:${sourceTxHash}`, {ifAvailable:true}, async lock=>{
    if (!lock) throw new Error('Another tab is processing this burn; no second mint was requested.')

    setState({
      isLoading: true,
      error: null,
      status: 'Recovering the existing Arc burn. No new burn will be created...',
      result: { sourceTxHash },
    })

    try {
      setState({
        isLoading: true,
        error: null,
        status: 'Arc burn confirmed. Waiting for Circle attestation...',
        result: { sourceTxHash },
      })

      const { ownerHex, ataHex } = deriveSolanaUsdcAta(phantomAddress, 'mainnet')
      const proof = await readCctpBurnProof({sourceChainId:ARC_MAINNET_EVM_CHAIN_ID,sourceTxHash,owner:evmAddress,mintRecipients:[ownerHex,ataHex],allowCircleKitBridge:true})
      if (proof.fields.destinationDomain !== 5 || !['0x'+'00'.repeat(32),ownerHex.toLowerCase()].includes(proof.fields.destinationCaller)) throw new Error('This burn does not authorize the connected Phantom destination.')
      const attestation = await readBoundCctpAttestation(proof)
      if (attestation.status !== 'complete' || !attestation.message || !attestation.attestation) throw new Error('Source burn verified, but Circle attestation is still pending. No mint was requested.')
      const mintRecipient = proof.fields.mintRecipient
      const prior = readMainnetSolanaActivity().find(x=>x.direction === 'arc-to-solana' && x.sourceTxHash?.toLowerCase() === sourceTxHash.toLowerCase())
      if (await isSolanaCctpMessageAlreadyMinted(attestation.message)) {
        recordMainnetSolanaActivity({evmWallet:evmAddress,solanaWallet:phantomAddress,direction:'arc-to-solana',amount:proof.amount,sourceTxHash,status:'complete'})
        setState({isLoading:false,error:null,status:'Destination nonce proves this burn was already received. No second mint was requested.',result:{sourceTxHash,recovered:true}})
        return {sourceTxHash,recovered:true}
      }
      // The receive journal decides from chain evidence (nonce, signature, blockhash) whether an earlier
      // attempt could still land; an older record without that evidence needs the manual review.
      let gate
      try {
        gate = await openReceiveAttempt({ sourceTxHash, owner: phantomAddress, message: attestation.message, legacyActivityStatus: prior?.status }, arcSolanaReceiveReads)
      } catch (error) {
        if (error instanceof LegacyReceiveReviewRequired) {
          const review = await reviewLegacyReceive(sourceTxHash, attestation.message, arcSolanaReceiveReads)
          setArcSolanaReceiveReview({ ...review, message: attestation.message, owner: phantomAddress })
        }
        throw error
      }
      if (gate.kind === 'already-received') {
        recordMainnetSolanaActivity({evmWallet:evmAddress,solanaWallet:phantomAddress,direction:'arc-to-solana',amount:proof.amount,sourceTxHash,status:'complete'})
        setArcSolanaReceiveReview(null)
        setState({isLoading:false,error:null,status:'Destination nonce proves this burn was already received. No second mint was requested.',result:{sourceTxHash,recovered:true}})
        return {sourceTxHash,recovered:true}
      }
      const receiveEntryId = gate.entryId

      const kit = new BridgeKit({ disableErrorReporting: true })
      const { solana, arc } = resolveChains(kit)
      const solanaBridgeChain = {
        ...(solana as any),
        rpcEndpoints: [SOLANA_BRIDGE_SDK_RPC],
      } as BridgeKitChain
      const solanaAdapter = await createSolanaAdapterFromProvider({
        connection: createSolanaBridgeConnection(window.location.origin),
        // G2 validates before the evidence signer records any wallet request.
        provider: createStrictSolanaProvider(createReceiveEvidenceSigner(phantomProvider, receiveEntryId) as unknown as PhantomSolanaProvider, { kind: 'receive', owner: phantomAddress, amountRaw: proof.fields.amount, exactMessage: attestation.message }),
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
          mintRecipient,
          fromChain: arc,
          toChain: solanaBridgeChain,
        },
        { chain: solanaBridgeChain, address: phantomAddress },
      )
      if (!action?.execute) throw new Error('Solana receiveMessage action could not be prepared.')

      if (recoveryContext.current !== expectedContext || phantomProvider.publicKey?.toBase58() !== phantomAddress) throw new Error('The connected wallet changed. No destination request is allowed.')
      // Persist uncertainty before the wallet request. Reload cannot silently authorize a second send.
      const attempt = recordMainnetSolanaActivity({evmWallet:evmAddress,solanaWallet:phantomAddress,direction:'arc-to-solana',amount:proof.amount,sourceTxHash,status:'pending'})
      if (!readMainnetSolanaActivity().some(x=>x.id===attempt.id && x.status==='pending')) throw new Error('Recovery record could not be persisted. No wallet request is allowed.')
      let destinationTxHash: string
      try { destinationTxHash = await action.execute() } catch(e) {
        // Only a refusal before the wallet or an explicit wallet rejection counts as "not sent";
        // any other SDK/RPC error stays unknown until chain evidence settles it.
        const settled = classifyFailedAttempt(receiveEntryId, e)
        updateMainnetSolanaActivity(attempt.id,{status:settled.phase==='failed'?'failed':'unknown'})
        throw e
      }
      updateReceiveEntry(receiveEntryId, { phase: 'sent' })
      updateMainnetSolanaActivity(attempt.id,{destinationTxHash,status:'pending'})
      const deadline = Date.now()+60_000
      let confirmed = false
      while (Date.now()<deadline) {
        const receipt = await solanaReadRpc('getSignatureStatuses',[[destinationTxHash],{searchTransactionHistory:true}])
        const status = receipt?.value?.[0]
        if (status?.err) { updateMainnetSolanaActivity(attempt.id,{status:'failed'}); throw new Error('Solana destination mint failed. Recheck before any new request.') }
        if (['confirmed','finalized'].includes(status?.confirmationStatus)) {
          try { if (await isSolanaCctpMessageAlreadyMinted(attestation.message)) { confirmed=true; break } }
          catch(e) { if (!(e instanceof SolanaNoncePendingError)) throw e }
        }
        await delay(2000)
      }
      if (!confirmed) throw new Error('Destination transaction outcome is not yet independently verified. Do not send again.')
      updateMainnetSolanaActivity(attempt.id,{status:'complete'})
      updateReceiveEntry(receiveEntryId, { phase: 'complete' })
      setArcSolanaReceiveReview(null)

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
      return {
        sourceTxHash,
        destinationTxHash,
        recovered: true,
      }
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
    })
    })
    })
  }, [
    evmAddress,
    findPendingArcToSolanaBurn,
    pendingArcToSolanaTx,
    phantomAddress,
    phantomProvider,
    refreshArcBalance,
    refreshSolanaBalance,
  ])

  const estimateCanary = useCallback(async (
    direction: MainnetSolanaCanaryDirection,
    amount: string,
  ) => {
    const requestId = ++feeRequest.current
    const startedAt = Date.now()
    feeQuote.current = null
    if (direction === 'solana-to-arc') setFeeEstimate(null)
    setIsEstimatingFees(true)
    setFeeEstimateError(null)

    try {
      // Only the canonical decimal from parseUsdcAmountInput reaches a quote or a signature.
      if (!/^\d+(\.\d{1,6})?$/.test(amount)) throw new Error('Enter a valid USDC amount (up to 6 decimals).')
      const amountRaw = parseUnits(amount, 6)
      if (amountRaw <= 0n) {
        throw new Error('Transfer amount must be greater than 0 USDC.')
      }

      if (!evmAddress || !walletClient) {
        throw new Error('Connect the Arc wallet first.')
      }

      if (!phantomProvider || !phantomAddress) {
        throw new Error('Connect Phantom first.')
      }

      const kit = new BridgeKit({ disableErrorReporting: true })
      const { solana, arc } = resolveChains(kit)
      const solanaBridgeChain = {
        ...(solana as any),
        rpcEndpoints: [SOLANA_BRIDGE_SDK_RPC],
      } as BridgeKitChain

      const solanaAdapter = await createSolanaAdapterFromProvider({
        connection: createSolanaBridgeConnection(window.location.origin),
        provider: createReadOnlySolanaProvider(phantomProvider, solanaTxExpectation(direction, amount, evmAddress, phantomAddress)),
        capabilities: {
          addressContext: 'user-controlled',
          supportedChains: [solanaBridgeChain],
        },
      })
      const evmAdapter = await createEvmAdapterFromProvider({
        provider: createEvmBridgePolicyProvider(createStrictEvmProvider(walletClient as WalletClientLike), { mode: 'read', owner: evmAddress, solanaOwner: phantomAddress, amount: amountRaw, maxFee: 0n, finality: 1000, current: () => true }),
      })

      const estimate = direction === 'solana-to-arc'
        ? await kit.estimate({
            from: { adapter: solanaAdapter, chain: solanaBridgeChain },
            to: { adapter: evmAdapter, chain: arc, recipientAddress: evmAddress },
            amount,
          } as any)
        : await kit.estimate({
            from: { adapter: evmAdapter, chain: arc },
            to: { adapter: solanaAdapter, chain: solanaBridgeChain, recipientAddress: phantomAddress },
            amount,
          } as any)

      if (direction === 'solana-to-arc') validateSolanaSdkFees(estimate)
      const normalized = normalizeSolanaFeeEstimate(estimate, amount)
      normalized.binding = { direction, evmWallet: evmAddress, solanaWallet: phantomAddress, checkedAt: startedAt }

      if (direction === 'solana-to-arc') {
        // Circle CCTP V2 stores the source MessageSent event in a temporary
        // Solana account. For a standard burn with empty hookData, the current
        // MessageSent account layout is 428 bytes.
        const rentRequestBody = JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'getMinimumBalanceForRentExemption',
          params: [428, { commitment: 'confirmed' }],
        })

        const readRentLamports = async (url: string) => {
          const response = await fetch(url, {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              accept: 'application/json',
            },
            body: rentRequestBody,
          })

          const payload = await response.json().catch(() => null)
          return response.ok && Number.isFinite(Number(payload?.result))
            ? BigInt(payload.result)
            : null
        }

        let rentLamports = await readRentLamports('/api/solana-rpc')

        // Vite dev does not serve Vercel API routes. Fall back to the same
        // public Solana RPC already used by the primary balance reader so
        // local UI estimates remain complete without Vercel dev.
        if (rentLamports === null && import.meta.env.DEV) {
          rentLamports = await readRentLamports('https://solana-rpc.publicnode.com')
        }

        if (rentLamports !== null) {
          const txFeeLamports = normalized.solanaTxFeeSol
            ? parseUnits(normalized.solanaTxFeeSol, 9)
            : 0n
          normalized.solanaEventRentSol = formatUnits(rentLamports, 9)
          normalized.solanaUpfrontSol = formatUnits(rentLamports + txFeeLamports, 9)
          normalized.solanaEventRentRefundableAfterDays = 5
        }
      }

      if (requestId !== feeRequest.current || g1Live.current.evmAddress !== evmAddress || g1Live.current.phantomAddress !== phantomAddress
        || g1Live.current.walletClient !== walletClient || g1Live.current.phantomProvider !== phantomProvider) throw new Error('The fee request changed. Recalculate fees.')
      if (direction === 'solana-to-arc') assertSolanaFeeEstimate(normalized, { direction, amount, evmWallet: evmAddress, solanaWallet: phantomAddress })
      feeQuote.current = normalized
      setFeeEstimate(normalized)
      return normalized
    } catch (error) {
      const message = error instanceof Error
        ? error.message
        : 'Fee estimate is unavailable.'
      if (requestId === feeRequest.current) {
        feeQuote.current = null
        setFeeEstimate(null)
        setFeeEstimateError(message)
      }
      throw error
    } finally {
      if (requestId === feeRequest.current) setIsEstimatingFees(false)
    }
  }, [
    evmAddress,
    phantomAddress,
    phantomProvider,
    walletClient,
  ])


  const runCanary = useCallback(async (
    direction: MainnetSolanaCanaryDirection,
    amount: string,
  ) => {
    let sourceStage: SolanaSourceStage = 'preparing'
    let sourceExecutionStarted = false
    let sourceFeeError: string | null = null
    let normalReceive: ReturnType<typeof createBoundReceiveSigner<PhantomSolanaProvider>> | undefined
    let preparationStep: 'solana-adapter' | 'arc-network' | 'evm-adapter' | 'bridge-kit' = 'solana-adapter'
    const safePreWalletFailure = (cause?: unknown) => {
      if (sourceFeeError) return sourceFeeError
      if (sourceStage !== 'preparing') return solanaSourceFailure(sourceStage)
      const errorName = cause && typeof cause === 'object' ? (cause as { name?: unknown }).name : undefined
      const safeType = errorName === 'EvmBridgePolicyError' ? 'EVM_POLICY'
        : errorName === 'SolanaTxPolicyError' ? 'SOLANA_POLICY'
        : errorName === 'UserRejectedRequestError' ? 'WALLET_REJECTION'
        : 'UNCLASSIFIED'
      return `Solana transfer stopped before Phantom signing [${preparationStep.toUpperCase()}/${safeType}]. No automatic retry was made.`
    }
    if (direction === 'arc-to-solana') {
      setPendingArcToSolanaTx(null)
      setPendingArcToSolanaError(null)
    }

    setState({ isLoading: true, error: null, status: 'Preparing transfer...', result: null })

    try {
      if (!MAINNET_SOLANA_CCTP_CANARY_ENABLED) {
        throw new Error('Solana mainnet bridge is currently unavailable.')
      }

      if (!isMainnetSolanaCanaryWriteEnabled(direction)) {
        throw new Error(`${direction} route is read-only.`)
      }

      // Only the canonical decimal from parseUsdcAmountInput reaches a quote or a signature.
      if (!/^\d+(\.\d{1,6})?$/.test(amount)) throw new Error('Enter a valid USDC amount (up to 6 decimals).')
      const amountRaw = parseUnits(amount, 6)
      if (amountRaw <= 0n) {
        throw new Error('Transfer amount must be greater than 0 USDC.')
      }

      if (!evmAddress || !walletClient) {
        throw new Error('Connect the EVM wallet used for Arc first.')
      }

      if (!phantomProvider || !phantomAddress) {
        throw new Error('Connect Phantom on Solana mainnet first.')
      }

      // Authorize the reviewed fee BEFORE B1 creates a journal or any adapter/wallet call.
      const approvedFee = direction === 'solana-to-arc' ? feeQuote.current : null
      const checkFee = () => {
        if (direction !== 'solana-to-arc') return
        sourceFeeError = feeQuote.current !== approvedFee
          ? 'The fee estimate changed. Recalculate fees and review again.'
          : solanaFeeEstimateIssue(approvedFee, { direction, amount, evmWallet: g1Live.current.evmAddress, solanaWallet: g1Live.current.phantomAddress })
        if (sourceFeeError) throw new Error(sourceFeeError)
      }
      checkFee()
      const approvedMaxFee = direction === 'solana-to-arc'
        ? assertSolanaFeeEstimate(approvedFee, { direction, amount, evmWallet: evmAddress, solanaWallet: phantomAddress })
        : feeEstimate?.amount === amount ? parseUnits(feeEstimate.bridgeFee, 6) : 0n

      // One transfer per wallet across tabs, recorded before any wallet request; an earlier burn
      // with an unknown outcome blocks a new one until chain evidence settles it.
      return await withSolanaSendGuard({ direction, amount, evmWallet: evmAddress, solanaWallet: phantomAddress,
        onSourceStage: stage => { sourceStage = stage },
        beforePrepare: checkFee,
      }, async guard => {
        checkFee()
        sourceExecutionStarted = true
        const solanaPolicy = solanaTxExpectation(direction, amount, evmAddress, phantomAddress)
        const kit = new BridgeKit({ disableErrorReporting: true })
        const { solana, arc } = resolveChains(kit)
        // SDK capability probes derive WSS from rpcEndpoint, not wsEndpoint.
        // The connection's fetch port sends HTTP to our same-origin proxy.
        const solanaBridgeChain = {
          ...(solana as any),
          rpcEndpoints: [SOLANA_BRIDGE_SDK_RPC],
        } as BridgeKitChain

        const attemptId = readSolanaSendAttempts().find(a => a.direction === direction && a.evmWallet.toLowerCase() === evmAddress.toLowerCase() && a.solanaWallet === phantomAddress && a.phase === 'prepared')?.id
        const current = () => g1Live.current.evmAddress === evmAddress && g1Live.current.phantomAddress === phantomAddress && g1Live.current.walletClient === walletClient
        if (direction === 'arc-to-solana') {
          normalReceive = createBoundReceiveSigner(phantomProvider, {
            reads: arcSolanaReceiveReads,
            prepare: async () => {
              if (!current()) throw new Error('The connected wallets changed. No receive was requested.')
              const source = readSolanaSendAttempts().find(a => a.id === attemptId)?.burnTxHash
              if (!source) throw new Error('The current Arc burn has no transaction proof. Check Activity before receiving.')
              const { ownerHex, ataHex } = deriveSolanaUsdcAta(phantomAddress, 'mainnet')
              const proof = await readCctpBurnProof({ sourceChainId: ARC_MAINNET_EVM_CHAIN_ID, sourceTxHash: source as Hex, owner: evmAddress, mintRecipients: [ownerHex, ataHex], allowCircleKitBridge: true })
              if (proof.fields.amount !== amountRaw || proof.fields.maxFee > approvedMaxFee || proof.fields.destinationDomain !== 5) throw new Error('The source burn differs from this transfer. No receive was requested.')
              const attestation = await readBoundCctpAttestation(proof)
              if (!current() || attestation.status !== 'complete' || !attestation.message) throw new Error('The bound Circle attestation is not ready. Recover this burn from Activity.')
              return { sourceTxHash: source, owner: phantomAddress, message: attestation.message }
            },
            validate: (tx, message) => assertSolanaBridgeSigningRequest(phantomProvider, tx, { kind: 'receive', owner: phantomAddress, amountRaw, exactMessage: message }),
          })
        }

        preparationStep = 'solana-adapter'
        const signingProvider = normalReceive ? normalReceive as unknown as PhantomSolanaProvider : phantomProvider
        const solanaAdapter = await createSolanaAdapterFromProvider({
          connection: createSolanaBridgeConnection(window.location.origin),
          provider: guard.solana(createStrictSolanaProvider(signingProvider, solanaPolicy), tx => { checkFee(); assertSolanaBridgeSigningRequest(phantomProvider, tx, solanaPolicy) }),
          capabilities: {
            addressContext: 'user-controlled',
            supportedChains: [solanaBridgeChain],
          },
        })
        const raw = createStrictEvmProvider(walletClient as WalletClientLike)
        const request = async (args: { method: string; params?: unknown[] }) =>
          walletClient.transport.request(args as never)

        checkFee()
        preparationStep = 'arc-network'
        await addChainToWallet(ARC_MAINNET_EVM_CHAIN, request)

        const maxFee = approvedMaxFee
        preparationStep = 'evm-adapter'
        const evmAdapter = await createEvmAdapterFromProvider({
          provider: createEvmBridgePolicyProvider(guard.evm(raw), {
            mode: direction === 'arc-to-solana' ? 'burn' : 'receive', owner: evmAddress, solanaOwner: phantomAddress, amount: amountRaw, maxFee, finality: 1000, current,
            receive: async () => {
              const candidates = readSolanaSendAttempts().filter(a => a.id === attemptId && a.direction === 'solana-to-arc' && a.evmWallet.toLowerCase() === evmAddress.toLowerCase() && a.solanaWallet === phantomAddress && a.amount === amount && a.solanaSignature)
              if (candidates.length !== 1) throw new Error('No unique current Solana burn proof for the Arc receive.')
              const proof = await inspectSolanaToArcRecovery({ signature: candidates[0].solanaSignature!, solanaOwner: phantomAddress, evmOwner: evmAddress }, solanaArcRecoveryPorts())
              if (proof.stage !== 'ready_to_mint' || !proof.message || !proof.attestation || parseUnits(proof.amount, 6) !== amountRaw || parseUnits(proof.feeUsdc ?? '0', 6) > maxFee) throw new Error('Arc receive proof unavailable.')
              return { message: proof.message, attestation: proof.attestation }
            },
          }),
        })

        const [arcBalanceBefore, solanaBalanceBefore] = await Promise.all([
          refreshArcBalance().catch(() => null),
          refreshSolanaBalance().catch(() => null),
        ])

        setState((previous) => ({
          ...previous,
          status: direction === 'solana-to-arc'
            ? 'Confirm the Solana mainnet CCTP transfer in Phantom.'
            : 'Confirm the Arc mainnet CCTP transfer in your EVM wallet.',
        }))

        checkFee()
        preparationStep = 'bridge-kit'
        const result = direction === 'solana-to-arc'
          ? await kit.bridge({
              from: { adapter: solanaAdapter, chain: solanaBridgeChain },
              to: { adapter: evmAdapter, chain: arc, recipientAddress: evmAddress },
              amount,
              config: { maxFee: formatUnits(maxFee, 6) },
            } as any)
          : await kit.bridge({
              from: { adapter: evmAdapter, chain: arc },
              to: { adapter: solanaAdapter, chain: solanaBridgeChain, recipientAddress: phantomAddress },
              amount,
              config: { maxFee: formatUnits(maxFee, 6) },
            } as any)

        const finalResult = result as any

        if (finalResult?.state === 'error') {
          if (direction === 'arc-to-solana') {
            normalReceive?.fail(finalResult.error)
            const attempt = readSolanaSendAttempts().find(a => a.id === attemptId)
            const settled = attempt ? await settleSolanaSendAttempt(attempt) : null
            const candidate = settled?.verdict.kind === 'burned' ? settled.verdict.txHash as Hex : null
            let sourceTxHash: Hex | null = null
            if (candidate) {
              try {
                const { ownerHex, ataHex } = deriveSolanaUsdcAta(phantomAddress, 'mainnet')
                const proof = await readCctpBurnProof({ sourceChainId: ARC_MAINNET_EVM_CHAIN_ID, sourceTxHash: candidate, owner: evmAddress, mintRecipients: [ownerHex, ataHex], allowCircleKitBridge: true })
                if (proof.fields.amount === amountRaw && proof.fields.destinationDomain === 5 && proof.fields.maxFee <= approvedMaxFee) sourceTxHash = candidate
              } catch { /* A successful receipt alone is not proof of the reviewed CCTP burn. */ }
            }
            if (sourceTxHash) setPendingArcToSolanaTx(sourceTxHash)
            // Never automatically ask Phantom again after a refusal, expiry or
            // uncertain mint. Recovery is an explicit, evidence-gated action.
            const pending = { ...finalResult, direction, ...(candidate ? { sourceTxHash: candidate } : {}), sourceBurnVerified: Boolean(sourceTxHash), destinationVerified: false }
            setState({ isLoading: false, error: sourceTxHash ? null : getBridgeKitErrorMessage(finalResult), status: sourceTxHash ? 'The Arc burn is verified. Solana receive is not verified. Use Activity to recover this existing burn; no second wallet request was made.' : 'The source outcome is not yet verified. Check Activity before trying again.', result: pending })
            return pending
          }

          // Never retry a Solana source error: provider-cctp-v2 can restart the burn.
          // B1 retains the signature/unknown request; Activity's independent source proof
          // is required before a destination-only recovery can ask for a wallet action.
          const attempt = readSolanaSendAttempts().find(a => a.id === attemptId)
          const settled = attempt ? await settleSolanaSendAttempt(attempt) : null
          if (settled?.verdict.kind === 'burned') {
            const pendingResult = { ...finalResult, direction, sourceTxHash: settled.verdict.txHash, destinationVerified: false }
            setState({ isLoading: false, error: null, status: 'The Solana burn is verified. Arc receive is not yet verified; use Activity to recover this existing burn. Do not send again.', result: pendingResult })
            return pendingResult
          }
          // Chain evidence (a landed transaction with an error, or an expired blockhash) proves this
          // signed burn moved no USDC; the attempt is released, so a fresh transfer is safe.
          if (sourceStage === 'wallet-signed' && settled?.verdict.kind === 'not-sent') {
            setState({ isLoading: false, error: `${settled.verdict.reason} You can start the transfer again.`, status: null, result: finalResult })
            return finalResult
          }
          setState({ isLoading: false, error: safePreWalletFailure(finalResult?.error), status: null, result: finalResult })
          return finalResult
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

        const txHashes = getBridgeResultTxHashes(finalResult)
        // "Completed" only with the receive proven on the destination chain; otherwise pending.
        setState({ isLoading: true, error: null, status: 'Verifying the receive on the destination chain...', result: finalResult })
        const { ownerHex: solOwnerHex, ataHex: solAtaHex } = deriveSolanaUsdcAta(phantomAddress, 'mainnet')
        const destination = await verifyTransferDestinationWithRetry(
          { direction, ...txHashes, evmWallet: evmAddress, solanaWallet: phantomAddress, amountRaw: parseUnits(amount, 6), solanaRecipients: [solOwnerHex, solAtaHex] },
          destinationEvidence({ evmWallet: evmAddress, solanaRecipients: [solOwnerHex, solAtaHex], solanaRead: solanaReadRpc }),
        )
        const destinationVerified = destination.verified
        const receiveEntryId = normalReceive?.entryId()
        if (receiveEntryId && destinationVerified) updateReceiveEntry(receiveEntryId, { phase: 'complete' })
        const [arcBalanceAfter, solanaBalanceAfter] = await Promise.all([
          refreshArcBalance().catch(() => null),
          refreshSolanaBalance().catch(() => null),
        ])
        const actualUsdcCost = computeActualUsdcCost(
          arcBalanceBefore,
          solanaBalanceBefore,
          arcBalanceAfter,
          solanaBalanceAfter,
        )
        const normalizedResult = {
          ...finalResult,
          ...txHashes,
          direction,
          actualUsdcCost,
          destinationVerified,
          ...(destination.verified ? {} : { destinationPendingReason: destination.reason }),
        }

        setState({
          isLoading: false,
          error: null,
          status: solanaTransferOutcomeStatus({ ...txHashes, destinationVerified }),
          result: normalizedResult,
        })

        return normalizedResult
      })
    } catch (error) {
      try { normalReceive?.fail(error) } catch { /* preserve the existing blocking journal */ }
      const message = direction === 'solana-to-arc' && sourceExecutionStarted
        ? safePreWalletFailure(error)
        : error instanceof Error ? error.message : 'Solana mainnet transfer failed.'
      setState({
        isLoading: false,
        error: message,
        status: null,
        result: null,
      })
      throw new Error(message)
    }
  }, [
    evmAddress,
    phantomAddress,
    phantomProvider,
    findPendingArcToSolanaBurn,
    feeEstimate,
    recoverPendingArcToSolana,
    refreshArcBalance,
    refreshSolanaBalance,
    walletClient,
  ])

  // Manual unlock of an older receive record after the independent chain checks passed and the user
  // confirmed the risk warning. Takes the same per-burn lock; every check is re-run first.
  const confirmArcSolanaReceiveRelease = useCallback(async (userConfirmed: boolean) => {
    const review = arcSolanaReceiveReview
    if (!review || !navigator.locks) throw new Error('There is no receive to review.')
    return navigator.locks.request(`machina-arc-solana-recovery:${review.sourceTxHash}`, { ifAvailable: true }, async lock => {
      if (!lock) throw new ReceiveLockedError('Another tab is processing this burn.')
      const fresh = await releaseLegacyReceiveAfterReview(review.sourceTxHash, review.owner, review.message, userConfirmed, arcSolanaReceiveReads)
      setArcSolanaReceiveReview(null)
      setState(s => ({ ...s, isLoading: false, error: null, status: 'The earlier receive request was unlocked after the chain checks. Start the receive again; it is checked once more before your wallet opens.' }))
      return fresh
    })
  }, [arcSolanaReceiveReview])

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
    feeEstimate,
    feeEstimateError,
    feeEstimateIssue,
    isEstimatingFees,
    estimateCanary,
    findPendingArcToSolanaBurn,
    recoverPendingArcToSolana,
    arcSolanaReceiveReview,
    confirmArcSolanaReceiveRelease,
    runCanary,
  }
}
