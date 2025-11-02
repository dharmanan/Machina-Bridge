import { useContractRead } from 'wagmi'
import { erc20Abi } from 'viem'

export function useTokenBalance(tokenAddress: string, account?: string) {
  const { data: balance } = useContractRead({
    address: tokenAddress as `0x${string}`,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: [account as `0x${string}`],
  })

  return balance
}

export function useTokenDecimals(tokenAddress: string) {
  const { data: decimals } = useContractRead({
    address: tokenAddress as `0x${string}`,
    abi: erc20Abi,
    functionName: 'decimals',
  })

  return decimals || 18
}
