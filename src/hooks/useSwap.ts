import { useState, useCallback, useEffect } from 'react'
import { useAccount, useSwitchChain } from 'wagmi'
import { ethers } from 'ethers'

// Sepolia Testnet Configuration
const SEPOLIA_CONFIG = {
  chainId: 11155111,
  UNISWAP_V2_ROUTER: '0xC532a74256D3Db42D0Bf7a0400fEFDbad7694008',
  USDC_ADDRESS: '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238',
  WETH_ADDRESS: '0x7b79995e5f793A07Bc00c21412e50Ecae098E7f9',
  RPC_ENDPOINT: 'https://rpc.sepolia.org',
}

const ROUTER_ABI = [
  'function WETH() external pure returns (address)',
  'function swapExactETHForTokens(uint amountOutMin, address[] calldata path, address to, uint deadline) external payable returns (uint[] memory amounts)',
  'function swapExactTokensForETH(uint amountIn, uint amountOutMin, address[] calldata path, address to, uint deadline) external returns (uint[] memory amounts)',
  'function getAmountsOut(uint amountIn, address[] memory path) public view returns (uint[] memory amounts)',
]

const ERC20_ABI = [
  'function approve(address spender, uint256 amount) public returns (bool)',
  'function allowance(address owner, address spender) public view returns (uint256)',
]

export interface SwapState {
  inputAmount: string
  outputAmount: string
  isEthToUsdc: boolean
  error: string | null
  status: string | null
  txHash: string | null
  isLoading: boolean
  ethBalance: string | null
  usdcBalance: string | null
  isLoadingBalance: boolean
}

