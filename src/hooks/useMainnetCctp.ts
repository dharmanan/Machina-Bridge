import { useCallback, useMemo, useState } from 'react'
import { useAccount, useSwitchChain } from 'wagmi'
import { getWalletClient } from 'wagmi/actions'
import {
  createPublicClient,
  fallback,
  formatUnits,
  http,
  parseUnits,
  type Hex,
} from 'viem'
import { getCircleMainnetReadiness } from '../config/circle'
import { getRuntimeCapabilities } from '../config/features'
import { getMainnetReadiness } from '../config/mainnet'
import {
  getDefaultMainnetCctpTransferMode,
  getMainnetCctpChain,
  getMainnetCctpRoute,
} from '../config/mainnetCctp'
import {
  getMainnetCanaryRoute,
  isMainnetCanaryRouteWriteEnabled,
} from '../config/mainnetCanary'
import {
  MAINNET_CCTP_CANARY_ENABLED,
  MAINNET_RUNTIME_IMPLEMENTED,
} from '../config/runtime'
import { inspectMainnetTransferRecovery } from '../lib/mainnetCctpRecovery'
import { assertNoUnresolvedSend, isWalletRejection, readSendAttempt } from '../lib/mainnetCctpSendRecovery'
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
import {
  createMainnetTransferRecord,
  getMainnetTransfer,
  transitionMainnetTransfer,
  updateMainnetTransferRecord,
} from '../lib/mainnetTransferQueue'

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

function globalMainnetWritesEnabled() {
  const capabilities = getRuntimeCapabilities('mainnet')
  return MAINNET_RUNTIME_IMPLEMENTED
    && capabilities.evmBridge
    && capabilities.realValueTransfers
}

function canaryReadinessPassed() {
  return MAINNET_CCTP_CANARY_ENABLED
    && getMainnetReadiness().ready
    && getCircleMainnetReadiness().cctpReady
}

function assertCanaryTransferRecord(input: {
  transferId?: string
  connectedAddress: string
}) {
  if (!input.transferId) {
    throw new Error('Mainnet transfer requires a persistent transfer record.')
  }

  const record = getMainnetTransfer(input.transferId)
  if (!record) {
    throw new Error('Mainnet transfer record was not found.')
  }

  const connected = input.connectedAddress.toLowerCase()
  const amountRaw = parseUnits(record.amount, 6)

  const policy = getMainnetCanaryRoute(
    record.sourceChainId,
    record.destinationChainId,
  )

  if (
    !policy
    || !isMainnetCanaryRouteWriteEnabled(
      record.sourceChainId,
      record.destinationChainId,
    )
    || (!record.recovered && record.mode !== getDefaultMainnetCctpTransferMode(record.sourceChainId))
    || amountRaw <= 0n
    || record.walletAddress.toLowerCase() !== connected
    || record.recipient.toLowerCase() !== connected
    || (record.destinationCaller.toLowerCase() !== connected && !(record.recovered && /^0x0{40}$/.test(record.destinationCaller)))
  ) {
    throw new Error(
      'Transfer does not match the selected verified route or connected wallet.',
    )
  }

  return { record, amountRaw }
}

function assertCanaryApprovalAllowed(input: {
  sourceChainId: number
  amountRaw: bigint
  transferId?: string
  connectedAddress: string
}) {
  if (globalMainnetWritesEnabled()) return

  if (!canaryReadinessPassed()) {
    throw new Error('Mainnet bridge services are not ready.')
  }

  const { record, amountRaw } = assertCanaryTransferRecord(input)

  if (
    input.sourceChainId !== record.sourceChainId
    || input.amountRaw !== amountRaw
    || record.stage !== 'approval_required'
  ) {
    throw new Error('Approval does not match the current transfer.')
  }
}

function assertCanaryBurnAllowed(input: {
  quote: MainnetCctpQuote
  transferId?: string
  connectedAddress: string
  recipient: string
  destinationCaller: string
}) {
  if (globalMainnetWritesEnabled()) return

  if (!canaryReadinessPassed()) {
    throw new Error('Mainnet bridge services are not ready.')
  }

  const { record, amountRaw } = assertCanaryTransferRecord(input)
  const connected = input.connectedAddress.toLowerCase()

  if (
    input.quote.sourceChainId !== record.sourceChainId
    || input.quote.destinationChainId !== record.destinationChainId
    || input.quote.mode !== record.mode
    || input.quote.amountRaw !== amountRaw
    || input.recipient.toLowerCase() !== connected
    || input.destinationCaller.toLowerCase() !== connected
    || (record.stage !== 'ready' && record.stage !== 'approved')
  ) {
    throw new Error('Source send does not match the current transfer.')
  }
}

