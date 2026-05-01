import { useState, useEffect, useRef } from 'react'
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
  CHAIN_NAMES,
} from '../hooks/useBridgeKit'
import { useGatewayForwarding } from '../hooks/useGatewayForwarding'
import { usePhantomSolana } from '../hooks/usePhantomSolana'
import { useSolanaBridge } from '../hooks/useSolanaBridge'
import { getSupportedEvmChain, getSupportedEvmChainName, SUPPORTED_EVM_CHAIN_OPTIONS } from '../lib/chains'
import { deriveSolanaUsdcAta, isValidSolanaAddress, SOLANA_DEVNET_NAME } from '../lib/solana'
import { logger } from '../lib/logger'
import { ArrowLeftRight, Loader2, CheckCircle, AlertCircle, ExternalLink, RefreshCw, Clock, X } from 'lucide-react'

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

export function BridgeTab() {
  const { address, isConnected, chainId } = useAccount()
  const { switchChainAsync, isPending: isSwitchingChain } = useSwitchChain()
  const { state, tokenBalance, isLoadingBalance, balanceError, fetchTokenBalance, bridge, resumePendingBridge, reset } = useBridgeKit()
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
  const [trackerNowMs, setTrackerNowMs] = useState(() => Date.now())
  const lastPendingBridgeJsonRef = useRef<string | null>(null)
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
  const estimatedFeeAmount = gatewayQuote.estimatedFee ? parseFloat(gatewayQuote.estimatedFee) || 0 : 0
  const feeBufferAmount = gatewayQuote.feeBuffer ? parseFloat(gatewayQuote.feeBuffer) || 0 : 0
  const totalRequiredAmount = gatewayQuote.totalRequired ? parseFloat(gatewayQuote.totalRequired) || 0 : 0
  const hasGatewayQuote = Boolean(gatewayQuote.totalRequired)
  const hasQuotedShortfall = hasGatewayQuote && totalRequiredAmount > numericGatewayBalance + 0.000001
  const topUpNeeded = hasQuotedShortfall ? Math.max(0, totalRequiredAmount - numericGatewayBalance) : 0
  const approxMaxSendable = hasGatewayQuote ? Math.max(0, numericGatewayBalance - estimatedFeeAmount - feeBufferAmount) : 0
  const isUsingConnectedPhantomRecipient = Boolean(phantomSolanaAddress) && solanaRecipient.trim() === phantomSolanaAddress
  const isRouteEnabled = ENABLED_EVM_BRIDGE_ROUTES.has(`${sourceEvmChainId}-${destinationEvmChainId}`)
  const isOptimismToArcRoute = bridgeMode === 'evm' && sourceEvmChainId === OPTIMISM_CHAIN_ID && destinationEvmChainId === ARC_CHAIN_ID
  const isBaseToArcRoute = bridgeMode === 'evm' && sourceEvmChainId === BASE_CHAIN_ID && destinationEvmChainId === ARC_CHAIN_ID
  const isArbitrumToArcRoute = bridgeMode === 'evm' && sourceEvmChainId === ARBITRUM_CHAIN_ID && destinationEvmChainId === ARC_CHAIN_ID
  const isTrackedBridgeRoute = isOptimismToArcRoute || isBaseToArcRoute
  const isTrackedBridgeActive = bridgeMode === 'evm' && state.isLoading && isTrackedBridgeRoute

  const trackedBridge = pendingBridge ?? trackerSnapshot
  const trackedSourceChainName = trackedBridge ? getSupportedEvmChainName(trackedBridge.sourceChainId) : ''
  const trackedDestinationChainName = trackedBridge ? getSupportedEvmChainName(trackedBridge.destinationChainId) : ''
  const trackedTxHashes = trackedBridge?.txHashes ?? []
  const trackedSignatureCount = trackedBridge?.signatureCount ?? 0
  const trackedLatestTxHash = trackedTxHashes.length > 0 ? trackedTxHashes[trackedTxHashes.length - 1] : undefined
  const trackedHasBurnTx = trackedTxHashes.length >= 2 || trackedBridge?.step === 'waiting-receive-message' || trackedBridge?.step === 'success'
  const trackedSourceTxHash = state.sourceTxHash ?? trackedBridge?.sourceTxHash ?? trackedBridge?.approvalTxHash ?? (trackedHasBurnTx ? trackedLatestTxHash : undefined)
  const trackedReceiveTxHash = state.receiveTxHash ?? trackedBridge?.receiveTxHash
  const isTrackedBaseToArc = Boolean(trackedBridge && trackedBridge.sourceChainId === BASE_CHAIN_ID && trackedBridge.destinationChainId === ARC_CHAIN_ID)
  const isTrackedOptimismToArc = Boolean(trackedBridge && trackedBridge.sourceChainId === OPTIMISM_CHAIN_ID && trackedBridge.destinationChainId === ARC_CHAIN_ID)
  const trackedEtaLabel = isTrackedBaseToArc ? '15-20 minutes' : isTrackedOptimismToArc ? '20-30 minutes' : '20-30 minutes'
  const trackedEstimatedMinutes = isTrackedBaseToArc ? 20 : 30
  const trackedElapsedMinutes = trackedBridge ? Math.max(0, Math.floor((trackerNowMs - trackedBridge.startedAt) / 60000)) : 0
  const trackedRemainingMinutes = trackedBridge ? Math.max(0, trackedEstimatedMinutes - trackedElapsedMinutes) : 0
  const trackedCompletionLabel = trackedElapsedMinutes > 0 ? `Completed in ~${trackedElapsedMinutes} min` : 'Completed just now'
  const hasBridgeReachedArc = Boolean(state.step === 'success' || trackedReceiveTxHash)
  const hasOnlyOffchainSignature = trackedSignatureCount > 0 && trackedTxHashes.length === 0
  const hasBridgeStartedOnSource = Boolean(trackedTxHashes.length > 0 || trackedBridge?.step === 'approving' || trackedBridge?.step === 'signing-bridge' || trackedBridge?.step === 'waiting-receive-message')
  const isWaitingForArrival = Boolean(trackedBridge) && !hasBridgeReachedArc && (trackedHasBurnTx || state.step === 'waiting-receive-message')

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

  const getBridgeTrackerHeadline = () => {
    if (hasBridgeReachedArc) {
      return 'Bridge completed on Arc'
    }

    if (isWaitingForArrival) {
      return trackedRemainingMinutes > 0 ? `Wait about ${trackedRemainingMinutes} min` : 'Waiting for Arc mint'
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

    if (pendingBridge.destinationChainId === ARC_CHAIN_ID && (pendingBridge.sourceChainId === OPTIMISM_CHAIN_ID || pendingBridge.sourceChainId === BASE_CHAIN_ID)) {
      setTrackerSnapshot(pendingBridge)
    }
  }, [pendingBridge])

  useEffect(() => {
    if (pendingBridge && pendingBridge.destinationChainId === ARC_CHAIN_ID && (pendingBridge.sourceChainId === OPTIMISM_CHAIN_ID || pendingBridge.sourceChainId === BASE_CHAIN_ID)) {
      setIsBridgeTrackerOpen(true)
    }
  }, [pendingBridge])

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
          error: error instanceof Error ? error.message : 'Could not estimate the forwarding fee right now.',
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
        alert('Checking the current forwarding fee. Please wait a moment and try again.')
        return
      }

      if (gatewayQuote.error) {
        alert(gatewayQuote.error)
        return
      }

      if (hasQuotedShortfall) {
        alert(`This send needs ${gatewayQuote.totalRequired} USDC in total including fee, but only ${walletState.availableBalance} USDC is currently available in Gateway.`)
        return
      }

      await forwardToSolana({
        amount,
        sourceChainId,
        recipientWalletAddress: solanaRecipient,
      })
      return
    }

    await bridge(selectedToken, amount, {
      sourceChainId,
      destinationChainId: destinationEvmChainId,
    })
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

      const transaction = {
        id: `${Date.now()}`,
        type: 'bridge',
        direction: transactionDirection,
        amount: amount,
        fromNetwork: transactionSourceChainName,
        toNetwork: transactionDestinationChainName,
        timestamp: new Date().toISOString(),
        sourceTxHash: state.sourceTxHash,
        receiveTxHash: state.receiveTxHash,
      }

      const existingTransactions = JSON.parse(localStorage.getItem('bridgeTransactions') || '[]')
      const isAlreadySaved = existingTransactions.some((t: any) => t.id === transaction.id)
      if (!isAlreadySaved) {
        existingTransactions.unshift(transaction)
        localStorage.setItem('bridgeTransactions', JSON.stringify(existingTransactions.slice(0, 10)))
      }
    }
  }, [bridgeMode, state.step, state.sourceChainId, state.destinationChainId, amount, state.sourceTxHash, state.receiveTxHash, pendingBridge])

  useEffect(() => {
    if (!pendingBridge?.receiveTxHash) {
      return
    }

    setTrackerSnapshot(pendingBridge)
    localStorage.removeItem(PENDING_BRIDGE_KEY)
    lastPendingBridgeJsonRef.current = null
    setPendingBridge(null)
  }, [pendingBridge])

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
          return 'Estimating forwarding fees...'
        case 'signing-burn-intent':
          return 'Sign the Gateway burn intent...'
        case 'submitting-transfer':
          return 'Submitting forwarding request...'
        case 'waiting-finality':
          return 'Waiting for Gateway finality...'
        default:
          return 'Processing forwarding request...'
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
    activeState.isLoading ||
    activeState.step === 'success' ||
    !hasAmount ||
    (!isSolanaMode && !isSolanaSourceMode && sourceEvmChainId === destinationEvmChainId) ||
    (!isSolanaMode && !isSolanaSourceMode && !isRouteEnabled) ||
    (isSolanaSourceMode && (!phantomSolanaProvider || !isPhantomConnected || isLoadingSolanaBalance || (!solanaBalanceError && parseFloat(amount) > numericSolanaBalance))) ||
    (!isSolanaMode && !isSolanaSourceMode && parseFloat(amount) > numericBalance) ||
    (isSolanaMode && (walletState.isLoadingBalances || gatewayQuote.isLoading || !isSolanaRecipientValid || Boolean(gatewayQuote.error) || hasQuotedShortfall))
  const trackedSourceTxUrl = trackedBridge && trackedSourceTxHash
    ? getTxExplorerUrl(trackedBridge.sourceChainId, trackedSourceTxHash)
    : undefined
  const trackedReceiveTxUrl = trackedBridge && trackedReceiveTxHash
    ? getTxExplorerUrl(trackedBridge.destinationChainId, trackedReceiveTxHash)
    : undefined

  if (!isConnected) {
    return (
      <Container className="py-12">
        <Card className="text-center">
          <ArrowLeftRight size={48} className="mx-auto mb-4 text-slate-400" />
          <h2 className="text-xl font-semibold mb-2">Connect Your Wallet</h2>
          <p className="text-slate-500">Connect your wallet to bridge USDC across supported EVM routes.</p>
        </Card>
      </Container>
    )
  }

  return (
    <>
      <Container className="py-12">
        <div className="max-w-xl mx-auto">
        <Card>
          <h2 className="text-2xl font-bold mb-2">Bridge USDC</h2>
          <p className="mb-6 text-sm text-slate-500">Choose the route, review balances, then follow the guided confirmations.</p>

          {trackedBridge && (isTrackedOptimismToArc || isTrackedBaseToArc) && (
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
                  onClick={() => setIsBridgeTrackerOpen(true)}
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
                Solana Forwarding
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
                  This path forwards to Solana using Circle Gateway and currently supports Arc as the source chain only.
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
                    <p className="font-semibold">Forwarding balance</p>
                    <p className="mt-1 text-xs text-amber-900/70">
                      Your deposit has to finish processing before it can be sent to Solana.
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
                    <span>Available in Gateway</span>
                    <span>{walletState.availableBalance} USDC</span>
                  </div>
                  {processingGatewayBalance > 0 && (
                    <div className="mt-2 flex items-center justify-between text-xs text-slate-500">
                      <span>Still processing</span>
                      <span>{processingGatewayBalance.toFixed(6)} USDC</span>
                    </div>
                  )}
                </div>
                {processingGatewayBalance > 0 ? (
                  <p className="text-xs text-amber-900/80">
                    Circle has your deposit, but it is not sendable yet. There is no exact ETA from the API. Refresh until `Available in Gateway` increases.
                  </p>
                ) : (
                  <p className="text-xs text-amber-900/80">
                    This is your current Gateway balance before the forwarding fee is deducted.
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
              <label className="mb-2 block text-sm font-medium text-slate-700">Amount</label>
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
                <p className="mt-1 text-xs text-slate-500">Checking the current forwarding fee...</p>
              )}
              {isSolanaMode && hasAmount && gatewayQuote.error && (
                <p className="text-xs text-red-400 mt-1">{gatewayQuote.error}</p>
              )}
              {isSolanaMode && hasGatewayQuote && (
                <div className="mt-3 space-y-2 rounded-xl border border-slate-200 bg-slate-50 p-3 text-xs text-slate-600">
                  <div className="flex items-center justify-between gap-3">
                    <span>Estimated fee</span>
                    <span>{gatewayQuote.estimatedFee} USDC</span>
                  </div>
                  <div className="flex items-center justify-between gap-3">
                    <span>Safety buffer</span>
                    <span>{gatewayQuote.feeBuffer} USDC</span>
                  </div>
                  <div className="flex items-center justify-between gap-3">
                    <span>Total needed now</span>
                    <span>{gatewayQuote.totalRequired} USDC</span>
                  </div>
                  <div className="flex items-center justify-between gap-3">
                    <span>Approx. max you can send now</span>
                    <span>{approxMaxSendable.toFixed(6)} USDC</span>
                  </div>
                </div>
              )}
              {isSolanaMode && hasGatewayQuote && hasQuotedShortfall && (
                <p className="text-xs text-amber-300 mt-1">
                  This send needs {gatewayQuote.totalRequired} USDC in total. Top up about {topUpNeeded.toFixed(6)} more USDC in Gateway, or lower the amount.
                </p>
              )}
              {isSolanaMode && hasGatewayQuote && !hasQuotedShortfall && (
                <p className="mt-1 text-xs text-slate-500">
                  The fee is estimated by Circle and can change slightly with route and amount. `Total needed now` includes a small safety buffer.
                </p>
              )}
            </div>

            {isSolanaMode && (
              <div className="space-y-2 rounded-2xl border border-slate-200 bg-[#f8faf7] p-4">
                <p className="text-sm font-medium">Gateway Deposit</p>
                <p className="text-xs text-slate-500">
                  Move USDC from your wallet into Gateway on {sourceChainName} if the total needed is higher than your available Gateway balance.
                </p>
                <p className="text-xs text-slate-500">
                  This usually needs 2 wallet confirmations: first `Approve`, then `Deposit`.
                </p>
                <Button
                  variant="secondary"
                  onClick={handleGatewayDeposit}
                  disabled={
                    walletState.isDepositing ||
                    walletState.isPollingDeposit ||
                    activeState.isLoading ||
                    !hasAmount ||
                    walletState.isLoadingBalances ||
                    parseFloat(amount) > numericWalletBalance
                  }
                  loading={walletState.isDepositing}
                  className="w-full"
                >
                  Deposit {amount || '0'} USDC to Gateway
                </Button>
                {hasAmount && parseFloat(amount) > numericWalletBalance && (
                  <p className="text-xs text-red-400">Wallet USDC balance is too low for this Gateway deposit</p>
                )}
                {walletState.depositStatus && (
                  <div className="flex items-start gap-2 text-xs text-slate-600">
                    {(walletState.isDepositing || walletState.isPollingDeposit) && <Loader2 size={12} className="mt-0.5 animate-spin flex-shrink-0" />}
                    <p>{walletState.depositStatus}</p>
                  </div>
                )}
                {walletState.approvalTxHash && !walletState.depositTxHash && (
                  <a
                    href={
                      sourceChainId === SEPOLIA_CHAIN_ID
                        ? `https://sepolia.etherscan.io/tx/${walletState.approvalTxHash}`
                        : `https://testnet.arcscan.app/tx/${walletState.approvalTxHash}`
                    }
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex items-center gap-2 text-xs text-[#2F6E0C] transition-colors hover:text-[#25580A]"
                  >
                    <span>View approval tx</span>
                    <ExternalLink size={12} />
                  </a>
                )}
                {!walletState.isDepositing && !walletState.isPollingDeposit && walletState.error && (
                  <p className="text-xs text-amber-700">
                    If you only confirmed `Approve`, the deposit has not been sent yet. Start the deposit again and confirm the second wallet popup.
                  </p>
                )}
                {walletState.depositTxHash && (
                  <a
                    href={
                      sourceChainId === SEPOLIA_CHAIN_ID
                        ? `https://sepolia.etherscan.io/tx/${walletState.depositTxHash}`
                        : `https://testnet.arcscan.app/tx/${walletState.depositTxHash}`
                    }
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex items-center gap-2 text-xs text-[#2F6E0C] transition-colors hover:text-[#25580A]"
                  >
                    <span>View Gateway deposit tx</span>
                    <ExternalLink size={12} />
                  </a>
                )}
                {walletState.pendingDeposits.length > 0 && (
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
              </div>
            )}

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
                      className="flex items-center gap-2 hover:text-green-100 transition-colors"
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
                      className="flex items-center gap-2 hover:text-green-100 transition-colors"
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
                    <p className="font-semibold">Forwarding Successful! 🎉</p>
                    <p className="text-xs mt-1">USDC forwarding from {sourceChainName} to {destinationChainName} was confirmed by Gateway.</p>
                  </div>
                </div>
                <div className="space-y-1 mt-3 pt-3 border-t border-green-400/20 text-xs text-green-100/90">
                  {gatewayState.transferId && <p className="break-all">Transfer ID: {gatewayState.transferId}</p>}
                  {gatewayState.status && <p>Gateway status: {gatewayState.status}</p>}
                  {gatewayState.recipientAta && <p className="break-all">Recipient ATA: {gatewayState.recipientAta}</p>}
                </div>
              </div>
            )}

            {/* EVM bridge wait-time notice */}
            {isTrackedBridgeRoute && state.step !== 'success' && (
              <div className="flex items-start gap-2 rounded-xl border border-blue-200 bg-blue-50 p-3 text-xs text-blue-800">
                <Clock size={13} className="mt-0.5 flex-shrink-0 text-blue-500" />
                <p>
                  {isBaseToArcRoute ? 'Base (CCTP Bridge)' : 'Optimism (CCTP Bridge)'} typically takes <strong>{trackedEtaLabel}</strong> on testnet. Three wallet confirmations
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
                      : 'Forwarding...'
                    : state.step === 'switching-network'
                      ? 'Switching Network...'
                      : 'Bridging...'}
                </>
              ) : activeState.step === 'success' ? (
                isSolanaMode ? 'Forwarding Complete' : 'Bridge Complete'
              ) : (
                isSolanaSourceMode
                  ? `Bridge ${amount || '0'} ${selectedToken} from Solana`
                  : isSolanaMode
                  ? `Forward ${amount || '0'} ${selectedToken} to Solana`
                  : `Bridge ${amount || '0'} ${selectedToken}`
              )}
            </Button>

            {/* Reset Button (after success) */}
            {activeState.step === 'success' && (
              <button
                onClick={() => {
                  if (isSolanaMode) {
                    resetGateway()
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
                {isSolanaMode ? 'Forward Again' : 'Bridge Again'}
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
                <p><strong>Solana Forwarding Process:</strong></p>
                <p>1. <strong>Deposit</strong>: Move USDC from your connected wallet into Gateway on the selected source chain</p>
                <p>2. <strong>Finalize</strong>: Wait until Gateway marks that deposit as available balance</p>
                <p>3. <strong>Estimate</strong>: The app derives the recipient ATA and estimates forwarding fees</p>
                <p>4. <strong>Sign and Forward</strong>: You sign the Gateway burn intent and Circle forwards the destination mint to Solana</p>
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

      {trackedBridge && (isTrackedOptimismToArc || isTrackedBaseToArc) && isBridgeTrackerOpen && (
        <div className="fixed inset-0 z-[90] flex items-center justify-center bg-slate-950/70 px-4 py-6 backdrop-blur-sm">
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="bridge-tracker-title"
            className="relative w-full max-w-lg rounded-[28px] border border-slate-200 bg-white p-6 shadow-[0_24px_80px_rgba(15,23,42,0.28)]"
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
              Bridge {trackedBridge.amount} {trackedBridge.token}
            </h2>
            <p className="mt-2 text-sm text-slate-500">{isTrackedBaseToArc ? 'Via Base (CCTP Bridge)' : isTrackedOptimismToArc ? 'Via Optimism (CCTP Bridge)' : 'Bridge status tracker'}</p>

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

            <div className="mt-4 space-y-3">
              {hasBridgeReachedArc && (
                <div className="rounded-2xl border border-[#66D121]/25 bg-[#eef7e8] p-4 text-[#25580A]">
                  <div className="flex items-start gap-3">
                    <CheckCircle size={18} className="mt-0.5 flex-shrink-0" />
                    <div>
                      <p className="text-sm font-semibold">Funds received on Arc</p>
                      <p className="mt-1 text-xs text-[#25580A]">{trackedBridge.amount} {trackedBridge.token} arrived on {trackedDestinationChainName}. {trackedCompletionLabel}.</p>
                    </div>
                  </div>
                </div>
              )}

              <div className="rounded-2xl border border-slate-200 bg-white p-4">
                <div className="flex items-center justify-between gap-3">
                  <div className="flex items-center gap-3">
                    <div className={`rounded-full p-1 ${hasBridgeStartedOnSource ? 'bg-[#eef7e8] text-[#2F6E0C]' : 'bg-slate-100 text-slate-400'}`}>
                      <CheckCircle size={16} />
                    </div>
                    <div>
                      <p className="text-sm font-semibold text-slate-900">Start on {trackedSourceChainName}</p>
                      <p className="text-xs text-slate-500">
                        {hasOnlyOffchainSignature
                          ? 'Wallet signature captured. No on-chain transaction has been submitted yet.'
                          : hasBridgeStartedOnSource
                            ? 'Source-chain transaction submitted.'
                            : 'Waiting for source-chain transaction.'}
                      </p>
                    </div>
                  </div>
                  {trackedSourceTxUrl && (
                    <a
                      href={trackedSourceTxUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="flex items-center gap-1 text-xs font-medium text-[#2F6E0C] transition-colors hover:text-[#25580A]"
                    >
                      View tx
                      <ExternalLink size={12} />
                    </a>
                  )}
                </div>
              </div>

              <div className="rounded-2xl border border-slate-200 bg-white p-4">
                <div className="flex items-center justify-between gap-3">
                  <div className="flex items-center gap-3">
                    <div className={`rounded-full p-1 ${isWaitingForArrival ? 'bg-amber-100 text-amber-700' : hasBridgeReachedArc ? 'bg-[#eef7e8] text-[#2F6E0C]' : 'bg-slate-100 text-slate-400'}`}>
                      {isWaitingForArrival ? <Loader2 size={16} className="animate-spin" /> : <Clock size={16} />}
                    </div>
                    <div>
                      <p className="text-sm font-semibold text-slate-900">
                        {hasBridgeReachedArc ? 'Bridge relayed to Arc' : `Wait ${trackedRemainingMinutes > 0 ? `${trackedRemainingMinutes} min` : 'for Arc mint'}`}
                      </p>
                      <p className="text-xs text-slate-500">
                        {isTrackedBaseToArc
                          ? 'Base testnet transfers usually settle in 15-20 minutes.'
                          : isTrackedOptimismToArc
                            ? 'Optimism testnet transfers usually settle in 20-30 minutes.'
                            : 'Waiting for the destination-chain mint to be confirmed.'}
                      </p>
                    </div>
                  </div>
                  <p className="text-xs text-slate-500">Elapsed {trackedElapsedMinutes} min</p>
                </div>
              </div>

              <div className="rounded-2xl border border-slate-200 bg-white p-4">
                <div className="flex items-center justify-between gap-3">
                  <div className="flex items-center gap-3">
                    <div className={`rounded-full p-1 ${hasBridgeReachedArc ? 'bg-[#eef7e8] text-[#2F6E0C]' : 'bg-slate-100 text-slate-400'}`}>
                      {hasBridgeReachedArc ? <CheckCircle size={16} /> : <AlertCircle size={16} />}
                    </div>
                    <div>
                      <p className="text-sm font-semibold text-slate-900">Get {trackedBridge.amount} {trackedBridge.token} on {trackedDestinationChainName}</p>
                      <p className="text-xs text-slate-500">
                        {hasBridgeReachedArc ? 'Destination mint confirmed.' : 'Destination mint has not been confirmed yet.'}
                      </p>
                    </div>
                  </div>
                  {trackedReceiveTxUrl && (
                    <a
                      href={trackedReceiveTxUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="flex items-center gap-1 text-xs font-medium text-[#2F6E0C] transition-colors hover:text-[#25580A]"
                    >
                      View tx
                      <ExternalLink size={12} />
                    </a>
                  )}
                </div>
              </div>
            </div>

            <div className="mt-5 flex flex-wrap gap-3">
              {pendingBridge && !hasBridgeReachedArc && (
                <button
                  onClick={() => void resumePendingBridge(pendingBridge)}
                  disabled={state.isLoading}
                  className="inline-flex items-center justify-center rounded-2xl bg-[#2F6E0C] px-4 py-3 text-sm font-semibold text-white transition-colors hover:bg-[#25580A] disabled:opacity-60"
                >
                  {state.isLoading ? 'Continuing...' : 'Continue pending bridge'}
                </button>
              )}
              {getAddressExplorerUrl(trackedBridge.sourceChainId, trackedBridge.walletAddress) && (
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
                    setIsBridgeTrackerOpen(false)
                  }}
                  className="inline-flex items-center justify-center rounded-2xl border border-slate-300 bg-white px-4 py-3 text-sm font-semibold text-slate-700 transition-colors hover:bg-slate-50"
                >
                  Clear tracker
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  )
}
