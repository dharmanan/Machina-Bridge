import { useMemo, useState } from 'react'
import { useAccount, usePublicClient, useReadContract, useWriteContract } from 'wagmi'
import type { Address } from 'viem'
import { ARC_EVM_CHAIN_ID } from '../lib/chains'
import { bitmapToDays, COUNTDOWN_ABI, COUNTDOWN_CONTRACT_ADDRESS, HAS_COUNTDOWN_CONTRACT } from './contract'

function getPreviewContractOverride(): Address | undefined {
  if (typeof window === 'undefined') return undefined
  if (!window.location.hostname.includes('-git-feature-')) return undefined

  const value = new URLSearchParams(window.location.search).get('contract')
  if (!value || !/^0x[a-fA-F0-9]{40}$/.test(value)) return undefined
  return value as Address
}

export function useCountdownContract() {
  const { address, chainId } = useAccount()
  const publicClient = usePublicClient({ chainId: ARC_EVM_CHAIN_ID })
  const [isConfirming, setIsConfirming] = useState(false)
  const [confirmedHash, setConfirmedHash] = useState<`0x${string}` | undefined>(undefined)
  const [receiptError, setReceiptError] = useState<Error | null>(null)

  const activeContractAddress = useMemo(
    () => getPreviewContractOverride() ?? COUNTDOWN_CONTRACT_ADDRESS,
    [],
  )
  const contractConfigured = Boolean(activeContractAddress) && HAS_COUNTDOWN_CONTRACT

  const owner = useReadContract({
    abi: COUNTDOWN_ABI,
    address: activeContractAddress,
    functionName: 'owner',
    chainId: ARC_EVM_CHAIN_ID,
    query: { enabled: contractConfigured },
  })

  const currentDay = useReadContract({
    abi: COUNTDOWN_ABI,
    address: activeContractAddress,
    functionName: 'currentDay',
    chainId: ARC_EVM_CHAIN_ID,
    query: { enabled: contractConfigured },
  })

  const claimedBitmap = useReadContract({
    abi: COUNTDOWN_ABI,
    address: activeContractAddress,
    functionName: 'claimedBitmap',
    args: address ? [address] : undefined,
    chainId: ARC_EVM_CHAIN_ID,
    query: { enabled: contractConfigured && Boolean(address) },
  })

  const claimedCount = useReadContract({
    abi: COUNTDOWN_ABI,
    address: activeContractAddress,
    functionName: 'claimedCount',
    args: address ? [address] : undefined,
    chainId: ARC_EVM_CHAIN_ID,
    query: { enabled: contractConfigured && Boolean(address) },
  })

  const tokenUri = useReadContract({
    abi: COUNTDOWN_ABI,
    address: activeContractAddress,
    functionName: 'uri',
    args: [1n],
    chainId: ARC_EVM_CHAIN_ID,
    query: { enabled: contractConfigured },
  })

  const { data: txHash, error: writeError, isPending: isWalletPending, writeContractAsync, reset: resetWagmiWrite } = useWriteContract()

  const claimedDays = useMemo(
    () => bitmapToDays((claimedBitmap.data as bigint | undefined) ?? 0n),
    [claimedBitmap.data],
  )

  const refetch = async () => {
    await Promise.all([
      currentDay.refetch(),
      claimedBitmap.refetch(),
      claimedCount.refetch(),
      owner.refetch(),
      tokenUri.refetch(),
    ])
  }

  const submitAndWait = async (request: any) => {
    setConfirmedHash(undefined)
    setReceiptError(null)
    const hash = await writeContractAsync(request)
    if (!publicClient) throw new Error('Arc Testnet RPC is not available.')

    setIsConfirming(true)
    try {
      const receipt = await publicClient.waitForTransactionReceipt({ hash })
      if (receipt.status !== 'success') throw new Error('Transaction reverted on Arc Testnet.')
      await refetch()
      setConfirmedHash(hash)
      return hash
    } catch (error) {
      const normalized = error instanceof Error ? error : new Error('Transaction confirmation failed.')
      setReceiptError(normalized)
      throw normalized
    } finally {
      setIsConfirming(false)
    }
  }

  const claim = async () => {
    if (!contractConfigured) throw new Error('Countdown contract is not configured.')
    return submitAndWait({
      abi: COUNTDOWN_ABI,
      address: activeContractAddress,
      functionName: 'claim',
      chainId: ARC_EVM_CHAIN_ID,
    })
  }

  const setTestDay = async (day: number) => {
    if (!contractConfigured) throw new Error('Countdown contract is not configured.')
    return submitAndWait({
      abi: COUNTDOWN_ABI,
      address: activeContractAddress,
      functionName: 'setTestDay',
      args: [day],
      chainId: ARC_EVM_CHAIN_ID,
    })
  }

  const resetSmokeDay = async (day: number) => {
    if (!address) throw new Error('Wallet not connected.')
    if (!contractConfigured) throw new Error('Countdown contract is not configured.')
    return submitAndWait({
      abi: COUNTDOWN_ABI,
      address: activeContractAddress,
      functionName: 'resetSmokeDay',
      args: [address, day],
      chainId: ARC_EVM_CHAIN_ID,
    })
  }

  const setMetadataUri = async (newUri: string) => {
    if (!contractConfigured) throw new Error('Countdown contract is not configured.')
    return submitAndWait({
      abi: COUNTDOWN_ABI,
      address: activeContractAddress,
      functionName: 'setMetadataUri',
      args: [newUri],
      chainId: ARC_EVM_CHAIN_ID,
    })
  }

  const resetWrite = () => {
    resetWagmiWrite()
    setConfirmedHash(undefined)
    setReceiptError(null)
  }

  return {
    address,
    chainId,
    contractAddress: activeContractAddress,
    contractConfigured,
    currentDay: Number(currentDay.data ?? 0),
    claimedBitmap: (claimedBitmap.data as bigint | undefined) ?? 0n,
    claimedCount: Number(claimedCount.data ?? 0),
    claimedDays,
    metadataUri: String(tokenUri.data ?? ''),
    owner: owner.data as `0x${string}` | undefined,
    isOwner: Boolean(address && owner.data && address.toLowerCase() === String(owner.data).toLowerCase()),
    isLoading: currentDay.isLoading || claimedBitmap.isLoading || claimedCount.isLoading,
    isWalletPending,
    isConfirming,
    isConfirmed: Boolean(confirmedHash),
    txHash,
    writeError,
    receiptError,
    onArcTestnet: chainId === ARC_EVM_CHAIN_ID,
    claim,
    setTestDay,
    resetSmokeDay,
    setMetadataUri,
    refetch,
    resetWrite,
  }
}