function assertCanaryMintAllowed(input: {
  destinationChainId: number
  transferId?: string
  connectedAddress: string
}) {
  if (globalMainnetWritesEnabled()) return

  if (!canaryReadinessPassed()) {
    throw new Error('Mainnet bridge services are not ready.')
  }

  const { record } = assertCanaryTransferRecord(input)

  if (
    input.destinationChainId !== record.destinationChainId
    || record.stage !== 'ready_to_mint'
    || !record.sourceTxHash
  ) {
    throw new Error('Destination receive does not match the current transfer.')
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

  const writesUnlocked = useMemo(() => globalMainnetWritesEnabled(), [])
  const canaryWritesUnlocked = useMemo(() => canaryReadinessPassed(), [])

  const reset = useCallback(() => {
    setState({
      step: 'idle',
      error: null,
      isLoading: false,
    })
  }, [])

  const createTransferPlan = useCallback((input: {
    sourceChainId: number
    destinationChainId: number
    amount: string
    approvalRequired: boolean
    mode?: MainnetCctpTransferMode
    recipient?: string
    destinationCaller?: string
  }) => {
    if (!address) {
      throw new Error('Connect a wallet before creating a mainnet transfer plan.')
    }
    assertNoUnresolvedSend(address, input.sourceChainId)

    return createMainnetTransferRecord({
      walletAddress: address,
      sourceChainId: input.sourceChainId,
      destinationChainId: input.destinationChainId,
      amount: input.amount,
      recipient: input.recipient ?? address,
      destinationCaller: input.destinationCaller ?? address,
      approvalRequired: input.approvalRequired,
      mode: input.mode ?? getDefaultMainnetCctpTransferMode(input.sourceChainId),
    })
  }, [address])

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
    transferId?: string
  }): Promise<Hex> => {
    if (!address) {
      throw new Error('Connect a wallet before submitting a mainnet approval.')
    }

    if (typeof navigator === 'undefined' || !navigator.locks) throw new Error('This browser cannot safely coordinate destination minting. Use a browser with transaction locks before starting a mainnet transfer.')

    const owner = address
    // One approval or burn per wallet at a time, across tabs; the request is never queued behind another.
    return navigator.locks.request(`machina-cctp-send:${owner.toLowerCase()}`, { ifAvailable: true }, async lock => {
    if (!lock) throw new Error('Another tab is sending a transaction from this wallet. Nothing was sent here.')
    assertCanaryApprovalAllowed({
      ...input,
      connectedAddress: owner,
    })
    assertNoUnresolvedSend(owner, input.sourceChainId, input.transferId)

    const source = getMainnetCctpChain(input.sourceChainId)

    if (!source) {
      throw new Error('Unsupported mainnet CCTP source chain.')
    }

    setState((current) => ({ ...current, step: 'approving', error: null, isLoading: true }))
    if (input.transferId) {
      transitionMainnetTransfer(input.transferId, 'approving', { lastError: undefined })
    }

    let hash: Hex | undefined, settled = false
    try {
      const walletClient = await ensureWalletOnChain(input.sourceChainId)
      const call = prepareMainnetCctpApproval(input)
      const publicClient = makePublicClient(source.rpcUrls)
      const attempt = await readSendAttempt(publicClient, owner)
      if (input.transferId) updateMainnetTransferRecord(input.transferId, { ...attempt, approvalTxHash: undefined })
      try {
        hash = await walletClient.sendTransaction({
          account: owner,
          to: call.to,
          data: call.data,
          value: call.value,
        })
      } catch (error) {
        if (isWalletRejection(error)) throw error
        // The wallet may have broadcast before failing: keep the step locked until the chain shows what happened.
        settled = true
        if (input.transferId) updateMainnetTransferRecord(input.transferId, { lastError: 'Your wallet did not confirm whether the approval was sent. Do not send it again; Machina is checking the chain.' })
        throw error
      }

      if (input.transferId) {
        updateMainnetTransferRecord(input.transferId, { approvalTxHash: hash })
      }

      const receipt = await publicClient.waitForTransactionReceipt({ hash })
      if (receipt.status !== 'success') {
        // Final on chain: no allowance was set. The hash stays in the error as evidence.
        settled = true
        if (input.transferId) transitionMainnetTransfer(input.transferId, 'approval_required', { approvalTxHash: undefined, lastError: `Approval ${hash} reverted on chain. No allowance was set.` })
        throw new Error(`Approval ${hash} reverted on chain. No allowance was set.`)
      }

      if (input.transferId) {
        transitionMainnetTransfer(input.transferId, 'approved', {
          approvalTxHash: hash,
          lastError: undefined,
        })
      }

      setState((current) => ({ ...current, step: 'idle', isLoading: false }))
      return hash
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Mainnet USDC approval failed.'
      if (input.transferId && !settled) {
        if (hash) {
          updateMainnetTransferRecord(input.transferId, {
            approvalTxHash: hash,
            lastError: 'Approval sent, result not confirmed yet. Do not send it again; Machina is checking the chain.',
          })
        } else {
          transitionMainnetTransfer(input.transferId, 'approval_required', { lastError: message })
        }
      }
      setState((current) => ({ ...current, step: 'error', error: message, isLoading: false }))
      throw error
    }
    })
  }, [address, ensureWalletOnChain])

  const burn = useCallback(async (input: {
    quote: MainnetCctpQuote
    recipient?: string
    destinationCaller?: string
    transferId?: string
  }): Promise<Hex> => {
    if (!address) {
      throw new Error('Connect a wallet before submitting a burn transaction.')
    }

    if (typeof navigator === 'undefined' || !navigator.locks) throw new Error('This browser cannot safely coordinate destination minting. Use a browser with transaction locks before starting a mainnet transfer.')

    const recipient = input.recipient ?? address
    const destinationCaller = input.destinationCaller ?? address

    const owner = address
    return navigator.locks.request(`machina-cctp-send:${owner.toLowerCase()}`, { ifAvailable: true }, async lock => {
    if (!lock) throw new Error('Another tab is sending a transaction from this wallet. Nothing was sent here.')
    assertCanaryBurnAllowed({
      quote: input.quote,
      transferId: input.transferId,
      connectedAddress: owner,
      recipient,
      destinationCaller,
    })
    assertNoUnresolvedSend(owner, input.quote.sourceChainId, input.transferId)

    const route = getMainnetCctpRoute(input.quote.sourceChainId, input.quote.destinationChainId)
    if (!route) {
      throw new Error('Unsupported mainnet CCTP route.')
    }

    setState((current) => ({ ...current, step: 'burning', error: null, isLoading: true }))
    const transferBeforeBurn = input.transferId ? getMainnetTransfer(input.transferId) : undefined
    const previousStage = transferBeforeBurn?.approvalTxHash ? 'approved' : 'ready'
    if (input.transferId) {
      transitionMainnetTransfer(input.transferId, 'burning', { lastError: undefined })
    }

    let hash: Hex | undefined, settled = false
    try {
      const walletClient = await ensureWalletOnChain(input.quote.sourceChainId)
      const call = prepareMainnetCctpBurn({
        quote: input.quote,
        recipient,
        destinationCaller,
      })
      const publicClient = makePublicClient(route.source.rpcUrls)
      const attempt = await readSendAttempt(publicClient, owner)
      if (input.transferId) updateMainnetTransferRecord(input.transferId, { ...attempt, sourceTxHash: undefined })
      try {
        hash = await walletClient.sendTransaction({
          account: owner,
          to: call.to,
          data: call.data,
          value: call.value,
        })
      } catch (error) {
        if (isWalletRejection(error)) throw error
        // The wallet may have broadcast before failing: never offer a second burn until the chain shows what happened.
        settled = true
        if (input.transferId) updateMainnetTransferRecord(input.transferId, { lastError: 'Your wallet did not confirm whether the transfer was sent. Do not send it again; Machina is checking the chain.' })
        throw error
      }

      if (input.transferId) {
        updateMainnetTransferRecord(input.transferId, { sourceTxHash: hash })
      }

      const receipt = await publicClient.waitForTransactionReceipt({ hash })
      if (receipt.status !== 'success') {
        // Final on chain: no USDC left the wallet. The hash stays in the error as evidence, not as a source burn.
        settled = true
        if (input.transferId) transitionMainnetTransfer(input.transferId, previousStage, { sourceTxHash: undefined, lastError: `Transfer ${hash} reverted on chain. No USDC was sent.` })
        throw new Error(`Transfer ${hash} reverted on chain. No USDC was sent.`)
      }

      if (input.transferId) {
        transitionMainnetTransfer(input.transferId, 'waiting_attestation', {
          sourceTxHash: hash,
          lastError: undefined,
        })
      }

      setState((current) => ({
        ...current,
        step: 'waiting-attestation',
        isLoading: false,
        sourceTxHash: hash,
      }))
      return hash
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Mainnet CCTP burn failed.'
      if (input.transferId && !settled) {
        if (hash) {
          updateMainnetTransferRecord(input.transferId, {
            sourceTxHash: hash,
            lastError: 'Transfer sent, result not confirmed yet. Do not send it again; Machina is checking the chain.',
          })
        } else {
          transitionMainnetTransfer(
            input.transferId,
            previousStage,
            { lastError: message },
          )
        }
      }
      setState((current) => ({ ...current, step: 'error', error: message, isLoading: false }))
      throw error
    }
    })
  }, [address, ensureWalletOnChain])

  const getAttestation = useCallback(async (input: {
    sourceChainId: number
    sourceTxHash: Hex
    transferId?: string
  }): Promise<MainnetCctpAttestation> => {
    setState((current) => ({ ...current, step: 'waiting-attestation', error: null, isLoading: true }))
    try {
      const result = await fetchMainnetCctpAttestation({
        sourceChainId: input.sourceChainId,
        transactionHash: input.sourceTxHash,
      })

      if (input.transferId && result.status === 'complete') {
        transitionMainnetTransfer(input.transferId, 'ready_to_mint', {
          attestationReadyAt: Date.now(),
          lastError: undefined,
        })
      }

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
    transferId?: string
  }): Promise<Hex | undefined> => {
    if (!address) {
      throw new Error('Connect a wallet before submitting the mint transaction.')
    }

    if (!input.transferId || !navigator.locks) throw new Error('Safe recovery requires a persistent transfer record and browser transaction lock.')
    return navigator.locks.request(`machina-cctp-mint:${input.transferId}`, { ifAvailable: true }, async lock => {
    if (!lock) throw new Error('Another tab is already processing this transfer. No second mint was requested.')
    assertCanaryMintAllowed({
      destinationChainId: input.destinationChainId,
      transferId: input.transferId,
      connectedAddress: address,
    })

    const destination = getMainnetCctpChain(input.destinationChainId)

    if (!destination) {
      throw new Error('Unsupported mainnet CCTP destination chain.')
    }

    const record = getMainnetTransfer(input.transferId!)!
    if (record.stage === 'minting' || record.mintRequestedAt || record.destinationTxHash) throw new Error('An earlier mint may still be pending. Recheck its status; do not submit again.')
    const checked = await inspectMainnetTransferRecovery({ sourceChainId: record.sourceChainId, sourceTxHash: record.sourceTxHash!, owner: address, sourceLogIndex: record.sourceLogIndex })
    if (checked.proof.destinationChainId !== record.destinationChainId || parseUnits(checked.proof.amount,6) !== parseUnits(record.amount,6)) throw new Error('Recovered burn does not match this transfer record.')
    if (checked.stage === 'complete') {
      updateMainnetTransferRecord(record.id, { stage:'complete', lastError:undefined })
      setState({ step:'success',error:null,isLoading:false })
      return undefined
    }
    if (checked.stage !== 'ready_to_mint' || checked.message?.toLowerCase() !== input.message.toLowerCase() || checked.attestation?.toLowerCase() !== input.attestation.toLowerCase()) throw new Error('Attestation changed or is not ready. Recheck this transfer before minting.')
    setState((current) => ({ ...current, step: 'minting', error: null, isLoading: true }))
    if (input.transferId) {
      transitionMainnetTransfer(input.transferId, 'minting', { lastError: undefined })
    }

    let hash: Hex | undefined
    let requested = false
    try {
      const call = prepareMainnetCctpMint(input)
      const publicClient = makePublicClient(destination.rpcUrls)

      const nativeBalanceRaw = await publicClient.getBalance({
        address,
      })

      if (nativeBalanceRaw <= 0n) {
        throw new Error(
          `Destination wallet has no ${destination.nativeCurrency.symbol} for mint gas.`,
        )
      }

      const [gasPrice, estimatedGas] = await Promise.all([
        publicClient.getGasPrice(),
        publicClient.estimateGas({
          account: address,
          to: call.to,
          data: call.data,
          value: call.value,
        }),
      ])

      const estimatedGasCostRaw = estimatedGas * gasPrice

      if (nativeBalanceRaw < estimatedGasCostRaw) {
        throw new Error(
          `Insufficient ${destination.nativeCurrency.symbol} for destination mint gas. `
          + `Available ${formatUnits(
            nativeBalanceRaw,
            destination.nativeCurrency.decimals,
          )}; estimated requirement ${formatUnits(
            estimatedGasCostRaw,
            destination.nativeCurrency.decimals,
          )}.`,
        )
      }

      const walletClient = await ensureWalletOnChain(
        input.destinationChainId,
      )

      const [accounts, walletChain] = await Promise.all([walletClient.getAddresses(), walletClient.getChainId()])
      if (accounts[0]?.toLowerCase() !== address.toLowerCase() || walletChain !== input.destinationChainId) throw new Error('Wallet or network changed. No mint was requested.')
      const fresh = await inspectMainnetTransferRecovery({ sourceChainId:record.sourceChainId, sourceTxHash:record.sourceTxHash!, owner:address, sourceLogIndex:record.sourceLogIndex })
      if (fresh.stage !== 'ready_to_mint' || fresh.message !== checked.message || fresh.attestation !== checked.attestation) throw new Error('Transfer state changed before wallet confirmation. Recheck without sending again.')
      updateMainnetTransferRecord(record.id, { mintRequestedAt:Date.now() })
      requested = true
      hash = await walletClient.sendTransaction({
        account: address,
        to: call.to,
        data: call.data,
        value: call.value,
      })

      if (input.transferId) {
        updateMainnetTransferRecord(input.transferId, {
          destinationTxHash: hash,
        })
      }

      const receipt = await publicClient.waitForTransactionReceipt({ hash })
      if (receipt.status !== 'success') { requested = false; hash = undefined; updateMainnetTransferRecord(record.id, { mintRequestedAt:undefined, destinationTxHash:undefined }); throw new Error('Destination mint reverted. Recheck the transfer before trying again.') }
      const verified = await inspectMainnetTransferRecovery({ sourceChainId:record.sourceChainId, sourceTxHash:record.sourceTxHash!, owner:address, sourceLogIndex:record.sourceLogIndex })
      if (verified.stage !== 'complete') throw new Error('Mint receipt exists, but independent nonce verification is unavailable. Do not send again.')

      if (input.transferId) {
        transitionMainnetTransfer(input.transferId, 'complete', {
          destinationTxHash: hash,
          lastError: undefined,
        })
      }

      setState((current) => ({
        ...current,
        step: 'success',
        isLoading: false,
        destinationTxHash: hash,
      }))
      return hash
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Mainnet CCTP mint failed.'
      if (input.transferId) {
        if (hash) {
          updateMainnetTransferRecord(input.transferId, {
            destinationTxHash: hash,
            lastError: message,
          })
        } else if (!requested || (error as {code?:number})?.code === 4001) {
          transitionMainnetTransfer(input.transferId, 'ready_to_mint', { lastError: message, mintRequestedAt:undefined })
        } else {
          updateMainnetTransferRecord(input.transferId, { lastError:'Wallet submission outcome is unknown. Recheck; no second mint is allowed.' })
        }
      }
      setState((current) => ({ ...current, step: 'error', error: message, isLoading: false }))
      throw error
    }
    })
  }, [address, ensureWalletOnChain])

  return {
    state,
    writesUnlocked,
    canaryWritesUnlocked,
    createTransferPlan,
    quote,
    simulateSource,
    approve,
    burn,
    getAttestation,
    mint,
    reset,
  }
}