export function useSwap() {
  const { address, chainId } = useAccount()
  const { switchChain } = useSwitchChain()

  const [state, setState] = useState<SwapState>({
    inputAmount: '',
    outputAmount: '',
    isEthToUsdc: true,
    error: null,
    status: null,
    txHash: null,
    isLoading: false,
    ethBalance: null,
    usdcBalance: null,
    isLoadingBalance: false,
  })

    // Get provider - using ethers v6
  const getProvider = useCallback(async () => {
    if (typeof window === 'undefined') return null
    
    if ((window as any).ethereum) {
      return new ethers.BrowserProvider((window as any).ethereum)
    }
    
    // Fallback to public RPC
    return new ethers.JsonRpcProvider(SEPOLIA_CONFIG.RPC_ENDPOINT)
  }, [])

  // Fetch ETH and USDC balances
  const fetchBalances = useCallback(async () => {
    if (!address) return

    setState(prev => ({ ...prev, isLoadingBalance: true }))

    try {
      const provider = await getProvider()
      if (!provider) return

      // Fetch ETH balance
      const ethBalance = await provider.getBalance(address)
      const ethBalanceFormatted = ethers.formatEther(ethBalance)

      // Fetch USDC balance
      const usdcContract = new ethers.Contract(
        SEPOLIA_CONFIG.USDC_ADDRESS,
        ['function balanceOf(address) view returns (uint256)'],
        provider
      )
      const usdcBalance = await usdcContract.balanceOf(address)
      const usdcBalanceFormatted = ethers.formatUnits(usdcBalance, 6)

      setState(prev => ({
        ...prev,
        ethBalance: ethBalanceFormatted,
        usdcBalance: usdcBalanceFormatted,
        isLoadingBalance: false,
      }))
    } catch (error) {
      console.error('Error fetching balances:', error)
      setState(prev => ({
        ...prev,
        ethBalance: null,
        usdcBalance: null,
        isLoadingBalance: false,
      }))
    }
  }, [address, getProvider])

  // Fetch balances when address or chain changes
  useEffect(() => {
    if (address && chainId === SEPOLIA_CONFIG.chainId) {
      fetchBalances()
    }
  }, [address, chainId, fetchBalances])

  // Estimate output amount
  const estimateOutput = useCallback(async (inputAmount: string) => {
    if (!inputAmount || parseFloat(inputAmount) <= 0) {
      setState(prev => ({ ...prev, outputAmount: '' }))
      return
    }

    try {
      const provider = await getProvider()
      if (!provider) return

      const router = new ethers.Contract(
        SEPOLIA_CONFIG.UNISWAP_V2_ROUTER,
        ROUTER_ABI,
        provider
      )

      const path = state.isEthToUsdc
        ? [SEPOLIA_CONFIG.WETH_ADDRESS, SEPOLIA_CONFIG.USDC_ADDRESS]
        : [SEPOLIA_CONFIG.USDC_ADDRESS, SEPOLIA_CONFIG.WETH_ADDRESS]

      const amountIn = ethers.parseEther(inputAmount)
      const amounts = await router.getAmountsOut(amountIn, path)
      
      const decimals = state.isEthToUsdc ? 6 : 18
      const outputFormatted = ethers.formatUnits(amounts[1], decimals)
      
      setState(prev => ({ ...prev, outputAmount: outputFormatted }))
    } catch (error) {
      console.error('Error estimating output:', error)
      setState(prev => ({ ...prev, outputAmount: '' }))
    }
  }, [getProvider, state.isEthToUsdc])

  const setInputAmount = useCallback((amount: string) => {
    setState(prev => ({ ...prev, inputAmount: amount }))
    estimateOutput(amount)
  }, [estimateOutput])

  const toggleDirection = useCallback(() => {
    setState(prev => ({
      ...prev,
      isEthToUsdc: !prev.isEthToUsdc,
      inputAmount: '',
      outputAmount: '',
    }))
  }, [])

  const executeSwap = useCallback(async () => {
    if (!address) {
      setState(prev => ({
        ...prev,
        error: 'Please connect your wallet',
        status: null,
      }))
      return
    }

    if (chainId !== SEPOLIA_CONFIG.chainId) {
      try {
        await switchChain({ chainId: SEPOLIA_CONFIG.chainId })
        await new Promise(resolve => setTimeout(resolve, 2000))
      } catch (err) {
        setState(prev => ({
          ...prev,
          error: 'Failed to switch to Sepolia',
          status: null,
        }))
        return
      }
    }

    if (!state.inputAmount || parseFloat(state.inputAmount) <= 0) {
      setState(prev => ({
        ...prev,
        error: 'Please enter a valid amount',
        status: null,
      }))
      return
    }

    setState(prev => ({
      ...prev,
      error: null,
      status: 'Initiating swap...',
      isLoading: true,
    }))

    try {
      const provider = await getProvider()
      if (!provider) throw new Error('Provider not available')

      const signer = await (provider as ethers.BrowserProvider).getSigner()
      const router = new ethers.Contract(
        SEPOLIA_CONFIG.UNISWAP_V2_ROUTER,
        ROUTER_ABI,
        signer
      )

      const wethAddress = await router.WETH()
      const path = state.isEthToUsdc
        ? [wethAddress, SEPOLIA_CONFIG.USDC_ADDRESS]
        : [SEPOLIA_CONFIG.USDC_ADDRESS, wethAddress]

      const deadline = Math.floor(Date.now() / 1000) + 60 * 20 // 20 minutes

      let tx

      if (state.isEthToUsdc) {
        setState(prev => ({ ...prev, status: 'Swapping ETH for USDC...' }))
        
        const amountIn = ethers.parseEther(state.inputAmount)
        tx = await router.swapExactETHForTokens(
          0, // No minimum amount for simplicity
          path,
          address,
          deadline,
          { value: amountIn }
        )
      } else {
        setState(prev => ({ ...prev, status: 'Approving USDC spend...' }))
        
        const usdcContract = new ethers.Contract(
          SEPOLIA_CONFIG.USDC_ADDRESS,
          ERC20_ABI,
          signer
        )

        const allowance = await usdcContract.allowance(
          address,
          SEPOLIA_CONFIG.UNISWAP_V2_ROUTER
        )
        const amountIn = ethers.parseUnits(state.inputAmount, 6)

        if (allowance < amountIn) {
          const approveTx = await usdcContract.approve(
            SEPOLIA_CONFIG.UNISWAP_V2_ROUTER,
            amountIn
          )
          await approveTx.wait()
        }

        setState(prev => ({ ...prev, status: 'Swapping USDC for ETH...' }))
        
        tx = await router.swapExactTokensForETH(
          amountIn,
          0,
          path,
          address,
          deadline
        )
      }

      setState(prev => ({
        ...prev,
        status: 'Waiting for transaction confirmation...',
        txHash: tx.hash,
      }))

      await tx.wait()

      setState(prev => ({
        ...prev,
        status: 'Swap successful!',
        isLoading: false,
        inputAmount: '',
        outputAmount: '',
      }))

      // Clear success message after 5 seconds
      setTimeout(() => {
        setState(prev => ({
          ...prev,
          status: null,
          txHash: null,
        }))
      }, 5000)
    } catch (error) {
      console.error('Swap failed:', error)
      
      let errorMessage = 'An unknown error occurred'
      
      if (error instanceof Error) {
        if (
          error.message.includes('user rejected') ||
          error.message.includes('ACTION_REJECTED')
        ) {
          errorMessage = 'Swap failed: Transaction rejected'
        } else if (error.message.includes('INSUFFICIENT_FUNDS')) {
          errorMessage = 'Swap failed: Insufficient funds'
        } else if (error.message.includes('transaction failed')) {
          errorMessage = 'Swap failed: Transaction failed'
        } else {
          errorMessage = `Swap failed: ${error.message}`
        }
      }

      setState(prev => ({
        ...prev,
        error: errorMessage,
        status: null,
        isLoading: false,
      }))
    }
  }, [address, chainId, switchChain, state.inputAmount, state.isEthToUsdc, getProvider])

  return {
    state,
    setInputAmount,
    toggleDirection,
    executeSwap,
    fetchBalances,
    setOutputAmount: (amount: string) => setState(prev => ({ ...prev, outputAmount: amount })),
  }
}
