import { useState, useEffect, useRef, useCallback } from 'react'
import { useAccount, useSwitchChain } from 'wagmi'
import { Card, Button, Input, Container } from './ui'
import {
  useBridgeKit,
  BridgeToken,
  SEPOLIA_CHAIN_ID,
  ARC_CHAIN_ID,
  BASE_CHAIN_ID,
  OPTIMISM_CHAIN_ID,
  ARBITRUM_CHAIN_ID,
  PENDING_BRIDGE_KEY,
  PendingBridgeRecord,
  BridgeActivityRecord,
  readBridgeActivitiesForWallet,
  CHAIN_NAMES,
} from '../hooks/useBridgeKit'
import { useGatewayForwarding } from '../hooks/useGatewayForwarding'
import { usePhantomSolana } from '../hooks/usePhantomSolana'
import { useSolanaBridge } from '../hooks/useSolanaBridge'
import { getSupportedEvmChain, getSupportedEvmChainName, SUPPORTED_EVM_CHAIN_OPTIONS } from '../lib/chains'
import { deriveSolanaUsdcAta, isValidSolanaAddress, SOLANA_DEVNET_NAME } from '../lib/solana'
import { logger } from '../lib/logger'
import {
  dismissServerBridgeActivity,
  dismissTrackedTransfer,
  dismissTrackedTransferBySourceTxHash,
  fetchServerBridgeActivities,
  fetchTrackedTransfers,
  ServerBridgeActivity,
  TrackedTransfer,
} from '../lib/transferTrackerApi'
import { ArrowLeftRight, Loader2, CheckCircle, AlertCircle, ExternalLink, RefreshCw, Clock, X, Bell } from 'lucide-react'

const EVM_BRIDGE_CHAIN_IDS = [SEPOLIA_CHAIN_ID, ARC_CHAIN_ID, BASE_CHAIN_ID, OPTIMISM_CHAIN_ID, ARBITRUM_CHAIN_ID]
const SOLANA_FORWARD_CHAIN_IDS = [ARC_CHAIN_ID]
const ENABLED_EVM_BRIDGE_ROUTES = new Set<string>([
  `${SEPOLIA_CHAIN_ID}-${ARC_CHAIN_ID}`,
  `${ARC_CHAIN_ID}-${SEPOLIA_CHAIN_ID}`,
  `${BASE_CHAIN_ID}-${ARC_CHAIN_ID}`,
  `${ARC_CHAIN_ID}-${BASE_CHAIN_ID}`,
  `${OPTIMISM_CHAIN_ID}-${ARC_CHAIN_ID}`,
  `${ARC_CHAIN_ID}-${OPTIMISM_CHAIN_ID}`,
  `${ARBITRUM_CHAIN_ID}-${ARC_CHAIN_ID}`,
  `${ARC_CHAIN_ID}-${ARBITRUM_CHAIN_ID}`,
])

const ALLOWED_DESTINATIONS_BY_SOURCE: Record<number, number[]> = {
  [SEPOLIA_CHAIN_ID]: [ARC_CHAIN_ID],
  [ARC_CHAIN_ID]: [SEPOLIA_CHAIN_ID, BASE_CHAIN_ID, OPTIMISM_CHAIN_ID, ARBITRUM_CHAIN_ID],
  [BASE_CHAIN_ID]: [ARC_CHAIN_ID],
  [OPTIMISM_CHAIN_ID]: [ARC_CHAIN_ID],
  [ARBITRUM_CHAIN_ID]: [ARC_CHAIN_ID],
}

function getAllowedDestinationChainIds(sourceChainId: number) {
  return ALLOWED_DESTINATIONS_BY_SOURCE[sourceChainId] ?? []
}

function resolveDestinationChainId(sourceChainId: number, currentDestinationChainId?: number) {
  const allowedDestinations = getAllowedDestinationChainIds(sourceChainId)
  if (currentDestinationChainId && allowedDestinations.includes(currentDestinationChainId)) {
    return currentDestinationChainId
  }

  return allowedDestinations[0]
}

function getTransferKey(sourceTxHash?: string | null, id?: string) {
  if (sourceTxHash) {
    return sourceTxHash.toLowerCase()
  }
  return (id ?? '').toLowerCase()
}

function getTransferStatusRank(status: TrackedTransfer['status']) {
  switch (status) {
    case 'minted':
      return 3
    case 'ready_to_mint':
      return 2
    case 'pending_attestation':
      return 1
    default:
      return 0
  }
}

function getBridgeEtaDetails(sourceChainId?: number) {
  if (sourceChainId === BASE_CHAIN_ID) {
    return { label: '15-20 minutes', minutes: 20 }
  }

  if (sourceChainId === OPTIMISM_CHAIN_ID) {
    return { label: '20-30 minutes', minutes: 30 }
  }

  if (sourceChainId === ARBITRUM_CHAIN_ID) {
    return { label: '15-25 minutes', minutes: 25 }
  }

  return { label: '15-25 minutes', minutes: 25 }
}

function findFirstStringMatch(value: unknown, pattern: RegExp, seen = new WeakSet<object>()): string | undefined {
  if (typeof value === 'string' && pattern.test(value)) {
    return value
  }

  if (!value || typeof value !== 'object') {
    return undefined
  }

  if (seen.has(value)) {
    return undefined
  }
  seen.add(value)

  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findFirstStringMatch(item, pattern, seen)
      if (found) {
        return found
      }
    }
    return undefined
  }

  for (const nestedValue of Object.values(value as Record<string, unknown>)) {
    const found = findFirstStringMatch(nestedValue, pattern, seen)
    if (found) {
      return found
    }
  }

  return undefined
}

function mergeLocalAndServerActivities(
  localActivities: BridgeActivityRecord[],
  serverActivities: ServerBridgeActivity[],
): BridgeActivityRecord[] {
  const byKey = new Map<string, BridgeActivityRecord>()

  const ingest = (activity: BridgeActivityRecord) => {
    const key = activity.sourceTxHash
      ? `source:${activity.sourceTxHash.toLowerCase()}`
      : `id:${String(activity.id).toLowerCase()}`
    const previous = byKey.get(key)

    if (!previous) {
      byKey.set(key, activity)
      return
    }

    const prevUpdated = Number(previous.updatedAt ?? previous.startedAt ?? 0)
    const nextUpdated = Number(activity.updatedAt ?? activity.startedAt ?? 0)
    if (nextUpdated >= prevUpdated) {
      byKey.set(key, activity)
    }
  }

  localActivities.forEach(ingest)
  serverActivities.forEach((serverActivity) => ingest(serverActivity as BridgeActivityRecord))

  return [...byKey.values()].sort(
    (a, b) => Number(b.updatedAt ?? b.startedAt ?? 0) - Number(a.updatedAt ?? a.startedAt ?? 0),
  )
}

