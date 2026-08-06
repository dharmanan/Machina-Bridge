import { useMemo } from 'react'
import { useAccount, useReadContract, useWaitForTransactionReceipt, useWriteContract } from 'wagmi'
import { ARC_EVM_CHAIN_ID } from '../lib/chains'
import { bitmapToDays, COUNTDOWN_ABI, COUNTDOWN_CONTRACT_ADDRESS, HAS_COUNTDOWN_CONTRACT } from './contract'

export function useCountdownContract() {
  const { address, chainId } = useAccount()

  const owner = useReadContract({
    abi: COUNTDOWN_ABI,
    address: COUNTDOWN_CONTRACT_ADDRESS,
    functionName: 'owner',
    chainId: ARC_EVM_CHAIN_ID,
    query: { enabled: HAS_COUNTDOWN_CONTRACT },
  })

  const currentDay = useReadContract({
    abi: COUNTDOWN_ABI,
    address: COUNTDOWN_CONTRACT_ADDRESS,
    functionName: 'currentDay',
    chainId: ARC_EVM_CHAIN_ID,
    query: { enabled: HAS_COUNTDOWN_CONTRACT },
  })

  const claimedBitmap = useReadContract({
    abi: COUNTDOWN_ABI,
    address: COUNTDOWN_CONTRACT_ADDRESS,
    functionName: 'claimedBitmap',
    args: address ? [address] : undefined,
    chainId: ARC_EVM_CHAIN_ID,
    query: { enabled: HAS_COUNTDOWN_CONTRACT && Boolean(address) },
  })

  const claimedCount = useReadContract({
    abi: COUNTDOWN_ABI,
    address: COUNTDOWN_CONTRACT_ADDRESS,
    functionName: 'claimedCount',
    args: address ? [address] : undefined,
    chainId: ARC_EVM_CHAIN_ID,
    query: { enabled: HAS_COUNTDOWN_CONTRACT && Boolean(address) },
  })

  const { data: txHash, error: writeError, isPending: isWalletPending, writeContractAsync, reset: resetWrite } = useWriteContract()
  const receipt = useWaitForTransactionReceipt({ hash: txHash, chainId: ARC_EVM_CHAIN_ID })

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
    ])
  }

  const claim = async () => {
    if (!HAS_COUNTDOWN_CONTRACT) throw new Error('Countdown contract is not configured.')
    const hash = await writeContractAsync({
      abi: COUNTDOWN_ABI,
      address: COUNTDOWN_CONTRACT_ADDRESS,
      functionName: 'claim',
      chainId: ARC_EVM_CHAIN_ID,
    })
    return hash
  }

  const setTestDay = async (day: number) => {
    if (!HAS_COUNTDOWN_CONTRACT) throw new Error('Countdown contract is not configured.')
    const hash = await writeContractAsync({
      abi: COUNTDOWN_ABI,
      address: COUNTDOWN_CONTRACT_ADDRESS,
      functionName: 'setTestDay',
      args: [day],
      chainId: ARC_EVM_CHAIN_ID,
    })
    return hash
  }

  const resetSmokeDay = async (day: number) => {
    if (!address) throw new Error('Wallet not connected.')
    if (!HAS_COUNTDOWN_CONTRACT) throw new Error('Countdown contract is not configured.')
    const hash = await writeContractAsync({
      abi: COUNTDOWN_ABI,
      address: COUNTDOWN_CONTRACT_ADDRESS,
      functionName: 'resetSmokeDay',
      args: [address, day],
      chainId: ARC_EVM_CHAIN_ID,
    })
    return hash
  }

  return {
    address,
    chainId,
    contractAddress: COUNTDOWN_CONTRACT_ADDRESS,
    contractConfigured: HAS_COUNTDOWN_CONTRACT,
    currentDay: Number(currentDay.data ?? 0),
    claimedBitmap: (claimedBitmap.data as bigint | undefined) ?? 0n,
    claimedCount: Number(claimedCount.data ?? 0),
    claimedDays,
    owner: owner.data as `0x${string}` | undefined,
    isOwner: Boolean(address && owner.data && address.toLowerCase() === String(owner.data).toLowerCase()),
    isLoading: currentDay.isLoading || claimedBitmap.isLoading || claimedCount.isLoading,
    isWalletPending,
    isConfirming: receipt.isLoading,
    isConfirmed: receipt.isSuccess,
    txHash,
    writeError,
    receiptError: receipt.error,
    onArcTestnet: chainId === ARC_EVM_CHAIN_ID,
    claim,
    setTestDay,
    resetSmokeDay,
    refetch,
    resetWrite,
  }
}
