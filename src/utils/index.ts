import { ethers } from 'ethers'
import { ARC_EVM_CHAIN_ID, SEPOLIA_EVM_CHAIN_ID } from '../lib/chains'

/**
 * Format token amount to readable string
 */
export function formatTokenAmount(
  amount: bigint | string | number,
  decimals: number,
  maxDecimals: number = 6
): string {
  try {
    if (typeof amount === 'number') {
      return amount.toFixed(maxDecimals)
    }

    const formatted = ethers.formatUnits(amount, decimals)
    const numFormatted = parseFloat(formatted)

    if (numFormatted === 0) return '0'
    if (numFormatted < 0.000001) return '<0.000001'

    return numFormatted.toLocaleString('en-US', {
      minimumFractionDigits: 2,
      maximumFractionDigits: maxDecimals,
    })
  } catch (error) {
    console.error('Format error:', error)
    return '0'
  }
}

/**
 * Parse token amount to wei
 */
export function parseTokenAmount(amount: string, decimals: number) {
  try {
    return ethers.parseUnits(amount, decimals)
  } catch (error) {
    console.error('Parse error:', error)
    return 0n
  }
}

/**
 * Calculate minimum output amount with slippage
 */
export function calculateMinimumAmount(
  amount: string,
  slippage: number
): string {
  try {
    const numAmount = parseFloat(amount)
    const slippageDecimal = slippage / 100
    const minimumAmount = numAmount * (1 - slippageDecimal)

    return minimumAmount.toString()
  } catch (error) {
    console.error('Calculation error:', error)
    return amount
  }
}

/**
 * Validate Ethereum address
 */
export function isValidAddress(address: string): boolean {
  try {
    return ethers.isAddress(address)
  } catch {
    return false
  }
}

/**
 * Shorten address for display
 */
export function shortenAddress(address: string, chars: number = 4): string {
  if (!isValidAddress(address)) return address

  return `${address.slice(0, chars + 2)}...${address.slice(-chars)}`
}

/**
 * Get transaction URL
 */
export function getTxUrl(txHash: string, chainId: number): string {
  const baseUrls: { [key: number]: string } = {
    [SEPOLIA_EVM_CHAIN_ID]: 'https://sepolia.etherscan.io/tx',
    [ARC_EVM_CHAIN_ID]: 'https://testnet.arcscan.io/tx',
  }

  const baseUrl = baseUrls[chainId]
  return baseUrl ? `${baseUrl}/${txHash}` : ''
}

/**
 * Get address URL
 */
export function getAddressUrl(address: string, chainId: number): string {
  const baseUrls: { [key: number]: string } = {
    [SEPOLIA_EVM_CHAIN_ID]: 'https://sepolia.etherscan.io/address',
    [ARC_EVM_CHAIN_ID]: 'https://testnet.arcscan.io/address',
  }

  const baseUrl = baseUrls[chainId]
  return baseUrl ? `${baseUrl}/${address}` : ''
}

/**
 * Wait for transaction confirmation
 */
export async function waitForTx(
  provider: ethers.BrowserProvider,
  txHash: string,
  confirmations: number = 1
): Promise<ethers.TransactionReceipt | null> {
  try {
    const receipt = await provider.waitForTransaction(txHash, confirmations)
    return receipt
  } catch (error) {
    console.error('Wait for tx error:', error)
    return null
  }
}

/**
 * Format gas price
 */
export function formatGasPrice(gasPrice: bigint): string {
  try {
    const gweiPrice = ethers.formatUnits(gasPrice, 'gwei')
    return `${parseFloat(gweiPrice).toFixed(2)} Gwei`
  } catch {
    return 'N/A'
  }
}