export function BridgeTab() {
  const { address, isConnected, chainId } = useAccount()
  const { switchChainAsync, isPending: isSwitchingChain } = useSwitchChain()
  const {
    state,
    tokenBalance,
    isLoadingBalance,
    balanceError,
    fetchTokenBalance,
    bridge,
    resumePendingBridge,
    approvePendingBridge,
    startPendingBridge,
    refreshBridgeActivities,
    isTransferReadyToMint,
    claimBridgedTransfer,
    reset,
  } = useBridgeKit()
  const {
    state: gatewayState,
    walletState,
    estimateSolanaForwarding,
    forwardToSolana,
    fetchGatewayBalances,
    depositToGateway,
    reset: resetGateway,
  } = useGatewayForwarding()
  const {
    address: phantomSolanaAddress,
    connect: connectPhantomSolana,
    disconnect: disconnectPhantomSolana,
    error: phantomSolanaError,
    isConnected: isPhantomConnected,
    isConnecting: isConnectingPhantomSolana,
    isPhantomInstalled,
    provider: phantomSolanaProvider,
    resetError: resetPhantomSolanaError,
  } = usePhantomSolana()
  const {
    state: solanaBridgeState,
    solanaBalance,
    isLoadingBalance: isLoadingSolanaBalance,
    balanceError: solanaBalanceError,
    fetchBalance: fetchSolanaBalance,
    bridgeToArc,
    reset: resetSolanaBridge,
  } = useSolanaBridge()
  
  const [amount, setAmount] = useState('')
  const [bridgeMode, setBridgeMode] = useState<'evm' | 'solana' | 'solana-source'>('evm')
  const [sourceEvmChainId, setSourceEvmChainId] = useState(SEPOLIA_CHAIN_ID)
  const [destinationEvmChainId, setDestinationEvmChainId] = useState(ARC_CHAIN_ID)
  const [selectedToken] = useState<BridgeToken>('USDC')
  const [solanaRecipient, setSolanaRecipient] = useState('')
  const [pendingBridge, setPendingBridge] = useState<PendingBridgeRecord | null>(() => {
    try {
      const raw = localStorage.getItem(PENDING_BRIDGE_KEY)
      if (!raw) return null
      const parsed: PendingBridgeRecord = JSON.parse(raw)
      // Only surface entries started within the last 2 hours
      if (Date.now() - parsed.startedAt > 2 * 60 * 60 * 1000) {
        localStorage.removeItem(PENDING_BRIDGE_KEY)
        return null
      }
      return parsed
    } catch {
      return null
    }
  })
  const [trackerSnapshot, setTrackerSnapshot] = useState<PendingBridgeRecord | null>(null)
  const [isBridgeTrackerOpen, setIsBridgeTrackerOpen] = useState(false)
  const [isActivityOpen, setIsActivityOpen] = useState(false)
  const [showFeeDetails, setShowFeeDetails] = useState(false)
  const [selectedTrackerKey, setSelectedTrackerKey] = useState<string | null>(null)
  const [trackerNowMs, setTrackerNowMs] = useState(() => Date.now())
  const [isMintReadyValidated, setIsMintReadyValidated] = useState(false)
  const [isCheckingMintReady, setIsCheckingMintReady] = useState(false)
  const [validatedReadyKeys, setValidatedReadyKeys] = useState<Record<string, boolean>>({})
  const lastPendingBridgeJsonRef = useRef<string | null>(null)
  const lastMintReadyCheckKeyRef = useRef<string | null>(null)
  const [trackedTransfers, setTrackedTransfers] = useState<TrackedTransfer[]>([])
  const [activityRecords, setActivityRecords] = useState<BridgeActivityRecord[]>([])
  const [isLoadingTrackedTransfers, setIsLoadingTrackedTransfers] = useState(false)
  const [gatewayQuote, setGatewayQuote] = useState<{
    isLoading: boolean
    estimatedFee: string | null
    feeBuffer: string | null
    totalRequired: string | null
    error: string | null
  }>({
    isLoading: false,
    estimatedFee: null,
    feeBuffer: null,
    totalRequired: null,
    error: null,
  })
  const [lastSolanaSummary, setLastSolanaSummary] = useState<{
    sentBudget: number
    totalFee: number
    estimatedRecipient: number
  } | null>(null)

  const isSolanaMode = bridgeMode === 'solana'
  const isSolanaSourceMode = bridgeMode === 'solana-source'
  const bridgeChainOptions = SUPPORTED_EVM_CHAIN_OPTIONS.filter((option) => EVM_BRIDGE_CHAIN_IDS.includes(option.id))
  const evmDestinationChainIds = getAllowedDestinationChainIds(sourceEvmChainId)
  const evmDestinationOptions = bridgeChainOptions.filter((option) => evmDestinationChainIds.includes(option.id))

  const sourceChainId = isSolanaMode ? ARC_CHAIN_ID : sourceEvmChainId
  const destinationChainId = isSolanaSourceMode ? ARC_CHAIN_ID : isSolanaMode ? undefined : destinationEvmChainId
  const sourceChainName = isSolanaSourceMode ? SOLANA_DEVNET_NAME : getSupportedEvmChainName(sourceChainId)
  const destinationChainName = isSolanaSourceMode
    ? getSupportedEvmChainName(ARC_CHAIN_ID)
    : isSolanaMode
      ? SOLANA_DEVNET_NAME
      : getSupportedEvmChainName(destinationEvmChainId)
  const completedSourceChainId = state.sourceChainId ?? sourceEvmChainId
  const completedDestinationChainId = state.destinationChainId ?? destinationEvmChainId
  const completedSourceChainName = getSupportedEvmChainName(completedSourceChainId)
  const completedDestinationChainName = getSupportedEvmChainName(completedDestinationChainId)
  const activeState = isSolanaSourceMode ? solanaBridgeState : isSolanaMode ? gatewayState : state
  const hasAmount = Boolean(amount) && parseFloat(amount) > 0
  const isSolanaRecipientValid = solanaRecipient.trim().length > 0 && isValidSolanaAddress(solanaRecipient)
  const derivedRecipientAta = isSolanaRecipientValid ? deriveSolanaUsdcAta(solanaRecipient).ata.toBase58() : ''
  const numericGatewayBalance = parseFloat(walletState.availableBalance) || 0
  const numericOnchainGatewayBalance = parseFloat(walletState.onchainAvailableBalance) || 0
  const numericWalletBalance = parseFloat(walletState.walletBalance) || 0
  const numericSolanaBalance = parseFloat(solanaBalance) || 0
  const processingGatewayBalance = Math.max(0, numericOnchainGatewayBalance - numericGatewayBalance)
  const enteredAmount = parseFloat(amount) || 0
  const estimatedFeeAmount = gatewayQuote.estimatedFee ? parseFloat(gatewayQuote.estimatedFee) || 0 : 0
  const feeBufferAmount = gatewayQuote.feeBuffer ? parseFloat(gatewayQuote.feeBuffer) || 0 : 0
  const hasGatewayQuote = Boolean(gatewayQuote.totalRequired)
  // In Solana mode the input is treated as total budget to use from Gateway.
  const hasQuotedShortfall = isSolanaMode && hasAmount && enteredAmount > numericGatewayBalance + 0.000001
  const topUpNeeded = hasQuotedShortfall ? Math.max(0, enteredAmount - numericGatewayBalance) : 0
  const estimatedRecipientAmount = hasGatewayQuote ? Math.max(0, enteredAmount - estimatedFeeAmount - feeBufferAmount) : 0
  const approxMaxSendable = hasGatewayQuote ? Math.max(0, numericGatewayBalance - estimatedFeeAmount - feeBufferAmount) : 0
  const isUsingConnectedPhantomRecipient = Boolean(phantomSolanaAddress) && solanaRecipient.trim() === phantomSolanaAddress
  const isRouteEnabled = ENABLED_EVM_BRIDGE_ROUTES.has(`${sourceEvmChainId}-${destinationEvmChainId}`)
  const isOptimismToArcRoute = bridgeMode === 'evm' && sourceEvmChainId === OPTIMISM_CHAIN_ID && destinationEvmChainId === ARC_CHAIN_ID
  const isBaseToArcRoute = bridgeMode === 'evm' && sourceEvmChainId === BASE_CHAIN_ID && destinationEvmChainId === ARC_CHAIN_ID
  const isArbitrumToArcRoute = bridgeMode === 'evm' && sourceEvmChainId === ARBITRUM_CHAIN_ID && destinationEvmChainId === ARC_CHAIN_ID
  const isTrackedBridgeRoute = bridgeMode === 'evm' && isRouteEnabled
  const showTrackedEtaWarning = isTrackedBridgeRoute && sourceEvmChainId !== ARC_CHAIN_ID
  const isTrackedBridgeActive = bridgeMode === 'evm' && state.isLoading && isTrackedBridgeRoute

  const selectedActivity = selectedTrackerKey
    ? activityRecords.find((activity) => getTransferKey(activity.sourceTxHash, activity.id) === selectedTrackerKey)
    : null
  const selectedTransfer = selectedTrackerKey
    ? trackedTransfers.find((transfer) => getTransferKey(transfer.sourceTxHash, transfer.id) === selectedTrackerKey)
    : null
  const selectedTrackedBridge = selectedActivity
    ? {
        id: selectedActivity.id,
        sourceChainId: selectedActivity.sourceChainId,
        destinationChainId: selectedActivity.destinationChainId,
        amount: selectedActivity.amount,
        token: selectedActivity.token,
        walletAddress: selectedActivity.walletAddress,
        startedAt: selectedActivity.startedAt,
        sourceTxHash: selectedActivity.sourceTxHash,
        approvalTxHash: selectedActivity.approvalTxHash,
        receiveTxHash: selectedActivity.receiveTxHash,
        txHashes: [selectedActivity.approvalTxHash, selectedActivity.sourceTxHash, selectedActivity.receiveTxHash].filter((value): value is string => Boolean(value)),
        step: selectedActivity.status === 'minted'
          ? 'success'
          : selectedActivity.status === 'awaiting_approve'
            ? 'approving'
            : selectedActivity.status === 'awaiting_burn'
              ? 'signing-bridge'
              : 'waiting-receive-message',
        status: selectedActivity.status,
      }
    : (selectedTransfer
      ? {
          sourceChainId: selectedTransfer.sourceChainId,
          destinationChainId: selectedTransfer.destinationChainId,
          amount: selectedTransfer.amount,
          token: selectedTransfer.token,
          walletAddress: address ?? selectedTransfer.walletAddress,
          startedAt: selectedTransfer.createdAt,
          step: selectedTransfer.status === 'minted' ? 'success' : 'waiting-receive-message',
          sourceTxHash: selectedTransfer.sourceTxHash,
          receiveTxHash: selectedTransfer.destinationTxHash ?? undefined,
          txHashes: selectedTransfer.destinationTxHash
            ? [selectedTransfer.sourceTxHash, selectedTransfer.destinationTxHash]
            : [selectedTransfer.sourceTxHash],
        }
      : null)
  const trackedBridge = selectedTrackedBridge
    ?? pendingBridge
    ?? trackerSnapshot
    ?? null
  const trackedSourceChainName = trackedBridge ? getSupportedEvmChainName(trackedBridge.sourceChainId) : ''
  const trackedDestinationChainName = trackedBridge ? getSupportedEvmChainName(trackedBridge.destinationChainId) : ''
  const trackedTxHashes = trackedBridge?.txHashes ?? []
  const trackedSignatureCount = trackedBridge && 'signatureCount' in trackedBridge
    ? (trackedBridge.signatureCount ?? 0)
    : 0
  const trackedApprovalTxHash = trackedBridge?.approvalTxHash ?? trackedTxHashes[0]
  const stateMatchesTrackedSource = Boolean(
    state.sourceTxHash
    && trackedBridge?.sourceTxHash
    && state.sourceTxHash.toLowerCase() === trackedBridge.sourceTxHash.toLowerCase(),
  )
  const trackedSourceTxHash = trackedBridge
    ? (trackedBridge.sourceTxHash
      ?? (stateMatchesTrackedSource ? state.sourceTxHash : undefined)
      ?? (trackedTxHashes.length >= 2 ? trackedTxHashes[1] : undefined))
    : undefined
  const trackedReceiveTxHash = trackedBridge
    ? (stateMatchesTrackedSource
      ? (state.receiveTxHash ?? trackedBridge.receiveTxHash)
      : trackedBridge.receiveTxHash)
    : undefined
  const trackedEta = getBridgeEtaDetails(trackedBridge?.sourceChainId ?? sourceEvmChainId)
  const trackedEtaLabel = trackedEta.label
  const trackedEstimatedMinutes = trackedEta.minutes
  const trackedElapsedMinutes = trackedBridge ? Math.max(0, Math.floor((trackerNowMs - trackedBridge.startedAt) / 60000)) : 0
  const trackedRemainingMinutes = trackedBridge ? Math.max(0, trackedEstimatedMinutes - trackedElapsedMinutes) : 0
  const trackedCompletionLabel = trackedElapsedMinutes > 0 ? `Completed in ~${trackedElapsedMinutes} min` : 'Completed just now'
  const hasBridgeReachedArc = Boolean((state.step === 'success' && stateMatchesTrackedSource) || trackedReceiveTxHash)
  const hasOnlyOffchainSignature = trackedSignatureCount > 0 && trackedTxHashes.length === 0
  const hasApproveCompleted = Boolean(trackedApprovalTxHash || trackedSourceTxHash || trackedReceiveTxHash)
  const hasBurnCompleted = Boolean(trackedSourceTxHash)
  const visibleTrackedTransfers = trackedTransfers.filter((transfer) => transfer.status !== 'dismissed')
  const activityStatusByKey = activityRecords.reduce<Record<string, BridgeActivityRecord['status']>>((acc, activity) => {
    acc[getTransferKey(activity.sourceTxHash, activity.id)] = activity.status
    return acc
  }, {})
  const activityTransfers: TrackedTransfer[] = activityRecords
    .filter((activity) => {
      if (activity.status === 'dismissed') {
        return false
      }

      if (activity.receiveTxHash) {
        return true
      }

      if (activity.sourceTxHash) {
        return true
      }

      return activity.status !== 'awaiting_approve' && activity.status !== 'awaiting_burn'
    })
    .map((activity) => ({
      id: activity.id,
      walletAddress: activity.walletAddress,
      sourceChainId: activity.sourceChainId,
      destinationChainId: activity.destinationChainId,
      amount: activity.amount,
      token: activity.token,
      sourceTxHash: activity.sourceTxHash ?? '',
      destinationTxHash: activity.receiveTxHash ?? null,
      status: activity.status === 'minted' || Boolean(activity.receiveTxHash)
        ? 'minted'
        : activity.status === 'ready_to_mint'
          ? 'ready_to_mint'
          : activity.sourceTxHash
            ? 'pending_attestation'
            : 'pending_attestation',
      createdAt: activity.startedAt,
      updatedAt: activity.updatedAt,
    }))
  const localFallbackTransfer: TrackedTransfer | null = trackedBridge
    ? {
        id: `local-${trackedBridge.sourceTxHash ?? trackedBridge.startedAt}`,
        walletAddress: trackedBridge.walletAddress,
        sourceChainId: trackedBridge.sourceChainId,
        destinationChainId: trackedBridge.destinationChainId,
        amount: trackedBridge.amount,
        token: trackedBridge.token,
        sourceTxHash: trackedBridge.sourceTxHash ?? '',
        destinationTxHash: trackedBridge.receiveTxHash ?? null,
        status: trackedBridge.receiveTxHash ? 'minted' : 'pending_attestation',
        createdAt: trackedBridge.startedAt,
        updatedAt: Date.now(),
      }
    : null
  const mergedTrackedTransfers = [...activityTransfers, ...visibleTrackedTransfers, ...(localFallbackTransfer ? [localFallbackTransfer] : [])]
    .reduce<Map<string, TrackedTransfer>>((acc, transfer) => {
      const transferKey = transfer.sourceTxHash?.toLowerCase() || transfer.id
      if (!transferKey) {
        return acc
      }

      const existing = acc.get(transferKey)
      if (!existing) {
        acc.set(transferKey, transfer)
        return acc
      }

      const existingRank = getTransferStatusRank(existing.status)
      const nextRank = getTransferStatusRank(transfer.status)
      if (nextRank > existingRank || (nextRank === existingRank && transfer.updatedAt > existing.updatedAt)) {
        acc.set(transferKey, transfer)
      }

      return acc
    }, new Map<string, TrackedTransfer>())
  const mergedTrackedTransfersList = Array.from(mergedTrackedTransfers.values())
    .sort((a, b) => b.updatedAt - a.updatedAt)
  const nonMintedTransfers = mergedTrackedTransfersList.filter((transfer) => transfer.status !== 'minted')
  const actionNeededTransfers = nonMintedTransfers.filter(
    (transfer) => transfer.status === 'ready_to_mint' || Boolean(validatedReadyKeys[getTransferKey(transfer.sourceTxHash, transfer.id)]),
  )
  const inProgressTransfers = nonMintedTransfers.filter((transfer) => {
    if (transfer.status === 'ready_to_mint') {
      return false
    }
    return !validatedReadyKeys[getTransferKey(transfer.sourceTxHash, transfer.id)]
  })
  const completedTransfers = mergedTrackedTransfersList.filter((transfer) => transfer.status === 'minted')
  const actionNeededCount = actionNeededTransfers.length
  const pendingReadyToMintTransfer = trackedBridge
    ? mergedTrackedTransfersList.find((transfer) => {
        const transferKey = getTransferKey(transfer.sourceTxHash, transfer.id)
        if (transfer.status !== 'ready_to_mint' && !validatedReadyKeys[transferKey]) {
          return false
        }

        if (!trackedBridge.sourceTxHash) {
          return false
        }

        return transfer.sourceTxHash.toLowerCase() === trackedBridge.sourceTxHash.toLowerCase()
      })
    : undefined
  const trackerTransferKey = trackedBridge ? getTransferKey(trackedBridge.sourceTxHash, trackedBridge.id) : null
  const isTrackerReadyValidated = trackerTransferKey ? Boolean(validatedReadyKeys[trackerTransferKey]) : false
  const trackedStatus =
    hasBridgeReachedArc
      ? 'minted'
      : trackedBridge?.status === 'awaiting_approve'
        ? 'awaiting_approve'
        : trackedBridge?.status === 'awaiting_burn'
          ? 'awaiting_burn'
          : hasBurnCompleted
            ? (isTrackerReadyValidated ? 'ready_to_mint' : 'pending_attestation')
            : hasApproveCompleted
              ? 'awaiting_burn'
              : 'awaiting_approve'
  const canApproveAction = trackedStatus === 'awaiting_approve'
  const canBurnAction = trackedStatus === 'awaiting_burn'
  const canMintAction = trackedStatus === 'ready_to_mint' && isMintReadyValidated
  const isWaitingForArrival = Boolean(trackedBridge) && !hasBridgeReachedArc && !canMintAction && hasBurnCompleted
  const isAttestationCompleted = canMintAction || hasBridgeReachedArc
  const hasAnyTrackerData = Boolean(trackedBridge) || mergedTrackedTransfersList.length > 0

  const getTransferProgressLabel = (transfer: TrackedTransfer) => {
    const transferKey = getTransferKey(transfer.sourceTxHash, transfer.id)
    if (validatedReadyKeys[transferKey]) {
      return 'Ready to mint'
    }

    const localStatus = activityStatusByKey[transferKey]
    if (localStatus === 'awaiting_approve') {
      return 'Waiting for approve'
    }
    if (localStatus === 'awaiting_burn') {
      return 'Waiting for burn'
    }
    if (localStatus === 'pending_attestation') {
      return 'Waiting for Circle attestation'
    }

    if (transfer.status === 'ready_to_mint') {
      return 'Ready to mint'
    }
    if (transfer.status === 'pending_attestation') {
      return 'Waiting for Circle attestation'
    }
    return 'In progress'
  }

  const getTxExplorerUrl = (evmChainId: number, txHash: string) => {
    const chain = getSupportedEvmChain(evmChainId)
    const explorerBaseUrl = chain?.blockExplorers?.default?.url

    if (!explorerBaseUrl) {
      return undefined
    }

    return `${explorerBaseUrl.replace(/\/$/, '')}/tx/${txHash}`
  }

  const getAddressExplorerUrl = (evmChainId: number, walletAddress: string) => {
    const chain = getSupportedEvmChain(evmChainId)
    const explorerBaseUrl = chain?.blockExplorers?.default?.url

    if (!explorerBaseUrl) {
      return undefined
    }

    return `${explorerBaseUrl.replace(/\/$/, '')}/address/${walletAddress}`
  }

  const refreshPendingBridge = () => {
    try {
      const raw = localStorage.getItem(PENDING_BRIDGE_KEY)
      if ((raw ?? null) === lastPendingBridgeJsonRef.current) {
        return
      }

      lastPendingBridgeJsonRef.current = raw ?? null
      setPendingBridge(raw ? JSON.parse(raw) : null)
    } catch {
      lastPendingBridgeJsonRef.current = null
      setPendingBridge(null)
    }
  }

  const refreshTrackedTransfers = useCallback(async () => {
    if (!isConnected || !address) {
      setTrackedTransfers([])
      setActivityRecords([])
      setValidatedReadyKeys({})
      return
    }

    setIsLoadingTrackedTransfers(true)
    try {
      const [localActivities, serverActivities, transfers] = await Promise.all([
        refreshBridgeActivities(address),
        fetchServerBridgeActivities(address, 30),
        fetchTrackedTransfers(address),
      ])

      const mergedActivities = mergeLocalAndServerActivities(localActivities, serverActivities)
      setActivityRecords(mergedActivities)
      setTrackedTransfers(transfers)

      const readyCandidates = [
        ...mergedActivities
          .filter((activity) => activity.status !== 'minted' && Boolean(activity.sourceTxHash))
          .map((activity) => ({
            sourceChainId: activity.sourceChainId,
            sourceTxHash: activity.sourceTxHash as string,
            destinationChainId: activity.destinationChainId,
            id: activity.id,
          })),
        ...transfers
          .filter((transfer) => transfer.status !== 'minted' && Boolean(transfer.sourceTxHash))
          .map((transfer) => ({
            sourceChainId: transfer.sourceChainId,
            sourceTxHash: transfer.sourceTxHash,
            destinationChainId: transfer.destinationChainId,
            id: transfer.id,
          })),
      ]
        .reduce<Array<{ sourceChainId: number; sourceTxHash: string; destinationChainId?: number; id: string }>>((acc, item) => {
          const key = getTransferKey(item.sourceTxHash, item.id)
          if (!key || acc.some((entry) => getTransferKey(entry.sourceTxHash, entry.id) === key)) {
            return acc
          }
          acc.push(item)
          return acc
        }, [])

      const readinessChecks = await Promise.all(
        readyCandidates.map(async (candidate) => {
          const key = getTransferKey(candidate.sourceTxHash, candidate.id)
          const ready = await isTransferReadyToMint(candidate.sourceChainId, candidate.sourceTxHash, candidate.destinationChainId)
          return [key, ready] as const
        }),
      )

      const nextReadiness = readinessChecks.reduce<Record<string, boolean>>((acc, [key, ready]) => {
        acc[key] = ready
        return acc
      }, {})
      setValidatedReadyKeys(nextReadiness)
    } catch {
      try {
        const [localFallback, serverFallback] = await Promise.all([
          Promise.resolve(readBridgeActivitiesForWallet(address)),
          fetchServerBridgeActivities(address, 30),
        ])
        setActivityRecords(mergeLocalAndServerActivities(localFallback, serverFallback))
      } catch {
        setActivityRecords(readBridgeActivitiesForWallet(address))
      }
      setValidatedReadyKeys({})
    } finally {
      setIsLoadingTrackedTransfers(false)
    }
  }, [address, isConnected, isTransferReadyToMint, refreshBridgeActivities])

  const getBridgeTrackerHeadline = () => {
    if (hasBridgeReachedArc) {
      return `Bridge completed on ${trackedDestinationChainName}`
    }

    if (trackedStatus === 'ready_to_mint' && isCheckingMintReady) {
      return 'Checking mint readiness...'
    }

    if (canMintAction) {
      return `Ready to mint on ${trackedDestinationChainName}`
    }

    if (isWaitingForArrival) {
      return trackedRemainingMinutes > 0 ? `Wait about ${trackedRemainingMinutes} min` : `Waiting for ${trackedDestinationChainName} mint`
    }

    if (canBurnAction) {
      return 'Approval done, burn action required'
    }

    if (canApproveAction) {
      return 'Waiting for USDC approval'
    }

    if (hasOnlyOffchainSignature) {
      return 'Signature received, waiting to submit chain tx'
    }

    if (state.step === 'approving' || state.step === 'signing-bridge') {
      return 'Waiting for wallet confirmations'
    }

    if (state.step === 'switching-network') {
      return `Switching to ${sourceChainName}`
    }

    return 'Ready to continue'
  }

  const formatPendingDepositAmount = (rawAmount: string) => {
    const amountNumber = Number(rawAmount)
    if (!Number.isFinite(amountNumber)) {
      return rawAmount
    }

    return (amountNumber / 1_000_000).toFixed(6)
  }

  // Fetch balance on mount and when source chain changes
  useEffect(() => {
    if (isConnected && address && !isSolanaMode && !isSolanaSourceMode) {
      fetchTokenBalance(selectedToken, sourceChainId)
    }
  }, [isConnected, address, sourceChainId, selectedToken, fetchTokenBalance, isSolanaMode, isSolanaSourceMode])

  useEffect(() => {
    if (!isTrackedBridgeActive && !pendingBridge) {
      return
    }

    const syncPendingBridge = () => {
      refreshPendingBridge()
    }

    syncPendingBridge()
    const intervalId = window.setInterval(syncPendingBridge, 1000)

    return () => {
      window.clearInterval(intervalId)
    }
  }, [isTrackedBridgeActive])

  useEffect(() => {
    if (!pendingBridge) {
      return
    }

    const nextKey = JSON.stringify(pendingBridge)
    const currentKey = trackerSnapshot ? JSON.stringify(trackerSnapshot) : null
    if (nextKey !== currentKey) {
      setTrackerSnapshot(pendingBridge)
    }
  }, [pendingBridge, trackerSnapshot])

  useEffect(() => {
    if (!isConnected || !address) {
      return
    }

    void refreshTrackedTransfers()
    const intervalId = window.setInterval(() => {
      void refreshTrackedTransfers()
    }, 15000)

    return () => {
      window.clearInterval(intervalId)
    }
  }, [isConnected, address, refreshTrackedTransfers])

  useEffect(() => {
    const checkKey = trackedBridge?.sourceTxHash ? `${trackedBridge.sourceChainId}:${trackedBridge.sourceTxHash}:${trackedStatus}` : null
    if (!trackedBridge?.sourceTxHash || trackedStatus !== 'ready_to_mint' || hasBridgeReachedArc) {
      lastMintReadyCheckKeyRef.current = null
      setIsCheckingMintReady(false)
      if (isMintReadyValidated) {
        setIsMintReadyValidated(false)
      }
      return
    }

    if (lastMintReadyCheckKeyRef.current === checkKey) {
      return
    }

    lastMintReadyCheckKeyRef.current = checkKey

    let isCancelled = false
    setIsCheckingMintReady(true)

    void isTransferReadyToMint(trackedBridge.sourceChainId, trackedBridge.sourceTxHash, trackedBridge.destinationChainId).then((ready) => {
      if (isCancelled) {
        return
      }
      setIsMintReadyValidated((previous) => (previous === ready ? previous : ready))
      setIsCheckingMintReady(false)
    })

    return () => {
      isCancelled = true
    }
  }, [trackedBridge?.sourceChainId, trackedBridge?.sourceTxHash, trackedStatus, hasBridgeReachedArc, isTransferReadyToMint, isMintReadyValidated])

  useEffect(() => {
    if (!trackedBridge || !isBridgeTrackerOpen) {
      return
    }

    setTrackerNowMs(Date.now())
    const intervalId = window.setInterval(() => {
      setTrackerNowMs(Date.now())
    }, 15000)

    return () => {
      window.clearInterval(intervalId)
    }
  }, [trackedBridge, isBridgeTrackerOpen])

  useEffect(() => {
    if (isBridgeTrackerOpen || pendingBridge?.status !== 'minted') {
      return
    }

    localStorage.removeItem(PENDING_BRIDGE_KEY)
    lastPendingBridgeJsonRef.current = null
    setPendingBridge(null)
    setTrackerSnapshot(null)
    setSelectedTrackerKey(null)
  }, [isBridgeTrackerOpen, pendingBridge])

  useEffect(() => {
    if (!isSolanaMode || SOLANA_FORWARD_CHAIN_IDS.includes(sourceEvmChainId)) {
      return
    }

    setSourceEvmChainId(ARC_CHAIN_ID)
    setDestinationEvmChainId(ARC_CHAIN_ID)
  }, [isSolanaMode, sourceEvmChainId])

  useEffect(() => {
    const resolvedDestination = resolveDestinationChainId(sourceEvmChainId, destinationEvmChainId)
    if (!resolvedDestination || resolvedDestination === destinationEvmChainId) {
      return
    }

    setDestinationEvmChainId(resolvedDestination)
  }, [sourceEvmChainId, destinationEvmChainId])

  useEffect(() => {
    if (isConnected && address && isSolanaMode) {
      fetchGatewayBalances(sourceChainId)
    }
  }, [isConnected, address, isSolanaMode, sourceChainId, fetchGatewayBalances])

  useEffect(() => {
    if (!isSolanaSourceMode) {
      return
    }

    fetchSolanaBalance(phantomSolanaAddress)
  }, [fetchSolanaBalance, isSolanaSourceMode, phantomSolanaAddress])

  useEffect(() => {
    if (!isSolanaMode || !phantomSolanaAddress || solanaRecipient.trim()) {
      return
    }

    setSolanaRecipient(phantomSolanaAddress)
  }, [isSolanaMode, phantomSolanaAddress, solanaRecipient])

  useEffect(() => {
    if (!isConnected || !address || !isSolanaMode || !hasAmount || !isSolanaRecipientValid || walletState.isLoadingBalances || gatewayState.isLoading) {
      setGatewayQuote({
        isLoading: false,
        estimatedFee: null,
        feeBuffer: null,
        totalRequired: null,
        error: null,
      })
      return
    }

    let isCancelled = false
    setGatewayQuote((previousState) => ({
      ...previousState,
      isLoading: true,
      error: null,
    }))

    const estimateTimer = window.setTimeout(async () => {
      try {
        const estimate = await estimateSolanaForwarding({
          amount,
          sourceChainId,
          recipientWalletAddress: solanaRecipient,
        })

        if (isCancelled) {
          return
        }

        setGatewayQuote({
          isLoading: false,
          estimatedFee: estimate.estimatedFee,
          feeBuffer: estimate.feeBuffer,
          totalRequired: estimate.totalRequired,
          error: null,
        })
      } catch (error) {
        if (isCancelled) {
          return
        }

        setGatewayQuote({
          isLoading: false,
          estimatedFee: null,
          feeBuffer: null,
          totalRequired: null,
          error: error instanceof Error ? error.message : 'Could not estimate the send fee right now.',
        })
      }
    }, 350)

    return () => {
      isCancelled = true
      window.clearTimeout(estimateTimer)
    }
  }, [address, amount, estimateSolanaForwarding, gatewayState.isLoading, hasAmount, isConnected, isSolanaMode, isSolanaRecipientValid, solanaRecipient, sourceChainId, walletState.isLoadingBalances])

  // Show loading state initially, then balance
  const displayBalance = isLoadingBalance ? 'Loading...' : tokenBalance
  
  // Get numeric balance for validation (fallback to 0 if loading)
  const numericBalance = isLoadingBalance ? 0 : parseFloat(tokenBalance) || 0

  const handleBridge = async () => {
    if (!amount || parseFloat(amount) <= 0) {
      alert('Please enter a valid amount')
      return
    }

    if (isSolanaSourceMode) {
      if (!phantomSolanaProvider || !isPhantomConnected || !phantomSolanaAddress) {
        alert('Connect Phantom on Solana first.')
        return
      }

      if (!solanaBalanceError && parseFloat(amount) > numericSolanaBalance) {
        alert('Amount exceeds your Solana Devnet USDC balance.')
        return
      }

      await bridgeToArc({
        amount,
        solanaProvider: phantomSolanaProvider,
      })
      return
    }

    if (isSolanaMode) {
      if (!isSolanaRecipientValid) {
        alert('Please enter a valid Solana wallet address')
        return
      }

      if (gatewayQuote.isLoading) {
        alert('Checking the current send fee. Please wait a moment and try again.')
        return
      }

      if (gatewayQuote.error) {
        alert(gatewayQuote.error)
        return
      }

      if (estimatedRecipientAmount <= 0) {
        alert('This amount is too low after fees. Please increase the amount.')
        return
      }

      // Approve + Send: top-up if needed, then forward
      const originalAmount = enteredAmount
      const totalFeeForSummary = estimatedFeeAmount + feeBufferAmount
      const netAmountToForward = Math.max(0, originalAmount - totalFeeForSummary)
      if (netAmountToForward <= 0) {
        alert('After fees, nothing left to send. Please increase the amount.')
        return
      }

      setLastSolanaSummary({
        sentBudget: originalAmount,
        totalFee: totalFeeForSummary,
        estimatedRecipient: netAmountToForward,
      })

      const topUpAmount = Math.max(0, originalAmount - numericGatewayBalance)
      
      if (topUpAmount > 0) {
        if (topUpAmount > numericWalletBalance) {
          alert(`Wallet USDC balance is too low. You need ${topUpAmount.toFixed(6)} USDC to continue.`)
          return
        }
        // Deposit first, wait for it to complete 
        await depositToGateway({
          amount: topUpAmount.toFixed(6),
          sourceChainId,
        })
        // After deposit completes, fetch fresh balances
        await fetchGatewayBalances(sourceChainId)
        // Clear the input—deposit is done, now forwarding automatically
        setAmount('')
      }

      // Forward the net amount that will arrive at recipient
      await forwardToSolana({
        amount: netAmountToForward.toFixed(6),
        sourceChainId,
        recipientWalletAddress: solanaRecipient,
      })
      return
    }

    // Starting a new EVM bridge should reset any previous tracker selection.
    setTrackerSnapshot(null)
    setSelectedTrackerKey(null)

    // Auto-open tracker for tracked EVM routes so the user can
    // follow progress immediately without having to click Open tracker.
    if (isTrackedBridgeRoute) {
      setIsBridgeTrackerOpen(true)
    }

    await bridge(selectedToken, amount, {
      sourceChainId,
      destinationChainId: destinationEvmChainId,
    })

    refreshPendingBridge()
  }

  const handleGatewayDeposit = async () => {
    if (!amount || parseFloat(amount) <= 0) {
      alert('Please enter a valid amount to deposit')
      return
    }

    if (parseFloat(amount) > numericWalletBalance) {
      alert('Wallet USDC balance is too low for this Gateway deposit')
      return
    }

    await depositToGateway({
      amount,
      sourceChainId,
    })
  }

  const handleConnectPhantomSolana = async () => {
    try {
      await connectPhantomSolana()
    } catch (error) {
      logger.warn('Unable to connect Phantom on Solana:', error)
    }
  }

  const handleDisconnectPhantomSolana = async () => {
    try {
      await disconnectPhantomSolana()
    } catch (error) {
      logger.warn('Unable to disconnect Phantom on Solana:', error)
    }
  }

  const handleUseConnectedPhantomAddress = () => {
    if (!phantomSolanaAddress) {
      return
    }

    setSolanaRecipient(phantomSolanaAddress)
    resetPhantomSolanaError()
  }

  const switchWalletToChain = async (targetChainId: number) => {
    if (!isConnected || !switchChainAsync || chainId === targetChainId) {
      return true
    }

    try {
      await switchChainAsync({ chainId: targetChainId })
      return true
    } catch (error) {
      logger.warn('Unable to switch wallet to selected source chain:', error)
      return false
    }
  }

  const handleSourceChainSelection = async (nextSourceChainId: number) => {
    const switched = await switchWalletToChain(nextSourceChainId)
    if (!switched) {
      return
    }

    const resolvedDestination = resolveDestinationChainId(nextSourceChainId, destinationEvmChainId)
    if (resolvedDestination) {
      setDestinationEvmChainId(resolvedDestination)
    }

    setSourceEvmChainId(nextSourceChainId)
    setAmount('')
  }

  const handleSwapDirection = async () => {
    if (isSolanaSourceMode || isSolanaMode) {
      return
    }

    const nextSourceChainId = destinationEvmChainId
    const nextDestinationChainId = resolveDestinationChainId(nextSourceChainId, sourceEvmChainId)

    if (!nextDestinationChainId) {
      logger.warn('No valid destination chain found for selected source chain.')
      return
    }

    if (isConnected && chainId !== nextSourceChainId && switchChainAsync) {
      try {
        await switchChainAsync({ chainId: nextSourceChainId })
      } catch (error) {
        logger.warn('Unable to switch bridge source chain automatically:', error)
        return
      }
    }

    setSourceEvmChainId(nextSourceChainId)
    setDestinationEvmChainId(nextDestinationChainId)
    setAmount('')
  }

  useEffect(() => {
    if (!isConnected || bridgeMode === 'solana-source' || activeState.isLoading || walletState.isDepositing || walletState.isPollingDeposit) {
      return
    }

    if (!chainId || !EVM_BRIDGE_CHAIN_IDS.includes(chainId) || chainId === sourceEvmChainId) {
      return
    }

    setSourceEvmChainId(chainId)
    const resolvedDestination = resolveDestinationChainId(chainId, destinationEvmChainId)
    if (resolvedDestination) {
      setDestinationEvmChainId(resolvedDestination)
    }
  }, [
    isConnected,
    bridgeMode,
    activeState.isLoading,
    walletState.isDepositing,
    walletState.isPollingDeposit,
    chainId,
    sourceEvmChainId,
    destinationEvmChainId,
  ])

  // Save transaction to localStorage when bridge succeeds
  useEffect(() => {
    if (bridgeMode !== 'evm') {
      return
    }

    if (state.step === 'success') {
      if (pendingBridge) {
        setTrackerSnapshot(pendingBridge)
      }
      localStorage.removeItem(PENDING_BRIDGE_KEY)
      lastPendingBridgeJsonRef.current = null
      setPendingBridge(null)
    }

    if (state.step === 'success' && state.sourceChainId && state.destinationChainId && amount) {
      const transactionSourceChainName = getSupportedEvmChainName(state.sourceChainId)
      const transactionDestinationChainName = getSupportedEvmChainName(state.destinationChainId)
      const transactionDirection = `${transactionSourceChainName.toLowerCase().replace(/\s+/g, '-')}-to-${transactionDestinationChainName.toLowerCase().replace(/\s+/g, '-')}`

      const txId = state.sourceTxHash
        || `${transactionDirection}-${amount}-${state.sourceChainId}-${state.destinationChainId}`

      const existingTransactions = JSON.parse(localStorage.getItem('bridgeTransactions') || '[]')
      const isAlreadySaved = existingTransactions.some((t: any) => t.id === txId)
      if (!isAlreadySaved) {
        const transaction = {
          id: txId,
          type: 'bridge',
          direction: transactionDirection,
          amount: amount,
          fromNetwork: transactionSourceChainName,
          toNetwork: transactionDestinationChainName,
          timestamp: new Date().toISOString(),
          sourceTxHash: state.sourceTxHash,
          receiveTxHash: state.receiveTxHash,
        }
        existingTransactions.unshift(transaction)
        localStorage.setItem('bridgeTransactions', JSON.stringify(existingTransactions.slice(0, 10)))
      }
    }
  }, [bridgeMode, state.step, state.sourceChainId, state.destinationChainId, amount, state.sourceTxHash, state.receiveTxHash, pendingBridge])

  useEffect(() => {
    if (!pendingBridge?.receiveTxHash) {
      return
    }

    const nextKey = JSON.stringify(pendingBridge)
    const currentKey = trackerSnapshot ? JSON.stringify(trackerSnapshot) : null
    if (nextKey !== currentKey) {
      setTrackerSnapshot(pendingBridge)
    }
    localStorage.removeItem(PENDING_BRIDGE_KEY)
    lastPendingBridgeJsonRef.current = null
    setPendingBridge(null)
  }, [pendingBridge, trackerSnapshot])

  useEffect(() => {
    if (bridgeMode !== 'solana' || gatewayState.step !== 'success' || !amount || !gatewayState.transferId) {
      return
    }

    const transaction = {
      id: gatewayState.transferId,
      type: 'solana-forward',
      direction: sourceChainName === 'Sepolia' ? 'sepolia-to-solana' : 'arc-to-solana',
      amount,
      fromNetwork: sourceChainName,
      toNetwork: destinationChainName,
      timestamp: new Date().toISOString(),
      transferId: gatewayState.transferId,
      recipientAta: gatewayState.recipientAta,
      status: gatewayState.status,
    }

    const existingTransactions = JSON.parse(localStorage.getItem('bridgeTransactions') || '[]')
    const isAlreadySaved = existingTransactions.some((entry: any) => entry.id === transaction.id)
    if (!isAlreadySaved) {
      existingTransactions.unshift(transaction)
      localStorage.setItem('bridgeTransactions', JSON.stringify(existingTransactions.slice(0, 10)))
    }
  }, [bridgeMode, gatewayState.step, gatewayState.transferId, gatewayState.recipientAta, gatewayState.status, amount, sourceChainName, destinationChainName])

  useEffect(() => {
    if (bridgeMode !== 'solana-source' || solanaBridgeState.step !== 'success' || !amount || !solanaBridgeState.sourceTxHash) {
      return
    }

    const transaction = {
      id: solanaBridgeState.sourceTxHash,
      type: 'solana-bridge',
      direction: 'solana-to-arc',
      amount,
      fromNetwork: SOLANA_DEVNET_NAME,
      toNetwork: 'Arc Testnet',
      timestamp: new Date().toISOString(),
      sourceTxHash: solanaBridgeState.sourceTxHash,
      receiveTxHash: solanaBridgeState.receiveTxHash,
      status: solanaBridgeState.status,
    }

    const existingTransactions = JSON.parse(localStorage.getItem('bridgeTransactions') || '[]')
    const isAlreadySaved = existingTransactions.some((entry: any) => entry.id === transaction.id)
    if (!isAlreadySaved) {
      existingTransactions.unshift(transaction)
      localStorage.setItem('bridgeTransactions', JSON.stringify(existingTransactions.slice(0, 10)))
    }
  }, [bridgeMode, solanaBridgeState.step, solanaBridgeState.sourceTxHash, solanaBridgeState.receiveTxHash, solanaBridgeState.status, amount])

  const buildPendingFromTrackedTransfer = useCallback((transfer: TrackedTransfer): PendingBridgeRecord => {
    return {
      sourceChainId: transfer.sourceChainId,
      destinationChainId: transfer.destinationChainId,
      amount: transfer.amount,
      token: transfer.token,
      walletAddress: address ?? transfer.walletAddress,
      startedAt: transfer.createdAt,
      step: transfer.status === 'minted' ? 'success' : 'waiting-receive-message',
      sourceTxHash: transfer.sourceTxHash,
      receiveTxHash: transfer.destinationTxHash ?? undefined,
      txHashes: transfer.destinationTxHash
        ? [transfer.sourceTxHash, transfer.destinationTxHash]
        : [transfer.sourceTxHash],
    }
  }, [address])

  const handleApprovePendingBridge = useCallback(async () => {
    if (!pendingBridge) {
      return
    }

    await approvePendingBridge(pendingBridge)
    refreshPendingBridge()
    void refreshTrackedTransfers()
  }, [approvePendingBridge, pendingBridge, refreshTrackedTransfers])

  const handleStartPendingBridge = useCallback(async () => {
    if (!pendingBridge) {
      return
    }

    await startPendingBridge(pendingBridge)
    refreshPendingBridge()
    void refreshTrackedTransfers()
  }, [pendingBridge, refreshTrackedTransfers, startPendingBridge])

  const handleOpenTransferInTracker = useCallback((transfer: TrackedTransfer) => {
    const requestedKey = getTransferKey(transfer.sourceTxHash, transfer.id)
    const matchedActivity = activityRecords.find((item) => {
      if (getTransferKey(item.sourceTxHash, item.id) === requestedKey) {
        return true
      }

      if (transfer.sourceTxHash && item.sourceTxHash) {
        return item.sourceTxHash.toLowerCase() === transfer.sourceTxHash.toLowerCase()
      }

      return false
    })

    const pending = matchedActivity
      ? {
          id: matchedActivity.id,
          sourceChainId: matchedActivity.sourceChainId,
          destinationChainId: matchedActivity.destinationChainId,
          amount: matchedActivity.amount,
          token: matchedActivity.token,
          walletAddress: matchedActivity.walletAddress,
          startedAt: matchedActivity.startedAt,
          status: matchedActivity.status,
          step: matchedActivity.step,
          approvalTxHash: matchedActivity.approvalTxHash,
          sourceTxHash: matchedActivity.sourceTxHash,
          receiveTxHash: matchedActivity.receiveTxHash,
          txHashes: matchedActivity.txHashes,
        }
      : buildPendingFromTrackedTransfer(transfer)

    if (!matchedActivity) {
      pending.status = transfer.status === 'ready_to_mint'
        ? 'ready_to_mint'
        : transfer.status === 'minted'
          ? 'minted'
          : 'pending_attestation'
    }

    localStorage.setItem(PENDING_BRIDGE_KEY, JSON.stringify(pending))
    lastPendingBridgeJsonRef.current = JSON.stringify(pending)
    setPendingBridge(pending)
    setTrackerSnapshot(pending)
    setSelectedTrackerKey(getTransferKey(transfer.sourceTxHash, transfer.id))
    setIsActivityOpen(false)
    setIsBridgeTrackerOpen(true)
  }, [activityRecords, buildPendingFromTrackedTransfer])

  const handleResumeTrackedTransfer = useCallback(async (transfer: TrackedTransfer) => {
    const transferKey = getTransferKey(transfer.sourceTxHash, transfer.id)
    if (!validatedReadyKeys[transferKey]) {
      return
    }

    await claimBridgedTransfer(
      transfer.sourceChainId,
      transfer.destinationChainId,
      transfer.sourceTxHash,
    )
    void refreshTrackedTransfers()
  }, [claimBridgedTransfer, refreshTrackedTransfers, validatedReadyKeys])

  const handleDismissTrackedTransfer = useCallback(async (transfer: TrackedTransfer) => {
    if (transfer.id.startsWith('local-')) {
      localStorage.removeItem(PENDING_BRIDGE_KEY)
      lastPendingBridgeJsonRef.current = null
      setPendingBridge(null)
      setTrackerSnapshot(null)
      setSelectedTrackerKey(null)
      return
    }

    const results = await Promise.all([
      dismissTrackedTransfer(transfer.id),
      dismissServerBridgeActivity(transfer.id),
      transfer.sourceTxHash ? dismissTrackedTransferBySourceTxHash(transfer.sourceTxHash) : Promise.resolve(false),
    ])

    const ok = results.some(Boolean)
    if (ok) {
      void refreshTrackedTransfers()
      return
    }

    logger.warn('Dismiss failed for transfer', transfer)
  }, [refreshTrackedTransfers])

  useEffect(() => {
    if (!isActivityOpen) {
      return
    }

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setIsActivityOpen(false)
      }
    }

    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [isActivityOpen])

  const getLoadingMessage = () => {
    if (isSolanaSourceMode) {
      switch (solanaBridgeState.step) {
        case 'signing-source':
          return 'Sign the burn on Solana Devnet in Phantom...'
        case 'waiting-attestation':
          return 'Waiting for Circle attestation...'
        case 'signing-destination':
          return 'Confirm the mint on Arc in your EVM wallet...'
        default:
          return 'Processing Solana to Arc bridge...'
      }
    }

    if (isSolanaMode) {
      switch (gatewayState.step) {
        case 'switching-network':
          return 'Switching source chain...'
        case 'validating-recipient':
          return 'Validating Solana recipient...'
        case 'estimating':
          return 'Calculating send fee...'
        case 'signing-burn-intent':
          return 'Sign to send from Gateway...'
        case 'submitting-transfer':
          return 'Submitting send request...'
        case 'waiting-finality':
          return 'Waiting for Gateway finality...'
        default:
          return 'Processing send request...'
      }
    }

    switch (state.step) {
      case 'switching-network':
        return 'Switching network...'
      case 'approving':
        return 'Processing transaction...'
      case 'signing-bridge':
        return 'Confirming transaction...'
      case 'waiting-receive-message':
        return 'Completing bridge...'
      default:
        return 'Processing...'
    }
  }

  const isBridgeDisabled =
    !isConnected ||
    activeState.isLoading ||
    activeState.step === 'success' ||
    !hasAmount ||
    (!isSolanaMode && !isSolanaSourceMode && sourceEvmChainId === destinationEvmChainId) ||
    (!isSolanaMode && !isSolanaSourceMode && !isRouteEnabled) ||
    (isSolanaSourceMode && (!phantomSolanaProvider || !isPhantomConnected || isLoadingSolanaBalance || (!solanaBalanceError && parseFloat(amount) > numericSolanaBalance))) ||
    (!isSolanaMode && !isSolanaSourceMode && parseFloat(amount) > numericBalance) ||
    (isSolanaMode && (walletState.isLoadingBalances || walletState.isDepositing || walletState.isPollingDeposit || gatewayQuote.isLoading || !isSolanaRecipientValid || Boolean(gatewayQuote.error)))
  const gatewayResultTxHash = findFirstStringMatch(gatewayState.result, /^0x[a-fA-F0-9]{64}$/)
  const solanaResultTxHash = findFirstStringMatch(gatewayState.result, /^[1-9A-HJ-NP-Za-km-z]{87,88}$/)
  const gatewayTxHash = walletState.depositTxHash ?? gatewayResultTxHash
  const gatewayTxUrl = gatewayTxHash
    ? sourceChainId === SEPOLIA_CHAIN_ID
      ? `https://sepolia.etherscan.io/tx/${gatewayTxHash}`
      : `https://testnet.arcscan.app/tx/${gatewayTxHash}`
    : undefined
  const solanaTxUrl = solanaResultTxHash
    ? `https://explorer.solana.com/tx/${solanaResultTxHash}?cluster=devnet`
    : undefined
  const trackedSourceTxUrl = trackedBridge && trackedSourceTxHash
    ? getTxExplorerUrl(trackedBridge.sourceChainId, trackedSourceTxHash)
    : undefined
  const trackedReceiveTxUrl = trackedBridge && trackedReceiveTxHash
    ? getTxExplorerUrl(trackedBridge.destinationChainId, trackedReceiveTxHash)
    : undefined

  return (
    <>
      <Container className="py-12">
        <div className="max-w-xl mx-auto">
        <Card>
          <div className="mb-2 flex items-center justify-between gap-3">
            <h2 className="text-2xl font-bold">Bridge USDC</h2>
            <button
              type="button"
              onClick={() => setIsActivityOpen(true)}
              className="relative inline-flex items-center justify-center rounded-xl border border-slate-200 bg-white p-2 text-slate-600 transition-colors hover:bg-slate-50"
              title="Open activity"
            >
              <Bell size={16} />
              {actionNeededCount > 0 && (
                <span className="absolute -right-1 -top-1 inline-flex min-h-[18px] min-w-[18px] items-center justify-center rounded-full bg-amber-500 px-1 text-[11px] font-semibold text-white">
                  {actionNeededCount}
                </span>
              )}
            </button>
          </div>
          <p className="mb-6 text-sm text-slate-500">Choose the route, review balances, then follow the guided confirmations.</p>

          {!isConnected && (
            <div className="mb-4 flex items-center gap-3 rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
              <AlertCircle size={16} className="shrink-0" />
              Connect your wallet to bridge USDC across supported EVM routes.
            </div>
          )}

          {trackedBridge && trackedStatus !== 'minted' && (
            <div className="mb-4 rounded-2xl border border-slate-200 bg-slate-50 p-4 text-sm text-slate-800">
              <div className="flex items-start justify-between gap-3">
                <div className="flex items-start gap-3">
                  <div className="rounded-2xl bg-white p-2 text-[#2F6E0C] shadow-sm">
                    <Clock size={16} />
                  </div>
                  <div>
                    <p className="font-semibold">Bridge tracker available</p>
                    <p className="mt-1 text-xs text-slate-500">
                      {trackedBridge.amount} {trackedBridge.token} from {trackedSourceChainName} to {trackedDestinationChainName}
                    </p>
                    <p className="mt-1 text-xs text-slate-500">{getBridgeTrackerHeadline()}</p>
                  </div>
                </div>
                <button
                  onClick={() => {
                    setSelectedTrackerKey(getTransferKey(trackedBridge.sourceTxHash, trackedBridge.id))
                    setIsBridgeTrackerOpen(true)
                  }}
                  className="rounded-xl border border-slate-300 bg-white px-3 py-2 text-xs font-semibold text-slate-800 transition-colors hover:bg-slate-100"
                >
                  Open tracker
                </button>
              </div>
            </div>
          )}

          <div className="space-y-4">
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
              <button
                onClick={() => setBridgeMode('evm')}
                className={`rounded-xl px-3 py-2 text-sm font-medium transition-colors ${
                  bridgeMode === 'evm'
                    ? 'border border-[#66D121]/40 bg-[#eef7e8] text-[#2F6E0C] shadow-sm'
                    : 'border border-slate-200 bg-white text-slate-600 hover:bg-slate-50'
                }`}
                disabled={activeState.isLoading}
              >
                EVM Bridge
              </button>
              <button
                onClick={() => setBridgeMode('solana')}
                className={`rounded-xl px-3 py-2 text-sm font-medium transition-colors ${
                  bridgeMode === 'solana'
                    ? 'border border-[#66D121]/40 bg-[#eef7e8] text-[#2F6E0C] shadow-sm'
                    : 'border border-slate-200 bg-white text-slate-600 hover:bg-slate-50'
                }`}
                disabled={activeState.isLoading}
              >
                Send to Solana
              </button>
              <button
                onClick={() => setBridgeMode('solana-source')}
                className={`rounded-xl px-3 py-2 text-sm font-medium transition-colors ${
                  bridgeMode === 'solana-source'
                    ? 'border border-[#66D121]/40 bg-[#eef7e8] text-[#2F6E0C] shadow-sm'
                    : 'border border-slate-200 bg-white text-slate-600 hover:bg-slate-50'
                }`}
                disabled={activeState.isLoading}
              >
                Solana → Arc
              </button>
            </div>

            {/* Chain Selection */}
            <div className="rounded-2xl border border-slate-200 bg-[#f8faf7] p-4">
              <div className="flex items-center justify-between">
                <div className="text-center flex-1">
                  <p className="mb-1 text-xs text-slate-500">From</p>
                  {isSolanaSourceMode || isSolanaMode ? (
                    <p className="font-semibold">{sourceChainName}</p>
                  ) : (
                    <select
                      value={sourceEvmChainId}
                      onChange={(event) => {
                        const nextSourceChainId = Number(event.target.value)
                        void handleSourceChainSelection(nextSourceChainId)
                      }}
                      disabled={
                        activeState.isLoading ||
                        walletState.isDepositing ||
                        walletState.isPollingDeposit ||
                        isSwitchingChain
                      }
                      className="w-full rounded-lg border border-slate-200 bg-white px-2 py-2 text-sm font-semibold text-slate-900"
                    >
                      {bridgeChainOptions.map((option) => (
                        <option key={`source-${option.id}`} value={option.id}>
                          {option.name}
                        </option>
                      ))}
                    </select>
                  )}
                </div>
                <button
                  onClick={handleSwapDirection}
                  className="mx-4 rounded-xl border border-slate-200 bg-white p-2 text-slate-600 shadow-sm transition-colors hover:bg-slate-50"
                  disabled={isSolanaSourceMode || isSolanaMode || activeState.isLoading || walletState.isDepositing || walletState.isPollingDeposit || isSwitchingChain}
                >
                  {isSwitchingChain ? <Loader2 size={18} className="animate-spin" /> : <ArrowLeftRight size={18} />}
                </button>
                <div className="text-center flex-1">
                  <p className="mb-1 text-xs text-slate-500">To</p>
                  {isSolanaSourceMode || isSolanaMode ? (
                    <p className="font-semibold">{destinationChainName}</p>
                  ) : (
                    <select
                      value={destinationEvmChainId}
                      onChange={(event) => {
                        setDestinationEvmChainId(Number(event.target.value))
                        setAmount('')
                      }}
                      disabled={activeState.isLoading || walletState.isDepositing || walletState.isPollingDeposit}
                      className="w-full rounded-lg border border-slate-200 bg-white px-2 py-2 text-sm font-semibold text-slate-900"
                    >
                      {evmDestinationOptions.map((option) => (
                        <option key={`destination-${option.id}`} value={option.id}>
                          {option.name}
                        </option>
                      ))}
                    </select>
                  )}
                </div>
              </div>
              {isSolanaMode && (
                <p className="mt-3 text-xs text-slate-500">
                  This flow sends USDC to Solana through Circle Gateway. The source chain is currently Arc only.
                </p>
              )}
              {isSolanaSourceMode && (
                <div className="mt-3 rounded-xl border border-slate-200 bg-white p-3 text-xs text-slate-600">
                  <p className="font-medium text-slate-900">Wallet roles</p>
                  <p className="mt-1">
                    <span className="text-slate-500">Source signer:</span>{' '}
                    {isPhantomConnected && phantomSolanaAddress
                      ? `Phantom ${phantomSolanaAddress.slice(0, 4)}...${phantomSolanaAddress.slice(-4)}`
                      : 'Phantom Solana not connected'}
                  </p>
                  <p className="mt-1">
                    <span className="text-slate-500">Destination mint:</span>{' '}
                    {address ? `${address.slice(0, 6)}...${address.slice(-4)} (Arc recipient)` : 'EVM wallet not connected'}
                  </p>
                </div>
              )}
              {!isSolanaMode && chainId !== sourceChainId && (
                <p className="mt-3 text-xs text-[#2F6E0C]">
                  Wallet will switch to {sourceChainName} automatically before bridge signatures are requested.
                </p>
              )}
              {!isSolanaMode && !isSolanaSourceMode && !isRouteEnabled && (
                <p className="mt-3 text-xs text-amber-700">
                  This route is not enabled yet. Available now: Sepolia/Base/Optimism/Arbitrum ↔ Arc.
                </p>
              )}
            </div>

            {/* Token Selection (USDC only) */}
            <div>
              <label className="mb-2 block text-sm font-medium text-slate-700">Token</label>
              <div className="rounded-xl border border-slate-200 bg-white px-4 py-3">
                <span className="font-semibold">USDC</span>
                <span className="ml-2 text-sm text-slate-500">(USD Coin)</span>
              </div>
            </div>

            {/* Balance Display */}
            {isSolanaSourceMode ? (
              <div className="space-y-3 rounded-2xl border border-cyan-200 bg-cyan-50 p-4 text-sm text-cyan-950">
                <div className="flex items-center justify-between gap-2">
                  <div>
                    <p className="font-semibold">Solana source balance</p>
                    <p className="mt-1 text-xs text-cyan-900/70">
                      This is the USDC balance on Solana Devnet for the connected Phantom account.
                    </p>
                  </div>
                  <button
                    onClick={() => fetchSolanaBalance(phantomSolanaAddress)}
                    disabled={isLoadingSolanaBalance || activeState.isLoading}
                    className="text-cyan-700 transition-colors hover:text-cyan-900 disabled:opacity-50"
                    title="Refresh Solana balance"
                  >
                    <RefreshCw size={14} className={isLoadingSolanaBalance ? 'animate-spin' : ''} />
                  </button>
                </div>
                <div className="rounded-xl border border-cyan-100 bg-white p-3 text-slate-900">
                  <div className="flex items-center justify-between text-xs text-slate-500">
                    <span>Solana Devnet wallet USDC</span>
                    <span>{solanaBalance} USDC</span>
                  </div>
                  <div className="mt-2 flex items-center justify-between text-xs text-slate-500">
                    <span>Arc recipient wallet</span>
                    <span>{address ? `${address.slice(0, 6)}...${address.slice(-4)}` : 'Not connected'}</span>
                  </div>
                </div>
                {solanaBalanceError && <p className="text-xs text-red-600">{solanaBalanceError}</p>}
              </div>
            ) : isSolanaMode ? (
              <div className="space-y-3 rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-950">
                <div className="flex items-center justify-between gap-2">
                  <div>
                    <p className="font-semibold">Send balance</p>
                    <p className="mt-1 text-xs text-amber-900/70">
                      Enter a total budget, then one click handles top-up and send.
                    </p>
                  </div>
                  <button
                    onClick={() => fetchGatewayBalances(sourceChainId)}
                    disabled={walletState.isLoadingBalances || walletState.isDepositing || walletState.isPollingDeposit}
                    className="text-amber-700 transition-colors hover:text-amber-900 disabled:opacity-50"
                    title="Refresh Gateway balances"
                  >
                    <RefreshCw size={14} className={walletState.isLoadingBalances ? 'animate-spin' : ''} />
                  </button>
                </div>
                <div className="rounded-xl border border-amber-100 bg-white p-3 text-slate-900">
                  <div className="flex items-center justify-between text-xs text-slate-500">
                    <span>{sourceChainName} wallet USDC</span>
                    <span>{walletState.walletBalance} USDC</span>
                  </div>
                  <div className="mt-2 flex items-center justify-between text-xs text-slate-500">
                    <span>Ready in Gateway</span>
                    <span>{walletState.availableBalance} USDC</span>
                  </div>
                  {processingGatewayBalance > 0 && (
                    <div className="mt-2 flex items-center justify-between text-xs text-slate-500">
                      <span>Processing deposit</span>
                      <span>{processingGatewayBalance.toFixed(6)} USDC</span>
                    </div>
                  )}
                </div>
                {processingGatewayBalance > 0 ? (
                  <p className="text-xs text-amber-900/80">
                    Your deposit is still being processed by Circle. Refresh until the amount moves into Ready in Gateway.
                  </p>
                ) : (
                  <p className="text-xs text-amber-900/80">
                    The send fee is deducted from your Gateway balance, so the full deposited amount is not sent.
                  </p>
                )}
              </div>
            ) : isLoadingBalance ? (
              <div className="flex items-center justify-center rounded-xl border border-slate-200 bg-[#f8faf7] p-3">
                <Loader2 size={16} className="animate-spin mr-2" />
                <span className="text-sm">Loading balance...</span>
              </div>
            ) : balanceError ? (
              <div className="rounded-xl border border-red-200 bg-red-50 p-3 text-red-700">
                <div className="flex items-center justify-between gap-3">
                  <div className="flex items-center min-w-0">
                    <AlertCircle size={16} className="mr-2 flex-shrink-0" />
                    <span className="text-sm">{balanceError}</span>
                  </div>
                  <button
                    onClick={() => fetchTokenBalance(selectedToken, sourceChainId)}
                    disabled={isLoadingBalance}
                    className="text-red-500 transition-colors hover:text-red-700 disabled:opacity-50"
                    title="Refresh balance"
                  >
                    <RefreshCw size={14} className={isLoadingBalance ? 'animate-spin' : ''} />
                  </button>
                </div>
              </div>
            ) : (
              <div className="rounded-xl border border-slate-200 bg-[#f8faf7] p-3">
                <div className="flex items-center justify-between mb-1">
                  <p className="text-xs text-slate-500">{sourceChainName} {selectedToken} Balance</p>
                  <button
                    onClick={() => fetchTokenBalance(selectedToken, sourceChainId)}
                    disabled={isLoadingBalance}
                    className="text-slate-500 transition-colors hover:text-[#2F6E0C] disabled:opacity-50"
                    title="Refresh balance"
                  >
                    <RefreshCw size={14} className={isLoadingBalance ? 'animate-spin' : ''} />
                  </button>
                </div>
                <p className="text-lg font-semibold">{displayBalance} {selectedToken}</p>
              </div>
            )}

            {/* Amount Input */}
            <div>
              <div className="mb-2 flex items-center justify-between">
                <label className="text-sm font-medium text-slate-700">{isSolanaMode ? 'Total budget to use' : 'Amount'}</label>
                {isSolanaMode && approxMaxSendable > 0 && (
                  <button
                    type="button"
                    onClick={() => setAmount(approxMaxSendable.toFixed(6))}
                    disabled={activeState.isLoading || walletState.isDepositing}
                    className="text-xs font-medium text-[#2F6E0C] hover:underline disabled:opacity-50"
                  >
                    Max
                  </button>
                )}
              </div>
              <Input
                type="number"
                placeholder="0.00"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                disabled={activeState.isLoading || walletState.isDepositing}
                className="w-full"
              />
              {!isSolanaMode && !isSolanaSourceMode && parseFloat(amount) > numericBalance && (
                <p className="text-xs text-red-400 mt-1">Amount exceeds balance</p>
              )}
              {isSolanaSourceMode && !solanaBalanceError && parseFloat(amount) > numericSolanaBalance && (
                <p className="text-xs text-red-400 mt-1">Amount exceeds Solana Devnet balance</p>
              )}
              {isSolanaMode && hasAmount && gatewayQuote.isLoading && (
                <p className="mt-1 text-xs text-slate-500">Calculating the current send fee...</p>
              )}
              {isSolanaMode && hasAmount && gatewayQuote.error && (
                <p className="text-xs text-red-400 mt-1">{gatewayQuote.error}</p>
              )}
              {isSolanaMode && hasGatewayQuote && (
                <div className="mt-2">
                  <p className="text-xs text-slate-600">
                    Estimated to Solana: ~{estimatedRecipientAmount.toFixed(6)} USDC
                  </p>
                  {hasQuotedShortfall ? (
                    <p className="text-xs text-amber-600 font-medium">
                      ~{gatewayQuote.estimatedFee} USDC send fee · Approve & Send handles top-up
                    </p>
                  ) : (
                    <p className="text-xs text-slate-500">~{gatewayQuote.estimatedFee} USDC send fee</p>
                  )}
                  <button
                    type="button"
                    onClick={() => setShowFeeDetails((v) => !v)}
                    className="mt-1 text-xs text-slate-400 hover:text-slate-600"
                  >
                    {showFeeDetails ? 'Hide details' : 'Show details'}
                  </button>
                  {showFeeDetails && (
                    <div className="mt-2 space-y-1 rounded-xl border border-slate-200 bg-slate-50 p-3 text-xs text-slate-600">
                      <div className="flex items-center justify-between gap-3">
                        <span>Total budget</span>
                        <span>{amount || '0'} USDC</span>
                      </div>
                      <div className="flex items-center justify-between gap-3">
                        <span>Network fee</span>
                        <span>{gatewayQuote.estimatedFee} USDC</span>
                      </div>
                      <div className="flex items-center justify-between gap-3">
                        <span>Safety buffer</span>
                        <span>{gatewayQuote.feeBuffer} USDC</span>
                      </div>
                      <div className="flex items-center justify-between gap-3">
                        <span>Estimated to recipient</span>
                        <span>{estimatedRecipientAmount.toFixed(6)} USDC</span>
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>

            {(isSolanaMode || isSolanaSourceMode) && (
              <div className="space-y-3 rounded-2xl border border-[#2F6E0C]/15 bg-[#eef7e8] p-4 text-sm text-slate-700">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <p className="font-semibold">Phantom on Solana</p>
                    <p className="mt-1 text-xs text-slate-500">
                      {isSolanaSourceMode
                        ? 'This connected Phantom account signs the source-side burn on Solana Devnet.'
                        : 'RainbowKit already handles Phantom for EVM here. This also connects Phantom\'s Solana account, so the same wallet app can be reused for Solana flows.'}
                    </p>
                  </div>
                  {isPhantomInstalled ? (
                    <button
                      onClick={isPhantomConnected ? handleDisconnectPhantomSolana : handleConnectPhantomSolana}
                      disabled={isConnectingPhantomSolana || activeState.isLoading || walletState.isDepositing}
                      className="rounded-xl border border-[#2F6E0C]/20 bg-white px-3 py-2 text-xs font-medium text-[#2F6E0C] transition-colors hover:bg-[#f8faf7] disabled:opacity-50"
                    >
                      {isPhantomConnected
                        ? 'Disconnect Solana'
                        : isConnectingPhantomSolana
                          ? 'Connecting...'
                          : 'Connect Solana'}
                    </button>
                  ) : (
                    <span className="rounded-xl border border-amber-300 bg-white px-3 py-2 text-xs text-amber-700">
                      Phantom not detected
                    </span>
                  )}
                </div>

                {isPhantomConnected && phantomSolanaAddress ? (
                  <div className="rounded-xl border border-slate-200 bg-white p-3">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0 flex-1">
                        <p className="text-xs text-slate-500">Connected Solana address</p>
                        <p className="mt-1 break-all text-xs text-slate-900">{phantomSolanaAddress}</p>
                      </div>
                      {!isSolanaSourceMode && (
                        <button
                          onClick={handleUseConnectedPhantomAddress}
                          disabled={isUsingConnectedPhantomRecipient || activeState.isLoading || walletState.isDepositing}
                          className="rounded-xl border border-[#2F6E0C]/20 bg-[#eef7e8] px-3 py-2 text-xs font-medium text-[#2F6E0C] transition-colors hover:bg-[#e4f1db] disabled:opacity-50"
                        >
                          {isUsingConnectedPhantomRecipient ? 'In Use' : 'Use Address'}
                        </button>
                      )}
                    </div>
                  </div>
                ) : isPhantomInstalled ? (
                  <p className="text-xs text-slate-600">
                    {isSolanaSourceMode
                      ? 'Connect Phantom on Solana to sign the source-chain burn for the Arc bridge.'
                      : 'Connect once and the app can reuse that Solana address right now. The same provider can be used later for Solana-side signing too.'}
                  </p>
                ) : (
                  <p className="text-xs text-slate-600">
                    {isSolanaSourceMode
                      ? 'Phantom\'s Solana provider is not available in this browser session, so source-side Solana signing cannot start yet.'
                      : 'Phantom\'s Solana provider is not available in this browser session. You can still paste a Solana destination address manually.'}
                  </p>
                )}

                {phantomSolanaError && <p className="text-xs text-red-600">{phantomSolanaError}</p>}
              </div>
            )}

            {isSolanaMode && (
              <div>
                <label className="mb-2 block text-sm font-medium text-slate-700">Solana Recipient Wallet</label>
                <Input
                  type="text"
                  placeholder="Enter a Solana wallet address"
                  value={solanaRecipient}
                  onChange={(event) => setSolanaRecipient(event.target.value)}
                  disabled={activeState.isLoading || walletState.isDepositing}
                  className="w-full"
                />
                {solanaRecipient.trim() && !isSolanaRecipientValid && (
                  <p className="text-xs text-red-400 mt-1">Enter a valid Solana wallet address</p>
                )}
                {isUsingConnectedPhantomRecipient && (
                  <p className="mt-1 text-xs text-[#2F6E0C]">Using the connected Phantom Solana address as the recipient.</p>
                )}
                {derivedRecipientAta && (
                  <p className="mt-2 break-all text-xs text-slate-500">
                    Recipient ATA: {derivedRecipientAta}
                  </p>
                )}
              </div>
            )}

            {/* Status Messages */}
            {isSolanaMode && walletState.error && (
              <div className="flex items-start rounded-xl border border-red-200 bg-red-50 p-3 text-red-700">
                <AlertCircle size={16} className="mr-2 mt-0.5 flex-shrink-0" />
                <span className="text-sm">{walletState.error}</span>
              </div>
            )}

            {activeState.error && (
              <div className="flex items-start rounded-xl border border-red-200 bg-red-50 p-3 text-red-700">
                <AlertCircle size={16} className="mr-2 mt-0.5 flex-shrink-0" />
                <span className="text-sm">{activeState.error}</span>
              </div>
            )}

            {activeState.isLoading && activeState.step !== 'success' && (
              <div className="flex items-start rounded-xl border border-slate-200 bg-slate-50 p-3 text-slate-700">
                <Loader2 size={16} className="mr-2 mt-0.5 flex-shrink-0 animate-spin" />
                <div className="text-sm">
                  <p className="font-semibold">{getLoadingMessage()}</p>
                  {isSolanaMode && gatewayState.status && (
                    <p className="mt-1 text-xs text-slate-500">Latest status: {gatewayState.status}</p>
                  )}
                  {isSolanaSourceMode && solanaBridgeState.status && (
                    <p className="mt-1 text-xs text-slate-500">Latest status: {solanaBridgeState.status}</p>
                  )}
                </div>
              </div>
            )}

            {bridgeMode === 'evm' && state.step === 'success' && (
              <div className="space-y-2 rounded-xl border border-[#66D121]/25 bg-[#eef7e8] p-3 text-[#25580A]">
                <div className="flex items-start gap-2">
                  <CheckCircle size={16} className="mt-0.5 flex-shrink-0" />
                  <div className="text-sm">
                    <p className="font-semibold">Bridge Successful! 🎉</p>
                    <p className="text-xs mt-1">USDC successfully transferred from {completedSourceChainName} to {completedDestinationChainName}</p>
                  </div>
                </div>
                
                {/* Transaction Links */}
                <div className="space-y-1 mt-3 pt-3 border-t border-green-400/20">
                  {state.sourceTxHash && (
                    (() => {
                      const sourceExplorerUrl = getTxExplorerUrl(completedSourceChainId, state.sourceTxHash)
                      if (!sourceExplorerUrl) {
                        return null
                      }

                      return (
                        <a
                          href={sourceExplorerUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="flex items-center gap-2 text-xs hover:text-green-100 transition-colors"
                        >
                          <span>View {completedSourceChainName} Tx</span>
                          <ExternalLink size={12} />
                        </a>
                      )
                    })()
                  )}
                  {state.receiveTxHash && (
                    (() => {
                      const destinationExplorerUrl = getTxExplorerUrl(completedDestinationChainId, state.receiveTxHash)
                      if (!destinationExplorerUrl) {
                        return null
                      }

                      return (
                        <a
                          href={destinationExplorerUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="flex items-center gap-2 text-xs hover:text-green-100 transition-colors"
                        >
                          <span>View {completedDestinationChainName} Tx</span>
                          <ExternalLink size={12} />
                        </a>
                      )
                    })()
                  )}
                </div>
              </div>
            )}

            {isSolanaSourceMode && solanaBridgeState.step === 'success' && (
              <div className="space-y-2 rounded-xl border border-[#66D121]/25 bg-[#eef7e8] p-3 text-[#25580A]">
                <div className="flex items-start gap-2">
                  <CheckCircle size={16} className="mt-0.5 flex-shrink-0" />
                  <div className="text-sm">
                    <p className="font-semibold">Bridge Successful! 🎉</p>
                    <p className="text-xs mt-1">USDC successfully transferred from Solana Devnet to Arc Testnet.</p>
                  </div>
                </div>
                <div className="space-y-1 mt-3 pt-3 border-t border-green-400/20 text-xs text-green-100/90">
                  {solanaBridgeState.sourceTxHash && (
                    <a
                      href={`https://explorer.solana.com/tx/${solanaBridgeState.sourceTxHash}?cluster=devnet`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="flex items-center gap-2 text-[#25580A] transition-colors hover:text-[#1E4608]"
                    >
                      <span>View Solana burn tx</span>
                      <ExternalLink size={12} />
                    </a>
                  )}
                  {solanaBridgeState.receiveTxHash && (
                    <a
                      href={`https://testnet.arcscan.app/tx/${solanaBridgeState.receiveTxHash}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="flex items-center gap-2 text-[#25580A] transition-colors hover:text-[#1E4608]"
                    >
                      <span>View Arc mint tx</span>
                      <ExternalLink size={12} />
                    </a>
                  )}
                </div>
              </div>
            )}

            {isSolanaMode && gatewayState.step === 'success' && (
              <div className="space-y-2 rounded-xl border border-[#66D121]/25 bg-[#eef7e8] p-3 text-[#25580A]">
                <div className="flex items-start gap-2">
                  <CheckCircle size={16} className="mt-0.5 flex-shrink-0" />
                  <div className="text-sm">
                    <p className="font-semibold">Sent to Solana! 🎉</p>
                  </div>
                </div>
                <div className="space-y-1 mt-2 pt-2 border-t border-green-400/20 text-xs text-[#25580A]">
                  {(() => {
                    const arrivedAmount = parseFloat(gatewayState.destinationBalanceAfter || '0') - parseFloat(gatewayState.destinationBalanceBefore || '0')
                    const summarySent = lastSolanaSummary?.sentBudget
                    const summaryFee = lastSolanaSummary?.totalFee
                    const summaryArrived = lastSolanaSummary?.estimatedRecipient
                    const sentAmount = summarySent ?? Math.max(0, arrivedAmount)
                    const feeAmount = summaryFee ?? Math.max(0, sentAmount - Math.max(0, arrivedAmount))
                    const arrivedForDisplay = summaryArrived ?? Math.max(0, arrivedAmount)
                    return (
                      <>
                        <p>Sent: ~{sentAmount.toFixed(2)} USDC</p>
                        <p>Fee: ~{feeAmount.toFixed(2)} USDC</p>
                        <p>Arrived: ~{arrivedForDisplay.toFixed(2)} USDC</p>
                        {gatewayTxUrl && (
                          <a
                            href={gatewayTxUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="flex items-center gap-2 text-[#25580A] transition-colors hover:text-[#1E4608]"
                          >
                            <span>View Gateway tx</span>
                            <ExternalLink size={12} />
                          </a>
                        )}
                        {solanaTxUrl && (
                          <a
                            href={solanaTxUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="flex items-center gap-2 text-[#25580A] transition-colors hover:text-[#1E4608]"
                          >
                            <span>View Solana tx</span>
                            <ExternalLink size={12} />
                          </a>
                        )}
                        {gatewayState.fundsArrived && (
                          <p className="text-[11px] text-green-700">✓ Confirmed by Solana balance increase</p>
                        )}
                      </>
                    )
                  })()}
                </div>
              </div>
            )}

            {/* EVM bridge wait-time notice */}
            {showTrackedEtaWarning && state.step !== 'success' && (
              <div className="flex items-start gap-2 rounded-xl border border-blue-200 bg-blue-50 p-3 text-xs text-blue-800">
                <Clock size={13} className="mt-0.5 flex-shrink-0 text-blue-500" />
                <p>
                  {sourceChainName} to {destinationChainName} typically takes <strong>{trackedEtaLabel}</strong> on testnet. Three wallet confirmations
                  are required. <strong>Keep this tab open</strong> — if it closes mid-flight, an &quot;Incomplete bridge
                  detected&quot; notice will appear when you return.
                </p>
              </div>
            )}

            {isArbitrumToArcRoute && state.step !== 'success' && (
              <div className="flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs text-amber-800">
                <AlertCircle size={13} className="mt-0.5 flex-shrink-0 text-amber-600" />
                <p>
                  MetaMask can overstate the <strong>max network fee</strong> for Arbitrum Sepolia receive-message transactions.
                  The value shown in the popup is often a safety cap, while the <strong>actual fee paid on-chain is much lower</strong>.
                </p>
              </div>
            )}

            {/* Bridge Button */}
            <Button
              onClick={handleBridge}
              disabled={isBridgeDisabled}
              loading={activeState.isLoading}
              className="w-full"
            >
              {activeState.isLoading ? (
                <>
                  <Loader2 size={16} className="animate-spin mr-2" />
                  {isSolanaSourceMode
                    ? 'Bridging...'
                    : isSolanaMode
                    ? gatewayState.step === 'switching-network'
                      ? 'Switching Network...'
                      : 'Sending...'
                    : state.step === 'switching-network'
                      ? 'Switching Network...'
                      : 'Bridging...'}
                </>
              ) : activeState.step === 'success' ? (
                isSolanaMode ? 'Send Complete' : 'Bridge Complete'
              ) : (
                isSolanaSourceMode
                  ? `Bridge ${amount || '0'} ${selectedToken} from Solana`
                  : isSolanaMode
                  ? hasQuotedShortfall
                    ? `Approve + Send`
                    : `Send ~${estimatedRecipientAmount.toFixed(2)} ${selectedToken} to Solana`
                  : `Bridge ${amount || '0'} ${selectedToken}`
              )}
            </Button>

            {/* Reset Button (after success) */}
            {/* Gateway deposit status (isSolanaMode shortfall flow) */}
            {isSolanaMode && (walletState.isDepositing || walletState.isPollingDeposit || walletState.depositStatus) && (
              <div className="space-y-1">
                {walletState.depositStatus && (
                  <div className="flex items-start gap-2 text-xs text-slate-600">
                    {(walletState.isDepositing || walletState.isPollingDeposit) && <Loader2 size={12} className="mt-0.5 animate-spin flex-shrink-0" />}
                    <p>{walletState.depositStatus}</p>
                  </div>
                )}
                {walletState.approvalTxHash && !walletState.depositTxHash && (
                  <a
                    href={sourceChainId === SEPOLIA_CHAIN_ID ? `https://sepolia.etherscan.io/tx/${walletState.approvalTxHash}` : `https://testnet.arcscan.app/tx/${walletState.approvalTxHash}`}
                    target="_blank" rel="noopener noreferrer"
                    className="flex items-center gap-2 text-xs text-[#2F6E0C] transition-colors hover:text-[#25580A]"
                  >
                    <span>View approval tx</span><ExternalLink size={12} />
                  </a>
                )}
                {walletState.depositTxHash && (
                  <a
                    href={sourceChainId === SEPOLIA_CHAIN_ID ? `https://sepolia.etherscan.io/tx/${walletState.depositTxHash}` : `https://testnet.arcscan.app/tx/${walletState.depositTxHash}`}
                    target="_blank" rel="noopener noreferrer"
                    className="flex items-center gap-2 text-xs text-[#2F6E0C] transition-colors hover:text-[#25580A]"
                  >
                    <span>View Gateway deposit tx</span><ExternalLink size={12} />
                  </a>
                )}
                {!walletState.isDepositing && !walletState.isPollingDeposit && walletState.error && (
                  <p className="text-xs text-amber-700">
                    If you only confirmed Approve, the deposit was not sent yet. Try again and confirm the second wallet popup.
                  </p>
                )}
              </div>
            )}
            {isSolanaMode && walletState.pendingDeposits.length > 0 && (
              <div className="rounded-xl border border-sky-200 bg-sky-50 p-3 text-xs text-sky-900">
                <p className="font-semibold">Deposits being processed</p>
                <div className="mt-2 space-y-2">
                  {walletState.pendingDeposits.slice(0, 3).map((deposit) => (
                    <div key={`${deposit.transactionHash}-${deposit.blockHeight ?? 'pending'}`} className="rounded-lg border border-sky-100 bg-white p-2">
                      <div className="flex items-center justify-between gap-2">
                        <span>Status: {deposit.status}</span>
                        <span>{formatPendingDepositAmount(deposit.amount)} USDC</span>
                      </div>
                      <p className="mt-1 break-all text-sky-700">Tx: {deposit.transactionHash}</p>
                      {deposit.blockTimestamp && (
                        <p className="mt-1 text-sky-700/80">Seen: {new Date(deposit.blockTimestamp).toLocaleString()}</p>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}
            {activeState.step === 'success' && (
              <button
                onClick={() => {
                  if (isSolanaMode) {
                    resetGateway()
                    setLastSolanaSummary(null)
                    setSolanaRecipient(phantomSolanaAddress ?? '')
                    fetchGatewayBalances(sourceChainId)
                  } else if (isSolanaSourceMode) {
                    resetSolanaBridge()
                    void fetchSolanaBalance(phantomSolanaAddress)
                  } else {
                    reset()
                  }
                  setAmount('')
                }}
                className="w-full rounded-xl border border-slate-300 bg-white px-4 py-2 text-sm text-slate-700 transition-colors hover:bg-slate-50"
              >
                {isSolanaMode ? 'Send Again' : 'Bridge Again'}
              </button>
            )}
          </div>
        </Card>

        {/* Info Box */}
        <div className="mt-6 rounded-2xl border border-slate-200 bg-white p-4 shadow-[0_12px_30px_rgba(15,23,42,0.04)]">
          <div className="space-y-1 text-xs text-slate-600">
            {isSolanaSourceMode ? (
              <>
                <p><strong>Solana to Arc Bridge Process:</strong></p>
                <p>1. <strong>Connect Phantom</strong>: Connect the Solana account that holds Devnet USDC</p>
                <p>2. <strong>Burn on Solana</strong>: Phantom signs the source-chain burn transaction</p>
                <p>3. <strong>Wait for Attestation</strong>: Circle attests the crosschain burn</p>
                <p>4. <strong>Mint on Arc</strong>: Your connected EVM wallet signs the Arc destination mint</p>
              </>
            ) : isSolanaMode ? (
              <>
                <p><strong>Send to Solana Process:</strong></p>
                <p>1. <strong>Add funds</strong>: Add USDC from your wallet to Gateway on the source chain</p>
                <p>2. <strong>Wait for ready balance</strong>: Refresh until the funds appear as Ready in Gateway</p>
                <p>3. <strong>Review fee</strong>: Check total required and Max sendable</p>
                <p>4. <strong>Send</strong>: Sign once to send USDC from Gateway to your Solana recipient</p>
              </>
            ) : (
              <>
                <p><strong>Bridge Process:</strong></p>
                <p>1. <strong>Approve</strong>: Approve USDC spending for the bridge contract</p>
                <p>2. <strong>Bridge</strong>: Send USDC to the source chain bridge contract</p>
                <p>3. <strong>Receive</strong>: Sign to receive USDC on the destination chain</p>
              </>
            )}
          </div>
        </div>
        </div>
      </Container>

      {isBridgeTrackerOpen && (
        <div className="fixed inset-0 z-[90] flex items-center justify-center bg-slate-950/70 px-4 py-6 backdrop-blur-sm">
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="bridge-tracker-title"
            className="relative w-full max-w-2xl rounded-[28px] border border-slate-200 bg-white p-6 shadow-[0_24px_80px_rgba(15,23,42,0.28)]"
          >
            <button
              type="button"
              onClick={() => setIsBridgeTrackerOpen(false)}
              className="absolute right-4 top-4 rounded-full border border-slate-200 p-2 text-slate-500 transition-colors hover:border-slate-300 hover:bg-slate-50 hover:text-slate-800"
              aria-label="Close bridge tracker"
            >
              <X size={16} />
            </button>

            <div className="mb-4 inline-flex h-12 w-12 items-center justify-center rounded-2xl bg-[#eef7e8] text-[#2F6E0C]">
              <Clock size={22} />
            </div>

            <h2 id="bridge-tracker-title" className="text-2xl font-semibold tracking-tight text-slate-900">
              Bridge Tracker
            </h2>
            <p className="mt-2 text-sm text-slate-500">
              Follow this bridge step by step and complete required signatures.
            </p>
            <p className="mt-1 text-xs text-slate-500">
              Verification: {isMintReadyValidated ? 'Circle readiness confirmed' : isCheckingMintReady ? 'Checking Circle readiness...' : 'Waiting Circle readiness'}
            </p>

            {hasAnyTrackerData ? (
              <div className="mt-5 rounded-2xl border border-slate-200 bg-slate-50 p-4">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <p className="text-xs uppercase tracking-[0.2em] text-slate-400">Network</p>
                  <p className="mt-2 text-sm font-semibold text-slate-900">{trackedSourceChainName} → {trackedDestinationChainName}</p>
                </div>
                <div className="text-right">
                  <p className="text-xs uppercase tracking-[0.2em] text-slate-400">Status</p>
                  <p className="mt-2 text-sm font-semibold text-slate-900">{getBridgeTrackerHeadline()}</p>
                </div>
              </div>
              </div>
            ) : (
              <div className="mt-5 rounded-2xl border border-slate-200 bg-slate-50 p-4 text-sm text-slate-500">
                No transfers for this wallet yet.
              </div>
            )}

            <div className="mt-4 space-y-2">
              {/* Step 1: Approve */}
              <div className={`rounded-2xl border p-4 ${
                hasApproveCompleted
                  ? 'border-[#66D121]/30 bg-[#eef7e8]'
                  : 'border-slate-200 bg-white'
              }`}>
                <div className="flex items-center justify-between gap-3">
                  <div className="flex items-center gap-3">
                    <div className={`flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full ${
                      hasApproveCompleted ? 'bg-[#2F6E0C] text-white' : 'bg-slate-100 text-slate-400'
                    }`}>
                      {hasApproveCompleted ? <CheckCircle size={15} /> : <span className="text-xs font-bold">1</span>}
                    </div>
                    <div>
                      <p className={`text-sm font-semibold ${
                        hasApproveCompleted ? 'text-[#1e4d07]' : 'text-slate-900'
                      }`}>Approve</p>
                      <p className={`text-xs ${
                        hasApproveCompleted ? 'text-[#2F6E0C]' : 'text-slate-500'
                      }`}>
                        {hasApproveCompleted ? 'USDC spend approved.' : 'Waiting for USDC approval.'}
                        {hasApproveCompleted && trackedApprovalTxHash && trackedBridge && (
                          <>
                            {' '}
                            <a
                              href={getTxExplorerUrl(trackedBridge.sourceChainId, trackedApprovalTxHash)}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="font-medium text-[#2F6E0C] underline-offset-2 hover:underline"
                            >
                              View tx
                            </a>
                          </>
                        )}
                      </p>
                    </div>
                  </div>
                  {!hasApproveCompleted && (
                    <button
                      type="button"
                      onClick={() => void handleApprovePendingBridge()}
                      disabled={!canApproveAction || state.isLoading}
                      className="rounded-lg bg-[#2F6E0C] px-3 py-1.5 text-xs font-semibold text-white hover:bg-[#25580A] disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      Approve
                    </button>
                  )}
                </div>
              </div>

              {/* Step 2: Burn */}
              <div className={`rounded-2xl border p-4 ${
                hasBurnCompleted
                  ? 'border-[#66D121]/30 bg-[#eef7e8]'
                  : 'border-slate-200 bg-white'
              }`}>
                <div className="flex items-center justify-between gap-3">
                  <div className="flex items-center gap-3">
                    <div className={`flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full ${
                      hasBurnCompleted ? 'bg-[#2F6E0C] text-white' : 'bg-slate-100 text-slate-400'
                    }`}>
                      {hasBurnCompleted ? <CheckCircle size={15} /> : <span className="text-xs font-bold">2</span>}
                    </div>
                    <div>
                      <p className={`text-sm font-semibold ${
                        hasBurnCompleted ? 'text-[#1e4d07]' : 'text-slate-900'
                      }`}>Burn on {trackedSourceChainName}</p>
                      <p className={`text-xs ${
                        hasBurnCompleted ? 'text-[#2F6E0C]' : 'text-slate-500'
                      }`}>
                        {hasBurnCompleted
                          ? 'Burn transaction submitted on source chain.'
                          : 'Waiting for burn transaction.'}
                          {hasBurnCompleted && trackedSourceTxUrl && (
                            <>
                              {' '}
                              <a
                                href={trackedSourceTxUrl}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="font-medium text-[#2F6E0C] underline-offset-2 hover:underline"
                              >
                                View tx
                              </a>
                            </>
                          )}
                      </p>
                    </div>
                  </div>
                    {!hasBurnCompleted && (
                    <button
                      type="button"
                      onClick={() => void handleStartPendingBridge()}
                      disabled={!canBurnAction || state.isLoading}
                      className="rounded-lg bg-[#2F6E0C] px-3 py-1.5 text-xs font-semibold text-white hover:bg-[#25580A] disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      Bridge
                    </button>
                  )}
                </div>
              </div>

              {/* Step 3: Attestation */}
              <div className={`rounded-2xl border p-4 ${
                isAttestationCompleted
                  ? 'border-[#66D121]/30 bg-[#eef7e8]'
                  : isWaitingForArrival
                    ? 'border-amber-200 bg-amber-50'
                    : 'border-slate-200 bg-white'
              }`}>
                <div className="flex items-center justify-between gap-3">
                  <div className="flex items-center gap-3">
                    <div className={`flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full ${
                      isAttestationCompleted
                        ? 'bg-[#2F6E0C] text-white'
                        : isWaitingForArrival
                          ? 'bg-amber-400 text-white'
                          : 'bg-slate-100 text-slate-400'
                    }`}>
                      {isAttestationCompleted
                        ? <CheckCircle size={15} />
                        : isWaitingForArrival
                          ? <Loader2 size={15} className="animate-spin" />
                          : <span className="text-xs font-bold">3</span>}
                    </div>
                    <div>
                      <p className={`text-sm font-semibold ${
                        isAttestationCompleted ? 'text-[#1e4d07]' : isWaitingForArrival ? 'text-amber-800' : 'text-slate-900'
                      }`}>{isAttestationCompleted ? `Bridge relayed to ${trackedDestinationChainName}` : 'Attestation'}</p>
                      <p className={`text-xs ${
                        isAttestationCompleted ? 'text-[#2F6E0C]' : isWaitingForArrival ? 'text-amber-700' : 'text-slate-500'
                      }`}>
                        {isAttestationCompleted
                          ? 'Circle attestation confirmed.'
                          : `${trackedSourceChainName} transfers usually settle in ~${trackedEstimatedMinutes} min.`}
                      </p>
                    </div>
                  </div>
                  {isWaitingForArrival && !hasBridgeReachedArc && (
                    <p className="flex-shrink-0 text-xs text-amber-600">{trackedElapsedMinutes} min elapsed</p>
                  )}
                </div>
              </div>

              {/* Step 4: Mint */}
              <div className={`rounded-2xl border p-4 ${
                hasBridgeReachedArc
                  ? 'border-[#66D121]/30 bg-[#eef7e8]'
                  : 'border-slate-200 bg-white'
              }`}>
                <div className="flex items-center justify-between gap-3">
                  <div className="flex items-center gap-3">
                    <div className={`flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full ${
                      hasBridgeReachedArc ? 'bg-[#2F6E0C] text-white' : 'bg-slate-100 text-slate-400'
                    }`}>
                      {hasBridgeReachedArc ? <CheckCircle size={15} /> : <span className="text-xs font-bold">4</span>}
                    </div>
                    <div>
                      <p className={`text-sm font-semibold ${
                        hasBridgeReachedArc ? 'text-[#1e4d07]' : 'text-slate-900'
                      }`}>Mint on {trackedDestinationChainName}</p>
                      <p className={`text-xs ${
                        hasBridgeReachedArc ? 'text-[#2F6E0C]' : 'text-slate-500'
                      }`}>
                        {hasBridgeReachedArc
                          ? `${trackedBridge?.amount ?? '-'} ${trackedBridge?.token ?? 'USDC'} received. ${trackedCompletionLabel}.`
                          : 'USDC will be minted on destination chain.'}
                        {hasBridgeReachedArc && trackedReceiveTxUrl && (
                          <>
                            {' '}
                            <a
                              href={trackedReceiveTxUrl}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="font-medium text-[#2F6E0C] underline-offset-2 hover:underline"
                            >
                              View tx
                            </a>
                          </>
                        )}
                      </p>
                    </div>
                  </div>
                  {!hasBridgeReachedArc && (
                    <button
                      type="button"
                      onClick={() => {
                        if (!pendingReadyToMintTransfer) return
                        void claimBridgedTransfer(
                          pendingReadyToMintTransfer.sourceChainId,
                          pendingReadyToMintTransfer.destinationChainId,
                          pendingReadyToMintTransfer.sourceTxHash,
                        )
                      }}
                      disabled={!canMintAction || isCheckingMintReady || state.isLoading || !pendingReadyToMintTransfer}
                      className="rounded-lg bg-[#2F6E0C] px-3 py-1.5 text-xs font-semibold text-white hover:bg-[#25580A] disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      {isCheckingMintReady ? 'Checking...' : 'Mint'}
                    </button>
                  )}
                </div>
              </div>
            </div>

            <div className="mt-5 flex flex-wrap gap-3">
              {trackedBridge && getAddressExplorerUrl(trackedBridge.sourceChainId, trackedBridge.walletAddress) && (
                <a
                  href={getAddressExplorerUrl(trackedBridge.sourceChainId, trackedBridge.walletAddress)}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center justify-center gap-2 rounded-2xl border border-slate-300 bg-white px-4 py-3 text-sm font-semibold text-slate-700 transition-colors hover:bg-slate-50"
                >
                  Wallet activity
                  <ExternalLink size={14} />
                </a>
              )}
              {pendingBridge && (
                <button
                  onClick={() => setIsBridgeTrackerOpen(false)}
                  className="inline-flex items-center justify-center rounded-2xl border border-slate-300 bg-white px-4 py-3 text-sm font-semibold text-slate-700 transition-colors hover:bg-slate-50"
                >
                  Dismiss
                </button>
              )}
              {trackedBridge && (
                <button
                  onClick={() => {
                    localStorage.removeItem(PENDING_BRIDGE_KEY)
                    lastPendingBridgeJsonRef.current = null
                    setPendingBridge(null)
                    setTrackerSnapshot(null)
                    setSelectedTrackerKey(null)
                    setIsBridgeTrackerOpen(false)
                  }}
                  className="inline-flex items-center justify-center rounded-2xl border border-slate-300 bg-white px-4 py-3 text-sm font-semibold text-slate-700 transition-colors hover:bg-slate-50"
                >
                  Clear tracker
                </button>
              )}
            </div>

            <div className="mt-6 border-t border-slate-200 pt-4">
              <p className="text-xs text-slate-500">
                Activity list is available from the bell icon. Use this tracker only for the currently selected bridge flow.
              </p>
            </div>

          </div>
        </div>
      )}

      {isActivityOpen && (
        <div
          className="fixed inset-0 z-[100] flex items-center justify-center bg-slate-950/70 px-4 py-6 backdrop-blur-sm"
          onClick={() => setIsActivityOpen(false)}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="activity-title"
            className="relative flex max-h-[90vh] w-full max-w-2xl flex-col overflow-hidden rounded-[28px] border border-slate-200 bg-white p-6 shadow-[0_24px_80px_rgba(15,23,42,0.28)]"
            onClick={(event) => event.stopPropagation()}
          >
            <button
              type="button"
              onClick={() => setIsActivityOpen(false)}
              className="absolute right-4 top-4 rounded-full border border-slate-200 p-2 text-slate-500 transition-colors hover:border-slate-300 hover:bg-slate-50 hover:text-slate-800"
              aria-label="Close activity"
            >
              <X size={16} />
            </button>

            <div className="mb-4 inline-flex h-12 w-12 items-center justify-center rounded-2xl bg-[#eef7e8] text-[#2F6E0C]">
              <Bell size={22} />
            </div>

            <h2 id="activity-title" className="text-2xl font-semibold tracking-tight text-slate-900">
              Activity
            </h2>
            <p className="mt-2 text-sm text-slate-500">
              Completed bridges, ready-to-mint transfers, and pending items for this wallet.
            </p>

            <div className="mt-6 overflow-y-auto border-t border-slate-200 pt-5">
              <div className="mb-3 flex items-center justify-between">
                <h3 className="text-sm font-semibold text-slate-900">Action Needed</h3>
                <button
                  type="button"
                  onClick={() => void refreshTrackedTransfers()}
                  className="inline-flex items-center gap-1 text-xs font-medium text-[#2F6E0C] hover:text-[#25580A]"
                >
                  <RefreshCw size={12} className={isLoadingTrackedTransfers ? 'animate-spin' : ''} />
                  Refresh
                </button>
              </div>

              {nonMintedTransfers.length === 0 ? (
                <p className="rounded-xl border border-slate-200 bg-slate-50 p-3 text-xs text-slate-500">
                  No active transfer right now.
                </p>
              ) : (
                <div className="space-y-4 max-h-[55vh] overflow-y-auto pr-1">
                  <div>
                    <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">In Progress</h4>
                    {inProgressTransfers.length === 0 ? (
                      <p className="rounded-xl border border-slate-200 bg-slate-50 p-3 text-xs text-slate-500">
                        No transfer waiting for approvals or attestation.
                      </p>
                    ) : (
                      <div className="space-y-2">
                        {inProgressTransfers.map((transfer) => {
                          const sourceName = getSupportedEvmChainName(transfer.sourceChainId)
                          const destinationName = getSupportedEvmChainName(transfer.destinationChainId)
                          const statusLabel = getTransferProgressLabel(transfer)

                          return (
                            <div key={`progress-${transfer.id}`} className="rounded-xl border border-slate-200 bg-slate-50 p-3">
                              <div className="flex items-start justify-between gap-3">
                                <div>
                                  <p className="text-sm font-semibold text-slate-900">{transfer.amount} {transfer.token}</p>
                                  <p className="text-xs text-slate-500">{sourceName} → {destinationName}</p>
                                  <p className="mt-1 text-xs font-medium text-slate-700">{statusLabel}</p>
                                </div>
                                <div className="flex items-center gap-2">
                                  <button
                                    type="button"
                                    onClick={() => handleOpenTransferInTracker(transfer)}
                                    className="rounded-lg border border-slate-300 px-2.5 py-1.5 text-xs font-semibold text-slate-700 hover:bg-white"
                                  >
                                    Open tracker
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() => void handleDismissTrackedTransfer(transfer)}
                                    className="rounded-lg border border-slate-300 px-2.5 py-1.5 text-xs font-semibold text-slate-700 hover:bg-white"
                                  >
                                    Dismiss
                                  </button>
                                </div>
                              </div>
                            </div>
                          )
                        })}
                      </div>
                    )}
                  </div>

                  <div>
                    <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-amber-700">Ready to Mint</h4>
                    {actionNeededTransfers.length === 0 ? (
                      <p className="rounded-xl border border-slate-200 bg-slate-50 p-3 text-xs text-slate-500">
                        No ready-to-mint transfer right now.
                      </p>
                    ) : (
                      <div className="space-y-2">
                        {actionNeededTransfers.map((transfer) => {
                          const sourceName = getSupportedEvmChainName(transfer.sourceChainId)
                          const destinationName = getSupportedEvmChainName(transfer.destinationChainId)
                          const transferKey = getTransferKey(transfer.sourceTxHash, transfer.id)
                          const isTransferReady = Boolean(validatedReadyKeys[transferKey])

                          return (
                            <div key={`ready-${transfer.id}`} className="rounded-xl border border-amber-200 bg-amber-50 p-3">
                              <div className="flex items-start justify-between gap-3">
                                <div>
                                  <p className="text-sm font-semibold text-slate-900">{transfer.amount} {transfer.token}</p>
                                  <p className="text-xs text-slate-500">{sourceName} → {destinationName}</p>
                                  <p className="mt-1 text-xs font-medium text-amber-700">Ready to mint</p>
                                  <p className="mt-1 text-[11px] text-slate-500">
                                    Verification: {isTransferReady ? 'confirmed' : 'not confirmed'}
                                  </p>
                                </div>
                                <div className="flex items-center gap-2">
                                  <button
                                    type="button"
                                    onClick={() => void handleResumeTrackedTransfer(transfer)}
                                    disabled={!isTransferReady || state.isLoading}
                                    className="rounded-lg bg-[#2F6E0C] px-2.5 py-1.5 text-xs font-semibold text-white hover:bg-[#25580A] disabled:cursor-not-allowed disabled:opacity-50"
                                  >
                                    Mint
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() => handleOpenTransferInTracker(transfer)}
                                    className="rounded-lg border border-slate-300 px-2.5 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50"
                                  >
                                    Open tracker
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() => void handleDismissTrackedTransfer(transfer)}
                                    className="rounded-lg border border-slate-300 px-2.5 py-1.5 text-xs font-semibold text-slate-700 hover:bg-white"
                                  >
                                    Dismiss
                                  </button>
                                </div>
                              </div>
                            </div>
                          )
                        })}
                      </div>
                    )}
                  </div>
                </div>
              )}

              <div className="mt-5 border-t border-slate-200 pt-4">
                <h4 className="mb-2 text-sm font-semibold text-slate-900">Completed</h4>
                {completedTransfers.length === 0 ? (
                  <p className="rounded-xl border border-slate-200 bg-slate-50 p-3 text-xs text-slate-500">
                    No completed transfer yet.
                  </p>
                ) : (
                  <div className="space-y-2 max-h-[32vh] overflow-y-auto pr-1">
                    {completedTransfers.slice(0, 20).map((transfer) => {
                      const sourceName = getSupportedEvmChainName(transfer.sourceChainId)
                      const destinationName = getSupportedEvmChainName(transfer.destinationChainId)

                      return (
                        <div key={`completed-${transfer.id}`} className="rounded-xl border border-[#66D121]/30 bg-[#eef7e8] p-3">
                          <div className="flex items-start justify-between gap-3">
                            <div>
                              <p className="text-sm font-semibold text-[#1e4d07]">{transfer.amount} {transfer.token}</p>
                              <p className="text-xs text-slate-500">{sourceName} → {destinationName}</p>
                              <p className="mt-1 text-xs font-medium text-[#2F6E0C]">Complete</p>
                            </div>
                            <CheckCircle size={16} className="text-[#2F6E0C]" />
                          </div>
                        </div>
                      )
                    })}
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
