import { useState, useEffect } from 'react'
import { useAccount } from 'wagmi'
import { ethers } from 'ethers'
import { Card, Button, Input, Container } from './ui'
import { UNISWAP_SEPOLIA } from '../config/networks'

// ERC20 ABI minimal
const ERC20_ABI = [
  'function approve(address spender, uint256 amount) external returns (bool)',
  'function balanceOf(address account) external view returns (uint256)',
  'function allowance(address owner, address spender) external view returns (uint256)',
  'function transfer(address to, uint256 amount) external returns (bool)',
]

export function BridgeTab() {
  const { address } = useAccount()
  const [amount, setAmount] = useState('')
  const [isLoading, setIsLoading] = useState(false)
  const [txHash, setTxHash] = useState<string | null>(null)
  const [provider, setProvider] = useState<any>(null)
  const [usdcBalance, setUsdcBalance] = useState('')

  // Setup provider
  useEffect(() => {
    if (typeof window !== 'undefined' && (window as any).ethereum) {
      const ethProvider = new ethers.BrowserProvider((window as any).ethereum)
      setProvider(ethProvider)
    }
  }, [])

  // Get USDC balance
  useEffect(() => {
    if (!provider || !address) return

    const getBalance = async () => {
      try {
        const usdc = new ethers.Contract(
          UNISWAP_SEPOLIA.USDC,
          ERC20_ABI,
          provider
        )
        const balance = await usdc.balanceOf(address)
        setUsdcBalance(ethers.formatUnits(balance, 6))
      } catch (error) {
        console.error('Balance error:', error)
      }
    }

    getBalance()
    const interval = setInterval(getBalance, 5000)
    return () => clearInterval(interval)
  }, [provider, address])

  const handleBridge = async () => {
    if (!address || !provider || !amount) {
      alert('Lütfen cüzdan bağlantısı ve miktar girin')
      return
    }

    setIsLoading(true)
    setTxHash(null)
    try {
      await provider.getSigner()

      // Bridge işlemi başlatıldı
      console.log('Bridge işlemi başlatıldı:', {
        amount,
        address,
        token: UNISWAP_SEPOLIA.USDC,
      })

      // In a real implementation, you would:
      // 1. Approve the bridge contract to spend USDC
      // 2. Call the bridge contract's bridge function
      // 3. Wait for cross-chain confirmation

      alert('Bridge işlemi simüle edildi. Gerçek implementasyon için Circle SDK gereklidir.')
      setAmount('')
    } catch (error) {
      console.error('Bridge error:', error)
      alert('Bridge başarısız: ' + (error instanceof Error ? error.message : 'Bilinmeyen hata'))
    } finally {
      setIsLoading(false)
    }
  }

  return (
    <Container className="py-12">
      <div className="max-w-md mx-auto">
        <Card>
          <h2 className="text-2xl font-bold mb-6">USDC Bridge</h2>
          <p className="text-dark-400 text-sm mb-6">
            Circle Bridge Kit kullanarak USDC'yi Sepolia'dan Arc Testnet'e bridge et
          </p>

          <div className="space-y-4">
            {/* From Chain */}
            <div>
              <label className="text-sm font-medium text-dark-300 block mb-2">Kaynak</label>
              <div className="px-4 py-3 bg-dark-700 rounded-lg border border-dark-600">
                Sepolia (11155111)
              </div>
            </div>

            {/* To Chain */}
            <div>
              <label className="text-sm font-medium text-dark-300 block mb-2">Hedef</label>
              <div className="px-4 py-3 bg-dark-700 rounded-lg border border-dark-600">
                Arc Testnet (42124)
              </div>
            </div>

            {/* Amount */}
            <div>
              <div className="flex justify-between mb-2">
                <label className="text-sm font-medium text-dark-300">Miktar</label>
                <span className="text-xs text-dark-400">
                  Bakiye: {usdcBalance ? parseFloat(usdcBalance).toFixed(2) : '--'} USDC
                </span>
              </div>
              <div className="flex gap-2">
                <Input
                  type="number"
                  placeholder="0.0"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                  className="flex-1"
                />
                <button className="px-4 py-2 bg-dark-700 hover:bg-dark-600 rounded-lg font-semibold transition-colors">
                  USDC
                </button>
              </div>
            </div>

            {/* Bridge Info */}
            <div className="bg-dark-700 border border-dark-600 rounded-lg p-3 space-y-2 text-sm">
              <div className="flex justify-between">
                <span className="text-dark-400">Bridge Ücreti</span>
                <span>0 USDC</span>
              </div>
              <div className="flex justify-between">
                <span className="text-dark-400">Tahmini Süre</span>
                <span>5-10 dakika</span>
              </div>
            </div>

            {/* Bridge Button */}
            <Button
              onClick={handleBridge}
              loading={isLoading}
              disabled={!address || !amount || isLoading}
              className="w-full mt-6"
            >
              {!address ? 'Cüzdan Bağla' : isLoading ? 'Bridge yapılıyor...' : 'USDC Bridge Et'}
            </Button>

            {/* Tx Hash */}
            {txHash && (
              <div className="bg-green-900 border border-green-700 rounded-lg p-3">
                <a
                  href={`https://sepolia.etherscan.io/tx/${txHash}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-green-400 hover:text-green-300 text-sm break-all"
                >
                  İşlemi Görüntüle →
                </a>
              </div>
            )}
          </div>
        </Card>
      </div>
    </Container>
  )
}
